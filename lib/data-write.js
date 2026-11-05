/**
 * P2 配置中心 · **唯一写路径**(设计文档 §6.4)。
 *
 * 时序(每一步都得成立,顺序不许换):
 *
 *   writeAllowed?(回环 + x-echo-edit)   否 → 403      ← 端点层做,见 lib/index.js
 *   白名单文件?                          否 → 404      ← isWritableFile()
 *   读旧文件 → 备份到 backup/<file>.<ts>.bak  失败 ⇒ 中止,不继续
 *   校验(字段/类型/长度/正则)             失败 ⇒ 400 + 明细,**一个字节都不写**
 *   原子写:.tmp + rename
 *   失效相关缓存(persona.json ⇒ 重新 loadPersona)+ emit 变更
 *   200 {ok, savedAt, effective}
 *
 * 纪律:
 *   * 只有**登记的 8 个数据文件**能写(`DATA_FILES`);`echo.db` 永远不在这条路上。
 *   * 校验用的是**字段表**(`lib/data-schema.js` 的 `validateFile`)—— 本文件不复制任何钳位。
 *   * 缓存失效是**注册制**(`registerCacheInvalidator`),本文件不反向 import 宿主模块(免成环)。
 *   * 所有函数可注入 `dir`(测试用临时目录,绝不碰真数据目录)。
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { BACKUP_DIR_NAME, DATA_FILES, emptyTemplate, specOf, validateFile } from './data-schema.js'
import { resolveDataDir } from './data-dir.js'

/** §6.5 的三种生效语义(端点不许自创第四种)。 */
export const WRITE_EFFECTIVE = Object.freeze({
  now: 'now',                       // 引擎每帧现读 / 纯前端 →「已生效」
  nextTurn: 'next-turn',            // 下一轮组装 →「下一轮生效」
  nextEngineCall: 'next-engine-call' // 引擎进程内快照 →「下次引擎调用生效」
})

/** 文件 → 生效时机。表就是 §6.5,别处不许再写一份。 */
const EFFECTIVE_BY_FILE = Object.freeze({
  'config.json': WRITE_EFFECTIVE.now,
  'persona.json': WRITE_EFFECTIVE.nextTurn,
  'profile.json': WRITE_EFFECTIVE.now,
  'aliases.json': WRITE_EFFECTIVE.nextEngineCall,
  'names.json': WRITE_EFFECTIVE.nextEngineCall,
  'graph.json': WRITE_EFFECTIVE.nextEngineCall,
  'state-defaults.json': WRITE_EFFECTIVE.nextEngineCall,
  'lexicon.json': WRITE_EFFECTIVE.nextEngineCall
})

/** 文件 → 面板深链(引导条点一下直达那一页)。 */
const DEEP_LINK_BY_FILE = Object.freeze({
  'config.json': '#/cfg',
  'persona.json': '#/persona',
  'profile.json': '#/profile',
  'aliases.json': '#/aliases',
  'names.json': '#/aliases',
  'graph.json': '#/tuning',
  'state-defaults.json': '#/state-lexicon',
  'lexicon.json': '#/state-lexicon'
})

/** 缺/空时该怎么跟用户说(引导条文案;不猜、不写死真名)。 */
const HINT_BY_FILE = Object.freeze({
  'config.json': '引擎与壳侧调参(每帧现读,改完立即生效)',
  'persona.json': '她的人格前缀/后缀(下一轮对话生效)',
  'profile.json': '你的称呼、她的名字、界面语言(立即生效)',
  'aliases.json': '别名规则(下次引擎调用生效)',
  'names.json': '说话人 / 人名词表(下次引擎调用生效)',
  'graph.json': '图谱阈值与挖掘参数(下次引擎调用生效)',
  'state-defaults.json': '新记忆的状态初值(下次引擎调用生效)',
  'lexicon.json': '情绪/话题词表(下次引擎调用生效)'
})

/** 写路径的失败 —— 带机器可读的 `code`,端点照它映射状态码。 */
export class DataWriteError extends Error {
  /**
   * @param {'not-allowed'|'invalid'|'backup-failed'|'write-failed'} code
   * @param {string} message
   * @param {{errors?: string[], warnings?: string[], detail?: string}} [extra]
   */
  constructor (code, message, extra = {}) {
    super(message)
    this.name = 'DataWriteError'
    this.code = code
    this.errors = extra.errors ?? []
    this.warnings = extra.warnings ?? []
    this.detail = extra.detail ?? ''
  }
}

