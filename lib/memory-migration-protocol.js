import { createHash } from 'node:crypto'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = code => { throw new Error(code) }
const ID = /^[A-Za-z0-9:_-]{1,128}$/u
const HASH = /^[a-f0-9]{64}$/iu
const SOURCE_TABLES = Object.freeze({
  legacy_memory: 'episodic_memory',
  legacy_traffic_node: 'graph_nodes',
  legacy_traffic_edge: 'graph_edges'
})
const COMMANDS = Object.freeze({
  attach_memory_to_node: ['memoryId', 'nodeId'],
  create_traffic_node: ['nodeId', 'canonicalName', 'aliases'],
  add_traffic_alias: ['nodeId', 'alias'],
  connect_traffic_nodes: ['fromNodeId', 'toNodeId', 'relation']
})
const STATUSES = new Set(['accepted', 'review', 'rejected', 'noop'])

function exactKeys (value, allowed, required = allowed) {
  if (!object(value)) fail('invalid_object')
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('unknown_field')
  if (required.some(key => !Object.hasOwn(value, key))) fail('missing_field')
}

function id (value) {
  if (typeof value !== 'string' || !ID.test(value)) fail('invalid_id')
  return value
}

function text (value, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid_text')
  return value
}

function validateSelector (selector) {
  exactKeys(selector, ['sourceKind', 'sourceTable', 'sourceId', 'sourceSnapshot', 'sourceHash'])
  if (!Object.hasOwn(SOURCE_TABLES, selector.sourceKind)
    || selector.sourceTable !== SOURCE_TABLES[selector.sourceKind]) fail('source_kind_table_mismatch')
  id(selector.sourceId)
  id(selector.sourceSnapshot)
  if (typeof selector.sourceHash !== 'string' || !HASH.test(selector.sourceHash)) fail('invalid_source_hash')
  return selector
}

function validateRefs (refs, selector) {
  if (!Array.isArray(refs) || refs.length > 16) fail('invalid_evidence_refs')
  for (const ref of refs) {
    exactKeys(ref, ['sourceKind', 'sourceTable', 'sourceId', 'sourceSnapshot', 'sourceHash', 'role'])
    const picked = validateSelector({
      sourceKind: ref.sourceKind, sourceTable: ref.sourceTable, sourceId: ref.sourceId,
      sourceSnapshot: ref.sourceSnapshot, sourceHash: ref.sourceHash
    })
    if (!['source', 'supports-traffic-edge', 'supports-target-node'].includes(ref.role)) fail('invalid_evidence_role')
    if (ref.role === 'supports-traffic-edge' && picked.sourceKind !== 'legacy_traffic_edge') fail('edge_evidence_wrong_source')
    if (ref.role === 'supports-target-node' && picked.sourceKind !== 'legacy_traffic_node') fail('target_evidence_wrong_source')
    if (picked.sourceKind === 'legacy_traffic_edge' && ref.role !== 'supports-traffic-edge') fail('edge_evidence_wrong_role')
    if (selector && picked.sourceKind !== selector.sourceKind && ref.role === 'source') fail('evidence_source_kind_mismatch')
  }
}

function validateSpans (spans, memoryIds) {
  if (!Array.isArray(spans) || spans.length > 32) fail('invalid_evidence_spans')
  for (const span of spans) {
    exactKeys(span, ['memoryId', 'start', 'end', 'sourceHash'])
    if (!memoryIds.has(id(span.memoryId)) || !Number.isSafeInteger(span.start)
      || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start
      || typeof span.sourceHash !== 'string' || !HASH.test(span.sourceHash)) fail('invalid_evidence_span')
  }
}

function validateTarget (target, sourceKind) {
  if (target === null) return null
  if (sourceKind === 'legacy_memory') {
    exactKeys(target, ['kind', 'trafficNodeId'])
    if (target.kind !== 'traffic_node') fail('memory_target_must_be_traffic')
    id(target.trafficNodeId)
  } else if (sourceKind === 'legacy_traffic_node') {
    exactKeys(target, ['kind', 'trafficNodeId'])
    if (target.kind !== 'traffic_node') fail('node_target_must_be_traffic')
    id(target.trafficNodeId)
  } else {
    exactKeys(target, ['kind', 'fromTrafficNodeId', 'toTrafficNodeId'])
    if (target.kind !== 'traffic_edge') fail('edge_target_must_be_traffic_edge')
    id(target.fromTrafficNodeId); id(target.toTrafficNodeId)
  }
  return target
}

