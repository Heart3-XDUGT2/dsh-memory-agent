/**
 * 「她为什么没开口」的报告层(M0/A5):纯函数、**无任何 IO**
 * (唯一例外 = P3 B1 #1:`topicStopwordsOf` 现读 `lexicon.json.topicStopwords`
 *  —— 词表是口味,不是报告逻辑;空 / 坏 ⇒ 回语言默认表,行为逐位不变)
 * ============================================================
 * 为什么单开一个文件:同一份真相要喂三个地方 ——
 *   `scripts/echoq.mjs`(他把这句话敲进命令行)、
 *   `tests/care-report.test.js`(钉住报告形状),
 *   以后面板/答辩截图也可能用。
 * 规则各写一份 = 三处慢慢长歪(`lib/graph-aliases.js` 的同一条理由)。
 *
 * 由来(2026-09-28):关心链断了 45 小时,`shouldCare` 明明是 true,外面
 * 一句话看不出来 —— 理由只喊在宿主 stdout 上(宿主 stdout 他看不见)。
 * `reason` 从此**只许枚举**(`docs/DISCIPLINE.md` 第一条),而枚举的意义
 * 就是能 GROUP BY:本文件把 `care_beats` 的行翻成「合计 / 开口 / 压住的
 * 原因分布 / 最近几拍」四段人话,并给每条枚举配一句解释。
 *
 * ⚠️ 报告文案的坑:**别给没有读数的行编读数**。`value`/`threshold` 两列
 * 默认 0,`0/0` 不是「想念 0,阈值 0」,是「这一拍没有读数」。所以只有
 * 两列都 > 0 才带上数字(第一版差点把整屏写成「想念 0/0」)。
 */
// 2026-09-30 P3:他的消息只认"他真打的字"(宿主注入/插件提示词不算 —— 判据与捕获层同源)。
import { isHumanUtterance } from './inbound-filter.js'
// P3 B1 #1(2026-10-05):话题停用词的**数据读点**(`lexicon.json.topicStopwords`)。
// 数据为空 ⇒ 回本文件的语言默认表 ⇒ 与迁移前逐位一致。
import { lexiconOf, listField } from './data-tables.js'

/** 认不出的 `--since` 回落值:24 小时(与 `echoq` 的默认窗口同一口径)。 */
export const DEFAULT_SINCE_SEC = 86400

/** 安静口径:这两条是「全通过才静默」的那个静默,**不算被压住**。 */
const QUIET_REASONS = new Set(['quiet', 'idle'])

/**
 * reason → 一句人话。文案层的事,绝不许进字段(`docs/DISCIPLINE.md` 第一条)。
 * 未知理由**不许抛、不许静默返回空**:要明说它是新的,好让人回来更新这张表。
 */
