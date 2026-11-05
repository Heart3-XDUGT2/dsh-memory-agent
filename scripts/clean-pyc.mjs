#!/usr/bin/env node
/**
 * 打包前清 `__pycache__` / `*.pyc`(2026-09-29 交接时补)。
 *
 * 为什么必须有这一步,而不是靠 `.npmignore` 或"记得删":
 *   `package.json` 的 `files` 是**白名单**,白名单里的目录是**整目录**收 ——
 *   `scripts/` 与 `python/engine/` 一旦被列进去,里面**任何**文件都会进 tgz,
 *   `.npmignore` / `.gitignore` **一律无效**(npm 的既有语义:files 压过 .npmignore)。
 *   而本机跑 Python 测试(`python -m unittest discover`)必然在
 *   `python/engine/__pycache__` 与 `scripts/__pycache__` 里落 .pyc ——
 *   2026-09-29 实测一次 `npm pack` 带进去 **22 个 .pyc**。
 *   所以挂在 `prepack`:**每次 `npm pack` / `npm publish` 之前真删一遍**,
 *   清完还会把结果打出来(0 个才算过),不靠自觉。
 *
 * 顺带把 `.scratch/` 之外**整仓**的 __pycache__ 也扫掉(`archive/` 里也有),
 * 免得下次有人把它加进 files 时踩同一个坑。
 *
 * 用法:
 *   node scripts/clean-pyc.mjs            # 删(默认,prepack 就是这条)
 *   node scripts/clean-pyc.mjs --check    # 只报不删;有残留就 exit 1(给打包验收用)
 */
import { readdirSync, rmSync, statSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ONLY = process.argv.includes('--check')

/** 不进去的地方:依赖树、临时草稿区(.scratch 里也有 __pycache__,那不是仓库的东西)。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.scratch'])

/** 递归收集所有 `__pycache__` 目录与游离的 `*.pyc`。 */
function collect (dir, found = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return found }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      if (e.name === '__pycache__') { found.push(full); continue }
      collect(full, found)
    } else if (e.isFile() && e.name.endsWith('.pyc')) {
      found.push(full)
    }
  }
  return found
}

const targets = collect(ROOT)
const rel = (p) => p.slice(ROOT.length + 1).replace(/\\/g, '/')

if (targets.length === 0) {
  console.log('clean-pyc: 0 个 __pycache__ / *.pyc —— 干净')
  process.exit(0)
}

if (CHECK_ONLY) {
  console.error('clean-pyc: 还有 ' + targets.length + ' 处残留(打包会带进去):')
  for (const t of targets) console.error('  - ' + rel(t))
  console.error('修:node scripts/clean-pyc.mjs')
  process.exit(1)
}

let removed = 0
for (const t of targets) {
  try {
    const rootReal = realpathSync(resolve(ROOT)), targetReal = realpathSync(t)
    if (!targetReal.startsWith(rootReal + sep)) throw new Error('Refusing cleanup outside this checkout')
    // statSync 只为看清是目录还是文件(用 rmSync 的 recursive 两种都能删)
    statSync(t)
    rmSync(t, { recursive: true, force: true })
    removed++
  } catch (err) {
    console.error('clean-pyc: 删不掉 ' + rel(t) + ' — ' + String(err?.message ?? err))
  }
}
console.log('clean-pyc: 删掉 ' + removed + ' 处 __pycache__ / *.pyc(下次 npm pack 不会再带进去)')
