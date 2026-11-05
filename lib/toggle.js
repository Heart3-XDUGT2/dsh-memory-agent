/**
 * dsh-echo — Echo 的电源开关与会话范围
 * ============================================================
 * v0.2.1 电源:面板「电源」卡控制她在不在线。休眠 = 三重静默:
 *   不注人格(两段 section 渲染空串)、不注记忆(pre-step 短路)、
 *   不捕获对话也不反思(session/event 直接短路)—— 她不偷听。
 * 插件本体/面板/诊断工具不受开关影响,唤醒通道永远可用。
 *
 * v0.9.0 会话范围:工作娱乐两不误(用户需求)。电源是总闸,范围是
 * 分闸 —— scope 两种模式:
 *   'all'       全部会话启用(默认,与历史行为一致);例外名单
 *               exempt 里的会话关闭(「Echo 下线」标记进这里);
 *   'whitelist' 仅白名单启用;「Echo 上线」标记把当前会话加进
 *               whitelist。新会话没聊过也能开:标记短语在消息
 *               捕获层先于范围闸执行,鸡生蛋问题不存在。
 * 人格段组装时按 AssembleContext.scope(= Agent 对象)取
 * session.id 判定 —— 同一份人格文本,按会话开关。
 *
 * 状态存 ~/.dsh/echo/config.json。读是同步的(系统提示段求值在同步
 * 上下文里,每轮组装读一次小文件,成本可忽略,且零缓存失效 bug);
 * 写走临时文件+rename 原子落盘,**全量保留旧字段**(v0.2.1 的
 * setEnabled 只写 enabled —— 加了范围字段后那会抹掉它们,已修)。
 * 文件缺失/损坏视为「在线 + 全部会话」:开关是运行时偏好,不是
 * 安全边界,fail-soft 向「被召唤」一侧倒。
 *
 * v0.41.0 阶段 2f:同一份文件再收一个**开关** ——
 * `memorySubagentTools`(面板「给子代理开只读记忆工具」,与 enabled/scope
 * 同层,不在 `settings` 段;理由见 `readMemoryTools()` 上方)。它与别的
 * 开关共用 `readConfig`/`writeConfig`,所以三条纪律一致:读 fail-soft、
 * 写原子、**保留未知字段**。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
// P1a:路径真源搬到 lib/data-dir.js(认 ECHO_DATA_DIR / $DSH_HOME / ~/.dsh)。
// 注意依赖方向:这里只依赖 data-dir.js,不再从 persona.js 拿 DATA_DIR ——
// 开关文件的路径不该经过"人格"那一层。
import { resolveConfigPath } from './data-dir.js'
// P1 收口(拍板 2):她的自称/别名从 profile.json 的 agentAliases 派生(唯一读点)
import { loadProfile } from './profile.js'
// P3 B1 #2(2026-10-05):开关口令的数据读点(`lexicon.json.powerWords`)。
// 数据为空 / 缺键 ⇒ 回本文件的两张默认表 ⇒ 与迁移前逐位一致。
import { lexiconOf, objectField, listField } from './data-tables.js'
// 2026-10-01 阶段 2f:面板开关「给子代理开只读记忆工具」的**键名**必须与判定同源
// (`lib/memory-read-tools.js` 的 MEMORY_TOOL_CONFIG_KEY),不许在这里再写一遍字面量。
// 依赖方向安全:memory-read-tools → retrieve → dmae/lexical,没有一条回到 toggle.js。
import { MEMORY_TOOL_CONFIG_KEY } from './memory-read-tools.js'
// 2026-10-01 阶段 4:同一个纪律给「每写一条新记忆就自动挖影子边」那个开关 ——
// 键名(GRAPH_GATE_CONFIG_KEY)与判定(`lib/graph-gate.js`)同源;引擎侧在
// `python/engine/graph_gate.py` 读**同一个文件的同一个键**(每帧现读)。
import { GRAPH_GATE_CONFIG_KEY } from './graph-gate.js'
// ★ 2026-10-25(bug-echo-new-session-default §5.1):「这条 id 形态上是不是子代理会话」
//   的判据只有一份,在 `lib/agent-scope.js`(它与会话头判据同住一个模块)。
//   这里**只许调用**它,不许在本文件重写那条正则 —— 有单测钉住(subagent-scope ⑩)。
//   依赖方向安全:agent-scope.js 零 import,不会绕回本文件。
import { isSubagentSessionId } from './agent-scope.js'
// 陪伴/桥落点的缺省 id(纯常量模块,零 import)。
import { DEFAULT_COMPANION_ID } from './companion-target.js'

/**
 * ★ 2026-10-01 尾:「开」这件事必须留痕(事故驱动,不是洁癖)。
 *
 * 现场:`~/.dsh/echo/config.json` 里 `graphShadowEdges` 在 21:33:41 变成了 `true`,
 * 而**谁也说不清是谁拨的** —— 面板拨一下只留 `savedAt`,那个时间戳只说"文件被写过",
 * 不说"哪个键、谁写的"。翻遍 afaccess 的每条 shell 记录、她的 audit_logs、全部会话
 * 转写,都只能证明**不是**哪些路,证不出**是**哪只手。
 *
 * 所以照 `poweredBy/poweredAt`、`scopeBy/scopeAt` 的同款样子,给两个面板开关各配
 * 一对来源标记:拨一次就写下 `by`(panel / loader-config / tool / marker / api)
 * 与 `at`(epoch 秒)—— 下次再有人问"谁开的",文件自己答。
 */
const MEMORY_TOOL_BY_KEY = MEMORY_TOOL_CONFIG_KEY + 'By'
const MEMORY_TOOL_AT_KEY = MEMORY_TOOL_CONFIG_KEY + 'At'
const GRAPH_GATE_BY_KEY = GRAPH_GATE_CONFIG_KEY + 'By'
const GRAPH_GATE_AT_KEY = GRAPH_GATE_CONFIG_KEY + 'At'

/** 开关文件路径(路径真源在 lib/data-dir.js:P1a 起认 ECHO_DATA_DIR / $DSH_HOME / ~/.dsh)。 */
export const CONFIG_PATH = resolveConfigPath()

/** 缺文件/坏文件时的兜底形状(**必须**与下面正常分支逐键一致)。 */
function defaultConfig() {
  return {
    enabled: true, scope: 'all', whitelist: [], exempt: [], sessionLabels: {}, manualOff: [],
    // 2026-10-25:见过的子代理会话 id(写进面板前要滤掉,见 index.js 的 scope 端点)。
    // 审计照旧记它们的行(排障要),但「会话」列表里不该出现临时会话。
    subagentSessions: [],
    poweredBy: '', poweredAt: 0, scopeBy: '', scopeAt: 0,
    // 2026-10-01 阶段 2f:面板开关「给子代理开只读记忆工具」。默认**关**
    // (fail-soft 的方向由 memoryToolsEnabled 的判据定,不由这里倒)。
    memorySubagentTools: false,
    // 2026-10-01 阶段 4:面板开关「每写一条新记忆就自动挖影子边」。默认**关**
    // (同上:方向由 graphGateEnabled 的判据定)。**引擎每帧现读这个键** ⇒ 拨了立即生效。
    graphShadowEdges: false,
    // 2026-10-01 尾:两个面板开关的**来源标记**(谁拨的 / 什么时候)。形状与
    // poweredBy/poweredAt 一致;缺省是"没记"(不是"没拨过")。
    memorySubagentToolsBy: '', memorySubagentToolsAt: 0,
    graphShadowEdgesBy: '', graphShadowEdgesAt: 0
  }
}

/** 读整份配置:同步、永不抛错。缺失/损坏 → 在线 + 全部会话。 */
function readConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return defaultConfig()
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    const scope = raw.scope === 'whitelist' ? 'whitelist' : 'all'
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x !== '').slice(0, 200) : [])
    // v0.11.0 会话标签:读取形状必须跟上字段(writeConfig 保字段,readConfig
    // 也要透传 —— 否则 sessionLabels 写得进读不出,静默丢数据)。
    // (v0.29.0:sessionChats「会话→群号」随群聊拒收一起退役;老配置里
    // 残留的该字段会被下面的白名单读取自然忽略,不用清理。)
    const labels = {}
    if (raw.sessionLabels && typeof raw.sessionLabels === 'object' && !Array.isArray(raw.sessionLabels)) {
      for (const [k, v] of Object.entries(raw.sessionLabels)) {
        if (typeof k === 'string' && k !== '' && typeof v === 'string' && v !== '') labels[k] = v.slice(0, 24)
      }
    }
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      scope,
      whitelist: arr(raw.whitelist),
      exempt: arr(raw.exempt),
      sessionLabels: labels,
      // 2026-09-26 硬开关:人**显式关过**的会话。autoScope 只认这份名单 ——
      // 以前它只看 sessionEnabled(),于是「Echo 下线」被下一条 QQ 消息静默撤销。
      manualOff: arr(raw.manualOff),
      subagentSessions: arr(raw.subagentSessions),
      // 谁关的、什么时候关的(面板/工具/标记短语)—— 开关要能被追问
      poweredBy: typeof raw.poweredBy === 'string' ? raw.poweredBy.slice(0, 24) : '',
      poweredAt: Number(raw.poweredAt) || 0,
      scopeBy: typeof raw.scopeBy === 'string' ? raw.scopeBy.slice(0, 24) : '',
      scopeAt: Number(raw.scopeAt) || 0,
      // 2026-10-01 阶段 2f:**严格布尔**才认(字符串 "true" / 1 一律按关)
      // —— 与 memoryToolsEnabledFromConfig 的 `=== true` 同一口径,
      // 免得"文件里写了点什么"和"她真的开了"在两处读出两种答案。
      memorySubagentTools: raw[MEMORY_TOOL_CONFIG_KEY] === true,
      // 2026-10-01 阶段 4:同样是**严格布尔**口径(引擎侧 `config_flag_enabled`
      // 也是 `is True`,两侧逐字一致)。
      graphShadowEdges: raw[GRAPH_GATE_CONFIG_KEY] === true,
      // 2026-10-01 尾:来源标记(与 poweredBy/poweredAt 同款归一;缺/坏值 = 空)。
      memorySubagentToolsBy: typeof raw[MEMORY_TOOL_BY_KEY] === 'string' ? raw[MEMORY_TOOL_BY_KEY].slice(0, 24) : '',
      memorySubagentToolsAt: Number(raw[MEMORY_TOOL_AT_KEY]) || 0,
      graphShadowEdgesBy: typeof raw[GRAPH_GATE_BY_KEY] === 'string' ? raw[GRAPH_GATE_BY_KEY].slice(0, 24) : '',
      graphShadowEdgesAt: Number(raw[GRAPH_GATE_AT_KEY]) || 0
    }
  } catch {
    return defaultConfig()
  }
}

/** 写整份配置:原子落盘(tmp+rename),保留未知字段。失败上抛。 */
function writeConfig(patch) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  let keep = {}
  try { keep = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) } catch { }
  const next = { ...keep, ...patch, savedAt: new Date().toISOString() }
  const tmp = CONFIG_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, CONFIG_PATH)
  return next
}

/**
 * 读电源:同步、永不抛错。缺失/损坏/字段非法 → true(在线)。
 * v0.2.1 教训预防:布尔字段显式校验,JSON 里存 "false" 字符串之类
 * 的脏值一律按默认处理,不猜。
 */
export function readEnabled() {
  return readConfig().enabled
}

/**
 * 写电源(保留范围字段)。
 * @param {boolean} enabled
 * @param {string} [by] 谁拨的:'panel' | 'tool' | 'marker' | 'api'(面板要能显示)
 */
export function setEnabled(enabled, by = '') {
  writeConfig({
    enabled: Boolean(enabled),
    poweredBy: String(by || '').slice(0, 24),
    poweredAt: Math.floor(Date.now() / 1000)
  })
  return Boolean(enabled)
}

/** 电源的完整状态:开关 + 谁拨的 + 什么时候(面板/工具/诊断共用一份真源)。 */
export function readPower() {
  const c = readConfig()
  return { enabled: c.enabled, by: c.poweredBy, at: c.poweredAt }
}

