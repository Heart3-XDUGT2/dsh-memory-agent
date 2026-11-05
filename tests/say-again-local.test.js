/**
 * P2(2026-10-05 拍板 4):余波(say_again)取消自动 QQ 路由。
 *
 * 事故形状(修之前):余波是壳在轮末替她端上来的注入(2~5 秒后那条),
 * 因为 `say_again` 在 `relay.js` 的 `VOICE_FORMS` 白名单里,整轮被盖上
 * 「她起的头」⇒ relay 的主动分支在**本地 DSH 会话没绑渠道**时退到全库兜底,
 * 把那半句话自动推到了 QQ —— 她没调任何 skill,是**系统**替她决定发的。
 *
 * 这一套钉三件事:
 *   ① 余波轮(`proactive:false` / `kind:undefined`)在本地会话上**不入队**;
 *      对照组证明"同一条走主动分支就会入队"—— 那就是被修掉的那条路。
 *   ② 关怀/提醒/闹钟(care/reminder/wake)**照旧**自动发:那是她"该提醒阿岚"的
 *      主动行为,不是被系统替她决定,不许被这次改动连坐。
 *   ③ 副作用的钉子:余波轮里她若用 `echo_qq_say` 显式发话,会被记成 `reply`
 *      而不是 `proactive`(壳不再 `markProactive`)—— 只影响"主动待兑现账"
 *      (`noteProactiveAcked`),**不影响投递本身**。
 * 外加两条守卫(源码级):壳真的这么接;relay 的逻辑**一字未动**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isolateTestHome, assertHomeIsolated } from './fixtures/test-home.js'

// 2026-10-10 测试隔离加固:先隔离 `DSH_HOME`,再**动态** import 库模块。
// 本文件调 `handleInbound()`,而 `lib/relay.js:457-462` 在活配置
// `settings.newSessionOn[qq] === true` 时会调 `setSessionOn` ⇒ `writeConfig()`
// ⇒ 写真机 config.json(实测:单跑本文件会刷新活配置的 `savedAt`)。
// 顺序是硬约束(toggle.js 的 CONFIG_PATH 是模块级常量),配套自检见 test-home.js。
isolateTestHome()
const { CONFIG_PATH } = await import('../lib/toggle.js')
assertHomeIsolated(CONFIG_PATH)
const { openStore } = await import('../lib/store.js')
const { createRelay, isVoiceForm, marksProactive } = await import('../lib/relay.js')

const SID = 'session-echo-companion'
/** 她当时正在用的那条**本地 DSH 会话**(没绑任何平台聊天)。 */
const WEB = 'session-a165b0d0-6055-4539-95ea-d4ec3cbb282a'
const QQ = { platform: 'qq', chatId: '<your-qq>' }
/** 本地会话里她说的那半句(余波正文)。 */
const HALF = '……其实我刚才还有半句没说完。'

/** 内存库 + 假壳;全库有一条 QQ 私聊主渠道,而**会话自己一条都没绑**。 */
function makeBridge (opts = {}) {
  const store = openStore(':memory:')
  const relay = createRelay({
    store,
    logger: { info: () => { }, warn: () => { } },
    config: () => ({
      sessionId: SID,
      permissionPreset: 'read-only',
      proactiveScope: opts.proactiveScope ?? 'private',
      pushLocalTurns: opts.pushLocalTurns === true, // 产品默认:关
      autoReplyToOrigin: opts.autoReplyToOrigin === true, // 产品默认:关
      outboxLeaseSec: 30,
      replyMaxChars: 500,
      proactiveTtlSec: 300,
      proactiveMaxChars: 120,
      token: 'SECRET-TOKEN-1'
    }),
    isEnabled: () => opts.enabled !== false,
    ensureCompanion: async () => ({ agent: { session: { id: SID } }, sessionId: SID, via: 'companion' }),
    injectInbound: async () => 'ok',
    applyPermission: () => 'applied:read-only',
    audit: () => { },
    labelSession: () => { },
    now: () => 1_000_000
  })
  relay.setChannel({ ...QQ, isPrimary: true })
  return {
    store,
    relay,
    rows: () => store.relayLeaseOutbox({ platform: 'qq', limit: 10, now: 1_000_001 }).items
  }
}

