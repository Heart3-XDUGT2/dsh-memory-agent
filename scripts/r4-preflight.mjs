/**
 * R4 切换前自检:三份配置文件对不对得上(只读,一个字节都不写)。
 * ==================================================================
 * 切换那天最贵的失败不是「桥不通」,而是**三份配置之间对不上**:
 *
 *   `~/.dsh/echo/config.json`         DSH 侧的令牌/权限/主动范围/陪伴会话
 *   `…\config\astrbot_plugin_echo_relay_config.json`   A 侧适配器的令牌/主人名单
 *   `…\data\cmd_config.json`          AstrBot 框架的白名单与平台实例
 *
 * 典型事故:
 *   ① 两边令牌不是一个字(桥回 401,表现是「她不说话」);
 *   ② 适配器的 master_ids 不在框架白名单里(消息在框架那层就被丢了,
 *      适配器**根本收不到** —— 而它自己的白名单看起来完全正常);
 *   ③ 陪伴会话不在 DSH 的启用射程里(whitelist 模式下人格/记忆不注入);
 *   ④ 老插件的 `db_path` 指向共享库(它会继续往 DSH 的库里写)。
 *
 * 用法:
 *   node scripts/r4-preflight.mjs          # 看结果(退出码 0=可以切,1=有项目要处理)
 *   node scripts/r4-preflight.mjs --json
 */
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const HOME = homedir()
const DSH_CONFIG = join(process.env.DSH_HOME ?? join(HOME, '.dsh'), 'echo', 'config.json')
const BASELINE = join(process.env.DSH_HOME ?? join(HOME, '.dsh'), 'echo', 'r4-baseline.json')
// A 侧数据目录可以用 ASTRBOT_DATA 指走(测试要能把整套判断在临时目录里跑一遍)
const A_DATA = process.env.ASTRBOT_DATA ?? join(HOME, '.astrbot', 'data')
const ADAPTER_CONFIG = join(A_DATA, 'config', 'astrbot_plugin_echo_relay_config.json')
const FRAMEWORK_CONFIG = join(A_DATA, 'cmd_config.json')
const OLD_CONFIG = join(A_DATA, 'config', 'astrbot_plugin_memory_middleware_config.json')
const BACKEND_LOG = join(A_DATA, '..', 'logs', 'backend.log')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const argDir = args.find((a) => a.startsWith('--astrbot='))?.slice(10)

const lines = []
const problems = []
const notes = []
const short = (t) => (t === '' ? '(空)' : createHash('sha256').update(t).digest('hex').slice(0, 10))
const ok = (label, msg) => lines.push(['  ✓', label, msg])
const bad = (label, msg) => { lines.push(['  !', label, msg]); problems.push(label + ':' + msg) }
const note = (label, msg) => { lines.push(['  ·', label, msg]); notes.push(label + ':' + msg) }

/**
 * 读一个 JSON 配置。**AstrBot 写的文件带 UTF-8 BOM**(实测 `cmd_config.json`
 * 头三字节是 EF BB BF),`JSON.parse` 会直接抛 —— 不剥 BOM 就会把「读不动」
 * 误报成「文件不在」。
 */
