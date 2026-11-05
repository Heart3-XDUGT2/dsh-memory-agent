/**
 * RT9 金标续命 —— **只读**矿工:去真机上捡「她明明记得、却没说出来」的现场。
 *
 * 为什么需要它:48 条金标全是我手造的题(query-first v2),**缺真实漏召回样本**。
 * 这个脚本反过来做:拿真机上发生过的一轮一轮(conversation_log 的他那句话 +
 * audit_logs 里那一轮**实际注入**的记忆文本),去问一句:
 *   「他这句话,库里明明有对得上的记忆(关键词有交集),可那一轮**没被调出来** —— 有几条?」
 * 命中的当场落成**金标草稿**(N7 现场漏召回),形状对齐 scripts/retrieval-bench.py 的
 * `(档位, query, {ids}, 依据)`。
 *
 * ⚠️ 三条纪律:
 *   ① **只读**(readOnly 打开线上库):矿工不许写库,连强化都不许(`reinforce=False` 那条纪律)。
 *   ② **草稿不等于金标**:关键词有交集**不代表**那条记忆真的该被想起来(可能只是同词不同事)。
 *      所以草稿只打印,进 `retrieval-bench.py` 得他过目点头 —— 我认错答案比漏题更糟。
 *   ③ 它是**启发式**,读数只当线索:`--json` 出全部,人看前几条。
 *
 * 用法:`node scripts/retrieve-audit.mjs [--turns 80] [--min-overlap 1] [--json]`
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name)
  if (i < 0) return dflt
  const v = args[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}
const TURNS = Math.max(1, Number(flag('turns', 80)) || 80)
const MIN_OVERLAP = Math.max(1, Number(flag('min-overlap', 2)) || 2)
const AS_JSON = args.includes('--json')
const DB = process.env.DSH_ECHO_DB || join(homedir(), '.dsh', 'echo', 'echo.db')

/** 关键词两种存法都吃得下:JSON 数组,或逗号/顿号串。 */
function keywordsOf (raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return []
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s)
      return Array.isArray(arr) ? arr.map((x) => String(x).trim()).filter((x) => x !== '') : []
    } catch { /* 落回串解析 */ }
  }
  return s.split(/[,，、;；\s]+/).map((x) => x.trim()).filter((x) => x !== '')
}

/** 中文二字以上词元(粗切:连续汉字段),够做"交集"这件事。 */
function termsOf (text) {
  const out = new Set()
  for (const m of String(text ?? '').matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const w = m[0]
    if (w.length <= 4) out.add(w)
    for (let i = 0; i + 1 < w.length; i++) out.add(w.slice(i, i + 2))
  }
  return out
}

if (!existsSync(DB)) {
  console.error('库不在:' + DB + '(设 DSH_ECHO_DB 指别的)')
  process.exit(2)
}

const db = new DatabaseSync(DB, { readOnly: true })
const turns = db.prepare(`
  SELECT a.user_input AS q, a.injected_memories AS injected, a.llm_reply AS reply, a.timestamp AS at
  FROM audit_logs a
  WHERE a.user_input IS NOT NULL AND TRIM(a.user_input) <> '' AND a.user_input NOT LIKE '(%'
  ORDER BY a.timestamp DESC LIMIT ?
`).all(TURNS)
const mems = db.prepare(`
  SELECT memory_id, keywords, summary, layer FROM episodic_memory
  WHERE is_active = 1 ORDER BY memory_id DESC LIMIT 4000
`).all()
db.close()

const drafts = []
for (const t of turns) {
  const qTerms = termsOf(t.q)
  if (qTerms.size === 0) continue
  const injected = String(t.injected ?? '')
  const hits = []
  for (const m of mems) {
    const kws = keywordsOf(m.keywords)
    if (kws.length === 0) continue
    const overlap = kws.filter((k) => k.length >= 2 && qTerms.has(k))
    if (overlap.length < MIN_OVERLAP) continue
    const summary = String(m.summary ?? '')
    // 已经被注入过(文本里能认出摘要开头)⇒ 不算漏召回
    const already = summary !== '' && injected.includes(summary.slice(0, 12))
    if (already) continue
    hits.push({ id: m.memory_id, layer: m.layer, overlap, summary: summary.slice(0, 60) })
  }
  if (hits.length > 0) {
    drafts.push({
      tier: 'N7 现场漏召回',
      query: String(t.q),
      ids: hits.map((h) => h.id),
      why: '他这句里出现过的词,这几条记忆的关键词也都有:' + hits[0].overlap.join('/'),
      source: 'live',
      at: Math.round(Number(t.at) || 0),
      replySeen: String(t.reply ?? '').slice(0, 120),
      detail: hits.slice(0, 5)
    })
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ db: DB, turns: turns.length, memories: mems.length, drafts }, null, 2))
} else {
  console.log('RT9 金标续命(只读):看了 ' + turns.length + ' 轮 / ' + mems.length + ' 条活跃记忆,'
    + '捡到 ' + drafts.length + ' 条草稿(档位 N7 现场漏召回)')
  for (const d of drafts.slice(0, 8)) {
    console.log('')
    console.log('  「' + d.query.slice(0, 40) + '」')
    console.log('    → 该想起来却没调出来: ' + d.detail.map((h) => '#' + h.id + '[' + h.layer + '] ' + h.summary).join(' | '))
  }
  console.log('')
  console.log('  草稿**不许自动进金标**:关键词有交集不等于那条记忆真该被想起来(同词不同事)。')
  console.log('  要进 scripts/retrieval-bench.py 得他过目;全量草稿加 --json。')
}
