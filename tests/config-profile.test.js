/**
 * 配置中心 ③ 用户画像页(`web/views/profile.js`,P2 / B2)的单测。
 *
 * 三条纪律钉住(照 tests/audit-view.test.js 的先例):
 *   ① **契约扫描**:classic script(无模块语法)、只走注入的 `api`、端点与生效文案字面量都在;
 *   ② **纯逻辑**:标签解析、载荷构造(**未管字段一个不丢**)、空值判定;
 *   ③ **桩 + 幂等**:DOM 桩只验"画了几笔、值对不对、画两遍不翻倍"——
 *      诚实标注:它**不是**浏览器 DOM,不验样式与真实布局。
 *
 * 加载方式:页面文件是 classic script,所以把源码喂给 `new Function('globalThis', src)`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../web/views/profile.js', import.meta.url)), 'utf8')
const sandbox = {}
new Function('globalThis', src)(sandbox) // eslint-disable-line no-new-func
const V = sandbox.EchoViews && sandbox.EchoViews['profile']
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
  assert.match(src, /\/api\/echo\/data\/profile\.json/, '必须出现唯一读写端点')
  assert.match(src, /已生效,刷新页面看界面/, '生效文案取自契约 §4,不许自创')
  assert.notEqual(V, undefined, 'EchoViews[\'profile\'] 得挂上')
  assert.equal(typeof V.draw, 'function', 'draw 必须是函数')
  assert.equal(typeof P.buildProfilePayload, 'function', '纯逻辑得挂出来')
})

/* ── ② 纯逻辑 ────────────────────────────────────────────── */

test('parseTags:逗号 / 换行 / 全角逗号 / 顿号都算分隔;去空白、丢空串、去重', () => {
  assert.deepEqual(P.parseTags('阿岚, 阿乙\n小E'), ['阿岚', '阿乙', '小E'])
  assert.deepEqual(P.parseTags('  a ,, b ,\n\n a , c '), ['a', 'b', 'c'], '空串丢掉,重复只留第一次')
  assert.deepEqual(P.parseTags('甲、乙;丙'), ['甲', '乙', '丙'])
  assert.deepEqual(P.parseTags(''), [])
  assert.deepEqual(P.parseTags(null), [])
  assert.deepEqual(P.formatTags([' a ', '', 'b']), 'a\nb', '数组 → 编辑框文本:一行一个')
})

test('isBlank:空串 / 全空白 / 空数组 = 空;0 算填过(与契约 §5 同口径)', () => {
  for (const v of ['', '   ', [], null, undefined, {}, false]) {
    assert.equal(P.isBlank(v), true, '应当算空:' + JSON.stringify(v))
  }
  for (const v of ['用户', ['阿岚'], 0, 7, true]) {
    assert.equal(P.isBlank(v), false, '应当算填过:' + JSON.stringify(v))
  }
})

test('buildProfilePayload:保留所有未管字段,只覆盖 ③ 页管的 7 个', () => {
  const original = {
    schemaRev: 1,
    userName: '阿岚',
    userAliases: ['旧名'],
    agentName: 'Echo',
    agentSelfRef: 'Echo',
    agentAliases: [],
    nicknamePatterns: ['^阿岚$'],
    nicknameStrict: true,
    locale: '',
    timezone: '',
    updatedAt: '2026-10-05T00:00:00.000Z',
    uiIndexPrefix: '对',
    fallbackAddress: '用户'
  }
  const payload = P.buildProfilePayload(original, {
    userName: ' 阿岚 ',
    agentName: 'Echo',
    agentSelfRef: 'Echo',
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    userAliases: ['阿岚', '阿乙', '阿岚'],
    agentAliases: ['小E']
  })
  assert.equal(payload.userName, '阿岚', '字符串 trim')
  assert.equal(payload.userAliases.join('|'), '阿岚|阿乙', '去重 + 保序')
  assert.deepEqual(payload.agentAliases, ['小E'])
  assert.equal(payload.locale, 'zh-CN')
  assert.equal(payload.timezone, 'Asia/Shanghai')
  // 未管字段:一个都不许丢(这是 PUT 完整对象的硬要求)
  assert.equal(payload.schemaRev, 1)
  assert.deepEqual(payload.nicknamePatterns, ['^阿岚$'])
  assert.equal(payload.nicknameStrict, true)
  assert.equal(payload.updatedAt, '2026-10-05T00:00:00.000Z')
  assert.equal(payload.uiIndexPrefix, '对', '④ 页的字段也得原样带回去')
  assert.equal(payload.fallbackAddress, '用户')
  assert.deepEqual(Object.keys(payload).sort(), [
    'agentAliases', 'agentName', 'agentSelfRef', 'fallbackAddress', 'locale', 'nicknamePatterns',
    'nicknameStrict', 'schemaRev', 'timezone', 'uiIndexPrefix', 'updatedAt', 'userAliases', 'userName'
  ].sort())
  assert.equal(original.userName, '阿岚', '纯函数:不许改调用方那份对象')
})

