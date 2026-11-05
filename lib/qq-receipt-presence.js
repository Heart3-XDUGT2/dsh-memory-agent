/** 034：只由已执行user/message分支调用；纯语音/文件收件不制造正文或事实。 */
import { isEchoSource } from './source-kind.js'
import { FORM, formOf } from './speak.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const key = value => typeof value === 'string' && value.trim() !== '' && value.length <= 256

export function createReceiptPresence ({
  isEnabled = () => false, sessionEnabledOf = () => false,
  heartbeat = null, engineOf = () => null, masterId = '', longingOf = () => null
} = {}) {
  // 只跟真实session对象关联；每会话64个已执行消息ID，避免重复观察重复计到访。
  const seen = new WeakMap()
  function note ({ session, message, capture } = {}) {
    const source = message?.source
    if (!object(session) || !key(session.id) || message?.role !== 'user' || !key(message.id)
      || !isEchoSource(source) || formOf(source?.form) !== FORM.INBOUND || source.platform !== 'qq'
      || source.isMaster !== true || source.hasSupplementalContent !== true
      || typeof source.rawText !== 'string' || source.rawText.trim() !== ''
      || !['private', 'group'].includes(source.chatType) || !key(source.chatId) || !key(source.senderId)
      || (source.chatType === 'private' && source.chatId !== source.senderId)
      || !Array.isArray(source.receiptKinds) || source.receiptKinds.length < 1 || source.receiptKinds.length > 2
      || !source.receiptKinds.every(kind => kind === 'voice' || kind === 'file')) return false
    try {
      if (isEnabled() !== true || sessionEnabledOf(session.id) !== true) return false
    } catch { return false }
    let ids = seen.get(session)
    if (ids?.has(message.id)) return false
    if (!ids) { ids = new Set(); seen.set(session, ids) }
    if (ids.size >= 64) ids.delete(ids.values().next().value)
    ids.add(message.id)
    // 心跳和现有想念入口互不牵连；没有转写，text必须保持空串。
    try {
      const ticking = heartbeat?.noteExternalEvent?.()
      if (ticking && typeof ticking.then === 'function') Promise.resolve(ticking).catch(() => {})
    } catch {}
    try {
      const engine = engineOf()
      if (key(masterId) && typeof engine?.longingMessage === 'function') {
        const pending = Promise.resolve(engine.longingMessage(masterId, '', session.id, longingOf()))
        pending.catch(() => {})
        if (object(capture)) capture.longingRead = pending
      }
    } catch {}
    return true
  }
  return Object.freeze({ note })
}
