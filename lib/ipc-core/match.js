/**
 * 把一个 IPC 坐标读成「哪个分仪、多强、最接近哪个词」。
 *
 * 这一层是坐标与语言之间的唯一转换点：提示词、工具输出、面板摘要都从这里取
 * 措辞，因此三者永远不会互相矛盾——这是 `dsh-pad-emotion/core/match.js` 用过的
 * 同一条设计约束，理由也一样：一个只在 UI 上成立、模型其实没看到的状态，等于没有。
 *
 * @module dsh-interpersonal-circumplex/core/match
 */

import {
  AXIS_META,
  MAX_RADIUS,
  NEUTRAL,
  OCTANTS,
  angleDeg,
  distance,
  isNeutral,
  octantOf,
  quantizePoint,
  radius,
  similarityFromDistance,
} from './circumplex.js';
import { LEXICON, intensityBand } from './lexicon.js';

/**
 * 把单个轴值翻译成两极之一或「均衡」。
 * @param {'a'|'c'} axis 轴键。
 * @param {number} value 轴值 0~1。
 * @param {number} [margin=0.1] 判定为「偏」的最小偏离量。
 * @returns {string} 例如 `支配` / `顺从` / `均衡`。
 */
export function axisWord(axis, value, margin = 0.1) {
  const meta = AXIS_META[axis];
  if (value > 0.5 + margin) return meta.highLabel;
  if (value < 0.5 - margin) return meta.lowLabel;
  return '均衡';
}

/**
 * 找出离给定点最近的若干锚点词。
 * @param {{a:number,c:number}} point IPC 点。
 * @param {object} [options] 选项。
 * @param {ReadonlyArray<object>} [options.lexicon] 词表。
 * @param {number} [options.limit=5] 返回条数。
 * @param {boolean} [options.excludeNeutral=false] 是否把 `平常` 排除在外。
 * @returns {Array<{entry:object, distance:number, similarity:number}>} 由近到远。
 */
export function nearestAnchors(point, options = {}) {
  const lexicon = options.lexicon ?? LEXICON;
  const limit = options.limit ?? 5;
  const target = quantizePoint(point);
  return lexicon
    .filter((entry) => !(options.excludeNeutral === true && entry.id === 'neutral'))
    .map((entry) => {
      const entryPoint = { a: entry.a, c: entry.c };
      const d = distance(target, entryPoint);
      return { entry, distance: d, similarity: similarityFromDistance(d) };
    })
    .sort((left, right) => left.distance - right.distance)
    .slice(0, Math.max(0, limit));
}

/**
 * 把一个 IPC 点解读成完整的区域描述。
 *
 * 返回的 `neutral` 必须被调用方优先处理：中心点没有方向，`octant` 在中心
 * 退化为 `DE`（`atan2(0,0) === 0` 的必然结果），此时任何分仪命名都是过度解读。
 * 这与 PAD 里「严格中性点落在开朗象限」是同一类结构性陷阱。
 * @param {{a:number,c:number}} point IPC 点。
 * @param {object} [options] 选项。
 * @param {number} [options.neutralRadius=0.1] 中性区半径。
 * @param {ReadonlyArray<object>} [options.lexicon] 词表。
 * @param {number} [options.limit=3] 备选词条数。
 * @returns {object} 区域描述。
 */
export function describeRegion(point, options = {}) {
  const neutralRadius = options.neutralRadius ?? 0.1;
  const grid = quantizePoint(point);
  const r = radius(grid);
  const strength = r / MAX_RADIUS;
  const degrees = angleDeg(grid);
  const neutral = isNeutral(grid, neutralRadius);
  const octant = octantOf(grid);
  const band = intensityBand(strength);
  const ranked = nearestAnchors(grid, { ...options, limit: (options.limit ?? 3) + 1 });

  // 贴近中心时不采信词表最近邻：那多半会给出某个分仪的浅度词，读起来像
  // 「他有一点冷淡」，而真实含义是「没什么可说的」。
  const nearest = neutral ? undefined : ranked[0]?.entry;
  const runnersUp = neutral ? [] : ranked.slice(1, (options.limit ?? 3) + 1);

  return {
    point: grid,
    octant,
    angle: degrees,
    radius: r,
    intensity: strength,
    band,
    neutral,
    word: nearest,
    runnersUp,
    axisWords: {
      a: axisWord('a', grid.a),
      c: axisWord('c', grid.c),
    },
    label: neutral ? '平淡' : `${band.zh}${octant.zh}`,
  };
}

