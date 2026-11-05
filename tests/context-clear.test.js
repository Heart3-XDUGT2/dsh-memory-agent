import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearOutcome, clearLabel } from '../lib/context-clear.js'

// 2026-09-26 他要一个「清空上下文」的按钮。查过宿主:插件没有删历史的手
// (SessionSurface 替换被来源校验锁着、只给压缩用;sessions.create 是调用方
// fiber 所有、不进 agent 生命周期就不落盘)。能做的是给宿主的 /compact 那只手
// (compaction.compactNow → selectCompactableRange(..., 0))装个把手。
// 这个文件钉的是「宿主各种回话,面板上该显示什么人话」。

test('✓ 真压掉了:报条数与 token,并说清记录没删', () => {
  const r = clearOutcome({ result: { shadowedSeqs: [3, 4, 5, 6, 7], shadowedTokenCount: 4210, summarySeq: 8 } })
  assert.equal(r.ok, true)
  assert.equal(r.code, 'cleared')
  assert.equal(r.shadowed, 5)
  assert.match(r.text, /5 条/)
  assert.match(r.text, /4210/)
  assert.match(r.text, /记录没删/)
})

test('宿主说「没有可压的区间」(result null)= 历史太短或已压过,不算失败也不算成功', () => {
  const r = clearOutcome({ result: null })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'nothing')
  assert.match(r.text, /没有可压的区间/)
})

test('她正忙:ManualCompactionError(busy) 翻成人话,而不是把宿主原文丢给用户', () => {
  const err = new Error('manual compaction requires an idle agent with no waking queued work')
  err.name = 'ManualCompactionError'
  const r = clearOutcome({ error: err })
  assert.equal(r.code, 'busy')
  assert.match(r.text, /等她这轮说完再点/)
  assert.doesNotMatch(r.text, /idle agent/)
})

test('取消(Abort)与压缩服务不存在,各有各的话', () => {
  const abort = new Error('This operation was aborted')
  abort.name = 'AbortError'
  assert.equal(clearOutcome({ error: abort }).code, 'cancelled')
  assert.equal(clearOutcome({ error: new Error('compaction unsupported: 宿主没有压缩服务') }).code, 'no-service')
})

test('真出错:保留宿主原文,便于他拿去查', () => {
  const r = clearOutcome({ error: new Error('summarizer model not configured') })
  assert.equal(r.code, 'error')
  assert.match(r.text, /summarizer model not configured/)
})

test('返回了但压掉 0 条:也归到「没得清」', () => {
  assert.equal(clearOutcome({ result: { shadowedSeqs: [], shadowedTokenCount: 0 } }).code, 'nothing')
})

test('标签映射覆盖每个 code(面板按它上色)', () => {
  for (const code of ['cleared', 'nothing', 'busy', 'cancelled', 'no-service', 'no-agent', 'error']) {
    assert.notEqual(clearLabel(code), '未知', code)
  }
  assert.equal(clearLabel('cleared'), '已清空')
  assert.equal(clearLabel('wat'), '未知')
})
