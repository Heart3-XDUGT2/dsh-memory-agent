/** 037：原生文件发送控制；产物与QQ服务均注入，不加载产品入口。 */
import { createQQSendOrigin } from './qq-send-origin.js'
import path from 'node:path'

const MAX_BYTES = 8 * 1024 * 1024
const MAX_TIMEOUT = 60000
const MAX_ITEMS = 32
const RUNTIME = Symbol.for('dsh-echo.qq-file-send-control.v1')
const ORIGINAL = Symbol.for('cordis.original')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const TA = Object.getPrototypeOf(Uint8Array.prototype)
const viewBuffer = Object.getOwnPropertyDescriptor(TA, 'buffer').get
const viewOffset = Object.getOwnPropertyDescriptor(TA, 'byteOffset').get
const viewLength = Object.getOwnPropertyDescriptor(TA, 'byteLength').get
const viewTag = Object.getOwnPropertyDescriptor(TA, Symbol.toStringTag).get
const abLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const abResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
const TEXT = Object.freeze({
  INVALID_ARGUMENTS: '请使用本轮已展示文件的相对名称。',
  ORIGIN_UNPROVEN: '无法证明这是当前QQ主人的发送请求。',
  CLOSED: '文件发送服务已关闭。',
  BUSY: '已有未结算文件操作，请等待其结束。',
  ARTIFACT_UNAVAILABLE: '本轮文件暂不可取得，请检查展示是否成功。',
  NOT_REGISTERED: '本轮没有登记这份文件。',
  AMBIGUOUS_REF: '文件名称不唯一，请使用完整相对名称。',
  INVALID_ARTIFACT: '文件快照无法验证，本次没有提交。',
  SOURCE_CHANGED: '展示后的文件已变化，本次没有提交。',
  ALREADY_TAKEN: '文件已交出，但没有可确认的本端发送记录；不会再次提交。',
  CAPACITY: '本轮文件操作记录已达上限。',
  IN_PROGRESS: '该文件的操作仍在处理，本次没有重复提交。',
  ALREADY_RECORDED: '已查询先前操作状态，本次没有重复提交。',
  NO_SERVICE: 'QQ文件提交服务当前不可用。',
  ORIGIN_UNAVAILABLE: '来源或服务已变化。',
  ABORTED: '本次文件操作已取消。',
  TIMEOUT: '文件操作达到总等待期限。',
  PREPARE_FAILED: '文件准备失败。',
  SERVICE_UNKNOWN: '提交调用已开始，但无法取得可确认的结果。',
  UNCONFIRMED: '接口没有返回完整确认。',
  WRITE_UNKNOWN: '提交后无法确认写入结果。',
  REMOTE_REJECTED: '接口明确拒绝本次提交。',
  CONNECTION_LOST: '提交连接已断开。',
  INVALIDATED: '提交实例已失效。',
  BACKPRESSURE: '提交连接仍有待写文件数据。',
  NO_CONNECTION: 'QQ连接当前不可用。',
  INVALID_INPUT: '提交输入无法验证。',
  INVALID_TARGET: '当前对话目标无法验证。',
  INVALID_NAME: '文件名称无法验证。',
  FILE_TOO_LARGE: '文件超过8MiB大小上限。',
  EMPTY_FILE: '文件为空，请先准备非空文件。',
  OUTSIDE_OUTPUT: '只发送工作区echo-outgoing内本轮已展示的文件。',
  SENSITIVE_FILE: '这份文件不属于可发送的输出文件。',
  NOT_FILE: '展示目标不是可验证的普通文件。',
  UNSUPPORTED_FILESYSTEM: '当前执行环境无法证明文件身份与版本。',
  CONFIRMED: '发送接口已确认提交。'
})
const STATES = new Set(['not_submitted', 'confirmed', 'rejected', 'unknown'])
export const QQ_FILE_SEND_CODES = Object.freeze(Object.keys(TEXT))
const safeCode = (code, fallback = 'ARTIFACT_UNAVAILABLE') => Object.hasOwn(TEXT, code) ? code : fallback
const ARTIFACT_CODES = Object.freeze({
  TOO_LARGE: 'FILE_TOO_LARGE', EMPTY_FILE: 'EMPTY_FILE', OUTSIDE_OUTPUT: 'OUTSIDE_OUTPUT',
  INVALID_PATH: 'OUTSIDE_OUTPUT', SENSITIVE_PATH: 'SENSITIVE_FILE', NOT_FILE: 'NOT_FILE',
  LINK_REFUSED: 'INVALID_ARTIFACT', NOT_FOUND: 'NOT_REGISTERED', UNKNOWN_REF: 'NOT_REGISTERED',
  SOURCE_CHANGED: 'SOURCE_CHANGED', REF_CONFLICT: 'SOURCE_CHANGED', AMBIGUOUS_REF: 'AMBIGUOUS_REF',
  REVOKED: 'ORIGIN_UNAVAILABLE', INVALID_GRANT: 'ORIGIN_UNAVAILABLE', STALE_SCOPE: 'ORIGIN_UNAVAILABLE',
  UNSUPPORTED_FILESYSTEM: 'UNSUPPORTED_FILESYSTEM', INVALID_PRESENT: 'NOT_REGISTERED',
  UNAVAILABLE: 'ARTIFACT_UNAVAILABLE', CAPACITY: 'CAPACITY', BUSY: 'BUSY',
  ALREADY_TAKEN: 'ALREADY_TAKEN', CLOSED: 'CLOSED', TIMEOUT: 'TIMEOUT', ABORTED: 'ABORTED'
})
const artifactCode = code => Object.hasOwn(ARTIFACT_CODES, code) ? ARTIFACT_CODES[code] : safeCode(code)

