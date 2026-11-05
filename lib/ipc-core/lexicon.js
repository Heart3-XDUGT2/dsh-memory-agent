/**
 * IPC 锚点词表：给 81 个圆盘格子提供可读的名字与文献出处。
 *
 * ## 为什么需要一张表
 *
 * 一个 `(0.7, 0.9)` 的坐标本身说不出任何东西。要让它对模型和用户都可读，就需要
 * 把「方向 + 强度」映射成词：方向来自八分仪（{@link OCTANTS}，角度已核实），强度
 * 来自半径。
 *
 * ## 内容取自**已验证**的 IPIP-IPC 题项，而不是凭记忆写的形容词表
 *
 * 第一版这张表按印象填了「Wiggins 各分仪高载荷形容词」（assertive / dominant /
 * forceful …）。核对后发现：**IAS-R 的逐分仪形容词表没能取得一手来源**（原始论文与
 * IAS-R 手册都取不到），而凭记忆填一份「看起来像文献值」的表，比留空更糟。
 *
 * 所以改用一份**可核实、公开授权**的替代品：**IPIP-IPC**（32 题、每分仪 4 题，
 * Markey & Markey 2009），其题项原文与分仪角度对照逐字取自 `circumplex` R 包文档页。
 * 每个锚点的 `source.item` 就是题项原文，`zh` 是本项目对该题项的短译（**是译法，
 * 不是量表官方中文名**）。
 *
 * ⚠️ 与中文有关的第二个陷阱：中文文献里的 IPC 量表用的是**人际问题**取向的分仪名
 * （如「顺从型」「易利用型」，来自 IIP-SC），**不是** Wiggins 的形容词对分仪名。
 * 两套是**不同的分仪体系**，不能互相套用。本项目因此只给 Wiggins/IPIP 侧的分仪名，
 * 中文一律标为译名。
 *
 * ## 出处分级（与 `dsh-pad-emotion` 同一套约定）
 *
 * - `literature` —— 数值直接取自文献报告的**实测**值。
 * - `definitional` —— 数值由文献给出的**结构**推出。
 * - `estimated` —— 由作者判断补齐，没有直接文献依据。
 *
 * ⚠️ **本词表里没有任何一条是 `literature` 坐标**，这是刻意的，而且要说清楚为什么：
 * IPC 文献报告的是因子载荷、角度位置、量表相关，**不是**「某题在某 `[0,1]²` 坐标上
 * 的位置」。把载荷硬说成坐标就是编数据。所以本表坐标一律 `definitional`：
 *
 * - **角度**来自 IPIP-IPC 的分仪定义（这一条是文献事实，记在 `source.angle`）；
 * - **半径**由本表指定（`designIntensity`），**没有实测依据**，`note` 里如实写出。
 *
 * ## 位置怎么算
 *
 * 强度 1.0 对应**圆周**（半径 {@link MAX_RADIUS} = 0.5）：
 *
 * ```
 * x = r · MAX_RADIUS · cos θ      c = x + 0.5
 * y = r · MAX_RADIUS · sin θ      a = y + 0.5
 * ```
 *
 * ⚠️ 规格里写的是**设计强度**，落盘的是**量化后的实际强度**：0.1 网格上圆周是锯齿状
 * 的，45° 方向取不到 1.0（实际约 0.85）。
 *
 * @module dsh-interpersonal-circumplex/core/lexicon
 */

import {
  IPIP_REF,
  MAX_RADIUS,
  OCTANTS,
  octantAtAngle,
  quantizePoint,
  radius,
} from './circumplex.js';

/** 出处分级的枚举值。 */
export const PROVENANCE = Object.freeze({
  LITERATURE: 'literature',
  DEFINITIONAL: 'definitional',
  ESTIMATED: 'estimated',
});

/** 出处分级的中文标签。 */
export const PROVENANCE_LABEL = Object.freeze({
  literature: '文献值',
  definitional: '按定义',
  estimated: '估计值',
});

/** 强度的分档，用于把半径翻译成词。 */
export const INTENSITY_BANDS = Object.freeze([
  Object.freeze({ id: 'flat', max: 0.15, zh: '平淡', gloss: '人际上无可描述之处' }),
  Object.freeze({ id: 'slight', max: 0.35, zh: '轻微', gloss: '刚有倾向，随时会变' }),
  Object.freeze({ id: 'moderate', max: 0.6, zh: '中度', gloss: '姿态明确' }),
  Object.freeze({ id: 'strong', max: 0.82, zh: '明显', gloss: '姿态鲜明，对方很难忽略' }),
  Object.freeze({ id: 'extreme', max: Infinity, zh: '强烈', gloss: '接近该方向的极端，几乎不留余地' }),
]);

