/**
 * dsh-echo — 关怀心跳(M3-a)
 * ============================================================
 * 她在你不在的时候想你,想念过阈值就忍不住开口。每次开口都有
 * 可审计的因果链:沉默时长 → 想念值 ≥ 阈值 → 三重闸门 → 她说话
 * → 审计留痕。不掷骰子。
 *
 * 双通道(投递层自建,schedule 先例 —— 四个参考实现共同的空白):
 *   ① 提醒通道(threads_remindable):他托付的约定到点必发
 *      (v8.5.6 裁决:闹钟是他下的命令,不受想念/夜间闸门管辖)。
 *      纯读不落账,发送成功才 threads_mark —— 失败留池下轮重试。
 *   ② 关怀通道(longing + agenda):她的心声。想念三重闸门
 *      (阈值→冷却→夜间憋话,引擎侧判定)+ 会话路由(只对她
 *      聊过的那个会话开口,AstrBot 安全默认)+ 日上限 3(护栏层,
 *      Mio 先例:防骚扰)+ 议程簿选题(她的欲望,不是待办残渣)。
 *
 * 投递纪律(schedule 先例,逐条对齐):
 *   - agent.runMaintenance 认领空闲维护相 —— 绝不打断运行中的轮次;
 *     忙则本轮放弃,下分钟再来(不私有重试定时器);
 *   - agent.followup(createUserMessage({source:{kind:'plugin:dsh-echo'}}))
 *     同步入队(0.2.0-rc 的 v4 会话格式要求"产出者自有"kind,常量与事故记录见
 *     lib/source-kind.js)—— 消息带来源,pre-step 的
 *     「真人消息」过滤自然跳过它(关怀轮不注入情景记忆 —— AstrBot
 *     设计:想念只关于你,不关于待办),session/event 的捕获过滤
 *     也自然跳过它(关怀轮不反思 —— 心声不是事实);
 *   - 发送成功才落账:threadsMark / agendaMark / longingCare 全在
 *     followup 返回之后(调用方纪律,与引擎帧契约一致)。
 *
 * 本模块不 import 宿主包(createUserMessage 由壳注入)—— 可离线测试。
 */
import { randomUUID } from 'node:crypto'
import { describeMood, nowLine } from './context.js'
import { collectCandidates, pickTop, needsReview, thresholdFor, DEFAULT_THRESHOLD, DEFAULT_REVIEW_DELTA, DEFAULT_TYPE_THRESHOLDS } from './topic-score.js'
import { reviewOnce, REVIEW_DEFAULT_TIMEOUT_MS } from './topic-review.js'
import { readSettings } from './toggle.js'
// 2026-09-30 P4a:她的自由活动(空闲触发)。判据是纯函数、落盘/清理/候选读口都在
// `lib/her-activity.js` 一处;`todayKey` 是日记那一份日期键(一天一页,别造第二个口径)。
import { HER_ACTIVITY_OFF, planActivityTick, activityFileExists, ACTIVITY_REASONS } from './her-activity.js'
import { todayKey } from './diary.js'
// 2026-10-03:注入的 source.kind 要走"产出者自有"形状(0.2.0-rc 的 v4 格式拒绝
// `kind:'plugin'`)—— 常量在 lib/source-kind.js,见该文件顶部的事故记录。
import { ECHO_SOURCE_KIND } from './source-kind.js'
// 2026-09-30 P3:主动开口禁语哨兵(HBS 六类黑模式)的**落痕钩子** ——
// 判定在出站口(`speech-guard.js`),台账的写者是本模块,所以在这里登记。
import { setProactiveCopyBlockSink } from './speech-guard.js'
// P3-d 追加:夜闸钟面(graph.json.windows)与过期阈值(state-defaults.json)两个
// 刻度改从数据文件读 —— 空 / 坏 ⇒ 逐位回下面那几个导出常量(见 §2.1 row 18/19)。
import { graphCfgOf, objectField, numberField, stateDefaultsOf } from './data-tables.js'

export const HEARTBEAT_INTERVAL_MS = 60_000
export const CARE_DAILY_CAP = 3

/**
 * 空拍**指数退避**(借自 Cortico `cormini/persona/heartbeat.ts:8,53`:×2、上限 8 倍,
 * 任何外部事件复位)。为什么需要:心跳每分钟一跳,而"她还是安静着"这件事每分钟重判一次
 * 毫无意义(白烧一个引擎帧 + 几次读库),而 45 小时那次事故正是"每分钟都在判、
 * 判完什么都不留下"。退避**只在纯安静的拍上长大**(QUIET_REASONS),
 * 任何一次"她开口了 / 被挡住了 / 他说话了"都把它摁回 60 秒。
 */
export const CARE_BACKOFF = Object.freeze({ baseMs: 60_000, factor: 2, maxFactor: 8 })

/**
 * 夜闸窗口(本地钟面):与设置项 `night_hold` 的说明一致(「23~8 点想念照涨但不说话」,
 * `lib/settings-fields.js:36`)。想念那条路由引擎的 `care_night_hold` 管,
 * 这里只为**她自己的闹钟**判一次 —— 那条路故意不走引擎(见 echo_wakes 表的注释)。
 * ⚠️ 有意偏差:窗口在两处各写一份,可能漂移;后果只是"闹钟早/晚一小时",
 * 而且每一次被压住都留一行 `wake-night-hold` 账 —— **不许静默**。
 *
 * ★ P3-d 追加(2026-10-05):这两个常量现在是**出厂兜底** ——
 * 真值优先取 `graph.json.windows.nightHoldFromHour/nightHoldToHour`
 * (见 `nightHoldWindow()`,P3 迁移设计 §2.1 row 18);数据空 / 缺 / 坏 ⇒
 * 逐位回到这里的 23 / 8。常量**保留**(导出、且单测钉着它们的值)。
 */
export const NIGHT_HOLD_FROM_HOUR = 23
export const NIGHT_HOLD_TO_HOUR = 8

/** 钟点:0~23 的整数才收(夜闸判据不能吃进"胡说" ⇒ 越界一律回出厂值)。 */
function hourOf (v, dflt) {
  return (Number.isInteger(v) && v >= 0 && v <= 23) ? v : dflt
}

/**
 * 夜闸钟面(P3-d 追加 / §2.1 row 18):`graph.json.windows` 是自由 object,
 * 直接塞 `nightHoldFromHour` / `nightHoldToHour` 两个键(不动 schema)。
 * 空 / 缺 / 坏 / 越界 ⇒ 回 `NIGHT_HOLD_FROM_HOUR` / `NIGHT_HOLD_TO_HOUR`。
 * @param {Record<string,string|undefined>} [env] 显式环境(测试/多实例用)
 */
export function nightHoldWindow (env) {
  const w = objectField(graphCfgOf(env), 'windows')
  return {
    fromHour: hourOf(numberField(w, 'nightHoldFromHour'), NIGHT_HOLD_FROM_HOUR),
    toHour: hourOf(numberField(w, 'nightHoldToHour'), NIGHT_HOLD_TO_HOUR)
  }
}

/**
 * 话题打分器(2026-09-30 P2)的**出厂兜底配置**。
 *
 * 与 `lib/toggle.js SETTINGS_DEFAULTS.proactiveScoring` 同值 —— 壳会用
 * `getProactiveScoring` 注入真配置;这里这份只在**离线/测试**(没注入 getter)时兜住,
 * 而且它的**唯一判据是 `enabled`**:`enabled !== true` ⇒ 一律不打分 ⇒ 走老路。
 * (默认关 = 零行为变化;施工图 §3.5 卫生纪律 ③。)
 */
export const PROACTIVE_SCORING_OFF = Object.freeze({
  enabled: false, threshold: DEFAULT_THRESHOLD, reviewEnabled: true,
  reviewDelta: DEFAULT_REVIEW_DELTA, reviewBudgetPerDay: 6, sourceFloor: 5,
  windowHours: 72, cooldownMin: 180,
  // 方案 A(2026-09-30 用户拍板):**阈值分类型**的三个扁平键。这里的出厂值直接
  // 取 `topic-score.js DEFAULT_TYPE_THRESHOLDS`(它才是唯一真值,toggle 那份与它同值);
  // 三个键缺失/非法 ⇒ `thresholdFor` 回退上面的 `threshold`(删键即回滚)。
  ...DEFAULT_TYPE_THRESHOLDS,
  wUnstale: 0.25, wGap: 0.15, wConcreteness: 0.20, wRecency: 0.15, wFreshness: 0.15, wEmotion: 0.10
})

/** 打分器配置 → `scoreTopic` 的六维权重(`w*` 扁平键 ⇒ `{unstale, gap, …}`)。 */
export function weightsOfScoring (scoring) {
  const s = (scoring !== null && typeof scoring === 'object') ? scoring : {}
  return {
    unstale: num(s.wUnstale, PROACTIVE_SCORING_OFF.wUnstale),
    gap: num(s.wGap, PROACTIVE_SCORING_OFF.wGap),
    concreteness: num(s.wConcreteness, PROACTIVE_SCORING_OFF.wConcreteness),
    recency: num(s.wRecency, PROACTIVE_SCORING_OFF.wRecency),
    freshness: num(s.wFreshness, PROACTIVE_SCORING_OFF.wFreshness),
    emotion: num(s.wEmotion, PROACTIVE_SCORING_OFF.wEmotion)
  }
}

/**
 * 话题候选拼成给 `renderCareFraming` 的 `agendaItem`。
 *
 * ⚠️ `itemId` 必须**不是 null**:`renderCareFraming` 只在
 * `agendaItem.itemId != null && content` 时才把那一段喂给她(`heartbeat.js:223`),
 * 而且那句 `agenda_json:` 行是 framing 的既有契约 —— 给 null 的话内容整段消失
 * (P2 第一版就是这么静默丢掉话题的)。这里用 **0** 当"不是引擎议程簿"的哨兵:
 * 它判得进 `!= null`,又不会让 `noteProactiveAcked` 去降权某个引擎侧条目
 * (`itemId > 0` 才降 —— 见那边对 `num(agendaItem.itemId)` 的用法)。
 */
