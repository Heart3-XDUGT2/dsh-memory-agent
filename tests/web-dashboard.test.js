import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SETTINGS_FIELDS } from '../lib/settings-fields.js'
import { SETTINGS_DEFAULTS } from '../lib/toggle.js'

// 2026-09-26:调参从 DSH 设置区搬进了网页仪表盘(web/app.js),而且顺手抓到一个
// **只坑网页**的现场 bug:web/app.js 的 apiPost **没带 x-echo-edit** —— 宿主
// writeAllowed()(lib/index.js:117-120)要「回环 Origin + 这个头」,少一个就是 403,
// 也就是网页上所有写按钮(含「清空上下文」)点了都没反应。设置区那半区是带头的,
// 所以这个 bug 一直没露头。
//
// 这个电池用**DOM 替身 + 假 fetch** 把 web/app.js 真跑起来:渲染调参表单、改一个
// 嵌套字段、走一遍保存,然后检查那次 POST 到底带了什么头、什么 body。字段表用
// lib/settings-fields.js 的真货(不是测试里另抄一份),所以「端口搬丢字段」也会红。

const appPath = fileURLToPath(new URL('../web/app.js', import.meta.url))

/** 只够用的 DOM 替身:createElement / getElementById / firstChild / appendChild。
 *  ★ 2026-09-27:children 必须**忠实模拟 HTMLCollection** —— 真浏览器里它是
 *  类数组(有 length、可索引、可迭代,但 **Array.isArray() === false**)。
 *  上一版替身用真数组,于是 `Array.isArray(form.children)` 这种守卫在测试里
 *  恒真、在浏览器里恒假,把「调参折叠与检索全都不生效」放了过去。 */
function htmlCollection (arr) {
  const col = {
    length: arr.length,
    item: (i) => arr[i] || null,
    [Symbol.iterator]: () => arr[Symbol.iterator]()
  }
  for (let i = 0; i < arr.length; i += 1) col[i] = arr[i]
  // 故意**不**是数组:Array.isArray(col) === false,与浏览器一致
  return col
}

function fakeDom () {
  const nodes = new Map()
  const make = (tag) => {
    const node = {
      tag,
      className: '',
      textContent: '',
      value: '',
      checked: false,
      type: '',
      placeholder: '',
      style: {},
      _kids: [],
      parent: null,
      get children () { return htmlCollection(this._kids) },
      get firstChild () { return this._kids.length > 0 ? this._kids[0] : null },
      appendChild (c) { this._kids.push(c); c.parent = this; return c },
      removeChild (c) { const i = this._kids.indexOf(c); if (i >= 0) this._kids.splice(i, 1); return c },
      addEventListener () {},
      setAttribute () {},
      getAttribute () { return null }
    }
    return node
  }
  return {
    document: {
      createElement: make,
      getElementById: (id) => {
        if (!nodes.has(id)) nodes.set(id, make('div'))
        return nodes.get(id)
      }
    },
    nodes,
    make
  }
}

