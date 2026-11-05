import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as codec from 'dsh-echo/official-c2c-codec'
import { referenceBytes, referenceKey, referencePlan, referencePart, identity, scope, rawIdentity, input, plan, part, ack } from './echo023-fixture.mjs'

const vectors = JSON.parse(readFileSync(new URL('./fixtures/official-identity-vectors.json', import.meta.url), 'utf8')).identityVectors
const hex = bytes => Buffer.from(bytes).toString('hex')
const safeError = (fn, code) => assert.throws(fn, error =>
  error instanceof codec.OfficialC2cCodecError && error instanceof TypeError &&
  error.name === 'OfficialC2cCodecError' && error.code === code && error.message === code)
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value) }; return value }
const otherKey = (prefix, digit = 'b') => prefix + digit.repeat(64)

test('canonical: fixed domain and literal manual UTF-8/LP32 bytes', () => {
  const expected = '6563686f2e71712e633263007632000000000178000000014100000003e4bda0'
  assert.equal(hex(codec.encodeCanonical('x', 'A', '你')), expected)
  assert.equal(hex(referenceBytes('x', 'A', '你')), expected)
  assert.equal(codec.KEY_SCHEME, 'eqqc2c-lp32-v2')
  assert.equal(codec.PLATFORM, 'qq-official')
})
test('canonical: length boundaries distinguish splits, empty strings, NULs and tags', () => {
  const inputs = [['x', 'ab', 'c'], ['x', 'a', 'bc'], ['x', '', 'ab'], ['x', 'ab', ''], ['x', 'a\0b'], ['x\0', 'ab']]
  const outputs = inputs.map(fields => hex(codec.encodeCanonical(...fields)))
  assert.equal(new Set(outputs).size, inputs.length)
  for (let i = 0; i < inputs.length; i++) assert.equal(outputs[i], hex(referenceBytes(...inputs[i])))
})
test('canonical: UTF-8 byte length is not UTF-16 length; returned buffers are independent', () => {
  const first = codec.encodeCanonical('tag', '🦉')
  assert.equal(first.readUInt32BE(22), 4)
  first.fill(0)
  assert.equal(hex(codec.encodeCanonical('tag', '🦉')), hex(referenceBytes('tag', '🦉')))
})
for (const [label, value] of [['high', '\ud800'], ['low', '\udfff'], ['mixed', 'ok\ud800x'], ['number', 1], ['object', {}], ['null', null]]) {
  test('canonical rejects ' + label + ' without coercion or echoed values', () => {
    safeError(() => codec.encodeCanonical('x', value), 'invalid_canonical_string')
    safeError(() => codec.encodeCanonical(value), 'invalid_canonical_string')
  })
}
test('AppID: explicit one-time trim, ASCII, retained case and maximum length', () => {
  assert.equal(codec.normalizeAppId('\t synth-App_A-1 \n'), 'synth-App_A-1')
  assert.equal(codec.normalizeAppId('A'.repeat(80)), 'A'.repeat(80))
  assert.notEqual(codec.ledgerNamespace('App-A'), codec.ledgerNamespace('app-A'))
  assert.equal(codec.ledgerNamespace('App-A'), referenceKey('lg2_', 'ledger', 'qq-official', 'App-A'))
})
for (const [label, value] of [['empty', ''], ['spaces', '  '], ['long', 'a'.repeat(81)], ['unicode', '合成'], ['punctuation', 'a.b'], ['number', 1], ['null', null], ['surrogate', '\ud800']]) {
  test('AppID rejects ' + label, () => safeError(() => codec.normalizeAppId(value), 'invalid_app_id'))
}
test('identity/scope/ledger never silently trim an unnormalized AppID', () => {
  safeError(() => codec.deriveMessageIdentity({ ...rawIdentity(), appId: ' synth-app-A ' }), 'invalid_app_id')
  safeError(() => codec.validateScope({ ...scope(), appId: ' synth-app-A ' }), 'invalid_app_id')
  safeError(() => codec.ledgerNamespace(' synth-app-A '), 'invalid_app_id')
  safeError(() => codec.ledgerNamespace('synth-app-A\n'), 'invalid_app_id')
  assert.deepEqual(codec.deriveMessageIdentity({ ...rawIdentity(), appId: codec.normalizeAppId(' synth-app-A ') }), identity)
})
for (const vector of vectors) test('frozen 021 identity vector: ' + vector.id, () => {
  const actual = codec.deriveMessageIdentity(deepFreeze(structuredClone(vector.input)))
  for (const key of ['ownerHash', 'chatId', 'scopeKey', 'replyAnchorKey', 'inboundKey']) assert.equal(actual[key], vector.expected[key])
  const v = vector.input
  const owner = referenceKey('oh2_', 'owner', v.appId, 'c2c', v.rawOpenid)
  const chat = 'official:c2c:v2:' + owner.slice(4)
  const s = referenceKey('sc2_', 'scope', 'qq-official', v.appId, owner, chat)
  const anchor = referenceKey('ra2_', 'anchor', s, v.rawMsgId)
  assert.deepEqual(actual, {
    ownerHash: owner, chatId: chat, scopeKey: s, replyAnchorKey: anchor,
    inboundKey: referenceKey('in2_', 'inbound', anchor, v.indexKind, v.indexValue)
  })
  assert.equal(hex(codec.encodeCanonical('owner', v.appId, 'c2c', v.rawOpenid)), vector.expected.ownerPreimageHex)
  assert.equal(hex(referenceBytes('owner', v.appId, 'c2c', v.rawOpenid)), vector.expected.ownerPreimageHex)
})
test('frozen vector relations: indexes share anchor but differ; v1 and v2 stay separate', () => {
  assert.equal(vectors.length, 8)
  const v = Object.fromEntries(vectors.map(v => [v.id, v.expected]))
  const indexes = ['missing', 'present-empty', 'present-01', 'present-1'].map(id => codec.deriveMessageIdentity(vectors.find(v => v.id === id).input))
  assert.equal(new Set(indexes.map(v => v.replyAnchorKey)).size, 1)
  assert.equal(new Set(indexes.map(v => v.inboundKey)).size, 4)
  assert.equal(v.missing.v1.inboundKey, v.missing.v1.replyKey)
  assert.notEqual(v.missing.inboundKey, v.missing.v1.inboundKey)
  assert.notEqual(v['different-app'].scopeKey, v.missing.scopeKey)
  assert.notEqual(v['different-owner'].scopeKey, v.missing.scopeKey)
  assert.notEqual(v['unicode-nfc'].replyAnchorKey, v['unicode-nfd'].replyAnchorKey)
})
for (const [label, patch, code] of [
  ['short owner', { rawOpenid: 'short' }, 'invalid_openid'],
  ['numeric owner', { rawOpenid: '12345678' }, 'invalid_openid'],
  ['trimmed owner', { rawOpenid: ' SYNTHETIC_OWNER_OPENID_A' }, 'invalid_openid'],
  ['owner newline suffix', { rawOpenid: 'SYNTHETIC_OWNER_OPENID_A\n' }, 'invalid_openid'],
  ['unicode owner', { rawOpenid: 'SYNTHETIC_主人' }, 'invalid_openid'],
  ['long owner', { rawOpenid: 'A'.repeat(129) }, 'invalid_openid'],
  ['empty message', { rawMsgId: '' }, 'invalid_message_id'],
  ['long UTF-16 message', { rawMsgId: '🦉'.repeat(91) }, 'invalid_message_id'],
  ['ill-formed message', { rawMsgId: '\ud800' }, 'invalid_message_id'],
  ['missing index with value', { indexValue: 'msg_idx=1' }, 'invalid_message_index'],
  ['present index with wrong prefix', { indexKind: 'present', indexValue: '1' }, 'invalid_message_index'],
  ['index kind unknown', { indexKind: 'guess' }, 'invalid_message_index'],
  ['index omitted', { indexKind: undefined, indexValue: undefined }, 'invalid_message_index'],
  ['ill-formed index', { indexKind: 'present', indexValue: 'msg_idx=\ud800' }, 'invalid_message_index'],
  ['hidden raw ext', { ext: ['msg_idx=1', 'msg_idx=2'] }, 'explicit_index_required']
]) test('identity rejects ' + label, () => safeError(() => codec.deriveMessageIdentity({ ...rawIdentity(), ...patch }), code))
test('opaque IDs retain exact bytes, maximum UTF-16 message length and owner case', () => {
  assert.ok(codec.deriveMessageIdentity({ ...rawIdentity(), rawMsgId: '🦉'.repeat(90) }).inboundKey)
  assert.notEqual(codec.deriveMessageIdentity({ ...rawIdentity(), rawMsgId: ' synthetic-message-A ' }).replyAnchorKey, identity.replyAnchorKey)
  assert.notEqual(codec.deriveMessageIdentity({ ...rawIdentity(), rawOpenid: 'synthetic_owner_openid_a' }).ownerHash, identity.ownerHash)
})
test('index normalization is explicit; missing, empty, 01 and 1 remain distinct', () => {
  assert.deepEqual(codec.normalizeMessageIndex(), { indexKind: 'missing', indexValue: '' })
  assert.deepEqual(codec.normalizeMessageIndex([]), { indexKind: 'missing', indexValue: '' })
  assert.deepEqual(codec.normalizeMessageIndex(['other=value']), { indexKind: 'missing', indexValue: '' })
  for (const value of ['msg_idx=', 'msg_idx=01', 'msg_idx=1']) {
    const normalized = codec.normalizeMessageIndex(['other=value', value])
    assert.deepEqual(normalized, { indexKind: 'present', indexValue: value })
    assert.equal(codec.deriveMessageIdentity({ ...rawIdentity(), ...normalized }).replyAnchorKey, identity.replyAnchorKey)
  }
})
for (const [label, ext, code] of [
  ['same duplicate', ['msg_idx=1', 'msg_idx=1'], 'duplicate_message_index'],
  ['conflicting duplicate', ['msg_idx=1', 'msg_idx=2'], 'duplicate_message_index'],
  ['empty duplicate', ['msg_idx=', 'msg_idx=1'], 'duplicate_message_index'],
  ['non-array', 'msg_idx=1', 'invalid_index_ext'],
  ['null', null, 'invalid_index_ext'],
  ['non-string', [1], 'invalid_index_ext'],
  ['surrogate', ['msg_idx=\udfff'], 'invalid_index_ext'],
  ['sparse', new Array(1), 'invalid_index_ext']
]) test('index normalization refuses ' + label, () => safeError(() => codec.normalizeMessageIndex(ext), code))
test('scope: exact derivation, optional asserted scopeKey, fresh canonical output only', () => {
  const s = deepFreeze({ ...scope(), scopeKey: identity.scopeKey, ignoredMetadata: 'not retained' })
  assert.deepEqual(codec.validateScope(s), { ...scope(), scopeKey: identity.scopeKey })
  assert.equal(Object.isFrozen(codec.validateScope(s)), true)
  assert.deepEqual(codec.validateScope(Object.assign(Object.create(null), scope())), { ...scope(), scopeKey: identity.scopeKey })
})
for (const [label, patch, code] of [
  ['platform', { platform: 'qq' }, 'invalid_scope'],
  ['chat owner relation', { chatId: 'official:c2c:v2:' + 'b'.repeat(64) }, 'scope_mismatch'],
  ['v1 chat', { chatId: 'official:c2c:' + 'b'.repeat(64) }, 'scope_mismatch'],
  ['scope hash', { scopeKey: otherKey('sc2_') }, 'scope_mismatch'],
  ['scope undefined', { scopeKey: undefined }, 'scope_mismatch'],
  ['owner prefix', { ownerHash: otherKey('sc2_') }, 'invalid_key'],
  ['uppercase hash', { ownerHash: 'oh2_' + 'A'.repeat(64) }, 'invalid_key'],
  ['short hash', { ownerHash: 'oh2_' + 'a'.repeat(63) }, 'invalid_key']
]) test('scope rejects ' + label, () => safeError(() => codec.validateScope({ ...scope(), ...patch }), code))
test('input/admission: independent fixed-order preimages and content/scope/anchor binding', () => {
  const v = input()
  const expected = referenceKey('ip2_', 'input', v.scopeKey, v.inboundKey, v.replyAnchorKey, 'plain-text-1', v.text)
  assert.equal(codec.inputDigest(deepFreeze(v)), expected)
  const request = { scopeKey: v.scopeKey, inboundKey: v.inboundKey, inputDigest: expected }
  assert.equal(codec.admissionRequestKey(request), referenceKey('iq2_', 'admit', request.scopeKey, request.inboundKey, expected))
  for (const patch of [{ text: v.text + '!' }, { scopeKey: otherKey('sc2_') }, { inboundKey: otherKey('in2_') }, { replyAnchorKey: otherKey('ra2_') }]) {
    const changed = { ...v, ...patch }
    assert.notEqual(codec.inputDigest(changed), expected)
    assert.notEqual(codec.admissionRequestKey({ ...request, inputDigest: codec.inputDigest(changed) }), codec.admissionRequestKey(request))
  }
  assert.notEqual(codec.inputDigest({ ...v, text: 'é' }), codec.inputDigest({ ...v, text: 'e\u0301' }))
})
for (const [label, value] of [['v1 unprefixed', 'a'.repeat(64)], ['uppercase', 'sc2_' + 'A'.repeat(64)], ['extra suffix', otherKey('sc2_') + 'a'], ['newline suffix', otherKey('sc2_') + '\n'], ['leading space', ' ' + otherKey('sc2_')], ['wrong type', 1]]) {
  test('input refuses malformed key: ' + label, () => safeError(() => codec.inputDigest({ ...input(), scopeKey: value }), 'invalid_key'))
}
test('input rejects malformed text and admission rejects another key domain', () => {
  safeError(() => codec.inputDigest({ ...input(), text: '\ud800' }), 'invalid_text')
  safeError(() => codec.admissionRequestKey({ scopeKey: identity.scopeKey, inboundKey: identity.inboundKey, inputDigest: otherKey('pc2_') }), 'invalid_key')
})
test('plan: full ordered rows and independent canonical result, no in-place mutation', () => {
  const v = deepFreeze(plan())
  assert.equal(codec.planContentDigest(v), referencePlan(v))
  assert.equal(codec.planContentDigest({ ...v, rows: [{ ...v.rows[0], text: 'changed' }, v.rows[1]] }) === referencePlan(v), false)
  const reordered = { ...v, rows: [{ ...v.rows[1], ordinal: 0 }, { ...v.rows[0], ordinal: 1 }] }
  assert.notEqual(codec.planContentDigest(reordered), referencePlan(v))
  assert.notEqual(codec.planContentDigest({ ...v, sealedDeadlineMs: v.sealedDeadlineMs + 1 }), referencePlan(v))
})
test('plan/part fingerprints exclude lease, cancel, current deadline and delivery state', () => {
  const extra = { lease: { token: 'synthetic-lease' }, cancelEpoch: 99, currentAnchorDeadlineMs: 1, bindingGeneration: 4, reports: ['unknown'], acked: true }
  assert.equal(codec.planContentDigest({ ...plan(), ...extra }), codec.planContentDigest(plan()))
  assert.equal(codec.partKey({ ...part(), ...extra }), codec.partKey(part()))
  assert.equal(codec.inputDigest({ ...input(), ...extra }), codec.inputDigest(input()))
})
for (const [label, rows, code] of [
  ['empty', [], 'invalid_rows'],
  ['gap', [{ ...plan().rows[0], ordinal: 1 }], 'invalid_row_order'],
  ['duplicate IDs', [plan().rows[0], { ...plan().rows[1], id: plan().rows[0].id }], 'invalid_rows'],
  ['sparse', new Array(1), 'invalid_rows'],
  ['too many', Array.from({ length: 101 }, (_, ordinal) => ({ id: `r${ordinal}`, ordinal, text: '', notBeforeMs: 0 })), 'invalid_rows'],
  ['float ordinal', [{ ...plan().rows[0], ordinal: 0.5 }], 'invalid_integer']
]) test('plan rejects ' + label + ' rows', () => safeError(() => codec.planContentDigest({ ...plan(), rows }), code))
test('plan: exact aggregate UTF-8 cap; future rows are retained in digest', () => {
  const v = { ...plan(), rows: [{ id: 'r', ordinal: 0, text: '你'.repeat(21845) + 'a', notBeforeMs: 1700000400000 }] }
  assert.equal(Buffer.byteLength(v.rows[0].text), 65536)
  assert.equal(codec.planContentDigest(v), referencePlan(v))
  safeError(() => codec.planContentDigest({ ...v, rows: [{ ...v.rows[0], text: v.rows[0].text + 'b' }] }), 'plan_text_too_large')
})
test('part/delivery/attempt/ack: independent ordered field/list preimages', () => {
  const p = part(), pk = codec.partKey(deepFreeze(p))
  assert.equal(pk, referencePart(p))
  const second = referencePart({ ...part(), partOrdinal: 1, msgSeq: 2 })
  const d = { contentDigest: p.contentDigest, policyVersion: 'r1-grouping-1', partKeys: [pk, second] }
  assert.equal(codec.deliveryDigest(d), referenceKey('pd2_', 'delivery', d.contentDigest, d.policyVersion, '2', pk, second))
  const attempt = { scopeKey: p.scopeKey, planKey: p.planKey, partKey: pk, ordinal: 1 }
  assert.equal(codec.attemptKey(attempt), referenceKey('at2_', 'attempt', attempt.scopeKey, attempt.planKey, pk, '1'))
  const a = ack()
  assert.equal(codec.ackRequestKey(a), referenceKey('ak2_', 'ack-request', a.scopeKey, a.planKey, a.contentDigest, '2', ...a.receiptKeys, '2', ...a.orderedIds))
})
test('ordered partition, receipt and ID lists never sort silently or collapse length boundaries', () => {
  const p = part(), p1 = referencePart(p), p2 = referencePart({ ...p, partOrdinal: 1, msgSeq: 2 })
  const d = { contentDigest: p.contentDigest, policyVersion: 'policy-1', partKeys: [p1, p2] }
  assert.notEqual(codec.deliveryDigest(d), codec.deliveryDigest({ ...d, partKeys: [p2, p1] }))
  const a = ack()
  assert.notEqual(codec.ackRequestKey(a), codec.ackRequestKey({ ...a, receiptKeys: [...a.receiptKeys].reverse() }))
  assert.notEqual(codec.ackRequestKey(a), codec.ackRequestKey({ ...a, orderedIds: [...a.orderedIds].reverse() }))
  assert.notEqual(codec.ackRequestKey({ ...a, receiptKeys: ['ab', 'c'] }), codec.ackRequestKey({ ...a, receiptKeys: ['a', 'bc'] }))
  assert.notEqual(codec.partKey(p), codec.partKey({ ...p, orderedIds: [...p.orderedIds].reverse() }))
  assert.notEqual(codec.partKey(p), codec.partKey({ ...p, msgSeq: 2 }))
  assert.notEqual(codec.partKey(p), codec.partKey({ ...p, notBeforeMs: p.notBeforeMs + 1 }))
  assert.notEqual(codec.attemptKey({ scopeKey: p.scopeKey, planKey: p.planKey, partKey: p1, ordinal: 1 }),
    codec.attemptKey({ scopeKey: p.scopeKey, planKey: p.planKey, partKey: p1, ordinal: 2 }))
})
test('part: code point length limit, not UTF-16 truncation', () => {
  assert.equal(codec.partKey({ ...part(), text: '🦉'.repeat(1500) }),
    referencePart({ ...part(), text: '🦉'.repeat(1500) }))
  safeError(() => codec.partKey({ ...part(), text: '🦉'.repeat(1501) }), 'part_text_too_large')
  safeError(() => codec.partKey({ ...part(), text: '\udfff' }), 'invalid_text')
})
for (const [label, value] of [['negative', -1], ['float', 1.5], ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['infinity', Infinity], ['NaN', NaN], ['numeric string', '1'], ['bigint', 1n], ['boolean', true]]) {
  test('integer/milliseconds refuse ' + label + ' without coercion', () => {
    safeError(() => codec.planContentDigest({ ...plan(), sealedDeadlineMs: value }), 'invalid_milliseconds')
    safeError(() => codec.partKey({ ...part(), notBeforeMs: value }), 'invalid_milliseconds')
    safeError(() => codec.anchorDeadlineMs(value), 'invalid_milliseconds')
    safeError(() => codec.attemptKey({ scopeKey: identity.scopeKey, planKey: 'p', partKey: referencePart(part()), ordinal: value }), 'invalid_attempt_ordinal')
  })
}
test('millisecond helpers: zero/MAX_SAFE_INTEGER, checked window arithmetic and monotonic min', () => {
  assert.equal(codec.anchorDeadlineMs(0), 300000)
  assert.equal(codec.anchorDeadlineMs(Number.MAX_SAFE_INTEGER - 300000), Number.MAX_SAFE_INTEGER)
  safeError(() => codec.anchorDeadlineMs(Number.MAX_SAFE_INTEGER - 299999), 'invalid_milliseconds')
  assert.equal(codec.effectiveDeadlineMs({ sealedDeadlineMs: Number.MAX_SAFE_INTEGER, coreAnchorDeadlineMs: 10, adapterAnchorDeadlineMs: 5 }), 5)
  assert.equal(codec.effectiveDeadlineMs({ sealedDeadlineMs: 0, coreAnchorDeadlineMs: 10, adapterAnchorDeadlineMs: 5 }), 0)
  safeError(() => codec.effectiveDeadlineMs({ sealedDeadlineMs: 1, coreAnchorDeadlineMs: 1, adapterAnchorDeadlineMs: -1 }), 'invalid_milliseconds')
  const v = { ...plan(), sealedDeadlineMs: Number.MAX_SAFE_INTEGER, rows: [{ id: 'r', ordinal: 0, text: '', notBeforeMs: Number.MAX_SAFE_INTEGER }] }
  assert.equal(codec.planContentDigest(v), referencePlan(v))
  assert.equal(codec.planContentDigest({ ...v, sealedDeadlineMs: -0 }), codec.planContentDigest({ ...v, sealedDeadlineMs: 0 }))
})
test('part/attempt sequence domains remain bounded, no allocation or refunds', () => {
  for (const msgSeq of [0, 5]) safeError(() => codec.partKey({ ...part(), msgSeq }), 'invalid_msg_seq')
  for (const partOrdinal of [-1, 4]) safeError(() => codec.partKey({ ...part(), partOrdinal }), 'invalid_part_ordinal')
  for (const ordinal of [0, 4]) safeError(() => codec.attemptKey({ scopeKey: identity.scopeKey, planKey: 'p', partKey: referencePart(part()), ordinal }), 'invalid_attempt_ordinal')
  assert.ok(codec.attemptKey({ scopeKey: identity.scopeKey, planKey: 'p', partKey: referencePart(part()), ordinal: 3 }))
})
for (const [label, values] of [['empty', []], ['duplicate', ['same', 'same']], ['sparse', new Array(1)], ['empty ID', ['']], ['surrogate ID', ['\ud800']]]) {
  test('part/ack list validation refuses ' + label, () => {
    const expected = label === 'empty ID' || label === 'surrogate ID' ? 'invalid_opaque_id' : 'invalid_list'
    safeError(() => codec.partKey({ ...part(), orderedIds: values }), expected)
    safeError(() => codec.ackRequestKey({ ...ack(), receiptKeys: values }), expected)
    safeError(() => codec.ackRequestKey({ ...ack(), orderedIds: values }), expected)
  })
}
test('delivery rejects duplicate/malformed/excessive part keys and non-string policy', () => {
  const p = referencePart(part()), d = { contentDigest: referencePlan(plan()), policyVersion: 'policy-1', partKeys: [p] }
  safeError(() => codec.deliveryDigest({ ...d, partKeys: [p, p] }), 'invalid_list')
  safeError(() => codec.deliveryDigest({ ...d, partKeys: [otherKey('at2_')] }), 'invalid_key')
  safeError(() => codec.deliveryDigest({ ...d, partKeys: new Array(5).fill(p) }), 'invalid_list')
  safeError(() => codec.deliveryDigest({ ...d, policyVersion: 1 }), 'invalid_policy_version')
})
test('codec returns no raw identity and errors never echo raw/body/credentials', () => {
  const raw = rawIdentity(), result = codec.deriveMessageIdentity(raw)
  assert.deepEqual(Object.keys(result).sort(), ['ownerHash', 'chatId', 'scopeKey', 'replyAnchorKey', 'inboundKey'].sort())
  assert.ok(!JSON.stringify(result).includes(raw.rawOpenid))
  assert.ok(!JSON.stringify(result).includes(raw.rawMsgId))
  const secret = 'SYNTHETIC_PRIVATE_VALUE_🦉'
  try { codec.deriveMessageIdentity({ ...raw, rawOpenid: secret }) } catch (error) {
    assert.equal(error.code, 'invalid_openid')
    assert.ok(!String(error).includes(secret))
    assert.ok(!JSON.stringify(error).includes(secret))
    assert.ok(!error.stack.includes(secret))
  }
})
for (const [label, value] of [['null', null], ['array', []], ['date', new Date(0)], ['function', () => {}]]) {
  test('record-taking APIs refuse ' + label, () => {
    for (const fn of [codec.validateScope, codec.deriveMessageIdentity, codec.inputDigest, codec.admissionRequestKey, codec.planContentDigest, codec.partKey, codec.deliveryDigest, codec.attemptKey, codec.ackRequestKey, codec.effectiveDeadlineMs]) {
      assert.throws(() => fn(value), error => error instanceof codec.OfficialC2cCodecError)
    }
  })
}
