import { captureAuditInput, makeAuditIO } from './audit-io.js'
/**
 * RT11b 查询扩展臂 —— **让大模型解语义,而不是手写小词表**。
 *
 * 起因(2026-09-28 夜,他一句话把路扳正):「我不建议用任何一个单独给出的东西来处理,
 * 这些全都是局限性的。你不是有大模型吗?就不能调用大模型来解决这个问题吗?」
 *
 * 他说得对。前面两版都是残废工具:
 *   · `graph_aliases` 静态表 19 个词元 —— 与全量跑 838 条问法**零交集**(实测),
 *     因为别名表记的是"图谱实体归一",不是"人怎么问";
 *   · 记忆 keywords 共现 —— 197 条的小库上抽出来的对子必然过拟合单条记忆。
 * 两者的共同病根:**它们都想用"库里已有的东西"去猜"他还没说出口的说法"**。
 * 那件事只有模型做得了 —— 而且模型**本来就在这条链上**(每轮都在读她/他的对话),
 * 所以不引入新的模型服务依赖；内容仍会交给宿主所选 provider，
 * 若该 provider 在远端，查询文本也会离开本机，边界见 PRIVACY.md。
 *
 * 形状照抄 C1 那条已经跑通的:**他开口那一刻并起一次小调用,与组装赛跑**
 * (`Promise.race` + 超时降级)。三条纪律:① 默认关;② 记不下来/超时 ⇒ **这一轮照常过**,
 * 但**必须记账**(超时率是这条通道的体检项);③ **产物要进主打分,不能只走"捞人"通道**。
 *
 * ⚠️ 2026-09-30 纠错(原来这里写的是"只喂捞人通道、不改已进榜顺序",**那是错的**):
 * 老用法把扩展词元交给"同义词救援"那条路,而救援按 `RESCUE_DISCOUNT(0.30)` 折扣进场,
 * **永远排不过词面命中** ⇒ top5 一条都进不来(实测 28 条金标 0 条改变)。
 * 改成**并进主打分**(问法词元 ∪ 扩展词元 = 覆盖率口径)后:18/21 → **20/21**,
 * 负控误取 6/7 → 3/7。现场与读数见 `docs/RETRIEVAL_OPT_2026-09-30.md` §7。
 * 另一个坑:扩展词必须**按查询同一套词元规则切**(`lexical.uniq_terms`)再递进引擎 ——
 * 直接把「深夜」当整词递进去,只有分词器恰好也产这个 token 才撞得上(实测漏过 gi13)。
 */

/** 默认超时(与 C1 同款思路:宁可这轮没有扩展,也不能让她的回复变慢)。 */
export const EXPAND_DEFAULT_TIMEOUT_MS = 1200
const EXPAND_MIN_MS = 200
const EXPAND_MAX_MS = 8000
/** 一条问句最多收几个扩展词元(多了等于把查询变成噪声)。 */
export const EXPAND_DEFAULT_MAX_TERMS = 8
/** 缓存多少条问句的扩展(LRU;同句话重复问不重复调模型)。 */
const EXPAND_CACHE_MAX = 200

export const EXPAND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    terms: {
      type: 'array',
      items: { type: 'string' },
      description: '能帮助词法检索召回的同义/别名/相关说法(短词元,不要整句)'
    }
  },
  required: ['terms']
}

export function clampExpandTimeoutMs (v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return EXPAND_DEFAULT_TIMEOUT_MS
  return Math.max(EXPAND_MIN_MS, Math.min(EXPAND_MAX_MS, Math.round(n)))
}

/** 同句话的缓存键(空白折叠 + 截断;不问语义,只问"是不是同一句")。 */
export function normalizeQueryKey (text) {
  return String(text ?? '').split(/\s+/).filter((x) => x !== '').join(' ').slice(0, 200)
}

export function expandPrompt ({ userText = '', maxTerms = EXPAND_DEFAULT_MAX_TERMS } = {}) {
  return [
    '你在给"记忆检索"做查询扩展。他刚说了一句话,系统要用它去他过去的记忆里找相关的那些条。',
    '',
    '他说的:' + String(userText ?? '').slice(0, 300),
    '',
    '请给出最多 ' + Math.max(1, Number(maxTerms) || EXPAND_DEFAULT_MAX_TERMS) + ' 个**短词元**,',
    '用来在检索时**换一种说法**也能命中同一件事:同义词、别名、口语/书面语对应说法、相关实体名、上位词。',
    '要求:只要词元(2~8 个字),不要整句;不要抄回他原话;不要编造具体事实(金额/日期/分数一律不要);',
    '想不出就少给几个(甚至空数组),**宁可少给,不许凑数** —— 凑出来的词会把不相干的记忆也捞进来。',
    '',
    '只输出 JSON:{"terms": ["…", "…"]}'
  ].join('\n')
}

/**
 * 清洗模型的产出:去空/去重/去原话/限长限数。
 * ⚠️ 这里是**唯一的**入口清洗点 —— 模型给什么都得先过这里才准进检索。
 */
