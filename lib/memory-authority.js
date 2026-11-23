import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { inspectMemoryBodyPrepared } from './memory-body-transactions.js'
import { inspectMemoryStrengthPrepared, MEMORY_STRENGTH_PROTOCOL } from './memory-strength-events.js'
import { inspectMemoryAssociationSchema } from './memory-association-transactions.js'
import { inspectP3Preparation } from './memory-association-prepared.js'
import { inspectMemoryExtractPrepared } from './memory-extract-transactions.js'

export const MEMORY_AUTHORITY_PROTOCOL = 'echo-memory-authority/v1'
export const MEMORY_AUTHORITY_ENTRIES = Object.freeze(['memory_add', 'memory_retrieve', 'memory_search', 'memory_association'])
export const MEMORY_RETRIEVAL_ENTRIES = Object.freeze(['memory_add', 'memory_retrieve', 'memory_search'])
export const MEMORY_EXTRACT_ENTRIES = Object.freeze([...MEMORY_AUTHORITY_ENTRIES, 'memory_extract'])
export const MEMORY_AUTHORITY_PROFILES = Object.freeze([
  Object.freeze(['memory_add']),
  MEMORY_RETRIEVAL_ENTRIES,
  MEMORY_AUTHORITY_ENTRIES,
  MEMORY_EXTRACT_ENTRIES
])
const RETRIEVAL_COLUMNS = [
  ['request_key', 'TEXT', 1, 0], ['request_hash', 'TEXT', 0, 1], ['epoch', 'TEXT', 0, 1],
  ['result_json', 'TEXT', 0, 1], ['result_hash', 'TEXT', 0, 1]
]
const TABLE = 'memory_authority_control'
const COLUMNS = [
  ['id', 'INTEGER', 1, 0], ['protocol', 'TEXT', 0, 1], ['strength_epoch', 'TEXT', 0, 1],
  ['generation', 'INTEGER', 0, 1], ['mode', 'TEXT', 0, 1], ['enabled_entries', 'TEXT', 0, 1],
  ['cutoff_at_ms', 'INTEGER', 0, 1], ['archive_ref', 'TEXT', 0, 1]
]
const DDL = 'id INTEGER PRIMARY KEY CHECK(id=1),protocol TEXT NOT NULL,strength_epoch TEXT NOT NULL,'
  + 'generation INTEGER NOT NULL,mode TEXT NOT NULL,enabled_entries TEXT NOT NULL,cutoff_at_ms INTEGER NOT NULL,archive_ref TEXT NOT NULL'
const fixed = reason => ({ status: 'blocked', protocol: MEMORY_AUTHORITY_PROTOCOL, epoch: null,
  generation: null, entries: [], cutoffAtMs: null, archiveRef: null, reason })
