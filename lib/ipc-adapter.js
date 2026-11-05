/**
 * IPC 适配器 —— `lib/ipc-core/`(MIT 只读副本)的唯一入口。
 *
 * 为什么要适配层:
 *   · IPC 插件**没有安装**到 `~/.dsh`(只有桌面源码副本),所以核心代码被整目录复制进
 *     `lib/ipc-core/`(见该目录 README 的出处与许可);
 *   · 用户拍板 ⑥:先不装插件 ⇒ 一切访问都必须 **fail-soft**:目录缺失 / 文件损坏 /
 *     上游 API 变了,都只降级为"无关系代数",绝不抛错、绝不影响聊天;
 *   · 上游有 178 条关系状态词 + 33 条姿态锚点(拍板 ⑦ 并用),本适配器把两条路都暴露出来。
 *
 * 只读约定:**不改 `lib/ipc-core/` 里的任何文件**;参数归一与降级逻辑全部写在这一层。
 */
import { clampTo } from './emotion-space.js'

/** 默认核心入口(相对本文件解析,打包/移动都不受影响)。 */
const DEFAULT_MODULE_PATH = './ipc-core/index.js'

/** 关系度量的标量键白名单(用于给审计/面板做紧凑摘要;上游若不认,会自动只剩交集)。 */
const SCALAR_KEYS = [
  'reciprocity', 'correspondence', 'complementarity', 'complementarityFloor',
  'similarity', 'opposition', 'agencyCorrespondence', 'communalOpposition',
  'euclideanSimilarity', 'geometricComplementarity'
]

/**
 * 建适配器。
 *
 * @param {object} [opts]
 * @param {string} [opts.modulePath] 核心入口(测试用:指一个不存在的路径即可验证降级)
 * @param {(level:string,msg:string)=>void} [opts.log]
 */
