import { createHash } from 'node:crypto'
import { initialHalfLife, reinforceHalfLife, retrievability } from './dmae.js'

export const MEMORY_STRENGTH_PROTOCOL = 'echo-memory-strength/v1'
export const MEMORY_STRENGTH_LIMITS = Object.freeze({ receipts: 1024, batch: 8, inputBytes: 16384, idBytes: 128 })
const tables = {
  memory_strength_control: {
    ddl: 'id INTEGER PRIMARY KEY CHECK(id=1),protocol TEXT NOT NULL,epoch TEXT NOT NULL,receipt_limit INTEGER NOT NULL',
    columns: [['id', 'INTEGER', 1, 0], ['protocol', 'TEXT', 0, 1], ['epoch', 'TEXT', 0, 1], ['receipt_limit', 'INTEGER', 0, 1]]
  },
  memory_strength_events: {
    ddl: 'event_key TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,epoch TEXT NOT NULL,kind TEXT NOT NULL,memory_id TEXT NOT NULL,occurred_at_ms INTEGER NOT NULL,admission_key TEXT NOT NULL,strength_applied INTEGER NOT NULL,half_life_after REAL NOT NULL,count_after INTEGER NOT NULL,last_after REAL NOT NULL,intrinsic_after REAL NOT NULL',
    columns: [['event_key', 'TEXT', 1, 0], ['payload_hash', 'TEXT', 0, 1], ['epoch', 'TEXT', 0, 1],
      ['kind', 'TEXT', 0, 1], ['memory_id', 'TEXT', 0, 1], ['occurred_at_ms', 'INTEGER', 0, 1],
      ['admission_key', 'TEXT', 0, 1], ['strength_applied', 'INTEGER', 0, 1],
      ['half_life_after', 'REAL', 0, 1], ['count_after', 'INTEGER', 0, 1], ['last_after', 'REAL', 0, 1], ['intrinsic_after', 'REAL', 0, 1]]
  },
  memory_strength_admissions: {
    ddl: 'admission_key TEXT PRIMARY KEY,epoch TEXT NOT NULL,memory_id TEXT NOT NULL,applied_event_key TEXT NOT NULL',
    columns: [['admission_key', 'TEXT', 1, 0], ['epoch', 'TEXT', 0, 1], ['memory_id', 'TEXT', 0, 1], ['applied_event_key', 'TEXT', 0, 1]]
  }
}
class StrengthError extends Error {}
const fail = reason => { throw new StrengthError(reason) }
const finite = value => typeof value === 'number' && Number.isFinite(value)
const clock = value => Number.isSafeInteger(value) && value >= 0
const validIntrinsic = value => finite(value) && value >= 0 && value <= 100
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const floatKey = value => { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value === 0 ? 0 : value); return bytes.toString('hex') }
function text(value) {
  if (typeof value !== 'string' || !value
    || Buffer.byteLength(value) > MEMORY_STRENGTH_LIMITS.idBytes
    || /[\u0000-\u0020\u007f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u.test(value)
    || [...value].some(char => char.length === 1 && /[\ud800-\udfff]/u.test(char))) fail('strength_invalid_input')
  return value
}
function shape(value, required, optional = []) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => d.get || d.set)) fail('strength_invalid_input')
}
function normalize(request) {
  shape(request, ['protocol', 'epoch', 'nowMs', 'events'])
  if (request.protocol !== MEMORY_STRENGTH_PROTOCOL || !clock(request.nowMs)
    || !Array.isArray(request.events) || !request.events.length || request.events.length > MEMORY_STRENGTH_LIMITS.batch) fail('strength_invalid_input')
  const epoch = text(request.epoch)
  const events = request.events.map(event => {
    shape(event, ['kind', 'sourceIdentity', 'memoryId', 'occurredAtMs'], ['intrinsicValue', 'admissionIdentity'])
    if (!['auto_context', 'association', 'search', 'teach', 'edit'].includes(event.kind) || !clock(event.occurredAtMs)) fail('strength_invalid_input')
    const sourceIdentity = text(event.sourceIdentity)
    const memoryId = typeof event.memoryId === 'number' && Number.isSafeInteger(event.memoryId) ? String(event.memoryId) : event.memoryId
    if (typeof memoryId !== 'string' || !/^[1-9][0-9]*$/u.test(memoryId) || !Number.isSafeInteger(Number(memoryId))) fail('strength_invalid_input')
    if (event.kind === 'edit' ? !validIntrinsic(event.intrinsicValue) : Object.hasOwn(event, 'intrinsicValue')) fail('strength_invalid_input')
    const admission = ['auto_context', 'association'].includes(event.kind)
    if (!admission && Object.hasOwn(event, 'admissionIdentity')) fail('strength_invalid_input')
    const admissionIdentity = admission ? text(event.admissionIdentity) : ''
    const identity = [MEMORY_STRENGTH_PROTOCOL, epoch, event.kind, sourceIdentity, memoryId]
    const admissionKey = admission ? digest([MEMORY_STRENGTH_PROTOCOL, epoch, admissionIdentity, memoryId]) : ''
    return { kind: event.kind, admissionKey, memoryId, occurredAtMs: event.occurredAtMs, intrinsicValue: event.intrinsicValue,
      wire: [event.kind, sourceIdentity, memoryId, String(event.occurredAtMs), admissionIdentity,
        event.kind === 'edit' ? floatKey(event.intrinsicValue) : ''],
      eventKey: digest(identity), payloadHash: digest([...identity, String(event.occurredAtMs),
        admissionIdentity, event.kind === 'edit' ? floatKey(event.intrinsicValue) : '']) }
  })
  if (Buffer.byteLength(JSON.stringify([MEMORY_STRENGTH_PROTOCOL, epoch, String(request.nowMs), events.map(e => e.wire)]))
    > MEMORY_STRENGTH_LIMITS.inputBytes) fail('strength_input_budget')
  // Stable sort groups Memory locks; events for the same Memory retain caller order.
  return { epoch, nowMs: request.nowMs, events: events.sort((a, b) => Number(a.memoryId) - Number(b.memoryId)) }
}

