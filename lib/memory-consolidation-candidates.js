/** Bounded read-only preparation; no store imports, persistence or model calls. */
import { createHash } from 'node:crypto'
import { CONSOLIDATION_DEFAULTS } from './memory-consolidation-state.js'
import { validateTypedGraphLinks } from './memory-consolidation-graph-contract.js'

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0
const sha = x => createHash('sha256').update(JSON.stringify(x)).digest('hex')
const fail = code => { throw new Error(code) }
const id = x => {
  if (!((typeof x === 'string' && x.trim() === x && x.length > 0 && x.length <= 128
    && !/[\u0000-\u001f\u007f]/u.test(x)) || (Number.isSafeInteger(x) && x > 0))) fail('invalid_id')
  return String(x)
}
const ids = x => {
  if (!Array.isArray(x)) fail('invalid_ids')
  return [...new Set(x.map(id))].sort(cmp)
}
const time = x => typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null
const text = (x, max = 32000) => {
  if (typeof x !== 'string' || !x.trim() || x.length > max) fail('invalid_text')
  return x
}
const active = row => row.status === 'active' && (row.isActive === undefined || row.isActive === true || row.isActive === 1)
  && (row.supersededBy === undefined || row.supersededBy === null || row.supersededBy === '' || row.supersededBy === 0)

/** Accepts the eight public settings, with the same bounds as normalizeSettings. */
export function candidateLimits (settings = {}) {
  const ranges = { maxMemories: [1, 1000], maxHops: [0, 8], maxNeighbors: [1, 200],
    maxTokens: [256, 64000], timeoutMs: [1000, 900000], maxRetries: [0, 10], retryDelayMs: [0, 3600000] }
  const result = { catchUp: settings.memoryConsolidationCatchUp !== false }
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const raw = settings['memoryConsolidation' + key[0].toUpperCase() + key.slice(1)]
    const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
    result[key] = Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : CONSOLIDATION_DEFAULTS[key]
  }
  // Additional hard transport ceilings prevent exponential neighborhood growth.
  return { ...result, maxNodes: 512, maxEdges: 2048, maxResponseBytes: 2 * 1024 * 1024 }
}

function uniqueRows (rows, key) {
  const map = new Map()
  for (const row of rows) {
    if (!object(row)) fail('invalid_row')
    const k = key(row)
    if (map.has(k) && sha(map.get(k)) !== sha(row)) fail('conflicting_duplicate')
    map.set(k, row)
  }
  return [...map.values()]
}

/** Per-request deadline only, never a scheduled job or a retry loop. */
async function withDeadline (fn, deadline, controller) {
  const remaining = deadline - performance.now()
  if (remaining <= 0) fail('read_timeout')
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn(controller.signal)),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('read_timeout')) }, remaining)
      })
    ])
  } finally { clearTimeout(timer) }
}

/**
 * source.readMemories({memoryIds | since, limit, signal}) ->
 *   {rows, complete:boolean, evidence:{kind, path}, version?:string}
 * source.readLocalGraph({memoryIds,maxHops,maxNeighbors,maxNodes,maxEdges,signal}) ->
 *   {trafficNodes,memoryNodeLinks,trafficLinks,complete,evidence,version?}
 * Graph links must already be explicit structural links, never inferred from legacy edge evidence.
 * Source must declare readOnly:true. This interface does not grant permission to a new source.
 */
