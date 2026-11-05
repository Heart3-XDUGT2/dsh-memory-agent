/**
 * dsh-echo — 图谱布局:用**真的 d3-force** 跑**真的活库图**
 * ============================================================
 * 09-26 深夜,他说了两遍「太丑了」。我改了一版,然后用自己写的近似积分器
 * 量了半天 —— 那东西只能证明"我的模型里的配方不自相矛盾",证明不了
 * "浏览器里那张图是好的"。所以这一份把 d3 本体请进来(web/vendor/d3.v7.min.js,
 * 页面自己加载的就是它),再把**页面里那段布局代码原样抽出来**跑:
 *
 *   tests/_graph-tuning.mjs 的 pageBundleAndDegree / pageForceRun
 *
 * 于是这份电池测的就不再是我的复述,而是页面自己的代码 + 页面自己的 d3。
 * 它仍然看不见"好不好看" —— 好不好看只能他刷一眼。但"会不会叠、会不会飞出
 * 画布、会不会炸成一片空地"从今往后是量出来的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadD3, pageBundleAndDegree, pageForceRun, tuning } from './_graph-tuning.mjs'

// 1663×987 = 他实际那块屏(2026-09-26 深夜他发的截图尺寸)。以前这里是 1280×760,
// 比真机小一圈 —— 拿真尺寸算,布局才真的被测到。
const W = 1663; const H = 987
const d3 = loadD3()
const live = JSON.parse(readFileSync(new URL('./fixtures/graph-live-2026-09-26.json', import.meta.url), 'utf8'))
const edges = live.edges.map((e) => ({ ...e }))
const nodes = live.nodes.map((n) => ({ ...n }))

function layout (list, opts = {}) {
  const ns = list.map((n) => ({ ...n }))
  const { bundles, degree, bundleEdges, degOf } = pageBundleAndDegree(edges)
  const out = pageForceRun({ d3, nodes: ns, bundles, degree, degOf, W, H, clamp: opts.clamp !== false })
  return { nodes: ns, bundles, degree, bundleEdges, out }
}
function minGap (ns) {
  const T = { radiusOf: (w) => 9 + 6 * Math.sqrt(Math.max(0.1, Math.min(10, Number(w) || 0.1)) / 10) }
  let best = Infinity; let who = ''
  for (let i = 0; i < ns.length; i += 1) {
    for (let j = i + 1; j < ns.length; j += 1) {
      const a = ns[i]; const b = ns[j]
      const gap = Math.hypot(a.x - b.x, a.y - b.y) - T.radiusOf(a.weight) - T.radiusOf(b.weight)
      if (gap < best) { best = gap; who = a.name + '↔' + b.name }
    }
  }
  return { gap: best, who }
}

test('★★ 真 d3 跑活库真图:排开、不叠、不出画布', () => {
  const { nodes: ns, bundles } = layout(nodes)
  assert.equal(ns.length, 17)
  assert.ok(bundles.length < edges.length, '平行关系没合并:' + bundles.length + ' vs ' + edges.length)
  // 1) 圆不许叠(collide 在 d3 里是硬约束,叠了就是配方真的有问题)
  const { gap, who } = minGap(ns)
  assert.ok(gap > 0, '真 d3 布局里有圆叠着:' + who + ' ' + gap.toFixed(1) + 'px')
  // 2) 不许跑出画布(cur = 视口;留 30px 边距给圆和名字)
  const out = ns.filter((n) => n.x < -30 || n.y < -30 || n.x > W + 30 || n.y > H + 30)
  assert.equal(out.length, 0, '有节点跑出画布:' + out.map((n) => n.name + '@' + n.x.toFixed(0) + ',' + n.y.toFixed(0)).join(' '))
  // 3) 不许挤成一小团,也不许散成一片空地
  const cx = W / 2; const cy = (H + 60) / 2
  const far = Math.max(...ns.map((n) => Math.hypot(n.x - cx, n.y - cy)))
  assert.ok(far > 150, '挤成一小团(最远 ' + far.toFixed(0) + 'px)')
  assert.ok(far < Math.min(W, H) * 0.5, '散成一片空地(最远 ' + far.toFixed(0) + 'px,视口半高 ' + (H / 2) + ')')
  // 4) 每条"束"都不许短到贴脸(最短的一条也要 > 50px)
  let minEdge = Infinity
  for (const b of bundles) {
    const a = ns.find((n) => n.id === b.source); const c = ns.find((n) => n.id === b.target)
    minEdge = Math.min(minEdge, Math.hypot(a.x - c.x, a.y - c.y))
  }
  assert.ok(minEdge > 50, '最短的连线只有 ' + minEdge.toFixed(0) + 'px')
  // 5) 关键节点别被挤到角落:权重最高的那个(活库里"用户",权重 31)该在中段
  const hub = ns.slice().sort((a, b) => b.weight - a.weight)[0]
  assert.ok(hub.name === '用户', '夹具变了:' + hub.name)
  assert.ok(Math.hypot(hub.x - cx, hub.y - cy) < Math.min(W, H) * 0.35,
    '权重最高的节点离画面中心 ' + Math.hypot(hub.x - cx, hub.y - cy).toFixed(0) + 'px,太靠边')
  // 6) 不许排成"蒲公英"(2026-09-26 深夜他截图里那个形状):枢纽的一圈邻居如果到它的
  //    距离几乎一样,画出来就是一朵等距放射的蒲公英。用真 d3 排完之后量离散度。
  const ring = ns.filter((n) => n.id !== hub.id)
    .map((n) => Math.hypot(n.x - hub.x, n.y - hub.y))
  const mean = ring.reduce((a, b) => a + b, 0) / ring.length
  const sd = Math.sqrt(ring.reduce((a, b) => a + (b - mean) ** 2, 0) / ring.length)
  assert.ok(sd / mean > 0.15, '邻居到枢纽的距离几乎一样(离散度 ' + (sd / mean).toFixed(3) +
    '):画出来就是朵等距蒲公英,微扰没生效')
  // 7) 线是配角:线宽上限必须明显小于最小圆的直径
  const T = tuning()
  assert.ok(T.linkWidth(10, 100) < T.radiusOf(1), '最粗的线(' + T.linkWidth(10, 100) +
    'px)比最小的圆半径(' + T.radiusOf(1) + 'px)还粗 —— 又是"线抢戏"')
})

test('★★ 真 d3:平行关系合并成一束 —— 6 条画在一起你只看得见一条,而且那一对被拉得比配方更近', () => {
  const bundled = layout(nodes)
  const { bundles, degree, degOf } = pageBundleAndDegree(edges)
  // 不合并(旧写法):每条边自己一束
  const flat = edges.map((e) => ({ key: e.id, source: e.source, target: e.target, weight: e.weight, activation: e.activation, relation: e.relation, edges: [e] }))
  const raw = nodes.map((n) => ({ ...n }))
  pageForceRun({ d3, nodes: raw, bundles: flat, degree, degOf, W, H })
  assert.ok(bundles.length < edges.length, '没合并:' + bundles.length + ' vs ' + edges.length)
  // 活库里 4 对节点之间有多条关系,逐对量"合并 vs 不合并"的距离
  const pair = new Map()
  for (const e of edges) {
    const k = e.source < e.target ? e.source + '\u0000' + e.target : e.target + '\u0000' + e.source
    pair.set(k, (pair.get(k) || 0) + 1)
  }
  const multi = [...pair.entries()].filter(([, n]) => n > 1)
  assert.ok(multi.length >= 3, '夹具里的平行关系不见了:' + multi.length + ' 对')
  const dist = (ns, key) => {
    const [a, b] = key.split('\u0000')
    const x = ns.find((n) => n.id === a); const y = ns.find((n) => n.id === b)
    return Math.hypot(x.x - y.x, x.y - y.y)
  }
  const worst = multi.slice().sort((a, b) => b[1] - a[1])[0]
  const merged = dist(bundled.nodes, worst[0])
  const loose = dist(raw, worst[0])
  // 合并之后那一对只剩**一根弹簧**,而且束的权重取对子里最大的那条(10)——
  // 所以它按"强关系"的距离坐。旧断言写的是"不合并更近",那是旧配方的巧合:
  // 那时每条平行边权重都按 1 算、距离只由权重决定,6 根弹簧只是拽得更紧。
  // 现在权重取 max ⇒ 合并后落在强关系的距离上(更近),这才是"强的近"该有的样子。
  const bworst = bundles.find((b) => b.key === worst[0])
  assert.equal(bworst.edges.length, 6, '那一对(用户—' + bworst.target + ')该有 6 条平行关系')
  assert.equal(bworst.weight, 10, '束的权重该取对子里最大的那条(不是平均、不是求和)')
  assert.ok(merged < loose,
    '合并后该按强关系坐得更近(实测:合并 ' + merged.toFixed(0) + 'px / 不合并 ' + loose.toFixed(0) + 'px)')
  assert.ok(merged > tuning().linkDistance(10, 12, 1) * 0.7,
    '合并后不该被理想距离拽得更近(实测 ' + merged.toFixed(0) + 'px)')
  // 两道闸在页面里都在:合并(上面)+ 预跑限速
  const withClamp = layout(nodes, { clamp: true })
  const far = Math.max(...withClamp.nodes.map((n) => Math.hypot(n.x - W / 2, n.y - (H + 60) / 2)))
  assert.ok(far < Math.min(W, H) * 0.6, '限速那一版跑出画面了:最远 ' + far.toFixed(0) + 'px')
  void degree
})

test('★★ 统计栏的"连线"数就是画布上真正画出来的线数(用页面自己的代码算)', () => {
  const { bundles, seen } = pageBundleAndDegree(edges)
  assert.ok(seen.sl, '页面那段代码没有把"连线数"写进统计栏')
  assert.equal(String(seen.sl.textContent), String(bundles.length),
    '统计栏写 ' + seen.sl.textContent + ',画布上其实有 ' + bundles.length + ' 根线')
  assert.ok(bundles.length < edges.length, '这组数据该有平行关系可合并')
})

test('★★ 页面的力真的接在 d3 上(不是我复述的配方)', () => {
  const { nodes: ns, out } = layout(nodes)
  const sim = out.simulation
  assert.ok(sim && typeof sim.force === 'function', '抽出来的那段没造出 d3 仿真')
  for (const name of ['link', 'charge', 'x', 'y', 'collision', 'angles', 'edgeRepel']) {
    assert.ok(sim.force(name), '少了 force(' + name + ')')
  }
  assert.equal(sim.force('center'), undefined, '还有 forceCenter(位移不是力,会把结构压平)')
  // 度数传递:link 里每个端的 index 都解析到了节点(不是 NaN)
  assert.ok(ns.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), '有节点的坐标不是有限数')
  assert.ok(ns.every((n) => Number.isFinite(n.vx) && Number.isFinite(n.vy)), '有节点的速度不是有限数')
})

/** 相邻两条边的夹角(度):每个节点把邻居方向排序,返回所有相邻间隔。 */
function adjacentAngles (ns, links) {
  const out = []
  for (const n of ns) {
    const dirs = []
    for (const l of links) {
      const o = l.source === n ? l.target : l.target === n ? l.source : null
      if (o) dirs.push(Math.atan2(o.y - n.y, o.x - n.x))
    }
    if (dirs.length < 2) continue
    dirs.sort((a, b) => a - b)
    for (let i = 0; i < dirs.length; i += 1) {
      const nx = i + 1 < dirs.length ? dirs[i + 1] : dirs[0] + Math.PI * 2
      out.push({ name: n.name || n.id, deg: dirs.length, gap: ((nx - dirs[i]) * 180) / Math.PI, uniform: 360 / dirs.length })
    }
  }
  return out
}

