/**
 * 图谱测试的公共零件:把 `web/graph.html` 里的纯函数表抠出来。
 * (不是 *.test.js,所以不会被 `node --test tests/*.test.js` 当测试跑)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const graphHtml = readFileSync(fileURLToPath(new URL('../web/graph.html', import.meta.url)), 'utf8')

/** 去掉注释再扫源码:注释里会引用旧写法(比如"旧版是 forceCenter"),不能误判成代码。 */
export function stripComments (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"])\/\/[^\n]*$/gm, '$1')
}

/** 抠出 `const GRAPH_TUNING = { ... }`(大括号配平),返回真对象。 */
export function tuning (html = graphHtml) {
  const start = html.indexOf('const GRAPH_TUNING = {')
  if (start < 0) throw new Error('找不到 GRAPH_TUNING(改名了就把测试也改掉)')
  const open = html.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < html.length; i += 1) {
    const c = html[i]
    if (c === '{') depth += 1
    else if (c === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
  }
  if (end < 0) throw new Error('GRAPH_TUNING 的大括号不配平')
  return new Function('return (' + html.slice(open, end) + ')')()
}

/** 抠出 [startMarker, endMarker) 之间的一段源码(两个标记都要真的在)。 */
function between (html, startMarker, endMarker) {
  const a = html.indexOf(startMarker)
  if (a < 0) throw new Error('找不到起点:' + startMarker)
  const b = html.indexOf(endMarker, a)
  if (b < 0) throw new Error('找不到终点:' + endMarker)
  return html.slice(a, b)
}

/**
 * 页面里"把平行关系合并成束 + 按真邻居数算度数"那一段,原样跑一遍。
 * 不重抄逻辑 —— 抄了就测不出页面自己写错了什么。
 */
export function pageBundleAndDegree (edges, html = graphHtml) {
  const slice = between(html, 'const bundles = []', '  for (const n of nodes) {')
  // 这一段会顺手把"连线数"写进统计栏($('sl')),所以给个假的 DOM 桩 —— 顺手
  // 把写进去的值记下来,测试就能验它跟束数一致(不用真浏览器)。
  const seen = {}
  const fn = new Function('edges', '$', 'let bundleEdges = null\n' + slice + '\nreturn { bundles, degree, bundleEdges, degOf }')
  const out = fn(edges, (id) => (seen[id] = seen[id] || { textContent: '' }))
  return { ...out, seen }
}

/**
 * 页面里"造力 + 预跑"那一段,用**真的 d3** 跑一遍(不是我自己写的近似积分器)。
 * clamp=false 时把速度上限那一行短路掉 —— 用来复现"平行关系没合并 + 不限速"的炸图。
 */
export function pageForceRun ({ d3, nodes, bundles, degree, degOf, W, H, clamp = true, strip = false, html = graphHtml }) {
  let slice = between(html, 'const d3Links = bundles.map(', 'for (const n of nodes) nodePositions[n.id]')
  if (!clamp) slice = slice.replace('if (v > T.maxStep)', 'if (false)')
  // strip:拆掉夹角力与边间斥力,当**对照组**用(证明那条测试量的确实是这两条力的作用,
  // 而不是布局本来就不挤)。
  if (strip) {
    slice = slice.replace(".force('angles', forceAngles)", '').replace(".force('edgeRepel', forceEdgeRepel)", '')
  }
  const fn = new Function(
    'd3', 'nodes', 'bundles', 'degree', 'degOf', 'T', 'W', 'H', 'nodePositions', 'currentLinks',
    'let simulation\n' + slice + '\nreturn { simulation, iterations, d3Links }')
  return fn(d3, nodes, bundles, degree, degOf, tuning(html), W, H, {}, [])
}

/** 把 web/vendor 里那份 d3 载进 Node(UMD 在 require 下会挂到 globalThis,只好自己喂 exports)。 */
export function loadD3 (html = graphHtml) {
  const src = readFileSync(fileURLToPath(new URL('../web/vendor/d3.v7.min.js', import.meta.url)), 'utf8')
  const fn = new Function('exports', 'module', 'define',
    src + '\n;return (typeof d3 !== "undefined" ? d3 : exports)')
  return fn({}, { exports: {} }, undefined)
}
