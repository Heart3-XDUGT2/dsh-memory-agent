/**
 * dsh-echo — 数据目录的**路径真源**与脚手架
 * ============================================================
 * 设计依据:`Desktop\交接\数据程序分离设计-2026-10-05.md` §3 / §4。
 *
 * ⚠️ P1a 起这个文件多担一个身份:**全仓唯一的路径真源**。
 *   以前三处各写各的 —— `lib/persona.js:19`(DATA_DIR/PERSONA_PATH)、
 *   `lib/toggle.js:62`(CONFIG_PATH)、`lib/index.js:145`(DB_PATH);
 *   现在都改成 import 这里的函数,只认一套优先级:
 *     `resolveDataDir()`  : ECHO_DATA_DIR > $DSH_HOME/echo > ~/.dsh/echo
 *     `resolveDbPath()`   : ECHO_DB > <dataDir>/echo.db
 *     `resolveConfigPath()` / `resolvePersonaPath()` / `resolveDataFilePath(name)`
 *   不设任何 env 时结果与 P0 之前**逐字节一致**(~/.dsh/echo/**)。
 *
 * 脚手架部分(P0 起)干四件事,全部幂等:
 *   ① `mkdir <数据目录>`(递归);
 *   ② `mkdir <数据目录>/backup`(写入前的备份落点);
 *   ③ 对 8 个数据文件:**不存在 ⇒ 写空模板**;**存在 ⇒ 只读校验**(绝不改写);
 *   ④ 写/更新 `data-rev.json`(版本 + 迁移记录 + 上次体检时间)。
 *
 * 三条硬纪律(P0 任务书 + 设计 §4.3/§7.2):
 *   1. **绝不抛错**。写盘失败只记 warn 并回在返回值里 —— 数据目录建不出来
 *      不该让插件挂不上(记忆库那边已经是同一个 fail-soft 姿势)。
 *   2. **绝不覆盖用户文件**。"存在"就走只读校验这条路;语义不合规
 *      (字段类型不对)只记 warn、**原样保留** —— 宁可少报一次,不毁他一个字。
 *      只有"读都读不出来"(JSON 坏了 / 顶层不是对象)才改名 `.bad-<时间戳>`
 *      **留档**后重建空模板:原文一个字节都不丢。
 *   3. **绝不写真人默认值**。空模板来自 lib/data-schema.js,里面只有
 *      '' / [] / {} / null —— 程序默认值(persona/DEFAULT_PERSONA、SETTINGS_DEFAULTS)
 *      一律不进用户文件。
 *
 * 与既有分工的关系:`lib/persona.js` 的 `loadPersona()` 仍然照旧读写它自己那份
 * persona.json(本文件只在"文件不存在"时替它把空壳先建出来);`lib/toggle.js` 的
 * config.json 读写、`openStore` 建库都不受影响 —— P0 **不改变任何现有行为**。
 */
import {
  accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  ARCHIVE_FILES, BACKUP_DIR_NAME, DATA_FILES, DATA_REV_FILE, MANAGED_FILES, PROGRAM_DATA_REV,
  emptyTemplate, isUnreadable, validateFile
} from './data-schema.js'

/**
 * 已知的"一次性迁移"标记(P3 迁移设计 §4.2,**17 个键,一次定死不许改名** ——
 * 改了就等于重新跑一遍)。登记进来的字符串必须与 `data-rev.json` 的
 * `appliedMigrations` 逐字一致。
 *
 * 谁在用:`lib/data-migrate.js`(执行器逐条过门)、`dataDirStatus()`(体检)、
 * `scripts/install.mjs --doctor/--migrate`(运维口)。
 *
 * ⚠️ 键集必须与"首次安装 ⇒ 全部跳过并登记"的账本逻辑**同一批落地**:
 *   `dataDirStatus` 曾无条件把"有 pendingMigrations"报成问题,而刚 scaffold 完的
 *   目录必须零问题(tests/data-dir.test.js:264/:268 钉着这条)⇒ 本批同时把
 *   pending 口径收成"只在 dataRev 落后时报"(见 dataDirStatus 里的注释)。
 */
