/** 033：实际QQ contract→主包service facade→relay，把执行许可与JSON信封分开传递。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRelay } from '../lib/relay.js'
import { createChannel, SERVICE_NAME } from '../../dsh-qq-bridge/lib/contract.js'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const label = '      inject: async (envelope, execution) => {'
const start = source.indexOf(label)
const end = source.indexOf('\n      },', start)
assert.ok(start >= 0 && end > start)
const facadeExpression = source.slice(start + '      inject: '.length, end + '\n      }'.length)
const raw = () => ({ v: 1, platform: 'qq', chat: { id: '11', type: 'private' },
  sender: { id: '11', name: '甲', isMaster: true }, msgId: 'context-case', text: '真实原话' })

function stack (ensure) {
  let rollback = 0
  const calls = []
  const store = new Proxy({
    relayBeginInbound: () => ({ duplicate: false }),
    relayRollbackInbound: () => { rollback++ },
    relayCommitInbound: () => true,
    relayCancelBubbles: () => ({ rows: 0 })
  }, { get: (target, name) => target[name] ?? (() => {}) })
  const relay = createRelay({
    store, config: () => ({ enabled: true, sessionId: 'context-session' }), isEnabled: () => true,
    ensureCompanion: ensure ?? (async () => ({ agent: {}, sessionId: 'context-session', via: 'his-window' })),
    injectInbound: async (agent, env, text, execution) => {
      calls.push({ agent, env, text, execution })
      return 'queued'
    }
  })
  const inject = new Function('relay', 'return (' + facadeExpression + ')')(relay)
  const channel = createChannel({
    ctx: { get: name => name === SERVICE_NAME ? { inject } : undefined },
    settings: { inboundRetryTimes: 1 }
  })
  return { channel, relay, calls, rollbacks: () => rollback }
}

test('033：执行许可确实穿过实际service和relay，不落信封或模型正文', async () => {
  const f = stack()
  const isCurrent = () => true
  const result = await f.channel.inject(raw(), { isCurrent })
  assert.equal(result.ok, true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].execution.isCurrent, isCurrent)
  assert.equal(Object.values(f.calls[0].env).some(value => typeof value === 'function'), false)
  assert.equal('execution' in f.calls[0].env, false)
  assert.doesNotMatch(f.calls[0].text, /isCurrent|execution/)
})

test('033：等待陪伴会话期间撤销，主包回滚而不开始注入', async () => {
  let current = true
  const f = stack(async () => {
    current = false
    return { agent: {}, sessionId: 'context-session', via: 'his-window' }
  })
  const result = await f.channel.inject(raw(), { isCurrent: () => current })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'inbound-cancelled')
  assert.equal(f.calls.length, 0)
  assert.equal(f.rollbacks(), 1)
})

test('033：旧调用没有执行许可，实际service及relay仍正常受理', async () => {
  const f = stack()
  assert.equal((await f.channel.inject(raw())).ok, true)
  assert.equal(f.calls.length, 1)
  assert.equal(typeof f.calls[0].execution?.isCurrent, 'undefined')
})