function runtime () {
  let value = globalThis[RUNTIME]
  if (value === undefined) {
    value = { slots: new Set(), sessions: new WeakMap(), queries: new Set() }
    Object.defineProperty(globalThis, RUNTIME, { value, writable: false, configurable: false, enumerable: false })
  }
  if (!object(value) || !(value.slots instanceof Set) || !(value.sessions instanceof WeakMap)) throw Error('INVALID_SEND_RUNTIME')
  if (value.queries === undefined) value.queries = new Set()
  if (!(value.queries instanceof Set)) throw Error('INVALID_SEND_RUNTIME')
  return value
}
function trueOf (callback) {
  try {
    if (typeof callback !== 'function') return false
    const value = callback()
    if (value !== true && value !== null && typeof value === 'object' && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {})
    }
    return value === true
  } catch { return false }
}
function safePart (name, limit) {
  return typeof name === 'string' && name.trim() === name && name.length > 0 && name.length <= limit
    && name !== '.' && name !== '..' && !/[\\/:?\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name)
    && !Array.from(name).some(c => c.codePointAt(0) >= 0xd800 && c.codePointAt(0) <= 0xdfff)
}
const safeLeaf = name => safePart(name, 160)
function safeRef (ref) {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 2048
    && ref.split('/').every(part => safePart(part, 2048))
}
function presentedAlias (value, cwd) {
  // This is only a label for a B-accepted presentation, never a file-opening
  // path or an authorization check. Select the execution world's path rules.
  if (typeof value !== 'string' || value.length > 2048 || typeof cwd !== 'string'
    || /[\p{Cc}\p{Cf}]/u.test(value) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)
    || value.startsWith('\\\\') || value.startsWith('//')
    || value.split(/[\\/]/u).some(part => part === '.' || part === '..')) return null
  const p = /^[a-z]:[\\/]/iu.test(cwd) ? path.win32
    : cwd.startsWith('/') && !cwd.startsWith('//') ? path.posix : null
  if (!p || !p.isAbsolute(cwd) || (p === path.posix && /[\\:]/u.test(value))) return null
  const relative = p.relative(p.join(cwd, 'echo-outgoing'), p.resolve(cwd, value))
  if (!relative || relative === '..' || relative.startsWith('..' + p.sep) || p.isAbsolute(relative)) return null
  const alias = relative.split(p.sep).join('/')
  return safeRef(alias) ? alias : null
}
function itemOf (raw) {
  if (!object(raw) || !safeRef(raw.ref) || !safeLeaf(raw.name) || !integer(raw.bytes, 1, MAX_BYTES)) return null
  return { ref: raw.ref, name: raw.name, bytes: raw.bytes }
}
function selectRef (ref, catalog, aliases) {
  const exact = aliases.get(ref) || ref
  if (catalog.has(exact)) return { ref: exact }
  if (ref.includes('/')) return { ref: null }
  const matches = new Set([...catalog].filter(candidate => candidate.split('/').at(-1) === ref))
  for (const [alias, canonical] of aliases) {
    if (alias.split('/').at(-1) === ref && catalog.has(canonical)) matches.add(canonical)
  }
  return matches.size > 1 ? { code: 'AMBIGUOUS_REF' } : { ref: matches.values().next().value || null }
}
function serviceIdentity (service) {
  try {
    if (!object(service) || typeof service.beginFileUpload !== 'function') return null
    let current = service
    const seen = new Set()
    for (let i = 0; i < 8; i++) {
      if (seen.has(current)) return null
      seen.add(current)
      const original = current[ORIGINAL]
      if (original === undefined || original === current) return current
      if (!object(original)) return null
      current = original
    }
  } catch {}
  return null
}
function dataView (data) {
  try {
    if (viewTag.call(data) !== 'Uint8Array') return null
    const buffer = viewBuffer.call(data), offset = viewOffset.call(data), length = viewLength.call(data)
    if (!integer(length, 1, MAX_BYTES) || !integer(offset, 0, Number.MAX_SAFE_INTEGER)
      || (abResizable && abResizable.call(buffer)) || abLength.call(buffer) < offset + length) return null
    return { buffer, offset, length }
  } catch { return null }
}
function resultOf (state, code, meta) {
  return Object.freeze({
    ok: state === 'confirmed', state, code: safeCode(code),
    ...(meta ? { ref: meta.ref, name: meta.name, bytes: meta.bytes } : {})
  })
}
function remoteResult (raw, meta) {
  if (!object(raw) || !STATES.has(raw.state) || raw.ok !== (raw.state === 'confirmed')
    || !Object.hasOwn(TEXT, raw.code)
    || (raw.state === 'confirmed' && raw.code !== 'CONFIRMED')
    || (raw.state === 'rejected' && raw.code !== 'REMOTE_REJECTED')) return resultOf('unknown', 'UNCONFIRMED', meta)
  return resultOf(raw.state, raw.code, meta)
}
function render (_args, value) {
  const name = value?.name ? '“' + value.name + '”' : '文件'
  if (value?.state === 'confirmed') return [{ type: 'text',
    text: value.code === 'ALREADY_RECORDED' ? name + '的先前提交已获接口确认；本次没有再次提交。' : '发送接口已确认提交' + name + '。' }]
  if (value?.state === 'unknown') return [{ type: 'text',
    text: value.code === 'IN_PROGRESS' ? TEXT.IN_PROGRESS : name + '的提交结果未知，不自动重发。' }]
  if (value?.state === 'rejected') return [{ type: 'text', text: name + '的提交被接口拒绝，不自动重发。' }]
  return [{ type: 'text', text: '本次未提交文件：' + (TEXT[value?.code] || TEXT.ORIGIN_UNPROVEN) }]
}