export async function readConsolidationCandidates ({ batchId, memoryIds, since, limit, settings = {}, source } = {}) {
  const limits = candidateLimits(settings)
  const out = { schema: 'echo-consolidation-candidates/v1', batchId: null, readOnly: true,
    status: 'blocked', memories: [], trafficNodes: null, memoryNodeLinks: null, trafficLinks: null,
    scope: null, truncation: [], issues: [], sourceEvidence: [], limits,
    budget: { unit: 'utf8-bytes', used: 0, ceiling: limits.maxTokens,
      note: 'Conservative content budget; no model tokenizer invoked.' },
    graphVersion: null, snapshotAtomic: false }
  const issue = reason => { if (!out.issues.includes(reason)) out.issues.push(reason) }
  const cut = reason => { if (!out.truncation.includes(reason)) out.truncation.push(reason) }
  const controller = new AbortController()
  const deadline = performance.now() + limits.timeoutMs
  let budgetExhausted = false
  const checkDeadline = () => { if (performance.now() >= deadline) fail('read_timeout') }
  const evidence = (response, kind) => {
    if (!object(response?.evidence) || !['http-get', 'engine-read', 'fixture'].includes(response.evidence.kind)
      || typeof response.evidence.path !== 'string' || !/^\/[A-Za-z0-9/_-]+$/.test(response.evidence.path)) fail('source_evidence_missing')
    const readId = out.sourceEvidence.length
    out.sourceEvidence.push({ readId, kind, transport: response.evidence.kind,
      path: response.evidence.path, sha256: sha(response),
      version: typeof response.version === 'string' ? response.version : null })
    return readId
  }
  const payload = () => ({ memories: out.memories, trafficNodes: out.trafficNodes,
    memoryNodeLinks: out.memoryNodeLinks, trafficLinks: out.trafficLinks })
  const fits = () => Buffer.byteLength(JSON.stringify(payload())) <= limits.maxTokens
  const addWithinBudget = (array, value) => {
    array.push(value)
    if (fits()) return true
    array.pop(); budgetExhausted = true; cut('max_tokens'); return false
  }
  try {
    out.batchId = id(batchId)
    if ((memoryIds !== undefined) === (since !== undefined)) fail('exactly_one_scope_required')
    const requested = memoryIds === undefined ? null : ids(memoryIds)
    if (since !== undefined && time(since) === null) fail('invalid_since')
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) fail('invalid_limit')
    const cap = Math.min(limit ?? limits.maxMemories, limits.maxMemories)
    const selected = requested?.slice(0, cap)
    if (requested && requested.length > cap) cut('max_memories')
    out.scope = { mode: requested ? 'ids' : 'since', requestedMemoryIds: requested,
      readMemoryIds: selected ?? null, since: since ?? null, limit: cap, includedMemoryIds: [],
      timeUnit: 'epoch-seconds', timeBasis: 'max(recordedAt, changedAt, lastRecalled)' }
    if (!source || source.readOnly !== true || typeof source.readMemories !== 'function') fail('readonly_source_required')
    if (selected?.length === 0) {
      out.trafficNodes = []; out.memoryNodeLinks = []; out.trafficLinks = []
      out.status = 'ok'; return out
    }
    const response = await withDeadline(signal => source.readMemories({
      ...(selected ? { memoryIds: selected } : { since }), limit: cap, signal
    }), deadline, controller)
    if (!object(response) || !Array.isArray(response.rows) || typeof response.complete !== 'boolean') fail('invalid_memory_response')
    if (response.rows.length > cap || Buffer.byteLength(JSON.stringify(response)) > limits.maxResponseBytes) fail('memory_response_over_budget')
    const readId = evidence(response, 'memories')
    if (!response.complete) { issue('memory_scope_incomplete'); cut('source_memory_limit') }
    const allowed = new Set(selected)
    const rows = uniqueRows(response.rows, row => id(row.memoryId))
    const seen = new Set(rows.map(row => id(row.memoryId)))
    if (selected?.some(k => !seen.has(k))) issue('requested_memories_missing')
    const normalized = []
    for (const row of rows) {
      checkDeadline()
      const memoryId = id(row.memoryId)
      if (selected && !allowed.has(memoryId)) fail('memory_outside_scope')
      if (typeof row.status !== 'string' || row.isActive === null) { issue('memory_status_unknown'); continue }
      if (!active(row)) continue
      // Occurrence is intentionally independent of recorded/learned/recalled timestamps.
      const recordedAt = time(row.recordedAt) ?? time(row.learnedAt) ?? time(row.timestamp)
      const changedAt = time(row.changedAt)
      const lastRecalled = time(row.lastRecalled)
      const cursor = Math.max(recordedAt ?? 0, changedAt ?? 0, lastRecalled ?? 0)
      if (since !== undefined) {
        if (cursor === 0) { issue('memory_cursor_time_missing'); continue }
        if (cursor < since) continue
      }
      normalized.push({ memoryId, summary: text(row.summary), source: typeof row.source === 'string' ? row.source : null,
        status: row.status, occurredAt: time(row.occurredAt), recordedAt, changedAt, lastRecalled,
        evidence: { readId, selector: { memoryId }, kind: 'summary', originalQuoteAvailable: false } })
    }
    normalized.sort((a, b) => (b.recordedAt ?? 0) - (a.recordedAt ?? 0) || cmp(a.memoryId, b.memoryId))
    for (const row of normalized) {
      if (!addWithinBudget(out.memories, row)) break
    }
    out.scope.includedMemoryIds = out.memories.map(row => row.memoryId)
    if (!out.memories.length && normalized.length) fail('memory_content_exceeds_budget')
    if (budgetExhausted) return out
    if (typeof source.readLocalGraph !== 'function') { issue('local_graph_reader_unavailable'); return out }
    if (!out.memories.length) {
      out.trafficNodes = []; out.memoryNodeLinks = []; out.trafficLinks = []
    } else {
      let graph
      try {
        graph = await withDeadline(signal => source.readLocalGraph({
          memoryIds: out.scope.includedMemoryIds, maxHops: limits.maxHops, maxNeighbors: limits.maxNeighbors,
          maxNodes: limits.maxNodes, maxEdges: limits.maxEdges, signal
        }), deadline, controller)
      } catch (error) {
        issue(error?.message === 'read_timeout' ? 'read_timeout' : 'local_graph_read_failed')
        return out
      }
      checkDeadline()
      if (!object(graph) || !Array.isArray(graph.trafficNodes) || !Array.isArray(graph.memoryNodeLinks)
        || !Array.isArray(graph.trafficLinks) || typeof graph.complete !== 'boolean') fail('invalid_local_graph_response')
      if (graph.trafficNodes.length > limits.maxNodes
        || graph.memoryNodeLinks.length + graph.trafficLinks.length > limits.maxEdges
        || Buffer.byteLength(JSON.stringify(graph)) > limits.maxResponseBytes) fail('graph_response_over_budget')
      const graphReadId = evidence(graph, 'local-graph')
      if (!graph.complete) { issue('local_graph_incomplete'); cut('source_graph_limit') }
      out.graphVersion = typeof graph.version === 'string' ? graph.version : null
      if (!out.graphVersion) issue('graph_version_unavailable')
      if (typeof response.version === 'string' && out.graphVersion !== response.version) {
        fail('source_version_changed')
      }
      const nodes = new Map(uniqueRows(graph.trafficNodes, row => id(row.nodeId)).map(row => [id(row.nodeId), row]))
      const memorySet = new Set(out.scope.includedMemoryIds)
      const roots = uniqueRows(graph.memoryNodeLinks, row => id(row.linkId))
      const edges = uniqueRows(graph.trafficLinks, row => id(row.linkId))
      const usable = link => {
        if (typeof link.status !== 'string') { issue('link_status_unknown'); return false }
        return active(link)
      }
      const eligible = nodeId => {
        const node = nodes.get(nodeId)
        if (!node) { issue('link_node_missing'); return false }
        if (typeof node.status !== 'string') { issue('node_status_unknown'); return false }
        return active(node)
      }
      out.trafficNodes = []; out.memoryNodeLinks = []; out.trafficLinks = []
      const visited = new Set(), paths = new Map(), selectedEdges = new Set()
      const addNode = (nodeId, path) => {
        if (visited.has(nodeId)) return true
        const row = nodes.get(nodeId)
        const node = { nodeId, canonicalName: text(row.canonicalName, 256),
          aliases: row.aliases === undefined ? null : row.aliases,
          sourceMemoryIds: row.sourceMemoryIds === undefined ? null : ids(row.sourceMemoryIds),
          status: row.status, path,
          evidence: { readId: graphReadId, selector: { nodeId } } }
        if (node.aliases !== null && (!Array.isArray(node.aliases) || !node.aliases.every(v => typeof v === 'string'))) fail('invalid_aliases')
        if (!addWithinBudget(out.trafficNodes, node)) return false
        visited.add(nodeId); paths.set(nodeId, path); return true
      }
      const adjacency = new Map()
      const room = (a, b) => {
        const canAdd = (x, y) => adjacency.get(x)?.has(y) || (adjacency.get(x)?.size ?? 0) < limits.maxNeighbors
        return canAdd(a, b) && canAdd(b, a)
      }
      const connect = (a, b) => {
        if (!adjacency.has(a)) adjacency.set(a, new Set())
        if (!adjacency.has(b)) adjacency.set(b, new Set())
        adjacency.get(a).add(b); adjacency.get(b).add(a)
      }
      for (const link of roots.sort((a, b) => cmp(id(a.linkId), id(b.linkId)))) {
        checkDeadline()
        const memoryId = id(link.memoryId), nodeId = id(link.nodeId)
        if (!memorySet.has(memoryId)) fail('graph_memory_outside_scope')
        if (!usable(link) || !eligible(nodeId)) continue
        if (limits.maxHops === 0) { cut('max_hops'); continue }
        const memoryKey = 'memory:' + memoryId, nodeKey = 'traffic:' + nodeId
        if (!room(memoryKey, nodeKey)) { cut('max_neighbors'); continue }
        const existed = visited.has(nodeId)
        if (!addNode(nodeId, [{ kind: 'memory', id: memoryId }, { kind: 'traffic', id: nodeId }])) break
        if (!addWithinBudget(out.memoryNodeLinks, { linkId: id(link.linkId), memoryId, nodeId,
          evidence: { readId: graphReadId, selector: { linkId: id(link.linkId) }, kind: 'explicit-memory-node-link' } })) {
          if (!existed) { out.trafficNodes.pop(); visited.delete(nodeId); paths.delete(nodeId) }
          break
        }
        connect(memoryKey, nodeKey)
      }
      let frontier = [...visited].sort(cmp)
      // One hop is the memory -> traffic attachment; remaining hops follow traffic links.
      for (let hop = 1; hop < limits.maxHops && frontier.length && !budgetExhausted; hop++) {
        const next = new Set()
        for (const from of frontier) {
          if (budgetExhausted) break
          checkDeadline()
          const neighbors = edges.filter(edge => String(edge.from) === from || String(edge.to) === from)
            .sort((a, b) => cmp(id(a.linkId), id(b.linkId)))
          let count = 0
          for (const edge of neighbors) {
            const a = id(edge.from), b = id(edge.to), linkId = id(edge.linkId)
            if (!usable(edge) || !eligible(a) || !eligible(b)) continue
            if (count++ >= limits.maxNeighbors) { cut('max_neighbors'); continue }
            if (selectedEdges.has(linkId)) continue
            if (!room('traffic:' + a, 'traffic:' + b)) { cut('max_neighbors'); continue }
            const to = a === from ? b : a
            const wasVisited = visited.has(to)
            if (!addNode(to, [...paths.get(from), { kind: 'traffic', id: to }])) break
            if (!addWithinBudget(out.trafficLinks, { linkId, from: a, to: b,
              relation: typeof edge.relation === 'string' ? edge.relation : null,
              evidence: { readId: graphReadId, selector: { linkId }, kind: 'explicit-traffic-link' } })) {
              if (!wasVisited) { out.trafficNodes.pop(); visited.delete(to); paths.delete(to) }
              break
            }
            selectedEdges.add(linkId)
            connect('traffic:' + a, 'traffic:' + b)
            if (!wasVisited) next.add(to)
          }
        }
        frontier = [...next].sort(cmp)
      }
      if (edges.some(edge => !selectedEdges.has(String(edge.linkId)) && usable(edge)
        && (visited.has(String(edge.from)) || visited.has(String(edge.to))))) cut('max_hops_or_local_boundary')
      // Extra disconnected nodes must not silently leak into the candidate package.
      if (nodes.size > visited.size) issue('unreachable_graph_nodes_omitted')
    }
    if (validateTypedGraphLinks({ memoryIds: out.scope.includedMemoryIds,
      trafficNodeIds: out.trafficNodes.map(node => node.nodeId),
      memoryNodeLinks: out.memoryNodeLinks, trafficLinks: out.trafficLinks }).length) {
      fail('invalid_typed_graph_link')
    }
    out.status = 'ok'
  } catch (error) {
    issue(['invalid_id', 'invalid_ids', 'invalid_text', 'invalid_limit', 'invalid_since', 'exactly_one_scope_required',
      'readonly_source_required', 'read_timeout', 'source_evidence_missing', 'conflicting_duplicate',
      'invalid_memory_response', 'memory_response_over_budget', 'memory_outside_scope',
      'invalid_local_graph_response', 'graph_response_over_budget', 'graph_memory_outside_scope',
      'memory_content_exceeds_budget', 'invalid_aliases', 'invalid_typed_graph_link', 'source_version_changed', 'http_since_scope_unsupported',
      'http_id_invalid', 'http_transport_failed', 'http_status_failed', 'http_body_budget',
      'http_invalid_json', 'http_invalid_payload'].includes(error?.message) ? error.message : 'source_read_failed')
    // A rejected graph is unknown, never a partially validated graph that looks usable.
    out.trafficNodes = null; out.memoryNodeLinks = null; out.trafficLinks = null; out.graphVersion = null
    out.status = 'blocked'
    return out
  } finally {
    controller.abort()
    out.budget.used = Buffer.byteLength(JSON.stringify(payload()))
    if (out.status !== 'ok' && out.memories.length) out.status = 'partial'
    if (out.status === 'ok' && (out.issues.length || out.truncation.length)) out.status = 'partial'
  }
  return out
}

