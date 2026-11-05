/* Bounded, detached audit observations. No business reads, requests, or persistence of their own. */
import { randomUUID } from 'node:crypto'
export const AUDIT_DETAIL_MAX = 4000
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k)
export const auditNumber = v => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)
const textClip = (s, n) => { const t = s.slice(0, n); return /[\uD800-\uDBFF]$/u.test(t) ? t.slice(0, -1) : t }

// The budget includes the metadata. Each retry projects the original, never slices serialized JSON.
function bounded (original, budget, inherited = null) {
  for (let pass = 0; pass < 8; pass += 1) {
    const cap = { text: Math.max(8, 480 >> pass), array: Math.max(0, 12 >> pass), keys: Math.max(8, 24 >> pass) }
    const fields = [...(inherited?.fields || [])].slice(0, 10), seen = new WeakSet()
    let omitted = Number(inherited?.omittedFields || 0) + Math.max(0, (inherited?.fields?.length || 0) - fields.length), visited = 0
    const cut = (path, kind, originalCount, savedCount) => {
      if (fields.length < 12) fields.push({ path: textClip(path, 160), kind, originalCount, savedCount })
      else omitted += 1
    }
    const copy = (v, path, depth) => {
      if (v === null || typeof v === 'boolean') return v
      if (typeof v === 'number') return Number.isFinite(v) ? v : null
      if (typeof v === 'string' && (path === 'source' || path.endsWith('.source') || path === 'turnTrace')) return textClip(v, 128)
      if (typeof v === 'string') { if (v.length > cap.text) cut(path, 'characters', v.length, textClip(v, cap.text).length); return textClip(v, cap.text) }
      if (v === undefined) return undefined
      if (typeof v !== 'object') { cut(path, 'unsupported', 1, 0); return null }
      visited += 1
      if (depth > 8 || visited > 220 || seen.has(v)) { cut(path, 'unavailable', 1, 0); return null }
      seen.add(v)
      let out
      if (Array.isArray(v)) {
        const length = Math.min(v.length, cap.array); out = []
        for (let n = 0; n < length; n += 1) { try { out.push(copy(v[n], path + '.' + n, depth + 1) ?? null) } catch { out.push(null); cut(path + '.' + n, 'unavailable', 1, 0) } }
        if (length < v.length) cut(path, 'items', v.length, length)
      } else {
        const keys = Object.keys(v); out = {}
        for (const k of keys.slice(0, cap.keys)) { if (k.length > 128) { cut(path, 'key_characters', k.length, 0); continue } try { const value = copy(v[k], path ? path + '.' + k : k, depth + 1); if (value !== undefined) Object.defineProperty(out, k, { value, enumerable: true, configurable: true, writable: true }) } catch { cut(path + '.' + k, 'unavailable', 1, 0) } }
        if (keys.length > cap.keys) cut(path, 'keys', keys.length, cap.keys)
      }
      seen.delete(v); return out
    }
    try {
      const value = copy(original, '', 0)
      value.truncation = { truncated: inherited?.truncated === true || fields.length > 0 || omitted > 0, fields, ...(omitted ? { omittedFields: omitted } : {}), ...(inherited?.unavailable ? { unavailable: true } : {}) }
      if (JSON.stringify(value).length <= budget) return value
    } catch { /* Retry a smaller projection; observation cannot escape into business control. */ }
  }
  return { ...(typeof original?.version === 'number' ? { version: original.version } : {}), ...(typeof original?.source === 'string' ? { source: textClip(original.source, 128) } : {}), ...(typeof original?.turnTrace === 'string' ? { turnTrace: textClip(original.turnTrace, 128) } : {}), ...(typeof original?.turnAssociation === 'string' ? { turnAssociation: textClip(original.turnAssociation, 128) } : {}), truncation: { truncated: true, fields: [], unavailable: true } }
}
export function captureAuditInput (input) {
  try { return bounded({ input }, 1400) } catch { return { input: null, truncation: { truncated: true, unavailable: true } } }
}
export function makeAuditIO (source, captured, process, output, outputCuts = null) {
  try {
    const fields = [...(captured?.truncation?.fields || []), ...(outputCuts?.fields || [])]
    return bounded({ version: 1, source, input: captured?.input, process, output }, 2800,
      { fields, omittedFields: (captured?.truncation?.omittedFields || 0) + (outputCuts?.omittedFields || 0), truncated: captured?.truncation?.truncated === true || outputCuts?.truncated === true, unavailable: captured?.truncation?.unavailable === true || outputCuts?.unavailable === true })
  } catch { return { version: 1, source, truncation: { truncated: true, unavailable: true } } }
}
export function encodeAuditDetail (base, io) {
  try {
    const value = { io, ...base }, text = JSON.stringify(value)
    return text.length <= AUDIT_DETAIL_MAX ? text : JSON.stringify(bounded(value, AUDIT_DETAIL_MAX))
  } catch { return '{"observationUnavailable":true}' }
}
export function createArmAudit ({ store, arm, step, beginAt, sessionId, turnTrace, userText, previousVector, now = Date.now, id = randomUUID } = {}) {
  try {
    const eventId = id(), sid = String(sessionId ?? ''), trace = String(turnTrace ?? ''), started = beginAt
    const input = captureAuditInput({ text: userText, ...(arm === 'same_turn_emotion' ? { previousVector } : {}) })
    return r => {
      try {
        if (!store || typeof store.writeAudit !== 'function') return
        // A missing round stays isolated under its event identity; the store resolver cannot attach a later round.
        const base = { turnTrace: trace || eventId, turnAssociation: trace ? 'captured' : 'unavailable', beginAt: started, settleAt: now(), ms: auditNumber(r?.ms), timedOut: r?.timedOut === true, ok: r?.ok === true, error: r?.error ? String(r.error).slice(0, 120) : null, reason: r?.reason ? String(r.reason) : null, raw: typeof r?.raw === 'string' && r.raw !== '' ? r.raw : null }
        const io = r?.io?.version === 1 && r.io.source === arm ? r.io : makeAuditIO(arm, input, { status: r?.timedOut ? 'timeout' : r?.ok ? 'success' : 'failed' }, {})
        store.writeAudit({ traceId: eventId + '#' + arm, sessionId: sid, userInput: typeof input.input?.text === 'string' ? input.input.text : '', injectedMemories: '', llmReply: '', toolCall: arm, stage: arm, step, stageDetail: encodeAuditDetail(base, io) })
      } catch { /* No observer exception changes the branch's old result. */ }
    }
  } catch { return () => {} }
}
export function captureRetrievedItems (items) {
  try {
    if (!Array.isArray(items)) return bounded({ output: { items: null, count: null } }, 2400)
    const list = items.slice(0, 12).map(item => {
      if (!item || typeof item !== 'object') return null
      const out = {}
      for (const key of ['summary', 'r_now', 'total', 'hits', 'emotion_score', 'emotionScore', 'forced', 'layer', 'similarity']) if (own(item, key)) out[key] = item[key]
      return out
    })
    return bounded({ output: { items: list, count: items.length } }, 2400,
      items.length > list.length ? { fields: [{ path: 'output.items', kind: 'items', originalCount: items.length, savedCount: list.length }] } : null)
  } catch { return { output: { items: null, count: null }, truncation: { truncated: true, unavailable: true } } }
}
export function createRetrieveAudit ({ store, query, topK, options, extraSeeds, sessionId, turnTrace, now = Date.now, id = randomUUID } = {}) {
  try {
    const eventId = id(), trace = String(turnTrace ?? ''), sid = String(sessionId ?? ''), begun = now()
    const input = captureAuditInput({ text: query, topK, options, extraSeeds })
    return ({ engine, status, returned = null, graph = 'not_requested', error = null, graphError = null } = {}) => {
      try {
        if (!store || typeof store.writeAudit !== 'function') return
        const output = returned?.output ?? { items: null, count: null }, ms = Math.max(0, now() - begun)
        const io = makeAuditIO('retrieve', input, { engine, status, graph, ...(graphError ? { graphError: String(graphError).slice(0, 120) } : {}), ...(error ? { error: String(error).slice(0, 120) } : {}) }, output, returned?.truncation)
        store.writeAudit({ traceId: eventId, sessionId: sid, userInput: typeof input.input?.text === 'string' ? input.input.text : '', llmReply: '', latency: ms, toolCall: 'retrieve', stage: 'retrieve', step: 2,
          stageDetail: encodeAuditDetail({ turnTrace: trace || eventId, turnAssociation: trace ? 'captured' : 'unavailable', arms: [], candidates: output.count, injected: null, ms, expanded: null, ok: status === 'success', error: error ? String(error).slice(0, 120) : null }, io) })
      } catch { /* Observing is optional; retrieval is not. */ }
    }
  } catch { return () => {} }
}
