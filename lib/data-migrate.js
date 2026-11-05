/**
 * dsh-echo — P3 一次性迁移的**执行器**(门 + 记账 + 幂等;本批不搬值)
 * ============================================================
 * 设计依据:`Desktop\交接\P3迁移设计-2026-10-05.md` §3(何时跑 / 三段版本位)、
 * §4(记账键 / 形状 / 幂等三规则)、§6 风险 6。
 *
 * 跑在哪:**T1 = 插件挂载时自动**(`lib/index.js:1240-1245` 那条 boot 链上,
 * `ensureDataDir()` 之后、`loadPersona()` 之前);`scripts/install.mjs --migrate`
 * 只是运维口(看 / 重跑 / 干跑),不是必经 —— 新装用户没有别的入口。
 *
 * 每个键三步(P3 设计 §4.3,缺一不可):
 *   ① **门先判** —— `appliedMigrations` 里有这个键 ⇒ skipped,一次都不重复执行;
 *   ② **写前快照** —— 先算目标值摘要 `before`,再算要写的 `after`;两者相等 ⇒
 *      **不写文件、只记账**(防"跑两遍把 mtime 改了"这类不幂等);
 *   ③ **失败不记账** —— 写盘失败 ⇒ **不 append 这个键**、`notes[]` 追一行原因,
 *      下次开机重试。
 *
 * ⚠️ 本批(B4)的边界:**不实现"该搬的值"**。B1/B2/B3 在别处加**读点**(词表、
 *   关系表、状态初值怎么读数据),执行器只管"门 + 记账 + 幂等" —— 所以生产路径上
 *   17 个键一律走"摘要相等 ⇒ 只记账"(值来源 `noValueMove` 永远返回 undefined,
 *   即"没有要搬的值")。值来源留成注入点 `desiredOf`:`before/after 相等不写盘 /
 *   不相等才写盘 / 写失败不记账` 这三条规则**现在就能被诚实测穿**
 *   (tests/data-migrate.test.js 三个注入用例)。
 *
 * ⚠️ P3 **不** bump `schemaRev` / `dataRev`(设计 §3.2):这批改的是"字段的有无",
 *   不是"旧程序会读错的破坏性改形" —— 加字段不 bump 也不会让任何读点出错。
 *   记账的 `dataRev` 由 `appendAppliedMigrations` **原样保留**(追加不是改版)。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_REV_FILE } from './data-schema.js'
import {
  KNOWN_MIGRATIONS, appendAppliedMigrations, firstInstallOf, isEmptyValue, resolveDataDir
} from './data-dir.js'
import { isEmptyContent, writeDataFile } from './data-write.js'

/**
 * 键 → 目标位置(设计 §4.2 的表,逐字照抄;**17 个键一个不许少、不许改名**)。
 *   `file: null`   = **代码级迁移** —— 只标记"那段代码改完了",不写任何数据文件。
 *   `path: null`   = 整份文件(初值种子那种一个键管多字段的);
 *   其余 `path`     = 字段在文件里的路径(数组,可嵌套)。
 */
export const MIGRATION_TARGETS = Object.freeze({
  'p3.lexicon-topic-stopwords': { file: 'lexicon.json', path: ['topicStopwords'] },
  'p3.lexicon-power-words': { file: 'lexicon.json', path: ['powerWords'] },
  'p3.lexicon-longing-markers': { file: 'lexicon.json', path: ['longingMarkers'] },
  'p3.lexicon-time-words': { file: 'lexicon.json', path: ['timeWords'] },
  'p3.lexicon-stopwords': { file: 'lexicon.json', path: ['stopwords'] },
  'p3.graph-relations-single-value': { file: 'graph.json', path: ['relations', 'singleValue'] },
  'p3.graph-relations-multi-keys': { file: 'graph.json', path: ['relations', 'multiValueKeys'] },
  'p3.graph-relations-canonical': { file: 'graph.json', path: ['relations', 'canonical'] },
  'p3.graph-relations-pending': { file: 'graph.json', path: ['relations', 'pending'] },
  'p3.graph-relations-type-rules': { file: 'graph.json', path: ['relations', 'typeRules'] },
  'p3.graph-relations-default': { file: 'graph.json', path: ['relations', 'defaultRelation'] },
  'p3.graph-relations-identity': { file: 'graph.json', path: ['relations', 'identityRelations'] },
  'p3.graph-display-tuning': { file: 'graph.json', path: ['display'] },
  'p3.graph-night-window': { file: 'graph.json', path: ['windows'] },
  'p3.state-defaults-seed': { file: 'state-defaults.json', path: null },
  // 这两条不写数据文件:它们是"程序侧做完了"的标记(设计 §4.2 的两条 [待定] 建议进)
  'p3.profile-address-fallback': { file: null, path: null },
  'p3.names-script-readers': { file: null, path: null }
})

