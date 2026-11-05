/** 034：按需读取文件正文的服务；只保留有界文本。无文件系统写入。 */
import { createFileDownloader } from './qq-file-download.js'
import { fileFormat, parseFiles } from './qq-file-content.js'
import { failure as parserFailure } from './file-text-errors.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const TOKEN = /^[0-9a-f]{32}$/i
const WARNINGS = new Set(['PDF_EMPTY_PAGES', 'PDF_TEXT_TRUNCATED', 'DOCX_BODY_ONLY', 'DOCX_EXTERNAL_LINKS_IGNORED'])
const DOWNLOAD_CODES = new Set(['SIZE_LIMIT', 'INVALID_INPUT', 'INVALID_URL', 'ABORTED', 'TIMEOUT',
  'UNSAFE_REDIRECT', 'REDIRECT_LOOP', 'REDIRECT_LIMIT', 'BODY_UNAVAILABLE', 'INVALID_BODY',
  'HTTP_ERROR', 'EMPTY_BODY', 'DOWNLOAD_FAILED', 'BUSY', 'CLOSED'])
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra })
const bound = (n, fallback, max) => {
  const value = n === undefined ? fallback : n
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error('INVALID_FILE_SERVICE_OPTIONS')
  return value
}
function scopeOf (raw) {
  if (!object(raw) || !['private', 'group'].includes(raw.chatType) ||
    ![raw.chatId, raw.senderId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 128) ||
    (raw.chatType === 'private' && raw.isMaster !== true)) return null
  return { chatType: raw.chatType, chatId: raw.chatId, senderId: raw.senderId, isMaster: raw.isMaster === true }
}
const sameScope = (a, b) => a.chatType === b.chatType && a.chatId === b.chatId
  && (a.chatType !== 'private' || (a.isMaster && b.isMaster && a.senderId === b.senderId))
const bisects = (text, offset) => offset > 0 && offset < text.length &&
  /[\ud800-\udbff]/.test(text[offset - 1]) && /[\udc00-\udfff]/.test(text[offset])