export const KNOWN_MIGRATIONS = Object.freeze([
  'p3.lexicon-topic-stopwords',
  'p3.lexicon-power-words',
  'p3.lexicon-longing-markers',
  'p3.lexicon-time-words',
  'p3.lexicon-stopwords',
  'p3.graph-relations-single-value',
  'p3.graph-relations-multi-keys',
  'p3.graph-relations-canonical',
  'p3.graph-relations-pending',
  'p3.graph-relations-type-rules',
  'p3.graph-relations-default',
  'p3.graph-relations-identity',
  'p3.graph-display-tuning',
  'p3.graph-night-window',
  'p3.state-defaults-seed',
  'p3.profile-address-fallback',
  'p3.names-script-readers'
])

/** "结构记账"键:它们有值不代表用户填过东西(口径与 lib/data-write.js:211 的同名清单同源)。 */
const STRUCTURAL_KEYS = Object.freeze([
  'schemaRev', 'updatedAt', 'savedAt', 'createdAt', 'lastCheckAt', 'appliedMigrations'
])

/** 空值口径:`''`(含全空白)/ `[]` / `{}` / `null` / `undefined` / `false`(默认态,不是填过的值)。
 *  与 lib/data-write.js 的 `isEmptyContent` 同口径(data-migrate.js 写 notes 时也要用)。 */
export function isEmptyValue (v) {
  if (v === undefined || v === null || v === false) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v).length === 0
  return false
}

/**
 * 数据目录在哪里(P0 起支持 `ECHO_DATA_DIR` 整体覆盖;其次 `DSH_HOME`,最后 `~/.dsh`)。
 * 与 `lib/persona.js:19` 的推法是同一条路径 —— 那边是模块级常量,第一次 import
 * 时定死;这里是函数,每次现读(测试/多实例要用)。
 * @param {Record<string, string|undefined>} [env]
 */
/** 纯推法:每次现读 env(内部件;对外只暴露 resolveDataDir)。 */
function dataDirOf (env) {
  const explicit = env?.ECHO_DATA_DIR
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const home = env?.DSH_HOME
  return join(typeof home === 'string' && home.trim() !== '' ? home.trim() : join(homedir(), '.dsh'), 'echo')
}

let frozenDataDir = null

/**
 * 数据目录在哪里。优先级:`ECHO_DATA_DIR` > `$DSH_HOME/echo` > `~/.dsh/echo`。
 *
 * ★ **进程内第一个问到的人定死**(P1a 起的正式语义,不是性能优化):
 *   "人格 / 开关 / 记忆库"三条路径必须让整个进程指向**同一个家** ——
 *   半个插件读 A 目录、半个插件读 B 目录是最坏的形状。
 *   于是旧代码里那条被 6 个测试文件写进注释、并被 5 处"落盘持久"断言依赖的
 *   语义 ——「`CONFIG_PATH` 是模块级常量,首次 import 时定死」——在 P1a 之后
 *   **逐字保留**:`import('../lib/toggle.js?again=1')` 拿到的**新模块实例**,
 *   解析出来的路径与第一次仍然一致(tests/toggle.test.js 靠它证明"写的是盘,不是内存")。
 *
 * 传**显式 env**(`resolveDataDir({ DSH_HOME: … })`)时不冻结、纯算 ——
 * 给测试和未来的多实例留口子。
 * @param {Record<string, string|undefined>} [env]
 */
export function resolveDataDir (env = process.env) {
  if (env !== process.env) return dataDirOf(env)
  if (frozenDataDir === null) frozenDataDir = dataDirOf(env)
  return frozenDataDir
}

/**
 * 记忆库路径:与 `lib/soul-snapshot.js` 的 `dbPathOf()` 同一口径
 * (`ECHO_DB` 覆盖,其次数据目录下的 echo.db)。
 * @param {Record<string, string|undefined>} [env]
 */