/**
 * 夹具先"吃掉来路":`origin` 是入站登记的,不清掉的话每一轮都像"刚被某个聊天搭话"
 * (那样连"她主动开口"都算不上)—— relay.test.js 的 `bridgeWithChannel` 同款做法。
 */
async function bridgeWithChannel () {
  const b = makeBridge()
  await b.relay.handleInbound({
    v: 1,
    platform: 'qq',
    chat: { id: QQ.chatId, type: 'private' },
    sender: { id: QQ.chatId, name: '阿岚', isMaster: true },
    text: '在吗',
    msgId: 'p2-1'
  })
  b.relay.finishTurn(SID) // 空轮:只用来吃掉来路
  return b
}

// ------------------------------------------------------- ① 余波不再自动到 QQ

test('① 余波轮在无渠道的本地会话上不入队(QQ 收不到那半句话)', async () => {
  const b = await bridgeWithChannel()
  b.relay.captureSegment(WEB, HALF)
  // 壳对余波的传参(拍板 4 的技术做法):proactive:false + kind:undefined
  const r = b.relay.finishTurn(WEB, { proactive: false, kind: undefined })
  assert.equal(r.queued, 0, '走"本地轮次"分支 ⇒ 不入队')
  assert.equal(b.rows().length, 0, 'QQ 队列里一个字都不许有')
})

test('① 对照(负控制):同一条若走主动分支,就会经全库兜底落到 QQ —— 这就是修掉的那条路', async () => {
  const b = await bridgeWithChannel()
  b.relay.captureSegment(WEB, HALF)
  const r = b.relay.finishTurn(WEB, { proactive: true, kind: 'proactive' })
  assert.equal(r.queued, 1, '主动分支不看会话绑没绑渠道')
  assert.equal(r.scope, 'global', '本地会话没绑渠道 ⇒ 退到全库兜底(事故的那一跳)')
  // ⚠️ 租约是**一次性的**(同一刻再租拿不到:行已被上一次租约拿走),所以只租一次再断言。
  const out = b.rows()
  assert.equal(out.length, 1)
  assert.equal(out[0].chatId, QQ.chatId)
  assert.equal(out[0].kind, 'proactive')
})

test('① 余波轮连"全库也没有渠道"时同样安静(不抛、不发明队列)', async () => {
  const store = openStore(':memory:')
  const relay = createRelay({
    store,
    logger: { info: () => { }, warn: () => { } },
    config: () => ({
      sessionId: SID, permissionPreset: 'read-only', proactiveScope: 'private',
      pushLocalTurns: false, autoReplyToOrigin: false, outboxLeaseSec: 30,
      replyMaxChars: 500, proactiveTtlSec: 300, proactiveMaxChars: 120, token: 'T'
    }),
    isEnabled: () => true,
    ensureCompanion: async () => ({ agent: { session: { id: SID } }, sessionId: SID, via: 'companion' }),
    injectInbound: async () => 'ok',
    applyPermission: () => 'read-only',
    now: () => 1_000_000
  })
  relay.captureSegment(WEB, HALF)
  assert.equal(relay.finishTurn(WEB, { proactive: false, kind: undefined }).queued, 0)
  assert.equal(store.relayLeaseOutbox({ platform: 'qq', limit: 10, now: 1_000_001 }).items.length, 0)
})

// ------------------------------------------------- ② 关怀/提醒/闹钟不许被连坐

test('② 回归:关怀照旧自动发到她够得到的地方(kind 如实落 proactive)', async () => {
  const b = await bridgeWithChannel()
  b.relay.captureSegment(WEB, '醒了没。记得吃饭。')
  const r = b.relay.finishTurn(WEB, { proactive: true, kind: 'proactive' })
  assert.equal(r.queued, 1, '她该提醒阿岚的话,照旧自动送')
  assert.equal(b.rows()[0].kind, 'proactive')
})

test('② 回归:提醒/闹钟照旧自动发,而且 kind 归一成 reminder', async () => {
  const b = await bridgeWithChannel()
  b.relay.captureSegment(WEB, '到点了,该吃药了。')
  const r = b.relay.finishTurn(WEB, { proactive: true, kind: 'reminder' })
  assert.equal(r.queued, 1)
  assert.equal(b.rows()[0].kind, 'reminder', '提醒/闹钟在出站口是 reminder(面板/审计靠它区分)')
})