export function createFileService ({
  channelOf, downloader = createFileDownloader(), extractor,
  now = Date.now, ttlMs, maxEntries, maxTextBytes
} = {}) {
  const ttl = bound(ttlMs, 1800000, 1800000)
  const capacity = bound(maxEntries, 32, 32)
  const byteCapacity = bound(maxTextBytes, 8 * 1024 * 1024, 8 * 1024 * 1024)
  if (typeof channelOf !== 'function' || typeof now !== 'function' ||
    typeof downloader?.download !== 'function' || typeof downloader?.close !== 'function' ||
    (extractor !== undefined && (typeof extractor?.extract !== 'function' || typeof extractor?.close !== 'function'))) {
    throw Error('INVALID_FILE_SERVICE_OPTIONS')
  }
  const cache = new Map(), active = new Set(), reading = new Set()
  let bytes = 0, closed = false, closing, parser = extractor, importing
  const channel = () => { try { return channelOf() } catch { return null } }
  function drop (ref) {
    const entry = cache.get(ref)
    if (entry) { bytes -= entry.bytes; cache.delete(ref) }
  }
  function purge () {
    const at = now()
    if (!Number.isFinite(at)) throw Error('CLOCK_UNAVAILABLE')
    for (const [ref, entry] of cache) if (entry.expires <= at) drop(ref)
    return at
  }
  async function parserOf () {
    if (parser) return parser
    if (!importing) importing = import('./qq-file-text.js').then(module => {
      parser = module.createFileTextExtractor()
      return parser
    })
    return importing
  }
  function slice (entry, offset) {
    if (offset > entry.text.length || bisects(entry.text, offset)) return fail('invalid-offset')
    let end = Math.min(entry.text.length, offset + (offset === 0 ? 4000 : 8000))
    if (bisects(entry.text, end)) end--
    return {
      ok: true, ref: entry.ref, label: entry.label, name: entry.name, format: entry.format,
      text: entry.text.slice(offset, end), start: offset, end, totalChars: entry.text.length,
      nextOffset: end < entry.text.length ? end : null, truncated: entry.truncated, warnings: [...entry.warnings],
      ...(entry.pages === undefined ? {} : { pages: entry.pages, pagesRead: entry.pagesRead })
    }
  }

  function readFile (input = {}) {
    if (closed) return Promise.resolve(fail('closed'))
    const source = scopeOf(input.source), ref = input.ref, offset = input.offset ?? 0
    if (!source || typeof ref !== 'string' || !TOKEN.test(ref) ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 ||
      !(input.signal instanceof AbortSignal) || typeof input.isCurrent !== 'function') {
      return Promise.resolve(fail('unavailable'))
    }
    const key = ref.toLowerCase()
    if (reading.has(key) || active.size >= 2) return Promise.resolve(fail('busy'))
    const controller = new AbortController()
    const task = { controller, promise: null }
    const onAbort = () => controller.abort()
    input.signal.addEventListener('abort', onAbort, { once: true })
    const expectedChannel = channel()
    const current = () => {
      try { return !closed && !controller.signal.aborted && !input.signal.aborted
        && input.isCurrent() === true && channel() === expectedChannel } catch { return false }
    }
    if (!current()) {
      input.signal.removeEventListener('abort', onAbort)
      return Promise.resolve(fail('canceled'))
    }
    // 原生轮次/渠道准入可能在await中变化；及时通知下载和worker，末尾仍复核。
    const timer = setInterval(() => { if (!current()) controller.abort() }, 25)
    timer.unref?.()
    active.add(task); reading.add(key)
    task.promise = execute().catch(() => fail('unavailable')).finally(() => {
      clearInterval(timer)
      input.signal.removeEventListener('abort', onAbort)
      active.delete(task); reading.delete(key)
    })
    return task.promise

    async function execute () {
      let handle = null, downloaded = null, actualBytes = 0, onHandleAbort
      try {
        if (!object(expectedChannel) || typeof expectedChannel.inspectFile !== 'function' ||
          typeof expectedChannel.openFile !== 'function') return fail('unavailable')
        const inspected = await expectedChannel.inspectFile({ ref: key, source: { ...source } })
        if (!current()) return fail('canceled')
        if (inspected?.ok !== true) {
          drop(key)
          return fail(['expired', 'not-found'].includes(inspected?.reason) ? 'expired' : 'unavailable')
        }
        const metadata = parseFiles([inspected])[0]
        if (!metadata || metadata.ref !== key) return fail('unavailable')
        if (metadata.state === 'unsupported') return fail('unsupported')
        if (metadata.state === 'too-large') return fail('too-large')
        if (metadata.state !== 'unread') return fail('unavailable')
        const at = purge()
        let entry = cache.get(key)
        if (entry) {
          if (!sameScope(entry.source, source) || entry.label !== metadata.label || entry.name !== metadata.name) return fail('unavailable')
          cache.delete(key); cache.set(key, entry)
          return slice(entry, offset)
        }
        // 没有同一有界正文就不能凭游标重下原件。
        if (offset !== 0) return fail('expired')
        handle = await expectedChannel.openFile({
          ref: key, source: { ...source }, signal: controller.signal, isCurrent: current
        })
        if (!current()) return fail('canceled')
        if (handle?.ok !== true) return fail(['expired', 'not-found', 'busy', 'canceled', 'unsupported', 'too-large']
          .includes(handle?.reason) ? handle.reason : 'unavailable')
        if (handle.ref !== key || handle.label !== metadata.label || handle.name !== metadata.name ||
          typeof handle.finish !== 'function' || typeof handle.isCurrent !== 'function' ||
          !(handle.signal instanceof AbortSignal) || !Number.isSafeInteger(handle.byteLimit) ||
          handle.byteLimit < 0 || handle.byteLimit > 8 * 1024 * 1024) return fail('unavailable')
        const live = () => {
          try { return current() && !handle.signal.aborted && handle.isCurrent() === true } catch { return false }
        }
        onHandleAbort = () => controller.abort()
        handle.signal.addEventListener('abort', onHandleAbort, { once: true })
        if (!live()) return fail('canceled')
        downloaded = await downloader.download({
          url: handle.url, declaredSize: metadata.declaredSize,
          byteLimit: handle.byteLimit, signal: controller.signal
        })
        actualBytes = downloaded?.ok === true ? downloaded.bytes : downloaded?.bytesRead
        if (!Number.isSafeInteger(actualBytes) || actualBytes < 0) actualBytes = handle.byteLimit
        // 取消未决read时，下载器可能尚不能知道迟到块的实际大小；保守占用预算，
        // 与bytesRead实际观测分开，不能让同条第二文件借取消重置12MiB限额。
        if (downloaded?.ok !== true && Number.isSafeInteger(downloaded?.budgetCharge)
          && downloaded.budgetCharge >= 0) actualBytes = Math.max(actualBytes, downloaded.budgetCharge)
        if (!live()) return fail('canceled')
        if (downloaded?.ok !== true) {
          const code = DOWNLOAD_CODES.has(downloaded?.code) ? downloaded.code : 'DOWNLOAD_FAILED'
          if (code === 'SIZE_LIMIT') return fail('too-large', { code: 'FILE_TOO_LARGE' })
          return fail(code === 'TIMEOUT' ? 'timeout' : code === 'ABORTED' ? 'canceled'
            : code === 'BUSY' ? 'busy' : 'download-failed', { code })
        }
        const engine = await parserOf()
        if (!live()) return fail('canceled')
        const parsed = await engine.extract({ data: downloaded.data, name: metadata.name, signal: controller.signal })
        downloaded = null // 解析器已经释放其输入，服务不缓存原件。
        if (!live()) return fail('canceled')
        if (parsed?.ok !== true) {
          const safe = parserFailure(parsed?.code)
          return fail(safe.code === 'ABORTED' ? 'canceled' : safe.code === 'TIMEOUT' ? 'timeout' : 'parse-failed',
            { code: safe.code, hint: safe.reason + safe.hint })
        }
        if (parsed.format !== fileFormat(metadata.name) || typeof parsed.text !== 'string' ||
          parsed.text.length > 100000 || typeof parsed.truncated !== 'boolean' || !Array.isArray(parsed.warnings)) {
          return fail('parse-failed', { code: 'PARSE_FAILED' })
        }
        if (parsed.format === 'pdf' && (!Number.isSafeInteger(parsed.pages) || parsed.pages < 1 || parsed.pages > 100 ||
          !Number.isSafeInteger(parsed.pagesRead) || parsed.pagesRead < 0 || parsed.pagesRead > parsed.pages)) {
          return fail('parse-failed', { code: 'PARSE_FAILED' })
        }
        // 同时约束UTF-8正文预算和JS UTF-16占用估算；中文不能借更短的UTF-16计数绕限。
        const retainedBytes = Math.max(parsed.text.length * 2, Buffer.byteLength(parsed.text, 'utf8'))
        if (retainedBytes > byteCapacity) return fail('cache-miss')
        purge()
        while (cache.size >= capacity || bytes + retainedBytes > byteCapacity) drop(cache.keys().next().value)
        entry = {
          ref: key, label: metadata.label, name: metadata.name, source, format: parsed.format,
          text: parsed.text, truncated: parsed.truncated, warnings: [...new Set(parsed.warnings.filter(w => WARNINGS.has(w)))],
          bytes: retainedBytes, expires: Math.min(at + ttl, now() + ttl),
          ...(parsed.format === 'pdf' ? { pages: parsed.pages, pagesRead: parsed.pagesRead } : {})
        }
        if (!live()) return fail('canceled')
        cache.set(key, entry); bytes += retainedBytes
        return slice(entry, 0)
      } finally {
        downloaded = null
        if (handle?.signal && onHandleAbort) handle.signal.removeEventListener('abort', onHandleAbort)
        if (typeof handle?.finish === 'function') {
          try { handle.finish(actualBytes) } catch {}
        }
      }
    }
  }

  function close () {
    if (closing) return closing
    closed = true
    for (const task of active) task.controller.abort()
    cache.clear(); bytes = 0
    closing = (async () => {
      await downloader.close()
      try { if (importing) await importing } catch {}
      await parser?.close()
      await Promise.allSettled([...active].map(task => task.promise))
    })()
    return closing
  }
  return Object.freeze({ readFile, close })
}