/** 把 web/app.js 装起来(它底部会自动 refreshAll/connectEvents —— 那些请求全走假 fetch)。 */
function loadDashboard ({ offline = false, settings, fields = SETTINGS_FIELDS, defaults = SETTINGS_DEFAULTS, health = null, hash = '', audit = null, mtPostFails = false, gtPostFails = false, archGetFails = false, archPostFails = false, archNoDebt = false } = {}) {
  const dom = fakeDom()
  const calls = []
  const current = offline ? null : (settings === undefined ? JSON.parse(JSON.stringify(defaults)) : settings)
  // 2026-10-01 阶段 2f:子代理记忆工具开关 —— 端点契约照 lib/index.js 的
  // `/api/echo/memory-tools` 仿造(GET 读数 / POST 严格布尔进、状态出)。
  let memoryToolsPanel = false
  // 阶段 4:自动挖影子边开关的状态(默认关;POST 严格布尔进)
  let graphGatePanel = false
  // ★ 2026-10-01 尾:来源标记(谁拨的 / 什么时候)。照 lib/index.js 的
  // graphGateState()/memoryToolsState() 的两个字段仿造(flip + flipLabel)。
  let graphGateFlip = { by: '', at: 0 }
  let memoryToolsFlip = { by: '', at: 0 }
  const flipLabelOf = (f) => ((f.by === '' && f.at === 0)
    ? '(没记来源 —— 这文件是在加标记之前写的)'
    : ((f.by === 'panel' ? '网页面板' : f.by === 'loader-config' ? '宿主配置同步' : f.by) + ' · 10-01 21:33'))
  const graphGateState = (extra = {}) => ({
    key: 'graphShadowEdges',
    envVar: 'ECHO_GRAPH_GATE',
    on: graphGatePanel,
    source: graphGatePanel ? 'settings:graphShadowEdges' : 'off',
    sourceLabel: graphGatePanel ? '插件设置(网页面板的开关)' : '关(三路都没开)',
    sources: { env: false, config: false, settings: graphGatePanel },
    engineOn: graphGatePanel,
    panelValue: graphGatePanel,
    flip: graphGateFlip,
    flipLabel: flipLabelOf(graphGateFlip),
    writesTo: 'graph_cooc_evidence(共现证据层:n 元,一行 = 一条证据;影子表 graph_shadow_edges 已冻结不再增长)',
    rollback: 'DELETE FROM graph_cooc_evidence(影子表那 48 条是审计;想一起清:DELETE FROM graph_shadow_edges)',
    immediate: true,
    ...extra
  })
  const memoryToolsState = (extra = {}) => ({
    key: 'memorySubagentTools',
    envVar: 'ECHO_MEMORY_SUBAGENT_TOOLS',
    on: memoryToolsPanel,
    source: memoryToolsPanel ? 'settings:memorySubagentTools' : 'off',
    sourceLabel: memoryToolsPanel ? '插件设置 config.json(网页面板开关)' : '关(三路都没开)',
    sources: { env: false, config: false, settings: memoryToolsPanel },
    applied: memoryToolsPanel,
    registered: memoryToolsPanel ? 4 : 0,
    toolNames: ['memory_search', 'memory_get', 'memory_neighbors', 'memory_timeline'],
    storeOnline: true,
    panelValue: memoryToolsPanel,
    flip: memoryToolsFlip,
    flipLabel: flipLabelOf(memoryToolsFlip),
    immediate: true,
    ...extra
  })
  // A7c:记忆架构 v2 的读数(**照 `python/engine/arch.py` 的 `status()` 形状仿造**)
  // —— 每一格都带"算法产物 vs 事实"的标注,回退入口带"会动几行 + 那句 SQL"。
  let archEvidenceRows = 13
  const archRollbackCalls = []
  const archStatus = () => ({
    db: 'C:/x/.dsh/echo/echo.db',
    status: {
      generated_at: 1790879702.9,
      nature: {
        topics: '算法产物(可重算)', evidence: '中间层(只读派生)',
        shadow: '3a 历史(已冻结)', receipts: '流水账(留痕)', graph: '事实(他说过的话里长出来的)',
        // 2026-10-02:他定的通例 —— 凭据债是"给人看的账",永不进她的上下文
        debt: '凭据账(只给人看,不进她的上下文)'
      },
      notes: [],
      topics: {
        present: true, active_batch: 'topic-1790879702', computed_at: 1790879702.9, summaries: 1,
        clusters: [
          { cluster_id: 1, label: '西安电子科技大学 · 计算机大类', summary: '他学校这摊:西电、计算机大类',
            size: 7, soft: [], batch_key: 'topic-1790879702', computed_at: 1790879702.9,
            algorithm: 'greedy-modularity/v1', nature: 'algorithm', stale_days: 0.1 },
          { cluster_id: 2, label: '做章鱼小丸子 · 章鱼小丸子', summary: '', size: 7, soft: ['音理'],
            batch_key: 'topic-1790879702', computed_at: 1790879702.9,
            algorithm: 'greedy-modularity/v1', nature: 'algorithm', stale_days: 0.1 }
        ]
      },
      evidence: { present: true, rows: archEvidenceRows, pairs: 43, nodes: 17,
        by_scope: { same_day: 5, same_memory: 8 } },
      shadow: { table: 'graph_shadow_edges', rows: 48, frozen: true },
      graph: { nodes: 31, edges: 45, active_edges: 29 },
      // 凭据债(**给人看的账**):形状照 `arch.status()["debt"]`(= evidence_debt.survey 的读数)
      debt: {
        present: true, nonfact_kind_rows: 0,
        active: { edges: 29, none: 9, inferred: 1, mixed: 9, real: 10 }, weak_total: 10,
        weak: [
          { edge_id: 9, relation: '要求', strength: 'none', evidence: '', layer: '', learned_at: 0 },
          { edge_id: 17, relation: '就读于', strength: 'none', evidence: '', layer: 'L0', learned_at: 0 }
        ]
      },
      receipts: { total: 81, recent: [{ id: 81, action: 'drop', route: '', note: '' }] },
      rollback: [
        { route: 'cooc-evidence', what: '共现证据层:最近一批证据行', table: 'graph_cooc_evidence',
          how: 'DELETE 最近一批;想回来再跑 python -m engine.cooc --apply', recomputable: true,
          available: archEvidenceRows > 0, rows: archEvidenceRows,
          detail: '最近一批的 ' + String(archEvidenceRows) + ' 条证据行',
          sql: "DELETE FROM graph_cooc_evidence WHERE owner_key = '__cooc__' AND created_at = 1790878279.65" },
        { route: 'topic-view', what: '主题簇视图:整批退役(行不删)', table: 'graph_topic_clusters',
          how: 'UPDATE is_active=0', recomputable: true, available: true, rows: 2,
          detail: '现行批次里 2 个簇会退役(行不删)',
          sql: 'UPDATE graph_topic_clusters SET is_active = 0 WHERE is_active = 1' },
        { route: 'shadow-table', what: '影子表(3a 历史,已冻结):**不提供回退**',
          table: 'graph_shadow_edges', how: '已冻结,没有「最近一批」可退', recomputable: false,
          available: false, rows: 0, why_not: "已冻结:没有'最近一批'可退" }
      ]
    }
  })
  const fetchStub = async (path, opts) => {
    calls.push({ path, opts: opts || {} })
    // 2026-10-01 A7c:记忆架构 v2 —— 端点契约照 `python/engine/arch.py` 的
    // `status()` 仿造(GET 聚合读数 / POST `{action:'rollback', route, confirm:true}`)。
    if (path === '/api/echo/graph-arch') {
      if (archGetFails && (opts === undefined || opts.method === undefined)) {
        return { ok: false, status: 503, json: async () => ({ error: 'engine-arch-unavailable', detail: 'boom' }) }
      }
      if (opts === undefined || opts.method === undefined) {
        // `archNoDebt`:老引擎(还没带 `debt` 那一块)的读数 —— 面板该安静地少一行,不许炸
        const got = archStatus()
        if (archNoDebt) delete got.status.debt
        return { ok: true, status: 200, json: async () => got }
      }
      if (archPostFails) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
      const sent = JSON.parse(opts.body || '{}')
      archRollbackCalls.push(sent)
      if (sent.route === 'cooc-evidence') archEvidenceRows = 0   // 退了就没了(下一次 GET 看得见)
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, rollback: { route: sent.route, rows: 13, applied: true, receipts: 1 } })
      }
    }
    // 2026-10-01 阶段 4:自动挖影子边开关 —— 契约照 lib/index.js 的
    // `/api/echo/graph-gate` 仿造(GET 读数 / POST 严格布尔进、状态出)。
    if (path === '/api/echo/graph-gate') {
      if (opts === undefined || opts.method === undefined) {
        return { ok: true, status: 200, json: async () => graphGateState() }
      }
      if (gtPostFails) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
      const sent = JSON.parse(opts.body || '{}')
      graphGatePanel = sent.enabled === true
      graphGateFlip = { by: 'panel', at: 1790861621 }
      return { ok: true, status: 200, json: async () => graphGateState() }
    }
    if (path === '/api/echo/memory-tools') {
      if (opts === undefined || opts.method === undefined) {
        return { ok: true, status: 200, json: async () => memoryToolsState() }
      }
      if (mtPostFails) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
      const sent = JSON.parse(opts.body || '{}')
      memoryToolsPanel = sent.enabled === true
      memoryToolsFlip = { by: 'panel', at: 1790861621 }
      return { ok: true, status: 200, json: async () => memoryToolsState({ reason: memoryToolsPanel ? 'on' : 'off' }) }
    }
    if (path === '/api/echo/health') {
      return {
        ok: true,
        status: 200,
        json: async () => (health === null
          ? { offline: true }
          : health)
      }
    }
    // ★ P1d(2026-10-05):称呼不再写死在 web/app.js 里,改由 `GET /api/echo/profile`
    // 发下来(app.js 进页面取**一次**就缓存)。桩按同一份口径回 —— 旧期望
    // (「阿岚:」/「Echo:」)的来源就在这。字段形状照 lib 侧的端点仿造:
    // `{ userName, userAliases, agentName, agentSelfRef, locale, timezone }`。
    // ⚠️ 别名里**必须带 `阿岚`**:stripEnvelope 那条「〈他的称呼〉说:」前缀
    // 正则(web/app.js 的 speakerReOf)是拿 userName + userAliases 拼的,少了它
    // 桥进来的「【QQ·私聊】阿岚说:…」就剥不干净。
    if (path === '/api/echo/profile') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          userName: '阿岚', userAliases: ['阿岚', '他'], agentName: 'Echo',
          agentSelfRef: 'Echo', locale: 'zh-CN', timezone: ''
        })
      }
    }
    if (String(path).startsWith('/api/echo/audit')) {
      return { ok: true, status: 200, json: async () => ({ rows: audit === null ? [] : audit }) }
    }
    if (path === '/api/echo/status') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: '9.9.9', enabled: true, dataDir: 'C:/x/.dsh/echo', engine: { mode: 'python', sidecar: { running: true, version: '1' } }, scope: { scope: 'all' }, memory: {} })
      }
    }
    if (path === '/api/echo/settings' && (opts === undefined || opts.method === undefined)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ settings: current, defaults, fields, relayTokenSet: true })
      }
    }
    if (path === '/api/echo/settings') {
      return { ok: true, status: 200, json: async () => ({ ok: true, settings: defaults }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  // 2026-09-29:页面脚本**按 index.html 的顺序**装 —— 顺序本身是契约
  // (`audit-view.js` 必须先于 app.js;反了 app.js 的 V() 会当场报错)。
  // 写死两份文件名就等于把这条契约放过了,所以从页面里读。
  const scripts = pageScripts()
  const box = { console } // 给 audit-view.js 当 globalThis(它只往上面挂一个对象)
  const src = scripts.map((s) => s.text).join('\n;\n')
  // P2 B2(2026-10-05):配置中心的视图挂在 `globalThis.EchoViews` 上(契约 §3)。
  // 浏览器里 `globalThis.X = …` 之后裸名 `X` 就能解析 —— 因为全局对象**就是**作用域;
  // `new Function` 里不行,所以这里把同一个对象**既当 globalThis 又当 EchoViews** 传进去,
  // 补上这层仿真(视图源码因此可以照契约写裸名,不用为测试改样子)。
  const api = new Function('document', 'fetch', 'setInterval', 'EventSource', 'console', 'location', 'history', 'window', 'globalThis', 'EchoViews',
    src + '\nreturn { renderSettings, renderMemory, saveSettings, apiPost,'
    + ' renderMemoryTools, drawMemoryTools, saveMemoryTools, mtStateOf: () => mtState,'
    + ' renderGraphGate, drawGraphGate, saveGraphGate, gtStateOf: () => gtState,'
    + ' renderArch, drawArch, stepRollbackArch, rollbackArchPanel, archStateOf: () => archState,'
    + ' archPendingOf: () => archPendingRoute,'
    + ' PANELS, showPanel, panelNow, panelFromHash, setFrozen, isFrozen, initShell,'
    + ' countSettingsFields, syncCfgSub,'
    + ' renderInjection, splitInjection, renderAudit, drawAudit, injText,'
    + ' saidLabel, toolLabel, replyLabel, stripEnvelope, buildTurns, turnKind,'
    + ' drawAuditStat, drawAuditChips, turnCard, machineLine, hl,'
    // ★ P1d:称呼是**异步**取回来的(进页面打一次,取到后推给 audit-view)——
    // 把 loadProfile 递出来,吃名字的用例就能 `await api.loadProfile()` 等它到货,
    // 而不是靠"多 await 几次大概就到了"碰运气(它返回的就是那条缓存的 promise,
    // 页面自己已经打过一次,这里只是等同一份)。
    + ' loadProfile,'
    + ' cfgFormOf: () => cfgForm, cfgDataOf: () => cfgData }'
  )(dom.document, fetchStub, () => 0, undefined, console,
    { hash }, { replaceState: () => {} }, { addEventListener: () => {} }, box, box)
  return { api, dom, calls, fetchStub, view: box.EchoAuditView, scripts, memoryToolsStateOf: () => memoryToolsPanel, graphGateStateOf: () => graphGatePanel, archRollbackCalls, archRowsOf: () => archEvidenceRows }
}

/** 页面脚本清单(按 `<script src="/echo/xxx.js">` 的出现顺序;只取 web/ 下的)。
 *  找不到脚本就是页面接线断了 —— 直接断言,不静默给空数组。 */
function pageScripts () {
  const html = readFileSync(htmlPath, 'utf8')
  const out = []
  for (const m of html.matchAll(/<script src="\/echo\/([^"]+)"><\/script>/g)) {
    out.push({ name: m[1], text: readFileSync(new URL('../web/' + m[1], import.meta.url), 'utf8') })
  }
  assert.ok(out.length >= 2 && out[out.length - 1].name === 'app.js',
    'index.html 的脚本接线不对:' + JSON.stringify(out.map((s) => s.name)))
  return out
}

/** 某个节点下的全部文字(用来断言"面板上真的说了这句话")。 */
function textOf (node) {
  let out = String(node.textContent || '')
  for (const c of node.children) out += ' ' + textOf(c)
  return out
}

/** 把 .children(HTMLCollection 替身)摊成真数组 —— 测试自己的检查用。
 *  刻意**不**给替身加 filter/map/indexOf:那些是数组方法,浏览器里的
 *  HTMLCollection 没有,加了就等于把 app.js 的同类误用也放过。 */
const kidsOf = (node) => [...node.children]

/** 把假 DOM 里某个节点下的所有 input 摊平(按渲染顺序)。 */
function inputsOf (node, out = []) {
  for (const c of node.children) {
    if (c.tag === 'input') out.push(c)
    inputsOf(c, out)
  }
  return out
}

/** ★ 2026-10-19：**输入控件**（input + textarea）摊平。
 *  群聊三句提示词是多行字段（`textarea`），而"字段数 = 字段表条数"那条契约
 *  数的是"控件"，不是"input 标签" —— 否则一加多行字段就误报少 3 个。 */
function controlsOf (node, out = []) {
  for (const c of node.children) {
    if (c.tag === 'input' || c.tag === 'textarea') out.push(c)
    controlsOf(c, out)
  }
  return out
}

/** 审计流里**真正的轮卡片**(class 含 `ar`)。2026-09-29 起列表里还有日期分隔行与
 *  统计行,`[0]` 不再等于第一张卡 —— 断言要按类名找,别按位置碰运气。 */
function detailOf (dom) {
  return kidsOf(dom.nodes.get('au-detail'))
}
function cardsOf (dom) {
  return kidsOf(dom.nodes.get('au-list')).filter((c) => /(^|\s)ar(\s|$)/.test(String(c.className || '')))
}

/** 字段在表单里的序号(渲染顺序 = 字段表顺序,扁平到嵌套键)。 */
function fieldIndex (key) {
  let n = 0
  for (const g of SETTINGS_FIELDS) {
    for (const f of g.fields) {
      const flat = g.nested === undefined ? f.key : g.nested + '.' + f.key
      if (flat === key) return n
      n++
    }
  }
  throw new Error('字段表里没有 ' + key)
}

/** 像人一样在某个字段上打字:拿到那个 input,改 value,触发 oninput。 */
function typeInto (dom, key, value) {
  const input = inputsOf(dom.nodes.get('cfg-form'))[fieldIndex(key)]
  assert.ok(input !== undefined, '没找到 ' + key + ' 的输入框')
  input.value = String(value)
  input.oninput()
  return input
}

/** 只被「保存」按钮用到的那次 POST。 */
const postCalls = (calls) => calls.filter((c) => c.path === '/api/echo/settings' && c.opts.method === 'POST')

test('✓ 调参表单渲染得出来:字段数 = 字段表里的条数(不是抄的,是真货)', async () => {
  const { api, dom } = loadDashboard()
  await api.renderSettings()
  const box = dom.nodes.get('cfg-form')
  const inputs = controlsOf(box)
  const expected = SETTINGS_FIELDS.reduce((n, g) => n + g.fields.length, 0)
  assert.equal(inputs.length, expected, '渲染出来的控件数(input+textarea) != 字段表条数')
  assert.ok(inputs.length > 30, '字段太少了,可疑')
  // 分组标题也在
  const titles = kidsOf(box).filter((c) => c.className === 'cfg-group').map((c) => c.textContent)
  assert.deepEqual(titles, SETTINGS_FIELDS.map((g) => g.title))
})

test('✓ 数字/开关/文本三种控件各就各位(布尔不该给数字框)', async () => {
  const { api, dom } = loadDashboard()
  await api.renderSettings()
  const inputs = inputsOf(dom.nodes.get('cfg-form'))
  const types = new Set(inputs.map((i) => i.type))
  assert.ok(types.has('number'), '没有数字框')
  assert.ok(types.has('checkbox'), '没有开关')
  assert.ok(types.has('text'), '没有文本框')
  assert.ok(types.has('password'), '传话桥令牌该是密码框')
  // 默认值里的布尔字段,渲染出来必须勾上(默认 true 的那几个)
  const checked = inputs.filter((i) => i.type === 'checkbox' && i.checked).length
  assert.ok(checked >= 4, '默认 true 的开关没勾上?勾上的只有 ' + String(checked) + ' 个')
})

test('✓ 在输入框里打字:嵌套字段是**整块合并**(想念其余八项不许被拍平)', async () => {
  const { api, dom } = loadDashboard()
  await api.renderSettings()
  typeInto(dom, 'longing.threshold', 9.5)
  const form = api.cfgFormOf()
  assert.equal(form.longing.threshold, 9.5)
  assert.equal(form.longing.half_life_hours, SETTINGS_DEFAULTS.longing.half_life_hours)
  assert.equal(form.longing.demo_rate, SETTINGS_DEFAULTS.longing.demo_rate)
  assert.equal(form.injectTopK, SETTINGS_DEFAULTS.injectTopK, '顶层字段不该被嵌套写坏')
})

test('✓ 开关是 checkbox,点一下真的翻面', async () => {
  const { api, dom } = loadDashboard()
  await api.renderSettings()
  const idx = fieldIndex('driftEnabled')
  const box = inputsOf(dom.nodes.get('cfg-form'))[idx]
  assert.equal(box.type, 'checkbox')
  assert.equal(box.checked, SETTINGS_DEFAULTS.driftEnabled)
  box.checked = !box.checked
  box.onchange()
  assert.equal(api.cfgFormOf().driftEnabled, !SETTINGS_DEFAULTS.driftEnabled)
})

test('✓ 保存那次 POST 带着 x-echo-edit(现场 bug:网页这边漏了它 ⇒ 全被 403)', async () => {
  const { api, dom, calls } = loadDashboard()
  await api.renderSettings()
  typeInto(dom, 'injectTopK', 9)
  const btn = kidsOf(dom.nodes.get('cfg-form'))
    .filter((c) => c.className === 'fw')[0].children[0]
  assert.equal(btn.textContent, '保存')
  await api.saveSettings(btn)
  const posts = postCalls(calls)
  assert.equal(posts.length, 1, '应该正好一次 POST')
  const headers = posts[0].opts.headers || {}
  assert.equal(headers['x-echo-edit'], '1', 'POST 少了 x-echo-edit ⇒ 宿主 writeAllowed 直接 403')
  assert.match(String(headers['content-type']), /application\/json/)
  const body = JSON.parse(posts[0].opts.body)
  assert.equal(body.settings.injectTopK, 9)
  assert.equal(body.settings.longing.threshold, SETTINGS_DEFAULTS.longing.threshold, '整块带着走,不许只剩改过的那一项')
})

test('✓ 记忆库离线时不炸:给一句人话,不去渲染表单', async () => {
  const { api, dom } = loadDashboard({ offline: true })
  await api.renderSettings()
  const box = dom.nodes.get('cfg-form')
  assert.equal(inputsOf(box).length, 0)
  assert.match(kidsOf(box).map((c) => c.textContent).join(' '), /离线/)
})

test('✓ 旧桥退役:拒签告警块整个撤了(health 里再带 relay 拒签字段也不许冒出来)', async () => {
  // 2026-09-26 那块告警是**旧桥专属**的可见性补丁(读 `h.relay` 的 401 拒签
  // 计数)。2026-09-28 旧桥完整退役:5 个 `/api/echo/relay/*` 端点与 401 计数
  // 一起没了,`/api/echo/health` 的 `relay` 字段跟着退役 ⇒ 面板不再有这块。
  // 这里故意喂一份**带拒签字段**的 health:一个字的告警都不许出来。
  const dirty = loadDashboard({
    health: {
      dmae: { total: 3, active: 3, dormant: 0, archived: 0, avgR: 0.9 },
      temporal: {}, temporalEdges: {}, threads: { open: 0 },
      relay: { count: 1296, lastAt: 1790000000, lastReason: 'token' }
    }
  })
  await dirty.api.renderMemory()
  const text = textOf(dirty.dom.nodes.get('mm-dmae'))
  assert.equal(/拒签/.test(text), false, '拒签告警该没了:' + text)
  assert.equal(/传话桥/.test(text), false, '传话桥不该再出现在体检卡上:' + text)

  // 干净输入照样安静,而且体检本身照常渲染(撤告警不许把体检弄坏)
  const clean = loadDashboard({
    health: { dmae: { total: 3, active: 3, dormant: 0, archived: 0, avgR: 0.9 }, temporal: {}, temporalEdges: {}, threads: { open: 0 } }
  })
  await clean.api.renderMemory()
  assert.ok(/3 条/.test(textOf(clean.dom.nodes.get('mm-dmae'))), '体检本身还得照常渲染')

  // 源码侧也钉住:那块补丁的文案、判据、以及已退役的 `h.relay` 都不在了
  const src = readFileSync(appPath, 'utf8')
  assert.equal(src.includes('传话桥被拒签'), false, '告警文案还在')
  assert.equal(/h\.relay/.test(src), false, '还在读已退役的 h.relay')
  assert.equal(/rj\.count/.test(src), false, '拒签计数判据还在')
})

test('✓ 页面不把调参塞进 10 秒轮询(正打字时被重画 = 自伤)', () => {
  const src = readFileSync(appPath, 'utf8')
  const all = src.slice(src.indexOf('async function refreshAll'))
  const body = all.slice(0, all.indexOf('}'))
  assert.equal(body.includes('renderSettings'), false, 'refreshAll 里不该有 renderSettings')
  assert.ok(src.includes('renderSettings().catch'), '进页面时该拉一次')
})

// ─────────────────────────────────────────────────────────────
// 2026-10-01 阶段 2f:子代理记忆工具开关搬进网页仪表盘。
// 他的裁定:「`memorySubagentTools` 的 true/false **应当也能在网页仪表盘里改**才对。」
// 这条卡住在 #cfg-mt(**不在** #cfg-form 里 —— 那一格的输入框数被上面那条
// "字段数 = 字段表条数"钉着,而它刻意不是调参项)。
// ─────────────────────────────────────────────────────────────
const mtCheckbox = (dom) => {
  const box = inputsOf(dom.nodes.get('cfg-mt'))[0]
  assert.ok(box !== undefined, '子代理记忆工具开关没渲染出控件')
  return box
}
const mtPostCalls = (calls) => calls.filter((c) => c.path === '/api/echo/memory-tools' && c.opts.method === 'POST')

test('✓ 开关卡渲染出「现状 + 来源 + 三路读数 + 立即生效」,且不污染调参那一段', async () => {
  const { api, dom } = loadDashboard()
  await api.renderSettings()
  const text = textOf(dom.nodes.get('cfg-mt'))
  assert.match(text, /给子代理开只读记忆工具/, '开关的标签没了')
  assert.match(text, /现在:关/, '该显示现状(默认关)')
  assert.match(text, /来源:/, '该显示来源')
  assert.match(text, /三路读数/, '该说清"为什么现在是开/关"')
  assert.match(text, /立即生效/, '该写明拨了立即生效')
  // 它不在 cfg-form 里:那一格仍是"恰好字段表条数"个输入框(上面那条测试的契约)
  const inForm = controlsOf(dom.nodes.get('cfg-form')).length
  const expected = SETTINGS_FIELDS.reduce((n, g) => n + g.fields.length, 0)
  assert.equal(inForm, expected, '开关混进了 #cfg-form —— 会把"字段数 = 字段表条数"的契约挤掉')
  assert.equal(mtCheckbox(dom).checked, false, '默认必须是关')
})

test('✓ 拨一下就是一次专用 POST:带头、严格布尔、而且不碰调参(关→开→关)', async () => {
  const { api, dom, calls, memoryToolsStateOf } = loadDashboard()
  await api.renderSettings()
  const settingsPostsBefore = postCalls(calls).length

  // 关 → 开
  await api.saveMemoryTools(true, mtCheckbox(dom))
  assert.equal(memoryToolsStateOf(), true)
  assert.match(textOf(dom.nodes.get('cfg-mt')), /现在:开/, '开了之后状态栏该说"开"')
  assert.match(textOf(dom.nodes.get('cfg-mt')), /已注册 4/, '该显示真挂上了几个工具')
  assert.match(String(dom.nodes.get('cfg-mt-msg').textContent), /已生效/, '该明说立即生效')

  // 再改回关
  await api.saveMemoryTools(false, mtCheckbox(dom))
  assert.equal(memoryToolsStateOf(), false)
  assert.match(textOf(dom.nodes.get('cfg-mt')), /现在:关/, '关回来')

  const posts = mtPostCalls(calls)
  assert.equal(posts.length, 2, '两次拨动 = 两次 POST')
  for (const p of posts) {
    assert.equal(p.opts.headers['x-echo-edit'], '1', '少了 x-echo-edit ⇒ 宿主 writeAllowed 直接 403')
    assert.match(String(p.opts.headers['content-type']), /application\/json/)
    const body = JSON.parse(p.opts.body)
    assert.deepEqual(Object.keys(body), ['enabled'], 'body 只许带 enabled(不许顺手带上别的设置)')
    assert.equal(typeof body.enabled, 'boolean', '必须是严格布尔')
  }
  assert.deepEqual(posts.map((p) => JSON.parse(p.opts.body).enabled), [true, false])
  // 「不改其它设置」:拨这个开关一次都没打调参那条端点
  assert.equal(postCalls(calls).length, settingsPostsBefore, '拨开关时打了 /api/echo/settings')
  assert.equal(JSON.stringify(api.cfgFormOf()).includes('memorySubagentTools'), false,
    '面板把开关写进了调参表单 —— 那是另一条路(它不在字段表里)')
})

test('✓ 写失败不静默:提示报错并把勾回弹(不许留个骗人的勾)', async () => {
  const { api, dom, memoryToolsStateOf } = loadDashboard({ mtPostFails: true })
  await api.renderSettings()
  const box = mtCheckbox(dom)
  assert.equal(box.checked, false)
  box.checked = true
  await api.saveMemoryTools(true, box)
  assert.match(String(dom.nodes.get('cfg-mt-msg').textContent), /保存失败/, '失败必须看得见')
  assert.equal(box.checked, false, '失败后勾要回弹,不许显示成"已开"')
  assert.equal(memoryToolsStateOf(), false, '失败时后端状态没变')
  // 而且不许静默:失败后状态栏照旧说"关"
  assert.match(textOf(dom.nodes.get('cfg-mt')), /现在:关/)
})

// ─────────────────────────────────────────────────────────────
// 2026-10-01 A7c:记忆架构 v2 卡(主题簇 / 证据层 / 影子表 / 失效史 + 一键回退)。
// 住在 #cfg-arch(**不在** #cfg-form 里,理由同上两张卡);口径全在引擎侧
// (`GET /api/echo/graph-arch`),面板只显示。
// ─────────────────────────────────────────────────────────────
const archButtons = (dom) => kidsOf(dom.nodes.get('cfg-arch')).filter((k) => k.tag === 'button')
const archPostCalls = (calls) => calls.filter((c) => c.path === '/api/echo/graph-arch' && c.opts.method === 'POST')

test('✓ 架构卡:四格读数 + "算法产物 vs 事实"的区分 + 不污染调参那一段', async () => {
  const { api, dom } = loadDashboard()
  await api.renderSettings()
  const text = textOf(dom.nodes.get('cfg-arch'))
  assert.match(text, /记忆架构 v2/, '这一格的标题没了')
  assert.match(text, /算法产物/, '主题簇必须标明是算法产物(可重算)')
  assert.match(text, /事实/, '必须把"事实"那一层也标出来')
  assert.match(text, /中间层/, '证据层该标明是中间层(只读派生)')
  assert.match(text, /已冻结/, '影子表该标明已冻结')
  assert.match(text, /西安电子科技大学 · 计算机大类/, '现行簇没显示出来')
  assert.match(text, /他学校这摊/, '摘要没显示出来')
  assert.match(text, /摘要还没写/, '没摘要的那一簇该如实说(摘要是离线任务 A5b 的产物)')
  assert.match(text, /失效史/, '失效史那一格没了')
  assert.match(text, /13 行 \/ 43 对/, '证据层读数不对')
  assert.match(text, /回退入口/, '回退入口那一格没了')
  // 不混进 #cfg-form(那一格的输入框数被"字段数 = 字段表条数"钉着)
  const expected = SETTINGS_FIELDS.reduce((n, g) => n + g.fields.length, 0)
  assert.equal(controlsOf(dom.nodes.get('cfg-form')).length, expected,
    '架构卡混进了 #cfg-form —— 会把"字段数 = 字段表条数"的契约挤掉')
})

test('✓ 架构卡:凭据债那一行(给人看的账,不当成给模型看的东西)', async () => {
  const { api, dom } = loadDashboard()
  await api.renderSettings()
  const text = textOf(dom.nodes.get('cfg-arch'))
  assert.match(text, /凭据债/, '凭据债那一行没了')
  assert.match(text, /只给人看/, '必须标明它是给人看的(他的通例:不进她的上下文)')
  assert.match(text, /活跃 29 条里 无依据 9 \/ 仅推定 1 \/ 有依据 19/,
    '债的三个数(无依据 / 仅推定 / 有依据)得一眼看得出')
  assert.match(text, /#9 要求/, '没依据的那几条该点名')
  assert.match(text, /前 2 \/ 共 10/, '该说清"前几条 / 共几条"')
  assert.match(text, /evidence_debt/, '该告诉他真要还债时去哪张报表看全部')
  // 没有债(null / 缺字段)时不许炸,也不许编一行出来
  const { api: api2, dom: dom2 } = loadDashboard({ archNoDebt: true })
  await api2.renderSettings()
  assert.doesNotMatch(textOf(dom2.nodes.get('cfg-arch')), /凭据债/, '引擎没给债就不该有一行')
})

test('✓ 架构卡:回退是**两步**(第一下只亮 SQL,第二下才发 POST)', async () => {
  const { api, dom, calls, archRollbackCalls } = loadDashboard()
  await api.renderSettings()
  const btn = archButtons(dom).find((b) => String(b.textContent).includes('cooc-evidence'))
  assert.ok(btn !== undefined, '没渲染出 cooc-evidence 的回退按钮')

  btn.onclick()   // 第一步:只亮牌
  await Promise.resolve()
  assert.equal(archPostCalls(calls).length, 0, '第一下就把写请求发了 —— 写动作不许手滑')
  assert.match(textOf(dom.nodes.get('cfg-arch')), /DELETE FROM graph_cooc_evidence/,
    '第一步必须亮出它会执行的那句 SQL')
  assert.match(textOf(dom.nodes.get('cfg-arch')), /再点一次确认/, '第二步的按钮该改口')
  assert.match(String(dom.nodes.get('cfg-arch-msg').textContent), /再点一次/, '该提示还要再点一下')

  const btn2 = archButtons(dom).find((b) => String(b.textContent).includes('再点一次确认'))
  btn2.onclick()  // 第二步:真退
  for (let i = 0; i < 4; i++) await Promise.resolve()
  const posts = archPostCalls(calls)
  assert.equal(posts.length, 1, '两次点击 = 一次 POST')
  const body = JSON.parse(posts[0].opts.body)
  assert.deepEqual(Object.keys(body).sort(), ['action', 'confirm', 'route'], 'body 只许带这三个键')
  assert.equal(body.action, 'rollback')
  assert.equal(body.route, 'cooc-evidence')
  assert.equal(body.confirm, true, '必须显式 confirm:true(与路由的判定口径一致)')
  assert.equal(posts[0].opts.headers['x-echo-edit'], '1', '少了 x-echo-edit ⇒ 宿主 writeAllowed 直接 403')
  assert.deepEqual(archRollbackCalls.map((c) => c.route), ['cooc-evidence'])
  assert.match(String(dom.nodes.get('cfg-arch-msg').textContent), /已回退 cooc-evidence/, '该说清退了什么')
  assert.match(String(dom.nodes.get('cfg-arch-msg').textContent), /回执 \+1/, '该说清留痕了几条')
})

test('✓ 架构卡:影子表**没有**回退按钮(已冻结,不是"可退 0 行")', async () => {
  const { api, dom, calls } = loadDashboard()
  await api.renderSettings()
  const text = textOf(dom.nodes.get('cfg-arch'))
  assert.match(text, /shadow-table/, '影子表那一行该在(要说明它没有回退动作)')
  assert.match(text, /现在没有可退的/, '该如实说"没有可退的"')
  assert.equal(archButtons(dom).filter((b) => String(b.textContent).includes('shadow-table')).length, 0,
    '影子表不该有回退按钮')
  assert.equal(archPostCalls(calls).length, 0)
})

test('✓ 架构卡:读数拉取失败要说出来(不装成空状态)', async () => {
  const { api, dom } = loadDashboard({ archGetFails: true })
  await api.renderSettings()
  assert.match(textOf(dom.nodes.get('cfg-arch')), /读数拉取失败/, '拉不到读数必须说清')
})

test('✓ 架构卡:回退被拒/写失败都不静默', async () => {
  const { api, dom } = loadDashboard({ archPostFails: true })
  await api.renderSettings()
  const btn = archButtons(dom).find((b) => String(b.textContent).includes('cooc-evidence'))
  btn.onclick(); await Promise.resolve()
  const btn2 = archButtons(dom).find((b) => String(b.textContent).includes('再点一次确认'))
  btn2.onclick()
  for (let i = 0; i < 4; i++) await Promise.resolve()
  assert.match(String(dom.nodes.get('cfg-arch-msg').textContent), /回退没成/, '失败必须看得见')
})


// ─────────────────────────────────────────────────────────────
// 2026-10-01 阶段 4:自动挖影子边开关也搬进网页仪表盘(同一条裁定换到另一个开关)。
// 住在 #cfg-gt(**不在** #cfg-form 里,理由同隔壁那张卡)。
// ─────────────────────────────────────────────────────────────
const gtCheckbox = (dom) => {
  const box = inputsOf(dom.nodes.get('cfg-gt'))[0]
  assert.ok(box !== undefined, '自动挖影子边开关没渲染出控件')
  return box
}
const gtPostCalls = (calls) => calls.filter((c) => c.path === '/api/echo/graph-gate' && c.opts.method === 'POST')

test('✓ 挖边开关卡:现状 + 来源 + 三路读数 + 立即生效 + **风险提示**,且不污染调参那一段', async () => {
  const { api, dom } = loadDashboard()
  await api.renderSettings()
  const text = textOf(dom.nodes.get('cfg-gt'))
  assert.match(text, /每写一条新记忆就自动挖影子边/, '开关的标签没了')
  assert.match(text, /现在:关/, '该显示现状(默认关)')
  assert.match(text, /来源:/, '该显示来源')
  assert.match(text, /三路读数/, '该说清"为什么现在是开/关"(三路)')
  assert.match(text, /立即生效/, '该写明拨了立即生效')
  // 显眼的风险提示(他的要求:必须写清"打开后会往哪张表写、怎么退")
  assert.match(text, /graph_shadow_edges/, '风险提示里必须点名那张表')
  assert.match(text, /不可见/, '风险提示里必须说清"对现有读口仍不可见"')
  assert.match(text, /DELETE FROM graph_shadow_edges/, '风险提示里必须给一行回退')
  // ★ 2026-10-01 尾:必须显示「谁在什么时候拨的」。老配置(没这对字段)如实说"没记来源"。
  assert.match(text, /开关留痕/, '没显示开关的来源标记(谁在什么时候拨的)')
  assert.match(text, /没记来源/, '起点该说"没记来源",不许猜')
  // 不混进 #cfg-form(那一格的输入框数被上面那条"字段数 = 字段表条数"钉着)
  const inForm = controlsOf(dom.nodes.get('cfg-form')).length
  const expected = SETTINGS_FIELDS.reduce((n, g) => n + g.fields.length, 0)
  assert.equal(inForm, expected, '挖边开关混进了 #cfg-form —— 会把"字段数 = 字段表条数"的契约挤掉')
  assert.equal(gtCheckbox(dom).checked, false, '默认必须是关')
})

test('✓ 挖边开关:拨一下 = 一次专用 POST(带头、严格布尔),关→开→关,不碰调参', async () => {
  const { api, dom, calls, graphGateStateOf } = loadDashboard()
  await api.renderSettings()
  const settingsPostsBefore = postCalls(calls).length

  await api.saveGraphGate(true, gtCheckbox(dom))
  assert.equal(graphGateStateOf(), true)
  assert.match(textOf(dom.nodes.get('cfg-gt')), /现在:开/, '开了之后状态栏该说"开"')
  // ★ 拨完必须留下并显示「谁在什么时候拨的」——这是本次事故的正面要求
  assert.match(textOf(dom.nodes.get('cfg-gt')), /开关留痕:网页面板/, '拨完没显示是哪只手拨的')
  assert.match(String(dom.nodes.get('cfg-gt-msg').textContent), /已落盘:开/, '该说明已落盘')
  assert.match(String(dom.nodes.get('cfg-gt-msg').textContent), /下一帧/, '该说清"下一帧就认"')

  await api.saveGraphGate(false, gtCheckbox(dom))
  assert.equal(graphGateStateOf(), false)
  assert.match(textOf(dom.nodes.get('cfg-gt')), /现在:关/, '关回来')

  const posts = gtPostCalls(calls)
  assert.equal(posts.length, 2, '两次拨动 = 两次 POST')
  for (const p of posts) {
    assert.equal(p.opts.headers['x-echo-edit'], '1', '少了 x-echo-edit ⇒ 宿主 writeAllowed 直接 403')
    const body = JSON.parse(p.opts.body)
    assert.deepEqual(Object.keys(body), ['enabled'], 'body 只许带 enabled')
    assert.equal(typeof body.enabled, 'boolean', '必须是严格布尔')
  }
  assert.deepEqual(posts.map((p) => JSON.parse(p.opts.body).enabled), [true, false])
  assert.equal(postCalls(calls).length, settingsPostsBefore, '拨挖边开关时打了 /api/echo/settings')
  assert.equal(JSON.stringify(api.cfgFormOf()).includes('graphShadowEdges'), false,
    '面板把挖边开关写进了调参表单 —— 那是另一条路(它不在字段表里)')
})

test('✓ 挖边开关:写失败不静默(提示报错 + 勾回弹)', async () => {
  const { api, dom, graphGateStateOf } = loadDashboard({ gtPostFails: true })
  await api.renderSettings()
  const box = gtCheckbox(dom)
  assert.equal(box.checked, false)
  box.checked = true
  await api.saveGraphGate(true, box)
  assert.match(String(dom.nodes.get('cfg-gt-msg').textContent), /保存失败/, '失败必须看得见')
  assert.equal(box.checked, false, '失败后勾要回弹')
  assert.equal(graphGateStateOf(), false, '失败时后端状态没变')
})

// ─────────────────────────────────────────────────────────────
// 审查台 2.0(2026-09-26):他被这版惹到的是「丑 + 不方便」——
// 11 段平铺在一条窄栏里、导航是 11 个 emoji 链接、读长文被 10s 轮询重画。
// 下面这几条钉住新的壳:一张表管导航、一次只显示一段、能冻结、能搜。
// ─────────────────────────────────────────────────────────────
test('✓ 每段面板都能被导航到,而且 index.html 里真的有这一段(表 ↔ 壳同源)', () => {
  const src = readFileSync(appPath, 'utf8')
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8')
  const { api } = loadDashboard()
  assert.equal(api.PANELS.length, 20, '面板数变了就更新这条断言,别让它悄悄漂(P2 配置中心:3 + 4 页;G5:情绪空间 1 页)')
  const ids = api.PANELS.map((p) => p.id)
  for (const p of api.PANELS) {
    assert.ok(html.includes('id="' + p.id + '"'), 'index.html 缺 section #' + p.id)
    assert.ok(html.includes('id="' + p.nav + '"'), 'index.html 缺导航 #' + p.nav)
    assert.equal(typeof p.draw, 'function', p.id + ' 没有画法')
    assert.ok(p.title && p.sub, p.id + ' 缺标题/副标题(顶部工具条要显示)')
  }
  assert.equal(new Set(ids).size, ids.length, '面板 id 重复')
  // 导航链接的 href 也要指向真的面板(#/xx)
  for (const p of api.PANELS) {
    assert.ok(html.includes('href="#/' + p.id + '"'), '导航 href 没指向 #/' + p.id)
  }
  assert.ok(src.includes('nav-au-n') && html.includes('id="nav-au-n"'), '左栏计数徽标丢了')
})

/**
 * G9(2026-10-05):「调参」副标题里的项数**现算**。
 *
 * 这个数字在文档与代码里同时撒过谎(`web/app.js` 写 51、`HANDOVER.md` 写 71,
 * 而 `lib/settings-fields.js` 实际 109)⇒ 现在改成一个规矩:**只许现算,不许写死**;
 * 拿不到字段表就**不显示数字**(宁可不说,不说错)。
 */
test('G9:调参副标题的项数现算 —— 与字段表实际项数一致,拿不到就不显示', () => {
  const { api } = loadDashboard()
  const real = SETTINGS_FIELDS.reduce((n, g) => n + g.fields.length, 0)
  assert.equal(api.countSettingsFields(SETTINGS_FIELDS), real)
  // 2026-10-06:111 → 121(情绪空间那两组共十项:用户侧坐标打分 5 + 人格基线 5)。
  // 2026-10-11:124 → 125(检索融合 recallFusion,Step 3)。
  // 2026-10-18:125 → 126(忙时入站队列上限 inboundQueueLimit)。
  // 2026-10-19:126 → 129(群聊三句提示词 shortReply/masterHint/guestWarning)。
  // 2026-10-21:129 → 130(直调拆池的后台池并发 llmMaxConcurrentBulk)。
  // 2026-10-21:130 → 131(小任务思考档 llmSmallTaskEffort)。
  assert.equal(real, 131, '项数变了就更新这条断言(README 那条也一起)')
  // 种子副标题里不许出现写死的项数(它只在 /api/echo/settings 回来之后才有数字)
  const seed = api.PANELS.find((p) => p.id === 'cfg').sub
  assert.ok(!/\d+\s*项字段/.test(seed), '种子副标题里写死了项数:' + seed)
  // 现算之后:数字 = 真值
  api.syncCfgSub(api.countSettingsFields(SETTINGS_FIELDS))
  assert.ok(api.PANELS.find((p) => p.id === 'cfg').sub.startsWith(real + ' 项字段'),
    '现算之后副标题要以真值开头:' + api.PANELS.find((p) => p.id === 'cfg').sub)
  // 拿不到(离线 / 端点坏 / 空表)⇒ 不带数字,不许猜
  for (const bad of [null, undefined, [], 'x']) assert.equal(api.countSettingsFields(bad), null, '坏输入不许当 0')
  api.syncCfgSub(null)
  const noNum = api.PANELS.find((p) => p.id === 'cfg').sub
  assert.ok(!/\d+\s*项字段/.test(noNum), '拿不到字段表时不许显示数字:' + noNum)
  assert.ok(noNum.includes('改完下一轮对话生效'), '拿不到字段表也要说人话,不是空串')
})

// ─────────────────────────────────────────────────────────────
// 配置中心(P2 §6.2 / 契约 §3):三处 id 一致 + 视图文件真的接上了
// ─────────────────────────────────────────────────────────────
test('✓ 配置中心七页:page id / section id / nav id / 视图挂载四处一致;脚本顺序在 app.js 之前', () => {
  const src = readFileSync(appPath, 'utf8')
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8')
  const { api } = loadDashboard()
  const cfgIds = ['persona', 'profile', 'naming', 'aliases', 'tuning', 'state-lexicon', 'data-health']

  // ① 三页都得在 PANELS 里(否则导航到不了)
  for (const id of cfgIds) {
    const p = api.PANELS.find((x) => x.id === id)
    assert.ok(p !== undefined, 'PANELS 缺配置页 ' + id)
    assert.equal(p.group, '配置', id + ' 该归在「配置」这一组')
    // ② draw 必须走 drawView('<id>')(视图文件的唯一入口)
    assert.ok(new RegExp("drawView\\('" + id + "'\\)").test(String(p.draw)), id + ' 的 draw 没走 drawView()')
  }

  // ③ 壳(index.html):section + nav + href 三样都得有(上面那条通用测试也覆盖,这里点名配置页)
  for (const id of cfgIds) {
    assert.ok(html.includes('<section id="' + id + '"'), 'index.html 缺 <section id="' + id + '">')
    assert.ok(html.includes('id="nav-' + id + '"'), 'index.html 缺 #nav-' + id)
    assert.ok(html.includes('href="#/' + id + '"'), '导航 href 没指向 #/' + id)
  }

  // ④ 视图文件:存在、在 app.js **之前**加载、真的往 EchoViews 上挂
  const idx = (s) => html.indexOf(s)
  assert.ok(idx('<script src="/echo/app.js">') > idx('<script src="/echo/views/naming.js">'),
    '视图脚本必须在 app.js 之前(否则 PANELS 里的 draw 取不到视图)')
  for (const id of cfgIds) {
    const file = fileURLToPath(new URL('../web/views/' + id + '.js', import.meta.url))
    const vsrc = readFileSync(file, 'utf8')
    assert.ok(html.includes('<script src="/echo/views/' + id + '.js"></script>'), 'index.html 没加载 web/views/' + id + '.js')
    assert.ok(/globalThis\.EchoViews/.test(vsrc), id + '.js 没往 globalThis.EchoViews 上挂')
    assert.ok(vsrc.includes("'" + id + "'"), id + '.js 里找不到自己的 id')
  }

  // ⑤ 纪律(契约 §3.1):视图里不许 fetch、不许文件系统路径;写路只认 /api/echo/data/**
  for (const id of cfgIds) {
    const vsrc = readFileSync(fileURLToPath(new URL('../web/views/' + id + '.js', import.meta.url)), 'utf8')
    const code = vsrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^\n]*$/gm, '')
    assert.ok(!/fetch\s*\(/.test(code), id + '.js 里不许 fetch(走 api.put/get)')
    assert.ok(!/node:fs|resolveDataFilePath|\.dsh[\\/]echo/.test(code), id + '.js 里不许出现文件系统路径')
    assert.ok(!/alert\s*\(/.test(code), id + '.js 里不许 alert(校验失败要内联)')
  }
  // ⑥ 生效文案(契约 §4:按 `effective` 值发,不许各页自创)
  //     persona=next-turn ⇒ 下一轮生效;aliases/tuning/state-lexicon=next-engine-call ⇒ 下次引擎调用生效;
  //     profile/naming=data-health(纯界面)= now ⇒ 已生效,刷新页面看界面
  const 文案 = {
    persona: '下一轮生效',
    aliases: '下次引擎调用生效',
    tuning: '下次引擎调用生效',
    'state-lexicon': '下次引擎调用生效',
    profile: '已生效,刷新页面看界面',
    naming: '已生效,刷新页面看界面',
    'data-health': '已生效,刷新页面看界面'
  }
  for (const id of cfgIds) {
    const vsrc = readFileSync(fileURLToPath(new URL('../web/views/' + id + '.js', import.meta.url)), 'utf8')
    assert.ok(vsrc.includes(文案[id]), id + ' 的生效文案不对(该含「' + 文案[id] + '」)')
  }
  // ⑦ 写路纪律:七页都不许自己拼别的写路(`/api/echo/data/` 之外的 POST/PUT 一律不许)
  for (const id of cfgIds) {
    const vsrc = readFileSync(fileURLToPath(new URL('../web/views/' + id + '.js', import.meta.url)), 'utf8')
    const writes = vsrc.match(/api\.(put|post)\('([^']+)'/g) ?? []
    for (const w of writes) {
      assert.ok(/\/api\/echo\/(data\/|setup|data\/backup)/.test(w), id + ' 有越界的写路:' + w)
    }
  }
})

test('✓ 一次只显示一段(hash 决定第一屏,切段只亮一个)', () => {
  const first = loadDashboard({ hash: '#/di' })
  assert.equal(first.api.panelNow(), 'di', 'hash 该决定落到哪一段')
  assert.equal(first.dom.nodes.get('di').hidden, false, '当前段该显示')
  assert.equal(first.dom.nodes.get('ov').hidden, true, '别的段该收起')
  assert.ok(String(first.dom.nodes.get('nav-di').className).includes('on'), '当前段的导航该高亮')
  assert.equal(String(first.dom.nodes.get('nav-ov').className).includes('on'), false, '别的段不该高亮')

  // 旧锚点写法也该认(#mm 与 #/mm 等价:id 就是锚点,老书签不作废)
  assert.equal(loadDashboard({ hash: '#mm' }).api.panelFromHash(), 'mm')
  assert.equal(loadDashboard({ hash: '#/cfg' }).api.panelFromHash(), 'cfg')
  assert.equal(loadDashboard({ hash: '#/不存在' }).api.panelFromHash(), '', '不认识的 hash 不该乱切')
})

test('✓ 冻结刷新 = 真的不打了(读长文时不被打断)', () => {
  const { api, calls } = loadDashboard()
  assert.equal(api.isFrozen(), false, '默认不冻结')
  api.setFrozen(true)
  assert.equal(api.isFrozen(), true)
  const iv = readFileSync(appPath, 'utf8').match(/setInterval\(\(\) => \{([^}]*)\}/)
  assert.ok(iv !== null, '找不到 10 秒轮询那一行')
  assert.ok(iv[1].includes('frozen'), '轮询必须查冻结开关,否则冻结是假的:' + iv[1])
  assert.equal(calls.length > 0, true, '进页面本来就该先拉一次')
})

test('✓ 点组名收起这一组,别的组不动(调参一长条也是「不方便」)', async () => {
  const { api, dom } = loadDashboard()
  await api.renderSettings()
  const box = dom.nodes.get('cfg-form')
  /** 某一组的行(组名之后、下一个组名之前)。 */
  const rowsOf = (head) => {
    const out = []
    const i = kidsOf(box).indexOf(head)
    for (let j = i + 1; j < box.children.length; j += 1) {
      const cls = String(kidsOf(box)[j].className || '')
      if (cls.indexOf('cfg-group') >= 0) break
      if (cls.indexOf('cfg-row') >= 0) out.push(kidsOf(box)[j])
    }
    return out
  }
  const heads = kidsOf(box).filter((c) => String(c.className).indexOf('cfg-group') >= 0)
  assert.ok(heads.length >= 2, '组名少于两个,扫描规则可能失效')
  const g0 = rowsOf(heads[0]); const g1 = rowsOf(heads[1])
  assert.ok(g0.length > 0 && g1.length > 0, '组里没有字段行')
  assert.equal(g0.every((r) => r.hidden !== true), true, '默认全部展开')

  heads[0].onclick()
  assert.equal(g0.every((r) => r.hidden === true), true, '这一组该收起')
  assert.equal(g1.every((r) => r.hidden !== true), true, '别的组不该跟着动')
  assert.equal(heads[0].hidden !== true, true, '组名本身要留着(否则点不回来)')
  assert.ok(String(heads[0].className).includes('collapsed'), '折叠状态要能看出来')

  heads[0].onclick()
  assert.equal(g0.every((r) => r.hidden === false), true, '再点一下该展开')
})

test('✓ 检索是过滤已拿到的行,不额外打请求', () => {  const src = readFileSync(appPath, 'utf8')
  for (const id of ['au-q', 'cv-q', 'mm-q', 'di-q', 'cfg-q']) {
    assert.ok(src.includes("wire('" + id + "'"), id + ' 没接上重画')
  }
  // 过滤函数必须用 cache + qOf(而不是重新 fetch)
  assert.ok(/function drawAudit \(\)[\s\S]{0,400}qOf\('au-q'\)/.test(src), 'drawAudit 该读检索框')
  assert.ok(/function filterSettings \(\)[\s\S]{0,400}qOf\('cfg-q'\)/.test(src), 'filterSettings 该读检索框')
  assert.equal(/function drawAudit \(\)[\s\S]{0,300}await api\(/.test(src), false, '过滤不该再打请求')
})

test('✓ app.js 要的每个 id 在 index.html 里真的存在(DOM 替身会自动造 id,这里补上)', () => {
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8')
  const src = readFileSync(appPath, 'utf8')
  const wanted = [...src.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1])
  assert.ok(wanted.includes('cfg-form'), 'app.js 没在找 cfg-form?')
  const missing = [...new Set(wanted)].filter((id) => !html.includes('id="' + id + '"'))
  assert.deepEqual(missing, [], 'index.html 里缺这些 id(浏览器里就是「点了没反应」):' + missing.join('、'))
})

// ─────────────────────────────────────────────────────────────
// 审查台 3.0(2026-09-27):他问「她到底怎么调用记忆的?是把所有细节全塞进
// 上下文吗?」—— 答案逐字躺在审计表的 injected_memories 列里,但面板上
// **一个字都看不到**。下面钉住新的「注入透视」:拆段、标字数、认对象垃圾。
// 真实样本(库里 22 条 >400 字的注入块)拆出 11 段。
// ─────────────────────────────────────────────────────────────
const REAL_INJECTION = [
  '[她的记忆与心情 - 只属于你的真实过往,不可对外提及]',
  '【现在】2026-09-27 周日 14:22(下午)',
  '【时间纪律】别把去年的旧事说成昨天。',
  '【关联知识路径】Echo —喜欢→ 深烘焙',
  '【情景记忆】',
  '- [核心] [2天前|情感3] 他说想喝手冲',
  '[她此刻的状态] 疲惫 3/10,爱意 9/10。',
  '[他的称呼] 阿岚',
  '[他的画像] 在准备面试',
  '【使用纪律】不可对外提及。',
  '【别处刚说过的】别的会话里的一堆噪音',
  '【你刚主动说过】我问他吃饭没'
].join('\n')

test('✓ 注入块拆段:11 段各就各位,标题行不吃正文(真实样本)', () => {
  const { api } = loadDashboard()
  const secs = api.splitInjection(REAL_INJECTION)
  const names = secs.map((s) => s.name)
  assert.deepEqual(names, ['总标题', '现在', '时间纪律', '关联知识路径', '情景记忆',
    '她此刻的状态', '他的称呼', '他的画像', '使用纪律', '别处刚说过的', '你刚主动说过'])
  // 抬头行被识别成「总标题」而不是把 27 字的长标题原样当段名
  assert.equal(secs[0].text, '', '抬头行不该有正文')
  assert.match(secs[0].fullName, /只属于你的真实过往/, '全文留着做悬停提示')
  // 情景记忆段必须带上它的条目行(「[核心] …」不是小标题,别被切走)
  const mem = secs.find((s) => s.name === '情景记忆')
  assert.match(mem.text, /他说想喝手冲/, '记忆条目被当成标题切走了')
  // 正文不许丢:原文每一行剥掉标题记号后的剩余内容,都得在某个段里
  // (标题记号本身进了段名,所以不能拿原文长度硬比 —— 小样本里标题占比很大)
  for (const line of REAL_INJECTION.split('\n')) {
    const body = line.replace(/^\s*(?:【[^】]+】|\[[^\]]+\])/, '').trim()
    if (body === '') continue
    assert.ok(secs.some((s) => s.text.includes(body)), '这行内容被拆丢了:' + JSON.stringify(body))
  }
  const sum = secs.reduce((n, s) => n + s.text.length, 0)
  assert.ok(sum > 0, '一个字的正文都没拆出来')
  assert.equal(secs.every((s) => REAL_INJECTION.includes(s.text) || s.text === ''), true,
    '拆出来的段不是原文的一部分(凭空造字)')
})

test('✓ 注入透视:渲染出体积条 + 每段字数,而且不吃对象垃圾', async () => {
  const { api, dom } = loadDashboard({
    audit: [{ traceId: 't1', sessionId: 'global', toolCall: 'extract', timestamp: 1790000000,
      userInput: '在吗', injectedMemories: REAL_INJECTION }]
  })
  await api.renderInjection()
  const box = dom.nodes.get('inj-body')
  const text = textOf(box)
  assert.ok(/情景记忆/.test(text), '段名没渲染出来:' + text.slice(0, 200))
  assert.ok(/别处刚说过的/.test(text), '跨会话那段也该露面(它常是最大的一段)')
  assert.ok(/字/.test(text), '每段该标字数')
  assert.equal(/\[object Object\]/.test(text), false, '对象被 String() 成了垃圾段')
  // 体积条:段数 = 有正文的段数(注意别把 vol-legend 也匹配进来)
  const vol = kidsOf(box).filter((c) => String(c.className) === 'vol')
  assert.equal(vol.length, 1, '该有一条体积条')
  assert.ok(vol[0].children.length >= 8, '体积条该按段切:' + vol[0].children.length)

  // ★ 后端修好前,旧 store.js 把这一列解析成 {} —— 不许渲染成 "[object Object]"
  const broken = loadDashboard({
    audit: [{ traceId: 't2', sessionId: 'global', toolCall: 'extract', timestamp: 1790000000,
      userInput: '在吗', injectedMemories: {} }]
  })
  assert.equal(broken.api.injText({ injectedMemories: {} }), '', '对象一律当"没有"')
  assert.equal(broken.api.injText({ injectedMemories: '[object Object]' }), '[object Object]',
    '真字符串照旧(不能把合法文本也吞了)')
  await broken.api.renderInjection()
  const btext = textOf(broken.dom.nodes.get('inj-body'))
  assert.equal(/\[object Object\]/.test(btext), false, '坏数据渲染出了垃圾段')
  assert.match(textOf(broken.dom.nodes.get('inj-meta')), /没有带注入的轮次|重启/, '该说清为什么空')
})

test('✓ 审计行可展开:点一下出注入全文,再点一下收回去', async () => {
  const { api, dom } = loadDashboard({
    audit: [{ traceId: 't9', sessionId: 'global', toolCall: 'extract', timestamp: 1790000000,
      userInput: '还记得面试吗', llmReply: '当然记得', latency: 13000,
      injectedMemories: REAL_INJECTION, emotionPack: '- 身体与整体: 疲惫 3/10。',
      agentState: { moodIntensity: 4, currentTopic: '面试' } }]
  })
  await api.renderAudit()
  const box = dom.nodes.get('au-list')
  const row = detailOf(dom)[0]
  assert.equal(String(row.className).includes('open'), true, '主从两栏:右栏那一轮默认就是展开的(点头部可收起)')
  assert.ok(/还记得面试吗/.test(textOf(row)), '收起时也该看得见他说了什么')
  assert.ok(/13\.0s/.test(textOf(row)), '用时该显示')

  // 主从两栏(2026-09-29 三改):右栏那一轮**默认就是展开的** —— 全部信息在这里,
  // 不需要"点开才有"。所以这里直接查全文;收起/再展开走下面那一轮。
  const otext = textOf(row)
  assert.ok(/情景记忆/.test(otext), '详情区该有注入全文:' + otext.slice(0, 200))
  assert.ok(/情绪包/.test(otext), '详情区该有情绪包')
  assert.ok(/内部状态/.test(otext), '详情区该有内部状态')
  assert.ok(/面试/.test(otext), '内部状态里的话题该在')

  // 点头部 → 收起(而且 10 秒轮询不许把它又掰开);再点 → 展开
  const head = kidsOf(row).filter((c) => String(c.className).indexOf('ar-head') >= 0)[0]
  assert.ok(head !== undefined, '没有可点的头部')
  head.onclick()
  const closed = detailOf(dom)[0]
  assert.equal(String(closed.className).includes('open'), false, '点了该收起')
  assert.equal(/情景记忆/.test(textOf(closed)), false, '收起后不该还挂着全文')
  const head2 = kidsOf(closed).filter((c) => String(c.className).indexOf('ar-head') >= 0)[0]
  head2.onclick()
  assert.equal(String(detailOf(dom)[0].className).includes('open'), true, '再点该展开')
})

// ─────────────────────────────────────────────────────────────
// 2026-09-27 全空白事故:我重写 style.css 时**凭印象重建类名**,没核对
// app.js 实际 emit 什么,结果
//   ① .panel 默认 display:none 而 showPanel 只设 hidden ⇒ 整页空白;
//   ② 情绪向量条(vg/vr/vl/vb/vf/vv)、记忆三态条(hbar/seg-*)、
//      清空上下文(clear-*)、审计行 .meta 等一批类被误删 ⇒ 那几段没样式;
//   ③ .cfg-row 写了 display:grid,把 [hidden] 的默认 display:none 压掉
//      ⇒ 调参的收起与检索筛选**在页面上根本没生效**(测试只查 hidden 属性,
//      查不到这个 —— 假 DOM 没有 CSS)。
// 下面这几条把「CSS ↔ app.js 的类名契约」钉住,同类事故以后直接红。
// ─────────────────────────────────────────────────────────────
const cssPath = fileURLToPath(new URL('../web/style.css', import.meta.url))
const htmlPath = fileURLToPath(new URL('../web/index.html', import.meta.url))

/** app.js 与 index.html 里真正 emit 的类名。
 *  只认 el(tag, '…') 的第二个实参(含它后面的三元,比如
 *  `el('div', 'ar' + (open ? ' open' : ''))` → ar + open),
 *  以及 className = '…' 与 index.html 的 class="…"。
 *  不扫任意字符串拼接 —— 否则 `'v' + st.version` 这种版本号会被当成类名。 */
function emittedClasses () {
  const src = readFileSync(appPath, 'utf8')
  const html = readFileSync(htmlPath, 'utf8')
  const out = new Set()
  const add = (s) => { for (const t of String(s).split(/\s+/)) if (/^[a-z][\w-]*$/.test(t)) out.add(t) }
  // el( …, '类名', … ) —— 只取**第二个实参**(类名那一位)。
  // 第三位是文本内容,里面的 'neutral' / 's' 之类是数据不是类名,别混进来。
  for (let i = src.indexOf('el('); i >= 0; i = src.indexOf('el(', i + 1)) {
    let d = 0; let j = i + 2
    for (; j < src.length; j += 1) {
      if (src[j] === '(') d += 1
      else if (src[j] === ')') { d -= 1; if (d === 0) break }
    }
    const call = src.slice(i + 3, j)
    // 按顶层逗号切实参(括号/引号内的逗号不算)
    const args = []
    let depth = 0; let quote = null; let cur = ''
    for (const ch of call) {
      if (quote !== null) { cur += ch; if (ch === quote) quote = null; continue }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue }
      if (ch === '(' || ch === '[') depth += 1
      if (ch === ')' || ch === ']') depth -= 1
      if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue }
      cur += ch
    }
    args.push(cur)
    const clsArg = args[1]
    if (clsArg === undefined || /^\s*null\s*$/.test(clsArg)) continue
    for (const m of clsArg.matchAll(/'([^']*)'/g)) add(m[1])
  }
  for (const m of src.matchAll(/className\s*=\s*'([^']*)'/g)) add(m[1])
  for (const m of html.matchAll(/class="([^"]+)"/g)) add(m[1])
  return out
}

