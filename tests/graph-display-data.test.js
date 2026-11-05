/**
 * P3-c:图谱页的显示调参改成**数据驱动**(`graph.json.display` → `web/graph.html`)。
 *
 * 背景:`GRAPH_TUNING` 那张表原来**只有页面自己一份真值**(九个数字),而面板
 * `#/tuning` 早就能写 `graph.json.display`(`web/views/tuning.js:75-85` 逐个照抄、
 * 连行号都标了)——两份真值必然漂。这批给页面加读点:轮询时现读
 * `/api/echo/data/graph.json`,把 `display` 的数值套到表上。
 *
 * 三条钉子(与 P3 的硬验收同一条):
 *   ① 键**逐一对齐**面板那张 DISPLAY_FIELDS(两边各写一份键名就是下一次漂);
 *   ② **空 / 坏 / 脏 ⇒ 一个数都不动** —— 页面行为与迁移前逐位一致;
 *   ③ 有数据 ⇒ 九个数值真的变了(不是"读了个哑字段")。
 *
 * 手法照 `tests/graph-force.test.js`:页面在浏览器里才跑,所以从 HTML 源码里把
 * 纯函数 / 表抠出来在 Node 里算(那张表当初就是为这个才写成纯函数的)。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleDataRequest } from '../lib/data-write.js'

const html = readFileSync(fileURLToPath(new URL('../web/graph.html', import.meta.url)), 'utf8')

/** 抠出从 needle 起到大括号配平的那一段源码(照 `graph-force.test.js` 的手势)。 */
function blockAt (needle) {
  const start = html.indexOf(needle)
  assert.ok(start > 0, '找不到 ' + needle + '(改名了就把这条测试也改掉)')
  let depth = 0
  for (let i = html.indexOf('{', start); i < html.length; i += 1) {
    if (html[i] === '{') depth += 1
    else if (html[i] === '}') { depth -= 1; if (depth === 0) return html.slice(start, i + 1) }
  }
  assert.fail(needle + ' 的大括号不配平')
}

/** 抠出 `const <name> = <字面量>` 的真值(对象 / 数组),返回真值。 */
function literalOf (name) {
  const start = html.indexOf('const ' + name + ' = ')
  assert.ok(start > 0, '找不到 ' + name + '(改名了就把这条测试也改掉)')
  const ob = html.indexOf('{', start)
  const os = html.indexOf('[', start)
  const open = (os !== -1 && (ob === -1 || os < ob)) ? os : ob
  const closeCh = html[open]
  const close = closeCh === '[' ? ']' : '}'
  let depth = 0
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === closeCh) depth += 1
    else if (html[i] === close) { depth -= 1; if (depth === 0) return new Function('return (' + html.slice(open, i + 1) + ')')() }
  }
  assert.fail(name + ' 配平失败')
}

/** 每次从源码**重新抠一份**表:用例之间不互相污染(那是个可变对象)。 */
function freshTuning () { return literalOf('GRAPH_TUNING') }

const DISPLAY_KEYS = literalOf('DISPLAY_KEYS')
/** 抠出来的函数带自由变量 `DISPLAY_KEYS` ⇒ 当参数喂进去(等价于页面里的词法环境)。 */
const applyDisplayTuning = new Function(
  'DISPLAY_KEYS', 'return (' + blockAt('function applyDisplayTuning (T, display) {') + ')'
)(DISPLAY_KEYS)

/** 面板那份 DISPLAY_FIELDS(同一个 IIFE 沙箱手势,见 tests/config-tuning.test.js)。 */
const sandbox = {}
new Function('globalThis', readFileSync(fileURLToPath(new URL('../web/views/tuning.js', import.meta.url)), 'utf8'))(sandbox)
const FIELDS = sandbox.EchoViews['tuning'].pure.DISPLAY_FIELDS

/** 九个数的观测向量(norm / 半径 / 边宽 / 流速 / 入场延迟各取几个点)。 */
function fingerprint (T) {
  return [T.norm(1), T.norm(3), T.norm(8), T.norm('x'),
    T.radiusOf(1), T.radiusOf(3), T.radiusOf(8),
    T.linkWidth(3, 80), T.linkWidth(3, 0),
    T.flowDuration(1), T.flowDuration(8),
    T.enterDelay(0), T.enterDelay(5), T.enterDelay(100)]
}

test('① 键逐一对齐面板:graph.html 的 DISPLAY_KEYS == tuning.js 的 DISPLAY_FIELDS', () => {
  assert.deepEqual(DISPLAY_KEYS, FIELDS.map((f) => f.key),
    '两边的键名必须一模一样 —— 面板写进去的键,页面得认')
  assert.equal(DISPLAY_KEYS.length, 9)
})

