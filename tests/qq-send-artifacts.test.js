import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, rename, unlink } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { hostFixture, grantHarness } from './helpers/qq-send-artifacts-fixture.mjs'
import { createQQSendArtifacts } from '../lib/qq-send-artifacts.js'

async function setup (t, limits) {
  const f = await hostFixture(t)
  const h = grantHarness(f.agent)
  const a = createQQSendArtifacts({ scopeOf: h.scopeOf, limits })
  // Registered last, but test hooks run in registration order. Explicit close in
  // tests with blocked reads; fixture disposal does not own/kill registry reads.
  t.after(() => a.close())
  const grant = h.issue()
  const present = async (name = 'report.txt', data = 'synthetic bytes', callId = name) => {
    const file = await f.file(name, data)
    const result = await a.registerPresented(grant, { callId, files: [{ path: file.path }] })
    return { ...file, result }
  }
  return { ...f, h, a, grant, present }
}
const expectCode = (value, expected) => { assert.equal(value.ok, false); assert.equal(value.code, expected) }
const gate = () => {
  let release, entered
  const wait = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  return { wait, started, release, entered }
}
function holdRead (f, g) {
  const original = f.implementation.readBytes.bind(f.implementation)
  f.implementation.readBytes = async (target, _signal, cap) => {
    g.entered()
    await g.wait
    // Deliberately noncompliant provider: finish the real bounded read despite
    // cancellation. Registry slots must follow this promise, not caller result.
    return original(target, undefined, cap)
  }
}
async function promptly (promise) {
  let timeout
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(Error('Synthetic cancellation did not settle promptly')), 2000)
    })])
  } finally { clearTimeout(timeout) }
}

test('fixed root prepare uses actual scoped Cordis fs and exposes no internal paths', async t => {
  const f = await setup(t)
  assert.deepEqual(await f.a.prepare(f.grant), { ok: true, relativeRoot: 'echo-outgoing' })
  const p = await f.present('报告.txt', 'hello')
  assert.deepEqual(p.result, { ok: true, items: [{ ref: '报告.txt', name: '报告.txt', bytes: 5 }], rejected: [] })
  assert.deepEqual(await f.a.list(f.h.issue()), { ok: true, items: p.result.items })
  assert.equal(JSON.stringify(p.result).includes(f.cwd), false)
})

test('invalid grants and untrusted session/string/authority shapes are refused', async t => {
  const f = await setup(t)
  for (const grant of [null, 'session', {}, { agent: f.agent, session: f.session, turn: 1 }]) {
    expectCode(await f.a.prepare(grant), 'INVALID_GRANT')
  }
  const malformed = createQQSendArtifacts({ scopeOf: () => ({ agent: f.agent, session: {}, turn: 1, authority: {}, isCurrent: () => true }) })
  t.after(() => malformed.close())
  expectCode(await malformed.prepare({}), 'INVALID_GRANT')
})

test('snapshot only resolves registered refs; leaf aliases must be unique', async t => {
  const f = await setup(t)
  await f.present('one/a.txt', 'one')
  await f.present('two/a.txt', 'two')
  expectCode(await f.a.snapshot(f.grant, 'a.txt'), 'AMBIGUOUS_REF')
  expectCode(await f.a.snapshot(f.grant, f.output + '/one/a.txt'), 'UNKNOWN_REF')
  expectCode(await f.a.snapshot(f.grant, '../one/a.txt'), 'UNKNOWN_REF')
  const result = await f.a.snapshot(f.grant, 'one/a.txt')
  assert.equal(result.ok, true)
  assert.equal(Buffer.from(result.data).toString(), 'one')
  assert.equal(typeof result.identity, 'object')
})

test('handoff is exactly once even for concurrent calls, with a stable internal identity', async t => {
  const f = await setup(t)
  await f.present()
  const results = await Promise.all([f.a.snapshot(f.grant, 'report.txt'), f.a.snapshot(f.grant, 'report.txt')])
  const success = results.find(r => r.ok)
  const duplicate = results.find(r => !r.ok)
  assert.ok(success)
  expectCode(duplicate, 'ALREADY_TAKEN')
  assert.equal(duplicate.identity, success.identity)
  success.data.fill(0)
  const again = await f.a.snapshot(f.h.issue(), 'report.txt')
  expectCode(again, 'ALREADY_TAKEN')
  assert.equal(again.identity, success.identity)
})