export function resolveDbPath (env = process.env) {
  const explicit = env?.ECHO_DB
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  return join(resolveDataDir(env), 'echo.db')
}

/**
 * config.json 的完整路径(**路径真源**:P1a 起 `lib/toggle.js` 不再自己拼)。
 * @param {Record<string, string|undefined>} [env]
 */
export function resolveConfigPath (env = process.env) {
  return join(resolveDataDir(env), 'config.json')
}

/**
 * persona.json 的完整路径(**路径真源**:P1a 起 `lib/persona.js` 不再自己拼)。
 * @param {Record<string, string|undefined>} [env]
 */
export function resolvePersonaPath (env = process.env) {
  return join(resolveDataDir(env), 'persona.json')
}

/**
 * persona-legacy-defaults.json(插件**历史默认人格**的只读史料)的完整路径。
 * P1b 起程序里不再有人格文本:那几版默认被一次性迁移搬进这个文件,
 * 程序只读它、永不写回;文件不在 = 没有史料(降级,不抛)。
 * @param {Record<string, string|undefined>} [env]
 */
export function resolvePersonaLegacyPath (env = process.env) {
  return join(resolveDataDir(env), 'persona-legacy-defaults.json')
}

/**
 * 数据目录里某个**受管文件**的完整路径;名字不在册 ⇒ `null`(不瞎拼路径)。
 * @param {string} name
 * @param {Record<string, string|undefined>} [env]
 */
export function resolveDataFilePath (name, env = process.env) {
  if (!MANAGED_FILES.includes(name)) return null
  return join(resolveDataDir(env), name)
}

// ---------------------------------------------------------------- 内部件

const isoNow = () => new Date().toISOString()

/** 文件名安全的时间戳:2026-10-05T12-34-56-789Z */
const stampOf = (iso) => String(iso).replace(/[:.]/g, '-')

/** 原子写(tmp + rename,与 lib/toggle.js 的 writeConfig 同一个姿势)。 */
function writeJsonAtomic (path, obj) {
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  renameSync(tmp, path)
}

function readJsonOrNull (path) {
  try {
    if (!existsSync(path)) return { obj: null, err: null }
    return { obj: JSON.parse(readFileSync(path, 'utf8')), err: null }
  } catch (err) {
    return { obj: null, err }
  }
}

/** 顶层是普通对象(不是 null / 数组 / 标量)。 */
const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// ---------------------------------------------------------------- 主入口

/**
 * 把数据目录准备好(幂等;永不抛错)。
 *
 * @param {object} [opts]
 * @param {string} [opts.dir]        数据目录(默认 `resolveDataDir()`)
 * @param {{info?: Function, warn?: Function}} [opts.logger] 宿主 logger(可省)
 * @param {() => string} [opts.now]  注入时间(测试用),返回 ISO 字符串
 * @returns {Promise<{dir: string, backupDir: string, created: string[], validated: string[],
 *   failed: Array<{file: string, reason: string, action: string, kept?: string}>,
 *   dataRev: object|null, ok: boolean}>}
 *   `created`  = 这次新建的空模板(文件名)
 *   `validated`= 这次只读校验通过的文件名
 *   `failed`   = 没搞定的({action:'renamed-and-rebuilt'|'kept'|'none'})
 */
