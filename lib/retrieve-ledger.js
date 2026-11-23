/**
 * RT9 检索账本 —— **先做仪器,再谈三臂**。
 *
 * 为什么需要它(计划原文 §3.2):现在 48 条金标**全是我手造的题**,缺少真机上的
 * 「她明明记得、却没说出来」的样本。要把那种现场变成第 49、50 条金标,先得有一条账:
 * **这一问召回了谁、各臂各给了多少分、谁靠分数进榜、谁是 L0 强制占位**。
 *
 * 记什么(引擎侧已经算好、只是没人记):
 *   · 每条候选:`cov`(词法臂覆盖率 = 现在的 `hits`)、`r_now`(时间/可回忆性臂)、
 *     `emotion_score`(情绪臂)、`total`(现状合成分)、`layer`、`forced`(L0 强制占位);
 *   · 这一问的元信息:查询原文、走了哪条引擎(python/baseline)、topK、降级标注。
 *
 * ⚠️ 三条纪律:
 *   ① **只记不判** —— RT9 不改任何排序、不改任何阈值。账本不是闸门。
 *   ② **不落库** —— 进程内的环形缓冲(默认留最近 50 问)。理由:真机的"漏召回"取证
 *      要的是**最近发生过什么**;长期留档该进金标(draft 经他过目才算),不留私聊原文进新表。
 *   ③ **不许把"记不下来"变成"这一轮出错"** —— 任何一层炸了都只丢掉这一条账。
 *
 * 各臂分数记的是**引擎实况**(python 侧的连续覆盖率与 DMAE 可回忆性),不是我们重算的 ——
 * 重算就是第二个真相源。
 */
import { createHash } from 'node:crypto'
import {
  sourceVersionOf, validateUnifiedShadowPaths, UNIFIED_SHADOW_BOUNDS
} from './memory-consolidation-retrieval.js'

/** 环形缓冲留多少问。 */
export const LEDGER_MAX = 50

/** 真机漏召回样本的档位名(**新档**,与 v2 的 N1–N6 并列;进金标前要他过目)。 */
export const GOLD_TIER_LIVE = 'N7 现场漏召回'

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const round4 = (v) => (v === null ? null : Math.round(v * 10000) / 10000)
const digest = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
const itemId = item => {
  const value = item?.memory_id ?? item?.memoryId ?? item?.id
  return value === null || value === undefined || value === '' ? null : String(value)
}

function pathShapeDigest (shadow) {
  const paths = []
  for (const memory of Array.isArray(shadow?.memories) ? shadow.memories : []) {
    const candidates = Array.isArray(memory.paths) && memory.paths.length
      ? memory.paths : memory.bestPath ? [memory.bestPath] : []
    for (const path of candidates) paths.push({
      nodes: Array.isArray(path.nodes) ? path.nodes : [],
      linkIds: Array.isArray(path.linkIds) ? path.linkIds : [],
      relations: Array.isArray(path.relations) ? path.relations : [],
      trafficHops: Number.isSafeInteger(path.trafficHops) ? path.trafficHops : null
    })
  }
  return { count: paths.length, digest: paths.length ? digest(paths) : null }
}

function outputDigest (items) {
  const ids = Array.isArray(items) ? items.map(itemId) : []
  return { count: ids.length, digest: ids.every(Boolean) ? digest(ids) : null }
}

const observerCandidateMeta = value => {
  if (value === null || typeof value !== 'object'
    || value.status !== 'observed' || value.candidateDigestStatus !== 'observed'
    || !Number.isSafeInteger(value.candidateCount) || value.candidateCount < 0
    || value.candidateCount > 500
    || !observerNullableDigest(value.candidateDigest)) return null
  return { candidateCount: value.candidateCount, candidateDigest: value.candidateDigest }
}
const observerShadowCandidateMeta = shadow => {
  const metrics = shadow?.metrics
  if (metrics === null || typeof metrics !== 'object'
    || metrics.candidateDigestStatus !== 'ready'
    || !Number.isSafeInteger(metrics.candidateCount)
    || metrics.candidateCount < 0
    || metrics.candidateCount > UNIFIED_SHADOW_BOUNDS.candidates
    || !observerNullableDigest(metrics.candidateDigest)) return null
  return { candidateCount: metrics.candidateCount, candidateDigest: metrics.candidateDigest }
}

