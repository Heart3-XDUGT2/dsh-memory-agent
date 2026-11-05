/**
 * 联合情绪空间(Echo emotion union space)—— **声明层**:纯数据 + 纯函数。
 *
 * 背景与边界(设计文档:`docs/EMOTION_SPACE.md`,2026-10-05):
 *   · 文献只支持 PAD 与 IPC「共享一条斜轴」:Yik & Russell (2004, *Multivariate
 *     Behavioral Research* 39(2):203–230)实测两个环**只重叠一条轴**(情感环侧 35°、
 *     IPC 侧 71°,N=395);Mehrabian (1995, *J Psychol* 129(5):565–581)显示公共因子
 *     需要三个(pleasantness / dominance / arousability),而 IPC 只有两轴
 *     ⇒ 3 维 vs 2 维,**双向双射在维数上就不可能**。
 *   · 所以本模块**不声明**"两个子空间是同一空间的两个投影"。联合空间是
 *     「三个子空间 + 一条共享轴 + 一条显式桥接」的**工程构造**:
 *
 *         SP_PAD(P, A[, D])  ⊕  SP_IPC(LOV/DOM)  ⊕  SP_IND(独立维)
 *
 *     公共读数用三维基 `{s, a, d}`:
 *       s = 共享轴    —— [literature]  Yik & Russell 2004 / Yik 2010
 *       a = 激活轴    —— [工程假设]    PAD 侧独有(arousal 类),IPC 无对应轴
 *       d = 支配轴    —— [工程假设]    同名(dominance/DOM)但**异刻度**,不可直接比较
 *
 *   · 本文件只做「声明 + 校验 + 量纲换算」:不做动力学(见 `lib/emotion.js`)、
 *     不发帧、不碰库。桥接与往返在 `lib/space-bridge.js`。
 *
 * 标记约定(全仓一致):
 *   [literature] 有文献依据(附出处);[工程假设] 人为钉死,必须可见、可调、可回滚。
 */

/**
 * 跨空间的**不可互推**声明 —— 这句话必须出现在每一处联合空间读数旁边
 * (拍板 ④:接受"工程可逆",但绝不假装两个坐标系是同一个空间)。
 */
export const EQUIVALENCE_NOTE =
  '两套坐标系不等价、不可互推:文献只支持一条共享轴(P×A 与 IPC 的交线),其他轴都是 [工程假设]'

/**
 * Echo 的 `emotionVector` → 联合空间的双极 PAD 读法。
 *
 * 逐维映射(**全部是 [工程假设]** —— 文献没给 F/V/A 与 PAD 的换算,这是
 * 工程取法,面板可调、可回滚):
 *   · `valence`(−10..10) → `p`(−1..1),直接除以 10;
 *   · `arousal`(1..10)  → `a`(−1..1),线性拉伸(3 落在偏负,≈−0.56);
 *   · `dominance`(0..10)→ `d`(−1..1),5 为中性(登记未渲染,这里仍如实换算)。
 * 缺维 / 脏值 ⇒ 该轴 0(原点),并在 `missing` 里记账 —— 不猜。
 *
 * 注意:`fatigue`(疲惫)在 PAD 里**没有对应维**(归独立空间 SP_IND),
 * 因此它不参与这里任何一条换算。
 */
export function echoVectorToBipolar (vector) {
  const global = vector && typeof vector === 'object' && vector.global ? vector.global : {}
  const missing = []
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const v = num(global.valence)
  const a = num(global.arousal)
  const d = num(global.dominance)
  if (v === null) missing.push('valence')
  if (a === null) missing.push('arousal')
  if (d === null) missing.push('dominance')
  const lo = NATIVE_RANGES['global.arousal'][0]
  const hi = NATIVE_RANGES['global.arousal'][1]
  return {
    p: v === null ? 0 : clampAxis(v / 10),
    a: a === null ? 0 : clampAxis(((a - lo) / (hi - lo)) * 2 - 1),
    d: d === null ? 0 : clampAxis((d - 5) / 5),
    missing,
    note: '[工程假设] F/V/A → PAD 的取法,面板可调可回滚;fatigue 不参与(归独立空间)'
  }
}

/**
 * 严格取数:`null` / `undefined` / `''` / 非有限 ⇒ `null`。
 * 注意 `Number(null) === 0` —— 少了这道闸,"缺维"会被当成"真值 0"。
 */
