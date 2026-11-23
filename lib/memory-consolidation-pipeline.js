/** Pure phase-4 proposal pipeline. The caller is injected; no model, graph or store access. */
import { COMMAND_SCHEMA, validateConsolidationPlan } from './memory-consolidation-commands.js'

export const CONSOLIDATION_PROMPT_SCHEMA = 'echo-consolidation-prompt/v1'
export const PIPELINE_LIMITS = Object.freeze({
  maxPromptBytes: 65536,
  maxResponseBytes: 262144
})

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, max = 128) =>
  typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max
const boundedJson = (value, maxBytes) => {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > maxBytes) throw Error('response_budget_exceeded')
    try { value = JSON.parse(value) } catch { throw Error('model_invalid_json') }
  }
  if (!object(value)) throw Error('model_invalid_shape')
  let count = 0
  const inspect = (entry, depth) => {
    if (++count > 50000 || depth > 20) throw Error('response_budget_exceeded')
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') return
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw Error('model_invalid_json')
      return
    }
    if (!object(entry) && !Array.isArray(entry)) throw Error('model_invalid_json')
    if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(entry))) {
      throw Error('model_invalid_json')
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(entry))) {
      if (descriptor.get || descriptor.set) throw Error('model_invalid_json')
      inspect(descriptor.value, depth + 1)
    }
  }
  inspect(value, 0)
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized) > maxBytes) throw Error('response_budget_exceeded')
  return JSON.parse(serialized)
}

function candidateForPrompt (candidate) {
  if (!object(candidate) || candidate.schema !== 'echo-consolidation-candidates/v1'
    || candidate.readOnly !== true || candidate.status !== 'ok') throw Error('candidate_unavailable')
  if (!Array.isArray(candidate.issues) || !Array.isArray(candidate.truncation)
    || candidate.issues.length || candidate.truncation.length) throw Error('candidate_incomplete')
  if (!text(candidate.batchId, 160) || !text(candidate.graphVersion, 160)) throw Error('candidate_version_missing')
  if (!Array.isArray(candidate.memories) || !Array.isArray(candidate.trafficNodes)
    || !Array.isArray(candidate.memoryNodeLinks) || !Array.isArray(candidate.trafficLinks)) {
    throw Error('candidate_graph_unknown')
  }
  const memories = candidate.memories.map(row => ({
    memoryId: row?.memoryId,
    summary: row?.summary,
    occurredAt: row?.occurredAt ?? null,
    recordedAt: row?.recordedAt ?? null,
    status: row?.status
  }))
  const trafficNodes = candidate.trafficNodes.map(row => ({
    nodeId: row?.nodeId,
    canonicalName: row?.canonicalName,
    aliases: row?.aliases ?? null,
    status: row?.status
  }))
  const memoryNodeLinks = candidate.memoryNodeLinks.map(row => ({
    linkId: row?.linkId,
    memoryId: row?.memoryId,
    nodeId: row?.nodeId
  }))
  const trafficLinks = candidate.trafficLinks.map(row => ({
    linkId: row?.linkId,
    from: row?.from,
    to: row?.to,
    relation: row?.relation ?? null
  }))
  for (const memory of memories) {
    for (const key of ['occurredAt', 'recordedAt']) {
      if (memory[key] !== null && (typeof memory[key] !== 'number' || !Number.isFinite(memory[key]))) {
        throw Error('candidate_invalid')
      }
    }
  }
  if (trafficLinks.some(link => link.relation !== null && typeof link.relation !== 'string')) {
    throw Error('candidate_invalid')
  }
  return {
    schema: CONSOLIDATION_PROMPT_SCHEMA,
    batchId: candidate.batchId,
    sourceGraphVersion: candidate.graphVersion,
    memories,
    trafficNodes,
    memoryNodeLinks,
    trafficLinks
  }
}

