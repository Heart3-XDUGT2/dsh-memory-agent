/**
 * S1-a 电池:`lib/speak.js` 是**渠道无关的嘴**,而且今天必须是**纯转发**。
 *
 * 这一步的验收标准只有一条:**换上 speaker 之后,行为逐字不变**。
 * 所以这个文件里最重要的是第 1 个用例 —— 参数原样进、返回值原样出、
 * 异常照旧往上抛(调用点的 try/catch 才有意义)。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpeaker, formOf, FORM, isHumanForm, NO_CHANNEL_SCOPE, CHANNEL_SHAPE, SERVICE_NAME, SERVICE_VERSION } from '../lib/speak.js'

/** 假传输:记下每一次调用与参数,返回值可指定。 */
function fakeTransport ({ enabled = true, ret = {}, throws = false, statusThrows = false } = {}) {
  const calls = []
  return {
    calls,
    enabled,
    statusThrows,
    status () {
      if (statusThrows) throw new Error('status 炸了')
      return { enabled, pendingTurn: 3 }
    },
    captureSegment (...args) { calls.push(['captureSegment', args]); if (throws) throw new Error('capture 炸了'); return ret.captureSegment ?? true },
    markProactive (...args) { calls.push(['markProactive', args]); return ret.markProactive ?? true },
    finishTurn (...args) { calls.push(['finishTurn', args]); if (throws) throw new Error('finishTurn 炸了'); return ret.finishTurn ?? { queued: 2, channels: 1, chars: 9 } },
    say (...args) { calls.push(['say', args]); return ret.say ?? { ok: true, sent: 1, kind: 'reply', targets: ['a'], chars: 5, scope: 'session' } }
  }
}

test('① 纯转发:参数原样进、返回值原样出、异常照旧往上抛', () => {
  const finishRet = { queued: 7, channels: 2, chars: 42 }
  const transport = fakeTransport({ ret: { finishTurn: finishRet, captureSegment: true } })
  const speaker = createSpeaker({ transport })

  assert.equal(speaker.captureSegment('s-1', '在吗'), true)
  assert.deepEqual(transport.calls[0], ['captureSegment', ['s-1', '在吗']])

  assert.equal(speaker.markProactive('s-1'), true)
  assert.deepEqual(transport.calls[1], ['markProactive', ['s-1']])

  const opts = { proactive: true, kind: 'care' }
  const r = speaker.finishTurn('s-1', opts)
  assert.equal(r, finishRet, '返回值必须是同一个对象(不复制、不改写)')
  assert.deepEqual(transport.calls[2], ['finishTurn', ['s-1', opts]])

  const args = { sessionId: 's-1', text: '晚安', mode: 'call', chat: '3783' }
  assert.equal(speaker.say(args).sent, 1)
  assert.deepEqual(transport.calls[3], ['say', [args]])

  // 异常照旧往上抛:调用点的 try/catch 才接得住
  const throwing = createSpeaker({ transport: fakeTransport({ throws: true }) })
  assert.throws(() => throwing.captureSegment('s', 'x'), /capture 炸了/)
  assert.throws(() => throwing.finishTurn('s', {}), /finishTurn 炸了/)
})

test('② 没有传输 ≠ 崩:形状与 relay 一致(她拿到的理由必须还是那个)', () => {
  const speaker = createSpeaker({})
  assert.equal(speaker.captureSegment('s', 'x'), false)
  assert.equal(speaker.markProactive('s'), false)
  assert.deepEqual(speaker.finishTurn('s', {}), { queued: 0, channels: 0, chars: 0 })
  const r = speaker.say({ sessionId: 's', text: '喂', mode: 'call' })
  assert.deepEqual(Object.keys(r).sort(), ['chars', 'kind', 'ok', 'reason', 'scope', 'sent', 'targets'].sort())
  assert.equal(r.reason, 'no-channel')
  assert.equal(r.kind, 'proactive', 'mode:call ⇒ 主动')
  assert.equal(r.scope, NO_CHANNEL_SCOPE)
  assert.equal(speaker.hasChannel(), false)
  assert.deepEqual(speaker.status().channels, [])
})

