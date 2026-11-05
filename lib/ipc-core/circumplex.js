/**
 * 人际环形模型（Interpersonal Circumplex, IPC）的几何层。
 *
 * ## 名字怎么叫（已核实）
 *
 * - 模型：**人际环形模型**是中文心理学刊物的主用名（王等 2014《中国临床心理学杂志》；
 *   邵 & 杨 2023《应用心理学》），**人际环形模型**是可用的别名。
 *   ⚠️ **「人际圆周模型」在中文文献里查不到**，本项目不使用。
 * - 两个轴：**掌控 / 联结**（王等 2014 的英文摘要明确写 "labeled as 'agency' and
 *   'communion'"）。⚠️ **「能动 / 共生」属于 Big Two 人格框架，不是 IPC**，因此不用。
 *
 * ## 算法要点
 *
 * 8 个分仪是**按角度切出来的扇区**（不是 PAD 那样的三轴符号），所以本模块的核心是
 * 极坐标换算与扇区归属；圆盘半径为 0.5，强度 = 半径 / 0.5；互补是**沿联结轴做镜像**
 * （`θ → −θ`）而不是旋转 180°。
 *
 * ## 模型来源
 *
 * - Leary, T. (1957). *Interpersonal Diagnosis of Personality*. Ronald Press.
 *   —— 16 个人际变量的环形排列，是 IPC 的原始形态。
 * - Wiggins, J. S. (1979). A psychological taxonomy of trait-descriptive terms:
 *   The interpersonal domain. *Journal of Personality and Social Psychology*, 37(3),
 *   395–412. —— IAS（Interpersonal Adjective Scales），把环形整理成 8 个分仪。
 * - Kiesler, D. J. (1983). The 1982 Interpersonal Circle: A taxonomy for
 *   complementarity in human transactions. *Psychological Review*, 90(3), 185–214.
 *   —— 互补性（complementarity）的正式表述。
 * - Gurtman, M. B. (1994). The circumplex as a tool for assessing normal and
 *   dysfunctional personality traits. —— 环状结构的余弦判据。
 *
 * ## 与 PAD 情绪模型的几何差异（这是本模块存在的理由）
 *
 * PAD 是**三维立方体**，用「三个轴各自的正负」切出 8 个卦限——`octantOf` 只做三次
 * `>= 0.5` 比较就完事。IPC 是**二维圆盘**，8 个分仪是**按角度切出来的扇形**，
 * 不能用符号判定：`(a=0.9, c=0.9)` 与 `(a=0.9, c=0.5)` 符号完全相同，却分属
 * 相邻的两个分仪。所以本模块的核心是极坐标换算与扇区归属，而不是符号位。
 *
 * ## 坐标约定
 *
 * 内部一律用单极 `[0, 1]`，中性点落在圆盘中心 `(0.5, 0.5)`——与 PAD 的约定一致，
 * 便于两个插件互相参照。文献里的量表多是双极 `[-1, +1]`，换算入口是
 * {@link fromBipolar}（`v01 = (v + 1) / 2`）。
 *
 * 圆盘的**朝向**采用 Wiggins 的惯例：
 *
 * ```
 *                    PA 支配自信 (90°)
 *                          │
 *   DE 冷漠疏离 (180°) ────┼──── LM 温暖亲和 (0°/360°)      ← 横轴 = 联结 Communion
 *                          │
 *                    HI 顺从退缩 (270°)
 *                    ↑ 纵轴 = 掌控 Agency
 * ```
 *
 * 角度从 `+联结`（右侧）起算，**逆时针为正**，即向 `+掌控` 方向增大。因此
 * 90° = 支配、0° = 温暖、180° = 冷漠、270° = 顺从。这与「极角即人际主题的方向」
 * 这一读法一致：角度告诉你这个人正在做什么，半径告诉你他做得多极端。
 *
 * 本模块是纯函数库：不依赖 DSH、不依赖 Node、不依赖浏览器，可直接被 host、
 * 浏览器半边与单元测试引用。
 *
 * @module dsh-interpersonal-circumplex/core/circumplex
 */

/** 两个轴的键名，顺序固定为 掌控 → 联结。 */
export const AXES = Object.freeze(['a', 'c']);

/**
 * 两个轴的语义与两极措辞。
 *
 * ## 中文命名的出处（这里刻意不用「能动/共生」）
 *
 * 中文文献里至少存在四套并存的轴名，分属**两个不同的研究传统**，不可混用：
 *
 * | 传统 | 纵轴 | 横轴 | 出处 |
 * |---|---|---|---|
 * | **IPC（临床，Pincus/Wiggins 一线）** | **掌控** | **联结** | 王等 (2014)《中国临床心理学杂志》22(4)；邵 & 杨 (2023)《应用心理学》29(6) |
 * | Big Two 人格（Bakan/Abele 一线） | 能动 | 共生 | 潘等 (2017)《心理科学进展》25(1) |
 * | Leary 传统 | 主导性 | 宜人性 | 《湖北成人教育学院学报》(2010) |
 * | Leary 传统 | 控制 | 亲和 | 佐斌 & 赵菊 (2009) |
 *
 * 本项目取**第一套（掌控 / 联结）**，因为它是唯一在 IPC 论文里被用来指代
 * agency / communion 的一对（王等 2014 的英文摘要明确写 "labeled as 'agency' and
 * 'communion'"）。
 *
 * ⚠️ 「能动 / 共生」属于 **Big Two 人格**框架（特质—动机—价值观），**不是** IPC 的分仪
 * 模型；把 IPC 的分仪内容挂到它名下属误植，所以这里不采用它。
 *
 * ⚠️ 另一处要小心：中文文献里 communion 是**联结或共生**，**不是「亲和性」**；而
 * affiliation 才对应「情感」或「亲和」。把「亲和性」当成 communion 的标准中文名没有依据。
 *
 * `lowLabel` / `highLabel` 是**行为**描述而不是特质描述：IPC 标的是「此刻这个人在怎么
 * 跟对方互动」，不是「这个人是什么样的人」。这一点在写提示词时很关键——写成特质，
 * 模型就会把它当成角色的固定人设；写成行为，模型才会让它随对话变化。
 *
 * ## 缩写用 DOM / LOV，不用「PA / DE」
 *
 * `DOM`（纵轴）与 `LOV`（横轴）是 `circumplex` R 包文档里实际使用的轴标签
 * （`x_label = "LOV", y_label = "DOM"`）。两个理由让别的写法都不能用：
 *
 * - **`PA / DE` 不是一对轴**：PA 在 90°、DE 在 180°，二者只差 90°，把它们当成纵轴两端
 *   是错的。真正 180° 相对的是 **PA–HI（掌控轴）** 与 **LM–DE（联结轴）**。
 * - **`AGENCY / COMM` 未见使用**，且 `COMM` 会与 Community 撞车。
 *
 * ## ⚠️ 不要把这些轴名安到 Wiggins (1979) 头上
 *
 * Wiggins (1979) 的摘要**只**说「Eight adjectival scales were developed as markers of the
 * principal vectors of the interpersonal domain」——它既没有命名 agency/communion，也没有
 * 命名任何一个分仪。「Agency / Communion」作为概念坐标进入 Wiggins 的用语是
 * **Wiggins (1991)**（Grove & Ciccetti 主编 *Thinking clearly about psychology* Vol. 2,
 * pp. 89–113）。所以本项目在提到 agency/communion 时引用的是 `circumplex` 包文档与
 * Boudreaux et al. (2017)（后者用 Dominance / Affiliation 这对名字），**不引 1979**。
 */
