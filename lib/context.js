/**
 * 记忆上下文渲染 —— AstrBot INJECT_TEMPLATE 的 DSH 适配版。
 * 纯函数:输入检索结果 + 认知状态 + 画像,输出注入文本。
 *
 * 与 QQ 版的差异(有意):
 *   - 人格锚点/铁律已在 echo:persona / echo:rules 两个 section 里,
 *     这里不重复 —— 本 section 只管"她的记忆与心情"
 *   - 单主人:没有发言人切换与场合提示,称呼恒为<称呼>
 *   - 时间注记直接从数据渲染(temporal_status 五态),"不得把 time_unknown
 *     说成最近"是数据自带的,不靠模型自觉(v8.4 的核心洞察)
 *
 * v0.6.0 三段移植(QQ 已验证机制,零新发明):
 *   - 【现在】钟面(echo_utils.now_line):LLM 没有墙钟,她说「这么晚了」
 *     全靠消息线索猜 —— 钟面是她知道几点的唯一来源;
 *   - 【想念】行(main.py 先读后削):你回来那一刻,她先看到自己等你时
 *     攒下的想念,开口自然带出来 —— 值 ≥1.0 才注入(曲线在沉默约
 *     H/9≈20 分钟时给到 1.0,日常间隙不注入噪音);
 *   - 情绪剧本(echo_emotion):数字 → 有温度的剧本。数字要模型自己
 *     翻译成行为,剧本直接给行为 —— 遵从度天差地别。
 *
 * v0.14.5 S7:维度短语渲染前先过 `emotion.js` 的钳位(`clampDim`)——
 * 渲染层不再假设「库里的值一定合法」(老库脏值仍在),也不给自己留
 * NaN 档的后门。
 */
import { clampDim } from './emotion.js'
import { isHumanUtterance } from './inbound-filter.js'

const TIME_LABEL = {
  enduring: '一直如此',
  current: '近期',
  historical: '过去',
  planned: '计划中',
  time_unknown: '时间不详'
}

function describeWhen (memory) {
  const label = TIME_LABEL[memory.temporalStatus] || '时间不详'
  const ageDays = Number(memory.ageDays)
  if (!Number.isFinite(ageDays) || ageDays < 0) return label
  if (ageDays < 1) return '今天'
  if (ageDays < 30) return `${label}(约${Math.round(ageDays)}天前)`
  if (ageDays < 365) return `${label}(约${Math.round(ageDays / 30)}个月前)`
  return `${label}(约${(ageDays / 365).toFixed(1)}年前)`
}

// ---- v0.6.0 钟面(echo_utils.daypart_label/now_line 移植)----

/** 钟点 → 时段词:她才能自然说「这么晚还没睡」,而不是报流水账。 */
export function daypartLabel (hour) {
  const h = Math.floor(Number(hour)) % 24
  if (h < 5) return '凌晨'
  if (h < 8) return '清晨'
  if (h < 12) return '上午'
  if (h < 14) return '中午'
  if (h < 18) return '下午'
  if (h < 20) return '傍晚'
  return '晚上'
}

