/**
 * 审计面板外观 —— P3：审计详情区不挂侧色条（2026-10-18）
 * ==================================================================
 * 验收时跑 impeccable 的 detector（`scripts/impeccable detect`），它报 4 处 `side-tab`：
 *   `style.css:71`  全局 h3         ← **会透进审计详情区**
 *   `style.css:194` .hint
 *   `style.css:204` .setup-banner
 *   `style.css:409` .th（悬置话题卡）
 *
 * 第一条是本次范围内的：全局 `h3` 带 `border-left: 3px solid var(--accent)`，
 * 而 `.ar-body h3` 只覆盖了 margin ⇒ 审计面板每张小卡里的
 * 「用户这一轮说的 / 她的回复 / …」都拖一条彩色竖线，
 * 正是 detector 说的「AI 生成界面最典型的记号」。
 *
 * 后三条属于**别的面板**（设置提示 / 启动横幅 / 悬置话题），
 * 不在「两个审计面板」里，本轮**只报告不动手** —— 动它们等于重刷整个应用的外观。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CSS = readFileSync(fileURLToPath(new URL('../web/style.css', import.meta.url)), 'utf8')

test('① ★ 审计区（.ar 家族）的 h3 不挂侧色条', () => {
  assert.match(CSS, /\.ar h3 \{ padding-left: 0; border-left: 0 \}/,
    '★ 要有 .ar h3 的收口覆盖 —— 否则审计详情每张小标题都拖一条 3px 彩色竖线')
})

test('② 覆盖必须排在通用 h3 之后（后写者赢）', () => {
  const h3At = CSS.indexOf('border-left: 3px solid var(--accent)')
  const ovAt = CSS.indexOf('.ar h3 { padding-left: 0; border-left: 0 }')
  assert.ok(h3At > 0, '找不到全局 h3 的侧色条')
  assert.ok(ovAt > h3At, '★ 覆盖要写在全局 h3 之后，否则会被盖掉')
})

test('③ 全局 h3 没被本次改动（其它面板观感不归这次）', () => {
  assert.match(CSS, /h3 \{\s*\n\s*font-size: \.96rem;[\s\S]{0,140}?border-left: 3px solid var\(--accent\)/,
    '全局 h3 的侧色条应当**原样保留** —— 本次只在 .ar 里收口')
})