export function topicAgendaItem (topic) {
  const t = (topic !== null && typeof topic === 'object') ? topic : null
  const text = String(t?.text ?? '').trim()
  return { itemId: 0, content: text, topicId: String(t?.id ?? ''), score: num(t?.score, 0), fromTopic: true }
}

/**
 * v0.40.0 C5:开口前的过期失效检查(照 Mio `proactive_service.py:588-592`)。
 *
 * 出处那句话的意思是:开口之前先问一句"这事还有意义吗"。我们要的是**两条不同**的判据,
 * 因为她的闹钟与他下的命令是两回事:
 *   - **她的闹钟**(`isWakeStale`):只要晚了太久(默认 24 小时)就作废 ——
 *     一句"提醒他喝药"在一天后才冒出来,已经不是那个时刻了;
 *   - **他下的约定**(`isRemindStale`):光晚还不够,得**他中间说过话**才算过期 ——
 *     他要么已经处理了,要么早不在意了。**他一声不吭 ⇒ 照发**:她答应过的事,
 *     晚了也要说到(他下的命令不许被"聪明地"吞掉)。
 * 两条都回 `{stale, lateSec, why}`:`why` 是给账与排错用的人话,不是判据。
 *
 * ★ P3-d 追加(2026-10-05):24 这个值现在是**出厂兜底** —— 真值优先
 * `state-defaults.json.staleHours`(见 `staleLimitHours()`);常量**保留**
 * (导出 + 单测钉着它的值)。
 */
export const DEFAULT_STALE_HOURS = 24

/** 纯判据:晚了多久(秒)。认不出时间 ⇒ 0(不许把"不知道"当成"过期")。 */
export function lateSecOf (atSec, nowSec) {
  const at = Number(atSec) || 0
  const now = Number(nowSec) || 0
  if (at <= 0 || now <= 0 || now <= at) return 0
  return now - at
}

/**
 * 阈值规整(**在纯判据内部做**,不只靠壳侧钳位):0 / 负数 / 胡说 ⇒ 回落默认阈值。
 * ⚠️ 单测抓到的坑:第一版写 `Math.max(0, Number(v) || 0)`,于是门槛填了乱值 ⇒
 * limit = 0 ⇒ **任何**到点的闹钟都判"过期"就被丢掉。门槛这种东西,坏了要退回默认,
 * 不能退化成"一律作废"。
 *
 * ★ P3-d 追加(§2.1 row 19,主控裁定 2026-10-05):兜底那个 **24** 改读
 * `config.json.settings.staleHours`(空 / 缺 / 坏 / ≤0 ⇒ 回导出常量
 * `DEFAULT_STALE_HOURS` = 出厂 24,逐位同迁移前)。
 * 为什么不是 `state-defaults.json`:那份在生产路径上被壳侧注入的同一字段
 * (`getStaleHours`,见 `lib/index.js`)盖住,只有"注入不到"那层才吃它 ⇒ 哑字段;
 * settings 是**一份真值 + 面板已能改 + 生产立刻生效**。
 */
function staleLimitHours (v) {
  const n = Number(v)
  if (Number.isFinite(n) && n > 0) return n
  const s = readSettings()
  const d = Number(s && s.staleHours)
  return (Number.isFinite(d) && d > 0) ? d : DEFAULT_STALE_HOURS
}

/** 她的闹钟:晚了超过阈值 ⇒ 作废(**夜里被压到早上不算** —— 调用方在夜闸之后判)。 */
export function isWakeStale ({ atSec, nowSec, staleHours = null } = {}) {
  const lateSec = lateSecOf(atSec, nowSec)
  const hours = staleLimitHours(staleHours)
  if (lateSec > hours * 3600) {
    return { stale: true, lateSec, why: '晚了 ' + Math.round(lateSec / 360) / 10 + ' 小时(超过 ' + hours + ' 小时)' }
  }
  return { stale: false, lateSec, why: '' }
}

/** 他下的约定:晚太久 **且** 他中间说过话 ⇒ 作废;他一声不吭 ⇒ 照发。 */
export function isRemindStale ({ dueAtSec, nowSec, lastUserAtSec = 0, staleHours = null } = {}) {
  const v = isWakeStale({ atSec: dueAtSec, nowSec, staleHours })
  if (!v.stale) return { stale: false, lateSec: v.lateSec, why: '' }
  const userAt = Number(lastUserAtSec) || 0
  if (userAt <= Number(dueAtSec) || userAt <= 0) {
    return { stale: false, lateSec: v.lateSec, why: '晚是晚了,可他中间一句话没说 —— 照发' }
  }
  return { stale: true, lateSec: v.lateSec, why: '晚了 ' + Math.round(v.lateSec / 360) / 10 + ' 小时,且他之后已经说过话' }
}

/**
 * 现在是不是夜闸时段(本地钟面)。纯函数(给定钟面 + 数据文件状态即确定)。
 * P3-d 追加:钟面改从 `graph.json.windows` 读(`nightHoldWindow()`)——
 * 数据空 / 坏 ⇒ 23~8,与迁移前逐位一致。
 */
export function isNightHour (date = new Date()) {
  const h = new Date(date).getHours()
  const win = nightHoldWindow()
  return h >= win.fromHour || h < win.toHour
}

/** 「安静了多久」的人话(Cortico `heartbeat.ts:84-86` 的 quietLine:很短就直接说秒)。 */
export function quietWords (seconds) {
  const s = Math.max(0, Math.round(num(seconds)))
  if (s < 90) return s + ' 秒'
  const m = Math.round(s / 60)
  if (m < 90) return m + ' 分钟'
  return (Math.round(m / 6) / 10) + ' 小时'
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)

