/** Bounded production candidate source for the isolated consolidation graph. */
import { createHash } from 'node:crypto'
import { ensureConsolidationCommitSchema, assertConsolidationPrepared } from './memory-consolidation-commit.js'
import { readConsolidationCandidates } from './memory-consolidation-candidates.js'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const idsOf = values => [...new Set((Array.isArray(values) ? values : []).map(value => String(value)))].sort()
const bounded = (value, fallback, max) => {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, max) : fallback
}

function evidence (kind, path, payload, version = null) {
  return { kind, path, version, readId: 0, sha256: digest(payload) }
}

export function createConsolidationCandidateSource ({ db, preparedOnly = false } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') throw Error('db_required')
  if (preparedOnly) assertConsolidationPrepared(db)
  else ensureConsolidationCommitSchema(db)
  const readVersion = () => db.prepare('SELECT graph_version FROM memory_consolidation_meta WHERE id = 1').get()?.graph_version ?? null
  return {
    readOnly: true,
    async readCandidate ({ batchId, scope, settings, signal }) {
      let memoryIds = Array.isArray(scope?.memoryIds) ? [...scope.memoryIds] : undefined
      for (;;) {
        const candidate = await readConsolidationCandidates({
          batchId, memoryIds, since: scope?.since,
          limit: scope?.limit, settings, source: this, signal
        })
        if (candidate.status !== 'partial'
          || !candidate.truncation.includes('max_tokens')
          || !memoryIds || memoryIds.length <= 1) return candidate
        // Narrow the explicit candidate set until the bounded content window is complete.
        memoryIds = memoryIds.slice(0, Math.max(1, Math.floor(memoryIds.length / 2)))
      }
    },
    selectRecentMemoryIds ({ limit = 100 } = {}) {
      const n = Math.max(1, bounded(limit, 100, 1000))
      return db.prepare(`SELECT memory_id FROM episodic_memory
        WHERE is_active = 1 AND (status IS NULL OR status = 'active')
        ORDER BY timestamp DESC, memory_id DESC LIMIT ?`).all(n).map(row => String(row.memory_id))
    },
    async readMemories ({ memoryIds = [], limit = 100 } = {}) {
      const ids = idsOf(memoryIds).slice(0, Math.max(1, bounded(limit, 100, 1000)))
      if (!ids.length) return { rows: [], complete: true, evidence: { kind: 'engine-read', path: '/episodic-memory' }, version: readVersion() }
      const placeholders = ids.map(() => '?').join(',')
      const statement = db.prepare(`SELECT memory_id, ${preparedOnly
        ? 'CASE WHEN length(CAST(summary AS BLOB))<=8192 THEN summary ELSE NULL END summary,length(CAST(summary AS BLOB)) summary_bytes'
        : 'summary'}, ${preparedOnly ? 'substr(source,1,1024) source' : 'source'}, status, is_active, superseded_by,
          occurred_at, timestamp, learned_at, last_recalled
        FROM episodic_memory WHERE memory_id IN (${placeholders})
          AND is_active = 1 AND (status IS NULL OR status = 'active')`)
      let rows
      if (preparedOnly) {
        rows = []
        let total = 0
        for (const row of statement.iterate(...ids)) {
          total += row.summary_bytes || 0
          if (row.summary_bytes > 8192 || total > 32768) throw Error('source_budget')
          rows.push(row)
        }
      } else rows = statement.all(...ids)
      return {
        rows: rows.map(row => ({
          memoryId: String(row.memory_id), summary: String(row.summary ?? ''),
          source: row.source ?? null, status: row.status || 'active',
          isActive: row.is_active, supersededBy: row.superseded_by ?? null,
          occurredAt: Number(row.occurred_at) > 0 ? Number(row.occurred_at) : null,
          recordedAt: Number(row.timestamp) > 0 ? Number(row.timestamp) : null,
          learnedAt: Number(row.learned_at) > 0 ? Number(row.learned_at) : null,
          lastRecalled: Number(row.last_recalled) > 0 ? Number(row.last_recalled) : null,
          evidence: { readId: 0 }
        })),
        complete: rows.length === ids.length,
        evidence: { kind: 'engine-read', path: '/episodic-memory' },
        version: readVersion()
      }
    },
    async readLocalGraph ({ memoryIds = [], maxHops = 2, maxNeighbors = 24, maxNodes = 512, maxEdges = 2048 } = {}) {
      const ids = idsOf(memoryIds)
      const nodeLimit = Math.max(1, bounded(maxNodes, 512, 512))
      const edgeLimit = Math.max(1, bounded(maxEdges, 2048, 2048))
      if (!ids.length || maxHops < 1) {
        return { trafficNodes: [], memoryNodeLinks: [], trafficLinks: [], complete: true,
          evidence: { kind: 'engine-read', path: '/memory-consolidation-graph' }, version: readVersion() }
      }
      const ph = ids.map(() => '?').join(',')
      const memoryLinks = db.prepare(`SELECT memory_id, node_id, link_id, created_batch
        FROM memory_consolidation_memory_links WHERE memory_id IN (${ph}) LIMIT ?`).all(...ids, edgeLimit + 1)
      const linkComplete = memoryLinks.length <= edgeLimit
      const links = memoryLinks.slice(0, edgeLimit).map(row => ({
        linkId: row.link_id, memoryId: String(row.memory_id), nodeId: row.node_id,
        status: 'active', evidence: { readId: 0 }
      }))
      const nodeIds = [...new Set(links.map(row => row.nodeId))]
      if (!nodeIds.length) return { trafficNodes: [], memoryNodeLinks: [], trafficLinks: [], complete: linkComplete,
        evidence: { kind: 'engine-read', path: '/memory-consolidation-graph' }, version: readVersion() }
      const nph = nodeIds.map(() => '?').join(',')
      const roots = db.prepare(`SELECT node_id, canonical_name, aliases_json, status, superseded_by
        FROM memory_consolidation_graph_nodes WHERE node_id IN (${nph}) LIMIT ?`).all(...nodeIds, nodeLimit + 1)
      const activeRootIds = roots.filter(row => row.status === 'active'
        && ['', '0'].includes(String(row.superseded_by || ''))).map(row => row.node_id)
      const aph = activeRootIds.map(() => '?').join(',')
      // Edges are read from the rooted neighborhood; include their other endpoints
      // so a bounded local graph never returns a dangling legal edge.
      const traffic = activeRootIds.length
        ? db.prepare(`SELECT link_id, from_node_id, to_node_id, relation
            FROM memory_consolidation_traffic_links
            WHERE from_node_id IN (${aph}) OR to_node_id IN (${aph}) LIMIT ?`)
          .all(...activeRootIds, ...activeRootIds, edgeLimit + 1)
        : []
      const endpointIds = [...new Set([
        ...nodeIds,
        ...traffic.flatMap(row => [row.from_node_id, row.to_node_id])
      ])]
      const eph = endpointIds.map(() => '?').join(',')
      const nodes = endpointIds.length
        ? db.prepare(`SELECT node_id, canonical_name, aliases_json, status, superseded_by
            FROM memory_consolidation_graph_nodes WHERE node_id IN (${eph}) LIMIT ?`)
          .all(...endpointIds, nodeLimit + 1)
        : []
      const nodeComplete = roots.length <= nodeLimit
        && nodes.length <= nodeLimit
        && nodes.length === endpointIds.length
      const trafficNodes = nodes.slice(0, nodeLimit).map(row => ({
        nodeId: row.node_id, canonicalName: row.canonical_name,
        aliases: JSON.parse(row.aliases_json || '[]'), status: row.status,
        supersededBy: row.superseded_by ?? null, evidence: { readId: 0 }
      }))
      const trafficComplete = traffic.length <= edgeLimit
      const returnedNodeIds = new Set(trafficNodes.map(row => row.nodeId))
      return {
        trafficNodes,
        memoryNodeLinks: links.filter(link => returnedNodeIds.has(link.nodeId)),
        trafficLinks: traffic.slice(0, edgeLimit).filter(row =>
          returnedNodeIds.has(row.from_node_id) && returnedNodeIds.has(row.to_node_id)).map(row => ({
          linkId: row.link_id, from: row.from_node_id, to: row.to_node_id,
          relation: row.relation, status: 'active', evidence: { readId: 0 }
        })),
        complete: linkComplete && nodeComplete && trafficComplete,
        evidence: { kind: 'engine-read', path: '/memory-consolidation-graph' },
        version: readVersion()
      }
    },
    async readGraphVersion () { return readVersion() }
  }
}
