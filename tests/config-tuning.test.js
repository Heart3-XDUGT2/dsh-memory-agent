/**
 * 配置中心 ⑥ 图论与显示调参页(`web/views/tuning.js`,P2 / B3)的单测。
 *
 * 三条纪律钉住(照 tests/config-profile.test.js 的先例):
 *   ① **契约扫描**:classic script(无模块语法)、只走注入的 `api`、端点与生效文案字面量都在;
 *   ② **纯逻辑**:键值行往返、数字 / 布尔判定、完整载荷合并(**未管字段一个不丢**、不改入参);
 *   ③ **桩 + 幂等**:DOM 桩只验"画了几笔、值对不对、画两遍不翻倍"——
 *      诚实标注:它**不是**浏览器 DOM,不验样式与真实布局。
 *
 * 加载方式:页面文件是 classic script,所以把源码喂给 `new Function('globalThis', src)`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../web/views/tuning.js', import.meta.url)), 'utf8')
const sandbox = {}
new Function('globalThis', src)(sandbox) // eslint-disable-line no-new-func
const V = sandbox.EchoViews && sandbox.EchoViews['tuning']
const P = V.pure

/** 等一轮 macro task:draw 的回包填充走微任务,等一拍最稳。 */
const tick = () => new Promise((resolve) => setImmediate(resolve))

/* ── ① 契约扫描 ─────────────────────────────────────────────── */