export function parseExpansion (raw, { userText = '', maxTerms = EXPAND_DEFAULT_MAX_TERMS } = {}) {
  const list = Array.isArray(raw) ? raw : (raw !== null && typeof raw === 'object' && Array.isArray(raw.terms) ? raw.terms : null)
  if (list === null) return []
  const cap = Math.max(1, Number(maxTerms) || EXPAND_DEFAULT_MAX_TERMS)
  const src = String(userText ?? '')
  const out = []
  for (const item of list) {
    const t = String(item ?? '').trim()
    if (t === '' || t.length > 12) continue
    if (src.includes(t)) continue // 原话里已有的词不算扩展(它本来就参与检索)
    if (out.includes(t)) continue
    out.push(t)
    if (out.length >= cap) break
  }
  return out
}

/** 一次调用(超时/失败都不抛,只回报状态 —— 与 C1 同一形状)。 */
export function expandOnce ({ run, userText = '', timeoutMs = EXPAND_DEFAULT_TIMEOUT_MS, parent = null, maxTerms = EXPAND_DEFAULT_MAX_TERMS, now = () => Date.now() } = {}) {
  const t0 = now()
  if (typeof run !== 'function' || normalizeQueryKey(userText) === '') {
    return Promise.resolve({ ok: false, terms: [], skipped: true, ms: 0 })
  }
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), clampExpandTimeoutMs(timeoutMs))
    if (typeof timer.unref === 'function') timer.unref()
  })
  const call = Promise.resolve()
    .then(() => run(expandPrompt({ userText, maxTerms }), EXPAND_SCHEMA, parent))
    .then((res) => ({ raw: res }))
    .catch((err) => ({ failed: true, err }))
  return Promise.race([call, timeout]).then((r) => {
    try { if (timer !== null) clearTimeout(timer) } catch { /* 忽略 */ }
    const ms = now() - t0
    if (r && r.timedOut) return { ok: false, terms: [], timedOut: true, ms }
    if (r && r.failed) return { ok: false, terms: [], failed: true, ms }
    const terms = parseExpansion(r ? r.raw : null, { userText, maxTerms })
    return { ok: terms.length > 0, terms, ms }
  })
}

/**
 * 门面:一句问句一次,缓存 + 记账。`take(sid)` 取走这一轮的结果(取走即删)。
 * 与 C1 的 `createSameTurnScorer` 同款:它站在每一轮流上,**不许拖慢回复**。
 */