/**
 * 本批的值来源:**永远"没有要搬的值"**(undefined)。
 *
 * 不是偷懒,是分工 —— B4 只做记账;等某个键真有值可导(T2 种子导入,设计 §2.1),
 * 由那一批把值来源接进 `desiredOf`。留着这个口,是为了让"摘要相等 ⇒ 不写盘"
 * 这条规则**能被测出真假**(不然它永远是句空话)。
 */
export function noValueMove () {
  return undefined
}

/** 摘要用的规范化字符串:对象键排序、数组保序 —— "值变了没有"只认它,不认文件字节。 */
function stableStringify (v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  if (v !== null && typeof v === 'object') {
    return '{' + Object.keys(v).sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
  }
  return v === undefined ? 'undefined' : JSON.stringify(v)
}

const digestOf = (v) => stableStringify(v)

/** 沿路径取值(path === null ⇒ 整份对象);路上撞到非对象就当"没有这个值"。 */
function readAt (obj, path) {
  if (path === null) return obj
  let cur = obj
  for (const k of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

/** 沿路径写值(浅拷贝,不动传进来的对象);中间层缺/不是对象 ⇒ 补一个空对象。 */
function setAt (obj, path, value) {
  const next = { ...(obj ?? {}) }
  let cur = next
  for (let i = 0; i < path.length - 1; i += 1) {
    const k = path[i]
    const child = cur[k]
    cur[k] = child !== null && typeof child === 'object' && !Array.isArray(child) ? { ...child } : {}
    cur = cur[k]
  }
  cur[path[path.length - 1]] = value
  return next
}

/** 读一份数据文件成对象;缺 / 坏 / 读不出来 ⇒ null(按"字段为空"处理,不判坏 —— 风险 2)。 */
function readFileObject (path) {
  try {
    if (!existsSync(path)) return null
    const obj = JSON.parse(readFileSync(path, 'utf8'))
    return obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? obj : null
  } catch {
    return null
  }
}

const dirOf = (dir) => (typeof dir === 'string' && dir.trim() !== '' ? dir : resolveDataDir())

const stamp = (iso, key, text) => iso + ' ' + key + ': ' + text

/**
 * 纯只读计划:现在跑一遍**会做什么**(给 `--dry-run` / doctor 用,一个字节都不写)。
 * @param {{dir?: string}} [opts]
 * @returns {{dir: string, firstInstall: boolean, filled: string[], applied: string[],
 *   pending: string[], done: string[]}}
 */
export function planMigrations ({ dir } = {}) {
  const root = dirOf(dir)
  const applied = readApplied(root)
  const fi = firstInstallOf({ dir: root })
  return {
    dir: root,
    firstInstall: fi.firstInstall,
    filled: fi.filled,
    applied,
    pending: KNOWN_MIGRATIONS.filter((k) => !applied.includes(k)),
    done: KNOWN_MIGRATIONS.filter((k) => applied.includes(k))
  }
}

/** 盘上的 appliedMigrations(读过 data-rev.json 的现读值;缺 ⇒ 空)。 */
function readApplied (root) {
  const obj = readFileObject(join(root, DATA_REV_FILE))
  if (obj === null || !Array.isArray(obj.appliedMigrations)) return []
  return obj.appliedMigrations.filter((x) => typeof x === 'string' && x !== '')
}

/**
 * 跑一条迁移(内部件,不外抛 —— 出口只有 `migrateDataDir`,免得多一条没人管的 API)。
 *
 * @param {string} key KNOWN_MIGRATIONS 里的键
 * @param {object} ctx
 * @param {string} ctx.dir 数据目录
 * @param {boolean} ctx.firstInstall 首装 ⇒ 没有可搬的旧值(设计 §3.3)
 * @param {(key: string, info: object) => any} ctx.desiredOf 值来源(本批恒 undefined)
 * @param {(name: string, obj: object) => void} ctx.writeFile 落盘口(默认唯一写路径)
 * @param {string} ctx.iso 记账时间戳
 * @returns {{ok: boolean, wrote: boolean, file: string|null, note: string, reason: string}}
 */
function applyMigration (key, ctx) {
  const { dir, firstInstall, desiredOf, writeFile, iso } = ctx
  const target = MIGRATION_TARGETS[key]
  if (target === undefined) {
    return { ok: false, wrote: false, file: null, note: '', reason: 'MIGRATION_TARGETS 里没登记这个键' }
  }
  // 代码级迁移:程序侧改完了 ⇒ 只记账,不碰数据文件
  if (target.file === null) {
    return {
      ok: true,
      wrote: false,
      file: null,
      note: stamp(iso, key, firstInstall ? '首次安装 ⇒ 只记账(代码级迁移)' : '代码级迁移 ⇒ 只记账(不动数据文件)'),
      reason: ''
    }
  }
  const obj = readFileObject(join(dir, target.file))
  const current = obj === null ? undefined : readAt(obj, target.path)
  const before = digestOf(current)
  // ① 首装:没有可搬的旧值 —— 跳过(不读值来源、不写盘);② 本批值来源恒 undefined ⇒ 摘要相等
  const desired = firstInstall ? undefined : desiredOf(key, { file: target.file, path: target.path, current })
  const after = desired === undefined ? before : digestOf(desired)
  if (after === before) {
    // "空"还是"已有值":单字段看值,整份文件看"除结构记账键之外有没有东西"
    // (`p3.state-defaults-seed` 那种 path===null 的键,空模板本身就是"一堆 null",不是已有值)
    const empty = target.path === null
      ? (obj === null || isEmptyContent(target.file, obj))
      : isEmptyValue(current)
    const why = empty
      ? (firstInstall ? '首次安装,目标字段空 ⇒ 未写(等他自己填或程序兜底)' : '空 ⇒ 未写(等他自己填或程序兜底)')
      : '已有值 ⇒ 一字不动,只补记账'
    return { ok: true, wrote: false, file: target.file, note: stamp(iso, key, why), reason: '' }
  }
  // 摘要真的变了 ⇒ 才落盘;写失败 ⇒ 不记账(由调用方跳过登记)
  // ⚠️ 必须把 `dir` 传下去:`writeDataFile` 不传 dir 会落到 **真实数据目录**
  //   (它的默认值是 `resolveDataDir()`)—— 测试里那就等于往他家里写垃圾。
  const next = target.path === null ? desired : setAt(obj, target.path, desired)
  try {
    writeFile(target.file, next, { dir })
  } catch (err) {
    return {
      ok: false,
      wrote: false,
      file: target.file,
      note: '',
      reason: '写 ' + target.file + ' 失败:' + String(err?.message ?? err)
    }
  }
  return {
    ok: true,
    wrote: true,
    file: target.file,
    note: stamp(iso, key, '写入 ' + target.file + '(摘要变过才落盘)'),
    reason: ''
  }
}

/**
 * 跑一遍这批迁移(**挂载时自动调用**;永不抛错,与 `ensureDataDir` 同姿势)。
 *
 * @param {object} [opts]
 * @param {string} [opts.dir] 数据目录(默认 `resolveDataDir()`)
 * @param {{info?: Function, warn?: Function}} [opts.logger]
 * @param {string} [opts.now] 注入时间(测试用,ISO 字符串)
 * @param {boolean} [opts.dryRun] 干跑:只算计划、只回报告,**一个字节都不写**
 * @param {(key: string, info: object) => any} [opts.desiredOf] 值来源(默认 `noValueMove`)
 * @param {(name: string, obj: object) => void} [opts.writeFile] 落盘口(默认唯一写路径 `writeDataFile`)
 * @returns {{dir: string, ok: boolean, dryRun: boolean, firstInstall: boolean, planned: string[],
 *   applied: string[], registered: string[], skipped: string[], wrote: string[], failed: Array,
 *   notes: string[], error: string}}
 */
export function migrateDataDir (opts = {}) {
  const info = (m) => { try { opts.logger?.info?.(m) } catch { /* logger 坏了不该影响迁移 */ } }
  const warn = (m) => { try { opts.logger?.warn?.(m) } catch { /* 同上 */ } }
  const root = dirOf(opts.dir)
  const iso = typeof opts.now === 'string' && opts.now.trim() !== '' ? opts.now : new Date().toISOString()
  const dryRun = opts.dryRun === true
  const out = {
    dir: root,
    ok: true,
    dryRun,
    firstInstall: false,
    planned: [],
    applied: [],
    registered: [],
    skipped: [],
    wrote: [],
    failed: [],
    notes: [],
    error: ''
  }
  try {
    const plan = planMigrations({ dir: root })
    out.firstInstall = plan.firstInstall
    out.applied = plan.applied
    out.skipped = [...plan.done]
    // 干跑:只报计划(设计 §3.1 的 T3-③)
    if (dryRun) {
      out.planned = [...plan.pending]
      for (const key of plan.pending) {
        out.notes.push(stamp(iso, key, plan.firstInstall ? '干跑:首次安装 ⇒ 会跳过并登记(不写盘)' : '干跑:会过门 + 记账(本批不搬值)'))
      }
      return out
    }
    const desire = typeof opts.desiredOf === 'function' ? opts.desiredOf : noValueMove
    const write = typeof opts.writeFile === 'function' ? opts.writeFile : writeDataFile
    for (const key of plan.pending) {
      const step = applyMigration(key, { dir: root, firstInstall: plan.firstInstall, desiredOf: desire, writeFile: write, iso })
      if (!step.ok) {
        // ③ 失败不记账:这个键不 append,留到下次开机重试
        out.ok = false
        out.failed.push({ key, reason: step.reason })
        out.notes.push(stamp(iso, key, '失败 ⇒ 不记账,下次开机重试(' + step.reason + ')'))
        warn('echo: 迁移 ' + key + ' 没跑成(不记账,下次开机重试):' + step.reason)
        continue
      }
      out.registered.push(key)
      out.notes.push(step.note)
      if (step.wrote) out.wrote.push(step.file)
    }
    if (out.registered.length > 0 || out.notes.length > 0) {
      const led = appendAppliedMigrations(out.registered, { dir: root, now: iso, notes: out.notes })
      if (!led.ok) {
        // 记账本身写不进去 ⇒ 一个键都没记下(下次开机整批重来);不抛错,报在返回值里
        out.ok = false
        out.registered = []
        out.failed.push({ key: DATA_REV_FILE, reason: led.reason })
        warn('echo: 迁移记账写不进去(本次一个键都没记下,下次开机重来):' + led.reason)
      } else {
        out.applied = led.applied
      }
    }
    info('echo: 一次性迁移:登记 ' + out.registered.length + ' 项,已登记跳过 ' + out.skipped.length + ' 项,写盘 '
      + out.wrote.length + ' 个文件' + (out.failed.length > 0 ? ',失败 ' + out.failed.length + ' 项(不记账)' : '')
      + (out.firstInstall ? '(首次安装 ⇒ 全部跳过并登记)' : ''))
  } catch (err) {
    out.ok = false
    out.error = String(err?.message ?? err)
    warn('echo: 迁移执行器抛错(已兜住,挂载不受影响):' + out.error)
  }
  return out
}