const OWNER_STATUSES = new Set(['verified', 'unverified'])
const OWNER_BINDINGS = new Set(['captured', 'unavailable'])
const OWNER_REASONS = new Set([
  'no_verified_owner_binding', 'challenge_mismatch', 'scope_invalid', 'scope_drift'
])
const ownerDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : null
const defaultOwner = Object.freeze({
  status: 'unverified', ownerHash: null, sessionHash: null,
  binding: 'unavailable', reason: 'no_verified_owner_binding'
})
const observerOwner = value => {
  if (value === null || typeof value !== 'object' || !OWNER_STATUSES.has(value.status)
    || !OWNER_BINDINGS.has(value.binding)
    || (value.reason !== null && !OWNER_REASONS.has(value.reason))) return defaultOwner
  if (value.status === 'verified'
    && ownerDigest(value.ownerHash) !== null && ownerDigest(value.sessionHash) !== null
    && value.binding === 'captured' && value.reason === null) {
    return {
      status: 'verified',
      ownerHash: value.ownerHash,
      sessionHash: value.sessionHash,
      binding: 'captured',
      reason: null
    }
  }
  if (value.status === 'unverified') {
    return {
      status: 'unverified',
      ownerHash: null,
      sessionHash: null,
      binding: value.binding,
      reason: OWNER_REASONS.has(value.reason) ? value.reason : 'scope_invalid'
    }
  }
  return defaultOwner
}

/** Build bounded, opaque same-round formal/shadow observation data. */
export function buildRetrievalObserver ({
  formalItems = null, formalEngine = 'unknown', association = null, formalSourceResult = null,
  formalCandidateMeta = null, ownerSummary = null,
  sessionId = '',
  turnTrace = '', attemptId = '', rankAtMs = null, bounds = {}, now = Date.now,
  failureReason = null
} = {}) {
  try {
    const formal = outputDigest(formalItems)
    const formalCandidate = observerCandidateMeta(formalCandidateMeta)
    const owner = observerOwner(ownerSummary)
    const shadow = association?.unifiedShadow ?? null
    const shadowCandidate = observerShadowCandidateMeta(shadow)
    const formalSourceVersion = sourceVersionOf(formalSourceResult)
    const shadowSourceVersion = sourceVersionOf(association)
    const sourceVersion = formalSourceVersion && shadowSourceVersion
      && JSON.stringify(formalSourceVersion) === JSON.stringify(shadowSourceVersion)
      ? formalSourceVersion
      : {
          kind: 'unavailable', tokenHash: null, atomic: false,
          status: formalSourceVersion || shadowSourceVersion ? 'mismatch' : 'unavailable',
          reason: formalSourceVersion || shadowSourceVersion
            ? 'source_version_mismatch' : 'source_version_provider_unavailable'
        }
    const shadowOutput = outputDigest(shadow?.memories)
    const binding = sessionId !== '' && turnTrace !== '' ? 'captured' : 'unavailable'
    const blockers = []
    if (binding !== 'captured') blockers.push('turn_binding_unavailable')
    blockers.push('no_atomic_snapshot', 'owner_unverified')
    if (owner.status === 'verified') blockers.splice(blockers.indexOf('owner_unverified'), 1)
    if (sourceVersion.status !== 'ready') blockers.push(sourceVersion.reason)
    const status = 'no-go'
    const reason = failureReason || (binding !== 'captured'
      ? 'turn_binding_unavailable'
      : sourceVersion.status !== 'ready'
        ? sourceVersion.reason
        : owner.status !== 'verified'
          ? owner.reason : 'no_atomic_snapshot')
    const formalIds = Array.isArray(formalItems) ? formalItems.map(itemId).filter(Boolean) : []
    const shadowIds = Array.isArray(shadow?.memories) ? shadow.memories.map(itemId).filter(Boolean) : []
    const symmetric = new Set([...formalIds, ...shadowIds]).size
      - new Set(formalIds.filter(id => shadowIds.includes(id))).size
    const path = pathShapeDigest(shadow)
    const pathValidation = validateUnifiedShadowPaths(shadow, { maxHops: bounds.maxHops ?? 3 })
    return {
      schema: 'echo.association.runtime-observer.v1',
      status, reason, blockers,
      round: {
        sessionHash: sessionId ? digest(sessionId) : null,
        turnHash: turnTrace ? digest(turnTrace) : null,
        attemptHash: attemptId ? digest(attemptId) : null,
        binding
      },
      formal: {
        status: Array.isArray(formalItems) ? 'observed' : 'unavailable',
        engine: String(formalEngine || 'unknown'),
        candidateCount: formalCandidate?.candidateCount ?? null,
        candidateDigest: formalCandidate?.candidateDigest ?? null,
        candidateDigestStatus: formalCandidate ? 'observed' : 'not_exposed',
        outputCount: formal.count, outputDigest: formal.digest, truncated: []
      },
      shadow: {
        status: shadow?.status || 'unavailable',
        candidateCount: shadowCandidate?.candidateCount ?? null,
        candidateDigest: shadowCandidate?.candidateDigest ?? null,
        candidateDigestStatus: shadowCandidate ? 'observed' : 'not_exposed',
        outputCount: shadowOutput.count, outputDigest: shadowOutput.digest,
        pathCount: path.count, pathDigest: path.digest, pathValidation,
        truncated: [...new Set(shadow?.metrics?.truncated || [])],
        budget: observerBudget(bounds)
      },
      diff: {
        candidateSetDelta: null, outputSetDelta: formal.digest && shadowOutput.digest ? symmetric : null,
        orderChanged: formal.digest && shadowOutput.digest ? JSON.stringify(formalIds) !== JSON.stringify(shadowIds) : null,
        pathChanged: null
      },
      sourceVersion,
      snapshot: { status: 'no-go', reason: 'no_atomic_snapshot', tokenHash: null },
      owner,
      at: Number(now()) || 0, rankAtMs: Number.isFinite(rankAtMs) ? rankAtMs : null,
      pathValidation,
      observerOnly: true
    }
  } catch {
    return {
      schema: 'echo.association.runtime-observer.v1', status: 'no-go',
      reason: 'observer_failed', blockers: ['observer_failed'], observerOnly: true
    }
  }
}

