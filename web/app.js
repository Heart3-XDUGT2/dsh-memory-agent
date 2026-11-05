/* Echo 审查台 — 活数据仪表盘(v0.12.0)
 * ============================================================
 * AstrBot 审查仪表盘同款视觉语言的活数据版:九段面板全部由
 * /api/echo/* 喂养,10s 轮询 + SSE 审计推送即时刷新。
 * 队友可直接以本文件为起跑底稿,或整个替换 —— 渲染纪律:
 * 全部 textContent,不拼 innerHTML(参考实现不留 XSS 坏习惯)。
 * 所有端点形状已对着活服务核过(docs/API.md 是契约)。
 */
'use strict'

// ---- DOM 小工具 ----
const $ = (id) => document.getElementById(id)
function el (tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined && text !== null) n.textContent = String(text)
  return n
}
function clear (node) { while (node.firstChild) node.removeChild(node.firstChild) }
function fill (node, children) { clear(node); for (const c of children) node.appendChild(c) }
async function api (path) {
  const res = await fetch(path)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}
async function apiPost (path, body) {
  const res = await fetch(path, {
    method: 'POST',
    // x-echo-edit 是宿主侧的写保护(循环 Origin + 自定义头,见 docs/API.md)。
    // 2026-09-26 现场发现:这里原先**漏了这个头**,于是网页仪表盘的写按钮
    // (如「清空上下文」)全被 403 挡掉 —— 而设置区那半区是带的,所以只坑网页。
    headers: { 'content-type': 'application/json', 'x-echo-edit': '1' },
    body: JSON.stringify(body || {})
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}
/** PUT 版(配置中心 §6.3 的写路:`PUT /api/echo/data/<file>.json`)。 */
async function apiPut (path, body) {
  const res = await fetch(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-echo-edit': '1' },
    body: JSON.stringify(body || {})
  })
  if (!res.ok) {
    // 400 的校验明细要能内联显示 ⇒ 把回包带在错误上(视图侧读 err.payload.errors)
    let payload = null
    try { payload = await res.json() } catch { /* 回包不是 JSON 也不能把错误吞掉 */ }
    const err = new Error('HTTP ' + res.status)
    err.status = res.status
    err.payload = payload
    throw err
  }
  return res.json()
}

// ---- 配置中心(P2 §3):页面视图的取数通道(view 里**不许**出现 fetch)----
// 视图文件(web/views/*.js)先把自己的 `EchoViews['<id>']` 挂到 globalThis,再由
// PANELS 里的 draw 走这里取出来画。契约见 docs/CONFIG_CENTER_CONTRACT.md §3/§3.1。
function drawView (id) {
  const el = $(id)
  const box = globalThis.EchoViews
  const view = (box === undefined || box === null) ? undefined : box[id]
  if (el === null || view === undefined || view === null || typeof view.draw !== 'function') {
    return Promise.resolve(null)   // 视图文件没加载:静默跳过,别把整页拖崩
  }
  return Promise.resolve().then(() => view.draw(el, VIEW_API))
}

const VIEW_API = {  get: (path) => api(path),
  put: (path, body) => apiPut(path, body),
  post: (path, body) => apiPost(path, body),
  profile: () => P(),
  reload: () => drawView(currentPanel),
  toast: (text, kind) => toast(text, kind)
}

/** ① 上手引导条(P2 §6.2):**不是一页**(没有导航项/hash 路由,也不进 PANELS),
 *  是页顶的常驻横幅 —— 数据没配好才红着,配好了自己消失。只读 `GET /api/echo/setup`。 */
function drawSetupBanner () {
  const el = $('setup-banner')
  if (el === null) return Promise.resolve(null)
  const box = globalThis.EchoViews
  const v = (box === undefined || box === null) ? undefined : box['setup-banner']
  if (v === undefined || v === null || typeof v.draw !== 'function') return Promise.resolve(null)
  return Promise.resolve().then(() => v.draw(el, VIEW_API)).catch(() => { el.hidden = true })
}

// 保存反馈:顶部那一行(文案表见契约 §4;6 秒后自己消失)
let toastTimer = null
function toast (text, kind) {
  const n = $('tb-toast')
  if (n === null) return false
  n.textContent = String(text === null || text === undefined ? '' : text)
  n.style.color = kind === 'err' ? '#d33' : '#2a7'
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { n.textContent = ''; n.style.color = '' }, 6000)
  return true
}

// ---- 🏷️ 称呼:从 API 拿,不写死在页面里 ----
// 数据与程序分离 P1d(2026-10-05):这一页原来把「〈他的称呼〉/ Echo / 别名」写死在代码里
// (昵称正则、说话人标签、情绪面板的「对XX」、索引前缀)。现在**只认**
// `GET /api/echo/profile` 发下来的那几个字段:
//   { userName, userAliases, agentName, agentSelfRef, locale, timezone }
// 取**一次**就缓存(10 秒轮询不会再来打它);端点在就用它;端点没就绪
// (404 / 网络失败 / 超时)就退到下面这份**中性兜底** —— 不许把真名写回代码。
const NEUTRAL_PROFILE = {
  userName: '用户', userAliases: [], agentName: '助手', agentSelfRef: '助手',
  // P2 §6.2 ④(2026-10-05):这两项原来写死在代码里(「对XX」的「对」、拿不到名字时的
  // 「用户」)—— 现在从 profile.json 来;空 = 就用这里的默认(中性词,不许是真名)。
  uiIndexPrefix: '', fallbackAddress: '用户',
  locale: 'zh-CN', timezone: 'Asia/Shanghai'
}
// fetch 自己没有超时 —— 端点挂着不该把称呼一直吊着,超时按失败处理(降级)。
const PROFILE_TIMEOUT_MS = 5000
let profile = NEUTRAL_PROFILE
let profileOnce = null

/** 取一个名字字段:空的/类型不对 ⇒ 用兜底(端点可能缺字段,也可能整块是 null)。 */
function nameOr (v, fallback) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback
}

/** 把端点读数收成面板用的形状 —— 缺什么补什么,永远返回一个能用的对象。 */
function normalizeProfile (data) {
  const d = (data !== null && typeof data === 'object') ? data : {}
  const aliases = Array.isArray(d.userAliases)
    ? d.userAliases
      .map((a) => String(a === null || a === undefined ? '' : a).trim())
      .filter((a) => a !== '')
    : []
  return {
    userName: nameOr(d.userName, NEUTRAL_PROFILE.userName),
    userAliases: aliases,
    agentName: nameOr(d.agentName, NEUTRAL_PROFILE.agentName),
    agentSelfRef: nameOr(d.agentSelfRef, NEUTRAL_PROFILE.agentSelfRef),
    // 空的索引前缀是合法语义(用默认「对」),所以这里**不补默认值** —— 由用它的地方 `|| '对'`
    uiIndexPrefix: typeof d.uiIndexPrefix === 'string' ? d.uiIndexPrefix.trim() : '',
    fallbackAddress: nameOr(d.fallbackAddress, NEUTRAL_PROFILE.fallbackAddress),
    locale: nameOr(d.locale, NEUTRAL_PROFILE.locale),
    timezone: nameOr(d.timezone, NEUTRAL_PROFILE.timezone)
  }
}

/** 名字变了没有(只有真变了才值得把眼前那屏重画一遍)。 */
function profileKey (p) {
  return p.userName + '\u0000' + p.agentName + '\u0000' + p.userAliases.join('\u0000') +
    '\u0000' + p.uiIndexPrefix + '\u0000' + p.fallbackAddress
}

/** 取一次 profile(带超时)。超时也当失败 —— 与 404 / 网络失败同一条降级路。 */
function profileRequest () {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('profile timeout')), PROFILE_TIMEOUT_MS)
    api('/api/echo/profile').then(
      (data) => { clearTimeout(timer); resolve(data) },
      (err) => { clearTimeout(timer); reject(err) }
    )
  })
}

/** 一次取回 + 缓存:**进页面只打一次**(别每帧打请求)。永不 reject。 */
function loadProfile () {
  if (profileOnce !== null) return profileOnce
  profileOnce = profileRequest()
    .then((data) => {
      const next = normalizeProfile(data)
      const changed = profileKey(next) !== profileKey(profile)
      profile = next
      applyProfile(changed)
      return profile
    })
    .catch(() => {
      // 端点没就绪时用中性兜底('用户' / '助手'):页面照常画,只是标签是中性词
      profile = NEUTRAL_PROFILE
      applyProfile(false)
      return profile
    })
  return profileOnce
}

/** 此刻的称呼(缓存那份)—— 面板上的标签**只走这一个来源**,不留第二份真名。 */
function P () { return profile }

/** 他的称呼集合(userName + userAliases,去重去空)—— 剥信封前缀、认"他的话"都用它。 */
function masterNames () {
  const out = [P().userName].concat(P().userAliases).filter((n) => n !== '')
  const uniq = out.filter((n, i) => out.indexOf(n) === i)
  // 中性兜底:别名空的时候宁可只认那份中性名字,也不许回落到内置真名
  // (P2 ④:兜底词本身也来自数据 —— `fallbackAddress`,空则用中性「用户」)
  return uniq.length > 0 ? uniq : [nameOr(P().fallbackAddress, NEUTRAL_PROFILE.fallbackAddress)]
}

/** 正则转义(名字里可能有 `.` `+` 这类字符,直接拼进正则会变味)。 */
function reEsc (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

let speakerRe = null
let speakerReKey = ''
/** 「〈他的称呼〉说:」那条前缀正则 —— **从 profile 的别名拼**(取到一次就缓存)。 */
function speakerReOf () {
  const key = masterNames().join('\u0000')
  if (speakerRe === null || speakerReKey !== key) {
    speakerRe = new RegExp('^(?:' + masterNames().map(reEsc).join('|') + ')说[:：]\\s*')
    speakerReKey = key
  }
  return speakerRe
}

/** 称呼到货后:推给"看法"层(audit-view 的主语标签也吃这一份)+ 抹到静态文案上;
 *  名字真变了才把眼前那屏重画一遍(端点没就绪时 changed=false,一次都不多画)。 */
function applyProfile (changed) {
  const v = globalThis.EchoAuditView
  if (v !== undefined && v !== null && typeof v.setProfile === 'function') v.setProfile(P())
  paintHintNames()
  if (changed) {
    const p = PANELS.filter((x) => x.id === currentPanel)[0]
    if (p !== undefined && typeof p.draw === 'function') p.draw().catch(() => {})
  }
}

/** index.html 里带称呼的静态文案(审计流那段的说明)—— 名字**只在 JS 里填**,
 *  壳里先放中性词:端点没就绪时页面也不会先蹦出真名。 */
function paintHintNames () {
  const u = $('au-hint-user'); if (u) u.textContent = P().userName
  const a = $('au-hint-agent'); if (a) a.textContent = P().agentName
}

function fmtTime (ts) { return ts > 0 ? new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }) : '—' }
function fmtClock (ts) { return ts > 0 ? new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false }) : '—' }
function fmtDur (sec) {
  if (!(sec > 0)) return '—'
  const h = sec / 3600
  if (h < 1) return Math.max(1, Math.round(sec / 60)) + ' 分钟'
  if (h < 48) return (Math.round(h * 10) / 10) + ' 小时'
  return Math.round(h / 24) + ' 天'
}
function clip (s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s }
function vecColor (v) { return v > 6 ? '#ef4444' : v > 3 ? '#f59e0b' : '#22c55e' }
function statCard (num, label, small) {
  const c = el('div', 'sc')
  const n = el('div', 'sn', num)
  if (small) n.appendChild(el('small', null, small))
  c.appendChild(n); c.appendChild(el('div', 'sl', label))
  return c
}
function engineLabel (eng) {
  if (!eng || !eng.mode) return '未知'
  if (eng.mode === 'python') {
    const s = eng.sidecar || {}
    const py = eng.python || {}
    return 'Python 全引擎' + (s.version ? '(worker v' + s.version + ')' : '') +
      (py.major ? '(py ' + py.major + '.' + (py.minor ?? '') + ')' : '')
  }
  if (eng.mode === 'baseline') return 'JS 基线'
  return '离线'
}

/**
 * Step C:向量臂那一行。
 *
 * 数据来自 **worker 主动上报的状态文件**(见 `lib/index.js` 的 `readEmbedState`),
 * 不是现场问引擎要的 —— 所以它**可能是旧读数**:worker 死了文件还在。
 * 因此这里一定带时间,而且超过 `EMBED_STALE_MS` 就明说"读数停在…",
 * 不假装它还活着。这是"写文件上报"方案的已知代价,显示上必须交代。
 */
const EMBED_STALE_MS = 10 * 60 * 1000
function embedLine (em, nowMs) {
  if (!em) return '向量臂:没装或没跑(没有状态文件)'
  const parts = []
  const off = em.source === 'off'
  const warming = em.reason === '预热中'
  if (em.warmed === true) parts.push('已预热')
  else if (warming) parts.push('预热中…')
  else if (off) parts.push('关着(开关默认关)')
  else parts.push('未预热')
  if (em.ms !== null && em.ms !== undefined) parts.push('预热 ' + Math.round(em.ms) + 'ms')
  if (em.rssMb !== null && em.rssMb !== undefined) parts.push('占用 ' + em.rssMb.toFixed(1) + 'MB')
  if (em.at) {
    const age = nowMs - em.at * 1000
    const t = new Date(em.at * 1000).toLocaleTimeString()
    parts.push(age > EMBED_STALE_MS ? '读数停在 ' + t + '(已过期)' : '更新于 ' + t)
  }
  // 失败原因只在"真试过但没成"时贴出来 —— 关着/预热中不是失败,别当成失败读
  if (em.reason && em.warmed !== true && !warming && !off) parts.push(em.reason)
  return '向量臂:' + parts.join(' · ')
}
const TOOL_LABELS = {
  session_on: '上线标记', session_off: '下线标记', care: '关怀', reflect: '反思',
  memory_add: '记忆', memory_edit: '记忆编辑', memory_state: '记忆状态',
  diary: '日记', persona: '人格', toggle: '电源', scope: '范围'
}

/**
 * 审查台 2.0(2026-09-26):**一张表管导航**。
 *
 * 前版是 11 段平铺在一条窄栏里 + 顶部 11 个 emoji 链接:宽屏一半空着,
 * 想看记忆得先滚过四段,而且每段都在 10 秒轮询里重画。现在:
 * 左栏分区,点一段只显示一段(hash 驱动,#/mm),切过去先拉一次。
 *
 * 加减一段 = 在这里改一行(panel 的 id 与 index.html 里的 section id 同源,
 * 契约由 tests/web-dashboard.test.js 钉着)。
 */
const PANELS = [
  { id: 'ov', nav: 'nav-ov', group: '实时', title: '总览', sub: '她现在什么样,一眼看全', draw: renderOverview },
  { id: 'lg', nav: 'nav-lg', group: '实时', title: '想念', sub: '幂律增长,消息脉冲削减,关怀后减半重积', draw: renderLonging },
  { id: 'em', nav: 'nav-em', group: '实时', title: '情绪向量', sub: '三组向量 + 强度 + 当时的话题', draw: renderEmotion },
  // 2026-10-05 G5/G6:情绪空间页(先出数据;圆盘 / 立方体随后两步加在同一页里)
  { id: 'emotion-space', nav: 'nav-emotion-space', group: '实时', title: '情绪空间', sub: '联合空间读数 + 门禁;IPC 圆盘 + PAD 立方体(只读,写状态通路已砍)', draw: () => drawView('emotion-space') },
  { id: 'au', nav: 'nav-au', group: '实时', title: '审计流', sub: '一轮一行:进 → 她说的 → 提取器;点开看那一轮实际注入了什么', draw: renderAudit },
  { id: 'inj', nav: 'nav-inj', group: '实时', title: '注入透视', sub: '她这一轮到底读到了什么,逐段拆开', draw: renderInjection },
  { id: 'mm', nav: 'nav-mm', group: '记忆', title: '体检与记忆', sub: 'DMAE 三态 + 最近落库的记忆', draw: renderMemory },
  { id: 'th', nav: 'nav-th', group: '记忆', title: '悬置话题', sub: '她惦记着、还没结掉的事', draw: renderThreads },
  { id: 'gr', nav: 'nav-gr', group: '记忆', title: '图谱', sub: '记忆之间的连线', draw: renderGraph },
  { id: 'di', nav: 'nav-di', group: '记忆', title: '她的日记', sub: '每晚 22:30 一页,写给自己', draw: renderDiary },
  { id: 'cv', nav: 'nav-cv', group: '对话与系统', title: '对话回放', sub: '全局滚动 100 轮', draw: renderConversations },
  { id: 'sc', nav: 'nav-sc', group: '对话与系统', title: '会话范围', sub: '总闸 × 分闸,以及清空她的上下文', draw: renderScope },
  { id: 'cfg', nav: 'nav-cfg', group: '对话与系统', title: '调参', sub: '改完下一轮对话生效;另有「子代理记忆工具」开关,拨了立即生效', draw: renderSettings },
  // ---- 配置中心(P2 §6.2):真源是数据文件,页面只走 /api/echo/** ----
  { id: 'persona', nav: 'nav-persona', group: '配置', title: '人格', sub: '她的前缀 / 后缀 —— 保存后下一轮生效', draw: () => drawView('persona') },
  { id: 'profile', nav: 'nav-profile', group: '配置', title: '用户画像', sub: '你叫什么、她叫什么 —— 显示层与识别层分开填', draw: () => drawView('profile') },
  { id: 'naming', nav: 'nav-naming', group: '配置', title: '称呼与显示', sub: '昵称正则 / 索引前缀 / 兜底称呼 —— 只写 profile.json', draw: () => drawView('naming') },
  { id: 'aliases', nav: 'nav-aliases', group: '配置', title: '别名与人名', sub: '别名 → 正名的归一;tier 表示确定性等级', draw: () => drawView('aliases') },
  { id: 'tuning', nav: 'nav-tuning', group: '配置', title: '图论与显示', sub: '打分权重 / 阈值 / 窗口 / 关系表 / 图谱显示 —— 存 graph.json', draw: () => drawView('tuning') },
  { id: 'state-lexicon', nav: 'nav-state-lexicon', group: '配置', title: '状态与词库', sub: '状态初值兜底 + 程序不再内置的那部分词(同义词/时间词/禁词/停用词)', draw: () => drawView('state-lexicon') },
  { id: 'data-health', nav: 'nav-data-health', group: '配置', title: '数据体检', sub: '缺 / 空 / 坏 + 备份清单(只列不删)', draw: () => drawView('data-health') }
]

