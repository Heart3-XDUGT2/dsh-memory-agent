/**
 * 🧭 情绪空间页(2026-10-05 · G5/G6)
 *
 * 交付节奏(每一步都能单独验收):
 *   ② **数据通** —— 拉 `/api/echo/emotion-space`,摊成「人话摘要 + 逐轮表 + 原始 JSON」;
 *   ③ **IPC 圆盘**(本步)—— 绘制与交互**逐字搬** `dsh-interpersonal-circumplex/client.js`:
 *      几何 `226-268`(toScreen / polarToScreen / sectorPath)、绘制 `284-539`、
 *      DPR + resize + 「只在有变化时重画」`653-692`、chips `802-805`、Help 气泡 `178-203`;
 *   ④ **PAD 立方体**(本步)—— 3D 数学与绘制**逐字搬** `dsh-pad-emotion/client.js`:
 *      数学 `119-157`(rotate / project / world)、绘制 `184-403`(六面深度排序、
 *      网格墙、12 棱、三轴、中性点、当前点、轨迹、投影虚线)、DPR/自转/拖拽/双击 `506-620`;
 *   ⑤ 离线断言补全 + 文档。
 *
 * 搬运纪律(用户拍板):
 *   · **数学一行不改**:坐标映射、扇区路径、环、轴、轨迹的透明度/线宽公式、光晕梯度、
 *     箭头几何 —— 全部保持上游原式(角度约定也是上游的:从 +联结 起算、逆时针为正)。
 *   · **React → 原生**:`useRef` / `useState` / `useEffect` 换成模块级状态 + 事件监听;
 *     `h(...)`(createElement)换成 `document.createElement`;React 的「依赖数组重渲染」
 *     换成**数据签名变化才重画**(上游注释原话:圆盘是静态的,不需要 rAF 常驻)。
 *   · **宿主 CSS 变量 → Echo 变量**:`--dsw-alias-*` 一律换成 Echo 页面的 `--line/--ink/…`
 *     或内联色;类名前缀 `ipc-` → `es-`。
 *   · **砍掉写状态通路(拍板 D9)**:上游的「设定角色 / 设定用户」两个按钮、圆盘点击换算回
 *     IPC 坐标、`POST /api/…/state` —— **整条通路不搬**。本页只显示。
 *   · **不做惯性(拍板 D10)**:上游的惯性/升级在宿主侧,本页不实现、也不假装有。
 *
 * 数据源:`GET /api/echo/emotion-space`(② 已通)。缺口按"不存在"处理,不凭空造:
 *   · 2026-10-07 MVP-3:主人一侧坐标(P5)与人格基线都已接入 ⇒ 有 `metrics` 就画青点 +
 *     关系向量 + 关系类型/分离角 + 六个量;**灰环占位只在 `other === null` 时出现**
 *     (没判定 / 红档 / 不可信);立方体画灰十字基线点 + 到当前点的偏差虚线(ΔP/ΔA);
 *   · 关系度量(互补/相似/对立 + 六个量)需要**两个**坐标 ⇒ `metrics` 为 `null` 时
 *     那几段**不画、写"缺席"**,而不是填 0;
 *   · 轨迹只有**角色**一条(用户那条没有数据源)。
 *
 * 契约(`docs/CONFIG_CENTER_CONTRACT.md` §3):`globalThis.EchoViews['<id>']` + `draw(el, api)`;
 * view 里不许出现 `fetch`(走 `api.get`)。走 `globalThis.EchoViews[...]` 而非裸名:单测在
 * `new Function('globalThis', src)` 沙箱里跑,那里没有真实全局作用域。
 */
globalThis.EchoViews = globalThis.EchoViews || {}

