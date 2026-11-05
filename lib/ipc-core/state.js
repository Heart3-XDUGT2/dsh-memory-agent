/**
 * 会话级「双人关系」状态机。
 *
 * ## 与 PAD 状态机的结构差异
 *
 * PAD 每个会话存**一个点**（角色的情绪）。本模型每个会话存**两个点**——角色对
 * 用户的姿态、以及角色感知到的用户姿态——因为 IPC 的关系量（互补性、对应性、
 * 张力）是**二元函数**，只存一个点算不出来。这两个点必须一起更新、一起经同一把尺子度量，
 * 一起持久化，否则过渡态会出现「一方已经变了、另一方还是旧的」这种自相矛盾的读数。
 *
 * ## 存储布局
 *
 * 每一方都存两份值：
 *
 * ```
 * grid     ∈ {0.0, 0.1, …, 1.0}²    // 121 个格子，精度 0.1，对外可见的规范状态
 * residual ∈ [-0.05, 0.05)²          // 量化残差，防止小步推动被永久抹掉
 *
 * latent = clamp01(grid + residual)  // 内部连续值
 * ```
 *
 * 残差的理由与 PAD 相同：0.1 的步长会把 `+0.04` 这样的微调抹成 0，于是一段持续
 * 但温和的冷淡永远推不动关系。
 *
 * @module dsh-interpersonal-circumplex/core/state
 */

import {
  AXES,
  NEUTRAL,
  angleDeg,
  distance,
  gridKey,
  intensity,
  isNeutral,
  octantOf,
  quantizePoint,
  radius,
  relationship,
} from './circumplex.js';
import {
  DEFAULT_DYNAMICS,
  composeLatent,
  integrateDyad,
 resolveDynamics,
  splitLatent,
} from './dynamics.js';
import { describeRegion } from './match.js';

/** 双方状态之间的键分隔符。 */
export const KEY_SEPARATOR = '|';

/**
 * 组合出整个二元状态的稳定键。
 * @param {{a:number,c:number}} self 角色位置。
 * @param {{a:number,c:number}} other 用户位置。
 * @returns {string} 形如 `"0.8,0.5|0.2,0.5"` 的键。
 */
export function dyadKey(self, other) {
  return `${gridKey(self)}${KEY_SEPARATOR}${gridKey(other)}`;
}

/**
 * 解析 {@link dyadKey}。
 * @param {string} key 二元键。
 * @returns {{self:{a:number,c:number}, other:{a:number,c:number}}} 两个点。
 */
export function parseDyadKey(key) {
  const parts = String(key).split(KEY_SEPARATOR);
  if (parts.length !== 2) throw new TypeError(`无法解析 IPC 关系键：${String(key)}`);
  return {
    self: quantizePoint(parseGrid(parts[0])),
    other: quantizePoint(parseGrid(parts[1])),
  };
}

/**
 * 解析单方的 `"a,c"` 网格键。
 * @param {string} text 网格键。
 * @returns {{a:number,c:number}} 点。
 */
function parseGrid(text) {
  const parts = String(text).split(',').map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    throw new TypeError(`无法解析 IPC 格子键：${String(text)}`);
  }
  return { a: parts[0], c: parts[1] };
}

/**
 * 组装一份新的空白双方状态。
 * @param {string} sessionId 会话 id。
 * @param {typeof DEFAULT_DYNAMICS} dynamics 已解析的动力学配置。
 * @param {number} at 创建时间戳。
 * @returns {object} 状态对象。
 */
function blankState(sessionId, dynamics, at) {
  return {
    sessionId,
    self: { grid: quantizePoint(dynamics.baselineSelf), residual: { a: 0, c: 0 } },
    other: { grid: quantizePoint(dynamics.baselineOther), residual: { a: 0, c: 0 } },
    updatedAt: at,
    createdAt: at,
    turns: 0,
    lastReason: undefined,
    lastPattern: undefined,
    lastSource: undefined,
    /** 本轮打分给出的两个短语，用于「概述用哪个词」。 */
    lastLabels: undefined,
    /** 本轮打分要求抵达的两个点，用于判断状态有没有漂开。 */
    lastTarget: undefined,
  };
}

