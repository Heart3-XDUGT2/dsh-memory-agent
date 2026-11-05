import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 2026-09-26 他的两批裁定:① 记忆图谱 / 悬置话题 / 对话回放 / 记忆管理 / 记忆体检 /
// 她的日记 —— 六个看板撤出设置区;② 审计流也撤,调参搬去网页仪表盘(都去 /echo/ 看)。
// `lib/client.js` 从 1652 行一路瘦到 784 行。
//
// 这类删改有一个**看不见的**失败形态:`node --check` 只查语法 —— 被删掉的名字若
// 还被谁引用着,语法照样过,直到他打开设置页,整页白屏。(同款现场教训:那天
// 人格「机制验过、文本没验」。)
//
// 所以这个电池不查语法,查**能不能渲染**:在假 window.__ModuleLoader__ 里把
// 客户端半区加载起来,把注册进 settings.section 的组件抓出来,沿元素树把每张卡
// 真调一遍。假数据 + useEffect 一律不执行 ⇒ 不碰网络、不开定时器、不写任何东西。
// 引用到已删的名字 ⇒ ReferenceError ⇒ 电池红。

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** 已撤的看板/卡片 + 只被它们用到的内部件(名字出现在源码里就是没删干净)。
 *  2026-09-28 旧桥退役:RelayCard(传话桥卡)跟着那 5 个 /api/echo/relay/* 端点
 *  一起撤 —— 它调 `POST /api/echo/relay/channel` 改单个聊天的启用/主动策略,
 *  那条路由马上就不存在了,面板不能再打它,所以这里也钉住「它不在了」。
 *  2026-09-29 他的裁定:「会话范围」卡撤出设置区。**后端一行没动** ——
 *  `/api/echo/scope` 端点、审查台那栏、会话角落的开关都还在,撤的只是设置区
 *  里那张卡(它就是嵌在 PowerCard 末尾的那个 ScopeCard)。 */
const REMOVED_CARDS = ['HealthCard', 'ThreadsCard', 'GraphCard', 'DiaryCard', 'MemoryCard',
  'ConversationCard', 'AuditCard', 'SettingsCard', 'RelayCard', 'ScopeCard']
const REMOVED_INTERNALS = ['temporalChips', 'layoutGraph', 'GRAPH_TYPE_LABELS', 'nodeEvidenceIds',
  'activationState', 'numField', 'longField', 'relayField', 'longBoolField', 'relayText']

/** 最小 React 替身:createElement 造元素;hook 给安全初值;effect 不执行。 */
function fakeReact () {
  const used = { state: 0, effect: 0 }
  return {
    createElement: (type, props, ...children) => ({
      __el: true,
      type,
      props: Object.assign({}, props === null || props === undefined ? {} : props,
        children.length > 0 ? { children } : {})
    }),
    Fragment: 'Fragment',
    useState: (init) => { used.state++; return [typeof init === 'function' ? init() : init, () => {}] },
    useEffect: () => { used.effect++ },
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useLayoutEffect: () => {},
    createContext: () => ({ Provider: 'Provider', Consumer: 'Consumer' }),
    _used: used
  }
}

/**
 * 把 lib/client.js 当浏览器模块加载(它顶层就是一句 window.__ModuleLoader__.load),
 * 返回它 factory 出来的 exports 与那个假 React。
 * 用 `new Function('window', src)`:Node 的真全局留着(卡片要用 Date/Math/String…),
 * 只注入 window 一个。document / fetch / EventSource 在 Node 里本来就不存在,
 * 模块顶层那几段都有 `typeof x` 守卫,所以安全。
 */
function loadClient () {
  const src = readFileSync(clientPath, 'utf8')
  const react = fakeReact()
  const require = (name) => {
    if (name === 'react') return react
    throw new Error('假 require 只认 react,收到:' + String(name))
  }
  let exports = null
  const fakeWindow = { __ModuleLoader__: { load: ({ id, factory }) => { exports = factory(require) } } }
  const factory = new Function('window', src)
  factory(fakeWindow)
  if (exports === null || typeof exports.apply !== 'function') throw new Error('没拿到客户端半区的 exports.apply')
  return { exports, react }
}

/** 跑一遍 apply(ctx),把注册进 settings.section 的组件拿回来。
 *  v0.30.0:插件现在注册**两个**插槽(设置区 + 会话页角落开关),
 *  所以假插槽要按插槽名收集 —— 只记「最后一次注册」会被后一个覆盖,
 *  测试就会拿角落开关去当设置区渲染(那是台架的错,不是产品的错)。 */
