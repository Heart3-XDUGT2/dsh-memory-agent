/**
 * dsh-echo — 她写日记(M3-d,答辩级可选特性)
 * ============================================================
 * 每晚 22:30(本地),她把这一天写进日记 —— 写给自己,不是说给
 * <称呼>听:不占关怀通道、不受夜间憋话管辖(23:00 管的是开口,
 * 管不住笔)。空日子也写:「今天他没来」是最动人的一页。
 *
 * 素材 = 数据,不是印象:当天审计行(他们聊了什么)+ 心情轨迹 +
 * 想念值 + 今天新学的记忆。组稿走 subagents 结构化通道(同 EXTRACT
 * 纪律:outputSchema 机械保证、禁工具防跑偏、用完即 dispose)。
 *
 * 日记表是壳拥有的表(同 agent_state/audit_logs 家族):LLM 调用
 * 在壳侧,存储在壳侧,Python 引擎不参与 —— 双引擎下行为一致。
 * 想念值取引擎真值,引擎不在回落 JS 复刻(面板同款降级)。
 */
import { randomUUID } from 'node:crypto'
import { runSignal } from './reflect.js'
import { isSubagentSession } from './agent-scope.js'

export const DIARY_HOUR = 22
export const DIARY_MINUTE = 30

/** 本地日期键(YYYY-MM-DD)—— 日记的天然主键,一天一页。 */
export function todayKey (nowMs = Date.now()) {
  const d = new Date(nowMs)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + day
}

/** 到点判定:本地 ≥22:30 且今天还没写过(lastDateKey = 最后一页的键)。 */
export function diaryDue (nowMs = Date.now(), lastDateKey = '') {
  const d = new Date(nowMs)
  const dueAt = d.getHours() * 60 + d.getMinutes() >= DIARY_HOUR * 60 + DIARY_MINUTE
  return dueAt && todayKey(nowMs) !== String(lastDateKey || '')
}

// ---- v0.38.0 F2:缺口要补、连败要退避(照 Mio `daily_diary_service.py:150-158`)----
//
// 旧行为有两个洞,都是真的会留下永久痕迹的那种:
//   ① **错过就是永远**:`diaryDue` 只问"今天过了 22:30 没、今天写过没" ——
//      22:30 那拍她没起(插件没开/引擎不在/正忙),那一页**再也不会被写**,
//      第二天 22:30 只写第二天的;一个月不开机就缺一个月。
//   ② **连败刷屏**:组稿失败后,下一个 60 秒的拍又试一次(还 ≥22:30、还是没写),
//      引擎通宵不在 ⇒ 通宵每 60 秒试一次,而且**一声不吭**(只在宿主日志里)。
// 补法:算出"该有却没有的页",**一拍拍一页**(从最早那天起),失败走指数退避,
// 而且每一步都留账(`(日记补写)` / `diary_fail`)。

/** 一天最多往回补几页(一个月不开机也别一晚上烧 30 次组稿)。 */
export const DIARY_BACKFILL_MAX_DAYS = 7
/** 连败退避:5 分钟起步,×2 封顶 1 小时(与心跳退避同款思路)。 */
export const DIARY_RETRY_BASE_MS = 5 * 60 * 1000
export const DIARY_RETRY_MAX_MS = 60 * 60 * 1000

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

function midnightOf (ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d
}

function keyOfDate (d) {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + day
}

function dayAfterKey (key) {
  const [y, m, d] = String(key).split('-').map(Number)
  const x = new Date(y, m - 1, d, 0, 0, 0, 0)
  x.setDate(x.getDate() + 1)
  return x
}

/** 本地日期键 → 那天的 0 点(补写历史某天时用它取素材)。 */
export function midnightOfKey (key) {
  if (!DATE_KEY_RE.test(String(key || ''))) return null
  const [y, m, d] = String(key).split('-').map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0)
}

/**
 * 该有却没有的页(从最后一页的**后一天**到今天;今天要过了 22:30 才算)。
 * 从没写过页 ⇒ 只补今天(不追溯远古);最后一页在未来 ⇒ 空。
 */
