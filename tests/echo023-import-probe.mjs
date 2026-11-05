// Fresh process proof. Only the self export and crypto may resolve during import.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const codecUrl = new URL('../lib/official-c2c-codec.js', import.meta.url).href
const resolved = [], loaded = [], forbiddenImports = [], forbiddenCalls = []
const before = process.getActiveResourcesInfo()
const saved = new Map()
for (const name of ['fetch', 'setTimeout', 'setInterval', 'setImmediate']) {
  saved.set(name, globalThis[name])
  globalThis[name] = () => { forbiddenCalls.push(name); throw Error('forbidden_runtime_effect') }
}
const originalGetBuiltinModule = process.getBuiltinModule
process.getBuiltinModule = () => { forbiddenCalls.push('getBuiltinModule'); throw Error('forbidden_runtime_effect') }
const hooks = registerHooks({
  resolve (specifier, context, nextResolve) {
    if (specifier !== 'dsh-echo/official-c2c-codec' && specifier !== 'node:crypto') {
      forbiddenImports.push(specifier)
      throw Error('forbidden_module_import')
    }
    const result = nextResolve(specifier, context)
    resolved.push({ specifier, url: result.url })
    return result
  },
  load (url, context, nextLoad) {
    if (url !== codecUrl && url !== 'node:crypto') {
      forbiddenImports.push(url)
      throw Error('forbidden_module_load')
    }
    loaded.push(url)
    return nextLoad(url, context)
  }
})
let codec
try {
  codec = await import('dsh-echo/official-c2c-codec')
  const identity = codec.deriveMessageIdentity({
    appId: codec.normalizeAppId(' synthetic-probe-app '), rawOpenid: 'SYNTHETIC_PROBE_OWNER',
    rawMsgId: 'synthetic-probe-message', indexKind: 'missing', indexValue: ''
  })
  const s = codec.validateScope({ platform: codec.PLATFORM, appId: 'synthetic-probe-app', ownerHash: identity.ownerHash, chatId: identity.chatId })
  const digest = codec.inputDigest({ ...identity, text: 'synthetic probe text' })
  const requestKey = codec.admissionRequestKey({ ...identity, inputDigest: digest })
  assert.equal(s.scopeKey, identity.scopeKey)
  assert.match(requestKey, /^iq2_[0-9a-f]{64}$/)
  assert.equal(codec.anchorDeadlineMs(0), 300000)
} finally {
  hooks.deregister()
  process.getBuiltinModule = originalGetBuiltinModule
  for (const [name, value] of saved) globalThis[name] = value
}
const after = process.getActiveResourcesInfo()
const added = after.filter(type => !before.includes(type))
assert.deepEqual(added, [])
assert.deepEqual(forbiddenImports, [])
assert.deepEqual(forbiddenCalls, [])
assert.ok(resolved.some(v => v.specifier === 'dsh-echo/official-c2c-codec' && v.url === codecUrl))
assert.ok(loaded.includes(codecUrl))
console.log(JSON.stringify({
  kind: 'fresh-node-package-self-export-proof', nodeVersion: process.version,
  resolvedSelfExport: true, resolved, loaded, forbiddenImports, forbiddenCalls,
  activeResourceTypesAdded: added, mainIndexEvaluated: false,
  explicitFilesystemOrConfigurationOrDatabaseImports: 0, networkAttempts: 0,
  exports: Object.keys(codec).sort(),
  limits: 'package-internal self-reference only; no installed profile or cross-package deployment claim'
}))