function matchCommandTarget (command, target) {
  if (!command) return
  if (!target) fail('command_target_missing')
  if (command.op === 'attach_memory_to_node' && target.trafficNodeId !== command.nodeId) fail('command_target_mismatch')
  if (command.op === 'create_traffic_node' && target.trafficNodeId !== command.nodeId) fail('command_target_mismatch')
  if (command.op === 'add_traffic_alias' && target.trafficNodeId !== command.nodeId) fail('command_target_mismatch')
  if (command.op === 'connect_traffic_nodes'
    && (target.fromTrafficNodeId !== command.fromNodeId || target.toTrafficNodeId !== command.toNodeId)) fail('command_target_mismatch')
}

function validateDecision (item) {
  const decision = item.humanDecision
  if (decision === null) return
  exactKeys(decision, ['state', 'reviewer', 'decision', 'reason', 'selectedTrafficNodeId',
    'selectedAttachmentIndices'], ['state'])
  if (decision.state === 'pending') {
    if (Array.isArray(item.attachments)) {
      if (Object.keys(decision).some(key => !['state', 'selectedAttachmentIndices'].includes(key))) {
        fail('pending_review_has_decision')
      }
      if (decision.selectedAttachmentIndices !== undefined && !Array.isArray(decision.selectedAttachmentIndices)) {
        fail('selected_attachments_required')
      }
      return
    }
    if (Object.keys(decision).some(key => !['state', 'selectedTrafficNodeId'].includes(key))) {
      fail('pending_review_has_decision')
    }
    if (decision.selectedTrafficNodeId !== undefined) {
      const selected = id(decision.selectedTrafficNodeId)
      if (!item.reviewOptions.some(option => option.trafficNodeId === selected)) fail('review_target_not_selected')
    }
    return
  }
  if (decision.state !== 'decided' || !['approve', 'reject'].includes(decision.decision)) fail('invalid_human_decision')
  text(decision.reviewer, 128); text(decision.reason, 512)
  if (decision.decision === 'approve') {
    if (Array.isArray(item.attachments)) {
      if (decision.selectedTrafficNodeId !== undefined) fail('single_target_decision_for_multi_attachment')
      if (!Array.isArray(decision.selectedAttachmentIndices) || !decision.selectedAttachmentIndices.length) {
        fail('selected_attachments_required')
      }
      const selected = decision.selectedAttachmentIndices
      if (!selected.every(index => Number.isSafeInteger(index) && index >= 0 && index < item.attachments.length)
        || new Set(selected).size !== selected.length) {
        fail('review_attachment_selection_invalid')
      }
      return
    }
    if (decision.selectedAttachmentIndices !== undefined) fail('attachment_indices_without_attachments')
    const selected = id(decision.selectedTrafficNodeId)
    if (!item.reviewOptions.some(option => option.trafficNodeId === selected)) fail('review_target_not_selected')
    if (item.command?.op === 'attach_memory_to_node' && item.command.nodeId !== selected) fail('review_target_command_mismatch')
    if (item.command?.op === 'add_traffic_alias' && item.command.nodeId !== selected) fail('review_target_command_mismatch')
    if (!['attach_memory_to_node', 'add_traffic_alias'].includes(item.command?.op)) fail('review_command_not_resolvable')
  }
}

function validateAttachmentEvidence (command, spans, refs, sourceNodeMap) {
  if (command?.op !== 'attach_memory_to_node') return
  if (!spans.length) fail('memory_attachment_evidence_span_missing')
  const targetRef = refs.find(ref => ref.role === 'supports-target-node')
  if (!targetRef) fail('target_node_evidence_ref_missing')
  if (command.nodeId !== (sourceNodeMap.get(targetRef.sourceId) ?? `legacy:${targetRef.sourceId}`)) {
    fail('target_node_evidence_mismatch')
  }
}