let currentPanel = 'ov'
let frozen = false

/**
 * G9(2026-10-05):「调参」页副标题里的项数**现算**,不再写死。
 *
 * 这个数字撒谎过三次(51 → 71 → 109):字段表的唯一来源是 `lib/settings-fields.js`,
 * 它由 `GET /api/echo/settings` 的 `fields` 发下来 ⇒ 面板手里就是真表,数一遍即可。
 * 拉不到(离线 / 端点坏)⇒ **不显示数字**(宁可不说,不说错 —— 猜一个数就是第三次撒谎)。
 * @param {unknown} fields `/api/echo/settings` 回包的 `fields`(分组数组)
 * @returns {number|null} 项数;拿不到 ⇒ null
 */
function countSettingsFields (fields) {
  if (!Array.isArray(fields)) return null
  let n = 0
  for (const g of fields) n += Array.isArray(g && g.fields) ? g.fields.length : 0
  return n > 0 ? n : null
}

/** 把现算的项数写回「调参」副标题(顺手修正正显示着的那一行,不用切页)。 */
function syncCfgSub (n) {
  const p = PANELS.find((x) => x.id === 'cfg')
  if (p === undefined) return
  p.sub = (typeof n === 'number' && n > 0)
    ? n + ' 项字段,改完下一轮对话生效;另有「子代理记忆工具」开关,拨了立即生效'
    : '改完下一轮对话生效;另有「子代理记忆工具」开关,拨了立即生效'
  const s = $('tb-panel-sub')
  if (s && currentPanel === 'cfg') s.textContent = p.sub
}

/** 当前面板(测试与"刷新"按钮用)。 */
function panelNow () { return currentPanel }

/** 切面板:只显示一段 + 左栏高亮 + 顶部标题。
 *  2026-09-27:这里**同时**写 hidden 与 .on —— 上一版只写 hidden,而当时
 *  的 CSS 只认 .panel.on,两边对不上 ⇒ 每个面板都 display:none,整页空白。
 *  现在 CSS 侧有 `[hidden]{display:none!important}` 兜底、`.panel` 默认
 *  display:block,双写只是让"谁该显示"这件事在两处都成立,任一侧写错都不白屏。 */
function showPanel (id) {
  const p = PANELS.find((x) => x.id === id) || PANELS[0]
  for (const q of PANELS) {
    const sec = $(q.id)
    if (sec) {
      sec.hidden = q.id !== p.id
      sec.className = 'panel' + (q.id === p.id ? ' on' : '')
    }
    const link = $(q.nav)
    if (link) link.className = 'navlink' + (q.id === p.id ? ' on' : '')
  }
  // ★ 2026-10-08:离开审计流 ⇒ 立刻撤掉检索框的守备(时间窗不带去别的面板)
  if (currentPanel === 'au' && p.id !== 'au' && typeof auditQueryGuardStop === 'function') { try { auditQueryGuardStop() } catch { } }
  currentPanel = p.id
  const t = $('tb-title'); if (t) t.textContent = p.title
  const s = $('tb-panel-sub'); if (s) s.textContent = p.sub
  // 切过去先画一次,不等下一拍轮询(但调参那段仍然只画一次:见 renderSettings)
  if (typeof p.draw === 'function') Promise.resolve().then(() => p.draw()).catch(() => {})
}