const REASON_TEXT = {
  sent: '她开口了',
  'engine-says-no': '想念没过阈值',
  'night-hold': '夜闸压住(23~8点)',
  'daily-cap': '当天已开过 3 次口',
  'pending-ack': '上一句还没送到他手机',
  // 2026-09-29 前的判词(她的锚会话 ≠ 这一拍 tick 到的会话)。**已退役**:
  // 开口目标改成"她那一条会话"(`ensureCompanion`),不再要求两个身份相等。
  // 文案留着 —— 老库里的拍还得有名字,不然翻历史会读成"未知理由"。
  'session-mismatch': '心跳挂在别的会话上(旧判词,已退役)',
  // 2026-09-29:她那一条会话没解析出来(建/续都失败)⇒ **不开口**并留账。
  // 与 session-mismatch 的区别:这个是"真的没有可用的会话",那个是"有会话但对不上号"。
  'no-target': '她那一条会话没拿到(建也建不出来)',
  'deliver-busy': '她正忙,下轮再试',
  'reminder-sent': '约定提醒通道',
  'reminder-busy': '约定提醒通道',
  'wake-sent': '她自己的闹钟到点了',
  'wake-night-hold': '她的闹钟落在夜里被压住',
  'wake-busy': '闹钟到点但她忙',
  // v0.31.0 P2:面板「她主动开口(心跳)」里把「她的闹钟」关掉了(关它是他的权利,
  // 但"关了所以没响"必须看得见;闹钟**不消耗**,开回来它还在)
  'wake-off': '她的闹钟被面板关着(到点也不响)',
  // v0.31.0 P2:心跳这一拍抛错了(不许静默 —— 它正是 45 小时那次的同类)
  'tick-error': '心跳这一拍炸了(看宿主日志)',
  // v0.31.0 P2:空拍退避让路(`heartbeat.js` 的 logBeat 落账用)。它和 quiet 同科:
  // 判定过了、没有任何一步否定,只是这一拍**故意**先不问。所以别把它写成"被挡"。
  backoff: '安静(没有任何一步否定)',
  // v0.34.0 B5:他在长任务里(审计表里有工具在跑)⇒ 这一拍**故意**不插话。
  // 与 backoff 分开写:一个是"他在忙",一个是"没人在变" —— 事后翻账要能分清。
  working: '他正在干活(有工具在跑),这一拍不插话',
  // v0.40.0 C5:开口前发现 payload 已经过期(照 Mio `proactive_service.py:588-592`)——
  // 闹钟/约定晚了太久 ⇒ 那个时刻已经过去,补说反而像复读。**作废也要落账**:
  // "她没开口"和"她说过、只是没过期就不说了"是两件事,翻账要分得清。
  'stale-drop': '那件事已经过去了(过期太久,不再补说)',
  // ── 2026-09-30 P2:主动性 v2 话题打分器(施工图 §3.5 决定②)──────────────────
  // 三个判词里的两个(第三个"复核通过并开口"**不新增枚举** —— reason 仍是
  // `sent`,由 `payload.reviewed=true` 记,所以这张表里没有 pass-after-review)。
  // 归因写在同一行的 `rejected_by` 列(local = 本地分没过 / review = 复核没过)。
  'no-topic': '没有值得开口的话题(打分器没过线)',
  'no-topic-after-review': '边缘区复核没过(宁可沉默,不硬说)',
  // ── 2026-09-30 P3:主动开口禁语哨兵(HBS 六类黑模式)────────────────────
  // 判在**出站口**(那一句已经组好、正要发):命中 ⇒ 这一拍不发、不改写、不降级。
  // 它和上面两条`no-topic*`的区别:那两条是"没有值得说的事",这条是
  // **"有话说,但那种说法我们不做"** —— 翻账时要能分清("她没话题"≠"她的话被拦")。
  'copy-blocked': '这句主动话踩了 HBS 黑模式(押注式话术),这一拍不发',
  // ── 2026-09-30 P4a:她的自由活动(空闲触发那档;kind='activity')──────────────
  // ⚠️ 这一族的 `acted` **恒为 false** —— 它们不是"她开口"(没往他手机上说话),
  // 而是"她自己在干活"。所以报告里它们落在"没开口的原因"那一桶,措辞必须让
  // 读的人一眼看出"这不是被谁挡了,是她这一拍没做(或做完了)"。
  'idle-done': '她自己的自由活动做完了(产出落了盘,不是开口)',
  'budget-used': '今天的自由活动额度用完了',
  'already-done': '今天已经做过这件事了(不重复做)',
  busy: '她手上有没干完的活(这一拍不做)',
  'not-idle': '离他上一句话太近(这一拍不自己找活干)',
  failed: '她自己的活动没做成(已留痕,没抛)',
  quiet: '安静(没有任何一步否定)',
  idle: '安静(没有任何一步否定)'
}

/** 未知 reason 的原话(测试钉它;别改口径,改了等于把「新理由」藏起来)。 */
export const UNKNOWN_REASON_TEXT = '未知理由(新加的?要更新这张表)'

/** 解析 `--since`:认 24h/7d/90m/30s、ISO 串、纯数字(epoch 秒);认不出回落默认。 */
export function parseSince (text, nowSec = Date.now() / 1000) {
  const now = toSec(nowSec)
  const raw = String(text ?? '').trim()
  const fallback = { since: now - DEFAULT_SINCE_SEC, fallback: true, why: '空或认不出的输入' }
  if (raw === '') return fallback
  // 相对窗口:数字 + 单位。允许中间有空格、单位大写(`24 H`),别为这点小事拒绝他。
  const rel = /^([0-9]+(?:\.[0-9]+)?)\s*([smhd])$/i.exec(raw)
  if (rel !== null) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[rel[2].toLowerCase()]
    return { since: now - Number(rel[1]) * unit, fallback: false, why: '' }
  }
  // 纯数字 = epoch 秒(不是「N 秒前」—— 两种读法会差出一个世纪,必须只认一种)
  if (/^[0-9]+$/.test(raw)) return { since: Number(raw), fallback: false, why: '' }
  // ISO 串(`2026-09-28T20:11:00Z` / `2026-09-28 20:11`)交给 Date,能解析就用
  const ms = Date.parse(raw)
  if (!Number.isNaN(ms)) return { since: ms / 1000, fallback: false, why: '' }
  return fallback
}

/** 按理由聚合。排序:count 降序,同 count 按 reason 字典序(报告要可复现)。
 *
 *  2026-09-30 P3:`extra`(可选)是**三列只读指标**的取数口 —— 只有调用方真的
 *  给了 `turns`(他的消息)/ `topics`(话题正文)时才附上 `metrics`;
 *  不给就**逐字**还是今天那个形状(老调用点一个字不用改,echoq --json 也不变)。
 */
