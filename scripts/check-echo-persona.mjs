/**
 * dsh-echo — 人格落地自检(2026-09-26,他拍板「B + 自检」)
 * ============================================================
 * 回答一个问题:**她真的带着我写的那份人格吗?**
 *
 * 为什么需要它:2026-09-26 他问「她讲话的语气完全不符合我给的人物提示词」,
 * 而我们所有现成的仪表都在骗人 —— 面板显示「人格字数 1813」、审计一切正常、
 * 插件日志没有任何异常,可她实际跑的是**插件默认人格**。真相只能从**真实
 * 请求体**里读出来:DSH 把每次请求的 system message 记进会话流
 * (`~/.dsh/sessions/<项目>/<会话>/session.v3.jsonl.zstd`,zstd 多帧追加)。
 *
 * 判据(逐会话):
 *   ✓ 已生效      最后一条 system/message 里含当前前段 + 后段;
 *   ✓ 已送达      不在最后一条 system/message 里,但出现在它**之后**的事件里
 *                (宿主用 `systemPromptUpdate:"in-history"` 把改动放进历史);
 *   ⏳ 等下一轮   会话最后一次活动**早于**人格保存时间 —— 她还没开口,不算错;
 *   ✗ 对不上      会话在人格保存**之后**动过,而新文本在整条流里找不到 ——
 *                她开口了,却带着旧人格/默认人格。这是要报警的那一种。
 *
 * 用法:
 *   node scripts/check-echo-persona.mjs            最近 3 天动过的会话
 *   node scripts/check-echo-persona.mjs --days=14  放宽窗口
 *   node scripts/check-echo-persona.mjs --all      扫全部会话(慢)
 * 退出码:0 = 没有 ✗;1 = 有 ✗(或读不到人格)。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { loadPersona, PERSONA_PATH } from '../lib/persona.js'
import { sessionEnabled } from '../lib/toggle.js'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const DAY = 86400000

/** zstd 多帧文件:按帧头切开逐帧解(同步 API 只吃第一帧 —— 踩过)。 */
export function decodeSessionStream (buf) {
  const starts = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { starts.push(i); i += 4 }
  const out = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { out.push(zstdDecompressSync(buf.subarray(starts[k], end))) } catch { /* 假帧头,跳过 */ }
  }
  return Buffer.concat(out).toString('utf8')
}

/**
 * 取一段人格文本的**指纹**:第一个不含空白的连续片段(≥12 字符)。
 * 为什么挑无空白片段:会话流里文本是 JSON 转义的,换行变成字面的 `\n`
 * 两个字符,带空白的片段根本匹配不上。
 * @param {string} text 人格文本
 * @returns {string} 指纹;文本太短则返回去空白后的全文
 */
export function fingerprint (text) {
  const runs = String(text ?? '').split(/\s+/).filter((s) => s.length >= 12)
  if (runs.length > 0) return runs[0]
  return String(text ?? '').replace(/\s+/g, '')
}

/**
 * 会话头信息(zstd 的第一帧):`{type,version,id,createdAt,cwd,isSeeded,
 * delegationDepth,agentPreset}`。
 *
 * 2026-09-26 查清那 19 条 ✗ 时加:它们全是**只有 1 条 system 消息、seq 到 7**
 * 的小会话 —— 她跑 Judge/整固时**自己 fork 出去的子代理会话**。子代理
 * **按设计就不该带人格**(那是内部提取工,带人格既浪费又可能污染抽取),
 * 可 `sessionEnabled` 只判"用户在射程内",判不出"这是子代理" ⇒ 检查器
 * 把设计正确的事报成了 ✗。会喊狼来了的检查比没有更糟,所以这里按会话头
 * 的 `delegationDepth` 跳过。
 */
export function sessionDepth (stream) {
  const first = stream.split('\n', 1)[0] || ''
  try {
    const j = JSON.parse(first)
    return Number(j.delegationDepth ?? 0) || 0
  } catch { return 0 }
}

/** 会话流里的时间戳(毫秒):取最后一条能解析出 time 的事件。 */
export function lastEventTime (stream) {
  const lines = stream.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line === '') continue
    try {
      const o = JSON.parse(line)
      if (typeof o.time === 'number') return o.time
    } catch { /* 尾部可能有半行 */ }
  }
  return 0
}

/**
 * 最后一条 system/message:返回 { text, time, offset };没有就返回空。
 * 为什么带 offset:宿主把人格改动以 `systemPromptUpdate:"in-history"` 的形式
 * 放进历史时,system/message **不会重记** —— 那就得看「这段文本出现在最后一次
 * 组装**之后**吗」,所以要知道那条 system message 在流里的位置。
 */
