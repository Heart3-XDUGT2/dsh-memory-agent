// 气泡分条 + 泡间节奏的电池。
//
// 靶子是 A 侧 `core/echo_utils.py:82 split_bubbles` 与 `main.py:1384 _bubble_delay`
// 的行为。**每一条都对应 A 侧的一条规则** —— 改坏了必须有人红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitBubbles, splitLongSentence, bubbleDelaySec, planBubbles, charLen, BUBBLE_MAX_BUBBLES } from '../lib/bubble.js'

test('气泡:短回复直通(≤max_chars 且无换行 → 一泡)', () => {
  assert.deepEqual(splitBubbles('在的', { maxChars: 30 }), ['在的'])
  assert.deepEqual(splitBubbles('  ', { maxChars: 30 }), [], '空输入返回空数组(A 侧同)')
  assert.deepEqual(splitBubbles('', { maxChars: 30 }), [])
})

test('气泡:模型自己写的换行是天然气泡界(哪怕整段很短)', () => {
  assert.deepEqual(splitBubbles('好。\n\n嗯,我在。', { maxChars: 30 }), ['好。', '嗯,我在。'])
  assert.deepEqual(splitBubbles('第一句\n第二句\n\n第三句', { maxChars: 30 }), ['第一句', '第二句', '第三句'])
})

test('气泡:段内按句末切句并装箱,不一句一泡(防碎片化)', () => {
  // 三句共 15 字,应装成一泡而不是三泡
  const out = splitBubbles('好。我知道了。你别催。', { maxChars: 30 })
  assert.deepEqual(out, ['好。我知道了。你别催。'])
  // 句末标点全集都要被当界:A 侧正则 (?<=[。？！…!?~])
  for (const mark of ['。', '？', '！', '…', '!', '?', '~']) {
    const s = '甲' .repeat(20) + mark + '乙'.repeat(20)
    const b = splitBubbles(s, { maxChars: 30 })
    assert.equal(b.length, 2, mark + ' 没被当句末界:' + JSON.stringify(b))
  }
})

test('气泡:单句超长退逗号切(逗号仍救不了就整句留着 —— 绝不切词中)', () => {
  const withCommas = '这是第一小段，这是第二小段，这是第三小段，这是第四小段，这是第五小段'
  const out = splitLongSentence(withCommas, 12)
  assert.ok(out.length > 1, '逗号处应该能切开')
  for (const p of out) assert.ok(charLen(p) <= 12 || !p.includes('，'), '除了救不了的整段,每段都要 ≤12:' + charLen(p))
  // 没有逗号的长句:A 侧铁律是整句保留(宁可留一泡长的,也不切词中)
  const noBreak = '甲'.repeat(40)
  assert.deepEqual(splitLongSentence(noBreak, 12), [noBreak])
})

test('气泡:泡数封顶 5,尾巴合并进最后一泡(一个字都不丢)', () => {
  const text = Array.from({ length: 9 }, (_, i) => '第' + (i + 1) + '句话在这里。').join('')
  const out = splitBubbles(text, { maxChars: 8 })
  assert.equal(out.length, BUBBLE_MAX_BUBBLES, '封顶硬编码 5 泡(A 侧同)')
  assert.equal(charLen(out.join('')), charLen(text.replace(/\s/g, '')), '合并不许丢字')
  const out3 = splitBubbles(text, { maxChars: 8, maxBubbles: 3 })
  assert.equal(out3.length, 3)
})

test('气泡:只改包装,不增字不减字', () => {
  const cases = [
    '在的。',
    '嗯,我在。刚在看代码——你那行 if 写错了。',
    '好。\n\n知道了。我记下了,不会忘。',
    '第一句很长很长很长很长很长很长很长,第二句也不短,第三句收尾。'
  ]
  for (const c of cases) {
    const flat = splitBubbles(c, { maxChars: 30 }).join('')
    assert.equal(flat.replace(/\s/g, ''), c.replace(/\s/g, ''), '丢字或加字了:' + c)
  }
})