/**
 * ★ 2026-10-01 阶段 2f:面板开关「给子代理开只读记忆工具」。
 *
 * 落点为什么在这里(而不是 `settings` 段):
 *   · 它**不是调参项**,是**开关** —— 与 enabled / scope 同一族,人拨一下就要变行为;
 *   · `settings` 段是 51 项调参面,键集被 `tests/settings-fields.test.js` 三向对齐
 *     电池 + README「调参(**N 项」项数同时钉死:往里加一个键,就得连带改仓根
 *     README.md —— 而那一份不在本次允许改的目录里。
 *   · 落盘方式**沿用既有那一套**:同一个 `writeConfig`(`.tmp` + `renameSync` 原子写、
 *     **保留未知字段**),所以它不会被别处的写(拨电源 / 存调参)抹掉,也不会抹掉别人。
 *
 * 读:同步、永不抛错,缺失/坏值一律 `false`(**默认关** —— 这是纪律 ①,单测钉住)。
 */
export function readMemoryTools() {
  return readConfig().memorySubagentTools
}

/**
 * 写面板开关。**只动这一个键**(+ 它自己那对来源标记 `…By`/`…At`)——`writeConfig`
 * 读旧文件保未知字段,所以电源/范围/调参/会话标签/隔壁那个开关一个字节都不动
 * (有单测钉住;单测的"只动哪些键"白名单里含这对标记)。
 * 失败**上抛**(调用方决定怎么报 —— 端点会回 500,绝不静默)。
 * @param {boolean} enabled
 * @param {string} [by] 谁拨的:'panel' | 'tool' | 'api'('' = 没记来源)
 */
export function setMemoryTools(enabled, by = '') {
  writeConfig({
    [MEMORY_TOOL_CONFIG_KEY]: enabled === true,
    [MEMORY_TOOL_BY_KEY]: String(by || '').slice(0, 24),
    [MEMORY_TOOL_AT_KEY]: Math.floor(Date.now() / 1000)
  })
  return enabled === true
}

/** 面板开关的来源标记(谁拨的 / 什么时候;'' 与 0 = 没记)。 */
export function readMemoryToolsFlip() {
  const c = readConfig()
  return { by: c.memorySubagentToolsBy, at: c.memorySubagentToolsAt }
}

/**
 * 喂给 `memoryToolsEnabled({ settings })` 的那一份:**调参设置 ⊕ 面板开关**。
 *
 * 为什么合成一份:判定函数只认三路(env / loader-config / settings),而面板开关
 * 落在 config.json 顶层、调参落在它的 `settings` 段 —— 两处都是"插件自己的设置",
 * 所以在这里合成,交给**同一个**判定函数,不另写第二份判据。
 * (键名 `MEMORY_TOOL_CONFIG_KEY` 与判定函数同源同字。)
 */
export function readMemoryToolSetting() {
  return { ...readSettings(), [MEMORY_TOOL_CONFIG_KEY]: readMemoryTools() }
}

/**
 * ★ 2026-10-01 阶段 4:面板开关「每写一条新依赖就自动挖影子边」——
 * 原话是「每写一条新记忆就自动挖影子边」,落点与理由**与 `readMemoryTools()` 逐条相同**
 * (它不是调参项,是开关;与 enabled / scope 同层;共用同一条 `writeConfig` 原子写
 * 并保留未知字段)。
 *
 * ⚠️ 与 2f 那个开关的**唯一区别**:这个开关的消费者在 **Python 引擎侧**,而引擎
 * 不去读 loader 配置 ⇒ 引擎读的是**这个文件**(每帧现读)⇒ 拨一下下一帧就生效。
 * 所以键名与文件路径在引擎里有镜像常量(`python/engine/graph_gate.py`),
 * 两边由单测钉住同字同路径。
 *
 * 读:同步、永不抛错,缺失/坏值一律 `false`(**默认关**)。
 */
export function readGraphShadowEdges() {
  return readConfig().graphShadowEdges
}

/** 面板开关的来源标记(谁拨的 / 什么时候;'' 与 0 = 没记)。 */
export function readGraphShadowEdgesFlip() {
  const c = readConfig()
  return { by: c.graphShadowEdgesBy, at: c.graphShadowEdgesAt }
}

/**
 * 写面板开关。**只动这一个键**(+ 它自己那对来源标记 `graphShadowEdgesBy`/`…At`)
 * ——`writeConfig` 保未知字段 ⇒ 电源/范围/调参/会话标签/另一个面板开关一个字节都不动,
 * 有单测钉住。失败**上抛**(端点回 500,绝不静默)。
 *
 * ★ 2026-10-01 尾:**「开」必须留痕**。任何把这个键写成 `true` 的路径都得传 `by`
 * (面板 = `'panel'`,宿主配置同步 = `'loader-config'`)—— 起因见文件上方那段事故记录。
 * @param {boolean} enabled
 * @param {string} [by]
 */
export function setGraphShadowEdges(enabled, by = '') {
  writeConfig({
    [GRAPH_GATE_CONFIG_KEY]: enabled === true,
    [GRAPH_GATE_BY_KEY]: String(by || '').slice(0, 24),
    [GRAPH_GATE_AT_KEY]: Math.floor(Date.now() / 1000)
  })
  return enabled === true
}

/**
 * 喂给 `graphGateEnabled({ settings })` 的那一份:**调参设置 ⊕ 面板开关**
 * (与 `readMemoryToolSetting()` 同款:判定函数只认三路,而面板开关落在 config.json
 * 顶层、调参落在 `settings` 段,两处都算"插件自己的设置")。
 */
export function readGraphShadowEdgeSetting() {
  return { ...readSettings(), [GRAPH_GATE_CONFIG_KEY]: readGraphShadowEdges() }
}

/** 读会话范围:{ scope, whitelist, exempt, manualOff }。 */
export function readScope() {
  const { scope, whitelist, exempt, manualOff, scopeBy, scopeAt } = readConfig()
  return {
    scope,
    whitelist: [...whitelist],
    exempt: [...exempt],
    manualOff: [...manualOff],
    by: scopeBy,
    at: scopeAt
  }
}

/**
 * 2026-10-25:记下「这个会话是子代理」。
 *
 * 为什么必须落盘:面板的会话列表是从 udit_logs 数出来的(见 store 的
 * sessionPreviews),而子代理的审计行**按设计要保留**(排障要看它的工具流水)。
 * 所以「谁是子代理」这件事只能由宿主告诉我们 —— 在 session/created 那一刻
 * 判出来,记在这里,端点在展示前滤掉。重启不丢。
 *
 * 上限 200 条:子代理会话是临时的,老条目留着只占地方。
 */
export function rememberSubagentSession(sessionId) {
  const sid = String(sessionId || '')
  if (sid === '') return false
  try {
    const cur = readConfig().subagentSessions
    if (cur.includes(sid)) return false
    const next = [...cur, sid].slice(-200)
    writeConfig({ subagentSessions: next })
    return true
  } catch { return false }   // 记不下就记不下,绝不影响这一轮
}

/** 见过的子代理会话 id(/api/echo/scope 展示前用它过滤)。 */
export function readSubagentSessions() {
  try { return [...readConfig().subagentSessions] } catch { return [] }
}

/**
 * ★ 2026-10-25(docs/bug-echo-new-session-default.md §5.2):**启动期回填**。
 *
 * 病:名单只在 `session/created` 那一拍记 —— 重启**之前**就存在的子代理会话
 * 没有任何人登记过,而面板的会话列表是从 `audit_logs` 数出来的 ⇒ 那 22 个老会话
 * 一直漏在列表上(活库实测:`/scope` 27 条里 25 条裸 UUID,名单里只有 3 条)。
 *
 * 修法:启动时把**看得见的会话**里形态上是子代理的那些补进名单。三条纪律:
 *   · **幂等** —— 已经在名单里的跳过,一条都没补就**不写盘**(不制造 mtime 抖动);
 *   · **上限沿用 200**(`rememberSubagentSession` 同一条:老的挤掉);
 *   · **只认裸 UUID** —— `global`(面板伪会话)、`session-*`(顶层/陪伴/桥)
 *     以及配置里的 `relay.sessionId` 一个都不许进名单。
 *
 * 返回补进去的条数(0 = 无事可做;调用方只拿它写日志)。失败回 0,绝不影响启动。
 * @param {Iterable<string>} sessionIds 看得见的会话 id(壳侧喂 store.sessionPreviews())
 */
export function backfillSubagentSessions(sessionIds) {
  let cur = []
  try { cur = readConfig().subagentSessions } catch { return 0 }
  const relay = relaySessionIdOf()
  const next = [...cur]
  let added = 0
  for (const raw of (sessionIds === null || sessionIds === undefined ? [] : sessionIds)) {
    const sid = String(raw ?? '')
    if (sid === '') continue
    if (sid === relay) continue                          // 桥的落点:永远不是"临时会话"
    if (!isSubagentSessionId(sid)) continue               // 只认裸 UUID(global / session-* 到此为止)
    if (next.includes(sid)) continue                      // 幂等:第二次什么都不补
    next.push(sid)
    added += 1
  }
  if (added === 0) return 0
  try {
    writeConfig({ subagentSessions: next.slice(-200) })   // 上限与 rememberSubagentSession 同一条
    return added
  } catch { return 0 }
}

/** 切模式:'all'(全部会话,例外除外)| 'whitelist'(仅白名单)。 */
export function setScope(scope, by = '') {
  writeConfig({
    scope: scope === 'whitelist' ? 'whitelist' : 'all',
    scopeBy: String(by || '').slice(0, 24),
    scopeAt: Math.floor(Date.now() / 1000)
  })
  return readScope()
}

/**
 * 这个会话是不是被人**显式关过**(硬开关)。
 *
 * 与 `sessionEnabled` 的区别:那个答的是"现在生效吗",这个答的是
 * "人有没有亲手关过它"。`autoScope` 必须问后者 —— 否则「Echo 下线」
 * 会被下一条入站消息静默撤销(2026-09-26 现场:exempt 一直是空的)。
 */
export function isManuallyOff(sessionId) {
  const sid = String(sessionId || '')
  if (sid === '') return false
  return readConfig().manualOff.includes(sid)
}

/**
 * 会话级开关(按当前模式落位):
 *   all 模式       on → 从例外名单摘除;off → 进例外名单
 *   whitelist 模式 on → 进白名单;off → 从白名单摘除
 */
export function setSessionOn(sessionId, on) {
  const sid = String(sessionId || '')
  if (sid === '') return readScope()
  const { scope, whitelist, exempt, manualOff } = readConfig()
  // 硬开关名单:人关过的会话记在这里,autoScope 永不覆盖(见 isManuallyOff)。
  // 人**亲手开**则从名单摘除 —— 摘除之后 autoScope 才允许再管它。
  const manual = on ? manualOff.filter((x) => x !== sid) : [...new Set([...manualOff, sid])]
  if (scope === 'whitelist') {
    const list = on ? [...new Set([...whitelist, sid])] : whitelist.filter((x) => x !== sid)
    writeConfig({ whitelist: list, manualOff: manual })
  } else {
    const list = on ? exempt.filter((x) => x !== sid) : [...new Set([...exempt, sid])]
    writeConfig({ exempt: list, manualOff: manual })
  }
  return readScope()
}

/**
 * 陪伴/桥的落点会话 id(配置里的 `relay.sessionId`,没配就回缺省)。
 * 为什么在这里读而不是让调用方传:判定是 `sessionEnabled` 一个人做的,
 * 「陪伴会话永远可用」这条也必须在它里面成立,不许靠调用方记得。
 */
function relaySessionIdOf () {
  try {
    const relay = readSettings()?.relay
    const sid = String(relay?.sessionId ?? '')
    return sid !== '' ? sid : DEFAULT_COMPANION_ID
  } catch {
    return DEFAULT_COMPANION_ID   // 读不到配置 ≠ 桥不存在:朝「陪伴会话可用」一侧倒
  }
}

