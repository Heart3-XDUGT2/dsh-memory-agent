/**
 * Unassembled stage B. A metadata transaction contract is REQUIRED; no file,
 * config, DB, agent creation, subscriptions or fallback repository.
 */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const KEY_SCHEME = 'eqqc2c-lp32-v2'
const key = v => typeof v === 'string' && v.length > 0 && v.length <= 256
const clone = v => structuredClone(v)
const terminal = new Set(['evicted', 'retry_exhausted', 'canceled', 'worker_failed', 'tracker_rejected', 'target_replaced', 'unknown', 'not_entered'])
const immutable = v => { if (v && typeof v === 'object') { Object.values(v).forEach(immutable); Object.freeze(v) }; return v }
const frozen = (v, depth = 0) => !v || typeof v !== 'object' || (depth < 32 && Object.isFrozen(v) && Object.values(v).every(x => frozen(x, depth + 1)))
const scopeSnapshot = value => {
  if (!value || typeof value !== 'object') throw TypeError('invalid_scope')
  const snapshot = { platform: value.platform, appId: value.appId, ownerHash: value.ownerHash, chatId: value.chatId }
  if (Object.hasOwn(value, 'scopeKey')) snapshot.scopeKey = value.scopeKey
  return immutable(snapshot)
}

/**
 * Store contract official-input-metadata-v1:
 * transaction({scopeKey,inboundKey}, synchronousReducer) serializes inboundKey
 * globally (including cross-scope reuse), executes the reducer once, resolves after
 * committing next. Reducer returns {next,value}; no deletion/retention implied.
 * read(key) is a linearizable metadata read, NOT a fence for an absent record.
 * durability must explicitly be memory-test or durable-metadata.
 *
 * worker.schedule(fn,{delayMs}), wait(target,{signal}) and publish(target,fn,
 * {signal}) are injected. publish must invoke fn at most once while the original
 * target's permission/maintenance boundary is owned; it must not create an Agent.
 */