export const AXIS_META = Object.freeze({
  a: Object.freeze({
    key: 'a',
    short: '主导性',
    zh: '主导性',
    en: 'Agency',
    aliasZh: '支配性 / 控制 / 主导性',
    aliasEn: 'Dominance / Control',
    lowLabel: '对方主导',
    highLabel: '角色主导',
    poleLow: 'HI 退让',
    poleHigh: 'PA 主导',
    question: '此刻是谁在主导这段互动——是角色在推动、下判断、给方向，还是角色在退让、征询、跟随？',
  }),
  c: Object.freeze({
    key: 'c',
    short: '亲近度',
    zh: '亲近度',
    en: 'Communion',
    aliasZh: '情感 / 亲和',
    aliasEn: 'Affiliation / Love',
    lowLabel: '冷淡',
    highLabel: '亲近',
    poleLow: 'DE 冷淡',
    poleHigh: 'LM 亲近友好',
    question: '此刻角色对对方是亲近、接纳、照护，还是疏远、冷淡、对抗？',
  }),
});

/** 轴取值下界（含）。 */
export const MIN = 0;
/** 轴取值上界（含）。 */
export const MAX = 1;
/** 量化精度：0.1。 */
export const STEP = 0.1;
/** 每轴可取的刻度数：0.0, 0.1, … 1.0 共 11 档。 */
export const LEVELS = 11;
/** 原始网格格子总数 11² = 121（其中一部分落在圆盘外，见 {@link CELLS}）。 */
export const GRID_CELLS = LEVELS ** 2;
/** 中性点：圆盘几何中心。IPC 把中心读作「人际上无可描述之处」，而不是某个分仪。 */
export const NEUTRAL = Object.freeze({ a: 0.5, c: 0.5 });
/**
 * 圆盘半径。
 *
 * ## 为什么状态空间是**内切圆盘**而不是整个正方形
 *
 * 坐标系是单极 `[0,1]²`，所以中心到正方形**边长中点**的距离是 `0.5`，到**角**的距离
 * 是 `√0.5 ≈ 0.7071`。若把「强度」定义成 `半径 / √0.5`，就会出现一个方向依赖的怪事：
 *
 * ```
 * (a=1.0, c=0.5) 纯支配    半径 0.500 → 强度 0.71
 * (a=1.0, c=1.0) 又暖又支配 半径 0.707 → 强度 1.00
 * ```
 *
 * 同样是「顶到边」，纯支配只有 0.71。这与 IPC 的圆盘语义直接冲突——圆周上的每一点
 * 都应当是「同等极端」。所以状态空间取**半径 0.5 的内切圆盘**，强度一律定义为
 * `半径 / 0.5`，于是每个方向上的强度 1.0 都恰好在圆周上。
 *
 * 代价是**正方形角落不可达**，而且 0.1 网格上的格点并不刚好铺满圆盘：落在圆盘内的
 * 整数格点只有 {@link CELLS} 个（原始网格共 {@link GRID_CELLS} 个），圆周在网格上是
 * 「锯齿状」的——斜向（45°）能取到的最大强度约 0.85，轴向能取到 1.00。这是把圆盘量化
 * 到 0.1 网格的必然结果，不是 bug；{@link clampToDisk} 负责把所有越界点拉回盘内，
 * 且**保持方向**（按比例回缩再量化），不会让一个 45° 的点被拉成不对称的 (0.8, 0.9)。
 */
export const MAX_RADIUS = 0.5;
/** 圆盘内任意两点的最大距离 = 直径 1.0，用于把距离归一化成相似度。 */
export const MAX_DISTANCE = 2 * MAX_RADIUS;
/** 相邻分仪的角宽：360 / 8 = 45°。 */
export const SECTOR_DEGREES = 45;
/** 轴偏离中心多少才算「有内容」。用于 {@link relationship} 的信息量权重。 */
export const AXIS_INFORMATIVE_MARGIN = 0.05;
/** 某个轴上「同」与「反」的分数差多少才算「分辨得出」。 */
export const AXIS_DECISIVE_MARGIN = 0.05;
/**
 * 头两名原型拟合度差多少以内算「并列」，即分类不可信。
 *
 * 取 0.15 而不是某个整十的分数，是为了避开「阈值恰好落在常见取值上」这一类浮点
 * 陷阱：权重都是 0.1 的整数倍，轴分数都是 0.1 的整数倍，于是差值常常正好等于 0.1
 * ——`0.1 < 0.1` 本该为假，但 `(0.18+0.2)/0.4` 这类算式会算出 `0.09999999999999998`，
 * 判定结果随浮点误差随机翻转。用一个不可能被这些分数精确取到的阈值，边界就稳定了。
 */
export const PATTERN_AMBIGUITY_MARGIN = 0.15;

/**
 * 把任意数值夹到 [0, 1]。
 * @param {number} value 原始数值。
 * @returns {number} 夹取后的数值。
 * @throws {TypeError} 当输入不是有限数时——静默吞掉 NaN 会让坏数据一路流进状态。
 */
export function clamp01(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`IPC 轴取值必须是有限数，收到 ${String(value)}`);
  }
  if (value < MIN) return MIN;
  if (value > MAX) return MAX;
  return value;
}

/**
 * 把任意数值按 0.1 精度吸附到网格上。
 *
 * 用「乘 10 取整再除 10」而不是累加 0.1，避免二进制浮点误差累积。
 * @param {number} value 原始数值，先被夹到 [0, 1]。
 * @returns {number} 落在 0.0…1.0、步长 0.1 网格上的值。
 */
export function quantize(value) {
  return Math.round(clamp01(value) * 10) / 10;
}

/**
 * 在两个数值之间线性插值。
 * @param {number} from 起点。
 * @param {number} to 终点。
 * @param {number} t 插值系数。
 * @returns {number} 插值结果。
 */
export function lerp(from, to, t) {
  return from + (to - from) * t;
}

/**
 * 把一个**连续**点沿原方向缩回圆盘内（不量化）。
 *
 * 与 {@link clampToDisk} 的分工：那个作用于已量化的格点，这个作用于 `latent` 连续值。
 * 动力学在「网格 + 残差」之间来回换算时必须用它——否则一个落在角落的连续值会被量化
 * 直接砍掉一大截，残差瞬间变成一个半格以上的大数，而残差的设计前提是「小于半格」。
 * @param {{a:number,c:number}} point 连续点。
 * @returns {{a:number,c:number}} 盘内（或恰好在盘上）的连续点。
 */
export function clampVectorToDisk(point) {
  const r = radius(point);
  if (r <= MAX_RADIUS || r === 0) return { a: point.a, c: point.c };
  const scale = MAX_RADIUS / r;
  return {
    a: clamp01(NEUTRAL.a + (point.a - NEUTRAL.a) * scale),
    c: clamp01(NEUTRAL.c + (point.c - NEUTRAL.c) * scale),
  };
}

/**
 * 把一个点拉回圆盘内，并**保持方向**。
 *
 * 只对越界点生效（盘内的点原样返回，热路径上没有额外开销）。做法是沿原方向按比例
 * 回缩再量化，逐步试探直到落进盘内，而不是「把偏移最大的那个轴往回减一格」——后者
 * 会把 `(0.85, 0.85)` 这种对称的 45° 点拉成 `(0.8, 0.9)` 这种不对称的点，方向被
 * 悄悄改掉，而方向恰恰是本模型里最有信息量的那个量。
 * @param {{a:number,c:number}} point 已量化的点。
 * @returns {{a:number,c:number}} 圆盘内的网格点。
 */
