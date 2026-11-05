/**
 * `audit-cards.html` 的分轮 —— 2026-10-18
 * ==================================================================
 * 他报「审计面板不更新了」。查下来**不是** `audit-view.js` 的回归
 * （那个我改过，实测 21 组 / 120 行、最新一轮在展示里）。
 *
 * 真相：**有两个审计面板**。
 *   · `app.js` 里的（用 `web/audit-view.js` 的 `buildTurns`）—— 我改了
 *   · **`audit-cards.html`（导航上那个「审计面板 ↗」）—— 自己另写了一套**
 *
 * 它按 `session_id + 180 秒窗` 切轮，完全不看 `stage_detail.turnTrace`：
 *   「评价一下」143 条一组、「[QQ:群聊] 来群里」55 条一组
 * ⇒ 新行被并进那种巨型组里 ⇒ 看起来就像"面板不动了"。
 *
 * 现在改成 **turnTrace 优先、180 秒兜底**，与 `audit-view.js` 同一口径。
 *
 * 本文件把那一段切轮代码从 HTML 里抽出来跑（与 `tests/graph-force.test.js`
 * 抽 graph.html 的分法同源）—— 页面是 classic script，没有 import/export。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const html = readFileSync(fileURLToPath(new URL('../web/audit-cards.html', import.meta.url)), 'utf8')

/** 抽出切轮那段（从 `const ttOf =` 到 `turns.sort(...)`），包成一个函数。 */
function extractGrouping () {
  const start = html.indexOf('const ttOf = (r) =>')
  const end = html.indexOf('turns.sort((a,b)=>b[0].timestamp-a[0].timestamp);')
  assert.ok(start > 0, '找不到 ttOf 的定义（切轮代码被改结构了？）')
  assert.ok(end > start, '找不到 turns.sort 收尾（切轮代码被改结构了？）')
  return html.slice(start, end) + '\nreturn turns'
}

const GROUP_CODE = extractGrouping()

/** 用一份行跑切轮（行的字段是 audit-cards.html 的下划线形状）。 */
function group (rows) {
  return new Function('map', GROUP_CODE)(rows)
}

/** 造一行（audit-cards.html 里的字段形状）。 */
let seq = 0
function row (over = {}) {
  seq += 1
  return {
    trace_id: 'tr-' + seq,
    session_id: 'session-b9f1692e',
    user_input: '',
    tool_call: '',
    timestamp: 1_800_000_000 + seq,
    stage: '',
    step: 0,
    stage_detail: '',
    agent_state: '{}',
    ...over
  }
}
const tt = (v) => JSON.stringify({ turnTrace: v })

function total (turns) {
  let n = 0
  for (const g of turns) n += g.length
  return n
}

test('① 语法闸：HTML 里的 script 块能被解析（改坏了浏览器会整页白）', () => {
  const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || []
  assert.ok(blocks.length > 0, '页面里要有 script 块')
  for (const b of blocks) {
    const code = b.replace(/^<script>/, '').replace(/<\/script>$/, '')
    assert.doesNotThrow(() => new Function(code), 'script 块语法必须能过')
  }
})

test('② ★ 同一 turnTrace 的 7 行必须归成一组（这是本次修复的核心）', () => {
  const T = 'turn-A'
  const rows = [
    row({ tool_call: 'relay_in', user_input: '在忙', timestamp: 1000 }),
    row({ tool_call: 'same_turn_emotion', timestamp: 1001, stage_detail: tt(T) }),
    row({ tool_call: 'retrieve', timestamp: 1001, stage_detail: tt(T) }),
    row({ tool_call: 'inject', timestamp: 1002, stage_detail: tt(T) }),
    row({ tool_call: 'relay_out', timestamp: 1010, stage_detail: tt(T) }),
    row({ tool_call: 'echo_qq_say', timestamp: 1010, stage_detail: tt(T) }),
    row({ tool_call: 'ipc-appraise', timestamp: 1035, stage_detail: tt(T) })
  ]
  const turns = group(rows)
  assert.equal(turns.length, 1, '★ 7 行必须 1 组，实际 ' + turns.length)
  assert.equal(turns[0].length, 7, '一行都不许丢')
})