/** Checks only the new protocol and required source columns; never creates or repairs anything. */
export function inspectMemoryStrengthPrepared(db, { strict = false } = {}) {
  try {
    for (const [name, definition] of Object.entries(tables)) {
      const rows = db.prepare(`PRAGMA ${strict ? 'table_xinfo' : 'table_info'}("${name}")`).all()
      if (!rows.length) return { status: 'unavailable', reason: 'strength_schema_missing' }
      if (strict && rows.some(row => row.hidden !== 0)) return { status: 'incompatible', reason: 'strength_schema_incompatible' }
      if (rows.length !== definition.columns.length || definition.columns.some(([column, type, pk, notnull], index) => {
        const row = rows.find(r => r.name === column)
        return !row || rows[index].name !== column || row.type.toUpperCase() !== type || row.pk !== pk || row.notnull !== notnull || row.dflt_value !== null
      })) return { status: 'incompatible', reason: 'strength_schema_incompatible' }
      for (const [column, type] of definition.columns.filter(([, type]) => type === 'TEXT')) {
        const eq = db.prepare(`EXPLAIN SELECT "${column}"=? FROM "${name}" LIMIT 1`).all('probe').filter(row => row.opcode === 'Eq')
        if (eq.length !== 1 || eq[0].p4 !== 'BINARY-8') return { status: 'incompatible', reason: 'strength_schema_incompatible' }
      }
      if (name !== 'memory_strength_control') {
        const primaryKey = definition.columns.find(row => row[2] === 1)[0]
        const pk = db.prepare(`PRAGMA index_list("${name}")`).all().filter(row => row.origin === 'pk' && row.partial === 0)
        if (!pk.some(index => {
          const cols = db.prepare(`PRAGMA index_xinfo("${index.name.replace(/"/gu, '""')}")`).all().filter(row => row.key === 1)
          return cols.length === 1 && cols[0].name === primaryKey && cols[0].coll === 'BINARY'
        })) return { status: 'incompatible', reason: 'strength_schema_incompatible' }
      }
    }
    db.prepare(`SELECT memory_id,user_id,is_active,status,superseded_by,intrinsic_value,
      half_life,recall_count,last_recalled FROM episodic_memory LIMIT 0`).all()
    const memoryPk = db.prepare('PRAGMA table_info(episodic_memory)').all().filter(row => row.pk)
    if (memoryPk.length !== 1 || memoryPk[0].name !== 'memory_id' || memoryPk[0].type.toUpperCase() !== 'INTEGER') {
      return { status: 'incompatible', reason: 'strength_source_incompatible' }
    }
    const controls = db.prepare('SELECT id,protocol,epoch,receipt_limit FROM memory_strength_control LIMIT 2').all()
    if (controls.length !== 1 || controls[0].id !== 1 || controls[0].protocol !== MEMORY_STRENGTH_PROTOCOL
      || controls[0].receipt_limit !== MEMORY_STRENGTH_LIMITS.receipts) return { status: 'incompatible', reason: 'strength_control_incompatible' }
    text(controls[0].epoch)
    return { status: 'ready', reason: null, epoch: controls[0].epoch }
  } catch { return { status: 'unavailable', reason: 'strength_schema_unavailable' } }
}
export function prepareMemoryStrengthSchema(db, { epoch } = {}) {
  text(epoch)
  if (!db?.exec || !db?.prepare) fail('strength_db_required')
  if (db.isTransaction) fail('strength_transaction_already_open')
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const [name, definition] of Object.entries(tables)) db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${definition.ddl})`)
    const existing = db.prepare('SELECT epoch FROM memory_strength_control WHERE id=1').get()
    if (!existing) db.prepare('INSERT INTO memory_strength_control VALUES (1,?,?,?)')
      .run(MEMORY_STRENGTH_PROTOCOL, epoch, MEMORY_STRENGTH_LIMITS.receipts)
    const prepared = inspectMemoryStrengthPrepared(db)
    if (prepared.status !== 'ready') fail(prepared.reason)
    if (prepared.epoch !== epoch) fail('strength_epoch_mismatch')
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

const validReceiptResult = row => row && /^[a-f0-9]{64}$/u.test(row.event_key)
  && /^[a-f0-9]{64}$/u.test(row.payload_hash) && clock(row.occurred_at_ms)
  && finite(row.half_life_after) && row.half_life_after > 0 && clock(row.count_after)
  && finite(row.last_after) && row.last_after > 0 && row.last_after * 1000 <= Number.MAX_SAFE_INTEGER
  && validIntrinsic(row.intrinsic_after)
function checkedAdmission(db, event, epoch, prior = null) {
  if (!event.admissionKey) {
    if (prior && prior.strength_applied !== 1) fail('strength_receipt_invalid')
    return null
  }
  const barrier = db.prepare('SELECT * FROM memory_strength_admissions WHERE admission_key=?').get(event.admissionKey)
  if (!barrier) {
    if (prior || db.prepare('SELECT 1 FROM memory_strength_events WHERE admission_key=? LIMIT 1').get(event.admissionKey)) {
      fail('strength_admission_invalid')
    }
    return null
  }
  const anchor = db.prepare('SELECT * FROM memory_strength_events WHERE event_key=?').get(barrier.applied_event_key)
  if (barrier.epoch !== epoch || barrier.memory_id !== event.memoryId || !validReceiptResult(anchor)
    || !['auto_context', 'association'].includes(anchor.kind) || anchor.strength_applied !== 1
    || anchor.epoch !== epoch || anchor.memory_id !== event.memoryId || anchor.admission_key !== event.admissionKey
    || anchor.count_after < 1 || anchor.last_after * 1000 < anchor.occurred_at_ms
    || (prior && prior.strength_applied === 1 && barrier.applied_event_key !== prior.event_key)
    || (prior && prior.strength_applied === 0 && barrier.applied_event_key === prior.event_key)) fail('strength_admission_invalid')
  return barrier
}

/** Trusted caller owns rollback on any exception. No BEGIN/COMMIT/ROLLBACK, DDL, or native-proof claims. */
export function applyMemoryStrengthEvents(db, request) {
  if (!db?.isTransaction) fail('strength_transaction_required')
  const normalized = normalize(request)
  const prepared = inspectMemoryStrengthPrepared(db)
  if (prepared.status !== 'ready') fail(prepared.reason)
  if (prepared.epoch !== normalized.epoch) fail('strength_epoch_mismatch')
  const outcomes = []
  for (const event of normalized.events) {
    const prior = db.prepare('SELECT * FROM memory_strength_events WHERE event_key=?').get(event.eventKey)
    if (prior) {
      if (prior.payload_hash !== event.payloadHash || prior.epoch !== normalized.epoch) fail('strength_payload_conflict')
      if (prior.kind !== event.kind || prior.memory_id !== event.memoryId || prior.occurred_at_ms !== event.occurredAtMs
        || prior.admission_key !== event.admissionKey || ![0, 1].includes(prior.strength_applied)
        || !validReceiptResult(prior)) fail('strength_receipt_invalid')
      checkedAdmission(db, event, normalized.epoch, prior)
      outcomes.push({ status: 'duplicate', memoryId: event.memoryId, eventKey: event.eventKey,
        sourceReceiptNew: false, associationStatisticsEligible: false, halfLife: prior.half_life_after,
        recallCount: prior.count_after, lastRecalled: prior.last_after, intrinsicValue: prior.intrinsic_after })
      continue
    }
    const admitted = checkedAdmission(db, event, normalized.epoch)
    const size = db.prepare('SELECT COUNT(*) n FROM (SELECT event_key FROM memory_strength_events LIMIT ?)').get(MEMORY_STRENGTH_LIMITS.receipts + 1).n
    if (size >= MEMORY_STRENGTH_LIMITS.receipts) fail('strength_receipt_capacity')
    const row = db.prepare(`SELECT memory_id,user_id,is_active,status,superseded_by,intrinsic_value,
      half_life,recall_count,last_recalled FROM episodic_memory WHERE memory_id=?`).get(event.memoryId)
    if (!row) fail('strength_memory_missing')
    if (row.user_id !== 'master' || row.is_active !== 1 || ![null, 'active'].includes(row.status)
      || !['', '0'].includes(String(row.superseded_by ?? ''))) fail('strength_memory_ineligible')
    if (!validIntrinsic(row.intrinsic_value) || !clock(row.recall_count) || (!finite(row.half_life)
      && row.half_life !== null) || row.half_life < 0 || !finite(row.last_recalled) || row.last_recalled <= 0) fail('strength_state_invalid')
    const lastMs = row.last_recalled * 1000
    if (!finite(lastMs) || lastMs > Number.MAX_SAFE_INTEGER) fail('strength_state_invalid')
    if (event.occurredAtMs > normalized.nowMs || lastMs > normalized.nowMs) fail('strength_clock_invalid')
    const h = row.half_life > 0 ? row.half_life : initialHalfLife(row.intrinsic_value)
    const intrinsic = event.kind === 'edit' ? event.intrinsicValue : row.intrinsic_value
    const halfLife = admitted ? h : event.kind === 'edit' ? initialHalfLife(intrinsic)
      : reinforceHalfLife(h, retrievability(Math.max(0, event.occurredAtMs - lastMs) / 3600000, h))
    const count = admitted || event.kind === 'edit' ? row.recall_count : row.recall_count + 1
    const last = admitted || event.kind === 'edit' ? row.last_recalled : Math.max(row.last_recalled, event.occurredAtMs / 1000)
    if (!finite(halfLife) || halfLife <= 0 || !clock(count)) fail('strength_state_invalid')
    if (!admitted) db.prepare('UPDATE episodic_memory SET half_life=?,recall_count=?,last_recalled=?,intrinsic_value=? WHERE memory_id=?')
      .run(halfLife, count, last, intrinsic, event.memoryId)
    db.prepare(`INSERT INTO memory_strength_events(event_key,payload_hash,epoch,kind,memory_id,occurred_at_ms,admission_key,strength_applied,
      half_life_after,count_after,last_after,intrinsic_after) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(event.eventKey, event.payloadHash, normalized.epoch, event.kind, event.memoryId, event.occurredAtMs, event.admissionKey, admitted ? 0 : 1,
        halfLife, count, last, intrinsic)
    if (event.admissionKey && !admitted) db.prepare('INSERT INTO memory_strength_admissions VALUES (?,?,?,?)')
      .run(event.admissionKey, normalized.epoch, event.memoryId, event.eventKey)
    outcomes.push({ status: admitted ? 'skipped_strength' : 'applied', memoryId: event.memoryId, eventKey: event.eventKey, sourceReceiptNew: true,
      associationStatisticsEligible: event.kind === 'association', halfLife, recallCount: count,
      lastRecalled: last, intrinsicValue: intrinsic })
  }
  const appliedCount = outcomes.filter(row => row.status === 'applied').length
  const duplicateCount = outcomes.filter(row => row.status === 'duplicate').length
  return { status: duplicateCount === outcomes.length ? 'duplicate' : 'committed', appliedCount,
    skippedCount: outcomes.length - duplicateCount - appliedCount, duplicateCount, outcomes }
}

export function createMemoryStrengthEvents({ db, enabled = false } = {}) {
  if (enabled !== true) return { record: () => ({ status: 'disabled', accepted: false }) }
  return {
    record(request) {
      if (!db?.exec || !db?.prepare) return { status: 'failed', reason: 'strength_db_required', accepted: false }
      if (db.isTransaction) return { status: 'failed', reason: 'strength_transaction_already_open', accepted: false }
      let transaction = false
      try {
        db.exec('BEGIN IMMEDIATE'); transaction = true
        const result = applyMemoryStrengthEvents(db, request)
        db.exec('COMMIT'); transaction = false
        return { ...result, accepted: true }
      } catch (error) {
        if (transaction) { try { db.exec('ROLLBACK') } catch { return { status: 'failed', reason: 'strength_rollback_failed', accepted: false } } }
        return { status: 'failed', reason: error instanceof StrengthError ? error.message
          : error?.errcode === 5 ? 'strength_write_busy' : 'strength_write_failed', accepted: false }
      }
    }
  }
}
