/**
 * v0.21.0 E5:情绪余波 say_again 的电池。
 *
 * 这一族的价值全在**时序**上:延迟挂起、只留最后一次、用户开口即撤、
 * 定时器醒来的那一瞬还要再核一次序号(竞态)。所以这里用**注入的假定时器**
 * 把时间捏在手里 —— 不靠真实 sleep,也不靠运气。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore, MASTER_ID } from '../lib/store.js'
import {
  createSayAgain, shouldSayAgain, extraReplyText, renderSayAgainLine,
  DEFAULT_MIN_DELAY_MS, DEFAULT_MAX_DELAY_MS, EXTRA_REPLY_MAX_CHARS
} from '../lib/say-again.js'

/** 假定时器:手动把时间推过去。 */
function fakeClock () {
  let seq = 0
  const timers = new Map()
  return {
    setTimer (fn, ms) { const id = ++seq; timers.set(id, { fn, ms }); return id },
    clearTimer (id) { timers.delete(id) },
    live () { return timers.size },
    /** 触发所有到期的定时器(按注册顺序)。 */
    async runAll () {
      const all = [...timers.entries()]
      timers.clear()
      for (const [, t] of all) await t.fn()
    },
    msOf () { return [...timers.values()].map((t) => t.ms) }
  }
}

function harness (opts = {}) {
  const clock = fakeClock()
  const delivered = []
  const audits = []
  const logs = []
  const agent = { id: 'agent-1' }
  const sched = createSayAgain({
    logger: { info: (m) => logs.push('info:' + m), warn: (m) => logs.push('warn:' + m) },
    deliver: async (a, text, queryText, form) => {
      delivered.push({ agent: a, text, queryText, form })
      return opts.deliverOk === undefined ? true : opts.deliverOk
    },
    writeAudit: (row) => audits.push(row),
    isEnabled: opts.isEnabled ?? (() => true),
    isSessionEnabled: opts.isSessionEnabled ?? (() => true),
    settingsOf: opts.settingsOf ?? (() => ({ minDelayMs: 2000, maxDelayMs: 5000 })),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    random: () => 0.5, now: () => 1790361736000
  })
  return { sched, clock, delivered, audits, logs, agent }
}

test('纯判定:只有 say_again=1 且台词非空才挂', () => {
  assert.equal(shouldSayAgain({ sayAgain: 1, extraReply: '还想说' }).fire, true)
  assert.equal(shouldSayAgain({ sayAgain: 0, extraReply: '还想说' }).reason, 'judge-said-no')
  assert.equal(shouldSayAgain({ sayAgain: 1, extraReply: '   ' }).reason, 'empty-extra-reply')
  assert.equal(shouldSayAgain({ sayAgain: 1, extraReply: 'x', enabled: false }).reason, 'disabled')
  assert.equal(shouldSayAgain({ sayAgain: 1, extraReply: 'x', sessionEnabled: false }).reason, 'session-off')
})

test('台词规整:空白压平、裁到 80 字、非字符串当空', () => {
  assert.equal(extraReplyText('  还想   说一句 '), '还想 说一句')
  assert.equal(extraReplyText(null), '')
  assert.equal(extraReplyText(undefined), '')
  assert.equal(extraReplyText(42), '')
  assert.equal(extraReplyText('啊'.repeat(200)).length, EXTRA_REPLY_MAX_CHARS)
})

test('信封:台词原样给出,但明说别复述别解释(与【你刚才被插嘴了】同族)', () => {
  const line = renderSayAgainLine('还想赖着你一会儿')
  assert.ok(line.includes('还想赖着你一会儿'))
  assert.ok(line.includes('情绪余波'))
  assert.ok(line.includes('不要复述上文'))
})

test('挂起到点后送达:走她自己的嘴(form=say_again),并留一行审计', async () => {
  const h = harness()
  const r = h.sched.schedule({ agent: h.agent, sessionId: 's1', sayAgain: 1, extraReply: '还想赖着你', traceId: 't1' })
  assert.equal(r.scheduled, true)
  assert.equal(r.delayMs, 3500, 'random=0.5 ⇒ (2+5)/2 秒')
  assert.equal(h.clock.live(), 1)
  assert.equal(h.delivered.length, 0, '还没到点,不许提前发')
  await h.clock.runAll()
  assert.equal(h.delivered.length, 1)
  assert.equal(h.delivered[0].form, 'say_again')
  assert.equal(h.delivered[0].queryText, '还想赖着你', '检索词就是那句台词')
  assert.ok(h.delivered[0].text.includes('还想赖着你'))
  assert.equal(h.audits.length, 1)
  assert.equal(h.audits[0].toolCall, 'say_again')
  assert.equal(h.audits[0].sayAgain, 1)
  assert.equal(h.audits[0].extraReply, '还想赖着你')
  assert.equal(h.audits[0].sessionId, 's1')
})

