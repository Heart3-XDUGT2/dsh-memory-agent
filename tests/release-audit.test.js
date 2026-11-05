import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { after, test } from 'node:test'
import { auditRelease, auditPackEntries, moduleReferences, expectedProductionDependencies } from '../scripts/release-audit.mjs'

const folders = []
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-release-audit-'))
  folders.push(root)
  for (const directory of ['lib', 'web', 'scripts', 'docs']) fs.mkdirSync(path.join(root, directory))
  const dependencies = { saxes: '6.0.0', unpdf: '1.4.0', yauzl: '3.4.0' }
  const metadata = { name: 'dsh-echo', version: '0.0.0-test.1', type: 'module', main: 'lib/index.js',
    dependencies, files: ['lib/', 'web/', 'scripts/', 'docs/'] }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(metadata))
  const lock = { name: metadata.name, version: metadata.version, lockfileVersion: 3, packages: {
    '': { name: metadata.name, version: metadata.version, dependencies },
    ...Object.fromEntries(Object.entries(expectedProductionDependencies).map(([name, info]) => ['node_modules/' + name,
      { ...info, resolved: 'https://registry.npmjs.org/' + name + '/-/' + name + '-' + info.version + '.tgz' }]))
  } }
  fs.writeFileSync(path.join(root, 'npm-shrinkwrap.json'), JSON.stringify(lock))
  fs.writeFileSync(path.join(root, 'lib/index.js'), "export const value = 1\n")
  return root
}
function write(root, file, text) {
  const target = path.join(root, file)
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text)
}
const rules = result => result.findings.map(finding => finding.rule)
after(() => {
  const temporaryRoot = path.resolve(os.tmpdir())
  for (const folder of folders) {
    const absolute = path.resolve(folder)
    assert.ok(absolute.startsWith(temporaryRoot + path.sep))
    assert.ok(path.basename(absolute).startsWith('echo-release-audit-'))
    fs.rmSync(absolute, { recursive: true, force: true })
  }
})

