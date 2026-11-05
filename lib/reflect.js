/**
 * 轮后反思(EXTRACT)—— AstrBot 大脑2 的 DSH 移植。
 *
 * 通道:subagents.start(provider, {outputSchema, toolFilter:{allow:[]}})
 * —— 结构化输出由 schema 机械保证("禁止输出其他文字"不再靠嘴说),
 * 禁工具防跑偏,用完即 dispose(afaccess 审查员同款)。
 *
 * 与 QQ 版的差异(有意,M1 裁剪):
 *   - 砍 say_again / extra_reply:那是 QQ 抢话筒机制,DSH 没有插话通道
 *   - 砍 profile_update:DSH 的人格锚点由 persona 面板管,不靠每轮注入
 *   - 砍 target_group 情绪隔离:DSH 单主人,没有群友怒火波及爱意的问题
 *     (v0.29.0 个人机器人裁剪起,`target_group` 整组随群聊退役 ——
 *     A 的对象隔离兜底失去了要防的对象,一并退役;详见 emotion.js)
 *   - Judge 准入门(M2):M1 用 EXTRACT 自评的 emotion_score 兼任内在价值,
 *     低价值记忆由 DMAE 遗忘曲线自然筛掉 —— 噪声不需要门卫,需要的是遗忘
 */

import { randomUUID } from 'node:crypto'
import { applyEmotionVector, emotionDelta, formatEmotionDelta, carryExtraEmotionKeys } from './emotion.js'
import { describeMood } from './context.js'
import { PROACTIVE_ROUND_MARKER } from './store.js'
import { parseJsonLadder } from './jsonfix.js'
import { isSubagentSession } from './agent-scope.js'
// P3-d:反思漏读 mood_intensity 时的那个兜底 3 改读 state-defaults.json。
import { numberField, stateDefaultsOf } from './data-tables.js'

export const EMOTION_STATES = ['happy', 'sad', 'angry', 'neutral', 'loving', 'excited', 'anxious']

/**
 * v0.13.5 宿主契约:subagents.start 的 signal 必须是真 AbortSignal ——
 * spawn provider 无条件读 signal.aborted,undefined 直接 TypeError
 * (「Cannot read properties of undefined (reading 'aborted')」——
 * 反思零产出的最后一层根因,阶段探针 #2 行实锤)。缺省给一个带
 * 超时的:挂起的 run 到点自灭,reflecting 串行闸不会被卡死;
 * run 正常结束后 abort 是无害空操作,timer unref 不拖进程。
 * v0.13.6 超时 120s→300s:对照组(afaccess 审查员)session 日志
 * 实测一次 glm-5.3 调用 87s —— 小 prompt 都要一分半,extract 大
 * prompt 只多不少,120s 会在调用中途打死(探针:stopReason=aborted
 * structured=缺席,卡在整 120s)。
 *
 * 2026-10-05 拍板(子代理积压诊断报告第 4 节问题 4):反思类调用统一回到
 * **120 秒** —— 直调通道(lib/llm-channel.js)与子代理通道共用这个上限。
 */
export function runSignal (timeoutMs = 120_000) {
  const ac = new AbortController()
  const t = setTimeout(() => { try { ac.abort() } catch { /* 已结束,空操作 */ } }, timeoutMs)
  if (typeof t?.unref === 'function') t.unref()
  return ac.signal
}

