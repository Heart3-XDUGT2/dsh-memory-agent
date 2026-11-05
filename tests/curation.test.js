/**
 * v0.20.0 D1:compaction 策展块的内容层电池(纯函数,离线)。
 *
 * 钉住三条硬性质:
 *   ① **绝不超过预算** —— 区域事务会拒绝"不比被遮蔽历史小"的摘要
 *      (`summary is not smaller than ...`),超预算就是压缩失败;
 *   ② **绝不空** —— 引擎侧 `summarization produced no text summary content`
 *      是硬抛错;
 *   ③ **不重复每轮快照** —— 想念曲线/检索回响不在策展块里(压缩后照样每轮重算)。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateTokens, budgetFor, composeCuratedText, trimToBudget, CHARS_PER_TOKEN
} from '../lib/curation.js'

const NOW = 1790361736 // 2026-09-27 左右的 epoch 秒
const rows = () => ({
  profile: { name: '阿岚', core_traits: '{"语言":"中文","代词":"他"}', affinity: 50 },
  counts: { memories: 233, beliefs: 1, turns: 412, firstAt: NOW - 86400 * 9, lastAt: NOW - 600 },
  threads: [
    { content: '用户今天的三公里跑没有完成，说先欠着，之后需要补跑', follow_up_after: NOW + 86400 },
    { content: '面试结果出来要告诉她', follow_up_after: 0 }
  ],
  moments: [
    { summary: '他第一次喊她名字时她愣了三秒', timestamp: NOW - 86400 * 3, emotion_score: 8 },
    { summary: '他们约好周末一起看那部老片', timestamp: NOW - 86400, emotion_score: 6 }
  ],
  mood: { mood_intensity: 6, user_emotion: '疲惫', mood_reason: '他加班到很晚', updated_at: NOW - 3600 }
})

test('估算:1.6 字符一个 token(中文保守高估)', () => {
  assert.equal(CHARS_PER_TOKEN, 1.6)
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('ab'), 2) // ceil(2/1.6)=2
  assert.equal(estimateTokens('一'.repeat(16)), 10)
})

test('预算:配置上限与"被遮蔽区一小份"取小;量不到规模就用配置上限', () => {
  assert.equal(budgetFor({ totalTokens: 0, configuredTokens: 1200 }), 1200)
  assert.equal(budgetFor({ totalTokens: 100000, configuredTokens: 1200 }), 1200) // 十万 token 也只写 1200
  assert.equal(budgetFor({ totalTokens: 4000, configuredTokens: 1200 }), 400)    // 10% 份额赢
  assert.equal(budgetFor({ totalTokens: 100, configuredTokens: 1200 }), 80)      // 地板
})

test('策展块:四段都在,且是她的账本语气(没有 ## Pending Jobs 那种工程腔)', () => {
  const text = composeCuratedText(rows(), { budgetTokens: 1200, now: NOW })
  assert.ok(text.includes('压缩备忘'))
  assert.ok(text.includes('我们:'), '关系账本')
  assert.ok(text.includes('还没结掉:'), '悬置话题')
  assert.ok(text.includes('她记得的:'), '最该活下来的记忆')
  assert.ok(text.includes('她上次记下的情绪:'), '情绪线')
  assert.ok(text.includes('三公里跑'), '具体约定要带原文片段')
  assert.ok(text.includes('聊天') === false && text.includes('## ') === false,
    '不许出现工程检查点的标题体裁')
  assert.ok(text.includes('别复述本段'), '尾注纪律')
})

test('策展块:不重复每轮快照的东西(想念曲线 / 检索回响不进策展块)', () => {
  const text = composeCuratedText(rows(), { budgetTokens: 1200, now: NOW })
  assert.equal(text.includes('【想念】'), false, '想念曲线每轮重算,压缩块里写它=双重记忆')
  assert.equal(text.includes('【记忆回响】'), false, '同上')
})

test('硬性质:任何预算下都不超预算,且永远非空', () => {
  for (const budget of [40, 60, 80, 120, 200, 400, 1200, 4000]) {
    const text = composeCuratedText(rows(), { budgetTokens: budget, now: NOW })
    assert.ok(text.trim() !== '', budget + ' 预算下不该是空')
    assert.ok(estimateTokens(text) <= budget,
      '预算 ' + budget + ' 超了:' + estimateTokens(text) + ' tokens')
  }
})

test('硬性质:空行/坏行也绝不空(引擎空摘要会硬抛)', () => {
  for (const bad of [{}, null, undefined, { profile: null, counts: {}, threads: [], moments: [], mood: null }]) {
    const text = composeCuratedText(bad, { budgetTokens: 80, now: NOW })
    assert.ok(text.trim() !== '')
    assert.ok(estimateTokens(text) <= 80)
  }
})

test('预算紧时按优先级丢:账本留着,后面的段先走', () => {
  const small = composeCuratedText(rows(), { budgetTokens: 60, now: NOW })
  const big = composeCuratedText(rows(), { budgetTokens: 1200, now: NOW })
  assert.ok(small.length < big.length)
  assert.ok(small.includes('压缩备忘'), '首行永远在')
  assert.equal(small.includes('三公里跑'), false, '紧预算下先丢细节段')
})

test('D3:「早该问了」只在真的到期未提时出现(提过的/不定时的都不写)', () => {
  const r = rows()
  r.threads = [
    { content: '到期未提的约定', follow_up_after: NOW - 3600, last_mentioned_at: 0 },
    { content: '已经提过的事', follow_up_after: 0, last_mentioned_at: NOW - 600 },
    { content: '还没到点的约定', follow_up_after: NOW + 86400, last_mentioned_at: 0 },
    { content: '不定时的老事', follow_up_after: 0, last_mentioned_at: 0 }
  ]
  const text = composeCuratedText(r, { budgetTokens: 1200, now: NOW })
  const line = text.split('\n').find((l) => l.includes('还没结掉:'))
  assert.ok(line, '悬置那一段要在')
  assert.ok(line.includes('到期未提的约定(早该问了)'), '真到期未提 ⇒ 写「早该问了」')
  assert.ok(!line.includes('已经提过的事(早该问了)'), '提过的不许再写「早该问了」')
  assert.ok(/还没到点的约定\(.+ 到期\)/.test(line), '没到点的写"到期"而不是"早该问了"')
  assert.ok(!line.includes('还没到点的约定(早该问了)'))
  assert.ok(!/不定时的老事\(/.test(line), '不定时的(fu=0)不写括号')
})

test('core_traits 坏 JSON 不许炸(宁可不写画像,也不能让压缩失败)', () => {
  const r = rows()
  r.profile.core_traits = '{这不是 JSON'
  const text = composeCuratedText(r, { budgetTokens: 400, now: NOW })
  assert.ok(text.includes('阿岚'))
  assert.ok(!text.includes('语言'))
})

test('trimToBudget:从尾部按行丢,保底两行', () => {
  const text = ['第一行', '第二行', '第三行', '第四行', '第五行'].join('\n')
  const out = trimToBudget(text, 5)
  const lines = out.split('\n')
  assert.ok(lines.length >= 2)
  assert.equal(lines[0], '第一行')
  assert.equal(lines[lines.length - 1], '第五行', '末行(纪律尾注)留着')
  assert.ok(estimateTokens(out) <= Math.max(20, 5) || lines.length === 2)
})
