/**
 * S3-b 验收:**切换点那道门**。
 *
 * 问题:旧桥总闸关着、但有一条渠道插件自报家门时,她还能不能进能出?
 * 这个文件用**真件**回答 —— 真 `lib/speak.js` + 真 `lib/relay.js` + 真内存库
 * (只有宿主那几件是假的:会话、注入、时钟),接线照抄 `lib/index.js` 的 `mouthOpen`。
 *
 * 为什么值得一条专门验收:这一步是"旧桥退役、插件接管"的分界。接错了有两种事故:
 *   ① 接成 `speaker.hasChannel()` ⇒ 无限递归(`status → gate → hasChannel → status`,
 *      见 lib/speak.js 的 hasRegisteredChannels 注释)—— 第 4 条用例把它钉住;
 *   ② 接成"只看有没有插件" ⇒ 现有部署(只用旧桥、没插件)当场失灵 —— 第 3 条用例钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolateTestHome, assertHomeIsolated } from './fixtures/test-home.js'

// 2026-10-10 测试隔离加固:先隔离 `DSH_HOME`,再**动态** import 库模块。
// 本文件用**真** `lib/relay.js`,而它的 `handleInbound()` 在活配置
// `settings.newSessionOn[qq] === true` 时会调 `setSessionOn` ⇒ `writeConfig()`
// ⇒ 写真机 config.json(实测:单跑本文件会刷新活配置的 `savedAt`)。
// 顺序是硬约束(toggle.js 的 CONFIG_PATH 是模块级常量),配套自检见 test-home.js。
isolateTestHome()
const { CONFIG_PATH } = await import('../lib/toggle.js')
assertHomeIsolated(CONFIG_PATH)
const { openStore } = await import('../lib/store.js')
const { createRelay } = await import('../lib/relay.js')
const { createSpeaker } = await import('../lib/speak.js')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STORE = () => openStore(':memory:')
const TOKEN = 'SECRET-TOKEN-1'
const SID = 'session-echo-companion'

const envelope = (over = {}) => ({
  v: 1,
  platform: 'qq',
  chat: { id: '<your-qq>', type: 'private', title: '' },
  sender: { id: '<your-qq>', name: '阿岚', isMaster: true },
  text: '在吗',
  msgId: 'm-1',
  ...over
})

/**
 * 照 index.js 的接线搭一台"主包":桥的门 = **有注册渠道**(就这一个判据)。
 * @param {{legacyOn?: boolean}} opts 旧桥总闸(`settings.relay.enabled` + token 非空)。
 *   2026-09-28 旧桥完整退役后它**不再算数** —— 这个参数留着,是为了让用例 ③
 *   把"它不算数了"这件事钉住(而不是悄悄删掉、以后又被谁加回去)。
 */
function wiring (opts = {}) {
  const store = opts.store ?? STORE()
  const calls = { inject: [], audits: [], ensure: 0 }
  const legacyOn = opts.legacyOn === true
  let speaker = null // speaker 在 relay 之后才建(与生产同序:靠闭包惰性读)
  const mouthOpen = () => {
    try {
      return speaker !== null && speaker.hasRegisteredChannels()
    } catch { return false }
  }
  const relay = createRelay({
    store,
    logger: { info: () => { }, warn: () => { } },
    config: () => ({
      sessionId: SID,
      permissionPreset: 'read-only',
      proactiveScope: 'private',
      pushLocalTurns: false,
      autoReplyToOrigin: true,
      outboxLeaseSec: 30,
      replyMaxChars: 500,
      proactiveTtlSec: 300,
      proactiveMaxChars: 120,
      token: TOKEN
    }),
    isEnabled: mouthOpen,
    ensureCompanion: async () => { calls.ensure += 1; return { agent: { session: { id: SID } }, sessionId: SID } },
    injectInbound: async (_agent, env, text) => { calls.inject.push({ env, text }); return 'ok' },
    applyPermission: () => 'applied:read-only',
    audit: (kind, label) => calls.audits.push({ kind, label }),
    labelSession: () => { },
    onAcked: () => { },
    now: () => 1_000_000
  })
  speaker = createSpeaker({ transport: relay })
  return { store, relay, speaker, calls, setLegacyOn: opts.setLegacyOn }
}

