/**
 * 群聊收不到消息的三重 bug —— 2026-10-17
 * ==================================================================
 * 现场（他报「加了个群进白名单就不能唤醒了」）：
 *   `inbound.jsonl` 里每条都是 `core-refused reason=agent-unavailable`，
 *   而**白名单早就放行了**（`stage=sent` 出现在 `core-refused` 之前）。
 *   ⇒ 跟白名单一点关系都没有。
 *
 * 三个齿轮咬在一起：
 *   ① `index.js` 的 `session/created` 把**每个新建的顶层会话**写进
 *      `manualOff`+`exempt`（`setSessionOn(sid,false)` 两个名单一起写）——
 *      **陪伴会话也是"新建的顶层会话"** ⇒ 一起被关；
 *   ② `ensureCompanionFor()` 的 `autoScope()` 看到 `isManuallyOff(sid)` 就
 *      `return`（「人显式关过，绝不覆盖」）⇒ 救不回来；
 *   ③ 来源纠偏原本在**注入成功之后** ⇒ 那一轮已经 503，只救得了"下一条"。
 *
 * 本文件钉住三件事（都是静态闸 + 一条原语行为）：
 *   · 陪伴会话**不许**被登记成"默认关"；
 *   · 来源纠偏必须在 `ensureCompanion()` **之前**；
 *   · `agent-unavailable` 两条分支都要**落审计**（否则下次还是查不出）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const idx = read('../lib/index.js')
const relay = read('../lib/relay.js')

test('① 陪伴会话不许被登记成「默认关」', () => {
  const at = idx.indexOf("ctx.on('session/created'")
  assert.ok(at > 0, 'session/created 的监听必须在')
  const block = idx.slice(at, at + 2400)

  // 必须拿得到陪伴会话 id（relay.sessionId 或 DEFAULT_COMPANION_ID 两个都要放过）
  assert.ok(/relayCfg\(\)\??\.sessionId/.test(block),
    '登记块里要读 relay.sessionId —— 他换过常驻会话，不能只看 DEFAULT')
  assert.ok(block.includes('DEFAULT_COMPANION_ID'),
    '登记块里要放过 DEFAULT_COMPANION_ID（没配 relay.sessionId 时的兜底）')
  // 陪伴会话那条必须**提前 return**，不许走到 setSessionOn(sid, false)
  const companionReturn = block.indexOf('陪伴会话不登记')
  const setOff = block.indexOf('setSessionOn(sid, false)')
  assert.ok(companionReturn > 0, '要有一句"陪伴会话不登记"的短路')
  assert.ok(setOff > companionReturn,
    '短路必须在 setSessionOn(sid, false) **之前** —— 否则先关再说是没用的')
})

test('② 来源纠偏必须在 ensureCompanion 之前（不能等到注入之后）', () => {
  const corr = relay.indexOf('setSessionOn(String(cfg().sessionId')
  const ensure = relay.indexOf('companion = await ensureCompanion()')
  const inject = relay.indexOf('result = await injectInbound')
  assert.ok(corr > 0, 'relay.js 里要有来源纠偏')
  assert.ok(ensure > 0 && inject > 0)
  assert.ok(corr < ensure,
    '纠偏必须在 ensureCompanion **之前** —— 否则 autoScope 还是被 manualOff 挡住')
  assert.ok(ensure < inject, '找会话在注入之前（原本就对，一起钉住）')
  // 纠偏只许出现一次（别两处各写一份，那样改一处漏一处）
  const all = relay.split('setSessionOn(').length - 1
  assert.equal(all, 2, 'setSessionOn 只该出现 2 次：import 一处 + 纠偏一处，实际 ' + all)
})

test('③ agent-unavailable 的两条分支都要落审计（失败原因不许只活在 logger 里）', () => {
  const start = relay.indexOf('// ⑥ 找/建/续陪伴会话')
  const end = relay.indexOf('// ⑦ 权限闸', start)
  assert.ok(start > 0 && end > start, '要能定位到第⑥段')
  const block = relay.slice(start, end)
  const hits = block.split("audit?.('relay_reject'").length - 1
  assert.equal(hits, 2,
    '两条 503 agent-unavailable 分支各要一条 relay_reject 审计，实际 ' + hits + ' 条')
  assert.ok(block.includes('why'),
    'catch 分支要把 err.message 带出来（`why`）—— 只记 "agent-unavailable" 等于没记')
})

test('行为:陪伴会话从硬名单摘除后 sessionEnabled 立刻为 true（纠偏真的有效）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-companion-on-'))
  const old = process.env.ECHO_DATA_DIR
  process.env.ECHO_DATA_DIR = dir
  try {
    const toggle = await import('../lib/toggle.js?companion=' + Date.now())
    const sid = 'session-b9f1692e-8224-4854-aa92-c04799e8251a'
    // 模拟 session/created 的错误登记
    toggle.setSessionOn(sid, false)
    assert.equal(toggle.sessionEnabled(sid), false, '登记后确实被关（复现现场）')
    assert.equal(toggle.isManuallyOff(sid), true, '而且在硬名单里 ⇒ autoScope 不敢动它')
    // 纠偏动作
    toggle.setSessionOn(sid, true)
    assert.equal(toggle.sessionEnabled(sid), true, '纠偏后必须能跑')
    assert.equal(toggle.isManuallyOff(sid), false, '纠偏要从硬名单摘除，否则下一条又救不回来')
  } finally {
    if (old === undefined) delete process.env.ECHO_DATA_DIR
    else process.env.ECHO_DATA_DIR = old
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
  }
})
