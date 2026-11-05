/**
 * v0.19.0 D2:轮末硬保证(「想念该说没说」)的行为电池。
 *
 * 挂点的血泪(参考实现 dsh-roleplay 的注释原文):
 *   > 这个钩子在轮**内部**运行,任何抛错都会**炸掉整轮**
 *   > 「丢的是转向是降级,丢的是整轮是丢用户的回复」。
 * ⇒ 本文件里"steer 抛错"与"createUserMessage 抛错"两条是核心用例:
 *   它们必须**不抛**,而且要留痕。
 *
 * 依赖全注入(不 import 宿主包)⇒ 离线可测;假 agent 只记 steer 收到的消息。
 *
 * v0.32.0 P2-A(2026-10-06)追加:渠道闸 —— 「补一句」只在**平台轮**补,
 * DSH 直聊轮不补(否则界面上多出"自言自语",heart-tts 还会把它当抢话)。
 * 见本文件末尾的 P2-A 一组用例。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// ⚠️ 隔离地板(2026-10-05 P3 B1 #3):judgment 的**默认**标记表会走称呼兜底
// (`store.getProfile().name` ⇒ `resolveDbPath()`),不隔离就会读到**真机库**。
// 与 toggle.test.js / heartbeat.test.js 同一条疤:先指 DSH_HOME,再**动态** import
// 库模块(静态 import 先于本行执行 —— tests/fixtures/test-home.js:17-21)。
import { isolateTestHome } from './fixtures/test-home.js'
isolateTestHome()
const {
  shouldSteerLonging, createTurnStopper, nudgeText, LONGING_SAID_MARKERS, longingMarkersOf
} = await import('../lib/turn-stopping.js')

/** 引擎 longing_message_result 的形状(含 v0.19.0 的 threshold/due)。 */
const read = (value = 7.4, threshold = 7.0, extra = {}) => ({
  pre: { exists: true, value, threshold, due: value >= threshold, sinceMessage: 21600, ...extra },
  post: { exists: true, value: Math.max(0, value - 4), threshold, sinceMessage: 0 }
})

function fakeAgent (sessionId = 's1') {
  return {
    session: { id: sessionId },
    steers: [],
    steer (msg) { this.steers.push(msg) }
  }
}

function makeStopper (over = {}) {
  const audits = []
  const warns = []
  const infos = []
  const stopper = createTurnStopper({
    logger: { info: (m) => infos.push(String(m)), warn: (m) => warns.push(String(m)) },
    createUserMessage: (o) => o,
    writeAudit: (row) => audits.push(row),
    ...over
  })
  return { stopper, audits, warns, infos }
}

// ---- 纯判定 ----

test('判定:到阈值却没说过 → 该 steer', () => {
  const v = shouldSteerLonging({ longingRead: read(7.4), said: '嗯,我回来了。' })
  assert.equal(v.steer, true)
  assert.equal(v.reason, 'due-and-unsaid')
  assert.equal(v.value, 7.4)
  assert.equal(v.threshold, 7.0)
})

test('判定:她这轮说过了 → 不 steer(词面命中)', () => {
  // 称呼类标记(「想{称呼}」)另有用例:程序里零真称呼,见「标记表:结构词根 + 称呼模板」。
  for (const said of ['我也想你', '今天一直在等你回来', '有点惦记你']) {
    const v = shouldSteerLonging({ longingRead: read(9.0), said })
    assert.equal(v.steer, false, said + ' 应该算说过')
    assert.equal(v.reason, 'already-said')
  }
})

test('判定:没过阈值 → 不 steer(2026-09-27 live 值 4.23 就属于这种)', () => {
  const v = shouldSteerLonging({ longingRead: read(4.233), said: '在忙什么' })
  assert.equal(v.steer, false)
  assert.equal(v.reason, 'below-threshold')
})

test('判定:从没聊过 → 不 steer(她不会想念一个没说过话的人)', () => {
  const v = shouldSteerLonging({
    longingRead: { pre: { exists: false, value: 0, threshold: 7.0, due: false } }
  })
  assert.equal(v.steer, false)
  assert.equal(v.reason, 'never-talked')
})

test('判定:这一轮已经 steer 过 → 不 steer(每轮至多一次)', () => {
  const v = shouldSteerLonging({ longingRead: read(9), said: '', alreadySteered: true })
  assert.equal(v.steer, false)
  assert.equal(v.reason, 'already-steered')
})

