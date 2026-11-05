import { createHash } from 'node:crypto'

const hash = data => createHash('md5').update(data).digest()
const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex')

function rc4 (key, input) {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index)
  let j = 0
  for (let index = 0; index < 256; index++) {
    j = (j + state[index] + key[index % key.length]) & 255
    ;[state[index], state[j]] = [state[j], state[index]]
  }
  const result = Buffer.alloc(input.length)
  let i = 0
  j = 0
  for (let index = 0; index < input.length; index++) {
    i = (i + 1) & 255
    j = (j + state[i]) & 255
    ;[state[i], state[j]] = [state[j], state[i]]
    result[index] = input[index] ^ state[(state[i] + state[j]) & 255]
  }
  return result
}

function encryption () {
  const padded = value => Buffer.concat([Buffer.from(value, 'ascii'), padding]).subarray(0, 32)
  const ownerKey = hash(padded('synthetic-owner-password')).subarray(0, 5)
  const owner = rc4(ownerKey, padded('synthetic-user-password'))
  const permission = Buffer.alloc(4)
  permission.writeInt32LE(-4)
  const id = hash(Buffer.from('034-synthetic-pdf-rc4-r2', 'ascii'))
  const key = hash(Buffer.concat([padded('synthetic-user-password'), owner, permission, id])).subarray(0, 5)
  const user = rc4(key, padding)
  return {
    id,
    dictionary: '<< /Filter /Standard /V 1 /R 2 /Length 40'
      + ` /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`,
    encrypt (objectId, bytes) {
      const suffix = Buffer.alloc(5)
      suffix.writeUIntLE(objectId, 0, 3)
      const objectKey = hash(Buffer.concat([key, suffix])).subarray(0, 10)
      return rc4(objectKey, bytes)
    }
  }
}

/** Real synthetic PDF pages, text operators and ToUnicode; never user fonts. */
export function makePdf (pages, { encrypted = false, externalCMap = false } = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('Synthetic fixture needs pages')
  const crypto = encrypted ? encryption() : null
  const unicode = [...new Set(pages.flat().join(''))]
  const ids = new Map(unicode.map((character, index) => [character, index + 1]))
  const hex4 = value => value.toString(16).padStart(4, '0').toUpperCase()
  const encoded = value => [...value].map(character => hex4(ids.get(character))).join('')
  const mappings = [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /SyntheticToUnicode def', '/CMapType 2 def',
    '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange'
  ]
  for (let offset = 0; offset < unicode.length; offset += 100) {
    const batch = unicode.slice(offset, offset + 100)
    mappings.push(`${batch.length} beginbfchar`)
    for (const character of batch) {
      const utf16 = Buffer.from(character, 'utf16le').swap16().toString('hex').toUpperCase()
      mappings.push(`<${hex4(ids.get(character))}> <${utf16}>`)
    }
    mappings.push('endbfchar')
  }
  mappings.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end')
  const objects = []
  const add = value => { objects.push(value); return objects.length }
  const pdfString = (value, id) => {
    const raw = Buffer.from(value, 'ascii')
    return `<${(crypto ? crypto.encrypt(id, raw) : raw).toString('hex')}>`
  }
  const stream = (value, id) => {
    const raw = Buffer.from(value, 'ascii')
    const data = crypto ? crypto.encrypt(id, raw) : raw
    return Buffer.concat([
      Buffer.from(`<< /Length ${data.length} >>\nstream\n`, 'ascii'),
      data,
      Buffer.from('\nendstream', 'ascii')
    ])
  }
  const pageIds = pages.map((_, index) => 7 + index * 2)
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  add('<< /Type /Font /Subtype /Type0 /BaseFont /FixtureSynthetic'
    + ` /Encoding /${externalCMap ? 'UniGB-UCS2-H' : 'Identity-H'} /DescendantFonts [4 0 R]`
    + (externalCMap ? '' : ' /ToUnicode 6 0 R') + ' >>')
  add('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /FixtureSynthetic'
    + ` /CIDSystemInfo << /Registry ${pdfString('Adobe', 4)} /Ordering ${pdfString('Identity', 4)} /Supplement 0 >>`
    + ' /FontDescriptor 5 0 R /DW 600 /CIDToGIDMap /Identity >>')
  add('<< /Type /FontDescriptor /FontName /FixtureSynthetic /Flags 4'
    + ' /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -200 /CapHeight 700 /StemV 80 >>')
  add(stream(mappings.join('\n'), 6))
  for (const [index, lines] of pages.entries()) {
    const pageId = pageIds[index]
    add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]'
      + ` /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`)
    add(stream(lines.length > 0
      ? ['BT', '/F1 14 Tf', '1 0 0 1 50 780 Tm',
          ...lines.flatMap((line, lineIndex) => [
            ...(lineIndex === 0 ? [] : ['0 -28 Td']), `<${encoded(line)}> Tj`
          ]), 'ET'].join('\n')
      : 'q\nQ', pageId + 1))
  }
  const encryptionId = crypto ? add(crypto.dictionary) : null
  const infoId = objects.length + 1
  add(`<< /Title ${pdfString('Synthetic fixture metadata, never expected page body', infoId)} >>`)
  const chunks = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')]
  const offsets = [0]
  let size = chunks[0].length
  for (const [index, object] of objects.entries()) {
    offsets.push(size)
    const bytes = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'ascii'),
      Buffer.isBuffer(object) ? object : Buffer.from(object, 'ascii'),
      Buffer.from('\nendobj\n', 'ascii')
    ])
    chunks.push(bytes)
    size += bytes.length
  }
  const trailer = `<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R`
    + (crypto ? ` /Encrypt ${encryptionId} 0 R /ID [<${crypto.id.toString('hex')}> <${crypto.id.toString('hex')}>]` : '')
    + ' >>'
  chunks.push(Buffer.from([
    'xref', `0 ${objects.length + 1}`, '0000000000 65535 f ',
    ...offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer', trailer, 'startxref', String(size), '%%EOF', ''
  ].join('\n'), 'ascii'))
  return new Uint8Array(Buffer.concat(chunks))
}

export const invalidPdf = () => new Uint8Array(Buffer.from(
  '%PDF-1.7\n1 0 obj\n<< /Type /Bogus >>\nendobj\ntrailer\n<< /Root 99 0 R >>\n%%EOF\n', 'ascii'))