/**
 * 会话启用判定(总闸 ∧ 分闸 ∧ 「这不是临时会话」):电源开着,且该会话在当前
 * 模式下启用。sid 为空(全局组装/未知会话)在 all 模式下视为启用 ——
 * 与历史行为一致;whitelist 模式下不启用(没有会话就没有人格)。
 *
 * ★★ 2026-10-25(docs/bug-echo-new-session-default.md §5.1):**第三道判据进场**。
 *
 * 修前只有「在不在 exempt / whitelist 里」这一条,而 `scope=all` 的语义是
 * 「不在黑名单里就算开」⇒ 子代理会话既不在 `exempt` 也不在 `manualOff`
 * (`session/created` 按设计不登记它们)⇒ **`sessionEnabled(子代理) === true`**。
 * 上一轮只在注入闸与面板展示上加了子代理判据,**没修"默认关"本身** ——
 * 于是「她到底开没开」在这 10 个调用点(`index.js:1781/2295/3205/3311/…`)
 * 上有两种答案,哪天有人新加一处漏判,那个 bug 就回来了。
 *
 * 所以判据收进这里,顺序是**三层**,每层都有含义:
 *   ① **人的开关**(名单语义一个字没动):whitelist 模式看白名单,all 模式看黑名单。
 *      人关掉的照样关 —— 包括陪伴会话(companion-session-never-off ④ 钉住)。
 *   ② **陪伴/桥的落点**:开着就可用,名单与形态都管不着它
 *      (QQ 消息进不来比"少一点洁癖"严重得多)。
 *   ③ **子代理/临时会话 ⇒ 关**:名单(`subagentSessions`,当时登记过的)
 *      或 id 形态(裸 UUID,老会话/header 缺席时的兜底)任一命中。
 *
 * ⚠️ 第 ③ 层是**故意**放在 ①② 之后的:它压不过人的手,但也正因为 `all` 模式下
 * 「开」不可表示(不在黑名单里 = 开),子代理在 all 模式下没有任何"显式开"的入口
 * —— 这正是这一轮要的语义(新会话默认关)。要让某条会话上线,把它从
 * `subagentSessions` 里去掉 / 换一个 `session-*` 的 id,而不是指望这里开口子。
 */
export function sessionEnabled(sessionId) {
  const c = readConfig()
  if (!c.enabled) return false
  const sid = String(sessionId || '')
  // ① 人的开关:名单语义与修前逐位一致(whitelist 模式另说,见函数头)
  const on = c.scope === 'whitelist' ? c.whitelist.includes(sid) : !c.exempt.includes(sid)
  if (!on) return false
  // ② 陪伴/桥落点永远可用(它是 QQ 的唯一入口)
  if (sid !== '' && sid === relaySessionIdOf()) return true
  // ③ 子代理/临时会话:默认关(名单 ∨ id 形态;判据在 lib/agent-scope.js 一处)
  if (c.subagentSessions.includes(sid) || isSubagentSessionId(sid)) return false
  return true
}

/**
 * 标记短语解析(纯函数):「Echo 上线」/「Echo 下线」切换当前会话。
 *
 * 2026-09-26 现场:他发「Echo 下线」没反应,因为他实际说的是「Echo 下线吧」
 * —— 旧实现要求整条消息去空白后**正好等于**四个字,而且不匹配时**一声不吭**。
 * 现在:
 *   · 口语都认(下线/关掉/休眠/别说话/安静点 …;上线/唤醒/回来/在吗 …)
 *   · 允许尾巴上的语气词与标点(吧/啊/呀/嘛/哦/了/!/。…)
 *   · 长度门放宽到 24 字,但**必须**出现「echo/小e/艾可」或整句就是那几个动词
 *     —— 否则「我今天想关掉这个项目」会被误判成关她。
 *   · ★ P3 B1 #2(2026-10-05):那几个动词**可配**(`lexicon.json.powerWords`,
 *     见 `powerWordsOf()`);数据空 / 缺键 ⇒ 就是下面两张默认表,行为逐位不变。
 * 命中返回 'on' | 'off';返回 null 时调用方**必须回一句状态**(不许静默)。
 */
const OFF_WORDS = ['下线', '关闭', '关掉', '关了', '休眠', '睡觉', '睡吧', '别说话', '安静点', '安静', '闭嘴', '停一下', '休息吧']
// 「在吗 / 出来 / 开始吧」**不算**上线 —— 那是日常招呼,不是开关。
// 误判的代价不对称:把招呼当上线会静默改范围,而漏判只是多问一句。
const ON_WORDS = ['上线', '唤醒', '醒来', '回来', '回来吧', '醒醒']

/**
 * 当前生效的开关口令:`lexicon.json.powerWords`(`{off:[…], on:[…]}`)有 ⇒ 用它。
 *
 * ★ P3 B1 #2(2026-10-05):口令是「她的开关」⇒ 属人格侧口味,不该焊在程序里
 * (总纲 §2.1 明写)。**逐键兜底**:只填了 `off` 就只覆盖 off,`on` 仍回默认表;
 * 键缺 / 空数组 / 坏形状 ⇒ 那一侧回默认表(空 ⇒ 与迁移前逐位一致)。
 * 每次现读(`lib/data-tables.js` 的纪律),永不抛。
 * @param {Record<string,string|undefined>} [env] 显式环境(测试 / 多实例用)
 */
export function powerWordsOf (env) {
  const words = objectField(lexiconOf(env), 'powerWords')
  const off = listField(words, 'off')
  const on = listField(words, 'on')
  return {
    off: (off !== null && off.length > 0) ? off : OFF_WORDS,
    on: (on !== null && on.length > 0) ? on : ON_WORDS
  }
}

// ★ P1 收口(2026-10-05 拍板 2):她的自称/别名**不再写在代码里**(原来是
// `['echo','小e','艾可','小echo']`)。真源 = `<数据目录>/profile.json` 的
// `agentAliases`(识别层;显示层只用 `agentName`,见 `lib/profile.js`)。
// 空(没填 / 文件缺 / 坏)⇒ **只用 agentName**;连它也空 ⇒ 空表(不猜、不兜真名)。
// 每次现读:与"引擎每帧现读 config.json"同一条纪律 —— 面板改了下一句就认得出。
// 归一与调用点同口径(小写、去空白)。
function selfWords () {
  const p = loadProfile()
  const words = p.agentAliases.length > 0
    ? p.agentAliases
    : (p.agentName !== '' ? [p.agentName] : [])
  const out = []
  for (const w of words) {
    const s = String(w ?? '').replace(/\s+/g, '').toLowerCase()
    if (s !== '' && !out.includes(s)) out.push(s)
  }
  return out
}
const TAIL = /[吧啊呀嘛哦呢了哈~～!！。.、,，?？\s]*$/

export function parseSessionMarker(text, env) {
  const raw = String(text || '').trim()
  if (raw === '') return null
  const t = raw.replace(/\s+/g, '').toLowerCase()
  if (t.length > 24) return null
  // 先剥尾巴上的语气词,再判词。
  const core = t.replace(TAIL, '')
  // ★ P1 收口(拍板 2 的漏网处):这句原来自带 `'echo' + w / '小e' + w / '艾可' + w`
  // 三个**写死的**前缀 —— 「她叫什么」又漏在代码里一份。现在前缀也从 `selfWords()`
  // (profile.json 的 agentAliases)拼;一个 alias 都没有 ⇒ 只剩裸动词那一支。
  const self = selfWords()
  // ★ P3 B1 #2:动词表也可配(powerWords;空 / 缺键 ⇒ 回默认表)。
  const { off: offWords, on: onWords } = powerWordsOf(env)
  const hit = (words) => words.some((w) => core === w || self.some((s) => core === s + w))
  if (hit(offWords)) return 'off'
  if (hit(onWords)) return 'on'
  // 带自称 + 动词的句子(「Echo 你先下线」「把 echo 关掉吧」):整句很短,
  // 且**以动词收尾** —— 否则「Echo 关掉记忆功能」会被误判成关她。
  const hasSelf = self.some((w) => core.includes(w))
  if (hasSelf && core.length <= 12) {
    if (offWords.some((w) => core.endsWith(w))) return 'off'
    if (onWords.some((w) => core.endsWith(w))) return 'on'
  }
  return null
}

/**
 * 他这句话**像不像**在跟她说开关(哪怕没解析成功)。
 * 用途:解析失败但意图明显时,回一句「我现在是休眠/在线」+ 用法,
 * 而不是像旧版那样一声不吭 —— 静默失败是这次事故的根。
 */
export function looksLikePowerTalk(text, env) {
  const t = String(text || '').replace(/\s+/g, '').toLowerCase()
  if (t.length > 24) return false
  const hasSelf = selfWords().some((w) => t.includes(w))
  const { off, on } = powerWordsOf(env)   // P3 B1 #2:读点同上(param 只为测试/多实例)
  const hasVerb = [...off, ...on].some((w) => t.includes(w))
  return hasSelf && hasVerb
}

/**
 * v0.11.0 会话来源标签(M8-a):sessionLabels 映射 sessionId → 标签
 * (「QQ中继」「DSH直聊」…),对话记录写时快照进 conversation_log
 * 的 channel 列 —— 标签注明这轮对话从哪个渠道来。中继桥(M8-b)
 * 首次调用自注册「QQ」;设置区/API 可改。空标签 = 未标注。
 */
export function sessionLabel(sessionId) {
  const sid = String(sessionId || '')
  if (sid === '') return ''
  try {
    const labels = readConfig().sessionLabels
    if (labels && typeof labels === 'object' && !Array.isArray(labels)) {
      return String(labels[sid] || '').slice(0, 24)
    }
  } catch { }
  return ''
}

/** 写会话标签(空标签 = 摘除该会话的标注)。 */
export function setSessionLabel(sessionId, label) {
  const sid = String(sessionId || '')
  if (sid === '') return readSessionLabels()
  const clean = String(label || '').trim().slice(0, 24)
  const labels = { ...readSessionLabels() }
  if (clean === '') delete labels[sid]
  else labels[sid] = clean
  writeConfig({ sessionLabels: labels })
  return labels
}

// (v0.29.0 个人机器人裁剪:sessionChat/setSessionChat/readSessionChats
// 「会话→群号」随群聊拒收一起退役 —— 群号是给「群与群互相隔离」用的,
// 没有群就没有这一维。老 config.json 里残留的 sessionChats 字段会被
// readConfig 的白名单读取自然忽略,不用清理。)

/** 读全部会话标签(纯对象副本)。 */
export function readSessionLabels() {
  try {
    const labels = readConfig().sessionLabels
    if (labels && typeof labels === 'object' && !Array.isArray(labels)) {
      const out = {}
      for (const [k, v] of Object.entries(labels)) {
        if (typeof k === 'string' && k !== '' && typeof v === 'string' && v !== '') out[k] = v.slice(0, 24)
      }
      return out
    }
  } catch { }
  return {}
}

// ═══════════════════════════════════════════════════════════════════════
// v0.14.4 调参(移植缺口 S4):A 侧 51 项配置里,真正需要可调的那批
// 落到 config.json 的 settings 段 —— 引擎帧早就在读 frame.get("config")
// (worker.py:467/495/524/541),此前壳侧一个都不传,参数全锁死默认值。
//
// 纪律与开关文件一致:读同步永不抛错、脏值回默认(fail-soft 向「照默认
// 跑」一侧倒,绝不因为一个坏数字让她失灵);写走 writeConfig 的原子
// 落盘并保留未知字段。数值一律钳位 —— 配置面板是给人填的,手滑打出
// 半衰期 99999 小时不该让想念曲线变成一条直线。
// ═══════════════════════════════════════════════════════════════════════

/**
 * 调参默认值。标注「A」的照抄 AstrBot 侧 _conf_schema.json 与
 * echo_constants.DEFAULTS 的默认值(出处行号已核)。
 */
