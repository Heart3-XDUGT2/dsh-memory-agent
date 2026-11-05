/**
 * 审计行的「这一轮是谁」—— 2026-10-18
 * ==================================================================
 * 现场（他报「审计面板数据缺了很多」）：
 *   `audit_logs` 一天 **508 行**，而面板**一行一行铺** ⇒ 每行只显示自己有的字段
 *   ⇒ 看 `echo_qq_say` 那行，`injected_memories` 是空的，就以为"记忆没注入"。
 *   实际数据都在，只是**散在 6~8 行里**（`inject` / `retrieve` / `relay_in` /
 *   `echo_qq_say` / `relay_out` / `extract` / `same_turn_emotion`）。
 *
 * 归组的前提是有一个"轮"的键。`trace_id` **不能**当这个键 —— 它是主键、
 * 走 `INSERT OR REPLACE`，两行共用会**互相覆盖**（`lib/index.js` 的 `auditArm`
 * 注释早写明，所以并行支才加 `#arm` 后缀）。
 *
 * ⇒ 用 `stage_detail.turnTrace`。实测改造前填充率 **8%**
 *   （只有 `same_turn_emotion` 那类并行支写了它）。
 *
 * 本文件钉住 `lib/store.js` 的 `withTurnTrace` 的**三条边界**：
 *   ① 没有 sessionId 的行不碰（日记/记忆编辑是系统事件，没有"轮"）；
 *   ② 已经写了 turnTrace 的行不覆盖（并行支自己那份是权威）；
 *   ③ resolver 抛错/返回空 ⇒ 原样写，绝不因为补字段把审计写坏。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 起一个临时库（用 openStore 直接给路径，不依赖 ECHO_DATA_DIR）。 */
async function freshStore (tag) {
  const dir = mkdtempSync(join(tmpdir(), 'echo-tt-' + tag + '-'))
  const { openStore } = await import('../lib/store.js')
  const store = openStore(join(dir, 'echo.db'))
  return {
    store,
    cleanup () {
      try { store.close?.() } catch { /* 关不掉不影响结论 */ }
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
    }
  }
}

/** 取一行刚写进去的 stage_detail。 */
function detailOf (store, traceId) {
  const r = store.db.prepare('SELECT stage_detail FROM audit_logs WHERE trace_id = ?').get(traceId)
  return r === undefined ? null : String(r.stage_detail ?? '')
}

test('① 没有 sessionId 的行不碰（系统事件没有"轮"）', async () => {
  const { store, cleanup } = await freshStore('nosid')
  try {
    store.setTurnTraceResolver(() => 'trace-abc')
    store.writeAudit({
      traceId: 't-nosid',
      // 故意不给 sessionId
      userInput: '(日记生成)',
      toolCall: 'diary',
      stageDetail: JSON.stringify({ note: 'keep' })
    })
    const sd = detailOf(store, 't-nosid')
    assert.equal(JSON.parse(sd).turnTrace, undefined,
      '★ 没有 sessionId 就不该补 turnTrace')
    assert.equal(JSON.parse(sd).note, 'keep', '原有字段要原样保留')
  } finally { cleanup() }
})

test('② 有 sessionId ⇒ 自动补 turnTrace（这是归组的前提）', async () => {
  const { store, cleanup } = await freshStore('withsid')
  try {
    store.setTurnTraceResolver((sid) => (sid === 'session-x' ? 'trace-xyz' : ''))
    store.writeAudit({
      traceId: 't-withsid',
      sessionId: 'session-x',
      userInput: '在吗',
      toolCall: 'relay_in',
      stageDetail: JSON.stringify({ stage: 'x' })
    })
    const sd = detailOf(store, 't-withsid')
    assert.equal(JSON.parse(sd).turnTrace, 'trace-xyz', '★ 要自动补上')
    assert.equal(JSON.parse(sd).stage, 'x', '原有字段不能丢')
  } finally { cleanup() }
})