export function summarizeBeats (rows, extra = {}) {
  const list = Array.isArray(rows) ? rows : []
  const acc = new Map()
  let firstAt = null
  let lastAt = null
  let acted = 0
  for (const row of list) {
    if (row === null || typeof row !== 'object') continue
    const reason = String(row.reason ?? '')
    const at = num(row.at)
    const did = num(row.acted) === 1 ? 1 : 0
    if (did === 1) acted += 1
    if (firstAt === null || at < firstAt) firstAt = at
    if (lastAt === null || at > lastAt) lastAt = at
    const slot = acc.get(reason) ?? { reason, count: 0, firstAt: at, lastAt: at, acted: 0 }
    slot.count += 1
    slot.acted += did
    if (at < slot.firstAt) slot.firstAt = at
    if (at > slot.lastAt) slot.lastAt = at
    acc.set(reason, slot)
  }
  const sum = {
    total: list.length,
    byReason: [...acc.values()].sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)),
    firstAt,
    lastAt,
    acted
  }
  const hasExtra = extra !== null && typeof extra === 'object'
    && (extra.turns !== undefined || extra.topics !== undefined)
  if (hasExtra) {
    sum.metrics = computeMetrics({
      rows: list,
      turns: extra.turns,
      topics: extra.topics,
      now: extra.now,
      windowSec: extra.windowSec,
      anySession: extra.anySession
    })
  }
  return sum
}

/** reason → 人话。未知理由明说未知,不抛、不装懂。 */
export function describeReason (reason) {
  const key = String(reason ?? '').trim()
  return REASON_TEXT[key] ?? UNKNOWN_REASON_TEXT
}

/**
 * 渲染人读报告。
 * @param {{rows?: Array, since?: number, now?: number,
 *          turns?: Array, topics?: Array, windowSec?: number, anySession?: boolean}} opts
 *   since/now 是 epoch 秒(与 `care_beats.at` 同一把尺),毫秒会被自动纠正。
 *   `turns`(他的消息)/ `topics`(话题正文)给了 ⇒ 末尾多一段**只读指标**
 *   (回复率 / 追问率 / 回访数);不给 ⇒ 报告逐字还是老样子。
 */
