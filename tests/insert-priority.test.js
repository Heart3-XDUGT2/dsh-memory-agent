/**
 * F4 插入优先级四档的电池(出处 neuro-sdk `API/SPECIFICATION.md:160`)。
 *
 * 上游的四档语义 + 一条限定(**她没在说话时优先级不生效**)都要钉住:
 *   low=等她说完成 · medium=尽快说完当前这句 · high=缩短她的话然后回应 · critical=打断。
 * 我们这一侧只认三种落点:`notBeforeAt`(入队时刻)+ 要不要砍掉她没发出去的泡。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PRIORITY_LEVELS, TIER_OF_PRIORITY, TIERS, TIER_IDLE, DEFAULT_PRIORITY, INSERT_KINDS,
  parsePriorityOverrides, priorityOf, decideInsertion, notBeforeFor
} from '../lib/insert-priority.js'

test('F4:四档映射与上游一字不差(low/medium/high/critical)', () => {
  assert.deepEqual(PRIORITY_LEVELS, ['low', 'medium', 'high', 'critical'])
  assert.deepEqual(TIERS, ['wait', 'finish-soon', 'shorten', 'interrupt'])
  assert.equal(TIER_OF_PRIORITY.low, 'wait')
  assert.equal(TIER_OF_PRIORITY.medium, 'finish-soon')
  assert.equal(TIER_OF_PRIORITY.high, 'shorten')
  assert.equal(TIER_OF_PRIORITY.critical, 'interrupt')
})

test('F4:她没在说话 ⇒ 优先级不生效(上游原话),直接发', () => {
  for (const k of INSERT_KINDS) {
    const d = decideInsertion({ kind: k, speaking: false })
    assert.equal(d.tier, TIER_IDLE)
    assert.equal(d.cutRemaining, false)
    assert.equal(d.notBeforeAt, 'now')
  }
})

test('F4:默认分配 —— 他说话最急(high),关怀最不急(low),提醒与闹钟居中', () => {
  assert.equal(DEFAULT_PRIORITY.reply, 'high')
  assert.equal(DEFAULT_PRIORITY.care, 'low')
  assert.equal(DEFAULT_PRIORITY.reminder, 'medium')
  assert.equal(DEFAULT_PRIORITY.wake, 'medium')
  assert.equal(DEFAULT_PRIORITY.event, 'low')
  // 说话时按档落地
  assert.equal(decideInsertion({ kind: 'care', speaking: true }).tier, 'wait')
  assert.equal(decideInsertion({ kind: 'reminder', speaking: true }).tier, 'finish-soon')
  assert.equal(decideInsertion({ kind: 'reply', speaking: true }).tier, 'shorten')
  assert.equal(decideInsertion({ kind: 'reply', speaking: true }).cutRemaining, true)
  assert.equal(decideInsertion({ kind: 'care', speaking: true }).cutRemaining, false)
})

test('F4:覆盖表 —— `care=medium, wake=low` 生效;认不出来的键/档位忽略(不报错)', () => {
  const ov = parsePriorityOverrides('care=medium, wake=low, 胡说=high, event=胡说, reminder=critical')
  assert.deepEqual(ov, { care: 'medium', wake: 'low', reminder: 'critical' })
  assert.equal(priorityOf('care', ov), 'medium')
  assert.equal(priorityOf('wake', ov), 'low')
  assert.equal(priorityOf('event', ov), 'low', '认不出来的档位 ⇒ 回落默认')
  assert.equal(priorityOf('reply', ov), 'high')
  assert.equal(decideInsertion({ kind: 'care', speaking: true, overrides: ov }).tier, 'finish-soon')
  assert.equal(decideInsertion({ kind: 'reminder', speaking: true, overrides: ov }).tier, 'interrupt')
  assert.equal(decideInsertion({ kind: 'reminder', speaking: true, overrides: ov }).cutRemaining, true)
})

test('F4:事件自带 priority 优先(将来语音平台能直接说"这条急")', () => {
  assert.equal(decideInsertion({ kind: 'event', speaking: true, priority: 'critical' }).tier, 'interrupt')
  assert.equal(decideInsertion({ kind: 'event', speaking: true, priority: 'HIGH' }).tier, 'shorten')
  assert.equal(decideInsertion({ kind: 'event', speaking: true, priority: '胡说' }).tier, 'wait', '乱填 ⇒ 回落 kind 的默认(low)')
})

test('F4:入队时刻 —— wait 排到最后一泡之后,finish-soon 排到当前泡之后,shorten/interrupt 立刻', () => {
  const now = 1000
  const args = { now, currentNotBefore: 1005, lastNotBefore: 1012, gap: 0.4 }
  assert.equal(notBeforeFor({ tier: 'wait', ...args }), 1012.4)
  assert.equal(notBeforeFor({ tier: 'finish-soon', ...args }), 1005.4)
  assert.equal(notBeforeFor({ tier: 'shorten', ...args }), 1000)
  assert.equal(notBeforeFor({ tier: 'interrupt', ...args }), 1000)
  assert.equal(notBeforeFor({ tier: TIER_IDLE, ...args }), 1000, '不在说话 ⇒ 立刻(老行为)')
  // 时间倒挂(泡的时刻已经过去)⇒ 不许排到过去
  assert.equal(notBeforeFor({ tier: 'wait', now: 2000, lastNotBefore: 1012, gap: 0.4 }), 2000)
})

test('F4:坏输入不抛(判不出来就该按老行为直接发)', () => {
  assert.doesNotThrow(() => decideInsertion({}))
  assert.doesNotThrow(() => decideInsertion({ kind: null, speaking: 'yes', overrides: 5 }))
  assert.equal(decideInsertion({ kind: null, speaking: true }).tier, 'wait', '不认识的 kind ⇒ low ⇒ wait')
  assert.doesNotThrow(() => notBeforeFor({ tier: '胡说', now: NaN }))
  assert.equal(notBeforeFor({ tier: 'wait', now: NaN, lastNotBefore: NaN, gap: 'x' }), 0)
})
