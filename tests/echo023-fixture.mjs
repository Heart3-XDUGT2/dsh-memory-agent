// Independent test oracle: TextEncoder/DataView/Uint8Array, not codec/Buffer LP.
import { createHash } from 'node:crypto'

export function referenceBytes (tag, ...fields) {
  const encoder = new TextEncoder()
  const domain = Uint8Array.from([101, 99, 104, 111, 46, 113, 113, 46, 99, 50, 99, 0, 118, 50, 0])
  const parts = [domain]
  for (const field of [tag, ...fields]) {
    const body = encoder.encode(field)
    const length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, body.length, false)
    parts.push(length, body)
  }
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}
export const referenceKey = (prefix, tag, ...fields) =>
  prefix + createHash('sha256').update(referenceBytes(tag, ...fields)).digest('hex')

// Copied verbatim from the frozen "missing" synthetic identity vector.
export const identity = Object.freeze({
  ownerHash: 'oh2_5a9e7e7a7c2edea2b3eeefdc58e2c5eee19d34b2ce16e4fd2902113620e5ba9d',
  chatId: 'official:c2c:v2:5a9e7e7a7c2edea2b3eeefdc58e2c5eee19d34b2ce16e4fd2902113620e5ba9d',
  scopeKey: 'sc2_5b460aa095fbc9b8d0a2eae72cfe3ea5b9cf5e25bfc5cc8fbded0ebed02f2f63',
  replyAnchorKey: 'ra2_918fc68590d99341d5c794b8d82a2a9f76a96f3b52ee3e9f0b8752942726ec73',
  inboundKey: 'in2_8d0a0e8f164861294b15096b4713adc133627fdceeb65d0c19e392771465b88c'
})
export const scope = () => ({ platform: 'qq-official', appId: 'synth-app-A', ownerHash: identity.ownerHash, chatId: identity.chatId })
export const rawIdentity = () => ({
  appId: 'synth-app-A', rawOpenid: 'SYNTHETIC_OWNER_OPENID_A',
  rawMsgId: 'synthetic-message-A', indexKind: 'missing', indexValue: ''
})
export const input = () => ({ scopeKey: identity.scopeKey, inboundKey: identity.inboundKey, replyAnchorKey: identity.replyAnchorKey, text: '合成正文\nsecond 🦉' })
export const plan = () => ({
  scopeKey: identity.scopeKey, planKey: 'synthetic-plan-A', sourceKey: 'synthetic-source-A',
  hostTurnUid: 'synthetic-turn-A', inboundKey: identity.inboundKey, replyAnchorKey: identity.replyAnchorKey,
  sealedDeadlineMs: 1700000300000,
  rows: [
    { id: 'synthetic-row-A', ordinal: 0, text: '合成正文', notBeforeMs: 1700000000123 },
    { id: 'synthetic-row-B', ordinal: 1, text: 'second 🦉', notBeforeMs: 1700000000456 }
  ]
})
export function referencePlan (v) {
  return referenceKey('pc2_', 'plan', v.scopeKey, v.planKey, v.sourceKey, v.hostTurnUid,
    v.inboundKey, v.replyAnchorKey, 'reply', 'tool-intents', `${v.sealedDeadlineMs}`, `${v.rows.length}`,
    ...v.rows.flatMap(row => [row.id, `${row.ordinal}`, row.text, `${row.notBeforeMs}`]))
}
export const part = () => ({
  scopeKey: identity.scopeKey, planKey: 'synthetic-plan-A', contentDigest: referencePlan(plan()),
  partOrdinal: 0, msgSeq: 1, notBeforeMs: 1700000000456, text: '合成正文\nsecond 🦉',
  orderedIds: ['synthetic-row-A', 'synthetic-row-B']
})
export const referencePart = v => referenceKey('pt2_', 'part', v.scopeKey, v.planKey, v.contentDigest,
  `${v.partOrdinal}`, `${v.msgSeq}`, `${v.notBeforeMs}`, v.text, `${v.orderedIds.length}`, ...v.orderedIds)
export const ack = () => ({
  scopeKey: identity.scopeKey, planKey: 'synthetic-plan-A', contentDigest: referencePlan(plan()),
  receiptKeys: ['synthetic-confirmation-A', 'synthetic-confirmation-B'],
  orderedIds: ['synthetic-row-A', 'synthetic-row-B']
})
