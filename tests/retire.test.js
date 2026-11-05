/**
 * 「归档 A 侧」这条命令的护栏(`scripts/retire-a-side.mjs`)。
 *
 * 它动的是**她当年全部的 QQ 记忆**,而且是在切换那天手最抖的时候动 ——
 * 所以这里测的不是功能,是**它会不会乱动**:
 *
 *  - 不给 `--apply` 就一个字节都不许动;
 *  - 备份没成功就绝不改名(先备份后改名,顺序反了就等于没备份);
 *  - A 侧还在长(老插件没停干净)时拒签,而且 `--force` 是显式逃生门;
 *  - 重复跑要安全(已经归档过就跳过,不当成错误);
 *  - 改名而不是删除:`-wal` 兄弟必须跟着走(最近的写入就在里面)。
 *
 * 全部在临时目录里跑,靠 `--dir/--backup-dir/--manifest-dir/--baseline` 指过去。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const SCRIPT = new URL('../scripts/retire-a-side.mjs', import.meta.url)

const A_TABLES = ['episodic_memory', 'pending_threads', 'her_agenda', 'graph_nodes', 'graph_edges']
const BASELINE = { episodic_memory: 134, pending_threads: 9, her_agenda: 4, graph_nodes: 26, graph_edges: 28 }

/** 合成 A 侧目录:先建并关闭真实 SQLite，再添加不透明的 WAL/SHM 与老配置。 */
function fixture ({ counts = BASELINE, withConfig = true, tables = A_TABLES, rollbackSampling = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'echo-retire-'))
  const aData = join(root, 'astrbot-data')
  const memDir = join(aData, 'plugin_data', 'astrbot_plugin_memory_middleware')
  const stateDir = join(aData, 'plugin_data', 'astrbot_plugin_agent_state')
  mkdirSync(memDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  // Existing withDb:true callers remain valid; every normal fixture is now real.
  const db = new DatabaseSync(join(memDir, 'memory.db'))
  try {
    db.exec('PRAGMA journal_mode=DELETE')
    for (const t of tables) {
      db.exec('CREATE TABLE ' + t + ' (x INTEGER)')
      for (let i = 0; i < (counts[t] ?? 0); i++) db.exec('INSERT INTO ' + t + ' VALUES (' + i + ')')
    }
  } finally { db.close() }
  const state = new DatabaseSync(join(stateDir, 'state.db'))
  try {
    state.exec('CREATE TABLE synthetic_state (x INTEGER); INSERT INTO synthetic_state VALUES (1)')
  } finally { state.close() }
  // Write opaque companion bytes only after both real connections are closed.
  // Sampling controls need actual DELETE locking: any memory WAL switches SQLite
  // into WAL mode and can initialize SHM even through a read-only connection.
  // Their seven files are memory DB+inert SHM, state DB+WAL+SHM, and two configs.
  if (!rollbackSampling) writeFileSync(join(memDir, 'memory.db-wal'), 'FAKE-WAL')
  writeFileSync(join(memDir, 'memory.db-shm'), 'FAKE-SHM')
  writeFileSync(join(stateDir, 'state.db-wal'), 'FAKE-STATE-WAL')
  if (rollbackSampling) writeFileSync(join(stateDir, 'state.db-shm'), 'FAKE-STATE-SHM')
  // 两份老插件配置(记忆中间件 51 项 / 状态机)—— 2026-09-26 起也进归档
  if (withConfig) {
    const cfgDir = join(aData, 'config')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'astrbot_plugin_memory_middleware_config.json'), '{"gateway_enabled":true,"master_id":"<your-qq>"}')
    writeFileSync(join(cfgDir, 'astrbot_plugin_agent_state_config.json'), '{"enabled":true}')
  }
  // state.db-shm 故意不给:缺文件不该让脚本崩
  const baseline = join(root, 'r4-baseline.json')
  writeFileSync(baseline, JSON.stringify({ at: '2026-09-25T00:00:00.000Z', aSide: BASELINE }))
  return { root, aData, baseline, backup: join(root, 'backup'), manifests: join(root, 'manifests') }
}

