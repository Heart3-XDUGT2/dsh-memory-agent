/**
 * v0.37.0 G2:他改了称呼之后,别让**旧记忆把旧名字贴回她嘴上**。
 *
 * 现场:`store.setName()`(`lib/engine.js:268-269`,由 extract 的 ack 驱动)只改画像
 * 那一行;可记忆的摘要是**很久以前写的**,里面全是旧称呼。于是她一边看着
 * 「[他的称呼] 新名字」,一边从记忆里读到「旧名字今天说…」—— 轻则叫错,
 * 重则把同一个人当成两个人(别名行只能救"当成陌生人"那一半)。
 *
 * 做法(纯函数,离线可测):注入前把**记忆文本**里的旧称呼换成现在的称呼。
 *   - 只动**记忆**那一块:对话历史(他自己说过的话)一个字不改 —— 改历史
 *     就是把记录改成假的,那是比叫错名字严重得多的事;
 *   - 旧称呼从哪来:改名时**自动**记下(见 index.js 的 `onNameChange`),
 *     存在调参的 `retiredAliases` 里 —— 他不用做任何事;
 *   - 保守替换:与现名相同的不动,太短的(默认 2 字以下)不动,
 *     互为子串的一对不动(「阿柴」/「柴」这种替换会切坏别的词),
 *     命中数封顶(默认 50),免得一整块被反复重写。
 */
const ALIAS_MIN_LEN = 2
export const ALIAS_MAX_HITS = 50

/** 把字符串列表(逗号/顿号/空白/换行分隔)拆成去重数组。 */
export function splitAliases (raw) {
  const s = typeof raw === 'string' ? raw : (Array.isArray(raw) ? raw.join(',') : '')
  const out = []
  for (const part of s.split(/[,、,;；\s\n\r]+/)) {
    const a = part.trim()
    if (a !== '' && !out.includes(a)) out.push(a)
  }
  return out
}

/** 一对名字该不该换:`{ok, why}`(why 只给测试与诊断看,不影响调用方)。 */
export function shouldRewrite (current, retired) {
  const cur = String(current || '').trim()
  const old = String(retired || '').trim()
  if (cur === '' || old === '') return { ok: false, why: '缺一个名字' }
  if (cur === old) return { ok: false, why: '就是现在这个名字' }
  if (old.length < ALIAS_MIN_LEN) return { ok: false, why: '太短(会切坏别的词)' }
  if (cur.includes(old) || old.includes(cur)) return { ok: false, why: '互为子串(替换会伤到别的词)' }
  return { ok: true, why: '' }
}

/**
 * 把 `text` 里的旧称呼换成现在的称呼。
 * 回 `{text, hits, changed, skipped}`:`hits` 是每处替换的 `{from, count}`,
 * `skipped` 记下"为什么这个旧名没换"(诚实:不换也要说得出理由)。
 */
export function rewriteRetiredAliases (text, { current = '', retired = [], maxHits = ALIAS_MAX_HITS } = {}) {
  const src = String(text ?? '')
  const list = Array.isArray(retired) ? retired : splitAliases(retired)
  const skipped = []
  if (src === '' || list.length === 0) return { text: src, hits: [], changed: false, skipped }
  let out = src
  const hits = []
  let budget = maxHits
  for (const old of list) {
    const verdict = shouldRewrite(current, old)
    if (!verdict.ok) { skipped.push({ from: String(old || ''), why: verdict.why }); continue }
    if (budget <= 0) { skipped.push({ from: String(old), why: '命中数封顶' }); continue }
    // 逐处替换,而且**按预算截断**:剩下的旧称呼原样留着 ——
    // 宁可少改几处(她会从别名行知道那也是他),也不许把一整块重写一遍。
    const parts = out.split(String(old))
    if (parts.length === 1) continue
    let used = 0
    let rebuilt = parts[0]
    for (let i = 1; i < parts.length; i++) {
      if (budget > 0) { rebuilt += String(current); budget -= 1; used += 1 } else { rebuilt += String(old) }
      rebuilt += parts[i]
    }
    out = rebuilt
    if (used > 0) hits.push({ from: String(old), count: used })
  }
  return { text: out, hits, changed: out !== src, skipped }
}
