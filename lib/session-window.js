/**
 * dsh-echo — 主对话「轮数窗口」(宿主侧、只读、fail-soft)
 * ============================================================
 * 判据从「固定时长」换成「最近 N 轮对话」,而且是**每个主对话各算各的**:
 *   - 主对话 A 的窗口边界 = A 里**最近 N 轮用户消息**中最早那条的时间;
 *     A 名下(parentSession = A)的子代理 mtime 早于 A 的边界 → 该收;
 *   - 主对话 B 用 B 的边界,B 的 subagent 与 A 的**互不干扰**(不跨会话取 min);
 *   - 某个主对话读到的轮数 < N(历史被截断)⇒ 它的过程数据全在窗口内 ⇒
 *     `keepAll`(该父名下全留),**不**把它最早的时间拿去当边界。
 *
 * 读接口**不自己写 zstd 解析器**:用宿主自己的
 * `@deepseek-ai/dsh-session-persistence-jsonl`(默认导出类
 * `JsonlSessionPersistence`,它是宿主 `sessionPersistence` 服务的 JSONL 后端):
 *   const backend = new JsonlSessionPersistence(ctxStub, { root, compression: 'zstd' })
 *   const snaps   = await backend.list()                       // header 里带 origin / id
 *   const handle  = await backend.open(id, 'read')             // 只读句柄
 *   const { events } = await handle.read(0, MAX_SAFE_INTEGER)  // {seq,time,data} 事件流
 *   await handle.close()
 * 那套混合封装(头部独立 zstd 帧 + 中间多段 + 尾部署文)由后端内部的
 * `readZstdPrefix()`(`scanZstdFrames` + 帧解码器 + `SessionLogScanner`)处理,
 * 连 torn-tail 也是它兜的 —— 所以本模块不碰字节。
 *
 * 纪律:
 *   1. **只读**。不写清单、不删文件、不改 mtime。
 *   2. **fail-soft + 绝不猜测**:模块拿不到 / 文件读不动 / 没有 time ⇒ 返回 `null`,
 *      调用方(session-reaper)会退回固定时长窗口兜底。
 *   3. 边界只从**真实事件时间**里取,不合成、不外推。
 *   4. **每个主对话只读一次**:循环跑在"父"这一层,子代理只查 `byParent` 表。
 *
 * 纯 ESM、零第三方依赖(读接口用**动态 import** 拿,拿不到就 null,绝不让插件
 * 启动依赖它)。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { turnBoundaryFromTimes } from './session-reaper.js'

/** 默认「最近 N 轮」。 */
export const DEFAULT_TURNS = 300
/** 读接口包名。 */
export const READER_PACKAGE = '@deepseek-ai/dsh-session-persistence-jsonl'

/** 把任意异常压成一行短说明(不抛)。 */
function msg (err) {
  if (err && typeof err.message === 'string' && err.message) return err.message
  return String(err)
}

