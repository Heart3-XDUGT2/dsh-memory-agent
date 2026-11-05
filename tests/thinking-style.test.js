/**
 * C2 思考风格双档的电池。
 *
 * 这一条最要紧的不是"她能切档",而是**不切的时候一个字都不加** ——
 * 本仓有一条疤(2026-09-26 那条被撤掉的尾部自检:她的思考里"像 Echo 吗/自检"
 * 提及率升到 25%,他的感觉是"演"和"怪")。所以下面一半用例都在钉"不加"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickThinkingStyle, thinkingLine, thinkingText, NEUTRAL_THINKING_LINE,
  STYLE_ROLE, STYLE_NEUTRAL, THINKING_DEFAULT_MIN_TOOLS, LONG_TASK_STEP
} from '../lib/thinking-style.js'

test('C2:聊天轮(没用工具、第一步)⇒ 角色档,而且那一行是**空串**(一个字不加)', () => {
  const style = pickThinkingStyle({ toolCallsThisTurn: 0, step: 1 })
  assert.equal(style, STYLE_ROLE)
  assert.equal(thinkingLine(style), '')
  assert.equal(thinkingText({ toolCallsThisTurn: 0, step: 1 }), '')
})

test('C2:干活轮(用过 1 件宿主工具,默认门槛 1)⇒ 中性档,且那一行只有一句话、没有问句', () => {
  assert.equal(THINKING_DEFAULT_MIN_TOOLS, 1)
  const style = pickThinkingStyle({ toolCallsThisTurn: 1, step: 2 })
  assert.equal(style, STYLE_NEUTRAL)
  const line = thinkingLine(style)
  assert.equal(line, NEUTRAL_THINKING_LINE)
  assert.ok(line.length < 100, '一行别写成一张表')
  assert.equal(/[?？]/.test(line), false, '**不许有问句** —— 问句会让她在思考里自问自答(那正是"演"的来源)')
  assert.equal(/像 Echo|扮演|自检|漂移/.test(line), false, '**不许提醒她在扮演**(2026-09-26 的教训)')
})

test('C2:门槛可调(他填 3 ⇒ 只用过 1、2 件不切档;用过 3 件才切)', () => {
  assert.equal(pickThinkingStyle({ toolCallsThisTurn: 2, step: 2, minTools: 3 }), STYLE_ROLE)
  assert.equal(pickThinkingStyle({ toolCallsThisTurn: 3, step: 2, minTools: 3 }), STYLE_NEUTRAL)
})

test('C2:多步长任务(到第 3 步,哪怕还没调工具)⇒ 也算干活', () => {
  assert.equal(LONG_TASK_STEP, 3)
  assert.equal(pickThinkingStyle({ toolCallsThisTurn: 0, step: 3 }), STYLE_NEUTRAL)
  assert.equal(pickThinkingStyle({ toolCallsThisTurn: 0, step: 2 }), STYLE_ROLE, '第 2 步还没调工具 ⇒ 还不知道在干嘛,不加')
})

test('C2:关掉开关 ⇒ 永远角色档(回到今天的行为,一模一样)', () => {
  assert.equal(pickThinkingStyle({ enabled: false, toolCallsThisTurn: 9, step: 9 }), STYLE_ROLE)
  assert.equal(thinkingText({ enabled: false, toolCallsThisTurn: 9, step: 9 }), '')
})

test('C2:坏输入一律回落角色档(认不出来就当她在聊天,不加字)', () => {
  assert.equal(pickThinkingStyle({ toolCallsThisTurn: NaN, step: NaN }), STYLE_ROLE)
  assert.equal(pickThinkingStyle({ toolCallsThisTurn: -3, step: -1 }), STYLE_ROLE)
  assert.equal(pickThinkingStyle({ toolCallsThisTurn: '胡说', step: 1 }), STYLE_ROLE)
  assert.equal(pickThinkingStyle({ toolCallsThisTurn: undefined, step: undefined }), STYLE_ROLE)
  assert.equal(pickThinkingStyle(), STYLE_ROLE)
  assert.equal(thinkingText(), '')
})

test('C2:force 只认两个档名(别的值忽略 ⇒ 不当成"强制关")', () => {
  assert.equal(pickThinkingStyle({ force: STYLE_NEUTRAL, toolCallsThisTurn: 0, step: 1 }), STYLE_NEUTRAL)
  assert.equal(pickThinkingStyle({ force: STYLE_ROLE, toolCallsThisTurn: 9, step: 9 }), STYLE_ROLE)
  assert.equal(pickThinkingStyle({ force: 'neutral!!', toolCallsThisTurn: 9, step: 9 }), STYLE_NEUTRAL, '按正常判据走')
  assert.equal(pickThinkingStyle({ force: null, toolCallsThisTurn: 0, step: 1 }), STYLE_ROLE)
})
