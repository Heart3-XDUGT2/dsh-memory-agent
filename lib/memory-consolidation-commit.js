/** Preview-to-atomic-commit boundary for the isolated consolidation graph. */
import { createHash } from 'node:crypto'
import { validateConsolidationPlan } from './memory-consolidation-commands.js'
import { validateTypedGraphLinks } from './memory-consolidation-graph-contract.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const json = value => JSON.stringify(value)
const digest = value => createHash('sha256').update(json(value)).digest('hex')
const nowMs = value => {
  const result = value instanceof Date ? value.getTime() : Number(value)
  if (!Number.isFinite(result)) throw Error('invalid_commit_time')
  return result
}
const fail = reason => { throw Error(reason) }

export const CONSOLIDATION_COMMIT_SCHEMA = 'echo-consolidation-commit/v1'

export function assertConsolidationPrepared(db) {
  for (const sql of [
    'SELECT node_id,canonical_name,aliases_json,status,superseded_by,created_batch,created_at FROM memory_consolidation_graph_nodes LIMIT 0',
    'SELECT memory_id,node_id,link_id,created_batch,created_at FROM memory_consolidation_memory_links LIMIT 0',
    'SELECT link_id,from_node_id,to_node_id,relation,created_batch,created_at FROM memory_consolidation_traffic_links LIMIT 0',
    'SELECT id,graph_version,updated_at FROM memory_consolidation_meta LIMIT 0',
    'SELECT batch_id,source_graph_version,target_graph_version,status,plan_sha256,operation_count,accepted_count,rejected_count,created_at,completed_at,audit_json,attempts,last_attempt_at,window_started_at,window_attempts,error_reason FROM memory_consolidation_receipts LIMIT 0'
  ]) db.prepare(sql).all()
  const version = db.prepare('SELECT graph_version FROM memory_consolidation_meta WHERE id=1').get()?.graph_version
  if (typeof version !== 'string' || !version.trim() || version.length > 128) throw Error('graph_version_missing')
}
export function ensureConsolidationCommitSchema (db, { initialVersion = 'g0' } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw Error('db_required')
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_consolidation_graph_nodes (
      node_id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL UNIQUE,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      superseded_by TEXT NOT NULL DEFAULT '',
      created_batch TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS memory_consolidation_memory_links (
      memory_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      link_id TEXT NOT NULL UNIQUE,
      created_batch TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (memory_id, node_id)
    );
    CREATE TABLE IF NOT EXISTS memory_consolidation_traffic_links (
      link_id TEXT PRIMARY KEY,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      created_batch TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL DEFAULT 0,
      UNIQUE (from_node_id, to_node_id, relation)
    );
    CREATE TABLE IF NOT EXISTS memory_consolidation_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      graph_version TEXT NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_consolidation_receipts (
      batch_id TEXT PRIMARY KEY,
      source_graph_version TEXT NOT NULL,
      target_graph_version TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_sha256 TEXT NOT NULL,
      operation_count INTEGER NOT NULL,
      accepted_count INTEGER NOT NULL,
      rejected_count INTEGER NOT NULL,
      created_at REAL NOT NULL,
      completed_at REAL NOT NULL,
      audit_json TEXT NOT NULL
    );
  `)
  const columns = new Set(db.prepare('PRAGMA table_info(memory_consolidation_receipts)').all().map(row => row.name))
  const additions = [
    ['attempts', "INTEGER NOT NULL DEFAULT 0"],
    ['last_attempt_at', "REAL NOT NULL DEFAULT 0"],
    ['window_started_at', "TEXT NOT NULL DEFAULT ''"],
    ['window_attempts', "INTEGER NOT NULL DEFAULT 0"],
    ['error_reason', "TEXT NOT NULL DEFAULT ''"]
  ]
  for (const [name, declaration] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE memory_consolidation_receipts ADD COLUMN ${name} ${declaration}`)
  }
  const existing = db.prepare('SELECT graph_version FROM memory_consolidation_meta WHERE id = 1').get()
  if (!existing) db.prepare('INSERT INTO memory_consolidation_meta (id, graph_version, updated_at) VALUES (1, ?, ?)')
    .run(String(initialVersion), 0)
}

