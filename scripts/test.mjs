/** Enumerate both suffixes; classify sibling-dependent tests without dropping them. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyDevelopment } from './dev-bootstrap.mjs'
import { releaseEnvironment } from './release-env.mjs'
const root = path.resolve(import.meta.dirname, '..'), mode = process.argv[2] || 'unit'
if (!['unit', 'integration', 'all'].includes(mode)) throw Error('Expected unit, integration or all')
await verifyDevelopment()
const cache = new Map()
function needsBridge(file, seen = new Set()) {
  if (cache.has(file)) return cache.get(file)
  if (seen.has(file) || !fs.existsSync(file)) return false
  seen.add(file)
  const text = fs.readFileSync(file, 'utf8')
  let result = /dsh-qq-bridge\//u.test(text)
  for (const match of text.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/gu)) {
    const child = path.resolve(path.dirname(file), match[1])
    if (child.startsWith(root + path.sep) && /\.(?:js|mjs)$/u.test(child)) result ||= needsBridge(child, seen)
  }
  cache.set(file, result); return result
}
const all = fs.readdirSync(path.join(root, 'tests')).filter(file => /\.test\.(?:js|mjs)$/u.test(file)).sort()
const integration = all.filter(file => needsBridge(path.join(root, 'tests', file)))
const files = mode === 'all' ? all : all.filter(file => integration.includes(file) === (mode === 'integration'))
if (!files.length) throw Error('No tests selected')
if (mode !== 'unit' && !fs.existsSync(path.resolve(root, '../dsh-qq-bridge/official/package.json'))) throw Error('Integration requires sibling dsh-qq-bridge including official/')
const context = releaseEnvironment('tests')
const result = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-concurrency=4',
  '--test-reporter=tap', '--import', './tests/release-isolation.mjs', ...files.map(file => 'tests/' + file)],
{ cwd: root, env: context.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '')
console.log(JSON.stringify({ mode, files: files.length, allFiles: all.length, integrationFiles: integration.length }))
const skipped = Number((result.stdout || '').match(/^# skipped (\d+)/mu)?.[1] || 0)
process.exitCode = result.error || result.status !== 0 || skipped ? 1 : 0
