/** Verify real npm packages and the unmodified MIT preset, no live DSH home. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const root = path.resolve(import.meta.dirname, '..')
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json')))
const required = { '@deepseek-ai/cordis': '4.0.4',
  ...Object.fromEntries(['dsh-tools', 'dsh-llm', 'dsh-compaction-basic', 'dsh-agent', 'dsh-session',
    'dsh-session-projection', 'dsh-agent-loop', 'dsh-system-prompt', 'dsh-fs-local', 'dsh-tool-present']
    .map(name => ['@deepseek-ai/' + name, '0.2.0-rc.2'])) }
export async function verifyDevelopment() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Development/release verification requires Node 24')
  const req = createRequire(path.join(root, 'package.json'))
  for (const [name, version] of Object.entries(required)) {
    if (metadata.devDependencies?.[name] !== version) throw Error('Pinned development dependency mismatch: ' + name)
    const pkgFile = req.resolve(name + '/package.json')
    if (!fs.realpathSync(pkgFile).startsWith(fs.realpathSync(path.join(root, 'node_modules')) + path.sep)) throw Error('Host dependency resolved outside this checkout')
    if (JSON.parse(fs.readFileSync(pkgFile)).version !== version) throw Error('Installed host version mismatch: ' + name)
    await import(name)
  }
  const presetRoot = path.join(root, 'tests/fixtures/host-web-app')
  const bytes = fs.readFileSync(path.join(presetRoot, 'presets/standard.patch.yml'))
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== '6cd2f197737fc94a45e487d0bb57869461dd6f392d45f6429b576e75d973eda8') throw Error('Upstream preset fixture changed')
  if (!fs.readFileSync(path.join(presetRoot, 'LICENSE'), 'utf8').startsWith('MIT License')) throw Error('Upstream preset license missing')
  return { hostVersion: '0.2.0-rc.2', cordisVersion: '4.0.4', realModules: Object.keys(required).length, presetRoot }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({ passed: true, ...await verifyDevelopment() })) }
  catch (error) { console.error(String(error.message)); process.exitCode = 1 }
}
