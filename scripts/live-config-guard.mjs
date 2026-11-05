/**
 * dsh-echo — 活配置守卫:「跑测试不许写真实 `$DSH_HOME\echo\config.json`」
 * ============================================================================
 * ★ 2026-10-01 尾,事故驱动。现场:`~/.dsh/echo/config.json` 里 `graphShadowEdges`
 * 被拨成了 `true`,而谁也说不清是哪只手 —— 排查时**必须**能一句话排除掉"是不是某个
 * 测试/探针偷偷写了活配置"。当时只能靠人工 `Get-FileHash` 前后比,太容易被漏掉。
 *
 * 判据(硬要求):跑**整套测试**之前与之后,活配置的 **sha256 与 mtime 都不许变**。
 *   · 用**真路径**(与 `lib/persona.js:19` 的 `DATA_DIR` 同一条推法:
 *     `$DSH_HOME ?? ~/.dsh` + `/echo/config.json`)—— 真路径注入,不是临时目录;
 *   · `DSH_HOME` 若指向临时目录 ⇒ **直接拒绝**(那是"用临时目录糊弄这条守卫",
 *     守卫要抓的正是"测试里没隔离、写到了真文件"这件事);
 *   · 文件不存在也算一种合法状态:前后都必须**仍然不存在**。
 *
 * 为什么 sha256 **和** mtime 都要:`writeConfig` 每次都会把 `savedAt` 刷成新时间戳
 * ⇒ 任何真写都会同时改 sha 与 mtime;sha 是主判据,mtime 兜住"内容一样但文件被动过"
 * 那类(复制/还原/别的工具改回去)。
 *
 * ⚠️ 已知的**非测试**噪声源:活宿主自己也会写这个文件(QQ 入站登记会话标签
 * `setSessionLabel`、面板拨开关)。如果一次 QQ 入站正好落在测试那 20 秒里,这条守卫
 * 会红 —— 它红得对(确实有写口动过活配置),但那不是测试干的。判据在失败信息里
 * 会把"改前/改后"两行都打出来,便于当场区分(测试写的 vs 宿主写的)。
 *
 * 用法:
 *   node scripts/live-config-guard.mjs          # 自己跑一遍整套测试并前后比
 *   node scripts/live-config-guard.mjs snap     # 只打印当前快照(人工排查用)
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, normalize, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/**
 * 活配置的**真路径**。推法与 `lib/persona.js` 的 `DATA_DIR` 逐字相同(不另立一套)。
 *
 * 拒绝临时目录:`mkdtempSync(tmpdir(), ...)` 那类隔离 home 一律不吃 —— 否则这条守卫
 * 就成了一句空话(它要抓的就是"某个测试忘了隔离"). 真要手工排查,用 `snap` 子命令。
 *
 * 2026-10-10 套件级隔离:测试现在统一由 `tests/_isolate.mjs` 把 `DSH_HOME` 指到临时目录
 * ⇒ 单看 `env.DSH_HOME` 本函数会**一律拒绝**,守卫等于停摆。所以加一层存根
 * `ECHO_TEST_REAL_DSH_HOME`(隔离件在改 `DSH_HOME` **之前**把真值写进去)并**优先读它**
 * —— 守卫盯的仍然是**真路径**,判据一个没丢。
 * 存根是空的(未隔离的运行 / 手工 CLI)⇒ 回落到 `env.DSH_HOME`,行为与之前逐位相同。
 * ⚠️ 存根本身不许指向临时目录:`looksTemp` 检查对它**照常生效**(伪造存根同样被拒)。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 绝对路径
 */
export function liveConfigPath (env = process.env) {
  const stashed = String(env.ECHO_TEST_REAL_DSH_HOME ?? '').trim()
  const home = stashed || String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  const p = normalize(join(home, 'echo', 'config.json'))
  const tmp = normalize(tmpdir())
  const looksTemp = p.toLowerCase().startsWith(tmp.toLowerCase() + sep) ||
    p.toLowerCase().includes(normalize(join('AppData', 'Local', 'Temp')).toLowerCase()) ||
    /[\\/](tmp|temp)[\\/]/i.test(p)
  if (looksTemp) {
    throw new Error('活配置守卫拒绝在临时目录上工作:' + p
      + '\n  DSH_HOME=' + String(env.DSH_HOME)
      + '\n  这条守卫的判据必须是**真路径**;拿临时目录跑等于没跑(见文件头)。')
  }
  return p
}

