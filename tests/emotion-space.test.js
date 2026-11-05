/**
 * 联合空间声明层(`lib/emotion-space.js`)单测。
 *
 * 这个文件钉的是**声明本身**:三个子空间各算各的、每维都有归属、
 * 量纲换算可逆、"哪些是文献、哪些是工程假设"在运行时也看得见。
 * 不测动力学(那是 `lib/emotion.js` 的事),不碰库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SPACE_ID, BASIS, SUBSPACES, DIM_OWNERSHIP, NATIVE_RANGES,
  emptyUnion, clampAxis, nativeToUnit, unitToNative, unitToBipolar, bipolarToUnit,
  nativeToAxis, axisToNative, validateUnion, ownershipOf, dimsOfSubspace, describeSpace
} from '../lib/emotion-space.js'

test('基:{s,a,d} 三轴,全部双极 [-1,1],原点 0', () => {
  assert.deepEqual(Object.keys(BASIS), ['s', 'a', 'd'])
  for (const [key, axis] of Object.entries(BASIS)) {
    assert.equal(axis.axis, key)
    assert.deepEqual(axis.range, [-1, 1])
    assert.equal(axis.origin, 0)
    assert.ok(axis.label.length > 0)
  }
})

test('基的来源标注:s 是文献,a/d 是工程假设', () => {
  assert.equal(BASIS.s.provenance, 'literature')
  assert.match(BASIS.s.source, /Yik & Russell 2004/)
  assert.equal(BASIS.a.provenance, 'engineering')
  assert.equal(BASIS.d.provenance, 'engineering')
  assert.match(BASIS.a.source, /工程假设/)
  assert.match(BASIS.d.source, /工程假设/)
})

test('三个子空间都有身份、量程说明与"不参与换算"的边界说明', () => {
  assert.deepEqual(Object.keys(SUBSPACES), ['SP_PAD', 'SP_IPC', 'SP_IND'])
  for (const sp of Object.values(SUBSPACES)) {
    assert.ok(sp.label.length > 0)
    assert.ok(sp.native.length > 0)
    assert.ok(sp.origin.length > 0)
  }
  assert.match(SUBSPACES.SP_IND.unit, /不参与/)
})

test('归属表:每个条目都指向已声明的子空间', () => {
  const ids = new Set(Object.keys(SUBSPACES))
  for (const [dim, entry] of Object.entries(DIM_OWNERSHIP)) {
    assert.ok(ids.has(entry.subspace), `${dim} 指向未知子空间 ${entry.subspace}`)
    assert.ok(entry.label.length > 0, `${dim} 缺中文标签`)
  }
})

test('归属表的硬约定:dominance 登记不渲染、playfulness/sadness 是扩展维', () => {
  assert.equal(DIM_OWNERSHIP['global.dominance'].kind, 'registered-only')
  assert.match(DIM_OWNERSHIP['global.dominance'].note, /登记、先不渲染/)
  assert.equal(DIM_OWNERSHIP['target_master.playfulness'].kind, 'extended')
  assert.equal(DIM_OWNERSHIP['target_master.sadness'].kind, 'extended')
  assert.equal(DIM_OWNERSHIP['target_master.affection'].axis, 'c')
  assert.equal(DIM_OWNERSHIP['target_master.dependency'].axis, 'agency')
})

test('原生量程:八维齐全且 lo < hi', () => {
  const dims = Object.keys(NATIVE_RANGES)
  assert.equal(dims.length, 8)
  assert.ok(dims.includes('global.dominance'))
  for (const [dim, range] of Object.entries(NATIVE_RANGES)) {
    assert.ok(range[0] < range[1], `${dim} 量程反了`)
    assert.equal(dimsOfSubspace(ownershipOf(dim).subspace).includes(dim), true)
  }
})

test('子空间维度计数:SP_PAD 3(含登记未渲染的 dominance)、SP_IPC 4、SP_IND 3', () => {
  assert.equal(dimsOfSubspace('SP_PAD').length, 3)
  assert.ok(dimsOfSubspace('SP_PAD').includes('global.dominance'), 'dominance 必须登记在 SP_PAD(拍板 ①)')
  assert.equal(dimsOfSubspace('SP_IPC').length, 4)
  assert.deepEqual(dimsOfSubspace('SP_IND').sort(), ['global.fatigue', 'longing.value', 'user_profile.affinity'])
})

test('单极/双极互换可逆:0→−1、0.5→0、1→+1', () => {
  assert.equal(unitToBipolar(0), -1)
  assert.equal(unitToBipolar(0.5), 0)
  assert.equal(unitToBipolar(1), 1)
  assert.equal(bipolarToUnit(-1), 0)
  assert.equal(bipolarToUnit(0), 0.5)
  assert.equal(bipolarToUnit(1), 1)
  assert.ok(Math.abs(bipolarToUnit(unitToBipolar(0.37)) - 0.37) < 1e-12)
})

test('原生↔基坐标往返(≤0.1:回程按 0.1 取整)', () => {
  const cases = [
    ['global.valence', 2], ['global.valence', -4.5], ['global.arousal', 3],
    ['global.dominance', 5], ['target_master.affection', 8], ['target_master.dependency', 6]
  ]
  for (const [dim, value] of cases) {
    const axis = nativeToAxis(value, NATIVE_RANGES[dim])
    assert.ok(Math.abs(axis) <= 1.0000001, `${dim}=${value} 出界`)
    const back = axisToNative(axis, NATIVE_RANGES[dim])
    assert.ok(Math.abs(back - value) <= 0.1, `${dim}=${value} 往返成了 ${back}`)
  }
})

test('原生量程映射:valence 0 ⇒ 单极 0.5;arousal 下界 ⇒ 0', () => {
  assert.equal(nativeToUnit(0, NATIVE_RANGES['global.valence']), 0.5)
  assert.equal(nativeToUnit(1, NATIVE_RANGES['global.arousal']), 0)
  assert.equal(unitToNative(1, NATIVE_RANGES['global.arousal']), 10)
})

test('validateUnion:越界夹取 + 记账,未知轴丢弃', () => {
  const r1 = validateUnion({ s: 2, a: 0, d: 0 })
  assert.equal(r1.ok, false)
  assert.equal(r1.union.s, 1)
  assert.ok(r1.issues.includes('clamped:s'))
  const r2 = validateUnion({ s: 0.5, a: 0, d: 0, zzz: 1 })
  assert.ok(r2.issues.includes('unknown-axis:zzz'))
  assert.ok(!Object.hasOwn(r2.union, 'zzz'))
  const r3 = validateUnion({ s: 0.5, a: 0, d: 0 })
  assert.equal(r3.ok, true)
  assert.deepEqual(r3.union, { s: 0.5, a: 0, d: 0 })
})

test('validateUnion:脏输入一律不抛', () => {
  assert.equal(validateUnion(null).ok, false)
  assert.equal(validateUnion([1, 2, 3]).ok, false)
  assert.equal(validateUnion(42).ok, false)
  const r = validateUnion({ s: Number.NaN, a: 0, d: 0 })
  assert.ok(r.issues.includes('not-finite:s'))
  assert.equal(r.union.s, 0)
  const miss = validateUnion({ s: 0.1 })
  assert.ok(miss.issues.includes('missing-axis:a'))
})

test('clampAxis 与 emptyUnion 的边界行为', () => {
  assert.equal(clampAxis(9), 1)
  assert.equal(clampAxis(-9), -1)
  assert.equal(clampAxis('x'), 0)
  assert.deepEqual(emptyUnion(), { s: 0, a: 0, d: 0 })
})

test('ownershipOf:未知维度 ⇒ null', () => {
  assert.equal(ownershipOf('global.dominance').subspace, 'SP_PAD')
  assert.equal(ownershipOf('target_group.anger'), null)
})

test('describeSpace 把"不等价"写进运行时摘要', () => {
  const line = describeSpace()
  assert.match(line, /echo\.emotion\.union\.v1|echo.emotion.union.v1/)
  assert.match(line, /不等价/)
  assert.match(line, /1 文献 \/ 2 工程假设/)
  assert.ok(line.includes(SPACE_ID))
})
