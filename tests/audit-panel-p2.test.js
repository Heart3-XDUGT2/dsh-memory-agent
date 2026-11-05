/**
 * 审计面板外观 —— P2：降噪 / 骨架 / 错误态（2026-10-18）
 * ==================================================================
 * 依据 `impeccable` 的 operate.md：
 *   · :32 *"Every interactive component has: default, hover, focus, active, disabled, loading, error.
 *         Don't ship with half of these."*
 *   · :34 *"Skeleton states for loading, not spinners in the middle of content."*
 *   · :35 *"Empty states that teach the interface, not 'nothing here.'"*
 *   · :42 动效只传状态，150–250ms
 *
 * 三件事：
 *   ① **9 格阶段流降噪** —— 只让「发生过」的占方块，没发生的收成一行灰字
 *   ② **`.dots` 9 个彩点 → 一个「n/9 阶段」文字**
 *   ③ **骨架屏 + 错误态（带重试）+ 空态（教人怎么出数据）**
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HTML = readFileSync(fileURLToPath(new URL('../web/audit-cards.html', import.meta.url)), 'utf8')

test('① ★ 没发生的阶段不占方块，收成一行 `.skip-row`（仍可点）', () => {
  // 循环里遇到 !on 必须 continue 并记进 skipArr，不许再画 .nd
  assert.match(HTML, /if\(!on\)\{skipArr\.push\(k\);continue\}/,
    '★ 没发生的阶段要 continue，不许占等宽方块')
  assert.ok(HTML.includes('class="skip-row"'), '要有一行灰字摘要')
  assert.match(HTML, /<button class="skip" data-g="s\$\{k\}">\$\{k\} \$\{ST\[k\]\}<\/button>/,
    '★ 摘要里的每个阶段仍要是按钮（可查性不丢）')
  // 阶段流容器只在真的有节点时才开
  assert.match(HTML, /if\(flowH!==''\)h\+='<div class="flow">'\+flowH\+'<\/div>'/,
    '一格都没发生时不该留一个空的 .flow 撑出空白')
})

test('② ★ `.dots` 9 个彩点已换成「n/9 阶段」文字', () => {
  assert.equal(HTML.includes('class="dots"'), false, '★ .dots 的模板必须删掉')
  assert.equal(HTML.includes('.dots{'), false, '.dots 的 CSS 也要删掉')
  assert.match(HTML, /\$\{nSt\}\/9 阶段/, '★ 换成一个能读的"n/9 阶段"')
  assert.match(HTML, /const nSt=ST\.slice\(1\)\.filter\(\(_,j\)=>have\.has\('s'\+\(j\+1\)\)\)\.length/,
    'nSt 只数 s1..s9（轮外 s90 不算进"9 阶段"）')
})

test('③ ★ 骨架屏在 fetch **之前**画（不是转圈，是占位块）', () => {
  const skAt = HTML.indexOf('(function skeleton()')
  const fetchAt = HTML.indexOf("fetch('/api/echo/audit")
  assert.ok(skAt > 0, '要有骨架屏')
  assert.ok(fetchAt > skAt, '★ 骨架必须在 fetch 之前，否则等于没有')
  assert.ok(HTML.includes('.sk{'), '要有骨架块样式')
  assert.match(HTML, /@keyframes sk\{/, '骨架要有呼吸动画')
  // reduced-motion 下动画必须停（全局那条已经兜住）
  assert.match(HTML, /@media\(prefers-reduced-motion:reduce\)\{\*,?\*?::before/, '全局 reduced-motion 兜底要在')
})

test('④ ★ 错误态：说清问题 + 恢复办法 + 真能点的重试', () => {
  assert.ok(HTML.includes('没能取到审计数据'), '要有错误标题（命名问题）')
  assert.match(HTML, /<button class="retry" id="retry">重新读一次<\/button>/, '★ 要有一个真按钮，不是一句话')
  assert.match(HTML, /addEventListener\('click',\(\)=>location\.reload\(\)\)/, '★ 按钮要真的挂上动作')
  assert.ok(HTML.includes('先确认 <b>dsh web</b> 还在跑'), '要点名恢复办法')
  assert.ok(HTML.includes('数据一直在库里，刷新不会丢东西'), '要安抚（别让人以为数据没了）')
})

test('⑤ ★ 空态教人怎么出数据（不是"nothing here"）', () => {
  assert.ok(HTML.includes('这个窗口里还没有审计行'), '空态要有人话标题')
  assert.ok(HTML.includes('跑一轮对话（或在 QQ 里跟她说句话）再刷新就有了'), '★ 空态要教下一步')
})

test('⑥ 新交互元素都带 focus-visible（键盘可达）', () => {
  assert.match(HTML, /\.skip:focus-visible\{outline:2px solid var\(--amb\)/, '.skip 要有焦点环')
  assert.match(HTML, /\.err \.retry:focus-visible\{outline:2px solid var\(--amb\)/, '.retry 要有焦点环')
})

test('⑦ 语法闸：内联 script 仍能编译（改坏了整页白）', () => {
  const blocks = HTML.match(/<script>([\s\S]*?)<\/script>/g) || []
  assert.ok(blocks.length > 0, '页面里要有 script')
  for (const b of blocks) {
    const code = b.replace(/^<script>/, '').replace(/<\/script>$/, '')
    assert.doesNotThrow(() => new Function(code), 'script 块语法必须能过')
  }
})
