/**
 * F1 的电池:外部事件(「他到家了」)只做一件事 —— 排一个到点的 wake。
 *
 * 三件事必须有测试守着:
 *   ① 过去的时间 = 立刻响(传感器说"他两分钟前到的",不该排到两分钟后);
 *   ② 时间认不出来**拒收**,不猜(猜错就是半夜把她叫起来);
 *   ③ 文本截断要留痕(截了就得说截了 —— 不许无声改他的原话)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseExternalEvent, parseEventTime, eventReason, EVENT_MAX_CHARS, EVENT_MAX_AHEAD_MS
} from '../lib/external-event.js'

const NOW = new Date(2026, 8, 28, 20, 0, 0, 0).getTime()

test('F1:最简事件(kind + 一句补充)⇒ 立刻响的 wake', () => {
  const p = parseExternalEvent({ kind: 'arrived-home', text: '他到楼下了' }, NOW)
  assert.equal(p.ok, true)
  assert.equal(p.kind, 'arrived-home')
  assert.equal(p.note, 'arrived-home：他到楼下了')
  assert.equal(p.at, Math.round(NOW / 1000))
  assert.equal(p.truncated, false)
})

test('F1:没有补充文本也认(只有事件名)', () => {
  assert.equal(parseExternalEvent({ kind: 'sat-down' }, NOW).note, 'sat-down')
  assert.equal(parseExternalEvent({ type: 'sat-down' }, NOW).kind, 'sat-down', 'type 也认')
})

test('F1:过去的时间 ⇒ 就是"现在该响了"(不许排到过去)', () => {
  const p = parseExternalEvent({ kind: 'arrived-home', at: Math.round(NOW / 1000) - 120 }, NOW)
  assert.equal(p.at, Math.round(NOW / 1000))
})

test('F1:未来的时间照排(但封顶 30 天)', () => {
  const in5 = Math.round(NOW / 1000) + 300
  assert.equal(parseExternalEvent({ kind: 'x', at: in5 }, NOW).at, in5)
  const way = Math.round((NOW + EVENT_MAX_AHEAD_MS * 3) / 1000)
  assert.equal(parseExternalEvent({ kind: 'x', at: way }, NOW).at, Math.round((NOW + EVENT_MAX_AHEAD_MS) / 1000))
})

test('F1:时间认不出来 ⇒ **拒收**(猜错就是半夜把她叫起来)', () => {
  const p = parseExternalEvent({ kind: 'x', at: '昨天下午' }, NOW)
  assert.equal(p.ok, false)
  assert.match(p.error, /at 认不出来/)
  assert.equal(parseEventTime('明天', NOW), null)
})

test('F1:秒/毫秒/ISO 三种写法都认', () => {
  const sec = Math.round(NOW / 1000) + 60
  assert.equal(parseEventTime(sec, NOW), sec * 1000)
  assert.equal(parseEventTime(sec * 1000, NOW), sec * 1000, '毫秒也认(别当成 1970 年)')
  assert.equal(parseEventTime('2026-09-28T21:30', NOW), new Date(2026, 8, 28, 21, 30, 0, 0).getTime())
  assert.equal(parseEventTime('', NOW), NOW, '没给就是现在')
  assert.equal(parseEventTime(undefined, NOW), NOW)
})

test('F1:没有 kind ⇒ 拒收,而且理由是人话', () => {
  const p = parseExternalEvent({ text: '他到楼下了' }, NOW)
  assert.equal(p.ok, false)
  assert.match(p.error, /kind/)
  assert.equal(parseExternalEvent(null, NOW).ok, false)
  assert.equal(parseExternalEvent({ kind: 'x'.repeat(80) }, NOW).ok, false)
})

test('F1:文本截断要**留痕**(截了就说截了,不许无声改他的原话)', () => {
  const long = '他'.repeat(EVENT_MAX_CHARS + 50)
  const p = parseExternalEvent({ kind: 'x', text: long }, NOW)
  assert.equal(p.ok, true)
  assert.equal(p.truncated, true)
  assert.equal(p.note.length, 'x：'.length + EVENT_MAX_CHARS)
})

test('F1:账上那句话带得出是哪类事件', () => {
  assert.equal(eventReason('arrived-home'), '外部事件:arrived-home')
  assert.ok(eventReason(null).startsWith('外部事件:'))
})
