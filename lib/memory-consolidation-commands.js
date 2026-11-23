/** Pure proposal validation. Acceptance is preview-only, never permission to commit. */
import { createHash } from 'node:crypto'
import { validateTypedGraphLinks } from './memory-consolidation-graph-contract.js'

export const COMMAND_SCHEMA = 'echo-consolidation-plan/v1'
export const COMMAND_LIMITS = Object.freeze({ maxOperations: 64, maxNewNodes: 16, maxEdges: 128 })
export const COMMAND_OPERATIONS = Object.freeze([
  'attach_memory_to_node', 'detach_memory_from_node', 'merge_traffic_nodes',
  'split_traffic_node', 'create_candidate_traffic_node', 'connect_traffic_nodes'
])
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const fail = code => { throw new Error(code) }
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const identifier = value => {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid_id')
  return value
}
const string = (v, max = 1000) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f]/u.test(v)) fail('invalid_text')
  return v
}
const nameKey = value => value.normalize('NFKC').trim().toLowerCase()
const array = (v, max = 1000) => { if (!Array.isArray(v) || v.length > max) fail('invalid_array'); return v }
function keys (value, allowed, required = allowed) {
  if (!object(value)) fail('invalid_object')
  if (Object.keys(value).some(k => !allowed.includes(k))) fail('unknown_field')
  if (required.some(k => !Object.hasOwn(value, k))) fail('missing_field')
}
function uniqueIds (value, min = 1) {
  const values = array(value).map(identifier)
  if (values.length < min || new Set(values).size !== values.length) fail('invalid_id_list')
  return values
}
function boundedJson (value, maxBytes) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > maxBytes) fail('input_budget_exceeded')
    try { value = JSON.parse(value) } catch { fail('invalid_json') }
  }
  let count = 0
  function check (x, depth) {
    if (++count > 50000 || depth > 20) fail('input_budget_exceeded')
    if (x === null || typeof x === 'boolean') return
    if (typeof x === 'number') { if (!Number.isFinite(x)) fail('invalid_json_value'); return }
    if (typeof x === 'string') { if (Buffer.byteLength(x) > maxBytes) fail('input_budget_exceeded'); return }
    if (!object(x) && !Array.isArray(x)) fail('invalid_json_value')
    if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(x))) fail('invalid_json_value')
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(x))) {
      if (descriptor.get || descriptor.set) fail('invalid_json_value')
      check(descriptor.value, depth + 1)
    }
  }
  check(value, 0)
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > maxBytes) fail('input_budget_exceeded')
  return JSON.parse(json)
}

function indexed (rows, field) {
  const result = new Map()
  for (const row of array(rows, 4096)) {
    if (!object(row)) fail('candidate_invalid')
    const id = identifier(row[field])
    if (result.has(id)) fail('candidate_duplicate_id')
    result.set(id, row)
  }
  return result
}

function candidateContext (candidate) {
  if (!object(candidate) || candidate.schema !== 'echo-consolidation-candidates/v1'
    || candidate.readOnly !== true || candidate.status !== 'ok') fail('candidate_incomplete')
  if (array(candidate.issues).length || array(candidate.truncation).length) fail('candidate_incomplete')
  identifier(candidate.batchId); identifier(candidate.graphVersion)
  const memories = indexed(candidate.memories, 'memoryId')
  const nodes = indexed(candidate.trafficNodes, 'nodeId')
  const memoryLinks = indexed(candidate.memoryNodeLinks, 'linkId')
  const trafficLinks = indexed(candidate.trafficLinks, 'linkId')
  const scope = new Set(uniqueIds(candidate.scope?.includedMemoryIds, 0))
  if (scope.size !== memories.size || [...memories.keys()].some(id => !scope.has(id))) fail('candidate_scope_invalid')
  const sourceEvidence = array(candidate.sourceEvidence)
  const proof = row => {
    const ref = row.evidence
    if (!object(ref) || !Number.isInteger(ref.readId) || ref.readId < 0
      || !object(sourceEvidence[ref.readId]) || sourceEvidence[ref.readId].readId !== ref.readId
      || !/^[a-f0-9]{64}$/i.test(sourceEvidence[ref.readId].sha256 ?? '')) fail('candidate_source_missing')
  }
  const names = new Set()
  for (const row of memories.values()) {
    if (row.status !== 'active' || typeof row.summary !== 'string' || !row.summary.trim()) fail('candidate_invalid')
    proof(row)
  }
  for (const row of nodes.values()) {
    if (row.status !== 'active') fail('candidate_invalid')
    string(row.canonicalName, 256); proof(row)
    names.add(nameKey(row.canonicalName))
    for (const alias of array(row.aliases ?? [], 128)) names.add(nameKey(string(alias, 256)))
  }
  for (const link of memoryLinks.values()) {
    if (!memories.has(link.memoryId) || !nodes.has(link.nodeId)) fail('candidate_scope_invalid')
    proof(link)
  }
  for (const link of trafficLinks.values()) {
    if (!nodes.has(link.from) || !nodes.has(link.to)) fail('candidate_scope_invalid')
    proof(link)
  }
  if (validateTypedGraphLinks({ memoryIds: memories.keys(), trafficNodeIds: nodes.keys(),
    memoryNodeLinks: memoryLinks.values(), trafficLinks: trafficLinks.values() }).length) fail('candidate_graph_invalid')
  return { memories, nodes, memoryLinks, trafficLinks, names }
}

