/**
 * `r4-preflight` 的判断力护栏。
 *
 * 这个脚本前后**两次报过假绿**(令牌写在顶层、`enabled` 只在重载那一刻被读到),
 * 所以它现在多读两样东西,这里把这两样钉住:
 *
 *   ① `plugin_set` —— AstrBot 的**启用面**。「配置文件里 enabled=true」不等于它在跑,
 *      「老插件的 gateway_enabled=true」也不等于它在答。
 *   ② 适配器**自己打印的启动行**(backend.log) —— 运行中那份到底说的「接管中」
 *      还是「已就绪但 enabled=false」。文件与进程不一致时,必须指出「要重载」。
 *
 * 全部指向临时目录(`DSH_HOME` + `ASTRBOT_DATA`),不碰真数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '')

/**
 * 造一套 A 侧现场:data/config/*.json + data/cmd_config.json + logs/backend.log。
 * @param {{adapterEnabled?: boolean, oldActive?: boolean, adapterRunning?: boolean}} o
 */
function scene ({ adapterEnabled = false, oldActive = true, adapterRunning = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'echo-preflight-'))
  const data = join(home, 'data')
  mkdirSync(join(data, 'config'), { recursive: true })
  mkdirSync(join(home, 'logs'), { recursive: true })
  mkdirSync(join(home, '.dsh', 'echo'), { recursive: true })

  const token = 'echo-test-token-0123456789'
  writeFileSync(join(home, '.dsh', 'echo', 'config.json'), JSON.stringify({
    enabled: true,
    scope: 'whitelist',
    whitelist: ['session-echo-companion'],
    settings: { relay: { enabled: true, token, sessionId: 'session-echo-companion', permissionPreset: 'read-only', proactiveScope: 'private' } }
  }), 'utf8')
  writeFileSync(join(data, 'config', 'astrbot_plugin_echo_relay_config.json'), JSON.stringify({
    enabled: adapterEnabled, dsh_base_url: 'http://127.0.0.1:3080', relay_token: token,
    platform: 'qq', umo_prefix: '', master_ids: ['<your-qq>'], group_require_at: false, forward_commands: false
  }), 'utf8')
  writeFileSync(join(data, 'config', 'astrbot_plugin_memory_middleware_config.json'), JSON.stringify({
    gateway_enabled: true, reminder_enabled: false, db_path: ''
  }), 'utf8')
  writeFileSync(join(data, 'cmd_config.json'), JSON.stringify({
    platform_settings: { enable_id_white_list: true, id_whitelist: ['<your-qq>'] },
    platform: [{ id: 'Echo', type: 'aiocqhttp', enable: true }],
    // 现场实测:`plugin_set` 一直是 ['*'],**分辨不出「被停用」** —— 权威答案在
    // data_v4.db 的 `preferences.inactivated_plugins`。所以这里故意也填 ['*']。
    plugin_set: ['*']
  }), 'utf8')
  // AstrBot 的启用面(权威):`turn_off_plugin` 往这张表里塞 `data.plugins.<名>.main`
  const db = new DatabaseSync(join(data, 'data_v4.db'))
  db.exec('CREATE TABLE preferences (id INTEGER PRIMARY KEY, scope TEXT, scope_id TEXT, key TEXT, value TEXT, created_at TEXT, updated_at TEXT)')
  const off = []
  if (!oldActive) off.push('data.plugins.astrbot_plugin_memory_middleware.main')
  db.prepare('INSERT INTO preferences (scope, scope_id, key, value) VALUES (?,?,?,?)')
    .run('global', 'global', 'inactivated_plugins', JSON.stringify({ val: off }))
  db.close()
  const logLine = adapterRunning
    ? '[01:20:15.514] [astrbot_plugin_echo_relay] [INFO] [main:174]: [echo_relay] 接管中 → http://127.0.0.1:3080(platform=qq, 轮询 2s)'
    : '[01:20:15.514] [astrbot_plugin_echo_relay] [INFO] [main:171]: [echo_relay] 已就绪但 enabled=false:仍然放行原生链路(随时可开)。'
  writeFileSync(join(home, 'logs', 'backend.log'), logLine + '\n', 'utf8')
  return home
}

function run (home) {
  const argv = [join(ROOT, 'scripts', 'r4-preflight.mjs'), '--json']
  const env = { ...process.env, DSH_HOME: join(home, '.dsh'), ASTRBOT_DATA: join(home, 'data') }
  try {
    return JSON.parse(execFileSync(process.execPath, argv, { encoding: 'utf8', env }))
  } catch (e) {
    return JSON.parse(e.stdout || '{}')
  }
}

const allText = (r) => JSON.stringify(r)

test('切换前:文件说关、运行中也说待机、老插件在跑 → 没有问题', () => {
  const home = scene({ adapterEnabled: false, oldActive: true, adapterRunning: false })
  try {
    const r = run(home)
    assert.equal(r.problems.length, 0, allText(r.problems))
    assert.ok(allText(r).includes('已就绪但 enabled=false'), '要如实报出运行中那份的说法')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('文件已开但运行中那份还没重载 → 只提醒「要重载」,不冤枉成问题', () => {
  const home = scene({ adapterEnabled: true, oldActive: false, adapterRunning: false })
  try {
    const r = run(home)
    assert.equal(r.problems.length, 0, allText(r.problems))
    assert.ok(allText(r).includes('文件已开但运行中那份还没重载'), '要指出下一步是重载:')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('适配器已接管而老插件还在加载 → 必须报「两个都在答」', () => {
  const home = scene({ adapterEnabled: true, oldActive: true, adapterRunning: true })
  try {
    const r = run(home)
    assert.equal(r.problems.length > 0, true, '这种组合是硬伤:同一句话会被答两遍')
    assert.ok(allText(r.problems).includes('两个都在答'), allText(r.problems))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('老插件已停用(在 inactivated_plugins 里,而 plugin_set 仍是 *)→ 说清「停用比关开关干净」', () => {
  const home = scene({ adapterEnabled: true, oldActive: false, adapterRunning: true })
  try {
    const r = run(home)
    assert.equal(r.problems.length, 0, allText(r.problems))
    assert.ok(allText(r).includes('已停用'), '要指出它已经不在启用面里')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('老插件还在启用面里 → 不能误报成「已停用」(库里的路径要整段匹配)', () => {
  const home = scene({ adapterEnabled: false, oldActive: true, adapterRunning: false })
  try {
    const r = run(home)
    assert.equal(allText(r).includes('已停用'), false, '它还在跑,别说它停了')
    assert.ok(allText(r).includes('整只停用它'), allText(r).slice(0, 600))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('平台实例 id 会被当成 umo 前缀报出来(重启后主动开口靠它)', () => {
  const home = scene()
  try {
    const r = run(home)
    assert.ok(allText(r).includes('Echo'), allText(r).slice(0, 400))
  } finally { rmSync(home, { recursive: true, force: true }) }
})
