/**
 * 真调用冒烟 —— **不是语法检查**,是把每个 lib 模块真的 import 一遍、把心跳真的 tick 三拍。
 *
 * 为什么需要它(2026-09-28 夜,真实事故):
 *   我挪代码时把一段文档注释的收尾 `*​/` 一起搬走了,`lib/heartbeat.js` 里 createHeartbeat
 *   的**函数体被注释掉一大截**(`let ticking` 因此消失)。`node --check` **只查语法,完全看不出来**;
 *   单元测试没跑到那条分支也看不出来。结果:宿主一加载插件就
 *   `fatal load failure: ReferenceError: ticking is not defined`,他的 dsh 直接起不来。
 *
 *   ⇒ 纪律:**改完 lib/ 里的模块,必须跑这个**(`npm run check` 里已挂)。
 *   ⇒ 它的价值就在"真的调用一次"这四个字 —— 断言可以少,调用不能省。
 *
 * **闸咬得住吗(2026-09-28 夜亲自做过负控,不是自称)**:
 *   把那个 bug 的**形状**原样注入回去(一段注释吞掉 createHeartbeat 里 2281 字节的函数体,
 *   让注释在后面正常收尾 ⇒ **语法仍然合法**):
 *     · `node --check lib/heartbeat.js` → **exit 0(完全看不出来,当晚就是这么被它骗过的)**
 *     · 本冒烟 → **exit 1**(import 期就报 Illegal return,心跳那条也拿不到 createHeartbeat)
 *   顺带测到:`tests/heartbeat.test.js` + `tests/care-beats.test.js` 也会红(11 过 37 败)——
 *   但那是**运气好,这两套正好跑到了那条路**;冒烟的价值是一次性覆盖**全部 54 个模块**,
 *   不用为每个模块的分支都写一条单测,而且语法检查永远抓不到这一类。
 *
 * 只跑内存里的假件,不碰真库、不发网络请求。
 */
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')
const fails = []
const note = (ok, what, detail = '') => {
  console.log((ok ? '  ok   ' : '  FAIL ') + what + (detail === '' ? '' : ' —— ' + detail))
  if (!ok) fails.push(what + (detail === '' ? '' : ':' + detail))
}

// ---- ① 每个 lib 模块都得 import 得动(import 期的炸也会在这里现形)----
// 例外:`lib/client.js` 是**浏览器侧**代码(用到 window),Node 里 import 不了是正常的 ——
// 它的冒烟在 web 那套测试里。写清楚例外,不靠"反正它红了也习惯"。
const BROWSER_ONLY = new Set(['client.js'])
const files = readdirSync(libDir).filter((f) => f.endsWith('.js')).sort()
const mods = {}
for (const f of files) {
  try {
    mods[f] = await import(new URL('../lib/' + f, import.meta.url).href)
    note(true, 'import lib/' + f)
  } catch (e) {
    if (BROWSER_ONLY.has(f)) {
      console.log('  info import lib/' + f + ' 跳过(浏览器侧模块,Node 里本来就不能 import)')
      continue
    }
    note(false, 'import lib/' + f, String(e?.message ?? e))
  }
}

