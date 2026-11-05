/**
 * 审计面板的**按轮归组**（`turnTrace` 优先）—— 2026-10-18
 * ==================================================================
 * 他报「审计面板数据缺了很多」，盘清后确认：**数据没丢，是散在 6~8 行里**。
 *
 * 面板本来就有 `buildTurns`（按时间窗口 `ATTACH_SEC` + 桶折轮），但它对
 * `bucket='other'` 的行有一条硬规则（`cls.bucket !== 'other'` 才允许附到上一轮）
 * ⇒ `retrieve` / `same_turn_emotion` / `ipc-appraise` **各自孤立成组**。
 * 实测 60 行归成 34 组，一趟 8 行的对话被拆成 4 组。
 *
 * 现在：同一 `turnTrace` ⇒ 一定是同一轮（不受时间窗口和桶限制）；
 * 没有 turnTrace 的行（老数据 / 系统事件）⇒ **退回原来的时间窗口逻辑，一行行为都不变**。
 *
 * 加载方式与 `tests/audit-view.test.js` 同源（classic script + new Function 沙箱）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../web/audit-view.js', import.meta.url)), 'utf8')
const sandbox = {}
new Function('globalThis', src)(sandbox) // eslint-disable-line no-new-func
const V = sandbox.EchoAuditView

/** 造一行审计（字段形状与 `store.listAudit` 的驼峰输出一致）。 */
let seq = 0
function row (over = {}) {
  seq += 1
  return {
    traceId: 'trace-' + seq,
    sessionId: 'session-b9f1692e',
    userInput: '',
    llmReply: '',
    toolCall: '',
    timestamp: 1_800_000_000 + seq,
    injectedMemories: '',
    emotionPack: '',
    injectedProfile: '',
    extraReply: null,
    stageDetail: '',
    ...over
  }
}

/** 把 turnTrace 塞进 stageDetail（与写入端 `withTurnTrace` 同形状）。 */
function withTT (tt) {
  return JSON.stringify({ turnTrace: tt })
}

/** 行数守恒：输入多少行，出来 rows 加起来必须还是多少行。 */
function totalRows (turns) {
  let n = 0
  for (const t of turns) n += t.rows.length
  return n
}

test('① traceOf：从 stage_detail 取 turnTrace（坏 JSON / 空 都返回空串）', () => {
  assert.equal(V.traceOf({ stageDetail: withTT('abc') }), 'abc')
  assert.equal(V.traceOf({ stageDetail: '{"turnTrace":"  x  "}' }), 'x', '要 trim')
  assert.equal(V.traceOf({ stageDetail: '' }), '', '空串 ⇒ 空')
  assert.equal(V.traceOf({ stageDetail: '不是 JSON' }), '', '★ 坏 JSON 不许抛')
  assert.equal(V.traceOf({ stageDetail: '{"a":1}' }), '', '没有这个键 ⇒ 空')
  assert.equal(V.traceOf({ stageDetail: '{"turnTrace":123}' }), '', '不是字符串 ⇒ 空')
  assert.equal(V.traceOf({}), '', '没有字段 ⇒ 空')
})

test('② ★ 同一 turnTrace 的 8 行必须归成一组（这是本次修复的核心）', () => {
  const TT = 'turn-abc'
  // 真实的 8 行形状（含那两个 bucket='other' 的刺头）
  const rows = [
    row({ toolCall: 'relay_in', userInput: '在忙', timestamp: 1000 }),
    row({ toolCall: 'inject', userInput: '在忙', timestamp: 1005, stageDetail: withTT(TT) }),
    row({ toolCall: 'same_turn_emotion', userInput: '(并行支)', timestamp: 1005, stageDetail: withTT(TT) }),
    row({ toolCall: 'retrieve', userInput: '在忙', timestamp: 1006, stageDetail: withTT(TT) }),
    row({ toolCall: 'relay_out', llmReply: '嗯～那你慢慢忙～', timestamp: 1020, stageDetail: withTT(TT) }),
    row({ toolCall: 'echo_qq_say', userInput: '(用 QQ 说)嗯～那你慢慢忙～', timestamp: 1020, stageDetail: withTT(TT) }),
    row({ toolCall: 'extract', userInput: '在忙', timestamp: 1035, stageDetail: withTT(TT) }),
    row({ toolCall: 'ipc-appraise', userInput: '(人际打分)', timestamp: 1035, stageDetail: withTT(TT) })
  ]
  const turns = V.buildTurns(rows)
  assert.equal(turns.length, 1, '★ 8 行必须是 1 组（改前会拆成 4 组），实际 ' + turns.length)
  assert.equal(turns[0].rows.length, 8, '一行都不许丢')
  assert.equal(turns[0].bucket, 'talk', '有入站 ⇒ 对话桶')
  assert.equal(turns[0].turnTrace, TT, '轮上要记住自己属于哪个 trace')
  assert.equal(totalRows(turns), 8, '★ 行数守恒')
})

