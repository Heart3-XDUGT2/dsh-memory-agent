/**
 * 图谱布局的**真几何**检查(2026-09-26)。
 *
 * 上面那张表只证明"配方本身讲道理";这一份更进一步:按 d3-force 的同款公式写一个
 * **确定性**小仿真(固定种子),在活库那种星形结构上把**新旧两套配方各跑一遍**,
 * 然后量:圆之间还剩多少缝、强关系的两个节点隔多远。
 *
 * 跑出来才看清旧配方真正的问题(和我一开始猜的不一样,记在这儿免得下次又猜):
 * 旧版理想边长 = 120/权重*2 ⇒ **关系越强画得越挤** —— 权重 10 的边只剩 24px,
 * 而权重 1 的边摊到 240px;再加上圆半径 sqrt(w)*6(权重 10 → 19px),
 * 强关系的两个圆之间只剩几像素缝,字叠在一起,看着就是"一对紧挨着"。
 * 新配方把这层关系正过来:重=近,但近有地板(78px),弱=远,但远有上限(140px)。
 *
 * 这个仿真不是 d3 本身(积分细节是近似的),所以断言只用来区分量级差异:
 * "旧配方只剩 8px 缝" vs "新配方留出 30px+"。d3 只在浏览器里跑,我没有截图能力 ——
 * 不能靠"我觉得好看了"交差,至少把能算的算干净。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tuning, stripComments, graphHtml } from './_graph-tuning.mjs'

const T = tuning()
const code = stripComments(graphHtml)

/** 固定种子(不许用 Math.random —— 布局测试必须每次一样)。 */
function rng (seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 活库那种形状:度数 25 的枢纽 + 一堆叶子 + 一对各自度数 6 的强耦合节点。 */
function starGraph () {
  const nodes = [{ id: 'hub', weight: 10 }]
  for (let i = 0; i < 25; i += 1) nodes.push({ id: 'leaf' + i, weight: 1 + (i % 3) })
  nodes.push({ id: 'a', weight: 10 }, { id: 'b', weight: 9 })
  const links = []
  for (let i = 0; i < 25; i += 1) links.push({ source: 'hub', target: 'leaf' + i, weight: i === 0 ? 10 : 1 })
  for (let i = 0; i < 4; i += 1) links.push({ source: 'a', target: 'leaf' + i, weight: 3 })
  for (let i = 0; i < 4; i += 1) links.push({ source: 'b', target: 'leaf' + (i + 5), weight: 3 })
  links.push({ source: 'a', target: 'b', weight: 9 })
  return { nodes, links }
}

/**
 * d3-force 的同款配方(link / manyBody / collide / forceX / forceY + 速度衰减)。
 * 两套配方只差 opts,所以新旧对比是在同一套积分下做的。
 */
function miniSim (nodes, links, opts) {
  const { linkDistance, linkStrength, chargeOf, collideOf, centerPull, velocityDecay } = opts
  const collideIters = opts.collideIters || 2      // 页面里是 .iterations(2)
  const collideStrength = opts.collideStrength || 0.95
  const W = 1280, H = 760
  const rnd = rng(20260926)
  // d3 遇到"两个点坐标完全重合"会 jiggle 一下;这里也照做(确定性,不用 Math.random)
  let jiggleN = 0
  const jiggle = () => (rng(1000 + (jiggleN += 1))() - 0.5) * 0.01
  // 度数 = **真邻居数**(和页面一致):活库"用户"有 25 条边端点,真邻居 12 个。
  const neighbor = new Map()
  for (const l of links) {
    if (!neighbor.has(l.source)) neighbor.set(l.source, new Set())
    if (!neighbor.has(l.target)) neighbor.set(l.target, new Set())
    neighbor.get(l.source).add(l.target)
    neighbor.get(l.target).add(l.source)
  }
  const degree = new Map([...neighbor].map(([id, set]) => [id, set.size]))
  // 平行关系合并成一束(和页面一致):一对节点只留一根弹簧。
  // 活库里 用户—Echo 有 6 条平行关系 —— 每根都算一次的话刚度 ×6,显式积分直接发散。
  const bundleMap = new Map()
  for (const l of links) {
    const key = l.source < l.target ? l.source + '\u0000' + l.target : l.target + '\u0000' + l.source
    const cur = bundleMap.get(key)
    if (!cur) bundleMap.set(key, { source: l.source, target: l.target, weight: l.weight || 1, n: 1 })
    else { cur.n += 1; cur.weight = Math.max(cur.weight, l.weight || 1) }
  }
  const bundled = opts.noBundle ? links : [...bundleMap.values()]
  for (const n of nodes) {
    const ang = rnd() * Math.PI * 2
    const rad = Math.min(W, H) * (0.16 + rnd() * 0.24)
    n.x = W / 2 + Math.cos(ang) * rad
    n.y = (H + 60) / 2 + Math.sin(ang) * rad
    n.vx = 0; n.vy = 0
  }
  const nodeOf = new Map(nodes.map((n) => [n.id, n]))
  const STRENGTH = 1.35
  const ALPHA_MIN = 0.001, DECAY = 1 - Math.pow(0.001, 1 / 300)
  let alpha = 1
  for (let step = 0; step < 320; step += 1) {
    for (const l of bundled) {
      const s = nodeOf.get(l.source); const t = nodeOf.get(l.target)
      let dx = t.x - s.x; let dy = t.y - s.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-6
      const target = linkDistance(l.weight, degree.get(l.source) || 1, degree.get(l.target) || 1)
      const k = (d - target) / d * alpha * linkStrength(degree.get(l.source) || 1, degree.get(l.target) || 1)
      dx *= k * 0.5; dy *= k * 0.5
      t.vx -= dx; t.vy -= dy
      s.vx += dx; s.vy += dy
    }
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]; const b = nodes[j]
        let dx = b.x - a.x; let dy = b.y - a.y
        let d2 = dx * dx + dy * dy
        if (d2 > T.chargeMax * T.chargeMax) continue
        if (d2 < 1) d2 = 1
        const w = (chargeOf(degree.get(a.id) || 0) + chargeOf(degree.get(b.id) || 0)) * 0.5 * alpha / d2
        const d = Math.sqrt(d2)
        dx /= d; dy /= d
        a.vx += dx * w; a.vy += dy * w
        b.vx -= dx * w; b.vy -= dy * w
      }
    }
    // collide —— 照 d3-force v3 的 collide.js 逐行实现(读了源码才写对):
    // ① 用**预测位置** (x+vx);② 质量加权 rj²/(ri²+rj²);③ **不吃 alpha** ——
    // 它是位置级的硬约束,这正是 d3 布局最后不会有圆叠在一起的原因。
    // 我上一版给它乘了 alpha,于是自己的仿真在收尾阶段"叠"了,白追一轮。
    for (let k = 0; k < collideIters; k += 1) {
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i]
        const ri = collideOf(node.weight); const ri2 = ri * ri
        const xi = node.x + node.vx; const yi = node.y + node.vy
        for (let j = i + 1; j < nodes.length; j += 1) {
          const data = nodes[j]
          const rj0 = collideOf(data.weight); const r = ri + rj0
          let x = xi - data.x - data.vx
          let y = yi - data.y - data.vy
          let l = x * x + y * y
          if (l >= r * r) continue
          if (x === 0) { x = jiggle(); l += x * x }
          if (y === 0) { y = jiggle(); l += y * y }
          // 一步最多把两个圆推开"重叠量"那么多 —— d3 的 l=(r-d)/d 在 d→0 时会炸出
          // 天文数字的速度(我第一版被这个坑到:节点被甩到 5e8 px 外)。d3 靠四叉树
          // 加上实践中的初始分布躲过去;这里加上界,量的是配方,不是数值事故。
          l = Math.min((r - Math.sqrt(l)) / Math.sqrt(l) * collideStrength, r)
          x *= l; y *= l
          const rj2 = rj0 * rj0
          const w = rj2 / (ri2 + rj2)
          node.vx += x * w; node.vy += y * w
          data.vx -= x * (1 - w); data.vy -= y * (1 - w)
        }
      }
    }
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * centerPull * alpha * STRENGTH
      n.vy += ((H + 60) / 2 - n.y) * centerPull * alpha * STRENGTH
    }
    for (const n of nodes) {
      n.vx *= 1 - velocityDecay
      n.vy *= 1 - velocityDecay
      // 预跑的速度上限(页面里也是这么夹的):显式欧拉在刚度大时发散,
      // 夹住速度就只是"走得慢",而不是把节点甩出几亿像素。
      const v = Math.hypot(n.vx, n.vy)
      if (!opts.noClamp && v > T.maxStep) { const k = T.maxStep / v; n.vx *= k; n.vy *= k }
      n.x += n.vx
      n.y += n.vy
    }
    alpha += (ALPHA_MIN - alpha) * DECAY
  }
  return nodes
}