export function clampToDisk(point) {
  const r = radius(point);
  if (r <= MAX_RADIUS + 1e-9) return { a: point.a, c: point.c };

  const x = point.c - NEUTRAL.c;
  const y = point.a - NEUTRAL.a;
  let scale = MAX_RADIUS / r;
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const candidate = { a: quantize(y * scale + NEUTRAL.a), c: quantize(x * scale + NEUTRAL.c) };
    if (radius(candidate) <= MAX_RADIUS + 1e-9) return candidate;
    scale *= 0.92;
  }
  // 理论上到不了这里（scale→0 必然收敛到中心）。留着是为了让函数**永远**返回一个
  // 合法点，而不是在极端输入下把 NaN 或越界值漏给状态机。
  return { ...NEUTRAL };
}

/**
 * 把一个对象规范成合法的 IPC 点：逐轴夹取、按 0.1 量化，**并保证落在圆盘内**。
 *
 * 缺失的轴回落到 {@link NEUTRAL} 的对应分量，而不是报错——调用方（模型输出、
 * HTTP 请求体、旧版持久化文件）常常只给出部分轴。
 * @param {Partial<Record<'a'|'c', number>>} input 候选点。
 * @returns {{a: number, c: number}} 圆盘内的网格 IPC 点。
 */
export function quantizePoint(input) {
  const out = {};
  for (const axis of AXES) {
    const raw = input?.[axis];
    out[axis] = raw === undefined || raw === null
      ? NEUTRAL[axis]
      : quantize(raw);
  }
  return clampToDisk(out);
}

/**
 * 把双极 `[-1, 1]` 坐标换算成本项目的单极 `[0, 1]` 坐标。
 *
 * 文献里的 IPC 数值几乎都是双极量表，此函数是引用文献值时的唯一换算入口。
 * @param {number} bipolar 双极坐标，允许略微越界（会被夹取）。
 * @returns {number} 单极坐标，未量化。
 */
export function fromBipolar(bipolar) {
  if (typeof bipolar !== 'number' || !Number.isFinite(bipolar)) {
    throw new TypeError(`双极坐标必须是有限数，收到 ${String(bipolar)}`);
  }
  return clamp01((bipolar + 1) / 2);
}

/**
 * {@link fromBipolar} 的逆运算，便于与文献值双向对照。
 * @param {number} unipolar 单极坐标。
 * @returns {number} 双极坐标，范围 [-1, 1]。
 */
export function toBipolar(unipolar) {
  return clamp01(unipolar) * 2 - 1;
}

/**
 * 把 IPC 点换算成以圆盘中心为原点的平面向量。
 *
 * 分量范围都是 `[-0.5, 0.5]`：`x` 为联结、`y` 为掌控。
 * @param {{a:number,c:number}} point IPC 点。
 * @returns {{x:number,y:number}} 向量。
 */
export function vectorOf(point) {
  return { x: point.c - 0.5, y: point.a - 0.5 };
}

/**
 * {@link vectorOf} 的逆运算。
 * @param {{x:number,y:number}} vector 向量。
 * @returns {{a:number,c:number}} IPC 点（未量化）。
 */
export function fromVector(vector) {
  return { a: clamp01(vector.y + 0.5), c: clamp01(vector.x + 0.5) };
}

/**
 * 点到圆盘中心的半径。
 * @param {{a:number,c:number}} point IPC 点。
 * @returns {number} 半径，范围 [0, √0.5]。
 */
export function radius(point) {
  const { x, y } = vectorOf(point);
  return Math.sqrt(x * x + y * y);
}

/**
 * 归一化强度：半径占圆盘半径的比例。
 *
 * 这是结构摘要（structural summary）里 **elevation** 的单点版本：值越大，
 * 人际行为越极端、越有辨识度；接近 0 表示「人际上平淡无奇」，1 表示落在圆周上
 * （该方向能取到的最极端姿态）。
 * @param {{a:number,c:number}} point IPC 点。
 * @returns {number} 0 表示正中心，1 表示落在圆周上。
 */
export function intensity(point) {
  return Math.min(1, radius(point) / MAX_RADIUS);
}

/**
 * 极角，单位**度**，范围 [0, 360)。
 *
 * 从 `+联结`（右）起算，逆时针为正。正中心处 `atan2(0, 0) === 0`，会返回 0
 * ——正中心没有有意义的方向，调用方应先看 {@link isNeutral}，不要拿这个 0
 * 当成「温暖亲和」。
 * @param {{a:number,c:number}} point IPC 点。
 * @returns {number} 角度。
 */
export function angleDeg(point) {
  const { x, y } = vectorOf(point);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg % 360 + 360) % 360;
}

/**
 * 极角，单位弧度。
 * @param {{a:number,c:number}} point IPC 点。
 * @returns {number} 角度，范围 [0, 2π)。
 */
export function angleRad(point) {
  return (angleDeg(point) * Math.PI) / 180;
}

/**
 * 判断一个点是否落在中性区。
 * @param {{a:number,c:number}} point IPC 点。
 * @param {number} [limit=0.1] 中性区半径（欧氏距离）。
 * @returns {boolean} 半径不超过 `limit` 时为 true。
 */
export function isNeutral(point, limit = STEP) {
  return radius(point) <= limit;
}

/**
 * 八分仪的定义表，**按已验证的角度递增顺序**排列：从正上方的 PA 起，逆时针一圈。
 *
 * ```
 *                PA 支配自信 90°
 *   BC 强势算计 135°    │    NO 外向热情 45°
 *      DE 冷漠 180° ────┼──── LM 温暖亲和 0°/360°
 *   FG 疏离内敛 225°    │    JK 谦逊坦诚 315°
 *                HI 顺从退缩 270°
 * ```
 *
 * ## ⚠️ 这份码—名对应关系是本项目修正过的一个真实错误
 *
 * 第一版凭印象把 `BC` 配成 `Gregarious-Extraverted`、`DE` 配成 `Warm-Agreeable`——那是
 * 把「从 PA 起顺时针经过温暖侧」的**另一套列报顺序**当成了码—名对应。正确的对应逐字
 * 核对自 `circumplex` R 包（Girard, Zimmermann & Wright）的 IPIP-IPC 文档页：
 *
 * > `PA: Assured-Dominant (90 degrees)` … `NO: Gregarious-Extraverted (45 degrees)`
 *
 * 也就是说：**温暖亲和是 LM，外向热情是 NO，冷漠是 DE，强势算计是 BC。** 八个分仪里
 * 有四个的码被第一版配错了。角度集合另有独立来源佐证（Boudreaux et al., 2017 明确写
 * 分仪中点是「90°, 135°, 180°, 225°, 270°, 315°, 360°, and 45°」）。
 *
 * 两处归属要说准：
 *
 * - **字母码是 Leary 的记法**，不是 Wiggins 的发明（Cain et al., 2012 原话：「Octants are
 *   labeled with the alphabetical notation originally provided by Leary (1957)」）；
 * - **`en` 里的分仪名是 Wiggins 的 IAS 量表名**（Wiggins 1979 只给出了 8 个形容词量表作为
 *   「主向量」的标志，并未命名这些分仪——见 {@link AXIS_META} 的说明）。
 *
 * ## 角度原点是约定，不是事实
 *
 * 「PA 在 90°」是 `circumplex` 包的约定；另有作者把掌控轴放在 0°，或整体旋转圆环，
 * 好让别的分仪当参考点。本模块把 {@link OCTANTS} 的角度当作**本项目采用的约定**固定下来，
 * 并在每个分仪上给出 `angle`，因此需要换原点是改这一张表即可，不需要动几何代码。
 *
 * ⚠️ 另外别把「八个分仪」叫成「八边形 / interpersonal octagon」：**octagon 是 Birtchnell
 * 另立的一套模型**，用来当圆周模型的**替代**（Birtchnell 2012 原话：octagon 没有把轴
 * 之间设成双极关系，而 circle 有）。圆周被切成 8 个**扇区**叫 octant，这是「扇区计数」，
 * 不是「八边形模型」。本模块一律用「分仪」。
 *
 * `ipipItems` 是**已验证、公开授权**的题项原文（IPIP-IPC，32 题、每分仪 4 题，
 * Markey & Markey 2009），来自同一份 `circumplex` 文档。⚠️ 它们**不是** Wiggins 的
 * IAS-R 形容词——IAS-R 的逐分仪高载荷形容词表本项目**未能取得一手来源**，因此
 * **不凭记忆填充**（这正是词表模块把出处分级标的那么死的原因）。
 */