test('buildProfilePayload:原对象缺失 / 坏掉 ⇒ 用空模板打底(带记账的 schemaRev)', () => {
  const p = P.buildProfilePayload(null, { userName: '甲' })
  assert.equal(p.schemaRev, 1)
  assert.equal(p.userName, '甲')
  assert.deepEqual(p.userAliases, [])
  assert.deepEqual(p.agentAliases, [])
  assert.equal(p.nicknameStrict, null)
})

test('baseValue / formFromValue:坏文件、exists:false、缺字段一律降级(永不抛)', () => {
  const tmpl = P.baseValue({ file: 'profile.json', exists: false, value: null, bytes: 0 })
  assert.equal(tmpl.schemaRev, 1, 'exists:false ⇒ 空模板')
  const broken = P.baseValue({ value: null, unreadable: true, raw: '{oops', parseError: 'x' })
  assert.equal(broken.userName, '', '读不出对象 ⇒ 空模板')
  const good = P.baseValue({ value: { userName: '阿岚' } })
  assert.equal(good.userName, '阿岚', '好文件原样给(未管字段以后还要带回去)')
  assert.deepEqual(P.formFromValue({ userName: 123, userAliases: ['a', 7, ' a '] }), {
    userName: '', agentName: '', agentSelfRef: '', locale: '', timezone: '',
    userAliases: ['a'], agentAliases: []
  }, '脏值降级:非字符串丢,重复去')
})

/* ── ③ DOM 桩 + 幂等 ─────────────────────────────────────── */

/**
 * 极简 DOM 桩:够跑 draw(`createElement` / `textContent` / `appendChild` /
 * `addEventListener` / `value` / `style` / `setAttribute`)。
 * **诚实标注**:它不是浏览器 DOM —— 只验结构笔数与取值,不验布局与样式。
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

const profileValue = () => ({
  schemaRev: 1,
  userName: '阿岚',
  userAliases: ['阿乙'],
  agentName: 'Echo',
  agentSelfRef: 'Echo',
  agentAliases: ['小E'],
  nicknamePatterns: ['^阿岚$'],
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai'
})

/** 一套桩:一个 `<section>` + 记账用的 api。 */
function harness (putReply) {
  const doc = stubDoc()
  const el = doc.createElement('section')
  el.ownerDocument = doc
  const calls = []
  const api = {
    get (path) {
      calls.push(['get', path])
      return Promise.resolve({ file: 'profile.json', exists: true, value: profileValue(), bytes: 120 })
    },
    put (path, body) {
      calls.push(['put', path, body])
      return putReply !== undefined && putReply.error !== undefined
        ? Promise.reject(putReply.error)
        : Promise.resolve({ ok: true, effective: 'now' })
    },
    toast (text, kind) { calls.push(['toast', text, kind]) },
    reload () { calls.push(['reload']) }
  }
  const inputsOf = (key) => flatten(el).filter((x) => x.tagName === 'input' && x.attrs['data-field'] === key)
  const findByClass = (cls) => flatten(el).find((x) => x.className === cls)
  const findByText = (tag, text) => flatten(el).find((x) => x.tagName === tag && x.textContent === text)
  return { doc, el, api, calls, inputsOf, findByClass, findByText }
}