function run (f, extra = [], { preload = null } = {}) {
  const argv = [
    ...(preload ? ['--import', pathToFileURL(preload).href] : []),
    SCRIPT.pathname.replace(/^\//, ''),
    '--dir=' + f.aData,
    '--backup-dir=' + f.backup,
    '--manifest-dir=' + f.manifests,
    '--baseline=' + f.baseline,
    '--date=2026-09-30',
    // 夹具文件是刚刚创建的,默认的 -wal 新鲜度闸会把每次跑都拦下 —— 测试里
    // 单独有一条用例专门验那道闸,其余的把它关掉。
    '--fresh-seconds=0',
    '--sample-gap-ms=0',
    '--json',
    ...extra
  ]
  try {
    const out = execFileSync(process.execPath, argv, { encoding: 'utf8' })
    return { code: 0, report: JSON.parse(out) }
  } catch (e) {
    // 退出码 1 是「拒签/有错」的正常表达
    return { code: e.status, report: e.stdout ? JSON.parse(e.stdout) : null, stderr: String(e.stderr || '') }
  }
}

/**
 * 在采样窗口里**持续**往 A 的库里写(模拟「老插件还没停」)。
 *
 * ★ 2026-10-21 改：原来它是「400ms 之后**写一次就退**」，于是这条用例隐含了一个
 *   时间假设：**脚本第一次采样 < writer 提交 < 脚本第二次采样**。
 *   全量 `npm test` 时 CPU 被并行测试占住，脚本第一次采样被推迟到提交**之后**
 *   ⇒ 两次采样都读成 139 ⇒ drift 空 ⇒ code 0 ≠ 1。**失败方向是"写入太早"**，
 *   不是产品错了。
 *
 *   现在改成**每 intervalMs 写一批、直到被 kill**：不管第一次采样被推迟到哪，
 *   第二次采样时 writer 仍在写 ⇒ `countsSecond > counts` **必然成立**。
 *
 * ⚠️ **活性**：它每批提交后把自己写了几批记进 `writer-status.json`。
 *   `stdio:'ignore'`（下面 spawn 那行）之下这是唯一能证明"它真的在写"的办法 ——
 *   没有这条，writer 一旦悄悄崩掉，用例会变成**假绿**，比红着更坏。
 *
 * ⚠️ 为什么用一个**长连接 + 极短事务**：实测（60ms 间隔、只读 COUNT 采样 163 次）
 *   脚本那边**一次 BUSY 都没撞**。事务只有微秒级，读者拿 SHARED 锁毫无压力。
 *
/**
 * ★ 2026-10-21：`maxMs` 从 8000 提到 **30000**，与用例的 `timeout: 30000` 对齐。
 *
 *   **实测数据（10 连跑该用例的耗时）**：4464 / 4427 / 5749 / 5905 / 5987 /
 *   6011 / 6022 / 6056 / 6068 / **11151** ms。
 *
 *   ⇒ 最长那次 **11151ms > 8000ms**，也就是说：**writer 在 8s 就自己退出了，
 *     而脚本还在采样**。那一刻起库不再长 —— 只要两次采样恰好都落在它退出**之后**，
 *     `drift` 就是空的 ⇒ 退化成旧写法那种"写完了"的状态 ⇒ 红。
 *     **第 8 次是侥幸绿的，余量是负的。**
 *
 *   为什么不是"调参蒙过去"：`maxMs` 是 **writer 的生命期**，不是断言阈值。
 *   把它对齐到用例的 30s 上限之后，"writer 提前退"这条路就没了；
 *   万一它真的卡死，`stopWriter` 里的 `kill()` 兜底（而且对外 `await` 过）。
 *
 * @returns {{child: import('node:child_process').ChildProcess, statusPath: string}}
 */
function spawnWriter (f, { intervalMs = 60, maxMs = 20000 } = {}) {
  const dbPath = join(f.aData, 'plugin_data', 'astrbot_plugin_memory_middleware', 'memory.db')
  const statusPath = join(f.root, 'writer-status.json')
  const script = join(f.root, 'writer.mjs')
  writeFileSync(script, [
    "import { DatabaseSync } from 'node:sqlite'",
    "import { writeFileSync } from 'node:fs'",
    'const dbPath = ' + JSON.stringify(dbPath),
    'const statusPath = ' + JSON.stringify(statusPath),
    'let commits = 0',
    'let lastError = ""',
    'const writeStatus = () => {',
    '  try { writeFileSync(statusPath, JSON.stringify({ commits, lastError })) } catch { /* 写不动就算了 */ }',
    '}',
    'let db = null',
    'const stopAt = Date.now() + ' + maxMs,
    'const tick = () => {',
    '  if (Date.now() >= stopAt) {',
    '    try { if (db !== null) db.close() } catch { /* 已经关了 */ }',
    '    writeStatus()',
    '    process.exit(0)',
    '  }',
    '  try {',
    '    if (db === null) db = new DatabaseSync(dbPath)',
    '    db.exec("BEGIN; INSERT INTO episodic_memory VALUES (1); COMMIT;")',
    '    commits += 1',
    '  } catch (e) { lastError = String((e && e.message) || e) }',
    '  writeStatus()',
    '  setTimeout(tick, ' + intervalMs + ')',
    '}',
    'tick()'
  ].join('\n'))
  const child = spawn(process.execPath, [script], { stdio: 'ignore' })
  return { child, statusPath }
}

/**
 * 直接数一下库里的行数（活性断言用）。
 *
 * ★ 2026-10-21：补 `busy_timeout` —— 读也可能撞上 writer 的写锁。
 *   默认是 0（立刻 BUSY），撞一次就让活性断言误红。
 */
function countEpisodic (dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return db.prepare('SELECT COUNT(*) AS n FROM episodic_memory').get().n
  } finally { db.close() }
}

