/**
 * IPC 适配器(`lib/ipc-adapter.js`)单测。
 *
 * 借来的 `lib/ipc-core/` 是 MIT 只读副本:这里既**核对我们借到了什么**
 * (178 词 / 33 锚点 / 81 格 / 8 分仪),也钉住 **fail-soft**
 * (核心缺失 ⇒ 一律 null + 记账,绝不上抛)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIpcAdapter } from '../lib/ipc-adapter.js'

test('inventory:借到的账目对得上(178 词 / 33 锚点 / 81 格 / 8 分仪 / 轴 a,c)', async () => {
  const ipc = createIpcAdapter()
  const inv = await ipc.inventory()
  assert.ok(inv, 'inventory 不该为 null')
  assert.deepEqual(inv.axes, ['a', 'c'])
  assert.equal(inv.octants, 8)
  assert.equal(inv.cells, 81)
  assert.ok(inv.states && inv.states.total === 178, `关系状态词应为 178,实得 ${inv.states && inv.states.total}`)
  assert.ok(inv.anchors && inv.anchors.total === 33, `姿态锚点应为 33,实得 ${inv.anchors && inv.anchors.total}`)
  assert.equal(ipc.available(), true)
})

test('nearestAnchors:中心点也能有最近锚点,且返回结构可用', async () => {
  const ipc = createIpcAdapter()
  const hits = await ipc.nearestAnchors({ a: 0.5, c: 0.5 }, { limit: 3 })
  assert.ok(Array.isArray(hits) && hits.length > 0)
  for (const h of hits) {
    assert.ok(h && typeof h === 'object')
    assert.ok(Number.isFinite(Number(h.a)) && Number.isFinite(Number(h.c)))
    assert.ok(typeof h.id === 'string')
  }
})

test('relationship:六个量所在的度量对象可拿到,标量摘要只含白名单键', async () => {
  const ipc = createIpcAdapter()
  const m = await ipc.relationship({ a: 0.2, c: 0.8 }, { a: 0.7, c: 0.6 })
  assert.ok(m && typeof m === 'object')
  const q = ipc.pickQuantities(m)
  if (q !== null) {
    for (const key of Object.keys(q)) {
      assert.ok(['reciprocity', 'correspondence', 'complementarity', 'complementarityFloor',
        'similarity', 'opposition', 'agencyCorrespondence', 'communalOpposition',
        'euclideanSimilarity', 'geometricComplementarity'].includes(key), `多出未在白名单的键 ${key}`)
      assert.ok(Math.abs(q[key]) <= 1.0001, `${key} 应是 [0,1] 量纲`)
    }
  }
})

test('complementOf / antiComplementOf:互补位与错位的定义不动', async () => {
  const ipc = createIpcAdapter()
  const c = await ipc.complementOf({ a: 0.2, c: 0.3 })
  assert.ok(Math.abs(c.a - 0.8) < 1e-9, `互补位 a 应为 1−0.2,实得 ${c.a}`)
  assert.ok(Math.abs(c.c - 0.3) < 1e-9)
  const ac = await ipc.antiComplementOf({ a: 0.2, c: 0.3 })
  assert.ok(Math.abs(ac.a - 0.2) < 1e-9)
  assert.ok(Math.abs(ac.c - 0.7) < 1e-9)
})

test('relationshipStates / describeRegion / octantRelation 都能调通', async () => {
  const ipc = createIpcAdapter()
  const m = await ipc.relationship({ a: 0.3, c: 0.85 }, { a: 0.6, c: 0.8 })
  const states = await ipc.relationshipStates(m, { limit: 4 })
  // 上游返回对象(不是数组):只要求"拿到东西且非空",不猜形状
  assert.ok(states !== null, 'relationshipStates 不该为 null')
  const size = Array.isArray(states) ? states.length : Object.keys(states).length
  assert.ok(size > 0, 'relationshipStates 结果不该是空的')
  const region = await ipc.describeRegion({ a: 0.3, c: 0.85 })
  assert.ok(region && typeof region === 'object')
  const rel = await ipc.octantRelation({ a: 0.3, c: 0.85 }, { a: 0.6, c: 0.8 })
  assert.ok(rel && typeof rel === 'object')
  assert.equal(typeof rel.kind, 'string')
  assert.ok(Number.isFinite(rel.gap), `octantRelation 应给出夹角,实得 gap=${rel.gap}`)
})

test('normalizePoint:越界夹取、非数回中性、缺对象不炸', () => {
  const ipc = createIpcAdapter()
  assert.deepEqual(ipc.normalizePoint({ a: 2, c: -1 }), { a: 1, c: 0 })
  assert.deepEqual(ipc.normalizePoint({ a: 'x', c: null }), { a: 0.5, c: 0.5 })
  assert.deepEqual(ipc.normalizePoint(null), { a: 0.5, c: 0.5 })
  assert.deepEqual(ipc.normalizePoint('nope'), { a: 0.5, c: 0.5 })
})

test('fail-soft:核心路径不存在 ⇒ 全部返回 null、记账、不抛', async () => {
  const ipc = createIpcAdapter({ modulePath: './ipc-core/__definitely_missing__.js' })
  const inv = await ipc.inventory()
  assert.equal(inv, null)
  assert.equal(await ipc.nearestAnchors({ a: 0.5, c: 0.5 }), null)
  assert.equal(await ipc.relationship({ a: 0.5, c: 0.5 }, { a: 0.5, c: 0.5 }), null)
  assert.equal(await ipc.complementOf({ a: 0.5, c: 0.5 }), null)
  assert.equal(ipc.available(), false)
  const st = ipc.stats()
  assert.ok(st.failures >= 1)
  assert.ok(typeof st.loadError === 'string' && st.loadError.length > 0)
  assert.match(st.lastNote, /不可用|降级/)
})

test('pickQuantities:非对象 ⇒ null;空对象 ⇒ null', () => {
  const ipc = createIpcAdapter()
  assert.equal(ipc.pickQuantities(null), null)
  assert.equal(ipc.pickQuantities(42), null)
  assert.equal(ipc.pickQuantities({ note: 'nope' }), null)
})
