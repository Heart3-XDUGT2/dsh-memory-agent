/** In-memory orchestration with injected reads/caller/clock. No persistence or scheduling. */
import { createHash } from 'node:crypto'
import { consolidationBatch } from './memory-consolidation-state.js'
import { candidateLimits } from './memory-consolidation-candidates.js'
import { buildConsolidationPrompt, runConsolidationPipeline } from './memory-consolidation-pipeline.js'
import { COMMAND_SCHEMA, validateConsolidationPlan } from './memory-consolidation-commands.js'

const DAY = 86400000
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const fail = code => { throw Error(code) }
const bytes = v => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v))
const sha = v => createHash('sha256').update(JSON.stringify(v)).digest('hex')
function copy (value) {
  let count = 0
  const visit = (v, depth) => {
    if (++count > 50000 || depth > 20) fail('input_budget')
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return
    if (typeof v === 'number' && Number.isFinite(v)) return
    if (!object(v) && !Array.isArray(v)) fail('invalid_json_input')
    if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(v))) fail('invalid_json_input')
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(v))) {
      if (descriptor.get || descriptor.set) fail('invalid_json_input')
      visit(descriptor.value, depth + 1)
    }
  }
  visit(value, 0)
  if (bytes(value) > 2097152) fail('input_budget')
  return JSON.parse(JSON.stringify(value))
}
function freeze (v) {
  if (v && typeof v === 'object') { Object.freeze(v); Object.values(v).forEach(freeze) }
  return v
}
async function abortable (signal, invoke) {
  if (signal?.aborted) fail('run_aborted')
  let listener
  try {
    const pending = Promise.resolve().then(() => {
      if (signal?.aborted) fail('run_aborted')
      return invoke()
    })
    return signal ? await Promise.race([pending, new Promise((resolve, reject) => {
      listener = () => reject(Error('run_aborted'))
      signal.addEventListener('abort', listener, { once: true })
      if (signal.aborted) listener()
    })]) : await pending
  } finally { if (listener) signal.removeEventListener('abort', listener) }
}
function scheduledTime (batchId) {
  if (typeof batchId !== 'string' || !/^memory-consolidation-\d{4}-\d{2}-\d{2}$/u.test(batchId)) fail('invalid_batch_state')
  const date = batchId.slice(-10)
  const ms = Date.parse(date + 'T22:00:00+08:00')
  if (!Number.isFinite(ms) || new Date(ms + 8 * 3600000).toISOString().slice(0, 10) !== date) fail('invalid_batch_state')
  return ms
}
function recordOf (raw) {
  if (raw === null || raw === undefined) return null
  const record = copy(raw)
  if (!object(record) || !['pending', 'failed', 'running', 'previewed', 'success', 'committed'].includes(record.status)
    || !Number.isSafeInteger(record.attempts) || record.attempts < 0 || record.attempts >= Number.MAX_SAFE_INTEGER) fail('invalid_batch_state')
  if (record.sourceVersion !== undefined && record.sourceVersion !== null
    && (typeof record.sourceVersion !== 'string' || !record.sourceVersion.trim() || record.sourceVersion.length > 128)) fail('invalid_batch_state')
  scheduledTime(record.batchId)
  return record
}
function checkGraph (candidate, bounds) {
  const adjacent = new Map()
  const join = (a, b) => {
    if (!adjacent.has(a)) adjacent.set(a, new Set())
    if (!adjacent.has(b)) adjacent.set(b, new Set())
    adjacent.get(a).add(b); adjacent.get(b).add(a)
  }
  for (const memory of candidate.memories) {
    for (const key of ['occurredAt', 'recordedAt']) {
      const value = memory[key]
      if (value !== null && value !== undefined && (typeof value !== 'number' || value <= 0 || !Number.isFinite(value))) fail('invalid_candidate_time')
    }
    // Pipeline forwards source; it must not become a nested metadata channel.
    memory.source = null
  }
  for (const node of candidate.trafficNodes) delete node.path
  for (const link of [...candidate.memoryNodeLinks, ...candidate.trafficLinks]) {
    if (link.status !== undefined && link.status !== 'active') fail('invalid_candidate_link_status')
    delete link.status
  }
  for (const link of candidate.memoryNodeLinks) join('m:' + link.memoryId, 'n:' + link.nodeId)
  for (const link of candidate.trafficLinks) {
    if (link.relation !== null && link.relation !== undefined && (typeof link.relation !== 'string' || link.relation.length > 256)) fail('invalid_candidate_relation')
    join('n:' + link.from, 'n:' + link.to)
  }
  if ([...adjacent.values()].some(set => set.size > bounds.maxNeighbors)) fail('candidate_neighbor_budget')
  const distance = new Map(candidate.memories.map(row => ['m:' + row.memoryId, 0]))
  const queue = [...distance.keys()]
  for (let i = 0; i < queue.length; i++) for (const next of adjacent.get(queue[i]) ?? []) {
    if (!distance.has(next)) { distance.set(next, distance.get(queue[i]) + 1); queue.push(next) }
  }
  for (const node of candidate.trafficNodes) {
    if (!distance.has('n:' + node.nodeId)) fail('candidate_unreachable_node')
    if (distance.get('n:' + node.nodeId) > bounds.maxHops) fail('candidate_hop_budget')
  }
}

