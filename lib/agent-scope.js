/**
 * dsh-echo — 会话分类:这一轮是「她跟他聊天」,还是「她自己内部的活」?
 * ==================================================================
 * 事故(2026-09-28 夜 → 09-29,他报「装上 echo 之后 dsh 会卡崩:子代理不断
 * 产生新的子代理」,他先把插件卸了):
 *
 * C1 情绪单轮闭环(`lib/emotion-score.js`)在他开口那一刻
 * (`agent/inbox/claimed`)并起一次小打分调用 —— 而那次调用**本身就是
 * 一个子代理**(`runStructured` → `subagents.start`)。
 *
 * 环是这样闭上的,逐环都有宿主源码可查,不是猜:
 *   ① 宿主 `dsh-agent` 的 `agentEvents()` 把 `agent` **融进事件载荷**
 *      (`dsh-agent/lib/types/dispatch.js`: `({ ...payload, agent })`)——
 *      插件的 `ctx.on('agent/inbox/claimed', …)` 挂在根上下文上,**子代理
 *      会话的 claim 一样收得到**(`dsh-subagent/lib/index.js:1107` 自己也
 *      监听同一个事件,可见它对子代理有效)。
 *   ② 子代理的初始任务是走 **inbox** 投递的,而且信封写死
 *      `source: { kind: 'user' }`(`dsh-subagent-in-process-driver/lib/index.js:207-210`)
 *      ⇒ 在 `latestDirectUserText` 眼里,它就是「他这一轮说的话」。
 *   ③ 打分提示词(`scorePrompt`)开头是「你只做一件事:读下面这句话之后…」:
 *      它既不在宿主注入名单里,也不在 `isInternalPrompt` 的三条判据里
 *      (开头不匹配指令式体裁)⇒ `isHumanUtterance` 放行。
 *   ④ `createSameTurnScorer.begin()` **只看 sid 非空** —— 没有范围闸、
 *      没有深度闸 ⇒ 子代理会话的 claim 又起一个打分子代理。
 *      ⇒ 打分子代理 A 起 B,B 起 C……**每一趟都是一次真 LLM 调用**;
 *      再叠上子代理轮末那条反思路(`fireReflect` 也会从子代理里再起
 *      EXTRACT 子代理),并发与深度一起长,宿主卡死。
 *
 * 这不是「模型跑偏」,是**结构性递归**:插件的子代理调用没有「子代理不许
 * 再起子代理」这条断言。所以修法也必须是结构性的 —— 本模块提供**唯一一份**
 * 会话分类判据,由所有「起子代理 / 记对话 / 路由 parent」的地方共用。
 *
 * 判据三选一(宿主 `SessionHeader` 的三个字段,任一命中即内部会话):
 *   · `origin === 'subagent'` —— 子代理会话的显式标记
 *     (`dsh-subagent-in-process-driver` 的 `childSessionMeta` 写死这个值);
 *   · `parentSession` 非空 —— 有父会话就是被派出去的;
 *   · `delegationDepth > 0` —— 递归预算(父深度 + 1),顶层是 0。
 *
 * **判不出来就当顶层**(`header` 缺席 = 老会话/非宿主对象)——与
 * `scripts/check-echo-persona.mjs` 的 `sessionDepth()` 同一口径:「没有这个
 * 字段的老会话 = 顶层会话」。代价不对称:错判成内部会话 ⇒ 她这一轮少了
 * 情绪读数/记忆(可接受的损失);错判成顶层 ⇒ 递归又回来了(**不可接受**)。
 * 所以「有字段但读不出来」要落到 `false`(顶层)只在**结构上确实是会话头**
 * 时才允许(见 `headerOf` 的说明)。
 */

/** 会话头的三个字段名(判据与诊断共用一处,免得两边漂;只在模块内用)。 */
const SUBAGENT_HEADER_FIELDS = ['origin', 'parentSession', 'delegationDepth']

/**
 * 从一个「跟会话有关的东西」里取出会话头。
 *
 * 接受的形状(调用方常常只拿得到其中一种):
 *   · agent   → `agent.session.header`
 *   · session → `session.header`
 *   · header  → 自己
 * 认不出来回 `null`(调用方据此当顶层)。
 *
 * 为什么不是「有 `.header` 就当头」:Session 与 Agent 都有 `.header`/`.session`
 * 层,而**纯会话头**上没有任何一层 —— 三种形状靠结构区分,不靠猜。
 */
export function headerOf (subject) {
  if (subject === null || subject === undefined || typeof subject !== 'object') return null
  // agent:{ session:{ header } }
  const session = subject.session
  if (session !== null && typeof session === 'object') {
    const h = session.header
    if (h !== null && typeof h === 'object') return h
  }
  // session:{ header }
  const h = subject.header
  if (h !== null && typeof h === 'object') return h
  // 会话头本体:出现任一专属字段才认(免得把任意对象当会话头)
  for (const f of SUBAGENT_HEADER_FIELDS) {
    if (Object.hasOwn(subject, f)) return subject
  }
  return null
}

