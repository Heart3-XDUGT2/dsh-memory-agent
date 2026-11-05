/**
 * 悬置话题的类别(`lib/thread-kinds.js`)· **一致性电池**
 *
 * 两侧同源是这个仓的老规矩(`test_ddl_parity.py` 从 `lib/store.js` 抠 DDL 比对)。
 * 这里反过来:**从 `python/engine/threads.py` 正则抠出** THREAD_KINDS /
 * KIND_RULES / HAS_TIME_RE,逐条与 JS 镜像比对 —— 改一边不改另一边,灯就红。
 * 再加一层:确认 python 的单测里出现过同样的夹具输入(两边测同一批例子)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { THREAD_KINDS, KIND_RULES, HAS_TIME_RE, isThreadKind, resolveThreadKind } from '../lib/thread-kinds.js'
import { THREAD_KIND_MAX_AGE_SEC, THREAD_KIND_CAPS } from '../lib/soul-snapshot.js'

const py = readFileSync(fileURLToPath(new URL('../python/engine/threads.py', import.meta.url)), 'utf8')
const pyTest = readFileSync(fileURLToPath(new URL('../python/tests/test_threads.py', import.meta.url)), 'utf8')

/** 夹具与 python/tests/test_threads.py 的 ThreadKinds.FIXTURES 逐行相同。 */
const FIXTURES = [
  ['提醒我两分钟后洗衣服', '', 'reminder'],
  ['用户要求2分钟后提醒他睡觉', '', 'reminder'],
  ['用户坐今晚10点的火车回家,预计明天早上八点到站', '', 'schedule'],
  ['用户把车票退了,改成10月7日当天出发', '', 'schedule'],
  ['明天中午12点到达合肥,可在那之后问候是否顺利到达', '', 'care'],
  ['用户计划明天开始学习数据结构', '', 'promise'],
  ['用户今天的三公里跑没有完成,说先欠着,之后需要补跑', '', 'promise'],
  ['大类分流后专业确定,说好回来汇报最终专业', 'topic', 'topic'],
  ['车票的事', 'schedule', 'schedule'],
  ['大类分流后专业确定,说好回来汇报最终专业', 'meeting', ''],
  ['随手记一句', '', ''],
  ['提醒我两分钟后洗衣服', 'care', 'reminder'],
  ['明天要去面试', '', 'schedule'],
  ['回家路上顺便买了本书', '', ''],
  ['', '', '']
]

test('一致性:JS 的 THREAD_KINDS 与 python/engine/threads.py 逐字相同', () => {
  const m = /^THREAD_KINDS = \(([^)]*)\)/m.exec(py)
  assert.ok(m, 'python 侧没抠到 THREAD_KINDS(正则或格式变了?)')
  const pyKinds = [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1])
  assert.deepEqual(pyKinds, THREAD_KINDS, '两边的类别枚举漂了 —— 改一边必须改另一边')
  assert.deepEqual(THREAD_KINDS, ['promise', 'schedule', 'reminder', 'care', 'topic'])
})

test('一致性:JS 的 KIND_RULES 与 python 逐条相同(顺序也是优先级)', () => {
  const m = /^KIND_RULES = \(\n([\s\S]*?)\n\)/m.exec(py)
  assert.ok(m, 'python 侧没抠到 KIND_RULES')
  const pyRules = [...m[1].matchAll(/\("([a-z]+)", "([^"]*)"\)/g)].map((x) => [x[1], x[2]])
  assert.deepEqual(pyRules, KIND_RULES, '规则表漂了')
  assert.ok(pyRules.length >= 4)
})

test('一致性:HAS_TIME_RE 与 python 逐字相同', () => {
  const m = /^HAS_TIME_RE = "([^"]*)"/m.exec(py)
  assert.ok(m, 'python 侧没抠到 HAS_TIME_RE')
  assert.equal(m[1], HAS_TIME_RE)
})

test('一致性:两边测的是同一批夹具(每一条非空输入都在 python 单测里出现)', () => {
  for (const [content] of FIXTURES) {
    if (content === '') continue
    assert.ok(pyTest.includes('"' + content + '"'), 'python 夹具里没有这一条:' + content)
  }
})

test('判定:规则优先 → LLM 兜底 → 认不出留空(不猜)', () => {
  for (const [content, llm, want] of FIXTURES) {
    assert.equal(resolveThreadKind(content, llm), want, JSON.stringify({ content, llm }))
  }
})

test('判定:schedule 必须同时有时间锚(只有动词不算日程)', () => {
  assert.equal(resolveThreadKind('回家'), '')
  assert.equal(resolveThreadKind('明天回家'), 'schedule')
  assert.equal(resolveThreadKind('明天要去面试'), 'schedule')
})

test('一致性:注入侧类内时效(D3)与 python 的冷却窗**同源**', () => {
  const m = /^COOL_AFTER_SECONDS = \{\n([\s\S]*?)\n\}/m.exec(py)
  assert.ok(m, 'python 侧没抠到 COOL_AFTER_SECONDS')
  const pyCaps = {}
  for (const g of m[1].matchAll(/"([a-z]*)"\s*:\s*([0-9]+) \* ([0-9]+)/g)) {
    pyCaps[g[1]] = Number(g[2]) * Number(g[3])
  }
  for (const [kind, sec] of Object.entries(THREAD_KIND_MAX_AGE_SEC)) {
    assert.equal(pyCaps[kind], sec, kind + ' 的时效两边不一致')
  }
  // 未分类('')只在引擎侧有冷却窗(D2);注入侧根本不放行未分类(D3),不需要它的时效
  assert.equal(pyCaps[''], 7 * 86400, "'' 的冷却窗是 7 天(D2)")
  assert.ok(!Object.prototype.hasOwnProperty.call(THREAD_KIND_MAX_AGE_SEC, ''))
  assert.deepEqual(THREAD_KIND_CAPS, { topic: 2, schedule: 2, care: 1 })
})

test('判定:白名单 + 脏输入不抛、不猜', () => {
  assert.equal(isThreadKind('topic'), true)
  assert.equal(isThreadKind('TOPIC'), true, '大小写不敏感')
  assert.equal(isThreadKind('meeting'), false)
  assert.equal(isThreadKind(null), false)
  for (const bad of [null, undefined, '', '   ', 42, [], {}, true]) {
    assert.equal(resolveThreadKind(bad), '', String(bad))
    assert.equal(resolveThreadKind(bad, bad), '', String(bad))
  }
})
