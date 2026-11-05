/**
 * 「真库迁移彩排」这条命令的护栏(`scripts/rehearse-migration.mjs`)。
 *
 * 它要在**他重启 dsh web 的那一秒之前**回答一件事:新版桥打开线上那份 echo.db
 * 会不会出事。所以这里测的是它的**判断**:
 *
 *  - 老库(还没有三张桥表)→ 落表 + 旧表一行不动;
 *  - 老库里的桥表**形状不对**(比如少了 `dropped_at`)→ 必须报出来,而不是
 *    「打开成功」就放行 —— 那种库跑到入队那一刻才会炸;
 *  - 只动副本:真库一个字节都不许改(拿文件大小+内容哈希盯着);
 *  - 找不到库时给出明确出路(exit 2),不是静默通过。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStore } from '../lib/store.js'

const SCRIPT = new URL('../scripts/rehearse-migration.mjs', import.meta.url).pathname.replace(/^\//, '')

/**
 * 造一份「老库」。**必须先用真 DDL 建库**(`openStore`)再动手拆 —— 简化过
 * 的表结构会让 store 打开时报 `no such column`(它假定库是自己的那份形状),
 * 那样测的就不是彩排脚本的判断,而是夹具自己的错。真实场景也正是这样:线上
 * 那份库是**本插件的老版本**建的,不是随便一个 SQLite 文件。
 */
function fixture ({ dropRelay = false, oldRelayShape = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'echo-rehearse-test-'))
  const dbPath = join(dir, 'echo.db')
  const boot = openStore(dbPath)
  boot.close()
  const db = new DatabaseSync(dbPath)
  db.exec("INSERT INTO episodic_memory (user_id, summary, timestamp, memory_key) " +
    "VALUES ('master', '记得吃饭', 1, 'k1'), ('master', '记得睡觉', 2, 'k2')")
  db.exec("INSERT INTO user_profile (user_id, name) VALUES ('master', '阿岚')")
  if (dropRelay) {
    for (const t of ['relay_inbox_seen', 'relay_channels', 'relay_outbox']) db.exec('DROP TABLE ' + t)
  } else if (oldRelayShape) {
    db.exec('DROP TABLE relay_outbox')
    db.exec(`CREATE TABLE relay_outbox (out_id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL,
      chat_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      kind TEXT DEFAULT 'reply', text TEXT NOT NULL, created_at REAL NOT NULL,
      leased_until REAL DEFAULT 0, acked_at REAL DEFAULT 0)`)
  }
  db.close()
  return { dir, dbPath }
}

function run (dbPath, extra = []) {
  const argv = [SCRIPT, '--db=' + dbPath, '--json', ...extra]
  try {
    return { code: 0, report: JSON.parse(execFileSync(process.execPath, argv, { encoding: 'utf8' })) }
  } catch (e) {
    return { code: e.status, report: e.stdout ? JSON.parse(e.stdout) : null, stderr: String(e.stderr || '') }
  }
}

const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

test('老库(没有桥表):落表 + 旧表一行不动 + 只动副本', () => {
  const f = fixture({ dropRelay: true })
  try {
    const before = digest(f.dbPath)
    const size = statSync(f.dbPath).size
    const { code, report } = run(f.dbPath)
    assert.equal(code, 0, JSON.stringify(report?.problems))
    assert.deepEqual(report.tablesAdded.sort(), ['relay_channels', 'relay_inbox_seen', 'relay_outbox'])
    assert.equal(report.changed.length, 0)
    assert.equal(report.countsBefore.episodic_memory, 2)
    assert.equal(report.countsAfter.episodic_memory, 2)
    assert.equal(report.probe.enqueued, true)
    assert.equal(report.probe.leased, true)
    assert.ok(report.integrity.ok)
    // 真库一个字节都不许变
    assert.equal(digest(f.dbPath), before, '彩排不许碰真库')
    assert.equal(statSync(f.dbPath).size, size)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('桥表已经在库里:不算缺,也不谎报「本次新建」', () => {
  const f = fixture()
  try {
    const { code, report } = run(f.dbPath)
    assert.equal(code, 0, JSON.stringify(report?.problems))
    assert.deepEqual(report.relayPresentBefore.sort(), ['relay_channels', 'relay_inbox_seen', 'relay_outbox'])
    assert.deepEqual(report.tablesAdded, [])
    assert.equal(report.changed.length, 0)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('桥表形状不对(少了 dropped_at)→ 必须报出来,不能「打开成功」就放行', () => {
  const f = fixture({ oldRelayShape: true })
  try {
    const { code, report } = run(f.dbPath)
    assert.equal(code, 1)
    // 实测:这种库在**打开那一刻**就抛(启动时的清理语句引用了那列)——
    // 也就是说形状不对 = 新插件**装不上**,不是「跑起来有点怪」,更要拦在前面。
    assert.ok(report.problems.some((p) => p.includes('dropped_at')),
      '要指名那一列:' + JSON.stringify(report.problems))
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('找不到库:exit 2 且说清出路(--db=)', () => {
  const f = fixture()
  try {
    const missing = join(f.dir, 'nope.db')
    try {
      execFileSync(process.execPath, [SCRIPT, '--db=' + missing], { encoding: 'utf8' })
      assert.fail('应该以 2 退出')
    } catch (e) {
      assert.equal(e.status, 2)
      assert.match(String(e.stdout || ''), /--db=/)
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})
