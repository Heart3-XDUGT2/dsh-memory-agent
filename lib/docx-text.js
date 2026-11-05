import { fail, isFileTextError, textPrefix } from './file-text-errors.js'

const WORD_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main'
])
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const DOCUMENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const COMPOUND_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})

// Merely importing this module must not require any optional parser dependency.
async function parserLibraries () {
  try {
    const [zipModule, xmlModule] = await Promise.all([import('yauzl'), import('saxes')])
    return { yauzl: zipModule.default, SaxesParser: xmlModule.SaxesParser }
  } catch { fail('PARSE_FAILED') }
}

function attribute (tag, local) {
  return Object.values(tag.attributes).find(value => value.local === local && value.uri === '')?.value ?? ''
}

function word (tag) { return tag && WORD_NAMESPACES.has(tag.uri) }
function macroType (value) { return /macroenabled|vbaproject|vbadata/i.test(value) }

function textCollector (maximum) {
  let text = ''
  let pending = ''
  let truncated = false
  const append = value => {
    if (value === '' || truncated) return
    const taken = textPrefix(value, Math.max(0, maximum - text.length))
    text += taken
    if (taken.length !== value.length) truncated = true
  }
  return {
    text (value) {
      if (value === '' || truncated) return
      append(pending)
      pending = ''
      append(value)
    },
    literal (value) {
      if (truncated) return
      append(pending)
      pending = ''
      append(value)
    },
    boundary (kind) {
      if (truncated) return
      if (kind === 'cell') pending = pending.replace(/\n+$/u, '') + '\t'
      else if (kind === 'row') pending = pending.replace(/\t+$/u, '') + '\n'
      else pending += '\n'
      // Deferred boundaries are only text if subsequent content follows them.
      // Keep at most the useful prefix plus one code unit proving overflow.
      pending = pending.slice(0, maximum + 1)
    },
    result () { return { text, truncated } }
  }
}

