/**
 * 2026-10-09:钉住 extract 耗时起点规则 —— 跨主动开口轮后不许再用过期参照。
 * 背景(活库实测):`care` 轮不走 claim ⇒ `capture.startedAt` 仍是上一轮的值,
 * 该轮 extract 写出 1609707ms(≈27 分钟),而它实际只跑了 53 秒 ✗
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')

test('extract 耗时起点:主动开口轮 / 无起点 / 超 10 分钟 ⇒ 不写数(null)', () => {
  assert.ok(/snap\.proactive === true \|\| snap\.startedAt <= 0 \|\| \(Date\.now\(\) - snap\.startedAt\) > 600000/.test(src),
    '必须按 proactive / 无起点 / 超 10 分钟 三条件判 null —— 否则跨 care 轮会把整段空闲算进去')
  assert.ok(/\? null\s*\n\s*: Math\.max\(0, Date\.now\(\) - snap\.startedAt\)/.test(src),
    '可信起点时仍要照旧算(常规轮保持秒级)')
})

test('extract 耗时起点:阈值与页面防御一致(10 分钟)', () => {
  const page = readFileSync(fileURLToPath(new URL('../web/audit-cards.html', import.meta.url)), 'utf8')
  assert.ok(page.includes('600000'), '页面侧防御阈值也应是 600000ms(两处一致,别各写一份)')
})
