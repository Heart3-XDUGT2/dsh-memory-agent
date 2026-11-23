import { createHash } from 'node:crypto'
import { ASSOCIATION_USE_STATUS } from './memory-association-use-store.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const textOf = message => typeof message?.content === 'string' ? message.content
  : (Array.isArray(message?.content) ? message.content : []).filter(block => block?.type === 'text').map(block => block.text || '').join('\n')
const validManifest = manifest => manifest?.schema === 'echo-association-use/v1' && manifest.explicit === true
  && Array.isArray(manifest.entries) && manifest.entries.length > 0 && manifest.entries.length <= 4
const validSeq = value => Number.isSafeInteger(value) && value >= 0
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Retrospective, conservative evidence: constructed prompt still visible at a
 * native core response, followed by completed turn. No remote-delivery claim.
 * Production is fail-closed unless a manager explicitly supplies enabled + writer.
 */
export function createAssociationUseTracker({ enabled = false, writeUse = null, onFailure = null, now = Date.now,
  subscribe = null, source = null } = {}) {
  let active = new WeakMap(), care = new WeakMap()
  const on = enabled === true && typeof writeUse === 'function'
  const subscribed = subscribe !== null
  if (on && subscribed && (typeof subscribe !== 'function' || typeof source?.captureAssociation !== 'function'
    || typeof source?.validate !== 'function')) throw Error('association_source_required')
  let live = on
  const no = reason => ({ status: 'ignored', reason })
  function notePrompt(session, { manifest, text, channel = 'normal', messageId = null } = {}) {
    if (!live) return no('disabled')
    const turn = active.get(session)
    if (!turn || turn.fault) return no('no_native_step')
    if (!validManifest(manifest) || typeof text !== 'string' || !text.trim()
      || text.length > 32768 || !['normal', 'care'].includes(channel)
      || (channel === 'care' && typeof messageId !== 'string')) return no('invalid_prompt_evidence')
    if (turn.notes.length >= 64) { turn.fault = true; return no('prompt_capacity') }
    turn.notes.push({ entries: structuredClone(manifest.entries), text: text.trim(), channel,
      step: turn.step, observed: false, messageId })
    return { status: 'staged' }
  }
  function stageCare(session, message, manifest) {
    if (!live) return () => {}
    if (!validManifest(manifest) || typeof message?.id !== 'string' || message.role !== 'user'
      || message.source?.form !== 'care' || textOf(message).length > 32768) return () => {}
    let pending = care.get(session)
    if (!pending) { pending = new Map(); care.set(session, pending) }
    if (pending.size >= 32) return () => {}
    const item = { manifest: structuredClone(manifest), text: textOf(message), messageId: message.id }
    pending.set(message.id, item)
    return () => {
      if (pending.get(message.id) === item) pending.delete(message.id)
      const turn = active.get(session)
      if (turn?.claimedCare.get(message.id) === item) turn.claimedCare.delete(message.id)
    }
  }
  function claimCare(session, message, nativeTurn) {
    if (!live) return no('disabled')
    const turn = active.get(session), pending = care.get(session)
    const item = pending?.get(message?.id)
    if (!item) return no('no_pending_care')
    if (!turn || turn.fault || turn.turn !== nativeTurn || message.role !== 'user'
      || message.source?.form !== 'care' || textOf(message) !== item.text) return no('unproven_care_claim')
    pending.delete(message.id)
    turn.claimedCare.set(message.id, item)
    return { status: 'claimed' }
  }
  function discardCare(session, message) {
    if (!live) return no('disabled')
    if (typeof message?.id !== 'string') return no('invalid_care_discard')
    const pending = care.get(session), turn = active.get(session)
    const item = pending?.get(message.id) || turn?.claimedCare.get(message.id)
    if (!item || message.role !== 'user' || message.source?.form !== 'care'
      || textOf(message) !== item.text) return no('unproven_care_discard')
    pending?.delete(message.id)
    turn?.claimedCare.delete(message.id)
    return { status: 'discarded' }
  }
  function observe(session, event) {
    if (!live) return no('disabled')
    if (subscribed) return no('subscription_required')
    if (!session || typeof session.id !== 'string' || typeof session.eventAt !== 'function'
      || !validSeq(event?.seq) || session.eventAt(event.seq) !== event) return no('unproven_native_event')
    return observeAccepted(session, event)
  }
  function observeAccepted(session, event) {
    if (!live) return no('disabled')
    if (!session || typeof session.id !== 'string' || !validSeq(event?.seq)
      || (subscribed && (!Object.isFrozen(event) || !Number.isSafeInteger(event.time) || event.time < 1))) {
      return no('unproven_native_event')
    }
    if (event.type === 'turn/start') {
      if (!Number.isSafeInteger(event.data?.turn) || event.data.turn < 1) return no('invalid_native_turn')
      const previous = active.get(session)
      active.set(session, { turn: event.data.turn, roundId: 'p3:' + hash([session.id, event.seq, event.data.turn]),
        lastSeq: event.seq, step: null, steps: 0, notes: [], claimedCare: new Map(), fault: !!previous })
      return { status: 'started' }
    }
    const turn = active.get(session)
    if (!turn) return no('no_native_turn')
    if (event.seq !== turn.lastSeq + 1) turn.fault = true
    turn.lastSeq = event.seq
    const data = event.data
    if (event.type === 'step/start') {
      if (data?.turn !== turn.turn || !Number.isSafeInteger(data.step) || data.step !== turn.steps + 1 || turn.step !== null) turn.fault = true
      else {
        turn.step = data.step
        turn.steps = data.step
        // Assembly precedes step/start in the installed host. Bind only after the
        // native step arrives, never by predicting its number during assembly.
        for (const note of turn.notes) if (note.step === null) note.step = data.step
      }
    } else if (event.type === 'user/message') {
      const pending = turn.claimedCare.get(data?.id)
      if (pending) {
        turn.claimedCare.delete(data.id)
        if (data.role === 'user' && data.source?.form === 'care' && textOf(data) === pending.text) notePrompt(session, { ...pending, channel: 'care' })
        else turn.fault = true
      }
    } else if (event.type === 'assistant/message') {
      if (data?.turn !== turn.turn || data.step !== turn.step || data.interrupted === true
        || data.message?.role !== 'assistant' || !Array.isArray(data.stream)
        || typeof data.message.source?.provider !== 'string' || !data.message.source.provider
        || typeof data.message.source?.model !== 'string' || !data.message.source.model) turn.fault = true
      else {
        let visible
        try { visible = session.deriveMessages().filter(message => ['system', 'developer', 'user'].includes(message.role)) } catch { turn.fault = true; return no('surface_unavailable') }
        for (const note of turn.notes) {
          if (note.step === turn.step && visible.some(message => (note.channel === 'care'
            ? message.role === 'user' && message.id === note.messageId
            : ['system', 'developer'].includes(message.role)) && textOf(message).includes(note.text))) note.observed = true
        }
      }
    } else if (event.type === 'step/end') {
      if (turn.step === null || data?.turn !== turn.turn || data.step !== turn.step) turn.fault = true
      turn.step = null
    } else if (event.type === 'turn/end') {
      // Claimed care belongs to this turn even if prepare failed before user/message.
      active.delete(session)
      if (turn.fault || turn.step !== null || data?.turn !== turn.turn || data.reason?.kind !== 'completed') return no('incomplete_or_canceled_turn')
      const notes = turn.notes.filter(note => note.observed)
      if (!notes.length) return no('no_observed_core_prompt')
      const entries = notes.flatMap(note => note.entries)
      if (entries.length > 64) return no('use_capacity')
      const channels = new Set(notes.map(note => note.channel))
      try {
        const channel = channels.size > 1 ? 'mixed' : notes[0].channel
        let useEvent
        if (subscribed) {
          const origin = source.captureAssociation(session, event)
          const proof = source.validate(origin, 'association')
          if (!proof || proof.roundId !== turn.roundId || proof.occurredAtMs !== event.time) return no('unproven_completed_turn')
          useEvent = freeze({ origin, channel, entries: structuredClone(entries) })
        } else useEvent = { status: ASSOCIATION_USE_STATUS, roundId: turn.roundId, channel, usedAtMs: now(), entries }
        const result = writeUse(useEvent)
        if (!result || !['committed', 'duplicate', 'disabled'].includes(result.status)) {
          try { onFailure?.({ reason: result?.reason || 'use_write_failed' }) } catch {}
        }
        return result || { status: 'failed', reason: 'use_writer_no_receipt' }
      } catch {
        try { onFailure?.({ reason: 'use_writer_threw' }) } catch {}
        return { status: 'failed', reason: 'use_writer_threw' }
      }
    }
    return { status: 'observed' }
  }
  const unsubscribe = on && subscribed ? subscribe(observeAccepted) : null
  function dispose() {
    live = false
    active = new WeakMap()
    care = new WeakMap()
    if (typeof unsubscribe === 'function') unsubscribe()
  }
  return { notePrompt, stageCare, claimCare, discardCare, observe, dispose, get enabled() { return live },
    pendingCareCount: session => care.get(session)?.size ?? 0 }
}
