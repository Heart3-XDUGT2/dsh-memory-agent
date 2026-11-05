/**
 * 桥接层:Echo 联合情绪空间 `{s, a, d}` ↔ PAD 子空间 / IPC 子空间。
 *
 * 这份代码**不声称**两个子空间等价。文献只支持"共享一条斜轴":
 *   · Yik & Russell (2004, MBR 39(2):203–230):两环只重叠 **一条轴**,情感侧 35°、
 *     IPC 侧 71°(Yik 2010 复现为 37°/76° ⇒ 角度不精确稳定);
 *   · Mehrabian (1995):公共因子有三个(pleasantness/dominance/arousability),
 *     IPC 只有两轴 ⇒ 3 维 vs 2 维,**双向双射不可能**。
 * 因此这里实现的是用户拍板 ④ 的「**工程可逆**」:
 *   · **共享轴**用文献角度([literature]:θ_s(情感侧)=35°、θ_s_ipc=71°);
 *   · **垂直轴 / 支配轴**用工程假设([工程假设]:θ_d 默认 0,λ 待标定);
 *   · 往返靠**缓存**(拍板 ⑨):IPC 侧少一维,取回时必须从缓存补 `agency` / `a_P`。
 *
 * 三条硬规矩(测试钉住):
 *   1. **往返无损**:同空间出发 → 联合 → 回本空间,在缓存齐备时逐位复原(浮点 1e-9)。
 *   2. **缓存缺失降级**:不抛错,返回 `degraded: true` + `degradeReason`,数值取"投影"近似。
 *   3. **误差只记录、不回写**:`bridge_err` 进统计(`snapshot()`),绝不修改调用方对象。
 *
 * 参数(全部可调,见面板键 `bridge*`):
 *   thetaS(35) / thetaSipc(71) / thetaD(0) / lambdaS(1) / lambdaD(1) / biasS(0)
 */
import {
  BASIS, emptyUnion, clampAxis, clampTo, nativeToAxis, axisToNative,
  NATIVE_RANGES, bipolarToUnit
} from './emotion-space.js'

/** 角度制 → 弧度。 */
const rad = (deg) => (Number(deg) || 0) * Math.PI / 180

/** 参数默认值:括号里是来源(文献角度 / 工程假设)。 */
export const DEFAULT_BRIDGE_PARAMS = Object.freeze({
  enabled: true,
  shadowMode: true,
  thetaS: 35, // [literature] Yik & Russell 2004:情感环侧 35°
  thetaSipc: 71, // [literature] 同一研究:IPC 侧 71°
  thetaD: 0, // [工程假设] 0 ⇒ d := D / DOM(不做旋转)
  lambdaS: 1, // [工程假设] 共享轴尺度;待标定
  lambdaD: 1, // [工程假设] 支配轴尺度;待标定
  biasS: 0, // [工程假设] 共享轴偏置;待标定
  exposeErr: true
})

/** 参数夹取(面板乱填也不能让桥接炸)。 */
/**
 * 门禁分带(B5,2026-10-05):用**当前参数下的残差**决定联合空间块能不能进 prompt。
 *
 * 为什么挂在"残差"而不是"原始差":一改 `biasS` 阈值就失效 —— 同一批真实数据在
 * `biasS=0` 时 7 轮全红、在 `biasS=0.30` 时 7 轮全绿。挂在残差上,阈值才稳。
 *
 * 分带依据(7 轮真实数据,详见 `docs/EMOTION_SPACE.md` 的标定记录):
 *   · 绿 < 0.15 —— 标定后残差标准差只有 0.026,对齐后本该很稳,所以绿线收得比"0.2"紧;
 *   · 黄 0.15–0.30 —— 有分歧,只给方向不给数值;
 *   · 红 > 0.30 —— 系统性分歧,块不进 prompt,只写审计。
 */
export const GATE_BANDS = Object.freeze({ green: 0.15, yellow: 0.3 })

/** 残差绝对值 → 分带。非数 / 缺失 / null 一律 'unknown'(调用方按"不给块"处理)。 */
export function gateOf (resid) {
  // 注意 `Number(null) === 0`:`null` 是"没有读数",不是"残差为 0"(0 是绿)。这一步必须严格。
  if (resid === null || resid === undefined || resid === '') return 'unknown'
  const n = Number(resid)
  if (!Number.isFinite(n)) return 'unknown'
  const a = Math.abs(n)
  if (a < GATE_BANDS.green) return 'green'
  if (a <= GATE_BANDS.yellow) return 'yellow'
  return 'red'
}