/** hash → 面板 id(旧锚点 #mm 与新的 #/mm 等价:id 就是锚点)。 */
function panelFromHash () {
  const raw = (typeof location !== 'undefined' && location.hash) ? String(location.hash) : ''
  const id = raw.replace(/^#\/?/, '')
  return PANELS.some((p) => p.id === id) ? id : ''
}

/** 冻结 = 停掉 10s 轮询(读长文时不被重画);手动「刷新」与切分区照旧拉。 */
function setFrozen (v) {
  frozen = v === true
  const box = $('tb-freeze'); if (box) box.checked = frozen
  const up = $('tb-updated'); if (up && frozen) up.textContent = '已冻结'
  return frozen
}
function isFrozen () { return frozen }

/** 工具条接线(检索框 / 刷新 / 冻结 / 快捷键 / hash 路由)。 */
function initShell () {
  const ref = $('tb-refresh')
  if (ref) ref.onclick = () => { refreshAll().catch(() => {}) }
  // ① 引导条:进页面先看一眼(不等第一拍轮询)
  drawSetupBanner().catch(() => {})
  const fr = $('tb-freeze')
  if (fr) fr.onchange = () => setFrozen(fr.checked === true)

  // 检索:过滤的是**已经拿到的行**(不重新打请求),所以每个列表自己留一份
  const wire = (id, redraw) => { const n = $(id); if (n) n.oninput = () => redraw() }
  wire('au-q', drawAudit)
  wire('cv-q', drawCv)
  wire('mm-q', drawMemTable)
  wire('di-q', drawDiary)
  wire('cfg-q', filterSettings)
  // 全部收起 / 全部展开:右栏那些重文本小节(注入全文 / 情绪包 / 向量 / 原始行…)
  // 默认全收起,一键铺开审查用。2026-09-29 第三轮:他说"能读了但太冗杂",所以要
  // **默认收、一键开**,而不是默认全铺着。
  const fold = $('au-fold')
  if (fold) {
    fold.onclick = () => {
      const anyOpen = auSectionsOpen || auditOpen.size > 0
      if (anyOpen) {
        auSectionsOpen = false
        auditOpen.clear()
        auditClosed.clear()
        if (typeof injOpen !== 'undefined' && injOpen.clear) injOpen.clear()
        fold.textContent = '全部展开'
      } else {
        auSectionsOpen = true
        auditClosed.clear()
        // ★ 2026-10-08(空 bug-b):用**显示侧那一份**轮(含筛选),别再自己折 —— 口径一处,
        // 谁都不会再漂;上一版这里用 `buildTurns(lastAudit)`(旧口径)⇒ F1′ 之后 id 对不上,
        // 「全部展开」点了没反应。
        for (const turn of lastShownTurns) auditOpen.add(turn.id)
        fold.textContent = '全部收起'
      }
      drawAudit()
    }
  }

  if (typeof location !== 'undefined' && location.hash === '' && typeof history !== 'undefined') {
    try { history.replaceState(null, '', '#/' + currentPanel) } catch (e) { /* 无所谓 */ }
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('hashchange', () => { const id = panelFromHash(); if (id !== '') showPanel(id) })
  }
  // 快捷键:/ 聚焦本段检索框,1~9 切段,Esc 让出焦点
  if (document.addEventListener) {
    document.addEventListener('keydown', (ev) => {
      const tag = String((ev.target && ev.target.tagName) || '').toLowerCase()
      const typing = tag === 'input' || tag === 'textarea'
      if (ev.key === '/' && !typing) {
        const q = $(currentPanel === 'au' ? 'au-q'
          : currentPanel === 'cv' ? 'cv-q'
            : currentPanel === 'mm' ? 'mm-q'
              : currentPanel === 'di' ? 'di-q'
                : currentPanel === 'cfg' ? 'cfg-q' : '')
        if (q) { ev.preventDefault(); q.focus() }
        return
      }
      if (typing) { if (ev.key === 'Escape' && ev.target.blur) ev.target.blur(); return }
      const n = Number(ev.key)
      if (n >= 1 && n <= PANELS.length) showPanel(PANELS[n - 1].id)
    })
  }
}

/** 检索词(小写、去空白);没填就是"全都要"。 */
function qOf (id) { const n = $(id); return n === null || n === undefined ? '' : String(n.value || '').trim().toLowerCase() }
function hit (q, ...fields) {
  if (q === '') return true
  for (const f of fields) if (String(f === undefined || f === null ? '' : f).toLowerCase().includes(q)) return true
  return false
}


// ---- 📊 总览 ----
async function renderOverview () {
  const box = $('ov-grid'); const info = $('ov-info')
  const [stR, lgR, cvR] = await Promise.allSettled([
    api('/api/echo/status'), api('/api/echo/longing'), api('/api/echo/conversations?limit=100')
  ])
  const st = stR.status === 'fulfilled' ? stR.value : null
  if (st === null) { fill(box, [el('div', 'loading', '状态拉取失败')]); return }
  const mem = st.memory || {}
  const lg = lgR.status === 'fulfilled' && lgR.value && lgR.value.rows ? lgR.value.rows[0] : null
  const cvCount = cvR.status === 'fulfilled' && cvR.value && Array.isArray(cvR.value.rows) ? cvR.value.rows.length : null
  const cards = []
  if (lg) cards.push(statCard(lg.value.toFixed(2), '想念值(阈值 ' + lg.threshold + ')'))
  cards.push(statCard((mem.episodicActive ?? 0) + '/' + (mem.episodicTotal ?? 0), '情景记忆 现役/总计'))
  cards.push(statCard((mem.graphNodes ?? 0) + '+' + (mem.graphEdges ?? 0), '图谱 节点+边'))
  cards.push(statCard((mem.moodIntensity ?? 0) + '/10', '她的心情强度'))
  if (cvCount !== null) cards.push(statCard(cvCount, '对话窗(滚动100轮)'))
  cards.push(statCard(mem.l0 ?? 0, '核心记忆 L0'))
  // v0.15.1 G22:统计三项(A dashboard 的 stats 面板同款)
  cards.push(statCard(mem.auditRows ?? 0, '审计行(证据链)'))
  cards.push(statCard(mem.superseded ?? 0, '换代过的记忆'))
  cards.push(statCard(mem.profileFields ?? 0, '画像字段'))
  fill(box, cards)
  const eng = st.engine || {}
  const sc = eng.sidecar || {}
  fill(info, [el('div', null,
    '引擎:' + engineLabel(eng) + ' · 版本 ' + (st.version || '—') +
    (st.enabled === false ? ' · 休眠中(不注入不记录)' : ' · 在线') +
    ' · 范围:' + (st.scope ? st.scope.scope : '—') +
    (sc.running ? ' · sidecar 运行中' : '')),
  // Step C:向量臂那一行(读 worker 上报的状态文件;null = 没装/没跑)
  el('div', null, embedLine(st.embed, Date.now())),
  el('div', null, '数据目录:' + (st.dataDir || '—'))])
}

// ---- 💗 想念 ----
async function renderLonging () {
  const card = $('lg-card'); const badge = $('lg-engine')
  const data = await api('/api/echo/longing')
  if (!data || data.offline === true || !Array.isArray(data.rows) || data.rows.length === 0) {
    fill(card, [el('div', 'loading', '记忆库离线或暂无想念数据')]); return
  }
  badge.textContent = data.rows[0].engine === 'python' ? '引擎真值' : 'JS 复刻'
  fill(card, data.rows.map((r) => {
    const pct = Math.min(100, Math.round(r.value / Math.max(0.1, r.threshold) * 100))
    const wrap = el('div', 'cd')
    const gauge = el('div', 'gauge')
    const bar = el('div')
    bar.style.width = pct + '%'
    bar.style.background = r.value >= r.threshold ? '#ef4444' : pct > 70 ? '#f59e0b' : '#38bdf8'
    gauge.appendChild(bar)
    wrap.appendChild(gauge)
    const kv = el('div', 'kv')
    const pairs = [
      ['当前', r.value.toFixed(2) + ' / 阈值 ' + r.threshold],
      ['她等你', fmtDur(r.sinceMessage)],
      ['已关怀', (r.careCount ?? 0) + ' 次'],
      ['上次关怀', fmtTime(r.lastCareAt)]
    ]
    if (r.shouldCare) pairs.push(['状态', '到阈值了,她想开口'])
    for (const [k, v] of pairs) {
      kv.appendChild(el('span', null, k + ':'))
      kv.appendChild(el('b', null, v))
    }
    wrap.appendChild(kv)
    return wrap
  }))
}

// ---- 🧠 情绪向量 ----
// v0.29.0 个人机器人裁剪:target_group(对群体:耐心/轻蔑/防御/愤怒)退役。
// ★ P1d(2026-10-05):分组标题里的称呼**从 profile 拿** —— 这里只留一个取值函数,
//   渲染时才算(名字可能晚一拍才到,标题不能写死在常量里)。
const VEC_GROUPS = [
  ['global', () => 'global', [['fatigue', '疲惫'], ['valence', '心情'], ['arousal', '唤醒']]],
  // P2 §6.2 ④:前缀进数据(`uiIndexPrefix`),空 ⇒ 默认「对」(与从前行为一致)
  ['target_master', () => (P().uiIndexPrefix || '对') + P().userName, [['affection', '爱意'], ['playfulness', '调皮'], ['sadness', '委屈'], ['dependency', '依赖']]]
]
async function renderEmotion () {
  const box = $('em-list')
  const data = await api('/api/echo/emotion')
  if (!data || data.offline === true || !Array.isArray(data.rows) || data.rows.length === 0) {
    fill(box, [el('div', 'loading', '暂无情绪数据')]); return
  }
  fill(box, data.rows.map((r) => {
    const card = el('div', 'cd')
    card.appendChild(el('h3', null, '她的情绪:' + (r.userEmotion || 'neutral')))
    // v0.15.1 G22:话题与会话也摆上来 —— 光看数值不知道她当时在想什么,
    // 「为什么是这个心情」的答案在话题里(A 的情绪面板同样带 topic)。
    card.appendChild(el('p', 'hint',
      '强度 ' + (r.moodIntensity ?? 0) + '/10(上轮 ' + (r.prevMoodIntensity ?? 0) + ')· ' + fmtTime(r.updatedAt)
      + (r.currentTopic ? ' · 话题:' + r.currentTopic : '')
      + (r.sessionId ? ' · 会话:' + String(r.sessionId).slice(0, 12) : '')))
    const vec = r.emotionVector || {}
    const vc = el('div', 'vc')
    for (const [key, titleOf, dims] of VEC_GROUPS) {
      const g = el('div', 'vg')
      g.appendChild(el('h4', null, typeof titleOf === 'function' ? titleOf() : titleOf))
      const group = vec[key] || {}
      for (const [dk, dl] of dims) {
        const v = Number(group[dk] ?? 0)
        const row = el('div', 'vr')
        row.appendChild(el('span', 'vl', dl))
        const track = el('div', 'vb')
        const bar = el('div', 'vf')
        bar.style.width = Math.min(100, v * 10) + '%'
        bar.style.background = vecColor(v)
        track.appendChild(bar)
        row.appendChild(track)
        row.appendChild(el('span', 'vv', v.toFixed(1)))
        g.appendChild(row)
      }
      vc.appendChild(g)
    }
    card.appendChild(vc)
    return card
  }))
}

// ---- 💾 记忆体检 + 最近记忆 ----
let lastMem = []
let memOffline = true
async function renderMemory () {
  const dmaeBox = $('mm-dmae')
  const [hR, mR] = await Promise.allSettled([api('/api/echo/health'), api('/api/echo/memories?limit=40')])
  if (hR.status !== 'fulfilled') { fill(dmaeBox, [el('div', 'loading', '体检拉取失败')]); return }
  const h = hR.value
  if (h.offline === true) { fill(dmaeBox, [el('div', 'loading', '记忆库离线')]); return }
  const d = h.dmae || {}
  const total = Math.max(1, d.total ?? 0)
  const bar = el('div', 'hbar')
  for (const [cls, n] of [['seg-a', d.active], ['seg-d', d.dormant], ['seg-x', d.archived]]) {
    const seg = el('div', cls)
    seg.style.width = ((n ?? 0) / total * 100) + '%'
    bar.appendChild(seg)
  }
  const wrap = el('div')
  wrap.appendChild(bar)
  const kv = el('div', 'kv')
  for (const [k, v] of [['现役', (d.active ?? 0) + ' 条'], ['休眠', (d.dormant ?? 0) + ' 条'], ['归档', (d.archived ?? 0) + ' 条'], ['平均可回忆度 R', d.avgR ?? 0], ['悬置话题', ((h.threads && h.threads.open) ?? 0) + ' 个开着']]) {
    kv.appendChild(el('span', null, k + ':')); kv.appendChild(el('b', null, v))
  }
  wrap.appendChild(kv)
  const temporal = el('div')
  temporal.appendChild(el('span', 'chip', '情景时间态:'))
  for (const [k, v] of Object.entries(h.temporal || {})) temporal.appendChild(el('span', 'chip', k + ' × ' + v))
  temporal.appendChild(el('span', 'chip', ' · 图边时间态:'))
  for (const [k, v] of Object.entries(h.temporalEdges || {})) temporal.appendChild(el('span', 'chip', k + ' × ' + v))
  wrap.appendChild(temporal)
  fill(dmaeBox, [wrap])

  memOffline = !(mR.status === 'fulfilled' && mR.value && mR.value.offline !== true && Array.isArray(mR.value.rows))
  lastMem = memOffline ? [] : mR.value.rows
  const n = $('nav-mm-n')
  if (n) n.textContent = lastMem.length > 0 ? String(lastMem.length) : ''
  drawMemTable()
}

/** 纯画:最近记忆表(检索词过滤已拿到的行)。 */
// (v0.29.0:渠道列随群聊拒收一起退役 —— 记忆不再分渠道。)
function drawMemTable () {
  const table = $('mm-table')
  if (memOffline) { fill(table, [el('div', 'loading', '记忆列表拉取失败')]); return }
  const q = qOf('mm-q')
  const rows = lastMem.filter((r) => hit(q, r.memoryId, r.summary, r.layer, r.source, r.status, r.emotionScore))
  const head = el('tr')
  for (const t of ['ID', '摘要', '层', '来源', '情绪', '状态']) head.appendChild(el('th', null, t))
  const thead = el('thead'); thead.appendChild(head)
  const tbody = el('tbody')
  for (const r of rows) {
    const tr = el('tr')
    tr.appendChild(el('td', 'mono', r.memoryId))
    tr.appendChild(el('td', 'cs', clip(r.summary, 90)))
    tr.appendChild(el('td', null, r.layer || '—'))
    tr.appendChild(el('td', null, r.source || '—'))
    tr.appendChild(el('td', 'mono', r.emotionScore ?? '—'))
    tr.appendChild(el('td', null, r.status || '—'))
    tbody.appendChild(tr)
  }
  if (rows.length === 0) {
    fill(table, [el('div', 'empty', '没有匹配「' + q + '」的记忆(' + lastMem.length + ' 条里)。')]); return
  }
  fill(table, [thead, tbody])
}

// ---- 💬 对话回放 ----
let cvChannel = ''
let lastCv = []
async function renderConversations () {
  const chipsBox = $('cv-chips'); const list = $('cv-list'); const count = $('cv-count')
  const url = cvChannel
    ? '/api/echo/conversations?limit=30&channel=' + encodeURIComponent(cvChannel)
    : '/api/echo/conversations?limit=30'
  const data = await api(url)
  if (!data || data.offline === true) { fill(list, [el('div', 'loading', '记忆库离线')]); return }
  const labels = data.labels || {}
  const chips = [el('span', 'chip' + (cvChannel === '' ? ' on' : ''), '全部')]
  chips[0].onclick = () => { cvChannel = ''; refreshConversations() }
  for (const label of new Set(Object.values(labels))) {
    const c = el('span', 'chip' + (cvChannel === label ? ' on' : ''), label)
    c.onclick = () => { cvChannel = label; refreshConversations() }
    chips.push(c)
  }
  fill(chipsBox, chips)
  lastCv = Array.isArray(data.rows) ? data.rows : []
  const n = $('nav-cv-n')
  if (n) n.textContent = lastCv.length > 0 ? String(lastCv.length) : ''
  drawCv()
}

/** 纯画:检索词过滤已拿到的轮次(你说的 + 她说的都算命中)。 */
// 宿主注入判据(与 lib/inbound-filter.js 的 isHumanUtterance 同源)。
// 浏览器端拿不到 lib 的 ESM import(这条是给面板用的独立 bundle),
// 所以这里是一份**最小镜像** —— 只认那几种宿主注入的开头,判错也不伤
// 数据(它只影响回放页的一个标记徽章,不参与任何写路径)。
const HOST_NOISE = /^\s*(current runtime context|this snapshot supersedes|this is an automatically generated checkpoint|## pending jobs|approval prompts are disabled|background job |background subagent )/i
// v0.30.2(2026-09-27):镜像 lib 的 isInternalPrompt —— 插件/子代理自己的
// 提示词也是「非他的话」(extractor、审查员、子代理任务)。活库实测
// conversation_log 100 行里 71 行渠道为空,其中 53 行是这类机器提示词。
const INTERNAL_MARKERS = ['你是一个严格的记忆与情绪反思模块', '你是「almost full access」插件的命令安全审查员']
// v0.41.0:镜像 lib 的 v0.41.0 补丁 —— 情绪单轮打分器的提示词开头(`你只做一件事…`)。
// 它只影响回放页那个「非他的话」徽章,不参与任何写路径。
const INTERNAL_OPENINGS = /^(你只做一件事|只读任务|只读分析|只读代码分析|只读资料提取|你是只读|你在为项目|整理架构文档|请你?只读|你要.{0,6}只读)/
const AGENT_DIRECTIVE = /^(你要|你将|你是|你的任务|请你|你在为|只读任务|只读分析|整理架构文档|重写|为项目)/
const AGENT_ACTION = /(只读|禁止|分析|审查|提取|整理|重写|评测|报告|输出|JSON|json|素材|审查员|候选|模块|提示词)/
function isInternalPrompt (t) {
  const s = String(t || '').trim()
  if (s === '') return false
  const low = s.toLowerCase()
  if (INTERNAL_MARKERS.some((m) => low.startsWith(m))) return true
  if (INTERNAL_OPENINGS.test(s)) return true
  return s.length >= 80 && AGENT_DIRECTIVE.test(s) && AGENT_ACTION.test(s.slice(0, 120))
}
function isHumanUtterance (t) {
  const s = String(t || '').trim()
  if (s === '') return false
  return !HOST_NOISE.test(s) && !isInternalPrompt(s)
}
function drawCv () {
  const list = $('cv-list'); const count = $('cv-count')
  const q = qOf('cv-q')
  const rows = lastCv.filter((r) => hit(q, r.userText, r.replyText, r.channel))
  if (count) count.textContent = (q === '' ? rows.length + ' 轮' : rows.length + '/' + lastCv.length + ' 轮')
  if (lastCv.length === 0) {
    fill(list, [el('div', 'empty', '还没有对话记录 —— 和她说句话,这里就有第一行。')]); return
  }
  if (rows.length === 0) { fill(list, [el('div', 'empty', '没有匹配「' + q + '」的轮次。')]); return }
  fill(list, rows.map((r) => {
    const t = el('div', 'turn')
    const head = el('div', 'meta')
    head.appendChild(el('span', 'badge', r.channel || '未标注'))
    head.appendChild(el('span', null, ' · ' + fmtTime(r.createdAt)))
    // 2026-09-26:宿主每轮注入的 runtime context 也被捕获进了这张表
    // (实测 44/100 行)。它现在进不了记忆、进不了共享窗口、进不了反思
    // 信封 —— 但回放是"照实显示历史"的地方,所以**留行 + 标出来**,
    // 而不是偷偷藏掉(藏掉等于篡改回放)。
    const noise = !isHumanUtterance(String(r.userText || ''))
    if (noise) head.appendChild(el('span', 'badge', '宿主注入·非他的话'))
    t.appendChild(head)
    if (r.userText) {
      const line = el('div')
      line.appendChild(el('span', 'who', '你:'))
      line.appendChild(el('span', noise ? 'you dim' : 'you', clip(r.userText, 200)))
      t.appendChild(line)
    }
    const reply = el('div')
    reply.appendChild(el('span', 'who', r.userText ? '她:' : '她(主动):'))
    reply.appendChild(el('span', 'her', clip(r.replyText, 300)))
    t.appendChild(reply)
    return t
  }))
}
function refreshConversations () { renderConversations().catch(() => {}) }

// ---- 🕸️ 图谱 ----
async function renderGraph () {
  const grid = $('gr-grid'); const edgesBox = $('gr-edges')
  const data = await api('/api/echo/graph')
  if (!data || data.offline === true) { fill(edgesBox, [el('span', 'loading', '记忆库离线')]); return }
  const nodes = Array.isArray(data.nodes) ? data.nodes : []
  const edges = Array.isArray(data.edges) ? data.edges : []
  fill(grid, [statCard(nodes.length, '节点'), statCard(edges.length, '关系边')])
  const byId = {}
  for (const n of nodes) byId[n.id] = n.name || n.id
  const top = [...nodes].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).slice(0, 10)
  const wrap = el('div')
  const chips = el('div')
  chips.appendChild(el('span', 'chip', '高频节点:'))
  for (const n of top) chips.appendChild(el('span', 'chip', (n.name || '?') + '(' + n.type + ',w' + (n.weight ?? 0) + ')'))
  wrap.appendChild(chips)
  for (const e of edges.slice(0, 30)) {
    wrap.appendChild(el('div', null,
      (byId[e.source] || e.source || '?') + ' —' + (e.relation || '相关') + '→ ' +
      (byId[e.target] || e.target || '?') + '(w' + (e.weight ?? 1) + ')'))
  }
  fill(edgesBox, [wrap])
}

// ---- 📋 审计流(2026-09-29 重做:分层 + 三档密度 + 人话;信息一条不删)----
// 他的现场话:「审计流太乱了,我希望你能设计清晰一点,人性化,但是信息一定要全面。」
// 病根:40 行里二十多行是 `structured_output` 的原始 JSON(每行三四行高、全是「系统」
// 徽章),真正的对话被埋在中间;而她一轮里干的事又按"一次工具调用一行"平铺,读起来
// 像日志不像故事。**修法不是删,是换组织方式**:
//   ① 每行先归桶(对话/她主动/提取/干活/后台/系统/桥)→ 桶决定它默认露不露面;
//   ② 后台行折进它服务的那一轮脚下(「⛭ 后台 9 次」,点开全在、原文一字不少);
//   ③ 机器的话也翻译成人话(`{"keywords":[…],"summary":…}` → 「词 … / 记 …」);
//   ④ 三档密度(**对话优先 / 全部 / 排障**)是同一份数据的三副面孔,不换数据源。
// 判据与纯逻辑都在 web/audit-view.js(离线可测);这里只管画。
let lastAudit = []
/** ★ 2026-10-08 F1′:折轮用的**大窗口**(比展示窗口大)—— 见 `audit-view.js#turnsForDisplay`。
 *  轮 id 来自"定义这一轮的那一行",只折展示窗口的话它一滑走 id 就漂。 */
let lastAuditFold = []
/** 展示窗口的行数(对话优先 40 / 其它 120):从大窗口里挑该展示的轮用它。 */
let lastAuditLimit = 40
/** ★ 2026-10-08(空 bug-b):`drawAudit` 这一拍**真正显示出来的轮**(筛选/密度/检索都算过之后)。
 *  别的按钮(尤其「全部收起/展开」)一律复用这一份 —— 以前它自己去 `buildTurns(lastAudit)` 折,
 *  F1′ 之后那是**旧口径**(只折展示窗口),算出来的 id 与显示侧不是同一批 ⇒ 点了没反应。 */
let lastShownTurns = []
/** ★ 2026-10-08:哪些桶算"有内容" —— "对话优先"档只显示它们(**白名单**,不是"滤掉机器行"的黑名单)。
 *  白名单比黑名单稳:以后再有新工具行(比如会话清理那种心跳)不会被漏进"对话优先"的版面。 */
const CONTENT_BUCKETS = ['talk', 'her', 'reflect']
/** ★ 2026-10-08(autofill 兜底):页面加载后**第一次**进审计流时清一次检索框。
 *  浏览器会把别处填过的值(他的 LLM baseURL 那种)自动填进没有 autocomplete 的搜索框,
 *  于是"一进审计流就是筛过的空列表"(现场:au-q 自动有值 https://r.dis.115.zone/v1)。
 *  只清第一次:他后来在框里打的字,切走再回来必须还在。 */
let firstAuditVisit = false
/** ★ 2026-10-08(竞态兜底):浏览器 autofill 可能在首帧**之后**才发生 ⇒ 单次清空有概率失效。
 *  所以进审计流后**守一段时间**:期间 au-q 一旦有值就清掉;他一旦 focus / 打字 / 按键,
 *  或者离开了审计流面板,立刻收手(绝不清他打的字)。*/
let auditQueryGuardStop = null
/** 守备的时间窗与人手标志:窗内且他没动过手 ⇒ 见到值就清(不依赖 timer,renderAudit 也会查一次)。*/
let auditQueryGuardUntil = 0
let auditQueryHuman = false
/** 守备窗内、他也没动过手 ⇒ 把 au-q 上的值清掉(autofill 的迟到由它兜住)。*/
function clearAuditQueryIfAutofilled () {
  if (auditQueryHuman) return
  if (Date.now() >= auditQueryGuardUntil) return
  const qb = $('au-q')
  if (!qb) return
  const v = String(qb.value || '').trim()
  // 只清**看起来像 URL / 端点**的值:我们见过的 autofill 就是这个形状(他的 LLM baseURL)。
  // 这样即便守备窗还开着,他自己打的普通检索词(哪怕只有一两个字)也绝不会被吃掉。
  if (!/^https?:\/\/\S+$/i.test(v)) return
  qb.value = ''
}
function startAuditQueryGuard (ms = 3000, everyMs = 200) {
  if (typeof auditQueryGuardStop === 'function') { try { auditQueryGuardStop() } catch { } }
  const qb = $('au-q')
  if (!qb) return
  let stopped = false
  const clear = () => clearAuditQueryIfAutofilled()
  // 用递归 setTimeout 而不是 setInterval:全文件只留轮询那一个 setInterval
  // (老闸就是用"第一个 setInterval 后面必须跟 if (!frozen)"来钉轮询的)。
  let timer = null
  const tick = () => {
    if (stopped) return
    clear()
    timer = setTimeout(tick, Math.max(50, everyMs))
    try { timer.unref && timer.unref() } catch { }
  }
  timer = setTimeout(tick, Math.max(50, everyMs))

  const hard = setTimeout(() => { stop() }, Math.max(0, ms))
  try { timer.unref && timer.unref() } catch { }
  try { hard.unref && hard.unref() } catch { }
  function stop () {
    if (stopped) return
    stopped = true
    try { clearInterval(timer) } catch { }
    try { clearTimeout(timer) } catch { }
    try { clearTimeout(hard) } catch { }
    if (auditQueryGuardStop === stop) auditQueryGuardStop = null
  }
  const human = () => { auditQueryHuman = true; stop() }   // 他动了手 ⇒ 立刻收手,并记住别再清
  try { qb.addEventListener('focus', human); qb.addEventListener('keydown', human); qb.addEventListener('input', human) } catch { }
  auditQueryGuardUntil = Date.now() + Math.max(0, ms)
  auditQueryHuman = false
  clear()
  auditQueryGuardStop = stop
}
/** 展开了哪些轮(按轮 id 记,跨重画保留 —— 10 秒轮询不该把读着的行收回去)。 */
const auditOpen = new Set()
/** 他手动**收起**过哪几轮(轮询不许把它又掰开)。 */
const auditClosed = new Set()
/** 密度档:'talk'(对话优先) | 'all'(全部) | 'debug'(排障:原始行视角)。 */
let auMode = 'talk'
/** 来源筛('' = 全部):qq / dsh / companion / sub / bg。 */
let auSrc = ''
/** 桶筛('' = 全部)。 */
let auKind = ''
/** 纯逻辑模块(缺席时给一句人话,不让整页崩)。 */
function V () {
  const v = globalThis.EchoAuditView
  if (!v) throw new Error('audit-view.js 没加载(检查 index.html 的 <script> 顺序)')
  return v
}
/** 左栏选中哪一轮(主从两栏;空 = 还没选,自动挑最近一轮说过话的)。 */
let auSel = ''
/** ★ 2026-10-08 F2:右栏最近一次**真的渲染过**的那一轮。
 *  窗口只取 40/120 行,轮 id 又是"定义这一轮的那一行"的 trace_id(`audit-view.js` 的
 *  buildTurns)——那一行滑出窗口,id 就变了(或整轮消失)。以前 `auSel` 一旦对不上就
 *  **跳到最近一轮说过话的轮**(现场:「点开单个对话展开详情,过一会儿自动关掉」)。
 *  现在改成:选择粘住,找不到就用这份缓存继续显示那一轮,并明说"已滑出窗口"。 */
let auSelTurn = null
/** 右栏里那些"重文本"小节(注入全文 / 情绪包 / 向量…)默认**全收起** ——
 *  他 2026-09-29 第三轮现场:「确实能读了,但是又显得太过于冗杂了,最好能够起个
 *  折叠功能」。所以默认只留"谁说了什么 + 后台折叠行",重文本一键展开。 */
let auSectionsOpen = false

/** 一个可折叠小节(标题行 + 正文)。auditDetail / 注入小节共用同一套。 */
function secBox (title, bodyNode, open) {
  const box = el('div', 'sec' + (open ? ' open' : ''))
  const head = el('div', 'sec-head')
  head.appendChild(el('span', 'sec-caret', '▶'))
  head.appendChild(el('span', 'sec-name', title))
  box.appendChild(head)
  const body = el('div', 'sec-body')
  body.appendChild(bodyNode)
  body.style.display = open ? '' : 'none'
  head.onclick = () => {
    const on = box.className.indexOf('open') < 0
    box.className = 'sec' + (on ? ' open' : '')
    body.style.display = on ? '' : 'none'
  }
  box.appendChild(body)
  return box
}


async function renderAudit () {
  clearAuditQueryIfAutofilled()   // 守备窗内:每次进这一拍都挡一次 autofill 的迟到
  // ★ 2026-10-08(autofill 兜底):第一次进审计流时把检索框清一次(见模块级 firstAuditVisit);
  // 只在**当前面板是审计流**的那一拍做,而且只做一次 —— 之后他打的字不许被清。
  if (!firstAuditVisit && currentPanel === 'au') {
    firstAuditVisit = true
    startAuditQueryGuard()   // 不是「清一次」—— 守 3 秒,挡 autofill 的迟到
  }
  // 窗口大小跟着密度档走:'对话优先' 看近期(40 行够),'全部/排障' 是查账,多取一些
  // (2026-09-29:活库实测 40 行的窗口会**从中间截断轮次** —— 顶上那几张只有她的话、
  //  没有他的话的卡片就是这么来的:他的入站行已经掉出窗口了)。
  const displayLimit = auMode === 'talk' ? 40 : 120
  // ★ 2026-10-08 F1′:折轮的窗口**比展示的窗口大** —— 轮 id 来自"定义这一轮的那一行",
  // 展示窗口一滑它就掉出去 ⇒ id 漂 ⇒ 他展开的详情"自己关掉"。多取一段只用于折轮,
  // 展示仍按最新 displayLimit 行(`audit-view.js#turnsForDisplay`)。
  // ⚠️ store 侧 `listAudit` 的硬上限是 200 行(lib/store.js:1110)⇒ 大窗口封顶 200
  //    ('全部/排障' 档 120×3=360 会被夹到 200,仍是展示窗口的 1.67 倍)。
  const foldLimit = Math.min(200, displayLimit * 3)
  const data = await api('/api/echo/audit?limit=' + foldLimit + '&light=1')
  lastAuditFold = (data && Array.isArray(data.rows)) ? data.rows : []
  // 读数与统计沿用**老口径**(= 展示窗口那几行):接口是新的在前,取前 displayLimit 行
  // ★ 2026-10-08(窗口按内容凑数):"对话优先"档的展示位**只给有内容的桶**(talk/her/reflect),
  // 从大窗口往回翻到凑满 displayLimit 行 —— 心跳/机器行(会话清理那样每 10 分钟一条)再也
  // 不会把真实对话挤出窗口;'全部'/'排障' 档照旧全都要(它们本来就是查账视角)。
  const vv = V()
  lastAudit = (auMode === 'talk' && typeof vv.contentRows === 'function')
    ? vv.contentRows(lastAuditFold, displayLimit, CONTENT_BUCKETS)
    : lastAuditFold.slice(0, displayLimit)
  lastAuditLimit = displayLimit
  const n = $('nav-au-n')
  if (n) n.textContent = lastAudit.length > 0 ? String(lastAudit.length) : ''
  drawAuditStat()
  drawAuditChips()
  drawAudit()
}

/** 顶栏统计带:这一窗里"发生了什么事"一句话说清 —— 数字全部可点,点了就是筛。 */
function drawAuditStat () {
  const box = $('au-stat')
  if (!box) return
  const v = V()
  const s = v.summarize(lastAudit)
  const chips = []
  const chip = (text, on, cls, onclick) => {
    const c = el('span', 'stat-chip' + (on ? ' on' : '') + (cls ? ' ' + cls : ''), text)
    c.onclick = onclick
    return c
  }
  chips.push(chip('最近 ' + s.rows + ' 行', false, null, () => { auKind = ''; auSrc = ''; drawAuditStat(); drawAuditChips(); drawAudit() }))
  // 分两组(2026-09-29 晚:一条长龙挤成一坨 —— "事件"与"来源"各占一行,标签带小标题)
  const evGroup = el('span', 'stat-group')
  evGroup.appendChild(el('span', 'stat-label', '事件'))
  for (const k of ['talk', 'her', 'reflect', 'work', 'machine', 'system', 'bridge']) {
    const n = s.buckets[k] || 0
    if (n === 0) continue
    evGroup.appendChild(chip(v.BUCKETS[k].icon + ' ' + v.BUCKETS[k].label + ' ' + n, auKind === k, null,
      () => { auKind = auKind === k ? '' : k; drawAuditStat(); drawAuditChips(); drawAudit() }))
  }
  chips.push(evGroup)
  const srcGroup = el('span', 'stat-group')
  srcGroup.appendChild(el('span', 'stat-label', '来源'))
  for (const k of ['qq', 'dsh', 'companion', 'sub', 'bg']) {
    const n = s.sources[k] || 0
    if (n === 0) continue
    srcGroup.appendChild(chip(v.SOURCES[k].label + ' ' + n, auSrc === k, v.SOURCES[k].cls,
      () => { auSrc = auSrc === k ? '' : k; drawAuditStat(); drawAuditChips(); drawAudit() }))
  }
  chips.push(srcGroup)
  // 2026-10-06:证据链体检 —— 这一窗里"她读到了什么"有没有留下证据。
  // 以前只在点开某一轮才看得到注入字数;整窗有没有证据、注入行是不是被工具行
  // 挤掉了,盯着页面看不出来(活库那次 160 行全空就是这么被发现的)。
  const injs = s.injects || { rows: 0, lines: 0, lastAt: 0, lastChars: 0 }
  const injChip = el('span', 'stat-chip plain' + (injs.rows > 0 ? '' : ' bad'),
    injs.rows > 0
      ? '注入留痕 ' + injs.rows + ' 行 · 最近一条块 ' + injs.lastChars + ' 字'
      : '⚠ 这一窗没有注入留痕')
  injChip.title = injs.rows > 0
    ? '每轮组装完提示词就写一行(toolCall=inject),与轮末反思成功与否无关;' +
      '带注入块的行共 ' + injs.rows + ' 行,其中注入留痕 ' + injs.lines + ' 行。点左侧任一轮看全文。'
    : '这一窗里没有任何一行带注入块 —— 要么还没有对话轮(工具行的空注入不算),' +
      '要么后端还在跑旧版(旧版只有轮末反思成功那行才带注入块)。'
  chips.push(injChip)
  if (s.lastTalkAt > 0) {
    chips.push(el('span', 'stat-chip plain', '最近一次有人说话:' + v.relTime(s.lastTalkAt, Date.now())))
  }
  // 提示信息收进 tooltip(它原来占一整枚标签,把统计带挤成了两行)
  const hint = el('span', 'stat-chip plain', (s.buckets.machine || 0) > (s.buckets.talk || 0) ? '后台占多数' : '')
  hint.title = '后台调用比对话多很正常(它们折在轮脚下);这里数的是最近这一窗的行数,不是消息条数。'
  if (hint.textContent !== '') chips.push(hint)
  fill(box, chips)
}

/** 筛选条:密度三档 + 桶 + 来源。**保留"全部收起"** —— 展开状态跨轮询保留。 */
function drawAuditChips () {
  const box = $('au-chips')
  if (!box) return
  const v = V()
  const nodes = []
  const seg = el('span', 'seg')
  for (const [k, label, tip] of [['talk', '对话优先', '只留说话与系统动作;后台折进轮脚下'],
    ['all', '全部', '后台与干活也摆出来,仍是一行一条人话'],
    ['debug', '排障', '原始行视角:工具原名 / 会话 / trace / 全文']]) {
    const b = el('span', 'seg-btn' + (auMode === k ? ' on' : ''), label)
    b.title = tip
    // 切密度档要**重新取数**(窗口大小跟着档走),不只是重画
    b.onclick = () => { auMode = k; renderAudit().catch(() => drawAudit()) }
    seg.appendChild(b)
  }
  nodes.push(seg)
  if (auKind !== '' || auSrc !== '') {
    const clearC = el('span', 'chip', '✕ 清筛选')
    clearC.onclick = () => {
      auKind = ''; auSrc = ''
      const qb = $('au-q'); if (qb) qb.value = ''   // 检索词也是筛选(见空态里那个同名按钮的注释)
      drawAuditStat(); drawAuditChips(); drawAudit()
    }
    nodes.push(clearC)
  }
  fill(box, nodes)
}

/** 注入块的文字(2026-09-27 防御:后端修好前,旧 store.js 会把这一列
 *  解析成 `{}` —— `String({})` 是 "[object Object]",会被拆段器当成
 *  一个 15 字的假标题渲染出来。只认真正的非空字符串,别的一律当"没有"。 */
function injText (r) {
  const v = r && r.injectedMemories
  if (typeof v === 'string') return v
  // 老夹具/老复现包可能是 [{summary}] —— 拼成可读文本,而不是丢掉
  if (Array.isArray(v) && v.length > 0) {
    return v.map((m) => '- ' + String((m && m.summary) || m)).join('\n')
  }
  return ''
}

/** 审计行的工具名(含桥与工具调用) —— 面板上不出现裸英文。
 *  2026-09-29:翻译表搬进 `web/audit-view.js`(那里是"看法"的唯一一份);
 *  这里保留 TOOL_LABELS 里那几条**本页特有**的说法,再落到模块的通用表。 */
function toolLabel (t) {
  if (TOOL_LABELS[t]) return TOOL_LABELS[t]
  return V().toolHuman(t)
}

/** 这一行 `user_input` 是谁的:'〈她的名字〉' | '〈他的称呼〉' | '系统' | '宿主注入'(不含冒号)。
 *
 * 2026-09-27 晚(他:「用男他还有女他还搁这讲信息」)—— 标签从**人称代词**换成
 * **名字**:`Echo` / `<称呼>` / `系统`。代词在这里没有信息量(谁是谁靠猜),
 * 名字直接说清;`宿主注入` 单列一类,免得宿主的话被读成他说的话。
 *
 * ★ P1d(2026-10-05):那两个名字**不再写在代码里** —— 全从 profile 的
 *   `agentName` / `userName` 来(见文件上方 loadProfile)。端点没就绪 ⇒ 中性兜底
 *   ('助手' / '用户'),判错的只是显示名,不影响任何写路径。
 *
 * 依据(逐个查过写侧,不是猜的):
 *   · 她的话 = `echo_qq_say|echo_qq_call|relay_out|relay_proactive`
 *     (`relay_out` 是桥对同一句的副本:同一句两行,取一份)
 *   · `relay_in` = 入站 → **他**的话(带 `[QQ:私聊] …说:` 前缀)
 *   · `extract` = 这轮的真人输入 → **他**(`lib/engine.js:289` / `reflect.js:352`)
 *   · `系统` = 明确清单(见下)+ 兜底:未知工具若文本以 `(` 开头,当系统标记
 *
 * ⚠️ 别把"以 `(` 开头"当成系统标记的**主**判据 —— 这条我踩过:
 * `lib/store.js:1279` 写的是 `面板手动编辑记忆 #12`(**没有括号**),
 * `lib/drift.js:82` 用方括号,`lib/turn-stopping.js:143` 也没有括号。
 * 所以系统行必须**点名**;括号只当未知工具时的兜底。
 */
const HER_TOOLS = ['echo_qq_say', 'echo_qq_call', 'relay_out', 'relay_proactive']
const SYS_TOOLS = ['memory_edit', 'memory_state', 'memory_clear', 'memory_cleanup',
  'session_on', 'session_off', 'auto_scope_on', 'power', 'diary', 'drift',
  'reflection', 'longing_steer', 'say_again', 'graph_merge', 'graph_cleanup']

function saidLabel (toolCall, userInput) {
  const t = String(toolCall || '')
  const u = String(userInput || '').trim()
  if (HER_TOOLS.indexOf(t) >= 0) return P().agentName
  if (SYS_TOOLS.indexOf(t) >= 0) return '系统'
  // 宿主注入(判据与 lib/inbound-filter.js 同源):空渠道那些机器提示词
  // 也在内 —— 它既不是他打的字,也不是她的
  if (u !== '' && !isHumanUtterance(u)) return '宿主注入'
  // 兜底:没点名的工具,文本像标记(以 `(` 开头)就按系统行显示,否则算他的话
  // —— 默认回到老行为,免得新工具一出现就把他的话标错。
  if (u.charAt(0) === '(') return '系统'
  return P().userName
}

/** `llm_reply` 那一列是谁写的。
 *
 * 2026-09-27 晚现场:审计流第二行原来**写死**「她:」,可这一列**只有 `extract`
 * 行有值**(活库 100 行实测),装的是提取器的**第三人称旁白 + 内心戏**
 * (「已回他:「…」」)。面板等于拿一个模型的旁白冒充她说的话 —— 正是他说的
 * 「还搁这讲信息」。所以按工具分流:extract 归「提取器(旁白)」。
 */
function replyLabel (toolCall) {
  return String(toolCall || '') === 'extract' ? '提取器(旁白)' : P().agentName
}

/** 剥信封与桥的元数据,只留人话本身(面板要显示"谁说了什么",不是协议)。
 *  「〈他的称呼〉说:」那条前缀的名字**从 profile 拼**(speakerReOf):端点没就绪时
 *  就是中性兜底那个词,而不是把真名写回正则。 */
function stripEnvelope (text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/^\(用 QQ (?:说|喊他)\)\s*/, '')
    .replace(/^\[(?:QQ|私聊|群聊)[^\]]*\]\s*/, '')
    .replace(/^【QQ·[^】]*】\s*/, '')
    .replace(speakerReOf(), '')
    .replace(/\s*→\s*[^→]*\(权限:[^)]*\)\s*$/, '')
    .trim()
}