test('same bytes across calls/names cannot reset handed-off identity', async t => {
  const f = await setup(t)
  await f.present('a.txt', 'same')
  const first = await f.a.snapshot(f.grant, 'a.txt')
  assert.equal(first.ok, true)
  const again = await f.present('renamed.txt', 'same', 'other-call')
  assert.equal(again.result.ok, true)
  assert.equal(again.result.items[0].ref, 'a.txt')
  const repeated = await f.a.snapshot(f.grant, again.result.items[0].ref)
  expectCode(repeated, 'ALREADY_TAKEN')
  assert.equal(repeated.identity, first.identity)
  assert.equal((await f.a.list(f.grant)).items.length, 1)
})

test('re-presenting identical bytes after rewriting or moving keeps the original identity', async t => {
  const f = await setup(t)
  const p = await f.present('same.txt', 'same bytes')
  await writeFile(p.path, 'same bytes')
  const rewritten = await f.a.registerPresented(f.grant, { callId: 'rewritten', files: [{ path: p.path }] })
  assert.equal(rewritten.ok, true)
  await rename(p.path, p.path + '.moved')
  const moved = await f.a.registerPresented(f.grant, { callId: 'moved', files: [{ path: p.path + '.moved' }] })
  assert.equal(moved.ok, true)
  assert.equal(moved.items[0].ref, 'same.txt')
  const taken = await f.a.snapshot(f.grant, 'same.txt')
  assert.equal(taken.ok, true)
  const repeated = await f.a.registerPresented(f.grant, { callId: 'same-again', files: [{ path: p.path + '.moved' }] })
  assert.equal(repeated.ok, true)
  assert.equal((await f.a.snapshot(f.grant, 'same.txt')).identity, taken.identity)
})

test('one ref cannot silently change bytes; source mutation/deletion blocks take', async t => {
  const f = await setup(t)
  const p = await f.present('change.txt', 'AAAA')
  await writeFile(p.path, 'BBBB')
  const conflict = await f.a.registerPresented(f.grant, { callId: 'new', files: [{ path: p.path }] })
  expectCode(conflict, 'REF_CONFLICT')
  expectCode(await f.a.snapshot(f.grant, 'change.txt'), 'SOURCE_CHANGED')
  const q = await f.present('gone.txt', 'gone')
  await rename(q.path, q.path + '.old')
  expectCode(await f.a.snapshot(f.grant, 'gone.txt'), 'SOURCE_CHANGED')
})