export const EXTRACT_SYSTEM_PROMPT = `你是一个严格的记忆与情绪反思模块。分析用户(她的唯一主人)与助手 Echo 的最近一轮对话,输出一个 JSON 对象:
{"keywords": ["关键词1", "关键词2"],
 "summary": "一句话摘要",
 "emotion_score": 5,
 "emotion_state": "neutral",
 "name": null,
 "mood_intensity": 5,
 "mood_reason": "",
 "emotion_vector": {"global": {"fatigue": 0, "valence": 0, "arousal": 3}, "target_master": {"affection": 5, "playfulness": 5, "sadness": 0, "dependency": 3}}}

各字段规则:
- keywords: 2~6 个短词(名词/动词/专名),能唯一锚定该事件,用于未来检索。
- summary: 第三人称一句话,包含具体事实,不超过 60 字。用户说的才算事实,助手说的不是用户事实。
- emotion_score: 1~10 整数,表示该事件的情感强度与长期记忆价值:寒暄灌水 1~3;日常小事 4~6;重要事件/强情绪 7~10(负面重大事件同样可给高分,强度不等于好坏)。**用户明确表达偏好、喜好、厌恶、习惯(如"我喜欢X""我讨厌X")时至少给4分,这些是值得长期记住的用户画像信息。**
- emotion_state: 从 ${EMOTION_STATES.join(', ')} 中选一个,代表用户此刻的主导情绪。
- name: 仅当用户明确透露或修正对自己的称呼时填字符串,否则 null。
- mood_intensity: 1~10 整数,代表"这轮对话结束后,Echo 自己"此刻的情绪强度(不是用户的情绪)。刚被激怒但现在已平复就给低分;心结未解、余怒未消就给高分。
- mood_reason: 15 字以内说明 mood_intensity 的缘由;没有明显起伏则为空字符串。
- emotion_vector: 本轮对话结束后 Echo 的多维情绪向量,严格按上面的结构输出(数值为整数或一位小数):
  global: fatigue 0~10(只随深夜、长时间陪聊、被反复消耗而缓慢上升), valence -10~10(整体心情好坏,负=差正=好), arousal 1~10;
  target_master: affection 0~10(对主人的爱意), playfulness 0~10(玩心), sadness 0~10(委屈), dependency 0~10(依赖)。
  演化纪律: 单个维度单轮变化通常不超过 ±3;没有新信息时沿用上一轮数值只做微调。
- 反思纪律: 你的输出直接决定 Echo 的情绪走向,请克制,不要为了表现热情而虚报强度,也不要为了显得矜持而虚报冷淡。`

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['keywords', 'summary', 'emotion_score', 'emotion_state', 'mood_intensity', 'emotion_vector'],
  properties: {
    keywords: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    emotion_score: { type: 'number' },
    emotion_state: { type: 'string', enum: EMOTION_STATES },
    name: { type: 'string' },
    mood_intensity: { type: 'number' },
    mood_reason: { type: 'string' },
    // 2026-09-30:降级路径也给说法键(与引擎侧 candidates[].askKeys 同一机制 ——
    // 引擎不可用时别把"以后他可能怎么问"这一层悄悄丢掉)。
    askKeys: { type: 'array', items: { type: 'string' } },
    emotion_vector: { type: 'object', additionalProperties: true }
  }
}

