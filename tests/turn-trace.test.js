/**
 * B2 trace 结构化的电池。
 *
 * 这一格的价值全在"能不能串起来查"上,所以两条线都要钉:
 *   ① `turn-trace` 的换轮/过期语义(过期不许把几小时后的一轮并进来);
 *   ② 工具审计**真的**用上了这一轮的 trace,并且耗时是**配对量出来的**
 *      (`pre` 记开始、`post` 相减),拿不到就 null —— 不编数字。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnTrace, TURN_TRACE_TTL_MS } from '../lib/turn-trace.js'
import { createToolAudit } from '../lib/tool-audit.js'

function clock (atMs = 1_800_000_000_000) {
  let ms = atMs
  return { now: () => ms, advance: (min) => { ms += Math.round(min * 60000) } }
}

function fakeCtx () {
  const listeners = new Map()
  return {
    listeners,
    on (name, fn) { listeners.set(name, fn); return () => listeners.delete(name) }
  }
}

const execOf = (name, sid = 'sess-1') => ({ name, args: {}, agent: { session: { id: sid } } })

// ---- ① turn-trace ----------------------------------------------------------

test('B2:一次开口换一轮,uuid 可注入 ⇒ 离线可测', () => {
  let n = 0
  const t = createTurnTrace({ uuid: () => 'T' + (++n), now: () => 1000 })
  assert.equal(t.begin('s1'), 'T1')
  assert.equal(t.of('s1'), 'T1')
  assert.equal(t.begin('s1'), 'T2', '再开口 = 新的一轮')
  assert.equal(t.of('s1'), 'T2')
})

test('B2:没开口过 / 别的会话 ⇒ 空串(调用方退回老行为)', () => {
  const t = createTurnTrace({ now: () => 1000 })
  assert.equal(t.of('s1'), '')
  t.begin('s1')
  assert.equal(t.of('s2'), '', '会话之间不许串')
  assert.equal(t.of(''), '')
  assert.equal(t.begin(''), '', '没会话 id 就不起 trace')
})

test('B2:过期不许把几小时后的一轮并进来(比不串更误导)', () => {
  const c = clock()
  const t = createTurnTrace({ now: c.now, uuid: () => 'T1' })
  t.begin('s1')
  assert.equal(t.of('s1'), 'T1')
  c.advance(TURN_TRACE_TTL_MS / 60000 + 1)
  assert.equal(t.of('s1'), '', '过期 ⇒ 空串')
  assert.equal(t.stats().expired, 1, '过期要计数(面板能说清为什么这轮没串上)')
})

test('B2:forget 立刻断开关联(会话清空/下线)', () => {
  const t = createTurnTrace({ now: () => 1000, uuid: () => 'T1' })
  t.begin('s1')
  t.forget('s1')
  assert.equal(t.of('s1'), '')
  assert.equal(t.stats().live, 0)
})

// ---- ② 工具审计跟着走 ------------------------------------------------------

test('B2:工具独立行 ID 与这一轮的关联分开，重复调用也保留', async () => {
  const ctx = fakeCtx()
  const rows = []
  const audit = createToolAudit({
    store: { writeAudit: (r) => rows.push(r) },
    traceOf: (sid) => (sid === 'sess-1' ? 'TURN-7' : '')
  })
  audit.attach(ctx)
  const post = ctx.listeners.get('tools/post-execute')
  await post(execOf('read_file'), { ok: true }, async () => ({ kind: 'allow' }))
  await post(execOf('read_file'), { ok: true }, async () => ({ kind: 'allow' }))
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].traceId, rows[1].traceId)
  for (const row of rows) {
    assert.match(row.traceId, /^[0-9a-f-]{36}$/u)
    assert.notEqual(row.traceId, 'TURN-7')
    assert.equal(JSON.parse(row.stageDetail).turnTrace, 'TURN-7')
  }
})

test('B2:没有这一轮的 trace ⇒ 退回自己一个 uuid(老行为,但别是空的)', async () => {
  const ctx = fakeCtx()
  const rows = []
  const audit = createToolAudit({ store: { writeAudit: (r) => rows.push(r) }, traceOf: () => '' })
  audit.attach(ctx)
  await ctx.listeners.get('tools/post-execute')(execOf('read_file'), { ok: true }, async () => ({ kind: 'allow' }))
  assert.match(String(rows[0].traceId), /^[0-9a-f-]{36}$/, '是 uuid,不是空串')
})

test('B2:耗时靠 pre/post 配对量(拿到才算,拿不到是 null)', async () => {
  const c = clock()
  const ctx = fakeCtx()
  const rows = []
  const audit = createToolAudit({
    store: { writeAudit: (r) => rows.push(r) },
    traceOf: () => 'TURN-1',
    now: c.now
  })
  audit.attach(ctx)
  const exec = execOf('run_code')
  // pre 记开始(而且**不改 decision**)
  const preOut = await ctx.listeners.get('tools/pre-execute')(exec, async () => ({ kind: 'allow', tag: 'pre-same' }))
  assert.deepEqual(preOut, { kind: 'allow', tag: 'pre-same' }, 'pre 也要原样交回')
  c.advance(1) // 1 分钟
  await ctx.listeners.get('tools/post-execute')(exec, { ok: true }, async () => ({ kind: 'allow' }))
  assert.equal(rows[0].latency, 60000)

  // 没配成对(宿主没发 pre 或对象不同)⇒ null,不编
  await ctx.listeners.get('tools/post-execute')(execOf('run_code'), { ok: true }, async () => ({ kind: 'allow' }))
  assert.equal(rows[1].latency, null)
})

test('B2:两处钩子都原样交回 next() 的结果(观察者不改任何 decision)', async () => {
  const ctx = fakeCtx()
  const audit = createToolAudit({ store: { writeAudit: () => {} }, traceOf: () => '' })
  const off = audit.attach(ctx)
  assert.equal(typeof off, 'function', '挂载要能卸')
  const decision = { kind: 'deny', reason: '别人的决定' }
  const post = await ctx.listeners.get('tools/post-execute')(execOf('x'), {}, async () => decision)
  assert.equal(post, decision)
  off()
  assert.equal(ctx.listeners.size, 0, '卸载后钩子都摘掉')
})