/**
 * 把引擎给的候选拆成"臂分解"。容忍缺字段:JS 基线那条路的行没有 `total`/`r_now`,
 * 那就如实记 null —— **不编一个数出来**(编了以后就没法拿它去比"哪一档在退步")。
 */
export function armBreakdown (items, { topK = 6 } = {}) {
  const list = Array.isArray(items) ? items : []
  const rows = []
  for (const it of list) {
    if (it === null || typeof it !== 'object') continue
    const cov = num(it.hits)
    const rNow = num(it.r_now)
    const emo = num(it.emotion_score) ?? num(it.emotionScore)
    rows.push({
      id: num(it.memory_id) ?? num(it.memoryId),
      layer: String(it.layer ?? ''),
      cov: round4(cov),
      rNow: round4(rNow),
      emo: round4(emo),
      total: round4(num(it.total)),
      forced: it.forced === true,
      matched: it.matched !== false
    })
    if (rows.length >= Math.max(1, Number(topK) || 6) * 4) break
  }
  const has = (k) => rows.some((r) => r[k] !== null)
  return {
    rows,
    top: rows.slice(0, Math.max(1, Number(topK) || 6)),
    // 哪几臂真的有读数(向量臂今天恒 false —— RT12 已量过:本机没有模型)
    arms: { lexical: has('cov'), recall: has('rNow'), emotion: has('emo'), vector: false },
    counts: {
      candidates: rows.length,
      forced: rows.filter((r) => r.forced).length,
      layers: rows.reduce((acc, r) => { if (r.layer !== '') acc[r.layer] = (acc[r.layer] || 0) + 1; return acc }, {})
    }
  }
}

/** 一问的账(纯函数,离线可测)。 */
export function ledgerEntry ({ query = '', engine = '', topK = 6, items = null, degrade = '', now = 0, observer = null } = {}) {
  const b = armBreakdown(items, { topK })
  return {
    at: Number(now) || 0,
    query: String(query ?? '').slice(0, 200),
    engine: String(engine ?? ''),
    topK: Math.max(1, Number(topK) || 6),
    degrade: String(degrade ?? ''),
    arms: b.arms,
    counts: b.counts,
    rows: b.rows,
    top: b.top.map((r) => r.id),
    ...(observer ? { observer } : {})
  }
}

/**
 * 把一条账(通常来自真机漏召回现场)做成**金标草稿**。
 * 形状对齐 `scripts/retrieval-bench.py` 的 `(档位, query, {ids}, 依据)`,
 * 外加 `source:'live'` 标明"这条是从真机捡的,不是造的"。
 *
 * **草稿不许自动进金标** —— 它得他过目(可能是我认错了答案)。
 */
