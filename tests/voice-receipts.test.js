/**
 * 语音回执账(lib/voice-receipts.js)单测。
 *
 * 覆盖任务书 9 条 + 三条防呆(绝不抛错/回退链/源码钉子)。
 * 全程假 entry 注入 + 临时库(DatabaseSync 建在 mkdtemp 里),不碰真实 echo.db。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVoiceReceiptLedger, PER_SESSION_CAP, VOICE_RECEIPTS_FACE_SHAPE } from '../lib/voice-receipts.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 临时库账本:每个用例独立一份,跑完删目录。 */
function withLedger (opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-receipts-'))
  const db = new DatabaseSync(join(dir, 'echo.db'))
  const logs = []
  const ledger = createVoiceReceiptLedger(db, { log: (m) => logs.push(m), ...opts })
  return {
    db, ledger, logs,
    count () { return db.prepare('SELECT COUNT(*) AS n FROM voice_receipts').get().n },
    done () { try { db.close() } catch { /* 已关 */ } rmSync(dir, { recursive: true, force: true }) }
  }
}

const external = (over = {}) => ({
  kind: 'voice.external', session: 's1', at: 1789000000000, turnId: 's1#t1', segId: 0, seq: 3,
  character: '派蒙', style: 'normal', styleFallback: false, ...over
})

const interrupted = (over = {}) => ({
  kind: 'voice.interrupted', session: 's1', at: 1789000000100, generation: 4, reason: 'user-message',
  lastExternalSeq: 3, externalSeqs: [1, 2, 3], droppedSeqs: [4], lastExternalTurnId: 's1#t1', ...over
})

test('① 合法 voice.external 写入成功', () => {
  const t = withLedger()
  try {
    assert.equal(t.ledger.receive(external()), true)
    assert.equal(t.count(), 1)
    const [row] = t.db.prepare('SELECT * FROM voice_receipts').all()
    assert.equal(row.kind, 'voice.external')
    assert.equal(row.session, 's1')
    assert.equal(row.seq, 3)
    assert.equal(row.turn_id, 's1#t1')
    assert.equal(row.style_fallback, 0)
    assert.ok(row.created_at > 0)
    const list = t.ledger.getReceiptsBySession('s1')
    assert.equal(list.length, 1)
    assert.equal(list[0].styleFallback, false, '读回来是布尔(false 不是 0)')
  } finally { t.done() }
})

test('② 合法 voice.interrupted 写入成功(数组字段落 JSON 串)', () => {
  const t = withLedger()
  try {
    assert.equal(t.ledger.receive(interrupted()), true)
    assert.equal(t.count(), 1)
    const [row] = t.db.prepare('SELECT * FROM voice_receipts').all()
    assert.equal(row.kind, 'voice.interrupted')
    assert.equal(row.reason, 'user-message')
    assert.equal(row.last_external_seq, 3)
    assert.deepEqual(JSON.parse(row.external_seqs), [1, 2, 3])
    assert.deepEqual(JSON.parse(row.dropped_seqs), [4])
    const [got] = t.ledger.getRecentInterrupts('s1')
    assert.deepEqual(got.externalSeqs, [1, 2, 3])
    assert.deepEqual(got.droppedSeqs, [4])
  } finally { t.done() }
})

test('③ 非法 kind 被丢弃、不抛错', () => {
  const t = withLedger()
  try {
    assert.equal(t.ledger.receive({ ...external(), kind: 'voice.played' }), false)
    assert.equal(t.ledger.receive({ ...external(), kind: '' }), false)
    assert.equal(t.ledger.receive({ ...external(), kind: undefined }), false)
    assert.equal(t.count(), 0)
    assert.equal(t.logs.length, 3, '每条坏输入都留了日志')
  } finally { t.done() }
})