export function renderBeats (opts = {}) {
  const rows = Array.isArray(opts.rows) ? opts.rows : []
  const now = toSec(opts.now ?? Date.now() / 1000)
  const since = toSec(opts.since ?? now - DEFAULT_SINCE_SEC)
  const sum = summarizeBeats(rows, opts)
  const L = []

  L.push('Echo 关心账 · 最近 ' + windowLabel(now - since) + '(' + fmtTime(since, 'minute') + ' → ' + fmtTime(now, 'minute') + ')')
  if (sum.total === 0) {
    // 「一拍都没有」= 心跳根本没跑。这是最坏的一种,绝不许写成「一切正常」。
    L.push('  合计 0 拍:这段时间**一拍都没有** —— 那才是真的坏(心跳没跑)')
    L.push('  结论:这段时间一拍都没有 —— 那才是真的坏(心跳没跑)。查心跳开关与 care_beats 的写入。')
    return L.join('\n')
  }

  const quiet = rows.filter((r) => r !== null && typeof r === 'object' && QUIET_REASONS.has(String(r.reason ?? ''))).length
  const blocked = sum.total - sum.acted - quiet
  // ⚠️ 措辞纪律(2026-09-28 自查):这一桶里既有"被闸挡住"(日上限/夜闸/待兑现),
  // 也有"根本没到开口的时候"(engine-says-no) —— 统称「被压住」是**夸大**:
  // 它会让读报告的人以为"系统不让她说话"。所以只说"没开口",卡点逐个列在下头。
  L.push('  合计 ' + sum.total + ' 拍:' + (sum.acted > 0 ? '开口 ' + sum.acted + ' 次' : '没开口')
    + (blocked > 0 ? ',其余 ' + blocked + ' 拍没开口' : (quiet > 0 ? ',其余 ' + quiet + ' 拍安静通过' : '')))

  if (sum.acted > 0) {
    // 「开口」= 真做了事的那几条(acted=1),**不只 sent** —— 约定提醒、她自己的
    // 闹钟同样是开口。所以每一类都要列出来:上面报几个数,下面就得对得上,
    // 否则「开口 2 次」底下只有 sent ×1,人会以为报告算错了(第一版就这么写的)。
    L.push('  ─ 开口 ' + sum.acted + ' 次:')
    const actedReasons = sum.byReason.filter((g) => g.acted > 0)
    const aw = widthOf(actedReasons.map((g) => g.reason))
    for (const g of actedReasons) {
      // 只出现过一次时 firstAt === lastAt —— 别把同一个时刻打印两遍(第一版
      // 打出来是「(13:02、13:02)」,看着像坏了)。
      const span = g.firstAt === g.lastAt
        ? fmtTime(g.firstAt, 'minute')
        : fmtTime(g.firstAt, 'minute') + '、' + fmtTime(g.lastAt, 'minute')
      L.push('      ' + pad(g.reason, aw) + ' ×' + g.acted + '(' + span + ')  ' + describeReason(g.reason))
    }
  } else {
    L.push('  ─ 开口 0 次')
  }

  // 没开口 = 没做成 + 不是静默通过。同一类理由既有做成又有没做成时(罕见),
  // 这里只列没做成的那部分 —— 数字必须和上面那行对得上。
  const blockedCount = (g) => g.count - g.acted
  const blockedReasons = sum.byReason.filter((g) => !QUIET_REASONS.has(g.reason) && blockedCount(g) > 0)
  if (blockedReasons.length > 0) {
    L.push('  ─ 没开口的原因(按次数):')
    const w = widthOf(blockedReasons.map((g) => g.reason))
    for (const g of blockedReasons) L.push('      ' + pad(g.reason, w) + ' ×' + blockedCount(g) + '  ' + describeReason(g.reason))
  }

  // 2026-09-30 P3:三列只读指标(只在调用方喂了 turns/topics 时出现)。
  // 数字后面**必须**带着判据与局限 —— 启发式的东西装成精确读数才是不诚实。
  if (sum.metrics !== undefined) {
    const m = sum.metrics
    L.push('  ─ 指标(只读;他的消息取 conversation_log):')
    const rr = m.reply_rate ?? {}
    L.push('      reply_rate  她开口 ' + fmtCount(rr.total) + ' 次,他回了 ' + fmtCount(rr.replied)
      + ' 次' + (Number.isFinite(rr.rate) ? '(回复率 ' + Math.round(rr.rate * 100) + '%)' : '(算不出比率)')
      + (rr.medianSec === null || rr.medianSec === undefined ? '' : ',中位 ' + humanSec(rr.medianSec)))
    const fu = m.follow_up ?? {}
    L.push('      follow_up   他回了 ' + fmtCount(fu.replied) + ' 次,其中反问 ' + fmtCount(fu.asked)
      + ' 次' + (Number.isFinite(fu.rate) ? '(追问率 ' + Math.round(fu.rate * 100) + '%)' : '(算不出比率)')
      + '  [启发式:' + String(fu.heuristic ?? '—') + ']')
    const rv = m.revisit ?? {}
    L.push('      revisit     她带话题开口 ' + fmtCount(rv.topics) + ' 个,后来他主动提起 ' + fmtCount(rv.revisited)
      + ' 个' + (Number.isFinite(rv.rate) ? '(回访率 ' + Math.round(rv.rate * 100) + '%)' : '(算不出比率)')
      + '  [启发式:' + String(rv.heuristic ?? '—') + ']')
    for (const [label, part] of [['reply_rate', rr], ['follow_up', fu], ['revisit', rv]]) {
      if (String(part?.why ?? '') !== '') L.push('      (' + label + ':' + String(part.why) + ')')
    }
    // ⚠️ 数据局限写进报告本体(不然读的人会把"没数据"读成"她不受待见")
    L.push('      (局限:conversation_log 是 100 行滚动窗 ⇒ 很久以前的拍找不到回复;沉默 ≠ 没看见)')
  }

  const recent = rows.slice(-5)
  if (recent.length > 0) {
    L.push('  ─ 最近 ' + recent.length + ' 拍:')
    const w = widthOf(recent.map((r) => String(r?.reason ?? '')))
    for (const r of recent) L.push('      ' + fmtTime(num(r?.at), 'second') + '  ' + pad(String(r?.reason ?? ''), w) + '  ' + describeReason(r?.reason) + readingOf(r))
  }

  L.push('  结论:' + conclusion(sum, blocked))
  return L.join('\n')
}

// ── 2026-09-30 P3:三列只读指标(reply_rate / follow_up / revisit)────────────
//
// 出处:概念稿 §3「指标三列(评价'想听下去'的可操作代理)」。它们回答的是**同一个
// 问题**:她开口之后,那件事有没有真的接上?
//
// 四条纪律:
//   ① **只读计算,不落库、不加列、不迁移** —— 数据全从现有行里算(`care_beats`
//      × `conversation_log`),取数由调用方喂进来(`turns` / `topics`)。
//   ② **纯函数,不抛**:没有数据 / 边界(她开口后他没回 / 同一话题多次 / 跨会话)
//      一律安全返回 null/0 + 一句说明(`why`),绝不让报告挂掉。
//   ③ **启发式要写明**(`follow_up` / `revisit` 那两条的判据是猜的,不是读心):
//      `heuristic` 字段里写着判据本身,报告上也印一版。
//   ④ 报告形状:`summarizeBeats(rows, { turns, topics })` 的结果就是
//      **仪表盘能拿到的那份 JSON**(`metrics` 挂在同一个对象上);`renderBeats`
//      把同一份东西印成人话。没喂 turns/topics 时**逐字**还是老形状。
//
// 取数(调用方一行,不用自己拼字段 —— `normTurns` 认的就是这个形状):
//   · `turns`  = `store.listConversations({ limit: 100 })`(全局滚动 100 轮)
//              或 `SELECT session_id, user_text, created_at FROM conversation_log`;
//   · `rows`   = `store.careBeatsSince(since, 200)`(她开口那几拍);
//   · `topics` = 话题正文:`pending_threads.content` / `episodic_memory.summary` /
//              `diary.content` 按 `topic_id` 的前缀(`thread:` / `mem:` / `diary:`)
//              对齐成 `[{id, text}]`。
//
// ⚠️ 已知的数据局限(如实写,不装):
//   · **被哨兵拦下的那一拍不算开口**(2026-09-30 P3.1):`sent` 与 `copy-blocked`
//     同拍时,她其实没说出去 ⇒ 该拍从 reply_rate / follow_up 的分母里踢掉
//     (`sentBeatsOf` 里那一步),不然"她说了却没发"会被算成一次有效开口;
//   · `conversation_log` 是**全局 100 行滚动窗**(`store.js:1694-1699`),
//     所以很久以前的拍**永远找不到**他的回复 —— 指标天然偏向"最近这段";
//   · 他的消息只认**他真打的字**(`isHumanUtterance`:宿主注入 / 插件提示词 / 子代理
//     通告一律不算);分不出来的一律不算"他回了我";
//   · 没有"他读了"的信号,只有"他说了话" —— 沉默 ≠ 没看见。

