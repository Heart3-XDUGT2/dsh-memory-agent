/**
 * ② 人格页(web/views/persona.js)的单测 —— P2 配置中心 B2 批。
 *
 * 钉住三件事:
 *   ① **契约扫描**(§3.1):classic script、挂 `EchoViews['persona']`、有 `draw`、
 *      不出现直接发请求的写法、写路必须是 `/api/echo/data/persona.json`、
 *      生效文案必须是 §4 的「下一轮生效」;
 *   ② **纯逻辑行为**:字数(中文/空白)、预览拼接(空段写「(空,不注入)」)、
 *      提交对象(保留原字段 + edited:true + savedAt 是 ISO 串 + 前后缀正确);
 *   ③ **draw 幂等**:用最小 DOM 桩连画两次,元素数不翻倍,且保存流真的只走
 *      `api.put('/api/echo/data/persona.json', …)`。
 *
 * 加载方式照 tests/audit-view.test.js:页面文件是 classic script(无 import/export),
 * 把源码喂给 `new Function('globalThis', src)(sandbox)`,沙箱隔离,不起浏览器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../web/views/persona.js', import.meta.url)), 'utf8')
// 契约 §3 的写法是 `globalThis.EchoViews = … || {}` 之后用**裸名** `EchoViews['<id>'] = …`:
// 浏览器里那是个全局属性,裸名能直接解析;`new Function` 里没有这层全局,所以把同一份对象
// **同时**当参数传进去(它等价于浏览器的那个全局属性),两条语句写的是同一个对象。
const sandbox = {}
const views = {}
sandbox.EchoViews = views
new Function('globalThis', 'EchoViews', src)(sandbox, views) // eslint-disable-line no-new-func
const V = sandbox.EchoViews && sandbox.EchoViews['persona']
const P = V && V.pure

// ── 最小 DOM 桩(只为 draw 的幂等与保存流服务;不做布局/样式)──────────
function stubElement (doc, tag) {
  const el = {
    ownerDocument: doc,
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    attrs: {},
    style: {},
    className: '',
    textContent: '',
    hidden: false,
    disabled: false,
    value: '',
    listeners: {},
    appendChild (c) { el.children.push(c); return c },
    removeChild (c) {
      const i = el.children.indexOf(c)
      if (i >= 0) el.children.splice(i, 1)
      return c
    },
    addEventListener (type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn) },
    setAttribute (k, v) { el.attrs[k] = v },
    getAttribute (k) { return el.attrs[k] },
    fire (type) { (el.listeners[type] || []).forEach((fn) => fn({ preventDefault () {} })) }
  }
  Object.defineProperty(el, 'firstChild', { get () { return el.children.length > 0 ? el.children[0] : null } })
  return el
}

function stubDoc () {
  const doc = {}
  doc.createElement = (tag) => stubElement(doc, tag)
  return doc
}

function stubEl () {
  const doc = stubDoc()
  const el = stubElement(doc, 'section')
  el.id = 'persona'
  return el
}

/** 深度优先找第一个某标签的元素。 */
function find (node, tag) {
  const want = String(tag).toUpperCase()
  for (const c of node.children || []) {
    if (c.tagName === want) return c
    const deeper = find(c, want)
    if (deeper) return deeper
  }
  return null
}

function findAll (node, tag, out) {
  const want = String(tag).toUpperCase()
  const acc = out || []
  for (const c of node.children || []) {
    if (c.tagName === want) acc.push(c)
    findAll(c, tag, acc)
  }
  return acc
}

function countAll (node) {
  let n = 1
  for (const c of node.children || []) n += countAll(c)
  return n
}

