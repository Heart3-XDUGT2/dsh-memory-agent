/**
 * P2 电池:边缘区**复核**那一次模型调用(`lib/topic-review.js`)。
 *
 * 这是整个主动性 v2 里**唯一新增的模型调用点**(施工图 §3.5 决定①),
 * 所以它的每一条纪律都必须是可测的、不许靠"应该不会":
 *   ① **超时 = 未过**(沉默是合法结果,绝不降级成"硬说");
 *   ② 认不出的产出 **= 未过**(坏输出不许变成"她说了一句");
 *   ③ 输入**只给候选话题 + 最近上下文摘要,不给全文**;
 *   ④ 失败/没接上 run ⇒ 未过,而且**不抛**(它是挡在开口前的一步,
 *      炸掉就等于把她那一拍整个吞掉)。
 *
 * 全部离线:`run` 是注入的假件,真 run 由壳给(`runStructured`)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  reviewOnce, reviewPrompt, parseReview, clampReviewTimeoutMs,
  REVIEW_DEFAULT_TIMEOUT_MS, REVIEW_MIN_MS, REVIEW_MAX_MS, REVIEW_SCHEMA
} from '../lib/topic-review.js'

const CAND = {
  id: 'thread:19', type: 'thread', score: 0.62,
  text: '用户坐今晚10点的火车回家,预计早上八点到,他答应到了会说一声'
}

// ---- ① 产出清洗 --------------------------------------------------------------

test('parseReview:只认 true/false;认不出/缺字段/坏形状一律**未过**', () => {
  assert.deepEqual(parseReview({ speak: true, why: '有内容' }), { speak: true, why: '有内容' })
  assert.deepEqual(parseReview({ speak: false, why: '像催他' }), { speak: false, why: '像催他' })
  // 认不出来 ⇒ false(不是"没意见 = 说")
  for (const bad of [null, undefined, 'yes', 1, [], {}, { speak: 'true' }, { speak: null }, { speak: 1 }]) {
    assert.equal(parseReview(bad).speak, false, '坏产出必须判"不说":' + JSON.stringify(bad))
  }
  assert.equal(parseReview({ speak: true }).why, '')
  assert.equal(parseReview({ speak: true, why: 'x'.repeat(500) }).why.length, 120, 'why 截断,不许塞长文进台账')
})

// ---- ② 输入纪律:不给全文 ----------------------------------------------------

test('reviewPrompt:候选只截 120 字、上下文最多 3 行,**不给全文**(省 token 也不泄隐私)', () => {
  const long = '这是一条很长很长的话题内容'.repeat(30)
  const prompt = reviewPrompt({
    candidate: { ...CAND, text: long },
    context: '第一行\n第二行\n第三行\n第四行\n第五行',
    threshold: 0.6, score: 0.62
  })
  assert.ok(!prompt.includes(long), '整段全文不许出现在 prompt 里')
  assert.ok(prompt.includes(long.slice(0, 120)), '候选话题截到 120 字要还在')
  assert.ok(prompt.includes('第一行') && prompt.includes('第三行'))
  assert.ok(!prompt.includes('第四行'), '上下文只给最近 3 行')
  assert.ok(prompt.includes('0.620') && prompt.includes('0.60'), '本地分/线要报给她看')
  assert.ok(prompt.includes('拿不准就判**不说**'), '偏保守的判据要写进 prompt')
  // 空输入也不崩
  assert.ok(reviewPrompt({}).includes('候选话题:'))
  assert.ok(reviewPrompt({ context: '   ' }).includes('(无)'))
})

test('REVIEW_SCHEMA:是对象根、只要求 speak(宿主 runStructured 契约)', () => {
  assert.equal(REVIEW_SCHEMA.type, 'object')
  assert.deepEqual(REVIEW_SCHEMA.required, ['speak'])
  assert.equal(REVIEW_SCHEMA.additionalProperties, false)
  assert.deepEqual(Object.keys(REVIEW_SCHEMA.properties).sort(), ['speak', 'why'])
})

// ---- ③ 赛跑:超时 / 失败 = 未过 ----------------------------------------------

test('reviewOnce:复核说"说" ⇒ ok:true + speak:true(带上 why 与耗时)', async () => {
  const r = await reviewOnce({
    run: async (prompt, schema) => {
      assert.ok(prompt.includes('thread:19') === false, 'prompt 只给正文,不给候选 id')
      assert.deepEqual(schema, REVIEW_SCHEMA)
      return { speak: true, why: '他真会想知道' }
    },
    candidate: CAND, threshold: 0.6, score: 0.62
  })
  assert.equal(r.ok, true)
  assert.equal(r.speak, true)
  assert.equal(r.why, '他真会想知道')
  assert.equal(r.timedOut, false)
  assert.ok(r.ms >= 0)
})

test('reviewOnce:**超时 = 未过**(不是"用本地分硬说")', async () => {
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({ speak: true }), 500))
  const r = await reviewOnce({ run: slow, candidate: CAND, timeoutMs: REVIEW_MIN_MS })
  assert.equal(r.ok, false)
  assert.equal(r.speak, false, '超时必须判"不说"')
  assert.equal(r.timedOut, true)
  assert.equal(r.why, 'timeout')
})

test('reviewOnce:模型抛错 = 未过,而且**不抛**(它挡在开口前,炸了会吞掉整拍)', async () => {
  const r = await reviewOnce({
    run: async () => { throw new Error('provider down') },
    candidate: CAND, timeoutMs: 1000
  })
  assert.equal(r.ok, false)
  assert.equal(r.speak, false)
  assert.equal(r.why, 'failed')
  assert.equal(r.timedOut, false)
})

test('reviewOnce:没注入 run / 认不出的产出 ⇒ 都判"不说"', async () => {
  const noRun = await reviewOnce({ run: null, candidate: CAND })
  assert.equal(noRun.ok, false)
  assert.equal(noRun.why, 'no-run')
  const junk = await reviewOnce({ run: async () => '不是 JSON', candidate: CAND, timeoutMs: 1000 })
  assert.equal(junk.ok, true, '跑完了就是 ok:true —— "说不说"看 speak')
  assert.equal(junk.speak, false, '认不出的产出 = 不说')
  const junk2 = await reviewOnce({ run: async () => ({ speak: 'yes' }), candidate: CAND, timeoutMs: 1000 })
  assert.equal(junk2.speak, false)
})

// ---- ④ 超时钳位 --------------------------------------------------------------

test('clampReviewTimeoutMs:坏值回默认,合理值钳在 0.5~15 秒', () => {
  assert.equal(clampReviewTimeoutMs(undefined), REVIEW_DEFAULT_TIMEOUT_MS)
  assert.equal(clampReviewTimeoutMs(0), REVIEW_DEFAULT_TIMEOUT_MS)
  assert.equal(clampReviewTimeoutMs(-5), REVIEW_DEFAULT_TIMEOUT_MS)
  assert.equal(clampReviewTimeoutMs('abc'), REVIEW_DEFAULT_TIMEOUT_MS)
  assert.equal(clampReviewTimeoutMs(1), REVIEW_MIN_MS)
  assert.equal(clampReviewTimeoutMs(999999), REVIEW_MAX_MS)
  assert.equal(clampReviewTimeoutMs(2500), 2500)
})
