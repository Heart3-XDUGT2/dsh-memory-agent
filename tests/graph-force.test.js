/**
 * 记忆图谱的「受力」契约(2026-09-26)。
 *
 * 他说:「动态图谱太丑了…用户这个大圆圈在中间,然后一对紧挨着,这个受力也有问题」。
 * 病灶在源码里是四条,全部可测:
 *
 *   ① 理想边长 = `120 / Math.max(1, weight) * 2` ⇒ 权重 10 的边只有 **24px**,
 *      两个半径 19px 的圆等于贴在一起 —— 这就是"一对紧挨着"。
 *   ② 拉力恒 `.strength(.4)` ⇒ 活库里那个度数 25 的枢纽(28 条边占 25 条)
 *      净吸力 10.0,把所有人吸进圆心 —— 这就是"大圆圈在中间"。
 *   ③ 半径 `sqrt(w) * 6` 无上界(10 → 19px),碰撞半径只 +4 ⇒ 19px 的圆加
 *      画在下方 14px 的节点名,必然叠字。
 *   ④ `forceCenter` 把质心硬钉在画面正中(它不是力,是位移)⇒ 结构被压平。
 *
 * 这里不改 d3(浏览器里才跑),而是把 `GRAPH_TUNING` 这张**纯函数表**抠出来
 * 在 Node 里算性质 —— 于是"重边又贴脸了""枢纽又变大了"会在 CI 里先红,
 * 而不是等阿岚再打开页面骂我一次。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const html = readFileSync(fileURLToPath(new URL('../web/graph.html', import.meta.url)), 'utf8')

/** 去掉注释再扫源码:注释里会引用旧写法(比如"旧版是 forceCenter"),不能误判成代码。 */
function stripComments (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"])\/\/[^\n]*$/gm, '$1')
}

/** 抠出 `const <name> = { ... }`(大括号配平),返回真对象。 */
function literalOf (name) {
  const start = html.indexOf('const ' + name + ' = {')
  assert.ok(start > 0, '找不到 ' + name + '(改名了就把这条测试也改掉)')
  const open = html.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < html.length; i += 1) {
    const c = html[i]
    if (c === '{') depth += 1
    else if (c === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
  }
  assert.ok(end > 0, name + ' 的大括号不配平')
  return new Function('return (' + html.slice(open, end) + ')')()
}

/** 抠出 `const GRAPH_TUNING = { ... }`(大括号配平),返回真对象。 */
function tuning () {
  const start = html.indexOf('const GRAPH_TUNING = {')
  assert.ok(start > 0, '找不到 GRAPH_TUNING(改名了就把这条测试也改掉)')
  const open = html.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < html.length; i += 1) {
    const c = html[i]
    if (c === '{') depth += 1
    else if (c === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
  }
  assert.ok(end > 0, 'GRAPH_TUNING 的大括号不配平')
  const literal = html.slice(open, end)
  return new Function('return (' + literal + ')')()
}

const T = tuning()
const code = stripComments(html)

test('① 重边不再贴脸:理想边长随权重下降但有地板(旧版 120/w*2 ⇒ 24px)', () => {
  const old = (w) => 120 / Math.max(1, w) * 2
  assert.ok(T.linkDistance(10) > 90, '权重 10 的边长只有 ' + T.linkDistance(10) + 'px,又会贴脸')
  assert.ok(T.linkDistance(10) > old(10) * 3, '比旧配方好得不够:旧 ' + old(10) + 'px')
  assert.ok(T.linkDistance(1) > T.linkDistance(10), '越重该越近,这条序关系不能反')
  for (const w of [1, 1.5, 3, 4, 9, 10]) {
    assert.ok(T.linkDistance(w) >= 100, '权重 ' + w + ' 的边长 ' + T.linkDistance(w).toFixed(0) + ' < 地板(105px)')
    assert.ok(T.linkDistance(w) <= T.distMax, '权重 ' + w + ' 的边长超过了上限')
  }
  // 权重 0 / 负数 / NaN 一律按最小权重算,不许出现 NaN 边长(那会让 d3 把点甩到无穷远)
  for (const bad of [0, -3, NaN, undefined, null, 'x']) {
    assert.ok(Number.isFinite(T.linkDistance(bad)), '非法权重 ' + String(bad) + ' 算出了非有限值')
  }
})

test('①b 枢纽的邻居要有地方站:边长得看邻居数(仿真发现:光靠地板还是会叠)', () => {
  // 度数 12 的枢纽(活库"用户"):邻居要沿圆周排开 ⇒ R ≥ deg×(邻居半径+标签余量)/π
  const hub = T.linkDistance(1, 12, 1)
  assert.ok(hub > 185, '度数 12 的枢纽边长只有 ' + hub.toFixed(0) + 'px,排不下 12 个邻居')
  assert.ok(hub <= T.distMax, '边长超过上限了')
  // 普通叶子对叶子不受影响(走权重基线:105 + 78×0.9 = 175.2px)
  assert.ok(T.linkDistance(1, 1, 1) >= 195 && T.linkDistance(1, 1, 1) < 210, '度数 1 的对子该拿到权重基线(约 201px),实际 ' + T.linkDistance(1, 1, 1))
  // 度数 3 和 12 都落在权重基线上(圆周够用),所以它俩相等;要看出度数项起作用得给 25
  assert.equal(T.linkDistance(1, 3, 1), T.linkDistance(1, 12, 1), '低度数不该被撑开')
  assert.ok(T.linkDistance(1, 3, 1) < T.linkDistance(1, 25, 1), '越忙的端点该拉得越开')
  assert.ok(T.linkDistance(9, 6, 6) >= 95, '一对度数 6 的强关系仍然要有基线长度')
  assert.ok(Number.isFinite(T.linkDistance(10, undefined, NaN)), '度数缺失时不许算出 NaN')
})

