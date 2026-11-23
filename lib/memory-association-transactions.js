import { createHash } from 'node:crypto'
import { validateMemoryStrengthOrigin } from './memory-strength-origin.js'
import { applyMemoryStrengthEvents, inspectMemoryStrengthPrepared, MEMORY_STRENGTH_PROTOCOL, MEMORY_STRENGTH_LIMITS } from './memory-strength-events.js'
import { inspectMemoryBodyPrepared } from './memory-body-transactions.js'
import { createAssociationUseStore, normalizeAssociationUseEvent } from './memory-association-use-store.js'
import { assertAssociationUseSchema } from './memory-association-use-schema.js'
import { validTrafficCount, validTrafficModel } from './memory-traffic-dynamics.js'

export const MEMORY_ASSOCIATION_PROTOCOL = 'echo-memory-association/v1'
export const MEMORY_ASSOCIATION_LIMITS = Object.freeze({ receipts: 1024, requestBytes: 65536, resultBytes: 65536,
  entries: 64, memories: 64, units: 576, batchSize: MEMORY_STRENGTH_LIMITS.batch })
export const MEMORY_ASSOCIATION_COLUMNS = Object.freeze([
  ['round_id', 'TEXT', 1, 0], ['protocol', 'TEXT', 0, 1], ['epoch', 'TEXT', 0, 1],
  ['request_hash', 'TEXT', 0, 1], ['result_json', 'TEXT', 0, 1], ['result_hash', 'TEXT', 0, 1]
])
const TABLE = 'memory_association_strength_receipts'
const DDL = 'round_id TEXT PRIMARY KEY,protocol TEXT NOT NULL,epoch TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,result_hash TEXT NOT NULL'
const RESULT_KEYS = ['memoryCount', 'unitCount', 'episodeAppliedCount', 'episodeSkippedCount']
const text = value => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= MEMORY_STRENGTH_LIMITS.idBytes
  && !/[\u0000-\u0020\u007f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u.test(value)
  && ![...value].some(char => char.length === 1 && /[\ud800-\udfff]/u.test(char))
const integer = value => Number.isSafeInteger(value) && value >= 0
const digest = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
const digestBytes = value => createHash('sha256').update(value, 'utf8').digest('hex')
const quote = value => '"' + value.replace(/"/gu, '""') + '"'
const fail = reason => { throw Error(reason) }
const exact = (value, keys, reason = 'association_invalid_input') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) fail(reason)
}
const jsonBytes = value => {
  let raw
  try { raw = JSON.stringify(value) } catch { fail('association_invalid_input') }
  if (typeof raw !== 'string') fail('association_invalid_input')
  return Buffer.byteLength(raw, 'utf8')
}
const stableEntries = event => normalizeAssociationUseEvent({
  status: 'prompt_constructed_core_response_observed_turn_completed',
  roundId: event.roundId, channel: event.channel, usedAtMs: event.occurredAtMs, entries: event.entries
})
const unitsOf = entries => {
  const units = new Set()
  for (const entry of entries) {
    units.add('memory:' + entry.memoryId)
    for (const node of entry.nodeIds) units.add('traffic-node:' + node)
    for (const link of entry.linkIds) units.add('traffic-link:' + link)
    units.add('traffic-path:' + digest([entry.nodeIds, entry.linkIds]))
  }
  return units.size
}
export function memoryAssociationStrengthBatches(memoryIds) {
  if (!Array.isArray(memoryIds) || memoryIds.length > MEMORY_ASSOCIATION_LIMITS.memories) fail('association_input_budget')
  const sorted = [...memoryIds].sort((a, b) => Number(a) - Number(b))
  return Array.from({ length: Math.ceil(sorted.length / MEMORY_ASSOCIATION_LIMITS.batchSize) }, (_, index) =>
    sorted.slice(index * MEMORY_ASSOCIATION_LIMITS.batchSize, (index + 1) * MEMORY_ASSOCIATION_LIMITS.batchSize))
}
const unitKeysOf = entries => {
  const units = new Map()
  const add = (kind, key) => units.set(kind + ':' + key, [kind, key])
  for (const entry of entries) {
    add('memory', entry.memoryId)
    for (const node of entry.nodeIds) add('traffic-node', node)
    for (const link of entry.linkIds) add('traffic-link', link)
    add('traffic-path', digest([entry.nodeIds, entry.linkIds]))
  }
  return [...units.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, unit]) => unit)
}
const resultObject = value => {
  exact(value, RESULT_KEYS, 'association_receipt_invalid')
  if (RESULT_KEYS.some(key => !integer(value[key]))
    || value.episodeAppliedCount + value.episodeSkippedCount !== value.memoryCount
    || value.memoryCount > MEMORY_ASSOCIATION_LIMITS.memories
    || value.unitCount > MEMORY_ASSOCIATION_LIMITS.units) fail('association_receipt_invalid')
  return value
}

