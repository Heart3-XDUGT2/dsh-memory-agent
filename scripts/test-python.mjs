/** Public baseline runs from an owned temporary cwd; no real home/user site. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { releaseEnvironment } from './release-env.mjs'

const flags = process.argv.slice(2)
if (flags.some(flag => !['--list', '--audit-only', '--guard-selftest'].includes(flag))) throw Error('Only --list, --audit-only or --guard-selftest is supported')
const selftest = flags.includes('--guard-selftest')
const root = path.resolve(import.meta.dirname, '..')
const parentHomeKeys = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']
const parentHome = parentHomeKeys.map(key => process.env[key])
const context = releaseEnvironment('python')
const home = path.join(context.folder, 'synthetic-home')
// Python receives a loader/locale allowlist, not a copy of arbitrary secrets.
// Canonical spelling also prevents case-insensitive duplicates on Windows.
const allowed = new Map(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC',
  'LANG', 'LC_ALL', 'TZ', 'SYSTEMDRIVE', 'NUMBER_OF_PROCESSORS'].map(key => [key.toLowerCase(), key]))
const cleaned = {}
for (const [key, value] of Object.entries(context.env)) {
  const canonical = allowed.get(key.toLowerCase())
  if (canonical && !Object.hasOwn(cleaned, canonical)) cleaned[canonical] = value
}
const drive = path.parse(home).root.replace(/[\\/]+$/u, '')
const env = { ...cleaned, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'),
  LOCALAPPDATA: path.join(home, 'local-appdata'), DSH_HOME: home, DSH_DATA_DIR: home,
  HOMEDRIVE: drive, HOMEPATH: drive ? home.slice(drive.length) : home,
  XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
  TEMP: context.folder, TMP: context.folder, TMPDIR: context.folder }
for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME]) {
  fs.mkdirSync(directory, { recursive: true })
}
const childEnvironmentKeysUnique = new Set(Object.keys(env).map(key => key.toLowerCase())).size === Object.keys(env).length
if (!childEnvironmentKeysUnique) throw Error('python_environment_key_collision')

const temporaryRoot = fs.realpathSync(os.tmpdir())
const outsidePrefix = 'echo-release-python-outside-control-'
function requireOwnedOutsideControl(folder) {
  if (!path.isAbsolute(folder) || !path.isAbsolute(temporaryRoot)) throw Error('outside_control_not_absolute')
  const resolved = path.resolve(folder)
  const relative = path.relative(temporaryRoot, resolved)
  if (!relative || relative.includes(path.sep) || path.isAbsolute(relative) ||
      relative.startsWith('..') || !path.basename(resolved).startsWith(outsidePrefix) ||
      path.dirname(resolved) !== temporaryRoot ||
      fs.lstatSync(resolved).isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw Error('outside_control_not_owned')
  }
  for (const excluded of [root, context.folder]) {
    const relation = path.relative(excluded, resolved)
    const inverse = path.relative(resolved, excluded)
    if (!relation || !inverse || (!relation.startsWith('..') && !path.isAbsolute(relation)) ||
        (!inverse.startsWith('..') && !path.isAbsolute(inverse))) throw Error('outside_control_not_separate')
  }
  return resolved
}

function outsideSnapshot(folder) {
  requireOwnedOutsideControl(folder)
  const entries = []
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, item.name)
      const relative = path.relative(folder, file).replaceAll('\\', '/')
      if (item.isSymbolicLink()) throw Error('outside_control_link_forbidden')
      if (item.isDirectory()) {
        entries.push({ file: relative, directory: true })
        visit(file)
      } else if (item.isFile()) {
        entries.push({ file: relative, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') })
      } else throw Error('outside_control_entry_forbidden')
    }
  }
  visit(folder)
  return entries
}

let outsideControl
let beforeOutside
let result
let outsideHashesUnchanged = false
try {
  if (selftest) {
    outsideControl = requireOwnedOutsideControl(fs.mkdtempSync(path.join(temporaryRoot, outsidePrefix)))
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(path.join(outsideControl, 'echo.db'))
    try {
      database.exec("PRAGMA journal_mode=DELETE; CREATE TABLE sentinel(value TEXT NOT NULL); INSERT INTO sentinel VALUES ('synthetic outside guard sentinel');")
    } finally {
      database.close()
    }
    fs.writeFileSync(path.join(outsideControl, 'ordinary.txt'), 'synthetic ordinary guard sentinel\n')
    fs.writeFileSync(path.join(outsideControl, 'config.json'), '{"syntheticGuardControl":true}\n')
    fs.writeFileSync(path.join(outsideControl, 'model.onnx'), Buffer.from('synthetic model guard sentinel\n'))
    beforeOutside = outsideSnapshot(outsideControl)
    if (beforeOutside.length !== 4) throw Error('outside_control_file_count')
  }
  const outsideArguments = selftest ? ['--outside-control', outsideControl] : []
  result = spawnSync(process.env.PYTHON || 'python', ['-I', '-S', '-B',
    path.join(root, 'python/tests/run_release.py'), '--root', root, '--sandbox', context.folder, ...flags, ...outsideArguments],
  { cwd: context.folder, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true })
  if (selftest) {
    outsideHashesUnchanged = JSON.stringify(beforeOutside) === JSON.stringify(outsideSnapshot(outsideControl))
    const parentHomeUnchanged = parentHomeKeys.every((key, index) => process.env[key] === parentHome[index])
    if (result.error || result.status !== 0) throw Error('python_guard_selftest_child_failed')
    const controls = JSON.parse(result.stdout)
    const workerProofKeys = ['caughtOutsideSqlite', 'continuedWithPong', 'childExitNonzero',
      'sharedJournalPersisted', 'protocolParsedAndDiscarded', 'environmentRestored']
    if (controls.passed !== true || controls.checks !== 16 || controls.blocked !== 13 ||
        controls.localBlocked !== 12 || controls.workerProcesses !== 1 ||
        controls.journalRecords !== 13 || controls.journalProcesses !== 2 ||
        !Array.isArray(controls.names) || controls.names.length !== 16 || new Set(controls.names).size !== 16 ||
        controls.importReadRefusedBeforeOpen !== true || controls.networkCallRefusedBeforeResolution !== true ||
        controls.readonlyBackupRefusedBeforeSourceOpen !== true ||
        !controls.workerProof || Array.isArray(controls.workerProof) ||
        workerProofKeys.some(key => controls.workerProof[key] !== true) ||
        Object.keys(controls.workerProof).length !== workerProofKeys.length ||
        !outsideHashesUnchanged || !parentHomeUnchanged) throw Error('python_guard_selftest_proof_failed')
    console.log(JSON.stringify(controls))
    console.log(JSON.stringify({ mode: 'GUARD_OUTSIDE_SENTINEL_PROOF', passed: true, checks: 17,
      pythonControls: controls.checks, blocked: controls.blocked, outsideFiles: beforeOutside.length,
      outsideHashesUnchanged, guardJournalRecords: controls.journalRecords,
      parentHomeUnchanged, childEnvironmentKeysUnique }))
  } else {
    process.stdout.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    const resultFile = path.join(context.folder, 'python-release-result.json')
    const auditFile = path.join(context.folder, 'python-source-audit.json')
    if (fs.existsSync(resultFile) || fs.existsSync(auditFile)) {
      const evidence = path.join(root, '.scratch', 'python-baseline-' + Date.now() + '-' + process.pid)
      fs.mkdirSync(evidence, { recursive: true })
      if (fs.existsSync(resultFile)) fs.copyFileSync(resultFile, path.join(evidence, 'result.json'))
      if (fs.existsSync(auditFile)) fs.copyFileSync(auditFile, path.join(evidence, 'source-audit.json'))
      fs.writeFileSync(path.join(evidence, 'output.log'), (result.stdout || '') + (result.stderr || ''))
      console.log(JSON.stringify({ evidence: path.relative(root, evidence).replaceAll('\\', '/'), temporaryCwd: true }))
    }
  }
  process.exitCode = result.error || result.status !== 0 ? 1 : 0
} catch {
  // Selftest errors never disclose the outside root or any sentinel contents.
  console.error(JSON.stringify({ passed: false, error: 'python_guard_parent_failure' }))
  process.exitCode = 1
} finally {
  if (outsideControl) {
    try {
      requireOwnedOutsideControl(outsideControl)
      fs.rmSync(outsideControl, { recursive: true, force: true })
    } catch {
      console.error(JSON.stringify({ passed: false, error: 'outside_control_cleanup_failed' }))
      process.exitCode = 1
    }
  }
}
