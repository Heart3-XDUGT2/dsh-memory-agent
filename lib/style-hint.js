/**
 * 「语气候选」—— 把情绪读数折成 heart-tts 的 `<emo type="N">` 候选集。
 *
 * 2026-10-05 方案 C(候选集 + 禁区):① = 纯函数 + 插槽 + 开关 + 矩阵;
 * ② = 降级矩阵写全 + 文案打磨 + 面板可见。盘点见
 * `交接档 emo融合盘点-2026-10-05.md`。
 *
 * 这一层干什么
 * ------------
 * heart-tts 的行内语气标签 `<emo type="…">…</emo>` 本来只靠模型临场判断(教学渠道是它注册的
 * 运行时 skill),与情绪架构零耦合。本模块把**已经算出来的情绪读数**折成
 * 「此刻偏向用哪几个号 / 哪几个号不优先」,由 `lib/context.js` 的 `describeMood()`
 * 追加一行进 prompt —— **只出号,不替模型决定哪一句用**。
 *
 * 职责边界(与「行为要求」那行的分工)
 * --------------------------------
 *   · `describeMood` 末尾的**行为要求**管"**话怎么写**":句长、用词、要不要挑起话题、
 *     安静不等于变冷 —— 落在**文本**上;
 *   · 本行的语气候选管"**话怎么念**":给 `<emo type="N">` 的候选,落在 **TTS 朗读**上。
 * 两者不重复(一个改文本、一个改韵律),所以在文案里写明 `(只影响朗读)`,
 * 免得模型拿"语气"一词把两件事搅在一起。行为要求**不动**。
 *
 * 融合侧不维护样式表(硬约束)
 * --------------------------
 * `<emo type="N">` 的权威表在 heart-tts 侧(`GET /characters`,由它的 skill 实时生成)。
 * 本模块**不拉表、不校验表、不缓存表**;`STYLE_LABEL` 只是"给号配个中文读法"的
 * **显示用**字典 —— 表中没收录的号照样按 `<emo type="N">` 原样输出(宁可不加名字,不猜)。
 * 派蒙当前是 6 条(自然/上扬/急促/低沉/紧张/突出),但那是**它那边的现状**,
 * 换角色换后端都不该让这一层出错。
 *
 * 四条硬约束(写进 `tests/style-hint.test.js`)
 * ------------------------------------------
 *   ① 产出的号永远 ∈ `1..6`;
 *   ② `6`(突出)与`1`(自然)**永不进候选、也不进禁区** ——
 *      前者是"这句话重不重要",后者是"没转折",两者都不由情绪推;
 *   ③ **门禁 `yellow`/`red`/`unknown` 时不引用共享轴 `s`**:候选只从她自身的
 *      唤醒度/心情推,文案里也不出现 `s`/共享轴(`green` 时 `s` **仅**用于
 *      "心情读数缺"的兜底,且**不许**因此在文案里声称"心情偏正/偏负");
 *   ④ `delta = 0` 与"读不出变化"⇒ **不出提示行** —— 没转折就别加,和 skill
 *      自己的克制纪律一致。
 *
 * 降级矩阵(②写全,`tests/style-hint.test.js` 里 4×4×3×4 = 192 格)
 * ---------------------------------------------------------------
 * "不出行"分四类:① `delta = 0`;② `delta` 读不出;③ **候选被掏空**
 * (低唤醒 + 心情偏正 = 平静 / 低唤醒 + 心情缺且门禁不可信 / **自身读数全缺**);
 * ④ 无 —— 门禁红/黄**自己**并不禁止出行:她自己的读数还在,只是不许引用 `s`。
 * **真正"什么都不该说"的是"自身读数也缺"**:那时连方向都没有,红带/黄带尤其
 * 不该硬给一个号(这就是 ② 补上的那类),绿带也不行 —— 共享轴单独一条不足以
 * 挑语气(两套坐标"不等价、不可互推")。
 *
 * 文案纪律(②打磨)
 * --------------
 *   · **正向表述**:不说"此刻不合适/不能用"(模型会读成"绝对禁止",反而丢掉语境),
 *     只说"**偏向用** X(`Y/Z` 不优先)";
 *   · **括号里只写真读到的字段**:唤醒度读不到就不提唤醒,心情没读到就写"心情读数缺";
 *   · **绿灯不啰嗦**:门禁尾巴只在黄/红/未知才出现;
 *   · 每个号后面括号里是**显示用**读法;目标 ≤ 80 字(`LINE_MAX` 是硬上限)。
 *
 * [工程假设] 两处阈值/口径(只在本文件一处,别处没有第二份)
 * ------------------------------------------------------
 *   · 唤醒度三档:`arousal` 是 0~10 的宿主口径 ⇒ `≤3 偏低 / 4~6 居中 / ≥7 偏高`;
 *     读不到 ⇒ `arousalBand = 'unknown'`(**不再**假装居中);
 *   · 心情符号:`valence < 0` 记负、`≥ 0` 记正;读不到且门禁可信 ⇒ 用 `s` 的符号兜底
 *     (标 `valenceFromS`,文案只写"心情读数缺")。
 */