test('④ 缺字段的 entry 被丢弃、不抛错', () => {
  const t = withLedger()
  try {
    assert.equal(t.ledger.receive({ ...external(), seq: undefined }), false, 'external 缺 seq')
    assert.equal(t.ledger.receive({ ...external(), session: '' }), false, '缺 session')
    assert.equal(t.ledger.receive({ ...external(), at: NaN }), false, 'at 非有限数')
    assert.equal(t.ledger.receive({ ...interrupted(), reason: undefined }), false, 'interrupted 缺 reason')
    assert.equal(t.ledger.receive({ ...interrupted(), reason: 'whatever' }), false, 'reason 不在枚举')
    assert.equal(t.count(), 0)
  } finally { t.done() }
})

test('⑤ getLastExternalSeq 返回正确值', () => {
  const t = withLedger()
  try {
    assert.equal(t.ledger.getLastExternalSeq('s1'), null, '还没有回执时是 null')
    t.ledger.receive(external({ seq: 3 }))
    assert.equal(t.ledger.getLastExternalSeq('s1'), 3)
    t.ledger.receive(external({ seq: 4, at: 1789000000001 }))
    assert.equal(t.ledger.getLastExternalSeq('s1'), 4)
  } finally { t.done() }
})

test('⑥ getRecentInterrupts 按时间倒序', () => {
  const t = withLedger()
  try {
    t.ledger.receive(interrupted({ at: 300, reason: 'user-message' }))
    t.ledger.receive(interrupted({ at: 100, reason: 'client-cancel' }))
    t.ledger.receive(interrupted({ at: 200, reason: 'browser-stop' }))
    const got = t.ledger.getRecentInterrupts('s1', 2)
    assert.equal(got.length, 2)
    assert.equal(got[0].at, 300, '最新在前')
    assert.equal(got[1].at, 200)
    assert.equal(got[0].reason, 'user-message')
    assert.equal(got[1].reason, 'browser-stop')
  } finally { t.done() }
})

test('⑦ 数据保留:超过上限滚动删除最旧(默认上限 500)', () => {
  assert.equal(PER_SESSION_CAP, 500, '每会话上限钉死 500')
  const t = withLedger({ perSessionCap: 5 })
  try {
    for (let i = 1; i <= 8; i += 1) {
      assert.equal(t.ledger.receive(external({ seq: i, at: 1000 + i })), true)
    }
    assert.equal(t.count(), 5, '滚动删到上限')
    const seqs = t.db.prepare('SELECT seq FROM voice_receipts ORDER BY at').all().map((r) => r.seq)
    assert.deepEqual(seqs, [4, 5, 6, 7, 8], '最旧的 1~3 被删')
  } finally { t.done() }
})

test('⑧ 同一 session 多条 external 时 lastExternalSeq 取最大值(乱序到达也对)', () => {
  const t = withLedger()
  try {
    for (const seq of [3, 7, 5]) t.ledger.receive(external({ seq, at: 1000 + seq }))
    assert.equal(t.ledger.getLastExternalSeq('s1'), 7)
  } finally { t.done() }
})

test('⑨ 空 session 查询不抛错、返回空', () => {
  const t = withLedger()
  try {
    assert.deepEqual(t.ledger.getReceiptsBySession('nobody'), [])
    assert.deepEqual(t.ledger.getRecentInterrupts('nobody'), [])
    assert.deepEqual(t.ledger.getStyleHistory('nobody'), [])
    assert.equal(t.ledger.getLastExternalSeq('nobody'), null)
    // 传 null/空串也不许抛
    assert.deepEqual(t.ledger.getReceiptsBySession(null), [])
    assert.equal(t.ledger.getLastExternalSeq(''), null)
  } finally { t.done() }
})

// ---- 防呆三条(任务书之外,契约钉住)------------------------------------

