/**
 * 「情绪空间」页(`web/views/emotion-space.js`)的单测 —— G5/G6 第二~四步。
 *
 * 钉六件事:
 *   ① `globalThis.EchoViews['emotion-space']` 挂上了、`draw` 是函数;
 *   ② **契约**:view 里不许出现 `fetch`(取数只走 `api.get`),也不许有写通路(拍板 D9:只读);
 *      端点按 40 轮取数(D5 轨迹上限);
 *   ③ `summaryOf()` 是纯函数:真形状的假数据能摊成摘要(含**顶层六件套**),坏数据不抛;
 *   ④ `historyRows()` / `trailOf()` 缺字段 ⇒ `null` / 跳过,**不填 0**;
 *   ⑤ 门禁/来源的中文映射与 `lib/space-bridge.js` / 拍板 D2 一致;
 *   ⑥ 两个 canvas 的几何与绘制是上游原式 —— 圆盘 `toScreen/polarToScreen/sectorPath`、
 *      立方体 `rotate/project/world` 与 PAD 口径换算;轨迹"越旧越暗"逐段单调;
 *      拖拽方向按拍板 D12(唯一一处偏离上游);上游缺数据的说明性分支(关系向量、
 *      人格基线、词表锚点)在**给了数据**时也能画出来,不留死代码。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../web/views/emotion-space.js', import.meta.url)), 'utf8')
const g = {}
new Function('globalThis', src)(g) // eslint-disable-line no-new-func
const V = g.EchoViews && g.EchoViews['emotion-space']

/** 一份"形状与端点一致"的假数据(数值随便取,只验形状与文案)。 */
const FIXTURE = {
  schema: 'echo.emotion.union.v1',
  at: 1760000000000,
  mode: 'live',
  enabled: true,
  pad: { p: 0.4, a: -0.2, d: -0.6, missing: [], dSource: 'derived' },
  union: { s: 0.31, a: -0.02, d: -0.6 },
  gate: 'green',
  bridgeErr: 0.06,
  direction: 'positive',
  sPad: -0.05,
  sIpc: 0.24,
  predicted: 0.19,
  ipc: {
    role: { a: 0.2, c: 0.7 },
    octants: [{ code: 'PA', zh: '主导', angle: 90 }],
    anchors: [{ id: 'assured-dominant', zh: '主导', a: 0.9, c: 0.5 }],
    complementPoint: { a: 0.8, c: 0.3 },
    antiComplementPoint: { a: 0.2, c: 0.3 },
    region: { zh: '温暖-顺从', angle: 200 },
    anchor: { id: 'warm', zh: '温暖', octant: 'LM' },
    metrics: null,
    metricsNote: '主人一侧坐标未接入(QQ 侧打分器未接):关系度量要两个点,本版只给单方姿态'
  },
  history: [
    {
      at: 1759999000000,
      sessionId: 's1',
      userEmotion: 'neutral',
      moodIntensity: 4,
      pad: { valence: 0.2, arousal: 0.1, dominance: -0.3 },
      dSource: 'derived',
      ipc: { a: 0.3, c: 0.6 },
      union: { s: 0.28, a: 0.01, d: -0.3 },
      sPad: -0.05, sIpc: 0.24, bridgeErr: 0.06,
      gate: 'green', direction: 'positive', degraded: false, missing: []
    },
    { gate: 'red' } // 缺字段的那一条(必须回 null / '—',不是 0)
  ],
  degraded: false,
  // ②(2026-10-05):「语气候选」段(端点按最近一轮读数**现算**,不是当时注入的原文)
  styleHint: {
    enabled: true,
    source: 'recomputed',
    at: 1759999000000,
    delta: 'pos',
    arousalBand: 'up',
    arousalKnown: true,
    valenceSign: 'pos',
    valenceKnown: true,
    valenceFromS: false,
    gate: 'green',
    sTrusted: true,
    candidates: [2],
    avoid: [4, 5],
    line: '- 语气候选(朗读用):偏正向(唤醒偏高、心情偏正)。有转折时偏向用 <emo type="2">(上扬),<emo type="4">/<emo type="5"> 不优先;没转折就不加。'
  },
  ipcAvailable: true,
  missing: [],
  dSource: 'derived',
  assumptions: '两套坐标系不等价、不可互推',
  note: '只读'
}

