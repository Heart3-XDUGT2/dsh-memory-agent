/**
 * Pure, bounded bytes-to-text service. No QQ, downloads, cache, filesystem paths
 * or product state. This copy is an isolated stage, not an activated plugin.
 */
import { Worker } from 'node:worker_threads'
import { failure } from './file-text-errors.js'

const defaults = Object.freeze({
  maxInputBytes: 8 * 1024 * 1024,
  maxTextChars: 100_000,
  maxPdfPages: 100,
  maxZipEntries: 512,
  maxExpandedBytes: 32 * 1024 * 1024,
  maxXmlBytes: 8 * 1024 * 1024,
  maxXmlDepth: 128,
  timeoutMs: 15_000,
  concurrency: 1,
  maxQueue: 2
})

function limitsOf (options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Invalid file reader options')
  for (const key of Object.keys(options)) {
    if (!Object.hasOwn(defaults, key)) throw new TypeError('Unknown file reader option')
  }
  const limits = { ...defaults }
  for (const key of Object.keys(defaults)) {
    if (options[key] === undefined) continue
    const value = options[key]
    const minimum = key === 'maxQueue' ? 0 : 1
    if (!Number.isInteger(value) || value < minimum || value > defaults[key]) {
      throw new TypeError('File reader limit is outside the supported range')
    }
    limits[key] = value
  }
  return Object.freeze(limits)
}

function formatOf (name, data) {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase()
  const formats = { txt: 'txt', md: 'md', markdown: 'md', pdf: 'pdf', docx: 'docx' }
  const format = Object.hasOwn(formats, extension) ? formats[extension] : undefined
  if (!format) return { error: 'UNSUPPORTED_FORMAT' }
  const prefix = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 1024)).toString('latin1')
  const pdf = prefix.includes('%PDF-')
  const leadingPdf = /^(?:\xef\xbb\xbf)?[ \t\r\n]*%PDF-/u.test(prefix)
  const zip = data[0] === 0x50 && data[1] === 0x4b &&
    ((data[2] === 3 && data[3] === 4) || (data[2] === 5 && data[3] === 6))
  // CFB is a container marker, not proof of decryption or a valid DOCX.
  // Let the DOCX helper return its existing encrypted/compound classification.
  const compoundSignature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
  const compoundOffice = data.byteLength >= compoundSignature.length &&
    compoundSignature.every((byte, index) => data[index] === byte)
  if ((format === 'pdf' && !pdf) || (format === 'docx' && !zip && !compoundOffice) ||
    ((format === 'txt' || format === 'md') && (leadingPdf || zip))) return { error: 'FORMAT_MISMATCH' }
  return { format }
}

function successOf (raw, job, limits) {
  if (!raw || raw.ok !== true || raw.format !== job.format || typeof raw.text !== 'string' ||
    raw.text.length > limits.maxTextChars || typeof raw.truncated !== 'boolean' ||
    !Array.isArray(raw.warnings)) return failure('PARSE_FAILED')
  const warnings = [...new Set(raw.warnings.filter(value =>
    typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)))].slice(0, 8)
  const result = {
    ok: true, format: job.format, text: raw.text, truncated: raw.truncated, warnings
  }
  if (job.format === 'pdf') {
    if (!Number.isInteger(raw.pages) || raw.pages < 1 || raw.pages > limits.maxPdfPages ||
      !Number.isInteger(raw.pagesRead) || raw.pagesRead < 0 || raw.pagesRead > raw.pages) {
      return failure('PARSE_FAILED')
    }
    result.pages = raw.pages
    result.pagesRead = raw.pagesRead
  }
  return result
}

