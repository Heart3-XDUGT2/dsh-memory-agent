/**
 * 「新会话默认关」(语义 C)的电池 —— 2026-10-08 补
 * ==================================================================
 * 被验的东西有两层:
 *   ① **接线**(静态闸):`lib/index.js` 里必须挂 `session/created`,判 `isTopLevelSession`,
 *      调 `setSessionOn(sid, false)` —— 这三件缺一件,行为就没发生。
 *   ② **原语行为**(真跑):把 `ECHO_DATA_DIR` 指到临时目录再**动态 import** `toggle.js`
 *      (`CONFIG_PATH` 是模块级 const,必须在 import 之前设好,所以这个文件单独成一个测试文件,
 *       免得别的用例先把模块加载进缓存 ⇒ 见 lib/toggle.js:70 与 lib/data-dir.js 的路径真源)。
 *
 * 为什么行为断言用 `sessionEnabled()` 而不是只看 `manualOff`:
 *   "她跑不跑"的判据就是 `sessionEnabled(sid)`(`lib/index.js` 里十处都用它),
 *   ⇒ 断言它 = 断言**真正生效**的那一件事。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')

test('静态闸:新会话登记必须挂 session/created,只登记顶层会话,且写进硬名单', () => {
  assert.ok(src.includes("ctx.on('session/created'"),
    'lib/index.js 里必须有 session/created 的监听(新会话默认关的接线)')
  assert.ok(/isTopLevelSession\s*\(/.test(src),
    '必须判 isTopLevelSession —— 否则子代理会话也会被登记进他的开关名单')
  assert.ok(src.includes('setSessionOn(sid, false)'),
    '必须调 setSessionOn(sid, false)(进硬名单;正是这个动作挡住 autoScope)')
  // 登记块里必须带 try/catch:登记失败不许影响会话创建
  // ⚠️ 窗口按"块"取而不是固定 700 字 —— 2026-10-17 加了一段「陪伴会话不登记」的
  //    短路与长注释，块变长了；固定窗口会在**注释写长**时误报（那是文档变多，不是行为变坏）。
  const at = src.indexOf("ctx.on('session/created'")
  const tail = src.indexOf('}))', at)
  const block = src.slice(at, tail > at ? tail + 3 : at + 3000)
  assert.ok(block.includes('try {') && block.includes('catch'),
    '登记块要有 try/catch —— 登记失败不该影响会话创建')
})

test('行为:新会话进硬名单 ⇒ sessionEnabled 为 false;发「上线」后为 true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-new-sess-'))
  const old = process.env.ECHO_DATA_DIR
  process.env.ECHO_DATA_DIR = dir
  try {
    // 必须在设好 ECHO_DATA_DIR 之后再 import(CONFIG_PATH 在模块加载时定形)
    const toggle = await import(`../lib/toggle.js?fresh=${Date.now()}`)
    const sid = 'sess-new-toplevel'

    // 默认(总闸开 + scope=all)⇒ 会话本来是跑的
    assert.equal(toggle.sessionEnabled(sid), true, '没登记前这条会话应当是跑的(地基:默认全开)')

    // 第二拍的那两个动作:登记进硬名单
    toggle.setSessionOn(sid, false)
    assert.equal(toggle.isManuallyOff(sid), true, '登记后必须进硬名单(manualOff)')
    assert.equal(toggle.sessionEnabled(sid), false, '登记后这条会话就不该再跑 Echo(新会话默认关)')

    // 「Echo 上线」⇒ 从名单摘除,又能跑
    toggle.setSessionOn(sid, true)
    assert.equal(toggle.isManuallyOff(sid), false, '发「Echo 上线」要从硬名单摘除')
    assert.equal(toggle.sessionEnabled(sid), true, '发「Echo 上线」后她要能跑')
  } finally {
    if (old === undefined) delete process.env.ECHO_DATA_DIR
    else process.env.ECHO_DATA_DIR = old
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结论 */ }
  }
})