const NEW = {
  label: '新配方',
  linkDistance: (w, da, db) => T.linkDistance(w, da, db),
  linkStrength: (a, b) => T.linkStrength(a, b),
  chargeOf: (d) => T.chargeOf(d),
  collideOf: (w) => T.collideOf(w),
  radiusOf: (w) => T.radiusOf(w),
  centerPull: T.centerPull,
  velocityDecay: T.velocityDecay
}
/** 2026-09-26 之前的配方(全须全尾:边长/拉力/半径/碰撞/硬定心都照旧)。 */
const OLD = {
  label: '旧配方',
  linkDistance: (w) => 120 / Math.max(1, w) * 2,
  linkStrength: () => 0.4,
  chargeOf: () => -300,
  collideOf: (w) => Math.max(8, Math.sqrt(w || 1) * 6) + 4,
  radiusOf: (w) => Math.max(8, Math.sqrt(w || 1) * 6),
  centerPull: 0.12,          // 近似 forceCenter:硬把质心拽回画面中央
  velocityDecay: 0.4
}
/** 也把度数传给 linkDistance(新配方的"给邻居留地方"就靠它)。 */
const NEW_DEG = { ...NEW, linkDistance: (w, da, db) => T.linkDistance(w, da, db) }

/** 量:每对圆之间还剩多少缝(负数 = 圆已经叠上了)。 */
function minGap (nodes, opts) {
  let worst = Infinity
  let who = ''
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]; const b = nodes[j]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const gap = d - opts.radiusOf(a.weight) - opts.radiusOf(b.weight)
      if (gap < worst) { worst = gap; who = a.id + '↔' + b.id }
    }
  }
  return { gap: worst, who }
}
const distOf = (nodes, x, y) => {
  const a = nodes.find((n) => n.id === x); const b = nodes.find((n) => n.id === y)
  return Math.hypot(a.x - b.x, a.y - b.y)
}