test('用户开口 = 抢话 ⇒ 立刻撤回,到点也不发(A 的 _cancel_pending_say)', async () => {
  const h = harness()
  h.sched.schedule({ agent: h.agent, sessionId: 's1', sayAgain: 1, extraReply: '补一句' })
  assert.equal(h.sched.pendingCount(), 1)
  h.sched.bump('s1')
  assert.equal(h.sched.pendingCount(), 0, '撤回后不该还有挂起的')
  assert.equal(h.clock.live(), 0, '定时器要真清掉,别留着空转')
  await h.clock.runAll()
  assert.equal(h.delivered.length, 0)
  assert.ok(h.logs.some((l) => l.includes('撤回未发出')))
})

test('竞态边界:序号只在投递**之前**核 —— 核过之后他再开口拦不住这一句(与 A 同)', async () => {
  // A `_say_again_after` 的形状:先 await(气泡+延迟)→ 核 seq → send。
  // 所以它拦得住"**延迟期间**他开口",拦不住"核完之后、send 那一瞬他开口"
  // —— 那个窗口在原实现里同样存在(而且只有毫秒级)。这里把边界钉住,
  // 免得以后有人以为它拦得比实际更多。
  const clock = fakeClock()
  const delivered = []
  let release = null
  const gate = new Promise((res) => { release = res })
  const sched = createSayAgain({
    deliver: async (a, text) => { await gate; delivered.push(text); return true },
    settingsOf: () => ({ minDelayMs: 0, maxDelayMs: 0 }),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer
  })
  sched.schedule({ agent: {}, sessionId: 's1', sayAgain: 1, extraReply: '半句' })
  const running = clock.runAll() // 进到 deliver(序号已核过,被 gate 挡住)
  sched.bump('s1') // ← 此刻他开口:已经晚了
  release()
  await running
  assert.equal(delivered.length, 1)
  assert.equal(sched.seqOf('s1'), 1, '序号确实 +1 了 —— 他没有抢到这一句')
})

test('延迟期间他开口(真正的抢话窗口)⇒ 一个字都不发', async () => {
  const clock = fakeClock()
  const delivered = []
  const sched = createSayAgain({
    deliver: async (a, text) => { delivered.push(text); return true },
    settingsOf: () => ({ minDelayMs: 3000, maxDelayMs: 3000 }),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer
  })
  sched.schedule({ agent: {}, sessionId: 's1', sayAgain: 1, extraReply: '半句' })
  sched.bump('s1') // 3 秒还没到
  await clock.runAll()
  assert.equal(delivered.length, 0)
  assert.equal(clock.live(), 0)
})

test('同一会话只留最后一次(新的顶掉旧的)', async () => {
  const h = harness()
  h.sched.schedule({ agent: h.agent, sessionId: 's1', sayAgain: 1, extraReply: '第一句' })
  h.sched.schedule({ agent: h.agent, sessionId: 's1', sayAgain: 1, extraReply: '第二句' })
  assert.equal(h.sched.pendingCount(), 1)
  assert.equal(h.clock.live(), 1, '被顶掉的那个定时器必须真清掉,不许漏一个空转的')
  await h.clock.runAll()
  assert.equal(h.delivered.length, 1)
  assert.ok(h.delivered[0].text.includes('第二句'))
})

test('不同会话各挂各的,互不顶替', async () => {
  const h = harness()
  h.sched.schedule({ agent: h.agent, sessionId: 's1', sayAgain: 1, extraReply: 'A 会话' })
  h.sched.schedule({ agent: h.agent, sessionId: 's2', sayAgain: 1, extraReply: 'B 会话' })
  assert.equal(h.sched.pendingCount(), 2)
  h.sched.bump('s1') // 只在 A 会话抢话
  await h.clock.runAll()
  assert.equal(h.delivered.length, 1)
  assert.ok(h.delivered[0].text.includes('B 会话'))
})

test('开关:总闸关 / 会话范围外 / 台词空 —— 都不挂', () => {
  assert.equal(harness({ isEnabled: () => false }).sched
    .schedule({ sessionId: 's1', sayAgain: 1, extraReply: 'x' }).reason, 'disabled')
  assert.equal(harness({ isSessionEnabled: () => false }).sched
    .schedule({ sessionId: 's1', sayAgain: 1, extraReply: 'x' }).reason, 'session-off')
  const h = harness()
  assert.equal(h.sched.schedule({ sessionId: 's1', sayAgain: 1, extraReply: '' }).reason, 'empty-extra-reply')
  assert.ok(h.logs.some((l) => l.includes('extra_reply 为空')), 'A 也显式记一条,不静默')
})

