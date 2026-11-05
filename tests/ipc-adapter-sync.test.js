/**
 * IPC 适配器的**同步**取数口(G5/G6 第二步为圆盘/立方体加的):
 * `lexiconSync` / `complementOfSync` / `antiComplementOfSync` / `describeRegionSync`。
 *
 * 这一层只做两件事:① 把上游形状摊成面板好用的字段;② 核心缺失 ⇒ `null`(fail-soft)。
 * 所以两条都要钉:**形状对得上** + **坏了不许抛**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIpcAdapter } from '../lib/ipc-adapter.js'

test('lexiconSync:8 个分仪 + 33 条锚点,形状是面板要的那几个键', async () => {
  const a = createIpcAdapter({})
  await a.ensure()
  assert.equal(a.available(), true, 'ipc-core 副本应该在仓里(没装插件也算可用)')
  const lex = a.lexiconSync()
  assert.equal(lex.octants.length, 8, '分仪恒为 8')
  assert.equal(lex.anchors.length, 33, '姿态锚点是 33 条(拍板 ⑦ 并用)')
  const oct = lex.octants[0]
  assert.deepEqual(Object.keys(oct).sort(), ['angle', 'code', 'en', 'id', 'zh'])
  assert.equal(typeof oct.zh, 'string')
  assert.ok(Number.isFinite(oct.angle), '画圆盘要角度')
  const anchor = lex.anchors[0]
  for (const k of ['id', 'code', 'zh', 'a', 'c', 'octant', 'intensity']) assert.ok(k in anchor, '锚点缺键 ' + k)
})

test('补位 / 对立位:互补位换 a 保 c,对立位 a、c 都翻(坐标都留在 [0,1])', async () => {
  const a = createIpcAdapter({})
  await a.ensure()
  const p = { a: 0.2, c: 0.98 }
  const comp = a.complementOfSync(p)
  const anti = a.antiComplementOfSync(p)
  assert.ok(Math.abs(comp.a - 0.8) < 1e-9, '互补位 a 应该翻过来')
  assert.ok(Math.abs(comp.c - 0.98) < 1e-9, '互补位 c 不变')
  assert.ok(Math.abs(anti.a - 0.2) < 1e-9 && Math.abs(anti.c - 0.02) < 1e-9, '对立位两轴都翻')
  for (const v of [comp.a, comp.c, anti.a, anti.c]) assert.ok(v >= 0 && v <= 1)
})

test('describeRegionSync:形状对齐上游 describeRegion(octant 摊成代号 + 中文 + 释义)', async () => {
  const a = createIpcAdapter({})
  await a.ensure()
  const r = a.describeRegionSync({ a: 0.2, c: 0.98 })
  assert.equal(r.octant, 'JK', '0.2/0.98 落在随和(JK)那 45° 里')
  assert.equal(r.zh, '随和')
  assert.ok(Number.isFinite(r.angle) && r.angle > 0 && r.angle <= 360)
  assert.equal(typeof r.label, 'string')
  assert.ok(r.label.length > 0, 'label 是"明显随和"这类人话,不能是空串')
  assert.equal(typeof r.band, 'string')
  assert.ok(r.axisWords !== null && typeof r.axisWords === 'object', '两轴的词要有')
  assert.equal(r.neutral, false)
  // 中性点必须自报 neutral(上游专门为"没什么可说的"留了这条)
  assert.equal(a.describeRegionSync({ a: 0.5, c: 0.5 }).neutral, true)
})

test('核心缺失 ⇒ 同步口一律 null(绝不抛);可用性同步可查', async () => {
  const broken = createIpcAdapter({ modulePath: './ipc-core/__definitely_missing__.js' })
  await broken.ensure()
  assert.equal(broken.available(), false)
  assert.equal(broken.lexiconSync(), null)
  assert.equal(broken.describeRegionSync({ a: 0.5, c: 0.5 }), null)
  assert.equal(broken.complementOfSync({ a: 0.5, c: 0.5 }), null)
  assert.equal(broken.antiComplementOfSync({ a: 0.5, c: 0.5 }), null)
  // 2026-10-06 用户侧坐标那五个口同样 fail-soft
  assert.equal(broken.relationshipSync({ a: 0.5, c: 0.5 }, { a: 0.5, c: 0.5 }), null)
  assert.equal(broken.appraisalPromptSync([{ role: 'user', text: 'hi' }]), null)
  assert.equal(broken.parseAppraisalSync('{}'), null)
  assert.equal(broken.defaultDynamicsSync(), null)
  assert.equal(broken.integrateDyadSync(null, null, null, 1), null)
})

// ---- 2026-10-06:用户侧坐标(设计 §1.6)需要的五个同步口 ----

test('relationshipSync:两个坐标才成立 —— 面板读的那几个键是契约(**形状快照**)', async () => {
  const a = createIpcAdapter({})
  await a.ensure()
  const m = a.relationshipSync({ a: 0.2, c: 0.98 }, { a: 0.8, c: 0.98 })
  assert.ok(m !== null, '两个点齐了就该算得出关系度量')
  // ① 两个点(面板画青点读 `metrics.other.{a,c}`)—— ⚠️ 上游会把坐标**量化到栅格**,
  // 所以 0.98 出来是 0.9,不是原样(消费端别按"原始小数"断言)。
  assert.deepEqual(m.self, { a: 0.2, c: 0.9 })
  assert.deepEqual(m.other, { a: 0.8, c: 0.9 })
  // ② 六个关系量(两轴级 + 总标量 + 下界 + 对立 + 相似)全在白名单里
  for (const k of ['reciprocity', 'correspondence', 'agencyCorrespondence', 'communalOpposition',
    'complementarity', 'complementarityFloor', 'similarity', 'opposition']) {
    assert.ok(k in m.quantities, '关系量缺了 ' + k)
  }
  // ③ 面板画关系向量/标签读的三件
  assert.ok(Number.isFinite(m.separationDegrees), '分离角')
  assert.equal(typeof m.pattern, 'object', '关系原型(panel: pattern.zh / pattern.fit)')
  assert.ok(Array.isArray(m.prototypes))
  assert.ok(m.complementPoint && m.contrastPoint, '理想互补位 / 对立位')
  // ④ 分仪代号(两个点各自落在哪个 45°;代号表是上游的,这里只钉"两侧不一样")
  assert.equal(m.selfOctant, 'JK', '0.2/0.9 落在随和那一格')
  assert.equal(m.otherOctant, 'NO', '0.8/0.9 落在主导-热情那一格')
  assert.notEqual(m.selfOctant, m.otherOctant)
  // ⑤ 语义:掌控轴相反、联结轴相同 ⇒ 这是**互补**那一半
  assert.equal(m.quantities.reciprocity, 1, '掌控轴正好相反 ⇒ 互动性满分')
  assert.equal(m.quantities.correspondence, 1, '联结轴正好相同 ⇒ 一致性满分')
  assert.equal(m.quantities.complementarity, 1, '两个分量都满分 ⇒ 互补总分 1')
  assert.equal(m.quantities.complementarityFloor, 1, '下界 = 两个分量里更弱的那个')
  // 对立 = 两轴都相反的均值:这里**只有**掌控轴相反 ⇒ 0.6(不是"对立")
  // 相似 = 两轴同向度的均值:联结轴满分、掌控轴 0.4 ⇒ 0.7
  // —— 这两个数正是"相似与互补是并列关系、不是互补数"的证据:面板不该只画一个。
  assert.equal(m.quantities.opposition, 0.6)
  assert.ok(Math.abs(m.quantities.similarity - 0.7) < 1e-9, '实际 ' + m.quantities.similarity)
  // 原型判定(面板读 `pattern.zh` / `pattern.fit`):0.8/0.9 正好是"互补"的理想位
  assert.equal(m.pattern.id, 'complementary')
  assert.equal(m.pattern.zh, '互补')
  assert.equal(m.pattern.fit, 1)
  assert.ok(m.separationDegrees > 70 && m.separationDegrees < 75, '分离角约 73.7°,实际 ' + m.separationDegrees)
})

test('relationshipSync:单方坐标给不出关系(缺一个点 ⇒ 调用方不该调它)', async () => {
  const a = createIpcAdapter({})
  await a.ensure()
  // 传 null 会被归一成圆心 0.5/0.5 —— 那是"没有读数"不是"中性关系";
  // 所以**判空在调用方**(`lib/ipc-appraise.js` 的 applyGate:`other === null` 就不算)。
  const m = a.relationshipSync({ a: 0.2, c: 0.98 }, null)
  assert.ok(m !== null)
  assert.deepEqual(m.other, { a: 0.5, c: 0.5 })
  // 面板那条纪律仍然成立:没有 `other` 时**不画**(不是画到圆心)
  assert.equal(m.otherNeutral, true, '圆心 = 平淡(半径 0)⇒ 所以调用方必须**判空**,不能靠中性挡')
  assert.equal(m.selfNeutral, false)
})

test('appraisalPromptSync:**用上游提示词**(不新写),转写已裁、两方都点名', async () => {
  const a = createIpcAdapter({})
  await a.ensure()
  const p = a.appraisalPromptSync([{ role: 'user', text: '在吗' }, { role: 'assistant', text: '在。' }], { roleName: '她', userName: '他' })
  assert.ok(p.system.length > 50, 'system 该是上游那份打分规则')
  assert.ok(p.user.includes('【最近对话】'))
  assert.ok(p.user.includes('他：在吗'))
  assert.ok(p.user.includes('她：在。'))
  assert.ok(p.user.includes('self') && p.user.includes('other'), '两方都要点名')
  assert.ok(p.transcript.includes('他：在吗'), '裁好的转写也回带(审计/调试要看它)')
  // 开局判断:没有对话 + 给人格正文 ⇒ 判的是"她刚登场时的默认位置"
  const opening = a.appraisalPromptSync([], { roleName: '她', userName: '他', persona: '（人格正文）' })
  assert.ok(opening.user.includes('【开局：角色设定】'))
  assert.ok(opening.user.includes('（人格正文）'))
  assert.ok(opening.user.includes('【开局时用户说的第一句话】'), '开局那版的对话块名也不同')
})

test('parseAppraisalSync:双方 + 置信 + 完整度;解析不了 ⇒ null(不抛)', async () => {
  const a = createIpcAdapter({})
  await a.ensure()
  const r = a.parseAppraisalSync(JSON.stringify({ self: { a: 0.6, c: 0.7 }, other: { a: 0.3, c: 0.55 }, confidence: 0.9, reason: '他收着说' }))
  assert.deepEqual(r.self, { a: 0.6, c: 0.7 })
  // 0.55 被**量化到 0.1 网格**(上游 quantizePoint)→ 0.6。消费端要知道这件事:
  // 落库的坐标是栅格上的,不是模型的原始小数。
  assert.deepEqual(r.other, { a: 0.3, c: 0.6 })
  assert.equal(r.confidence, 0.9)
  assert.equal(r.complete, true)
  assert.equal(r.reason, '他收着说')
  for (const bad of ['没有 JSON', '', null, undefined, '[]']) {
    assert.equal(a.parseAppraisalSync(bad), null, String(bad) + ' 该解析不出来')
  }
})

test('defaultDynamicsSync / integrateDyadSync:动力学是上游的默认值,惯性不越级跳', async () => {
  const a = createIpcAdapter({})
  await a.ensure()
  const d = a.defaultDynamicsSync()
  assert.ok(d && typeof d === 'object')
  const out = a.integrateDyadSync({ self: { a: 0.5, c: 0.5 }, other: { a: 0.5, c: 0.5 } }, { self: { a: 1, c: 1 }, other: { a: 0, c: 0 } }, d, 1)
  assert.ok(out && typeof out === 'object')
  // ⚠️ 上游字段叫 `latent`(不是 `point`)—— 消费端要按这个读,读错就是静默跳过惯性。
  assert.ok(out.latent && out.latent.self && out.latent.other, '结算结果要含双方的新位置')
  assert.ok(out.grid && out.grid.self, '栅格化那份也要有')
  assert.ok(out.delta && out.delta.self, '位移也要有')
  // 目标在 (1,1),起点在中心 ⇒ 一步之内不该直接跳到目标(惯性的意思)
  assert.ok(out.latent.self.a < 1, '一步跳到底就不是惯性了')
  assert.ok(out.latent.self.a > 0.5, '但必须真的朝目标动了(否则就是上面那个静默 bug)')
})