function loadEchoSection () {
  const { exports, react } = loadClient()
  const registered = new Map()
  // 2026-10-01 尾:同一个插槽现在可能有多枚(会话头部那一排:会话开关 90、
  // 设为 QQ 常驻 91)⇒ 除了「最后一次覆盖」的 Map,再留一份**全部注册调用**的
  // 流水 —— 否则断言会被"后注册的把它盖掉"骗过(那不是产品的错,是台架的错)。
  const calls = []
  const slots = {
    inject: (channel, fn) => { fn() },
    register: (desc, comp) => { registered.set(desc.name, { desc, comp }); calls.push({ desc, comp }); return comp }
  }
  // 2026-10-01 尾:预设选择器走 `ctx.inject(["remote.agentPresets"], …)` 这条**软**
  // 注入(等不到那个服务就不挂那一枚,绝不写进 exports.inject)⇒ 假 ctx 也要给
  // 这条入口,否则新 UI 在台架上根本不注册,测试就成了摆设。
  const scope = { slots, effect: (fn) => { fn() }, remote: {} }
  exports.apply({
    get: (name) => (name === 'slots' ? slots : undefined),
    effect: (fn) => { fn() },
    inject: (names, fn) => { fn(scope) }
  })
  const hit = registered.get('settings.section')
  if (hit === undefined) throw new Error('没注册上 settings.section')
  return { section: hit.comp, desc: hit.desc, react, registered, calls }
}

/** 沿元素树把每个函数组件真调一遍,返回见过的组件名(渲染崩了就把名字带进错误)。 */
function renderTree (node, seen = []) {
  if (node === null || node === undefined || typeof node !== 'object') return seen
  if (Array.isArray(node)) {
    for (const child of node) renderTree(child, seen)
    return seen
  }
  if (node.__el !== true) return seen
  if (typeof node.type === 'function') {
    const name = node.type.name || '(匿名卡片)'
    seen.push(name)
    let out
    try {
      out = node.type(node.props)
    } catch (err) {
      err.message = '卡片 ' + name + ' 渲染崩了 —— ' + err.message
      throw err
    }
    renderTree(out, seen)
    return seen
  }
  renderTree(node.props === undefined ? null : node.props.children, seen)
  return seen
}

/** 设置区现在的样子(2026-09-26 两批裁定 + 2026-09-29 撤范围卡之后),
 *  顺序 = 他看到的堆叠顺序。假数据下都是「加载中」分支,所以嵌套卡片
 *  (如 DashboardCard 内部的子件)不在这一层 —— 这是确定的、可钉的。
 *  2026-10-01 阶段 2f:**多了一张 MemoryToolsCard**(他的裁定:「`memorySubagentTools`
 *  的 true/false 应当也能在网页仪表盘里改才对」)⇒ 这张卡是**有意加的**,不是漂移,
 *  所以期望表跟着改;它紧跟电源卡(两个都是"拨一下变行为"的开关)。
 *  2026-10-01 阶段 4:**再多一张 GraphGateCard**(同一条裁定换到"运行时自动挖边"那个
 *  开关上:"能在网页仪表盘拨、拨了立即生效")⇒ 同样有意加,紧跟隔壁那张开关卡。 */
const EXPECTED_CARDS = ['ConsoleCard', 'PowerCard', 'MemoryToolsCard', 'GraphGateCard', 'DashboardCard',
  'LongingCard', 'EmotionCard', 'PersonaCard', 'DangerZone']

test('✓ 设置区整个渲染得完(假 React)⇒ 没有引用到已删的名字,卡片就剩这几张', () => {
  const { section, react } = loadEchoSection()
  const seen = renderTree(section({}))
  assert.deepEqual(seen, EXPECTED_CARDS, '面板上的卡片变了(多了/少了/换序了)')
  assert.ok(react._used.state > 0, '一张卡都没用到 useState?八成没真渲染')
})

test('✓ 注册信息没动:还是 settings.section / id=echo / label=Echo', () => {
  const { desc } = loadEchoSection()
  assert.equal(desc.name, 'settings.section')
  assert.equal(desc.id, 'echo')
  assert.equal(desc.label(), 'Echo')
})

test('✓ 他撤掉的卡片不在树里(撤的是看板,DashboardCard 这类状态卡还在)', () => {
  const { section } = loadEchoSection()
  const seen = renderTree(section({}))
  for (const gone of REMOVED_CARDS) {
    assert.equal(seen.includes(gone), false, gone + ' 应该已经撤出设置区')
  }
  // 调参搬去了网页 —— 它的字段表也不该在客户端半区留下影子
  assert.equal(readFileSync(clientPath, 'utf8').includes('injectTopK'), false,
    '调参字段还留在 client.js 里?字段表只许在 lib/settings-fields.js')
})

test('✓ 危险区(整库清空)没跟着记忆管理卡一起消失 —— 它是动作,不是看板', () => {
  const { section } = loadEchoSection()
  const seen = renderTree(section({}))
  assert.ok(seen.includes('DangerZone'), '危险区该留成独立一张卡:' + seen.join('、'))
})