export function lastSystemMessage (stream) {
  const lines = stream.split('\n')
  let offset = 0
  let last = { text: '', time: 0, offset: -1 }
  for (const line of lines) {
    if (line.includes('"system/message"')) {
      try {
        const o = JSON.parse(line)
        if (o.type === 'system/message') {
          const blocks = o.data?.message?.content ?? []
          last = { text: blocks.map((b) => String(b.text ?? '')).join('\n'), time: Number(o.time) || 0, offset }
        }
      } catch { /* 半行,跳过 */ }
    }
    offset += Buffer.byteLength(line, 'utf8') + 1
  }
  return last
}

/**
 * 判一条会话(纯函数,离线可测)。
 *
 * 时序是关键:**最后一次组装在保存之前 ⇒ 她只是还没轮到(⏳)**;组装在保存
 * **之后**却仍没带上 ⇒ 那才是真的没生效(✗)。第一版拿「会话最后活动时间」
 * 当判据,被自己的用例抓出来:保存前 30 秒动过的会话被误报成 ✗。
 *
 * @param {{stream:string, persona:{prefix:string,suffix:string}, savedAt:number, graceMs?:number}} input
 * @returns {{verdict:'ok'|'in-history'|'pending'|'stale', detail:string}}
 */
/**
 * 一段人格文本的**多点指纹**(2026-09-26 当晚加)。
 *
 * 为什么要多点:`fingerprint()` 取的是**第一个**无空白片段。那天我改了
 * 「说话方式」的正文、没动「两条铁律」的标题 —— 而标题正是第一个片段,
 * 于是这个检查拿着**旧请求体**照样报「✓ 已生效」。假绿的检查比没有检查更坏
 * (它会把「她还没带上新人格」这件事盖住)。现在:
 *   · system prompt 内用**全量逐字比对**(那里的文本是解析过的,不转义);
 *   · 历史送达分支没法逐字比(流里是转义的),就要求**三点指纹全中**。
 * 取点方式确定(首/中/尾),不用随机 —— 测试要能复现。
 *
 * @param {string} text 人格文本
 * @param {number} n 取几个点
 * @returns {string[]} 指纹列表(去重)
 */
export function fingerprints (text, n = 3) {
  const runs = String(text ?? '').split(/\s+/).filter((s) => s.length >= 12)
  const all = runs.length > 0 ? runs : [String(text ?? '').replace(/\s+/g, '')].filter((s) => s !== '')
  if (all.length <= n) return [...new Set(all)]
  const idx = new Set()
  for (let i = 0; i < n; i++) idx.add(Math.round((i * (all.length - 1)) / (n - 1)))
  return [...idx].sort((a, b) => a - b).map((i) => all[i])
}

export function judgeSession ({ stream, persona, savedAt, graceMs = 5000 }) {
  const fps = [...fingerprints(persona.prefix), ...fingerprints(persona.suffix)]
  const sys = lastSystemMessage(stream)
  const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim()

  // ① 逐字:最后一条 system prompt 里有没有**整段**当前人格。
  const sysText = norm(sys.text)
  const inSystem = (text) => {
    const t = norm(text)
    return t !== '' && sysText.includes(t)
  }
  if (inSystem(persona.prefix) && inSystem(persona.suffix)) {
    return { verdict: 'ok', detail: '最后一条 system prompt 里逐字含当前前段 + 后段' }
  }
  // ② 历史送达:宿主把改动放进历史(in-history)时 system/message 不会重记 ——
  // 这时要求当前文本的**三点指纹全中**,且都在最后一次组装之后。
  if (fps.length > 0 && sys.offset >= 0 && fps.every((fp) => stream.slice(sys.offset).includes(fp))) {
    return { verdict: 'in-history', detail: '不在最后一条 system prompt 里,但在其后的历史更新中出现(三点指纹全中)' }
  }
  if (sys.time === 0 || sys.time < savedAt - graceMs) {
    return { verdict: 'pending', detail: '最后一次组装在人格保存之前 —— 她下一次开口才会带上' }
  }
  return {
    verdict: 'stale',
    detail: '人格保存**之后**组装过,可那一次的 system prompt 里没有当前人格(她带着旧人格/默认人格说的话)'
  }
}

/**
 * 当前人格落在 system prompt 的什么位置(百分比)。
 * 为什么报这个:2026-09-26 拍板把前段从 1.1% 处挪到尾部 —— 「挪了没有」
 * 得有数字,不然下一轮还是只能靠耳朵。
 * @returns {{prePct:number|null, sufPct:number|null, chars:number}}
 */
export function personaPosition (systemText, persona) {
  const total = systemText.length || 1
  const at = (fp) => {
    const i = fp === '' ? -1 : systemText.indexOf(fp)
    return i < 0 ? null : Math.round((1000 * i) / total) / 10
  }
  return { prePct: at(fingerprint(persona.prefix)), sufPct: at(fingerprint(persona.suffix)), chars: systemText.length }
}

function walkSessions (root, out = []) {
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(root, e.name)
    if (e.isDirectory()) walkSessions(p, out)
    else if (e.name === 'session.v3.jsonl.zstd') out.push(p)
  }
  return out
}