test('② 回归:本地对话轮(pushLocalTurns 默认 false)照旧不回推 —— 这次改动没动那道闸', async () => {
  const b = await bridgeWithChannel()
  b.relay.captureSegment(WEB, '我在,你说。')
  assert.equal(b.relay.finishTurn(WEB, { proactive: false }).queued, 0)
  // 开关打开时才回推(证明闸本身还在,只是这次不碰它)
  const on = makeBridge({ pushLocalTurns: true })
  await on.relay.handleInbound({
    v: 1, platform: 'qq', chat: { id: QQ.chatId, type: 'private' },
    sender: { id: QQ.chatId, name: '阿岚', isMaster: true }, text: '在吗', msgId: 'p2-2'
  })
  on.relay.finishTurn(SID)
  on.relay.captureSegment(WEB, '我在,你说。')
  assert.equal(on.relay.finishTurn(WEB, { proactive: false }).queued, 1)
})

// --------------------------------------------- ③ 副作用钉子(影响面确认可接受)

test('③ 副作用:余波轮里她用手显式发话 ⇒ 记成 reply(投递照旧,只是不再记主动)', async () => {
  const b = await bridgeWithChannel()
  // 余波轮:壳**不** markProactive(拍板 4)⇒ say() 认不出"她起的头"
  const r = b.relay.say({ sessionId: SID, text: HALF })
  assert.equal(r.ok, true, '手说的那句照样送得出去 —— 投递本身不受影响')
  assert.equal(r.kind, 'reply', '代价:这一行不再是 proactive')
  const rows = b.relay.lease({ platform: 'qq', limit: 5 }).items
  assert.equal(rows.length, 1, '她显式发的东西必须真的到 QQ(这就是"她想用就用")')
  assert.equal(rows[0].kind, 'reply')
})

test('③ 对照:关怀/提醒轮她用手发话 ⇒ 仍是 proactive(markProactive 的既有作用不动)', async () => {
  const b = await bridgeWithChannel()
  b.relay.markProactive(SID) // 只有非余波的"她开口"轮才打这个标
  const r = b.relay.say({ sessionId: SID, text: '傍晚了——想你了,就这一句。' })
  assert.equal(r.kind, 'proactive')
})

// --------------------------------------------------------------- 接线/红线守卫

test('接线守卫:壳对 say_again 只置 sayAgainLocal,主动章与 kind 都不盖(源码级)', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /if \(srcForm === 'say_again'\) \{\s*cap\.sayAgainLocal = true/,
    'say_again 分支只允许置"只本地"标记')
  const iSay = src.indexOf("if (srcForm === 'say_again') {")
  const iMark = src.indexOf('speaker?.markProactive?.(')
  assert.ok(iSay > 0, 'say_again 例外分支必须在')
  assert.ok(iMark > iSay, 'markProactive 只能出现在非余波分支里')
  assert.match(src.slice(iSay, iMark), /\} else \{/,
    '结构守卫:markProactive 与 cap.proactiveKind 必须落在 else 分支内')
  assert.match(src, /const sayAgainLocal = capture\.sayAgainLocal === true/)
  assert.match(src, /proactive: capture\.proactive === true && !sayAgainLocal/,
    'finishTurn 必须对余波轮传 proactive:false')
  // 哨兵照旧:余波轮在对话窗口里仍记"她主动开口"(不然反思里会多一行空「阿岚:」)
  assert.match(src, /if \(capture\.proactive && !capture\.userText\) capture\.userText = PROACTIVE_ROUND_MARKER/)
  // 标记只在本轮有效
  assert.match(src, /capture\.proactive = false[\s\S]{0,120}?capture\.sayAgainLocal = false/)
})

test('红线守卫:relay.js 的白名单逻辑一字未动(say_again 仍在,只是不再被自动路由)', () => {
  assert.equal(isVoiceForm('say_again'), true, '白名单是红线:这次没动它')
  assert.equal(marksProactive({ kind: 'plugin', plugin: 'dsh-echo', form: 'say_again' }), true,
    '判据照旧为真 —— 变的是壳的出站传参,不是 relay 的逻辑')
  assert.equal(marksProactive({ kind: 'plugin', plugin: 'dsh-echo', form: 'care' }), true)
  assert.equal(marksProactive({ kind: 'plugin', plugin: 'dsh-echo', form: 'snapshot' }), false)
  assert.equal(isVoiceForm('以后新加的什么 form'), false)
})