test('判定:没有想念读(引擎不在/还没回帧)→ 不 steer,不许瞎猜', () => {
  assert.equal(shouldSteerLonging({}).reason, 'no-longing-read')
  assert.equal(shouldSteerLonging({ longingRead: null }).reason, 'no-longing-read')
  assert.equal(shouldSteerLonging({ longingRead: 'oops' }).reason, 'no-longing-read')
})

test('判定:老帧/桩帧没有 due 时退回本地比较(别让整条保证静默失效)', () => {
  const legacy = { pre: { exists: true, value: 8.0, threshold: 7.0 } }
  assert.equal(shouldSteerLonging({ longingRead: legacy, said: '' }).steer, true)
  const legacyOut = { pre: { exists: true, value: 5.0, threshold: 7.0 } }
  assert.equal(shouldSteerLonging({ longingRead: legacyOut, said: '' }).steer, false)
})

test('判定:阈值只信引擎(壳不自己算心境调制)—— 帧里给多少就是多少', () => {
  const v = shouldSteerLonging({ longingRead: read(4.6, 4.5), said: '' })
  assert.equal(v.steer, true) // 4.6 ≥ 4.5:心境调制把线压到下限时也该说
  assert.equal(v.threshold, 4.5)
})

test('指令文本:是她的话,不是机制说明书', () => {
  const t = nudgeText(7.4, 7.0)
  assert.ok(t.includes('系统指令'), '要标明这是指令,别让她以为阿岚在说这句')
  assert.ok(t.includes('7.4'), '带上数值供她把握程度')
  assert.ok(t.includes('不要说"系统"'), '明确禁止她把机制说给阿岚听')
  assert.ok(t.includes('不要解释'), '不许解释这条指令本身')
})

test('标记表:结构词根在代码里,称呼走模板/运行时代入(程序里零真称呼)', async () => {
  assert.ok(LONGING_SAID_MARKERS.includes('想你'))
  assert.ok(!LONGING_SAID_MARKERS.some((m) => m.includes('{address}')), '默认表只有词根,没有模板')
  // ① 显式称呼 ⇒ 产出「想<称呼>」「想见<称呼>」;称呼只活在注入里,不写在程序里
  const withAddr = longingMarkersOf(undefined, '阿岚')
  assert.ok(withAddr.includes('想阿岚') && withAddr.includes('想见阿岚'), '词根 + 运行时称呼')
  assert.ok(!longingMarkersOf(undefined, '').some((m) => m.includes('阿岚')), '称呼空 ⇒ 称呼类标记整条不产出')
  // ② 数据侧写模板 `想{address}` ⇒ 代入同一个称呼(模板不进代码、进数据)
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'echo-longing-'))
  mkdirSync(join(home, 'echo'), { recursive: true })
  writeFileSync(join(home, 'echo', 'lexicon.json'),
    JSON.stringify({ schemaRev: 1, longingMarkers: ['想你', '想{address}'] }), 'utf8')
  assert.deepEqual(longingMarkersOf({ DSH_HOME: home }, '阿岚'), ['想你', '想阿岚', '想见阿岚'],
    '表里的模板先代入,词根那两条随后补齐(去重)')
})

// ---- 挂点行为 ----

test('挂点:到阈值没说 → steer 一条本插件来源的消息,并留审计', async () => {
  const { stopper, audits, infos } = makeStopper()
  const agent = fakeAgent()
  const out = await stopper.handle({
    agent, turn: 3, signal: { aborted: false },
    capture: { sessionId: 's1', longingRead: read(7.4), turnText: '嗯,回来了。' }
  })
  assert.equal(out.steered, true)
  assert.equal(agent.steers.length, 1)
  const msg = agent.steers[0]
  // 2026-10-03:kind 升为"产出者自有"形状(0.2.0-rc 的 v4 格式拒绝 `kind:'plugin'`)
  assert.equal(msg.source.kind, 'plugin:dsh-echo')
  assert.equal(msg.source.plugin, undefined, '旧形状的 plugin 字段不再写')
  assert.equal(msg.source.form, 'longing-steer')
  assert.ok(msg.content[0].text.includes('系统指令'))
  assert.equal(audits.length, 1)
  assert.equal(audits[0].toolCall, 'longing_steer')
  assert.equal(audits[0].sessionId, 's1')
  assert.ok(infos.some((m) => m.includes('硬保证')))
})