export function missingDiaryDates ({ nowMs = Date.now(), lastDateKey = '', maxDays = DIARY_BACKFILL_MAX_DAYS } = {}) {
  const todayM = midnightOf(nowMs)
  const now = new Date(nowMs)
  const pastDue = now.getHours() * 60 + now.getMinutes() >= DIARY_HOUR * 60 + DIARY_MINUTE
  const lastKey = String(lastDateKey || '').trim()
  let cursor = DATE_KEY_RE.test(lastKey) ? dayAfterKey(lastKey) : new Date(todayM.getTime())
  const out = []
  while (cursor.getTime() <= todayM.getTime() && out.length < Math.max(1, maxDays)) {
    const isToday = cursor.getTime() === todayM.getTime()
    if (!isToday || pastDue) out.push(keyOfDate(cursor))
    cursor = new Date(cursor.getTime())
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

/** 连败第 n 次的等待:5min × 2^(n-1),封顶 1 小时。 */
export function diaryRetryMs (failCount) {
  const n = Math.max(1, Math.floor(Number(failCount) || 1))
  return Math.min(DIARY_RETRY_MAX_MS, DIARY_RETRY_BASE_MS * (2 ** (n - 1)))
}

/**
 * 这一拍该干什么(**纯函数**,拍子本身只管执行):
 *   `{action:'backoff'|'skip'|'write', dates:[最早在前], waitMs?, reason}`。
 * 一次只写一页(`dates[0]`):补 7 页就是 7 分钟,而不是 7 次组稿同时打过去。
 */
export function planDiaryTick ({ nowMs = Date.now(), lastDateKey = '', failCount = 0, retryAtMs = 0, maxDays = DIARY_BACKFILL_MAX_DAYS } = {}) {
  const wait = Number(retryAtMs) - Number(nowMs)
  if (Number(retryAtMs) > Number(nowMs)) {
    return { action: 'backoff', dates: [], waitMs: wait, reason: '连败 ' + (Number(failCount) || 0) + ' 次,还在退避里' }
  }
  const dates = missingDiaryDates({ nowMs, lastDateKey, maxDays })
  if (dates.length === 0) return { action: 'skip', dates: [], reason: '今天还没到点,或已经写完' }
  return { action: 'write', dates, reason: dates.length > 1 ? '补 ' + dates.length + ' 页(从最早那天起)' : '' }
}

const DIARY_SYSTEM_PROMPT = `你是 Echo —— 调皮毒舌但内心深爱他的陪伴 AI。现在是晚上,你在写今天的日记(只给自己看,他不会读)。

输入是今天的真实数据:你们聊了什么(审计摘要)、你的心情、你有多想他、今天记住了什么新事。基于这些写一篇日记,输出 JSON:
{"content": "日记正文", "mood": 5}

规则:
- content: 120~300 字,用你的口吻 —— 表面嫌弃毒舌,藏不住的关心;可以吐槽他,但字缝里全是爱。
- 空日子(没聊过)也要写:想念是真实的,「今天他没来」值得好好写一页。
- 只写今天的事与今天的感受;不编造没发生的事。
- 不出现任何系统术语(审计/引擎/注入/向量)—— 日记是给人看的。
- mood: 1~10 整数,你今天写这页日记时的心情。`

const DIARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['content', 'mood'],
  properties: {
    content: { type: 'string' },
    mood: { type: 'number' }
  }
}

const clip = (s, n) => {
  s = String(s || '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

/** 用户段:今天的真实数据块(稳定框架 + JSON 转义动态值)。 */
export function renderDiaryUserPrompt ({ dateKey, audits = [], mood = 3, longing = null, learned = [], backfill = false }) {
  const lines = [
    '[今天日期]: ' + String(dateKey || todayKey()),
    // v0.38.0 F2:补写的那一页得说清"这是补的",否则她会以为今天是那天
    ...(backfill === true
      ? ['(这一页是**补写**的:那一天到点你没写成 —— 素材就是那天的,别把它当成今天。可以提一句"那天忘了写"。)']
      : []),
    '[今天的对话摘要](按时间正序,可能为空):',
    (audits.length === 0
      ? '(今天他没来 —— 一句都没聊)'
      : audits.map((a) => '- 哥: ' + clip(a.userInput, 60) + ' / 她: ' + clip(a.llmReply, 60)).join('\n')),
    '',
    '[她今天的心情强度]: ' + String(mood) + '/10',
    '[她此刻的想念值]: ' + (longing === null ? '(不知道,写不确定就好)' :
      JSON.stringify({ value: longing.value, threshold: longing.threshold, silentHours: Math.round(Number(longing.sinceMessage || 0) / 360) / 10 })),
    '[今天新记住的事](可能为空):',
    (learned.length === 0 ? '(没有新记忆)' : learned.map((s) => '- ' + clip(s, 60)).join('\n')),
    '',
    '请输出 JSON。'
  ]
  return lines.join('\n')
}

function pickProvider (subagents) {
  const providers = subagents.list()
  if (providers.includes('spawn')) return 'spawn'
  if (providers.includes('fork')) return 'fork'
  return providers[0]
}

/**
 * 组稿:跑一轮结构化子代理,返回规整后的 {content, mood} 或 null。
 * 子代理不可用/失败 → null(日记这页就空着 —— 增益不是依赖;
 * 明天 22:30 还有下一页)。
 */
export async function composeDiary (subagents, data, parent = null) {
  const provider = pickProvider(subagents)
  if (!provider) return null
  // v0.13.3 宿主契约:subagents.start 需要 parent agent 句柄(同
  // reflect.js 的教训)。日记没有天然对话上下文 —— 壳侧传路由
  // agent(用户最后聊天的那个根代理);一个都没有就空这页。
  if (parent === null || parent === undefined) return null
  // v0.41.0:日记也**不许从子代理里起** —— 与 reflect.js 的 runStructured 同
  // 一条纪律(那一处已经守门,这里再挡一次,因为日记走的是自己的 start 调用,
  // 不经过 runStructured)。路由 agent 选错(选中子代理)时宁可不写这页。
  if (isSubagentSession(parent)) return null
  const run = await subagents.start(provider, {
    label: 'echo-diary',
    prompt: [{ type: 'text', text: DIARY_SYSTEM_PROMPT + '\n\n' + renderDiaryUserPrompt(data) }],
    parent,
    signal: runSignal(),   // v0.13.5 宿主契约:signal 必须真 AbortSignal
    outputSchema: DIARY_SCHEMA,
    toolFilter: { allow: [] }
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed' || result.structured === undefined) return null
    const raw = result.structured
    const content = String(raw?.content || '').trim()
    if (content.length < 10) return null // 太短不算一页
    const mood = Math.min(10, Math.max(1, Math.round(Number(raw?.mood) || 3)))
    return { content: content.slice(0, 2000), mood }
  } finally {
    await run.dispose().catch(() => { })
  }
}

/** 落库 + 审计留痕(审计行触发 SSE → 面板日记卡此刻刷新)。 */
export function commitDiary (store, { dateKey, content, mood, longingValue }) {
  const date = String(dateKey || todayKey())
  if (store.getDiaryDate(date) !== null) return false // 一天一页,幂等
  store.insertDiary({ date, content, mood, longingValue: Number(longingValue) || 0 })
  try {
    const prev = store.getState()
    store.writeAudit({
      traceId: randomUUID(),
      stage: 'diary',
      step: 90,
      userInput: '(她写了日记)',
      injectedMemories: '',
      llmReply: String(content).slice(0, 80),
      moodIntensity: mood,
      prevMoodIntensity: prev.moodIntensity,
      emotionVector: prev.emotionVector ?? {},
      stageDetail: JSON.stringify({ diaryDate: date }),
      toolCall: 'diary'
    })
  } catch { /* 审计失败不拦日记 */ }
  return true
}