// ── 缓存失效:注册制(宿主注册,本文件调用) ──────────────────────────────

const invalidators = []

/**
 * 宿主注册一个"某个数据文件变了"的回调(例如 persona.json ⇒ 重新 loadPersona)。
 * 回调**抛错不影响写盘结果**(文件已经落好了);错误进 `notes` 回给调用方。
 * @param {(name: string, obj: object, ctx: {dir: string, path: string}) => void} fn
 */
export function registerCacheInvalidator (fn) {
  if (typeof fn === 'function') invalidators.push(fn)
}

function invalidate (name, obj, ctx) {
  const notes = []
  for (const fn of invalidators) {
    try {
      fn(name, obj, ctx)
    } catch (err) {
      notes.push('失效回调抛错:' + String(err?.message ?? err))
    }
  }
  return notes
}

// ── 只读面 ──────────────────────────────────────────────────────────────

/** 这是不是能写的数据文件(`echo.db` 永远 false)。 */
export function isWritableFile (name) {
  return DATA_FILES.includes(String(name))
}

/** 这个文件改完什么时候生效(不认识的文件按"立即")。 */
export function effectiveOf (name) {
  return EFFECTIVE_BY_FILE[String(name)] ?? WRITE_EFFECTIVE.now
}

/** 这个文件的面板深链(引导条用)。 */
export function deepLinkOf (name) {
  return DEEP_LINK_BY_FILE[String(name)] ?? '#/cfg'
}

function pathOf (name, dir) {
  return join(dir, String(name))
}

function backupDirOf (dir) {
  return join(dir, BACKUP_DIR_NAME)
}

/** 读一个数据文件(不解析成业务对象,只回"原始内容 + 状态")。 */
export function readDataFile (name, { dir = resolveDataDir() } = {}) {
  const file = String(name)
  if (!isWritableFile(file)) {
    throw new DataWriteError('not-allowed', '不在白名单里的文件:' + file)
  }
  const path = pathOf(file, dir)
  if (!existsSync(path)) return { file, exists: false, value: null, raw: '', bytes: 0 }
  const raw = readFileSync(path, 'utf8')
  let value = null
  let parseError = ''
  try {
    value = JSON.parse(raw)
  } catch (err) {
    parseError = String(err?.message ?? err)
  }
  return {
    file, exists: true, value, raw, bytes: Buffer.byteLength(raw, 'utf8'),
    parseError, unreadable: value === null
  }
}

/** 校验(不落盘)。给 JSON 编辑器干跑用。 */
export function validateDataFile (name, obj) {
  const file = String(name)
  if (!isWritableFile(file)) {
    return { ok: false, errors: ['不在白名单里的文件:' + file], warnings: [], file }
  }
  const v = validateFile(file, obj)
  return { ok: v.ok, errors: v.errors, warnings: v.warnings, file }
}

/** 一个数据文件的体检行(⑧ 页 + /setup 共用)。永不抛。 */
export function fileStatus (name, { dir = resolveDataDir() } = {}) {
  const file = String(name)
  const spec = specOf(file)
  const row = {
    file, exists: false, empty: false, broken: false, unreadable: false,
    bytes: 0, schemaRev: null, fieldCount: spec ? spec.fields.length : 0,
    errors: [], warnings: [], deepLink: deepLinkOf(file), hint: HINT_BY_FILE[file] ?? '',
    mtime: null
  }
  try {
    const path = pathOf(file, dir)
    if (!existsSync(path)) return row
    row.exists = true
    row.bytes = statSync(path).size
    row.mtime = statSync(path).mtime.toISOString()
    const got = readDataFile(file, { dir })
    if (got.unreadable) {
      row.broken = true
      row.unreadable = true
      row.errors = ['JSON 解析失败:' + (got.parseError || '未知')]
      return row
    }
    row.schemaRev = got.value?.schemaRev ?? null
    const v = validateDataFile(file, got.value)
    row.errors = v.errors
    row.warnings = v.warnings
    row.empty = isEmptyContent(file, got.value)
    return row
  } catch (err) {
    row.broken = true
    row.errors = [String(err?.message ?? err)]
    return row
  }
}

/**
 * "这份内容算不算空" —— 只看**用户意图字段**:空串 / 空数组 / null 都算空。
 * 有任何一个字段填了值就不算空。数字 0 算**填了**(0 是有意义的取值,不替用户做主)。
 * `schemaRev` / `updatedAt` / `appliedMigrations` 是**结构记账**,不是用户意图 ⇒ 不算数。
 */