test('③ ★ 行数守恒（防"重复 push"那个 bug 复发）', () => {
  // 第一版我把 `else{cur=[r];turns.push(cur)}` 写反了顺序（原代码是
  // `else{turns.push(cur);cur=[r]}`），而且 `:220` 和 `:227` 会重复 push 同一组
  // ⇒ 实测 200 行被数成 207 行。这条用例就是钉它。
  const rows = []
  for (let i = 0; i < 20; i++) {
    const T = 'turn-' + i
    const base = 1000 + i * 100
    rows.push(row({ tool_call: 'relay_in', timestamp: base }))
    rows.push(row({ tool_call: 'inject', timestamp: base + 1, stage_detail: tt(T) }))
    rows.push(row({ tool_call: 'relay_out', timestamp: base + 2, stage_detail: tt(T) }))
    // 夹一行没有 trace 的系统事件（走 180 秒兜底）
    rows.push(row({ tool_call: 'emotion_decay', timestamp: base + 3 }))
  }
  const turns = group(rows)
  assert.equal(total(turns), rows.length,
    '★ 行数必须守恒（' + total(turns) + ' vs ' + rows.length + '）—— 重复 push 或丢行都是 bug')
  // 而且不许有组被算两遍
  const uniq = new Set(turns)
  assert.equal(uniq.size, turns.length, '★ 同一个组不许在 turns 里出现两次')
})

test('④ 不同 turnTrace ⇒ 不许并到一起（哪怕时间挨着）', () => {
  const rows = [
    row({ tool_call: 'relay_in', user_input: '第一轮', timestamp: 3000 }),
    row({ tool_call: 'inject', timestamp: 3001, stage_detail: tt('turn-1') }),
    row({ tool_call: 'relay_in', user_input: '第二轮', timestamp: 3002 }),
    row({ tool_call: 'inject', timestamp: 3003, stage_detail: tt('turn-2') })
  ]
  const turns = group(rows)
  assert.equal(turns.length, 2, '两个 trace ⇒ 两组，实际 ' + turns.length)
  assert.equal(total(turns), 4)
})

test('⑤ 没有 turnTrace 的老数据 ⇒ 180 秒窗（老行为不变）', () => {
  const rows = [
    row({ tool_call: 'relay_in', user_input: '在吗', timestamp: 4000 }),
    row({ tool_call: 'relay_out', timestamp: 4010 }),
    row({ tool_call: 'extract', timestamp: 4020 })
  ]
  const turns = group(rows)
  assert.equal(turns.length, 1, '180 秒内的三行 ⇒ 一组')
  // 隔了 200 秒 ⇒ 应该切开
  const rows2 = [
    row({ tool_call: 'relay_in', user_input: 'A', timestamp: 5000 }),
    row({ tool_call: 'relay_in', user_input: 'B', timestamp: 5201 })
  ]
  assert.equal(group(rows2).length, 2, '超过 180 秒 ⇒ 两组')
})

test('⑥ ★ 不许再出现「巨型组」（旧逻辑把 143 行并成一组）', () => {
  // 造 30 轮 × 7 行，每轮都有独立 trace，时间紧凑（模拟真实高频对话）
  const rows = []
  for (let i = 0; i < 30; i++) {
    const T = 'turn-' + i
    const base = 10_000 + i * 10
    rows.push(row({ tool_call: 'relay_in', timestamp: base }))
    for (let k = 1; k <= 6; k++) {
      rows.push(row({ tool_call: 'step' + k, timestamp: base + k, stage_detail: tt(T) }))
    }
  }
  const turns = group(rows)
  assert.equal(turns.length, 30, '30 轮 ⇒ 30 组，实际 ' + turns.length)
  const biggest = Math.max(...turns.map((g) => g.length))
  assert.equal(biggest, 7, '★ 最大的组只能是 7 行（旧逻辑会并成 200+），实际 ' + biggest)
})

test('⑦ 坏 stage_detail 不许让整行消失', () => {
  const rows = [
    row({ tool_call: 'relay_in', timestamp: 6000 }),
    row({ tool_call: 'relay_out', timestamp: 6001, stage_detail: '{{{坏' }),
    row({ tool_call: 'retrieve', timestamp: 6002, stage_detail: 'null' })
  ]
  const turns = group(rows)
  assert.equal(total(turns), 3, '★ 坏 JSON 也要保留整行')
})

test('⑧ 静态闸：切轮判据必须是 turnTrace 优先（不是只剩 180 秒）', () => {
  assert.ok(html.includes('const ttOf = (r) =>'), '要有 ttOf 取 turnTrace')
  assert.ok(html.includes('traceToTurn'), '要有 turnTrace → 轮的索引')
  assert.ok(html.includes('curHasTrace'), '★ 要有"认领"分支（relay_in 没 trace 时靠它）')
  // 那句过时的说明必须已经改掉
  assert.equal(html.includes('新写入的 trace_id 仍是每行一个'), false,
    '★ 页面里那句"trace_id 仍是每行一个"已经过时了，必须改掉（现在有 turnTrace 了）')
  assert.ok(html.includes('turnTrace</b> 分轮'), '说明文字要写清新口径')
})