test('② 一对高连接度节点不再互相猛拽:拉力按两端度数的较小值归一', () => {
  // 星形必须撑住:叶子连枢纽仍是满力(归一到 0 会散成一盘沙)
  assert.equal(T.linkStrength(25, 1), 1, '叶子到枢纽的拉力不该被削弱')
  // 但两个各自连着很多东西的节点之间,谁也不该猛拽谁(这就是"一对紧挨着"的成因之一)
  const pair = T.linkStrength(6, 6)
  assert.ok(Math.abs(pair - 1 / 6) < 1e-9, '两个度 6 的节点之间该是 1/6,实际 ' + pair)
  assert.ok(pair < 0.4, '旧的恒 0.4 拉力还在起作用:' + pair)
  assert.ok(T.linkStrength(6, 6) < T.linkStrength(2, 2), '度数越高,两端的拉力该越弱')
  assert.ok(T.linkStrength(2, 2) < T.linkStrength(1, 1), '同上,单调性')
  // 上界:两端取小值,不能因为对方度数大就把自己拉过去
  assert.equal(T.linkStrength(25, 6), T.linkStrength(6, 25), '交换两端必须对称')
  assert.equal(T.linkStrength(25, 6), 1 / 6, '该被较小的度数(6)封顶')
  assert.ok(T.linkStrength(99, 99) >= 0.06 - 1e-9, '拉力有地板,不能被压到 0')
  for (const bad of [0, -3, NaN, undefined, null]) {
    assert.ok(Number.isFinite(T.linkStrength(bad, bad)), '非法度数 ' + String(bad) + ' 算出了非有限值')
  }
})

test('③ 节点是"点"不是"圆盘":半径 4.5~13px(参考实现 4~20px、多数 5.5~10px)', () => {
  const old = (w) => Math.max(8, Math.sqrt(w) * 6)
  // 2026-09-26 深夜第五次"丑"之后,照 contextual-neural-map 的节点尺寸重做:
  // 那个实现里几乎所有节点都是 5.5~10px 的点,图看着像星座;我前几版 11~23px 的
  // 大实心圆正是"积木感"的主因。现在权重 31 的枢纽也只有 13px。
  assert.ok(T.radiusOf(31) <= 15, '权重 31 的圆太大(又回到圆盘):' + T.radiusOf(31))
  assert.ok(T.radiusOf(31) >= 11, '权重最大的节点太小了(看不到层次):' + T.radiusOf(31))
  assert.ok(T.radiusOf(1) >= 4 && T.radiusOf(1) <= 8, '最小节点该是 5px 量级的点:' + T.radiusOf(1))
  assert.ok(T.radiusOf(31) < old(31), '还是要比旧配方小:' + T.radiusOf(31) + ' vs ' + old(31).toFixed(1))
  assert.ok(T.radiusOf(10) / T.radiusOf(1) < 2.1, '大小差距太夸张(枢纽会显得像个球):' + (T.radiusOf(10) / T.radiusOf(1)).toFixed(2))
  assert.ok(T.radiusOf(10) > T.radiusOf(3) && T.radiusOf(3) > T.radiusOf(1), '半径该随权重单调')
  for (const w of [1, 3, 10]) {
    const room = T.collideOf(w) - T.radiusOf(w)
    assert.ok(room >= 12, '权重 ' + w + ' 的碰撞只留了 ' + room + 'px,节点名(画在下方 12px)会叠字')
  }
  assert.ok(T.chargeOf(25) < T.chargeOf(0), '枢纽该被推得更开,而不是和叶子一个斥力')
  assert.ok(T.chargeOf(0) < 0 && Number.isFinite(T.chargeOf(25)), '斥力必须是负数且有限')
})

test('③b 边是发丝线:0.6~1.5px(参考实现 0.5/1.2/1.8px —— 好看的图里线几乎看不见)', () => {
  const widths = [1, 4, 10]
  const w = widths.map((x) => T.linkWidth(x, 100))   // 100 = 清醒,才走"正常线宽"那条路
  assert.ok(w[0] >= 0.4, '最细的线看不见了:' + w[0])
  assert.ok(w[2] <= 1.6, '线又变粗了(参考实现最粗 1.8px):' + w[2])
  assert.ok(w[2] / w[0] < 3.4, '粗细动态范围还是过大:' + (w[2] / w[0]).toFixed(2))
  assert.ok(w[2] > w[1] && w[1] > w[0], '线宽该随权重单调(粗细仍然表达强度)')
  assert.match(code, /const linkWidth = \(d\) =>/, 'linkWidth 没抽成函数,纯函数表测不到')
})