async function flush () {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

/** 假 api:记录每一次调用;save 走通到 toast/reload。 */
function fakeApi (opts) {
  const o = opts || {}
  const calls = { get: [], put: [], toast: [], reload: 0 }
  const read = JSON.stringify(o.read || { prefix: '', suffix: '' })
  return {
    calls,
    get: async (path) => {
      calls.get.push(path)
      if (path === P.WRITE_PATH) return o.file === undefined ? { exists: false } : o.file
      return JSON.parse(read)
    },
    put: async (path, body) => {
      calls.put.push({ path, body })
      if (o.putError) throw o.putError
      return { ok: true, file: 'persona.json', effective: 'next-turn' }
    },
    toast: (text, kind) => calls.toast.push({ text, kind }),
    reload: () => { calls.reload += 1 }
  }
}

// ── ① 契约扫描 ────────────────────────────────────────────────────────
test('契约:classic script、挂上 EchoViews[persona]、draw 是函数', () => {
  assert.ok(V, 'EchoViews[persona] 必须被挂上')
  assert.equal(typeof V.draw, 'function')
  assert.ok(V.draw.length >= 1, 'draw 至少收 (el, api)')
  assert.ok(P, '视图对象上要挂 pure(零 DOM / 零 io 的纯逻辑)')
})

test('契约:无 import/export、无直接发请求的写法、必须有唯一写路与 §4 文案', () => {
  assert.ok(!/\bimport\b/.test(src), 'classic script 不许有 import')
  assert.ok(!/\bexport\b/.test(src), 'classic script 不许有 export')
  assert.ok(src.indexOf('fetch(') === -1, '视图里不许出现 fetch(')
  assert.ok(src.indexOf('/api/echo/data/persona.json') !== -1, '写路必须是 /api/echo/data/persona.json')
  assert.ok(src.indexOf('下一轮生效') !== -1, '§4:persona 的生效文案是「下一轮生效」')
  assert.ok(!/node:fs|resolveDataFilePath|\.dsh\/echo/.test(src), '视图里不许出现文件系统路径')
})

// ── ② 纯逻辑行为 ──────────────────────────────────────────────────────
test('纯逻辑:字数统计 —— 中文/空白各记一个,与数据层 maxLen 同口径', () => {
  assert.equal(P.countChars(''), 0)
  assert.equal(P.countChars(null), 0)
  assert.equal(P.countChars(undefined), 0)
  assert.equal(P.countChars('中文'), 2)
  assert.equal(P.countChars('中文 abc\n'), 7) // 中 文 空 a b c 换行
  assert.equal(P.countChars('  \t'), 3)
})

test('纯逻辑:计数行 / 上限兜底 / 超限禁用保存', () => {
  assert.equal(P.counterText(12, 4000), '12 / 4000')
  assert.equal(P.maxOf({ maxChars: 800 }), 800)
  assert.equal(P.maxOf({ maxChars: 0 }), P.MAX_FALLBACK)
  assert.equal(P.maxOf({}), P.MAX_FALLBACK)
  assert.equal(P.maxOf(null), P.MAX_FALLBACK)
  assert.equal(P.overLimit(4000, 4000), false)
  assert.equal(P.overLimit(4001, 4000), true)
  assert.equal(P.overLimit(4001, undefined), true) // 兜底也是 4000
  assert.equal(P.canSave({ prefix: 'a', suffix: 'b' }, 4000), true)
  assert.equal(P.canSave({ prefix: 'a'.repeat(4001), suffix: '' }, 4000), false)
  assert.equal(P.canSave({ prefix: '', suffix: 'b'.repeat(4001) }, 4000), false)
})

test('纯逻辑:预览拼接 —— 空段显式写「(空,不注入)」,前缀段在后缀段之前', () => {
  const empty = P.buildPreview('', '')
  assert.equal(empty.segments.length, 2)
  assert.equal(empty.segments[0].key, 'prefix')
  assert.equal(empty.segments[1].key, 'suffix')
  assert.equal(empty.segments[0].shown, '(空,不注入)')
  assert.equal(empty.segments[1].shown, '(空,不注入)')
  assert.equal(empty.emptyCount, 2)
  assert.ok(empty.text.indexOf('(空,不注入)') !== -1)

  const both = P.buildPreview('我是前缀', '我是后缀')
  assert.equal(both.emptyCount, 0)
  assert.equal(both.segments[0].shown, '我是前缀')
  assert.equal(both.segments[0].count, 4)
  assert.ok(both.text.indexOf('我是前缀') < both.text.indexOf('我是后缀'), '先前缀后后缀')

  const half = P.buildPreview('只有前缀', '')
  assert.equal(half.emptyCount, 1)
  assert.equal(half.segments[1].shown, '(空,不注入)')

  assert.equal(P.buildPreview('a { b', '').braces, true, '花括号要被标出来(注入时会转义)')
  assert.equal(P.buildPreview('a b', '').braces, false)
})

test('纯逻辑:提交对象 = 保留原字段 + 覆盖三处(§3.1)', () => {
  const now = '2026-10-05T07:31:00.000Z'
  const read = {
    file: 'persona.json', exists: true,
    value: { schemaRev: 1, prefix: '旧前缀', suffix: '旧后缀', edited: false, savedAt: null, defaultsRev: 3 }
  }
  const body = P.nextPersonaPayload(read, { prefix: '新前缀', suffix: '新后缀' }, now)
  assert.equal(body.schemaRev, 1, '原字段保留')
  assert.equal(body.defaultsRev, 3, '老键也要原样带回去(数据层保留不动)')
  assert.equal(body.prefix, '新前缀')
  assert.equal(body.suffix, '新后缀')
  assert.equal(body.edited, true)
  assert.equal(body.savedAt, now)
  assert.equal(new Date(body.savedAt).toISOString(), now, 'savedAt 是 ISO 串')
})

test('纯逻辑:文件不存在({exists:false})⇒ 空对象打底 + schemaRev:1', () => {
  const body = P.nextPersonaPayload({ file: 'persona.json', exists: false, value: null, bytes: 0 }, { prefix: 'a', suffix: '' })
  assert.equal(body.schemaRev, 1)
  assert.equal(body.prefix, 'a')
  assert.equal(body.suffix, '')
  assert.equal(body.edited, true)
  assert.equal(typeof body.savedAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(body.savedAt)))
})

