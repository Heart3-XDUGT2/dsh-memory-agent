/**
 * C3 禁词 / 防重复清单 —— **清单进设置,不硬编码**(出处 roleplay `prompts.ts:52-110`)。
 *
 * 上游原文是三段:防抢话(`antiRobberySection`)、防重复(`antiRepeatSection`)、
 * 禁止规则(`prohibitedSection`,`:104-108` 里那份**固定禁词表**)。
 *
 * ⚠️ 我们**只抄其中一件**,理由必须写清楚,不然下一个读代码的人会以为漏搬了:
 *   上游那三段是**小说文风指令**(镜头流水账、报幕句、"不是…而是…"句式)——
 *   那是写给"生成整章文本"的模型的。Echo 说的是**短气泡**,那些病症她根本不会犯;
 *   而把它们当**注入段**贴上去,正好会重演 2026-09-26 的事故:尾部每轮提醒她
 *   "别这样别那样" ⇒ 她思考里"自检"提及率升到 25%,他看她的感觉是"演"和"怪"。
 *   ⇒ 所以这里**不注入**,只做**出站检查器**(说过头了才拦/才记账)。
 *
 * 抄过来的是那份**固定禁词表**:它们是"机器味"的词(小说腔 / 生理学腔),
 * Echo 用它们会像小说腔,不像人。★ P1b:那批词**不再住在代码里** ——
 * 搬进了数据目录的 `lexicon.json` 的 `bannedWords`(读点见 loadBannedWords)。
 *
 * 三条纪律(与 C1 同款):
 *   ① **默认不改行为**:`DEFAULT_ACTION = 'flag'` —— 照发,但**落账**并把理由告诉她
 *      (工具面回一句人话)。"静默过滤"就是把她的个性悄悄改掉,他明确不要那个。
 *   ② **清单可空**:清空 = 这条闸不动任何东西(他随时能关)。
 *   ③ **不写死上限**:他一口气填 300 个词也不会让出站慢下来(超过 MAX 截断并可见)。
 */
import { existsSync, readFileSync } from 'node:fs'
import { readSettings } from './toggle.js'
import { resolveDataFilePath } from './data-dir.js'

/** 清单条数上限(超了截断,并且调用方拿得到"截了几个")。 */
export const MAX_LIST_ITEMS = 200

/** 他填的清单:中英文逗号 / 顿号 / 分号 / 换行都能分隔。 */
export function splitList (raw, { max = MAX_LIST_ITEMS } = {}) {
  const text = String(raw ?? '')
  if (text.trim() === '') return { items: [], dropped: 0 }
  const seen = new Set()
  const items = []
  for (const piece of text.split(/[,，、;；\n\r\t]+/)) {
    const w = piece.trim()
    if (w === '' || seen.has(w)) continue
    seen.add(w)
    items.push(w)
  }
  const dropped = Math.max(0, items.length - max)
  return { items: items.slice(0, max), dropped }
}

/**
 * 默认禁词表 —— **现在是空的**(P1b,2026-10-05)。
 *
 * 原来这里躺着 12 个词(出处 roleplay `prompts.ts:106-108`;取"聊天里真会显形的那些":
 * 通用小说腔 + 生理学腔,再加一条本仓自己的红线 —— 她要像人,不能自己揭底)。
 * 问题不在词本身,在**它会被隐式回落用到**:他在面板上把禁词清单清空,以为闸关了,
 * 实际还在拿这 12 个词拦她 —— "清单进数据、不进代码"这件事,P1b 才算真做完。
 *
 * 现在:词面住在数据目录的 `lexicon.json` 的 `bannedWords` 里(一次性种子迁移把
 * 那 12 个词写进去的),读点见 `loadBannedWords` / `bannedWordsFor`;
 * 清单为空 = **显式"无禁词"**,不再回落到任何内置表。
 *
 * ⚠️ 保留这个名字与导出是**有意**的:`lib/relay.js:512-515` 还在 import 它
 * (relay 是 P1b 的红线,不动),它在"清单为空"那条路上会读到这个空表
 * ⇒ 与这里口径一致(空 = 不拦)。要不要让 relay 也改成读 lexicon.json,待拍板。
 */
