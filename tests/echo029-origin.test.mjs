import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { writeTestTrace } from './fixtures/test-trace.mjs'
import { coreHost, response, identity, local, until, isolation, cleanTmp } from './fixtures/echo024-core.mjs'
import { host, createUserMessage } from './fixtures/echo020-host.mjs'
const { createTurnStopper } = await import('../lib/turn-stopping.js')
const { defineTool } = await import('@deepseek-ai/dsh-tools')
const ownerModule = await import('../lib/official-owner-text.js')
const observations = []
after(() => {
  assert.equal(isolation.networkAttempts, 0)
  const label = process.env.ECHO029_RUN_LABEL ?? 'manual-' + Date.now()
  writeTestTrace("echo-executor-029-trace", label, { kind: 'real installed host and actual legacy stopper; synthetic due/LLM only', networkAttempts: isolation.networkAttempts, observations })
  cleanTmp()
})
const call = n => ({ id: 'synthetic-029-' + n, name: 'echo_qq_say', arguments: JSON.stringify({ text: 'synthetic chosen reply' }) })
function wireStopper (owner, h, fromPlatform = true) {
  const handled = []
  const stopper = createTurnStopper({ createUserMessage, isEnabled: () => true, isSessionEnabled: () => true,
    mustSayEnabled: () => true, steerOnlyFromPlatform: () => true })
  h.ctx.on('agent/turn-stopping', async payload => {
    // Same controller predicate used by the production entry, not hasBinding.
    if (owner.isCurrentOfficialTurn?.({ agent: payload.agent, turn: payload.turn }) === true) {
      handled.push({ skipped: true }); return
    }
    const result = await stopper.handle({ ...payload,
      capture: { longingRead: { pre: { exists: true, value: 8, threshold: 5, due: true } },
        turnText: 'synthetic plain answer', fromPlatform } })
    handled.push({ skipped: false, steered: result.steered === true, reason: result.reason })
  })
  return handled
}
for (const initialTool of [false, true]) test('029 official exact turn skips actual legacy longing hook; initialTool=' + initialTool, async t => {
  const f = await coreHost(t, { script: (_r, i) => initialTool
    ? i === 0 || i === 2 ? response('', [call(i)]) : response('synthetic tail')
    : i === 1 ? response('', [call(i)]) : response('synthetic plain first response') })
  const handled = wireStopper(f.owner, f.h)
  await f.binding.inject(identity('029-official-' + initialTool)); await f.quiet()
  const reply = (await f.binding.takeReply({ claimKey: 'synthetic-029-claim' })).reply
  observations.push({ case: t.name, handled, modelRequests: f.h.requests.length, replyPresent: !!reply,
    toolResults: f.rendered.map(r => ({ ok: r.value.ok, reason: r.value.reason ?? null, originReason: r.value.originReason ?? null })) })
  assert.equal(handled.some(r => r.steered), false)
  assert.ok(handled.some(r => r.skipped))
  assert.equal(f.h.requests.length, initialTool ? 2 : 1)
  assert.equal(!!reply, initialTool)
  if (initialTool) assert.equal(reply.text, 'synthetic chosen reply')
  else { assert.equal(f.rendered.length, 0); assert.equal(f.binding.status().reason, 'no_reply') }
})
for (const platform of ['local', 'legacy-qq']) test('029 same agent after official round preserves actual old stopping policy: ' + platform, async t => {
  let seed = true
  const f = await coreHost(t, { script: (_r, i) => seed && i === 0 ? response('', [call('seed')]) : response('synthetic plain text') })
  await f.binding.inject(identity('029-seed-' + platform)); const reply = await f.reply('seed')
  await f.binding.confirmReply({ replyId: reply.replyId, claimKey: 'seed', outcome: 'confirmed' })
  seed = false
  const handled = wireStopper(f.owner, f.h, platform === 'legacy-qq')
  const message = platform === 'local' ? local('synthetic local input') : createUserMessage({
    source: { kind: 'plugin:dsh-echo', form: 'relay', platform: 'qq', rawText: 'synthetic legacy input', isMaster: true },
    content: [{ type: 'text', text: 'synthetic legacy input' }]
  })
  f.h.agent.followup(message); await f.h.agent.whenIdle()
  assert.equal(f.owner.hasBinding(), true)
  assert.equal(handled.some(r => r.skipped), false)
  if (platform === 'legacy-qq') assert.equal(handled.filter(r => r.steered).length, 1)
  else assert.ok(handled.some(r => r.reason === 'not-from-platform'))
  observations.push({ case: t.name, handled })
})
test('029 another real agent remains outside the active official turn bypass', async t => {
  let release
  const held = new Promise(resolve => { release = resolve })
  const f = await coreHost(t, { script: async function * (_r, i) {
    if (i === 0) yield * response('', [call('active')])
    else { await held; yield * response('synthetic tail') }
  } })
  try {
    await f.binding.inject(identity('029-active'))
    await until(() => f.h.requests.length === 2)
    const other = await host(t, { script: () => response('synthetic other response') })
    const handled = wireStopper(f.owner, other)
    other.agent.followup(local('synthetic other input')); await other.agent.whenIdle()
    assert.equal(handled.some(r => r.skipped), false)
    assert.equal(handled.filter(r => r.steered).length, 1)
    const turn = f.h.agent.session.snapshotEvents(0).find(e => e.type === 'turn/start').data.turn
    assert.equal(f.owner.isCurrentOfficialTurn?.({ agent: f.h.agent, turn }), true)
    assert.equal(f.owner.isCurrentOfficialTurn({ agent: f.h.agent, turn: turn + 1 }), false)
    assert.equal(f.owner.isCurrentOfficialTurn({ agent: other.agent, turn }), false)
    observations.push({ case: t.name, handled, otherModelRequests: other.requests.length })
  } finally { release(); await f.h.agent.whenIdle() }
})
test('029 unknown extra input remains rejected, with schema-valid safe origin enums and no private fields', async t => {
  const secret = 'SYNTHETIC_PRIVATE_MARKER_029'
  const f = await coreHost(t, { script: (_r, i) => i === 0 ? response('', [{ ...call('mixed'), arguments: JSON.stringify({ text: secret }) }]) : response('synthetic tail') })
  f.h.agent.inject(createUserMessage({ source: { kind: 'plugin:synthetic-unknown', form: secret }, content: [{ type: 'text', text: secret }] }))
  await f.binding.inject(identity('029-ambiguous')); await f.quiet()
  const result = f.rendered.find(r => r.value.reason === 'official_origin_unproven')
  assert.ok(result)
  assert.equal(result.value.originReason, 'ineligible_inputs')
  assert.ok(result.value.originTurnReasons.includes('ambiguous_inputs'))
  assert.ok(result.value.originTurnReasons.every(r => ownerModule.OFFICIAL_TURN_REASONS.includes(r)))
  assert.ok(result.result[0].text.includes('ineligible_inputs'))
  assert.equal(JSON.stringify(result).includes(secret), false)
  for (const forbidden of ['sourceKey', 'sessionId', 'turnId', 'hostTurnUid', 'msgId', 'callId', 'text']) assert.equal(Object.hasOwn(result.value, forbidden), false)
  assert.equal((await f.binding.takeReply({ claimKey: 'mixed' })).reply, null)
  observations.push({ case: t.name, result: result.value })
})
for (const mode of ['nested', 'wrong-root-name']) test('029 actual ToolRuntime rejection stays closed with diagnostic: ' + mode, async t => {
  const values = []
  const f = await coreHost(t, { script: (_r, i) => i === 0 ? response('', [{ id: 'synthetic-outer', name: 'synthetic_bridge', arguments: '{}' }]) : response('synthetic tail') })
  f.h.ctx.tools.register(defineTool({ name: 'synthetic_bridge', description: 'memory-only nested diagnostic', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } }, render: () => [] },
    execute: async (_args, exec) => {
      const result = await f.h.agent.ctx.tools.execute({ name: 'echo_qq_say', agent: exec.agent, parent: exec.token, signal: exec.signal,
        callId: mode === 'nested' ? 'synthetic-child' : exec.callId, rootCallId: exec.rootCallId, arguments: { text: 'SYNTHETIC_PRIVATE_NESTED_029' } })
      values.push(result.value)
      return { ok: true }
    } }))
  await f.binding.inject(identity('029-' + mode)); await f.quiet()
  assert.equal(values[0]?.reason, 'official_origin_unproven')
  assert.equal(values[0].originReason, mode === 'nested' ? 'nested_unverified' : 'unpublished_root')
  assert.equal(JSON.stringify(values).includes('synthetic-outer'), false)
  assert.equal(JSON.stringify(values).includes('SYNTHETIC_PRIVATE_NESTED_029'), false)
  assert.equal((await f.binding.takeReply({ claimKey: mode })).reply, null)
  observations.push({ case: t.name, result: values[0], ptcSuccessClaimed: false })
})
test('029 production entry uses the exact-turn gate before calling old stopper, not global binding', () => {
  const source = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const start = source.indexOf("ctx.on('agent/turn-stopping', (payload) => {")
  const block = source.slice(start, source.indexOf("'echo.turnStopping()'", start))
  assert.ok(block.indexOf('officialOwner.isCurrentOfficialTurn') >= 0)
  assert.ok(block.indexOf('officialOwner.isCurrentOfficialTurn') < block.indexOf('turnStopper.handle'))
  assert.equal(block.includes('officialOwner.hasBinding'), false)
})