function validateMemoryAttachments (item, { selector, sourceRow, memoryIds, trafficNodeIds, trafficNodes, sourceNodeMap }) {
  if (item.attachments === undefined) return null
  if (selector.sourceKind !== 'legacy_memory') fail('attachments_require_memory_source')
  const attachments = item.attachments
  if (!Array.isArray(attachments) || attachments.length < 1 || attachments.length > 16) fail('invalid_attachments')
  const seen = new Set()
  const summary = sourceRow?.summary
  if (typeof summary !== 'string' || String(sourceRow.memory_id) !== selector.sourceId
    || Number(sourceRow.is_active) !== 1 || (sourceRow.status && sourceRow.status !== 'active')
    || (sourceRow.superseded_by && String(sourceRow.superseded_by) !== '')) fail('memory_inactive_or_superseded')
  const validated = []
  for (const attachment of attachments) {
    exactKeys(attachment, ['trafficNodeId', 'evidenceSpan', 'targetEvidenceRef'])
    const nodeId = id(attachment.trafficNodeId)
    if (seen.has(nodeId)) fail('duplicate_attachment_target')
    seen.add(nodeId)
    if (!trafficNodeIds.has(nodeId)) fail('attachment_target_outside_scope')
    const node = trafficNodes.find(row => row.nodeId === nodeId)
    if (!node) fail('attachment_target_missing')
    const span = attachment.evidenceSpan
    exactKeys(span, ['memoryId', 'start', 'end', 'sourceHash'])
    if (span.memoryId !== selector.sourceId || !memoryIds.has(span.memoryId)
      || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
      || span.start < 0 || span.end <= span.start || span.end > summary.length
      || span.sourceHash !== createHash('sha256').update(summary).digest('hex')) fail('attachment_evidence_span_invalid')
    const matchedName = [node.canonicalName, ...(node.aliases ?? [])]
      .some(name => summary.slice(span.start, span.end) === String(name))
    if (!matchedName) fail('attachment_evidence_target_mismatch')
    const ref = attachment.targetEvidenceRef
    exactKeys(ref, ['sourceKind', 'sourceTable', 'sourceId', 'sourceSnapshot', 'sourceHash', 'role'])
    validateSelector({ sourceKind: ref.sourceKind, sourceTable: ref.sourceTable, sourceId: ref.sourceId,
      sourceSnapshot: ref.sourceSnapshot, sourceHash: ref.sourceHash })
    if (ref.role !== 'supports-target-node' || ref.sourceKind !== 'legacy_traffic_node') {
      fail('attachment_target_ref_invalid')
    }
    const resolvedTarget = sourceNodeMap.get(ref.sourceId) ?? `legacy:${ref.sourceId}`
    if (resolvedTarget !== nodeId) fail('attachment_target_ref_mismatch')
    validated.push({ index: validated.length, trafficNodeId: nodeId, evidenceSpan: span, targetEvidenceRef: ref })
  }
  if (attachments.length > 1 && item.status !== 'review'
    && (item.humanDecision?.state !== 'decided' || item.humanDecision.decision !== 'approve')) {
    fail('multi_attachment_requires_human_approval')
  }
  const decision = item.humanDecision
  if (item.status === 'review' && decision?.state === 'pending') return validated
  if (decision?.decision === 'approve') {
    const selected = decision.selectedAttachmentIndices
    if (!Array.isArray(selected) || !selected.length
      || !selected.every(index => Number.isSafeInteger(index) && index >= 0 && index < attachments.length)
      || new Set(selected).size !== selected.length) {
      fail('review_attachment_selection_invalid')
    }
    return validated.filter(attachment => selected.includes(attachment.index))
  }
  if (attachments.length > 1) fail('multi_attachment_requires_human_approval')
  return validated
}

