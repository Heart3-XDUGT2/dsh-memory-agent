// dsh-echo — 形态 (b) 只读记忆工具的**启用开关**辅助(打印 / 只读体检;**从不写任何配置**)
// ============================================================================
// 为什么要有它:开关是"配置驱动 + 默认关"。**打开它的首选做法是网页仪表盘的开关**
// (调参页顶部那张卡;端点 `GET/POST /api/echo/memory-tools`,拨一下**立即生效**),
// 它落的是本插件自己的 `<DATA_DIR>/config.json` 顶层同名键。本脚本做两件事:
//   ① 不传参 = 打印**两条路**的确切做法(首选:面板;备选:改宿主 patch 文件 —— 仍是
//      `env` 之外唯一"不经面板也能生效"的路)+ 各自何时生效;
//   ② `--check` = **只读**扫三处(env / 两份 patch / 插件 config)报告"现在算不算开"。
//
// ⚠️ **不写宿主配置**:改宿主 config 需要人类点头 —— 这里一个字节都不落盘。
// ⚠️ 三个开关来源的判定与 `lib/memory-read-tools.js` 的 `memoryToolsEnabled` 同源
//    (env OR loader-config OR settings;配置那条必须**严格** `true`)。
//
// 用法:
//   node scripts/enable-memory-tools.mjs
//   node scripts/enable-memory-tools.mjs --check

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { MEMORY_TOOL_ENV, MEMORY_TOOL_CONFIG_KEY } from '../lib/memory-read-tools.js'
// 路径**同源**:DATA_DIR 直接取 lib/persona.js 的导出(它是唯一的真源,且零宿主依赖),
// `settings` 那个文件名照 lib/toggle.js:31 的 `CONFIG_PATH = join(DATA_DIR, 'config.json')`。
// (别在这儿自己拼路径 —— 先前手拼过一次,拼成了 plugins/dsh-echo/data,是错的。)
import { DATA_DIR } from '../lib/persona.js'

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const patchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
const homePatchPath = join(dshHome, 'cordis.patch.yml')
const settingsPath = join(DATA_DIR, 'config.json')

const check = process.argv.includes('--check')

console.log('dsh-echo 形态 (b) 只读记忆工具 —— 开关辅助(只读,不写任何配置)')
console.log('='.repeat(72))
console.log('开关默认 **关**。打开的判据(三路 OR,任一为真即开):')
console.log('  ① 环境变量  ' + MEMORY_TOOL_ENV + '=1            → 改它 **必须重启宿主**')
console.log('  ② loader 配置 ' + MEMORY_TOOL_CONFIG_KEY + ': true        → 改它 **不用重启宿主进程**(但要重跑 apply,见备选)')
console.log('  ③ 插件设置   ' + settingsPath + ' 顶层同名键 → **经面板/端点拨 = 立即生效**')
console.log('                                       (只有**手改这个文件**、不经过面板,才是"下次启动生效")')

console.log('-'.repeat(72))
console.log('【首选做法 —— 面板拨一下(立即生效,推荐)】')
console.log('  网页仪表盘 → 「调参」页顶部 → 勾上「给子代理开只读记忆工具」。')
console.log('  端点 `GET/POST /api/echo/memory-tools` 落 `' + settingsPath + '` 顶层同名键,')
console.log('  并在 POST 里**当场**注册/摘除那 4 个工具(重设 toolFilter 名单)')
console.log('  ⇒ **不需要重启宿主、也不需要热重载**,拨完子代理那一轮就能用。')
console.log('  看生效:面板那张卡上会写「已注册 4 个只读工具」(= 回包 `registered: 4`)')
console.log('         与「来源:插件设置 config.json(网页面板开关)」。')
console.log('')

console.log('【备选 —— 改宿主 patch(不经面板也能生效的唯一一条;确切三步)】')
console.log('  1) 打开: ' + patchPath)
console.log('  2) 给 `id: echo` 那一条追加 config(同文件里 browserskill 那条是同款写法),加这三行:')
console.log('')
console.log('       - id: echo')
console.log('         config:')
console.log('           ' + MEMORY_TOOL_CONFIG_KEY + ': true')
console.log('')
console.log('  3) 存盘。本部署 web profile 是 patchReload: "live" ⇒ 宿主 HMR 监听到该文件变化,')
console.log('     立刻重放 patch → loader 只改 config ⇒ fiber.update ⇒ restart ⇒')
console.log('     原地重跑 apply(ctx, newConfig)。**无需重启宿主进程**。')
console.log('     ⚠️ 代价 = echo 这个插件 entry 整体 dispose + re-apply(不是"只挂 4 个工具");')
console.log('        宿主进程与别的插件(含正在进行的会话)不受影响。')
console.log('     看生效:日志出现 `echo: 子代理记忆工具已开(4 个,只读;来源 loader-config:' + MEMORY_TOOL_CONFIG_KEY + ')`。')
console.log('     退回去:把那一项删掉(或改成 false)即可,同样无需重启。')
console.log('     (为什么它还是备选:它要动**宿主的**文件、代价是整插件重跑;面板那条更轻。')
console.log('      但它仍是 `env` 之外唯一"不经过面板也能立即生效"的路 —— 面板本身坏了时用它。')

