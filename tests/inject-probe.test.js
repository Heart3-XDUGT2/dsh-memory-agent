/**
 * A0 兼容闸 + A1a 注入探针 的电池。
 *
 * 为什么这两块要单独钉:
 *   - 兼容闸判错的代价是"整轮组装炸掉"(或悄悄退化成没有记忆),两种都不能接受;
 *   - 探针是**先量再搬**的依据 —— 它数错了,后面的搬迁决策就建立在一个假数字上。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostCaps, createCompat, CAP_KEYS } from '../lib/compat.js'
import { firstMarkerLine, countMarker, probeReport, createInjectProbe } from '../lib/inject-probe.js'

// ---- A0 兼容闸 -------------------------------------------------------------

test('兼容闸:三个挂点全在 ⇒ 无 note,ok=true', () => {
  const c = hostCaps({ section () {}, context () {}, variable () {} })
  assert.equal(c.ok, true)
  assert.equal(c.section, true)
  assert.equal(c.context, true)
  assert.equal(c.variable, true)
  assert.equal(c.note, '')
})

test('兼容闸:只有 section(老宿主)⇒ context/variable 为 false,note 点名缺谁', () => {
  const c = hostCaps({ section () {} })
  assert.equal(c.context, false)
  assert.equal(c.variable, false)
  assert.match(c.note, /context/)
  assert.match(c.note, /variable/)
  assert.match(c.note, /退回旧做法/)
})

test('兼容闸:服务不在 ⇒ ok=false,note 说清"没地方注入"而不是"降级"', () => {
  const c = hostCaps(null)
  assert.equal(c.ok, false)
  assert.equal(c.section, false)
  assert.match(c.note, /服务不在/)
})

test('兼容闸:非函数（摆了字段但不可调用）也算没有', () => {
  const c = hostCaps({ section: 'yes', context: 1, variable: null })
  assert.deepEqual(CAP_KEYS.filter((k) => c[k]), [])
})

test('兼容闸:探测只做一次并缓存,日志也只留一行', () => {
  let calls = 0
  let logged = 0
  const compat = createCompat({ logger: { info () { logged += 1 } } })
  const svc = { section () {} }
  assert.equal(compat.last(), null, '没探过 = null(面板照实说"还没探")')
  const a = compat.check(svc)
  const b = compat.check({ section () {}, context () {} }) // 第二次传了更强的服务,也**不再探**
  assert.equal(a, b, '缓存:同一份对象')
  assert.equal(b.context, false, '不会被后来的探测翻案')
  assert.equal(calls, 0)
  assert.equal(logged, 1, '只留一行 info')
  compat.reset()
  assert.equal(compat.last(), null)
})

test('兼容闸:全挂点齐时不打日志(退回才留痕)', () => {
  let logged = 0
  const compat = createCompat({ logger: { info () { logged += 1 } } })
  compat.check({ section () {}, context () {}, variable () {} })
  assert.equal(logged, 0)
})

// ---- A1a 注入探针 ----------------------------------------------------------

test('标记行:取第一行够长的非空行,短的跳过,超长截断', () => {
  assert.equal(firstMarkerLine('[她此刻的状态]\n其余', 8), '[她此刻的状态]')
  assert.equal(firstMarkerLine('[短]\n\n  [她此刻的状态]  ', 8), '[她此刻的状态]')
  assert.equal(firstMarkerLine('[短]\nabc', 8), '', '没有够长的行 ⇒ 空标记,不做半截的匹配')
  assert.equal(firstMarkerLine(null), '')
  assert.equal(firstMarkerLine('x'.repeat(500), 8).length, 120)
})

test('计数:同一段文本里出现多次都数到,空标记不数', () => {
  const r = countMarker(['a\nM\nb\nM', 'M'], 'M')
  assert.equal(r.occurrences, 3)
  assert.deepEqual(r.hits, [2, 1])
  assert.equal(r.chars, 3 * 1, '"M" 每处 1 字')
  assert.deepEqual(countMarker(['M'], ''), { occurrences: 0, chars: 0, hits: [] })
})

test('探针报告:只报**真的数过**的语料,空语料不进 scopes(诚实的一半)', () => {
  const r = probeReport({
    at: 123,
    marker: 'M',
    corpora: { 'system-prompt/sections': ['M'], 'pre-step/messages': [] }
  })
  assert.equal(r.occurrences, 1)
  assert.deepEqual(r.scopes, ['system-prompt/sections'], '没数的语料不许出现在 scopes 里')
  assert.deepEqual(r.per, { 'system-prompt/sections': 1 })
  assert.equal(r.duplicated, false)
  assert.equal(r.at, 123)
})

test('探针报告:两份以上就是红线(duplicated)', () => {
  const r = probeReport({ marker: 'M', corpora: { a: ['M'], b: ['M'] } })
  assert.equal(r.occurrences, 2)
  assert.equal(r.duplicated, true)
  assert.deepEqual(r.per, { a: 1, b: 1 })
})

test('探针:保存最近一次;给坏数据也不抛(探针绝不影响注入)', () => {
  const p = createInjectProbe()
  assert.equal(p.last(), null)
  p.record({ marker: 'M', corpora: { a: ['M'] } })
  assert.equal(p.last().occurrences, 1)
  assert.doesNotThrow(() => p.record({ marker: null, corpora: { a: [{}] } }))
  assert.equal(p.last().occurrences, 0)
  p.reset()
  assert.equal(p.last(), null)
})