function validateCommand (command, { selector, sourceRow, sourceNodeMap = new Map(), memoryIds, trafficNodeIds, trafficNodes }) {
  if (!object(command) || !Object.hasOwn(COMMANDS, command.op)) fail('unknown_migration_command')
  exactKeys(command, ['op', ...COMMANDS[command.op]])
  if (command.op === 'attach_memory_to_node') {
    if (selector.sourceKind !== 'legacy_memory') fail('memory_attachment_requires_memory_source')
    if (!sourceRow || String(sourceRow.memory_id) !== selector.sourceId) fail('source_row_required')
    if (Number(sourceRow.is_active) !== 1 || (sourceRow.status && sourceRow.status !== 'active')
      || (sourceRow.superseded_by && String(sourceRow.superseded_by) !== '')) fail('memory_inactive_or_superseded')
    if (!memoryIds.has(id(command.memoryId))) fail('memory_outside_scope')
    if (command.memoryId !== selector.sourceId) fail('memory_source_id_mismatch')
    if (!trafficNodeIds.has(id(command.nodeId))) fail('node_outside_scope')
  } else if (command.op === 'create_traffic_node') {
    if (selector.sourceKind !== 'legacy_traffic_node') fail('traffic_node_requires_node_source')
    id(command.nodeId); text(command.canonicalName, 256)
    if (command.nodeId !== `legacy:${selector.sourceId}`) fail('traffic_node_source_id_mismatch')
    if (!Array.isArray(command.aliases) || command.aliases.length > 32) fail('invalid_aliases')
    for (const alias of command.aliases) text(alias, 256)
    const names = new Set([command.canonicalName, ...command.aliases].map(name => name.normalize('NFKC').trim().toLocaleLowerCase()))
    const conflicts = trafficNodes.filter(node => node.nodeId !== command.nodeId
      && [node.canonicalName, ...(node.aliases ?? [])].some(name => names.has(String(name).normalize('NFKC').trim().toLocaleLowerCase())))
    if (conflicts.length) return conflicts.map(node => node.nodeId)
  } else if (command.op === 'add_traffic_alias') {
    if (selector.sourceKind !== 'legacy_traffic_node') fail('traffic_alias_requires_node_source')
    if (!sourceRow || String(sourceRow.node_id) !== selector.sourceId) fail('source_row_required')
    if (Number(sourceRow.is_active) !== 1 || (sourceRow.superseded_by && String(sourceRow.superseded_by) !== '')) {
      fail('source_node_inactive')
    }
    if (command.alias !== String(sourceRow.name || '')) fail('alias_must_match_source_name')
    const target = trafficNodes.find(node => node.nodeId === id(command.nodeId))
    if (!target) fail('node_outside_scope')
  } else {
    if (selector.sourceKind !== 'legacy_traffic_edge') fail('traffic_edge_requires_edge_source')
    const from = id(command.fromNodeId), to = id(command.toNodeId)
    if (!sourceRow || String(sourceRow.edge_id) !== selector.sourceId) fail('source_row_required')
    if (Number(sourceRow.is_active) !== 1 || (sourceRow.superseded_by && Number(sourceRow.superseded_by) !== 0)) {
      fail('source_edge_inactive')
    }
    if (typeof sourceRow.evidence !== 'string' || !sourceRow.evidence.trim()) fail('source_edge_evidence_missing')
    const sourceFrom = sourceNodeMap.get(String(sourceRow.source_id)) ?? `legacy:${sourceRow.source_id}`
    const sourceTo = sourceNodeMap.get(String(sourceRow.target_id)) ?? `legacy:${sourceRow.target_id}`
    if (!((from === sourceFrom && to === sourceTo) || (from === sourceTo && to === sourceFrom))) {
      fail('traffic_edge_source_mismatch')
    }
    const sourceRelation = String(sourceRow.relation || '相关')
    if (command.relation !== sourceRelation) fail('traffic_edge_relation_mismatch')
    if (!trafficNodeIds.has(from) || !trafficNodeIds.has(to)) fail('traffic_link_endpoint_type_mismatch')
    if (from === to) fail('self_connection')
    text(command.relation, 128)
  }
}

