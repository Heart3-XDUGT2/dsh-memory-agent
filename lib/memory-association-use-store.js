import { createHash } from 'node:crypto'
import { initialHalfLife, reinforceHalfLife, retrievability } from './dmae.js'
import { recallTraffic } from './memory-traffic-dynamics.js'
import { assertAssociationUseSchema, createAssociationUseTablesInTransaction } from './memory-association-use-schema.js'

export const ASSOCIATION_USE_STATUS = 'prompt_constructed_core_response_observed_turn_completed'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const marks = rows => rows.map(() => '?').join(',')
const id = value => {
  if (!(typeof value === 'string' || Number.isSafeInteger(value))) return null
  const key = String(value)
  return key.length > 0 && key.length <= 128 && key.trim() === key
    && !/[\u0000-\u001f\u007f]/u.test(key) ? key : null
}
const fail = reason => { throw Error(reason) }
const liveMemory = row => row && row.user_id === 'master' && row.is_active === 1
  && (row.status === null || row.status === 'active') && ['', '0'].includes(String(row.superseded_by ?? ''))

/** Explicit bootstrap only. Importing, reading or a disabled writer never creates tables. */
export function ensureAssociationUseSchema(db, { trafficDynamics = false } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') fail('db_required')
  if (db.isTransaction) fail('bootstrap_transaction_already_open')
  let transaction = false
  try {
    db.exec('BEGIN IMMEDIATE')
    transaction = true
    createAssociationUseTablesInTransaction(db, { trafficDynamics })
    db.exec('COMMIT')
    transaction = false
  } catch (error) {
    if (transaction) db.exec('ROLLBACK')
    if (trafficDynamics !== true) throw error
    throw Error(error?.errcode === 5 ? 'traffic_bootstrap_busy'
      : error?.message === 'traffic_schema_incompatible' ? 'traffic_schema_incompatible' : 'traffic_bootstrap_failed')
  }
}

export function normalizeAssociationUseEvent(event) {
  const roundId = id(event.roundId)
  if (!roundId || !['normal', 'care', 'mixed'].includes(event.channel)
    || !Number.isSafeInteger(event.usedAtMs) || event.usedAtMs < 0
    || !Array.isArray(event.entries) || !event.entries.length || event.entries.length > 64) fail('invalid_use_event')
  const entries = new Map()
  for (const raw of event.entries) {
    const memoryId = id(raw?.memoryId), seedId = id(raw?.seedId)
    if (!memoryId || !seedId || !Array.isArray(raw.nodeIds) || raw.nodeIds.length < 1
      || raw.nodeIds.length > 4 || !Array.isArray(raw.linkIds)
      || raw.linkIds.length !== raw.nodeIds.length - 1) fail('invalid_use_event')
    const nodeIds = raw.nodeIds.map(id), linkIds = raw.linkIds.map(id)
    if (nodeIds.some(value => !value) || linkIds.some(value => !value)
      || new Set(nodeIds).size !== nodeIds.length || new Set(linkIds).size !== linkIds.length) fail('invalid_use_event')
    const entry = { memoryId, seedId, nodeIds, linkIds }
    entries.set(JSON.stringify(entry), entry)
  }
  return { roundId, channel: event.channel, entries: [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value) }
}

function validateSource(db, entries, { memoryAuthority = 'legacy' } = {}) {
  const memoryIds = [...new Set(entries.flatMap(entry => [entry.memoryId, entry.seedId]))]
  const nodeIds = [...new Set(entries.flatMap(entry => entry.nodeIds))]
  const linkIds = [...new Set(entries.flatMap(entry => entry.linkIds))]
  const rows = db.prepare(`SELECT memory_id,user_id,is_active,status,superseded_by${memoryAuthority === 'legacy' ? ',intrinsic_value,half_life' : ''}
    FROM episodic_memory WHERE memory_id IN (${marks(memoryIds)})`).all(...memoryIds)
  const memories = new Map(rows.map(row => [String(row.memory_id), row]))
  if (memoryIds.some(key => !liveMemory(memories.get(key)))) fail('memory_not_active')
  const nodes = db.prepare(`SELECT node_id FROM memory_consolidation_graph_nodes
    WHERE node_id IN (${marks(nodeIds)}) AND status='active' AND COALESCE(superseded_by,'') IN ('',0)`).all(...nodeIds)
  if (nodes.length !== nodeIds.length) fail('traffic_not_active')
  const links = linkIds.length ? db.prepare(`SELECT link_id,from_node_id,to_node_id
    FROM memory_consolidation_traffic_links WHERE link_id IN (${marks(linkIds)})`).all(...linkIds) : []
  const edges = new Map(links.map(row => [String(row.link_id), row]))
  const pairs = [...new Map(entries.flatMap(entry => [[entry.seedId, entry.nodeIds[0]],
    [entry.memoryId, entry.nodeIds.at(-1)]]).map(pair => [JSON.stringify(pair), pair])).values()]
  const attachments = db.prepare(`WITH requested(memory_id,node_id) AS (VALUES ${pairs.map(() => '(?,?)').join(',')})
    SELECT l.memory_id,l.node_id FROM memory_consolidation_memory_links l
    JOIN requested r ON r.memory_id=l.memory_id AND r.node_id=l.node_id`).all(...pairs.flat())
  const attached = new Set(attachments.map(row => JSON.stringify([String(row.memory_id), String(row.node_id)])))
  if (pairs.some(pair => !attached.has(JSON.stringify(pair)))) fail('attachment_missing')
  for (const entry of entries) {
    for (let index = 0; index < entry.linkIds.length; index++) {
      const edge = edges.get(entry.linkIds[index]), a = entry.nodeIds[index], b = entry.nodeIds[index + 1]
      if (!edge || !((String(edge.from_node_id) === a && String(edge.to_node_id) === b)
        || (String(edge.from_node_id) === b && String(edge.to_node_id) === a))) fail('traffic_path_changed')
    }
  }
  return memories
}