/** 打分器的词最多允许漂离多远，超过就退回词表最近邻。 */
const DISPLAY_WORD_MAX_DRIFT = 0.3;

/**
 * 选一个用来概述某一方姿态的词。
 *
 * 优先用打分器给出的短语——它带着上下文（能说出「嘴上配合但心里不服」），而
 * 词表只有 41 个锚点、粒度不足以覆盖每种姿态。只在状态漂离那次判断超过
 * {@link DISPLAY_WORD_MAX_DRIFT} 之后才退回词表。
 * @param {{a:number,c:number}} grid 当前网格点。
 * @param {string|undefined} label 打分器给的短语。
 * @param {{a:number,c:number}|undefined} target 打分要求抵达的点。
 * @param {object} region {@link describeRegion} 的结果。
 * @returns {{zh:string, provenance:string, fromAppraisal:boolean, drift:number|null}} 选中的词。
 */
function chooseDisplayWord(grid, label, target, region) {
  const anchor = region.word;
  if (typeof label !== 'string' || label === '' || target === undefined || target === null) {
    return {
      zh: region.neutral ? '平淡' : (anchor?.zh ?? region.label),
      provenance: anchor?.provenance ?? 'definitional',
      fromAppraisal: false,
      drift: null,
    };
  }
  const drift = distance(grid, target);
  if (drift > DISPLAY_WORD_MAX_DRIFT) {
    return {
      zh: region.neutral ? '平淡' : (anchor?.zh ?? region.label),
      provenance: anchor?.provenance ?? 'definitional',
      fromAppraisal: false,
      drift,
    };
  }
  return { zh: label, provenance: 'appraisal', fromAppraisal: true, drift };
}

/**
 * 给单方状态补上全部派生字段。
 *
 * 派生字段一律现算而不是存下来：存下来就会和 `grid` 不一致，而「UI 显示的方向」
 * 和「模型看到的方向」不一致是这类系统最典型的 bug。
 * @param {{grid:{a:number,c:number}, residual:{a:number,c:number}}} person 单方状态。
 * @param {{a:number,c:number}} latent 连续值。
 * @param {object} [options] 选项。
 * @returns {object} 单方派生视图。
 */
function decoratePerson(person, latent, options = {}) {
  const grid = quantizePoint(latent);
  const region = describeRegion(grid, options);
  return {
    grid,
    residual: { ...person.residual },
    latent,
    key: gridKey(grid),
    angle: angleDeg(grid),
    radius: radius(grid),
    intensity: intensity(grid),
    neutral: isNeutral(grid, options.neutralRadius ?? 0.1),
    octant: region.octant,
    region,
  };
}

/**
 * 会话级关系状态机。
 *
 * 纯内存实现，不依赖 DSH，因而可以在 node 里直接单测。持久化由 host 插件在
 * 本类的读写调用点之外完成。
 */
export class InterpersonalStore {
  /**
   * @param {object} [options] 选项。
   * @param {Partial<typeof DEFAULT_DYNAMICS>} [options.dynamics] 动力学配置。
   * @param {() => number} [options.now] 时钟注入点，便于测试。
   * @param {number} [options.historyLimit=200] 每会话保留的变迁记录条数上限。
   * @param {number} [options.transcriptLimit=40] 每会话保留的对话转写条数上限。
   * @param {number} [options.neutralRadius=0.1] 中性区半径。
   */
  constructor(options = {}) {
    /** 已解析的动力学配置。 */
    this.dynamics = resolveDynamics(options.dynamics ?? {});
    /** @type {Map<string, object>} 会话 id → 双方状态。 */
    this.states = new Map();
    /** @type {Map<string, object[]>} 会话 id → 变迁历史。 */
    this.history = new Map();
    /** @type {Map<string, Array<{role: string, text: string}>>} 会话 id → 最近对话转写。 */
    this.transcripts = new Map();
    /**
     * @type {Set<string>} 被面板开关关掉关系功能的会话 id。
     *
     * 存「关掉的」而不是「开着的」：默认全开，空集合即默认行为，新会话自动开启。
     */
    this.disabledSessions = new Set();
    this.now = options.now ?? (() => Date.now());
    this.historyLimit = options.historyLimit ?? 200;
    this.transcriptLimit = options.transcriptLimit ?? 40;
    this.neutralRadius = options.neutralRadius ?? 0.1;
  }

