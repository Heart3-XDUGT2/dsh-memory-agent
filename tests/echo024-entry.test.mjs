// Explicit source-wiring checks, separate from real service/tool/host execution.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createSpeaker } from '../lib/speak.js'
import { createRelay } from '../lib/relay.js'
const index = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
test('actual entry publishes factory service and fences availability until event/tool wiring is ready', () => {
  assert.ok(index.includes("import { createOfficialOwnerText } from './official-owner-text.js'"))
  assert.ok(index.includes('officialOwnerText: officialOwner.service'))
  assert.ok(index.includes("supportsHost: () => officialHostReady && !!ctx.get('sessionProjections')"))
  assert.ok(index.indexOf('officialHostReady = true') > index.indexOf('dispatchOfficial: officialOwner.dispatchTool'))
  const handler = index.slice(index.indexOf("ctx.on('session/event', (session, event) => {"))
  assert.ok(handler.indexOf('officialOwner.observeSessionEvent(session, event)') < handler.indexOf('if (isSubagentSession(session)) return'))
  assert.ok(handler.includes('!officialObservation.suppressLegacy'))
  assert.ok(handler.includes('officialObservation.suppressLegacy ? { queued: 0 } : speaker.finishTurn'))
  assert.ok(index.includes('officialOwner.observeClaim({ agent, message, turn })'))
})
test('binding does not register a generic mouth and reserved target views are excluded', () => {
  let registered = 0
  const speaker = createSpeaker({ transport: null, channelView: {
    ofSession: () => [{ platform: 'qq-official' }, { platform: 'qq' }],
    all: () => [{ platform: 'qq-official' }, { platform: 'qq' }]
  } })
  speaker.onRegistered(() => { registered++ })
  assert.throws(() => speaker.registerChannel({ name: 'official', platform: 'qq-official' }), /reserved/)
  assert.equal(speaker.hasChannel(), false); assert.equal(registered, 0)
  assert.deepEqual(speaker.targets('s').map(c => c.platform), ['qq'])
  assert.deepEqual(speaker.allTargets().map(c => c.platform), ['qq'])
})
test('reserved generic inject/channel/lease fail before any store or companion side effect', async () => {
  let touched = 0
  const relay = createRelay({ store: new Proxy({}, { get: () => () => { touched++; throw Error('unexpected old store') } }),
    config: () => ({}), isEnabled: () => true, ensureCompanion: async () => { touched++ } })
  assert.equal((await relay.handleInbound({ platform: 'qq-official' })).body.reason, 'reserved-platform')
  assert.equal(relay.setChannel({ platform: 'qq-official' }).ok, false)
  assert.equal(relay.lease({ platform: 'qq-official' }).items.length, 0)
  assert.equal(touched, 0)
})
test('raw legacy ack cannot confirm a reserved row through injected platform guard', () => {
  let ids
  const relay = createRelay({ store: { relayAckOutbox: args => { ids = args.ids; return { acked: args.ids.length, rows: [] } } },
    config: () => ({}), isEnabled: () => true, legacyAckAllowed: id => id !== 2 })
  assert.equal(relay.ack([1, 2, 3]).acked, 2)
  assert.deepEqual(ids, [1, 3])
  assert.ok(index.includes("SELECT platform FROM relay_outbox WHERE out_id = ?"))
})