test('★ 纯星形(枢纽 + 25 叶子):新配方留得出缝,旧配方只留几像素', () => {
  const gn = pureStar(); const on = pureStar()
  const nw = miniSim(gn.nodes, gn.links, NEW)
  const od = miniSim(on.nodes, on.links, OLD)
  const gNew = minGap(nw, NEW)
  const gOld = minGap(od, OLD)
  // collide 是位置级硬约束(d3 里不吃 alpha,我读了源码才发现),所以**圆不会真的叠**——
  // 旧配方的问题是"只剩 8px 缝":两个圆看着就是粘住的,名字必然压在一起。
  assert.ok(gNew.gap > 0, '新配方有圆叠着:' + gNew.who + ' ' + gNew.gap.toFixed(1) + 'px')
  assert.ok(gNew.gap > gOld.gap * 1.8, '新配方的缝(' + gNew.gap.toFixed(1) + 'px)没比旧配方(' + gOld.gap.toFixed(1) + 'px)大')
  assert.ok(gOld.gap < 16, '旧配方居然留了 ' + gOld.gap.toFixed(1) + 'px 缝 —— 反例不成立了')
  // 叶子到枢纽的距离要够站开(仿真量出来的:>=150px 才排得下 25 个邻居)
  const hub = nw.find((n) => n.id === 'hub')
  const ds = nw.filter((n) => n.id !== 'hub').map((n) => Math.hypot(n.x - hub.x, n.y - hub.y)).sort((a, b) => a - b)
  assert.ok(ds[0] > 150, '最近的叶子离枢纽只有 ' + ds[0].toFixed(0) + 'px,又挤成一团了')
})

/** 纯星形(枢纽 + 25 叶子,互不多连):活库那个度数 25 的枢纽就是这个形状。 */
function pureStar () {
  const nodes = [{ id: 'hub', weight: 10 }]
  for (let i = 0; i < 25; i += 1) nodes.push({ id: 'leaf' + i, weight: 1 + (i % 3) })
  const links = nodes.slice(1).map((n, i) => ({ source: 'hub', target: n.id, weight: i === 0 ? 10 : 1 }))
  return { nodes, links }
}