  /**
   * 更新动力学配置（保留现有状态）。
   * @param {Partial<typeof DEFAULT_DYNAMICS>} patch 新配置。
   * @returns {typeof DEFAULT_DYNAMICS} 解析后的完整配置。
   */
  configure(patch) {
    this.dynamics = resolveDynamics({ ...this.dynamics, ...patch });
    return this.dynamics;
  }

  /**
   * 取会话状态，不存在则按基线惰性创建。
   * @param {string} sessionId 会话 id。
   * @returns {object} 原始状态对象（可变，仅供本类内部使用）。
   */
  ensure(sessionId) {
    let state = this.states.get(sessionId);
    if (state === undefined) {
      state = blankState(sessionId, this.dynamics, this.now());
      this.states.set(sessionId, state);
      this.history.set(sessionId, []);
    }
    return state;
  }

  /**
   * 只读读取当前状态。
   *
   * ⚠️ 这里**没有**任何「按时间投影」的步骤：两个点只在上一次 `apply` 时改变过，
   * 读多少次都一样。以前这里会先按半衰期把双方各自拉向基线（惰性投影，不回写），
   * 那是时间项的产物，已随衰减一起删除——见 `core/dynamics.js` 开头的说明。
   * @param {string} sessionId 会话 id。
   * @returns {object} 派生视图。
   */
  read(sessionId) {
    const state = this.ensure(sessionId);

    // 连续值由「网格 + 残差」合成，因此对外暴露的 `latent` 是真正的连续位置，而不是
    // 被量化过的网格值——否则调用方无法观察「状态正在向某个格子滑动但还没到」这种中间态。
    const selfLatent = composeLatent(state.self.grid, state.self.residual);
    const otherLatent = composeLatent(state.other.grid, state.other.residual);

    const options = { neutralRadius: this.neutralRadius };
    const self = decoratePerson(state.self, selfLatent, options);
    const other = decoratePerson(state.other, otherLatent, options);
    const metrics = relationship(self.grid, other.grid, options);

    const labels = state.lastLabels ?? {};
    const target = state.lastTarget ?? {};

    return {
      sessionId,
      self,
      other,
      metrics,
      key: dyadKey(self.grid, other.grid),
      turns: state.turns,
      updatedAt: state.updatedAt,
      createdAt: state.createdAt,
      lastReason: state.lastReason,
      lastPattern: state.lastPattern,
      lastSource: state.lastSource,
      /**
       * 打分器上一轮给出的两个姿态短语。
       *
       * ⚠️ 这个字段曾经漏在 `read()` 之外，而 host 侧同时把它当作打分提示词的
       * `previousLabels` 和提示词块的 `triggerLabels` 用——结果是两处都静默拿到
       * `undefined`，「本轮读到的姿态」那一句永远不会出现，而且不报错。
       * 单元测试里的持久化往返用例把它抓了出来。
       */
      lastLabels: state.lastLabels === undefined ? null : { ...state.lastLabels },
      lastTarget: state.lastTarget ?? null,
      displaySelf: chooseDisplayWord(self.grid, labels.self, target.self, self.region),
      displayOther: chooseDisplayWord(other.grid, labels.other, target.other, other.region),
    };
  }