test('★ 关节处不许挤成锐角:枢纽(度 12)最挤的那一格也得 ≥ 理想的 45%', () => {
  // 他(第八次之后追加):「记忆图谱的这个关节处不应该能弯那么狠……那两个线段中间
  // 最好不要成锐角」。改之前实测这一格是 **0.3°**(理想的 1%),两条边叠在一起。
  const { nodes: ns, out } = layout(nodes)
  const angs = adjacentAngles(ns, out.d3Links)
  const T = tuning()
  const worst = angs.slice().sort((a, b) => a.gap / b.uniform - b.gap / b.uniform)[0]
  assert.ok(worst.gap / worst.uniform >= 0.45,
    '最挤的关节只有 ' + worst.gap.toFixed(1) + '°(「' + worst.name + '」度' + worst.deg +
    ',理想 ' + worst.uniform.toFixed(0) + '°)—— 夹角力没起作用或被压回去了(实测 0.60)')
  assert.ok(worst.gap > T.angleUniform(worst.deg) * 0.3, '还是有几乎重叠的两条边:' + worst.gap.toFixed(2) + '°')
  // 每个节点(不限度数)都不许出现"几乎重合"(<8°)的两条边
  for (const a of angs) {
    assert.ok(a.gap > 8, '「' + a.name + '」处两条边只差 ' + a.gap.toFixed(1) + '°,看着就是一条')
  }
})

