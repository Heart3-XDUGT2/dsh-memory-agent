/**
 * 会话分类的电池(v0.41.0 事故修复)。
 *
 * 要钉住的是一件事:**判错的代价不对称**。
 *   · 把子代理会话判成顶层 ⇒ 递归回来了(打分器从子代理里再起子代理,
 *     子代理再起子代理 —— 他报的「卡崩」),**不可接受**;
 *   · 把顶层会话判成子代理 ⇒ 她这一轮少一次情绪读数/一轮记忆,
 *     可接受的损失。
 * 所以判据**只用宿主会话头上那三个字段**,而且「认不出来」一律当顶层
 * (老会话/非宿主对象不会被误伤)。这几条边界就是这份电池的全部内容。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headerOf, delegationDepthOf, isSubagentSession, isTopLevelSession } from '../lib/agent-scope.js'

/** 顶层会话的 agent(宿主 `SessionHeader` 的最小形状)。 */
const rootAgent = () => ({ session: { id: 'session-echo-companion', header: { version: 3, id: 'session-echo-companion', delegationDepth: 0 } } })
/** 子代理会话的 agent —— 字段逐字照抄宿主 `childSessionMeta()`
 *  (`dsh-subagent-in-process-driver/lib/index.js:502-511`)。 */
const childAgent = (depth = 1) => ({
  session: {
    id: 'sub-' + String(depth),
    header: { version: 3, id: 'sub-' + String(depth), parentSession: 'session-echo-companion', origin: 'subagent', delegationDepth: depth }
  }
})

test('v0.41.0 子代理会话认得出来:origin / parentSession / delegationDepth 三选一', () => {
  // 三个字段齐全(宿主真实形状)
  assert.equal(isSubagentSession(childAgent(1)), true)
  // 只带 origin
  assert.equal(isSubagentSession({ session: { header: { origin: 'subagent' } } }), true)
  // 只带 parentSession
  assert.equal(isSubagentSession({ session: { header: { parentSession: 'p' } } }), true)
  // 只带深度
  assert.equal(isSubagentSession({ session: { header: { delegationDepth: 2 } } }), true)
  // session / header 两种形状也要认(调用方常常只拿得到其中一种)
  assert.equal(isSubagentSession({ header: { delegationDepth: 1 } }), true)
  assert.equal(isSubagentSession({ delegationDepth: 1 }), true)
})

test('v0.41.0 顶层会话不被误伤(这是代价不对称的那一侧)', () => {
  assert.equal(isSubagentSession(rootAgent()), false)
  assert.equal(isTopLevelSession(rootAgent()), true)
  // 老会话没有 depth 字段 ⇒ 顶层(与 check-echo-persona 的 sessionDepth 同口径)
  assert.equal(isSubagentSession({ session: { id: 'old', header: { version: 2, id: 'old' } } }), false)
  // 空 parentSession / 空 origin 不算有父
  assert.equal(isSubagentSession({ session: { header: { parentSession: '', origin: '' } } }), false)
  // depth 为 0 / 负数 / 乱填 ⇒ 顶层
  for (const bad of [0, -1, '胡说', null, undefined, NaN]) {
    assert.equal(isSubagentSession({ session: { header: { delegationDepth: bad } } }), false, String(bad))
  }
})

test('v0.41.0 认不出来一律当顶层(绝不因为"读不懂"就把他的会话关掉)', () => {
  for (const x of [null, undefined, 'session', 42, {}, { session: null }, { header: 'x' }, { session: {} }]) {
    assert.equal(isSubagentSession(x), false, JSON.stringify(x))
    assert.equal(isTopLevelSession(x), true)
  }
})

test('v0.41.0 delegationDepthOf:数值/字符串数字都认,缺省 0,负数与小数规整', () => {
  assert.equal(delegationDepthOf(childAgent(3)), 3)
  assert.equal(delegationDepthOf({ session: { header: { delegationDepth: '2' } } }), 2)
  assert.equal(delegationDepthOf({ session: { header: { delegationDepth: 2.7 } } }), 2, '深度是计数,小数向下取整')
  assert.equal(delegationDepthOf(rootAgent()), 0)
  assert.equal(delegationDepthOf(null), 0)
})

test('v0.41.0 headerOf:三种形状各归各位,任意对象不当会话头', () => {
  const header = { delegationDepth: 1 }
  assert.equal(headerOf({ session: { header } }), header, 'agent → session.header')
  assert.equal(headerOf({ header }), header, 'session → header')
  assert.equal(headerOf(header), header, 'header → 自己')
  assert.equal(headerOf({ id: 'x' }), null, '没有三个专属字段的对象不是会话头')
  assert.equal(headerOf({ session: { id: 'x' } }), null, 'session 没有 header ⇒ 认不出来')
})

test('v0.41.0 递归形状(宿主真实的多层委派)逐层都认得', () => {
  // 打分器起 A,A 起 B,B 起 C …… 每一层都得是「子代理」
  let parent = rootAgent()
  for (let d = 1; d <= 4; d += 1) {
    assert.equal(isSubagentSession(parent), d > 1, '第 ' + String(d - 1) + ' 层')
    parent = childAgent(d)
    assert.equal(isSubagentSession(parent), true, '第 ' + String(d) + ' 层必须被认出来(否则递归继续)')
  }
})