test('③ hasChannel 必须与旧门 relayEnabled() 等价(否则工具注册会换行为)', () => {
  assert.equal(createSpeaker({ transport: fakeTransport({ enabled: true }) }).hasChannel(), true)
  assert.equal(createSpeaker({ transport: fakeTransport({ enabled: false }) }).hasChannel(), false)
  // 新插件注册成渠道 ⇒ 即使传输门关着,也有嘴
  const speaker = createSpeaker({ transport: fakeTransport({ enabled: false }) })
  const off = speaker.registerChannel({ name: 'qq', send () {}, status: () => ({ ok: true }) })
  assert.equal(speaker.hasChannel(), true)
  off()
  assert.equal(speaker.hasChannel(), false, '注销后回到传输的门')
  // status() 炸了不能把门变成 true
  assert.equal(createSpeaker({ transport: fakeTransport({ statusThrows: true }) }).hasChannel(), false)
})

test('④ 送到回执:钩子全收到、互不牵连、注销生效、空行不触发', () => {
  const speaker = createSpeaker({ transport: fakeTransport() })
  const got = []
  const bad = () => { throw new Error('钩子炸了') }
  speaker.onDelivered(bad)
  const off = speaker.onDelivered((rows, meta) => got.push(['a', rows.length, meta]))
  speaker.onDelivered((rows) => got.push(['b', rows.length]))

  const rows = [{ kind: 'proactive', id: 'o-1' }]
  const fired = speaker.noteDelivered(rows, { channel: 'qq' })
  assert.equal(fired, 2, '炸掉的那个不算,另外两个照样跑')
  assert.deepEqual(got, [['a', 1, { channel: 'qq' }], ['b', 1]])
  assert.equal(speaker.noteDelivered([]), 0, '空行不吵钩子')
  off()
  got.length = 0
  speaker.noteDelivered(rows)
  assert.deepEqual(got, [['b', 1]], '注销后只剩另一个')
})

test('⑤ 渠道表视图由外面注入(speak 不认识 store)', () => {
  const view = {
    ofSession: (sid) => (sid === 's-1' ? [{ chatId: '3783', label: '他' }] : []),
    all: () => [{ chatId: '3783' }, { chatId: '9' }]
  }
  const speaker = createSpeaker({ transport: fakeTransport(), channelView: view })
  assert.deepEqual(speaker.targets('s-1'), [{ chatId: '3783', label: '他' }])
  assert.deepEqual(speaker.targets('other'), [])
  assert.equal(speaker.allTargets().length, 2)
  // 视图自己炸了 ⇒ 空表,不往上抛(提示词段是纯增益,不该因它断)
  const broken = createSpeaker({ channelView: { ofSession () { throw new Error('x') }, all () { throw new Error('y') } } })
  assert.deepEqual(broken.targets('s-1'), [])
  assert.deepEqual(broken.allTargets(), [])
})

test('⑥ 注册渠道:空名拒;一览含传输;一个渠道炸了不拖垮整张表;dispose 收尾', () => {
  const speaker = createSpeaker({ transport: fakeTransport() })
  assert.throws(() => speaker.registerChannel({}), /需要 channel.name/)
  let closed = 0
  speaker.registerChannel({ name: 'qq', send () {}, status: () => ({ clients: 1 }), close: () => { closed += 1 } })
  speaker.registerChannel({ name: 'bad', send () {}, status: () => { throw new Error('炸') } })
  const list = speaker.list()
  assert.equal(list.length, 3, 'qq + bad + http')
  assert.deepEqual(list.find((x) => x.name === 'qq'), { name: 'qq', clients: 1 })
  assert.equal(list.find((x) => x.name === 'bad').error, 'status-failed', '炸的那个被隔离成一条记录')
  assert.equal(list.find((x) => x.name === 'http').enabled, true, '传输自身也在表里')
  speaker.dispose()
  assert.equal(closed, 1, 'dispose 要 close 每个渠道')
  assert.equal(speaker.isDisposed(), true)
  assert.equal(speaker.hasChannel(), true, '传输还在(dispose 只管注册的渠道,不动传输)')
})

test('⑦ 钉子:没有渠道时的归属地字面量仍是 global(历史数据与审查台依赖)', () => {
  assert.equal(NO_CHANNEL_SCOPE, 'global')
  assert.equal(CHANNEL_SHAPE.name, 'string')
})

