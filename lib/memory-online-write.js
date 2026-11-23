import { createHash } from 'node:crypto'
import { createDshConsolidationCaller } from './memory-consolidation-dsh-caller.js'
import { COMMAND_SCHEMA, validateConsolidationPlan } from './memory-consolidation-commands.js'
import { assertConsolidationPrepared, commitConsolidationPreview, readConsolidationReceipt,
  recordConsolidationNoWork, recordConsolidationFailure } from './memory-consolidation-commit.js'
import { createConsolidationCandidateSource } from './memory-consolidation-source.js'
import { RETRIEVAL_BOUNDS } from './memory-consolidation-retrieval.js'

export const ONLINE_WRITE_LIMITS = Object.freeze({
  targets: 8, background: 8, nodes: 32, edges: 48, operations: 16, newNodes: 4,
  nameRows: 512, nameBytes: 262144, promptBytes: 32768, timeoutMs: 15000,
  memoryBytes: 8192, memoryTotalBytes: 32768, localBytes: 32768
})
export const ONLINE_WRITE_SHAPE = Object.freeze({
  scope: 'process', enabled: false, preparation: 'not_initialized', connectionWarning: null,
  bodyConfirmed: 0, pending: 0, committed: 0, noWork: 0, rejected: 0, failed: 0, replayed: 0,
  lastStatus: null, lastReason: null, lastAtMs: null, lastConfirmed: null,
  lastEligible: null, lastAssociated: null, lastUnlinked: null, lastReceiptPersisted: null,
  lastRejectedReason: null, lastRejectedValidationReason: null, lastRejectedOperationIndex: null,
  lastRejectedCount: null, lastRejectedAtMs: null
})
const allowed = ['create_candidate_traffic_node', 'attach_memory_to_node', 'connect_traffic_nodes']
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const marks = values => values.map(() => '?').join(',')
const key = name => name.normalize('NFKC').trim().toLowerCase()
const fail = reason => { throw Error(reason) }
const origins = new WeakMap()
const validId = id => (typeof id === 'string' || Number.isSafeInteger(id)) && String(id).length > 0
  && String(id).length <= 128 && !/[\u0000-\u001f\u007f]/u.test(String(id))
const live = row => row?.user_id === 'master' && row.is_active === 1 && [null, 'active'].includes(row.status)
  && ['', '0'].includes(String(row.superseded_by ?? '')) && typeof row.summary === 'string' && row.summary.trim()
const safe = (callback, value) => { try { callback?.(value) } catch {} }
const memoryHash = rows => hash([...rows].sort((a, b) => String(a.memory_id).localeCompare(String(b.memory_id))))
const graphHashOf = (nodes, attachments, links) => hash([
  [...nodes].sort((a, b) => a.node_id.localeCompare(b.node_id)),
  [...attachments].sort((a, b) => a.link_id.localeCompare(b.link_id)),
  [...links].sort((a, b) => a.link_id.localeCompare(b.link_id))
])
const validationReasons = new Set([
  'invalid_operation', 'unknown_operation', 'unknown_field', 'missing_field', 'invalid_id', 'invalid_text',
  'invalid_array', 'invalid_id_list', 'invalid_confidence', 'invalid_json', 'invalid_json_value', 'invalid_input',
  'input_budget_exceeded', 'invalid_plan_schema', 'batch_mismatch', 'source_version_mismatch', 'operation_limit',
  'evidence_outside_scope', 'evidence_missing', 'evidence_not_declared', 'evidence_span_mismatch',
  'memory_outside_scope', 'target_memory_evidence_missing', 'node_outside_scope', 'new_node_id_exists',
  'new_node_name_exists', 'new_node_name_without_evidence', 'node_mention_evidence_missing',
  'memory_link_already_exists', 'traffic_link_already_exists', 'connection_evidence_missing',
  'self_connection', 'unsupported_relation', 'duplicate_operation_id', 'duplicate_or_conflicting_operation',
  'duplicate_new_node', 'edge_limit', 'new_node_limit'
])