  /**
   * 应用一次关系打分并返回变迁详情。
   * @param {object} params 输入。
   * @param {string} params.sessionId 会话 id。
   * @param {{self:{a:number,c:number}, other:{a:number,c:number}}|null} params.appraisal 打分结果；
   *   `null` 表示本轮无新证据，状态保持不动。
   * @param {string} [params.reason] 变化理由。
   * @param {{self?:string, other?:string}} [params.labels] 双方姿态的短语。
   * @param {string} [params.pattern] 本轮的关系模式名。
   * @param {string} [params.source] 打分来源（`llm` / `manual`）。
   * @param {number} [params.confidence] 置信度。
   * @param {number} [params.gain] 用于缩放惯性系数的可信度 0~1；省略时取 `confidence`。
   * @param {number} [params.at] 时间戳，默认取时钟。
   * @returns {{before:object, after:object, transition:object}} 变迁详情。
   */
  apply({
    sessionId,
    appraisal,
    reason,
    labels,
    pattern,
    source = 'manual',
    confidence = 1,
    gain,
    at = this.now(),
  }) {
    const state = this.ensure(sessionId);
    const before = this.read(sessionId);

    const current = {
      self: composeLatent(state.self.grid, state.self.residual),
      other: composeLatent(state.other.grid, state.other.residual),
    };

    const result = integrateDyad({
      current,
      // 显式传 null：integrateDyad 会保持两个点不动，不引入刺激，也不触发升级。
      appraisal: appraisal ?? null,
      dynamics: this.dynamics,
      gain: gain ?? confidence,
    });

    const selfSplit = splitLatent(result.latent.self);
    const otherSplit = splitLatent(result.latent.other);
    state.self = { grid: selfSplit.grid, residual: selfSplit.residual };
    state.other = { grid: otherSplit.grid, residual: otherSplit.residual };
    state.updatedAt = at;

    // 只有真正施加了新证据才更新「本轮」的元数据。没有新证据的结算会把它覆盖成
    // 「本轮无新证据」，于是提示词里的「成因」会与它上方那组数值对不上。
    if (result.stimulusApplied) {
      state.turns += 1;
      state.lastReason = reason;
      state.lastPattern = pattern;
      state.lastSource = source;
      state.lastLabels = labels === undefined ? undefined : { ...labels };
      state.lastTarget = {
        self: { ...appraisal.self },
        other: { ...appraisal.other },
      };
    }

    const after = this.read(sessionId);

    const transition = {
      sessionId,
      at,
      index: state.turns,
      from: { self: before.self.grid, other: before.other.grid },
      to: { self: after.self.grid, other: after.other.grid },
      fromKey: before.key,
      toKey: after.key,
      delta: result.delta,
      moved: distance(before.self.grid, after.self.grid) + distance(before.other.grid, after.other.grid),
      complementarityBefore: before.metrics.complementarity,
      complementarityAfter: after.metrics.complementarity,
      patternBefore: before.metrics.pattern.id,
      patternAfter: after.metrics.pattern.id,
      patternBeforeLabel: before.metrics.pattern.zh,
      patternAfterLabel: after.metrics.pattern.zh,
      patternChanged: before.metrics.pattern.id !== after.metrics.pattern.id,
      selfOctantBefore: before.self.octant.id,
      selfOctantAfter: after.self.octant.id,
      otherOctantBefore: before.other.octant.id,
      otherOctantAfter: after.other.octant.id,
      octantChanged: before.self.octant.id !== after.self.octant.id
        || before.other.octant.id !== after.other.octant.id,
      labels: { self: after.displaySelf.zh, other: after.displayOther.zh },
      labelsBefore: { self: before.displaySelf.zh, other: before.displayOther.zh },
      pattern,
      source,
      confidence,
      reason,
      appraisal: appraisal === null || appraisal === undefined
        ? null
        : { self: { ...appraisal.self }, other: { ...appraisal.other } },
      stimulusApplied: result.stimulusApplied,
      reactivity: result.reactivity,
      escalated: result.escalated,
    };

    this.pushHistory(sessionId, transition);
    return { before, after, transition };
  }

