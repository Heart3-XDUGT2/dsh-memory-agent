/** Read-only API data for the dedicated consolidation graph. */
import { graphEdgeTypesValid } from './memory-consolidation-graph-contract.js'

const MAX_LIMIT = 400
const MAX_DEPTH = 3
const cleanText = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, '').trim() : ''
const intParam = (value, fallback, max) => {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, max) : fallback
}
function parseQuery (url = '') {
  try { return new URL(String(url), 'http://echo.local').searchParams } catch { return new URLSearchParams() }
}

function readRows (db, query) {
  const limit = intParam(query.limit, 240, MAX_LIMIT)
  const depth = intParam(query.depth, 2, MAX_DEPTH)
  const kind = ['all', 'memory', 'traffic'].includes(query.kind) ? query.kind : 'all'
  const needle = cleanText(query.q).toLocaleLowerCase()
  const root = cleanText(query.node)
  const truncated = { nodes: false, edges: false, memoryDetails: false }
  const partial = []
  const missing = { memorySummaries: 0, receiptEvidence: 0 }
  const edgeById = new Map()
  const addEdges = rows => {
    for (const row of rows) {
      const edge = row.node_id !== undefined
        ? { id: `memory-link:${row.link_id}`, source: `memory:${row.memory_id}`, target: `traffic:${row.node_id}`,
          kind: 'memory-link', relation: '连接', batchId: cleanText(row.created_batch), createdAt: Number(row.created_at) || null }
        : { id: `traffic-link:${row.link_id}`, source: `traffic:${row.from_node_id}`, target: `traffic:${row.to_node_id}`,
          kind: 'traffic-link', relation: cleanText(row.relation) || '相关',
          batchId: cleanText(row.created_batch), createdAt: Number(row.created_at) || null }
      edgeById.set(edge.id, edge)
    }
  }
  const fetchIncident = ids => {
    const memoryIds = ids.filter(id => id.startsWith('memory:')).map(id => id.slice(7))
    const trafficIds = ids.filter(id => id.startsWith('traffic:')).map(id => id.slice(8))
    if (memoryIds.length) {
      const placeholders = memoryIds.map(() => '?').join(',')
      addEdges(db.prepare(`SELECT memory_id, node_id, link_id, created_batch, created_at
        FROM memory_consolidation_memory_links WHERE memory_id IN (${placeholders}) LIMIT ?`).all(...memoryIds, limit + 1))
    }
    if (trafficIds.length) {
      const placeholders = trafficIds.map(() => '?').join(',')
      const attachments = db.prepare(`SELECT memory_id, node_id, link_id, created_batch, created_at
        FROM memory_consolidation_memory_links WHERE node_id IN (${placeholders}) LIMIT ?`).all(...trafficIds, limit + 1)
      if (attachments.length > limit) truncated.edges = true
      addEdges(attachments.slice(0, limit))
      const incident = db.prepare(`SELECT link_id, from_node_id, to_node_id, relation, created_batch, created_at
        FROM memory_consolidation_traffic_links
        WHERE from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders}) LIMIT ?`)
        .all(...trafficIds, ...trafficIds, limit + 1)
      if (incident.length > limit) truncated.edges = true
      addEdges(incident.slice(0, limit))
    }
  }
  if (root) {
    const rootId = root.startsWith('memory:') || root.startsWith('traffic:') ? root : `traffic:${root}`
    let frontier = [rootId]
    const seen = new Set(frontier)
    for (let level = 0; level < depth; level++) {
      fetchIncident(frontier)
      const next = []
      for (const edge of edgeById.values()) {
        if (frontier.includes(edge.source) && !seen.has(edge.target)) { seen.add(edge.target); next.push(edge.target) }
        if (frontier.includes(edge.target) && !seen.has(edge.source)) { seen.add(edge.source); next.push(edge.source) }
      }
      frontier = next
      if (!frontier.length) break
    }
    if (edgeById.size > limit * 2) truncated.edges = true
  } else {
    addEdges(db.prepare(`SELECT memory_id, node_id, link_id, created_batch, created_at
      FROM memory_consolidation_memory_links ORDER BY created_at DESC LIMIT ?`).all(limit * 2 + 1))
    addEdges(db.prepare(`SELECT link_id, from_node_id, to_node_id, relation, created_batch, created_at
      FROM memory_consolidation_traffic_links ORDER BY created_at DESC LIMIT ?`).all(limit * 2 + 1))
    if (edgeById.size > limit * 2) truncated.edges = true
  }
  const edges = [...edgeById.values()]
  const ids = new Set(edges.flatMap(edge => [edge.source, edge.target]))
  const rootId = root ? (root.startsWith('memory:') || root.startsWith('traffic:') ? root : `traffic:${root}`) : null
  if (rootId) {
    const exists = rootId.startsWith('traffic:')
      ? db.prepare('SELECT 1 FROM memory_consolidation_graph_nodes WHERE node_id = ? AND status = ?').get(rootId.slice(8), 'active')
      : db.prepare('SELECT 1 FROM memory_consolidation_memory_links WHERE memory_id = ? LIMIT 1').get(rootId.slice(7))
    if (exists) ids.add(rootId)
    else partial.push('root_not_found')
  }
  const trafficIds = [...ids].filter(id => id.startsWith('traffic:')).map(id => id.slice(8))
  const trafficRows = trafficIds.length
    ? db.prepare(`SELECT node_id, canonical_name, status FROM memory_consolidation_graph_nodes
        WHERE status = 'active' AND node_id IN (${trafficIds.map(() => '?').join(',')})`).all(...trafficIds)
    : (!root ? db.prepare(`SELECT node_id, canonical_name, status FROM memory_consolidation_graph_nodes
        WHERE status = 'active' ORDER BY canonical_name COLLATE NOCASE LIMIT ?`).all(limit + 1) : [])
  if (!root && trafficRows.length > limit) { trafficRows.length = limit; truncated.nodes = true }
  const memoryIds = [...ids].filter(id => id.startsWith('memory:')).map(id => id.slice(7))
  const memoryRows = memoryIds.length
    ? db.prepare(`SELECT memory_id, summary, timestamp, occurred_at FROM episodic_memory
        WHERE memory_id IN (${memoryIds.map(() => '?').join(',')}) LIMIT ${limit}`).all(...memoryIds)
    : []
  const memoryMap = new Map(memoryRows.map(row => [String(row.memory_id), row]))
  if (memoryIds.length > limit) truncated.memoryDetails = true
  const receipts = new Map()
  for (const edge of edges) {
    if (!edge.batchId || receipts.has(edge.batchId)) continue
    receipts.set(edge.batchId, db.prepare(`SELECT status, completed_at FROM memory_consolidation_receipts
      WHERE batch_id = ?`).get(edge.batchId) || null)
  }
  const nodeMap = new Map()
  for (const row of trafficRows) nodeMap.set(`traffic:${row.node_id}`, {
    id: `traffic:${row.node_id}`, type: 'traffic', label: cleanText(row.canonical_name) || '交通节点',
    status: row.status, detail: '交通节点；名称来自专用整固图表。'
  })
  for (const id of memoryIds) {
    const row = memoryMap.get(id)
    if (!row) missing.memorySummaries++
    const summary = cleanText(row?.summary)
    nodeMap.set(`memory:${id}`, {
      id: `memory:${id}`, type: 'memory', label: summary ? (summary.length > 48 ? summary.slice(0, 48) + '…' : summary) : '记忆节点',
      summary: summary || null, occurredAt: Number(row?.occurred_at) > 0 ? Number(row.occurred_at) : null,
      recordedAt: Number(row?.timestamp) > 0 ? Number(row.timestamp) : null,
      status: 'active', detail: summary ? '摘要来自按 memory ID 的只读读取。' : '未读取到这条记忆的摘要。'
    })
  }
  const typedEdges = edges.filter(edge => graphEdgeTypesValid(nodeMap, edge))
  if (typedEdges.length !== edges.length) partial.push('invalid_typed_edges_omitted')
  const matched = [...nodeMap.values()].filter(node => {
    if (kind !== 'all' && node.type !== kind) return false
    return !needle || [node.label, node.summary || ''].some(value => value.toLocaleLowerCase().includes(needle))
  })
  if (matched.length > limit) truncated.nodes = true
  if (rootId) matched.sort((a, b) => Number(b.id === rootId) - Number(a.id === rootId))
  const selected = matched.slice(0, limit)
  const selectedIds = new Set(selected.map(node => node.id))
  const visibleEdges = typedEdges.filter(edge => selectedIds.has(edge.source) && selectedIds.has(edge.target)).map(edge => {
    const receipt = receipts.get(edge.batchId)
    const verified = receipt?.status === 'committed'
    if (!verified) missing.receiptEvidence++
    return { ...edge, evidence: verified ? `批次回执：${receipt.status === 'committed' ? '已提交' : '无工作'}` : '未记录可验证回执',
      evidenceStatus: verified ? 'verified' : 'missing' }
  })
  const degree = new Map()
  for (const edge of visibleEdges) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1)
  }
  const resultNodes = selected.map(node => ({ ...node, degree: degree.get(node.id) || 0 }))
  const meta = db.prepare('SELECT graph_version, updated_at FROM memory_consolidation_meta WHERE id = 1').get() || {}
  const latestReceipt = db.prepare(`SELECT status, completed_at
    FROM memory_consolidation_receipts ORDER BY completed_at DESC LIMIT 1`).get() || null
  if (Object.values(truncated).some(Boolean)) partial.push('bounded_window')
  if (missing.memorySummaries) partial.push('memory_summary_missing')
  if (missing.receiptEvidence) partial.push('receipt_evidence_missing')
  return {
    schema: 'echo-consolidation-graph/v1', readOnly: true,
    summarySource: 'episodic_memory_by_id',
    summaryMissing: missing.memorySummaries > 0,
    summaryMissingCount: missing.memorySummaries,
    graphVersion: typeof meta.graph_version === 'string' ? meta.graph_version : null,
    updatedAt: Number(meta.updated_at) || null,
    receipt: latestReceipt ? { status: cleanText(latestReceipt.status), completedAt: Number(latestReceipt.completed_at) || null } : null,
    filters: { q: needle, kind, depth, node: root || null, limit },
    truncated, partial, missing, nodes: resultNodes, edges: visibleEdges,
    counts: { nodes: resultNodes.length, memoryNodes: resultNodes.filter(node => node.type === 'memory').length,
      trafficNodes: resultNodes.filter(node => node.type === 'traffic').length, edges: visibleEdges.length }
  }
}

export function readConsolidationGraph (db, query = {}) {
  if (!db || typeof db.prepare !== 'function') throw Error('db_required')
  return readRows(db, query)
}

export function consolidationGraphHandler ({ db, json, offline } = {}) {
  return (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    if (!db) return offline(res)
    try { return json(res, 200, readConsolidationGraph(db, Object.fromEntries(parseQuery(req.url)))) } catch {
      return json(res, 500, { error: 'graph read failed' })
    }
  }
}
