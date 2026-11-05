/**
 * Echo 维度 ↔ IPC 子空间 的映射(拍板 ②⑦⑧:只读、双向、扩展维保留)。
 *
 * 映射表(**除标注外都是 [工程假设]** —— 文献只给了"一条共享轴",没给这套字典):
 *   · `affection`(爱意)  → `c`(亲近度 / communion)      [推断:爱意是亲近的正向表达]
 *   · `dependency`(依赖) → `a`(掌控 / agency),**反向**  [推断:依赖 = friendly-submissive ⇒ 低掌控]
 *   · `playfulness`(调皮) / `sadness`(委屈) → **扩展维**(拍板 ②:不压进二维系)
 *
 * 两条硬规矩:
 *   1. **只读**:本模块不写库、不写向量、不改入参对象(拍板 ⑧"先只读");
 *   2. **不假装可逆**:`ipcToEcho` 给出的是"建议值",带 `assumed: true`,
 *      调用方要用它写库必须自己拍板(当前没有任何调用方这么做)。
 *
 * 主人一侧的坐标(拍板 ⑧"Echo 与主人各一套")在本版**只接受外部传入**:
 * 拿不到就标 `otherMissing: true` —— 不猜、不编(QQ 侧的打分器还没接)。
 */
import { NATIVE_RANGES, nativeToUnit, unitToNative, clampAxis } from './emotion-space.js'

/** IPC 坐标默认值(中性:圆盘中心)。 */
export const NEUTRAL_IPC = Object.freeze({ a: 0.5, c: 0.5 })

/** 映射方向表(改这里就等于改字典;全部 [工程假设])。 */
export const IPC_MAP = Object.freeze({
  affection: Object.freeze({ axis: 'c', invert: false, note: '[工程假设] 爱意 ↑ ⇒ 亲近 ↑' }),
  dependency: Object.freeze({ axis: 'a', invert: true, note: '[工程假设] 依赖 ↑ ⇒ 掌控 ↓(friendly-submissive)' }),
  playfulness: Object.freeze({ axis: null, ext: true, note: '[工程假设] 扩展维:只透传,不旋转' }),
  sadness: Object.freeze({ axis: null, ext: true, note: '[工程假设] 扩展维:只透传,不旋转' })
})

/**
 * Echo 的情绪向量 → IPC 坐标 + 扩展维。
 * 只读:不改 `vector`;缺维按中性处理并在 `missing` 里记账。
 */
export function echoToIpc (vector) {
  const tm = vector && typeof vector === 'object' && vector.target_master
    ? vector.target_master
    : {}
  const missing = []
  const unit = (dim) => {
    const raw = tm[dim]
    if (raw === undefined || raw === null || !Number.isFinite(Number(raw))) { missing.push(dim); return null }
    return nativeToUnit(Number(raw), NATIVE_RANGES[`target_master.${dim}`])
  }
  const aff = unit('affection')
  const dep = unit('dependency')
  const play = unit('playfulness')
  const sad = unit('sadness')
  const point = {
    c: aff === null ? NEUTRAL_IPC.c : aff,
    a: dep === null ? NEUTRAL_IPC.a : 1 - dep // invert:true
  }
  return {
    point: { a: round3(point.a), c: round3(point.c) },
    ext: {
      playfulness: play === null ? null : round3(play),
      sadness: sad === null ? null : round3(sad)
    },
    missing,
    assumed: true,
    note: '[工程假设] 爱意→c、依赖→(1−a);扩展维只透传'
  }
}

/**
 * IPC 坐标 → Echo 维度的**建议值**(不落地;`assumed: true` 提醒调用方)。
 * 扩展维原样带回;`affinity` 之类独立维不在这里碰。
 */
export function ipcToEcho (ipc = {}) {
  const pt = { a: clamp01(ipc.a), c: clamp01(ipc.c) }
  const ext = ipc.ext && typeof ipc.ext === 'object' ? ipc.ext : {}
  const out = {
    affection: round1(unitToNative(pt.c, NATIVE_RANGES['target_master.affection'])),
    dependency: round1(unitToNative(1 - pt.a, NATIVE_RANGES['target_master.dependency']))
  }
  if (Number.isFinite(Number(ext.playfulness))) {
    out.playfulness = round1(unitToNative(Number(ext.playfulness), NATIVE_RANGES['target_master.playfulness']))
  }
  if (Number.isFinite(Number(ext.sadness))) {
    out.sadness = round1(unitToNative(Number(ext.sadness), NATIVE_RANGES['target_master.sadness']))
  }
  return { target_master: out, assumed: true, note: '[工程假设] 建议值,不是文献换算;扩展维原样带回' }
}

/**
 * 双人视角(拍板 ⑧"Echo 与主人各一套坐标,双向,先只读")。
 * `other` 缺失 ⇒ `otherMissing: true`,不猜对方位置。
 */
export function dyad (echoVector, otherPoint = null) {
  const self = echoToIpc(echoVector)
  const other = otherPoint && Number.isFinite(Number(otherPoint.a)) && Number.isFinite(Number(otherPoint.c))
    ? { a: clamp01(otherPoint.a), c: clamp01(otherPoint.c) }
    : null
  return {
    self: self.point,
    other,
    otherMissing: other === null,
    ext: self.ext,
    missing: self.missing,
    note: other === null
      ? '[工程假设] 主人一侧坐标未接入(QQ 侧打分器未接):关系代数只能单边算'
      : '[工程假设] 双方坐标均在;关系代数可用'
  }
}

const clamp01 = (x) => {
  const n = Number(x)
  if (!Number.isFinite(n)) return 0.5
  return clampAxis(n * 2 - 1) * 0.5 + 0.5
}
const round1 = (x) => Math.round(x * 10) / 10
const round3 = (x) => Math.round(x * 1000) / 1000
