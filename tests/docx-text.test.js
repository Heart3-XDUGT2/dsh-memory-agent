import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { extractDocx } from '../lib/docx-text.js'
import {
  docxBytes, zipBytes, paragraph, documentXml, contentTypesXml, utf16Xml,
  fixtureCrc32, W_NS, STRICT_W_NS, CT_NS, REL_NS
} from './helpers/docx-fixtures.mjs'

const defaults = Object.freeze({
  maxInputBytes: 8388608, maxTextChars: 100000, maxPdfPages: 100,
  maxZipEntries: 512, maxExpandedBytes: 33554432, maxXmlBytes: 8388608,
  maxXmlDepth: 128, timeoutMs: 15000, concurrency: 1, maxQueue: 2
})
const extract = (bytes, overrides = {}) => extractDocx(bytes, { ...defaults, ...overrides })
const rejectsCode = (bytes, code, overrides) => assert.rejects(extract(bytes, overrides), error => error?.code === code)

test('fixture CRC matches the standard reference vector', () => {
  assert.equal(fixtureCrc32(Buffer.from('123456789')), 0xcbf43926)
})

test('extracts Unicode, XML escapes, split runs and explicit tab/break in order', async () => {
  const body = `<w:p><w:r><w:t xml:space="preserve">  中文&amp;😀</w:t></w:r><w:r><w:t>&lt;后段&gt;</w:t><w:tab/><w:t>A</w:t><w:br/><w:t>B&apos;&quot;</w:t></w:r></w:p>`
  const result = await extract(docxBytes({ body }))
  assert.equal(result.text, `  中文&😀<后段>\tA\nB'"`)
  assert.equal(result.truncated, false)
  assert.ok(result.warnings.includes('DOCX_BODY_ONLY'))
})

test('preserves paragraph and table-cell/row ordering', async () => {
  const cell = value => `<w:tc>${paragraph(value)}</w:tc>`
  const body = paragraph('首段') + `<w:tbl><w:tr>${cell('甲')}${cell('乙')}</w:tr><w:tr>${cell('丙')}${cell('丁')}</w:tr></w:tbl>` + paragraph('尾段')
  assert.equal((await extract(docxBytes({ body }))).text, '首段\n甲\t乙\n丙\t丁\n尾段')
})

test('supports real DEFLATED entries as well as STORED entries', async () => {
  const expected = '压缩正文😀\n末段'
  const body = paragraph('压缩正文😀') + paragraph('末段')
  assert.equal((await extract(docxBytes({ body, method: 8 }))).text, expected)
  assert.equal((await extract(docxBytes({ body, method: 0 }))).text, expected)
})

test('reads both independent paragraph/table fixtures copied from 033', async () => {
  const expected = '中文段落：你好，世界。\nEnglish paragraph: Hello, fixture world.\n左上 A1\t右上 B1\n左下 A2\t右下 B2\n表格之后：结束。'
  for (const name of ['synthetic-paragraph-table.docx', 'synthetic-paragraph-table-deflated.docx']) {
    const bytes = await readFile(new URL(`./fixtures/qq-file-text/${name}`, import.meta.url))
    const result = await extract(bytes)
    assert.equal(result.text, expected)
    assert.equal(result.truncated, false)
  }
})

test('uses namespace identity, including strict OOXML and alternative prefixes', async () => {
  const document = documentXml('<x:p><x:r><x:t>严格版</x:t></x:r></x:p>', { namespace: STRICT_W_NS, prefix: 'x' })
  const result = await extract(docxBytes({ document, types: contentTypesXml({ prefix: 'ct' }) }))
  assert.equal(result.text, '严格版')
})

test('does not treat foreign namespace t elements as Word text', async () => {
  const body = `<w:p><w:r><alien:t xmlns:alien="urn:untrusted">不应提取</alien:t><w:t>正文</w:t></w:r></w:p>`
  assert.equal((await extract(docxBytes({ body }))).text, '正文')
})

test('accepts UTF-16 LE and BE XML with actual BOM', async () => {
  for (const bigEndian of [false, true]) {
    assert.equal((await extract(docxBytes({ document: utf16Xml(documentXml(paragraph('UTF16😀')), bigEndian) }))).text, 'UTF16😀')
  }
})

test('decodes predefined and numeric entities without entity expansion', async () => {
  const body = '<w:p><w:r><w:t>&amp;&lt;&gt;&quot;&apos;&#20013;&#x1F600;</w:t></w:r></w:p>'
  assert.equal((await extract(docxBytes({ body }))).text, `&<>"'中😀`)
})

test('text truncation is a prefix and never leaves a dangling surrogate', async () => {
  const bytes = docxBytes({ text: '甲😀乙' })
  assert.deepEqual(Object.fromEntries(Object.entries(await extract(bytes, { maxTextChars: 2 })).filter(([k]) => k !== 'warnings')), { text: '甲', truncated: true })
  assert.equal((await extract(bytes, { maxTextChars: 3 })).text, '甲😀')
  assert.equal((await extract(bytes, { maxTextChars: 4 })).truncated, false)
})