test('契约扫描:无 fetch / 无模块语法 / 无弹窗 / 不碰文件系统,端点与文案都在', () => {
  assert.doesNotMatch(src, /fetch\s*\(/, '视图不许自己发请求(取数只走 api)')
  assert.doesNotMatch(src, /^\s*(import|export)\b/m, 'classic script:不许模块语法')
  assert.doesNotMatch(src, /alert\s*\(/, '校验失败必须内联显示,不许弹窗')
  assert.doesNotMatch(src, /node:fs|writeFileSync|resolveDataFilePath|require\s*\(/,
    '视图不许出现文件系统路径 / 裸写盘(唯一写路是 API)')
  assert.match(src, /\/api\/echo\/data\/graph\.json/, '必须出现唯一读写端点')
  assert.match(src, /下次引擎调用生效/, '生效文案取自契约 §4(graph.json = next-engine-call),不许自创')
  assert.doesNotMatch(src, /已生效,刷新页面看界面/, '那是 profile.json 的文案,别串页')
  // 只许出现自己那一份数据文件名 —— 别的 7 个一个都不许冒出来
  for (const other of ['config.json', 'persona.json', 'profile.json', 'aliases.json', 'names.json',
    'state-defaults.json', 'lexicon.json']) {
    assert.equal(src.includes(other), false, '⑥ 页不许碰 ' + other)
  }
  assert.notEqual(V, undefined, 'EchoViews[\'tuning\'] 得挂上')
  assert.equal(typeof V.draw, 'function', 'draw 必须是函数')
  for (const fn of ['kvRows', 'rowsToObj', 'mergeGraphPayload', 'numOrNull', 'boolOrNull', 'errText']) {
    assert.equal(typeof P[fn], 'function', '纯逻辑得挂出来:' + fn)
  }
})

/* ── ② 纯逻辑 ────────────────────────────────────────────── */

test('kvRows / rowsToObj:往返一致(空表 / 单项 / 脏值都不炸)', () => {
  assert.deepEqual(P.kvRows({ wUnstale: 1, wEmotion: 0.5 }), [
    { key: 'wUnstale', value: 1 }, { key: 'wEmotion', value: 0.5 }
  ], '盘上的键按原次序铺成行')
  assert.deepEqual(P.kvRows({}), [], '空表 ⇒ 空行数组(页面自己会补一行空白)')
  assert.deepEqual(P.kvRows(null), [], '不是对象也不炸')
  // 往返:对象 → 行 → 对象(数组 / 对象 / 数字原样过;「像数字的字符串」会被认成数字,这是有意的)
  const obj = { a: 1, c: [1, 2], d: { k: 'v' }, e: '甲' }
  assert.deepEqual(P.rowsToObj(P.kvRows(obj)), obj, '往返必须一模一样')
  assert.deepEqual(P.rowsToObj(P.kvRows({ b: '2' })), { b: 2 },
    '像数字的字符串 ⇒ 数字(权重 / 阈值要的是数;键集不写死,只能按形状认)')
  assert.deepEqual(P.rowsToObj([]), {}, '空表 ⇒ 空对象')
  assert.deepEqual(P.rowsToObj([{ key: '  甲  ', value: ' 3.5 ' }]), { 甲: 3.5 }, '键 trim,值认数字')
  assert.deepEqual(P.rowsToObj([{ key: '', value: 1 }, null, 'oops']), {},
    '空键 / 脏行丢掉,只剩合法键')
  assert.deepEqual(P.rowsToObj([{ key: 'x' }]), { x: '' }, '有键没值 ⇒ 空串(不猜)')
  assert.deepEqual(P.rowsToObj([{ key: 'a', value: 1 }, { key: 'a', value: 2 }]), { a: 2 },
    '同键后者覆盖前者')
  assert.deepEqual(P.rowsToObj([{ key: 'arr', value: '["x","y"]' }]), { arr: ['x', 'y'] },
    'JSON 文本读回数组')
  assert.deepEqual(P.rowsToObj([{ key: 'bad', value: '[oops' }]), { bad: '[oops' },
    'JSON 坏掉原样当字符串,不吞错')
  assert.deepEqual(P.rowsToObj([{ key: 'empty', value: '' }]), { empty: '' }, '空值 ⇒ 空串')
})

test('numOrNull:空串 / 非数字 ⇒ null;"3.5" ⇒ 3.5', () => {
  assert.equal(P.numOrNull(''), null)
  assert.equal(P.numOrNull('   '), null)
  assert.equal(P.numOrNull('3.5'), 3.5)
  assert.equal(P.numOrNull(' -7 '), -7)
  assert.equal(P.numOrNull('1e3'), 1000)
  assert.equal(P.numOrNull('x'), null)
  assert.equal(P.numOrNull('3.5px'), null)
  assert.equal(P.numOrNull(null), null)
  assert.equal(P.numOrNull(undefined), null)
  assert.equal(P.numOrNull(true), null, '布尔不当数字')
  assert.equal(P.numOrNull(4), 4, '本来就是数字 ⇒ 原样')
  assert.equal(P.numOrNull(NaN), null)
  assert.equal(P.numOrNull(Infinity), null)
})

test('boolOrNull:只认真实的真假值,其余一律 null', () => {
  assert.equal(P.boolOrNull(true), true)
  assert.equal(P.boolOrNull(false), false)
  assert.equal(P.boolOrNull('true'), true)
  assert.equal(P.boolOrNull(' FALSE '), false)
  assert.equal(P.boolOrNull('1'), true)
  assert.equal(P.boolOrNull('0'), false)
  assert.equal(P.boolOrNull(1), true)
  assert.equal(P.boolOrNull(0), false)
  assert.equal(P.boolOrNull(''), null)
  assert.equal(P.boolOrNull('yes'), null)
  assert.equal(P.boolOrNull(2), null)
  assert.equal(P.boolOrNull(null), null)
})

test('errText:errors[] 优先,否则状态码 + 摘要,再否则兜底', () => {
  assert.equal(P.errText({ status: 400, payload: { errors: ['weights:不是数字', 'thresholds.a:空'] } }),
    'weights:不是数字 / thresholds.a:空')
  assert.equal(P.errText({ status: 500, payload: { error: 'write-failed' } }), '保存失败(500):write-failed')
  assert.equal(P.errText({}), '保存失败():请稍后重试')
  assert.equal(P.errText(null), '保存失败():请稍后重试')
})

test('mergeGraphPayload:保留未管字段、覆盖五块、钉 schemaRev:1、换 updatedAt、不改入参', () => {
  const original = {
    schemaRev: 1,
    weights: { wUnstale: 1, wSpecificity: 5, wEmotion: 0.5 },
    thresholds: { topic: 3 },
    windows: { candidateHours: 48, cooldownMin: 90 },
    relations: { defaultRelation: '相关' },
    display: { wMin: 1, wMax: 10 },
    updatedAt: '2026-10-05T00:00:00.000Z',
    notes: '别丢我'
  }
  const blocks = {
    weights: { wUnstale: 1.2 },
    thresholds: {},
    windows: { candidateHours: 72 },
    relations: { typeRules: ['是', '属于'] },
    display: { wMin: 2 }
  }
  const payload = P.mergeGraphPayload(original, blocks, '2026-10-05T12:00:00.000Z')
  assert.deepEqual(payload.weights, { wUnstale: 1.2 }, '五块整体覆盖(删掉的行 = 删掉的键)')
  assert.deepEqual(payload.thresholds, {})
  assert.deepEqual(payload.relations, { typeRules: ['是', '属于'] })
  assert.deepEqual(payload.display, { wMin: 2 })
  assert.equal(payload.schemaRev, 1, '写入钉版本')
  assert.equal(payload.updatedAt, '2026-10-05T12:00:00.000Z', '给了 now 就用它(纯函数可测)')
  assert.equal(payload.notes, '别丢我', '未管字段一个都不丢')
  // 入参一份都不改
  assert.deepEqual(original.weights, { wUnstale: 1, wSpecificity: 5, wEmotion: 0.5 })
  assert.deepEqual(original.display, { wMin: 1, wMax: 10 })
  assert.equal(original.updatedAt, '2026-10-05T00:00:00.000Z')
  // 没给 now / 原对象坏掉,也要给出合法形状
  const bare = P.mergeGraphPayload(null, null)
  assert.equal(bare.schemaRev, 1)
  assert.equal(typeof bare.updatedAt, 'string')
  for (const k of P.MANAGED) assert.deepEqual(bare[k], {}, k + ' 缺省是空对象')
})

test('collectBlock:新填的行没值就丢,盘上原有的键清空也保留', () => {
  const orig = new Set(['wUnstale'])
  const rows = [
    { key: 'wUnstale', value: '' },          // 原有键 → 清空也留
    { key: 'wNew', value: '' },              // 新键 + 空值 → 丢
    { key: 'wNew2', value: '0' },            // 新键 + 有值 → 0
    { key: 'wBool', value: false },          // 布尔 false 不算空
    { key: '   ', value: 'x' }               // 空键 → 丢
  ]
  assert.deepEqual(P.collectBlock(rows, orig), { wUnstale: '', wNew2: 0, wBool: false })
})

test('display 固定项:九个键与 graph.html 的现行值都在表里(防抄错行号)', () => {
  const keys = P.DISPLAY_FIELDS.map((f) => f.key)
  assert.deepEqual(keys, ['wMin', 'wMax', 'radiusBase', 'radiusScale', 'edgeWidthMin', 'edgeWidthMax',
    'flowSlowSec', 'flowFastSec', 'enterDelayMaxMs'])
  for (const f of P.DISPLAY_FIELDS) {
    assert.equal(typeof f.line, 'number', f.key + ' 要标 graph.html 行号')
    assert.notEqual(f.cur, undefined, f.key + ' 要给现行硬编码值')
  }
  assert.equal(P.DISPLAY_FIELDS.find((f) => f.key === 'wMax').cur, '10')
  assert.equal(P.DISPLAY_FIELDS.find((f) => f.key === 'enterDelayMaxMs').line, 412)
})

/* ── ③ DOM 桩 + 幂等 ─────────────────────────────────────── */

/**
 * 极简 DOM 桩:够跑 draw(`createElement` / `textContent` / `appendChild` /
 * `addEventListener` / `value` / `checked` / `style` / `setAttribute`)。
 * **诚实标注**:它不是浏览器 DOM —— 只验结构笔数与取值,不验布局与样式。
 */
function stubDoc () {
  const node = (tag) => {
    let text = ''
    const n = {
      tagName: tag, className: '', value: '', checked: false, type: '', placeholder: '',
      style: {}, children: [], attrs: {}, handlers: {},
      setAttribute (k, v) { n.attrs[k] = String(v) },
      getAttribute (k) { return n.attrs[k] },
      appendChild (c) { n.children.push(c); return c },
      removeChild (c) { const i = n.children.indexOf(c); if (i >= 0) n.children.splice(i, 1); return c },
      addEventListener (kind, fn) { (n.handlers[kind] = n.handlers[kind] || []).push(fn) },
      click () { for (const fn of (n.handlers.click || [])) fn() }
    }
    Object.defineProperty(n, 'textContent', {
      get () { return text },
      set (v) { text = String(v); n.children.length = 0 } // 真 DOM 里也是这么替换子节点的
    })
    return n
  }
  return { createElement: node }
}

/** 子树摊平(含自己)。 */
function flatten (node) {
  const out = []
  const go = (x) => { out.push(x); for (const c of x.children) go(c) }
  go(node)
  return out
}

/** 页面上所有值输入(`data-value` 那些),按出现顺序。 */
const valueInputs = (el) => flatten(el).filter((x) => x.tagName === 'input' && x.attrs['data-value'] === '1')

/** 页面上所有键输入(`data-key` 那些,display 的固定项没有)。 */
const keyInputs = (el) => flatten(el).filter((x) => x.tagName === 'input' && x.attrs['data-key'] === '1')

const findByText = (el, tag, text) => flatten(el).find((x) => x.tagName === tag && x.textContent === text)

/** 一套桩:一个 `<section>` + 记账用的 api。 */
function harness (value, putReply) {
  const doc = stubDoc()
  const el = doc.createElement('section')
  el.ownerDocument = doc
  const calls = []
  const api = {
    get (path) {
      calls.push(['get', path])
      return Promise.resolve({ file: 'graph.json', exists: value !== undefined, value: value === undefined ? {} : value, bytes: 40 })
    },
    put (path, body) {
      calls.push(['put', path, body])
      return putReply !== undefined && putReply.error !== undefined
        ? Promise.reject(putReply.error)
        : Promise.resolve({ ok: true, effective: 'next-engine-call' })
    },
    toast (text, kind) { calls.push(['toast', text, kind]) },
    reload () { calls.push(['reload']) }
  }
  return { doc, el, api, calls, findByText: (tag, text) => findByText(el, tag, text) }
}

const graphValue = () => ({
  schemaRev: 1,
  weights: { wUnstale: 1, wEmotion: 0.5 },
  thresholds: { topic: 3 },
  windows: { candidateHours: 48 },
  relations: { defaultRelation: '相关' },
  display: { wMin: 2, wMax: 10 },
  updatedAt: '2026-10-05T00:00:00.000Z',
  notes: '未管字段'
})

test('draw:空 graph.json 也能画(不报错);有值时按盘上的键铺行', async () => {
  // 空文件(⑧ 页体检实测 graph.json 就是空的):不报错,四块各留一行空白 + 提示
  const empty = harness({})
  V.draw(empty.el, empty.api)
  await tick()
  assert.ok(flatten(empty.el).length > 10, '空文件也要画出页面结构')
  assert.ok(flatten(empty.el).some((x) => x.textContent === '还没有值 —— 填一个就是第一个。'),
    '空表要给提示,不是报错')
  assert.equal(valueInputs(empty.el).filter((x) => x.attrs['data-value'] === '1').length >= 4, true,
    '四块键值编辑器的值框在(各留一行空白)')
  assert.equal(P.DISPLAY_FIELDS.every((f) => valueInputs(empty.el).length > 0), true)
  assert.equal(flatten(empty.el).some((x) => x.className === 'hint err' && x.textContent !== ''), false,
    '空文件不该有错误')

  // `exists:false`(文件还没建)与"读不出对象"两种形状都得优雅打住,不是报错
  const missing = harness(undefined) // harness 的 value === undefined ⇒ exists:false, value:{} 
  V.draw(missing.el, missing.api)
  await tick()
  assert.ok(flatten(missing.el).length > 10, 'exists:false 也要画出页面结构')
  const unreadable = harness({})
  unreadable.api.get = () => Promise.resolve({ file: 'graph.json', exists: true, value: null, unreadable: true, parseError: 'x' })
  V.draw(unreadable.el, unreadable.api)
  await tick()
  assert.equal(flatten(unreadable.el).some((x) => x.className === 'hint err' && x.textContent !== ''), false,
    '读不出对象 ⇒ 空表打底,不是报错')

  // 有值:键值行铺出来,display 固定项带上现行默认说明
  const h = harness(graphValue())
  V.draw(h.el, h.api)
  await tick()
  const keys = keyInputs(h.el).map((x) => x.value)
  assert.deepEqual(keys, ['wUnstale', 'wEmotion', 'topic', 'candidateHours', 'defaultRelation'],
    '键集不写死:盘上有什么键就铺什么行')
  const vals = valueInputs(h.el).map((x) => x.value)
  assert.equal(vals[0], '1', '数字值填进值框')
  assert.equal(vals[1], '0.5')
  assert.ok(vals.includes('2') && vals.includes('10'), 'display 盘上的值也填上')
  assert.ok(flatten(h.el).some((x) => typeof x.textContent === 'string'
    && x.textContent.indexOf('现行默认:10(来自 graph.html:391)') >= 0),
  '行尾要标现行硬编码值与行号')
  assert.ok(flatten(h.el).some((x) => String(x.textContent).indexOf('现行默认:320(来自 graph.html:412)') >= 0))
})

test('draw 幂等:画两遍不叠加;没有 api 也不炸', async () => {
  const h = harness(graphValue())
  V.draw(h.el, h.api)
  await tick()
  const nodes = flatten(h.el).length
  V.draw(h.el, h.api)
  await tick()
  assert.equal(flatten(h.el).length, nodes, '重画不许叠加(幂等)')
  assert.equal(keyInputs(h.el).length, 5, '重画后键行数照旧')

  const bare = stubDoc()
  const bareEl = bare.createElement('section')
  bareEl.ownerDocument = bare
  V.draw(bareEl, null) // 没注入 api:空对象打底,结构照样在
  assert.ok(flatten(bareEl).length > 3)
})

test('行编辑:「+ 加一项」增行、「删」减行(键值块)', async () => {
  const h = harness({ weights: { a: 1 } })
  V.draw(h.el, h.api)
  await tick()
  const base = keyInputs(h.el).length // 有值的块 1 行 + 空块各留 1 行空白
  assert.ok(base >= 1)
  h.findByText('button', '+ 加一项').click()
  assert.equal(keyInputs(h.el).length, base + 1, '加一项 ⇒ 多一行')
  h.findByText('button', '删').click()
  assert.equal(keyInputs(h.el).length, base, '删 ⇒ 少一行')
})

test('保存:一次 PUT 完整对象(未管字段不丢)→ toast 生效文案 → reload', async () => {
  const h = harness(graphValue())
  V.draw(h.el, h.api)
  await tick()
  // 改第一个值(weights.wUnstale),再给他一个新键
  valueInputs(h.el)[0].value = '9'
  keyInputs(h.el)[1].value = 'wSpecificity'
  valueInputs(h.el)[1].value = '5'
  h.findByText('button', '保存').click()
  await tick()
  const puts = h.calls.filter((c) => c[0] === 'put')
  assert.equal(puts.length, 1, '保存流只发一次 PUT')
  assert.equal(puts[0][1], '/api/echo/data/graph.json')
  const body = puts[0][2]
  assert.equal(body.schemaRev, 1)
  assert.equal(typeof body.updatedAt, 'string')
  assert.notEqual(body.updatedAt, '2026-10-05T00:00:00.000Z', 'updatedAt 换新')
  assert.equal(body.weights.wUnstale, 9, '数字值写成数字')
  assert.equal(body.weights.wSpecificity, 5)
  assert.deepEqual(body.thresholds, { topic: 3 }, '没动的块原样带回去')
  assert.deepEqual(body.display, { wMin: 2, wMax: 10 }, 'display 也原样')
  assert.equal(body.notes, '未管字段', '未管字段一个不丢')
  const toast = h.calls.find((c) => c[0] === 'toast')
  assert.deepEqual([toast[1], toast[2]], ['下次引擎调用生效', 'ok'], '生效文案是契约 §4 那一句')
  assert.ok(h.calls.some((c) => c[0] === 'reload'), '成功后要重画本页')
  assert.equal(flatten(h.el).some((x) => x.className === 'hint err' && x.textContent !== ''), false)
})

test('保存:display 留空的新项不写成空串(原始键缺席时不硬塞)', async () => {
  const h = harness({ weights: { a: 1 } }) // display 完全没有值
  V.draw(h.el, h.api)
  await tick()
  h.findByText('button', '保存').click()
  await tick()
  const body = h.calls.find((c) => c[0] === 'put')[2]
  assert.deepEqual(body.display, {}, '空着的 display 行不许变成九个空串')
  assert.deepEqual(body.weights, { a: 1 })
})

test('保存失败:err.payload.errors[] 内联进 .hint.err,且不弹窗、不 toast', async () => {
  const h = harness(graphValue(), { error: { status: 400, payload: { error: 'invalid', errors: ['weights.wUnstale:必须是数字'] } } })
  V.draw(h.el, h.api)
  await tick()
  h.findByText('button', '保存').click()
  await tick()
  const box = flatten(h.el).find((x) => x.className === 'hint err')
  assert.match(box.textContent, /weights\.wUnstale:必须是数字/, '错误要出现在页面上')
  assert.equal(box.style.display, '', '出错时错误槽要露出来')
  assert.equal(h.calls.some((c) => c[0] === 'toast'), false, '没存成就不许说"生效"')
  assert.equal(h.calls.some((c) => c[0] === 'reload'), false)
})