export const SETTINGS_DEFAULTS = {
  // —— 治理上限 ——
  // A:audit_keep 200。本仓 SSE 每 3 秒轮询读审计,100 条足够看且更省
  // (2026-09-25 定案:100)。
  auditKeep: 100,
  // 每轮注入记忆条数。A 网关路径 8、legacy inject_top_k 3;本仓此前
  // 硬编码 6 —— 定案:保持 6 但做成配置,不制造行为突变。
  injectTopK: 6,
  // 2026-09-30 检索三项(实测见 docs/RETRIEVAL_OPT_2026-09-30.md):
  //   ① 常驻不占席(17/21 → 18/21,知识更新档 2/3 → 3/3)⇒ 默认开;
  //   ② 词法长尾臂(扩池)⇒ 默认开(配合①;单独用无效);
  //   ③ 时间臂 ⇒ 默认**关**(实测 no-op,留成旋钮)。
  recallCoreBlock: true,
  // 2026-09-30:长尾臂实测**零增益**,却会扩池把零重合的记忆当相关注入 ⇒ 默认**关**
  // (代码留着;要试就在面板上打开,它同时会打开 RT10 的三臂融合 —— 那一版实测 −2)
  recallLexArm: false,
  recallTimeArm: false,
  // 2026-09-30 第二批:查询扩展(实测 18/21 → 20/21;负控误取 6/7 → 3/7)
  recallExpand: true,
  expandTimeoutMs: 1200,
  // 2026-09-30 第三批:写入侧"说法键"进打分正文。**实测零增益**(§9)⇒ 默认关;
  // 键照写(下一步读时重排的底座),要不要它们参与打分由这一项决定。
  recallAugKeys: false,
  // 2026-10-11 Step 3:检索融合(BM25 + 向量,RRF)。**实验性功能,默认关** ——
  // 实测(37 条判据)融合 91.9% > BM25 89.2% > 向量 86.5%,但**生产尚未接入
  // 向量臂**(依赖 onnxruntime+numpy+模型 / 降级路不一致 / 模型预热 都待拍板),
  // 所以这一项**先只做开关本身**:落盘 + 面板可见 + 可一键关,**不接检索路径**
  // (打开它目前不改变任何检索行为)。
  recallFusion: false,
  // A:memory_ttl_days 30 / cleanup_every 10。
  memoryTtlDays: 30,
  cleanupEvery: 10,
  // —— 开关 ——
  reflectionEnabled: true,   // A:reflection_enabled
  driftEnabled: true,        // A:drift_check_enabled(v0.15.0 消费)
  driftEvery: 8,             // A:drift_check_every
  driftReinforceRounds: 3,   // A:drift_reinforce_rounds
  emotionDecayEnabled: true, // A:emotion_decay_enabled
  emotionDecayIntervalMinutes: 30, // A:emotion_decay_interval_minutes
  // —— v0.31.0 P2:心跳两个行为开关(账本不设开关,它是"失败可见"的地板)——
  heartbeatBackoffEnabled: true, // 空拍退避(安静时 2/4/8 分钟封顶;关 = 每分钟都判)
  wakeEnabled: true,             // 她自己的闹钟(echo_wake / 到点那条通道)
  // ── 2026-09-30 P2:主动性 v2「话题打分器」(施工图 §3.5 决定③)─────────────
  // **扁平标量键**(`tests/settings-fields.test.js:27-35` 的 indexOfDefaults 只拍平
  //  一层且按 typeof 断言 ⇒ weights 不许写成嵌套对象)。
  // **默认 `enabled:false` = 零行为变化**:关着时 `heartbeat.tick` 不打分,走的是
  //  今天一模一样的老路(施工图 §3.5 卫生纪律 ③)。
  // 复核(施工图 §3.5 决定①):本地分落进 `|score-threshold| <= reviewDelta` 的边缘区
  //  才花**一次**模型复核,且受日额度 `reviewBudgetPerDay` 约束;复核只决定"说不说",
  //  开口仍复用 `deliver`(**不新增第二个开口调用点**)。
  proactiveScoring: {
    enabled: false,            // 总开关(默认关;开了才有任何新行为)
    threshold: 0.6,            // 本地分过线才继续(与 topic-score 的 DEFAULT_THRESHOLD 同值)
    // 2026-09-30 方案 A(他拍板「阈值分类型」):**每种类型一条线**,不整体下调 ——
    // 实测真数据上话题 ≈0.548 / 记忆 ≈0.563 永远过不了那一条 0.6,只有日记
    // (修后 ≈0.659)能过;而把整条线拉低会让日记也跟着变松。
    // ★ **删掉这三个键(或写坏)就回到上面那条单一 `threshold`** —— 兜底回退,可回滚。
    thresholdArtifact: 0.60,   // 日记/她的产出(具体性满分,线保持高)
    thresholdThread: 0.52,     // 悬置话题(她惦记着、还没结掉的事)
    thresholdMemory: 0.55,     // 记忆(她记得的事)
    reviewEnabled: true,       // 边缘区要不要花那次模型复核
    reviewDelta: 0.08,         // 边缘区半宽(|score-threshold| <= 它才进复核)
    reviewBudgetPerDay: 6,     // 复核日额度(当天 care_beats 里 payload.reviewed=true 的行数)
    sourceFloor: 5,            // 来源保底:每个来源至少这么多条进池(修"日记进不了池"的饥饿)
    windowHours: 72,           // 候选窗口(日记/时效的"多久之内算新")
    cooldownMin: 180,          // 同一个话题提过之后的冷却(分钟)
    wUnstale: 0.25,            // 六维权重(与 topic-score 的 DEFAULT_WEIGHTS 同值)
    wGap: 0.15,
    wConcreteness: 0.20,
    wRecency: 0.15,
    wFreshness: 0.15,
    wEmotion: 0.10
  },
  // ── 2026-09-30 P4a:她的自由活动(空闲触发 + 真产出落盘)─────────────────────
  // 为什么要有:`~/.dsh/echo/workspace` 一直是空目录 ⇒ 概念稿 §4 那条
  // 「我有件事给你看(真做过)vs FOMO 钩子(编的)」的分界线**此前根本不存在**。
  // 这一组让她按空闲自己写一页,而且那一页**真的落在盘上**(候选池第四类来源
  // `note:` 读的就是它)。
  // **默认 `enabled:false` = 零行为变化**:关着时心跳那一档一个字都不做。
  // 执行体**复用既有管线**(不新增调用点):`diary` 借日记管线那次既有的模型调用
  // (`composeDiary`);`memory`(整理记忆)借压缩域既有的**只读**策展管线
  // (快速照 + `composeCuratedText`),**一个模型都不调**。产出只落文件 + 台账,
  // **不写 diary 表、不碰主记忆**(详见 `lib/her-activity.js` 的头部注释)。
  herActivity: {
    enabled: false,             // 总闸(默认关;开了才有任何新行为)
    budgetPerDay: 1,            // 一天最多做几次(0 = 等于关掉;**各类型共用这一份**)
    idleMin: 30,                // 他安静多久她才自己找活干(分钟)
    quietHoursSameAsCare: true, // 沿用夜闸口径(23~8 点不做)
    kind: 'diary'               // 做什么:P4b = diary(写一页)/ memory(整理记忆)
  },
  // v0.34.0 B5:他正在干活(最近有工具在跑)⇒ 她这一拍不插话(只压关怀通道,
  // 压不到他下的提醒与她自己的闹钟 —— 那两条到点就是到点)
  // (2026-09-29:「干活时不插话」`quietWhileWorking` 按他裁定删掉。) 
  // v0.37.0 G2:他**以前**的称呼(逗号分隔)。改名时自动往里追加(见 index.js 的
  // onNameChange),也可以手填;注入时记忆里的旧称会被改写成现在的称呼。
  // 只动记忆那一块 —— 他自己说过的话一个字不改(改历史就是把记录改成假的)。
  retiredAliases: '',
  // v0.38.0 F1:外部事件入口(传感器/将来的语音平台)开关。**默认关**(fail-closed):
  // 关着时 `/api/echo/event` 直接 403,不静默收下 —— 他以为门开着才是最坏的情况。
  externalWake: false,
  // v0.40.0 C5:开口前的过期失效检查 —— 闹钟/约定晚了超过这个小时数就作废
  // (作废**落账**,不会静默消失)。她的闹钟只看"晚了多少";他下的约定还要叠一条
  // "他中间说过话"才算过期(他一声不吭 ⇒ 照发)。
  staleHours: 24,
  // v0.40.0 C2:思考风格双档 —— 干活那一步给她一行"用中性思考、汇报短一点"
  // (出处 dsh-cosplay 的 THINKING_DIRECTIVES)。**默认开**,但只在本轮真用过
  // 宿主工具/多步轮时出现;聊天轮一个字不加(理由与那条被撤掉的尾部自检见
  // lib/thinking-style.js 的注释)。关掉 = 回到今天的行为,一模一样。
  thinkingNeutralWhenWorking: true,
  // 几件工具才算"干活"(默认 1:用过就算)。
  thinkingNeutralMinTools: 1,
  // v0.40.0 C1:情绪单轮闭环 —— 他这一句惹到她,**这一轮**就带情绪(出处
  // pad-emotion index.js:833-846)。做法:他开口那一刻并起一次很小的打分调用,
  // 与组装赛跑;赢 ⇒ 这一轮的心情快照换成新读数,输/超时 ⇒ 用旧向量照常回复。
  // 只影响这一轮的**渲染**;写库那条路仍归轮末反思(避免两个写者互相覆盖)。
  emotionSameTurn: true,
  // ★ 2026-10-08:新会话默认开关(按来源)。true = 这类来源的**新会话默认就跑她**。
  //   网页直聊默认关(要她答就发「Echo 上线」)；QQ 桥默认开。
  newSessionOn: { dsh: false, qq: true, other: false },
  // 打分等多久(毫秒,100~10000)。等不到就用上一轮的向量接着回复 ——
  // 他等的是回复,不是情绪打分;超时率是这条通道的体检指标(accept-emotion.mjs)。
  //
  // 2026-10-10:800 → **3000**。原值对一次完整的 LLM 调用不现实 ——
  // 活库实测 13/13 全超时,且 `ms` 全部落在 800~814(定时器每次都是赢家),
  // 说明**从来没有一次在 800ms 内返回过**。这条路走的是直调通道
  // (`index.js:2256` → `llmChannel.runStructured`)、与轮末反思**同一个
  // provider/model**(`chooseReflectTransport` 同源),而反思那条给的超时是
  // `llmTimeoutMs = 120000`。同为一个直调小任务的 `expandTimeoutMs` 是 1200。
  // ⇒ 800 不是"偶尔差一点",是**设计上就过不去**。
  // 先调大**取真实 ms 分布**(多数落 900~1500 ⇒ 此值即解;普遍 >5000 ⇒ 模型选错;
  // 仍紧贴 3000 全超时 ⇒ 不是慢,是通道有问题)。**只改这一个数,不动任何逻辑。**
  emotionScoreTimeoutMs: 3000,
  // v0.40.0 C3:出站清单 —— 禁词 / 防重复(出处 roleplay prompts.ts:52-110)。
  // **留空 = 用代码里那份默认表**(小说腔的固定禁词);他填了就**只**用他这份。
  // 默认动作 flag = **照发 + 落账 + 把理由告诉她**(静默过滤会把她的个性一起滤掉)。
  bannedWords: '',
  bannedAction: 'flag',
  repeatGuardSimilarity: 0.85,
  repeatGuardAction: 'flag',
  // v0.40.0 F4:她正在说话时事件怎么插队(出处 neuro-sdk SPECIFICATION.md:160)。
  // 覆盖表写成 `care=medium, wake=low`;认不出来的键与档位忽略。
  insertPriority: '',
  /**
   * ★ 2026-10-18：**忙时入站队列的上限**（她跑任务时，进来的消息排队等下一轮）。
   *
   * 现场：`injectInbound` 用 `agent.runMaintenance` 当互斥锁，而 DSH 侧忙时
   * **抛错**（`dsh-agent-loop/lib/index.js:823`）⇒ 适配器重试 6 次 ≈22.5 秒
   * 耗尽后**真丢**（journal 实测 52 条）。
   *
   * 现在忙时进队列（`lib/inbound-queue.js`），满了**丢最旧的**。
   * 实现在 `lib/index.js` 的 `injectInbound` / `flushInboundQueue`。
   * 越界由 `clampQueueLimit` 夹回 1~200。
   */
  inboundQueueLimit: 50,
  // ── 方案 C(2026-10-05):反思类调用的**直调通道**(不起子代理)─────────────
  // 子代理那条路每跑一次反思就留一个会话目录(实测 835 个 / 67.41 MB),而反思要的
  // 只是"一次带 schema 的 LLM 调用" ⇒ 改走宿主 `llm` 服务直调(见 `lib/llm-channel.js`)。
  // 下面六项是**那条通道自己的参数**(2026-10-06 方案 C 后语义变了):
  // provider/model 空 = **不覆盖**,通道默认继承本会话 route(继承也拿不到才退回
  // 子代理);直调不可用时不再"跳过本轮",而是明确退子代理并把原因写进状态面。
  llmProvider: '',           // 直调用 provider;空 = 继承本会话 route(覆盖项)
  llmModel: '',              // 直调用 model;空 = 继承本会话 route(覆盖项)
  llmDirectEnabled: true,    // 直调总闸;只有显式 false 才关(与 readCfg 的 `!== false` 同口径)
  llmMaxTokens: 4096,        // 单次产出上限(tokens;llm-channel 同默认。2026-10-06 由 1024 提高:思考也吃 maxTokens,1024 会思考没完就没了 ⇒ 空产出)
  llmTimeoutMs: 120000,      // 等多久(毫秒);= llm-channel 的 DEFAULT_TIMEOUT_MS
  llmMaxConcurrent: 1,       // 全局并发上限(反思是增益不是依赖,别和主对话抢)
  // ★ 2026-10-21：**后台池并发**（舱壁隔离）。轮末纯增益（反思那类）单独一个池，
  //   与组装前的情绪打分 / 查询扩展彻底分开 —— 后者有 5s/10s 截止期，拿不到就整轮作废。
  llmMaxConcurrentBulk: 1,
  // ★★ 2026-10-21：**小任务思考档**。情绪打分一个 6 字段 JSON 要 4–6 秒，
  //   占一句回复总等待的 70–82%（实测 5.83s 里 4.09s 是它）。根因是直调通道从不传
  //   `reasoningEffort` ⇒ 落进宿主默认 high。原生适配器里 'off' 就是真关思考。
  //   ⚠️ 空字符串 = 不传这个字段（= 宿主默认档）。**缺省给 'off'** —— 小任务不值得思考。
  llmSmallTaskEffort: 'off',
  // ── 第二批(2026-10-05):子代理会话自动清理(见 `lib/session-reaper.js`)─────────
  // 判据 = **轮数窗口**:保留"最近 reaperWindowTurns 轮对话"对应的过程数据
  // (边界从主对话会话文件的消息时间戳算,见 `lib/session-window.js`),
  // 子代理会话创建时间早于边界才删;`reaperKeepNewest` 是**并集兜底**
  // (排名在前的永远留)。算不出边界 ⇒ 退回 120 分钟时间窗口(宁可多留)。
  reaperEnabled: true,       // 自动清理总闸
  reaperWindowTurns: 20,     // 轮数窗口:留住最近多少轮(2026-10-05 拍板 300→20:300 在真实语料上几乎总是 partial)
  reaperKeepNewest: 0,       // 并集兜底:默认 0 = 不用排名兜底(拍板:50 会把"该删的"先全保下来)
  // ── 第三批(2026-10-05):情绪空间融合(联合空间桥接)───────────────────────
  // 见 `lib/emotion-space.js`(声明)/ `lib/space-bridge.js`(桥接)。
  // 角度两项是**文献值**(Yik & Russell 2004:情感侧 35°、IPC 侧 71°),
  // 其余是 [工程假设](拍板 ③④:参数化、面板可调、可回滚)。
  // 影子模式默认开(拍板 ⑤):只算 + 写审计(`emotion_pack_structured`),
  // **不进 prompt**;看够了再把 shadowMode 关掉才真正进注入块。
  bridgeEnabled: true,       // 联合空间总闸(关 = 完全不算,历史行为)
  bridgeShadowMode: true,    // 影子模式:算 + 记,不注入
  bridgeThetaS: 35,          // [文献] 情感环侧共享轴角(度)
  bridgeThetaSipc: 71,       // [文献] IPC 侧共享轴角(度)
  bridgeThetaD: 0,           // [工程假设] 支配轴耦合角(度)
  bridgeLambdaS: 1,          // [工程假设] 共享轴尺度(待标定)
  bridgeLambdaD: 1,          // [工程假设] 支配轴尺度(待标定)
  bridgeBiasS: 0,            // [工程假设] 共享轴偏置(吸收 IPC 单极↔双极的常数项)
  bridgeExposeErr: true,     // 渲染时是否带不确定度(bridge_err)
  // 方案 C 第一步(2026-10-05):语气候选 —— 把情绪读数折成 <emo type="N"> 候选集,
  // 由 describeMood 追加一行进 prompt(**只出号**;delta=0 不出行;门禁黄/红不引用 s)。
  // 关 = 完全回滚(与加它之前逐字节一致)。见 `lib/style-hint.js`。
  styleHint: true,
  // —— 2026-10-06:用户侧坐标(人际关系打分)+ 人格基线 ——
  // 设计见桌面《情绪面板缺口补齐设计-2026-10-06.md》§1/§2;落地在
  // `lib/ipc-appraise.js`(打分编排 + 残差对账)与 `lib/her-baseline.js`(基线归一)。
  // 打分器跑在**轮末异步**(与反思并行)**不进 prompt**,只上屏 ⇒ 这几项只管
  // "多久判一次 / 判到多可信才落库",不影响回复时延(同 `emotionScoreTimeoutMs` 的理由)。
  ipcAppraiseEnabled: true,      // 总闸:关 = 完全不判(等于回到加它之前)
  ipcAppraiseEveryTurns: 3,      // 至少隔几轮才判一次
  ipcAppraiseMinMinutes: 10,     // 至少隔几分钟才判一次(与轮数**两条都过**才跑)
  ipcAppraiseGainMin: 0.35,      // 可信度下限:低于它**不落库**(只写审计,面板显示"本轮未判定")
  ipcAppraiseTurns: 5,           // 喂给打分器的最近几轮对话
  // 人格基线(立方体里那个静止点):**只做 P/A 两维,`d` 恒 null** —— dominance 在本仓
  // 是"已登记未启用"(`lib/emotion-space.js` 的 DIM_OWNERSHIP 标的 registered-only),
  // 基线不许把第三维编出来。原生值口径(同 `global.valence` [-10,10] /
  // `global.arousal` [1,10]),**不经联合空间桥接**。
  herBaselineEnabled: false,     // 总闸:关着 = 立方体里没有基线(整块跳过,不画假的点)
  herBaselineP: 2,               // 手填:心情(原生值)
  herBaselineA: 3,               // 手填:唤醒度(原生值)
  herBaselineSource: 'manual',   // manual / mean / inferred(**面板只读**,由程序写)
  herBaselineUpdatedAt: 0,       // 最后一次改动的毫秒时间戳(**面板只读**)
  // —— 记忆去重闸(v0.16.0 M3)——
  // 槽位路径没命中时的「换说法近似」判定:同层 + (关键词 Jaccard ≥
  // dedupeSimilarity 或 摘要双字重合 ≥ dedupeSummarySimilarity) 即判为
  // 同一件事的另一种说法 → 新行落库、旧行让位(不删)。
  // 实测基线(2026-09-25 活库):161 条现役里 43 条可让位。
  // 两个都给 0 = 关闭 = 回到「同键同句才算想起」的旧行为。
  dedupeSimilarity: 0.6,
  dedupeSummarySimilarity: 0.7,
  // —— 人格接地 ——
  herInterests: '',   // A:her_interests(逗号分隔;喂 agenda_pick 的 persona 项)
  masterAliases: '',  // A:master_aliases(逗号分隔;她该认得的称呼)
  // 漂移体检的判定标准 —— **P1e(2026-10-05 拍板)已退役**:真源是
  // `<数据目录>/persona.json` 的 prefix/suffix(`lib/drift.js` 的
  // `personaDigestForDrift` 派生),面板只读展示。所以这里不再有
  // `personaSummary`/`personaRules` 两键(老 config.json 里若还留着副本,
  // 见 `RETIRED_SETTINGS_KEYS`:丢弃、不告警、不写回)。
  // —— 想念/关怀(A_eight 项,引擎侧可配,此前壳从不传)—— 
  longing: {
    enabled: true,        // A:longing_enabled
    half_life_hours: 3.0, // A:longing_half_life_hours
    threshold: 7.0,       // A:longing_threshold
    msg_drop: 4.0,        // A:longing_msg_drop
    care_relief: 0.5,     // A:longing_care_relief
    protest_kick: 1.5,    // A:longing_protest_kick
    cooldown_minutes: 120, // A:care_cooldown_minutes
    night_hold: true,     // A:care_night_hold(23~8 点想念照涨但不开口)
    demo_rate: 1.0,       // A:longing_demo_rate(演示倍率)
    // v0.19.0 D2:轮末硬保证(A 侧无此开关 —— 它是 DSH 侧的 turn-stopping
    // 机制)。到阈值却没把想念说出口 ⇒ 轮将停时 steer 续一步,每轮至多一次。
    // 关掉它只是少了这道保证,想念照常涨、关怀照常开口。
    must_say: true,
    // P2-A 渠道闸(2026-10-06):只在**平台轮**(QQ 中继进来的)补那一句。
    // 他在 DSH 里直接说话时补 ⇒ 界面上多出一条"自言自语",而且 heart-tts 会把
    // 它当用户抢话、砍掉正常回复的音频(诊断报告见桌面「交接」)。默认 true。
    // 设 false = 恢复旧行为(任何轮都补)—— 与 must_say 是**串联**的:
    // must_say 是总闸,这一条是渠道子闸。
    steerOnlyFromPlatform: true
  },
  // —— 压缩即策展(v0.20.0 D1)——
  // 只在「Echo 陪伴模式」预设被选中时才有意义(那个预设里的 compaction
  // 域指向 dsh-echo/compaction)。curated=false ⇒ 用兜底的一页最小账本
  // (仍然不写英文工程检查点);budgetTokens 是策展块的硬预算 ——
  // 区域事务会拒绝"不比被遮蔽历史小"的摘要,所以它必须真的小。
  compaction: {
    curated: true,
    budgetTokens: 1200
  },
  // —— 情绪余波(v0.21.0 E5)——
  // Judge 说「忍不住还想补一句」时,延迟 2~5 秒追加一句;**他在这期间再
  // 开口 ⇒ 立刻撤回**(A `main.py:1382-1479` 同名同单位:秒)。关掉只是
  // 少了这半句话,别的都不变。
  say_again: {
    enabled: true,
    min_delay_sec: 2.0,
    max_delay_sec: 5.0
  },
  // —— 议程簿与整固(v0.22.0:把 A 的两个开关接出来)——
  // A `main.py:1818`:agenda_enabled 只在**取用**那一步设门(登记照旧);
  // A `main.py:1926-1927`:整固阈值与窗口上限。
  agenda: {
    enabled: true
  },
  reflection: {
    importance_threshold: 30.0, // A echo_constants.py:69
    max_inputs: 50              // A echo_constants.py:70(实际取 max(5, cfg))
  },
  // —— 跨会话的「刚说过什么」(2026-09-26 现场发现)——
  // 现场:他在 DSH 里新开一条会话跟她说话,她说不出另一条会话刚聊过
  // 的事 —— 因为**上下文是会话自带的**(DSH 的 10 轮在那条会话里),
  // 而 A 侧老插件当年是「按人一份全局上下文」,所以他觉得"她忘了"。
  // 这里补的是**短期连续性**,不是记忆:从全局 conversation_log 里取
  // 别的会话最近几轮,渲染成一小段【别处刚说过的】注入进去。
  // 0 = 关(回到纯会话内上下文)。不改长期记忆那条路。
  sharedRounds: 4,
  // —— 传话桥(R2:v0.17.0)——
  // 平台侧(QQ)只当嘴和耳朵,核心在 DSH。**总闸默认关**:
  // enabled=false 或 token 为空 ⇒ 桥完全不工作,连陪伴会话都不建
  // (闸门顺序:先在入口判,别在把会话拉起来之后再判)。
  relay: {
    enabled: false,          // 总闸
    token: '',               // Bearer token;**空 = 桥关闭**(第二道闸)
    sessionId: 'session-echo-companion', // 全平台共用的那一个陪伴会话(D1)
    cwd: '',                 // 陪伴会话的工作目录;空 = ~/.dsh/echo/workspace
    // 中继会话的权限预设(待拍 #10 的推荐默认:只读起步)。
    // 工具既然不精简(已拍),权限就是唯一的安全边界,值得保守。
    // 留空 = 不动权限(用宿主默认,危险);'off' 同理。
    permissionPreset: 'read-only',
    // 2026-09-29 他裁定 A:「QQ 跟着你在用的窗口」。开(默认)= QQ 入站进
    // "他正在用的那条会话"(`lib/companion-target.js` 的挑选),她的回复也就
    // 出现在同一条 —— 他看到的现场是"她在隔壁窗口回复";关 = 回到固定陪伴会话。
    followHisWindow: true,
    // 主动开口推到哪(v0.29.0 起 'all' 随群聊退役:没有群,「群里也推」
    // 没有意义;老配置里写 'all' 会被下面的 scopeOf 归一到 'private')。
    // private = 只推私聊(唯一选项)| off = 不推(她只在被搭话时回)
    proactiveScope: 'private',
    // **本地回推**(2026-09-26 现场:他在 DSH 里对着伴聊会话说话,QQ 也
    // 收到了那条回复 —— 因为那一轮没有来路(origin),于是推给了绑在
    // 这个会话上的全部渠道)。默认 false:在 DSH 里直接跟她说的话,回复
    // 留在 DSH,不再推到 QQ(你人就在她眼前,没必要同一条话说两处)。
    // 想让她「在 DSH 里替你把话带到 QQ」再打开。
    pushLocalTurns: false,
    // **被搭话的回复要不要自动送**(2026-09-26 产品裁定:不要)。
    // 他的模型是「QQ 是她调用的工具」,所以回话也归她决定:她调
    // `echo_qq_say` 才发。默认 false。
    // 代价说清楚:模型偶尔忘了调工具 = 她在 QQ 上静默。所以轮末会**记一笔**
    // 「这一条入站还没回」(日志 + 审计),好让「她是不是漏回」变成可观测的
    // 数字;想反悔就把这个开关打开(回到每次必回的自动送)。
    autoReplyToOrigin: false,
    outboxLeaseSec: 30,      // 出站租约(适配器崩了不丢消息,最多重发一次)
    replyMaxChars: 500,      // 单条上限(适配器侧按这个切段)
    proactiveTtlSec: 300,    // 主动话的保鲜期:5 分钟没发出去就丢(迟到的关怀不是关怀)
    // 关怀正文的字数上限(v0.18.1 C3)。A 侧 `main.py:1852` 硬编码 120:
    // 「提醒是履约,组稿失败有确定性模板兜底;关怀是情感,套话即假话 ——
    // 组不出真话就宁可这轮不说」。超长照 A 侧规矩**整条不发**,但会留审计
    // (`care_silent`),免得"她为什么没开口"变成猜。0 = 关掉这条闸。
    proactiveMaxChars: 120
  },
  // —— 气泡分条(v0.18.0,从 A 侧 v8.10.0 原样移植)——
  // A 侧三项:`bubble_split_enabled` / `bubble_max_chars`(30)/ `bubble_delay_scale`(1.0),
  // 默认值与 A 完全一致。关掉它 = 回到「一整段发出去」的旧行为。
  bubble: {
    enabled: true,
    maxChars: 30,
    delayScale: 1.0
  },
  /**
   * ★ 2026-10-19：**群聊那三句提示词**开放成可配（他拍的「甲方案」）。
   *
   * 这三句原来硬编码在 `lib/relay.js` 的 `renderInboundText` 里
   * （`brevity` / `masterNote` / 非主人警示）。他改不了口吻，只能改代码。
   *
   * 现在：**留空 = 用内置默认**（向后兼容 —— 老配置里没这组时行为一字不变）。
   * 填了就用他的；没带方括号会自动补一层（见 `relay.js` 的 `composeGroupPrompt`）。
   *
   * ⚠️ 只开放这三句。`extract` / `reflection` 的 prompt **不动** ——
   *   那两个绑死 JSON schema，开放出去改坏就是解析失败（丙方案，不做）。
   */
  groupChatPrompts: {
    shortReply: '',      // 群聊简短回复 + 「这句话也许不是对你说的」
    masterHint: '',      // 主人标记（可以亲近/撒娇/主动关心）
    guestWarning: ''     // 非主人警示（别擅自答应、别透隐私）
  }
}

