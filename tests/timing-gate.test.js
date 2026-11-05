/**
 * P1 电池:`timingGate` —— 时机闸(**表驱动**)。
 *
 * 闸的存在理由(施工图 §2.1):分数高 ≠ 现在就能开口。同一句话,他刚说完话三秒
 * 里冒出来是**打断**;隔了三天才补说是**复读**;额度用完要闭嘴;这个话题刚刚才
 * 提过,得等冷却。理由字符串与 `lib/heartbeat.js:673-703` 现用词**同名**
 * (`night-hold` / `daily-cap`)—— 口径不许一个人一个词。
 *
 * 一条总纪律:任何一闸的参数**没给**就当那一闸关着(宁可判 ok)—— "配置缺一项"
 * 不许把她永久憋住(那是 45 小时静默的同科事故)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { timingGate, TIMING_REASONS } from '../lib/topic-score.js'

const NOW = 1_800_000_000
const MIN = 60
const HOUR = 3600

/** 全参数都在的基线:空闲 10 小时、额度 5、冷却 3 小时。 */
const baseInput = () => ({
  now: NOW,
  lastUserAt: NOW - 10 * HOUR,
  lastTopicAt: NOW - 10 * HOUR,
  quotaLeft: 5,
  cooldownMin: 180,
  minIdleMin: 30,
  maxIdleMin: 24 * 60,
  isNight: false
})

