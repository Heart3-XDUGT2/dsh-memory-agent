/**
 * 情绪向量:数据与动力学 —— A 侧 `brains/echo_emotion.py` 的移植。
 *
 * v0.14.4 移植缺口 S7(G13):此前 DSH 侧**只有渲染**(context.js 的
 * 剧本/滤镜),没有数据层:LLM 给的向量原样透传落库 ——
 *   · 未知维度不丢、越界不夹(`affection: 99` 照样写进去);
 *   · 缺维不补默认(渲染端只能靠 v0.14.4 的缺维跳过兜住);
 *   · 没有差分(`emotion_delta`),审计里那一列永远是空的;
 *   · 没有时间衰减,情绪强度只会被对话改写,放着不动永不回落。
 *
 * v0.29.0 个人机器人裁剪(2026-09-27,他的裁决:「彻底移除一切和群体
 * 相关的东西」):**砍掉 `target_group` 组**(耐心/轻蔑/防御/怒火 ——
 * A 侧「对群友」的那四维)。DSH 从第一天起就是单主人:judge 提示词
 * 从来只请 `global` + `target_master`,那四维在活库里永远是出厂值,
 * 留着只会让面板多出一排「对群体」的假读数。连同它一起退役的是
 * A 的「对象隔离硬兜底」(未触及组强制回填 prev)—— 那道防线的存在
 * 理由就是「群友怒火污染主人爱意」;没有群,没有要防的污染。
 * 老库向量里若还躺着 target_group,`clampEmotionVector` 按 EMOTION_RANGES
 * 白名单清洗时会自然丢弃,不需要迁移。
 *
 * 本模块只放**数据与纯函数**,不碰库、不发帧(与 A 的分层一致:
 * `echo_emotion.py` 是纯函数模块,落库在 `main.py`/`echo_audit.py`)。
 * `agent_state` 是壳拥有的表(引擎只读,`longing.py:277` 自述),所以
 * 钳位与衰减都发生在壳侧 —— 与 A 把衰减放在 audit mixin 同位。
 */

/**
 * 7 维合法范围(A 侧 11 维去掉 target_group 四维;
 * global/target_master 逐字照抄 `echo_emotion.py:85-103`)。
 */
export const EMOTION_RANGES = {
  global: {
    fatigue: [0.0, 10.0], valence: [-10.0, 10.0], arousal: [1.0, 10.0],
    // 2026-10-05 情绪空间融合(拍板 ①):**登记但先不渲染**。
    // 为什么现在就要这个键:联合空间声明层(`lib/emotion-space.js`)把
    // `global.dominance` 归到 SP_PAD 的 d 轴(`kind:'registered-only'`),
    // 桥接要读它就必须先过这里的白名单 —— 否则 `clampEmotionVector` 会把
    // LLM 给的 dominance 静默丢掉,联合空间永远拿到 0。
    // 渲染侧(剧本行 / 行为要求 / 四维面板)一律**不读它**:
    // 见 `docs/EMOTION_SPACE.md` 的「登记未渲染」一节。
    dominance: [0.0, 10.0]
  },
  target_master: {
    affection: [0.0, 10.0], playfulness: [0.0, 10.0],
    sadness: [0.0, 10.0], dependency: [0.0, 10.0]
  }
}

/** 维度中文名(A `EMOTION_DIM_LABELS`,`echo_emotion.py:106-118`,去群维)。 */
// P3-a:初值优先取 `state-defaults.json`(见 defaultEmotionVector 的注释)。
import { objectField, stateDefaultsOf } from './data-tables.js'

export const EMOTION_DIM_LABELS = {
  fatigue: '疲惫', valence: '心情', arousal: '唤醒度', dominance: '支配',
  affection: '爱意', playfulness: '调皮', sadness: '委屈', dependency: '依赖'
}

/**
 * 默认向量:中性、微正(照抄 `echo_emotion.py:135-151`,数值逐字)。
 *
 * P3-a:初值改由 `state-defaults.json.emotionVector` **覆盖**(只覆盖它给了的维度,
 * 越界夹取、未知维度忽略);文件缺 / 空 / 坏 ⇒ 与迁移前**逐位一致**的这组出厂值。
 */
export function defaultEmotionVector (env = undefined) {
  const base = {
    global: { fatigue: 2.0, valence: 2.0, arousal: 3.0 },
    target_master: { affection: 8.0, playfulness: 7.0, sadness: 0.0, dependency: 6.0 }
  }
  let data = null
  try {
    data = objectField(stateDefaultsOf(env), 'emotionVector')
  } catch { data = null }
  if (data === null) return base
  for (const group of Object.keys(base)) {
    const row = objectField(data, group)
    if (row === null) continue
    for (const dim of Object.keys(base[group])) {
      const v = clampDim(group, dim, row[dim])
      if (v !== null) base[group][dim] = v
    }
  }
  return base
}