test('行为:子代理会话不算顶层 ⇒ 不会进他的开关名单', async () => {
  const { isTopLevelSession } = await import('../lib/agent-scope.js')
  assert.equal(isTopLevelSession({ id: 'x', header: { origin: 'subagent' } }), false,
    'origin=subagent 的会话必须是"非顶层"')
  assert.equal(isTopLevelSession({ id: 'y', header: { parentSession: 'main-1' } }), false,
    '带 parentSession 的会话必须是"非顶层"')
  assert.equal(isTopLevelSession({ id: 'z', header: {} }), true,
    '普通会话头 = 顶层(缺省即顶层,与宿主 delegationDepthOf 同口径)')
})

// ══════════════════════════════════════════════════════════════════════════
// 2026-10-08 补(按来源的新会话默认开关 newSessionOn)
//   ⚠️ 诚实边界:两锚点(`session/created` 登记 / relay 入站纠偏)的**接线**由静态闸钉住 ——
//   本仓没有"起真 ctx + 喂真 relay envelope"的宿主级夹具,行为只能测到**原语**。
// ══════════════════════════════════════════════════════════════════════════

test('静态闸:两处接线 + 面板三项都在', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
  const idx = read('../lib/index.js')
  const relay = read('../lib/relay.js')
  const fields = read('../lib/settings-fields.js')

  assert.ok(idx.includes('newSessionOn'),
    'index.js 的登记判据必须看 newSessionOn(否则"按来源分别设默认"不成立)')
  assert.ok(relay.includes('newSessionOn') && relay.includes('setSessionOn('),
    'relay.js 的第二锚点必须在(newSessionOn + setSessionOn)')
  assert.ok(relay.includes("from './toggle.js'"), 'relay.js 要 import toggle 的读/写口')
  for (const k of ['newSessionOn.dsh', 'newSessionOn.qq', 'newSessionOn.other']) {
    assert.ok(fields.includes("'" + k + "'"), '面板缺这一项:' + k)
  }
  assert.ok(fields.includes("title: '新会话默认开关'"), '面板要有「新会话默认开关」这一组')
})

test('行为:默认三档 = dsh 关 / qq 开 / other 关', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-newsess-on-'))
  const old = process.env.ECHO_DATA_DIR
  process.env.ECHO_DATA_DIR = dir
  try {
    const toggle = await import('../lib/toggle.js?on=' + Date.now())
    const s = toggle.readSettings()
    assert.deepEqual(s.newSessionOn, { dsh: false, qq: true, other: false },
      '默认:网页直聊关、QQ 开、其它关')
  } finally {
    if (old === undefined) delete process.env.ECHO_DATA_DIR
    else process.env.ECHO_DATA_DIR = old
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
  }
})

test('行为:三档 × setSessionOn —— 登记的关能被"默认开"那一档纠正回来', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-newsess-bucket-'))
  const old = process.env.ECHO_DATA_DIR
  process.env.ECHO_DATA_DIR = dir
  try {
    const toggle = await import('../lib/toggle.js?bucket=' + Date.now())

    // ① dsh 档(默认关)⇒ 登记后不跑
    toggle.setSessionOn('sid-dsh', false)
    assert.equal(toggle.sessionEnabled('sid-dsh'), false, '网页直聊档:新会话默认不该跑')

    // ② qq 档(默认开)⇒ relay 入站的纠偏把它摘除 ⇒ 又跑起来
    toggle.setSessionOn('sid-qq', false)
    assert.equal(toggle.sessionEnabled('sid-qq'), false, '纠偏前应当是关的')
    if (toggle.readSettings().newSessionOn.qq === true) toggle.setSessionOn('sid-qq', true)
    assert.equal(toggle.sessionEnabled('sid-qq'), true, 'QQ 档默认开 ⇒ 纠偏后必须能跑')

    // ③ other 档(默认关)⇒ 不纠正,保持关
    toggle.setSessionOn('sid-other', false)
    if (toggle.readSettings().newSessionOn.other === true) toggle.setSessionOn('sid-other', true)
    assert.equal(toggle.sessionEnabled('sid-other'), false, '其它档默认关 ⇒ 保持关')
  } finally {
    if (old === undefined) delete process.env.ECHO_DATA_DIR
    else process.env.ECHO_DATA_DIR = old
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
  }
})