function readJson (path) {
  if (!existsSync(path)) return null
  try {
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch (e) {
    lines.push(['  !', '解析失败', path + ' → ' + e.message])
    problems.push('解析失败:' + path + ' → ' + e.message)
    return null
  }
}

const dsh = readJson(DSH_CONFIG)
const adapterPath = argDir ? join(argDir, 'config', 'astrbot_plugin_echo_relay_config.json') : ADAPTER_CONFIG
const adapter = readJson(adapterPath)
const framework = readJson(FRAMEWORK_CONFIG)
const old = readJson(OLD_CONFIG)

// ---- ① DSH 侧 ----
// 2026-09-25 的真实事故:relay 块被我写在 config.json **顶层**,而插件读的是
// `settings.relay`(`lib/toggle.js:358` → normalizeSettings)。结果是插件侧一直用
// 默认值(总闸关、令牌空 → 四个端点全 401),而这个脚本当年也读顶层 → 报「对得上」。
// 所以这里不只读对格子,还要**指着那个顶层块说话**。
const relay = (dsh && dsh.settings && dsh.settings.relay) || {}
const strayRelay = Boolean(dsh && Object.prototype.hasOwnProperty.call(dsh, 'relay'))
const dshToken = String(relay.token || '')
lines.push(['', 'DSH 侧 ' + DSH_CONFIG, ''])
if (!dsh) bad('DSH 配置', '读不到 ' + DSH_CONFIG)
else {
  if (strayRelay) {
    bad('顶层 relay 块', '存在 —— 插件**不读**它(读 settings.relay);删掉它,别在这儿调参')
  }
  relay.enabled === true ? ok('总闸', '开(settings.relay.enabled)') : bad('总闸', '关着(enabled=' + String(relay.enabled) + ')')
  dshToken !== '' ? ok('令牌', '已设(sha256:' + short(dshToken) + ')') : bad('令牌', '空 —— 桥是关的')
  const preset = String(relay.permissionPreset || '')
  preset === '' ? note('权限预设', '空 = 用宿主默认(危险,推荐 read-only)') : ok('权限预设', preset)
  const scope = String(relay.proactiveScope || 'private')
  scope === 'private' ? ok('主动范围', 'private(只推私聊)') : note('主动范围', scope)
  const sid = String(relay.sessionId || 'session-echo-companion')
  ok('陪伴会话', sid)
  // 陪伴会话必须在启用射程里(whitelist 模式下不显式开就没有人格/记忆)。
  // 但**切换前它本来就不在表里** —— 桥第一次拉会话时会自动加进去
  // (`lib/index.js` 的 ensureCompanion → autoScope → setSessionOn)。
  // 所以「不在表里」是提醒,不是错;真正的错是启动后仍不在。
  const scopeMode = String(dsh.scope || '')
  const on = dsh.sessions && typeof dsh.sessions === 'object' ? dsh.sessions[sid] : undefined
  if (scopeMode === 'whitelist') {
    on === true
      ? ok('射程', 'whitelist 模式 + 陪伴会话已开')
      : note('射程', 'whitelist 模式,' + sid + ' 还不在启用表里 —— 桥第一次拉会话时会自动开(autoScope);R4 第 2 步之后它应当已在表里,那时若还不在才是问题')
  } else {
    note('射程', 'scope=' + (scopeMode || '(缺省)') + '(非 whitelist,默认全开)')
  }
  ok('出站租约', String(relay.outboxLeaseSec ?? 30) + 's / 单条上限 ' + String(relay.replyMaxChars ?? 500) + ' 字 / 主动话保鲜 ' + String(relay.proactiveTtlSec ?? 300) + 's')
}

// ---- ② A 侧适配器 ----
// 「文件里 enabled=true」≠「运行中那份已经开了」:插件在 **load 那一刻**读配置
// (`AstrBotConfig` 构造时读文件,适配器的 `_cfg()` 读的是那一刻拿到的 dict,
// `main.py:119`),所以改文件要等**重载/重启**才生效。这一点当年就是我的假绿来源,
// 所以这里除了读文件,还去读**它自己打印的启动行**,看运行中那份到底怎么想。
const logTail = (() => {
  try {
    if (!existsSync(BACKEND_LOG)) return ''
    const text = readFileSync(BACKEND_LOG, 'utf8')
    return text.slice(-400_000)
  } catch { return '' }
})()
const loadHits = [...logTail.matchAll(
  /\[(\d\d:\d\d:\d\d)\.[^\]]*\][^\n]*astrbot_plugin_echo_relay\][^\n]*?(接管中|已就绪但 enabled=false|未配置 relay_token|拿不到平台实例 id)/g
)]
const lastLoad = loadHits.length > 0 ? { at: loadHits[loadHits.length - 1][1], what: loadHits[loadHits.length - 1][2] } : null
const pluginSet = Array.isArray(framework?.plugin_set) ? framework.plugin_set.map(String) : null
const allPluginsOn = pluginSet === null || pluginSet.includes('*')
/**
 * 「这个插件到底在不在跑」的**权威答案**在 AstrBot 自己的库里:
 * `data/data_v4.db` 的 `preferences` 表,键 `inactivated_plugins`,值是
 * `{"val":["data.plugins.<插件名>.main", …]}`(`star_manager.turn_off_plugin`
 * 往里加,`turn_on_plugin` 里删)。`cmd_config.json` 的 `plugin_set` 只是
 * 「*」= 允许加载,分辨不出「被停用」—— 我先前拿它判断,差点又报一次假绿。
 */
