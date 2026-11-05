/**
 * R4 第七步:归档老链路(**改名,永不删除**)。
 * ==================================================================
 * 归档四样东西:A 侧两张库(`memory.db` / `state.db`,各自连同 `-wal`/`-shm`)
 * + 两份老插件配置(记忆中间件 51 项 / 状态机)—— 2026-09-26 他拍:「库 + 两份
 * 老配置,一个备份目录里存齐」。见 `docs/RETIRE_OLD_CHAIN_PLAN.md`。
 *
 * `docs/R4_ACCEPTANCE.md` 第四节原来写的是三条手敲的 `Rename-Item`。手敲这件事
 * 有三个坑:漏掉 `-wal`(那才是最近的写入)、改到一半失败留下半截状态、
 * 事后说不清「当时到底哪几个文件、多大、内容是不是这个」。
 *
 * 这个脚本把第七步变成一条命令,并且**默认什么也不做**:
 *
 *   node scripts/retire-a-side.mjs            # dry-run:列出会动哪些文件(默认)
 *   node scripts/retire-a-side.mjs --apply    # 先备份每个文件、再逐个改名
 *   node scripts/retire-a-side.mjs --apply --force   # 只覆盖已确认的写入/WAL信号
 *
 * 它守的四条:
 *   ① **默认 dry-run**:不 --apply 就不备份、不写清单、不改名;
 *      SQLite 的只读连接仍可能维护 `-shm` 共享内存索引;
 *   ② **备份先行**:改名之前把要动的每个文件(db/wal/shm + 两份配置)
 *      原样拷到 `~/.dsh/echo/backup/a-side-<时间戳>/`;
 *   ③ **写清单**:文件名/大小/mtime/sha256/行数 → `retired-a-side-<时间戳>.json`,
 *      改名前先落盘(半截失败也查得到原样),改完再补结果;
 *   ④ **A 侧还在写就拒签**:与 `r4-baseline.json` 逐表比,行数涨了说明老插件
 *      还在写 —— 那会儿归档等于把她的记忆切在活体上,该先停插件(+ 重跑增量合并)。
 *
 * 不碰:`data_v4.db`(宿主自己的对话历史)、老插件的代码(只停用不删)、
 * 其它 A 侧插件的配置(比如 `setu_on_proactive` —— 它没被归档过)。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ECHO_DIR = join(homedir(), '.dsh', 'echo')
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const val = (name, dflt) => {
  // 同名参数以**最后一个**为准(测试与手工都会「先给默认再覆盖」)
  const hits = args.filter((a) => a.startsWith('--' + name + '='))
  return hits.length === 0 ? dflt : hits[hits.length - 1].slice(name.length + 3)
}

const apply = has('--apply')
const force = has('--force')
const noCopy = has('--no-copy')
const asJson = has('--json')
const aData = val('dir', join(homedir(), '.astrbot', 'data'))
const backupRoot = val('backup-dir', join(ECHO_DIR, 'backup'))
const baselinePath = val('baseline', join(ECHO_DIR, 'r4-baseline.json'))
// 清单落在哪(测试要指到临时目录,免得污染真实数据目录)
const manifestDir = val('manifest-dir', ECHO_DIR)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const day = val('date', new Date().toISOString().slice(0, 10))

// A 侧那两张「她的记忆」:文件名就这两个,但每个都有 -wal/-shm 兄弟
const DB_TARGETS = [
  { name: '记忆库(memory.db)', dir: join(aData, 'plugin_data', 'astrbot_plugin_memory_middleware'), base: 'memory.db', suffixes: ['', '-wal', '-shm'] },
  { name: '状态库(state.db)', dir: join(aData, 'plugin_data', 'astrbot_plugin_agent_state'), base: 'state.db', suffixes: ['', '-wal', '-shm'] }
]
// 那两份「它当年照什么说话」的配置(记忆中间件 51 项 + 状态机)。
// 现役人格在 ~/.dsh/echo/persona.json —— 这两份是「老链路尸体」的一部分,
// 一个备份目录里存齐,以后不用满盘找(2026-09-26 他拍:连配置一起归档)。
const CONFIG_TARGETS = [
  { name: '老插件配置(记忆中间件·51 项)', dir: join(aData, 'config'), base: 'astrbot_plugin_memory_middleware_config.json', suffixes: [''] },
  { name: '老插件配置(状态机)', dir: join(aData, 'config'), base: 'astrbot_plugin_agent_state_config.json', suffixes: [''] }
]
const TARGETS = [...DB_TARGETS, ...CONFIG_TARGETS]
const A_TABLES = ['episodic_memory', 'pending_threads', 'her_agenda', 'graph_nodes', 'graph_edges']
const SAMPLE_BUSY_TIMEOUT_MS = 500
const SAMPLE_MAX_ATTEMPTS = 3
const SAMPLE_RETRY_DELAY_MS = 25

const problems = []
const notes = []
const plan = []

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
const human = (n) => n < 1024 ? n + 'B' : n < 1024 * 1024 ? (n / 1024).toFixed(1) + 'KB' : (n / 1024 / 1024).toFixed(2) + 'MB'

/** 一个目标连同它的兄弟文件(库有 `-wal`/`-shm`,配置就只有它自己)。 */
function filesOf (target) {
  const out = []
  for (const suffix of target.suffixes ?? ['', '-wal', '-shm']) {
    const from = join(target.dir, target.base + suffix)
    if (!existsSync(from)) continue
    const st = statSync(from)
    out.push({
      from,
      archived: from + '.archived-' + day,
      copyTo: join(backupRoot, 'a-side-' + stamp, basename(from)),
      bytes: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      sha256: suffix === '-shm' ? '' : sha256(from) // -shm 是易变的共享内存索引,哈希没意义
    })
  }
  return out
}

