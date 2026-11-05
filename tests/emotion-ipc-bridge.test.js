/**
 * Echo ↔ IPC 映射(`lib/emotion-ipc-bridge.js`)单测。
 *
 * 钉三件事:①映射方向(爱意→c、依赖→(1−a)、两个扩展维只透传);
 * ②**只读**(不改正则里的入参对象、不给库写任何东西);
 * ③"主人一侧没有坐标"时如实标 `otherMissing`,不猜。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { echoToIpc, ipcToEcho, dyad, NEUTRAL_IPC, IPC_MAP } from '../lib/emotion-ipc-bridge.js'

const VEC = { target_master: { affection: 8, dependency: 6, playfulness: 7, sadness: 0 } }

test('映射表声明:四个维都有方向与说明,且标注 [工程假设]', () => {
  assert.equal(IPC_MAP.affection.axis, 'c')
  assert.equal(IPC_MAP.dependency.axis, 'a')
  assert.equal(IPC_MAP.dependency.invert, true)
  assert.equal(IPC_MAP.playfulness.ext, true)
  assert.equal(IPC_MAP.sadness.ext, true)
  for (const entry of Object.values(IPC_MAP)) assert.match(entry.note, /工程假设/)
})

test('echoToIpc:爱意→c、依赖→(1−a)、扩展维透传、无缺失', () => {
  const r = echoToIpc(VEC)
  assert.equal(r.point.c, 0.8)
  assert.equal(r.point.a, 0.4) // 1 − 0.6
  assert.equal(r.ext.playfulness, 0.7)
  assert.equal(r.ext.sadness, 0)
  assert.deepEqual(r.missing, [])
  assert.equal(r.assumed, true)
})

test('echoToIpc 只读:入参对象一个字节都不改', () => {
  const snapshot = JSON.stringify(VEC)
  echoToIpc(VEC)
  assert.equal(JSON.stringify(VEC), snapshot)
})

test('echoToIpc:缺维 / 脏值 ⇒ 走中性并在 missing 里记账', () => {
  const r = echoToIpc({ target_master: { affection: 5 } })
  assert.equal(r.point.a, NEUTRAL_IPC.a) // dependency 缺 ⇒ 中性
  assert.equal(r.point.c, 0.5)
  assert.ok(r.missing.includes('dependency') && r.missing.includes('playfulness'))
  const r2 = echoToIpc({ target_master: { affection: NaN, dependency: 'x' } })
  assert.equal(r2.point.c, 0.5)
  assert.equal(r2.point.a, 0.5)
  const r3 = echoToIpc(null)
  assert.deepEqual(r3.missing, ['affection', 'dependency', 'playfulness', 'sadness'])
})

test('ipcToEcho:给出建议值,并明说"不是文献换算"', () => {
  const r = ipcToEcho({ a: 0.4, c: 0.8, ext: { playfulness: 0.7 } })
  assert.equal(r.target_master.affection, 8)
  assert.equal(r.target_master.dependency, 6)
  assert.equal(r.target_master.playfulness, 7)
  assert.equal(r.target_master.sadness, undefined)
  assert.equal(r.assumed, true)
  assert.match(r.note, /工程假设/)
})

test('往返一致:Echo→IPC→Echo 在两个轴上都回到原值(0.1 精度内)', () => {
  const fwd = echoToIpc(VEC)
  const back = ipcToEcho({ ...fwd.point, ext: fwd.ext })
  assert.ok(Math.abs(back.target_master.affection - 8) <= 0.1)
  assert.ok(Math.abs(back.target_master.dependency - 6) <= 0.1)
  assert.ok(Math.abs(back.target_master.playfulness - 7) <= 0.1)
})

test('ipcToEcho:脏输入不炸,量纲夹在合法区间', () => {
  const r = ipcToEcho({ a: 9, c: -9, ext: { sadness: 'x' } })
  assert.ok(r.target_master.affection >= 0 && r.target_master.affection <= 10)
  assert.ok(r.target_master.dependency >= 0 && r.target_master.dependency <= 10)
  assert.equal(r.target_master.sadness, undefined)
  const r2 = ipcToEcho()
  assert.ok(Number.isFinite(r2.target_master.affection))
})

test('dyad:主人一侧缺失 ⇒ otherMissing,不猜对方位置', () => {
  const d = dyad(VEC)
  assert.equal(d.otherMissing, true)
  assert.equal(d.other, null)
  assert.equal(d.self.c, 0.8)
  assert.match(d.note, /未接入|单边/)
})

test('dyad:给了主人坐标 ⇒ 双边就绪', () => {
  const d = dyad(VEC, { a: 0.7, c: 0.6 })
  assert.equal(d.otherMissing, false)
  assert.deepEqual(d.other, { a: 0.7, c: 0.6 })
  assert.match(d.note, /双方坐标/)
  const bad = dyad(VEC, { a: 'x', c: 1 })
  assert.equal(bad.otherMissing, true)
})