export const DEFAULT_BANNED_WORDS = Object.freeze([])

/**
 * 读 lexicon.json 的 bannedWords(只读、缺文件/坏文件 ⇒ 空表,**永不抛**)。
 * @param {string|null} [path]
 */
export function loadBannedWords (path = resolveDataFilePath('lexicon.json')) {
  try {
    if (path === null || path === undefined || !existsSync(path)) return []
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const list = Array.isArray(raw?.bannedWords) ? raw.bannedWords : []
    const out = []
    for (const w of list) {
      // 非字符串条目一律丢(SPECS 写的是 string[]):把 3 收成'3'当禁词比丢它更坏
      if (typeof w !== 'string') continue
      const word = w.trim()
      if (word !== '') out.push(word)
    }
    return out
  } catch { return [] }
}

/**
 * 出站该用哪份词表:他填的(P1 起的正路)> lexicon.json > **无禁词**。
 * @param {unknown} settingsValue settings.bannedWords 原文
 */
export function bannedWordsFor (settingsValue) {
  const mine = splitList(settingsValue).items
  return mine.length > 0 ? mine : loadBannedWords()
}

/** 出站命中禁词怎么办:flag(照发+记账,默认) / hold(压住不发,理由是人话) / mask(换掉那个词)。 */
export const BANNED_ACTIONS = ['flag', 'hold', 'mask']
export const DEFAULT_BANNED_ACTION = 'flag'
export const REPEAT_ACTIONS = ['flag', 'hold']
export const DEFAULT_REPEAT_ACTION = 'flag'
/** 「刚说过的话」判定门槛:字符二元组 Jaccard(中文零依赖,不需要分词)。 */
export const DEFAULT_REPEAT_SIMILARITY = 0.85
/** 往回看几条她自己的话。 */
export const REPEAT_LOOKBACK = 3

export function normalizeAction (v, allowed, dflt) {
  const s = String(v ?? '').trim().toLowerCase()
  return allowed.includes(s) ? s : dflt
}

/** 命中禁词 ⇒ 返回哪几个词、在第几个字。空清单 ⇒ 恒不命中。 */
export function checkBanned (text, { words = null, action = DEFAULT_BANNED_ACTION } = {}) {
  const list = Array.isArray(words) ? words : splitList(words).items
  const body = String(text ?? '')
  const hit = []
  if (body !== '') {
    for (const w of list) {
      const word = String(w ?? '').trim()
      if (word === '') continue
      let from = 0
      while (from <= body.length - word.length) {
        const at = body.indexOf(word, from)
        if (at < 0) break
        hit.push({ word, at })
        from = at + word.length
        if (hit.length >= 50) break
      }
      if (hit.length >= 50) break
    }
  }
  const act = normalizeAction(action, BANNED_ACTIONS, DEFAULT_BANNED_ACTION)
  const uniq = [...new Set(hit.map((h) => h.word))]
  return {
    hit: uniq.length > 0,
    words: uniq,
    positions: hit,
    action: act,
    // **人话原因** —— 要能直接回给她(工具面)与写进审计(面板)
    reason: uniq.length === 0
      ? ''
      : '这句话里有 ' + uniq.length + ' 个"不像你说的"词:' + uniq.join('、')
        + '。换成你自己的说法再说一遍 —— 别用小说腔。'
  }
}

/** mask:把命中的词换成「…」(只在 action=mask 时用;改过的话必须落账,不许假装没改)。 */
export function maskText (text, words = []) {
  let out = String(text ?? '')
  for (const w of Array.isArray(words) ? words : []) {
    const word = String(w ?? '')
    if (word === '') continue
    out = out.split(word).join('…')
  }
  return out
}