function sqlitePrimaryCode (error) {
  return Number.isInteger(error?.errcode) ? error.errcode & 0xff : null
}

function sqliteBusy (error) {
  const primary = sqlitePrimaryCode(error)
  return primary === 5 || primary === 6 ||
    /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/u.test(String(error?.code ?? '')) ||
    (error?.code === 'ERR_SQLITE_ERROR' &&
      ['database is locked', 'database table is locked', 'database schema is locked'].includes(error?.errstr))
}

function missingKnownTable (error, table) {
  return sqlitePrimaryCode(error) === 1 &&
    error?.message === 'no such table: ' + table
}

/** 整次采样共用只读事务，不能把读锁冲突伪装成缺表或部分成功。 */
function readCountsSnapshot (dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  let inTransaction = false
  try {
    db.exec('PRAGMA busy_timeout = ' + SAMPLE_BUSY_TIMEOUT_MS)
    db.exec('BEGIN')
    inTransaction = true
    const out = {}
    for (const table of A_TABLES) {
      try {
        const n = db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n
        if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid row count: ' + table)
        out[table] = n
      } catch (error) {
        if (!missingKnownTable(error, table)) throw error
      }
    }
    db.exec('COMMIT')
    inTransaction = false
    return out
  } finally {
    try {
      if (inTransaction) db.exec('ROLLBACK')
    } finally {
      db.close()
    }
  }
}

/** BUSY/LOCKED 只重试完整采样；未知结果无论是否 --force 都拒签。 */
async function aSideCounts () {
  const dbPath = join(aData, 'plugin_data', 'astrbot_plugin_memory_middleware', 'memory.db')
  if (!existsSync(dbPath)) return { status: 'missing', attempts: 0, counts: null }
  for (let attempts = 1; attempts <= SAMPLE_MAX_ATTEMPTS; attempts++) {
    try {
      return { status: 'ok', attempts, counts: readCountsSnapshot(dbPath) }
    } catch (error) {
      if (sqliteBusy(error) && attempts < SAMPLE_MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, SAMPLE_RETRY_DELAY_MS))
        continue
      }
      const detail = String(error?.message ?? error)
      problems.push('A 侧行数采样失败(' + detail + '):无法确认安全归档，拒签；--force 不覆盖未知采样结果')
      return {
        status: 'failed', attempts, counts: null,
        error: { code: error?.code ?? null, errcode: error?.errcode ?? null, errstr: error?.errstr ?? null }
      }
    }
  }
}

// ---- ① 盘一遍要动的文件 ----
for (const target of TARGETS) {
  const files = filesOf(target)
  if (files.length === 0) {
    notes.push(target.name + ':文件不在(' + join(target.dir, target.base) + ')—— 可能已经归档过')
    continue
  }
  const already = files.filter((f) => existsSync(f.archived))
  if (already.length > 0) {
    notes.push(target.name + ':已经有归档文件,跳过这批(' + already.map((f) => basename(f.archived)).join(',') + ')')
  }
  plan.push({ target: target.name, dir: target.dir, files: files.filter((f) => !existsSync(f.archived)) })
}