const clampNum = (v, lo, hi, dflt) => {
  // 2026-09-26(写整固旋钮时抓到的):以前直接 Number(v),于是**手改配置里写个
  // null / true / [] 会被静默钳成下限**(Number(null)=0),而不是回默认值 ——
  // `max_inputs: null` 本意是"没填",结果变成"5 条窗口"。现在只认数字与
  // 数字字符串,其余一律当没填。
  if (typeof v === 'number') {
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt
  }
  if (typeof v !== 'string' || v.trim() === '') return dflt
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}
const clampInt = (v, lo, hi, dflt) => Math.round(clampNum(v, lo, hi, dflt))
const boolOf = (v, dflt) => (typeof v === 'boolean' ? v : dflt)
/** 逗号/顿号分隔的短清单 → 去重数组(每项 ≤ 24 字,最多 20 项)。 */
const listOf = (v) => String(v ?? '')
  .split(/[,，、]/)
  .map((s) => s.trim().slice(0, 24))
  .filter((s) => s !== '')
  .slice(0, 20)
const strOf = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
/** v0.40.0 C3/F4:枚举型开关 —— 只认白名单里的值,别的(乱填/大小写跑偏)回落默认。 */
const pickOf = (v, allowed, dflt) => {
  const s = String(v ?? '').trim().toLowerCase()
  return allowed.includes(s) ? s : dflt
}
/** 正数钳位(0 与不合法 → 默认值;上限也一并管住)。 */
const posOf = (v, dflt, max) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return dflt
  return Math.min(n, max)
}
/**
 * 方案 A 的**类型专属线**(`thresholdArtifact` / `thresholdThread` / `thresholdMemory`)。
 *
 * 只认 **0~1 之间的有限数**(数字,或数字字符串 —— 与 `clampNum` 同一条输入口径);
 * 其余(缺失 / 空串 / NaN / 负数 / >1 / 胡写)一律**退回兜底 `threshold`**:
 * 他点名的语义是"三个键坏掉或删掉 ⇒ 回到今天的单一阈值",所以这里**不是钳到 0/1**,
 * 而是回退 —— 钳位会把一条坏线变成"永远过不了"或"永远过",那比回退危险得多
 * (与 `heartbeat.js staleLimitHours` 那条教训同科:门槛坏了要退回默认,
 * 不能退化成"一律作废")。
 * 消费侧还有 `topic-score.thresholdFor` 兜第二道(它更严:只认数字)。
 */