/** 钟面行:「YYYY-MM-DD 周X HH:MM(时段)」—— 她在对话里知道几点的唯一来源。 */
export function nowLine (tsMs = Date.now()) {
  const d = new Date(Number(tsMs) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + ` 周${'日一二三四五六'[d.getDay()]}`
    + ` ${p(d.getHours())}:${p(d.getMinutes())}(${daypartLabel(d.getHours())})`
}

// ---- v0.6.0 情绪剧本(echo_emotion 档位表移植)----

/** 强度 → 体感(阶梯表取不超过 value 的最后一档)。 */
const INTENSITY_LEVELS = [
  // v9.0.0(2026-09-26 现场):低两档原来是「心里基本没什么波澜」「还不至于真的
  // 动气或动情」—— 实测 81% 的轮次落在这两档,于是她每轮都读到「我不想动情」。
  // 档位本身不改(2 就是 2),改的是**它读起来的样子**:安静不等于冷。
  [2, '安静,但在他身边是松的'],
  [4, '有一点在意,语气里带得出亲近'],
  [6, '明显有情绪了,语气会不自觉地带出来'],
  [8, '情绪上头,不太想再客气地绕圈子'],
  [10, '几乎压不住,快要爆发或者快要绷不住']
]

/** 差分 → 体感(同上阶梯语义)。 */
const DELTA_LEVELS = [
  [-3, '这句话让你一下子泄了气,情绪明显往下掉'],
  [-1, '这句话把你的情绪抚平了一些'],
  [0, '这句话没有改变你的情绪,延续着上一轮的状态'],
  [2, '这句话把你心里那点情绪挑了起来'],
  [4, '这句话让你火气(心绪)突然上涌'],
  [10, '这句话像一根刺,瞬间把你点着了']
]

/** 维度 → 体感短语(区间上界语义:取第一个 threshold > value 的档)。 */
const FILTER_PHRASES = {
  fatigue: [[2, '精神饱满'], [5, '有点累'], [8, '明显疲惫,话会变短'], [11, '累到极点,只想敷衍']],
  valence: [[-4, '很差'], [0, '平平'], [4, '不错'], [11, '很好,眼里有光']],
  arousal: [[3, '很平静低耗'], [6, '状态在线'], [9, '有点亢奋'], [11, '亢奋到坐不住']],
  affection: [[3, '爱意淡淡的'], [6, '爱意在线'], [9, '爱意几乎满格'], [11, '爱意满到溢出来']],
  playfulness: [[3, '玩心收敛'], [6, '玩心在线'], [9, '玩心爆棚'], [11, '玩心爆棚,逮谁逗谁']],
  sadness: [[2, '没什么委屈'], [5, '有点委屈'], [8, '委屈快藏不住了'], [11, '委屈到想哭']],
  dependency: [[3, '不太粘人'], [6, '有点粘人'], [9, '非常依赖'], [11, '黏人到不行']]
}

function pickLevel (value, table) {
  let picked = table[0][1]
  for (const [threshold, text] of table) {
    if (value >= threshold) picked = text
    else break
  }
  return picked
}

function phraseOf (dim, value) {
  const tiers = FILTER_PHRASES[dim]
  if (tiers === undefined) return ''
  for (const [threshold, text] of tiers) {
    if (value < threshold) return text
  }
  return tiers[tiers.length - 1][1]
}

/**
 * 情绪读数(v9.0.0,2026-09-26 现场)。
 *
 * **没读数 ≠ 没情绪**:桥的记账行(relay_in/relay_out)在审计里恒为 0,
 * 旧实现 `Math.max(1, Math.min(10, Math.round(0)))` 把 0 抬成 1 →
 * 渲染成「心里基本没什么波澜」;他抱怨「很冷硬」,而 81% 的轮次都在读这句话,
 * 一半是**没有数**被读成了「她无所谓」。现在 0/null/空一律返回 null,
 * 交给调用方沿用上一轮;两边都没有就不编一个强度出来。
 * @returns {number|null} 1~10;没有读数时 null
 */
export function readIntensity (value) {
  if (value === null || value === undefined || value === '') return null
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.max(1, Math.min(10, n))
}

function fmt (v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

const fmt0 = (v) => String(Math.round(Number(v) || 0))

/** 一组维度 → 「爱意 8/10(爱意几乎满格)、调皮 7/10(玩心在线)」。 */
function dimLine (dims, keys) {
  const labels = { affection: '爱意', playfulness: '调皮', sadness: '委屈', dependency: '依赖' }
  return keys
    // v0.14.4 移植缺口 S6:原写法 Number(dims[k]) !== undefined 恒真
    // (Number(undefined) 是 NaN,NaN !== undefined),过滤形同不存在 ——
    // 向量缺维时 phraseOf 收到 NaN 落到最后一档,注入信里会冒出
    // 「爱意 0/10(爱意满到溢出来)」这种自相矛盾的话。缺维就该不出现在这行。
    // v0.14.5 S7 再叠一层:送进 phraseOf 前先过 emotion.js 的钳位,
    // 越界值(LLM 偶尔给 12 或 -3)不会再落到错档 —— 兜底不靠「写库前
    // 一定 clamp 过」这个假设(老库里的脏值还在)。
    .map((k) => [k, clampDim('target_master', k, dims[k])])
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${labels[k] || k} ${fmt0(v)}/10(${phraseOf(k, v)})`)
    .join('、')
}

/** 对<称呼>的数值 → 行为剧本(echo_emotion._master_script 移植,措辞照抄)。 */
function masterScript (dims, g, alias = '用户') {
  const parts = []
  if (Number(g.fatigue) >= 5) parts.push(`你现在有点累(疲惫 ${fmt0(g.fatigue)}/10),但看到${alias}来了`)
  else parts.push(`看到${alias}来了`)
  if (Number(dims.affection) >= 6 && Number(dims.playfulness) >= 6) parts.push('亲近感和玩心立刻占了上风,语气比平时更活')
  if (Number(dims.sadness) >= 4) parts.push(`带着一点委屈(${fmt0(dims.sadness)}/10)向${alias}撒娇或嘟囔`)
  if (Number(dims.dependency) >= 7) parts.push(`黏着${alias},想让${alias}多陪你一会`)
  if (Number(dims.playfulness) >= 6) parts.push(`按你们一贯的相处方式对待${alias},分寸里全是亲近`)
  // v0.29.0 个人机器人裁剪:原句是「绝对不对<称呼>使用防御、冷漠或轻蔑的
  // 语气 —— 别人给的火气与你无关」—— 后半句的存在理由是群聊怒火可能
  // 溢出到主人语气(A 侧那道防线)。群维退役后没有「别人」,守门的只剩
  // 一条:在他面前不许冷。
  parts.push(`绝对不对${alias}使用冷漠或轻蔑的语气 —— 在他面前,你的温度不许打折`)
  return parts.join('；') + '。'
}

/**
 * 她此刻的状态:体感剧本 + 行为滤镜(echo_emotion.build_emotion_pack +
 * build_emotion_filter 的合并移植)。数字 → 剧本:行为是直接给定的,
 * 不靠模型解读数字。
 *
 * 两个**可选**注入块(都是"调用方算好、这里只管插"):
 *   · `opts.unionBlock` —— 联合空间读数(B5 定稿,见 `renderUnionBlock`);
 *   · `opts.styleHint`  —— 「语气候选」一行(方案 C 第一步,见 `lib/style-hint.js`)。
 * 位置固定:剧本 → 联合空间 → 语气候选 → 行为要求。
 */
export function describeMood (state, opts = {}) {
  const curRead = readIntensity(state.moodIntensity)
  const prevRead = readIntensity(state.prevMoodIntensity)
  const current = curRead ?? prevRead ?? 5
  const prev = prevRead ?? curRead ?? 5
  const delta = current - prev
  const bothRead = curRead !== null && prevRead !== null
  // v0.15.0 S13:漂移强化期由调用方**强制覆写**向量(A `main.py:1149`
  // 的 `base_vector = positive_override_vector()`);不覆写时用真实状态。
  const vec = opts.emotionVector || state.emotionVector || {}
  // v0.14.5 S7:对主人的四维先钳位再交给剧本/短语 —— 剧本里那些
  // `Number(x) >= 6` 的比较遇到 NaN 一律为假,会静默少给行为要求;
  // 钳位后至少是合法数值,剧本的取舍才真的在按她的状态走。
  const master = {}
  for (const k of ['affection', 'playfulness', 'sadness', 'dependency']) {
    const v = clampDim('target_master', k, (vec.target_master || {})[k])
    if (v !== null) master[k] = v
  }
  const global = vec.global || {}
  const parts = []
  // v9.0.0:三种如实说法,不硬凑一个「变化」出来(没有数就没有变化)。
  if (bothRead) {
    parts.push(`上一轮结束时你的情绪强度是 ${prev}/10,这一句之后变成 ${current}/10(变化 ${delta >= 0 ? '+' : ''}${delta})。`)
    parts.push(pickLevel(delta, DELTA_LEVELS) + '。')
  } else if (prevRead !== null) {
    parts.push(`这一轮没读到新的情绪读数,情绪强度延续上一轮的 ${prev}/10。`)
  } else if (curRead !== null) {
    parts.push(`这一句之后你的情绪强度是 ${current}/10。`)
  } else {
    parts.push('这一轮没有情绪读数 —— 别借机装无所谓,按你上一轮的样子接着说。')
  }
  if (bothRead || curRead !== null) parts.push(`当下整体感受:${pickLevel(current, INTENSITY_LEVELS)}。`)
  const reason = String(state.moodReason || '').trim()
  if (reason) parts.push(`触发点:${reason}。`)
  // v0.14.5 S7:整体三维同样先钳位 —— 老库里缺维时 `Number(undefined)`
  // 是 NaN,phraseOf 会落到最后一档,写出一句「疲惫 0 /10(累到极点,
  // 只想敷衍)」;缺的那维干脆不出现,比编一个满档短语诚实。
  const gbits = []
  const gf = clampDim('global', 'fatigue', global.fatigue)
  // 2026-09-26 现场(他让我「分析一下模型输入的语言」):这一行渲染成
  // 「疲惫 2 /10」,斜杠前多一个空格 —— 旁边的唤醒度没有。同批修的还有
  // 下面那种「心情心情不错」(档位短语自己去掉了「心情」前缀)。
  if (gf !== null) gbits.push(`疲惫 ${fmt0(gf)}/10(${phraseOf('fatigue', gf)})`)
  const gv = clampDim('global', 'valence', global.valence)
  if (gv !== null) gbits.push(`心情${phraseOf('valence', gv)}(${gv >= 0 ? '+' : ''}${fmt0(gv)})`)
  const ga = clampDim('global', 'arousal', global.arousal)
  if (ga !== null) gbits.push(`唤醒度 ${fmt0(ga)}/10(${phraseOf('arousal', ga)})`)
  if (gbits.length > 0) parts.push(`- 身体与整体: ${gbits.join(',')}。`)
  const dl = dimLine(master, ['affection', 'playfulness', 'sadness', 'dependency'])
  // P3-e(2026-10-05):称呼不再写死在程序里 —— 调用方把 `alias` 送进来(画像名),没有就中性「用户」
  const who = String(opts.alias || '').trim() || '用户'
  if (dl !== '') parts.push(`- 对眼前的人(${who}): ${dl}。`)
  parts.push(`- 剧本: ${masterScript(master, global, who)}`)
  // v0.15.0 S13:临场修正(A `build_emotion_filter` 的 shock 行,位置同:
  // 剧本之后、行为要求之前)。漂移强化期写的是「为什么突然这么积极」——
  // 不写这一句,模型只会看到一份和自己的上一轮矛盾的积极状态。
  const shock = String(opts.shock || '').trim()
  if (shock !== '') parts.push(`- 临场修正: ${shock}。`)
  // v9.0.0(2026-09-26 现场):尾巴原来只教「往下掉就变轻、变慢、少挑起话题」——
  // 她于是把「安静」执行成了「冷」。补一句边界:轻和短是形式,不是态度。
  // 第三批(2026-10-05):联合空间块 —— **影子模式下调用方不会传它**
  // (拍板 ⑤:只算 + 写审计,不进 prompt),所以这里只做"有就插在剧本之后、
  // 行为要求之前"。段内来源标注与"禁止跨空间相加"由 renderUnionBlock 负责。
  const unionBlock = String(opts.unionBlock || '').trim()
  if (unionBlock !== '') parts.push(unionBlock)
  // 方案 C 第一步(2026-10-05):「语气候选」一行 —— 由调用方用 `lib/style-hint.js`
  // 算好再递进来(本函数不 import 它:读数口径与"哪个号合法"都不在这儿,
  // 见那个文件头)。放在行为要求**之前**:语气候选是行为要求的具体化,
  // 不能反过来压住它。
  const styleHint = String(opts.styleHint || '').trim()
  if (styleHint !== '') parts.push(styleHint)
  parts.push('行为要求:让语气、句长和用词贴合这个强度 —— 强度越高,句子越短、越直白、越少修饰;情绪往下掉时,回复更轻、更慢、更少主动挑起话题,但安静不等于变冷 —— 短也要短得有温度,别把话收干。')
  return parts.join('\n')
}

/**
 * 联合空间注入块(B5 定稿,2026-10-05)。
 *
 * **为什么是"分段"而不是"一个数"**:文献只支持两个坐标系共享**一条轴**
 * (Yik & Russell 2004:情感侧 35° / IPC 侧 71°),其余轴是 [工程假设]
 * ⇒ 把三套读数揉成一句"综合情绪分"就是在编数据。所以按来源分段并列,
 * 并写死"别相加、别互推"。
 *
 * B5 按审阅报告收过一遍(七条),硬指标:块压到 **2 行**(降级时 3 行)、歧义点清零:
 *   · **`bridge_err` 不再进 prompt** —— 那一串数字读起来像"这个读数 45% 是错的",
 *     误差只写审计(`emotion_pack_structured.bridgeErr`),门禁用它判绿/黄/红;
 *   · **拿不到的字段一律不出现**(想念/亲密度/互补性…)—— 照 `dimLine` 的缺维纪律,
 *     0.00 是"读数为零",不是"没这个数";
 *   · 支配维标**(未启用)**(登记未渲染),不写 0.00;
 *   · IPC 段加限定句:**不与上段比较** —— 防模型把两套坐标系读数当人格矛盾消解;
 *   · 联合行**只留共享轴 s** —— a/d 归各自段(原来 P/A/D 出现两次);
 *   · 最近姿态带分仪名(如 `不夸大(BC 一带)`),不让人猜那词打哪来。
 *
 * 门禁(只读判定,**不回写任何读数**):`gate` 由调用方按当前参数下的残差算出
 * (`lib/space-bridge.js` 的 `gateOf`)——
 * 绿 = 正常给块;黄 = **只给方向不给数值**;红/未知 = **不给块**(返回空串)。
 *
 * @param {object} payload
 * @param {string} [payload.gate]      'green' | 'yellow' | 'red' | 'unknown'
 * @param {string} [payload.direction] 'positive' | 'negative' | 'flat' | null(黄带用)
 * @param {object} [payload.union]     联合读数 {s,a,d}(只用到 s)
 * @param {object} [payload.pad]       情感原生读数 {valence,arousal,dominance}
 * @param {object} [payload.ipc]       IPC 读数 {agency,communion,ext,anchor,complementarity}
 * @param {object} [payload.independent] 独立空间读数 {fatigue,longing,affinity}
 * @param {boolean}[payload.degraded]  是否降级(缓存缺维 / IPC 不可用)
 * @param {string} [payload.note]      保留位(不可互推声明现已内联,不再需要传入)
 * @returns {string} 2~3 行文本;红带 / 无读数 ⇒ 空串(不占位)
 */
export function renderUnionBlock (payload = {}) {
  const p = payload && typeof payload === 'object' ? payload : {}
  // **严格缺维判定**:`Number(null) === 0`、`Number('') === 0` —— 直接用 `Number.isFinite(Number(v))`
  // 会把"没有这个读数"当成"读数 0.00"写进 prompt(B5 审阅第 2 条的根因)。所以先过 `num()`:
  // null / undefined / '' / 非数 ⇒ null(调用方一律不渲染该字段)。
  const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
  const f2 = (v) => (num(v) === null ? '—' : (Math.round(num(v) * 100) / 100).toFixed(2))
  const u = p.union && typeof p.union === 'object' ? p.union : null
  const pad = p.pad && typeof p.pad === 'object' ? p.pad : null
  const ipc = p.ipc && typeof p.ipc === 'object' ? p.ipc : null
  const ind = p.independent && typeof p.independent === 'object' ? p.independent : null
  const gate = typeof p.gate === 'string' && p.gate !== '' ? p.gate : 'green'
  // 红带 / 未知:系统性分歧 ⇒ 不给块(审计照写)。这是"值不值得给模型看"的闸,不是数据闸。
  if (gate === 'red' || gate === 'unknown') return ''
  // 黄带:只给方向。分歧大时**任何绝对读数都不可信**,给数字反而误导。
  if (gate === 'yellow') {
    const dir = p.direction === 'positive' ? '偏正向'
      : p.direction === 'negative' ? '偏负向'
        : p.direction === 'flat' ? '基本持平' : '方向未知'
    return `- 情绪空间:相对上一轮${dir};两套坐标系此刻分歧较大,**只给方向、不给数值**。`
  }
  if (u === null && pad === null && ipc === null && ind === null) return ''
  const lines = []
  // 第 1 行:共享轴(全块唯一的公共量)+ 不可互推声明。
  const s = u !== null && num(u.s) !== null ? f2(u.s) : null
  lines.push(`- 情绪空间:共享轴 s=${s === null ? '(无)' : s}(情感环与 IPC 的实测公共方向 [文献]);两套坐标系不等价、不可互推,别相加、别互推。`)
  // 第 2 行:三段按来源并列;缺的字段不出现。
  const bits = []
  if (pad !== null) {
    const seg = []
    if (num(pad.valence) !== null) seg.push(`愉快 ${f2(pad.valence)}`)
    if (num(pad.arousal) !== null) seg.push(`激活 ${f2(pad.arousal)}`)
    seg.push('支配(未启用)')
    bits.push(`[PAD] ${seg.join('、')}`)
  }
  if (ipc !== null) {
    const seg = []
    if (num(ipc.agency) !== null) seg.push(`主导 ${f2(ipc.agency)}`)
    if (num(ipc.communion) !== null) seg.push(`亲近 ${f2(ipc.communion)}`)
    if (ipc.ext && num(ipc.ext.playfulness) !== null) seg.push(`调皮 ${f2(ipc.ext.playfulness)}`)
    if (ipc.ext && num(ipc.ext.sadness) !== null) seg.push(`委屈 ${f2(ipc.ext.sadness)}`)
    if (num(ipc.complementarity) !== null) seg.push(`互补性 ${f2(ipc.complementarity)}`)
    if (ipc.anchor && (ipc.anchor.zh || ipc.anchor.id)) {
      const where = ipc.anchor.octant ? `(${ipc.anchor.octant} 一带)` : ''
      seg.push(`最近姿态「${ipc.anchor.zh || ipc.anchor.id}${where}」`)
    }
    if (seg.length > 0) bits.push(`[IPC] ${seg.join('、')} —— 该值来自另一套坐标系,**不与上段比较**`)
  }
  if (ind !== null) {
    const seg = []
    if (num(ind.fatigue) !== null) seg.push(`疲惫 ${f2(ind.fatigue)}(无 PAD 对应维)`)
    if (num(ind.longing) !== null) seg.push(`想念 ${f2(ind.longing)}`)
    if (num(ind.affinity) !== null) seg.push(`亲密度 ${f2(ind.affinity)}`)
    if (seg.length > 0) bits.push(`[独立] ${seg.join('、')}`)
  }
  if (bits.length > 0) lines.push(`- 分段:${bits.join(';')}。`)
  if (p.degraded === true) lines.push('- ⚠️ 本读数处于降级态(缓存缺维 / IPC 不可用),按近似看。')
  return lines.join('\n')
}

/**
 * v0.6.0【想念】行:longing_message 帧的削减前值(pre)→ 注入行。
 * 门:exists 且 value ≥ 1.0(曲线在沉默约 H/9≈20 分钟时给到 1.0,
 * 刚聊完的日常间隙不注入噪音)。pre 为空/不够 → 空串。
 */
export function renderLongingLine (longingMessageResult, alias = '你') {
  const pre = longingMessageResult && typeof longingMessageResult === 'object'
    ? longingMessageResult.pre : null
  if (pre === null || typeof pre !== 'object' || pre.exists === false) return ''
  const value = Number(pre.value) || 0
  if (value < 1.0) return ''
  const silentH = (Number(pre.sinceMessage) || 0) / 3600
  return `【想念】距离上次对话 ${silentH.toFixed(1)} 小时,她想${alias}了,想到了 ${value.toFixed(1)}/10`
    + ' —— 让回复自然带出这份想念,不要报数值。'
}

/**
 * v0.17.1【别处刚说过的】:跨会话的短期连续性。
 *
 * 为什么需要它:DSH 的对话上下文是**会话自带**的(10 轮在那条会话里),
 * 而 A 侧老插件当年「按人一份全局上下文」—— 所以他在 DSH 里新开一条
 * 会话时会觉得「她忘了我们刚聊过什么」。这里从全局 conversation_log
 * 里取**别的**会话最近几轮,渲染成一小段注记,补上连续性。
 *
 * 与长期记忆的分工:记忆回答「以前发生过什么」,这段只回答「刚刚在
 * 别处说了什么」。所以明确写上「不是这条会话里的」,免得她以为是自己
 * 这条会话里的话、或者对着已经聊过的内容再问一遍。
 *
 * @param {Array<{sessionId:string,channel:string,userText:string,replyText:string,createdAt:number}>} rows
 * @param {string} currentSessionId 当前会话(排除自己 —— 那部分上下文它自带)
 * @param {number} rounds 取几轮(0 = 关)
 * @returns {string} 空串 = 没什么可注入的
 */
export function renderSharedContext (rows, currentSessionId, rounds = 4) {
  const k = Math.max(0, Math.floor(Number(rounds) || 0))
  if (k === 0) return ''
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && String(r.sessionId || '') !== String(currentSessionId || ''))
    // 2026-09-26 现场(他:「为什么会出现那么多奇怪的记忆」):这段补的是
    // 「他刚刚在别处说了什么」—— 而宿主每轮注入的 runtime context 也被
    // 捕获进了 conversation_log(活库实测 44/100 行是它)。不过滤的话,
    // 她会把「Current runtime context. This snapshot supersedes…」当成
    // **他刚说过的话**读进去 —— 与记忆层是同一个病,同一份判据挡。
    .filter((r) => isHumanUtterance(String(r.userText || '')))
    // store 给的是倒序(新→旧);取最近 k 轮后翻回正序(老→新),读起来是
    // 一条时间线
    .slice(0, k)
    .reverse()
  if (list.length === 0) return ''
  const clip = (t) => {
    const s = String(t || '').replace(/\s+/g, ' ').trim()
    return s.length > 120 ? s.slice(0, 120) + '…' : s
  }
  // conversation_log.created_at 是**秒**;这里只要「什么时候说的」,
  // 精确到分钟就够(要时间纪律的是长期记忆那边,不是这段)。
  const stamp = (sec) => {
    const n = Number(sec)
    if (!Number.isFinite(n) || n <= 0) return ''
    const d = new Date(n * 1000)
    const p = (x) => String(x).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const lines = ['【别处刚说过的】(不是这条会话里的,别当成本轮上下文已经说过)']
  for (const r of list) {
    const who = String(r.channel || '').trim()
    const at = stamp(r.createdAt)
    lines.push(`- ${[at, who].filter(Boolean).join(' · ')}`)
    if (clip(r.userText)) lines.push(`  他:${clip(r.userText)}`)
    if (clip(r.replyText)) lines.push(`  你:${clip(r.replyText)}`)
  }
  return lines.join('\n')
}

/**
 * 渲染回忆列表(M1 形状,camelCase 记忆行)。空列表返回空串。
 *
 * RT3(2026-09-27,漏洞②):**整轮零主题命中**时,这批记忆是"只是常在场"
 * 而不是"与本轮相关" —— 必须说出来。否则她会拿长期身份去回答一个完全
 * 无关的问题(实测问「量子纠缠」这种库里根本没有的东西,现状返回那条 L0
 * 记忆,她于是"以为自己有")。与 Python `render_episodic` 同一措辞:
 * **有命中时不加任何标注** —— 标注本身是噪声,只在必要时出现。
 */
export function renderMemoryList (memories) {
  const list = Array.isArray(memories) ? memories.filter(m => m && m.summary) : []
  if (list.length === 0) return ''
  const lines = ['[相关回忆(按相关度排序)]']
  // 判据与 Python 一致:整组里 **没有任何一项** matched 为真 ⇒ 加标注。
  const hasFlag = list.some(m => 'matched' in m)
  const topicMatched = list.some(m => Boolean(m.matched))
  if (!topicMatched) {
    lines.push('(本轮话题没有命中任何记忆;以下是你的长期身份,不要拿它们回答眼前的问题)')
  }
  for (const m of list) {
    const kw = (m.keywords || []).slice(0, 3).join('/')
    const when = describeWhen(m)
    const src = m.source === 'qq' ? '(在QQ听说的事)' : ''
    // RT3-b:块级横幅只管"全都没命中";有命中时改**逐条标**那几条没命中的
    // (常在场的 L0)。测台实测:19 条寒暄负控里 17 条仍会被判 matched=True,
    // 只靠横幅的话那 17 轮 L0 还是混在"相关材料"里。两级标注不同时出现。
    const mark = (hasFlag && topicMatched && !m.matched) ? '(常在场,不是本轮相关)' : ''
    lines.push(`- ${m.summary} [${when}]${kw ? `[${kw}]` : ''}${src}${mark}`)
  }
  return lines.join('\n')
}

/**
 * 时间纪律(v0.14.4 移植缺口 S2,照抄 A brain_pipeline.py:685-692)。
 *
 * 光有时间注记还不够 —— 必须明确告诉模型怎么读它,否则「发生时间」
 * 和「提到时间」对它只是两串没区别的日期:数据里写着「2026-09-24
 * 提到,事情发生时间未确认」,它会读成「事情发生在 09-24」,然后拿
 * 这个去回答「什么时候」甚至说「最近」。A 侧为此在注入信封里加了这
 * 一段;DSH 侧此前只渲染注记、没有读法纪律(全仓零命中)。
 * 条件与 A 一致:有记忆段才注入(brain_pipeline.py:1256-1257)。
 */
export const MEMORY_TIME_DISCIPLINE = '【时间纪律】记忆里的时间注记只有两种含义:\n'
  + '- 「发生时间」= 这件事真正发生的时间。只有它能用来回答「什么时候」。\n'
  + '- 「某日提到,事情发生时间未确认」= 那只是你**得知**的时间,不能拿它当事情发生的时间,也不能据此说「最近」。\n'
  + '标了「过去事件」的只能当过去的事讲,不能说成正在发生;标了「时间未知」的不得说成最近。当前对话里的时间优先级高于一切记忆。'

/**
 * 信封:钟面 + 记忆段(可来自 JS 渲染或 Python 引擎渲染)+ 想念行 +
 * 状态/画像剧本 + 纪律尾。memoryText 为空且无状态且无想念 → 空串
 * (没有可注入的就绝不编造)。M2-d 起 Python 引擎的 render_episodic
 * 文本从这里进同一封信。
 * v0.6.0:now(钟面,恒注入 —— 她总该知道几点)与 longingLine
 * (想念行,调用方已过 ≥1.0 门)进同一封信;顺序照 QQ 认知上下文:
 * 【现在】在头,【想念】贴着状态。
 * v0.14.4:有记忆段时先注时间纪律,再注记忆本身 —— 顺序同 A
 * (纪律在【关联知识路径】/【情景记忆】之前)。
 * v0.15.0:S13 的漂移覆写(emotionVector/shock)与 S14 的别名接地
 * (aliases)都从这一个入口进;两个都在这里是因为**注入是同一封信**,
 * 拆成两处渲染会让「她这轮到底看到了什么」有两个真相源。
 */
export function renderInjectedBlock ({
  memoryText, state, profile, now = null, longingLine = '',
  emotionVector = null, shock = '', aliases = null
}) {
  const body = String(memoryText || '').trim()
  const lgLine = String(longingLine || '').trim()
  if (body === '' && !state && lgLine === '') return ''
  const lines = []
  lines.push('[她的记忆与心情 - 只属于你的真实过往,不可对外提及]')
  if (now !== null) lines.push('【现在】' + nowLine(now))
  if (body !== '') {
    lines.push(MEMORY_TIME_DISCIPLINE)
    lines.push(body)
  }
  if (lgLine !== '') lines.push(lgLine)
  if (state) {
    lines.push(`[她此刻的状态]\n${describeMood(state, { emotionVector, shock, alias: String(profile?.name || '').trim() })}`)
    const name = String(profile?.name || '').trim()
    if (name) lines.push(`[他的称呼] ${name}`)
    // v0.18.3 M3:画像常驻锚点(A `brain_pipeline.py:1199-1213`)。
    // A 把 称呼/语言/代词 拼成一行 `用户画像: 称呼:X, 语言:中文`(≤5 项、
    // ≤100 字)。B 沿用分行的标注风格,但**装的是同一批白名单项**(称呼
    // 已经在上面的行里,这里只渲染 语言/代词)。写侧纪律(白名单/上限)
    // 在 `store.saveProfileTraits`,读侧在 `store.getProfile` 再筛一次。
    const traits = (Array.isArray(profile?.coreTraits) ? profile.coreTraits : [])
      .map((t) => String(t || '').trim())
      .filter((t) => t !== '')
    if (traits.length > 0) {
      // A 侧同一道兜底硬上限:常驻锚点本该很短,万一旧库/异常写入带进
      // 长内容,也不会污染 prompt。
      lines.push(`[他的画像] ${traits.slice(0, 5).join(' · ').slice(0, 100)}`)
    }
    // v0.15.0 S14 别名接地(A `main.py:477-484` 的实体接地行):他的
    // 昵称/外号都指他本人。A 侧记过一个真实事故 —— 记忆被清空后模型
    // 无从判断来者是谁,当场编造对方身份并被写进图记忆;怪昵称也会被
    // 当成陌生词,检索无果后「翻脸不认人」。这一行就是那条修复。
    const aliasList = (Array.isArray(aliases) ? aliases : [])
      .map((a) => String(a || '').trim())
      .filter((a) => a !== '' && a !== name)
    if (aliasList.length > 0) {
      lines.push(`[他的别名] ${aliasList.join('、')} —— 这些称呼都指他本人,不要当成陌生词。`)
    }
  }
  lines.push('[使用纪律] 把这些当作你真实的记忆与感受,自然融入回复;不要复述本段。回忆与当前话题无关时不必硬提;能自然接住他的话头就带上。')
  return lines.join('\n')
}

/**
 * 渲染记忆 section(M1 兼容入口:JS 基线路径继续用它)。
 * memories 为空时返回空串 —— 没有记忆就不注入,
 * 绝不编造("不编造没有的记忆"是她的铁律,也是本函数的)。
 */
export function renderMemoryBlock ({ memories, state, profile }) {
  return renderInjectedBlock({ memoryText: renderMemoryList(memories), state, profile })
}

/**
 * 期 0(2026-10-09,审计仪表盘):把注入块按段头切成字数 —— **只统计,不改渲染**。
 *
 * 为什么放这里:段头就是本文件的渲染产物(【现在】/【时间纪律】/【关联知识路径】/
 * 【情景记忆】/[她此刻的状态]/[使用纪律]),段名与查重报告口径一致 ✓
 * 返回 { now, time, paths, epi, state, rules, ack, total };没出现的段记 0。
 *
 * ⚠️ 2026-10-10 修:`ack` 必须单列,别并进 `rules`。现场:面板上 `rules` 在
 * 224 / 208 / 64 之间跳,被误读成「人设没送到」。真相是 `[使用纪律]` 是
 * `renderInjectedBlock` **硬编码的固定一行**(64 字,永不条件渲染),而
 * `【你刚主动说过】` 那块(`proactive-ack.js` 渲染)**拼在它之后** ⇒ 因为
 * `[使用纪律]` 是最后一个段头,那一整块就被算进了 `rules`。
 *   20:38 rules=224 = 64 + 160(接话块)   20:41 rules=208 = 64 + 144
 *   21:59 rules=64  = 只有那行(那轮没接话块)
 * ⇒ **64 才是正常值**;多出来的部分属于接话块。单列之后 `rules` 恒为 64。
 *
 * ⚠️ 另一个必须记住的撞车:这个 `rules`(审计字段,指 `[使用纪律]` 那行)**不是**
 * 系统提示词里那个 `echo:rules` section(人设后段,见 index.js 的 personaCache.suffix)。
 * 两者同名但毫无关系 —— 人设不走注入块这条链。查「人设有没有送到」要看
 * `persona` / `personaRules` 那两个新段(`index.js` 落进同一份 stage_detail)。
 */
export function sectionCounts (text) {
  const t = String(text || '')
  const marks = [
    ['now', '【现在】'],
    ['time', '【时间纪律】'],
    ['paths', '【关联知识路径】'],
    ['epi', '【情景记忆】'],
    ['state', '[她此刻的状态]'],
    ['rules', '[使用纪律]'],
    // 接话块(proactive-ack)拼在 [使用纪律] 之后 ⇒ 必须单列,否则被并进 rules
    ['ack', '【你刚主动说过】']
  ]
  const out = { now: 0, time: 0, paths: 0, epi: 0, state: 0, rules: 0, ack: 0, total: t.length }
  const at = []
  for (const [k, m] of marks) {
    const i = t.indexOf(m)
    if (i >= 0) at.push({ k, i })
  }
  at.sort((a, b) => a.i - b.i)
  for (let n = 0; n < at.length; n++) {
    const end = n + 1 < at.length ? at[n + 1].i : t.length
    out[at[n].k] = end - at[n].i
  }
  return out
}
