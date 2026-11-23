import { createHash } from 'node:crypto'
import { initialHalfLife, retrievability } from './dmae.js'
import { trafficR, validTrafficModel, trafficPathUtility } from './memory-traffic-dynamics.js'

export const STRENGTH_READ_BOUNDS = Object.freeze({ memories: 256, paths: 3072, units: 4096, queries: 3 })
const marks = rows => rows.map(() => '?').join(',')
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0
const epoch = value => Number.isSafeInteger(value) && value >= 0
const legacySeconds = value => positive(value) && value * 1000 <= Number.MAX_SAFE_INTEGER
const pathId = path => createHash('sha256').update(JSON.stringify([path.nodes, path.linkIds])).digest('hex')

/** Bounded SELECT-only diagnostics. Legacy times are seconds; P3 times are milliseconds. */
export function readAssociationStrength(db, candidates, { now = Date.now(), memoryAuthority } = {}) {
  const episode = memoryAuthority === 'episode'
  const metrics = { queries: 0, candidateCount: 0, p3Count: 0, fallbackCount: 0,
    unknownTimeCount: 0, futureTimeCount: 0, invalidCount: 0, trafficCount: 0 }
  const result = (status, reason, memories = [], traffic = [], paths = []) => ({ status, reason, memories, traffic, paths, metrics })
  if (!epoch(now) || !Array.isArray(candidates) || candidates.length > STRENGTH_READ_BOUNDS.memories) {
    return result('failed', 'invalid_strength_input')
  }
  const units = new Map(), memoryIds = []
  const add = (kind, id) => units.set(JSON.stringify([kind, id]), [kind, id])
  let paths = 0
  for (const candidate of candidates) {
    if (!validId(candidate?.memoryId) || !Array.isArray(candidate.paths)) return result('failed', 'invalid_strength_input')
    memoryIds.push(candidate.memoryId)
    add('memory', candidate.memoryId)
    for (const path of candidate.paths) {
      if (++paths > STRENGTH_READ_BOUNDS.paths || !Array.isArray(path?.nodes) || path.nodes.length < 1
        || path.nodes.length > 4 || !Array.isArray(path.linkIds) || path.linkIds.length !== path.nodes.length - 1
        || [...path.nodes, ...path.linkIds].some(id => !validId(id))) return result('failed', 'invalid_strength_input')
      for (const id of path.nodes) add('traffic-node', id)
      for (const id of path.linkIds) add('traffic-link', id)
      add('traffic-path', pathId(path))
    }
  }
  if (new Set(memoryIds).size !== memoryIds.length || units.size > STRENGTH_READ_BOUNDS.units) {
    return result('failed', 'invalid_strength_input')
  }
  metrics.candidateCount = memoryIds.length
  if (!db?.prepare) return result('unavailable', 'db_unavailable')
  const query = (sql, ...params) => {
    if (++metrics.queries > STRENGTH_READ_BOUNDS.queries) throw Error('strength_query_budget')
    return db.prepare(sql).all(...params)
  }
  try {
    const table = query(`SELECT name FROM sqlite_master WHERE type='table'
      AND name IN ('memory_association_use_state','memory_association_traffic_strength') LIMIT 2`)
    const hasUse = table.some(row => row.name === 'memory_association_use_state')
    if (!hasUse && !episode) return result('unavailable', 'missing_use_table')
    const hasTrafficModel = table.some(row => row.name === 'memory_association_traffic_strength')
    if (!memoryIds.length) return result('empty', 'no_candidates')
    const legacy = query(`SELECT memory_id,half_life,last_recalled,intrinsic_value,learned_at,timestamp${episode ? ',recall_count' : ''}
      FROM episodic_memory WHERE memory_id IN (${marks(memoryIds)}) AND user_id='master'
      AND is_active=1 AND (status IS NULL OR status='active') AND COALESCE(superseded_by,0) IN (0,'')
      LIMIT ?`, ...memoryIds, memoryIds.length)
    if (legacy.length !== memoryIds.length) return result('failed', 'memory_changed')
    const requested = [...units.values()].filter(([kind]) => !episode || kind !== 'memory')
    const rows = hasUse && requested.length ? query(`WITH requested(unit_kind,unit_id) AS (VALUES ${requested.map(() => '(?,?)').join(',')})
      SELECT s.unit_kind,s.unit_id,s.use_count,s.last_used_ms,s.half_life_hours
      ${hasTrafficModel ? ',t.link_id AS model_link_id,t.intrinsic_value,t.weight,t.model_started_ms,t.initialization' : ''}
      FROM memory_association_use_state s JOIN requested r
      ON s.unit_kind=r.unit_kind AND s.unit_id=r.unit_id
      ${hasTrafficModel ? "LEFT JOIN memory_association_traffic_strength t ON s.unit_kind='traffic-link' AND t.link_id=s.unit_id" : ''}
      LIMIT ?`, ...requested.flat(), requested.length + 1) : []
    if (rows.length > requested.length) return result('failed', 'invalid_use_state')
    const state = new Map()
    for (const row of rows) {
      const key = JSON.stringify([row.unit_kind, row.unit_id])
      if (state.has(key)) return result('failed', 'invalid_use_state')
      state.set(key, row)
    }
    const validUse = row => Number.isSafeInteger(row.use_count) && row.use_count > 0 && epoch(row.last_used_ms)
    const memories = legacy.map(row => {
      const memoryId = String(row.memory_id), use = state.get(JSON.stringify(['memory', memoryId]))
      const valid = use && validUse(use) && positive(use.half_life_hours)
      if (use && !valid) metrics.invalidCount++
      const h = valid ? use.half_life_hours : positive(row.half_life) ? row.half_life
        : typeof row.intrinsic_value === 'number' && Number.isFinite(row.intrinsic_value)
          ? initialHalfLife(row.intrinsic_value) : null
      const halfLifeHours = positive(h) ? h : null
      if (halfLifeHours === null) metrics.invalidCount++
      if (!valid && row.half_life != null && row.half_life !== 0 && !positive(row.half_life)) metrics.invalidCount++
      if (!valid && [row.last_recalled, row.learned_at, row.timestamp].some(value =>
        value != null && value !== 0 && !legacySeconds(value))) metrics.invalidCount++
      const legacyTime = [row.last_recalled, row.learned_at, row.timestamp]
        .find(legacySeconds)
      const lastUsedMs = valid ? use.last_used_ms : legacyTime === undefined ? null : legacyTime * 1000
      const source = valid ? 'p3' : positive(row.half_life) ? episode ? 'episode' : 'legacy' : 'h0'
      if (!episode) metrics[valid ? 'p3Count' : 'fallbackCount']++
      if (episode && !epoch(row.recall_count)) metrics.invalidCount++
      if (lastUsedMs === null) metrics.unknownTimeCount++
      const future = lastUsedMs !== null && lastUsedMs > now
      if (future) metrics.futureTimeCount++
      return { memoryId, source, fallback: !episode && !valid, invalidUse: !!use && !valid,
        ...(episode ? { useCount: epoch(row.recall_count) ? row.recall_count : null } : {}),
        halfLifeHours, lastUsedMs, timeStatus: lastUsedMs === null ? 'unknown' : future ? 'future_clamped' : 'known',
        r: lastUsedMs === null || halfLifeHours === null ? null
          : retrievability(Math.max(0, now - lastUsedMs) / 3600000, halfLifeHours) }
    })
    const traffic = rows.filter(row => row.unit_kind !== 'memory').map(row => {
      if (row.unit_kind === 'traffic-link' && row.model_link_id != null) {
        const valid = validTrafficModel(row, row)
        if (!valid) metrics.invalidCount++
        return { kind: row.unit_kind, id: row.unit_id, status: valid ? 'modeled' : 'invalid',
          useCount: valid ? row.use_count : null, lastUsedMs: valid ? row.last_used_ms : null,
          halfLifeHours: valid ? row.half_life_hours : null, weight: valid ? row.weight : null,
          intrinsicValue: valid ? row.intrinsic_value : null, modelStartedAt: valid ? row.model_started_ms : null,
          initialization: valid ? row.initialization : null, r: valid ? trafficR(row, row, now) : null,
          timeStatus: valid ? row.last_used_ms > now ? 'future_clamped' : 'known' : 'unknown' }
      }
      const valid = validUse(row) && row.half_life_hours === null
      if (!valid) metrics.invalidCount++
      return { kind: row.unit_kind, id: row.unit_id, status: valid ? 'observed' : 'invalid',
        useCount: valid ? row.use_count : null, lastUsedMs: valid ? row.last_used_ms : null }
    })
    metrics.trafficCount = traffic.length
    const links = new Map(traffic.filter(row => row.kind === 'traffic-link').map(row => [row.id, row]))
    const pathObservations = [...new Map(candidates.flatMap(candidate => candidate.paths)
      .map(path => [pathId(path), { pathId: pathId(path), ...trafficPathUtility(path.linkIds, links) }])).values()]
    const observation = result(metrics.invalidCount || !hasUse ? 'partial' : metrics.fallbackCount ? 'fallback' : 'ok',
      metrics.invalidCount ? 'invalid_strength_data' : !hasUse ? 'missing_use_table' : metrics.fallbackCount ? 'missing_memory_use' : null,
      memories, traffic, pathObservations)
    if (episode) observation.trafficStatus = !hasUse ? 'unavailable' : traffic.some(row => row.status === 'invalid') ? 'partial' : 'ok'
    return observation
  } catch (error) {
    if (/^no such (?:table|column):/u.test(error?.message || '')) return result('unavailable', 'incompatible_strength_schema')
    return result('failed', 'strength_query_failed')
  }
}