test('⑧ form 归一:旧值 relay 是别名,今天的行为不变', () => {
  assert.equal(formOf('relay'), FORM.INBOUND, "旧字面量 'relay' → 'inbound'")
  assert.equal(formOf('care'), 'care')
  assert.equal(formOf('reminder'), 'reminder')
  assert.equal(formOf('say_again'), 'say_again')
  assert.equal(formOf('snapshot'), 'snapshot', '认不出的原样返回,不猜')
  assert.equal(formOf(undefined), '')
  // 「他的话」= relay(旧写法) / inbound(新写法) / care 三种都算,其余不算
  assert.equal(isHumanForm('relay'), true)
  assert.equal(isHumanForm('inbound'), true)
  assert.equal(isHumanForm('care'), true)
  assert.equal(isHumanForm('snapshot'), false, '记忆/心情快照不是他的话')
  assert.equal(isHumanForm('mind'), false)
  assert.equal(isHumanForm(''), false)
  // 与 turn-query.js 原来的集合 {'relay','care'} 逐项等价 —— **对今天真在写的旧拼写**。
  // (新拼写 'inbound' 是有意多认的:今天没有任何一处写它,写入侧要到 S3 才切,
  //  所以"现在行为不变"这句话成立。)
  const before = new Set(['relay', 'care'])
  for (const v of ['relay', 'care', 'reminder', 'mind', 'say_again', 'snapshot', '', undefined, 'garbage']) {
    assert.equal(isHumanForm(v), before.has(String(v)), 'form=' + String(v))
  }
  assert.equal(isHumanForm('inbound'), true, '归一后的新拼写也被认(为 S3 的写入侧切换留好路)')
})

test('⑨ 扇出:入队才喊(rows>0),沉默/没渠道一律不喊', () => {
  const seen = []
  // ① 真入队了 ⇒ 喊一次,并且带的是"有活儿"的信号(不是正文)
  const t1 = fakeTransport({ ret: { finishTurn: { queued: 1, channels: 1, chars: 12, scope: 'session', bubbles: 1, rows: 3 } } })
  const s1 = createSpeaker({ transport: t1 })
  s1.onOutbound((p) => seen.push(p))
  s1.finishTurn('s-1', { kind: 'reply' })
  assert.equal(seen.length, 1, '入队成功必须喊一声')
  assert.deepEqual(seen[0], { kind: 'queued', sessionId: 's-1', rows: 3, queued: 1, scope: 'session', turnKind: 'reply' })

  // ② 没入队(held / 没渠道 / 超长沉默)⇒ 一声不吭,而且返回值和以前一模一样
  for (const ret of [
    { queued: 0, channels: 0, chars: 0 },
    { queued: 0, channels: 0, chars: 200, silent: 'too-long', limit: 120 }
  ]) {
    const s = createSpeaker({ transport: fakeTransport({ ret: { finishTurn: ret } }) })
    let n = 0
    s.onOutbound(() => { n += 1 })
    const r = s.finishTurn('s-1', {})
    assert.equal(r, ret, '返回值必须是同一个对象')
    assert.equal(n, 0, '没入队就别喊:' + JSON.stringify(ret))
  }

  // ③ 她的手 say():真的发出去了(sent>0)也喊一声
  const seen2 = []
  const t3 = fakeTransport({ ret: { say: { ok: true, sent: 2, kind: 'proactive', targets: ['qq:1'], chars: 9, scope: 'global' } } })
  const s3 = createSpeaker({ transport: t3 })
  s3.onOutbound((p) => seen2.push(p))
  s3.say({ sessionId: 's-2', text: '在吗', mode: 'call' })
  assert.equal(seen2.length, 1)
  assert.equal(seen2[0].kind, 'sent')
  assert.equal(seen2[0].rows, 2)
  // 发不出去(sent=0)不喊
  const s4 = createSpeaker({ transport: fakeTransport({ ret: { say: { ok: false, reason: 'no-channel', sent: 0, kind: 'reply', targets: [], chars: 0 } } }) })
  let n4 = 0
  s4.onOutbound(() => { n4 += 1 })
  s4.say({ sessionId: 's-2', text: '在吗' })
  assert.equal(n4, 0)
})