export const OCTANTS = Object.freeze([
  Object.freeze({
    code: 'PA', id: 'assured-dominant', angle: 90,
    en: 'Assured-Dominant', zh: '主导', gloss: '拿主意、给方向、说了算容易',
    ipipItems: Object.freeze([
      'Demand to be the center of interest',
      'Do most of the talking',
      'Speak loudly',
      'Demand attention',
    ]),
  }),
  Object.freeze({
    code: 'BC', id: 'arrogant-calculating', angle: 135,
    en: 'Arrogant-Calculating', zh: '压人', gloss: '话里带刺、不让人、压着对方',
    ipipItems: Object.freeze([
      'Cut others to pieces',
      'Contradict others',
      'Snap at people',
      'Have a sharp tongue',
    ]),
  }),
  Object.freeze({
    code: 'DE', id: 'cold-hearted', angle: 180,
    en: 'Cold-Hearted', zh: '冷淡', gloss: '不关心对方的事、也不接情绪',
    ipipItems: Object.freeze([
      'Believe people should fend for themselves',
      "Don't fall for sob stories",
      "Don't put a lot of thought into things",
      "Am not interested in other people's problems",
    ]),
  }),
  Object.freeze({
    code: 'FG', id: 'aloof-introverted', angle: 225,
    en: 'Aloof-Introverted', zh: '沉默', gloss: '话少、不表态、保持距离',
    ipipItems: Object.freeze([
      'Am quiet around strangers',
      'Am a very private person',
      "Don't talk a lot",
      'Have little to say',
    ]),
  }),
  Object.freeze({
    code: 'HI', id: 'unassured-submissive', angle: 270,
    en: 'Unassured-Submissive', zh: '退让', gloss: '顺着对方、不争、少主张',
    ipipItems: Object.freeze([
      'Speak softly',
      'Let others finish what they are saying',
      'Seldom toot my own horn',
      'Dislike being the center of attention',
    ]),
  }),
  Object.freeze({
    code: 'JK', id: 'unassuming-ingenuous', angle: 315,
    en: 'Unassuming-Ingenuous', zh: '随和', gloss: '好说话、让着对方、不计较',
    ipipItems: Object.freeze([
      'Tolerate a lot from others',
      'Take things as they come',
      'Think of others first',
      'Seldom stretch the truth',
    ]),
  }),
  Object.freeze({
    code: 'LM', id: 'warm-agreeable', angle: 0,
    en: 'Warm-Agreeable', zh: '亲近友好', gloss: '关心对方、体谅、愿意靠近',
    ipipItems: Object.freeze([
      'Am interested in people',
      'Reassure others',
      "Inquire about others' well-being",
      'Get along well with others',
    ]),
  }),
  Object.freeze({
    code: 'NO', id: 'gregarious-extraverted', angle: 45,
    en: 'Gregarious-Extraverted', zh: '热络', gloss: '主动搭话、兴致高、愿意聊',
    ipipItems: Object.freeze([
      'Feel comfortable around people',
      'Start conversations',
      'Talk to a lot of different people at parties',
      'Love large parties',
    ]),
  }),
]);

/** IPIP-IPC 题项与分仪角度的出处串。 */
export const IPIP_REF = 'IPIP-IPC（Markey & Markey, 2009），角度与题项对照取自 circumplex R 包文档：'
  + 'https://circumplex.jmgirard.com/reference/ipipipc.html';

/** 按 `id` 快速取分仪。 */
const OCTANT_BY_ID = new Map(OCTANTS.map((octant) => [octant.id, octant]));
/** 按两位字母码快速取分仪。 */
const OCTANT_BY_CODE = new Map(OCTANTS.map((octant) => [octant.code, octant]));

/**
 * 判定 IPC 点所属的八分仪。
 *
 * 实现是「角度 → 扇区」而不是 PAD 那样的「三轴符号」：把角度归到以 PA（90°）为起点、
 * **逆时针递增**的序号上，每 45° 一个扇区。注意 `OCTANTS` 的列报顺序正是这个递增顺序
 * （PA 90 → BC 135 → DE 180 → FG 225 → HI 270 → JK 315 → LM 360 → NO 45），所以
 * 序号可以直接当数组下标用。
 *
 * ⚠️ 正中心 `(0.5, 0.5)` 没有方向，按 `atan2(0,0) === 0` 会落在 LM。这是退化情形，
 * 不是结论：调用方若关心「真的处于中间」，应当同时看 {@link isNeutral} 或
 * {@link intensity}，而不是只看分仪——这与 PAD 里「严格中性点落在开朗象限」是同一类
 * 结构性必然。
 * @param {{a:number,c:number}} point IPC 点。
 * @returns {typeof OCTANTS[number]} 命中的分仪条目。
 */
export function octantOf(point) {
  const step = Math.round((angleDeg(point) - 90) / SECTOR_DEGREES);
  return OCTANTS[((step % OCTANTS.length) + OCTANTS.length) % OCTANTS.length];
}

/**
 * 按 `id` 取分仪定义。
 * @param {string} id 分仪 id，例如 `'warm-agreeable'`。
 * @returns {typeof OCTANTS[number]} 分仪条目。
 * @throws {RangeError} 当 id 不存在时。
 */
export function octantById(id) {
  const octant = OCTANT_BY_ID.get(id);
  if (octant === undefined) throw new RangeError(`未知 IPC 分仪 id：${String(id)}`);
  return octant;
}

/**
 * 按两位字母码取分仪定义。
 * @param {string} code 字母码，例如 `'PA'`，大小写不敏感。
 * @returns {typeof OCTANTS[number]} 分仪条目。
 * @throws {RangeError} 当码不存在时。
 */
export function octantByCode(code) {
  const octant = OCTANT_BY_CODE.get(String(code).toUpperCase());
  if (octant === undefined) throw new RangeError(`未知 IPC 分仪码：${String(code)}`);
  return octant;
}

/**
 * 取某个角度所在的分仪，等价于 `octantOf({a,c})` 但不需要构造点。
 * @param {number} degrees 角度。
 * @returns {typeof OCTANTS[number]} 分仪条目。
 */
export function octantAtAngle(degrees) {
  const step = Math.round((degrees - 90) / SECTOR_DEGREES);
  return OCTANTS[((step % OCTANTS.length) + OCTANTS.length) % OCTANTS.length];
}

/**
 * 把角度渲染成方向词，用于 UI 与提示词。
 * @param {number} degrees 角度。
 * @returns {string} 例如 `右上（温暖·支配）`。
 */