export function createQQFileSender ({
  createArtifacts, serviceOf, isEnabled = () => false, sessionEnabledOf = () => false,
  timeoutMs = MAX_TIMEOUT, now = Date.now, monotonicNow = () => performance.now(),
  captureAudit = () => null, audit = () => {}
} = {}) {
  if (typeof createArtifacts !== 'function' || typeof serviceOf !== 'function'
    || typeof now !== 'function' || typeof monotonicNow !== 'function'
    || typeof captureAudit !== 'function' || typeof audit !== 'function'
    || !integer(timeoutMs, 1, MAX_TIMEOUT)) throw Error('INVALID_SEND_OPTIONS')
  const shared = runtime(), states = new WeakMap(), active = new Set(), registrationJobs = new Set()
  let closed = false, closing, artifacts
  const currentService = () => { try { return serviceOf() } catch { return null } }
  const captureContext = scope => {
    try {
      const value = captureAudit(scope)
      if (!object(value) || typeof value.sessionId !== 'string' || !integer(value.turn, 0, Number.MAX_SAFE_INTEGER)
        || typeof value.turnTrace !== 'string' || typeof value.traceId !== 'string') return null
      // The audit adapter issues an already frozen, privately tracked context.
      // Other injected observers get a primitive copy before any asynchronous work.
      if (Object.isFrozen(value) && Object.keys(value).length === 4) return value
      return Object.freeze({ sessionId: value.sessionId, turn: value.turn,
        turnTrace: value.turnTrace, traceId: value.traceId })
    } catch { return null }
  }
  const stateFor = scope => {
    let state = states.get(scope.authority)
    if (!state) {
      state = { pending: Promise.resolve(), refs: new Map(), aliases: new Map(), catalog: new Set(), identities: new WeakMap(),
        inflight: new Map(), records: new Set(), failures: new Map(), lastCode: null }
      states.set(scope.authority, state)
    }
    return state
  }
  const origin = createQQSendOrigin({
    isEnabled, sessionEnabledOf,
    onPresented: info => register(info),
    onRevoke: info => {
      for (const task of active) if (task.authority === info.authority) task.controller.abort()
      if (artifacts) {
        try { Promise.resolve(artifacts.revoke(info.grant)).catch(() => {}) } catch {}
      }
    }
  })
  try { artifacts = createArtifacts({ scopeOf: origin.scopeOf }) } catch { throw Error('INVALID_SEND_ARTIFACTS') }
  if (!object(artifacts) || ['prepare', 'registerPresented', 'list', 'snapshot', 'revoke', 'close']
    .some(name => typeof artifacts[name] !== 'function')) throw Error('INVALID_SEND_ARTIFACTS')

  function register ({ grant, callId, files }) {
    const scope = origin.scopeOf(grant)
    if (closed || !scope || !trueOf(scope.isCurrent)) return
    const state = stateFor(scope)
    if (registrationJobs.size >= MAX_ITEMS) { state.lastCode = 'CAPACITY'; return }
    const job = state.pending.then(async () => {
      if (closed || !trueOf(scope.isCurrent)) return
      const cwd = scope.session.header?.cwd
      const prepared = await artifacts.prepare(grant)
      if (closed || !trueOf(scope.isCurrent)) return
      if (prepared?.ok !== true || prepared.relativeRoot !== 'echo-outgoing') {
        state.lastCode = 'ARTIFACT_UNAVAILABLE'; return
      }
      const result = await artifacts.registerPresented(grant, { callId, files })
      if (result?.ok !== true) state.lastCode = artifactCode(result?.code)
      else state.lastCode = null
      if (Array.isArray(result?.rejected)) for (const rejected of result.rejected.slice(0, MAX_ITEMS)) {
        if (!integer(rejected?.index, 0, files.length - 1)) continue
        const path = files[rejected.index]?.path
        if (typeof path !== 'string') continue
        const normalized = path.replaceAll('\\', '/')
        const ref = normalized.startsWith('echo-outgoing/') ? normalized.slice(14) : ''
        if (safeRef(ref) && state.failures.size < MAX_ITEMS) state.failures.set(ref, artifactCode(rejected.code))
      }
      if (result?.ok === true && Array.isArray(result.items) && Array.isArray(result.rejected)) {
        for (const item of result.items.slice(0, MAX_ITEMS)) {
          if (object(item) && safeRef(item.ref) && state.catalog.size < MAX_ITEMS) state.catalog.add(item.ref)
        }
        const rejected = new Set(result.rejected.map(item => item?.index))
        const successful = files.filter((_file, index) => !rejected.has(index))
        if (result.items.length === successful.length) result.items.forEach((item, index) => {
          if (!object(item) || !safeRef(item.ref)) return
          const alias = presentedAlias(successful[index]?.path, cwd)
          if (!alias || (state.aliases.size >= MAX_ITEMS && !state.aliases.has(alias))) return
          state.aliases.set(alias, item.ref)
          state.failures.delete(alias)
        })
      }
    }).catch(() => { state.lastCode = 'ARTIFACT_UNAVAILABLE' })
    registrationJobs.add(job)
    job.finally(() => registrationJobs.delete(job))
    state.pending = job
  }

  function bind (input = {}) {
    if (!object(input)) return { ok: false, code: 'ORIGIN_UNPROVEN' }
    const identity = serviceIdentity(currentService())
    if (!identity) return { ok: false, code: 'ORIGIN_UNPROVEN' }
    const guard = input.isCurrent
    return origin.bind({ ...input, isCurrent: () => {
      if (!trueOf(guard) || serviceIdentity(currentService()) !== identity) return false
      return trueOf(guard)
    } })
  }

  function query (ref, state, scope, context, wall, monotonic) {
    if (shared.queries.size >= MAX_ITEMS) return Promise.resolve(resultOf('not_submitted', 'CAPACITY'))
    const controller = new AbortController(), token = Symbol('send-status-query')
    const task = { controller, authority: scope.authority, done: null }
    const waiting = state.pending
    const callerSignal = context.signal
    let resolve, ended = false, timer, watch
    const result = new Promise(done => { resolve = done })
    const expired = () => {
      try { return now() >= wall + timeoutMs || monotonicNow() >= monotonic + timeoutMs } catch { return true }
    }
    const current = () => !closed && !controller.signal.aborted && !callerSignal.aborted
      && trueOf(scope.isCurrent) && trueOf(context.isCurrent)
    function finish (value) {
      if (ended) return
      ended = true
      clearTimeout(timer); clearInterval(watch)
      callerSignal.removeEventListener('abort', onAbort)
      resolve(value) // 查询失败不更改原提交记录。
    }
    const onAbort = () => finish(resultOf('not_submitted', 'ABORTED'))
    callerSignal.addEventListener('abort', onAbort, { once: true })
    controller.signal.addEventListener('abort', () => finish(resultOf('not_submitted', 'ORIGIN_UNAVAILABLE')), { once: true })
    let remaining = 0
    try { remaining = Math.max(0, Math.min(wall + timeoutMs - now(), monotonic + timeoutMs - monotonicNow())) } catch {}
    timer = setTimeout(() => finish(resultOf('not_submitted', 'TIMEOUT')), remaining)
    watch = setInterval(() => { if (!current()) finish(resultOf('not_submitted', 'ORIGIN_UNAVAILABLE')) }, 25)
    watch.unref?.()
    shared.queries.add(token); active.add(task)
    task.done = Promise.resolve(waiting).then(() => {
      if (expired()) finish(resultOf('not_submitted', 'TIMEOUT'))
      else if (!current()) finish(resultOf('not_submitted', 'ORIGIN_UNAVAILABLE'))
      else {
        const selected = selectRef(ref, state.catalog, state.aliases)
        if (selected.code) finish(resultOf('not_submitted', selected.code))
        else {
          const record = state.refs.get(selected.ref)
          finish(record ? resultOf(record.value.state,
            record.value.code === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'ALREADY_RECORDED', record.meta) : null)
        }
      }
    }, () => finish(resultOf('not_submitted', 'ARTIFACT_UNAVAILABLE'))).finally(() => {
      shared.queries.delete(token); active.delete(task)
    })
    return result
  }

  async function execute (args, exec) {
    let wall, monotonic
    try { wall = now(); monotonic = monotonicNow() } catch { return resultOf('not_submitted', 'PREPARE_FAILED') }
    if (!Number.isFinite(wall) || !Number.isFinite(monotonic)) return resultOf('not_submitted', 'PREPARE_FAILED')
    if (closed) return resultOf('not_submitted', 'CLOSED')
    if (!object(args) || Object.keys(args).length !== 1 || !safeRef(args.ref)) return resultOf('not_submitted', 'INVALID_ARGUMENTS')
    let context
    try { context = origin.proveSend(args, exec) } catch { context = null }
    if (context?.ok !== true) return resultOf('not_submitted', 'ORIGIN_UNPROVEN')
    const callerSignal = context.signal
    if (!(callerSignal instanceof AbortSignal)) return resultOf('not_submitted', 'ORIGIN_UNPROVEN')
    const scope = origin.scopeOf(context.grant)
    if (!scope || !trueOf(scope.isCurrent) || !trueOf(context.isCurrent)) return resultOf('not_submitted', 'ORIGIN_UNPROVEN')
    const state = stateFor(scope)
    const auditContext = captureContext(scope)
    // A new verified presentation may still be resolving a rename to an old
    // identity. Bounded metadata queries never need another physical send slot.
    if (state.records.size > 0) {
      const previous = await query(args.ref, state, scope, context, wall, monotonic)
      if (previous !== null) return previous
      if (!trueOf(scope.isCurrent) || !trueOf(context.isCurrent) || callerSignal.aborted) {
        return resultOf('not_submitted', 'ORIGIN_UNAVAILABLE')
      }
    }
    if (state.inflight.has(args.ref)) return resultOf('unknown', 'IN_PROGRESS')
    if (shared.sessions.has(scope.session) || shared.slots.size >= 2) return resultOf('not_submitted', 'BUSY')
    if (state.records.size >= MAX_ITEMS) return resultOf('not_submitted', 'CAPACITY')
    const channel = currentService(), identity = serviceIdentity(channel)
    if (!identity) return resultOf('not_submitted', 'NO_SERVICE')
    let begin
    try { begin = channel.beginFileUpload } catch { return resultOf('not_submitted', 'NO_SERVICE') }

    const controller = new AbortController(), slot = Symbol('file-send-control-slot')
    let resolveLogical, resolveDeadline
    const logicalResult = new Promise(resolve => { resolveLogical = resolve })
    const deadline = new Promise(resolve => { resolveDeadline = resolve })
    const task = {
      controller, slot, session: scope.session, authority: scope.authority,
      started: false, logicalEnded: false, record: null, meta: null,
      wallDeadline: wall + timeoutMs, monotonicDeadline: monotonic + timeoutMs,
      auditContext,
      done: null, timer: null, watch: null
    }
    function expired () {
      try { return now() >= task.wallDeadline || monotonicNow() >= task.monotonicDeadline } catch { return true }
    }
    const permitted = () => {
      if (closed || controller.signal.aborted || callerSignal.aborted
        || !trueOf(scope.isCurrent) || !trueOf(context.isCurrent)
        || serviceIdentity(currentService()) !== identity) return false
      return !closed && !controller.signal.aborted && !callerSignal.aborted
    }
    const operationCurrent = () => {
      const current = permitted(), inTime = !expired()
      return current && inTime && !closed && !controller.signal.aborted && !callerSignal.aborted
    }
    function finish (value) {
      if (task.logicalEnded) return
      task.logicalEnded = true
      if (task.record) {
        task.record.value = value
        try { Promise.resolve(audit({ context: task.auditContext, value })).catch(() => {}) } catch {}
      }
      clearInterval(task.watch)
      callerSignal.removeEventListener('abort', onAbort)
      resolveLogical(value)
    }
    function cancel (code) {
      finish(resultOf(task.started ? 'unknown' : 'not_submitted', code, task.meta))
      if (!controller.signal.aborted) controller.abort()
    }
    function onAbort () { cancel('ABORTED') }
    function onDeadline () {
      if (!expired()) {
        let remaining = 1
        try { remaining = Math.max(1, Math.min(task.wallDeadline - now(), task.monotonicDeadline - monotonicNow())) } catch {}
        task.timer = setTimeout(onDeadline, remaining); return
      }
      resolveDeadline()
      cancel('TIMEOUT')
    }
    shared.slots.add(slot); shared.sessions.set(scope.session, slot)
    active.add(task); state.inflight.set(args.ref, task)
    callerSignal.addEventListener('abort', onAbort, { once: true })
    controller.signal.addEventListener('abort', () => {
      if (!task.logicalEnded) cancel(expired() ? 'TIMEOUT' : 'ORIGIN_UNAVAILABLE')
    }, { once: true })
    let remaining = 0
    try { remaining = Math.max(0, Math.min(task.wallDeadline - now(), task.monotonicDeadline - monotonicNow())) } catch {}
    task.timer = setTimeout(onDeadline, remaining)
    task.watch = setInterval(() => {
      if (!permitted()) cancel(callerSignal.aborted ? 'ABORTED' : 'ORIGIN_UNAVAILABLE')
    }, 25)
    task.watch.unref?.()

    let released = false
    function release () {
      if (released) return
      released = true
      clearTimeout(task.timer); clearInterval(task.watch)
      callerSignal.removeEventListener('abort', onAbort)
      state.inflight.delete(args.ref)
      shared.slots.delete(slot)
      if (shared.sessions.get(scope.session) === slot) shared.sessions.delete(scope.session)
      active.delete(task)
    }
    task.done = perform().catch(() => {
      cancel(task.started ? 'SERVICE_UNKNOWN' : 'ARTIFACT_UNAVAILABLE')
    }).finally(release)
    return logicalResult

    async function perform () {
      let snapshot = null, handle = null, data = null
      try {
        await state.pending
        if (!operationCurrent()) { cancel(expired() ? 'TIMEOUT' : 'ORIGIN_UNAVAILABLE'); return }
        const listed = await artifacts.list(context.grant)
        if (!operationCurrent()) { cancel(expired() ? 'TIMEOUT' : 'ORIGIN_UNAVAILABLE'); return }
        if (listed?.ok !== true || !Array.isArray(listed.items) || listed.items.length > MAX_ITEMS) {
          finish(resultOf('not_submitted', artifactCode(listed?.code))); return
        }
        const items = listed.items.filter(item => object(item) && safeRef(item.ref))
        const selection = selectRef(args.ref, new Set(items.map(item => item.ref)), state.aliases)
        if (selection.code) { finish(resultOf('not_submitted', selection.code)); return }
        const matches = items.filter(item => item.ref === selection.ref)
        if (matches.length > 1) { finish(resultOf('not_submitted', 'AMBIGUOUS_REF')); return }
        const selected = matches[0]
        if (!selected) {
          finish(resultOf('not_submitted', state.failures.get(args.ref) || state.lastCode || 'NOT_REGISTERED')); return
        }
        if (!safeLeaf(selected.name)) { finish(resultOf('not_submitted', 'INVALID_NAME')); return }
        if (integer(selected.bytes, MAX_BYTES + 1, Number.MAX_SAFE_INTEGER)) {
          finish(resultOf('not_submitted', 'FILE_TOO_LARGE')); return
        }
        if (selected.bytes === 0) { finish(resultOf('not_submitted', 'EMPTY_FILE')); return }
        const meta = itemOf(selected)
        if (!meta) { finish(resultOf('not_submitted', 'INVALID_ARTIFACT')); return }
        task.meta = meta
        const prior = state.refs.get(meta.ref)
        if (prior) { finish(resultOf(prior.value.state, 'ALREADY_RECORDED', prior.meta)); return }
        const record = { meta, value: resultOf('unknown', 'IN_PROGRESS', meta) }
        task.record = record; state.records.add(record); state.refs.set(meta.ref, record)
        snapshot = await artifacts.snapshot(context.grant, meta.ref, {
          signal: controller.signal, isCurrent: operationCurrent, deadlineAt: task.wallDeadline
        })
        if (snapshot?.ok !== true) {
          if (snapshot?.code === 'ALREADY_TAKEN' && object(snapshot.identity)) {
            const original = state.identities.get(snapshot.identity)
            if (original) {
              state.records.delete(record); state.refs.set(meta.ref, original)
              task.record = null
              finish(resultOf(original.value.state, 'ALREADY_RECORDED', original.meta)); return
            }
          }
          finish(resultOf('not_submitted', artifactCode(snapshot?.code), meta)); return
        }
        data = snapshot.data
        const admitted = dataView(data)
        if (!admitted || !object(snapshot.identity) || snapshot.ref !== meta.ref || snapshot.name !== meta.name
          || snapshot.bytes !== meta.bytes || admitted.length !== meta.bytes) {
          finish(resultOf('not_submitted', 'INVALID_ARTIFACT', meta)); return
        }
        const old = state.identities.get(snapshot.identity)
        if (old) {
          state.records.delete(record); state.refs.set(meta.ref, old); task.record = null
          finish(resultOf(old.value.state, 'ALREADY_RECORDED', old.meta)); return
        }
        state.identities.set(snapshot.identity, record)
        if (!operationCurrent()) { cancel(expired() ? 'TIMEOUT' : 'ORIGIN_UNAVAILABLE'); return }
        const still = dataView(data)
        if (!still || still.buffer !== admitted.buffer || still.offset !== admitted.offset || still.length !== admitted.length) {
          finish(resultOf('not_submitted', 'INVALID_ARTIFACT', meta)); return
        }
        task.started = true // 进入服务后即不能假称没有可能发生的提交。
        try {
          handle = Reflect.apply(begin, channel, [{
            chatType: context.source.chatType, chatId: context.source.chatId, name: meta.name,
            data, signal: controller.signal, isCurrent: operationCurrent, deadlineAt: task.wallDeadline
          }, { source: context.source }])
        } catch {
          finish(resultOf('unknown', 'SERVICE_UNKNOWN', meta))
          await deadline
          return
        } finally { snapshot = null; data = null }
        if (expired()) cancel('TIMEOUT')
        else if (!permitted()) cancel(callerSignal.aborted ? 'ABORTED' : 'ORIGIN_UNAVAILABLE')
        if (!object(handle) || typeof handle.result?.then !== 'function' || typeof handle.physicalDone?.then !== 'function') {
          finish(resultOf('unknown', 'SERVICE_UNKNOWN', meta)); await deadline; return
        }
        Promise.resolve(handle.result).then(value => {
          const safe = remoteResult(value, meta)
          if (expired()) cancel('TIMEOUT')
          else if (!permitted()) cancel(callerSignal.aborted ? 'ABORTED' : 'ORIGIN_UNAVAILABLE')
          else finish(safe)
        },
          () => finish(resultOf('unknown', 'SERVICE_UNKNOWN', meta)))
        await Promise.resolve(handle.physicalDone).catch(() => deadline)
        if (!task.logicalEnded) {
          // A通常先结算result；允许其同一tick回调完成，不能无限等坏服务。
          await Promise.resolve()
          if (!task.logicalEnded) finish(resultOf('unknown', 'UNCONFIRMED', meta))
        }
      } catch {
        finish(resultOf(task.started ? 'unknown' : 'not_submitted', task.started ? 'SERVICE_UNKNOWN' : 'ARTIFACT_UNAVAILABLE', task.meta))
        if (task.started) await deadline
      } finally { snapshot = null; data = null; release() }
    }
  }

  function dispose () {
    if (closing) return closing
    closed = true
    origin.dispose()
    for (const task of active) task.controller.abort()
    let endArtifacts
    try { endArtifacts = Promise.resolve(artifacts.close()).catch(() => {}) } catch { endArtifacts = Promise.resolve() }
    closing = Promise.allSettled([endArtifacts, ...registrationJobs, ...[...active].map(task => task.done)]).then(() => {})
    return closing
  }
  return Object.freeze({
    bind, observeClaim: origin.observeClaim, observeSessionEvent: origin.observeSessionEvent,
    observeToolResult: origin.observeToolResult, scopeOf: origin.scopeOf,
    toolDefinition: () => ({
      name: 'echo_qq_file_send',
      description: '发送本轮已展示的工作区文件到当前QQ主人的对话。先用原有工具在echo-outgoing目录准备文件并成功present；随后只填该轮登记的友好相对文件名ref。一次一个非空文件，最多8MiB，不选择其它聊天，提交结果未知时不自动重发。',
      parameters: { ref: { type: 'string', description: 'echo-outgoing内、本轮成功present的相对文件名', required: true } },
      isConcurrencySafe: () => true,
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        ok: { type: 'boolean', required: true },
        state: { type: 'string', enum: [...STATES], required: true },
        code: { type: 'string', enum: Object.keys(TEXT), required: true },
        ref: { type: 'string' }, name: { type: 'string' }, bytes: { type: 'number' }
      } }, render },
      execute
    }),
    dispose
  })
}
