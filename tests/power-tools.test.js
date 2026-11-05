/**
 * 硬开关(2026-09-26 现场)—— `echo_power` / `echo_scope` 与 autoScope 的底线。
 *
 * 他问的原话:「你是一个工作的 agent,为什么我跟你说 Echo 下线,你还在使用
 * Echo 插件?……你应该搞一个硬性的按钮出来。」
 *
 * 那时的三条根因,每条都要有一条测试钉住:
 *   ① agent 手上没有开关 → 现在有两只手(echo_power / echo_scope);
 *   ② 只有精确短语能拨、失败了还静默 → 口语都认 + 必有回话(见 toggle 用例);
 *   ③ **写进去也会被 autoScope 静默覆盖** → 本文件的核心:
 *      「人显式关过的会话,autoScope 永不自动打开」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { powerToolDefinitions } from '../lib/power-tools.js'

/** 一个最小可用的假开关台:内存态,记录谁拨的。 */
function fakeSwitch (init = {}) {
  const state = {
    enabled: init.enabled !== false,
    by: init.by || '',
    at: init.at || 0,
    scope: { scope: init.scope || 'all', whitelist: init.whitelist || [], exempt: init.exempt || [], manualOff: init.manualOff || [] }
  }
  const writes = []
  return {
    state,
    writes,
    readPower: () => ({ enabled: state.enabled, by: state.by, at: state.at }),
    setPower: (on, by) => { state.enabled = Boolean(on); state.by = by; state.at = 7; writes.push(['power', on, by]); return state.enabled },
    readScope: () => ({ ...state.scope, whitelist: [...state.scope.whitelist], exempt: [...state.scope.exempt], manualOff: [...state.scope.manualOff] }),
    setScope: (s, by) => { state.scope.scope = s === 'whitelist' ? 'whitelist' : 'all'; writes.push(['scope', s, by]); return state.scope },
    setSessionOn: (sid, on) => {
      const s = state.scope
      s.manualOff = on ? s.manualOff.filter((x) => x !== sid) : [...new Set([...s.manualOff, sid])]
      if (s.scope === 'whitelist') s.whitelist = on ? [...new Set([...s.whitelist, sid])] : s.whitelist.filter((x) => x !== sid)
      else s.exempt = on ? s.exempt.filter((x) => x !== sid) : [...new Set([...s.exempt, sid])]
      writes.push(['session', sid, on])
      return s
    },
    sessionEnabledOf: (sid) => {
      if (!state.enabled) return false
      return state.scope.scope === 'whitelist' ? state.scope.whitelist.includes(sid) : !state.scope.exempt.includes(sid)
    }
  }
}

const deps = (sw, extra = {}) => ({
  readPower: sw.readPower,
  setPower: sw.setPower,
  readScope: sw.readScope,
  setScope: sw.setScope,
  setSessionOn: sw.setSessionOn,
  sessionEnabledOf: sw.sessionEnabledOf,
  ...extra
})

const byName = (defs, name) => defs.find((d) => d.name === name)

test('硬开关:两只手都在,名字与参数形状对得上(他没开关可用是原罪)', () => {
  const sw = fakeSwitch()
  const defs = powerToolDefinitions(deps(sw))
  assert.equal(defs.length, 2)
  const power = byName(defs, 'echo_power')
  const scope = byName(defs, 'echo_scope')
  assert.ok(power, 'echo_power 必须在')
  assert.ok(scope, 'echo_scope 必须在')
  assert.equal(power.parameters.on.required, true)
  // scope 的三个参数都可选(留空 = 当前会话 / 只给我 on 就是拨会话)
  for (const k of ['sessionId', 'on', 'scope']) assert.ok(scope.parameters[k], k + ' 参数在')
  // 输出 schema 一律 additionalProperties:false —— 漏声明一个键就是整个工具被宿主拒掉
  assert.equal(power.output.schema.additionalProperties, false)
  assert.equal(scope.output.schema.additionalProperties, false)
})