test('★★ 他的原话场景:把一个点钉住绕一圈,两条边的夹角永远不小', () => {
  // 「假设一个记忆树上面有三个点,三个点中间有两线的,我把一个点给转一圈,
  //   然后另外一个线段不动,就会感觉很很难受」
  // 复现:找一个度 2 的节点,钉住它放在圆心周围 24 个角度上,每种情况跑一遍布局,
  // 量它两条边的夹角。**对照组**是把页面里那两条自定义力拆掉 —— 拆掉必须变红,
  // 否则这条测试证明不了力有用。
  const T = tuning()
  const W2 = W / 2; const H2 = (H + 60) / 2
  const count = new Map()
  for (const e of edges) {
    count.set(e.source, (count.get(e.source) || 0) + 1)
    count.set(e.target, (count.get(e.target) || 0) + 1)
  }
  const target = nodes.filter((n) => count.get(n.id) === 2).sort((a, b) => (b.weight || 0) - (a.weight || 0))[0]
  assert.ok(target, '夹具里没有度 2 的节点,这条场景测不了')
  const sweep = (strip) => {
    let worst = 180; let at = 0
    for (let k = 0; k < 24; k += 1) {
      const a = (k * Math.PI * 2) / 24
      const x = W2 + Math.cos(a) * 220; const y = H2 + Math.sin(a) * 220
      const ns = nodes.map((n) => (n.id === target.id ? { ...n, x, y, fx: x, fy: y } : { ...n }))
      const { bundles, degree, degOf } = pageBundleAndDegree(edges)
      const out = pageForceRun({ d3, nodes: ns, bundles, degree, degOf, W, H, strip })
      const n = ns.find((q) => q.id === target.id)
      const nb = out.d3Links.filter((l) => l.source === n || l.target === n)
        .map((l) => (l.source === n ? l.target : l.source))
      const d = nb[1].y - n.y; const e = nb[1].x - n.x; const f = nb[0].y - n.y; const g = nb[0].x - n.x
      const deg = (Math.abs(Math.atan2(d, e) - Math.atan2(f, g)) * 180) / Math.PI
      const angle = Math.min(deg, 360 - deg)
      if (angle < worst) { worst = angle; at = k * 15 }
    }
    return { worst, at }
  }
  const on = sweep(false)
  const off = sweep(true)
  assert.ok(off.worst < 40, '对照组(拆掉夹角力)本该出现锐角,实测 ' + off.worst.toFixed(1) + '° —— 夹具没测到点上')
  assert.ok(on.worst >= 90,
    '钉住「' + (target.name || target.id) + '」绕一圈,最小夹角只有 ' + on.worst.toFixed(1) +
    '°(第 ' + on.at + '°) —— 他要的是"不要锐角",对照组是 ' + off.worst.toFixed(1) + '°')
  // 展开一次:把两次结果写进测试名里没意义,所以留个下限断言:比对照组好一大截
  assert.ok(on.worst > off.worst * 2.5, '夹角力只改善了一点点:' + off.worst.toFixed(1) + '° → ' + on.worst.toFixed(1) + '°')
})

