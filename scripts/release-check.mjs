/** Release gate for this checkout only. Never reads a real profile or database. */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { auditRelease, auditPackEntries } from './release-audit.mjs'
import { releaseEnvironment } from './release-env.mjs'
import { runNpm } from './npm-runner.mjs'
const root = path.resolve(import.meta.dirname, '..'), context = releaseEnvironment('check')
const folder = path.join(root, '.scratch', 'release-' + Date.now())
fs.mkdirSync(folder, { recursive: true })
const policy = JSON.parse(fs.readFileSync(path.join(root, 'scripts/release-policy.json')))
const report = { passed: false, node: process.version, syntheticOnly: true, realProfileRead: false,
  modelOrQQRequests: 0, steps: [] }
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function run(label, args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: context.env,
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true })
  fs.writeFileSync(path.join(folder, label + '.log'), (result.stdout || '') + (result.stderr || ''))
  report.steps.push({ label, exit: result.status })
  if (result.error || result.status !== 0) throw Error(label + ' failed')
}
function sourceFiles(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.scratch', '__pycache__'].includes(entry.name)) continue
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw Error('Source link is not permitted')
    if (entry.isDirectory()) sourceFiles(file, out); else out.push(file)
  }
  return out
}
try {
  const audit = auditRelease({ root, ...policy })
  report.sourceAudit = audit
  if (!audit.passed) throw Error('Source privacy, path or dependency audit failed')
  let syntaxCount = 0, inlineCount = 0
  for (const file of sourceFiles(root)) {
    if (/\.(?:mjs|cjs|js)$/u.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true })
      if (result.status !== 0) throw Error('Syntax: ' + path.relative(root, file))
      syntaxCount++
    } else if (file.endsWith('.html')) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gu)) {
        if (match[1].trim()) { new vm.Script(match[1]); inlineCount++ }
      }
    }
  }
  report.syntax = { files: syntaxCount, inlineScripts: inlineCount }
  const licenseManifest = JSON.parse(fs.readFileSync(path.join(root, 'LICENSES/SOURCES.json')))
  if (!Array.isArray(licenseManifest.files) || !licenseManifest.files.length) throw Error('License provenance manifest is missing')
  for (const entry of licenseManifest.files) {
    if (!entry.path || !entry.sha256 || sha(path.join(root, entry.path)) !== entry.sha256) throw Error('Third-party license provenance mismatch')
  }
  report.licenseFiles = licenseManifest.files.length
  run('prepack-clean-verify', ['scripts/clean-pyc.mjs', '--check'])
  const text = runNpm(['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, env: context.env })
  const [pack] = JSON.parse(text), findings = auditPackEntries(pack.files, policy)
  if (findings.length) { report.packFindings = findings; throw Error('Forbidden files in npm package') }
  const names = new Set(pack.files.map(file => file.path))
  for (const needed of ['PRIVACY.md', 'SECURITY.md', 'CONTRIBUTING.md', 'THIRD_PARTY.md',
    'lib/ipc-core/LICENSE', 'web/vendor/LICENSE.d3.txt', 'web/mock/final/index.html',
    'web/mock/final/emotion-charts.css', 'web/mock/final/memory-star.html',
    'web/mock/final/memory-star-experience.js', 'web/mock/final/vendor/jiulin/NOTICE.txt',
    'web/mock/final/vendor/jiulin/THREE-LICENSE.txt', 'npm-shrinkwrap.json', 'LICENSES/SOURCES.json']) {
    if (!names.has(needed)) throw Error('Required packaged asset missing: ' + needed)
  }
  report.package = { dryRun: true, files: pack.files.length, bytes: pack.size }
  report.passed = true
} catch (error) {
  report.error = String(error.message); process.exitCode = 1
} finally {
  fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: report.passed, report: path.relative(root, path.join(folder, 'result.json')).replaceAll('\\', '/'),
  package: report.package, error: report.error }))
