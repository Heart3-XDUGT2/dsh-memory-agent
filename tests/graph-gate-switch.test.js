/**
 * 2026-10-01 阶段 4:面板开关「每写一条新记忆就自动挖影子边」的**落盘与判定**电池。
 *
 * 他的裁定:「把"运行时自动挖边"也做成能在网页仪表盘拨、拨了立即生效的开关
 * (默认关,不改任何现有行为)。」
 *
 * 这一套钉六件事(每条对应一种"看起来成了、其实没成"的失败形态):
 *   ① **默认关** —— 文件缺失/坏值/非严格布尔一律按关(关 = 逐位不变);
 *   ② **写→读往返一致 + 持久**(换个模块实例仍读得到);
 *   ③ **只动那一个键** —— 不许把电源/范围/调参/会话标签/隔壁那个开关碰掉;
 *   ④ **三路 OR + 来源人话**,而且 env 优先(不许被配置层顶掉);
 *   ⑤ **写失败不静默**(端点回 500),原文件一个字节不动;
 *   ⑥ **引擎侧同字**:同一个键名/同一个文件路径在 Python 那边有镜像常量
 *      (两侧字符串对不上 ⇒ 面板拨了引擎不认,还会一片绿)。
 *
 * ⚠️ 隔离纪律(照 tests/memory-tools-panel.test.js / toggle.test.js 顶部的疤):
 * `lib/toggle.js` 的 `CONFIG_PATH` 是**模块级常量**,首次 import 时按当时的
 * `DSH_HOME` 定死 ⇒ 必须先隔离、**动态** import;`lib/graph-gate.js` 是纯件(零 fs),
 * 静态 import 安全。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GRAPH_GATE_ENV, GRAPH_GATE_CONFIG_KEY, graphGateEnabled, graphGateEnabledFromEnv,
  graphGateEnabledFromConfig, graphGateSourceReport, graphGateSourceLabel,
  flipByLabel, flipProvenanceLabel
} from '../lib/graph-gate.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// 一个进程只建一个隔离 home、只 import 一次 toggle.js(CONFIG_PATH 是模块级常量)。
const HOME = mkdtempSync(join(tmpdir(), 'echo-gg-panel-'))
process.env.DSH_HOME = HOME
const mod = await import('../lib/toggle.js')
const CONFIG_PATH = mod.CONFIG_PATH
assert.ok(CONFIG_PATH.startsWith(HOME),
  '测试的 CONFIG_PATH 没落在隔离 home 里 —— 它会改到真实配置:' + CONFIG_PATH)

function resetConfig () { rmSync(CONFIG_PATH, { recursive: true, force: true }) }
function diskConfig () {
  return existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : null
}
after(() => { rmSync(HOME, { recursive: true, force: true }) })

// ─────────────────────────────────────────────────────────────
// ① 默认关(纪律 ①)
// ─────────────────────────────────────────────────────────────
test('① 默认关:文件不存在 / 坏 JSON / 非严格布尔 ⇒ 一律关', () => {
  resetConfig()
  assert.equal(mod.readGraphShadowEdges(), false, '没有配置文件时必须关')
  const r = graphGateEnabled({
    env: {}, config: {}, settings: mod.readGraphShadowEdgeSetting()
  })
  assert.deepEqual(r, { on: false, source: 'off' }, '三路全空必须关')

  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  for (const bad of ['"true"', '1', '"1"', 'null', '{}', '[]']) {
    writeFileSync(CONFIG_PATH, '{"' + GRAPH_GATE_CONFIG_KEY + '": ' + bad + '}', 'utf8')
    assert.equal(mod.readGraphShadowEdges(), false, JSON.stringify(bad) + ' 不该被当成开')
  }
  writeFileSync(CONFIG_PATH, '{ 这不是 JSON', 'utf8')
  assert.equal(mod.readGraphShadowEdges(), false, '坏 JSON ⇒ 关(fail-soft)')
  resetConfig()
})

// ─────────────────────────────────────────────────────────────
// ② 写→读往返 + 持久
// ─────────────────────────────────────────────────────────────
test('② 关→开→关三态往返一致,落盘可持久(重读盘面仍一致)', async () => {
  resetConfig()
  assert.equal(mod.readGraphShadowEdges(), false, '起点:关')

  assert.equal(mod.setGraphShadowEdges(true), true)
  assert.equal(mod.readGraphShadowEdges(), true, '写 true 后该读到 true')
  const raw = diskConfig()
  assert.equal(raw[GRAPH_GATE_CONFIG_KEY], true, '盘上必须是真布尔 true(不是字符串)')
  assert.equal(typeof raw.savedAt, 'string', 'writeConfig 的 savedAt 照旧')

  const again = await import('../lib/toggle.js?gg=1')
  assert.equal(again.readGraphShadowEdges(), true, '持久性:换个模块实例该还是开')

  assert.equal(mod.setGraphShadowEdges(false), false)
  assert.equal(mod.readGraphShadowEdges(), false, '再改回关')
  assert.equal(diskConfig()[GRAPH_GATE_CONFIG_KEY], false)

  mod.setGraphShadowEdges('true')       // 非严格布尔归一 ⇒ false(与判定口径一致)
  assert.equal(mod.readGraphShadowEdges(), false, '非严格布尔不许被当成开')
  mod.setGraphShadowEdges(1)
  assert.equal(mod.readGraphShadowEdges(), false)
  resetConfig()
})

// ─────────────────────────────────────────────────────────────
// ③ 只动那一个键
// ─────────────────────────────────────────────────────────────
test('③ 拨这个开关不许碰掉电源 / 范围 / 调参 / 会话标签 / 隔壁开关(逐键比对)', () => {
  resetConfig()
  mod.setEnabled(false, 'panel')
  mod.setScope('whitelist', 'panel')
  mod.setSessionLabel('sess-1', 'QQ:私聊')
  mod.writeSettings({ auditKeep: 321, injectTopK: 5 })
  mod.setMemoryTools(true)                 // 隔壁那个开关也得留着
  const before = diskConfig()

  mod.setGraphShadowEdges(true, 'tool')

  const after = diskConfig()
  // 白名单 = 这个开关**自己的**四个键:值 + 它那对来源标记(`…By`/`…At`)+ writeConfig 的
  // savedAt。★ 2026-10-01 尾:标记对是本次事故后新加的("开"必须留痕,见 lib/toggle.js
  // 上方),所以它**只能由这个开关来动**;别的键一个都不许变(下面逐键比)。
  const skip = new Set([GRAPH_GATE_CONFIG_KEY, GRAPH_GATE_CONFIG_KEY + 'By',
    GRAPH_GATE_CONFIG_KEY + 'At', 'savedAt'])
  for (const k of Object.keys({ ...before, ...after })) {
    if (skip.has(k)) continue
    assert.deepEqual(after[k], before[k], '键 ' + k + ' 被这个开关改掉了')
  }
  assert.equal(after[GRAPH_GATE_CONFIG_KEY], true)
  // ★ 留痕必须真的落盘(不能只是接口返回里编一个)
  assert.equal(after[GRAPH_GATE_CONFIG_KEY + 'By'], 'tool', '拨动没留下"谁拨的"')
  assert.ok(Number(after[GRAPH_GATE_CONFIG_KEY + 'At']) > 0, '拨动没留下"什么时候"')
  assert.equal(after.enabled, false, '电源没被碰')
  assert.equal(after.scope, 'whitelist')
  assert.equal(after.settings.auditKeep, 321)
  assert.equal(after[mod.MEMORY_TOOL_CONFIG_KEY ?? 'memorySubagentTools'], true, '隔壁开关被碰掉了')

  // 反过来:拨电源 / 存调参 / 拨隔壁开关也不许把这个开关抹掉
  mod.setEnabled(true, 'panel')
  mod.writeSettings({ auditKeep: 100 })
  mod.setMemoryTools(false)
  assert.equal(mod.readGraphShadowEdges(), true, '别的写口把这个开关抹掉了')
  assert.equal(mod.readGraphShadowEdgesFlip().by, 'tool', '别的写口把来源标记抹掉了')
  resetConfig()
})

// ─────────────────────────────────────────────────────────────
// ④ 三路 OR + 来源人话 + env 优先
// ─────────────────────────────────────────────────────────────
test('④ 三路 OR:env / 宿主配置 / 面板开关各报各的,总读数与 source 同源', () => {
  resetConfig()
  let r = graphGateSourceReport({ env: {}, config: {}, settings: mod.readGraphShadowEdgeSetting() })
  assert.deepEqual(r, { on: false, source: 'off', env: false, config: false, settings: false })
  assert.equal(graphGateSourceLabel(r.source), '关(三路都没开)')

  // 面板开关这一路(真写盘 → 再读)
  mod.setGraphShadowEdges(true)
  r = graphGateSourceReport({ env: {}, config: {}, settings: mod.readGraphShadowEdgeSetting() })
  assert.equal(r.settings, true, '面板开关必须落进 settings 那一份')
  assert.equal(r.on, true)
  assert.equal(r.source, 'settings:' + GRAPH_GATE_CONFIG_KEY)
  assert.match(graphGateSourceLabel(r.source), /面板/)

  // env 路(优先级最高)
  r = graphGateSourceReport({
    env: { [GRAPH_GATE_ENV]: '1' }, config: {}, settings: mod.readGraphShadowEdgeSetting()
  })
  assert.equal(r.source, 'env:' + GRAPH_GATE_ENV)
  assert.match(graphGateSourceLabel(r.source), /环境变量/)

  // 宿主配置那一路
  r = graphGateSourceReport({ env: {}, config: { [GRAPH_GATE_CONFIG_KEY]: true }, settings: {} })
  assert.equal(r.source, 'loader-config:' + GRAPH_GATE_CONFIG_KEY)
  assert.match(graphGateSourceLabel(r.source), /cordis\.patch\.yml/)

  // 判定只有一处:报告里的 on/source 必须与共享函数逐字一致(含脏值)
  for (const parts of [
    { env: {}, config: {}, settings: {} },
    { env: { [GRAPH_GATE_ENV]: '0' }, config: {}, settings: {} },
    { env: { [GRAPH_GATE_ENV]: 'true' }, config: {}, settings: {} },
    { env: {}, config: { [GRAPH_GATE_CONFIG_KEY]: 'true' }, settings: {} },
    { env: {}, config: {}, settings: { [GRAPH_GATE_CONFIG_KEY]: 1 } }
  ]) {
    assert.equal(graphGateSourceReport(parts).on, graphGateEnabled(parts).on)
    assert.equal(graphGateSourceReport(parts).source, graphGateEnabled(parts).source)
  }
  resetConfig()
})

test('④b env 读数与引擎 `_truthy` 逐字同口径(否则面板与实际会两回事)', () => {
  // 引擎侧:`str(raw).strip().lower() in ("1","true","on","yes")` —— 这一套必须同字,
  // 不然 `ECHO_GRAPH_GATE=true` 会出现"面板显示关、引擎在挖边"。
  for (const v of ['1', 'true', 'TRUE', 'On', 'on', 'yes', ' 1 ']) {
    assert.equal(graphGateEnabledFromEnv({ [GRAPH_GATE_ENV]: v }), true, String(v) + ' 该算开')
  }
  for (const v of [undefined, null, '', '0', 'no', 'false', 'off', '2', 'yes!']) {
    assert.equal(graphGateEnabledFromEnv({ [GRAPH_GATE_ENV]: v }), false,
      String(v) + ' 不该被当成 env 开')
  }
  assert.equal(graphGateEnabledFromConfig({ [GRAPH_GATE_CONFIG_KEY]: true }), true)
  assert.equal(graphGateEnabled({ env: { [GRAPH_GATE_ENV]: '1' }, config: {}, settings: {} }).on, true)
  assert.equal(graphGateEnabled({ env: { [GRAPH_GATE_ENV]: '1' },
    config: { [GRAPH_GATE_CONFIG_KEY]: false }, settings: {} }).source, 'env:' + GRAPH_GATE_ENV)
})

// ─────────────────────────────────────────────────────────────
// ⑤ 写失败不静默
// ─────────────────────────────────────────────────────────────
test('⑤ 落盘失败必须上抛(端点据此回 500),原文件一个字节不动', () => {
  resetConfig()
  mod.setGraphShadowEdges(false)
  const before = readFileSync(CONFIG_PATH, 'utf8')
  const blocker = CONFIG_PATH + '.tmp'
  mkdirSync(blocker, { recursive: true })

  let threw = false
  try { mod.setGraphShadowEdges(true) } catch { threw = true }
  assert.equal(threw, true, '写失败被静默吞掉了 —— 面板会显示"已开"而盘上没变')
  rmSync(blocker, { recursive: true, force: true })
  assert.equal(readFileSync(CONFIG_PATH, 'utf8'), before, '失败后原文件被改脏了')
  assert.equal(mod.readGraphShadowEdges(), false)
  resetConfig()
})

// ─────────────────────────────────────────────────────────────
// ⑥ 端点 + 两处前端 + 引擎侧同字(源码级契约电池)
// ─────────────────────────────────────────────────────────────
test('⑥ 端点契约:写保护 + 严格布尔 + 落盘即全部动作(引擎下一帧现读)', () => {
  const src = readFileSync(join(repoRoot, 'lib', 'index.js'), 'utf8')
  const i = src.indexOf("path: '/api/echo/graph-gate'")
  assert.ok(i > 0, '没有 /api/echo/graph-gate 这条路由')
  const body = src.slice(i, i + 2200)
  assert.match(body, /writeAllowed\(req\)/, '写口必须过 writeAllowed')
  assert.match(body, /typeof body\.enabled !== 'boolean'/, '必须只认严格布尔')
  // ★ 2026-10-01 尾:面板这一路必须**留下来源标记**(by='panel')—— 事故驱动:
  // 21:33 那个 true 谁都说不清是哪只手拨的。少传 by 就是又回到"没人说得清"。
  assert.match(body, /setGraphShadowEdges\(body\.enabled, 'panel'\)/,
    '必须走 toggle.setGraphShadowEdges 落盘**并**留下 by=panel 的来源标记')
  // 来源标记必须被**读出来给面板看**(只写不读 = 留痕白留)。读数在 `graphGateState()`
  // 里组装(在路由注册之前),所以这两条查整份源码,不查路由那一段切片。
  assert.match(src, /readGraphShadowEdgesFlip/, '端点没有把来源标记读出来')
  assert.match(src, /flipLabel/, '状态里没有"谁在什么时候拨的"这句人话')
  // 消费者在引擎侧 ⇒ POST 里**不该**有工具注册/摘除(那是隔壁那张卡的事)
  assert.equal(/ctx\.tools\.register/.test(body), false, '这张卡不该动态挂工具')
  // loader 配置那一路必须落成文件引擎才看得见,而且同样要留痕
  assert.match(src, /graphGateEnabledFromConfig\(pluginConfig\)/, 'loader 那一路没同步进插件设置文件')
  assert.match(src, /setGraphShadowEdges\(true, 'loader-config'\)/,
    'loader 那一路同步时没留下 by=loader-config 的来源标记')
  // 壳侧不许提引擎模块的名字(既有纪律:壳与 engine 模块解耦)
  assert.equal(src.includes('graph_gate'), false, 'index.js 里出现了引擎模块名')
})

test('⑥b 两处前端都打同一批端点,而且风险提示句必须在', () => {
  const client = readFileSync(join(repoRoot, 'lib', 'client.js'), 'utf8')
  const app = readFileSync(join(repoRoot, 'web', 'app.js'), 'utf8')
  const html = readFileSync(join(repoRoot, 'web', 'index.html'), 'utf8')
  for (const [what, src] of [['设置区卡片', client], ['网页仪表盘', app]]) {
    assert.ok(src.includes('/api/echo/graph-gate'), what + ' 没打这个端点')
    assert.ok(src.includes('x-echo-edit'), what + ' 的 POST 少了 x-echo-edit(会被 403)')
    assert.match(src, /graph_shadow_edges/, what + ' 没说清边写到哪张表')
    assert.match(src, /立即生效/, what + ' 没写"拨一下立即生效"')
    assert.match(src, /DELETE FROM graph_shadow_edges/, what + ' 没给一行回退')
    // ★ 2026-10-01 尾:两处前端都必须把「谁在什么时候拨的」显示出来(只写不显示 = 白留痕)
    assert.match(src, /开关留痕/, what + ' 没显示"谁在什么时候拨的"')
    assert.match(src, /flipLabel/, what + ' 没读来源标记')
  }
  // 独立容器(不许混进 #cfg-form:那一格的输入框数被 web 测试钉死)
  assert.ok(html.includes('id="cfg-gt"'), '网页没有 #cfg-gt 容器')
  const mtAt = html.indexOf('id="cfg-mt"')
  const formAt = html.indexOf('id="cfg-form"')
  assert.ok(html.indexOf('id="cfg-gt"') > mtAt && html.indexOf('id="cfg-gt"') < formAt,
    '#cfg-gt 的位置不对(应在 #cfg-mt 与 #cfg-form 之间)')
})

test('⑥c 引擎侧的键名与路径必须与壳侧**同字**(否则拨了引擎不认,还一片绿)', () => {
  const py = readFileSync(join(repoRoot, 'python', 'engine', 'graph_gate.py'), 'utf8')
  assert.match(py, /^SWITCH_CONFIG_KEY = "graphShadowEdges"$/m,
    '引擎侧键名与壳侧 GRAPH_GATE_CONFIG_KEY 不一致')
  assert.match(py, /^SWITCH_ENV = "ECHO_GRAPH_GATE"$/m, '引擎侧 env 名对不上')
  assert.equal(GRAPH_GATE_CONFIG_KEY, 'graphShadowEdges')
  assert.equal(GRAPH_GATE_ENV, 'ECHO_GRAPH_GATE')
  // 路径推法:与 lib/persona.js 的 DATA_DIR 同一条($DSH_HOME ?? ~/.dsh)+ /echo/config.json
  assert.match(py, /def switch_config_path\(env=None\)/, '没有路径解析函数')
  assert.match(py, /"echo", "config\.json"/, '引擎侧的路径拼法不对')
  assert.match(py, /DSH_HOME/, '引擎侧没认 DSH_HOME(那就读不到面板写的那个文件)')
  // env 真值口径两侧同字(引擎:1/true/on/yes;壳侧同款,见 graph-gate.js 注释)
  assert.match(py, /in \("1", "true", "on", "yes"\)/, '引擎侧的 env 真值口径变了?壳侧要对齐')
})

// ─────────────────────────────────────────────────────────────
// ⑦ 留痕(2026-10-01 尾,事故驱动):「谁在什么时候开的」要说得清
// ─────────────────────────────────────────────────────────────
test('⑦ 来源标记:写入端留痕、读出口拿得到、老配置如实说「没记来源」', () => {
  // 纯函数那一层:人话映射(不参与判定)、老配置不猜
  assert.equal(flipByLabel(''), '(没记来源)')
  assert.match(flipByLabel('panel'), /面板/)
  assert.match(flipByLabel('loader-config'), /宿主配置/)
  assert.match(flipProvenanceLabel({ by: '', at: 0 }), /没记来源/)
  // 老配置(加标记之前写的)⇒ 如实说是"没记",不许猜成"没人拨过"
  assert.match(flipProvenanceLabel(undefined), /没记来源/)
  // 有标记 ⇒ 谁 + 什么时候(月-日 时:分)
  const when = new Date(2026, 9, 1, 21, 33).getTime() / 1000
  assert.equal(flipProvenanceLabel({ by: 'panel', at: when }), '网页面板 · 10-01 21:33')

  // 写→读一整条链(真文件:隔离 home 里的 config.json)
  resetConfig()
  assert.deepEqual(mod.readGraphShadowEdgesFlip(), { by: '', at: 0 }, '起点:没记来源')
  const t0 = Math.floor(Date.now() / 1000)
  mod.setGraphShadowEdges(true, 'panel')
  const flip = mod.readGraphShadowEdgesFlip()
  assert.equal(flip.by, 'panel')
  assert.ok(flip.at >= t0 && flip.at <= Math.floor(Date.now() / 1000), 'at 该是刚写下的 epoch 秒')
  // 关掉也要留痕(关也是"谁在什么时候"的一部分:否则又说不清是谁关的)
  mod.setGraphShadowEdges(false, 'panel')
  assert.equal(mod.readGraphShadowEdgesFlip().by, 'panel')
  assert.equal(mod.readGraphShadowEdges(), false)
  // 非严格布尔归一成 false,但仍留痕(别让 by 与值对不上时静默)
  mod.setGraphShadowEdges('true', 'api')
  assert.equal(mod.readGraphShadowEdges(), false, '非严格布尔不许被当成开')
  assert.equal(mod.readGraphShadowEdgesFlip().by, 'api')
  // by 超长要截断(别把一条人话塞进配置文件)
  mod.setGraphShadowEdges(true, 'x'.repeat(80))
  assert.equal(mod.readGraphShadowEdgesFlip().by.length, 24)
  resetConfig()
})