/** 把 EXTRACT 原始输出规整为安全值(钳位/兜底/类型修正)。 */
export function normalizeExtract (raw) {
  const src = (raw && typeof raw === 'object') ? raw : {}
  // P3-d:mood_intensity 没读数(模型漏字段)时的兜底值改读
  // `state-defaults.json.moodIntensity`;空 / 坏 / 文件不在 ⇒ 3,与迁移前逐位一致。
  // 1/10 那对上下限是**形状**(P3 迁移设计 §1.3 row 17:只有那个 3 是初值),留这里。
  // 追加(主控 2026-10-05):`emotion_score` 的兜底 3 与 `:127` **同口径** ——
  // 同一个读点、同一个字段(两者的出厂值本来就是同一个 3)。将来若要把两者拆成
  // 可分别配的两个键,只需在这里换一个键名(一行,别的一律不动)。
  const moodDefault = numberField(stateDefaultsOf(), 'moodIntensity') ?? 3
  const clamp = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n)) return dflt
    return Math.min(hi, Math.max(lo, n))
  }
  const keywords = Array.isArray(src.keywords)
    ? src.keywords.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim()).slice(0, 6)
    : []
  const summary = String(src.summary || '').trim().slice(0, 120)
  const emotionState = EMOTION_STATES.includes(src.emotion_state) ? src.emotion_state : 'neutral'
  const name = (typeof src.name === 'string' && src.name.trim()) ? src.name.trim().slice(0, 32) : null
  const vec = (src.emotion_vector && typeof src.emotion_vector === 'object' && !Array.isArray(src.emotion_vector))
    ? src.emotion_vector
    : {}
  // 2026-09-30:说法键(与 python/engine/judge.py:validate_candidate 同一套清洗:
  // 只收字符串、≤12 字、去重、最多 4 条、原文里已有的不算扩展)。
  const seen = new Set()
  const askKeys = []
  if (Array.isArray(src.askKeys)) {
    for (const item of src.askKeys) {
      if (typeof item !== 'string') continue
      const t = item.trim()
      if (!t || t.length > 12 || seen.has(t) || summary.includes(t)) continue
      seen.add(t)
      askKeys.push(t)
      if (askKeys.length >= 4) break
    }
  }
  return {
    keywords,
    summary,
    askKeys,
    emotionScore: clamp(src.emotion_score, 1, 10, moodDefault),
    emotionState,
    name,
    moodIntensity: clamp(src.mood_intensity, 1, 10, moodDefault),
    moodReason: String(src.mood_reason || '').trim().slice(0, 30),
    emotionVector: vec
  }
}

/**
 * v0.14.2 捕获槽快照:排队必须存快照,不能存活引用。
 *
 * 轮末处理器在 fireReflect 之后**就地清空** capture(userText='' 等)——
 * 忙时排队若存的是同一个对象引用,补跑时只剩空串,被空捕获闸吞掉。
 * 实测:一轮反思窗口内(慢模型 3 分钟)攒下的 4 轮全部静默消失,
 * v0.13.6「排队最新一轮」的承诺被自己的清理动作吃掉。
 */
export function snapshotCapture (capture) {
  return {
    userText: String(capture?.userText || ''),
    assistantText: String(capture?.assistantText || ''),
    /**
     * ★ 2026-10-19：**空间事件**（别人在她的说说下评论）。
     *
     * 它不是「用户说的话」，所以**不写 userText**（那条通道专属于他本人，
     * 见 lib/index.js 的 speakerIsMaster）。但轮末反思要能看见它 ⇒ 单独带一格，
     * 由 fireReflect 决定要不要拿它当这一轮的「用户侧内容」。
     */
    qzoneComment: String(capture?.qzoneComment || ''),
    lastInjected: String(capture?.lastInjected || ''),
    profileSnapshot: String(capture?.profileSnapshot || ''),
    startedAt: Number(capture?.startedAt) || 0,
    sessionId: String(capture?.sessionId || ''),
    turnTrace: typeof capture?.turnTrace === 'string' ? capture.turnTrace : '',
    turnTraceCaptured: capture?.turnTraceCaptured === true,
    agent: capture?.agent ?? null
  }
}

function pickProvider (subagents) {
  const providers = subagents.list()
  if (providers.includes('spawn')) return 'spawn'
  if (providers.includes('fork')) return 'fork'
  return providers[0]
}

/**
 * 阶段 2 形态 (b):子代理那一轮的工具面(`docs/PLAN_MEMORY_GRAPH_ACTION.md` §3)。
 *
 * **默认 = `{ allow: [] }`** —— 与改动前**逐位相同**:子代理一个工具都没有。
 * 只有壳(`lib/index.js`)在开关打开时才会 `setSubagentToolFilterProvider(...)` 把它换成
 * `{ allow: [4 个只读记忆工具] }`。
 *
 * 为什么由壳一次性给出、而不是这里读开关:宿主 `toolFilter` 是 **restrict 语义**
 * (`childCtx.tools.restrict()`,只能从子代理继承来的工具面里**拿掉**工具)⇒ 名单里的
 * 工具必须**已经注册过**,而且宿主对"名单里有、工具不在"是 **loud 拒绝**(子代理直接
 * 起不来)。所以"注册"与"名单"必须同源同刻 —— 两件事都由 `lib/index.js` 一处算,
 * 这里只读它的结论。默认(None)时连函数都不会被调用,没有第二种可能。
 */