const legacy = () => ({ status: 'legacy', protocol: MEMORY_AUTHORITY_PROTOCOL, epoch: null,
  generation: null, entries: [], cutoffAtMs: null, archiveRef: null, reason: null })
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum
const text = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 128
  && !/[\u0000-\u0020\u007f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u.test(value)
  && ![...value].some(char => char.length === 1 && /[\ud800-\udfff]/u.test(char))
const quote = value => '"' + value.replace(/"/gu, '""') + '"'

function compareTextColumns(db) {
  for (const [name, type] of COLUMNS) {
    if (type !== 'TEXT') continue
    const comparisons = db.prepare(`EXPLAIN SELECT "${name}"=? FROM "${TABLE}" LIMIT 1`).all('authority-probe')
      .filter(row => row.opcode === 'Eq')
    if (comparisons.length !== 1 || comparisons[0].p4 !== 'BINARY-8') return false
  }
  return true
}

/** Read-only scope/epoch gate. A missing manifest means legacy, never inferred active. */
export function inspectMemoryAuthority(db) {
  try {
    const objects = db.prepare('SELECT type FROM sqlite_master WHERE name=?').all(TABLE)
    if (objects.length === 0) return legacy()
    if (objects.length !== 1 || objects[0].type !== 'table') return fixed('a1_authority_schema_invalid')

    const actual = db.prepare(`PRAGMA table_info(${quote(TABLE)})`).all()
    if (actual.length !== COLUMNS.length || actual.some((row, index) => {
      const [name, type, pk, notnull] = COLUMNS[index]
      return row.name !== name || row.type.toUpperCase() !== type || row.pk !== pk
        || row.notnull !== notnull || row.dflt_value !== null
    }) || !compareTextColumns(db)) return fixed('a1_authority_schema_invalid')
    if (db.prepare(`PRAGMA index_list(${quote(TABLE)})`).all().some(index => index.origin === 'pk')) {
      return fixed('a1_authority_schema_invalid')
    }

    const rows = db.prepare(`SELECT * FROM ${quote(TABLE)} LIMIT 2`).all()
    if (rows.length !== 1) return fixed('a1_authority_invalid')
    const row = rows[0]
    if (row.id !== 1 || row.protocol !== MEMORY_AUTHORITY_PROTOCOL || !text(row.strength_epoch)
      || !integer(row.generation, 1) || !integer(row.cutoff_at_ms)) return fixed('a1_authority_invalid')

    let entries
    if (row.mode === 'prepared') {
      if (row.enabled_entries !== '[]' || row.cutoff_at_ms !== 0 || row.archive_ref !== '') return fixed('a1_authority_invalid')
      entries = []
    } else if (row.mode === 'active') {
      if (!MEMORY_AUTHORITY_PROFILES.some(profile => row.enabled_entries === JSON.stringify(profile))
        || !integer(row.cutoff_at_ms, 1)
        || typeof row.archive_ref !== 'string' || !/^[a-f0-9]{64}$/u.test(row.archive_ref)) {
        return fixed('a1_authority_invalid')
      }
      entries = JSON.parse(row.enabled_entries)
    } else return fixed('a1_authority_invalid')

    const strict = entries.includes('memory_association')
    if (strict) {
      const extended = db.prepare(`PRAGMA table_xinfo(${quote(TABLE)})`).all()
      if (extended.length !== COLUMNS.length || extended.some(row => row.hidden !== 0)) return fixed('a1_schema_incompatible')
    }
    const strength = inspectMemoryStrengthPrepared(db, { strict }), body = inspectMemoryBodyPrepared(db, { strict })
    if (strength.status !== 'ready' || body.status !== 'ready') return fixed('a1_schema_unprepared')
    if (strength.epoch !== row.strength_epoch || body.epoch !== row.strength_epoch) return fixed('a1_epoch_mismatch')
    if (entries.includes('memory_retrieve')) {
      const retrieval = inspectMemoryRetrievalPrepared(db)
      if (!retrieval) return fixed('a1_schema_unprepared')
    }
    if (entries.includes('memory_association')) {
      const p3 = inspectP3Preparation(db, { strict: true })
      if (p3.status !== 'ready') return fixed(p3.reason === 'prepared_schema_incompatible'
        ? 'a1_schema_incompatible' : 'a1_schema_unprepared')
      const association = inspectMemoryAssociationSchema(db, { epoch: row.strength_epoch })
      if (association.status !== 'ready') return fixed(association.reason === 'association_schema_incompatible'
        ? 'a1_schema_incompatible' : 'a1_schema_unprepared')
    }
    if (entries.includes('memory_extract')) {
      const extract = inspectMemoryExtractPrepared(db, { epoch: row.strength_epoch })
      if (extract.reason === 'extract_epoch_mismatch') return fixed('a1_epoch_mismatch')
      if (extract.status !== 'ready') return fixed(extract.reason === 'extract_schema_incompatible'
        ? 'a1_schema_incompatible' : 'a1_schema_unprepared')
    }
    return { status: row.mode, protocol: MEMORY_AUTHORITY_PROTOCOL, epoch: row.strength_epoch,
      generation: row.generation, entries, cutoffAtMs: row.cutoff_at_ms, archiveRef: row.archive_ref, reason: null }
  } catch { return fixed('a1_authority_unavailable') }
}

export function inspectMemoryRetrievalPrepared(db) {
  try {
    const table = 'memory_retrieval_receipts'
    const actual = db.prepare(`PRAGMA table_xinfo("${table}")`).all()
    if (actual.length !== RETRIEVAL_COLUMNS.length || actual.some((row, i) => {
      const [name, type, pk, nn] = RETRIEVAL_COLUMNS[i]
      return row.hidden !== 0 || row.name !== name || row.type.toUpperCase() !== type || row.pk !== pk
        || row.notnull !== nn || row.dflt_value !== null
    })) return false
    for (const [name] of RETRIEVAL_COLUMNS) {
      const eq = db.prepare(`EXPLAIN SELECT "${name}"=? FROM "${table}" LIMIT 1`).all('probe').filter(row => row.opcode === 'Eq')
      if (eq.length !== 1 || eq[0].p4 !== 'BINARY-8') return false
    }
    return db.prepare(`PRAGMA index_list("${table}")`).all().some(index => {
      if (index.origin !== 'pk' || index.partial !== 0) return false
      const cols = db.prepare(`PRAGMA index_xinfo(${quote(index.name)})`).all().filter(c => c.key === 1)
      return cols.length === 1 && cols[0].name === 'request_key' && cols[0].coll === 'BINARY'
    })
  } catch { return false }
}

/** Explicitly creates only a prepared manifest; there is intentionally no active transition API. */
export function prepareMemoryAuthoritySchema(db, { epoch } = {}) {
  if (!text(epoch)) throw Error('a1_authority_invalid')
  if (!db?.exec || !db?.prepare) throw Error('a1_authority_db_required')
  if (db.isTransaction) throw Error('a1_transaction_already_open')
  const strength = inspectMemoryStrengthPrepared(db), body = inspectMemoryBodyPrepared(db)
  if (strength.status !== 'ready' || body.status !== 'ready') throw Error('a1_schema_unprepared')
  if (strength.epoch !== epoch || body.epoch !== epoch) throw Error('a1_epoch_mismatch')

  db.exec('BEGIN IMMEDIATE')
  try {
    const before = inspectMemoryAuthority(db)
    if (before.status === 'legacy') {
      db.exec(`CREATE TABLE ${quote(TABLE)} (${DDL})`)
      db.prepare(`INSERT INTO ${quote(TABLE)} VALUES (1,?,?,1,'prepared','[]',0,'')`)
        .run(MEMORY_AUTHORITY_PROTOCOL, epoch)
    } else if (before.status === 'blocked') throw Error(before.reason || 'a1_authority_invalid')
    else if (before.epoch !== epoch) throw Error('a1_epoch_mismatch')

    const after = inspectMemoryAuthority(db)
    if (!['prepared', 'active'].includes(after.status)) throw Error(after.reason || 'a1_authority_invalid')
    db.exec('COMMIT')
    return after
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { throw Error('a1_rollback_failed') }
    throw error
  }
}

/** Validates one ready binding; callers must not infer activation from schema presence. */
export function authorityBindingMatches(binding, authority) {
  return !!binding && Object.getPrototypeOf(binding) === Object.prototype
    && Object.keys(binding).length === 3 && binding.protocol === MEMORY_AUTHORITY_PROTOCOL
    && authority?.protocol === MEMORY_AUTHORITY_PROTOCOL
    && binding.epoch === authority?.epoch && integer(binding.generation, 1)
    && binding.generation === authority.generation
}

export function authorityHelloState(authority) {
  if (!authority || !['legacy', 'prepared', 'active', 'blocked'].includes(authority.status)) return fixed('a1_authority_invalid')
  return { status: authority.status, protocol: MEMORY_AUTHORITY_PROTOCOL,
    epoch: authority.epoch ?? null, generation: authority.generation ?? null,
    entries: Array.isArray(authority.entries) ? [...authority.entries] : [],
    cutoffAtMs: authority.cutoffAtMs ?? null, archiveRef: authority.archiveRef ?? null,
    reason: authority.reason ?? null, strengthProtocol: MEMORY_STRENGTH_PROTOCOL,
    bodyProtocol: 'echo-memory-body/v1', supportedEntries: [...MEMORY_AUTHORITY_ENTRIES] }
}

export function inspectMemoryAuthorityPath(path) {
  if (path === ':memory:' || !existsSync(path)) return legacy()
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    return inspectMemoryAuthority(db)
  } catch { return fixed('a1_authority_unavailable') }
  finally { try { db?.close() } catch {} }
}