/** 一轮的类别(徽章文字) —— 现在统一走桶(web/audit-view.js 的 classify)。 */
function turnKind (turn) {
  const b = V().BUCKETS[turn.bucket] || V().BUCKETS.other
  return b.label
}

/** 把审计行折成**轮**。判据与实现在 `web/audit-view.js`(纯逻辑,离线可测)——
 *  不能靠 traceId 折(每行一个)也不能靠会话折(她的话记 `global`、桥记陪伴会话),
 *  只能按**时间序 + 工具族状态机**折;活库实测形状:`relay_in 18:52:33 →
 *  echo_qq_say 18:52:44 + relay_out 18:52:44 → extract 18:53:00`。
 *  这层皮留着,是给"全部展开"(顶部按钮)与别处复用同一个折叠结果。 */
function buildTurns (rows) { return V().buildTurns(rows) }

/** 纯画:折成轮 → 三层筛选(桶 / 来源 / 检索)→ 按天分组 → **左索引 + 右详情**。
 *
 * 2026-09-29 三改(他:「还是太丑了…拥用全部信息,但同时也不能过于拥挤」):
 * 病根是"想在一条时间线里把全部信息塞完"。改成主从两栏(日志类界面的通则):
 *   · 左栏 = **索引**:固定行高、单行、溢出省略号 —— 只回答"哪一轮 / 谁的 / 什么类别 /
 *     大概说了啥";因为永远是单行,结构上就不可能挤成一坨或折成竖排;
 *   · 右栏 = **那一轮的全部**(气泡 / 后台调用 / 注入全文 / 原始行),只装一轮,
 *     所以可以放开留白。
 * 两栏都保留全部信息,拥挤感来自"同时看全部",不是来自"信息多"。 */
function drawAudit () {
  const box = $('au-list')
  const detail = $('au-detail')
  if (!Array.isArray(lastAudit) || lastAudit.length === 0) {
    fill(box, [el('div', 'empty', '还没有审计记录。')])
    if (detail) fill(detail, [])
    lastShownTurns = []
    return
  }
  const v = V()
  const q = qOf('au-q')
  // ★ 2026-10-08:白名单判据 —— "对话优先"档只显示**有内容**的桶(talk/her/reflect)。
  // 旧写法是黑名单(`turn.bucket !== 'machine' && turn.bucket !== 'work'`),于是任何
  // 没被点名的工具行(会话清理那种心跳)都会漏进"对话优先"的版面 ⇒ 对话被挤没。
  const visible = (turn) => auMode !== 'talk' || CONTENT_BUCKETS.indexOf(turn.bucket) >= 0
  // ★ 2026-10-08 F1′:从**大窗口**折轮(轮的 id 因此不随展示窗口滑动而漂),再按展示
  // 窗口(`lastAudit`:talk 档是"内容窗口",其它档是最新 displayLimit 行)挑出该显示的轮。
  const folded = (typeof v.turnsForDisplay === 'function')
    ? v.turnsForDisplay(lastAuditFold, lastAudit)
    : v.buildTurns(lastAudit)
  const turns = folded
    .filter(visible)
    .filter((turn) => auKind === '' || turn.rows.some((r) => v.classify(r).bucket === auKind))
    .filter((turn) => auSrc === '' || turn.rows.some((r) => v.classify(r).source === auSrc))
    .filter((turn) => q === '' || hit(q, v.turnText(turn), turnKind(turn), v.BUCKETS[turn.bucket] ? v.BUCKETS[turn.bucket].desc : ''))
  if (turns.length === 0) {
    // ★ 2026-10-08(空 bug-a):空态**右栏也要给话**。以前是"左栏一句提示 + `fill(detail, [])`"
    // ⇒ 右栏一片空白,看着像整个审计流没了(现场:「点一下按钮又空了」)。
    // 顺手把「✕ 清筛选」搬到空态里两栏各一个 —— 他不用再往上找统计带里那一个。
    const why = '当前筛选下没有可显示的轮' + (lastAudit.length > 0
      ? '(' + lastAudit.length + ' 行里' + (q !== '' ? '、检索词「' + q + '」' : '') + ')'
      : '') + ' —— 点「✕ 清筛选」或换密度档试试。若检索框里有你没输入过的内容,可能是浏览器自动填充 —— 清掉即可。'
    const mkClear = () => {
      const b = el('button', 'btn', '✕ 清筛选')
      b.type = 'button'
      b.onclick = () => {
        auKind = ''; auSrc = ''
        // ⚠️ 2026-10-08:检索框也是"筛选"的一部分 —— 老「清筛选」只清 chips,
        // 于是点完还是空的(检索词还在)。一并清掉,按钮才名副其实。
        const qb = $('au-q'); if (qb) qb.value = ''
        drawAuditStat(); drawAuditChips(); drawAudit()
      }
      return b
    }
    const emptyL = el('div', 'empty')
    emptyL.appendChild(el('span', null, why))
    emptyL.appendChild(mkClear())
    fill(box, [emptyL])
    if (detail) {
      const emptyR = el('div', 'empty')
      emptyR.appendChild(el('span', null, '当前筛选下没有可显示的轮 —— 点上面「✕ 清筛选」或换密度档;若检索框里有你没输入过的内容,可能是浏览器自动填充'))
      emptyR.appendChild(mkClear())
      fill(detail, [emptyR])
    }
    lastShownTurns = []
    return
  }
  lastShownTurns = turns
  // 选中项:★ 2026-10-08 F2 —— **只有"还没选过"才自动挑**。
  // 以前这里是 `if (auSel === '' || !turns.some(t => t.id === auSel))`,即"选中的轮不在
  // 新窗口里 ⇒ 跳到最近一轮说过话的轮":10 秒轮询(与每个审计 SSE 事件)一重建,
  // 他正读着的那一轮就被换成另一轮 —— 现场就是"展开详情过一会儿自动关掉"。
  // 现在选过就**粘住**;它滑出窗口时由下面的缓存兜底(见 auSelTurn)。
  if (auSel === '') {
    let pick = turns[0]
    for (const t of turns) if (t.in !== null || t.out.length > 0) { pick = t; break }
    auSel = pick.id
  }
  const groups = v.groupByDay(turns)
  const nodes = []
  // ★ 2026-10-08:F3 冻结之后左栏也要说一声 —— 以前只有右栏有横幅,左栏看不出"为什么不动了"。
  if (frozen) nodes.push(el('div', 'au-meta-line', '已暂停刷新(读长文时不被重建打断)—— 右栏「继续刷新」可恢复'))
  const shown = groups.reduce((n, g) => n + g.turns.length, 0)
  nodes.push(el('div', 'au-meta-line', '显示 ' + shown + ' 轮 · 共取回 ' + lastAudit.length + ' 行' +
    (q !== '' ? ' · 检索「' + q + '」' : '') + ' · 左栏是索引(点一轮换看),右栏是这一轮的全部信息'))
  for (const g of groups) {
    nodes.push(el('div', 'au-day', g.label))
    for (const turn of g.turns) nodes.push(idxRow(turn))
  }
  fill(box, nodes)
  if (detail) {
    const sel = turns.filter((t) => t.id === auSel)[0] || null
    if (sel !== null) {
      auSelTurn = sel
      if (!auditClosed.has(sel.id)) auditOpen.add(sel.id) // 详情默认**展开**(他手动收起的除外)
    }
    const shown = sel !== null ? sel : auSelTurn
    const stale = sel === null && shown !== null
    const box2 = []
    // ⚠️ 顺序有讲究:卡片**必须第一个**(页面别处与测试都按 `au-detail` 的第一个子节点
    // 认"那张卡"),提示条一律跟在它后面。
    if (shown !== null) box2.push(turnCard(shown))
    // ★ 2026-10-08 F2:选了的那一轮这一拍不在窗口里(窗口滑走 / 它的定义行掉出去)⇒
    // **不换人**:用缓存继续显示,并明确告诉他"这一轮已滑出窗口",不要静默换一张卡。
    if (stale) box2.push(el('div', 'au-meta-line', '⚠ 这一轮已滑出窗口 —— 上面是离开窗口前的最后一版;点左栏任一轮换看。'))
    if (frozen) {
      // ★ 2026-10-08 F3:点开就冻结 ⇒ 给一条"我在暂停刷新"的横幅 + 解除按钮
      // (工具条那个"冻结"勾选框会同步亮起,两条路等价)。
      const bar = el('div', 'au-meta-line')
      bar.appendChild(el('span', null, '已暂停刷新(读长文时不被重建打断)'))
      const btn = el('button', 'btn', '继续刷新')
      btn.type = 'button'
      btn.onclick = () => { setFrozen(false); drawAudit() }
      bar.appendChild(btn)
      box2.push(bar)
    }
    fill(detail, box2.length > 0 ? box2 : [el('div', 'empty', '在左边点一轮。')])
  }
}

