/**
 * 事故回归闸:`lib/index.js` 里**裸赋值的布尔闸**必须有声明。
 *
 * 2026-10-05 事故:`24f6d86` 插接线块时把 `let reflectingMemory = false` 那一行
 * 吃掉了,引用(`reflectionTick` 里三处)还在 —— 心跳一触发就
 * `ReferenceError: reflectingMemory is not defined`,**把 `dsh web` 打死**。
 * `npm run check` 的 `check-syntax` 只查语法,`ReferenceError` 必须真跑才炸,
 * 而 `lib/index.js` 是插件入口,测试里 import 不动它 —— 所以这里用静态扫描补这道闸。
 *
 * 判定口径(刻意保守,避免把"给参数赋值"误报成 bug):
 *   · 只看**缩进 ≥2 空格、整行就是 `名字 = true|false`** 的赋值(`let/const/var` 一行不算);
 *   · 该名字必须在本文件里出现过 `let|const|var 名字` 的声明,或者出现在某个参数表里
 *     (`function (…)` / `=> (…)` 里以 `名字` 结尾或 `名字,` 出现)—— 命中任一即放行;
 *   · 否则红:这条就是"引用还在、声明没了"的形状。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const lines = src.split('\n')

test('index.js:每个裸赋值的布尔闸都有声明(防"引用还在、声明没了")', () => {
  const suspects = []
  lines.forEach((line, i) => {
    const m = /^\s{2,}([A-Za-z_$][\w$]*)\s*=\s*(true|false)\s*$/.exec(line)
    if (!m) return
    if (/\b(let|const|var)\b/.test(line)) return
    suspects.push({ name: m[1], line: i + 1 })
  })
  assert.ok(suspects.length > 0, '一个都没扫到?正则或文件结构变了,这道闸失效了')

  const declared = new Set()
  for (const m of src.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  // 参数表兜底:`(a, b)` / `(a = 1)` 里的名字也算"有出处"
  for (const m of src.matchAll(/\(([^()]{0,200})\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split('=')[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
    }
  }

  const orphans = suspects.filter((s) => !declared.has(s.name))
  assert.deepEqual(
    orphans.map((s) => s.name + '(行 ' + s.line + ')'),
    [],
    '这些闸被赋值但全文件找不到声明 ⇒ 运行到就会 ReferenceError 打死宿主:' + orphans.map((s) => s.name).join('、')
  )
})

test('index.js:reflectionTick 的整固互斥闸三件套齐全(定义 + 读 + 写 + 复位)', () => {
  assert.match(src, /\blet\s+reflectingMemory\s*=\s*false\b/, '互斥闸必须有声明')
  assert.match(src, /if\s*\(\s*reflectingMemory\s*\)\s*return/, '要有入口互斥判断')
  assert.match(src, /reflectingMemory\s*=\s*true/, '要有置位')
  assert.match(src, /reflectingMemory\s*=\s*false/, '要有复位(否则整固只跑一次)')
})
