#!/usr/bin/env node
/**
 * 闸门真值回执的**行数报表**(阶段 1b 裁决②) —— 只读、量化增长
 * ============================================================
 * 用法:
 *   node scripts/graph-receipts-report.mjs                # 人类可读(默认库:~/.dsh/echo/echo.db)
 *   node scripts/graph-receipts-report.mjs --db <path>    # 指定库(也可用环境变量 ECHO_DB)
 *   node scripts/graph-receipts-report.mjs --runs 20      # 最近 N 个 run_id 各自的行数(默认 10)
 *   node scripts/graph-receipts-report.mjs --json         # 结构化结果(JSON 到 stdout)
 *
 * 为什么有它:写入侧闸门(`python/engine/graph_gate.py`)每次丢边 / 改边 / 表外放行都会往
 * `graph_edge_receipts` 留一行。同一 `run_id` 幂等,但**跨 run_id 每次新增** ⇒ 表会长。
 * 裁决②明确"**本轮不自动清理**、先量化每次运行行数、增长失控再定保留期" —— 这个脚本就是
 * 那把尺子:让人**看得见**增长(总行数 / 按 action·reason 分组 / 最近 N 个 run 的行数),
 * 而不是等它悄悄撑大库。
 *
 * 三条硬约束(与 `scripts/graph-baseline.mjs` 同一套纪律):
 *   ① **只读**:`file:<abs>?mode=ro` URI + `readOnly: true` 双保险,连 `PRAGMA` 都不写;
 *      **故意不走 `lib/store.js` 的 openStore()** —— 它顺带做迁移(ALTER TABLE = 写库);
 *   ② **不做清理**:本脚本**只报数**,没有任何 DELETE / 保留期逻辑(要清理由人另批);
 *   ③ **不改既有文件**:本文件是纯新增,没有往 package.json 的 scripts 里加入口
 *      (`node scripts/graph-receipts-report.mjs` 直接可跑)。
 *
 * 口径:
 *   · 表不存在(老库 / 还没迁移)⇒ 报 `exists:false`,exit 0(空表不是错误);
 *   · `--runs N` 按 `run_id` 分组的**最近 N 组**排序(N 组内的行才是最近留下的;
 *     排序键 = 该组 `MAX(id)`,即"最后写的那一行",不是字符串排序);
 *   · 末尾比对库文件 mtime,并固定打印「本报表只读,未修改任何数据」。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const RECEIPTS_TABLE = 'graph_edge_receipts'
export const DEFAULT_RUNS = 10

/** 本地时间串(报表给人看;JSON 里同时给原始 epoch 秒)。 */
function localTime (epochSeconds) {
  const n = Number(epochSeconds)
  if (!Number.isFinite(n) || n <= 0) return null
  const d = new Date(n * 1000)
  const pad = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function groupCounts (rows, key) {
  const out = {}
  for (const r of rows) {
    const k = r[key] === null || r[key] === undefined ? '' : String(r[key])
    out[k] = (out[k] || 0) + 1
  }
  return out
}

/**
 * 只读地读一遍回执表,产出报表对象(纯函数:不打印、不退出)。
 *
 * `dbPath` 不存在 / 表不存在都**不抛**:报表本身不该因为库年轻而失败。
 */
export function buildReceiptsReport (dbPath, { runs = DEFAULT_RUNS } = {}) {
  if (!existsSync(dbPath)) {
    return { ok: false, reason: 'db-not-found', db: { path: dbPath }, readOnly: true }
  }
  const mtimeBefore = statSync(dbPath).mtimeMs
  const uri = 'file:' + resolve(dbPath).replace(/\\/g, '/') + '?mode=ro'
  const db = new DatabaseSync(uri, { readOnly: true })
  let report
  try {
    const exists = !!db.prepare(
      "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(RECEIPTS_TABLE)
    if (!exists) {
      report = {
        ok: true,
        table: { name: RECEIPTS_TABLE, exists: false, rows: 0, runIds: 0, notes: {} },
        byAction: {}, byReason: {}, runs: [], runsRequested: runs
      }
    } else {
      const rows = db.prepare(
        `SELECT id, run_id, created_at, kind, action, reason, rule_id, note FROM ${RECEIPTS_TABLE}`
      ).all()
      const group = db.prepare(
        `SELECT run_id AS runId, COUNT(*) AS rows, MIN(id) AS firstId, MAX(id) AS lastId,`
        + ` MIN(created_at) AS firstAt, MAX(created_at) AS lastAt`
        + ` FROM ${RECEIPTS_TABLE} GROUP BY run_id ORDER BY MAX(id) DESC LIMIT ?`
      ).all(Number(runs) > 0 ? Number(runs) : DEFAULT_RUNS)
      report = {
        ok: true,
        table: {
          name: RECEIPTS_TABLE,
          exists: true,
          rows: rows.length,
          runIds: new Set(rows.map((r) => String(r.run_id || ''))).size,
          notes: groupCounts(rows.filter((r) => String(r.note || '') !== ''), 'note'),
          internalErrors: rows.filter((r) => String(r.reason) === 'internal-error').length,
          tableMissPasses: rows.filter((r) => String(r.note).startsWith('rule-table-miss')).length,
          firstAt: rows.length ? Math.min(...rows.map((r) => Number(r.created_at) || 0)) : null,
          lastAt: rows.length ? Math.max(...rows.map((r) => Number(r.created_at) || 0)) : null
        },
        byAction: groupCounts(rows, 'action'),
        byReason: groupCounts(rows, 'reason'),
        runs: group.map((g) => ({
          runId: String(g.runId || ''),
          rows: Number(g.rows),
          firstId: Number(g.firstId),
          lastId: Number(g.lastId),
          firstAt: localTime(g.firstAt),
          lastAt: localTime(g.lastAt)
        })),
        runsRequested: Number(runs)
      }
    }
  } finally {
    db.close()
  }
  const mtimeAfter = statSync(dbPath).mtimeMs
  report.db = {
    path: resolve(dbPath),
    uri,
    readOnly: true,
    mtimeBefore,
    mtimeAfter,
    mtimeUnchanged: mtimeBefore === mtimeAfter
  }
  return report
}

/** 人类可读报表(数组 join,方便单测直接断言字符串)。 */
export function renderReport (report) {
  const L = []
  const say = (s = '') => L.push(s)
  if (!report.ok) {
    say('库不在: ' + report.db.path + '(报表只能读数,不会建库)')
    return L.join('\n')
  }
  const t = report.table
  say('回执行数报表(只读)—— 表 ' + t.name)
  if (!t.exists) {
    say('  表不存在(老库 / 还没迁移):0 行。这不是错误。')
  } else {
    say('  总行数 = ' + t.rows + ';不同 run_id = ' + t.runIds)
    if (t.firstAt || t.lastAt) {
      say('  时间跨度: ' + (localTime(t.firstAt) || '?') + ' → ' + (localTime(t.lastAt) || '?'))
    }
    say('  按 action:' + (Object.keys(report.byAction).length
      ? Object.entries(report.byAction).map(([k, v]) => `${k || '(空)'}=${v}`).join(' / ') : '(无)'))
    say('  按 reason:' + (Object.keys(report.byReason).length
      ? Object.entries(report.byReason).map(([k, v]) => `${k || '(空)'}=${v}`).join(' / ') : '(无)'))
    say('  闸门自身出错留痕(internal-error)= ' + t.internalErrors + ';表外放行留痕(rule-table-miss)= ' + t.tableMissPasses)
    say('  最近 ' + report.runs.length + ' 个 run_id(按最后写入行排序):')
    for (const r of report.runs) {
      say('    ' + (r.runId || '(空 run_id)') + '  行数=' + r.rows
        + '  id ' + r.firstId + '…' + r.lastId
        + '  ' + (r.firstAt || '?') + ' → ' + (r.lastAt || '?'))
    }
  }
  say('  保留策略:默认不清理(裁决②);本脚本只报数,不做任何删除')
  say('库文件 mtime: 前=' + report.db.mtimeBefore + ' 后=' + report.db.mtimeAfter
    + (report.db.mtimeUnchanged ? ' (未变)' : ' (!! 变了)'))
  say('本报表只读,未修改任何数据')
  return L.join('\n')
}

function main (argv) {
  const has = (f) => argv.includes(f)
  const valOf = (f) => {
    const i = argv.indexOf(f)
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''
  }
  if (has('--help') || has('-h')) {
    console.log('用法: node scripts/graph-receipts-report.mjs [--db <path>] [--runs N] [--json]')
    return 0
  }
  const dbPath = valOf('--db') || process.env.ECHO_DB
    || join(homedir(), '.dsh', 'echo', 'echo.db')
  const runs = Number(valOf('--runs') || DEFAULT_RUNS)
  if (!Number.isFinite(runs) || runs < 1) {
    console.error('--runs 要是 ≥1 的整数(收到:' + valOf('--runs') + ')')
    return 1
  }
  const report = buildReceiptsReport(dbPath, { runs })
  if (has('--json')) console.log(JSON.stringify(report, null, 2))
  else console.log(renderReport(report))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
