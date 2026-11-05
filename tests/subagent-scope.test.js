/**
 * 子代理会话不该被 Echo 接管 —— 2026-10-25
 * ==================================================================
 * 出处：`docs/bug-echo-subagent-scope.md`
 *
 * ## 病
 *
 * `scope=all` 的语义是「不在黑名单里的会话都算开」，而子代理既不在 `exempt`
 * 也不在 `manualOff`（`session/created` 里 `isTopLevelSession` 把它们放走了）
 * ⇒ `sessionEnabled(sid)` 对子代理返回 true ⇒ **注入闸放行**。
 *
 * 后果：干活用的子代理带着「陪伴型 AI」的人格与私人记忆上班，
 * 还把 `retrieve` 写进审计 ⇒ 面板里多出几个带 `turns` 的陌生会话。
 *
 * ## 这一组钉两件事
 *
 *   ① 注入闸上必须有子代理判据（静态闸：`index.js` 不能被 import 进测试，
 *      它带宿主依赖；这个仓的老办法就是读源码断言，见 `reflect-route.test.js`）。
 *   ② 「谁是子代理」这件事要记得住 —— 面板的会话列表是从 `audit_logs` 数出来的，
 *      而子代理的审计行**按设计要保留**，所以只能显式记名单再过滤。
 *
 * ## 关于状态隔离（踩过的坑）
 *
 * `lib/toggle.js` 的 `CONFIG_PATH` 是**模块级常量**，首次 import 时定死；
 * `import()` 之后拿到的都是同一个实例 ⇒ 换 `DSH_HOME` **不会**换掉配置。
 * 所以下面的用例**不假设空名单**，一律用各自独有的 id、只断言自己那几条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ECHO_DATA_DIR = mkdtempSync(join(tmpdir(), 'echo-subscope-data-'))

const SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
// 纯判据模块（零依赖、不碰盘）：⑰ 直接喂假列表用它，不假手于端点。
const SCOPE = await import('../lib/agent-scope.js')

async function freshToggle () {
  const dir = mkdtempSync(join(tmpdir(), 'echo-subscope-'))
  process.env.DSH_HOME = dir
  const mod = await import('../lib/toggle.js')
  return { dir, mod }
}

/** 这个 id 在名单里出现了几次。 */
const countOf = (list, id) => list.filter((x) => x === id).length

// ---- ① 注入闸（静态闸）--------------------------------------------------

test('① ★★ 注入闸必须挡住子代理会话（bug 的主刀）', () => {
  // 修前：`if (sid === '' || !sessionEnabled(sid)) return target`
  // 修后：**两道**——会话头判据 + 名单判据（见下一条为什么要两道）
  assert.match(
    SRC,
    /if \(sid === '' \|\| isSubagentSession\(session\) \|\| subagentSids\.has\(sid\) \|\| !sessionEnabled\(sid\)\) return target/,
    '★ 注入闸少了子代理判据 ⇒ scope=all 下子代理会被灌人格与私人记忆'
  )
})

test('①″ ★ 两道判据缺一不可：头可能缺席，名单是兜底', () => {
  // 只写 `isSubagentSession(session)` 是不够的：assemble 载荷里的 session
  // 未必带 header；而 `session/created` 那边判定是可靠的（子代理不登记就是证据）。
  const at = SRC.indexOf('const subagentSids = new Set(readSubagentSessions())')
  assert.ok(at > 0, '★ 没建内存镜像 ⇒ 每一拍都要读盘，或者根本没兜底')
  assert.match(SRC, /subagentSids\.add\(sid\)/, '★ session/created 记下了却没进镜像 ⇒ 兜底是空的')
})

test('①′ 注入闸用的是 session（不是 agent）—— 那个位置拿不到 agent', () => {
  // `system-prompt/assemble` 的载荷里是 `context.scope.session`；
  // 写成 `isSubagentSession(agent)` 在这里等于 undefined，判了等于没判。
  const at = SRC.indexOf('system-prompt/assemble')
  assert.ok(at > 0, '找不到 system-prompt/assemble 处理块')
  const seg = SRC.slice(at, at + 4000)
  assert.ok(!/isSubagentSession\(agent\)/.test(seg),
    '★ 这里必须用 session（agent 在 assemble 载荷里是 undefined）')
})

test('② ★ 子代理一律不登记开关（老行为不许回退）', () => {
  assert.match(
    SRC,
    /if \(!isTopLevelSession\(session\)\) \{ rememberSubagentSession\(sid\); subagentSids\.add\(sid\); return \}/,
    '★ 子代理必须继续被登记逻辑放走，只是顺手把 id 记下来'
  )
})

