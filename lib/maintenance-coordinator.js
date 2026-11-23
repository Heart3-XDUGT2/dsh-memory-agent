const MAX_TIMEOUT_MS = 900000
const OUTCOMES = new Set(['completed', 'failed', 'unknown'])
const REASONS = Object.freeze({
  CLOSED: 'maintenance_closed',
  WINDOW: 'maintenance_window',
  FAILED: 'task_failed',
  UNKNOWN: 'unknown_outcome',
  DUPLICATE: 'token_already_completed',
  INVALID: 'token_invalid',
  TIMEOUT: 'drain_timeout',
  OPEN_BLOCKED: 'open_blocked'
})

const copyStatus = state => ({
  state: state.state,
  generation: state.generation,
  accepting: state.accepting,
  accepted: state.accepted,
  completed: state.completed,
  unresolved: state.unresolved,
  lastReason: state.lastReason
})

/**
 * Host-owned admission coordinator.
 *
 * This is intentionally process-local. It blocks new admissions but does not
 * cancel, ACK, drop, or otherwise mutate work that was accepted before close.
 */
export function createMaintenanceCoordinator () {
  const state = {
    state: 'open',
    generation: 0,
    accepting: true,
    accepted: 0,
    completed: 0,
    unresolved: 0,
    lastReason: null
  }
  const tokens = new WeakMap()
  let drainPromise = null
  let wake = null

  const notify = () => {
    const resolve = wake
    wake = null
    resolve?.()
  }

  // WeakMap is intentionally not iterable. The counter is the authoritative
  // bounded in-flight view and avoids retaining caller-owned token objects.
  let inFlight = 0
  const settled = () => inFlight === 0 && state.unresolved === 0
  const snapshot = () => copyStatus(state)

  const close = () => {
    if (state.accepting) {
      state.accepting = false
      state.generation += 1
      state.lastReason = REASONS.WINDOW
    }
    if (state.state === 'open') state.state = inFlight === 0 ? 'closed' : 'closing'
    return snapshot()
  }

  const open = () => {
    if (!settled()) {
      state.lastReason = REASONS.OPEN_BLOCKED
      return snapshot()
    }
    if (!state.accepting) {
      state.accepting = true
      state.generation += 1
    }
    state.state = 'open'
    state.lastReason = null
    return snapshot()
  }

  const admit = kind => {
    if (!state.accepting) return { accepted: false, reason: REASONS.CLOSED }
    if (typeof kind !== 'string' || kind.trim() === '') return { accepted: false, reason: 'admission_kind_invalid' }
    const token = Object.freeze(Object.create(null))
    tokens.set(token, { state: 'in_flight', kind: kind.trim() })
    inFlight += 1
    state.accepted += 1
    return { accepted: true, token }
  }

  const finish = (token, outcome) => {
    const entry = tokens.get(token)
    if (!entry) {
      state.lastReason = REASONS.INVALID
      return { ok: false, reason: REASONS.INVALID }
    }
    if (entry.state !== 'in_flight') {
      state.lastReason = REASONS.DUPLICATE
      return { ok: false, reason: REASONS.DUPLICATE }
    }
    if (!OUTCOMES.has(outcome)) {
      state.lastReason = 'outcome_invalid'
      return { ok: false, reason: 'outcome_invalid' }
    }
    entry.state = outcome
    inFlight -= 1
    if (outcome === 'unknown') {
      state.unresolved += 1
      state.state = 'unknown'
      state.accepting = false
      state.lastReason = REASONS.UNKNOWN
    } else {
      state.completed += 1
      if (outcome === 'failed') state.lastReason = REASONS.FAILED
      if (!state.accepting && state.state !== 'unknown') state.state = 'closed'
    }
    notify()
    return { ok: true, outcome }
  }

  const resolveUnknown = token => {
    const entry = tokens.get(token)
    if (!entry || entry.state !== 'unknown') {
      state.lastReason = !entry ? REASONS.INVALID : REASONS.DUPLICATE
      return { ok: false, reason: state.lastReason }
    }
    entry.state = 'failed'
    state.unresolved -= 1
    state.completed += 1
    state.lastReason = REASONS.FAILED
    if (!state.accepting) state.state = 'closed'
    notify()
    return { ok: true, outcome: 'failed' }
  }

  const drain = async ({ timeoutMs = 30000 } = {}) => {
    if (drainPromise) return drainPromise
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) {
      close()
      state.lastReason = 'drain_timeout_invalid'
      return { status: 'timed_out', ...snapshot() }
    }
    close()
    drainPromise = (async () => {
      if (settled()) {
        state.state = 'closed'
        state.accepting = false
        return { status: 'drained', ...snapshot() }
      }
      const deadline = Date.now() + timeoutMs
      while (!settled()) {
        if (state.unresolved > 0) {
          state.state = 'unknown'
          state.lastReason = REASONS.UNKNOWN
          return { status: 'unknown', ...snapshot() }
        }
        const remaining = deadline - Date.now()
        if (remaining < 0) {
          state.state = 'timed_out'
          state.lastReason = REASONS.TIMEOUT
          return { status: 'timed_out', ...snapshot() }
        }
        await Promise.race([
          new Promise(resolve => { wake = resolve }),
          new Promise(resolve => setTimeout(resolve, remaining))
        ])
      }
      state.state = 'closed'
      return { status: 'drained', ...snapshot() }
    })()
    try {
      return await drainPromise
    } finally {
      drainPromise = null
    }
  }

  return Object.freeze({
    status: snapshot,
    beginClose: close,
    close,
    open,
    admit,
    finish,
    complete: token => finish(token, 'completed'),
    fail: token => finish(token, 'failed'),
    unknown: token => finish(token, 'unknown'),
    resolveUnknown,
    drain
  })
}