/**
 * 把「方向 + 强度」落到网格上。
 * @param {number} degrees 分仪角度（度）。
 * @param {number} intensity 强度 0~1（0 = 中心，1 = 圆周）。
 * @returns {{a:number,c:number}} 量化并夹入圆盘后的 IPC 点。
 */
export function placeAt(degrees, intensity) {
  const radians = (degrees * Math.PI) / 180;
  const length = Math.max(0, Math.min(1, intensity)) * MAX_RADIUS;
  return quantizePoint({
    a: Math.sin(radians) * length + 0.5,
    c: Math.cos(radians) * length + 0.5,
  });
}

/**
 * 把强度翻译成分档。
 * @param {number} intensity 强度 0~1。
 * @returns {typeof INTENSITY_BANDS[number]} 命中的档位。
 */
export function intensityBand(intensity) {
  for (const band of INTENSITY_BANDS) {
    if (intensity <= band.max) return band;
  }
  return INTENSITY_BANDS[INTENSITY_BANDS.length - 1];
}

/**
 * 中性的定义性条目。
 *
 * 它没有分仪：中心点没有方向。给出这个词条是为了让「贴近中心」也能被命名，
 * 面板与提示词都要能说「人际上平淡」而不是硬塞一个分仪名。
 */
const NEUTRAL_ENTRY = Object.freeze({
  id: 'neutral',
  zh: '平常',
  en: 'Average / Unremarkable',
  family: 'neutral',
  octant: null,
  angle: null,
  intensity: 0,
  designIntensity: 0,
  a: 0.5,
  c: 0.5,
  key: '0.5,0.5',
  provenance: PROVENANCE.DEFINITIONAL,
  source: Object.freeze({
    scale: 'IPC-centre',
    scaleLabel: '环状模型中心（normative baseline）',
    item: null,
    ref: 'Kiesler, D. J. (1983). The 1982 Interpersonal Circle. Psychological Review, 90(3), 185–214.',
    angle: null,
  }),
  note: '环状模型的中心读作「人际上无可描述」，不是一个分仪。',
  aliases: Object.freeze(['中性', '一般', '普通']),
});

/**
 * 短译表：分仪码 → 4 条题项的中文短译，顺序与 `OCTANTS[].ipipItems` 一一对应。
 *
 * 这些是**本项目对该题项的短译**，用来给锚点起一个可读的中文名（题项原文太长，
 * 不适合做面板标签）。它们不是量表官方中文版；官方中文版属于 IIP-SC 那一套**不同**
 * 的分仪体系，不能互相套用。
 */
const ITEM_GLOSSES = Object.freeze({
  PA: Object.freeze(['想当主角', '话多主导', '高声压场', '索要全场注意']),
  BC: Object.freeze(['言语刻薄', '逢话必驳', '出言不逊', '尖刻压人']),
  DE: Object.freeze(['各人自扫门前雪', '不吃卖惨', '不上心', '不关心他人处境']),
  FG: Object.freeze(['见生人沉默', '不透露自己', '少言', '无话可说']),
  HI: Object.freeze(['低声', '让人说完', '不自我推销', '回避焦点']),
  JK: Object.freeze(['多容忍', '随遇而安', '先想别人', '不夸大']),
  LM: Object.freeze(['对人感兴趣', '安抚他人', '关心近况', '与人和睦']),
  NO: Object.freeze(['在人群中自在', '主动开话', '四处攀谈', '热衷热闹场合']),
});

/**
 * 每个分仪内 4 条锚点的设计强度。
 *
 * ⚠️ 这组数字是**本项目指定的**，没有任何实测依据——IPIP-IPC 只告诉你某题属于哪个
 * 分仪，不告诉你它在分仪里有多极端。取「递增的四档」是为了让同一方向上能读出
 * 「轻微 → 强烈」的差别，而不是只有一个极端词。
 */
const DESIGN_INTENSITIES = Object.freeze([0.35, 0.5, 0.68, 0.85]);

/**
 * 由 IPIP-IPC 题项展开出的完整锚点词表（33 条 = 32 题项 + 1 个中心）。
 *
 * 每条都带 `a` / `c` / `key`，因此可以直接和状态点做距离比较。
 * @type {ReadonlyArray<object>}
 */
