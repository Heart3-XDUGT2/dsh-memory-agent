import { createHash } from 'node:crypto'

const PROTOCOL = 'echo-memory-strength-origin/v1'
const origins = new WeakMap()
const positive = value => Number.isSafeInteger(value) && value > 0
const seq = value => Number.isSafeInteger(value) && value >= 0
const digest = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
const callsOf = event => (Array.isArray(event?.data?.message?.content) ? event.data.message.content : [])
  .filter(block => block?.type === 'tool-call')
const stamp = event => JSON.stringify([event.type, event.seq, event.time, event.data?.turn,
  event.data?.step, event.data?.callId, event.data?.name, event.data?.interrupted,
  event.data?.message?.role, callsOf(event).map(block => [block.id, block.name])])
const completionStamp = event => JSON.stringify([stamp(event), event.data?.reason?.kind])

/** Only the trusted accepted-event subscription can mint source capabilities. */
export function createMemoryStrengthOrigin({ subscribe } = {}) {
  if (typeof subscribe !== 'function') throw Error('a1_source_subscription_required')
  const turns = new WeakMap(), accepted = new WeakMap(), handles = new WeakMap()
  const completed = new WeakMap(), completedExtract = new WeakMap()
  const lifetime = { live: true }
  function remember(session, event) {
    accepted.set(event, { session, stamp: stamp(event) })
  }
  function mint(kind, session, start, call = null, assistant = null) {
    const event = call ?? start
    let purposes = handles.get(event)
    if (!purposes) { purposes = new Map(); handles.set(event, purposes) }
    if (purposes.has(kind)) return purposes.get(kind)
    const fields = [PROTOCOL, kind, session.id, String(start.seq), String(start.data.turn)]
    if (call) fields.push(String(call.seq), String(call.data.callId))
    const handle = Object.freeze(Object.create(null))
    origins.set(handle, { lifetime, accepted, session, sessionId: session.id, start, call, assistant,
      kind, sourceIdentity: 'host:' + digest(fields), occurredAtMs: event.time,
      admissionIdentity: 'admission:' + digest([PROTOCOL, session.id, String(start.seq), String(start.data.turn)]) })
    purposes.set(kind, handle)
    return handle
  }
  function observe(session, event) {
    if (!lifetime.live || !session || typeof session.id !== 'string' || !session.id
      || !event || !seq(event.seq) || !positive(event.time) || !Object.isFrozen(event)) return
    if (event.type === 'turn/start') {
      if (!positive(event.data?.turn)) return
      remember(session, event)
      turns.set(session, { start: event, sessionId: session.id, associationFault: turns.has(session),
        lastSeq: event.seq, fault: false, assistants: new Map(), calls: new Map() })
      return
    }
    const state = turns.get(session)
    if (!state) return
    if (event.seq !== state.lastSeq + 1) state.fault = true
    state.lastSeq = event.seq
    if (event.type === 'assistant/message') {
      if (event.data?.turn !== state.start.data.turn || !positive(event.data?.step)
        || event.data.interrupted === true || event.data.message?.role !== 'assistant'
        || !Array.isArray(event.data.stream)) { state.fault = true; return }
      remember(session, event)
      for (const call of callsOf(event)) {
        if (state.assistants.size >= 32 || typeof call.id !== 'string' || !call.id
          || state.assistants.has(call.id)) { state.fault = true; return }
        state.assistants.set(call.id, { event, name: call.name })
      }
    } else if (event.type === 'tool/call') {
      const data = event.data, assistant = state.assistants.get(data?.callId)
      if (!['echo_remember', 'echo_memory'].includes(data?.name) || !assistant || assistant.name !== data.name
        || data.turn !== state.start.data.turn || data.step !== assistant.event.data.step
        || !positive(data.step) || assistant.event.seq >= event.seq || state.calls.size >= 32
        || state.calls.has(data.callId)) return
      remember(session, event)
      state.calls.set(data.callId, { event, assistant: assistant.event })
    } else if (event.type === 'turn/end') {
      const start = state.start
      if (!state.fault && !state.associationFault && session.id === state.sessionId
        && event.data?.turn === start.data.turn && event.data?.reason?.kind === 'completed'
        && accepted.get(start)?.stamp === stamp(start)) {
        remember(session, event)
        const makeCompleted = kind => {
          const handle = Object.freeze(Object.create(null))
          const sourceIdentity = kind === 'extract'
            ? digest([PROTOCOL, kind, session.id,
            String(start.seq), String(start.data.turn), String(event.seq), String(event.time),
            String(event.data.reason.kind)])
            : 'host:' + digest([PROTOCOL, kind, session.id,
              String(start.seq), String(start.data.turn), String(event.seq)])
          origins.set(handle, { lifetime, accepted, session, sessionId: session.id, start,
            end: event, endStamp: completionStamp(event), kind, sourceIdentity,
            admissionIdentity: 'admission:' + digest([PROTOCOL, session.id, String(start.seq), String(start.data.turn)]),
            resultAdmissionIdentity: 'extract-admission:' + digest(['extract-admission/v1', sourceIdentity]),
            roundId: 'p3:' + digest([session.id, start.seq, start.data.turn]), occurredAtMs: event.time })
          return handle
        }
        completed.set(event, makeCompleted('association'))
        completedExtract.set(event, makeCompleted('extract'))
      }
      turns.delete(session)
    }
  }
  const unsubscribe = subscribe(observe)
  function captureExtract(session, event) {
    const proof = accepted.get(event)
    if (!lifetime.live || proof?.session !== session || event?.type !== 'turn/start'
      || proof.stamp !== stamp(event)) return null
    return mint('extract', session, event)
  }
  function captureCall(session, exec, name, kind) {
    const state = turns.get(session), proof = state?.calls.get(exec?.callId)
    if (!lifetime.live || !state || state.fault || exec?.agent?.session !== session || !proof
      || proof.event.data.name !== name) return null
    const handle = mint(kind, session, state.start, proof.event, proof.assistant)
    return validateMemoryStrengthOrigin(handle, kind) ? handle : null
  }
  function captureAutoContext(session) {
    const state = turns.get(session)
    if (!lifetime.live || !state || state.fault) return null
    const handle = mint('auto_context', session, state.start)
    return validateMemoryStrengthOrigin(handle, 'auto_context') ? handle : null
  }
  function captureAssociation(session, event) {
    const handle = completed.get(event)
    return origins.get(handle)?.session === session && validateMemoryStrengthOrigin(handle, 'association') ? handle : null
  }
  function captureExtractCompleted(session, event) {
    const handle = completedExtract.get(event)
    return origins.get(handle)?.session === session && validateMemoryStrengthOrigin(handle, 'extract') ? handle : null
  }
  function validate(handle, expectedKind = null) {
    const proof = origins.get(handle)
    if (proof?.kind === 'association' && proof.lifetime !== lifetime) return null
    return validateMemoryStrengthOrigin(handle, expectedKind)
  }
  function dispose() {
    lifetime.live = false
    if (typeof unsubscribe === 'function') unsubscribe()
  }
  return Object.freeze({ captureExtract, captureExtractCompleted, captureAutoContext, captureAssociation,
    captureTeach: (session, exec) => captureCall(session, exec, 'echo_remember', 'teach'),
    captureSearch: (session, exec) => captureCall(session, exec, 'echo_memory', 'search'),
    validate, dispose })
}

