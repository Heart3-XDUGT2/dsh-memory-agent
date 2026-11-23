import { TRAFFIC_REFERENCE } from './memory-traffic-dynamics.js'

export const UNIFIED_SHADOW_BOUNDS = Object.freeze({
  adjacencyObservations: 384, candidateObservations: 256, trafficEdges: 96,
  trafficNodes: 48, candidates: 64, memories: 4, queries: 12, maxHops: 3,
  fallbackQueries: 1, startingLane: 'modeled'
})
const quote = name => '"' + name.replace(/"/gu, '""') + '"'
const marks = values => values.map(() => '?').join(',')
const number = value => `(typeof(${value}) IN ('integer','real')
  AND ${value} BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308)`
const clock = value => `(${number(value)} AND ${value}>=0 AND ${value}<=9007199254740991 AND CAST(${value} AS INTEGER)=${value})`
const positive = value => `(${number(value)} AND ${value}>0)`
const useValid = alias => `(${clock(`${alias}.last_used_ms`)} AND ${clock(`${alias}.use_count`)}
  AND ${alias}.use_count>0 AND ${positive(`${alias}.half_life_hours`)})`
const nullUse = 'LEFT JOIN (SELECT NULL unit_id,NULL use_count,NULL last_used_ms,NULL half_life_hours) u ON 0'
const identityKey = path => JSON.stringify([path.nodes, path.linkIds, path.relations])
export function betterUnifiedPath(candidate, current) {
  return !current || candidate.distance < current.distance || (candidate.distance === current.distance
    && ((candidate.score !== null && current.score === null)
      || (candidate.score !== null && current.score !== null && candidate.score > current.score)
      || (candidate.score === current.score && identityKey(candidate) < identityKey(current))))
}
export function balancedShadowTake(rows, limit) {
  const buckets = [rows.filter(row => row.lane === 0), rows.filter(row => row.lane !== 0)]
  const out = []
  while (out.length < limit && buckets.some(bucket => bucket.length)) {
    for (const bucket of buckets) if (out.length < limit && bucket.length) out.push(bucket.shift())
  }
  return out
}

/** Policy/SQL only. Traversal, visits, typed validation and path construction stay in the shared kernel. */
export function createUnifiedShadowPolicy(query, now, activeNode, activeMemory, { memoryAuthority } = {}) {
  const episode = memoryAuthority === 'episode'
  if (!Number.isSafeInteger(now) || now < 0) throw Error('invalid_shadow_clock')
  const metadata = query(`WITH required(table_name,column_name) AS (VALUES
    ('memory_consolidation_traffic_links','from_node_id'),
    ('memory_consolidation_traffic_links','to_node_id'),
    ('memory_consolidation_memory_links','node_id'),
    ('memory_association_use_state','unit_kind'),
    ('memory_association_traffic_strength','link_id'))
    SELECT r.table_name,r.column_name,(SELECT i.name FROM pragma_index_list(r.table_name) i
      JOIN pragma_index_xinfo(i.name) c ON c.seqno=0 AND c.key=1 AND c.name=r.column_name AND c.coll='BINARY'
      WHERE i.partial=0 AND (r.table_name<>'memory_association_use_state' OR EXISTS(
        SELECT 1 FROM pragma_index_xinfo(i.name) c2 WHERE c2.seqno=1 AND c2.key=1 AND c2.name='unit_id' AND c2.coll='BINARY'))
      ORDER BY i.name LIMIT 1) index_name
    FROM required r LIMIT 5`)
  const indexes = new Map(metadata.map(row => [`${row.table_name}:${row.column_name}`, row.index_name]))
  const lookup = (table, column) => indexes.get(`${table}:${column}`)
  const fromIndex = lookup('memory_consolidation_traffic_links', 'from_node_id')
  const toIndex = lookup('memory_consolidation_traffic_links', 'to_node_id')
  const nodeIndex = lookup('memory_consolidation_memory_links', 'node_id')
  const stats = { status: 'ok', reason: null, dynamicStatus: 'ok', fallbackQueries: 0,
    observedEdges: 0, modeledEdges: 0, unknownEdges: 0, invalidEdges: 0,
    coveredLinks: 0, missingLinks: 0,
    futureLinks: 0, memoryFuture: 0,
    candidateObserved: 0, memoryFallback: 0, memoryUnknown: 0, memoryInvalid: 0,
    adjacencyTruncations: 0, candidateTruncations: 0 }
  if (!fromIndex || !toIndex || !nodeIndex) return { ready: false, stats: { ...stats,
    status: 'unavailable', reason: 'missing_lookup_index', dynamicStatus: 'unavailable' } }
  let useIndex = lookup('memory_association_use_state', 'unit_kind')
  let modelIndex = lookup('memory_association_traffic_strength', 'link_id')
  if (!useIndex || !modelIndex) Object.assign(stats, { status: 'partial', reason: 'dynamic_state_unavailable', dynamicStatus: 'unavailable' })
  const degrade = error => {
    if (stats.fallbackQueries >= UNIFIED_SHADOW_BOUNDS.fallbackQueries) throw error
    stats.fallbackQueries++
    Object.assign(stats, { status: 'partial', reason: 'dynamic_query_failed', dynamicStatus: 'failed' })
    useIndex = modelIndex = null
  }
  const guarded = make => {
    try { return make() } catch (error) {
      if (!useIndex && !modelIndex) throw error
      degrade(error)
      return make()
    }
  }
  const useJoin = memory => useIndex ? `LEFT JOIN memory_association_use_state u INDEXED BY ${quote(useIndex)}
    ON u.unit_kind='${memory ? 'memory' : 'traffic-link'}' AND u.unit_id=${memory ? 'CAST(m.memory_id AS TEXT)' : 'l.link_id'}` : nullUse
  function adjacent(frontierRows, visited) {
    return guarded(() => {
      const dynamic = !!useIndex && !!modelIndex
      const valid = dynamic ? `(${useValid('u')} AND ${number('t.intrinsic_value')} AND t.intrinsic_value=${TRAFFIC_REFERENCE.intrinsicValue}
        AND ${number('t.weight')} AND t.weight BETWEEN 0 AND 10 AND ${clock('t.model_started_ms')}
        AND t.model_started_ms<=u.last_used_ms AND t.initialization='${TRAFFIC_REFERENCE.source}')` : '0'
      const factor = dynamic ? `(0.5+t.weight/10.0+0.4/(1.0+MAX(0.0,${now}-u.last_used_ms)/3600000.0/u.half_life_hours))*0.5` : 'NULL'
      const branch = reverse => `SELECT l.from_node_id,l.to_node_id,l.link_id,l.relation,
        f.node_id parent_node_id,l.${reverse ? 'from' : 'to'}_node_id adjacent_node_id,
        CASE WHEN ${valid} THEN ${factor} ELSE NULL END factor,
        CASE WHEN ${valid} AND f.score IS NOT NULL THEN 0 ELSE 1 END lane,
        CASE WHEN ${valid} AND f.score IS NOT NULL THEN f.score*(${factor}) ELSE NULL END priority,
        CASE WHEN ${valid} THEN 1 ELSE 0 END link_modeled,
        ${dynamic ? `CASE WHEN ${valid} AND u.last_used_ms>${now} THEN 1 ELSE 0 END` : '0'} future_clock,
        ${dynamic ? 'CASE WHEN t.link_id IS NULL THEN 1 ELSE 0 END' : '1'} model_missing,
        ${dynamic ? `CASE WHEN t.link_id IS NOT NULL AND NOT ${valid} THEN 1 ELSE 0 END` : '0'} invalid_model
        FROM frontier f CROSS JOIN memory_consolidation_traffic_links l INDEXED BY ${quote(reverse ? toIndex : fromIndex)}
        ON l.${reverse ? 'to' : 'from'}_node_id=f.node_id
        JOIN memory_consolidation_graph_nodes a ON a.node_id=l.from_node_id
        JOIN memory_consolidation_graph_nodes b ON b.node_id=l.to_node_id
        ${dynamic ? useJoin(false) + ` LEFT JOIN memory_association_traffic_strength t INDEXED BY ${quote(modelIndex)} ON t.link_id=l.link_id` : ''}
        WHERE l.from_node_id<>l.to_node_id AND ${activeNode('a')} AND ${activeNode('b')}
        AND l.${reverse ? 'from' : 'to'}_node_id NOT IN (${marks(visited)})`
      const quota = UNIFIED_SHADOW_BOUNDS.adjacencyObservations / 2
      const rows = query(`WITH frontier(node_id,score) AS (VALUES ${frontierRows.map(() => '(?,?)').join(',')}),
        incident AS (${branch(false)} UNION ALL ${branch(true)}),
        ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY lane ORDER BY priority DESC,from_node_id,to_node_id,link_id) rn,
          COUNT(*) OVER(PARTITION BY lane) lane_count FROM incident),
        counted AS (SELECT *,MAX(CASE WHEN lane=0 THEN lane_count ELSE 0 END) OVER() modeled_count,
          MAX(CASE WHEN lane=1 THEN lane_count ELSE 0 END) OVER() unknown_count FROM ranked),
        allotted AS (SELECT *,${quota}+MAX(0,${quota}-CASE lane WHEN 0 THEN unknown_count ELSE modeled_count END) quota FROM counted)
        SELECT * FROM allotted WHERE rn<=quota+1 ORDER BY rn,lane LIMIT ?`,
      ...frontierRows.flat(), ...visited, ...visited, UNIFIED_SHADOW_BOUNDS.adjacencyObservations + 2)
      if (rows.some(row => row.rn > row.quota)) stats.adjacencyTruncations++
      const visible = rows.filter(row => row.rn <= row.quota)
      stats.observedEdges += visible.length
      stats.modeledEdges += visible.filter(row => row.lane === 0).length
      stats.unknownEdges += visible.filter(row => row.lane !== 0).length
      stats.invalidEdges += visible.filter(row => row.invalid_model).length
      stats.coveredLinks += visible.filter(row => row.link_modeled).length
      stats.missingLinks += visible.filter(row => row.model_missing).length
      stats.futureLinks += visible.filter(row => row.future_clock).length
      if (stats.unknownEdges) {
        stats.status = 'partial'
        if (!stats.reason) stats.reason = 'missing_dynamic_record'
        if (stats.dynamicStatus === 'ok') stats.dynamicStatus = 'partial'
      }
      if (stats.invalidEdges && stats.dynamicStatus !== 'failed') {
        stats.reason = 'invalid_dynamic_state'
        stats.dynamicStatus = 'partial'
      }
      return visible
    })
  }
  function attachments(hopRows, excluded) {
    return guarded(() => {
      const valid = !episode && useIndex ? useValid('u') : '0'
      const legacyTime = ['m.last_recalled', 'm.learned_at', 'm.timestamp'].map(field =>
        `WHEN ${positive(field)} AND ${field}<=9007199254740.991 THEN ${field}*1000.0`).join(' ')
      const h = `CASE WHEN ${valid} THEN u.half_life_hours WHEN ${positive('m.half_life')} THEN m.half_life
        WHEN ${number('m.intrinsic_value')} THEN 24.0*pow(MAX(1.0,m.intrinsic_value)/10.0,1.2) ELSE NULL END`
      const last = `CASE WHEN ${valid} THEN u.last_used_ms ELSE CASE ${legacyTime} ELSE NULL END END`
      const badLegacy = `(m.half_life IS NOT NULL AND m.half_life<>0 AND NOT ${positive('m.half_life')})
        OR ${['m.last_recalled', 'm.learned_at', 'm.timestamp'].map(field => `(${field} IS NOT NULL AND ${field}<>0
          AND (NOT ${positive(field)} OR ${field}>9007199254740.991))`).join(' OR ')}`
      const quota = UNIFIED_SHADOW_BOUNDS.candidateObservations / 4
      const rows = query(`WITH reachable(node_id,traffic_hops,route_score) AS (VALUES ${hopRows.map(() => '(?,?,?)').join(',')}),
        links AS (SELECT l.memory_id,l.node_id,l.link_id,r.traffic_hops,r.route_score,
          ${h} strength_h,${last} strength_last,${episode ? '0' : `CASE WHEN ${valid} THEN 0 ELSE 1 END`} memory_fallback,
          CASE WHEN (u.unit_id IS NOT NULL AND NOT ${valid}) OR (NOT ${valid} AND (${badLegacy}))
            OR (${h}) IS NULL OR (${h})>1.7976931348623157e308
            ${episode ? `OR NOT ${clock('m.recall_count')} OR m.recall_count IS NULL` : ''} THEN 1 ELSE 0 END memory_invalid,
          ROW_NUMBER() OVER(PARTITION BY l.memory_id ORDER BY r.traffic_hops,r.route_score DESC,l.node_id,l.link_id) memory_row
          FROM reachable r CROSS JOIN memory_consolidation_memory_links l INDEXED BY ${quote(nodeIndex)} ON l.node_id=r.node_id
          JOIN episodic_memory m ON m.memory_id=l.memory_id
          JOIN memory_consolidation_graph_nodes n ON n.node_id=l.node_id ${episode ? nullUse : useJoin(true)}
          WHERE l.memory_id NOT IN (${marks(excluded)}) AND ${activeMemory('m')} AND ${activeNode('n')}),
        strengths AS (SELECT *,CASE WHEN strength_h>0 AND strength_h<=1.7976931348623157e308 AND strength_last IS NOT NULL
          THEN 1.0/(1.0+MAX(0.0,${now}-strength_last)/3600000.0/strength_h) ELSE NULL END memory_r
          FROM links WHERE memory_row=1),
        ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY traffic_hops ORDER BY memory_r DESC,route_score DESC,memory_id,node_id,link_id) bucket_row
          FROM strengths)
        SELECT * FROM ranked WHERE bucket_row<=? ORDER BY traffic_hops,bucket_row LIMIT ?`,
      ...hopRows.flat(), ...excluded, quota + 1, UNIFIED_SHADOW_BOUNDS.candidateObservations + 4)
      if (rows.some(row => row.bucket_row > quota)) stats.candidateTruncations++
      const visible = rows.filter(row => row.bucket_row <= quota)
      stats.candidateObserved = visible.length
      stats.memoryFallback = visible.filter(row => row.memory_fallback).length
      stats.memoryUnknown = visible.filter(row => row.memory_r === null).length
      stats.memoryFuture = visible.filter(row => row.strength_last > now).length
      stats.memoryInvalid = visible.filter(row => row.memory_invalid).length
      if (stats.memoryInvalid) {
        stats.status = 'partial'
        if (stats.dynamicStatus !== 'failed') {
          stats.reason = 'invalid_dynamic_state'
          stats.dynamicStatus = 'partial'
        }
      } else if (stats.memoryFallback && stats.status === 'ok') {
        stats.status = 'partial'
        stats.reason = 'memory_strength_fallback'
      }
      return visible
    })
  }
  return { ready: true, stats, adjacent, attachments }
}
