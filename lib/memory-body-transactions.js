import { createHash } from 'node:crypto'
import { applyMemoryStrengthEvents, inspectMemoryStrengthPrepared, MEMORY_STRENGTH_PROTOCOL } from './memory-strength-events.js'

export const MEMORY_BODY_PROTOCOL = 'echo-memory-body/v1'
export const MEMORY_BODY_LIMITS = Object.freeze({ receipts: 1024, inputBytes: 65536, resultBytes: 16384, items: 16 })
const MAX_SAFE = Number.MAX_SAFE_INTEGER
const table = 'memory_body_receipts'
const columns = [
  ['body_key', 'TEXT', 1, 0], ['payload_hash', 'TEXT', 0, 1], ['epoch', 'TEXT', 0, 1],
  ['source_kind', 'TEXT', 0, 1], ['source_identity', 'TEXT', 0, 1], ['occurred_at_ms', 'INTEGER', 0, 1],
  ['result_json', 'TEXT', 0, 1], ['result_hash', 'TEXT', 0, 1]
]
const ddl = 'body_key TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,epoch TEXT NOT NULL,source_kind TEXT NOT NULL,'
  + 'source_identity TEXT NOT NULL,occurred_at_ms INTEGER NOT NULL,result_json TEXT NOT NULL,result_hash TEXT NOT NULL'

class BodyError extends Error {}
const fail = reason => { throw new BodyError(reason) }
const finite = value => typeof value === 'number' && Number.isFinite(value)
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex')
const digest = value => sha(JSON.stringify(value))
const own = (value, key) => Object.hasOwn(value, key)
const validString = value => typeof value === 'string'
  && ![...value].some(char => char.length === 1 && /[\ud800-\udfff]/u.test(char))
function identity(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 128
    || /[\u0000-\u0020\u007f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u.test(value)
    || !validString(value)) fail('body_invalid_input')
  return value
}
function exact(value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || required.some(key => !own(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => descriptor.get || descriptor.set)) {
    fail('body_invalid_input')
  }
}
function parsePayload(raw) {
  if (typeof raw !== 'string' || !validString(raw) || Buffer.byteLength(raw, 'utf8') > MEMORY_BODY_LIMITS.inputBytes) {
    fail('body_input_budget')
  }
  let value
  try { value = JSON.parse(raw) } catch { fail('body_invalid_input') }
  let count = 0
  const visit = (item, depth = 0) => {
    if (++count > 10000 || depth > 20) fail('body_invalid_input')
    if (typeof item === 'string') {
      if (!validString(item)) fail('body_invalid_input')
    } else if (item === null || typeof item === 'boolean') {
      return
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('body_invalid_input')
    } else if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1)
    } else if (item && Object.getPrototypeOf(item) === Object.prototype) {
      for (const [key, child] of Object.entries(item)) {
        if (!validString(key)) fail('body_invalid_input')
        visit(child, depth + 1)
      }
    } else fail('body_invalid_input')
  }
  visit(value)
  return value
}
function normalizeItems(payload, sourceKind) {
  exact(payload, ['items'])
  if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > MEMORY_BODY_LIMITS.items
    || (sourceKind === 'teach' && payload.items.length !== 1)) fail('body_invalid_input')
  const seen = new Set()
  const items = payload.items.map(item => {
    exact(item, ['ordinal', 'input'])
    if (!integer(item.ordinal) || item.ordinal > 63 || seen.has(item.ordinal)) fail('body_invalid_input')
    seen.add(item.ordinal)
    return { ordinal: item.ordinal, input: normalizeInput(item.input) }
  })
  return items
}
function normalizeInput(input) {
  const required = ['keywords', 'summary', 'emotionScore', 'source']
  const optional = ['intrinsicValue', 'sourceLabel', 'actor', 'occurredAt', 'temporalStatus', 'memoryKey',
    'layer', 'evidence', 'augKeys', 'speakerId', 'isMaster', 'status', 'memoryType', 'memoryStability', 'dedupe']
  exact(input, required, optional)
  if (!Array.isArray(input.keywords) || input.keywords.some(value => !validString(value))
    || input.keywords.some(value => value === '')
    || !validString(input.summary) || !input.summary.trim() || !Number.isInteger(input.emotionScore)
    || input.emotionScore < 1 || input.emotionScore > 10 || !validString(input.source) || input.source === '') {
    fail('body_invalid_input')
  }
  for (const key of ['sourceLabel', 'actor', 'temporalStatus', 'memoryKey', 'layer', 'evidence', 'speakerId', 'status',
    'memoryType', 'memoryStability']) {
    if (own(input, key) && !validString(input[key])) fail('body_invalid_input')
  }
  if (own(input, 'intrinsicValue') && (!finite(input.intrinsicValue) || input.intrinsicValue < 0 || input.intrinsicValue > 100)) {
    fail('body_invalid_input')
  }
  if (own(input, 'occurredAt') && !finite(input.occurredAt)) fail('body_invalid_input')
  if (own(input, 'augKeys') && input.augKeys !== null
    && (!Array.isArray(input.augKeys) || input.augKeys.some(value => !validString(value)))) {
    fail('body_invalid_input')
  }
  if ((own(input, 'speakerId') && input.speakerId !== '') || (own(input, 'isMaster') && input.isMaster !== true)
    || (own(input, 'status') && input.status !== 'active') || (own(input, 'memoryType') && input.memoryType !== '')
    || (own(input, 'memoryStability') && input.memoryStability !== '')
    || (own(input, 'dedupe') && input.dedupe !== null)) fail('body_unsupported_field')
  if (input.evidence && input.evidence !== '') fail('body_unsupported_field')
  const { keywords, summary, emotionScore, ...options } = input
  return { keywords, summary, emotionScore, options }
}
function rowList(db, sql, parameters = []) { return db.prepare(sql).all(...parameters) }
function rowOne(db, sql, parameters = []) { return db.prepare(sql).get(...parameters) }

