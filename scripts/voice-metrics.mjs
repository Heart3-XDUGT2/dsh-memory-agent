// 她的语域,量出来的尺子(只读)。
//
// ── 2026-09-26 的教训:量错列 = 整套假结论 ──────────────────────────
// 第一版量的是 `audit_logs.llm_reply`。那一列**只在 tool_call='extract' 的行上
// 有值**,而那是提取器(`python/engine/judge.py`)写下的**第三人称摘要 + 内心戏**
// —— 不是她对他说的话。于是量出两个假结论:
//     ✗「句长中位数 49 字」   → 那是摘要的长度
//     ✗「38% 报账腔(已回:「…」)」→ 那是提取器的**输出格式**,她说的话里一个没有
// 真话在另外两列:
//     · 她发出去的原话 = `echo_qq_say.user_input`(前缀「(用 QQ 说)」)
//     · 她此刻的情绪   = extract 行的 `mood_intensity`(桥的记账行恒 0,必须排掉)
// 真基线(21 句)= 中位数 27 字 / ≤40 字 76% / 语气词 0% / 「主人」10% / 报账 0%。
// 真结论只剩一条,但那条很硬:**人格写着「句尾常带～嘛啦呀」,实际出现率 0%。**
//
// 用法:`npm run voice`(`-- --limit 40`、`-- --since 2026-09-26T15:20:00Z`)
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const numArg = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt
}
const limit = numArg('--limit', 40)
const sinceIso = args.includes('--since') ? String(args[args.indexOf('--since') + 1]) : ''
const since = sinceIso === '' ? 0 : Date.parse(sinceIso) / 1000

const DB = join(homedir(), '.dsh', 'echo', 'echo.db')
if (!existsSync(DB)) {
  console.log('  找不到 ' + DB + '(她还没起过?)')
  process.exit(0)
}
const db = new DatabaseSync(DB, { readOnly: true })
const t = (x) => new Date(x * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const pct = (n, tot) => (tot === 0 ? '—' : Math.round((n / tot) * 100) + '%')
const say = (s) => console.log('  ' + s)

// ---- 1~3. 她真正发出去的话 ----
// 一次发送在库里留两行(echo_qq_say 是她那次调用,relay_out 是桥的副本),
// 所以只取 echo_qq_say,顺手按文本去重(重发同一句只算一次)。
const seen = new Set()
const rows = db.prepare(
  "select timestamp, user_input from audit_logs where tool_call = 'echo_qq_say' and timestamp >= ? order by timestamp desc limit ?"
).all(since, limit * 2).filter((r) => {
  const x = String(r.user_input || '').replace(/^\(用 [^)]*说\)\s*/, '').trim()
  if (x === '' || seen.has(x)) return false
  seen.add(x)
  return true
}).slice(0, limit).reverse()

say('窗口:她**发出去**的最近 ' + rows.length + ' 句' + (since > 0 ? '(自 ' + t(since) + ')' : '') +
  (rows[0] ? ',从 ' + t(rows[0].timestamp) + ' 到 ' + t(rows.at(-1).timestamp) : ''))
if (rows.length === 0) {
  say('  (窗口内没有发送记录)')
} else {
  const txts = rows.map((r) => String(r.user_input).replace(/^\(用 [^)]*说\)\s*/, '').trim())
  const lens = txts.map((s) => s.replace(/\s/g, '').length).sort((a, b) => a - b)
  const has = (re) => pct(txts.filter((s) => re.test(s)).length, txts.length)
  say('')
  say('句长      中位数 ' + lens[Math.floor(lens.length / 2)] + ' 字   最短 ' + lens[0] + '   最长 ' + lens.at(-1) +
      '   ≤40 字 ' + pct(lens.filter((l) => l <= 40).length, lens.length) + '   ≤20 字 ' + pct(lens.filter((l) => l <= 20).length, lens.length))
  say('签名语气词 「～」' + has(/～/) + '   「嘛/啦/呀」' + has(/[嘛啦呀]/) + '   「嘿嘿/啊哈/嗯哼」' + has(/嘿嘿|啊哈|嗯哼/))
  say('称呼       「主人」' + has(/主人/) + '   「你」' + has(/你/))
  say('报账腔     以「已回/已发/测完/已送」开头 ' + has(/^\s*(已回|已发|测完|已送)/) + '(她说的话里,基线 0%)')
  say('')
  say('最后三句原文:')
  for (const x of txts.slice(-3)) say('  · ' + x.replace(/\n/g, ' ⏎ '))
}

// ---- 4. 情绪强度(extract 行才是真读数;桥的记账行恒 0,排掉) ----
const inten = db.prepare("select mood_intensity m, tool_call tc from audit_logs where timestamp >= ?").all(since)
const isBridge = (r) => /relay_in|relay_out|echo_qq_say/.test(String(r.tc || ''))
const real = inten.filter((r) => !isBridge(r) && Number(r.m) > 0).map((r) => Number(r.m))
say('')
if (real.length > 0) {
  const hist = new Map()
  for (const m of real) hist.set(m, (hist.get(m) || 0) + 1)
  const ks = [...hist.keys()].sort((a, b) => a - b)
  say('情绪强度(' + real.length + ' 轮真读数):' + ks.map((k) => k + '→' + hist.get(k)).join('  ') +
      '   平均 ' + (real.reduce((a, b) => a + b, 0) / real.length).toFixed(2) + ' 最高 ' + ks.at(-1))
  say('         落在低两档(≤4)的占 ' + pct(real.filter((m) => m <= 4).length, real.length) +
      '   ← 这两档的措辞 2026-09-26 已改暖(v9.0.0)')
} else {
  say('情绪强度:窗口内没有真读数')
}
db.close()
say('')
say('对照基线见 docs/VOICE_BASELINE_2026-09-26.md(注意:那份文档里 49 字/38% 报账是量错列的假结论,已纠正)')