  /**
   * 强制覆盖双方状态，绕过惯性、升级与步长限制。
   *
   * 与 {@link InterpersonalStore.apply} 的分工：`apply` 模拟真实关系演化，`assign`
   * 用于人工调试与「用户明确要求把关系设定成某个样子」。
   * @param {string} sessionId 会话 id。
   * @param {{self?:{a:number,c:number}, other?:{a:number,c:number}}} points 目标点；缺省的一方保持不变。
   * @param {object} [meta] 附加说明。
   * @returns {{before:object, after:object, transition:object}} 变迁详情。
   */
  assign(sessionId, points = {}, meta = {}) {
    const state = this.ensure(sessionId);
    const before = this.read(sessionId);
    const at = meta.at ?? this.now();

    const selfGrid = quantizePoint(points.self ?? before.self.grid);
    const otherGrid = quantizePoint(points.other ?? before.other.grid);
    state.self = { grid: selfGrid, residual: { a: 0, c: 0 } };
    state.other = { grid: otherGrid, residual: { a: 0, c: 0 } };
    state.updatedAt = at;
    state.turns += 1;
    state.lastReason = meta.reason ?? '直接赋值';
    state.lastLabels = meta.labels === undefined ? undefined : { ...meta.labels };
    state.lastPattern = meta.pattern;
    state.lastSource = meta.source ?? 'manual';
    state.lastTarget = { self: { ...selfGrid }, other: { ...otherGrid } };

    const after = this.read(sessionId);
    const transition = {
      sessionId,
      at,
      index: state.turns,
      from: { self: before.self.grid, other: before.other.grid },
      to: { self: after.self.grid, other: after.other.grid },
      fromKey: before.key,
      toKey: after.key,
      delta: {
        self: Object.fromEntries(AXES.map((axis) => [axis, selfGrid[axis] - before.self.grid[axis]])),
        other: Object.fromEntries(AXES.map((axis) => [axis, otherGrid[axis] - before.other.grid[axis]])),
      },
      moved: distance(before.self.grid, selfGrid) + distance(before.other.grid, otherGrid),
      complementarityBefore: before.metrics.complementarity,
      complementarityAfter: after.metrics.complementarity,
      patternBefore: before.metrics.pattern.id,
      patternAfter: after.metrics.pattern.id,
      patternBeforeLabel: before.metrics.pattern.zh,
      patternAfterLabel: after.metrics.pattern.zh,
      patternChanged: before.metrics.pattern.id !== after.metrics.pattern.id,
      selfOctantBefore: before.self.octant.id,
      selfOctantAfter: after.self.octant.id,
      otherOctantBefore: before.other.octant.id,
      otherOctantAfter: after.other.octant.id,
      octantChanged: true,
      labels: { self: after.displaySelf.zh, other: after.displayOther.zh },
      labelsBefore: { self: before.displaySelf.zh, other: before.displayOther.zh },
      pattern: meta.pattern,
      source: state.lastSource,
      confidence: 1,
      reason: state.lastReason,
      appraisal: { self: { ...selfGrid }, other: { ...otherGrid } },
      stimulusApplied: true,
      reactivity: 1,
      escalated: 0,
    };
    this.pushHistory(sessionId, transition);
    return { before, after, transition };
  }

  /**
   * 把会话重置回基线。
   * @param {string} sessionId 会话 id。
   * @param {object} [meta] 附加说明。
   * @returns {{before:object, after:object, transition:object}} 变迁详情。
   */
  reset(sessionId, meta = {}) {
    return this.assign(sessionId, {
      self: this.dynamics.baselineSelf,
      other: this.dynamics.baselineOther,
    }, { ...meta, reason: meta.reason ?? '重置到基线' });
  }

  /**
   * 往会话的转写缓冲里追加一条消息。
   * @param {string} sessionId 会话 id。
   * @param {'user'|'assistant'} role 说话人角色。
   * @param {string} text 消息文本。
   * @returns {boolean} 是否真的写入了（空文本不写入）。
   */
  pushTranscript(sessionId, role, text) {
    if (typeof text !== 'string' || text.trim() === '') return false;
    const list = this.transcripts.get(sessionId) ?? [];
    list.push({ role, text });
    if (list.length > this.transcriptLimit) list.splice(0, list.length - this.transcriptLimit);
    this.transcripts.set(sessionId, list);
    return true;
  }

  /**
   * 读取会话的转写缓冲。
   * @param {string} sessionId 会话 id。
   * @returns {Array<{role:string, text:string}>} 由旧到新的消息副本。
   */
  readTranscript(sessionId) {
    return (this.transcripts.get(sessionId) ?? []).map((entry) => ({ ...entry }));
  }

  /**
   * 追加一条变迁记录，超出上限时丢弃最旧的。
   * @param {string} sessionId 会话 id。
   * @param {object} transition 变迁记录。
   */
  pushHistory(sessionId, transition) {
    const list = this.history.get(sessionId) ?? [];
    list.push(transition);
    if (list.length > this.historyLimit) list.splice(0, list.length - this.historyLimit);
    this.history.set(sessionId, list);
  }

