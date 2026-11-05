/** Repository-only release audit. No application modules, profiles or network. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isBuiltin } from 'node:module'

const EXCLUDED = new Set(['.git', 'node_modules', '.scratch', '.dev-host',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache'])
const IMAGE = /\.(?:png|jpe?g|webp|gif|avif|svg|ico|bmp|tiff?)$/iu
const APPROVED_IMAGE_PATH = /^docs\/images\/[^/]+\.png$/u
const SECRET_RULES = [
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/gu],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,255}\b/gu],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{35}\b/gu],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,255}\b/gu],
  ['private-key', /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----[\s\S]{32,}?-----END (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/gu],
  ['private-home-path', /\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[A-Za-z0-9_.-]+(?=[\\/"'\s]|$)/gu],
  ['private-home-path', /(?<![\w/:])\/(?:Users|home)\/[A-Za-z0-9_.-]+(?=[/"'\s]|$)/gu]
]
const LOCKED = Object.freeze({
  pend: { version: '1.2.0', integrity: 'sha512-F3asv42UuXchdzt+xXqfW1OGlVBe+mxa2mqI0pg5yAHZPvFmY3Y6drSf/GQ1A86WgWEN9Kzh/WrgKa6iGcHXLg==' },
  saxes: { version: '6.0.0', integrity: 'sha512-xAg7SOnEhrm5zI3puOOKyy1OMcMlIJZYNJY7xLBwSze0UjhPLnWfj2GF2EpT0jmzaJKIWKHLsaSSajf35bcYnA==' },
  unpdf: { version: '1.4.0', integrity: 'sha512-TahIk0xdH/4jh/MxfclzU79g40OyxtP00VnEUZdEkJoYtXAHWLiir6t3FC6z3vDqQTzc2ZHcla6uEiVTNjejuA==' },
  xmlchars: { version: '2.2.0', integrity: 'sha512-JZnDKK8B0RCDw84FNdDAIpZK+JuJw+s7Lz8nksI7SIuU3UXJJslUthsi+uWBUYOwPFwW7W7PRLRfUKpxjtjFCw==' },
  yauzl: { version: '3.4.0', integrity: 'sha512-jIH9yLR9wqr0wOS0TpBvo/g/2UgZH5qePVbjgRliiF0BYvOZyaBknKsF+x9Iht0O6sqgnB93rCICdOZFecJuDw==' }
})
const DIRECT = Object.freeze({ saxes: '6.0.0', unpdf: '1.4.0', yauzl: '3.4.0' })
const HOST_PROVIDED = new Set(['react', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm'])
export const expectedProductionDependencies = LOCKED
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const slash = value => value.replaceAll('\\', '/')
const within = (root, file) => file === root || file.startsWith(root + path.sep)
const lineAt = (text, index) => text.slice(0, index).split('\n').length
function pathFinding(file, directory = false) {
  const pieces = slash(file).split('/').filter(Boolean), lower = pieces.map(piece => piece.toLowerCase())
  const name = lower.at(-1) || ''
  if (lower.some(piece => ['credentials', 'backups', 'backup', 'data', 'state', 'logs'].includes(piece))) return 'runtime-directory'
  if (!directory && (/^(?:config|profile|persona|names|aliases|graph|lexicon|state-defaults|data-rev|embed-state)\.json$/u.test(name)
    || /(?:\.db(?:-.*)?|\.sqlite.*)$/u.test(name)
    || /^(?:credentials|tokens?|secrets?)\.json$/u.test(name))) return 'runtime-data-file'
  if (!directory && ((/^\.env(?:\.|$)/u.test(name) && name !== '.env.example')
    || /(?:^|\.)private\.env$/u.test(name)
    || /^(?:id_rsa|id_ed25519|id_dsa)(?:\.pub)?$/u.test(name)
    || /\.(?:pem|key|p12|pfx|keystore)$/u.test(name))) return 'credential-file'
  return null
}
function entryPath(raw) {
  const item = typeof raw === 'string' ? raw : raw?.path
  if (typeof item !== 'string' || !item || item.includes('\0')) return null
  const normalized = slash(item).replace(/^package\//u, '')
  if (/^(?:\/|[A-Za-z]:)/u.test(normalized) || normalized.split('/').includes('..')) return null
  return normalized.replace(/^\.\//u, '')
}

/** Also apply to npm pack --json `files`; this never opens archive contents. */
export function auditPackEntries(entries, { approvedImages = {} } = {}) {
  const findings = []
  if (Object.keys(approvedImages).length > 2) findings.push({ rule: 'image-policy-limit', file: '(policy)', line: 0 })
  for (const entry of entries) {
    const file = entryPath(entry)
    if (!file) { findings.push({ rule: 'invalid-pack-path', file: '(package entry)', line: 0 }); continue }
    const rule = pathFinding(file)
    if (rule) findings.push({ rule, file, line: 0 })
    if (IMAGE.test(file) && (!Object.hasOwn(approvedImages, file) || !APPROVED_IMAGE_PATH.test(file))) findings.push({ rule: 'unapproved-image', file, line: 0 })
    if (file.split('/').some(piece => EXCLUDED.has(piece)) || /\.(?:pyc|pyo|log|tgz)$/iu.test(file)) {
      findings.push({ rule: 'generated-pack-file', file, line: 0 })
    }
    if (file.startsWith('tests/') || file.startsWith('python/tests/')) findings.push({ rule: 'development-test-packed', file, line: 0 })
  }
  return findings
}

