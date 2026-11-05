/**
 * Step C:向量臂那一行在面板上怎么显示。
 *
 * 两种测试混着用:
 *  ① **真执行** —— 把 `web/app.js` 里的 `embedLine` 抽出来跑,验格式化逻辑
 *     (纯源码断言只能验"写了没有",验不出"写对了没有");
 *  ② **源码级断言** —— 接线与 payload/schema 那两处(这个仓的既有约定,
 *     见 `voice-receipts.test.js:198` 与 `build-stamp.test.js:12`)。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const APP = fileURLToPath(new URL('../web/app.js', import.meta.url))
const INDEX = fileURLToPath(new URL('../lib/index.js', import.meta.url))

/** 从 app.js 里抽出 embedLine 那一整段(自包含)并**真跑**它。 */
function loadEmbedLine () {
  const src = readFileSync(APP, 'utf8')
  const start = src.indexOf('const EMBED_STALE_MS')
  assert.ok(start > 0, 'web/app.js 里找不到 EMBED_STALE_MS —— 改名了?')
  const end = src.indexOf('\nconst TOOL_LABELS', start)
  assert.ok(end > start, '找不到 embedLine 段的结束锚点(TOOL_LABELS)')
  const block = src.slice(start, end)
  // eslint-disable-next-line no-new-func
  return new Function(block + '\nreturn { embedLine, EMBED_STALE_MS }')()
}

const { embedLine, EMBED_STALE_MS } = loadEmbedLine()
const NOW = 1791786000000            // 固定"现在",免得测试随钟摆
const at = (offsetMs) => (NOW - offsetMs) / 1000

test('没有状态文件 ⇒ 明说"没装或没跑",不假装已预热', () => {
  assert.equal(embedLine(null, NOW), '向量臂:没装或没跑(没有状态文件)')
  assert.equal(embedLine(undefined, NOW), '向量臂:没装或没跑(没有状态文件)')
})

test('已预热 ⇒ 四样都报:状态 + 耗时 + 占用 + 更新时间', () => {
  const line = embedLine({ warmed: true, reason: 'ok', ms: 1053.4, rssMb: 155.9, at: at(1000), source: 'env' }, NOW)
  assert.match(line, /^向量臂:已预热/)
  assert.match(line, /预热 1053ms/, '耗时要四舍五入到整毫秒')
  assert.match(line, /占用 155\.9MB/, 'RSS 要一位小数')
  assert.match(line, /更新于 /)
  assert.doesNotMatch(line, /ok/, '成功时不该把 reason 也贴出来')
})

test('开关关着 ⇒ 说"关着(开关默认关)",不报成"未预热"', () => {
  const line = embedLine({ warmed: false, reason: '预热开关关着(默认)', ms: null, rssMb: null, at: at(1000), source: 'off' }, NOW)
  assert.match(line, /关着\(开关默认关\)/)
  assert.doesNotMatch(line, /未预热/)
  assert.doesNotMatch(line, /预热开关关着/, '关着不是失败,别把内部原因贴出来')
  assert.doesNotMatch(line, /预热 \d+ms/, '没预热就没有耗时')
})

test('预热中 ⇒ 有中间态,不显示成"关着"或"未预热"', () => {
  const line = embedLine({ warmed: false, reason: '预热中', ms: null, rssMb: null, at: at(500), source: 'env' }, NOW)
  assert.match(line, /预热中…/)
  assert.doesNotMatch(line, /关着/)
  assert.doesNotMatch(line, /未预热/)
})

test('真试过但失败 ⇒ 状态 + 原因都要露出来', () => {
  const line = embedLine({ warmed: false, reason: '模型文件缺: model.onnx', ms: null, rssMb: null, at: at(1000), source: 'env' }, NOW)
  assert.match(line, /未预热/)
  assert.match(line, /模型文件缺/, '失败原因必须可见 —— 不然排查无从下手')
})

test('读数过期 ⇒ 明说"读数停在…",不假装它还活着', () => {
  const fresh = embedLine({ warmed: true, reason: 'ok', ms: 900, rssMb: 150, at: at(1000), source: 'env' }, NOW)
  assert.match(fresh, /更新于 /)
  const stale = embedLine({ warmed: true, reason: 'ok', ms: 900, rssMb: 150, at: at(EMBED_STALE_MS + 60000), source: 'env' }, NOW)
  assert.match(stale, /读数停在 .*\(已过期\)/, 'worker 死了文件还在 —— 必须交代这是旧读数')
})

test('缺字段不许抛:ms/rssMb/at 都可能没有', () => {
  for (const em of [
    { warmed: true, reason: 'ok', source: 'env' },
    { warmed: false, reason: 'x', source: 'env' },
    { warmed: false, reason: '', source: 'off' }
  ]) {
    const line = embedLine(em, NOW)
    assert.ok(typeof line === 'string' && line.startsWith('向量臂:'), JSON.stringify(em))
  }
})

// ---- ② 接线与 payload/schema(源码级,这个仓的既有约定) ----

test('接线:总览的 info 块必须真的用上 embedLine', () => {
  const src = readFileSync(APP, 'utf8')
  assert.match(src, /el\('div', null, embedLine\(st\.embed, Date\.now\(\)\)\)/,
    'embedLine 定义了却没接进总览 —— 面板上看不到')
})

test('payload 必须带 embed,且 schema 必须声明它', () => {
  const src = readFileSync(INDEX, 'utf8')
  assert.ok(src.includes('embed: readEmbedState()'), 'statusPayload 必须带 embed')
  assert.match(src, /embed:\s*\{\s*\n\s*type: 'object',\s*\n\s*additionalProperties: false,/,
    'schema 里没声明 embed ⇒ additionalProperties:false 会把整个 echo_status 拒掉')
  // 六个字段一个都不能少(形状与 readEmbedState 对齐)
  for (const k of ['warmed', 'reason', 'ms', 'rssMb', 'at', 'source']) {
    assert.ok(src.includes(k + ':'), 'readEmbedState 少返回了 ' + k)
  }
})

test('读状态文件必须 never-throw(读不到 ⇒ null,不是抛)', () => {
  const src = readFileSync(INDEX, 'utf8')
  const i = src.indexOf('function readEmbedState')
  assert.ok(i > 0, '找不到 readEmbedState')
  const body = src.slice(i, src.indexOf('\n}', i))
  assert.ok(/catch\s*\{\s*return null\s*\}/.test(body), 'readEmbedState 必须 catch 后返回 null')
})