test('挂载与契约:EchoViews 里的 emotion-space 存在,且不出现 fetch / 写通路', () => {
  assert.ok(V, "EchoViews['emotion-space'] 必须挂上")
  assert.equal(typeof V.draw, 'function')
  assert.equal(V.PATH, '/api/echo/emotion-space', '路径必须与宿主 echo.api.emotionSpace() 一致')
  assert.equal(/\bfetch\s*\(/.test(src), false, 'view 里不许出现 fetch(契约:取数走 api.get)')
  assert.equal(/api\.(put|post)\s*\(/.test(src), false, '只读页不许有写通路(拍板 D9)')
})

test('summaryOf:真形状 ⇒ 三张卡都摊得出来,支配标着「推导」', () => {
  const s = V.summaryOf(FIXTURE)
  assert.match(s.state, /模式 live/)
  assert.match(s.state, /IPC 副本 可用/)
  assert.match(s.state, /逐轮样本 2 条/)
  assert.match(s.pad.join(' | '), /支配 d = -0\.60/)
  assert.match(s.pad.join(' | '), /推导 \[工程假设\]/, 'D2:来源必须跟着读数走')
  assert.match(s.union.join(' | '), /共享轴 s = 0\.31/)
  assert.match(s.union.join(' | '), /门禁:绿 · 进 prompt/)
  assert.match(s.union.join(' | '), /s_pad = -0\.05 vs s_ipc = 0\.24/)
  assert.match(s.ipc.join(' | '), /角色姿态:a\(主导\)= 0\.20/)
  assert.match(s.ipc.join(' | '), /互补位:\(0\.80, 0\.30\)/)
  assert.match(s.ipc.join(' | '), /词表:分仪 1/)
  assert.deepEqual(s.warn, [], '这份假数据没有该报的降级')
})

test('summaryOf:降级场景逐条出提示(缺维 / IPC 缺失 / 主人坐标没接)', () => {
  const s = V.summaryOf({
    ipcAvailable: false,
    degraded: true,
    pad: { missing: ['dominance', 'arousal'] },
    ipc: { octants: null, anchors: null, role: null },
    history: []
  })
  const all = s.warn.join(' | ')
  assert.match(all, /IPC 副本不可用/)
  assert.match(all, /分仪表不可用/)
  assert.match(all, /缺维:dominance、arousal/)
  assert.match(all, /桥接降级/)
  assert.match(all, /IPC 侧姿态拿不到/)
})

test('summaryOf / historyRows:坏数据不抛,缺字段一律 null(不填 0)', () => {
  assert.doesNotThrow(() => V.summaryOf(null))
  assert.doesNotThrow(() => V.summaryOf({}))
  assert.doesNotThrow(() => V.historyRows(undefined))
  assert.deepEqual(V.historyRows(undefined), [])
  const rows = V.historyRows(FIXTURE)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].gate, 'green')
  assert.equal(rows[0].s, 0.28)
  assert.equal(rows[0].dSource, 'derived')
  assert.equal(rows[1].gate, 'red')
  assert.equal(rows[1].p, null, '缺字段必须是 null —— 面板不许把"没有"画成 0')
  assert.equal(rows[1].s, null)
  assert.equal(rows[1].ipcA, null)
  assert.equal(rows[1].when, '—')
})

test('映射表:门禁四档 + 方向四档都对得上(与 space-bridge 同义)', () => {
  assert.deepEqual(Object.keys(V.GATE_COLOR).sort(), ['green', 'red', 'unknown', 'yellow'])
  assert.equal(V.GATE_ZH.yellow, '黄 · 只给方向')
  assert.equal(V.dirZh('positive'), '偏正向')
  assert.equal(V.dirZh('negative'), '偏负向')
  assert.equal(V.dirZh('flat'), '基本持平')
  assert.equal(V.dirZh(null), '—')
  assert.equal(V.SOURCE_ZH.derived, '推导 [工程假设]')
})

test('③ 圆盘:几何是上游原式(圆盘半径 0.5、y 取反、弧的 anticlockwise 约定)', () => {
  assert.equal(V.DISK_RADIUS, 0.5, '与上游 DISK_RADIUS / 宿主 MAX_RADIUS 一致')
  const view = { cx: 100, cy: 100, r: 80 }
  // 中心 (0.5,0.5) ⇒ 画面中心
  assert.deepEqual(V.toScreen({ a: 0.5, c: 0.5 }, view), { x: 100, y: 100 })
  // c=1.0 ⇒ 正右; a=1.0 ⇒ 正上(y 取反)
  assert.deepEqual(V.toScreen({ a: 0.5, c: 1 }, view), { x: 180, y: 100 })
  assert.deepEqual(V.toScreen({ a: 1, c: 0.5 }, view), { x: 100, y: 20 })
  // 极坐标:0° 在正右、90° 在正上(角度从 +联结 起算、逆时针为正)
  const right = V.polarToScreen(0, 1, view)
  assert.ok(Math.abs(right.x - 180) < 1e-9 && Math.abs(right.y - 100) < 1e-9)
  const up = V.polarToScreen(90, 1, view)
  assert.ok(Math.abs(up.x - 100) < 1e-9 && Math.abs(up.y - 20) < 1e-9)
  const half = V.polarToScreen(180, 0.5, view)
  assert.ok(Math.abs(half.x - 60) < 1e-9 && Math.abs(half.y - 100) < 1e-9)
})