export async function ensureDataDir ({ dir, logger, now } = {}) {
  const info = (m) => { try { logger?.info?.(m) } catch { /* logger 坏了不该影响建目录 */ } }
  const warn = (m) => { try { logger?.warn?.(m) } catch { /* 同上 */ } }
  const iso = (typeof now === 'function' ? now() : isoNow())

  const root = typeof dir === 'string' && dir.trim() !== '' ? dir : resolveDataDir()
  const backupDir = join(root, BACKUP_DIR_NAME)
  const out = {
    dir: root,
    backupDir,
    created: [],
    validated: [],
    failed: [],
    dataRev: null,
    ok: true
  }

  // ---- ① 目录 + ② backup/ ----
  try {
    mkdirSync(root, { recursive: true })
  } catch (err) {
    out.ok = false
    out.failed.push({ file: '(数据目录)', reason: String(err?.message ?? err), action: 'none' })
    warn('echo: 数据目录建不出来,跳过 scaffold —— ' + String(err?.message ?? err))
    return out
  }
  try {
    mkdirSync(backupDir, { recursive: true })
  } catch (err) {
    out.ok = false
    out.failed.push({ file: BACKUP_DIR_NAME, reason: String(err?.message ?? err), action: 'none' })
    warn('echo: backup/ 建不出来(写入前的备份会没有落点)—— ' + String(err?.message ?? err))
  }

  // ---- ③ 8 个数据文件 ----
  for (const name of DATA_FILES) {
    const path = join(root, name)
    let exists = false
    try { exists = existsSync(path) } catch { exists = false }

    // ③-a 不存在 ⇒ 写空模板
    if (!exists) {
      try {
        writeJsonAtomic(path, emptyTemplate(name))
        out.created.push(name)
      } catch (err) {
        out.ok = false
        out.failed.push({ file: name, reason: String(err?.message ?? err), action: 'none' })
        warn('echo: ' + name + ' 写不进去(数据目录只读?)—— ' + String(err?.message ?? err))
      }
      continue
    }

    // ③-b 存在 ⇒ **只读**校验(到这里一次写都没有)
    const { obj, err } = readJsonOrNull(path)
    const broken = err !== null || isUnreadable(obj)
    if (broken) {
      // 读都读不出来:留档 + 重建。**原文进 .bad-<时间戳>,不丢一个字节。**
      const kept = path + '.bad-' + stampOf(iso)
      try {
        renameSync(path, kept)
        writeJsonAtomic(path, emptyTemplate(name))
        out.failed.push({
          file: name,
          reason: String(err?.message ?? '顶层不是 JSON 对象'),
          action: 'renamed-and-rebuilt',
          kept: basename(kept)
        })
        warn('echo: ' + name + ' 读不出来,已留档为 ' + basename(kept) + ' 并重建空模板')
      } catch (err2) {
        out.ok = false
        out.failed.push({ file: name, reason: String(err2?.message ?? err2), action: 'none' })
        warn('echo: ' + name + ' 坏了又搬不动(只读?)—— ' + String(err2?.message ?? err2))
      }
      continue
    }

    const v = validateFile(name, obj)
    if (v.ok) {
      out.validated.push(name)
    } else {
      // 语义错:报出来,但**原样保留**(非破坏优先 —— 设计 §7.2)
      out.failed.push({ file: name, reason: v.errors.join('; '), action: 'kept' })
      warn('echo: ' + name + ' 字段不合规,但**保持原样**(不覆盖用户文件):' + v.errors.join('; '))
    }
    for (const w of v.warnings) info('echo: ' + name + ':' + w)
  }

  // ---- ④ 记账文件(程序独占) ----
  const revPath = join(root, DATA_REV_FILE)
  const prev = readJsonOrNull(revPath).obj
  const prevObj = prev !== null && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}
  const next = {
    dataRev: PROGRAM_DATA_REV,
    createdAt: typeof prevObj.createdAt === 'string' && prevObj.createdAt !== '' ? prevObj.createdAt : iso,
    appliedMigrations: Array.isArray(prevObj.appliedMigrations)
      ? prevObj.appliedMigrations.filter((x) => typeof x === 'string' && x !== '')
      : [],
    lastCheckAt: iso,
    notes: Array.isArray(prevObj.notes) ? prevObj.notes.filter((x) => typeof x === 'string') : []
  }
  const revCheck = validateFile(DATA_REV_FILE, next)
  if (!revCheck.ok) {
    out.ok = false
    out.failed.push({ file: DATA_REV_FILE, reason: revCheck.errors.join('; '), action: 'none' })
    warn('echo: ' + DATA_REV_FILE + ' 自检不过(这是个 bug,不是数据问题):' + revCheck.errors.join('; '))
  } else {
    try {
      writeJsonAtomic(revPath, next)
      out.dataRev = next
    } catch (err) {
      out.ok = false
      out.failed.push({ file: DATA_REV_FILE, reason: String(err?.message ?? err), action: 'none' })
      warn('echo: ' + DATA_REV_FILE + ' 写不进去 —— ' + String(err?.message ?? err))
    }
  }

  return out
}

