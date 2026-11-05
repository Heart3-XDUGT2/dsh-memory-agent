import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  topicRepeatPenalty, TOPIC_REPEAT_PENALTY, TOPIC_REPEAT_SIMILARITY,
  matchOpenThread, normThreadContent
} from '../lib/thread-dedupe.js'

test('C4:连说两拍 ⇒ 第二拍降分(验收条款原话)', () => {
  const prevTopics = ['这周末要不要去把校园跑补上,还差三次']
  const second = topicRepeatPenalty({ prevTopics, topic: '这周末要不要去把校园跑补上,还差三次' })
  assert.equal(second.hit, true)
  assert.equal(second.score, TOPIC_REPEAT_PENALTY)
  assert.ok(second.score < 1, '第二拍必须比第一拍低')
  // 第一拍没有"上一拍"可比 ⇒ 满分
  assert.equal(topicRepeatPenalty({ prevTopics: [], topic: '这周末要不要去把校园跑补上' }).score, 1)
})

test('C4:换话题不降分(惩罚只针对"刚说过的那个")', () => {
  const r = topicRepeatPenalty({ prevTopics: ['校园跑还差三次'], topic: '你面试那家店后来给你回复了吗' })
  assert.equal(r.hit, false)
  assert.equal(r.score, 1)
})

test('C4:阈值是 0.6 的相似度,不是"沾一点边就罚"', () => {
  assert.equal(TOPIC_REPEAT_SIMILARITY, 0.6)
  // 同一个话题的两种说法(改了几个字)⇒ 仍算复读
  const near = topicRepeatPenalty({
    prevTopics: ['我明天想早点睡,别熬到两点'],
    topic: '我明天想早点睡,别熬到两点啊'
  })
  assert.equal(near.hit, true)
  // 只是共享"我/明天"这种高频残片 ⇒ 不许罚
  const far = topicRepeatPenalty({
    prevTopics: ['我明天想去图书馆待一下午'],
    topic: '你今天在图书馆看见谁了'
  })
  assert.equal(far.hit, false, '沾边就罚会把她该说的话也罚掉')
})

test('C4:惩罚器与"话题合并"是两件事(合并管"是不是新话题",惩罚管"该不该再提")', () => {
  const same = '这周末要不要去把校园跑补上'
  assert.ok(matchOpenThread([{ threadId: 7, content: same }], same) === 7, '合并:认得出是老话题')
  assert.ok(topicRepeatPenalty({ prevTopics: [same], topic: same }).hit, '惩罚:认得出刚提过')
  // 但两者结论可以不同:一个**全新的**话题照样可能命中"上一拍提过"(她换个说法再提)
  const rephrase = topicRepeatPenalty({ prevTopics: [same], topic: same + '?' })
  assert.equal(rephrase.hit, true, '换个说法再提 = 复读,不是新话题')
  assert.equal(matchOpenThread([{ threadId: 7, content: same }], same + '?'), 7)
})

test('C4:坏输入不崩,且不许把"没上一拍"当成"罚"(宁可满分)', () => {
  assert.deepEqual(topicRepeatPenalty({}).score, 1)
  assert.deepEqual(topicRepeatPenalty({ prevTopics: null, topic: '  ' }).score, 1)
  assert.equal(topicRepeatPenalty({ prevTopics: ['x'], topic: 'x', penalty: 0 }).penalty, TOPIC_REPEAT_PENALTY, '坏惩罚值回落默认')
  assert.equal(topicRepeatPenalty({ prevTopics: ['x'], topic: 'x', penalty: 5 }).penalty, 1, '上限 1(不许把分数拉成负数)')
  assert.equal(normThreadContent('  a\n b  '), 'a b')
})