const typeLineOf = (v, dflt) => {
  const raw = (typeof v === 'number') ? v : (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) return dflt
  return raw
}

/**
 * 上次告警过的"程序不认识的键"。
 * 为什么只在**键集变化**时才喊:`readSettings()` 每轮都跑一遍归一,
 * 每回合往日志里塞一行同样的告警 = 把真信号淹掉。
 */
let lastUnknownSettingsKeys = []

/**
 * P1e(2026-10-05 拍板):**退役的键** —— 见过、但现在没人读了。
 *
 * `personaSummary` / `personaRules` 原来是面板手填字段(漂移体检的判定标准),
 * 现在真源是 `<数据目录>/persona.json`,`lib/drift.js` 只从那里派生、面板也只读展示。
 * 老 `config.json` 里可能还留着这两位的副本 —— 它们的处理是:
 *   · **原文件不删不写**(他的数据一个字节不动);
 *   · 读取时**丢弃且不告警** —— 它们不是"用户塞错了键",是时代产物,
 *     混进 `_unknown` 段反倒会让体检报告出现假噪声。
 * 退役键列表只增不改:以后再有字段退役,加到这里即可。
 */
const RETIRED_SETTINGS_KEYS = ['personaSummary', 'personaRules']

function noteUnknownSettingsKeys (names) {
  const sorted = names.slice().sort()
  if (sorted.join('\u0000') === lastUnknownSettingsKeys.join('\u0000')) return
  lastUnknownSettingsKeys = sorted
  try {
    console.warn('echo: settings 里有 ' + sorted.length + ' 个程序不认识的键(不会生效),'
      + '已存进 `_unknown` 段:' + sorted.join('、'))
  } catch { /* 告警失败不影响归一 */ }
}

/** 体检/面板读它:「这份配置里有哪些程序不认识的键」。空数组 = 干净。 */
export function unknownSettingsKeys () {
  return [...lastUnknownSettingsKeys]
}

