/**
 * dsh-echo — 一次性子代理会话回收器(纯逻辑 + 可注入 IO,可单测)
 * ============================================================
 * 现场:宿主**不会**删除跑完的一次性子代理会话,`~/.dsh/sessions/<workspace>/<sid>/`
 * 越积越多(实测 835 个)。每个目录里基本只有一个
 * `session.v4.jsonl.zstd`(zstd 压缩的 JSONL,第一行是会话头 JSON)。
 *
 * 判据只有一个:**头部 JSON 里 `"origin":"subagent"`** 才算子代理会话;主对话
 * 没有 origin 字段(或 origin 是别的值)。判不出来的(`unknown`:没 .zstd、
 * 解压失败、头部没有 origin 且退回整文件解压也失败、权限错误…)一律**保留**,
 * 只在返回值里单独列出来给人看 —— 这个模块宁可漏收,也绝不误删他的主对话。
 *
 * 保留窗口:默认是**轮数窗口**,而且**按父各算各的** —— `lib/session-window.js`
 * 给每个主对话算「最近 `DEFAULT_WINDOW_TURNS` 轮用户消息」的边界(A 的 subagent 只看
 * A 的边界,B 的只看 B 的,**不跨会话取 min**);父读到的轮数 < N(历史被截断)⇒ 该父
 * 名下全留。算不出来就退回固定时长窗口(`now - windowMs`),并在
 * `result.turnBoundary.fallback` 里标明;孤立子代理(父不在表里)一律保留。
 *
 * 安全纪律:
 *   1. 默认 dry-run:`apply === true` 才真删,否则一个文件都不碰。
 *   2. 只删 `kind === 'subagent'`,`main` / `unknown` 一律留。
 *   3. 保留窗口取**并集**:mtime 在自己父的边界之内(或全局 `now - windowMs` 之内)
 *      **或** 按 mtime 从新到旧排名 < keepNewest —— 满足任一条就留。
 *   4. 删之前先把待删清单落盘(audit),apply 时清单**先写完**再动手。
 *   5. fail-soft:单条失败只 `log.warn`,继续处理其余,整个函数**绝不抛异常**。
 *
 * 本模块是纯 ESM、零第三方依赖,IO 全部可从参数注入(readFile / rm / mkdir /
 * writeFile / log),所以单测能在临时目录里造夹具,不碰真实的 ~/.dsh。
 */
import { createReadStream } from 'node:fs'
import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  readdir as fsReaddir,
  rm as fsRm,
  stat as fsStat,
  writeFile as fsWriteFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib'

/** 默认保留窗口:2 小时。 */
export const DEFAULT_WINDOW_MS = 2 * 60 * 60 * 1000
/** 默认保留最新的 N 个会话(2026-10-05 拍板:0 = 不设排名兜底)。 */
export const DEFAULT_KEEP_NEWEST = 0
/** 默认「最近 N 轮对话」的轮数(轮数窗口的 N;2026-10-05 拍板 300→20)。 */
export const DEFAULT_WINDOW_TURNS = 20
/** 头部只读这么多解压后的字节;够了就 destroy。 */
export const DEFAULT_HEAD_BYTES = 8192

/** 会话头所在文件名(通常只有这一个文件)。 */
export const SESSION_FILE = 'session.v4.jsonl.zstd'

// ═══════════════════════════════════════════════════════════════════════
// 小工具
// ═══════════════════════════════════════════════════════════════════════

/** 把任意异常压成一行短说明(日志/why 用,不抛)。 */
function msg (err) {
  if (err && typeof err.message === 'string' && err.message) return err.message
  return String(err)
}