/** 回复窗口默认 24 小时:比"沉默 3 天后的回复"更接近"他回了她那一句"。 */
export const DEFAULT_REPLY_WINDOW_SEC = 24 * 3600

/** 疑问判据(`follow_up` 的启发式):疑问标点 + 常见疑问词。 */
const QUESTION_MARK = /[?？]|吗|呢|怎么|为什么|为啥|哪|什么|是不是|能不能|要不要|有没有|几点|多少|多久|好不好/

/** 高频虚词/时间词 —— 从"话题关键词"里剔掉,免得人人命中(反例:"今天")。
 *  ★ P3 B1 #1(2026-10-05):这张表是**语言默认兜底**(中文虚词,不是个人数据)。
 *  `<数据目录>/lexicon.json` 的 `topicStopwords` 填了 ⇒ **以数据为准**(整表覆盖);
 *  空 / 缺字段 / 坏文件 ⇒ 回这张表。读点见 `topicStopwordsOf()`。 */
const TOPIC_STOPWORDS = new Set([
  '今天', '明天', '昨天', '后天', '以后', '以前', '现在', '最近', '时候', '一个', '我们', '他们',
  '用户', '什么', '自己', '因为', '所以', '然后', '可以', '已经', '还是', '这个', '那个', '就是',
  '不是', '有点', '真的', '感觉', '知道', '觉得', '应该', '需要', '如果', '但是', '而且', '还有',
  '或者', '一起', '一下', '一直', '可能', '大概', '一直', '关于', '对于', '之后', '之前', '正在'
])

/**
 * 当前生效的话题停用词:`lexicon.json.topicStopwords` 有值 ⇒ 用它,否则回**语言默认表**。
 *
 * 每次现读(P3「数据与程序分离」的读点纪律:`lib/data-tables.js` 只读、不缓存、
 * 缺 / 坏 / 空一律当"没填"且**永不抛**)⇒ 面板改了下一份报告就生效。
 * @param {Record<string,string|undefined>} [env] 显式环境(测试 / 多实例用;不传 = 真实环境)
 */
export function topicStopwordsOf (env) {
  const words = listField(lexiconOf(env), 'topicStopwords')
  return (words !== null && words.length > 0) ? new Set(words) : TOPIC_STOPWORDS
}

const listOf = (v) => (Array.isArray(v) ? v : [])

/** 他的消息归一:[{sessionId, text, at}],时间升序,认不出/不是人话的丢掉。 */
function normTurns (turns) {
  const out = []
  for (const t of listOf(turns)) {
    if (t === null || typeof t !== 'object') continue
    const at = num(t.at ?? t.createdAt ?? t.created_at)
    const text = String(t.userText ?? t.text ?? t.user_text ?? '').trim()
    const sessionId = String(t.sessionId ?? t.session_id ?? '')
    if (at <= 0 || text === '') continue
    // 宿主注入 / 插件提示词 / 子代理通告**不是他打的话**(判据与捕获层同一份)
    if (isHumanUtterance(text) !== true) continue
    out.push({ at, text, sessionId })
  }
  return out.sort((a, b) => a.at - b.at)
}

/**
 * 「同一拍」的容差:`sent` 与 `copy-blocked` 是同一次心跳里前后脚写的两笔,
 * `care_beats.at` 只差毫秒(P3.1 的配对要用)。
 */
export const SAME_BEAT_SEC = 5

