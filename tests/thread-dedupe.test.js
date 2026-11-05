import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  normThreadContent, matchOpenThread, cpLength, THREAD_NORM_MAX,
  semanticThreadMatch, normForSimilarity, THREAD_SEMANTIC_WINDOW_SEC, THREAD_SEMANTIC_SIMILARITY
} from '../lib/thread-dedupe.js'
import { similarityOf } from '../lib/speech-guard.js'

// 夹具与 python/tests/test_threads.py:34-74 同一组 —— 权威实现是
// python/engine/threads.py 的 _norm_content + remember_pending_thread,
// 本镜像只服务离线合并脚本。两边判定必须一致,否则合并会把
// 她主动开口的燃料灌成两条(同一件事问两遍)。

const thread = (id, content) => ({ threadId: id, content })

test('规整:空白折叠(多空白/制表/换行 → 单空格)', () => {
  assert.equal(normThreadContent('  多   空白\t换\n行  '), '多 空白 换 行')
})

test('规整:300 字硬顶', () => {
  const long = normThreadContent('长'.repeat(500))
  assert.equal(cpLength(long), THREAD_NORM_MAX)
  assert.equal(long, '长'.repeat(300))
})

test('规整:空内容与全空白 → 空串', () => {
  assert.equal(normThreadContent('   '), '')
  assert.equal(normThreadContent(null), '')
  assert.equal(normThreadContent(undefined), '')
})

test('去重:全等命中(重提不新建)', () => {
  const open = [thread(7, '明天要告诉我面试的结果')]
  assert.equal(matchOpenThread(open, '明天要告诉我面试的结果'), 7)
  // 空白差异不影响命中(规整后全等)
  assert.equal(matchOpenThread(open, ' 明天要告诉我面试的结果 '), 7)
})

test('去重:≥6 字的双向包含命中(长话登记后短的核心重提)', () => {
  const open = [thread(3, '明天要告诉你面试的结果怎么样')]
  assert.equal(matchOpenThread(open, '面试的结果怎么样'), 3)
  // 反向:短的在库里,长的重提也命中
  assert.equal(matchOpenThread([thread(4, '面试的结果怎么样')], '明天要告诉你面试的结果怎么样'), 4)
})

test('去重:<6 字的短子串不算重提(「面试」太泛)', () => {
  assert.equal(matchOpenThread([thread(1, '面试结果如何')], '面试'), 0)
})

test('去重:空内容恒不命中(不误并到第一条)', () => {
  assert.equal(matchOpenThread([thread(1, '面试结果如何')], '   '), 0)
})

test('去重:按调用方给的顺序取第一个命中(权威实现按 updated_at DESC)', () => {
  const open = [thread(9, '跑步计划'), thread(2, '跑步计划')]
  assert.equal(matchOpenThread(open, '跑步计划'), 9)
})

test('去重:没有 open 话题 → 不命中(合并全新的)', () => {
  assert.equal(matchOpenThread([], '明天要告诉我面试的结果'), 0)
  assert.equal(matchOpenThread(null, '明天要告诉我面试的结果'), 0)
})

test('去重:thread_id 两种字段名都认(snake/camel)', () => {
  assert.equal(matchOpenThread([{ thread_id: 11, content: '考试安排' }], '考试安排'), 11)
})

// ---- D4:语义去重(2026-10-06)------------------------------------------------
const pyThreads = readFileSync(fileURLToPath(new URL('../python/engine/threads.py', import.meta.url)), 'utf8')
const pyTest = readFileSync(fileURLToPath(new URL('../python/tests/test_threads.py', import.meta.url)), 'utf8')

