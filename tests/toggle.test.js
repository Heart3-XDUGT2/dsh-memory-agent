/**
 * v0.2.1 「电源」:开关读写与 fail-soft 语义。
 * DATA_DIR 跟随 DSH_HOME 环境变量 —— 每个用例先指到临时目录再
 * 动态 import,拿到干净的 CONFIG_PATH,不碰真实数据目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

/**
 * ★ 防「测试写进真实配置」(2026-09-26 我真踩过)。
 *
 * `lib/toggle.js` 的 `CONFIG_PATH` 是**模块级常量**,在**首次** import 时按当时的
 * `DSH_HOME` 定死。于是:谁要是为了用一下 `normalizeSettings`,在文件顶部写一行
 * **静态** `import { normalizeSettings } from '../lib/toggle.js'` —— 那行会先于
 * `freshToggle()` 里的 `process.env.DSH_HOME = dir` 执行,CONFIG_PATH 就永久指向
 * `~/.dsh/echo/config.json`,后面 31 处写操作**全落到他机器上的真实配置里**。
 *
 * 那一次的实际后果:`settings.relay.token` 被写成测试占位值 `"good"`,还多出一块
 * 顶层垃圾 `relay` 块(his 真实令牌是适配器侧用的那个)→ QQ 中继静默 401。
 *
 * 所以这里加一道闸:**每次**解析出来的路径都必须在临时目录里,否则当场炸。
 * 「只验第一次」的版本我当场踩过第二次:第一次抛了、后面 16 条照跑照写,
 * 真实配置照样被改脏 —— 要红就红整片,一个字节都不许写出去。
 * 安静的假绿/安静的越界写,比红着更糟。
 */
let firstConfigPath = null

/**
 * ★ P1 收口(拍板 2):她的自称/别名从 `<数据目录>/profile.json` 的 `agentAliases` 派生
 * ⇒ 本文件要能**喂一份 profile**。数据目录是**进程级冻结**的(P1a),所以这里在
 * 第一次 import 之前就把 `ECHO_DATA_DIR` 钉到一个自建临时目录,并放一份 profile。
 * 文件名/值都跟他的真数据同形状(显示层中性 + 识别层保留)。
 */
const DATA_DIR = process.env.ECHO_DATA_DIR === undefined
  ? mkdtempSync(join(tmpdir(), 'echo-toggle-data-'))
  : process.env.ECHO_DATA_DIR
process.env.ECHO_DATA_DIR = DATA_DIR
const PROFILE_PATH = join(DATA_DIR, 'profile.json')
const PROFILE = {
  schemaRev: 1,
  userName: '用户',
  userAliases: ['阿乙', '阿岚'],
  agentName: '助手',
  agentSelfRef: '助手',
  agentAliases: ['Echo', '小e', '艾可'],
  nicknamePatterns: [],
  nicknameStrict: null,
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
  updatedAt: null
}
if (!existsSync(PROFILE_PATH)) writeFileSync(PROFILE_PATH, JSON.stringify(PROFILE), 'utf8')

async function freshToggle() {
  const dir = mkdtempSync(join(tmpdir(), 'echo-toggle-'))
  process.env.DSH_HOME = dir
  const mod = await import('../lib/toggle.js')
  if (firstConfigPath === null) firstConfigPath = mod.CONFIG_PATH
  assert.ok(
    mod.CONFIG_PATH.startsWith(tmpdir()),
    '测试的 CONFIG_PATH 落在了临时目录之外 —— 它会改到真实配置:' + mod.CONFIG_PATH
    + '\n  多半是文件顶部加了静态 `import ... from \'../lib/toggle.js\'`'
    + '(静态导入先于 DSH_HOME 赋值执行)。改成在用例内动态 import。'
  )
  return { dir, mod }
}