test('挂点:同一轮里 turn-stopping 再被问一次 → 不再 steer(每轮至多一次)', async () => {
  const { stopper } = makeStopper()
  const agent = fakeAgent()
  const capture = { sessionId: 's1', longingRead: read(9.0), turnText: '' }
  await stopper.handle({ agent, turn: 5, capture })
  await stopper.handle({ agent, turn: 5, capture })
  await stopper.handle({ agent, turn: 5, capture })
  assert.equal(agent.steers.length, 1, '一轮里只许追一句')
  // 下一轮:记号按轮走,该说还得说
  await stopper.handle({ agent, turn: 6, capture })
  assert.equal(agent.steers.length, 2)
})

test('挂点:她这轮已经说了 → 一条都不发', async () => {
  const { stopper, audits } = makeStopper()
  const agent = fakeAgent()
  await stopper.handle({
    agent, turn: 1, capture: { sessionId: 's1', longingRead: read(9.5), turnText: '……我也想你。' }
  })
  assert.equal(agent.steers.length, 0)
  assert.equal(audits.length, 0)
})

test('挂点:轮已被中断(signal.aborted)→ 什么都不做', async () => {
  const { stopper } = makeStopper()
  const agent = fakeAgent()
  const out = await stopper.handle({
    agent, turn: 1, signal: { aborted: true },
    capture: { sessionId: 's1', longingRead: read(9.0), turnText: '' }
  })
  assert.equal(out.steer, false)
  assert.equal(out.reason, 'aborted')
  assert.equal(agent.steers.length, 0)
})

test('挂点:电源休眠 / 开关关 / 会话范围外 → 一条都不发', async () => {
  const agent = fakeAgent()
  const capture = { sessionId: 's1', longingRead: read(9.0), turnText: '' }
  const a = makeStopper({ isEnabled: () => false })
  assert.equal((await a.stopper.handle({ agent, turn: 1, capture })).reason, 'disabled')
  const b = makeStopper({ mustSayEnabled: () => false })
  assert.equal((await b.stopper.handle({ agent, turn: 1, capture })).reason, 'must-say-off')
  const c = makeStopper({ isSessionEnabled: () => false })
  assert.equal((await c.stopper.handle({ agent, turn: 1, capture })).reason, 'session-off')
  // 拿不到会话 id:也不许发(不知道往哪条会话说)
  const d = makeStopper()
  assert.equal((await d.stopper.handle({ agent: { session: { id: '' } }, turn: 1, capture })).reason, 'session-off')
  assert.equal(agent.steers.length, 0)
})

test('挂点血泪①:agent.steer 抛错 → 不冒泡(丢的是转向是降级,丢整轮是丢回复)', async () => {
  const { stopper, warns } = makeStopper()
  const agent = { session: { id: 's1' }, steer () { throw new Error('steer exploded') } }
  const out = await stopper.handle({
    agent, turn: 1, capture: { sessionId: 's1', longingRead: read(9.0), turnText: '' }
  })
  assert.equal(out.steer, false)
  assert.equal(out.reason, 'error')
  assert.ok(String(out.error).includes('steer exploded'))
  assert.ok(warns.some((m) => m.includes('降级')))
})

test('挂点血泪②:createUserMessage 抛错 → 同样不冒泡', async () => {
  const { stopper } = makeStopper({
    createUserMessage: () => { throw new Error('llm helper missing') }
  })
  const agent = fakeAgent()
  const out = await stopper.handle({
    agent, turn: 1, capture: { sessionId: 's1', longingRead: read(9.0), turnText: '' }
  })
  assert.equal(out.steer, false)
  assert.equal(out.reason, 'error')
  assert.equal(agent.steers.length, 0)
})

test('挂点:想念读是 promise(壳侧就是 fire-and-forget 的 promise)→ 等它落定', async () => {
  const { stopper } = makeStopper()
  const agent = fakeAgent()
  await stopper.handle({
    agent, turn: 2,
    capture: { sessionId: 's1', longingRead: Promise.resolve(read(7.9)), turnText: '' }
  })
  assert.equal(agent.steers.length, 1)
})