/** 把 settings 段逐项校验钳位成合法形状(纯函数,可测)。 */
export function normalizeSettings(raw) {
  const d = SETTINGS_DEFAULTS
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  const rl = (r.longing && typeof r.longing === 'object' && !Array.isArray(r.longing)) ? r.longing : {}
  const rr = (r.relay && typeof r.relay === 'object' && !Array.isArray(r.relay)) ? r.relay : {}
  const rb = (r.bubble && typeof r.bubble === 'object' && !Array.isArray(r.bubble)) ? r.bubble : {}
  // ★ 2026-10-19：群聊三句提示词的原始输入（空 = 用 relay.js 的内置默认）
  const rgp = (r.groupChatPrompts && typeof r.groupChatPrompts === 'object' && !Array.isArray(r.groupChatPrompts))
    ? r.groupChatPrompts
    : {}
  const scopeOf = (v, dflt) => {
    const s = String(v ?? '').trim().toLowerCase()
    // v0.29.0:'all' 不再是合法值 —— 群聊拒收后它等价于 'private'
    return (s === 'private' || s === 'all' || s === 'off')
      ? (s === 'all' ? 'private' : s)
      : dflt
  }
  const presetOf = (v, dflt) => {
    const s = String(v ?? '').trim()
    if (s === '') return dflt
    // 预设名由部署决定(web profile 有 almost-full-access),这里只挡
    // 明显的注入形状,具体名字是否存在由 bridged 侧 resolve() 判。
    return /^[a-z][a-z0-9-]{0,31}$/.test(s) ? s : dflt
  }
  const out = {
    auditKeep: clampInt(r.auditKeep, 20, 5000, d.auditKeep),
    injectTopK: clampInt(r.injectTopK, 1, 12, d.injectTopK),
    // 2026-09-30:三项检索开关(漏归一 ⇒ 面板上关不掉,是这条电池点名过的老坑)
    recallCoreBlock: boolOf(r.recallCoreBlock, d.recallCoreBlock),
    recallLexArm: boolOf(r.recallLexArm, d.recallLexArm),
    recallTimeArm: boolOf(r.recallTimeArm, d.recallTimeArm),
    recallExpand: boolOf(r.recallExpand, d.recallExpand),
    expandTimeoutMs: clampInt(r.expandTimeoutMs, 200, 8000, d.expandTimeoutMs),
    recallAugKeys: boolOf(r.recallAugKeys, d.recallAugKeys),
    // 2026-10-11 Step 3:漏归一 ⇒ 面板上关不掉(这条电池点名过的老坑)
    recallFusion: boolOf(r.recallFusion, d.recallFusion),
    memoryTtlDays: clampInt(r.memoryTtlDays, 1, 3650, d.memoryTtlDays),
    cleanupEvery: clampInt(r.cleanupEvery, 1, 1000, d.cleanupEvery),
    reflectionEnabled: boolOf(r.reflectionEnabled, d.reflectionEnabled),
    driftEnabled: boolOf(r.driftEnabled, d.driftEnabled),
    driftEvery: clampInt(r.driftEvery, 1, 200, d.driftEvery),
    driftReinforceRounds: clampInt(r.driftReinforceRounds, 0, 50, d.driftReinforceRounds),
    emotionDecayEnabled: boolOf(r.emotionDecayEnabled, d.emotionDecayEnabled),
    emotionDecayIntervalMinutes: clampInt(r.emotionDecayIntervalMinutes, 5, 1440, d.emotionDecayIntervalMinutes),
    // v0.31.0 P2:两项都要在这里归一,漏一项 ⇒ 面板上的开关永远关不掉
    // (`must_say` 那条漏项的老坑,见 lib/settings-fields.js 的键集对齐电池)
    heartbeatBackoffEnabled: boolOf(r.heartbeatBackoffEnabled, d.heartbeatBackoffEnabled),
    wakeEnabled: boolOf(r.wakeEnabled, d.wakeEnabled),
    // 2026-09-30 P2:主动性 v2 打分器(整组 13 项;方案 A 后 = 16 项)。
    // ★ **漏掉这一处,面板上这整组开关就是假的** —— 字段表里有、normalize 之后
    // 没有 ⇒ `readSettings().proactiveScoring` 恒为 undefined,消费端永远读默认值
    // (与 `longing.must_say` / 整组 `compaction` 那两次现场事故同一科;
    //  `tests/settings-fields.test.js:130` 的键集对齐电池专抓这一条)。
    proactiveScoring: (() => {
      const rp = (r.proactiveScoring && typeof r.proactiveScoring === 'object'
        && !Array.isArray(r.proactiveScoring)) ? r.proactiveScoring : {}
      // 先归一出**统一线**,再拿它当三个类型线的兜底 —— 兜底必须是"这一份配置里
      // 真正生效的那条线",不是出厂常数(否则他把统一线调到 0.45,坏掉的话题线
      // 会回退到 0.6,面板上就出现两条自相矛盾的线)。
      const thr = clampNum(rp.threshold, 0, 1, d.proactiveScoring.threshold)
      return {
        enabled: boolOf(rp.enabled, d.proactiveScoring.enabled),
        threshold: thr,
        // 2026-09-30 方案 A:三个类型线也要在这里归一(漏一项 ⇒ 面板上改了不生效),
        // 每一条的兜底都是统一线(坏值/越界 ⇒ 回退 = 回滚路径)。
        thresholdArtifact: typeLineOf(rp.thresholdArtifact, thr),
        thresholdThread: typeLineOf(rp.thresholdThread, thr),
        thresholdMemory: typeLineOf(rp.thresholdMemory, thr),
        reviewEnabled: boolOf(rp.reviewEnabled, d.proactiveScoring.reviewEnabled),
        reviewDelta: clampNum(rp.reviewDelta, 0, 0.5, d.proactiveScoring.reviewDelta),
        reviewBudgetPerDay: clampInt(rp.reviewBudgetPerDay, 0, 100, d.proactiveScoring.reviewBudgetPerDay),
        sourceFloor: clampInt(rp.sourceFloor, 0, 50, d.proactiveScoring.sourceFloor),
        windowHours: clampInt(rp.windowHours, 1, 24 * 14, d.proactiveScoring.windowHours),
        cooldownMin: clampInt(rp.cooldownMin, 0, 24 * 60, d.proactiveScoring.cooldownMin),
        wUnstale: clampNum(rp.wUnstale, 0, 1, d.proactiveScoring.wUnstale),
        wGap: clampNum(rp.wGap, 0, 1, d.proactiveScoring.wGap),
        wConcreteness: clampNum(rp.wConcreteness, 0, 1, d.proactiveScoring.wConcreteness),
        wRecency: clampNum(rp.wRecency, 0, 1, d.proactiveScoring.wRecency),
        wFreshness: clampNum(rp.wFreshness, 0, 1, d.proactiveScoring.wFreshness),
        wEmotion: clampNum(rp.wEmotion, 0, 1, d.proactiveScoring.wEmotion)
      }
    })(),
    // (2026-09-29:「干活时不插话」`quietWhileWorking` 按他裁定删除,不再归一。)
    // 2026-09-30 P4a:她的自由活动(整组五项,默认关)。整组里任何一个键漏在
    // normalize 之外 ⇒ 面板上拨了不生效(与 `longing.must_say` / 整组 `compaction`
    // 那两次现场事故同一科)。`kind` 只收小写短标识:`P4b` 之后加活动类型时,
    // 这里不用改;认不出的值回落到出厂 `diary`(而消费端对没实现的 kind 记
    // `failed` 而不是硬做 —— 见 `lib/index.js` 的 `runHerActivity`)。
    // ⚠️ P4b 有意**不做白名单**(比如只许 diary/memory):白名单会把"还没实现的
    // kind"(`goal` 之类)静默**换成 diary** —— 他以为在立小目标,她却在写日记。
    // 现在的形状是"值照收、消费端按 `kind-not-implemented` 留 failed 账",
    // 认得出与认不出都看得见。允许值域见 `lib/her-activity.js ACTIVITY_KINDS`。
    herActivity: (() => {
      const rh = (r.herActivity && typeof r.herActivity === 'object'
        && !Array.isArray(r.herActivity)) ? r.herActivity : {}
      const kind = String(rh.kind ?? '').trim().toLowerCase()
      return {
        enabled: boolOf(rh.enabled, d.herActivity.enabled),
        budgetPerDay: clampInt(rh.budgetPerDay, 0, 24, d.herActivity.budgetPerDay),
        idleMin: clampInt(rh.idleMin, 1, 1440, d.herActivity.idleMin),
        quietHoursSameAsCare: boolOf(rh.quietHoursSameAsCare, d.herActivity.quietHoursSameAsCare),
        kind: /^[a-z][a-z0-9-]{0,31}$/.test(kind) ? kind : d.herActivity.kind
      }
    })(),
    retiredAliases: strOf(r.retiredAliases, 300),
    externalWake: boolOf(r.externalWake, d.externalWake),
    staleHours: posOf(r.staleHours, d.staleHours, 24 * 30),
    thinkingNeutralWhenWorking: boolOf(r.thinkingNeutralWhenWorking, d.thinkingNeutralWhenWorking),
    thinkingNeutralMinTools: clampInt(r.thinkingNeutralMinTools, 1, 5, d.thinkingNeutralMinTools),
    emotionSameTurn: boolOf(r.emotionSameTurn, d.emotionSameTurn),
    // ★ 2026-10-08:三档来源各自的“新会话默认开”(缺一档 ⇒ 回默认)
    newSessionOn: {
      dsh: boolOf(r.newSessionOn?.dsh, d.newSessionOn.dsh),
      qq: boolOf(r.newSessionOn?.qq, d.newSessionOn.qq),
      other: boolOf(r.newSessionOn?.other, d.newSessionOn.other)
    },
    emotionScoreTimeoutMs: clampInt(r.emotionScoreTimeoutMs, 100, 10000, d.emotionScoreTimeoutMs),
    bannedWords: strOf(r.bannedWords, 2000),
    bannedAction: pickOf(r.bannedAction, ['flag', 'hold', 'mask'], d.bannedAction),
    repeatGuardSimilarity: clampNum(r.repeatGuardSimilarity, 0, 1, d.repeatGuardSimilarity),
    repeatGuardAction: pickOf(r.repeatGuardAction, ['flag', 'hold'], d.repeatGuardAction),
    insertPriority: strOf(r.insertPriority, 500),
    // ★ 2026-10-18：忙时入站队列上限（1~200，越界夹回默认 50）
    inboundQueueLimit: clampInt(r.inboundQueueLimit, 1, 200, d.inboundQueueLimit),
    // 方案 C(2026-10-05):反思直调六项。这里漏一项 ⇒ 面板上改了不生效
    // (与 `longing.must_say` / 整组 `compaction` 那两次现场事故同一科;
    //  `tests/settings-fields.test.js` 的键集对齐电池专抓这一条)。
    // 键都是**扁平标量**(不嵌子对象),所以 writeSettings 的逐组合并那几行
    // 不用动 —— 它们随 `...p` / `...cur` 原样穿过。
    llmProvider: strOf(r.llmProvider, 120),
    llmModel: strOf(r.llmModel, 120),
    llmDirectEnabled: boolOf(r.llmDirectEnabled, d.llmDirectEnabled),
    llmMaxTokens: clampInt(r.llmMaxTokens, 128, 8192, d.llmMaxTokens),
    llmTimeoutMs: clampInt(r.llmTimeoutMs, 5000, 600000, d.llmTimeoutMs),
    llmMaxConcurrent: clampInt(r.llmMaxConcurrent, 1, 8, d.llmMaxConcurrent),
    // ★ 2026-10-21：后台池并发（舱壁隔离的另一半）。**不夹这一项 ⇒ 面板改了不生效**
    //   —— 这个仓反复踩的"漏一项"同款,一处不许少。
    llmMaxConcurrentBulk: clampInt(r.llmMaxConcurrentBulk, 1, 8, d.llmMaxConcurrentBulk),
    // ★★ 2026-10-21：小任务思考档。**不夹这一项 ⇒ 面板改了不生效**（同一条纪律）。
    //   留空 = 不传字段（= 宿主默认档）；没配 = 取缺省 'off'。
    //   用 `=== undefined` 判而不是 `||`：**空字符串是合法值**（它表示"别传这个字段"）。
    llmSmallTaskEffort: (r.llmSmallTaskEffort === undefined
      ? d.llmSmallTaskEffort : String(r.llmSmallTaskEffort).slice(0, 16)),
    // 第二批(2026-10-05):会话清理三项 —— 同样"这里漏一项 ⇒ 面板改了不生效"
    // (轮数窗口是主判据;时间窗口键 reaperWindowMinutes 已从键集移除,
    //  只作为算不出边界时的内部兜底常量活在 session-reaper.js 里)。
    reaperEnabled: boolOf(r.reaperEnabled, d.reaperEnabled),
    reaperWindowTurns: clampInt(r.reaperWindowTurns, 10, 20000, d.reaperWindowTurns),
    reaperKeepNewest: clampInt(r.reaperKeepNewest, 0, 5000, d.reaperKeepNewest),
    // 第三批(2026-10-05):情绪空间融合九项 + 语气候选一项(共十项)—— 同样"这里漏一项
    // ⇒ 面板改了不生效"(角度折进 (−180,180];尺度下限 0.05 防止除零;偏置夹在 [−1,1])。
    bridgeEnabled: boolOf(r.bridgeEnabled, d.bridgeEnabled),
    bridgeShadowMode: boolOf(r.bridgeShadowMode, d.bridgeShadowMode),
    bridgeThetaS: clampNum(r.bridgeThetaS, -180, 180, d.bridgeThetaS),
    bridgeThetaSipc: clampNum(r.bridgeThetaSipc, -180, 180, d.bridgeThetaSipc),
    bridgeThetaD: clampNum(r.bridgeThetaD, -180, 180, d.bridgeThetaD),
    bridgeLambdaS: clampNum(r.bridgeLambdaS, 0.05, 20, d.bridgeLambdaS),
    bridgeLambdaD: clampNum(r.bridgeLambdaD, 0.05, 20, d.bridgeLambdaD),
    bridgeBiasS: clampNum(r.bridgeBiasS, -1, 1, d.bridgeBiasS),
    bridgeExposeErr: boolOf(r.bridgeExposeErr, d.bridgeExposeErr),
    // 方案 C 第一步:语气候选开关(漏了这条 ⇒ 面板上关不掉 = 回滚是假的)
    styleHint: boolOf(r.styleHint, d.styleHint),
    // 2026-10-06:用户侧坐标打分 + 人格基线(共十项)—— 同上面那条老规矩:
    // **这里漏一项 ⇒ 面板上改了不生效**(键都是扁平标量,不用动 writeSettings 的逐组合并)。
    ipcAppraiseEnabled: boolOf(r.ipcAppraiseEnabled, d.ipcAppraiseEnabled),
    ipcAppraiseEveryTurns: clampInt(r.ipcAppraiseEveryTurns, 1, 100, d.ipcAppraiseEveryTurns),
    ipcAppraiseMinMinutes: clampInt(r.ipcAppraiseMinMinutes, 0, 1440, d.ipcAppraiseMinMinutes),
    ipcAppraiseGainMin: clampNum(r.ipcAppraiseGainMin, 0, 1, d.ipcAppraiseGainMin),
    ipcAppraiseTurns: clampInt(r.ipcAppraiseTurns, 1, 20, d.ipcAppraiseTurns),
    herBaselineEnabled: boolOf(r.herBaselineEnabled, d.herBaselineEnabled),
    herBaselineP: clampNum(r.herBaselineP, -10, 10, d.herBaselineP),
    herBaselineA: clampNum(r.herBaselineA, 1, 10, d.herBaselineA),
    herBaselineSource: pickOf(r.herBaselineSource, ['manual', 'mean', 'inferred'], d.herBaselineSource),
    herBaselineUpdatedAt: clampNum(r.herBaselineUpdatedAt, 0, 4102444800000, d.herBaselineUpdatedAt),
    dedupeSimilarity: clampNum(r.dedupeSimilarity, 0, 1, d.dedupeSimilarity),
    dedupeSummarySimilarity: clampNum(r.dedupeSummarySimilarity, 0, 1, d.dedupeSummarySimilarity),
    herInterests: strOf(r.herInterests, 300),
    masterAliases: strOf(r.masterAliases, 300),
    // P1e:personaSummary / personaRules 已退役(见 RETIRED_SETTINGS_KEYS),不再归一。
    sharedRounds: clampInt(r.sharedRounds, 0, 20, d.sharedRounds),
    // —— 气泡分条(A 侧 v8.10.0 `main.py:640-673`)——
    // 她的回复中位数 123 字、他 12 字 —— 一大段就是 AI 感的来源。切泡只改
    // 包装不减体量,但它给了「中途」一个存在的前提:没有多泡就没有打断。
    // **默认与 A 侧同**:开、30 字一泡、倍率 1.0(A `_conf_schema.json:214/220/226`)。
    bubble: {
      enabled: boolOf(rb.enabled, d.bubble.enabled),
      maxChars: clampInt(rb.maxChars, 10, 200, d.bubble.maxChars),
      delayScale: clampNum(rb.delayScale, 0, 5, d.bubble.delayScale)
    },
    /**
     * ★ 2026-10-19：**群聊三句提示词**（他拍的「甲方案」）。
     * 空串 = 用 `lib/relay.js` 的 `GROUP_PROMPT_DEFAULTS`（向后兼容）。
     * 只做 trim + 长度上限 —— 不做任何"懂事"的改写，他填什么就是什么。
     */
    groupChatPrompts: {
      shortReply: strOf(rgp.shortReply, 2000),
      masterHint: strOf(rgp.masterHint, 2000),
      guestWarning: strOf(rgp.guestWarning, 2000)
    },
    longing: {
      enabled: boolOf(rl.enabled, d.longing.enabled),
      half_life_hours: clampNum(rl.half_life_hours, 0.1, 168, d.longing.half_life_hours),
      threshold: clampNum(rl.threshold, 0, 10, d.longing.threshold),
      msg_drop: clampNum(rl.msg_drop, 0, 10, d.longing.msg_drop),
      care_relief: clampNum(rl.care_relief, 0, 1, d.longing.care_relief),
      protest_kick: clampNum(rl.protest_kick, 0, 10, d.longing.protest_kick),
      cooldown_minutes: clampInt(rl.cooldown_minutes, 0, 1440, d.longing.cooldown_minutes),
      night_hold: boolOf(rl.night_hold, d.longing.night_hold),
      demo_rate: clampNum(rl.demo_rate, 0.1, 24, d.longing.demo_rate),
      // ★ 2026-09-26 全仓审查抓到:这一项以前**漏在 normalize 之外** ——
      // `readSettings().longing.must_say` 恒为 undefined,而消费端判的是
      // `!== false`(index.js)→ **面板上的「想念必须说出口」永远关不掉**。
      // 默认 true(A 侧没有这个开关,它是 DSH 的 D2 机制,默认开)。
      must_say: boolOf(rl.must_say, d.longing.must_say),
      steerOnlyFromPlatform: boolOf(rl.steerOnlyFromPlatform, d.longing.steerOnlyFromPlatform)
    },
    // —— 压缩即策展(v0.20.0 D1)——
    // ★ 同一处审查抓到:整组 `compaction` 以前在返回值里**根本不存在**,
    // 于是 `readSettings().compaction` 恒为 undefined,`lib/compaction.js:48`
    // 只能拿到 `{}` ⇒ **「压缩改走策展块」关不掉、预算改了也不生效**。
    compaction: (() => {
      const rc = raw && typeof raw.compaction === 'object' && raw.compaction !== null ? raw.compaction : {}
      return {
        curated: boolOf(rc.curated, d.compaction.curated),
        // 下限 80 与字段表一致;上限 20000 防手滑
        budgetTokens: clampInt(rc.budgetTokens, 80, 20000, d.compaction.budgetTokens)
      }
    })(),
    relay: {
      enabled: boolOf(rr.enabled, d.relay.enabled),
      // token 只做长度与字符面钳制(它不是给人看的,别截断出半个)
      token: strOf(rr.token, 200),
      sessionId: (() => {
        const s = String(rr.sessionId ?? '').trim()
        return s === '' ? d.relay.sessionId : s.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80) || d.relay.sessionId
      })(),
      cwd: strOf(rr.cwd, 400),
      permissionPreset: presetOf(rr.permissionPreset, d.relay.permissionPreset),
    followHisWindow: boolOf(rr.followHisWindow, d.relay.followHisWindow),
      proactiveScope: scopeOf(rr.proactiveScope, d.relay.proactiveScope),
      pushLocalTurns: boolOf(rr.pushLocalTurns, d.relay.pushLocalTurns),
      autoReplyToOrigin: boolOf(rr.autoReplyToOrigin, d.relay.autoReplyToOrigin),
      outboxLeaseSec: clampInt(rr.outboxLeaseSec, 5, 600, d.relay.outboxLeaseSec),
      replyMaxChars: clampInt(rr.replyMaxChars, 50, 5000, d.relay.replyMaxChars),
      proactiveTtlSec: clampInt(rr.proactiveTtlSec, 0, 86400, d.relay.proactiveTtlSec),
      // 0 = 关掉「超长即沉默」这条闸;上限 2000 只是防手滑填个天文数字
      proactiveMaxChars: clampInt(rr.proactiveMaxChars, 0, 2000, d.relay.proactiveMaxChars)
    },
    // v0.21.0 E5:情绪余波。单位是**秒**(与 A 的 say_again_min_delay 同名
    // 同单位);max 必须 ≥ min,坏了就回默认对(2,5)。
    say_again: (() => {
      const rs = raw && typeof raw.say_again === 'object' && raw.say_again !== null ? raw.say_again : {}
      const min = clampNum(rs.min_delay_sec, 0, 60, d.say_again.min_delay_sec)
      const max = clampNum(rs.max_delay_sec, 0, 120, d.say_again.max_delay_sec)
      return {
        enabled: boolOf(rs.enabled, d.say_again.enabled),
        min_delay_sec: min,
        max_delay_sec: max < min ? d.say_again.max_delay_sec : max
      }
    })(),
    // v0.22.0:议程簿开关(A `main.py:1818`)。
    agenda: (() => {
      const ra = raw && typeof raw.agenda === 'object' && raw.agenda !== null ? raw.agenda : {}
      return { enabled: boolOf(ra.enabled, d.agenda.enabled) }
    })(),
    // v0.22.0:整固旋钮(A `main.py:1926-1927`)。阈值 0 = 每次都触发(调试用);
    // 窗口下限 5 与 A 的 `max(5, cfg)` 一致 —— 面板给 1 也会被抬到 5。
    reflection: (() => {
      const rq = raw && typeof raw.reflection === 'object' && raw.reflection !== null ? raw.reflection : {}
      return {
        importance_threshold: clampNum(rq.importance_threshold, 0, 500, d.reflection.importance_threshold),
        max_inputs: clampInt(rq.max_inputs, 5, 500, d.reflection.max_inputs)
      }
    })()
  }
  // ★ P1b(模块8,Q7):settings 段里的**未知键不许静默丢** —— 搬进 `_unknown` 段并告警。
  //   理由(设计文档 Q7):数据迁移时用户手写的字段会"神隐"(写了、面板上没有、
  //   也不生效),那是最难查的一类"我改了没用"。以前就地丢弃,连痕迹都不留。
  //   已有的 `_unknown` 段原样带上 ⇒ 幂等(再归一一次结果不变)。
  const known = new Set(Object.keys(out))
  const carried = (r._unknown !== null && typeof r._unknown === 'object' && !Array.isArray(r._unknown))
    ? r._unknown
    : {}
  const unknown = {}
  for (const k of Object.keys(r)) {
    if (k === '_unknown' || known.has(k) || RETIRED_SETTINGS_KEYS.includes(k)) continue
    unknown[k] = r[k]
  }
  const names = Object.keys(unknown)
  if (names.length > 0 || Object.keys(carried).length > 0) {
    out._unknown = { ...carried, ...unknown }
  }
  if (names.length > 0) noteUnknownSettingsKeys(names)
  return out
}