/**
 * 轮询 `writer-status.json` 直到 `commits > 0`（或超时）。
 *
 * ★ 2026-10-21 审查方指出：**活性断言不能只采一次样**。
 *   writer 是**另一个 node 进程**，进程启动本身就要时间；全量跑、CPU 被占满时，
 *   "采样那一刻它还没写第一批"完全可能 ⇒ **误红**。误红和假绿一样坏。
 *
 * @returns {Promise<number>} 最后一次读到的 commits（超时返回 0）
 */
async function waitForCommits (statusPath, deadlineMs = 2000, everyMs = 50) {
  const until = Date.now() + deadlineMs
  for (;;) {
    try {
      const s = JSON.parse(readFileSync(statusPath, 'utf8'))
      const n = Number(s?.commits ?? 0)
      if (Number.isFinite(n) && n > 0) return n
    } catch { /* 还没写出来 / 正在写半截 */ }
    if (Date.now() >= until) return 0
    await new Promise((r) => setTimeout(r, everyMs))
  }
}

/**
 * 等 writer **真的退出**（幂等、已退出则立即返回）。
 *
 * ★★ 2026-10-21 审查方抓到的**遮蔽 bug**：上一版只把 `await once(child,'exit')`
 *   加在 happy path（`:262`），`finally` 里是「kill 了就走」⇒ 文件还被占着
 *   ⇒ 下一行 `rmSync` EPERM ⇒ **真实的断言错误被清理阶段的 EPERM 盖掉**。
 *   这是本仓反复踩的「看不见的失败」同款。
 *
 * ★ `exitCode !== null` 守卫：`exit` 事件**只触发一次**，对一个已经退出的 child
 *   再调 `once()` 就是**等一个永远不会再来的事件** ⇒ 整条用例永久挂起。
 */
async function stopWriter (writer) {
  if (writer === null || writer === undefined) return
  const child = writer.child
  if (child === null || child === undefined) return
  // 已经退出了就别等事件 —— exit 只触发一次，错过了就是永久挂起
  if (child.exitCode !== null || child.signalCode !== null) {
    try { child.kill() } catch { /* 已经没了 */ }
    return
  }
  const exited = once(child, 'exit')
  try { child.kill() } catch { /* 已经没了 */ }
  try { await exited } catch { /* 等不到就算了，绝不因为它上抛 */ }
}

/**
 * 删临时目录。**失败只 warn，绝不上抛。**
 *
 * ★ 2026-10-21：清理阶段的错不许盖掉真正的断言错误（同一条遮蔽纪律）。
 *   Windows 上 `rmSync` 会因为「文件还被进程占着」报 EPERM —— 那是**清理问题**，
 *   不是**判定结果**，两者必须分开。
 */
function cleanup (root) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch (e) {
    // 只记一行，不抛 —— 真正的失败原因在上面那条断言里，别把它冲掉
    console.warn('[retire.test] 清理临时目录失败（不影响判定结果）: '
      + String(e?.message ?? e).slice(0, 140))
  }
}

const memoryPath = f => join(f.aData, 'plugin_data', 'astrbot_plugin_memory_middleware', 'memory.db')
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex')

function sourceBytes (f) {
  const out = {}
  function visit (directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name
      if (entry.isDirectory()) visit(join(directory, entry.name), name + '/')
      else out[name] = readFileSync(join(directory, entry.name))
    }
  }
  visit(f.aData)
  return out
}

