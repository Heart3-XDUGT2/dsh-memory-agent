import { inspectAssociationUseSchema, createAssociationUseTablesInTransaction } from './memory-association-use-schema.js'
import { createAssociationUseStore } from './memory-association-use-store.js'
import { createAssociationUseTracker } from './memory-association-use-tracker.js'

export const P3_LOOKUPS = Object.freeze([
  ['memory_consolidation_traffic_links', 'from_node_id', 'echo_p3_lookup_traffic_from'],
  ['memory_consolidation_traffic_links', 'to_node_id', 'echo_p3_lookup_traffic_to'],
  ['memory_consolidation_memory_links', 'node_id', 'echo_p3_lookup_memory_node']
])
const sourceColumns = {
  episodic_memory: ['memory_id', 'user_id', 'summary', 'is_active', 'status', 'superseded_by', 'intrinsic_value', 'half_life',
    'recall_count', 'last_recalled', 'learned_at', 'timestamp', 'occurred_at', 'temporal_status', 'source',
    'source_label', 'actor', 'speaker_id', 'is_master'],
  memory_consolidation_graph_nodes: ['node_id', 'canonical_name', 'status', 'superseded_by'],
  memory_consolidation_memory_links: ['memory_id', 'node_id', 'link_id'],
  memory_consolidation_traffic_links: ['link_id', 'from_node_id', 'to_node_id', 'relation'],
  memory_consolidation_meta: ['graph_version'],
  memory_consolidation_receipts: ['batch_id']
}
const quote = value => '"' + value.replace(/"/gu, '""') + '"'
const binaryLeading = (db, index, column) => index.partial === 0
  && db.prepare(`PRAGMA index_xinfo(${quote(index.name)})`).all()
    .some(row => row.seqno === 0 && row.key === 1 && row.name === column && row.coll?.toUpperCase() === 'BINARY')
export function inspectP3Preparation(db, { strict = false } = {}) {
  const report = { status: 'failed', reason: 'schema_query_failed', missingTables: 0, invalidTables: 0,
    missingIndexes: 0, invalidIndexes: 0, steps: [] }
  try {
    for (const [table, columns] of Object.entries(sourceColumns)) {
      const actual = new Set(db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name))
      if (!actual.size || columns.some(column => !actual.has(column))) {
        return { ...report, status: 'unavailable', reason: 'source_schema_incompatible' }
      }
    }
    const schema = inspectAssociationUseSchema(db, { trafficDynamics: true, strict })
    report.missingTables = schema.missing
    report.invalidTables = schema.invalid
    for (const [table, column, name] of P3_LOOKUPS) {
      const indexes = db.prepare(`PRAGMA index_list(${quote(table)})`).all()
      const equivalent = index => binaryLeading(db, index, column)
      const existing = db.prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?").get(name)
      if (existing && (existing.tbl_name !== table || !indexes.some(index => index.name === name && equivalent(index)))) report.invalidIndexes++
      if (!indexes.some(equivalent)) report.missingIndexes++
    }
    if (report.invalidTables || report.invalidIndexes) return { ...report, status: 'incompatible', reason: 'prepared_schema_incompatible' }
    if (report.missingTables) report.steps.push('create_use_tables')
    if (report.missingIndexes) report.steps.push('install_lookup_indexes')
    return { ...report, status: report.steps.length ? 'needs_prepare' : 'ready', reason: null }
  } catch { return report }
}
/** DDL only, called by the preparation transaction after verified backup and drift check. */
export function applyP3PreparationInTransaction(db) {
  if (!db.isTransaction) throw Error('prepare_transaction_required')
  const before = inspectP3Preparation(db)
  if (!['ready', 'needs_prepare'].includes(before.status)) throw Error(before.reason)
  createAssociationUseTablesInTransaction(db, { trafficDynamics: true })
  for (const [table, column, name] of P3_LOOKUPS) {
    const exists = db.prepare(`PRAGMA index_list(${quote(table)})`).all().some(index => binaryLeading(db, index, column))
    if (!exists) db.exec(`CREATE INDEX ${quote(name)} ON ${quote(table)}(${quote(column)})`)
  }
  if (inspectP3Preparation(db).status !== 'ready') throw Error('prepared_schema_incompatible')
  return before
}
/** No DB access at all unless explicitly enabled. No constructor DDL on the enabled path. */
export function createPreparedAssociationUseTracker({ db, enabled = false, onFailure = null, onConnectionWarning = null, now = Date.now } = {}) {
  if (enabled !== true) return createAssociationUseTracker()
  if (inspectP3Preparation(db).status !== 'ready') throw Error('p3_not_prepared')
  const writer = createAssociationUseStore({ db, enabled: true, trafficDynamics: true, preparedOnly: true })
  let recording = false, frozen = false, pendingFailure = null
  const safe = (callback, value) => { try { callback?.(value) } catch {} }
  const reportFailure = failure => {
    if (recording) pendingFailure = failure
    else safe(onFailure, failure)
  }
  const writeUse = event => {
    if (frozen) return { status: 'disabled', reason: 'busy_restore_failed' }
    if (recording) return { status: 'failed', reason: 'reentrant_write', failureAudit: 'not_attempted' }
    if (db.isTransaction) return writer.record(event)
    recording = true
    let previous, result, enteredWriter = false, restoreFailed = false
    try {
      previous = db.prepare('PRAGMA busy_timeout').get().timeout
      if (!Number.isSafeInteger(previous) || previous < 0 || previous > 2147483647) throw Error('invalid_busy_timeout')
      db.exec('PRAGMA busy_timeout=0')
      enteredWriter = true
      result = writer.record(event)
    } catch {
      result = { status: 'failed', reason: enteredWriter ? 'use_writer_threw' : 'busy_policy_failed', failureAudit: 'not_attempted' }
    } finally {
      if (Number.isSafeInteger(previous) && previous >= 0 && previous <= 2147483647) {
        try { db.exec(`PRAGMA busy_timeout=${previous}`) } catch {
          frozen = restoreFailed = true
        }
      }
      recording = false
    }
    if (restoreFailed) safe(onConnectionWarning, { reason: 'busy_restore_failed' })
    if (pendingFailure) {
      const failure = pendingFailure
      pendingFailure = null
      safe(onFailure, failure)
    }
    return result
  }
  const tracker = createAssociationUseTracker({ enabled: true, writeUse, onFailure: reportFailure, now })
  return { ...tracker, get enabled() { return !frozen } }
}