/** Opaque trusted identity; only primitive IDs/hashes go into the work key, never the session into a prompt. */
export function captureOnlineIdentity(session, event = null, callId = null) {
  try {
    if (!session || typeof session.id !== 'string' || typeof session.eventAt !== 'function') return null
    let start = event, call
    if (callId !== null) {
      if (!validId(callId)) return null
      const events = session.snapshotEvents(Math.max(0, session.seq - 256))
      const matches = events.filter(e => e.type === 'assistant/message'
        && e.data?.message?.content?.some(block => block.type === 'tool-call' && block.id === callId))
      call = matches.at(-1)
      if (!call || session.eventAt(call.seq) !== call) return null
      start = events.find(e => e.type === 'turn/start' && e.data?.turn === call.data.turn && e.seq < call.seq)
    }
    if (start?.type !== 'turn/start' || !Number.isSafeInteger(start.seq)
      || !Number.isSafeInteger(start.data?.turn) || session.eventAt(start.seq) !== start) return null
    const identity = Object.freeze({ kind: callId === null ? 'extract' : 'teach', sessionId: session.id,
      startSeq: start.seq, turn: start.data.turn, ...(callId === null ? {} : { callId: String(callId) }) })
    origins.set(identity, { session, start, call })
    return identity
  } catch { return null }
}
function proven(identity) {
  const ref = origins.get(identity)
  return ref && ref.session.eventAt(identity.startSeq) === ref.start
    && (!ref.call || ref.session.eventAt(ref.call.seq) === ref.call)
}
function confirmedIds(receipt) {
  const raw = Array.isArray(receipt?.written) ? receipt.written.map(row => row?.memoryId)
    : receipt?.memoryId ? [receipt.memoryId] : []
  if (raw.length > 64 || raw.some(id => !validId(id))) fail('invalid_body_receipt')
  return [...new Set(raw.map(String))].sort()
}
const reasons = new Set(['missing_native_identity', 'invalid_body_receipt', 'target_budget', 'body_snapshot_changed',
  'no_eligible_memory', 'no_successful_memory', 'source_version_drift', 'scope_changed', 'name_catalog_incomplete',
  'name_collision', 'ambiguous_name', 'inactive_name', 'new_id_not_allocated', 'generic_role_node',
  'forbidden_operation', 'other_memory_write', 'unattached_new_node', 'source_budget', 'prompt_budget',
  'no_route', 'online_busy', 'input_conflict', 'model_empty_plan', 'receipt_replay', 'online_not_prepared',
  'caller_timeout', 'caller_aborted', 'route_unconfigured', 'channel_disabled', 'provider_timeout',
  'provider_max_tokens', 'model_invalid_json', 'dsh_structured_failed', 'atomic_commit_failed',
  'transaction_already_open', 'receipt_persist_unavailable', 'graph_query_failed', 'plan_rejected'])