export function buildConsolidationPrompt ({ candidate, limits = {}, maxPromptBytes = PIPELINE_LIMITS.maxPromptBytes } = {}) {
  if (!Number.isSafeInteger(maxPromptBytes) || maxPromptBytes < 1024
    || maxPromptBytes > PIPELINE_LIMITS.maxPromptBytes) throw Error('invalid_prompt_limit')
  const input = candidateForPrompt(candidate)
  const checked = validateConsolidationPlan({ candidate, limits, plan: {
    schema: COMMAND_SCHEMA, batchId: candidate.batchId, sourceGraphVersion: candidate.graphVersion, operations: []
  } })
  if (checked.status !== 'validated') throw Error('candidate_invalid')
  input.boundaries = checked.limits
  const body = JSON.stringify(input)
  const prompt = [
    'Produce one JSON object matching echo-consolidation-plan/v1.',
    'Use only the supplied candidate memories and local traffic graph.',
    'Propose bounded graph operations; do not rewrite memory summaries or invent evidence.',
    'Keep reasons concise (under 160 characters) and return an empty operations array when evidence is not decisive.',
    'Every operation must include operationId, op, reason, evidenceMemoryIds, evidenceSpans, confidence.',
    'Return JSON only. The host will validate the plan before any preview is considered.',
    body
  ].join('\n')
  if (Buffer.byteLength(prompt) > maxPromptBytes) throw Error('prompt_budget_exceeded')
  return { schema: CONSOLIDATION_PROMPT_SCHEMA, prompt, input }
}

function blocked (reason, extra = {}) {
  return {
    schema: 'echo-consolidation-pipeline/v1',
    status: 'blocked',
    reason,
    prompt: null,
    sourceVersion: null,
    batchId: null,
    validation: null,
    preview: [],
    commitAllowed: false,
    ...extra
  }
}

/**
 * Runs one injected structured proposal call and phase-3 validation.
 * The structuredCaller is the only external seam and receives no candidate source evidence.
 */
export async function runConsolidationPipeline ({
  candidate,
  structuredCaller,
  limits = {},
  maxPromptBytes = PIPELINE_LIMITS.maxPromptBytes,
  maxResponseBytes = PIPELINE_LIMITS.maxResponseBytes,
  signal
} = {}) {
  let promptPackage
  let snapshot
  try {
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0
      || maxResponseBytes > PIPELINE_LIMITS.maxResponseBytes) throw Error('invalid_response_limit')
    // Validate JSON descriptors before copying; an await must not change the validation baseline.
    snapshot = boundedJson(candidate, 2097152)
    promptPackage = buildConsolidationPrompt({ candidate: snapshot, limits, maxPromptBytes })
  } catch (error) {
    const reason = ['candidate_unavailable', 'candidate_incomplete', 'candidate_version_missing',
      'candidate_graph_unknown', 'candidate_invalid', 'invalid_prompt_limit', 'invalid_response_limit',
      'prompt_budget_exceeded'].includes(error?.message)
      ? error.message : 'prompt_build_failed'
    return blocked(reason)
  }
  if (typeof structuredCaller !== 'function') {
    return blocked('structured_caller_required', {
      prompt: promptPackage.prompt,
      batchId: promptPackage.input.batchId,
      sourceVersion: promptPackage.input.sourceGraphVersion
    })
  }
  let raw
  try {
    raw = await structuredCaller({
      prompt: promptPackage.prompt,
      schema: 'echo-consolidation-plan/v1',
      limits: { ...promptPackage.input.boundaries },
      maxOutputBytes: maxResponseBytes,
      signal
    })
  } catch (error) {
    const safeReason = ['route_unconfigured', 'channel_disabled', 'provider_timeout',
      'provider_max_tokens', 'caller_timeout', 'caller_aborted', 'response_budget_exceeded',
      'model_invalid_json', 'caller_prompt_budget_exceeded'].includes(error?.message)
      ? error.message : 'structured_caller_error'
    return blocked(safeReason, {
      prompt: promptPackage.prompt,
      batchId: promptPackage.input.batchId,
      sourceVersion: promptPackage.input.sourceGraphVersion
    })
  }
  let plan
  try {
    plan = boundedJson(raw, maxResponseBytes)
  } catch (error) {
    return blocked(error.message, {
      prompt: promptPackage.prompt,
      batchId: promptPackage.input.batchId,
      sourceVersion: promptPackage.input.sourceGraphVersion
    })
  }
  const validation = validateConsolidationPlan({ candidate: snapshot, plan, limits: promptPackage.input.boundaries })
  return {
    schema: 'echo-consolidation-pipeline/v1',
    status: validation.status === 'validated' ? 'validated'
      : validation.status === 'rejected' ? 'rejected' : 'blocked',
    reason: validation.reason,
    prompt: promptPackage.prompt,
    sourceVersion: validation.sourceVersion ?? promptPackage.input.sourceGraphVersion,
    batchId: validation.batchId ?? promptPackage.input.batchId,
    validation,
    preview: validation.preview,
    commitAllowed: false
  }
}
