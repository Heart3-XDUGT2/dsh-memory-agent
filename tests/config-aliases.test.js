/**
 * 配置中心 ⑤ 别名与人名页(`web/views/aliases.js`,P2 / B3)的单测。
 *
 * 三条纪律钉住(照 tests/config-profile.test.js 的先例):
 *   ① **契约扫描**:classic script(无模块语法)、只走注入的 `api`、端点与生效文案字面量都在、
 *      数据文件名**只许 `aliases.json` 一个**(候选改读真图谱端点 `GET /api/echo/graph`,不碰 `graph.json`);
 *   ② **纯逻辑**:`normalizeRules`(丢空行 / 去重 / tier 归位 / trim)、
 *      `mergeAliasesPayload`(保留未管字段 + 覆盖 rules + 不改入参)、
 *      `candidatesFromGraph`(排掉已进 rules 的名字 / 去重 / 脏数据不抛)、`errText`;
 *   ③ **桩 + 幂等**:DOM 桩只验"画了几笔、值对不对、画两遍不翻倍"——
 *      ⚠️ **诚实标注**:它不是浏览器 DOM,不验样式与真实布局,也不验 `<select>` 的交互细节。
 *
 * 加载方式:页面文件是 classic script,所以把源码喂给 `new Function('globalThis', src)`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../web/views/aliases.js', import.meta.url)), 'utf8')
const sandbox = {}
new Function('globalThis', src)(sandbox) // eslint-disable-line no-new-func
const V = sandbox.EchoViews && sandbox.EchoViews['aliases']
const P = V.pure

/** 等一轮 macro task:draw 的回包填充走微任务,等一拍最稳。 */
const tick = () => new Promise((resolve) => setImmediate(resolve))

/* ── ① 契约扫描 ─────────────────────────────────────────────── */

