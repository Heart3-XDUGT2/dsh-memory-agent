/**
 * 034：只负责已准入文件引用的有界HTTP(S)流下载，不接路径、不落盘。
 * 调用方负责聊天来源授权；构造参数和fetch实现只能由受控服务提供。
 * 失败bytesRead仅为结算前实际已知字节；可选budgetCharge是未完正文的
 * 保守占额，不代表实际已读。批次调用方按max(bytesRead,budgetCharge||0)扣额。
 */
const HARD_BYTES = 8 * 1024 * 1024
const HARD_TIMEOUT = 15000
const HARD_REDIRECTS = 3
const HARD_CONCURRENT = 2
const URL_LIMIT = 8192
const STOPPED = Symbol('download-stopped')
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MESSAGES = Object.freeze({
  SIZE_LIMIT: ['文件超过本次读取大小限制。', '请缩小文件或拆分后重新发送。'],
  INVALID_INPUT: ['文件下载参数无效。', '请重新发送文件后再试。'],
  INVALID_URL: ['文件下载地址不可用。', '请重新发送文件以获取有效地址。'],
  ABORTED: ['文件读取已取消。', '需要时请重新读取。'],
  TIMEOUT: ['文件下载超时。', '请稍后重试或缩小文件。'],
  UNSAFE_REDIRECT: ['文件下载跳转不可用。', '请重新发送文件后再试。'],
  REDIRECT_LOOP: ['文件下载出现循环跳转。', '请重新发送文件后再试。'],
  REDIRECT_LIMIT: ['文件下载跳转次数过多。', '请重新发送文件后再试。'],
  BODY_UNAVAILABLE: ['文件内容无法按流读取。', '请重新发送文件后再试。'],
  INVALID_BODY: ['文件下载内容无效。', '请重新发送文件后再试。'],
  HTTP_ERROR: ['文件下载服务未返回可读取内容。', '请稍后重试或重新发送文件。'],
  EMPTY_BODY: ['文件没有可读取字节。', '请检查文件内容后重新发送。'],
  DOWNLOAD_FAILED: ['文件下载失败。', '请稍后重试或重新发送文件。'],
  BUSY: ['文件读取任务已满。', '请等待当前读取结束后重试。'],
  CLOSED: ['文件读取服务已关闭。', '请稍后重新发送文件。']
})

function failure (code, bytesRead = 0, budgetCharge = 0) {
  const [reason, hint] = MESSAGES[code]
  return { ok: false, code, reason, hint, bytesRead, ...(budgetCharge > bytesRead ? { budgetCharge } : {}) }
}

function validInteger (value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max
}