export function createAssociationUseStore({ db, enabled = false, onFailure = null, trafficDynamics = false, trafficIsMaster = true, preparedOnly = false } = {}) {
  if (enabled !== true) return { record: () => ({ status: 'disabled' }) }
  if (trafficDynamics === true && typeof trafficIsMaster !== 'boolean') fail('invalid_traffic_policy')
  if (preparedOnly === true) assertAssociationUseSchema(db, { trafficDynamics })
  else ensureAssociationUseSchema(db, { trafficDynamics })
  let writing = false
  const report = failure => {
    if (typeof onFailure !== 'function') return false
    try { onFailure?.(failure) } catch { return false }
    return true
  }
  const prepared = new WeakMap()
  function prepareData(event, memoryAuthority = 'legacy') {
    if (event?.status !== ASSOCIATION_USE_STATUS) fail('ineligible_evidence')
    if (!['legacy', 'episode'].includes(memoryAuthority)) fail('invalid_memory_authority')
    const normalized = normalizeAssociationUseEvent(event)
    const payloadHash = digest(normalized)
    const prior = db.prepare(`SELECT payload_hash,evidence_status,channel,used_at_ms,memory_count,unit_count
      FROM memory_association_use_receipts WHERE round_id=?`).get(normalized.roundId)
    if (prior) {
      if (prior.payload_hash !== payloadHash) return { status: 'conflict', normalized, payloadHash, prior }
      return { status: 'duplicate', normalized, payloadHash, prior }
    }
    const memories = validateSource(db, normalized.entries, { memoryAuthority })
    const units = new Map()
    const add = (kind, key) => units.set(kind + ':' + key, { kind, key })
    for (const entry of normalized.entries) {
      add('memory', entry.memoryId)
      for (const node of entry.nodeIds) add('traffic-node', node)
      for (const link of entry.linkIds) add('traffic-link', link)
      add('traffic-path', digest([entry.nodeIds, entry.linkIds]))
    }
    const data = { status: 'new', normalized, payloadHash, memories, units: [...units.values()], memoryAuthority }
    const token = Object.freeze({ status: 'new', roundId: normalized.roundId,
      memoryCount: new Set(normalized.entries.map(entry => entry.memoryId)).size, unitCount: units.size })
    prepared.set(token, data)
    return token
  }
  function applyPrepared(event, token, memoryAuthority) {
    if (!db.isTransaction) fail('caller_transaction_required')
    if (!['legacy', 'episode'].includes(memoryAuthority)) fail('invalid_memory_authority')
    const data = prepared.get(token)
    const normalized = normalizeAssociationUseEvent(event)
    if (!data || data.status !== 'new' || data.memoryAuthority !== memoryAuthority
      || data.normalized.roundId !== normalized.roundId || data.payloadHash !== digest(normalized)) fail('invalid_prepared_use')
    const { payloadHash, memories, units } = data
    if (db.prepare('SELECT 1 FROM memory_association_use_receipts WHERE round_id=?').get(normalized.roundId)) {
      fail('association_use_changed_after_prepare')
    }
    for (const unit of units.sort((a, b) => (a.kind + a.key).localeCompare(b.kind + b.key))) {
      const old = db.prepare(`SELECT use_count,last_used_ms,half_life_hours FROM memory_association_use_state
        WHERE unit_kind=? AND unit_id=?`).get(unit.kind, unit.key)
      let halfLife = null
      if (unit.kind === 'memory' && memoryAuthority === 'legacy') {
        const memory = memories.get(unit.key)
        const initial = Number.isFinite(memory.half_life) && memory.half_life > 0
          ? memory.half_life : initialHalfLife(memory.intrinsic_value)
        const previous = old?.half_life_hours ?? initial
        const r = old ? retrievability(Math.max(0, event.usedAtMs - old.last_used_ms) / 3600000, previous) : 1
        halfLife = reinforceHalfLife(previous, r)
      } else if (unit.kind === 'memory' && memoryAuthority === 'episode') {
        halfLife = old?.half_life_hours ?? null
      } else if (unit.kind === 'traffic-link') {
        const model = trafficDynamics === true ? db.prepare(`SELECT intrinsic_value,weight,model_started_ms,initialization
          FROM memory_association_traffic_strength WHERE link_id=?`).get(unit.key) : null
        if (trafficDynamics === true) {
          const next = recallTraffic(old, model, event.usedAtMs, trafficIsMaster)
          halfLife = next.halfLifeHours
          db.prepare(`INSERT INTO memory_association_traffic_strength
            (link_id,intrinsic_value,weight,model_started_ms,initialization) VALUES (?,?,?,?,?)
            ON CONFLICT(link_id) DO UPDATE SET weight=excluded.weight`)
            .run(unit.key, next.model.intrinsic_value, next.model.weight, next.model.model_started_ms, next.model.initialization)
        } else if (old?.half_life_hours != null) fail('traffic_policy_required')
      }
      db.prepare(`INSERT INTO memory_association_use_events(round_id,unit_kind,unit_id) VALUES (?,?,?)`)
        .run(normalized.roundId, unit.kind, unit.key)
      db.prepare(`INSERT INTO memory_association_use_state(unit_kind,unit_id,use_count,last_used_ms,half_life_hours)
        VALUES (?,?,1,?,?) ON CONFLICT(unit_kind,unit_id) DO UPDATE SET
        use_count=use_count+1,last_used_ms=MAX(last_used_ms,excluded.last_used_ms),half_life_hours=excluded.half_life_hours`)
        .run(unit.kind, unit.key, event.usedAtMs, halfLife)
    }
    const memoryCount = new Set(normalized.entries.map(entry => entry.memoryId)).size
    db.prepare(`INSERT INTO memory_association_use_receipts
      (round_id,payload_hash,evidence_status,channel,used_at_ms,memory_count,unit_count) VALUES (?,?,?,?,?,?,?)`)
      .run(normalized.roundId, payloadHash, ASSOCIATION_USE_STATUS, normalized.channel,
        event.usedAtMs, memoryCount, units.length)
    return { status: 'committed', roundId: normalized.roundId, payloadHash,
      channel: normalized.channel, usedAtMs: event.usedAtMs, memoryCount, unitCount: units.length }
  }
  function prepareInTransaction(event, { memoryAuthority = 'legacy' } = {}) {
    if (!db.isTransaction) fail('caller_transaction_required')
    if (writing) fail('reentrant_write')
    return prepareData(event, memoryAuthority)
  }
  function applyInTransaction(event, { memoryAuthority = 'legacy', prepared: token } = {}) {
    if (writing) fail('reentrant_write')
    writing = true
    try { return applyPrepared(event, token, memoryAuthority) } finally { writing = false }
  }
  function record(event) {
    if (event?.status !== ASSOCIATION_USE_STATUS) return { status: 'ignored', reason: 'ineligible_evidence' }
    if (writing || db.isTransaction) {
      const reason = writing ? 'reentrant_write' : 'transaction_already_open'
      if (!writing) report({ reason })
      return { status: 'failed', reason, failureAudit: 'not_attempted' }
    }
    writing = true
    let transaction = false
    let normalized
    try {
      normalized = normalizeAssociationUseEvent(event)
      db.exec('BEGIN IMMEDIATE')
      transaction = true
      const token = prepareData(event)
      if (token.status === 'duplicate') {
        db.exec('ROLLBACK'); transaction = false
        return { status: 'duplicate' }
      }
      if (token.status === 'conflict') {
        db.exec('ROLLBACK'); transaction = false
        const failureReported = report({ reason: 'round_payload_conflict', failureAudit: 'not_attempted' })
        return { status: 'rejected', reason: 'round_payload_conflict', failureAudit: 'not_attempted', failureReported }
      }
      const applied = applyPrepared(event, token, 'legacy')
      db.exec('COMMIT'); transaction = false
      return { status: 'committed', memoryCount: applied.memoryCount, unitCount: applied.unitCount }
    } catch (error) {
      if (transaction) { try { db.exec('ROLLBACK') } catch {} }
      const known = ['invalid_use_event', 'memory_not_active', 'traffic_not_active', 'attachment_missing', 'traffic_path_changed',
        'invalid_traffic_state', 'traffic_policy_required']
      const reason = known.includes(error?.message) ? error.message : error?.errcode === 5 ? 'write_busy'
        : /^no such (?:table|column):/u.test(error?.message || '') ? 'source_graph_unavailable' : 'write_failed'
      let failureAudit = 'unavailable'
      try {
        db.prepare('INSERT INTO memory_association_use_failures(round_id,reason,failed_at_ms) VALUES (?,?,?)')
          .run(normalized?.roundId ?? null, reason, Number.isSafeInteger(event.usedAtMs) ? event.usedAtMs : 0)
        failureAudit = 'persisted'
      } catch {}
      const failureReported = report({ reason, failureAudit })
      return { status: 'failed', reason, failureAudit, failureReported }
    } finally { writing = false }
  }
  return { record, prepareInTransaction, applyInTransaction }
}
