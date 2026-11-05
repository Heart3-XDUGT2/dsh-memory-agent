/**
 * DMAE 幂律遗忘模型 —— 从 AstrBot brain_pipeline.py 原样移植(v6.0 数学)。
 * 纯函数、零依赖,是 tests/dmae.test.js 的靶子。
 *
 * 核心三式:
 *   R(Δt) = 1 / (1 + Δt/H)          幂律可回忆度:Δt=H 时 R=0.5,
 *                                    长尾永不归零 —— 长期陪伴的前提
 *   H0   = h_min · (I/i_ref)^γ      内在价值决定"起手能记多久"
 *   H'   = H · (1 + k·(1 − R_想起时))  间隔效应:快忘掉时才想起 → 增益大
 */

export const DMAE_DEFAULT = Object.freeze({
  maxScore: 100.0,
  hMin: 24.0,        // 最低半衰期(小时)
  iRef: 10.0,        // 内在价值参考量
  gamma: 1.2,        // H0 幂指数
  kReinforce: 1.8,   // 间隔效应增益系数
  rActive: 0.5,      // R ≥ 此值 → Active
  rDormant: 0.1      // R ≥ 此值 → Dormant,否则 Archived
})

/** 幂律可回忆度。half_life 非法(≤0/空)时返回 0 —— 与 Python 版一致。 */
export function retrievability (dtHours, halfLife) {
  if (halfLife === null || halfLife === undefined || Number(halfLife) <= 0) return 0.0
  const dt = Math.max(0.0, Number(dtHours) || 0.0)
  return 1.0 / (1.0 + dt / Number(halfLife))
}

/** H0 = h_min · (I / i_ref)^γ。I 至少取 1,防止 0 幂。 */
export function initialHalfLife (intrinsicValue, params = DMAE_DEFAULT) {
  const i = Math.max(1.0, Number(intrinsicValue) || 0.0)
  return params.hMin * Math.pow(i / params.iRef, params.gamma)
}

/** 间隔效应强化:快忘掉时才想起 → 增益大;刚想起过又想起 → 增益小。 */
export function reinforceHalfLife (halfLife, rAtRecall, params = DMAE_DEFAULT) {
  const h = Math.max(1e-6, Number(halfLife) || 0.0)
  const r = Math.min(1.0, Math.max(0.0, Number(rAtRecall) || 0.0))
  return h * (1.0 + params.kReinforce * (1.0 - r))
}

/** 三态划分。Archived 仍可被直接命中唤醒,只是不参与扩散(M2 图记忆用)。 */
export function deriveState (r, params = DMAE_DEFAULT) {
  if (r >= params.rActive) return 'Active'
  if (r >= params.rDormant) return 'Dormant'
  return 'Archived'
}