test('① 总闸关着 + 没有嘴 ⇒ 入站被拒(与今天逐字相同)', async () => {
  const w = wiring()
  assert.equal(w.relay.status().enabled, false, '门:关')
  const r = await w.relay.handleInbound(envelope())
  assert.equal(r.status, 409)
  assert.equal(r.body.reason, 'scope-off')
  assert.equal(w.calls.inject.length, 0, '拒收后不许注入')
  assert.equal(w.calls.ensure, 0, '拒收发生在建会话之前')
  // 总闸这一层的拒收**不留审计**(留痕是路由层的事)。这里钉住这个事实,免得以后
  // 有人以为它留了 —— 2026-09-28 之后连那层路由都没了(旧桥退役),所以这条更该留着。
  assert.equal(w.calls.audits.length, 0)
})

test('② 渠道插件自报家门 ⇒ 能进能出(嘴在不在,由嘴自己说)', async () => {
  const w = wiring()
  const off = w.speaker.registerChannel({ name: 'qq', status: () => ({ mode: 'service' }) })
  assert.equal(w.relay.status().enabled, true, '门:开 —— 因为有人注册了嘴')
  const r = await w.relay.handleInbound(envelope())
  assert.equal(r.status, 200)
  assert.equal(w.calls.inject.length, 1, '真的进了她的管道')
  assert.equal(w.calls.ensure, 1, '会话照常建起来(入站九步不变)')

  // 出站:她说的话照样入队(出站本来就不受总闸管),行里带着渠道
  w.relay.captureSegment(SID, '在的')
  const fin = w.relay.finishTurn(SID, { proactive: false })
  assert.ok(fin.rows > 0, '她说的话进了队列(rows=' + fin.rows + ')')
  const out = w.store.relayLeaseOutbox({ platform: 'qq', limit: 5, now: 1_000_001 })
  assert.equal(out.items.length, 1)
  assert.equal(out.items[0].text, '在的')
  assert.equal(out.items[0].chatId, '<your-qq>')

  // 插件注销(关了/卸载)⇒ 门又关上:不是单向阀
  off()
  assert.equal(w.speaker.hasRegisteredChannels(), false)
  assert.equal(w.relay.status().enabled, false)
  const r2 = await w.relay.handleInbound(envelope({ msgId: 'm-2' }))
  assert.equal(r2.status, 409)
})

test('③ 退役后:旧桥总闸开着也**不再算数**(门只剩"有没有嘴")', async () => {
  const w = wiring({ legacyOn: true })  // 配置里 settings.relay.enabled 还是 true
  assert.equal(w.relay.status().enabled, false, '没人注册 ⇒ 门关(fail-closed)')
  const r = await w.relay.handleInbound(envelope())
  assert.equal(r.status, 409, '旧桥总闸再也换不来一次注入')
  assert.equal(r.body.reason, 'scope-off')
  assert.equal(w.calls.inject.length, 0)
  // 注册了嘴 ⇒ 门开。两个判据不再是"或",只剩这一个。
  w.speaker.registerChannel({ name: 'qq' })
  assert.equal(w.relay.status().enabled, true)
  assert.equal(await w.relay.handleInbound(envelope({ msgId: 'm-open' })).then((x) => x.status), 200)
})

test('④ 陷阱:把 hasChannel() 当桥的门 ⇒ **静默把门关死**(不是崩,所以更危险)', () => {
  // 为什么不会崩:`hasChannel()` 没注册渠道时会去问 `transport.status()` —— 那就是这条
  // relay 自己,于是 `gate → isEnabled → hasChannel → status → gate …` 递归到栈溢出,
  // 而 hasChannel() 内部的 try/catch 把 RangeError **吞了** ⇒ 返回 false。
  // 现场表现:总闸明明开着,入站却全被 409(而且日志里一个字都没有)。
  const store = STORE()
  let speaker = null
  const legacyOn = true // 这台 relay 的"旧桥总闸"其实开着
  const build = (isEnabled) => {
    const relay = createRelay({
      store,
      logger: { info: () => { }, warn: () => { } },
      config: () => ({ sessionId: SID, token: TOKEN, outboxLeaseSec: 30 }),
      isEnabled,
      ensureCompanion: async () => ({ agent: {}, sessionId: SID }),
      injectInbound: async () => 'ok',
      now: () => 1_000_000
    })
    speaker = createSpeaker({ transport: relay })
    return relay
  }
  // ❌ 错接线(只认"有没有注册渠道",把总闸那半边丢了)
  const wrong = build(() => speaker !== null && speaker.hasChannel())
  assert.equal(wrong.status().enabled, false, '❌ 总闸开着却报"关" —— 静默错,不报错')
  // ✅ 正确接线:先算总闸(短路,不碰 speaker),再谈注册渠道
  const right = build(() => {
    try {
      if (legacyOn) return true
      return speaker !== null && speaker.hasRegisteredChannels()
    } catch { return false }
  })
  assert.equal(right.status().enabled, true, '✅ 正确接线:门如实报开')
})

