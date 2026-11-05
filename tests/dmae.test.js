import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retrievability, initialHalfLife, reinforceHalfLife, deriveState, DMAE_DEFAULT } from '../lib/dmae.js'

test('R(Δt=H) = 0.5 —— 半衰期语义', () => {
  assert.equal(retrievability(24, 24), 0.5)
  assert.equal(retrievability(240, 240), 0.5)
})

test('R 长尾永不归零(幂律 vs 二次式的本质区别)', () => {
  assert.ok(retrievability(240, 24) > 0.09)   // 10H → ~0.091
  assert.ok(retrievability(2400, 24) > 0.009) // 100H → ~0.0099
  assert.ok(retrievability(1e9, 24) > 0)
})

test('R 单调递减,Δt=0 时为 1', () => {
  assert.equal(retrievability(0, 24), 1)
  const r1 = retrievability(10, 24)
  const r2 = retrievability(100, 24)
  assert.ok(r1 > r2)
})

test('非法半衰期返回 0(与 Python 版一致)', () => {
  assert.equal(retrievability(10, 0), 0)
  assert.equal(retrievability(10, null), 0)
  assert.equal(retrievability(10, undefined), 0)
  assert.equal(retrievability(-5, 24), 1) // 负 Δt 钳到 0
})

test('H0 = h_min·(I/i_ref)^γ,内在价值决定起手记忆时长', () => {
  // I=i_ref(10) → H0 = 24h
  assert.ok(Math.abs(initialHalfLife(10) - 24) < 1e-9)
  // I=100(满分重要) → 24·10^1.2 ≈ 380h ≈ 16 天
  assert.ok(initialHalfLife(100) > 24 * 10)
  // I=1(最低) → 24·(0.1)^1.2 ≈ 1.9h,灌水记忆当天就淡
  assert.ok(initialHalfLife(1) < 2)
})

test('间隔效应:快忘掉时才想起 → 增益大;刚想起过 → 增益小', () => {
  const h = 24
  const lowR = reinforceHalfLife(h, 0.05) // 快忘了才想起:大增益
  const highR = reinforceHalfLife(h, 0.95) // 刚想起过:小增益
  assert.ok(lowR > h * 2.5)
  assert.ok(highR < h * 1.15)
  assert.ok(lowR > highR)
})

test('强化永不缩短半衰期', () => {
  assert.ok(reinforceHalfLife(24, 1.0) >= 24)
  assert.ok(reinforceHalfLife(24, 0.0) > 24)
})

test('三态划分阈值', () => {
  assert.equal(deriveState(0.6), 'Active')
  assert.equal(deriveState(0.5), 'Active')
  assert.equal(deriveState(0.3), 'Dormant')
  assert.equal(deriveState(0.1), 'Dormant')
  assert.equal(deriveState(0.05), 'Archived')
  assert.equal(deriveState(0.0), 'Archived')
})

test('默认参数与 Python 版一致', () => {
  assert.equal(DMAE_DEFAULT.hMin, 24)
  assert.equal(DMAE_DEFAULT.iRef, 10)
  assert.equal(DMAE_DEFAULT.gamma, 1.2)
  assert.equal(DMAE_DEFAULT.kReinforce, 1.8)
})
