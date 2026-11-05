/**
 * 2026-10-01 阶段 2f:面板开关「给子代理开只读记忆工具」的**落盘与判定**电池。
 *
 * 他的裁定:「`memorySubagentTools` 的 true/false **应当也能在网页仪表盘里改**才对。」
 * 以前只能手改宿主配置(`$DSH_HOME/profiles/web/cordis.patch.yml`)。
 *
 * 这一套钉五件事(每一条都对应一种"看起来成了、其实没成"的失败形态):
 *   ① **默认关** —— 文件缺失/坏值/非严格布尔一律按关(纪律 ①:关 = 逐位不变);
 *   ② **写→读往返一致**,而且**持久**(换一个模块实例仍读得到);
 *   ③ **只动那一个键** —— 拨这个开关不许把电源/范围/调参/会话标签碰掉(它就是被
 *      `writeConfig` 的"保留未知字段"保护的,有反例就会静默丢配置);
 *   ④ **判定只有一处** —— 面板的三路读数与 `memoryToolsEnabled` 同源;来源标签对人话;
 *   ⑤ **写失败不静默** —— 落盘抛错必须上抛(端点回 500),而且目标文件保持原样
 *      (原子写的 `.tmp`+rename 保证不留半个文件)。
 *
 * ⚠️ 隔离纪律(照 `tests/toggle.test.js` 顶部的疤):`lib/toggle.js` 的 `CONFIG_PATH`
 * 是**模块级常量**,首次 import 时按当时的 `DSH_HOME` 定死 ⇒ 必须先隔离、
 * **动态** import;`memory-read-tools.js` 是纯件(零 fs),静态 import 安全。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MEMORY_TOOL_ENV, MEMORY_TOOL_CONFIG_KEY, memoryToolsEnabled,
  memoryToolSourceReport, memoryToolSourceLabel, SUBAGENT_MEMORY_TOOL_NAMES
} from '../lib/memory-read-tools.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// ⚠️ 一个进程**只建一个**隔离 home、只 import 一次 toggle.js:`CONFIG_PATH` 的父目录
// (`DATA_DIR`)在 `lib/persona.js` 里也是模块级常量,换 DSH_HOME 再 import 也不会变
// (persona.js 已缓存)⇒ "每个用例一个新临时目录"是假隔离。所以:一个 home,
// 用例之间靠 `resetConfig()` 把盘面清回出厂态。
const HOME = mkdtempSync(join(tmpdir(), 'echo-mt-panel-'))
process.env.DSH_HOME = HOME
const mod = await import('../lib/toggle.js')
const CONFIG_PATH = mod.CONFIG_PATH
assert.ok(CONFIG_PATH.startsWith(HOME),
  '测试的 CONFIG_PATH 没落在隔离 home 里 —— 它会改到真实配置:' + CONFIG_PATH)

/** 把盘面清回出厂态(没有 config.json ⇒ 全部默认值)。 */
function resetConfig () {
  rmSync(CONFIG_PATH, { recursive: true, force: true })
}
/** 当前盘面(没有文件就返回 null)。 */
function diskConfig () {
  return existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : null
}
after(() => { rmSync(HOME, { recursive: true, force: true }) })

// ─────────────────────────────────────────────────────────────
// ① 默认关(纪律 ①)
// ─────────────────────────────────────────────────────────────
test('① 默认关:文件不存在 / 坏 JSON / 非严格布尔 ⇒ 一律关', () => {
  resetConfig()
  assert.equal(mod.readMemoryTools(), false, '没有配置文件时必须关')
  assert.equal(memoryToolsEnabled({ env: {}, config: undefined, settings: mod.readMemoryToolSetting() }).on, false)

  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  // 非严格布尔:字符串 "true" / 数字 1 都不算开(与 memoryToolsEnabledFromConfig 同口径)
  for (const bad of ['"true"', '1', '"1"', 'null', '{}', '[]']) {
    writeFileSync(CONFIG_PATH, '{"' + MEMORY_TOOL_CONFIG_KEY + '": ' + bad + '}', 'utf8')
    assert.equal(mod.readMemoryTools(), false, JSON.stringify(bad) + ' 不该被当成开')
  }
  // 坏 JSON:fail-soft 回默认关(不许抛)
  writeFileSync(CONFIG_PATH, '{ 这不是 JSON', 'utf8')
  assert.equal(mod.readMemoryTools(), false)
  resetConfig()
})

