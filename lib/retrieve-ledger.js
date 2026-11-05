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

/** 环形缓冲留多少问。 */
export const LEDGER_MAX = 50

/** 真机漏召回样本的档位名(**新档**,与 v2 的 N1–N6 并列;进金标前要他过目)。 */
export const GOLD_TIER_LIVE = 'N7 现场漏召回'

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const round4 = (v) => (v === null ? null : Math.round(v * 10000) / 10000)

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
export function ledgerEntry ({ query = '', engine = '', topK = 6, items = null, degrade = '', now = 0 } = {}) {
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
    top: b.top.map((r) => r.id)
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
  const stats = { pushed: 0, zeroHit: 0, dropped: 0, byEngine: {}, lastAt: 0, lastQuery: '', lastRows: 0, avgRows: 0 }

  function push (entry) {
    try {
      const e = entry !== null && typeof entry === 'object' ? entry : null
      if (e === null) return null
      buf.push(e)
      while (buf.length > cap) { buf.shift(); stats.dropped += 1 }
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
      return e
    } catch { return null } // 记不下来只丢这一条账,不许影响这一轮
  }

  return {
    push,
    list: () => buf.slice(-cap),
    last: () => (buf.length === 0 ? null : buf[buf.length - 1]),
    clear: () => { buf.length = 0 },
    stats: () => ({ ...stats, byEngine: { ...stats.byEngine }, kept: buf.length, cap, at: now() })
  }
}