export function readConsolidationReceipt (db, batchId, { preparedOnly = false } = {}) {
  if (!preparedOnly) ensureConsolidationCommitSchema(db)
  return db.prepare('SELECT * FROM memory_consolidation_receipts WHERE batch_id = ?').get(batchId) ?? null
}

export function recordConsolidationFailure ({
  db, batchId, sourceGraphVersion = '', attempts = 1, lastAttemptAt = 0,
  windowStartedAt = '', windowAttempts = attempts, reason = 'failed', audit = {}, preparedOnly = false
} = {}) {
  if (preparedOnly) assertConsolidationPrepared(db)
  else ensureConsolidationCommitSchema(db, { initialVersion: sourceGraphVersion || 'g0' })
  const at = Number(lastAttemptAt)
  if (!Number.isFinite(at) || at < 0) throw Error('invalid_failure_time')
  const existing = readConsolidationReceipt(db, batchId, { preparedOnly })
  if (existing?.status === 'committed') return { status: 'already_committed', batchId }
  const now = at
  const payload = JSON.stringify({ ...audit, batchId, reason, attempts, windowAttempts })
  db.prepare(`INSERT INTO memory_consolidation_receipts
    (batch_id, source_graph_version, target_graph_version, status, plan_sha256,
     operation_count, accepted_count, rejected_count, created_at, completed_at, audit_json,
     attempts, last_attempt_at, window_started_at, window_attempts, error_reason)
    VALUES (?, ?, '', 'failed', '', 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(batch_id) DO UPDATE SET
      source_graph_version=excluded.source_graph_version,
      status='failed', completed_at=excluded.completed_at, audit_json=excluded.audit_json,
      attempts=excluded.attempts, last_attempt_at=excluded.last_attempt_at,
      window_started_at=excluded.window_started_at, window_attempts=excluded.window_attempts,
      error_reason=excluded.error_reason`)
    .run(batchId, String(sourceGraphVersion || ''), now, now, payload, attempts, at,
      String(windowStartedAt || ''), windowAttempts, String(reason))
  return { status: 'failed', batchId, attempts, reason }
}

export function recordConsolidationNoWork ({
  db, batchId, sourceGraphVersion = '', now = Date.now(), attempts = 0,
  lastAttemptAt = 0, windowStartedAt = '', windowAttempts = 0, audit = {}, preparedOnly = false
} = {}) {
  if (preparedOnly) assertConsolidationPrepared(db)
  else ensureConsolidationCommitSchema(db, { initialVersion: sourceGraphVersion || 'g0' })
  const at = nowMs(now)
  const existing = readConsolidationReceipt(db, batchId, { preparedOnly })
  if (existing?.status === 'committed' || existing?.status === 'no_work') {
    return { status: existing.status, batchId, sourceGraphVersion: existing.source_graph_version }
  }
  const payload = JSON.stringify({ ...audit, batchId, reason: 'no_work',
    attempts, windowAttempts, graphChanged: false })
  db.prepare(`INSERT INTO memory_consolidation_receipts
    (batch_id, source_graph_version, target_graph_version, status, plan_sha256,
     operation_count, accepted_count, rejected_count, created_at, completed_at, audit_json,
     attempts, last_attempt_at, window_started_at, window_attempts, error_reason)
    VALUES (?, ?, ?, 'no_work', '', 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, '')
    ON CONFLICT(batch_id) DO UPDATE SET
      source_graph_version=excluded.source_graph_version,
      target_graph_version=excluded.target_graph_version,
      status='no_work', completed_at=excluded.completed_at,
      audit_json=excluded.audit_json, attempts=excluded.attempts,
      last_attempt_at=excluded.last_attempt_at,
      window_started_at=excluded.window_started_at,
      window_attempts=excluded.window_attempts, error_reason=''`)
    .run(batchId, String(sourceGraphVersion || ''), String(sourceGraphVersion || ''),
      at, at, payload, attempts, Number(lastAttemptAt) || at,
      String(windowStartedAt || ''), windowAttempts)
  return { status: 'no_work', batchId, sourceGraphVersion: String(sourceGraphVersion || '') }
}