/**
 * 「她真的开口」的拍(`acted=1` 且 `reason='sent'`),带会上话与会话归属。
 *
 * 2026-09-30 P3.1(**修污染**):被哨兵拦下的那一笔(`copy-blocked`)与她"开口"
 * 是**同一拍** —— 她其实**没说出去**(理由只是没送到他手机上)。所以配对时把
 * "紧随其后、同一拍里还有一笔 `copy-blocked`"的 `sent` 拍**踢出分母**,否则
 * "她说了却没发"会被当成一次有效开口,把 reply_rate / follow_up 的分母灌水。
 */
function sentBeatsOf (rows) {
  const list = listOf(rows).filter((r) => r !== null && typeof r === 'object')
  const blockedAts = list
    .filter((r) => String(r.reason ?? '') === 'copy-blocked')
    .map((r) => num(r.at))
    .filter((at) => at > 0)
  const sameBeatBlocked = (at) => blockedAts.some((b) => b >= at && b - at <= SAME_BEAT_SEC)
  return list
    .filter((r) => num(r.acted) === 1 && String(r.reason ?? '') === 'sent'
      && num(r.at) > 0 && !sameBeatBlocked(num(r.at)))
    .map((r) => ({
      at: num(r.at),
      // 开口落在 target_session_id(她那一条);session_id 是"她锚在哪条" ——
      // 两个都认(施工图给的判据就是这两个),空串不算。
      sessionIds: [String(r.targetSessionId ?? ''), String(r.sessionId ?? '')].filter((s) => s !== ''),
      topicId: String(r.topicId ?? '')
    }))
    .sort((a, b) => a.at - b.at)
}

/** 她开口之后他的第一条消息。同会话优先(默认);`anySession` 时可跨会话。 */
function firstUserAfter (list, beat, { windowSec = DEFAULT_REPLY_WINDOW_SEC, anySession = false } = {}) {
  const cap = num(windowSec) > 0 ? num(windowSec) : DEFAULT_REPLY_WINDOW_SEC
  for (const t of list) {
    if (t.at <= beat.at || t.at - beat.at > cap) continue
    if (anySession || beat.sessionIds.length === 0) return t
    if (beat.sessionIds.includes(t.sessionId)) return t
  }
  return null
}