export function createOfficialInput ({
  scope, generation, getGeneration, codec, metadataStore: store, resolveTarget,
  createMessage, worker, clock, capacity = 32, maxAdmitting = 16,
  maxSources = 256, busyLimit = 30, retryDelayMs = 25,
  makeKey = kind => `${kind}_${randomUUID()}`
}) {
  if (!codec || !['validateScope', 'inputDigest', 'admissionRequestKey'].every(k => typeof codec[k] === 'function') ||
    store?.contract !== 'official-input-metadata-v1' || !['memory-test', 'durable-metadata'].includes(store.durability) ||
    !['transaction', 'read'].every(k => typeof store[k] === 'function') ||
    ![getGeneration, resolveTarget, createMessage, makeKey, worker?.schedule, worker?.wait, worker?.publish, clock?.now, clock?.setTimeout, clock?.clearTimeout].every(f => typeof f === 'function')) throw TypeError('official_input_dependencies_required')
  for (const [v, min, max] of [[capacity, 1, 128], [maxAdmitting, 1, 64], [maxSources, 1, 256], [busyLimit, 0, 100], [retryDelayMs, 0, 60000]]) {
    if (!Number.isSafeInteger(v) || v < min || v > max) throw TypeError('official_input_limits')
  }
  if (!key(String(generation))) throw TypeError('official_input_generation')
  const normalized = codec.validateScope(scopeSnapshot(scope))
  const S = immutable({ platform: normalized.platform, appId: normalized.appId, ownerHash: normalized.ownerHash, chatId: normalized.chatId })
  const scopeKey = normalized.scopeKey
  if (!key(scopeKey)) throw TypeError('official_input_scope')
  const queue = new Map(), admitting = new Map(), known = new Map(), byInput = new Map(), tasks = new Map()
  let active = true, reason = null, epoch = 0, scheduled = false, pumping = false, taskId = 0
  const current = () => { try { return active && getGeneration() === generation } catch { return false } }
  const ref = inboundKey => ({ scopeKey, inboundKey })
  const uncertain = why => ({ ok: false, admissionState: 'unknown', everAccepted: null, duplicate: false, processingState: 'unknown', reason: why, absenceIsFence: false })
  function track (promise, type, sourceKey = null) {
    const id = ++taskId, p = Promise.resolve(promise)
    tasks.set(id, { type, sourceKey })
    p.then(() => tasks.delete(id), () => tasks.delete(id))
    return p
  }
  function halt (why) {
    active = false; reason = why; epoch++
    for (const item of queue.values()) {
      item.canceled = true; item.localState = 'unknown'; item.message = null
      item.controller.abort(); item.signal?.removeEventListener('abort', item.onAbort)
    }
    queue.clear()
  }
  async function tx (inputKey, reducer) {
    try { return await store.transaction(ref(inputKey), reducer) } catch { halt('storage_unavailable'); throw Error('storage_unavailable') }
  }
  function reply (record, duplicate = false) {
    if (!record?.everAccepted || !record.receipt) return { ok: false, admissionState: record?.admissionState ?? 'unknown', everAccepted: record?.everAccepted ?? null,
      duplicate: false, sourceKey: record?.sourceKey ?? null, processingState: record?.processingState ?? 'unknown', absenceIsFence: record?.admissionState === 'not_accepted' }
    const local = byInput.get(record.inboundKey)
    const processingState = local?.localState === 'unknown' || (!local && ['queued_volatile', 'publishing', 'host_enqueued'].includes(record.processingState)) ? 'unknown' : record.processingState
    return { ok: true, admissionState: 'accepted', everAccepted: true, duplicate, sourceKey: record.sourceKey,
      admissionReceiptId: record.receipt.id, receipt: clone(record.receipt), processingState,
      stateVersion: record.stateVersion, metadataDurability: store.durability, bodyDurable: false }
  }
  async function writeState (item, state, observed = false) {
    const r = await tx(item.inboundKey, record => {
      if (!record || record.attemptKey !== item.attemptKey) return { next: record, value: null }
      if (!record.everAccepted) return { next: record, value: record }
      if (terminal.has(record.processingState) && !observed) return { next: record, value: record }
      const next = { ...record, processingState: state, stateVersion: record.stateVersion + 1 }
      return { next, value: next }
    })
    if (r) item.record = r
    return r
  }
  function remove (item) {
    if (queue.get(item.queueItemKey) === item) queue.delete(item.queueItemKey)
    item.signal?.removeEventListener('abort', item.onAbort)
  }
  function retire (item, state) {
    remove(item); item.canceled = true; item.localState = item.publishStarted ? 'unknown' : state; item.message = null
    if (item.record?.everAccepted) track(writeState(item, item.localState).catch(() => {}), 'settlement', item.sourceKey)
  }
  function validTarget (target) {
    return !!target?.agent && target.agent.session === target.session && typeof target.agent.followup === 'function' &&
      ['registerSource', 'sourceStatus'].every(k => typeof target.tracker?.[k] === 'function') && typeof target.isCurrent === 'function'
  }
  function validItem (item) {
    try { return current() && item.epoch === epoch && !item.canceled && !item.signal?.aborted &&
      queue.get(item.queueItemKey) === item && item.record?.everAccepted === true &&
      item.record.attemptKey === item.attemptKey && validTarget(item.target) && item.target.isCurrent() === true } catch { return false }
  }
  function kick (delayMs = 0) {
    if (!current() || scheduled || pumping || ![...queue.values()].some(i => i.ready)) return
    scheduled = true
    try {
      worker.schedule(() => { scheduled = false; if (current()) void pump() }, { delayMs })
    } catch { scheduled = false; halt('scheduler_failed') }
  }
  async function processItem (item) {
    const stopReason = () => current() ? 'target_replaced' : 'canceled'
    if (!validItem(item)) { retire(item, stopReason()); return }
    let result
    try { result = await worker.wait(item.target, { signal: item.controller.signal }) } catch { result = { kind: 'failed' } }
    // The captured item may have been evicted during this await. Never shift a
    // different head, and never invoke a late callback for an evicted item.
    if (queue.get(item.queueItemKey) !== item) return
    if (!validItem(item)) { retire(item, stopReason()); return }
    if (result?.kind === 'busy') {
      item.busyResults++
      if (item.busyResults > busyLimit) retire(item, 'retry_exhausted')
      return
    }
    if (result?.kind !== 'ready') { retire(item, 'worker_failed'); return }
    try {
      await writeState(item, 'publishing')
      if (!validItem(item)) { retire(item, stopReason()); return }
      let callbackCalled = false, refusal = null
      const commit = () => {
        if (callbackCalled) { refusal = 'unknown'; return { ok: false, reason: 'duplicate_publish_callback' } }
        callbackCalled = true
        if (!validItem(item)) { refusal = stopReason(); return { ok: false, reason: refusal } }
        const registration = item.target.tracker.registerSource({ message: item.message, sourceKey: item.sourceKey, inboundKey: item.inboundKey, scopeKey })
        if (registration?.ok !== true) { refusal = 'tracker_rejected'; return { ok: false, reason: refusal } }
        if (!validItem(item)) { refusal = stopReason(); return { ok: false, reason: refusal } }
        item.publishStarted = true // even a throwing followup may have enqueued
        item.target.agent.followup(item.message)
        return { ok: true }
      }
      const published = await worker.publish(item.target, commit, { signal: item.controller.signal })
      if (item.publishStarted) {
        remove(item); item.message = null
        if (published?.kind !== 'published' || refusal) await writeState(item, 'unknown')
        else await writeState(item, 'host_enqueued')
      } else if (queue.get(item.queueItemKey) === item) retire(item, refusal ?? 'worker_failed')
    } catch {
      if (item.publishStarted) {
        remove(item); item.message = null; item.localState = 'unknown'
        if (active) await writeState(item, 'unknown').catch(() => {})
      } else retire(item, current() ? 'worker_failed' : 'unknown')
    }
  }
  function pump () {
    if (pumping || !current()) return Promise.resolve()
    const item = [...queue.values()].find(i => i.ready)
    if (!item) return Promise.resolve()
    pumping = true
    return track((async () => {
      try { await processItem(item) } finally { pumping = false; kick(retryDelayMs) }
    })(), 'worker', item.sourceKey)
  }
  async function fence (item) {
    const record = await tx(item.inboundKey, old => {
      if (!old || old.attemptKey !== item.attemptKey) return { next: old, value: old ?? null }
      if (old.everAccepted) {
        const next = { ...old, processingState: item.publishStarted ? old.processingState : 'canceled', stateVersion: old.stateVersion + 1 }
        return { next, value: next }
      }
      const next = { ...old, admissionState: 'not_accepted', processingState: 'canceled', stateVersion: old.stateVersion + 1 }
      return { next, value: next }
    })
    if (record) item.record = record
    return reply(record)
  }
  async function admit (item, input) {
    const claim = await tx(item.inboundKey, old => {
      if (old) return { next: old, value: { owned: false, record: old } }
      const record = { scopeKey, inboundKey: item.inboundKey, replyAnchorKey: item.replyAnchorKey, inputDigest: item.inputDigest,
        requestKey: item.requestKey, sourceKey: item.sourceKey, attemptKey: item.attemptKey, bindingGeneration: generation,
        admissionState: 'admitting', everAccepted: false, processingState: 'not_started', receipt: null, stateVersion: 1 }
      return { next: record, value: { owned: true, record } }
    })
    const r = claim.record
    if (r.scopeKey !== scopeKey || r.inputDigest !== item.inputDigest || r.replyAnchorKey !== item.replyAnchorKey) return { ...uncertain('conflict'), admissionState: 'not_accepted', conflict: true }
    if (!claim.owned) return reply(r, r.everAccepted === true)
    item.record = r
    known.set(item.sourceKey, item); byInput.set(item.inboundKey, item)
    if (!current() || item.signal?.aborted || item.canceled) return await fence(item)
    const target = await resolveTarget({ scope: S, sourceKey: item.sourceKey, inboundKey: item.inboundKey, signal: item.controller.signal })
    if (!current() || item.signal?.aborted || item.canceled) return await fence(item)
    if (!validTarget(target) || target.isCurrent() !== true) { item.canceled = true; return await fence(item) }
    item.target = target
    const context = immutable({ version: 2, keyScheme: KEY_SCHEME, scopeKey, sourceKey: item.sourceKey, inboundKey: item.inboundKey, replyAnchorKey: item.replyAnchorKey })
    const expected = { role: 'user', content: [{ type: 'text', text: input.text }],
      source: { kind: 'plugin:dsh-echo', form: 'relay', platform: S.platform, chatId: S.chatId,
        chatType: 'private', isMaster: true, rawText: input.text, replyContext: context } }
    const message = createMessage(clone(expected))
    if (!key(message?.id) || !frozen(message) || message.role !== 'user' ||
      !isDeepStrictEqual(message.content, expected.content) || !isDeepStrictEqual(message.source, expected.source)) throw Error('message_construction_failed')
    item.message = message; item.messageId = message.id
    if (queue.size >= capacity) retire(queue.values().next().value, 'evicted')
    queue.set(item.queueItemKey, item) // prepared but NOT consumable
    const receipt = immutable({ id: makeKey('admission'), sourceKey: item.sourceKey, requestKey: item.requestKey, hostMessageId: message.id, acceptedAtMs: clock.now() })
    if (!key(receipt.id) || !Number.isSafeInteger(receipt.acceptedAtMs) || receipt.acceptedAtMs < 0) throw Error('invalid_receipt')
    const accepted = await tx(item.inboundKey, old => {
      if (!old || old.attemptKey !== item.attemptKey) return { next: old, value: old ?? null }
      if (old.admissionState !== 'admitting') return { next: old, value: old }
      if (!current() || item.epoch !== epoch || item.canceled || item.signal?.aborted || queue.get(item.queueItemKey) !== item) {
        const next = { ...old, admissionState: 'not_accepted', processingState: item.localState ?? 'canceled', stateVersion: old.stateVersion + 1 }
        return { next, value: next }
      }
      const next = { ...old, admissionState: 'accepted', everAccepted: true, processingState: 'queued_volatile',
        hostMessageId: message.id, queueItemKey: item.queueItemKey, receipt, stateVersion: old.stateVersion + 1 }
      return { next, value: next }
    })
    item.record = accepted
    if (!accepted?.everAccepted) { remove(item); item.message = null; return reply(accepted) }
    if (!validItem(item)) {
      await writeState(item, item.localState ?? 'canceled')
      remove(item); item.message = null
    } else { item.ready = true; kick() }
    return reply(item.record)
  }
  function inject (input, { signal } = {}) {
    if (!current()) return Promise.resolve(uncertain(active ? 'binding_changed' : reason ?? 'revoked'))
    let digest, requestKey
    try {
      if (!input || typeof input !== 'object') return Promise.resolve(uncertain('invalid_input'))
      const snapshot = { text: input.text, inboundKey: input.inboundKey, replyAnchorKey: input.replyAnchorKey }
      const callerScope = input.scope
      if (callerScope !== undefined) snapshot.scope = scopeSnapshot(callerScope)
      input = immutable(snapshot) // all later digest/queue/message work uses this one snapshot
      if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 32768) return Promise.resolve(uncertain('invalid_input'))
      if (input.scope && codec.validateScope(input.scope).scopeKey !== scopeKey) return Promise.resolve(uncertain('scope_conflict'))
      digest = codec.inputDigest({ scopeKey, inboundKey: input.inboundKey, replyAnchorKey: input.replyAnchorKey, text: input.text })
      requestKey = codec.admissionRequestKey({ scopeKey, inboundKey: input.inboundKey, inputDigest: digest })
    } catch { return Promise.resolve(uncertain('invalid_identity')) }
    const pending = admitting.get(input.inboundKey)
    if (pending) return Promise.resolve(pending.inputDigest === digest && pending.replyAnchorKey === input.replyAnchorKey ?
      { ...uncertain('admitting'), admissionState: 'admitting', sourceKey: pending.sourceKey, everAccepted: pending.record?.everAccepted ?? null } : { ...uncertain('conflict'), conflict: true })
    if (admitting.size >= maxAdmitting || (known.size >= maxSources && !byInput.has(input.inboundKey))) return Promise.resolve(uncertain('capacity'))
    const item = { inboundKey: input.inboundKey, replyAnchorKey: input.replyAnchorKey, inputDigest: digest, requestKey,
      sourceKey: makeKey('source'), attemptKey: makeKey('attempt'), queueItemKey: makeKey('queue'), epoch, signal,
      controller: new AbortController(), ready: false, canceled: false, publishStarted: false, busyResults: 0, record: null, message: null }
    if (![item.sourceKey, item.attemptKey, item.queueItemKey].every(key)) return Promise.resolve(uncertain('invalid_key_factory'))
    admitting.set(item.inboundKey, item)
    const abort = () => {
      item.canceled = true; item.controller.abort()
      if (!item.publishStarted) { remove(item); item.message = null }
      if (item.record) track(fence(item).catch(() => {}), 'abort_fence', item.sourceKey)
    }
    item.onAbort = abort
    signal?.addEventListener('abort', abort, { once: true })
    return track((async () => {
      try { return await admit(item, input) } catch (error) {
        if (error?.message === 'storage_unavailable') { retire(item, 'unknown'); return uncertain('storage_unavailable') }
        try { item.canceled = true; remove(item); item.message = null; return await fence(item) } catch { return uncertain('storage_unavailable') }
      } finally {
        admitting.delete(item.inboundKey)
        // Keep Abort effective while the accepted item is still waiting.
        if (!queue.has(item.queueItemKey)) signal?.removeEventListener('abort', abort)
      }
    })(), 'admission', item.sourceKey)
  }
  async function sourceStatus ({ inboundKey }) {
    return track((async () => {
      try {
        const record = await store.read(ref(inboundKey))
        if (record && record.scopeKey !== scopeKey) return uncertain('scope_conflict')
        return record ? { queryState: 'found', ...reply(record, record.everAccepted === true), record: clone(record) } :
          { ...uncertain('not_found'), queryState: 'unknown', found: false }
      } catch { halt('storage_unavailable'); return uncertain('storage_unavailable') }
    })(), 'query')
  }
  function refresh (sourceKey) {
    const item = known.get(sourceKey)
    if (!item?.publishStarted) return Promise.resolve(uncertain('not_published'))
    const observation = item.target.tracker.sourceStatus(sourceKey)
    if (!['claimed', 'entered', 'turn_closed', 'not_entered'].includes(observation?.state)) return Promise.resolve(uncertain('unobserved'))
    if (observation.sourceKey !== sourceKey || observation.messageId !== item.messageId ||
      observation.scopeKey !== scopeKey || observation.inboundKey !== item.inboundKey ||
      !key(observation.claimedUid) || (['entered', 'turn_closed'].includes(observation.state) && !key(observation.enteredUid))) return Promise.resolve(uncertain('tracker_identity_conflict'))
    return track(writeState(item, observation.state, true).then(record => {
      if (record) item.localState = null
      return { ...reply(record), observation: clone(observation) }
    }).catch(() => uncertain('storage_unavailable')), 'tracker_observation', sourceKey)
  }
  function revoke () {
    if (!active) return { revoked: true }
    active = false; reason = 'revoked'; epoch++
    for (const item of new Set([...queue.values(), ...admitting.values()])) {
      item.canceled = true; item.controller.abort()
      if (!item.publishStarted) retire(item, 'canceled')
      if (item.record) track(fence(item).catch(() => {}), 'revoke_fence', item.sourceKey)
    }
    return { revoked: true }
  }
  function status () {
    return { active: current(), reason, scheduled, queued: [...queue.keys()], pendingTasks: [...tasks.values()].map(clone),
      sources: [...known.values()].map(i => ({ sourceKey: i.sourceKey, queueItemKey: i.queueItemKey, busyResults: i.busyResults, localState: i.localState ?? null, record: clone(i.record) })) }
  }
  async function drain ({ timeoutMs = 0 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) throw TypeError('invalid_drain_timeout')
    const end = clock.now() + timeoutMs
    while (tasks.size && clock.now() < end) {
      await new Promise(resolve => clock.setTimeout(resolve, Math.min(5, end - clock.now())))
    }
    const snapshot = status()
    return { drained: tasks.size === 0 && queue.size === 0 && !scheduled, revoked: !active, scheduled,
      queued: snapshot.queued, pendingTasks: snapshot.pendingTasks,
      unresolvedSources: snapshot.sources.filter(i => i.localState === 'unknown' || ['unknown', 'publishing'].includes(i.record?.processingState) || i.record?.admissionState === 'admitting').map(i => i.sourceKey),
      hostWorkMayContinue: snapshot.sources.some(i => ['host_enqueued', 'claimed', 'entered'].includes(i.record?.processingState)), sharedStoreClosed: false }
  }
  return Object.freeze({ inject, sourceStatus, refresh, pump, revoke, drain, status, scope: S, scopeKey })
}