/** 夹具与 python/tests/test_threads.py 的 ThreadSemanticDedupe.REPLAY 同一批。 */
const REPLAY = [
  ['用户计划明天开始学习数据结构', '用户计划明天学习数据结构。', 0.714, true],
  ['写西电的oj作业', '他要去写西电的OJ作业,两分钟后提醒他', 0.412, false],
  ['上周的面试', '这周的面试', 0.6, false],
  ['用户大类分流后专业确定,说好回来汇报最终专业。', '用户分流专业确定后告知结果', 0.192, false]
]

test('D4:阈值/窗口与 python 侧同源(0.70 / 48h)', () => {
  const w = /^THREAD_SEMANTIC_WINDOW_SEC = ([0-9]+) \* ([0-9]+)/m.exec(pyThreads)
  const s = /^THREAD_SEMANTIC_SIMILARITY = ([0-9.]+)/m.exec(pyThreads)
  assert.ok(w && s, 'python 侧没抠到 D4 两个常量')
  assert.equal(Number(w[1]) * Number(w[2]), THREAD_SEMANTIC_WINDOW_SEC)
  assert.equal(Number(s[1]), THREAD_SEMANTIC_SIMILARITY)
  assert.equal(THREAD_SEMANTIC_SIMILARITY, 0.7)
  for (const row of REPLAY) {
    assert.ok(pyTest.includes('"' + row[0] + '"'), 'python 夹具里没有这一条:' + row[0])
  }
})

test('D4:判重归一与 python 的 norm_text 对齐 —— 同一对句子两边算出同一个数', () => {
  // 现场:先用 normThreadContent(保留标点)算 ⇒ 0.667,而 python 的 norm_text
  // 去标点 ⇒ 0.714 —— 跨过 0.70 阈值就成了"一边并一边不并"。所以语义层
  // **必须**用 normForSimilarity(去空白 + 去标点 + 小写)。
  assert.equal(normForSimilarity('用户计划明天学习数据结构。'), '用户计划明天学习数据结构')
  assert.equal(normForSimilarity('  多 空白\t换行  '), '多空白换行')
  assert.equal(normForSimilarity('A,b。c'), 'abc')
  for (const [a, b, sim] of REPLAY) {
    const js = similarityOf(normForSimilarity(a), normForSimilarity(b))
    assert.ok(Math.abs(js - sim) < 0.011, a + ' 的相似度两边不一致:js=' + js.toFixed(3) + ' py=' + sim)
  }
})

test('D4:语义命中(同 kind + 48h + Jaccard ≥ 0.70)⇒ 返回既有 id', () => {
  const now = 1790361736
  const open = [
    { threadId: 4, content: '用户计划明天开始学习数据结构', kind: 'promise', createdAt: now - 3 * 3600 },
    { threadId: 9, content: '用户大类分流后专业确定,说好回来汇报最终专业。', kind: 'topic', createdAt: now - 3600 }
  ]
  // 0.714 ⇒ 命中(措辞不同的同一件事)
  assert.equal(semanticThreadMatch(open, { content: '用户计划明天学习数据结构。', kind: 'promise', createdAt: now }), 4)
  // 跨 kind(同文也不并)
  assert.equal(semanticThreadMatch(open, { content: '用户计划明天开始学习数据结构', kind: 'care', createdAt: now }), 0)
  // 超 48h 窗(同文也不并)
  assert.equal(semanticThreadMatch(
    [{ threadId: 2, content: '用户计划明天开始学习数据结构', kind: 'promise', createdAt: now - 10 * 86400 }],
    { content: '用户计划明天开始学习数据结构', kind: 'promise', createdAt: now }), 0)
  // 相似度不足(不该并的对照)
  assert.equal(semanticThreadMatch(
    [{ threadId: 3, content: '上周的面试', kind: 'schedule', createdAt: now - 3600 }],
    { content: '这周的面试', kind: 'schedule', createdAt: now }), 0)
  // 脏输入不抛
  assert.equal(semanticThreadMatch(null, null), 0)
  assert.equal(semanticThreadMatch([{ threadId: 0, content: 'x' }], { content: 'x' }), 0)
})