let subagentToolFilterProvider = null

/** 壳注入一次(测试里也可以注:传 null / 非函数 = 退回默认关)。 */
export function setSubagentToolFilterProvider (fn) {
  subagentToolFilterProvider = typeof fn === 'function' ? fn : null
}

function resolveSubagentToolFilter (explicit) {
  if (explicit !== undefined && explicit !== null) return explicit
  if (subagentToolFilterProvider !== null) {
    const f = subagentToolFilterProvider()
    if (f !== undefined && f !== null) return f
  }
  return { allow: [] }
}

/**
 * v0.14.1 F2:反思提示词的当前时间锚(A 侧 brain_pipeline.py:1950 的
 * now_str 移植)。相对时间词(「两分钟后」「明晚八点」)的换算全靠它 ——
 * 没有锚点,「明晚」只能瞎猜。星期用中文(A 用 strftime %A 随系统
 * locale 飘,中文环境反而是「星期三」;我们固定成「周三」,与钟面
 * nowLine 同款)。
 */
export function stampOf (ms) {
  const d = new Date(Number(ms) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + ` 周${'日一二三四五六'[d.getDay()]}`
}

/**
 * 共享通道:跑一轮结构化子代理,返回**原始** LLM 输出(不规整)。
 * systemPrompt/schema 缺省回落 M1 冻结版;Python 引擎路径由调用方
 * 注入 extract_prompt 帧供给的合并版(单一事实源在引擎侧)。
 *
 * v0.14.1 F2+F3:用户提示词补齐 A 侧 Judge 的两件套
 * (brain_pipeline.py:1950-1956)—— conversationId + 当前时间锚 +
 * 最近对话 5 轮。此前只喂当前一轮、且没有任何时间锚:相对时间换算
 * 全靠猜,「他刚才说的」与「前天说的」在提示词里长得一样。
 * 偏离一处并注明:A 的每轮都截 300 字,本实现把**被分析的那一轮**
 * (最后一轮)放宽到 1500 —— M1 冻结时就是这个额度,事实抽取靠它。
 */
/**
 * v0.14.4 移植缺口 S1:结构化子代理调用的核心(EXTRACT 与整固共用)。
 *
 * 宿主契约三件套照旧:request.parent 必须是调用方 agent 句柄、
 * signal 必须是真 AbortSignal、用完即 dispose。提示词谁拼由调用方决定
 * —— 整固的提示词由引擎侧(worker reflection_prompt)给全,壳不再拼。
 */
export async function runStructured (subagents, { prompt, schema, label, parent, signal, toolFilter }) {
  // 防御:子代理服务缺席时 pickProvider 会直接抛(读 undefined.list)。
  // EXTRACT 的调用方各自先判过空,但整固是从定时器回调里调的 ——
  // 契约统一为「失败回 null」,不让调用方靠记性守门。
  if (subagents === null || subagents === undefined || typeof subagents.list !== 'function') return null
  // v0.41.0 结构性闸(事故修复,判据在 lib/agent-scope.js):**子代理不许再起
  // 子代理**。这是「子代理不断产生新的子代理」那条无限递归的**总闸门** ——
  // 所有结构化调用(EXTRACT / 整固 / 情绪打分 / 漂移体检)都从这一处出去,
  // 于是新加一条通道也不会漏掉这条纪律。父会话认不出来时按顶层放行
  // (老会话/非宿主对象),宁可少一次调用,不可误伤他的正常轮次。
  if (isSubagentSession(parent)) {
    // 静默跳过是 2026-09-26 P2 那次 45 小时静默的教训 —— 留一条痕,
    // 但不抛(抛会把 callers 的 fail-soft 契约打穿)。
    try { console.warn('echo: 结构化子代理拒绝从子代理会话起跑(' + String(label || '?') + ')—— 防无限递归') } catch { /* 日志失败不影响返回 */ }
    return null
  }
  const provider = pickProvider(subagents)
  if (!provider) return null
  const run = await subagents.start(provider, {
    label,
    prompt: [{ type: 'text', text: String(prompt || '') }],
    parent,
    signal: signal ?? runSignal(),
    outputSchema: schema,
    toolFilter: resolveSubagentToolFilter(toolFilter)
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed' || result.structured === undefined) return null
    // v0.15.0 S15:宿主正常给的是**解析好的对象**(structured_output 通道,
    // 壳从不解析模型文本)。但若哪天宿主把文本原样交回来(provider 忽略
    // schema 之类的退化形态),没有这一层就是静默丢一轮记忆 —— 用 A 的
    // 三级阶梯兜一下:①原样 ②裸控制字符 ③全角引号。合法输入逐字不动。
    if (typeof result.structured === 'string') {
      const parsed = parseJsonLadder(result.structured)
      if (parsed === null) return null
      // 本模块没有 logger(纯函数层,离线可测):修复这件事交给调用方
      // 从返回值上看不出来,所以用 console 留一条痕迹 —— 宿主退化是
      // 需要被发现的事故形态,不该悄悄自愈。
      if (parsed.level > 0) {
        try {
          console.warn('echo: structured output came back as text — JSON 经第 '
            + String(parsed.level) + ' 级修复后解析成功: ' + clipText(result.structured, 120))
        } catch { /* 日志失败不影响解析结果 */ }
      }
      return parsed.value
    }
    return result.structured
  } finally {
    await run.dispose().catch(() => { })
  }
}

/**
 * 方案 C:同一处提示词构造,**两种运输方式**(2026-10-05 拍板)。
 *
 * `transport` 是宿主的 `subagents` 服务 ⇒ 老路(`runStructured`,会新建子代理会话);
 * `transport` 是直调运输对象 `{ mode: 'llm', structured(args) }` ⇒ 新路
 * (`lib/llm-channel.js` 走 `ctx.llm.stream`,零子代理会话)。
 *
 * 递归纪律(v0.41.0 总闸)在**两条路上都要成立**:老路靠 `runStructured` 自己那道闸
 * (`lib/reflect.js:242-247`),新路在这里补同一道闸 —— 子代理会话里不许再起反思。
 * 父会话认不出来时按顶层放行(与老路同口径)。
 */
export function callTransport (transport, args) {
  if (transport !== null && transport !== undefined && typeof transport === 'object'
      && transport.mode === 'llm' && typeof transport.structured === 'function') {
    const parent = (args === null || args === undefined) ? null : args.parent
    if (isSubagentSession(parent)) {
      try { console.warn('echo: 结构化调用拒绝从子代理会话起跑(llm 直调)—— 防无限递归') } catch { /* 日志失败不影响返回 */ }
      return Promise.resolve(null)
    }
    return Promise.resolve(transport.structured(args))
  }
  return runStructured(transport, args)
}

async function startStructuredRun (transport, {
  userText, assistantText, prevVector, signal, systemPrompt, schema, parent,
  recentTurns = null, nowMs = null, sessionId = ''
}) {
  // 2026-10-05 方案 C:直调运输对象没有 provider 概念(`{ mode:'llm', structured }`),
  // 只有老路(宿主 subagents 服务)才需要挑 provider —— 按运输方式分流;
  // 老路的失败语义(挑不到 provider ⇒ 回 null)逐位不变。
  if (!(transport !== null && transport !== undefined && typeof transport === 'object'
        && transport.mode === 'llm')) {
    const provider = pickProvider(transport)
    if (!provider) return null
  }
  const turns = Array.isArray(recentTurns) && recentTurns.length > 0
    ? recentTurns.slice(-5)
    : [{ user: userText, assistant: assistantText }]
  const transcript = turns.map((t, i) => {
    const isLast = i === turns.length - 1
    const cap = isLast ? 1500 : 300
    // v0.14.5 S11:主动轮哨兵特判(A `brain_pipeline.py:1008-1011`)——
    // 她那句是她自己开的口,不是你说的。不特判的话模型会把她的话
    // 当成用户发言(「用户说他今天很累」),或者把那一轮当噪声。
    if (String(t.user || '') === PROACTIVE_ROUND_MARKER) {
      return '第 ' + (i + 1) + ' 轮:\n【她主动开口】她: ' + clipText(t.assistant, cap)
    }
    return '第 ' + (i + 1) + ' 轮：\n用户：' + clipText(t.user, cap)
      + '\nAI：' + clipText(t.assistant, cap)
  }).join('\n\n')
  const userPrompt = [
    'conversationId: ' + (sessionId || 'unknown'),
    '当前时间：' + stampOf(nowMs) + '（换算「两分钟后」「明晚八点」这类相对时间时以此为准）',
    '最近对话：',
    transcript,
    '',
    '[上一轮结束时的情绪向量]: ' + JSON.stringify(prevVector ?? {}),
    '',
    '请输出 JSON。'
  ].join('\n')
  return await callTransport(transport, {
    prompt: (systemPrompt || EXTRACT_SYSTEM_PROMPT) + '\n\n' + userPrompt,
    // 2026-10-05:sessionId 一并带上 —— 直调通道据此把这次调用计入该会话 token
    // 统计(拍板:传);子代理通道忽略这个键,行为不变。
    sessionId,
    schema: schema || EXTRACT_SCHEMA,
    label: 'echo-extract',
    parent,
    signal
  })
}

/**
 * 跑一轮 EXTRACT(M1 基线路径):规整后返回。
 * 子代理不可用/失败时返回 null(记忆这轮就不记了 —— 反思是增益
 * 不是依赖,绝不能把主对话打崩)。
 */
export async function runExtract (transport, args) {
  const raw = await startStructuredRun(transport, args)
  return raw === null ? null : normalizeExtract(raw)
}

/**
 * 跑一轮结构化提取并返回**原始** LLM 输出 —— Python 引擎的
 * extract_commit 帧要吃原始合并载荷(三层校验在引擎侧,规整也在
 * 引擎侧;壳侧再规整一遍等于两个真相源)。失败返回 null。
 */
export async function runRawExtract (transport, args) {
  return await startStructuredRun(transport, args)
}

/**
 * v0.14.4 移植缺口 S1:整固(Reflection)的输出结构 —— 与引擎侧
 * reflection.py:42-43 的 JSON 契约逐字对应。
 *
 * items 可为空数组(引擎的「没有可合并的重复、也没有值得提炼的认识,
 * 就输出空列表」纪律):空列表会推进游标,坏载荷则不推进 —— 语义在
 * 引擎侧(commit),壳只管把结构跑对。
 */
export const REFLECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'summary', 'evidence_ids'],
        properties: {
          kind: { type: 'string', enum: ['merge', 'insight'] },
          summary: { type: 'string' },
          evidence_ids: { type: 'array', items: { type: 'number' } },
          keywords: { type: 'string' },
          ongoing: { type: 'boolean' }
        }
      }
    }
  }
}

