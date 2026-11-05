// Pure complete-turn-v2 encoding. No binding, storage, budget or send capability.
import { createHash } from 'node:crypto'

export const KEY_SCHEME = 'eqqc2c-lp32-v2'
export const PLATFORM = 'qq-official'
const CHAT_PREFIX = 'official:c2c:v2:'
const WINDOW_MS = 300000

export class OfficialC2cCodecError extends TypeError {
  constructor (code) {
    super(code)
    this.name = 'OfficialC2cCodecError'
    this.code = code
  }
}

function fail (code) { throw new OfficialC2cCodecError(code) }
function record (value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code)
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail(code)
  return value
}
function string (value, code, nonempty = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || (nonempty && !value.length)) fail(code)
  return value
}
function appId (value) {
  string(value, 'invalid_app_id')
  if (value.length < 1 || value.length > 80 || /[^A-Za-z0-9_-]/.test(value)) fail('invalid_app_id')
  return value
}
function key (value, prefix) {
  string(value, 'invalid_key')
  if (!value.startsWith(prefix) || value.length !== prefix.length + 64 || /[^0-9a-f]/.test(value.slice(prefix.length))) fail('invalid_key')
  return value
}
function opaque (value) { return string(value, 'invalid_opaque_id', true) }
function integer (value, code = 'invalid_integer', min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code)
  return String(value)
}
function ms (value) { return integer(value, 'invalid_milliseconds') }
function list (values, max, validate, code = 'invalid_list') {
  if (!Array.isArray(values) || values.length < 1 || values.length > max) fail(code)
  const result = []
  // A sparse list must not silently lose fields through Array#map.
  for (let i = 0; i < values.length; i++) {
    if (!Object.hasOwn(values, i)) fail(code)
    result.push(validate(values[i], i))
  }
  if (new Set(result).size !== result.length) fail(code)
  return result
}

/** C(tag, ...fields): fixed domain, then u32be UTF-8 length and bytes per string. */
export function encodeCanonical (tag, ...fields) {
  const chunks = [Buffer.from('echo.qq.c2c\0v2\0', 'ascii')]
  for (const value of [tag, ...fields]) {
    string(value, 'invalid_canonical_string')
    const length = Buffer.byteLength(value, 'utf8')
    if (length > 0xffffffff) fail('canonical_field_too_large')
    const size = Buffer.alloc(4)
    size.writeUInt32BE(length)
    chunks.push(size, Buffer.from(value, 'utf8'))
  }
  return Buffer.concat(chunks)
}
function hash (prefix, tag, ...fields) {
  return prefix + createHash('sha256').update(encodeCanonical(tag, ...fields)).digest('hex')
}

/** The sole AppID trimming entry. Every other API requires canonical AppID. */
export function normalizeAppId (value) {
  return appId(string(value, 'invalid_app_id').trim())
}

/** Syntax and derivation consistency only; never owner authentication. */
export function validateScope (value) {
  const s = record(value, 'invalid_scope')
  if (s.platform !== PLATFORM) fail('invalid_scope')
  const normalizedAppId = appId(s.appId)
  const ownerHash = key(s.ownerHash, 'oh2_')
  const chatId = CHAT_PREFIX + ownerHash.slice(4)
  if (s.chatId !== chatId) fail('scope_mismatch')
  const scopeKey = hash('sc2_', 'scope', PLATFORM, normalizedAppId, ownerHash, chatId)
  if (Object.hasOwn(s, 'scopeKey') && s.scopeKey !== scopeKey) fail('scope_mismatch')
  return Object.freeze({ platform: PLATFORM, appId: normalizedAppId, ownerHash, chatId, scopeKey })
}

/** Explicit synthetic/protocol ext normalization; deriveMessageIdentity never guesses ext. */
export function normalizeMessageIndex (ext) {
  if (ext === undefined) return Object.freeze({ indexKind: 'missing', indexValue: '' })
  if (!Array.isArray(ext)) fail('invalid_index_ext')
  let found
  for (let i = 0; i < ext.length; i++) {
    if (!Object.hasOwn(ext, i)) fail('invalid_index_ext')
    const value = string(ext[i], 'invalid_index_ext')
    if (!value.startsWith('msg_idx=')) continue
    if (found !== undefined) fail('duplicate_message_index')
    found = value
  }
  return Object.freeze(found === undefined
    ? { indexKind: 'missing', indexValue: '' }
    : { indexKind: 'present', indexValue: found })
}

/** Adapter-side raw identity input; the result contains no raw values. */
export function deriveMessageIdentity (value) {
  const v = record(value, 'invalid_identity')
  if (Object.hasOwn(v, 'ext')) fail('explicit_index_required')
  const normalizedAppId = appId(v.appId)
  const openid = string(v.rawOpenid, 'invalid_openid')
  if (openid.length < 8 || openid.length > 128 || /[^A-Za-z0-9_-]/.test(openid) || /^\d+$/.test(openid)) fail('invalid_openid')
  const msgId = string(v.rawMsgId, 'invalid_message_id', true)
  if (msgId.length > 180) fail('invalid_message_id')
  string(v.indexValue, 'invalid_message_index')
  if (v.indexKind === 'missing') {
    if (v.indexValue !== '') fail('invalid_message_index')
  } else if (v.indexKind === 'present') {
    if (!v.indexValue.startsWith('msg_idx=')) fail('invalid_message_index')
  } else fail('invalid_message_index')
  const ownerHash = hash('oh2_', 'owner', normalizedAppId, 'c2c', openid)
  const chatId = CHAT_PREFIX + ownerHash.slice(4)
  const scopeKey = hash('sc2_', 'scope', PLATFORM, normalizedAppId, ownerHash, chatId)
  const replyAnchorKey = hash('ra2_', 'anchor', scopeKey, msgId)
  const inboundKey = hash('in2_', 'inbound', replyAnchorKey, v.indexKind, v.indexValue)
  return Object.freeze({ ownerHash, chatId, scopeKey, replyAnchorKey, inboundKey })
}

