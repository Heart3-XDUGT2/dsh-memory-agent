import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import test from 'node:test'
import { extractPdf } from '../lib/pdf-text.js'
import { invalidPdf, makePdf } from './helpers/pdf-fixtures.mjs'

const limits = overrides => ({
  maxInputBytes: 8 * 1024 * 1024,
  maxTextChars: 100000,
  maxPdfPages: 100,
  ...overrides
})
const code = expected => error => {
  assert.equal(error.name, 'FileTextError')
  assert.equal(error.code, expected)
  assert.equal(error.message, expected)
  return true
}
const wellFormed = value => assert.equal(value, value.toWellFormed())

test('PDF: reads real two-page Chinese text in page order, not metadata', async () => {
  const bytes = new Uint8Array(await readFile(new URL('./fixtures/qq-file-text/synthetic-two-page-zh.pdf', import.meta.url)))
  const result = await extractPdf(bytes, limits())
  assert.equal(result.pages, 2)
  assert.equal(result.pagesRead, 2)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.warnings, [])
  const expected = [
    '第1页：中文文字PDF夹具', '这是正文，不是元数据。',
    'English paragraph: Alpha beta 123.', '第二行包含标点：你好，世界！',
    '第2页：继续读取', '跨页顺序应为第一页，然后第二页。',
    'Table-like text: A1 B1 / A2 B2.', '结束：只验证文字提取。'
  ]
  let position = -1
  for (const item of expected) {
    const next = result.text.indexOf(item)
    assert.ok(next > position, `Missing/out-of-order synthetic body: ${item}`)
    position = next
  }
  assert.doesNotMatch(result.text, /Synthetic two-page text fixture|Producer/)
  wellFormed(result.text)
})

test('PDF: exact whole-page boundary retains pagesRead; later text is partial', async () => {
  const result = await extractPdf(makePdf([['AB'], ['😀C']]), limits({ maxTextChars: 6 }))
  assert.equal(result.text, 'AB\n\n😀')
  assert.equal(result.truncated, true)
  assert.equal(result.pages, 2)
  assert.equal(result.pagesRead, 1)
  assert.ok(result.warnings.includes('PDF_TEXT_TRUNCATED'))
  wellFormed(result.text)
})

test('PDF: truncation never splits a Unicode surrogate pair', async () => {
  const result = await extractPdf(makePdf([['甲😀乙']]), limits({ maxTextChars: 2 }))
  assert.equal(result.text, '甲')
  assert.equal(result.truncated, true)
  assert.equal(result.pagesRead, 0)
  wellFormed(result.text)
})

test('PDF: supplementary character larger than remaining budget is a truncated success', async () => {
  const result = await extractPdf(makePdf([['😀']]), limits({ maxTextChars: 1 }))
  assert.equal(result.text, '')
  assert.equal(result.truncated, true)
  assert.equal(result.pagesRead, 0)
})

test('PDF: fitting exactly is complete rather than falsely truncated', async () => {
  const result = await extractPdf(makePdf([['AB']]), limits({ maxTextChars: 2 }))
  assert.equal(result.text, 'AB')
  assert.equal(result.truncated, false)
  assert.equal(result.pagesRead, 1)
})

test('PDF: checks page count before accepting an over-limit document', async () => {
  await assert.rejects(extractPdf(makePdf([['一'], ['二'], ['三']]), limits({ maxPdfPages: 2 })), code('PDF_PAGE_LIMIT'))
})

test('PDF: an actual Standard Security RC4 R2 encrypted fixture is rejected safely', async () => {
  await assert.rejects(extractPdf(makePdf([['这是加密正文']], { encrypted: true }), limits()), code('PDF_ENCRYPTED'))
})

test('PDF: malformed document returns a fixed safe error', async () => {
  await assert.rejects(extractPdf(invalidPdf(), limits()), code('PDF_INVALID'))
})

test('PDF: blank page has no extractable text, without claiming scanning', async () => {
  await assert.rejects(extractPdf(makePdf([[]]), limits()), code('NO_EXTRACTABLE_TEXT'))
})

test('PDF: mixed blank pages preserve real text, completed-page counts, one safe warning', async () => {
  const result = await extractPdf(makePdf([['第一页'], [], ['第三页']]), limits())
  assert.equal(result.text, '第一页\n\n第三页')
  assert.equal(result.pages, 3)
  assert.equal(result.pagesRead, 3)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.warnings, ['PDF_EMPTY_PAGES'])
})

test('PDF: no network calls for text extraction or a missing external CMap', async t => {
  const attempts = []
  const denied = name => () => { attempts.push(name); throw new Error('Synthetic network denial') }
  t.mock.method(globalThis, 'fetch', denied('fetch'))
  for (const [owner, name] of [[http, 'http'], [https, 'https']]) {
    t.mock.method(owner, 'request', denied(`${name}.request`))
    t.mock.method(owner, 'get', denied(`${name}.get`))
  }
  t.mock.method(net, 'connect', denied('net.connect'))
  t.mock.method(net, 'createConnection', denied('net.createConnection'))
  const result = await extractPdf(makePdf([['内存中的中文正文']]), limits())
  assert.equal(result.text, '内存中的中文正文')
  await assert.rejects(extractPdf(makePdf([['缺少外部字符映射']], { externalCMap: true }), limits()), error => {
    assert.ok(['PDF_INVALID', 'NO_EXTRACTABLE_TEXT'].includes(error.code))
    return true
  })
  assert.deepEqual(attempts, [])
})

test('PDF: consumes only the Uint8Array view without detaching its caller', async () => {
  const pdf = makePdf([['视图正文']])
  const backing = new Uint8Array(pdf.length + 48)
  backing.fill(0xA5)
  backing.set(pdf, 24)
  const view = backing.subarray(24, 24 + pdf.length)
  const before = Uint8Array.from(backing)
  const result = await extractPdf(view, limits())
  assert.equal(result.text, '视图正文')
  assert.deepEqual(backing, before)
  assert.equal(backing.byteLength, before.byteLength)
})

test('PDF: rejects paths and byte over-limit before parsing', async () => {
  await assert.rejects(extractPdf('C:\\not-a-real-input.pdf', limits()), code('INVALID_INPUT'))
  await assert.rejects(extractPdf(makePdf([['正文']]), limits({ maxInputBytes: 16 })), code('FILE_TOO_LARGE'))
})
