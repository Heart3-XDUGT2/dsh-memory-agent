import { isEchoSource } from './source-kind.js'
import { relayFactText } from './relay-content.js'

/** Text captured for conversation/reflect memory, separate from model-facing prompt text. */
export function captureTextForMemory (message, fallbackText = '') {
  const source = message?.source
  if (isEchoSource(source) && String(source.form || '') === 'relay') {
    if (typeof source.rawText === 'string') {
      if (source.hasSupplementalContent === true) return relayFactText(message, fallbackText)
      return source.rawText
    }
  }
  return fallbackText
}