function finiteOrNull (value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * [工程假设] dominance 的反推口径(用户拍板 D1 / D2 / D3,2026-10-05)。
 *
 * 为什么要它:PAD 立方体要三轴,而 `global.dominance` 是"登记未渲染"
 * (拍板 ①)—— 活库里它永远是出厂中性值,立方体的 D 轴会是**死的**。
 * 用户拍板:先**反推**,等打分器愿意输出实测 dominance(方案 C)再接管。
 *
 * 依据:依赖 ↑ ⇒ 支配 ↓(friendly-submissive)。**这与已经发货的 IPC 字典同源**
 * —— `lib/emotion-ipc-bridge.js` 的 `IPC_MAP.dependency` 就是 `{axis:'a', invert:true}`。
 * 两处同一条假设,所以不会出现"PAD 说高支配、IPC 说低掌控"这种自相矛盾。
 *
 * 纪律(D3):**只作显示** —— 不回写 `emotionVector`、不进提示词、不落库。
 */
export const DOMINANCE_DERIVATION_NOTE =
  '[工程假设] 依赖 ↑ ⇒ 支配 ↓(friendly-submissive;与 IPC_MAP 的 dependency→agency invert 同源)'

/**
 * 未来开关:**方案 C(打分器实测 dominance)上线后置 `true`**,实测即接管;
 * 今天为 `false` = 推导优先(因为现在向量里的 dominance 是出厂中性值,不是测量)。
 * 切换只动这一个常量 —— 面板与审计都按 `dSource` 显示来源,不会静默换口径。
 */
export const DOMINANCE_PREFER_MEASURED = false

/**
 * 依赖 → 支配(原生 [0,10] + 双极 [-1,1])。
 * 反推的"反"就是量程反射:`native = hi + lo − dependency`(依赖 0 ⇒ 支配 10)。
 * 缺维 / 脏值 ⇒ `null`(**不猜 0**)。
 */
export function dominanceFromDependency (dependency) {
  const n = finiteOrNull(dependency)
  if (n === null) return null
  const range = NATIVE_RANGES['target_master.dependency']
  const native = clampTo(range[1] + range[0] - n, range[0], range[1])
  return {
    native,
    bipolar: nativeToAxis(native, NATIVE_RANGES['global.dominance']),
    source: 'derived',
    from: 'target_master.dependency',
    assumption: DOMINANCE_DERIVATION_NOTE
  }
}

/**
 * **显示口径**的 PAD 读法:`p` / `a` 照实测,`d` 走「推导优先 → 实测 → 缺」。
 * 返回 `{p, a, d, dSource, missing, note}`;`dSource ∈ 'derived' | 'measured' | null`。
 * 纯函数:不改传入的向量(D3:只显示,不回写)。
 */
export function padBipolarFromVector (vector) {
  const measured = echoVectorToBipolar(vector)
  const tm = vector && typeof vector === 'object' && vector.target_master ? vector.target_master : {}
  const derived = dominanceFromDependency(tm.dependency)
  const hasMeasured = !(measured.missing || []).includes('dominance')
  const missing = (measured.missing || []).filter((k) => k !== 'dominance')
  let d = measured.d
  let dSource = hasMeasured ? 'measured' : null
  if (derived !== null && (!hasMeasured || DOMINANCE_PREFER_MEASURED === false)) {
    d = derived.bipolar
    dSource = 'derived'
  } else if (!hasMeasured && derived === null) {
    missing.push('dominance')
  }
  return { p: measured.p, a: measured.a, d, dSource, missing, note: measured.note }
}

/** 空间标识 + 版本。改基/改归属都要动它(便于审计回溯)。 */
export const SPACE_ID = 'echo.emotion.union.v1'

/**
 * 三维基。三轴一律**双极 [-1, 1]**,原点 0 = 中性。
 * 注意:`a` 是"激活(activation)",**不是** IPC 的 `a`(agency/主导性)——
 * 命名冲突是 IPC 源码的历史包袱(`core/circumplex.js:66` 用 `a` 指主导性),
 * 本模块内部一律称 IPC 那一轴为 `agency`,避免歧义。
 */
export const BASIS = Object.freeze({
  s: Object.freeze({
    axis: 's', label: '共享轴', range: [-1, 1], origin: 0,
    meaning: '情感环与 IPC 实测共享的那条斜轴(愉快激活 ↔ 不愉快失活方向)',
    provenance: 'literature',
    source: 'Yik & Russell 2004 (MBR 39(2):203–230):35°(情感侧)/ 71°(IPC 侧)'
  }),
  a: Object.freeze({
    axis: 'a', label: '激活轴', range: [-1, 1], origin: 0,
    meaning: '与共享轴正交的激活/唤醒方向;IPC 侧无对应轴(投影时丢弃)',
    provenance: 'engineering',
    source: '[工程假设] 取共享轴的正交补;PAD 侧由 (P, A) 旋转得到'
  }),
  d: Object.freeze({
    axis: 'd', label: '支配轴', range: [-1, 1], origin: 0,
    meaning: '支配/主导方向:PAD 的 D 与 IPC 的 DOM 同名但刻度不同',
    provenance: 'engineering',
    source: '[工程假设] 默认 θ_d = 0(即 d := D / DOM);刻度靠 λ_d 标定'
  })
})

/** 三个子空间的身份、量程、原点、单位 —— "各算各的"的账本。 */
export const SUBSPACES = Object.freeze({
  SP_PAD: Object.freeze({
    id: 'SP_PAD',
    label: 'PAD 子空间',
    native: 'P ∈ [-10,10](Echo `global.valence`)、A ∈ [1,10](Echo `global.arousal`)、D 已登记未启用',
    unit: '先各自仿射到 [0,1],再折成双极 [-1,1] 才进基',
    origin: '0 = 中性;P 的无偏点在 0(`valence` 0),A 的无偏点在低值端',
    note: 'Echo 的 global 是 **F/V/A**(fatigue/valence/arousal),不是 PAD:P/D 需另行登记'
  }),
  SP_IPC: Object.freeze({
    id: 'SP_IPC',
    label: 'IPC 子空间',
    native: 'c ∈ [0,1](亲近度/communion)、agency ∈ [0,1](主导性/dominance);单极',
    unit: '单极 [0,1],0° 指向 +c,逆时针为正(`core/circumplex.js:55-56`)',
    origin: '0 = 该维最低端(不是中性);比较前必须先双极化',
    note: '二维系 + 两条**扩展维**(playfulness / sadness),扩展维不参与几何旋转'
  }),
  SP_IND: Object.freeze({
    id: 'SP_IND',
    label: '独立维',
    native: 'fatigue ∈ [0,10]、longing.value、user_profile.affinity',
    unit: '各自原生单位,**不参与**任何跨空间换算',
    origin: '各维自定',
    note: '独立维只在渲染层成段出现,禁止与共享轴数字相加'
  })
})

/**
 * 维度归属表:Echo 的每个维度归哪个子空间。
 * `axis` 只对进基的维度有意义;`kind: 'extended'` = IPC 二维系之外的扩展维;
 * `kind: 'registered-only'` = 已登记、暂不渲染(用户拍板 ①)。
 */
export const DIM_OWNERSHIP = Object.freeze({
  'global.fatigue': Object.freeze({ subspace: 'SP_IND', label: '疲惫', kind: 'independent' }),
  'global.valence': Object.freeze({ subspace: 'SP_PAD', axis: 'p', label: '心情', kind: 'axis' }),
  'global.arousal': Object.freeze({ subspace: 'SP_PAD', axis: 'a', label: '唤醒度', kind: 'axis' }),
  'global.dominance': Object.freeze({
    subspace: 'SP_PAD', axis: 'd', label: '支配', kind: 'registered-only',
    note: '用户拍板 ①:登记、先不渲染(留口子)'
  }),
  'target_master.affection': Object.freeze({ subspace: 'SP_IPC', axis: 'c', label: '爱意', kind: 'axis' }),
  'target_master.dependency': Object.freeze({ subspace: 'SP_IPC', axis: 'agency', label: '依赖', kind: 'axis' }),
  'target_master.playfulness': Object.freeze({
    subspace: 'SP_IPC', label: '调皮', kind: 'extended',
    note: '用户拍板 ②:作为扩展维保留,不压进二维系'
  }),
  'target_master.sadness': Object.freeze({
    subspace: 'SP_IPC', label: '委屈', kind: 'extended',
    note: '用户拍板 ②:作为扩展维保留(线索:submissive-cold 区)'
  }),
  'longing.value': Object.freeze({ subspace: 'SP_IND', label: '想念', kind: 'independent' }),
  'user_profile.affinity': Object.freeze({ subspace: 'SP_IND', label: '好感度', kind: 'independent' })
})

/** Echo 侧原生量程(与 `lib/emotion.js` 的 EMOTION_RANGES 保持一致,只读引用)。 */
export const NATIVE_RANGES = Object.freeze({
  'global.fatigue': Object.freeze([0, 10]),
  'global.valence': Object.freeze([-10, 10]),
  'global.arousal': Object.freeze([1, 10]),
  'global.dominance': Object.freeze([0, 10]), // 登记用:中性 5.0
  'target_master.affection': Object.freeze([0, 10]),
  'target_master.playfulness': Object.freeze([0, 10]),
  'target_master.sadness': Object.freeze([0, 10]),
  'target_master.dependency': Object.freeze([0, 10])
})

/** 归零向量(所有轴 0)。 */
export function emptyUnion () {
  return { s: 0, a: 0, d: 0 }
}

/** 夹到 [lo, hi];非有限数 ⇒ 回原点(绝不抛)。 */
export function clampTo (value, lo, hi) {
  const n = Number(value)
  if (!Number.isFinite(n)) return lo <= 0 && hi >= 0 ? 0 : lo
  return Math.min(hi, Math.max(lo, n))
}

/** 夹到基的范围 [-1,1]。 */
export function clampAxis (value) {
  return clampTo(value, -1, 1)
}

/** 原生量程 → 单极 [0,1](`lo..hi` 线性映射)。 */
export function nativeToUnit (value, range) {
  const lo = Number(range[0]); const hi = Number(range[1])
  const n = Number(value)
  if (!Number.isFinite(n) || !(hi > lo)) return 0
  return clampTo((n - lo) / (hi - lo), 0, 1)
}

/** 单极 [0,1] → 原生量程。 */
export function unitToNative (unit, range) {
  const lo = Number(range[0]); const hi = Number(range[1])
  const u = clampTo(unit, 0, 1)
  if (!(hi > lo)) return lo
  return lo + u * (hi - lo)
}

/** 单极 [0,1] → 双极 [-1,1]。 */
export function unitToBipolar (unit) {
  return clampAxis(clampTo(unit, 0, 1) * 2 - 1)
}

/** 双极 [-1,1] → 单极 [0,1]。 */
export function bipolarToUnit (axis) {
  return clampTo((clampAxis(axis) + 1) / 2, 0, 1)
}

/** 原生值直接折成基坐标(仿射两跳)。 */
export function nativeToAxis (value, range) {
  return unitToBipolar(nativeToUnit(value, range))
}

/** 基坐标折回原生值。 */
export function axisToNative (axis, range) {
  return Math.round(unitToNative(bipolarToUnit(axis), range) * 10) / 10
}

/**
 * 校验一个联合读数:未知键丢弃、非有限数记问题、越界夹取。
 * 返回 `{ ok, union, issues }` —— 永不抛。
 */
export function validateUnion (raw) {
  const issues = []
  const union = emptyUnion()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push('not-an-object')
    return { ok: false, union, issues }
  }
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(BASIS, key)) {
      issues.push(`unknown-axis:${key}`)
      continue
    }
    const n = Number(raw[key])
    if (!Number.isFinite(n)) {
      issues.push(`not-finite:${key}`)
      continue
    }
    if (n < -1 || n > 1) issues.push(`clamped:${key}`)
    union[key] = clampAxis(n)
  }
  for (const key of Object.keys(BASIS)) {
    if (!Object.hasOwn(raw, key)) issues.push(`missing-axis:${key}`)
  }
  return { ok: issues.length === 0, union, issues }
}

/** 归属查询:`global.valence` → 条目;未知 ⇒ null。 */
export function ownershipOf (dimKey) {
  return Object.hasOwn(DIM_OWNERSHIP, dimKey) ? DIM_OWNERSHIP[dimKey] : null
}

/** 某子空间下的全部维度键(渲染层与测试都用它)。 */
export function dimsOfSubspace (subspaceId) {
  return Object.keys(DIM_OWNERSHIP).filter((k) => DIM_OWNERSHIP[k].subspace === subspaceId)
}

/**
 * 供审计/文档用的一行摘要 —— 也用来把"哪些是文献、哪些是工程"钉在运行时。
 */
export function describeSpace () {
  const lit = Object.values(BASIS).filter((x) => x.provenance === 'literature').length
  const eng = Object.values(BASIS).length - lit
  return `${SPACE_ID}: 基 {s,a,d}(${lit} 文献 / ${eng} 工程假设);` +
    ` 子空间 ${Object.keys(SUBSPACES).join(' + ')};` +
    ` 归属 ${Object.keys(DIM_OWNERSHIP).length} 维;` +
    ' 声明:PAD 与 IPC 不等价、不宣称双向双射(Yik & Russell 2004 只共享一条轴)'
}
