import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The phase023 one-change byte freeze was an implementation-time acceptance
// check. Later release metadata changes are authorized separately; retain the
// public subpath's current contract and the independent pure-import proof.
test('current package exposes the pure official C2C codec at its stable public subpath', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.name, 'dsh-echo')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.exports['./official-c2c-codec'], './lib/official-c2c-codec.js')
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.exports['./package.json'], './package.json')
  assert.equal(manifest.exports['./compaction'], './lib/compaction.js')
  assert.equal(manifest.exports['./qq-file-text'], './lib/qq-file-text.js')
  const codec = readFileSync(new URL('../lib/official-c2c-codec.js', import.meta.url), 'utf8')
  assert.ok(codec.length > 0)
  assert.ok(manifest.files.includes('lib/'), 'The public codec must ship in the runtime package')
})

test('fresh Node self export imports and calls codec without main index/config/DB/network/timers', t => {
  const probe = fileURLToPath(new URL('./echo023-import-probe.mjs', import.meta.url))
  const child = spawnSync(process.execPath, [probe], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, NODE_NO_WARNINGS: '1' }
  })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stderr, '')
  const result = JSON.parse(child.stdout)
  assert.equal(result.resolvedSelfExport, true)
  assert.equal(result.mainIndexEvaluated, false)
  assert.equal(result.explicitFilesystemOrConfigurationOrDatabaseImports, 0)
  assert.equal(result.networkAttempts, 0)
  assert.deepEqual(result.forbiddenImports, [])
  assert.deepEqual(result.forbiddenCalls, [])
  assert.deepEqual(result.activeResourceTypesAdded, [])
  assert.deepEqual(result.exports, [
    'KEY_SCHEME', 'OfficialC2cCodecError', 'PLATFORM', 'ackRequestKey', 'admissionRequestKey',
    'anchorDeadlineMs', 'attemptKey', 'deliveryDigest', 'deriveMessageIdentity',
    'effectiveDeadlineMs', 'encodeCanonical', 'inputDigest', 'ledgerNamespace',
    'normalizeAppId', 'normalizeMessageIndex', 'partKey', 'planContentDigest', 'validateScope'
  ].sort())
  t.diagnostic('ECHO023_IMPORT_PROOF ' + child.stdout.trim())
})
