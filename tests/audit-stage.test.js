/**
 * 2026-10-10:钉住审计面板的**阶段归位**(`web/audit-cards.html` 的 `stepOf`)。
 *
 * 现场:面板「1 收到 / 5 回复 / 6 送信」三格恒显「暂无阶段标注」,而数据其实在库里
 * (`relay_in` / `relay_out` / `echo_qq_say` 三种行**只写 tool_call、不写 stage**)。
 * 旧 `stepOf` 的查表链是 `step → stage → trace_id#`,**缺 tool_call 这一环** ⇒
 * `N2S` 里那三条映射(`relay_in:1` / `relay_out:6` / `echo_qq_say:6`)白写了。
 * 另:`structured_output` 行的 stage 是 `tool:structured_output`,被 `/^tool:/`
 * 抢先判成 step=4(工具) —— 它其实是「5 回复」。
 *
 * 这里**真的把函数抽出来调用**(不是断言源码里有某个字符串),所以它能挡住
 * 「改坏了但字符串还在」的假绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const page = readFileSync(fileURLToPath(new URL('../web/audit-cards.html', import.meta.url)), 'utf8')

/** 从页面里抠出 N2S + stepOf 的定义并求值 —— 页面自身用 new Function 沙箱,同款做法。 */
function loadStepOf () {
  const n2s = /const N2S=\{[\s\S]*?\};/.exec(page)
  const fn = /const stepOf=r=>\{[\s\S]*?return s\};/.exec(page)
  assert.ok(n2s, '页面里找不到 N2S 定义(改名字了?)')
  assert.ok(fn, '页面里找不到 stepOf 定义(改结构了?)')
  return new Function(n2s[0] + '\n' + fn[0] + '\nreturn stepOf;')()
}

const stepOf = loadStepOf()

// ---- 核心:三格归位(修的就是这三条) ----

test('归位:relay_in(只写 tool_call、stage 空)⇒ step 1「收到」', () => {
  assert.equal(stepOf({ tool_call: 'relay_in', stage: '', step: 0 }), 1)
  assert.equal(stepOf({ tool_call: 'relay_in' }), 1)
})

test('归位:relay_out / echo_qq_say ⇒ step 6「送信」', () => {
  assert.equal(stepOf({ tool_call: 'relay_out', stage: '', step: 0 }), 6)
  assert.equal(stepOf({ tool_call: 'echo_qq_say', stage: '', step: 0 }), 6)
})

test('归位:structured_output ⇒ step 5「回复」,不被 tool: 抢成 4', () => {
  // 活库实测:它的 stage 是 'tool:structured_output'
  assert.equal(stepOf({ tool_call: 'structured_output', stage: 'tool:structured_output' }), 5)
  // 万一哪天 tool_call 缺失,只靠 stage 也要判 5
  assert.equal(stepOf({ stage: 'tool:structured_output' }), 5)
})

// ---- 不许回归:原来就对的行为一个都不能变 ----

test('回归:真·工具行仍是 step 4(不能因为加了 tool_call 查表就把工具判没了)', () => {
  // 这几个 tool_call 不在 N2S 里 ⇒ 落到 stage 的 /^tool:/ 规则
  assert.equal(stepOf({ tool_call: 'advanced_search', stage: 'tool:advanced_search' }), 4)
  assert.equal(stepOf({ tool_call: 'job_output', stage: 'tool:job_output' }), 4)
  assert.equal(stepOf({ tool_call: 'web_call', stage: 'tool:web_call' }), 4)
  assert.equal(stepOf({ tool_call: 'read', stage: 'tool:read' }), 4)
  assert.equal(stepOf({ stage: 'tool:pwsh' }), 4)
})

test('回归:stage 具名反查仍生效(retrieve 2 / assemble 3 / extract 7)', () => {
  assert.equal(stepOf({ stage: 'retrieve' }), 2)
  assert.equal(stepOf({ stage: 'assemble' }), 3)
  assert.equal(stepOf({ stage: 'extract' }), 7)
  assert.equal(stepOf({ tool_call: 'longing_steer', stage: 'longing_steer' }), 8)
  assert.equal(stepOf({ tool_call: 'care', stage: 'care' }), 9)
})

test('回归:显式 step 最高优先(不受 tool_call / stage 影响)', () => {
  assert.equal(stepOf({ step: 7, tool_call: 'relay_out', stage: 'tool:web_call' }), 7)
  assert.equal(stepOf({ step: 21, tool_call: 'same_turn_emotion', stage: '' }), 21)
})

test('回归:trace_id# 后缀兜底与"认不出就是 0"', () => {
  assert.equal(stepOf({ trace_id: 'abc#relay_out' }), 6)
  assert.equal(stepOf({ trace_id: 'abc#retrieve' }), 2)
  // 认不出来 ⇒ 0(面板归「未标注」,不硬塞)
  assert.equal(stepOf({}), 0)
  assert.equal(stepOf({ tool_call: 'emotion_decay', stage: 'emotion_decay' }), 0)
  assert.equal(stepOf({ tool_call: 'session-reaper', stage: '' }), 0)
})

test('归位:查表顺序对「同一条行同时有 tool_call 与 stage」取更具体的那条', () => {
  // tool_call 更具体 ⇒ 优先于 stage
  assert.equal(stepOf({ tool_call: 'relay_out', stage: 'tool:relay_out' }), 6)
  // structured_output 同理:tool_call 先说它是 5
  assert.equal(stepOf({ tool_call: 'structured_output', stage: 'tool:structured_output' }), 5)
  // 而 tool_call 不认识时,stage 说了算
  assert.equal(stepOf({ tool_call: 'advanced_search', stage: 'tool:advanced_search' }), 4)
})