test('纯逻辑:失败文案取 err.payload.errors[](内联显示,不用 alert)', () => {
  assert.deepEqual(P.errorsOf({ status: 400, payload: { errors: ['prefix:长 4001 字,超过上限 4000'] } }),
    ['prefix:长 4001 字,超过上限 4000'])
  assert.deepEqual(P.errorsOf({ payload: { error: 'forbidden' } }), ['forbidden'])
  assert.deepEqual(P.errorsOf({ message: 'HTTP 500' }), ['HTTP 500'])
  assert.equal(P.errorsOf(undefined).length, 1)
})

// ── ③ draw:幂等 + 取数 + 保存流 ──────────────────────────────────────
test('draw:连画两次不抛错、不重复叠加(元素数不翻倍)', async () => {
  const el = stubEl()
  const api = fakeApi({ read: { prefix: '前缀', suffix: '后缀', maxChars: 4000 } })
  V.draw(el, api)
  await flush()
  const first = countAll(el)
  assert.equal(el.children.length, 1, 'el 下只有自己建的那一层')
  V.draw(el, api)
  await flush()
  const second = countAll(el)
  assert.equal(el.children.length, 1, '重画仍只挂一层,不叠加')
  assert.equal(second, first, '元素总数不翻倍')
})

test('draw:载入后两个框有值、计数行是「N / maxChars」', async () => {
  const el = stubEl()
  const api = fakeApi({ read: { prefix: '一二三', suffix: '四', maxChars: 800 } })
  V.draw(el, api)
  await flush()
  const tas = findAll(el, 'textarea')
  assert.equal(tas.length, 2, '两个大 textarea')
  assert.equal(tas[0].value, '一二三')
  assert.equal(tas[1].value, '四')
  const counters = findAll(el, 'div').filter((d) => d.className.indexOf('persona-count') !== -1)
  assert.equal(counters.length, 2)
  assert.equal(counters[0].textContent, '3 / 800', '上限取自 GET /persona 的 maxChars')
  assert.equal(counters[1].textContent, '1 / 800')
})