// ---------------------------------------------------------------- P3 记账

/**
 * "这个数据目录算不算**首次安装**?"(P3 迁移设计 §3.3)
 *
 * 首装 = 8 个数据文件里**没有任何用户意图值**(全空 / 缺 / 读不出来)。
 * 空模板只有 '' / [] / {} / null / `schemaRev` 这类结构记账 ⇒ 判"首装";
 * 他填过任何一个字段(persona 文本、禁词、时间词…) ⇒ 判"升级"。
 *
 * 为什么要紧:首装**没有可导的旧值**(纪律:永远不写真人默认值),执行器要
 * "全部跳过并登记";升级才逐条走"门 + 摘要 + 记账"。
 *
 * 空值判据**故意与 lib/data-write.js 的 `isEmptyContent` 同口径、但不 import 它** ——
 * data-write.js 反过来 import 本文件(resolveDataDir),import 回去就成环。
 * @param {{dir?: string}} [opts]
 * @returns {{firstInstall: boolean, filled: string[]}} `filled` = 让他"不算首装"的字段
 */
export function firstInstallOf ({ dir } = {}) {
  const root = typeof dir === 'string' && dir.trim() !== '' ? dir : resolveDataDir()
  const filled = []
  for (const name of DATA_FILES) {
    const { obj } = readJsonOrNull(join(root, name))
    // 缺文件 / 读不出来都当"空"(缺 schemaRev 本来就合法,见 lib/data-schema.js:502-503)
    if (isUnreadable(obj)) continue
    for (const k of Object.keys(obj)) {
      if (STRUCTURAL_KEYS.includes(k)) continue
      if (!isEmptyValue(obj[k])) { filled.push(name + '.' + k); break }
    }
  }
  return { firstInstall: filled.length === 0, filled }
}

/**
 * 往 `data-rev.json.appliedMigrations` **追加**已跑键(P3 迁移设计 §4.3 的写入口)。
 *
 * 三条纪律:
 *   ① **绝不覆盖别人的键** —— 已有的 `appliedMigrations` / `notes` 逐条保留、
 *      顺序不动,只往后接;`dataRev` 也**不 bump**(P3 只改"字段的有无",旧程序
 *      不会误读 ⇒ 设计 §3.2 明说不 bump)。
 *   ② **幂等** —— 要追加的键一个都没有、也没有新 notes ⇒ **不写盘**(内容与 mtime
 *      都不动):这是"跑两遍,除 lastCheckAt 外逐字节一致"那条验收的前提。
 *   ③ **失败不记账** —— 校验不过 / 写不进去 ⇒ 一个键都不追加,回 `{ok:false, reason}`
 *      (调用方把它记进下次重试的名单)。
 *
 * 读—比—写三步,写前现读一次(乐观并发:盘上现值优先于我们的快照)。
 * 永不抛错(与 `ensureDataDir` 同姿势)——数据目录写不进去不该让插件挂不上。
 * @param {string[]} keys 这次跑成的键(顺序照传入)
 * @param {{dir?: string, now?: string, notes?: string[]}} [opts]
 * @returns {{ok: boolean, wrote: boolean, path: string, applied: string[], added: string[], reason: string}}
 *   `applied` 失败时回**盘上现值**(什么都没记)
 */