const COMMON = ['operationId', 'op', 'reason', 'evidenceMemoryIds', 'evidenceSpans', 'confidence']
const FIELDS = Object.freeze({
  attach_memory_to_node: ['memoryId', 'nodeId'],
  detach_memory_from_node: ['memoryId', 'nodeId'],
  merge_traffic_nodes: ['nodeIds', 'targetNodeId'],
  split_traffic_node: ['nodeId', 'groups'],
  create_candidate_traffic_node: ['newNodeId', 'canonicalName'],
  connect_traffic_nodes: ['fromNodeId', 'toNodeId', 'relation']
})

function validateOperation (raw, ctx) {
  if (!object(raw)) fail('invalid_operation')
  if (!Object.hasOwn(FIELDS, raw.op)) fail('unknown_operation')
  keys(raw, [...COMMON, ...FIELDS[raw.op]])
  identifier(raw.operationId); string(raw.reason)
  if (typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 1) fail('invalid_confidence')
  const evidenceIds = uniqueIds(raw.evidenceMemoryIds)
  for (const id of evidenceIds) if (!ctx.memories.has(id)) fail('evidence_outside_scope')
  const spans = array(raw.evidenceSpans)
  if (!spans.length) fail('evidence_missing')
  for (const span of spans) {
    keys(span, ['memoryId', 'start', 'end', 'text'])
    if (!evidenceIds.includes(span.memoryId)) fail('evidence_not_declared')
    const summary = ctx.memories.get(span.memoryId).summary
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0
      || span.end <= span.start || span.end > summary.length
      || summary.slice(span.start, span.end) !== span.text) fail('evidence_span_mismatch')
  }
  if (evidenceIds.some(id => !spans.some(span => span.memoryId === id))) fail('evidence_missing')
  const requireMemory = value => {
    const id = identifier(value)
    if (!ctx.memories.has(id)) fail('memory_outside_scope')
    if (!evidenceIds.includes(id)) fail('target_memory_evidence_missing')
    return id
  }
  const requireNode = value => {
    const id = identifier(value)
    if (!ctx.nodes.has(id)) fail('node_outside_scope')
    return id
  }
  const mentions = (span, value) => {
    const summary = ctx.memories.get(span.memoryId).summary
    const normalize = text => ctx.normalizeMentions ? text.normalize('NFKC').toLowerCase() : text
    const text = normalize(span.text), needle = normalize(value)
    const offset = normalize(summary.slice(0, span.start)).length
    const whole = normalize(summary.slice(0, span.start)) + text + normalize(summary.slice(span.end))
    let at = text.indexOf(needle)
    while (at >= 0) {
      const end = at + needle.length
      const latin = /^[A-Za-z0-9_ ]+$/u.test(needle)
      if (!latin || (!/[A-Za-z0-9_]/u.test(whole[offset + at - 1] ?? '')
        && !/[A-Za-z0-9_]/u.test(whole[offset + end] ?? ''))) return true
      at = text.indexOf(needle, at + 1)
    }
    return false
  }
  const mentionsNode = (span, nodeId) => {
    const node = ctx.nodes.get(nodeId)
    return [node.canonicalName, ...(node.aliases ?? [])].some(name => mentions(span, name))
  }
  const newNode = (newNodeId, canonicalName, memoryIds) => {
    identifier(newNodeId); string(canonicalName, 128)
    if (ctx.nodes.has(newNodeId)) fail('new_node_id_exists')
    if (ctx.names.has(nameKey(canonicalName))) fail('new_node_name_exists')
    if (!memoryIds.every(id => spans.some(span => span.memoryId === id && mentions(span, canonicalName)))) fail('new_node_name_without_evidence')
    return { nodeId: newNodeId, canonicalName, sourceMemoryIds: [...memoryIds], status: 'candidate' }
  }
  const preview = { operationId: raw.operationId, op: raw.op, addNodes: [], addMemoryLinks: [],
    removeMemoryLinks: [], addTrafficLinks: [], removeTrafficLinks: [], nodeMapping: [],
    requiresBoundaryRecheck: false }
  const touched = new Set(), destructive = new Set()
  let fingerprint
  const pairLinks = (memoryId, nodeId) => [...ctx.memoryLinks.values()]
    .filter(l => l.memoryId === memoryId && l.nodeId === nodeId)
  const requireMention = (memoryId, nodeId) => {
    if (!spans.some(span => span.memoryId === memoryId && mentionsNode(span, nodeId))) fail('node_mention_evidence_missing')
  }
  switch (raw.op) {
    case 'attach_memory_to_node':
    case 'detach_memory_from_node': {
      const memoryId = requireMemory(raw.memoryId), nodeId = requireNode(raw.nodeId)
      const links = pairLinks(memoryId, nodeId)
      if (raw.op === 'attach_memory_to_node') {
        if (links.length) fail('memory_link_already_exists')
        requireMention(memoryId, nodeId)
        preview.addMemoryLinks.push({ memoryId, nodeId })
      } else {
        if (!links.length) fail('memory_link_missing')
        preview.removeMemoryLinks.push(...links.map(l => ({ linkId: l.linkId, memoryId, nodeId })))
      }
      touched.add(nodeId)
      fingerprint = JSON.stringify(['memory-link', memoryId, nodeId])
      break
    }
    case 'create_candidate_traffic_node':
      preview.addNodes.push(newNode(raw.newNodeId, raw.canonicalName, evidenceIds))
      fingerprint = JSON.stringify(['new-node', nameKey(raw.canonicalName)])
      break
    case 'connect_traffic_nodes': {
      const from = requireNode(raw.fromNodeId), to = requireNode(raw.toNodeId)
      if (from === to) fail('self_connection')
      if (raw.relation !== 'related') fail('unsupported_relation')
      if ([...ctx.trafficLinks.values()].some(l => (l.from === from && l.to === to) || (l.from === to && l.to === from))) fail('traffic_link_already_exists')
      if (!spans.some(span => mentionsNode(span, from) && mentionsNode(span, to))) fail('connection_evidence_missing')
      preview.addTrafficLinks.push({ from, to, relation: 'related' })
      touched.add(from); touched.add(to)
      fingerprint = JSON.stringify(['traffic-link', ...[from, to].sort()])
      break
    }
    case 'merge_traffic_nodes': {
      const nodeIds = uniqueIds(raw.nodeIds)
      if (nodeIds.length < 2) fail('merge_requires_multiple_nodes')
      nodeIds.forEach(requireNode)
      const target = requireNode(raw.targetNodeId)
      if (!nodeIds.includes(target)) fail('merge_target_not_member')
      const targetName = ctx.nodes.get(target).canonicalName
      for (const other of nodeIds.filter(id => id !== target)) {
        const otherName = ctx.nodes.get(other).canonicalName
        // Exact whole-summary assertions only, not a model's explanation or a name overlap.
        const assertions = [
          `${otherName} and ${targetName} refer to the same entity.`,
          `${targetName} and ${otherName} refer to the same entity.`,
          `${otherName}\u4e0e${targetName}\u6307\u540c\u4e00\u5bf9\u8c61\u3002`,
          `${targetName}\u4e0e${otherName}\u6307\u540c\u4e00\u5bf9\u8c61\u3002`
        ]
        if (!spans.some(span => assertions.includes(span.text)
          && ctx.memories.get(span.memoryId).summary === span.text)) fail('explicit_equivalence_evidence_missing')
        preview.nodeMapping.push({ from: other, to: target })
      }
      const mapping = new Map(preview.nodeMapping.map(m => [m.from, m.to]))
      for (const link of ctx.memoryLinks.values()) if (mapping.has(link.nodeId)) {
        if (!evidenceIds.includes(link.memoryId)) fail('merge_memory_evidence_missing')
        preview.removeMemoryLinks.push({ linkId: link.linkId, memoryId: link.memoryId, nodeId: link.nodeId })
        if (!pairLinks(link.memoryId, target).length) preview.addMemoryLinks.push({ memoryId: link.memoryId, nodeId: target })
      }
      for (const link of ctx.trafficLinks.values()) if (mapping.has(link.from) || mapping.has(link.to)) {
        touched.add(link.from); touched.add(link.to)
        const from = mapping.get(link.from) ?? link.from, to = mapping.get(link.to) ?? link.to
        preview.removeTrafficLinks.push({ linkId: link.linkId, from: link.from, to: link.to })
        if (from !== to) preview.addTrafficLinks.push({ from, to, relation: link.relation })
      }
      preview.requiresBoundaryRecheck = true
      nodeIds.forEach(id => { touched.add(id); destructive.add(id) })
      fingerprint = JSON.stringify(['merge', ...nodeIds.sort()])
      break
    }
    case 'split_traffic_node': {
      const nodeId = requireNode(raw.nodeId)
      const groups = array(raw.groups, 16)
      if (groups.length < 2) fail('split_requires_multiple_groups')
      const oldLinks = [...ctx.memoryLinks.values()].filter(l => l.nodeId === nodeId)
      const assigned = new Set()
      for (const group of groups) {
        keys(group, ['newNodeId', 'canonicalName', 'memoryIds'])
        const memoryIds = uniqueIds(group.memoryIds)
        memoryIds.forEach(requireMemory)
        for (const memoryId of memoryIds) {
          if (assigned.has(memoryId)) fail('split_duplicate_assignment')
          if (!oldLinks.some(l => l.memoryId === memoryId)) fail('split_memory_not_attached')
          assigned.add(memoryId)
          preview.addMemoryLinks.push({ memoryId, nodeId: group.newNodeId })
        }
        preview.addNodes.push(newNode(group.newNodeId, group.canonicalName, memoryIds))
      }
      if (oldLinks.some(l => !assigned.has(l.memoryId))) fail('split_partition_incomplete')
      preview.removeMemoryLinks.push(...oldLinks.map(l => ({ linkId: l.linkId, memoryId: l.memoryId, nodeId })))
      // Existing traffic edges are not guessed onto a split group.
      preview.requiresBoundaryRecheck = true
      touched.add(nodeId); destructive.add(nodeId)
      fingerprint = JSON.stringify(['split', nodeId])
      break
    }
  }
  for (const key of ['addNodes', 'addMemoryLinks', 'removeMemoryLinks', 'addTrafficLinks', 'removeTrafficLinks']) {
    preview[key] = [...new Map(preview[key].map(v => [JSON.stringify(v), v])).values()]
  }
  const trafficKey = link => JSON.stringify([
    ...(link.relation === 'related' ? [link.from, link.to].sort() : [link.from, link.to]), link.relation
  ])
  const removed = new Set(preview.removeTrafficLinks.map(l => l.linkId))
  const existing = new Set([...ctx.trafficLinks.values()].filter(l => !removed.has(l.linkId)).map(trafficKey))
  preview.addTrafficLinks = preview.addTrafficLinks.filter(link => {
    const key = trafficKey(link)
    if (existing.has(key)) return false
    existing.add(key); return true
  })
  const created = preview.addNodes.map(n => n.nodeId), createdNames = preview.addNodes.map(n => nameKey(n.canonicalName))
  if (new Set(created).size !== created.length || new Set(createdNames).size !== createdNames.length) fail('duplicate_new_node')
  return { command: raw, preview, touched: [...touched], destructive: [...destructive],
    fingerprint, created, createdNames }
}