/**
 * 人格护栏触发时的强制覆写向量(`echo_emotion.py:154-162`)。
 * 目前没有调用方 —— A 的调用点在人格护栏分支,DSH 的护栏走提示词。
 * 留档导出,免得下次有人以为「A 有这个我们没抄」。
 *
 * 2026-10-10 补 `dependency`:此前只覆写 affection/playfulness/sadness,
 * **依赖维会从 `defaultEmotionVector()` 漏进来** —— 也就是说"强制积极"之后,
 * 依赖度由活文件 `state-defaults.json` 决定,同一个函数在不同机器上给出不同向量。
 * 那是真缺口(不是风格问题):覆写函数的产物必须**完全确定**。
 *
 * 为什么显式写 `6.0` 而**不跟随 affection 到 9.0**:
 *   `dependency` 的语义是"依赖",与"积极/亲热"不是一回事 —— 把依赖也拉到 9.0
 *   会得到"又热情又黏人"的向量,而人格护栏要的是**积极**,不是**黏**。
 *   6.0 是迁移前 `echo_emotion.py:135-151` 的依赖出厂值(`emotion.js:67`),
 *   取它 = "积极覆写不改变依赖关系,只改情绪面",这是最保守、也最说得通的口径。
 */
export function positiveOverrideVector () {
  const vec = defaultEmotionVector()
  Object.assign(vec.global, { fatigue: 1.0, valence: 5.0, arousal: 6.0 })
  Object.assign(vec.target_master, {
    affection: 9.0, playfulness: 9.0, sadness: 0.0,
    // 显式写死:不读活文件,也不跟随 affection(见上方注释)
    dependency: 6.0
  })
  return vec
}