test('③ 轨迹:只取有 ipc 的历史行(旧 → 新),缺行跳过而不是补 0', () => {
  const trail = V.trailOf({
    history: [
      { ipc: { a: 0.3, c: 0.6 } },
      { ipc: null },
      { ipc: { a: 0.2, c: 0.98 } },
      { ipc: { a: null, c: 0.5 } }
    ]
  })
  assert.deepEqual(trail, [{ a: 0.3, c: 0.6 }, { a: 0.2, c: 0.98 }])
  assert.deepEqual(V.trailOf(undefined), [])
  assert.deepEqual(V.trailOf({ history: 'nope' }), [])
})

test('④ 立方体:3D 数学是上游原式(世界映射 / 旋转 / 透视)', () => {
  // PAD [0,1]³ → 世界 [-1,1]³,中性点落正中心
  assert.deepEqual(V.world({ p: 0.5, a: 0.5, d: 0.5 }), { x: 0, y: 0, z: 0 })
  assert.deepEqual(V.world({ p: 1, a: 0, d: 0.5 }), { x: 1, y: -1, z: 0 })
  // yaw=0 / pitch=0 ⇒ 恒等
  assert.deepEqual(V.rotate({ x: 1, y: 0, z: 0 }, 0, 0), { x: 1, y: 0, z: 0 })
  // yaw=90° ⇒ +x 落到 +z
  const r = V.rotate({ x: 1, y: 0, z: 0 }, Math.PI / 2, 0)
  assert.ok(Math.abs(r.x) < 1e-9 && Math.abs(r.z - 1) < 1e-9, 'yaw 是绕 Y 轴的右手旋转')
  // 透视:z=0 ⇒ depth=1,直接按 scale 缩放且 y 取反
  assert.deepEqual(V.project({ x: 1, y: 1, z: 0 }, { cx: 100, cy: 100, scale: 50 }), { x: 150, y: 50, depth: 0, scale: 1 })
  // 相机在 +z、距离 4.2:z=1 ⇒ 4.2/3.2
  const near = V.project({ x: 0, y: 0, z: 1 }, { cx: 0, cy: 0, scale: 1 })
  assert.ok(Math.abs(near.depth - 1) < 1e-9 && Math.abs(near.scale - 4.2 / 3.2) < 1e-9, 'CAMERA 必须是 4.2')
  assert.equal(V.CORNERS.length, 8)
  assert.equal(V.FACES.length, 6)
  assert.deepEqual(V.AXES.map((a) => a.short), ['P', 'A', 'D'])
})

test('④ PAD 口径换算:双极轴 a/d 按 bipolarToUnit 折到 [0,1],缺维留 null(不猜 0.5)', () => {
  const u = V.padUnitOf({ p: 0.2, a: -0.5555555555555556, d: -0.6 })
  assert.ok(Math.abs(u.p - 0.2) < 1e-9, 'p 本来就是 [0,1]')
  assert.ok(Math.abs(u.a - 0.2222222222222222) < 1e-9, '(a+1)/2')
  assert.ok(Math.abs(u.d - 0.2) < 1e-9, '(d+1)/2')
  assert.deepEqual(V.padUnitOf({ p: null, a: null, d: null }), { p: null, a: null, d: null })
  assert.deepEqual(V.padUnitOf(null), { p: null, a: null, d: null })
  // 轨迹:缺维的行跳过,顺序保持旧 → 新
  const trail = V.trailUnitOf({ history: [{ pad: { p: 0.1, a: 0, d: 0 } }, { pad: { p: 0.2, a: null, d: 0 } }, { pad: { p: 0.3, a: 1, d: 1 } }] })
  assert.equal(trail.length, 2)
  assert.ok(Math.abs(trail[0].a - 0.5) < 1e-9 && Math.abs(trail[1].a - 1) < 1e-9)
})