const ICON = { ok: '✓', 'in-history': '✓', pending: '⏳', stale: '✗' }

async function main () {
  const argv = process.argv.slice(2)
  const all = argv.includes('--all')
  const days = Number((argv.find((a) => a.startsWith('--days=')) ?? '--days=3').split('=')[1])
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const root = join(dshHome, 'sessions')

  if (!existsSync(PERSONA_PATH)) {
    console.log('✗ 找不到人格文件:' + PERSONA_PATH)
    process.exit(1)
  }
  const persona = await loadPersona()
  const savedAt = existsSync(PERSONA_PATH) ? statSync(PERSONA_PATH).mtimeMs : 0
  const fpPre = fingerprint(persona.prefix)
  const fpSuf = fingerprint(persona.suffix)
  console.log('当前人格:' + PERSONA_PATH)
  console.log('  前段 ' + persona.prefix.length + ' 字,指纹「' + fpPre + '」')
  console.log('  后段 ' + persona.suffix.length + ' 字,指纹「' + fpSuf + '」')
  console.log('  保存于 ' + (savedAt ? new Date(savedAt).toLocaleString() : '?') + '(edited=' + String(persona.customized) + ')')
  if (!persona.customized) {
    // 2026-09-26 那一课:他听了一整天的「默认 Echo」,而所有仪表都正常。
    // 盘上还是插件默认值 = 你写的那份**从来没进过这个文件**,不是没生效。
    console.log('  ⚠ 盘上这份是**插件默认人格**,不是你编辑过的 —— 她只会像默认那段说话。')
    console.log('     要把你写的人格生效:设置区面板粘贴保存(会写 edited:true + 刷新缓存)。')
  }

  const files = walkSessions(root)
  const cutoff = Date.now() - days * DAY
  const picked = files.filter((f) => all || statSync(f).mtimeMs >= cutoff)
  console.log('扫 ' + picked.length + ' 条会话' + (all ? '(全部)' : '(最近 ' + days + ' 天),共 ' + files.length + ' 条)') + '\n')

  const tally = { ok: 0, 'in-history': 0, pending: 0, stale: 0 }
  const rows = []
  let skipped = 0
  let subagents = 0
  for (const f of picked) {
    // 只判「插件在该会话本来就该带上人格」的会话 —— 用和插件同一个判据
    // (sessionEnabled:总闸 ∧ 范围闸)。否则子代理/辅助会话会被误报成 ✗:
    // 它们不在白名单里,人格段按设计就是空的。会喊狼来了的检查比没有更糟。
    const sid = basename(dirname(f))
    if (!sessionEnabled(sid)) { skipped++; continue }
    let stream = ''
    try { stream = decodeSessionStream(readFileSync(f)) } catch { continue }
    // 子代理会话(她 fork 出去跑 Judge/整固的)按设计不带人格 —— 跳过,
    // 但**报数**,免得"跳过"变成掩盖(以前这 19 条被误报成 ✗)。
    if (sessionDepth(stream) > 0) { subagents++; continue }
    if (!stream.includes('"system/message"')) continue
    const r = judgeSession({ stream, persona, savedAt })
    tally[r.verdict]++
    const rel = f.replace(root + '\\', '')
    const when = lastEventTime(stream)
    let detail = r.detail
    if (r.verdict === 'ok') {
      const pos = personaPosition(lastSystemMessage(stream).text, persona)
      detail += '(prompt 共 ' + pos.chars + ' 字;前段在 ' + pos.prePct + '% 处、后段在 ' + pos.sufPct + '% 处)'
    }
    rows.push({ icon: ICON[r.verdict], rel, when, detail, verdict: r.verdict })
  }
  rows.sort((a, b) => b.when - a.when)
  for (const r of rows.slice(0, 24)) {
    console.log('  ' + r.icon + ' ' + new Date(r.when).toLocaleString() + '  ' + r.rel.slice(0, 62))
    console.log('      ' + r.detail)
  }
  if (rows.length > 24) console.log('  … 还有 ' + (rows.length - 24) + ' 条')
  if (skipped > 0) console.log('  (范围外会话 ' + skipped + ' 条已跳过:插件在那儿的开关是关的)')
  if (subagents > 0) console.log('  (子代理会话 ' + subagents + ' 条已跳过:她被 fork 出去跑 Judge/整固时按设计不带人格)')

  console.log('\n合计:' + rows.length + ' 条 —— ✓已生效 ' + tally.ok + ' , ✓历史送达 ' + tally['in-history']
    + ' , ⏳等下一轮 ' + tally.pending + ' , ✗对不上 ' + tally.stale)
  if (tally.stale > 0) {
    console.log('\n✗ 有会话在她开口时没有带上当前人格 —— 要么重启 dsh web,要么查 persona 段是否被别的东西盖掉。')
    process.exit(1)
  }
  console.log('没有 ✗:她下一轮开口时会带着这份人格。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