export function appendAppliedMigrations (keys, { dir, now, notes } = {}) {
  const root = typeof dir === 'string' && dir.trim() !== '' ? dir : resolveDataDir()
  const revPath = join(root, DATA_REV_FILE)
  const iso = typeof now === 'string' && now.trim() !== '' ? now : isoNow()
  const prevObj = readJsonOrNull(revPath).obj
  const base = isPlainObj(prevObj) ? prevObj : {}
  const keepStrings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x !== '') : [])
  const applied = keepStrings(base.appliedMigrations)
  const added = []
  for (const k of Array.isArray(keys) ? keys : []) {
    // 三重滤:非字符串/空串丢掉;**盘上已有的**和**本次已收的**都算重(重键只记一次)
    if (typeof k !== 'string' || k === '') continue
    if (applied.includes(k) || added.includes(k)) continue
    added.push(k)
  }
  const extra = keepStrings(notes)
  if (added.length === 0 && extra.length === 0) {
    return { ok: true, wrote: false, path: revPath, applied, added: [], reason: '' }
  }
  const next = {
    dataRev: Number.isInteger(base.dataRev) && base.dataRev >= 1 ? base.dataRev : PROGRAM_DATA_REV,
    createdAt: typeof base.createdAt === 'string' && base.createdAt !== '' ? base.createdAt : iso,
    appliedMigrations: applied.concat(added),
    lastCheckAt: iso,
    notes: keepStrings(base.notes).concat(extra)
  }
  const check = validateFile(DATA_REV_FILE, next)
  if (!check.ok) {
    return { ok: false, wrote: false, path: revPath, applied, added: [], reason: '自检不过(这是个 bug,不是数据问题):' + check.errors.join('; ') }
  }
  try {
    writeJsonAtomic(revPath, next)
  } catch (err) {
    return { ok: false, wrote: false, path: revPath, applied, added: [], reason: String(err?.message ?? err) }
  }
  return { ok: true, wrote: true, path: revPath, applied: next.appliedMigrations, added, reason: '' }
}

/**
 * 体检(**纯只读**,给 `scripts/install.mjs --doctor` 与未来的面板用)。
 * @param {object} [opts]
 * @param {string} [opts.dir]
 * @returns {{dir: string, exists: boolean, writable: boolean, backupExists: boolean,
 *   files: Array<{file: string, exists: boolean, ok: boolean, rev: number|null,
 *                 errors: string[], warnings: string[]}>,
 *   badResidue: string[], dataRev: object|null, dataRevStale: boolean,
 *   pendingMigrations: string[], problems: string[]}}
 */
