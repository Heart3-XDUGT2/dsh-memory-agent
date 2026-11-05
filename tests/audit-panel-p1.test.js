/**
 * 审计面板外观 —— P1：去假边框 / 人名脱 mono / 裸值归 token（2026-10-18）
 * ==================================================================
 * 依据 `impeccable` 的 craft-floor：
 *   · **:35** 卡片/列表项上 **1px 以上的彩色左边框 = 禁**（`box-shadow: inset 2px 0` 是同一个东西的伪装）
 *   · **:38** 等宽字体只给**代码 / 数据 / 度量**，不当"技术感"的戏服 —— 人名不是
 *   · **:12** 颜色从 token 来，散在样式里的裸 hex 改主题时必然漏改
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const CSS = read('../web/style.css')
const HTML = read('../web/audit-cards.html')

test('① ★ 两个面板都不许再用 `inset Npx 0` 冒充彩色左边框（craft-floor:35）', () => {
  // style.css 里也不许有（同样的问题换个文件还是同一个问题）
  for (const [name, src] of [['style.css', CSS], ['audit-cards.html', HTML]]) {
    const hits = []
    // 只查"带颜色变量的 inset 左边框"，不误伤普通 inset 高光
    const re = /box-shadow\s*:\s*inset\s+[1-9]\d*px\s+0\s+(?:var\(|#|rgba?\()/g
    let m
    while ((m = re.exec(src)) !== null) {
      const line = src.slice(0, m.index).split('\n').length
      hits.push(name + ':' + line + '  ' + m[0])
    }
    assert.deepEqual(hits, [], '★ 这些地方还在用 inset 冒充左边框:\n  ' + hits.join('\n  '))
  }
})

test('② 选中态改用「整圈边框 + 底色」表达（不是左边一条）', () => {
  assert.ok(HTML.includes('.tn.on{background:var(--p2);border-color:var(--amb)}'),
    '★ .tn.on 应当是 background + border-color（整圈），不是 box-shadow inset')
  assert.ok(HTML.includes('.nd.has{background:color-mix'),
    '.nd.has 的"有内容"态靠 color-mix 底色 tint 表达')
})

test('③ ★ 人名脱 mono（craft-floor:38）', () => {
  const m = CSS.match(/\.ar-sum \.who\s*\{[^}]*\}/)
  assert.ok(m, '找不到 .ar-sum .who')
  assert.equal(/font-family\s*:\s*var\(--mono\)/.test(m[0]), false,
    '★ .ar-sum .who 渲染的是「谁说的」（人名），不该用等宽：' + m[0])
  // 度量类仍可 mono（不能一刀切把数据也脱了）
  assert.match(CSS, /\.ar-meta\s*\{[^}]*font-family:\s*var\(--mono\)/,
    '.ar-meta 是时间/桶这类度量信息，仍然该用等宽')
})

test('④ ★ 裸值归 token：`#dbeafe` / `rgba(76,194,245,.05)` 不许散在样式里', () => {
  // ⚠️ 先剥注释 —— 注释里会引用这些值说明"改前长什么样"（这条闸自己踩过）
  const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.equal((clean.match(/#dbeafe/gi) || []).length, 1,
    '#dbeafe 只许出现在 :root 的 --say-fg 定义那一处（其余全走 var）')
  assert.match(clean, /--say-fg:\s*#dbeafe/i, '要有 --say-fg token')
  assert.match(clean, /\.ar-sum\.say\s*\{\s*color:\s*var\(--say-fg\)/, '.ar-sum.say 要用 token')
  assert.match(clean, /\.brand-t b\s*\{[^}]*color:\s*var\(--say-fg\)/, '.brand-t b 也要用 token')
  assert.match(clean, /\.ar-head:hover\s*\{\s*background:\s*var\(--accent-ghost\)/, '.ar-head:hover 要用 token')
  assert.match(clean, /--accent-ghost:/, '要有 --accent-ghost token')
  // rgba(76,194,245,.05) 也不许再有第二处（只留 token 定义）
  const ghost = (clean.match(/rgba\(\s*76\s*,\s*194\s*,\s*245\s*,\s*\.?0?5\s*\)/g) || []).length
  assert.equal(ghost, 1, 'rgba(76,194,245,.05) 只许出现在 --accent-ghost 定义那一处，实际 ' + ghost)
})

test('⑤ note 那组 token 在两个文件里**值相同**（两个面板一个世界）', () => {
  const tokensOf = (src) => {
    const clean = src.replace(/\/\*[\s\S]*?\*\//g, '')
    const m = clean.match(/:root\s*\{([\s\S]*?)\}/)
    assert.ok(m, '找不到 :root')
    const out = {}
    for (const part of m[1].split(';')) {
      const kv = part.split(':')
      if (kv.length < 2) continue
      const k = kv[0].trim(); const v = kv.slice(1).join(':').trim()
      if (k.startsWith('--')) out[k] = v
    }
    return out
  }
  const a = tokensOf(CSS)
  const b = tokensOf(HTML)
  const bad = []
  for (const k of ['--say-fg', '--note-bg', '--note-fg', '--note-line']) {
    if (a[k] === undefined) { bad.push('style.css 缺 ' + k); continue }
    if (b[k] === undefined) { bad.push('audit-cards 缺 ' + k); continue }
    if (a[k].toLowerCase() !== b[k].toLowerCase()) bad.push(k + '：style=' + a[k] + ' cards=' + b[k])
  }
  assert.deepEqual(bad, [], '★ note/say token 两份必须一致:\n  ' + bad.join('\n  '))
})

test('⑥ audit-cards 里不许再有暖色硬编码（.note / .tag 的琥珀残留）', () => {
  for (const bad of ['#1d1a12', '#453a1f', '#d4bf8a', '#5a4a1e', '#a8cbc4', '#e2b052']) {
    assert.equal(HTML.toLowerCase().includes(bad.toLowerCase()), false,
      '★ audit-cards 里还有暖色硬编码 ' + bad + '（应该走 token 或 color-mix）')
  }
})