/** 表驱动用例:`{ name, input, ok, reason, detail? }`。 */
const CASES = [
  {
    name: '全过:白天、隔了 10 小时、额度够、冷却也过了',
    input: baseInput(),
    ok: true,
    reason: TIMING_REASONS.ok
  },
  {
    name: '夜闸(23~8 点)优先:别的条件全都满足也压住',
    input: { ...baseInput(), isNight: true },
    ok: false,
    reason: 'night-hold',
    detail: (d) => assert.equal(d.gate, 'night')
  },
  {
    name: '夜闸压过一切:额度也没了、话题也在冷却,报的仍是夜闸',
    input: { ...baseInput(), isNight: true, quotaLeft: 0, lastTopicAt: NOW - 60 },
    ok: false,
    reason: 'night-hold'
  },
  {
    name: '太近 = 打断:他刚说完 5 分钟,下界要 30 分钟',
    input: { ...baseInput(), lastUserAt: NOW - 5 * MIN },
    ok: false,
    reason: 'too-soon',
    detail: (d) => assert.equal(d.gate, 'idle-min')
  },
  {
    name: '下界边界:正好 == 30 分钟 ⇒ 不算太近(闭区间)',
    input: { ...baseInput(), lastUserAt: NOW - 30 * MIN },
    ok: true,
    reason: TIMING_REASONS.ok
  },
  {
    name: '太久 = 补说像复读:空闲 25 小时 > 上界 24 小时',
    input: { ...baseInput(), lastUserAt: NOW - 25 * HOUR, lastTopicAt: NOW - 25 * HOUR },
    ok: false,
    reason: 'idle-too-long',
    detail: (d) => assert.equal(d.gate, 'idle-max')
  },
  {
    name: '上界边界:正好 == 24 小时 ⇒ 还允许',
    input: { ...baseInput(), lastUserAt: NOW - 24 * HOUR, lastTopicAt: NOW - 24 * HOUR },
    ok: true,
    reason: TIMING_REASONS.ok
  },
  {
    name: '额度用尽(与心跳同名 daily-cap)',
    input: { ...baseInput(), quotaLeft: 0 },
    ok: false,
    reason: 'daily-cap',
    detail: (d) => assert.equal(d.gate, 'quota')
  },
  {
    name: '额度边界:还剩 1 次 ⇒ 放行',
    input: { ...baseInput(), quotaLeft: 1 },
    ok: true,
    reason: TIMING_REASONS.ok
  },
  {
    name: '同题冷却:3 分钟前提过,冷却 180 分钟',
    input: { ...baseInput(), lastTopicAt: NOW - 3 * MIN },
    ok: false,
    reason: 'cooldown',
    detail: (d) => assert.ok(d.cooldownLeftMin > 170 && d.cooldownLeftMin < 180)
  },
  {
    name: '冷却边界:正好 == 180 分钟 ⇒ 可以再提(闭区间)',
    input: { ...baseInput(), lastTopicAt: NOW - 180 * MIN },
    ok: true,
    reason: TIMING_REASONS.ok
  },
  {
    name: '闸的顺序:太近 + 额度也没了 ⇒ 先报太近(打断比额度更该先知道)',
    input: { ...baseInput(), lastUserAt: NOW - 1 * MIN, quotaLeft: 0 },
    ok: false,
    reason: 'too-soon'
  },
  {
    name: '闸的顺序:太久 + 冷却中 ⇒ 先报太久',
    input: { ...baseInput(), lastUserAt: NOW - 48 * HOUR, lastTopicAt: NOW - 1 * MIN },
    ok: false,
    reason: 'idle-too-long'
  },
  {
    name: '没给 idle 参数 ⇒ 空闲两闸关着(配置缺项不许憋住她)',
    input: { now: NOW, lastUserAt: NOW - 1 * MIN, quotaLeft: 5, cooldownMin: 0, isNight: false },
    ok: true,
    reason: TIMING_REASONS.ok
  },
  {
    name: '没有他上一句的时间(lastUserAt=0)⇒ 空闲两闸不判',
    input: { ...baseInput(), lastUserAt: 0 },
    ok: true,
    reason: TIMING_REASONS.ok
  },
  {
    name: '没有额度信息(quotaLeft 缺省)⇒ 额度闸不判',
    input: { now: NOW, lastUserAt: NOW - 10 * HOUR, lastTopicAt: NOW - 10 * HOUR, cooldownMin: 180 },
    ok: true,
    reason: TIMING_REASONS.ok
  },
  {
    name: '冷却为 0 / 没提过(0)⇒ 冷却闸不判',
    input: { ...baseInput(), cooldownMin: 0, lastTopicAt: 0 },
    ok: true,
    reason: TIMING_REASONS.ok
  },
  {
    name: '坏输入不许崩:全空对象',
    input: {},
    ok: true,
    reason: TIMING_REASONS.ok
  },
  {
    name: '坏输入不许崩:undefined / NaN 混进来',
    input: { now: NaN, lastUserAt: NaN, lastTopicAt: NaN, quotaLeft: NaN, cooldownMin: NaN, isNight: undefined },
    ok: true,
    reason: TIMING_REASONS.ok
  }
]

for (const c of CASES) {
  test('timingGate:' + c.name, () => {
    const r = timingGate(c.input)
    assert.equal(r.ok, c.ok, 'ok 判定')
    assert.equal(r.reason, c.reason, 'reason 必须是该闸自己的词')
    assert.equal(typeof r.detail, 'object')
    if (c.detail) c.detail(r.detail)
  })
}

test('timingGate:返回值形状稳定(ok/not-ok 都带 detail,不许 undefined)', () => {
  for (const c of CASES) {
    const r = timingGate(c.input)
    assert.equal(typeof r.ok, 'boolean')
    assert.equal(typeof r.reason, 'string')
    assert.ok(r.detail !== null && r.detail !== undefined)
  }
})

test('timingGate:reason 词表与心跳现用口径同名(别造新词)', () => {
  assert.equal(TIMING_REASONS.nightHold, 'night-hold')
  assert.equal(TIMING_REASONS.dailyCap, 'daily-cap')
  assert.equal(TIMING_REASONS.tooSoon, 'too-soon')
  assert.equal(TIMING_REASONS.idleTooLong, 'idle-too-long')
  assert.equal(TIMING_REASONS.cooldown, 'cooldown')
  assert.equal(new Set(Object.values(TIMING_REASONS)).size, Object.keys(TIMING_REASONS).length, '词表不许重名')
})
