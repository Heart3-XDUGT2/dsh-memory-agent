import { captureRetrievedItems, createRetrieveAudit } from './audit-io.js'
/**
 * dsh-echo — 引擎门面(M2-d)
 * ============================================================
 * 两档引擎,同一异步入口(PLAN §5 降级链):
 *   Python sidecar 在 → 全引擎(b1-b6:检索/写入链/反思/议程簿);
 *   探测不到/起不来 → JS 基线(M1 冻结,最终形态);
 *   引擎中途崩/熔断 → 检索回落基线(明确死透才回,见下),
 *                      反思跳过本轮(增益不是依赖)。
 *   人格永不陪葬:本模块任何失败都不上抛给注入/反思调用方。
 *
 * 单写者纪律:Python 活着时 JS store 只读(state/画像/审计读与
 * 壳侧状态写 —— agent_state 表是壳拥有的,引擎不碰);store.retrieve
 * 的召回强化写只发生在基线路径。**模糊态不回落**:请求超时/报错但
 * 进程还活着时,本轮跳过注入而不是切基线 —— 引擎可能还在处理上一
 * 发,双写比漏一拍更伤(PLAN §8「她这轮没想起,不是失忆」)。
 *
 * 壳侧职责(b4 定案):extract_commit 的 ack 里 name 交画像、
 * 规整后情绪载荷交 agent_state(壳拥有的表)、审计照写;
 * profileUpdate(语言等)暂无落列 —— 画像表是定列 schema,
 * 不为它发明列,日志留痕待 M2-h 一并定夺(诚实边界)。
 */
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { detectPython, SidecarClient } from './sidecar-client.js'
import { createOwnerScopeVerifier } from './owner-scope.js'
import { SNAPSHOT_PROTOCOL } from './memory-source-export.js'
import { inspectMemoryAuthority, authorityBindingMatches, MEMORY_EXTRACT_ENTRIES } from './memory-authority.js'
import { validateMemoryStrengthOrigin } from './memory-strength-origin.js'
import { renderMemoryList, renderInjectedBlock, describeMood } from './context.js'
import { runExtract, runRawExtract, commitExtract } from './reflect.js'
import { applyEmotionVector, emotionDelta, formatEmotionDelta, carryExtraEmotionKeys } from './emotion.js'
// v0.40.0 C1:同轮情绪读数(只改这一轮的**渲染**;写库那条路仍归轮末反思)
import { sameTurnState } from './emotion-score.js'
// RT9:检索账本(只记不判;环形缓冲在壳侧,这里只往它推一条)
import { ledgerEntry, buildRetrievalObserver } from './retrieve-ledger.js'
import { rejectReason } from './inbound-filter.js'
// P1c:引擎帧的**名字集合**载荷(说话人 / 人名)—— 单一读点见 lib/names.js
import { loadNames, loadOwnerNames } from './names.js'
// P3-a「通路先行」:数据文件(graph.json / lexicon.json / state-defaults.json)随帧下发。
import { frameData } from './data-tables.js'
import { retrieveConsolidationMemories, bindFormalSourceVersion, RETRIEVAL_BOUNDS, UNIFIED_SHADOW_BOUNDS, coreMemoryProjection, renderCoreMemories, writerMemoryProjection } from './memory-consolidation-retrieval.js'
import { rankMemories } from './retrieve.js'
import { applyExtractHostAck } from './memory-extract-transactions.js'

const ASSOCIATION_AUDIT_REASONS = new Set([
  'invalid_candidate_selection', 'invalid_memory_selection', 'invalid_evaluation_bounds', 'db_unavailable',
  'invalid_seed_ids', 'no_seeds', 'no_active_roots', 'no_reachable_candidates', 'memory_changed',
  'invalid_memory_data', 'missing_tables', 'incompatible_schema', 'query_budget_exceeded', 'query_failed',
  'missing_lookup_index', 'dynamic_state_unavailable', 'dynamic_query_failed', 'missing_dynamic_record',
  'invalid_dynamic_state', 'memory_strength_fallback', 'shadow_failed', 'association_failed', 'observation_unavailable'
])
const WORKER_PATH = fileURLToPath(new URL('../python/worker.py', import.meta.url))
const MASTER_ID = 'master'   // 与 store.js 同源;worker 帧用 caller 传键
const RETRIEVE_TIMEOUT_MS = 4000   // 注入是前奏:超时宁可她这轮没想起
const SNAPSHOT_DIGEST = /^[a-f0-9]{64}$/u
const SNAPSHOT_HASH_FIELDS = ['tokenHash', 'schemaHash', 'contentHash', 'ownerHash', 'turnHash', 'attemptHash']
const snapshotHash = value => createHash('sha256').update(value, 'utf8').digest('hex')
const matchesSnapshotReceipt = (frame, type, receipt) => {
  const actual = frame?.snapshotReceipt
  return frame?.type === type && frame.readOnlySnapshot === true
    && actual?.status === 'ready' && actual.reason === null && actual.kind === receipt.kind
    && (actual.protocol === undefined || actual.protocol === receipt.protocol)
    && SNAPSHOT_HASH_FIELDS.every(key => actual[key] === receipt[key])
}
const EXTRACT_TIMEOUT_MS = 30000   // 写入链是轮后:给足时间
const REFLECT_TIMEOUT_MS = 8000    // 整固两帧只碰库(LLM 在壳侧 subagents):够用
const A1_SERVER_REASONS = new Set([
  'a1_authority_schema_invalid', 'a1_authority_invalid', 'a1_authority_unavailable',
  'a1_authority_changed', 'a1_schema_unprepared', 'a1_epoch_mismatch', 'a1_binding_mismatch',
  'a1_protocol_mismatch', 'a1_generation_mismatch', 'a1_scope_mismatch', 'a1_peer_mismatch',
  'a1_origin_invalid', 'a1_origin_before_cutoff', 'a1_entry_not_integrated', 'a1_body_invalid',
  'a1_not_active', 'a1_invalid_origin', 'a1_invalid_input', 'a1_request_failed', 'a1_outcome_unknown',
  'a1_write_busy', 'a1_write_failed', 'a1_rollback_failed', 'a1_intent_conflict',
  'body_payload_conflict', 'body_invalid_input', 'body_receipt_invalid', 'body_receipt_capacity',
  'body_strength_not_applied', 'body_clock_invalid', 'strength_state_invalid',
  'strength_clock_invalid', 'strength_memory_ineligible', 'strength_receipt_capacity',
  'retrieval_invalid_input', 'retrieval_input_budget', 'retrieval_schema_unprepared',
  'retrieval_schema_incompatible', 'retrieval_schema_unavailable', 'retrieval_epoch_mismatch',
  'retrieval_receipt_invalid', 'retrieval_payload_conflict', 'retrieval_receipt_capacity',
  'retrieval_clock_invalid', 'retrieval_result_invalid', 'retrieval_result_budget',
  'retrieval_transaction_required', 'retrieval_transaction_already_open',
  'retrieval_write_busy', 'retrieval_write_failed', 'retrieval_rollback_failed'
])
const a1ServerReason = (error, fallback) => error?.frame?.type === 'error'
  ? A1_SERVER_REASONS.has(error.frame.error) ? error.frame.error : fallback
  : null
const freezeSnapshot = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child)
    Object.freeze(value)
  }
  return value
}

/**
 * 想念九项的**键名翻译**:面板(settings)用 snake_case(A 侧原名),
 * 引擎 `longing.merge_config` 读 camelCase。
 *
 * ★ 2026-09-26 全仓审查抓到的真漏:四个 longing 帧以前**原样转发** settings,
 * 于是九项里只有 `enabled`/`threshold` 两个同名键生效,其余七项
 * (半衰期/脉冲削减/缓解/抗议尖峰/冷却/夜间静默/演示倍率)**面板上调了没用**,
 * 引擎永远走 DEFAULTS。数值两边本来就一致(所以肉眼看不出),差的是键名 ——
 * 这类"读得到、传不到"的 bug 只能靠**映射表 + 测试**钉住,靠读代码看不出来。
 */
const LONGING_KEY_MAP = {
  enabled: 'enabled',
  half_life_hours: 'halfLifeHours',
  threshold: 'threshold',
  msg_drop: 'msgDrop',
  care_relief: 'careRelief',
  protest_kick: 'protestKick',
  cooldown_minutes: 'cooldownMinutes',
  night_hold: 'nightHold',
  demo_rate: 'demoRate'
}

/** settings.longing → 引擎认的 camelCase 视图(缺值不塞,让引擎用自己的默认)。 */
export function longingFrameConfig (config) {
  if (config === null || typeof config !== 'object') return null
  const out = {}
  for (const [snake, camel] of Object.entries(LONGING_KEY_MAP)) {
    if (config[snake] === undefined) continue
    out[camel] = config[snake]
  }
  return Object.keys(out).length > 0 ? out : null
}

/** 种子条数上限:别让一次检索把几十个词塞进帧(图上节点总共才二十来个)。 */
export const MAX_SEED_NAMES = 12

/**
 * F6(2026-09-27):图谱种子通道②(实体种子)的收集。
 *
 * 现场:`worker.py:869-876` 设计了种子三通道(①字面直扫 ②LLM/壳传
 * `extraSeeds` ③机械切分兜底),但 `lib/turn-snapshot.js` 的 extras **从来没
 * 带过 `extraSeeds`** ⇒ `engine.js` 那行恒为 null ⇒ 每轮都掉进 ③,而 ③ 出来的
 * 是垃圾('有什么想说的吗' / 'QQ' / '——')。实测:22 条注入里 BFS 贡献 0 条
 * 路径,注入里唯一的图内容就是 pinned 的 L0 边(那两条章鱼小丸子)。
 *
 * 种子来源选**刚检索到的情景记忆的关键词**,理由三条:
 *   1. 零额外 LLM 调用 —— compose 在关键路径上,A 侧法医记录一次 glm-5.3
 *      小 prompt 都要 87s,这条账付不起;
 *   2. 当轮新鲜 —— extract 在 compose **之后**才跑,当轮实体根本还没出来;
 *   3. 语义连贯 —— 她刚想起「章鱼小丸子」的记忆,就拿这个实体去走图。
 *      这正是「情景 → 图谱」那座桥:图上亮什么,取决于她想起了什么。
 *
 * 强制占位的 L0 **跳过**:它们是无条件注入的身份背景,不是这一轮的话题,
 * 把身份词喂给图只会让图永远只亮身份实体 —— 正是要治的病。
 * 多余的词交给 `match_seeds_to_graph` 挡(它只认图谱里已有的节点名)。
 */
export function collectSeeds (items, explicit) {
  const out = []
  const push = (s) => {
    const t = String(s ?? '').trim()
    if (t === '' || t.length > 32) return
    if (!out.includes(t)) out.push(t)
  }
  if (Array.isArray(explicit)) explicit.forEach(push)   // 调用方显式给的优先
  if (Array.isArray(items)) {
    for (const it of items) {
      if (it === null || typeof it !== 'object') continue
      if (it.forced === true) continue                  // 强制占位 ≠ 这一轮的话题
      const kws = Array.isArray(it.keywords) ? it.keywords : []
      for (const k of kws) push(k)
    }
  }
  return out.slice(0, MAX_SEED_NAMES)
}

/**
 * 创建引擎门面。store 为 null(库打不开)时基线也不可用 → offline。
 * detect 可注入(测试用),缺省走探测链。
 */