export function createFileTextExtractor (options = {}) {
  const limits = limitsOf(options)
  const pending = []
  const jobs = new Set()
  let active = null
  let closed = false
  let closing = null

  function finish (job, result) {
    if (job.state === 'settling' || job.state === 'done') return job.promise
    job.state = 'settling'
    clearTimeout(job.timer)
    job.signal?.removeEventListener('abort', job.onAbort)
    const index = pending.indexOf(job)
    if (index !== -1) pending.splice(index, 1)
    job.bytes = null
    const worker = job.worker
    if (worker) {
      worker.removeAllListeners('message')
      worker.removeAllListeners('exit')
      worker.removeAllListeners('error')
      worker.on('error', () => {})
    }
    void (async () => {
      if (worker) {
        try { await worker.terminate() } catch { /* no raw worker errors cross this seam */ }
      }
      job.worker = null
      if (active === job) active = null
      jobs.delete(job)
      job.state = 'done'
      job.resolve(result)
      queueMicrotask(pump)
    })()
    return job.promise
  }

  function pump () {
    if (closed || active) return
    while (pending.length) {
      const job = pending.shift()
      if (job.state !== 'waiting') continue
      if (job.signal?.aborted) { finish(job, failure('ABORTED')); continue }
      if (performance.now() >= job.deadlineAt) { finish(job, failure('TIMEOUT')); continue }
      active = job
      job.state = 'running'
      try {
        const ownedBytes = job.bytes
        const worker = new Worker(new URL('./qq-file-worker.js', import.meta.url), {
          workerData: { data: ownedBytes, format: job.format, limits },
          transferList: [ownedBytes.buffer],
          resourceLimits: { maxOldGenerationSizeMb: 256 }
        })
        job.worker = worker
        job.bytes = null
        const completed = result => finish(job,
          performance.now() >= job.deadlineAt ? failure('TIMEOUT') : result)
        worker.once('message', raw => {
          const result = raw?.ok === true ? successOf(raw, job, limits) : failure(raw?.code)
          completed(result)
        })
        worker.once('error', () => { completed(failure('PARSE_FAILED')) })
        worker.once('exit', () => { completed(failure('PARSE_FAILED')) })
      } catch {
        finish(job, failure('PARSE_FAILED'))
      }
      return
    }
  }

  function extract (input) {
    if (closed) return Promise.resolve(failure('CLOSED'))
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return Promise.resolve(failure('INVALID_INPUT'))
      const { data, name, signal } = input
      if (!ArrayBuffer.isView(data) || !(data instanceof Uint8Array) ||
        (typeof SharedArrayBuffer === 'function' && data.buffer instanceof SharedArrayBuffer) ||
        typeof name !== 'string' || !name.trim() || name.length > 255 ||
        /[\\/\u0000-\u001f\u007f]/.test(name) ||
        (signal !== undefined && !(signal instanceof AbortSignal))) {
        return Promise.resolve(failure('INVALID_INPUT'))
      }
      if (signal?.aborted) return Promise.resolve(failure('ABORTED'))
      if (data.byteLength > limits.maxInputBytes) return Promise.resolve(failure('FILE_TOO_LARGE'))
      const format = formatOf(name.trim(), data)
      if (format.error) return Promise.resolve(failure(format.error))
      if (active && pending.length >= limits.maxQueue) return Promise.resolve(failure('BUSY'))
      const deadlineAt = performance.now() + limits.timeoutMs
      const snapshot = new Uint8Array(data.byteLength)
      snapshot.set(data)
      let resolve
      const promise = new Promise(yes => { resolve = yes })
      const job = {
        bytes: snapshot, format: format.format, signal, resolve, promise, deadlineAt,
        state: 'waiting', worker: null, timer: null, onAbort: null
      }
      jobs.add(job)
      pending.push(job)
      job.onAbort = () => { finish(job, failure('ABORTED')) }
      signal?.addEventListener('abort', job.onAbort, { once: true })
      job.timer = setTimeout(() => { finish(job, failure('TIMEOUT')) },
        Math.max(0, deadlineAt - performance.now()))
      if (signal?.aborted) finish(job, failure('ABORTED'))
      else pump()
      return promise
    } catch {
      return Promise.resolve(failure('INVALID_INPUT'))
    }
  }

  function close () {
    if (closing) return closing
    closed = true
    const outstanding = [...jobs]
    for (const job of outstanding) finish(job, failure('CLOSED'))
    closing = Promise.all(outstanding.map(job => job.promise)).then(() => undefined)
    return closing
  }

  return Object.freeze({ extract, close })
}
