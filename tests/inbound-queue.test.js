/**
 * 忙时入站队列 —— 2026-10-18
 * ==================================================================
 * 他拍的口径：「只修忙时排队」（非主人进记忆那条**不动**）。
 *
 * 现场（journal 实测，500 行内）：
 *   非主人群消息 成功进轮 187 / **撞上她忙、重试耗尽 52**
 *
 * 链路：`injectInbound` 拿 `agent.runMaintenance(...)` 当互斥锁，而 DSH 侧
 *   `dsh-agent-loop/lib/index.js:823`
 *       `if (this.phase.kind !== "idle") throw new Error("already has active work")`
 *   ⇒ **抛错**（不是排队）⇒ 适配器重试 6 次 ≈22.5 秒 ⇒ 耗尽即丢。
 *
 * 但 DSH 的 inbox **本来就是无损队列**：
 *   `agent.followup` → `inbox.splice('next-turn')`，
 *   turn 收尾时 `dsh-agent-loop/lib/index.js:1035`
 *       `if (!this.inbox.hasPending) return false;  return true;`
 *   ⇒ 还有待处理消息就自己开下一轮。
 *   卡住它的从来不是 inbox，是外面那道互斥锁。
 *
 * 那为什么还要自己的队列？因为 `inbox` **没有上限**，而他要一个（"比如 50 条"）。
 * ⇒ 消息先落我们的队列，一条一条交给 DSH：**上限我们守，消费交给 DSH 保证**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  createInboundQueue,
  clampQueueLimit,
  DEFAULT_INBOUND_QUEUE_LIMIT,
  INBOUND_QUEUE_LIMIT_MIN,
  INBOUND_QUEUE_LIMIT_MAX
} from '../lib/inbound-queue.js'

const item = (id) => ({ env: { msgId: id, senderName: '张三' }, text: 'x' + id })

test('① clampQueueLimit：默认 50，越界夹回 1~200', () => {
  assert.equal(DEFAULT_INBOUND_QUEUE_LIMIT, 50)
  assert.equal(INBOUND_QUEUE_LIMIT_MIN, 1)
  assert.equal(INBOUND_QUEUE_LIMIT_MAX, 200)
  assert.equal(clampQueueLimit(undefined), 50, '没配 ⇒ 默认 50')
  assert.equal(clampQueueLimit(0), 1, '0 ⇒ 下限 1')
  assert.equal(clampQueueLimit(-5), 1, '负数 ⇒ 1')
  assert.equal(clampQueueLimit(999), 200, '超上限 ⇒ 200')
  assert.equal(clampQueueLimit('abc'), 50, '非数 ⇒ 默认')
  assert.equal(clampQueueLimit(7.9), 7, '取整')
})

test('② 忙时消息入队、不丢（核心）', () => {
  const q = createInboundQueue({ limit: 50 })
  const r = q.push(item('m1'))
  assert.equal(r.accepted, true)
  assert.equal(r.dropped, null, '没满就不该丢')
  assert.equal(q.size(), 1)
  assert.equal(q.peek()?.env?.msgId, 'm1', '队头是它')
})

test('③ ★ 队列满时丢**最旧的**（留最新的）', () => {
  const q = createInboundQueue({ limit: 3 })
  q.push(item('a'))
  q.push(item('b'))
  q.push(item('c'))
  const r = q.push(item('d'))     // 满 ⇒ 挤掉 a
  assert.notEqual(r.dropped, null, '★ 满了必须报"丢了谁"')
  assert.equal(r.dropped.env.msgId, 'a', '★ 丢的是最旧的 a，不是 d')
  assert.equal(q.size(), 3)
  // 队列里现在是 b, c, d
  assert.equal(q.peek()?.env?.msgId, 'b')
})

test('④ 队列上限**活读**（面板改了立刻生效，不用重建队列）', () => {
  let cap = 10
  const q = createInboundQueue({ limit: () => cap })
  for (let i = 0; i < 10; i++) q.push(item('x' + i))
  assert.equal(q.size(), 10)
  cap = 3                                  // 调小
  const r = q.push(item('over'))           // 这一 push 会一次挤掉到 3
  assert.equal(q.size(), 3, '★ 上限改小后立刻按新上限裁')
  assert.notEqual(r.dropped, null)
})

test('⑤ FIFO：取出的顺序 = 进来的顺序', () => {
  const q = createInboundQueue({ limit: 10 })
  for (const id of ['a', 'b', 'c']) q.push(item(id))
  assert.equal(q.shift()?.env?.msgId, 'a')
  assert.equal(q.shift()?.env?.msgId, 'b')
  assert.equal(q.shift()?.env?.msgId, 'c')
  assert.equal(q.shift(), null, '空了 ⇒ null')
})

test('⑥ 空队列 / 坏入参不许炸', () => {
  const q = createInboundQueue({})
  assert.equal(q.peek(), null)
  assert.equal(q.shift(), null)
  assert.equal(q.size(), 0)
  const r = q.push(null)
  assert.equal(r.accepted, false, 'null 不入队')
  assert.equal(q.size(), 0)
})

test('⑦ status()：能看出排了几条、丢过几条', () => {
  const q = createInboundQueue({ limit: 2 })
  q.push(item('a'))
  q.push(item('b'))
  q.push(item('c'))     // 挤掉 a
  q.shift()             // 取走 b
  const st = q.status()
  assert.equal(st.size, 1)
  assert.equal(st.limit, 2)
  assert.equal(st.accepted, 3, '一共收过 3 条')
  assert.equal(st.dropped, 1, '丢过 1 条')
  assert.equal(st.taken, 1, '取走 1 条')
})

test('⑧ 静态闸：主包必须把 busy 变成入队，而不是回 busy 让人重试', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  // 拆分：raw 注入（忙就报 busy）+ 包装（busy ⇒ 入队）
  assert.ok(src.includes('async function injectInboundNow'), '要有 raw 版（忙就返回 busy）')
  assert.ok(src.includes('async function injectInbound ('), '要有包装版')
  assert.ok(src.includes('async function flushInboundQueue'), '要有冲刷循环')
  // 包装里 busy ⇒ push 且返回 queued
  const at = src.indexOf('async function injectInbound (')
  // ★ 2026-10-20：**切成"到函数尾"而不是固定 900 字** ——
  //   图片暂存让这个函数变长了，写死窗口会漏看后半段。
  //   收尾取下一个顶层函数名（flushInboundQueue），比数字稳。
  const endAt = src.indexOf('async function flushInboundQueue', at)
  assert.ok(endAt > at, '找不到 injectInbound 的收尾')
  const block = src.slice(at, endAt)
  assert.match(block, /if \(r !== 'busy'\) return r/, '非忙直接透传')
  assert.ok(block.includes('inboundQueue.push('), '★ busy ⇒ 入队')
  assert.ok(block.includes("return 'queued'"), '★ 返回 queued（不是 busy）')
  // 声明必须在定义之前（防 TDZ —— 这个坑之前踩过一次）
  const declAt = src.indexOf('const inboundQueue = createInboundQueue(')
  assert.ok(declAt > 0 && declAt < at, '★ 队列声明必须在 injectInbound 之前（防 TDZ）')
})

test('⑨ 静态闸：relay 必须把 queued 当受理成功（不许回 503）', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/relay.js', import.meta.url)), 'utf8')
  assert.ok(src.includes("result !== 'ok' && result !== 'queued'"),
    "★ queued 必须走「受理成功」那条路 —— 回 503 就又变成重试→丢")
  // 而且不许再有裸的 result !== 'ok'（那会把 queued 当失败）
  const bare = (src.match(/if \(result !== 'ok'\)/g) || []).length
  assert.equal(bare, 0, '★ 不许留着裸的 `result !== \'ok\'`')
  assert.ok(src.includes("Promise<'ok'|'queued'|'busy'|'error'>"), 'JSDoc 签名要标出 queued')
  // ★ 2026-10-20：`stashed` 那条已撤（图片-only 现在照常注入，只是明说"不用回"）——
  //   验收方式反过来：**签名里不该再有它**，受理判定也不该认它。
  assert.equal(src.includes("'stashed'"), false, '★ 暂存撤掉后不该再有 stashed')
})

test('⑩ 静态闸：队列上限进配置（默认 50），且插在 toggle 的 settings 里', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/toggle.js', import.meta.url)), 'utf8')
  assert.ok(src.includes('inboundQueueLimit: 50'), '默认值 50')
  assert.ok(src.includes('clampInt(r.inboundQueueLimit, 1, 200'), '解析时夹 1~200')
})
