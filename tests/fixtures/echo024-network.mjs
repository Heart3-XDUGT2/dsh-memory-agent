import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
const native = { socket: net.Socket.prototype.connect, connect: net.connect, createConnection: net.createConnection,
  tls: tls.connect, request: http.request, get: http.get, httpsRequest: https.request, httpsGet: https.get,
  fetch: globalThis.fetch, WebSocket: globalThis.WebSocket }
export const network = { loopbackCalls: 0, forbidden: 0 }
function check (host) {
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host))) { network.forbidden++; throw Error('echo024_external_network_forbidden') }
  network.loopbackCalls++
}
function connection (args) {
  const values = Array.isArray(args[0]) ? args[0] : args
  const first = values[0]
  check(first && typeof first === 'object' ? first.host ?? first.hostname : values[1])
}
function request (args) {
  const first = args[0]
  const url = typeof first === 'string' || first instanceof URL ? new URL(first) : null
  check(url ? url.hostname : first?.hostname ?? first?.host)
}
export function allowLoopback () {
  net.Socket.prototype.connect = function (...args) { connection(args); return native.socket.apply(this, args) }
  net.connect = function (...args) { connection(args); return native.connect.apply(this, args) }
  net.createConnection = function (...args) { connection(args); return native.createConnection.apply(this, args) }
  tls.connect = function (...args) { connection(args); return native.tls.apply(this, args) }
  http.request = function (...args) { request(args); return native.request.apply(this, args) }
  http.get = function (...args) { request(args); return native.get.apply(this, args) }
  https.request = function (...args) { request(args); return native.httpsRequest.apply(this, args) }
  https.get = function (...args) { request(args); return native.httpsGet.apply(this, args) }
  globalThis.fetch = function (url, ...args) { check(new URL(typeof url === 'string' || url instanceof URL ? url : url.url).hostname); return native.fetch.call(this, url, ...args) }
  globalThis.WebSocket = class extends native.WebSocket { constructor (url, ...args) { check(new URL(url).hostname); super(url, ...args) } }
  syncBuiltinESMExports()
}