export function directionLabel(degrees) {
  return octantAtAngle(degrees).zh;
}

/**
 * 两点的欧氏距离。IPC 的圆盘本身即欧氏平面，故不做加权。
 * @param {{a:number,c:number}} a 起点。
 * @param {{a:number,c:number}} b 终点。
 * @returns {number} 距离，范围 [0, √2]。
 */
export function distance(a, b) {
  const da = a.a - b.a;
  const dc = a.c - b.c;
  return Math.sqrt(da * da + dc * dc);
}

/**
 * 把距离折算成 [0, 1] 的相似度，1 表示重合。
 * @param {number} d 欧氏距离。
 * @returns {number} 相似度。
 */
export function similarityFromDistance(d) {
  return 1 - d / MAX_DISTANCE;
}

/**
 * 两点之间的角度间隔（取锐角侧，0~180）。
 * @param {{a:number,c:number}} a 起点。
 * @param {{a:number,c:number}} b 终点。
 * @returns {number} 角度，单位度。
 */
export function separationDegrees(a, b) {
  const diff = Math.abs(angleDeg(a) - angleDeg(b)) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * 网格坐标：把 IPC 点写成 `"a,c"` 形式的稳定字符串。
 *
 * 这个字符串是状态存储的键、审计日志的字段，也是「121 个格子」这一说法里
 * 「格子」的可读标识。
 * @param {{a:number,c:number}} point IPC 点。
 * @returns {string} 形如 `"0.7,0.3"` 的键。
 */
export function gridKey(point) {
  return AXES.map((axis) => quantize(point[axis]).toFixed(1)).join(',');
}

/**
 * {@link gridKey} 的逆运算。
 * @param {string} key 形如 `"0.7,0.3"` 的键。
 * @returns {{a:number,c:number}} 网格上的 IPC 点。
 */
export function parseGridKey(key) {
  const parts = String(key).split(',').map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    throw new TypeError(`无法解析 IPC 格子键：${String(key)}`);
  }
  return quantizePoint({ a: parts[0], c: parts[1] });
}

/**
 * 枚举圆盘内的全部网格点，按 A → C 升序。
 *
 * 只返回**可达**的格子（半径 ≤ {@link MAX_RADIUS}）。原始 11×11 网格里有
 * {@link GRID_CELLS} 个点，其中落在圆盘内的是 {@link CELLS} 个——四个角以及贴着角的
 * 那一圈都够不着，这是圆盘拓扑的直接后果，不是枚举漏了。
 * @returns {Array<{a:number,c:number}>} 圆盘内的全部网格点。
 */
export function allCells() {
  const cells = [];
  for (let ai = 0; ai < LEVELS; ai += 1) {
    for (let ci = 0; ci < LEVELS; ci += 1) {
      const point = { a: ai / 10, c: ci / 10 };
      if (radius(point) <= MAX_RADIUS + 1e-9) cells.push(point);
    }
  }
  return cells;
}

/** 圆盘内的可达格子总数（0.1 网格下为 81）。 */
export const CELLS = allCells().length;

/**
 * 把 IPC 点渲染成一行紧凑的人类可读文本。
 * @param {{a:number,c:number}} point IPC 点。
 * @returns {string} 例如 `A0.8 C0.2`。
 */
export function formatPoint(point) {
  return AXES.map((axis) => `${AXIS_META[axis].short}${quantize(point[axis]).toFixed(1)}`).join(' ');
}

// ---------------------------------------------------------------- 关系度量

/**
 * 四种「轴关系原型」：两个轴各自取「相同」或「相反」，构成 2×2 完备划分。
 *
 * 这是把 IPC 的关系预测收敛成一张表的地方。每个原型由 `self` 唯一决定一个
 * **理想位置** `ideal(self)`，而每个原型的拟合度由两个轴的分数加权聚合而成（见
 * {@link relationship}）。
 *
 * ## 术语出处（这里是本项目返工过的地方）
 *
 * 第一版把 `correspondence` 当成「两个轴都相同」，并把「互补」讲成「旋转 180°」。
 * 两处都错，且都能被一手/二手来源直接证伪：
 *
 * > "**correspondence** tends to occur on the **affiliation axis**（友好招来友好，敌对招来
 * > 敌对），and **reciprocity** tends to occur on the **power axis**（主导招来顺从，顺从招来
 * > 主导）。" —— Acton, *Interpersonal Complementarity*
 *
 * > "greater dominance in one partner invites greater submissiveness in the other
 * > (**i.e., reciprocity**) and greater friendliness invites greater friendliness
 * > (**i.e., correspondence**)" —— Ni et al. (2020), 心理学报 52(2), 197–206
 *
 * 所以三件不同的事必须分开：
 *
 * - **互补（complementary）** = 掌控**相反** + 联结**相同**（Carson 1969；Kiesler 1983）；中文「人际互补」。
 * - **相似（similar）** = 两个轴都**相同**。这是**另一个**关系，在关系研究里叫 similarity /
 *   同质配对，并被明确拿来与互补对照（Dryer & Horowitz 1997 的标题就是
 *   "When do opposites attract? Interpersonal complementarity versus similarity"）。
 * - **对立（opposite）** = 两个轴都**相反**，也就是圆环上真正的 180°。
 *
 * 几何上，互补是**沿联结轴做镜像**（`θ → −θ`），**不是**旋转 180°：`LM 温暖亲和` 的互补点
 * 是它自己，`DE 冷漠疏离` 的互补点也是它自己——这才是「温暖招来温暖」的意思。把互补讲成
 * 180° 只在 `PA ↔ HI` 这一对上凑巧成立，其余六对全错。已核对的互补对：
 * **PA↔HI、BC↔FG、NO↔JK，LM 与 DE 自互补**。
 *
 * ⚠️ 第四个原型（掌控相同 + 联结相反）在已核实的来源里**没有**一个稳定的专名。英文文献里
 * "anti-complementarity" 被用来指 180° 那个原型（上一条 `opposite`），而中文「互补性」在
 * 倪等 (2020) 的用法里**专门指控制轴那一半**，与英文把 complementarity 当总称正好相反。
 * 为了不把一个有争议的词硬安上去，本表直接按**轴关系**命名它（`contrast` / 错位），
 * 并在 README 里记下这处术语冲突。
 */
export const PROTOTYPES = Object.freeze([
  Object.freeze({
    id: 'complementary', zh: '互补', en: 'Complementary',
    agency: 'opposite', communion: 'same',
    gloss: '一个人拿主意，另一个人配合；两个人的亲近程度差不多（文献称「人际互补」）',
    ideal: (self) => ({ a: 1 - self.a, c: self.c }),
  }),
  Object.freeze({
    id: 'similar', zh: '相似', en: 'Similar',
    agency: 'same', communion: 'same',
    gloss: '谁强谁弱、想不想亲近，两个人都差不多（文献称 similarity）',
    ideal: (self) => ({ a: self.a, c: self.c }),
  }),
  Object.freeze({
    id: 'contrast', zh: '错位', en: 'Contrast',
    agency: 'same', communion: 'opposite',
    gloss: '谁也不比谁强势，但一个想亲近、一个想保持距离（文献没有稳定专名，本项目命名）',
    ideal: (self) => ({ a: self.a, c: 1 - self.c }),
  }),
  Object.freeze({
    id: 'opposite', zh: '对立', en: 'Opposite',
    agency: 'opposite', communion: 'opposite',
    gloss: '谁强谁弱、想不想亲近，全都对着来（圆环上真正的 180°）',
    ideal: (self) => ({ a: 1 - self.a, c: 1 - self.c }),
  }),
]);