test('★ 夹角力的判据本身:统一间隔的 60% 是下限', () => {
  const T = tuning()
  assert.equal(T.angleUniform(2), 180, '度 2 的理想间隔该是 180°')
  assert.equal(T.angleUniform(12), 30, '度 12 的理想间隔该是 30°')
  assert.equal(T.angleFloor(2), 108, '度 2 的下限该是 108°')
  assert.ok(Math.abs(T.angleFloor(12) - 18) < 1e-9, '度 12 的下限该是 18°')
  // 两线段最近距离:平行错开 80px → 80px;交叉 → 0;端点对端点 → 真实距离
  const n = (x, y) => ({ x, y })
  const par = T.closestSegments(n(0, 0), n(100, 0), n(0, 80), n(100, 80))
  assert.ok(Math.abs(par.d - 80) < 1e-9, '平行线距离算错了:' + par.d)
  assert.ok(Math.abs(Math.abs(par.dir.y) - 1) < 1e-9, '平行线的推开方向该垂直于线:' + JSON.stringify(par.dir))
  const cross = T.closestSegments(n(0, 0), n(100, 0), n(50, -50), n(50, 50))
  assert.ok(cross.d < 1e-9, '交叉的两条线距离该是 0:' + cross.d)
  const apart = T.closestSegments(n(0, 0), n(10, 0), n(30, 0), n(40, 0))
  assert.ok(Math.abs(apart.d - 20) < 1e-9, '共线错开该取端点距离:' + apart.d)
  const degenerate = T.closestSegments(n(5, 5), n(5, 5), n(5, 5), n(5, 5))
  assert.ok(degenerate.d === 0 && Number.isFinite(degenerate.dir.x) && Number.isFinite(degenerate.dir.y),
    '完全重合时该给 d=0 且方向不含 NaN(力的那边会跳过 d≈0,但 NaN 一旦漏进去就是整张图乱飞)')
})