/** 读调参:同步、永不抛错、脏值回默认。 */
export function readSettings() {
  try {
    const raw = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {}
    return normalizeSettings(raw?.settings)
  } catch {
    return normalizeSettings(null)
  }
}

/** herInterests → 数组(喂 agenda_pick 的 persona 项)。 */
export function readInterests() {
  return listOf(readSettings().herInterests)
}

/** masterAliases → 数组(她该认得的名字)。 */
export function readAliases() {
  return listOf(readSettings().masterAliases)
}

/**
 * 写调参(部分字段即可):校验钳位后合并,全量保留未知字段与
 * 未提及的字段。失败上抛(调用方决定是否吞)。
 */
export function writeSettings(patch) {
  const cur = readSettings()
  const p = patch && typeof patch === 'object' ? patch : {}
  // 嵌套组必须**逐组合并**:面板现在发整份 settings 所以没暴露,但任何
  // 按字段 patch 的调用方(未来的一键切换/脚本)都会让没提到的同组其它键
  // 回默认值 —— 2026-09-26 审查把这四组一起补齐(以前只并 longing/relay)。
  const nestedOf = (key) => ({
    ...(cur[key] && typeof cur[key] === 'object' ? cur[key] : {}),
    ...(p[key] && typeof p[key] === 'object' ? p[key] : {})
  })
  const merged = {
    ...cur,
    ...p,
    longing: nestedOf('longing'),
    relay: nestedOf('relay'),
    bubble: nestedOf('bubble'),
    // ★ 2026-10-19：群聊三句提示词。同上面几组的理由 —— 面板只发改动项，
    //   不并这一组就会把另外两句打回默认（他改一句，另外两句白改）。
    groupChatPrompts: nestedOf('groupChatPrompts'),
    compaction: nestedOf('compaction'),
    say_again: nestedOf('say_again'),
    agenda: nestedOf('agenda'),
    reflection: nestedOf('reflection'),
    // 2026-09-30 P2:主动性 v2 那 16 项(方案 A 的三个类型线也在这一组里)。不并进这里
    // 的话,任何**按字段** patch(未来的"一键切换/脚本"、或面板只发改动项)都会让
    // 没提到的同组键回默认值 —— 与上面四组是同一条理由。
    proactiveScoring: nestedOf('proactiveScoring'),
    // 2026-09-30 P4a:她的自由活动(整组五项)。同一条理由 —— 面板只要发变动项,
    // 不并这一组就会把 `budgetPerDay: 3` 这种手改值悄悄打回默认。
    herActivity: nestedOf('herActivity'),
    // ★ 2026-10-08:新会话默认开关(三档)—— 同上面八组的理由:
    //   不并这一组 ⇒ 任何按字段 patch 都会把没提到的档打回默认。
    newSessionOn: nestedOf('newSessionOn')
  }
  const next = normalizeSettings(merged)
  writeConfig({ settings: next })
  return next
}
