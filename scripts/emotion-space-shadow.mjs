#!/usr/bin/env node
/**
 * 情绪空间融合 · **影子采样回放**(第三批 2026-10-05)。
 *
 * 干什么:把活库 `audit_logs` 里**最近 N 轮真实情绪向量**拿出来,逐轮跑一遍
 * `lib/space-bridge.js`,打印每轮的联合空间读数与 `bridge_err`,并给一份分布小结。
 *
 * 为什么要有这个脚本(而不是等插件自己写):
 *   · 影子模式的审计列 `emotion_pack_structured` 要**下一轮对话**才会产生;
 *   · 而在那之前,他也应该能看见"这套换算在真实数据上误差到底多大" ——
 *     这就是标定 `λs/λd/θd` 的唯一依据。
 *
 * 三条纪律(与插件主路径同款):
 *   ① **只读**:数据库以 readOnly 打开,绝不写入(审计真源在插件侧,不在这个脚本);
 *   ② **fail-soft**:任何一步坏掉只跳过那一轮,绝不中断;
 *   ③ 输出里每项都标来源([文献] / [工程假设]),不把工程取法说成文献结论。
 *
 * 用法:
 *   node scripts/emotion-space-shadow.mjs            # 最近 10 轮
 *   node scripts/emotion-space-shadow.mjs --n 30     # 最近 30 轮
 *   node scripts/emotion-space-shadow.mjs --db <路径>
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { echoVectorToBipolar, SPACE_ID, EQUIVALENCE_NOTE } from '../lib/emotion-space.js'
import { createSpaceBridge, DEFAULT_BRIDGE_PARAMS } from '../lib/space-bridge.js'
import { echoToIpc } from '../lib/emotion-ipc-bridge.js'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const N = Math.max(1, Math.min(200, Number(argOf('n', 10)) || 10))
const dbPath = String(argOf('db', join(homedir(), '.dsh', 'echo', 'echo.db')))

if (!existsSync(dbPath)) {
  console.error('找不到数据库:' + dbPath)
  console.error('(用 --db <路径> 指定;这个脚本只读,不会建库)')
  process.exit(2)
}

const db = new DatabaseSync(dbPath, { readOnly: true })
const hasStructured = db.prepare("PRAGMA table_info(audit_logs)").all().map((r) => r.name).includes('emotion_pack_structured')
// 列还不存在(插件没被加载过 ⇒ 迁移还没跑)时,**不带那一列查** —— 脚本是只读的,
// 绝不为了自己方便去 ALTER 活库。
const rows = db.prepare(
  'SELECT trace_id, timestamp, emotion_vector' + (hasStructured ? ', emotion_pack_structured' : '') + ' FROM audit_logs' +
  " WHERE emotion_vector IS NOT NULL AND emotion_vector != '' AND emotion_vector != '{}'" +
  ' ORDER BY timestamp DESC LIMIT ?'
).all(N)
db.close()

const bridge = createSpaceBridge({ params: { ...DEFAULT_BRIDGE_PARAMS, shadowMode: true } })
const f = (v) => (Number.isFinite(Number(v)) ? (Math.round(Number(v) * 1000) / 1000).toFixed(3) : '  —  ')
const out = []
let errs = []
let degraded = 0
let missing = 0
let withStructured = 0

for (const row of rows) {
  let vec = {}
  try { vec = JSON.parse(row.emotion_vector) || {} } catch { vec = {} }
  try {
    const pad = echoVectorToBipolar(vec)
    const padU = bridge.padToUnion(pad, { native: false })
    const ipc = echoToIpc(vec)
    const ipcU = bridge.ipcToUnion(ipc.point, { sessionId: 'shadow-' + row.trace_id })
    const cmp = bridge.compareShared(padU.ok ? padU.union : null, ipcU.ok ? ipcU.union : null)
    if (padU.degraded || ipcU.degraded || !ipcU.ok) degraded += 1
    const miss = (pad.missing || []).length + (ipc.missing || []).length
    missing += miss
    if (Number.isFinite(Number(cmp.err))) errs.push(Math.abs(Number(cmp.err)))
    if (String(row.emotion_pack_structured || '').trim() !== '') withStructured += 1
    out.push({
      traceId: String(row.trace_id).slice(0, 12),
      s: padU.ok ? padU.union.s : null,
      a: padU.ok ? padU.union.a : null,
      d: padU.ok ? padU.union.d : null,
      sIpc: cmp.sIpc,
      err: cmp.err,
      ext: ipc.ext,
      miss
    })
  } catch (err) {
    out.push({ traceId: String(row.trace_id).slice(0, 12), error: String((err && err.message) || err) })
  }
}

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length)
const median = (xs) => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2
}

console.log('# 情绪空间融合 · 影子采样回放')
console.log('')
console.log('- 空间:' + SPACE_ID + '(影子模式:只算 + 记录,不进 prompt)')
console.log('- 数据源:' + dbPath + '(**只读**)')
console.log('- 样本:最近 ' + out.length + ' 轮带情绪向量的审计行(请求 ' + N + ' 轮)')
console.log('- 参数:θs=' + DEFAULT_BRIDGE_PARAMS.thetaS + '° / θs_ipc=' + DEFAULT_BRIDGE_PARAMS.thetaSipc +
  '° [文献];θd=' + DEFAULT_BRIDGE_PARAMS.thetaD + '° / λs=' + DEFAULT_BRIDGE_PARAMS.lambdaS +
  ' / λd=' + DEFAULT_BRIDGE_PARAMS.lambdaD + ' / biasS=' + DEFAULT_BRIDGE_PARAMS.biasS + ' [工程假设]')
console.log('- 审计新列 `emotion_pack_structured`:' + (hasStructured ? '在库(' + withStructured + ' / ' + out.length + ' 行非空)' : '尚未建列(插件下次加载时自动补)'))
console.log('')
console.log('| # | 轮次 trace | 联合 s | 联合 a | 联合 d | IPC 侧 s | bridge_err | 缺维 |')
console.log('|---|---|---|---|---|---|---|---|')
out.forEach((o, i) => {
  if (o.error) { console.log('| ' + (i + 1) + ' | ' + o.traceId + ' | 出错:' + o.error + ' | | | | | |'); return }
  console.log('| ' + (i + 1) + ' | ' + o.traceId + ' | ' + f(o.s) + ' | ' + f(o.a) + ' | ' + f(o.d) + ' | ' + f(o.sIpc) + ' | ' + f(o.err) + ' | ' + o.miss + ' |')
})
console.log('')
console.log('## 小结(影子读数分布)')
console.log('- 有效误差样本:' + errs.length + ' / ' + out.length + ' 轮')
console.log('- |bridge_err| 均值:' + f(mean(errs)) + ' · 中位数:' + f(median(errs)) + ' · 最大:' + f(errs.length ? Math.max(...errs) : null))
console.log('- 降级轮数(缓存缺维 / IPC 不可用):' + degraded)
console.log('- 缺维计数合计(0 表示历史向量都带齐了三维):' + missing)
console.log('')
console.log('> ' + EQUIVALENCE_NOTE)
console.log('> 说明:`bridge_err` 是**两套坐标对同一条共享轴的读数差**,只记账、不回写任何一维;')
console.log('> 长期偏正/偏负 ⇒ 该去面板调 λs(标定),而不是去改读数。')