export function validateMemoryMigrationItem ({ item, sourceRow = null, sourceNodeMap = new Map(),
  memoryIds = [], trafficNodeIds = [], trafficNodes = [] } = {}) {
  const result = { schema: 'echo-memory-migration-validation/v1', status: 'rejected', reason: null,
    itemId: null, sourceSelector: null, command: null, evidenceRefs: [], evidenceSpans: [],
    humanDecision: null, commitAllowed: false }
  try {
    exactKeys(item, ['schema', 'itemId', 'sourceSelector', 'status', 'reason', 'command', 'target',
      'reviewOptions', 'evidenceRefs', 'evidenceSpans', 'humanDecision', 'attachments'],
    ['schema', 'itemId', 'sourceSelector', 'status', 'reason', 'command', 'target',
      'reviewOptions', 'evidenceRefs', 'evidenceSpans', 'humanDecision'])
    if (item.schema !== 'echo-memory-migration-item/v1') fail('invalid_schema')
    result.itemId = id(item.itemId)
    result.sourceSelector = validateSelector(item.sourceSelector)
    if (item.itemId !== migrationItemId(item.sourceSelector)) fail('item_id_selector_mismatch')
    result.status = item.status
    if (!STATUSES.has(item.status)) fail('invalid_status')
    if (typeof item.reason !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(item.reason)) fail('invalid_reason_code')
    result.reason = item.reason
    validateTarget(item.target, item.sourceSelector.sourceKind)
    if (!Array.isArray(item.reviewOptions) || item.reviewOptions.length > 32) fail('invalid_review_options')
    for (const option of item.reviewOptions) {
      exactKeys(option, ['kind', 'trafficNodeId'])
      if (option.kind !== 'traffic_node') fail('invalid_review_target_type')
      id(option.trafficNodeId)
    }
    result.evidenceRefs = item.evidenceRefs
    result.evidenceSpans = item.evidenceSpans
    result.humanDecision = item.humanDecision
    validateRefs(item.evidenceRefs, item.sourceSelector)
    const sourceRole = item.sourceSelector.sourceKind === 'legacy_traffic_edge' ? 'supports-traffic-edge' : 'source'
    if (!item.evidenceRefs.some(ref => ref.role === sourceRole
      && ref.sourceKind === item.sourceSelector.sourceKind && ref.sourceTable === item.sourceSelector.sourceTable
      && ref.sourceId === item.sourceSelector.sourceId && ref.sourceSnapshot === item.sourceSelector.sourceSnapshot
      && ref.sourceHash === item.sourceSelector.sourceHash)) fail('source_evidence_ref_missing')
    const memorySet = new Set(memoryIds.map(id))
    const trafficSet = new Set(trafficNodeIds.map(id))
    const attachments = validateMemoryAttachments(item, { selector: item.sourceSelector, sourceRow, memoryIds: memorySet,
      trafficNodeIds: trafficSet, trafficNodes, sourceNodeMap })
    validateSpans(item.evidenceSpans, memorySet)
    for (const span of item.evidenceSpans) {
      if (item.sourceSelector.sourceKind !== 'legacy_memory' || span.memoryId !== item.sourceSelector.sourceId
        || typeof sourceRow?.summary !== 'string' || span.end > sourceRow.summary.length
        || createHash('sha256').update(sourceRow.summary).digest('hex') !== span.sourceHash) {
        fail('evidence_span_source_mismatch')
      }
    }
    if (item.status === 'noop' || item.status === 'rejected') {
      if (item.command !== null) fail('terminal_item_has_command')
      if (item.status === 'noop' && item.humanDecision !== null) fail('noop_has_human_decision')
      if (item.status === 'rejected' && item.humanDecision !== null) {
        exactKeys(item.humanDecision, ['state', 'reviewer', 'decision', 'reason'])
        if (item.humanDecision.state !== 'decided' || item.humanDecision.decision !== 'reject') fail('invalid_human_decision')
        text(item.humanDecision.reviewer, 128); text(item.humanDecision.reason, 512)
      }
      return result
    }
    if (item.status === 'review') {
      validateDecision(item)
      if (item.humanDecision.state === 'pending') {
        if (attachments !== null) {
          result.status = 'review'
          result.attachments = []
          return result
        }
        if (item.command !== null) {
          validateCommand(item.command, { selector: item.sourceSelector, sourceRow, sourceNodeMap,
            memoryIds: memorySet, trafficNodeIds: trafficSet, trafficNodes })
          validateAttachmentEvidence(item.command, item.evidenceSpans, item.evidenceRefs, sourceNodeMap)
          matchCommandTarget(item.command, item.target)
        }
        result.status = 'review'
        return result
      }
      if (item.humanDecision.decision === 'reject') {
        result.status = 'rejected'; result.reason = 'human_rejected'; return result
      }
    }
    if (attachments !== null) {
      result.status = 'accepted'
      result.attachments = attachments
      result.command = null
      result.commitAllowed = false
      return result
    }
    if (!object(item.command)) fail('command_required')
    const conflicts = validateCommand(item.command, { selector: item.sourceSelector, sourceRow, sourceNodeMap, memoryIds: memorySet,
      trafficNodeIds: trafficSet, trafficNodes }) || []
    validateAttachmentEvidence(item.command, item.evidenceSpans, item.evidenceRefs, sourceNodeMap)
    matchCommandTarget(item.command, item.target)
    if (item.status === 'review') {
      if (conflicts.length && item.humanDecision?.decision !== 'approve') {
        result.status = 'review'; result.reason = 'name_or_alias_conflict'; return result
      }
      if (item.humanDecision?.decision !== 'approve') {
        result.status = 'review'; return result
      }
    }
    if (item.command.op === 'add_traffic_alias'
      && (item.humanDecision?.state !== 'decided' || item.humanDecision.decision !== 'approve')) {
      fail('traffic_alias_requires_human_approval')
    }
    if (conflicts.length && (item.humanDecision?.state !== 'decided' || item.humanDecision.decision !== 'approve')) {
      fail('name_conflict_requires_review')
    }
    if (item.humanDecision !== null) {
      validateDecision(item)
    }
    if (item.sourceSelector.sourceKind === 'legacy_traffic_edge'
      && item.command.op !== 'connect_traffic_nodes') fail('legacy_edge_cannot_create_memory_link')
    if (item.sourceSelector.sourceKind === 'legacy_memory'
      && item.command.op === 'connect_traffic_nodes') fail('memory_source_cannot_connect_traffic_edge')
    result.status = 'accepted'
    result.command = item.command
    result.commitAllowed = false
    return result
  } catch (error) {
    result.status = 'rejected'
    result.reason = error?.message || 'invalid_migration_item'
    result.command = null
    result.commitAllowed = false
    return result
  }
}

export function migrationItemId (selector) {
  validateSelector(selector)
  return `migration:${selector.sourceKind}:${selector.sourceId}`
}