function assertNoRetireWrites (f, before, memoryHash = null) {
  const after = sourceBytes(f)
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), '拒签不许改名或新增源文件')
  for (const name of Object.keys(before)) {
    if (memoryHash !== null && name.endsWith('/memory.db')) {
      assert.equal(hashBytes(after[name]), memoryHash, '库只能包含受控 writer 已提交的 schema 变更')
    } else assert.equal(Buffer.compare(after[name], before[name]), 0, name + ' 的字节不许被拒签流程改动')
  }
  assert.equal(existsSync(f.backup), false, '未知采样不得创建备份')
  assert.equal(existsSync(f.manifests), false, '未知采样不得创建清单')
}

async function waitForSignal (file, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { /* 创建/写入尚未完成。 */ }
    assert.ok(Date.now() < until, '受控进程没有发出完整就绪信号: ' + file)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Real SQLite control process; stopWriter() supplies the existing exit/cleanup discipline. */
function spawnSampleControl (f, mode) {
  const signals = Object.fromEntries(['ready', 'busy', 'released', 'secondBegin', 'schemaReady', 'status']
    .map(name => [name, join(f.root, 'sample-' + name + '.json')]))
  const script = join(f.root, 'sample-control.mjs')
  writeFileSync(script, `
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const file = ${JSON.stringify(memoryPath(f))}
const mode = ${JSON.stringify(mode)}
const signals = ${JSON.stringify(signals)}
const write = (name, value) => writeFileSync(signals[name], JSON.stringify(value))
const until = Date.now() + 25000
let db
try {
  if (mode !== 'schema-drop') {
    db = new DatabaseSync(file)
    db.exec('BEGIN EXCLUSIVE')
  }
  write('ready', { mode, locked: mode !== 'schema-drop' })
  const tick = () => {
    try {
      if (mode === 'exclusive-release' && existsSync(signals.busy)) {
        db.exec('COMMIT'); db.close(); db = null
        write('released', { released: true })
        write('status', { finished: true })
        return
      }
      if (mode === 'schema-drop' && existsSync(signals.secondBegin)) {
        db = new DatabaseSync(file)
        db.exec('PRAGMA busy_timeout=5000; DROP TABLE her_agenda')
        db.close(); db = null
        write('schemaReady', { dropped: 'her_agenda',
          sha256: createHash('sha256').update(readFileSync(file)).digest('hex') })
        write('status', { finished: true })
        return
      }
      if (Date.now() >= until) throw Error('sample control handshake timed out')
      setTimeout(tick, 10)
    } catch (error) {
      try { db?.close() } catch {}
      write('status', { error: String(error.message) })
      process.exitCode = 1
    }
  }
  tick()
} catch (error) {
  write('status', { error: String(error.message) })
  process.exitCode = 1
}
`)
  const child = spawn(process.execPath, [script], { stdio: 'ignore', windowsHide: true })
  return { child, signals, statusPath: signals.status }
}

/** Observe genuine BUSY or delay the second BEGIN; never replace a result/error. */
function samplePreload (f, control, mode) {
  const file = join(f.root, 'sample-observer.mjs')
  writeFileSync(file, `
import { DatabaseSync } from 'node:sqlite'
import { existsSync, writeFileSync } from 'node:fs'
const signals = ${JSON.stringify(control.signals)}
const mode = ${JSON.stringify(mode)}
const write = (name, value) => writeFileSync(signals[name], JSON.stringify(value))
const wait = name => {
  const until = Date.now() + 10000
  while (!existsSync(signals[name]) && Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
  return existsSync(signals[name])
}
let begins = 0, busy = 0
const exec = DatabaseSync.prototype.exec
DatabaseSync.prototype.exec = function (sql, ...args) {
  if (mode === 'schema-drop' && String(sql).trim() === 'BEGIN' && ++begins === 2) {
    write('secondBegin', { pausedBeforeRealBegin: true })
    if (!wait('schemaReady')) write('status', { error: 'schema handshake timed out' })
  }
  return exec.call(this, sql, ...args)
}
const prepare = DatabaseSync.prototype.prepare
DatabaseSync.prototype.prepare = function (...args) {
  try { return prepare.apply(this, args) }
  catch (error) {
    if (Number.isInteger(error.errcode) && (error.errcode & 255) === 5) {
      const observation = { hits: ++busy, errcode: error.errcode, errstr: error.errstr }
      write('busy', observation)
      if (mode === 'exclusive-release') write('busy', {
        ...observation, releaseConfirmed: wait('released')
      })
    }
    throw error
  }
}
`)
  return file
}

test('dry-run:一个字节都不动', () => {
  const f = fixture()
  try {
    const { code, report } = run(f)
    assert.equal(code, 0)
    assert.equal(existsSync(join(f.aData, 'plugin_data', 'astrbot_plugin_memory_middleware', 'memory.db')), true)
    assert.equal(existsSync(f.backup), false, 'dry-run 不该造备份目录')
    assert.equal(existsSync(f.manifests), false, 'dry-run 不该写清单')
    const files = report.plan.flatMap((p) => p.files.map((x) => x.from))
    assert.equal(files.length, 7, 'memory 三件套 + state 两件 + 两份老配置(夹具故意没有 state.db-shm)')
  } finally { cleanup(f.root) }
})

test('--apply:三件套跟着走、备份先落、清单记下 sha256 与回滚命令', () => {
  const f = fixture()
  try {
    const memDir = join(f.aData, 'plugin_data', 'astrbot_plugin_memory_middleware')
    const before = readFileSync(join(memDir, 'memory.db-wal'), 'utf8')
    const { code, report } = run(f, ['--apply'])
    assert.equal(code, 0)
    // 改名:原件不在,归档件在(-wal 也不能落下)
    for (const name of ['memory.db', 'memory.db-wal', 'memory.db-shm']) {
      assert.equal(existsSync(join(memDir, name)), false, name + ' 应该已改名')
      assert.equal(existsSync(join(memDir, name + '.archived-2026-09-30')), true, name + ' 缺归档件')
    }
    assert.equal(existsSync(join(f.aData, 'plugin_data', 'astrbot_plugin_agent_state', 'state.db.archived-2026-09-30')), true)
    // 备份:内容逐字节一样
    const copies = readdirSync(report.copied[0].replace(/[\\/][^\\/]+$/, ''))
    assert.equal(copies.length, 7)
    const walCopy = report.copied.find((p) => p.endsWith('memory.db-wal'))
    assert.equal(readFileSync(walCopy, 'utf8'), before)
    // 清单:sha256 + 回滚命令 + 结果都在
    const manifest = JSON.parse(readFileSync(report.manifest, 'utf8'))
    assert.equal(manifest.renamed.length, 7)
    assert.equal(manifest.errors.length, 0)
    assert.match(manifest.plan[0].files[0].sha256, /^[0-9a-f]{16}$/)
    assert.equal(manifest.rollback.length, 7)
  } finally { cleanup(f.root) }
})

test('两份老配置也跟着归档:一个备份目录里存齐「老链路尸体」', () => {
  const f = fixture()
  try {
    const cfgDir = join(f.aData, 'config')
    const beforeMem = readFileSync(join(cfgDir, 'astrbot_plugin_memory_middleware_config.json'), 'utf8')
    const { code, report } = run(f, ['--apply'])
    assert.equal(code, 0)
    for (const name of ['astrbot_plugin_memory_middleware_config.json', 'astrbot_plugin_agent_state_config.json']) {
      assert.equal(existsSync(join(cfgDir, name)), false, name + ' 应该已改名')
      assert.equal(existsSync(join(cfgDir, name + '.archived-2026-09-30')), true, name + ' 缺归档件')
      assert.ok(report.copied.some((p) => p.endsWith(name)), name + ' 没进备份')
    }
    // 备份里的内容逐字节一样(它是「老链路当年照什么说话」的原始证据)
    const copy = report.copied.find((p) => p.endsWith('astrbot_plugin_memory_middleware_config.json'))
    assert.equal(readFileSync(copy, 'utf8'), beforeMem)
    // 清单里也有一项,带 sha256
    const manifest = JSON.parse(readFileSync(report.manifest, 'utf8'))
    const cfgItem = manifest.plan.find((p) => p.target.includes('记忆中间件'))
    assert.ok(cfgItem, '清单里该有配置那一项:' + JSON.stringify(manifest.plan.map((p) => p.target)))
    assert.match(cfgItem.files[0].sha256, /^[0-9a-f]{16}$/)
  } finally { cleanup(f.root) }
})

test('配置不在也不炸(没这两份配置的机器):照样能归档库', () => {
  const f = fixture({ withConfig: false })
  try {
    const { code, report } = run(f, ['--apply'])
    assert.equal(code, 0)
    assert.equal(report.plan.flatMap((p) => p.files).length, 5, '只剩两张库的五件')
    assert.ok(report.notes.some((n) => n.includes('文件不在')), '该说一句「配置不在」')
  } finally { cleanup(f.root) }
})

test('重复跑安全:已经归档过就跳过,不当错误', () => {
  const f = fixture()
  try {
    run(f, ['--apply'])
    const { code, report } = run(f, ['--apply'])
    assert.equal(code, 0)
    assert.equal(report.plan.length, 0, '第二次没有要动的文件')
    assert.ok(report.notes.some((n) => n.includes('已经归档过') || n.includes('文件不在')))
  } finally { cleanup(f.root) }
})

/**
 * ★ 2026-10-21：**显式 `timeout: 30000`**。
 *
 *   我上一版报告里写过「node:test 有默认超时兜底」—— **那是错的**。
 *   `node:test` 的默认 timeout 是 **Infinity**：这里一旦挂住（比如等一个
 *   永远不会再触发的 `exit` 事件），**整条套件永久挂起**，不是"超时失败"。
 *   所以必须自己给一个上限，让"挂住"变成"失败"。
 *
 *   30s 的依据：这条在全量负载下实测最长 ~6.9s（审查方数据）；
 *   30s 留了 4 倍余量，又不至于让真挂住的情况拖太久。
 */
test('A 侧还在写就拒签(两次采样对不上);--force 是显式逃生门', { timeout: 30000 }, async () => {
  const f = fixture({ withDb: true })
  const memDir = join(f.aData, 'plugin_data', 'astrbot_plugin_memory_middleware')
  const dbPath = join(memDir, 'memory.db')
  let writer = null
  try {
    // ★ 2026-10-21：writer **持续写**，直到被 kill。
    //   这样**不管脚本第一次采样被推迟到哪**，第二次采样时它还在写
    //   ⇒ countsSecond > counts 必然成立 ⇒ drift 非空 ⇒ 拒签。
    //   （旧写法「400ms 写一次就退」隐含了「第一次采样 < 提交」这个时间假设，
    //     全量跑时 CPU 被占住、第一次采样被推到提交之后 ⇒ 两次都读成同值 ⇒ 假绿变红。）
    writer = spawnWriter(f)

    const refused = run(f, ['--apply', '--sample-gap-ms=1200'])

    // ---- 活性断言 ①（**轮询**，不是只采一次样）----------------------------
    // writer 是另一个 node 进程，启动本身要时间；全量跑 CPU 被占满时，
    // "采样那一刻它还没写第一批"完全可能 ⇒ 只采一次会**误红**。
    const commitsSeen = await waitForCommits(writer.statusPath, 2000)
    assert.ok(commitsSeen > 0,
      '★ writer 必须真的写过 —— 否则这条用例是假绿（stdio:ignore 下它崩了也看不见）: '
      + '2 秒内 writer-status.json 里 commits 一直是 0')

    const totalAfter = countEpisodic(dbPath)
    assert.ok(totalAfter > BASELINE.episodic_memory,
      '★ writer 必须真的写过 —— 否则这条用例是假绿: '
      + totalAfter + ' vs 基线 ' + BASELINE.episodic_memory)

    // ---- 停 writer，**等它真退**（stopWriter 里带 exitCode 守卫）---------
    const writerStatus = JSON.parse(readFileSync(writer.statusPath, 'utf8'))
    await stopWriter(writer)
    writer = null

    // ---- 活性断言 ②：writer 自己记的提交次数 -----------------------------
    assert.ok(writerStatus.commits > 0,
      '★ writer 自己记的提交次数要 > 0（它自己说没写过就是没写）: ' + JSON.stringify(writerStatus))

    // ---- 现在才验产品行为 -----------------------------------------------
    assert.equal(refused.code, 1, 'A 侧还在长就该拒签（writer 写了 ' + writerStatus.commits + ' 批）')
    assert.ok(Array.isArray(refused.report.drift) && refused.report.drift.length > 0,
      '★ drift 必须非空 —— 这是「两次采样对不上」的直接证据: '
      + JSON.stringify(refused.report.drift)
      + '（counts=' + JSON.stringify(refused.report.counts)
      + ' countsSecond=' + JSON.stringify(refused.report.countsSecond) + '）')
    assert.ok(refused.report.problems.some((p) => p.includes('两次采样之间还在长') || p.includes('-wal')),
      '要明说「还在写」:' + JSON.stringify(refused.report.problems))
    assert.equal(existsSync(dbPath), true, '拒签时绝不许改名')

    // writer 已停 ⇒ 库不再长 ⇒ --force 放行
    const forced = run(f, ['--apply', '--force'])
    assert.equal(forced.code, 0, '--force 是显式逃生门: ' + JSON.stringify(forced.report?.problems))
    assert.equal(existsSync(join(memDir, 'memory.db.archived-2026-09-30')), true)
  } finally {
    // ★★ 2026-10-21：**先等 writer 真退，再删目录**（stopWriter 幂等、带 exitCode 守卫）。
    //   上一版这里是「kill 了就走」⇒ 文件还被占着 ⇒ `rmSync` EPERM
    //   ⇒ **真实的断言错误被清理阶段的 EPERM 盖掉**（审查方实测过一次）。
    await stopWriter(writer)
    cleanup(f.root)          // 删不掉只 warn，绝不上抛
  }
})

test('-wal 刚被写过也拒签(阈值可调;这正是「插件还开着」的样子)', () => {
  const f = fixture()
  try {
    // 默认阈值 90s,而夹具文件是刚创建的 → 必须拦下
    const refused = run(f, ['--fresh-seconds=90'])
    assert.equal(refused.code, 1)
    assert.ok(refused.report.problems.some((p) => p.includes('-wal')))
    // 关掉阈值就放行
    const passed = run(f, ['--fresh-seconds=0'])
    assert.equal(passed.code, 0)
  } finally { cleanup(f.root) }
})

test('与切换前基线的差异只是提醒,不拦人(切换前它本来就该在长)', () => {
  const f = fixture({ withDb: true, counts: { ...BASELINE, episodic_memory: 136 } })
  try {
    const { code, report } = run(f, ['--apply'])
    assert.equal(code, 0)
    assert.equal(report.drift.length, 0, '两次采样一致 = 此刻没人写')
    assert.deepEqual(report.sinceBaseline, ['episodic_memory 134→136'])
    assert.ok(report.notes.some((n) => n.includes('归档前记得先跑一次增量合并')))
  } finally { cleanup(f.root) }
})

test('--no-copy:只改名不备份(留给「我已经自己备份过」的场合)', () => {
  const f = fixture()
  try {
    const { code, report } = run(f, ['--apply', '--no-copy'])
    assert.equal(code, 0)
    assert.equal(report.copied.length, 0)
    assert.equal(existsSync(f.backup), false)
  } finally { cleanup(f.root) }
})

test('真实 EXCLUSIVE 首次 BUSY 后释放:重试整个只读采样并返回完整五表', { timeout: 30000 }, async () => {
  const f = fixture({ rollbackSampling: true }), before = sourceBytes(f)
  assert.equal(Object.keys(before).length, 7)
  const control = spawnSampleControl(f, 'exclusive-release')
  try {
    assert.equal((await waitForSignal(control.signals.ready)).locked, true)
    const preload = samplePreload(f, control, 'exclusive-release')
    const { code, report } = run(f, [], { preload })
    const observed = JSON.parse(readFileSync(control.signals.busy, 'utf8'))
    assert.equal(observed.hits, 1, '必须实际碰到一次 SQLite BUSY')
    assert.equal(observed.errcode & 255, 5)
    assert.equal(observed.releaseConfirmed, true)
    assert.equal((await waitForSignal(control.signals.released)).released, true)
    assert.equal(code, 0)
    assert.deepEqual(report.counts, BASELINE)
    assert.deepEqual(report.countsSecond, BASELINE)
    assert.equal(report.sampling.busyTimeoutMs, 500)
    assert.equal(report.sampling.maxAttempts, 3)
    assert.deepEqual(report.sampling.first, { status: 'ok', attempts: 2 })
    assert.deepEqual(report.sampling.second, { status: 'ok', attempts: 2 })
    assert.deepEqual(report.schemaDrift, [])
    assertNoRetireWrites(f, before)
  } finally { await stopWriter(control); cleanup(f.root) }
})

test('真实 EXCLUSIVE 持续锁:三次真实 BUSY 耗尽后 force 也不能触碰源文件', { timeout: 30000 }, async () => {
  const f = fixture({ rollbackSampling: true }), before = sourceBytes(f)
  assert.equal(Object.keys(before).length, 7)
  const control = spawnSampleControl(f, 'exclusive-hold')
  try {
    assert.equal((await waitForSignal(control.signals.ready)).locked, true)
    const preload = samplePreload(f, control, 'exclusive-hold')
    const { code, report } = run(f, ['--apply', '--force'], { preload })
    const observed = JSON.parse(readFileSync(control.signals.busy, 'utf8'))
    assert.equal(observed.hits, 3, '三次尝试必须都实际遇到 BUSY')
    assert.equal(code, 1)
    assert.equal(report.counts, null)
    assert.equal(report.countsSecond, null)
    assert.equal(report.sampling.first.status, 'failed')
    assert.equal(report.sampling.first.attempts, 3)
    assert.deepEqual(report.sampling.second, report.sampling.first)
    assert.ok(report.problems.length > 0)
    assertNoRetireWrites(f, before)
  } finally { await stopWriter(control); cleanup(f.root) }
})

test('稳定缺少一个已知表:保留四表完整计数与七文件归档字节', () => {
  const f = fixture({ tables: A_TABLES.filter(table => table !== 'her_agenda'), rollbackSampling: true })
  const before = sourceBytes(f)
  assert.equal(Object.keys(before).length, 7)
  try {
    const { code, report } = run(f, ['--apply'])
    const expected = { episodic_memory: 134, pending_threads: 9, graph_nodes: 26, graph_edges: 28 }
    assert.equal(code, 0)
    assert.deepEqual(report.counts, expected)
    assert.deepEqual(report.countsSecond, expected)
    assert.deepEqual(report.sampling.first, { status: 'ok', attempts: 1 })
    assert.deepEqual(report.sampling.second, { status: 'ok', attempts: 1 })
    assert.deepEqual(report.schemaDrift, [])
    assert.equal(report.renamed.length, 7)
    assert.equal(report.copied.length, 7)
    for (const [name, bytes] of Object.entries(before)) {
      assert.equal(Buffer.compare(readFileSync(join(f.aData, name + '.archived-2026-09-30')), bytes), 0, name)
    }
  } finally { cleanup(f.root) }
})

test('两次事务间真实 DROP 已知表:表集合漂移即使 force 也拒绝归档', { timeout: 30000 }, async () => {
  const f = fixture({ rollbackSampling: true }), before = sourceBytes(f)
  assert.equal(Object.keys(before).length, 7)
  const control = spawnSampleControl(f, 'schema-drop')
  try {
    assert.equal((await waitForSignal(control.signals.ready)).mode, 'schema-drop')
    const preload = samplePreload(f, control, 'schema-drop')
    const { code, report } = run(f, ['--apply', '--force', '--sample-gap-ms=1'], { preload })
    const changed = await waitForSignal(control.signals.schemaReady)
    assert.equal(changed.dropped, 'her_agenda')
    assert.equal(code, 1)
    assert.deepEqual(report.counts, BASELINE)
    assert.deepEqual(report.countsSecond,
      { episodic_memory: 134, pending_threads: 9, graph_nodes: 26, graph_edges: 28 })
    assert.deepEqual(report.sampling.first, { status: 'ok', attempts: 1 })
    assert.deepEqual(report.sampling.second, { status: 'ok', attempts: 1 })
    assert.deepEqual(report.schemaDrift, ['her_agenda'])
    assert.ok(report.problems.length > 0)
    assertNoRetireWrites(f, before, changed.sha256)
  } finally { await stopWriter(control); cleanup(f.root) }
})

test('损坏的 memory.db:未知采样失败在 force 下也保持七个源文件不动', () => {
  const f = fixture({ rollbackSampling: true })
  writeFileSync(memoryPath(f), 'synthetic corrupt SQLite bytes; intentionally not a database')
  const before = sourceBytes(f)
  assert.equal(Object.keys(before).length, 7)
  try {
    const { code, report } = run(f, ['--apply', '--force'])
    assert.equal(code, 1)
    assert.equal(report.counts, null)
    assert.equal(report.countsSecond, null)
    assert.equal(report.sampling.first.status, 'failed')
    assert.equal(report.sampling.first.attempts, 1)
    assert.deepEqual(report.sampling.second, report.sampling.first)
    assert.ok(report.problems.length > 0)
    assertNoRetireWrites(f, before)
  } finally { cleanup(f.root) }
})
