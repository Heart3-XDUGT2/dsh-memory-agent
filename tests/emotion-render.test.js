/**
 * 联合空间渲染(B5 定稿)单测 —— 钉三件事:
 *   ① **门禁**:绿给块 / 黄只给方向 / 红与未知不给块(且判定是只读的);
 *   ② **不歧义**:`bridge_err` 不进 prompt;缺的字段不出现(不写 0.00);支配标(未启用);
 *      IPC 段带"不与上段比较"限定;联合行只留共享轴 s(a/d 归各自段);
 *   ③ **尺寸**:绿块 2 行(降级 3 行),能被"压到 2~3 行以内"这条验收线量出来。
 * 另外保留 F/V/A → PAD 取法(`echoVectorToBipolar`)的既有断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderUnionBlock, describeMood } from '../lib/context.js'
import { echoVectorToBipolar, EQUIVALENCE_NOTE } from '../lib/emotion-space.js'

const FULL = {
  gate: 'green',
  union: { s: 0.42, a: -0.18, d: 0.3 },
  pad: { valence: 0.22, arousal: -0.56, dominance: 0 },
  ipc: { agency: 0.2, communion: 0.98, ext: { playfulness: 0.67, sadness: 0 }, anchor: { id: 'unassuming', zh: '不夸大', octant: 'BC' }, complementarity: 0.62 },
  independent: { fatigue: 0, longing: null, affinity: null },
  degraded: false,
  note: EQUIVALENCE_NOTE
}

test('绿:正常给块,恰好 2 行、每行以句号收尾、尺寸可控(≤300 字)', () => {
  const block = renderUnionBlock(FULL)
  const lines = block.split('\n')
  assert.equal(lines.length, 2, '绿块应压到 2 行,实得:\n' + block)
  assert.ok(block.length <= 300, '绿块应 ≤300 字,实得 ' + block.length)
  for (const line of lines) assert.ok(line.endsWith('。') || line.endsWith('。'), '每行都要收句号:' + line)
  assert.ok(lines[1].endsWith('。') || lines[1].includes('。'), '尾句必须补句号')
})

test('bridge_err 不进 prompt(数字只留审计)', () => {
  const block = renderUnionBlock({ ...FULL, bridgeErr: 0.451, resid: 0.451, exposeErr: true })
  assert.ok(!block.includes('bridge_err'), '注入块里不许出现 bridge_err')
  assert.ok(!block.includes('0.45'), '误差数值也不许顺带出现')
  assert.ok(!/resid|残差/.test(block), '残差字样同样不进 prompt')
})

test('共用行只留共享轴 s:a/d 不再重复出现', () => {
  const block = renderUnionBlock(FULL)
  assert.match(block, /共享轴 s=0\.42/)
  assert.ok(!block.includes('激活轴'), '联合行不该再列激活轴(PAD 段已有"激活")')
  assert.ok(!block.includes('支配轴'), '联合行不该再列支配轴(PAD 段已有"支配")')
  assert.match(block, /\[PAD\] 愉快 0\.22、激活 -0\.56、支配\(未启用\)/)
})

test('IPC 段有"不与上段比较"限定,且姿态带分仪名', () => {
  const block = renderUnionBlock(FULL)
  assert.match(block, /\[IPC\] /)
  assert.match(block, /不与上段比较/)
  assert.match(block, /最近姿态「不夸大\(BC 一带\)」/)
  assert.match(block, /互补性 0\.62/)
})

test('缺维不出现:拿不到的字段一个字都不写(照 dimLine 纪律)', () => {
  const block = renderUnionBlock(FULL)
  assert.ok(!block.includes('想念'), '想念没接线 ⇒ 不该出现')
  assert.ok(!block.includes('亲密度'), '亲密度没接线 ⇒ 不该出现')
  assert.match(block, /疲惫 0\.00\(无 PAD 对应维\)/, '疲惫是真读数(0 也写)')
  const noComp = renderUnionBlock({ ...FULL, ipc: { ...FULL.ipc, complementarity: null } })
  assert.ok(!noComp.includes('互补性'), '互补性拿不到 ⇒ 不该出现')
  const noExt = renderUnionBlock({ ...FULL, ipc: { ...FULL.ipc, ext: {} } })
  assert.ok(!noExt.includes('调皮'))
  const onlyS = renderUnionBlock({ gate: 'green', union: { s: 0.1 } })
  assert.match(onlyS, /共享轴 s=0\.10/)
  assert.equal(onlyS.split('\n').length, 1, '只有共享轴时就是 1 行')
})

test('门禁黄:只给方向,一个绝对读数都不给', () => {
  const block = renderUnionBlock({ ...FULL, gate: 'yellow', direction: 'positive' })
  assert.match(block, /偏正向/)
  assert.match(block, /只给方向、不给数值/)
  assert.ok(!/\d\.\d\d/.test(block), '黄带不许出现任何小数读数:' + block)
  assert.ok(!block.includes('[IPC]'))
  for (const [dir, zh] of [['negative', '偏负向'], ['flat', '基本持平'], [null, '方向未知']]) {
    assert.match(renderUnionBlock({ ...FULL, gate: 'yellow', direction: dir }), new RegExp(zh))
  }
})

test('门禁红 / 未知:不给块(空串),等于不注入', () => {
  assert.equal(renderUnionBlock({ ...FULL, gate: 'red' }), '')
  assert.equal(renderUnionBlock({ ...FULL, gate: 'unknown' }), '')
  assert.equal(renderUnionBlock({}), '')
  assert.equal(renderUnionBlock(), '')
  assert.equal(renderUnionBlock({ gate: 'green' }), '')
})

test('降级态:如实体现在块里(第 3 行)', () => {
  const block = renderUnionBlock({ ...FULL, degraded: true })
  assert.equal(block.split('\n').length, 3)
  assert.match(block, /降级态/)
})

test('describeMood 挂钩:块夹在「剧本」与「行为要求」之间;没块就一个字不多', () => {
  const state = {
    moodIntensity: 6,
    prevMoodIntensity: 5,
    moodReason: '测试',
    emotionVector: {
      global: { fatigue: 2, valence: 2, arousal: 3 },
      target_master: { affection: 8, playfulness: 7, sadness: 0, dependency: 6 }
    }
  }
  const plain = describeMood(state)
  assert.ok(!plain.includes('情绪空间:共享轴'))
  const withBlock = describeMood(state, { unionBlock: renderUnionBlock(FULL) })
  const iScript = withBlock.indexOf('- 剧本:')
  const iUnion = withBlock.indexOf('- 情绪空间:共享轴')
  const iBehavior = withBlock.indexOf('行为要求:')
  assert.ok(iScript >= 0 && iUnion > iScript && iBehavior > iUnion, '块必须夹在剧本与行为要求之间')
})

test('echoVectorToBipolar:三轴取值 + 缺维记账(不猜)', () => {
  const full = echoVectorToBipolar({ global: { valence: 5, arousal: 3, dominance: 7, fatigue: 9 } })
  assert.ok(Math.abs(full.p - 0.5) < 1e-9)
  assert.ok(Math.abs(full.a - (-0.5555555555555556)) < 1e-6, `arousal 3 应≈−0.556,实得 ${full.a}`)
  assert.ok(Math.abs(full.d - 0.4) < 1e-9)
  assert.deepEqual(full.missing, [])
  assert.match(full.note, /工程假设/)
  const partial = echoVectorToBipolar({ global: { valence: -10 } })
  assert.equal(partial.p, -1)
  assert.equal(partial.a, 0)
  assert.deepEqual(partial.missing, ['arousal', 'dominance'])
  const dirty = echoVectorToBipolar({ global: { valence: 'x', arousal: null, dominance: NaN } })
  assert.deepEqual(dirty.missing, ['valence', 'arousal', 'dominance'])
  assert.deepEqual(echoVectorToBipolar(null).missing, ['valence', 'arousal', 'dominance'])
  assert.equal(echoVectorToBipolar({ global: { fatigue: 10 } }).p, 0)
})