export function dataDirStatus ({ dir } = {}) {
  const root = typeof dir === 'string' && dir.trim() !== '' ? dir : resolveDataDir()
  const st = {
    dir: root,
    exists: false,
    writable: false,
    backupExists: false,
    files: [],
    badResidue: [],
    dataRev: null,
    dataRevStale: false,
    pendingMigrations: [],
    problems: []
  }
  try { st.exists = existsSync(root) } catch { st.exists = false }
  if (!st.exists) {
    st.problems.push('数据目录还不存在(插件首次启动会自动建出来)')
    return st
  }
  try {
    accessSync(root, constants.W_OK)
    st.writable = true
  } catch {
    st.problems.push('数据目录不可写(面板存不下去、备份也落不了)')
  }
  try { st.backupExists = existsSync(join(root, BACKUP_DIR_NAME)) } catch { st.backupExists = false }

  // 体检清单 = 8 个数据文件 + 档案文件(P1b 拍板:档案住在数据目录里,就该被校验)。
  // 但档案**不参与建仓** ⇒ "缺文件"那一段只对数据文件报;档案缺了就是"没有史料",
  // 不算缺、不进 problems、也不写它(体检全程只读)。
  for (const name of [...DATA_FILES, ...ARCHIVE_FILES]) {
    const isArchive = ARCHIVE_FILES.includes(name)
    const path = join(root, name)
    const one = { file: name, exists: false, ok: false, rev: null, errors: [], warnings: [] }
    try { one.exists = existsSync(path) } catch { one.exists = false }
    if (!one.exists) {
      if (isArchive) continue
      one.errors.push('缺文件(scaffold 会自动补)')
      st.problems.push(name + ':缺文件')
      st.files.push(one)
      continue
    }
    const { obj, err } = readJsonOrNull(path)
    if (err !== null || isUnreadable(obj)) {
      one.errors.push(String(err?.message ?? '顶层不是 JSON 对象'))
      st.problems.push(name + ':读不出来')
    } else {
      const v = validateFile(name, obj)
      one.ok = v.ok
      one.rev = Number.isInteger(obj.schemaRev) ? obj.schemaRev : null
      one.errors.push(...v.errors)
      one.warnings.push(...v.warnings)
      if (!v.ok) st.problems.push(name + ':字段不合规(' + v.errors.length + ' 条)')
    }
    st.files.push(one)
  }

  try {
    for (const n of readdirSync(root)) {
      if (String(n).includes('.bad-')) st.badResidue.push(String(n))
    }
  } catch { /* 列不动就当作没有 */ }
  if (st.badResidue.length > 0) {
    st.problems.push('有 ' + st.badResidue.length + ' 个 .bad-* 残留(旧的坏文件留档,确认后可删)')
  }

  st.dataRev = readJsonOrNull(join(root, DATA_REV_FILE)).obj
  if (st.dataRev === null) {
    st.problems.push(DATA_REV_FILE + ':缺(还没跑过 scaffold)')
  } else if (!Number.isInteger(st.dataRev.dataRev)) {
    st.problems.push(DATA_REV_FILE + ':dataRev 不是整数')
  } else if (st.dataRev.dataRev !== PROGRAM_DATA_REV) {
    st.dataRevStale = true
    st.problems.push(DATA_REV_FILE + ':dataRev=' + st.dataRev.dataRev + ' != 程序期望 ' + PROGRAM_DATA_REV)
  }

  const applied = Array.isArray(st.dataRev?.appliedMigrations) ? st.dataRev.appliedMigrations : []
  // ⚠️ 口径(2026-10-05 P3-B4 拍板):pending **只在 dataRev 落后时**才算问题。
  //
  // 为什么不能继续无条件 `KNOWN_MIGRATIONS.filter(...)`:把 17 个键填进
  // `KNOWN_MIGRATIONS` 之后,刚 scaffold 完(记账还是空数组)的目录会当场被报
  // "有 17 项一次性迁移没应用",而 tests/data-dir.test.js:264/:268 钉着
  // "刚 scaffold 完的目录零问题 **且** pendingMigrations 为空"。
  // 首装本来就没有可导的旧值(设计 §3.3:全部跳过并登记),那不是"落后",
  // 不该报成问题;真要跑,由挂载时的执行器(lib/data-migrate.js)逐条过门。
  // 于是体检的版本信号只留 dataRev 这一档(dataRev 落后 = 结构真落后)。
  // ⚠️ P3 **不** bump dataRev(设计 §3.2):所以这一批的 pending 在体检里
  // 是"信息"而不是"警告" —— 运维口 `--migrate --dry-run` 才看逐条计划。
  st.pendingMigrations = st.dataRevStale ? KNOWN_MIGRATIONS.filter((m) => !applied.includes(m)) : []
  if (st.pendingMigrations.length > 0) {
    st.problems.push('有 ' + st.pendingMigrations.length + ' 项一次性迁移没应用')
  }
  return st
}

/** 人话一行(启动日志与 doctor 共用;只返回字符串,不打印)。 */
export function describeEnsureResult (r) {
  if (r === null || typeof r !== 'object') return '数据目录:没有结果'
  return '数据目录已就绪:新建 ' + r.created.length + ' 个模板,校验 ' + r.validated.length + ' 个'
    + (r.failed.length > 0 ? ',异常 ' + r.failed.length + ' 项' : '')
}