export function inputDigest (value) {
  const v = record(value, 'invalid_input')
  return hash('ip2_', 'input', key(v.scopeKey, 'sc2_'), key(v.inboundKey, 'in2_'),
    key(v.replyAnchorKey, 'ra2_'), 'plain-text-1', string(v.text, 'invalid_text'))
}

export function admissionRequestKey (value) {
  const v = record(value, 'invalid_input')
  return hash('iq2_', 'admit', key(v.scopeKey, 'sc2_'), key(v.inboundKey, 'in2_'), key(v.inputDigest, 'ip2_'))
}

export function ledgerNamespace (value) {
  return hash('lg2_', 'ledger', PLATFORM, appId(value))
}

/** Full ordered rows, including future due rows. Mutable delivery state is ignored. */
export function planContentDigest (value) {
  const v = record(value, 'invalid_plan')
  if (!Array.isArray(v.rows) || v.rows.length < 1 || v.rows.length > 100) fail('invalid_rows')
  const ids = new Set(), fields = []
  let textBytes = 0
  for (let i = 0; i < v.rows.length; i++) {
    const row = record(v.rows[i], 'invalid_rows')
    const id = opaque(row.id)
    if (ids.has(id)) fail('invalid_rows')
    ids.add(id)
    const ordinal = integer(row.ordinal)
    if (row.ordinal !== i) fail('invalid_row_order')
    const text = string(row.text, 'invalid_text')
    textBytes += Buffer.byteLength(text, 'utf8')
    if (textBytes > 65536) fail('plan_text_too_large')
    fields.push(id, ordinal, text, ms(row.notBeforeMs))
  }
  return hash('pc2_', 'plan', key(v.scopeKey, 'sc2_'), opaque(v.planKey), opaque(v.sourceKey),
    opaque(v.hostTurnUid), key(v.inboundKey, 'in2_'), key(v.replyAnchorKey, 'ra2_'),
    'reply', 'tool-intents', ms(v.sealedDeadlineMs), String(v.rows.length), ...fields)
}

/** A fixed part's fingerprint; membership/continuity against its plan is a caller check. */
export function partKey (value) {
  const v = record(value, 'invalid_part')
  const text = string(v.text, 'invalid_text')
  if ([...text].length > 1500) fail('part_text_too_large')
  const ids = list(v.orderedIds, 100, opaque)
  return hash('pt2_', 'part', key(v.scopeKey, 'sc2_'), opaque(v.planKey), key(v.contentDigest, 'pc2_'),
    integer(v.partOrdinal, 'invalid_part_ordinal', 0, 3), integer(v.msgSeq, 'invalid_msg_seq', 1, 4),
    ms(v.notBeforeMs), text, String(ids.length), ...ids)
}

export function deliveryDigest (value) {
  const v = record(value, 'invalid_delivery')
  const parts = list(v.partKeys, 4, part => key(part, 'pt2_'))
  return hash('pd2_', 'delivery', key(v.contentDigest, 'pc2_'),
    string(v.policyVersion, 'invalid_policy_version', true), String(parts.length), ...parts)
}

export function attemptKey (value) {
  const v = record(value, 'invalid_attempt')
  return hash('at2_', 'attempt', key(v.scopeKey, 'sc2_'), opaque(v.planKey), key(v.partKey, 'pt2_'),
    integer(v.ordinal, 'invalid_attempt_ordinal', 1, 3))
}

/** Ordered receipt keys, not reports or raw response data; no receipt authorization here. */
export function ackRequestKey (value) {
  const v = record(value, 'invalid_ack')
  const receipts = list(v.receiptKeys, 4, opaque)
  const ids = list(v.orderedIds, 100, opaque)
  return hash('ak2_', 'ack-request', key(v.scopeKey, 'sc2_'), opaque(v.planKey),
    key(v.contentDigest, 'pc2_'), String(receipts.length), ...receipts, String(ids.length), ...ids)
}

/** Checked arithmetic only; no observation, clock read or deadline extension. */
export function anchorDeadlineMs (earliestAtMs) {
  ms(earliestAtMs)
  const result = earliestAtMs + WINDOW_MS
  ms(result)
  return result
}

export function effectiveDeadlineMs (value) {
  const v = record(value, 'invalid_deadline')
  ms(v.sealedDeadlineMs); ms(v.coreAnchorDeadlineMs); ms(v.adapterAnchorDeadlineMs)
  return Math.min(v.sealedDeadlineMs, v.coreAnchorDeadlineMs, v.adapterAnchorDeadlineMs)
}