/** 按 `id` 快速取原型。 */
const PROTOTYPE_BY_ID = new Map(PROTOTYPES.map((prototype) => [prototype.id, prototype]));

/**
 * 取原型的理想位置（相对 `self`）。
 * @param {string} id 原型 id。
 * @param {{a:number,c:number}} self 角色的位置。
 * @returns {{a:number,c:number}} 该原型下对方「应当在」的位置（未量化）。
 * @throws {RangeError} 当 id 未知时。
 */
export function prototypeIdeal(id, self) {
  const prototype = PROTOTYPE_BY_ID.get(id);
  if (prototype === undefined) throw new RangeError(`未知 IPC 关系原型 id：${String(id)}`);
  return quantizePoint(prototype.ideal(self));
}

/**
 * 角色的「互补位置」：掌控取反、联结保持。
 *
 * ⚠️ 几何上这是**沿联结轴的镜像**（`y → -y`），不是绕原点旋转 180°。二者在
 * 圆盘上都不是同一件事：
 *
 * - 镜像：`(a, c) → (1−a, c)`，于是 `LM 温暖亲和` 的互补点是它**自己**——
 *   这正符合理论：温暖招来温暖，温暖不需要一个「反温暖」的对手。
 * - 旋转 180°：`(a, c) → (1−a, 1−c)`，会把 `DE` 送到 `LM 冷漠敌对`，那描述的
 *   是**对立**而非互补。
 *
 * Kiesler 的定义是「支配诱发顺从、温暖诱发温暖」，所以正确的几何是镜像。
 * 把互补讲成 180° 对立是最常见的误读，本模块用 {@link PROTOTYPES} 里的
 * `opposite` 单独承载那个概念，不让两者混为一谈。
 * @param {{a:number,c:number}} point 角色的位置。
 * @returns {{a:number,c:number}} 互补位置（未量化）。
 */
export function complementOf(point) {
  return { a: 1 - point.a, c: point.c };
}

/**
 * 角色的「错位位置」：掌控保持、联结取反。
 * @param {{a:number,c:number}} point 角色的位置。
 * @returns {{a:number,c:number}} 反互补位置（未量化）。
 */
export function antiComplementOf(point) {
  return { a: point.a, c: 1 - point.c };
}

/**
 * 互补性的两个轴级分量，以及它们的**均值**与**下界**。
 *
 * ## 术语与归属（这两个名字不是随便起的）
 *
 * - **`reciprocity` 互动性/互补性** = 掌控轴**相反**。「主导招来顺从，顺从招来主导」。
 * - **`correspondence` 一致性** = 联结轴**相同**。「友好招来友好，敌对招来敌对」。
 * - 二者合起来才是英文文献里的 **complementarity**（中文「人际互补」）。
 *
 * ⚠️ 中文的用法与英文**正好相反**，实现时不要被绕进去：倪等 (2020) 写「互动双方在情感
 * 维度的**一致性**和控制维度的**互补性**统称为**人际互补**」——中文的「互补性」收窄到了
 * **控制轴那一半**，而英文的 "complementarity" 是总称、那一半叫 "reciprocity"。
 * 本模块的 `complementarity` 取英文的总称义（两半的均值），两个分量则各用一个无歧义的名字。
 *
 * 单独抽成一个函数是因为**动力学层也要用同一个公式**（非互补会引发升级，见
 * `core/dynamics.js`）。如果那里另写一份，公式一旦被改动就会静默分叉：度量层说
 * 「已经互补了」，动力学层却按另一套公式判定「非互补」并继续加码。
 *
 * ## 为什么返回两个标量而不是一个
 *
 * 互补性是**合取式**的：要求掌控相反**且**联结相同，两个条件都满足才算一次确认性的
 * 交易。于是同一个公式有两种合理读法：
 *
 * - **均值** `complementarity`：一个平滑的总体接近度。两个轴各错一半，和「一个轴
 *   全对、另一个轴全错」，在均值下都是 0.5。
 * - **下界** `complementarityFloor`：最弱的那一环，合取式读法。它认为上面两种情形
 *   **不同**——「一个轴全错」意味着这次互动**没有被确认**，无论另一个轴多完美。
 *
 * 二者都保留，用在不同的地方：
 *
 * - 展示、审计、面板用均值（更稳、更易读）；
 * - **升级判定用下界**。理由是一句具体的反例：`LM 温暖亲和 × DE 冷漠疏离`（地位相当、
 *   一暖一冷）用均值算出来是 0.5，刚好卡在「不算太糟」的位置；但温暖撞上敌意恰恰是
 *   最典型的对抗情境。用下界算是 0，立刻触发升级。
 * @param {{a:number,c:number}} self 角色的位置。
 * @param {{a:number,c:number}} other 对方的位置。
 * @returns {{reciprocity:number, correspondence:number, complementarity:number, complementarityFloor:number}} 分量、均值与下界。
 */
export function complementarityOf(self, other) {
  const s = quantizePoint(self);
  const o = quantizePoint(other);
  // reciprocity：掌控轴相反。a_s + a_o = 1 时完全互补。
  const reciprocity = 1 - Math.abs(s.a + o.a - 1);
  // correspondence：联结轴相同。c_s = c_o 时完全一致。
  const correspondence = 1 - Math.abs(s.c - o.c);
  return {
    reciprocity,
    correspondence,
    complementarity: (reciprocity + correspondence) / 2,
    complementarityFloor: Math.min(reciprocity, correspondence),
  };
}

/**
 * 计算一段关系的全部度量。
 *
 * 返回的东西刻意分成三层，便于不同消费者各取所需：
 *
 * 1. **两人各自的位置**（`selfVector` / `otherVector` / 分仪 / 半径 / 角度）；
 * 2. **四种原型的拟合度**（`prototypes` 与 `pattern`）——「这段关系像什么」；
 * 3. **轴级分量**（`reciprocity` / `correspondence` / …）——「为什么像」。
 *
 * 第 3 层是理论上的正主：互补性是**两个轴分别预测**的，把头号标量
 * `complementarity` 定义成两个轴分量的均值（而不是几何距离），就是为了不让
 * 「两个轴各错一半」和「一个轴全对、另一个轴全错」得到同一个分数。
 *
 * ## ⚠️ 这里刻意**不**使用 structural summary 的三个词（elevation / amplitude / displacement）
 *
 * 第一版把「双方半径的均值」叫 `elevation`、把「半径之差」叫 `amplitude`。那是把
 * 一套有确切定义的术语随手挪用，而定义完全不同（据 `circumplex` R 包文档）：
 *
 * | 术语 | 真正的定义 |
 * |---|---|
 * | **elevation** | **八个分数的均值**——一般因子的大小；在人际问题量表上读作「总体人际困扰」 |
 * | **amplitude**（别名 vector length, R） | **`√(X² + Y²)`**——剖面的**分化度**，有多大起伏 |
 * | **displacement**（别名 angular location, O） | **`atan2(Y, X)`**——曲线峰值所在角度，即「风格」 |
 *
 * 所以：
 *
 * - 每个人自己的 `amplitude` = 他的**半径**，`displacement` = 他的**角度**——这两个是
 *   货真价实的 SSM 量，只是作用在单点上，字段名就叫 `selfRadius` / `selfAngle`；
 * - 而「双方平均有多极端」「双方有多不对等」**不是** SSM 的量，因此改用不会引起
 *   误读的自造名：`meanIntensity`（平均分化度）与 `radiusGapRatio`（不对等）；
 * - **`elevation` 干脆不提供**：本模型只有两个点、没有八个分数，算不出那个一般因子，
 *   硬凑一个数再冠上这个名字，比不给更糟。
 *
 * 这一处纠正来自核对 `circumplex` 包文档时发现的术语挪用；README 里记了整条推理。
 *
 * @param {{a:number,c:number}} self 角色（character）的位置。
 * @param {{a:number,c:number}} other 用户（user）的位置。
 * @param {object} [options] 选项。
 * @param {number} [options.neutralRadius=0.1] 中性区半径。
 * @returns {object} 关系度量。
 */
