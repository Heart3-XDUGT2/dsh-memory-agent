/**
 * B1 全量工具审计 的电池。
 *
 * 这一格最贵的教训是"审计自己不能成为事故":它是**观察者**,得
 * ① 原样交回结果(不许改别人的 content)、② 自己绝不抛、③ 关闸/写库失败都要**留痕**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clipText, safeStringify, callOf, resultOf, createToolAudit, AUDIT_MAX_CHARS } from '../lib/tool-audit.js'

function fakeCtx () {
  const listeners = new Map()
  return {
    listeners,
    on (name, fn) {
      listeners.set(name, fn)
      return () => listeners.delete(name)
    }
  }
}

function fakeStore () {
  const rows = []
  return {
    rows,
    writeAudit (row) { rows.push(row) }
  }
}

const execOf = (name, args = {}, sid = 'sess-1') => ({
  name,
  args,
  agent: { session: { id: sid } }
})

// ---- 纯函数 ----------------------------------------------------------------

test('截断:短的不动,长的留前 N 字并记原文长度', () => {
  assert.deepEqual(clipText('abc', 10), { text: 'abc', len: 3, cut: false })
  const long = 'x'.repeat(50)
  assert.deepEqual(clipText(long, 10), { text: 'x'.repeat(10), len: 50, cut: true })
  assert.equal(clipText({ a: 1 }, 100).text, '{"a":1}', '非字符串也 JSON 化')
})

test('JSON 化:循环引用不炸,undefined 给空串', () => {
  const o = { a: 1 }
  o.self = o
  assert.match(safeStringify(o), /循环/)
  assert.equal(safeStringify(undefined), '')
})

test('调用身份:name 与参数长度都拿到(超大参数只留前 500 字)', () => {
  const c = callOf(execOf('read_file', { path: 'a.txt' }))
  assert.equal(c.name, 'read_file')
  assert.equal(c.argsLen, '{"path":"a.txt"}'.length)
  assert.equal(c.argsCut, false)
  const big = callOf(execOf('write_file', { body: 'y'.repeat(5000) }))
  assert.equal(big.argsCut, true)
  assert.equal(big.argsText.length, AUDIT_MAX_CHARS)
  assert.equal(big.argsLen, '{"body":"' .length + 5000 + 2)
  assert.equal(callOf({}).name, '?', '连名字都没有也给个占位,不抛')
})

test('结果:ok/failed/未知三态分得清,content 数组拼成文本', () => {
  // v0.42.0 审计修复(P1):**宿主真形状是 `isError: boolean`**
  // (dsh-tools 的 `ToolResult.isError`)—— 原来 fixture 全是 `{ok:…}`,
  // 于是测试自己也没发现「真跑起来每一条审计的 ok 都是 null」。
  assert.equal(resultOf({ isError: false, content: [{ type: 'text', text: 'done' }] }).ok, true)
  assert.equal(resultOf({ isError: false, content: [{ type: 'text', text: 'done' }] }).text, 'done')
  assert.equal(resultOf({ isError: true, content: [{ type: 'text', text: '炸了' }] }).ok, false)
  assert.match(resultOf({ isError: true, content: [{ type: 'text', text: '炸了' }] }).text, /炸了/)
  // 旧拼法留作兼容(离线电池 / 别的宿主形状)
  assert.equal(resultOf({ ok: true, content: [{ type: 'text', text: 'done' }] }).ok, true)
  assert.equal(resultOf({ error: 'boom' }).ok, false)
  assert.match(resultOf({ error: 'boom' }).text, /boom/)
  assert.equal(resultOf({}).ok, null, '说不清就 null,不假装成功')
})

test('结果:isError 权威 —— 它和 ok 打架时听宿主的', () => {
  assert.equal(resultOf({ isError: true, ok: true }).ok, false)
  assert.equal(resultOf({ isError: false, ok: false }).ok, true)
})

// ---- 审计器本体 ------------------------------------------------------------

test('挂上后:原样交回 next() 的结果(观察者不许改别人的结果)', async () => {
  const ctx = fakeCtx()
  const store = fakeStore()
  const a = createToolAudit({ store })
  a.attach(ctx)
  const decision = { kind: 'allow', token: Symbol('same-object') }
  const seen = []
  const out = await ctx.listeners.get('tools/post-execute')(execOf('run', { cmd: 'ls' }), { isError: false, content: [{ type: 'text', text: 'done' }] }, async () => {
    seen.push('next')
    return decision
  })
  assert.equal(out, decision, '同一个对象交回去')
  assert.deepEqual(seen, ['next'])
  assert.equal(store.rows.length, 1)
  assert.equal(store.rows[0].toolCall, 'run')
  assert.match(store.rows[0].userInput, /\(工具\) run/)
  assert.match(store.rows[0].llmReply, /^ok/)
})

test('电源关 ⇒ 不记(计入 skippedPower,不是悄悄丢)', () => {
  const store = fakeStore()
  const a = createToolAudit({ store, isEnabled: () => false })
  assert.equal(a.record(execOf('run'), { ok: true }), 'skip:power')
  assert.equal(store.rows.length, 0)
  assert.equal(a.stats().skippedPower, 1)
  assert.equal(a.stats().seen, 1, '看见过它,只是没记 —— 两个数都要有')
})

test('会话射程外 ⇒ 不记(工作会话不是她的现场)', () => {
  const store = fakeStore()
  const a = createToolAudit({ store, sessionEnabledOf: () => false })
  assert.equal(a.record(execOf('run', {}, 'work-1'), { ok: true }), 'skip:scope')
  assert.equal(store.rows.length, 0)
  assert.equal(a.stats().skippedScope, 1)
})

test('自家 echo_* 工具不重复记(它们自己写过更全的审计),但也计数', () => {
  const store = fakeStore()
  const a = createToolAudit({ store })
  assert.equal(a.record(execOf('echo_remember'), { ok: true }), 'skip:own')
  assert.equal(store.rows.length, 0)
  assert.equal(a.stats().ownSkipped, 1)
})

test('写库炸了 ⇒ 不抛、计入 failed、只 warn 一次', () => {
  let warned = 0
  const a = createToolAudit({
    store: { writeAudit () { throw new Error('库锁着') } },
    logger: { warn () { warned += 1 } }
  })
  assert.equal(a.record(execOf('run'), { ok: true }), 'fail:write')
  assert.equal(a.record(execOf('run'), { ok: true }), 'fail:write')
  assert.equal(a.stats().failed, 2)
  assert.equal(warned, 1, '重复故障只留一行,别刷屏')
})

test('宿主真形状:失败的一步在审计里记 failed,不许记成 ok(2026 审计 P1)', () => {
  const store = fakeStore()
  const a = createToolAudit({ store })
  a.record(execOf('run', { cmd: 'ls' }), { isError: true, content: [{ type: 'text', text: '炸了' }] })
  a.record(execOf('run', { cmd: 'pwd' }), { isError: false, content: [{ type: 'text', text: 'done' }] })
  assert.match(store.rows[0].llmReply, /^failed/)
  assert.match(store.rows[1].llmReply, /^ok/)
})

test('库不在 ⇒ 也计入 failed(不静默)', () => {
  const a = createToolAudit({ store: null })
  assert.equal(a.record(execOf('run'), { ok: true }), 'fail:nostore')
  assert.equal(a.stats().failed, 1)
})

test('ctx 没有 on(老宿主/替身)⇒ 空挂载,不抛,留一行 info', () => {
  let info = 0
  const a = createToolAudit({ store: fakeStore(), logger: { info () { info += 1 } } })
  assert.doesNotThrow(() => a.attach({}))
  assert.doesNotThrow(() => a.attach(null))
  assert.equal(info, 2)
})

test('统计:按名字计数,面板能说"她调了什么、几次"', () => {
  const a = createToolAudit({ store: fakeStore(), now: () => 42 })
  a.record(execOf('read_file'), { ok: true })
  a.record(execOf('read_file'), { ok: true })
  a.record(execOf('bash'), { ok: true })
  const s = a.stats()
  assert.equal(s.seen, 3)
  assert.equal(s.written, 3)
  assert.deepEqual(s.byName, { read_file: 2, bash: 1 })
  assert.equal(s.at, 42)
})

// ---- v0.40.0 C2:本轮工具计数(思考风格双档的判据)---------------------------

test('C2:本轮用过几件宿主工具 —— 换轮归零,射程外/她睡着/自家工具都不算', () => {
  const a = createToolAudit({ store: fakeStore() })
  assert.equal(a.turnTools('sess-1'), 0, '刚换轮 ⇒ 0')

  a.record(execOf('read_file'), { ok: true })
  a.record(execOf('bash'), { ok: true })
  assert.equal(a.turnTools('sess-1'), 2)
  assert.equal(a.turnTools('sess-2'), 0, '按会话分开数')

  // 她自己的工具是**说话**不是干活 ⇒ 不计(她调 echo_qq_say 不该把她切到中性档)
  a.record(execOf('echo_qq_say'), { ok: true })
  assert.equal(a.turnTools('sess-1'), 2)

  // 换轮(他开口)⇒ 归零
  a.turnReset('sess-1')
  assert.equal(a.turnTools('sess-1'), 0)
  assert.equal(a.turnTools('sess-2'), 0)

  // 写库失败的那条**也要算** —— "她确实动过手"是事实,不该被写库失败抹掉
  const broken = createToolAudit({ store: { writeAudit () { throw new Error('库坏了') } } })
  broken.record(execOf('bash'), { ok: true })
  assert.equal(broken.turnTools('sess-1'), 1)

  // 射程外的会话:不进账也不计数
  const scoped = createToolAudit({ store: fakeStore(), sessionEnabledOf: () => false })
  scoped.record(execOf('bash'), { ok: true })
  assert.equal(scoped.turnTools('sess-1'), 0)
  assert.equal(scoped.stats().skippedScope, 1)

  // 她整个睡着(电源闸)⇒ 不计数
  const off = createToolAudit({ store: fakeStore(), isEnabled: () => false })
  off.record(execOf('bash'), { ok: true })
  assert.equal(off.turnTools('sess-1'), 0)
})