// ---- ② 心跳:三拍真 tick(空 / 有他到点的约定 / 有她过期的闹钟)----
const H = 3600
const NOW_SEC = 1_800_000_000
const { createHeartbeat } = mods['heartbeat.js'] ?? {}
if (typeof createHeartbeat !== 'function') {
  note(false, 'heartbeat.createHeartbeat 拿得到')
} else {
  const makeStore = (over = {}) => ({
    wakesDue: () => [],
    wakeFired: () => {},
    careBeatAdd: () => 1,
    careCountSince: () => 0,
    careBeatsSince: () => [],
    getState: () => ({}),
    writeAudit: () => {},
    recentUserTurnAt: () => 0,
    ...over
  })
  const makeEngine = (over = {}) => ({
    threadsRemindable: async () => ({ items: [] }),
    threadsMark: async () => {},
    longingTick: async () => {},
    longing: async () => null,
    agendaPick: async () => null,
    agendaMark: async () => {},
    longingCare: async () => {},
    ...over
  })
  const hbWith = (engine, store) => createHeartbeat({
    engine,
    store,
    logger: { info: () => {}, warn: () => {} },
    isEnabled: () => true,
    isSessionEnabled: () => true,
    createUserMessage: (m) => ({ role: 'user', ...m }),
    masterId: '10001',
    getStaleHours: () => 24,
    getUserSpokeAt: () => 0,
    now: () => NOW_SEC * 1000
  })
  const agent = { session: { id: 'smoke-sess' }, followup: () => {}, runMaintenance: (cb) => Promise.resolve(cb()).then(() => true) }

  // ②-1 空拍(最常用的一条路)
  try {
    await hbWith(makeEngine(), makeStore()).tick(agent)
    note(true, 'tick 空拍(没有到点的事)')
  } catch (e) { note(false, 'tick 空拍', String(e?.message ?? e)) }

  // ②-2 他到点的约定 ⇒ 走提醒通道(C5 的 isRemindStale 就在这条路上)
  try {
    const engine = makeEngine({ threadsRemindable: async () => ({ items: [{ session_id: 'smoke-sess', thread_id: 7, due_at: NOW_SEC - 60 }] }) })
    await hbWith(engine, makeStore()).tick(agent)
    note(true, 'tick 提醒通道(他到点的约定)')
  } catch (e) { note(false, 'tick 提醒通道', String(e?.message ?? e)) }

  // ②-3 她一个**过期很久**的闹钟 ⇒ 走 C5 的 stale-drop 分支(最容易只写了一半的路)
  try {
    const store = makeStore({ wakesDue: () => [{ id: 1, at: NOW_SEC - 30 * H, text: '提醒他喝药', session_id: 'smoke-sess' }] })
    await hbWith(makeEngine(), store).tick(agent)
    note(true, 'tick 闹钟通道(过期作废,留账)')
  } catch (e) { note(false, 'tick 闹钟通道', String(e?.message ?? e)) }
}

// ---- ③ 几个有分支的纯件:真调一次(空参也要能出结果)----
const pure = [
  ['care-report.js', 'describeReason', (m) => m.describeReason('stale-drop') !== m.UNKNOWN_REASON_TEXT, '过期作废有人话文案'],
  ['alias-rewrite.js', 'rewriteRetiredAliases', (m) => m.rewriteRetiredAliases('<称呼>在吗', { current: '<称呼>', retired: ['阿澈'] })?.text !== undefined, '旧称呼改写能跑'],
  ['external-event.js', 'parseExternalEvent', (m) => m.parseExternalEvent({ kind: 'sensor', text: '门开了' }, NOW_SEC * 1000)?.ok === true, '外部事件能解析'],
  ['diary.js', 'planDiaryTick', (m) => m.planDiaryTick({ nowMs: NOW_SEC * 1000, lastDateKey: '', failCount: 0, retryAtMs: 0, maxDays: 7 })?.action !== undefined, '日记补写能规划'],
  ['tool-audit.js', 'createToolAudit', (m) => typeof m.createToolAudit === 'function', '工具审计能创建'],
  ['turn-trace.js', 'createTurnTrace', (m) => typeof m.createTurnTrace === 'function', 'turn trace 能创建'],
  ['inject-probe.js', 'createInjectProbe', (m) => m.createInjectProbe().loaded()?.readings === 0, '注入探针能建且带"未读数"标记'],
  ['compat.js', 'hostCaps', (m) => m.hostCaps({ section: () => {}, context: () => {} })?.section === true, '兼容闸能判']
]
for (const [file, fn, run, label] of pure) {
  const m = mods[file]
  if (m === undefined || typeof m[fn] !== 'function') { note(false, label + '(' + file + ':' + fn + ')'); continue }
  try { note(run(m) === true, label) } catch (e) { note(false, label, String(e?.message ?? e)) }
}

console.log(fails.length === 0
  ? '结论:真调用冒烟全过(' + files.length + ' 个模块 import + 三拍心跳 + 8 个纯件)。'
  : '结论:' + fails.length + ' 条没通过 —— 别提交,先修。')
process.exit(fails.length === 0 ? 0 : 1)
