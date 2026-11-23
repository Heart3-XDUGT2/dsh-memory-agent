import { createHash } from 'node:crypto'
import { ensureConsolidationCommitSchema } from './memory-consolidation-commit.js'
import { validateTypedGraphLinks } from './memory-consolidation-graph-contract.js'
import { migrationItemId, validateMemoryMigrationItem } from './memory-migration-protocol.js'

const json = value => JSON.stringify(value)
const sha = value => createHash('sha256').update(json(value)).digest('hex')
const fail = code => { throw Error(code) }

export const MEMORY_MIGRATION_RECEIPT_SCHEMA = 'echo-memory-migration-receipt/v1'

export function readMigrationSourceRow (db, selector) {
  const specs = {
    legacy_memory: ['episodic_memory', 'memory_id', ['memory_id', 'summary', 'source', 'status', 'is_active', 'superseded_by', 'occurred_at', 'timestamp', 'learned_at', 'last_recalled']],
    legacy_traffic_node: ['graph_nodes', 'node_id', ['node_id', 'name', 'node_type', 'is_active', 'superseded_by', 'owner_key']],
    legacy_traffic_edge: ['graph_edges', 'edge_id', ['edge_id', 'source_id', 'target_id', 'relation', 'is_active', 'superseded_by', 'layer', 'evidence', 'kind']]
  }
  const spec = specs[selector?.sourceKind]
  if (!spec || selector.sourceTable !== spec[0]) fail('source_kind_table_mismatch')
  const [table, key, columns] = spec
  const row = db.prepare(`SELECT ${columns.join(',')} FROM ${table} WHERE ${key} = ?`).get(selector.sourceId)
  if (!row) fail('source_row_missing')
  return row
}

export function createMemoryMigrationReceiptSchema (db) {
  ensureConsolidationCommitSchema(db)
  db.exec(`CREATE TABLE IF NOT EXISTS memory_migration_item_receipts (
    item_id TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL,
    source_table TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_snapshot TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    proposal_hash TEXT NOT NULL,
    source_graph_version TEXT NOT NULL,
    target_graph_version TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    created_at REAL NOT NULL,
    completed_at REAL NOT NULL
  )`)
}

function replay (row, proposalHash, selector) {
  if (row.proposal_hash !== proposalHash || row.source_hash !== selector.sourceHash
    || row.source_snapshot !== selector.sourceSnapshot) {
    return { schema: MEMORY_MIGRATION_RECEIPT_SCHEMA, itemId: row.item_id,
      status: 'rejected', reason: 'migration_item_conflict', commitAllowed: false }
  }
  const original = JSON.parse(row.receipt_json)
  return { ...original, status: row.status === 'committed' ? 'already_committed' : row.status,
    reason: row.status === 'committed' ? 'idempotent_replay' : row.reason, commitAllowed: false }
}

function writeReceipt (db, item, proposalHash, sourceVersion, targetVersion, status, reason, now) {
  const s = item.sourceSelector
  const receipt = { schema: MEMORY_MIGRATION_RECEIPT_SCHEMA, itemId: item.itemId,
    sourceSelector: s, proposalHash, sourceGraphVersion: sourceVersion,
    targetGraphVersion: targetVersion, status, reason, command: item.command,
    attachments: item.attachments ?? null,
    attachmentsHash: item.attachments === undefined ? null : sha(item.attachments),
    humanDecision: item.humanDecision, commitAllowed: status === 'committed' }
  db.prepare(`INSERT INTO memory_migration_item_receipts
    (item_id,source_kind,source_table,source_id,source_snapshot,source_hash,proposal_hash,
     source_graph_version,target_graph_version,status,reason,receipt_json,created_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(item_id) DO UPDATE SET proposal_hash=excluded.proposal_hash,
      source_graph_version=excluded.source_graph_version,target_graph_version=excluded.target_graph_version,
      status=excluded.status,reason=excluded.reason,receipt_json=excluded.receipt_json,
      completed_at=excluded.completed_at
    WHERE memory_migration_item_receipts.status='review'
      AND memory_migration_item_receipts.source_hash=excluded.source_hash
      AND memory_migration_item_receipts.source_snapshot=excluded.source_snapshot`)
    .run(item.itemId, s.sourceKind, s.sourceTable, s.sourceId,
    s.sourceSnapshot, s.sourceHash, proposalHash, sourceVersion, targetVersion, status, reason,
    json(receipt), now, now)
  return receipt
}

