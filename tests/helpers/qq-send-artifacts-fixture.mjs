import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { mkdtemp, mkdir, writeFile, rm, realpath, lstat, readdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export async function hostFixture (t) {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(path.join(parent, 'echo-037-artifacts-'))
  const cwd = path.join(root, 'workspace')
  const output = path.join(cwd, 'echo-outgoing')
  await mkdir(output, { recursive: true })
  const ctx = new Context()
  const implementation = new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 })
  const session = { id: 'synthetic-session', header: { cwd } }
  const agent = { session, ctx }
  const junctions = []
  t.after(async () => {
    await ctx.fiber.dispose()
    const resolved = await realpath(root)
    const relative = path.relative(parent, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative) ||
      !path.basename(resolved).startsWith('echo-037-artifacts-') || (await lstat(root)).isSymbolicLink()) {
      throw new Error('Refusing unsafe synthetic fixture cleanup')
    }
    for (const link of junctions) {
      // Native deletion removes only the reparse point, never its target.
      const relativeLink = path.relative(resolved, path.resolve(link))
      if (relativeLink.startsWith('..') || path.isAbsolute(relativeLink)) throw Error('Unsafe junction cleanup')
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$item = Get-Item -LiteralPath $env:ECHO_037_TEST_LINK -Force -ErrorAction Stop; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw "Expected synthetic reparse point" }; [IO.Directory]::Delete($env:ECHO_037_TEST_LINK)'],
      { windowsHide: true, env: { ...process.env, ECHO_037_TEST_LINK: link } })
    }
    // Node 22 Windows recursive rm can leave a junction behind (ENOTEMPTY).
    // Unlink only entries under this checked synthetic root, without following links.
    const removeLinks = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = path.join(directory, entry.name)
        const stat = await lstat(child)
        if (stat.isSymbolicLink()) await unlink(child)
        else if (stat.isDirectory()) await removeLinks(child)
      }
    }
    await removeLinks(resolved)
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 })
  })
  return {
    root, cwd, output, ctx, implementation, agent, session,
    fs: ctx.get('fs'),
    async junction (target, link) {
      // Use native junction creation/deletion: Node 22.5/libuv on this Windows
      // build cannot reliably inspect/remove these reparse points itself.
      for (const value of [target, link]) {
        const relative = path.relative(root, path.resolve(value))
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Unsafe synthetic junction')
      }
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'New-Item -ItemType Junction -Path $env:ECHO_037_TEST_LINK -Target $env:ECHO_037_TEST_TARGET -ErrorAction Stop | Out-Null'],
      { windowsHide: true, env: { ...process.env, ECHO_037_TEST_LINK: link, ECHO_037_TEST_TARGET: target } })
      junctions.push(link)
    },
    async file (name = 'report.txt', data = 'synthetic bytes') {
      const filename = path.join(output, name)
      await mkdir(path.dirname(filename), { recursive: true })
      await writeFile(filename, data)
      return { path: filename, data: typeof data === 'string' ? Buffer.from(data) : data }
    }
  }
}

export function grantHarness (agent, options = {}) {
  const grants = new WeakMap()
  let current = true
  let turn = options.turn ?? 1
  let authority = {}
  const issue = () => {
    const grant = Object.freeze({})
    grants.set(grant, { agent, session: agent.session, turn, authority, isCurrent: () => current })
    return grant
  }
  return {
    issue,
    scopeOf: grant => grants.get(grant) ?? null,
    revoke: () => { current = false },
    restore: () => { current = true },
    nextTurn: () => { turn++; authority = {}; current = true },
    replaceAuthority: () => { authority = {} }
  }
}