// ---- ② 「A 侧还在写吗」 ----
// 判据用**两次采样**(而不是拿切换前的基线比):切换前那份基线本来就该比现在小
// —— 老插件在停用之前一直在长。真正要拦的是「此刻还有人在写」。
const gapMs = Math.max(0, Number(val('sample-gap-ms', '2000')) || 0)
const freshSeconds = Math.max(0, Number(val('fresh-seconds', '90')) || 0)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const firstSample = await aSideCounts()
const secondSample = gapMs > 0 && firstSample.status !== 'failed'
  ? (await sleep(gapMs), await aSideCounts())
  : firstSample
const counts = firstSample.counts
const countsSecond = secondSample.counts
const drift = []
const schemaDrift = []
if (firstSample.status !== 'failed' && secondSample.status !== 'failed' &&
    firstSample.status !== secondSample.status) {
  problems.push('两次采样之间 memory.db 的存在性发生变化:无法确认安全归档，拒签；--force 不覆盖未知采样结果')
}
if (counts && countsSecond) {
  const firstKeys = Object.keys(counts)
  const secondKeys = Object.keys(countsSecond)
  for (const table of new Set([...firstKeys, ...secondKeys])) {
    if (Object.hasOwn(counts, table) !== Object.hasOwn(countsSecond, table)) schemaDrift.push(table)
  }
  if (schemaDrift.length > 0) {
    problems.push('两次采样的表集合发生变化(' + schemaDrift.join('、') + '):无法确认安全归档，拒签；--force 不覆盖未知采样结果')
  }
  for (const table of Object.keys(counts)) {
    if (Object.hasOwn(countsSecond, table) && counts[table] !== countsSecond[table]) {
      drift.push(table + ' ' + counts[table] + '→' + countsSecond[table])
    }
  }
}
// `-wal` 刚被写过也是「还有人在写」的信号(它每次提交都会动)
let walAgeSec = null
for (const item of plan) {
  for (const f of item.files) {
    if (!f.from.endsWith('-wal')) continue
    const age = (Date.now() - new Date(f.mtime).getTime()) / 1000
    if (walAgeSec === null || age < walAgeSec) walAgeSec = age
  }
}

let baseline = null
if (existsSync(baselinePath)) {
  try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) } catch { baseline = null }
}
// 与切换前基线的差异只是**信息**(说明停用之前它还在长),不拦人
const sinceBaseline = []
if (counts && baseline && baseline.aSide) {
  for (const [table, was] of Object.entries(baseline.aSide)) {
    const now = counts[table]
    if (typeof now === 'number' && now !== was) sinceBaseline.push(table + ' ' + was + '→' + now)
  }
}
if (sinceBaseline.length > 0) {
  notes.push('比切换前基线多出来的:' + sinceBaseline.join('、') +
    '(切换前长的,不是现在长的 —— 归档前记得先跑一次增量合并把这段补进 DSH)')
}

const live = []
if (drift.length > 0) live.push('两次采样之间还在长(' + drift.join('、') + ')')
if (walAgeSec !== null && walAgeSec < freshSeconds) {
  live.push('-wal 在 ' + walAgeSec.toFixed(0) + 's 前还被写过(阈值 ' + freshSeconds + 's)')
}
if (live.length > 0) {
  const msg = live.join(';') + ' —— 老插件没停干净。先停用它(+ 重跑增量合并),等一分钟再来'
  if (force) notes.push('【--force】' + msg)
  else problems.push(msg)
}

// ---- 输出计划 ----
const report = {
  at: new Date().toISOString(), apply, force, aData, backupRoot, day,
  baseline: baseline ? baseline.at : null, counts, countsSecond, drift, walAgeSec, sinceBaseline,
  schemaDrift,
  sampling: {
    busyTimeoutMs: SAMPLE_BUSY_TIMEOUT_MS, maxAttempts: SAMPLE_MAX_ATTEMPTS,
    first: { ...firstSample, counts: undefined }, second: { ...secondSample, counts: undefined }
  },
  plan, problems, notes,
  manifest: join(manifestDir, 'retired-a-side-' + stamp + '.json')
}