test('★ 对照:同一套积分下,旧配方把强关系的那一对粘住(缝 < 12px)', () => {
  const g = starGraph()
  const out = miniSim(g.nodes, g.links, OLD)
  const { gap, who } = minGap(out, OLD)
  assert.ok(gap < 12, '旧配方居然没粘住(' + gap.toFixed(1) + 'px,' + who + ')—— 那这个对照就说明不了问题')
  // 顺带把"关系越强画得越挤"钉成数字:旧版权重 10 的边只有 24px 目标长度,
  // 而权重 1 的边是 240px —— 强度与距离的关系是反的
  assert.ok(OLD.linkDistance(10) < 30 && OLD.linkDistance(1) > 200, '旧配方的反相关记错了')
  assert.ok(T.linkDistance(10) > OLD.linkDistance(10) * 3, '新配方没把重边拉开')
})

test('★ a↔b 那对强耦合节点:新配方留的缝明显大于旧配方(同一对节点,同一套积分)', () => {
  const gn = starGraph(); const on = starGraph()
  const nw = miniSim(gn.nodes, gn.links, NEW)
  const od = miniSim(on.nodes, on.links, OLD)
  const dn = distOf(nw, 'a', 'b'); const d0 = distOf(od, 'a', 'b')
  assert.ok(dn > d0 * 1.25, 'a↔b 间距:新 ' + dn.toFixed(0) + 'px vs 旧 ' + d0.toFixed(0) + 'px,没拉开')
  // 枢纽到它最重的那条叶子:只做同一套积分下的对照,不断言绝对长度 ——
  // 枢纽挂着 25 个叶子时,叶子之间的碰撞本来就会把它压得比"理想边长"短
  // (真实 d3 同样如此,这是物理,不是 bug)。
  const hn = distOf(nw, 'hub', 'leaf0'); const h0 = distOf(od, 'hub', 'leaf0')
  assert.ok(hn >= h0 * 0.9, '枢纽重边:新 ' + hn.toFixed(0) + 'px 比旧 ' + h0.toFixed(0) + 'px 还近得多')
})

test('★ 边长的强度关系是正的:强的近、弱的远,但两头都有界', () => {
  const strong = T.linkDistance(10)
  const weak = T.linkDistance(1)
  assert.ok(strong < weak, '强关系该更近')
  assert.ok(weak / strong < 2, '近远差距 ' + (weak / strong).toFixed(2) + ' 倍 —— 差距一大,弱边就把图拉散')
  assert.ok(strong >= 120 && weak <= 210, '地板/上限不对:' + strong + ' ~ ' + weak)
})

/** 活库快照夹具(2026-09-26 深夜:17 节点 / 28 边)。
 *  用真数据测,而不是只用我编的星形 —— 也免得测试依赖正在跑的服务器。 */
function liveFixture () {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/graph-live-2026-09-26.json', import.meta.url)), 'utf8'))
  return { nodes: raw.nodes.map((n) => ({ id: n.id, weight: n.weight })), links: raw.edges.map((e) => ({ source: e.source, target: e.target, weight: e.weight })) }
}

test('★ 我的近似积分器的边界:不给速度上界 + 不合并平行关系,它会发散', () => {
  // 注意这条**不是**在说"页面会炸图"。真 d3 那一份(见 graph-d3-live.test.js)
  // 实测不会炸 —— 09-26 深夜我差点拿自己积分器的发散当页面的病。
  // 这条留着是为了标明这个仪器能信到哪一步:它是近似的,所以只有 A/B 对比
  // 和量级才有意义,绝对的"会不会炸"必须问真 d3。
  const g = liveFixture()
  const pair = new Map()
  for (const l of g.links) {
    const k = l.source < l.target ? l.source + '\u0000' + l.target : l.target + '\u0000' + l.source
    pair.set(k, (pair.get(k) || 0) + 1)
  }
  const most = Math.max(...pair.values())
  assert.ok(most >= 5, '夹具里的平行关系不见了(最多 ' + most + ' 条)')
  const worst = miniSim(g.nodes, g.links, { ...NEW, noBundle: true, noClamp: true })
  const cx = 1280 / 2, cy = (760 + 60) / 2
  const farWorst = Math.max(...worst.map((n) => Math.hypot(n.x - cx, n.y - cy)))
  assert.ok(farWorst > 5000, '我的积分器这次没发散(最远 ' + farWorst.toFixed(0) + 'px)')
  const ok = miniSim(g.nodes, g.links, NEW)
  const okFar = Math.max(...ok.map((n) => Math.hypot(n.x - cx, n.y - cy)))
  assert.ok(okFar < 640, '合并 + 限速之后还该待在画布里,实际最远 ' + okFar.toFixed(0) + 'px')
})

