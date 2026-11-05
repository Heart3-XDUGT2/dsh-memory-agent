import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { syncBuiltinESMExports } from 'node:module'
import { createFileTextExtractor } from '../lib/qq-file-text.js'

const fixture = name => readFile(new URL('./fixtures/qq-file-text/' + name, import.meta.url))
const extractOnce = async (input, options) => {
  const extractor = createFileTextExtractor(options)
  try { return await extractor.extract(input) } finally { await extractor.close() }
}
const bytes = text => Buffer.from(text, 'utf8')

test('worker .js import in the main thread is safe and preserves process capabilities', async () => {
  const before = {
    fetch: globalThis.fetch, request: http.request, get: http.get,
    httpsRequest: https.request, httpsGet: https.get,
    connect: net.connect, createConnection: net.createConnection, socketConnect: net.Socket.prototype.connect
  }
  try {
    await import('../lib/qq-file-worker.js?main-thread-smoke')
    assert.equal(globalThis.fetch, before.fetch)
    assert.equal(http.request, before.request)
    assert.equal(http.get, before.get)
    assert.equal(https.request, before.httpsRequest)
    assert.equal(https.get, before.httpsGet)
    assert.equal(net.connect, before.connect)
    assert.equal(net.createConnection, before.createConnection)
    assert.equal(net.Socket.prototype.connect, before.socketConnect)
  } finally {
    globalThis.fetch = before.fetch
    http.request = before.request
    http.get = before.get
    https.request = before.httpsRequest
    https.get = before.httpsGet
    net.connect = before.connect
    net.createConnection = before.createConnection
    net.Socket.prototype.connect = before.socketConnect
    syncBuiltinESMExports()
  }
})

test('ordinary main-thread import of every parser lib module is safe', async () => {
  const beforeFetch = globalThis.fetch
  const beforeRequest = http.request
  const beforeConnect = net.Socket.prototype.connect
  const names = ['qq-file-text.js', 'qq-file-worker.js', 'file-text-errors.js', 'pdf-text.js', 'docx-text.js']
  const results = await Promise.allSettled(names
    .map(name => import(new URL('../lib/' + name, import.meta.url))))
  assert(results.every(result => result.status === 'fulfilled'))
  assert.equal(globalThis.fetch, beforeFetch)
  assert.equal(http.request, beforeRequest)
  assert.equal(net.Socket.prototype.connect, beforeConnect)
})

test('factory is synchronous; extract is a Promise with bounded stable success fields', async () => {
  const extractor = createFileTextExtractor()
  try {
    assert.equal(typeof extractor.then, 'undefined')
    const result = extractor.extract({ data: bytes('中文内容\nEnglish'), name: 'note.TXT' })
    assert(result instanceof Promise)
    assert.deepEqual(await result, {
      ok: true, format: 'txt', text: '中文内容\nEnglish', truncated: false, warnings: []
    })
  } finally { await extractor.close() }
})

test('Markdown retains source syntax and strips one UTF-8 BOM', async () => {
  const result = await extractOnce({ data: bytes('\ufeff# 中文\n**bold**'), name: 'notes.markdown' })
  assert.equal(result.ok, true)
  assert.equal(result.format, 'md')
  assert.equal(result.text, '# 中文\n**bold**')
})

test('accepted input is snapshotted before return without detaching caller Buffer', async () => {
  const extractor = createFileTextExtractor()
  const original = bytes('before')
  const underlyingLength = original.buffer.byteLength
  try {
    const pending = extractor.extract({ data: original, name: 'input.txt' })
    original.fill(120)
    const result = await pending
    assert.equal(result.ok, true)
    assert.equal(result.text, 'before')
    assert.equal(original.toString(), 'xxxxxx')
    assert.equal(original.buffer.byteLength, underlyingLength)
  } finally { await extractor.close() }
})

test('only a Buffer subarray view enters extraction, never the surrounding pool', async () => {
  const original = bytes('PREFIXhelloSUFFIX')
  const result = await extractOnce({ data: original.subarray(6, 11), name: 'slice.txt' })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'hello')
  assert.equal(original.toString(), 'PREFIXhelloSUFFIX')
})

test('shared memory, wrong types and fake signal objects are refused safely', async () => {
  const extractor = createFileTextExtractor()
  try {
    for (const input of [
      null, {}, { data: 'hello', name: 'a.txt' },
      { data: new DataView(new ArrayBuffer(4)), name: 'a.txt' },
      { data: new Uint8Array(new SharedArrayBuffer(4)), name: 'a.txt' },
      { data: bytes('hello'), name: 'a.txt', signal: { aborted: false } }
    ]) {
      const result = await extractor.extract(input)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'INVALID_INPUT')
      assert.equal(typeof result.reason, 'string')
      assert.equal(typeof result.hint, 'string')
    }
  } finally { await extractor.close() }
})

