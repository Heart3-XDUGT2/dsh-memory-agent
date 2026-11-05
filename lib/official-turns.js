/**
 * Stage A only: a caller-driven, process-local observer of one live Agent/Session.
 * No subscriptions, configuration, persistence, agents, intents or delivery APIs.
 * Feed every live session event in order; do not feed a history projection.
 */
import { createHash } from 'node:crypto'

const integer = n => Number.isSafeInteger(n) && n >= 0
const key = s => typeof s === 'string' && s.length > 0 && s.length <= 256
const defaults = { sources: 256, inputs: 256, roots: 128, rootIdentities: 1024, turns: 32, messageBytes: 131072, turnBytes: 1048576 }
const copy = v => structuredClone(v)
function canonical (v, depth = 0) {
  if (depth > 32) throw Error('message_depth')
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v)
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(x => canonical(x, depth + 1)).join(',') + ']'
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k], depth + 1)).join(',') + '}'
  }
  throw Error('non_json_message')
}
function deeplyFrozen (v, depth = 0) {
  if (!v || typeof v !== 'object') return true
  return depth <= 32 && Object.isFrozen(v) && Object.values(v).every(x => deeplyFrozen(x, depth + 1))
}

/**
 * The caller owns unique bootEpoch/agentEpoch and a synchronous, complete feed.
 * liveFromSeq is the next append seq at attachment, not the beginning of history.
 * Registration is a trusted internal action, never authorization from message text.
 */
