/** Fixed 22:00 background integration for the consolidation runner and commit boundary. */
import { candidateLimits } from './memory-consolidation-candidates.js'
import { createConsolidationRunner } from './memory-consolidation-runner.js'
import {
  assertConsolidationPrepared, ensureConsolidationCommitSchema, readConsolidationReceipt,
  recordConsolidationFailure, recordConsolidationNoWork, commitConsolidationPreview
} from './memory-consolidation-commit.js'
import { createConsolidationCandidateSource } from './memory-consolidation-source.js'
import { createDshConsolidationCaller } from './memory-consolidation-dsh-caller.js'
import { consolidationBatch, CONSOLIDATION_DEFAULTS } from './memory-consolidation-state.js'

const safeJson = value => {
  try { return JSON.parse(value || '{}') } catch { return {} }
}
const runtimeSettings = raw => {
  const value = (raw && typeof raw === 'object') ? raw : {}
  const defaults = {
    memoryConsolidationCatchUp: CONSOLIDATION_DEFAULTS.catchUp,
    memoryConsolidationMaxMemories: CONSOLIDATION_DEFAULTS.maxMemories,
    memoryConsolidationMaxHops: CONSOLIDATION_DEFAULTS.maxHops,
    memoryConsolidationMaxNeighbors: CONSOLIDATION_DEFAULTS.maxNeighbors,
    memoryConsolidationMaxTokens: CONSOLIDATION_DEFAULTS.maxTokens,
    memoryConsolidationTimeoutMs: CONSOLIDATION_DEFAULTS.timeoutMs,
    memoryConsolidationMaxRetries: CONSOLIDATION_DEFAULTS.maxRetries,
    memoryConsolidationRetryDelayMs: CONSOLIDATION_DEFAULTS.retryDelayMs
  }
  const normalized = { ...value }
  for (const [key, fallback] of Object.entries(defaults)) {
    if (normalized[key] === undefined || normalized[key] === null || normalized[key] === '') normalized[key] = fallback
  }
  return {
    ...normalized,
    catchUp: normalized.memoryConsolidationCatchUp !== false,
    maxRetries: normalized.memoryConsolidationMaxRetries,
    retryDelayMs: normalized.memoryConsolidationRetryDelayMs
  }
}

function recordForRunner (row) {
  if (!row) return null
  const audit = safeJson(row.audit_json)
  return {
    batchId: row.batch_id, status: row.status, attempts: Number(row.attempts) || 0,
    lastAttemptAt: row.last_attempt_at > 0 ? new Date(row.last_attempt_at).toISOString() : null,
    windowStartedAt: row.window_started_at || null, windowAttempts: Number(row.window_attempts) || 0,
    sourceVersion: row.source_graph_version || null, reason: row.error_reason || audit.reason || ''
  }
}

function scopeFromReceipt (row) {
  const scope = safeJson(row?.audit_json).scope
  return scope && typeof scope === 'object' ? scope : null
}

function findBatchReceipt (db, now) {
  const current = consolidationBatch(new Date(now)).batchId
  const row = db.prepare(`SELECT * FROM memory_consolidation_receipts
    WHERE batch_id = ? OR (status = 'failed' AND last_attempt_at <= ?
      AND batch_id GLOB 'memory-consolidation-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
    ORDER BY CASE WHEN batch_id = ? THEN 0 ELSE 1 END, last_attempt_at ASC LIMIT 1`)
    .get(current, now, current)
  return row ?? null
}