test('④ 立方体:轨迹越旧越暗(透明度按 0.06+0.5·age 单调升),三种降级都不抛', () => {
  const alphas = []
  const grad = { addColorStop: () => {} }
  const g = {
    clearRect: () => {}, fillRect: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
    arc: () => {}, closePath: () => {}, fill: () => {}, stroke: () => {}, fillText: () => {},
    setLineDash: () => {}, setTransform: () => {},
    createRadialGradient: () => grad,
    set fillStyle (v) {}, get fillStyle () { return '' },
    set strokeStyle (v) { const m = /rgba\(255,214,120,([0-9.]+)\)/.exec(String(v)); if (m !== null) alphas.push(Number(m[1])) },
    get strokeStyle () { return '' },
    set lineWidth (v) {}, get lineWidth () { return 1 },
    set font (v) {}, set textAlign (v) {}, set textBaseline (v) {}, set globalAlpha (v) {}, get globalAlpha () { return 1 }
  }
  const trail = Array.from({ length: 40 }, (_, i) => ({ p: i / 40, a: 0.4, d: 0.5 }))
  const state = { point: { p: 0.2, a: 0.2222222222222222, d: 0.2 }, trail, label: '当前(d 推导)', reason: '' }

  V.drawCube(g, { width: 420, height: 320, yaw: -0.62, pitch: 0.42, state, anchors: [] })
  assert.equal(alphas.length, 39, '40 个轨迹点 ⇒ 39 段;只有轨迹用这个颜色')
  for (let i = 1; i < alphas.length; i += 1) {
    assert.ok(alphas[i] > alphas[i - 1], '第 ' + i + ' 段不该比前一段更亮(越旧越暗)')
  }
  assert.ok(alphas[0] < 0.09 && alphas[alphas.length - 1] > 0.5, '最旧接近 0.06、最新接近 0.56')

  // 没有 PAD(全 null)⇒ 只画房间和轴 + 等待字
  V.drawCube(g, { width: 420, height: 320, yaw: 0, pitch: 0, state: { point: { p: null, a: null, d: null }, trail: [], label: '', reason: 'PAD 有缺维:画不出当前点' }, anchors: [] })
  // 没有任何数据(state=null)
  V.drawCube(g, { width: 420, height: 320, yaw: 0, pitch: 0, state: null, anchors: [] })
  // 只有本轮、没有历史 ⇒ 不该画线段
  const before = alphas.length
  V.drawCube(g, { width: 420, height: 320, yaw: 0, pitch: 0, state: { point: { p: 0.5, a: 0.5, d: 0.5 }, trail: [{ p: 0.5, a: 0.5, d: 0.5 }], label: '当前', reason: '' }, anchors: [] })
  assert.equal(alphas.length, before, 'trail 只有 1 个点 ⇒ 不画线')
})

test('④ 拖拽:[拍板 D12] 横向跟着手走(唯一一处偏离上游),纵向与俯仰夹照上游', () => {
  // 往右拖 50px:上游是 yaw0 + 0.4(实测让"前面心"往左走 = 逆着手)
  assert.equal(V.dragYaw(0, 50), -0.4, '取负之后表面跟着手')
  assert.equal(V.dragYaw(-0.62, -50), -0.62 + 0.4)
  assert.equal(V.dragYaw(1, 0), 1, '没动就不变')
  // 纵向照上游:往下拖 ⇒ pitch 增;夹在 ±1.45
  assert.equal(V.dragPitch(0.42, 50), 0.42 + 50 * 0.008, '系数必须是 0.008(浮点:写成同一个算式)')
  assert.equal(V.dragPitch(0, 800), 1.45, '上限')
  assert.equal(V.dragPitch(0, -800), -1.45, '下限')
  assert.equal(V.dragPitch(0.2, 0), 0.2)
})

