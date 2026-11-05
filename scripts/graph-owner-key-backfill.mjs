#!/usr/bin/env node
/**
 * `graph_nodes.owner_key` 无主行的一次性回填 —— **默认 dry-run**(阶段 2d,2026-10-01)
 * ============================================================
 * 用法:
 *   node scripts/graph-owner-key-backfill.mjs                  # dry-run:只报「将改几行」(默认)
 *   node scripts/graph-owner-key-backfill.mjs --db <path>       # 指定库(也可用环境变量 ECHO_DB)
 *   node scripts/graph-owner-key-backfill.mjs --owner master    # 归属键(默认 master)
 *   node scripts/graph-owner-key-backfill.mjs --json            # 结构化结果(JSON 到 stdout)
 *   node scripts/graph-owner-key-backfill.mjs --apply           # 真写(需人类先裁决;本阶段**不跑**)
 *
 * 为什么要它:写入侧(`python/engine/graph.py` 的 `get_or_create_node`)此前 INSERT 列表里
 * **没有 `owner_key`** ⇒ 引擎现场新建的每个节点 `owner_key` 都是 NULL。阶段 2d 已把那条
 * INSERT 补上(`owner_key` 显式入参、默认 `"master"`),**新节点从此不再留 NULL**;
 * 但**老行**还欠一次回填 —— 而那属于"**改**"不属"**纯增**",所以要单独批准、单独跑。
 * 实测活库 28 个节点里 5 个 NULL:`音理` / `舞萌` / `计算机大类` /
 * `老乡鸡的梅菜扣肉` / `麦当劳随心配1+1`(含度数最高的桥节点 `音理`)。
 *
 * 五条硬约束(与 `scripts/graph-baseline.mjs`、`scripts/graph-receipts-report.mjs` 同一套纪律):
 *   ① **默认 dry-run**:不传 `--apply` 就一个字节都不写(只读打开 + 只报数);
 *   ② **只碰无主行**:SQL 里**写死**谓词 `owner_key IS NULL OR owner_key = ''`,
 *      **严禁全表覆盖**(有主的行一个都不许动);
 *   ③ **幂等**:回填完第二跑 0 行(谓词自身收敛,不靠记水位);
 *   ④ **绝不接进 `python/engine/db.py` 的 `connect()`**:不许有任何自动路径替她改数据 ——
 *      这是一次**人工点名跑**的脚本,不是迁移;
 *   ⑤ **只读打开用双保险**:`file:<abs>?mode=ro` URI + `readOnly: true`(dry-run 那趟),
 *      **故意不走 `lib/store.js` 的 `openStore()`** —— 它顺带做迁移(ALTER TABLE = 写库)。
 *
 * 口径:
 *   · 表/列不存在 ⇒ 报 `exists:false`,exit 0(老库不是错误);
 *   · dry-run 末尾比对库文件 sha256,并固定打印「本趟只读,未修改任何数据」;
 *   · `--apply` 走单事务,返回的 `changes` 就是**实际改几行**。
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const TABLE = 'graph_nodes'
export const DEFAULT_OWNER = 'master'

/**
 * 「只碰无主行」的那条谓词 —— **写死**,不许参数化、不许放宽。
 * 全表覆盖(`UPDATE ... SET owner_key = ?` 无 WHERE)是本脚本明令禁止的写法。
 */
export const ORPHAN_PREDICATE = "owner_key IS NULL OR owner_key = ''"

const SELECT_ORPHANS = 'SELECT node_id, name, node_type FROM ' + TABLE
  + ' WHERE (' + ORPHAN_PREDICATE + ') ORDER BY name'
const COUNT_ORPHANS = 'SELECT COUNT(*) AS n FROM ' + TABLE
  + ' WHERE (' + ORPHAN_PREDICATE + ')'
const COUNT_ALL = 'SELECT COUNT(*) AS n FROM ' + TABLE
const UPDATE_ORPHANS = 'UPDATE ' + TABLE + ' SET owner_key = ?'
  + ' WHERE (' + ORPHAN_PREDICATE + ')'