function inspectReceiptSchema(db) {
  try {
    const actual = db.prepare(`PRAGMA table_xinfo(${quote(TABLE)})`).all()
    if (actual.length !== MEMORY_ASSOCIATION_COLUMNS.length || actual.some((row, index) => {
      const [name, type, pk, notnull] = MEMORY_ASSOCIATION_COLUMNS[index]
      return row.hidden !== 0 || row.name !== name || row.type.toUpperCase() !== type
        || row.pk !== pk || row.notnull !== notnull || row.dflt_value !== null
    })) return { status: 'incompatible', reason: 'association_schema_incompatible' }
    for (const [column] of MEMORY_ASSOCIATION_COLUMNS) {
      const comparisons = db.prepare(`EXPLAIN SELECT ${quote(column)}=? FROM ${quote(TABLE)} LIMIT 1`)
        .all('association-probe').filter(row => row.opcode === 'Eq')
      if (comparisons.length !== 1 || comparisons[0].p4 !== 'BINARY-8') {
        return { status: 'incompatible', reason: 'association_schema_incompatible' }
      }
    }
    const primary = db.prepare(`PRAGMA index_list(${quote(TABLE)})`).all().filter(row => row.origin === 'pk' && row.partial === 0)
    if (!primary.some(index => {
      const columns = db.prepare(`PRAGMA index_xinfo(${quote(index.name)})`).all().filter(row => row.key === 1)
      return columns.length === 1 && columns[0].name === 'round_id' && columns[0].coll?.toUpperCase() === 'BINARY'
    })) return { status: 'incompatible', reason: 'association_schema_incompatible' }
    return { status: 'ready', reason: null }
  } catch { return { status: 'unavailable', reason: 'association_schema_unavailable' } }
}

function inspectDependencies(db, epoch, { strict = false } = {}) {
  const strength = inspectMemoryStrengthPrepared(db, { strict })
  if (strength.status !== 'ready') return { status: 'unavailable', reason: strength.reason || 'strength_schema_unprepared' }
  if (strength.epoch !== epoch) return { status: 'incompatible', reason: 'strength_epoch_mismatch' }
  if (strict) {
    const body = inspectMemoryBodyPrepared(db, { strict })
    if (body.status !== 'ready') return { status: body.status, reason: body.reason || 'body_schema_unprepared' }
  }
  try { assertAssociationUseSchema(db, { trafficDynamics: true, strict: true }) } catch {
    return { status: 'unavailable', reason: 'traffic_schema_unprepared' }
  }
  return inspectReceiptSchema(db)
}

export function inspectMemoryAssociationSchema(db, { epoch } = {}) {
  if (!text(epoch)) return { status: 'incompatible', reason: 'association_epoch_invalid' }
  return inspectDependencies(db, epoch)
}