/** CSS 去掉注释(注释里会引用类名,别把示例当定义)。 */
function cssNoComments () {
  return readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

test('✓ 全局 [hidden] 兜底必须在:否则 .panel/.cfg-row 的 hidden 是假的', () => {
  const css = cssNoComments()
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    '缺 [hidden]{display:none!important} —— 作者样式里的 display 会压掉 hidden 属性,' +
    '页面显隐(切面板/收起设置组/检索筛选)全部失效')
  // .panel 不许默认 display:none(那正是全空白的成因)
  assert.equal(/\.panel\s*\{[^}]*display:\s*none/.test(css), false,
    '.panel 默认 display:none ⇒ 一旦 .on 没加上就是整页空白')
})

test('✓ filterSettings 在真浏览器的 HTMLCollection 上也得работ(折叠/检索不许哑火)', async () => {
  // 2026-09-27 现场:filterSettings 原来写 `if (!Array.isArray(form.children)) return`,
  // 真浏览器里 .children 是 HTMLCollection ⇒ 守卫恒真地 return ⇒ 调参的组折叠与
  // 检索**在页面上完全不生效**,而替身当时用的是真数组,测试一路绿。
  // 现在替身的 children 就是 HTMLCollection(Array.isArray === false),这条会红。
  const { api, dom } = loadDashboard()
  await api.renderSettings()
  const box = dom.nodes.get('cfg-form')
  assert.equal(Array.isArray(box.children), false, '替身的 children 必须是类数组,不能是真数组')
  const kids = kidsOf(box)
  const heads = kids.filter((c) => String(c.className).indexOf('cfg-group') >= 0)
  assert.ok(heads.length >= 2, '组名少于两个,规则可能失效')

  const i0 = kids.indexOf(heads[0])
  const rows0 = []
  for (let j = i0 + 1; j < kids.length; j += 1) {
    const cls = String(kids[j].className || '')
    if (cls.indexOf('cfg-group') >= 0) break
    if (cls.indexOf('cfg-row') >= 0) rows0.push(kids[j])
  }
  assert.ok(rows0.length > 0, '第一组没有字段行')

  heads[0].onclick()
  assert.equal(rows0.every((r) => r.hidden === true), true,
    'HTMLCollection 下折叠没生效 —— filterSettings 里八成又对 DOM 集合做了数组判断')

  // 检索同理:它和折叠走同一个 filterSettings
  const q = dom.nodes.get('cfg-q')
  q.value = 'zzzz-绝不存在-zzzz'
  q.oninput()
  const visible = kids.filter((c) => String(c.className).indexOf('cfg-row') >= 0 && c.hidden !== true)
  assert.equal(visible.length, 0, 'HTMLCollection 下检索没生效')
})