// ─────────────────────────────────────────────────────────────
// ② 写→读往返 + 持久
// ─────────────────────────────────────────────────────────────
test('② 关→开→关三态往返一致,而且落盘可持久(重读盘面仍一致)', async () => {
  resetConfig()
  assert.equal(mod.readMemoryTools(), false, '起点:关')

  assert.equal(mod.setMemoryTools(true), true)
  assert.equal(mod.readMemoryTools(), true, '写 true 后该读到 true')
  const raw = diskConfig()
  assert.equal(raw[MEMORY_TOOL_CONFIG_KEY], true, '盘上必须是真布尔 true(不是字符串)')
  assert.equal(typeof raw.savedAt, 'string', 'writeConfig 的 savedAt 照旧')

  // 新模块实例 → 仍从盘上读到 true(持久性;CONFIG_PATH 同一份文件)
  const again = await import('../lib/toggle.js?mt=1')
  assert.equal(again.readMemoryTools(), true, '持久性:换个模块实例该还是开')

  assert.equal(mod.setMemoryTools(false), false)
  assert.equal(mod.readMemoryTools(), false, '再改回关')
  assert.equal(diskConfig()[MEMORY_TOOL_CONFIG_KEY], false)

  // 非严格布尔归一:传 'true' / 1 一律落到 false(与判定口径一致)
  mod.setMemoryTools('true')
  assert.equal(mod.readMemoryTools(), false, '非严格布尔不许被当成开')
  mod.setMemoryTools(1)
  assert.equal(mod.readMemoryTools(), false)
  resetConfig()
})

// ─────────────────────────────────────────────────────────────
// ③ 只动那一个键(不改其它设置)
// ─────────────────────────────────────────────────────────────
test('③ 拨这个开关不许碰掉电源 / 范围 / 调参 / 会话标签(逐键比对)', () => {
  resetConfig()
  // 先铺一份"别人的"配置:电源、范围、会话标签、调参
  mod.setEnabled(false, 'panel')
  mod.setScope('whitelist', 'panel')
  mod.setSessionLabel('sess-1', 'QQ:私聊')
  mod.writeSettings({ auditKeep: 321, injectTopK: 5 })
  const before = diskConfig()

  mod.setMemoryTools(true, 'panel')

  const after = diskConfig()
  // 除了那一个键、它那对来源标记(`…By`/`…At`),与 writeConfig 自带的 savedAt,
  // 整份配置逐键相同。★ 2026-10-01 尾:标记对是本次事故后新加的("开"必须留痕,
  // 见 lib/toggle.js 上方),所以它**只能由这个开关来动**。
  const skip = new Set([MEMORY_TOOL_CONFIG_KEY, MEMORY_TOOL_CONFIG_KEY + 'By',
    MEMORY_TOOL_CONFIG_KEY + 'At', 'savedAt'])
  for (const k of Object.keys({ ...before, ...after })) {
    if (skip.has(k)) continue
    assert.deepEqual(after[k], before[k], '键 ' + k + ' 被这个开关改掉了')
  }
  assert.equal(after[MEMORY_TOOL_CONFIG_KEY], true)
  // ★ 留痕必须真的落盘
  assert.equal(after[MEMORY_TOOL_CONFIG_KEY + 'By'], 'panel', '拨动没留下"谁拨的"')
  assert.ok(Number(after[MEMORY_TOOL_CONFIG_KEY + 'At']) > 0, '拨动没留下"什么时候"')
  assert.equal(after.enabled, false, '电源没被碰')
  assert.equal(after.scope, 'whitelist')
  assert.equal(after.settings.auditKeep, 321)
  assert.equal(after.settings.injectTopK, 5)

  // 反过来:拨电源 / 存调参也不许把这个开关抹掉
  mod.setEnabled(true, 'panel')
  mod.writeSettings({ auditKeep: 100 })
  assert.equal(mod.readMemoryTools(), true, '别的写口把这个开关抹掉了')
  assert.equal(mod.readMemoryToolsFlip().by, 'panel', '别的写口把来源标记抹掉了')
  resetConfig()
})

