/**
 * 舱壁的**可观测面形状契约** —— 2026-10-21
 * ==================================================================
 * `10605eb` 把直调通道拆成 live / bulk 两池，但 `/api/echo/status` 里看不见它们
 * ⇒ 重启之后没法验收"反思是不是还在挡轮前那两个小调用"。这一组钉的就是
 * **那两格（`llmLastMs` / `llmPool`）的形状契约**。
 *
 * ## 为什么是源码断言，不是 import
 *
 * `lib/index.js` 顶部 `import { defineTool } from '@deepseek-ai/dsh-tools'` /
 * `@deepseek-ai/dsh-llm` —— 那两个包只存在于 DSH profile，**本仓 node_modules 里没有**，
 * 测试里 import 不了（全仓没有一个测试 import `lib/index.js`）。
 * 所以走 `tests/reflect-route.test.js:96-97` 同款做法：**读源码做断言**。
 *
 * ## 这条为什么能抓住"漏声明"
 *
 * `echo_status` 的 `output.schema` 是**逐键 `additionalProperties: false`** 的
 * （`lib/index.js` 里那段注释写过：漏一个键 ⇒ `echo_status` 整个被宿主拒掉，
 * 而不是"少显示一格"）。所以：
 *
 *   · 值里有 `llmPool`、schema 里没声明 ⇒ 每次调用都被拒（2026-09-26 两连炸同款）
 *   · schema 里声明了、`REFLECT_STATS_SHAPE` 没给默认值 ⇒ 填之前那一拍是 `undefined`
 *   · 声明成"只有 object、没有 null 支" ⇒ `llmPool: null` 过不去
 *
 * 三个坑各有一条断言盯着。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

/**
 * 从 `needle` 起做**花括号配对**，切出那一段字面量（含首尾）。
 * 找不到 / 不配对 ⇒ 返回 ''（断言那边会红，不会静默通过）。
 */
function sliceBraces (src, needle) {
  const at = src.indexOf(needle)
  if (at < 0) return ''
  const open = src.indexOf('{', at)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return ''
}

/** 数某个键在片段里被声明了几次（`running: { type: 'number' }` 这种）。 */
const countKey = (block, key) =>
  (block.match(new RegExp(key + ":\\s*\\{\\s*type:\\s*'number'\\s*\\}", 'g')) || []).length

test('★ llmPool 两种形态都能过 schema：null 与两池对象', () => {
  // ── ① A 段：schema 必须声明这两格 ────────────────────────────────
  //     ★ 把 A 段（`llmLastMs` / `llmPool` 的声明）删掉 ⇒ 这一条立刻红。
  assert.match(SRC, /llmLastMs:\s*\{\s*type:\s*'number'\s*\}/,
    'schema 必须声明 llmLastMs（漏了 ⇒ echo_status 被宿主整条拒掉）')
  assert.match(SRC, /llmPool:\s*\{\s*oneOf:/,
    'schema 必须声明 llmPool')

  // ── ② llmPool 的两支必须都在：object（两池） + null ──────────────
  const poolSchema = sliceBraces(SRC, 'llmPool: {')
  assert.ok(poolSchema !== '', '抽不到 llmPool 的 schema 字面量')

  assert.match(poolSchema, /\{\s*type:\s*'null'\s*\}/,
    '★ null 支必须在 —— 否则 `llmPool: null`（还没起过直调时的值）过不去 schema')
  assert.match(poolSchema, /type:\s*'object'/,
    '★ object 支必须在 —— 否则真跑起来之后那份两池对象过不去')

  // object 支：关掉额外键 + live/bulk 各一个 running/waiting
  assert.match(poolSchema, /additionalProperties:\s*false/,
    'object 支要 additionalProperties:false（与整块同一条纪律）')
  for (const side of ['live', 'bulk']) {
    assert.ok(poolSchema.includes(side + ': {'), 'object 支里必须有 ' + side)
  }
  assert.equal(countKey(poolSchema, 'running'), 2, 'live / bulk 各要一个 running')
  assert.equal(countKey(poolSchema, 'waiting'), 2, 'live / bulk 各要一个 waiting')

  // ── ③ B 段：REFLECT_STATS_SHAPE 必须同批给默认值 ─────────────────
  //     没有默认值 ⇒ 第一次填之前是 undefined ⇒ additionalProperties:false 下被判非法
  assert.match(SRC, /llmLastMs:\s*0,\s*llmPool:\s*null/,
    'REFLECT_STATS_SHAPE 必须同批给 llmLastMs:0 / llmPool:null')

  // ── ④ C 段：抄值处必须真的把它们填上来 ───────────────────────────
  assert.match(SRC, /reflectStats\.llmLastMs\s*=\s*Number\(ls\.lastMs\)\s*\|\|\s*0/,
    'lastMs 要抄进状态面（判"是不是又被通道卡住"的第一眼）')
  // ⚠️ 这里不能用 sliceBraces：`reflectStats.llmPool = (ls.pool === null …) ? null : {…}`
  //   的第一个 `{` 是**三元分支里的内层对象**，会把条件那句切掉。取一段窗口。
  const atAssign = SRC.indexOf('reflectStats.llmPool =')
  const assign = atAssign < 0 ? '' : SRC.slice(atAssign, atAssign + 420)
  assert.ok(assign !== '', '找不到 reflectStats.llmPool 的赋值')
  // 赋值产出的键集必须**恰好**是 live/bulk × running/waiting —— 与 ② 的声明逐键对上
  assert.equal((assign.match(/running:/g) || []).length, 2, '两池各抄一个 running')
  assert.equal((assign.match(/waiting:/g) || []).length, 2, '两池各抄一个 waiting')
  for (const side of ['live:', 'bulk:']) {
    assert.ok(assign.includes(side), '抄值处要覆盖 ' + side)
  }
  // 取不到（通道还没起过）⇒ null，绝不是 undefined（null 支就是为这个存在的）
  assert.match(assign, /ls\.pool === null \|\| ls\.pool === undefined/,
    '取不到时必须给 null，不许留 undefined')
})