  /**
   * 读取变迁历史。
   * @param {string} sessionId 会话 id。
   * @param {number} [limit=50] 最多返回条数（取最新的）。
   * @returns {object[]} 由旧到新的变迁记录。
   */
  readHistory(sessionId, limit = 50) {
    const list = this.history.get(sessionId) ?? [];
    return list.slice(Math.max(0, list.length - limit));
  }

  /**
   * 列出所有已知会话的当前视图。
   * @returns {object[]} 派生视图数组。
   */
  list() {
    return [...this.states.keys()].map((sessionId) => this.read(sessionId));
  }

  /**
   * 导出可持久化的数据。
   * @returns {object} 序列化结果。
   */
  toJSON() {
    return {
      dynamics: { ...this.dynamics },
      disabledSessions: [...this.disabledSessions],
      sessions: Object.fromEntries(
        [...this.states.entries()].map(([sessionId, state]) => [
          sessionId,
          {
            self: { grid: { ...state.self.grid }, residual: { ...state.self.residual } },
            other: { grid: { ...state.other.grid }, residual: { ...state.other.residual } },
            updatedAt: state.updatedAt,
            createdAt: state.createdAt,
            turns: state.turns,
            lastReason: state.lastReason,
            lastPattern: state.lastPattern,
            lastSource: state.lastSource,
            lastLabels: state.lastLabels,
            lastTarget: state.lastTarget,
            history: this.history.get(sessionId) ?? [],
            /**
             * 打分器的输入上下文。必须一起存：重启后缓冲为空的话，第一次打分
             * 只看得到一条消息，模型无从判断关系，只能给出「都很平淡」。
             */
            transcript: this.transcripts.get(sessionId) ?? [],
          },
        ]),
      ),
    };
  }

  /**
   * 从持久化数据恢复状态机。
   * @param {object} data {@link toJSON} 的输出。
   * @param {object} [options] 与构造函数相同的选项。
   * @returns {InterpersonalStore} 新实例。
   */
  static fromJSON(data, options = {}) {
    const store = new InterpersonalStore({
      ...options,
      dynamics: { ...(data?.dynamics ?? {}), ...(options.dynamics ?? {}) },
    });
    // 旧文件里多出来的 `savedAt` 会被忽略（不再读取）：没有时间项，恢复路径是纯快照。
    for (const sessionId of data?.disabledSessions ?? []) {
      if (typeof sessionId === 'string' && sessionId !== '') store.disabledSessions.add(sessionId);
    }
    /** 把磁盘上的一方状态读成规范形状；旧版本或字段缺失时回落到基线。 */
    const readPerson = (saved, baseline) => ({
      grid: quantizePoint(saved?.grid ?? baseline),
      residual: { a: saved?.residual?.a ?? 0, c: saved?.residual?.c ?? 0 },
    });
    for (const [sessionId, saved] of Object.entries(data?.sessions ?? {})) {
      store.states.set(sessionId, {
        sessionId,
        self: readPerson(saved.self, store.dynamics.baselineSelf),
        other: readPerson(saved.other, store.dynamics.baselineOther),
        updatedAt: saved.updatedAt ?? Date.now(),
        createdAt: saved.createdAt ?? saved.updatedAt ?? Date.now(),
        turns: saved.turns ?? 0,
        lastReason: saved.lastReason,
        lastPattern: saved.lastPattern,
        lastSource: saved.lastSource,
        lastLabels: saved.lastLabels,
        lastTarget: saved.lastTarget,
      });
      store.history.set(sessionId, Array.isArray(saved.history) ? saved.history : []);
      store.transcripts.set(
        sessionId,
        Array.isArray(saved.transcript)
          ? saved.transcript
            .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.text === 'string')
            .map((entry) => ({ role: entry.role === 'assistant' ? 'assistant' : 'user', text: entry.text }))
            .slice(-store.transcriptLimit)
          : [],
      );
    }
    return store;
  }

  /**
   * 当前双方基线。
   * @returns {{self:{a:number,c:number}, other:{a:number,c:number}}} 基线点。
   */
  get baselines() {
    return { self: this.dynamics.baselineSelf, other: this.dynamics.baselineOther };
  }
}

/** 再导出中心点与分仪判定，方便调用方不额外 import `circumplex.js`。 */
export { NEUTRAL, octantOf };
