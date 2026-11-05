/**
 * 她自己的手(echo_qq_say / echo_qq_call)—— 工具层电池。
 *
 * 这里盯的是**她的自我认识**能不能成立:
 *   · 桥关着 / 会话不在射程里 → 这只手不该出现,或明确告诉她不行
 *   · 发出去 → 回执里说清「发到了哪」,这句话会进她的上下文
 *   · 发不出去 → 用人话解释(不是 `no-channel` 这种代码词),她也读得懂
 *
 * 真桥行为(入队/闸/租约)由 tests/relay.test.js 盯;宿主 defineTool 的
 * schema 校验在 `npm run check:tools`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relayToolDefinitions, explainRelayFailure } from '../lib/relay-tools.js'

/**
 * 宿主的**第二道**校验:工具输出必须是「无损 JSON」。
 * 2026-09-26 现场就炸在这:成功时 `reason: undefined` —— 键在、值 undefined,
 * JSON 往返一次键就没了,宿主判「value is not lossless JSON」,整条回执被拒
 * (消息其实已经发出去了,她因此以为没发出去)。
 * 判据一句话:对象过一遍 JSON 往返,得**原样**回来。
 */
function assertLossless (label, value) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value,
    label + ' 不是无损 JSON(键在、值 undefined 是常见原因)')
  const walk = (v, path) => {
    if (v === undefined) assert.fail(label + ' 里 ' + path + ' 是 undefined')
    if (typeof v === 'number' && !Number.isFinite(v)) assert.fail(label + ' 里 ' + path + ' 不是有限数')
    if (typeof v === 'function' || typeof v === 'bigint' || typeof v === 'symbol') {
      assert.fail(label + ' 里 ' + path + ' 不是 JSON 值(' + typeof v + ')')
    }
    if (v !== null && typeof v === 'object') {
      for (const [k, sub] of Object.entries(v)) walk(sub, path + '.' + k)
    }
  }
  walk(value, '$')
}

/** 假桥:只记下她被要求说了什么。 */
function tools (opts = {}) {
  const calls = { say: [], audit: [] }
  const defs = relayToolDefinitions({
    relay: {
      say: (o) => {
        calls.say.push(o)
        return opts.result ?? { ok: true, sent: 1, kind: 'reply', targets: ['QQ:私聊'], chars: o.text.length }
      }
    },
    isEnabled: () => opts.enabled !== false,
    sessionEnabledOf: (sid) => (opts.inScope === false ? false : sid === 'session-echo-companion'),
    audit: (label, tool) => calls.audit.push({ label, tool })
  })
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  return { defs, byName, calls, exec: { agent: { session: { id: opts.sid ?? 'session-echo-companion' } } } }
}

test('两个工具:回他(echo_qq_say)和喊他(echo_qq_call)分开 —— 她的自我认识靠名字', () => {
  const t = tools()
  assert.deepEqual(t.defs.map((d) => d.name), ['echo_qq_say', 'echo_qq_call'])
  // 描述里必须写明「这是你的手,不是你的嘴」这层意思,否则她还是不知道
  assert.ok(/手/.test(t.byName.echo_qq_say.description))
  assert.ok(/主动/.test(t.byName.echo_qq_call.description))
})

test('发出去 → 走 reply / call 两条路,并把结果告诉她是哪条路', async () => {
  const t = tools()
  const r1 = await t.byName.echo_qq_say.execute({ text: '在的' }, t.exec)
  assert.equal(r1.ok, true)
  assert.deepEqual(t.calls.say[0], { sessionId: 'session-echo-companion', text: '在的', mode: 'reply', chat: '' })
  assert.equal(t.calls.audit[0].tool, 'echo_qq_say')

  const r2 = await t.byName.echo_qq_call.execute({ text: '想你了' }, t.exec)
  assert.equal(r2.ok, true)
  assert.equal(t.calls.say[1].mode, 'call')
  assert.equal(t.calls.audit[1].tool, 'echo_qq_call')
})

test('回执:发到了哪要写清楚(这样「我说过没有」她自己心里有数)', async () => {
  const t = tools()
  const out = [{ type: 'text', text: '' }]
  const value = { ok: true, sent: 1, targets: ['QQ:私聊'], chars: 3 }
  const blocks = t.byName.echo_qq_say.output.render({ text: '在的' }, value)
  assert.ok(blocks[0].text.includes('QQ:私聊'))
  assert.ok(blocks[0].text.includes('在的'))
  // 多处送达时要说几处(同一句话跳到所有平台是事故)
  const many = t.byName.echo_qq_say.output.render({ text: 'x' }, { ok: true, sent: 3, targets: ['a', 'b', 'c'] })
  assert.ok(many[0].text.includes('3'))
  assert.equal(out.length, 1)
})

