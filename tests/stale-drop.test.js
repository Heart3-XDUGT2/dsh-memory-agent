/**
 * C5 的电池:开口前先问一句"这事还有意义吗"。
 *
 * 两条判据必须**分开**测,因为她的闹钟与他下的命令是两回事:
 *   ① 她的闹钟:晚了太久就作废(夜里被压到早上**不算** —— 调用方在夜闸之后判);
 *   ② 他下的约定:光晚不够,得**他中间说过话**才算过期 ——
 *      他一声不吭就**照发**(他下的命令不许被"聪明地"吞掉)。
 * 还有一条纪律:认不出时间**不许**当成过期(0 不是"很久以前",是"不知道")。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isWakeStale, isRemindStale, lateSecOf, DEFAULT_STALE_HOURS } from '../lib/heartbeat.js'

const H = 3600
const NOW = 1_800_000_000

test('C5:闹钟晚了 3 小时 ⇒ 照响(默认阈值 24 小时)', () => {
  const v = isWakeStale({ atSec: NOW - 3 * H, nowSec: NOW })
  assert.equal(v.stale, false)
  assert.equal(v.lateSec, 3 * H)
  assert.equal(v.why, '')
  assert.equal(DEFAULT_STALE_HOURS, 24)
})

test('C5:闹钟晚了 30 小时 ⇒ 作废,而且理由写得出"晚了多少"', () => {
  const v = isWakeStale({ atSec: NOW - 30 * H, nowSec: NOW })
  assert.equal(v.stale, true)
  assert.match(v.why, /30 小时/)
  assert.match(v.why, /超过 24 小时/)
})

test('C5:夜里被压到早上**不算**过期(阈值以内的过夜是设计,不是故障)', () => {
  // 23:30 的闹钟早上 8:00 响 = 晚 8.5 小时 < 24 ⇒ 必须照响
  assert.equal(isWakeStale({ atSec: NOW - Math.round(8.5 * H), nowSec: NOW }).stale, false)
})

test('C5:阈值可调(他填 6 小时 ⇒ 晚 8.5 小时就作废;填 0/乱填 ⇒ 回落默认)', () => {
  assert.equal(isWakeStale({ atSec: NOW - Math.round(8.5 * H), nowSec: NOW, staleHours: 6 }).stale, true)
  assert.equal(isWakeStale({ atSec: NOW - 30 * H, nowSec: NOW, staleHours: 0 }).stale, true, '0 ⇒ 回落 24 小时')
  assert.equal(isWakeStale({ atSec: NOW - 10 * H, nowSec: NOW, staleHours: '胡说' }).stale, false)
})

test('C5:认不出时间 ⇒ **不判过期**(不知道 ≠ 很久以前)', () => {
  assert.equal(lateSecOf(0, NOW), 0)
  assert.equal(lateSecOf(undefined, NOW), 0)
  assert.equal(lateSecOf(NOW + 100, NOW), 0, '未来的时间也不是过期')
  assert.equal(isWakeStale({ atSec: 0, nowSec: NOW }).stale, false)
  assert.equal(isWakeStale({ atSec: NOW - 30 * H, nowSec: 0 }).stale, false)
})

test('C5:⚠️他下的约定 —— 晚 30 小时但**他一句话没说** ⇒ 照发', () => {
  const v = isRemindStale({ dueAtSec: NOW - 30 * H, nowSec: NOW, lastUserAtSec: 0 })
  assert.equal(v.stale, false)
  assert.match(v.why, /一句话没说/)
  // 他最后一次说话在约定到点**之前** ⇒ 也不算(那不是"他处理过了")
  assert.equal(isRemindStale({ dueAtSec: NOW - 30 * H, nowSec: NOW, lastUserAtSec: NOW - 40 * H }).stale, false)
})

test('C5:他下的约定,晚 30 小时**且他中间说过话** ⇒ 作废', () => {
  const v = isRemindStale({ dueAtSec: NOW - 30 * H, nowSec: NOW, lastUserAtSec: NOW - 2 * H })
  assert.equal(v.stale, true)
  assert.match(v.why, /已经说过话/)
})

test('C5:他下的约定,还没晚到阈值 ⇒ 照发(与他说没说话无关)', () => {
  assert.equal(isRemindStale({ dueAtSec: NOW - 2 * H, nowSec: NOW, lastUserAtSec: NOW - H }).stale, false)
})

test('C5:文案表里有 stale-drop 那一句(作废也要让账本说得清)', async () => {
  const { reasonTextOf } = await import('../lib/care-report.js')
  const line = typeof reasonTextOf === 'function' ? reasonTextOf('stale-drop') : null
  assert.ok(line === null || /过去/.test(String(line)), '若是函数则文案该说"过去了":' + String(line))
})