test('气泡:emoji 按码点算字数(与 Python len 对齐)', () => {
  assert.equal(charLen('🌙'), 1, 'JS 的 .length 会算成 2,必须用码点')
  assert.equal('🌙'.length, 2, '前提:JS 原生长度确实是 2')
  // 26 个码点(52 个 UTF-16 单元)≤ 26 ⇒ 直通一泡。若按 .length 算会走慢路径并被切成两泡。
  assert.equal(splitBubbles('🌙'.repeat(20) + '，' + '🌙'.repeat(5), { maxChars: 26 }).length, 1)
  // 反例:无标点的超长句**不许**被切开 —— 宁可留一泡长的(A 侧「绝不切词中」铁律)
  assert.equal(splitBubbles('🌙'.repeat(31), { maxChars: 30 }).length, 1)
  assert.equal(splitBubbles('甲'.repeat(31), { maxChars: 30 }).length, 1)
})

test('节奏:延迟 ∝ 字数、乘 scale、带抖动、单泡封顶 2s(A 侧公式)', () => {
  const mid = () => 0.5 // uniform(0.7,1.3) 在中点恰好 = 1.0
  // 30 字:base = min(2.0, 0.4 + 30*0.045) = 1.75
  assert.equal(bubbleDelaySec('甲'.repeat(30), 1, mid).toFixed(4), '1.7500')
  // 短泡:0.4 + 4*0.045 = 0.58
  assert.equal(bubbleDelaySec('甲乙丙丁', 1, mid).toFixed(4), '0.5800')
  // 超长泡封顶 2.0
  assert.equal(bubbleDelaySec('甲'.repeat(100), 1, mid), 2.0)
  // scale 生效;0 = 连发
  assert.equal(bubbleDelaySec('甲'.repeat(30), 2, mid).toFixed(4), '3.5000')
  assert.equal(bubbleDelaySec('甲'.repeat(30), 0, mid), 0)
  // 抖动区间 [0.7, 1.3]
  assert.equal(bubbleDelaySec('甲'.repeat(30), 1, () => 0).toFixed(4), (1.75 * 0.7).toFixed(4))
  assert.equal(bubbleDelaySec('甲'.repeat(30), 1, () => 1).toFixed(4), (1.75 * 1.3).toFixed(4))
})

test('节奏:发送计划 —— 第一泡立刻,后面各泡等上一泡的延迟(A 侧 yield→sleep 语义)', () => {
  const plan = planBubbles('好。\n\n我知道了。\n\n你别催我。', { maxChars: 30, scale: 1, now: 1000, rand: () => 0.5 })
  assert.equal(plan.length, 3)
  assert.equal(plan[0].notBefore, 1000, '第一泡立刻发')
  assert.equal(plan[1].notBefore, 1000 + Math.min(2, 0.4 + charLen(plan[0].text) * 0.045), '第二泡 = 第一泡到期 + 第一泡的延迟')
  assert.equal(plan[2].notBefore, plan[1].notBefore + Math.min(2, 0.4 + charLen(plan[1].text) * 0.045))
  for (const p of plan) assert.ok(p.notBefore >= 1000 && p.seq >= 0)
  // 单调不减
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i].notBefore >= plan[i - 1].notBefore)
})

test('节奏:泡数封顶 ⇒ 总时长天然兜在 ~8s 内(A 侧原注)', () => {
  const text = Array.from({ length: 20 }, () => '这一句刚好十五个字左右吧。').join('')
  const plan = planBubbles(text, { maxChars: 30, scale: 1, now: 0, rand: () => 1 })
  const total = plan[plan.length - 1].notBefore
  assert.ok(plan.length <= BUBBLE_MAX_BUBBLES)
  assert.ok(total <= 5 * 2.0, '总时长不该超过泡数上限 × 单泡封顶,实际 ' + total)
})