test('draw:填得出盘上的值;重复 draw 幂等(不叠加);无 api 也不炸', async () => {
  const h = harness()
  h.api.get = (path) => Promise.resolve({ file: 'profile.json', exists: true, value: profileValue(), bytes: 120 })
  V.draw(h.el, h.api)
  await tick()
  assert.equal(h.inputsOf('userName')[0].value, '阿岚')
  assert.equal(h.inputsOf('agentName')[0].value, 'Echo')
  assert.equal(h.inputsOf('timezone')[0].value, 'Asia/Shanghai')
  assert.equal(h.inputsOf('userAliases')[0].value, '阿乙', '标签列表按行铺开')
  assert.equal(h.inputsOf('agentAliases')[0].value, '小E')
  assert.ok(h.findByClass('hint err') !== undefined, '错误槽始终在位(平时空着)')
  const nodes = flatten(h.el).length
  V.draw(h.el, h.api)
  await tick()
  assert.equal(flatten(h.el).length, nodes, '重画不许叠加(幂等)')

  const bare = stubDoc()
  const bareEl = bare.createElement('section')
  bareEl.ownerDocument = bare
  V.draw(bareEl, null) // 没注入 api:空模板打底,结构照样在
  assert.ok(flatten(bareEl).length > 3)
})

test('draw:exists:false ⇒ 空表单;标签编辑器可增删行', async () => {
  const h = harness()
  h.api.get = () => Promise.resolve({ file: 'profile.json', exists: false, value: null, bytes: 0 })
  V.draw(h.el, h.api)
  await tick()
  assert.equal(h.inputsOf('userName')[0].value, '', '文件不存在 ⇒ 空模板,不是报错')
  assert.equal(h.inputsOf('userAliases').length, 1, '空表也留一行给他直接打字')
  h.findByText('button', '+ 添加一行').click()
  assert.equal(h.inputsOf('userAliases').length, 2, '添加一行')
  assert.equal(h.inputsOf('userAliases')[1].value, '')
  const dels = flatten(h.el).filter((x) => x.tagName === 'button' && x.textContent === '删')
  dels[0].click()
  assert.equal(h.inputsOf('userAliases').length, 1, '删掉一行')
})

test('保存:PUT 完整对象(未管字段不丢)→ toast 生效文案 → reload', async () => {
  const h = harness()
  V.draw(h.el, h.api)
  await tick()
  h.inputsOf('userName')[0].value = '阿岚'
  h.inputsOf('userAliases')[0].value = '阿岚,阿乙'
  h.findByText('button', '保存').click()
  await tick()
  const put = h.calls.find((c) => c[0] === 'put')
  assert.ok(put !== undefined, '保存必须走 PUT')
  assert.equal(put[1], '/api/echo/data/profile.json')
  assert.equal(put[2].userName, '阿岚')
  assert.equal(put[2].userAliases.join('|'), '阿岚|阿乙', '一次 PUT 带上全部标签')
  assert.deepEqual(put[2].nicknamePatterns, ['^阿岚$'], '未管字段原样带回')
  assert.equal(put[2].schemaRev, 1)
  const toast = h.calls.find((c) => c[0] === 'toast')
  assert.deepEqual([toast[1], toast[2]], ['已生效,刷新页面看界面', 'ok'], '生效文案是契约 §4 那一句')
  assert.ok(h.calls.some((c) => c[0] === 'reload'), '成功后要重画本页')
})

test('保存失败:err.payload.errors[] 内联进 .hint.err,且不弹窗、不 toast', async () => {
  const h = harness({ error: { status: 400, payload: { error: 'invalid', errors: ['userName:只能 32 字以内'] } } })
  V.draw(h.el, h.api)
  await tick()
  h.findByText('button', '保存').click()
  await tick()
  const box = h.findByClass('hint err')
  assert.match(box.textContent, /userName:只能 32 字以内/, '错误要出现在页面上')
  assert.equal(box.style.display, '', '出错时错误槽要露出来')
  assert.equal(h.calls.some((c) => c[0] === 'toast'), false, '没存成就不许说"已生效"')
  assert.equal(h.calls.some((c) => c[0] === 'reload'), false)
})