test('draw:超限变红并禁用保存;恢复为空把两个框清空', async () => {
  const el = stubEl()
  const api = fakeApi({ read: { prefix: 'a'.repeat(4000), suffix: '', maxChars: 4000 } })
  V.draw(el, api)
  await flush()
  const tas = findAll(el, 'textarea')
  const save = findAll(el, 'button').find((b) => b.textContent === '保存')
  assert.ok(save)
  // 已到上限:允许(4000/4000 不算超)
  assert.equal(save.disabled, false)
  // 手动打一个字 ⇒ 超限
  tas[0].value = 'a'.repeat(4001)
  tas[0].fire('input')
  assert.equal(save.disabled, true, '超限禁用保存')
  const counters = findAll(el, 'div').filter((d) => d.className.indexOf('persona-count') !== -1)
  assert.ok(/over/.test(counters[0].className), '超限的计数行加 over 类(配合内联红色)')
  assert.equal(counters[0].style.color, '#fca5a5')

  const clearBtn = findAll(el, 'button').find((b) => b.textContent === '恢复为空')
  assert.ok(clearBtn)
  clearBtn.fire('click')
  assert.equal(tas[0].value, '', '恢复为空 ⇒ 前缀清空')
  assert.equal(tas[1].value, '', '恢复为空 ⇒ 后缀清空')
  assert.equal(save.disabled, false, '清空后不再超限')
})

test('draw:保存走 PUT /api/echo/data/persona.json + toast「下一轮生效」+ reload', async () => {
  const el = stubEl()
  const api = fakeApi({
    read: { prefix: '旧', suffix: '旧', maxChars: 4000 },
    file: { file: 'persona.json', exists: true, value: { schemaRev: 1, prefix: '旧', suffix: '旧', edited: false } }
  })
  V.draw(el, api)
  await flush()
  const tas = findAll(el, 'textarea')
  tas[0].value = '新前缀'
  tas[1].value = '新后缀'
  const save = findAll(el, 'button').find((b) => b.textContent === '保存')
  save.fire('click')
  await flush()

  assert.equal(api.calls.put.length, 1, '只有一次写')
  assert.equal(api.calls.put[0].path, '/api/echo/data/persona.json')
  assert.deepEqual(api.calls.get, ['/api/echo/persona', '/api/echo/data/persona.json'],
    '先读展示回包,再读原 value(§3.1 的提交对象要保留原字段)')
  const body = api.calls.put[0].body
  assert.equal(body.prefix, '新前缀')
  assert.equal(body.suffix, '新后缀')
  assert.equal(body.edited, true)
  assert.equal(body.schemaRev, 1, '原字段保留')
  assert.equal(typeof body.savedAt, 'string')
  assert.equal(new Date(body.savedAt).toISOString(), body.savedAt, 'savedAt 是 ISO 串')
  assert.deepEqual(api.calls.toast, [{ text: '下一轮生效', kind: 'ok' }], '§4 文案')
  assert.equal(api.calls.reload, 1, '成功流程:toast → reload')
})

test('draw:校验失败内联显示 err.payload.errors[](不 alert)', async () => {
  const el = stubEl()
  const api = fakeApi({
    read: { prefix: 'x', suffix: 'y', maxChars: 4000 },
    putError: { status: 400, payload: { error: 'invalid', errors: ['suffix:长 4001 字,超过上限 4000'] } }
  })
  V.draw(el, api)
  await flush()
  const save = findAll(el, 'button').find((b) => b.textContent === '保存')
  save.fire('click')
  await flush()
  const err = findAll(el, 'div').find((d) => d.className === 'hint err')
  assert.ok(err, '错误行必须带 class="hint err"')
  assert.equal(err.hidden, false)
  assert.ok(err.textContent.indexOf('suffix:长 4001 字,超过上限 4000') !== -1, 'errors[] 逐条内联')
})
