import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LEDGER_MAX, GOLD_TIER_LIVE, armBreakdown, ledgerEntry, goldDraft, createRetrieveLedger
} from '../lib/retrieve-ledger.js'

test('RT9:臂分解读的是引擎实况(cov/r_now/emo/total),缺字段就记 null 不编数', () => {
  const items = [
    { memory_id: 251, layer: 'L1', hits: 0.63, r_now: 0.41, emotion_score: 0.2, total: 0.5, matched: true },
    { memory_id: 7, layer: 'L0', hits: 0.1, r_now: 0.9, emotion_score: 0, total: 0.3, forced: true }
  ]
  const b = armBreakdown(items, { topK: 5 })
  assert.equal(b.rows.length, 2)
  assert.equal(b.rows[0].cov, 0.63)
  assert.equal(b.rows[0].rNow, 0.41)
  assert.equal(b.rows[1].forced, true)
  assert.deepEqual(b.arms, { lexical: true, recall: true, emotion: true, vector: false })
  assert.equal(b.counts.forced, 1)
  assert.deepEqual(b.counts.layers, { L1: 1, L0: 1 })
})

test('RT9:JS 基线那条路没有 total/r_now ⇒ 如实记 null(不拿别的东西顶上)', () => {
  const b = armBreakdown([{ memoryId: 3, keywords: ['面试'], summary: '面试' }], { topK: 5 })
  assert.equal(b.rows[0].id, 3)
  assert.equal(b.rows[0].total, null)
  assert.equal(b.rows[0].cov, null)
  assert.equal(b.arms.recall, false)
  assert.equal(b.arms.lexical, false, '这条路上连词法分都没有 ⇒ 不许谎报有')
})

test('RT9:垃圾输入不崩(账本不许把"记不下来"变成"这一轮出错")', () => {
  assert.equal(armBreakdown(null).rows.length, 0)
  assert.equal(armBreakdown([null, 42, 'x']).rows.length, 0)
  const e = ledgerEntry({})
  assert.equal(e.query, '')
  assert.equal(e.topK, 6)
  assert.deepEqual(e.top, [])
})

test('RT9:一问的账带查询原文/引擎/降级标注 + top 就是进榜那几条', () => {
  const e = ledgerEntry({
    query: '他面试那场每人给了多少钱',
    engine: 'python',
    topK: 2,
    items: [{ memory_id: 79, hits: 0.5 }, { memory_id: 83, hits: 0.4 }, { memory_id: 99, hits: 0.1 }],
    now: 1790000000000
  })
  assert.equal(e.engine, 'python')
  assert.deepEqual(e.top, [79, 83])
  assert.equal(e.at, 1790000000000)
})

test('RT9:环形缓冲只留最近 50 问,零命中单独计数(那正是"她明明记得却没说"的入口)', () => {
  const led = createRetrieveLedger({ max: 3, now: () => 1234 })
  for (let i = 1; i <= 5; i++) {
    led.push(ledgerEntry({ query: 'q' + i, engine: i === 4 ? 'baseline' : 'python', items: i === 2 ? [] : [{ memory_id: i, hits: 0.5 }] }))
  }
  const s = led.stats()
  assert.equal(s.pushed, 5)
  assert.equal(s.kept, 3)
  assert.equal(s.dropped, 2)
  assert.equal(s.zeroHit, 1)
  assert.equal(s.lastQuery, 'q5')
  assert.equal(s.byEngine.python, 4)
  assert.equal(s.byEngine.baseline, 1)
  assert.equal(s.cap, 3)
  assert.equal(led.list().length, 3)
  led.clear()
  assert.equal(led.list().length, 0)
  assert.equal(LEDGER_MAX, 50, '默认留 50 问')
})

test('RT9:push 的东西再怪也不许抛(它站在每一轮的路上)', () => {
  const led = createRetrieveLedger({})
  assert.doesNotThrow(() => led.push(null))
  assert.doesNotThrow(() => led.push('字符串'))
  assert.equal(led.stats().pushed, 0)
})

test('RT9:金标草稿形状对齐 retrieval-bench.py 的 (档位, query, {ids}, 依据)', () => {
  const d = goldDraft({ query: '我校园跑还差几次', ids: [21, 21, 152, 0, 'x'], why: '真机:该想起来却没调出来', replyText: '……' })
  assert.equal(d.tier, GOLD_TIER_LIVE)
  assert.deepEqual(d.ids, [21, 152], '去重 + 只留正整数')
  assert.equal(d.source, 'live')
  assert.equal(goldDraft({ query: '', ids: [1] }), null, '没查询原文 = 不是一条金标')
  assert.equal(goldDraft({ query: 'q', ids: [] }), null, '认不出答案 = 只能进负控档,不做正样本草稿')
})