/** 方向(黄带只用方向、不给数值):与上一轮比偏正 / 偏负 / 持平。 */
export function directionOf (now, prev) {
  const strict = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
  const a = strict(now)
  const b = strict(prev)
  if (a === null || b === null) return null
  const d = a - b
  if (Math.abs(d) < 0.02) return 'flat'
  return d > 0 ? 'positive' : 'negative'
}

export function normalizeParams (raw = {}) {
  const base = { ...DEFAULT_BRIDGE_PARAMS, ...(raw && typeof raw === 'object' ? raw : {}) }
  const angle = (v, dv) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return dv
    const wrapped = ((n + 180) % 360 + 360) % 360 - 180
    return Math.round(wrapped * 1000) / 1000
  }
  const scale = (v, dv) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return dv
    return clampTo(n, 0.05, 20)
  }
  return {
    enabled: base.enabled !== false,
    shadowMode: base.shadowMode !== false,
    thetaS: angle(base.thetaS, 35),
    thetaSipc: angle(base.thetaSipc, 71),
    thetaD: angle(base.thetaD, 0),
    lambdaS: scale(base.lambdaS, 1),
    lambdaD: scale(base.lambdaD, 1),
    biasS: clampAxis(Number.isFinite(Number(base.biasS)) ? Number(base.biasS) : 0),
    exposeErr: base.exposeErr !== false
  }
}

/**
 * 会话级缓存(拍板 ⑨"缓存往返"):存各子空间**在投影中会丢**的分量。
 *   · `aPad` —— PAD 的激活轴读数(IPC 侧没有,回读 PAD 时必须补);
 *   · `agency` —— IPC 的主导性读数(联合空间的 s 里含 sin·agency,需补);
 *   · `playfulness` / `sadness` —— IPC 的两条扩展维(拍板 ②)。
 * LRU + 硬上限:桥接是热路径,内存不许无限长。
 */
export function createBridgeCache ({ max = 256 } = {}) {
  const map = new Map()
  let puts = 0
  let hits = 0
  let misses = 0
  return {
    put (sessionId, patch) {
      const key = String(sessionId || '-')
      const prev = map.get(key) || {}
      map.set(key, { ...prev, ...(patch && typeof patch === 'object' ? patch : {}) })
      puts += 1
      if (map.size > max) {
        const oldest = map.keys().next().value
        map.delete(oldest)
      }
      return map.get(key)
    },
    get (sessionId) {
      const key = String(sessionId || '-')
      const hit = map.get(key)
      if (hit === undefined) misses += 1
      else {
        hits += 1
        map.delete(key); map.set(key, hit) // LRU 抬升
      }
      return hit === undefined ? null : { ...hit }
    },
    size () { return map.size },
    stats () { return { size: map.size, max, puts, hits, misses } },
    clear () { map.clear() }
  }
}

/** 二维旋转(正交 ⇒ 天然可逆):返回 [共享轴, 正交轴]。 */
function rotate2 (x, y, deg) {
  const t = rad(deg)
  return [Math.cos(t) * x + Math.sin(t) * y, -Math.sin(t) * x + Math.cos(t) * y]
}

/** 逆旋转(转置矩阵,精确互逆)。 */
function rotate2Inv (s, orth, deg) {
  const t = rad(deg)
  return [Math.cos(t) * s - Math.sin(t) * orth, Math.sin(t) * s + Math.cos(t) * orth]
}

const round6 = (x) => Math.round(x * 1e6) / 1e6

/**
 * 建桥接器。
 *
 * @param {object} opts
 * @param {object} [opts.params] 参数(默认 `DEFAULT_BRIDGE_PARAMS`)
 * @param {boolean} [opts.ipcAvailable] IPC 源码副本是否可用(fail-soft 用)
 * @param {object} [opts.cache] 会话缓存(默认自建)
 * @param {(level:string,msg:string)=>void} [opts.log]
 */