/**
 * 渲染一行区域标题，供工具输出与面板共用。
 * @param {object} region {@link describeRegion} 的结果。
 * @returns {string} 例如 `角色现在的姿态：明显 亲近友好——关心对方、体谅，明显程度 0.71`。
 */
export function headlineOf(region) {
  if (region.neutral) {
    return `角色现在的姿态：很平淡（明显程度 ${region.intensity.toFixed(2)}），说不上主导还是退让、也谈不上亲疏。`;
  }
  return `角色现在的姿态：「${region.label}」——${region.octant.gloss}`
    + `（明显程度 ${region.intensity.toFixed(2)}）。`;
}

/**
 * 两个分仪的关系类型，用于给一段关系起名。
 *
 * ⚠️ 这里**不能**用「角度差 180° = 互补」来判定。互补是**沿联结轴做镜像**（`θ → −θ`），
 * 只在 `PA ↔ HI` 这一对上恰好等价于 180°；其余六对全错：
 *
 * ```
 * BC 135° 的互补是 FG 225°（差 90°，不是 180°）
 * LM   0° 的互补是它自己（差 0°）
 * ```
 *
 * 所以实现是「把候选目标角度算出来，再取角度最接近的那个」，四个目标分别是：
 *
 * | 关系 | 目标角度 | 含义 |
 * |---|---|---|
 * | 互补 | `-θ` | 掌控相反 + 联结相同 |
 * | 相似 | `θ` | 两个轴都相同 |
 * | 错位 | `180 - θ` | 掌控相同 + 联结相反 |
 * | 对立 | `θ + 180` | 两个轴都相反（真正的 180°） |
 *
 * @param {typeof OCTANTS[number]} self 角色的分仪。
 * @param {typeof OCTANTS[number]} other 对方的分仪。
 * @returns {{kind:string, zh:string, gloss:string}} 关系名。
 */
export function octantRelation(self, other) {
  /** 两个角度之间的最小夹角（0~180）。 */
  const gap = (a, b) => {
    const diff = Math.abs(((a - b) % 360 + 360) % 360);
    return diff > 180 ? 360 - diff : diff;
  };
  const candidates = [
    { kind: 'complementary', zh: '一个带、一个跟', gloss: '一个人拿主意，另一个人配合；亲近程度差不多', angle: -self.angle },
    { kind: 'similar', zh: '两个人差不多', gloss: '谁强谁弱、想不想亲近，都差不多', angle: self.angle },
    { kind: 'contrast', zh: '一个热、一个冷', gloss: '谁也不比谁强势，但一个想亲近、一个想保持距离', angle: 180 - self.angle },
    { kind: 'opposite', zh: '什么都拧着', gloss: '谁强谁弱、想不想亲近，全都对着来', angle: self.angle + 180 },
  ];
  return candidates
    .map((candidate) => ({ ...candidate, gap: gap(candidate.angle, other.angle) }))
    .sort((left, right) => left.gap - right.gap)[0];
}

/**
 * 判断某个点是否已经贴近圆盘中心。
 * @param {{a:number,c:number}} point IPC 点。
 * @param {number} [limit=0.1] 中性区半径。
 * @returns {boolean} 贴近中心时为 true。
 */
export function atCenter(point, limit = 0.1) {
  return isNeutral(point, limit);
}

/** 再导出中心点，方便调用方不额外 import `circumplex.js`。 */
export { NEUTRAL };
