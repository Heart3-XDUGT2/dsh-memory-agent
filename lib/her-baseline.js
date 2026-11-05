/**
 * 人格基线(`herBaseline`)—— 立方体里那个"她平时在哪个情绪档"的静止点(拍板 ⑦⑧,2026-10-06)。
 *
 * 设计全文见桌面的 `情绪面板缺口补齐设计-2026-10-06.md` §2。口径三条:
 *
 *   1. **只做 P/A 两维,`d` 恒 `null`** —— `dominance` 在本仓是"已登记未启用"
 *      (`lib/emotion-space.js` 的 `DIM_OWNERSHIP['global.dominance'].kind = 'registered-only'`)
 *      ⇒ 基线**不许**把第三维编出来。
 *   2. **原生值口径**(与 `global.valence` / `global.arousal` 同量纲),**不经联合空间桥接**:
 *      基线是"她是谁"的声明,不是"两套坐标系对齐后的读数";要画到立方体上时由
 *      `baselineUnit()` 现算双极坐标,桥接层一个字都不参与。
 *   3. **手填为主,均值只作辅助**:`source` 如实标注 `manual` / `mean` / `inferred`,
 *      程序不替用户改数(要改就他改)。
 *
 * 存哪:settings(`config.json`)—— 与 `bridge*` 那组标定参数同处,复用现成的面板
 * 字段机制(`lib/settings-fields.js` + `lib/toggle.js`),**不新增数据文件**。
 *
 * 该模块是**纯函数**集合:不读文件、不写库(settings 由调用方传进来)。
 */

import { NATIVE_RANGES, nativeToAxis } from './emotion-space.js'

/** 允许的来源标记(面板乱填 ⇒ 回落 manual)。 */
export const BASELINE_SOURCES = Object.freeze(['manual', 'mean', 'inferred'])

/** 出厂:没填 = 没有基线(`set: false`,立方体那块照旧整块跳过)。 */
export const DEFAULT_HER_BASELINE = Object.freeze({
  p: null,
  a: null,
  d: null,
  source: 'manual',
  updatedAt: null
})

const numOr = (v, fb = null) => {
  if (v === null || v === undefined || v === '') return fb
  const n = Number(v)
  return Number.isFinite(n) ? n : fb
}
const clampNum = (v, lo, hi, fb) => {
  const n = numOr(v, null)
  if (n === null) return fb
  return Math.min(hi, Math.max(lo, n))
}
const round1 = (x) => Math.round(x * 10) / 10

/**
 * 归一一份基线(面板乱填也不炸;`d` 一律 `null`)。
 * @param {object} [raw] `settings.herBaseline`(或任何同形状对象)
 * @returns {{p:number|null,a:number|null,d:null,source:string,updatedAt:number|null,set:boolean}}
 */
export function resolveHerBaseline (raw = {}) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  const p = clampNum(r.p, -10, 10, null)
  const a = clampNum(r.a, 1, 10, null)
  const source = BASELINE_SOURCES.includes(String(r.source)) ? String(r.source) : 'manual'
  const updatedAt = numOr(r.updatedAt, null)
  return {
    p: p === null ? null : round1(p),
    a: a === null ? null : round1(a),
    d: null, // 硬约定:dominance 未启用,基线不给第三维
    source,
    updatedAt,
    // 两个数都填了才算"有基线";只填一个 = 没填(不半画一个点)
    set: p !== null && a !== null
  }
}

/** 从 settings 读基线(**扁平键**:`herBaselineEnabled` / `herBaselineP` / `herBaselineA` / …)。 */
export function readBaseline (settings) {
  const s = (settings && typeof settings === 'object') ? settings : {}
  const has = (v) => v !== null && v !== undefined && v !== ''
  const flat = {
    p: s.herBaselineP,
    a: s.herBaselineA,
    source: s.herBaselineSource,
    updatedAt: s.herBaselineUpdatedAt
  }
  // 兼容:老/外部形状若给了嵌套对象,而扁平键全空,就认嵌套那份(只读侧宽容,写侧仍走扁平)。
  const nested = (s.herBaseline && typeof s.herBaseline === 'object' && !Array.isArray(s.herBaseline))
    ? s.herBaseline
    : null
  const raw = (has(flat.p) || has(flat.a)) ? flat : (nested ?? flat)
  const out = resolveHerBaseline(raw)
  // 总闸:关着 = 没有基线(哪怕数还在配置里)⇒ 立方体整块跳过,不画假点。
  return { ...out, enabled: s.herBaselineEnabled === true, set: s.herBaselineEnabled === true && out.set }
}

/**
 * 用最近 N 轮的向量算一个**建议**基线(辅助按钮用;不落库、不替用户做决定)。
 *
 * 只吃 `global.valence` / `global.arousal`(`global.fatigue` 归独立空间,不参与);
 * 一条有效样本都没有 ⇒ `null`(不编、不用默认值充数)。
 * @param {Array<object>} vectors 审计行/状态里的 `emotion_vector`(任意顺序)
 * @param {object} [options] `{ limit = 30 }` 只看最近多少条有效样本
 */
export function baselineFromMean (vectors, options = {}) {
  const limit = Math.max(1, Math.min(500, Number(options.limit) || 30))
  const rows = Array.isArray(vectors) ? vectors : []
  const ps = []
  const as = []
  for (const v of rows) {
    const g = v && typeof v === 'object' && v.global && typeof v.global === 'object' ? v.global : null
    if (g === null) continue
    const p = numOr(g.valence, null)
    const a = numOr(g.arousal, null)
    if (p === null || a === null) continue
    ps.push(p)
    as.push(a)
  }
  const useP = ps.slice(-limit)
  const useA = as.slice(-limit)
  const n = Math.min(useP.length, useA.length)
  if (n === 0) return null
  const mean = (xs) => xs.slice(-n).reduce((s, x) => s + x, 0) / n
  return {
    p: round1(mean(useP)),
    a: round1(mean(useA)),
    d: null,
    source: 'mean',
    updatedAt: Date.now(),
    set: true,
    n,
    note: '[工程假设] 最近 ' + String(n) + ' 轮的平均心情/唤醒;填进面板后由他确认(source 标 mean)'
  }
}

/**
 * 基线 → 立方体用的**双极**坐标([−1,1],与 `padBipolarFromVector` 同一口径)。
 * 拿不到 ⇒ `null`(面板整块跳过,不画一个假的点)。
 */
export function baselineUnit (baseline) {
  // `readBaseline()` 的产出带 `enabled`:总闸关着 ⇒ 一律没有(不画假点)。
  if (baseline && typeof baseline === 'object' && baseline.enabled === false) return null
  const b = resolveHerBaseline(baseline)
  if (!b.set) return null
  try {
    return {
      p: nativeToAxis(b.p, NATIVE_RANGES['global.valence']),
      a: nativeToAxis(b.a, NATIVE_RANGES['global.arousal']),
      d: null // 未启用维:不画
    }
  } catch { return null }
}

/** 一行人话(面板/文档用;**不进 prompt**)。没填 ⇒ `null`。 */
export function describeBaseline (baseline) {
  if (baseline && typeof baseline === 'object' && baseline.enabled === false) return null
  const b = resolveHerBaseline(baseline)
  if (!b.set) return null
  const srcZh = b.source === 'mean' ? '(最近若干轮均值)' : (b.source === 'inferred' ? '(由人格文本推断)' : '(手填)')
  return '人格基线:P ' + String(b.p) + ' / A ' + String(b.a) + ' ' + srcZh + ' · d 未启用'
}