/** Explicit schema preparation; S1 and P3 must already be prepared at the same boundary. */
export function prepareMemoryAssociationSchema(db, { epoch } = {}) {
  if (!text(epoch)) fail('association_epoch_invalid')
  if (!db?.exec || !db?.prepare) fail('association_db_required')
  if (db.isTransaction) fail('association_transaction_already_open')
  const strength = inspectMemoryStrengthPrepared(db)
  if (strength.status !== 'ready') fail(strength.reason || 'strength_schema_unprepared')
  if (strength.epoch !== epoch) fail('strength_epoch_mismatch')
  try { assertAssociationUseSchema(db, { trafficDynamics: true, strict: true }) } catch { fail('traffic_schema_unprepared') }
  let transaction = false
  try {
    db.exec('BEGIN IMMEDIATE'); transaction = true
    const object = db.prepare('SELECT type FROM sqlite_master WHERE name=?').get(TABLE)
    if (!object) db.exec(`CREATE TABLE ${quote(TABLE)} (${DDL})`)
    else if (object.type !== 'table') fail('association_schema_incompatible')
    const prepared = inspectReceiptSchema(db)
    if (prepared.status !== 'ready') fail(prepared.reason)
    db.exec('COMMIT'); transaction = false
    return { status: 'ready', epoch, reason: null }
  } catch (error) {
    if (transaction) { try { db.exec('ROLLBACK') } catch { fail('association_rollback_failed') } }
    if (error instanceof Error && /^association_[a-z_]+$|^strength_[a-z_]+$|^traffic_schema_unprepared$/u.test(error.message)) throw error
    fail(error?.errcode === 5 ? 'association_write_busy' : 'association_prepare_failed')
  }
}

function normalizeRequest(proof, epoch, channel, entries) {
  if (proof?.sourceKind !== 'association' || !text(proof.sourceIdentity) || !text(proof.admissionIdentity)
    || !text(proof.roundId) || !Number.isSafeInteger(proof.occurredAtMs) || proof.occurredAtMs < 0) {
    fail('association_source_invalid')
  }
  const source = { protocol: MEMORY_ASSOCIATION_PROTOCOL, epoch, roundId: proof.roundId,
    sourceIdentity: proof.sourceIdentity, admissionIdentity: proof.admissionIdentity,
    occurredAtMs: proof.occurredAtMs, channel, entries }
  const normalized = stableEntries(source)
  const memoryIds = new Set(normalized.entries.map(entry => entry.memoryId))
  const unitCount = unitsOf(normalized.entries)
  if (normalized.entries.length > MEMORY_ASSOCIATION_LIMITS.entries
    || memoryIds.size > MEMORY_ASSOCIATION_LIMITS.memories || unitCount > MEMORY_ASSOCIATION_LIMITS.units) {
    fail('association_input_budget')
  }
  const request = { protocol: MEMORY_ASSOCIATION_PROTOCOL, epoch, roundId: normalized.roundId,
    sourceIdentity: proof.sourceIdentity, admissionIdentity: proof.admissionIdentity,
    occurredAtMs: proof.occurredAtMs, channel: normalized.channel, entries: normalized.entries }
  const requestHash = digest([request.protocol, request.epoch, request.roundId, request.sourceIdentity,
    request.admissionIdentity, String(request.occurredAtMs), request.channel, request.entries])
  const p3Hash = digest(normalized)
  if (jsonBytes(request) > MEMORY_ASSOCIATION_LIMITS.requestBytes) fail('association_input_budget')
  return { request, requestHash, p3Hash, memoryCount: memoryIds.size, unitCount }
}