/** 左栏的**索引行**:固定行高、单行、溢出省略号。
 *  永不换行 = 结构上不可能拥挤、不可能竖排。全文在右栏。 */
function idxRow (turn) {
  const v = V()
  const b = v.BUCKETS[turn.bucket] || v.BUCKETS.other
  const sel = turn.id === auSel
  const row = el('div', 'ar idx k-' + turn.bucket + (sel ? ' sel' : ''))
  row.appendChild(el('span', 'idx-dot ' + 'dot-' + turn.bucket))
  row.appendChild(el('span', 'idx-time', v.relTime(turn.time, Date.now())))
  row.appendChild(el('span', 'idx-kind', b.label))
  const src = v.SOURCES[v.rowSource(turn.rows[0])] || v.SOURCES.bg
  row.appendChild(el('span', 'idx-src ' + src.cls, src.label))
  // 摘要:他的原话优先(他找的就是"哪句"),没有就退到系统动作
  const primary = turn.in || turn.out[0] || turn.reflect || turn.rows[0]
  // 前缀那两个名字**从 profile 拿**(P1d):面板上不认第二份真名。
  const said = (turn.in !== null && String(turn.in.userInput || '') !== '')
    ? P().userName + ' ' + clip(stripEnvelope(turn.in.userInput).replace(/\s+/g, ' '), 60)
    : (turn.out.length > 0 ? P().agentName + ' ' + clip(stripEnvelope(turn.out[0].userInput).replace(/\s+/g, ' '), 60)
      : v.toolHuman(primary.toolCall) + ' ' + clip(String(primary.userInput || '').replace(/\s+/g, ' '), 52))
  row.appendChild(el('span', 'idx-sum', said))
  const counts = v.countByBucket(turn)
  const extra = (counts.machine || 0) + (counts.work || 0)
  if (extra > 0) row.appendChild(el('span', 'idx-n', '⛭' + extra))
  row.title = fmtTime(turn.time) + ' · ' + said
  row.onclick = () => {
    auSel = turn.id
    if (!frozen) setFrozen(true)   // ★ 2026-10-08 F3:点开详情 ⇒ 冻结刷新(见 toggleTurn)
    drawAudit()
  }
  return row
}

/** 检索命中高亮:把一段文字里命中检索词的部分包成 <mark>。
 *  只用 `el()` 拼元素(不碰 createTextNode / createDocumentFragment)—— 与全文件
 *  一个写法,而且测试里的假 DOM 只需要 createElement 那一个原语。
 *  逐段 textContent,不拼 innerHTML(老规矩,不留 XSS 坏习惯)。 */
function hl (text, q) {
  const s = String(text === undefined || text === null ? '' : text)
  const wrap = el('span')
  if (q === '' || s === '') { wrap.textContent = s; return wrap }
  const low = s.toLowerCase()
  let at = 0
  for (;;) {
    const i = low.indexOf(q, at)
    if (i < 0) break
    if (i > at) wrap.appendChild(el('span', null, s.slice(at, i)))
    wrap.appendChild(el('mark', 'hl', s.slice(i, i + q.length)))
    at = i + q.length
  }
  if (at === 0) { wrap.textContent = s; return wrap }
  if (at < s.length) wrap.appendChild(el('span', null, s.slice(at)))
  return wrap
}

/** 一行"谁说了什么"(气泡)。`who` 决定颜色,不是靠猜 —— 判据见 saidLabel()。
 *  他/她的话最长给 220 字(以前 150,常把一句完整的话截断,读着像没说完),
 *  全文永远在展开区里。 */
function bubble (who, text, cls) {
  const row = el('div', 'tbub ' + (cls || ''))
  // 冒号保留:`tbub-who` 是"谁说的"的标签,测试与老契约都按「〈称呼〉:」这种形状认。
  // 颜色按**名字**分流 —— 名字从 profile 来,所以这里比的是 P() 里那两个,不是字面量。
  const nameCls = who === P().agentName ? 'me' : (who === P().userName ? 'you' : 'sys')
  row.appendChild(el('span', 'tbub-who ' + nameCls, who + ':'))
  const body = el('span', 'tbub-text')
  const q = qOf('au-q')
  body.appendChild(hl(clip(stripEnvelope(text), 220), q))
  row.appendChild(body)
  return row
}

/** 轮卡片:一行"谁说了什么" + 折叠行;点开是这一轮的全部(注入全文 + 后台明细 + 原始行)。
 *
 * 2026-09-29 重排的取舍(对着他自己的截图改的):
 *   · 头行**先时间后类别**,时间用人话(「12 分钟前」),绝对时间进 title;
 *   · 来源(QQ / DSH / 陪伴 / 子代理 / 全局)与来源色**显式标出** —— 一眼看出
 *     "这条是 QQ 上的,还是她在自己窗口里干的";
 *   · 后台/干活**折进轮脚下**:`⛭ 后台 9 次 · 🛠 干活 2 次`,点这行就展开;
 *   · 机器内容(关键词/情绪/摘要)在折叠行里就给一行标签 —— 不点开也有信息。
 */
function turnCard (turn) {
  const v = V()
  const id = turn.id
  const open = auditOpen.has(id)
  const item = el('div', 'ar turn k-' + turn.bucket + (open ? ' open' : ''))
  const primary = turn.rows.find((r) => injText(r).length > 0) || turn.out[0] || turn.in ||
    turn.reflect || turn.rows[0]
  // 来源看**工具**(rowSource):裁定 A 之后 QQ 的话记在他的窗口账上,按会话标会说反
  const srcKey = v.rowSource(primary)
  const src = v.SOURCES[srcKey] || v.SOURCES.bg
  // 人话标签**只给机器行用**:说话那几轮的头行已经有人话了,再贴一行"原文"就等于
  // 把信封/桥元数据(`[QQ:私聊] …`、`(用 QQ 说) …`)搬回折叠行上 —— 2026-09-27 那条
  // 契约(「信封/桥元数据不该出现在面板上」)正是这么被测试抓住的。
  const meta = ['machine', 'work', 'other', 'bridge'].indexOf(turn.bucket) >= 0 ? v.machineTags(primary) : []

  const head = el('div', 'ar-head')
  head.appendChild(el('span', 'ar-caret', '▶'))
  const m = el('div', 'ar-meta')
  m.appendChild(el('span', 't', v.relTime(turn.time, Date.now())))
  m.title = fmtTime(turn.time)
  const badge = el('span', 'badge bk-' + turn.bucket, (v.BUCKETS[turn.bucket] || v.BUCKETS.other).icon + ' ' + turnKind(turn))
  badge.title = (v.BUCKETS[turn.bucket] || v.BUCKETS.other).desc
  m.appendChild(badge)
  const sBadge = el('span', 'src ' + src.cls, src.label)
  sBadge.title = src.title + (turn.sessions.length > 0 ? ' · 会话 ' + turn.sessions.join(', ') : '')
  m.appendChild(sBadge)
  if (turn.sessions.length > 0 && v.shortSid(turn.sessions[0]) !== '' && srcKey !== 'qq') {
    m.appendChild(el('span', 'dim', v.shortSid(turn.sessions[0])))
  }
  if (typeof primary.latency === 'number' && primary.latency > 0) {
    const sec = primary.latency / 1000
    m.appendChild(el('span', sec >= 20 ? 'bad' : (sec >= 10 ? 'warn' : null), '用时 ' + sec.toFixed(1) + 's'))
  }
  const injLen = injText(primary).length
  if (injLen > 0) m.appendChild(el('span', null, '注入 ' + injLen + ' 字'))
  if (typeof primary.moodIntensity === 'number' && primary.moodIntensity > 0) {
    m.appendChild(el('span', null, '心情 ' + primary.prevMoodIntensity + '→' + primary.moodIntensity))
  }
  // 后台/干活行的标签**另起一行**放在头行下面(2026-09-29 晚:挤在头行里会把
  // "25 分钟前 / 对话 / DSH / 用时 / 注入 / 心情"那条主线读断,而且窄屏下标签本身
  // 会被压成竖条)。不点开也有信息,但主线永远清爽。
  if (meta.length > 0) {
    const tagRow = el('div', 'tag-row')
    for (const t of meta.slice(0, 3)) {
      const tag = el('span', 'tag')
      tag.appendChild(el('span', 'tag-k', t.k))
      tag.appendChild(el('span', 'tag-v', clip(t.v, 80)))
      tagRow.appendChild(tag)
    }
    item.appendChild(tagRow)
  }
  head.appendChild(m)
  item.appendChild(head)

  // ① 他的话(桥行;DSH 窗口那种没有桥行的轮次,他的话在 extract 行里)
  const hisRow = turn.in !== null
    ? turn.in
    : (turn.reflect !== null && turn.out.length === 0 ? turn.reflect : null)
  if (hisRow !== null && String(hisRow.userInput || '') !== '') {
    item.appendChild(bubble(saidLabel(hisRow.toolCall, hisRow.userInput), hisRow.userInput, 'you'))
  }
  // ② 她真发出去的话(桥副本只记一笔)
  if (turn.out.length > 0) {
    const row = bubble(P().agentName, turn.out[0].userInput, 'me')
    if (turn.out.length > 1) row.appendChild(el('span', 'dim', '(+' + (turn.out.length - 1) + ' 条桥副本)'))
    item.appendChild(row)
  }
  // ③ 提取器的第三人称旁白 —— 标清是谁,不再冒充她
  if (turn.reflect !== null && String(turn.reflect.llmReply || '') !== '') {
    item.appendChild(bubble(replyLabel(turn.reflect.toolCall), turn.reflect.llmReply, 'note'))
  }
  // ④ 没说过话的轮(系统 / 桥 / 后台 / 干活 / 提取):一行一件事
  if (turn.in === null && turn.out.length === 0 && turn.reflect === null) {
    const r = turn.rows[0]
    const line = el('div', 'tbub note')
    line.appendChild(el('span', 'tbub-who sys', (v.BUCKETS[turn.bucket] || v.BUCKETS.other).icon))
    line.appendChild(el('span', 'tbub-text', toolLabel(r.toolCall) + ' · ' + clip(stripEnvelope(r.userInput), 200)))
    item.appendChild(line)
    if (turn.rows.length > 1) item.appendChild(el('div', 'dim au-more', '(+' + (turn.rows.length - 1) + ' 行同轮,点开看)'))
  }
  // ⑤ 这一轮脚底下折着的东西(后台 / 干活 / 系统 / 桥):数得清、点得开
  const extra = turn.extra.filter((r) => {
    const b = v.classify(r).bucket
    return !(b === 'reflect' && r === turn.reflect)
  })
  if (extra.length > 0) {
    const counts = {}
    for (const r of extra) {
      const b = v.classify(r).bucket
      counts[b] = (counts[b] || 0) + 1
    }
    const foldLine = el('div', 'foldline')
    const bits = Object.keys(counts).sort((a, b) => (v.BUCKETS[a] || v.BUCKETS.other).rank - (v.BUCKETS[b] || v.BUCKETS.other).rank)
      .map((b) => (v.BUCKETS[b] || v.BUCKETS.other).icon + ' ' + (v.BUCKETS[b] || v.BUCKETS.other).label + ' ' + counts[b] + ' 次')
    foldLine.appendChild(el('span', null, bits.join(' · ')))
    foldLine.appendChild(el('span', 'dim', open ? '收起来' : '点开看明细'))
    foldLine.onclick = (ev) => { if (ev) ev.stopPropagation(); toggleTurn(id) }
    item.appendChild(foldLine)
    // '全部' 档:折着的内容也摆出来(一行一条人话,'排障' 档另有原始行视角)
    if (auMode === 'all') for (const r of extra) item.appendChild(machineLine(r, false))
  }

  head.onclick = () => toggleTurn(id)
  if (open) {
    item.appendChild(auditDetail(primary))
    // 展开区最后**永远**附上这一轮的原始行 —— 信息全面在这里兜底
    item.appendChild(rawRowsBlock(turn))
  }
  return item
}

/** 展开/收起一轮(点折叠行也走这里)。右栏默认展开,但他手动收起过的那一轮
 *  不该被 10 秒轮询又掰开 —— 所以"收起来"要记在 auditClosed 里。 */
function toggleTurn (id) {
  if (auditOpen.has(id)) { auditOpen.delete(id); auditClosed.add(id) }
  else {
    auditClosed.delete(id); auditOpen.add(id)
    // ★ 2026-10-08 F3:点开详情就**冻结刷新** —— 读长文时不再被 10 秒轮询 / 审计 SSE
    // 重建打断(重建还会顺带把滚动位置顶回去)。右栏给"继续刷新"按钮,随时可解除;
    // 工具条的"冻结"勾选框同步亮起(`setFrozen` 一并写它)。
    if (!frozen) setFrozen(true)
  }
  drawAudit()
}

/** 后台/干活行的一行画法:时间 · 人话工具名 · 人话标签 · 会话;原文在它自己的 title 里。 */
function machineLine (r, raw) {
  const v = V()
  const line = el('div', 'mline')
  line.appendChild(el('span', 'ml-time', v.relTime(r.timestamp, Date.now())))
  line.appendChild(el('span', 'ml-tool', v.toolHuman(r.toolCall)))
  const tags = v.machineTags(r)
  if (tags.length === 0) line.appendChild(el('span', 'dim', '(没有可读内容,展开看原文)'))
  for (const t of tags) {
    const tag = el('span', 'tag')
    tag.appendChild(el('span', 'tag-k', t.k))
    tag.appendChild(el('span', 'tag-v', clip(t.v, 140))) // 值单独一层:太长就省略号,不折成竖条
    line.appendChild(tag)
  }
  const sid = v.shortSid(r.sessionId)
  if (sid !== '') line.appendChild(el('span', 'dim ml-sid', sid))
  if (raw) {
    const pre = el('pre', 'raw')
    pre.textContent = String(r.userInput === undefined || r.userInput === null ? '' : r.userInput)
    line.appendChild(pre)
  }
  line.title = String(r.userInput || '')
  return line
}

/** 展开区最后一块:**这一轮的全部原始审计行**(一条不藏,排障时救命)。
 *  默认收起,点标题展开 —— 平时不占地方,要查的时候一行不少。 */
function rawRowsBlock (turn) {
  const v = V()
  const wrap = el('div', 'raw-wrap')
  const head = el('div', 'sec-head')
  head.appendChild(el('span', 'sec-caret', '▶'))
  head.appendChild(el('span', 'sec-name', '原始审计行 · ' + turn.rows.length + ' 行(工具原名 / 会话 / trace / 全文)'))
  wrap.appendChild(head)
  const body = el('div', 'raw-body')
  for (const r of turn.rows) {
    const one = el('div', 'raw-one')
    const line1 = el('div', 'raw-hd')
    line1.appendChild(el('span', 'mono', fmtTime(r.timestamp)))
    line1.appendChild(el('span', 'badge bk-' + v.classify(r).bucket, r.toolCall === '' ? '(对话)' : String(r.toolCall)))
    const sid = String(r.sessionId || '')
    if (sid !== '') line1.appendChild(el('span', 'mono dim', sid))
    if (String(r.traceId || '') !== '') line1.appendChild(el('span', 'mono dim', 'trace ' + String(r.traceId).slice(0, 8)))
    if (typeof r.latency === 'number' && r.latency > 0) line1.appendChild(el('span', 'mono dim', (r.latency / 1000).toFixed(1) + 's'))
    one.appendChild(line1)
    for (const [k, val] of [['他的输入', r.userInput], ['她的回复', r.llmReply], ['余波', r.extraReply]]) {
      if (String(val || '') === '') continue
      const pre = el('pre', 'raw')
      pre.textContent = k + ': ' + String(val)
      one.appendChild(pre)
    }
    body.appendChild(one)
  }
  body.style.display = 'none'
  head.onclick = () => {
    const shown = body.style.display !== 'none'
    body.style.display = shown ? 'none' : 'block'
    head.firstChild.textContent = shown ? '▶' : '▼'
  }
  wrap.appendChild(body)
  return wrap
}

/** 展开区:这一轮她实际读到的全部东西(注入全文 + 情绪包 + 状态 + 向量)。 */
function auditDetail (r) {
  const body = el('div', 'ar-body')
  const open = auSectionsOpen
  const inj = injText(r)
  if (inj !== '') {
    body.appendChild(secBox('本轮注入全文 · ' + inj.length + ' 字', injectionSections(inj, open), open))
  } else {
    body.appendChild(el('div', 'hint', '这一轮没有注入记忆块(桥/工具类审计行本来就不注入;或当时检索为空)。'))
  }
  if (String(r.injectedProfile || '') !== '') {
    body.appendChild(secBox('注入画像 · ' + String(r.injectedProfile).length + ' 字', el('div', 'sec-text', r.injectedProfile), open))
  }
  if (String(r.emotionPack || '') !== '') {
    body.appendChild(secBox('情绪包 · ' + String(r.emotionPack).length + ' 字', el('div', 'sec-text', r.emotionPack), open))
  }
  // 第三批(2026-10-05):联合空间结构化读数(影子模式的产物)。**只读展示**:
  // 面板不做任何换算,照原样摊开 —— `bridgeErr`、共享轴两侧读数(sPad / sIpc)、
  // 降级原因都在里面;解析失败就原样显示字符串(绝不因为一格 JSON 坏掉就不显示)。
  if (String(r.emotionPackStructured || '').trim() !== '') {
    let pretty = String(r.emotionPackStructured)
    try { pretty = JSON.stringify(JSON.parse(pretty), null, 2) } catch { /* 原样显示 */ }
    body.appendChild(secBox('联合空间读数 · ' + String(pretty.length) + ' 字', el('div', 'sec-text', pretty), false))
  }
  if (r.agentState && typeof r.agentState === 'object') {
    body.appendChild(secBox('内部状态', el('div', 'sec-text', JSON.stringify(r.agentState, null, 2)), open))
  }
  if (r.emotionVector && typeof r.emotionVector === 'object') {
    body.appendChild(secBox('情绪向量', vectorBlock(r.emotionVector), open))
  }
  if (String(r.emotionDelta || '') !== '') {
    body.appendChild(secBox('情绪差分', el('div', 'sec-text', r.emotionDelta), open))
  }
  if (r.sayAgain === 1 && r.extraReply) {
    body.appendChild(secBox('情绪余波', el('div', 'sec-text', r.extraReply), open))
  }
  return body
}

