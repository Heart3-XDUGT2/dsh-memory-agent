/**
 * v0.32.0 A1a:注入位置工程的**探针**(只测量,绝不改行为)。
 *
 * 为什么先量再搬 —— 这项目买过教训:
 * `lib/index.js:1340-1346` 记着上一版做法的现场:快照当 user 消息 append 进
 * surface,而 **surface append 永不消失** ⇒ 同一段上下文里 **62 条**重复的
 * 「[她此刻的状态]」、57,105 字、占 75%,他讲的话只剩 0.7%。
 * 现在 A1 想改用宿主文档里的 `systemPrompt.context()` ——
 * 它的类型注释是 "Dynamic model context materialized as a **durable user-role
 * snapshot**"(`docs/subsystems/system-prompt.zh.md:79-88`)。
 * 「durable」到底是"每轮**替换**那一份"还是"每轮**追加**一份",**文档没说死** ——
 * 所以先把它量出来,再决定搬不搬。**不靠推断。**
 *
 * 纪律:
 *   - 计数是纯函数(`countMarker`),不碰 IO ⇒ 能离线测;
 *   - 只报**它真的看得到的语料**,并把语料名(`scopes`)一起发出去 ——
 *     免得读数字的人以为"1 份"是对整段历史说的(这是诚实的一半);
 *   - 探针**不改注入内容**、不加标记行、不写库。
 */

/** 取一段注入文本的"标记行":第一行够长的非空行(找不到就给 '')。 */
export function firstMarkerLine (text, min = 8) {
  const lines = String(text ?? '').split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length >= min) return line.slice(0, 120)
  }
  return ''
}

/**
 * 在一堆文本里数标记出现次数。
 * 返回 `{ occurrences, chars, hits }`:`hits` 是每个语料命中的次数(定位用)。
 */
export function countMarker (texts, marker) {
  const m = String(marker ?? '')
  const out = { occurrences: 0, chars: 0, hits: [] }
  if (m === '') return out
  for (const t of texts ?? []) {
    const s = String(t ?? '')
    let n = 0
    let i = s.indexOf(m)
    while (i !== -1) { n += 1; i = s.indexOf(m, i + m.length) }
    if (n > 0) out.chars += m.length * n
    out.occurrences += n
    out.hits.push(n)
  }
  return out
}

/**
 * 汇总一次探针结果。
 * `scopes` 是我们**真的数过**的语料名(例:`system-prompt/sections`、`pre-step/messages`),
 * 没数的语料**不在里面** —— 面板与验收脚本据此标注"这份数字管到哪"。
 */
export function probeReport ({ at = 0, marker = '', corpora = {} } = {}) {
  const scopes = []
  let occurrences = 0
  let chars = 0
  const per = {}
  for (const [name, texts] of Object.entries(corpora ?? {})) {
    if (!Array.isArray(texts) || texts.length === 0) continue
    const r = countMarker(texts, marker)
    scopes.push(name)
    occurrences += r.occurrences
    chars += r.chars
    per[name] = r.occurrences
  }
  return {
    at: Number(at) || 0,
    marker: String(marker ?? ''),
    occurrences,
    chars,
    per,
    scopes,
    // 份数 > 1 就是"注入在历史/提示里累积"——A1b 的红线。
    duplicated: occurrences > 1
  }
}

/** 保存最近一次探针结果(一步一份,面板与验收脚本读它)。 */
export function createInjectProbe () {
  let last = null
  let loadedAt = 0
  return {
    record (opts) {
      try {
        last = probeReport(opts)
        return last
      } catch { return last }
    },
    /**
     * v0.40.0:「**已加载,但还没有读数**」—— 2026-09-28 夜真机踩到的:
     * 宿主重启后陪伴会话还没人来过话 ⇒ 一次组装都没有 ⇒ `inject` 是 null,
     * 于是探针喊「A1a 未加载」,把"还没发生"错报成"代码不在"。
     * 这两种情况必须分得开:前者是等一等,后者要重启。
     */
    loaded () {
      loadedAt = Date.now()
      return {
        at: 0,
        marker: '',
        occurrences: 0,
        chars: 0,
        per: {},
        scopes: [],
        duplicated: false,
        loadedAt,
        readings: 0,
        note: '探针已加载,还没组装过一次(等陪伴会话里发生一次真对话;不是"代码不在")'
      }
    },
    last () { return last },
    reset () { last = null }
  }
}