function median (nums) {
  const s = nums.slice().sort((a, b) => a - b)
  if (s.length === 0) return null
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/**
 * `reply_rate`:她开口后**他多久回**。
 * 数据来源 = `care_beats`(`acted=1` & `reason='sent'` 的 `at` + 该 `session_id`/
 * `target_session_id`)× 他的消息(实库 = `conversation_log` 的
 * `session_id` / `user_text` / `created_at`)。
 * @returns {{total:number, replied:number, rate:number|null, medianSec:number|null, why:string}}
 */
export function replyRate (rows, turns, { windowSec = DEFAULT_REPLY_WINDOW_SEC, anySession = false } = {}) {
  const beats = sentBeatsOf(rows)
  if (beats.length === 0) {
    return { total: 0, replied: 0, rate: null, medianSec: null, windowSec, why: '这段时间没有「她开口」的拍(acted=1 且 reason=sent)' }
  }
  const list = normTurns(turns)
  if (list.length === 0) {
    return { total: beats.length, replied: 0, rate: null, medianSec: null, windowSec, why: '没有可用的他的消息(取数没喂 turns,或这库还没有他真打的字)' }
  }
  const deltas = []
  for (const b of beats) {
    const hit = firstUserAfter(list, b, { windowSec, anySession })
    if (hit !== null) deltas.push(hit.at - b.at)
  }
  const replied = deltas.length
  return {
    total: beats.length,
    replied,
    rate: replied / beats.length,
    medianSec: median(deltas),
    windowSec,
    anySession: anySession === true,
    why: replied === 0
      ? '她开口过 ' + beats.length + ' 次,但 ' + (anySession === true ? '' : '同一会话里 ') + '没找到他之后的回复(窗口 ' + Math.round(windowSec / 360) / 10 + ' 小时)'
      : ''
  }
}

/**
 * `follow_up`:他回了之后**是不是反问**。
 * ⚠️ **启发式**:只看有没有疑问标点/疑问词(`QUESTION_MARK`),不判语义 ——
 * 「在吗?」算反问,「行,那我知道了呢」也会被算进来(它带"呢")。宁可粗,不许假装精确。
 */
export function followUp (rows, turns, { windowSec = DEFAULT_REPLY_WINDOW_SEC, anySession = false } = {}) {
  const beats = sentBeatsOf(rows)
  const list = normTurns(turns)
  if (beats.length === 0) {
    return { total: 0, replied: 0, asked: 0, rate: null, heuristic: '疑问标点或疑问词', why: '这段时间没有「她开口」的拍' }
  }
  if (list.length === 0) {
    return { total: beats.length, replied: 0, asked: 0, rate: null, heuristic: '疑问标点或疑问词', why: '没有可用的他的消息' }
  }
  let replied = 0
  let asked = 0
  for (const b of beats) {
    const hit = firstUserAfter(list, b, { windowSec, anySession })
    if (hit === null) continue
    replied += 1
    if (QUESTION_MARK.test(hit.text)) asked += 1
  }
  return {
    total: beats.length,
    replied,
    asked,
    rate: replied === 0 ? null : asked / replied,
    heuristic: '疑问标点或疑问词',
    why: replied === 0 ? '她开口的那几拍里,他一条都没回(分母为 0)' : ''
  }
}

/**
 * 话题关键词(**启发式**):切出中文/字母数字串,整串长度 2~4 就当一个词;
 * 更长的串再补它的**二字片段**(「用户坐今晚10点的火车回家」⇒ 出「火车」这种)。
 * 剔掉高频虚词。判据粗,但**同一个话题的同一批词**前后一致 —— 可比。
 */
export function topicKeywords (text, { max = 12, env } = {}) {
  const body = String(text ?? '')
  const runs = body.match(/[\u4e00-\u9fa5A-Za-z0-9]+/g) ?? []
  const out = []
  // 停用词表一次读定(整份报告同一份口径),不再每个词读一次盘。
  const stop = topicStopwordsOf(env)
  const push = (w) => {
    const s = String(w ?? '').trim()
    if (s.length < 2 || stop.has(s) || out.includes(s)) return
    out.push(s)
  }
  for (const run of runs) {
    if (run.length <= 4) { push(run); continue }
    for (let i = 0; i + 1 < run.length; i += 1) push(run.slice(i, i + 2))
  }
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : 12
  return out.slice(0, cap)
}

/**
 * `revisit`:她提过的**话题**(`care_beats.topic_id`,P2 已加列)后来**被他主动提起**
 * (话题关键词在**他的**输入里命中)。
 * ⚠️ **启发式**:① 关键词是切出来的,不是语义;② "同一话题多次"只算**一次**
 * (取最早的拍);③ 话题正文要靠调用方喂 `topics:[{id,text}]`(topic_id 只是一个
 * 键 —— `thread:19` / `mem:7` / `diary:2026-09-30`,正文分别在 `pending_threads.content`
 * / `episodic_memory.summary` / `diary.content` 里),喂不到正文的话题算"没数据"。
 */
export function revisit (rows, turns, topics, { windowSec = 0, anySession = false } = {}) {
  const withTopic = sentBeatsOf(rows).filter((b) => b.topicId !== '')
  if (withTopic.length === 0) {
    return { topics: 0, revisited: 0, rate: null, details: [], heuristic: '话题关键词命中他的输入', why: '账上没有带话题的开口(topic_id 全空 —— 老拍/打分器关着时就是这样)' }
  }
  const textById = new Map()
  for (const t of listOf(topics)) {
    if (t === null || typeof t !== 'object') continue
    const id = String(t.id ?? t.topicId ?? t.topic_id ?? '')
    const text = String(t.text ?? t.content ?? t.summary ?? '')
    if (id !== '' && text.trim() !== '') textById.set(id, text)
  }
  const list = normTurns(turns)
  // 同一话题多次:只算最早那一拍(后来再提同一件事不重复计分)
  const firstBeatByTopic = new Map()
  for (const b of withTopic) if (!firstBeatByTopic.has(b.topicId)) firstBeatByTopic.set(b.topicId, b)
  const details = []
  let revisited = 0
  let noText = 0
  for (const [topicId, beat] of firstBeatByTopic) {
    const topicText = textById.get(topicId) ?? ''
    if (topicText === '') { noText += 1; details.push({ topicId, revisited: false, why: '没有话题正文(调用方没喂 topics)' }); continue }
    const keys = topicKeywords(topicText)
    let hitText = ''
    let hitAt = 0
    for (const t of list) {
      if (t.at <= beat.at) continue
      const cap = num(windowSec) > 0 ? num(windowSec) : Infinity
      if (t.at - beat.at > cap) break
      if (!anySession && beat.sessionIds.length > 0 && !beat.sessionIds.includes(t.sessionId)) continue
      const k = keys.find((w) => t.text.includes(w))
      if (k !== undefined) { hitText = k; hitAt = t.at; break }
    }
    if (hitText !== '') revisited += 1
    details.push({ topicId, revisited: hitText !== '', keyword: hitText, at: hitAt })
  }
  const total = firstBeatByTopic.size
  return {
    topics: total,
    revisited,
    rate: total === 0 ? null : revisited / total,
    details,
    heuristic: '话题关键词命中他的输入',
    why: list.length === 0
      ? '没有可用的他的消息'
      : (noText > 0 ? noText + ' 个话题没有正文(调用方没喂 topics)' : '')
  }
}

/**
 * 三列一起算 —— **仪表盘/报告**拿这一个就够(`summarizeBeats(rows, {turns,topics})`
 * 会把它挂在 `metrics` 上)。内部逐个包 try:任何一列自己炸了都不许带倒整份报告。
 */
export function computeMetrics ({ rows, turns, topics, now = null, windowSec = DEFAULT_REPLY_WINDOW_SEC, anySession = false } = {}) {
  const safe = (fn, label) => {
    try { return fn() } catch (err) {
      return { error: String(err?.message ?? err), why: label + ' 这一列算不动了(已隔离,别的列照常)' }
    }
  }
  const opts = { windowSec, anySession }
  return {
    reply_rate: safe(() => replyRate(rows, turns, opts), 'reply_rate'),
    follow_up: safe(() => followUp(rows, turns, opts), 'follow_up'),
    revisit: safe(() => revisit(rows, turns, topics, { windowSec: 0, anySession }), 'revisit'),
    now: toSec(now ?? Date.now() / 1000)
  }
}

// ── 小工具(不导出:给上面三个函数当手和脚) ─────────────────────────

/** 毫秒还是秒?`care_beats.at` 是秒,但手输的时间戳常是 `Date.now()`(毫秒)。 */
function toSec (v) {
  const n = num(v)
  return n > 1e11 ? n / 1000 : n
}

function num (v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 本地钟面(Asia/Shanghai)。她要能一眼认出「08:12 那次是早上」,所以不用 UTC。 */
function fmtTime (sec, precision = 'minute') {
  const d = new Date(toSec(sec) * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return precision === 'minute' ? mm + '-' + dd + ' ' + hh + ':' + mi : mm + '-' + dd + ' ' + hh + ':' + mi + ':' + String(d.getSeconds()).padStart(2, '0')
}

/** 窗口长度的中文说法:整数单位才用 d/h,否则落到分钟。 */
function windowLabel (sec) {
  const s = num(sec)
  if (s >= 86400 && s % 86400 === 0) return (s / 86400) + ' 天'
  if (s >= 3600 && s % 3600 === 0) return (s / 3600) + ' 小时'
  return Math.max(1, Math.round(s / 60)) + ' 分钟'
}

/** 中文逐字宽度(不用 Intl,免得两个运行时的宽度表不一样把报告对歪)。 */
function charWidth (ch) {
  const c = ch.codePointAt(0)
  if ((c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) || (c >= 0xAC00 && c <= 0xD7A3)
    || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFF00 && c <= 0xFF60) || (c >= 0x1F300 && c <= 0x1FAFF)) return 2
  return 1
}

function textWidth (s) {
  let w = 0
  for (const ch of String(s ?? '')) w += charWidth(ch)
  return w
}

function pad (s, width) {
  const str = String(s ?? '')
  return str + ' '.repeat(Math.max(0, width - textWidth(str)))
}

/** 对齐用宽度:取最长那条,并封顶 —— 免得某个超长 reason 把整屏推出去。 */
function widthOf (labels) {
  return Math.min(16, Math.max(6, ...labels.map((l) => textWidth(String(l ?? '')))))
}

/** 只有真有读数(两列都 > 0)才带数字。0/0 是「没读数」,不是「想念 0」。 */
function readingOf (row) {
  if (row === null || typeof row !== 'object') return ''
  const v = num(row.value)
  const th = num(row.threshold)
  if (v > 0 && th > 0) return '  想念 ' + trimNum(v) + '/' + trimNum(th)
  return ''
}

/** 6.30 → 6.3,6.00 → 6(读起来像人写的数字)。 */
function trimNum (v) {
  return String(Math.round(num(v) * 10) / 10)
}

/** 计数当人话:没有数据(null/undefined)时印「—」,别印 NaN。 */
function fmtCount (v) {
  const n = Number(v)
  return Number.isFinite(n) ? String(Math.max(0, Math.round(n))) : '—'
}

/** 秒数当人话(指标里的"他多久回":分钟以内说秒,其余说分钟)。 */
function humanSec (v) {
  const s = Math.max(0, Math.round(num(v)))
  if (s < 90) return s + ' 秒'
  const m = Math.round(s / 60)
  return m < 90 ? m + ' 分钟' : (Math.round(m / 6) / 10) + ' 小时'
}

/** 结论行。有开口 ≠ 一切正常:拍数少 / 最近很久没开口都要点出来。 */
function conclusion (sum, blocked) {
  const last = sum.byReason.find((g) => g.reason === 'sent')
  const tail = last === undefined || last.acted === 0 ? '' : '(最近一次 ' + fmtTime(last.lastAt, 'minute') + ')'
  if (sum.acted > 0) {
    return blocked === 0
      ? '她开口过 ' + sum.acted + ' 次' + tail + ',而且每一步都查得到。'
      : '她开口过 ' + sum.acted + ' 次' + tail + ',其余 ' + blocked + ' 拍各有各的卡点,每一步都查得到。'
  }
  // 「每拍都被压住」是夸大(engine-says-no 那类根本没人压她)—— 说"卡点"。
  return '这段时间她一次都没开口(共 ' + sum.total + ' 拍)—— 拍在跑,但每拍都有卡点;逐条对着上面的原因看。'
}
