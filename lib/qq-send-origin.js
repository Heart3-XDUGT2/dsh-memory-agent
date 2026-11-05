/**
 * 037-C1：固定原生发送域。只证明真实输入、present和工具根，不读文件或发送字节。
 * 轮内authority跨步骤；单次send根的isCurrent更窄，两者不能混用。
 */
import { createHash } from 'node:crypto'
import { isEchoSource } from './source-kind.js'
import { formOf, FORM } from './speak.js'

const SEND = 'echo_qq_file_send'
const PRESENT = 'present'
const MAX_CANONICAL_BYTES = 131072
const MAX_RECENT_IDS = 1024
// 不强留已结束的输入或执行对象；外部仍持有旧exec/token时，也不能借新轮重放。
const messageUses = new WeakSet()
const executionUses = new WeakMap()
const tokenUses = new WeakMap()
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const key = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const failure = (code = 'ORIGIN_UNPROVEN') => ({ ok: false, code })

function exactlyTrue (callback) {
  try {
    if (typeof callback !== 'function') return false
    const value = callback()
    if (value !== true && value !== null && typeof value === 'object' && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {})
    }
    return value === true
  } catch { return false }
}

function canonical (value) {
  let bytes = 0
  const piece = text => {
    bytes += Buffer.byteLength(text)
    if (bytes > MAX_CANONICAL_BYTES) throw Error('UNVERIFIABLE')
    return text
  }
  function visit (value, depth) {
    if (depth > 32) throw Error('UNVERIFIABLE')
    if (value === null || typeof value === 'boolean') return piece(JSON.stringify(value))
    if (typeof value === 'string') {
      if (value.length > MAX_CANONICAL_BYTES) throw Error('UNVERIFIABLE')
      return piece(JSON.stringify(value))
    }
    if (typeof value === 'number' && Number.isFinite(value)) return piece(JSON.stringify(value))
    if (Array.isArray(value)) {
      if (value.length > 256) throw Error('UNVERIFIABLE')
      for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) throw Error('UNVERIFIABLE')
      return piece('[') + value.map((item, index) => (index ? piece(',') : '') + visit(item, depth + 1)).join('') + piece(']')
    }
    if (object(value) && Object.getPrototypeOf(value) === Object.prototype) {
      const names = Object.keys(value).sort()
      if (names.length > 256 || names.some(name => name.length > 1024)) throw Error('UNVERIFIABLE')
      return piece('{') + names.map((name, index) => (index ? piece(',') : '')
        + piece(JSON.stringify(name) + ':') + visit(value[name], depth + 1)).join('') + piece('}')
    }
    throw Error('UNVERIFIABLE')
  }
  return visit(value, 0)
}
const fingerprint = message => createHash('sha256').update(canonical(message)).digest('hex')
const argsValue = raw => typeof raw === 'string' ? JSON.parse(raw) : raw
function rememberRecent (set, value) {
  if (set.has(value)) set.delete(value)
  set.add(value)
  while (set.size > MAX_RECENT_IDS) set.delete(set.values().next().value)
}

function sourceOf (raw) {
  if (!object(raw) || !['private', 'group'].includes(raw.chatType) || raw.isMaster !== true
    || ![raw.chatId, raw.senderId].every(value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value))
    || (raw.chatType === 'private' && raw.chatId !== raw.senderId)) return null
  return Object.freeze({ chatType: raw.chatType, chatId: raw.chatId, senderId: raw.senderId, isMaster: true })
}
const sameSource = (a, b) => !!a && !!b && a.chatType === b.chatType && a.chatId === b.chatId
  && a.senderId === b.senderId && a.isMaster === true && b.isMaster === true
function messageSource (message) {
  const raw = message?.source
  return message?.role === 'user' && key(message.id) && isEchoSource(raw)
    && formOf(raw.form) === FORM.INBOUND && raw.platform === 'qq' ? sourceOf(raw) : null
}
function presentFiles (raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32) return null
  const files = []
  for (const one of raw) {
    if (!object(one) || Object.keys(one).some(name => !['path', 'description'].includes(name))
      || typeof one.path !== 'string' || one.path.trim() === '' || one.path.length > 8192 || one.path.includes('\0')
      || (one.description !== undefined && (typeof one.description !== 'string' || one.description.length > 4096))) return null
    files.push({ path: one.path, ...(one.description !== undefined ? { description: one.description } : {}) })
  }
  return { canonical: canonical(files), files: files.map(file => Object.freeze({ path: file.path })) }
}