function currentVersion (db) {
  const row = db.prepare('SELECT graph_version FROM memory_consolidation_meta WHERE id = 1').get()
  if (!row || typeof row.graph_version !== 'string' || !row.graph_version) fail('graph_version_missing')
  return row.graph_version
}

function applyPreview (db, validation, batchId, at) {
  const addNode = db.prepare(`INSERT INTO memory_consolidation_graph_nodes
    (node_id, canonical_name, aliases_json, status, created_batch, created_at) VALUES (?, ?, ?, 'active', ?, ?)`)
  const mapNode = db.prepare(`UPDATE memory_consolidation_graph_nodes
    SET status = 'superseded', superseded_by = ? WHERE node_id = ? AND status = 'active'`)
  const addMemory = db.prepare(`INSERT INTO memory_consolidation_memory_links
    (memory_id, node_id, link_id, created_batch, created_at) VALUES (?, ?, ?, ?, ?)`)
  const removeMemory = db.prepare('DELETE FROM memory_consolidation_memory_links WHERE memory_id = ? AND node_id = ?')
  const removeTraffic = db.prepare('DELETE FROM memory_consolidation_traffic_links WHERE link_id = ?')
  const addTraffic = db.prepare(`INSERT INTO memory_consolidation_traffic_links
    (link_id, from_node_id, to_node_id, relation, created_batch, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
  let edgeNumber = 0
  for (const operation of validation.preview) {
    for (const node of operation.addNodes) addNode.run(
      node.nodeId, node.canonicalName, json(node.aliases ?? []), batchId, at)
    for (const mapping of operation.nodeMapping) mapNode.run(mapping.to, mapping.from)
    for (const link of operation.removeMemoryLinks) removeMemory.run(link.memoryId, link.nodeId)
    for (const link of operation.addMemoryLinks) addMemory.run(
      link.memoryId, link.nodeId, `memory:${batchId}:${link.memoryId}:${link.nodeId}`, batchId, at)
    for (const link of operation.removeTrafficLinks) removeTraffic.run(link.linkId)
    for (const link of operation.addTrafficLinks) {
      const id = `traffic:${batchId}:${edgeNumber++}:${digest(link).slice(0, 16)}`
      addTraffic.run(id, link.from, link.to, link.relation, batchId, at)
    }
  }
}

function checkCurrentGraph (db, validation) {
  const nodes = new Set(db.prepare(`SELECT node_id FROM memory_consolidation_graph_nodes
    WHERE status = 'active'`).all().map(row => row.node_id))
  const memoryLinks = db.prepare(`SELECT memory_id,node_id,link_id FROM memory_consolidation_memory_links`).all()
  const trafficLinks = db.prepare(`SELECT link_id,from_node_id,to_node_id FROM memory_consolidation_traffic_links`).all()
  if (validateTypedGraphLinks({ memoryIds: memoryLinks.map(row => String(row.memory_id)),
    trafficNodeIds: nodes, memoryNodeLinks: memoryLinks.map(row => ({
      linkId: row.link_id, memoryId: String(row.memory_id), nodeId: row.node_id
    })), trafficLinks: trafficLinks.map(row => ({
      linkId: row.link_id, from: row.from_node_id, to: row.to_node_id
    })) }).length) fail('graph_typed_link_invalid')
  for (const operation of validation.preview) {
    for (const node of operation.addNodes) nodes.add(node.nodeId)
  }
  for (const operation of validation.preview) {
    for (const link of operation.removeMemoryLinks) {
      if (!db.prepare(`SELECT 1 FROM memory_consolidation_memory_links
        WHERE memory_id = ? AND node_id = ?`).get(link.memoryId, link.nodeId)) fail('graph_memory_link_missing')
    }
    for (const link of operation.removeTrafficLinks) {
      if (!db.prepare('SELECT 1 FROM memory_consolidation_traffic_links WHERE link_id = ?').get(link.linkId)) {
        fail('graph_traffic_link_missing')
      }
    }
    for (const mapping of operation.nodeMapping) {
      if (!nodes.has(mapping.from) || !nodes.has(mapping.to)) fail('graph_node_mapping_missing')
    }
    for (const link of operation.addMemoryLinks) if (!nodes.has(link.nodeId)) fail('graph_target_missing')
    for (const link of operation.addTrafficLinks) {
      if (!nodes.has(link.from) || !nodes.has(link.to)) fail('graph_target_missing')
    }
  }
}

function replayReceipt (existing, batchId, sourceGraphVersion, planHash) {
  if (existing.plan_sha256 !== planHash || existing.source_graph_version !== sourceGraphVersion) {
    return receipt({ status: 'rejected', reason: 'batch_conflict', batchId, sourceGraphVersion })
  }
  return receipt({ status: existing.status === 'committed' ? 'already_committed' : 'rejected',
    reason: existing.status === 'committed' ? 'idempotent_replay' : 'prior_failed_batch',
    batchId, sourceGraphVersion, targetGraphVersion: existing.target_graph_version,
    operationCount: existing.operation_count, acceptedCount: existing.accepted_count,
    rejectedCount: existing.rejected_count, audit: JSON.parse(existing.audit_json) })
}

function receipt (input) {
  return {
    schema: CONSOLIDATION_COMMIT_SCHEMA,
    status: input.status,
    reason: input.reason,
    batchId: input.batchId,
    sourceGraphVersion: input.sourceGraphVersion,
    targetGraphVersion: input.targetGraphVersion ?? null,
    operationCount: input.operationCount ?? 0,
    acceptedCount: input.acceptedCount ?? 0,
    rejectedCount: input.rejectedCount ?? 0,
    commitAllowed: input.status === 'committed',
    audit: input.audit ?? null
  }
}

/**
 * Revalidates the complete plan, checks the current graph version inside the
 * transaction, then writes the isolated graph and receipt atomically.
 */
export function commitConsolidationPreview ({
  db, candidate, plan, batchId, sourceGraphVersion, now = Date.now(), limits = {},
  attempts = 0, lastAttemptAt = 0, windowStartedAt = '', windowAttempts = 0,
  preparedOnly = false, allowPlannedNodes = false, checkOnlineScope = null, receiptContext = null
} = {}) {
  let at
  try { at = nowMs(now) } catch { return receipt({ status: 'rejected', reason: 'invalid_commit_time', batchId: batchId ?? null }) }
  if (preparedOnly) {
    try { assertConsolidationPrepared(db) } catch { return receipt({ status: 'failed', reason: 'prepared_schema_missing', batchId }) }
    if (typeof checkOnlineScope !== 'function') return receipt({ status: 'rejected', reason: 'online_scope_required', batchId })
    if (db.isTransaction) return receipt({ status: 'failed', reason: 'transaction_already_open', batchId })
  } else ensureConsolidationCommitSchema(db, { initialVersion: sourceGraphVersion })
  if (!object(candidate) || !object(plan)) return receipt({ status: 'rejected', reason: 'input_invalid', batchId: batchId ?? null })
  if (plan.batchId !== batchId || plan.sourceGraphVersion !== sourceGraphVersion) {
    return receipt({ status: 'rejected', reason: 'preview_identity_mismatch', batchId: batchId ?? null,
      sourceGraphVersion: sourceGraphVersion ?? null })
  }
  const planHash = digest(plan)
  const existing = db.prepare('SELECT * FROM memory_consolidation_receipts WHERE batch_id = ?').get(batchId)
  if (existing?.status === 'committed') {
    return replayReceipt(existing, batchId, sourceGraphVersion, planHash)
  }
  const validation = validateConsolidationPlan({ candidate, plan, limits, allowPlannedNodes })
  if (validation.status !== 'validated') {
    return receipt({ status: 'rejected', reason: validation.reason, batchId, sourceGraphVersion,
      operationCount: Array.isArray(plan.operations) ? plan.operations.length : 0,
      acceptedCount: validation.accepted?.length ?? 0, rejectedCount: validation.rejected?.length ?? 0,
      audit: { validation } })
  }
  const audit = {
    batchId, sourceGraphVersion, planSha256: planHash, operationCount: plan.operations.length,
    acceptedCount: validation.accepted.length, rejectedCount: validation.rejected.length,
    writes: validation.preview.reduce((sum, item) => sum + item.addNodes.length + item.addMemoryLinks.length
      + item.removeMemoryLinks.length + item.addTrafficLinks.length + item.removeTrafficLinks.length
      + item.nodeMapping.length, 0),
    memoryContentChanged: false, attempts, windowAttempts,
    ...(preparedOnly ? { online: receiptContext } : {})
  }
  const targetGraphVersion = `g:${batchId}:${planHash.slice(0, 16)}`
  try {
    db.exec('BEGIN IMMEDIATE')
    const insideReceipt = db.prepare('SELECT * FROM memory_consolidation_receipts WHERE batch_id = ?').get(batchId)
    if (insideReceipt?.status === 'committed') {
      db.exec('ROLLBACK')
      return replayReceipt(insideReceipt, batchId, sourceGraphVersion, planHash)
    }
    if (insideReceipt?.status === 'failed') {
      db.prepare('DELETE FROM memory_consolidation_receipts WHERE batch_id = ?').run(batchId)
    }
    const inside = currentVersion(db)
    if (inside !== sourceGraphVersion) {
      db.exec('ROLLBACK')
      return receipt({ status: 'rejected', reason: 'source_version_drift', batchId, sourceGraphVersion,
        audit: { ...audit, currentGraphVersion: inside } })
    }
    if (preparedOnly) checkOnlineScope(db, validation)
    else checkCurrentGraph(db, validation)
    applyPreview(db, validation, batchId, at)
    db.prepare('UPDATE memory_consolidation_meta SET graph_version = ?, updated_at = ? WHERE id = 1')
      .run(targetGraphVersion, at)
    db.prepare(`INSERT INTO memory_consolidation_receipts
      (batch_id, source_graph_version, target_graph_version, status, plan_sha256,
       operation_count, accepted_count, rejected_count, created_at, completed_at, audit_json,
       attempts, last_attempt_at, window_started_at, window_attempts, error_reason)
      VALUES (?, ?, ?, 'committed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`)
      .run(batchId, sourceGraphVersion, targetGraphVersion, planHash, plan.operations.length,
        validation.accepted.length, validation.rejected.length, at, at, json(audit),
        attempts, Number(lastAttemptAt) || at, String(windowStartedAt || ''), windowAttempts)
    db.exec('COMMIT')
    return receipt({ status: 'committed', reason: 'committed', batchId, sourceGraphVersion,
      targetGraphVersion, operationCount: plan.operations.length,
      acceptedCount: validation.accepted.length, rejectedCount: validation.rejected.length, audit })
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    if (preparedOnly && ['body_snapshot_changed', 'scope_changed', 'source_budget', 'name_catalog_incomplete', 'name_collision'].includes(error?.message)) {
      return receipt({ status: 'rejected', reason: error.message, batchId, sourceGraphVersion })
    }
    const reason = ['graph_target_missing', 'graph_memory_link_missing', 'graph_traffic_link_missing',
      'graph_node_mapping_missing', 'graph_version_missing', 'graph_typed_link_invalid'].includes(error?.message)
      ? error.message : 'atomic_commit_failed'
    return receipt({ status: 'failed', reason, batchId, sourceGraphVersion,
      operationCount: plan.operations.length, acceptedCount: validation.accepted.length,
      rejectedCount: validation.rejected.length,
      audit: { ...audit, error: String(error?.message || 'commit_failed').slice(0, 160), failureReason: reason } })
  }
}
