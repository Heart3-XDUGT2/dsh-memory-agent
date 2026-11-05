// 仓库卫生报告(只读,不作判据 —— 卫生阈值是模糊的,硬判会变成噪声源)。
//
// 起因:2026-09-26 他让「检查一下代码的卫生情况,把以前遗留的 plan / 用不着的
// 文件删掉」。一次性盘查容易做完就忘,所以把判据固化成这个脚本:
//
//   1. 没用到的 import —— 客观、可自动判定(符号在文件里除 import 行外零出现)
//   2. lib/ 里「过导出」的常量 —— export 了但全仓没人 import(不算错,只是噪声)
//   3. 工作区垃圾 —— *.bak / *.old / *.tmp / *~ / __pycache__ / *.log
//   4. docs/ 里没有任何代码引用的文档 —— 提示「也许该归档」
//
// 用法:`npm run hygiene`。要它红着退出,得先把阈值吵清楚 —— 现在只是把
// 「该看一眼了」的东西摆出来,判断留给人。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set(['.git', 'node_modules', 'archive', '__pycache__'])
const TEXT_RE = /\.(js|mjs|py|json|md|yml|html|css)$/i

/** 递归列出仓库里的文本文件(跳过 .git/node_modules/archive)。 */
function listFiles (dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) listFiles(p, out)
    else out.push(p)
  }
  return out
}

const files = listFiles()
const text = new Map()
for (const f of files) {
  if (!TEXT_RE.test(f)) continue
  try { text.set(f, readFileSync(f, 'utf8')) } catch { /* 读不了就跳过 */ }
}
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')

// ---- 1. 没用到的 import ----
const unusedImports = []
for (const [f, body] of text) {
  if (!f.endsWith('.js') && !f.endsWith('.mjs')) continue
  const lines = body.split(/\r?\n/)
  const names = []
  for (const l of lines) {
    const m = /^\s*import\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s+from/.exec(l)
    if (!m) continue
    if (m[1]) for (const p of m[1].split(',')) {
      const n = p.trim().split(/\s+as\s+/).pop().trim()
      if (n) names.push(n)
    } else if (m[2]) names.push(m[2])
  }
  const bodyNoImport = lines.filter((l) => !/^\s*import\s/.test(l)).join('\n')
  const bad = names.filter((n) => !new RegExp('\\b' + n.replace(/\$/g, '\\$') + '\\b').test(bodyNoImport))
  if (bad.length > 0) unusedImports.push([rel(f), bad])
}

// ---- 2. lib/ 过导出 ----
const overExported = []
for (const [f, body] of text) {
  if (!rel(f).startsWith('lib/')) continue
  const names = new Set()
  for (const m of body.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of body.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim()
      if (n) names.add(n)
    }
  }
  for (const n of names) {
    let seen = false
    for (const [g, b] of text) {
      if (g === f) continue
      if (new RegExp('\\b' + n.replace(/\$/g, '\\$') + '\\b').test(b)) { seen = true; break }
    }
    if (!seen) overExported.push([rel(f), n])
  }
}

// ---- 3. 工作区垃圾 ----
const junk = []
const JUNK_RE = /(\.bak$|\.old$|\.tmp$|~$|\.orig$|\.rej$|\.log$|commitmsg)/i
for (const f of files) if (JUNK_RE.test(f)) junk.push(rel(f))
for (const f of files) if (/__pycache__|\.pyc$/.test(f)) junk.push(rel(f))

// ---- 4. 没人引用的文档 ----
const docs = files.filter((f) => rel(f).startsWith('docs/'))
const orphanDocs = []
for (const d of docs) {
  const b = rel(d).split('/').pop()
  let seen = false
  for (const [g, body] of text) {
    if (g === d || rel(g).startsWith('docs/')) continue
    if (body.includes(b)) { seen = true; break }
  }
  if (!seen) orphanDocs.push(rel(d))
}

// ---- 报告(永远 exit 0) ----
const say = (s) => console.log(s)
say('echo 仓库卫生报告(只读;不作判据,判断留给人)')
say('')
say('  1. 没用到的 import:' + (unusedImports.length === 0 ? ' 无' : ''))
for (const [f, names] of unusedImports) say('       ' + f + '  →  ' + names.join(', '))
say('  2. lib/ 过导出(export 了但没人 import;若只在本文件内用,去掉 export 即可):' + (overExported.length === 0 ? ' 无' : ''))
for (const [f, n] of overExported) say('       ' + f + '  →  ' + n)
say('  3. 工作区垃圾:' + (junk.length === 0 ? ' 无' : ''))
for (const f of junk) say('       ' + f + '   (可删)')
say('  4. docs/ 里没有任何代码引用的文档(也许该归档到 archive/):' + (orphanDocs.length === 0 ? ' 无' : ''))
for (const f of orphanDocs) say('       ' + f)
say('')
say('  归档策略:已完成的计划 → `git mv docs/X archive/docs/X`(可随时挪回);')
say('            零引用的常量/import → 删(git 历史都在);')
say('            原始转储(几 MB 的 json)→ 删,只留可读版。')
if (existsSync(join(ROOT, 'archive'))) say('            现在 archive/ 里:见 archive/README.md')
