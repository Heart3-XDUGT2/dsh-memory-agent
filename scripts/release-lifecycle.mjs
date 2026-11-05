#!/usr/bin/env node
/**
 * Exercise the distributed installer in a disposable synthetic DSH profile.
 * The host dependency tree must be a clean public bootstrap, never a real home.
 * No DSH process is started, apply() is not called, and no model/QQ request runs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { npmCli } from './npm-runner.mjs'

const options = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  if (!['--package', '--previous', '--host-root', '--out', '--source'].includes(key) || !process.argv[index + 1]) {
    throw new Error('Usage: node scripts/release-lifecycle.mjs --package <tgz> --host-root <clean-public-bootstrap> [--previous <older-tgz>] [--out <new-dir>] [--source <expected-source>]')
  }
  options[key.slice(2)] = process.argv[index + 1]
}
if (!options.package || !options['host-root']) throw new Error('--package and --host-root are required')
const artifact = path.resolve(options.package), previousArtifact = options.previous ? path.resolve(options.previous) : artifact
const hostRoot = path.resolve(options['host-root'])
for (const file of [artifact, previousArtifact]) assert.ok(fs.statSync(file).isFile(), 'Package artifact must be a regular file')
const publicHostPackage = JSON.parse(fs.readFileSync(path.join(hostRoot, 'package.json'), 'utf8'))
assert.equal(typeof publicHostPackage.name, 'string', 'Use an explicitly supplied clean public bootstrap project')
const hostModules = path.join(hostRoot, 'node_modules')
const toolsPackage = path.join(hostModules, '@deepseek-ai', 'dsh-tools', 'package.json')
const llmPackage = path.join(hostModules, '@deepseek-ai', 'dsh-llm', 'package.json')
assert.ok(fs.existsSync(toolsPackage) && fs.existsSync(llmPackage), 'Bootstrap must contain actual public host packages')
const actualHost = {
  tools: JSON.parse(fs.readFileSync(toolsPackage, 'utf8')).version,
  llm: JSON.parse(fs.readFileSync(llmPackage, 'utf8')).version
}
assert.equal(actualHost.tools, actualHost.llm, 'Host package versions must agree')
const expectedSource = options.source ? path.resolve(options.source) : null
const folder = options.out ? path.resolve(options.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'echo-release-lifecycle-'))
if (options.out) { assert.equal(fs.existsSync(folder), false, 'Preserve earlier evidence; choose a new --out'); fs.mkdirSync(folder, { recursive: true }) }
const folderReal = fs.realpathSync(folder), home = path.join(folder, 'synthetic-home'), temp = path.join(folder, 'tmp')
const inside = target => {
  const absolute = path.resolve(target)
  assert.ok(absolute.startsWith(folderReal + path.sep), 'Mutation target escaped lifecycle sandbox')
  return absolute
}
for (const dir of [home, temp]) fs.mkdirSync(inside(dir), { recursive: true })
const userConfig = inside(path.join(folder, 'empty-user.npmrc')), globalConfig = inside(path.join(folder, 'empty-global.npmrc'))
fs.writeFileSync(userConfig, ''); fs.writeFileSync(globalConfig, '')
// Remove aliases before assigning sandbox values: Windows keys are case-insensitive.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:npm_config_|echo_|dsh_|astrbot_|xdg_|node_options$|node_path$|temp$|tmp$|tmpdir$|node_auth_token$|npm_token$|openai_api_key$|deepseek_api_key$|anthropic_api_key$)/iu.test(key)))
const env = { ...inherited,
  DSH_HOME: home, DSH_DATA_DIR: home,
  ECHO_DATA_DIR: path.join(home, 'echo'), ECHO_DB: path.join(home, 'echo', 'echo.db'),
  ECHO_QQ_DATA_DIR: path.join(home, 'echo-qq'), ECHO_QQ_OFFICIAL_DATA_DIR: path.join(home, 'echo-qq-official'),
  ASTRBOT_DATA: path.join(home, 'astrbot'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
  TEMP: temp, TMP: temp, TMPDIR: temp,
  npm_config_cache: path.join(folder, 'npm-cache'), npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
  npm_config_registry: 'https://registry.npmjs.org/', npm_config_audit: 'false', npm_config_fund: 'false',
  npm_config_update_notifier: 'false'
}
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const result = {
  date: new Date().toISOString(), runtime: process.version, passed: false, actualHost,
  artifactSha256: sha(artifact), previousArtifactSha256: sha(previousArtifact),
  commands: [], checks: [], hostPackageApplyCalled: false, DSHStarted: false, realHomeAccessed: false,
  QQOrModelRequests: 0, syntheticOnly: true
}
function check(name, work) {
  work(); result.checks.push({ name, passed: true })
}
function run(name, args, cwd, expected = 0, command = process.execPath) {
  const before = new Date().toISOString()
  const output = spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true })
  const log = inside(path.join(folder, name + '.log'))
  fs.writeFileSync(log, (output.stdout || '') + (output.stderr || ''))
  result.commands.push({ name, command, args, cwd, exit: output.status, expected, started: before,
    finished: new Date().toISOString(), log: path.relative(folder, log), error: output.error?.message })
  if (expected === 'nonzero') assert.ok(Number.isInteger(output.status) && output.status !== 0, name + ' must reject missing install')
  else assert.equal(output.status, expected, name + ' failed; read its log')
  return output
}
function unpack(file, name) {
  const directory = inside(path.join(folder, name)); fs.mkdirSync(directory)
  run(name + '-extract', ['-xzf', file, '-C', directory], folder, 0, 'tar')
  const source = path.join(directory, 'package')
  assert.ok(fs.existsSync(path.join(source, 'scripts', 'install.mjs')))
  return source
}
const profile = inside(path.join(home, 'profiles', 'web')), profilePath = path.join(profile, 'package.json')
const target = inside(path.join(profile, 'node_modules', 'dsh-echo')), dist = inside(path.join(profile, '.dsh-echo-local'))
function profileValue() { return JSON.parse(fs.readFileSync(profilePath, 'utf8')) }
function dataSnapshot() {
  return Object.fromEntries(fs.readdirSync(path.join(home, 'echo')).sort().map(name => {
    const file = path.join(home, 'echo', name), stat = fs.statSync(file)
    return [name, { sha256: sha(file), bytes: stat.size, mtimeMs: stat.mtimeMs }]
  }))
}
function verify(source, phase, { installerCheck = true } = {}) {
  const wanted = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
  if (installerCheck) run(phase + '-verify', ['scripts/install.mjs', '--check'], source)
  check(phase + '-install-version-and-patches', () => {
    const installed = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'))
    assert.equal(installed.name, wanted.name); assert.equal(installed.version, wanted.version)
    const patches = typeof installed.dsh.bundle.patch === 'string' ? [installed.dsh.bundle.patch] : installed.dsh.bundle.patch
    for (const patch of patches) {
      const file = path.resolve(target, patch); inside(file)
      assert.ok(fs.existsSync(file), 'Missing declared patch: ' + patch)
      assert.equal(sha(file), sha(path.resolve(source, patch)), 'Installed patch changed')
    }
    assert.ok(fs.existsSync(path.join(target, 'npm-shrinkwrap.json')), 'Installed lockfile missing')
  })
  check(phase + '-registration-and-distribution', () => {
    const value = profileValue()
    assert.ok(value.dsh.profile.bundles.includes('dsh-echo'))
    assert.ok(value.dsh.profile.bundles.includes('synthetic-unrelated'))
    assert.equal(value.dependencies['synthetic-unrelated'], 'file:./synthetic-unrelated.tgz')
    const spec = value.dependencies['dsh-echo']
    assert.equal(spec, 'file:./.dsh-echo-local/dsh-echo-' + wanted.version + '.tgz')
    assert.deepEqual(fs.readdirSync(dist).filter(name => name.endsWith('.tgz')), ['dsh-echo-' + wanted.version + '.tgz'])
  })
  const probe = inside(path.join(target, 'release-lifecycle-probe.mjs'))
  fs.writeFileSync(probe, `import assert from 'node:assert/strict';\n`
    + `import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';import{syncBuiltinESMExports}from'node:module';\n`
    + `const denied=()=>{throw Error('Network disabled during installed import probe')};globalThis.fetch=denied;net.connect=net.createConnection=net.Socket.prototype.connect=denied;tls.connect=denied;http.request=http.get=https.request=https.get=denied;syncBuiltinESMExports();\n`
    + `for (const specifier of ['saxes','yauzl','unpdf','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-llm']) await import(specifier);\n`
    + `const plugin=await import('./lib/index.js'); assert.equal(typeof plugin.apply,'function');\n`
    + `console.log('Actual public host and parser imports resolved; apply() was not called');\n`)
  run(phase + '-real-imports', [probe], folder)
  fs.rmSync(probe)
}
function removed(phase) {
  check(phase + '-removes-program-and-keeps-other-registration', () => {
    assert.equal(fs.existsSync(target), false); assert.equal(fs.existsSync(dist), false)
    const value = profileValue()
    assert.equal(value.dsh.profile.bundles.includes('dsh-echo'), false)
    assert.deepEqual(value.dsh.profile.bundles, ['synthetic-unrelated'])
    assert.equal(value.dependencies['dsh-echo'], undefined)
    assert.equal(value.dependencies['synthetic-unrelated'], 'file:./synthetic-unrelated.tgz')
  })
}
let source = null
try {
  source = unpack(artifact, 'current')
  const previousSource = unpack(previousArtifact, 'previous')
  const currentPackage = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
  const previousPackage = JSON.parse(fs.readFileSync(path.join(previousSource, 'package.json'), 'utf8'))
  result.currentVersion = currentPackage.version; result.previousVersion = previousPackage.version
  result.upgradeMode = currentPackage.version === previousPackage.version ? 'same-version-reinstall' : 'version-upgrade'
  if (expectedSource) assert.equal(currentPackage.version, JSON.parse(fs.readFileSync(path.join(expectedSource, 'package.json'), 'utf8')).version)
  if (options.previous) assert.notEqual(currentPackage.version, previousPackage.version, 'An explicitly supplied previous artifact must be older/different')
  fs.mkdirSync(profile, { recursive: true })
  const hostDestination = inside(path.join(home, 'profiles', 'node_modules'))
  // Physical copy rather than a junction: Node must resolve from the simulated profile.
  fs.cpSync(hostModules, hostDestination, { recursive: true, dereference: true })
  fs.writeFileSync(profilePath, JSON.stringify({ name: 'echo-release-synthetic-profile', private: true,
    dsh: { profile: { bundles: ['synthetic-unrelated'] } },
    dependencies: { 'synthetic-unrelated': 'file:./synthetic-unrelated.tgz' }
  }, null, 2) + '\n')
  fs.mkdirSync(path.join(home, 'echo'), { recursive: true })
  fs.writeFileSync(path.join(home, 'echo', 'config.json'), '{"syntheticLifecycleSentinel":"preserve","enabled":false}\n')
  fs.writeFileSync(path.join(home, 'echo', 'persona.json'), '{"syntheticLifecycleSentinel":"preserve"}\n')
  const dataBefore = dataSnapshot()
  run('fresh-install', ['scripts/install.mjs'], source)
  verify(source, 'fresh')
  run('fresh-doctor', ['scripts/install.mjs', '--doctor'], source)
  check('fresh-install-and-readonly-doctor-preserve-data', () => assert.deepEqual(dataSnapshot(), dataBefore))
  run('fresh-remove', ['scripts/install.mjs', '--remove'], source); removed('fresh')
  check('fresh-uninstall-keeps-data', () => assert.deepEqual(dataSnapshot(), dataBefore))
  run('fresh-check-after-remove', ['scripts/install.mjs', '--check'], source, 'nonzero')
  // The older copy installer has a separately preserved missing-asset defect.
  // Install its immutable tgz with real npm rather than executing that installer
  // or changing the old artifact to make a historical check appear green.
  const previousConsumer = inside(path.join(folder, 'previous-npm-consumer'))
  fs.mkdirSync(previousConsumer)
  fs.writeFileSync(path.join(previousConsumer, 'package.json'), JSON.stringify({
    name: 'echo-release-previous-consumer', private: true, version: '1.0.0'
  }) + '\n')
  run('previous-npm-consumer-install', [npmCli(), 'install', previousArtifact,
    '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--package-lock=false'], previousConsumer)
  // Physical copies retain npm's actual package bytes and avoid link resolution.
  const previousModules = path.join(previousConsumer, 'node_modules')
  fs.cpSync(previousModules, inside(path.join(profile, 'node_modules')), { recursive: true, dereference: true })
  fs.mkdirSync(dist, { recursive: true })
  fs.copyFileSync(previousArtifact, inside(path.join(dist, 'dsh-echo-' + previousPackage.version + '.tgz')))
  const previousProfile = profileValue()
  previousProfile.dsh.profile.bundles.push('dsh-echo')
  previousProfile.dependencies['dsh-echo'] = 'file:./.dsh-echo-local/dsh-echo-' + previousPackage.version + '.tgz'
  fs.writeFileSync(profilePath, JSON.stringify(previousProfile, null, 2) + '\n')
  result.previousInstallation = { method: 'real npm consumer install then physical copy into synthetic profile',
    oldInstallerExecuted: false, artifactModified: false, profileRegistration: 'explicit synthetic setup' }
  verify(previousSource, 'previous', { installerCheck: false })
  check('previous-version-installed-before-upgrade', () => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version, previousPackage.version)
    assert.deepEqual(dataSnapshot(), dataBefore)
  })
  run('upgrade-install', ['scripts/install.mjs'], source)
  verify(source, 'upgrade')
  check('upgrade-keeps-data', () => assert.deepEqual(dataSnapshot(), dataBefore))
  run('upgrade-remove', ['scripts/install.mjs', '--remove'], source); removed('upgrade')
  run('remove-idempotent', ['scripts/install.mjs', '--remove'], source)
  check('upgrade-uninstall-is-idempotent-and-keeps-data', () => assert.deepEqual(dataSnapshot(), dataBefore))
  result.passed = true
} catch (error) {
  result.error = String(error.stack || error)
  process.exitCode = 1
} finally {
  // Even a failed install may have swapped the program directory. Clean only the
  // explicitly owned synthetic profile, preserving all logs and source artifacts.
  if (!result.passed && source && fs.existsSync(profilePath)) {
    inside(target); inside(dist)
    try { run('failure-uninstall', ['scripts/install.mjs', '--remove'], source) } catch (error) {
      result.cleanupError = String(error.message)
    }
  }
  result.finished = new Date().toISOString()
  result.passedChecks = result.checks.length
  fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify(result, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, version: result.currentVersion,
  previous: result.previousVersion, upgradeMode: result.upgradeMode, result: path.join(folder, 'result.json') }))