/** 七维向量 → 横条(与情绪面板同一套画法,展开区里复用)。 */
function vectorBlock (vec) {
  const wrap = el('div')
  for (const [key, title, dims] of VEC_GROUPS) {
    const group = vec[key] || {}
    wrap.appendChild(el('div', 'sec-name', title))
    for (const [dk, dl] of dims) {
      const v = Number(group[dk] ?? 0)
      const row = el('div', 'vec-row')
      row.appendChild(el('span', 'vec-name', dl))
      const track = el('div', 'vec-bar')
      const bar = el('div')
      bar.style.width = Math.min(100, v * 10) + '%'
      bar.style.background = vecColor(v)
      track.appendChild(bar)
      row.appendChild(track)
      const cls = v > 6 ? 'hot' : (v > 3 ? 'mid' : 'calm')
      row.appendChild(el('span', 'vec-val ' + cls, v.toFixed(1)))
      wrap.appendChild(row)
    }
  }
  return wrap
}

// ---- 🔍 注入透视(2026-09-27 新增)----
// 他问「她到底怎么调用记忆的?是把所有细节全塞进上下文吗?」—— 答案在
// 审计表的 injected_memories 列里逐字躺着(实测每轮 1.3k~2.2k 字符,
// 只挑 1~2 条情景记忆),但此前**面板上完全看不到**,只能直接翻 SQLite。
// 这一节把注入块按【小标题】拆成可展开的小节,并标出每段吃多少字。
let lastInj = null

/** 把注入块按【…】/[… ] 小标题切成 {name, text} 段(顺序即渲染顺序)。
 *  实测一个真实注入块拆出 11 段(总标题 / 现在 / 时间纪律 / 关联知识路径 /
 *  情景记忆 / 她此刻的状态 / 他的称呼 / 他的画像 / 使用纪律 / 别处刚说过的 /
 *  你刚主动说过),段字数合计 + 标题行 ≈ 原文长度。 */
function splitInjection (text) {
  const lines = String(text || '').split('\n')
  const secs = []
  let cur = null
  for (const line of lines) {
    const m = line.match(/^\s*(?:【([^】]+)】|\[([^\]]+)\])/)
    if (m) {
      const raw = (m[1] || m[2] || '').trim()
      const rest = line.replace(/^\s*(?:【[^】]+】|\[[^\]]+\])/, '').trim()
      // 「[核心] …」这种是记忆条目的前缀,不是小标题 —— 只有整行就是标题才算
      if (rest === '' || /^(现在|时间纪律|关联知识路径|情景记忆|她此刻的状态|他的称呼|他的画像|使用纪律|别处刚说过的|你刚主动说过|你刚才被插嘴了)/.test(raw)) {
        // 首行那条「[她的记忆与心情 - 只属于你的真实过往,不可对外提及]」是
        // 整块的抬头,不是内容段 —— 给个短名,全文留着做悬停提示
        const isBanner = secs.length === 0 && rest === ''
        const name = isBanner ? '总标题' : (raw.length > 20 ? raw.slice(0, 20) + '…' : raw)
        cur = { name, fullName: raw, text: rest, lines: rest === '' ? [] : [rest] }
        secs.push(cur)
        continue
      }
    }
    if (cur === null) { cur = { name: '开头', fullName: '开头', text: '', lines: [] }; secs.push(cur) }
    cur.lines.push(line)
  }
  for (const s of secs) s.text = s.lines.join('\n').trim()
  return secs.filter((s) => s.name !== '' || s.text !== '')
}

/** 段的语气色(哪一段是记忆、哪一段是情绪,一眼分开)。 */
function secTone (name) {
  if (/情景记忆|关联知识路径/.test(name)) return 'tone-mem'
  if (/知识路径/.test(name)) return 'tone-graph'
  if (/状态|情绪|感受/.test(name)) return 'tone-mood'
  if (/别处|共享|插嘴/.test(name)) return 'tone-shared'
  if (/时间|纪律|使用|画像|称呼/.test(name)) return 'tone-rule'
  if (/现在/.test(name)) return 'tone-now'
  return ''
}

async function renderInjection () {
  const box = $('inj-body'); const meta = $('inj-meta'); const chips = $('inj-chips')
  const data = await api('/api/echo/audit?limit=40')
  const rows = (data && Array.isArray(data.rows)) ? data.rows : []
  // 取最近一条**真的有注入**的轮次(桥/工具行没有注入块)
  lastInj = rows.find((r) => injText(r).length > 0) || null
  if (lastInj === null) {
    fill(chips, [])
    // 说清"为什么空"——否则他会以为面板坏了(实际是后端还没重启)
    const anyRow = rows.length > 0
    meta.textContent = anyRow
      ? '最近 40 条审计里没有带注入的轮次 —— 和她说句话再看。(若下面审计流里明明有对话行,说明后端还在跑旧版 store.js:注入列被当成 JSON 解析成了 {}，重启 dsh web 后即恢复)'
      : '审计表是空的 —— 和她说句话再看。'
    fill(box, [])
    return
  }
  const inj = injText(lastInj)
  const secs = splitInjection(inj)
  const total = secs.reduce((n, s) => n + s.text.length, 0) || inj.length
  fill(meta, [
    el('div', null, '最近一次注入:' + fmtTime(lastInj.timestamp) + ' · ' + toolLabel(lastInj.toolCall)
      + ' · 会话 ' + clip(lastInj.sessionId, 12) + ' · 正文 ' + total + ' 字 / 原文 ' + inj.length + ' 字 / ' + secs.length + ' 段'),
    el('div', 'dim', saidLabel(lastInj.toolCall, lastInj.userInput) + ' 这一轮说:'
      + clip(stripEnvelope(lastInj.userInput), 120))
  ])
  // 体积条:谁在吃 token 一眼看出来
  const palette = ['#4cc2f5', '#34d399', '#a78bfa', '#fbbf24', '#f87171', '#7dd3fc', '#6ee7b7', '#c4b5fd']
  const vol = el('div', 'vol')
  const legend = el('div', 'vol-legend')
  secs.forEach((s, i) => {
    const n = s.text.length
    if (n === 0) return
    const color = palette[i % palette.length]
    const seg = el('i')
    seg.style.width = (n / Math.max(1, total) * 100) + '%'
    seg.style.background = color
    vol.appendChild(seg)
    const lg = el('span')
    const dot = el('i'); dot.style.background = color
    lg.appendChild(dot)
    lg.appendChild(el('span', null, s.name + ' ' + n + ' 字'))
    legend.appendChild(lg)
  })
  fill(chips, [
    el('span', 'chip plain', '正文 ' + total + ' 字'),
    el('span', 'chip plain', secs.length + ' 段'),
    el('span', 'chip plain', '最大段:' + (secs.slice().sort((a, b) => b.text.length - a.text.length)[0] || {}).name)
  ])
  const nodes = [vol, legend]
  for (const s of secs) {
    nodes.push(secBlock(s.name, s.text, secTone(s.name), s.fullName))
  }
  fill(box, nodes)
}

/** 一个可展开的小节(注入透视与审计展开区共用)。
 *  2026-09-27:0 字的「抬头行」不许做成可点 —— 点开是空白,看着像坏了。
 *  它本来就只有一行标题,直接把全文当名字显示(不截断),也不给箭头。 */
function secBlock (name, text, tone, fullName) {
  if (text.length === 0) {
    const flat = el('div', 'sec sec-flat' + (tone ? ' ' + tone : ''))
    const row = el('div', 'sec-head')
    row.appendChild(el('span', 'sec-name', fullName || name))
    row.appendChild(el('span', 'sec-n', '抬头行'))
    flat.appendChild(row)
    return flat
  }
  const open = injOpen.has(name)
  const box = el('div', 'sec' + (open ? ' open' : '') + (tone ? ' ' + tone : ''))
  const head = el('div', 'sec-head')
  head.appendChild(el('span', 'sec-caret', '▶'))
  head.appendChild(el('span', 'sec-name', name))
  head.appendChild(el('span', 'sec-n', text.length + ' 字'))
  if (fullName && fullName !== name) head.setAttribute('title', fullName)
  head.onclick = () => {
    if (injOpen.has(name)) injOpen.delete(name)
    else injOpen.add(name)
    renderInjection().catch(() => {})
  }
  box.appendChild(head)
  if (open) box.appendChild(el('div', 'sec-body', text))
  return box
}

/** 展开了哪些注入小节(按段名记,跨重画保留)。 */
const injOpen = new Set()

/** 审计展开区里的注入:与注入透视同一套拆段,但默认全展开(点开就是要看)。 */
function injectionSections (text, open) {
  const wrap = el('div')
  for (const s of splitInjection(text)) {
    if (s.text.length === 0) {
      // 抬头行:一行标题而已,不给可滚动的空盒子
      const flat = el('div', 'sec sec-flat' + (secTone(s.name) ? ' ' + secTone(s.name) : ''))
      const row = el('div', 'sec-head')
      row.appendChild(el('span', 'sec-name', s.fullName || s.name))
      row.appendChild(el('span', 'sec-n', '抬头行'))
      flat.appendChild(row)
      wrap.appendChild(flat)
      continue
    }
    // 默认收起(除非「全部展开」开着):标题行给"段名 + 字数",点开才铺正文。
    // 2026-09-29 第三轮:他说"能读了但太冗杂",而这一层原来**永远是开的** ——
    // 点开一轮就是几屏文本,折叠等于没有。
    const opened = open === true
    const box = el('div', 'sec' + (opened ? ' open' : '') + (secTone(s.name) ? ' ' + secTone(s.name) : ''))
    const head = el('div', 'sec-head')
    head.appendChild(el('span', 'sec-caret', '▶'))
    head.appendChild(el('span', 'sec-name', s.name))
    head.appendChild(el('span', 'sec-n', s.text.length + ' 字'))
    if (s.fullName && s.fullName !== s.name) head.setAttribute('title', s.fullName)
    box.appendChild(head)
    const secBody = el('div', 'sec-body', s.text)
    secBody.style.display = opened ? '' : 'none'
    head.onclick = () => {
      const on = box.className.indexOf('open') < 0
      box.className = box.className.replace(/\s*\bopen\b/, '') + (on ? ' open' : '')
      secBody.style.display = on ? '' : 'none'
    }
    box.appendChild(secBody)
    wrap.appendChild(box)
  }
  return wrap
}

// ---- 📖 日记 ----
// ---- 📌 悬置话题(O5,v0.22.0;2026-10-06 D5 扩五档)----
// 这一区以前**只有 API 没有 UI**,而 README 早就写了「悬置话题」——
// 文档与实现不一致是答辩会场最容易被问的那种。
// 判据全在 `store.listThreads`(四态桶 + 冷却/已了结/归档三档),这里只渲染:
//   活跃(waiting/due/untimed/done 四个子桶,位置不变)
//   / 冷却(cooling_at>0)/ 已了结(status='resolved')/ 归档(archived_at>0,**默认折叠**)
// 每行带 kind 徽标;面板**只读**,写通路仍然只有 `/threads/act` 那一个口。
const TH_KINDS = {
  promise: '承诺', schedule: '行程', reminder: '提醒', care: '关心', topic: '话题', '': '未分类'
}

async function renderThreads () {
  const box = $('th-list')
  const grid = $('th-grid')
  const badge = $('th-count')
  const data = await api('/api/echo/threads')
  if (!data || data.offline === true) {
    if (badge) badge.textContent = '离线'
    fill(grid, [])
    fill(box, [el('div', 'empty', '引擎不在 —— 悬置话题由引擎侧的反思归纳登记。')]); return
  }
  const activeBuckets = [
    ['due', '🔔 到点(该催办了)', 'due'],
    ['waiting', '⏳ 等待中', 'wait'],
    ['untimed', '🗒️ 不定时(只记着)', 'unt'],
    ['done', '✅ 她提过了(算兑现)', 'done']
  ]
  const cooling = Array.isArray(data.cooling) ? data.cooling : []
  const resolved = Array.isArray(data.resolved) ? data.resolved : []
  const archived = Array.isArray(data.archived) ? data.archived : []
  const activeCount = activeBuckets.reduce((n, [k]) => n + ((data[k] || []).length), 0)
  const total = activeCount + cooling.length + resolved.length + archived.length
  if (badge) badge.textContent = total + ' 条'
  fill(grid, [
    statCard(activeCount, '🟢 活跃(还在惦记)'),
    statCard(cooling.length, '🌙 冷却(不再问,还记着)'),
    statCard(resolved.length, '✅ 已了结'),
    statCard(archived.length, '📦 归档(默认折叠)')
  ])
  if (total === 0) {
    fill(box, [el('div', 'empty', '她手上没有悬着的事 —— 你说「明天九点提醒我面试」这种,才会登记进来。')])
    return
  }
  const items = []
  const cardOf = (r, cls) => {
    const card = el('div', 'th ' + cls)
    const head = el('div', 'th-main', r.content || '(空)')
    card.appendChild(head)
    const meta = []
    const kind = String(r.kind || '')
    if (kind !== '') meta.push(TH_KINDS[kind] || kind)
    if (Number(r.followUpAfter) > 0) meta.push('到点 ' + fmtTime(r.followUpAfter))
    if (Number(r.secondsLeft) > 0 && cls === 'wait') meta.push('还有 ' + fmtDur(r.secondsLeft))
    if (Number(r.lastMentionedAt) > 0) meta.push('她 ' + fmtTime(r.lastMentionedAt) + ' 提过')
    if (Number(r.coolingAt) > 0) meta.push('冷却于 ' + fmtClock(r.coolingAt))
    if (Number(r.archivedAt) > 0) meta.push('归档于 ' + fmtClock(r.archivedAt))
    if (Number(r.supersededBy) > 0) meta.push('被 #' + Number(r.supersededBy) + ' 取代')
    if (Number(r.updatedAt) > 0) meta.push('更新于 ' + fmtClock(r.updatedAt))
    if (meta.length > 0) card.appendChild(el('div', 'th-meta', meta.join(' · ')))
    return card
  }
  for (const [k, label, cls] of activeBuckets) {
    const rows = data[k] || []
    if (rows.length === 0) continue
    items.push(el('h3', null, label + '(' + rows.length + ')'))
    for (const r of rows) items.push(cardOf(r, cls))
  }
  if (cooling.length > 0) {
    items.push(el('h3', null, '🌙 冷却中(' + cooling.length + ')—— 还记着,但不再问了'))
    for (const r of cooling) items.push(cardOf(r, 'cool'))
  }
  if (resolved.length > 0) {
    items.push(el('h3', null, '✅ 已了结(' + resolved.length + ')'))
    for (const r of resolved) items.push(cardOf(r, 'done'))
  }
  if (archived.length > 0) {
    // 归档默认折叠:它只是留档,展开才有内容(默认收起 = 不占视线)
    const details = el('details', 'th-fold')
    details.appendChild(el('summary', null, '📦 已归档(' + archived.length + ')—— 点开看留档'))
    for (const r of archived) details.appendChild(cardOf(r, 'arch'))
    items.push(details)
  }
  fill(box, items)
}

let lastDiary = []
async function renderDiary () {
  const data = await api('/api/echo/diary')
  lastDiary = (data && Array.isArray(data.rows)) ? data.rows : []
  drawDiary()
}

/** 纯画:日记(检索词过滤日期与正文)。 */
function drawDiary () {
  const box = $('di-list')
  if (lastDiary.length === 0) {
    fill(box, [el('div', 'empty', '她还没写过日记 —— 每晚 22:30 一页,今晚就有。')]); return
  }
  const q = qOf('di-q')
  const rows = lastDiary.filter((r) => hit(q, r.date, r.content))
  if (rows.length === 0) { fill(box, [el('div', 'empty', '没有匹配「' + q + '」的日记。')]); return }
  fill(box, rows.map((r) => {
    const card = el('div', 'diary')
    card.appendChild(el('div', 'date', r.date + ' · 心情 ' + (r.mood ?? 3) + '/10 · 想念 ' + (r.longingValue ?? 0)))
    card.appendChild(el('div', 'body', r.content || ''))
    return card
  }))
}

// ---- ⚙️ 范围 ----
async function renderScope () {
  const box = $('sc-info')
  const data = await api('/api/echo/scope')
  if (!data) { fill(box, [el('div', 'loading', '拉取失败')]); return }
  const labelOf = {}
  for (const s of (data.sessions || [])) labelOf[s.sessionId] = s.label || ''
  const line1 = el('div')
  line1.appendChild(el('b', null, '模式:' + (data.scope === 'whitelist' ? '白名单(仅列表内会话启用)' : '全部会话(例外除外)')))
  const mkList = (title, ids) => {
    if (!ids || ids.length === 0) return el('div', null, title +':无')
    const div = el('div')
    const parts = [title + ':']
    for (const id of ids) parts.push(clip(id, 8) + (labelOf[id] ? '(' + labelOf[id] + ')' : ''))
    div.textContent = parts.join(' ')
    return div
  }
  fill(box, [line1,
    mkList(data.scope === 'whitelist' ? '白名单' : '例外(关闭)', data.scope === 'whitelist' ? data.whitelist : data.exempt),
    mkList('硬关名单(不会被自动打开)', data.manualOff || []),
    powerPanel(data),
    el('div', null, '会话内发「Echo 上线」/「Echo 下线」切当前会话;设置区 Echo 段有完整管理。'),
    clearPanel(data, labelOf)])
}