// A small token reader keeps quoted examples and comments out of import checks.
// Syntax itself belongs to `node --check`, not to this dependency audit.
function tokensOf(text) {
  const tokens = []; let i = 0, previous = ''
  const regexAfter = new Set(['', '=', '(', '[', '{', ':', ',', ';', '!', '?', '&&', '||', 'return', 'case', '=>'])
  while (i < text.length) {
    const ch = text[i], next = text[i + 1]
    if (/\s/u.test(ch)) { i++; continue }
    if (ch === '/' && next === '/') { i = text.indexOf('\n', i + 2); if (i < 0) break; continue }
    if (ch === '/' && next === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue }
    if (ch === '"' || ch === "'") {
      const start = i++, quote = ch; let raw = ''
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < text.length) {
          const escaped = text[++i]
          raw += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' })[escaped] ?? escaped
          i++
        } else raw += text[i++]
      }
      i++; tokens.push({ kind: 'string', value: raw, index: start }); previous = 'string'; continue
    }
    if (ch === '`') {
      i++
      while (i < text.length) { if (text[i] === '\\') i += 2; else if (text[i++] === '`') break }
      previous = 'template'; continue
    }
    if (ch === '/' && regexAfter.has(previous)) {
      i++; let characterClass = false
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === '[') characterClass = true
        if (text[i] === ']') characterClass = false
        if (text[i++] === '/' && !characterClass) break
      }
      while (/[A-Za-z]/u.test(text[i] || '')) i++
      previous = 'regex'; continue
    }
    const word = text.slice(i).match(/^[A-Za-z_$][\w$]*/u)
    if (word) {
      tokens.push({ kind: 'word', value: word[0], index: i }); previous = word[0]; i += word[0].length; continue
    }
    const pair = text.slice(i, i + 2)
    const value = ['=>', '&&', '||', '?.'].includes(pair) ? pair : ch
    tokens.push({ kind: 'punct', value, index: i }); previous = value; i += value.length
  }
  return tokens
}
export function moduleReferences(text) {
  const tokens = tokensOf(text), found = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], next = tokens[i + 1]
    if (token.kind !== 'word') continue
    if (token.value === 'require' && next?.value === '(' && tokens[i + 2]?.kind === 'string') found.push(tokens[i + 2])
    if (token.value === 'import') {
      if (next?.kind === 'string') found.push(next)
      else if (next?.value === '(' && tokens[i + 2]?.kind === 'string') found.push(tokens[i + 2])
      else if (next?.value !== '.' && next?.value !== '?.') {
        for (let j = i + 1; j < tokens.length && j < i + 80 && tokens[j].value !== ';'; j++) {
          if (tokens[j].value === 'from' && tokens[j + 1]?.kind === 'string') { found.push(tokens[j + 1]); break }
        }
      }
    }
    if (token.value === 'export' && ['*', '{'].includes(next?.value)) {
      for (let j = i + 1; j < tokens.length && j < i + 80 && tokens[j].value !== ';'; j++) {
        if (tokens[j].value === 'from' && tokens[j + 1]?.kind === 'string') { found.push(tokens[j + 1]); break }
      }
    }
  }
  return found
}

