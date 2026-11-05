import { createHash } from 'node:crypto'
import { createQQSendFilesystem, QQSendArtifactError, artifactFailure, filesystemIdentity } from './qq-send-filesystem.js'

const HARD = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024,
  maxCachedBytes: 16 * 1024 * 1024,
  maxEntries: 32,
  maxConcurrentReads: 2,
  maxEvents: 32,
  maxScopes: 32
})
const fail = code => { throw new QQSendArtifactError(code) }
const object = value => value !== null && typeof value === 'object'
const safeFailure = error => artifactFailure(error instanceof QQSendArtifactError ? error.code : 'UNAVAILABLE')
const publicItem = entry => ({ ref: entry.ref, name: entry.name, bytes: entry.size })
const copyResult = value => ({ ...value,
  ...(value.items ? { items: value.items.map(item => ({ ...item })) } : {}),
  ...(value.rejected ? { rejected: value.rejected.map(item => ({ ...item })) } : {})
})

// scopeOf and its opaque grants belong to the trusted native-event integration.
// This module never derives authorization from model paths or session IDs.
export function createQQSendArtifacts ({ scopeOf, limits = {} } = {}) {
  if (typeof scopeOf !== 'function' || !object(limits)) throw new TypeError('Invalid artifact configuration')
  const cap = { ...HARD }
  for (const [name, value] of Object.entries(limits)) {
    if (!(name in HARD) || !Number.isSafeInteger(value) || value < 1 || value > HARD[name]) throw new TypeError('Invalid artifact limit')
    cap[name] = value
  }
  const agents = new WeakMap()
  const grants = new WeakMap()
  const scopes = new Set()
  const jobs = new Set()
  let closed = false
  let closePromise
  let cached = 0
  let reserved = 0
  let entries = 0
  let pendingEntries = 0
  let readers = 0
  let events = 0

  function invalidate (state, code = 'REVOKED') {
    if (state.revoked) return
    state.revoked = true
    state.abort.abort(code)
    for (const entry of state.entries.values()) {
      if (entry.data) cached -= entry.size
      entry.data = null
      entries--
    }
    events -= state.calls.size
    state.entries.clear()
    state.hashes.clear()
    state.calls.clear()
    scopes.delete(state)
  }
  function source (grant) {
    if (!object(grant)) fail('INVALID_GRANT')
    let value
    try { value = scopeOf(grant) } catch { fail('INVALID_GRANT') }
    if (!object(value) || !object(value.agent) || !object(value.session) ||
      value.agent.session !== value.session || !Number.isSafeInteger(value.turn) || value.turn < 0 ||
      !object(value.authority) || typeof value.isCurrent !== 'function') {
      const previous = grants.get(grant)
      if (previous) { invalidate(previous); fail('REVOKED') }
      fail('INVALID_GRANT')
    }
    return value
  }
  function stateOf (grant) {
    if (closed) fail('CLOSED')
    const s = source(grant)
    const bound = grants.get(grant)
    if (bound && (bound.agent !== s.agent || bound.session !== s.session ||
      bound.turn !== s.turn || bound.authority !== s.authority)) fail('STALE_SCOPE')
    let record = agents.get(s.agent)
    if (record && (record.session !== s.session || s.turn < record.turn)) fail('STALE_SCOPE')
    if (record && s.turn === record.turn && record.state.authority !== s.authority) fail('STALE_SCOPE')
    if (record && s.turn > record.turn) invalidate(record.state)
    let current = false
    try { current = s.isCurrent() === true } catch {}
    if (!current) {
      if (record && s.turn === record.turn) invalidate(record.state)
      else {
        // Even a first observation of a revoked native authority is a tombstone;
        // restoring a callback boolean cannot reopen that same turn.
        const state = { agent: s.agent, session: s.session, turn: s.turn, authority: s.authority, revoked: true }
        record = { session: s.session, turn: s.turn, state }
        agents.set(s.agent, record)
        grants.set(grant, state)
      }
      fail('REVOKED')
    }
    if (!record || s.turn > record.turn) {
      if (scopes.size >= cap.maxScopes) fail('CAPACITY')
      const ctx = s.agent.ctx
      let fs, cwd
      try { fs = ctx?.get('fs'); cwd = s.session.header?.cwd } catch { fail('UNSUPPORTED_FILESYSTEM') }
      if (!object(ctx) || typeof cwd !== 'string' || !cwd) fail('UNSUPPORTED_FILESYSTEM')
      const adapter = createQQSendFilesystem(fs, { cwd, relativeRoot: 'echo-outgoing', maxFileBytes: cap.maxFileBytes })
      const state = {
        agent: s.agent, session: s.session, authority: s.authority, turn: s.turn,
        ctx, fs, fsIdentity: filesystemIdentity(fs), cwd, adapter,
        abort: new AbortController(), revoked: false,
        entries: new Map(), hashes: new Map(), calls: new Map()
      }
      record = { session: s.session, turn: s.turn, state }
      agents.set(s.agent, record)
      scopes.add(state)
    }
    const state = record.state
    grants.set(grant, state)
    if (state.revoked) fail('REVOKED')
    let same = false
    try {
      same = s.agent.ctx === state.ctx && s.session.header?.cwd === state.cwd &&
        filesystemIdentity(state.ctx.get('fs')) === state.fsIdentity
    } catch {}
    if (!same) { invalidate(state); fail('REVOKED') }
    return state
  }
  // Caller-visible cancellation can settle early. The task and its resource
  // reservations stay alive until the provider's actual asynchronous work exits.
  function job (state, grant, operation = {}, work) {
    const abort = new AbortController()
    let timer
    const stop = code => { if (!abort.signal.aborted) abort.abort(code) }
    const fromScope = () => stop(state.abort.signal.reason ?? 'REVOKED')
    const fromCaller = () => stop('ABORTED')
    const deadline = Math.min(Date.now() + 60_000, operation.deadlineAt ?? Infinity)
    if (!Number.isFinite(deadline) || (operation.deadlineAt !== undefined && !Number.isSafeInteger(operation.deadlineAt))) return Promise.resolve(artifactFailure('INVALID_PRESENT'))
    state.abort.signal.addEventListener('abort', fromScope, { once: true })
    operation.signal?.addEventListener('abort', fromCaller, { once: true })
    if (state.abort.signal.aborted) fromScope()
    if (operation.signal?.aborted) fromCaller()
    if (Date.now() >= deadline) stop('TIMEOUT')
    else timer = setTimeout(() => stop('TIMEOUT'), deadline - Date.now())
    const check = () => {
      if (abort.signal.aborted) fail(abort.signal.reason)
      if (Date.now() >= deadline) { stop('TIMEOUT'); fail('TIMEOUT') }
      if (stateOf(grant) !== state) fail('STALE_SCOPE')
      if (operation.isCurrent) {
        let current = false
        try { current = operation.isCurrent() === true } catch {}
        if (!current) fail('REVOKED')
      }
      return true
    }
    let onAbort
    const cancelled = new Promise(resolve => {
      onAbort = () => resolve(artifactFailure(abort.signal.reason))
      abort.signal.addEventListener('abort', onAbort, { once: true })
      if (abort.signal.aborted) onAbort()
    })
    let task
    task = Promise.resolve().then(async () => {
      check()
      const result = await work({ signal: abort.signal, check })
      check()
      return result
    }).catch(error => abort.signal.aborted ? artifactFailure(abort.signal.reason) : safeFailure(error)).finally(() => {
      clearTimeout(timer)
      abort.signal.removeEventListener('abort', onAbort)
      state.abort.signal.removeEventListener('abort', fromScope)
      operation.signal?.removeEventListener('abort', fromCaller)
      jobs.delete(task)
    })
    jobs.add(task)
    return Promise.race([task, cancelled])
  }
  async function prepare (grant) {
    try {
      const state = stateOf(grant)
      return await job(state, grant, {}, async options => {
        await state.adapter.workspace(options)
        return { ok: true, relativeRoot: 'echo-outgoing' }
      })
    } catch (error) { return safeFailure(error) }
  }
  async function list (grant) {
    try {
      const state = stateOf(grant)
      return { ok: true, items: [...state.entries.values()].map(publicItem) }
    } catch (error) { return safeFailure(error) }
  }
  async function registerOne (state, value, options) {
    options.check()
    // No unbounded queue: fail promptly while noncompliant reads retain slots.
    if (readers >= cap.maxConcurrentReads) fail('BUSY')
    readers++
    let charge = 0
    let entrySlot = false
    try {
      const descriptor = await state.adapter.inspect(value, options)
      options.check()
      const existing = state.entries.get(descriptor.ref)
      if (existing && existing.size !== descriptor.size) fail('REF_CONFLICT')
      if ((!existing && entries + pendingEntries >= cap.maxEntries) || cached + reserved + descriptor.size > cap.maxCachedBytes) fail('CAPACITY')
      charge = descriptor.size
      reserved += charge
      if (!existing) { pendingEntries++; entrySlot = true }
      const data = await state.adapter.readSnapshot(descriptor, options)
      options.check()
      const hash = createHash('sha256').update(data).digest('hex')
      // No awaits between deduplication and commit. Concurrent presenters cannot
      // create two identities for a ref or the same content.
      const collision = state.entries.get(descriptor.ref)
      if (collision && collision.hash !== hash) fail('REF_CONFLICT')
      const duplicate = collision ?? state.hashes.get(hash)
      if (duplicate) {
        // The latest proved presentation can move the source, but never changes
        // its public ref, identity, cached bytes or already-taken tombstone.
        duplicate.descriptor = descriptor
        return publicItem(duplicate)
      }
      const entry = { ...descriptor, descriptor, hash, identity: Object.freeze({}), data, taken: false }
      state.entries.set(entry.ref, entry)
      state.hashes.set(hash, entry)
      entries++
      cached += entry.size
      return publicItem(entry)
    } finally {
      reserved -= charge
      if (entrySlot) pendingEntries--
      readers--
    }
  }
  async function registerPresented (grant, presentation, operation = {}) {
    try {
      const state = stateOf(grant)
      const callId = presentation?.callId
      const files = presentation?.files
      if (typeof callId !== 'string' || callId.length < 1 || callId.length > 128 || /[\p{Cc}\p{Cf}]/u.test(callId) ||
        !Array.isArray(files) || files.length < 1 || files.length > 32 ||
        files.some(file => !object(file) || typeof file.path !== 'string' || file.path.length > 2048)) fail('INVALID_PRESENT')
      const paths = files.map(file => file.path)
      const fingerprint = JSON.stringify(paths)
      const existing = state.calls.get(callId)
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail('INVALID_PRESENT')
        // Replayed native events never reread files or reset handoff state.
        return await job(state, grant, operation, async () => copyResult(await existing.promise))
      }
      if (events >= cap.maxEvents) fail('CAPACITY')
      events++
      const promise = job(state, grant, operation, async options => {
        const items = []
        const rejected = []
        for (const [index, value] of paths.entries()) {
          options.check()
          try { items.push(await registerOne(state, value, options)) } catch (error) {
            options.check()
            const result = safeFailure(error)
            rejected.push({ index, code: result.code, reason: result.reason })
          }
        }
        if (!items.length) return { ...artifactFailure(rejected[0].code), items, rejected }
        return { ok: true, items, rejected }
      })
      state.calls.set(callId, { fingerprint, promise })
      return copyResult(await promise)
    } catch (error) { return safeFailure(error) }
  }
  async function snapshot (grant, ref, operation = {}) {
    try {
      const state = stateOf(grant)
      if (typeof ref !== 'string' || ref.length > 2048) fail('UNKNOWN_REF')
      let entry = state.entries.get(ref)
      if (!entry && !/[\\/]/u.test(ref)) {
        const matches = [...state.entries.values()].filter(v => v.name === ref)
        if (matches.length > 1) fail('AMBIGUOUS_REF')
        entry = matches[0]
      }
      if (!entry) fail('UNKNOWN_REF')
      return await job(state, grant, operation, async options => {
        if (entry.taken) return { ...artifactFailure('ALREADY_TAKEN'), identity: entry.identity }
        await state.adapter.verify(entry.descriptor, options)
        options.check()
        if (entry.taken) return { ...artifactFailure('ALREADY_TAKEN'), identity: entry.identity }
        if (!entry.data) fail('REVOKED')
        const data = new Uint8Array(entry.data)
        entry.taken = true
        entry.data = null
        cached -= entry.size
        return { ok: true, ...publicItem(entry), data, identity: entry.identity }
      })
    } catch (error) { return safeFailure(error) }
  }
  async function revoke (grant) {
    try {
      const state = stateOf(grant)
      invalidate(state)
      return { ok: true }
    } catch (error) { return safeFailure(error) }
  }
  function close () {
    if (closePromise) return closePromise
    closed = true
    for (const state of scopes) invalidate(state, 'CLOSED')
    closePromise = Promise.allSettled([...jobs]).then(() => {})
    return closePromise
  }
  return { prepare, list, registerPresented, snapshot, revoke, close }
}