test('an emoji-only document with a one-code-unit budget is truncated success, not empty text', async () => {
  const result = await extract(docxBytes({ text: '😀' }), { maxTextChars: 1 })
  assert.equal(result.text, '')
  assert.equal(result.truncated, true)
  assert.deepEqual(result.warnings, ['DOCX_BODY_ONLY'])
})

test('continues package validation after reaching the text budget', async () => {
  await rejectsCode(docxBytes({ text: '很多正文', extras: [{ name: 'word/vbaProject.bin', data: 'not executable' }] }), 'DOCX_MACRO', { maxTextChars: 1 })
})

test('enforces input byte size before opening ZIP', async () => {
  const bytes = docxBytes()
  await rejectsCode(bytes, 'FILE_TOO_LARGE', { maxInputBytes: bytes.length - 1 })
})

test('refuses invalid input types and empty input', async () => {
  await rejectsCode('not bytes', 'INVALID_INPUT')
  await rejectsCode(new Uint8Array(), 'DOCX_INVALID')
})

test('refuses malformed ZIP bytes and an archive missing required parts', async () => {
  await rejectsCode(Buffer.from('PK broken'), 'DOCX_INVALID')
  await rejectsCode(docxBytes({ omitDocument: true }), 'DOCX_INVALID')
  await rejectsCode(docxBytes({ omitTypes: true }), 'DOCX_INVALID')
})

test('refuses fake DOCX content type, document root and body', async () => {
  await rejectsCode(docxBytes({ types: contentTypesXml({ mainType: 'application/xml' }) }), 'DOCX_INVALID')
  await rejectsCode(docxBytes({ document: `<w:document xmlns:w="urn:fake"><w:body>${paragraph('fake')}</w:body></w:document>` }), 'DOCX_INVALID')
  await rejectsCode(docxBytes({ document: `<w:document xmlns:w="${W_NS}"/>` }), 'DOCX_INVALID')
})

test('rejects duplicate required and ignored part names', async () => {
  await rejectsCode(docxBytes({ extras: [{ name: 'word/document.xml', data: documentXml(paragraph('重复')) }] }), 'DOCX_INVALID')
  await rejectsCode(docxBytes({ extras: [{ name: '[Content_Types].xml', data: contentTypesXml() }] }), 'DOCX_INVALID')
  await rejectsCode(docxBytes({ extras: [{ name: 'extra.bin', data: 'a' }, { name: 'extra.bin', data: 'b' }] }), 'DOCX_INVALID')
})

test('rejects malformed main XML and malformed ignored XML', async () => {
  await rejectsCode(docxBytes({ document: `<w:document xmlns:w="${W_NS}"><w:body><w:p></w:body></w:document>` }), 'DOCX_INVALID')
  await rejectsCode(docxBytes({ extras: [{ name: 'word/styles.xml', data: '<styles><broken></styles>' }] }), 'DOCX_INVALID')
})

test('rejects DTD, external entities and undeclared entities safely', async () => {
  const document = `<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY secret SYSTEM "file:///must-not-read">]><w:document xmlns:w="${W_NS}"><w:body>${paragraph('安全')}</w:body></w:document>`
  await rejectsCode(docxBytes({ document }), 'XML_UNSAFE')
  await rejectsCode(docxBytes({ body: '<w:p><w:r><w:t>&undefined;</w:t></w:r></w:p>' }), 'XML_UNSAFE')
  await rejectsCode(docxBytes({ extras: [{ name: 'ignored.xml', data: '<!DOCTYPE x SYSTEM "https://example.invalid/dtd"><x/>' }] }), 'XML_UNSAFE')
})

test('enforces XML depth and per-entry XML byte budgets', async () => {
  await rejectsCode(docxBytes(), 'XML_DEPTH_LIMIT', { maxXmlDepth: 2 })
  await rejectsCode(docxBytes({ text: '字'.repeat(500) }), 'XML_BYTE_LIMIT', { maxXmlBytes: 600 })
  await rejectsCode(docxBytes({ extras: [{ name: 'ignored.xml', data: `<x>${'a'.repeat(1000)}</x>` }] }), 'XML_BYTE_LIMIT', { maxXmlBytes: 600 })
})

test('enforces ZIP entry count', async () => {
  await rejectsCode(docxBytes({ extras: [{ name: 'extra.bin', data: '' }] }), 'ZIP_ENTRY_LIMIT', { maxZipEntries: 2 })
})

test('counts declared expanded bytes of ignored binary entries', async () => {
  await rejectsCode(docxBytes({ extras: [{ name: 'ignored.bin', data: Buffer.alloc(5000), method: 8 }] }), 'ZIP_EXPANDED_LIMIT', { maxExpandedBytes: 2000 })
})

test('reads ignored entry streams and refuses understated actual expanded bytes', async () => {
  await rejectsCode(docxBytes({ extras: [{ name: 'ignored.bin', data: Buffer.alloc(5000, 0x41), declaredSize: 1, method: 8 }] }), 'DOCX_INVALID')
})