export function relationship(self, other, options = {}) {
  const neutralRadius = options.neutralRadius ?? STEP;
  const s = quantizePoint(self);
  const o = quantizePoint(other);

  const distanceValue = distance(s, o);
  const complement = complementOf(s);
  const complementDistance = distance(o, complement);
  const separation = separationDegrees(s, o);

  // ---- 轴级关系。四个量都是 [0,1]，1 表示该轴完全符合该关系。
  // 它们是本模块所有关系读数的**唯一来源**：标量、原型拟合、升级判定全部由这四
  // 个数组合而成，因此不可能出现「标量说互补、分类器说对立」这种自相矛盾。
  const { reciprocity, correspondence, complementarity, complementarityFloor } =
    complementarityOf(s, o);
  const agencyCorrespondence = 1 - Math.abs(s.a - o.a);
  const communalOpposition = 1 - Math.abs(s.c + o.c - 1);

  // ---- 原型拟合：按轴聚合，且按「该轴有没有信息」加权。
  //
  // 两个设计决定，都是被 bug 逼出来的：
  //
  // 1. **按轴聚合，而不是算到理想位置的欧氏距离**。第一版用了后者
  //    （`1 − d/√2`），结果是**所有**原型的拟合度都挤在 0.6~0.95，完全没有区分度：
  //    一个「只在联结轴上差 0.4」的配对会拿到 0.93 的高分，读起来像完美匹配。
  //    按轴聚合则直接复用上面那四个量，数值就是「这个轴符合到什么程度」，可解释。
  // 2. **按信息量加权**。若双方在某个轴上都恰好是 0.5，这个轴就**不携带任何关系
  //    信息**——此时「同」和「反」在数学上同时成立，不加权就会让四个原型的拟合度
  //    全部塌到同一个数，分类器彻底失效。权重取「双方在该轴上偏离中心的最大值」，
  //    于是只有真正有内容的轴参与投票。
  const weightAgency = Math.max(Math.abs(s.a - NEUTRAL.a), Math.abs(o.a - NEUTRAL.a));
  const weightCommunion = Math.max(Math.abs(s.c - NEUTRAL.c), Math.abs(o.c - NEUTRAL.c));
  const weightTotal = weightAgency + weightCommunion;

  const prototypes = PROTOTYPES.map((prototype) => {
    const agencyScore = prototype.agency === 'same' ? agencyCorrespondence : reciprocity;
    const communionScore = prototype.communion === 'same' ? correspondence : communalOpposition;
    // 权重为零（双方都在中心）时所有原型等价，拟合度记 1 —— 此时 `flat` 为 true，
    // 调用方本来就不该读 `pattern`。
    const fit = weightTotal === 0
      ? 1
      : (weightAgency * agencyScore + weightCommunion * communionScore) / weightTotal;
    return {
      id: prototype.id,
      zh: prototype.zh,
      en: prototype.en,
      gloss: prototype.gloss,
      ideal: quantizePoint(prototype.ideal(s)),
      fit,
    };
  }).sort((left, right) => right.fit - left.fit);

  // ---- 每个轴「有没有内容」以及「能不能分辨同/反」。
  //
  // 这一步是被一串**看起来自相矛盾的输出**逼出来的。若双方在某个轴上都是 0.5，那么
  // 「相同」和「相反」在数学上**同时成立**（`1−|a−b|` 与 `1−|a+b−1|` 都等于 1），
  // 于是四个原型里必然有两个并列满分。典型例子：
  //
  // ```
  // PA 支配(1.0,0.5) × HI 顺从(0.0,0.5)  →  互补 1.00、对立 1.00   （联结轴两方都居中）
  // PA 支配(1.0,0.5) × PA 支配(1.0,0.5)  →  相似 1.00、错位 1.00   （同上）
  // ```
  //
  // 这是**结构性退化**，不是数据问题：联结那一半根本没提供信息，所以关于它的一切
  // 断言都是空的。把它当成「定性不明确」是错的——掌控那一半其实给出了满分级的
  // 明确结论。真正需要标出来的另一种情形是：**唯一有内容的那个轴自己分辨不出
  // 同与反**（因为其中一方恰好居中），此时任何关系断言都失去依据。
  const decisive = {
    a: Math.abs(agencyCorrespondence - reciprocity) > AXIS_DECISIVE_MARGIN,
    c: Math.abs(correspondence - communalOpposition) > AXIS_DECISIVE_MARGIN,
  };
  const weights = { a: weightAgency, c: weightCommunion };
  const undeterminedAxes = AXES.filter((axis) => (
    weights[axis] <= AXIS_INFORMATIVE_MARGIN || !decisive[axis]
  ));

  const patternMargin = prototypes[1] === undefined ? 1 : prototypes[0].fit - prototypes[1].fit;
  /**
   * 分类是否不唯一。
   *
   * 判据是「头两名几乎并列」**且**「这个并列不能用一个无信息轴解释掉」。恰好有一个
   * 无信息轴时，并列只发生在「仅在该轴上不同」的那两个原型之间（如互补 vs 对立），
   * 而有内容的那个轴仍然给出明确结论，所以不算不唯一——只要如实说明哪一半没有信息
   * （见 `undeterminedAxes`）即可。
   */
  const patternAmbiguous = patternMargin < PATTERN_AMBIGUITY_MARGIN && undeterminedAxes.length !== 1;

  const selfRadius = radius(s);
  const otherRadius = radius(o);
  const selfNeutral = isNeutral(s, neutralRadius);
  const otherNeutral = isNeutral(o, neutralRadius);

  return {
    self: s,
    other: o,
    selfKey: gridKey(s),
    otherKey: gridKey(o),
    selfVector: vectorOf(s),
    otherVector: vectorOf(o),
    delta: { a: o.a - s.a, c: o.c - s.c },

    // ---- 位置本身
    //
    // 这些量就是 SSM 在**单点**上的类比物（半径 ≈ 分化度，角度 ≈ 风格），但一律用
    // 平白的几何名。原因见下方「结构摘要」那段：SSM 的 elevation / amplitude /
    // displacement 定义在 8 个分仪分数构成的曲线之上，本模型没有那条曲线，
    // 借用它们的名字只会让人以为算的是同一个东西。
    selfOctant: octantOf(s),
    otherOctant: octantOf(o),
    /** 角色姿态的方向（度，从 +联结/右 起算、逆时针为正）。 */
    selfAngle: angleDeg(s),
    otherAngle: angleDeg(o),
    /** 角色姿态的半径（0 ~ 圆盘半径 0.5）。 */
    selfRadius,
    otherRadius,
    /** 角色姿态的强度（半径 / 圆盘半径，0~1）。 */
    selfIntensity: selfRadius / MAX_RADIUS,
    otherIntensity: otherRadius / MAX_RADIUS,
    selfNeutral,
    otherNeutral,

    // ---- 关系几何
    distance: distanceValue,
    distanceRatio: distanceValue / MAX_DISTANCE,
    separationDegrees: separation,
    separationRatio: separation / 180,

    // ---- 理论上的正主：轴级分量
    /**
     * 互动性 / 互补性（掌控轴相反）：主导招来顺从，顺从招来主导。
     * 这一半在中文文献里就叫「互补性」，配对的是**控制轴**。
     */
    reciprocity,
    /**
     * 一致性（联结轴相同）：友好招来友好，敌对招来敌对。
     * 这一半在中文文献里叫「一致性」，配对的是**情感轴**。
     */
    correspondence,
    agencyCorrespondence,
    communalOpposition,
    /**
     * 互补性总标量（英文义的总称，= 中文「人际互补」）：互动性与一致性的**均值**。
     * 1 = 完全互补（如 PA 支配 × HI 顺从，或 LM 温暖 × LM 温暖）。
     */
    complementarity,
    /**
     * 互补性的**下界**：两个分量里更弱的那个。
     *
     * 合取式读法下的互补性——任一个轴没有被确认，这次交易就没有被确认。
     * 升级判定看的是它，不是均值；理由见 {@link complementarityOf}。
     */
    complementarityFloor,
    /** 对立性：两个轴都相反的均值（圆环上的 180°）。 */
    opposition: (reciprocity + communalOpposition) / 2,
    /**
     * 相似性：**两个轴都相同**。这是与互补**并列**的另一种关系，不是互补的同义词——
     * 关系研究里两者被明确对照（Dryer & Horowitz, 1997）。刻意用轴级均值而不是几何
     * 相似度 `1 − d`：后者会把「只差 0.4」也读成 0.60，与「完全一致」区分不开。
     */
    similarity: (agencyCorrespondence + correspondence) / 2,
    /** 几何相似度：`1 − 距离 / 直径`。留着是为了与其它工具的欧氏读数对照。 */
    euclideanSimilarity: similarityFromDistance(distanceValue),
    /** 几何互补度：对方离「理想互补位置」有多近。与 `complementarity` 是两条路，见模块注释。 */
    geometricComplementarity: similarityFromDistance(complementDistance),

    // ---- 理想位置与原型
    complementPoint: quantizePoint(complement),
    contrastPoint: quantizePoint(antiComplementOf(s)),
    complementDistance,
    prototypes,
    pattern: prototypes[0],
    /**
     * 头名与次名的拟合度之差。裕度小意味着分类本身不唯一，此时不该对模型或用户断言
     * 「你们是互补的」。见 `patternAmbiguous` 的注释。
     */
    patternMargin,
    patternAmbiguous,
    /**
     * 既不携带信息、又分辨不出「同/反」的轴。
     *
     * 为空时说明两个轴都给出了明确结论；只含一个轴时（最常见）说明这段关系的定性
     * 完全来自另一个轴——上层应当**照实说出来**，而不是假装两个轴都读到了东西。
     */
    undeterminedAxes,
    /** 每个轴是否分辨得出「同」与「反」。 */
    decisive,
    /** 每个轴的信息量权重（双方偏离中心的最大值）。 */
    axisWeights: weights,
    /** 双方都贴近中性区时为 true——此时任何分仪命名都是过度解读。 */
    flat: selfNeutral && otherNeutral,

    // ---- 结构摘要（structural summary）
    //
    // ⚠️ 这三个量刻意**不叫** SSM 的 elevation / amplitude / displacement。
    //
    // 已核实的 SSM 定义（circumplex R 包文档与 Cain et al. 2012 原话）：
    //
    // | 参数 | 定义 |
    // |---|---|
    // | elevation（e） | **剖面的均值**——一般因子的大小 |
    // | amplitude（a，别名 vector length, R） | **峰值与均值之差**，即剖面的**分化度** |
    // | displacement（d，别名 angular location, O） | 曲线峰值所在角度，即**风格** |
    // | R² | 与余弦曲线的拟合优度（prototypicality） |
    //
    // 这四个量都定义在「8 个分仪分数构成一条曲线」之上。本模型一个会话只有**两个点**、
    // 没有 8 个分数，因此**算不出** elevation，也谈不上「峰值与均值之差」。硬凑一个数
    // 再冠上那些名字，就是术语挪用——第一版正是这么干的（把「双方半径均值」叫
    // elevation、把「半径之差」叫 amplitude），所以这里改用不会引起误读的名字。
    //
    // 另外：网上流传的「R / O / C 三个结构摘要参数」**未能核实**（R = vector length、
    // O = angular location 尚可推断，C 的含义查不到），本项目不使用这套缩写。
    /**
     * 双方的平均强度（半径均值 / 圆盘半径）。越高说明这段关系的姿态越鲜明、越有辨识度。
     * 与单点强度 {@link intensity} 同尺度，可直接比较。
     */
    meanIntensity: (selfRadius + otherRadius) / 2 / MAX_RADIUS,
    /**
     * 不对等：双方强度之差。越高说明一方远比另一方投入/强势——
     * 它是「这段关系里谁更在意」的几何版本。
     */
    radiusGapRatio: Math.abs(selfRadius - otherRadius) / MAX_RADIUS,
    neutralRadius,
  };
}