test('③ 画布:drawDisc 能跑在假上下文上,且三种降级都不抛', () => {
  // 最小假 2D 上下文:只要记录调用次数就能证明"画了东西"
  let ops = 0
  const grad = { addColorStop: () => { ops += 1 } }
  const g = {
    clearRect: () => { ops += 1 }, fillRect: () => { ops += 1 }, beginPath: () => { ops += 1 },
    moveTo: () => { ops += 1 }, lineTo: () => { ops += 1 }, arc: () => { ops += 1 },
    closePath: () => { ops += 1 }, fill: () => { ops += 1 }, stroke: () => { ops += 1 },
    fillText: () => { ops += 1 }, setLineDash: () => { ops += 1 }, setTransform: () => { ops += 1 },
    createRadialGradient: () => grad,
    set fillStyle (v) { ops += 1 },
    set strokeStyle (v) { ops += 1 },
    set lineWidth (v) { ops += 1 },
    set font (v) { ops += 1 },
    set textAlign (v) { ops += 1 },
    set textBaseline (v) { ops += 1 }
  }
  const show = { trail: true, anchors: true, ideal: true }
  const octants = [{ code: 'PA', zh: '主导', angle: 90 }, { code: 'JK', zh: '随和', angle: 315 }]
  const anchors = [{ a: 0.5, c: 0.5 }, { a: 0.9, c: 0.5 }]
  const role = { a: 0.2, c: 0.98 }

  ops = 0
  V.drawDisc(g, { width: 400, height: 360, state: { role, octants, anchors, history: [{ a: 0.3, c: 0.6 }, role], complementPoint: { a: 0.8, c: 0.98 }, antiComplementPoint: { a: 0.2, c: 0.02 }, region: { word: '随和' }, metrics: null }, anchors, show })
  const painted = ops
  assert.ok(painted > 60, '正常路径应该画了不少图元,实际 ' + painted)

  ops = 0
  V.drawDisc(g, { width: 400, height: 360, state: null, anchors: [], show })
  assert.ok(ops > 20, '没有姿态读数时也要画底(盘 + 提示字)')

  ops = 0
  V.drawDisc(g, { width: 400, height: 360, state: { role: null, octants: null, anchors: null, history: [] }, anchors: [], show })
  assert.ok(ops > 20, 'IPC 副本缺失(分仪为 null)时画空盘 + 原因,不许抛')

  ops = 0
  V.drawDisc(g, { width: 400, height: 360, state: { role, octants, anchors, history: [], complementPoint: null, antiComplementPoint: null, region: null, metrics: null }, anchors, show })
  assert.ok(ops > 60, '缺主人坐标时照样画角色点 + 灰环占位')
})

test('⑤ 扇区路径:sectorPath 用 anticlockwise=true(上游 258-268 的约定)', () => {
  const calls = []
  const g = {
    beginPath: () => { calls.push(['beginPath']) },
    moveTo: (x, y) => { calls.push(['moveTo', x, y]) },
    arc: (x, y, r, from, to, ccw) => { calls.push(['arc', x, y, r, from, to, ccw]) },
    closePath: () => { calls.push(['closePath']) }
  }
  const view = { cx: 100, cy: 100, r: 80 }
  V.sectorPath(g, 0, 45, 1, view)
  assert.deepEqual(calls[0], ['beginPath'])
  assert.deepEqual(calls[1], ['moveTo', 100, 100], '从中心起笔')
  const arc = calls[2]
  assert.equal(arc[0], 'arc')
  assert.deepEqual([arc[1], arc[2], arc[3]], [100, 100, 80])
  assert.ok(Math.abs(arc[4] - 0) < 1e-9 && Math.abs(arc[5] + Math.PI / 4) < 1e-9, '角度取负(屏幕 y 向下)')
  assert.equal(arc[6], true, '必须 anticlockwise')
  assert.deepEqual(calls[3], ['closePath'])
})

test('⑤ 关系向量:一旦两个坐标都在,上游那一段(箭头 + 关系词 + 分离角)能画出来', () => {
  const texts = []
  const grad = { addColorStop: () => {} }
  const g = {
    clearRect: () => {}, fillRect: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
    arc: () => {}, closePath: () => {}, fill: () => {}, stroke: () => {}, setLineDash: () => {},
    createRadialGradient: () => grad,
    fillText: (s) => { texts.push(String(s)) },
    set fillStyle (v) {}, get fillStyle () { return '' },
    set strokeStyle (v) {}, get strokeStyle () { return '' },
    set lineWidth (v) {}, set font (v) {}, set textAlign (v) {}, set textBaseline (v) {}
  }
  // 合成一份"主人坐标已接入"的状态:Echo 现在拿不到,但这段代码是搬来的,不能让它烂掉
  V.drawDisc(g, {
    width: 400, height: 360,
    state: {
      role: { a: 0.2, c: 0.98 }, octants: [], anchors: [], history: [],
      complementPoint: { a: 0.8, c: 0.98 }, antiComplementPoint: null, region: { word: '随和' },
      metrics: { other: { a: 0.7, c: 0.3 }, pattern: { zh: '亲密袒露与交流', fit: 0.87 }, separationDegrees: 128.4, flat: false }
    },
    anchors: [], show: { trail: false, anchors: false, ideal: false }
  })
  assert.ok(texts.includes('随和') || texts.some((t) => t.includes('角色')), '角色点标签还在')
  assert.ok(texts.some((t) => t.includes('亲密袒露与交流') && t.includes('0.87')), '关系词 + 拟合度(上游 `${pattern.zh} ${fit.toFixed(2)}`)')
  assert.ok(texts.some((t) => t.includes('128')), '分离角取整 + °')
  assert.ok(texts.includes('用户'), '用户点标签')
})