/** 数字兜底。 */
function num (v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 默认 log:静音。 */
function makeLog (log) {
  const warn = log && typeof log.warn === 'function' ? log.warn.bind(log) : () => {}
  return (m) => { try { warn(String(m)) } catch { /* 日志自己炸了也不许上来 */ } }
}

/** 默认 ~/.dsh 根目录(可用 DSH_HOME 覆盖)。 */
function defaultHome (env = process.env) {
  return typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
}

/** 候选模块位置:先按包名解析,再退到 DSH 插件目录下的绝对路径。 */
export function readerCandidates (env = process.env) {
  const home = defaultHome(env)
  const abs = join(home, 'plugins', 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js')
  const out = [READER_PACKAGE]
  try { out.push(pathToFileURL(abs).href) } catch { /* 忽略 */ }
  const fallback = join(homedir(), '.dsh', 'plugins', 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js')
  if (fallback !== abs) {
    try { out.push(pathToFileURL(fallback).href) } catch { /* 忽略 */ }
  }
  return out
}

/**
 * 动态 import 出 JSONL 后端类。拿不到就 throw(调用方接住 → null)。
 * @returns {Promise<Function>} `JsonlSessionPersistence` 构造器
 */
async function loadReaderClass () {
  let lastErr = null
  for (const spec of readerCandidates()) {
    try {
      const mod = await import(spec)
      const Ctor = mod?.default ?? mod?.JsonlSessionPersistence
      if (typeof Ctor === 'function') return Ctor
      lastErr = new Error('reader module has no usable default export')
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr || new Error('reader module unavailable')
}

/**
 * 最小 ctx 桩:`Service` 构造只用到 `reflect.provide` / `on` / `effect` / `logger`。
 * 我们不注册任何事件、不持有任何 fiber,所以桩不会泄漏到宿主里。
 */
function makeCtxStub () {
  return {
    reflect: { provide () { /* 桩:不注册服务 */ } },
    on () { /* 桩:不订阅事件 */ },
    effect () { /* 桩:不做 teardown */ },
    logger: { warn () {}, info () {}, error () {}, debug () {} }
  }
}

/**
 * 读一个会话里全部 `user/message` 的 time(升序)。读不动 ⇒ `null`。
 * @param {object} backend 已构造的后端实例
 * @param {string} sid 会话 id
 * @returns {Promise<number[]|null>}
 */
async function readUserTimes (backend, sid) {
  let handle = null
  try {
    handle = await backend.open(sid, 'read')
    const res = await handle.read(0, Number.MAX_SAFE_INTEGER)
    const events = Array.isArray(res?.events) ? res.events : []
    const times = []
    for (const e of events) {
      if (!e || e.type !== 'user/message') continue
      const t = Number(e.time)
      if (Number.isFinite(t) && t > 0) times.push(t)
    }
    times.sort((a, b) => a - b)
    return times
  } catch {
    return null
  } finally {
    try { await handle?.close() } catch { /* 只读句柄关不掉也不许上来 */ }
  }
}

/**
 * 从**主对话**会话文件算「最近 N 轮」窗口 —— **每个主对话各算各的**。
 *
 * 每个主对话:取最近 `turns` 轮 `user/message` 的 `time`,
 *   - 事件数 >= `turns` ⇒ `boundaryMs` = 这批里**最早**那条(真实数据);
 *   - 事件数 < `turns`(历史被截断)⇒ `keepAll: true` / `boundaryMs: null`
 *     —— 它的过程数据全在窗口内,**不**拿它最早的时间去当边界。
 * 返回 `byParent`:`{ 主对话 id → 边界 | null(全留) }`,调用方(回收器)拿子代理的
 * `parentSession` 去查 —— A 的子代理用 A 的边界,B 的用 B 的,**不跨会话取 min**。
 *
 * 每个主对话**只读一次**(循环在"父"这一层,不在"子代理"那一层)⇒ 一次回收
 * 运行里 8 个主对话 = 8 次 `open`,而不是 51 次。
 *
 * 任何一步失败(模块拿不到 / 文件读不动 / 没有 time / 连一个主对话都没读到)⇒ `null`。
 * **只读**:一个字节都不写。
 *
 * @param {object} [options]
 * @param {string} [options.sessionsRoot] 默认 ~/.dsh/sessions
 * @param {number} [options.turns]        默认 300
 * @param {object} [options.log]          { warn }
 * @returns {Promise<{turns:number, windows:Array<{sid:string,turnsUsed:number,boundaryMs:number|null,partial:boolean,keepAll:boolean}>,
 *                    byParent:Record<string, number|null>, latestMs:number|null, partial:boolean, sources:Array}|null>}
 */
export async function readMainSessionTurnBoundary (options = {}) {
  const o = options || {}
  const warn = makeLog(o.log)
  const turns = Math.max(1, Math.floor(num(o.turns, DEFAULT_TURNS)))
  const sessionsRoot = typeof o.sessionsRoot === 'string' && o.sessionsRoot
    ? o.sessionsRoot
    : join(defaultHome(), 'sessions')

  try {
    const Ctor = await loadReaderClass()
    const backend = new Ctor(makeCtxStub(), { root: sessionsRoot, compression: 'zstd' })
    const snaps = await backend.list()
    const mains = (Array.isArray(snaps) ? snaps : [])
      .filter((s) => s && s.header && String(s.header.origin ?? '') !== 'subagent')
    if (mains.length === 0) return null

    // 一个主对话读一次(这里就是"缓存"本身:边界在父这一层算完,子代理只查表)
    const sessions = []
    for (const s of mains) {
      const sid = String(s.header.id)
      const times = await readUserTimes(backend, sid)
      // 主对话读不动 ⇒ 宁可整条判据作废(退回时长窗口),也不给猜测值
      if (times === null) {
        warn('session-window:主对话事件读不动,放弃轮数窗口:' + sid)
        return null
      }
      // 没有用户消息 ⇒ 也进列表,由纯函数落成 keepAll(该父名下全留)
      sessions.push({ sid, times })
    }

    const r = turnBoundaryFromTimes({ turns, sessions })
    if (!r || !Array.isArray(r.windows) || r.windows.length === 0) return null
    return {
      turns,
      windows: r.windows,
      byParent: r.byParent,
      latestMs: r.latestMs ?? null,
      partial: r.partial === true,
      sources: r.windows
    }
  } catch (err) {
    warn('session-window:轮数窗口算不出来(' + msg(err) + '),调用方应退回时长窗口')
    return null
  }
}

export default { readMainSessionTurnBoundary, readerCandidates, DEFAULT_TURNS }