function checkedP3Anchor(db, normalized, usedAtMs, p3Hash, result) {
  const p3 = db.prepare(`SELECT payload_hash,evidence_status,channel,used_at_ms,memory_count,unit_count
    FROM memory_association_use_receipts WHERE round_id=?`).get(normalized.roundId)
  if (!p3 || p3.payload_hash !== p3Hash) fail('association_p3_payload_invalid')
  if (p3.evidence_status !== 'prompt_constructed_core_response_observed_turn_completed'
    || p3.channel !== normalized.channel || p3.used_at_ms !== usedAtMs
    || p3.memory_count !== result.memoryCount || p3.unit_count !== result.unitCount) fail('association_p3_receipt_invalid')
  const events = db.prepare(`SELECT unit_kind,unit_id FROM memory_association_use_events WHERE round_id=? LIMIT ?`)
    .all(normalized.roundId, MEMORY_ASSOCIATION_LIMITS.units + 1)
  const expected = unitKeysOf(normalized.entries)
  const actualMap = new Map(events.map(row => [row.unit_kind + ':' + row.unit_id, [row.unit_kind, row.unit_id]]))
  const actual = [...actualMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, unit]) => unit)
  if (events.length !== result.unitCount || JSON.stringify(actual) !== JSON.stringify(expected)) fail('association_p3_units_invalid')
  const readState = db.prepare(`SELECT use_count,last_used_ms,half_life_hours
    FROM memory_association_use_state WHERE unit_kind=? AND unit_id=?`)
  const readModel = db.prepare(`SELECT intrinsic_value,weight,model_started_ms,initialization
    FROM memory_association_traffic_strength WHERE link_id=?`)
  for (const [kind, key] of expected) {
    const state = readState.get(kind, key)
    if (!validTrafficCount(state) || state.last_used_ms < usedAtMs) fail('association_p3_state_invalid')
    if (kind === 'traffic-link' && !validTrafficModel(state, readModel.get(key))) fail('association_p3_traffic_invalid')
  }
}

function checkStoredResult(raw, hash) {
  if (typeof raw !== 'string' || typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)
    || Buffer.byteLength(raw, 'utf8') > MEMORY_ASSOCIATION_LIMITS.resultBytes || digestBytes(raw) !== hash) {
    fail('association_receipt_invalid')
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch { fail('association_receipt_invalid') }
  const result = resultObject(parsed)
  if (JSON.stringify(result) !== raw) fail('association_receipt_invalid')
  return result
}