/** 单维清洗:非数字/NaN → null(调用方决定补默认还是跳过)。 */
export function clampDim (group, dim, value) {
  const range = EMOTION_RANGES[group] ? EMOTION_RANGES[group][dim] : undefined
  if (range === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.round(Math.max(range[0], Math.min(range[1], n)) * 10) / 10
}

/**
 * 把任意脏输入清洗成合法向量(照抄 `clamp_emotion_vector`)。
 *
 * 规则:未知维度/未知组丢弃、越界夹取、缺失维度补默认、round 0.1;任何解析
 * 失败都降级为默认向量(A 的交付要求 6:绝不能影响正常聊天)。
 * 「未知组丢弃」也是 v0.29.0 的退役路径:老库向量里残留的 `target_group`
 * (或模型偶尔幻觉出来的)在这里被静默扔掉,不迁移、不报错。
 */
export function clampEmotionVector (raw) {
  const vec = defaultEmotionVector()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return vec
  for (const group of Object.keys(EMOTION_RANGES)) {
    const rawGroup = raw[group]
    if (rawGroup === null || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) continue
    for (const dim of Object.keys(EMOTION_RANGES[group])) {
      const v = clampDim(group, dim, rawGroup[dim])
      if (v !== null) vec[group][dim] = v
    }
  }
  return vec
}

/**
 * 多维差分:`{group: {dim: 变化量}}`;变化小于 0.1 的维度不出现
 * (照抄 `emotion_delta`,两边都先各自 clamp)。
 */
export function emotionDelta (prev, cur) {
  const p = clampEmotionVector(prev)
  const c = clampEmotionVector(cur)
  const out = {}
  for (const group of Object.keys(EMOTION_RANGES)) {
    const diffs = {}
    for (const dim of Object.keys(EMOTION_RANGES[group])) {
      const d = Math.round((c[group][dim] - p[group][dim]) * 10) / 10
      if (Math.abs(d) >= 0.1) diffs[dim] = d
    }
    if (Object.keys(diffs).length > 0) out[group] = diffs
  }
  return out
}

/** 差分字典 → 日志/审计友好的短句(照抄 `format_emotion_delta`)。 */
export function formatEmotionDelta (delta) {
  if (delta === null || delta === undefined || Object.keys(delta).length === 0) return '无变化'
  const groupLabels = { global: '整体', target_master: '对主人' }
  const parts = []
  for (const [group, dims] of Object.entries(delta)) {
    const inner = Object.entries(dims)
      .map(([dim, value]) => `${EMOTION_DIM_LABELS[dim] || dim}${value > 0 ? '+' : ''}${value}`)
      .join(', ')
    parts.push(`${groupLabels[group] || group}[${inner}]`)
  }
  return parts.join('; ')
}

/**
 * 本轮向量落地(A `main.py:725-732` 的两步):
 *   ① LLM 给了非空向量 → clamp 它;没给 → clamp(prev)(= 原样保留);
 *   ② 返回可直接落库的向量(调用方再拿 emotionDelta(prev, next) 写审计)。
 *
 * 保真说明:A 的判定是 `isinstance(raw, dict) and raw`(非空才算),
 * 空 dict 走保留路径 —— 这里用 `Object.keys().length > 0` 对齐。另外
 * A 对**被触及**的组不做回填:LLM 漏给 target_master 时它会回落默认
 * 值(爱意 8.0)。本移植照抄这一条,不发明「缺组也回填」的新行为 ——
 * 有据可查 > 顺手改良。(A 的第三步「未触及组强制回填 prev」随
 * target_group 一起退役 —— 见文件头 v0.29.0 注。)
 */
export function applyEmotionVector (prevRaw, rawVector) {
  const given = rawVector !== null && typeof rawVector === 'object' &&
    !Array.isArray(rawVector) && Object.keys(rawVector).length > 0
  return given ? clampEmotionVector(rawVector) : clampEmotionVector(prevRaw)
}

/**
 * 把 value 按半衰期向 target 指数逼近,并让大偏差的有效半衰期更短。
 *
 * B-1a:线性绝对步长 → 指数比例步长(半衰期在 6h 锚定改前行为)。
 * B-1b:再加入距离依赖:
 *   distanceNorm = min(1, |value-target|/maxDistance)
 *   HL_eff = HL/(1 + DECAY_ASYMMETRY * distanceNorm^1.35)
 *
 * 使用 64 步**中点指数积分器**,而不是显式 Euler。显式 Euler 的乘子
 * `1-(ln2/HL_eff)*dt` 在远距离 / 大 dt 时会 ≤0,造成震荡甚至发散；中点指数步
 * 每次都乘 `2^(-dt/HL_eff)`∈(0,1),无条件稳定。参考 RK4 数值解验证,asym=0.5/1/2
 * 的最大绝对误差均 < 0.0002,远小于 r1 的 0.05 取整阈值。
 *
 * maxDistance 是逐维原生范围内从 target 到最远边界的距离(数值在 decayedEmotionVector
 * 调用点显式列出)。衰减维度的合法范围是 0~10 / -10~10 / 1~10,**不是 [0,1]**;
 * emotion-space 的 /10 是 PAD/IPC 桥的转换,不在这里使用。
 *
 * @param {number} value 当前值
 * @param {number} target 基线(吸引子)
 * @param {number} hours 经过的小时数(≥ 0)
 * @param {number} halfLife 基础半衰期(小时,> 0)
 * @param {number} maxDistance target 到该维最远合法边界的距离(原生单位,> 0)
 */
const DECAY_ASYMMETRY = 1.0

function toward (value, target, hours, halfLife, maxDistance) {
  if (hours <= 0 || halfLife <= 0 || maxDistance <= 0) return value
  const steps = 64
  const dt = hours / steps
  const effectiveHalfLife = (x) => {
    const distanceNorm = Math.min(1, Math.abs(x - target) / maxDistance)
    return halfLife / (1 + DECAY_ASYMMETRY * Math.pow(distanceNorm, 1.35))
  }
  let current = value
  for (let i = 0; i < steps; i++) {
    const startHalfLife = effectiveHalfLife(current)
    const midpoint = target + (current - target) * Math.pow(0.5, dt / (2 * startHalfLife))
    const midpointHalfLife = effectiveHalfLife(midpoint)
    current = target + (current - target) * Math.pow(0.5, dt / midpointHalfLife)
  }
  return current
}

/**
 * 按时间衰减多维情绪,规则分对象差异化:
 *
 * - `global.fatigue` 向 0 衰减(睡一觉就好);
 * - `global.arousal/valence` 向基线(3/2)衰减;
 * - `target_master` 向基线衰减:爱意极慢 = 长期记忆性,委屈消得快。
 *
 * (A 侧还有 `target_group` 怒火/防御/轻蔑 −2/h、耐心 +1/h 的快速翻篇
 * 规则 —— 随群维一起退役。)
 *
 * 2026-10-10(笔 2-B-1a/b):绝对步长 → **指数逼近 + 距离依赖**(见 `toward` 注释)。
 * 2026-10-10(笔 5):**速率校准** —— 基础半衰期从 B-1a 的"锚定改前线性 6h 行为"
 * (3h–81h)改成对齐人类经验区间 + 工程先例的下表。B-1a 那套锚定只保证"换形状不换
 * 速度",而调研(《情绪动态学调研-2026-10-10》§1.6/§1.7/§3.4)显示原速度整体比
 * 人类实测慢 4–13×、比 Letta 慢 2×+,所以本笔是**有意换速度**。
 *
 *   维          基础 HL   maxDistance   asym   依据
 *   fatigue     3h        10            1.0    生理/稳态量,不用情绪文献校准 [工程决策]
 *   valence     1.4h      12            1.0    Kuppens 2010 的 AR(1)→λ 换算区间 0.7–1.5h
 *   arousal     1.4h      7             1.0    同上(Kuppens 2010,doi 10.1177/0956797610372634)
 *   sadness     7h        10            1.0    [工程假设] 折中:D'Mello 秒级测的是学习任务
 *                                              认知情绪、Letta 无同名参数,两端都不可直迁
 *   playfulness 2.5h      7             1.0    Letta SHORT_FEELINGS(amusement/excitement)类比
 *   affection   24h       8             1.0    Letta LONG_FEELINGS 明确列 affection=24h(直接先例)
 *   dependency  24h       6             1.0    [工程假设] 关系维类比 Letta 慢感受;dependency
 *                                              不在其 LONG 列表,属跨构念迁移
 * (Letta 出处:letta-ai/mods `packages/emotions/mods/index.ts`,feelingHalfLife 与
 *  `d(36,20,48,72,48)` / `d(3,1.5,4,8,5)`;见调研报告 §3.4。)
 *
 * ⚠️ **基础 HL ≠ 实际半程时间**:`asym=1.0` 让远距离的有效半衰期更短
 * (`HL_eff = HL/(1+d^1.35)`,最大距离处只有一半),所以"走完一半距离要多久"随起点变化。
 * 按最大距离起点实测(asym=1、64 步积分):fatigue 1.84h、valence/arousal 0.86h、
 * sadness 4.29h、playfulness 1.53h、affection/dependency 14.71h。文档与日志里请称
 * 上表为**基础 HL**;要对具体起点说"半衰期",必须由积分器实算。
 *
 * ⚠️ fatigue 的 0.1 取整归零阈值随 asym 改变:hot=10 时 asym=1 约 20.8h,
 * 故测试用 20h 验证仍 >0、22h 验证归零。指数从正数出发永不为负,不需显式截断。
 */
export function decayedEmotionVector (vector, hours) {
  const v = clampEmotionVector(vector)
  const h = Math.max(0, Number(hours) || 0)
  if (h <= 0) return v
  const g = v.global
  const m = v.target_master
  const r1 = (x) => Math.round(x * 10) / 10
  // maxDistance = max(target-rangeMin, rangeMax-target),范围取 EMOTION_RANGES 原生单位
  // 基础 HL 见上方注释的依据表;fatigue 保持 3h(生理量,不用情绪文献校准)
  g.fatigue = r1(toward(g.fatigue, 0.0, h, 3, 10))
  g.arousal = r1(toward(g.arousal, 3.0, h, 1.4, 7))
  g.valence = r1(toward(g.valence, 2.0, h, 1.4, 12))
  const base = defaultEmotionVector().target_master
  for (const [key, halfLife, maxDistance] of [
    ['affection', 24, 8], ['playfulness', 2.5, 7], ['sadness', 7, 10], ['dependency', 24, 6]
  ]) {
    m[key] = r1(toward(m[key], base[key], h, halfLife, maxDistance))
  }
  return clampEmotionVector(v)
}

/**
 * 衰减写回:把 `decayed` 里**不认识**的键,从原向量 `prev` 原样带回来。
 *
 * **事故(2026-10-06)**:`decayedEmotionVector` 内部走 `clampEmotionVector`,而后者
 * **只重建已知的情绪维** ⇒ `emotion_vector` 这一列 JSON 里的**额外键**会被顺手抹掉。
 * 当时正在落地的那种额外键是轮末异步判定留下的 `ipc_dyad`(用户侧坐标 + 残差对账):
 * 衰减 tick 60 秒叫醒一次(自带 30 分钟桶)⇒ 判定之后 ≤30 分钟,面板上的青点就自己
 * 消失,而且**看起来一切正常**(没有报错、没有日志)。这正是最贵的一类失败。
 *
 * 纪律:衰减只衰减**情绪维**;额外键是别的子系统的账,原样带过去(引用同一个值,不改它)。
 * 已知维一律以 `decayed` 为准(衰减结果不许被原值盖回去)。
 *
 * @param {object} prev 衰减前的向量(真源,可能含额外键)
 * @param {object} decayed 已衰减的向量(通常只含已知维)
 * @returns {object} 新对象(不改入参);`prev` 不是对象 ⇒ 原样返回 `decayed`
 */
export function carryExtraEmotionKeys (prev, decayed) {
  const base = (decayed !== null && typeof decayed === 'object' && !Array.isArray(decayed))
    ? decayed
    : {}
  if (prev === null || typeof prev !== 'object' || Array.isArray(prev)) return { ...base }
  const out = { ...base }
  for (const key of Object.keys(prev)) {
    if (Object.prototype.hasOwnProperty.call(base, key)) continue // 已知维:以衰减结果为准
    out[key] = prev[key] // 额外键:原样带过来
  }
  return out
}