test('unknown extension and path-like names never become filesystem inputs', async () => {
  for (const name of ['file.exe', 'file.constructor']) {
    const result = await extractOnce({ data: bytes('hello'), name })
    assert.equal(result.code, 'UNSUPPORTED_FORMAT')
  }
  for (const name of ['file:///private/note.txt', 'C:\\private\\note.txt', '../note.txt']) {
    const rejected = await extractOnce({ data: bytes('hello'), name })
    assert.equal(rejected.code, 'INVALID_INPUT')
    assert.doesNotMatch(JSON.stringify(rejected), /private|C:\\|file:|stack/i)
  }
})

test('extension and PDF/ZIP bytes must agree', async () => {
  const pdf = await fixture('synthetic-two-page-zh.pdf')
  const docx = await fixture('synthetic-paragraph-table-deflated.docx')
  for (const input of [
    { data: pdf, name: 'fake.txt' }, { data: docx, name: 'fake.pdf' },
    { data: pdf, name: 'fake.docx' }, { data: bytes('plain words'), name: 'fake.pdf' }
  ]) {
    assert.equal((await extractOnce(input)).code, 'FORMAT_MISMATCH')
  }
})

test('CFB-marked .docx is classified as possible encrypted or compound Office structure', async () => {
  const marker = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  for (const data of [marker, Uint8Array.from([...marker, 0, 0, 0, 0])]) {
    const result = await extractOnce({ data, name: 'synthetic-encrypted.docx' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DOCX_ENCRYPTED')
    assert.match(result.reason, /可能/u)
    assert.match(result.reason, /Office|复合/u)
    assert.doesNotMatch(JSON.stringify(result), /已成功解密|解密成功|探测到密码/u)
  }
  for (const data of [marker.subarray(0, 7), Uint8Array.from([...marker.subarray(0, 7), 0])]) {
    assert.equal((await extractOnce({ data, name: 'synthetic-near-marker.docx' })).code, 'FORMAT_MISMATCH')
  }
  assert.equal((await extractOnce({ data: marker, name: 'synthetic-marker.pdf' })).code, 'FORMAT_MISMATCH')
})

test('text documents may mention file signatures inside ordinary prose', async () => {
  const text = '# PDF notes\nThe file header is %PDF-1.7, followed by objects.\n'
  const result = await extractOnce({ data: bytes(text), name: 'notes.md' })
  assert.equal(result.ok, true)
  assert.equal(result.text, text)
})

test('byte admission rejects before parsing; callers cannot enlarge hard limits', async () => {
  assert.equal((await extractOnce({ data: bytes('12345'), name: 'small.txt' },
    { maxInputBytes: 4 })).code, 'FILE_TOO_LARGE')
  for (const options of [
    { maxInputBytes: 8 * 1024 * 1024 + 1 }, { concurrency: 2 }, { maxQueue: 3 },
    { timeoutMs: Infinity }, { timeoutMs: 0 }, { unknownOption: 1 }
  ]) assert.throws(() => createFileTextExtractor(options), TypeError)
})

test('strict UTF-8 and NUL rejection never invent replacement text', async () => {
  assert.equal((await extractOnce({ data: new Uint8Array([0xc3, 0x28]), name: 'bad.txt' })).code,
    'INVALID_ENCODING')
  assert.equal((await extractOnce({ data: new Uint8Array([0xff, 0xfe, 0x41, 0]), name: 'utf16.txt' })).code,
    'INVALID_ENCODING')
  assert.equal((await extractOnce({ data: bytes('hello\0world'), name: 'binary.txt' })).code, 'BINARY_TEXT')
})

test('text truncation keeps a valid Unicode boundary and an explicit flag', async () => {
  const result = await extractOnce({ data: bytes('ab😀tail'), name: 'emoji.txt' }, { maxTextChars: 3 })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'ab')
  assert.equal(result.truncated, true)
  assert(!/[\ud800-\udfff]/u.test(result.text))
})

test('empty text remains an honest empty file', async () => {
  const result = await extractOnce({ data: new Uint8Array(), name: 'empty.txt' })
  assert.equal(result.ok, true)
  assert.equal(result.text, '')
  assert(result.warnings.includes('EMPTY_TEXT'))
})

test('already aborted request does not enter the queue', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await extractOnce({ data: bytes('hello'), name: 'a.txt', signal: controller.signal })
  assert.equal(result.code, 'ABORTED')
})

test('canceling the active job settles it and allows the next task', async () => {
  const extractor = createFileTextExtractor()
  const controller = new AbortController()
  try {
    const cancelled = extractor.extract({ data: bytes('first'), name: 'a.txt', signal: controller.signal })
    const next = extractor.extract({ data: bytes('second'), name: 'b.txt' })
    controller.abort()
    assert.equal((await cancelled).code, 'ABORTED')
    assert.equal((await next).text, 'second')
  } finally { await extractor.close() }
})

