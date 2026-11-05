/**
 * 审计面板外观 —— P0：对比度 / 导航标题 / 配色统一（2026-10-18）
 * ==================================================================
 * 他拍了「甲」：**统一到 `style.css` 的蓝黑+青**，`audit-cards.html` 跟着走。
 *
 * 这个文件钉住 P0 的三件事：
 *   ① `--dimmer` 必须 ≥4.5:1（改前 `#6b7c96` 在所有底上都不到，card 上只有 3.77）
 *   ② 导航标题不许被注入元数据污染（改前显示成 `[QQ:群聊] 来群里 → 陪伴会话(兜底)(权`）
 *   ③ 两个面板的配色是**同一个世界**（同一组 token 值）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const CSS = read('../web/style.css')
const HTML = read('../web/audit-cards.html')

// ───────────────────────── 颜色工具（不改文件，纯算） ─────────────────────────
function rgb (h) { const s = h.replace('#', ''); return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)] }
function lin (c) { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
function lum (h) { const [r, g, b] = rgb(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) }
function contrast (a, b) { const l1 = Math.max(lum(a), lum(b)); const l2 = Math.min(lum(a), lum(b)); return (l1 + 0.05) / (l2 + 0.05) }

/** 从 style.css 的 :root 里抠出 token 值。
 *  ⚠️ 先剥注释：`:root` 里可能写着"改前 #6b7c96 只有 3.77"这种说明，
 *  不剥的话注释里的 `#hex` 会被当成某个 key 的值（这条闸自己踩过）。 */
function tokensOf (src) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = clean.match(/:root\s*\{([\s\S]*?)\}/)
  assert.ok(m, '找不到 :root')
  const out = {}
  for (const part of m[1].split(';')) {
    const kv = part.split(':')
    if (kv.length < 2) continue
    const k = kv[0].trim()
    const v = kv.slice(1).join(':').trim()
    if (k.startsWith('--') && /^#[0-9a-fA-F]{6}$/.test(v)) out[k] = v
  }
  return out
}

const TOK = tokensOf(CSS)
const SURFACES = ['--bg', '--bg-2', '--panel', '--card', '--sunken', '--raise']

test('① ★ --dimmer 在**每一个**底色上都 ≥4.5:1（改前 card 上只有 3.77）', () => {
  const dimmer = TOK['--dimmer']
  assert.ok(dimmer, '--dimmer 必须存在')
  const bad = []
  for (const s of SURFACES) {
    const bg = TOK[s]
    if (!bg) continue
    const r = contrast(dimmer, bg)
    if (r < 4.5) bad.push(s + '=' + r.toFixed(2))
  }
  assert.deepEqual(bad, [],
    '★ --dimmer=' + dimmer + ' 在这些底上不到 4.5:1: ' + bad.join(', ')
    + '（craft-floor：正文/次要文字 ≥4.5:1）')
})

test('② --dimmer 仍然暗于 --dim（层级没被提亮压塌）', () => {
  assert.ok(lum(TOK['--dimmer']) < lum(TOK['--dim']),
    '--dimmer 该比 --dim 暗；现在 dimmer=' + lum(TOK['--dimmer']).toFixed(3) + ' dim=' + lum(TOK['--dim']).toFixed(3))
  assert.ok(lum(TOK['--dim']) < lum(TOK['--ink-2']), '--dim < --ink-2')
  assert.ok(lum(TOK['--ink-2']) < lum(TOK['--ink']), '--ink-2 < --ink')
})

