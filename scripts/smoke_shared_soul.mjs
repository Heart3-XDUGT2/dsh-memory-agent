#!/usr/bin/env node
/**
 * dsh-echo — M8-b「共享灵魂库」副本双跑冒烟(编排者)
 * ============================================================
 * 三进程并发开同一个库副本交错读写,断言:
 *   1. QQ 真 SchemaMixin 建表/补列在 DSH 超集形状上不炸;
 *   2. QQ 式 INSERT(11 列)在 DSH 表上成功;
 *   3. 三进程并发交错零 SQLITE_BUSY(WAL + busy_timeout=5000);
 *   4. 行数守恒 + 跨进程可见(三方计数一致,JS 看到 QQ/引擎的行);
 *   5. 双 tick 幂等:QQ tick 与 DSH 引擎 tick 同刻并发,落值 ==
 *      解析期望 v0 + M(沉默秒)(绝对值写回,非增量累加)。
 *
 * 用法:node scripts/smoke_shared_soul.mjs [--plugin <AstrBot 插件根>]
 * 默认插件根 = AstrBot 数据目录的 astrbot_plugin_memory_middleware。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore } from '../lib/store.js'

const PYTHON = process.env.ECHO_PYTHON ?? 'python'
const DEFAULT_PLUGIN = join(homedir(), '.astrbot', 'data', 'plugins', 'astrbot_plugin_memory_middleware')
const pluginArg = process.argv.includes('--plugin')
  ? process.argv[process.argv.indexOf('--plugin') + 1]
  : DEFAULT_PLUGIN

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(join(tmpdir(), 'echo-m8b-'))
const dbPath = join(dir, 'soul.db')
let failures = 0
const check = (ok, label) => {
  console.log((ok ? '[PASS] ' : '[FAIL] ') + label)
  if (!ok) failures++
}

// ---- 1. DSH 形状建库 + 种子(JS store,连接全程保持 = 第三进程) ----
const store = openStore(dbPath)
for (const s of ['种子A', '种子B', '种子C']) store.insertMemory({ keywords: ['种子'], summary: s, emotionScore: 5 })

// ---- 2. 双伙伴同刻起跑 ----
const tickAt = Date.now() + 5000
const spawnPartner = (role, extra) => {
  const child = spawn(PYTHON, [join(repoRoot, 'scripts', 'smoke_shared_soul_partner.py'),
    '--role', role, '--db', dbPath, '--tick-at', String(tickAt), ...extra], {
    cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })))
  return { child, done }
}
const qq = spawnPartner('qq', ['--plugin', pluginArg])
const dsh = spawnPartner('dsh', [])

// ---- 3. JS 侧同时交错读写(tick 时刻收手,保证三方终数同窗) ----
let jsInserted = 0
while (Date.now() < tickAt - 200) {
  store.insertMemory({ keywords: ['冒烟', 'js' + jsInserted], summary: `JS冒烟第${jsInserted}条`, emotionScore: 5 })
  jsInserted++
  if (jsInserted % 5 === 0) store.retrieve('冒烟', 6)
  await sleep(15)
}

const [qqR, dshR] = await Promise.all([qq.done, dsh.done])
const parseResult = (r, role) => {
  const line = (r.out || '').split(/\r?\n/).find((l) => l.startsWith('RESULT '))
  if (!line) {
    check(false, `${role} 伙伴无 RESULT 输出(exit=${r.code}) stderr=${(r.err || '').slice(0, 300)}`)
    return null
  }
  const report = JSON.parse(line.slice(7))
  check(r.code === 0, `${role} 伙伴退出码 0(exit=${r.code})`)
  return report
}
const qqRep = parseResult(qqR, 'QQ')
const dshRep = parseResult(dshR, 'DSH')

// ---- 4. 断言 ----
if (qqRep && dshRep) {
  check(qqRep.errors.length === 0, `QQ 侧零异常(${JSON.stringify(qqRep.errors.slice(0, 3))})`)
  check(dshRep.errors.length === 0, `DSH 侧零异常(${JSON.stringify(dshRep.errors.slice(0, 3))})`)
  check(qqRep.ddlOk === true, 'QQ 真 SchemaMixin 建表/补列在 DSH 超集形状上不炸')
  check(qqRep.tickOk === true && dshRep.tickOk === true, '双侧 tick 均完成')

  const total = store.db.prepare('SELECT COUNT(*) AS n FROM episodic_memory').get().n
  const expectTotal = 3 + jsInserted + qqRep.inserted + dshRep.inserted
  check(total === expectTotal, `行数守恒: ${total} == 3种子 + ${jsInserted}JS + ${qqRep.inserted}QQ + ${dshRep.inserted}引擎`)
  check(qqRep.countAtEnd === total && dshRep.countAtEnd === total,
    `跨进程可见: 三方终数一致(JS=${total} QQ=${qqRep.countAtEnd} 引擎=${dshRep.countAtEnd})`)
  const sees = (kw) => store.db.prepare(
    "SELECT COUNT(*) AS n FROM episodic_memory WHERE summary LIKE ?").get('%' + kw + '%').n
  check(sees('QQ渠道冒烟第0条') === 1, 'JS 看到 QQ 插入的行(11 列集兼容)')
  check(sees('DSH引擎冒烟第0条') === 1, 'JS 看到引擎插入的行')

  check(dshRep.idempotentOk === true,
    `双 tick 幂等: stored=${dshRep.storedValue?.toFixed(6)} == 期望 ${dshRep.expectedValue?.toFixed(6)}(v0=${dshRep.v0})`)
}
store.close()

if (failures === 0) console.log('M8-b 冒烟全绿:共享灵魂库前提(并发/形状/幂等)实证成立')
else console.log('M8-b 冒烟有 ' + failures + ' 项失败')
try { rmSync(dir, { recursive: true, force: true }) } catch { /* 无妨 */ }
process.exit(failures === 0 ? 0 : 1)