test('没有投递通道(agent 缺席)时不静默:警告 + 不挂', () => {
  const h = harness()
  const r = h.sched.schedule({ agent: null, sessionId: 's1', sayAgain: 1, extraReply: 'x' })
  assert.equal(r.reason, 'no-channel')
  assert.equal(h.sched.pendingCount(), 0)
  assert.ok(h.logs.some((l) => l.includes('没有投递通道')))
})

test('投递失败:审计记 say_again_failed,不重试', async () => {
  const h = harness({ deliverOk: false })
  h.sched.schedule({ agent: h.agent, sessionId: 's1', sayAgain: 1, extraReply: '没送出去' })
  await h.clock.runAll()
  assert.equal(h.audits.length, 1)
  assert.equal(h.audits[0].toolCall, 'say_again_failed')
  assert.equal(h.clock.live(), 0, '不重试')
})

test('投递抛异常:吞掉(她还在聊,不能因为余波把她这一轮搞砸)', async () => {
  const clock = fakeClock()
  const sched = createSayAgain({
    deliver: async () => { throw new Error('boom') },
    settingsOf: () => ({ minDelayMs: 0, maxDelayMs: 0 }),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer
  })
  sched.schedule({ agent: {}, sessionId: 's1', sayAgain: 1, extraReply: 'x' })
  await clock.runAll() // 不抛 = 通过
})

test('审计写失败不影响投递(两个 try 分开)', async () => {
  const clock = fakeClock()
  const delivered = []
  const sched = createSayAgain({
    deliver: async (a, t) => { delivered.push(t); return true },
    writeAudit: () => { throw new Error('audit down') },
    settingsOf: () => ({ minDelayMs: 0, maxDelayMs: 0 }),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer
  })
  sched.schedule({ agent: {}, sessionId: 's1', sayAgain: 1, extraReply: 'x' })
  await clock.runAll()
  assert.equal(delivered.length, 1)
})

test('dispose 清干净:不留悬空定时器(关插件不留尾巴)', () => {
  const h = harness()
  h.sched.schedule({ agent: h.agent, sessionId: 's1', sayAgain: 1, extraReply: 'x' })
  h.sched.schedule({ agent: h.agent, sessionId: 's2', sayAgain: 1, extraReply: 'y' })
  h.sched.dispose()
  assert.equal(h.sched.pendingCount(), 0)
  assert.equal(h.clock.live(), 0)
})

test('延迟来自面板设置(秒 → 毫秒)', () => {
  const h = harness({ settingsOf: () => ({ minDelayMs: 1000, maxDelayMs: 1000 }) })
  const r = h.sched.schedule({ agent: h.agent, sessionId: 's1', sayAgain: 1, extraReply: 'x' })
  assert.equal(r.delayMs, 1000)
})

test('面板给了坏值(负 / max<min)不乱来:回默认区间', () => {
  const h = harness({ settingsOf: () => ({ minDelayMs: -5, maxDelayMs: NaN }) })
  const r = h.sched.schedule({ agent: h.agent, sessionId: 's1', sayAgain: 1, extraReply: 'x' })
  assert.ok(r.delayMs >= DEFAULT_MIN_DELAY_MS && r.delayMs <= DEFAULT_MAX_DELAY_MS)
})

// ---- 审计列:这一族以前"结构性留 NULL",现在有真写入端 ----

test('审计:说过的余波能读回来;没这机制的那一轮仍是 NULL(不编 0)', () => {
  const store = openStore(':memory:')
  store.db.prepare("INSERT INTO user_profile (user_id, name) VALUES (?, '阿岚')").run(MASTER_ID)
  try {
    store.writeAudit({ traceId: 'sa-1', sessionId: 's1', userInput: '(情绪余波)',
      toolCall: 'say_again', sayAgain: 1, extraReply: '还想赖着你一会儿' })
    store.writeAudit({ traceId: 'old-1', sessionId: 's1', userInput: '老行', toolCall: 'extract' })
    const rows = store.listAudit(0, 10)
    const sa = rows.find((r) => r.traceId === 'sa-1')
    const old = rows.find((r) => r.traceId === 'old-1')
    assert.equal(Number(sa.sayAgain), 1)
    assert.equal(sa.extraReply, '还想赖着你一会儿')
    assert.equal(old.sayAgain, null, '没传就是 NULL —— 那一版确实没这机制,不编 0')
    assert.equal(old.extraReply, null)
  } finally {
    store.close()
  }
})