test('开关:文件缺失 → 在线(fail-soft 向「被召唤」一侧倒)', async () => {
  const { dir, mod } = await freshToggle()
  try {
    assert.equal(mod.readEnabled(), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('开关:写入休眠 → 读回休眠,落盘可持久', async () => {
  const { dir, mod } = await freshToggle()
  try {
    assert.equal(mod.setEnabled(false), false)
    assert.equal(mod.readEnabled(), false)
    // 再 import 一次(新模块实例)仍从盘上读到 false —— 持久性
    const again = await import('../lib/toggle.js?again=1')
    assert.equal(again.readEnabled(), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('开关:写入唤醒 → 读回在线', async () => {
  const { dir, mod } = await freshToggle()
  try {
    mod.setEnabled(false)
    assert.equal(mod.setEnabled(true), true)
    assert.equal(mod.readEnabled(), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('开关:文件损坏/字段脏值 → 一律按在线处理,不猜', async () => {
  const { dir, mod } = await freshToggle()
  try {
    writeFileSync(mod.CONFIG_PATH, '{not json', 'utf8')
    assert.equal(mod.readEnabled(), true)
    writeFileSync(mod.CONFIG_PATH, JSON.stringify({ enabled: 'false' }), 'utf8')
    assert.equal(mod.readEnabled(), true)
    writeFileSync(mod.CONFIG_PATH, JSON.stringify({ enabled: false }), 'utf8')
    assert.equal(mod.readEnabled(), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---- v0.9.0 会话范围:电源是总闸,范围是分闸 ----

test('范围:默认全部会话;脏值按默认处理', async () => {
  const { dir, mod } = await freshToggle()
  try {
    // 2026-09-26 硬开关:readScope 多了 manualOff(人显式关过的会话)与
    // by/at(谁拨的、什么时候)—— 面板要能显示「谁关的」,开关的可信度
    // 靠这个。**这个 deepEqual 是后面用例的前置**:它一红,第 89 行的
    // 重置写入就不执行,enabled:false 会漏给下一条用例(实测踩过)。
    assert.deepEqual(mod.readScope(), { scope: 'all', whitelist: [], exempt: [], manualOff: [], by: '', at: 0 })
    writeFileSync(mod.CONFIG_PATH, JSON.stringify({ scope: 'banana', whitelist: 'oops' }), 'utf8')
    assert.equal(mod.readScope().scope, 'all')
    assert.deepEqual(mod.readScope().whitelist, [])
    assert.deepEqual(mod.readScope().manualOff, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('范围:all 模式例外名单;whitelist 模式白名单;setSessionOn 按模式落位', async () => {
  const { dir, mod } = await freshToggle()
  try {
    // 前置:这条用例假定总闸开着。上一条用例若红在半路,会把
    // enabled:false 漏下来 —— 这里显式扶正,免得故障表现成"范围坏了"。
    mod.setEnabled(true)
    // all 模式:下线进例外,上线摘除
    mod.setSessionOn('sess-a', false)
    assert.equal(mod.sessionEnabled('sess-a'), false)
    assert.equal(mod.sessionEnabled('sess-b'), true)
    mod.setSessionOn('sess-a', true)
    assert.equal(mod.sessionEnabled('sess-a'), true)
    // whitelist 模式:上线进白名单,下线摘除
    mod.setScope('whitelist')
    assert.equal(mod.sessionEnabled('sess-a'), false) // 没进白名单的都关
    mod.setSessionOn('sess-a', true)
    assert.equal(mod.sessionEnabled('sess-a'), true)
    assert.equal(mod.sessionEnabled('sess-b'), false)
    mod.setSessionOn('sess-a', false)
    assert.equal(mod.sessionEnabled('sess-a'), false)
    // 重复上线幂等(名单不叠加)
    mod.setSessionOn('sess-a', true)
    mod.setSessionOn('sess-a', true)
    assert.equal(mod.readScope().whitelist.filter((x) => x === 'sess-a').length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('范围:电源总闸优先;setEnabled 不抹范围字段(v0.2.1 全量重写坑)', async () => {
  const { dir, mod } = await freshToggle()
  try {
    mod.setScope('whitelist')
    mod.setSessionOn('sess-a', true)
    // 总闸关:范围开着也不启用
    mod.setEnabled(false)
    assert.equal(mod.sessionEnabled('sess-a'), false)
    // 总闸开回来:范围字段还在(setEnabled 曾是全量重写,会抹掉它们)
    mod.setEnabled(true)
    assert.equal(mod.sessionEnabled('sess-a'), true)
    assert.equal(mod.readScope().scope, 'whitelist')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---- 2026-09-26 硬开关:autoScope 不许静默反悔 ----
// 现场:他说「Echo 下线」,而 exempt 一直是空的 —— 因为 autoScope() 每次入站
// 都只看 sessionEnabled(),把**人亲手关掉的**会话又打开,还只写一行 info 日志。
// 这条底线是「硬开关」这个词的全部含义:人关过,就必须一直关着。

test('硬开关:人关过的会话进 manualOff;autoScope 的判据(isManuallyOff)为真', async () => {
  const { dir, mod } = await freshToggle()
  try {
    assert.equal(mod.isManuallyOff('sess-a'), false)
    mod.setSessionOn('sess-a', false)
    assert.equal(mod.isManuallyOff('sess-a'), true, '关掉 = 进硬关名单')
    assert.equal(mod.sessionEnabled('sess-a'), false)
    // 空 id / 未知会话:不许误判成"关过"(否则 autoScope 会永久放弃陪伴会话)
    assert.equal(mod.isManuallyOff(''), false)
    assert.equal(mod.isManuallyOff('sess-never-seen'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('硬开关:他亲手开回来 → 摘除名单,autoScope 才允许再管它', async () => {
  const { dir, mod } = await freshToggle()
  try {
    mod.setSessionOn('sess-a', false)
    assert.equal(mod.isManuallyOff('sess-a'), true)
    mod.setSessionOn('sess-a', true)
    assert.equal(mod.isManuallyOff('sess-a'), false)
    assert.equal(mod.sessionEnabled('sess-a'), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('硬开关:whitelist 模式下也记名单(两种模式同一份硬关语义)', async () => {
  const { dir, mod } = await freshToggle()
  try {
    mod.setScope('whitelist')
    mod.setSessionOn('sess-a', false)
    assert.equal(mod.isManuallyOff('sess-a'), true)
    assert.deepEqual(mod.readScope().whitelist, [])
    mod.setSessionOn('sess-a', true)
    assert.equal(mod.isManuallyOff('sess-a'), false)
    assert.deepEqual(mod.readScope().whitelist, ['sess-a'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('硬开关:总闸/范围都记「谁拨的、什么时候」(面板要能显示来源)', async () => {
  const { dir, mod } = await freshToggle()
  try {
    // 注意:CONFIG_PATH 是模块级常量(首次 import 时定死),所以同一进程里
    // 前一条用例写下的 by/at 会留在这里 —— 只断言"这次拨动之后"的形状。
    mod.setEnabled(true, '')
    assert.equal(mod.readPower().by, '')
    mod.setEnabled(false, 'panel')
    const p = mod.readPower()
    assert.equal(p.enabled, false)
    assert.equal(p.by, 'panel')
    assert.ok(p.at > 0, '要带时间戳 —— 「什么时候关的」是开关可信度的一半')
    mod.setScope('whitelist', 'tool')
    const s = mod.readScope()
    assert.equal(s.by, 'tool')
    assert.ok(s.at > 0)
    // 落盘持久:新模块实例读得到(不是内存态)
    const again = await import('../lib/toggle.js?power=1')
    assert.equal(again.readPower().by, 'panel')
    assert.equal(again.readScope().by, 'tool')
    // 收尾扶正总闸:CONFIG_PATH 是模块级常量,同一进程里后面的用例共用
    // 这份配置 —— 留一个 enabled:false 下去,故障会表现成"范围坏了"。
    mod.setEnabled(true, '')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('标记短语:归一解析 + 长度门防误触(纯函数)', async () => {
  const { mod } = await freshToggle()
  // ★ P1 收口(拍板 2):认不认得出"她在说自己",看的是 profile.json 的 agentAliases
  // —— 下面是"这份数据已就位"的情形(值与他真数据同形状)。
  assert.equal(mod.parseSessionMarker('Echo 上线'), 'on')
  assert.equal(mod.parseSessionMarker('echo上线'), 'on')
  assert.equal(mod.parseSessionMarker('  ECHO   下线  '), 'off')
  // 2026-09-26 现场:他发的是「Echo 下线吧」,旧版要求整条消息正好等于四个字
  // ⇒ 不匹配 ⇒ **一声不吭**。现在口语都认,尾巴上的语气词与标点也剥掉。
  assert.equal(mod.parseSessionMarker('Echo下线。'), 'off')
  assert.equal(mod.parseSessionMarker('Echo 下线吧'), 'off')
  assert.equal(mod.parseSessionMarker('小E休眠'), 'off')
  assert.equal(mod.parseSessionMarker('艾可关掉'), 'off')
  assert.equal(mod.parseSessionMarker('Echo 你先下线'), 'off')
  assert.equal(mod.parseSessionMarker('把 echo 关掉吧'), 'off')
  assert.equal(mod.parseSessionMarker('Echo回来吧'), 'on')
  // 误判的代价不对称:把日常招呼当开关会静默改范围,所以「在吗」不算上线
  assert.equal(mod.parseSessionMarker('在吗'), null)
  assert.equal(mod.parseSessionMarker('<称呼>在吗'), null)
  // 句子里有动词但不是在跟她说开关 —— 不许误判
  assert.equal(mod.parseSessionMarker('Echo 关掉记忆功能'), null)
  assert.equal(mod.parseSessionMarker('帮我 echo 上线一下谢谢'), null) // 长句不认
  assert.equal(mod.parseSessionMarker('今天天气不错'), null)
  assert.equal(mod.parseSessionMarker(''), null)
  // 「像开关但没认出来」:调用方据此回一句状态,而不是静默
  assert.equal(mod.looksLikePowerTalk('Echo 关掉记忆功能'), true)
  assert.equal(mod.looksLikePowerTalk('今天天气不错'), false)
  // ★ 反面证据(同一份代码,只换数据):把 profile 里的 alias 清空 ⇒ 自称认不出来
  // ⇒ 「Echo 上线」不再被当开关。名字**真的**在数据里,不在代码里。
  writeFileSync(PROFILE_PATH, JSON.stringify({ ...PROFILE, agentAliases: [] }), 'utf8')
  try {
    assert.equal(mod.parseSessionMarker('Echo 上线'), null, '没有 alias ⇒ 不认(不猜、不兜真名)')
    assert.equal(mod.parseSessionMarker('小E休眠'), null)
    assert.equal(mod.looksLikePowerTalk('Echo 关掉记忆功能'), false)
    // 连 agentName 也空 ⇒ 还是空表,不崩
    writeFileSync(PROFILE_PATH, JSON.stringify({ ...PROFILE, agentAliases: [], agentName: '' }), 'utf8')
    assert.equal(mod.parseSessionMarker('Echo 上线'), null)
  } finally {
    writeFileSync(PROFILE_PATH, JSON.stringify(PROFILE), 'utf8')   // 喂回去,防串场
  }
})

// ---- v0.11.0 会话来源标签(M8-a)----

test('标签:默认空;写入读回;持久;不抹范围字段', async () => {
  const { dir, mod } = await freshToggle()
  try {
    assert.equal(mod.sessionLabel('sess-qq'), '')
    // 先落一个范围状态,再写标签 —— writeConfig 保字段,标签不能抹范围
    mod.setSessionOn('sess-qq', true)
    mod.setSessionLabel('sess-qq', 'QQ中继')
    assert.equal(mod.sessionLabel('sess-qq'), 'QQ中继')
    assert.equal(mod.readSessionLabels()['sess-qq'], 'QQ中继')
    // 持久性:新模块实例从盘上读回
    const again = await import('../lib/toggle.js?labels=1')
    assert.equal(again.sessionLabel('sess-qq'), 'QQ中继')
    // 范围字段完好
    assert.equal(again.sessionEnabled('sess-qq'), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('标签:空标签摘除;超长截断;脏值容错', async () => {
  const { dir, mod } = await freshToggle()
  try {
    mod.setSessionLabel('sess-a', 'QQ中继')
    mod.setSessionLabel('sess-b', 'x'.repeat(50))
    assert.equal(mod.sessionLabel('sess-b').length, 24) // 截断到 24
    mod.setSessionLabel('sess-a', '   ')                 // 空白 = 摘除
    assert.equal(mod.sessionLabel('sess-a'), '')
    assert.equal(Object.keys(mod.readSessionLabels()).includes('sess-a'), false)
    assert.equal(mod.sessionLabel(''), '')               // 空 sid 永远空
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---- v0.14.4 移植缺口 S4:调参段(引擎参数终于有人喂了)----

test('调参:文件缺失 → 全套默认值(A 侧默认照抄)', async () => {
  const { dir, mod } = await freshToggle()
  try {
    const s = mod.readSettings()
    assert.equal(s.auditKeep, 100)          // A 是 200;本仓定案 100
    assert.equal(s.injectTopK, 6)           // A 网关 8 / legacy 3;本仓保持 6
    assert.equal(s.reflectionEnabled, true)
    assert.equal(s.memoryTtlDays, 30)
    assert.equal(s.cleanupEvery, 10)
    assert.equal(s.emotionDecayIntervalMinutes, 30)
    assert.deepEqual(s.longing, {
      enabled: true, half_life_hours: 3.0, threshold: 7.0, msg_drop: 4.0,
      care_relief: 0.5, protest_kick: 1.5, cooldown_minutes: 120,
      night_hold: true, demo_rate: 1.0,
      // DSH 侧才有的一项(D2 轮末硬保证),默认开
      must_say: true,
      // P2-A 渠道子闸:默认 true = 只在平台轮(QQ)补那一句
      steerOnlyFromPlatform: true
    })
    // 2026-09-26 全仓审查:这里以前**没有**断言 —— 整组 `compaction` 曾从
    // normalizeSettings 的返回值里漏掉,面板上的策展开关与预算都是摆设。
    assert.deepEqual(s.compaction, { curated: true, budgetTokens: 1200 })
    assert.deepEqual(mod.readInterests(), [])
    assert.deepEqual(mod.readAliases(), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('调参:写入读回 + 持久,且不抹开关/范围/标签字段', async () => {
  const { dir, mod } = await freshToggle()
  try {
    mod.setEnabled(false)
    mod.setSessionOn('sess-x', false)
    mod.setSessionLabel('sess-x', 'QQ中继')
    mod.writeSettings({
      injectTopK: 3, herInterests: '写代码, 看番、折腾服务器',
      longing: { half_life_hours: 6, night_hold: false, demo_rate: 4 }
    })
    const s = mod.readSettings()
    assert.equal(s.injectTopK, 3)
    assert.equal(s.longing.half_life_hours, 6)
    assert.equal(s.longing.night_hold, false)
    assert.equal(s.longing.demo_rate, 4)
    assert.equal(s.longing.threshold, 7.0, '没提到的字段保持上次的值')
    assert.deepEqual(mod.readInterests(), ['写代码', '看番', '折腾服务器'])
    // 新模块实例从盘上读回(持久),老字段一个不少(v0.2.1 全量重写的坑)
    const again = await import('../lib/toggle.js?settings=1')
    assert.equal(again.readSettings().injectTopK, 3)
    assert.equal(again.readEnabled(), false)
    assert.equal(again.sessionLabel('sess-x'), 'QQ中继')
    assert.equal(again.sessionEnabled('sess-x'), false)
    assert.deepEqual(again.readAliases(), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('调参:脏值与越界一律钳位/回默认(fail-soft,不因一个坏数字失灵)', async () => {
  const { dir, mod } = await freshToggle()
  try {
    // 模块缓存:CONFIG_PATH 在**首次** import 时就按当时的 DSH_HOME 定下,
    // 本文件所有用例共享同一条路径 —— 所以按模块自己认的路径写,而不是
    // 自己拼 dir(拼错会读到默认值,测试变成假绿)。
    mkdirSync(dirname(mod.CONFIG_PATH), { recursive: true })
    writeFileSync(mod.CONFIG_PATH, JSON.stringify({
      enabled: true,
      settings: {
        auditKeep: 0,               // 钳到 20(裁剪保留至少 20 条)
        injectTopK: 999,            // 钳到 12
        memoryTtlDays: -5,          // 钳到 1
        cleanupEvery: 'x',          // 非数字 → 默认 10
        reflectionEnabled: 'false', // 字符串布尔 → 默认 true(不猜)
        emotionDecayIntervalMinutes: 1, // 钳到 5(A 也是 max(5, cfg))
        herInterests: 42,           // 非字符串 → ''
        longing: {
          half_life_hours: 99999,   // 钳到 168
          threshold: -3,            // 钳到 0
          care_relief: 5,           // 钳到 1
          cooldown_minutes: 100000, // 钳到 1440
          demo_rate: 0,             // 钳到 0.1
          night_hold: 0             // 非布尔 → 默认 true
        }
      }
    }), 'utf8')
    const s = mod.readSettings()
    assert.equal(s.auditKeep, 20)
    assert.equal(s.injectTopK, 12)
    assert.equal(s.memoryTtlDays, 1)
    assert.equal(s.cleanupEvery, 10)
    assert.equal(s.reflectionEnabled, true)
    assert.equal(s.emotionDecayIntervalMinutes, 5)
    assert.equal(s.herInterests, '')
    assert.equal(s.longing.half_life_hours, 168)
    assert.equal(s.longing.threshold, 0)
    assert.equal(s.longing.care_relief, 1)
    assert.equal(s.longing.cooldown_minutes, 1440)
    assert.equal(s.longing.demo_rate, 0.1)
    assert.equal(s.longing.night_hold, true)
  } finally {
    // 这条用例写的是共享的那份 config —— 收尾删掉,别脏了别的用例
    try { rmSync(mod.CONFIG_PATH, { force: true }) } catch { }
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 传话桥的开关住在 **settings.relay**。
 *
 * 2026-09-25 的真实事故:我手写 config.json 时把 relay 块放在了**顶层**。插件读的
 * 是 `raw.settings.relay`(`lib/toggle.js` → `normalizeSettings`),于是它一直用
 * 默认值(总闸关、令牌空 → `/relay/*` 四个端点全 401),而我当时的探针与
 * `r4-preflight` 也读顶层 → 双双报「开关开着、配置对得上」。两处假绿,
 * 直到他强制重启 `dsh web` 才暴露。这组用例把两边都钉住。
 */
test('桥:writeSettings 写进 settings.relay,readSettings 读得到', async () => {
  const { dir, mod } = await freshToggle()
  try {
    const next = mod.writeSettings({ relay: { enabled: true, token: 'echo-test-token' } })
    assert.equal(next.relay.enabled, true)
    assert.equal(next.relay.token, 'echo-test-token')
    // 再 import 一次(新模块实例)从盘上读 —— 印证「插件读的是这一格」
    const again = await import('../lib/toggle.js?relay=1')
    const s = again.readSettings()
    assert.equal(s.relay.enabled, true)
    assert.equal(s.relay.token, 'echo-test-token')
    // 落盘形状:在 settings 里,不在顶层
    const onDisk = JSON.parse(readFileSync(again.CONFIG_PATH, 'utf8'))
    assert.equal(onDisk.relay, undefined, '顶层不该有 relay 块')
    assert.equal(onDisk.settings.relay.enabled, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('桥:顶层 relay 块被忽略(这正是那次事故的形状)', async () => {
  const { dir, mod } = await freshToggle()
  try {
    mkdirSync(dirname(mod.CONFIG_PATH), { recursive: true })
    writeFileSync(mod.CONFIG_PATH, JSON.stringify({
      enabled: true,
      // 插件**不读**这里 —— 写在顶层 = 改了没生效
      relay: { enabled: true, token: 'top-level-should-be-ignored' }
    }), 'utf8')
    const s = mod.readSettings()
    assert.equal(s.relay.enabled, false, '顶层那份不该生效')
    assert.equal(s.relay.token, '', '顶层令牌不该生效')
    assert.equal(s.relay.sessionId, 'session-echo-companion', '读不到就回默认')
    // 写入也只能落到 settings 里,顺带把顶层那块留着(它是垃圾,不是数据源)
    mod.writeSettings({ relay: { enabled: true, token: 'good' } })
    const onDisk = JSON.parse(readFileSync(mod.CONFIG_PATH, 'utf8'))
    assert.equal(onDisk.settings.relay.token, 'good')
    assert.equal(mod.readSettings().relay.token, 'good')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

/**
 * v0.22.0:议程簿与整固两只旋钮(A `main.py:1818/1926-1927`)。
 * 这里钉的是**钳位语义**:坏值不许变成"关不掉的开关"或"0 条窗口"。
 */
test('整固旋钮:窗口下限 5(与 A 的 max(5,cfg) 一致),阈值钳到 [0,500]', async () => {
  // ★ 动态 import,别在文件顶部静态导入(见 freshToggle 上方那段注释)
  const { mod } = await freshToggle()
  const s = mod.normalizeSettings({ reflection: { importance_threshold: -10, max_inputs: 1 } })
  assert.equal(s.reflection.importance_threshold, 0)
  assert.equal(s.reflection.max_inputs, 5, '给 1 也要抬到 5 —— A 就是这么写的')
  const t = mod.normalizeSettings({ reflection: { importance_threshold: 99999, max_inputs: 99999 } })
  assert.equal(t.reflection.importance_threshold, 500)
  assert.equal(t.reflection.max_inputs, 500)
  // 坏类型回默认(A 默认 30/50)
  const junk = mod.normalizeSettings({ reflection: { importance_threshold: 'x', max_inputs: null } })
  assert.equal(junk.reflection.importance_threshold, 30)
  assert.equal(junk.reflection.max_inputs, 50)
  // 2026-09-26 抓到的真坑:null/true/[] 以前被 Number() 成 0 再钳成下限
  const bad = mod.normalizeSettings({ reflection: { importance_threshold: null, max_inputs: true } })
  assert.equal(bad.reflection.importance_threshold, 30, 'null 该回默认,不是 0')
  assert.equal(bad.reflection.max_inputs, 50, 'true 该回默认,不是 5')
})

test('议程簿开关:默认开着,只有显式 false 才关(坏值不改变行为)', async () => {
  const { mod } = await freshToggle()
  assert.equal(mod.normalizeSettings({}).agenda.enabled, true)
  assert.equal(mod.normalizeSettings({ agenda: { enabled: false } }).agenda.enabled, false)
  assert.equal(mod.normalizeSettings({ agenda: { enabled: 'no' } }).agenda.enabled, true)
  assert.equal(mod.normalizeSettings({ agenda: null }).agenda.enabled, true)
})
