/** Pure one-batch preview orchestration. No persistence, timers, model or graph writes. */
import { readConsolidationCandidates } from './memory-consolidation-candidates.js'
import { consolidationState } from './memory-consolidation-state.js'
import { runConsolidationPipeline } from './memory-consolidation-pipeline.js'

const blocked = (reason, extra = {}) => ({
  schema: 'echo-consolidation-orchestration/v1',
  status: 'blocked',
  reason,
  batchId: null,
  state: null,
  candidate: null,
  validation: null,
  preview: [],
  commitAllowed: false,
  ...extra
})

export async function runConsolidationPreview ({
  now,
  clock = () => new Date(),
  timeZone = 'Asia/Shanghai',
  settings = {},
  record = null,
  memoryIds,
  since,
  limit,
  source,
  candidateReader = readConsolidationCandidates,
  structuredCaller,
  limits = {},
  maxPromptBytes,
  maxResponseBytes,
  signal
} = {}) {
  let current
  try {
    const at = now ?? clock()
    current = consolidationState({ now: at, settings, record, timeZone })
  } catch (error) {
    return blocked(error?.message === 'invalid_now' ? 'invalid_clock' : 'batch_state_failed')
  }
  const batchId = current.batch.batchId
  const base = { batchId, state: current, commitAllowed: false }
  if (!current.canRun) return blocked(current.reason, base)
  if ((memoryIds === undefined) === (since === undefined)) return blocked('exactly_one_scope_required', base)
  let candidate
  try {
    candidate = await candidateReader({
      batchId,
      memoryIds,
      since,
      limit,
      settings,
      source,
      signal
    })
  } catch {
    return blocked('candidate_reader_error', base)
  }
  if (!candidate || candidate.status !== 'ok') {
    return blocked(candidate?.status === 'partial' || candidate?.status === 'blocked'
      ? 'candidate_unavailable' : 'candidate_invalid', { ...base, candidate: candidate ?? null })
  }
  let pipeline
  try {
    pipeline = await runConsolidationPipeline({
      candidate,
      structuredCaller,
      limits,
      maxPromptBytes,
      maxResponseBytes,
      signal
    })
  } catch {
    return blocked('pipeline_error', { ...base, candidate })
  }
  return {
    schema: 'echo-consolidation-orchestration/v1',
    status: pipeline.status,
    reason: pipeline.reason,
    batchId,
    state: current,
    candidate,
    validation: pipeline.validation,
    preview: pipeline.preview,
    prompt: pipeline.prompt,
    sourceVersion: pipeline.sourceVersion,
    commitAllowed: false
  }
}
