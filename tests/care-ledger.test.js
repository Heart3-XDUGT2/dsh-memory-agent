/**
 * 主动性 v2 · P2 台账电池:`care_beats` 的四个新读数 + `pending_threads`
 * 的两列打分缓存(2026-09-30,施工图 `${docs/PLAN_PROACTIVE_TOPIC_SCORER_CODE.md}` §2.4)。
 *
 * 这一批保护的是「**为什么没开口**」这件事能不能被事后回答:
 *   · `candidates` / `top_score` —— 这一拍组了几个候选、最高分多少(可 GROUP BY);
 *   · `rejected_by` —— **归因**:`local`(本地分没过)/ `review`(复核没过);
 *   · `topic_id` —— 那条候选是谁(`thread:19` / `mem:7` / `diary:2026-09-30`)。
 *
 * 三条纪律(施工图 §3.5 卫生纪律 8/9):
 *   ① 老的 `value` / `threshold` 两列**语义不动**(想念值 × 引擎阈值)—— 新分数
 *      另走 `top_score`,同行双读数、互不污染(`tests/care-beats.test.js:128-129`
 *      仍钉着 `8.2/5.5`);
 *   ② 旧数据**只读**:老库只 `ALTER TABLE ADD COLUMN`(全部 DEFAULT),不删列、
 *      不重建表 —— 老拍读出来是 `0/0/''/''` = "这一拍没有打分读数";
 *   ③ `pending_threads` 是 **JS/引擎共有表**,两列必须两侧同源
 *      (`test_ddl_parity.py` 的 superset 闸;这边只测 JS 侧的形状与幂等)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, MASTER_ID } from '../lib/store.js'

function freshStore () {
  return openStore(':memory:')
}

// ---- ① 四个新列:写得进、读得出(经 mapBeat 透出,驼峰键)-------------------

test('P2 台账:四个新读数写得进、mapBeat 透得出(candidates/topScore/rejectedBy/topicId)', () => {
  const store = freshStore()
  try {
    const id = store.careBeatAdd({
      at: 1790611622, kind: 'care', reason: 'no-topic', value: 3.2, threshold: 5.5,
      candidates: 7, topScore: 0.4213, rejectedBy: 'local', topicId: 'thread:19'
    })
    assert.ok(id > 0)
    const row = store.careBeatsSince(0, 10)[0]
    assert.equal(row.reason, 'no-topic')
    assert.equal(row.candidates, 7)
    assert.equal(row.topScore, 0.4213)
    assert.equal(row.rejectedBy, 'local')
    assert.equal(row.topicId, 'thread:19')
    // 老两列照旧同行双读数(新分数不许顶掉想念值)
    assert.equal(row.value, 3.2, 'value 仍是引擎想念值')
    assert.equal(row.threshold, 5.5)
  } finally { store.close() }
})

test('P2 台账:不传新读数时是 0/0/空串 —— 等于"这一拍没有打分读数",不是"打了 0 分"', () => {
  const store = freshStore()
  try {
    store.careBeatAdd({ at: 1, kind: 'care', reason: 'sent', acted: true })
    const row = store.careBeatsSince(0, 10)[0]
    assert.equal(row.candidates, 0)
    assert.equal(row.topScore, 0)
    assert.equal(row.rejectedBy, '')
    assert.equal(row.topicId, '')
  } finally { store.close() }
})

test('P2 台账:坏输入不许写进库(NaN / 负数候选 / 对象被 String 化)', () => {
  const store = freshStore()
  try {
    store.careBeatAdd({
      at: 1, kind: 'care', reason: 'no-topic',
      candidates: Number.NaN, topScore: Number.NaN, rejectedBy: null, topicId: undefined
    })
    const row = store.careBeatsSince(0, 10)[0]
    assert.equal(row.candidates, 0, 'NaN 候选数 ⇒ 0(不许写 NULL 进 INTEGER 列)')
    assert.equal(row.topScore, 0, 'NaN 分数 ⇒ 0')
    assert.equal(row.rejectedBy, '', 'null ⇒ 空串')
    assert.equal(row.topicId, '')
    store.careBeatAdd({ at: 2, kind: 'care', reason: 'no-topic', candidates: -3, topScore: 'abc' })
    const row2 = store.careBeatsSince(0, 10)[0]
    assert.equal(row2.candidates, 0, '负数候选 ⇒ 0')
    assert.equal(row2.topScore, 0, '认不出的分数 ⇒ 0')
  } finally { store.close() }
})

test('P2 台账:旧行(value/threshold 那种)读出来也带这四个键(缺列不崩)', () => {
  const store = freshStore()
  try {
    // 直接按**老列集**插一行(模拟迁移前写下的拍)
    store.db.prepare(
      "INSERT INTO care_beats (at, kind, reason, value, threshold) VALUES (1, 'care', 'engine-says-no', 3.1, 5.5)"
    ).run()
    const row = store.careBeatsSince(0, 10)[0]
    assert.equal(row.value, 3.1)
    assert.equal(row.candidates, 0, '老拍没有候选数 ⇒ 0(不是 undefined)')
    assert.equal(row.rejectedBy, '')
    assert.equal(row.topicId, '')
  } finally { store.close() }
})

// ---- ② 归因:rejected_by 说清是本地判掉还是复核判掉 ------------------------

test('P2 台账:rejected_by 归因 —— local / review 两种落点都要在账上分得清', () => {
  const store = freshStore()
  try {
    store.careBeatAdd({ at: 10, kind: 'care', reason: 'no-topic', candidates: 3, topScore: 0.11, rejectedBy: 'local' })
    store.careBeatAdd({ at: 20, kind: 'care', reason: 'no-topic-after-review', candidates: 5, topScore: 0.57, rejectedBy: 'review' })
    const rows = store.careBeatsSince(0, 10)
    assert.deepEqual(rows.map((r) => r.rejectedBy), ['review', 'local'], '新的在前')
    assert.deepEqual(rows.map((r) => r.reason), ['no-topic-after-review', 'no-topic'])
    // 复核通过并开口那一拍:reason 仍是 sent,payload 记 reviewed
    store.careBeatAdd({
      at: 30, kind: 'care', reason: 'sent', acted: true,
      candidates: 6, topScore: 0.62, topicId: 'mem:7',
      payload: { reviewed: true, topScore: 0.62 }
    })
    const top = store.careBeatsSince(0, 10)[0]
    assert.equal(top.reason, 'sent', '复核通过**不新增 reason** —— 开口就是 sent')
    assert.equal(top.payload.reviewed, true, '复核过没过要看 payload.reviewed')
    assert.equal(top.topicId, 'mem:7')
  } finally { store.close() }
})

// ---- ③ 老库幂等补列(只加不删不重建)----------------------------------------

test('P2 台账:老库(没有那四列)打开时幂等补上,老行照旧在、读出来是默认值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-ledger-'))
  const file = join(dir, 'old.db')
  try {
    const old = openStore(file)
    // 造一张"老形状"的表:把 P2 新列摘掉(sqlite 3.35+ 支持 DROP COLUMN)
    for (const col of ['candidates', 'top_score', 'rejected_by', 'topic_id']) {
      old.db.exec(`ALTER TABLE care_beats DROP COLUMN ${col}`)
    }
    old.db.prepare("INSERT INTO care_beats (at, kind, reason, value, threshold) VALUES (1, 'care', 'sent', 8.2, 5.5)").run()
    old.close()
    const again = openStore(file) // 打开即迁移
    try {
      const cols = again.db.prepare('PRAGMA table_info(care_beats)').all().map((r) => r.name)
      for (const col of ['candidates', 'top_score', 'rejected_by', 'topic_id']) {
        assert.ok(cols.includes(col), '老库该被补列:' + col)
      }
      const rows = again.careBeatsSince(0, 10)
      assert.equal(rows.length, 1, '老拍还在(补列不是重建表)')
      assert.equal(rows[0].value, 8.2, '老读数一个字没动')
      assert.equal(rows[0].candidates, 0)
      assert.equal(rows[0].rejectedBy, '')
      // 补完列之后新拍能正常写
      assert.ok(again.careBeatAdd({ at: 2, kind: 'care', reason: 'no-topic', candidates: 4, rejectedBy: 'local' }) > 0)
    } finally { again.close() } // Windows 上文件被占着删不掉
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---- ④ pending_threads 的两列(共有表 JS 侧)--------------------------------

test('P2 台账:pending_threads 带上 score/score_at 两列(共有表两侧同源)', () => {
  const store = freshStore()
  try {
    const cols = store.db.prepare('PRAGMA table_info(pending_threads)').all().map((r) => r.name)
    assert.ok(cols.includes('score'), 'pending_threads 该有 score 列')
    assert.ok(cols.includes('score_at'), 'pending_threads 该有 score_at 列')
    // 老行(不写这两列)读出来是 0 —— DEFAULT 兜住
    store.db.prepare(
      'INSERT INTO pending_threads (user_id, content, status, follow_up_after, created_at)'
      + " VALUES (?, '今晚十点的火车', 'open', 0, 1)"
    ).run(MASTER_ID)
    const row = store.db.prepare('SELECT score, score_at FROM pending_threads LIMIT 1').get()
    assert.equal(row.score, 0)
    assert.equal(row.score_at, 0)
  } finally { store.close() }
})

test('P2 台账:pending_threads 老库(没有那两列)打开时幂等补上', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-threads-'))
  const file = join(dir, 'old.db')
  try {
    const old = openStore(file)
    for (const col of ['score', 'score_at']) old.db.exec(`ALTER TABLE pending_threads DROP COLUMN ${col}`)
    old.db.prepare(
      'INSERT INTO pending_threads (user_id, content, status, follow_up_after, created_at)'
      + " VALUES (?, '旧的悬置话题', 'open', 0, 1)"
    ).run(MASTER_ID)
    old.close()
    const again = openStore(file)
    try {
      const cols = again.db.prepare('PRAGMA table_info(pending_threads)').all().map((r) => r.name)
      assert.ok(cols.includes('score'))
      assert.ok(cols.includes('score_at'))
      const n = again.db.prepare('SELECT COUNT(*) AS n FROM pending_threads').get().n
      assert.equal(Number(n), 1, '老话题还在(只加列不重建)')
    } finally { again.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