/** Existing HTTP API supports scoped IDs only. It has no bounded local graph/since endpoint. */
export function createCandidateHttpSource ({ origin = 'http://127.0.0.1:3080', fetchImpl = globalThis.fetch } = {}) {
  const base = new URL(origin)
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.pathname !== '/' || base.search || base.hash) fail('endpoint_not_allowed')
  return {
    readOnly: true,
    async readMemories ({ memoryIds, signal }) {
      if (!Array.isArray(memoryIds)) fail('http_since_scope_unsupported')
      if (memoryIds.length > 1000) fail('memory_response_over_budget')
      const numeric = memoryIds.map(value => {
        if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail('http_id_invalid')
        return String(value)
      })
      const rows = []
      let bytes = 0
      for (let i = 0; i < numeric.length; i += 50) {
        const url = new URL('/api/echo/memories', base)
        url.searchParams.set('ids', numeric.slice(i, i + 50).join(','))
        let response
        try {
          response = await fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit', signal })
        } catch { fail('http_transport_failed') }
        if (response?.ok !== true) fail('http_status_failed')
        if (Number(response.headers?.get('content-length')) > 2 * 1024 * 1024 - bytes) fail('http_body_budget')
        // Stream under a byte ceiling; never buffer an unbounded production response.
        if (!response.body?.getReader) fail('http_invalid_payload')
        const reader = response.body.getReader()
        const chunks = []
        try {
          for (;;) {
            const part = await reader.read()
            if (part.done) break
            bytes += part.value.byteLength
            if (bytes > 2 * 1024 * 1024) fail('http_body_budget')
            chunks.push(Buffer.from(part.value))
          }
        } catch (error) {
          await reader.cancel().catch(() => {})
          throw error
        } finally { reader.releaseLock() }
        const body = Buffer.concat(chunks).toString('utf8')
        let data
        try { data = JSON.parse(body) } catch { fail('http_invalid_json') }
        if (!Array.isArray(data?.rows) || data.rows.length > 50) fail('http_invalid_payload')
        rows.push(...data.rows)
      }
      return { rows, complete: true, evidence: { kind: 'http-get', path: '/api/echo/memories' } }
    }
  }
}