test('★★ d3 从本地加载(答辩现场断网也要出图)', () => {
  const html = readFileSync(new URL('../web/graph.html', import.meta.url), 'utf8')
  assert.match(html, /<script src="\.\/vendor\/d3\.v7\.min\.js"><\/script>/, '页面没加载本地那份 d3')
  // CDN 只能是兜底:必须在本地之后,而且包在 typeof d3 === 'undefined' 里
  const localAt = html.indexOf('./vendor/d3.v7.min.js')
  const cdnAt = html.indexOf('https://d3js.org/d3.v7.min.js')
  assert.ok(cdnAt > localAt, 'CDN 兜底跑到了本地加载之前 —— 那就等于还是依赖 CDN')
  assert.match(html, /if \(typeof d3 === 'undefined'\)/, 'CDN 没有做"本地缺失才用"的判断')
  // 文件本体在(而且是个真 d3,不是空文件)
  const src = readFileSync(new URL('../web/vendor/d3.v7.min.js', import.meta.url), 'utf8')
  assert.ok(src.length > 200000, 'vendor 里的 d3 只有 ' + src.length + ' 字节,不像是真的')
  assert.match(src, /Mike Bostock/, '首行版权声明没了(d3 是 ISC 许可,得留着)')
  assert.ok(loadD3().forceSimulation, 'vendor 那份 d3 里没有 forceSimulation')
})