function xmlConsumer (SaxesParser, name, limits, summary, collector) {
  const main = name === 'word/document.xml'
  const types = name === '[content_types].xml'
  const relationships = name.endsWith('.rels')
  const parser = new SaxesParser({ xmlns: true })
  const stack = []
  const typeDeclarations = new Set()
  let depth = 0
  let bodyDepth = 0
  let bodyCount = 0
  let rootSeen = false
  let decoder = null
  let prefix = Buffer.alloc(0)
  let encoding = ''

  parser.on('error', error => {
    if (/undefined entity/i.test(String(error?.message ?? ''))) fail('XML_UNSAFE')
    fail('DOCX_INVALID')
  })
  parser.on('doctype', () => fail('XML_UNSAFE'))
  parser.on('xmldecl', declaration => {
    const declared = String(declaration.encoding ?? '').toLowerCase()
    if (declared && declared !== encoding && !(declared === 'utf-16' && encoding.startsWith('utf-16'))) {
      fail('DOCX_INVALID')
    }
  })
  parser.on('opentag', tag => {
    depth++
    if (depth > limits.maxXmlDepth) fail('XML_DEPTH_LIMIT')
    if (depth === 1) {
      rootSeen = true
      if (main && (!word(tag) || tag.local !== 'document')) fail('DOCX_INVALID')
      if (types && (tag.uri !== CONTENT_TYPES_NS || tag.local !== 'Types')) fail('DOCX_INVALID')
      if (relationships && (tag.uri !== RELATIONSHIPS_NS || tag.local !== 'Relationships')) fail('DOCX_INVALID')
    }
    stack.push(tag)
    if (types && depth === 2) {
      if (tag.uri !== CONTENT_TYPES_NS || !['Default', 'Override'].includes(tag.local)) fail('DOCX_INVALID')
      const contentType = attribute(tag, 'ContentType').trim()
      if (macroType(contentType)) fail('DOCX_MACRO')
      const part = attribute(tag, tag.local === 'Default' ? 'Extension' : 'PartName').toLowerCase()
      const key = tag.local + ':' + part
      if (part === '' || typeDeclarations.has(key)) fail('DOCX_INVALID')
      typeDeclarations.add(key)
      if (tag.local === 'Override' && part === '/word/document.xml') {
        if (contentType.toLowerCase() !== DOCUMENT_TYPE) fail('DOCX_INVALID')
        summary.mainContentType = true
      }
    }
    if (relationships && tag.uri === RELATIONSHIPS_NS && tag.local === 'Relationship') {
      if (macroType(attribute(tag, 'Type'))) fail('DOCX_MACRO')
      const target = attribute(tag, 'Target')
      if (attribute(tag, 'TargetMode').trim().toLowerCase() === 'external' || /^[a-z][a-z0-9+.-]*:|^\/\//iu.test(target)) {
        summary.warnings.add('DOCX_EXTERNAL_LINKS_IGNORED')
      }
    }
    if (main && word(tag) && tag.local === 'body') {
      if (depth !== 2 || ++bodyCount !== 1) fail('DOCX_INVALID')
      bodyDepth = depth
    }
    if (main && bodyDepth && depth > bodyDepth && word(tag)) {
      if (tag.local === 'tab') collector.literal('\t')
      else if (tag.local === 'br' || tag.local === 'cr') collector.literal('\n')
    }
  })
  const text = value => {
    const tag = stack.at(-1)
    if (main && bodyDepth && word(tag) && tag.local === 't') collector.text(value)
  }
  parser.on('text', text)
  parser.on('cdata', text)
  parser.on('closetag', tag => {
    if (main && bodyDepth && word(tag)) {
      if (tag.local === 'p') collector.boundary('paragraph')
      else if (tag.local === 'tc') collector.boundary('cell')
      else if (tag.local === 'tr') collector.boundary('row')
      if (depth === bodyDepth && tag.local === 'body') bodyDepth = 0
    }
    stack.pop()
    depth--
  })

  function startDecoder (bytes) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
    else if (bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f) encoding = 'utf-16be'
    else if (bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0) encoding = 'utf-16le'
    else encoding = 'utf-8'
    decoder = new TextDecoder(encoding, { fatal: true })
  }
  return {
    write (bytes) {
      if (decoder === null) {
        const beginning = prefix.length ? Buffer.concat([prefix, bytes]) : bytes
        if (beginning.length < 4) { prefix = Buffer.from(beginning); return }
        prefix = Buffer.alloc(0)
        startDecoder(beginning)
        parser.write(decoder.decode(beginning, { stream: true }))
      } else parser.write(decoder.decode(bytes, { stream: true }))
    },
    finish () {
      if (decoder === null) {
        startDecoder(prefix)
        parser.write(decoder.decode(prefix, { stream: true }))
        prefix = Buffer.alloc(0)
      }
      parser.write(decoder.decode()).close()
      if (!rootSeen || depth !== 0) fail('DOCX_INVALID')
      if (main && bodyCount !== 1) fail('DOCX_INVALID')
    }
  }
}

function validEntryName (name) {
  if (typeof name !== 'string' || name === '' || /[\u0000-\u001f\\]/u.test(name) || name.startsWith('/')) fail('DOCX_INVALID')
  if (name.split('/').some(part => part === '..' || part === '.')) fail('DOCX_INVALID')
  return name.normalize('NFC').toLowerCase()
}

async function checkLocalHeader (zip, entry) {
  const header = await zip.readLocalFileHeaderPromise(entry, { minimal: false })
  if (header.generalPurposeBitFlag & 0x41) fail('DOCX_ENCRYPTED')
  if (header.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
      header.compressionMethod !== entry.compressionMethod ||
      !header.fileName.equals(entry.fileNameRaw)) fail('DOCX_INVALID')
  if (!(header.generalPurposeBitFlag & 8)) {
    if (header.crc32 !== entry.crc32 ||
        (header.uncompressedSize !== 0xffffffff && header.uncompressedSize !== entry.uncompressedSize) ||
        (header.compressedSize !== 0xffffffff && header.compressedSize !== entry.compressedSize)) fail('DOCX_INVALID')
  }
}

