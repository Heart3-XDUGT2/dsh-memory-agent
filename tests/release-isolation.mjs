/** Public test preload: isolated paths and no non-loopback network. */
import './_isolate.mjs'
import net from 'node:net'
import tls from 'node:tls'
import { syncBuiltinESMExports } from 'node:module'
const local = value => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(value).toLowerCase())
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const first = args[0]
  const host = typeof first === 'object' && first ? first.host : typeof args[1] === 'string' ? args[1] : 'localhost'
  if (!local(host || 'localhost')) throw Error('release_external_network_forbidden')
  return connect.apply(this, args)
}
const originalTLS = tls.connect
tls.connect = function (...args) {
  const first = args[0], host = typeof first === 'object' && first ? first.host : typeof args[1] === 'string' ? args[1] : ''
  if (!local(host)) throw Error('release_external_network_forbidden')
  return originalTLS.apply(this, args)
}
const fetch = globalThis.fetch
globalThis.fetch = function (input, ...args) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!local(url.hostname)) throw Error('release_external_network_forbidden')
  return fetch.call(this, input, ...args)
}
syncBuiltinESMExports()