export function validateMemoryStrengthOrigin(handle, expectedKind = null) {
  const origin = origins.get(handle)
  if (!origin || !origin.lifetime.live || (expectedKind !== null && origin.kind !== expectedKind)
    || origin.session.id !== origin.sessionId) return null
  for (const event of [origin.start, origin.call, origin.assistant, origin.end].filter(Boolean)) {
    const proof = origin.accepted.get(event)
    if (proof?.session !== origin.session || proof.stamp !== stamp(event)) return null
  }
  if (origin.kind === 'association' && (origin.endStamp !== completionStamp(origin.end)
    || origin.end.data?.reason?.kind !== 'completed')) return null
  return { sourceKind: origin.kind, sourceIdentity: origin.sourceIdentity, occurredAtMs: origin.occurredAtMs,
    ...(['auto_context', 'association'].includes(origin.kind) ? { admissionIdentity: origin.admissionIdentity } : {}),
    ...(origin.kind === 'extract' && origin.end ? {
      resultAdmissionIdentity: origin.resultAdmissionIdentity,
      sessionId: origin.sessionId, startSeq: origin.start.seq, endSeq: origin.end.seq,
      turn: origin.start.data.turn, endReason: origin.end.data.reason.kind
    } : {}),
    ...(origin.kind === 'association' ? { roundId: origin.roundId } : {}) }
}