import { readIntensity } from './context.js'

/** `<emo type="N">` 的号域(那边是 1 起的序号;1 与 6 见文件头约束 ②)。 */
export const STYLE_MIN = 1
export const STYLE_MAX = 6

/** 永不入候选/禁区的两个号:1 = 自然(默认语气),6 = 突出(纯强调,与情绪无关)。 */
export const STYLE_NEVER = [1, 6]

/** **显示用**中文读法(非权威、非校验;表里没有的号不编名字)。 */
export const STYLE_LABEL = Object.freeze({ 2: '上扬', 3: '急促', 4: '低沉', 5: '紧张' })

/** 文案长度硬上限(电池里断言)。
 *
 *  2026-10-07 换 XML 语法时由 **80 重标到 101**:每出现一个标记,旧写法 `[emo:2]`
 *  (7 字)变成 `<emo type="2">`(14 字),一行最多三个(1 个候选 + 2 个禁区)⇒ 恰好 +21。
 *  最长的那格(黄/红带 + 两个禁区号)实测正好 101,与旧的"实测正好 80"同一套标法。
 *
 *  ⚠️ 这不是把原注「再长就该砍信息,而不是放宽这个数」作废 —— 那条规矩管的是
 *  **别往里加信息**;而这次一个字的**信息**都没加,只是同一个标记的**写法**变长了。
 *  也就是说:上限跟着**格式**走,不跟着**内容**走。真要再加信息,仍按原规矩砍信息。 */
export const LINE_MAX = 101

/** 唤醒度档位 [工程假设](0~10)。 */
const AROUSAL_UP = 7
const AROUSAL_DOWN = 3

const DIR_ZH = { pos: '偏正向', neg: '偏负向' }
const AROUSAL_ZH = { up: '偏高', mid: '居中', down: '偏低' }
const VALENCE_ZH = { pos: '偏正', neg: '偏负' }
/** 门禁尾巴:**绿灯什么都不说**(默认情形,说得越多越啰嗦);黄/红/未知只提醒
 *  一句该怎么做(按自己的体感推、别引用联合读数),不复述原因 —— 省下来的字
 *  留给"偏向用哪个号"。黄与红**同一句**:对模型来说要做的动作是一样的。 */
const GATE_TAIL = {
  green: '',
  yellow: '(按体感)',
  red: '(按体感)',
  unknown: '(按体感)'
}

/** 号 → `<emo type="N">`(名字):表里没有就只给号(不猜名字)。
 *  这里只给**开标签**:它是一份"候选清单",让模型知道该往正文外面套哪个号;
 *  完整的一对怎么写由 heart-tts 的 skill 教(见那里的语法契约)。 */
function markOf (n) {
  const label = STYLE_LABEL[n]
  return '<emo type="' + n + '">' + (label === undefined ? '' : '(' + label + ')')
}

/**
 * 读一个数:缺读数一律 `null`(不补 0 —— 与 `renderUnionBlock` 的严格缺维判定同口径)。
 * @param {unknown} v
 * @returns {number|null}
 */
