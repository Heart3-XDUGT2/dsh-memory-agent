/**
 * 流水表清理(2026-09-29 他的担心:「每次对话都产生一个子代理,时间长了会不会卡」)。
 *
 * 复查结论:子代理**用完即弃** —— `runStructured` 每次都 `finally { await run.dispose() }`
 * (`lib/reflect.js:224-226`),宿主侧也 dispose 掉 activation,所以它们不会攒。
 * 真正随时间**线性长**的是这几张行流水:`care_beats` 每拍一行(实测 10.3 小时 153 行),
 * 而它在这次修复之前**全仓一个 DELETE 都没有**(只有 INSERT + 给 care-report 的 SELECT)。
 *
 * 这个电池钉两件事:
 *   ① 老的清掉、保留期内的留着(幂等:第二遍不再删);
 *   ② **在途的话一条都不许删** —— `relay_outbox` 里 `acked_at = 0 且 dropped_at = 0`
 *      是「还没送出去的话」,删了就是丢话(代价不对称:多留一行只占几十字节)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../lib/store.js'

const NOW = 1790611622 // 2026-09-29 00:07(本机实测时刻,纯数字,测试不依赖真实时钟)
const DAY = 86400

function freshStore () {
  return openStore(join(mkdtempSync(join(tmpdir(), 'echo-prune-')), 'soul.db'))
}

const beatStmt = (s) => s.db.prepare(
  'INSERT INTO care_beats (at, kind, reason, value, threshold, should_act, acted, session_id, trace_id)'
  + ' VALUES (?,?,?,?,?,?,?,?,?)'
)

test('care_beats:老行清掉、保留期内的留着', () => {
  const s = freshStore()
  try {
    beatStmt(s).run(NOW - 40 * DAY, 'care', 'threshold', 5.0, 5.25, 0, 0, 'sess', 't-40')
    beatStmt(s).run(NOW - 31 * DAY, 'care', 'threshold', 5.1, 5.25, 0, 0, 'sess', 't-31')
    beatStmt(s).run(NOW - 1 * DAY, 'care', 'night-hold', 5.6, 5.25, 0, 0, 'sess', 't-new')
    assert.equal(s.pruneCareBeats({ now: NOW, keepDays: 30 }), 2, '40 天前与 31 天前那两条该走')
    const left = s.db.prepare('SELECT trace_id FROM care_beats').all().map((r) => r.trace_id)
    assert.deepEqual(left, ['t-new'], '近期那条必须还在(翻历史还要用)')
  } finally { s.close() }
})

test('relay_outbox:只清已落定(acked/dropped)的老行,在途的一条都不许动', () => {
  const s = freshStore()
  try {
    const ins = s.db.prepare(
      'INSERT INTO relay_outbox (platform, chat_id, session_id, turn_id, kind, text, created_at,'
      + ' expires_at, leased_until, acked_at, dropped_at, not_before) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    ins.run('qq', '1', 'sess', 't-acked', 'reply', '老的:已回执', NOW - 40 * DAY, 0, 0, NOW - 40 * DAY, 0, 0)
    ins.run('qq', '1', 'sess', 't-dropped', 'proactive', '老的:已丢弃(过期)', NOW - 40 * DAY, 0, 0, 0, NOW - 40 * DAY, 0)
    ins.run('qq', '1', 'sess', 't-pending', 'proactive', '**还没送出去的话**', NOW - 40 * DAY, 0, 0, 0, 0, 0)
    ins.run('qq', '1', 'sess', 't-fresh', 'reply', '刚回执的', NOW - 1 * DAY, 0, 0, NOW - 1 * DAY, 0, 0)
    assert.equal(s.pruneRelayOutbox({ now: NOW, keepDays: 30 }), 2, '两条已落定的老行该走')
    const left = s.db.prepare('SELECT turn_id FROM relay_outbox ORDER BY turn_id').all().map((r) => r.turn_id)
    assert.deepEqual(left, ['t-fresh', 't-pending'], '**没回执的那条必须还在** + 近期那条也在')
  } finally { s.close() }
})

test('清理幂等:同一时刻再跑一遍不再删', () => {
  const s = freshStore()
  try {
    beatStmt(s).run(NOW - 40 * DAY, 'care', 'threshold', 5.0, 5.25, 0, 0, 'sess', 'x')
    assert.equal(s.pruneCareBeats({ now: NOW, keepDays: 30 }), 1)
    assert.equal(s.pruneCareBeats({ now: NOW, keepDays: 30 }), 0, '第二遍没有可删的')
    assert.equal(s.pruneRelayOutbox({ now: NOW, keepDays: 30 }), 0, '空表也不许抛')
  } finally { s.close() }
})