const STRUCTURAL_KEYS = ['schemaRev', 'updatedAt', 'appliedMigrations']

/** 空值口径:`''`(含全空白)/ `[]` / `{}` / `null` / `undefined` / `false`(默认态,不是填过的值)。 */
function isEmptyValue (v) {
  if (v === undefined || v === null || v === false) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v).length === 0
  return false
}

export function isEmptyContent (name, obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return true
  const spec = specOf(String(name))
  // 字段表 ∪ 对象自己的键:表里没登记但用户写进去的值,也算"填过"(不吞用户数据)
  const keys = new Set([
    ...(spec ? spec.fields.map((f) => f.key) : []),
    ...Object.keys(obj)
  ])
  for (const k of keys) {
    if (STRUCTURAL_KEYS.includes(k)) continue
    if (!isEmptyValue(obj[k])) return false
  }
  return true
}

/**
 * 配置状态体检(§6.3 `GET /api/echo/setup` 的唯一数据源)。
 * `configured` = 8 个文件里**至少一个**存在且不空(用户真填过东西)。
 * 永不抛。
 */
export function setupStatus ({ dir = resolveDataDir() } = {}) {
  const files = []
  try {
    for (const f of DATA_FILES) files.push(fileStatus(f, { dir }))
  } catch (err) {
    return {
      configured: false, dataDir: String(dir), checkedAt: new Date().toISOString(),
      programRev: null, files: [], missing: [], empty: [], broken: [],
      backup: { count: 0, newest: null },
      hints: [], error: String(err?.message ?? err)
    }
  }
  const missing = files.filter((f) => !f.exists).map((f) => f.file)
  const empty = files.filter((f) => f.exists && f.empty).map((f) => f.file)
  const broken = files.filter((f) => f.broken).map((f) => f.file)
  const configured = files.some((f) => f.exists && !f.empty && !f.broken)
  // 备份概览(⑧ 页一屏要看"有几个备份、最新的是哪个";只数不删)
  const baks = listBackups({ dir })
  return {
    configured,
    dataDir: String(dir),
    checkedAt: new Date().toISOString(),
    files,
    missing,
    empty,
    broken,
    backup: { count: baks.length, newest: baks[0]?.name ?? null },
    hints: [...missing, ...empty, ...broken].map((file) => ({
      file, deepLink: deepLinkOf(file), hint: HINT_BY_FILE[file] ?? '这个文件还没填'
    }))
  }
}

// ── 备份 ────────────────────────────────────────────────────────────────

function stampOf (now) {
  return String(now).replace(/[:.]/g, '-')
}

/** 把备份文件反查成"它备份的是哪个数据文件"(认不出来回 null —— 老的手工备份就是这种)。 */
export function backupForFileOf (entryName) {
  for (const f of DATA_FILES) {
    if (entryName === f || entryName.startsWith(f + '.')) return f
    if (entryName.startsWith(f.replace(/\.json$/, '') + '-')) return f
  }
  return null
}

/**
 * 手动/自动备份一个数据文件到 `backup/<file>.<ts>.bak`。
 * 文件不存在 ⇒ `{backedUp: false}`(没什么可备份的,不算错)。
 * 写不进去 ⇒ 抛 `backup-failed`(**调用方必须中止,不许继续写**)。
 */
export function backupDataFile (name, { dir = resolveDataDir(), now = new Date().toISOString() } = {}) {
  const file = String(name)
  if (!isWritableFile(file)) {
    throw new DataWriteError('not-allowed', '不在白名单里的文件:' + file)
  }
  const path = pathOf(file, dir)
  if (!existsSync(path)) return { file, backedUp: false, path: '', bytes: 0 }
  const bdir = backupDirOf(dir)
  const target = join(bdir, file + '.' + stampOf(now) + '.bak')
  try {
    mkdirSync(bdir, { recursive: true })
    copyFileSync(path, target)
    return { file, backedUp: true, path: target, bytes: statSync(target).size }
  } catch (err) {
    throw new DataWriteError('backup-failed', '备份失败,已中止(旧文件原样保留)',
      { detail: String(err?.message ?? err) })
  }
}