test('⑩ 扇出:钩子互不牵连、退订生效、没有订阅者时是零操作', () => {
  const t = fakeTransport({ ret: { finishTurn: { queued: 1, channels: 1, chars: 3, rows: 1 } } })
  const speaker = createSpeaker({ transport: t })
  const order = []
  const offBad = speaker.onOutbound(() => { order.push('bad'); throw new Error('钩子炸了') })
  const offGood = speaker.onOutbound(() => { order.push('good') })
  assert.equal(speaker.notifyOutbound({ kind: 'queued' }), 1, '抛错的那个**不计入**叫醒数(隔离 + warn 记账),好的那个照旧')
  assert.deepEqual(order, ['bad', 'good'], '一个抛错不能挡住另一个')
  assert.deepEqual(t.calls, [], 'notifyOutbound 只管喊,不碰传输')
  offGood()
  order.length = 0
  assert.equal(speaker.notifyOutbound({ kind: 'queued' }), 0, '只剩那个抛错的 ⇒ 成功数 0(但它照样被叫到了)')
  assert.deepEqual(order, ['bad'], '抛错的钩子也真的被调用了(不是被跳过)')
  offBad()
  assert.equal(speaker.notifyOutbound({ kind: 'queued' }), 0, '全退了就是零操作')
  assert.equal(speaker.status().outboundHooks, 0)
  // 非函数入参不炸也不登记
  assert.equal(typeof speaker.onOutbound(null), 'function')
  assert.equal(speaker.status().outboundHooks, 0)
})

test('⑪ 扇出:dispose 清订阅;服务名/版本是钉子(跨仓靠字面量对齐)', () => {
  const speaker = createSpeaker({ transport: fakeTransport() })
  speaker.onOutbound(() => {})
  assert.equal(speaker.status().outboundHooks, 1)
  speaker.dispose()
  assert.equal(speaker.status().outboundHooks, 0)
  assert.equal(SERVICE_NAME, 'echo:relay')
  assert.equal(SERVICE_VERSION, 1)
})

test('⑫ 非递归那半边:hasRegisteredChannels() 不看 transport(S3-b 的门要用它)', () => {
  // 传输自己报"门关着"(总闸关/token 空)
  const speaker = createSpeaker({ transport: fakeTransport({ enabled: false }) })
  assert.equal(speaker.hasChannel(), false, '没渠道 + 传输关 ⇒ 没嘴')
  assert.equal(speaker.hasRegisteredChannels(), false)
  assert.equal(speaker.status().registeredChannels, 0)

  const off = speaker.registerChannel({ name: 'qq' })
  assert.equal(speaker.hasRegisteredChannels(), true, '注册了就是有嘴')
  assert.equal(speaker.hasChannel(), true, 'hasChannel 也跟着开(channels.size 短路,不会去问 transport)')
  assert.equal(speaker.status().registeredChannels, 1)

  off()
  assert.equal(speaker.hasRegisteredChannels(), false, '注销即回关')
  assert.equal(speaker.hasChannel(), false)
})

test('⑬ 递归陷阱有护栏:非递归那半边绝不碰 transport.status()', () => {
  // 造一个"status() 会回头问 hasChannel()"的传输(= index.js 若接错线会发生的事):
  // 门只要走非递归那半边,就一次都不会去问 transport。
  // (反面证据在 tests/relay-gate.test.js ④:把 hasChannel() 接成门 ⇒ 栈溢出)
  let speaker = null
  let statusCalls = 0
  const transport = {
    status () {
      statusCalls += 1
      if (speaker !== null) speaker.hasChannel() // 故意摸一下:它若转回来问 status(),这里就炸栈
      return { enabled: false }
    }
  }
  speaker = createSpeaker({ transport })
  assert.equal(speaker.hasRegisteredChannels(), false)
  assert.equal(statusCalls, 0, '非递归半边不看 transport')
  speaker.registerChannel({ name: 'qq' })
  assert.equal(speaker.hasRegisteredChannels(), true)
  assert.equal(statusCalls, 0, '注册之后也不问')
  speaker.unregisterChannel('qq')
  assert.equal(speaker.hasRegisteredChannels(), false)
  assert.equal(statusCalls, 0, '注销之后也不问')
})