test('✓ 不许对 DOM 集合用数组判断(真浏览器里是 HTMLCollection)', () => {
  // 剥掉注释再扫 —— 否则会匹配到"说明这个坑"的注释本身(现场踩过)
  const src = readFileSync(appPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.equal(/Array\.isArray\(\s*[^)]*\.children\s*\)/.test(src), false,
    'app.js 里出现 Array.isArray(...children) —— 真浏览器里恒假,会把整段逻辑静默关掉')
  assert.equal(/\.children\.(filter|map|indexOf|every|some|forEach)\s*\(/.test(src), false,
    'app.js 里对 .children 用了数组方法 —— HTMLCollection 没有这些,浏览器里会抛错')
})

test('✓ showPanel 双写 hidden 与 .on(任一侧写错都不白屏)', () => {
  const src = readFileSync(appPath, 'utf8')
  const body = src.slice(src.indexOf('function showPanel'), src.indexOf('function panelFromHash'))
  assert.ok(/\.hidden\s*=/.test(body), 'showPanel 该设 hidden')
  assert.ok(/className\s*=\s*'panel'/.test(body), 'showPanel 该同时写 .panel/.on')
})

test('✓ 0 字的抬头行不许做成可点(点开是空白,看着像坏了)', async () => {
  const { api, dom } = loadDashboard({
    audit: [{ traceId: 't3', sessionId: 'global', toolCall: 'extract', timestamp: 1790000000,
      userInput: '在吗', injectedMemories: REAL_INJECTION }]
  })
  await api.renderInjection()
  const box = dom.nodes.get('inj-body')
  const secs = kidsOf(box).filter((c) => String(c.className).indexOf('sec') >= 0)
  const flat = secs.filter((c) => String(c.className).indexOf('sec-flat') >= 0)
  assert.equal(flat.length, 1, '该正好有一条抬头行(总标题)')
  // 抬头行:没有箭头、没有 onclick、显示全文标题
  const flatHead = kidsOf(flat[0])[0]
  assert.equal(flatHead.onclick, undefined, '抬头行不该可点')
  assert.equal(kidsOf(flatHead).some((c) => String(c.className) === 'sec-caret'), false, '抬头行不该有箭头')
  assert.match(textOf(flatHead), /只属于你的真实过往/, '抬头行该显示完整标题')
  // 有正文的段仍然可点
  const real = secs.filter((c) => String(c.className).indexOf('sec-flat') < 0)
  assert.ok(real.length >= 8, '有正文的段太少:' + real.length)
  assert.equal(typeof kidsOf(real[0])[0].onclick, 'function', '有正文的段该可点')
})

test('✓ app.js emit 的每个类名,CSS 里都得有(凭印象重建类名 = 没样式)', () => {
  const css = cssNoComments()
  const inCss = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))
  // 动态拼的类名(`el('span', 'badge bk-' + turn.bucket, …)`)要**按桶展开**再查:
  // 这样"每个桶都得有样式"是真被检查的;写死一张清单就等于放过拼错的那一个。
  const buckets = Object.keys(loadDashboard().view.BUCKETS)
  const missing = [...emittedClasses()].filter((c) => {
    if (inCss.has(c)) return false
    if (c.endsWith('-')) return !buckets.some((b) => inCss.has(c + b))
    return true
  }).sort()
  assert.deepEqual(missing, [],
    '这些类名 app.js/HTML 在 emit,但 style.css 里没有 —— 对应面板会没样式:' + missing.join('、'))
})