test('③ retrieve / same_turn_emotion 这类 other 桶的行，有 trace 时不许再孤立成组', () => {
  const TT = 'turn-xyz'
  const rows = [
    row({ toolCall: 'relay_in', userInput: '你好', timestamp: 2000 }),
    row({ toolCall: 'relay_out', llmReply: '在的', timestamp: 2005, stageDetail: withTT(TT) }),
    // 这两行在改前会因为 bucket='other' 被踢开，各成一组
    row({ toolCall: 'retrieve', userInput: '你好', timestamp: 2006, stageDetail: withTT(TT) }),
    row({ toolCall: 'same_turn_emotion', userInput: '(并行支)', timestamp: 2006, stageDetail: withTT(TT) })
  ]
  const turns = V.buildTurns(rows)
  assert.equal(turns.length, 1, '★ 必须并成 1 组，实际 ' + turns.length)
  const tools = turns[0].rows.map((r) => r.toolCall).sort()
  assert.deepEqual(tools, ['relay_in', 'relay_out', 'retrieve', 'same_turn_emotion'], '四行都在')
})

test('④ 不同 turnTrace ⇒ 不许并到一起（哪怕时间上挨着）', () => {
  const rows = [
    row({ toolCall: 'relay_in', userInput: '第一轮', timestamp: 3000 }),
    row({ toolCall: 'inject', userInput: '第一轮', timestamp: 3001, stageDetail: withTT('turn-1') }),
    row({ toolCall: 'relay_in', userInput: '第二轮', timestamp: 3002 }),
    row({ toolCall: 'inject', userInput: '第二轮', timestamp: 3003, stageDetail: withTT('turn-2') })
  ]
  const turns = V.buildTurns(rows)
  assert.equal(turns.length, 2, '★ 两个 trace ⇒ 两组，实际 ' + turns.length)
  assert.equal(totalRows(turns), 4)
})

test('⑤ 没有 turnTrace 的老数据 ⇒ 老行为逐位不变（时间窗口归组）', () => {
  // 这一组复刻 `audit-view.test.js` 里"一进一出 + 反思"的经典形状
  const rows = [
    row({ toolCall: 'relay_in', userInput: '在吗', timestamp: 4000 }),
    row({ toolCall: 'echo_qq_say', userInput: '(用 QQ 说)在的', timestamp: 4010 }),
    row({ toolCall: 'relay_out', llmReply: '在的', timestamp: 4010 }),
    row({ toolCall: 'extract', userInput: '在吗', timestamp: 4020 })
  ]
  const turns = V.buildTurns(rows)
  assert.equal(turns.length, 1, '★ 没有 trace 也要按时间窗口折成一轮（老行为）')
  assert.equal(turns[0].turnTrace, '', '老数据没有 trace')
  assert.equal(totalRows(turns), 4, '行数守恒')
})

test('⑥ 混合：有 trace 的并进那一轮；`other` 桶的系统事件自己成组', () => {
  const TT = 'turn-mix'
  const rows = [
    row({ toolCall: 'relay_in', userInput: '在吗', timestamp: 5000 }),
    row({ toolCall: 'retrieve', userInput: '在吗', timestamp: 5001, stageDetail: withTT(TT) }),
    row({ toolCall: 'relay_out', llmReply: '在', timestamp: 5002, stageDetail: withTT(TT) }),
    // ★ 2026-10-19：`reflection_failed` 原本归 `other` 桶，那时它「自己成一组」。
    //   现在它归 `reflect` 桶（为了在「对话优先」档里能看见 —— 见
    //   tests/audit-reflection-mapping.test.js），而 `buildTurns` 的判别线正是
    //   `cls.bucket !== 'other'`（audit-view.js:417）⇒ 它会挂到最近一轮，
    //   和**成功的整固**、`inject` 这些 reflect 家族的行完全一样。
    //   所以这条测试改用真正的 `other` 桶系统事件（会话清理）来守那条线。
    //   ⚠️ 别拿 `emotion_decay` 当例子：它带 `(工具)` 前缀时 classify 出来是
    //   `machine`（不是 `other`），会照样挂上去 —— 这条踩过。
    row({ toolCall: 'session_cleanup', userInput: '(会话清理) 删了 3 条', timestamp: 5003 })
  ]
  const turns = V.buildTurns(rows)
  assert.equal(totalRows(turns), 4, '★ 一行都不许丢')
  const talk = turns.filter((t) => t.in !== null)
  assert.equal(talk.length, 1, '只有一轮有入站')
  assert.equal(talk[0].rows.length, 3, '带 trace 的三行并在一起')
  const own = turns.filter((t) => t.in === null)
  assert.equal(own.length, 1, '★ other 桶的系统事件要自己成组，不许被硬塞进对话轮')
  assert.equal(own[0].rows[0].toolCall, 'session_cleanup')
})