test('⑤ 源码钉子:index.js 接的就是这道门', () => {
  const src = readFileSync(join(ROOT, 'lib/index.js'), 'utf8')
  assert.ok(src.includes('isEnabled: mouthOpen,'), '桥的门必须是 mouthOpen')
  assert.ok(src.includes('speaker.hasRegisteredChannels()'), 'mouthOpen 必须用非递归那半边')
  // 只查 createRelay 那一段:别处的 `isEnabled: () => speaker.hasChannel()`
  // 是**工具注册门**(S1-b 的既有语义),不是桥的门。
  const at = src.indexOf('relay = createRelay({')
  assert.ok(at > 0, '找不到 createRelay 接线')
  const block = src.slice(at, src.indexOf('\n  })', at))
  assert.equal(block.includes('hasChannel'), false, '桥的门不许出现 hasChannel(会递归)')
  assert.ok(src.includes('const startResident = () => {') && src.includes('if (residentStarted || !mouthOpen()) return'),
    '陪伴会话常驻也走新门(否则退役旧桥后心跳会没人跑)')
  // 2026-09-28 早上事故:常驻块写在 `if (mouthOpen()) {` 里 ⇒ 启动那一瞬
  // 渠道插件还没自报家门 ⇒ 常驻一次没跑过 ⇒ 她的 agent 不存在 ⇒ 心跳没地方挂
  // ⇒ 她再也没能先开口。所以必须挂 onRegistered 补判(与⑥同一修法)。
  assert.ok(src.includes('speaker.onRegistered(startResident)'),
    '启动那一刻门可能还关着 —— 嘴一出现就要重判常驻')
  assert.equal(src.includes('if (relayEnabled()) {'), false, '不该还有哪处直接看旧门')
})

/**
 * ⑥ 2026-09-28 现场事故的钉子:她突然不说话了。
 *
 * 她的两只手(`echo_qq_say`/`echo_qq_call`)**只能注册、没法注销**,
 * 而"她有嘴吗"退役后是**注册**说了算(渠道插件晚几秒才自报家门)⇒ 工具若只在
 * 启动那一瞬判一次,宿主先起时手就永远不登记,可提示词是动态读 `hasChannel()` 的,
 * 她会一直去试一只不存在的手(`unknown tool`),话全卡在手里。
 * 所以:必须挂 `speaker.onRegistered()` 补登记。
 */
test('⑥ 源码钉子:手跟着嘴走(onRegistered 补登记),不许只判启动那一刻', () => {
  const src = readFileSync(join(ROOT, 'lib/index.js'), 'utf8')
  assert.ok(src.includes('speaker.onRegistered('), '手必须挂"嘴一出现就补登记"的钩子')
  assert.ok(/const registerHandTools = \(\) => \{/.test(src), '手要收进一个幂等的函数里')
  const calls = src.match(/registerHandTools\(\)/g) ?? []
  assert.ok(calls.length >= 2, '快路(启动能判就判)+ 钩子路都要调用它,现在只有 ' + calls.length + ' 处')
  assert.ok(src.includes('handRegistered'), '手只能注册一次 ⇒ 必须有幂等标记')
  // relay-tools 那只手的动态门也得留着:渠道全走了之后它要能说 bridge-off
  const tools = readFileSync(join(ROOT, 'lib/relay-tools.js'), 'utf8')
  assert.ok(tools.includes("'bridge-off'"), '手上的动态门(桥关着 ⇒ bridge-off)不许删')
})
