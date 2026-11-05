/**
 * 回执行数报表(`scripts/graph-receipts-report.mjs`)的护栏 —— 阶段 1b 裁决②补的。
 *
 * 裁决②要的是"**看得见增长**、但本轮不清理" ⇒ 这把尺子必须满足两件:
 *   ① **只读**:跑完库文件字节级不变(mtime + sha256 双重作证);
 *   ② **数字对得上**:总行数 / 按 action·reason 分组 / 最近 N 个 run_id 的行数,
 *      与手工插进去的行一一对应。
 *
 * 另加一条形状守卫:`--runs` 只影响"列最近几组",不影响总数(报表没有"只看最近 N"的口径
 * 漂移)。表不存在(老库)时报 `exists:false` 且 exit 0 —— 空表不是错误。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const SCRIPT = fileURLToPath(new URL('../scripts/graph-receipts-report.mjs', import.meta.url))

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

function run (args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' }), err: '' }
  } catch (e) {
    return { code: Number(e.status), out: String(e.stdout || ''), err: String(e.stderr || '') }
  }
}

/** 造一个"有回执表 + 几行"的库(形状照 `db.py` 的迁移 DDL,只留报表要读的列也够,但这里给全)。 */
function makeDb (dir, rows, { withTable = true } = {}) {
  const path = join(dir, 'echo.db')
  const db = new DatabaseSync(path)
  if (withTable) {
    db.exec(`CREATE TABLE graph_edge_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT DEFAULT '', created_at REAL DEFAULT 0,
      kind TEXT DEFAULT '', source_kind TEXT DEFAULT '', target_kind TEXT DEFAULT '',
      source_id TEXT DEFAULT '', target_id TEXT DEFAULT '', action TEXT DEFAULT '',
      reason TEXT DEFAULT '', rule_id TEXT DEFAULT '', occurred_at REAL DEFAULT 0,
      occurred_at_source TEXT DEFAULT '', evidence_memory_id TEXT DEFAULT '[]',
      note TEXT DEFAULT '', payload TEXT DEFAULT '{}')`)
    const ins = db.prepare('INSERT INTO graph_edge_receipts (run_id, created_at, kind, action, reason, rule_id, note)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const r of rows) ins.run(r.runId, r.createdAt, r.kind, r.action, r.reason, r.ruleId, r.note || '')
  } else {
    db.exec('CREATE TABLE graph_nodes (node_id TEXT PRIMARY KEY, name TEXT)')
  }
  db.close()
  return path
}

test('只读 + 数字对得上:总行数 / 分组 / 最近 N 组', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-receipts-'))
  try {
    const path = makeDb(dir, [
      { runId: 'a', createdAt: 1000, kind: 'cooccur_same_memory', action: 'drop', reason: 'speaker-node', ruleId: 'R1' },
      { runId: 'a', createdAt: 1001, kind: 'cooccur_same_memory', action: 'rewrite', reason: 'slot-conflict', ruleId: 'R5' },
      { runId: 'b', createdAt: 1002, kind: 'temporal', action: 'accept', reason: '', ruleId: 'R4', note: 'rule-table-miss' },
      { runId: 'c', createdAt: 1003, kind: '', action: 'drop', reason: 'internal-error', ruleId: '', note: 'gate-internal-error:RuntimeError' }
    ])
    const before = sha(path)
    const res = run(['--db', path, '--runs', '2', '--json'])
    assert.equal(res.code, 0, res.err)
    const out = JSON.parse(res.out)
    assert.equal(out.ok, true)
    assert.equal(out.db.mtimeUnchanged, true)
    assert.equal(sha(path), before, '报表改了库文件')
    assert.equal(out.table.rows, 4)
    assert.equal(out.table.runIds, 3)
    assert.deepEqual(out.byAction, { drop: 2, rewrite: 1, accept: 1 })
    assert.deepEqual(out.byReason, { 'speaker-node': 1, 'slot-conflict': 1, '': 1, 'internal-error': 1 })
    assert.equal(out.table.internalErrors, 1)
    assert.equal(out.table.tableMissPasses, 1)
    assert.equal(out.runs.length, 2, '--runs 2 只列最近两组')
    assert.deepEqual(out.runs.map((r) => r.runId), ['c', 'b'], '按最后写入行排序')
    assert.deepEqual(out.runs.map((r) => r.rows), [1, 1])
    // --runs 只改"列几组",不改总数
    const all = JSON.parse(run(['--db', path, '--runs', '9', '--json']).out)
    assert.equal(all.table.rows, 4)
    assert.equal(all.runs.length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('人类可读报表:关键数字与"只读"声明都在,且 exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-receipts-'))
  try {
    const path = makeDb(dir, [
      { runId: 'probe-1', createdAt: 1700000000, kind: 'temporal', action: 'drop', reason: 'no-occurred-at', ruleId: 'R6' }
    ])
    const res = run(['--db', path])
    assert.equal(res.code, 0, res.err)
    assert.match(res.out, /总行数 = 1/)
    assert.match(res.out, /不同 run_id = 1/)
    assert.match(res.out, /probe-1/)
    assert.match(res.out, /默认不清理/)
    assert.match(res.out, /本报表只读,未修改任何数据/)
    assert.match(res.out, /\(未变\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('老库没有回执表 / 库不存在:报清楚,exit 0(空表不是错误)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-receipts-'))
  try {
    const noTable = makeDb(dir, [], { withTable: false })
    const a = run(['--db', noTable, '--json'])
    assert.equal(a.code, 0, a.err)
    const parsed = JSON.parse(a.out)
    assert.equal(parsed.table.exists, false)
    assert.equal(parsed.table.rows, 0)

    const missing = run(['--db', join(dir, 'nope.db'), '--json'])
    assert.equal(missing.code, 0, missing.err)
    assert.equal(JSON.parse(missing.out).reason, 'db-not-found')

    const bad = run(['--db', noTable, '--runs', 'zero'])
    assert.equal(bad.code, 1, '--runs 非法要 exit 1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