function numOf (v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 主函数:情绪读数 → `<emo>` 候选集 + 一行 prompt 文案。
 *
 * @param {object} [input]
 * @param {unknown} [input.moodIntensity]      这一轮的强度(0~10,0/空 = 没读数)
 * @param {unknown} [input.prevMoodIntensity]  上一轮的强度(同上)
 * @param {object}  [input.emotionVector]      情绪向量(只读 `global.arousal` / `global.valence`)
 * @param {string}  [input.gate]               门禁:`green` / `yellow` / `red` / 其它(按未知)
 * @param {object}  [input.union]              联合读数(只用到 `s`,且**仅**在门禁可信时当兜底)
 * @returns {{delta:string, arousalBand:string, arousalKnown:boolean, valenceSign:string,
 *            valenceKnown:boolean, valenceFromS:boolean, gate:string, sTrusted:boolean,
 *            candidates:number[], avoid:number[], line:string}}
 *          `line` 为 `''` 表示**不要注入**(没转折 / 读不出变化 / 候选被掏空)。
 */
export function statusToStyleCandidates (input = {}) {
  const p = (input !== null && typeof input === 'object') ? input : {}
  const gate = ['green', 'yellow', 'red'].includes(p.gate) ? p.gate : 'unknown'
  // 门禁可信 = 绿带。黄带"只给方向"、红带/未知"不给块" ⇒ 一律不碰 s。
  const sTrusted = gate === 'green'

  // ── delta:这一轮相对上一轮的变化(读不出就不猜) ────────────────────────
  const cur = readIntensity(p.moodIntensity)
  const prev = readIntensity(p.prevMoodIntensity)
  const delta = (cur === null || prev === null)
    ? 'unknown'
    : (cur > prev ? 'pos' : (cur < prev ? 'neg' : 'zero'))

  // ── 自身读数:唤醒度 + 心情符号(各自独立,缺一个不影响另一个) ───────────
  const vec = (p.emotionVector !== null && typeof p.emotionVector === 'object') ? p.emotionVector : {}
  const g = (vec.global !== null && typeof vec.global === 'object') ? vec.global : {}
  const arousal = numOf(g.arousal)
  const arousalKnown = arousal !== null
  const arousalBand = !arousalKnown
    ? 'unknown'
    : (arousal >= AROUSAL_UP ? 'up' : (arousal <= AROUSAL_DOWN ? 'down' : 'mid'))
  const valence = numOf(g.valence)
  const valenceKnown = valence !== null
  let valenceSign = valenceKnown ? (valence < 0 ? 'neg' : 'pos') : 'unknown'
  let valenceFromS = false
  if (!valenceKnown && sTrusted) {
    // 心情读数缺 + 门禁可信 ⇒ 拿共享轴(文献支持的公共方向)当**兜底**:只判符号,
    // 不写进文案的"心情偏正/偏负"里(那是没读到的东西)。
    const s = numOf(p.union !== null && typeof p.union === 'object' ? p.union.s : null)
    if (s !== null) {
      valenceSign = s < 0 ? 'neg' : 'pos'
      valenceFromS = true
    }
  }

  // ── 候选 / 禁区(1 与 6 永不出现) ─────────────────────────────────────
  let candidates = []
  let avoid = []
  if (!arousalKnown && !valenceKnown) {
    // 自身读数全缺 ⇒ **任何门禁**都不出行 —— 哪怕绿带能拿到 `s`。
    // 理由:共享轴 `s` 与自身体感"两套坐标不等价、不可互推"是既有口径
    // (`lib/context.js:313` 那句就写在注入块里),拿它**单独**去挑朗读语气
    // 正是那条被禁的推断;它只在"至少有一个自身读数"时当兜底。
    // (②补上的那类:红带 + 自身也缺,原来会照给;现在不出行。)
    candidates = []
    avoid = []
  } else if (!arousalKnown) {
    // 只有心情:给一档,但文案里不许出现"唤醒度"(没读到)。
    candidates = valenceSign === 'neg' ? [4] : [2]
    avoid = valenceSign === 'neg' ? [2] : []
  } else if (arousalBand === 'up') {
    candidates = valenceSign === 'neg' ? [5] : [2]
    avoid = valenceSign === 'neg' ? [2, 4] : [4, 5]
  } else if (arousalBand === 'down') {
    // 低唤醒 + 心情偏正 = **平静/温柔** ⇒ 不推任何号(默认语气就是对的)。
    // real-data 复盘(2026-10-05):真实那几轮是"唤醒 3 + 心情 +2",第一版推了
    // <emo type="4">(低沉)—— 读起来像"她情绪低落",和"心情偏正"自相矛盾。
    // heart-tts 的 skill 原话:「不确定就不加,默认语气是安全选择」。
    // 心情读不出时同理:没有读数就别指着她说"压低声"。
    candidates = valenceSign === 'neg' ? [4] : []
    avoid = [2, 3]
  } else {
    candidates = valenceSign === 'neg' ? [4] : [2]
    avoid = valenceSign === 'neg' ? [2] : []
  }
  const drop = (xs) => xs.filter((n) => STYLE_NEVER.indexOf(n) < 0 && candidates.indexOf(n) < 0)
  candidates = candidates.filter((n) => STYLE_NEVER.indexOf(n) < 0)
  avoid = drop(avoid)

  // ── 文案(没转折 / 候选被掏空 ⇒ 一个字都不出) ─────────────────────────
  let line = ''
  if ((delta === 'pos' || delta === 'neg') && candidates.length > 0) {
    // 括号里只写"真读到"的字段:唤醒度读不到就不提唤醒,心情没读到就写"心情读数缺"。
    const state = []
    if (arousalKnown) state.push(`唤醒${AROUSAL_ZH[arousalBand]}`)
    state.push(valenceKnown ? `心情${VALENCE_ZH[valenceSign]}` : '心情读数缺')
    const bits = []
    bits.push(`- 语气候选(朗读用):${DIR_ZH[delta]}(${state.join('、')})。`)
    bits.push(`有转折时偏向用 ${candidates.map(markOf).join(' 或 ')}`)
    if (avoid.length > 0) bits.push(',' + avoid.map((n) => '<emo type="' + n + '">').join('/') + ' 不优先')
    bits.push(';没转折就不加。' + (GATE_TAIL[gate] !== undefined ? GATE_TAIL[gate] : GATE_TAIL.unknown))
    line = bits.join('')
  }

  return {
    delta,
    arousalBand,
    arousalKnown,
    valenceSign,
    valenceKnown,
    valenceFromS,
    gate,
    sTrusted,
    candidates,
    avoid,
    line
  }
}
