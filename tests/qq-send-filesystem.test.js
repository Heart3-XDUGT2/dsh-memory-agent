import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { hostFixture } from './helpers/qq-send-artifacts-fixture.mjs'
import { createQQSendFilesystem, filesystemIdentity, artifactFailure } from '../lib/qq-send-filesystem.js'

const adapterOf = f => createQQSendFilesystem(f.fs, { cwd: f.cwd, relativeRoot: 'echo-outgoing' })
const code = expected => error => {
  assert.equal(error.name, 'QQSendArtifactError')
  assert.equal(error.code, expected)
  return true
}

test('actual installed Cordis proxies identify one fs without operating the raw service', async t => {
  const f = await hostFixture(t)
  assert.notEqual(f.ctx.get('fs'), f.ctx.get('fs'))
  assert.equal(filesystemIdentity(f.ctx.get('fs')), f.implementation)
  const a = adapterOf(f)
  const workspace = await a.workspace()
  assert.equal(workspace.style, 'win32')
  assert.equal(workspace.fsIdentity, f.implementation)
})

test('real host fs accepts ordinary bytes only inside the relative output root', async t => {
  const f = await hostFixture(t)
  const file = await f.file('reports/中文报告.pdf', Buffer.from([1, 2, 3, 255]))
  const a = adapterOf(f)
  const descriptor = await a.inspect(file.path)
  assert.equal(descriptor.ref, 'reports/中文报告.pdf')
  assert.equal(descriptor.name, '中文报告.pdf')
  assert.equal(descriptor.size, 4)
  assert.deepEqual(await a.readSnapshot(descriptor), new Uint8Array(file.data))
  await a.verify(descriptor)
})

test('missing output directory may be described without creating it', async t => {
  const f = await hostFixture(t)
  const a = createQQSendFilesystem(f.fs, { cwd: f.cwd, relativeRoot: 'another-output' })
  assert.equal((await a.workspace()).style, 'win32')
  await assert.rejects(a.inspect('another-output/not-created.txt'), code('NOT_FOUND'))
})

test('outside paths, traversal, URLs and credential-like leaf names are refused', async t => {
  const f = await hostFixture(t)
  const outside = path.join(f.root, 'not-for-sending.txt')
  await writeFile(outside, 'synthetic outside bytes')
  const a = adapterOf(f)
  await assert.rejects(a.inspect(outside), code('OUTSIDE_OUTPUT'))
  for (const value of ['echo-outgoing/../outside.txt', 'file:///secret.txt', 'https://example.invalid/file']) {
    await assert.rejects(a.inspect(value), code('INVALID_PATH'))
  }
  const sensitive = await f.file('.env', 'synthetic')
  await assert.rejects(a.inspect(sensitive.path), code('SENSITIVE_PATH'))
  await assert.rejects(a.inspect('echo-outgoing/.ssh/key.txt'), code('SENSITIVE_PATH'))
  for (const value of ['echo-outgoing/a.txt:stream', 'echo-outgoing/CON.txt', 'echo-outgoing/a\u0000.txt',
    'echo-outgoing/session-1234abcd.txt', 'echo-outgoing/12345678-1234-1234-1234-123456789abc.txt']) {
    await assert.rejects(a.inspect(value), code('INVALID_PATH'))
  }
})

test('public failure codes cannot carry backend strings or paths', () => {
  assert.deepEqual(artifactFailure('C:\\private\\synthetic-token'), { ok: false, code: 'UNAVAILABLE', reason: '文件暂不可发送。' })
})

test('real Windows junction in the output path is rejected before content is read', async t => {
  const f = await hostFixture(t)
  const outside = path.join(f.root, 'outside')
  await mkdir(outside)
  await writeFile(path.join(outside, 'fake.txt'), 'synthetic outside')
  await f.junction(outside, path.join(f.output, 'linked'))
  await assert.rejects(adapterOf(f).inspect('echo-outgoing/linked/fake.txt'), code('LINK_REFUSED'))
})

test('directories, missing files, empty files and byte caps are explicit refusals', async t => {
  const f = await hostFixture(t)
  await mkdir(path.join(f.output, 'folder'))
  const a = adapterOf(f)
  await assert.rejects(a.inspect('echo-outgoing/folder'), code('NOT_FILE'))
  await assert.rejects(a.inspect('echo-outgoing/missing.txt'), code('NOT_FOUND'))
  await f.file('empty.txt', '')
  await assert.rejects(a.inspect('echo-outgoing/empty.txt'), code('EMPTY_FILE'))
  await f.file('over.txt', '12345')
  const capped = createQQSendFilesystem(f.fs, { cwd: f.cwd, relativeRoot: 'echo-outgoing', maxFileBytes: 4 })
  await assert.rejects(capped.inspect('echo-outgoing/over.txt'), code('TOO_LARGE'))
})

