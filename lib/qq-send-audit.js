/** 037：发送审计只保留叶名、大小与固定终态；轮关联在受理时捕获。 */
import { randomUUID } from 'node:crypto'
import { QQ_FILE_SEND_CODES } from './qq-send-file.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const turnOf = value => Number.isSafeInteger(value) && value >= 0
const tag = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : ''
const codes = new Set(QQ_FILE_SEND_CODES)
const states = new Set(['not_submitted', 'confirmed', 'rejected', 'unknown'])
const leaf = name => typeof name === 'string' && name.length > 0 && name.length <= 160
  && name.trim() === name && name !== '.' && name !== '..'
  && !/[\\/:?\p{Cc}\p{Cf}]/u.test(name)
  && !Array.from(name).some(c => c.codePointAt(0) >= 0xd800 && c.codePointAt(0) <= 0xdfff)

export function createQQSendAudit ({ writeAudit, id = randomUUID } = {}) {
  const claims = new WeakMap(), issued = new WeakSet(), written = new WeakSet()
  function noteClaim ({ agent, turn } = {}, observation = {}) {
    try {
      const session = agent?.session
      if (!object(session) || !turnOf(turn)) return
      const previous = claims.get(session)
      const turnTrace = observation.hasQuery === true ? tag(observation.turnTrace)
        : previous?.turn === turn ? previous.turnTrace : ''
      claims.set(session, { turn, turnTrace })
    } catch {}
  }
  function capture (scope) {
    try {
      if (!object(scope?.session) || !turnOf(scope.turn)) return null
      const sessionId = scope.session.id, traceId = tag(id())
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 2048 || !traceId) return null
      const claimed = claims.get(scope.session)
      const context = Object.freeze({ sessionId, turn: scope.turn,
        turnTrace: claimed?.turn === scope.turn ? claimed.turnTrace : '', traceId })
      issued.add(context)
      return context
    } catch { return null }
  }
  function record ({ context, value } = {}) {
    try {
      if (!object(context) || !issued.has(context) || written.has(context)
        || !object(value) || !states.has(value.state)) return
      written.add(context)
      const detail = {
        turnTrace: context.turnTrace, sourceTurn: context.turn,
        ...(leaf(value.name) ? { name: value.name } : {}),
        ...(Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= 8388608 ? { bytes: value.bytes } : {}),
        state: value.state, code: codes.has(value.code) ? value.code : 'UNCONFIRMED'
      }
      const result = writeAudit?.({
        traceId: context.traceId, sessionId: context.sessionId,
        turnTraceCaptured: true, stage: 'qq_file_send', toolCall: 'echo_qq_file_send',
        stageDetail: JSON.stringify(detail),
        userInput: '', injectedMemories: '', llmReply: '', agentState: ''
      })
      Promise.resolve(result).catch(() => {})
    } catch { /* Observation never changes the send outcome. */ }
  }
  return Object.freeze({ noteClaim, capture, record })
}