export function createIpcAdapter ({ modulePath = DEFAULT_MODULE_PATH, log } = {}) {
  let core = null
  let loadError = null
  let loading = null
  const stats = {
    available: false, loads: 0, calls: 0, degraded: 0, failures: 0,
    nearestAnchors: 0, relationshipStates: 0, relationship: 0, lastNote: ''
  }
  const note = (msg) => {
    stats.lastNote = String(msg)
    if (typeof log === 'function') { try { log('debug', `[ipc-adapter] ${msg}`) } catch { /* fail-soft */ } }
  }

  /** 加载核心(只加载一次;失败记住原因,不再反复试)。 */
  async function ensure () {
    if (core !== null) return core
    if (loadError !== null) return null
    if (loading !== null) return loading
    loading = (async () => {
      try {
        const mod = await import(modulePath)
        stats.loads += 1
        core = mod
        stats.available = true
        note(`ipc-core 已加载(${Object.keys(mod).length} 个导出)`)
        return mod
      } catch (err) {
        loadError = err && err.message ? err.message : String(err)
        stats.available = false
        stats.failures += 1
        note(`ipc-core 不可用,关系代数降级:${loadError}`)
        return null
      } finally {
        loading = null
      }
    })()
    return loading
  }

  /** 同步可用性(未加载完 ⇒ false;这是给渲染层"现在能不能用"的快问)。 */
  function available () { return core !== null }

  /** 宽容取数:null / 空串 / NaN / 非数 一律回落(不能把 null 当 0)。 */
  function numOr (value, fallback) {
    if (value === null || value === undefined || value === '') return fallback
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }

  /** 把一个坐标归一成上游认识的 `{a, c}`(夹到 [0,1];非数 ⇒ 0.5)。 */
  function normalizePoint (point) {
    const src = point && typeof point === 'object' ? point : {}
    return {
      a: clampTo(numOr(src.a, 0.5), 0, 1),
      c: clampTo(numOr(src.c, 0.5), 0, 1)
    }
  }

  /** 统一调用包装:核心缺失 / 上游抛错 ⇒ 返回 null 并记账,绝不上抛。 */
  async function call (name, fn) {
    stats.calls += 1
    const mod = await ensure()
    if (mod === null) { stats.degraded += 1; return null }
    try {
      return fn(mod)
    } catch (err) {
      stats.failures += 1
      note(`${name} 调用失败,已降级:${err && err.message ? err.message : String(err)}`)
      return null
    }
  }

  /** 关系度量里挑出标量键(给审计/面板用;缺失的键就不出现)。 */
  function pickQuantities (metrics) {
    if (metrics === null || typeof metrics !== 'object') return null
    const out = {}
    for (const key of SCALAR_KEYS) {
      const v = metrics[key]
      if (Number.isFinite(Number(v))) out[key] = Math.round(Number(v) * 1000) / 1000
    }
    return Object.keys(out).length > 0 ? out : null
  }

  return {
    modulePath,
    available,
    ensure,
    normalizePoint,
    pickQuantities,
    stats: () => ({ ...stats, loadError }),

    /**
     * **同步**版最近锚点:只在核心已经加载完之后可用(调用方是渲染/审计这种
     * 同步路径)。没加载完 ⇒ null,绝不 await、绝不抛 —— 同步路径上宁可没有。
     */
    nearestAnchorsSync (point, options = {}) {
      if (core === null) return null
      try {
        const hit = core.nearestAnchors(normalizePoint(point), options)
        if (!Array.isArray(hit)) return null
        return hit.map((h) => {
          const e = h && typeof h.entry === 'object' ? h.entry : {}
          return { id: e.id ?? null, zh: e.zh ?? null, a: numOr(e.a, null), c: numOr(e.c, null), octant: e.octant ?? null, distance: numOr(h && h.distance, null) }
        })
      } catch (err) {
        stats.failures += 1
        note(`nearestAnchorsSync 失败,已降级:${(err && err.message) || err}`)
        return null
      }
    },

    /** 33 条姿态锚点里的最近邻(上游 `match.js:49`)。上游回 `{entry:{…},distance,similarity}` ⇒ 拍平。 */
    async nearestAnchors (point, options = {}) {
      return call('nearestAnchors', (m) => {
        stats.nearestAnchors += 1
        const hit = m.nearestAnchors(normalizePoint(point), options)
        if (!Array.isArray(hit)) return null
        return hit.map((h) => {
          const e = h && typeof h.entry === 'object' ? h.entry : {}
          return {
            id: e.id ?? null,
            zh: e.zh ?? null,
            en: e.en ?? null,
            a: numOr(e.a, null),
            c: numOr(e.c, null),
            octant: e.octant ?? null,
            angle: numOr(e.angle, null),
            provenance: e.provenance ?? null,
            distance: numOr(h && h.distance, null),
            similarity: numOr(h && h.similarity, null)
          }
        })
      })
    },

    /**
     * 178 条关系状态词的选择(上游 `states.js:664`);metrics 来自 `relationship()`。
     * 上游返回的是**对象**(不是数组),这里原样透传(pass-through),不猜形状。
     */
    async relationshipStates (metrics, options = {}) {
      return call('relationshipStates', (m) => {
        stats.relationshipStates += 1
        const hit = m.relationshipStates(metrics, options)
        return hit === null || hit === undefined ? null : hit
      })
    },

    /** 全套关系度量(上游 `circumplex.js:896`)—— 六个量都在这里面。 */
    async relationship (self, other, options = {}) {
      return call('relationship', (m) => {
        stats.relationship += 1
        return m.relationship(normalizePoint(self), normalizePoint(other), options) || null
      })
    },

    /** 互补位 / 错位(上游 `circumplex.js:789/798`)。 */
    async complementOf (point) {
      return call('complementOf', (m) => m.complementOf(normalizePoint(point)) || null)
    },
    async antiComplementOf (point) {
      return call('antiComplementOf', (m) => m.antiComplementOf(normalizePoint(point)) || null)
    },

    /** 区域语言(上游 `match.js:77`)。 */
    async describeRegion (point, options = {}) {
      return call('describeRegion', (m) => m.describeRegion(normalizePoint(point), options) || null)
    },

    /** 两个坐标的关系类型(上游 `match.js:148`)。上游要**区域**(带 `angle`),裸坐标会算出空值 ⇒ 这里补齐。 */
    async octantRelation (self, other) {
      return call('octantRelation', (m) => {
        const region = (p) => {
          const q = normalizePoint(p)
          return { ...q, angle: m.angleDeg(q), octant: m.octantOf(q) }
        }
        const out = m.octantRelation(region(self), region(other))
        if (!out || typeof out !== 'object') return null
        return {
          kind: out.kind ?? null,
          zh: out.zh ?? null,
          gloss: out.gloss ?? null,
          gap: numOr(out.gap, null)
        }
      })
    },

    /**
     * **同步**词表快照:8 个分仪 + 33 条姿态锚点 —— 圆盘要画它们。
     * 核心没加载完 / 表不可用 ⇒ `null`(面板画空盘 + 文案,不抛)。
     * 只读:不动 `lib/ipc-core/` 任何文件,只做形状收拢。
     */
    lexiconSync () {
      if (core === null) return null
      try {
        const octants = Array.isArray(core.OCTANTS)
          ? core.OCTANTS.map((o) => ({
            code: o.code ?? null, id: o.id ?? null, zh: o.zh ?? null, en: o.en ?? null, angle: numOr(o.angle, null)
          }))
          : null
        const anchors = Array.isArray(core.LEXICON)
          ? core.LEXICON.map((e) => ({
            id: e.id ?? null, code: e.code ?? null, zh: e.zh ?? null,
            a: numOr(e.a, null), c: numOr(e.c, null),
            octant: e.octant ?? null, intensity: numOr(e.intensity, null)
          }))
          : null
        if (octants === null && anchors === null) return null
        return { octants, anchors }
      } catch (err) {
        stats.failures += 1
        note(`lexiconSync 失败,已降级:${(err && err.message) || err}`)
        return null
      }
    },

    /** **同步**互补位 / 对立位(圆盘的两个空心圈);核心缺失 ⇒ `null`。 */
    complementOfSync (point) {
      if (core === null) return null
      try { return core.complementOf(normalizePoint(point)) || null } catch (err) {
        stats.failures += 1
        note(`complementOfSync 失败,已降级:${(err && err.message) || err}`)
        return null
      }
    },
    antiComplementOfSync (point) {
      if (core === null) return null
      try { return core.antiComplementOf(normalizePoint(point)) || null } catch (err) {
        stats.failures += 1
        note(`antiComplementOfSync 失败,已降级:${(err && err.message) || err}`)
        return null
      }
    },

    /** **同步**区域语言(单个坐标就能算,不需要第二个点);核心缺失 ⇒ `null`。
     *  形状对齐上游 `core/match.js:93-108`(octant 是**对象**,这里摊成代号 + 中文/释义)。 */
    describeRegionSync (point) {
      if (core === null) return null
      try {
        const q = normalizePoint(point)
        const out = core.describeRegion({ ...q, angle: core.angleDeg(q), octant: core.octantOf(q) })
        if (!out || typeof out !== 'object') return null
        const oct = out.octant && typeof out.octant === 'object' ? out.octant : {}
        const band = out.band && typeof out.band === 'object' ? out.band : {}
        const word = out.word && typeof out.word === 'object' ? out.word : {}
        return {
          octant: oct.code ?? oct.id ?? null,
          zh: oct.zh ?? null,
          gloss: oct.gloss ?? null,
          angle: numOr(out.angle, null),
          radius: numOr(out.radius, null),
          intensity: numOr(out.intensity, null),
          band: band.zh ?? null,
          neutral: out.neutral === true,
          label: out.label ?? null,
          word: word.zh ?? null,
          wordId: word.id ?? null,
          axisWords: (out.axisWords && typeof out.axisWords === 'object') ? { a: out.axisWords.a ?? null, c: out.axisWords.c ?? null } : null
        }
      } catch (err) {
        stats.failures += 1
        note(`describeRegionSync 失败,已降级:${(err && err.message) || err}`)
        return null
      }
    },

    /**
     * **同步**关系度量(2026-10-06 用户侧坐标,拍板 ①「双轨 + 对账」):
     * 上游 `circumplex.js` 的 `relationship(self, other)` —— **六种关系量 + 理想位 + 原型**
     * 全在这里,只有拿到**两个**坐标才成立(单方坐标算不了)。
     *
     * 与异步版 `relationship()`(:180)的分工:那个走 `await ensure()`(首次调用要加载
     * 核心),这个只给**已经加载完**的同步路径用(API/审计/面板在同步构建响应)。
     * 核心没加载完 ⇒ `null`(面板继续画灰环占位),绝不 await、绝不抛。
     *
     * 形状:`self`/`other` 两个点 + `quantities`(白名单标量,`pickQuantities` 同一份)
     * + `pattern`/`prototypes`/理想位**原样透传**(不猜上游形状,与 `relationshipStates` 同口径)。
     */
    relationshipSync (self, other, options = {}) {
      if (core === null) return null
      try {
        stats.relationship += 1
        const out = core.relationship(normalizePoint(self), normalizePoint(other), options)
        if (!out || typeof out !== 'object') return null
        const pt = (p) => (p && typeof p === 'object'
          ? { a: numOr(p.a, null), c: numOr(p.c, null) }
          : null)
        const oc = (o) => (o && typeof o === 'object' ? (o.code ?? o.id ?? null) : (o ?? null))
        return {
          self: pt(out.self),
          other: pt(out.other),
          delta: (out.delta && typeof out.delta === 'object')
            ? { a: numOr(out.delta.a, null), c: numOr(out.delta.c, null) }
            : null,
          quantities: pickQuantities(out),
          separationDegrees: numOr(out.separationDegrees, null),
          separationRatio: numOr(out.separationRatio, null),
          distance: numOr(out.distance, null),
          distanceRatio: numOr(out.distanceRatio, null),
          selfOctant: oc(out.selfOctant),
          otherOctant: oc(out.otherOctant),
          selfAngle: numOr(out.selfAngle, null),
          otherAngle: numOr(out.otherAngle, null),
          selfIntensity: numOr(out.selfIntensity, null),
          otherIntensity: numOr(out.otherIntensity, null),
          selfNeutral: out.selfNeutral === true,
          otherNeutral: out.otherNeutral === true,
          complementPoint: pt(out.complementPoint),
          contrastPoint: pt(out.contrastPoint),
          pattern: (out.pattern && typeof out.pattern === 'object') ? out.pattern : null,
          prototypes: Array.isArray(out.prototypes) ? out.prototypes : null
        }
      } catch (err) {
        stats.failures += 1
        note(`relationshipSync 失败,已降级:${(err && err.message) || err}`)
        return null
      }
    },

    /**
     * **同步**打分提示词(拍板 ④:不新写提示词,直接用上游 `appraise.js`)。
     * `messages` 是 `{role:'user'|'assistant', text}` 的**时间升序**数组;
     * 先 `renderTranscript` 裁成紧凑文本,再拼 system + user。
     * 核心缺失 ⇒ `null`(调用方按"这轮不判定"处理)。
     */
    appraisalPromptSync (messages, params = {}) {
      if (core === null) return null
      try {
        const transcript = core.renderTranscript(Array.isArray(messages) ? messages : [], {
          maxChars: numOr(params.maxChars, 1000),
          perMessageChars: numOr(params.perMessageChars, 200),
          roleName: params.roleName,
          userName: params.userName
        })
        return {
          system: core.buildAppraisalSystemPrompt({ opening: params.opening === true }),
          user: core.buildAppraisalUserContent({
            transcript,
            current: params.current,
            previousLabels: params.previousLabels,
            roleName: params.roleName,
            userName: params.userName,
            persona: params.persona
          }),
          transcript
        }
      } catch (err) {
        stats.failures += 1
        note(`appraisalPromptSync 失败,已降级:${(err && err.message) || err}`)
        return null
      }
    },

    /** **同步**解析打分输出(`appraise.js:476`)⇒ 只留我们要的键;解析不了 ⇒ `null`。 */
    parseAppraisalSync (raw) {
      if (core === null) return null
      try {
        const out = core.parseAppraisal(raw)
        if (!out || typeof out !== 'object') return null
        return {
          self: { a: numOr(out.self && out.self.a, null), c: numOr(out.self && out.self.c, null) },
          other: { a: numOr(out.other && out.other.a, null), c: numOr(out.other && out.other.c, null) },
          labels: {
            self: (out.labels && out.labels.self) ?? null,
            other: (out.labels && out.labels.other) ?? null
          },
          confidence: numOr(out.confidence, null),
          reason: out.reason === undefined ? null : String(out.reason),
          scale: out.scale ?? null,
          complete: out.complete === true
        }
      } catch (err) {
        stats.failures += 1
        note(`parseAppraisalSync 失败,已降级:${(err && err.message) || err}`)
        return null
      }
    },

    /** **同步**动力学默认值(惯性/升级;`dynamics.js:64`)—— 面板/模块只读它,不当配置入口。 */
    defaultDynamicsSync () {
      if (core === null) return null
      try {
        return core.DEFAULT_DYNAMICS && typeof core.DEFAULT_DYNAMICS === 'object'
          ? { ...core.DEFAULT_DYNAMICS }
          : null
      } catch (err) {
        stats.failures += 1
        note(`defaultDynamicsSync 失败,已降级:${(err && err.message) || err}`)
        return null
      }
    },

    /** **同步**惯性结算(`dynamics.js:199` `integrateDyad`):当前双方 → 打分输入 ⇒ 新双方。 */
    integrateDyadSync (current, appraisal, dynamics, gain = 1) {
      if (core === null) return null
      try {
        const pt = (p) => (p && typeof p === 'object' ? normalizePoint(p) : null)
        const out = core.integrateDyad({
          current: {
            self: pt(current && current.self) ?? normalizePoint(null),
            other: pt(current && current.other) ?? normalizePoint(null)
          },
          appraisal: appraisal === null || appraisal === undefined
            ? null
            : { self: pt(appraisal.self) ?? normalizePoint(null), other: pt(appraisal.other) ?? normalizePoint(null) },
          dynamics,
          gain
        })
        if (!out || typeof out !== 'object') return null
        return out
      } catch (err) {
        stats.failures += 1
        note(`integrateDyadSync 失败,已降级:${(err && err.message) || err}`)
        return null
      }
    },

    /** 词表规模自查(178 / 33 / 8 / 81)—— 审计里能直接看见"借来的到底是什么"。 */
    async inventory () {
      return call('inventory', (m) => {
        const out = { axes: Array.isArray(m.AXES) ? [...m.AXES] : null }
        try { out.octants = Array.isArray(m.OCTANTS) ? m.OCTANTS.length : null } catch { out.octants = null }
        try { out.states = typeof m.stateStats === 'function' ? m.stateStats() : null } catch { out.states = null }
        try {
          out.anchors = typeof m.lexiconStats === 'function' ? m.lexiconStats() : null
        } catch { out.anchors = null }
        try { out.cells = typeof m.allCells === 'function' ? m.allCells().length : null } catch { out.cells = null }
        return out
      })
    }
  }
}
