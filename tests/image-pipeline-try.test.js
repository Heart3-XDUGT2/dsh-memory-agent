/**
 * 图片处理整段包进 try —— 2026-10-20
 * ==================================================================
 * ## 现场（他报的「发完表情后会忽略下一句话」）
 *
 * `inbound.jsonl` 里：
 * ```
 * 12:25:16  stage=sent          imgs=1                    ← 表情包
 * 12:25:16  stage=core-refused  imgs=1  agent-unavailable  ← ★ 主包拒了
 * 12:25:40  stage=sent          imgs=0  "看不出来"
 * 12:25:40  stage=core-refused  imgs=0  agent-unavailable  ← ★ 下一句也被拒
 * ```
 * 主包的 `relay_in` 审计里那两条**完全缺失**（`relay_in` 写在受理判定之后）
 * ⇒ 确认没进她的上下文。
 *
 * ## 根因
 *
 * `injectInboundNow` 里，**图片处理那一整段在 `try` 外面**：
 * 抓图 / 数表情包 / 选文案 / 落附件库 / 拼 content —— 任何一处抛错都会冒泡到
 * `relay.js` 的 catch ⇒ `result = 'error'` ⇒ 503 `agent-unavailable` ⇒
 * **整条消息被拒**（还会连带下一条）。
 *
 * ## 纪律
 *
 * **图片炸了只该少一张图，不该让这句话消失。** 降级成纯文字注入。
 *
 * ---
 * 这一组是**静态闸**：`injectInboundNow` 要真跑起来得整个插件 + 宿主，
 * 成本远高于收益；而这里要钉的是**结构**（"有没有包住"），静态判据恰好合适。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')

/** 抠出 `injectInboundNow` 的函数体。 */
function injectBody () {
  const at = SRC.indexOf('async function injectInboundNow (')
  assert.ok(at > 0, '找不到 injectInboundNow')
  // 收尾：下一个顶层（两空格缩进的）函数声明
  const end = SRC.indexOf('\n  async function ', at + 10)
  assert.ok(end > at, '找不到 injectInboundNow 的收尾')
  return SRC.slice(at, end)
}

/** 去掉行注释，便于判"第一条语句是什么"。 */
const stripLineComments = (s) => s.replace(/(^|[^:])\/\/[^\n]*/g, '$1')

test('① ★ if (wanted > 0) 之后**第一条语句就是 try**（图片整段被包住）', () => {
  const body = injectBody()
  const at = body.indexOf('if (wanted > 0) {')
  assert.ok(at > 0, '找不到 `if (wanted > 0) {`')
  const after = stripLineComments(body.slice(at + 'if (wanted > 0) {'.length))
  const firstStmt = after.split('\n').map((l) => l.trim()).filter((l) => l !== '')[0]
  assert.equal(firstStmt, 'try {',
    '★ 图片处理必须从第一条语句起就被 try 包住 —— 原来它是裸的，抛了就 503。实得: ' + firstStmt)
})

test('② ★ catch 里要**降级成纯文字**（不是重抛、不是沉默）', () => {
  const body = injectBody()
  const at = body.indexOf('if (wanted > 0) {')
  const seg = body.slice(at)
  // 外层的 catch（第一个出现在图片段之后的 `} catch (err) {`，且后面跟着降级）
  const idx = seg.indexOf('content = [{ type: \'text\', text }]')
  assert.ok(idx > 0, '★ 降级那行不在 —— 图片炸了这条消息就白费了')
  // 降级那行必须在一个 catch 块里
  const before = seg.slice(0, idx)
  const lastCatch = before.lastIndexOf('} catch')
  assert.ok(lastCatch > 0, '降级那行必须在 catch 里')
})

test('③ ★ 降级还要留一条审计（下次能查到是哪张图/哪一步炸的）', () => {
  const body = injectBody()
  assert.match(body, /audit\?\.\('relay_reject', 'image-pipeline-crashed:/,
    '★ 只 warn 不落盘 = 下次还是查不出来（ctx.logger 不落盘，这条疤踩过一次）')
})

test('④ ★ 四个图片相关的调用都必须在 try 里（逐个点名，防以后挪出去）', () => {
  const body = injectBody()
  const at = body.indexOf('if (wanted > 0) {')
  const imgSeg = body.slice(at)
  const tryAt = imgSeg.indexOf('try {')
  assert.ok(tryAt > 0, '找不到图片段的 try')
  // try 起点到外层 catch 之间
  const outerCatch = imgSeg.indexOf('image-pipeline-crashed')
  assert.ok(outerCatch > tryAt, '找不到外层 catch')
  const inside = imgSeg.slice(tryAt, outerCatch)

  for (const call of ['collectImages(', 'isStickerImage(', 'describeImages(', 'saveImageBlocks(', 'inboundContent(']) {
    assert.ok(inside.includes(call), '★ ' + call + ' 必须在 try 里面')
  }
})

test('⑤ 降级之后**照样注入**（不许在 catch 里 return）', () => {
  const body = injectBody()
  const at = body.indexOf('image-pipeline-crashed')
  assert.ok(at > 0)
  const tail = body.slice(at)
  // 图片段的 catch 结束后，紧跟着应该是注入那段（runMaintenance）
  assert.ok(tail.includes('agent.runMaintenance('),
    '★ 降级完还得继续往下走注入 —— catch 里 return 就等于把这条消息吞了')
  assert.ok(!/catch \(err\) \{[\s\S]{0,400}?return '(error|busy)'/.test(tail),
    '★ 图片段的 catch 里不许 return —— 那正是"忽略下一句话"的成因')
})

// ---- ⑥⑦ ★ relay.js 那个注入 catch 必须落审计（2026-10-20 第三件）-----------
//
// 现场：他报「发完表情后会忽略下一句话」，可 `echo.db` 里什么线索都没有 ——
// 因为那个 catch 只有 `warn(...)`，而 `ctx.logger` 的输出**不落盘**。
// 排查时只能靠 `inbound.jsonl` + `relay_in` 审计 + 时间戳反推，绕了一大圈。

const RELAY = readFileSync(fileURLToPath(new URL('../lib/relay.js', import.meta.url)), 'utf8')

test('⑥ ★ relay 的注入 catch 必须落审计（不许只 warn）', () => {
  assert.match(RELAY, /audit\?\.\('relay_reject', 'inject-threw: '/,
    '★ 只 warn 不落盘 ⇒ 下次 503 还是查不出是哪一行抛的')
  // 而且必须带得动上下文：为什么 + 哪个会话
  const at = RELAY.indexOf("'inject-threw: '")
  assert.ok(at > 0)
  const seg = RELAY.slice(at, at + 260)
  assert.ok(seg.includes('why'), '要带上原因')
  assert.ok(seg.includes('sessionId'), '要带上会话 id（否则多个会话混在一起看不出来）')
})

test('⑦ ★ 审计本身要包 try/catch（不许因为它把消息也搞坏）', () => {
  const at = RELAY.indexOf("'inject-threw: '")
  const before = RELAY.slice(Math.max(0, at - 200), at)
  assert.ok(before.includes('try {'), '★ 审计必须在 try 里 —— 它自己抛了，这条消息就真没了')
  const after = RELAY.slice(at, at + 400)
  assert.ok(after.includes('catch'), '★ 要有 catch 兜住')
})