globalThis.EchoViews['emotion-space'] = (function () {
  'use strict'

  /** 本页只认这一条路径(与宿主 `echo.api.emotionSpace()` 对着)。 */
  const PATH = '/api/echo/emotion-space'
  /** 圆盘半径(数据坐标)= 0.5,与上游 `DISK_RADIUS` / 宿主 `MAX_RADIUS` 一致。 */
  const DISK_RADIUS = 0.5

  /** 门禁配色(语义同 `lib/space-bridge.js` 的 GATE_BANDS:绿给块 / 黄只给方向 / 红不给块)。 */
  const GATE_COLOR = { green: '#2a7', yellow: '#f59e0b', red: '#ef4444', unknown: '#8b93a7' }
  const GATE_ZH = { green: '绿 · 进 prompt', yellow: '黄 · 只给方向', red: '红 · 不进 prompt', unknown: '未知' }
  /** 支配维来源(拍板 D2:来源必须跟着读数走)。 */
  const SOURCE_ZH = { derived: '推导 [工程假设]', measured: '实测', '': '缺' }
  /** 轨迹色(上游 `draw` 里 `['self','255,214,120']` 那一项,原样)。 */
  const TRAIL_SELF = '255,214,120'

  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null
  const f1 = (v) => { const n = num(v); return n === null ? '—' : (Math.round(n * 10) / 10).toFixed(1) }
  const f2 = (v) => { const n = num(v); return n === null ? '—' : (Math.round(n * 100) / 100).toFixed(2) }
  const when = (ms) => { const n = num(ms); return (n === null || n <= 0) ? '—' : new Date(n).toLocaleString() }
  const dirZh = (d) => d === 'positive' ? '偏正向' : d === 'negative' ? '偏负向' : d === 'flat' ? '基本持平' : '—'

  /**
   * 「语气候选」卡的若干行(纯函数;端点没给这一段也不抛)。
   *
   * 数据来自端点 `styleHint`(按**最近一轮**读数的现算结果,`source='recomputed'`)——
   * 不是当时注入的原文,所以卡里要写明来源,免得把它当"历史事实"。
   * 看不到这一行就等于调不动它:`她为什么用 <emo type="2">` 该在这里查得到。
   *
   * @param {unknown} raw 端点 `styleHint` 段
   * @returns {string[]}
   */
  function styleLinesOf (raw) {
    const sh = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null
    if (sh === null) return ['端点没给「语气候选」段(宿主版本旧?)']
    if (sh.enabled === false) return ['开关 styleHint 关着 —— 这一轮 prompt 里没有这一行(回滚态)']
    const DELTA_ZH = { pos: '偏正向', neg: '偏负向', zero: '强度没变', unknown: '读不出变化' }
    const line = typeof sh.line === 'string' ? sh.line.trim() : ''
    if (line === '') {
      const why = sh.delta === 'zero' ? '强度没变(delta=0)'
        : sh.delta === 'unknown' ? '读不出变化(缺这一轮或上一轮的读数)'
          : (Array.isArray(sh.candidates) && sh.candidates.length === 0 ? '候选被掏空(平静 / 自身读数缺)' : '没有可用的推断')
      return ['这一轮不出行 —— ' + why]
    }
    const marks = (xs) => (Array.isArray(xs) && xs.length > 0 ? xs.map((n) => '<emo type="' + n + '">').join(' ') : '—')
    return [
      line,
      '候选 ' + marks(sh.candidates) + ' · 不优先 ' + marks(sh.avoid)
        + ' · 触发 ' + (DELTA_ZH[String(sh.delta ?? '')] || '—')
        + ' · 唤醒 ' + (sh.arousalBand || '—') + ' · 心情 ' + (sh.valenceSign || '—'),
      '门禁 ' + (GATE_ZH[String(sh.gate ?? '')] || GATE_ZH.unknown)
        + (sh.sTrusted === true ? '(允许引用共享轴)' : '(不引用共享轴)')
        + ' · 来源:按最近一轮读数现算' + (sh.at ? ' · ' + when(sh.at) : '')
    ]
  }

  /**
   * 端点返回值 → 人话摘要。**纯函数**(单测直接喂假数据),坏数据不抛。
   * @returns {{state:string,pad:string[],union:string[],ipc:string[],style:string[],warn:string[]}}
   */
  /**
   * 端点的 `ipc.metrics`(P5 的两点关系度量)—— 不是对象就当中性 `null`。
   * 形状:`{self, other, pattern{zh,fit}, separationDegrees, quantities{六个数}, selfNeutral, otherNeutral, …}`。
   */
  function metricsOf (ipc) {
    return (ipc && typeof ipc.metrics === 'object' && ipc.metrics !== null) ? ipc.metrics : null
  }

  /** 六个关系量 + 关系类型/分离角(2026-10-07 MVP-3 M1)。缺 ⇒ `—`,**不填 0**。 */
  function metricLinesOf (ipc) {
    const m = metricsOf(ipc)
    // 没数 ⇒ 这一行**不说话**(由 metricsNoteOf 给一句带真原因的"缺席",避免两句重复)
    if (m === null) return []
    const q = (m.quantities && typeof m.quantities === 'object') ? m.quantities : {}
    const g = (k) => f2(q[k])
    return [
      '六个量:互补 ' + g('complementarity') + ' · 互动性 ' + g('reciprocity')
        + ' · 一致性 ' + g('correspondence') + ' · 相似 ' + g('similarity')
        + ' · 对立 ' + g('opposition'),
      '关系类型:' + (m.pattern && m.pattern.zh ? String(m.pattern.zh) + '(fit ' + f2(m.pattern.fit) + ')' : '—')
        + ' · 分离角 ' + (num(m.separationDegrees) === null ? '—' : f1(m.separationDegrees) + '°')
    ]
  }

  /**
   * 关系度量那一行的人话(2026-10-07 MVP-3 M5)。
   *
   * **修的就是这行的假话**:老写法 `ipc.metricsNote || '主人一侧坐标未接入…'` ——
   * 后端有数时 `metricsNote` 是 `null`(它只在"没数"时才说话)⇒ `||` 兜底会把陈年
   * 那句"未接入"顶出来,于是面板一边画青点一边写着未接入。
   */
  function metricsNoteOf (ipc) {
    if (metricsOf(ipc) !== null) return '关系度量:六个量在本卡;两套坐标口径的差见「两把尺子的差」'
    const note = ipc && typeof ipc.metricsNote === 'string' ? ipc.metricsNote : ''
    if (note !== '') return '关系度量:缺席(' + note + ')'
    return '关系度量:缺席(要两个坐标)'
  }

  /** 圆盘 badge 里那一句短话(M1:有数就给数,没数就说缺席)。 */
  function metricBadgeText (ipc) {
    const m = metricsOf(ipc)
    if (m === null) return '关系度量:缺席(要两个坐标)'
    const q = (m.quantities && typeof m.quantities === 'object') ? m.quantities : {}
    const sep = num(m.separationDegrees)
    return '互补 ' + f2(q.complementarity) + ' · 分离 ' + (sep === null ? '—' : f1(sep) + '°')
      + (m.pattern && m.pattern.zh ? ' · ' + String(m.pattern.zh) : '')
  }

  /** 残差小卡(2026-10-07 MVP-3 M2):两把尺子的差 —— **只记账,不回写**。 */
  function residualLinesOf (ipc) {
    const m = metricsOf(ipc)
    const err = (ipc && typeof ipc.ipcErr === 'object' && ipc.ipcErr !== null) ? ipc.ipcErr : null
    if (m === null && err === null) {
      return ['这一轮没判定(节流 / 总闸关 / 引擎没产出 / 红档 —— 原因看状态面 echo_status.ipcAppraise)']
    }
    const gate = String((ipc && ipc.errGate) || 'unknown')
    const at = num(ipc && ipc.at)
    return [
      '两把尺子的差(LLM 直判的「她」 vs 向量映射的她):'
        + (err === null ? '—' : 'maxAbs ' + f2(err.maxAbs) + '(Δa ' + f2(err.a) + ' · Δc ' + f2(err.c) + ')'),
      '档:' + (GATE_ZH[gate] || GATE_ZH.unknown) + (gate === 'red' ? ' —— 红档:本版不画数、不给点' : ''),
      '这次判定的可信度:' + f2(ipc && ipc.gain)
        + (ipc && ipc.lowConfidence === true ? '(低于门槛:不落库)' : '')
        + (at === null ? '' : ' · 判定于 ' + when(at))
    ]
  }

  /**
   * 端点的顶层 `baseline`(P5 的人格基线)→ 立方体口径。
   * 只有 `set === true` 且 P/A 都拿得到才返回 —— **不画一个没人填过的点**。
   * `d` 恒 `null`(支配维"已登记未启用"),上立方体时落在中面(`world` 里当 0)。
   */
  function baselineOf (data) {
    const b = (data && typeof data.baseline === 'object' && data.baseline !== null) ? data.baseline : null
    if (b === null || b.set !== true) return null
    const unit = (b.unit && typeof b.unit === 'object') ? b.unit : null
    const p = unit ? num(unit.p) : null
    const a = unit ? num(unit.a) : null
    if (p === null || a === null) return null
    return {
      point: { p, a, d: 0 }, p, a,
      native: { p: num(b.p), a: num(b.a) },
      source: String(b.source || '')
    }
  }

  /** 基线的图例/说明文案(来源如实标;`source` 认不出就说"手填")。 */
  function baselineTextOf (data) {
    const base = baselineOf(data)
    if (base === null) return { text: '人格基线 —— 未接入(总闸关着或还没填)', dim: true, base: null }
    const src = base.source === 'mean' ? '均值' : base.source === 'inferred' ? '推断' : '手填'
    return {
      text: '人格基线(P ' + f2(base.native.p) + ' / A ' + f2(base.native.a) + ',' + src + ')',
      dim: false,
      base
    }
  }

  function summaryOf (data) {
    const d = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {}
    const pad = (d.pad && typeof d.pad === 'object') ? d.pad : {}
    const ipc = (d.ipc && typeof d.ipc === 'object') ? d.ipc : {}
    const uni = (d.union && typeof d.union === 'object') ? d.union : null
    const hist = Array.isArray(d.history) ? d.history : []
    const warn = []
    if (typeof d.error === 'string' && d.error !== '') warn.push('读数降级:' + d.error)
    if (d.ipcAvailable === false) warn.push('IPC 副本不可用:关系几何缺席(空盘)')
    if (ipc.octants === null || ipc.octants === undefined) warn.push('分仪表不可用(圆盘只能画空盘)')
    if (Array.isArray(pad.missing) && pad.missing.length > 0) warn.push('缺维:' + pad.missing.join('、'))
    if (d.degraded === true) warn.push('桥接降级(degraded)')
    if (ipc.role === null || ipc.role === undefined) warn.push('IPC 侧姿态拿不到(依赖/爱意缺维?)')
    // 注:「关系度量缺席(要两个坐标)」**不进 warn** —— 主人一侧未接入是长期状态,
    // 每次都顶上一条黄字就是噪音;它写在 IPC 卡与圆盘的灰环占位里。

    const state = '模式 ' + String(d.mode || '—')
      + ' · IPC 副本 ' + (d.ipcAvailable === true ? '可用' : '不可用')
      + ' · 逐轮样本 ' + hist.length + ' 条'
      + ' · ' + when(d.at)

    const padLines = [
      '心情 p = ' + f2(pad.p) + ' · 唤醒 a = ' + f2(pad.a) + ' · 支配 d = ' + f2(pad.d),
      '支配来源:' + (SOURCE_ZH[String(pad.dSource ?? '')] || SOURCE_ZH['']),
      '缺维:' + (Array.isArray(pad.missing) && pad.missing.length > 0 ? pad.missing.join('、') : '无')
    ]

    const unionLines = uni === null
      ? ['没有联合读数(总闸关了或计算降级)']
      : [
        '共享轴 s = ' + f2(uni.s) + ' · 激活 a = ' + f2(uni.a) + ' · 支配 d = ' + f2(uni.d),
        '门禁:' + (GATE_ZH[String(d.gate ?? '')] || GATE_ZH.unknown) + ' · 残差 ' + f2(d.bridgeErr ?? d.resid)
          + ' · 方向 ' + dirZh(d.direction),
        '两侧读数:s_pad = ' + f2(d.sPad) + ' vs s_ipc = ' + f2(d.sIpc) + '(预测 ' + f2(d.predicted) + ')'
      ]

    const ipcLines = [
      '角色姿态:a(主导)= ' + f2(ipc.role && ipc.role.a) + ' · c(亲近)= ' + f2(ipc.role && ipc.role.c),
      '最近姿态锚点:' + (ipc.anchor && ipc.anchor.zh ? ipc.anchor.zh + '(' + String(ipc.anchor.octant || '') + ')' : '—'),
      '所在区域:' + (ipc.region && ipc.region.label ? ipc.region.label + '(' + String(ipc.region.octant || '') + ' · ' + f1(ipc.region.angle) + '°)' : '—'),
      '互补位:' + (ipc.complementPoint ? '(' + f2(ipc.complementPoint.a) + ', ' + f2(ipc.complementPoint.c) + ')' : '—')
        + ' · 对立位:' + (ipc.antiComplementPoint ? '(' + f2(ipc.antiComplementPoint.a) + ', ' + f2(ipc.antiComplementPoint.c) + ')' : '—'),
      // 2026-10-06 D3:锚点清单已从端点砍掉(与 region.label 重复)⇒ 这一行只报分仪表
      '词表:分仪 ' + (Array.isArray(ipc.octants) ? ipc.octants.length : 0),
      ...metricLinesOf(ipc), // 2026-10-07 MVP-3 M1:六个关系量 + 关系类型/分离角
      metricsNoteOf(ipc)     // M5:有数就不再写"未接入"(老写法在这里撒过谎)
    ]

    // ②(2026-10-05):「语气候选」卡 —— 看得见才调得动。
    const styleLines = styleLinesOf(d.styleHint)

    return { state, pad: padLines, union: unionLines, ipc: ipcLines, residual: residualLinesOf(ipc), style: styleLines, warn }
  }

  /** 逐轮表:端点已按「旧 → 新」排好;这里只做字段投影(缺 ⇒ null,**不填 0**)。 */
  function historyRows (data) {
    const d = (data && typeof data === 'object') ? data : {}
    const rows = Array.isArray(d.history) ? d.history : []
    return rows.map((r, i) => {
      const row = (r && typeof r === 'object') ? r : {}
      const pad = (row.pad && typeof row.pad === 'object') ? row.pad : {}
      const ipc = (row.ipc && typeof row.ipc === 'object') ? row.ipc : null
      return {
        index: i + 1,
        at: num(row.at),
        when: when(row.at),
        moodIntensity: num(row.moodIntensity),
        p: num(pad.valence), a: num(pad.arousal), d: num(pad.dominance),
        dSource: row.dSource === undefined ? null : row.dSource,
        s: num(row.union && row.union.s),
        sPad: num(row.sPad), sIpc: num(row.sIpc), bridgeErr: num(row.bridgeErr),
        gate: String(row.gate || 'unknown'),
        direction: row.direction === undefined ? null : row.direction,
        ipcA: ipc === null ? null : num(ipc.a),
        ipcC: ipc === null ? null : num(ipc.c),
        userEmotion: row.userEmotion === undefined ? null : row.userEmotion
      }
    })
  }

  /**
   * 轨迹折线点:只取有 `ipc` 的历史行(旧 → 新)。**角色**一条,用户那条没有数据源。
   * 纯函数,单测直接喂假数据。
   */
  function trailOf (data) {
    const d = (data && typeof data === 'object') ? data : {}
    const rows = Array.isArray(d.history) ? d.history : []
    return rows
      .map((r) => (r && typeof r === 'object' && r.ipc && typeof r.ipc === 'object' ? r.ipc : null))
      .filter((p) => p !== null && num(p.a) !== null && num(p.c) !== null)
      .map((p) => ({ a: num(p.a), c: num(p.c) }))
  }

  // ---------------------------------------------------------------- 样式
  //
  // 逐条来自上游 CSS(类名 `ipc-` → `es-`),只做一件事:把宿主主题变量
  // (`--dsw-alias-*`)换成 Echo 页面的变量或内联色(用户拍板:宿主变量不许进 Echo)。

  const CSS = `
.es-root{display:flex;flex-direction:column;min-height:0;background:transparent;color:var(--ink,#e8eef8);font-size:12px}
.es-stage{position:relative;flex:1 1 auto;min-height:340px;height:360px}
/* 立方体比圆盘矮一点:它只要装一个单位立方体 + 三条轴的标签 */
.es-stage-cube{min-height:300px;height:320px}
.es-stage canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab}
.es-stage canvas:active{cursor:grabbing}
.es-badge{position:absolute;left:10px;top:8px;display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:2px;pointer-events:none;max-width:70%}
.es-pattern{font-size:17px;font-weight:600;letter-spacing:.4px}
.es-note{font-size:10px;opacity:.55}
.es-subject{font-size:11px;line-height:1.3;opacity:1;text-align:left;color:rgba(232,236,242,.6)}
.es-subject b{color:#7fd4a8;font-weight:700;letter-spacing:.5px}
.es-stateline{display:flex;align-items:flex-start;gap:4px;opacity:.75;pointer-events:auto;line-height:1.45}
.es-hint{position:absolute;right:10px;bottom:8px;font-size:10px;opacity:.45;pointer-events:none;text-align:right}
.es-tools{display:flex;gap:6px;flex-wrap:wrap;padding:8px 0 6px;flex:none;align-items:center}
.es-chip{border:1px solid var(--line,#26334a);background:transparent;color:inherit;font-size:10px;padding:2px 7px;border-radius:9px;cursor:pointer;opacity:.55}
.es-chip[data-on="true"]{opacity:1;border-color:#7fd4a8;color:#7fd4a8}
.es-legend{display:flex;gap:9px;flex-wrap:wrap;padding:0 0 8px;font-size:11px;opacity:.8;flex:none}
.es-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:-1px}
.es-help{position:relative;display:inline-flex;flex:none}
.es-q{width:13px;height:13px;line-height:11px;padding:0;border-radius:50%;border:1px solid var(--line-hi,#35486a);background:transparent;color:inherit;font-size:9px;cursor:pointer;opacity:.6}
.es-q:hover{opacity:1;border-color:#7fd4a8;color:#7fd4a8}
/* 弹窗必须是不透明浮层,否则会跟下面的文字叠成重影(上游注释原话)。 */
.es-pop{position:absolute;left:0;top:18px;z-index:60;width:240px;padding:8px 10px;border-radius:7px;font-size:11px;line-height:1.55;white-space:pre-line;background:#23272e;color:#e8ecf2;border:1px solid var(--line,#26334a);box-shadow:0 10px 28px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.4)}
`

  /** 只注入一次样式表,按 tag 去重(上游 `injectCss` 同法,换 tag 名)。 */
  function injectCss () {
    if (document.querySelector('style[data-echo-emotion-space]') !== null) return
    const tag = document.createElement('style')
    tag.setAttribute('data-echo-emotion-space', '')
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  // ---------------------------------------------------------------- 几何
  // 以下三个函数**逐字**搬自上游 `client.js:226-268`(只改了注释里的出处标注)。

  /** 把 IPC 点映射到画布坐标(单极 [0,1]²;纵轴向上为 +掌控 ⇒ y 取反)。 */
  function toScreen (point, view) {
    return {
      x: view.cx + ((point.c - 0.5) / DISK_RADIUS) * view.r,
      y: view.cy - ((point.a - 0.5) / DISK_RADIUS) * view.r
    }
  }

  /** 角度(从 +联结 起算、逆时针为正)+ 半径比例 → 画布坐标。 */
  function polarToScreen (degrees, radiusRatio, view) {
    const radians = (degrees * Math.PI) / 180
    return {
      x: view.cx + Math.cos(radians) * radiusRatio * view.r,
      y: view.cy - Math.sin(radians) * radiusRatio * view.r
    }
  }

  /** 扇区路径(中心 → 弧 → 闭合)。`anticlockwise = true` 才是视觉上的逆时针(上游注释)。 */
  function sectorPath (g, fromDeg, toDeg, radiusRatio, view) {
    const from = (fromDeg * Math.PI) / 180
    const to = (toDeg * Math.PI) / 180
    const radius = radiusRatio * view.r
    g.beginPath()
    g.moveTo(view.cx, view.cy)
    g.arc(view.cx, view.cy, radius, -from, -to, true)
    g.closePath()
  }

  /**
   * 画整个圆盘。**绘制顺序即遮挡顺序**(上游注释):底 → 扇区 → 网格 → 轨迹 → 锚点 →
   * 理想位 → 关系向量 → 两个点。全部是 2D 图元,没有需要排序的 3D 面。
   *
   * @param {CanvasRenderingContext2D} g 画布上下文。
   * @param {object} params 输入:`{width, height, state, anchors, show}`。
   *   `state` 形如端点的 `ipc` 段(`{role, octants, anchors, complementPoint, antiComplementPoint, region, metrics}`),
   *   外加 `history`(轨迹用)。
   */
  function drawDisc (g, { width, height, state, anchors, show }) {
    const view = {
      cx: width / 2,
      cy: height / 2,
      // 0.5 的半径只占画布 0.40,留出外圈文字与标签的余地(上游原式)。
      r: Math.min(width, height) * 0.40
    }
    g.clearRect(0, 0, width, height)

    // ---- 背景:一圈很淡的径向渐变,让圆盘「浮」起来
    const backdrop = g.createRadialGradient(view.cx, view.cy, 0, view.cx, view.cy, Math.max(width, height) * 0.7)
    backdrop.addColorStop(0, 'rgba(120,200,170,0.10)')
    backdrop.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = backdrop
    g.fillRect(0, 0, width, height)

    const octants = (state && Array.isArray(state.octants)) ? state.octants : []

    // ---- 8 个扇区:交替填充,帮助肉眼分辨分仪边界
    octants.forEach((octant, index) => {
      sectorPath(g, octant.angle - 22.5, octant.angle + 22.5, 1, view)
      g.fillStyle = index % 2 === 0 ? 'rgba(150,190,225,0.055)' : 'rgba(150,190,225,0.025)'
      g.fill()
    })

    // ---- 4 圈等强度环(半径即强度,所以环就是刻度)
    for (const step of [0.25, 0.5, 0.75, 1]) {
      g.strokeStyle = step === 1 ? 'rgba(165,195,235,0.42)' : 'rgba(165,195,235,0.16)'
      g.lineWidth = step === 1 ? 1.4 : 1
      g.beginPath()
      g.arc(view.cx, view.cy, step * view.r, 0, Math.PI * 2)
      g.stroke()
    }

    // ---- 8 条辐射轴(分仪边界),并标注分仪名
    for (const octant of octants) {
      const edge = polarToScreen(octant.angle + 22.5, 1, view)
      g.strokeStyle = 'rgba(165,195,235,0.18)'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(view.cx, view.cy)
      g.lineTo(edge.x, edge.y)
      g.stroke()

      const label = polarToScreen(octant.angle, 1.16, view)
      g.fillStyle = 'rgba(210,225,245,0.82)'
      g.font = '600 10px ui-sans-serif,system-ui,sans-serif'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(octant.zh, label.x, label.y)
      g.fillStyle = 'rgba(210,225,245,0.45)'
      g.font = '9px ui-sans-serif,system-ui,sans-serif'
      g.fillText(`${octant.angle}°`, label.x, label.y + 11)
    }

    // ---- 两条主轴:主导性(纵)与亲近度(横)
    g.lineWidth = 1.4
    g.strokeStyle = 'rgba(233,190,120,0.55)'
    g.beginPath()
    g.moveTo(view.cx, view.cy - view.r)
    g.lineTo(view.cx, view.cy + view.r)
    g.stroke()
    g.strokeStyle = 'rgba(120,205,235,0.55)'
    g.beginPath()
    g.moveTo(view.cx - view.r, view.cy)
    g.lineTo(view.cx + view.r, view.cy)
    g.stroke()

    g.font = '600 10px ui-sans-serif,system-ui,sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillStyle = 'rgba(233,190,120,0.9)'
    g.fillText('主导性 ↑', view.cx, view.cy - view.r - 14)
    g.fillText('听对方的', view.cx, view.cy + view.r + 14)
    g.fillStyle = 'rgba(120,205,235,0.9)'
    g.textAlign = 'left'
    g.fillText('亲近度 →', view.cx + view.r + 6, view.cy - 12)
    g.textAlign = 'right'
    g.fillText('冷淡', view.cx - view.r - 6, view.cy - 12)

    // ---- 中心点
    g.strokeStyle = 'rgba(200,200,200,0.45)'
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(view.cx - 4, view.cy)
    g.lineTo(view.cx + 4, view.cy)
    g.moveTo(view.cx, view.cy - 4)
    g.lineTo(view.cx, view.cy + 4)
    g.stroke()

    const role = (state && state.role && num(state.role.a) !== null && num(state.role.c) !== null)
      ? { a: num(state.role.a), c: num(state.role.c) }
      : null

    if (state === null || state === undefined || role === null) {
      // 上游原句('等待宿主状态…')+ 这里的真实原因(缺维 / IPC 副本缺失)
      g.fillStyle = 'rgba(220,220,220,0.5)'
      g.font = '12px ui-sans-serif,system-ui,sans-serif'
      g.textAlign = 'center'
      g.fillText('等待姿态读数…', view.cx, view.cy + view.r + 34)
      if (state && (state.octants === null || state.octants === undefined)) {
        g.fillText('(IPC 副本不可用:画不出分仪与锚点)', view.cx, view.cy + view.r + 50)
      } else if (role === null) {
        g.fillText('(IPC 侧姿态拿不到:依赖 / 爱意缺维?)', view.cx, view.cy + view.r + 50)
      }
      return
    }

    // ---- 词表锚点(可开关):小灰点,只标分仪码,避免糊成一片
    if (show.anchors) {
      for (const anchor of anchors) {
        const screen = toScreen({ a: anchor.a, c: anchor.c }, view)
        g.fillStyle = 'rgba(140,200,180,0.40)'
        g.beginPath()
        g.arc(screen.x, screen.y, 2, 0, Math.PI * 2)
        g.fill()
      }
    }

    // ---- 轨迹:越旧越暗(上游原式:age = i / len,alpha 0.05+0.35·age,lineWidth 0.8+1.3·age)
    // 上游画两条(self/other);Echo 只有**角色**一条(用户那条没有数据源)⇒ 只画 self。
    const history = (state && Array.isArray(state.history)) ? state.history : []
    if (show.trail && history.length > 1) {
      for (const [key, color] of [['self', TRAIL_SELF]]) {
        for (let i = 1; i < history.length; i += 1) {
          const from = history[i - 1] && history[i - 1][key]
          const to = history[i] && history[i][key]
          if (from === undefined || to === undefined || from === null || to === null) continue
          const a = toScreen(from, view)
          const b = toScreen(to, view)
          const age = i / history.length
          g.strokeStyle = `rgba(${color},${0.05 + 0.35 * age})`
          g.lineWidth = 0.8 + 1.3 * age
          g.beginPath()
          g.moveTo(a.x, a.y)
          g.lineTo(b.x, b.y)
          g.stroke()
        }
      }
    }

    const selfScreen = toScreen(role, view)
    const metrics = (state && state.metrics && typeof state.metrics === 'object') ? state.metrics : null
    const other = (metrics && metrics.other && num(metrics.other.a) !== null && num(metrics.other.c) !== null)
      ? { a: num(metrics.other.a), c: num(metrics.other.c) }
      : null
    const otherScreen = other === null ? null : toScreen(other, view)

    // ---- 理想位:互补点(沿联结轴镜像)与对立点(旋转 180°)
    // 上游的两个圈是「互补位 / 错位位」;Echo 手上是 `complementPoint` / `antiComplementPoint`
    // (后者是两轴全翻 = 对立位),所以第二个圈如实标『对立位』—— 名字跟着真数据走。
    if (show.ideal) {
      const marks = [
        { point: state.complementPoint, label: '互补位', color: '127,212,168' },
        { point: state.antiComplementPoint, label: '对立位', color: '240,163,94' }
      ]
      for (const mark of marks) {
        if (mark.point === undefined || mark.point === null) continue
        const screen = toScreen(mark.point, view)
        g.strokeStyle = `rgba(${mark.color},0.85)`
        g.lineWidth = 1.2
        g.setLineDash([3, 3])
        g.beginPath()
        g.arc(screen.x, screen.y, 5.5, 0, Math.PI * 2)
        g.stroke()
        g.setLineDash([])
        g.fillStyle = `rgba(${mark.color},0.8)`
        g.font = '9px ui-sans-serif,system-ui,sans-serif'
        g.textAlign = 'left'
        g.fillText(mark.label, screen.x + 8, screen.y - 7)
      }
    }

    // ---- 关系向量(角色 → 用户)与关系标签:上游这里依赖 `snapshot.metrics`
    // (关系类型 + 分离角),而那两个数**需要主人一侧坐标** ⇒ Echo 未接入时整块不画。
    if (otherScreen !== null) {
      g.strokeStyle = 'rgba(255,255,255,0.35)'
      g.lineWidth = 1.2
      g.setLineDash([4, 3])
      g.beginPath()
      g.moveTo(selfScreen.x, selfScreen.y)
      g.lineTo(otherScreen.x, otherScreen.y)
      g.stroke()
      g.setLineDash([])

      // 箭头画在两点之间 72% 处,避免压住端点圆圈(上游原式)
      const angle = Math.atan2(otherScreen.y - selfScreen.y, otherScreen.x - selfScreen.x)
      const tip = {
        x: selfScreen.x + (otherScreen.x - selfScreen.x) * 0.72,
        y: selfScreen.y + (otherScreen.y - selfScreen.y) * 0.72
      }
      g.fillStyle = 'rgba(255,255,255,0.5)'
      g.beginPath()
      g.moveTo(tip.x, tip.y)
      g.lineTo(tip.x - Math.cos(angle - 0.4) * 9, tip.y - Math.sin(angle - 0.4) * 9)
      g.lineTo(tip.x - Math.cos(angle + 0.4) * 9, tip.y - Math.sin(angle + 0.4) * 9)
      g.closePath()
      g.fill()

      const mid = { x: (selfScreen.x + otherScreen.x) / 2, y: (selfScreen.y + otherScreen.y) / 2 }
      // 2026-10-07 MVP-3 M6:端点**不给** `metrics.flat` ⇒ 老判据 `!metrics.flat` 恒真。
      // 用两个"平淡"旗标自己判(端点有给 selfNeutral / otherNeutral)。
      const flat = metrics.flat === true
        || (metrics.selfNeutral === true && metrics.otherNeutral === true)
      if (!flat) {
        const pat = (metrics.pattern && typeof metrics.pattern === 'object') ? metrics.pattern : null
        g.fillStyle = '#cfd8e6'
        g.font = '600 11px ui-sans-serif,system-ui,sans-serif'
        g.textAlign = 'center'
        if (pat && pat.zh) {
          g.fillText(`${pat.zh} ${f2(pat.fit)}`, mid.x, mid.y - 6)
        }
        g.fillStyle = 'rgba(220,225,235,0.55)'
        g.font = '9px ui-sans-serif,system-ui,sans-serif'
        g.fillText(`${num(metrics.separationDegrees) === null ? '—' : f1(metrics.separationDegrees) + '°'}`, mid.x, mid.y + 6)
      }
    } else {
      // 灰环占位(拍板 D6):主人一侧坐标未接入 —— 明确是"没有",不是"在中心"。
      g.strokeStyle = 'rgba(160,170,185,0.35)'
      g.lineWidth = 1.2
      g.setLineDash([2, 4])
      g.beginPath()
      g.arc(view.cx, view.cy, view.r + 6, 0, Math.PI * 2)
      g.stroke()
      g.setLineDash([])
      g.fillStyle = 'rgba(200,208,220,0.45)'
      g.font = '600 10px ui-sans-serif,system-ui,sans-serif'
      g.textAlign = 'center'
      g.fillText('用户一侧未接入(灰环占位)', view.cx, view.cy - view.r - 30)
    }

    /** 画一个带光晕的点(上游原式:光晕半径 = 点半径 × 4.5)。 */
    const marker = (screen, color, glowColor, label, radius) => {
      const glow = g.createRadialGradient(screen.x, screen.y, 0, screen.x, screen.y, radius * 4.5)
      glow.addColorStop(0, glowColor)
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      g.fillStyle = glow
      g.beginPath()
      g.arc(screen.x, screen.y, radius * 4.5, 0, Math.PI * 2)
      g.fill()

      g.fillStyle = color
      g.strokeStyle = 'rgba(0,0,0,0.35)'
      g.lineWidth = 1
      g.beginPath()
      g.arc(screen.x, screen.y, radius, 0, Math.PI * 2)
      g.fill()
      g.stroke()

      if (label !== undefined && label !== '') {
        g.fillStyle = color
        g.font = '600 10px ui-sans-serif,system-ui,sans-serif'
        g.textAlign = 'left'
        g.fillText(label, screen.x + radius + 5, screen.y - radius - 2)
      }
    }

    if (otherScreen !== null) marker(otherScreen, '#78cdeb', 'rgba(120,205,235,0.32)', '用户', 5.5)
    const regionZh = (state.region && (state.region.word || state.region.zh)) ? (state.region.word || state.region.zh) : ''
    marker(selfScreen, '#ffd678', 'rgba(255,214,120,0.35)', regionZh === '' ? '角色' : `角色·${regionZh}`, 6.5)

    // ---- 强度刻度文字(最外圈)
    g.fillStyle = 'rgba(220,225,235,0.35)'
    g.font = '9px ui-monospace,monospace'
    g.textAlign = 'left'
    g.fillText('1.0', view.cx + 3, view.cy - view.r)
    g.fillText('0.5', view.cx + 3, view.cy - view.r * 0.5)
  }

  // ---------------------------------------------------------------- PAD 立方体
  //
  // 逐字搬自 `dsh-pad-emotion/client.js`:3D 数学 `119-157`(rotate / project / world)、
  // 场景绘制 `184-403`(六面按平均深度排序 → 远处三面画 0.1 刻度网格墙 → 12 条棱按深度
  // 调亮度 → 三轴从中心射向 +P/+A/+D 面心 → 中性十字 → 标记点统一按深度排序 →
  // 当前点到三个坐标平面的虚线投影 → 历史轨迹越旧越暗)、数据与交互骨架 `506-620`
  // (DPR 适配、rAF 自转、拖拽、双击)。**数学一行未改**(CAMERA 4.2、scale 0.29、
  // 俯仰夹 ±1.45、自转 0.0035/帧、轨迹 `0.06+0.5·age` 与 `1+1.6·age`、光晕 ×5)。

  /** 三个轴的展示元数据(上游 `AXES`;D 轴按本仓叫法写「支配」,上游叫「优势度」)。 */
  const AXES = [
    { key: 'p', short: 'P', zh: '愉悦度', color: '#f0a35e' },
    { key: 'a', short: 'A', zh: '唤醒度', color: '#5ec8f0' },
    { key: 'd', short: 'D', zh: '支配', color: '#a98cf0' }
  ]

  /** 绕 Y 轴(yaw)与 X 轴(pitch)旋转一个世界坐标点(上游 `119-131` 原式)。 */
  function rotate (point, yaw, pitch) {
    const cosYaw = Math.cos(yaw)
    const sinYaw = Math.sin(yaw)
    const x1 = point.x * cosYaw - point.z * sinYaw
    const z1 = point.x * sinYaw + point.z * cosYaw
    const cosPitch = Math.cos(pitch)
    const sinPitch = Math.sin(pitch)
    return {
      x: x1,
      y: point.y * cosPitch - z1 * sinPitch,
      z: point.y * sinPitch + z1 * cosPitch
    }
  }

  /** 透视投影到画布坐标(相机在 +z、距离 CAMERA 个世界单位;上游 `139-148` 原式)。 */
  function project (rotated, view) {
    const CAMERA = 4.2
    const depth = CAMERA / (CAMERA - rotated.z)
    return {
      x: view.cx + rotated.x * view.scale * depth,
      y: view.cy - rotated.y * view.scale * depth,
      depth: rotated.z,
      scale: depth
    }
  }

  /** PAD 单位点 [0,1]³ → 世界坐标 [-1,1]³(上游 `155-157` 原式)。 */
  function world (point) {
    return { x: point.p * 2 - 1, y: point.a * 2 - 1, z: point.d * 2 - 1 }
  }

  /** 立方体的六个面:每个面固定一个轴,另外两轴遍历(上游 `FACES` 原样)。 */
  const FACES = [
    { axis: 'x', value: -1, u: 'y', v: 'z', label: 'P=0' },
    { axis: 'x', value: 1, u: 'y', v: 'z', label: 'P=1' },
    { axis: 'y', value: -1, u: 'x', v: 'z', label: 'A=0' },
    { axis: 'y', value: 1, u: 'x', v: 'z', label: 'A=1' },
    { axis: 'z', value: -1, u: 'x', v: 'y', label: 'D=0' },
    { axis: 'z', value: 1, u: 'x', v: 'y', label: 'D=1' }
  ]

  /** 立方体 8 个顶点(上游 `CORNERS` 原样,同一个双层循环写法)。 */
  const CORNERS = []
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) CORNERS.push({ x, y, z })

  /**
   * Echo 端点的 `pad` → 立方体要的**单位立方体 [0,1]³**。
   *
   * 三个轴在端点里的刻度**不一样**:`p` 已经是 `[0,1]`(宿主 `echoVectorToBipolar` 里
   * `p = v/10`),而 `a` / `d` 是双极 `[-1,1]`。这里按 `lib/emotion-space.js` 的
   * `bipolarToUnit` 同一式换算:`(x+1)/2`。缺维 ⇒ 该轴 `null`(**不猜 0.5**)。
   */
  function padUnitOf (pad) {
    const src = (pad && typeof pad === 'object') ? pad : {}
    const bp = (v) => { const n = num(v); return n === null ? null : (Math.max(-1, Math.min(1, n)) + 1) / 2 }
    const up = (v) => { const n = num(v); return n === null ? null : Math.max(0, Math.min(1, n)) }
    return { p: up(src.p), a: bp(src.a), d: bp(src.d) }
  }

  /** 逐轮轨迹: `history[].pad` → 单位立方体点(旧 → 新);缺维的行**跳过**。 */
  function trailUnitOf (data) {
    const d = (data && typeof data === 'object') ? data : {}
    const rows = Array.isArray(d.history) ? d.history : []
    const out = []
    for (const r of rows) {
      const u = padUnitOf(r && r.pad)
      if (u.p === null || u.a === null || u.d === null) continue
      out.push(u)
    }
    return out
  }

  /**
   * 拖拽 → 视角的两个**纯函数**(可单测;上游 `558-559` 是内联在事件回调里的)。
   *
   * 纵向照上游:`pitch = clamp(pitch0 + Δy·0.008)`,往下拖时表面往下走(手感"抓住表面拖")。
   * 横向**故意取负** —— [拍板 D12,本站唯一一处偏离上游]:理由是可复现的 ——
   * 上游 `yaw = yaw0 + Δx·0.008`,把"往右拖 50px"代进去,立方体**前面心**(正对着看的那个面)
   * 的画面 x 从 446 走到 406(往左,逆着手);而同一个模型里纵向是跟着手走的。
   * 两个轴手感相反 ⇒ 上游那一行是笔误。取负之后前面心 446 → 469(跟着手),与纵向一致。
   * (探针留档 `.scratch/probe-drag-direction.mjs`,可随时复算。)
   */
  function dragYaw (yaw0, dx) { return yaw0 - dx * 0.008 }
  function dragPitch (pitch0, dy) { return Math.max(-1.45, Math.min(1.45, pitch0 + dy * 0.008)) }

  /**
   * 画立方体(上游 `draw` 逐字搬;只有数据字段名换成 Echo 的、以及上游缺的数据不画)。
   * @param {CanvasRenderingContext2D} g 画布上下文。
   * @param {object} params `{width, height, yaw, pitch, state, anchors}`。
   *   `state` = `{point, trail, label, baseline, alternatives, reason}`(单位立方体口径)。
   */
  function drawCube (g, { width, height, yaw, pitch, state, anchors }) {
    const view = {
      cx: width / 2,
      cy: height / 2,
      scale: Math.min(width, height) * 0.29
    }

    /** 世界点 → 画布点. */
    const toScreen = (point) => project(rotate(point, yaw, pitch), view)

    g.clearRect(0, 0, width, height)

    // ---- 背景径向渐变,给立方体一个「浮在空间里」的底
    const backdrop = g.createRadialGradient(view.cx, view.cy, 0, view.cx, view.cy, Math.max(width, height) * 0.7)
    backdrop.addColorStop(0, 'rgba(120,150,220,0.10)')
    backdrop.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = backdrop
    g.fillRect(0, 0, width, height)

    // ---- 六个面按平均深度排序,远处三面画成网格墙,近处三面只留淡边
    const faceInfo = FACES.map((face) => {
      const corners = []
      for (const u of [-1, 1]) {
        for (const v of [-1, 1]) {
          const point = { x: 0, y: 0, z: 0 }
          point[face.axis] = face.value
          point[face.u] = u
          point[face.v] = v
          corners.push(point)
        }
      }
      const depth = corners.reduce((sum, corner) => sum + rotate(corner, yaw, pitch).z, 0) / 4
      return { face, corners, depth }
    }).sort((a, b) => a.depth - b.depth)

    // 远处三面画 0.1 刻度网格 —— 它们构成「房间的后墙」,帮助读数值。
    for (const { face } of faceInfo.slice(0, 3)) {
      g.lineWidth = 1
      for (let step = 0; step <= 10; step += 1) {
        const t = step / 10 * 2 - 1
        for (const axis of [face.u, face.v]) {
          const a = { x: 0, y: 0, z: 0 }
          const b = { x: 0, y: 0, z: 0 }
          a[face.axis] = face.value
          b[face.axis] = face.value
          const other = axis === face.u ? face.v : face.u
          a[axis] = t
          b[axis] = t
          a[other] = -1
          b[other] = 1
          const sa = toScreen(a)
          const sb = toScreen(b)
          const major = step % 5 === 0
          g.strokeStyle = major ? 'rgba(150,175,225,0.30)' : 'rgba(150,175,225,0.13)'
          g.beginPath()
          g.moveTo(sa.x, sa.y)
          g.lineTo(sb.x, sb.y)
          g.stroke()
        }
      }
    }

    // 立方体 12 条棱:远的暗、近的亮。
    const edgePairs = []
    for (const corner of CORNERS) {
      for (const axis of ['x', 'y', 'z']) {
        if (corner[axis] !== 1) continue
        edgePairs.push([corner, { ...corner, [axis]: -1 }])
      }
    }
    for (const [a, b] of edgePairs) {
      const sa = toScreen(a)
      const sb = toScreen(b)
      const depth = (rotate(a, yaw, pitch).z + rotate(b, yaw, pitch).z) / 2
      g.strokeStyle = `rgba(165,190,240,${0.20 + 0.28 * ((depth + 1.4) / 2.8)})`
      g.lineWidth = 1.2
      g.beginPath()
      g.moveTo(sa.x, sa.y)
      g.lineTo(sb.x, sb.y)
      g.stroke()
    }

    // ---- 三条轴:从立方体中心射向 +P / +A / +D 三个面心
    for (const axis of AXES) {
      const dir = { x: 0, y: 0, z: 0 }
      dir[axis.key === 'p' ? 'x' : axis.key === 'a' ? 'y' : 'z'] = 1
      const from = toScreen({ x: 0, y: 0, z: 0 })
      const to = toScreen({ x: dir.x * 1.35, y: dir.y * 1.35, z: dir.z * 1.35 })
      g.strokeStyle = axis.color
      g.globalAlpha = 0.75
      g.lineWidth = 1.6
      g.beginPath()
      g.moveTo(from.x, from.y)
      g.lineTo(to.x, to.y)
      g.stroke()
      g.globalAlpha = 1

      g.fillStyle = axis.color
      g.font = '600 12px ui-sans-serif,system-ui,sans-serif'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(`${axis.short} ${axis.zh}`, to.x, to.y - 12)
    }

    // ---- 中性点:立方体正中心
    const neutral = toScreen({ x: 0, y: 0, z: 0 })
    g.strokeStyle = 'rgba(200,200,200,0.45)'
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(neutral.x - 4, neutral.y)
    g.lineTo(neutral.x + 4, neutral.y)
    g.moveTo(neutral.x, neutral.y - 4)
    g.lineTo(neutral.x, neutral.y + 4)
    g.stroke()

    const point = (state && state.point && state.point.p !== null && state.point.a !== null && state.point.d !== null)
      ? state.point
      : null
    if (point === null) {
      g.fillStyle = 'rgba(220,220,220,0.5)'
      g.font = '12px ui-sans-serif,system-ui,sans-serif'
      g.textAlign = 'center'
      g.fillText('等待姿态读数…', view.cx, view.cy + view.scale + 26)
      if (state && state.reason) {
        g.font = '10px ui-sans-serif,system-ui,sans-serif'
        g.fillText(state.reason, view.cx, view.cy + view.scale + 42)
      }
      return
    }

    // ---- 收集所有标记点,统一按深度排序后绘制,保证遮挡关系正确
    const markers = []

    // 基线:上游画人格基线(Echo 没有这个数据源 ⇒ `state.baseline` 恒 undefined,整块跳过)
    if (state.baseline) {
      markers.push({ kind: 'baseline', point: state.baseline, depth: rotate(world(state.baseline), yaw, pitch).z })
    }

    // 词表锚点:上游只画离当前点足够近的几个(`alternatives` 前 4 个)。
    // Echo **没有 PAD 词表**(拍板:上游注释里提到但本仓没有的,按"不存在"处理)⇒ 空集。
    const shownAnchorIds = new Set((state.alternatives ?? []).slice(0, 4).map((item) => item.id))
    for (const anchor of anchors) {
      if (!shownAnchorIds.has(anchor.id)) continue
      const p = { p: anchor.p, a: anchor.a, d: anchor.d }
      markers.push({ kind: 'anchor', label: anchor.zh, point: p, depth: rotate(world(p), yaw, pitch).z })
    }

    // 当前点
    markers.push({ kind: 'current', label: state.label, point, depth: rotate(world(point), yaw, pitch).z })
    markers.sort((a, b) => a.depth - b.depth)

    // 当前点到三个坐标平面的辅助投影线
    const currentWorld = world(point)
    const currentScreen = toScreen(currentWorld)
    g.setLineDash([3, 3])
    g.lineWidth = 1
    for (const [drop, color] of [
      [{ x: currentWorld.x, y: -1, z: currentWorld.z }, 'rgba(240,163,94,0.5)'],
      [{ x: -1, y: currentWorld.y, z: currentWorld.z }, 'rgba(94,200,240,0.5)'],
      [{ x: currentWorld.x, y: currentWorld.y, z: -1 }, 'rgba(169,140,240,0.5)']
    ]) {
      const end = toScreen(drop)
      g.strokeStyle = color
      g.beginPath()
      g.moveTo(currentScreen.x, currentScreen.y)
      g.lineTo(end.x, end.y)
      g.stroke()
    }
    g.setLineDash([])

    // 历史轨迹(上游原式:slice(-40)、透明度 0.06+0.5·age、线宽 1+1.6·age)
    const trail = (state.trail ?? []).slice(-40)
    if (trail.length > 1) {
      for (let i = 1; i < trail.length; i += 1) {
        const from = toScreen(world(trail[i - 1]))
        const to = toScreen(world(trail[i]))
        const age = (i / trail.length)
        g.strokeStyle = `rgba(255,214,120,${0.06 + 0.5 * age})`
        g.lineWidth = 1 + 1.6 * age
        g.beginPath()
        g.moveTo(from.x, from.y)
        g.lineTo(to.x, to.y)
        g.stroke()
      }
    }

    // 2026-10-07 MVP-3 M4:基线 → 当前点的**偏差虚线**(偏离多少一眼看见);
    // ΔP / ΔA = 当前点 − 基线(缺维写 —,**不填 0**)。
    // 基线不在视野/缺 P·A ⇒ 整块跳过(不画一条指向空气的线)。
    const basePoint = state.baseline
    if (basePoint && num(basePoint.p) !== null && num(basePoint.a) !== null
      && num(point.p) !== null && num(point.a) !== null) {
      const bs = toScreen(world(basePoint))
      const cs = toScreen(world(point))
      g.setLineDash([4, 4])
      g.lineWidth = 1.2
      g.strokeStyle = 'rgba(210,210,210,0.55)'
      g.beginPath()
      g.moveTo(bs.x, bs.y)
      g.lineTo(cs.x, cs.y)
      g.stroke()
      g.setLineDash([])
      g.fillStyle = 'rgba(210,210,210,0.95)'
      g.font = '10px ui-sans-serif,system-ui,sans-serif'
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      g.fillText('ΔP ' + f2(Number(point.p) - Number(basePoint.p))
        + ' · ΔA ' + f2(Number(point.a) - Number(basePoint.a)),
      (bs.x + cs.x) / 2 + 6, (bs.y + cs.y) / 2)
    }

    // 标记点本体
    for (const marker of markers) {
      const screen = toScreen(world(marker.point))
      const radius = (marker.kind === 'current' ? 5.5 : 2.8) * screen.scale

      if (marker.kind === 'current') {
        const glow = g.createRadialGradient(screen.x, screen.y, 0, screen.x, screen.y, radius * 5)
        glow.addColorStop(0, 'rgba(255,236,170,0.55)')
        glow.addColorStop(1, 'rgba(255,236,170,0)')
        g.fillStyle = glow
        g.beginPath()
        g.arc(screen.x, screen.y, radius * 5, 0, Math.PI * 2)
        g.fill()
      }

      g.fillStyle = marker.kind === 'current'
        ? '#ffe08a'
        : marker.kind === 'baseline' ? 'rgba(210,210,210,0.85)' : 'rgba(140,220,190,0.85)'
      g.beginPath()
      if (marker.kind === 'baseline') {
        g.strokeStyle = g.fillStyle
        g.lineWidth = 1.4
        g.moveTo(screen.x - 4, screen.y)
        g.lineTo(screen.x + 4, screen.y)
        g.moveTo(screen.x, screen.y - 4)
        g.lineTo(screen.x, screen.y + 4)
        g.stroke()
      } else {
        g.arc(screen.x, screen.y, radius, 0, Math.PI * 2)
        g.fill()
      }

      if (marker.label) {
        g.fillStyle = marker.kind === 'current' ? '#ffe08a' : 'rgba(160,230,200,0.9)'
        g.font = `${marker.kind === 'current' ? '600 12px' : '10px'} ui-sans-serif,system-ui,sans-serif`
        g.textAlign = 'left'
        g.textBaseline = 'middle'
        g.fillText(marker.label, screen.x + radius + 5, screen.y)
      }
    }
  }

  // ---------------------------------------------------------------- DOM 小件

  function el (tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined) e.textContent = String(text)
    return e
  }

  /**
   * 「?」按钮 + 点开的解释小弹窗(上游 `Help` 组件的原生版:点开显示、点别处关闭)。
   * 上游为什么不用原生 `title`:要悬停一秒、不能点、手机上看不到、长解释会被截断。
   */
  function helpBubble (text) {
    const wrap = el('span', 'es-help')
    const btn = el('button', 'es-q', '?')
    btn.type = 'button'
    btn.setAttribute('aria-label', '解释')
    btn.setAttribute('aria-expanded', 'false')
    const close = () => {
      const pop = wrap.querySelector('.es-pop')
      if (pop !== null) pop.remove()
      btn.setAttribute('aria-expanded', 'false')
      document.removeEventListener('click', onDoc)
    }
    const onDoc = (event) => { if (!wrap.contains(event.target)) close() }
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      if (wrap.querySelector('.es-pop') !== null) { close(); return }
      wrap.appendChild(el('span', 'es-pop', text))
      btn.setAttribute('aria-expanded', 'true')
      document.addEventListener('click', onDoc)
    })
    wrap.appendChild(btn)
    return wrap
  }

  /** 一个小开关按钮(上游 `Chip`,原样:data-on 控制样式)。 */
  function chip (label, on, onClick) {
    const b = el('button', 'es-chip', label)
    b.type = 'button'
    b.setAttribute('data-on', on ? 'true' : 'false')
    b.addEventListener('click', onClick)
    return b
  }

  const AXIS_HELP = {
    a: '主导性:这段互动里谁说了算。0.0 是你听用户的,1.0 是你拿主意,0.5 是两人相当。'
      + '盘上的金点是角色此刻的位置,蓝点是**她读到的你**(有判定时才有,见下方「两把尺子的差」)。',
    c: '亲近度:双方想靠近还是想保持距离。0.0 是冷淡、公事公办,1.0 是亲近、愿意交心,0.5 是中间。',
    word: '这个大字是「区域语言」:由姿态坐标落在哪个 45° 分仪 + 强度档拼出来的'
      + '(随和 / 主导 / 冷淡 …)。上游在这里显示的是**关系状态词**(亲密袒露与交流…),'
      + '那个要两个坐标才能算,所以本页换成长度可信的单方区域语言,名字跟着数据走。',
    ideal: '两个虚线圈:「互补位」= 沿联结轴镜像(谁拿主意、谁想亲近,正好互补);'
      + '「对立位」= 两轴全翻(旋转 180°)。这两个点在盘上是不同地方,并排画出来正是这张图想说明的事。'
      + '上游的第二个圈叫「错位位」(contrastPoint);Echo 手上只有 antiComplementPoint,所以如实标「对立位」。',
    trail: '轨迹 = 最近几轮角色姿态的折线,越旧越暗(透明度/线宽都按上游公式)。'
      + '上游画角色与用户两条;Echo 只有角色一条 —— 用户那条没有数据源。',
    anchors: '词表锚点:**本仓主动不提供** —— 2026-10-06 拍板 ⑨:上游那份 33 条单方姿态目录'
      + '与圆盘大字的「区域语言」功能重复,已从端点撤掉(`ipc.anchors` 恒 null)⇒ 图例里不再列它。'
      + '上游的小灰点画法还在(输入驱动),只是生产上永远没有数据可画。',
    metrics: '上游在这一块画「角色 → 用户」的关系向量与关系类型标签。那两个数(关系类型、分离角)'
      + '需要**两个**坐标:有判定(两点齐)时本页照画;没判定 / 红档时**不画**,只留灰环占位'
  }

  // ---------------------------------------------------------------- 模块级状态
  //
  // 上游是一串 `useRef` / `useState`;这里换成模块级对象(单页只挂一个实例)。
  // `sig` 是「数据签名」—— 上游靠 React 依赖数组重渲染,这里靠签名变化(等价物)。

  const M = {
    root: null,
    stage: null,
    canvas: null,
    frame: 0,
    data: null,
    anchors: [],
    show: { trail: true, anchors: false, ideal: true },
    sig: '',
    error: '',
    listening: false,
    // ---- ④ 立方体:视角/拖拽/自转(上游 `useRef` 那一套的模块级版)
    cubeStage: null,
    cubeCanvas: null,
    cubeHint: null,
    cubeFrame: 0,
    yaw: -0.62,
    pitch: 0.42,
    drag: null,
    spin: true,
    spinning: false
  }

  /** 上游 `render`(653-676)的原生版:DPR 尺寸 + setTransform + 交给 draw。 */
  function renderDisc () {
    const canvas = M.canvas
    const stage = M.stage
    if (canvas === null || stage === null || !canvas.isConnected) return
    const rect = stage.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(rect.width))
    const height = Math.max(1, Math.floor(rect.height))
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }
    const g = canvas.getContext('2d')
    if (g === null) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    // 状态对象 = 端点的 ipc 段 + 轨迹(history 里的 ipc 已由 trailOf 摊平)
    const ipc = (M.data && M.data.ipc && typeof M.data.ipc === 'object') ? M.data.ipc : null
    const state = ipc === null ? null : Object.assign({}, ipc, { history: trailOf(M.data) })
    drawDisc(g, { width, height, state, anchors: M.anchors, show: M.show })
  }

  /** ④ 立方体的渲染(上游 `render` 506-529 的原生版:DPR + setTransform + draw)。 */
  function renderCube () {
    const canvas = M.cubeCanvas
    const stage = M.cubeStage
    if (canvas === null || stage === null || !canvas.isConnected) return
    // 页面被切走就别烧 CPU(上游没有这一层;本仓加的卫生阀,不影响任何算法)
    if (canvas.offsetParent === null) return
    const rect = stage.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(rect.width))
    const height = Math.max(1, Math.floor(rect.height))
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }
    const g = canvas.getContext('2d')
    if (g === null) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)

    const data = M.data
    const pad = (data && typeof data.pad === 'object' && data.pad !== null) ? data.pad : {}
    const unit = padUnitOf(pad)
    const missing = unit.p === null || unit.a === null || unit.d === null
    const src = String(pad.dSource ?? '')
    // 2026-10-07 MVP-3 M3:人格基线挂上去(P5 的顶层 `baseline`,口径用 `unit` 双极值);
    // 只有 `set === true` 且 P/A 都拿得到才传 —— **不画一个没人填过的点**。
    const base = baselineOf(data)
    drawCube(g, {
      width,
      height,
      yaw: M.yaw,
      pitch: M.pitch,
      anchors: [],
      state: {
        point: missing ? { p: null, a: null, d: null } : unit,
        trail: trailUnitOf(data),
        // 当前点的标签跟着**真数据**走:支配是推导来的就把来源写脸上(拍板 D2)
        label: '当前' + (src === 'derived' ? '(d 推导)' : src === 'measured' ? '(d 实测)' : ''),
        reason: missing ? 'PAD 有缺维:画不出当前点' : '',
        baseline: base === null ? undefined : base.point
      }
    })
  }

  /** 自转循环(上游 534-547:拖拽中暂停;每帧 0.0035 弧度,与上游同一个数)。 */
  function spinTick () {
    if (!M.spinning) return
    if (M.spin && M.drag === null) {
      M.yaw += 0.0035
      renderCube()
    }
    M.cubeFrame = requestAnimationFrame(spinTick)
  }

  function ensureSpinLoop () {
    if (M.spinning) return
    M.spinning = true
    M.cubeFrame = requestAnimationFrame(spinTick)
  }

  /** resize 合并重绘:圆盘与立方体都在窗口尺寸变化时重画一次(上游 678-690 的原生版)。 */
  function listenResize () {
    if (M.listening) return
    M.listening = true
    window.addEventListener('resize', () => {
      cancelAnimationFrame(M.frame)
      M.frame = requestAnimationFrame(() => { renderDisc(); renderCube() })
    })
  }

  /** 数据签名:变了才重画/重建 DOM(上游「只在有变化时重画」的等价物)。 */
  function sigOf (data) {
    try {
      const d = (data && typeof data === 'object') ? data : {}
      return JSON.stringify([d.at === undefined ? null : d.at, d.pad, d.ipc && d.ipc.role, d.ipc && d.ipc.region,
        d.complementPointA ?? null, d.ipc && d.ipc.complementPoint, d.ipc && d.ipc.antiComplementPoint,
        d.union, d.gate, d.bridgeErr, d.sPad, d.sIpc, d.dominant ?? null, d.dSource, d.degraded,
        d.ipcAvailable, d.missing, Array.isArray(d.history) ? d.history.length : 0,
        Array.isArray(d.history) ? d.history[d.history.length - 1] : null, d.error])
    } catch { return String(Date.now()) }
  }

  function card (title, lines) {
    const box = el('div', 'stat')
    box.appendChild(el('div', 'hint', title))
    for (const line of lines) box.appendChild(el('div', null, line))
    return box
  }

  /** 工具行:三个 chips(轨迹 / 锚点 / 理想位)+ 两个 Help 气泡(拍板 D11)。 */
  function toolsRow () {
    const row = el('div', 'es-tools')
    row.appendChild(chip('轨迹', M.show.trail, () => { M.show.trail = !M.show.trail; repaintChips(row); renderDisc() }))
    row.appendChild(chip('锚点', M.show.anchors, () => { M.show.anchors = !M.show.anchors; repaintChips(row); renderDisc() }))
    row.appendChild(chip('理想位', M.show.ideal, () => { M.show.ideal = !M.show.ideal; repaintChips(row); renderDisc() }))
    row.appendChild(el('span', 'es-note', '说明:'))
    row.appendChild(helpBubble(AXIS_HELP.trail))
    row.appendChild(el('span', 'es-note', '轨迹 ·'))
    row.appendChild(helpBubble(AXIS_HELP.anchors))
    row.appendChild(el('span', 'es-note', '锚点 ·'))
    row.appendChild(helpBubble(AXIS_HELP.ideal))
    row.appendChild(el('span', 'es-note', '理想位 ·'))
    row.appendChild(helpBubble(AXIS_HELP.metrics))
    row.appendChild(el('span', 'es-note', '关系向量'))
    return row
  }

  function repaintChips (row) {
    const btns = row.querySelectorAll('.es-chip')
    const flags = [M.show.trail, M.show.anchors, M.show.ideal]
    for (let i = 0; i < btns.length && i < flags.length; i += 1) {
      btns[i].setAttribute('data-on', flags[i] ? 'true' : 'false')
    }
  }

  /** 图例(上游四条;用户那条如实标「未接入」)。 */
  /** 圆盘图例(2026-10-07 MVP-3 M5:有 `other` 就不再写"未接入")。 */
  function legend (data) {
    const box = el('div', 'es-legend')
    const item = (color, text, dim) => {
      const s = el('span')
      const i = el('i')
      i.style.background = color
      if (dim === true) i.style.opacity = '0.4'
      s.appendChild(i)
      s.appendChild(el('span', null, text))
      if (dim === true) s.style.opacity = '0.55'
      return s
    }
    box.appendChild(item('#ffd678', '角色'))
    const hasOther = Boolean(data && data.ipc && data.ipc.other
      && num(data.ipc.other.a) !== null && num(data.ipc.other.c) !== null)
    box.appendChild(item('#78cdeb', hasOther ? '用户(她读到的你)' : '用户(角色解读)—— 未接入', !hasOther))
    box.appendChild(item('#7fd4a8', '互补位'))
    box.appendChild(item('#f0a35e', '对立位'))
    return box
  }

  /** 重建整页 DOM(圆盘 → chips → 图例 → 三张卡 → 逐轮 → 原始 JSON)。 */
  function paint (root, data) {
    M.root = root
    root.textContent = ''
    injectCss()
    listenResize()

    const wrap = el('div', 'es-root')
    root.appendChild(wrap)
    wrap.appendChild(el('p', 'hint',
      '联合空间读数(只读):圆的半径 = 姿态强度,八个扇区 = 上游八个分仪,金字 = 角色此刻的姿态;'
      + '虚线两圈 = 互补位 / 对立位。逐轮表与下面的数字用的是库里真实的审计行、按当前面板参数现算。'))

    // ---- 圆盘舞台(上游的 stage + canvas + badge + hint)
    const stage = el('div', 'es-stage')
    const canvas = el('canvas')
    stage.appendChild(canvas)
    const ipc = (data && data.ipc && typeof data.ipc === 'object') ? data.ipc : {}
    const region = (ipc.region && typeof ipc.region === 'object') ? ipc.region : null
    const badge = el('div', 'es-badge')
    const subject = el('div', 'es-note es-subject')
    subject.appendChild(el('b', null, '角色'))
    badge.appendChild(subject)
    const stateline = el('div', 'es-note es-stateline')
    stateline.appendChild(el('span', 'es-pattern', region === null || !region.label ? '—' : String(region.label)))
    stateline.appendChild(helpBubble(AXIS_HELP.word))
    badge.appendChild(stateline)
    badge.appendChild(el('div', 'es-note',
      ipc.role && num(ipc.role.a) !== null
        ? '主导 ' + f2(ipc.role.a) + ' · 亲近 ' + f2(ipc.role.c)
          + (region !== null && region.angle !== undefined ? ' · 方位 ' + f1(region.angle) + '°' : '')
        : '还没有姿态读数'))
    // 2026-10-07 MVP-3 M1:有数就给一句短的(互补 / 分离角 / 关系类型),没数才说缺席
    badge.appendChild(el('div', 'es-note', metricBadgeText(ipc)))
    stage.appendChild(badge)
    stage.appendChild(el('div', 'es-hint', '圆盘半径 = 态度强度;两个虚线圈是「互补位」与「对立位」'))
    wrap.appendChild(stage)
    M.stage = stage
    M.canvas = canvas

    // ---- ④ PAD 立方体舞台(与圆盘同页、同一份数据)
    const unit = padUnitOf(data && data.pad)
    const dSource = String((data && data.pad && data.pad.dSource) ?? '')
    const cubeStage = el('div', 'es-stage es-stage-cube')
    const cubeCanvas = el('canvas')
    cubeStage.appendChild(cubeCanvas)
    const cubeBadge = el('div', 'es-badge')
    cubeBadge.appendChild(el('div', 'es-note es-subject', 'PAD · 当前'))
    cubeBadge.appendChild(el('div', 'es-note es-stateline', 'P ' + f2(unit.p) + ' · A ' + f2(unit.a) + ' · D ' + f2(unit.d)))
    cubeBadge.appendChild(el('div', 'es-note',
      '支配来源:' + (SOURCE_ZH[dSource] || SOURCE_ZH[''])
        + (Array.isArray(data && data.pad && data.pad.missing) && data.pad.missing.length > 0
          ? ' · 缺维:' + data.pad.missing.join('、') : '')))
    cubeStage.appendChild(cubeBadge)
    const cubeHint = el('div', 'es-hint', '拖拽旋转 · 双击' + (M.spin ? '停止' : '开始') + '自转')
    cubeStage.appendChild(cubeHint)
    wrap.appendChild(cubeStage)
    M.cubeStage = cubeStage
    M.cubeCanvas = cubeCanvas
    M.cubeHint = cubeHint

    // 拖拽旋转(上游 549-566 原式;俯仰夹 ±1.45 弧度,水平/垂直系数 0.008)
    cubeCanvas.addEventListener('pointerdown', (event) => {
      M.drag = { x: event.clientX, y: event.clientY, yaw: M.yaw, pitch: M.pitch }
      // 上游是 `setPointerCapture?.()`;这里再包一层 try:合成事件(测试/自动化)没有真实
      // pointerId,捕获会抛 NotFoundError —— 抛出去会打断拖拽回调。
      try { cubeCanvas.setPointerCapture?.(event.pointerId) } catch { /* 合成事件,忽略 */ }
    })
    cubeCanvas.addEventListener('pointermove', (event) => {
      const drag = M.drag
      if (drag === null) return
      M.yaw = dragYaw(drag.yaw, event.clientX - drag.x)
      M.pitch = dragPitch(drag.pitch, event.clientY - drag.y)
      renderCube()
    })
    const endDrag = (event) => {
      M.drag = null
      try { cubeCanvas.releasePointerCapture?.(event.pointerId) } catch { /* 同上 */ }
    }
    cubeCanvas.addEventListener('pointerup', endDrag)
    cubeCanvas.addEventListener('pointercancel', endDrag)
    // 双击开关自转(上游 620;提示字跟着翻)
    cubeCanvas.addEventListener('dblclick', () => {
      M.spin = !M.spin
      cubeHint.textContent = '拖拽旋转 · 双击' + (M.spin ? '停止' : '开始') + '自转'
    })

    wrap.appendChild(toolsRow())
    wrap.appendChild(legend(data))

    // 立方体的图例(上游四条;2026-10-07:基线接上了就不再写"未接入";
    // 「词表锚点」那条**删掉** —— D3 拍板 ⑨ 已主动不提供那份目录,列它等于
    // 把"我们砍掉的"说成"上游功能缺",而且它永远亮不起来)
    const baseInfo = baselineTextOf(data)
    const cubeLegend = el('div', 'es-legend')
    for (const [color, text, dim] of [
      ['#ffe08a', '当前 PAD', false],
      ['#ffd678', '历史轨迹(最多 40 轮)', false],
      ['rgba(210,210,210,0.85)', baseInfo.dim ? baseInfo.text : baseInfo.text + ' · 虚线 = 偏离', baseInfo.dim]
    ]) {
      const s = el('span')
      const i = el('i')
      i.style.background = color
      if (dim) { i.style.opacity = '0.4'; s.style.opacity = '0.55' }
      s.appendChild(i)
      s.appendChild(el('span', null, text))
      cubeLegend.appendChild(s)
    }
    wrap.appendChild(cubeLegend)

    // ---- ② 的三张卡 + 逐轮表 + 原始 JSON(本步不改内容)
    const s = summaryOf(data)
    wrap.appendChild(el('div', 'hint', s.state))
    for (const w of s.warn) {
      const n = el('div', 'note', '⚠ ' + w)
      n.style.color = '#f59e0b'
      wrap.appendChild(n)
    }

    const grid = el('div', 'stat-grid')
    grid.appendChild(card('情感侧(PAD)', s.pad))
    grid.appendChild(card('联合空间(共享轴)', s.union))
    grid.appendChild(card('IPC 侧(姿态与几何)', s.ipc))
    // 2026-10-07 MVP-3 M2:两把尺子的差(只记账,不回写任何坐标)
    grid.appendChild(card('两把尺子的差(只记账)', s.residual))
    // ②(2026-10-05):heart-tts 的 `<emo>` 是"这句话怎么念",和上面三张卡(她什么感受)
    // 不同层 —— 单独一张卡,并写明这是**现算**(不是当时注入的原文)。
    grid.appendChild(card('语气候选(<emo> 朗读语气)', s.style))
    wrap.appendChild(grid)

    const rows = historyRows(data)
    if (rows.length === 0) {
      wrap.appendChild(el('div', 'note', '还没有带情绪向量的审计行 —— 每轮反思落库之后这里就会长出来。'))
    } else {
      wrap.appendChild(el('div', 'hint', '逐轮(旧 → 新,门禁用当前面板参数现算):'))
      for (const r of rows) {
        const line = el('div', 'kv')
        const dot = el('b', null, '●')
        dot.style.color = GATE_COLOR[r.gate] || GATE_COLOR.unknown
        line.appendChild(dot)
        line.appendChild(el('span', null, ' #' + r.index + ' ' + r.when))
        line.appendChild(el('span', null, ' · 强度 ' + f1(r.moodIntensity)))
        line.appendChild(el('span', null, ' · pad ' + f1(r.p) + '/' + f1(r.a) + '/' + f1(r.d)))
        line.appendChild(el('span', null, ' · s ' + f2(r.s) + '(' + f2(r.sPad) + '↔' + f2(r.sIpc) + ')'))
        line.appendChild(el('span', null, ' · 残差 ' + f2(r.bridgeErr) + ' · ' + dirZh(r.direction)))
        if (r.userEmotion) line.appendChild(el('span', null, ' · ' + String(r.userEmotion)))
        wrap.appendChild(line)
      }
    }

    const det = el('details')
    det.appendChild(el('summary', 'dim', '原始 JSON(端点原文,未加工)'))
    const pre = el('pre', 'sec-text')
    try { pre.textContent = JSON.stringify(data, null, 2) } catch { pre.textContent = '(无法序列化)' }
    det.appendChild(pre)
    wrap.appendChild(det)

    wrap.appendChild(el('div', 'note', '本页只读,不设任何写状态通路(上游的「情绪功能开关」与 POST /state 一律不搬)。'))

    renderDisc()
    renderCube()
    ensureSpinLoop()
  }

  function draw (root, api) {
    if (root === null || root === undefined) return Promise.resolve(null)
    if (M.data === null && M.error === '') {
      root.textContent = ''
      root.appendChild(el('div', 'note', '加载中…'))
    }
    return Promise.resolve()
      .then(() => api.get(PATH + '?limit=40'))
      .then((data) => {
        M.anchors = (data && data.ipc && Array.isArray(data.ipc.anchors)) ? data.ipc.anchors : []
        const sig = sigOf(data)
        if (sig === M.sig && M.canvas !== null && M.canvas.isConnected) { renderDisc(); return null }
        M.sig = sig
        M.data = data
        M.error = ''
        paint(root, data)
        return null
      })
      .catch((err) => {
        const text = (err && err.message) || String(err)
        if (M.error === text) return null
        M.error = text
        M.data = null
        if (root !== null && root !== undefined) {
          root.textContent = ''
          root.appendChild(el('div', 'note', '取数失败:' + text))
        }
        return null
      })
  }

  return {
    draw, summaryOf, styleLinesOf, historyRows, trailOf, drawDisc, toScreen, polarToScreen, sectorPath,
    rotate, project, world, FACES, CORNERS, AXES, drawCube, padUnitOf, trailUnitOf, renderCube,
    // 2026-10-07 MVP-3:四个新纯函数也放出来(单测直接驱动,不必去戳 DOM)
    metricsOf, metricLinesOf, metricsNoteOf, metricBadgeText, residualLinesOf, baselineOf, baselineTextOf,
    dragYaw, dragPitch,
    chip, helpBubble, renderDisc, M,
    PATH, DISK_RADIUS, GATE_COLOR, GATE_ZH, SOURCE_ZH, TRAIL_SELF, f1, f2, dirZh, when
  }
})()
