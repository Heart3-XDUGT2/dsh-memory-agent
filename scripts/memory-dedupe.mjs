#!/usr/bin/env node
/**
 * 记忆去重清理(M3)
 * ============================================================
 * 用法:
 *   node scripts/memory-dedupe.mjs                          # dry-run:列重复组(默认)
 *   node scripts/memory-dedupe.mjs --report docs/MEMORY_DEDUPE_REVIEW.md
 *   node scripts/memory-dedupe.mjs --apply                  # 落库:旧行让位
 *   node scripts/memory-dedupe.mjs --layer L0 --apply        # 只收拾某一层
 *   node scripts/memory-dedupe.mjs --survivor recent --json  # 换 survivor 规则/机器读
 *
 * 判据在 `lib/memory-dedupe.js`(权威在 python/engine/dedupe.py,写入闸用
 * 的就是它):同层 + (摘要双字重合 ≥ 0.7 或 (关键词 Jaccard ≥ 0.6 且摘要
 * 重合 ≥ 0.35)),「只在数字上不同」的句子**不算**重复。
 *
 * 让位不删除:旧行 `is_active=0 + superseded_by=survivor`
 * (`/api/echo/memories?state=forgotten` 仍翻得到 —— 「她以前以为…」是历史)。
 * survivor 规则默认 `value`(I 最高优先,长期价值优先);`recent` = 最近优先。
 */
import { existsSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findDuplicateGroups, DEDUPE_DEFAULTS } from '../lib/memory-dedupe.js'
import { openStore } from '../lib/store.js'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const asJson = argv.includes('--json')
const opt = (name, dflt) => {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt
}
const reportPath = opt('--report', '')
const layerFilter = opt('--layer', '')
const survivorRule = opt('--survivor', 'value')
const num = (v, dflt) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : dflt
}

const dbPath = process.env.ECHO_DB ?? join(homedir(), '.dsh', 'echo', 'echo.db')
if (!existsSync(dbPath)) {
  console.error('库不存在: ' + dbPath)
  process.exit(1)
}
// 走 openStore:任何 schema 迁移都在打开时补齐(写入脚本必须能自愈,
// 不能要求插件先启动过一次)。
const store = openStore(dbPath)
const db = store.db
const now = Date.now() / 1000

const rows = db.prepare(
  'SELECT memory_id AS memoryId, user_id AS userId, summary, keywords, layer, status,' +
  ' intrinsic_value AS intrinsicValue, emotion_score AS emotionScore, learned_at AS learnedAt,' +
  ' recall_count AS recallCount, source, half_life AS halfLife, last_recalled AS lastRecalled' +
  " FROM episodic_memory WHERE is_active = 1 AND status IN ('active','quarantined')"
).all().filter((r) => layerFilter === '' || String(r.layer || '') === layerFilter)

const groups = findDuplicateGroups(rows, {
  kwThreshold: num(process.env.ECHO_DEDUPE_KW, DEDUPE_DEFAULTS.kwThreshold),
  summaryThreshold: num(process.env.ECHO_DEDUPE_SUM, DEDUPE_DEFAULTS.summaryThreshold),
  summaryFloor: num(process.env.ECHO_DEDUPE_FLOOR, DEDUPE_DEFAULTS.summaryFloor),
  survivorRule
})

const yieldable = groups.reduce((a, g) => a + g.losers.length, 0)
const byLayer = {}
for (const g of groups) {
  const k = String(g.survivor.layer || '(空)')
  byLayer[k] = byLayer[k] || { groups: 0, rows: 0 }
  byLayer[k].groups += 1
  byLayer[k].rows += g.losers.length
}

if (reportPath !== '') {
  const L = []
  L.push('# 记忆去重清单(M3)')
  L.push('')
  L.push('> 由 `scripts/memory-dedupe.mjs --report` 生成。判定:同层 + 摘要双字重合 ≥ '
    + DEDUPE_DEFAULTS.summaryThreshold + ' 或 (关键词 Jaccard ≥ ' + DEDUPE_DEFAULTS.kwThreshold
    + ' 且摘要重合 ≥ ' + DEDUPE_DEFAULTS.summaryFloor + ');「只在数字上不同」不算重复。')
  L.push('> survivor 规则:`' + survivorRule + '`。**不删行** —— 旧行只让位(`is_active=0`)。')
  L.push('')
  L.push('现役记忆 ' + rows.length + ' 条 → 重复组 ' + groups.length + ' 组,可让位 ' + yieldable + ' 行。')
  L.push('')
  L.push('| 层 | 组 | 可让位行 |')
  L.push('|---|---|---|')
  for (const [k, v] of Object.entries(byLayer)) L.push('| ' + k + ' | ' + v.groups + ' | ' + v.rows + ' |')
  L.push('')
  for (const g of groups) {
    L.push('## 留 #' + g.survivor.memoryId + '(I=' + Math.round(g.survivor.intrinsicValue || 0)
      + ', ' + (g.survivor.layer || '空层') + ')')
    L.push('- 留:' + g.survivor.summary)
    for (const l of g.losers) {
      L.push('- 让 #' + l.memoryId + '(I=' + Math.round(l.intrinsicValue || 0) + '):' + l.summary)
    }
    L.push('')
  }
  writeFileSync(reportPath, L.join('\n'), 'utf8')
  console.log('清单已写: ' + reportPath)
}

if (asJson) {
  console.log(JSON.stringify({
    active: rows.length, groups: groups.length, yieldable, byLayer,
    plan: groups.map((g) => ({
      survivor: g.survivor.memoryId,
      losers: g.losers.map((l) => l.memoryId),
      layer: g.survivor.layer || ''
    }))
  }, null, 2))
  db.close()
  process.exit(0)
}

if (!apply) {
  console.log('现役记忆 ' + rows.length + ' 条;重复组 ' + groups.length + ' 组,可让位 ' + yieldable + ' 行')
  for (const g of groups.slice(0, 12)) {
    console.log('  留 #' + g.survivor.memoryId + ' 「' + String(g.survivor.summary).slice(0, 34) + '」')
    for (const l of g.losers) console.log('    让 #' + l.memoryId + ' 「' + String(l.summary).slice(0, 34) + '」')
  }
  if (groups.length > 12) console.log('  …还有 ' + (groups.length - 12) + ' 组(--json 看全)')
  console.log('\n[dry-run] 没写库。加 --apply 落库(旧行让位,不删)。')
  db.close()
  process.exit(0)
}

let moved = 0
for (const g of groups) {
  const survivorId = Number(g.survivor.memoryId)
  for (const l of g.losers) {
    const r = db.prepare(
      'UPDATE episodic_memory SET is_active = 0, superseded_by = ? WHERE memory_id = ? AND is_active = 1'
    ).run(survivorId, Number(l.memoryId))
    moved += Number(r?.changes ?? 0)
  }
}
try {
  db.prepare(
    'INSERT INTO audit_logs (trace_id, session_id, user_key, is_master, user_input, tool_call, timestamp)' +
    ' VALUES (?, ?, ?, 1, ?, ?, ?)'
  ).run(randomUUID(), 'global', 'master',
    '记忆去重: ' + groups.length + ' 组 / 让位 ' + moved + ' 行(survivor 规则 ' + survivorRule + ')',
    'memory_dedupe', now)
} catch { /* 审计写不进不该让清理失败 */ }
console.log('已让位 ' + moved + ' 行(重复组 ' + groups.length + ' 组)+ 1 行审计。')
db.close()