test('④ 图真的用上了这张表(不是写在文件里好看)', () => {
  assert.match(code, /\.distance\(\(d\) => T\.linkDistance\(d\.weight, linkDeg\(d\)\[0\], linkDeg\(d\)\[1\], T\.seedOf\(d\.key\)\)\)/, '没接上 linkDistance(或没把度数/微扰种子传进去)')
  assert.match(code, /\.strength\(\(d\) => T\.linkStrength\(/, '没接上 linkStrength')
  assert.match(code, /T\.chargeOf\(degOf\(d\)\)/, '没接上 chargeOf(斥力还按度数算)')
  assert.match(code, /T\.collideOf\(d\.weight\)/, '没接上 collideOf')
  assert.match(code, /forceX\(/, '缺了向心 X 力')
  assert.match(code, /forceY\(/, '缺了向心 Y 力')
  assert.equal(/\.force\('center'/.test(code), false, '还有 forceCenter —— 它是位移不是力,会把结构压平')
  assert.equal(/120 \/ Math\.max\(1, d\.weight/.test(code), false, '旧的 120/权重 配方还在')
  assert.equal(/Math\.sqrt\(d\.weight \|\| 1\) \* 6/.test(code), false, '旧的半径配方还在')
  // 度数表必须真的建了(没有它,linkStrength 拿到的是 undefined),
  // 而且必须是**真邻居数** —— 按边端点累计会把枢纽的度数算成 25(实际 12),
  // 边长算成 300px,17 个节点被撑成一片空地。
  assert.match(code, /const degree = new Map\(\)/, '没有建度数表')
  assert.match(code, /for \(const \[id, set\] of neighbor\) degree\.set\(id, set\.size\)/, '度数表没按邻居集合算')
  assert.equal(/degree\.set\([a-z]\.source, \(degree\.get/.test(code), false, '又在按边端点累加度数了')
})

test('⑤ 布局定下来就不许再抖:预跑后自己画一次,不靠 restart 慢慢飘', () => {
  assert.match(code, /simulation\.on\('tick', applyPositions\)/, '没有把绘制抽成 applyPositions')
  assert.match(code, /\n  applyPositions\(\)\n/, '预跑之后没有立刻画一次(旧版靠 alpha(.3).restart 抖到位)')
  assert.equal(/simulation\.alpha\(\.3\)\.restart\(\)/.test(code), false, '又让它自己抖起来了')
})

test('⑥ 空图之后底纹与滤镜还在(旧版 selectAll("*").remove() 会连 defs 一起清掉)', () => {
  assert.equal(/svg\.selectAll\('\*'\)\.remove\(\)/.test(code), false, '又把 defs 一起清了')
  for (const id of ['dots', 'bg-grad', 'glow']) {
    assert.ok(html.includes('id="' + id + '"'), 'defs 里少了 #' + id)
  }
  // 方向由"线中段的流向标"表达(不是 marker-end):只给权重 ≥3 的边,否则成了刺猬
  assert.match(code, /filter\(\(d\) => \(d\.weight \|\| 1\) >= 3\)/, '流向标的权重条件丢了')
})

test('⑦ 标签有策略:默认全显名字,「重要的」只留权重 ≥6,「关」一个不留', () => {
  assert.match(code, /let labelMode = 0/, '缺少标签模式开关')
  assert.match(code, /function cycleLabels \(\)/, '缺少切换函数')
  assert.match(html, /id="label-btn"/, '工具条上没有标签按钮')
  assert.match(code, /labelVisible = \(d\) => T\.labelFor\(/, '可见性没接到纯函数上')
  assert.match(code, /applyLabels\(\)/, '没有在缩放/悬停后重算标签')
  // 默认必须是「全部」:名字就是这个页面的内容。09-26 那版默认只显权重 ≥6 的,
  // 17 个节点里只有 3 个有名字,其余全是没名字的圆点 —— 他看着就是"丑"。
  assert.match(code, /const LABEL_MODES = \['全部', '重要的', '关'\]/, '模式名不对')
  const live = JSON.parse(readFileSync(new URL('./fixtures/graph-live-2026-09-26.json', import.meta.url), 'utf8'))
  const named = live.nodes.filter((n) => T.labelFor(n.weight, 0, 1)).length
  assert.ok(named >= live.nodes.length - 1, '默认模式只显示了 ' + named + '/' + live.nodes.length + ' 个名字 —— 又变回没名字的圆点了')
  // 行为矩阵
  assert.equal(T.labelFor(10, 0, 1), true, '「全部」:权重 1 也要显')
  assert.equal(T.labelFor(1, 0, 1), true, '「全部」:最小的权重 1 也要显')
  assert.equal(T.labelFor(10, 1, 1), true, '「重要的」:权重 10 该显')
  assert.equal(T.labelFor(2, 1, 1), false, '「重要的」:权重 2 该藏着')
  assert.equal(T.labelFor(1, 1, 3), false, '「重要的」:放多大都不显低权重')
  assert.equal(T.labelFor(10, 2, 3), false, '「关」该一个都不显示')
  assert.equal(T.labelFor(undefined, 0, 1), false, '权重缺失时不许炸,也不该显')
})

test('⑧ 不再是"垃圾积木":弧线 + 底色光环 + 中段流向标', () => {
  // 他第五次的原话:「就是非常简单的那种几何图形硬拼凑在一起,垃圾积木」。
  // 三件事造成那个观感,对应三处修改:
  //   ① 棍子顶珠子、接口硬断口  →  弧线画到圆心 + 节点一圈背景色光环把线切断
  //   ② 实心三角胶在棍子末端    →  细拐(chevron)挂在线中段,顺着切线转
  //   ③ 大小一律                →  字号/字重按权重分级(见 applyLabels 的断言)
  assert.match(code, /\.enter\(\)\.append\('path'\)\.attr\('class', 'link'\)/, '连线不是 path(弧线画不出来)')
  assert.match(code, /attr\('d', pathOf\)/, '连线没吃弧线路径')
  assert.match(code, /const pathOf = \(d\) => T\.arcPath\(d\.source, d\.target, kOf\(d\)\)/, '弧线没走 arcPath')
  assert.match(code, /T\.curveOf\(d\.key\)/, '曲率没按边的 key 算(相邻的边会往同一侧弯,糊成一坨)')
  // 光环:漏了它,线就会插进圆里,还是"硬断口"
  assert.match(code, /append\('circle'\)\.attr\('class', 'node-halo'\)/, '节点没有底色光环')
  assert.match(html, /\.node-halo\{fill:var\(--bg\)\}/, '光环不是背景色,切不断线')
  // 流向标:不再是贴上去的三角,而是挂在线中段的拐
  assert.equal(/marker-end/.test(html), false, '还有 marker-end —— 又回到"末端胶三角"了')
  assert.equal(/<marker id=/.test(html), false, 'marker 定义该删掉了(没有引用)')
  assert.match(code, /\.attr\('class', 'link-arrow'\)/, '没有流向标图层')
  assert.match(code, /'M-3,-2\.3 L2\.2,0 L-3,2\.3'/, '流向标的形状变了')
  assert.match(code, /const p = T\.arcPoint\(d\.source, d\.target, kOf\(d\), \.62\)/, '流向标没挂在线中段')
  assert.match(code, /rotate\(' \+ T\.arcAngle\(d\.source, d\.target, kOf\(d\), \.62\)/, '流向标没顺着切线转')
  assert.match(code, /\.data\(d3Links\.filter\(\(d\) => \(d\.weight \|\| 1\) >= 3\)\)/, '流向标该只给权重 ≥3 的边')
  // 悬停联动:指向某个节点/某条边时,相关流向标要亮起来
  assert.match(code, /selectAll\('\.link-arrow'\)\.transition\(\)\.duration\(160\)\.style\('opacity', \(l\) => \(l\.source\.id === d\.id \|\| l\.target\.id === d\.id\) \? 1 : \.05\)/, '悬停节点时流向标没联动')
  assert.match(code, /selectAll\('\.link-arrow'\)\.transition\(\)\.duration\(200\)\.style\('opacity', \(l\) => l === d \? 1 : \.12\)/, '悬停边时流向标没联动')
  // 字号分级:枢纽的名字得比叶子大一号
  assert.match(code, /\.style\('font-size', \(d\) => \(\(d\.weight \|\| 1\) >= 6 \? '13px'/, '标签字号没分级')
  // 投影由参考实现的结论改成"只给该强调的节点"(全挂就变成一串珠子),所以这里查的是
  // 全局不再挂投影 + 稿纸主题挂的是铅笔抖动(见 ⑧e)
  assert.equal(/^\.node\{filter:drop-shadow/m.test(html), false, '又给所有节点挂投影了(会变成一串珠子)')
})

test('⑧bis 弧线的纯函数:端点精确、弯在弦外、切线跟着弯', () => {
  const a = { x: 0, y: 0 }; const b = { x: 100, y: 0 }
  // 端点必须精确落在两端 —— 差一点线头就会离开圆心(现在是靠光环切断,不是靠缩端点)
  const p0 = T.arcPoint(a, b, 0.2, 0); const p1 = T.arcPoint(a, b, 0.2, 1)
  assert.ok(Math.hypot(p0.x - a.x, p0.y - a.y) < 1e-9, '起点不在 a 上')
  assert.ok(Math.hypot(p1.x - b.x, p1.y - b.y) < 1e-9, '终点不在 b 上')
  assert.match(T.arcPath(a, b, 0.2), /^M0,0Q/, '路径不是二次贝塞尔:')
  assert.match(T.arcPath(a, b, 0.2), /100,0$/, '路径终点不是 b')
  // 中点该离开弦(垂直方向),且方向随 k 的正负翻转
  const mid = T.arcPoint(a, b, 0.2, 0.5)
  assert.ok(Math.abs(mid.y) > 1, '弧线没弯(中点还在弦上):' + mid.y)
  assert.ok(T.arcPoint(a, b, -0.2, 0.5).y < 0 && mid.y > 0, 'k 的符号没控制弯曲方向')
  // 直线情形:k=0 时中点就在弦上
  assert.ok(Math.abs(T.arcPoint(a, b, 0, 0.5).y) < 1e-9, 'k=0 该是直线')
  // 切线:流向标挂 t=.62 而不是 .5 —— 二次贝塞尔在 t=.5 处的切线**永远平行于弦**
  // (B'(.5) = P1-P0,跟控制点无关,这个坑是量出来才发现的),所以那里转不转都一样。
  const straight = T.arcAngle({ x: 0, y: 0 }, { x: 100, y: 0 }, 0, 0.62)
  const curved = T.arcAngle(a, b, 0.3, 0.62)
  assert.ok(Math.abs(straight) < 1e-9, '直线情形切线该是 0°')
  assert.ok(Math.abs(curved) > 3, '弧线 t=.62 的切线几乎和平行弦一样(' + curved.toFixed(1) + '°),流向标看着是贴歪的')
  assert.ok(T.arcAngle(a, b, -0.3, 0.62) * curved < 0, 'k 反号时切线该往另一侧偏')
  // 曲率幅度有界:相邻的边不能弯成乱麻
  for (const seed of [0, 1, 7, 42, 98765]) {
    const k = T.curveOf('a|b' + seed)
    assert.ok(Math.abs(k) <= 0.2, '曲率太大:' + k)
    assert.equal(T.curveOf('a|b' + seed), k, '同一条边每次的曲率必须一样')
  }
  // 一侧一条:活库里 15 条束的曲率该有正有负(全同号 = 全往一边弯)
  const pos = []; const neg = []
  for (let i = 0; i < 40; i += 1) { (T.curveOf('k' + i) > 0 ? pos : neg).push(i) }
  assert.ok(pos.length >= 10 && neg.length >= 10, '曲率符号分布太偏:' + pos.length + '/' + neg.length)
})

test('⑧b 边色:亮底那套必须低饱和(参考实现整张图只用灰棕,不用饱和色)', () => {
  // 参考实现:contextual-neural-map 的边色 #cdc6bb / #a09888 / #8a8279 —— 三档全是灰棕。
  // 我把"状态色"保留成三档(清醒/模糊/遗忘),但**亮底那套降到灰棕**,深底那套才用亮色。
  assert.match(code, /const EDGE_PALETTES = \{/, '缺少边色表 —— 状态色又写死在 edgeColor 里了')
  const paper = literalOf('EDGE_PALETTES').paper
  const dark = literalOf('EDGE_PALETTES').obsidian
  const sat = (rgb) => (Math.max(...rgb) - Math.min(...rgb)) / Math.max(...rgb)
  for (const k of ['ok', 'warn', 'bad']) {
    assert.ok(sat(paper[k]) <= 0.55, '稿纸主题的边色太艳了(' + k + ' ' + paper[k] + '):饱和度 ' + sat(paper[k]).toFixed(2))
    assert.ok(sat(dark[k]) >= 0.5, '深空主题的边色该是有彩度的(' + k + '):饱和度 ' + sat(dark[k]).toFixed(2))
  }
  // 边色、流向标色、图例都得跟着主题换 —— 不能只有一半跟着变
  assert.match(code, /const p = EDGE_PALETTES\[themeMode\] \|\| EDGE_PALETTES\.paper/, 'edgeColor 没按主题取色')
  assert.match(code, /TYPE_COLORS = TYPE_PALETTES\[themeMode\]/, '类型色没按主题换')
  assert.match(code, /dot\.style\.background = TYPE_COLORS\[t\]/, '图例色点没跟着主题换')
  // 状态靠虚线区分(参考实现用 5,4 / 8,3 区分关系类型):清醒实线 / 模糊 6,5 / 遗忘 2.5,3.5
  assert.match(code, /if \(a >= 30\) return null\n      return a > 0 \? '6,5' : '2\.5,3\.5'/, '虚线档位丢了')
})

test('⑧d 节点靠形状分类型(参考实现:实心/空心/虚线/环 四种画法)', () => {
  assert.match(code, /const shapeOf = \(d\) =>/, '缺少按类型取形状的函数')
  for (const t of ['person', 'habit', 'preference', 'event']) {
    assert.ok(code.indexOf("t === '" + t + "'") > 0, '缺少 ' + t + ' 的画法')
  }
  // 五类必须真的画得不一样(不能五类同一种)
  const shapes = code.match(/return \{ fill: [^\n]+/g) || []
  assert.ok(shapes.length >= 4, '形状分支太少:' + shapes.length)
  assert.ok(code.indexOf("fill: 'none'") > 0, '没有"空心"那一类')
  assert.ok(code.indexOf("dash: '3,2'") > 0, '没有"虚线描边"那一类')
  assert.ok(code.indexOf('fillOpacity: .55') > 0, '概念节点该是半透明实心(退到后面去)')
  // 形状要真的接到圆上,不是写了不用
  for (const attr of ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray']) {
    assert.ok(code.indexOf(".attr('" + attr + "', (d) => shapeOf(d)") > 0, attr + ' 没接 shapeOf')
  }
})

test('⑧e 稿纸主题:纸感底纹 + 铅笔抖动(照抄参考实现的数值)', () => {
  // 细格:两层 repeating-linear-gradient,28/29px,透明度 .07/.05
  assert.match(html, /repeating-linear-gradient\(0deg,transparent,transparent 28px,rgba\(180,170,155,\.07\)/, '缺横向细格')
  assert.match(html, /repeating-linear-gradient\(90deg,transparent,transparent 28px,rgba\(180,170,155,\.05\)/, '缺纵向细格')
  // 噪点:feTurbulence 生成的 data-URI,透明度 .03
  assert.match(html, /stitchTiles='stitch'/, '缺纸面噪点')
  assert.match(html, /--grain-op:\.03/, '噪点透明度该是 .03')
  // 铅笔抖动:两个滤镜,baseFrequency .03/.04、scale 2.2/2.6
  assert.match(html, /id="pencil"[\s\S]{0,400}baseFrequency="0\.03"[\s\S]{0,200}scale="2\.2"/, '缺 pencil 抖动滤镜')
  assert.match(html, /id="sketchLine"[\s\S]{0,400}baseFrequency="0\.04"[\s\S]{0,200}scale="2\.6"/, '缺 sketchLine 抖动滤镜')
  // 只在稿纸主题挂(深底细线挂抖动会糊)
  assert.match(html, /\[data-theme="paper"\] \.link\{stroke-linecap:round;filter:url\(#sketchLine\)\}/, '稿纸主题的线没挂抖动')
  assert.match(html, /\[data-theme="paper"\] \.node\{filter:url\(#pencil\)\}/, '稿纸主题的节点没挂抖动')
  // 标签默认是"暗"的(参考实现 opacity .55):默认就抢眼的话,图还是一团字
  assert.match(html, /\.node-label\{font-size:10\.5px;opacity:\.62/, '标签默认不透明度不对')
  assert.match(code, /\.style\('opacity', \(d\) => \(\(d\.weight \|\| 1\) >= 6 \? 1 : \(d\.weight \|\| 1\) >= 3 \? \.78 : \.62\)\)/, '标签没有分级不透明度')
})

test('⑧c 布局不许是"蒲公英":边长带确定性微扰,邻居不再排成完美等距圆环', () => {
  // 他截图里那个形状:12 个邻居全部等距射向中心,像蒲公英。根因是目标距离完全相同。
  const a = T.linkDistance(1, 12, 1, 0)
  const b = T.linkDistance(1, 12, 1, 1)
  const c = T.linkDistance(1, 12, 1, 999)
  assert.notEqual(a, b, '不同种子算出了同样的距离 —— 微扰没接上')
  assert.notEqual(b, c, '不同种子算出了同样的距离')
  assert.equal(T.linkDistance(1, 12, 1, 7), T.linkDistance(1, 12, 1, 7), '同一个种子必须永远同一个值(布局要可复现)')
  assert.equal(T.linkDistance(1, 12, 1), T.linkDistance(1, 12, 1, undefined), '不传种子时不加微扰')
  const plain = T.linkDistance(1, 12, 1)
  for (const seed of [0, 1, 7, 42, 100000, 99999]) {
    const v = T.linkDistance(1, 12, 1, seed)
    assert.ok(v > plain * 0.85 && v < plain * 1.15, '微扰幅度超过 ±15%:' + v.toFixed(1) + ' vs ' + plain.toFixed(1))
  }
  // 一堆种子的离散程度要够(不然等于没抖)
  const vs = []
  for (let s = 1; s <= 40; s += 1) vs.push(T.linkDistance(1, 12, 1, s))
  const m = vs.reduce((x, y) => x + y, 0) / vs.length
  const sd = Math.sqrt(vs.reduce((x, y) => x + (y - m) ** 2, 0) / vs.length)
  assert.ok(sd / m > 0.06, '微扰太小,还是圆环:' + (sd / m).toFixed(3))
  assert.match(code, /T\.linkDistance\(d\.weight, linkDeg\(d\)\[0\], linkDeg\(d\)\[1\], T\.seedOf\(d\.key\)\)/, '页面没把种子传进去')
  assert.match(code, /hash01 \(seed\)/, '缺少确定性哈希')
  assert.match(code, /seedOf \(key\)/, '缺少 key → 种子的换算')
  assert.equal(/Math\.random\(\)[\s\S]{0,40}distance/.test(code), false, '别用 Math.random 抖距离(布局不可复现,电池钉不住)')
})

test('⑨ 统计栏不许自相矛盾:关系条数 vs 画布上真画出来的连线数', () => {
  // 他说的另一个:统计栏写"边 28",画布上只有 15 根线(平行关系已合并)
  assert.match(html, /id="sl">0<\/span>/, '统计栏缺"连线"这一项')
  assert.match(code, /\$\('sl'\)\.textContent = bundles\.length/, '"连线"没接到合并后的束数上')
  assert.match(code, /\$\('sl'\)\.textContent = '0'/, '空图时"连线"没清零')
  assert.match(code, /id="se">0<\/span>/, '"关系"那一项别删(关系条数还是要知道)')
})

test('⑩ 三套配色可切换(他说了三次丑,索性让他点一下挑)', () => {
  assert.match(html, /id="theme-btn"/, '工具条上没有配色按钮')
  assert.match(code, /const THEMES = \['paper', 'obsidian', 'focus'\]/, '主题表不对(默认该是稿纸)')
  assert.match(code, /function applyTheme \(\)/, '缺少应用主题的函数')
  assert.match(code, /document\.documentElement\.setAttribute\('data-theme', themeMode\)/, '主题没写到 html 上')
  assert.match(code, /localStorage\.setItem\('echo-graph-theme'/, '选的配色没记下来')
  assert.match(code, /localStorage\.getItem\('echo-graph-theme'\)/, '没读回上次选的配色')
  assert.match(code, /applyTheme\(\)\n  applyMotion\(\)\n  await poll\(\)/, 'boot 时没应用主题或动效档')
  assert.match(code, /b\.textContent = '配色:' \+ THEME_LABELS\[themeMode\]/, '按钮文字没跟着变')
  // 三套的变量表都得在(CSS 里)
  for (const t of ['paper', 'obsidian', 'focus']) {
    assert.ok(html.indexOf('data-theme="' + t + '"') >= 0 || html.indexOf('[data-theme="' + t + '"]') >= 0, 'CSS 里缺 ' + t + ' 这套')
  }
  assert.match(html, /--dots-op:0; --vignette-op:0/, '亮底那套该把点阵底纹关掉')
  // 面板底色必须走变量,否则换主题时工具条/图例不会跟着变
  for (const v of ['--bar-bg', '--card-bg', '--legend-bg', '--shadow']) {
    assert.ok(html.indexOf('var(' + v + ')') >= 0, v + ' 没被用上')
  }
})

test('⑪ 窗口变大变小要重排(旧版没有 resize,图会歪在一边)', () => {
  assert.match(code, /window\.addEventListener\('resize'/, '没有监听 resize')
  assert.match(code, /rt = setTimeout\(\(\) => render\(\), 220\)/, 'resize 后没重排(或没防抖)')
  assert.match(code, /clearTimeout\(rt\)/, 'resize 没防抖,拖窗口会疯狂重排')
})

test('⑫ 动效:流动的方向 = 关系方向,速度 = 权重,只有新记忆入场 + 三档开关', () => {
  // 他:"能让它动起来就好了"。动效不许是纯装饰,三样都得带含义、且能关。
  // ① 线上流动:同一条弧上叠一条跑动的虚线,方向 source→target(所以方向不用箭头猜)
  assert.match(code, /const linkFlow = g\.selectAll\('\.link-flow'\)/, '缺流动层')
  assert.match(code, /linkFlow\.attr\('d', pathOf\)/, '流动层没跟着布局走(会停在原地)')
  assert.match(code, /\.style\('--dur', \(d\) => T\.flowDuration\(d\.weight\) \+ 's'\)/, '流速没跟权重挂钩')
  assert.match(html, /@keyframes flow\{from\{stroke-dashoffset:0\}to\{stroke-dashoffset:-28\}\}/, 'flow 关键帧不对(移动量必须等于 dash 周期 2+26,否则会跳)')
  assert.match(html, /\.link-flow\{[^}]*stroke-dasharray:2 26/, '流动虚线的周期不对')
  assert.match(html, /\.link-flow\{[^}]*pointer-events:none/, '流动层挡了点击(点线展依据会失效)')
  // 权重越大越快(3.4s → 1.6s),且有界
  assert.ok(T.flowDuration(10) < T.flowDuration(1), '强关系的流动该更快:' + T.flowDuration(10) + ' vs ' + T.flowDuration(1))
  assert.ok(T.flowDuration(10) >= 1.4 && T.flowDuration(1) <= 3.6, '流速越界(太快像蚂蚁爬,太慢像卡住):' + T.flowDuration(1) + '~' + T.flowDuration(10))
  // ② 只有新节点入场(轮询重画不许整张图闪)
  assert.match(code, /pendingEnter = new Set\(nd\.nodes\.filter\(\(n\) => !seenIds\.has\(n\.id\)\)\.map\(\(n\) => n\.id\)\)/, '没按"新增"筛出入场名单')
  assert.match(code, /if \(freshIdx\.size\)/, '入场动画没有"只有新节点才做"的闸')
  assert.match(code, /\.style\('animation-delay', \(d\) => T\.enterDelay\(freshIdx\.get\(d\.id\)\) \+ 'ms'\)/, '入场没有错峰延迟')
  assert.match(code, /pendingEnter = new Set\(\)/, '入场名单没清(会每帧都重新弹)')
  // 动画必须挂在圆/文字上,不能挂 <g>(会把布局的 translate 盖掉,节点瞬移到原点)
  assert.match(code, /nodeG\.selectAll\('\.node-halo, \.node, \.node-label'\)/, '入场动画挂错层了')
  assert.equal(/nodeG\.classed\('enter'/.test(code), false, '把入场动画挂到 <g> 上了 —— transform 会覆盖布局的 translate')
  assert.equal(T.enterDelay(0), 0, '第一个新节点该立刻出现')
  assert.ok(T.enterDelay(100) <= 400, '错峰延迟封顶太高(最后几个要等太久):' + T.enterDelay(100))
  // ③ 只有核心锚定节点呼吸
  assert.match(code, /nodeG\.filter\(\(d\) => d\.isProtected\)\.append\('circle'\)\.attr\('class', 'node-pulse'\)/, '呼吸环没限定在核心锚定节点上')
  assert.match(html, /@keyframes breatheOut/, '缺呼吸关键帧')
  // 三档开关 + 用户偏好 + 系统偏好兜底
  assert.match(code, /const MOTION_MODES = \['on', 'soft', 'off'\]/, '动效档位不对')
  assert.match(code, /localStorage\.setItem\('echo-graph-motion', motionMode\)/, '动效选择没记住')
  assert.match(code, /document\.documentElement\.setAttribute\('data-motion', motionMode\)/, '没有把动效档写到根元素上')
  assert.match(html, /\[data-motion="off"\] \.link-flow,\[data-motion="off"\] \.node-pulse\{animation:none;opacity:0\}/, '关档没有真关掉动画')
  assert.match(html, /\[data-motion="soft"\] \.link-flow\{opacity:\.3;animation-duration:calc\(var\(--dur,2\.4s\) \* 2\.2\)\}/, '弱档没有减速')
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)\{\*\{transition:none!important;animation:none!important\}\}/, '没尊重系统的"减少动态效果"')
  assert.match(html, /id="motion-btn" onclick="cycleMotion\(\)"/, '工具条上没有动效按钮')
})

test('⑬ 夹角力与边间斥力的纪律(自定义力写错一个字符就是整张图乱飞)', () => {
  // 他说:「关节处不应该能弯那么狠……两条线段中间最好不要成锐角」+「边之间也有斥力」。
  // d3 没有这两种力,是自己写的 —— 所以这里钉的是"写的规矩":
  assert.match(code, /\.force\('angles', forceAngles\)/, '夹角力没接到仿真上')
  assert.match(code, /\.force\('edgeRepel', forceEdgeRepel\)/, '边间斥力没接到仿真上')
  assert.match(code, /const forceAngles = \(\(\) => \{/, '夹角力不是 d3 的自定义力形状')
  assert.match(code, /const forceEdgeRepel = \(\(\) => \{/, '边间斥力不是 d3 的自定义力形状')
  assert.equal((code.match(/force\.initialize = \(\) => \{\}/g) || []).length, 2, '自定义力缺 initialize(d3 会直接报错)')
  // 只许往 vx/vy 上加:直接改 x/y 会把 d3 的积分器绕过去(位置和速度不一致,拖拽时更明显)
  assert.equal(/\.x \+= /.test(code), false, '有代码直接改 x 了 —— 力只能加在速度上')
  assert.equal(/\.y \+= /.test(code), false, '有代码直接改 y 了 —— 力只能加在速度上')
  // 钉住的节点(拖拽中/他钉住的)不许被推:否则拖一根线,整个布局跟着乱跑
  assert.match(code, /if \(it\.other\.fx != null \|\| it\.other\.fy != null\) continue/, '夹角力会推被钉住的节点')
  assert.match(code, /if \(p\.fx != null \|\| p\.fy != null\) continue/, '边间斥力会推被钉住的节点')
  // 共端点的两条边交给夹角力;边间斥力只处理不相邻的(否则同一对会同时被两条力推)
  assert.match(code, /if \(A\.source === B\.source \|\| A\.source === B\.target \|\| A\.target === B\.source \|\| A\.target === B\.target\) continue/, '共端点的边没被排除')
  // 两条力都要随 alpha 衰减:不然收敛不了,图会一直抖
  assert.match(code, /T\.angleStrength \* alpha \* push/, '夹角力没有跟着 alpha 衰减')
  assert.match(code, /T\.edgeRepelStrength \* alpha \* \(1 - near\.d \/ R\)/, '边间斥力没有跟着 alpha 衰减')
  // 拖拽时才启动实时仿真(载入时不许自己抖) —— 拖的时候这两条力也就跟着生效了
  assert.match(code, /function dragStart \(e, d\) \{ if \(!e\.active\) simulation\.alphaTarget\(\.3\)\.restart\(\)/, '拖拽没有启动实时仿真(那"转一个点"时夹角力就不生效)')
})

test('⑦b 平行关系合并成一束 + 预跑限速', () => {
  // 合并:一对节点一根线、一根弹簧;点一下展开这一串关系的全部依据
  assert.match(code, /const bundleOf = new Map\(\)/, '缺少平行关系合并')
  assert.match(code, /bundleEdges\.set\(b\.key, b\.edges\)/, '束里的边没记下来,点击就展不开全部依据')
  assert.match(code, /showEvidence\('bundle', d\.key\)/, '点击还是按单条边展开')
  assert.match(code, /else if \(evidenceTarget\.kind === 'edge'\)/, '单条边的依据面板被删了')
  assert.match(code, /evidenceTarget\.kind === 'bundle'/, '依据面板没处理"束"')
  assert.match(code, /d\.relCount > 1 \? ' ×' \+ d\.relCount/, '多条平行关系没有在图上标出来')
  // 限速:显式欧拉在刚度大时会发散
  assert.match(code, /n\.vx \*= k; n\.vy \*= k/, '预跑没有给速度上界')
  assert.ok(T.maxStep > 0 && T.maxStep < 120, '速度上界该是个小数字:' + T.maxStep)
  // 旧写法必须不在:直接一次 tick 完 + 按端点累计度数
  assert.equal(/for \(let i = 0; i < iterations; i\+\+\) simulation\.tick\(\)\n/.test(code), false, '又变回"一次性 tick 完、不夹速度"了')
})
