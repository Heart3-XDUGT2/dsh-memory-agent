/**
 * sidecar 取消路径(0.45.0)
 * ============================================================
 * 核心不变量:**取消不是超时**。
 *   超时 = 「挂着的引擎不可信」 ⇒ _kill + 计失败 + 可能推开熔断器;
 *   取消 = 调用方主动撤回     ⇒ 不 kill、不计失败、也不 noteSuccess。
 * 把这两条混了,要么正常操作把熔断器推开,要么真故障被当成正常操作放过去。
 *
 * 夹具 `tests/fixtures/cancellable_worker.py`:业务帧挂着等本 reqId 的
 * cancel,收到才回 cancelled 并继续处理下一帧。于是同一份夹具、同一个帧
 * 能对照出两条路径:
 *   - 带 signal → abort → 立刻本地拒绝,进程活着;
 *   - 不带 signal → 挂到超时 → 击杀 + 记账。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const CANCELLABLE = fileURLToPath(new URL('./fixtures/cancellable_worker.py', import.meta.url))

const { detectPython, SidecarClient, SidecarError } = await import('../lib/sidecar-client.js')

async function waitFor(fn, timeoutMs = 8000, everyMs = 25) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, everyMs))
  }
}

let detected = null

test('夹具前置:本机 Python ≥3.9 可探到', async () => {
  detected = await detectPython()
  assert.notEqual(detected, null)
  assert.ok(detected.minor >= 9)
})

/** 起一台对着夹具的客户端。marker 非空时让夹具把收到的 cancel 写进去。 */
async function withClient(opts, fn) {
  assert.notEqual(detected, null, '探测用例必须先跑过')
  const dir = mkdtempSync(join(tmpdir(), 'echo-sidecar-cancel-'))
  const marker = join(dir, 'cancels.txt')
  if (opts.marker === true) process.env.CANCEL_MARKER = marker
  else delete process.env.CANCEL_MARKER
  let c = null
  try {
    c = new SidecarClient({
      pythonPath: detected.path,
      workerPath: CANCELLABLE,
      dbPath: ':memory:',
      timeoutMs: opts.timeoutMs ?? 3000,
      handshakeTimeoutMs: 8000,
      restartBackoffMs: 40,
      failureLimit: 3,
      revivalIntervalMs: 150
    })
    await c.start()
    return await fn(c, { dir, marker })
  } finally {
    if (c !== null) await c.stop()   // 夹具收到 EOF 会安静退出
    rmSync(dir, { recursive: true, force: true })
    delete process.env.CANCEL_MARKER
  }
}

test('取消:abort 后立刻拒绝,进程不杀、不计失败', async () => {
  await withClient({}, async (c) => {
    const ac = new AbortController()
    const t0 = Date.now()
    const pending = c.request('retrieve', { query: 'x' }, { signal: ac.signal, timeoutMs: 5000 })
    // 让请求真的发出去(start 之后立刻 abort 会走「已 abort」那条短路)
    await waitFor(() => c.state().requests >= 1)
    ac.abort()
    await assert.rejects(pending, (err) => {
      assert.ok(err instanceof SidecarError, '应该是 SidecarError')
      assert.equal(err.cancelled, true, '错误必须带 cancelled 标记')
      return true
    })
    const took = Date.now() - t0
    // 关键:远早于 5s 超时 —— 证明是「立刻本地拒绝」而不是等引擎回帧
    assert.ok(took < 2000, `取消应该立刻返回,实际 ${took}ms`)
    // 取消不是故障:进程活着,失败计数没动
    assert.equal(c.state().running, true, '取消不该击杀进程')
    assert.equal(c.state().failures, 0, '取消不该计失败')
    assert.equal(c.state().cancels, 1, 'cancels 计数应该 +1')
  })
})

test('取消:cancel 帧真的发到了引擎', async () => {
  await withClient({ marker: true }, async (c, { marker }) => {
    const ac = new AbortController()
    const pending = c.request('retrieve', { query: 'x' }, { signal: ac.signal, timeoutMs: 5000 })
    await waitFor(() => c.state().requests >= 1)
    ac.abort()
    await assert.rejects(pending, (err) => err.cancelled === true)
    // 断言「帧出门了」,而不是只断言「壳本地拒绝了」—— 那两件事能独立坏掉
    await waitFor(() => existsSync(marker) && readFileSync(marker, 'utf8').trim() !== '')
    const ids = readFileSync(marker, 'utf8').trim().split('\n')
    assert.equal(ids.length, 1)
    assert.match(ids[0], /^\d+$/, 'targetReqId 应该是数字')
  })
})

test('取消:不把失败计数清零(取消不是一次成功)', async () => {
  await withClient({}, async (c) => {
    // 白盒:直接摆一个非零失败数。noteSuccess() 会把它清零,
    // 而取消**不该**被当成一次成功 —— 否则真故障会被一次取消「原谅」掉。
    c._failures = 2
    const ac = new AbortController()
    const pending = c.request('retrieve', { query: 'x' }, { signal: ac.signal, timeoutMs: 5000 })
    await waitFor(() => c.state().requests >= 1)
    ac.abort()
    await assert.rejects(pending, (err) => err.cancelled === true)
    assert.equal(c.state().failures, 2, '取消把失败计数清零了 —— noteSuccess 不该在这条路径上')
  })
})

test('取消:已经 abort 的 signal 一帧都不发', async () => {
  await withClient({ marker: true }, async (c, { marker }) => {
    const ac = new AbortController()
    ac.abort()   // 先中止,再请求
    const before = c.state().requests
    await assert.rejects(
      () => c.request('retrieve', { query: 'x' }, { signal: ac.signal }),
      (err) => err instanceof SidecarError && err.cancelled === true
    )
    assert.equal(c.state().requests, before, '不该占用一个 reqId')
    assert.equal(c.state().cancels, 0, '什么都没发,不该计一次取消')
    assert.ok(!existsSync(marker) || readFileSync(marker, 'utf8').trim() === '')
  })
})

test('取消之后连接仍然可用', async () => {
  await withClient({}, async (c) => {
    const ac = new AbortController()
    const pending = c.request('retrieve', { query: 'x' }, { signal: ac.signal, timeoutMs: 5000 })
    await waitFor(() => c.state().requests >= 1)
    ac.abort()
    await assert.rejects(pending, (err) => err.cancelled === true)
    // 夹具收到 cancel 后回 cancelled 并腾出来处理队列 —— 后续请求必须正常
    const pong = await c.ping({ timeoutMs: 3000 })
    assert.equal(pong.type, 'pong')
  })
})

test('对照:同一份夹具,不带 signal 就是超时 → 击杀 + 记账', async () => {
  await withClient({ timeoutMs: 300 }, async (c) => {
    // 同一个帧,只是没有 signal —— 必须走超时路径,而不是被当成取消
    await assert.rejects(
      () => c.request('retrieve', { query: 'x' }, { timeoutMs: 300 }),
      (err) => {
        assert.ok(err instanceof SidecarError)
        assert.ok(!err.cancelled, '超时不能被标成取消')
        assert.match(err.message, /timeout/)
        return true
      }
    )
    // 超时 = 引擎不可信:击杀并记账(与取消形成对照)
    await waitFor(() => c.state().failures >= 1)
    assert.match(c.state().lastError, /timeout|exited/)
    assert.equal(c.state().cancels, 0, '超时不该计成取消')
  })
})