export function createConsolidationHeartbeat ({
  db, channel, getSettings = () => ({}), getRoute = () => ({ provider: '', model: '' }),
  clock = () => Date.now(), logger = null, preparedOnly = false, authorityCheck = null,
  maintenance = null, audit = null
} = {}) {
  if (!db || !channel) return {
    async tick () { return { status: 'disabled', reason: 'dependencies_missing' } },
    async drain () { return { status: 'disabled', reason: 'dependencies_missing' } },
    status () { return { accepting: false, inFlight: false, outcome: 'disabled' } },
    resume () { return { status: 'disabled', reason: 'dependencies_missing' } }
  }
  if (preparedOnly) assertConsolidationPrepared(db)
  else ensureConsolidationCommitSchema(db)
  const source = createConsolidationCandidateSource({ db, preparedOnly })
  const structuredCaller = createDshConsolidationCaller({ channel, getRoute })
  const runner = createConsolidationRunner({
    candidateSource: source, structuredCaller, clock
  })
  let accepting = true, inFlight = null, drainTask = null, unresolved = null
  let preparedBoundaryFailure = null
  const preparedFailureReasons = new Set(['authority_drift', 'authority_unavailable', 'prepared_schema_unavailable'])
  const log = (level, text) => {
    try { if (typeof logger?.[level] === 'function') logger[level](text) } catch {}
  }
  const verifyPrepared = () => {
    if (!preparedOnly) return
    try { assertConsolidationPrepared(db) } catch { throw Error('prepared_schema_unavailable') }
    if (typeof authorityCheck === 'function') {
      let ok = false
      try { ok = authorityCheck() === true } catch { throw Error('authority_unavailable') }
      if (!ok) throw Error('authority_drift')
    }
  }
  const markPreparedUnknown = reason => {
    accepting = false
    unresolved = { phase: 'authority', reason }
    return { status: 'unknown', reason }
  }
  const settleMaintenance = (token, result, error = null) => {
    if (token === null || typeof maintenance !== 'object') return
    const unknown = error !== null || result?.status === 'unknown'
      || result?.reason === 'persistence_outcome_unknown'
    try { (unknown ? maintenance.unknown : maintenance.complete)(token) } catch {}
  }
  const persist = action => {
    try {
      if (preparedOnly) verifyPrepared()
      if (db.isTransaction) throw Error('transaction_already_open')
      const result = action()
      if (preparedBoundaryFailure !== null) {
        const reason = preparedBoundaryFailure
        preparedBoundaryFailure = null
        return { status: 'rejected', reason }
      }
      // The commit helper can swallow rollback errors or lose confirmation after COMMIT.
      if (db.isTransaction || result?.reason === 'atomic_commit_failed') throw Error('persistence_outcome_unknown')
      return result
    } catch (error) {
      if (preparedOnly && preparedFailureReasons.has(error?.message)) {
        accepting = false
        unresolved = { phase: 'authority', reason: error.message }
        throw error
      }
      accepting = false
      unresolved = { phase: 'persistence', reason: 'persistence_outcome_unknown' }
      throw error
    }
  }
  const execute = async ({ force = false } = {}) => {
      try {
        if (preparedOnly) {
          try { verifyPrepared() } catch (error) {
            return markPreparedUnknown(preparedFailureReasons.has(error?.message)
              ? error.message : 'authority_unavailable')
          }
        }
        const instant = clock()
        const now = Number(instant instanceof Date ? instant.getTime() : instant)
        const settings = runtimeSettings(getSettings())
        const persisted = findBatchReceipt(db, now)
        if (persisted?.status === 'no_work') {
          return { status: 'empty', reason: 'no_work_receipt', batchId: persisted.batch_id,
            sourceVersion: persisted.source_graph_version, commitAllowed: false }
        }
        const scope = scopeFromReceipt(persisted) ?? {
          memoryIds: source.selectRecentMemoryIds({ limit: candidateLimits(settings).maxMemories })
        }
        if (!Array.isArray(scope.memoryIds) || scope.memoryIds.length === 0) {
          scope.memoryIds = []
        }
        const result = await runner.run({
          scope, batchState: recordForRunner(persisted), settings,
          expectedGraphVersion: persisted?.source_graph_version || undefined, force
        })
        if (result.status === 'empty') {
          const noWork = persist(() => recordConsolidationNoWork({
            db, batchId: result.batchId, sourceGraphVersion: result.sourceVersion || '',
            now, attempts: result.receipt?.attempts ?? 0,
            lastAttemptAt: result.receipt ? Date.parse(result.receipt.lastAttemptAt) : now,
            windowStartedAt: result.receipt?.windowStartedAt ?? '',
            windowAttempts: result.receipt?.windowAttempts ?? 0,
            audit: { scope, runner: result.summary }, preparedOnly
          }))
          return { ...result, receipt: noWork, commitAllowed: false }
        }
        if (result.status !== 'previewed') {
          if (result.receipt?.status === 'failed') {
            persist(() => recordConsolidationFailure({
              db, batchId: result.batchId, sourceGraphVersion: result.sourceVersion || '',
              attempts: result.receipt.attempts, lastAttemptAt: Date.parse(result.receipt.lastAttemptAt),
              windowStartedAt: result.receipt.windowStartedAt,
              windowAttempts: result.receipt.windowAttempts, reason: result.reason,
              audit: { scope, runner: result.summary }, preparedOnly
            }))
          }
          return result
        }
        if (!result.candidate || !result.plan) return { ...result, status: 'failed', reason: 'runner_plan_missing' }
        if (preparedOnly) {
          try { verifyPrepared() } catch (error) {
            return markPreparedUnknown(preparedFailureReasons.has(error?.message)
              ? error.message : 'authority_unavailable')
          }
        }
        preparedBoundaryFailure = null
        const committed = persist(() => commitConsolidationPreview({
          db, candidate: result.candidate, plan: result.plan, batchId: result.batchId,
          sourceGraphVersion: result.sourceVersion, now, limits: {},
          attempts: result.receipt?.attempts ?? 0,
          lastAttemptAt: result.receipt ? Date.parse(result.receipt.lastAttemptAt) : 0,
          windowStartedAt: result.receipt?.windowStartedAt ?? '',
          windowAttempts: result.receipt?.windowAttempts ?? 0,
          preparedOnly,
          allowPlannedNodes: preparedOnly,
          checkOnlineScope: preparedOnly
            ? (connection, validation) => {
                if (connection !== db) throw Error('transaction_already_open')
                try { verifyPrepared() } catch (error) {
                  preparedBoundaryFailure = preparedFailureReasons.has(error?.message)
                    ? error.message : 'authority_unavailable'
                  throw error
                }
                const created = new Set(validation.preview.flatMap(item =>
                  item.addNodes.map(node => node.nodeId)))
                for (const nodeId of validation.touched || []) {
                  if (created.has(nodeId)) continue
                  const row = connection.prepare(
                    'SELECT status,superseded_by FROM memory_consolidation_graph_nodes WHERE node_id=?'
                  ).get(nodeId)
                  if (!row || row.status !== 'active' || String(row.superseded_by || '') !== '') {
                    throw Error('graph_target_missing')
                  }
                }
              }
            : null
        }))
        if (preparedOnly && preparedFailureReasons.has(committed.reason)) {
          return markPreparedUnknown(committed.reason)
        }
        if (committed.status === 'committed' || committed.status === 'already_committed') {
          log('info', 'echo: memory consolidation committed ' + result.batchId)
          return { ...result, commit: committed }
        }
        const receipt = result.receipt
        if (receipt?.status === 'previewed') {
          persist(() => recordConsolidationFailure({
            db, batchId: result.batchId, sourceGraphVersion: result.sourceVersion || '',
            attempts: receipt.attempts, lastAttemptAt: Date.parse(receipt.lastAttemptAt),
            windowStartedAt: receipt.windowStartedAt, windowAttempts: receipt.windowAttempts,
            reason: committed.reason, audit: { scope, runner: result.summary, commit: committed.audit },
            preparedOnly
          }))
        }
        return { ...result, status: 'failed', reason: committed.reason, commit: committed }
      } catch (error) {
        if (unresolved) return { status: 'unknown', reason: unresolved.reason }
        log('warn', 'echo: memory consolidation tick failed — ' + String(error?.message ?? error))
        return { status: 'failed', reason: 'heartbeat_error' }
      }
  }
  function tick (options = {}) {
    if (unresolved) return Promise.resolve({ status: 'unknown', reason: unresolved.reason })
    if (!accepting) return Promise.resolve({ status: 'skipped', reason: 'draining' })
    if (inFlight) return Promise.resolve({ status: 'skipped', reason: 'busy', inFlight: true })
    let token = null
    if (maintenance !== null) {
      let admission
      try { admission = maintenance.admit('memory_consolidation') } catch {
        return Promise.resolve({ status: 'skipped', reason: 'maintenance_unavailable' })
      }
      if (admission?.accepted !== true) {
        return Promise.resolve({ status: 'skipped', reason: admission?.reason || 'maintenance_closed' })
      }
      token = admission.token ?? null
    }
    // Register before execute can reenter through an injected callback.
    const { promise, resolve, reject } = Promise.withResolvers()
    const settled = promise.then(result => {
      try { audit?.(result) } catch {}
      settleMaintenance(token, result)
      return result
    }, error => {
      try { audit?.({ status: 'unknown', reason: 'heartbeat_outcome_unknown' }) } catch {}
      settleMaintenance(token, null, error)
      throw error
    })
    const task = inFlight = settled.finally(() => { inFlight = null })
    execute(options).then(resolve, reject)
    return task
  }
  function status () {
    return { accepting, draining: !accepting, inFlight: inFlight !== null,
      outcome: unresolved ? 'unknown' : inFlight ? 'in_flight' : 'idle',
      phase: unresolved?.phase ?? null, reason: unresolved?.reason ?? null }
  }
  async function drain ({ timeoutMs = 30000 } = {}) {
    accepting = false
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 900000) {
      return { status: 'invalid', reason: 'invalid_drain_timeout', ...status() }
    }
    if (unresolved) return { status: 'unknown', ...status() }
    if (drainTask) return drainTask
    const task = inFlight
    if (!task) return { status: 'drained', ...status() }
    drainTask = (async () => {
      let timer
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      })
      const result = await Promise.race([task.then(value => ({ value }), error => ({ error })), timeout])
      clearTimeout(timer)
      if (result === null) return { status: 'timed_out', ...status() }
      if (unresolved) return { status: 'unknown', ...status() }
      if (result.error) return { status: 'failed', reason: 'task_failed', ...status() }
      return { status: 'drained', ...status(), taskStatus: result.value?.status ?? 'unknown' }
    })()
    try { return await drainTask } finally { drainTask = null }
  }
  function resume () {
    if (unresolved) return { status: 'unknown', ...status() }
    if (inFlight !== null || drainTask !== null) return { status: 'busy', ...status() }
    accepting = true
    return { status: 'resumed', ...status() }
  }
  return {
    tick,
    runNow () { return tick({ force: true }) },
    drain,
    status,
    resume
  }
}