/** Synchronous, caller-owned atomic Episode/S1 + P3 + Traffic coordinator. */
export function createMemoryAssociationTransactions({ db, enabled = false, epoch, generation = null,
  requiredEntries = null, authorityOf = null, nowMs = Date.now,
  onFailure = null, onConnectionWarning = null } = {}) {
  if (enabled !== true) return { record: () => ({ status: 'disabled', accepted: false }) }
  if (!db?.exec || !db?.prepare || typeof nowMs !== 'function') fail('association_dependencies_invalid')
  if (!text(epoch)) fail('association_epoch_invalid')
  const readiness = inspectDependencies(db, epoch)
  if (readiness.status !== 'ready') fail(readiness.reason)
  const p3 = createAssociationUseStore({ db, enabled: true, trafficDynamics: true, preparedOnly: true })
  let writing = false, frozen = false
  const notify = (callback, value) => { try { callback?.(value) } catch {} }
  const failure = reason => ({ status: 'failed', accepted: false, reason,
    failureAudit: 'not_attempted' })
  function record(input) {
    if (frozen) return failure('association_writer_frozen')
    if (writing || db.isTransaction) return failure(writing ? 'reentrant_write' : 'association_transaction_already_open')
    let request, requestHash, p3Hash, memoryCount, unitCount
    try {
      exact(input, ['origin', 'channel', 'entries'])
      const proof = validateMemoryStrengthOrigin(input.origin, 'association')
      if (!proof) fail('association_source_invalid')
      ;({ request, requestHash, p3Hash, memoryCount, unitCount } = normalizeRequest(proof, epoch, input.channel, input.entries))
    } catch (error) {
      const reason = /^association_[a-z_]+$/u.test(error?.message || '') ? error.message : 'association_invalid_input'
      writing = true
      try { notify(onFailure, { reason, failureAudit: 'not_attempted' }) } finally { writing = false }
      return failure(reason)
    }
    writing = true
    let previousTimeout, transaction = false, outcome = null, warning = null, failureReason = null
    try {
      previousTimeout = db.prepare('PRAGMA busy_timeout').get().timeout
      if (!Number.isSafeInteger(previousTimeout) || previousTimeout < 0 || previousTimeout > 2147483647) fail('busy_policy_failed')
      db.exec('PRAGMA busy_timeout=0')
      db.exec('BEGIN IMMEDIATE'); transaction = true
      if (typeof authorityOf === 'function') {
        const authority = authorityOf(db)
        if (authority?.status !== 'active'
          || authority.protocol !== 'echo-memory-authority/v1'
          || authority.epoch !== epoch
          || (generation !== null && authority.generation !== generation)
          || (requiredEntries !== null && JSON.stringify(authority.entries) !== JSON.stringify(requiredEntries))) {
          fail('association_authority_changed')
        }
      }
      const ready = inspectDependencies(db, epoch, { strict: Array.isArray(requiredEntries) })
      if (ready.status !== 'ready') fail(ready.reason)
      const prior = db.prepare(`SELECT protocol,epoch,request_hash,result_json,result_hash
        FROM ${quote(TABLE)} WHERE round_id=?`).get(request.roundId)
      if (prior) {
        if (prior.protocol !== MEMORY_ASSOCIATION_PROTOCOL || prior.epoch !== epoch) fail('association_epoch_conflict')
        if (prior.request_hash !== requestHash) fail('association_payload_conflict')
        const result = checkStoredResult(prior.result_json, prior.result_hash)
        if (result.memoryCount !== memoryCount || result.unitCount !== unitCount) fail('association_receipt_invalid')
        const normalizedP3 = stableEntries({ roundId: request.roundId, channel: request.channel,
          occurredAtMs: request.occurredAtMs, entries: request.entries })
        checkedP3Anchor(db, normalizedP3, request.occurredAtMs, p3Hash, result)
        db.exec('ROLLBACK'); transaction = false
        outcome = { status: 'duplicate', accepted: true, ...result }
      } else {
        const p3Event = { status: 'prompt_constructed_core_response_observed_turn_completed',
          roundId: request.roundId, channel: request.channel, usedAtMs: request.occurredAtMs, entries: request.entries }
        const p3Prepared = p3.prepareInTransaction(p3Event, { memoryAuthority: 'episode' })
        if (p3Prepared.status === 'duplicate') {
          const priorP3 = p3Prepared.prior
          if (priorP3.payload_hash !== p3Hash || priorP3.evidence_status !== 'prompt_constructed_core_response_observed_turn_completed'
            || priorP3.channel !== request.channel || priorP3.used_at_ms !== request.occurredAtMs
            || priorP3.memory_count !== memoryCount || priorP3.unit_count !== unitCount) fail('association_receipt_invalid')
          fail('association_legacy_round_unreceipted')
        }
        if (p3Prepared.status === 'conflict') fail('round_payload_conflict')
        const actualNow = nowMs()
        if (!Number.isSafeInteger(actualNow) || actualNow < 0 || request.occurredAtMs > actualNow) fail('association_clock_invalid')
        const memoryIds = [...new Set(request.entries.map(entry => entry.memoryId))]
        let episodeAppliedCount = 0, episodeSkippedCount = 0
        for (const batchIds of memoryAssociationStrengthBatches(memoryIds)) {
          const batch = batchIds.map(memoryId => ({
            kind: 'association', sourceIdentity: request.sourceIdentity, memoryId,
            occurredAtMs: request.occurredAtMs, admissionIdentity: request.admissionIdentity
          }))
          const applied = applyMemoryStrengthEvents(db, { protocol: MEMORY_STRENGTH_PROTOCOL, epoch,
            nowMs: actualNow, events: batch })
          if (applied.outcomes.length !== batch.length) fail('association_strength_result_invalid')
          episodeAppliedCount += applied.appliedCount
          episodeSkippedCount += applied.skippedCount + applied.duplicateCount
        }
        if (episodeAppliedCount + episodeSkippedCount !== memoryCount) fail('association_strength_result_invalid')
        const p3Result = p3.applyInTransaction(p3Event, { memoryAuthority: 'episode', prepared: p3Prepared })
        if (p3Result.status !== 'committed' || p3Result.payloadHash !== p3Hash
          || p3Result.memoryCount !== memoryCount || p3Result.unitCount !== unitCount) fail('association_p3_result_invalid')
        const result = resultObject({ memoryCount, unitCount, episodeAppliedCount, episodeSkippedCount })
        const resultJson = JSON.stringify(result)
        if (Buffer.byteLength(resultJson, 'utf8') > MEMORY_ASSOCIATION_LIMITS.resultBytes) fail('association_result_budget')
        const count = db.prepare(`SELECT COUNT(*) n FROM (SELECT round_id FROM ${quote(TABLE)} LIMIT ?)`)
          .get(MEMORY_ASSOCIATION_LIMITS.receipts + 1).n
        if (count >= MEMORY_ASSOCIATION_LIMITS.receipts) fail('association_receipt_capacity')
        db.prepare(`INSERT INTO ${quote(TABLE)} VALUES (?,?,?,?,?,?)`)
          .run(request.roundId, MEMORY_ASSOCIATION_PROTOCOL, epoch, requestHash, resultJson, digestBytes(resultJson))
        db.exec('COMMIT'); transaction = false
        outcome = { status: 'committed', accepted: true, ...result }
      }
    } catch (error) {
      if (transaction) { try { db.exec('ROLLBACK') } catch { failureReason = 'association_rollback_failed' } }
      if (!failureReason) {
        const known = new Set(['association_epoch_conflict', 'association_payload_conflict', 'association_receipt_invalid',
          'association_p3_receipt_invalid', 'association_p3_payload_invalid', 'association_p3_units_invalid',
          'association_p3_state_invalid', 'association_p3_traffic_invalid', 'association_authority_changed',
          'association_legacy_round_unreceipted', 'round_payload_conflict', 'memory_not_active', 'traffic_not_active',
          'attachment_missing', 'traffic_path_changed', 'invalid_traffic_state', 'traffic_policy_required',
          'strength_epoch_mismatch', 'strength_invalid_input', 'strength_input_budget', 'strength_memory_missing',
          'strength_memory_ineligible', 'strength_clock_invalid', 'strength_state_invalid', 'strength_receipt_capacity',
          'strength_admission_invalid', 'strength_receipt_invalid', 'strength_payload_conflict', 'strength_transaction_required',
          'association_clock_invalid', 'association_strength_result_invalid', 'association_p3_result_invalid',
          'association_receipt_capacity', 'association_result_budget', 'association_input_budget', 'invalid_use_event',
          'association_schema_incompatible', 'association_schema_unavailable', 'strength_schema_unprepared',
          'strength_epoch_mismatch', 'traffic_schema_unprepared', 'association_source_invalid', 'ineligible_evidence'])
        const message = String(error?.message || '')
        failureReason = known.has(message) ? message : error?.errcode === 5 ? 'write_busy' : 'association_write_failed'
      }
    } finally {
      if (Number.isSafeInteger(previousTimeout) && previousTimeout >= 0 && previousTimeout <= 2147483647) {
        try { db.exec(`PRAGMA busy_timeout=${previousTimeout}`) } catch { frozen = true; warning = { reason: 'busy_restore_failed' } }
      }
    }
    try {
      if (warning) notify(onConnectionWarning, warning)
      if (failureReason) notify(onFailure, { reason: failureReason, failureAudit: 'not_attempted' })
    } finally {
      writing = false
    }
    if (failureReason) return failure(failureReason)
    if (warning) return { ...outcome, connectionWarning: warning.reason }
    return outcome
  }
  return { record, get enabled() { return !frozen } }
}