test('硬开关:echo_power(false) 真的落盘,并说清是谁拨的(不是嘴上答应)', async () => {
  const sw = fakeSwitch()
  const power = byName(powerToolDefinitions(deps(sw)), 'echo_power')
  const out = await power.execute({ on: false }, {})
  assert.equal(out.ok, true)
  assert.equal(out.enabled, false)
  assert.equal(out.by, 'tool', '要记清是工具拨的 —— 面板靠这个显示来源')
  assert.equal(sw.state.enabled, false, '必须真的落到状态上')
  assert.deepEqual(sw.writes, [['power', false, 'tool']])
})

test('硬开关:字符串/中文的 on 也要认(她可能这么传)', async () => {
  const sw = fakeSwitch()
  const power = byName(powerToolDefinitions(deps(sw)), 'echo_power')
  for (const [input, want] of [[false, false], ['off', false], ['关', false], [0, false], [true, true], ['on', true], ['在线', true]]) {
    const out = await power.execute({ on: input }, {})
    assert.equal(out.ok, true, JSON.stringify(input) + ' 要能解析')
    assert.equal(out.enabled, want, JSON.stringify(input) + ' → ' + want)
  }
  // 解析不了的必须**明确报错**,不许猜
  const bad = await power.execute({ on: '也许吧' }, {})
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'bad-arg')
})

test('硬开关:写失败必须说清(她不能以为自己关上了而其实没关)', async () => {
  const sw = fakeSwitch()
  const defs = powerToolDefinitions({ ...deps(sw), setPower: () => { throw new Error('磁盘只读') } })
  const out = await byName(defs, 'echo_power').execute({ on: false }, {})
  assert.equal(out.ok, false)
  assert.equal(out.code, 'write-failed')
  assert.match(out.text, /磁盘只读/)
})

test('硬开关:echo_scope 留空 = 当前会话;关掉进硬关名单', async () => {
  const sw = fakeSwitch()
  const defs = powerToolDefinitions(deps(sw, { currentSessionId: () => 'sess-now' }))
  const scope = byName(defs, 'echo_scope')
  const out = await scope.execute({ on: false }, {})
  assert.equal(out.ok, true)
  assert.equal(out.sessionId, 'sess-now', '没给 sessionId 就该落到当前会话')
  assert.equal(out.sessionOn, false)
  assert.deepEqual(sw.state.scope.manualOff, ['sess-now'], '必须进硬关名单 —— autoScope 靠它')
})

test('硬开关:硬关名单是「人亲手关过」的判据;亲手开则摘除', async () => {
  const sw = fakeSwitch()
  const defs = powerToolDefinitions(deps(sw, { currentSessionId: () => 's1' }))
  const scope = byName(defs, 'echo_scope')
  await scope.execute({ on: false }, {})
  assert.deepEqual(sw.state.scope.manualOff, ['s1'])
  await scope.execute({ on: true }, {})
  assert.deepEqual(sw.state.scope.manualOff, [], '他亲手开回来之后,autoScope 才允许再管它')
})

test('硬开关:切模式也走这只手(all / whitelist)', async () => {
  const sw = fakeSwitch()
  const defs = powerToolDefinitions(deps(sw))
  const out = await byName(defs, 'echo_scope').execute({ scope: 'whitelist' }, {})
  assert.equal(out.ok, true)
  assert.equal(out.scope.scope, 'whitelist')
  assert.deepEqual(sw.writes, [['scope', 'whitelist', 'tool']])
})

test('硬开关:没接上手时诚实回报,不硬撑', async () => {
  const defs = powerToolDefinitions({ readPower: () => ({ enabled: true, by: '', at: 0 }) })
  const out = await byName(defs, 'echo_power').execute({ on: false }, {})
  assert.equal(out.ok, false)
  assert.equal(out.code, 'no-service')
})