/** 硬开关(2026-09-26 他要的按钮)。
 *  以前这里只有一行字:「会话内发 Echo 下线」—— 而那条路要求整条消息正好
 *  等于四个字,不匹配时一声不吭,写进去还会被 autoScope 静默覆盖。
 *  现在:总闸按钮 + 每个会话的硬开关按钮,与工具/面板写同一份 config。 */
function powerPanel (data) {
  const box = el('div', 'clear-panel')
  const head = el('div')
  head.appendChild(el('b', null, '硬开关:'))
  const state = el('span', 'clear-out', '')
  const btn = el('button', 'btn', '…')
  const refresh = (st) => {
    const on = st ? st.enabled !== false : true
    btn.textContent = on ? '让她休眠(总闸)' : '唤醒她(总闸)'
    state.textContent = on ? '现在:在线' : '现在:休眠'
  }
  btn.onclick = async () => {
    btn.disabled = true
    try {
      const st = await api('/api/echo/status')
      const next = !(st && st.enabled !== false)
      const r = await apiPost('/api/echo/toggle', { enabled: next })
      refresh(r)
      state.textContent += r.by ? '(由 ' + r.by + ' 拨的)' : ''
    } catch (err) {
      state.textContent = '请求失败:' + err
    } finally {
      btn.disabled = false
    }
  }
  api('/api/echo/status').then((st) => refresh(st)).catch(() => refresh(null))
  head.appendChild(btn)
  head.appendChild(state)
  box.appendChild(head)
  box.appendChild(el('div', null, '休眠 = 不注人格、不注记忆、不捕获、不反思、不主动开口。插件本体与这只开关不受影响。'))

  const ids = (data.sessions || []).map((s) => s.sessionId)
  if (ids.length === 0) return box
  const hard = data.manualOff || []
  box.appendChild(el('div', null, '按会话硬开关(关掉的记进硬关名单,不会被自动打开):'))
  for (const id of ids) {
    const on = data.scope === 'whitelist' ? (data.whitelist || []).includes(id) : !(data.exempt || []).includes(id)
    const row = el('div', 'clear-row')
    row.appendChild(el('span', null, clip(id, 18) + (hard.includes(id) ? ' · 硬关' : '')))
    const b = el('button', 'btn', on ? '此会话下线' : '此会话上线')
    const out = el('span', 'clear-out', '')
    b.onclick = async () => {
      b.disabled = true
      try {
        const r = await apiPost('/api/echo/scope', { sessionId: id, on: !on })
        out.textContent = r.ok === false ? ('失败:' + (r.error || '')) : '已' + (on ? '下线' : '上线')
        renderScope()
      } catch (err) {
        out.textContent = '请求失败:' + err
      } finally {
        b.disabled = false
      }
    }
    row.appendChild(b)
    row.appendChild(out)
    box.appendChild(row)
  }
  return box
}

/** 「清空她的上下文」——2026-09-26 他要的按钮。
 *  它不自己删历史(插件没这只手):调宿主的压缩服务 compactNow,把旧历史整段
 *  压成一条摘要(宿主 /compact 同一条路,retain 0)。旧消息从她视野里消失,
 *  会话记录仍在。 */
function clearPanel (data, labelOf) {
  const box = el('div', 'clear-panel')
  box.appendChild(el('div', null, '清空她的上下文(旧历史压成一条摘要,记录不删):'))
  const ids = data.scope === 'whitelist' ? (data.whitelist || []) : (data.sessions || [])
    .map((s) => s.sessionId).filter((id) => !(data.exempt || []).includes(id))
  const list = ids.length > 0 ? ids : (data.sessions || []).map((s) => s.sessionId)
  for (const id of list) {
    const row = el('div', 'clear-row')
    row.appendChild(el('span', null, clip(id, 18) + (labelOf[id] ? '(' + labelOf[id] + ')' : '')))
    const btn = el('button', 'btn', '清空上下文')
    const out = el('span', 'clear-out', '')
    btn.onclick = async () => {
      btn.disabled = true
      out.textContent = '正在清…(她得是闲着的,可能要几十秒)'
      try {
        const r = await apiPost('/api/echo/context/clear', { sessionId: id })
        out.textContent = r.text || JSON.stringify(r)
      } catch (err) {
        out.textContent = '请求失败:' + err
      } finally {
        btn.disabled = false
      }
    }
    row.appendChild(btn)
    row.appendChild(out)
    box.appendChild(row)
  }
  return box
}

// ---- 🎛️ 调参(2026-09-26 从 DSH 设置区搬来)----
// 字段表**不在这里**:由 GET /api/echo/settings 的 fields 发下来
// (lib/settings-fields.js 是唯一一份;钳位规则只在 toggle.js 一处)。
// 这一页不进 10 秒轮询 —— 打字打到一半被重画覆盖是典型的自伤,
// 所以只在进页面时拉一次,外加一个「重新拉取」按钮。
let cfgData = null
let cfgForm = null

// ---- 🧰 子代理记忆工具开关(2026-10-01 阶段 2f)----
// 他的裁定:「`memorySubagentTools` 的 true/false **应当也能在网页仪表盘里改**才对。」
// 以前只能手改 `$DSH_HOME/profiles/web/cordis.patch.yml`。
//
// 这张卡落在 `#cfg-mt`(**不在** `#cfg-form` 里面 —— 那一格的输入框数被
// tests/web-dashboard.test.js 钉成"正好等于字段表条数";而且它**刻意不是调参项**:
// 它落 config.json 顶层,与 enabled / scope 同层,见 lib/toggle.js `readMemoryTools()`)。
// 拨一下 = 一次 `POST /api/echo/memory-tools`;后端落盘后**当场**注册/摘除那 4 个只读工具
// ⇒ **立即生效,不用重启宿主**。状态栏照实显示:三路读数 + 来源 + "真挂上了没有"。
let mtState = null

async function renderMemoryTools () {
  try { mtState = await api('/api/echo/memory-tools') } catch { mtState = null }
  drawMemoryTools()
}

function drawMemoryTools () {
  const box = $('cfg-mt')
  if (!box) return
  if (mtState === null) {
    fill(box, [el('div', 'hint', '子代理记忆工具:读数拉取失败(不影响上面的调参)')])
    return
  }
  const on = mtState.on === true
  const src = mtState.sources || {}
  const row = el('label', 'cfg-row')
  const input = el('input', 'cfg-input')
  input.type = 'checkbox'
  input.checked = mtState.panelValue === true
  input.onchange = () => { saveMemoryTools(input.checked, input).catch(() => {}) }
  row.appendChild(el('span', 'cfg-name', '给子代理开只读记忆工具'))
  row.appendChild(input)
  row.appendChild(el('span', 'cfg-hint',
    '默认关。开 = 给子代理那一轮挂 4 个只读记忆工具(memory_search / memory_get / memory_neighbors / memory_timeline);'
    + '打开时**主会话也会看到**这 4 个 —— 宿主 toolFilter 是 restrict 语义(只能从继承来的工具面里拿掉)。'
    + '拨一下**立即生效**,不用重启宿主。'))
  const state = el('div', 'hint', '现在:' + (on ? '开' : '关')
    + ' · 来源:' + String(mtState.sourceLabel === undefined ? (mtState.source || '—') : mtState.sourceLabel)
    + (on
      ? ' · ' + (mtState.applied === true
        ? ('已注册 ' + String(mtState.registered) + ' 个只读工具(子代理那一轮现在就能查)')
        : ('**没挂上**(原因:' + String(mtState.reason === undefined ? '未知' : mtState.reason) + ')'))
      : ''))
  const three = el('div', 'hint', '三路读数 —— env:' + (src.env === true ? '开' : '关')
    + ' · 宿主配置 cordis.patch.yml:' + (src.config === true ? '开' : '关')
    + ' · 插件设置(本页开关):' + (src.settings === true ? '开' : '关'))
  // ★ 2026-10-01 尾:「谁在什么时候拨的」—— 事故驱动(21:33 那个键曾是 true 而查不出哪只手)。
  // 老配置没有这对字段 ⇒ 如实显示「没记来源」,不猜。
  const prov = el('div', 'hint', '开关留痕:'
    + String(mtState.flipLabel === undefined || mtState.flipLabel === '' ? '(没记来源)' : mtState.flipLabel))
  fill(box, [row, state, three, prov])
}

/** 拨一下:落盘 + 后端当场生效;回包里的 applied 决定这句人话怎么写。 */
async function saveMemoryTools (enabled, input) {
  if (input) input.disabled = true
  const msg = $('cfg-mt-msg')
  if (msg) msg.textContent = '保存中…'
  try {
    const r = await apiPost('/api/echo/memory-tools', { enabled: enabled === true })
    mtState = r
    drawMemoryTools()
    if (msg) {
      msg.textContent = r.applied === true
        ? ('已生效(立即,不用重启):' + String(r.registered) + ' 个只读工具现在就挂在子代理那一轮上。')
        : (r.on === true
          ? ('已落盘,但**没挂上**(原因:' + String(r.reason === undefined ? '未知' : r.reason) + ')—— 上面那行状态照实显示。')
          : '已落盘:关。4 个工具已摘除,子代理那一轮又是零工具。')
    }
  } catch (err) {
    if (msg) msg.textContent = '保存失败:' + err
    if (input) input.checked = !(enabled === true) // 失败要看得见:勾回原样,别留个骗人的勾
  } finally {
    if (input) input.disabled = false
  }
}

// ---- 🎯 自动挖影子边开关(2026-10-01 阶段 4)----
// 同一条裁定换到另一个开关上:「把"运行时自动挖边"也做成能在网页仪表盘拨、拨了
// 立即生效的开关(默认关,不改任何现有行为)」。
//
// 与隔壁「子代理记忆工具」那张卡的差别只有一处,但很关键:消费者在 **Python 引擎**
// (`worker.py` 的 graph_learn → 闸门 → 写共现证据层 `graph_cooc_evidence`),壳侧没有东西要挂
// ⇒ **落盘就是全部动作**;"立即生效"靠引擎**每帧现读** `$DSH_HOME/echo/config.json`
// (不缓存)⇒ 不用重启宿主、不用热重载。
// 落 `#cfg-gt`(**不在** `#cfg-form` 里:那一格的输入框数被 web 测试钉死;它也不是调参项)。
let gtState = null

async function renderGraphGate () {
  try { gtState = await api('/api/echo/graph-gate') } catch { gtState = null }
  drawGraphGate()
}

function drawGraphGate () {
  const box = $('cfg-gt')
  if (!box) return
  if (gtState === null) {
    fill(box, [el('div', 'hint', '自动挖影子边:读数拉取失败(不影响上面的调参)')])
    return
  }
  const on = gtState.on === true
  const src = gtState.sources || {}
  const row = el('label', 'cfg-row')
  const input = el('input', 'cfg-input')
  input.type = 'checkbox'
  input.checked = gtState.panelValue === true
  input.onchange = () => { saveGraphGate(input.checked, input).catch(() => {}) }
  row.appendChild(el('span', 'cfg-name', '每写一条新记忆就自动挖影子边'))
  row.appendChild(input)
  row.appendChild(el('span', 'cfg-hint',
    '默认关。开 = 每写一条新记忆,就把那条记忆里的共现对过一遍 R1–R6 去噪,通过的写进 '
    + 'graph_cooc_evidence(共现**证据层**:一行 = 一条证据(一条记忆 / 一天),pair 由只读视图 '
    + '按需派生;**现有读口看不见它**)。影子表 graph_shadow_edges 是 3a 的历史,已冻结不再增长。'
    + '拨一下**立即生效**:引擎每一帧都现读这个开关(不用重启宿主,也不用热重载)。'))
  const state = el('div', 'hint', '现在:' + (on ? '开' : '关')
    + ' · 来源:' + String(gtState.sourceLabel === undefined ? (gtState.source || '—') : gtState.sourceLabel))
  const three = el('div', 'hint', '三路读数 —— env:' + (src.env === true ? '开' : '关')
    + ' · 宿主配置 cordis.patch.yml:' + (src.config === true ? '开' : '关')
    + ' · 插件设置(本页开关):' + (src.settings === true ? '开' : '关'))
  const risk = el('div', 'hint',
    '⚠️ 打开后,每写一条新记忆都会往 graph_cooc_evidence 写一条证据行(对现有读口仍不可见,'
    + '可随时关 / 可一行清空:DELETE FROM graph_cooc_evidence;'
    + '影子表 graph_shadow_edges 那 48 条是审计,想一起清:DELETE FROM graph_shadow_edges)。')
  // ★ 2026-10-01 尾:「谁在什么时候拨的」—— 事故驱动(21:33 那个键曾是 true 而查不出哪只手)。
  const prov = el('div', 'hint', '开关留痕:'
    + String(gtState.flipLabel === undefined || gtState.flipLabel === '' ? '(没记来源)' : gtState.flipLabel))
  fill(box, [row, state, three, prov, risk])
}

/** 拨一下:落盘(引擎下一帧现读它);壳侧没有工具要挂/摘。 */
async function saveGraphGate (enabled, input) {
  if (input) input.disabled = true
  const msg = $('cfg-gt-msg')
  if (msg) msg.textContent = '保存中…'
  try {
    const r = await apiPost('/api/echo/graph-gate', { enabled: enabled === true })
    gtState = r
    drawGraphGate()
    if (msg) {
      msg.textContent = r.panelValue === true
        ? '已落盘:开。引擎**下一帧**挖边时就认这个值(不用重启;只写 graph_cooc_evidence,现有读口看不见)。'
        : '已落盘:关。引擎下一帧起就不再挖边(一条都不写);证据层里已有的行不动。'
    }
  } catch (err) {
    if (msg) msg.textContent = '保存失败:' + err
    if (input) input.checked = !(enabled === true) // 失败要看得见:勾回原样,别留个骗人的勾
  } finally {
    if (input) input.disabled = false
  }
}

// ---- 🧭 记忆架构 v2(2026-10-01 A7c)----
// 一格看清:**主题簇(算法产物)/ 证据层(中间层)/ 影子表(冻结)/ 事实图 / 失效史**,
// 每一格旁边就是它自己的"回退"入口。
//
// 纪律(§5.A7):口径**不在这** —— 全部来自 `GET /api/echo/graph-arch`(引擎 `arch.py`
// 聚合一次,面板只显示)。所以这里既不判断哪格能退、也不重算任何东西;能退几行、那句
// SQL,都是引擎报上来的原话。
//
// 回退 = 一次专用 POST(`{action:'rollback', route, confirm:true}`)。**两步确认**:第一下
// 只把"会动几行 + 那句 SQL"亮出来,第二下才真发 —— 写动作不许手滑(也不用 `window.confirm`,
// 在测试的假 DOM 里那玩意儿不存在)。
// 落 `#cfg-arch`(**不在** `#cfg-form` 里:那一格的输入框数被 web 测试钉着)。
let archState = null
let archPendingRoute = ''   // 第一步点过的路线(第二步才是真发)

async function renderArch () {
  try { archState = await api('/api/echo/graph-arch') } catch { archState = null }
  drawArch()
}

function drawArch () {
  const box = $('cfg-arch')
  if (!box) return
  if (archState === null || typeof archState !== 'object') {
    fill(box, [el('div', 'hint', '记忆架构 v2:读数拉取失败(不影响上面的调参)')])
    return
  }
  const st = archState.status || {}
  const nature = st.nature || {}
  const rows = []
  rows.push(el('div', 'cfg-group', '记忆架构 v2 —— 算法产物 / 事实,一眼分清'))

  // ① 主题簇(**算法产物**:可重算,退役即读口看不见)
  const tp = st.topics || {}
  const clusters = tp.clusters || []
  rows.push(el('div', 'cfg-name', '主题簇 —— ' + String(nature.topics || '算法产物,可重算')))
  rows.push(el('div', 'hint', '现行批次:' + (tp.active_batch ? String(tp.active_batch) : '(还没算或已退役)')
    + ' · ' + String(clusters.length) + ' 簇 · 有摘要 ' + String(tp.summaries || 0)))
  if (clusters.length === 0) {
    rows.push(el('div', 'hint', '现行批次是空的(没算过 / 已退役)。重算:`python -m engine.topics --apply`'))
  }
  for (const c of clusters) {
    rows.push(el('div', 'hint', '#' + String(c.cluster_id) + ' ' + String(c.label)
      + '(' + String(c.size) + ' 人' + ((c.soft || []).length ? ',软归属 ' + String((c.soft || []).length) : '') + ')'
      + ' · ' + (c.summary ? String(c.summary) : '(摘要还没写 —— 摘要是离线任务 A5b 的产物)')))
  }

  // ② 证据层 + 影子表 + 事实图(三格:中间层 / 史 / 事实)
  const ev = st.evidence || {}
  const scopes = Object.keys(ev.by_scope || {}).sort().map((k) => k + ' ' + String(ev.by_scope[k])).join(' + ')
  rows.push(el('div', 'hint', '证据层(' + String(nature.evidence || '中间层') + '):'
    + String(ev.rows || 0) + ' 行 / ' + String(ev.pairs || 0) + ' 对' + (scopes ? '(' + scopes + ')' : '')
    + (ev.present === false ? ' · 表还没建(引擎下次 connect 纯增建表)' : '')))
  rows.push(el('div', 'hint', '影子表(' + String(nature.shadow || '3a 历史') + '):'
    + String((st.shadow || {}).rows || 0) + ' 行 · 事实图(' + String(nature.graph || '事实') + '):'
    + String((st.graph || {}).nodes || 0) + ' 节点 / ' + String((st.graph || {}).edges || 0)
    + ' 边(active ' + String((st.graph || {}).active_edges || 0) + ')'))

  // ②′ 凭据债(**给人看的账**:查"她凭什么" —— 永不进她的上下文)
  //   他 2026-10-02 定的通例:证据 / 债 / 统计这类东西只出现在给人看的表面。
  const db2 = st.debt || {}
  if (db2.present) {
    const a = db2.active || {}
    rows.push(el('div', 'hint', '凭据债(' + String(nature.debt || '只给人看') + '):活跃 '
      + String(a.edges || 0) + ' 条里 无依据 ' + String(a.none || 0) + ' / 仅推定 '
      + String(a.inferred || 0) + ' / 有依据 ' + String((a.mixed || 0) + (a.real || 0))
      + (db2.nonfact_kind_rows ? ' · ⚠️ 非空 kind ' + String(db2.nonfact_kind_rows) + ' 条' : '')))
    const weak = db2.weak || []
    if (weak.length) {
      rows.push(el('div', 'hint', '没依据的活跃边(前 ' + String(weak.length) + ' / 共 '
        + String(db2.weak_total || weak.length) + '):'
        + weak.slice(0, 6).map((w) => '#' + String(w.edge_id) + ' ' + String(w.relation)).join(' · ')
        + ' —— 要还债得他给编号;报表:`python -m engine.evidence_debt`'))
    }
  }

  // ③ 失效史(回执尾巴)
  const rc = st.receipts || {}
  const tail = (rc.recent || []).slice(0, 4).map((r) => '#' + String(r.id) + ' ' + String(r.action)
    + (r.route ? '[' + String(r.route) + ']' : '')).join(' · ')
  rows.push(el('div', 'hint', '失效史(' + String(nature.receipts || '流水账') + '):共 '
    + String(rc.total || 0) + ' 条' + (tail ? ' · 最近:' + tail : '')))

  // ④ 回退入口:每条路线一个按钮(能退几行、动哪张表 —— 引擎报的原话)
  rows.push(el('div', 'cfg-name', '回退入口(一键,按最近一批)'))
  for (const r of (st.rollback || [])) {
    const line = el('div', 'hint', String(r.route) + ':' + String(r.what || '')
      + ' → ' + (r.available ? '可退 ' + String(r.rows) + ' 行' : '现在没有可退的')
      + (r.recomputable ? '(可重算)' : '(不可重算,只有审计)'))
    rows.push(line)
    if (r.available !== true) continue
    const btn = el('button', 'btn', archPendingRoute === r.route
      ? '再点一次确认:' + String(r.route)
      : '回退 ' + String(r.route) + '(' + String(r.rows) + ' 行)')
    btn.onclick = () => { stepRollbackArch(String(r.route)).catch(() => {}) }
    rows.push(btn)
    if (archPendingRoute === r.route) {
      rows.push(el('div', 'hint', '⚠️ 这一步真写:会执行引擎报的那句 SQL ——' + String(r.sql || '(引擎没给 SQL)')))
    }
  }
  fill(box, rows)
}