export function createOnlineMemoryWriter({
  db, channel, onResult = null, audit = null, now = Date.now, maintenance = null
} = {}) {
  const stats = { ...ONLINE_WRITE_SHAPE }
  let source, busy = false, pendingKey = null, pendingHash = null, pendingPromise = null, frozen = false
  let activeContext = null
  try {
    assertConsolidationPrepared(db)
    db.prepare(`SELECT memory_id,user_id,summary,is_active,status,superseded_by,source,
      occurred_at,timestamp,learned_at,last_recalled FROM episodic_memory LIMIT 0`).all()
    source = createConsolidationCandidateSource({ db, preparedOnly: true })
    if (typeof channel?.runStructured !== 'function') throw Error('no_channel')
    stats.enabled = true; stats.preparation = 'ready'
  } catch { stats.preparation = 'unavailable' }
  const finish = (status, reason, counts, persisted = false, replay = false, diagnostic = null) => {
    const field = status === 'no_work' ? 'noWork' : status
    if (replay) stats.replayed++
    else if (Object.hasOwn(stats, field) && typeof stats[field] === 'number') stats[field]++
    Object.assign(stats, { lastStatus: status, lastReason: reason, lastAtMs: now(),
      lastConfirmed: counts.confirmed, lastEligible: counts.eligible,
      lastAssociated: counts.associated, lastUnlinked: null,
      lastReceiptPersisted: persisted })
    if (status === 'rejected' && !replay) Object.assign(stats, {
      lastRejectedReason: reasons.has(reason) ? reason : 'plan_rejected',
      lastRejectedValidationReason: diagnostic?.reason ?? null,
      lastRejectedOperationIndex: diagnostic?.index ?? null,
      lastRejectedCount: diagnostic?.count ?? null, lastRejectedAtMs: stats.lastAtMs
    })
    let result = { status, reason, confirmed: counts.confirmed, eligible: counts.eligible,
      associated: counts.associated, unlinked: stats.lastUnlinked, receiptPersisted: persisted, replay }
    result.onlineStatus = replay && status === 'committed' ? 'already_committed'
      : ['committed', 'no_work', 'rejected', 'failed', 'skipped'].includes(status) ? status : 'unknown'
    result.targetCount = counts.confirmed
    result.operationCount = Number.isSafeInteger(activeContext?.operationCount) ? activeContext.operationCount : null
    result.validationReason = diagnostic?.reason ?? activeContext?.validation?.reason ?? null
    result.receiptStatus = persisted ? (replay && status === 'committed' ? 'already_committed' : status) : 'unknown'
    result.batchKeyHash = activeContext?.batchKeyHash || null
    result.sourceVersionHash = activeContext?.sourceVersionHash || null
    if (status === 'rejected' && !replay) Object.assign(result, {
      validationReason: stats.lastRejectedValidationReason, validationOperationIndex: stats.lastRejectedOperationIndex,
      validationRejectedCount: stats.lastRejectedCount, validationAtMs: stats.lastRejectedAtMs
    })
    if (audit) {
      const recorded = !frozen && stats.preparation === 'ready'
        ? synchronousWrite(() => ({ status: audit(result) === false ? 'audit_unavailable' : 'audit_written' })) : null
      result = { ...result, auditPersisted: recorded?.status === 'audit_written' }
    }
    safe(onResult, result)
    return result
  }
  const maintenanceRejected = reason => ({
    status: 'skipped', reason, confirmed: 0, eligible: null, associated: 0,
    unlinked: null, receiptPersisted: false, replay: false
  })
  const settleMaintenance = (token, result, error = null) => {
    if (token === null || typeof maintenance !== 'object') return
    const unknown = error !== null
      || result?.status === 'unknown'
      || (result?.status === 'failed' && result?.receiptPersisted !== true)
    try { (unknown ? maintenance.unknown : maintenance.complete)(token) } catch {}
  }
  function memoryRows(ids) {
    if (!ids.length) return []
    const stmt = db.prepare(`SELECT memory_id,
      CASE WHEN length(CAST(user_id AS BLOB))<=128 THEN user_id ELSE NULL END user_id,
      CASE WHEN length(CAST(summary AS BLOB))<=8192 THEN summary ELSE NULL END summary,
      length(CAST(summary AS BLOB)) summary_bytes,is_active,
      CASE WHEN length(CAST(status AS BLOB))<=128 THEN status ELSE NULL END status,
      CASE WHEN length(CAST(superseded_by AS BLOB))<=128 THEN superseded_by ELSE NULL END superseded_by,
      CASE WHEN length(CAST(user_id AS BLOB))>128 OR length(CAST(status AS BLOB))>128
        OR length(CAST(superseded_by AS BLOB))>128 THEN 1 ELSE 0 END metadata_over
      FROM episodic_memory WHERE memory_id IN (${marks(ids)}) LIMIT ?`)
    const rows = []
    let total = 0
    for (const row of stmt.iterate(...ids, 16)) {
      total += row.summary_bytes || 0
      if (row.metadata_over || row.summary_bytes > ONLINE_WRITE_LIMITS.memoryBytes || total > ONLINE_WRITE_LIMITS.memoryTotalBytes) fail('source_budget')
      rows.push(row)
    }
    return rows
  }
  function catalogue() {
    const result = db.prepare(`WITH slice AS MATERIALIZED (
      SELECT CASE WHEN length(CAST(node_id AS BLOB))<=512 THEN node_id ELSE NULL END node_id,
        length(CAST(node_id AS BLOB))+length(CAST(canonical_name AS BLOB))+length(CAST(aliases_json AS BLOB))
        +length(CAST(status AS BLOB))+length(CAST(superseded_by AS BLOB)) row_bytes,
        CASE WHEN length(CAST(node_id AS BLOB))>512 OR typeof(node_id)<>'text'
          OR typeof(canonical_name)<>'text' OR typeof(aliases_json)<>'text'
          OR typeof(status)<>'text' OR typeof(superseded_by)<>'text' THEN 1 ELSE 0 END invalid
      FROM memory_consolidation_graph_nodes ORDER BY node_id LIMIT ?
    ), size AS (SELECT COUNT(*) n,COALESCE(SUM(row_bytes),0) bytes,COALESCE(SUM(invalid),0) bad FROM slice)
    SELECT 0 marker,NULL node_id,NULL canonical_name,NULL aliases_json,NULL status,NULL superseded_by,n,bytes,bad FROM size
    UNION ALL SELECT 1,g.node_id,g.canonical_name,g.aliases_json,g.status,g.superseded_by,n,bytes,bad
      FROM size CROSS JOIN slice CROSS JOIN memory_consolidation_graph_nodes g ON g.node_id=slice.node_id
      WHERE n<=? AND bytes<=? AND bad=0
    ORDER BY marker,node_id LIMIT ?`).all(ONLINE_WRITE_LIMITS.nameRows + 1, ONLINE_WRITE_LIMITS.nameRows,
      ONLINE_WRITE_LIMITS.nameBytes, ONLINE_WRITE_LIMITS.nameRows + 1)
    const complete = !result[0].bad && result[0].n <= ONLINE_WRITE_LIMITS.nameRows && result[0].bytes <= ONLINE_WRITE_LIMITS.nameBytes
    if (!complete) return { complete: false, rows: [], hash: null }
    const rows = result.slice(1).map(({ marker, n, bytes, bad, ...row }) => row)
    const parsed = rows.map(row => {
      const aliases = JSON.parse(row.aliases_json)
      if (!Array.isArray(aliases) || aliases.some(name => typeof name !== 'string') || aliases.length > 128) fail('graph_query_failed')
      return { ...row, aliases }
    })
    return { complete: true, rows: parsed, hash: hash(rows) }
  }
  function scopedGraph(nodeIds, memoryIds) {
    const budget = { bytes: 0 }
    const read = (table, fields, where, params, maximum) => {
      const bytes = fields.map(field => `COALESCE(length(CAST(${field} AS BLOB)),0)`).join('+')
      const selected = fields.map(field => `CASE WHEN (${bytes})<=32768 THEN ${field} ELSE NULL END ${field}`).join(',')
      const statement = db.prepare(`SELECT ${selected},(${bytes}) scope_bytes FROM ${table} WHERE ${where} LIMIT ?`)
      const rows = []
      for (const row of statement.iterate(...params, maximum + 1)) {
        budget.bytes += row.scope_bytes
        if (rows.length >= maximum || budget.bytes > ONLINE_WRITE_LIMITS.localBytes) fail('source_budget')
        const { scope_bytes, ...data } = row
        rows.push(data)
      }
      return rows
    }
    const nodes = nodeIds.length ? read('memory_consolidation_graph_nodes',
      ['node_id', 'canonical_name', 'aliases_json', 'status', 'superseded_by'],
      `node_id IN (${marks(nodeIds)})`, nodeIds, ONLINE_WRITE_LIMITS.nodes)
      .filter(row => row.status === 'active' && ['', '0'].includes(String(row.superseded_by || ''))) : []
    const active = nodes.map(row => row.node_id)
    const attachments = active.length ? read('memory_consolidation_memory_links', ['memory_id', 'node_id', 'link_id'],
      `memory_id IN (${marks(memoryIds)}) AND node_id IN (${marks(active)})`,
      [...memoryIds, ...active], ONLINE_WRITE_LIMITS.edges) : []
    const links = active.length ? read('memory_consolidation_traffic_links', ['link_id', 'from_node_id', 'to_node_id', 'relation'],
      `from_node_id IN (${marks(active)}) AND to_node_id IN (${marks(active)})`,
      [...active, ...active], ONLINE_WRITE_LIMITS.edges) : []
    if (attachments.length + links.length > ONLINE_WRITE_LIMITS.edges) fail('source_budget')
    return { nodes, attachments, links }
  }
  function synchronousWrite(fn) {
    if (db.isTransaction) return { status: 'failed', reason: 'transaction_already_open', persisted: false }
    let timeout, result
    try {
      timeout = db.prepare('PRAGMA busy_timeout').get().timeout
      if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2147483647) throw Error('bad_timeout')
      db.exec('PRAGMA busy_timeout=0')
      result = fn()
    } catch (error) {
      result = { status: 'failed', reason: reasons.has(error?.message) ? error.message : 'receipt_persist_unavailable', persisted: false }
    }
    finally {
      if (Number.isSafeInteger(timeout) && timeout >= 0 && timeout <= 2147483647) {
        try { db.exec(`PRAGMA busy_timeout=${timeout}`) } catch {
          frozen = true; stats.enabled = false; stats.connectionWarning = 'busy_restore_failed'
        }
      }
    }
    return result
  }
  function namespaceCheck(plan, names, allocated) {
    for (const operation of plan.operations) if (operation.op === 'create_candidate_traffic_node') {
      if (!allocated.includes(operation.newNodeId)) fail('new_id_not_allocated')
      if (!names.complete) fail('name_catalog_incomplete')
      const normalized = key(operation.canonicalName)
      if (['user', 'master', 'owner', '用户', '主人', '我'].includes(normalized)) fail('generic_role_node')
      const collisions = names.rows.filter(row => [row.canonical_name, ...row.aliases].some(name => key(name) === normalized))
      if (collisions.length) fail('name_collision')
    }
  }
  async function execute(input, ids, targetRows, inputHash, batchId, counts) {
    let version = '', guard = null, diagnostic = null
    activeContext = { inputHash, confirmed: counts.confirmed, eligible: counts.eligible, associated: 0 }
    const context = activeContext
    const persist = (status, reason) => synchronousWrite(() => {
      db.exec('BEGIN IMMEDIATE')
      try {
        if (guard && status === 'no_work') guard(db)
        const audit = { online: context }
        const result = status === 'no_work'
          ? recordConsolidationNoWork({ db, batchId, sourceGraphVersion: version, now: now(), audit, preparedOnly: true })
          : recordConsolidationFailure({ db, batchId, sourceGraphVersion: version, now: now(), reason, audit, preparedOnly: true })
        db.exec('COMMIT')
        return { ...result, persisted: result.status === status }
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
    try {
      if (!input.route?.provider || !input.route?.model) fail('no_route')
      const route = Object.freeze({ provider: input.route.provider, model: input.route.model })
      version = db.prepare('SELECT graph_version FROM memory_consolidation_meta WHERE id=1').get()?.graph_version
      context.batchKeyHash = hash(batchId)
      context.sourceVersionHash = typeof version === 'string' ? hash(version) : null
      const backgroundIds = [...new Set((input.writerContext?.memories || [])
        .map(row => String(row.memoryId)).filter(id => validId(id) && !ids.includes(id)))]
        .slice(0, RETRIEVAL_BOUNDS.seeds + RETRIEVAL_BOUNDS.memories)
      const paths = input.writerContext?.schema === 'echo-writer-memory-context/v1' ? input.writerContext.paths || [] : []
      const pathTargets = new Set(paths.filter(path => Array.isArray(path.linkIds) && path.linkIds.length)
        .map(path => String(path.memoryId)))
      const selectedIds = backgroundIds.filter(id => pathTargets.has(id))
      const selectedRows = memoryRows(selectedIds).filter(live)
      const selectedById = new Map(selectedRows.map(row => [String(row.memory_id), row]))
      const selected = selectedIds.map(id => selectedById.get(id)).filter(Boolean)
        .slice(0, ONLINE_WRITE_LIMITS.background)
      const selectedSet = new Set(selected.map(row => String(row.memory_id)))
      const remainingIds = backgroundIds.filter(id => !selectedSet.has(id))
        .slice(0, ONLINE_WRITE_LIMITS.background - selected.length)
      const remaining = memoryRows(remainingIds).filter(live)
      const rowsById = new Map(remaining.map(row => [String(row.memory_id), row]))
      const background = [...selected, ...remainingIds.map(id => rowsById.get(id)).filter(Boolean)]
      const all = [...targetRows, ...background]
      if (all.reduce((sum, row) => sum + (row.summary_bytes || 0), 0) > ONLINE_WRITE_LIMITS.memoryTotalBytes) fail('source_budget')
      const names = catalogue()
      const contextNodeIds = (input.writerContext?.trafficNodes || []).map(row => String(row.nodeId)).filter(validId)
      const mentioned = names.rows.filter(row => row.status === 'active' && all.some(memory =>
        [row.canonical_name, ...row.aliases].some(name => key(memory.summary).includes(key(name))))).map(row => row.node_id)
      const nodeIds = [...new Set([...contextNodeIds, ...mentioned])]
      if (nodeIds.length > ONLINE_WRITE_LIMITS.nodes) fail('source_budget')
      const memoryIds = all.map(row => String(row.memory_id))
      const { nodes, attachments, links } = scopedGraph(nodeIds, memoryIds)
      const projected = await source.readMemories({ memoryIds, limit: 16 })
      if (!projected.complete || projected.rows.some(row => all.find(memory => String(memory.memory_id) === row.memoryId)?.summary !== row.summary)) fail('body_snapshot_changed')
      if (await source.readGraphVersion() !== version) fail('source_version_drift')
      const graphHash = graphHashOf(nodes, attachments, links)
      const frozenMemories = memoryHash(all)
      const proof = { readId: 0, sha256: hash([all, nodes, attachments, links]) }
      const candidate = { schema: 'echo-consolidation-candidates/v1', readOnly: true, status: 'ok', batchId,
        graphVersion: version, issues: [], truncation: [], sourceEvidence: [proof],
        scope: { includedMemoryIds: memoryIds },
        memories: all.map(row => ({ memoryId: String(row.memory_id), summary: row.summary, status: 'active', evidence: { readId: 0 } })),
        trafficNodes: nodes.map(row => ({ nodeId: row.node_id, canonicalName: row.canonical_name,
          aliases: JSON.parse(row.aliases_json), status: 'active', evidence: { readId: 0 } })),
        memoryNodeLinks: attachments.map(row => ({ linkId: row.link_id, memoryId: String(row.memory_id), nodeId: row.node_id, evidence: { readId: 0 } })),
        trafficLinks: links.map(row => ({ linkId: row.link_id, from: row.from_node_id, to: row.to_node_id, relation: row.relation, evidence: { readId: 0 } })) }
      const allocated = Array.from({ length: ONLINE_WRITE_LIMITS.newNodes }, (_, index) => `online-node:${batchId.slice(-40)}:${index}`)
      guard = () => {
        if (db.prepare('SELECT graph_version FROM memory_consolidation_meta WHERE id=1').get()?.graph_version !== version) fail('source_version_drift')
        if (memoryHash(memoryRows(memoryIds)) !== frozenMemories) fail('body_snapshot_changed')
        const current = scopedGraph(nodeIds, memoryIds)
        if (graphHashOf(current.nodes, current.attachments, current.links) !== graphHash) fail('scope_changed')
      }
      const prompt = JSON.stringify({ schema: COMMAND_SCHEMA, batchId, sourceGraphVersion: version,
        allowedTargetMemoryIds: targetRows.map(row => String(row.memory_id)), allocatedNewNodeIds: allocated,
        canCreateNewNodes: names.complete,
        limits: { maxTargets: ONLINE_WRITE_LIMITS.targets, maxNodes: ONLINE_WRITE_LIMITS.nodes,
          maxOperations: ONLINE_WRITE_LIMITS.operations, maxNewNodes: ONLINE_WRITE_LIMITS.newNodes },
        instructions: [
          'Copy the input root-level batchId and sourceGraphVersion EXACTLY into the response root-level fields. Do not summarize, format, trim, or rewrite either value.',
          'Stable topic domains and descriptions of ongoing projects are valid Traffic subjects; a proper name is NOT required.',
          'A create followed by attach is sufficient: no old Memory or extra connect operation is required.',
          'Do not mechanically split keywords, create an owner hub, or turn a temporary failure/emotion into a topic.',
          'Do not guess that an old project, a new project, or an unnamed team is the same entity.',
          'wholeSummaryEvidence is an OPTIONAL evidence catalogue, NOT a checklist to copy in full. Choose evidence independently for EACH operation.',
          'Copy ONLY the chosen wholeSummaryEvidence entries verbatim into that operation evidenceSpans, including text and HOST-computed UTF-16 end. Do not count offsets yourself.',
          'For create_candidate_traffic_node, include only supporting memories in evidenceMemoryIds/evidenceSpans: EVERY listed memory must have a cited span containing the canonicalName (existing NFKC/case normalization applies).',
          'Do not add background-only memories that lack that name to a create operation evidence set. If no cited memory contains the canonicalName, do not create that node; do not guess aliases or force an association.',
          'Background can help association without being create evidence. If a background memory also contains the canonicalName literally, it may be included as additional supporting create evidence; this does not authorize attaching that background Memory.',
          'Copy allocatedNewNodeIds exactly. Create an ID BEFORE any attach/connect references it.',
          'All operations still need operationId, reason, confidence, evidenceMemoryIds and evidenceSpans.',
          'Only allowedTargetMemoryIds may receive attachments. Return operations: [] when choosing not to propose a supported association.'
        ].join('\n'),
        operationOrderExample: ['create allocatedNewNodeIds[0]', 'attach target to allocatedNewNodeIds[0]',
          'create allocatedNewNodeIds[1]', 'attach target to allocatedNewNodeIds[1]'],
        evidenceSelectionExample: {
          note: 'Synthetic illustration only; use actual supplied IDs and evidence. A is a target; B is readable background without Orchid. Each operation selects its own evidence.',
          memories: [{ memoryId: 'A', summary: 'Orchid' }, { memoryId: 'B', summary: 'Garden' }],
          operations: [
            { operationId: 'example-create', op: 'create_candidate_traffic_node', reason: 'A names Orchid',
              confidence: 0.9, newNodeId: 'EXAMPLE_ALLOCATED_ID', canonicalName: 'Orchid',
              evidenceMemoryIds: ['A'], evidenceSpans: [{ memoryId: 'A', start: 0, end: 6, text: 'Orchid' }] },
            { operationId: 'example-attach', op: 'attach_memory_to_node', reason: 'Attach target A using its own supporting evidence',
              confidence: 0.9, memoryId: 'A', nodeId: 'EXAMPLE_ALLOCATED_ID',
              evidenceMemoryIds: ['A'], evidenceSpans: [{ memoryId: 'A', start: 0, end: 6, text: 'Orchid' }] }
          ]
        },
        wholeSummaryEvidence: all.map(row => ({ memoryId: String(row.memory_id), start: 0,
          end: row.summary.length, text: row.summary })),
        candidate })
      if (Buffer.byteLength(prompt) > ONLINE_WRITE_LIMITS.promptBytes) fail('prompt_budget')
      const caller = createDshConsolidationCaller({ channel, getRoute: () => route, timeoutMs: ONLINE_WRITE_LIMITS.timeoutMs,
        maxOutputTokens: 2048, maxOutputBytes: 16384, allowedOperations: allowed, maxOperations: ONLINE_WRITE_LIMITS.operations })
      const response = await caller({ schema: COMMAND_SCHEMA, prompt })
      const limits = { maxOperations: ONLINE_WRITE_LIMITS.operations, maxNewNodes: ONLINE_WRITE_LIMITS.newNodes, maxEdges: ONLINE_WRITE_LIMITS.edges }
      const validated = validateConsolidationPlan({ candidate, plan: response, limits, allowPlannedNodes: true })
      if (validated.status !== 'validated') {
        const first = validated.rejected[0]
        const code = first?.reason ?? validated.reason
        diagnostic = { reason: validationReasons.has(code) ? code : 'unrecognized_validation',
          index: Number.isSafeInteger(first?.index) && first.index >= 0 && first.index < 1024 ? first.index : null,
          count: validated.rejected.length ? validated.rejected.length : null }
        context.validation = diagnostic
      }
      if (!names.complete && validated.accepted.some(row => row.command.op === 'create_candidate_traffic_node')) fail('name_catalog_incomplete')
      if (validated.status !== 'validated') {
        if (validated.rejected.some(row => row.reason === 'new_node_name_exists')) fail('name_collision')
        fail('plan_rejected')
      }
      const plan = { schema: COMMAND_SCHEMA, batchId, sourceGraphVersion: version, operations: validated.accepted.map(row => row.command) }
      context.operationCount = plan.operations.length
      if (plan.operations.some(op => !allowed.includes(op.op))) fail('forbidden_operation')
      const targetSet = new Set(targetRows.map(row => String(row.memory_id)))
      if (plan.operations.some(op => op.op === 'attach_memory_to_node' && !targetSet.has(op.memoryId))) fail('other_memory_write')
      namespaceCheck(plan, names, allocated)
      const created = validated.preview.flatMap(row => row.addNodes), added = validated.preview.flatMap(row => row.addMemoryLinks)
      if (created.some(node => !added.some(link => link.nodeId === node.nodeId && targetSet.has(link.memoryId)))) fail('unattached_new_node')
      counts.associated = new Set(added.filter(link => targetSet.has(link.memoryId)).map(link => link.memoryId)).size
      context.associated = counts.associated
      if (!plan.operations.length) {
        context.outcome = 'no_work'
        const receipt = persist('no_work', 'model_empty_plan')
        if (receipt.status !== 'no_work') {
          const rejected = ['body_snapshot_changed', 'scope_changed', 'source_version_drift', 'source_budget'].includes(receipt.reason)
          context.outcome = rejected ? 'rejected' : 'failed'
          const failedReceipt = persist('failed', receipt.reason)
          return finish(context.outcome, receipt.reason, counts, failedReceipt.persisted === true)
        }
        return finish('no_work', 'model_empty_plan', counts, receipt.persisted === true)
      }
      context.outcome = 'committed'
      const committed = synchronousWrite(() => commitConsolidationPreview({ db, candidate, plan, batchId,
        sourceGraphVersion: version, preparedOnly: true, allowPlannedNodes: true, receiptContext: context,
        checkOnlineScope: () => {
          guard()
          if (created.length) {
            const current = catalogue()
            if (!current.complete) fail('name_catalog_incomplete')
            namespaceCheck(plan, current, allocated)
          }
        }, limits, now: now() }))
      if (!['committed', 'already_committed'].includes(committed.status)) {
        counts.associated = 0
        context.associated = 0
        context.outcome = committed.status === 'rejected' ? 'rejected' : 'failed'
        const reason = reasons.has(committed.reason) ? committed.reason : 'atomic_commit_failed'
        const receipt = persist('failed', reason)
        return finish(committed.status === 'rejected' ? 'rejected' : 'failed', reason, counts, receipt.persisted === true, false, diagnostic)
      }
      return finish('committed', null, counts, true, committed.status === 'already_committed')
    } catch (error) {
      counts.associated = 0
      context.associated = 0
      const reason = reasons.has(error?.message) ? error.message : 'graph_query_failed'
      const rejected = ['plan_rejected', 'forbidden_operation', 'other_memory_write', 'unattached_new_node',
        'name_collision', 'new_id_not_allocated', 'generic_role_node', 'name_catalog_incomplete'].includes(reason)
      context.outcome = rejected ? 'rejected' : 'failed'
      const receipt = persist('failed', reason)
      return finish(rejected ? 'rejected' : 'failed', reason, counts, receipt.persisted === true, false, diagnostic)
    }
  }
  return {
    stats: () => ({ ...stats }),
    run(input = {}) {
      let token = null
      if (maintenance !== null) {
        let admission
        try { admission = maintenance.admit('online_memory_writer') } catch {
          return Promise.resolve(maintenanceRejected('maintenance_unavailable'))
        }
        if (admission?.accepted !== true) {
          return Promise.resolve(maintenanceRejected(admission?.reason || 'maintenance_closed'))
        }
        token = admission.token ?? null
      }
      const settle = value => Promise.resolve(value).then(result => {
        settleMaintenance(token, result)
        return result
      }, error => {
        settleMaintenance(token, null, error)
        throw error
      })
      let ids, rows, inputHash, batchId
      const counts = { confirmed: 0, eligible: null, associated: 0 }
      try {
        ids = confirmedIds(input.receipt)
        counts.confirmed = ids.length
        if (!ids.length) return settle(Promise.resolve(finish('no_work', 'no_successful_memory', counts)))
        stats.bodyConfirmed++
        if (stats.preparation !== 'ready') fail('online_not_prepared')
        if (db.isTransaction) fail('transaction_already_open')
        if (ids.length > ONLINE_WRITE_LIMITS.targets) fail('target_budget')
        if (!proven(input.identity)) fail('missing_native_identity')
        rows = memoryRows(ids)
        if (rows.length !== ids.length) fail('body_snapshot_changed')
        inputHash = hash(rows.map(row => [String(row.memory_id), row.summary]).sort(([a], [b]) => a.localeCompare(b)))
        batchId = 'memory-online-' + hash([input.identity, ids])
        const existing = readConsolidationReceipt(db, batchId, { preparedOnly: true })
        if (existing) {
          const data = JSON.parse(existing.audit_json || '{}').online
          if (data?.inputHash !== inputHash) fail('input_conflict')
          counts.eligible = data.eligible ?? null; counts.associated = data.associated ?? null
          const status = existing.status === 'failed' ? data.outcome || 'failed' : existing.status
          if (!['committed', 'no_work', 'rejected', 'failed'].includes(status)) fail('input_conflict')
          return settle(Promise.resolve(finish(status, 'receipt_replay', counts, true, true)))
        }
        if (frozen) fail('online_not_prepared')
        rows = rows.filter(live)
        counts.eligible = rows.length
        if (!rows.length) return settle(Promise.resolve(finish('no_work', 'no_eligible_memory', counts)))
        if (busy) {
          if (pendingKey === batchId && pendingHash === inputHash) return settle(pendingPromise)
          fail('online_busy')
        }
      } catch (error) {
        return settle(Promise.resolve(finish('failed', reasons.has(error?.message) ? error.message : 'graph_query_failed', counts)))
      }
      busy = true; stats.pending = 1; pendingKey = batchId; pendingHash = inputHash
      pendingPromise = execute(input, ids, rows, inputHash, batchId, counts)
        .finally(() => { busy = false; stats.pending = 0; pendingKey = pendingHash = pendingPromise = null })
      return settle(pendingPromise)
    }
  }
}
