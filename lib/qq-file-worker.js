import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { syncBuiltinESMExports } from 'node:module'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { failure, fail, isFileTextError, textPrefix } from './file-text-errors.js'

async function runWorker () {
  // Defense in depth for memory-only extraction. This is not an OS sandbox.
  const noNetwork = () => { throw new Error('NETWORK_DISABLED') }
  globalThis.fetch = noNetwork
  http.request = noNetwork
  http.get = noNetwork
  https.request = noNetwork
  https.get = noNetwork
  net.connect = noNetwork
  net.createConnection = noNetwork
  net.Socket.prototype.connect = noNetwork
  syncBuiltinESMExports()

  try {
    const { data, format, limits } = workerData
    if (!(data instanceof Uint8Array) || data.byteLength > limits.maxInputBytes) fail('INVALID_INPUT')
    let extracted
    if (format === 'pdf') {
      const { extractPdf } = await import('./pdf-text.js')
      extracted = await extractPdf(data, limits)
    } else if (format === 'docx') {
      const { extractDocx } = await import('./docx-text.js')
      extracted = await extractDocx(data, limits)
    } else if (format === 'txt' || format === 'md') {
      let text
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { fail('INVALID_ENCODING') }
      if (text.includes('\u0000')) fail('BINARY_TEXT')
      const prefix = textPrefix(text, limits.maxTextChars)
      extracted = {
        text: prefix, truncated: prefix.length < text.length,
        warnings: !text.length ? ['EMPTY_TEXT'] : (prefix.length < text.length ? ['TEXT_TRUNCATED'] : [])
      }
    } else fail('UNSUPPORTED_FORMAT')
    parentPort.postMessage({ ok: true, format, ...extracted })
  } catch (error) {
    parentPort.postMessage(failure(isFileTextError(error) ? error.code : 'PARSE_FAILED'))
  }
}

// Existing product smoke tooling imports every lib/*.js on the main thread.
if (!isMainThread && parentPort !== null && workerData !== null && typeof workerData === 'object') {
  await runWorker()
}