test('⑩ 绝不抛错:垃圾输入/库炸了都只是丢弃', () => {
  const t = withLedger()
  try {
    for (const junk of [null, undefined, 42, 'hi', [], {}, { kind: 'voice.external' }]) {
      assert.equal(t.ledger.receive(junk), false, JSON.stringify(junk))
    }
    assert.equal(t.count(), 0)
  } finally { t.done() }
  // 库一落地就炸:建个表再把库关了,写入路径全兜住
  const dead = withLedger()
  dead.ledger.receive(external())
  dead.db.close()
  assert.equal(dead.ledger.receive(external({ seq: 9, at: 2 })), false, '写库失败也返回 false')
  assert.equal(dead.ledger.getLastExternalSeq('s1') !== undefined, true)
  assert.deepEqual(dead.ledger.getReceiptsBySession('s1'), [])
  const face = dead.ledger.statusFace()
  assert.ok(face === null || typeof face === 'object')
  dead.done()
})

test('⑪ getStyleHistory:取 external 的实际样式,倒序(供「语气不对」排查)', () => {
  const t = withLedger()
  try {
    t.ledger.receive(external({ seq: 1, at: 10, style: 'normal', styleFallback: false }))
    t.ledger.receive(external({ seq: 2, at: 20, style: 'cozy', styleFallback: true }))
    t.ledger.receive(interrupted({ at: 30 }))
    const got = t.ledger.getStyleHistory('s1')
    assert.equal(got.length, 2, 'interrupted 不算 style')
    assert.deepEqual(got[0], { seq: 2, style: 'cozy', styleFallback: true, at: 20 })
    assert.equal(got[1].styleFallback, false)
  } finally { t.done() }
})

test('⑫ 源码钉子:index.js 桥接一行 + echo_status 声明与形状夹具都在', () => {
  const src = readFileSync(join(ROOT, 'lib/index.js'), 'utf8')
  assert.ok(src.includes('registerVoiceReceipt: (entry) => voiceReceiptLedger.receive(entry)'),
    'provide 字面量里必须是那一行桥接(不许改成别的形态)')
  assert.ok(src.includes('voiceReceipts: safeVoiceReceiptsFace()'), 'statusPayload 必须带 voiceReceipts 键')
  assert.ok(src.includes('voiceReceipts: {'), 'echo_status schema 必须声明 voiceReceipts(additionalProperties:false 的坑)')
  assert.ok(src.includes("face: 'voiceReceipts'"), '离线对拍夹具 statusShapes 必须带 voiceReceipts 面')
  const speak = readFileSync(join(ROOT, 'lib/speak.js'), 'utf8')
  assert.ok(speak.includes("'registerVoiceReceipt'"), '能力清单必须报 registerVoiceReceipt(判定以能力名为准)')
  // 形状夹具必须"非空且可空字段两种都带",否则声明错类型检不出来
  assert.equal(VOICE_RECEIPTS_FACE_SHAPE.recent.length, 2)
  assert.equal(VOICE_RECEIPTS_FACE_SHAPE.recent[0].reason, null)
  assert.equal(VOICE_RECEIPTS_FACE_SHAPE.recent[1].seq, null)
})

test('⑬ 回退链:external 行被滚动删光后,lastExternalSeq 从打断痕补', () => {
  const t = withLedger({ perSessionCap: 2 })
  try {
    t.ledger.receive(external({ seq: 5, at: 10 }))
    t.ledger.receive(interrupted({ at: 20, lastExternalSeq: 5 }))
    // 再来两条新 external 把 seq:5 的行滚掉
    t.ledger.receive(external({ seq: 6, at: 30 }))
    t.ledger.receive(external({ seq: 7, at: 40 }))
    assert.equal(t.ledger.getLastExternalSeq('s1'), 7, '正常时是 MAX(seq)')
    // 只留打断痕的库(全新一份)
    const s = withLedger()
    s.ledger.receive(interrupted({ at: 1, lastExternalSeq: 5 }))
    assert.equal(s.ledger.getLastExternalSeq('s1'), 5, 'external 行没了,从痕里补')
    s.done()
  } finally { t.done() }
})