/** 备份清单(⑧ 页只列不删)。永不抛。 */
export function listBackups ({ dir = resolveDataDir(), limit = 50 } = {}) {
  const bdir = backupDirOf(dir)
  const rows = []
  try {
    if (!existsSync(bdir)) return rows
    for (const entry of readdirSync(bdir)) {
      const full = join(bdir, entry)
      let st = null
      try { st = statSync(full) } catch { continue }
      if (!st.isFile()) continue
      rows.push({
        name: entry,
        file: backupForFileOf(entry),
        bytes: st.size,
        mtime: st.mtime.toISOString()
      })
    }
  } catch { return rows }
  rows.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
  return rows.slice(0, Math.max(1, Number(limit) || 50))
}

// ── 写 ──────────────────────────────────────────────────────────────────

/**
 * 唯一写入口。**校验不过就一个字节都不写**;先备份再写;原子替换。
 *
 * @param {string} name 白名单里的文件名
 * @param {object} obj 该文件的**完整**新内容(不是 patch)
 * @param {{dir?: string, now?: string, actor?: string, backup?: boolean}} [opts]
 * @returns {{ok: true, file: string, savedAt: string, effective: string, backupPath: string, bytes: number, schemaRev: number|null, warnings: string[], notes: string[]}}
 * @throws {DataWriteError} code = not-allowed | invalid | backup-failed | write-failed
 */
export function writeDataFile (name, obj, opts = {}) {
  const file = String(name)
  const dir = opts.dir ?? resolveDataDir()
  const now = opts.now ?? new Date().toISOString()
  if (!isWritableFile(file)) {
    throw new DataWriteError('not-allowed', '不在白名单里的文件:' + file)
  }
  const v = validateDataFile(file, obj)
  if (!v.ok) {
    throw new DataWriteError('invalid', '校验不过,未落盘', { errors: v.errors, warnings: v.warnings })
  }
  // 备份(默认开;`backup:false` 只给"已经备份过"的内部调用用)
  let backupPath = ''
  if (opts.backup !== false) {
    const b = backupDataFile(file, { dir, now })
    backupPath = b.path
  }
  const path = pathOf(file, dir)
  const tmp = path + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  const text = JSON.stringify(obj, null, 2)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)          // 原子替换:同名 rename 在 Windows 上也覆盖
  } catch (err) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }) } catch { /* 清不掉也不能改结论 */ }
    throw new DataWriteError('write-failed', '写盘失败(旧文件原样保留)',
      { detail: String(err?.message ?? err) })
  }
  const notes = invalidate(file, obj, { dir, path })
  return {
    ok: true,
    file,
    savedAt: now,
    effective: effectiveOf(file),
    backupPath,
    bytes: Buffer.byteLength(text, 'utf8'),
    schemaRev: obj?.schemaRev ?? null,
    warnings: v.warnings,
    notes
  }
}

/** 空模板(新装/重建用;不会自动落盘 —— 落盘只能走 `writeDataFile`)。 */
export function templateOf (name) {
  return emptyTemplate(String(name))
}

// ═══════════════════════════════════════════════════════════════════════
// 数据 API(§6.3 的第 2~7 条)
//
// 端点层**只做两件事**:过写保护(`writeAllowed`,回环 Origin + x-echo-edit)、
// 把 body 读出来。其余(白名单、状态码、时序)全在这里 —— 纯函数,不碰 req/res,
// 于是可以拿临时目录把整张状态码表测穿(见 tests/data-api.test.js)。
// ═══════════════════════════════════════════════════════════════════════

const API_PREFIX = '/api/echo/data'

/** 导出包(§6.3 第 6 条):只含白名单文件;`echo.db` 不在白名单 ⇒ 结构上进不来。 */
export function buildExportBundle ({ dir = resolveDataDir(), now = new Date().toISOString() } = {}) {
  const files = {}
  const missing = []
  for (const f of DATA_FILES) {
    try {
      const got = readDataFile(f, { dir })
      if (!got.exists || got.unreadable) { missing.push(f); continue }
      files[f] = got.value
    } catch {
      missing.push(f)
    }
  }
  return { schemaRev: 1, exportedAt: now, program: 'echo', files, missing }
}

/**
 * 导入(§6.3 第 7 条):**整包覆盖**,先备份后覆盖。
 * 顺序:形状 → 白名单(**一个越界就整包不落盘**)→ **逐文件校验全过** → 逐个备份 → 逐个原子写。
 * 不是跨文件事务:逐文件原子写;中途失败会把已写的清单放在 `DataWriteError.detail` 里
 * (备份都在,能还原)。
 */