function sha256 (path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

function openReadOnly (dbPath) {
  const uri = 'file:' + resolve(dbPath).replace(/\\/g, '/') + '?mode=ro'
  return new DatabaseSync(uri, { readOnly: true })
}

function tableExists (db) {
  return !!db.prepare(
    "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(TABLE)
}

function schemaReady (db) {
  const cols = new Set(db.prepare('PRAGMA table_info(' + TABLE + ')').all()
    .map((r) => String(r.name)))
  return cols.has('node_id') && cols.has('name') && cols.has('owner_key')
}

/** 回填前的「读数」:总数 / 无主数 / 无主名单(名字 + 类型)。 */
function readBefore (db) {
  return {
    nodes: Number(db.prepare(COUNT_ALL).get().n),
    orphans: Number(db.prepare(COUNT_ORPHANS).get().n),
    orphanNames: db.prepare(SELECT_ORPHANS).all().map((r) => String(r.name))
  }
}

/**
 * dry-run:只读地算一遍"将改几行",并给出前后读数 + 库文件 sha256。
 * 纯函数式:不打印、不退出、**不写一个字节**。
 */
export function planBackfill (dbPath, { owner = DEFAULT_OWNER, now = () => Date.now() } = {}) {
  const startedAt = now()
  if (!existsSync(dbPath)) {
    return { ok: false, reason: 'db-not-found', apply: false, db: { path: dbPath }, readOnly: true }
  }
  const shaBefore = sha256(dbPath)
  const mtimeBefore = statSync(dbPath).mtimeMs
  const db = openReadOnly(dbPath)
  let report
  try {
    if (!tableExists(db)) {
      report = { ok: true, table: { name: TABLE, exists: false }, apply: false }
    } else if (!schemaReady(db)) {
      // 老库连 owner_key 列都还没有:那是迁移的事,不归这个脚本(不许自己 ALTER)
      report = { ok: true, table: { name: TABLE, exists: true, ownerKeyColumn: false }, apply: false }
    } else {
      const before = readBefore(db)
      const rows = db.prepare(SELECT_ORPHANS).all().map((r) => ({
        nodeId: String(r.node_id), name: String(r.name), nodeType: String(r.node_type || '')
      }))
      report = {
        ok: true,
        apply: false,
        table: { name: TABLE, exists: true, ownerKeyColumn: true },
        owner: String(owner),
        predicate: ORPHAN_PREDICATE,
        before,
        orphanRows: rows,
        // 「将改几行」= 谓词命中的行数;dry-run 的 `changes` 恒为 0(没写)
        planned: rows.length,
        changes: 0,
        // 回填后**预期**读数(纯推算,不落库)
        afterExpected: {
          nodes: before.nodes,
          orphans: 0,
          orphanNames: []
        },
        idempotentNote: '幂等:回填后再跑同一谓词 ⇒ planned = 0'
      }
    }
  } finally {
    db.close()
  }
  const shaAfter = sha256(dbPath)
  const mtimeAfter = statSync(dbPath).mtimeMs
  report.db = {
    path: resolve(dbPath),
    uri: 'file:' + resolve(dbPath).replace(/\\/g, '/') + '?mode=ro',
    readOnly: true,
    shaBefore,
    shaAfter,
    shaUnchanged: shaBefore !== null && shaBefore === shaAfter,
    mtimeBefore,
    mtimeAfter,
    mtimeUnchanged: mtimeBefore === mtimeAfter
  }
  report.elapsedMs = now() - startedAt
  return report
}

/**
 * `--apply`:真写。**单事务 + 写死谓词**,返回「实际改几行」。
 *
 * 本阶段**不跑**它 —— 往她真库写要等人类裁决。留在这里是为了让"将来那一次"是
 * 同一条路径(而不是有人手敲 UPDATE)。
 */
export function applyBackfill (dbPath, { owner = DEFAULT_OWNER, now = () => Date.now() } = {}) {
  const startedAt = now()
  if (!existsSync(dbPath)) {
    return { ok: false, reason: 'db-not-found', apply: true, db: { path: dbPath } }
  }
  const shaBefore = sha256(dbPath)
  const mtimeBefore = statSync(dbPath).mtimeMs
  // --apply 必须可写 ⇒ 不用 mode=ro(但谓词一样写死)
  const db = new DatabaseSync(resolve(dbPath))
  let report
  try {
    if (!tableExists(db) || !schemaReady(db)) {
      report = { ok: false, reason: 'schema-not-ready', apply: true, changes: 0 }
    } else {
      const before = readBefore(db)
      const rows = db.prepare(SELECT_ORPHANS).all().map((r) => ({
        nodeId: String(r.node_id), name: String(r.name), nodeType: String(r.node_type || '')
      }))
      let changes = 0
      db.exec('BEGIN IMMEDIATE')
      try {
        const res = db.prepare(UPDATE_ORPHANS).run(String(owner))
        changes = Number(res.changes || 0)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      const after = readBefore(db)
      report = {
        ok: true,
        apply: true,
        table: { name: TABLE, exists: true, ownerKeyColumn: true },
        owner: String(owner),
        predicate: ORPHAN_PREDICATE,
        before,
        orphanRows: rows,
        planned: rows.length,
        changes,
        after,
        idempotent: after.orphans === 0
      }
    }
  } finally {
    db.close()
  }
  const shaAfter = sha256(dbPath)
  const mtimeAfter = statSync(dbPath).mtimeMs
  report.db = {
    path: resolve(dbPath),
    readOnly: false,
    shaBefore,
    shaAfter,
    shaUnchanged: shaBefore !== null && shaBefore === shaAfter,
    mtimeBefore,
    mtimeAfter,
    mtimeUnchanged: mtimeBefore === mtimeAfter
  }
  report.elapsedMs = now() - startedAt
  return report
}

/** 人类可读(数组 join,方便单测直接断言字符串)。 */
export function renderBackfill (report) {
  const L = []
  const say = (s = '') => L.push(s)
  if (!report.ok) {
    say('回填跳过:' + report.reason + '(' + (report.db && report.db.path) + ')')
    return L.join('\n')
  }
  const t = report.table || {}
  say('graph_nodes.owner_key 无主行回填 —— ' + (report.apply ? 'APPLY(真写)' : 'DRY-RUN(只读)'))
  if (t.exists === false) {
    say('  表不存在(老库 / 还没迁移):0 行。这不是错误。')
    return L.join('\n')
  }
  if (t.ownerKeyColumn === false) {
    say('  没有 owner_key 列 —— 那是迁移的事,不归这个脚本(它不 ALTER)。')
    return L.join('\n')
  }
  say('  谓词(写死): ' + report.predicate)
  say('  归属键: ' + report.owner)
  say('  回填前读数:节点总数=' + report.before.nodes
    + ';无主行=' + report.before.orphans)
  say('  **将改 ' + report.planned + ' 行**;实际改 ' + report.changes + ' 行')
  if (report.planned > 0) {
    say('  无主行名单(' + report.planned + '):')
    for (const r of report.orphanRows) {
      say('    ' + r.name + '  [' + (r.nodeType || '?') + ']  ' + r.nodeId)
    }
  }
  if (report.apply) {
    say('  回填后读数:节点总数=' + report.after.nodes
      + ';无主行=' + report.after.orphans
      + (report.idempotent ? '(幂等:再跑将改 0 行)' : '(! 还有残留)'))
  } else {
    say('  回填后**预期**读数:节点总数=' + report.afterExpected.nodes
      + ';无主行=' + report.afterExpected.orphans + '(纯推算,未落库)')
    say('  幂等:回填后再跑同一谓词 ⇒ 将改 0 行')
  }
  say('  库文件 sha256: 前=' + String(report.db.shaBefore).slice(0, 16)
    + ' 后=' + String(report.db.shaAfter).slice(0, 16)
    + (report.db.shaUnchanged ? ' (一致)' : ' (!! 变了)'))
  if (!report.apply) say('本趟只读,未修改任何数据')
  return L.join('\n')
}

function main (argv) {
  const has = (f) => argv.includes(f)
  const valOf = (f) => {
    const i = argv.indexOf(f)
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''
  }
  if (has('--help') || has('-h')) {
    console.log('用法: node scripts/graph-owner-key-backfill.mjs [--db <path>] [--owner <key>] [--json] [--apply]')
    console.log('  默认 dry-run;--apply 才写;只碰 owner_key IS NULL OR owner_key = \'\' 的行。')
    return 0
  }
  const dbPath = valOf('--db') || process.env.ECHO_DB
    || join(homedir(), '.dsh', 'echo', 'echo.db')
  const owner = valOf('--owner') || DEFAULT_OWNER
  const report = has('--apply')
    ? applyBackfill(dbPath, { owner })
    : planBackfill(dbPath, { owner })
  if (has('--json')) console.log(JSON.stringify(report, null, 2))
  else console.log(renderBackfill(report))
  return report.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