export function createQQSendOrigin ({
  isEnabled = () => false, sessionEnabledOf = () => false,
  onPresented = () => {}, onRevoke = () => {}
} = {}) {
  const agents = new WeakMap(), sessions = new WeakMap(), grants = new WeakMap(), active = new Set()
  let disposed = false
  const allowed = agent => {
    try { return !disposed && exactlyTrue(isEnabled) && key(agent?.session?.id)
      && exactlyTrue(() => sessionEnabledOf(agent.session.id)) } catch { return false }
  }
  function notify (callback, value) {
    try { Promise.resolve(callback(value)).catch(() => {}) } catch {}
  }
  function revoke (state, current, code) {
    if (!current) return
    current.blocked = true
    if (!current.authority || current.revoked) return
    current.revoked = true
    active.delete(current)
    notify(onRevoke, { grant: current.grant, authority: current.authority, code })
  }
  function authorityLive (state, current) {
    if (!current || current.revoked || current.blocked || !current.authority || !current.entered
      || state.revoked || disposed || state.current !== current || state.agent.session !== state.session
      || agents.get(state.agent) !== state || sessions.get(state.session) !== state) return false
    if (!allowed(state.agent) || ![...current.guards].every(exactlyTrue)) {
      revoke(state, current, 'ORIGIN_REVOKED')
      return false
    }
    return true
  }
  function issue (state, current) {
    const grant = Object.freeze(Object.create(null))
    grants.set(grant, { state, current })
    return grant
  }
  function scopeOf (grant) {
    const proof = object(grant) ? grants.get(grant) : null
    if (!proof || !authorityLive(proof.state, proof.current)) return null
    const { state, current } = proof
    return Object.freeze({
      agent: state.agent, session: state.session, turn: current.number, authority: current.authority,
      isCurrent: () => authorityLive(state, current)
    })
  }
  function bad (state, code = 'ORIGIN_UNPROVEN') {
    if (state?.current) revoke(state, state.current, code)
    return failure(code)
  }
  function protectedBinding (state, id, binding) {
    return !!state.current && (state.current.claims.has(id) || binding.claimedTurn === state.current.number)
  }
  function pruneBindings (state) {
    for (const [id, binding] of state.bindings) {
      if (protectedBinding(state, id, binding)) continue
      if (binding.claimedTurn !== undefined || !exactlyTrue(binding.guard)) {
        state.bindings.delete(id)
        if (binding.claimedTurn !== undefined) rememberRecent(state.recentInputs, id)
      }
    }
  }
  function retireTurn (state, current) {
    if (!current) return
    for (const id of current.claims.keys()) rememberRecent(state.recentInputs, id)
    for (const [id, binding] of state.bindings) if (binding.claimedTurn === current.number) {
      rememberRecent(state.recentInputs, id)
      state.bindings.delete(id)
    }
    for (const id of current.rootIds) rememberRecent(state.recentRoots, id)
  }
  function bind ({ agent, message, env, isCurrent } = {}) {
    try {
      if (!allowed(agent) || agent?.status !== 'idle' || !object(agent?.session) || !object(agent?.inbox)
        || !integer(agent.session.seq) || typeof agent.session.eventAt !== 'function'
        || env?.platform !== 'qq' || !exactlyTrue(isCurrent)) return failure()
      const source = sourceOf(env), actual = messageSource(message)
      if (!sameSource(source, actual)) return failure()
      const digest = fingerprint(message)
      let state = agents.get(agent)
      if (state && (state.revoked || state.session !== agent.session)) return failure()
      if (!state) {
        const previous = sessions.get(agent.session)
        if (previous) { previous.revoked = true; revoke(previous, previous.current, 'AGENT_CHANGED') }
        state = { agent, session: agent.session, lastSeq: agent.session.seq - 1, lastTurn: -1,
          current: null, bindings: new Map(), recentInputs: new Set(), recentRoots: new Set(), revoked: false }
        agents.set(agent, state); sessions.set(agent.session, state)
      }
      pruneBindings(state)
      if (messageUses.has(message) || state.recentInputs.has(message.id) || state.current?.claims.has(message.id)) return failure()
      const old = state.bindings.get(message.id)
      if (old) return old.fingerprint === digest && sameSource(old.source, source) && exactlyTrue(old.guard)
        ? { ok: true } : failure()
      if (state.bindings.size >= 64) {
        const victim = [...state.bindings].find(([id, binding]) => !protectedBinding(state, id, binding))
        if (!victim) return failure('ORIGIN_CAPACITY')
        state.bindings.delete(victim[0])
      }
      if (!exactlyTrue(isCurrent)) return failure()
      state.bindings.set(message.id, { source, fingerprint: digest, guard: isCurrent })
      return { ok: true }
    } catch { return failure() }
  }
  function observeClaim ({ agent, message, turn } = {}) {
    const state = agents.get(agent), current = state?.current
    try {
      if (!state || state.revoked || state.session !== agent?.session || sessions.get(state.session) !== state
        || !current || current.number !== turn || current.step !== null || current.blocked) return bad(state)
      const bound = state.bindings.get(message?.id), source = messageSource(message)
      if (!bound || !sameSource(source, bound.source) || bound.fingerprint !== fingerprint(message)
        || messageUses.has(message)) return bad(state)
      bound.claimedTurn = current.number
      messageUses.add(message)
      if (!exactlyTrue(bound.guard) || current.claims.has(message.id)
        || current.claims.size >= 64 || (current.source && !sameSource(current.source, source))) return bad(state)
      current.claims.set(message.id, { ...bound, entered: false })
      current.source = bound.source
      return { ok: true }
    } catch { return bad(state) }
  }
  function nativeRoot (state, exec, name) {
    const current = state?.current
    if (!state || !current || !authorityLive(state, current) || state.agent !== exec?.agent
      || exec.agent.status !== 'running' || current.step === null || exec.name !== name || !key(exec.callId)
      || typeof exec.token !== 'symbol' || Symbol.keyFor(exec.token) !== undefined || exec.parent !== undefined
      || (exec.rootCallId !== undefined && exec.rootCallId !== exec.callId)
      || !(exec.signal instanceof AbortSignal) || exec.signal.aborted) return null
    const root = current.roots.get(exec.callId)
    if (!root?.ready || root.name !== name || root.step !== current.step
      || root.arguments !== canonical(exec.arguments)) return null
    for (const seen of [executionUses.get(exec), tokenUses.get(exec.token)]) {
      if (seen && (seen.state !== state || seen.current !== current || seen.root !== root)) return null
    }
    return { current, root }
  }
  function rememberExecution (state, current, root, exec) {
    const use = root.executionUse ??= { state, current, root }
    executionUses.set(exec, use)
    tokenUses.set(exec.token, use)
  }
  function maybePresented (state, current, root) {
    if (root.emitted || root.failed || !root.runtimeSuccess || !root.presented || !root.resultSeen
      || !authorityLive(state, current)) return
    root.emitted = true
    notify(onPresented, { grant: current.grant, callId: root.id, files: root.files.map(file => ({ ...file })) })
  }
  function observeToolResult (exec, result) {
    if (![PRESENT, SEND].includes(exec?.name)) return { ok: true, ignored: true }
    const state = agents.get(exec?.agent)
    try {
      const proof = nativeRoot(state, exec, exec.name)
      if (!proof || !Object.isFrozen(exec)) return bad(state)
      const { current, root } = proof
      rememberExecution(state, current, root, exec)
      if (exec.name === SEND) {
        if (root.token && root.token !== exec.token) return bad(state)
        root.runtimeDone = true
        return { ok: true }
      }
      const value = result?.value
      if (root.runtimeSeen) {
        return root.token === exec.token && root.runtimeFingerprint === canonical(result?.isError === true
          ? { isError: true } : { isError: result?.isError, value }) ? { ok: true, duplicate: true } : bad(state)
      }
      root.runtimeSeen = true; root.token = exec.token
      if (result?.isError === true) {
        root.failed = true; root.runtimeFingerprint = canonical({ isError: true })
        if (root.presented) return bad(state)
        return { ok: true }
      }
      const parsed = presentFiles(value?.files)
      if (result?.isError !== false || !object(value) || value.turn !== current.number
        || !parsed || parsed.canonical !== root.filesCanonical) return bad(state)
      root.runtimeFingerprint = canonical({ isError: false, value })
      root.runtimeSuccess = true
      maybePresented(state, current, root)
      return { ok: true }
    } catch { return bad(state) }
  }
  function observeSessionEvent (session, event) {
    const state = sessions.get(session)
    if (!state) return { ok: true, ignored: true }
    try {
      if (disposed || state.revoked || state.agent.session !== session || !integer(event?.seq)
        || event.seq !== state.lastSeq + 1 || session.eventAt(event.seq) !== event) {
        state.revoked = true
        return bad(state)
      }
      state.lastSeq = event.seq
      const data = event.data, current = state.current
      if (event.type === 'turn/start') {
        if (current || !integer(data?.turn) || data.turn <= state.lastTurn) return bad(state)
        state.lastTurn = data.turn
        state.current = { number: data.turn, step: null, steps: 0, claims: new Map(), source: null,
          entered: 0, guards: new Set(), authority: null, grant: null, blocked: false, revoked: false,
          roots: new Map(), rootIds: new Set(), assistantSeen: false, presents: 0 }
        return { ok: true }
      }
      if (event.type === 'turn/end') {
        if (current && data?.turn !== current.number) state.revoked = true
        revoke(state, current, 'TURN_ENDED')
        retireTurn(state, current)
        state.current = null
        return { ok: !state.revoked }
      }
      if (!current) return { ok: true, ignored: true }
      if (current.blocked) return failure()
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return bad(state)
      if (event.type === 'step/start') {
        if (current.step !== null || data?.turn !== current.number || data.step !== current.steps + 1) return bad(state)
        current.step = data.step; current.steps++; current.assistantSeen = false; current.roots.clear()
      } else if (event.type === 'step/end') {
        if (data?.turn !== current.number || data.step !== current.step) return bad(state)
        current.step = null; current.roots.clear()
      } else if (event.type === 'user/message') {
        const claim = current.claims.get(data?.id)
        if (!claim) {
          const context = data?.role === 'user' && (data?.source?.kind === 'runtime-context'
            || (isEchoSource(data?.source) && data.source.form === 'snapshot'))
          return context ? { ok: true, ignored: true } : bad(state)
        }
        if (current.step === null || current.assistantSeen || event.surfaceOp !== 'append') return bad(state)
        if (claim.entered || claim.fingerprint !== fingerprint(data) || !sameSource(messageSource(data), claim.source)
          || !exactlyTrue(claim.guard)) return bad(state)
        messageUses.add(data) // Session可为claim输入写入独立快照；两种实际对象都不重新绑定。
        claim.entered = true; current.entered++; current.guards.add(claim.guard)
        state.bindings.delete(data.id)
        if (!current.authority) {
          if (active.size >= 32) return bad(state, 'ORIGIN_CAPACITY')
          current.authority = Object.freeze(Object.create(null))
          current.grant = issue(state, current)
          active.add(current)
        }
        if (!authorityLive(state, current)) return bad(state)
      } else if (event.type === 'assistant/message') {
        if (data?.turn !== current.number || data.step !== current.step || current.step === null
          || current.assistantSeen || data.interrupted || event.surfaceOp !== 'append'
          || data.message?.role !== 'assistant' || !Array.isArray(data.message.content)) return bad(state)
        current.assistantSeen = true
        for (const block of data.message.content) {
          if (block?.type !== 'tool-call' || ![PRESENT, SEND].includes(block.name)) continue
          if (!key(block.id) || state.recentRoots.has(block.id) || current.rootIds.has(block.id) || current.rootIds.size >= 1024
            || current.roots.size >= 32 || (block.name === PRESENT && current.presents >= 32)) return bad(state, 'ORIGIN_CAPACITY')
          const args = argsValue(block.arguments), declared = canonical(args)
          let files = null
          if (block.name === PRESENT) {
            files = object(args) && Object.keys(args).every(name => name === 'files') ? presentFiles(args.files) : null
            if (!files) return bad(state)
            current.presents++
          }
          current.rootIds.add(block.id)
          current.roots.set(block.id, { id: block.id, name: block.name, step: current.step, declared,
            ready: false, used: false, resultSeen: false, runtimeDone: false,
            ...(files ? { files: files.files, filesCanonical: files.canonical } : {}) })
        }
      } else if (event.type === 'tool/call' && [PRESENT, SEND].includes(data?.name)) {
        const root = current.roots.get(data.callId), args = argsValue(data.arguments)
        if (data.turn !== current.number || data.step !== current.step || !root || root.ready
          || root.name !== data.name || root.declared !== canonical(args)) return bad(state)
        root.arguments = canonical(args); root.ready = true; root.callSeq = event.seq
      } else if (event.type === 'deliverables/presented') {
        const root = current.roots.get(data?.callId), parsed = presentFiles(data?.files)
        if (!root || root.name !== PRESENT || !root.ready || root.step !== current.step || root.failed
          || data.turn !== current.number || !parsed || parsed.canonical !== root.filesCanonical) return bad(state)
        if (root.presented) return { ok: true, duplicate: true }
        root.presented = true
        maybePresented(state, current, root)
      } else if (event.type === 'tool/result') {
        const message = data?.message, root = current.roots.get(message?.toolCallId)
        if (!root) return { ok: true, ignored: true }
        if (!root.ready || root.step !== current.step || message?.role !== 'tool'
          || message.source?.kind !== 'tool' || message.source.callId !== root.id
          || !Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length !== 1
          || event.sourceEventSeqs[0] !== root.callSeq || typeof message.isError !== 'boolean') return bad(state)
        if (root.resultSeen) return { ok: true, duplicate: true }
        root.resultSeen = true
        if (root.name === PRESENT) {
          if (message.isError) {
            root.failed = true
            if (root.presented || root.runtimeSuccess) return bad(state)
          } else maybePresented(state, current, root)
        }
      }
      return { ok: true }
    } catch { return bad(state) }
  }
  function proveSend (args, exec) {
    try {
      if (!object(args) || Object.keys(args).some(name => name !== 'ref')
        || typeof args.ref !== 'string' || args.ref.length < 1 || args.ref.length > 2048) return failure('INVALID_ARGUMENTS')
      const state = agents.get(exec?.agent), proof = nativeRoot(state, exec, SEND)
      if (!proof) return failure()
      const { current, root } = proof
      if (root.used || root.resultSeen || root.runtimeDone || root.arguments !== canonical(args)) return failure()
      rememberExecution(state, current, root, exec)
      root.used = true; root.token = exec.token
      const signal = exec.signal, token = exec.token, callId = exec.callId, raw = root.arguments
      return {
        // B登记、空scope查询与撤销须用同一个轮内grant；单根约束仍由下面的guard负责。
        ok: true, grant: current.grant, source: current.source, signal,
        isCurrent: () => {
          try {
            return authorityLive(state, current) && state.agent.status === 'running' && current.step === root.step
              && current.roots.get(callId) === root && root.used && root.token === token && !root.resultSeen
              && !root.runtimeDone && exec.agent === state.agent && exec.callId === callId && exec.token === token
              && exec.signal === signal && !signal.aborted && exec.name === SEND && exec.parent === undefined
              && (exec.rootCallId === undefined || exec.rootCallId === callId)
              && raw === canonical(args) && raw === canonical(exec.arguments)
          } catch { return false }
        }
      }
    } catch { return failure() }
  }
  function dispose () {
    if (disposed) return
    disposed = true
    for (const current of [...active]) {
      const proof = grants.get(current.grant)
      if (proof) revoke(proof.state, current, 'DISPOSED')
    }
  }
  return Object.freeze({ bind, observeClaim, observeSessionEvent, observeToolResult, scopeOf, proveSend, dispose })
}
