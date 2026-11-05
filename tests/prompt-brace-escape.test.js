/**
 * 提示词插值逃逸电池(2026-09-26 全仓审查补,高危)。
 *
 * 宿主的 system-prompt 组装会对**每一节**跑严格 `{{变量}}` 插值
 * (`dsh-system-prompt/lib/index.js:164-167`):名字没注册就
 * `throw new Error('unknown prompt variable …')`。而我们把一堆**自由文本**
 * 塞进节里 —— 他的原话、她的残句、LLM 摘要、审计行、人格资产、渠道标签。
 * 他只要在 QQ 里打一句 `{{随便}}`,整轮就失败,而且那份快照会在窗口里
 * 反复重现 ⇒ 连续多轮收不到回复。
 *
 * 所以:进提示词的路径一律过 `escapePromptBraces`(`{{` → `{ {`)。
 * 注意只转义**注入**那一份 —— 审计/面板/落库仍是他的原话(证据不许被改)。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTurnSnapshot, escapePromptBraces } from '../lib/turn-snapshot.js'

test('逃逸:{{ 被打断,普通文本与单个 { 不动', () => {
  assert.equal(escapePromptBraces('他说 {{x}} 了'), '他说 { {x}} 了')
  assert.equal(escapePromptBraces('{{a}}{{b}}'), '{ {a}}{ {b}}')
  assert.equal(escapePromptBraces('单个 { 与 } 没事'), '单个 { 与 } 没事')
  assert.equal(escapePromptBraces('正常的 JSON {"a":1}'), '正常的 JSON {"a":1}')
  assert.equal(escapePromptBraces(''), '')
  assert.equal(escapePromptBraces(null), '')
  assert.equal(escapePromptBraces(undefined), '')
})

test('逃逸:结果里再也不含 {{(宿主插值器认不出的东西)', () => {
  const hostile = '他把 {{unknown}}\n{{system}} 和 {{{triple}}} 都打进来了'
  const out = escapePromptBraces(hostile)
  assert.ok(!out.includes('{{'), '还有 {{ 漏过去 —— 宿主会当场抛错,整轮死')
  // 连续花括号整段拆开:{{ → { {,{{{ → { { {
  assert.equal(out, '他把 { {unknown}}\n{ {system}} 和 { { {triple}}} 都打进来了')
})

test('逃逸:任意长度/任意位置的连续 { 都不会留下相邻两个', () => {
  for (const n of [1, 2, 3, 4, 5, 9]) {
    const out = escapePromptBraces('{'.repeat(n) + 'x' + '}'.repeat(n))
    assert.ok(!out.includes('{{'), n + ' 个 { 之后还剩 {{:' + out)
  }
  // 交叉边界也要看:替换后新拼接出来的相邻 brace 同样危险
  assert.ok(!escapePromptBraces('a{{b{c{d{{e').includes('{{'))
})

test('逃逸:快照那一节走的是真路径(sectionOf 直接吃他的原话)', () => {
  const snap = createTurnSnapshot({ store: null, logger: null, engine: null })
  const sec = snap.sectionOf('他刚才说:{{让我看看}}这一段')
  assert.ok(!String(sec.text).includes('{{'), 'sectionOf 没逃逸 —— 这是进系统提示词的那一份')
  assert.equal(sec.name, 'echo:snapshot')
})

test('逃逸:每个往提示词节里塞自由文本的地方都过了这道闸', () => {
  // 源码级检查(弱,但能抓住"新加了一节忘了转义"):三处 section 的 text
  // 与快照的 sectionOf 都必须出现 escapePromptBraces
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const hits = (src.match(/escapePromptBraces\(/g) || []).length
  assert.ok(hits >= 3, 'echo:persona / echo:rules / echo:relay 三处都要转义,现在只有 ' + hits + ' 处')
  const snapSrc = readFileSync(new URL('../lib/turn-snapshot.js', import.meta.url), 'utf8')
  assert.ok(snapSrc.includes('text: escapePromptBraces(text)'), '快照节要转义')
})
