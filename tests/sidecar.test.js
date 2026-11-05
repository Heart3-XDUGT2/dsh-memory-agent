/**
 * M2-c sidecar-client 三剧本(PLAN M2 验收):正常 / 崩溃 / 超时。
 * 全部打真实子进程 —— 测的就是「spawn 起来能不能说人话、坏了会
 * 不会自己爬起来、爬不起来会不会说实话」。
 *
 * DSH_HOME 指到临时目录:探测链的 config 级读那里的 config.json,
 * 不碰真实数据目录;DB 也是临时建库(openStore 建表)。
 *
 * ⚠️ **已知**:七个用例全过之后,**进程不肯自己退**(有句柄没放,2026-09-28 夜
 * 他重启后才暴露:`npm test` 会一直挂着)。回到 HEAD 也一样 ⇒ **不是某次改动引入的**,
 * 是这套"打真实子进程"的测试本身留了个尾巴(spawn/pipe 或某个 socket 没关)。
 * 现在的保底是 `npm test` 带 `--test-force-exit`(用例跑完就退),
 * **真正的修法**是找出那个句柄 —— 记在这儿,别让"加了保底"变成"没人再查"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'echo-sidecar-'))
const WORKER = fileURLToPath(new URL('../python/worker.py', import.meta.url))
const HUNG_WORKER = fileURLToPath(new URL('./fixtures/hung_worker.py', import.meta.url))
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

const { detectPython, parsePythonVersion, pythonVersionOk, SidecarClient, SidecarError, PROTOCOL } =
  await import('../lib/sidecar-client.js')
const { openStore } = await import('../lib/store.js')
const { CONFIG_PATH } = await import('../lib/toggle.js')
mkdirSync(dirname(CONFIG_PATH), { recursive: true }) // config.json 的父目录要存在

// 轮询等待:三剧本全是异步进程编排,轮询比 sleep 稳。
async function waitFor(fn, timeoutMs = 8000, everyMs = 25) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, everyMs))
  }
}

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'echo-sidecar-db-'))
  const dbPath = join(dir, 'echo.db')
  const store = openStore(dbPath) // 建库建表(worker 只验不建)
  store.close()
  return { dir, dbPath }
}

let detected = null
test('探测:本机 Python ≥3.9 可探到(探测链末端 PATH 兜底)', async () => {
  detected = await detectPython()
  assert.notEqual(detected, null)
  assert.equal(detected.major, 3)
  assert.ok(detected.minor >= 9)
})

test('探测:版本解析纯函数与门槛(3.9 下限,不猜)', () => {
  assert.deepEqual(parsePythonVersion('3 14'), { major: 3, minor: 14 })
  assert.deepEqual(parsePythonVersion('3.14.7\n'), { major: 3, minor: 14 })
  assert.equal(parsePythonVersion('garbage'), null)
  assert.equal(parsePythonVersion(''), null)
  assert.ok(pythonVersionOk({ major: 3, minor: 9 }))
  assert.ok(pythonVersionOk({ major: 3, minor: 14 }))
  assert.ok(pythonVersionOk({ major: 4, minor: 0 }))
  assert.equal(pythonVersionOk({ major: 3, minor: 8 }), false)
  assert.equal(pythonVersionOk({ major: 2, minor: 7 }), false)
  assert.equal(pythonVersionOk(null), false)
})

test('探测链:env 优先 → config 兜底 → 脏配置跳过', async () => {
  // env 指向真 python → 直接命中
  const viaEnv = await detectPython({ env: { ECHO_PYTHON: detected.path } })
  assert.notEqual(viaEnv, null)
  assert.equal(viaEnv.path, detected.path)
  // env 是假路径 → 落到 config 级
  writeFileSync(CONFIG_PATH, JSON.stringify({ pythonPath: detected.path }), 'utf8')
  const viaConfig = await detectPython({ env: { ECHO_PYTHON: 'C:\\definitely\\not\\here.exe' } })
  assert.notEqual(viaConfig, null)
  assert.equal(viaConfig.path, detected.path)
  // config 脏值 → 跳过这一级,PATH 兜底仍能探到
  writeFileSync(CONFIG_PATH, '{not json', 'utf8')
  const viaPath = await detectPython({ env: { ECHO_PYTHON: 'C:\\definitely\\not\\here.exe' } })
  assert.notEqual(viaPath, null)
})

test('正常剧本:握手 → ping → retrieve 真往返 → 优雅收尾', async () => {
  const { dir, dbPath } = await freshDb()
  let c = null
  try {
    c = new SidecarClient({
      pythonPath: detected.path, workerPath: WORKER, dbPath,
      timeoutMs: 8000, handshakeTimeoutMs: 8000
    })
    const info = await c.start()
    assert.equal(info.engine, 'python')
    assert.equal(info.protocol, PROTOCOL)
    assert.equal(info.db.ok, true)
    assert.equal(info.version, PKG.version) // 版本唯一事实源 = package.json
    // 幂等:活着再 start 直接回握手信息,不重复 spawn
    const again = await c.start()
    assert.equal(again, info)
    // ping
    const pong = await c.ping()
    assert.equal(pong.type, 'pong')
    // retrieve 真往返(空库:items 空,但协议形状完整)
    const r = await c.request('retrieve', { userId: 'master', query: '你好', topK: 6 })
    assert.equal(r.type, 'retrieve_result')
    assert.deepEqual(r.items, [])
    assert.ok(typeof r.text === 'string')
    // 状态快照
    const s = c.state()
    assert.equal(s.running, true)
    assert.equal(s.breakerOpen, false)
    assert.equal(s.failures, 0)
    assert.ok(s.pid > 0)
    assert.equal(s.version, PKG.version)
    // 优雅收尾
    await c.stop()
    const s2 = c.state()
    assert.equal(s2.running, false)
    assert.equal(s2.pid, null)
    assert.equal(s2.breakerOpen, false)
  } finally {
    if (c !== null) await c.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('崩溃剧本:连续击杀 → 自动重启 → 3 连败熔断 → 复活探测合闸', async () => {
  const { dir, dbPath } = await freshDb()
  let c = null
  try {
    c = new SidecarClient({
      pythonPath: detected.path, workerPath: WORKER, dbPath,
      timeoutMs: 8000, handshakeTimeoutMs: 8000,
      restartBackoffMs: 60, failureLimit: 3, revivalIntervalMs: 150
    })
    await c.start()
    const pid1 = c.state().pid
    // —— 第 1 杀:死了就说实话,然后自己爬起来 ——
    process.kill(pid1)
    await waitFor(() => !c.state().running)            // 死讯送达
    await assert.rejects(() => c.ping(), SidecarError) // 快速失败不装活
    await waitFor(() => c.state().running)             // 自动重启
    await c.ping()                                     // 复活后能干活(失败计数清零)
    // —— 复活验证后再连杀 3 次:中间不许有成功业务请求
    //    (连续失败才熔断;重启握手不算业务成功,计数不清零)——
    for (let i = 0; i < 3; i++) {
      process.kill(c.state().pid)
      await waitFor(() => !c.state().running)
      if (i < 2) await waitFor(() => c.state().running) // 前两次会自动重启
    }
    await waitFor(() => c.state().breakerOpen === true) // 3 连败 → 熔断
    // 熔断期:快速失败,不再 spawn
    await assert.rejects(() => c.ping(), (err) => err instanceof SidecarError && /breaker/.test(err.message))
    assert.equal(c.state().running, false)
    // 复活探测:周期 spawn+握手,成功合闸
    await waitFor(() => c.state().running && !c.state().breakerOpen, 5000)
    await c.ping()
    assert.equal(c.state().failures, 0)                // 业务成功才清零
  } finally {
    if (c !== null) await c.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('超时剧本:握手后挂起 → 请求超时 → 击杀 → 失败记账', async () => {
  const { dir, dbPath } = await freshDb()
  let c = null
  try {
    c = new SidecarClient({
      pythonPath: detected.path, workerPath: HUNG_WORKER, dbPath,
      timeoutMs: 250, handshakeTimeoutMs: 8000,
      restartBackoffMs: 40, failureLimit: 3, revivalIntervalMs: 150
    })
    await c.start() // 夹具会答握手
    // 业务帧挂起 → 超时拒绝
    await assert.rejects(() => c.ping(), (err) => err instanceof SidecarError && /timeout/.test(err.message))
    // 超时 = 引擎不可信:击杀并记账。断言走 failures 计数而不是
    // running 窗口 —— 40ms 后备重启可能已把进程拉活,窗口吃竞态。
    await waitFor(() => c.state().failures >= 1)
    assert.match(c.state().lastError, /timeout|exited/)
  } finally {
    if (c !== null) await c.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('握手拒绝:验库失败(dbPath 不存在)→ start 拒绝且不留残进程', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-sidecar-nodb-'))
  let c = null
  try {
    c = new SidecarClient({
      pythonPath: detected.path, workerPath: WORKER,
      dbPath: join(dir, 'nope.db'), // 不存在:worker 只验不建
      timeoutMs: 4000, handshakeTimeoutMs: 4000
    })
    await assert.rejects(() => c.start(), SidecarError)
    assert.equal(c.state().running, false)
  } finally {
    if (c !== null) await c.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
