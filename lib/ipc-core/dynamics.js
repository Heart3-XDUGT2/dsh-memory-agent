/**
 * 双人关系动力学：惯性、非互补升级，以及「网格 + 连续残差」的量化方案。
 *
 * ## ⚠️ 这里刻意**没有**时间项
 *
 * 本模块曾经实现过「按半衰期向基线回归」的衰减（双方各自回到人际基线），并配了一套
 * 「停机冻结」（把状态时钟平移停机时长，好让隔夜重启不把关系衰减掉）。**这两样都已删除**：
 *
 * - 需求上不需要「随时间变化」：关系只在**有新证据**（一次打分）时改变；
 * - 时间项会让「同一段对话、不同的挂钟间隔」跑出不同结果，状态因此不可复现——
 *   测起来要额外注入时钟、比对时要额外对齐 `updatedAt`，而它带来的表达力
 *  （「一周没联系所以淡了」）在单次会话里用不上；
 * - 「停机冻结」是在给时间项打补丁：一旦没有时间项，停机多久都不会影响状态，
 *   那套 `savedAt` / `shiftClock` / 文件 mtime 兜底的机制就整体失去了存在意义。
 *
 * 因此现在的规则非常直白：**状态只有两个来源——上一轮的状态，和这一轮的打分。**
 * `updatedAt` 仍然记录，但纯粹是可读的元数据，不参与任何计算。
 *
 * ## 保留的三件事
 *
 * 1. **惯性**：人际关系不会因为一句话就反转。新的打分按 `reactivity` 与旧状态做凸组合，
 *    于是关系具有连续性。
 * 2. **非互补升级**：这是 IPC 相对 PAD 多出来的一条动力学。
 *
 *    ⚠️ **先说清楚它的证据等级，别把它当成定论。** 「非互补的交易会诱发行为强化
 *    （transactional escalation）」这个说法确实存在于人际理论里，但本项目**没有取得
 *    能逐字引用的一手来源**：唯一查到的是 SITAR 文档里的一句转述
 *    （"According to Van Denburg and Kiesler, an implicit assumption of interpersonal
 *    theory, the principle of transactional escalation…"），而 Kiesler (1983) 正文与
 *    Kiesler & Van Denburg 都没能读到。同时 Orford (1986) 的论文标题本身就是对这个
 *    规则的反问（《The rules of interpersonal complementarity: Does hostility beget
 *    hostility and dominance, submission?》）。
 *
 *    所以这一项在本项目里的定位是**一个明确标注的建模选择**，而不是「按 Kiesler 的
 *    结论实现」。默认速率刻意取小（0.25），并且可以一键关成 0。任何对外说明都应当
 *    这样表述，不能写成「Kiesler 证明了非互补会导致升级」。
 *
 *    它做的事是：互补性低时，双方沿各自当前方向向外扩张——在向量空间里把两个向量
 *    同时放大 `1 + escalation × (阈值 − 互补性下界)`。互补性达标时不放大。
 *
 *    这里**没有**「向互补位置吸引」这一项。那是常见的误读：这个机制说的是非互补时
 *    行为**强化**，不是「自动收敛到互补」。
 * 3. **网格 + 残差**：对外暴露的状态严格落在 0.1 网格上（可观测、可枚举、可写进
 *    日志），内部另存连续值 `latent`。只存量化值的话，一次 `+0.03` 的微调会被
 *    四舍五入抹掉，关系将永远卡在同一个格子里——残差累积让微小但持续的推动
 *    最终仍能跨过格子边界。
 *
 * @module dsh-interpersonal-circumplex/core/dynamics
 */

import {
  AXES,
  MAX_RADIUS,
  NEUTRAL,
  clamp01,
  clampVectorToDisk,
  complementarityOf,
  distance,
  quantize,
  quantizePoint,
} from './circumplex.js';