// ─────────────────────────────────────────────────────────────
// ④ 判定只有一处 + 三路读数 + 来源人话
// ─────────────────────────────────────────────────────────────
test('④ 三路 OR:env / 宿主配置 / 面板开关各报各的,总读数与 source 同源', () => {
  resetConfig()
  // 三路全空 = 关
  let r = memoryToolSourceReport({ env: {}, config: {}, settings: mod.readMemoryToolSetting() })
  assert.deepEqual(r, { on: false, source: 'off', env: false, config: false, settings: false })
  assert.equal(memoryToolSourceLabel(r.source), '关(三路都没开)')

  // 面板开关这一路(真写盘 → 再读)
  mod.setMemoryTools(true)
  r = memoryToolSourceReport({ env: {}, config: {}, settings: mod.readMemoryToolSetting() })
  assert.equal(r.settings, true, '面板开关必须落进 settings 那一份')
  assert.equal(r.on, true)
  assert.equal(r.source, 'settings:' + MEMORY_TOOL_CONFIG_KEY)
  assert.match(memoryToolSourceLabel(r.source), /面板开关/)

  // env 路(优先级最高)
  r = memoryToolSourceReport({
    env: { [MEMORY_TOOL_ENV]: '1' }, config: {}, settings: mod.readMemoryToolSetting()
  })
  assert.equal(r.on, true)
  assert.equal(r.source, 'env:' + MEMORY_TOOL_ENV)
  assert.match(memoryToolSourceLabel(r.source), /环境变量/)

  // 宿主配置那一路
  r = memoryToolSourceReport({ env: {}, config: { [MEMORY_TOOL_CONFIG_KEY]: true }, settings: {} })
  assert.equal(r.source, 'loader-config:' + MEMORY_TOOL_CONFIG_KEY)
  assert.match(memoryToolSourceLabel(r.source), /cordis\.patch\.yml/)

  // 判定只有一处:报告里的 on 必须与共享函数逐字一致(含各种脏值)
  for (const parts of [
    { env: {}, config: {}, settings: {} },
    { env: { [MEMORY_TOOL_ENV]: '0' }, config: {}, settings: {} },
    { env: {}, config: { [MEMORY_TOOL_CONFIG_KEY]: 'true' }, settings: {} },
    { env: {}, config: {}, settings: { [MEMORY_TOOL_CONFIG_KEY]: 1 } }
  ]) {
    assert.equal(memoryToolSourceReport(parts).on, memoryToolsEnabled(parts).on)
    assert.equal(memoryToolSourceReport(parts).source, memoryToolsEnabled(parts).source)
  }
  resetConfig()
})

test('④b readMemoryToolSetting 只是"调参设置 ⊕ 面板开关",调参键一个不少', () => {
  resetConfig()
  const merged = mod.readMemoryToolSetting()
  assert.equal(merged[MEMORY_TOOL_CONFIG_KEY], false, '默认关')
  // 调参那一份的键都在(合成不许把 settings 拍平/丢键)
  for (const k of Object.keys(mod.SETTINGS_DEFAULTS)) {
    assert.ok(k in merged, '合成后丢了调参键:' + k)
  }
  assert.equal(merged.auditKeep, mod.SETTINGS_DEFAULTS.auditKeep)
  mod.setMemoryTools(true)
  assert.equal(mod.readMemoryToolSetting()[MEMORY_TOOL_CONFIG_KEY], true)
  resetConfig()
})