test('硬开关:render 输出是人话且带来源', () => {
  const defs = powerToolDefinitions(deps(fakeSwitch()))
  const power = byName(defs, 'echo_power')
  const on = power.output.render({ on: true }, { ok: true, enabled: true, by: 'tool', code: 'online', text: '她醒了。' })
  const off = power.output.render({ on: false }, { ok: true, enabled: false, by: 'tool', code: 'asleep', text: '她睡了(总闸关)。' })
  assert.match(on[0].text, /在线/)
  assert.match(off[0].text, /休眠/)
  const bad = power.output.render({}, { ok: false, code: 'bad-arg', text: 'on 要 true/false。' })
  assert.match(bad[0].text, /没拨成/)
})

// ---- v0.42.0 审计修复(P1):这两只手原来**没有调用方闸** ----
//
// 现场:工具是全局注册的 ⇒ 任何会话的 agent、以及**子代理**都看得见。
// 于是一条子代理(EXTRACT/打分/整理)就能 `echo_power(true)` 把他亲手关掉的
// 硬关重新打开;而「当前会话」取的是壳里那个 routeAgent(= 最后说过话的顶层
// 会话),从别的会话调 echo_scope 会**改到另一条会话**身上。
// 判据与 v0.41.0 的子代理递归闸同一份(lib/agent-scope.js)。

/** 一个子代理形状的调用方(宿主 exec.agent:session.header 带委派标记)。 */
const subagentCaller = {
  session: { id: 'sub-1', header: { origin: 'subagent', delegationDepth: 1, parentSession: 'root-1' } }
}
/** 一个顶层会话形状的调用方。 */
const rootCaller = { session: { id: 'root-9', header: { origin: 'root' } } }

test('硬开关:子代理不许拨总闸(它把他关掉的硬关再打开就是越权)', async () => {
  const sw = fakeSwitch({ enabled: false })
  const power = byName(powerToolDefinitions(deps(sw)), 'echo_power')
  const out = await power.execute({ on: true }, { agent: subagentCaller })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'subagent-refused')
  assert.equal(sw.state.enabled, false, '被拒绝的调用不许真的写下去')
  assert.deepEqual(sw.writes, [], '一次写都不许发生')
})

test('硬开关:子代理也不许改分闸(会话范围)', async () => {
  const sw = fakeSwitch()
  const scope = byName(powerToolDefinitions(deps(sw)), 'echo_scope')
  for (const args of [{ on: false }, { scope: 'whitelist' }, { sessionId: 'root-9', on: false }]) {
    const out = await scope.execute(args, { agent: subagentCaller })
    assert.equal(out.ok, false, JSON.stringify(args) + ' 必须被拒')
    assert.equal(out.code, 'subagent-refused')
  }
  assert.deepEqual(sw.writes, [])
})

test('硬开关:不带 sessionId = **调用方自己**那条会话,不是最后说过话的那条', async () => {
  const sw = fakeSwitch()
  // routeAgent 那条老路指向别的会话 —— 它只配当兜底,不许再当判据
  const defs = powerToolDefinitions(deps(sw, { currentSessionId: () => 'sess-somebody-else' }))
  const out = await byName(defs, 'echo_scope').execute({ on: false }, { agent: rootCaller })
  assert.equal(out.ok, true)
  assert.equal(out.sessionId, 'root-9', '要落在调用方自己的会话上')
  assert.deepEqual(sw.state.scope.manualOff, ['root-9'])
})

test('硬开关:顶层调用方照旧能用;宿主没给 exec 时退回 currentSessionId', async () => {
  const sw = fakeSwitch()
  const defs = powerToolDefinitions(deps(sw, { currentSessionId: () => 'sess-now' }))
  const power = byName(defs, 'echo_power')
  const okRoot = await power.execute({ on: false }, { agent: rootCaller })
  assert.equal(okRoot.ok, true, '顶层会话拨总闸必须照旧能拨')
  const scope = byName(defs, 'echo_scope')
  const noExec = await scope.execute({ on: false }, {})          // 离线电池/宿主异常
  assert.equal(noExec.sessionId, 'sess-now', '没有 exec 才退回老路')
  const bareAgent = await scope.execute({ on: false }, { agent: { session: {} } }) // 拿不到 id
  assert.equal(bareAgent.sessionId, 'sess-now')
})