test('③ ★★ 面板的会话列表要滤掉子代理（审计行照旧保留）', () => {
  const at = SRC.indexOf("path: '/api/echo/scope'")
  assert.ok(at > 0, '找不到 scope 端点')
  const seg = SRC.slice(at, at + 1600)
  assert.match(seg, /readSubagentSessions\(\)/, '★ 端点没读子代理名单 ⇒ 列表里还会冒出陌生会话')
  assert.match(seg, /\.filter\(/, '★ 读了名单却没有过滤')
})

// ---- ② 名单本身 ----------------------------------------------------------

test('④ 记一个子代理 id ⇒ 读得回来', async () => {
  const { dir, mod } = await freshToggle()
  try {
    assert.equal(mod.rememberSubagentSession('t4-a'), true, '第一次记应返回 true')
    assert.ok(mod.readSubagentSessions().includes('t4-a'))
    assert.equal(countOf(mod.readSubagentSessions(), 't4-a'), 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑤ 同一个 id 记两次 ⇒ 不重复（幂等）', async () => {
  const { dir, mod } = await freshToggle()
  try {
    mod.rememberSubagentSession('t5-x')
    assert.equal(mod.rememberSubagentSession('t5-x'), false, '重复记应返回 false')
    assert.equal(countOf(mod.readSubagentSessions(), 't5-x'), 1, '名单里只许有一条')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑥ ★ 空 id / null 不许写进名单（别让脏值污染过滤）', async () => {
  const { dir, mod } = await freshToggle()
  try {
    const before = mod.readSubagentSessions().length
    assert.equal(mod.rememberSubagentSession(''), false)
    assert.equal(mod.rememberSubagentSession(null), false)
    assert.equal(mod.rememberSubagentSession(undefined), false)
    assert.equal(mod.readSubagentSessions().length, before, '★ 空值把名单写长了')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑦ ★ 上限 200 条：老条目被挤掉，不无限长', async () => {
  const { dir, mod } = await freshToggle()
  try {
    for (let i = 0; i < 205; i++) mod.rememberSubagentSession('t7-' + i)
    const list = mod.readSubagentSessions()
    assert.equal(list.length, 200, '实际 ' + list.length)
    assert.equal(list[list.length - 1], 't7-204', '最后一条要留着')
    assert.equal(countOf(list, 't7-0'), 0, '最早的应被挤掉')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑧ ★★ 名单与开关名单分家 —— 记一个子代理不许动 exempt / manualOff', async () => {
  const { dir, mod } = await freshToggle()
  try {
    const before = mod.readScope()
    mod.rememberSubagentSession('t8-x')
    const after = mod.readScope()
    assert.deepEqual(after.exempt, before.exempt, '★ exempt 被动了 ⇒ 子代理会挤进开关名单')
    assert.deepEqual(after.manualOff, before.manualOff, '★ manualOff 被动了 ⇒ 同款')
    assert.deepEqual(after.whitelist, before.whitelist, '白名单也不许动')
    assert.equal(after.scope, before.scope, '范围模式不许动')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑨ 落盘可持久：重新读配置还认得它', async () => {
  const { dir, mod } = await freshToggle()
  try {
    mod.rememberSubagentSession('t9-persist')
    // readSubagentSessions 每次都重新 readConfig()（读盘），所以这条就是在测落盘
    assert.ok(mod.readSubagentSessions().includes('t9-persist'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---- ③ 回归：顶层与陪伴会话不许受影响 ------------------------------------

test('⑩ ★★ `sessionEnabled` 只许**复用**那份唯一判据，不许自己手写形态', () => {
  // ★ 2026-10-25 第二拍：这条的字面**改过一次，理由写在下面，别当成"测试被改了所以不算数"。
  //
  // 原文是「`sessionEnabled` 不许提到子代理（判据只留 agent-scope.js 一处）」——
  // 它钉的是第一拍的修法（只在闸上加判据、不动 sessionEnabled）。第二拍的决定**反转**了：
  // 「新会话默认关」必须落在 sessionEnabled 里，否则 10 个调用点各判一次，总有一处漏
  // （`docs/bug-echo-new-session-default.md` §3 第 1 条：上一轮就是这么漏的）。
  //
  // 所以这条闸保留**真正的意图** ——「判据只有一份、这一层不许自己长出一份」：
  // 不许在这里手写会话头判据（origin/parentSession），也不许手写 id 形态正则；
  // 只许调用 `lib/agent-scope.js` 的导出（⑪ 已经在钉注入闸那一侧）。
  const toggleSrc = readFileSync(new URL('../lib/toggle.js', import.meta.url), 'utf8')
  const at = toggleSrc.indexOf('export function sessionEnabled')
  assert.ok(at > 0, '找不到 sessionEnabled')
  // 取到**整个函数体**（到下一个顶层 `export ` 或文件尾），不是随手截 400 字 ——
  // 截短了这条会"因为注释变长而变绿"，那是假绿。
  const rest = toggleSrc.slice(at + 10)
  const endRel = rest.search(/\nexport /)
  const seg = endRel > 0 ? rest.slice(0, endRel) : rest
  assert.ok(seg.length > 200, '函数体只截到 ' + seg.length + ' 字符，闸没覆盖住')
  assert.ok(!seg.includes('parentSession'),
    '★ 不许在这里手写会话头判据（会与 agent-scope.js 漂）')
  assert.ok(!/0-9a-f\]\{8\}/.test(seg),
    '★ 不许在这里手写 id 形态正则 —— 用 agent-scope.js 的 isSubagentSessionId()')
  assert.ok(!/isSubagentSession\s*\(/.test(seg),
    '★ 会话对象判据（isSubagentSession）在这里用不上：这个位置只有 id')
  assert.match(seg, /isSubagentSessionId\(/, '★ 形态判据必须复用 agent-scope.js 的导出')
  assert.match(seg, /subagentSessions/, '★ 名单那一路也要在这里（否则老会话漏回来）')
})

test('⑪ ★ 判据只有一份：注入闸复用的是 agent-scope.js 的导出', () => {
  assert.match(SRC, /import \{[^}]*isSubagentSession[^}]*\} from '\.\/agent-scope\.js'/,
    '★ 不许在注入闸里手写 origin/parentSession 判据（会与别处漂）')
})

// ---- ④ 默认关（2026-10-25 第二拍：docs/bug-echo-new-session-default.md）--------
// 这一组问的是「她跑不跑」**本身**（`sessionEnabled`），不是"注入被挡"。
// 修前：子代理既不在 `exempt` 也不在 `manualOff` ⇒ `scope=all` 下它返回 true
// ⇒ 上一轮只在注入闸与展示上打了补丁，"默认关"这件事没修。

test('⑫ ★★ 裸 UUID 的会话默认就是关的（不用等它被登记）', async () => {
  const { dir, mod } = await freshToggle()
  try {
    const sid = '0d0b2bef-6cf1-4334-b750-86202e92bd32'
    assert.equal(mod.isManuallyOff(sid), false, '前提：它不在硬名单里')
    assert.equal(mod.readScope().exempt.includes(sid), false, '前提：也不在例外名单里')
    assert.equal(mod.sessionEnabled(sid), false,
      '★ 裸 UUID（宿主给子代理的命名方式）必须默认关 —— 修前这里返回 true')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑬ ★★ 进了子代理名单就是关的（哪怕它挂着 session- 前缀）', async () => {
  const { dir, mod } = await freshToggle()
  try {
    const sid = 'session-t13-known-sub'
    mod.rememberSubagentSession(sid)
    assert.equal(mod.readScope().exempt.includes(sid), false, '前提：名单与开关名单分家（⑧ 钉过）')
    assert.equal(mod.isManuallyOff(sid), false, '前提：没人关过它')
    assert.equal(mod.sessionEnabled(sid), false,
      '★ 名单那一路必须独立生效 —— 形态判据抓不到带前缀的 id')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑭ ★ 陪伴/桥落点与面板伪会话不许被误伤', async () => {
  const { dir, mod } = await freshToggle()
  try {
    const relaySid = String(mod.readSettings()?.relay?.sessionId || 'session-echo-companion')
    assert.equal(mod.sessionEnabled(relaySid), true, '★ 桥的落点是 QQ 的唯一入口，必须开着')
    assert.equal(mod.sessionEnabled('global'), true, '★ 面板伪会话 global 不许被滤')
    // 极端的那个形状：他哪天把落点换成一个裸 UUID —— 关掉它等于 QQ 失联。
    // 判据的顺序（名单 → 桥落点 → 子代理）就是为这一条写的。
    const bare = 'b52fb676-b715-48c6-affc-3c32357e15ea'
    const original = String(mod.readSettings()?.relay?.sessionId ?? '')
    try {
      mod.writeSettings({ relay: { ...mod.readSettings().relay, sessionId: bare } })
      assert.equal(mod.sessionEnabled(bare), true,
        '★ 桥落点即使长得像子代理，也照样开')
    } finally {
      mod.writeSettings({ relay: { ...mod.readSettings().relay, sessionId: original } })
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑮ ★ 回填幂等：跑两次名单长度不变、无重复', async () => {
  const { dir, mod } = await freshToggle()
  try {
    const ids = ['37acb71f-30a9-4d79-93a7-7a577d66c6c0', '8503f305-22d0-48c8-bddb-16d7797fbb2a']
    const before = mod.readSubagentSessions().length
    const first = mod.backfillSubagentSessions(ids)
    assert.equal(first, ids.length, '第一次应当把两条都补进去，实际 ' + first)
    const afterFirst = mod.readSubagentSessions()
    // ⚠️ 这份配置是**本文件共用**的（CONFIG_PATH 模块级定死），⑦ 已经把它写到 200 上限了
    // ⇒ 长度按 min(200, before+n) 算；关键是补进去的两条在**尾部**、各只一条。
    assert.equal(afterFirst.length, Math.min(200, before + ids.length),
      '名单长度应当是 min(200, ' + (before + ids.length) + ')，实际 ' + afterFirst.length)
    for (const id of ids) assert.equal(countOf(afterFirst, id), 1, '★ 不许重复登记 ' + id)
    const second = mod.backfillSubagentSessions(ids)
    assert.equal(second, 0, '★ 第二次一条都不该补（幂等：不写盘、不涨长度）')
    assert.equal(mod.readSubagentSessions().length, afterFirst.length, '★ 名单长度不许变')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑯ ★ 回填不吞具名会话（global / session-* / 桥落点）', async () => {
  const { dir, mod } = await freshToggle()
  try {
    const relaySid = String(mod.readSettings()?.relay?.sessionId || 'session-echo-companion')
    const bare = 'fd077b2a-fb90-4fd2-b017-ff79fbaf8d2d'
    const added = mod.backfillSubagentSessions(['global', 'session-t16-named', relaySid, bare, '', null])
    assert.equal(added, 1, '只该补那条裸 UUID，实际补了 ' + added)
    const list = mod.readSubagentSessions()
    assert.ok(!list.includes('global'), '★ global 进了名单 ⇒ 面板伪会话会被隐藏')
    assert.ok(!list.includes('session-t16-named'), '★ 顶层会话进了名单 ⇒ 她会从那条会话里消失')
    assert.ok(!list.includes(relaySid), '★ 桥落点进了名单 ⇒ QQ 会失联')
    assert.ok(list.includes(bare), '该补的没补')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑰ ★★ /scope 的过滤：名单 + id 形态双判（喂假列表）', async () => {
  // 端点逐行判的就是这个纯函数（lib/agent-scope.js），⑱ 钉住"端点用的就是它"。
  const rows = [
    { sessionId: 'global', turns: 105 },
    { sessionId: 'session-b9f1692e-8224-4854-aa92-c04799e8251a', turns: 335 },
    { sessionId: 'efac6b41-2dfa-4fe9-bcc2-21ae8a730546', turns: 31 },
    { sessionId: 'session-t17-in-list', turns: 9 }
  ]
  const kept = rows
    .filter((x) => SCOPE.isScopeVisibleSession(x, new Set(['session-t17-in-list'])))
    .map((x) => x.sessionId)
  assert.deepEqual(kept, ['global', 'session-b9f1692e-8224-4854-aa92-c04799e8251a'],
    '★ 裸 UUID 与名单里的都不许出现；global 与 session-* 一个都不动')
})

test('⑱ ★ 端点用的是那份纯函数（不许自己再写一遍过滤）', () => {
  const at = SRC.indexOf("path: '/api/echo/scope'")
  assert.ok(at > 0, '找不到 scope 端点')
  const seg = SRC.slice(at, at + 1800)
  assert.match(seg, /isScopeVisibleSession\(/, '★ /scope 必须复用 agent-scope.js 的判据')
  assert.match(seg, /readSubagentSessions\(\)/, '★ 名单那一路也在（③ 钉过）')
  // GET 与 POST 两份列表都要滤：只滤 GET ⇒ 拨一下开关，子代理会话又冒回来。
  const handler = SRC.slice(at, SRC.indexOf("'echo.api.scope()'", at))
  const calls = (handler.match(/isScopeVisibleSession\(x,/g) || []).length
  assert.equal(calls, 2, 'GET 1 处 + POST 1 处，实际 ' + calls)
})