/**
 * candidateSource: {readOnly:true, readCandidate(request), readGraphVersion?(request)}
 * clock: () => epoch milliseconds or Date. No Date.now fallback.
 * Returned receipts are proposals for the owner to persist; no state adapter is written here.
 */
export function createConsolidationRunner ({ candidateSource, structuredCaller, clock } = {}) {
  const active = new Set(), records = new Map()
  return {
    async run ({ scope, batchState = null, settings = {}, limits = {}, expectedGraphVersion, signal, force = false } = {}) {
      const out = { schema: 'echo-consolidation-runner/v1', status: 'blocked', reason: null,
        batchId: null, sourceVersion: null, state: null, receipt: null, preview: [], commitAllowed: false,
        sourceEvidence: [], pipeline: null,
        summary: { attempts: 0, candidateReads: 0, modelCalls: 0, memories: null, nodes: null, accepted: null, rejected: null },
        budget: { promptBytes: null, responseBytes: null, actualTokens: null },
        versionCheck: 'snapshot-only', requiresSourceVersionRecheck: true }
      let reserved = false, attemptStarted = false, previous = null, nowMs, windowStart, windowAttempts, bounds, expectedAnchor = null
      const finish = (status, reason) => {
        out.status = status; out.reason = reason
        if (attemptStarted) {
          const terminal = records.get(out.batchId)
          if (['success', 'committed'].includes(terminal?.status)) {
            out.status = 'skipped'; out.reason = 'batch_completed_during_attempt'
            out.preview = []; out.receipt = copy(terminal)
            return out
          }
          out.receipt = { batchId: out.batchId, status: status === 'previewed' || status === 'empty' ? 'previewed' : 'failed',
            attempts: (previous?.attempts ?? 0) + 1, lastAttemptAt: new Date(nowMs).toISOString(),
            windowStartedAt: new Date(windowStart).toISOString(), windowAttempts: windowAttempts + 1,
            sourceVersion: expectedAnchor ?? out.sourceVersion, reason, previewSha256: status === 'previewed' ? sha(out.preview) : null,
            commitAllowed: false }
          records.set(out.batchId, copy(out.receipt))
          out.summary.attempts = out.receipt.attempts
        }
        return out
      }
      try {
        if (typeof clock !== 'function') fail('clock_required')
        const instant = clock()
        nowMs = instant instanceof Date ? instant.getTime() : instant
        if (typeof nowMs !== 'number' || !Number.isFinite(new Date(nowMs).getTime())) fail('invalid_clock')
        const current = consolidationBatch(new Date(nowMs))
        bounds = candidateLimits(settings)
        const external = recordOf(batchState)
        if (external && scheduledTime(external.batchId) > scheduledTime(current.batchId)) fail('future_batch_state')
        if (external && ['previewed', 'success', 'committed'].includes(external.status)) {
          if (records.size >= 64 && !records.has(external.batchId)) fail('runner_capacity')
          if (!['success', 'committed'].includes(records.get(external.batchId)?.status)
            || external.status !== 'previewed') records.set(external.batchId, copy(external))
        }
        let batchId = current.batchId
        if (external && ['pending', 'failed', 'running'].includes(external.status)
          && scheduledTime(external.batchId) <= nowMs) batchId = external.batchId
        if (!external) {
          const backlog = [...records.values()].filter(record => record.status === 'failed'
            && scheduledTime(record.batchId) <= nowMs).sort((a, b) => scheduledTime(a.batchId) - scheduledTime(b.batchId))
          if (backlog.length) batchId = backlog[0].batchId
        }
        out.batchId = batchId
        const cached = records.get(batchId)
        previous = external?.batchId === batchId ? external : null
        if (cached && !['success', 'committed'].includes(previous?.status)
          && (!previous || ['previewed', 'success', 'committed'].includes(cached.status) || cached.attempts > previous.attempts
            || (cached.status === 'failed' && previous.status === 'pending' && cached.attempts === previous.attempts))) previous = copy(cached)
        if (expectedGraphVersion !== undefined && (typeof expectedGraphVersion !== 'string'
          || !expectedGraphVersion.trim() || expectedGraphVersion.length > 128)) fail('invalid_expected_version')
        if (expectedGraphVersion !== undefined && previous?.sourceVersion
          && expectedGraphVersion !== previous.sourceVersion) fail('source_version_anchor_conflict')
        expectedAnchor = expectedGraphVersion ?? previous?.sourceVersion ?? null
        out.receipt = previous ? copy(previous) : null
        out.summary.attempts = previous?.attempts ?? 0
        const due = scheduledTime(batchId)
        windowStart = previous?.windowStartedAt ? Date.parse(previous.windowStartedAt) : due
        windowAttempts = previous?.windowAttempts ?? previous?.attempts ?? 0
        const invalidWindow = !Number.isFinite(windowStart) || windowStart < due || (windowStart - due) % DAY !== 0
          || !Number.isSafeInteger(windowAttempts) || windowAttempts < 0 || windowAttempts > (previous?.attempts ?? 0)
        if (invalidWindow && !force) fail('invalid_batch_state')
        if (force && invalidWindow) { windowStart = due; windowAttempts = 0 }
        const decision = (phase, reason, canRun = false) => {
          out.state = { phase, canRun, scheduledAt: new Date(due).toISOString(),
            windowStartedAt: new Date(windowStart).toISOString(), nextWindowAt: new Date(windowStart + DAY).toISOString(),
            retryAt: null, maxRetries: bounds.maxRetries, windowAttempts }
          return finish('skipped', reason)
        }
        if (active.has(batchId) || previous?.status === 'running') return decision('running', 'batch_running')
        if (['previewed', 'success', 'committed'].includes(previous?.status)) return decision('completed', 'batch_already_completed')
        if (!force && nowMs < due) return decision('scheduled', 'before_scheduled_time')
        if (previous?.status === 'failed' && !force) {
          const last = Date.parse(previous.lastAttemptAt)
          if (!Number.isFinite(last) || last > nowMs || last < windowStart || last >= windowStart + DAY
            || previous.attempts < 1 || windowAttempts < 1) fail('invalid_batch_state')
          if (nowMs >= windowStart + DAY) {
            if (!bounds.catchUp) return decision('next-window',
              windowAttempts >= bounds.maxRetries + 1 ? 'retry_exhausted' : 'catch_up_disabled')
            windowStart = due + Math.floor((nowMs - due) / DAY) * DAY; windowAttempts = 0
          }
          if (windowAttempts >= bounds.maxRetries + 1) return decision('next-window', 'retry_exhausted')
          if (nowMs < last + bounds.retryDelayMs) {
            const skipped = decision('retry-wait', 'retry_delay')
            skipped.state.retryAt = new Date(last + bounds.retryDelayMs).toISOString()
            return skipped
          }
        } else if (!force && !bounds.catchUp && nowMs >= due + 60000) return decision('missed', 'catch_up_disabled')
        if (nowMs >= windowStart + DAY) {
          windowStart = due + Math.floor((nowMs - due) / DAY) * DAY; windowAttempts = 0
        }
        if (signal !== undefined && !(signal instanceof AbortSignal)) fail('invalid_abort_signal')
        if (signal?.aborted) fail('run_aborted')
        if (!candidateSource || candidateSource.readOnly !== true || typeof candidateSource.readCandidate !== 'function') fail('readonly_candidate_source_required')
        if (typeof structuredCaller !== 'function') fail('structured_caller_required')
        if (!object(scope) || (scope.memoryIds === undefined) === (scope.since === undefined)) fail('candidate_scope_required')
        const requestedScope = copy(scope), requestSettings = copy(settings), requestLimits = copy(limits)
        if (Object.keys(requestedScope).some(key => !['memoryIds', 'since', 'limit'].includes(key))
          || (requestedScope.limit !== undefined && (!Number.isSafeInteger(requestedScope.limit) || requestedScope.limit < 1))) fail('candidate_scope_required')
        requestedScope.limit = Math.min(requestedScope.limit ?? bounds.maxMemories, bounds.maxMemories)
        if (requestedScope.memoryIds !== undefined) {
          if (!Array.isArray(requestedScope.memoryIds)) fail('candidate_scope_required')
          const ids = requestedScope.memoryIds.map(value => {
            if (!((typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128
              && !/[\u0000-\u001f\u007f]/u.test(value)) || (Number.isSafeInteger(value) && value > 0))) fail('candidate_scope_required')
            return String(value)
          })
          requestedScope.memoryIds = [...new Set(ids)].sort().slice(0, requestedScope.limit)
        } else if (typeof requestedScope.since !== 'number' || !Number.isFinite(requestedScope.since) || requestedScope.since <= 0) fail('candidate_scope_required')
        if (records.size >= 64 && !records.has(batchId)) fail('runner_capacity')
        active.add(batchId); reserved = true; attemptStarted = true
        out.state = { phase: previous?.status === 'failed' ? 'retry-ready' : nowMs < due + 60000 ? 'due' : 'catch-up',
          canRun: true, scheduledAt: new Date(due).toISOString(), windowStartedAt: new Date(windowStart).toISOString(),
          nextWindowAt: new Date(windowStart + DAY).toISOString(), maxRetries: bounds.maxRetries, windowAttempts }
        const raw = await abortable(signal, () => {
          out.summary.candidateReads = 1
          return candidateSource.readCandidate(Object.freeze({ batchId,
            scope: freeze(copy(requestedScope)), settings: freeze(copy(requestSettings)), signal, readOnly: true }))
        })
        if (signal?.aborted) fail('run_aborted')
        const candidate = copy(raw)
        if (!object(candidate)) fail('invalid_candidate')
        if (candidate.batchId !== batchId) fail('candidate_batch_mismatch')
        if (candidate.readOnly !== true || candidate.schema !== 'echo-consolidation-candidates/v1') fail('invalid_candidate')
        out.summary.memories = Array.isArray(candidate.memories) ? candidate.memories.length : null
        out.summary.nodes = Array.isArray(candidate.trafficNodes) ? candidate.trafficNodes.length : null
        if (Array.isArray(candidate.sourceEvidence)) {
          out.sourceEvidence = candidate.sourceEvidence.map(ref => ({
            readId: Number.isInteger(ref?.readId) ? ref.readId : null,
            kind: typeof ref?.kind === 'string' && ['memories', 'local-graph', 'fixture'].includes(ref.kind) ? ref.kind : null,
            sha256: typeof ref?.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(ref.sha256) ? ref.sha256 : null
          }))
        }
        if (candidate.status === 'partial') {
          const cause = Array.isArray(candidate.truncation) && candidate.truncation[0]
            ? candidate.truncation[0]
            : Array.isArray(candidate.issues) && candidate.issues[0]
              ? candidate.issues[0] : 'unknown'
          return finish('partial', 'candidate_partial:' + cause)
        }
        if (candidate.status !== 'ok') return finish('blocked', 'candidate_blocked')
        if (!Array.isArray(candidate.memories)) fail('invalid_candidate')
        if (candidate.memories.length > requestedScope.limit || candidate.memories.some(row =>
          requestedScope.memoryIds && !requestedScope.memoryIds.includes(row.memoryId))) fail('candidate_scope_mismatch')
        if (requestedScope.since !== undefined && candidate.scope?.since !== requestedScope.since) fail('candidate_scope_mismatch')
        if (requestedScope.since !== undefined && candidate.memories.some(row => {
          const cursor = Math.max(...['recordedAt', 'changedAt', 'lastRecalled'].map(key =>
            typeof row[key] === 'number' && Number.isFinite(row[key]) ? row[key] : 0))
          return cursor < requestedScope.since
        })) fail('candidate_scope_mismatch')
        if (candidate.graphVersion !== null && candidate.graphVersion !== undefined
          && (typeof candidate.graphVersion !== 'string' || !candidate.graphVersion.trim()
            || candidate.graphVersion.length > 128 || /[\u0000-\u001f\u007f]/u.test(candidate.graphVersion))) fail('candidate_version_missing')
        out.sourceVersion = candidate.graphVersion ?? null
        if (expectedAnchor !== null && out.sourceVersion !== expectedAnchor) fail('source_version_drift')
        Object.defineProperty(out, 'candidate', {
          value: copy(candidate), enumerable: false, configurable: true
        })
        Object.defineProperty(out, 'plan', {
          value: { schema: COMMAND_SCHEMA, batchId,
            sourceGraphVersion: out.sourceVersion, operations: [] },
          enumerable: false, configurable: true
        })
        if (!candidate.memories.length) {
          if (!Array.isArray(candidate.issues) || candidate.issues.length
            || !Array.isArray(candidate.truncation) || candidate.truncation.length
            || !Array.isArray(candidate.scope?.includedMemoryIds) || candidate.scope.includedMemoryIds.length
            || ['trafficNodes', 'memoryNodeLinks', 'trafficLinks'].some(key => !Array.isArray(candidate[key]) || candidate[key].length)) fail('invalid_empty_candidate')
          return finish('empty', 'no_candidates')
        }
        const preflight = validateConsolidationPlan({ candidate, limits: requestLimits, plan: {
          schema: COMMAND_SCHEMA, batchId, sourceGraphVersion: out.sourceVersion, operations: []
        } })
        if (preflight.status !== 'validated') return finish('blocked', preflight.reason)
        if (candidate.memories.length > bounds.maxMemories || candidate.trafficNodes.length > bounds.maxNodes
          || candidate.memoryNodeLinks.length + candidate.trafficLinks.length > bounds.maxEdges) fail('candidate_scope_budget')
        checkGraph(candidate, bounds)
        freeze(candidate)
        const built = buildConsolidationPrompt({ candidate, maxPromptBytes: Math.min(65536, Math.max(1024, bounds.maxTokens)) })
        out.budget.promptBytes = bytes(built.prompt)
        const remaining = bounds.maxTokens - out.budget.promptBytes
        if (remaining < 256) fail('prompt_budget_exceeded')
        // maxTokens is a UTF-8 content budget, not a provider token count.
        // The injected DSH channel supplies the provider/session token cap;
        // response bytes remain the hard content boundary.
        const responseTokens = bounds.maxTokens
        let callerFailure = null
        const guardedCaller = async request => {
          if (signal?.aborted) fail('run_aborted')
          try {
            const response = await abortable(signal, () => {
              out.summary.modelCalls++
              return structuredCaller(Object.freeze({ ...request, limits: freeze(copy(preflight.limits)),
                maxOutputBytes: remaining, maxOutputTokens: responseTokens, timeoutMs: bounds.timeoutMs }))
            })
            if (signal?.aborted) fail('run_aborted')
            const safe = typeof response === 'string' ? response : copy(response)
            out.budget.responseBytes = bytes(safe)
            if (out.budget.responseBytes > remaining) fail('response_budget_exceeded')
            return safe
          } catch (error) {
            if (['response_budget_exceeded', 'run_aborted'].includes(error?.message)) callerFailure = error.message
            throw error
          }
        }
        const result = await runConsolidationPipeline({ candidate, structuredCaller: guardedCaller,
          limits: preflight.limits, maxPromptBytes: Math.min(65536, Math.max(1024, bounds.maxTokens)),
          maxResponseBytes: remaining, signal })
        if (signal?.aborted) fail('run_aborted')
        out.pipeline = { status: result.status, reason: result.reason }
        if (result.status !== 'validated') return finish(result.status === 'rejected' ? 'partial' : 'failed', callerFailure ?? result.reason)
        if (result.commitAllowed !== false || result.validation?.commitAllowed !== false
          || result.batchId !== batchId || result.sourceVersion !== out.sourceVersion) fail('pipeline_receipt_mismatch')
        if (typeof candidateSource.readGraphVersion === 'function') {
          const version = await abortable(signal, () => candidateSource.readGraphVersion({ batchId, signal, readOnly: true }))
          if (signal?.aborted) fail('run_aborted')
          out.versionCheck = 'source-rechecked'
          if (version !== out.sourceVersion) fail('source_version_drift')
        }
        out.summary.nodes = candidate.trafficNodes.length
        out.summary.accepted = result.validation.accepted.length
        out.summary.rejected = result.validation.rejected.length
        Object.defineProperty(out, 'plan', { value: {
          schema: COMMAND_SCHEMA,
          batchId,
          sourceGraphVersion: out.sourceVersion,
          operations: result.validation.accepted.map(item => copy(item.command))
        }, enumerable: false, configurable: true })
        out.preview = copy(result.preview)
        return finish('previewed', 'preview_ready')
      } catch (error) {
        const allowed = ['clock_required', 'invalid_clock', 'invalid_batch_state', 'future_batch_state', 'invalid_abort_signal',
          'run_aborted', 'readonly_candidate_source_required', 'structured_caller_required', 'candidate_scope_required',
          'runner_capacity', 'candidate_batch_mismatch', 'invalid_candidate', 'source_version_drift', 'candidate_scope_budget',
          'invalid_candidate_time', 'invalid_candidate_relation', 'candidate_neighbor_budget', 'candidate_unreachable_node',
          'candidate_hop_budget', 'candidate_scope_mismatch', 'invalid_empty_candidate', 'invalid_expected_version',
          'candidate_version_missing', 'invalid_candidate_link_status',
          'source_version_anchor_conflict', 'input_budget', 'invalid_json_input', 'prompt_budget_exceeded', 'pipeline_receipt_mismatch']
        return finish(attemptStarted ? 'failed' : 'blocked', allowed.includes(error?.message) ? error.message : 'runner_failed')
      } finally { if (reserved) active.delete(out.batchId) }
    }
  }
}