export function auditRelease({ root: requestedRoot, approvedImages = {}, approvedBinaryFixtures = {}, credentialAllowlist = [] } = {}) {
  if (typeof requestedRoot !== 'string' || !requestedRoot) throw Error('An explicit repository root is required')
  const root = fs.realpathSync(path.resolve(requestedRoot))
  const packageFile = path.join(root, 'package.json')
  if (!fs.existsSync(packageFile)) throw Error('Repository package.json is missing')
  const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
  if (metadata.name !== 'dsh-echo') throw Error('This scanner only accepts the dsh-echo source repository')
  const findings = [], files = [], textFiles = new Map(), exceptionUses = new Map()
  const counts = { files: 0, textFiles: 0, approvedImages: 0, approvedBinaryFixtures: 0, relativeImports: 0, assetReferences: 0,
    packageTargets: 0, lockedDependencies: 0, hostImports: 0, productionImports: 0, credentialExceptions: 0 }
  const add = (rule, file, line = 0) => findings.push({ rule, file: slash(file), line })
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name)) continue
      const full = path.join(directory, entry.name), file = slash(path.relative(root, full))
      const rule = pathFinding(file, entry.isDirectory())
      if (rule) { add(rule, file); continue } // Do not open accidentally copied runtime data.
      if (entry.isSymbolicLink()) { add('repository-link', file); continue }
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile()) { add('unsupported-file-type', file); continue }
      files.push(file); counts.files++
      if (IMAGE.test(file)) {
        if (!Object.hasOwn(approvedImages, file)) { add('unapproved-image', file); continue }
        const bytes = fs.readFileSync(full)
        if (!/^[0-9a-f]{64}$/u.test(approvedImages[file]) || sha256(bytes) !== approvedImages[file]) add('image-hash-mismatch', file)
        else counts.approvedImages++
        continue
      }
      const bytes = fs.readFileSync(full)
      if (Object.hasOwn(approvedBinaryFixtures, file)) {
        if (!file.startsWith('tests/fixtures/') || !/^[0-9a-f]{64}$/u.test(approvedBinaryFixtures[file])
          || sha256(bytes) !== approvedBinaryFixtures[file]) add('binary-fixture-hash-mismatch', file)
        else counts.approvedBinaryFixtures++
        continue
      }
      if (bytes.includes(0)) { add('unapproved-binary', file); continue }
      let text
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { add('non-utf8-source', file); continue }
      textFiles.set(file, text); counts.textFiles++
      if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) add('utf8-bom', file)
      for (const [secretRule, expression] of SECRET_RULES) {
        expression.lastIndex = 0
        for (const match of text.matchAll(expression)) {
          const exceptionIndex = credentialAllowlist.findIndex(item => item.file === file && item.rule === secretRule
            && item.sha256 === sha256(bytes) && typeof item.reason === 'string' && item.reason.trim())
          if (exceptionIndex >= 0) {
            exceptionUses.set(exceptionIndex, (exceptionUses.get(exceptionIndex) || 0) + 1); counts.credentialExceptions++
          } else add(secretRule, file, lineAt(text, match.index))
        }
      }
    }
  }
  walk(root)
  if (Object.keys(approvedImages).length > 2) add('image-policy-limit', '(policy)')
  for (const [file, hash] of Object.entries(approvedImages)) {
    if (!/^[0-9a-f]{64}$/u.test(hash) || !APPROVED_IMAGE_PATH.test(file)) add('invalid-image-policy', file)
    if (!files.includes(file)) add('approved-image-missing', file)
  }
  for (const [file, hash] of Object.entries(approvedBinaryFixtures)) {
    if (!file.startsWith('tests/fixtures/') || !/^[0-9a-f]{64}$/u.test(hash)) add('invalid-binary-fixture-policy', file)
    if (!files.includes(file)) add('approved-binary-fixture-missing', file)
  }
  credentialAllowlist.forEach((entry, index) => {
    if (!Number.isSafeInteger(entry.occurrences) || entry.occurrences < 1
      || exceptionUses.get(index) !== entry.occurrences) add('credential-exception-drift', entry.file || '(exception)')
  })
  function target(source, reference, index, category, browserAsset = false) {
    if (!reference) return
    if (category === 'module' && /^(?:https?:|data:)/iu.test(reference)) { add('remote-module', source, index); return }
    if (/^(?:#|data:|https?:\/\/)/iu.test(reference)) return
    if (/^(?:file:|[A-Za-z]:|\\\\|\/(?:Users|home)\/)/u.test(reference)) {
      add('absolute-' + category, source, index); return
    }
    let destination
    if (browserAsset && reference.startsWith('/echo/')) destination = path.resolve(root, 'web', reference.slice('/echo/'.length).split(/[?#]/u)[0] || 'index.html')
    else if (reference.startsWith('/')) { add('absolute-' + category, source, index); return }
    else destination = path.resolve(root, path.dirname(source), reference.split(/[?#]/u)[0])
    if (!within(root, destination)) { add('outside-repository-' + category, source, index); return }
    if (category === 'module') counts.relativeImports++
    else if (category === 'asset') counts.assetReferences++
    else counts.packageTargets++
    if (!fs.existsSync(destination)) { add('missing-' + category, source, index); return }
    const stat = fs.lstatSync(destination)
    if (stat.isSymbolicLink() || !within(root, fs.realpathSync(destination))) add('linked-' + category, source, index)
  }
  for (const [file, text] of textFiles) {
    if (!/^(?:lib|web|scripts)\//u.test(file)) continue
    if (/\.(?:mjs|cjs|js)$/iu.test(file)) for (const ref of moduleReferences(text)) {
      if (/^(?:\.{1,2}\/|file:|https?:|data:|[A-Za-z]:|\/|\\\\)/u.test(ref.value)) target(file, ref.value, lineAt(text, ref.index), 'module')
      else if (!isBuiltin(ref.value)) {
        const name = ref.value.startsWith('@') ? ref.value.split('/').slice(0, 2).join('/') : ref.value.split('/')[0]
        if (Object.hasOwn(DIRECT, name)) counts.productionImports++
        else if (HOST_PROVIDED.has(name)) counts.hostImports++
        else add('undeclared-import', file, lineAt(text, ref.index))
      }
    }
    if (/\.(?:html|css)$/iu.test(file)) {
      const patterns = file.endsWith('.css') ? [/url\(\s*["']?([^"')]+)["']?\s*\)/giu]
        : [/<(?:script|img|source)\b[^>]*?\bsrc=["']([^"']+)["']/giu,
          /<link\b[^>]*?\bhref=["']([^"']+)["']/giu]
      for (const pattern of patterns) for (const match of text.matchAll(pattern)) target(file, match[1], lineAt(text, match.index), 'asset', true)
    }
  }
  const packageTarget = value => {
    if (typeof value === 'string') target('package.json', value, 0, 'package-target')
    else if (value && typeof value === 'object') Object.values(value).forEach(packageTarget)
  }
  packageTarget(metadata.main); packageTarget(metadata.exports)
  packageTarget(metadata.dsh?.bundle?.patch)
  for (const file of metadata.files || []) target('package.json', file.replace(/\/$/u, ''), 0, 'package-target')
  const lockText = textFiles.get('npm-shrinkwrap.json')
  if (!lockText) add('shrinkwrap-missing', 'npm-shrinkwrap.json')
  else {
    let lock
    try { lock = JSON.parse(lockText) } catch { add('shrinkwrap-invalid-json', 'npm-shrinkwrap.json') }
    if (lock) {
      if (lock.lockfileVersion !== 3 || lock.version !== metadata.version || lock.packages?.['']?.version !== metadata.version) add('shrinkwrap-root-mismatch', 'npm-shrinkwrap.json')
      if (JSON.stringify(Object.entries(metadata.dependencies || {}).sort()) !== JSON.stringify(Object.entries(DIRECT).sort())
        || JSON.stringify(Object.entries(lock.packages?.['']?.dependencies || {}).sort()) !== JSON.stringify(Object.entries(DIRECT).sort())) add('production-dependency-mismatch', 'package.json')
      const actual = Object.keys(lock.packages || {}).filter(name => name !== '' && !lock.packages[name].dev).sort()
      if (JSON.stringify(actual) !== JSON.stringify(Object.keys(LOCKED).map(name => 'node_modules/' + name).sort())) add('shrinkwrap-package-set', 'npm-shrinkwrap.json')
      if (JSON.stringify(Object.entries(lock.packages?.['']?.devDependencies || {}).sort())
        !== JSON.stringify(Object.entries(metadata.devDependencies || {}).sort())) add('shrinkwrap-dev-mismatch', 'npm-shrinkwrap.json')
      for (const [name, version] of Object.entries(metadata.devDependencies || {})) {
        const entry = lock.packages?.['node_modules/' + name]
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) || entry?.version !== version) add('unpinned-development-dependency', 'package.json')
      }
      for (const [name, entry] of Object.entries(lock.packages || {})) {
        if (name && (!String(entry.resolved).startsWith('https://registry.npmjs.org/') || !String(entry.integrity).startsWith('sha512-'))) add('unverified-lock-entry', 'npm-shrinkwrap.json')
      }
      for (const [name, expected] of Object.entries(LOCKED)) {
        const info = lock.packages?.['node_modules/' + name]
        const resolved = 'https://registry.npmjs.org/' + name + '/-/' + name + '-' + expected.version + '.tgz'
        if (!info || info.version !== expected.version || info.integrity !== expected.integrity || info.resolved !== resolved) add('locked-dependency-mismatch', 'npm-shrinkwrap.json')
        else counts.lockedDependencies++
      }
    }
  }
  const unique = [...new Map(findings.map(item => [item.rule + '\0' + item.file + '\0' + item.line, item])).values()]
  return { passed: unique.length === 0, counts, findings: unique }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = process.argv[2] || path.resolve(import.meta.dirname, '..')
    const result = auditRelease({ root })
    console.log(JSON.stringify(result, null, 2))
    if (!result.passed) process.exitCode = 1
  } catch {
    // Do not print paths, source text, exception messages or private values.
    console.log(JSON.stringify({ passed: false, findings: [{ rule: 'audit-operational-error', file: '(repository)', line: 0 }] }))
    process.exitCode = 2
  }
}