export function inspectMemoryBodyPrepared(db, { strict = false } = {}) {
  const strength = inspectMemoryStrengthPrepared(db, { strict })
  if (strength.status !== 'ready') return { status: 'unavailable', reason: strength.reason }
  try {
    const actual = rowList(db, `PRAGMA ${strict ? 'table_xinfo' : 'table_info'}("${table}")`)
    if (!actual.length) return { status: 'unavailable', reason: 'body_schema_missing' }
    if (strict && actual.some(row => row.hidden !== 0)) return { status: 'incompatible', reason: 'body_schema_incompatible' }
    if (actual.length !== columns.length || actual.some((row, index) => {
      const [name, type, pk, notnull] = columns[index]
      return row.name !== name || row.type.toUpperCase() !== type || row.pk !== pk
        || row.notnull !== notnull || row.dflt_value !== null
    })) return { status: 'incompatible', reason: 'body_schema_incompatible' }
    for (const [name, type] of columns) {
      if (type !== 'TEXT') continue
      const comparisons = rowList(db, `EXPLAIN SELECT "${name}"=? FROM "${table}" LIMIT 1`, ['probe'])
        .filter(row => row.opcode === 'Eq')
      if (comparisons.length !== 1 || comparisons[0].p4 !== 'BINARY-8') {
        return { status: 'incompatible', reason: 'body_schema_incompatible' }
      }
    }
    const primaryIndexes = rowList(db, `PRAGMA index_list("${table}")`).filter(index => index.origin === 'pk' && index.partial === 0)
    const validPrimaryKey = primaryIndexes.some(index => {
      const safeName = index.name.replace(/"/gu, '""')
      const keys = rowList(db, `PRAGMA index_xinfo("${safeName}")`).filter(row => row.key === 1)
      return keys.length === 1 && keys[0].name === 'body_key' && keys[0].coll === 'BINARY'
    })
    if (!validPrimaryKey) return { status: 'incompatible', reason: 'body_schema_incompatible' }
    return { status: 'ready', reason: null, epoch: strength.epoch }
  } catch { return { status: 'unavailable', reason: 'body_schema_unavailable' } }
}

export function prepareMemoryBodySchema(db, { epoch } = {}) {
  identity(epoch)
  if (!db?.exec || !db?.prepare) fail('body_db_required')
  if (db.isTransaction) fail('body_transaction_already_open')
  db.exec('BEGIN IMMEDIATE')
  try {
    const strength = inspectMemoryStrengthPrepared(db)
    if (strength.status !== 'ready') fail(strength.reason)
    if (strength.epoch !== epoch) fail('body_epoch_mismatch')
    db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${ddl})`)
    const prepared = inspectMemoryBodyPrepared(db)
    if (prepared.status !== 'ready') fail(prepared.reason)
    if (prepared.epoch !== epoch) fail('body_epoch_mismatch')
    db.exec('COMMIT')
    return prepared
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { fail('body_rollback_failed') }
    throw error
  }
}

function validWrittenResult(resultJson, items) {
  if (typeof resultJson !== 'string' || Buffer.byteLength(resultJson, 'utf8') > MEMORY_BODY_LIMITS.resultBytes
    || !validString(resultJson)) fail('body_receipt_invalid')
  let result
  try { result = JSON.parse(resultJson) } catch { fail('body_receipt_invalid') }
  if (!Array.isArray(result) || result.length !== items.length || JSON.stringify(result) !== resultJson) fail('body_receipt_invalid')
  return result.map((row, index) => {
    const item = items[index]
    if (!Array.isArray(row) || row.length !== 3 || row[0] !== String(item.ordinal)
      || typeof row[1] !== 'string' || !/^[1-9][0-9]{0,15}$/u.test(row[1])
      || !Number.isSafeInteger(Number(row[1])) || !['initialized', 'reinforced'].includes(row[2])) fail('body_receipt_invalid')
    return { ordinal: item.ordinal, memoryId: row[1], action: row[2] }
  })
}

function assertStoreDatabase(db, store) {
  if (!store || store.db !== db || typeof store.memoryTransactions?.prepareInsertMemory !== 'function') {
    fail('body_store_unavailable')
  }
}

export function applyMemoryBodyTransactions(db, request, { store, nowMs } = {}) {
  if (!db?.isTransaction) fail('body_transaction_required')
  assertStoreDatabase(db, store)
  if (typeof nowMs !== 'function') fail('body_clock_invalid')
  exact(request, ['protocol', 'epoch', 'sourceKind', 'sourceIdentity', 'occurredAtMs', 'payloadJson'])
  if (request.protocol !== MEMORY_BODY_PROTOCOL || !['extract', 'teach'].includes(request.sourceKind)
    || !integer(request.occurredAtMs, 1)) fail('body_invalid_input')
  const epoch = identity(request.epoch)
  const sourceIdentity = identity(request.sourceIdentity)
  const source = { kind: request.sourceKind, identity: sourceIdentity, time: request.occurredAtMs }
  if (typeof request.payloadJson !== 'string' || !validString(request.payloadJson)
    || Buffer.byteLength(request.payloadJson, 'utf8') > MEMORY_BODY_LIMITS.inputBytes) fail('body_input_budget')
  const payload = parsePayload(request.payloadJson)
  const items = normalizeItems(payload, source.kind)
  const prepared = inspectMemoryBodyPrepared(db)
  if (prepared.status !== 'ready') fail(prepared.reason)
  if (prepared.epoch !== epoch) fail('body_epoch_mismatch')
  const key = digest([MEMORY_BODY_PROTOCOL, epoch, source.kind, source.identity])
  const payloadHash = digest([MEMORY_BODY_PROTOCOL, epoch, source.kind, source.identity, String(source.time), request.payloadJson])

  const prior = rowOne(db, `SELECT * FROM "${table}" WHERE body_key=?`, [key])
  if (prior) {
    if (prior.payload_hash !== payloadHash) fail('body_payload_conflict')
    if (prior.epoch !== epoch || prior.source_kind !== source.kind || prior.source_identity !== source.identity
      || prior.occurred_at_ms !== source.time || typeof prior.result_json !== 'string'
      || typeof prior.result_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(prior.result_hash)
      || sha(prior.result_json) !== prior.result_hash) fail('body_receipt_invalid')
    return { status: 'duplicate', written: validWrittenResult(prior.result_json, items) }
  }
  const now = nowMs()
  if (!integer(now, 1) || source.time > now) fail('body_clock_invalid')
  const count = rowOne(db, `SELECT COUNT(*) n FROM (SELECT body_key FROM "${table}" LIMIT ?)`,
    [MEMORY_BODY_LIMITS.receipts + 1]).n
  if (count >= MEMORY_BODY_LIMITS.receipts) fail('body_receipt_capacity')

  const result = []
  for (const item of items) {
    const decision = store.memoryTransactions.prepareInsertMemory({
      ...item.input.options,
      keywords: item.input.keywords,
      summary: item.input.summary,
      emotionScore: item.input.emotionScore,
      timestamp: source.time / 1000
    })
    if (!decision || !Number.isSafeInteger(decision.memoryId) || decision.memoryId < 1
      || !['inserted', 'replaced', 'reinforce_existing'].includes(decision.action)) fail('body_insert_decision_invalid')
    let action = 'initialized'
    if (decision.action === 'reinforce_existing') {
      const teachSource = digest([MEMORY_BODY_PROTOCOL, source.kind, source.identity, String(item.ordinal)])
      const applied = applyMemoryStrengthEvents(db, {
        protocol: MEMORY_STRENGTH_PROTOCOL,
        epoch,
        nowMs: now,
        events: [{ kind: 'teach', sourceIdentity: teachSource, memoryId: String(decision.memoryId), occurredAtMs: source.time }]
      })
      if (applied.status !== 'committed' || applied.appliedCount !== 1 || applied.outcomes[0]?.status !== 'applied') {
        fail('body_strength_not_applied')
      }
      action = 'reinforced'
    }
    result.push([String(item.ordinal), String(decision.memoryId), action])
  }
  const resultJson = JSON.stringify(result)
  if (Buffer.byteLength(resultJson, 'utf8') > MEMORY_BODY_LIMITS.resultBytes) fail('body_receipt_invalid')
  const written = validWrittenResult(resultJson, items)
  db.prepare(`INSERT INTO "${table}" (body_key,payload_hash,epoch,source_kind,source_identity,occurred_at_ms,result_json,result_hash)
    VALUES (?,?,?,?,?,?,?,?)`).run(key, payloadHash, epoch, source.kind, source.identity, source.time, resultJson, sha(resultJson))
  return { status: 'applied', written }
}

const bodyReasons = new Set([
  'body_invalid_input', 'body_input_budget', 'body_unsupported_field', 'body_db_required',
  'body_transaction_already_open', 'body_epoch_mismatch', 'body_rollback_failed', 'body_schema_missing',
  'body_schema_incompatible', 'body_schema_unavailable', 'body_receipt_invalid', 'body_transaction_required',
  'body_payload_conflict', 'body_clock_invalid', 'body_receipt_capacity', 'body_store_unavailable',
  'body_insert_decision_invalid', 'body_strength_not_applied'
])
const strengthReasons = new Set([
  'strength_invalid_input', 'strength_input_budget', 'strength_db_required', 'strength_transaction_already_open',
  'strength_schema_missing', 'strength_schema_incompatible', 'strength_source_incompatible',
  'strength_control_incompatible', 'strength_schema_unavailable', 'strength_epoch_mismatch',
  'strength_transaction_required', 'strength_payload_conflict', 'strength_receipt_invalid',
  'strength_admission_invalid', 'strength_receipt_capacity', 'strength_memory_missing',
  'strength_memory_ineligible', 'strength_state_invalid', 'strength_clock_invalid'
])
const publicReason = error => {
  const message = String(error?.message || '')
  if ((error instanceof BodyError && bodyReasons.has(message))
    || strengthReasons.has(message) || message === 'memory_transaction_required') return message
  if (error?.errcode === 5 || error?.code === 'SQLITE_BUSY') return 'body_write_busy'
  return 'body_write_failed'
}

/** Body receipts and S1 events are committed only by this outer coordinator. */
export function createMemoryBodyTransactions({ db, store, enabled = false, nowMs = Date.now } = {}) {
  if (enabled !== true) return Object.freeze({
    record: () => ({ status: 'disabled', accepted: false })
  })
  const apply = request => applyMemoryBodyTransactions(db, request, { store, nowMs })
  return Object.freeze({
    apply,
    record(request) {
      if (!db?.exec || !db?.prepare || !store?.memoryTransactions || typeof store.memoryTransactions.prepareInsertMemory !== 'function'
        || store.db !== db || typeof nowMs !== 'function') {
        return { status: 'failed', reason: 'body_coordinator_unavailable', accepted: false }
      }
      if (db.isTransaction) return { status: 'failed', reason: 'body_transaction_already_open', accepted: false }
      let transaction = false
      try {
        db.exec('BEGIN IMMEDIATE')
        transaction = true
        const result = applyMemoryBodyTransactions(db, request, { store, nowMs })
        db.exec('COMMIT')
        transaction = false
        return { ...result, status: result.status === 'applied' ? 'committed' : 'duplicate', accepted: true }
      } catch (error) {
        if (transaction) {
          try { db.exec('ROLLBACK') } catch { return { status: 'failed', reason: 'body_rollback_failed', accepted: false } }
        }
        return { status: 'failed', reason: publicReason(error), accepted: false }
      }
    }
  })
}