test('a real file replacement invalidates the opaque registered version', async t => {
  const f = await hostFixture(t)
  const file = await f.file('replace.txt', 'original')
  const a = adapterOf(f)
  const descriptor = await a.inspect(file.path)
  await rename(file.path, file.path + '.old')
  await writeFile(file.path, 'replaced')
  await assert.rejects(a.verify(descriptor), code('SOURCE_CHANGED'))
})

test('real provider post-stat growth is bounded and rejected during snapshot', async t => {
  const f = await hostFixture(t)
  const file = await f.file('grow.txt', 'small')
  const a = adapterOf(f)
  const descriptor = await a.inspect(file.path)
  f.implementation.internals.inspectReadBytesAfterStat = async () => { await writeFile(file.path, 'much longer synthetic data') }
  await assert.rejects(a.readSnapshot(descriptor), code('SOURCE_CHANGED'))
})

test('same-size replacement inside real read is rejected without returning the new bytes', async t => {
  const f = await hostFixture(t)
  const file = await f.file('race.txt', 'AAAA')
  const a = adapterOf(f)
  const descriptor = await a.inspect(file.path)
  f.implementation.internals.inspectReadBytesAfterStat = async () => {
    await rename(file.path, file.path + '.old')
    await writeFile(file.path, 'BBBB')
  }
  await assert.rejects(a.readSnapshot(descriptor), code('SOURCE_CHANGED'))
})

test('unsupported or versionless composed filesystems are not replaced with host reads', async t => {
  const f = await hostFixture(t)
  const file = await f.file()
  assert.throws(() => createQQSendFilesystem({}, { cwd: f.cwd, relativeRoot: 'echo-outgoing' }))
  const versionless = new Proxy(f.fs, {
    get (target, key) {
      if (key === 'stat') return async (...args) => { const result = await target.stat(...args); return result && { type: result.type, size: result.size } }
      return Reflect.get(target, key)
    }
  })
  await assert.rejects(createQQSendFilesystem(versionless, { cwd: f.cwd, relativeRoot: 'echo-outgoing' }).inspect(file.path),
    code('UNSUPPORTED_FILESYSTEM'))
})

test('pre-cancel and a failed live guard abort before accepting bytes', async t => {
  const f = await hostFixture(t)
  const file = await f.file()
  const a = adapterOf(f)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(a.inspect(file.path, { signal: controller.signal }), code('ABORTED'))
  await assert.rejects(a.inspect(file.path, { check: () => false }), code('REVOKED'))
})

test('POSIX execution-world paths work on a Windows host without parsing targetKey', async () => {
  const entries = new Map([
    ['/sandbox/work', { type: 'directory', version: 'root-v' }],
    ['/sandbox/work/echo-outgoing', { type: 'directory', version: 'out-v' }],
    ['/sandbox/work/echo-outgoing/a.txt', { type: 'file', size: 3, version: 'file-v' }]
  ])
  const keys = new Map([...entries.keys()].map((value, i) => [value, `opaque-${i}`]))
  const paths = new Map([...keys].map(([p, key]) => [key, p]))
  const fs = {
    async resolve (p, opts = {}) { const absolute = path.posix.resolve(opts.cwd ?? '/sandbox/work', p); return { targetKey: keys.get(absolute), displayPath: p } },
    processPath: target => paths.get(target.targetKey),
    contains: (a, b) => { const relative = path.posix.relative(paths.get(a.targetKey), paths.get(b.targetKey)); return relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative)) },
    async lstat (p, opts = {}) { return entries.get(path.posix.resolve(opts.cwd ?? '/sandbox/work', p)) },
    async stat (target) { return entries.get(paths.get(target.targetKey)) },
    async readBytes (_target, signal, cap) {
      assert.equal(signal, undefined, 'physical bounded reads must not receive a cancellable signal')
      assert.equal(cap, 3)
      return new Uint8Array([65, 66, 67])
    }
  }
  const a = createQQSendFilesystem(fs, { cwd: '/sandbox/work', relativeRoot: 'echo-outgoing' })
  const descriptor = await a.inspect('echo-outgoing/a.txt')
  assert.equal(descriptor.ref, 'a.txt')
  assert.deepEqual(await a.readSnapshot(descriptor, { signal: new AbortController().signal }), new Uint8Array([65, 66, 67]))
})
