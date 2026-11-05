import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, identity, gate, codec } from './fixtures/echo022-state.mjs'

test('024 snapshot: outer input changes during target await cannot split digest and published content', async () => {
  const started = gate(), hold = gate(), f = fixture({ resolveTarget: async () => { started.resolve(); await hold.promise; return f.target } })
  const input = identity('mutable', { text: 'synthetic original' }), original = structuredClone(input)
  const pending = f.component.inject(input)
  await started.promise
  Object.assign(input, identity('changed', { text: 'synthetic changed during await' }))
  hold.resolve(); const receipt = await pending; await f.run()
  const record = await f.store.read({ scopeKey: f.component.scopeKey, inboundKey: original.inboundKey })
  assert.equal(receipt.everAccepted, true)
  assert.equal(f.published[0].content[0].text, original.text)
  assert.equal(f.published[0].source.replyContext.inboundKey, original.inboundKey)
  assert.equal(f.published[0].source.replyContext.replyAnchorKey, original.replyAnchorKey)
  assert.equal(record.inputDigest, codec.inputDigest({ scopeKey: f.component.scopeKey, ...original }))
})
test('024 snapshot: nested caller scope mutation does not change the verified scope', async () => {
  const started = gate(), hold = gate(), f = fixture({ resolveTarget: async () => { started.resolve(); await hold.promise; return f.target } })
  const input = identity('nested'), original = structuredClone(input)
  const pending = f.component.inject(input)
  await started.promise
  input.scope.appId = 'OtherApp'
  input.scope.ownerHash = 'invalid-new-owner'
  input.scope.chatId = 'invalid-new-chat'
  hold.resolve(); const receipt = await pending; await f.run()
  assert.equal(receipt.everAccepted, true)
  assert.equal(f.component.scope.appId, original.scope.appId)
  assert.equal(f.component.scope.ownerHash, original.scope.ownerHash)
  assert.equal(f.published[0].source.chatId, original.scope.chatId)
  assert.equal(f.published[0].source.replyContext.scopeKey, f.component.scopeKey)
})
test('024 snapshot: each relevant caller field/getter is read once before any await', async () => {
  const f = fixture(), original = identity('getters'), counts = {}
  const read = (name, value) => { counts[name] = (counts[name] ?? 0) + 1; return value }
  const scope = Object.fromEntries(Object.entries(original.scope).map(([k, v]) => [k, v]))
  for (const k of Object.keys(scope)) Object.defineProperty(scope, k, { enumerable: true, get: () => read('scope.' + k, original.scope[k]) })
  const input = {}
  for (const k of ['inboundKey', 'replyAnchorKey', 'text']) Object.defineProperty(input, k, { enumerable: true, get: () => read(k, original[k]) })
  Object.defineProperty(input, 'scope', { enumerable: true, get: () => read('scope', scope) })
  assert.equal((await f.component.inject(input)).everAccepted, true)
  await f.run()
  assert.ok(Object.values(counts).every(n => n === 1), JSON.stringify(counts))
  assert.equal(f.published[0].content[0].text, original.text)
})