test('② 空 / 坏 / 脏 ⇒ 一个数都不动(迁移前逐位一致)', () => {
  const T = freshTuning()
  const before = fingerprint(T)
  const bads = [undefined, null, [], 'display', 7, true,
    {}, { wMin: 'x' }, { wMin: '' }, { wMin: '   ' }, { wMin: true }, { wMin: null },
    { wMin: NaN }, { radiusBase: '不是数' }, { radiusScale: [] }, { radiusScale: {} }]
  for (const bad of bads) {
    assert.equal(applyDisplayTuning(T, bad), 0, '脏值不该被采纳:' + String(bad))
  }
  assert.deepEqual(fingerprint(T), before, '一个数都不许动')
  assert.equal(T.wMin, 1)
  assert.equal(T.wMax, 10)
  assert.equal(T.radiusBase, undefined, '出厂值仍写在表里(用 ?? 兜),不是被这里塞进去的')
})

test('③ 有数据 ⇒ 九个数值真的生效(逐条对齐)', () => {
  const T = freshTuning()
  const n = applyDisplayTuning(T, {
    wMin: 2, wMax: 8, radiusBase: 6, radiusScale: 10,
    edgeWidthMin: 1, edgeWidthMax: 3,
    flowSlowSec: 5, flowFastSec: 1, enterDelayMaxMs: 100
  })
  assert.equal(n, 9, '九项全采纳')
  assert.equal(T.norm(8), 1, '上限也跟着数据走(8/8)')
  assert.equal(T.norm(1), 0.25, '下限 2 / 上限 8 ⇒ 1 被夹到 2')
  assert.equal(T.radiusOf(8), 16, 'radiusBase + radiusScale×1')
  assert.equal(T.linkWidth(8, 80), 3, 'edgeWidthMin→Max 按权重插值')
  assert.equal(T.flowDuration(8), 1, '最快那一端 = flowFastSec')
  assert.equal(T.enterDelay(100), 100, '封顶值跟着数据走')

  // 只给一部分 ⇒ 只动那一部分(其余留出厂值)
  const T2 = freshTuning()
  assert.equal(applyDisplayTuning(T2, { wMax: 20 }), 1)
  assert.equal(T2.norm(10), 0.5, '给了 wMax 才动它')
  assert.equal(T2.radiusOf(8), 4.5 + 8.5 * Math.sqrt(0.4), '没给的照旧(4.5 + 8.5×√norm)')
  assert.equal(T2.linkWidth(8, 80), 0.6 + 0.9 * 0.4, '边宽出厂值也照旧')
})

test('④ 接线:页面现读数据端点,且**先套调参再画图**', () => {
  assert.match(html, /fetch\('\/api\/echo\/data\/graph\.json'\)/, '显示调参只走这条只读端点')
  assert.match(html, /await loadDisplayTuning\(\)/, '轮询里要真的调它')
  assert.match(html, /async function poll \(\) \{\n  await loadDisplayTuning\(\)/, '要先套调参再取图 / 画图')
  assert.doesNotMatch(html, /writeFileSync|PUT |x-echo-edit/, '页面只读,不许出现任何写路径')
  // 出厂值仍在代码里(空数据时靠它们;上面第 ② 条钉的就是这个行为)
  for (const v of ['4.5', '8.5', '0.6', '1.5', '3.4', '1.6', '320']) {
    assert.ok(html.includes(v), '出厂值 ' + v + ' 不许丢')
  }
})

test('⑤ 端到端(不过浏览器):面板写进 graph.json 的数,页面那条路读得到', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-display-'))
  try {
    writeFileSync(join(dir, 'graph.json'), JSON.stringify({
      schemaRev: 1, display: { wMax: 20, radiusBase: 6, enterDelayMaxMs: 100 }
    }), 'utf8')
    // 页面那段就一句 `await fetch('/api/echo/data/graph.json')` ⇒ 这里直接问**真 handler**
    // (B1 的只读端点),形状对不上就是页面读了个空。
    const r = handleDataRequest({ method: 'GET', url: '/api/echo/data/graph.json', dir })
    assert.equal(r.status, 200)
    const body = r.payload
    const T = freshTuning()
    assert.equal(applyDisplayTuning(T, body && body.value ? body.value.display : null), 3)
    assert.equal(T.radiusOf(8), 6 + 8.5 * Math.sqrt(0.4), 'wMax 改了 ⇒ norm 跟着改,radiusBase 也生效')
    assert.equal(T.enterDelay(100), 100)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