/** 默认动力学参数。全部可被插件配置覆盖。 */
export const DEFAULT_DYNAMICS = Object.freeze({
  /** 角色的人际基线：无外部证据时状态停留的位置。 */
  baselineSelf: NEUTRAL,
  /** 用户的人际基线（角色对用户的默认预期）。 */
  baselineOther: NEUTRAL,
  /**
   * 单轮响应系数：0 表示关系完全不动，1 表示完全跟随最新打分。
   *
   * 与 PAD 相同的算术约束：实际位移是 `(目标 − 当前) × reactivity × confidence`，
   * 而**小于半格（0.05）的位移在 0.1 网格上等于零**。一次「离中心一格」的打分
   * （目标 0.4）配上常见的 0.7 置信度，需要 `reactivity > 0.714` 才跨得过格子
   * 边界。低于这个数，双方会永远停在中心，关系读数失去可观测性。
   */
  reactivity: 0.8,
  /** 单轮单轴允许的最大变化幅度，防止一次极端打分把某一方甩到圆盘角落。 */
  maxStepPerTurn: 0.4,
  /** 中性区半径（欧氏距离），用于 `isNeutral`。 */
  neutralRadius: 0.1,
  /**
   * 非互补升级速率。0 表示关闭该项。
   *
   * 每一项都乘 `(escalationThreshold − 互补性下界)`，因此达标时恰好为 0，不会造成
   * 额外漂移；下界为 0（某个轴完全错位）时单轮最多把向量放大
   * `escalation × threshold`。默认 0.25 × 0.5 = 12.5% 的单轮扩张。
   *
   * ⚠️ 这里用的是**下界**（{@link import('./circumplex.js').complementarityOf} 的
   * `complementarityFloor`）而不是均值，这是刻意的：互补性在理论上要求两个轴**同时**
   * 成立，任一轴不被确认就意味着这次交易没有被确认。用均值会漏掉 `温暖 × 敌对`
   * 这类「掌控完美对上、联结完全相反」的情形——而那正是最该升级的一种。
   */
  escalation: 0.25,
  /** 互补性下界低于此值才触发升级。默认 0.5，即「任一轴错位超过一半」。 */
  escalationThreshold: 0.5,
});

/**
 * 校验并补全动力学配置。
 *
 * ⚠️ **只接受已知的键，未知键一律丢弃**，而不是原样透传。这不是洁癖：旧版本写下的
 * `state.json` 里带着 `halfLifeMs`，而恢复路径会把磁盘上的 `dynamics` 与配置合并后
 * 交给本函数。若在这里透传未知键，那个已经失效的 `halfLifeMs` 就会一直留在内存状态里、
 * 并在下一次落盘时被写回——一个已经不存在的参数会像幽灵一样永远跟着状态文件。
 * @param {Partial<typeof DEFAULT_DYNAMICS>} [input] 用户配置。
 * @returns {typeof DEFAULT_DYNAMICS} 冻结后的完整配置。
 * @throws {TypeError} 当数值字段非法时。
 */
export function resolveDynamics(input = {}) {
  const merged = {};
  for (const key of Object.keys(DEFAULT_DYNAMICS)) {
    merged[key] = input?.[key] === undefined ? DEFAULT_DYNAMICS[key] : input[key];
  }
  for (const key of [
    'reactivity', 'maxStepPerTurn', 'neutralRadius', 'escalation', 'escalationThreshold',
  ]) {
    const value = merged[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`dynamics.${key} 必须是非负有限数，收到 ${String(value)}`);
    }
  }
  if (merged.reactivity > 1) throw new TypeError('dynamics.reactivity 不能大于 1');
  if (merged.escalation > 1) throw new TypeError('dynamics.escalation 不能大于 1');
  if (merged.escalationThreshold > 1) throw new TypeError('dynamics.escalationThreshold 不能大于 1');
  return Object.freeze({
    ...merged,
    baselineSelf: quantizePoint(merged.baselineSelf ?? NEUTRAL),
    baselineOther: quantizePoint(merged.baselineOther ?? NEUTRAL),
  });
}