test('✓ 撤掉的卡片代码块真删了(不是只从组合里摘掉),函数与内部件都不在源码里', () => {
  const src = readFileSync(clientPath, 'utf8')
  for (const gone of [...REMOVED_CARDS, ...REMOVED_INTERNALS]) {
    assert.equal(new RegExp('\\b' + gone + '\\b').test(src), false, gone + ' 的代码应该已经删掉')
  }
  // 旧桥退役(2026-09-28):传话桥卡是这 5 个端点的唯一面板消费者 ——
  // `/api/echo/relay/*` 正在完整退役,客户端半区一个都不许再打。
  assert.equal(/\/api\/echo\/relay\//.test(src), false,
    '客户端半区还在打 /api/echo/relay/* —— 那批端点马上就不存在了')
})

/** 在假元素树里按 type 找第一个元素(找不到 ⇒ null)。 */
function findByType (node, type) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByType(child, type)
      if (hit !== null) return hit
    }
    return null
  }
  if (node.__el !== true) return null
  if (node.type === type) return node
  return findByType(node.props === undefined ? null : node.props.children, type)
}

test('✓ v0.44.0:本会话预设选择器挂在会话头部 actions,用自己的 id(不占宿主那枚只读标签)', () => {
  const { registered, calls } = loadEchoSection()
  const pick = registered.get('conversation.session.header.actions')
  assert.ok(pick !== undefined, '预设选择器没注册上(检查 ctx.inject(["remote.agentPresets"]) 那条路)')
  assert.equal(pick.desc.id, 'echo-preset-picker')
  assert.notEqual(pick.desc.id, 'agent-preset', '不许复用宿主的 id —— 那会把它那枚只读标签顶掉')
  assert.equal(pick.desc.order, 10)
  assert.ok(calls.some((c) => c.desc.name === 'conversation.session.header.utilities' && c.desc.id === 'echo-qq-pin'),
    '「设为 QQ 常驻」按钮没注册进会话头部那一排')
})

test('✓ v0.44.0:预设选择器——空白会话可点;开聊后置灰并写明"宿主锁定"', () => {
  const { registered } = loadEchoSection()
  const Picker = registered.get('conversation.session.header.actions').comp
  // 拿不到宿主那份 useSessions ⇒ 什么都不画(早返回,不能条件调用 hook)
  assert.equal(Picker({ useSessions: undefined }), null)
  const makeProps = (blank) => ({
    sessionId: 'session-x',
    useSessions: (sel) => sel({ byId: { 'session-x': { projectionValues: { agentPreset: 'echo' }, blank } } }),
    loadPresets: () => Promise.resolve({ ok: true, value: { presets: [{ id: 'echo', name: 'Echo' }] } }),
    selectPreset: () => Promise.resolve({ ok: true })
  })
  const lockedEl = Picker(makeProps(false))
  const lockedInner = lockedEl.type(lockedEl.props)
  // 提示语挂在外层小格子(title 在真浏览器里是 hover 提示),下拉本身只管禁用
  assert.match(String(lockedInner.props.title), /宿主锁定/)
  const lockedSel = findByType(lockedInner, 'select')
  assert.ok(lockedSel !== null, '没渲染出预设下拉')
  assert.equal(lockedSel.props.disabled, true, '已开聊的会话必须置灰(宿主会拒 agent-preset/locked)')

  const openEl = Picker(makeProps(true))
  const openSel = findByType(openEl.type(openEl.props), 'select')
  assert.equal(openSel.props.disabled, false, '空白会话应当可点')
})

test('✓ v0.30.0:会话角落开关单独占一个插槽,不混进设置区', () => {
  const { section, calls } = loadEchoSection()
  const utils = calls.filter((c) => c.desc.name === 'conversation.session.header.utilities')
  const toggle = utils.find((c) => c.desc.id === 'echo-session-toggle')
  assert.ok(toggle !== undefined, '会话页角落开关没注册上')
  assert.equal(toggle.desc.order, 90)
  // 2026-10-01 尾:这一排**有意**多了一枚「设为 QQ 常驻」(order 91)——
  // list 槽允许并存,开关本身不许被它挤掉(上面就是按 id 找的那一枚)。
  assert.ok(utils.find((c) => c.desc.id === 'echo-qq-pin') !== undefined,
    '「设为 QQ 常驻」应该也在这一排(order 91)')
  // 它是会话页头部的一枚小按钮 —— 不许出现在设置区的卡树里
  const seen = renderTree(section({}))
  assert.equal(seen.includes('SessionToggleButton'), false,
    '角落开关混进设置区了(它是会话页头部的席位,不是设置卡)')
})