test('挂点:想念读 promise 拒绝 → 降级成"没读到",不抛不炸轮', async () => {
  const { stopper, warns } = makeStopper()
  const agent = fakeAgent()
  const out = await stopper.handle({
    agent, turn: 2,
    capture: { sessionId: 's1', longingRead: Promise.reject(new Error('engine down')), turnText: '' }
  })
  assert.equal(out.steer, false)
  assert.equal(out.reason, 'no-longing-read')
  assert.equal(agent.steers.length, 0)
  assert.equal(warns.length, 0, '引擎不在是常态,不该刷警告')
})

test('挂点:capture 缺失 / 形状怪 → 退化成不发,不抛', async () => {
  const { stopper } = makeStopper()
  const agent = fakeAgent()
  assert.equal((await stopper.handle({ agent, turn: 1 })).steer, false)
  assert.equal((await stopper.handle({ agent, turn: 1, capture: null })).steer, false)
  assert.equal((await stopper.handle({})).steer, false)
  assert.equal(agent.steers.length, 0)
})

test('挂点:审计写失败不影响 steer 已发出的事实', async () => {
  const { stopper } = makeStopper({
    writeAudit: () => { throw new Error('audit table gone') }
  })
  const agent = fakeAgent()
  const out = await stopper.handle({
    agent, turn: 4, capture: { sessionId: 's1', longingRead: read(8.0), turnText: '' }
  })
  assert.equal(out.steered, true)
  assert.equal(agent.steers.length, 1)
})

// ============================================================================
// P2-A 渠道闸(2026-10-06):轮末补一句只在**平台轮**补。
//
// 为什么:他在 DSH 里直接说话时补 ⇒ 界面上多出一条"自言自语",而且 heart-tts
// 把那条插件注入当"用户抢话",砍掉正常回复的音频
// (诊断:`Desktop/交接/DSH自言自语-bug诊断-2026-10-06.md`)。
// 判据在**纯函数**里;来源事实由壳的 capture 给(`fromPlatform`)。
// ============================================================================

test('P2-A 纯判定:直聊轮不补 / 平台轮补 / 来源未知当平台轮(fail-open)', () => {
  const on = { longingRead: read(7.4), said: '嗯,我回来了。', onlyFromPlatform: true }
  assert.equal(shouldSteerLonging({ ...on, fromPlatform: false }).steer, false)
  assert.equal(shouldSteerLonging({ ...on, fromPlatform: false }).reason, 'not-from-platform')
  assert.equal(shouldSteerLonging({ ...on, fromPlatform: true }).steer, true)
  assert.equal(shouldSteerLonging({ ...on, fromPlatform: true }).reason, 'due-and-unsaid')
  // 来源未知(轮首默认 / 宿主没给这一维)⇒ 宁可补,也不让 QQ 悄悄少补
  assert.equal(shouldSteerLonging({ ...on, fromPlatform: null }).steer, true)
  assert.equal(shouldSteerLonging(on).steer, true, '缺省 fromPlatform ⇒ 当平台轮')
  // 闸关掉 = 旧行为(任何轮都补)
  assert.equal(shouldSteerLonging({ ...on, fromPlatform: false, onlyFromPlatform: false }).steer, true)
})

test('P2-A 开关矩阵:must_say × steerOnlyFromPlatform 四种组合', async () => {
  const cases = [
    // mustSay, onlyFromPlatform, fromPlatform, 期望补?
    [true, true, true, true, '总闸开 + 平台轮 ⇒ 补'],
    [true, true, false, false, '⭐ 总闸开 + 直聊轮 ⇒ 不补(治 bug 的那一格)'],
    [true, true, null, true, '总闸开 + 来源未知 ⇒ 补(fail-open)'],
    [true, false, false, true, '子闸关 ⇒ 回到旧行为:直聊轮也补'],
    [false, true, true, false, '总闸关 ⇒ 不补(旧开关语义:任何轮都不补)'],
    [false, true, false, false, '总闸关 ⇒ 不补'],
    [false, false, true, false, '总闸关优先,子闸开不开都一样']
  ]
  for (const [mustSay, only, from, want, why] of cases) {
    const { stopper, infos } = makeStopper({
      mustSayEnabled: () => mustSay,
      steerOnlyFromPlatform: () => only
    })
    const agent = fakeAgent()
    const out = await stopper.handle({
      agent, turn: 1, capture: { sessionId: 's1', longingRead: read(9.0), turnText: '', fromPlatform: from }
    })
    assert.equal(agent.steers.length, want ? 1 : 0, why + '(must_say=' + mustSay + ', only=' + only + ', from=' + from + ')')
    assert.equal(out.steer, want, why)
    if (!want && mustSay && only && from === false) {
      assert.equal(out.reason, 'not-from-platform', '直聊轮的理由要能一眼看出是渠道闸拦的:' + why)
      assert.ok(infos.some((m) => m.includes('渠道闸')), '拦下来要留一句日志(不然现场查不到)')
    }
  }
  // 总闸的判据在子闸之前(理由优先级)
  const { stopper } = makeStopper({ mustSayEnabled: () => false, steerOnlyFromPlatform: () => true })
  const out = await stopper.handle({
    agent: fakeAgent(), turn: 1,
    capture: { sessionId: 's1', longingRead: read(9.0), turnText: '', fromPlatform: false }
  })
  assert.equal(out.reason, 'must-say-off')
})