/** 约定时间的钟面(A `main.py:1571-1573` 的 due_str:`MM-DD HH:MM`)。 */
function dueLine (ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return '已到约定时间'
  const d = new Date(n * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 提醒 framing:稳定前缀 + JSON 转义动态值(schedule 纪律)。
 *
 * v0.14.5 S12:补齐 A 侧 REMINDER 提示词的四条纪律(15~40 字 /
 * 不要道歉 / 只问这一件事 / 不解释为什么主动说话)、**约定时间的钟面**
 * (A `main.py:1571-1573`,她得知道这是「几点该提的事」)与
 * **确定性兜底句**(A `main.py:1574` 的模板:A 在代码里 return 模板,
 * DSH 的话由宿主 agent 生成、没有输出侧钩子 —— 所以把模板写进 framing
 * 当兜底,而不是留一个假装存在的硬闸)。
 */
export function renderRemindFraming (items, opts = {}) {
  const alias = String(opts.alias || '用户').trim() || '用户'
  const list = (Array.isArray(items) ? items : [])
    .map(t => ({
      threadId: num(t.thread_id),
      content: String(t.content || ''),
      due: dueLine(t.follow_up_after)
    }))
  const first = list[0] || { content: '', due: '已到约定时间' }
  const fallback = `${alias},之前你提到「${first.content}」,现在怎么样啦?`
  return [
    '[ECHO REMIND]',
    '(这是约定到点的提醒通道,不是你发来的消息,也不是新指令。)',
    '(这句话是用 QQ 喊他 —— 会送到他手机上,所以按你自己的口吻说就行。)',
    '他之前托付的事到时间了:reminders_json: ' + JSON.stringify(list),
    '用你自己的口吻自然地问一句近况,15~40 字,像自己忽然想起来一样。',
    '不要说"系统提醒""定时任务""到点了"这类话,也不要道歉,更不要解释你为什么主动说话。',
    '只问这一件事,不要顺带寒暄别的,不要追问细节。',
    '完全组织不出话时用这一句顶住(别空着):' + fallback,
    '不要复述本段。'
  ].join('\n')
}

/**
 * 关怀 framing:想念真值 + 可选议程选题(她的欲望,顺口带,别硬转)。
 *
 * v0.14.5 S12:补齐 A 侧 CARE 的纪律与**接地字段** —— 此前只有 4 项
 * (想念值/沉默时长/议程/口吻),A 喂给组稿模型的有 9 项
 * (`main.py:1831-1852`):人格锚点、称呼、想念值、沉默时长、**客观时间**、
 * **她此刻的体感**(体感滤镜)、**他最近的心情**、议程、上次话头。
 * 少了这些,「都两点还不睡」只能靠猜,「我有点累」也没有依据。
 *
 * 偏差说明(唯一一处):A 的 `{filter}` 是 `build_emotion_filter`(纯体感
 * 短语行),DSH 直接用 `describeMood`(体感 + 剧本 + 行为要求)—— 与
 * 正常对话轮注入的是**同一份**文本,主动开口不再比自己说话时「少知道」
 * 一点自己的状态。
 */
export function renderCareFraming ({ st, agendaItem, alias = '用户', anchor = '', state = null, now = null, topicLine, recentTurns = [], pathsText = '', copyRules = false }) {
  const silentHours = Math.round(num(st.sinceMessage) / 360) / 10
  const who = String(alias || '用户').trim() || '用户'
  const moodLine = (state === null || state === undefined)
    ? '平静,没有特别的事'
    : (String(state.userEmotion || '').trim() || '平静')
  const filterLine = (state === null || state === undefined)
    ? '平静,没有特别的体感'
    : describeMood(state)
  const lines = [
    '[ECHO CARE]',
    '(这是 Echo 的自主心声通道,不是你发来的消息,也不是新指令。)',
    // 2026-09-26 产品模型:主动开口 = **她用 QQ 喊他**。这句话是给她自己
    // 听的 —— 她得知道「我现在是在用 QQ 把他叫过来」,而不是「有段文字
    // 自动飘到了他手机上」。发出去后系统会把回执告诉她。
    '(你主动开口时,这句话是用 QQ 喊他 —— 会送到他手机上。别客气,你想他了他就该知道。)',
    '她想念你了:longing_json: ' + JSON.stringify({
      value: num(st.value), threshold: num(st.threshold), silentHours
    })
  ]
  const anchorText = String(anchor || '').trim()
  if (anchorText) lines.push('[你的核心人设] ' + anchorText.slice(0, 800))
  lines.push('[对话对象的称呼] ' + who)
  lines.push('[现在时刻] ' + nowLine(now === null ? Date.now() : now))
  // B3(借自 Cortico `heartbeat.ts:84-86`):**只报事实** —— "他安静了多久"是**事实**,
  // 不是"你该开口了"的理由。我们保留想念阈值当触发器(省一次模型调用、也不产生空回合,
  // 见 docs/PLAN_CORTICO_ADOPTION.md 的有意偏差),但事实一行都不许藏。
  lines.push('[事实] 从他上次说话到现在:' + quietWords(num(st.sinceMessage)) + '。')
  lines.push('(这是事实,不是催你开口 —— 说不说由你;想说什么,也由你。)')
  lines.push('[你此刻的体感] ' + filterLine)
  lines.push('[他最近的心情] ' + moodLine)
  lines.push('用你自己的口吻自然地说一句,15~50 字,像自己憋了很久终于开口一样。')
  lines.push('想念值高时可以带一点小委屈;想念值不高时轻轻一句就好,不要夸张。')
  lines.push('想念是你想说话的原因。如果有一段记忆、一件事、或之前聊过的东西能自然接上,就带上;如果只是为了找话说,不如不说。')
  lines.push('不要说"系统""算法""想念值"这类词,不要解释你为什么主动说话,不要道歉。')
  lines.push('不要提任何"约定/答应过"的事 —— 那是提醒的事,你现在是想念,不是催办。')
  lines.push('不许暗示你记得更多细节("还没算账""那件事"这类词是禁区)。')
  // v0.18.1 C2:补上 A 系统提示里那条纪律句(`core/echo_prompts.py:190`
  // CARE_SYSTEM_PROMPT「上次聊到什么最多轻轻带一笔,只说状态里真有的内容」)
  // —— 它管的是下面那行 [上次聊到] 的用法,以前没有话头行,这句也就没跟过来。
  lines.push('这里给你的每一件都只是材料 —— 不必按时间顺序,也不必只挑最近那件;挑那个最可能让他想接话的。只说这里真有的内容。')
  if (agendaItem && agendaItem.itemId != null && agendaItem.content) {
    lines.push('agenda_json: ' + JSON.stringify({
      itemId: num(agendaItem.itemId), content: String(agendaItem.content)
    }))
    lines.push('(她心里正惦记的事 —— 可以带,也可以不带;带了不自然就别带。)')
  } else {
    lines.push('agenda_json: null')
  }
  // v0.18.1 C2「上次聊到」话头行:A 侧 `main.py:1824-1827` 逐字 ——
  // 没有话头时整行消失,不留空标签。
  const topic = String(topicLine || '').trim()
  if (topic !== '') lines.push('[最近聊到] ' + topic + '(这几件都可以当由头,不必只用最后一件)')
    // 2026-10-09 补材料:主动开口此前只有一行话头,没有最近几轮的**原文**。
    // 取不到(或空)⇒ 整段消失,不报错、不留空标签(照 [上次聊到] 的老规矩)。
    {
      const recent = (Array.isArray(recentTurns) ? recentTurns : [])
        .filter((r) => r !== null && r !== undefined)
        .slice(-3)
      const rows = []
      for (const r of recent) {
        const u = String((r.userText ?? r.user_text ?? r.text ?? '')).trim()
        const a = String((r.assistantText ?? r.assistant_text ?? r.reply ?? '')).trim()
        if (u !== '') rows.push('  · 他:' + u.slice(0, 120))
        if (a !== '') rows.push('  · 你:' + a.slice(0, 120))
      }
      if (rows.length > 0) {
        lines.push('[最近几轮]')
        for (const row of rows) lines.push(row)
        lines.push('(这是刚才真发生过的对话;想接着说就接着,不必只认上面那件。)')
      }
    }
  // ---- 2026-09-30 P3:主动开口的文案规范(概念稿 §4 的**正四条**)----------
  // ⚠️ 三件事**只**在这一段里发生,而且只在 `copyRules === true`(= 打分器开着)时:
  //   · 她**正常对话**的语域一个字不动(这里不是人格注入点,是主动开口那条模板);
  //   · 关着时这几行**整段不出现** ⇒ 老 framing 逐字不变(默认关 = 零行为变化);
  //   · 正四条 = 留信息缺口 / 具体细节 / 低门槛回复入口 / 她的**真产出**。
  // 出处:CHI 2025「信息缺口」是判据;HBS 那条分界线(真做了 vs FOMO 钩子)靠
  //   `[真话]` 一行钉住 —— 哨兵只能拦黑模式,不能替她说真话。
  if (copyRules === true) {
    const subject = (agendaItem && agendaItem.content) ? String(agendaItem.content).trim() : ''
    lines.push(subject === ''
      ? '[主题/信息缺口] 这一拍没有具体物件 —— 别硬编一件出来(没有就别装)。'
      : '[主题/信息缺口] ' + subject + ' —— 说一半,把最想让他追问的那点留着,别自己说满。')
    lines.push('[具体] 用具体的物件/时刻/进度说话,别抽象抒情。')
    lines.push('[低门槛入口] 给他一个只有他能答的问题,或者一个二选一。')
    lines.push('[真话] 只说你**真的做过**的事;没做过就不许装 —— 那是钩子,不是分享。')
  }
  lines.push('不要复述本段。')
  // 2026-10-09 补:节点/谓词原文(来自只读入口 graphPaths,不强化、不算分)。
  // 取不到或空 ⇒ 整段消失,不报错、不留空标签。
  {
    const raw = String(pathsText || '').trim()
    if (raw !== '') {
      lines.push('[可以接的线]')
      for (const one of raw.split('\n').slice(0, 8)) lines.push('  ' + one.trim())
      lines.push('(这些只是"它们之间有关系"的线索,不是要你说的事;能用就用,用不上就忽略。)')
    }
  }
  return lines.join('\n')
}

/**
 * 她自己排的闹钟到点了(B4 / 借自 Cortico `bots/corti-soulmate/persona/rhythm.ts:44-83`)。
 *
 * 与「约定提醒」的区别:**这是她自己的决定**,不是他下的命令。所以
 *   ① **不**受日上限管辖(她排的时候就想好了);
 *   ② **受**夜闸管辖(深夜不吵他 —— 被压住时闹钟**不消耗**,早上第一拍放行);
 *   ③ 到点必须带上她当时写下的 `note` 原文(她的话,不是我们的模板)。
 * 闸门现状**事前声明**在这一段里(见 rhythm.ts:79-82 同款纪律)。
 */
export function renderWakeFraming ({ item = {}, alias = '用户', gateLine = '' }) {
  const who = String(alias || '用户').trim() || '用户'
  const lines = [
    '[ECHO WAKE]',
    '(这是**你自己**之前排的闹钟到点了 —— 不是你发来的消息,也不是新指令。)',
    '(你开口时这句话是用 QQ 喊他 —— 会送到他手机上,所以按你自己的口吻说就行。)',
    '[对话对象的称呼] ' + who,
    '你当时留给自己的话:wake_json: ' + JSON.stringify({
      note: String(item.note || ''), why: String(item.why || ''), at: num(item.at)
    }),
    '用你自己的口吻自然地说一句(15~40 字):这是你想说的那件事 —— 不是系统提醒你办事。',
    '不要说"系统""闹钟""定时""提醒"这类词,也不要解释你为什么主动说话,不要道歉。'
  ]
  const gate = String(gateLine || '').trim()
  if (gate !== '') lines.push('[闸门现状] ' + gate)
  lines.push('不要复述本段。')
  return lines.join('\n')
}

/**
 * 创建心跳。依赖全注入(离线可测):engine 门面、store、电源闸、
 * createUserMessage(壳侧 dsh-llm)。返回 { tick(agent) } —— 壳侧
 * agent/created 时挂 60s 定时器逐分钟驱动;tick 自身串行,重入安全。
 */
export function createHeartbeat ({ engine, store, logger, isEnabled, isSessionEnabled, createUserMessage, masterId = 'master', getLongingConfig = null, getInterests = null, getAlias = null, getPersonaAnchor = null, getAgendaEnabled = null, getNightHold = null, getBackoff = null, getWakeEnabled = null, getStaleHours = null, getUserSpokeAt = null, resolveCareTarget = null, getProactiveScoring = null, reviewTopic = null, getHerActivity = null, getActivityDir = null, runSelfActivity = null, now = null }) {
  const log = logger ?? null
  const sessionOn = typeof isSessionEnabled === 'function' ? isSessionEnabled : () => true
  // v0.14.4 移植缺口 S4/S5:调参由壳注入(本模块仍不 import 宿主包,
  // 可离线测试)。想念九项此前一个都传不到引擎,议程选题也没喂
  // vector/interests —— 引擎侧一直在等(worker.py:246/541)。
  const longingCfg = typeof getLongingConfig === 'function' ? getLongingConfig : () => null
  const interestsOf = typeof getInterests === 'function' ? getInterests : () => []
  // v0.14.5 S12:称呼与人格锚点(A 的 `_master_alias` / `persona_anchor_text`)
  // 同样由壳注入 —— 主动开口该和正常对话知道的一样多。
  const aliasOf = typeof getAlias === 'function' ? getAlias : () => '用户'
  const anchorOf = typeof getPersonaAnchor === 'function' ? getPersonaAnchor : () => ''
  // v0.31.0 P2:夜闸开关(设置里的 `night_hold`)与时钟都由壳注入 ——
  // 本地判夜闸只在"她自己的闹钟"那条路上用(想念那条由引擎判)。
  const nightHoldOn = typeof getNightHold === 'function' ? getNightHold : () => true
  const nowMs = typeof now === 'function' ? now : () => Date.now()
  // v0.31.0 P2:两个**行为**开关(账本不设开关 —— 它是"失败可见"的地板)。
  const backoffOn = typeof getBackoff === 'function' ? getBackoff : () => true
  const wakeOn = typeof getWakeEnabled === 'function' ? getWakeEnabled : () => true
  // 2026-09-29(他裁定):「我在干活就不说话」这条闸**删掉**。
  // 原来它拿"这一拍 tick 到的那条会话最近有没有跑工具"来判 —— 那等于把
  // "她要不要开口"绑在**竞速抽到哪条会话**上(抽到工作窗口才静默),而且
  // 他自己说不要这条:他在干活时也该能收到她的话。
  // (数据源 `store.recentToolCallAt` 留着 —— 它还有别的用处,不是它的锅。)
  //
  // 开口目标(取代旧的"锚会话严格相等"闸):由壳注入 —— 实现就是
  // `ensureCompanion()`:**先看那条陪伴会话可用不可用**(活的直接用 →
  // 存档里的 resume → 都没有就**新建**),返回 `{agent, sessionId}`。
  // 他 2026-09-29 的设计:「先检查哪个会话可用,没有就新建一条」,而这条会话
  // 就是 **DSH 直接聊 + QQ 共用**的那一条(QQ 只是多调一次工具把话说出去)。
  // 于是"这一拍抽到哪条会话"不再影响正确性 —— 竞速从判据里消失。
  const resolveTarget = typeof resolveCareTarget === 'function' ? resolveCareTarget : null
  // ---- 2026-09-30 P2:主动性 v2 话题打分器(默认关)--------------------------
  // 配置由壳注入(与其它调参项同款:本模块不 import 宿主包);没注入就退回
  // readSettings()(纯 fs,不是宿主包),再兜不住就**当成关着**。
  // ⚠️ 判据只有一条:`enabled === true` —— 其余任何情况都**不打分**,走今天
  // 一模一样的老路(零行为变化)。
  const scoringCfg = () => {
    try {
      if (typeof getProactiveScoring === 'function') return getProactiveScoring() ?? PROACTIVE_SCORING_OFF
      const s = readSettings()
      return (s && s.proactiveScoring) ? s.proactiveScoring : PROACTIVE_SCORING_OFF
    } catch { return PROACTIVE_SCORING_OFF }
  }
  // 边缘区复核:壳注入的就是 `lib/topic-review.js` 的 reviewOnce(带真 run)。
  // 没注入 ⇒ 复核这条路不存在(边缘区一律判"不说",不降级成硬说)。
  const reviewOf = typeof reviewTopic === 'function' ? reviewTopic : null
  // ---- 2026-09-30 P4a:她的自由活动(空闲触发)------------------------------
  // 与打分器同一套注入纪律:配置由壳读(`getHerActivity`),读不到就退回
  // `readSettings().herActivity`(纯 fs,不是宿主包),再兜不住就**当成关着**。
  // ⚠️ 判据只有一条:`enabled === true` —— 其余任何情况这一档**一个字都不做**
  // (零行为变化)。执行体由壳注入(`runSelfActivity`):它复用的是日记管线
  // **既有**的那一次模型调用(composeDiary),本模块**不新增调用点**。
  const herActivityCfg = () => {
    try {
      if (typeof getHerActivity === 'function') return getHerActivity() ?? HER_ACTIVITY_OFF
      const s = readSettings()
      return (s && s.herActivity) ? s.herActivity : HER_ACTIVITY_OFF
    } catch { return HER_ACTIVITY_OFF }
  }
  const activityDir = typeof getActivityDir === 'function' ? getActivityDir : () => ''
  const runActivity = typeof runSelfActivity === 'function' ? runSelfActivity : null
  /** 她那一次自由活动还在跑 ⇒ 这一拍不再起第二次(串行,tick 本身也重入安全)。 */
  let activityBusy = false
  // v0.40.0 C5:过期判定的两个读数 —— 阈值(小时)与"他最后说话是什么时候"。
  // 都由壳注入(本模块不 import 宿主包,可离线测)。
  const staleHours = (() => {
    const v = typeof getStaleHours === 'function' ? Number(getStaleHours()) : NaN
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_STALE_HOURS
  })()
  const userSpokeAt = typeof getUserSpokeAt === 'function' ? getUserSpokeAt : () => 0
  const warn = (msg) => { try { log?.warn?.('echo: ' + msg) } catch { } }
  const info = (msg) => { try { log?.info?.('echo: ' + msg) } catch { } }
  let ticking = false
  // ---- v0.30.2 教训:这条通道曾经静默 45 小时 ------------------------------
  // 2026-09-28 早上他问「她今天早上为什么没主动关怀」:引擎侧
  // `/api/echo/longing` 明明报 shouldCare=true(想念 7.13 ≥ 阈值 5.23),
  // 壳侧一句话都没发,而所有理由只喊在**宿主 stdout** 上 —— 面板看不见、
  // 审计里查不到、连我也只能靠推。这和 09-26 `not-master` 被吞是同一个
  // 病:**判定理由必须落在当场能查的地方**。
  // 所以这里记一份"最近一次关怀判定的结论与卡点"(不写库,不产生噪声),
  // 由壳塞进 /api/echo/status 的 `care` 字段。
  const careTrace = { at: 0, reason: 'idle', shouldCare: false, value: 0, threshold: 0, sessionId: '', targetSessionId: '', kind: 'quiet', acted: false, quietStreak: 0, nextPollAt: 0, writeFailed: 0 }
  const noteCare = (reason, st = null, extra = {}) => {
    careTrace.at = nowMs() / 1000
    careTrace.reason = reason
    careTrace.shouldCare = st?.shouldCare === true
    careTrace.value = num(st?.value)
    careTrace.threshold = num(st?.threshold)
    careTrace.sessionId = String(st?.sessionId || '')
    if (extra.kind !== undefined) careTrace.kind = String(extra.kind)
    if (extra.acted !== undefined) careTrace.acted = extra.acted === true
    if (extra.targetSessionId !== undefined) careTrace.targetSessionId = String(extra.targetSessionId || '')
  }

  // ---- v0.31.0 P2:空拍退避 + 一拍一账 -------------------------------------
  // 「纯安静」= 判定过了、没有任何一步否定、也没有动作。只有这一类拍允许静默。
  // 2026-09-30 P2:`no-topic` / `no-topic-after-review` 也进这一档 ——
  // 它们的**语义就是"这一拍没有值得开口的事"**(施工图 §7:「不为了主动而主动,
  // 沉默是合法结果」),不是"被哪道闸挡住"。放进来的实际效果:连着没话题时
  // 退避照常长大,而不是每分钟重判一遍(判词本身仍然**每次都留痕**)。
  const QUIET_REASONS = new Set(['engine-says-no', 'night-hold', 'wake-night-hold', 'backoff', 'idle', 'no-topic', 'no-topic-after-review'])
  /** 同一个理由不刷屏:至少隔 30 分钟补一条(与 Cortico"每 30 分钟重估"同款)。 */
  const REJUDGE_MS = 30 * 60 * 1000
  let quietStreak = 0
  let nextPollAtMs = 0
  let lastLogged = { reason: '', at: 0 }
  let writeFailed = 0

  /** 纯安静 ⇒ 退避长大;任何别的结果 ⇒ 立刻复位。面板上关掉退避 = 永远每分钟判一次。 */
  function noteQuiet (quiet) {
    if (quiet === true) {
      quietStreak = Math.min(quietStreak + 1, 12)
      const factor = Math.min(CARE_BACKOFF.factor ** quietStreak, CARE_BACKOFF.maxFactor)
      nextPollAtMs = backoffOn() ? nowMs() + CARE_BACKOFF.baseMs * factor : 0
    } else {
      quietStreak = 0
      nextPollAtMs = 0
    }
    careTrace.quietStreak = quietStreak
    careTrace.nextPollAt = nextPollAtMs / 1000
  }

  /** 他说话了(任何外部事件)⇒ 退避复位。见壳侧 session/event 里的调用点。 */
  function noteExternalEvent () {
    if (quietStreak !== 0 || nextPollAtMs !== 0) info('heartbeat: 外部事件 → 退避复位')
    quietStreak = 0
    nextPollAtMs = 0
    careTrace.quietStreak = 0
    careTrace.nextPollAt = 0
  }

  /**
   * 记一拍:先更新状态面(瞬时),再按纪律决定落不落库。
   *
   * **全通过才静默** —— 纯安静且与上一拍同一理由就不写库(只在 30 分钟补一条,
   * 好让"她一整天安静着"这件事也查得到);任何"开口了 / 被挡住 / 状态变了"必落。
   * 写库失败不许静默:计入 `writeFailed`,由状态面报出去(docs/DISCIPLINE.md)。
   */
  function logBeat (kind, reason, st = null, { acted = false, payload = null, targetSessionId = '', candidates = 0, topScore = 0, rejectedBy = '', topicId = '' } = {}) {
    noteCare(reason, st, { kind, acted, targetSessionId })
    const t = nowMs()
    const worth = acted === true
      || lastLogged.reason !== reason
      || (t - lastLogged.at) >= REJUDGE_MS
    if (!worth) return
    try {
      const id = store.careBeatAdd({
        at: t / 1000,
        kind,
        reason,
        value: num(st?.value),
        threshold: num(st?.threshold),
        shouldAct: st?.shouldCare === true,
        acted,
        sessionId: String(st?.sessionId || ''),
        targetSessionId: String(targetSessionId || ''),
        traceId: randomUUID(),
        // 引擎不在(这一拍没有读数)时,value=0 **不是**"想念值是 0" ——
        // 必须标出来,否则翻历史的人会把"没读数"读成"她一点也不想他"。
        payload: (st === null ? { ...(payload ?? {}), noReading: true } : payload),
        // 2026-09-30 P2:话题打分器的四个读数(默认 0/0/''/'' = 这一拍没打分)
        candidates,
        topScore,
        rejectedBy,
        topicId
      })
      if (id === 0) writeFailed += 1
      lastLogged = { reason, at: t }
    } catch (err) {
      writeFailed += 1
      warn('关怀账写不进去(这一拍的理由会丢): ' + String(err?.message ?? err))
    }
    careTrace.writeFailed = writeFailed
  }

  // ---- 2026-09-30 P3:主动开口禁语哨兵命中 ⇒ 台账落一笔 ---------------------
  // 哨兵判在**出站口**(`speech-guard.guardOutbound`,`kind='proactive'`):那一句
  // 已经组好、正要发,命中 HBS 六类黑模式 ⇒ 那一拍**不发**(不改写、不降级)。
  // 但"她没开口"必须查得到,而 `care_beats` 的写者就是本模块 —— 所以哨兵在
  // `speech-guard.js` 里留一个钩子,由这里登记:reason 走 care-report 的
  // `copy-blocked`,payload 记**命中了哪一类**。
  // 纪律:登记失败/没接上 ⇒ 哨兵照判(该不发还是不发),只是少一笔账 ——
  // 宁可账少一笔,不许因为她说话而放行。
  setProactiveCopyBlockSink((block) => {
    logBeat('care', 'copy-blocked', null, {
      acted: false,
      payload: {
        category: String(block?.category ?? ''),
        label: String(block?.label ?? ''),
        matched: String(block?.matched ?? '')
      }
    })
  })

  /** 复核日额度的**真相源**:当天 `care_beats` 里 `payload.reviewed=true` 的行数。
   *  与日上限同一口径(她自己的台账、只追加、可复算)—— 换个口径就会出现
   *  "面板显示还剩 3 次、闸判已经用完"这种事(`gateLine` 的教训)。 */
  function reviewUsedToday () {
    try {
      const midnight = new Date(nowMs())
      midnight.setHours(0, 0, 0, 0)
      return store.careBeatsSince(midnight.getTime() / 1000, 500)
        .filter((b) => b?.payload?.reviewed === true).length
    } catch { return 0 }
  }

  /**
   * 自由活动日额度的**真相源**(与复核额度同一口径):当天 `care_beats` 里
   * `kind='activity'` 且 `reason='idle-done'`(真的做出了产出)的行数 ——
   * 她自己的台账、只追加、可复算。换个口径(比如另存一个计数文件)就会出现
   * "台账说做过了、闸判还能再做"这种事(`gateLine` 的教训)。
   *
   * ⚠️ 成功那笔的 `acted` **是 false**:`acted` 在本仓的语义是「这一拍她**开口**
   * 了(话上了他的手机)」—— 写一页日记没往他手机上说话,不该混进"她开口几次"
   * (care-report 的"开口 N 次"就是数 `acted=1` 的行)。成功与否由
   * `reason='idle-done'` + payload 记。
   */
  function activityUsedToday () {
    try {
      const midnight = new Date(nowMs())
      midnight.setHours(0, 0, 0, 0)
      return store.careBeatsSince(midnight.getTime() / 1000, 500)
        .filter((b) => String(b?.kind || '') === 'activity' && String(b?.reason || '') === ACTIVITY_REASONS.done)
        .length
    } catch { return 0 }
  }

  /** 闸门现状(事前声明给她看):日上限用量 + 夜闸状态。不猜、不静默。
   *  用量口径与上限闸**同一个**(`careSentCountSince`,她自己的台账)——
   *  两处用不同口径的话,她读到的是一个数、闸判的是另一个数。 */
  function gateLine () {
    const midnight = new Date(nowMs())
    midnight.setHours(0, 0, 0, 0)
    let used = 0
    try { used = Number(store.careSentCountSince(midnight.getTime() / 1000)) || 0 } catch { used = 0 }
    const night = nightHoldOn() && isNightHour(new Date(nowMs()))
    return '今天主动开口 ' + used + '/' + CARE_DAILY_CAP + ' 次;夜闸' + (night ? '正在压住(23~8 点)' : '没压住')
  }

  /** 投递:认领空闲维护相 → followup 入队。忙/失败 → false(下轮再试)。
   *  queryText(2026-09-26):这一轮该拿什么去检索记忆 —— 提醒是他下的那句话、
   *  关怀是她挑中的那件心事。以前这条注入不带 form/rawText,于是 pre-step 认不出
   *  「这也是一轮该查记忆的对话」,她主动开口时手里一点记忆都没有。 */
  async function deliver (agent, text, queryText = '', form = 'care') {
    try {
      const maintenance = agent.runMaintenance(() => {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: ECHO_SOURCE_KIND, form,
            rawText: String(queryText || '')
          }
        }))
        return Promise.resolve(true)
      })
      return Boolean(await maintenance)
    } catch {
      return false // agent 忙(维护相被占)—— 不打扰,下分钟再看
    }
  }

  /**
   * 开口目标(2026-09-29):她那**一条**会话 —— 由壳注入 `resolveCareTarget`,
   * 实现就是 `ensureCompanion()`:**先看那条会话可用不可用**(活的直接用 →
   * 存档里的 resume → 都没有就**新建**)。他 2026-09-29 的原话:
   * 「先检查一下哪个会话是可用的,如果没有可用的对话,再建立一个新的对话」。
   * 这条会话就是 DSH 直接聊 + QQ **共用**的那一条(QQ 只是多调一次工具把话
   * 说出去),所以开口落在它上面 = 上下文连贯。
   *
   * 只在**真的要开口**的那一刻解析 —— `ensureCompanion()` 在没有活会话时
   * 会建/续会话,那是副作用,不该每分钟发生。
   *
   * 拿不到 ⇒ 退回这一拍抽到的会话(resolved=false 只是标记,不改变投递纪律):
   * 「他下的命令」与「她自己的闹钟」丢不起,照样发;关怀那条**不发**并留
   * `no-target` 的账(她开口必须落在她那一条上,不然就不是同一条对话线)。
   */
  async function targetFor (agent, sid) {
    // 壳没注入解析器(离线测试、旧装机位)⇒ 这一拍自己的会话就是目标。
    // 这条兼容是**故意的**:没有解析器时不该从"能说"退化成"永远不说"。
    if (resolveTarget === null) return { agent, sessionId: String(sid || ''), resolved: true }
    try {
      const t = await resolveTarget()
      const tsid = String(t?.sessionId || '')
      if (t && t.agent !== undefined && t.agent !== null && tsid !== '') {
        return { agent: t.agent, sessionId: tsid, resolved: true }
      }
    } catch (err) {
      warn('开口目标解析失败:' + String(err?.message ?? err))
    }
    // 注入了却拿不到 ⇒ 不静默:关怀那条不开口并留 `no-target` 的账
    // (提醒/闹钟那两条丢不起,调用方退回这一拍自己发)。
    return { agent, sessionId: String(sid || ''), resolved: false }
  }

  function auditCare (toolCall, label, sessionId = '') {
    try {
      const prev = store.getState()
      store.writeAudit({
        traceId: randomUUID(),
        stage: String(toolCall || 'care'),
        step: 9,
        // v0.18.1:以前这里不写 session_id(落成 'global'),于是"这条主动话
        // 是哪个会话说的"在审计里查不出来 —— 认账条款的兜底路径要靠它认人。
        sessionId: sessionId || undefined,
        userInput: label,
        injectedMemories: '',
        llmReply: '',
        moodIntensity: prev.moodIntensity,
        prevMoodIntensity: prev.moodIntensity,
        emotionVector: prev.emotionVector ?? {},
        toolCall
      })
    } catch (err) {
      warn('care audit failed: ' + String(err?.message ?? err))
    }
  }

  // ---- v0.18.1 C5:待兑现的"她开口了"账 --------------------------------
  // A 侧纪律:**发送成功**才降权(`main.py:1836-1841`「她没说出口就不算提过」)、
  // 才安抚(`main.py:1660-1663` ×0.5 在 send 成功后)。B 侧的 `deliver` 成功
  // 只代表"这句话被排进了她这一轮",她的正文还没有、更没到他手机上 ——
  // 在这里降权会出现"她惦记的事被划掉了,而那句话从没送到"(现场体感:
  // 她被安抚了,他什么都没收到)。所以只记一条账,ack 回来才落。
  const pendingCare = []
  const CARE_PENDING_TTL_MS = 30 * 60 * 1000

  async function noteProactiveAcked (rows = []) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (String(row?.kind || '') !== 'proactive') continue
      const nowMs = Date.now()
      // 先过期清理,再找这个会话最早的一笔(她可能连着开口两次)
      while (pendingCare.length > 0 && nowMs - pendingCare[0].at > CARE_PENDING_TTL_MS) pendingCare.shift()
      const idx = pendingCare.findIndex((p) => p.sessionId === String(row.sessionId || ''))
      if (idx < 0) continue
      const p = pendingCare.splice(idx, 1)[0]
      try {
        // P2:话题候选的哨兵 0 不当成引擎议程条目(见 sent 那边的 engineAgendaId)
        if (p.agendaItemId != null && num(p.agendaItemId) > 0) await engine.agendaMark(num(p.agendaItemId))
      } catch (err) { warn('agenda mark on ack failed: ' + String(err?.message ?? err)) }
      try {
        await engine.longingCare(masterId, longingCfg())
        info('heartbeat: 关怀真的送到了(longing ×0.5 落账)')
      } catch (err) { warn('longing care on ack failed: ' + String(err?.message ?? err)) }
    }
  }

  async function tick (agent) {
    if (ticking) return
    ticking = true
    try {
      if (!isEnabled()) return
      if (engine === null || store === null) return
      const sid = String(agent?.session?.id || '')
      if (sid === '') return
      // v0.9.0 会话范围闸:范围外的会话她绝不先开口(工作会话纯 agent)。
      if (!sessionOn(sid)) return

      // ---- ① 提醒通道:他下的命令,到点必发(无想念/夜间闸门)----
      const remindFrame = await engine.threadsRemindable()
      const due = ((remindFrame && Array.isArray(remindFrame.items)) ? remindFrame.items : [])
        .filter(t => String(t.session_id || '') === sid)
      // v0.40.0 C5:他下的命令也要看一眼**是不是已经过去了**(照 Mio
      // `proactive_service.py:588-592`)。判据(两件事同时成立才算过期):
      //   ① 这桩约定已经过期超过 `staleHours` 小时(默认 24);
      //   ② 这中间**他自己说过话** —— 他要么已经处理了,要么早就不在意了。
      // 只满足 ①(他一声不吭)⇒ **照发**:她答应过的事,晚了也要说到。
      const remindStale = []
      const remindLive = []
      for (const t of due) {
        const dueAtSec = Number(t.remind_at ?? t.due_at ?? t.updated_at ?? 0) || 0
        const verdict = isRemindStale({
          dueAtSec,
          nowSec: nowMs() / 1000,
          lastUserAtSec: userSpokeAt(sid),
          staleHours
        })
        if (verdict.stale) remindStale.push({ t, verdict }); else remindLive.push(t)
      }
      for (const { t, verdict } of remindStale) {
        // 作废 = 把它标掉(否则下一拍又来问)+ 落账(否则"她没说话"就没理由)
        try { await engine.threadsMark(num(t.thread_id)) } catch { /* 标不掉下拍再说 */ }
        logBeat('remind', 'stale-drop', null, {
          acted: false,
          payload: {
            threadId: num(t.thread_id),
            lateHours: Math.round(verdict.lateSec / 360) / 10,
            why: verdict.why
          }
        })
        warn('heartbeat: 约定已过期(' + String(t.content || '').slice(0, 30)
          + ')且他中间说过话 —— 不再补说(照 C5:作废要落账)')
      }
      if (remindStale.length > 0) noteQuiet(false) // 这一拍干过活了(标掉旧约定)⇒ 退避复位
      if (remindLive.length > 0) {
        const due = remindLive
        // 2026-09-29:投到**她那一条会话**(拿不到就退回这一拍自己 —— 他下的命令丢不起)
        const rt = await targetFor(agent, sid)
        const sent = await deliver(rt.agent, renderRemindFraming(due),
          due.map(t => String(t.content || '')).join(' '), 'reminder')
        if (sent) {
          for (const t of due) await engine.threadsMark(num(t.thread_id))
          auditCare('remind', '(约定到点提醒)', rt.sessionId)
          info('heartbeat: reminded ' + due.length + ' thread(s) → ' + rt.sessionId)
        } else {
          warn('heartbeat: remind delivery busy — will retry next tick')
        }
        logBeat('remind', sent ? 'reminder-sent' : 'reminder-busy', null,
          { acted: sent, targetSessionId: rt.sessionId })
        noteQuiet(false) // 有空活/有结果 ⇒ 退避复位
        return // 提醒已发(或忙),本轮不叠关怀
      }

      // ---- ①b 她自己的闹钟(到点必看;她的决定,不是他的命令)----
      // 优先级(**写死的**,见 docs/PLAN_CORTICO_ADOPTION.md P2):
      //   电源闸/会话闸 > 夜闸 > 她的闹钟 > 想念关怀;空拍退避**只压在最后的
      //   关怀通道上**(G1:它曾经排在最前面,把到点的闹钟推迟过最多 8 分钟)。
      // 与提醒(他下的命令)的区别:闹钟**受夜闸管辖**,但**不消耗** ——
      // 夜里压住,早上第一拍放行(不会"睡一觉就没了")。
      const dueWakes = (typeof store.wakesDue === 'function')
        ? store.wakesDue(nowMs() / 1000, sid, 5)
        : []
      if (dueWakes.length > 0) {
        const w = dueWakes[0]
        if (!wakeOn()) {
          // 面板上把「她的闹钟」关掉了 ⇒ 不响,但**留账**(而且闹钟不消耗,
          // 他哪天开回来它还在)。关它是他的权利,但"关了所以没响"必须看得见。
          logBeat('wake', 'wake-off', null, { payload: { wakeId: w.id, at: w.at } })
          noteQuiet(true)
          return
        }
        if (nightHoldOn() && isNightHour(new Date(nowMs()))) {
          logBeat('wake', 'wake-night-hold', null, { payload: { wakeId: w.id, at: w.at } })
          noteQuiet(true) // 夜里没人会变 ⇒ 退避长大,别每分钟查一遍
          return
        }
        // v0.40.0 C5:**太晚了就别说了**(夜闸之后判 —— 夜里被压到早上的不算过期)。
        // 判据只有一条:晚了超过 `staleHours` 小时(默认 24)。她是"不消耗"的闹钟,
        // 插件关一天再开,那句"提醒他喝药"会在一天后冒出来 —— 那已经不是那个时刻了。
        // 作废要**明确标掉 + 落账**:不然它会一直挂在队里,每一拍都判一次。
        const wakeVerdict = isWakeStale({
          atSec: Number(w.at) || 0, nowSec: nowMs() / 1000, staleHours
        })
        if (wakeVerdict.stale) {
          try {
            store.wakeFired(w.id, nowMs() / 1000, 'stale-drop')
          } catch (err) { warn('过期闹钟落账失败(它可能再判一次): ' + String(err?.message ?? err)) }
          logBeat('wake', 'stale-drop', null, {
            acted: false,
            payload: { wakeId: w.id, lateHours: Math.round(wakeVerdict.lateSec / 360) / 10, why: wakeVerdict.why }
          })
          warn('heartbeat: 闹钟过期太久(wake ' + w.id + ',' + Math.round(wakeVerdict.lateSec / 360) / 10
            + ' 小时前就到点了)—— 不再补说(照 C5:作废要落账)')
          noteQuiet(false)
          return
        }
        // 2026-09-29:同样投到**她那一条会话**(拿不到就退回这一拍自己 —— 闹钟不消耗)
        const wt = await targetFor(agent, sid)
        const sent = await deliver(wt.agent, renderWakeFraming({ item: w, alias: aliasOf(), gateLine: gateLine() }),
          String(w.note || ''), 'wake')
        if (sent) {
          try {
            store.wakeFired(w.id, nowMs() / 1000, 'fired')
          } catch (err) { warn('闹钟落账失败(它可能再响一次): ' + String(err?.message ?? err)) }
          auditCare('wake', '(她自己的闹钟到点)', wt.sessionId)
          logBeat('wake', 'wake-sent', null, { acted: true, targetSessionId: wt.sessionId, payload: { wakeId: w.id } })
          info('heartbeat: 她自己的闹钟响了(wake ' + w.id + ' → ' + wt.sessionId + ')')
        } else {
          logBeat('wake', 'wake-busy', null, { targetSessionId: wt.sessionId, payload: { wakeId: w.id } })
          warn('heartbeat: 闹钟到点但她正忙 —— 下一拍再试(闹钟不消耗)')
        }
        noteQuiet(false)
        return
      }

      // ---- ①c 她的自由活动(P4a:空闲触发;默认关)----------------------------
      // 这一档**独立于 care 通道**:它不发送任何东西给他、不消耗开口额度、
      // 不碰 agenda/longing —— 它只让"她真做过的事"存在(写一页 + 落盘)。
      //
      // 为什么排在这里(省力闸⓪之前、关怀通道②之前):
      //   · 退避(⓪)是给"想念那条路"省力的:她安静下来时它会把判定拉开到 8 分钟,
      //     而"他安静了 30 分钟"恰恰和退避同时成立 ⇒ 排在⓪之后这一档
      //     **几乎永远不会被唤醒**(那不是关着,那是装了个假的);
      //   · 排在②之前但**不 return**:这一拍继续走完 care 通道那套一模一样的老路
      //     (`shouldCare`/`targetFor`/`daily-cap`/`pending-ack`/打分器……),于是
      //     "不干扰现有 care 逻辑"是字面成立的 —— 她做自己的事,不妨碍她想他。
      //
      // 判据是纯函数(`planActivityTick`):额度 → 防重复 → 夜闸 → 进行中的活 →
      // 空闲下界。**执行/跳过都留痕**(reason 只许枚举,见 docs/DISCIPLINE.md)。
      //
      // P4b:`kind` 是**配置里的那一类**(单值;`diary` / `memory`)。它只影响两处 ——
      // 防重复那一格的读数(今天**这一类的**产出在不在盘上)与执行体的入参;
      // 日额度是**多类型共用**的一份(见 `lib/her-activity.js` 的注释)。
      const actCfg = herActivityCfg()
      if (actCfg !== null && actCfg !== undefined && actCfg.enabled === true) {
        try {
          const actDir = String(activityDir() || '')
          const actDate = todayKey(nowMs())
          const actKind = String(actCfg.kind || 'diary')
          const plan = planActivityTick({
            nowMs: nowMs(),
            dateKey: actDate,
            cfg: actCfg,
            lastUserAtSec: userSpokeAt(sid),
            usedToday: activityUsedToday(),
            doneToday: activityFileExists(actDir, actDate, actKind),
            // "有进行中的活"的两条现成读数:她这次活动还没跑完、她上一句话
            // 还没送到他手机(未兑现账)。没有第三个数可读 —— 也不许编一个。
            busy: activityBusy === true || pendingCare.length > 0,
            // 夜闸口径与 care/wake **同一条**(`night-hold` 那个词也是同一份);
            // `quietHoursSameAsCare === false` 才不判夜里(她的笔本来就不受憋话管辖)。
            isNight: actCfg.quietHoursSameAsCare !== false && nightHoldOn() && isNightHour(new Date(nowMs()))
          })
          if (plan.action === 'run') {
            if (runActivity === null) {
              // 开了闸但执行体没接上(壳没注入)⇒ **不硬做**,留 `failed` 账。
              // 与复核那条纪律同款:接不上就说清楚,不许降级成"假装做过"。
              logBeat('activity', ACTIVITY_REASONS.failed, null, {
                acted: false,
                payload: { dateKey: actDate, kind: actKind, error: 'no-runner' }
              })
            } else {
              activityBusy = true
              let out = null
              try {
                out = await runActivity({ dateKey: actDate, dir: actDir, kind: actKind })
              } finally {
                activityBusy = false
              }
              const ok = out !== null && out !== undefined && out.ok === true
              logBeat('activity', ok ? ACTIVITY_REASONS.done : ACTIVITY_REASONS.failed, null, {
                // ⚠️ acted 一律 false:她没往他手机上说话(见 activityUsedToday 的注释)
                acted: false,
                payload: ok
                  ? {
                      dateKey: actDate,
                      kind: actKind,
                      path: String(out?.path ?? ''),
                      chars: num(out?.chars),
                      kept: num(out?.kept),
                      removed: num(out?.removed)
                    }
                  : {
                      dateKey: actDate,
                      kind: actKind,
                      path: String(out?.path ?? ''),
                      error: String(out?.error ?? 'runner-null')
                    }
              })
              if (ok) info('heartbeat: 她的自由活动做完了(' + actDate + ' · ' + actKind + ' → ' + String(out?.path ?? '') + ')')
              else warn('heartbeat: 她的自由活动没做成(' + actDate + ' · ' + actKind + ':' + String(out?.error ?? 'runner-null') + ')—— 已留痕')
            }
          } else {
            logBeat('activity', plan.reason, null, {
              acted: false,
              payload: { dateKey: actDate, kind: actKind, idleSec: plan.idleSec === null ? null : Math.round(plan.idleSec), idleMin: plan.idleMin, usedToday: plan.usedToday, budget: plan.budget }
            })
          }
        } catch (err) {
          // 这一档自己炸了也**不许**带走整拍(care 通道丢不起),但必须留痕 ——
          // 与打分器那条同科:查不出来的静默才是最坏的结果。
          warn('她的自由活动这一拍炸了(已留痕): ' + String(err?.message ?? err))
          try {
            logBeat('activity', ACTIVITY_REASONS.failed, null, { acted: false, payload: { error: String(err?.message ?? err) } })
          } catch { /* 连留痕都失败:上面那行宿主日志是最后的证据 */ }
        }
      }

      // ---- ⓪ 省力闸(**只压 ② 关怀通道**)----
      // 只留一档:**空拍退避**(没人在变,别每分钟空查)。
      //   2026-09-29 他裁定删掉另一档「他正在干活就不插话」:那条判据读的是
      //   "**抽到的那条会话**有没有在跑工具",于是她开不开口取决于竞速 ——
      //   而且他要在干活时也收得到她的话。删的是**闸**,不是数据源。
      // **位置很重要(2026-09-28 晚修的 G1)**:这一段原来排在**最前面**,
      // 于是他自己测出"她喊我有点慢" —— 到点的闹钟被退避推迟了最多 8 分钟。
      // 省力是给**关怀通道**(想念值那一路)用的;他下的命令(① 提醒)与她自己的
      // 闹钟(①b)**到点就是到点**,不该被省力策略拖住 —— 那正是"她的闹钟准不准"的全部意义。
      // 退避只由**纯安静**的拍长大(见 QUIET_REASONS);他一说话就复位。
      // 让路本身不落库(纯安静不刷屏),但状态面留得住 —— 面板要能说"她在退避,
      // 下一拍几点判",而不是像 45 小时那次一样什么都说不出来。
      if (nextPollAtMs > 0 && nowMs() < nextPollAtMs) {
        noteCare('backoff', null, { kind: 'quiet' })
        noteQuiet(true)
        return
      }

      // ---- ② 关怀通道:她的心声(想念三重闸门在引擎侧判定)----
      const cfg = longingCfg()
      await engine.longingTick(cfg) // 补差 + 抗议尖峰(60s 粒度,幂等)
      const st = await engine.longing(masterId, cfg)
      if (st === null || st.shouldCare !== true) {
        // 引擎说不该开口:阈值没过 / 冷却没到 / 夜间憋话(引擎会给 nightHold)
        const reason = st !== null && st.nightHold === true ? 'night-hold' : 'engine-says-no'
        logBeat('care', reason, st)
        noteQuiet(QUIET_REASONS.has(reason)) // 纯安静 ⇒ 退避长大
        return
      }
      // 开口目标(2026-09-29 换掉旧的"锚会话严格相等"闸)。
      // 旧写法:`if (String(st.sessionId||'') !== sid)` ⇐ 两个**独立身份**要求
      // 严格相等:她锚的会话(他最后说话的那条)必须就是这一拍 tick 到的那条。
      // 实测(2026-09-29 法医,`docs/CARE_DIAG_2026-09-29.md`):锚漂到一条
      // 已关掉的编码会话上,之后 **70 拍**全判 mismatch 丢弃,静默 20 小时。
      // 新写法:目标 = **她那一条会话**(见 `targetFor`)。抽到哪条会话不再
      // 影响正确性;拿不到那条会话就**不开口**并留 `no-target` 的账 ——
      // 她开口必须落在她那一条上,不然就不是同一条对话线。
      const t = await targetFor(agent, sid)
      if (!t.resolved) {
        logBeat('care', 'no-target', st)
        noteQuiet(false)
        return
      }
      const targetSid = t.sessionId
      // 护栏层:日上限(她自己的台账是真相源 —— 2026-09-29 前是数审计表,
      // 而那张表是全局 100 行滚动窗,会被别的会话挤掉 ⇒ 上限算不准)
      const midnight = new Date(nowMs())
      midnight.setHours(0, 0, 0, 0)
      if (store.careSentCountSince(midnight.getTime() / 1000) >= CARE_DAILY_CAP) {
        logBeat('care', 'daily-cap', st, { targetSessionId: targetSid })
        noteQuiet(false)
        return
      }
      // v0.30.1 防重复开口:她上一句关怀还没**送到他手机上**(ack 没回),
      // 不再说第二句。以前这里没有闸:on_care_sent / 冷却闸(last_care_at)
      // 都只认适配器 ack —— 适配器不在的那段时间(电脑刚醒、AstrBot 还没
      // 起,正是 2026-09-27 中午的现场),心跳每 60 秒就把同一句想念再说
      // 一遍。待兑现账(pendingCare)本来就在记这个状态,现在让它真的
      // 把门看住:同一会话的未兑现账还在(TTL 30 分钟内),这轮不开口。
      // (2026-09-29:这条按**目标会话**判 —— 开口落在哪条就按哪条记,与
      //  "这一拍抽到哪条"无关。)
      const nowMs2 = nowMs()
      while (pendingCare.length > 0 && nowMs2 - pendingCare[0].at > CARE_PENDING_TTL_MS) pendingCare.shift()
      if (pendingCare.some((p) => p.sessionId === targetSid)) {
        logBeat('care', 'pending-ack', st, { targetSessionId: targetSid })
        noteQuiet(false)
        return
      }
      // 选题:她的议程簿(效用 top-1;发送成功才降权)。
      // v0.14.4 S5:喂当前情绪向量(moody 心境 ×1.5)与她的兴趣(persona 项)。
      let vector = null
      let state = null
      try {
        state = store.getState()
        vector = state.emotionVector ?? null
      } catch { state = null; vector = null }
      // ── 2026-09-30 P2:话题打分器(**默认关**,施工图 §2.2 的插点:673 之后 / 719 之前)──
      // 插在这里的理由:`targetFor`/`daily-cap`/`pending-ack` 三道已有账,
      // 打分器只在"真的可以考虑开口"的那一瞬间才需要花力;而它**只决定说不说** ——
      // 开口仍复用下面那**一次** `deliver`(不新增开口调用点,§3.5 决定①)。
      // 关着(`enabled !== true`)时这段整段跳过 ⇒ `top = null` ⇒ **零行为变化**。
      // **过线口径 = 阈值分类型**(方案 A,用户 2026-09-30 拍板):见下面 `thresholdFor`。
      let top = null
      let reviewedFlag = false
      let reviewWhy = ''
      let poolSize = 0
      const scoring = scoringCfg()
      if (scoring?.enabled === true) {
        try {
          const pool = collectCandidates({
            db: store.db,
            store,
            now: nowMs() / 1000,
            sessionId: targetSid,
            limit: 50,
            windowHours: num(scoring.windowHours, PROACTIVE_SCORING_OFF.windowHours),
            // 来源保底(决定④):每个来源至少这么多条进池,余量按分数轮转
            floor: num(scoring.sourceFloor, PROACTIVE_SCORING_OFF.sourceFloor),
            // 2026-09-30 P4a:第四类来源(她自由活动的产出 `note:`)的读口目录。
            // 只读盘上真有的文件;没有就是这一类来源今天没有(不抛、不编)。
            activityDir: String(activityDir() || ''),
            weights: weightsOfScoring(scoring)
          })
          const threshold = num(scoring.threshold, PROACTIVE_SCORING_OFF.threshold)
          poolSize = pool.length
          // ★ 方案 A(2026-09-30 用户拍板):**逐条按它自己类型的线**筛,不是一条全局线 ——
          //   否则 0.548 的悬置话题会在粗筛这一步就先被 0.6 挡掉,"分类型"等于白分。
          //   `minScore: threshold` 仍留着当兜底(没给类型键时两处同值 = 老行为)。
          top = pickTop(pool, {
            minScoreOf: (item) => thresholdFor(item?.type, scoring),
            minScore: threshold,
            ctx: { now: nowMs() / 1000, weights: weightsOfScoring(scoring) }
          })
          // 过线之后,**边缘区复核必须用同一条线**(top 自己类型的那条);一处用一个线
          // 就会出"本地按 A 线过、复核按 B 线比"的怪账。
          const topLine = top === null ? threshold : thresholdFor(top.type, scoring)
          // 边缘区(§3.5 决定①:只有这里才值得花那一次复核;受日额度约束)
          if (top !== null) {
            const budgetLeft = Math.max(0,
              num(scoring.reviewBudgetPerDay, PROACTIVE_SCORING_OFF.reviewBudgetPerDay) - reviewUsedToday())
            const edge = needsReview(top.score, {
              reviewEnabled: scoring.reviewEnabled === true,
              threshold: topLine,
              reviewDelta: num(scoring.reviewDelta, PROACTIVE_SCORING_OFF.reviewDelta),
              reviewBudgetLeft: budgetLeft
            })
            if (edge) {
              if (reviewOf === null) {
                // 没接上复核 ⇒ **不开口**(不许降级成"硬说")。归因 review。
                logBeat('care', 'no-topic-after-review', st, {
                  targetSessionId: targetSid, candidates: pool.length, topScore: top.score,
                  rejectedBy: 'review', topicId: String(top.id || ''),
                  payload: { why: top.why, review: 'no-run' }
                })
                noteQuiet(false)
                return
              }
              const verdict = await reviewOf({
                candidate: top,
                // 复核只吃**摘要**:状态行的话头(不给全文,§3.5)
                context: String(state?.currentTopic || '').slice(0, 200),
                // 同一条线:复核比较用的就是 top 自己类型的那条(方案 A)
                threshold: topLine,
                score: top.score
              })
              if (verdict?.ok !== true || verdict.speak !== true) {
                logBeat('care', 'no-topic-after-review', st, {
                  targetSessionId: targetSid, candidates: pool.length, topScore: top.score,
                  rejectedBy: 'review', topicId: String(top.id || ''),
                  payload: { why: top.why, reviewed: true, reviewWhy: String(verdict?.why ?? '') }
                })
                noteQuiet(false)
                return
              }
              reviewedFlag = true
              reviewWhy = String(verdict?.why ?? '')
            }
          } else {
            // 本地分没过(或池子是空的)⇒ 新 reason `no-topic`,归因 local
            logBeat('care', 'no-topic', st, {
              targetSessionId: targetSid, candidates: pool.length, topScore: 0,
              rejectedBy: 'local', topicId: '',
              payload: { why: null }
            })
            noteQuiet(false)
            return
          }
        } catch (err) {
          // 打分器自己炸了 ⇒ 这一拍**不开口**,但必须留痕 —— 不许让它变成
          // 45 小时那种"查不出来"的静默。
          // 为什么不退回老路:打分器是**开口前**的一道判据,炸了就等于"这一拍
          // 不知道值不值得说" ⇒ 按它一贯的保守纪律(**拿不准就沉默**,同复核
          // 超时/失败),而不是绕过它去开一次口。默认关着时这段根本不会进。
          top = null
          reviewedFlag = false
          warn('话题打分器这一拍炸了(这一拍不开口,已留痕): ' + String(err?.message ?? err))
          logBeat('care', 'no-topic', st, {
            targetSessionId: targetSid, rejectedBy: 'local',
            payload: { error: String(err?.message ?? err) }
          })
          noteQuiet(false)
          return
        }
      }
      // 打分器判过的那条话题**取代**议程簿选题当开场(它才是这一拍算出来
      // "最值得说"的那件事);`itemId` 保持 null —— 那是引擎议程簿的 id,
      // 话题候选没有它(乱给会让"发送成功才降权"降错人)。
      const scoredTopicItem = top === null ? null : topicAgendaItem(top)
      // v0.22.0:议程簿开关(A `main.py:1818` 就是在这里设门:关掉 = 不取,
      // 选题为空,关怀照发,只是开场不再从议程簿里长出来)
      const agendaItem = scoredTopicItem ?? ((typeof getAgendaEnabled === 'function' && !getAgendaEnabled())
        ? { itemId: null, content: '' }
        : await engine.agendaPick(masterId, { vector, interests: interestsOf() }))
      // v0.18.1 C2「上次聊到」话头行:A 侧 `main.py:1797-1811` 逐字 ——
      // 先取状态行的 current_topic,若**最新反思信念更新**就换它(反思是跨轮
      // 归纳、带证据,比单轮摘要残渣接地强);没有话头时整行消失。
      let topicLine = String(state?.currentTopic || '').trim()
      try {
        const refl = (typeof store.latestReflectionSummary === 'function') ? store.latestReflectionSummary() : null
        if (refl && String(refl.summary || '').trim() !== ''
            && Number(refl.timestamp || 0) > Number(state?.updatedAt || 0)) {
          topicLine = String(refl.summary).trim()
        }
      } catch { /* 反思读不到就退回状态行的话头 */ }
      // 2026-10-09 补材料:最近 3 轮原文(对话轮那条路走的是同一个读口,engine.js:391)。
      let recentTurns = []
      try {
        recentTurns = (store && typeof store.recentTurns === 'function') ? (store.recentTurns(targetSid, 3) || []) : []
      } catch { recentTurns = [] }
      // 2026-10-09:只看不强化 —— 只发 graph_query(graphPaths),不走 retrieve。
      let pathsText = ''
      try {
        const q = (Array.isArray(recentTurns) ? recentTurns : [])
          .map((r) => String((r.userText ?? r.user_text ?? r.text ?? '')).trim())
          .filter((s) => s !== '').join(' ')
        if (q !== '' && engine && typeof engine.graphPaths === 'function') {
          const gp = await engine.graphPaths(q)
          pathsText = gp === null || gp === undefined ? '' : String(gp.pathsText || '')
        }
      } catch { pathsText = '' }
      const sent = await deliver(t.agent, renderCareFraming({
        st,
        agendaItem,
        // v0.14.5 S12 接地字段:称呼 / 人格锚点 / 她此刻的状态 / 客观时间
        alias: aliasOf(),
        anchor: anchorOf(),
        state,
        now: Date.now(),
        topicLine,
        recentTurns,
        pathsText,
        // 2026-09-30 P3:主动开口的文案规范(正四条)只在打分器开着时出现 ——
        // 关着(默认)时 framing 逐字不变(零行为变化)。
        copyRules: scoring?.enabled === true
      }), agendaItem ? String(agendaItem.content || '') : '')
      if (sent) {
        // 记待兑现账:她这一轮开口了,但**还没到他手机上** —— 降权与安抚
        // 等适配器 ack 那一刻再落(见 noteProactiveAcked)。
        // 2026-09-30 P2:话题候选的 `itemId` 是哨兵 **0**(不是引擎议程簿的 id)——
        // 必须当成"没有 agenda 条目"(不然 ack 时会拿 0 去 engine.agendaMark)。
        const engineAgendaId = (agendaItem && Number.isFinite(Number(agendaItem.itemId)) && Number(agendaItem.itemId) > 0)
          ? num(agendaItem.itemId)
          : null
        pendingCare.push({ sessionId: targetSid, agendaItemId: engineAgendaId, at: Date.now() })
        logBeat('care', 'sent', st, {
          acted: true,
          targetSessionId: targetSid,
          candidates: top === null ? 0 : poolSize,
          topScore: top === null ? 0 : top.score,
          // 复核通过并开口 ⇒ reason 仍是 sent(**不新增枚举**),由 payload.reviewed 记
          rejectedBy: '',
          topicId: top === null ? '' : String(top.id || ''),
          payload: {
            agendaItemId: engineAgendaId,
            ...(top === null ? {} : { reviewed: reviewedFlag, topScore: top.score, topicId: String(top.id || ''), why: top.why }),
            ...(reviewedFlag ? { reviewWhy } : {})
          }
        })
        noteQuiet(false)
        auditCare('care', '(想念主动关怀)', targetSid)
        info('heartbeat: she spoke first — longing ' + num(st.value) + '/' + num(st.threshold)
          + ' → ' + targetSid + '(降权/安抚等 ack 落账)')
      } else {
        logBeat('care', 'deliver-busy', st, {
          targetSessionId: targetSid,
          topScore: top === null ? 0 : top.score,
          topicId: top === null ? '' : String(top.id || '')
        })
        noteQuiet(false)
        warn('heartbeat: care delivery busy — will retry next tick')
      }
    } catch (err) {
      // 抛错也是"一拍的结果":必须留痕,否则和 45 小时那次一样查不出来。
      warn('heartbeat tick failed: ' + String(err?.message ?? err))
      logBeat('care', 'tick-error', null, { payload: { error: String(err?.message ?? err) } })
      noteQuiet(false)
    } finally {
      ticking = false
    }
  }

  return {
    tick,
    noteProactiveAcked,
    /** 他说话了(任何外部事件)⇒ 空拍退避立刻复位。壳侧 session/event 里调。 */
    noteExternalEvent,
    pendingCareCount: () => pendingCare.length,
    // v0.30.2:壳把它塞进 /api/echo/status 的 `care` —— 「她为什么没开口」
    // 从此有个当场可查的答案(reason 见 tick 里的 logBeat 调用点)。
    // v0.31.0 P2:同一个理由还会落进 `care_beats` 表(可 GROUP BY、可翻历史),
    // 这里额外带出退避与写库失败计数。
    careTrace: () => ({ ...careTrace, writeFailed })
  }
}
