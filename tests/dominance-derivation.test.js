/**
 * ① dominance 推导(用户拍板 D1/D2/D3,2026-10-05)的**离线断言**。
 *
 * 背景:PAD 立方体要三轴,而 `global.dominance` 是"登记未渲染"(拍板 ①)——
 * 活库里它永远是出厂中性值,立方体的 D 轴会是死的。用户拍板走**方案 A**:
 * 从 `target_master.dependency` 反推(依赖 ↑ ⇒ 支配 ↓),并**只作显示**。
 *
 * 本测试钉四件事:
 *   1. 反推公式与端点(量程反射:`native = hi + lo − dependency`);
 *   2. 缺维 / 脏值 ⇒ `null`,**不猜 0**;
 *   3. 显示口径的优先级(DOMINANCE_PREFER_MEASURED=false ⇒ 推导优先)与 `dSource` 标注;
 *   4. **与 IPC 字典同源**:`d` 必须等于 `2·agency − 1`(证明 A 与 B 代数等价,
 *      B 只是把同一条假设绕 IPC 走一圈 —— 所以选 A 不选 B 没有信息损失)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dominanceFromDependency,
  padBipolarFromVector,
  DOMINANCE_PREFER_MEASURED,
  DOMINANCE_DERIVATION_NOTE
} from '../lib/emotion-space.js'
import { echoToIpc } from '../lib/emotion-ipc-bridge.js'

test('dominance 推导:量程反射 10 − dependency(端点 / 中点)', () => {
  assert.equal(dominanceFromDependency(0).native, 10)
  assert.equal(dominanceFromDependency(0).bipolar, 1)
  assert.equal(dominanceFromDependency(10).native, 0)
  assert.equal(dominanceFromDependency(10).bipolar, -1)
  assert.equal(dominanceFromDependency(5).native, 5)
  assert.equal(dominanceFromDependency(5).bipolar, 0)
  assert.equal(dominanceFromDependency(2.5).native, 7.5)
  assert.equal(dominanceFromDependency(2.5).bipolar, 0.5)
})

test('dominance 推导:缺维 / 脏值 ⇒ null(绝不猜 0)', () => {
  for (const bad of [null, undefined, '', NaN, 'x', {}, Infinity, -Infinity]) {
    assert.equal(dominanceFromDependency(bad), null, '这个输入必须回 null:' + String(bad))
  }
})

test('dominance 推导:越界夹到 [0,10](不抛)', () => {
  assert.equal(dominanceFromDependency(-3).native, 10)
  assert.equal(dominanceFromDependency(-3).bipolar, 1)
  assert.equal(dominanceFromDependency(99).native, 0)
  assert.equal(dominanceFromDependency(99).bipolar, -1)
})

test('dominance 推导:来源与 [工程假设] 标注齐全(拍板 D2)', () => {
  const out = dominanceFromDependency(8)
  assert.equal(out.source, 'derived')
  assert.equal(out.from, 'target_master.dependency')
  assert.equal(out.assumption, DOMINANCE_DERIVATION_NOTE)
  assert.match(out.assumption, /\[工程假设\]/)
})

test('显示口径:推导优先,且 missing 不再含 dominance', () => {
  const pad = padBipolarFromVector({
    global: { valence: 4, arousal: 6 },
    target_master: { dependency: 8 }
  })
  assert.equal(pad.dSource, 'derived')
  assert.ok(Math.abs(pad.d - (-0.6)) < 1e-9, 'dependency 8 ⇒ d = 1 − 8/5 = −0.6')
  assert.deepEqual(pad.missing, [], '三轴都有来源 ⇒ 不该记缺维')
  assert.equal(pad.p, 0.4)
})

test('显示口径:两路都缺 ⇒ dSource=null、missing 含 dominance、d=0(不猜)', () => {
  const pad = padBipolarFromVector({ global: { valence: 4 } })
  assert.equal(pad.dSource, null)
  assert.equal(pad.d, 0)
  assert.ok(pad.missing.includes('dominance'))
  assert.ok(pad.missing.includes('arousal'))
})

test('与 IPC 字典同源:A ≡ B(2·agency − 1,误差 < 1e-3)', () => {
  for (const dep of [0, 2.5, 5, 8, 10]) {
    const derived = dominanceFromDependency(dep).bipolar
    const viaIpc = 2 * echoToIpc({ target_master: { dependency: dep, affection: 5 } }).point.a - 1
    assert.ok(Math.abs(derived - viaIpc) < 1e-3,
      'dep=' + dep + ' ⇒ 推导 ' + derived + ' vs 走 IPC ' + viaIpc)
  }
})

test('只显示不回写:传入的向量在调用后一字未改(拍板 D3)', () => {
  const vec = {
    global: { fatigue: 3, valence: 4, arousal: 6, dominance: 5 },
    target_master: { affection: 7, playfulness: 5, sadness: 2, dependency: 8 }
  }
  const before = JSON.parse(JSON.stringify(vec))
  const pad = padBipolarFromVector(vec)
  assert.deepEqual(vec, before, '向量被改了 ⇒ 违反"只显示"')
  assert.equal(pad.dSource, 'derived', 'domonance 有值但仍是出厂中性 ⇒ 今天仍走推导')
})

test('开关常量:今天必须是 false(方案 C 未上线);翻转只动一处', () => {
  assert.equal(DOMINANCE_PREFER_MEASURED, false)
})