export function createQueryExpander ({ run, getTimeoutMs = null, maxTerms = EXPAND_DEFAULT_MAX_TERMS, cacheMax = EXPAND_CACHE_MAX, logger = null, now = () => Date.now() } = {}) {
  const pending = new Map()
  const cache = new Map()
  const stats = { started: 0, applied: 0, timedOut: 0, failed: 0, skippedNoRun: 0, emptyQuery: 0, cacheHit: 0, lastMs: 0, lastTerms: 0, cacheSize: 0 }

  function cacheGet (key) {
    if (!cache.has(key)) return null
    const v = cache.get(key)
    cache.delete(key); cache.set(key, v) // LRU 触达
    return v
  }

  function begin (sid, { userText = '', parent = null, onSettle = null } = {}) {
    const key = normalizeQueryKey(userText)
    let auditInput
    try { auditInput = captureAuditInput({ text: userText, modelText: String(userText ?? '').slice(0, 300), maxTerms }) } catch { auditInput = null }
    // ⚠️ 2026-10-10:`onSettle` 抛异常**必须留痕**。以前这里是空 `catch { }`
    // ⇒ 审计写失败时「行不落、也没有任何一句话」,现场表现为「query_expand
    // 恒 0 行」而五条出口看起来全都正常 —— 查了很久才知道是被静默吞了。
    // 这与 `same_turn_emotion` 缺 `raw` 字段是同一类病:**看不见的失败**。
    // 现在一律 `logger.warn`,失败了至少能在日志里看到是哪条出口。
    const warnSettle = (where, err) => {
      try {
        if (logger !== null && logger !== undefined && typeof logger.warn === 'function') {
          logger.warn('echo: query_expand onSettle 回调抛错(' + where + '),这一支的审计行没写成:'
            + String(err?.message ?? err))
        }
      } catch { /* 连日志都写不出就只能放弃 —— 但绝不让它影响这一轮 */ }
    }
    // 期 0 并发观测:早退路径也要回调(skip/空查询/缓存命中)—— 否则这一支永远不落审计
    const settleNow = (reason, ok, terms = null) => {
      try { if (typeof onSettle === 'function') onSettle({ ok, timedOut: false, ms: 0, terms: 0, reason, io: makeAuditIO('query_expand', auditInput, { status: reason, fromCache: reason === 'cache_hit' }, { terms, count: Array.isArray(terms) ? terms.length : null }) }) } catch (err) { warnSettle('early:' + reason, err) }
    }
    if (typeof run !== 'function') { stats.skippedNoRun += 1; settleNow('no_run', false); return Promise.resolve(null) }
    // ★ 2026-10-17：`empty_query` 这条路以前**一条 stats 都不记**就直接 return
    //   ⇒ 状态面上是「全 0」，和"压根没跑过"**长得一模一样**。
    //   现场：真机 `expanded` 一直是 null，而 `queryExpand` 段十个计数全是 0，
    //   于是"到底是空查询、还是没跑到、还是超时"根本分不出来，只能靠猜。
    //   这与本仓库反复踩的同一类病同源（`same_turn_emotion` 缺 `raw`、
    //   `onSettle` 静默吞异常、`judge.py` 的「缺少」vs「值非法」）。
    if (key === '') { stats.emptyQuery += 1; stats.lastMs = 0; settleNow('empty_query', false); return Promise.resolve(null) }
    const hit = cacheGet(key)
    // ★★ 2026-10-21：`pending` 条目**必须带 key**（本轮那句话）。
    //   漏了这条 ⇒ 所有缓存命中都会被 `take(sid, query)` 拒收 ⇒ 扩展从此永远交付不了。
    if (hit !== null) { stats.cacheHit += 1; settleNow('cache_hit', true, hit); pending.set(String(sid), { key, terms: hit, fromCache: true }); return Promise.resolve(hit) }
    stats.started += 1
    const timeoutMs = typeof getTimeoutMs === 'function' ? getTimeoutMs() : EXPAND_DEFAULT_TIMEOUT_MS
    return expandOnce({ run, userText, timeoutMs, parent, maxTerms, now }).then((r) => {
      stats.lastMs = r.ms
      if (r.timedOut) stats.timedOut += 1
      else if (r.failed) stats.failed += 1
      if (r.terms.length > 0) {
        cache.set(key, r.terms)
        if (cache.size > cacheMax) cache.delete(cache.keys().next().value)
        stats.lastTerms = r.terms.length
        // ★★ 同上：带 key。这是**迟到**风险最大的一条 —— 它 resolve 的时刻
        //   可能已经晚于本轮 `take()`，那样它会躺在 pending 里等下一轮来取。
        pending.set(String(sid), { key, terms: r.terms, fromCache: false })
      }
      stats.cacheSize = cache.size
      // 期 0 并发观测:settle 时回调(不 await、不改语义)
      try { if (typeof onSettle === 'function') onSettle({ ok: r.terms.length > 0, timedOut: r.timedOut === true, failed: r.failed === true, ms: r.ms, terms: r.terms.length, io: makeAuditIO('query_expand', auditInput, { status: r.timedOut ? 'timeout' : r.failed ? 'failed' : r.terms.length ? 'success' : 'empty_result', fromCache: false, timeoutMs: clampExpandTimeoutMs(timeoutMs) }, { terms: r.terms, count: r.terms.length }) }) } catch (err) { warnSettle('settle', err) }
      return r.terms
    }).catch((err) => {
      stats.failed += 1
      try { if (typeof onSettle === 'function') onSettle({ ok: false, failed: true, ms: 0, terms: 0, error: String(err?.message ?? err), io: makeAuditIO('query_expand', auditInput, { status: 'failed', fromCache: false }, { terms: null, count: null }) }) } catch (e2) { warnSettle('catch', e2) }
      return null
    })
  }

  /**
   * 取走**这一轮那句话**的扩展词元（取走即删）；没有 / 不是同一句 ⇒ `null`（检索照旧走）。
   *
   * ★★ 2026-10-21：**必须校验是不是同一句**（`query` 是这一轮他说的那句）。
   *
   *   以前只按 `sid` 存、只按 `sid` 取，**不比对问话**。只要扩展"迟到"一次
   *   （本轮 `take()` 已经过去了它才 resolve），它就会躺在 `pending` 里，
   *   被**下一轮**的 `take()` 取走，当成下一轮那句话的扩展词元送进检索
   *   ⇒ **静默用错词**（不报错、不记日志，只是召回的东西不对）。
   *
   *   为什么**丢弃**不匹配项而不是留着：
   *     `cache` 是按 **query key** 存的（`begin` 里 `cacheGet(key)`），
   *     同一句再问一次会走 `cacheHit` 原样恢复。所以 `pending` 只是
   *     **"本轮交接槽"** —— 严格绑定本轮那句话才对。丢弃它**不丢任何能力**，
   *     反而堵死了"给下一轮送错词"这条路。
   *
   * @param {string} sid 会话 id
   * @param {string} query 这一轮他说的那句话（与 `begin` 时同一个 `normalizeQueryKey` 口径）
   * @returns {{key: string, terms: string[], fromCache: boolean} | null}
   */
  function take (sid, query) {
    const k = String(sid)
    const v = pending.get(k) || null
    if (v === null) return null
    // ★ 不是这一轮的 ⇒ 丢掉并拒收。留着只会被下一轮误用（那正是这颗雷）。
    if (v.key !== normalizeQueryKey(query)) { pending.delete(k); return null }
    pending.delete(k)
    stats.applied += 1
    return v
  }

  return { begin, take, stats: () => ({ ...stats, pending: pending.size }), cacheClear: () => cache.clear() }
}
