/** 034直接执行实际主包注入边界；不加载插件apply/真实库/配置或模型。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseEnvelope, renderInboundText } from '../lib/relay.js'
import { hasRelayContent, relayFactText } from '../lib/relay-content.js'
import { prepareForwardImages } from '../lib/relay-image-content.js'
import { describeImages, inboundContent, isStickerImage } from '../lib/eyes.js'
import { ECHO_SOURCE_KIND } from '../lib/source-kind.js'
import { latestDirectUserText } from '../lib/turn-query.js'
import { parseSessionMarker } from '../lib/toggle.js'
import { isHumanUtterance } from '../lib/inbound-filter.js'
import { createReceiptPresence } from '../lib/qq-receipt-presence.js'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const start = source.indexOf('  async function injectInboundNow (')
const end = source.indexOf('\n  }\n', start)
const actualInject = source.slice(start, end + '\n  }'.length)
const LABEL = '文件2026-11-02T03:04:05.006Z-1'
const REF = 'e'.repeat(32)
const file = { received: true, name: 'Echo下线.txt', ref: REF, label: LABEL, declaredSize: 50 }
function rig () {
  const messages = [], fileBindings = [], forwardBindings = [], noReplies = []
  const deps = {
    hasRelayContent, prepareForwardImages, inboundContent, isStickerImage, ECHO_SOURCE_KIND,
    attachments: {},
    collectImages: async refs => ({ images: refs.map(() => ({ mediaType: 'image/png' })), problems: [] }),
    saveImageBlocks: async (_attachments, images) => images.map(() => ({ type: 'image', attachment: { id: 'synthetic' } })),
    describeImages: (count, problems, options) => { noReplies.push(options.noReply); return describeImages(count, problems, options) },
    forwardReader: { bind: data => forwardBindings.push(data) },
    fileReader: { bind: data => fileBindings.push(data) },
    fileSender: { bind: () => {} },
    ctx: { logger: { info: () => {}, warn: () => {} } }, audit: () => {},
    createUserMessage: value => ({ id: 'executed-file', role: 'user', ...value })
  }
  const inject = new Function(...Object.keys(deps), actualInject + '\nreturn injectInboundNow')(...Object.values(deps))
  const agent = { session: { id: 'synthetic-session' }, runMaintenance: fn => fn(), followup: m => messages.push(m) }
  const env = patch => {
    const parsed = parseEnvelope({ v: 1, platform: 'qq', chat: { id: '11', type: 'private' },
      sender: { id: '11', isMaster: true }, msgId: 'file-seam', text: '', files: [file], ...patch })
    assert.equal(parsed.ok, true)
    return parsed.value
  }
  return { messages, fileBindings, forwardBindings, noReplies, inject, agent, env }
}

test('034实际核心：双文件绑定及隐藏fileRefs进入真实消息，元数据原话隔离', async () => {
  const h = rig()
  const env = h.env({ files: [file, { ...file, name: '资料.md', ref: 'f'.repeat(32), label: LABEL.slice(0, -1) + '2' }] })
  assert.equal(await h.inject(h.agent, env, renderInboundText(env)), 'ok')
  assert.equal(h.fileBindings.length, 1)
  const message = h.messages[0]
  assert.deepEqual(message.source.fileRefs, [REF, 'f'.repeat(32)])
  assert.equal(message.source.hasSupplementalContent, true)
  assert.deepEqual(message.source.receiptKinds, ['file'])
  assert.equal(message.source.rawText, '')
  const text = message.content.map(b => b.text || '').join('\n')
  assert.equal(latestDirectUserText([message]), '')
  assert.equal(relayFactText(message, text), '')
  assert.equal(parseSessionMarker(relayFactText(message, text)), null)
  assert.doesNotMatch(text, /e{32}|f{32}|fileRefs|不用回|0张图/)
  assert.match(text, /Echo下线\.txt/)
})

test('034实际核心：原有图片不用回，混合文件/语音有独立receiptKinds', async () => {
  for (const kind of ['image', 'file', 'voice', 'both']) {
    const h = rig()
    const env = h.env({ images: [{ url: 'http://image.invalid/synthetic' }],
      files: ['file', 'both'].includes(kind) ? [file] : [],
      ...(['voice', 'both'].includes(kind) ? { voices: [{ received: true }] } : {}) })
    assert.equal(await h.inject(h.agent, env, renderInboundText(env)), 'ok')
    assert.equal(h.messages[0].content.filter(b => b.type === 'image').length, 1)
    assert.equal(h.noReplies[0], kind === 'image')
    assert.deepEqual(h.messages[0].source.receiptKinds ?? [], kind === 'image' ? []
      : kind === 'file' ? ['file'] : kind === 'voice' ? ['voice'] : ['voice', 'file'])
  }
})

test('034实际核心：尚未执行或已撤准入的收件，不绑定或followup', async () => {
  const h = rig(), env = h.env()
  assert.equal(await h.inject(h.agent, env, renderInboundText(env), { isCurrent: () => false }), 'cancelled')
  assert.equal(h.messages.length, 0)
  assert.equal(h.fileBindings.length, 0)
  let live = true
  h.agent.runMaintenance = callback => { live = false; return callback() }
  assert.equal(await h.inject(h.agent, env, renderInboundText(env), { isCurrent: () => live }), 'cancelled')
  assert.equal(h.messages.length, 0)
  assert.equal(h.fileBindings.length, 0)
})

test('034实际核心：执行后的空文件/语音收件到访一次，不进入原话/开关捕获', async () => {
  const begin = source.indexOf('        const text = (msg?.source?.hasSupplementalContent')
  const finish = source.indexOf('        // P2-A:走到这里', begin)
  assert.ok(begin >= 0 && finish > begin)
  const actualBranch = source.slice(begin, finish)
  const arrivals = [], frames = []
  const presence = createReceiptPresence({
    isEnabled: () => true, sessionEnabledOf: () => true, masterId: 'synthetic-master',
    heartbeat: { noteExternalEvent: () => arrivals.push(1) },
    engineOf: () => ({ longingMessage: (...args) => { frames.push(args); return Promise.resolve({}) } })
  })
  const run = new Function('msg', 'session', 'capture', 'receiptPresence', 'relayFactText', 'textOf', 'isHumanUtterance',
    actualBranch + '\ncapture.userText="不应到达的原话分支"')
  for (const kind of ['file', 'voice']) {
    const h = rig()
    const env = h.env(kind === 'file' ? {} : { files: [], voices: [{ received: true }] })
    await h.inject(h.agent, env, renderInboundText(env))
    const msg = h.messages[0], capture = {}
    for (let i = 0; i < 2; i++) run(msg, h.agent.session, capture, presence, relayFactText,
      m => m.content.map(b => b.text || '').join('\n'), isHumanUtterance)
    assert.equal('userText' in capture, false)
    assert.equal(parseSessionMarker(relayFactText(msg, 'Echo下线')), null)
    assert.equal(frames.at(-1)[1], '')
  }
  assert.equal(arrivals.length, 2)
  assert.equal(frames.length, 2)
})
