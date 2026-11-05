/** Invoke npm as Node+argv, including on Windows; no string-built shell. */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
export function npmCli() {
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
  try { candidates.push(path.join(path.dirname(createRequire(import.meta.url).resolve('npm/package.json')), 'bin/npm-cli.js')) } catch {}
  const found = candidates.find(file => file && path.basename(file) === 'npm-cli.js' && fs.existsSync(file))
  if (!found) throw Error('npm CLI not found; install Node with npm or run this command through npm')
  return found
}
export function runNpm(args, options = {}) {
  const result = spawnSync(process.execPath, [npmCli(), ...args], {
    encoding: 'utf8', windowsHide: true, ...options
  })
  if (result.error || result.status !== 0) {
    const error = Error('npm ' + args[0] + ' failed (' + result.status + ')')
    error.stdout = result.stdout || ''; error.stderr = result.stderr || ''; throw error
  }
  return result.stdout || ''
}