test('clean isolated source passes with five pinned dependencies', () => {
  const result = auditRelease({ root: fixture() })
  assert.equal(result.passed, true); assert.equal(result.counts.lockedDependencies, 5)
})
test('actual credential bytes fail without exposing the matched value', () => {
  const root = fixture(), credential = ['ghp', '_', 'X'.repeat(36)].join('')
  write(root, 'lib/leak.js', 'export const credential = ' + JSON.stringify(credential))
  const result = auditRelease({ root })
  assert.ok(rules(result).includes('github-token'))
  assert.equal(JSON.stringify(result).includes(credential), false)
  assert.equal(result.findings.find(finding => finding.rule === 'github-token').line, 1)
})
test('OpenAI, cloud and PEM controls are rejected, with no match text in report', () => {
  const root = fixture()
  const values = [['sk', '-', 'proj', '-', 'A'.repeat(32)].join(''), ['AK', 'IA', 'B'.repeat(16)].join(''),
    ['AI', 'za', 'C'.repeat(35)].join(''), ['xox', 'b-', 'D'.repeat(30)].join(''),
    ['-----BEGIN ', 'PRIVATE KEY-----\n', 'E'.repeat(64), '\n-----END ', 'PRIVATE KEY-----'].join('')]
  write(root, 'docs/leak.txt', values.join('\n'))
  const result = auditRelease({ root })
  for (const rule of ['openai-key', 'aws-access-key', 'google-api-key', 'slack-token', 'private-key']) assert.ok(rules(result).includes(rule))
  for (const value of values) assert.equal(JSON.stringify(result).includes(value), false)
})
test('runtime and credential paths fail without opening their contents', () => {
  const root = fixture()
  for (const file of ['config.json', 'persona.json', 'names.json', 'profile.json', '.env', 'private.env',
    'runtime.db', 'runtime.db-wal', 'runtime.sqlite-shm', 'id_rsa', 'cert.key', 'backups/one.txt', 'data/unknown.json']) write(root, file, 'private data should not be reported')
  const originalRead = fs.readFileSync, reads = []
  let result
  try {
    fs.readFileSync = (file, ...args) => { reads.push(path.resolve(String(file))); return originalRead(file, ...args) }
    result = auditRelease({ root })
  } finally { fs.readFileSync = originalRead }
  assert.equal(result.passed, false)
  assert.ok(rules(result).includes('runtime-data-file')); assert.ok(rules(result).includes('credential-file'))
  assert.ok(rules(result).includes('runtime-directory')); assert.equal(JSON.stringify(result).includes('private data'), false)
  for (const file of ['config.json', 'persona.json', 'names.json', 'profile.json', '.env', 'private.env',
    'runtime.db', 'runtime.db-wal', 'runtime.sqlite-shm', 'id_rsa', 'cert.key', 'backups/one.txt', 'data/unknown.json']) {
    assert.equal(reads.includes(path.join(root, file)), false)
  }
})
test('private home literals are rejected at their actual line without reading a home directory', () => {
  const root = fixture(), home = ['C:', 'Users', 'synthetic-user'].join('/'), posix = ['', 'home', 'synthetic-user'].join('/')
  write(root, 'docs/paths.txt', ['plain text', home, posix].join('\n'))
  const result = auditRelease({ root }), findings = result.findings.filter(finding => finding.rule === 'private-home-path')
  assert.deepEqual(findings.map(finding => finding.line), [2, 3])
  assert.equal(JSON.stringify(result).includes(home), false); assert.equal(JSON.stringify(result).includes(posix), false)
})
test('forbidden package entries and unapproved screenshots fail', () => {
  const findings = auditPackEntries(['package/echo.db-wal', 'package/docs/screenshots/audit.png',
    'package/node_modules/one.js', '../escape.js'])
  for (const rule of ['runtime-data-file', 'unapproved-image', 'generated-pack-file', 'invalid-pack-path']) assert.ok(findings.some(finding => finding.rule === rule))
})
test('image approvals require an exact path and digest', () => {
  const root = fixture(), bytes = Buffer.from('synthetic image bytes')
  write(root, 'docs/images/approved.png', bytes)
  assert.equal(auditRelease({ root }).passed, false)
  const approvedImages = { 'docs/images/approved.png': sha256(bytes) }
  assert.equal(auditRelease({ root, approvedImages }).passed, true)
  write(root, 'docs/images/approved.png', Buffer.from('different synthetic bytes'))
  assert.ok(rules(auditRelease({ root, approvedImages })).includes('image-hash-mismatch'))
})
test('approval cannot authorize old audit screenshots or more than two PNG files', () => {
  const root = fixture(), bytes = Buffer.from('synthetic image bytes'), file = 'docs/screenshots/old.png'
  write(root, file, bytes)
  assert.ok(rules(auditRelease({ root, approvedImages: { [file]: sha256(bytes) } })).includes('invalid-image-policy'))
  const approvedImages = Object.fromEntries(['one', 'two', 'three'].map(name => ['docs/images/' + name + '.png', sha256(bytes)]))
  assert.ok(rules(auditRelease({ root, approvedImages })).includes('image-policy-limit'))
})
test('absolute OS module imports fail', () => {
  const root = fixture()
  write(root, 'lib/absolute.js', 'import x from ' + JSON.stringify(['C:', '/private/vendor.js'].join('')) + '\nexport { x }\n')
  assert.ok(rules(auditRelease({ root })).includes('absolute-module'))
})
test('remote module imports and undeclared dependencies fail', () => {
  const root = fixture()
  write(root, 'lib/remote.js', "import 'https://example.invalid/module.js'\nimport 'undeclared-package'\n")
  const result = auditRelease({ root })
  assert.ok(rules(result).includes('remote-module')); assert.ok(rules(result).includes('undeclared-import'))
})
test('missing and escaping relative imports fail', () => {
  const root = fixture()
  write(root, 'lib/broken.js', "import './absent.js'\nexport * from '../../outside.js'\n")
  const result = auditRelease({ root })
  assert.ok(rules(result).includes('missing-module')); assert.ok(rules(result).includes('outside-repository-module'))
})
test('package exports and browser assets must exist', () => {
  const root = fixture(), file = path.join(root, 'package.json'), pkg = JSON.parse(fs.readFileSync(file))
  pkg.exports = { '.': './lib/absent.js' }; fs.writeFileSync(file, JSON.stringify(pkg))
  write(root, 'web/index.html', '<link rel="stylesheet" href="./absent.css"><script src="/echo/absent.js"></script>')
  const result = auditRelease({ root })
  assert.ok(rules(result).includes('missing-package-target')); assert.ok(rules(result).includes('missing-asset'))
})
test('browser root routes map to repository web assets', () => {
  const root = fixture()
  write(root, 'web/index.html', '<script src="/echo/script.js"></script><link rel="stylesheet" href="./style.css">')
  write(root, 'web/script.js', 'export const okay = true\n'); write(root, 'web/style.css', 'body {color: black}')
  assert.equal(auditRelease({ root }).passed, true)
})
test('relative import tokenizer ignores examples and comments', () => {
  const refs = moduleReferences(`// import './comment.js'
const example = "import './example.js'";
const expression = /import\\('pattern'\\)/;
import { a } from './actual.js'
export * from './second.js'
const module = import('./third.js')`)
  assert.deepEqual(refs.map(ref => ref.value), ['./actual.js', './second.js', './third.js'])
})
test('credential exceptions bind the full file hash, rule and exact occurrence count', () => {
  const root = fixture(), file = 'docs/synthetic.txt', credential = ['ghp', '_', 'Z'.repeat(36)].join('')
  const text = 'synthetic fixture: ' + credential + '\n'; write(root, file, text)
  const credentialAllowlist = [{ file, rule: 'github-token', sha256: sha256(Buffer.from(text)), occurrences: 1,
    reason: 'Explicit negative-control sample, never a credential' }]
  assert.equal(auditRelease({ root, credentialAllowlist }).passed, true)
  write(root, file, text + 'new text\n')
  const changed = auditRelease({ root, credentialAllowlist })
  assert.ok(rules(changed).includes('github-token')); assert.ok(rules(changed).includes('credential-exception-drift'))
})
test('dependency version, registry and integrity changes fail', () => {
  const root = fixture(), file = path.join(root, 'npm-shrinkwrap.json'), lock = JSON.parse(fs.readFileSync(file))
  lock.packages['node_modules/pend'].resolved = 'https://example.invalid/pend.tgz'
  lock.packages['node_modules/saxes'].integrity = 'sha512-' + 'A'.repeat(86) + '=='
  fs.writeFileSync(file, JSON.stringify(lock))
  assert.ok(rules(auditRelease({ root })).includes('locked-dependency-mismatch'))
})
test('excluded development roots never supply source checks or hide packed files', () => {
  const root = fixture()
  for (const directory of ['node_modules', '.dev-host', '.scratch', '.git']) write(root, directory + '/config.json', 'private data')
  assert.equal(auditRelease({ root }).passed, true)
  assert.ok(auditPackEntries(['package/.dev-host/one.js']).some(finding => finding.rule === 'generated-pack-file'))
})
test('approved binary test fixtures bind exact bytes and cannot enter runtime package', () => {
  const root = fixture(), file = 'tests/fixtures/one.pdf', bytes = Buffer.from([0, 1, 2, 3])
  write(root, file, bytes)
  assert.equal(auditRelease({ root }).passed, false)
  const approvedBinaryFixtures = { [file]: sha256(bytes) }
  assert.equal(auditRelease({ root, approvedBinaryFixtures }).passed, true)
  write(root, file, Buffer.from([0, 1, 2, 4]))
  assert.ok(rules(auditRelease({ root, approvedBinaryFixtures })).includes('binary-fixture-hash-mismatch'))
  assert.ok(auditPackEntries([file]).some(finding => finding.rule === 'development-test-packed'))
})
