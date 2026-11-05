/**
 * 034：033真实QQ来源证明的机械抽取，仅支持forward/file两个固定域。
 * 不接模型自报聊天，不管理下载、正文或分页。
 */
import { createHash } from 'node:crypto'
import { isEchoSource } from './source-kind.js'
import { formOf, FORM } from './speak.js'
import { isForwardLabel } from './relay-content.js'

const TOKEN = /^[0-9a-f]{32}$/i
const integer = value => Number.isSafeInteger(value) && value >= 0
const key = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const failure = reason => ({ ok: false, reason })

export function isFileReadLabel (value) {
  if (typeof value !== 'string' || value.length > 43) return false
  const match = /^文件(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-([1-9]\d{0,15})$/.exec(value)
  if (!match || !Number.isSafeInteger(Number(match[2]))) return false
  const time = Date.parse(match[1])
  return Number.isFinite(time) && new Date(time).toISOString() === match[1]
}

function canonical (value, depth = 0) {
  if (depth > 32) throw Error('unverifiable')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']'
  if (object(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(name => JSON.stringify(name) + ':' + canonical(value[name], depth + 1)).join(',') + '}'
  }
  throw Error('unverifiable')
}

function fingerprint (message) {
  const text = canonical(message)
  if (Buffer.byteLength(text) > 131072) throw Error('message-capacity')
  return createHash('sha256').update(text).digest('hex')
}

function sourceScope (raw) {
  if (!object(raw) || !['private', 'group'].includes(raw.chatType)
    || !key(raw.chatId) || raw.chatId.length > 128 || !key(raw.senderId) || raw.senderId.length > 128) return null
  return { chatId: raw.chatId, chatType: raw.chatType, senderId: raw.senderId, isMaster: raw.isMaster === true }
}
const sameScope = (a, b) => !!a && !!b && a.chatId === b.chatId && a.chatType === b.chatType
  && (a.chatType !== 'private' || (a.isMaster && b.isMaster && a.senderId === b.senderId))
const aliasKey = (scope, label) => canonical([scope.chatType, scope.chatId, label])

/**
 * bind来自真实维护注入；claim还须有匹配user/message才激活别名。
 * run接收原始参数，不能在原生tool/call证明之前补缺省值。
 */
export function createQQReadOrigin ({
  domain, serviceOf, isEnabled = () => false, sessionEnabledOf = () => false, now = Date.now
} = {}) {
  if (!['forward', 'file'].includes(domain)) throw Error('invalid-read-domain')
  const fileDomain = domain === 'file'
  const NAME = fileDomain ? 'echo_qq_file_read' : 'echo_qq_forward_read'
  const method = fileDomain ? 'readFile' : 'readForward'
  const capacity = fileDomain ? 32 : 16
  const ttl = fileDomain ? 1800000 : 600000
  const isLabel = fileDomain ? isFileReadLabel : isForwardLabel
  const agents = new WeakMap(), sessions = new WeakMap()
  let disposed = false
  const allowed = agent => {
    try { return !disposed && isEnabled() === true && key(agent?.session?.id) && sessionEnabledOf(agent.session.id) === true } catch { return false }
  }
  const service = () => { try { return typeof serviceOf === 'function' ? serviceOf() : null } catch { return null } }
  const revokeEntry = (state, entry) => {
    entry.revoked = true
    state.bindings.delete(entry.ref)
    const alias = aliasKey(entry.source, entry.label)
    if (state.aliases.get(alias) === entry) state.aliases.delete(alias)
  }
  function purge (state) {
    const time = now()
    if (!Number.isFinite(time)) throw Error('clock-unavailable')
    for (const entry of state.bindings.values()) if (entry.expires <= time) revokeEntry(state, entry)
  }
  function messageSource (message) {
    const raw = message?.source
    if (message?.role !== 'user' || !key(message.id) || !isEchoSource(raw)
      || formOf(raw.form) !== FORM.INBOUND || raw.platform !== 'qq') return null
    const source = sourceScope(raw)
    if (!source || (source.chatType === 'private' && !source.isMaster)) return null
    if (!fileDomain) {
      if (raw.forwardRef !== undefined && (typeof raw.forwardRef !== 'string' || !TOKEN.test(raw.forwardRef))) return null
      return { source, refs: raw.forwardRef === undefined ? [] : [raw.forwardRef.toLowerCase()] }
    }
    if (raw.fileRefs === undefined) return { source, refs: [] }
    if (!Array.isArray(raw.fileRefs) || raw.fileRefs.length < 1 || raw.fileRefs.length > 2
      || raw.fileRefs.some(ref => typeof ref !== 'string' || !TOKEN.test(ref))) return null
    const refs = raw.fileRefs.map(ref => ref.toLowerCase())
    if (new Set(refs).size !== refs.length) return null
    return { source, refs }
  }
  function contentBindings (env) {
    if (!fileDomain) return env.forwardContent?.ref ? [env.forwardContent] : []
    if (env.files === undefined) return []
    if (!Array.isArray(env.files) || env.files.length > 2) return null
    const entries = []
    for (const one of env.files) {
      if (!object(one)) return null
      // 不支持或没有有效引用的文件只有收件元数据，不可读正文。
      if (one.ref === undefined) continue
      entries.push(one)
    }
    return entries
  }
  function bind ({ agent, env } = {}) {
    if (!allowed(agent) || agent?.status !== 'idle' || !object(agent?.session)
      || !object(agent?.inbox) || !integer(agent.session.seq) || typeof agent.session.eventAt !== 'function') return failure('unproven-origin')
    const source = env?.platform === 'qq' ? sourceScope(env) : null
    if (!source || (source.chatType === 'private' && !source.isMaster)) return failure('unproven-origin')
    let state = agents.get(agent)
    if (state && (state.session !== agent.session || state.revoked)) return failure('unproven-origin')
    if (!state) {
      const previous = sessions.get(agent.session)
      if (previous) previous.revoked = true
      state = { agent, session: agent.session, lastSeq: agent.session.seq - 1, lastTurn: 0, generation: 0,
        current: null, bindings: new Map(), aliases: new Map(), seenRoots: new Set(), revoked: false }
      agents.set(agent, state); sessions.set(agent.session, state)
    }
    try { purge(state) } catch { return failure('unavailable') }
    const contents = contentBindings(env)
    if (!contents) return failure('unproven-origin')
    const pending = [], seen = new Set(), labels = new Set()
    // 先验证整条输入，双文件不能只留下前半个合法绑定。
    for (const content of contents) {
      if (typeof content.ref !== 'string' || !TOKEN.test(content.ref) || !isLabel(content.label)) return failure('unproven-origin')
      const ref = content.ref.toLowerCase(), label = content.label
      if (seen.has(ref) || labels.has(label)) return failure('unproven-origin')
      seen.add(ref); labels.add(label)
      const old = state.bindings.get(ref)
      if (old && (!sameScope(old.source, source) || old.label !== label)) return failure('unproven-origin')
      pending.push({ ref, label, old })
    }
    for (const { label, old } of pending) {
      if (old) continue
      // 异常重名不继承旧授权；新引用仍须实际消息入场。
      for (const entry of state.bindings.values()) if (aliasKey(entry.source, entry.label) === aliasKey(source, label)) revokeEntry(state, entry)
    }
    const newCount = pending.filter(one => !one.old).length
    while (state.bindings.size + newCount > capacity) {
      // 同一条双文件输入中已核验的旧引用不能被新引用的容量淘汰。
      const victim = [...state.bindings.values()].find(entry => !seen.has(entry.ref))
      if (!victim) return failure('unavailable')
      revokeEntry(state, victim)
    }
    for (const { ref, label, old } of pending) if (!old) {
      state.bindings.set(ref, { ref, label, source, expires: now() + ttl, revoked: false })
    }
    return { ok: true }
  }
  function observeClaim ({ agent, message, turn } = {}) {
    const state = agents.get(agent), current = state?.current
    if (!state || state.revoked || state.session !== agent?.session || sessions.get(state.session) !== state
      || !current || current.number !== turn || current.step !== null) {
      if (current) current.blocked = true
      return failure('unproven-origin')
    }
    current.version++
    const origin = messageSource(message)
    if (!origin || current.claims.size >= 64 || current.claims.has(message.id)
      || (current.source && !sameScope(current.source, origin.source))) {
      current.blocked = true; return failure('unproven-origin')
    }
    try {
      current.claims.set(message.id, { ...origin, fingerprint: fingerprint(message), entered: false })
      current.source = origin.source
      return { ok: true }
    } catch { current.blocked = true; return failure('unproven-origin') }
  }
  function observeSessionEvent (session, event) {
    const state = sessions.get(session)
    if (!state) return { ok: true, ignored: true }
    const bad = () => { if (state.current) state.current.blocked = true; return failure('unproven-origin') }
    try {
      if (disposed || state.revoked || state.agent.session !== session || !integer(event?.seq)
        || event.seq !== state.lastSeq + 1 || session.eventAt(event.seq) !== event) { state.revoked = true; return bad() }
      state.lastSeq = event.seq
      const data = event.data, current = state.current
      if (event.type === 'turn/start') {
        if (current || !integer(data?.turn) || data.turn <= state.lastTurn) { state.revoked = true; return bad() }
        state.lastTurn = data.turn
        state.current = { number: data.turn, generation: ++state.generation, step: null, steps: 0,
          version: 0, claims: new Map(), source: null, entered: 0, roots: new Map(), blocked: false, assistantSeen: false }
        return { ok: true }
      }
      if (event.type === 'turn/end') {
        if (current && data?.turn !== current.number) state.revoked = true
        state.current = null
        return { ok: !state.revoked }
      }
      if (!current) return { ok: true, ignored: true }
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return bad()
      if (event.type === 'step/start') {
        if (current.step !== null || data?.turn !== current.number || data.step !== current.steps + 1) return bad()
        current.step = data.step; current.steps++; current.assistantSeen = false; current.roots.clear()
      } else if (event.type === 'step/end') {
        if (data?.turn !== current.number || data.step !== current.step) return bad()
        current.step = null; current.roots.clear()
      } else if (event.type === 'user/message') {
        if (current.step === null || current.assistantSeen || event.surfaceOp !== 'append') return bad()
        const claim = current.claims.get(data?.id)
        if (!claim) {
          const context = data?.source?.kind === 'runtime-context'
            || (isEchoSource(data?.source) && data.source.form === 'snapshot')
          return context ? { ok: true, ignored: true } : bad()
        }
        if (claim.entered || fingerprint(data) !== claim.fingerprint) return bad()
        claim.entered = true; current.entered++; current.source = claim.source
        if (claim.refs.length) {
          purge(state)
          const entries = claim.refs.map(ref => state.bindings.get(ref))
          if (entries.some(entry => !entry || !sameScope(entry.source, claim.source))) return bad()
          // 先核全部，再原子激活两个友好名称。
          for (const entry of entries) state.aliases.set(aliasKey(entry.source, entry.label), entry)
        }
      } else if (event.type === 'assistant/message') {
        if (data?.turn !== current.number || data.step !== current.step || current.step === null
          || current.assistantSeen || data.interrupted || event.surfaceOp !== 'append'
          || data.message?.role !== 'assistant' || !Array.isArray(data.message.content)) return bad()
        current.assistantSeen = true
        for (const block of data.message.content) {
          if (block?.type !== 'tool-call' || block.name !== NAME) continue
          if (!key(block.id) || state.seenRoots.has(block.id) || state.seenRoots.size >= 1024 || current.roots.size >= 32) return bad()
          state.seenRoots.add(block.id)
          current.roots.set(block.id, { name: block.name, step: current.step, ready: false, used: false, settled: false })
        }
      } else if (event.type === 'tool/call' && data?.name === NAME) {
        const root = current.roots.get(data.callId)
        if (data.turn !== current.number || data.step !== current.step || !root || root.ready) return bad()
        root.arguments = canonical(typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments)
        root.ready = true
      } else if (event.type === 'tool/result') {
        const root = current.roots.get(data?.message?.callId)
        if (root) root.settled = true
      }
      return { ok: true }
    } catch { return bad() }
  }
  function proofFor (args, exec) {
    const state = agents.get(exec?.agent), current = state?.current
    if (!allowed(exec?.agent) || !state || state.revoked || state.session !== exec.agent.session
      || sessions.get(state.session) !== state || exec.agent.status !== 'running' || !current || current.blocked
      || current.step === null || !current.entered || !current.source || !key(exec.callId)
      || exec.name !== NAME || typeof exec.token !== 'symbol' || exec.parent !== undefined
      || (exec.rootCallId !== undefined && exec.rootCallId !== exec.callId)
      || !exec.signal || exec.signal.aborted !== false) return null
    const root = current.roots.get(exec.callId)
    if (!root?.ready || root.used || root.settled || root.step !== current.step
      || root.arguments !== canonical(args) || root.arguments !== canonical(exec.arguments)) return null
    purge(state)
    const entry = state.aliases.get(aliasKey(current.source, args.ref))
    if (!entry || entry.revoked || state.bindings.get(entry.ref) !== entry || !sameScope(entry.source, current.source)) return null
    return { state, current, root, entry, version: current.version, step: current.step }
  }
  async function run (args, exec, consume) {
    let proof
    try { proof = proofFor(args, exec) } catch { proof = null }
    if (!proof) return failure(exec?.signal?.aborted ? 'canceled' : 'unproven-origin')
    const channel = service()
    if (!object(channel) || typeof channel[method] !== 'function') return failure('unavailable')
    const { state, current, root, entry } = proof
    root.used = true; root.token = exec.token
    const isCurrent = () => {
      try {
        return allowed(exec.agent) && !disposed && !exec.signal.aborted && !state.revoked
          && exec.agent.session === state.session && sessions.get(state.session) === state
          && state.current === current && !current.blocked && current.version === proof.version
          && current.step === proof.step && current.roots.get(exec.callId) === root && root.token === exec.token
          && !root.settled && service() === channel && !entry.revoked && state.bindings.get(entry.ref) === entry
          && state.aliases.get(aliasKey(current.source, args.ref)) === entry
          && sameScope(entry.source, current.source) && entry.expires > now()
      } catch { return false }
    }
    let result
    try {
      result = await consume({
        ref: entry.ref, label: entry.label, source: { ...current.source },
        signal: exec.signal, isCurrent, service: channel
      })
    } catch { return failure('unavailable') }
    if (!isCurrent()) return failure('stale-turn')
    return result
  }
  return Object.freeze({ bind, observeClaim, observeSessionEvent, run, dispose: () => { disposed = true } })
}