test('canceling a queued request never consumes the following request', async () => {
  const extractor = createFileTextExtractor()
  const controller = new AbortController()
  try {
    const first = extractor.extract({ data: bytes('first'), name: 'a.txt' })
    const queued = extractor.extract({ data: bytes('queued'), name: 'b.txt', signal: controller.signal })
    const next = extractor.extract({ data: bytes('last'), name: 'c.txt' })
    controller.abort()
    assert.equal((await queued).code, 'ABORTED')
    assert.equal((await first).text, 'first')
    assert.equal((await next).text, 'last')
  } finally { await extractor.close() }
})

test('one active plus two queued jobs is bounded; overflow returns BUSY', async () => {
  const extractor = createFileTextExtractor()
  const accepted = Array.from({ length: 3 }, (_, index) =>
    extractor.extract({ data: bytes(String(index)), name: 'n.txt' }))
  assert.equal((await extractor.extract({ data: bytes('overflow'), name: 'n.txt' })).code, 'BUSY')
  assert.deepEqual((await Promise.all(accepted)).map(result => result.text), ['0', '1', '2'])
  await extractor.close()
})

test('queued bytes are snapshotted at acceptance, including a subarray view', async () => {
  const extractor = createFileTextExtractor()
  const source = bytes('xxqueuedyy')
  try {
    const first = extractor.extract({ data: bytes('first'), name: 'a.txt' })
    const second = extractor.extract({ data: source.subarray(2, 8), name: 'b.txt' })
    source.fill(120)
    await first
    assert.equal((await second).text, 'queued')
  } finally { await extractor.close() }
})

test('close is idempotent, settles active/queued jobs and rejects future extraction', async () => {
  const extractor = createFileTextExtractor()
  const jobs = Array.from({ length: 3 }, () =>
    extractor.extract({ data: bytes('pending'), name: 'a.txt' }))
  await Promise.all([extractor.close(), extractor.close()])
  assert.deepEqual((await Promise.all(jobs)).map(result => result.code), ['CLOSED', 'CLOSED', 'CLOSED'])
  assert.equal((await extractor.extract({ data: bytes('future'), name: 'b.txt' })).code, 'CLOSED')
  await extractor.close()
})

test('a chosen cancellation outcome is not overwritten by a following close', async () => {
  const extractor = createFileTextExtractor()
  const controller = new AbortController()
  const pending = extractor.extract({ data: bytes('pending'), name: 'a.txt', signal: controller.signal })
  controller.abort()
  const closed = extractor.close()
  assert.equal((await pending).code, 'ABORTED')
  await closed
  assert.equal((await extractor.extract({ data: bytes('x'), name: 'x.txt', signal: controller.signal })).code,
    'CLOSED')
})

test('deadline terminates work and settles waiting jobs from acceptance time', async () => {
  const extractor = createFileTextExtractor({ timeoutMs: 1 })
  try {
    const jobs = [0, 1].map(() => extractor.extract({ data: bytes('work'), name: 'a.txt' }))
    const results = await Promise.all(jobs)
    assert.deepEqual(results.map(result => result.code), ['TIMEOUT', 'TIMEOUT'])
  } finally { await extractor.close() }
})

test('a completed worker result cannot beat an already expired monotonic deadline', async t => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const extractor = createFileTextExtractor({ timeoutMs: 1_000 })
  try {
    const pending = extractor.extract({ data: bytes('late result'), name: 'late.txt' })
    // Model main-thread delay without waiting for the real timer: the worker
    // can reply before its timer callback even though the logical budget passed.
    now = 2_000
    assert.equal((await pending).code, 'TIMEOUT')
  } finally { await extractor.close() }
})

test('public API runs real PDF and compressed DOCX helpers without native canvas', async () => {
  const extractor = createFileTextExtractor()
  try {
    const pdf = await extractor.extract({
      data: await fixture('synthetic-two-page-zh.pdf'), name: 'test.pdf'
    })
    assert.equal(pdf.ok, true, JSON.stringify(pdf))
    assert.equal(pdf.format, 'pdf')
    assert.equal(pdf.pages, 2)
    assert.equal(pdf.pagesRead, 2)
    assert.match(pdf.text, /这是正文/u)
    const docx = await extractor.extract({
      data: await fixture('synthetic-paragraph-table-deflated.docx'), name: 'test.docx'
    })
    assert.equal(docx.ok, true, JSON.stringify(docx))
    assert.equal(docx.format, 'docx')
    assert.match(docx.text, /左上 A1/u)
  } finally { await extractor.close() }
})