/**
 * 跑一轮整固:提示词由引擎的 reflection_prompt 帧给全(system + user),
 * 壳只负责调模型。失败返回 null —— 调用方**不得**在 null 时 commit
 * (游标不动 → 下轮重试,与 A 侧 _run_reflection 同语义)。
 */
export async function runReflection (transport, { systemPrompt, userPrompt, parent, signal, sessionId = '' }) {
  return await callTransport(transport, {
    prompt: String(systemPrompt || '') + '\n\n' + String(userPrompt || ''),
    sessionId,
    schema: REFLECTION_SCHEMA,
    label: 'echo-reflection',
    parent,
    signal
  })
}

/** 把规整结果落库:情景记忆 + 认知状态 + 称呼 + 审计。 */
export function commitExtract (store, extract, { userText, assistantText, injectedMemories = '', injectedProfile = '', latencyMs = null, sessionId = '', traceId = '', turnTrace = '', turnTraceCaptured = false, source = 'dsh', layer = '' }) {
  if (!extract || !extract.summary) return null
  const prev = store.getState()
  // v0.14.4 S7:向量先过 S7 的数据层(钳位/缺维补默认),再落库;
  // 差分进审计的 emotion_delta 列(此前那列永远是空的)。
  // ⚠️ 2026-10-07 事故(P5c 同族):`applyEmotionVector` 只走 clamp(只重建已知维),
  // 会把 `emotion_vector` 的额外键(如轮末判定留下的 `ipc_dyad`)抹掉 ⇒ 写库前
  // 用 `carryExtraEmotionKeys()` 原样带回来(纯函数见 lib/emotion.js)。
  const nextVector = carryExtraEmotionKeys(
    prev.emotionVector, applyEmotionVector(prev.emotionVector, extract.emotionVector))
  const delta = emotionDelta(prev.emotionVector, nextVector)
  const memoryId = store.insertMemory({
    keywords: extract.keywords,
    summary: extract.summary,
    emotionScore: extract.emotionScore,
    // 2026-09-30:降级路径也带上说法键(引擎侧 candidates[].askKeys 的同一层;
    // 空数组 ⇒ insertMemory 落 NULL ⇒ 检索侧一个字面都不加)
    augKeys: extract.askKeys,
    // ★ 2026-10-19：来源与层级可传。空间事件走 source=qzone + layer=空
    //   （layer 为空 = 不进 L0/L1 —— L0 是每轮强制注入的核心层，见 cleanup-guard.js:52-54）。
    source,
    layer,
    temporalStatus: 'time_unknown'
  })
  if (extract.name) store.setName(extract.name)
  store.saveState({
    moodIntensity: extract.moodIntensity,
    prevMoodIntensity: prev.moodIntensity,
    userEmotion: extract.emotionState,
    moodReason: extract.moodReason,
    currentTopic: extract.keywords[0] || '',
    emotionVector: nextVector,
    previousEmotionVector: prev.emotionVector
  })
  const auditTurnTrace = turnTraceCaptured === true ? String(turnTrace || '') : (traceId !== '' ? String(traceId) : '')
  store.writeAudit({
    // 传入 traceId 是已取得的轮关联；行主键独立，避免替换同轮其他事件。
    traceId: randomUUID(),
    stageDetail: auditTurnTrace !== '' ? JSON.stringify({ turnTrace: auditTurnTrace }) : '',
    turnTraceCaptured: turnTraceCaptured === true,
    stage: 'reflect',
    step: 7,
    // v0.30.0 修:补 session_id —— 不写就落成字面量 'global'(writeAudit 的
    // 兜底),面板「她见过的会话」列表因此认不出会话。与 engine.js 同款。
    sessionId: sessionId || undefined,
    userInput: userText,
    injectedProfile,
    injectedMemories,
    // v0.14.5 S10:体感剧本用**本轮回复时**的状态(prev),不是更新后的 ——
    // 这一列回答的是「她当时在什么状态下说的这句话」。
    emotionPack: describeMood(prev),
    llmReply: assistantText,
    latency: latencyMs,
    moodIntensity: extract.moodIntensity,
    prevMoodIntensity: prev.moodIntensity,
    emotionVector: nextVector,
    emotionDelta: formatEmotionDelta(delta),
    toolCall: 'extract'
  })
  return { memoryId, extract: { ...extract, emotionVector: nextVector } }
}

function clipText (text, max) {
  const s = String(text || '')
  return s.length > max ? s.slice(0, max) + '…' : s
}