/** 两步走:第一下只亮出"会动几行 + 那句 SQL",第二下才真发(写动作不许手滑)。 */
async function stepRollbackArch (route) {
  const msg = $('cfg-arch-msg')
  if (archPendingRoute !== route) {
    archPendingRoute = route
    drawArch()
    if (msg) msg.textContent = '再点一次那个按钮才算真退(先看清它会动几行)。'
    return
  }
  archPendingRoute = ''
  await rollbackArchPanel(route)
}

/** 真回退:一次专用 POST(带头 + confirm:true);引擎说什么就显示什么。 */
async function rollbackArchPanel (route) {
  const msg = $('cfg-arch-msg')
  if (msg) msg.textContent = '回退中…'
  try {
    const r = await apiPost('/api/echo/graph-arch', { action: 'rollback', route: route, confirm: true })
    const rb = (r && r.rollback) || {}
    if (msg) {
      msg.textContent = '已回退 ' + String(route) + ':动 ' + String(rb.rows || 0) + ' 行;'
        + '回执 +' + String(rb.receipts || 0) + '。重算回来:按上面那格提示跑对应的 --apply。'
    }
    await renderArch()
  } catch (err) {
    // 被拒(409:没有可退的 / 白名单外)也要说人话,不许静默
    if (msg) msg.textContent = '回退没成:' + err
    await renderArch()
  }
}

async function renderSettings () {
  const box = $('cfg-form')
  try {
    const d = await api('/api/echo/settings')
    cfgData = d
    // G9:副标题里的项数**现算**(字段表是唯一一份;写死会飘 —— 51 / 71 / 109 就是三次飘)
    syncCfgSub(countSettingsFields(d.fields))
    cfgForm = d.settings === undefined ? null : d.settings
    const badge = $('cfg-badge')
    badge.textContent = cfgForm === null ? '离线' : '就绪'
    badge.className = 'badge' + (cfgForm === null ? ' warn' : ' on')
    drawSettings()
  } catch (err) {
    fill(box, [el('div', 'empty', '拉取失败:' + err)])
  }
  // 子代理记忆工具开关同一次进来就拉(它是开关,不在字段表里 —— 见上方注释)
  await renderMemoryTools()
  // 自动挖影子边开关:同一份道理(阶段 4),一起拉
  await renderGraphGate()
  // 记忆架构 v2(A7c):同一个理由 —— 它也住在设置区,但不是调参项
  await renderArch()
}

function cfgGet (nested, key) {
  if (!nested) return cfgForm[key]
  return (cfgForm[nested] || {})[key]
}

/** 嵌套子对象(longing / relay)**整块合并**回去 —— 拍平会把整块覆盖成 undefined,
 *  normalizeSettings 兜回默认:用户以为改成了、其实一切照旧(v0.17.0 R2 的教训)。 */
function cfgSet (nested, key, value) {
  if (!nested) { cfgForm = Object.assign({}, cfgForm, { [key]: value }); return }
  cfgForm = Object.assign({}, cfgForm, { [nested]: Object.assign({}, cfgForm[nested] || {}, { [key]: value }) })
}

function cfgRow (group, f) {
  // ★ 2026-10-19：`textarea` 是多行字段（群聊提示词用）。
  //   以前这里只会造 `<input>`，长句只能挤在一行里，看得见半句就找不着后半句。
  //   多行字段整行换个版式（标签在上、输入+提示在下），见 style.css 的 `.cfg-row-multi`。
  //   ⚠️ class 在创建时一次给全 —— 别用 `row.classList.add()`，测试的 DOM shim 没有它。
  const multi = f.type === 'textarea'
  const row = el('label', multi ? 'cfg-row cfg-row-multi' : 'cfg-row')
  row.appendChild(el('span', 'cfg-name', f.label))
  const input = el(multi ? 'textarea' : 'input', 'cfg-input')
  if (multi) {
    if (f.rows !== undefined) input.rows = String(f.rows)
    if (f.placeholder !== undefined) input.placeholder = f.placeholder
    input.value = String(cfgGet(group.nested, f.key) ?? '')
    input.oninput = () => cfgSet(group.nested, f.key, input.value)
  } else if (f.type === 'bool') {
    input.type = 'checkbox'
    input.checked = cfgGet(group.nested, f.key) === true
    input.onchange = () => cfgSet(group.nested, f.key, input.checked)
  } else if (f.type === 'num') {
    input.type = 'number'
    if (f.min !== undefined) input.min = String(f.min)
    if (f.max !== undefined) input.max = String(f.max)
    if (f.step !== undefined) input.step = String(f.step)
    input.value = String(cfgGet(group.nested, f.key) ?? '')
    // 空框按 0 走(宿主还会钳位);不 Number() 成 NaN 是因为 NaN 会整段被兜回默认
    input.oninput = () => cfgSet(group.nested, f.key, input.value === '' ? 0 : Number(input.value))
  } else {
    input.type = f.type === 'password' ? 'password' : 'text'
    if (f.placeholder !== undefined) input.placeholder = f.placeholder
    input.value = String(cfgGet(group.nested, f.key) ?? '')
    input.oninput = () => cfgSet(group.nested, f.key, input.value)
  }
  row.appendChild(input)
  row.appendChild(el('span', 'cfg-hint', f.hint || ''))
  return row
}

function cfgMsg (text) { $('cfg-msg').textContent = text }

function drawSettings () {
  const box = $('cfg-form')
  if (cfgForm === null || cfgForm === undefined) {
    fill(box, [el('div', 'empty', '记忆库离线,调参先放着')]); return
  }
  const nodes = []
  for (const g of (cfgData.fields || [])) {
    // 组名可点:收起这一段(51 项一长条,配上面的检索一起用)。
    // 箭头走 CSS 的 ::before —— 塞子元素会让组节点的 textContent 变空,
    // 而「组名 = 字段表里的 title」这条契约(The tests)是要读 textContent 的。
    const head = el('div', 'cfg-group', g.title)
    head.onclick = () => {
      const title = String(head.textContent)
      if (cfgCollapsed.has(title)) cfgCollapsed.delete(title)
      else cfgCollapsed.add(title)
      head.className = 'cfg-group' + (cfgCollapsed.has(title) ? ' collapsed' : '')
      filterSettings() // 显隐只由 filterSettings 一处决定(折叠 + 检索一起算)
    }
    nodes.push(head)
    for (const f of g.fields) nodes.push(cfgRow(g, f))
  }
  const actions = el('div', 'fw')
  const save = el('button', 'btn', '保存')
  const reset = el('button', 'btn', '恢复默认(未保存)')
  const again = el('button', 'btn', '重新拉取')
  save.onclick = () => { saveSettings(save).catch(() => {}) }
  reset.onclick = () => {
    cfgForm = JSON.parse(JSON.stringify(cfgData.defaults || {}))
    drawSettings()
    cfgMsg('已填回默认值 —— 还没落库,点「保存」才生效')
  }
  again.onclick = () => { renderSettings().catch(() => {}) }
  actions.appendChild(save); actions.appendChild(reset); actions.appendChild(again)
  nodes.push(actions)
  if (cfgData.relayTokenSet === true) {
    nodes.push(el('div', 'hint', '适配器令牌已设(出于安全,GET 不回显)—— 这里的令牌框留空 = 不改。'))
  }
  fill(box, nodes)
  filterSettings()
}

/** 折叠了哪几组(按组标题记,跨重画保留:保存一次不该把折叠状态吃掉)。 */
const cfgCollapsed = new Set()

/** 设置项的显隐只在这里算:折叠(整组收起)+ 检索(按词过滤)两个条件合起来。
 *  只改 hidden,不改值、不改 cfgForm —— 过滤不是编辑。
 *  2026-09-27 现场:原来这里写 `if (!Array.isArray(form.children)) return`,
 *  而真浏览器里 .children 是 **HTMLCollection**(类数组、不是 Array)⇒ 守卫
 *  直接 return ⇒ **折叠与检索在页面上全都不生效**,而假 DOM 的 children 是
 *  真数组,测试一直绿。现在先 Array.from 快照,别再对 DOM 集合做数组判断。 */
function filterSettings () {
  const form = $('cfg-form')
  if (!form || !form.children) return
  const kids = Array.from(form.children)
  const q = qOf('cfg-q')
  let group = null; let shown = 0; const groups = []
  for (const node of kids) {
    const cls = String(node.className || '')
    if (cls.indexOf('cfg-group') >= 0) {
      if (group) groups.push([group, shown])
      group = node; shown = 0
    } else if (cls.indexOf('cfg-row') >= 0) {
      const folded = group !== null && cfgCollapsed.has(String(group.textContent))
      const ok = !folded && (q === '' || hit(q, node.textContent))
      node.hidden = !ok
      if (ok) shown += 1
    }
  }
  if (group) groups.push([group, shown])
  // 检索把一组全滤掉了才连组名一起收;折叠状态不隐藏组名(否则点不回来)
  for (const [g, n] of groups) g.hidden = q !== '' && n === 0
}

async function saveSettings (btn) {
  btn.disabled = true
  cfgMsg('保存中…')
  try {
    const r = await apiPost('/api/echo/settings', { settings: cfgForm })
    cfgForm = r.settings === undefined ? cfgForm : r.settings
    drawSettings()
    cfgMsg('已保存 —— 下一轮对话就按新值走(心跳类改动最多等一分钟)')
  } catch (err) {
    cfgMsg('保存失败:' + err)
  } finally {
    btn.disabled = false
  }
}

// ---- 页头 + 左栏状态 + 调度 ----
/** 三枚状态丸常驻左栏:她在不在、引擎是 Python 还是 JS、桥通不通。
 *  以前这三件事散在三个面板里,得翻页才知道自己正跟谁说话。 */
function setPill (id, text, cls) {
  const n = $(id); if (!n) return
  n.textContent = text
  n.className = 'pill' + (cls ? ' ' + cls : '')
}

async function renderSub () {
  const [stR, hR] = await Promise.allSettled([api('/api/echo/status'), api('/api/echo/health')])
  if (stR.status !== 'fulfilled') { $('page-sub').textContent = '状态拉取失败'; return }
  const st = stR.value
  const eng = st.engine || {}
  const line = 'v' + (st.version || '?') + ' · ' + engineLabel(eng) +
    (st.enabled === false ? ' · 休眠中(不注入不记录)' : ' · 在线') +
    ' · ' + (st.dataDir || '')
  $('page-sub').textContent = line
  const ver = $('side-ver'); if (ver) ver.textContent = 'v' + (st.version || '?')
  const dir = $('side-dir'); if (dir) { dir.textContent = String(st.dataDir || '—').split(/[\\/]/).pop(); dir.title = st.dataDir || '' }
  setPill('pill-live', st.enabled === false ? '休眠中' : '在线', st.enabled === false ? 'off' : 'on')
  const mode = eng.mode
  setPill('pill-engine', mode === 'python' ? 'Python 引擎' : (mode === 'baseline' ? 'JS 基线' : '引擎离线'),
    mode === 'python' ? 'on' : (mode === 'baseline' ? 'warn' : 'off'))
  const h = hR.status === 'fulfilled' ? hR.value : null
  if (h === null || h.offline === true) setPill('pill-bridge', '桥 —', 'off')
  else {
    // 2026-09-28 旧桥退役:桥通不通改看 `/api/echo/status` 的 relay 面
    // (总闸开 **或** 有渠道插件自报家门 = 她有嘴能说)。旧桥那套 401 拒签计数
    // (体检面里那份)跟着 5 个 `/api/echo/relay/*` 端点一起没了。
    const rl = st.relay || {}
    setPill('pill-bridge', rl.enabled === true ? '桥 通' : '桥 —', rl.enabled === true ? 'on' : 'off')
  }
}

/** 错峰轮询游标(每拍推进 3 个) */
let pollCursor = 0
async function refreshAll () {
  // 每段独立失败:一段炸不拖垮整页
  const jobs = [renderSub, renderOverview, renderLonging, renderEmotion, renderMemory,
    renderConversations, renderThreads, renderGraph, renderInjection, renderDiary, renderScope,
    drawSetupBanner]   // ① 引导条跟着轮询走(它自己决定显示/隐藏)
  // ★ 2026-10-09(他实测:面板一开就卡、DSH 里发不出消息;关掉面板立刻能发):
    // 上面那个字面量**一字不动**(每个面板依然真在轮询里⇒ 不破 O5),只在**调用时过滤**⇒
    // 常驻件 + 当前面板 每拍刷,其余面板轮转着刷(每拍约 13 → 4),后台标签整拍跳过。
    // 切面板时 showPanel 本来就会 draw 一次(见 :354)⇒ 切过去永远是新的 ✓
    if (typeof document !== 'undefined' && document.hidden === true) return
    const curDraw = {
      ov: renderOverview, lg: renderLonging, em: renderEmotion, au: renderAudit, inj: renderInjection,
      mm: renderMemory, th: renderThreads, gr: renderGraph, di: renderDiary, cv: renderConversations,
      sc: renderScope
    }[currentPanel]
    const restDraw = jobs.filter((j) => j !== renderSub && j !== drawSetupBanner && j !== curDraw)
    const pollBatch = restDraw.slice(pollCursor, pollCursor + 3)
    pollCursor = (pollCursor + 3) % Math.max(1, restDraw.length)
    const runJobs = jobs.filter((j) => j === renderSub || j === drawSetupBanner || j === curDraw || pollBatch.indexOf(j) >= 0)
    await Promise.allSettled(runJobs.map((j) => j()))
  const up = $('tb-updated')
  if (up && !frozen) up.textContent = '刷新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

function connectEvents () {
  // ★ 2026-10-09(他实测实验锤实:关掉一个 DSH 标签 ⇒ 老面板立刻活过来):
  // 本机实测是 **HTTP/1.1**(curl:http_version=1.1,响应头 `Connection: keep-alive`),
  // 而 Chrome 对同一个 host 只给约 **6 条**并发连接;本页原来开一条**常驻** EventSource
  // (`/api/echo/events`),与 DSH 界面自己需要的常驻连接一起把槽占满 ⇒ 两边的新请求**永远排队** ⇒ 双向假死。
  // 现改为**不占常驻连接**:一切走下方 30 秒轮询 —— `refreshAll()` 的 jobs 里已包含
  // `renderAudit` / `renderLonging` / `renderInjection` ⇒ 审计流、想念、注入透视都不丢,只是最慢 30 秒跟上。
  // 徽章如实标注,不再假装"已连接"。EventSource 这段逻辑整体退役(要回滚:见本提交的 diff)。
  const badge = $('sse-badge'); const count = $('audit-count')
  if (badge) { badge.textContent = '轮询模式'; badge.className = 'badge off' }
  if (count) count.textContent = '—'
}

// 先接好壳(导航/检索/冻结/快捷键),再定第一屏 —— 落到哪一段由 hash 决定(默认总览)
initShell()
showPanel(panelFromHash() || 'ov')
// 称呼先取一次(P1d):进页面只打一次,取到后把吃称呼的那屏重画一遍
// (端点在 ⇒ 用它的名字;没就绪/超时 ⇒ 中性兜底,页面照常,首屏不等它)
loadProfile().catch(() => {})
refreshAll().catch(() => {})
// 调参单独一次:它不进轮询(见 renderSettings 上方注释),刷新靠「重新拉取」
renderSettings().catch(() => {})
setInterval(() => { if (!frozen) refreshAll().catch(() => {}) }, 30000) // 2026-10-09:10s → 30s(面板占同源连接,他实测发不出消息)
// ★ 2026-10-09(方案 A:老面板审计下线,但**零改测试**):
// `#au` 那一页的 renderAudit/drawAudit 与 section#au 全部保留(测试直接调用它们,契约不动),
// 只把**导航入口**改成打开独立审计页 —— 且刻意**不动 `href="#/au"`**(那道「表↔壳同源」闸要求它字面存在),
// 改用点击拦截 preventDefault 后开新标签,徽标 #nav-au-n 也原样留着。
try {
  const auLink = $('nav-au')
  if (auLink) {
    auLink.onclick = (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault()
      try { window.open('/echo/audit-cards.html', '_blank', 'noopener') } catch { /* 弹窗被拦就退回默认(留在本页) */ }
    }
  }
} catch { /* 拿不到就照旧 */ }
const AU_EXTERNAL = true // 标记:审计入口已改外链(此注释供 grep 定位,别删)
connectEvents()