console.log('-'.repeat(72))
if (!check) {
  console.log('加 --check 可**只读**体检当前状态(node scripts/enable-memory-tools.mjs --check)。')
  process.exit(0)
}

// ---------------------------------------------------------------- --check(只读)
const envOn = String(process.env[MEMORY_TOOL_ENV] ?? '') === '1'

/** 极简 YAML 扫描:找 `- id: echo` 块后面的 memorySubagentTools 是不是严格 true。 */
function scanPatch (file, id) {
  if (!existsSync(file)) return { exists: false, on: false, why: '文件不存在' }
  let text
  try { text = readFileSync(file, 'utf8') } catch (err) {
    return { exists: true, on: false, why: '读不动:' + String(err?.message ?? err) }
  }
  const lines = text.split(/\r?\n/)
  let inBlock = false
  let subagent = null
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '') // 去行尾注释(够用:不处理引号里的 #)
    const m = line.match(/^\s*-\s*id:\s*["']?([^"'\s]+)["']?\s*$/)
    if (m) { inBlock = m[1] === id; continue }
    if (!inBlock) continue
    const k = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (k && k[1] === MEMORY_TOOL_CONFIG_KEY) subagent = k[2].trim().replace(/^["']|["']$/g, '')
  }
  if (subagent === null) return { exists: true, on: false, why: 'id: ' + id + ' 块里没有 ' + MEMORY_TOOL_CONFIG_KEY }
  return { exists: true, on: subagent === 'true', why: MEMORY_TOOL_CONFIG_KEY + ': ' + subagent + '（严格 true 才算开）' }
}

/** 插件设置文件那一路(只读)。 */
function scanSettings () {
  if (!existsSync(settingsPath)) return { exists: false, on: false, why: '文件不存在' }
  try {
    const j = JSON.parse(readFileSync(settingsPath, 'utf8'))
    return { exists: true, on: j?.[MEMORY_TOOL_CONFIG_KEY] === true, why: MEMORY_TOOL_CONFIG_KEY + ': ' + JSON.stringify(j?.[MEMORY_TOOL_CONFIG_KEY]) }
  } catch (err) { return { exists: true, on: false, why: '解析失败:' + String(err?.message ?? err) } }
}

const profile = scanPatch(patchPath, 'echo')
const home = scanPatch(homePatchPath, 'echo')
const settings = scanSettings()

console.log('【只读体检】')
console.log('  ① env ' + MEMORY_TOOL_ENV + ' = ' + JSON.stringify(process.env[MEMORY_TOOL_ENV] ?? null)
  + '  ⇒ ' + (envOn ? '开' : '关'))
console.log('  ② ' + patchPath)
console.log('     ' + (profile.exists ? '' : '(不存在) ') + profile.why + '  ⇒ ' + (profile.on ? '开' : '关'))
console.log('  ③ ' + homePatchPath)
console.log('     ' + (home.exists ? '' : '(不存在) ') + home.why + '  ⇒ ' + (home.on ? '开' : '关')
  + (home.exists ? '' : '(本机实测:该文件不存在 ⇒ 那一层为空,正常)'))
console.log('  ④ ' + settingsPath)
console.log('     ' + (settings.exists ? '' : '(不存在) ') + settings.why + '  ⇒ ' + (settings.on ? '开' : '关'))

const on = envOn || profile.on || home.on || settings.on
console.log('-'.repeat(72))
console.log('总读数: **' + (on ? '开' : '关') + '**'
  + (on ? '（来源:' + (envOn ? 'env' : (profile.on || home.on ? 'loader-config' : 'settings')) + '）' : ''))
console.log('⚠️ 两句话别混(**配置怎么写** ≠ **真机注册成功**):')
console.log('   · 「**配置怎么写**」= **本脚本能证的**,就是上面这份只读体检(三处各是什么、总读数)。')
console.log('   · 「**真机注册成功**」= 只有 `apply()` 那一刻的日志')
console.log('     (`echo: 子代理记忆工具已开(4 个,只读;来源 …)`)或**面板卡片上的 `registered` = 4** 能证。')
console.log('     ⇒ **要证真机注册,看面板那张卡(调参页)或日志**;配置对 ≠ 注册成功')
console.log('       (store 缺席 / 注册抛错都会整体退回关,面板上的 `applied/reason` 照实说是哪种)。')
process.exit(0)