/** 数字兜底:非法值一律用 fallback。 */
function num (v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 本地时间戳 `yyyyMMdd-HHmmss`(审计文件名用)。 */
export function manifestStamp (ms) {
  const d = new Date(num(ms, Date.now()))
  const p = (n) => String(n).padStart(2, '0')
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

/** 默认路径(~/.dsh/...);可用 DSH_HOME 改根目录。 */
export function defaultPaths (env = process.env) {
  const home = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return {
    sessionsRoot: join(home, 'sessions'),
    projcacheRoot: join(home, 'storages', 'session_projcache', 'sessions'),
    auditDir: join(home, 'echo', 'audit')
  }
}

/** 取第一行当 JSON 解析;不像 JSON 就当解析不出来(返回 null)。 */
function parseFirstJson (text) {
  if (typeof text !== 'string' || text === '') return null
  const line = text.split('\n', 1)[0].trim()
  if (line === '' || line[0] !== '{') return null
  try {
    const obj = JSON.parse(line)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj
    return null
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 只解压头部(性能关键:会话文件可能几十 MB,但头在第一行)
// ═══════════════════════════════════════════════════════════════════════

/**
 * 用 `createZstdDecompress()` 流读**头部**:解压输出攒到 `headBytes` 就
 * `destroy()` 收工,不把整文件解压进内存。整段文本返回(可能被截断)。
 */
function readHeadText (filePath, headBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false
    let rs = null
    let zs = null
    const settle = (err, text) => {
      if (settled) return
      settled = true
      try { if (rs) rs.destroy() } catch { /* 忽略 */ }
      try { if (zs) zs.destroy() } catch { /* 忽略 */ }
      if (err) reject(err)
      else resolve(text)
    }
    try {
      rs = createReadStream(filePath)
      zs = createZstdDecompress()
    } catch (err) {
      settle(err || new Error('stream-create-failed'))
      return
    }
    rs.on('error', (err) => settle(err))
    zs.on('error', (err) => settle(err))
    zs.on('data', (chunk) => {
      chunks.push(chunk)
      total += chunk.length
      if (total >= headBytes) settle(null, Buffer.concat(chunks).toString('utf8'))
    })
    zs.on('end', () => settle(null, Buffer.concat(chunks).toString('utf8')))
    zs.on('close', () => settle(null, Buffer.concat(chunks).toString('utf8')))
    rs.pipe(zs)
  })
}

// ═══════════════════════════════════════════════════════════════════════
// classifySessionDir —— 只读地认一个会话目录
// ═══════════════════════════════════════════════════════════════════════

/**
 * 内部版:比对外版多一个 `why`(unknown 的原因)。reapSessions 用这个。
 *
 * @param {string} dirPath 会话目录
 * @param {{headBytes?:number, stat?:Function, readdir?:Function, readFile?:Function}} [opts]
 */
async function classifyDetailed (dirPath, opts = {}) {
  const o = opts || {}
  const headBytes = Math.max(1, num(o.headBytes, DEFAULT_HEAD_BYTES))
  const statFn = typeof o.stat === 'function' ? o.stat : fsStat
  const readdirFn = typeof o.readdir === 'function' ? o.readdir : fsReaddir
  const readFileFn = typeof o.readFile === 'function' ? o.readFile : fsReadFile

  const sid0 = basename(String(dirPath || '')) || String(dirPath || '')
  const base = { sid: sid0, kind: 'unknown', origin: null, parentSession: null, bytes: 0, mtimeMs: 0 }

  // 目录本身的信息(mtime 就是保留窗口的判据,mtimeMs 拿不到就退到 0)
  let mtimeMs = 0
  try {
    const st = await statFn(dirPath)
    mtimeMs = num(st?.mtimeMs, 0)
  } catch (err) {
    return { ...base, why: 'stat-failed:' + msg(err) }
  }

  // 目录里的 .zstd(通常只有 session.v4.jsonl.zstd 一个)
  let names = []
  try {
    names = await readdirFn(dirPath)
  } catch (err) {
    return { ...base, mtimeMs, why: 'readdir-failed:' + msg(err) }
  }
  const zstds = (Array.isArray(names) ? names : [])
    .map((n) => String(n))
    .filter((n) => n.toLowerCase().endsWith('.zstd'))
  if (zstds.length === 0) return { ...base, mtimeMs, why: 'no-zstd' }
  const pick = zstds.includes(SESSION_FILE) ? SESSION_FILE : zstds[0]
  const filePath = join(dirPath, pick)

  let bytes = 0
  try {
    const st = await statFn(filePath)
    bytes = num(st?.size, 0)
  } catch (err) {
    return { ...base, mtimeMs, why: 'file-stat-failed:' + msg(err) }
  }

  // ① 先只解压头部;② 头部里没有 origin 才退回整文件解压;③ 都不行 = unknown
  let header = null
  let why = ''
  try {
    header = parseFirstJson(await readHeadText(filePath, headBytes))
  } catch (err) {
    why = 'head-stream-failed:' + msg(err)
  }
  if (!header || header.origin === undefined) {
    try {
      const raw = await readFileFn(filePath)
      const full = parseFirstJson(zstdDecompressSync(raw).toString('utf8'))
      if (full) header = full
      else if (!header) why = why || 'bad-header'
    } catch (err) {
      if (!header) {
        return { ...base, mtimeMs, bytes, why: why || ('decompress-failed:' + msg(err)) }
      }
    }
  }
  if (!header) return { ...base, mtimeMs, bytes, why: why || 'bad-header' }

  const origin = header.origin === undefined || header.origin === null
    ? null
    : String(header.origin).trim()
  const sid = typeof header.id === 'string' && header.id.trim() !== '' ? header.id.trim() : sid0
  return {
    sid,
    kind: origin === 'subagent' ? 'subagent' : 'main',
    origin,
    parentSession: header.parentSession === undefined || header.parentSession === null
      ? null
      : String(header.parentSession),
    bytes,
    mtimeMs,
    why: ''
  }
}

/**
 * 只读地认一个会话目录,返回
 * `{ sid, kind: 'subagent'|'main'|'unknown', origin, parentSession, bytes, mtimeMs }`。
 * 不删任何东西;任何失败(权限/解压/缺文件)都折成 `kind: 'unknown'`,不抛。
 */
export async function classifySessionDir (dirPath, opts) {
  let d
  try {
    d = await classifyDetailed(dirPath, opts)
  } catch (err) {
    d = { sid: basename(String(dirPath || '')) || String(dirPath || ''), kind: 'unknown', origin: null, parentSession: null, bytes: 0, mtimeMs: 0 }
  }
  return {
    sid: d.sid,
    kind: d.kind,
    origin: d.origin,
    parentSession: d.parentSession,
    bytes: d.bytes,
    mtimeMs: d.mtimeMs
  }
}

// ═══════════════════════════════════════════════════════════════════════
// turnBoundaryFromTimes —— 纯函数:每个主对话各算各的轮数窗口
// ═══════════════════════════════════════════════════════════════════════

/**
 * 从**每个主对话**的用户消息时间戳,各算各的「最近 `turns` 轮」窗口。
 *
 * 每会话(独立,互不干扰):
 *   - `times.length >= turns`:拿到真实数据 ⇒
 *     `boundaryMs = times[times.length - turns]`(最近 N 轮里最早那条),
 *     `keepAll = false`,`partial = false`;
 *   - `times.length < turns`(历史被截断):它的过程数据**全在窗口内** ⇒
 *     `keepAll = true`,`boundaryMs = null`,`partial = true`
 *     —— **不**拿它的最早时间当边界,绝不把窗口拉到极早;
 *   - 一条用户消息都没有:同样 `keepAll = true`。
 *
 * **不跨会话取 min**:A 主对话的子代理只看 A 的边界,B 的只看 B 的。
 * `byParent[sid]`:`null` 表示"该父名下全留";数字表示该父名下的窗口边界。
 * `latestMs` = 所有真实边界的**最大值**(备用/诊断,不参与默认判据)。
 *
 * @param {{turns?:number, sessions?:Array<{sid?:string, times?:number[]}>}} [opts]
 * @returns {{windows:Array<{sid:string,turnsUsed:number,boundaryMs:number|null,partial:boolean,keepAll:boolean}>,
 *            byParent:Record<string, number|null>, latestMs:number|null, partial:boolean}|null}
 *          一个会话都没有 ⇒ `null`(绝不用猜测值)
 */
export function turnBoundaryFromTimes (opts = {}) {
  const o = opts || {}
  const turns = Math.max(1, Math.floor(num(o.turns, DEFAULT_WINDOW_TURNS)))
  const list = Array.isArray(o.sessions) ? o.sessions : []

  const windows = []
  for (const s of list) {
    if (!s || typeof s !== 'object') continue
    // 连 times 字段都没有 ⇒ 不是一条像样的输入,跳过(skip ≠ 判它全留)
    if (!Array.isArray(s.times)) continue
    const sid = s.sid === undefined || s.sid === null ? '' : String(s.sid)
    const times = s.times
      .map((t) => Number(t))
      .filter((t) => Number.isFinite(t) && t > 0)
      .sort((a, b) => a - b)
    if (times.length === 0) {
      windows.push({ sid, turnsUsed: 0, boundaryMs: null, partial: true, keepAll: true })
      continue
    }
    const keepAll = times.length < turns
    const n = Math.min(turns, times.length)
    windows.push({
      sid,
      turnsUsed: n,
      boundaryMs: keepAll ? null : times[times.length - n],
      partial: keepAll,
      keepAll
    })
  }
  if (windows.length === 0) return null

  const byParent = {}
  for (const w of windows) byParent[w.sid] = w.keepAll ? null : w.boundaryMs
  let latestMs = null
  for (const w of windows) {
    if (w.keepAll) continue
    if (latestMs === null || w.boundaryMs > latestMs) latestMs = w.boundaryMs
  }
  return { windows, byParent, latestMs, partial: windows.some((w) => w.partial) }
}

// ═══════════════════════════════════════════════════════════════════════
// planReap —— 纯函数:谁能留、谁该收
// ═══════════════════════════════════════════════════════════════════════

/** 从 `boundaryByParent`(对象或 Map)里取一个父的窗口值;没这个键 ⇒ undefined。 */
function parentWindowOf (byParent, pid) {
  if (byParent === null || byParent === undefined) return undefined
  if (byParent instanceof Map) return byParent.get(pid)
  if (typeof byParent === 'object') {
    return Object.prototype.hasOwnProperty.call(byParent, pid) ? byParent[pid] : undefined
  }
  return undefined
}

/**
 * 输入 classify 结果数组,切出 `{ keep, reap }`。
 *
 * 保留 = 两条取**并集**(满足任一条就留):
 *   A. 在保留窗口之内。
 *      - 给了 `boundaryByParent`(**按父各算各的**,推荐):子代理用它
 *        `parentSession` 对应的那个边界 —— `mtimeMs >= 该边界` 才留;
 *        `null` 表示"该父 partial ⇒ 全留";父不在表里/没有 parentSession
 *        (**孤立子代理**)⇒ 保守**保留**。
 *      - 否则用 `boundaryMs`(有限正数,全局轮数窗口)或 `now - windowMs`(时长窗口)。
 *   B. 按 mtimeMs 从新到旧排序后**在子代理会话里**的排名 < keepNewest。
 * 其余子代理会话进 `reap`。`main` / `unknown` / 其它 kind 一律进 `keep`。
 *
 * 注 1:排名只在 `kind === 'subagent'` 之间排 —— main/unknown 本来就不删,
 * 不该占用 keepNewest 的名额。
 * 注 2:两条判据的**并集语义不许变**。
 */
export function planReap (entries, opts = {}) {
  const o = opts || {}
  const now = num(o.now, Date.now())
  const windowMs = Math.max(0, num(o.windowMs, DEFAULT_WINDOW_MS))
  const keepNewest = Math.max(0, Math.floor(num(o.keepNewest, DEFAULT_KEEP_NEWEST)))
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === 'object')
  // 全局轮数窗口边界:只在它是有限正数时接管判据,否则退回固定时长
  const rawBoundary = Number(o.boundaryMs)
  const boundaryMs = Number.isFinite(rawBoundary) && rawBoundary > 0 ? rawBoundary : null
  const byParent = o.boundaryByParent === null || o.boundaryByParent === undefined ? null : o.boundaryByParent
  const cutoffDefault = boundaryMs !== null ? boundaryMs : now - windowMs

  const subs = list.filter((e) => e.kind === 'subagent')
  const ranked = [...subs].sort((a, b) => {
    const d = num(b.mtimeMs, 0) - num(a.mtimeMs, 0)
    if (d !== 0) return d
    // 同 mtime 时按 sid 定序,保证结果可复现
    return String(a.sid || '').localeCompare(String(b.sid || ''))
  })
  const rankOf = new Map()
  for (let i = 0; i < ranked.length; i += 1) rankOf.set(ranked[i], i)

  const keep = []
  const reap = []
  for (const e of list) {
    if (e.kind !== 'subagent') { keep.push(e); continue }
    let cutoff = cutoffDefault
    if (byParent !== null) {
      const pid = e.parentSession === null || e.parentSession === undefined ? null : String(e.parentSession)
      const v = pid === null ? undefined : parentWindowOf(byParent, pid)
      // 孤立 / 父 partial(null) / 表里是坏值 ⇒ 保守保留,不进待删
      if (v === undefined || v === null || !Number.isFinite(Number(v))) { keep.push(e); continue }
      cutoff = Number(v)
    }
    const inWindow = num(e.mtimeMs, 0) >= cutoff
    const rank = rankOf.get(e) ?? 0
    if (inWindow || rank < keepNewest) keep.push(e)
    else reap.push(e)
  }
  return { keep, reap }
}

// ═══════════════════════════════════════════════════════════════════════
// reapSessions —— 扫 → 判 → 备份清单 → 删
// ═══════════════════════════════════════════════════════════════════════

/** 默认 log:全部静音(warn 也吞掉)。 */
function makeLog (log) {
  const warn = log && typeof log.warn === 'function' ? log.warn.bind(log) : () => {}
  return (m) => { try { warn(String(m)) } catch { /* 日志自己炸了也不许上来 */ } }
}

function isDir (d) {
  return d && typeof d.isDirectory === 'function' ? d.isDirectory() : true
}

/**
 * 默认的「主对话时间戳」取数器:动态 import `lib/session-window.js`。
 * 模块拿不到 / 算不出来 ⇒ `null`(调用方退回时长窗口)。
 * 动态 import 是故意的:插件启动**不许**依赖这个读接口。
 */
async function defaultListMainTimes (args) {
  try {
    const mod = await import('./session-window.js')
    if (typeof mod?.readMainSessionTurnBoundary === 'function') {
      return await mod.readMainSessionTurnBoundary(args)
    }
    return null
  } catch {
    return null
  }
}

/**
 * 扫描 + 回收。
 *
 * @param {object} [options]
 * @param {string} [options.sessionsRoot]  默认 ~/.dsh/sessions
 * @param {string} [options.projcacheRoot] 默认 ~/.dsh/storages/session_projcache/sessions
 * @param {string} [options.auditDir]      默认 ~/.dsh/echo/audit
 * @param {number} [options.now]           epoch ms,默认 Date.now()
 * @param {number} [options.windowMs]      默认 2h(兜底时长窗口)
 * @param {number} [options.keepNewest]    默认 50
 * @param {number} [options.windowTurns]   「最近 N 轮」的 N,默认 300
 * @param {number} [options.boundaryMs]    直接给定**全局**轮数窗口边界(给了就不去算)
 * @param {Function}[options.listMainTimes] async ({sessionsRoot,turns,log}) =>
 *                                          `{byParent,windows,...}|{boundaryMs,...}|null`;
 *                                          注入用,默认走 `readMainSessionTurnBoundary`。
 *                                          优先用 `byParent`(按父各算各的)。
 * @param {boolean}[options.apply]         只有 === true 才真删
 * @param {object} [options.log]           { warn }
 * @param {Function}[options.readFile] [options.rm] [options.mkdir] [options.writeFile]
 * @returns {Promise<{scanned:number, kept:number, reaped:Array, unknown:Array, freedBytes:number, manifestPath:string|null, applied:boolean, ms:number, turnBoundary:object|null}>}
 *
 * 返回值约定:
 *   - `reaped`:dry-run 时 = **计划要删的**(planReap 的结果,含"会删哪些 projcache");
 *     apply 时 = **真删成功的**(删失败那条不出现,只留 log.warn)。
 *   - `freedBytes`:真释放的字节数,dry-run 恒为 0。
 *   - `manifestPath`:apply 才写(dry-run 恒 null);apply 时清单**先落盘**再删。
 *   - `unknown`:解压不了/没有 .zstd 之类的目录,一律原样留着,单独列出来。
 *   - `ms`:本次真跑实际耗时(毫秒;算轮数窗口 + 读事件的开销都算在内)。
 *   - `turnBoundary`:`{turns,fallback,ms,byParent,windows,partial,sources,orphan}`。
 *     `fallback: true` 表示轮数窗口没算出来,本次用固定时长窗口兜底(`ms = now - windowMs`)。
 */
export async function reapSessions (options = {}) {
  const startedAt = Date.now()
  const o = options || {}
  const dft = defaultPaths()
  const sessionsRoot = typeof o.sessionsRoot === 'string' && o.sessionsRoot ? o.sessionsRoot : dft.sessionsRoot
  const projcacheRoot = typeof o.projcacheRoot === 'string' && o.projcacheRoot ? o.projcacheRoot : dft.projcacheRoot
  const auditDir = typeof o.auditDir === 'string' && o.auditDir ? o.auditDir : dft.auditDir
  const now = num(o.now, Date.now())
  const windowMs = Math.max(0, num(o.windowMs, DEFAULT_WINDOW_MS))
  const keepNewest = Math.max(0, Math.floor(num(o.keepNewest, DEFAULT_KEEP_NEWEST)))
  const windowTurns = Math.max(1, Math.floor(num(o.windowTurns, DEFAULT_WINDOW_TURNS)))
  const apply = o.apply === true
  const warn = makeLog(o.log)
  const readFileFn = typeof o.readFile === 'function' ? o.readFile : fsReadFile
  const rmFn = typeof o.rm === 'function' ? o.rm : fsRm
  const mkdirFn = typeof o.mkdir === 'function' ? o.mkdir : fsMkdir
  const writeFileFn = typeof o.writeFile === 'function' ? o.writeFile : fsWriteFile

  // ── 0) 轮数窗口:显式 boundaryMs > 注入/默认取数器(按父各算各的)> 时长窗口兜底 ──
  const givenBoundary = Number(o.boundaryMs)
  const turnBoundary = Number.isFinite(givenBoundary) && givenBoundary > 0
    ? {
        turns: windowTurns,
        fallback: false,
        ms: givenBoundary,
        byParent: null,
        windows: [],
        partial: false,
        sources: [],
        orphan: 'keep'
      }
    : await (async () => {
      let got = null
      try {
        const fn = typeof o.listMainTimes === 'function' ? o.listMainTimes : defaultListMainTimes
        got = await fn({ sessionsRoot, turns: windowTurns, log: o.log })
      } catch (err) {
        warn('轮数窗口取数器抛了,退回时长窗口:' + msg(err))
        got = null
      }
      if (got && got.byParent && typeof got.byParent === 'object') {
        const windows = Array.isArray(got.windows) ? got.windows : []
        return {
          turns: windowTurns,
          fallback: false,
          ms: null, // 按父各算各的 ⇒ 没有单一全局边界
          byParent: got.byParent,
          windows,
          partial: got.partial === true || windows.some((w) => w && w.partial === true),
          sources: windows,
          orphan: 'keep'
        }
      }
      // 兼容旧形状:注入方只给了一个全局 boundaryMs
      if (got && Number.isFinite(Number(got.boundaryMs)) && Number(got.boundaryMs) > 0) {
        const windows = Array.isArray(got.windows) ? got.windows : (Array.isArray(got.sources) ? got.sources : [])
        return {
          turns: windowTurns,
          fallback: false,
          ms: Number(got.boundaryMs),
          byParent: null,
          windows,
          partial: got.partial === true,
          sources: windows,
          orphan: 'keep'
        }
      }
      return {
        turns: windowTurns,
        fallback: true,
        ms: now - windowMs,
        byParent: null,
        windows: [],
        partial: false,
        sources: [],
        orphan: 'keep'
      }
    })()

  const result = {
    scanned: 0,
    kept: 0,
    reaped: [],
    unknown: [],
    freedBytes: 0,
    manifestPath: null,
    applied: apply,
    ms: 0,
    turnBoundary
  }
  /** 出口统一盖上实际耗时(心跳看这个)。 */
  const finish = () => { result.ms = Date.now() - startedAt; return result }

  // ── 1) 扫 ~/.dsh/sessions/<workspace>/<sid>/(两层)。扫不动就当空,不抛 ──
  const dirs = []
  let workspaces = []
  try {
    workspaces = await fsReaddir(sessionsRoot, { withFileTypes: true })
  } catch (err) {
    warn('sessions 根目录读不到:' + sessionsRoot + ' (' + msg(err) + ')')
    return finish()
  }
  for (const ws of Array.isArray(workspaces) ? workspaces : []) {
    if (!isDir(ws)) continue
    const wsPath = join(sessionsRoot, String(ws.name))
    let children = []
    try {
      children = await fsReaddir(wsPath, { withFileTypes: true })
    } catch (err) {
      warn('工作区目录读不到:' + wsPath + ' (' + msg(err) + ')')
      continue
    }
    for (const child of Array.isArray(children) ? children : []) {
      if (!isDir(child)) continue
      dirs.push(join(wsPath, String(child.name)))
    }
  }

  // ── 2) 认每一个目录(失败 → unknown,保留) ──
  const entries = []
  for (const dir of dirs) {
    const d = await classifyDetailed(dir, { readFile: readFileFn })
    entries.push({ ...d, path: dir })
  }
  result.scanned = entries.length

  // ── 3) 判谁留谁收(按父各算各的优先,其次全局轮数窗口,最后时长窗口) ──
  const { keep, reap } = planReap(entries, {
    now,
    windowMs,
    keepNewest,
    boundaryByParent: turnBoundary.fallback ? undefined : (turnBoundary.byParent ?? undefined),
    boundaryMs: turnBoundary.fallback ? undefined : (turnBoundary.ms ?? undefined)
  })
  result.kept = keep.length
  result.unknown = entries
    .filter((e) => e.kind === 'unknown')
    .map((e) => ({ sid: e.sid, path: e.path, why: e.why || 'unknown' }))

  // ── 4) apply 时:先把待删清单落盘,再动手(清单失败就整个不删) ──
  if (apply) {
    const manifestPath = join(auditDir, 'reaper-' + manifestStamp(now) + '.jsonl')
    try {
      await mkdirFn(auditDir, { recursive: true })
      const lines = reap.map((e) => {
        const pid = e.parentSession === null || e.parentSession === undefined ? null : String(e.parentSession)
        const v = turnBoundary.byParent ? parentWindowOf(turnBoundary.byParent, pid) : undefined
        return JSON.stringify({
          at: new Date(now).toISOString(),
          sid: e.sid,
          path: e.path,
          bytes: num(e.bytes, 0),
          kind: 'subagent',
          windowMs,
          keepNewest,
          // 本次真正生效的窗口边界与轮数
          // (按父各算各的时 = 该父的边界;固定时长兜底时 = now - windowMs)
          boundaryMs: Number.isFinite(Number(v)) ? Number(v) : (turnBoundary ? turnBoundary.ms : null),
          turns: windowTurns,
          parentSession: pid
        })
      })
      await writeFileFn(manifestPath, lines.length ? lines.join('\n') + '\n' : '', 'utf8')
      result.manifestPath = manifestPath
    } catch (err) {
      warn('清单写入失败,放弃本次删除:' + manifestPath + ' (' + msg(err) + ')')
      return finish()
    }
  }

  if (reap.length === 0) return finish()

  // ── 5) projcache 索引:列一次目录,只认**真实存在**的候选文件 ──
  // (dry-run 也要列:它得报出"会删哪些缓存",这才叫预览)
  let projNames = null
  try {
    projNames = new Set((await fsReaddir(projcacheRoot)).map((n) => String(n)))
  } catch (err) {
    projNames = null
    if (apply) warn('projcache 目录读不到,跳过缓存清理:' + projcacheRoot + ' (' + msg(err) + ')')
  }

  // ── 6) 遍历待删:dry-run 只回报计划(一个都不删);apply 才动手 ──
  for (const e of reap) {
    const candidates = projNames
      ? [String(e.sid) + '.json', 'session-' + String(e.sid) + '.json']
        .filter((n) => projNames.has(n))
        .map((n) => join(projcacheRoot, n))
      : []
    if (!apply) {
      // dry-run:planReap 的结果照常返回,但磁盘一个字节都不动
      result.reaped.push({ sid: e.sid, path: e.path, bytes: num(e.bytes, 0), projcache: candidates })
      continue
    }
    try {
      await rmFn(e.path, { recursive: true, force: true })
    } catch (err) {
      warn('删除会话目录失败,跳过:' + e.path + ' (' + msg(err) + ')')
      continue
    }
    const projDeleted = []
    for (const p of candidates) {
      try {
        await rmFn(p, { force: true })
        projNames.delete(basename(p))
        projDeleted.push(p)
      } catch (err) {
        warn('删除 projcache 失败:' + p + ' (' + msg(err) + ')')
      }
    }
    result.reaped.push({ sid: e.sid, path: e.path, bytes: num(e.bytes, 0), projcache: projDeleted })
    result.freedBytes += num(e.bytes, 0)
  }

  return finish()
}

export default {
  classifySessionDir,
  planReap,
  reapSessions,
  defaultPaths,
  manifestStamp,
  turnBoundaryFromTimes
}
