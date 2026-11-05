/**
 * C3 工具面用例:**她自己动手说话时踩了清单,必须回一句人话原因 —— 不静默丢**
 * (验收条款出自 `docs/PLAN_LAND_ALL.md:230`:`check_tools.mjs` 加"踩禁词"用例)。
 *
 * 两种动作分得很清:
 *   · flag(默认)⇒ `ok:true`(照发),但结果里带 `words` + `note`,渲染文案也带提醒;
 *   · hold       ⇒ `ok:false` + `reason:'guard-hold'` + 人话 `note`,而且**桥一次都不许被调**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relayToolDefinitions, explainRelayFailure, lossless } from '../lib/relay-tools.js'

function fakeRelay ({ ok = true } = {}) {
  const calls = []
  return {
    calls,
    say (args) { calls.push(args); return { ok, sent: ok ? 1 : 0, targets: ok ? ['私聊'] : [], chars: String(args.text).length, scope: 'session', kind: args.mode, reason: ok ? undefined : 'no-channel' } }
  }
}

const defsOf = (relay, guard) => {
  const defs = relayToolDefinitions({ relay, isEnabled: () => true, sessionEnabledOf: () => true, audit: () => { }, guard })
  return { say: defs.find((d) => d.name === 'echo_qq_say'), call: defs.find((d) => d.name === 'echo_qq_call') }
}

const execOf = (sid = 'sess-1') => ({ agent: { session: { id: sid } } })

test('C3 工具面:没有 guard(老宿主)⇒ 行为一个字不变', async () => {
  const relay = fakeRelay()
  const { say } = defsOf(relay, undefined)
  const out = await say.execute({ text: '在的' }, execOf())
  assert.equal(out.ok, true)
  assert.equal(Object.hasOwn(out, 'words'), false, '没命中就不该有 words 这个键')
  assert.equal(Object.hasOwn(out, 'note'), false)
  assert.equal(relay.calls.length, 1)
})

test('C3 工具面:flag ⇒ 照发 + 把词与理由回给她(不静默)', async () => {
  const relay = fakeRelay()
  const guard = (text) => ({ ok: true, text, words: ['一抹', '弧度'], reason: '这句话里有 2 个"不像你说的"词:一抹、弧度。换成你自己的说法再说一遍 —— 别用小说腔。' })
  const { say } = defsOf(relay, guard)
  const out = await say.execute({ text: '嘴角有一抹弧度' }, execOf())
  assert.equal(out.ok, true)
  assert.deepEqual(out.words, ['一抹', '弧度'])
  assert.match(out.note, /不像你说的/)
  assert.equal(relay.calls.length, 1, '照发 = 桥真的被调了')
  const rendered = say.output.render({ text: '嘴角有一抹弧度' }, out)[0].text
  assert.match(rendered, /提醒:/, '她得在工具返回里看到这句提醒')
  const losslessOk = lossless(out)
  assert.equal(typeof losslessOk, 'object')
})

test('C3 工具面:hold ⇒ 不发,并说清是哪个词(桥一次都不许被调)', async () => {
  const relay = fakeRelay()
  const guard = () => ({ ok: false, text: '嘴角有一抹弧度', words: ['一抹'], reason: '这句话里有 1 个"不像你说的"词:一抹。' })
  const { say } = defsOf(relay, guard)
  const out = await say.execute({ text: '嘴角有一抹弧度' }, execOf())
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'guard-hold')
  assert.deepEqual(out.words, ['一抹'])
  assert.equal(relay.calls.length, 0, '压住不发 —— 桥根本不该被碰')
  const rendered = say.output.render({ text: '嘴角有一抹弧度' }, out)[0].text
  assert.match(rendered, /没发出去/)
  assert.match(rendered, /不像你说的词/)
  assert.equal(explainRelayFailure('guard-hold'), '这句话里有不像你说的词,我没替你发出去 —— 换上你自己的说法再来')
})

test('C3 工具面:mask ⇒ 发的是换过的文本(改过的话也回一句说明)', async () => {
  const relay = fakeRelay()
  const guard = () => ({ ok: true, text: '嘴角有…弧度', words: ['一抹'], reason: '换过一次词' })
  const { say } = defsOf(relay, guard)
  const out = await say.execute({ text: '嘴角有一抹弧度' }, execOf())
  assert.equal(out.ok, true)
  assert.equal(relay.calls[0].text, '嘴角有…弧度', '发出去的必须是换过的')
  assert.match(out.note, /换过一次词/)
})

test('C3 工具面:检查器自己炸了 ⇒ 照原文发(绝不因为她说话而报错)', async () => {
  const relay = fakeRelay()
  const guard = () => { throw new Error('检查器炸了') }
  const { say } = defsOf(relay, guard)
  const out = await say.execute({ text: '在的' }, execOf())
  assert.equal(out.ok, true)
  assert.equal(out.note, undefined)
})

test('C3 工具面:结果 schema 声明了 words/note(漏声明 = 整个工具输出被宿主拒掉)', async () => {
  const relay = fakeRelay()
  const { say } = defsOf(relay, undefined)
  const schema = say.output.schema
  assert.equal(schema.additionalProperties, false)
  assert.ok(Object.hasOwn(schema.properties, 'words'))
  assert.ok(Object.hasOwn(schema.properties, 'note'))
})
