/**
 * F7 记忆归档守卫 + 批次回滚。
 *
 * 现场:`scripts/memory-doctor.mjs --clean --yes` 把那 27 条 `memory_cleanup`
 * 写进审计,归档的是他**当前正在做的项目整簇**(AI 记忆架构 / 多人 agent /
 * 面试预算 / 审查台与图谱),其中 **#248 就是他让我「去开源社区与学术论文里
 * 找现成图谱实现作参照」的那条请求**。图侧同步受害:12/35 条边 is_active=0。
 *
 * 根因:写入侧的 `rejectReason` 是"宁可漏拒(少记一条)",被**追溯**施加到
 * 归档侧时代价完全不同 —— 错拒 = 把他已经记住的东西删掉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  cleanupProtected, planCleanup, archiveBatch, rollbackBatch, newBatchId,
  batchTracePrefix, PROTECT_IV, PROTECT_EMOTION, PROTECT_DAYS
} = await import('../lib/cleanup-guard.js')

const DAY = 86400
const NOW = 1790000000

function row (over = {}) {
  return {
    id: 1, layer: 'reflection', source: 'reflection', active: 1,
    intrinsicValue: 10, emotionScore: 3, timestamp: NOW - 400 * DAY,
    summary: 'x', ...over
  }
}

// ── 守卫规则 ───────────────────────────────────────────────────────────

test('F7 守卫:低价值老记忆可归档', () => {
  assert.deepEqual(cleanupProtected(row(), NOW), { protected: false, why: '' })
})

test('F7 守卫:L0 一律豁免(按文本判据归档身份事实是最不该的误伤)', () => {
  const v = cleanupProtected(row({ layer: 'L0' }), NOW)
  assert.equal(v.protected, true)
  assert.equal(v.why, 'core-tier')
})

test('F7 守卫:高内在价值豁免', () => {
  assert.equal(cleanupProtected(row({ intrinsicValue: PROTECT_IV }), NOW).protected, true)
  assert.equal(cleanupProtected(row({ intrinsicValue: PROTECT_IV - 1 }), NOW).protected, false)
})

test('F7 守卫:高情感分豁免(与 episodic.cleanup_stale 同一条规则)', () => {
  assert.equal(cleanupProtected(row({ emotionScore: PROTECT_EMOTION }), NOW).protected, true)
  assert.equal(cleanupProtected(row({ emotionScore: PROTECT_EMOTION - 1 }), NOW).protected, false)
})

test('F7 守卫:近期豁免 —— 当前项目永远落在窗口里', () => {
  const fresh = row({ timestamp: NOW - (PROTECT_DAYS - 1) * DAY })
  const old = row({ timestamp: NOW - (PROTECT_DAYS + 1) * DAY })
  assert.equal(cleanupProtected(fresh, NOW).protected, true)
  assert.equal(cleanupProtected(fresh, NOW).why, 'recent(<' + PROTECT_DAYS + '天)')
  assert.equal(cleanupProtected(old, NOW).protected, false)
})

test('F7 守卫:畸形行不炸', () => {
  assert.equal(cleanupProtected(null, NOW).protected, false)
  assert.equal(cleanupProtected(undefined, NOW).protected, false)
  assert.equal(cleanupProtected(row({ timestamp: 0 }), NOW).protected, false)
})

test('F7 planCleanup:只动现役,已归档的不重复动', () => {
  const rows = [
    row({ id: 1, active: 1 }),
    row({ id: 2, active: 0 }),
    row({ id: 3, active: 1, intrinsicValue: 90 })
  ]
  const { targets, kept } = planCleanup(rows, NOW)
  assert.deepEqual(targets.map((r) => r.id), [1])
  assert.deepEqual(kept.map((r) => r.id), [3])
  assert.equal(kept[0].why, 'high-value(I≥' + PROTECT_IV + ')')
})

test('F7 planCleanup:活库那 27 条会被大面积豁免(现场复刻)', () => {
  // 复刻:他的项目簇记忆 = 近期 + 高价值
  const cluster = [
    row({ id: 248, timestamp: NOW - DAY, intrinsicValue: 88,
      summary: '他让我去开源社区与学术论文里找现成图谱实现作参照' }),
    row({ id: 240, timestamp: NOW - 3 * DAY, emotionScore: 7,
      summary: '审查台要做得好看一点' }),
    row({ id: 10, timestamp: NOW - 5 * DAY, intrinsicValue: 70,
      summary: 'AI 记忆架构的讨论' })
  ]
  const { targets, kept } = planCleanup(cluster, NOW)
  assert.equal(targets.length, 0, '#248 那种任务请求绝不该被归档')
  assert.equal(kept.length, 3)
})

test('F7 planCleanup:真噪声仍然会被清掉(守卫不是万能保护伞)', () => {
  const junk = [row({ id: 900, timestamp: NOW - 300 * DAY, intrinsicValue: 5,
    emotionScore: 1, summary: 'Current runtime context. This snapshot supersedes' })]
  const { targets } = planCleanup(junk, NOW)
  assert.deepEqual(targets.map((r) => r.id), [900])
})

// ── 批次归档 / 回滚(真库) ─────────────────────────────────────────────

function freshDb () {
  const dir = mkdtempSync(join(tmpdir(), 'echo-cleanup-'))
  const db = new DatabaseSync(join(dir, 'echo.db'))
  db.exec(`
    CREATE TABLE episodic_memory (
      memory_id INTEGER PRIMARY KEY AUTOINCREMENT,
      summary TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE audit_logs (
      trace_id TEXT PRIMARY KEY, session_id TEXT, user_key TEXT,
      user_input TEXT, tool_call TEXT, timestamp REAL);
  `)
  return { dir, db }
}

test('F7 archiveBatch + rollbackBatch:一键撤销那一批', () => {
  const { dir, db } = freshDb()
  try {
    for (const id of [1, 2, 3, 4]) {
      db.prepare('INSERT INTO episodic_memory (memory_id, summary, is_active) VALUES (?,?,1)')
        .run(id, 'm' + id)
    }
    const batchA = newBatchId(NOW)
    const batchB = newBatchId(NOW)
    assert.notEqual(batchA, batchB, '同秒两批不许撞车')
    archiveBatch(db, batchA, [{ id: 1, summary: 'a' }, { id: 2, summary: 'b' }], NOW)
    archiveBatch(db, batchB, [{ id: 3, summary: 'c' }], NOW)
    const active = () => db.prepare(
      'SELECT memory_id FROM episodic_memory WHERE is_active = 1 ORDER BY memory_id')
      .all().map((r) => Number(r.memory_id))
    assert.deepEqual(active(), [4], '归档后只剩 4')

    // 回滚 A 批:只恢复 1/2,B 批的 3 不动
    const r = rollbackBatch(db, batchA, NOW)
    assert.equal(r.notFound, false)
    assert.equal(r.restored, 2)
    assert.deepEqual(r.ids.sort((a, b) => a - b), [1, 2])
    assert.deepEqual(active(), [1, 2, 4], '回滚不许越界动别的批次')

    // 回滚留痕
    const rb = db.prepare(
      "SELECT user_input FROM audit_logs WHERE tool_call = 'memory_restore'").get()
    assert.ok(String(rb.user_input).includes('恢复 2 条'), rb.user_input)

    // 行没被物理删(归档/回滚都只是翻 is_active)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM episodic_memory').get().n, 4)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('F7 rollbackBatch:批次找不到时明确报 notFound(不静默成功)', () => {
  const { dir, db } = freshDb()
  try {
    const r = rollbackBatch(db, 'no-such-batch', NOW)
    assert.equal(r.notFound, true)
    assert.equal(r.restored, 0)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('F7 archiveBatch:审计 trace_id 带批次前缀(回滚就靠它索引)', () => {
  const { dir, db } = freshDb()
  try {
    db.prepare('INSERT INTO episodic_memory (memory_id, summary, is_active) VALUES (7,?,1)')
      .run('m7')
    const b = 'batch-x'
    archiveBatch(db, b, [{ id: 7, summary: 'm7' }], NOW)
    const r = db.prepare(
      "SELECT trace_id, tool_call FROM audit_logs WHERE tool_call = 'memory_cleanup'").get()
    assert.equal(r.trace_id, batchTracePrefix(b) + '7')
    assert.equal(r.trace_id, 'cleanup:batch-x:7')
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('F7 archiveBatch:坏行不炸整批', () => {
  const { dir, db } = freshDb()
  try {
    db.prepare('INSERT INTO episodic_memory (memory_id, summary, is_active) VALUES (9,?,1)')
      .run('m9')
    const res = archiveBatch(db, 'b2', [{ id: 9, summary: 'm9' }, { id: null }, {}, null], NOW)
    assert.equal(res.archived, 1)
    assert.equal(res.failed, 0)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

// ── 接线守卫 ───────────────────────────────────────────────────────────

test('F7 doctor 接线:守卫 + 批次 id + --rollback 都接上了', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../scripts/memory-doctor.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes("from '../lib/cleanup-guard.js'"), 'doctor 没接守卫模块')
  assert.ok(src.includes('planCleanup('), 'doctor 没走 planCleanup')
  assert.ok(src.includes('archiveBatch('), 'doctor 没走批次归档')
  assert.ok(src.includes('rollbackBatch('), 'doctor 没接回滚')
  assert.ok(src.includes("argv.indexOf('--rollback')"), '没有 --rollback 入口')
  // 旧的无条件归档写法必须消失
  assert.ok(!src.includes("const cleanTargets = [...out.selfReferential, ...out.hostInjection].filter"),
    '旧的无条件归档路径还在')
  // 审计里要带批次 id
  assert.ok(src.includes('批次 '), '审计文本里没有批次 id')
})