/**
 * Extract main-body text from an in-memory OPC package. Every ZIP stream is
 * drained, counted and CRC-checked, including parts whose text is not retained.
 * No relation target is opened, no part is written and no macro is executed.
 */
export async function extractDocx (data, limits) {
  if (!(data instanceof Uint8Array)) fail('INVALID_INPUT')
  if (data.byteLength > limits.maxInputBytes) fail('FILE_TOO_LARGE')
  if (COMPOUND_SIGNATURE.every((byte, index) => data[index] === byte)) fail('DOCX_ENCRYPTED')
  if (data.byteLength < 4 || data[0] !== 0x50 || data[1] !== 0x4b) fail('DOCX_INVALID')
  const { yauzl, SaxesParser } = await parserLibraries()
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const collector = textCollector(limits.maxTextChars)
  const summary = { mainContentType: false, warnings: new Set(['DOCX_BODY_ONLY']) }
  const seen = new Set()
  let entries = 0
  let declaredBytes = 0
  let actualBytes = 0
  let zip = null
  let stream = null
  try {
    zip = await new Promise((resolve, reject) => {
      yauzl.fromBuffer(buffer, {
        lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true
      }, (error, value) => error ? reject(error) : resolve(value))
    })
    if (zip.entryCount > limits.maxZipEntries) fail('ZIP_ENTRY_LIMIT')
    for await (const entry of zip.eachEntry()) {
      if (++entries > limits.maxZipEntries) fail('ZIP_ENTRY_LIMIT')
      if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x40)) fail('DOCX_ENCRYPTED')
      const name = validEntryName(entry.fileName)
      if (seen.has(name)) fail('DOCX_INVALID')
      seen.add(name)
      const leaf = name.split('/').at(-1)
      if (leaf === 'encryptioninfo' || leaf === 'encryptedpackage') fail('DOCX_ENCRYPTED')
      if (/^vba(?:project|data)/iu.test(leaf)) fail('DOCX_MACRO')
      if (![0, 8].includes(entry.compressionMethod)) fail('DOCX_INVALID')
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
          !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) fail('DOCX_INVALID')
      if (entry.uncompressedSize > limits.maxExpandedBytes - declaredBytes) fail('ZIP_EXPANDED_LIMIT')
      declaredBytes += entry.uncompressedSize
      const xml = name.endsWith('.xml') || name.endsWith('.rels')
      if (xml && entry.uncompressedSize > limits.maxXmlBytes) fail('XML_BYTE_LIMIT')
      await checkLocalHeader(zip, entry)
      const consumer = xml ? xmlConsumer(SaxesParser, name, limits, summary, collector) : null
      stream = await zip.openReadStreamPromise(entry)
      let entryBytes = 0
      let crc = 0xffffffff
      try {
        for await (const chunk of stream) {
          if (chunk.byteLength > limits.maxExpandedBytes - actualBytes) fail('ZIP_EXPANDED_LIMIT')
          actualBytes += chunk.byteLength
          entryBytes += chunk.byteLength
          if (xml && entryBytes > limits.maxXmlBytes) fail('XML_BYTE_LIMIT')
          for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
          consumer?.write(chunk)
        }
      } finally {
        stream.destroy()
        stream = null
      }
      if (entryBytes !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) fail('DOCX_INVALID')
      consumer?.finish()
    }
    if (!seen.has('[content_types].xml') || !seen.has('word/document.xml') || !summary.mainContentType) fail('DOCX_INVALID')
    const result = collector.result()
    if (!result.truncated && result.text.trim() === '') fail('NO_EXTRACTABLE_TEXT')
    return { ...result, warnings: [...summary.warnings] }
  } catch (error) {
    if (isFileTextError(error)) throw error
    if (/encrypt/i.test(String(error?.message ?? ''))) fail('DOCX_ENCRYPTED')
    fail('DOCX_INVALID')
  } finally {
    stream?.destroy()
    zip?.close()
  }
}