export const LEXICON = Object.freeze([
  NEUTRAL_ENTRY,
  ...OCTANTS.flatMap((octant) => octant.ipipItems.map((item, index) => {
    const designIntensity = DESIGN_INTENSITIES[index];
    const point = placeAt(octant.angle, designIntensity);
    // 落盘的是**量化后**的实际强度。设计强度 0.85 在 45° 方向上会因为圆周锯齿而只能
    // 落到约 0.85 以下——把设计值当实际值存下来，就会让「强度 0.85」的锚点其实只有
    // 更小的半径，于是 `nearestAnchors` 与面板读数会对不上。
    const actual = Number((radius(point) / MAX_RADIUS).toFixed(4));
    const zh = ITEM_GLOSSES[octant.code][index];
    return Object.freeze({
      id: `${octant.id}-${index + 1}`,
      zh,
      en: item,
      family: octant.code,
      octant: octant.code,
      angle: octant.angle,
      intensity: actual,
      designIntensity,
      a: point.a,
      c: point.c,
      key: `${point.a.toFixed(1)},${point.c.toFixed(1)}`,
      provenance: PROVENANCE.DEFINITIONAL,
      source: Object.freeze({
        scale: 'IPIP-IPC',
        scaleLabel: `${octant.code} ${octant.en}`,
        item,
        ref: IPIP_REF,
        angle: octant.angle,
      }),
      note: `分仪角度 ${octant.angle}° 与题项原文来自 IPIP-IPC（已验证）；`
        + `中文「${zh}」是本项目的短译，不是量表官方中文版；`
        + `设计强度 ${designIntensity.toFixed(2)} 由本项目指定（无实测依据），`
        + `在 0.1 网格的圆盘上量化为 ${actual.toFixed(2)}。`,
      aliases: Object.freeze([zh, octant.zh]),
    });
  })),
]);

/** 按 `id` 快速取锚点。 */
const ENTRY_BY_ID = new Map(LEXICON.map((entry) => [entry.id, entry]));

/**
 * 取中性的定义性条目。
 * @returns {object} `平常` 条目。
 */
export function neutralEntry() {
  return NEUTRAL_ENTRY;
}

/**
 * 按 `id` 取锚点。
 * @param {string} id 锚点 id。
 * @returns {object|undefined} 命中的条目。
 */
export function entryById(id) {
  return ENTRY_BY_ID.get(id);
}

/**
 * 统计词表覆盖情况，供工具输出与面板显示。
 * @param {ReadonlyArray<object>} [lexicon] 词表。
 * @returns {{total:number, byProvenance:Record<string,number>, octantCoverage:number, cellsCovered:number, perOctant:Record<string,number>}} 统计。
 */
export function lexiconStats(lexicon = LEXICON) {
  const byProvenance = { literature: 0, definitional: 0, estimated: 0 };
  const perOctant = {};
  const cells = new Set();
  for (const entry of lexicon) {
    byProvenance[entry.provenance] = (byProvenance[entry.provenance] ?? 0) + 1;
    if (entry.family !== 'neutral') perOctant[entry.family] = (perOctant[entry.family] ?? 0) + 1;
    cells.add(entry.key);
  }
  return {
    total: lexicon.length,
    byProvenance,
    octantCoverage: Object.keys(perOctant).length,
    cellsCovered: cells.size,
    perOctant,
  };
}

/**
 * 枚举某个分仪上的全部锚点，按强度升序。
 * @param {string} code 分仪码，例如 `'PA'`。
 * @returns {object[]} 锚点数组。
 */
export function anchorsOfOctant(code) {
  return LEXICON
    .filter((entry) => entry.family === String(code).toUpperCase())
    .sort((left, right) => left.intensity - right.intensity);
}

/**
 * 把角度翻译成「方向 + 强度」的可读名字，不依赖最近邻锚点。
 *
 * 这是 {@link placeAt} 的逆读法：给定任意点，先取分仪，再取强度档，拼成
 * 例如 `明显温暖亲和` 或 `平淡`。
 * @param {{a:number,c:number}} point IPC 点。
 * @param {number} intensity 归一化强度 0~1。
 * @param {number} degrees 角度。
 * @returns {string} 可读名字。
 */
export function bandedName(point, intensity, degrees) {
  const band = intensityBand(intensity);
  if (band.id === 'flat') return band.zh;
  const octant = octantAtAngle(degrees);
  return `${band.zh}${octant.zh}`;
}