/**
 * 委派深度:顶层会话 0,子代理 1、孙代理 2……读不到回 0。
 * (与宿主 `dsh-subagent/lib/index.js:144 delegationDepthOf` 同口径 ——
 *  缺省即顶层;这边不给 runtime 兜底,插件拿不到那个内部量。)
 */
export function delegationDepthOf (subject) {
  const header = headerOf(subject)
  if (header === null) return 0
  const n = Number(header.delegationDepth)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

/**
 * 这个会话是不是**她内部的活**(子代理/辅助会话)—— 是的话,它既不是
 * 「他这一轮说的话」,也**不许再起子代理**。
 *
 * 纯函数:不碰宿主、不碰库,离线可测(`tests/agent-scope.test.js`)。
 */
export function isSubagentSession (subject) {
  const header = headerOf(subject)
  if (header === null) return false
  if (String(header.origin || '') === 'subagent') return true
  const parent = header.parentSession
  if (parent !== undefined && parent !== null && String(parent) !== '') return true
  return delegationDepthOf(header) > 0
}

/** 顶层会话 = 不是子代理(判据取反,读起来比 `!isSubagentSession()` 省事)。 */
export function isTopLevelSession (subject) {
  return !isSubagentSession(subject)
}

/**
 * ★ 2026-10-25(bug-echo-new-session-default §5.1):**id 形态**是第三条判据。
 *
 * 上面那三道都读会话头,可会话头**不是哪里都有**:
 *   · 注入闸拿到的 `session` 未必带 header(那条 bug 的现场);
 *   · 重启**之前**就存在的子代理会话谁也不认识 —— `session/created` 那一拍早过去了,
 *     名单(`config.json.subagentSessions`)里没有它 ⇒ 面板与判定都漏。
 * 所以补一条不依赖任何登记、不依赖 header 的判据:看 id 长什么样。
 *
 * 依据(两条,都实测过,不是猜):
 *   · 宿主给**子代理**发的是**裸 randomUUID**
 *     —— `node_modules/@deepseek-ai/dsh-subagent/lib/index.js:1677`:
 *     `const childId = spec.childId ?? brandString(randomUUID())`;
 *     而**顶层**会话 id 带 `session-` 前缀
 *     —— `@deepseek-ai/dsh-api-session-controller/lib/index.js:688`:
 *     `request.sessionId ?? brandString('session-' + randomUUID())`。
 *   · 本机 `~/.dsh/sessions` 全量对账(2026-10-25,8 个 workspace / 42 个会话目录):
 *     **16/16** 裸 UUID 会话的头是 `"origin":"subagent"`(parentSession + depth=1),
 *     **26/26** 带 `session-` 前缀的顶层会话 `delegationDepth: 0`、没有 origin
 *     ⇒ 形态判据与会话头判据在这台机器的数据上**零冲突**。
 *
 * ⚠️ 这是**启发式**,代价不对称,所以宁严不宁宽:错判成子代理 ⇒ 那条会话里她不说话
 * (可接受,而且 `subagentSessions` 名单那一路仍可人工纠正);漏判 ⇒ 干活用的子代理
 * 带着私人记忆上班(本轮 bug)。`global`(面板伪会话)与 `session-*` 一个字都碰不到。
 */
export const SUBAGENT_ID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

const SUBAGENT_ID_RE = new RegExp(SUBAGENT_ID_PATTERN)

/** id 形态判据:裸 UUID(不带 `session-` 前缀)⇒ 子代理会话。空/非串 ⇒ 不是。 */
export function isSubagentSessionId (id) {
  const sid = String(id ?? '').trim()
  if (sid === '') return false
  return SUBAGENT_ID_RE.test(sid)
}

/**
 * 面板「会话」列表里这一条该不该露出来 —— **名单 + id 形态双判**。
 *
 * 名单(`config.json.subagentSessions`)是「当时登记过」的那一批;形态是兜底
 * (老会话、重启前就有的、header 缺席的)。两个都要,缺一个就会漏:
 * 只按名单滤 ⇒ 老会话照旧漏出来(正是这次的现象);只按形态滤 ⇒ 将来宿主换了
 * 命名方式,名单里那批又会漏。
 *
 * 纯函数(不碰盘、不碰库)⇒ 单测直接喂假的 sessions 列表。
 * @param {{sessionId?: string}|string} session sessionPreviews() 的一行,或裸 id
 * @param {Iterable<string>} [hidden] 已知子代理名单(Set/Array 都收)
 */
export function isScopeVisibleSession (session, hidden) {
  const sid = String(
    (session !== null && typeof session === 'object' ? session.sessionId : session) ?? ''
  )
  if (sid === '') return true            // 没有 id 的行不归这里管(展示层自有兜底)
  if (hidden !== undefined && hidden !== null) {
    if (typeof hidden.has === 'function') { if (hidden.has(sid)) return false } else if (Array.from(hidden).includes(sid)) return false
  }
  return !isSubagentSessionId(sid)
}