test('★ 活库真图:排开、不叠、而且不许被撑成一片空地', () => {
  const g = liveFixture()
  assert.equal(g.nodes.length, 17, '夹具变了就把这条断言一起改')
  const out = miniSim(g.nodes, g.links, NEW)
  const { gap, who } = minGap(out, NEW)
  assert.ok(gap > 0, '活库图上有圆叠着:' + who + ' ' + gap.toFixed(1) + 'px')
  // 铺开程度:离画布中心最远的节点不能顶到边,也不能全缩在中心一小团
  const cx = 1280 / 2, cy = (760 + 60) / 2
  const far = Math.max(...out.map((n) => Math.hypot(n.x - cx, n.y - cy)))
  assert.ok(far < 640, '图被撑得太开(最远 ' + far.toFixed(0) + 'px,画布半宽 640)')
  assert.ok(far > 120, '图缩成一小团(最远只有 ' + far.toFixed(0) + 'px)')
  // 每条边都不许短到贴脸
  let minEdge = Infinity
  for (const l of g.links) {
    const s = out.find((n) => n.id === l.source); const t = out.find((n) => n.id === l.target)
    minEdge = Math.min(minEdge, Math.hypot(s.x - t.x, s.y - t.y))
  }
  assert.ok(minEdge > 60, '最短的边只有 ' + minEdge.toFixed(0) + 'px')
})

test('★ 活库真图:度数必须按"真邻居数"算,不是边端点(我 09-26 就是这里算错的)', () => {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/graph-live-2026-09-26.json', import.meta.url)), 'utf8'))
  const endpoints = new Map(); const neighbor = new Map()
  for (const e of raw.edges) {
    endpoints.set(e.source, (endpoints.get(e.source) || 0) + 1)
    endpoints.set(e.target, (endpoints.get(e.target) || 0) + 1)
    for (const [a, b] of [[e.source, e.target], [e.target, e.source]]) {
      if (!neighbor.has(a)) neighbor.set(a, new Set())
      neighbor.get(a).add(b)
    }
  }
  const hub = raw.nodes.find((n) => n.id === [...endpoints.entries()].sort((a, b) => b[1] - a[1])[0][0])
  const ep = endpoints.get(hub.id); const dn = neighbor.get(hub.id).size
  assert.ok(ep > dn + 5, '夹具里的枢纽应该有"很多重复关系"这个特征:' + ep + ' vs ' + dn)
  // 页面代码里必须建的是邻居集合,而不是给端点累加计数
  assert.match(code, /neighbor\.get\(b\.source\)\.add\(b\.target\)/, '页面没有按邻居集合算度数')
  assert.equal(/degree\.set\(b\.source/.test(code), false, '又在按边端点数目累计度数了')
  // 平行关系必须合并成一束:不合并时刚度会叠起来,活库图直接发散(见下一条)
  assert.match(code, /const bundleOf = new Map\(\)/, '页面没把平行关系合并成束')
  assert.match(code, /const d3Links = bundles\.map\(/, '物理用的还是原始边,不是束')
  assert.match(code, /n\.vx \*= k; n\.vy \*= k/, '预跑没有给速度上界(刚度大时会炸图)')
  // 度数确实进了边长公式:越忙的端点要越大的圆周(need 随 deg 线性长)。
  // 注意**活库那个枢纽(真邻居 12 个)其实用不上这一项** —— 圆变小之后
  // (半径 4.5~13px)12 个邻居在权重基线(约 190~200px)的圆周上就排得开,
  // 实测最小圆缝 55px。所以这里验的是"公式在需要时会起作用"(度数 25 时
  // need 超过基线),外加真实布局不重叠(由 d3-live 那组验),不是硬凑一个比例。
  const need = (deg) => T.roomFactor * deg * (T.radiusOf(4) + 14) / Math.PI
  assert.ok(need(25) > T.linkDistance(1, 1, 1), '度数 25 的圆周需求该盖过权重基线:' + need(25).toFixed(0) + ' vs ' + T.linkDistance(1, 1, 1).toFixed(0))
  assert.ok(need(dn) < T.linkDistance(1, 1, 1), '活库枢纽(12 个邻居)不该被度数项撑开:' + need(dn).toFixed(0))
  assert.ok(need(ep) > need(dn), '端点数(25)会算出更大的圆周 —— 这正是不能用它的原因:' + need(ep).toFixed(0) + ' vs ' + need(dn).toFixed(0))
  assert.ok(T.linkDistance(1, 25, 1) > T.linkDistance(1, dn, 1), '越忙的端点边长该越长')
})
