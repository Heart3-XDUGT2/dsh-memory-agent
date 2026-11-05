/**
 * 门禁分带(`lib/space-bridge.js` 的 `gateOf` / `directionOf` / `GATE_BANDS`)单测。
 *
 * 门禁是"联合空间块能不能进 prompt"的唯一闸:
 *   绿 <0.15 给块 · 黄 ≤0.30 只给方向 · 红 >0.30 不给块 · 非数 = unknown(一样不给块)。
 * 依据是 7 轮真实数据(见 `docs/EMOTION_SPACE.md` 标定记录):标定后残差标准差仅 0.026,
 * 所以绿线收到 0.15;**判定只读,绝不回写任何读数**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gateOf, directionOf, GATE_BANDS } from '../lib/space-bridge.js'

test('分带边界:0.15 / 0.30 是开闭区间的分界', () => {
  assert.equal(GATE_BANDS.green, 0.15)
  assert.equal(GATE_BANDS.yellow, 0.3)
  assert.equal(gateOf(0), 'green')
  assert.equal(gateOf(0.1499), 'green')
  assert.equal(gateOf(0.15), 'yellow') // 左闭:到 0.15 就算黄
  assert.equal(gateOf(0.3), 'yellow')
  assert.equal(gateOf(0.3001), 'red')
  assert.equal(gateOf(1), 'red')
})

test('负残差按绝对值分带(误差方向不影响判决)', () => {
  assert.equal(gateOf(-0.1), 'green')
  assert.equal(gateOf(-0.2), 'yellow')
  assert.equal(gateOf(-0.9), 'red')
})

test('脏输入一律 unknown(调用方按"不给块"处理,不猜)', () => {
  assert.equal(gateOf(null), 'unknown')
  assert.equal(gateOf(undefined), 'unknown')
  assert.equal(gateOf(NaN), 'unknown')
  assert.equal(gateOf('x'), 'unknown')
  assert.equal(gateOf(Infinity), 'unknown')
})

test('真实数据回放:标定前全红黄、标定后全绿', () => {
  // 7 轮真实读数(见审阅报告):s_pad 序列与 s_ipc 序列
  const sPad = [-0.138, -0.138, -0.114, -0.114, 0.053, 0.116, -0.073]
  const sIpc = [0.313, 0.313, 0.313, 0.300, 0.300, 0.300, 0.300]
  const gateWith = (lambdaS, biasS) => sPad.map((v, i) => gateOf(Math.abs(sIpc[i] - (lambdaS * v + biasS))))
  const before = gateWith(1, 0) // 现状:λs=1 / biasS=0
  assert.ok(before.every((g) => g === 'yellow' || g === 'red'), '标定前不应有绿:' + before.join(','))
  assert.ok(before.includes('red'), '标定前应出现红')
  const after = gateWith(0.7, 0.3) // B5 标定:λs=0.7 / biasS=0.30
  assert.ok(after.every((g) => g === 'green'), '标定后应全部落绿:' + after.join(','))
})

test('directionOf:偏正 / 偏负 / 持平 / 未知', () => {
  assert.equal(directionOf(0.5, 0.1), 'positive')
  assert.equal(directionOf(-0.4, 0.2), 'negative')
  assert.equal(directionOf(0.2, 0.2), 'flat')
  assert.equal(directionOf(0.21, 0.2), 'flat') // 2e-2 以内算持平
  assert.equal(directionOf(0.23, 0.2), 'positive')
  assert.equal(directionOf(null, 0.2), null)
  assert.equal(directionOf(0.2, 'x'), null)
  assert.equal(directionOf(NaN, NaN), null)
})