test('⑥′ 整固行（成功/失败）都会挂到最近一轮 —— 与 inject 同款', () => {
  for (const tc of ['reflection', 'reflection_failed']) {
    const rows = [
      row({ toolCall: 'relay_in', userInput: '在吗', timestamp: 5000 }),
      row({ toolCall: 'relay_out', llmReply: '在', timestamp: 5002 }),
      row({ toolCall: tc, userInput: '(' + tc + ')', timestamp: 5003 })
    ]
    const turns = V.buildTurns(rows)
    assert.equal(totalRows(turns), 3, '一行都不许丢')
    const talk = turns.filter((t) => t.in !== null)
    assert.equal(talk.length, 1, tc + ' 只有一轮有入站')
    assert.equal(talk[0].rows.length, 3,
      '★ ' + tc + ' 归 reflect 桶 ⇒ 挂到最近一轮（和成功行/inject 一致），实际该轮 ' + talk[0].rows.length + ' 行')
  }
})

test('⑦ 坏 stage_detail 不许让整行消失（解析失败当没有 trace）', () => {
  const rows = [
    row({ toolCall: 'relay_in', userInput: '在吗', timestamp: 6000 }),
    row({ toolCall: 'relay_out', llmReply: '在', timestamp: 6001, stageDetail: '{{{坏 JSON' }),
    row({ toolCall: 'retrieve', userInput: '在吗', timestamp: 6002, stageDetail: 'null' })
  ]
  const turns = V.buildTurns(rows)
  assert.equal(totalRows(turns), 3, '★ 坏 JSON 也不许丢行')
})

test('⑧ 静态闸：buildTurns 里必须先查 turnTrace 再走桶逻辑', () => {
  const at = src.indexOf('function buildTurns')
  assert.ok(at > 0)
  const body = src.slice(at, at + 4600)
  assert.ok(body.includes('traceOf('), '要调用 traceOf')
  assert.ok(body.includes('traceIndex'), '要有 traceIndex 索引')
  // traceTrace 分支必须在"开新一轮"之前（判据：`tt !== ''` 出现在 relay_in 之前）
  const ttAt = body.indexOf("if (tt !== '')")
  const relayInAt = body.indexOf("tool === 'relay_in'")
  assert.ok(ttAt > 0, '要有 `if (tt !== \'\')` 分支')
  assert.ok(ttAt < relayInAt,
    '★ 必须先查 turnTrace 再看是不是 relay_in —— 否则同一轮的 later 行会被开新组')
  // 认领逻辑必须在（否则 relay_in 没 trace 时又会分裂）
  assert.ok(body.includes('target.turnTrace ==='), '★ 要有"最近一轮认领这个 trace"的分支')
})

test('⑨ 有 turnTrace 时，轮 id 用它（保证展开状态不漂移）', () => {
  const TT = 'turn-stable-id'
  const rows = [
    row({ traceId: 'raw-trace-1', toolCall: 'relay_in', userInput: '在吗', timestamp: 7000 }),
    row({ traceId: 'raw-trace-2', toolCall: 'retrieve', timestamp: 7001, stageDetail: withTT(TT) }),
    row({ traceId: 'raw-trace-3', toolCall: 'relay_out', llmReply: '在', timestamp: 7002, stageDetail: withTT(TT) })
  ]
  const turns = V.buildTurns(rows)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].id, TT,
    '★ 有 trace 的轮，id 必须等于 turnTrace —— 否则开轮那一行一变，'
    + '面板按 id 记的展开状态就全塌（app.js:881 的老坑）')
  // 老数据（没 trace）仍然用原 id 口径
  const old = V.buildTurns([row({ traceId: 'legacy-1', toolCall: 'relay_in', userInput: '在吗', timestamp: 8000 })])
  assert.equal(old[0].id, 'legacy-1', '没有 trace ⇒ 老行为：用 traceId')
})