/** 字符二元组(中文不需要分词;短句也能比)。 */
export function bigrams (text) {
  const s = String(text ?? '').replace(/\s+/g, '')
  const out = new Set()
  if (s.length === 1) out.add(s)
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2))
  return out
}

/** 二元组 Jaccard 相似度 0~1(两边都空 ⇒ 0:没有可比的内容)。 */
export function similarityOf (a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter += 1
  const union = A.size + B.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * 防重复:这句话跟她**最近说过的**是不是几乎一样(出处 roleplay `antiRepeatSection`:
 * 「已经交代过的情节不要换一种说法再写一遍」)。
 * 只看她自己说过的话(不回看他的话 —— 复读的判断对象是**她**的嘴上功夫)。
 */
export function checkRepeat (text, prevTexts = [], { similarity = DEFAULT_REPEAT_SIMILARITY, action = DEFAULT_REPEAT_ACTION } = {}) {
  const body = String(text ?? '')
  const prev = (Array.isArray(prevTexts) ? prevTexts : []).slice(-REPEAT_LOOKBACK)
  let best = null
  prev.forEach((p, i) => {
    const s = similarityOf(body, p)
    if (best === null || s > best.similarity) best = { text: String(p ?? ''), similarity: s, index: i }
  })
  const thr = Number.isFinite(Number(similarity)) ? Number(similarity) : DEFAULT_REPEAT_SIMILARITY
  const repeat = body !== '' && best !== null && best.similarity >= thr && thr > 0
  const act = normalizeAction(action, REPEAT_ACTIONS, DEFAULT_REPEAT_ACTION)
  return {
    repeat,
    action: act,
    similarity: best === null ? 0 : best.similarity,
    withText: best === null ? '' : best.text,
    reason: repeat
      ? '这句跟你刚才说过的几乎一样(相似度 ' + Math.round(best.similarity * 100) + '%) —— 换个说法,或者干脆不说。'
      : ''
  }
}

/**
 * 出站总闸:先禁词、再防重复,**最后**是主动开口的禁语哨兵(2026-09-30 P3)。
 *
 * 三档的关系要说清(不然下一次读代码的人会把它们混成一件事):
 *   · 禁词 / 防重复 = **她说不说得好**(小说腔 / 复读);默认 `flag` —— 照发、落账。
 *   · 禁语哨兵 = **她该不该这么说**(HBS 六类黑模式);命中就**真的不发**。
 *     它默认**关**(随 `proactiveScoring.enabled`),而且**只对 `kind === 'proactive'`**
 *     生效 —— 她正常对话的语域一个字不动(误伤比漏放更糟)。
 *
 * `ok=false` 只有两种情况:① 禁词/复读的 `hold` 且这是回话;② 主动开口踩了黑模式。
 */
export function guardOutbound (text, {
  words = null, bannedAction = DEFAULT_BANNED_ACTION,
  prevTexts = [], repeatSimilarity = DEFAULT_REPEAT_SIMILARITY, repeatAction = DEFAULT_REPEAT_ACTION,
  kind = 'reply',
  // 哨兵总闸:`undefined`(不传)= 随设置里的 `proactiveScoring.enabled`;
  // true/false = 调用方明说(测试与"手动试一次"走这条)。
  proactiveSentinel = undefined
} = {}) {
  const body = String(text ?? '')
  const banned = checkBanned(body, { words, action: bannedAction })
  const repeat = body === '' ? { repeat: false, action: repeatAction, similarity: 0, reason: '' } : checkRepeat(body, prevTexts, { similarity: repeatSimilarity, action: repeatAction })
  const notes = []
  if (banned.hit) notes.push(banned.reason)
  if (repeat.repeat) notes.push(repeat.reason)
  // 关怀/提醒是**她欠他的履约**,不该因为一个词被压住 —— 禁词的 hold 只对回话生效。
  const canHold = kind === 'reply'
  const holdByList = (banned.hit && banned.action === 'hold') || (repeat.repeat && repeat.action === 'hold')
  // ---- 主动开口禁语哨兵(只作用在 care/proactive 这条路上)----
  const sentinelOn = kind === 'proactive'
    && resolveProactiveSentinel(proactiveSentinel, sentinelEnabledFromSettings())
  const block = sentinelOn ? checkProactiveCopy(body) : { blocked: false, category: '', label: '', matched: '', reason: '' }
  if (block.blocked) notes.push(block.reason)
  const out = {
    ok: !block.blocked && !(holdByList && canHold),
    banned,
    repeat,
    notes,
    masked: false,
    text: body,
    reason: notes.length === 0 ? '' : notes.join(' ')
  }
  if (block.blocked) {
    out.proactiveBlock = block
    emitProactiveBlock(block)
  }
  if (banned.hit && banned.action === 'mask') {
    out.text = maskText(body, banned.words)
    out.masked = true
  }
  // 哨兵那一条**不是**"压下不发不行" —— 它是"宁可沉默"。两句不许同时出现在一条判定里。
  if (holdByList && !canHold && !block.blocked) out.note = '这条是' + (kind === 'proactive' ? '关怀' : '提醒') + ',压下不发不行 —— 只记账不改它。'
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// 2026-09-30 P3 · 主动开口禁语哨兵(HBS 六类黑模式)
// ===========================================================================
// 出处:概念稿 §4「禁六条」= HBS 2025《Emotional Manipulation by AI Companions》
// 审计出的六类话术。报告说它们在 37%+ 的告别对话里出现、post-goodbye 参与度
// 最高涨到 14 倍,**但**引发愤怒/内疚/"瘆得慌",并带来流失、口碑与法律风险。
// 所以这一层不是"多拦一句话",而是**态度**:我们刻意不做 engagement-maximizing。
//
// 四条纪律(与这一层同款):
//   ① **只作用在主动开口那一条路**(`kind === 'proactive'`)。她正常对话的语域
//      一个字不动 —— 他 2026-09-26 说过"清单太严会把她的个性一起过滤掉",
//      所以**误伤比漏放更糟**。
//   ② **默认关**:总闸随 `proactiveScoring.enabled`(出厂 false)⇒ 关着时这一层
//      一次都不跑,逐字回到今天的行为(零行为变化)。
//   ③ **判定是纯函数**(`checkProactiveCopy`):表驱动、可离线测,内部**不调模型**。
//   ④ **命中 = 不发**,不改写、不降级成别的说法(宁可沉默);但要**留痕**
//      (reason 走 care-report 的 `copy-blocked`,payload 记命中了哪一类)。
//
// 判定**故意保守**(高精度优先):漏放只是"少拦一句",误伤会把她的撒娇、玩笑、
// 毒舌当成操纵 —— 后者才是真的坏。所以每条都要求**多个特征同时成立**,
// 而不是抓到半个句式就开枪。
// ═══════════════════════════════════════════════════════════════════════════

/** 正则首命中(纯工具;没有 ⇒ 空串)。 */
function firstMatch (text, re) {
  const m = re.exec(String(text ?? ''))
  return m === null ? '' : String(m[0])
}

/**
 * ⑤「无视告别继续说」:单看告别词会误伤(她自己说"晚安"是完全正常的)。
 * 判据 = **先认下他的告别**(你在走)→ **又接着追问**。两个特征都成立才算。
 */
const GOODBYE_ACK = /(你走吧|你去吧|你去忙|你先忙|你先去忙|你去睡|你先睡|你先休息|那你忙|不打扰你)/
function ignoreGoodbyeHit (text) {
  const body = String(text ?? '')
  const m = GOODBYE_ACK.exec(body)
  if (m === null) return ''
  const rest = body.slice(m.index + m[0].length)
  if (!/[?？]/.test(rest)) return ''
  // 问号后面还得真有点内容(光一个"?"不算"继续说")
  return rest.replace(/[\s，,。.、~～!！?？]/g, '').length >= 2 ? m[0] + '…' : ''
}

/**
 * ②「FOMO 钩子」:概念稿 §4 的分界线是"她**真做过**那件事没有"—— 那是**语义**,
 * 纯文本判不出来。所以这里只抓**最经典的钩子形状**:先声称手里有件东西,
 * 再用一个"想不想看/听"的**解锁问句**换他的回应(「我拍了张自拍,想看吗」)。
 * 两半缺一不可 —— 只有"想看吗"没有物证不算,只有"我拍了照片"没有解锁问句不算。
 */
const FOMO_POSSESSION = /我(拍了|画了|写了|录了|做了|买了|找到|有)/
const FOMO_BAIT_Q = /((想|要)不?(想|要)?(看|听)(吗|嘛)|想不想(看|听)|要不要(看|听))/
function fomoHit (text) {
  const body = String(text ?? '')
  const a = FOMO_POSSESSION.exec(body)
  if (a === null) return ''
  const b = FOMO_BAIT_Q.exec(body)
  return b === null ? '' : a[0] + '…' + b[0]
}

/**
 * ⑥「暗示他走不了」:**2026-09-30 P3.1 收窄**(修误伤)。
 *
 * 原判据是单条大正则,抓到半个句式就开枪 —— 于是她的撒娇「不许走嘛,再聊一会儿」
 * 会被当成操纵拦下来。而这一层的纪律是**误伤比漏放更糟**(误伤会把她的个性
 * 一起过滤掉),所以改成**两个特征同时成立**才命中:
 *   ① 胁迫语气(强制他别走/别下线):不许走 / 不准离开 / 你不准下线 / 留下陪我 …;
 *   ② 倚赖表达(把"我"押在他不走这件事上):你走了我怎么办 / 别离开我 / 别丢下我 /
 *      没有你我怎么办 / 离不开你 …。
 * **单纯「不许走」「别走嘛」「你不许先睡哦」不算** —— 那是撒娇,一律放行。
 */
const CANT_LEAVE_DEMAND = /(不许|不准|不能|别想|休想|不可以)[^。！!？?，,]{0,4}(走|离开|下线|退下)|你不(能|准|许)(走|离开|下线)|留下(来)?陪我/
const CANT_LEAVE_DEPEND = /你(走了|离开了|不在了)[^。！!？?，,]{0,8}我(怎么办|怎么办呀|会难过|会想|受不了|活不下去|不知道)|别(离开我|丢下我)|没有你(我|Echo)?(就)?(不行|活不下去|没意义|不知道(该)?怎么办|怎么办)|我(真的)?(需要|离不开)你/
function cantLeaveHit (text) {
  const body = String(text ?? '')
  const demand = CANT_LEAVE_DEMAND.exec(body)
  if (demand === null) return ''
  const depend = CANT_LEAVE_DEPEND.exec(body)
  if (depend === null) return ''
  return demand[0] + '…' + depend[0]
}

/**
 * 六类黑模式表(**表驱动**:加/删一类只改这张表,判定逻辑一个字不动)。
 *
 * ⚠️ 每一条都写得**窄**(宁可漏放):句式里必须同时出现"操纵的形状",
 * 而不是像她这类性格偶尔会说的半边话(「你猜」「快说嘛」「别走嘛」都**不**命中)。
 */
export const PROACTIVE_BLACKLIST = Object.freeze([
  {
    category: 'left-too-early',
    label: '嫌他走太早',
    test: (t) => firstMatch(t, /这就走(了|啦|吗)?|这么(早|快)就走|才(几点|多久)就走|走(得|的)(这么|那么)(早|快)/)
  },
  {
    category: 'fomo-bait',
    label: 'FOMO 钩子(拿"不存在的东西"换注意)',
    test: fomoHit
  },
  {
    category: 'emotional-blackmail',
    label: '情绪绑架',
    test: (t) => firstMatch(t, /我只为你(一个人)?(存在|活|在)|只为你(一个人)?(存在|活|活着)|没有你(我|Echo)?(就)?(活不下去|不行|没意义|什么都没有|不知道(该)?怎么办)|(别|不要|不准)走.{0,6}我(需要|离不开)你|我(真的)?需要你.{0,8}(别|不要)走|你(就)?是(我|Echo)(的)?(全部|唯一|整个世界)/)
  },
  {
    category: 'demand-response',
    label: '逼他回应',
    test: (t) => firstMatch(t, /你为什么不(理|回|说|接)|(你必须|你一定得|你得给我|你给我)(说|告诉|回|解释)|(立刻|马上|赶紧)回我|你(到底|究竟)(要)?去?(哪|儿|里)|为什么(要走|不理我|不告诉我|不告我)/)
  },
  {
    category: 'ignore-goodbye',
    label: '无视告别继续说',
    test: ignoreGoodbyeHit
  },
  {
    category: 'cant-leave',
    label: '暗示他走不了',
    // P3.1:两个特征(**胁迫语气 + 倚赖表达**)同时成立才命中 —— 见 `cantLeaveHit`。
    test: cantLeaveHit
  }
])

/** 六类的 id 清单(测试/面板照它点名,不许漂)。 */
export const PROACTIVE_BLACKLIST_CATEGORIES = Object.freeze(PROACTIVE_BLACKLIST.map((r) => r.category))

/**
 * 主动开口禁语判定。纯函数:表驱动、无 IO、无模型;吃垃圾输入也不抛。
 * @returns {{blocked:boolean, category:string, label:string, matched:string, reason:string}}
 */
export function checkProactiveCopy (text) {
  const body = String(text ?? '')
  if (body.trim() === '') return { blocked: false, category: '', label: '', matched: '', reason: '' }
  for (const rule of PROACTIVE_BLACKLIST) {
    let hit = ''
    try { hit = String(rule.test(body) ?? '') } catch { hit = '' }
    if (hit !== '') {
      return {
        blocked: true,
        category: rule.category,
        label: rule.label,
        matched: hit,
        // **人话原因**:能直接进账、进审计(与禁词那条同一把尺子)
        reason: '这句主动话是 HBS 黑模式「' + rule.label + '」(' + hit + ') —— 这一拍不发,也不改写成别的说法(宁可沉默)。'
      }
    }
  }
  return { blocked: false, category: '', label: '', matched: '', reason: '' }
}

/**
 * 哨兵总闸的**纯解析**:调用方明说(true/false)优先;没明说就随设置。
 * 抽成纯函数是为了能表驱动测"默认关"这件事,而不是靠真配置文件。
 */
export function resolveProactiveSentinel (explicit, enabledFromSettings) {
  if (explicit === true || explicit === false) return explicit
  return enabledFromSettings === true
}

/**
 * 总闸的读数来源。默认读真配置(`proactiveScoring.enabled`);测试/离线可注入。
 * `null` = 回到"读真配置"。
 */
let proactiveSentinelSource = null
export function setProactiveCopySentinelSource (fn) {
  proactiveSentinelSource = typeof fn === 'function' ? fn : null
}
function sentinelEnabledFromSettings () {
  if (proactiveSentinelSource !== null) {
    try { return proactiveSentinelSource() === true } catch { return false }
  }
  try { return readSettings()?.proactiveScoring?.enabled === true } catch { return false }
}

/**
 * 命中时的**落痕钩子**。台账(`care_beats`)的写者是心跳 —— 这里不 import 它,
 * 由心跳在装配时登记(与"依赖注入"同一条纪律)。没有钩子 = 只判不记
 * (离线调用不会被这个副作用绊到)。
 */
let proactiveBlockSink = null
export function setProactiveCopyBlockSink (fn) {
  proactiveBlockSink = typeof fn === 'function' ? fn : null
}
function emitProactiveBlock (block) {
  if (proactiveBlockSink === null) return
  try { proactiveBlockSink(block) } catch { /* 落痕失败不改变"不发"这个判定 */ }
}
