/**
 * 配置中心 ⑧ 数据体检页(`web/views/data-health.js`,P2 / B3-D)的单测。
 *
 * 三条纪律钉住(照 tests/config-profile.test.js 的先例):
 *   ① **契约扫描**:classic script(无模块语法)、只走注入的 `api`、四个端点与生效文案字面量都在;
 *   ② **纯逻辑**:四态归位、深链取 id、字节人话、重建判定、模板兜底;
 *   ③ **桩 + 幂等**:DOM 桩只验"画了几笔、点了发什么请求、画两遍不翻倍"——
 *      诚实标注:它**不是**浏览器 DOM,不验样式与真实布局。
 *
 * 加载方式:页面文件是 classic script,所以把源码喂给 `new Function('globalThis', src)`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../web/views/data-health.js', import.meta.url)), 'utf8')
const sandbox = {}
new Function('globalThis', src)(sandbox) // eslint-disable-line no-new-func
const V = sandbox.EchoViews && sandbox.EchoViews['data-health']
const P = V && V.pure

/** 等一轮 macro task:draw 的回包填充走微任务,等一拍最稳。 */
const tick = () => new Promise((resolve) => setImmediate(resolve))

/* ── ① 契约扫描 ─────────────────────────────────────────────── */

test('契约扫描:无 fetch / 无模块语法 / 无弹窗 / 不碰文件系统,四个端点与文案都在', () => {
  assert.doesNotMatch(src, /fetch\s*\(/, '视图不许自己发请求(取数只走 api)')
  assert.doesNotMatch(src, /^\s*(import|export)\b/m, 'classic script:不许模块语法')
  assert.doesNotMatch(src, /alert\s*\(/, '校验失败必须内联显示,不许弹窗')
  assert.doesNotMatch(src, /node:fs|writeFileSync|resolveDataFilePath|require\s*\(/,
    '视图不许出现文件系统路径 / 裸写盘(唯一写路是 API)')
  assert.match(src, /\/api\/echo\/setup/, '必须出现体检端点')
  assert.match(src, /\/api\/echo\/data\/backups/, '必须出现备份清单端点(只读)')
  assert.match(src, /\/api\/echo\/data\/backup/, '必须出现一键备份端点')
  assert.match(src, /\/api\/echo\/data\/<file>\.json/, '必须出现单文件读写路')
  assert.match(src, /已生效,刷新页面看界面/, '生效文案取自契约 §4,不许自创')
  assert.match(src, /本页不删任何东西/, '备份区必须写明"只列不删"')
  assert.notEqual(V, undefined, 'EchoViews[\'data-health\'] 得挂上')
  assert.equal(typeof V.draw, 'function', 'draw 必须是函数')
  for (const k of ['statusRow', 'statusLabel', 'deepLinkId', 'backupLabel', 'bytesText',
    'errText', 'templateOf', 'needsRebuild']) {
    assert.equal(typeof P[k], 'function', '纯逻辑得挂出来:' + k)
  }
})

/* ── ② 纯逻辑 ────────────────────────────────────────────── */

test('statusRow:missing / empty / broken / ok 四态的标签与徽标;broken 优先于 empty', () => {
  const missing = P.statusRow({ file: 'lexicon.json', exists: false })
  assert.equal(missing.state, 'missing')
  assert.equal(missing.badge, 'missing')
  assert.equal(missing.label, '文件不在')

  const blank = P.statusRow({ file: 'names.json', exists: true, empty: true })
  assert.equal(blank.state, 'empty')
  assert.equal(blank.badge, 'empty')
  assert.equal(blank.label, '还没填')

  const broken = P.statusRow({ file: 'graph.json', exists: true, empty: true, broken: true })
  assert.equal(broken.state, 'broken', '又是空的又读不出来 ⇒ 按 broken 算')
  assert.equal(broken.badge, 'broken')
  assert.equal(broken.label, '读不出来')

  const unreadable = P.statusRow({ file: 'graph.json', exists: true, unreadable: true })
  assert.equal(unreadable.state, 'broken', 'unreadable 也是读不出来')

  const ok = P.statusRow({ file: 'persona.json', exists: true, empty: false, broken: false })
  assert.equal(ok.state, 'ok')
  assert.equal(ok.badge, 'ok')
  assert.equal(ok.label, '正常')

  // 缺字段兜底 + 脏值不炸
  assert.equal(P.statusRow({ file: 'x.json' }).state, 'ok', 'exists 缺席按"在"算,不乱报失踪')
  assert.equal(P.statusRow(null).state, 'ok')
  assert.equal(P.statusRow('nope').state, 'ok')

  assert.equal(P.statusLabel('missing'), '文件不在')
  assert.equal(P.statusLabel('没这个态'), '未知', '不认识的状态不装懂')
  assert.equal(P.statusLabel(null), '未知')
})

test('needsRebuild:缺文件 / 读不出来才给重建;empty 不催', () => {
  assert.equal(P.needsRebuild({ exists: false }), true)
  assert.equal(P.needsRebuild({ exists: true, broken: true }), true)
  assert.equal(P.needsRebuild({ exists: true, unreadable: true }), true)
  assert.equal(P.needsRebuild({ exists: true, empty: true }), false, 'empty 只提示"还没填"')
  assert.equal(P.needsRebuild({ exists: true }), false)
  assert.equal(P.needsRebuild(null), false)
})

test('dataPathOf:file 已带 .json 就不叠第二遍(端点回的 file 带后缀)', () => {
  assert.equal(P.dataPathOf('persona.json'), '/api/echo/data/persona.json')
  assert.equal(P.dataPathOf('persona'), '/api/echo/data/persona.json', '不带后缀也能用')
  assert.match(P.dataPathOf('lexicon.json'), /\/api\/echo\/data\/lexicon\.json$/)
})

test('deepLinkId:从 #/<id> 里取出 id;脏值 ⇒ 空串', () => {
  assert.equal(P.deepLinkId('#/persona'), 'persona')
  assert.equal(P.deepLinkId('#/state-lexicon'), 'state-lexicon')
  assert.equal(P.deepLinkId('#/cfg'), 'cfg')
  assert.equal(P.deepLinkId('  #/aliases  '), 'aliases', '两头空白不算脏')
  for (const dirty of ['', 'persona', '#/', '#/a/b', '#persona', '#/persona?x=1', null, undefined, 7, {}]) {
    assert.equal(P.deepLinkId(dirty), '', '脏值必须回空串:' + JSON.stringify(dirty))
  }
})

test('bytesText:0 / 1 / <1024 / KB / MB;脏值不炸', () => {
  assert.equal(P.bytesText(0), '0 B')
  assert.equal(P.bytesText(1), '1 B')
  assert.equal(P.bytesText(512), '512 B')
  assert.equal(P.bytesText(1023), '1023 B')
  assert.equal(P.bytesText(1024), '1.0 KB')
  assert.equal(P.bytesText(2794), '2.7 KB')
  assert.equal(P.bytesText(1024 * 1024), '1.0 MB')
  assert.equal(P.bytesText(1024 * 1024 * 3 / 2), '1.5 MB')
  for (const dirty of [null, undefined, NaN, -5, 'abc']) {
    assert.equal(P.bytesText(dirty), '0 B', '脏值兜底成 0 B:' + JSON.stringify(dirty))
  }
  // 字节串进来也认(端点回的是数字,但别被字符串噎住)
  assert.equal(P.bytesText('2048'), '2.0 KB')
})

test('backupLabel / mtimeText:一行字带上名字、来源、大小、时间;认不出来不编', () => {
  assert.equal(P.mtimeText('2026-10-05T14:07:31.000Z'), '2026-10-05 14:07')
  assert.equal(P.mtimeText('不是时间'), '')
  assert.equal(P.mtimeText(null), '')

  const line = P.backupLabel({ name: 'persona.json.2026-10-05T14-07-31-000Z.bak', file: 'persona.json', bytes: 2794, mtime: '2026-10-05T14:07:31.000Z' })
  assert.match(line, /persona\.json\.2026/)
  assert.match(line, /persona\.json/)
  assert.match(line, /2\.7 KB/)
  assert.match(line, /2026-10-05 14:07/)
  assert.equal(P.backupLabel({ name: 'manual.bak', file: null, bytes: 0 }), 'manual.bak · 来源未知 · 0 B',
    '反查不出来的备份要说"来源未知",不是编一个文件名')
  assert.equal(P.backupLabel({}), '', '连名字都没有 ⇒ 不给行')
  assert.equal(P.backupLabel(null), '')
})

test('errText:校验失败取 err.payload.errors[];其余给状态码 + 原因', () => {
  assert.equal(P.errText({ status: 400, payload: { error: 'invalid', errors: ['names.json:speakers 必须是数组'] } }),
    'names.json:speakers 必须是数组')
  assert.equal(P.errText({ status: 400, payload: { errors: ['a', 'b'] } }), 'a / b')
  assert.equal(P.errText({ status: 403, payload: { error: '写保护未过' } }), '操作失败(403):写保护未过')
  assert.equal(P.errText({}), '出错了,稍后再试')
  assert.equal(P.errText(null), '出错了,稍后再试')
})

test('templateOf:回包里的 template 优先;缺席 / 脏值 ⇒ 最小打底(不瞎编字段)', () => {
  const t = P.templateOf({ file: 'names.json', exists: false, value: null, bytes: 0, template: { schemaRev: 1, speakers: [], personNames: [] } })
  assert.equal(t.schemaRev, 1)
  assert.deepEqual(t.speakers, [])
  assert.deepEqual(t.personNames, [])
  assert.deepEqual(P.templateOf({ template: null }), { schemaRev: 1 }, '没模板 ⇒ 最小打底')
  assert.deepEqual(P.templateOf({ template: ['x'] }), { schemaRev: 1 }, '数组不算模板')
  assert.deepEqual(P.templateOf(null), { schemaRev: 1 })
  const srcT = { schemaRev: 1, prefix: '' }
  const out = P.templateOf({ template: srcT })
  assert.notEqual(out, srcT, '要复制一份,别把回包对象直接塞进 PUT')
})

test('configuredLabel / summaryText:徽标与人话结论(empty 只算"还没填")', () => {
  assert.equal(P.configuredLabel(true), '已配置')
  assert.equal(P.configuredLabel(false), '还没配置')
  assert.equal(P.configuredLabel(undefined), '状态未知')

  const good = { files: [{ exists: true, empty: false }, { exists: true, empty: false }] }
  assert.match(P.summaryText(good), /全好/)

  const mixed = {
    files: [
      { exists: true, empty: false },
      { exists: false },
      { exists: true, broken: true, empty: true },
      { exists: true, empty: true }
    ]
  }
  const text = P.summaryText(mixed)
  assert.match(text, /2 个要修/, 'missing + broken = 要修')
  assert.match(text, /1 个还没填/, 'empty 单独算"还没填",不算要修')
  assert.equal(P.summaryText(null), '还没读到体检结果')
  assert.equal(P.summaryText({}), '还没读到体检结果')
})

/* ── ③ DOM 桩 + 幂等 ─────────────────────────────────────── */

/**
 * 极简 DOM 桩:够跑 draw(`createElement` / `textContent` / `appendChild` /
 * `addEventListener` / `value` / `style` / `setAttribute`)。
 * **诚实标注**:它不是浏览器 DOM —— 只验结构笔数与发出去的请求,不验布局与样式。
 */
function stubDoc () {
  const node = (tag) => {
    let text = ''
    const n = {
      tagName: tag, className: '', value: '', type: '', placeholder: '',
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

/** 一份体检回包:四态各来一个(都、好、空、坏)。 */
const setupReply = () => ({
  configured: true,
  dataDir: 'C:\\…\\.dsh\\echo',
  files: [
    { file: 'persona.json', exists: true, bytes: 2794, empty: false, broken: false, schemaRev: 1, valid: true, deepLink: '#/persona', hint: '人格' },
    { file: 'lexicon.json', exists: false, bytes: 0, empty: false, broken: false, schemaRev: null, valid: false, deepLink: '#/state-lexicon', hint: '词表' },
    { file: 'names.json', exists: true, bytes: 12, empty: true, broken: false, schemaRev: 1, valid: true, deepLink: '#/aliases', hint: '人名词表' },
    { file: 'graph.json', exists: true, bytes: 40, empty: false, broken: true, schemaRev: null, valid: false, deepLink: '#/tuning', hint: '图谱' }
  ],
  missing: ['lexicon.json'],
  empty: ['names.json'],
  broken: ['graph.json']
})

const backupsReply = () => ({
  ok: true,
  count: 2,
  files: [
    { name: 'persona.json.2026-10-05T14-07-31-000Z.bak', file: 'persona.json', bytes: 2794, mtime: '2026-10-05T14:07:31.000Z' },
    { name: 'manual.bak', file: null, bytes: 0, mtime: '2026-10-04T09:00:00.000Z' }
  ]
})

/** 一套桩:一个 `<section>` + 记账用的 api。 */
function harness (opts = {}) {
  const doc = stubDoc()
  const el = doc.createElement('section')
  el.ownerDocument = doc
  const calls = []
  const api = {
    get (path) {
      calls.push(['get', path])
      if (path === '/api/echo/setup') return Promise.resolve(opts.setup === undefined ? setupReply() : opts.setup)
      if (path === '/api/echo/data/backups') return Promise.resolve(opts.backups === undefined ? backupsReply() : opts.backups)
      return Promise.resolve(opts.data === undefined
        ? { file: 'lexicon.json', exists: false, value: null, bytes: 0, template: { schemaRev: 1, speakers: [] } }
        : opts.data)
    },
    put (path, body) {
      calls.push(['put', path, body])
      return opts.putError === undefined ? Promise.resolve({ ok: true }) : Promise.reject(opts.putError)
    },
    post (path, body) {
      calls.push(['post', path, body])
      return opts.postError === undefined
        ? Promise.resolve({ ok: true, path: 'x', bytes: 100, files: [{ file: 'persona.json', backedUp: true, path: 'y', bytes: 100 }] })
        : Promise.reject(opts.postError)
    },
    toast (text, kind) { calls.push(['toast', text, kind]) },
    reload () { calls.push(['reload']) }
  }
  const rows = () => flatten(el).filter((x) => x.tagName === 'tr' && x.attrs['data-file'] !== undefined)
  const textOf = () => flatten(el).map((x) => x.textContent).join('|')
  const findByText = (tag, text) => flatten(el).find((x) => x.tagName === tag && x.textContent === text)
  const buttons = () => flatten(el).filter((x) => x.tagName === 'button')
  const anchors = () => flatten(el).filter((x) => x.tagName === 'a')
  const callsOf = (kind) => calls.filter((c) => c[0] === kind)
  return { doc, el, api, calls, rows, textOf, findByText, buttons, anchors, callsOf }
}

test('draw:表画出四行、标记齐、深链是锚点;重复 draw 幂等(不叠加)', async () => {
  const h = harness()
  V.draw(h.el, h.api)
  await tick()

  const rows = h.rows()
  assert.equal(rows.length, 4, '一个文件一行(表头行不算)')
  assert.deepEqual(rows.map((r) => r.attrs['data-file']),
    ['persona.json', 'lexicon.json', 'names.json', 'graph.json'])
  assert.deepEqual(rows.map((r) => r.attrs['data-state']), ['ok', 'missing', 'empty', 'broken'])
  assert.match(h.textOf(), /文件不在/, 'missing 的人话标记在页面上')
  assert.match(h.textOf(), /读不出来/)
  assert.match(h.textOf(), /还没填/)
  assert.match(h.textOf(), /2\.7 KB/, '字节人话')
  assert.match(h.textOf(), /已配置/, 'configured 徽标')
  assert.match(h.textOf(), /2 个要修/, '结论:几个要修(missing + broken = 2)')
  assert.match(h.textOf(), /1 个还没填/, '结论:几个还没填')

  // 深链是 `<a href="#/<id>">`,不靠 JS 跳转
  assert.deepEqual(h.anchors().map((a) => a.attrs.href), ['#/persona', '#/state-lexicon', '#/aliases', '#/tuning'])

  // 缺 / 坏的行才有重建按钮(2 个);empty / ok 没有
  assert.equal(h.buttons().filter((b) => b.textContent === '重建').length, 2)
  assert.equal(h.findByText('span', '还没填,不急') !== undefined, true, 'empty 只提示,不催')

  // 备份清单:名字 / 来源 / 大小 / 时间都在
  assert.match(h.textOf(), /manual\.bak/)
  assert.match(h.textOf(), /来源未知/)
  assert.match(h.textOf(), /2026-10-05 14:07/)

  const nodes = flatten(h.el).length
  V.draw(h.el, h.api)
  await tick()
  assert.equal(h.rows().length, 4, '重画不许叠出 8 行')
  assert.equal(flatten(h.el).length, nodes, '重画不许叠加(幂等)')
})

test('draw:没注入 api / files 缺席也不炸,结构照样在', async () => {
  const bare = stubDoc()
  const bareEl = bare.createElement('section')
  bareEl.ownerDocument = bare
  V.draw(bareEl, null)
  assert.ok(flatten(bareEl).length > 5, '没有 api 也要有骨架')
  assert.match(flatten(bareEl).map((x) => x.textContent).join('|'), /数据通道还没接上/)

  const h = harness({ setup: { configured: false } })
  V.draw(h.el, h.api)
  await tick()
  assert.match(h.textOf(), /还没配置/)
  assert.match(h.textOf(), /体检结果没读到/, 'files 缺席要有兜底提示')
})

test('重建:两步确认 —— 第一下只亮说明不发请求,第二下才 GET template + PUT', async () => {
  const h = harness()
  V.draw(h.el, h.api)
  await tick()

  const btn = h.buttons().find((b) => b.textContent === '重建')
  assert.ok(btn !== undefined)
  btn.click()
  assert.equal(h.callsOf('put').length, 0, '第一下不许写盘')
  assert.equal(btn.textContent, '确认重建', '第一下只把按钮变成"确认重建"')
  assert.match(h.textOf(), /将写入空模板/, '第一下要亮出说明')

  btn.click()
  await tick()
  const put = h.callsOf('put')[0]
  assert.ok(put !== undefined, '第二下才发 PUT')
  assert.equal(put[1], '/api/echo/data/lexicon.json', '写的是那一个文件')
  assert.deepEqual(put[2], { schemaRev: 1, speakers: [] }, '载荷 = GET 回包里的 template')
  assert.ok(h.callsOf('get').some((c) => c[1] === '/api/echo/data/lexicon.json'), 'template 从单文件 GET 拿')
  const toast = h.callsOf('toast')[0]
  assert.deepEqual([toast[1], toast[2]], ['已生效,刷新页面看界面', 'ok'], '生效文案是契约 §4 那一句')
  assert.ok(h.callsOf('reload').length > 0, '成功后要重画本页')
})

test('重建失败:err.payload.errors[] 内联进 .hint.err,不 toast、不 reload', async () => {
  const h = harness({ putError: { status: 400, payload: { error: 'invalid', errors: ['lexicon.json:词表必须是对象'] } } })
  V.draw(h.el, h.api)
  await tick()
  const btn = h.buttons().find((b) => b.textContent === '重建')
  btn.click()
  btn.click()
  await tick()
  const box = flatten(h.el).find((x) => x.className === 'hint err')
  assert.match(box.textContent, /lexicon\.json:词表必须是对象/, '错误要出现在页面上')
  assert.equal(box.style.display, '', '出错时错误槽要露出来')
  assert.equal(h.callsOf('toast').length, 0, '没写成就别说"已生效"')
  assert.equal(h.callsOf('reload').length, 0)
})

test('看原文:坏文件才有;点开在页内折叠显示 raw(不发别的请求)', async () => {
  const h = harness({ data: { file: 'graph.json', exists: true, value: null, bytes: 40, unreadable: true, raw: '{ 坏掉的原文', template: { schemaRev: 1 } } })
  V.draw(h.el, h.api)
  await tick()
  const btn = h.buttons().find((b) => b.textContent === '看原文')
  assert.ok(btn !== undefined, '只有 broken 行给「看原文」')
  assert.equal(h.buttons().filter((b) => b.textContent === '看原文').length, 1)
  btn.click()
  await tick()
  assert.ok(h.callsOf('get').some((c) => c[1] === '/api/echo/data/graph.json?raw=1'), '走 ?raw=1 强制回原文')
  const fold = flatten(h.el).find((x) => x.className === 'hint raw-fold')
  assert.equal(fold.textContent, '{ 坏掉的原文', '原文在页内折叠显示,不弹窗')
  assert.equal(fold.style.display, '', '点开就露出来')
})

test('备份全部:一次 POST + toast + reload;备份清单没有删除按钮', async () => {
  const h = harness()
  V.draw(h.el, h.api)
  await tick()

  h.findByText('button', '一键备份全部').click()
  await tick()
  assert.equal(h.callsOf('post').length, 1, '一次点击只发一次 POST')
  assert.deepEqual(h.callsOf('post')[0].slice(0, 2), ['post', '/api/echo/data/backup'])
  assert.deepEqual(h.callsOf('post')[0][2], {}, '缺省 = 全部')
  assert.deepEqual([h.callsOf('toast')[0][1], h.callsOf('toast')[0][2]], ['已生效,刷新页面看界面', 'ok'])
  assert.ok(h.callsOf('reload').length > 0)

  // 只列不删:渲染出来的按钮里不许有"删"字
  assert.ok(h.buttons().length > 0, '页面上有按钮(否则这条断言没意义)')
  for (const b of h.buttons()) {
    assert.doesNotMatch(b.textContent, /删|remove|delete/i, '本页不删任何东西:' + b.textContent)
  }
  assert.match(h.textOf(), /本页不删任何东西/, '页内要有那句明白话')
})

test('备份失败:内联报错,不 toast', async () => {
  const h = harness({ postError: { status: 500, payload: { error: '备份失败,已中止' } } })
  V.draw(h.el, h.api)
  await tick()
  h.findByText('button', '一键备份全部').click()
  await tick()
  const box = flatten(h.el).find((x) => x.className === 'hint err')
  assert.match(box.textContent, /备份失败,已中止/)
  assert.equal(h.callsOf('toast').length, 0)
})
