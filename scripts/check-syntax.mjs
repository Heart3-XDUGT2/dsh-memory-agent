#!/usr/bin/env node
/**
 * dsh-echo — 语法自检(遍历,不再手写清单)
 * ============================================================
 * 为什么有它:package.json 的 `check` 原来是一长串手写的 `node --check <文件>`,
 * 2026 全仓审计抓到两处后果 ——
 *   ① **漏**:lib/ 下 8 个模块(agent-scope / speech-guard / insert-priority /
 *      retrieve-ledger / query-expand / turn-trace / aliases-rewrite / preset-patch /
 *      external-event 等)没进清单,新写的文件**永远不会**被语法检查;
 *   ② **重**:`lib/diary.js` 在清单里出现了两次(改一处忘一处就是这么来的)。
 * 手写清单天生会漂;遍历天生不漂 —— 加文件不用改这里。
 *
 * 覆盖:lib/*.js + scripts/*.mjs + web/*.js + **web/views/*.js** + **web/*.html 里的内联脚本**。
 *
 * 2026-10-02 补的窟窿:`web/graph.html` 里有 1100 行内联 JS(整张动态图谱),却
 * **不在任何语法闸里** —— 我那天改了它,能证明它没写坏的只有"真浏览器里打开看一眼"。
 * 一次没跑浏览器就发出去的语法错误,会以"页面白屏"的形式落到他头上。内联脚本用
 * `new Function(源码)` 解析(**只解析、不执行**),和 `node --check` 同样是"能不能解析"。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** 目录下所有指定后缀的文件(**不递归** —— 平铺的目录;有子目录就该显式说出来)。
 *  P2 B2(2026-10-05):配置中心的页面视图落在 `web/views/`,所以这一层也要点名
 *  —— 子代理 B 报的窟窿:新视图文件原先**不进语法闸**(闸还会照旧说"全过")。 */
function filesIn (rel, suffix) {
  const abs = join(root, rel)
  let names = []
  try { names = readdirSync(abs) } catch { return [] }
  const out = []
  for (const name of names.sort()) {
    if (!name.endsWith(suffix)) continue
    let isFile = false
    try { isFile = statSync(join(abs, name)).isFile() } catch { isFile = false }
    if (isFile) out.push(rel + '/' + name)
  }
  return out
}

const targets = [...filesIn('lib', '.js'), ...filesIn('scripts', '.mjs'),
  ...filesIn('web', '.js'), ...filesIn('web', '.html'),
  ...filesIn('web/views', '.js')]

/** `.js` 直接查文件;`.html` 查它**内联**的脚本块(`<script src=...>` 那种是外部文件,跳过)。 */
function syntaxOf (rel) {
  const abs = join(root, rel)
  if (rel.endsWith('.js')) {
    const r = spawnSync(process.execPath, ['--check', abs], { stdio: 'ignore' })
    return r.status === 0 ? [] : [rel + (r.error ? ' (' + String(r.error.message ?? r.error) + ')' : '')]
  }
  let src = ''
  try { src = readFileSync(abs, 'utf8') } catch { return [] }
  const bad = []
  const blocks = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  blocks.forEach((body, i) => {
    if (!body.trim()) return
    try { new Function(body) } catch (e) { bad.push(rel + ' 内联脚本#' + (i + 1) + ':' + String(e.message ?? e)) }
  })
  return bad
}

const bad = []
for (const rel of targets) bad.push(...syntaxOf(rel))

if (bad.length > 0) {
  console.error('✗ 语法不过 ' + bad.length + ' 处 / ' + targets.length + ' 个文件:')
  for (const b of bad) console.error('  - ' + b)
  process.exit(1)
}
console.log('语法自检:' + targets.length + ' 个文件全过(lib/*.js + scripts/*.mjs + web/*.js + web/views/*.js + web/*.html 内联脚本)')