test('每一条出口都得是无损 JSON(宿主第二道校验,2026-09-26 就炸在这)', async () => {
  // 五条出口:成功、桥关、不在射程、空文本、桥说发不出去
  const ok = tools()
  assertLossless('成功', await ok.byName.echo_qq_say.execute({ text: '在的' }, ok.exec))
  assertLossless('成功(call)', await ok.byName.echo_qq_call.execute({ text: '想你了' }, ok.exec))

  const off = tools({ enabled: false })
  assertLossless('桥关', await off.byName.echo_qq_say.execute({ text: '在的' }, off.exec))

  const out = tools({ inScope: false })
  assertLossless('不在射程', await out.byName.echo_qq_say.execute({ text: '在的' }, out.exec))

  const t = tools()
  assertLossless('空文本', await t.byName.echo_qq_say.execute({ text: ' ' }, t.exec))
  assertLossless('拿不到会话', await t.byName.echo_qq_say.execute({ text: 'x' }, { agent: null }))

  const fail = tools({ result: { ok: false, reason: 'no-channel', sent: 0, targets: [], chars: 0, scope: 'global' } })
  const failed = await fail.byName.echo_qq_say.execute({ text: '在的' }, fail.exec)
  assertLossless('桥拒绝', failed)
  // 成功那条**不该有** reason 这个键(不是 reason: undefined)
  const success = await ok.byName.echo_qq_say.execute({ text: '在的' }, ok.exec)
  assert.ok(!('reason' in success), '成功时不该带 reason 键')
  assert.equal(success.kind, 'reply')
  assert.equal(success.scope, 'session')
})

test('发不出去:用人话解释,不是代码词', async () => {
  const cases = [
    ['bridge-off', '桥关着'],
    ['no-channel', '一个平台聊天都没绑上来'],
    ['scope', '范围闸']
  ]
  for (const [reason, hint] of cases) {
    assert.ok(explainRelayFailure(reason).includes(hint), reason + ' 要说人话')
  }
  const t = tools({ result: { ok: false, reason: 'no-channel', sent: 0, targets: [], chars: 0 } })
  const blocks = t.byName.echo_qq_say.output.render({ text: '在的' }, { ok: false, reason: 'no-channel' })
  assert.ok(blocks[0].text.includes('一个平台聊天都没绑上来'))
  assert.ok(!blocks[0].text.includes('no-channel'), '别把代码词甩给她')
})

test('回执:走全库渠道时要说出来(免得她以为他在这个窗口里就看得见)', () => {
  const t = tools()
  const global = t.byName.echo_qq_say.output.render({ text: '喂' },
    { ok: true, sent: 1, targets: ['QQ:私聊'], scope: 'global' })
  assert.ok(global[0].text.includes('这个窗口没连平台'), '→ ' + global[0].text)
  const local = t.byName.echo_qq_say.output.render({ text: '喂' },
    { ok: true, sent: 1, targets: ['QQ:私聊'], scope: 'session' })
  assert.ok(!local[0].text.includes('这个窗口没连平台'))
})

test('门:桥关着 / 会话不在射程 / 没给内容 → 都不发,且理由能说清', async () => {
  const off = tools({ enabled: false })
  assert.equal((await off.byName.echo_qq_say.execute({ text: '在的' }, off.exec)).reason, 'bridge-off')
  assert.equal(off.calls.say.length, 0)

  const outScope = tools({ inScope: false })
  const r = await outScope.byName.echo_qq_say.execute({ text: '在的' }, outScope.exec)
  assert.equal(r.reason, 'out-of-scope')
  assert.equal(outScope.calls.say.length, 0, '工作会话不该能往 QQ 说话')

  const t = tools()
  assert.equal((await t.byName.echo_qq_say.execute({ text: '   ' }, t.exec)).reason, 'empty')
  assert.equal((await t.byName.echo_qq_say.execute({ text: 'x' }, { agent: null })).reason, 'no-session')
  assert.equal(t.calls.say.length, 0)
})

test('chat 参数会原样交给她要的那条渠道', async () => {
  const t = tools()
  await t.byName.echo_qq_say.execute({ text: '带句话', chat: 'group' }, t.exec)
  assert.equal(t.calls.say[0].chat, 'group')
})
