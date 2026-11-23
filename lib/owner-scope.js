import { createHash } from 'node:crypto'

const OWNER_SCOPE_CHALLENGE = Symbol('echo.owner-scope.challenge')
const MAX_FIELD = 256
const MAX_TURN = 128
const MAX_ATTEMPT = 128
const REASONS = new Set([
  'no_verified_owner_binding',
  'challenge_mismatch',
  'scope_invalid',
  'scope_drift'
])

const text = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD
  ? value : null
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex')
const summary = (status, ownerHash, sessionHash, binding, reason) => Object.freeze({
  status, ownerHash, sessionHash, binding, reason
})
const unverified = (reason, binding = 'unavailable') =>
  summary('unverified', null, null, binding, REASONS.has(reason) ? reason : 'scope_invalid')

function readScope (provider, turn, attempt) {
  if (typeof provider !== 'function') return unverified('no_verified_owner_binding')
  let value
  try { value = provider(OWNER_SCOPE_CHALLENGE) } catch { return unverified('scope_invalid') }
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)
    || value.challenge !== OWNER_SCOPE_CHALLENGE) return unverified('challenge_mismatch')
  if (!Object.isFrozen(value.scope) || value.scope === null) return unverified('scope_invalid')
  const owner = text(value.scope.owner)
  const session = text(value.scope.session)
  const sourceTurn = text(value.scope.turn)
  const sourceAttempt = text(value.scope.attempt)
  if (!owner || !session || !sourceTurn || !sourceAttempt
    || sourceTurn.length > MAX_TURN || sourceAttempt.length > MAX_ATTEMPT
    || sourceTurn !== turn || sourceAttempt !== attempt) return unverified('scope_invalid')
  return summary('verified', hash(owner), hash(session), 'captured', null)
}

/** Create a pure in-memory verifier for one trusted host scope callback. */
export function createOwnerScopeVerifier (provider) {
  const seen = new Map()
  return Object.freeze({
    observe ({ turn = '', attempt = '' } = {}) {
      const validTurn = text(turn) && turn.length <= MAX_TURN
      const validAttempt = text(attempt) && attempt.length <= MAX_ATTEMPT
      if (!validTurn || !validAttempt) return unverified('no_verified_owner_binding')
      const binding = hash(`${turn}\u0000${attempt}`)
      const current = readScope(provider, turn, attempt)
      if (current.status !== 'verified') return current
      const prior = seen.get(binding)
      if (prior && (prior.ownerHash !== current.ownerHash || prior.sessionHash !== current.sessionHash)) {
        return unverified('scope_drift', 'captured')
      }
      seen.set(binding, current)
      return current
    },
    clear () { seen.clear() }
  })
}

/** Pure one-shot helper for callers that do not need drift tracking. */
export function observeOwnerScope (provider, { turn = '', attempt = '' } = {}) {
  return createOwnerScopeVerifier(provider).observe({ turn, attempt })
}