export function createSpaceBridge ({ params, ipcAvailable = true, cache, log } = {}) {
  let cfg = normalizeParams(params)
  const store = cache || createBridgeCache()
  const stats = {
    padToUnion: 0, ipcToUnion: 0, unionToPad: 0, unionToIpc: 0,
    compares: 0, degraded: 0, ipcUnavailable: 0, disabled: 0,
    rtPad: 0, rtIpc: 0, rtPadMaxErr: 0, rtIpcMaxErr: 0, rtLastErr: 0,
    sharedErrN: 0, sharedErrMeanAbs: 0, sharedErrMaxAbs: 0, sharedErrLast: 0,
    lastNote: ''
  }
  const note = (msg) => {
    stats.lastNote = String(msg)
    if (typeof log === 'function') { try { log('debug', `[space-bridge] ${msg}`) } catch { /* fail-soft */ } }
  }
  const recordSharedErr = (err) => {
    const e = Math.abs(Number(err) || 0)
    stats.sharedErrLast = round6(e)
    stats.sharedErrN += 1
    stats.sharedErrMeanAbs = round6((stats.sharedErrMeanAbs * (stats.sharedErrN - 1) + e) / stats.sharedErrN)
    stats.sharedErrMaxAbs = round6(Math.max(stats.sharedErrMaxAbs, e))
  }

  /**
   * PAD 子空间 → 联合空间。
   * 入参是 **Echo 原生值**(`valence` / `arousal` / `dominance`),
   * 除非显式给 `native: false`(那时三个数当已折好的双极坐标用)。
   */
  function padToUnion ({ p, a, d } = {}, { native = true } = {}) {
    if (!cfg.enabled) { stats.disabled += 1; return { ok: false, union: emptyUnion(), reason: 'bridge-disabled' } }
    const P = native ? nativeToAxis(p, NATIVE_RANGES['global.valence']) : clampAxis(p)
    const A = native ? nativeToAxis(a, NATIVE_RANGES['global.arousal']) : clampAxis(a)
    const D = native ? nativeToAxis(d, NATIVE_RANGES['global.dominance']) : clampAxis(d)
    const [s, orth] = rotate2(P, A, cfg.thetaS)
    // [工程假设] θ_d:把支配轴与共享轴做一个小角度耦合(默认 0 ⇒ 恒等)。
    const dd = clampAxis(Math.cos(rad(cfg.thetaD)) * D + Math.sin(rad(cfg.thetaD)) * s) * cfg.lambdaD
    stats.padToUnion += 1
    return {
      ok: true,
      union: { s: round6(clampAxis(s)), a: round6(clampAxis(orth)), d: round6(clampAxis(dd)) },
      axes: { P, A, D },
      native
    }
  }

  /**
   * IPC 子空间 → 联合空间。
   * 入参 `{ lov, dom }`(或别名 `{ c, agency }`),单极 [0,1]。
   * 输出 `{ s, a: 0, d }` —— **a 恒为 0**:IPC 没有激活轴(拍板 ⑨ 的已知损失,
   * 由缓存补,不由公式编)。
   */
  function ipcToUnion ({ lov, dom, c, agency } = {}, { sessionId } = {}) {
    if (!cfg.enabled) { stats.disabled += 1; return { ok: false, union: emptyUnion(), reason: 'bridge-disabled' } }
    if (ipcAvailable === false) {
      stats.ipcUnavailable += 1
      note('ipc-unavailable: 关系代数降级,IPC 侧读数缺失')
      return { ok: false, union: emptyUnion(), reason: 'ipc-unavailable' }
    }
    // [工程假设] 两侧统一在**双极**坐标里旋转:IPC 的 [0,1]² 内切圆盘在双极坐标下
    // 就是以原点为心的单位圆盘(中心 (0.5,0.5) → (0,0),半径 0.5 → 1)。
    // 设计文档里的单极式 `s = cos71°·c + sin71°·a` 与这里相差一个常数偏移
    // (0.5·(cosθ+sinθ)),该偏移由 `biasS` 吸收。
    const LUnit = unitOf(lov !== undefined ? lov : c)
    const GUnit = unitOf(dom !== undefined ? dom : agency)
    const L = clampAxis(LUnit * 2 - 1)
    const G = clampAxis(GUnit * 2 - 1)
    // 关键:往返必须存**旋转后的第二分量**(orth),不是输入坐标 G —— 逆旋转
    // 拿的是正交分量;只存 G 的话 IPC→联合→IPC 会失真(试过,错)。
    const [s, orth] = rotate2(L, G, cfg.thetaSipc)
    const dd = clampAxis(G) * cfg.lambdaD
    if (sessionId !== undefined) {
      store.put(sessionId, { agency: round6(G), ipcOrth: round6(orth), lov: round6(LUnit) })
    }
    stats.ipcToUnion += 1
    return {
      ok: true,
      union: { s: round6(clampAxis(s)), a: 0, d: round6(clampAxis(dd)) },
      axes: { lov: LUnit, agency: GUnit },
      clamped: Math.abs(s) > 1
    }
  }

  /**
   * 联合空间 → PAD 子空间。
   * `u.a`(激活轴)若被 IPC 路径写成 0 ⇒ 从缓存回读 `aPad`;缓存也没有 ⇒ 降级。
   */
  function unionToPad (u, { sessionId, native = true } = {}) {
    const v = { ...emptyUnion(), ...(u && typeof u === 'object' ? u : {}) }
    let orth = clampAxis(v.a)
    let degraded = false
    let reason = ''
    const needCache = Math.abs(orth) < 1e-12
    if (needCache) {
      const hit = store.get(sessionId)
      if (hit && Number.isFinite(Number(hit.aPad))) {
        orth = clampAxis(hit.aPad)
      } else {
        degraded = true
        reason = 'missing-aPad-cache'
        stats.degraded += 1
        note(`unionToPad 降级:${reason}(session=${sessionId ?? '-'}):激活轴按 0 处理`)
      }
    }
    const s = clampAxis(v.s)
    const [P, A] = rotate2Inv(s, orth, cfg.thetaS)
    const D = clampAxis((clampAxis(v.d) / cfg.lambdaD - Math.sin(rad(cfg.thetaD)) * s) / Math.cos(rad(cfg.thetaD)))
    stats.unionToPad += 1
    return {
      ok: true, degraded, degradeReason: reason, axes: { P, A, D },
      p: native ? axisToNative(P, NATIVE_RANGES['global.valence']) : round6(P),
      a: native ? axisToNative(A, NATIVE_RANGES['global.arousal']) : round6(A),
      d: native ? axisToNative(D, NATIVE_RANGES['global.dominance']) : round6(D)
    }
  }

  /**
   * 联合空间 → IPC 子空间(投影,`a` 丢弃)。
   * IPC 的 `agency` 优先取缓存;拿不到就用 s 的余弦投影近似并标降级。
   */
  function unionToIpc (u, { sessionId } = {}) {
    if (ipcAvailable === false) {
      stats.ipcUnavailable += 1
      return { ok: false, degraded: true, degradeReason: 'ipc-unavailable', lov: null, agency: null }
    }
    const v = { ...emptyUnion(), ...(u && typeof u === 'object' ? u : {}) }
    const s = clampAxis(v.s)
    const hit = store.get(sessionId)
    const orth = hit && Number.isFinite(Number(hit.ipcOrth)) ? Number(hit.ipcOrth) : null
    const agency = hit && Number.isFinite(Number(hit.agency)) ? clampAxis(hit.agency) : 0
    let degraded = false
    let reason = ''
    let L
    if (orth !== null) {
      ;[L] = rotate2Inv(s, orth, cfg.thetaSipc) // 精确回程(缓存齐备)
    } else {
      degraded = true
      reason = 'missing-ipc-orth-cache'
      const c = Math.cos(rad(cfg.thetaSipc))
      L = Math.abs(c) > 1e-6 ? clampAxis(s / c) : s // [工程假设] 投影:假定主导性中性
      stats.degraded += 1
      note(`unionToIpc 降级:${reason}(session=${sessionId ?? '-'}):主导性按中性投影,精度下降`)
    }
    const G = clampAxis(v.d / cfg.lambdaD)
    stats.unionToIpc += 1
    return {
      ok: true, degraded, degradeReason: reason,
      lov: round6(bipolarToUnit(L)), agency: round6(bipolarToUnit(G))
    }
  }

  /** 两个子空间在共享轴上的读数比对:预测 `λ·s_PAD + b`,误差 `|s_IPC − 预测|`。 */
  function compareShared (padUnion, ipcUnion) {
    // 读数是"读数",不是坐标:这里只做有限性兜底,**不夹取**(夹取会把
    // 超出 [-1,1] 的真实读数抹平,误差反而看不出来)。
    const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0)
    const sPad = num(padUnion && padUnion.s)
    const sIpc = num(ipcUnion && ipcUnion.s)
    const predicted = cfg.lambdaS * sPad + cfg.biasS
    const err = Math.abs(sIpc - predicted)
    stats.compares += 1
    recordSharedErr(err)
    return { ok: true, sPad, sIpc, predicted: round6(predicted), err: round6(err), lambdaS: cfg.lambdaS, biasS: cfg.biasS }
  }

  /** PAD 往返:`(p,a,d)` → 联合 → 回 PAD。缓存齐备时应无损。 */
  function roundTripPad (input, opts = {}) {
    const fwd = padToUnion(input, { native: false })
    if (!fwd.ok) return { ok: false, err: null, reason: fwd.reason }
    // 回程前把激活轴写进缓存(等价于"我们自己产生的往返",不需要外部缓存)
    const to = { ...fwd.union }
    const back = unionToPad({ s: to.s, a: to.a, d: to.d }, { native: false })
    const err = Math.max(
      Math.abs(back.axes.P - fwd.axes.P),
      Math.abs(back.axes.A - fwd.axes.A),
      Math.abs(back.axes.D - fwd.axes.D)
    )
    stats.rtPad += 1
    stats.rtLastErr = round6(err)
    stats.rtPadMaxErr = round6(Math.max(stats.rtPadMaxErr, err))
    return { ok: true, degraded: back.degraded, degradeReason: back.degradeReason, back: back.axes, err: round6(err) }
  }

  /** IPC 往返:`(lov,dom)` → 联合 → 回 IPC。必须带 sessionId 才有缓存补维。 */
  function roundTripIpc (input, { sessionId = 'rt' } = {}) {
    const fwd = ipcToUnion(input, { sessionId })
    if (!fwd.ok) return { ok: false, err: null, reason: fwd.reason }
    const back = unionToIpc(fwd.union, { sessionId })
    const err = back.lov === null ? null : Math.max(
      Math.abs(back.lov - fwd.axes.lov), Math.abs(back.agency - fwd.axes.agency)
    )
    stats.rtIpc += 1
    if (err !== null) {
      stats.rtLastErr = round6(err)
      stats.rtIpcMaxErr = round6(Math.max(stats.rtIpcMaxErr, err))
    }
    return { ok: true, degraded: back.degraded, degradeReason: back.degradeReason, back, err: err === null ? null : round6(err) }
  }

  /** 供审计/面板用的一行读数(拍板 ⑤:影子模式先只算 + 写审计)。 */
  function describe (u, extra = {}) {
    const v = { ...emptyUnion(), ...(u && typeof u === 'object' ? u : {}) }
    const errPart = cfg.exposeErr
      ? ` err=${stats.sharedErrLast}±[工程假设]`
      : ''
    return `联合空间 {s=${round6(v.s)}, a=${round6(v.a)}, d=${round6(v.d)}}${errPart}` +
      ` θs=${cfg.thetaS}°/θs_ipc=${cfg.thetaSipc}°/θd=${cfg.thetaD}° λs=${cfg.lambdaS}/λd=${cfg.lambdaD}` +
      (extra.note ? ` ${extra.note}` : '')
  }

  return {
    params: () => ({ ...cfg }),
    configure (patch) { cfg = normalizeParams({ ...cfg, ...(patch || {}) }); return { ...cfg } },
    basisKeys: () => Object.keys(BASIS),
    cache: store,
    padToUnion,
    ipcToUnion,
    unionToPad,
    unionToIpc,
    compareShared,
    roundTripPad,
    roundTripIpc,
    describe,
    snapshot: () => ({
      ...stats,
      mode: cfg.enabled ? (cfg.shadowMode ? 'shadow' : 'live') : 'off',
      params: { ...cfg },
      cache: store.stats()
    }),
    reset () { for (const k of Object.keys(stats)) { if (typeof stats[k] === 'number') stats[k] = 0 } stats.lastNote = ''; store.clear() }
  }
}

/** IPC 单极值的宽容归一:非数 ⇒ 0.5(中性),越界夹取。 */
function unitOf (x) {
  const n = Number(x)
  if (!Number.isFinite(n)) return 0.5
  return clampTo(n, 0, 1)
}
