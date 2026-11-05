// dsh-echo — 阶段 2 形态 (b) 的 4 个只读记忆工具:**token 成本实测**(估算,非真实分词)
// ============================================================================
// 为什么要这个:`PLAN_MEMORY_GRAPH_ACTION.md` 里"每轮 400–700 token"是**估算的估算**
// (没人量过)。这个脚本用**真实工具 schema 的 JSON 字符数**给两档,口径写死在屏幕上,
// 谁都能复算。
//
// 两档(任务书要求):
//   (a) 全量 = 4 个工具的 `name` + `description` + `inputSchema`(宿主编译后的那个)
//   (b) 只算 `description`
//
// 两条换算口径(都打印,别只信一条):
//   · 4 chars/token —— 常见英文/代码口径(DeepSeek 系公开口径)
//   · 1.5 chars/token —— 中文重的口径(本项目 description 是中文)
//   ⚠️ **估算,非真实分词** —— 真值要用真 tokenizer 数;这里只做量级与两档差额。
//
// 为什么不需要临时 junction:本模块(`lib/memory-read-tools.js`)只 import
// `./retrieve.js`,**零宿主依赖**;宿主那侧只借一个 `defineTool`(按绝对路径 import),
// 所以不往本仓写任何 node_modules。
//
// 用法:`node scripts/memory-tools-cost.mjs`

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** 与 scripts/check_tools.mjs 同一份候选表(宿主 dsh-tools 的位置)。 */
function candidates () {
  const out = []
  if (process.env.DSH_TOOLS_PATH) out.push(process.env.DSH_TOOLS_PATH)
  out.push('@deepseek-ai/dsh-tools')
  const appData = process.env.APPDATA
  const roots = [
    appData ? join(appData, 'npm', 'node_modules') : null,
    join(homedir(), '.npm-global', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules'
  ].filter(Boolean)
  for (const root of roots) {
    out.push(join(root, '@deepseek-ai', 'dsh', 'node_modules',
      '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  }
  return out
}

async function loadDefineTool () {
  const tried = []
  for (const c of candidates()) {
    const bare = c.startsWith('@')
    if (!bare && !existsSync(c)) { tried.push(c + ' (不存在)'); continue }
    try {
      const mod = await import(bare ? c : pathToFileURL(c).href)
      if (typeof mod.defineTool === 'function') return { defineTool: mod.defineTool, entry: c }
      tried.push(c + ' (无 defineTool 导出)')
    } catch (err) {
      tried.push(c + ' (' + String(err?.code ?? err) + ')')
    }
  }
  return { defineTool: null, tried }
}

const { createReadOnlyReader, memoryReadToolDefinitions } = await import(
  pathToFileURL(join(repoRoot, 'lib', 'memory-read-tools.js')).href)
const { openStore } = await import(pathToFileURL(join(repoRoot, 'lib', 'store.js')).href)

const store = openStore(':memory:')
const raw = memoryReadToolDefinitions(createReadOnlyReader(store))

const { defineTool, entry, tried } = await loadDefineTool()
let shapes
let mode
if (defineTool !== null) {
  // 宿主编译后的真实形状:`parameters` 就是 wire 上的 `inputSchema`。
  shapes = raw.map((def) => {
    const t = defineTool(def)
    return { name: t.name, description: t.description, inputSchema: t.parameters }
  })
  mode = '宿主 defineTool 编译后(与真机注册的那份同源)'
} else {
  // 离线兜底:没有宿主时量 author-facing 的 `parameters`(**不是**编译后的形状)。
  shapes = raw.map((def) => ({ name: def.name, description: def.description, inputSchema: def.parameters }))
  mode = '离线兜底:author-facing parameters(**非**编译后形状,数字偏小)'
  console.log('找不到宿主 @deepseek-ai/dsh-tools,走离线兜底。找过: ' + (tried || []).join(' / '))
}
store.close()

const json = (v) => JSON.stringify(v)
const per = shapes.map((s) => {
  const full = json(s)
  const desc = json(s.description)
  const schemaOnly = json(s.inputSchema)
  return { name: s.name, full: full.length, desc: desc.length, schema: schemaOnly.length }
})

const sum = (k) => per.reduce((a, b) => a + b[k], 0)
const fullAll = sum('full')
const descAll = sum('desc')
const est = (chars, ratio) => Math.round(chars / ratio)

console.log('')
console.log('4 个只读记忆工具的 token 成本实测(口径:' + mode + ')')
console.log('='.repeat(72))
console.log('每个工具(JSON 字符数):')
for (const p of per) {
  console.log('  ' + p.name.padEnd(18) + ' 全量 ' + String(p.full).padStart(5)
    + '  |  description ' + String(p.desc).padStart(4)
    + '  |  inputSchema ' + String(p.schema).padStart(5))
}
console.log('-' .repeat(72))
console.log('(a) 全量 name+description+inputSchema : ' + String(fullAll) + ' 字符/轮')
console.log('     ≈ ' + String(est(fullAll, 4)) + ' tokens @4chars  |  '
  + String(est(fullAll, 1.5)) + ' tokens @1.5chars(中文口径)')
console.log('(b) 只算 description                : ' + String(descAll) + ' 字符/轮')
console.log('     ≈ ' + String(est(descAll, 4)) + ' tokens @4chars  |  '
  + String(est(descAll, 1.5)) + ' tokens @1.5chars(中文口径)')
console.log('-' .repeat(72))
console.log('差额(a-b):inputSchema + name = ' + String(fullAll - descAll) + ' 字符/轮')
console.log('⚠️ 以上为**估算,非真实分词**;真值需真 tokenizer。')
console.log('⚠️ 只在开关打开时才有这份成本(默认关 = 一个工具都不注册 = 0)。')