/**
 * 按 `reactivity × gain` 把单个点向目标混合，并限制单轴步长。
 * @param {{a:number,c:number}} from 起点。
 * @param {{a:number,c:number}} target 目标（打分结果）。
 * @param {number} reactivity 混合系数 0~1。
 * @param {number} maxStepPerTurn 单轴最大步长。
 * @returns {{point:{a:number,c:number}, delta:{a:number,c:number}}} 结果与位移。
 */
function mixToward(from, target, reactivity, maxStepPerTurn) {
  const point = {};
  const delta = {};
  for (const axis of AXES) {
    const start = from[axis];
    const goal = clamp01(target[axis]);
    let next = start + (goal - start) * reactivity;
    const step = next - start;
    if (Math.abs(step) > maxStepPerTurn) {
      next = start + Math.sign(step) * maxStepPerTurn;
    }
    next = clamp01(next);
    point[axis] = next;
    delta[axis] = next - start;
  }
  return { point, delta };
}

/**
 * 把单个点的向量沿原方向放大，模拟「非互补 → 行为升级」。
 *
 * 在向量空间里做缩放而不是逐轴乘系数：逐轴缩放会改变**方向**（除非恰好是
 * 分仪正中心方向），于是升级会顺带扭曲人际主题，而理论说的是「沿原方向走得更
 * 远、而不是换一个方向」。缩放在中心处自然无效（零向量放不出方向），这也是
 * 对的：没有姿态就没有可升级的姿态。
 *
 * 缩放后若越出圆盘，按向量长度夹到边缘，因此结果一定落在合法范围内。
 * @param {{a:number,c:number}} point 连续状态。
 * @param {number} factor 放大比例（0.1 表示放大 10%）。
 * @returns {{point:{a:number,c:number}, moved:number}} 结果与位移量。
 */
export function escalate(point, factor) {
  if (!(factor > 0)) return { point: { ...point }, moved: 0 };
  const x = point.c - 0.5;
  const y = point.a - 0.5;
  const length = Math.sqrt(x * x + y * y);
  if (length === 0) return { point: { ...point }, moved: 0 };
  const grown = Math.min(MAX_RADIUS, length * (1 + factor));
  const scale = grown / length;
  const next = { a: clamp01(y * scale + 0.5), c: clamp01(x * scale + 0.5) };
  return { point: next, moved: distance(next, point) };
}

/**
 * 结算一轮：先混合，再按互补性决定是否升级。
 *
 * 升级放在混合**之后**，因为它读的是「本轮结束时的互补性下界」，也就是这段互动
 * **当下**的样子，而不是上一轮遗留的样子。放在前面会让升级永远慢一拍。
 *
 * `appraisal` 为 `null` 表示本轮没有新证据：状态**完全不动**，也不触发升级——
 * 没有新证据就谈不上「这次互动是非互补的」，而且没有时间项，状态不会自己漂移。
 * @param {object} params 输入。
 * @param {{self:{a:number,c:number}, other:{a:number,c:number}}} params.current 当前连续状态。
 * @param {{self:{a:number,c:number}, other:{a:number,c:number}}|null} params.appraisal 本轮打分。
 * @param {typeof DEFAULT_DYNAMICS} params.dynamics 已解析的动力学配置。
 * @param {number} [params.gain=1] 这次打分的可信度 0~1，用来缩放实际惯性系数。
 * @returns {object} 结算结果。
 */
