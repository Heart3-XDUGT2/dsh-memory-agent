/**
 * BOM 闸(`npm run check` 里的一环)。
 *
 * 为什么值得单开一个闸:2026-09-28 夜里我用 PowerShell 的 `Set-Content -Encoding utf8`
 * 改了一行 `package.json`,于是文件开头多了 3 个字节 `EF BB BF` ——
 * `require()` 会自动吞掉它,**但 `readFileSync` + `JSON.parse` 不会**:
 * `tests/manifest.test.js` / `sidecar.test.js` 当场炸出
 * 「SyntaxError: Unexpected token '﻿'」,而 `npm run hygiene` 当时**报 0 条问题**
 * (它只看 import/过导出/垃圾/孤儿文档,不看字节)。
 *
 * 所以:凡是人肉/脚本改过的文本文件,交付前扫一遍字节头。
 * 规矩:UTF-8 **不带** BOM(仓库全 LF、无 BOM);带 BOM 的一律报错。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
// `.scratch` = 仓库里唯一的**草稿区**(gitignore 了):检索实验的 dump / 论文 HTML /
// 真库快照,还有临时写出来的带 BOM / UTF-16 的样本文件。它里面的字节不是交付物,
// 却会让「全仓无 BOM」这条判据红成一片 —— 于是这个闸自己给自己放行这一处
// (2026-09-30:`.scratch/` 下写试验样本不再让 `npm run check` 红)。
const SKIP_DIRS = new Set(['node_modules', '.git', 'archive', '__pycache__', '.venv', 'venv', '.scratch'])
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.py', '.txt', '.yml', '.yaml', '.html', '.css'])

function listFiles (dir, out = []) {
  let names = []
  try { names = readdirSync(dir) } catch { return out }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    let st = null
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) listFiles(p, out)
    else out.push(p)
  }
  return out
}

const offenders = []
for (const f of listFiles(ROOT)) {
  if (!TEXT_EXT.has(extname(f).toLowerCase())) continue
  let bytes = null
  try { bytes = readFileSync(f) } catch { continue }
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    offenders.push([relative(ROOT, f).replace(/\\/g, '/'), 'UTF-8 BOM'])
  } else if (bytes.length >= 2 && ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF))) {
    offenders.push([relative(ROOT, f).replace(/\\/g, '/'), 'UTF-16 BOM'])
  }
}

if (offenders.length === 0) {
  console.log('BOM 闸:过(全仓无 BOM;`require()` 会吞掉它,`JSON.parse` 不会 —— 所以必须有这个闸)')
} else {
  console.error('BOM 闸:❌ ' + offenders.length + ' 个文件带 BOM —— 用 [System.IO.File]::WriteAllText($p,$s,(New-Object System.Text.UTF8Encoding($false))) 重写,别用 Set-Content -Encoding utf8:')
  for (const [f, kind] of offenders) console.error('   ' + f + '  (' + kind + ')')
  process.exitCode = 1
}