test('③ ★ 两个面板是同一个配色世界（audit-cards 的 token 值 = style.css 的）', () => {
  const cardsTok = tokensOf(HTML)
  // audit-cards 的变量名 → style.css 的变量名
  const MAP = {
    '--bg': '--bg', '--p1': '--panel', '--p2': '--card', '--p3': '--raise',
    '--ln': '--line', '--ln2': '--line-hi', '--tx': '--ink', '--mut': '--dim',
    '--amb': '--accent', '--tea': '--ok', '--ros': '--bad',
    '--sky': '--accent-2', '--vio': '--violet'
  }
  const bad = []
  for (const [a, b] of Object.entries(MAP)) {
    if (cardsTok[a] === undefined || TOK[b] === undefined) { bad.push(a + '/' + b + ' 缺'); continue }
    if (cardsTok[a].toLowerCase() !== TOK[b].toLowerCase()) bad.push(a + '=' + cardsTok[a] + ' 但 ' + b + '=' + TOK[b])
  }
  assert.deepEqual(bad, [], '★ 两个面板的世界必须一致（他拍「甲」）:\n  ' + bad.join('\n  '))
  // 琥珀必须是历史（他拍的甲：琥珀→青）
  assert.equal((HTML.match(/#e2b052/gi) || []).length, 0, '★ 琥珀 #e2b052 不许再出现')
})

test('④ audit-cards 自己的配色也全过 4.5:1（前景 × 底色矩阵）', () => {
  const cardsTok = tokensOf(HTML)
  const FG = ['--tx', '--mut', '--amb', '--tea', '--ros', '--sky', '--vio']
  const BG = ['--bg', '--nav', '--p1', '--p2', '--p3', '--ln']
  const bad = []
  for (const f of FG) {
    for (const b of BG) {
      if (!cardsTok[f] || !cardsTok[b]) continue
      const r = contrast(cardsTok[f], cardsTok[b])
      if (r < 4.5) bad.push(f + ' on ' + b + ' = ' + r.toFixed(2))
    }
  }
  assert.deepEqual(bad, [], '★ 这些组合不达 4.5:1:\n  ' + bad.join('\n  '))
})

// ───────────────────────── 导航标题去污染 ─────────────────────────
function loadCleanTitle () {
  const a = HTML.indexOf('    const TOOL_HUMAN=')
  const b = HTML.indexOf('    const mk=g=>')
  assert.ok(a > 0 && b > a, '抽不到 TOOL_HUMAN / cleanTitle')
  const code = HTML.slice(a, b).replace('const TOOL_HUMAN=', 'var TOOL_HUMAN=')
  const sandbox = {}
  // eslint-disable-next-line no-new-func
  new Function('s', code + '\n; s.cleanTitle = cleanTitle;')(sandbox)
  return sandbox.cleanTitle
}

test('⑤ ★ 导航标题不再被注入元数据污染（这是 P0 的第二件事）', () => {
  const ct = loadCleanTitle()
  const cases = [
    // 桥信封 + 路由尾巴 → 只留人话
    ['[QQ:群聊] 来群里 → 陪伴会话(兜底)(权限:already:read-only)', '来群里'],
    ['[QQ:私聊] 在忙 → 陪伴会话(兜底)(权限:already:read-only)', '在忙'],
    // 私聊注入信封
    ['【QQ·私聊】阿岚说:评价一下', '评价一下'],
    // 群注入信封：头/提示行/说:正文 三行 —— 要跨到第三行取正文
    ['【QQ·群聊(875432047)】阿岚（主人）\n[系统：本条来自群聊…]\n[这是主人…]\n说:在吗', '在吗'],
    ['【QQ·群聊(875432047)】张三#7890（非主人）\n[系统：…]\n[警惕：…]\n说:我也觉得', '我也觉得'],
    // 她自己的手
    ['(用 QQ 说)嗯～那你慢慢忙～我在这儿等你呢～', '嗯～那你慢慢忙～我在这儿等你呢～'],
    // 正文里的冒号**不许**被当成人名剁掉
    ['(用 QQ 说)查到了：审计面板报的 workspace 是 %USERPROFILE%', '查到了：审计面板报的 workspace 是 %USER'],
    // 已经是人话的别动
    ['(记忆整固·失败)', '(记忆整固·失败)'],
    ['？？？？？？你删错了吧', '？？？？？？你删错了吧']
  ]
  const bad = []
  for (const [input, want] of cases) {
    const got = ct([{ user_input: input, tool_call: '' }])
    if (got !== want) bad.push(JSON.stringify(input.slice(0, 34)) + ' → ' + JSON.stringify(got) + '（期望 ' + JSON.stringify(want) + '）')
  }
  assert.deepEqual(bad, [], '★ 标题清洗不对:\n  ' + bad.join('\n  '))
})

test('⑥ 剥空了要退回 tool_call 的人话名（不许留空白标题）', () => {
  const ct = loadCleanTitle()
  assert.equal(ct([{ user_input: '', tool_call: 'relay_in' }]), '他说')
  assert.equal(ct([{ user_input: '', tool_call: 'reflection_failed' }]), '记忆整固失败')
  assert.equal(ct([{ user_input: '(工具) ', tool_call: 'emotion_decay' }]), '情绪衰减')
  assert.equal(ct([{ user_input: '', tool_call: '没登记的工具' }]), '没登记的工具', '没登记的退回原名，不编')
  assert.equal(ct([{ user_input: '', tool_call: '' }]), '(无标题)')
})

test('⑦ 原文不丢：导航按钮挂 title 做悬浮，详情页本来就有全文', () => {
  assert.ok(HTML.includes('title="${esc(t.raw)}"'), '★ 导航按钮要挂 title，否则截断后就再也看不到原文')
  assert.match(HTML, /const mk=g=>\(\{title:cleanTitle\(g\),raw:/, 'mk 要同时带 title 与 raw')
})