test('partial registration is indexed and failures never leak raw provider errors', async t => {
  const f = await setup(t)
  const p = await f.file()
  const result = await f.a.registerPresented(f.grant, { callId: 'partial', files: [{ path: 'echo-outgoing/.env' }, { path: p.path }, { path: 'https://secret.invalid/x' }] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.rejected.map(v => [v.index, v.code]), [[0, 'SENSITIVE_PATH'], [2, 'INVALID_PATH']])
  assert.deepEqual(result.items, [{ ref: 'report.txt', name: 'report.txt', bytes: 15 }])
  assert.equal(JSON.stringify(result).includes('secret.invalid'), false)
})

test('new real turn discards old refs, old turns and changed authority cannot revive them', async t => {
  const f = await setup(t)
  await f.present()
  f.h.replaceAuthority()
  expectCode(await f.a.prepare(f.h.issue()), 'STALE_SCOPE')
  f.h.nextTurn()
  const next = f.h.issue()
  assert.equal((await f.a.prepare(next)).ok, true)
  expectCode(await f.a.list(f.grant), 'STALE_SCOPE')
  expectCode(await f.a.snapshot(next, 'report.txt'), 'UNKNOWN_REF')
})

test('revocation survives grant replacement/guard restoration; next turn can proceed', async t => {
  const f = await setup(t)
  await f.present()
  assert.equal((await f.a.revoke(f.grant)).ok, true)
  f.h.restore()
  expectCode(await f.a.prepare(f.h.issue()), 'REVOKED')
  f.h.nextTurn()
  assert.equal((await f.a.prepare(f.h.issue())).ok, true)
})

test('revocation before first prepare cannot be undone in the same native turn', async t => {
  const f = await setup(t)
  f.h.revoke()
  expectCode(await f.a.prepare(f.grant), 'REVOKED')
  f.h.restore()
  expectCode(await f.a.prepare(f.h.issue()), 'REVOKED')
  f.h.nextTurn()
  assert.equal((await f.a.prepare(f.h.issue())).ok, true)
})

test('agent session object, context, cwd or underlying fs replacement invalidates scope', async t => {
  for (const field of ['session', 'ctx', 'cwd', 'fs']) {
    const f = await setup(t)
    await f.a.prepare(f.grant)
    if (field === 'session') f.agent.session = { ...f.session }
    if (field === 'ctx') f.agent.ctx = { get: () => f.fs }
    if (field === 'cwd') f.session.header.cwd += '/changed'
    if (field === 'fs') f.agent.ctx.get = () => ({})
    assert.equal((await f.a.list(f.grant)).ok, false, field)
  }
})

test('separate real Agent/session objects with identical IDs cannot take each others refs', async t => {
  const f = await setup(t)
  await f.present()
  const otherAgent = { ctx: f.ctx, session: { id: f.session.id, header: { cwd: f.cwd } } }
  const other = {}
  const scopeOf = g => g === other ? { agent: otherAgent, session: otherAgent.session, turn: 1, authority: other, isCurrent: () => true } : f.h.scopeOf(g)
  const a = createQQSendArtifacts({ scopeOf })
  t.after(() => a.close())
  const registered = await a.registerPresented(f.grant, { callId: 'first-agent', files: [{ path: (await f.file()).path }] })
  assert.equal(registered.ok, true)
  await a.prepare(other)
  expectCode(await a.snapshot(other, 'report.txt'), 'UNKNOWN_REF')
  assert.equal((await a.snapshot(f.grant, 'report.txt')).ok, true)
})

test('call IDs are bounded/idempotent and cannot be reused for different paths', async t => {
  const f = await setup(t, { maxEvents: 1 })
  const p = await f.present()
  assert.equal(p.result.ok, true)
  const again = await f.a.registerPresented(f.h.issue(), { callId: 'report.txt', files: [{ path: p.path }] })
  assert.deepEqual(again, p.result)
  expectCode(await f.a.registerPresented(f.grant, { callId: 'report.txt', files: [{ path: 'elsewhere' }] }), 'INVALID_PRESENT')
  expectCode(await f.a.registerPresented(f.grant, { callId: 'second', files: [{ path: p.path }] }), 'CAPACITY')
  for (const value of [{}, { callId: 'x', files: [] }, { callId: 'x'.repeat(129), files: [{ path: p.path }] }]) {
    expectCode(await f.a.registerPresented(f.grant, value), 'INVALID_PRESENT')
  }
})

test('byte and tombstone entry budgets are global and cannot be raised by options', async t => {
  const f = await setup(t, { maxCachedBytes: 7, maxEntries: 2 })
  assert.equal((await f.present('a.txt', 'AAAA')).result.ok, true)
  expectCode((await f.present('b.txt', 'BBBB')).result, 'CAPACITY')
  assert.equal((await f.a.snapshot(f.grant, 'a.txt')).ok, true)
  assert.equal((await f.present('b.txt', 'BBBB', 'b-retry')).result.ok, true)
  expectCode((await f.present('c.txt', 'C')).result, 'CAPACITY')
  assert.throws(() => createQQSendArtifacts({ scopeOf: f.h.scopeOf, limits: { maxFileBytes: 9 * 1024 * 1024 } }))
  assert.throws(() => createQQSendArtifacts({ scopeOf: f.h.scopeOf, limits: { maxConcurrentReads: 3 } }))
})

test('a single real 8MiB file is accepted, and oversized/empty files are refused', async t => {
  const f = await setup(t)
  assert.equal((await f.present('max.bin', Buffer.alloc(8 * 1024 * 1024, 17))).result.ok, true)
  expectCode((await f.present('over.bin', Buffer.alloc(8 * 1024 * 1024 + 1))).result, 'TOO_LARGE')
  expectCode((await f.present('empty.txt', '')).result, 'EMPTY_FILE')
})

test('read slots and byte reservations remain occupied after early caller cancellation', async t => {
  const f = await setup(t, { maxConcurrentReads: 1, maxCachedBytes: 4 })
  const p = await f.file('a.txt', 'AAAA')
  const q = await f.file('b.txt', 'BBBB')
  const g = gate()
  holdRead(f, g)
  const controller = new AbortController()
  const pending = f.a.registerPresented(f.grant, { callId: 'a', files: [{ path: p.path }] }, { signal: controller.signal })
  await g.started
  controller.abort()
  expectCode(await pending, 'ABORTED')
  expectCode(await f.a.registerPresented(f.grant, { callId: 'b', files: [{ path: q.path }] }), 'BUSY')
  g.release()
  await f.a.close()
})

test('cancellation/current guard during actual read never commits entries', async t => {
  const f = await setup(t)
  const p = await f.file()
  f.implementation.internals.inspectReadBytesAfterStat = async () => f.h.revoke()
  expectCode(await f.a.registerPresented(f.grant, { callId: 'revoked', files: [{ path: p.path }] }), 'REVOKED')
  f.h.restore()
  expectCode(await f.a.list(f.grant), 'REVOKED')
})

test('one batch deadline is not reset per file; timeout closes pending work without leaking paths', async t => {
  const f = await setup(t)
  const p = await f.file()
  const g = gate()
  holdRead(f, g)
  const pending = f.a.registerPresented(f.grant, { callId: 'timeout', files: [{ path: p.path }] }, { deadlineAt: Date.now() + 100 })
  await g.started
  expectCode(await pending, 'TIMEOUT')
  let done = false
  const closing = f.a.close().then(() => { done = true })
  await delay(10)
  assert.equal(done, false)
  g.release()
  await closing
  assert.equal(done, true)
})

test('close is idempotent, aborts reads and waits physical completion without disposing host fs', async t => {
  const f = await setup(t)
  const p = await f.file()
  const g = gate()
  holdRead(f, g)
  const pending = f.a.registerPresented(f.grant, { callId: 'close', files: [{ path: p.path }] })
  await g.started
  const closing = f.a.close()
  expectCode(await pending, 'CLOSED')
  g.release()
  await closing
  await f.a.close()
  expectCode(await f.a.prepare(f.grant), 'CLOSED')
  assert.ok(await f.fs.stat(await f.fs.resolve(p.path)))
})

for (const mode of ['caller', 'revoke', 'timeout', 'close']) {
  test(`real host post-stat ${mode} cancellation finishes bounded IO and unlocks the file`, async t => {
    const f = await setup(t, { maxConcurrentReads: 1, maxCachedBytes: 4 })
    const p = await f.file('physical.txt', 'AAAA')
    const q = await f.file('blocked.txt', 'BBBB')
    const g = gate()
    const originalReadBytes = f.implementation.readBytes
    // No readBytes wrapper: this is the actual installed provider's stat ->
    // ReadStream path which locked files under Node 22 when passed an abort.
    f.implementation.internals.inspectReadBytesAfterStat = async () => { g.entered(); await g.wait }
    const controller = new AbortController()
    const operation = mode === 'timeout' ? { deadlineAt: Date.now() + 200 } : { signal: controller.signal }
    const pending = f.a.registerPresented(f.grant, { callId: `real-${mode}`, files: [{ path: p.path }] }, operation)
    let closing
    try {
      await promptly(g.started)
      if (mode === 'caller') controller.abort()
      if (mode === 'revoke') assert.equal((await f.a.revoke(f.grant)).ok, true)
      if (mode === 'close') closing = f.a.close()
      const result = await promptly(pending)
      expectCode(result, { caller: 'ABORTED', revoke: 'REVOKED', timeout: 'TIMEOUT', close: 'CLOSED' }[mode])
      assert.equal(Object.hasOwn(result, 'data'), false)
      if (mode === 'caller' || mode === 'timeout') {
        assert.deepEqual((await f.a.list(f.grant)).items, [])
        expectCode(await f.a.registerPresented(f.grant, { callId: 'still-busy', files: [{ path: q.path }] }), 'BUSY')
      }
      let physicallyDone = false
      closing ??= f.a.close()
      const observedClose = closing.then(() => { physicallyDone = true })
      await delay(10)
      assert.equal(physicallyDone, false, 'post-stat IO must retain its physical reservation')
      g.release()
      await promptly(observedClose)
      assert.equal(physicallyDone, true)
      expectCode(await f.a.list(f.grant), 'CLOSED')
      assert.equal(f.implementation.readBytes, originalReadBytes)
      // Rename AND delete are immediate real Windows operations after the
      // public read promise has exited; a leaked ReadStream handle fails here.
      await rename(p.path, p.path + '.finished')
      await unlink(p.path + '.finished')
      await writeFile(p.path, 'clean')
      await unlink(p.path)
    } finally {
      g.release()
      await f.a.close()
    }
  })
}

test('operation guards cannot extend scope and hostile fs messages are fixed safe failures', async t => {
  const f = await setup(t)
  const p = await f.file()
  expectCode(await f.a.registerPresented(f.grant, { callId: 'pre', files: [{ path: p.path }] }, { isCurrent: () => false }), 'REVOKED')
  f.implementation.readBytes = async () => { throw Error('C:\\secret\\credentials=synthetic-token') }
  const result = await f.a.registerPresented(f.grant, { callId: 'error', files: [{ path: p.path }] })
  expectCode(result, 'UNAVAILABLE')
  assert.equal(JSON.stringify(result).includes('credentials'), false)
})

test('provider shared/resizable buffers never become snapshots', async t => {
  const f = await setup(t)
  const p = await f.file('a.txt', 'AAAA')
  for (const buffer of [new SharedArrayBuffer(4), new ArrayBuffer(4, { maxByteLength: 8 })]) {
    f.implementation.readBytes = async () => new Uint8Array(buffer)
    expectCode(await f.a.registerPresented(f.grant, { callId: String(buffer.constructor.name), files: [{ path: p.path }] }), 'SOURCE_CHANGED')
  }
})

test('in-flight byte reservations reject a second read before starting it', async t => {
  const f = await setup(t, { maxCachedBytes: 7, maxConcurrentReads: 2 })
  const p = await f.file('first.txt', 'AAAA')
  const q = await f.file('second.txt', 'BBBB')
  const g = gate()
  holdRead(f, g)
  const pending = f.a.registerPresented(f.grant, { callId: 'first', files: [{ path: p.path }] })
  await g.started
  expectCode(await f.a.registerPresented(f.grant, { callId: 'second', files: [{ path: q.path }] }), 'CAPACITY')
  g.release()
  assert.equal((await pending).ok, true)
})

test('scope, event, byte and entry budgets apply across real agents in one registry', async t => {
  const f = await setup(t)
  const second = await hostFixture(t)
  const other = grantHarness(second.agent)
  const grant2 = other.issue()
  const a = createQQSendArtifacts({ scopeOf: g => f.h.scopeOf(g) ?? other.scopeOf(g), limits: { maxCachedBytes: 7, maxEntries: 2 } })
  t.after(() => a.close())
  const p = await f.file('a.txt', 'AAAA')
  const q = await second.file('b.txt', 'BBBB')
  assert.equal((await a.registerPresented(f.grant, { callId: 'a', files: [{ path: p.path }] })).ok, true)
  expectCode(await a.registerPresented(grant2, { callId: 'b', files: [{ path: q.path }] }), 'CAPACITY')
  await a.snapshot(f.grant, 'a.txt')
  assert.equal((await a.registerPresented(grant2, { callId: 'b2', files: [{ path: q.path }] })).ok, true)
  const r = await second.file('c.txt', 'C')
  expectCode(await a.registerPresented(grant2, { callId: 'c', files: [{ path: r.path }] }), 'CAPACITY')
  const limited = createQQSendArtifacts({ scopeOf: g => f.h.scopeOf(g) ?? other.scopeOf(g), limits: { maxScopes: 1, maxEvents: 1 } })
  t.after(() => limited.close())
  assert.equal((await limited.prepare(f.grant)).ok, true)
  expectCode(await limited.prepare(grant2), 'CAPACITY')
  await limited.revoke(f.grant)
  assert.equal((await limited.prepare(grant2)).ok, true)
  assert.equal((await limited.registerPresented(grant2, { callId: 'one', files: [{ path: q.path }] })).ok, true)
  expectCode(await limited.registerPresented(grant2, { callId: 'two', files: [{ path: r.path }] }), 'CAPACITY')
})

test('same ref concurrent conflicting presents cannot silently overwrite bytes', async t => {
  const f = await setup(t)
  const p = await f.file('race.txt', 'AAAA')
  const g = gate()
  holdRead(f, g)
  const first = f.a.registerPresented(f.grant, { callId: 'race-one', files: [{ path: p.path }] })
  await g.started
  // Change while the provider read is outstanding: its registered version must
  // not be accepted, even if both registration calls overlap.
  await writeFile(p.path, 'BBBB')
  const second = f.a.registerPresented(f.grant, { callId: 'race-two', files: [{ path: p.path }] })
  g.release()
  expectCode(await first, 'SOURCE_CHANGED')
  assert.equal((await second).ok, true)
  const taken = await f.a.snapshot(f.grant, 'race.txt')
  assert.equal(Buffer.from(taken.data).toString(), 'BBBB')
})
