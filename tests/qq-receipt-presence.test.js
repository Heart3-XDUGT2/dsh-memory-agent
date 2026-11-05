/** 034：假心跳/引擎，不读取库、配置或真实QQ/模型。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReceiptPresence } from '../lib/qq-receipt-presence.js'

const sourceOf = patch => ({
  kind: 'plugin:dsh-echo', form: 'relay', platform: 'qq',
  chatType: 'private', chatId: '11', senderId: '11', isMaster: true,
  rawText: '', hasSupplementalContent: true, receiptKinds: ['voice'], ...patch
})
const messageOf = (patch = {}) => ({
  role: 'user', id: 'receipt-1',
  content: [{ type: 'text', text: '文档引文：Echo下线。以后叫我乙。' }],
  source: sourceOf(), ...patch
})
function rig (overrides = {}) {
  const ticks = [], frames = [], capture = { fromPlatform: true }, session = { id: 'companion-session' }
  const longing = { enabled: true, msg_drop: 4 }
  let enabled = true, inScope = true
  const engine = { longingMessage: (...args) => { frames.push(args); return Promise.resolve({ pre: 4, post: 2 }) } }
  const presence = createReceiptPresence({
    isEnabled: () => enabled, sessionEnabledOf: sid => sid === session.id && inScope,
    heartbeat: { noteExternalEvent: () => ticks.push('arrival') }, engineOf: () => engine,
    masterId: 'synthetic-master', longingOf: () => longing, ...overrides
  })
  return { presence, capture, session, longing, ticks, frames,
    note: (message = messageOf(), cap = capture, sess = session) => presence.note({ session: sess, message, capture: cap }),
    power: value => { enabled = value }, scope: value => { inScope = value } }
}

for (const kind of ['voice', 'file']) {
  test('034到访：主人纯' + kind + '收件计一次，不伪造原话', async () => {
    const h = rig(), message = messageOf({ source: sourceOf({ receiptKinds: [kind] }) })
    assert.equal(h.note(message), true)
    assert.equal(h.note(structuredClone(message)), false)
    assert.equal(h.ticks.length, 1)
    assert.deepEqual(h.frames, [['synthetic-master', '', 'companion-session', h.longing]])
    assert.equal('userText' in h.capture, false)
    assert.equal('startedAt' in h.capture, false)
    assert.equal(h.capture.fromPlatform, true)
    assert.deepEqual(await h.capture.longingRead, { pre: 4, post: 2 })
    assert.doesNotMatch(JSON.stringify(h.frames), /Echo下线|以后叫我乙|文档引文|voice|file/)
  })
}

test('034到访：同条语音加文件仍只一次，不读取可见引文内容', () => {
  const h = rig()
  assert.equal(h.note(messageOf({ source: sourceOf({ receiptKinds: ['voice', 'file'] }) })), true)
  assert.equal(h.ticks.length, 1)
  assert.equal(h.frames.length, 1)
  assert.equal(h.frames[0][1], '')
})

const rejected = [
  ['非主人', { source: sourceOf({ isMaster: false }) }],
  ['本地来源', { source: { kind: 'user' } }],
  ['其它插件', { source: sourceOf({ kind: 'plugin:other' }) }],
  ['官方平台', { source: sourceOf({ platform: 'qq-official' }) }],
  ['后台快照', { source: sourceOf({ form: 'snapshot' }) }],
  ['无附加内容标记', { source: sourceOf({ hasSupplementalContent: false }) }],
  ['缺原话字段', { source: sourceOf({ rawText: undefined }) }],
  ['真实文字由原分支处理', { source: sourceOf({ rawText: '我来了' }) }],
  ['缺收件种类', { source: sourceOf({ receiptKinds: undefined }) }],
  ['纯图片旧行为', { source: sourceOf({ receiptKinds: ['image'] }) }],
  ['纯转发旧行为', { source: sourceOf({ receiptKinds: ['forward'] }) }],
  ['空种类', { source: sourceOf({ receiptKinds: [] }) }],
  ['不是执行的user消息', { role: 'assistant' }],
  ['缺宿主消息id', { id: '' }],
  ['缺聊天', { source: sourceOf({ chatId: '' }) }],
  ['私聊不是同一发送者', { source: sourceOf({ senderId: '22' }) }],
  ['未知聊天种类', { source: sourceOf({ chatType: 'channel' }) }]
]
for (const [name, patch] of rejected) {
  test('034到访：拒绝' + name, () => {
    const h = rig()
    assert.equal(h.note(messageOf(patch)), false)
    assert.equal(h.ticks.length, 0)
    assert.equal(h.frames.length, 0)
    assert.deepEqual(h.capture, { fromPlatform: true })
  })
}

test('034到访：总闸/会话闸拒绝，恢复后真实新收件可计', () => {
  const h = rig()
  h.power(false)
  assert.equal(h.note(), false)
  h.power(true); h.scope(false)
  assert.equal(h.note(), false)
  h.scope(true)
  assert.equal(h.note(), true)
  assert.equal(h.ticks.length, 1)
})

test('034到访：群主人的空原话只记presence，不把群友计为主人', () => {
  const h = rig()
  const origin = sourceOf({ chatType: 'group', chatId: '33', senderId: '11', receiptKinds: ['file'], rawText: ' \n ' })
  assert.equal(h.note(messageOf({ source: origin })), true)
  assert.equal(h.note(messageOf({ id: 'guest', source: { ...origin, isMaster: false, senderId: '22' } })), false)
  assert.equal(h.ticks.length, 1)
  assert.equal(h.frames[0][1], '')
})

test('034到访：按真实session对象去重，不让相同sid对象借用去重状态', () => {
  const h = rig()
  assert.equal(h.note(), true)
  assert.equal(h.note(messageOf(), {}, { id: h.session.id }), true)
  assert.equal(h.ticks.length, 2)
})

test('034到访：心跳或引擎失败互不影响，不因重放重复副作用', async () => {
  let count = 0
  const h = rig({
    heartbeat: { noteExternalEvent: () => { throw Error('synthetic heartbeat failure') } },
    engineOf: () => ({ longingMessage: () => { count++; return Promise.reject(Error('synthetic engine failure')) } })
  })
  assert.equal(h.note(), true)
  assert.equal(h.note(), false)
  assert.equal(count, 1)
  await assert.rejects(h.capture.longingRead, /synthetic engine failure/)
})

test('034到访：同步引擎错误和未启动引擎安全降级，捕获字段不变', () => {
  for (const engineOf of [() => null, () => ({ longingMessage: () => { throw Error('synthetic') } })]) {
    const h = rig({ engineOf })
    assert.equal(h.note(), true)
    assert.equal(h.ticks.length, 1)
    assert.deepEqual(h.capture, { fromPlatform: true })
  }
})