export function integrateDyad({ current, appraisal, dynamics, gain = 1 }) {
  const reactivity = dynamics.reactivity * clamp01(gain);

  if (appraisal === null || appraisal === undefined) {
    const { complementarity, complementarityFloor } = complementarityOf(current.self, current.other);
    return {
      latent: { self: { ...current.self }, other: { ...current.other } },
      grid: { self: quantizePoint(current.self), other: quantizePoint(current.other) },
      delta: {
        self: { a: 0, c: 0 },
        other: { a: 0, c: 0 },
      },
      reactivity: 0,
      stimulusApplied: false,
      escalated: 0,
      complementarity,
      complementarityFloor,
    };
  }

  const mixedSelf = mixToward(current.self, appraisal.self, reactivity, dynamics.maxStepPerTurn);
  const mixedOther = mixToward(current.other, appraisal.other, reactivity, dynamics.maxStepPerTurn);

  // 升级：读本轮结束时的互补性**下界**（合取式读法），理由见 DEFAULT_DYNAMICS.escalation。
  const { complementarity, complementarityFloor } = complementarityOf(mixedSelf.point, mixedOther.point);
  const shortfall = Math.max(0, dynamics.escalationThreshold - complementarityFloor);
  const factor = dynamics.escalation * shortfall;
  const selfEscalated = escalate(mixedSelf.point, factor);
  const otherEscalated = escalate(mixedOther.point, factor);

  const latent = { self: selfEscalated.point, other: otherEscalated.point };
  return {
    latent,
    grid: { self: quantizePoint(latent.self), other: quantizePoint(latent.other) },
    delta: {
      // 位移里包含升级带来的部分——它确实是这一轮真实发生的变化，不该被藏起来。
      self: { a: latent.self.a - current.self.a, c: latent.self.c - current.self.c },
      other: { a: latent.other.a - current.other.a, c: latent.other.c - current.other.c },
    },
    reactivity,
    stimulusApplied: true,
    escalated: selfEscalated.moved + otherEscalated.moved,
    complementarity,
    complementarityFloor,
  };
}

/**
 * 用「网格状态」重建连续状态（恢复持久化数据时用）。
 * @param {{a:number,c:number}} grid 网格状态。
 * @returns {{a:number,c:number}} 等价连续状态。
 */
export function latentFromGrid(grid) {
  return quantizePoint(grid);
}

/**
 * 把「网格 + 残差」合成连续状态。
 *
 * 结果会被拉回圆盘内。这一步不能省：`grid` 已经是盘内的格点，但加上残差后可能越出
 * 圆周一点点，而下游一切「方向 / 强度」读数都假定点在盘内。
 * @param {{a:number,c:number}} grid 网格状态。
 * @param {Partial<Record<'a'|'c', number>>} [residual] 残差。
 * @returns {{a:number,c:number}} 连续状态。
 */
export function composeLatent(grid, residual = {}) {
  const out = {};
  for (const axis of AXES) {
    out[axis] = clamp01(quantize(grid[axis]) + (residual[axis] ?? 0));
  }
  return clampVectorToDisk(out);
}

/**
 * 把连续状态拆成「网格 + 残差」。
 *
 * 先把连续值拉回盘内**再**量化，否则靠近圆盘角落的连续值会被量化砍掉一大截
 * （`(0.95, 0.95)` 量化后越界、被 {@link quantizePoint} 拉回 `(0.8, 0.8)`，残差一下
 * 变成 0.15），而残差的设计前提是「小于半格」。
 *
 * 残留的偏差是**有界**的：圆周边界在 0.1 网格上是锯齿状的，因此贴近圆周时残差最大
 * 约 0.07 而不是 0.05。这个量级不会影响可观测性（对外读数一律取量化后的 `grid`），
 * 只是让「残差严格小于半格」这个不变量在边界上放宽一点。
 * @param {{a:number,c:number}} latent 连续状态。
 * @returns {{grid:{a:number,c:number}, residual:{a:number,c:number}}} 拆分结果。
 */
export function splitLatent(latent) {
  const inside = clampVectorToDisk({ a: clamp01(latent.a), c: clamp01(latent.c) });
  const grid = quantizePoint(inside);
  const residual = {};
  for (const axis of AXES) {
    residual[axis] = inside[axis] - grid[axis];
  }
  return { grid, residual };
}

/** 再导出量化函数，让使用方只需 import 本模块即可装配完整状态机。 */
export { quantize, quantizePoint, clamp01 };