export function importBundle (bundle, { dir = resolveDataDir(), now = new Date().toISOString() } = {}) {
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new DataWriteError('invalid', '导入包顶层必须是对象', { errors: ['形状不对'] })
  }
  const files = bundle.files
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    throw new DataWriteError('invalid', '导入包缺 files 对象', { errors: ['期望 {files:{<文件名>:<内容>}}'] })
  }
  const names = Object.keys(files)
  if (names.length === 0) {
    throw new DataWriteError('invalid', '导入包是空的,没东西可导', { errors: ['files 里一个文件都没有'] })
  }
  const outside = names.filter((n) => !isWritableFile(n))
  if (outside.length > 0) {
    throw new DataWriteError('not-allowed', '导入包里有不许写的文件(整包未落盘):' + outside.join(', '),
      { errors: outside.map((n) => n + ': 不在白名单') })
  }
  // ① 全部先校验:一个不过 ⇒ 一个字节都不写
  const errors = []
  for (const n of names) {
    const v = validateDataFile(n, files[n])
    if (!v.ok) errors.push(n + ': ' + v.errors.join('; '))
  }
  if (errors.length > 0) {
    throw new DataWriteError('invalid', '导入包有文件没过校验,整包未落盘', { errors })
  }
  // ② 逐个备份(要覆盖哪个就备份哪个)
  const backups = []
  for (const n of names) {
    const b = backupDataFile(n, { dir, now })
    if (b.backedUp) backups.push({ file: n, path: b.path, bytes: b.bytes })
  }
  // ③ 逐个原子写(备份已经做过 ⇒ backup:false,不重复备份)
  const imported = []
  const warnings = []
  for (const n of names) {
    try {
      const r = writeDataFile(n, files[n], { dir, now, backup: false })
      imported.push({ file: n, bytes: r.bytes, effective: r.effective })
      warnings.push(...r.warnings.map((w) => n + ': ' + w))
    } catch (err) {
      throw new DataWriteError(err?.code ?? 'write-failed',
        '导入中途失败(已写:' + imported.map((x) => x.file).join(',') + ' —— 备份都在,可还原)',
        { errors: [String(err?.message ?? err)], detail: JSON.stringify(imported) })
    }
  }
  return {
    ok: true,
    imported,
    backups,
    backupPath: backups[0]?.path ?? '',
    savedAt: now,
    warnings
  }
}

function parseRawFlag (url) {
  const q = String(url).split('?')[1] ?? ''
  return /(^|&)raw=(1|true)(&|$)/.test(q)
}

/**
 * 数据 API 的**全部判定**。返回 `{status, payload}`(端点原样 `json(res, status, payload)`)。
 * @param {{method?: string, url?: string, allowed?: boolean, body?: any, dir?: string, now?: string}} req
 */