export function validateConsolidationPlan ({ candidate, plan, limits = {}, allowPlannedNodes = false } = {}) {
  const out = { schema: 'echo-consolidation-validation/v1', status: 'blocked', reason: null,
    batchId: null, sourceVersion: null, candidateSha256: null, accepted: [], rejected: [], preview: [],
    limits: { ...COMMAND_LIMITS }, usage: { operations: 0, newNodes: 0, edges: 0 },
    commitAllowed: false, requiresSourceVersionRecheck: true }
  try {
    keys(limits, Object.keys(COMMAND_LIMITS), [])
    for (const key of Object.keys(COMMAND_LIMITS)) {
      if (limits[key] !== undefined) {
        if (!Number.isInteger(limits[key]) || limits[key] < 0 || limits[key] > COMMAND_LIMITS[key]) fail('invalid_limits')
        out.limits[key] = limits[key]
      }
    }
    const input = boundedJson(plan, 262144)
    keys(input, ['schema', 'batchId', 'sourceGraphVersion', 'operations'])
    if (input.schema !== COMMAND_SCHEMA) fail('invalid_plan_schema')
    out.batchId = identifier(input.batchId)
    out.sourceVersion = identifier(input.sourceGraphVersion)
    const operations = array(input.operations, 1024)
    const snapshot = boundedJson(candidate, 2097152)
    const ctx = candidateContext(snapshot)
    ctx.normalizeMentions = allowPlannedNodes === true
    out.candidateSha256 = digest(snapshot)
    if (input.batchId !== snapshot.batchId) fail('batch_mismatch')
    if (input.sourceGraphVersion !== snapshot.graphVersion) fail('source_version_mismatch')
    const reject = (index, reason) => ({ index, operationId: typeof operations[index]?.operationId === 'string'
      ? operations[index].operationId.slice(0, 128) : null, reason })
    if (operations.length > out.limits.maxOperations) {
      out.rejected = operations.map((_, i) => reject(i, 'operation_limit'))
      out.status = 'rejected'; out.reason = 'operation_limit'; return out
    }
    const checked = operations.map((operation, index) => {
      try {
        const validated = { index, ...validateOperation(operation, ctx) }
        if (allowPlannedNodes === true && operation.op === 'create_candidate_traffic_node') {
          for (const node of validated.preview.addNodes) {
            ctx.nodes.set(node.nodeId, { ...node, aliases: [], status: 'planned' })
            ctx.names.add(nameKey(node.canonicalName))
          }
        }
        return validated
      } catch (error) {
        out.rejected.push(reject(index, error.message)); return null
      }
    }).filter(Boolean)
    const count = values => {
      const counts = new Map()
      for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
      return counts
    }
    const operationIds = count(operations.map(op => object(op) ? op.operationId : undefined))
    const signatures = count(checked.map(op => op.fingerprint))
    const newIds = count(checked.flatMap(op => op.created))
    const newNames = count(checked.flatMap(op => op.createdNames))
    const valid = []
    for (const op of checked) {
      let reason = null
      if (operationIds.get(op.command.operationId) > 1) reason = 'duplicate_operation_id'
      else if (signatures.get(op.fingerprint) > 1) reason = 'duplicate_or_conflicting_operation'
      else if (op.created.some(id => newIds.get(id) > 1) || op.createdNames.some(name => newNames.get(name) > 1)) reason = 'duplicate_new_node'
      else if (checked.some(other => other !== op && (op.destructive.some(id => other.touched.includes(id))
        || other.destructive.some(id => op.touched.includes(id))))) reason = 'conflicting_node_operations'
      if (reason) out.rejected.push(reject(op.index, reason))
      else valid.push(op)
    }
    const usage = { operations: valid.length,
      newNodes: valid.reduce((n, op) => n + op.preview.addNodes.length, 0),
      edges: valid.reduce((n, op) => n + op.preview.addMemoryLinks.length + op.preview.removeMemoryLinks.length
        + op.preview.addTrafficLinks.length + op.preview.removeTrafficLinks.length, 0) }
    const budgetReason = usage.newNodes > out.limits.maxNewNodes ? 'new_node_limit'
      : usage.edges > out.limits.maxEdges ? 'edge_limit' : null
    if (budgetReason) {
      out.rejected.push(...valid.map(op => reject(op.index, budgetReason)))
    } else {
      out.accepted = valid.map(op => ({ index: op.index, operationId: op.command.operationId,
        reason: 'validated_for_preview', command: op.command }))
      out.preview = valid.map(op => op.preview)
      out.usage = usage
    }
    out.rejected.sort((a, b) => a.index - b.index)
    out.status = out.rejected.length ? 'rejected' : 'validated'
    out.reason = budgetReason ?? (out.rejected.length ? 'one_or_more_operations_rejected' : 'validated_for_preview_only')
    return out
  } catch (error) {
    out.reason = error instanceof TypeError || error instanceof RangeError ? 'invalid_input' : error.message
    return out
  }
}
