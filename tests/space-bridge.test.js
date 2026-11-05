/**
 * 桥接层(`lib/space-bridge.js`)单测。
 *
 * 钉三条硬规矩(拍板 ④⑨):
 *   1. **往返无损**:同空间出发 → 联合 → 回本空间,缓存齐备时逐位复原;
 *   2. **缓存缺失降级**:不抛错,标 `degraded` + `degradeReason`,数值走投影近似;
 *   3. **误差只记录不回写**:`compareShared` 绝不改调用方对象,误差进 `snapshot()`。
 * 另外钉:关闸 / IPC 不可用(fail-soft)/ θd 耦合 / 参数夹取 / 缓存 LRU。
 *
 * [工程假设] 在本文件里以断言形式固化,便于日后改参数时"知道会破什么"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSpaceBridge, createBridgeCache, normalizeParams, DEFAULT_BRIDGE_PARAMS
} from '../lib/space-bridge.js'

const rad = (d) => d * Math.PI / 180

test('默认参数:θs=35 / θs_ipc=71(文献),θd=0、λ=1(工程假设),影子模式默认开', () => {
  const p = normalizeParams()
  assert.equal(p.thetaS, 35)
  assert.equal(p.thetaSipc, 71)
  assert.equal(p.thetaD, 0)
  assert.equal(p.lambdaS, 1)
  assert.equal(p.lambdaD, 1)
  assert.equal(p.biasS, 0)
  assert.equal(p.shadowMode, true)
  assert.equal(DEFAULT_BRIDGE_PARAMS.thetaS, 35)
})

test('参数夹取:角度折到 (−180,180]、尺度 ≤20、偏置 ≤1', () => {
  const p = normalizeParams({ thetaS: 380, thetaSipc: -450, lambdaS: 100, lambdaD: -3, biasS: 5 })
  assert.equal(p.thetaS, 20)
  assert.equal(p.thetaSipc, -90)
  assert.equal(p.lambdaS, 20)
  assert.equal(p.lambdaD, 0.05)
  assert.equal(p.biasS, 1)
})

test('PAD 往返无损(双极入、双极出;联合坐标按 1e-6 取整 ⇒ 容差 1e-6)', () => {
  const b = createSpaceBridge()
  const r = b.roundTripPad({ p: 0.4, a: -0.2, d: 0.6 }, {})
  assert.equal(r.ok, true)
  assert.equal(r.degraded, false)
  assert.ok(r.err < 1e-6, `往返误差 ${r.err} 应≈0`)
  assert.ok(Math.abs(r.back.P - 0.4) < 1e-6)
  assert.ok(Math.abs(r.back.A - -0.2) < 1e-6)
  assert.ok(Math.abs(r.back.D - 0.6) < 1e-6)
})

test('共享轴角度:θs=0 ⇒ s=P;θs=90 ⇒ s=A;θs=35 ⇒ 余弦组合', () => {
  const b0 = createSpaceBridge({ params: { thetaS: 0 } })
  assert.ok(Math.abs(b0.padToUnion({ p: 0.5, a: 0.9 }, { native: false }).union.s - 0.5) < 1e-9)
  const b90 = createSpaceBridge({ params: { thetaS: 90 } })
  assert.ok(Math.abs(b90.padToUnion({ p: 0.5, a: 0.9 }, { native: false }).union.s - 0.9) < 1e-9)
  const b35 = createSpaceBridge({ params: { thetaS: 35 } })
  const got = b35.padToUnion({ p: 0.5, a: 0.9 }, { native: false }).union.s
  const want = Math.cos(rad(35)) * 0.5 + Math.sin(rad(35)) * 0.9
  assert.ok(Math.abs(got - want) < 1e-6, `${got} ≠ ${want}`)
})

test('旋转保范数:s² + a² = P² + A²(正交变换)且 s = cosθ·P + sinθ·A', () => {
  const b = createSpaceBridge()
  const u = b.padToUnion({ p: 0.5, a: 0.9 }, { native: false }).union
  const src = 0.5 * 0.5 + 0.9 * 0.9
  const dst = u.s * u.s + u.a * u.a
  assert.ok(Math.abs(dst - src) < 1e-5, `范数没保住:${dst} ≠ ${src}`)
  const want = Math.cos(rad(35)) * 0.5 + Math.sin(rad(35)) * 0.9
  assert.ok(Math.abs(u.s - want) < 1e-6)
})

test('IPC 侧共享轴:θs_ipc=71 时 s=cos71·L+sin71·G(L/G 为双极)', () => {
  const b = createSpaceBridge()
  const r = b.ipcToUnion({ lov: 1, dom: 1 }, { sessionId: 'ipc-1' })
  assert.equal(r.ok, true)
  const want = Math.cos(rad(71)) + Math.sin(rad(71)) // ≈1.271 ⇒ 夹到 1
  assert.equal(r.clamped, true)
  assert.equal(r.union.s, 1)
  const b0 = createSpaceBridge({ params: { thetaSipc: 0 } })
  const r2 = b0.ipcToUnion({ lov: 1, dom: 0 }, { sessionId: 'ipc-2' })
  assert.ok(Math.abs(r2.union.s - 1) < 1e-9)
  assert.equal(r2.union.a, 0) // IPC 没有激活轴
  assert.ok(want > 1)
})

test('IPC 往返无损(带 sessionId 走缓存)', () => {
  const b = createSpaceBridge()
  const r = b.roundTripIpc({ lov: 0.8, dom: 0.6 }, { sessionId: 'rt-ok' })
  assert.equal(r.ok, true)
  assert.equal(r.degraded, false)
  assert.ok(r.err < 1e-5, `往返误差 ${r.err}`)
  assert.ok(Math.abs(r.back.lov - 0.8) < 1e-5)
  assert.ok(Math.abs(r.back.agency - 0.6) < 1e-5)
})

test('缓存缺失降级:回 IPC 时没有 ipcOrth ⇒ 标 degraded、走投影、不抛', () => {
  const b = createSpaceBridge()
  const back = b.unionToIpc({ s: 0.5, a: 0, d: 0 })
  assert.equal(back.ok, true)
  assert.equal(back.degraded, true)
  assert.equal(back.degradeReason, 'missing-ipc-orth-cache')
  const back2 = b.unionToPad({ s: 0.5, a: 0, d: 0 })
  assert.equal(back2.degraded, true)
  assert.equal(back2.degradeReason, 'missing-aPad-cache')
  assert.ok(b.snapshot().degraded >= 2)
  assert.match(b.snapshot().lastNote, /降级/)
})

test('缓存齐备时 unionToPad 用缓存补激活轴,不再降级', () => {
  const b = createSpaceBridge()
  b.cache.put('warm', { aPad: 0.42 })
  const r = b.unionToPad({ s: 0.3, a: 0, d: 0.1 }, { sessionId: 'warm', native: false })
  assert.equal(r.degraded, false)
  assert.ok(Math.abs(r.axes.A) > 0.1, '激活轴应被缓存补回')
})

test('compareShared:误差只记录、不回写,读数不被夹取', () => {
  const b = createSpaceBridge()
  const pad = { s: 0.6, a: 0.1, d: 0.2 }
  const ipc = { s: 0.4, a: 0, d: 0 }
  const frozen = JSON.stringify(pad)
  const cmp = b.compareShared(pad, ipc)
  assert.equal(JSON.stringify(pad), frozen, 'pad 对象被改了 ⇒ 违反"只记录不回写"')
  assert.ok(Math.abs(cmp.err - 0.2) < 1e-6)
  assert.equal(cmp.sPad, 0.6)
  assert.equal(cmp.sIpc, 0.4)
  const big = b.compareShared({ s: 1.5 }, { s: 0.2 })
  assert.equal(big.sPad, 1.5, '读数不该被夹到 1')
  assert.ok(b.snapshot().sharedErrN >= 2)
  assert.ok(b.snapshot().sharedErrMaxAbs >= 1.3)
})

test('λs 只影响预测值(不污染读数)', () => {
  const b = createSpaceBridge()
  b.configure({ lambdaS: 2 })
  const cmp = b.compareShared({ s: 0.5 }, { s: 0.5 })
  assert.equal(cmp.predicted, 1)
  assert.ok(Math.abs(cmp.err - 0.5) < 1e-6)
  assert.equal(cmp.lambdaS, 2)
})

test('θd 耦合:θd=90 时支配轴读到共享轴分量', () => {
  const b = createSpaceBridge({ params: { thetaD: 90 } })
  const r = b.padToUnion({ p: 0.5, a: 0 }, { native: false })
  const s = Math.cos(rad(35)) * 0.5
  assert.ok(Math.abs(r.union.d - s) < 1e-5, `d=${r.union.d} 应≈s=${s}`)
})

test('关闸:enabled=false ⇒ 三个入口都干脆不干活(fail-soft)', () => {
  const b = createSpaceBridge({ params: { enabled: false } })
  assert.equal(b.padToUnion({ p: 0, a: 0 }).ok, false)
  assert.equal(b.padToUnion({ p: 0, a: 0 }).reason, 'bridge-disabled')
  assert.equal(b.ipcToUnion({ lov: 0.5, dom: 0.5 }).ok, false)
  assert.equal(b.snapshot().mode, 'off')
  assert.ok(b.snapshot().disabled >= 2)
})

test('IPC 不可用 ⇒ fail-soft,不抛错,有 reason 与 note', () => {
  const b = createSpaceBridge({ ipcAvailable: false })
  const r = b.ipcToUnion({ lov: 0.9, dom: 0.9 }, { sessionId: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'ipc-unavailable')
  assert.deepEqual(r.union, { s: 0, a: 0, d: 0 })
  const back = b.unionToIpc({ s: 0.5 })
  assert.equal(back.ok, false)
  assert.equal(back.degradeReason, 'ipc-unavailable')
  assert.ok(b.snapshot().ipcUnavailable >= 2)
  assert.match(b.snapshot().lastNote, /降级/)
})

test('缓存 LRU:超上限淘汰最旧,统计 hits/misses', () => {
  const cache = createBridgeCache({ max: 2 })
  cache.put('a', { aPad: 1 }); cache.put('b', { aPad: 2 }); cache.put('c', { aPad: 3 })
  assert.equal(cache.size(), 2)
  assert.equal(cache.get('a'), null) // 被淘汰
  assert.ok(cache.get('b'))
  const st = cache.stats()
  assert.equal(st.puts, 3)
  assert.ok(st.hits >= 1 && st.misses >= 1)
  cache.clear()
  assert.equal(cache.size(), 0)
})

test('describe:影子模式读数含 θ/λ 与误差开关', () => {
  const b = createSpaceBridge()
  const line = b.describe({ s: 0.25, a: -0.1, d: 0.05 })
  assert.match(line, /联合空间 \{s=0\.25, a=-0\.1, d=0\.05\}/)
  assert.match(line, /θs=35°/)
  assert.match(line, /err=/)
  b.configure({ exposeErr: false })
  assert.ok(!b.describe({ s: 0, a: 0, d: 0 }).includes('err='))
})

test('snapshot:模式随参数切换 shadow / live,reset 清零但保留参数', () => {
  const b = createSpaceBridge()
  assert.equal(b.snapshot().mode, 'shadow')
  b.configure({ shadowMode: false })
  assert.equal(b.snapshot().mode, 'live')
  b.padToUnion({ p: 0, a: 0 })
  b.reset()
  const st = b.snapshot()
  assert.equal(st.padToUnion, 0)
  assert.equal(st.sharedErrN, 0)
  assert.equal(st.mode, 'live')
})
