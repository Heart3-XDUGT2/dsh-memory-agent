/**
 * Public/CI checks for the live-config guard's pure path and snapshot helpers.
 * Every filesystem operation below uses a freshly created synthetic directory.
 * The opt-in scripts/live-config-guard.mjs CLI remains an operator tool; this
 * test never calls runSuite(), reads a real home or claims to have tested one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, normalize, resolve, sep } from 'node:path'
import { liveConfigPath, snapshot, sameSnapshot, describe } from '../scripts/live-config-guard.mjs'

const syntheticHome = process.platform === 'win32' ? 'Z:\\release-synthetic-home' : '/release-synthetic-home'
const alternateHome = process.platform === 'win32' ? 'Z:\\release-alternate-home' : '/release-alternate-home'

function fixture(work) {
  const parent = realpathSync(tmpdir())
  const dir = mkdtempSync(join(parent, 'echo-release-guard-'))
  const resolved = realpathSync(dir)
  assert.ok(resolved.startsWith(parent + sep))
  assert.match(basename(resolved), /^echo-release-guard-/u)
  try { return work(join(dir, 'config.json')) } finally {
    assert.equal(realpathSync(dir), resolved)
    assert.ok(resolve(dir).startsWith(resolve(parent) + sep))
    rmSync(dir, { recursive: true, force: true })
  }
}

test('guard path uses an explicit home without filesystem access', () => {
  assert.equal(liveConfigPath({ DSH_HOME: syntheticHome }), normalize(join(syntheticHome, 'echo', 'config.json')))
})

test('guard path prefers its explicit stashed home', () => {
  assert.equal(liveConfigPath({ DSH_HOME: alternateHome, ECHO_TEST_REAL_DSH_HOME: syntheticHome }),
    normalize(join(syntheticHome, 'echo', 'config.json')))
  assert.equal(liveConfigPath({ DSH_HOME: syntheticHome, ECHO_TEST_REAL_DSH_HOME: '  ' }),
    normalize(join(syntheticHome, 'echo', 'config.json')))
})

test('operator guard still refuses temporary homes instead of reporting them as live', () => {
  const temporary = join(tmpdir(), 'synthetic-guard-home')
  assert.throws(() => liveConfigPath({ DSH_HOME: temporary }), /拒绝在临时目录/u)
  assert.throws(() => liveConfigPath({ DSH_HOME: syntheticHome, ECHO_TEST_REAL_DSH_HOME: temporary }), /拒绝在临时目录/u)
})

test('snapshot records only the explicit synthetic file and its byte hash', () => fixture(file => {
  const text = '{"savedAt":"synthetic-release-check","value":7}\n'
  writeFileSync(file, text)
  const value = snapshot(file)
  assert.equal(value.exists, true)
  assert.equal(value.path, file)
  assert.equal(value.sha256, createHash('sha256').update(text).digest('hex'))
  assert.equal(value.size, Buffer.byteLength(text))
  assert.equal(value.savedAt, 'synthetic-release-check')
  assert.equal(sameSnapshot(value, snapshot(file)), true)
}))

test('sameSnapshot detects content changes in a synthetic configuration', () => fixture(file => {
  writeFileSync(file, '{"savedAt":"synthetic","value":1}\n')
  const before = snapshot(file)
  writeFileSync(file, '{"savedAt":"synthetic","value":2}\n')
  assert.equal(sameSnapshot(before, snapshot(file)), false)
}))

test('sameSnapshot also detects mtime-only writes with identical bytes', () => fixture(file => {
  writeFileSync(file, '{"savedAt":"synthetic","value":1}\n')
  const beforeBytes = readFileSync(file)
  const before = snapshot(file)
  const later = new Date(before.mtimeMs + 10_000)
  utimesSync(file, later, later)
  assert.deepEqual(readFileSync(file), beforeBytes)
  assert.equal(sameSnapshot(before, snapshot(file)), false)
}))

test('missing and removed synthetic files keep explicit existence semantics', () => fixture(file => {
  const missing = snapshot(file)
  assert.deepEqual(missing, { exists: false, path: file })
  assert.equal(sameSnapshot(missing, snapshot(file)), true)
  writeFileSync(file, '{"savedAt":"synthetic"}\n')
  const present = snapshot(file)
  assert.equal(sameSnapshot(missing, present), false)
  rmSync(file)
  assert.equal(existsSync(file), false)
  assert.equal(sameSnapshot(present, snapshot(file)), false)
  assert.equal(sameSnapshot(missing, snapshot(file)), true)
  assert.equal(describe(snapshot(file)), '(不存在)')
}))