test('⑤ 立方体:人格基线与词表锚点两条分支也是搬来的,给了数据就得画', () => {
  const texts = []
  const grad = { addColorStop: () => {} }
  const g = {
    clearRect: () => {}, fillRect: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
    arc: () => {}, closePath: () => {}, fill: () => {}, stroke: () => {}, setLineDash: () => {},
    createRadialGradient: () => grad,
    fillText: (s) => { texts.push(String(s)) },
    set fillStyle (v) {}, get fillStyle () { return '' },
    set strokeStyle (v) {}, get strokeStyle () { return '' },
    set lineWidth (v) {}, set font (v) {}, set textAlign (v) {}, set textBaseline (v) {},
    set globalAlpha (v) {}, get globalAlpha () { return 1 }
  }
  V.drawCube(g, {
    width: 420, height: 320, yaw: -0.62, pitch: 0.42,
    anchors: [{ id: 'a1', zh: '平常', p: 0.5, a: 0.5, d: 0.5 }],
    state: {
      point: { p: 0.2, a: 0.22, d: 0.2 }, trail: [], label: '当前',
      baseline: { p: 0.6, a: 0.5, d: 0.5 }, alternatives: [{ id: 'a1' }], reason: ''
    }
  })
  assert.ok(texts.includes('平常'), '词表锚点的中文标签(上游用 anchor.zh)')
  assert.ok(texts.includes('当前'), '当前点标签')
})

test('⑤ 六件套:summaryOf 必须读**顶层**的 gate/残差/两侧读数/预测/方向(② 曾漏给)', () => {
  const s = V.summaryOf({
    ipc: { role: { a: 0.2, c: 0.98 }, metrics: null },
    union: { s: -0.154823, a: -0.5698, d: -0.6 },
    gate: 'yellow', bridgeErr: 0.1234567, sPad: -0.154823, sIpc: 0.312545,
    predicted: 0.145177, direction: 'positive',
    history: [{ at: 1, pad: {}, union: {} }]
  })
  const joined = s.union.join('\n')
  assert.ok(joined.includes('黄 · 只给方向'), '门禁档位来自顶层 gate')
  assert.ok(joined.includes('0.12'), '残差取顶层 bridgeErr')
  assert.ok(joined.includes('-0.15') && joined.includes('0.31'), '两侧读数取顶层 sPad / sIpc')
  assert.ok(joined.includes('0.15'), '预测取顶层 predicted')
  assert.ok(joined.includes('偏正向'), '方向取顶层 direction')
})