export function handleDataRequest (req = {}) {
  const method = String(req.method ?? 'GET').toUpperCase()
  const dir = req.dir ?? resolveDataDir()
  const allowed = req.allowed === true
  const now = req.now
  const path = String(req.url ?? '').split('?')[0]
  if (!path.startsWith(API_PREFIX)) return { status: 404, payload: { error: 'not found' } }
  const rest = path.slice(API_PREFIX.length).replace(/^\/+/, '')
  const seg = rest.split('/').filter((s) => s !== '')
  const decode = (s) => { try { return decodeURIComponent(s) } catch { return s } }

  // POST /api/echo/data/backup
  if (seg.length === 1 && decode(seg[0]) === 'backup') {
    if (method !== 'POST') return { status: 405, payload: { error: 'method not allowed' } }
    if (!allowed) return { status: 403, payload: { error: 'forbidden' } }
    const wanted = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && req.body.file)
      ? [String(req.body.file)]
      : [...DATA_FILES]
    const out = []
    try {
      for (const f of wanted) {
        if (!isWritableFile(f)) return { status: 404, payload: { error: '不在白名单里的文件', file: f } }
        const b = backupDataFile(f, { dir, now: now ?? new Date().toISOString() })
        out.push({ file: f, backedUp: b.backedUp, path: b.path, bytes: b.bytes })
      }
    } catch (err) {
      return { status: 500, payload: { error: String(err?.message ?? err), detail: err?.detail ?? '' } }
    }
    const first = out.find((x) => x.backedUp)
    return {
      status: 200,
      payload: {
        ok: true,
        path: out.length === 1 ? (first?.path ?? '') : '',
        bytes: out.reduce((n, x) => n + x.bytes, 0),
        files: out
      }
    }
  }

  // GET /api/echo/data/backups(⑧ 页的备份清单;**只读、只列不删**)
  if (seg.length === 1 && decode(seg[0]) === 'backups') {
    if (method !== 'GET') return { status: 405, payload: { error: 'method not allowed' } }
    const lim = (() => {
      const q = String(req.url ?? '').split('?')[1] ?? ''
      const m = /(^|&)limit=(\d+)(&|$)/.exec(q)
      return m ? Number(m[2]) : 50
    })()
    let files = listBackups({ dir, limit: lim })
    const only = (() => {
      const q = String(req.url ?? '').split('?')[1] ?? ''
      const m = /(^|&)file=([^&]+)(&|$)/.exec(q)
      return m ? decode(m[2]) : ''
    })()
    if (only !== '') files = files.filter((f) => f.file === only)
    return { status: 200, payload: { ok: true, count: files.length, files } }
  }

  // GET /api/echo/data/export
  if (seg.length === 1 && decode(seg[0]) === 'export') {
    if (method !== 'GET') return { status: 405, payload: { error: 'method not allowed' } }
    return { status: 200, payload: buildExportBundle({ dir, now }) }
  }

  // POST /api/echo/data/import
  if (seg.length === 1 && decode(seg[0]) === 'import') {
    if (method !== 'POST') return { status: 405, payload: { error: 'method not allowed' } }
    if (!allowed) return { status: 403, payload: { error: 'forbidden' } }
    const body = req.body
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 400, payload: { error: 'bad request' } }
    }
    if (body.confirm !== true) {
      return { status: 400, payload: { error: '导入要显式确认', need: 'confirm:true' } }
    }
    try {
      return { status: 200, payload: importBundle(body.bundle ?? body, { dir, now }) }
    } catch (err) {
      if (err instanceof DataWriteError) {
        const status = err.code === 'not-allowed' ? 404 : (err.code === 'invalid' ? 400 : 500)
        return { status, payload: { error: err.message, errors: err.errors, warnings: err.warnings, detail: err.detail } }
      }
      return { status: 500, payload: { error: String(err?.message ?? err) } }
    }
  }

  // /api/echo/data/<file> 与 /api/echo/data/<file>/validate
  if (seg.length >= 1) {
    const file = decode(seg[0])
    const isValidate = seg.length === 2 && decode(seg[1]) === 'validate'
    if (seg.length > 2 || (seg.length === 2 && !isValidate)) {
      return { status: 404, payload: { error: 'not found' } }
    }
    if (!isWritableFile(file)) return { status: 404, payload: { error: '不在白名单里的文件', file } }
    if (isValidate) {
      if (method !== 'POST') return { status: 405, payload: { error: 'method not allowed' } }
      if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return { status: 400, payload: { error: 'bad request' } }
      }
      return { status: 200, payload: validateDataFile(file, req.body) }
    }
    if (method === 'GET') {
      const got = readDataFile(file, { dir })
      // `template` = 该文件的**空模板**(⑧ 页"重建坏文件"要用;它不必先去读别的端点)。
      const template = templateOf(file)
      if (!got.exists) {
        return { status: 200, payload: { file, exists: false, value: null, bytes: 0, template } }
      }
      const payload = {
        file, exists: true, value: got.value, bytes: got.bytes, template
      }
      // `raw` 语义(用户 2026-10-05 明确):**只在"读不出对象"时才回**(坏文件要能被修);
      // 好文件不塞第二遍;`?raw=1` 强制回(给"看原文"按钮)。
      if (got.unreadable || parseRawFlag(req.url)) {
        payload.raw = got.raw
        if (got.unreadable) payload.unreadable = true
        if (got.parseError) payload.parseError = got.parseError
      }
      return { status: 200, payload }
    }
    if (method === 'PUT') {
      if (!allowed) return { status: 403, payload: { error: 'forbidden' } }
      if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return { status: 400, payload: { error: 'bad request(顶层必须是 JSON 对象)' } }
      }
      try {
        return { status: 200, payload: writeDataFile(file, req.body, { dir, now }) }
      } catch (err) {
        if (err instanceof DataWriteError) {
          const status = err.code === 'invalid' ? 400 : (err.code === 'not-allowed' ? 404 : 500)
          return { status, payload: { error: err.message, errors: err.errors, warnings: err.warnings, detail: err.detail } }
        }
        return { status: 500, payload: { error: String(err?.message ?? err) } }
      }
    }
    return { status: 405, payload: { error: 'method not allowed' } }
  }
  return { status: 404, payload: { error: 'not found' } }
}