/**
 * 渲染「这次分类的可靠程度」的简短注记。
 *
 * 三种情形必须分开说，因为它们对读者的意义完全不同：
 * - 有一个原型紧追在后 → 分类**不唯一**，要连同次名一起报出来；
 * - 一个轴没信息 → 结论成立，只是**只基于另一个轴**（最常见的正常情形）；
 * - 都没信息 → `flat`，调用方本来就不该问「是什么关系」。
 *
 * 注意这里**不停在「不明确」上**：只说「不明确」等于把信息丢掉。既然算了四个拟合度，
 * 就该把头名与次名一起给出（「更接近互补 0.89，但对立 0.93 也差不多」），
 * 由上层决定怎么用。
 * @param {object} metrics {@link relationship} 的结果。
 * @returns {string} 注记文本，或空串。
 */
export function informationNote(metrics) {
  const labels = { a: AXIS_META.a.zh, c: AXIS_META.c.zh };
  if (metrics.flat) return '';
  const runnerUp = metrics.prototypes[1];
  if (metrics.patternAmbiguous && runnerUp !== undefined) {
    return `（和「${runnerUp.zh}」也差不多，分不清更像哪个）`;
  }
  const missing = metrics.undeterminedAxes ?? [];
  if (missing.length === 0) return '';
  const determined = AXES.filter((axis) => !missing.includes(axis)).map((axis) => labels[axis]);
  return `（只看「${determined.join('、')}」：另一个两人都居中，没有信息）`;
}

/**
 * 用一句话概括关系，适合日志、工具返回值与面板副标题。
 * @param {object} metrics {@link relationship} 的结果。
 * @returns {string} 例如 `最像：一个带、一个跟（0.92）| 角色 主导 × 用户 退让 | 相隔 12°`。
 */
export function summarizeRelationship(metrics) {
  if (metrics.flat) {
    return `两人都很平淡（说不上谁主导、也谈不上亲疏）`
      + ` | 相隔 ${Math.round(metrics.separationDegrees)}°`;
  }
  // 保留「像」这个限定词：`pattern.fit` 是「像这种关系的程度」，而 `complementarity`
  // 是两个轴合起来的一个分数。两者数值不同，不区分会让人以为其中一个算错了。
  return `最像「${metrics.pattern.zh}」（${metrics.pattern.fit.toFixed(2)}）${informationNote(metrics)}`
    + ` | 角色：${metrics.selfOctant.zh}，用户：${metrics.otherOctant.zh}`
    + ` | 相隔 ${Math.round(metrics.separationDegrees)}°`;
}
