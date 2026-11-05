import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertHomePath, assertDisjoint, nearestRealPath } from '../scripts/install-boundary.mjs'
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), folder = fs.mkdtempSync(path.join(parent, 'echo-install-boundary-'))
  const real = fs.realpathSync(folder), home = path.join(folder, 'synthetic-home'), outside = path.join(folder, 'outside-home')
  fs.mkdirSync(home); fs.mkdirSync(outside)
  t.after(() => {
    assert.equal(fs.realpathSync(folder), real); assert.ok(real.startsWith(parent + path.sep))
    fs.rmSync(folder, { recursive: true, force: true })
  })
  return { folder, home, outside }
}
test('uncreated descendants are proved from their nearest real ancestor', t => {
  const { home, outside } = fixture(t), target = path.join(home, 'profiles/web/node_modules/dsh-echo')
  assert.equal(assertHomePath(home, target).leafLink, false)
  assert.equal(nearestRealPath(target), target)
  assert.throws(() => assertHomePath(home, path.join(outside, 'dsh-echo')), /outside_home/u)
  assert.throws(() => assertHomePath(home, home), /outside_home/u)
})
test('ancestor junction cannot redirect an install or uninstall outside home', t => {
  const { home, outside } = fixture(t), profile = path.join(home, 'profiles/web')
  fs.mkdirSync(profile, { recursive: true })
  const nodeModules = path.join(profile, 'node_modules')
  fs.symlinkSync(outside, nodeModules, process.platform === 'win32' ? 'junction' : 'dir')
  const marker = path.join(outside, 'sentinel'); fs.writeFileSync(marker, 'keep')
  assert.throws(() => assertHomePath(home, path.join(nodeModules, 'dsh-echo')), /linked_install_ancestor/u)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep')
})
test('unexpected local distribution link is rejected before packing', t => {
  const { home, outside } = fixture(t), dist = path.join(home, '.dsh-echo-local')
  fs.symlinkSync(outside, dist, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => assertHomePath(home, dist), /linked_install_ancestor/u)
})
test('a legacy slot link can be removed without touching source contents', t => {
  const { home, outside } = fixture(t), slot = path.join(home, 'slot'), marker = path.join(outside, 'sentinel')
  fs.writeFileSync(marker, 'keep')
  fs.symlinkSync(outside, slot, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(assertHomePath(home, slot, { allowLeafLink: true }).leafLink, true)
  fs.rmSync(slot, { force: true })
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep')
})
test('source overlap checks resolve existing aliases and future descendants', t => {
  const { home, outside } = fixture(t)
  const source = path.join(outside, 'source'); fs.mkdirSync(source)
  const alias = path.join(home, 'alias')
  fs.symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => assertDisjoint(source, alias), /source_target_overlap/u)
  assert.throws(() => assertDisjoint(source, path.join(alias, 'future')), /source_target_overlap/u)
  assert.throws(() => assertDisjoint(path.join(source, 'child'), source), /source_target_overlap/u)
  assert.doesNotThrow(() => assertDisjoint(source, path.join(home, 'slot')))
})
