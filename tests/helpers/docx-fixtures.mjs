import { deflateRawSync } from 'node:zlib'

export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
export const STRICT_W_NS = 'http://purl.oclc.org/ooxml/wordprocessingml/main'
export const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
export const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
export const MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'

export function escapeXml (value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

export function documentXml (body, { namespace = W_NS, prefix = 'w' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?><${prefix}:document xmlns:${prefix}="${namespace}"><${prefix}:body>${body}</${prefix}:body></${prefix}:document>`
}

export function contentTypesXml ({ mainType = MAIN_TYPE, additional = '', prefix = '' } = {}) {
  const name = prefix ? `${prefix}:` : ''
  const xmlns = prefix ? `xmlns:${prefix}` : 'xmlns'
  return `<?xml version="1.0" encoding="UTF-8"?><${name}Types ${xmlns}="${CT_NS}"><${name}Override PartName="/word/document.xml" ContentType="${escapeXml(mainType)}"/>${additional}</${name}Types>`
}

export function paragraph (text) {
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
}

// Deliberately independent, bit-at-a-time fixture CRC implementation.
export function fixtureCrc32 (data) {
  let result = 0xffffffff
  for (const byte of data) {
    result ^= byte
    for (let bit = 0; bit < 8; bit++) result = (result >>> 1) ^ ((result & 1) ? 0xedb88320 : 0)
  }
  return (result ^ 0xffffffff) >>> 0
}

export function zipBytes (entries, { comment = '' } = {}) {
  const local = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const localName = Buffer.from(entry.localName ?? entry.name, 'utf8')
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data ?? [])
    const method = entry.method ?? 0
    const compressed = method === 8 ? deflateRawSync(data) : data
    const checksum = entry.crc ?? fixtureCrc32(data)
    const flags = entry.flags ?? 0x800
    const size = entry.declaredSize ?? data.length
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(entry.localFlags ?? flags, 6)
    localHeader.writeUInt16LE(entry.localMethod ?? method, 8)
    localHeader.writeUInt16LE(0x21, 12)
    localHeader.writeUInt32LE(entry.localCrc ?? checksum, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(entry.localSize ?? size, 22)
    localHeader.writeUInt16LE(localName.length, 26)
    local.push(localHeader, localName, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(flags, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(0x21, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(size, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, name)
    offset += localHeader.length + localName.length + compressed.length
  }
  const centralData = Buffer.concat(central)
  const commentBytes = Buffer.from(comment, 'utf8')
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralData.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(commentBytes.length, 20)
  return Buffer.concat([...local, centralData, end, commentBytes])
}

export function docxBytes ({
  text = '合成文档',
  body = paragraph(text),
  document = documentXml(body),
  types = contentTypesXml(),
  extras = [],
  method = 0,
  omitDocument = false,
  omitTypes = false,
  documentOptions = {},
  typesOptions = {}
} = {}) {
  return zipBytes([
    ...omitTypes ? [] : [{ name: '[Content_Types].xml', data: types, method, ...typesOptions }],
    ...omitDocument ? [] : [{ name: 'word/document.xml', data: document, method, ...documentOptions }],
    ...extras
  ])
}

export function utf16Xml (text, bigEndian = false) {
  const bytes = Buffer.from(text.replace('encoding="UTF-8"', 'encoding="UTF-16"'), 'utf16le')
  if (bigEndian) bytes.swap16()
  return Buffer.concat([Buffer.from(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]), bytes])
}