export function goldDraft ({ query = '', ids = [], why = '', replyText = '', at = 0 } = {}) {
  const set = [...new Set((Array.isArray(ids) ? ids : []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))]
  if (String(query).trim() === '' || set.length === 0) return null
  return {
    tier: GOLD_TIER_LIVE,
    query: String(query),
    ids: set,
    why: String(why || '真机现场:这一问没把该想起来的调出来').slice(0, 200),
    source: 'live',
    at: Number(at) || 0,
    replySeen: String(replyText ?? '').slice(0, 160)
  }
}

/** 环形缓冲门面(壳持有;`stats()` 上面板)。 */
export function createRetrieveLedger ({ max = LEDGER_MAX, now = () => Date.now() } = {}) {
  const cap = Math.max(1, Number(max) || LEDGER_MAX)
  const buf = []
  const stats = { pushed: 0, zeroHit: 0, dropped: 0, byEngine: {}, lastAt: 0, lastQuery: '', lastRows: 0, avgRows: 0,
    observer: { pushed: 0, noGo: 0, partial: 0, ready: 0, dropped: 0, lastAt: 0,
      lastStatus: 'unavailable', lastReason: 'not_observed', last: null } }

  function push (entry) {
    try {
      const e = entry !== null && typeof entry === 'object' ? entry : null
      if (e === null) return null
      buf.push(e)
      while (buf.length > cap) {
        const removed = buf.shift()
        stats.dropped += 1
        if (removed?.observer) stats.observer.dropped += 1
      }
      stats.pushed += 1
      const n = Array.isArray(e.rows) ? e.rows.length : 0
      if (n === 0) stats.zeroHit += 1
      const eng = String(e.engine ?? '') || 'unknown'
      stats.byEngine[eng] = (Number(stats.byEngine[eng]) || 0) + 1
      stats.lastAt = Number(e.at) || now()
      stats.lastQuery = String(e.query ?? '')
      stats.lastRows = n
      const sum = buf.reduce((s, x) => s + (Array.isArray(x.rows) ? x.rows.length : 0), 0)
      stats.avgRows = buf.length === 0 ? 0 : Math.round((sum / buf.length) * 100) / 100
      if (e.observer && typeof e.observer === 'object') {
        const o = e.observer
        const status = ['no-go', 'partial', 'ready'].includes(o.status) ? o.status : 'no-go'
        stats.observer.pushed += 1
        stats.observer[status === 'no-go' ? 'noGo' : status] += 1
        stats.observer.lastAt = Number(e.at) || now()
        stats.observer.lastStatus = status
        stats.observer.lastReason = typeof o.reason === 'string' ? o.reason : 'observer_failed'
        stats.observer.last = boundedObserver(o)
      }
      return e
    } catch { return null } // 记不下来只丢这一条账,不许影响这一轮
  }

  return {
    push,
    list: () => buf.slice(-cap),
    last: () => (buf.length === 0 ? null : buf[buf.length - 1]),
    clear: () => { buf.length = 0 },
    stats: () => ({ ...stats, byEngine: { ...stats.byEngine },
        observer: { ...stats.observer, last: stats.observer.last ? boundedObserver(stats.observer.last) : null },
      kept: buf.length, cap, at: now() })
  }
}

const observerText = (value, max = 128, fallback = null) => {
  if (typeof value !== 'string') return fallback
  return value.slice(0, max)
}
const observerInt = (value, max = 1000000) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null
const observerBool = value => typeof value === 'boolean' ? value : null
const observerTextList = (value, maxItems = 8, maxText = 64) => Array.isArray(value)
  ? value.slice(0, maxItems).map(item => observerText(item, maxText, '')).filter(Boolean) : []