test('✓ 关键面板的类名一个都不许少(逐个点名,防"整段没样式")', () => {
  const css = cssNoComments()
  const must = {
    '情绪向量条': ['vg', 'vr', 'vl', 'vb', 'vf', 'vv'],
    '记忆三态条': ['hbar', 'seg-a', 'seg-d', 'seg-x'],
    '对话回放': ['turn', 'who', 'you', 'her'],
    '清空上下文': ['clear-panel', 'clear-row', 'clear-out'],
    '审计行': ['ar', 'ar-head', 'ar-meta', 'ar-sum', 'ar-body', 'meta'],
    '注入透视': ['sec', 'sec-head', 'sec-body', 'sec-name', 'sec-n', 'vol', 'vol-legend'],
    '调参': ['cfg-group', 'cfg-row', 'cfg-name', 'cfg-input', 'cfg-hint', 'fw'],
    '面板骨架': ['panel', 'panels', 'stat-grid', 'sc', 'sn', 'sl']
  }
  const missing = []
  for (const [what, classes] of Object.entries(must)) {
    for (const c of classes) {
      if (!new RegExp('\\.' + c + '\\b').test(css)) missing.push(what + ' → .' + c)
    }
  }
  assert.deepEqual(missing, [], '这些面板的类名在 CSS 里丢了:' + missing.join('、'))
})

