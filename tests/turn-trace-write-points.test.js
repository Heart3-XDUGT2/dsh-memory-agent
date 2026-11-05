/**
 * 补 retrieve / echo_qq_say 的 turnTrace —— 2026-10-18
 * ==================================================================
 * 上一次（`4ebaa6b`）把 `turnTrace` 的补写做成了一处注册、全场生效，
 * 实测从 **8% → 62%**。剩下 38% 是三处**根本没把 `sessionId` 递到 `writeAudit`**：
 *
 *   ① `retrieve`  —— `turn-snapshot.js` 调 `engine.retrieve()` 时没传 `sessionId`，
 *      而 `engine.js:263` 明明写了 `sessionId: String(extras.sessionId ?? '')`
 *      （那行注释自己都说了「要挂当轮得由壳把 sid/trace 递进来」）。
 *   ② `echo_qq_say` —— `auditToolCall(label, toolCall)` 只有两个参数，
 *      `writeAudit` 不带 `sessionId` ⇒ 落到默认 `GLOBAL_SESSION='global'`
 *      ⇒ `turnTrace.of('global')` 是空 ⇒ 那 138 行永远归不到轮里。
 *   ③ `reflection_failed` —— 整固是**全局夜间批处理**，**不该有 turnTrace**；
 *      但 `sessionId` 值得带上（不再一律落 'global'）。
 *
 * 本文件钉住这三条（都是行为或静态闸）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

test('① retrieve：调用 engine 时必须把 sid 递进去', () => {
  const src = read('../lib/turn-snapshot.js')
  const at = src.indexOf('engine.retrieve(')
  assert.ok(at > 0, 'turn-snapshot.js 里要有 engine.retrieve 的调用')
  const block = src.slice(at, at + 700)
  assert.match(block, /sessionId:\s*sid/,
    '★ extras 里必须带 `sessionId: sid` —— 否则 retrieve 的审计行落默认会话，'
    + 'turnTrace 永远是空的（实测 0%）')
})

test('② retrieve：engine 侧确实消费 extras.sessionId（不是白传）', () => {
  const src = read('../lib/engine.js')
  assert.match(src, /sessionId:\s*String\(extras\.sessionId/,
    'engine.js 的 writeAudit 要读 extras.sessionId')
})

test('③ echo_qq_say：auditToolCall 必须收 sessionId 并写进去', () => {
  const src = read('../lib/index.js')
  // 函数签名有第三个参数
  assert.match(src, /function auditToolCall \(label, toolCall, sessionId = ''\)/,
    '★ auditToolCall 要有第三个参数 sessionId')
  // 并且真的写进 writeAudit（有条件的展开）
  const at = src.indexOf('function auditToolCall')
  const block = src.slice(at, at + 900)
  assert.match(block, /sessionId:\s*String\(sessionId\)/,
    '★ 要把 sessionId 传给 writeAudit —— 否则落到 GLOBAL_SESSION=global')
  // 空串时不写（保持系统事件的老行为）
  assert.match(block, /String\(sessionId \?\? ''\) === '' \? \{\}/,
    '空 sid 时不塞 sessionId（老行为逐位不变）')
})

test('④ echo_qq_say：relay-tools 调用 audit 时必须传第三个参数', () => {
  const src = read('../lib/relay-tools.js')
  const at = src.indexOf("audit('(' + (kind === 'call'")
  assert.ok(at > 0, 'relay-tools.js 里要有那次 audit 调用')
  const block = src.slice(at, at + 340)
  assert.match(block, /echo_qq_say',\s*sid\)/,
    '★ audit 的第三个参数必须是 sid —— 否则 echo_qq_say 的审计行归不到轮里')
})

test('⑤ reflection_failed：带 sessionId，但**不**补 turnTrace（全局批处理不是一轮）', () => {
  const src = read('../lib/index.js')
  const at = src.indexOf('const reflectFailAudit')
  assert.ok(at > 0)
  const block = src.slice(at, at + 1400)
  assert.match(block, /sessionId:\s*String\(sessionId\)/,
    '有 sid 就带上（不再一律落 global）')
  // 关键：不许往 stageDetail 里塞 turnTrace
  assert.equal(/stageDetail.*turnTrace/.test(block), false,
    '★ 整固失败**不许**补 turnTrace —— 它是全局夜间批处理，'
    + '硬挂到某一轮上是假归组')
})

test('⑥ 行为：给了 sessionId ⇒ resolver 能查到并补上 turnTrace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-tt2-'))
  const { openStore } = await import('../lib/store.js')
  const store = openStore(join(dir, 'echo.db'))
  try {
    store.setTurnTraceResolver((sid) => (sid === 'session-real' ? 'trace-R' : ''))
    // 模拟 auditToolCall 修好后的形状
    store.writeAudit({
      traceId: 't-qq-say',
      sessionId: 'session-real',
      userInput: '(用 QQ 说)在的',
      toolCall: 'echo_qq_say',
      stage: 'tool:echo_qq_say'
    })
    const r = store.db.prepare('SELECT session_id, stage_detail FROM audit_logs WHERE trace_id = ?').get('t-qq-say')
    assert.equal(r.session_id, 'session-real', '★ 不再落到 global')
    assert.equal(JSON.parse(r.stage_detail).turnTrace, 'trace-R', '★ 自动补上 turnTrace')
  } finally {
    try { store.close?.() } catch { /* 关不掉不影响结论 */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
  }
})

test('⑦ 行为：sid 为空 ⇒ 落 global 且不补 turnTrace（老行为不变）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-tt3-'))
  const { openStore } = await import('../lib/store.js')
  const store = openStore(join(dir, 'echo.db'))
  try {
    store.setTurnTraceResolver(() => 'trace-should-not-appear')
    store.writeAudit({
      traceId: 't-nosid2',
      userInput: '(系统事件)',
      toolCall: 'reflection_failed'
    })
    const r = store.db.prepare('SELECT session_id, stage_detail FROM audit_logs WHERE trace_id = ?').get('t-nosid2')
    assert.equal(r.session_id, 'global', '没给 sid ⇒ 老行为：global')
    assert.equal(String(r.stage_detail ?? ''), '', '★ 不给 sid 就不补 turnTrace')
  } finally {
    try { store.close?.() } catch { /* 关不掉不影响结论 */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
  }
})