test('P2-A 回归:只有 longing-steer 受影响 —— care/wake/say_again 是独立一轮,不走这里', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/turn-stopping.js', import.meta.url)), 'utf8')
  assert.ok(!/say_again|'care'|'wake'/.test(src), '轮末 steer 这条路上不该出现别的 form —— ' +
    '那几个走 heartbeat/say-again 自己的 followup(独立一轮),渠道闸不许碰它们')
  assert.ok(src.includes("form: 'longing-steer'"), '注入的 form 仍是这一个')
  assert.equal((src.match(/form: 'longing-steer'/g) || []).length, 1, '只有一处注入')
  // 只数**语句位置**的 steer(注释里的 `agent.steer(...)` 是文档,不算)
  assert.equal((src.match(/^\s*agent\.steer\(/gm) || []).length, 1, '全模块只许有一处真的 steer')
  assert.equal((src.match(/^\s*agent\.(followup|inject)\(/gm) || []).length, 0,
    '轮末这条路上不许出现 followup/inject —— 那是 care/wake/say_again 的路')
})

test('P2-A 接线:壳把来源记进 capture、把开关接进 stopper', () => {
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  // 来源三处:轮首默认 null / relay 标 true / 人话落 false / 轮末归零
  assert.ok(/fromPlatform: null,\n/.test(host), 'capture 里要有这一维(轮首默认)')
  assert.ok(host.includes('capture.fromPlatform = true'), 'relay 注入的人话 ⇒ 平台轮')
  assert.ok(host.includes('if (capture.fromPlatform !== true) capture.fromPlatform = false'),
    '人话 ⇒ 直聊轮,但**不许覆盖**平台轮(relay 也走这条分支)')
  assert.ok(host.includes('capture.fromPlatform = null'), '轮末归零:标记只在本轮有效')
  assert.ok(host.includes("formOf(msg?.source?.form) === FORM.INBOUND"), '平台轮的判据用 form=relay')
  assert.ok(/steerOnlyFromPlatform: \(\) => \{[\s\S]{0,160}?readSettings\(\)\.longing\?\.steerOnlyFromPlatform !== false/.test(host),
    '开关要接线:默认 true(只在平台轮补)')
  const fields = readFileSync(fileURLToPath(new URL('../lib/settings-fields.js', import.meta.url)), 'utf8')
  assert.ok(fields.includes("key: 'steerOnlyFromPlatform'"), '面板上要有这一格')
  const toggle = readFileSync(fileURLToPath(new URL('../lib/toggle.js', import.meta.url)), 'utf8')
  assert.ok(/must_say: true,\n[\s\S]{0,600}?steerOnlyFromPlatform: true\n/.test(toggle),
    'SETTINGS_DEFAULTS 默认 true = 治 bug')
  assert.ok(toggle.includes('steerOnlyFromPlatform: boolOf(rl.steerOnlyFromPlatform, d.longing.steerOnlyFromPlatform)'),
    'normalize 也要跟(不然面板拨了不生效 —— 这一科的老坑)')
})

// ============================================================================
// ★ 2026-10-15 跨轮节流:「每次都要接一句多想,话题很生硬」。
//
// 原来唯一的去重是 `steeredTurn`(sid+**turn**),而 turn 每轮都变 ⇒ 只做到
// 「同一轮至多一次」,**跨轮毫无节流** ⇒ 想念一到阈值就每轮追一句。
// 加一层按墙钟的冷却(复用面板既有项 `longing.cooldown_minutes`)。
//
// 判据在 `handle()`(带状态),**纯函数 `shouldSteerLonging` 一字未动** ——
// 上面那组 P2-A 纯判定用例仍然逐位有效。
// ============================================================================

test('跨轮节流:冷却期内不再补(第二次 handle 被拦)', async () => {
  let t = 1_000_000_000_000
  const { stopper, infos } = makeStopper({ cooldownMinutes: () => 120, now: () => t })
  const agent = fakeAgent()
  const cap = { sessionId: 's1', longingRead: read(9.0), turnText: '', fromPlatform: true }

  const a = await stopper.handle({ agent, turn: 1, capture: cap })
  assert.equal(a.steered, true, '第一次:该补')
  assert.equal(agent.steers.length, 1)

  // 30 分钟后(仍在 120 分钟冷却内)⇒ 不补
  t += 30 * 60 * 1000
  const b = await stopper.handle({ agent, turn: 2, capture: cap })
  assert.equal(b.steer, false, '冷却期内不许再补')
  assert.equal(b.reason, 'cooldown')
  assert.ok(b.cooldownLeftMin > 89 && b.cooldownLeftMin <= 90, '剩下的冷却时间要报出来:' + b.cooldownLeftMin)
  assert.equal(agent.steers.length, 1, '没有第二条 steer')
  assert.ok(infos.some((m) => m.includes('还在冷却里')), '拦下来要留一句日志')
})

test('跨轮节流:过了冷却、她仍没说 ⇒ 再补', async () => {
  let t = 1_000_000_000_000
  const { stopper } = makeStopper({ cooldownMinutes: () => 120, now: () => t })
  const agent = fakeAgent()
  const cap = { sessionId: 's1', longingRead: read(9.0), turnText: '', fromPlatform: true }

  await stopper.handle({ agent, turn: 1, capture: cap })
  assert.equal(agent.steers.length, 1)

  t += 121 * 60 * 1000   // 刚过冷却
  const b = await stopper.handle({ agent, turn: 2, capture: cap })
  assert.equal(b.steered, true, '过了冷却就该补(本意是「憋着一直没说」,不是「这轮没说」)')
  assert.equal(agent.steers.length, 2)
})

test('跨轮节流:没接线 / 传 0 ⇒ 退回旧行为(不节流,逐位不变)', async () => {
  for (const over of [{}, { cooldownMinutes: () => 0 }]) {
    const { stopper } = makeStopper(over)
    const agent = fakeAgent()
    const cap = { sessionId: 's1', longingRead: read(9.0), turnText: '', fromPlatform: true }
    await stopper.handle({ agent, turn: 1, capture: cap })
    await stopper.handle({ agent, turn: 2, capture: cap })
    assert.equal(agent.steers.length, 2, '没接线 = 每轮都补(老行为)')
  }
})

test('跨轮节流:按会话隔离(A 冷却不影响 B)', async () => {
  const t = 1_000_000_000_000
  const { stopper } = makeStopper({ cooldownMinutes: () => 120, now: () => t })
  const a1 = fakeAgent('sa')
  const a2 = fakeAgent('sb')
  await stopper.handle({ agent: a1, turn: 1, capture: { sessionId: 'sa', longingRead: read(9.0), turnText: '', fromPlatform: true } })
  const r = await stopper.handle({ agent: a2, turn: 1, capture: { sessionId: 'sb', longingRead: read(9.0), turnText: '', fromPlatform: true } })
  assert.equal(r.steered, true, '另一个会话不受影响')
  assert.equal(a2.steers.length, 1)
})

test('跨轮节流:接线 —— 壳把面板项接进 stopper', () => {
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert.ok(/cooldownMinutes: \(\) => \{[\s\S]{0,160}?readSettings\(\)\.longing\?\.cooldown_minutes/.test(host),
    '冷却要接线到面板既有的 longing.cooldown_minutes')
  const toggle = readFileSync(fileURLToPath(new URL('../lib/toggle.js', import.meta.url)), 'utf8')
  assert.ok(/cooldown_minutes: 120,/.test(toggle), '默认 120 分钟(既有默认值,没有新增面板项)')
})