test('verifies CRC of both document and otherwise ignored entries', async () => {
  await rejectsCode(docxBytes({ documentOptions: { crc: 0 } }), 'DOCX_INVALID')
  await rejectsCode(docxBytes({ extras: [{ name: 'ignored.bin', data: 'nonzero crc', crc: 0 }] }), 'DOCX_INVALID')
})

test('rejects mismatched local filenames and compression methods', async () => {
  await rejectsCode(docxBytes({ documentOptions: { localName: 'word/other.xml' } }), 'DOCX_INVALID')
  await rejectsCode(docxBytes({ method: 8, documentOptions: { localMethod: 0 } }), 'DOCX_INVALID')
})

test('rejects regular, strong and local-header-only ZIP encryption flags', async () => {
  await rejectsCode(docxBytes({ method: 8, documentOptions: { flags: 0x801 } }), 'DOCX_ENCRYPTED')
  await rejectsCode(docxBytes({ method: 8, documentOptions: { flags: 0x840 } }), 'DOCX_ENCRYPTED')
  await rejectsCode(docxBytes({ method: 8, documentOptions: { localFlags: 0x801 } }), 'DOCX_ENCRYPTED')
})

test('rejects encrypted Office package markers', async () => {
  await rejectsCode(docxBytes({ extras: [{ name: 'EncryptionInfo', data: 'marker' }] }), 'DOCX_ENCRYPTED')
  await rejectsCode(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'DOCX_ENCRYPTED')
})

test('rejects macro payloads and macro content types even with innocent filenames', async () => {
  await rejectsCode(docxBytes({ extras: [{ name: 'word/vbaProject.bin', data: 'never execute' }] }), 'DOCX_MACRO')
  await rejectsCode(docxBytes({ types: contentTypesXml({ mainType: 'application/vnd.ms-word.document.macroEnabled.main+xml' }) }), 'DOCX_MACRO')
  await rejectsCode(docxBytes({ types: contentTypesXml({ additional: '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>' }) }), 'DOCX_MACRO')
})

test('does not fetch or expose external relationship targets', async () => {
  const target = 'https://example.invalid/private-target'
  const rels = `<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/></Relationships>`
  let calls = 0
  const previousFetch = globalThis.fetch
  globalThis.fetch = () => { calls++; throw new Error('must not fetch') }
  try {
    const result = await extract(docxBytes({ text: '链接显示文字', extras: [{ name: 'word/_rels/document.xml.rels', data: rels }] }))
    assert.equal(result.text, '链接显示文字')
    assert.ok(result.warnings.includes('DOCX_EXTERNAL_LINKS_IGNORED'))
    assert.equal(JSON.stringify(result).includes(target), false)
    assert.equal(calls, 0)
    assert.ok(result.warnings.length <= 2)
  } finally { globalThis.fetch = previousFetch }
})

test('does not include headers, comments or embedded files in the main text', async () => {
  const result = await extract(docxBytes({ text: '正文', extras: [
    { name: 'word/header1.xml', data: `<w:hdr xmlns:w="${W_NS}">${paragraph('页眉')}</w:hdr>` },
    { name: 'word/comments.xml', data: `<w:comments xmlns:w="${W_NS}">${paragraph('批注')}</w:comments>` },
    { name: 'word/embeddings/oleObject1.bin', data: 'ignored embedded bytes' }
  ] }))
  assert.equal(result.text, '正文')
  assert.ok(result.warnings.includes('DOCX_BODY_ONLY'))
})

test('refuses an empty body without pretending it was read as meaningful text', async () => {
  await rejectsCode(docxBytes({ body: '<w:p/>' }), 'NO_EXTRACTABLE_TEXT')
})

test('refuses invalid XML encoding and duplicate body elements', async () => {
  await rejectsCode(docxBytes({ document: Buffer.from([0xff, 0xff, 0x3c, 0x78, 0x2f, 0x3e]) }), 'DOCX_INVALID')
  await rejectsCode(docxBytes({ document: `<w:document xmlns:w="${W_NS}"><w:body>${paragraph('a')}</w:body><w:body>${paragraph('b')}</w:body></w:document>` }), 'DOCX_INVALID')
})

test('accepts Uint8Array slices without reading surrounding bytes', async () => {
  const bytes = docxBytes({ text: '有界切片' })
  const surrounded = Buffer.concat([Buffer.from('junk'), bytes, Buffer.from('junk')])
  const slice = new Uint8Array(surrounded.buffer, surrounded.byteOffset + 4, bytes.length)
  assert.equal((await extract(slice)).text, '有界切片')
})

test('refuses invalid OPC paths and malformed content-types namespace', async () => {
  await rejectsCode(docxBytes({ extras: [{ name: '../escape.bin', data: 'never written' }] }), 'DOCX_INVALID')
  await rejectsCode(docxBytes({ types: `<Types xmlns="urn:wrong"><Override PartName="/word/document.xml" ContentType="${CT_NS}"/></Types>` }), 'DOCX_INVALID')
})