export function createEngine ({ logger, dbPath, store, detect, clientOpts, onNameChange = null, ledger = null, auditTraceOf = null, associationMode = 'shadow', associationStrengthShadow = false, associationUnifiedShadow = false, associationSelection = 'topology', sourceVersionProvider = null, ownerScopeProvider = null, attemptIdOf = null, snapshotObserver = false, snapshotSource = null, maintenance = null }) {
  const log = logger ?? null
  const warn = (msg) => { try { log?.warn?.('echo: ' + msg) } catch { } }
  const info = (msg) => { try { log?.info?.('echo: ' + msg) } catch { } }
  let mode = store !== null ? 'baseline' : 'offline'
  let client = null
  let pythonInfo = null
  let ownerScopeContext = null
  const verifiedOwnerProvider = typeof ownerScopeProvider === 'function'
    ? (challenge) => {
        try { return ownerScopeProvider(challenge, ownerScopeContext) } catch { return null }
      }
    : null
  const ownerScopeVerifier = createOwnerScopeVerifier(verifiedOwnerProvider)
  const frozenAdds = new WeakMap()
  const frozenRetrievals = new WeakMap()
  const frozenExtracts = new WeakMap()
  let activeSeen = false
  let firstAuthority = null
  function memoryAuthority() {
    const current = typeof store?.memoryAuthority === 'function'
      ? store.memoryAuthority() : store?.db ? inspectMemoryAuthority(store.db) : { status: 'legacy' }
    if (current.status === 'active') {
      if (!firstAuthority) firstAuthority = JSON.stringify(current)
      activeSeen = true
    }
    if (activeSeen && (current.status !== 'active' || JSON.stringify(current) !== firstAuthority)) {
      return { status: 'blocked', reason: 'a1_authority_changed' }
    }
    return current
  }
  const memoryFence = () => ['active', 'blocked'].includes(memoryAuthority().status)
  const entryRejected = () => ({ ok: false, reason: 'a1_entry_not_integrated' })

  async function retrievalTransaction(kind, userId, query, topK, opts, origin) {
    const intent = JSON.stringify([kind, userId, query, topK, opts])
    let frozen = frozenRetrievals.get(origin)
    if (frozen && frozen.intent !== intent) return { ok: false, reason: 'a1_intent_conflict' }
    const denied = reason => ({ ok: false, reason: frozen?.uncertain ? 'a1_outcome_unknown' : reason })
    const authority = memoryAuthority()
    if (authority.status === 'blocked') return denied(authority.reason || 'a1_authority_invalid')
    const entry = kind === 'auto_context' ? 'memory_retrieve' : 'memory_search'
    if (authority.status !== 'active' || !authority.entries.includes(entry)) return denied('a1_entry_not_integrated')
    const proof = validateMemoryStrengthOrigin(origin, kind)
    if (!proof || proof.occurredAtMs < authority.cutoffAtMs) return denied('a1_origin_invalid')
    if (userId !== MASTER_ID || typeof query !== 'string' || !query.trim()
      || !Number.isInteger(topK) || topK < 1 || topK > 12) return denied('a1_invalid_input')
    const a1 = { protocol: authority.protocol, epoch: authority.epoch, generation: authority.generation }
    if (!frozen) {
      frozen = { intent, rankAtMs: Date.now(), request: null, business: null, fullResult: null,
        pending: null, uncertain: false, a1, rankingData: kind === 'auto_context' ? null : (() => {
          const lexicon = frameData().lexicon
          return freezeSnapshot(structuredClone({ lexicon: { stopwords: lexicon.stopwords, timeWords: lexicon.timeWords } }))
        })() }
      frozenRetrievals.set(origin, frozen)
    }
    if (!authorityBindingMatches(frozen.a1, authority)) return denied('a1_authority_changed')
    if (frozen.business) return frozen.business
    if (frozen.pending) return await frozen.pending
    const run = async () => {
      if (mode !== 'python' || pythonDown()) return denied('a1_peer_unavailable')
      if (!frozen.request) {
        const native = { kind, sourceIdentity: proof.sourceIdentity, occurredAtMs: proof.occurredAtMs,
          ...(kind === 'auto_context' ? { admissionIdentity: proof.admissionIdentity } : {}) }
        try {
          const prepared = await client.request('memory_retrieval_prepare', { a1, kind, origin: native,
            userId, query, topK, rankAtMs: frozen.rankAtMs, rankingData: frozen.rankingData,
            ...(opts === null ? {} : { opts }) })
          if (prepared.type !== 'memory_retrieval_prepare_result' || !authorityBindingMatches(prepared.a1, authority)
            || typeof prepared.payloadJson !== 'string' || Buffer.byteLength(prepared.payloadJson) > 16384) {
            return denied('a1_prepare_invalid')
          }
          const payload = JSON.parse(prepared.payloadJson)
          if (payload.userId !== MASTER_ID || payload.query !== query || payload.topK !== topK
            || payload.rankAtMs !== frozen.rankAtMs || JSON.stringify(payload.rankingData) !== JSON.stringify(frozen.rankingData)
            || Object.keys(payload).sort().join(',') !== 'opts,query,rankAtMs,rankingData,topK,userId'
            || Object.keys(payload.opts || {}).sort().join(',') !== 'augKeys,coreBlock,dedupe,expandScore,expandTerms,fusion,timeArm,timeMode'
            || payload.opts.dedupe !== (kind === 'auto_context')
            || Object.entries(opts || {}).some(([key, value]) => value !== undefined
              && JSON.stringify(payload.opts[key]) !== JSON.stringify(value))) return denied('a1_prepare_invalid')
          frozen.request = Object.freeze({ protocol: 'echo-memory-retrieval/v1', epoch: authority.epoch,
            ...native, payloadJson: prepared.payloadJson })
        } catch (error) {
          return denied(a1ServerReason(error, 'a1_prepare_failed') || 'a1_prepare_failed')
        }
      }
      const latest = memoryAuthority()
      if (latest.status !== 'active' || !authorityBindingMatches(a1, latest)) return denied('a1_authority_changed')
      if (!validateMemoryStrengthOrigin(origin, kind)) return denied('a1_origin_invalid')
      if (mode !== 'python' || pythonDown()) return denied('a1_peer_unavailable')
      const wasUncertain = frozen.uncertain
      frozen.uncertain = true
      try {
        const ack = await client.request('memory_retrieval_commit', { a1, request: frozen.request })
        if (ack.type !== (kind === 'auto_context' ? 'retrieve_result' : 'memory_search_result')
          || ack.retrievalReceipt?.accepted !== true || !['committed', 'duplicate'].includes(ack.retrievalReceipt?.status)
          || !Array.isArray(ack.items) || ack.items.length > 20 || ack.rankAtMs !== frozen.rankAtMs
          || !Number.isSafeInteger(ack.reinforced) || ack.reinforced < 0 || ack.reinforced > 12
          || ack.items.some(item => !Number.isSafeInteger(item?.memory_id ?? item?.memoryId)
            || (item.memory_id ?? item.memoryId) < 1)
          || (kind === 'auto_context' && typeof ack.text !== 'string')) return denied('a1_outcome_unknown')
        const { retrievalReceipt, reqId, ...business } = ack
        if (Buffer.byteLength(JSON.stringify(business)) > 262144) return denied('a1_outcome_unknown')
        frozen.business = business
        frozen.uncertain = false
        return business
      } catch (error) {
        const reason = a1ServerReason(error, 'a1_outcome_unknown') || 'a1_outcome_unknown'
        frozen.uncertain = wasUncertain || reason === 'a1_outcome_unknown'
        return denied(reason)
      }
    }
    frozen.pending = run()
    try { return await frozen.pending } finally { frozen.pending = null }
  }

  async function activeRetrieve(query, topK, extras) {
    if (extras.readOnlyStrength === true) {
      const authority = memoryAuthority()
      if (authority.status !== 'active' || !authority.entries.includes('memory_retrieve')) {
        return { ok: false, reason: authority.reason || 'a1_entry_not_integrated' }
      }
      try {
        const frame = await client.request('memory_retrieval_read', {
          a1: { protocol: authority.protocol, epoch: authority.epoch, generation: authority.generation },
          kind: 'auto_context', userId: MASTER_ID, query, topK,
          opts: { ...(extras.retrievalOpts || {}), reinforce: false }
        }, { timeoutMs: RETRIEVE_TIMEOUT_MS })
        if (frame?.type !== 'memory_retrieval_read_result'
          || frame.readOnly !== true || !Array.isArray(frame.items)
          || frame.writeChanges !== 0
          || typeof frame.text !== 'string') return { ok: false, reason: 'a1_outcome_unknown' }
        const association = associationShadow(frame.items.map(item => item.memory_id ?? item.memoryId), 'episode')
        const context = associationFields(association, frame.items)
        const memoryText = [frame.text ? '【情景记忆】\n' + frame.text : '',
          renderCoreMemories(context.coreMemories)].filter(Boolean).join('\n\n')
        let text = memoryText
        try {
          text = renderInjectedBlock({ memoryText, state: sameTurnState(store?.getState(), extras.sameTurnEmotion),
            profile: store?.getProfile(), now: extras.now ?? Date.now(), longingLine: extras.longingLine ?? '',
            emotionVector: extras.emotionVector ?? extras.sameTurnEmotion?.vector ?? null,
            shock: extras.shock ?? '', aliases: extras.aliases ?? null, groupAudience: extras.groupAudience ?? null })
        } catch { warn('a1 retrieval display_failed') }
        return withAssociation({ engine: 'python', text, graphHits: null, items: frame.items,
          readOnlyWriteChanges: frame.writeChanges,
          readOnlySnapshot: true }, context)
      } catch {
        return { ok: false, reason: 'a1_outcome_unknown' }
      }
    }
    const frame = await retrievalTransaction('auto_context', MASTER_ID, query, topK,
      extras.retrievalOpts ?? null, extras.origin)
    if (frame?.ok === false) return frame
    const frozen = frozenRetrievals.get(extras.origin)
    if (frozen.fullResult) return frozen.fullResult
    const association = associationShadow(frame.items.map(item => item.memory_id ?? item.memoryId), 'episode')
    const context = associationFields(association, frame.items)
    const memoryText = [frame.text ? '【情景记忆】\n' + frame.text : '', renderCoreMemories(context.coreMemories)]
      .filter(Boolean).join('\n\n')
    let text = memoryText
    try {
      text = renderInjectedBlock({ memoryText, state: sameTurnState(store?.getState(), extras.sameTurnEmotion),
        profile: store?.getProfile(), now: extras.now ?? frozen.rankAtMs, longingLine: extras.longingLine ?? '',
        emotionVector: extras.emotionVector ?? extras.sameTurnEmotion?.vector ?? null,
        shock: extras.shock ?? '', aliases: extras.aliases ?? null, groupAudience: extras.groupAudience ?? null })
    } catch { warn('a1 retrieval display_failed') }
    frozen.fullResult = withAssociation({ engine: 'python', text, graphHits: null, items: frame.items }, context)
    return frozen.fullResult
  }

  /** 引擎是否明确死透(可安全回落基线:没有并发写者)。 */
  const pythonDown = () => client === null || !client.running || client.state().breakerOpen
  function associationShadow (seedIds = [], memoryAuthority = 'legacy',
    sourceVersionProviderOverride = sourceVersionProvider, dbOverride = null) {
    try {
      const db = dbOverride ?? store?.db
      const options = { memoryAuthority, strengthShadow: associationStrengthShadow,
        unifiedShadow: dbOverride !== null || associationUnifiedShadow === true || associationSelection === 'unified',
        sourceVersionProvider: sourceVersionProviderOverride }
      return associationMode === 'explicit'
        ? retrieveConsolidationMemories(db, seedIds, RETRIEVAL_BOUNDS, 'hop_quota', 'hop_round_robin', options)
        : retrieveConsolidationMemories(db, seedIds, RETRIEVAL_BOUNDS, 'global', 'distance', options)
    } catch {
      return { status: 'failed', reason: 'association_failed', memories: [], metrics: {} }
    }
  }
  function selectedAssociation(result) {
    return associationSelection === 'unified' && ['ok', 'empty'].includes(result?.unifiedShadow?.status)
      ? result.unifiedShadow : result
  }
  function associationFields(result, seeds) {
    if (associationMode !== 'explicit') return {}
    result = selectedAssociation(result)
    const associationUse = result.status === 'ok' && result.memories.length ? {
      schema: 'echo-association-use/v1', explicit: true,
      entries: result.memories.map(row => ({ memoryId: String(row.memory_id), seedId: row.bestPath.seedId,
        nodeIds: [...row.bestPath.nodes], linkIds: [...row.bestPath.linkIds] }))
    } : null
    return { coreMemories: coreMemoryProjection(result), writerContext: writerMemoryProjection(store?.db, result, seeds), associationUse }
  }
  function withAssociation(result, context) {
    if (!context.writerContext) return result
    result.coreMemories = context.coreMemories
    Object.defineProperty(result, 'writerContext', { value: context.writerContext, enumerable: false })
    Object.defineProperty(result, 'associationUse', { value: context.associationUse, enumerable: false })
    return result
  }
  async function associationForCare(query) {
    const authority = memoryAuthority()
    if (authority.status === 'blocked') return entryRejected()
    if (associationMode !== 'explicit') return { status: 'shadow', coreMemories: [] }
    try {
      const pool = store.listMemories({ state: 'active', sort: 'recent', limit: 200 }).rows
      const seeds = rankMemories(pool, String(query || ''), 6, Date.now() / 1000, { coreBlock: false })
      const result = associationShadow(seeds.map(row => row.memoryId), authority.status === 'active' ? 'episode' : 'legacy', sourceVersionProvider)
      if (associationUnifiedShadow === true || associationSelection === 'unified') info('care ' + shadowAudit(result))
      return withAssociation({ status: selectedAssociation(result).status }, associationFields(result, seeds))
    } catch { return { status: 'unavailable', coreMemories: [] } }
  }
  function shadowAudit (result) {
    const selected = selectedAssociation(result)
    const metrics = selected?.metrics || {}
    const truncation = [...new Set(Array.isArray(metrics.truncated) ? metrics.truncated : [])]
    if (associationUnifiedShadow === true || associationSelection === 'unified') {
      const s = result?.metrics?.unifiedShadow || {}
      const selection = associationSelection === 'unified' ? selected === result ? 'fallback' : 'unified' : 'topology'
      const status = value => ['ok', 'empty', 'partial', 'failed', 'unavailable'].includes(value) ? value : 'unavailable'
      const reason = value => value == null ? 'none' : ASSOCIATION_AUDIT_REASONS.has(value) ? value : 'unrecognized_reason'
      const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 'na'
      const ms = Number.isFinite(s.elapsedMs) && s.elapsedMs >= 0
        ? s.elapsedMs <= 999999999 ? Math.round(s.elapsedMs * 1000) / 1000 : 'overflow' : 'na'
      const observed = UNIFIED_SHADOW_BOUNDS.adjacencyObservations * UNIFIED_SHADOW_BOUNDS.maxHops
      // Fixed bounded fields preserve all observation essentials; no trailing substring truncation.
      return [
        `${associationMode === 'explicit' ? 'association' : 'shadow'}_${status(selected?.status)}`,
        `c=${count(metrics.candidateCount, RETRIEVAL_BOUNDS.candidates)}`, `r=${count(metrics.returnedCount, RETRIEVAL_BOUNDS.memories)}`,
        `e=${count(metrics.edgeCount, RETRIEVAL_BOUNDS.trafficEdges)}`, `n=${count(metrics.nodeCount, RETRIEVAL_BOUNDS.trafficNodes)}`,
        `q=${count(metrics.queries, selection === 'unified' ? UNIFIED_SHADOW_BOUNDS.queries : RETRIEVAL_BOUNDS.queries)}`, `ft=${count(truncation.length, 64)}`,
        `unified=${status(s.status)}`, `uq=${count(s.queries, UNIFIED_SHADOW_BOUNDS.queries)}`,
        `uc=${count(s.candidateCount, UNIFIED_SHADOW_BOUNDS.candidates)}`,
        `um=${count(s.modeledEdges, observed)}`, `uu=${count(s.unknownEdges, observed)}`,
        `uf=${count(s.fallbackQueries, UNIFIED_SHADOW_BOUNDS.fallbackQueries)}`,
        `ur=${count(s.returnedCount, UNIFIED_SHADOW_BOUNDS.memories)}`, `ums=${ms}`,
        `why=${reason(s.reason ?? (result?.metrics?.unifiedShadow ? null : result?.reason || 'observation_unavailable'))}`,
        `uds=${status(s.dynamicStatus)}`, `ut=${Number.isSafeInteger(s.adjacencyTruncations) && Number.isSafeInteger(s.candidateTruncations)
          ? count(s.adjacencyTruncations + s.candidateTruncations, 4) : 'na'}`,
        `fr=${reason(selected?.reason)}`, `sel=${selection}`
      ].join(';')
    }
    const fields = [
      `${associationMode === 'explicit' ? 'association' : 'shadow'}_${String(result?.status || 'unavailable')}`,
      `c=${Number.isSafeInteger(metrics.candidateCount) ? metrics.candidateCount : 0}`,
      `r=${Number.isSafeInteger(metrics.returnedCount) ? metrics.returnedCount : 0}`,
      `e=${Number.isSafeInteger(metrics.edgeCount) ? metrics.edgeCount : 0}`,
      `n=${Number.isSafeInteger(metrics.nodeCount) ? metrics.nodeCount : 0}`,
      `q=${Number.isSafeInteger(metrics.queries) ? metrics.queries : 0}`,
      `t=${truncation.slice(0, 8).map(value => String(value).replace(/[^a-z_]/gu, '').slice(0, 24)).join(',') || 'none'}`,
      associationMode === 'explicit' ? 'rank=hop_round_robin' : 'rank=distance_only_not_legacy_equivalent'
    ]
    if (result?.reason) fields.push(`reason=${String(result.reason).replace(/[^a-z_]/gu, '').slice(0, 32)}`)
    if (associationStrengthShadow === true && metrics.strengthShadow) {
      const s = metrics.strengthShadow
      fields.push(`strength=${s.status}`, `sc=${s.candidateCount}`, `sf=${s.fallbackCount}`,
        `sx=${s.changedPositions}`, `sq=${s.queries}`)
    }
    return fields.join(';').slice(0, 240)
  }

  async function init () {
    try {
      const authority = memoryAuthority()
      if (authority.status === 'blocked') throw Error(authority.reason || 'a1_authority_invalid')
      const detectFn = detect ?? detectPython
      pythonInfo = await detectFn()
      if (pythonInfo === null) {
        warn('python not found — engine stays ' + mode + ' (JS baseline)')
        return mode
      }
      // clientOpts.client 是**测试缝**:注入一个假 client 就能查"引擎实际发出
      // 的帧长什么样"。想念九项那次真漏(面板调了引擎收不到)就是因为只测了
      // 翻译函数、没测接线 —— 有这条缝之后电池可以直接断言帧内容。
      client = (clientOpts && clientOpts.client) || new SidecarClient({
        pythonPath: pythonInfo.path, workerPath: WORKER_PATH, dbPath,
        logger: log, timeoutMs: EXTRACT_TIMEOUT_MS,
        ...(clientOpts || {}),
        ...(authority.status === 'active' ? { a1: { protocol: authority.protocol,
          epoch: authority.epoch, generation: authority.generation }, a1Entries: authority.entries } : {})
      })
      const ready = await client.start()
      if (authority.status === 'active' && (!authorityBindingMatches({
        protocol: authority.protocol, epoch: authority.epoch, generation: authority.generation
      }, ready.a1) || ready.a1?.status !== 'active'
        || ready.a1?.strengthProtocol !== 'echo-memory-strength/v1'
        || ready.a1?.bodyProtocol !== 'echo-memory-body/v1'
        || JSON.stringify(ready.a1?.entries) !== JSON.stringify(authority.entries)
        || !Array.isArray(ready.a1?.supportedEntries)
        || !authority.entries.every(entry => ready.a1.supportedEntries.includes(entry)))) {
        await client.stop()
        throw Error('a1_peer_mismatch')
      }
      mode = 'python'
      info('engine=python — worker v' + ready.version + ' ready (' + pythonInfo.path + ')')
    } catch (err) {
      client = null
      mode = store !== null ? 'baseline' : 'offline'
      warn('python engine unavailable — ' + String(err?.message ?? err) + ' — engine stays ' + mode)
    }
    return mode
  }

  async function stop () {
    if (client !== null) { try { await client.stop() } catch { } }
  }

  /**
   * 检索 + 渲染注入文本。返回 { engine, text, graphHits } | null
   * (null = 本轮跳过)。text 为空串时调用方也不注入(没有记忆就不
   * 注入,绝不编造)。
   *
   * Legacy graphHits remain in the result for the existing round-end feedback path.
   * Consolidation Traffic diffusion is shadow-only here and never alters the prompt.
   */
  /**
   * 只读图查询:只发 `graph_query`,**不召回、不强化** —— 不写 recall_count、不动 LTP。
   *
   * 为什么单开一个入口而不是复用 `retrieve`:`retrieve` 的语义是「她真的想起来了」,
   * 所以引擎侧对命中做「召回即强化」(`python/worker.py:200-201`)—— 那条语义是对的。
   * 但主动开口前「看看有什么线可接」**不是**想起:她没用到那条记忆,强化它就是
   * 给不相关的记忆反复加权重,久了会失真。所以这里照 `retrieve` 内部那一小段的形状
   * 复制一份(故意不共用,免得哪天有人顺手在共用点上加回强化)。
   *
   * 返回形状与 retrieve 内部的 graphHits 一致:`{ pathsText, seedNames, hitEdgeIds, ltpEdgeIds }`;
   * 引擎不在/失败 ⇒ 返回 null(调用方整段消失,不报错)。
   */
  async function graphPaths (query, extraSeeds = null) {
    if (memoryFence()) return entryRejected()
    if (mode !== 'python' || pythonDown()) return null
    try {
      const g = await client.request('graph_query', {
        userId: MASTER_ID,
        text: String(query || ''),
        now: null,
        extraSeeds: Array.isArray(extraSeeds) && extraSeeds.length > 0 ? extraSeeds : null
      }, { timeoutMs: RETRIEVE_TIMEOUT_MS })
      return {
        pathsText: String(g.pathsText || ''),
        seedNames: Array.isArray(g.seedNames) ? g.seedNames : [],
        hitEdgeIds: Array.isArray(g.hitEdgeIds) ? g.hitEdgeIds : [],
        ltpEdgeIds: Array.isArray(g.ltpEdgeIds) ? g.ltpEdgeIds : [],
      }
    } catch (err) {
      warn('graphPaths failed — 只丢这一段: ' + String(err?.message ?? err))
      return null
    }
  }

  // Abort diagnostic work before the transport's worker-killing timeout.
  const snapshotRequestOptions = () => ({
    signal: AbortSignal.timeout(RETRIEVE_TIMEOUT_MS), timeoutMs: 2 * RETRIEVE_TIMEOUT_MS
  })
  let snapshotInFlight = false, pendingSnapshot = null
  async function releaseObservedSnapshot (attempt) {
    if (attempt.reader) {
      try {
        const closed = await attempt.reader.close()
        if ((closed === undefined || closed === true || closed?.status === 'closed')
          && attempt.reader.db?.isOpen !== true) attempt.reader = null
      } catch { /* No proof of release. */ }
    }
    for (let retry = 0; attempt.handle !== null && retry < 2; retry++) {
      try {
        const result = await attempt.peer.closeMemorySnapshot(attempt.handle, {
          ...snapshotRequestOptions(), reclaim: true
        })
        if (result?.status === 'closed' && result.handle === attempt.handle) attempt.handle = null
      } catch { /* Retry only this attempt's handle. */ }
    }
    if (attempt.reader || attempt.handle !== null) return false
    try { return !attempt.cleanup || await attempt.cleanup() === true } catch { return false }
  }

  async function readRetrievalSnapshot (retrieveArgs, graphArgs, extraSeeds,
    { sessionId, turnTrace, attemptId, ownerSummary }, attempt) {
    const { peer } = attempt
    const input = { dbPath, query: retrieveArgs.query, topK: retrieveArgs.topK,
      sessionId, turnTrace, attemptId, ownerSummary, retrievalOpts: retrieveArgs.opts ?? null }
    const created = typeof snapshotSource === 'function' ? await snapshotSource(input)
      : await snapshotSource?.create?.(input)
    if (typeof created?.cleanup === 'function') attempt.cleanup = () => created.cleanup()
    if (created?.status !== 'ready') return null
    const capability = created.capability
    if (typeof capability?.manifest !== 'function' || typeof capability.openReader !== 'function') return null
    const manifest = capability.manifest()
    const receipt = { ...manifest?.receipt }
    const scope = { ownerHash: ownerSummary.ownerHash, turnHash: snapshotHash(turnTrace),
      attemptHash: snapshotHash(attemptId) }
    if (receipt.protocol !== SNAPSHOT_PROTOCOL || manifest.protocol !== receipt.protocol
      || !['immutable_export', 'backup_export'].includes(receipt.kind) || manifest.kind !== receipt.kind
      || typeof manifest.handle !== 'string' || !/^snapshot_[a-f0-9]{48}$/u.test(manifest.handle)
      || created.tokenHash !== receipt.tokenHash
      || !SNAPSHOT_HASH_FIELDS.every(key => typeof receipt[key] === 'string'
        && SNAPSHOT_DIGEST.test(receipt[key]) && receipt[key] !== '0'.repeat(64))
      || !Object.entries(scope).every(([key, value]) => receipt[key] === value)) return null

    const options = snapshotRequestOptions()
    attempt.handle = manifest.handle
    const installed = await peer.installMemorySnapshot(manifest, options)
    if (installed?.status !== 'ready' || installed.handle !== manifest.handle) return null
    if (options.signal.aborted) return null
    const binding = { snapshotHandle: attempt.handle, ...scope }
    const frame = await peer.request('retrieve', { ...retrieveArgs, ...binding }, options)
    if (!matchesSnapshotReceipt(frame, 'retrieve_result', receipt) || frame.reinforced !== 0
      || !Array.isArray(frame.items) || options.signal.aborted) return null
    const seeds = collectSeeds(frame.items, extraSeeds)
    const graph = await peer.request('graph_query', { ...graphArgs,
      extraSeeds: seeds.length > 0 ? seeds : null, ...binding }, options)
    if (!matchesSnapshotReceipt(graph, 'graph_query_result', receipt) || options.signal.aborted) return null

    // Open after the Python reads; the local read may create WAL coordination files.
    const opened = await capability.openReader()
    const reader = attempt.reader = opened?.reader
    if (opened?.status !== 'ready' || typeof reader?.db?.prepare !== 'function'
      || typeof reader.close !== 'function') return null
    const token = Object.freeze({ tokenHash: receipt.tokenHash, schemaHash: receipt.schemaHash,
      contentHash: receipt.contentHash, ...scope })
    const provider = challenge => Object.freeze({
      challenge, kind: 'immutable_export', token, atomic: true, status: 'ready'
    })
    const association = associationShadow(
      frame.items.map(item => item?.memoryId ?? item?.memory_id ?? item?.id).filter(Boolean),
      'episode', provider, reader.db)
    if (['ok', 'empty'].includes(association.unifiedShadow?.status) && !options.signal.aborted) {
      return { association, formalSourceResult: bindFormalSourceVersion(association),
        formalItems: frame.items, formalCandidateMeta: frame.candidateMeta }
    }
    return null
  }

  async function observeRetrievalSnapshot (retrieveArgs, graphArgs, extraSeeds, binding) {
    const { sessionId, turnTrace, attemptId, ownerSummary } = binding
    const peer = client
    if (!graphArgs || ownerSummary?.status !== 'verified' || !sessionId || !turnTrace
      || !attemptId || ownerSummary.sessionHash !== snapshotHash(sessionId)
      || pythonDown() || typeof peer.installMemorySnapshot !== 'function'
      || typeof peer.closeMemorySnapshot !== 'function') return null
    const cleanupPending = { failureReason: 'snapshot_cleanup_pending' }
    if (snapshotInFlight) return pendingSnapshot ? cleanupPending : null
    snapshotInFlight = true
    try {
      // Retain at most one owned attempt; new exports wait until it is safely reclaimed.
      if (pendingSnapshot && !await releaseObservedSnapshot(pendingSnapshot)) return cleanupPending
      pendingSnapshot = null
      const attempt = { peer, handle: null, reader: null, cleanup: null }
      let observation = null
      try {
        observation = await readRetrievalSnapshot(retrieveArgs, graphArgs, extraSeeds, binding, attempt)
      } catch { /* Snapshot failures never replace business results. */ }
      finally {
        if (!await releaseObservedSnapshot(attempt)) pendingSnapshot = attempt
      }
      return pendingSnapshot ? cleanupPending : observation
    } finally {
      snapshotInFlight = false
    }
  }

  const strengthFor = (value, readOnly) => {
    const items = Array.isArray(value?.items) ? value.items : null
    if (readOnly === true) return {
      status: 'skipped', attempted: false, writtenCount: 0,
      eventCount: items ? items.length : null, reason: 'maintenance_closed'
    }
    if (value === null || typeof value !== 'object') return {
      status: 'failed', attempted: false, writtenCount: null,
      eventCount: items ? items.length : null, reason: 'retrieval_failed'
    }
    if (value?.status === 'unknown' || value?.status === 'partial' || value?.reason === 'a1_outcome_unknown') {
      return {
        status: 'unknown', attempted: true, writtenCount: null,
        eventCount: items ? items.length : null, reason: value.reason || 'a1_outcome_unknown'
      }
    }
    return {
      status: items && items.length === 0 ? 'no_op' : 'committed',
      attempted: true, writtenCount: Number.isSafeInteger(Number(value.reinforced)) ? Number(value.reinforced) : null,
      eventCount: items ? items.length : null, reason: null
    }
  }

  async function retrieveBusiness (query, topK = 6, extras = {}) {
    if (memoryFence()) return await activeRetrieve(query, topK, extras)
    // 2026-09-30:检索三项(常驻不占席 / 词法长尾臂 / 时间臂)由设置经 `extras.retrievalOpts`
    // 递进去 —— 引擎侧 `retrieve.PROD_*` 是"生产默认",这里是"他改过的覆盖"。
    // 不传 ⇒ 引擎用自己的生产默认(与设置默认一致,不两头各写一份)。
    const ro = (extras.retrievalOpts && typeof extras.retrievalOpts === 'object')
      ? extras.retrievalOpts
      : null
    const retrievalOptions = extras.readOnlyStrength === true
      ? { ...(ro || {}), reinforce: false } : ro
    const observerSessionId = String(extras.sessionId ?? '')
    let observerTurnTrace = String(extras.turnTrace ?? '')
    if (observerTurnTrace === '' && typeof auditTraceOf === 'function') {
      try { observerTurnTrace = String(auditTraceOf(extras.sessionId) || '') } catch { }
    }
    let suppliedAttemptId
    try { suppliedAttemptId = attemptIdOf?.({ sessionId: observerSessionId, turnTrace: observerTurnTrace }) } catch { }
    const observerAttemptId = typeof suppliedAttemptId === 'string' && suppliedAttemptId !== ''
      ? suppliedAttemptId : randomUUID()
    let observerOwner = null
    ownerScopeContext = Object.freeze({
      sessionId: observerSessionId, turn: observerTurnTrace, attempt: observerAttemptId
    })
    try {
      observerOwner = ownerScopeVerifier.observe({ turn: observerTurnTrace, attempt: observerAttemptId })
    } catch { /* A broken proof provider is not a retrieval failure. */
    } finally {
      ownerScopeContext = null
    }
    let recordRetrieve = () => {}
    if (extras.readOnlyStrength !== true) {
      try {
        recordRetrieve = createRetrieveAudit({ store, query, topK, options: retrievalOptions, extraSeeds: extras.extraSeeds,
          sessionId: observerSessionId, turnTrace: observerTurnTrace })
      } catch { /* A failed observation setup must not skip retrieval. */ }
    }
    if (mode === 'python' && !pythonDown()) {
      let observedReturned = null
      let graphStatus = 'not_requested', graphError = null
      try {
        const retrieveArgs = { userId: MASTER_ID, query, topK,
          ...(retrievalOptions === null ? {} : { opts: retrievalOptions }) }
        const frame = await client.request('retrieve', retrieveArgs, { timeoutMs: RETRIEVE_TIMEOUT_MS })
        try { observedReturned = captureRetrievedItems(frame.items) } catch { }
        // Formal core and writer projections always use the live association.
        const episodic = String(frame.text || '')
        const retrievalAuthority = memoryAuthority()
        const associationAuthority = retrievalAuthority.status === 'active'
          && Array.isArray(retrievalAuthority.entries)
          && retrievalAuthority.entries.includes('memory_association')
          ? 'episode' : 'legacy'
        const association = associationShadow(
          (frame.items || []).map(item => item?.memoryId ?? item?.memory_id ?? item?.id).filter(Boolean),
          associationAuthority)
        const associationContext = associationFields(association, frame.items || [])
        let graphArgs = null
        let extraSeeds = null
        let graphHits = null
        try {
          // F6(2026-09-27):把刚检索到的情景记忆的关键词当作图种子 ——
          // 通道②终于接上了(此前恒为 null ⇒ 每轮掉进机械兜底 ⇒ BFS 0 路径)。
          extraSeeds = extras.extraSeeds
          const seeds = collectSeeds(frame.items, extraSeeds)
          graphArgs = {
            userId: MASTER_ID,
            text: query,
            // v0.14.2 单位事故修正:引擎侧一律 **epoch 秒**,而壳的
            // extras.now 是毫秒(供 JS 渲染钟面用)。此前原样透传:
            // 引擎把 1.79e12 当秒算 Δt(≈49.7 万小时)→ R 恒为 0 →
            // 每条边都被判「休眠」不参与扩散,注入里只剩置顶的核心边
            // —— 与 A 侧 v8.9.3 法医记录的症状一模一样(186 轮 BFS
            // 零扩散、图每轮只贡献 pinned 的 L0 边)。新建边因
            // last_accessed=0 走 now 兜底,恰好躲过一枪,所以只有
            // 「有真实历史时钟的边」才暴露。
            now: extras.now !== null && extras.now !== undefined
              ? Math.floor(Number(extras.now) / 1000)
              : null,
            extraSeeds: seeds.length > 0 ? seeds : null
          }
          const g = await client.request('graph_query', graphArgs, { timeoutMs: RETRIEVE_TIMEOUT_MS })
          graphHits = {
            hitEdgeIds: Array.isArray(g.hitEdgeIds) ? g.hitEdgeIds : [],
            ltpEdgeIds: Array.isArray(g.ltpEdgeIds) ? g.ltpEdgeIds : [],
            // 2026-10-09:节点/谓词文本也带回 —— 关怀路的 [可以接的线] 用它(它原来只喂对话轮注入,被丢在这里)。
            pathsText: String(g.pathsText || ''),
          }
          graphStatus = 'ok'
        } catch (err) {
          graphStatus = 'failed'
          try { graphError = String(err?.message ?? err).slice(0, 120) } catch { }
          // 图那一段掉了,情景记忆不许陪葬
          warn('graph_query failed — 本轮只注入情景记忆: ' + String(err?.message ?? err))
        }
        const parts = []
        // Legacy graphHits remain available to existing consumers, but are not the new memory context.
        if (episodic !== '') parts.push('【情景记忆】\n' + episodic)
        const associationText = renderCoreMemories(associationContext.coreMemories)
        if (associationText) parts.push(associationText)
        const text = renderInjectedBlock({
          memoryText: parts.join('\n\n'),
          state: sameTurnState(store !== null ? store.getState() : null, extras.sameTurnEmotion),
          profile: store !== null ? store.getProfile() : null,
          // v0.6.0:钟面(恒注入)与想念行(调用方已过 ≥1.0 门)进同一封信
          now: extras.now ?? null,
          longingLine: extras.longingLine ?? '',
          // v0.15.0 S13/S14:漂移强化期的覆写与临场修正、别名接地
          // v0.40.0 C1:漂移强化期照旧**强制覆写**(他的裁定不许被同轮读数顶掉);
          // 其余时候同轮读数进 emotionVector ⇒ 心情那一块按新读数渲染。
          emotionVector: extras.emotionVector ?? ((extras.sameTurnEmotion && extras.sameTurnEmotion.vector) || null),
          shock: extras.shock ?? '',
          aliases: extras.aliases ?? null,
          groupAudience: extras.groupAudience ?? null
        })
        const result = withAssociation({ engine: 'python', text, graphHits, items: frame.items }, associationContext)
        recordRetrieve({ engine: 'python', status: 'success', returned: observedReturned, graph: graphStatus, graphError,
          association: shadowAudit(association), readOnly: extras.readOnlyStrength === true,
          strengthWrite: strengthFor(result, extras.readOnlyStrength === true) })
        // RT9:先把这一问的账记下来(只记不判;记不下来也只丢这一条)
        try {
          const evidence = snapshotObserver === true
            ? await observeRetrievalSnapshot(retrieveArgs, graphArgs, extraSeeds, {
                sessionId: observerSessionId, turnTrace: observerTurnTrace,
                attemptId: observerAttemptId, ownerSummary: observerOwner
              })
            : { association, formalSourceResult: bindFormalSourceVersion(association) }
          const observer = buildRetrievalObserver({
            formalItems: frame.items, formalCandidateMeta: frame.candidateMeta,
            formalEngine: 'python', ...evidence,
            ownerSummary: observerOwner,
            sessionId: observerSessionId, turnTrace: observerTurnTrace,
            attemptId: observerAttemptId, rankAtMs: null, bounds: {
              candidates: RETRIEVAL_BOUNDS.candidates, outputs: RETRIEVAL_BOUNDS.memories,
              seeds: RETRIEVAL_BOUNDS.seeds, maxHops: RETRIEVAL_BOUNDS.maxHops,
              trafficEdges: RETRIEVAL_BOUNDS.trafficEdges, trafficNodes: RETRIEVAL_BOUNDS.trafficNodes
            }
          })
          ledger?.push?.(ledgerEntry({
            query, engine: 'python', topK, items: frame.items, now: Date.now(), observer
          }))
        } catch { /* Observer failure cannot affect formal retrieval. */ }
        return result
      } catch (err) {
        recordRetrieve({ engine: 'python', status: 'failed', returned: observedReturned, graph: graphStatus, graphError,
          error: err?.message ?? err, readOnly: extras.readOnlyStrength === true,
          strengthWrite: strengthFor(null, extras.readOnlyStrength === true) })
        // 模糊态:进程可能还在处理这一发 —— 跳过本轮,不切基线(防双写)
        warn('retrieve via python failed — skip this turn: ' + String(err?.message ?? err))
        return null
      }
    }
    if (mode === 'python' && pythonDown()) {
      // 明确死透:回落基线(她不能因为引擎坏了就失忆)
      warn('python engine down — retrieve falls back to JS baseline')
    }
    if (mode !== 'baseline' && mode !== 'python') { recordRetrieve({ engine: mode, status: 'no_run' }); return null }
    if (store === null) return null
    let observedReturned = null
    try {
      // 基线只镜像得动「常驻不占席」那一项(词法长尾臂/时间臂是引擎侧实现,
      // 基线不另写一份 —— 两条路各写一遍必漂移,那是这个仓吃过亏的地方)。
      const memories = store.retrieve(query, topK, Date.now() / 1000,
        retrievalOptions === null ? null : {
          coreBlock: retrievalOptions.coreBlock !== false,
          // 2026-09-30:说法键进打分正文(与 python 帧同一个开关同一个值)
          augKeys: retrievalOptions.augKeys !== false,
          reinforce: retrievalOptions.reinforce !== false
        })
      try { observedReturned = captureRetrievedItems(memories) } catch { }
      const memoryText = renderMemoryList(memories)
      const association = associationShadow(
        memories.map(item => item?.memoryId ?? item?.id).filter(Boolean),
        'legacy', sourceVersionProvider)
      const formalSourceResult = snapshotObserver === true ? null : bindFormalSourceVersion(association)
      const associationContext = associationFields(association, memories)
      try {
        const observer = buildRetrievalObserver({
          formalItems: memories, formalEngine: 'baseline',
          association: snapshotObserver === true ? null : association,
          formalSourceResult,
          ownerSummary: observerOwner,
          sessionId: observerSessionId, turnTrace: observerTurnTrace,
          attemptId: observerAttemptId, rankAtMs: null, bounds: {
            candidates: RETRIEVAL_BOUNDS.candidates, outputs: RETRIEVAL_BOUNDS.memories,
            seeds: RETRIEVAL_BOUNDS.seeds, maxHops: RETRIEVAL_BOUNDS.maxHops,
            trafficEdges: RETRIEVAL_BOUNDS.trafficEdges, trafficNodes: RETRIEVAL_BOUNDS.trafficNodes
          }
        })
        ledger?.push?.(ledgerEntry({
          query, engine: 'baseline', topK, items: memories, now: Date.now(), observer
        }))
      } catch { /* Observer failure cannot affect formal retrieval. */ }
      const text = renderInjectedBlock({
        memoryText: [memoryText, renderCoreMemories(associationContext.coreMemories)].filter(Boolean).join('\n\n'),
        state: sameTurnState(store.getState(), extras.sameTurnEmotion),
        profile: store.getProfile(),
        now: extras.now ?? null,
        longingLine: extras.longingLine ?? '',
        emotionVector: extras.emotionVector ?? ((extras.sameTurnEmotion && extras.sameTurnEmotion.vector) || null),
        shock: extras.shock ?? '',
        aliases: extras.aliases ?? null,
        groupAudience: extras.groupAudience ?? null
      })
      recordRetrieve({ engine: 'baseline', status: 'success', returned: observedReturned,
        association: shadowAudit(association), readOnly: extras.readOnlyStrength === true,
        strengthWrite: strengthFor({ items: memories, reinforced: memories.length }, extras.readOnlyStrength === true) })
      return withAssociation({ engine: 'baseline', text, items: memories }, associationContext)
    } catch (err) {
      recordRetrieve({ engine: 'baseline', status: 'failed', returned: observedReturned, error: err?.message ?? err,
        readOnly: extras.readOnlyStrength === true, strengthWrite: strengthFor(null, extras.readOnlyStrength === true) })
      warn('retrieve via baseline failed: ' + String(err?.message ?? err))
      return null
    }
  }

  async function retrieve (query, topK = 6, extras = {}) {
    let token = null
    let readOnlyStrength = false
    if (maintenance !== null) {
      let admission
      try { admission = maintenance.admit('memory_retrieval_strength') } catch {
        readOnlyStrength = true
      }
      if (admission?.accepted === true) token = admission.token ?? null
      else readOnlyStrength = true
    }
    let result
    try {
      result = await retrieveBusiness(query, topK, { ...extras, readOnlyStrength })
    } catch (error) {
      if (token !== null) {
        try { maintenance.unknown(token) } catch {}
      }
      throw error
    }
    const uncertain = result === null
      || result?.reason === 'a1_outcome_unknown'
      || result?.status === 'unknown' || result?.status === 'partial'
    if (token !== null) {
      try { (uncertain ? maintenance.unknown : maintenance.complete)(token) } catch {}
    }
    if (result === null || typeof result !== 'object') return result
    const authority = memoryAuthority()
    const strengthWrite = strengthFor(result, readOnlyStrength)
    const readSnapshot = Object.freeze({
      authority: {
        status: authority.status, protocol: authority.protocol ?? null,
        epoch: authority.epoch ?? null, generation: authority.generation ?? null,
        cutoffAtMs: authority.cutoffAtMs ?? null
      },
      ranking: Object.freeze({ topK, retrievalOpts: extras.retrievalOpts ?? null }),
      projection: Object.freeze({ core: 'frozen', writer: 'frozen' })
    })
    const enriched = { ...result, readSnapshot, strengthWrite }
    for (const key of ['writerContext', 'associationUse']) {
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        Object.defineProperty(enriched, key, {
          value: result[key], enumerable: false, configurable: true
        })
      }
    }
    return enriched
  }

  /** extract_commit ack 的壳侧落地:状态/称呼/审计(表都是壳拥有的)。 */
  function applyExtractAck (ack, { userText, assistantText, injectedMemories, injectedProfile = '', latencyMs = null, sessionId = '', traceId = '', turnTrace = '', turnTraceCaptured = false, onCommit = null, associationAudit = null }) {
    if (store === null) return
    const ex = (ack && ack.extract && typeof ack.extract === 'object') ? ack.extract : {}
    const prev = store.getState()
    // v0.14.4 S7:引擎侧只做合法性三层校验,**向量清洗在壳侧**——
    // agent_state 是壳拥有的表(引擎只读,longing.py:277 自述),钳位/
    // 缺维补默认/未触及组回填 prev 三件事与基线路径共用同一份
    // emotion.js(两个真相源最容易漂的地方,只留一个)。
    // ⚠️ 2026-10-07 事故(P5c 同族,第二处写者):`applyEmotionVector` 内部只走
    // `clampEmotionVector` —— **只重建已知的情绪维** ⇒ `emotion_vector` 里的额外键
    // (轮末异步判定留下的 `ipc_dyad`:用户侧坐标 + 残差对账)会被抹掉,判定结果
    // **活不过下一轮反思**:面板上的青点 / 六个关系量 / 残差卡永远是"缺席"。
    // 所以写库前用 `carryExtraEmotionKeys()` 把额外键原样带回来(纯函数见 lib/emotion.js）。
    const nextVector = carryExtraEmotionKeys(
      prev.emotionVector, applyEmotionVector(prev.emotionVector, ex.emotionVector))
    const delta = emotionDelta(prev.emotionVector, nextVector)
    const name = (typeof ack.name === 'string' && ack.name.trim()) ? ack.name.trim() : null
    if (name !== null) {
      // v0.37.0 G2:改名那一刻记下**旧名**(壳侧收进 retiredAliases)——
      // 记忆里全是旧称呼,不记下来她下一轮就会把旧名贴回他脸上。
      try {
        const prevName = String((store.getProfile() || {}).name || '').trim()
        if (prevName !== '' && prevName !== name && typeof onCommit === 'function') onCommit(prevName, name)
        else if (prevName !== '' && prevName !== name && typeof onNameChange === 'function') onNameChange(prevName, name)
      } catch { /* 记不下不阻止改名本身 */ }
      store.setName(name)
    }
    store.saveState({
      moodIntensity: ex.moodIntensity,
      prevMoodIntensity: prev.moodIntensity,
      userEmotion: ex.emotionState,
      moodReason: ex.moodReason,
      currentTopic: (Array.isArray(ex.keywords) && ex.keywords[0]) || '',
      emotionVector: nextVector,
      previousEmotionVector: prev.emotionVector
    })
    const auditTurnTrace = turnTraceCaptured === true ? String(turnTrace || '') : (traceId !== '' ? String(traceId) : '')
    store.writeAudit({
      traceId: randomUUID(),
      turnTraceCaptured: turnTraceCaptured === true,
      // 期 0(2026-10-09):轮末提取落地(python 路径)—— 与基线路径的 reflect 同 stage 同 step。
      stage: 'extract',
      step: 7,
      // v0.30.0 修:以前这里不写 session_id —— writeAudit 的兜底是
      // `row.sessionId || GLOBAL_SESSION`,于是**每一行反思审计都落成
      // 字面量 'global'**。活库实测 100 行审计全是 'global',面板那张
      // 「她见过的会话」列表因此永远只有一行、认不出谁是谁,会话分闸
      // 等于没法用(他 2026-09-27 问「我怎么没有看到哪个单独的会话里面
      // 出现了开关」就是这个)。heartbeat / turn-stopping 早就修过同一个病,
      // 反思这两条路漏了。
      sessionId: sessionId || undefined,
      userInput: userText,
      injectedProfile,
      injectedMemories,
      emotionPack: describeMood(prev),
      llmReply: assistantText,
      latency: latencyMs,
      moodIntensity: ex.moodIntensity,
      prevMoodIntensity: prev.moodIntensity,
      emotionVector: nextVector,
      emotionDelta: formatEmotionDelta(delta),
      toolCall: 'extract',
      // v0.21.0 E5:Judge 的两个余波字段(A 侧同一行的 say_again/extra_reply)。
      // 这一行记的是**判官说了什么**(say_again=1),不代表那句话最后真发了 ——
      // 真发/撤回各写自己的行(`toolCall:'say_again'` / `'say_again_failed'`),
      // 所以"记了没发"在审计里分得清。缺字段时留 NULL(老行为,不编 0)。
      sayAgain: ex.sayAgain,
      extraReply: ex.extraReply,
      // 2026-10-11 修(可观测性):判官这一轮的**图账**以前一个字都不落库 ——
      // `triplesRaw / triplesWritten / triplesRejected(带理由) / learned /
      // graphError` 只活在宿主 stdout 的 info 行里。于是「知识图谱为什么
      // 不动」既看不出"模型没给三元组",也看不出"给了但被过滤",更看不出
      // "写边抛错了"(judge.py 原来把异常吞成 learned=0)。
      // 现在随 extract 审计行一起落 `stage_detail`,可按行查。
      stageDetail: (() => {
        try {
          const st = (ack && ack.stats && typeof ack.stats === 'object') ? ack.stats : {}
          const dropped = Array.isArray(ack && ack.triplesRejected) ? ack.triplesRejected : []
          return JSON.stringify({
            triplesRaw: st.triplesRaw,
            triplesSchemaRejected: st.triplesSchemaRejected,
            triplesWritten: st.triplesWritten,
            triplesRejected: st.triplesRejected,
            learned: (ack && ack.learned) || 0,
            graphError: (ack && ack.graphError) || '',
            // 被丢的三元组各带一句理由(shouldWrite=false / 不可归因 / …)——
            // 这是回答"图谱为什么没长"最直接的一格。
            dropReasons: dropped.slice(0, 5),
            ...(auditTurnTrace !== '' ? { turnTrace: auditTurnTrace } : {}),
            ...(associationAudit ? { association: associationAudit } : {})
          })
        } catch { return '' }
      })()
    })
    // v0.18.3 M3:画像常驻锚点**落库**(A `_apply_profile_update`)。
    // 这一帧以前只打日志(「no column yet」)—— 语言/代词永远进不了她的
    // 常驻视野,画像层等于只有称呼。白名单/上限/删除纪律在 store 里
    // (A v8.1 的原话:只有 语言/代词 能进 core_traits,其余交记忆层)。
    if (ack.profileUpdate && typeof ack.profileUpdate === 'object') {
      const applied = store.saveProfileTraits(ack.profileUpdate)
      if (applied.saved.length > 0) {
        info('画像常驻锚点已更新:' + applied.saved.join('/'))
      }
      if (applied.dropped.length > 0) {
        // A 也是记一条日志而不是静默丢弃 —— 这些键应由记忆系统承载。
        info('画像丢弃 ' + applied.dropped.length + ' 个非白名单键(常驻区只留 语言/代词):'
          + applied.dropped.join('/'))
      }
    }
  }

  /**
   * Active A1 extract commit: the host-owned state changes and the JS receipt
   * share one SQLite transaction. A committed js_ack is the replay barrier;
   * its side effects were committed with it, so an exact retry must not apply
   * the model result a second time.
   */
  function applyExtractAckAtomically (ack, context, requestHash, expected) {
    if (store === null) throw Error('a1_store_unavailable')
    const db = store.db
    let owned = false
    const deferredNameChanges = []
    try {
      if (db.isTransaction) throw Error('extract_transaction_already_open')
      db.exec('BEGIN IMMEDIATE')
      owned = true
      const existing = db.prepare(
        "SELECT status FROM memory_extract_stage_receipts" +
        " WHERE request_hash=? AND stage='js_ack' AND action_key='host'"
      ).get(requestHash)
      const replay = existing?.status === 'committed'
      const result = applyExtractHostAck(db, requestHash, ack, Date.now(), expected)
      if (!replay && result.status === 'committed') applyExtractAck(result.ack, { ...context,
        onCommit: (oldName, newName) => deferredNameChanges.push([oldName, newName]) })
      if (owned) db.exec('COMMIT')
      if (owned) for (const [oldName, newName] of deferredNameChanges) {
        try { onNameChange?.(oldName, newName) } catch { /* file settings are best effort */ }
      }
      return { ...result, replay }
    } catch (error) {
      if (owned) {
        try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
      }
      throw error
    }
  }

  async function reflectActive(subagents, args, authority) {
    const { origin, userText, assistantText, prevVector, sessionId, parent,
      dedupeSimilarity, dedupeSummarySimilarity, associationAudit } = args
    const proof = validateMemoryStrengthOrigin(origin, 'extract')
    if (!proof || !Number.isSafeInteger(proof.endSeq) || proof.endReason !== 'completed'
      || proof.sessionId !== sessionId || parent?.session?.id !== sessionId
      || proof.occurredAtMs < authority.cutoffAtMs) return { ok: false, status: 'failed',
        zeroStage: true, reason: 'a1_origin_invalid' }
    const intent = JSON.stringify([userText, assistantText, sessionId, args.injectedMemories, args.injectedProfile,
      args.writerContext, dedupeSimilarity, dedupeSummarySimilarity])
    let frozen = frozenExtracts.get(origin)
    if (frozen && frozen.intent !== intent) return { ok: false, status: 'unknown', reason: 'a1_intent_conflict' }
    if (!frozen) {
      frozen = { intent, a1: { protocol: authority.protocol, epoch: authority.epoch, generation: authority.generation },
        names: freezeSnapshot(structuredClone(frameNames())), raw: null, modelStarted: false,
        promptObserved: false, prepareObserved: false,
        requestHash: null, payloadHash: null, submitted: false, pending: null,
        context: { ...args }, terminal: null }
      frozenExtracts.set(origin, frozen)
    }
    const denied = reason => ({ ok: false, status: frozen.submitted ? 'unknown' : 'failed',
      ...(frozen.submitted ? {} : { zeroStage: true }), reason: frozen.submitted ? 'a1_outcome_unknown' : reason })
    if (!authorityBindingMatches(frozen.a1, authority)) return denied('a1_authority_changed')
    if (frozen.pending) return await frozen.pending
    if (frozen.terminal) return frozen.terminal
    const run = async () => {
      if (mode !== 'python' || pythonDown()) return denied('a1_peer_unavailable')
      try {
        if (!frozen.raw) {
          if (frozen.modelStarted) return denied('a1_model_unavailable')
          const prompt = await client.request('extract_prompt', {
            a1: frozen.a1, origin: proof, knownEntities: store?.topEntityNames?.(20) || [], names: frozen.names })
          if (prompt?.type !== 'extract_prompt_result') return denied('a1_prepare_invalid')
          frozen.promptObserved = true
          frozen.modelStarted = true
          let recent = null
          try { recent = store?.recentTurns?.(sessionId, 5) ?? null } catch {}
          const raw = await runRawExtract(subagents, { userText, assistantText, prevVector,
            systemPrompt: prompt.prompt, schema: prompt.schema, parent, recentTurns: recent,
            nowMs: Date.now(), sessionId, writerContext: frozen.context.writerContext })
          if (raw === null) {
            frozen.terminal = denied('a1_model_unavailable')
            return frozen.terminal
          }
          frozen.raw = freezeSnapshot(structuredClone(raw))
        }
        if (!frozen.requestHash) {
          const prepared = await client.request('memory_extract_prepare', {
            a1: frozen.a1, origin: { sourceKind: 'extract', sourceIdentity: proof.sourceIdentity,
              occurredAtMs: proof.occurredAtMs }, structured: frozen.raw, text: userText, names: frozen.names,
            dedupe: { kwThreshold: dedupeSimilarity, summaryThreshold: dedupeSummarySimilarity } })
          if (prepared?.type !== 'memory_extract_prepare_result' || !authorityBindingMatches(prepared.a1, authority)
            || !/^[a-f0-9]{64}$/u.test(prepared.requestHash) || !/^[a-f0-9]{64}$/u.test(prepared.payloadHash)) {
            return denied('a1_prepare_invalid')
          }
          frozen.requestHash = prepared.requestHash
          frozen.payloadHash = prepared.payloadHash
          frozen.prepareObserved = true
        }
        const current = memoryAuthority()
        if (current.status !== 'active' || !authorityBindingMatches(frozen.a1, current)
          || JSON.stringify(current.entries) !== JSON.stringify(MEMORY_EXTRACT_ENTRIES)) return denied('a1_authority_changed')
        frozen.submitted = true
        const result = await client.request('memory_extract_commit', { a1: frozen.a1, requestHash: frozen.requestHash })
        if (result?.type !== 'memory_extract_commit_result' || result.requestHash !== frozen.requestHash
          || !authorityBindingMatches(result.a1, current)) return denied('a1_result_mismatch')
        if (!result.ack) {
          if (result.staleSkipped === true && ['stale_skipped', 'duplicate'].includes(result.status)) {
            return { ...result, status: 'duplicate', accepted: true, staleSkipped: true }
          }
          return denied('a1_result_missing')
        }
        const host = applyExtractAckAtomically(result.ack, { ...frozen.context, associationAudit }, frozen.requestHash,
          { binding: frozen.a1, proof, payloadHash: frozen.payloadHash, authorityOf: inspectMemoryAuthority,
            observed: { prompt: frozen.promptObserved === true, prepare: frozen.prepareObserved === true } })
        return { ...result, ...host, accepted: ['committed', 'duplicate'].includes(host.status),
          ack: host.ack || result.ack }
      } catch {
        return denied('a1_extract_failed')
      }
    }
    frozen.pending = run()
    try { return await frozen.pending } finally { frozen.pending = null }
  }

  /**
   * 轮后反思:Python 路径 extract_prompt → 子代理(引擎提示词+schema)
   * → extract_commit → 壳侧落地;基线路径 M1 冻结链。
   * 返回 ack/commit 结果或 null(本轮不记 —— 反思是增益不是依赖)。
   *
   * v0.14.1 F2+F3:喂给子代理的用户提示词补齐 A 侧 Judge 的两件套 ——
   * 当前时间锚(相对时间换算的唯一依据)与最近 5 轮对话(语境)。
   */
  async function reflect (subagents, { userText, assistantText, prevVector, sessionId = '', injectedMemories = '', injectedProfile = '', latencyMs = null, parent = null, dedupeSimilarity = undefined, dedupeSummarySimilarity = undefined, traceId = '', turnTrace = '', turnTraceCaptured = false, source = 'dsh', layer = '', writerContext = null, associationAudit = null, origin = null }) {
    const authority = memoryAuthority()
    const extractActive = authority.status === 'active'
      && JSON.stringify(authority.entries) === JSON.stringify(MEMORY_EXTRACT_ENTRIES)
    if (memoryFence() && !extractActive) {
      if (origin && frozenExtracts.get(origin)?.submitted) {
        return { ok: false, status: 'unknown', reason: 'a1_outcome_unknown' }
      }
      return entryRejected()
    }
    if (extractActive && !origin) return { ok: false, reason: 'a1_origin_invalid' }
    if (subagents === undefined) return null
    // v0.13.3 宿主契约:subagents.start 需要 parent agent 句柄。
    // 缺席时显式 warn 后跳过 —— 不再让 TypeError 淹没在通用 catch 里。
    if (parent === null || parent === undefined) {
      warn('reflect skipped — 无 parent agent(宿主 subagents.start 契约)')
      return null
    }
    // 最近 5 轮(读不到就当没有 —— 反思不许因为日志表出问题而停)
    let recent = null
    try { recent = store === null ? null : store.recentTurns(sessionId, 5) } catch { recent = null }
    const promptArgs = { recentTurns: recent, nowMs: Date.now(), sessionId, writerContext }
    // 2026-09-26 现场(他:「为什么会出现那么多奇怪的记忆」):**一律拒收**
    // 工程自指内容。产出端(judge 提示词 + post_filter)已经拦了一道,这里是
    // 壳侧最后一道 —— 引擎降级到 JS 基线时,那道门不在,得由这里兜住。
    // 拒收发生在**反思之前**:连模型都不用请,省一次调用。
    if (rejectReason(userText).reject) {
      info('reflect skipped — 本轮不是人话/是工程自指: ' + String(userText).slice(0, 40))
      return null
    }
    if (extractActive) return await reflectActive(subagents, {
      userText, assistantText, prevVector, sessionId, injectedMemories, injectedProfile, latencyMs,
      parent, dedupeSimilarity, dedupeSummarySimilarity, traceId, turnTrace, turnTraceCaptured,
      writerContext, origin
      , associationAudit
    }, authority)
    if (mode === 'python' && !pythonDown()) {
      try {
        // v0.16.0 M2:递一张「图谱里已有的实体名」给提示词 —— 让模型
        // 复用现成名字,而不是每轮自己造近义词(实测「西电」与
        // 「西安电子科技大学」并存就是这么来的)。读不到就是 []。
        let knownEntities = []
        try { knownEntities = store === null ? [] : store.topEntityNames(20) } catch { knownEntities = [] }
        const p = await client.request('extract_prompt', {
          knownEntities,
          names: frameNames()
        }, { timeoutMs: RETRIEVE_TIMEOUT_MS })
        const raw = await runRawExtract(subagents, {
          userText, assistantText, prevVector,
          systemPrompt: p.prompt, schema: p.schema, parent,
          ...promptArgs
        })
        if (raw === null) {
          // v0.13.7 非错误但要可见:子代理没交出结构化输出(未完成/
          // 被判不合法)。留一行 info,别让「本轮没记住」无声无息。
          info('extract: 子代理未交出结构化输出 —— 本轮跳过(对话不受影响)')
          return null
        }
        try {
          const ack = await client.request('extract_commit', {
            userId: MASTER_ID, structured: raw, text: userText, sessionId,
            // v0.16.0 M3:近重复闸的阈值(面板可调,0 = 关闭)
            dedupe: {
              kwThreshold: dedupeSimilarity,
              summaryThreshold: dedupeSummarySimilarity
            }
          })
          if (ack === null || ack === undefined) return { status: 'unknown', reason: 'extract_outcome_unknown' }
          applyExtractAck(ack, { userText, assistantText, injectedMemories, injectedProfile, latencyMs, sessionId, traceId, turnTrace, turnTraceCaptured })
          info('extract ok via python — written=' + (ack.written ? ack.written.length : 0)
            + ' quarantined=' + (ack.quarantined ? ack.quarantined.length : 0)
            + ' learned=' + String(ack.learned) + ' threads=' + String(ack.threadsRegistered))
          return ack
        } catch (err) {
          warn('extract_commit outcome unknown: ' + String(err?.message ?? err))
          return { status: 'unknown', reason: 'extract_outcome_unknown' }
        }
      } catch (err) {
        warn('reflect via python failed — skip this turn: ' + String(err?.message ?? err))
        return null
      }
    }
    if (mode === 'python' && pythonDown()) {
      warn('python engine down — reflect falls back to JS baseline')
    }
    if (mode !== 'baseline' && mode !== 'python') return null
    if (store === null) return null
    let extract
    try {
      extract = await runExtract(subagents, { userText, assistantText, prevVector, parent, ...promptArgs })
    } catch (err) {
      warn('reflect via baseline failed before commit: ' + String(err?.message ?? err))
      return null
    }
    if (extract === null) return null
    try {
      return commitExtract(store, extract, { userText, assistantText, injectedMemories, injectedProfile, latencyMs, sessionId, traceId, turnTrace, turnTraceCaptured, source, layer })
    } catch (err) {
      warn('extract_commit outcome unknown: ' + String(err?.message ?? err))
      return { status: 'unknown', reason: 'extract_outcome_unknown' }
    }
  }

  /**
   * v0.14.5 S9:记忆治理扫描(TTL)。只走 Python —— 基线态没有治理概念
   * (A 的治理也只在真引擎里),返回 null 表示「本轮没扫」。
   */
  async function episodicCleanup (ttlDays = 30, now = null) {
    if (memoryFence()) return entryRejected()
    if (mode !== 'python' || pythonDown()) return null
    try {
      return await client.request('episodic_cleanup', {
        userId: MASTER_ID, ttlDays,
        ...(now === null ? {} : { now: Math.floor(now / 1000) })
      }, { timeoutMs: EXTRACT_TIMEOUT_MS })
    } catch (err) {
      warn('episodic cleanup via python failed: ' + String(err?.message ?? err))
      return null
    }
  }

  /**
   * v0.15.1 G14:整库清空(不可逆)。确认由调用方拿到之后才走到这里 ——
   * 工具侧要 `confirm: true` 参数,面板侧要手打确认短语;这里再往引擎
   * 帧上带一次 confirm,让「没确认就不会删」在两层都成立(引擎帧自己
   * 也拒收没有 confirm 的请求)。
   * 只清情景记忆与画像(A 的 `_clear_all` 语义);图谱/话题/审计/日记留着。
   */
  async function memoryClear () {
    if (memoryFence()) return entryRejected()
    if (mode !== 'python' || pythonDown()) return null
    try {
      // (v0.29.0:A 侧的 include_members「连群友隔离空间一起清」随群聊
      // 退役 —— 单用户形态下它本来就是同一次清理。)
      return await client.request('episodic_clear', {
        userId: MASTER_ID, confirm: true
      }, { timeoutMs: EXTRACT_TIMEOUT_MS })
    } catch (err) {
      warn('memory clear via python failed: ' + String(err?.message ?? err))
      return null
    }
  }

  /**
   * v0.15.1 G15:全部 open 悬置话题(纯读,不落账)。工具与面板问同一件事
   * 就该走同一条路 —— 帧带回引擎的 `now`,到期换算不受两机时钟偏差影响。
   * 帧里的字段是引擎的 snake_case,在这一处转成壳的 camelCase:翻译只做
   * 一遍,上层(工具/端点)就不会各翻各的、各错各的。
   */
  async function threadsList (limit = 20) {
    const r = await frame('threads_list', { userId: MASTER_ID, limit })
    if (r === null) return null
    return {
      now: Number(r.now) || 0,
      items: (r.items || []).map((it) => ({
        threadId: Number(it.thread_id) || 0,
        content: String(it.content || ''),
        followUpAfter: Number(it.follow_up_after) || 0,
        lastMentionedAt: Number(it.last_mentioned_at) || 0,
        createdAt: Number(it.created_at) || 0
      }))
    }
  }

  /**
   * v0.15.1 G15:人工结掉一条悬置话题(A `/threads done <关键词>`)。
   * 返回 { threadId } —— threadId 为 0/null 表示没匹配上(A 同款语义:
   * 没找到就如实说没找到,不新建)。
   */
  async function threadsDone (query) {
    return await frame('threads_done', { userId: MASTER_ID, query: String(query || '') })
  }

  /**
   * v0.15.1 G15:人工登记一条**不带时间**的悬置话题(A `/threads add`)。
   * follow_up_after=0 → 永不主动提,只留记录(A `:2397` 的原话:
   * 「手动添加的不带时间,不会被主动提起」)。
   */
  async function threadsAdd (content, sessionId = '') {
    return await frame('threads_add', {
      userId: MASTER_ID, content: String(content || ''), sessionId
    })
  }

  /**
   * 2026-10-06 D2:悬置话题生命周期(**影子期**:只盖 `cooling_at` / `archived_at`)。
   * 由壳侧的低频节拍驱动(60 秒时基 + 30 分钟桶,见 `lib/index.js` 的 tick);
   * `dryRun` 只算不写(影子比对每天一拍)。引擎不在 ⇒ `null`,这一拍跳过。
   */
  async function threadsLifecycle ({ now = null, dryRun = false } = {}) {
    const r = await frame('threads_lifecycle', now === null ? { dryRun } : { now, dryRun })
    if (r === null) return null
    return {
      cooled: (r.cooled || []).map((x) => Number(x) || 0),
      archived: (r.archived || []).map((x) => Number(x) || 0),
      scanned: Number(r.scanned) || 0,
      now: Number(r.now) || 0,
      dryRun: r.dryRun === true
    }
  }

  /**
   * 2026-10-06 D5:人工"恢复":把一条**冷却中**的话题拉回活跃。
   * 已归档/被取代/已了结的不给恢复(语义终态,理由见 `python/engine/threads.py`)。
   */
  async function threadsRestore (threadId) {
    const r = await frame('threads_restore', { threadId: Number(threadId) || 0 })
    if (r === null) return null
    return { restored: r.restored === true }
  }

  /**
   * P1c:随帧下发的**名字集合**(说话人 / 人名 / 自节点名)。引擎侧消费点
   * (`graph_gate.SPEAKER_NODES`、`person_names`、`l0_tier.OWNER_NODE_NAMES`)
   * 都从帧里取 —— 引擎**不自己读文件**,避免壳与引擎两套路径。
   * 每帧现读数据文件(与"引擎每帧现读 config.json"同一条纪律:面板改了下一帧生效);
   * 读不到(文件缺/坏/空)⇒ 空三份列表 = **没有名字**这个口径,绝不回落代码里的旧表。
   * `ownerNames` 空时由 `loadOwnerNames()` 从 profile.json 派生(拍板:默认空数组 + 派生)。
   */
  function frameNames () {
    try {
      const n = loadNames()
      return { speakers: n.speakers, personNames: n.personNames, ownerNames: loadOwnerNames() }
    } catch {
      return { speakers: [], personNames: [], ownerNames: [] }
    }
  }

  /**
   * 通用帧通道(M3-a 心跳用):python 在且明确没死透才发;模糊失败
   * 返回 null(调用方跳过本轮 —— 心跳下分钟再来,不回落基线:
   * 基线没有这些引擎特性,回落等于假装会说话)。
   */
  async function frame (type, payload = {}, timeoutMs = RETRIEVE_TIMEOUT_MS) {
    if (memoryFence() && ['memory_forget', 'memory_search', 'reflection_prompt', 'reflection_commit'].includes(type)) {
      return entryRejected()
    }
    if (mode !== 'python' || pythonDown()) return null
    try {
      return await client.request(type, { ...payload, names: frameNames(), data: frameData() }, { timeoutMs })
    } catch (err) {
      warn(type + ' via python failed: ' + String(err?.message ?? err))
      return null
    }
  }

  /**
   * 想念补差 + 抗议尖峰(时钟驱动,心跳每分钟调)。
   * v0.14.4 移植缺口 S4:config 终于有人喂了 —— 引擎一直支持覆盖
   * (worker.py:541 → longing.merge_config),此前壳从不传,九项参数
   * 全锁死 DEFAULTS,`care_night_hold` 与 `longing_demo_rate` 实际不可用。
   */
  async function longingTick (config = null) {
    const c = longingFrameConfig(config)
    return await frame('longing_tick', c ? { config: c } : {})
  }

  /** 用户来消息:脉冲削减 + 锚点重置 + 冷启动回填(事件流接线)。
   *  v0.6.0 起帧带回 {pre, post} 双值:pre = 削减前的想念(她等你时
   *  的值,pre-step 注入【想念】行用 —— 先读后削),post = 削减后。 */
  async function longingMessage (userId, text, sessionId = '', config = null) {
    const c = longingFrameConfig(config)
    return await frame('longing_message', c
      ? { userId, text, sessionId, config: c }
      : { userId, text, sessionId })
  }

  /** 关怀已发出:×0.5 缓解(发送成功才调 —— 调用方纪律)。 */
  async function longingCare (userId, config = null) {
    const c = longingFrameConfig(config)
    return await frame('longing_care', c ? { userId, config: c } : { userId })
  }

  /** 主动提醒候选(纯读不落账,发送成功才 threadsMark —— 失败留池)。 */
  async function threadsRemindable () {
    return await frame('threads_remindable', {})
  }

  /** 提醒发送成功落账:提过一次,归零,不再追问。 */
  async function threadsMark (threadId) {
    return await frame('threads_mark', { threadId })
  }

  /**
   * v0.14.1 F4 命令式提醒登记(确定性,不赌 Judge 的心情):
   * items = [{ content, followUpAfter(epoch 秒) | followUpAfterText(原话),
   *            requireTime? }] —— requireTime 为真且时间换算不出来时
   * 引擎侧直接丢弃该条(没有时间的约定归被动提及管)。
   * 时间解析留在引擎(timeutil 单一事实源),壳只交原话。
   */
  async function threadsIngest (userId, text, sessionId, items) {
    return await frame('threads_ingest', { userId, text, sessionId, items })
  }

  /**
   * 议程簿选题(效用 top-1;不落账,发送成功才 agendaMark)。
   * v0.14.4 移植缺口 S5:引擎的效用函数一直在等这两样 —— moody 心境
   * ×1.5 与 persona 兴趣恒 1.0(agenda.py:62-84),worker.py:246-247
   * 也一直在读;此前壳只传 userId,加权实际退化成「只按 weight 与新鲜度」。
   * vector = 当前情绪向量(store.getState().emotionVector);
   * interests = her_interests 拆分后的数组。
   */
  async function agendaPick (userId, { vector = null, interests = null } = {}) {
    const payload = { userId }
    if (vector && typeof vector === 'object') payload.vector = vector
    if (Array.isArray(interests) && interests.length > 0) payload.interests = interests
    return await frame('agenda_pick', payload)
  }

  /** 议程用过降权(48h 冷却;发送成功才调 —— 调用方纪律)。 */
  async function agendaMark (itemId) {
    return await frame('agenda_mark', { itemId })
  }

  /** 用户直教(M3-b):落库为正式记忆 —— explicit/user_explicit,
   *  Judge 信任权重的最高档(谁为这句话负责?用户自己)。 */
  async function memoryAdd (userId, text, { slot = '', layer = 'L2', origin = null } = {}) {
    const requestIntent = JSON.stringify([userId, text, slot, layer])
    let frozen = frozenAdds.get(origin)
    if (frozen && frozen.requestIntent !== requestIntent) return { ok: false, reason: 'a1_intent_conflict' }
    const denied = reason => ({ ok: false, reason: frozen?.uncertain ? 'a1_outcome_unknown' : reason })
    const authority = memoryAuthority()
    if (authority.status === 'blocked') return denied(authority.reason || 'a1_authority_invalid')
    if (authority.status !== 'active') return await frame('memory_add', { userId, text, slot, layer })
    if (userId !== MASTER_ID) return denied('a1_origin_invalid')
    const source = validateMemoryStrengthOrigin(origin, 'teach')
    if (!source || source.occurredAtMs < authority.cutoffAtMs) return denied('a1_origin_invalid')
    const a1 = { protocol: authority.protocol, epoch: authority.epoch, generation: authority.generation }
    const intent = JSON.stringify([userId, text, slot, layer, a1, source])
    if (frozen && frozen.intent !== intent) return { ok: false, reason: 'a1_intent_conflict' }
    if (!frozen) {
      frozen = { intent, requestIntent, body: null, metadata: null, pending: null, uncertain: false }
      frozenAdds.set(origin, frozen)
    }
    if (frozen.pending) return await frozen.pending
    const run = async () => {
      if (mode !== 'python' || pythonDown()) return denied('a1_peer_unavailable')
      if (!frozen.body) {
        try {
          const native = { protocol: 'echo-memory-body/v1', epoch: authority.epoch, ...source }
          const prepared = await client.request('memory_add_prepare', { userId, text, slot, layer, a1, origin: native })
          if (prepared.type !== 'memory_add_prepare_result' || !authorityBindingMatches(prepared.a1, authority)
            || typeof prepared.payloadJson !== 'string' || Buffer.byteLength(prepared.payloadJson) > 65536
            || !Array.isArray(prepared.keywords) || prepared.keywords.some(k => typeof k !== 'string')
            || typeof prepared.I !== 'number' || !Number.isFinite(prepared.I) || prepared.I < 0 || prepared.I > 100
            || !['L0', 'L2'].includes(prepared.layer)) {
            return { ok: false, reason: 'a1_prepare_invalid' }
          }
          const payload = JSON.parse(prepared.payloadJson)
          if (!Array.isArray(payload.items) || payload.items.length !== 1 || payload.items[0].ordinal !== 0) {
            return { ok: false, reason: 'a1_prepare_invalid' }
          }
          frozen.body = Object.freeze({ ...native, payloadJson: prepared.payloadJson })
          frozen.metadata = JSON.stringify([prepared.keywords, prepared.I, prepared.layer])
        } catch (error) {
          return { ok: false, reason: a1ServerReason(error, 'a1_prepare_failed') || 'a1_prepare_failed' }
        }
      }
      if (!validateMemoryStrengthOrigin(origin, 'teach')) return denied('a1_origin_invalid')
      const latestAuthority = memoryAuthority()
      if (latestAuthority.status !== 'active' || !authorityBindingMatches(a1, latestAuthority)) {
        return denied('a1_authority_changed')
      }
      if (mode !== 'python' || pythonDown()) return denied('a1_peer_unavailable')
      const previouslyUncertain = frozen.uncertain
      frozen.uncertain = true
      try {
        const ack = await client.request('memory_add', { userId, a1, body: frozen.body })
        if (ack.type !== 'memory_add_result' || !Number.isSafeInteger(ack.memoryId) || ack.memoryId < 1
          || ack.bodyReceipt?.accepted !== true || !['committed', 'duplicate'].includes(ack.bodyReceipt?.status)
          || JSON.stringify([ack.keywords, ack.I, ack.layer]) !== frozen.metadata) {
          return { ok: false, reason: 'a1_outcome_unknown' }
        }
        frozen.uncertain = false
        return ack
      } catch (error) {
        const reason = a1ServerReason(error, 'a1_outcome_unknown') || 'a1_outcome_unknown'
        frozen.uncertain = previouslyUncertain || reason === 'a1_outcome_unknown'
        return denied(reason)
      }
    }
    frozen.pending = run()
    try { return await frozen.pending } finally { frozen.pending = null }
  }

  /** 遗忘(M3-b):按主题抹记忆 —— 只读匹配绝不强化目标,命中
   *  is_active=0;匹配 >10 拒绝(防「忘掉一切」式误伤)。 */
  async function memoryForget (userId, query) {
    return await frame('memory_forget', { userId, query })
  }

  /** 主动翻记忆(M3-b):与 pre-step 注入同一套检索,含强化 ——
   *  「翻记忆」就是「想起」,间隔效应照常适用。 */
  async function memorySearch (userId, query, topK = 6, { origin = null } = {}) {
    if (memoryFence()) return await retrievalTransaction('search', userId, query, topK, null, origin)
    return await frame('memory_search', { userId, query, topK })
  }

  /**
   * v0.14.4 移植缺口 S1:反思整固(信念层)两帧。
   *
   * 引擎侧整层早已就绪(reflection.py 提示词逐字、阈值 30/窗口 50/
   * 夜窗 23-8 且 >12h;worker.py:402/429 两个帧;连 reflection_state
   * 表都建好了),但壳侧此前零引用 —— 信念层从未产出过一条。
   *
   * reflectionPrompt:判触发 + 组提示词。候选窗口留在 worker 内存
   * (state['reflection_rounds']),commit 帧据此校验 evidence_ids ——
   * 两帧之间窗口不漂移,所以必须成对调用。
   * 返回 { triggered, reason?…, systemPrompt?, userPrompt? } 或 null。
   */
  async function reflectionPrompt (now = null, config = null) {
    const payload = { userId: MASTER_ID }
    if (now !== null && now !== undefined) payload.now = Math.floor(Number(now) / 1000)
    // v0.22.0:整固的两个旋钮(A `main.py:1926-1927`:阈值 / 窗口上限)。
    // 引擎侧默认就是 30/50,只有面板改过才带 —— 不带时行为与以前完全一致。
    if (config !== null && typeof config === 'object') {
      const c = {}
      if (Number.isFinite(Number(config.importance_threshold))) {
        c.importanceThreshold = Number(config.importance_threshold)
      }
      if (Number.isFinite(Number(config.max_inputs))) {
        c.maxInputs = Number(config.max_inputs)
      }
      if (Object.keys(c).length > 0) payload.config = c
    }
    return await frame('reflection_prompt', payload, REFLECT_TIMEOUT_MS)
  }

  /** 整固落库 + 推游标。items 为空/坏 → 游标不动(下轮重试)。 */
  async function reflectionCommit (items, now = null) {
    const payload = { userId: MASTER_ID, items: Array.isArray(items) ? items : [] }
    if (now !== null && now !== undefined) payload.now = Math.floor(Number(now) / 1000)
    return await frame('reflection_commit', payload, REFLECT_TIMEOUT_MS)
  }

  /**
   * 想念真值(M2-f):longing_check 帧,读即刷新(引擎补差并落库)。
   * 返回帧原样(snake_case:value/exists/threshold/sinceMessage/…/
   * shouldCare/sessionId)或 null(引擎不在/模糊失败 —— 调用方回落
   * JS 复刻)。面板与 M3 心跳共用这一个入口。
   */
  async function longing (userId, config = null) {
    if (mode !== 'python' || pythonDown()) return null
    try {
      // v0.14.4 S4:读也要带同一份 config —— 引擎补差用 cfg 的半衰期算,
      // 判定/展示若吃默认值,就会与 tick 落库的值各算一套数学。
      const c = longingFrameConfig(config)
      return await client.request('longing_check',
        c ? { userId, config: c } : { userId },
        { timeoutMs: RETRIEVE_TIMEOUT_MS })
    } catch (err) {
      warn('longing via python failed: ' + String(err?.message ?? err))
      return null
    }
  }
  async function longingOutcome (userId, config = null) {
    if (mode !== 'python' || pythonDown()) return { status: 'no_op', reason: 'pre_frame_no_op' }
    try {
      const c = longingFrameConfig(config)
      const result = await client.request('longing_check',
        c ? { userId, config: c } : { userId }, { timeoutMs: RETRIEVE_TIMEOUT_MS })
      return { status: 'committed', result }
    } catch (err) {
      warn('longing outcome unknown: ' + String(err?.message ?? err))
      return { status: 'unknown', reason: 'longing_outcome_unknown' }
    }
  }
  async function threadsLifecycleOutcome ({ now = null, dryRun = false } = {}) {
    if (mode !== 'python' || pythonDown()) return { status: 'no_op', reason: 'pre_frame_no_op' }
    try {
      const result = await threadsLifecycle({ now, dryRun })
      return result === null
        ? { status: 'unknown', reason: 'thread_lifecycle_outcome_unknown' }
        : { status: 'committed', result }
    } catch {
      return { status: 'unknown', reason: 'thread_lifecycle_outcome_unknown' }
    }
  }

  /**
   * v0.14.0 F1 轮末图谱回传(graph_reinforce):把本轮检索想起的边
   * (hit)与路径边(ltp)原样交回引擎 —— apply_ltp 权重增强 +
   * recall_updates(H 增益/R 归 1/次数+1/时钟前移)+ 物化/剪枝节流桶。
   * 这是「用进长时增强」真正落地的地方:在此之前库里的 activation
   * 恒为 0,图谱面板显示的活跃度是壳侧现算的。
   *
   * 入参 = retrieve 返回的 graphHits。
   * v0.14.4 移植缺口 S3:这里原本「hit 与 ltp 皆空即 return null」,
   * 于是没有命中边的轮次(闲聊、纯情绪轮)根本不发帧 —— 而引擎的
   * 物化(10 分钟桶把 R 写进 activation)与剪枝(1 小时桶清从未想起
   * 的噪声)就挂在这个帧里(graph.py:update_and_persist 接受空
   * user_hit_ids、照常按桶推进;A 侧 brain_pipeline.py:1424 也是每轮
   * 无条件调用)。空集也发,换来面板活跃度与桶准点。
   * 返回帧回执 { ltp, reinforced, materialized, pruned, edges } 或 null。
   * 基线态没有图(JS store 只有展示用的 graphData)—— 明确跳过。
   */
  async function reinforceGraph (graphHits) {
    if (memoryFence()) return entryRejected()
    if (mode !== 'python' || pythonDown()) return null
    const hit = Array.isArray(graphHits?.hitEdgeIds) ? graphHits.hitEdgeIds : []
    const ltp = Array.isArray(graphHits?.ltpEdgeIds) ? graphHits.ltpEdgeIds : []
    try {
      const r = await client.request('graph_reinforce', {
        userId: MASTER_ID, hitEdgeIds: hit, ltpEdgeIds: ltp, isMaster: true
      }, { timeoutMs: RETRIEVE_TIMEOUT_MS })
      return r
    } catch (err) {
      warn('graph_reinforce failed — 本轮命中边不回传: ' + String(err?.message ?? err))
      return null
    }
  }

  /** 诊断快照:echo_status 与面板引擎状态行(M2-i)的数据源。 */
  function state () {
    const s = client !== null ? client.state() : null
    return {
      mode,
      python: pythonInfo !== null
        ? { path: pythonInfo.path, major: pythonInfo.major, minor: pythonInfo.minor }
        : null,
      sidecar: s === null ? null : {
        running: s.running, breakerOpen: s.breakerOpen,
        failures: s.failures, restarts: s.restarts,
        version: s.version, pid: s.pid, lastError: s.lastError,
        protocol: s.protocol ?? 'unverified',
        profileEntries: s.profileEntries ?? 'unverified',
        authority: s.authority ?? 'unverified'
      }
    }
  }

  return {
    graphPaths,
    associationForCare,
    init, stop, retrieve, reflect, longing, longingOutcome, state,
    reinforceGraph,
    longingTick, longingMessage, longingCare,
    threadsRemindable, threadsMark, threadsIngest, agendaPick, agendaMark,
    threadsDone, threadsAdd, threadsList, threadsLifecycle, threadsLifecycleOutcome, threadsRestore,
    memoryAdd, memoryForget, memorySearch, memoryClear,
    reflectionPrompt, reflectionCommit,
    episodicCleanup
  }
}