test('③ stage_detail 是空串 ⇒ 也能补（造一个只有 turnTrace 的 JSON）', async () => {
  const { store, cleanup } = await freshStore('emptysd')
  try {
    store.setTurnTraceResolver(() => 'trace-only')
    store.writeAudit({
      traceId: 't-emptysd',
      sessionId: 's',
      userInput: 'hi',
      toolCall: 'echo_qq_say',
      stageDetail: ''
    })
    const sd = detailOf(store, 't-emptysd')
    assert.equal(JSON.parse(sd).turnTrace, 'trace-only')
  } finally { cleanup() }
})

test('④ 已经写了 turnTrace 的行不覆盖（并行支自己那份是权威）', async () => {
  const { store, cleanup } = await freshStore('keepown')
  try {
    store.setTurnTraceResolver(() => 'resolver-says-this')
    store.writeAudit({
      traceId: 't-keepown',
      sessionId: 's',
      userInput: '(并行支 same_turn_emotion)',
      toolCall: 'same_turn_emotion',
      stageDetail: JSON.stringify({ turnTrace: 'own-value', ms: 12 })
    })
    const sd = detailOf(store, 't-keepown')
    assert.equal(JSON.parse(sd).turnTrace, 'own-value',
      '★ 已有的 turnTrace 不许被 resolver 覆盖')
    assert.equal(JSON.parse(sd).ms, 12)
  } finally { cleanup() }
})

test('⑤ resolver 抛错 ⇒ 原样写（绝不因为补字段把审计写坏）', async () => {
  const { store, cleanup } = await freshStore('throw')
  try {
    store.setTurnTraceResolver(() => { throw new Error('boom') })
    store.writeAudit({
      traceId: 't-throw',
      sessionId: 's',
      userInput: 'hi',
      toolCall: 'relay_in',
      stageDetail: JSON.stringify({ a: 1 })
    })
    const sd = detailOf(store, 't-throw')
    assert.equal(JSON.parse(sd).a, 1, '原有内容要完好')
    assert.equal(JSON.parse(sd).turnTrace, undefined, '补不上就不补')
  } finally { cleanup() }
})

test('⑥ resolver 返回空串 ⇒ 不补', async () => {
  const { store, cleanup } = await freshStore('empty')
  try {
    store.setTurnTraceResolver(() => '')
    store.writeAudit({
      traceId: 't-empty',
      sessionId: 's',
      userInput: 'hi',
      toolCall: 'relay_in',
      stageDetail: JSON.stringify({ a: 1 })
    })
    const sd = detailOf(store, 't-empty')
    assert.equal(JSON.parse(sd).turnTrace, undefined)
  } finally { cleanup() }
})

test('⑦ 没注册 resolver ⇒ 老行为逐位不变（向后兼容）', async () => {
  const { store, cleanup } = await freshStore('none')
  try {
    store.writeAudit({
      traceId: 't-none',
      sessionId: 's',
      userInput: 'hi',
      toolCall: 'relay_in',
      stageDetail: JSON.stringify({ a: 1 })
    })
    const sd = detailOf(store, 't-none')
    assert.equal(sd, JSON.stringify({ a: 1 }), '★ 没注册就必须一字不改')
  } finally { cleanup() }
})

test('⑧ stage_detail 不是 JSON ⇒ 不猜形状，原样留着', async () => {
  const { store, cleanup } = await freshStore('badjson')
  try {
    store.setTurnTraceResolver(() => 'trace-x')
    store.writeAudit({
      traceId: 't-badjson',
      sessionId: 's',
      userInput: 'hi',
      toolCall: 'relay_in',
      stageDetail: '这不是 JSON'
    })
    const sd = detailOf(store, 't-badjson')
    assert.equal(sd, '这不是 JSON',
      '★ 宁可少一个字段，也不毁一条审计')
  } finally { cleanup() }
})

test('⑨ 静态闸：index.js 必须注册 resolver（否则改了个寂寞）', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const idx = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const sto = readFileSync(fileURLToPath(new URL('../lib/store.js', import.meta.url)), 'utf8')
  assert.ok(sto.includes('setTurnTraceResolver'), 'store.js 要导出注册口')
  assert.match(idx, /setTurnTraceResolver\?\.\(\(sid\) => turnTrace\.of\(sid\)\)/,
    '★ index.js 要用 turnTrace.of(sid) 注册 —— 否则 stage_detail 里永远是空的')
})