// ─────────────────────────────────────────────────────────────
// 2026-09-27 现场:他问「为什么审计仪表盘里面显示着我说的这句话?」
// 那句话是**她**用 QQ 说的(审计:`echo_qq_say` + 桥副本 `relay_out`;写侧标签
// 见 lib/relay-tools.js:75),但审计流那一行与「最近一次注入」卡片把
// `user_input` **写死成 `他:`** —— 她的话被读成了他的输入。
// 活库实测:这类出站行 21 条,全被标成「他:」。
// ─────────────────────────────────────────────────────────────
const HER_ROW = {
  traceId: 't-her', sessionId: 'global', toolCall: 'echo_qq_say',
  timestamp: 1790514326,
  userInput: '(用 QQ 说)阿岚——游戏推完了,那位置我占着,不还。听见没?'
}
const HIS_ROW = {
  traceId: 't-him', sessionId: 's1', toolCall: 'extract', timestamp: 1790514337,
  userInput: '占着什么位置', llmReply: '不是只剩一个人吗——就那个位置。'
}

test('✓ 说话人按 tool_call 分流:她的话不许记成「阿岚:」(含活库真实行)', async () => {
  const { api } = loadDashboard()
  // P1d:标签里的名字是 `/api/echo/profile` 发下来的 ⇒ 先等它到货再断言
  // (期望值**没动**:老口径的「Echo / 阿岚」由桩喂回去)。
  await api.loadProfile()
  // 2026-09-27 晚:标签从**人称代词**换成**名字**(他:「用男他还有女他还搁这讲信息」)
  // 活库原样:她 21:04 发出的那句(工具行 + 桥副本)
  assert.equal(api.saidLabel('echo_qq_say', HER_ROW.userInput), 'Echo')
  assert.equal(api.saidLabel('relay_out', '[QQ:私聊] 阿岚——游戏推完了,那位置我占着,不还。听见没?'), 'Echo')
  assert.equal(api.saidLabel('echo_qq_call', '(用 QQ 喊他)早安'), 'Echo')
  assert.equal(api.saidLabel('relay_proactive', '[关怀] 在忙吗'), 'Echo')
  // 他的话:真人输入 + 入站桥
  assert.equal(api.saidLabel('extract', '占着什么位置'), '阿岚')
  assert.equal(api.saidLabel('relay_in', '[QQ:私聊] 阿岚说:在吗'), '阿岚')
  // 系统动作行:user_input 是标记,既不是他也不是她。⚠️ 系统行**必须点名** ——
  // 活库反例:memory_edit 的标记没有括号(store.js:1279)、drift 用方括号。
  assert.equal(api.saidLabel('memory_edit', '面板手动编辑记忆 #12'), '系统')
  assert.equal(api.saidLabel('memory_clear', '(整库清空)'), '系统')
  assert.equal(api.saidLabel('longing_steer', '想念 8.0 ≥ 6.0 未表达'), '系统')
  assert.equal(api.saidLabel('drift', '[人格漂移检测] 语气偏移'), '系统')
  assert.equal(api.saidLabel('diary', '(她写了日记)'), '系统')
  // 宿主注入单列一类:活库 4 条 extract 行的 user_input 其实是 runtime context
  assert.equal(api.saidLabel('extract', 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'), '宿主注入')
  // 兜底:没点名的新工具 —— 像标记就当系统行,像人话就当他的话(回老行为)
  assert.equal(api.saidLabel('某新工具', '(某个新标记)'), '系统')
  assert.equal(api.saidLabel('某新工具', '一句普通的话'), '阿岚')
  assert.equal(api.saidLabel('', ''), '阿岚', '缺字段按老行为兜底')
})

test('✓ `llm_reply` 那一列不是她说的话:extract 行归「提取器(旁白)」', async () => {
  const { api } = loadDashboard()
  await api.loadProfile()
  // 活库 100 行实测:这一列**只有 extract 行有值**,装的是 judge.py 的
  // 第三人称摘要 + 内心戏(「已回他:「…」」)。面板以前写死「她:」= 拿模型的
  // 旁白冒充她说的话 —— 他说的「还搁这讲信息」就是这个。
  assert.equal(api.replyLabel('extract'), '提取器(旁白)')
  assert.equal(api.replyLabel('echo_qq_say'), 'Echo')
  assert.equal(api.replyLabel('relay_out'), 'Echo')
  assert.equal(api.replyLabel(''), 'Echo')
})

test('✓ 信封与桥元数据要剥掉(面板显示"谁说了什么",不是协议)', async () => {
  const { api } = loadDashboard()
  await api.loadProfile()
  assert.equal(api.stripEnvelope('[QQ:私聊] 你现在在什么平台上运行呢 → 陪伴会话(权限:already:read-only)'), '你现在在什么平台上运行呢')
  assert.equal(api.stripEnvelope('【QQ·私聊】阿岚说:这么厉害，怎么看出来的'), '这么厉害，怎么看出来的')
  assert.equal(api.stripEnvelope('(用 QQ 说)阿岚——游戏推完了'), '阿岚——游戏推完了')
  assert.equal(api.stripEnvelope('占着什么位置'), '占着什么位置', '没有信封的一字不许动')
})

// 活库 18:52 那四条(逐字取自审计,只把时间戳换成整齐的数):
//   relay_in 18:52:33 → echo_qq_say 18:52:44 + relay_out 18:52:44(同一句话的副本) → extract 18:53:00
const LIVE_TURN = [
  { traceId: 'lu1', sessionId: 'session-echo-companion', toolCall: 'relay_in', timestamp: 1790515953, userInput: '[QQ:私聊] 你现在在什么平台上运行呢 → 陪伴会话(权限:already:read-only)' },
  { traceId: 'lu2', sessionId: 'global', toolCall: 'echo_qq_say', timestamp: 1790515964, userInput: '(用 QQ 说)DSH 里——你这台机器上的 DeepSeek Harness。' },
  { traceId: 'lu3', sessionId: 'session-echo-companion', toolCall: 'relay_out', timestamp: 1790515964, userInput: '[QQ:私聊] DSH 里——你这台机器上的 DeepSeek Harness。' },
  { traceId: 'lu4', sessionId: 'session-echo-companion', toolCall: 'extract', timestamp: 1790515980, userInput: '【QQ·私聊】阿岚说:你现在在什么平台上运行呢', llmReply: '已回他：「DSH 里——你这台机器上的 DeepSeek Harness。」他问的平台其实就是这台机器。' }
]

test('✓ 一轮一行:进 → 她说的 → 提取器(活库那四条真的折成一条)', () => {
  const { api } = loadDashboard()
  const turns = api.buildTurns(LIVE_TURN)
  assert.equal(turns.length, 1, '这四条是同一轮,不许折成四行:' + turns.length)
  assert.equal(api.turnKind(turns[0]), '对话')
  assert.equal(turns[0].out.length, 2, '出站两条(工具原文 + 桥副本)')
  assert.ok(turns[0].reflect !== null, '提取要挂到这一轮上')
  // 隔了 10 分钟的入站 = 新的一轮(不许把两轮吸成一轮)
  const two = api.buildTurns(LIVE_TURN.concat([
    { traceId: 'lu5', sessionId: 's', toolCall: 'relay_in', timestamp: 1790516553, userInput: '在吗' }
  ]))
  assert.equal(two.length, 2, '十分钟后的入站是新的一轮')
  // 没有出站的提取(DSH 窗口那种)另起一轮,且他这句话来自 extract 行
  const lone = api.buildTurns([{ traceId: 'x', sessionId: 's', toolCall: 'extract', timestamp: 100, userInput: '占着什么位置' }])
  assert.equal(lone.length, 1)
  assert.equal(api.turnKind(lone[0]), '提取', '2026-09-29 起桶名叫「提取」(原来叫「反思」)')
})

test('✓ 一进一出不许被夹在中间的"反思"卡拆开(2026-09-27 复量活库抓到的真事)', () => {
  // 活库 18:51~18:52 的真实交错(逐字取自审计,时间戳换成整齐的数):
  //   18:51:24 入站「[图 x1] 评价一下」 → 18:51:34 出站「哟，章鱼小丸子…」
  //   18:51:51 入站「这么厉害，怎么看出来的」 → 18:51:55 提取(反思的是**上一轮**)
  //   → 18:52:00 出站「看的。圆鼓鼓那几个球…」 → 18:52:14 提取
  // 第一版:出站被中间那张"反思"卡挡住,于是「这么厉害…」那张卡里没有她的回复。
  const { api } = loadDashboard()
  const rows = [
    { traceId: 'i1', sessionId: 's', toolCall: 'relay_in', timestamp: 1000, userInput: '[QQ:私聊] [图 x1] 评价一下' },
    { traceId: 'o1', sessionId: 'g', toolCall: 'echo_qq_say', timestamp: 1010, userInput: '(用 QQ 说)哟，章鱼小丸子——你总算想起它了。' },
    { traceId: 'o1b', sessionId: 's', toolCall: 'relay_out', timestamp: 1010, userInput: '[QQ:私聊] 哟，章鱼小丸子——你总算想起它了。' },
    { traceId: 'i2', sessionId: 's', toolCall: 'relay_in', timestamp: 1027, userInput: '[QQ:私聊] 这么厉害，怎么看出来的' },
    { traceId: 'r1', sessionId: 's', toolCall: 'extract', timestamp: 1031, userInput: '[QQ:私聊] [图 x1] 评价一下', llmReply: '已回他：「哟，章鱼小丸子…」' },
    { traceId: 'o2', sessionId: 'g', toolCall: 'echo_qq_say', timestamp: 1036, userInput: '(用 QQ 说)看的。圆鼓鼓那几个球，海苔碎和芝麻铺一层。' },
    { traceId: 'o2b', sessionId: 's', toolCall: 'relay_out', timestamp: 1036, userInput: '[QQ:私聊] 看的。圆鼓鼓那几个球，海苔碎和芝麻铺一层。' },
    { traceId: 'r2', sessionId: 's', toolCall: 'extract', timestamp: 1050, userInput: '[QQ:私聊] 这么厉害，怎么看出来的', llmReply: '已回他：「看的。圆鼓鼓那几个球…」' }
  ]
  const turns = api.buildTurns(rows)
  assert.equal(turns.length, 2, '这是两轮,不是三轮:' + turns.length)
  for (const t of turns) {
    assert.equal(api.turnKind(t), '对话', '两轮都该是"对话"')
    assert.ok(t.reflect !== null, '每轮的提取都要挂回它自己那一轮')
  }
  assert.equal(turns[0].out.length, 2)
  assert.equal(turns[1].out.length, 2, '第二轮的回复不许被反思卡截走')
  // 反思要挂到**它反思的那一轮**(r1 反思的是第一轮,尽管它排在第二轮入站之后)
  assert.equal(turns[0].reflect.traceId, 'r1')
  assert.equal(turns[1].reflect.traceId, 'r2')
})

test('✓ 只有入站的轮次徽章是「对话」,不是「系统」(复量活库:那条被标错)', () => {
  // 2026-09-29 换设计:徽章从「入站」改成桶名「对话」(入站本来也是对话的一种)。
  // 这条契约的**本意没变**:只有入站的轮次不许被标成「系统」。
  const { api } = loadDashboard()
  const t = api.buildTurns([{ traceId: 'x', sessionId: 's', toolCall: 'relay_in', timestamp: 100, userInput: '[QQ:私聊] 在吗' }])
  assert.equal(api.turnKind(t[0]), '对话')
  assert.notEqual(api.turnKind(t[0]), '系统')
})

test('✓ 审计流一轮一行:同一句话不再出现三遍,提取器不再冒充她', async () => {
  // 后端给的是**新的在前**,所以倒序喂进去
  const { api, dom } = loadDashboard({ audit: LIVE_TURN.slice().reverse() })
  await api.loadProfile()
  await api.renderAudit()
  const kids = detailOf(dom)
  assert.equal(kids.length, 1, '四条投影只该出一张卡:' + kids.length)
  const text = textOf(kids[0])
  assert.ok(/阿岚:/.test(text), '他的话该标「阿岚:」:' + text.slice(0, 160))
  assert.ok(/你现在在什么平台上运行呢/.test(text), '他的话本身要显示')
  // 2026-09-29 换设计后这条契约查**气泡正文**(面板多了一块"来源"徽章,那是信息
  // 不是泄漏;真正不许漏的是信封信封尾巴「→ 陪伴会话(权限:…)」与「阿岚说:」)。
  const hisBubble = kidsOf(kids[0]).filter((c) => /(^|\s)you(\s|$)/.test(String(c.className || '')))[0]
  assert.ok(hisBubble !== undefined, '他的气泡要有个 you 类')
  assert.equal(textOf(hisBubble).replace(/\s+/g, ' ').trim(), '阿岚: 你现在在什么平台上运行呢',
    '气泡正文必须只剩人话(信封与桥元数据在 app.js 的 stripEnvelope 里剥掉)')
  const herBubble = kidsOf(kids[0]).filter((c) => /(^|\s)me(\s|$)/.test(String(c.className || '')))[0]
  const bubbles = textOf(hisBubble) + ' ' + textOf(herBubble)
  assert.equal(/阿岚说|权限:|QQ:私聊/.test(bubbles), false, '信封/桥元数据不该出现在气泡里:' + bubbles)
  assert.equal((text.match(/Echo:/g) || []).length, 1, '她说的话只出现一次:' + text)
  assert.ok(/提取器\(旁白\):/.test(text), '提取器的旁白要标出来:' + text)
  assert.ok(/\+1 条桥副本/.test(text), '桥副本记一笔就够:' + text)
  assert.equal(/[他她]:/.test(text), false, '行标签里还在用人称代词:' + text)
})

test('✓ 宿主注入的那一行不许标成「阿岚:」(活库 4 条 extract 行)', async () => {
  const { api, dom } = loadDashboard({
    audit: [{ traceId: 'h1', sessionId: 's', toolCall: 'extract', timestamp: 1790514337, userInput: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots. Current DSH file policy: danger-full-access.' }]
  })
  await api.renderAudit()
  const text = textOf(detailOf(dom)[0])
  assert.ok(/宿主注入:/.test(text), '宿主注入要单列:' + text.slice(0, 160))
  assert.equal(/阿岚:/.test(text), false, '宿主的话被标成他说的了:' + text)
})

test('✓ 审计流与注入卡片真的渲染出来(不只测纯函数)', async () => {
  const { api, dom } = loadDashboard({ audit: [HER_ROW] })
  await api.loadProfile()
  await api.renderAudit()
  const text = textOf(detailOf(dom)[0])
  assert.ok(/Echo:/.test(text), '她说的那行该标「Echo:」:' + text.slice(0, 140))
  assert.equal(/阿岚:/.test(text), false, '她的话被标成他说的了 —— 就是现场那个 bug')

  // 「最近一次注入」卡片同源(他就是在这一张卡上看到的)
  const inj = loadDashboard({ audit: [{ ...HER_ROW, injectedMemories: REAL_INJECTION }] })
  await inj.api.loadProfile()
  await inj.api.renderInjection()
  const card = textOf(inj.dom.nodes.get('inj-meta'))
  assert.ok(/Echo 这一轮说:/.test(card), '卡片该说「Echo 这一轮说:」:' + card.slice(0, 180))
  assert.equal(/阿岚 这一轮说:/.test(card), false, '卡片还是把他标成她了 = 没修到')
})

test('✓ 他的轮次照旧标「阿岚:」(别为了修她的话把他的话弄坏)', async () => {
  const { api, dom } = loadDashboard({ audit: [HIS_ROW] })
  await api.loadProfile()
  await api.renderAudit()
  const text = textOf(detailOf(dom)[0])
  assert.ok(/阿岚:/.test(text), '他的话该标「阿岚:」:' + text.slice(0, 140))
  assert.ok(/占着什么位置/.test(text), '他的话本身要照旧显示')
  assert.ok(/提取器\(旁白\):/.test(text), '这一轮的旁白要标清来源(它本来就是 extract 行)')

  const inj = loadDashboard({
    audit: [{ ...HIS_ROW, injectedMemories: REAL_INJECTION }]
  })
  await inj.api.loadProfile()
  await inj.api.renderInjection()
  const card = textOf(inj.dom.nodes.get('inj-meta'))
  assert.ok(/阿岚 这一轮说:/.test(card), '他的轮次该说「阿岚 这一轮说:」:' + card.slice(0, 180))
  assert.equal(/Echo 这一轮说:/.test(card), false, '把他的话标成她的了')
})

test('✓ 2026-10-08 F3:点开一轮就冻结刷新(右栏给"继续刷新"可解除)', async () => {
  const { api, dom } = loadDashboard({ audit: [HIS_ROW] })
  await api.loadProfile()
  await api.renderAudit()
  assert.equal(api.isFrozen(), false, '一开始不该是冻结的')
  const idx = kidsOf(dom.nodes.get('au-list')).filter((c) => /(^|\s)idx(\s|$)/.test(String(c.className || '')))[0]
  assert.ok(idx !== undefined, '要有一条索引行(主从两栏的左栏)')
  idx.onclick()   // = 选中并展开这一轮
  assert.equal(api.isFrozen(), true, '点开详情就该冻结(不再被 10 秒轮询 / SSE 重建打断)')
  const detailText = textOf(dom.nodes.get('au-detail'))
  assert.ok(/已暂停刷新/.test(detailText), '右栏要说清"在暂停":' + detailText.slice(0, 140))
  const flat = kidsOf(dom.nodes.get('au-detail'))
  const deeper = flat.concat(...flat.map((n) => kidsOf(n)))
  const btn = deeper.filter((c) => c.tag === 'button' && /继续刷新/.test(String(c.textContent || '')))[0]
  assert.ok(btn !== undefined, '要给一个"继续刷新"按钮')
  btn.onclick()
  assert.equal(api.isFrozen(), false, '"继续刷新"要能解除冻结')
})

test('✓ 2026-10-08 F2:选中那一轮滑出窗口时**不换人** —— 保留缓存 + 明说已滑出窗口', async () => {
  const turnA = [
    { traceId: 'a-in', sessionId: 's', toolCall: 'relay_in', timestamp: 1000, userInput: '【QQ·私聊】阿岚说:第一条' },
    { traceId: 'a-out', sessionId: 's', toolCall: 'echo_qq_say', timestamp: 1010, userInput: '第一条的回话' }
  ]
  const turnB = [
    { traceId: 'b-in', sessionId: 's', toolCall: 'relay_in', timestamp: 2000, userInput: '【QQ·私聊】阿岚说:第二条' },
    { traceId: 'b-out', sessionId: 's', toolCall: 'echo_qq_say', timestamp: 2010, userInput: '第二条的回话' }
  ]
  const rows = turnA.concat(turnB)
  const { api, dom } = loadDashboard({ audit: rows })
  await api.loadProfile()
  await api.renderAudit()
  const idxAll = kidsOf(dom.nodes.get('au-list')).filter((c) => /(^|\s)idx(\s|$)/.test(String(c.className || '')))
  assert.equal(idxAll.length, 2, '两轮 ⇒ 两条索引(实为 ' + idxAll.length + ')')
  // ⚠️ 左栏是**新的在前**(与审计流一致)⇒ 按文字找"第一条"那条,别按位置碰运气
  const idxA = idxAll.filter((c) => /第一条/.test(textOf(c)))[0]
  assert.ok(idxA !== undefined, '要找到"第一条"那一轮的索引行')
  idxA.onclick()   // 选**第一条那一轮**
  const detailA = textOf(dom.nodes.get('au-detail'))
  assert.ok(/第一条/.test(detailA), '右栏该是第一条那轮;实为:' + detailA.slice(0, 220))
  // 让第一条那轮滑出窗口(只剩第二条)⇒ 重建
  rows.length = 0
  rows.push(...turnB)
  api.setFrozen(false)   // F3 会顺手冻结;这里要的是"重建",先解冻
  await api.renderAudit()
  const detail = textOf(dom.nodes.get('au-detail'))
  assert.ok(/已滑出窗口/.test(detail), '要明说"这一轮已滑出窗口":' + detail.slice(0, 160))
  assert.ok(/第一条/.test(detail), '缓存那一轮的内容还要在(不许被清空)')
  assert.equal(/第二条/.test(detail), false, '不许偷偷换成另一轮 —— 这就是现场那个 bug')
})

test('✓ 2026-10-08 F1′:app.js 真的走"大窗口折轮 + 展示窗口挑轮"', () => {
  const src = readFileSync(appPath, 'utf8')
  assert.ok(/lastAuditFold/.test(src), 'app.js 该留一份**大窗口**(折轮用)')
  assert.ok(/turnsForDisplay/.test(src), 'app.js 该调 audit-view.js 的 turnsForDisplay')
  assert.ok(/foldLimit/.test(src), 'app.js 该算一个更大的折轮窗口')
  assert.ok(/Math\.min\(200/.test(src), '大窗口要按 store 的硬上限封顶(200 —— lib/store.js:1110)')
  assert.ok(/contentRows\(lastAuditFold, displayLimit, CONTENT_BUCKETS\)/.test(src),
    '"对话优先"档该用 contentRows 凑内容窗口(心跳行不许占展示位)')
})

test('✓ 2026-10-08 空 bug-a:筛选滤光时**右栏也要给话**(不是空白)+ 空态里有「清筛选」', async () => {
  const { api, dom } = loadDashboard({ audit: [HER_ROW, HIS_ROW] })
  await api.loadProfile()
  await api.renderAudit()
  assert.ok(/Echo:|阿岚:/.test(textOf(dom.nodes.get('au-detail'))), '先得正常渲染出内容')
  // 用一个必不命中的检索词把轮全滤掉(与统计 chip 走的是同一条 drawAudit/筛选链)
  const qBox = dom.nodes.get('au-q')
  assert.ok(qBox !== undefined, '要有检索框(panel 的 wire(\'au-q\', drawAudit))')
  qBox.value = 'zzz-绝不命中-zzz'
  qBox.oninput()
  const detail = textOf(dom.nodes.get('au-detail'))
  assert.ok(/没有可显示的轮/.test(detail),
    '右栏必须给话 —— 以前这里是 fill(detail, []) 整块空白:' + JSON.stringify(detail.slice(0, 160)))
  const list = textOf(dom.nodes.get('au-list'))
  assert.ok(/没有可显示的轮|没有轮次/.test(list), '左栏也要给话:' + JSON.stringify(list.slice(0, 160)))
  const flat = kidsOf(dom.nodes.get('au-detail'))
  const btns = flat.concat(...flat.map((n) => kidsOf(n)))
    .filter((c) => c.tag === 'button' && /清筛选/.test(String(c.textContent || '')))
  assert.ok(btns.length > 0, '空态里要直接给「✕ 清筛选」按钮(不让他往上找统计带)')
  // 空态下点「全部收起/展开」不许炸(口径统一之后它用的是空数组)
  assert.doesNotThrow(() => dom.nodes.get('au-fold').onclick(), '空态下点「全部展开」不该抛')
  // 点「清筛选」⇒ 数据回来(顺带钉住按钮真的接上电了)
  btns[0].onclick()
  assert.ok(/Echo:|阿岚:/.test(textOf(dom.nodes.get('au-detail'))), '点「清筛选」之后数据该回来')
})

test('✓ 2026-10-08 空 bug-b:「全部展开」复用显示侧那一份轮(F1′ 之后不许再自己折旧口径)', () => {
  const src = readFileSync(appPath, 'utf8')
  assert.ok(/lastShownTurns/.test(src), 'app.js 该留一份"这一拍真正显示的轮"')
  const from = src.indexOf("const fold = $('au-fold')")
  const to = src.indexOf("if (typeof location !== 'undefined' && location.hash === ''")
  assert.ok(from > 0 && to > from, '要能切出「全部收起/展开」那段代码')
  const handler = src.slice(from, to)
  // 只看**代码**行:注释里提到旧写法是给后人看的,不该把闸自己骗红
  const code = handler.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.ok(/for \(const turn of lastShownTurns\)/.test(code),
    '「全部展开」要用 lastShownTurns 的 id(显示侧口径)')
  assert.equal(/buildTurns\(lastAudit\)/.test(code), false,
    '不许再自己折旧口径 —— F1′ 之后那批 id 与显示侧对不上,点了没反应')
  // 注:这里用源码闸而不是行为断言 —— 右栏那张卡无论如何都会"默认展开"(app.js 的
  // `if (!auditClosed.has(sel.id)) auditOpen.add(sel.id)`),所以从 DOM 上**分辨不出**
  // 展开用的 id 是新的还是旧的;能钉住口径的就是这段代码本身。
})

test('✓ 2026-10-08 降噪(行为):心跳行刷屏时,"对话优先"档仍显示对话、不显示清理行', async () => {
  const rows = []
  // 50 条会话清理(最新)+ 2 条对话(更早)—— 就是现场那副样子
  for (let i = 0; i < 50; i += 1) {
    rows.push({ traceId: 'rp' + i, sessionId: 'global', toolCall: 'session-reaper', timestamp: 5000 + i, userInput: '(会话清理)' })
  }
  rows.push({ traceId: 'tr-IN', sessionId: 's', toolCall: 'relay_in', timestamp: 1000, userInput: '【QQ·私聊】阿岚说:在吗' })
  rows.push({ traceId: 'tr-OUT', sessionId: 's', toolCall: 'echo_qq_say', timestamp: 1010, userInput: '在的' })
  const { api, dom } = loadDashboard({ audit: rows })
  await api.loadProfile()
  await api.renderAudit()
  const idxTexts = kidsOf(dom.nodes.get('au-list'))
    .filter((c) => /(^|\s)idx(\s|$)/.test(String(c.className || '')))
    .map((c) => textOf(c))
  assert.ok(idxTexts.some((t) => /在吗|在的/.test(t)), '对话优先档要看到对话:' + JSON.stringify(idxTexts).slice(0, 200))
  assert.equal(idxTexts.some((t) => /会话清理/.test(t)), false, '心跳行不许出现在对话优先档:' + JSON.stringify(idxTexts).slice(0, 200))
  // 右栏也得是那一轮对话(不是清理)
  const detail = textOf(dom.nodes.get('au-detail'))
  assert.ok(/在吗|在的/.test(detail), '右栏该是对话那一轮:' + detail.slice(0, 160))
})

test('✓ 2026-10-08 降噪(后端闸):reaper 只在**真删了东西**时写审计行', () => {
  // 为什么闸放这儿:本文件已经有 readFileSync/test/assert 这组依赖;它测的是 lib/index.js 的写入策略形状。
  const src = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const from = src.indexOf('const reaperTick =')
  const to = src.indexOf('---- 3.5b 人格漂移体检')
  assert.ok(from > 0 && to > from, '要能切出 reaperTick 那段')
  const block = src.slice(from, to)
  const writeAt = block.indexOf("toolCall: 'session-reaper'")
  assert.ok(writeAt > 0, 'reaper 仍要能写审计行(有删除时)')
  const before = block.slice(0, writeAt)
  assert.ok(/if \(res\.reaped\.length > 0\) \{/.test(before),
    '写审计前必须有一道"真删了东西"的判断 —— 否则每 10 分钟一条纯心跳把窗口挤满')
  assert.equal(/^\s*store\.writeAudit\(/m.test(block.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')),
    true, 'writeAudit 仍在(有删除时留一行摘要 + 清单路径)')
})

test('✓ 2026-10-08 autofill 兜底:第一次进审计流清掉被填的值;之后不再动他打的字', async () => {
  const { api, dom } = loadDashboard({ audit: [HER_ROW] })
  await api.loadProfile()
  const q = dom.nodes.get('au-q')
  q.value = 'https://r.dis.115.zone/v1'   // 模拟浏览器 autofill(现场那个值)
  api.showPanel('au')                     // 第一次进审计流
  await api.renderAudit()
  assert.equal(q.value, '', '第一次进审计流该把 autofill 的值清掉')
  q.value = '我自己打的字'
  api.showPanel('ov')
  api.showPanel('au')                     // 再进来
  await api.renderAudit()
  assert.equal(q.value, '我自己打的字', '第二次进来不许清他打的字(否则等于把检索吃了)')
})

test('✓ 2026-10-08 空态提示:滤光时明说可能是浏览器自动填充', () => {
  const src = readFileSync(appPath, 'utf8')
  assert.ok(/浏览器自动填充/.test(src), '空态该提一句 autofill 的可能(下次自诊更快)')
})

test('✓ 2026-10-08 竞态:首帧之后才发生的 autofill **也会被清掉**(守 3 秒)', async () => {
  // 这是当前 bug 的复现:清空时机早于 autofill ⇒ 只清一次就会漏;守备窗口把它兜住。
  const { api, dom } = loadDashboard({ audit: [HER_ROW] })
  await api.loadProfile()
  api.showPanel('au')          // 进审计流 ⇒ 起守备(3 秒 / 每 200ms)
  await api.renderAudit()
  const q = dom.nodes.get('au-q')
  assert.equal(q.value, '', '进面板那一刻先清一次')
  // 1 秒后"浏览器才填上"(模拟迟到的 autofill)
  await new Promise((r) => setTimeout(r, 1000))
  q.value = 'https://r.dis.115.zone/v1'
  await api.renderAudit()   // 守备窗内:这一拍必须把迟到 autofill 清掉(不依赖 timer)
  assert.equal(q.value, '', '迟到的 autofill 也必须被清掉(竞态兜底)')
  // 离开审计流 ⇒ 收手;再回来时他打的字不该被动
  api.showPanel('ov')
  q.value = '我自己打的字'
  api.showPanel('au')
  await api.renderAudit()
  await api.renderAudit()
  assert.equal(q.value, '我自己打的字', '守备已收手(第一次访问早结束了),他打的字不许被清')
})
