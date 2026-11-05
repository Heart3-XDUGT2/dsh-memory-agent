/**
 * 构建指纹(2026-09-26 只读审计的第一条,也是今天反复咬人的那口)。
 *
 * 现场:装机位 `relay.js` mtime 14:36:52,而 14:39:56 还冒出一条 `relay_proactive`;
 * 直到 14:40:46 `dsh web` 重启才彻底干净。可 `echo_status` 只报 `version: 0.17.1`
 * —— 仓库、装机位、活着的进程**三份都是 0.17.1**,于是「修复没生效」和「那一次
 * 恰好是合规的一轮」在数据上分不出来。
 *
 * 更糟的是宿主的行为:它的 HMR(`profile-boot-*.js` 里 `config:{root:[]}`)只显式
 * watch patch 文件,**不重载插件模块** —— 改完 `lib/*.js` 不重启 `dsh web`,跑着的
 * 仍然是旧代码,而没有任何地方会告诉你。我们今天已经因此误判过一次。
 *
 * 所以给她一枚**构建指纹**:`lib/*.js` 全部内容的 sha256 前 12 位 + 文件数与
 * 最新 mtime。启动时算一次,塞进 `echo_status` 与面板 —— 重启前后一对比,
 * 「活着的到底是哪一版」就不用猜。换行符按 LF 归一(装机位与仓库只差 CRLF/LF
 * 时指纹应当相同,否则这枚指纹每天都在假报警)。
 *
 * 纯函数式依赖注入(不用真文件系统也能测),副作用只在读文件。
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const UNKNOWN = { short: 'unknown', sha: '', files: 0, latestMtime: 0 }

/**
 * 算一份 lib 目录的构建指纹。
 * @param {string} dir 目录(装机位或仓库的 lib/)
 * @param {{readdir?: Function, readFile?: Function, stat?: Function}} [io] 注入点(测试用)
 * @returns {{short: string, sha: string, files: number, latestMtime: number}}
 */
export function buildStampOf (dir, io = {}) {
  const readdir = io.readdir ?? readdirSync
  const readFile = io.readFile ?? readFileSync
  const stat = io.stat ?? statSync
  let names = []
  try {
    names = readdir(dir)
      .map((n) => String(n))
      .filter((n) => n.endsWith('.js'))
      .sort() // 排序:目录顺序不稳定,不排序的话同一份代码会算出不同指纹
  } catch { return { ...UNKNOWN } } // 目录不在(比如打包后换了布局)不该炸插件
  const h = createHash('sha256')
  let latestMtime = 0
  for (const name of names) {
    const full = join(dir, name)
    let body = ''
    try {
      // 归一 CRLF:装机位/仓库只差换行符时指纹必须一致,否则每天假报警
      body = String(readFile(full, 'utf8')).replace(/\r\n/g, '\n')
    } catch { continue }
    h.update(name)
    h.update('\u0000')
    h.update(body)
    h.update('\u0000')
    try {
      const m = stat(full).mtimeMs
      if (m > latestMtime) latestMtime = m
    } catch { /* mtime 读不到不影响内容指纹 */ }
  }
  const sha = h.digest('hex')
  return {
    short: sha.slice(0, 12),
    sha,
    files: names.length,
    latestMtime: Math.floor(latestMtime)
  }
}