test('⑤ 端点用法:面板按 40 轮(拍板 D5)取数,且仍然不许出现写通路', () => {
  assert.ok(src.includes("?limit=40"), '立方体/圆盘的轨迹上限是 40 轮')
  assert.ok(!/api\.(put|post)\s*\(/.test(src))
  assert.ok(!/fetch\s*\(/.test(src))
})

test('⑦ 语气候选②:summaryOf 摊出这一行(含候选/禁区/门禁/来源),并走独立一张卡', () => {
  const s = V.summaryOf(FIXTURE)
  assert.ok(Array.isArray(s.style) && s.style.length >= 3, '语气候选有自己的几行')
  assert.ok(s.style[0].startsWith('- 语气候选(朗读用):'), '第一行就是 prompt 原文')
  const joined = s.style.join('\n')
  assert.match(joined, /候选 <emo type="2"> · 不优先 <emo type="4"> <emo type="5">/)
  assert.match(joined, /触发 偏正向 · 唤醒 up · 心情 pos/)
  assert.match(joined, /门禁 绿 · 进 prompt\(允许引用共享轴\)/)
  assert.match(joined, /来源:按最近一轮读数现算/, '必须写明是现算,不是当时注入的原文')
  assert.ok(src.includes("card('语气候选(<emo> 朗读语气)', s.style)"), '面板上要有这一块')
})

test('⑦ 语气候选②:不出行要说清理由;开关关着 / 端点没给 / 坏数据都不抛', () => {
  assert.match(V.styleLinesOf({ delta: 'zero', candidates: [4] })[0], /不出行 —— 强度没变/)
  assert.match(V.styleLinesOf({ delta: 'unknown', candidates: [2] })[0], /读不出变化/)
  assert.match(V.styleLinesOf({ delta: 'pos', candidates: [] })[0], /候选被掏空/)
  assert.match(V.styleLinesOf({ enabled: false, line: 'x' })[0], /开关 styleHint 关着/)
  assert.match(V.styleLinesOf(undefined)[0], /端点没给/)
  for (const bad of [null, 0, 'x', [], { line: 7 }, { candidates: 'x', avoid: 1 }]) {
    assert.doesNotThrow(() => V.styleLinesOf(bad))
    assert.ok(Array.isArray(V.styleLinesOf(bad)))
  }
})

// ════════════════════════════════════════════════════════════════════════
// 2026-10-07 MVP-3:圆盘关系量 / 残差卡 / 基线挂载 / 偏差虚线 / 文案
// 五组夹具:有数 · 缺数 · 红档 · 绿档 · 有基线 / 无基线
// ════════════════════════════════════════════════════════════════════════

const METRICS_OK = {
  other: { a: 0.3, c: 0.6 },
  pattern: { zh: '相似', fit: 0.7857 },
  separationDegrees: 26.565,
  quantities: {
    reciprocity: 0.5, correspondence: 0.7, complementarity: 0.6,
    complementarityFloor: 0.5, similarity: 0.8, opposition: 0.5
  },
  selfNeutral: false, otherNeutral: false
}

/** 端点真形状:`baseline` 的 `d` 恒 null(P2 拍板:支配维未启用)。 */
const BASELINE_OK = {
  set: true, p: 2, a: 3, d: null, source: 'manual',
  unit: { p: 0.2, a: -0.5555, d: null }, updatedAt: 1791000000000, note: '手填'
}

test('M1 有数:六个量 + 关系类型/分离角都摊出来,且**不再写"未接入"**', () => {
  const s = V.summaryOf({ ipc: { role: { a: 0.2, c: 0.9 }, octants: [], metrics: METRICS_OK } })
  const j = s.ipc.join('\n')
  assert.match(j, /六个量:互补 0\.60 · 互动性 0\.50 · 一致性 0\.70 · 相似 0\.80 · 对立 0\.50/)
  assert.match(j, /关系类型:相似\(fit 0\.79\) · 分离角 26\.6°/)
  assert.ok(!j.includes('未接入'), 'M5:有数就不许再写"未接入"(这就是老写法撒的那句谎)')
  assert.match(j, /六个量在本卡/)
})

test('M1/M5 缺数:写"缺席"并带端点给的真原因;**不填 0**', () => {
  const s = V.summaryOf({ ipc: { metrics: null, metricsNote: '这轮没有判定' } })
  const j = s.ipc.join('\n')
  assert.match(j, /关系度量:缺席\(这轮没有判定\)/)
  assert.ok(!j.includes('未接入'), '缺数也不该说"未接入"(主人坐标已接入,只是这轮没有)')
  // badge:没数 ⇒ 缺席;有数 ⇒ 一句短的(互补 / 分离角 / 关系类型)
  assert.equal(V.metricBadgeText({ metrics: null }), '关系度量:缺席(要两个坐标)')
  assert.match(V.metricBadgeText({ metrics: METRICS_OK }), /^互补 0\.60 · 分离 26\.6° · 相似$/)
  // 六个量缺键 ⇒ —(不是 0)
  const partial = V.summaryOf({ ipc: { metrics: { quantities: { complementarity: 0.6 } } } })
  assert.match(partial.ipc.join('\n'), /互动性 — · 一致性 — · 相似 —/)
})

test('M2 残差卡:绿档给数 / 红档明说"不画数" / 没判定写"这一轮没判定"', () => {
  const green = V.summaryOf({
    ipc: { metrics: METRICS_OK, ipcErr: { a: 0.1, c: 0, maxAbs: 0.1 }, errGate: 'green', gain: 0.9, at: 1791291302961 }
  })
  const gj = green.residual.join('\n')
  assert.match(gj, /maxAbs 0\.10\(Δa 0\.10 · Δc 0\.00\)/)
  assert.match(gj, /档:绿 · 进 prompt/)
  assert.match(gj, /可信度:0\.90/)
  assert.match(gj, /判定于 /)
  const red = V.summaryOf({ ipc: { metrics: null, ipcErr: { a: 0.4, c: 0.1, maxAbs: 0.4 }, errGate: 'red', gain: 0.9 } })
  assert.match(red.residual.join('\n'), /红档:本版不画数、不给点/)
  const low = V.summaryOf({ ipc: { metrics: null, ipcErr: { maxAbs: 0.2 }, errGate: 'yellow', gain: 0.2, lowConfidence: true } })
  assert.match(low.residual.join('\n'), /低于门槛:不落库/)
  for (const none of [{}, null, { ipc: { metrics: null } }]) {
    assert.match(V.summaryOf(none).residual.join('\n'), /这一轮没判定/)
  }
  // 面板上真有这张卡
  assert.ok(src.includes("card('两把尺子的差(只记账)', s.residual)"))
  assert.ok(src.includes('residual: residualLinesOf(ipc)'))
})

test('M3/M5 基线:有 ⇒ 图例写 P/A 与来源并去压暗;没有 ⇒ 仍标"未接入"且不画点', () => {
  const on = V.baselineTextOf({ baseline: BASELINE_OK })
  assert.equal(on.dim, false)
  assert.match(on.text, /人格基线\(P 2\.00 \/ A 3\.00,手填\)/)
  // 立方体口径:用 unit,d 落中面(0)—— 支配维本来就没启用
  assert.deepEqual(on.base.point, { p: 0.2, a: -0.5555, d: 0 })
  for (const off of [{ baseline: { set: false, p: 2, a: 3 } }, {}, null]) {
    assert.equal(V.baselineTextOf(off).base, null, '没开总闸/没填 ⇒ 不画')
    assert.match(V.baselineTextOf(off).text, /未接入/)
    assert.equal(V.baselineTextOf(off).dim, true)
  }
  // 只有一维 ⇒ 也算没填(不半画一个点)
  assert.equal(V.baselineOf({ baseline: { set: true, p: 2, a: 3, unit: { p: 0.2 } } }), null)
  assert.equal(V.baselineOf({ baseline: { set: true, p: 2, a: 3, source: 'mean', unit: { p: 0.1, a: 0.1 } } }).source, 'mean')
})

test('2026-10-07:锚点图例已删(本仓主动不提供,不是"上游功能缺")', () => {
  assert.equal(src.includes('词表锚点 —— 未接入'), false, '立方体图例里不许再有这条(D3 拍板 ⑨ 已撤掉那份目录)')
  assert.ok(src.includes('本仓主动不提供'), 'AXIS_HELP 要说清是主动不提供,而不是上游缺')
  // 绘制分支保留(输入驱动、有测试);生产上永远没有数据 —— 这是有意的
  assert.ok(src.includes('if (show.anchors)'))
})

test('M4 偏差虚线:有基线 ⇒ 画虚线并标 ΔP/ΔA;没基线 ⇒ 一个字都不多', () => {
  const texts = []
  const ctx = (bag) => ({
    clearRect: () => {}, fillRect: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
    arc: () => {}, closePath: () => {}, fill: () => {}, stroke: () => {}, setLineDash: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    fillText: (s) => { bag.push(String(s)) },
    set fillStyle (v) {}, get fillStyle () { return '' },
    set strokeStyle (v) {}, set lineWidth (v) {}, set font (v) {},
    set textAlign (v) {}, set textBaseline (v) {}, get globalAlpha () { return 1 }, set globalAlpha (v) {}
  })
  V.drawCube(ctx(texts), {
    width: 420, height: 320, yaw: -0.62, pitch: 0.42, anchors: [],
    state: {
      point: { p: 0.5, a: 0.5, d: 0.5 }, trail: [], label: '当前', reason: '',
      baseline: { p: 0.2, a: 0.3, d: 0 }
    }
  })
  assert.ok(texts.some((t) => t.startsWith('ΔP 0.30 · ΔA 0.20')), 'Δ = 当前 − 基线:' + JSON.stringify(texts.slice(-3)))
  // 没基线 / 基线缺维 ⇒ 不画(也不该冒出 Δ 字样)
  for (const st of [
    { point: { p: 0.5, a: 0.5, d: 0.5 }, trail: [], label: '当前', reason: '' },
    { point: { p: null, a: null, d: null }, trail: [], label: '当前', reason: '缺维', baseline: { p: 0.2, a: 0.3, d: 0 } }
  ]) {
    const bag = []
    V.drawCube(ctx(bag), { width: 420, height: 320, yaw: 0, pitch: 0, anchors: [], state: st })
    assert.equal(bag.some((t) => t.includes('ΔP')), false, '没两点齐 ⇒ 不画偏离')
  }
})