export function readCommittedSourceNodeMap (db) {
  if (!db || typeof db.prepare !== 'function') fail('db_required')
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_migration_item_receipts'`).get()
  if (!exists) return new Map()
  const rows = db.prepare(`SELECT source_id,receipt_json,status FROM memory_migration_item_receipts
    WHERE source_kind='legacy_traffic_node' AND status IN ('committed','no_work')`).all()
  const mapping = new Map()
  for (const row of rows) {
    const receipt = JSON.parse(row.receipt_json)
    const command = receipt.command
    const target = command?.op === 'create_traffic_node' ? command.nodeId
      : command?.op === 'add_traffic_alias' ? command.nodeId : null
    if (target) mapping.set(String(row.source_id), target)
  }
  return mapping
}

export function commitMemoryMigrationItem ({ db, item, sourceGraphVersion, now = Date.now() } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') fail('db_required')
  const at = Number(now)
  if (!Number.isFinite(at) || at < 0) fail('invalid_migration_time')
  if (typeof sourceGraphVersion !== 'string' || !sourceGraphVersion) fail('source_graph_version_required')
  createMemoryMigrationReceiptSchema(db)
  if (!item?.itemId || !item?.sourceSelector) fail('invalid_item')
  if (item.itemId !== migrationItemId(item.sourceSelector)) fail('item_id_selector_mismatch')
  const proposalHash = sha(item)
  const existing = db.prepare('SELECT * FROM memory_migration_item_receipts WHERE item_id = ?').get(item.itemId)
  if (existing && existing.status !== 'review') return replay(existing, proposalHash, item.sourceSelector)
  if (existing && (existing.source_hash !== item.sourceSelector.sourceHash
    || existing.source_snapshot !== item.sourceSelector.sourceSnapshot)) {
    return replay(existing, proposalHash, item.sourceSelector)
  }
  if (existing?.status === 'review') {
    const priorReceipt = JSON.parse(existing.receipt_json)
    const priorAttachmentsHash = priorReceipt.attachments === null || priorReceipt.attachments === undefined
      ? null : sha(priorReceipt.attachments)
    const nextAttachmentsHash = item.attachments === undefined ? null : sha(item.attachments)
    if (priorAttachmentsHash !== nextAttachmentsHash) {
      return { schema: MEMORY_MIGRATION_RECEIPT_SCHEMA, itemId: item.itemId,
        status: 'rejected', reason: 'review_attachment_candidates_conflict', commitAllowed: false }
    }
  }

  let opened = false
  try {
    db.exec('BEGIN IMMEDIATE'); opened = true
    const current = db.prepare('SELECT graph_version FROM memory_consolidation_meta WHERE id=1').get()?.graph_version
    if (typeof current !== 'string' || !current) fail('graph_version_missing')
    if (current !== sourceGraphVersion) fail('source_version_drift')
    const row = db.prepare('SELECT * FROM memory_migration_item_receipts WHERE item_id = ?').get(item.itemId)
    if (row && row.status !== 'review') {
      db.exec('ROLLBACK'); opened = false
      return replay(row, proposalHash, item.sourceSelector)
    }
    if (row?.status === 'review') {
      const priorReceipt = JSON.parse(row.receipt_json)
      const priorAttachmentsHash = priorReceipt.attachments === null || priorReceipt.attachments === undefined
        ? null : sha(priorReceipt.attachments)
      const nextAttachmentsHash = item.attachments === undefined ? null : sha(item.attachments)
      if (priorAttachmentsHash !== nextAttachmentsHash) fail('review_attachment_candidates_conflict')
    }
    const sourceRow = readMigrationSourceRow(db, item.sourceSelector)
    if (sha(sourceRow) !== item.sourceSelector.sourceHash) fail('source_hash_mismatch')
    const sourceNodeMap = readCommittedSourceNodeMap(db)
    for (const ref of item.evidenceRefs) {
      if (ref.sourceKind === item.sourceSelector.sourceKind && ref.sourceId === item.sourceSelector.sourceId) continue
      if (ref.sourceSnapshot !== item.sourceSelector.sourceSnapshot) fail('evidence_source_snapshot_mismatch')
      const evidenceRow = readMigrationSourceRow(db, ref)
      if (sha(evidenceRow) !== ref.sourceHash) fail('evidence_source_hash_mismatch')
    }
    for (const attachment of item.attachments ?? []) {
      const ref = attachment?.targetEvidenceRef
      if (!ref || ref.sourceSnapshot !== item.sourceSelector.sourceSnapshot) {
        fail('attachment_source_snapshot_mismatch')
      }
      const evidenceRow = readMigrationSourceRow(db, ref)
      if (sha(evidenceRow) !== ref.sourceHash) fail('attachment_source_hash_mismatch')
    }
    if (item.command?.op === 'connect_traffic_nodes') {
      const edge = sourceRow
      const endpoints = db.prepare(`SELECT node_id,is_active,superseded_by FROM graph_nodes WHERE node_id IN (?,?)`)
        .all(String(edge.source_id), String(edge.target_id))
      if (endpoints.length !== 2 || endpoints.some(row => Number(row.is_active) !== 1
        || (row.superseded_by && String(row.superseded_by) !== ''))) fail('source_edge_endpoint_inactive')
    }
    const memoryLinks = db.prepare(`SELECT memory_id,node_id,link_id FROM memory_consolidation_memory_links`).all()
    const memoryIds = new Set(memoryLinks.map(row => String(row.memory_id)))
    if (item.sourceSelector.sourceKind === 'legacy_memory') memoryIds.add(item.sourceSelector.sourceId)
    const trafficNodes = db.prepare(`SELECT node_id,canonical_name,aliases_json FROM memory_consolidation_graph_nodes
      WHERE status='active'`).all().map(row => ({ nodeId: row.node_id, canonicalName: row.canonical_name,
      aliases: JSON.parse(row.aliases_json || '[]') }))
    const trafficNodeIds = trafficNodes.map(row => row.nodeId)
    const memoryLinkRows = memoryLinks.map(row => ({
      linkId: row.link_id, memoryId: String(row.memory_id), nodeId: row.node_id
    }))
    const trafficLinks = db.prepare(`SELECT link_id,from_node_id,to_node_id FROM memory_consolidation_traffic_links`).all()
      .map(row => ({ linkId: row.link_id, from: row.from_node_id, to: row.to_node_id }))
    if (validateTypedGraphLinks({ memoryIds, trafficNodeIds, memoryNodeLinks: memoryLinkRows, trafficLinks }).length) {
      fail('invalid_typed_graph')
    }
    const validation = validateMemoryMigrationItem({ item, sourceRow,
      sourceNodeMap,
      memoryIds: [...memoryIds], trafficNodeIds, trafficNodes })
    if (validation.status === 'rejected') {
      if (item.status !== 'rejected' && !(item.status === 'review' && validation.reason === 'human_rejected')) {
        fail(validation.reason || 'item_rejected')
      }
      const receipt = writeReceipt(db, item, proposalHash, current, current, 'rejected', validation.reason || item.reason, at)
      db.exec('COMMIT'); opened = false
      return receipt
    }
    if (validation.status === 'review') {
      const receipt = writeReceipt(db, item, proposalHash, current, current, 'review', validation.reason, at)
      db.exec('COMMIT'); opened = false
      return receipt
    }
    if (item.status === 'noop') {
      const receipt = writeReceipt(db, item, proposalHash, current, current, 'no_work', item.reason, at)
      db.exec('COMMIT'); opened = false
      return receipt
    }
    const command = validation.command
    if (Array.isArray(validation.attachments) && validation.attachments.length === 0) {
      fail('empty_attachment_selection')
    }
    if (Array.isArray(validation.attachments)) {
      const insert = db.prepare(`INSERT INTO memory_consolidation_memory_links
        (memory_id,node_id,link_id,created_batch,created_at) VALUES (?,?,?,?,?)`)
      validation.attachments.forEach((attachment, index) => {
        const targetNodeId = attachment.trafficNodeId
        if (!db.prepare(`SELECT 1 FROM memory_consolidation_graph_nodes WHERE node_id=? AND status='active'`).get(targetNodeId)) {
          fail('target_node_missing')
        }
        insert.run(item.sourceSelector.sourceId, targetNodeId, `migration:${item.itemId}:${index}`, item.itemId, at)
      })
    } else if (command.op === 'attach_memory_to_node') {
      if (!db.prepare(`SELECT 1 FROM memory_consolidation_graph_nodes WHERE node_id=? AND status='active'`).get(command.nodeId)) fail('target_node_missing')
      db.prepare(`INSERT INTO memory_consolidation_memory_links
        (memory_id,node_id,link_id,created_batch,created_at) VALUES (?,?,?,?,?)`)
        .run(command.memoryId, command.nodeId, `migration:${item.itemId}`, item.itemId, at)
    } else if (command.op === 'create_traffic_node') {
      db.prepare(`INSERT INTO memory_consolidation_graph_nodes
        (node_id,canonical_name,aliases_json,status,superseded_by,created_batch,created_at)
        VALUES (?,?,?,'active','',?,?)`).run(command.nodeId, command.canonicalName,
        json(command.aliases), item.itemId, at)
    } else if (command.op === 'add_traffic_alias') {
      const row = db.prepare(`SELECT canonical_name,aliases_json FROM memory_consolidation_graph_nodes
        WHERE node_id=? AND status='active'`).get(command.nodeId)
      if (!row) fail('target_node_missing')
      const aliases = JSON.parse(row.aliases_json || '[]')
      const aliasKey = command.alias.normalize('NFKC').trim().toLocaleLowerCase()
      const alreadyKnown = String(row.canonical_name).normalize('NFKC').trim().toLocaleLowerCase() === aliasKey
        || aliases.some(alias => String(alias).normalize('NFKC').trim().toLocaleLowerCase() === aliasKey)
      if (!alreadyKnown) {
        aliases.push(command.alias)
        db.prepare(`UPDATE memory_consolidation_graph_nodes SET aliases_json=? WHERE node_id=? AND status='active'`)
          .run(json(aliases), command.nodeId)
      }
      if (alreadyKnown) {
        const receipt = writeReceipt(db, item, proposalHash, current, current, 'no_work', 'alias_already_present', at)
        db.exec('COMMIT'); opened = false
        return receipt
      }
    } else if (command.op === 'connect_traffic_nodes') {
      for (const nodeId of [command.fromNodeId, command.toNodeId]) {
        if (!db.prepare(`SELECT 1 FROM memory_consolidation_graph_nodes WHERE node_id=? AND status='active'`).get(nodeId)) fail('target_node_missing')
      }
      db.prepare(`INSERT INTO memory_consolidation_traffic_links
        (link_id,from_node_id,to_node_id,relation,created_batch,created_at) VALUES (?,?,?,?,?,?)`)
        .run(`migration:${item.itemId}`, command.fromNodeId, command.toNodeId, command.relation, item.itemId, at)
    } else fail('unknown_migration_command')
    const target = `g:migration:${sha(item.itemId).slice(0, 12)}:${proposalHash.slice(0, 16)}`
    db.prepare('UPDATE memory_consolidation_meta SET graph_version=?,updated_at=? WHERE id=1').run(target, at)
    const receipt = writeReceipt(db, item, proposalHash, current, target, 'committed', 'committed', at)
    db.exec('COMMIT'); opened = false
    return receipt
  } catch (error) {
    if (opened) { try { db.exec('ROLLBACK') } catch {} }
    const reason = ['source_row_missing', 'source_hash_mismatch', 'evidence_source_hash_mismatch',
        'evidence_source_snapshot_mismatch', 'attachment_source_hash_mismatch',
        'attachment_source_snapshot_mismatch',
        'source_edge_endpoint_inactive', 'source_version_drift',
        'graph_version_missing', 'target_node_missing', 'source_snapshot_mismatch',
        'invalid_typed_graph', 'review_attachment_candidates_conflict'].includes(error?.message)
      ? error.message : 'atomic_migration_item_failed'
    try {
      db.exec('BEGIN IMMEDIATE')
      const prior = db.prepare('SELECT 1 FROM memory_migration_item_receipts WHERE item_id=?').get(item.itemId)
      if (!prior) {
        const current = db.prepare('SELECT graph_version FROM memory_consolidation_meta WHERE id=1').get()?.graph_version || sourceGraphVersion
        writeReceipt(db, item, proposalHash, current, current, 'failed', reason, at)
      }
      db.exec('COMMIT')
    } catch {
      try { db.exec('ROLLBACK') } catch {}
    }
    return { schema: MEMORY_MIGRATION_RECEIPT_SCHEMA, itemId: item.itemId,
      status: 'failed', reason, commitAllowed: false }
  }
}