function printPlan () {
  console.log(apply ? '== 归档 A 侧(真改名)==' : '== 归档 A 侧(dry-run:不执行归档)==')
  console.log('A 数据目录 ' + aData)
  console.log('基线       ' + (report.baseline || '(没有基线文件:' + baselinePath + ')'))
  if (counts) console.log('A 侧行数   ' + JSON.stringify(counts) +
    (report.walAgeSec === null ? '' : '   (最近一次 -wal 写入:' + report.walAgeSec.toFixed(0) + 's 前)'))
  for (const item of plan) {
    console.log('')
    console.log(item.target + '  [' + item.dir + ']')
    for (const f of item.files) {
      console.log('  ' + basename(f.from).padEnd(16) + human(f.bytes).padStart(8) + '  →  ' +
        basename(f.archived) + '   (mtime ' + f.mtime + (f.sha256 ? ', sha256:' + f.sha256 : '') + ')')
    }
  }
  if (plan.length === 0) console.log('\n(没有要动的文件)')
  console.log('')
  console.log('不碰: data_v4.db(宿主自己的对话历史)、老插件的代码(只停用不删)')
  for (const n of notes) console.log('  · ' + n)
  for (const p of problems) console.log('  ! ' + p)
}

// ---- ③ 执行 ----
function doApply () {
  const manifest = { ...report, copied: [], renamed: [], errors: [], rollback: [] }
  // 清单先落盘:万一改到一半出问题,「原本长什么样」已经记下了
  mkdirSync(manifestDir, { recursive: true })
  writeFileSync(manifest.manifest, JSON.stringify(manifest, null, 2), 'utf8')
  for (const item of plan) {
    for (const f of item.files) {
      if (!noCopy) {
        try {
          mkdirSync(dirname(f.copyTo), { recursive: true })
          copyFileSync(f.from, f.copyTo)
          manifest.copied.push(f.copyTo)
        } catch (e) {
          manifest.errors.push('备份失败 ' + f.from + ': ' + e.message)
          problems.push('备份失败:' + basename(f.from) + ' → ' + e.message)
          continue // 备份没成就别改名
        }
      }
      try {
        renameSync(f.from, f.archived)
        manifest.renamed.push(f.archived)
        manifest.rollback.push('rename "' + f.archived + '" back to "' + f.from + '"')
      } catch (e) {
        // Windows 上文件被占用的典型样子:EPERM/EBUSY —— 说明插件还开着
        manifest.errors.push('改名失败 ' + f.from + ': ' + e.message)
        problems.push('改名失败:' + basename(f.from) + ' → ' + e.message + '(文件被占用?先停用老插件/重启 AstrBot)')
      }
    }
  }
  writeFileSync(manifest.manifest, JSON.stringify(manifest, null, 2), 'utf8')
  return manifest
}

if (asJson) {
  const done = (apply && problems.length === 0) ? doApply() : null
  console.log(JSON.stringify(done || report, null, 2))
  process.exit(problems.length === 0 ? 0 : 1)
}

printPlan()
if (!apply) {
  console.log('')
  console.log(problems.length === 0
    ? '  ✓ 可以归档(加 --apply 就动手;它会先备份每个文件再改名)'
    : '  ! 有 ' + problems.length + ' 项要先处理(--force 仅覆盖已确认的写入/WAL信号，不能覆盖未知采样结果)')
  process.exit(problems.length === 0 ? 0 : 1)
}

if (problems.length > 0) {
  console.log('')
  console.log('  ! 拒签:采样无法确认安全归档，或发现老链路仍在写。先处理上面的具体问题；--force 不覆盖未知采样结果。')
  process.exit(1)
}

const manifest = doApply()
console.log('')
console.log('备份   ' + (noCopy ? '(跳过)' : join(backupRoot, 'a-side-' + stamp)))
console.log('清单   ' + manifest.manifest)
console.log('改名   ' + manifest.renamed.length + ' 个文件' + (manifest.errors.length ? '(失败 ' + manifest.errors.length + ' 个)' : ''))
for (const e of manifest.errors) console.log('  ! ' + e)
if (manifest.rollback.length > 0) {
  console.log('')
  console.log('回滚(逐条执行即可;归档是改名,所以回滚也是改名):')
  for (const line of manifest.rollback) console.log('  ' + line)
}
process.exit(manifest.errors.length === 0 ? 0 : 1)