test('契约扫描:无 fetch / 无模块语法 / 无弹窗 / 不碰文件系统;端点、文案、挂载点都在', () => {
  assert.doesNotMatch(src, /fetch\s*\(/, '视图不许自己发请求(取数只走 api)')
  assert.doesNotMatch(src, /^\s*(import|export)\b/m, 'classic script:不许模块语法')
  assert.doesNotMatch(src, /alert\s*\(/, '校验失败必须内联显示,不许弹窗')
  assert.doesNotMatch(src, /node:fs|writeFileSync|resolveDataFilePath|require\s*\(/,
    '视图不许出现文件系统入口 / 裸写盘(唯一写路是 API)')
  assert.doesNotMatch(src, /\.dsh[\\/]/, '视图不许出现数据目录路径')
  assert.match(src, /\/api\/echo\/data\/aliases\.json/, '必须出现唯一读写端点')
  assert.match(src, /\/api\/echo\/graph\b/, '候选按钮要读的是真图谱端点,得在')
  assert.match(src, /下次引擎调用生效/, '生效文案取自契约 §4(aliases.json: next-engine-call),不许自创')
  // 数据文件名白名单(**只剩自己的 aliases.json**):别的数据文件一个都不许露头。
  // 候选改读真图谱端点 `GET /api/echo/graph` 之后,`graph.json` 也不该再出现(它是图论调参配置)。
  for (const other of ['names.json', 'persona.json', 'profile.json', 'config.json', 'state-defaults.json', 'lexicon.json', 'graph.json']) {
    assert.equal(src.includes(other), false, '视图不该碰别的数据文件:' + other)
  }
  assert.notEqual(V, undefined, 'EchoViews[\'aliases\'] 得挂上')
  assert.equal(typeof V.draw, 'function', 'draw 必须是函数')
  for (const k of ['rowFrom', 'normalizeRules', 'mergeAliasesPayload', 'candidatesFromGraph', 'errText']) {
    assert.equal(typeof P[k], 'function', '纯逻辑得挂出来:' + k)
  }
})

/* ── ② 纯逻辑 ────────────────────────────────────────────── */

test('normalizeRules:trim + 丢空行 + 去重(alias+canonical)+ tier 非法值归 1', () => {
  const input = [
    { alias: ' 西电 ', canonical: ' 西安电子科技大学 ', tier: 2, why: ' 常用简称 ' },
    { alias: '', canonical: '', tier: 1, why: '' },                    // 整行空 ⇒ 丢
    { alias: '西电', canonical: '西安电子科技大学', tier: 1 },           // 与第 1 行同 alias+canonical ⇒ 只留第一次
    { alias: '助手', canonical: 'Echo', tier: '2', why: 7 },            // 下拉给的是字符串;why 脏 ⇒ ''
    { alias: '小E', canonical: 'Echo', tier: 9 },                       // tier 非法 ⇒ 1
    { alias: ' 半行 ', canonical: '' }                                  // 半行留着,交给后端报错
  ]
  const out = P.normalizeRules(input)
  assert.deepEqual(out, [
    { alias: '西电', canonical: '西安电子科技大学', tier: 2, why: '常用简称' },
    { alias: '助手', canonical: 'Echo', tier: 2, why: '' },
    { alias: '小E', canonical: 'Echo', tier: 1, why: '' },
    { alias: '半行', canonical: '', tier: 1, why: '' }
  ])
  assert.equal(input[0].alias, ' 西电 ', '纯函数:不许改调用方那些行')
  assert.deepEqual(P.normalizeRules(null), [], '不是数组 ⇒ 空')
  assert.deepEqual(P.normalizeRules('x'), [], '不是数组 ⇒ 空')
  assert.deepEqual(P.normalizeRules([null, 3, []]), [], '脏行 ⇒ 丢掉')
})

test('tierOf / rowFrom:脏值一律降级,只留四个键', () => {
  assert.equal(P.tierOf(2), 2)
  assert.equal(P.tierOf('2'), 2)
  assert.equal(P.tierOf(1), 1)
  assert.equal(P.tierOf('1'), 1)
  for (const bad of [0, 3, 9, 'x', '', null, undefined, {}, []]) {
    assert.equal(P.tierOf(bad), 1, 'tier 非法值归 1:' + JSON.stringify(bad))
  }
  assert.deepEqual(P.rowFrom({ alias: ' a ', canonical: 'b', tier: 2, why: 'c', 多出来的: 1 }),
    { alias: 'a', canonical: 'b', tier: 2, why: 'c' }, '多余键不许带走')
  assert.deepEqual(P.rowFrom(null), { alias: '', canonical: '', tier: 1, why: '' })
})

test('mergeAliasesPayload:保留未管字段 + 覆盖 rules + 补 schemaRev/updatedAt + 不改入参', () => {
  const original = {
    schemaRev: 1,
    rules: [{ alias: '旧的', canonical: '旧正名', tier: 1, why: '' }],
    updatedAt: '2026-10-01T00:00:00.000Z',
    notes: '别丢我'
  }
  const payload = P.mergeAliasesPayload(
    original,
    [{ alias: ' 西电 ', canonical: '西安电子科技大学', tier: 1 }],
    '2026-10-05T00:00:00.000Z'
  )
  assert.equal(payload.schemaRev, 1)
  assert.equal(payload.updatedAt, '2026-10-05T00:00:00.000Z', 'updatedAt 换新的')
  assert.deepEqual(payload.rules, [{ alias: '西电', canonical: '西安电子科技大学', tier: 1, why: '' }])
  assert.equal(payload.notes, '别丢我', '未管字段一个都不许丢(PUT 收完整对象)')
  assert.deepEqual(Object.keys(payload).sort(), ['notes', 'rules', 'schemaRev', 'updatedAt'])
  assert.equal(original.rules[0].alias, '旧的', '纯函数:不许改调用方那份对象')
  assert.equal(original.updatedAt, '2026-10-01T00:00:00.000Z')

  const auto = P.mergeAliasesPayload(null, [])
  assert.equal(auto.schemaRev, 1)
  assert.deepEqual(auto.rules, [])
  assert.match(auto.updatedAt, /^\d{4}-\d{2}-\d{2}T/, '不给 nowIso ⇒ 自己补一个 ISO')
})

test('baseValue:exists:false / 坏文件 ⇒ 用**回包给的 template** 打底,不自己编模板', () => {
  const tpl = P.baseValue({
    file: 'aliases.json', exists: false, value: null, bytes: 0,
    template: { schemaRev: 1, rules: [{ alias: '模板里的', canonical: '模板正名', tier: 1, why: '' }], updatedAt: null }
  })
  assert.equal(tpl.rules[0].alias, '模板里的', '模板来自回包,不是这一页编的')
  const broken = P.baseValue({ value: null, unreadable: true, raw: '{oops', parseError: 'x', template: { schemaRev: 1, rules: [], updatedAt: null } })
  assert.deepEqual(broken.rules, [])
  const good = P.baseValue({ value: { schemaRev: 1, rules: [{ alias: 'a', canonical: 'b', tier: 1, why: '' }], 未管字段: 1 } })
  assert.equal(good.未管字段, 1, '读得出对象就原样给(未管字段以后还要带回去)')
  assert.deepEqual(P.baseValue(null), {}, '连 template 都没有 ⇒ 空对象兜底,不抛')
})

test('candidatesFromGraph:排掉已进 rules 的名字(alias / canonical)/ 去重 / 脏数据不抛', () => {
  const rules = [{ alias: '西电', canonical: '西安电子科技大学', tier: 1, why: '' }]
  // 真形状:`GET /api/echo/graph` 的回包 `{nodes:[{id,name,type,…}], edges, layers}`(lib/store.js graphData())
  assert.deepEqual(
    P.candidatesFromGraph({
      nodes: [
        { id: 'n-1', name: '校园跑', type: 'concept' },
        { id: 'n-2', name: '西电', type: 'concept' },
        { id: 'n-3', name: '西安电子科技大学', type: 'concept' },
        { id: 'n-4', name: '校园跑', type: 'concept' },
        { id: 'n-5', name: ' 章鱼小丸子 ', type: 'concept', activation: 0 }
      ],
      edges: [], layers: []
    }, rules),
    ['校园跑', '章鱼小丸子'],
    '当过 alias 或 canonical 的都不再当候选;去重 + trim'
  )
  // `name` 缺 ⇒ 退 `id`;字符串节点也认(不挑形状的刺)
  assert.deepEqual(P.candidatesFromGraph({ nodes: [{ id: 'n-7' }, { name: '音理' }, { name: ' 音理 ' }, '旧写法'] }, []),
    ['n-7', '音理', '旧写法'])
  for (const bad of [null, undefined, {}, { nodes: null }, { nodes: 'x' }, { value: 7 },
    { nodes: [null, 3, [], {}, { name: '' }, { id: '' }] }]) {
    assert.deepEqual(P.candidatesFromGraph(bad, rules), [], '脏数据 ⇒ 空数组,永不抛:' + JSON.stringify(bad))
  }
})

test('errText:优先 err.payload.errors[],否则给一句能看的兜底', () => {
  assert.equal(
    P.errText({ status: 400, payload: { error: 'invalid', errors: ['rules[0].alias:空', 'rules[0].tier:只能是 1 或 2'] } }),
    'rules[0].alias:空 / rules[0].tier:只能是 1 或 2'
  )
  assert.equal(P.errText({ status: 403, payload: { error: 'forbidden' } }), '保存失败(403):forbidden')
  assert.equal(P.errText({ status: 0, payload: { error: '数据通道还没接上,先别急着存' } }), '保存失败(0):数据通道还没接上,先别急着存')
  assert.equal(P.errText(null), '保存失败():请稍后重试')
})

/* ── ③ DOM 桩 + 幂等 ─────────────────────────────────────── */

/**
 * 极简 DOM 桩:够跑 draw(`createElement` / `textContent` / `appendChild` /
 * `addEventListener` / `value` / `style` / `setAttribute`)。
 * **诚实标注**:它不是浏览器 DOM —— 只验结构笔数与取值,不验布局、样式,也不验下拉的真实交互。
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

const TEMPLATE = { schemaRev: 1, rules: [], updatedAt: null }
const aliasesValue = () => ({
  schemaRev: 1,
  rules: [
    { alias: '西电', canonical: '西安电子科技大学', tier: 2, why: '' },
    { alias: '助手', canonical: 'Echo', tier: 1, why: '' }
  ],
  updatedAt: '2026-10-01T00:00:00.000Z',
  notes: '别丢我'
})

/** 一套桩:一个 `<section>` + 记账用的 api(get/put/toast/reload 全部留痕)。 */
function harness (opts) {
  const o = opts || {}
  const doc = stubDoc()
  const el = doc.createElement('section')
  el.ownerDocument = doc
  const calls = []
  const api = {
    get (path) {
      calls.push(['get', path])
      if (path === '/api/echo/graph') {
        if (o.graphError !== undefined) return Promise.reject(o.graphError)
        return Promise.resolve(o.graph !== undefined
          ? o.graph
          : {
              nodes: [
                { id: 'n-1', name: '校园跑', type: 'concept' },
                { id: 'n-2', name: '西电', type: 'concept' },
                { id: 'n-3', name: '章鱼小丸子', type: 'concept' }
              ],
              edges: [], layers: []
            })
      }
      if (o.getError !== undefined) return Promise.reject(o.getError)
      return Promise.resolve(o.aliases !== undefined
        ? o.aliases
        : { file: 'aliases.json', exists: true, value: aliasesValue(), bytes: 90, template: TEMPLATE })
    },
    put (path, body) {
      calls.push(['put', path, body])
      return (o.putError !== undefined)
        ? Promise.reject(o.putError)
        : Promise.resolve({ ok: true, effective: 'next-engine-call' })
    },
    toast (text, kind) { calls.push(['toast', text, kind]) },
    reload () { calls.push(['reload']) }
  }
  const all = () => flatten(el)
  const inputsOf = (key) => all().filter((x) => x.tagName === 'input' && x.attrs['data-field'] === key)
  const selectsOf = (key) => all().filter((x) => x.tagName === 'select' && x.attrs['data-field'] === key)
  const dels = () => all().filter((x) => x.tagName === 'button' && x.textContent === '删')
  const cands = () => all().filter((x) => x.attrs['data-candidate'] !== undefined)
  const findByClass = (cls) => all().find((x) => x.className === cls)
  const findByText = (tag, text) => all().find((x) => x.tagName === tag && x.textContent === text)
  return { doc, el, api, calls, all, inputsOf, selectsOf, dels, cands, findByClass, findByText }
}

test('draw:铺得出盘上的 rules;重复 draw 幂等(不叠加);没 api 也不炸', async () => {
  const h = harness()
  V.draw(h.el, h.api)
  await tick()
  assert.equal(h.inputsOf('alias').length, 2)
  assert.equal(h.inputsOf('alias')[0].value, '西电')
  assert.equal(h.inputsOf('canonical')[0].value, '西安电子科技大学')
  assert.equal(h.selectsOf('tier')[0].value, '2', '下拉停在该行的 tier 上')
  assert.equal(h.selectsOf('tier')[1].value, '1')
  assert.equal(h.inputsOf('why')[1].value, '')
  assert.ok(h.findByClass('hint err') !== undefined, '错误槽始终在位(平时空着)')
  assert.ok(h.findByText('button', '从图谱提候选') !== undefined)
  assert.ok(h.findByText('button', '+ 加一条') !== undefined)
  assert.ok(h.findByText('button', '保存') !== undefined)

  const nodes = h.all().length
  V.draw(h.el, h.api)
  await tick()
  assert.equal(h.all().length, nodes, '重画不许叠加(幂等)')

  const bare = stubDoc()
  const bareEl = bare.createElement('section')
  bareEl.ownerDocument = bare
  V.draw(bareEl, null)
  const bareAll = flatten(bareEl)
  assert.ok(bareAll.length > 3, '没注入 api:空模板打底,结构照样在')
  assert.equal(bareAll.filter((x) => x.tagName === 'input' && x.attrs['data-field'] === 'alias').length, 1,
    '空表也留一行给他直接打字')
})

test('draw:exists:false ⇒ 用回包的 template 打底;「+ 加一条」与「删」真的增删行', async () => {
  const h = harness({
    aliases: {
      file: 'aliases.json', exists: false, value: null, bytes: 0,
      template: { schemaRev: 1, rules: [{ alias: '模板里的', canonical: '模板正名', tier: 2, why: '' }], updatedAt: null }
    }
  })
  V.draw(h.el, h.api)
  await tick()
  assert.equal(h.inputsOf('alias').length, 1, '模板给了一行,就画一行')
  assert.equal(h.inputsOf('alias')[0].value, '模板里的', '打底用的是回包 template')
  assert.equal(h.selectsOf('tier')[0].value, '2')

  h.findByText('button', '+ 加一条').click()
  assert.equal(h.inputsOf('alias').length, 2, '「+ 加一条」加一行')
  assert.equal(h.inputsOf('alias')[1].value, '')
  h.dels()[0].click()
  assert.equal(h.inputsOf('alias').length, 1, '「删」删掉一行')
  h.dels()[0].click()
  assert.equal(h.inputsOf('alias').length, 0, '删到空也不炸')

  const blank = harness({ aliases: { file: 'aliases.json', exists: false, value: null, bytes: 0, template: TEMPLATE } })
  V.draw(blank.el, blank.api)
  await tick()
  assert.equal(blank.inputsOf('alias').length, 1, '空模板也留一行')
})

test('「从图谱提候选」:读真图谱端点的 nodes,排掉已进 rules 的,点一下加进编辑器(不自动保存)', async () => {
  const h = harness()
  V.draw(h.el, h.api)
  await tick()
  h.findByText('button', '从图谱提候选').click()
  await tick()
  assert.ok(h.calls.filter((c) => c[0] === 'get').map((c) => c[1]).includes('/api/echo/graph'),
    '按钮必须真去读图谱(而且读的是真图谱端点,不是 graph.json)')
  assert.deepEqual(h.cands().map((x) => x.textContent), ['校园跑', '章鱼小丸子'], '「西电」已进 rules,不当候选')

  h.cands().find((x) => x.attrs['data-candidate'] === '校园跑').click()
  await tick()
  assert.equal(h.inputsOf('alias').length, 3, '候选加了一行')
  assert.equal(h.inputsOf('canonical')[2].value, '校园跑', '候选名当正名')
  assert.equal(h.inputsOf('alias')[2].value, '', '别名留空等他补')
  assert.equal(h.inputsOf('why')[2].value, '图谱候选(来自 nodes)', 'why 记一句来源')
  assert.equal(h.calls.some((c) => c[0] === 'put'), false, '加候选**不**自动保存')
  assert.equal(h.calls.some((c) => c[0] === 'toast'), false, '没保存就不许说生效')
  assert.deepEqual(h.cands().map((x) => x.textContent), ['章鱼小丸子'], '加过的候选不再重复列')
})

test('图谱里没有 nodes ⇒ 如实说「没候选」(不装死、不弹窗、不 toast)', async () => {
  const h = harness({ graph: { nodes: [], edges: [], layers: [] } })
  V.draw(h.el, h.api)
  await tick()
  h.findByText('button', '从图谱提候选').click()
  await tick()
  assert.match(h.findByClass('hint cand').textContent, /没挑出候选/, '要说清为什么没候选')
  assert.equal(h.findByClass('hint err').textContent, '', '这不是保存失败,不该往错误槽里写')
  assert.deepEqual(h.cands(), [])
  assert.equal(h.calls.some((c) => c[0] === 'toast'), false)

  const h2 = harness({ graph: { edges: [] } }) // 回包连 nodes 都没有
  V.draw(h2.el, h2.api)
  await tick()
  h2.findByText('button', '从图谱提候选').click()
  await tick()
  assert.match(h2.findByClass('hint cand').textContent, /没挑出候选/)
})

test('图谱拉取失败 ⇒ 内联报错,按钮仍然可用(不是死按钮)', async () => {
  const h = harness({ graphError: { status: 500, payload: { error: 'graph-failed' } } })
  V.draw(h.el, h.api)
  await tick()
  h.findByText('button', '从图谱提候选').click()
  await tick()
  assert.match(h.findByClass('hint err').textContent, /graph-failed/)
  assert.deepEqual(h.cands(), [])
  assert.ok(h.findByText('button', '从图谱提候选') !== undefined, '按钮还在,可以再点')
  assert.ok(h.findByText('button', '保存') !== undefined, '别的功能不受影响')
})

test('保存:PUT 完整对象(空行丢掉 / rules 覆盖 / 未管字段不丢)→ toast 生效文案 → reload', async () => {
  const h = harness()
  V.draw(h.el, h.api)
  await tick()
  h.inputsOf('alias')[0].value = ' 西电 '
  h.inputsOf('canonical')[0].value = ' 西安电子科技大学 '
  h.selectsOf('tier')[0].value = '2'
  h.inputsOf('alias')[1].value = '小E'
  h.inputsOf('canonical')[1].value = 'Echo'
  h.inputsOf('why')[1].value = '常用'
  h.findByText('button', '+ 加一条').click() // 留一行空的 ⇒ 保存时应当被丢掉
  h.findByText('button', '保存').click()
  await tick()

  const puts = h.calls.filter((c) => c[0] === 'put')
  assert.equal(puts.length, 1, '保存只发一次 PUT')
  assert.equal(puts[0][1], '/api/echo/data/aliases.json')
  assert.deepEqual(puts[0][2].rules, [
    { alias: '西电', canonical: '西安电子科技大学', tier: 2, why: '' },
    { alias: '小E', canonical: 'Echo', tier: 1, why: '常用' }
  ], 'trim + tier 归位 + 空行丢掉')
  assert.equal(puts[0][2].schemaRev, 1)
  assert.equal(puts[0][2].notes, '别丢我', '未管字段原样带回')
  assert.match(puts[0][2].updatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.notEqual(puts[0][2].updatedAt, aliasesValue().updatedAt, 'updatedAt 换新')

  const toast = h.calls.find((c) => c[0] === 'toast')
  assert.deepEqual([toast[1], toast[2]], ['下次引擎调用生效', 'ok'], '生效文案是契约 §4 那一句')
  assert.equal(h.calls.filter((c) => c[0] === 'reload').length, 1, '成功后重画本页一次')
})

test('保存失败:err.payload.errors[] 内联进 .hint.err;不弹窗、不 toast、不 reload', async () => {
  const h = harness({
    putError: { status: 400, payload: { error: 'invalid', errors: ['rules[0].alias:空', 'rules[1].tier:只能是 1 或 2'] } }
  })
  V.draw(h.el, h.api)
  await tick()
  h.findByText('button', '保存').click()
  await tick()
  const box = h.findByClass('hint err')
  assert.match(box.textContent, /rules\[0\]\.alias:空/, '错误要出现在页面上')
  assert.match(box.textContent, /rules\[1\]\.tier:只能是 1 或 2/)
  assert.equal(box.style.display, '', '出错时错误槽要露出来')
  assert.equal(h.calls.some((c) => c[0] === 'toast'), false, '没存成就不许说"生效"')
  assert.equal(h.calls.some((c) => c[0] === 'reload'), false)
})

test('读盘失败:内联报错 + 编辑器照样能用(不白屏)', async () => {
  const h = harness({ getError: { status: 500, payload: { error: 'read-failed' } } })
  V.draw(h.el, h.api)
  await tick()
  assert.match(h.findByClass('hint err').textContent, /read-failed/)
  assert.equal(h.inputsOf('alias').length, 1, '读不出来也要留下一行')
  assert.ok(h.findByText('button', '保存') !== undefined)
})