const inactivated = (() => {
  const dbPath = join(A_DATA, 'data_v4.db')
  if (!existsSync(dbPath)) return null
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db.prepare("SELECT value FROM preferences WHERE key = 'inactivated_plugins'").get()
      if (!row) return []
      const parsed = JSON.parse(String(row.value))
      const list = Array.isArray(parsed?.val) ? parsed.val : []
      return list.map(String)
    } finally { db.close() }
  } catch { return null }
})()
const activeIn = (name) => {
  // 注意:name 已经是完整的 `astrbot_plugin_xxx`(库里存的是 `data.plugins.<name>.main`)
  if (inactivated !== null) {
    return inactivated.some((v) => v.includes(name)) ? '否' : '是'
  }
  if (pluginSet === null) return '未知'
  return allPluginsOn || pluginSet.includes(name) ? '是' : '否'
}
const activationSource = inactivated !== null
  ? 'data_v4.db 的 inactivated_plugins'
  : 'cmd_config.json 的 plugin_set(读不到前者时的退路)'
const adapterActive = activeIn('astrbot_plugin_echo_relay')
const oldActive = activeIn('astrbot_plugin_memory_middleware')

lines.push(['', 'A 侧适配器 ' + adapterPath, ''])
if (!adapter) bad('适配器配置', '读不到(装好但 AstrBot 还没加载过它?)')
else {
  const aToken = String(adapter.relay_token || '')
  const fileOn = adapter.enabled === true
  const runningOn = lastLoad !== null && lastLoad.what === '接管中'
  if (fileOn) {
    note('enabled', '文件里已开 —— 但它只在**插件重载/重启那一刻**被读到(运行中那份:见下)')
  } else {
    ok('enabled', 'false(装配待机,完全放行原生链路)')
  }
  note('AstrBot 侧激活', adapterActive + '(' + activationSource + ')')
  lastLoad === null
    ? note('运行中那份', '日志里没找到它的启动行(这个进程还没加载过它?)')
    : note('运行中那份', lastLoad.at + ' 说「' + lastLoad.what + '」')
  // 三条要人命的组合,逐条点出来
  if (fileOn && adapterActive === '是' && lastLoad !== null && !runningOn) {
    note('下一步', '文件已开但运行中那份还没重载 → 在 AstrBot 面板**重载这个插件**(或重启 AstrBot)才接管')
  }
  if (runningOn && oldActive === '是') {
    bad('两个都在答?', '适配器运行中已接管,而老插件还在加载 —— 同一句话会被答两遍,记忆写两份;停用老插件')
  }
  aToken !== '' ? ok('令牌', '已设(sha256:' + short(aToken) + ')') : bad('令牌', '空 —— 入站会 401')
  if (aToken !== '' && dshToken !== '') {
    aToken === dshToken ? ok('令牌一致', '两边同一个(sha256:' + short(aToken) + ')') : bad('令牌一致', '两边不一样:DSH=' + short(dshToken) + ' A=' + short(aToken))
  }
  const masters = Array.isArray(adapter.master_ids) ? adapter.master_ids.map(String) : []
  masters.length > 0 ? ok('主人名单', masters.join(',')) : bad('主人名单', '空 —— 谁说话都不会被转发')
  ok('平台', String(adapter.platform || 'qq') + ' @ ' + String(adapter.dsh_base_url || 'http://127.0.0.1:3080'))
  note('群里要叫到才接?', adapter.group_require_at === true ? '是(默认关)' : '否(群里主人说话就接)')
  note('命令透传', adapter.forward_commands === true ? '开' : '关(带 / 的消息直接给框架)')
  note('umo 前缀', String(adapter.umo_prefix || '') !== ''
    ? '配置里写死 ' + adapter.umo_prefix
    : '留空 → 起步时从平台实例学(本机实测是 Echo;日志会打「umo 前缀 = …」)')
}