export function createOfficialTurnTracker ({ agent, session, bootEpoch, agentEpoch, liveFromSeq, limits = {} }) {
  if (!agent || !session || agent.session !== session || !key(session.id) || !key(bootEpoch) || !key(agentEpoch) || !integer(liveFromSeq)) throw TypeError('invalid_tracker_identity')
  const cap = { ...defaults, ...limits }
  if (Object.keys(cap).some(k => !Object.hasOwn(defaults, k) || !Number.isSafeInteger(cap[k]) || cap[k] < 1 || cap[k] > defaults[k])) throw TypeError('invalid_tracker_limits')
  const sources = new Map(), sourceKeys = new Map(), inboundKeys = new Map(), seenRoots = new Set(), history = []
  const sessionId = session.id
  let current = null, lastSeq = liveFromSeq - 1, lastTurn = null, revoked = false, integrityLost = false
  const no = reason => ({ ok: false, reason })
  const fault = reason => {
    integrityLost = true
    if (current && !current.reasons.includes(reason)) current.reasons.push(reason)
    return no(reason)
  }
  const mark = reason => {
    if (current && !current.reasons.includes(reason)) current.reasons.push(reason)
    return no(reason)
  }
  function digest (message) {
    const text = canonical(message)
    const bytes = Buffer.byteLength(text)
    if (bytes > cap.messageBytes) throw Error('message_capacity')
    return { digest: createHash('sha256').update(text).digest('hex'), bytes }
  }
  const identity = context => context?.agent === agent && context?.session === session && agent.session === session && session.id === sessionId
  function classify (message) {
    const s = message?.source
    if (s?.kind === 'user') return 'local_human'
    if (s?.kind === 'runtime-context') return 'context'
    if (s?.kind === 'plugin:dsh-echo') {
      if (s.form === 'snapshot') return 'context'
      if (s.form === 'relay') return s.platform === 'qq-official' ? 'untrusted_official' : 'other_human'
      if (['care', 'reminder', 'mind', 'wake', 'say_again', 'proactive', 'reflect'].includes(s.form)) return 'proactive'
    }
    return 'unknown_input'
  }
  function unique () {
    if (!current || current.reasons.length || integrityLost || revoked) return false
    return current.inputs.filter(i => i.kind === 'official').length === 1 && current.inputs.every(i => ['official', 'context'].includes(i.kind))
  }
  function summary (t) {
    return { hostTurnUid: t.uid, bootEpoch, agentEpoch, sessionId, turn: t.turn, startSeq: t.startSeq,
      endSeq: t.endSeq ?? null, endReason: t.endReason ?? null, steps: t.steps, claims: [...t.claims.values()].map(copy),
      inputs: t.inputs.map(copy), assistantMessages: t.assistantMessages, assistantBytes: t.assistantBytes,
      roots: [...t.roots.values()].map(copy), reasons: [...t.reasons], closed: t.closed,
      associationEligible: t.closed && t.endReason === 'completed' && !t.reasons.length && t.qualified && !revoked && !integrityLost,
      deliveryAuthorized: false, persisted: false }
  }
  function snapshot () { return { revoked, integrityLost, lastSeq, registeredSources: sources.size, rootIdentities: seenRoots.size, current: current ? summary(current) : null, turns: history.map(summary) } }
  function safe (fn) {
    return (...args) => { try { return fn(...args) } catch (error) { return fault(['message_capacity', 'message_depth', 'non_json_message'].includes(error?.message) ? error.message : 'invalid_observation') } }
  }
  function registerSource ({ message, sourceKey, inboundKey, scopeKey }) {
    if (revoked) return no('revoked')
    if (!key(sourceKey) || !key(inboundKey) || !key(scopeKey) || !key(message?.id) || message.role !== 'user' || !deeplyFrozen(message)) return no('invalid_source_registration')
    const context = message.source?.replyContext
    if (message.source?.kind !== 'plugin:dsh-echo' || message.source.form !== 'relay' || message.source.platform !== 'qq-official' || context?.sourceKey !== sourceKey || context?.inboundKey !== inboundKey || context?.scopeKey !== scopeKey) return no('source_context_mismatch')
    const fingerprint = digest(message).digest
    const old = sources.get(message.id)
    if (old) return old.fingerprint === fingerprint && old.sourceKey === sourceKey && old.inboundKey === inboundKey && old.scopeKey === scopeKey ? { ok: true, duplicate: true } : fault('source_identity_conflict')
    if (sourceKeys.has(sourceKey) || inboundKeys.has(canonical([scopeKey, inboundKey]))) return fault('source_identity_conflict')
    if (sources.size >= cap.sources) return fault('source_capacity')
    sources.set(message.id, { messageId: message.id, sourceKey, inboundKey, scopeKey, fingerprint, state: 'registered', claimedUid: null, enteredUid: null })
    sourceKeys.set(sourceKey, message.id)
    inboundKeys.set(canonical([scopeKey, inboundKey]), message.id)
    return { ok: true, duplicate: false, messageId: message.id }
  }
  function observeClaim (context) {
    if (!identity(context)) return no('wrong_instance')
    if (revoked) return no('revoked')
    const { message, turn } = context
    if (!current || current.turn !== turn || current.step !== null) return fault('claim_boundary')
    if (!key(message?.id)) return mark('invalid_claim')
    if (current.claims.size >= cap.inputs) return fault('input_capacity')
    if (current.claims.has(message.id)) return mark('duplicate_claim')
    const fingerprint = digest(message).digest
    const src = sources.get(message.id)
    if (src && (src.fingerprint !== fingerprint || src.enteredUid || src.claimedUid)) return mark('source_claim_conflict')
    const claim = { messageId: message.id, fingerprint, kind: src ? 'official' : classify(message) }
    current.claims.set(message.id, claim)
    if (src) { src.state = 'claimed'; src.claimedUid = current.uid }
    return { ok: true, candidate: true, entered: false, hostTurnUid: current.uid }
  }
  function checkReplacement (e) {
    const op = e.surfaceOp
    if (op === undefined || op === 'append') return null
    const cited = e.sourceEventSeqs
    if (!op || typeof op !== 'object' || Array.isArray(op) || Object.keys(op).length !== 3 ||
      !Object.hasOwn(op, 'op') || !Object.hasOwn(op, 'startSeq') || !Object.hasOwn(op, 'endSeq') ||
      op.op !== 'replace' || !integer(op.startSeq) || !integer(op.endSeq) ||
      op.startSeq >= e.seq || op.endSeq >= e.seq ||
      !Array.isArray(cited) || !cited.length || cited.length > cap.inputs ||
      cited.some(seq => !integer(seq) || seq >= e.seq) || new Set(cited).size !== cited.length ||
      !cited.includes(op.startSeq) || !cited.includes(op.endSeq)) return fault('invalid_surface_metadata')
    // Session has validated the actual positional range before publishing this
    // exact event. Citations may include extra nodes: they are NOT a removed set.
    // Use the host's committed surface, never a numeric range or a copied fold.
    if (!current || typeof session.eventAt !== 'function' || session.eventAt(e.seq) !== e ||
      !Array.isArray(session.surface?.nodes)) return mark('surface_replacement_unproven')
    const nodes = session.surface.nodes
    if (current.inputs.some(input => !nodes.includes(input.seq))) return mark('surface_input_replaced')
    if ([...current.roots.values()].some(root => !nodes.includes(root.assistantSeq))) return mark('surface_root_replaced')
    const target = session.eventAt(op.startSeq)
    // A narrow positive proof: exactly one own system/developer node was
    // replaced, all input/root nodes survive, and the accepted new node is live.
    // Seeded/unobserved prompts can be checked via eventAt without reading any
    // persisted history. Multi-node/other-producer ranges remain unproven.
    if (!['system/message', 'developer/message'].includes(e.type) || op.startSeq !== op.endSeq ||
      target?.type !== e.type || target.seq !== op.startSeq ||
      target.data?.message?.role !== e.data?.message?.role ||
      !key(target.data?.message?.source?.kind) ||
      canonical(target.data.message.source) !== canonical(e.data.message.source) ||
      !nodes.includes(e.seq) || nodes.includes(op.startSeq)) return mark('surface_replacement_unproven')
    return null
  }
  function observeSessionEvent (context) {
    if (!identity(context)) return no('wrong_instance')
    const e = context.event
    if (!integer(e?.seq) || typeof e.type !== 'string') return fault('invalid_event')
    if (e.seq < liveFromSeq) return no('historical_event')
    if (e.seq !== lastSeq + 1) return fault('event_order')
    lastSeq = e.seq
    const replacementFailure = checkReplacement(e)
    if (replacementFailure) return replacementFailure
    const d = e.data
    if (e.type === 'turn/start') {
      if (current || !integer(d?.turn) || d.turn === 0 || (lastTurn !== null && d.turn <= lastTurn)) return fault('turn_boundary')
      lastTurn = d.turn
      current = { uid: canonical([bootEpoch, agentEpoch, sessionId, e.seq, d.turn]), turn: d.turn, startSeq: e.seq,
        step: null, steps: 0, claims: new Map(), inputs: [], inputIds: new Set(), roots: new Map(), reasons: [...(integrityLost ? ['feed_integrity_lost'] : []), ...(revoked ? ['revoked'] : [])],
        bytes: 0, assistantMessages: 0, assistantBytes: 0, assistantInStep: false, closed: false, qualified: false }
      return { ok: true, hostTurnUid: current.uid }
    }
    if (e.type === 'step/start') {
      if (!current || current.step !== null || d?.turn !== current.turn || d.step !== current.steps + 1) return fault('step_boundary')
      current.step = d.step; current.steps++; current.assistantInStep = false
      return { ok: true }
    }
    if (e.type === 'step/end') {
      if (!current || current.step === null || d?.turn !== current.turn || d.step !== current.step) return fault('step_boundary')
      current.step = null
      return { ok: true }
    }
    if (e.type === 'user/message') {
      // data is UserMessage; it has NO turn field. The open boundaries supply it.
      if (!current || current.step === null || e.surfaceOp !== 'append' || current.assistantInStep) return fault('input_boundary')
      if (!key(d?.id) || d.role !== 'user') return mark('invalid_input')
      if (current.inputIds.has(d.id)) return mark('duplicate_input')
      if (current.inputs.length >= cap.inputs) return fault('input_capacity')
      const fp = digest(d), src = sources.get(d.id), claim = current.claims.get(d.id)
      current.bytes += fp.bytes
      if (current.bytes > cap.turnBytes) return fault('turn_capacity')
      let kind = classify(d)
      if (src) {
        if (src.fingerprint !== fp.digest || !claim || claim.fingerprint !== fp.digest || src.claimedUid !== current.uid || src.enteredUid) return mark('source_enter_conflict')
        src.state = 'entered'; src.enteredUid = current.uid
        kind = 'official'
      }
      const input = { messageId: d.id, kind, step: current.step, seq: e.seq, fingerprint: fp.digest,
        ...(src ? { sourceKey: src.sourceKey, inboundKey: src.inboundKey, scopeKey: src.scopeKey } : {}) }
      current.inputs.push(input); current.inputIds.add(d.id)
      if (!['official', 'context'].includes(kind)) mark(kind === 'proactive' ? 'proactive_input' : 'ambiguous_inputs')
      if (current.inputs.filter(i => i.kind === 'official').length > 1) mark('ambiguous_inputs')
      return { ok: true, entered: kind === 'official', hostTurnUid: current.uid, turn: current.turn, step: current.step }
    }
    if (e.type === 'assistant/message') {
      if (!current || current.step === null || d?.turn !== current.turn || d.step !== current.step || e.surfaceOp !== 'append' || current.assistantInStep) return fault('assistant_boundary')
      current.assistantInStep = true
      if (d.interrupted) mark('interrupted')
      const fp = digest(d.message)
      current.bytes += fp.bytes; current.assistantBytes += fp.bytes; current.assistantMessages++
      if (current.bytes > cap.turnBytes) return fault('turn_capacity')
      if (d.message?.role !== 'assistant' || !Array.isArray(d.message.content)) return mark('invalid_assistant')
      for (const block of d.message.content) {
        if (block.type !== 'tool-call') continue
        // Provider ids are not assumed unique across turns. Never let a later
        // publication with the same id capture a still-live prior execution.
        if (!key(block.id) || !key(block.name) || seenRoots.has(block.id)) return mark('root_identity_conflict')
        if (current.roots.size >= cap.roots) return fault('root_capacity')
        if (seenRoots.size >= cap.rootIdentities) return fault('root_identity_capacity')
        seenRoots.add(block.id)
        current.roots.set(block.id, { callId: block.id, name: block.name, step: current.step, assistantSeq: e.seq, order: current.roots.size })
      }
      return { ok: true }
    }
    if (e.type === 'turn/end') {
      if (!current || current.step !== null || d?.turn !== current.turn) return fault('turn_boundary')
      current.endReason = ['completed', 'blocked', 'error', 'aborted', 'max-tokens', 'interrupted', 'forked'].includes(d.reason?.kind) ? d.reason.kind : 'unknown'
      if (current.endReason !== 'completed') mark('turn_' + current.endReason)
      current.qualified = unique()
      if (!current.inputs.some(i => i.kind === 'official')) mark('no_official_input')
      current.closed = true; current.endSeq = e.seq
      for (const src of sources.values()) {
        if (src.enteredUid === current.uid) { src.state = 'turn_closed'; src.endReason = current.endReason }
        else if (src.claimedUid === current.uid) { src.state = 'not_entered'; src.endReason = current.endReason }
      }
      history.push(current)
      if (history.length > cap.turns) history.shift() // summaries only; never evict source replay guards
      const result = summary(current)
      current = null
      return { ok: true, turn: result }
    }
    if (['assistant/attempt', 'tool/call', 'tool/result', 'developer/message', 'system/message'].includes(e.type)) {
      if (!current || current.step === null || d?.turn !== current.turn || d.step !== current.step) return fault('event_boundary')
      // Object replacements reached here only after the host-backed proof above.
      return { ok: true, ignored: true }
    }
    // An unknown surface mutation cannot be asserted to preserve the final inputs.
    if (e.surfaceOp === 'replace' || e.surfaceOp === 'remove') return fault('surface_replacement')
    return { ok: true, ignored: true }
  }
  function resolveToolCall (exec) {
    if (!identity({ agent: exec?.agent, session: exec?.agent?.session })) return no('wrong_instance')
    if (revoked) return no('revoked')
    if (!exec.signal || typeof exec.signal.aborted !== 'boolean' || exec.signal.aborted) return no('canceled_or_missing_signal')
    if (!current || current.closed || current.step === null) return no('no_live_step')
    if (!unique()) return no('ineligible_inputs')
    // Nested/PTC propagation is intentionally unsupported until independently proven.
    if (exec.rootCallId !== undefined && exec.rootCallId !== exec.callId) return no('nested_unverified')
    const root = current.roots.get(exec.callId)
    if (!root || root.step !== current.step || root.name !== exec.name) return no('unpublished_root')
    const input = current.inputs.find(i => i.kind === 'official')
    return { ok: true, provisional: true, deliveryAuthorized: false, hostTurnUid: current.uid, turn: current.turn, step: root.step,
      rootCallId: root.callId, callId: exec.callId, order: root.order, sourceKey: input.sourceKey, inboundKey: input.inboundKey, scopeKey: input.scopeKey }
  }
  return Object.freeze({ registerSource: safe(registerSource), observeClaim: safe(observeClaim), observeSessionEvent: safe(observeSessionEvent), resolveToolCall: safe(resolveToolCall),
    sourceStatus: sourceKey => { const src = sources.get(sourceKeys.get(sourceKey)); return src ? copy(src) : null }, snapshot,
    revoke: () => { revoked = true; if (current) mark('revoked'); return { ok: true, revoked: true } } })
}