const observerBudget = value => {
  const source = value && typeof value === 'object' ? value : {}
  const out = {}
  for (const key of ['candidates', 'outputs', 'seeds', 'maxHops', 'trafficEdges', 'trafficNodes']) {
    const bounded = observerInt(source[key], 100000)
    if (bounded !== null) out[key] = bounded
  }
  return out
}
const observerNullableDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : null
const observerSourceVersion = value => {
  const source = value && typeof value === 'object' ? value : {}
  return {
    kind: observerText(source.kind, 32, 'unavailable'),
    tokenHash: observerNullableDigest(source.tokenHash),
    atomic: source.atomic === true,
    status: observerText(source.status, 24, 'unavailable'),
    reason: observerText(source.reason, 64, 'source_version_provider_unavailable')
  }
}
const observerPathValidation = value => {
  const source = value && typeof value === 'object' ? value : {}
  return {
    status: observerText(source.status, 24, 'unknown'),
    reason: observerText(source.reason, 64),
    pathCount: observerInt(source.pathCount, 100000),
    validCount: observerInt(source.validCount, 100000),
    invalidCount: observerInt(source.invalidCount, 100000),
    unknownCount: observerInt(source.unknownCount, 100000)
  }
}

function boundedObserver (observer) {
  try {
    const source = observer && typeof observer === 'object' ? observer : {}
    const formal = source.formal && typeof source.formal === 'object' ? source.formal : {}
    const shadow = source.shadow && typeof source.shadow === 'object' ? source.shadow : {}
    const diff = source.diff && typeof source.diff === 'object' ? source.diff : {}
    const snapshot = source.snapshot && typeof source.snapshot === 'object' ? source.snapshot : {}
    const owner = source.owner && typeof source.owner === 'object' ? source.owner : {}
    const round = source.round && typeof source.round === 'object' ? source.round : {}
    const shadowPathValidation = observerPathValidation(shadow.pathValidation)
    return {
      schema: 'echo.association.runtime-observer.v1',
      status: observerText(source.status, 24, 'no-go'),
      reason: observerText(source.reason, 64, 'observer_failed'),
      blockers: observerTextList(source.blockers),
      round: {
        sessionHash: observerNullableDigest(round.sessionHash),
        turnHash: observerNullableDigest(round.turnHash),
        attemptHash: observerNullableDigest(round.attemptHash),
        binding: observerText(round.binding, 24, 'unavailable')
      },
      formal: {
        status: observerText(formal.status, 24, 'unavailable'),
        engine: observerText(formal.engine, 24, 'unknown'),
        candidateCount: observerInt(formal.candidateCount, 100000),
        candidateDigest: observerNullableDigest(formal.candidateDigest),
        candidateDigestStatus: observerText(formal.candidateDigestStatus, 32, 'not_exposed'),
        outputCount: observerInt(formal.outputCount, 100000),
        outputDigest: observerNullableDigest(formal.outputDigest),
        truncated: observerTextList(formal.truncated)
      },
      shadow: {
        status: observerText(shadow.status, 24, 'unavailable'),
        candidateCount: observerInt(shadow.candidateCount, 100000),
        candidateDigest: observerNullableDigest(shadow.candidateDigest),
        candidateDigestStatus: observerText(shadow.candidateDigestStatus, 32, 'not_exposed'),
        outputCount: observerInt(shadow.outputCount, 100000),
        outputDigest: observerNullableDigest(shadow.outputDigest),
        pathCount: observerInt(shadow.pathCount, 100000),
        pathDigest: observerNullableDigest(shadow.pathDigest),
        pathValidation: shadowPathValidation,
        truncated: observerTextList(shadow.truncated),
        budget: observerBudget(shadow.budget)
      },
      diff: {
        candidateSetDelta: observerInt(diff.candidateSetDelta, 100000),
        outputSetDelta: observerInt(diff.outputSetDelta, 100000),
        orderChanged: observerBool(diff.orderChanged),
        pathChanged: observerBool(diff.pathChanged)
      },
      snapshot: {
        status: observerText(snapshot.status, 24, 'no-go'),
        reason: observerText(snapshot.reason, 64, 'no_atomic_snapshot'),
        tokenHash: observerNullableDigest(snapshot.tokenHash)
      },
      owner: {
        status: observerText(owner.status, 24, 'unverified'),
        ownerHash: observerNullableDigest(owner.ownerHash),
        sessionHash: observerNullableDigest(owner.sessionHash),
        binding: observerText(owner.binding, 24, 'unavailable'),
        reason: owner.reason === null ? null : observerText(owner.reason, 64, 'no_verified_owner_binding'),
      },
      sourceVersion: observerSourceVersion(source.sourceVersion),
      pathValidation: shadowPathValidation,
      observerOnly: true
    }
  } catch {
    return { schema: 'echo.association.runtime-observer.v1', status: 'no-go',
      reason: 'observer_failed', blockers: ['observer_failed'], observerOnly: true }
  }
}