/**
 * 快照:存在性 + sha256 + mtime(毫秒)+ 字节数 + 文件里的 `savedAt`(便于人读)。
 * 文件不存在 ⇒ `{ exists: false }`(合法状态,前后必须一致)。
 * @param {string} p
 */
export function snapshot (p) {
  if (!existsSync(p)) return { exists: false, path: p }
  const buf = readFileSync(p)
  const st = statSync(p)
  let savedAt = null
  try { savedAt = JSON.parse(buf.toString('utf8')).savedAt ?? null } catch { /* 坏 JSON 也算一种状态 */ }
  return {
    exists: true,
    path: p,
    sha256: createHash('sha256').update(buf).digest('hex'),
    mtimeMs: st.mtimeMs,
    size: st.size,
    savedAt
  }
}

/** 两个快照是否逐位相同(sha256 + mtime;不存在 ⇔ 不存在)。 */
export function sameSnapshot (a, b) {
  if (a.exists !== b.exists) return false
  if (!a.exists) return true
  return a.sha256 === b.sha256 && a.mtimeMs === b.mtimeMs
}

/** 一行人话(失败信息里要能当场看出"哪一项变了")。 */
export function describe (s) {
  if (!s.exists) return '(不存在)'
  return 'sha256=' + String(s.sha256).slice(0, 16) + '… mtime=' + new Date(s.mtimeMs).toISOString()
    + ' size=' + s.size + ' savedAt=' + JSON.stringify(s.savedAt)
}

/**
 * 跑整套测试(与 `npm test` 同一条命令;子进程里置哨兵变量 ⇒ 守卫不再递归)。
 *
 * 2026-10-10 套件级隔离 —— **子套件必须真正未隔离,否则这条守卫就是空话**:
 * 外层进程由 `tests/_isolate.mjs` 把 `DSH_HOME` 指到了临时目录,而 `spawnSync` 会
 * **继承** `process.env` ⇒ 子套件里的测试也全都在临时目录上跑 ⇒ **没有任何测试
 * 写得动真配置** ⇒ 前后快照必然一致,守卫永远绿、永远抓不到东西。
 * 所以这里把 `DSH_HOME` **还原成真值**、并摘掉隔离存根:子套件回到"真机"环境,
 * 它要是写了活配置,守卫照样红。这正是这条守卫存在的理由(见文件头事故记录)。
 * (子套件本身红不红不由这里负责 —— 调用方只要求它**跑起来**,见 `live-config-guard.test.js:50`。)
 */
export function runSuite (extraEnv = {}) {
  const realHome = String(process.env.ECHO_TEST_REAL_DSH_HOME ?? '').trim()
  const env = { ...process.env, ECHO_LIVE_CONFIG_GUARD_CHILD: '1', ...extraEnv }
  // 摘掉隔离存根:子套件不该再看到它(它只服务于"外层被隔离时守卫仍能定位真路径")
  delete env.ECHO_TEST_REAL_DSH_HOME
  // 还原真 home:空串 = 真机用 ~/.dsh 默认值 ⇒ 删掉这个键,让 liveConfigPath 走默认
  if (realHome === '') delete env.DSH_HOME
  else env.DSH_HOME = realHome
  return spawnSync(process.execPath,
    ['--test', '--test-force-exit', 'tests/*.test.js'],
    {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8'
    })
}

// ─────────────────────────────────────────────────────────────
// CLI(直接 `node scripts/live-config-guard.mjs` 时)
// ─────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] !== undefined &&
  normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  const cmd = process.argv[2] || 'run'
  const p = liveConfigPath()
  console.log('活配置守卫 —— 目标:' + p)
  if (cmd === 'snap') {
    console.log('  当前快照:' + describe(snapshot(p)))
    process.exit(0)
  }
  const before = snapshot(p)
  console.log('  跑前:' + describe(before))
  const r = runSuite()
  const after = snapshot(p)
  console.log('  跑后:' + describe(after))
  const childOk = r.status === 0
  if (!sameSnapshot(before, after)) {
    console.error('❌ 活配置在测试期间被改动了 —— 这是硬失败(有写口没隔离)。')
    console.error('   跑前:' + describe(before))
    console.error('   跑后:' + describe(after))
    process.exitCode = 1
  } else {
    console.log('✅ 活配置 sha256 与 mtime 前后一致 —— 没有测试写活配置。'
      + '(子套件 exit=' + String(r.status) + ',与这条守卫无关)')
    if (!childOk) console.log('   ⚠️ 子套件本身没全过(exit=' + String(r.status) + ');那条看 npm test 的输出。')
  }
}