// ─────────────────────────────────────────────────────────────
// ⑤ 写失败不静默
// ─────────────────────────────────────────────────────────────
test('⑤ 落盘失败必须上抛(端点据此回 500),而且原文件一个字节不动', () => {
  resetConfig()
  mod.setMemoryTools(false)
  const before = readFileSync(CONFIG_PATH, 'utf8')
  // 让原子写的 `.tmp` 落不下去:把它占成一个目录 ⇒ writeFileSync 抛错
  const blocker = CONFIG_PATH + '.tmp'
  mkdirSync(blocker, { recursive: true })
  assert.equal(existsSync(blocker), true)

  let threw = false
  try { mod.setMemoryTools(true) } catch { threw = true }
  assert.equal(threw, true, '写失败被静默吞掉了 —— 面板会显示"已开"而盘上没变')
  rmSync(blocker, { recursive: true, force: true })
  assert.equal(readFileSync(CONFIG_PATH, 'utf8'), before, '失败后原文件被改脏了(原子写没守住)')
  assert.equal(mod.readMemoryTools(), false)
  resetConfig()
})

// ─────────────────────────────────────────────────────────────
// 端点契约(源码级,和这个仓既有的"契约电池"同款做法)
// ─────────────────────────────────────────────────────────────
test('⑥ 端点契约:写保护 + 严格布尔 + 落盘后**当场**重算(立即生效)', () => {
  const src = readFileSync(join(repoRoot, 'lib', 'index.js'), 'utf8')
  const i = src.indexOf("path: '/api/echo/memory-tools'")
  assert.ok(i > 0, '没有 /api/echo/memory-tools 这条路由')
  const body = src.slice(i, i + 2200)
  assert.match(body, /writeAllowed\(req\)/, '写口必须过 writeAllowed(回环 Origin + x-echo-edit)')
  assert.match(body, /typeof body\.enabled !== 'boolean'/, '必须只认严格布尔(否则"打开"与"真的开"成了两回事)')
  assert.match(body, /setMemoryTools\(body\.enabled, 'panel'\)/,
    '必须走 toggle.setMemoryTools 落盘**并**留下 by=panel 的来源标记')
  assert.match(body, /syncSubagentMemoryTools\('panel'\)/, '落盘后必须当场重算/重挂 —— 这就是"立即生效"')
  // 落盘与重挂的顺序:先写盘,再对齐真实状态
  assert.ok(body.indexOf("setMemoryTools(body.enabled, 'panel')") < body.indexOf("syncSubagentMemoryTools('panel')"))
  // ★ 2026-10-01 尾:来源标记要读出来给面板看(读数在 `memoryToolsState()` 里组装,
  // 在路由注册之前 ⇒ 查整份源码,不查路由那一段切片)
  assert.match(src, /readMemoryToolsFlip/, '端点没有把来源标记读出来')
  assert.match(src, /flipLabel/, '状态里没有"谁在什么时候拨的"这句人话')
  // 判定不许另写一份:index.js 里没有第二个 OR 判定
  assert.equal(/memoryToolsEnabledFromConfig\s*\(/.test(src), false, 'index.js 里另写了一份配置判定')
})

test('⑥b 前端两处都打同一批端点,且都不自己编造开关状态', () => {
  const client = readFileSync(join(repoRoot, 'lib', 'client.js'), 'utf8')
  const app = readFileSync(join(repoRoot, 'web', 'app.js'), 'utf8')
  for (const [what, src] of [['设置区卡片', client], ['网页仪表盘', app]]) {
    assert.ok(src.includes('/api/echo/memory-tools'), what + ' 没打这个端点')
    assert.match(src, /已?注册 [^']*工具|registered/, what + ' 没显示"真挂上了没有"')
    assert.ok(src.includes('x-echo-edit'), what + ' 的 POST 少了 x-echo-edit(会被 403)')
    // ★ 2026-10-01 尾:两处前端都得显示「谁在什么时候拨的」(只写不显示 = 白留痕)
    assert.match(src, /开关留痕/, what + ' 没显示"谁在什么时候拨的"')
    assert.match(src, /flipLabel/, what + ' 没读来源标记')
  }
  // 名字必须是那 4 个(与 SUBAGENT_MEMORY_TOOL_NAMES 同源,不在面板里另抄一份)
  assert.equal(SUBAGENT_MEMORY_TOOL_NAMES.length, 4)
  assert.match(app, /memory_search/)
})