// ---- ③ 框架白名单 ----
lines.push(['', 'A 侧框架 ' + FRAMEWORK_CONFIG, ''])
// 这些键在 cmd_config.json 的 `platform_settings` 段里(实测 4.28.0),
// 早期版本挂在顶层 —— 两个位置都认,免得换个版本就误报「没配白名单」。
const pset = (framework && (framework.platform_settings || framework)) || {}
if (!framework) bad('框架配置', '读不到 ' + FRAMEWORK_CONFIG)
else {
  const wl = pset.enable_id_white_list === true
  const ids = Array.isArray(pset.id_whitelist) ? pset.id_whitelist.map(String) : []
  wl ? ok('框架白名单', '开:' + (ids.join(',') || '(空表!)')) : note('框架白名单', '关(适配器自己的白名单是第一道,也是唯一一道)')
  if (wl && adapter) {
    const masters = Array.isArray(adapter.master_ids) ? adapter.master_ids.map(String) : []
    const missing = masters.filter((m) => !ids.includes(m))
    missing.length === 0
      ? ok('名单覆盖', '适配器的主人都框架放行(不然消息在框架那层就被丢了)')
      : bad('名单覆盖', '这些主人在框架白名单外:' + missing.join(','))
  }
  const plats = Array.isArray(framework.platform) ? framework.platform : []
  const enabled = plats.filter((p) => p && p.enable !== false)
  enabled.length > 0
    ? ok('平台实例', enabled.map((p) => (p.id || '?') + '(' + (p.type || '?') + ')').join(' '))
    : bad('平台实例', '没有启用的平台 —— 消息根本进不来')
  // 平台实例 id 就是 umo 的第一段(`Echo:FriendMessage:…`)。适配器留空时会自己学,
  // 但「学不到」正是「她重启后主动开口发不出去」那个坑 —— 所以这里把该学的值写出来,
  // 好让日志里那行「umo 前缀 = 」有东西可对。
  const first = enabled[0]
  if (first && first.id) {
    note('umo 前缀', '应当是 ' + first.id + '(适配器留空时靠它学;留空 ≠ 出错,但它得学得到)')
  }
  ok('插件启用面', allPluginsOn ? 'plugin_set=*(全部插件都加载)' : 'plugin_set=' + pluginSet.join(','))
}

// ---- ④ 老插件 ----
lines.push(['', 'A 侧老插件 ' + OLD_CONFIG, ''])
if (!old) note('老插件配置', '读不到(可能已经卸了/停用了)')
else {
  const gw = old.gateway_enabled === true
  const rem = old.reminder_enabled === true
  const dbPath = String(old.db_path || '')
  // 配置说开着 ≠ 它在跑;权威答案在 AstrBot 自己的库里(上面那行「AstrBot 侧激活」)。
  note('AstrBot 侧激活', oldActive + '(' + activationSource + ')' + (oldActive === '否' ? ' —— 已停用,这正是切换后要的状态' : ''))
  if (oldActive === '否') {
    note('gateway_enabled', '还是 true,但插件没加载 —— 停用比关开关干净,这个值只是留着')
  } else {
    gw ? note('gateway_enabled', 'true —— 切换那天要整只停用它(不是只关这个开关)') : ok('gateway_enabled', 'false')
  }
  rem ? note('reminder_enabled', 'true —— 每 60s 扫一次,失败会每分钟重试(费调用)') : ok('reminder_enabled', 'false(不空转)')
  dbPath === ''
    ? ok('db_path', '空 = 它写自己的库(切换后那张库归档)')
    : bad('db_path', '指向 ' + dbPath + ' —— 它会继续往那边写,确认这是你要的')
}

// ---- ⑤ 基线 ----
lines.push(['', '验收基线 ' + BASELINE, ''])
if (!existsSync(BASELINE)) note('基线', '还没记(切换前跑 node scripts/relay-accept.mjs --snapshot)')
else {
  const b = readJson(BASELINE) || {}
  ok('基线', String(b.at || '?') + ' → ' + JSON.stringify(b.aSide || b))
}

// ---- 输出 ----
if (asJson) {
  console.log(JSON.stringify({ problems, notes, lines: lines.map((l) => l.join(' ')) }, null, 2))
} else {
  console.log('== R4 切换前自检(只读) ==')
  console.log('时间   ' + new Date().toISOString())
  for (const [mark, label, msg] of lines) {
    if (mark === '') { console.log(label); continue }
    console.log(mark + ' ' + label.padEnd(14) + ' ' + msg)
  }
  console.log('')
  if (problems.length === 0) console.log('  ✓ 三份配置对得上,可以切换')
  else {
    console.log('  ! 有 ' + problems.length + ' 项要处理:')
    for (const p of problems) console.log('    - ' + p)
  }
  if (notes.length > 0) {
    console.log('  · ' + notes.length + ' 条提醒(不是错,但切换那天要盯着):')
    for (const n of notes) console.log('    - ' + n)
  }
}
process.exit(problems.length === 0 ? 0 : 1)