function safeUrl (value, base) {
  if (typeof value !== 'string' || !value || value.length > URL_LIMIT ||
      /[\u0000-\u0020\u007f\\]/.test(value)) return null
  // URL会容忍http:host等缩写；初始地址和显式跳转协议均要求完整写法。
  if ((!base || /^[a-z][a-z0-9+.-]*:/i.test(value)) && !/^https?:\/\//i.test(value)) return null
  try {
    const url = base ? new URL(value, base) : new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

function declaredBytes (value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
  // 很长的正十进制声明仍应按超限拒绝，不能因精度不足误认成未知长度。
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value)
  return null
}

function header (response, name) {
  return typeof response?.headers?.get === 'function' ? response.headers.get(name) : null
}

function safeMime (value) {
  if (typeof value !== 'string') return undefined
  const mime = value.split(';', 1)[0].trim().toLowerCase()
  return mime.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : undefined
}

// 不等待外部取消实现的Promise，避免不合作的fetch/body阻塞超时或close。
function cancelResource (resource) {
  if (!resource || resource.cancelled || resource.completed) return
  resource.cancelled = true
  try {
    const target = resource.reader || resource.body
    if (typeof target?.cancel === 'function') Promise.resolve(target.cancel()).catch(() => {})
  } catch {}
}

export function createFileDownloader (options = {}) {
  if (!options || typeof options !== 'object') throw Error('INVALID_DOWNLOAD_OPTIONS')
  const {
    fetchImpl = globalThis.fetch,
    maxFileBytes = HARD_BYTES,
    timeoutMs = HARD_TIMEOUT,
    maxRedirects = HARD_REDIRECTS,
    maxConcurrent = HARD_CONCURRENT
  } = options
  if (typeof fetchImpl !== 'function' ||
      !validInteger(maxFileBytes, 1, HARD_BYTES) ||
      !validInteger(timeoutMs, 1, HARD_TIMEOUT) ||
      !validInteger(maxRedirects, 0, HARD_REDIRECTS) ||
      !validInteger(maxConcurrent, 1, HARD_CONCURRENT)) throw Error('INVALID_DOWNLOAD_OPTIONS')

  const active = new Set()
  let closed = false
  let closing

  function download (input) {
    if (closed) return Promise.resolve(failure('CLOSED'))
    if (!input || typeof input !== 'object') return Promise.resolve(failure('INVALID_INPUT'))
    const url = safeUrl(input.url)
    if (!url) return Promise.resolve(failure('INVALID_URL'))
    const byteLimit = input.byteLimit === undefined ? maxFileBytes : input.byteLimit
    const declared = declaredBytes(input.declaredSize)
    if (!validInteger(byteLimit, 0, maxFileBytes) || declared === null) return Promise.resolve(failure('INVALID_INPUT'))
    const signal = input.signal
    if (signal != null && !(signal instanceof AbortSignal)) return Promise.resolve(failure('INVALID_INPUT'))
    if (signal?.aborted) return Promise.resolve(failure('ABORTED'))
    if (byteLimit === 0 || declared > byteLimit) return Promise.resolve(failure('SIZE_LIMIT'))
    if (active.size >= maxConcurrent) return Promise.resolve(failure('BUSY'))

    const controller = new AbortController()
    const deadline = performance.now() + timeoutMs
    let resolveStop
    const stopped = new Promise(resolve => { resolveStop = resolve })
    const task = {
      code: null, resource: null, finished: false, promise: null,
      bodyStarted: false, bodyComplete: false, budgetCharge: 0,
      stop (code) {
        if (task.finished || task.code) return
        task.code = code
        // 挂起read可能忽略cancel后迟到交付。结算后无法再追回批次额度，
        // 故正文未自然结束时保守保留整个受控额度，绝不冒称实际已读。
        if (task.bodyStarted && !task.bodyComplete) task.budgetCharge = byteLimit
        resolveStop(STOPPED)
        controller.abort()
        cancelResource(task.resource)
      }
    }
    function check () {
      if (!task.code && performance.now() >= deadline) task.stop('TIMEOUT')
      if (task.code) throw STOPPED
    }
    async function wait (operation) {
      const value = await Promise.race([operation, stopped])
      check()
      return value
    }
    const onAbort = () => task.stop('ABORTED')
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => task.stop('TIMEOUT'), timeoutMs)

    async function execute () {
      let bytesRead = 0
      let storage = null
      try {
        let currentUrl = url
        const visited = new Set([url])
        let followed = 0
        while (true) {
          check()
          const fetched = Promise.resolve().then(() => {
            check()
            return fetchImpl(currentUrl, {
              method: 'GET', redirect: 'manual', credentials: 'omit',
              referrerPolicy: 'no-referrer', signal: controller.signal
            })
          }).then(response => {
            const resource = { body: response?.body, reader: null, cancelled: false, completed: false }
            // fetch即使忽略abort，迟到的响应也必须取消，不能保留未读正文。
            if (task.code || task.finished) cancelResource(resource)
            else task.resource = resource
            return response
          })
          const response = await wait(fetched)
          if (response?.redirected === true || response?.type === 'opaqueredirect') {
            task.stop('UNSAFE_REDIRECT')
            check()
          }
          if (REDIRECTS.has(response?.status)) {
            const nextUrl = safeUrl(header(response, 'location'), currentUrl)
            if (!nextUrl) task.stop('UNSAFE_REDIRECT')
            else if (visited.has(nextUrl)) task.stop('REDIRECT_LOOP')
            else if (followed >= maxRedirects) task.stop('REDIRECT_LIMIT')
            check()
            cancelResource(task.resource)
            task.resource = null
            visited.add(nextUrl)
            followed++
            currentUrl = nextUrl
            continue
          }
          if (!validInteger(response?.status, 200, 299)) {
            task.stop('HTTP_ERROR')
            check()
          }
          const length = header(response, 'content-length')
          if (typeof length === 'string' && /^[0-9]+$/.test(length) && Number(length) > byteLimit) {
            task.stop('SIZE_LIMIT')
            check()
          }
          const resource = task.resource
          if (resource.body == null) {
            task.stop('EMPTY_BODY')
            check()
          }
          if (typeof resource.body.getReader !== 'function') {
            task.stop('BODY_UNAVAILABLE')
            check()
          }
          try {
            resource.reader = resource.body.getReader()
          } catch {
            task.stop('BODY_UNAVAILABLE')
            check()
          }
          // 单块工作区使碎片/零长度chunk不会造成无界的chunk数组。
          storage = new Uint8Array(byteLimit)
          while (true) {
            check()
            const offset = bytesRead
            task.bodyStarted = true
            // 直接发起read，并在取消/期限检查之前记录已交付块。原生pull
            // 可在enqueue后同步abort；不能因终态抢先而丢掉这块实际字节。
            const delivered = Promise.resolve(resource.reader.read()).then(chunk => {
              if (task.finished) return STOPPED
              if (chunk.done) {
                resource.completed = true
                if (!resource.cancelled) task.bodyComplete = true
              } else if (chunk.value instanceof Uint8Array) {
                bytesRead += chunk.value.byteLength
              }
              return chunk
            })
            const chunk = await wait(delivered)
            if (chunk.done) {
              break
            }
            if (!(chunk.value instanceof Uint8Array) || !(chunk.value.buffer instanceof ArrayBuffer)) {
              task.stop('INVALID_BODY')
              check()
            }
            if (bytesRead > byteLimit) {
              // 已送达的触发块也计入同消息预算，但绝不复制或保留超限块。
              task.stop('SIZE_LIMIT')
              check()
            }
            storage.set(chunk.value, offset)
          }
          check()
          if (!bytesRead) {
            task.stop('EMPTY_BODY')
            check()
          }
          const data = bytesRead === storage.length ? storage : storage.slice(0, bytesRead)
          const contentType = safeMime(header(response, 'content-type'))
          check()
          return { ok: true, data, bytes: bytesRead, ...(contentType ? { contentType } : {}) }
        }
      } catch {
        if (!task.code) task.stop('DOWNLOAD_FAILED')
        return failure(task.code, bytesRead, task.budgetCharge)
      } finally {
        task.finished = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        cancelResource(task.resource)
        try { task.resource?.reader?.releaseLock() } catch {}
        task.resource = null
        storage = null
      }
    }

    active.add(task)
    task.promise = Promise.resolve().then(execute).finally(() => active.delete(task))
    return task.promise
  }

  function close () {
    if (closing) return closing
    closed = true
    const tasks = [...active]
    for (const task of tasks) task.stop('CLOSED')
    closing = Promise.allSettled(tasks.map(task => task.promise)).then(() => {})
    return closing
  }

  return { download, close }
}
