/* Echo 配置中心 ⑤ 别名与人名页 —— `web/views/aliases.js`
 * ============================================================
 * P2「配置中心」B3:这一页管 `aliases.json` 里的**归一规则** ——
 * 每一条规则回答「谁在说、说的是谁」:一种叫法(别名 `alias`)归到它真正的名字(正名 `canonical`),
 * `tier` 是**确定性等级**(1 = 已经认定 / 2 = 待人工确认),`why` 是给他自己看的理由。
 *
 * 页面结构(契约 §6.2 ⑤):
 *   · 顶端一句说明:这一页管的是"谁在说、说的是谁"的归一;
 *   · `rules[]` **列表编辑器**:每行 alias + canonical + tier(下拉 1/2)+ why + 「删」,底部「+ 加一条」;
 *   · 「从图谱提候选」:读**真图谱端点** `GET /api/echo/graph` 的 `nodes`(节点名),
 *     挑出**还没进 rules 的**名字列成候选,点一下把那一行加进编辑器 ——
 *     **不自动保存**(存不存由他按「保存」决定)。
 *
 * 纪律(契约 §3.1,与 ③ 页 profile.js 同一套写法):
 *   · classic script:没有模块语法,末尾只往 `EchoViews['aliases']` 上挂东西;
 *   · 取数只走注入的 `api`:读 `GET /api/echo/data/aliases.json`、写
 *     `PUT /api/echo/data/aliases.json`(完整对象 —— 未管字段一个都不丢);
 *     候选按钮另读 `GET /api/echo/graph`(只读,不写 —— 这一页只碰 `aliases.json` 一个数据文件);
 *     这一份文件里既不直连网络、也不出现任何文件系统路径;
 *   · 保存成功:`api.toast('下次引擎调用生效', 'ok')` → `api.reload()`
 *     (文案取自契约 §4:`aliases.json` 的 effective = `next-engine-call` ⇒「下次引擎调用生效」);
 *   · 校验失败:`err.payload.errors[]` 内联显示在 `.hint.err` 里,不弹窗。
 *
 * 整块包在 IIFE 里:视图文件都在同一张页面里当普通脚本跑,顶层 `const`
 * 是**共享**的词法环境 —— 不包起来,两个页面文件同名一个变量就整页报错。
 */
globalThis.EchoViews = globalThis.EchoViews || {}
// 走 `globalThis.EchoViews[...]` 而不是裸名:浏览器里两者等价,但单测是用
// `new Function('globalThis', src)` 的沙箱跑的(见 tests/config-aliases.test.js),
// 那里没有真实全局作用域,裸名会 ReferenceError。
globalThis.EchoViews['aliases'] = (function () {
  'use strict'

  /** 读写 `aliases.json` 的唯一两条路(唯一写路,契约 §1)。 */
  const DATA_PATH = '/api/echo/data/aliases.json'

  /**
   * 候选来源:**真图谱端点**(`GET /api/echo/graph`,由 `lib/store.js` 的 `graphData()` 供,
   * 每项形如 `{id, name, type, …}`)。只读 —— 这一页只写 `aliases.json` 一个数据文件。
   */
  const GRAPH_PATH = '/api/echo/graph'

  /** 生效文案(契约 §4:`aliases.json` 的 effective = `next-engine-call`)。 */
  const EFFECTIVE_TEXT = '下次引擎调用生效'

  /** `tier` 的合法取值(下拉就这两个;顺序即下拉顺序)。 */
  const TIERS = [1, 2]

  /* ── 纯逻辑(零 DOM、零 io;测试直接拿去用) ───────────────────── */

  /** 字符串:非字符串(脏值)⇒ `''`;是字符串就 trim。 */
  function strOf (v) { return typeof v === 'string' ? v.trim() : '' }

  /**
   * 确定性等级:`2` / `'2'`(下拉给的是字符串)认成 2;
   * 其余(含非法值 `9`、`'x'`、`undefined`)一律归 **1**(契约 §0 的数据形状里 tier 只能是 1|2)。
   */
  function tierOf (v) {
    const n = (typeof v === 'string') ? Number(v) : v
    return n === 2 ? 2 : 1
  }

  /** 盘上 / 编辑器里的一行(可能是脏的)⇒ 规范行(**只留这四个键**,别的一律不带走)。 */
  function rowFrom (rule) {
    const r = (rule !== null && typeof rule === 'object' && !Array.isArray(rule)) ? rule : {}
    return {
      alias: strOf(r.alias),
      canonical: strOf(r.canonical),
      tier: tierOf(r.tier),
      why: strOf(r.why)
    }
  }

  /** 空行判定:`alias` 与 `canonical` 都空 = 空行(丢掉);半行留着,交给后端报错,不静默吞掉他的话。 */
  function isEmptyRow (row) { return row.alias === '' && row.canonical === '' }

  /**
   * 编辑器里的行 ⇒ PUT 用的 `rules[]`:
   * 逐行规范(trim + `tier` 归位)→ 丢空行 → 去重(同一个 `alias` + `canonical` 只留第一次)。
   * 顺序保持**第一次出现**的位置(他排的顺序就是盘上的顺序)。
   */
  function normalizeRules (list) {
    const out = []
    const seen = {}
    for (const raw of (Array.isArray(list) ? list : [])) {
      const row = rowFrom(raw)
      if (isEmptyRow(row)) continue
      const key = row.alias + '\u0000' + row.canonical
      if (seen[key] === true) continue
      seen[key] = true
      out.push(row)
    }
    return out
  }

  /**
   * 读回包 ⇒ 盘上那份对象。
   * 读得出对象就用它;**读不出**(`exists:false` / 坏文件 / 不是对象)就用**回包给的 `template`**
   * —— 真模板只有回包里的那一份(`lib/data-schema.js` 的 SPECS 是唯一真源),这一页不自己编空模板。
   * 连 `template` 都没有(离线 / 假 api)才退到 `{}`,记账字段(`schemaRev` / `updatedAt`)由保存时补。
   */
  function baseValue (res) {
    const d = (res !== null && typeof res === 'object') ? res : {}
    const v = d.value
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v
    const t = d.template
    if (t !== null && typeof t === 'object' && !Array.isArray(t)) return Object.assign({}, t)
    return {}
  }

  /**
   * 盘上原对象 + 规范后的 rules ⇒ **PUT 的完整载荷**。
   * 关键:原对象里没管的键**一个都不丢**(契约 §1:PUT 收的是完整对象,不是 patch);
   * 只覆盖 `rules[]`,并补 `schemaRev: 1` 与新的 `updatedAt`(新 ISO 时间)。
   * 纯函数:不改 `original`、不改 `rules`。
   */
  function mergeAliasesPayload (original, rules, nowIso) {
    const src = (original !== null && typeof original === 'object' && !Array.isArray(original)) ? original : {}
    const out = Object.assign({}, src)
    out.schemaRev = 1
    out.rules = normalizeRules(rules)
    out.updatedAt = (typeof nowIso === 'string' && nowIso !== '') ? nowIso : new Date().toISOString()
    return out
  }

  /** 一个图谱节点 ⇒ 名字:字符串直接用;对象取 `name`,退 `id`;其余(数字 / 数组 / null)丢掉。 */
  function nodeName (node) {
    if (typeof node === 'string') return node.trim()
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      return strOf(node.name) || strOf(node.id)
    }
    return ''
  }

  /** 图谱回包里的 `nodes`(`GET /api/echo/graph` 的回包就是 `{nodes, edges, layers}`)。 */
  function nodesOf (payload) {
    const p = (payload !== null && typeof payload === 'object') ? payload : {}
    return Array.isArray(p.nodes) ? p.nodes : []
  }

  /**
   * 图谱回包 + 现有 rules ⇒ **还没进 rules 的节点名**(候选列表)。
   * 口径:凡是已经在某条 rule 里当过 `alias`(别名)或 `canonical`(正名)的名字,都算"进过了";
   * 去重、保序;`nodes` 缺失 / 元素脏一律跳过 —— **永不抛**(图谱读不到不是这一页的错误)。
   */
  function candidatesFromGraph (payload, rules) {
    const used = {}
    for (const raw of (Array.isArray(rules) ? rules : [])) {
      const row = rowFrom(raw)
      if (row.alias !== '') used[row.alias] = true
      if (row.canonical !== '') used[row.canonical] = true
    }
    const out = []
    const seen = {}
    for (const node of nodesOf(payload)) {
      const name = nodeName(node)
      if (name === '' || used[name] === true || seen[name] === true) continue
      seen[name] = true
      out.push(name)
    }
    return out
  }

  /**
   * 失败对象 ⇒ 内联文案:优先 `err.payload.errors[]`(后端校验明细),
   * 没有就退到 `保存失败(status):error`;再没有就给一句能看的中文。**永不抛。**
   */
  function errText (err) {
    const e = (err !== null && typeof err === 'object') ? err : {}
    const payload = (e.payload !== null && typeof e.payload === 'object') ? e.payload : {}
    const list = Array.isArray(payload.errors) ? payload.errors : []
    const joined = list.map(function (x) { return String(x) }).join(' / ')
    if (joined !== '') return joined
    const status = (e.status === undefined || e.status === null) ? '' : String(e.status)
    const detail = (payload.error === undefined || payload.error === null) ? '请稍后重试' : String(payload.error)
    return '保存失败(' + status + '):' + detail
  }

  /* ── DOM:小工具 ──────────────────────────────────────────── */

  /** 建一个节点(一律 `textContent`,不拼 HTML —— 不留 XSS 坏习惯)。 */
  function mk (doc, tag, cls, text) {
    const node = doc.createElement(tag)
    if (cls !== undefined && cls !== '') node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }

  /** 输入框 / 下拉当前值(桩与真 DOM 都给字符串)。 */
  function valOf (input) {
    return String((input === null || input === undefined || input.value === undefined) ? '' : input.value)
  }

  /** 重画序号:同一个 `el` 上后一次 draw 作废前一次的回包(幂等的另一半)。 */
  const gens = new WeakMap()
  let seq = 0

  /* ── 页面 ───────────────────────────────────────────────── */

  /**
   * 画这一页。`el` = 该页的 `<section>`;`api` = 主控注入(见契约 §3.1)。
   * 幂等:先清空再建;并且每次 draw 都发一个序号,老回包回来发现序号变了就丢掉。
   */
  function draw (el, api) {
    if (el === null || el === undefined || typeof el.appendChild !== 'function') return
    const myGen = (seq += 1)
    gens.set(el, myGen)
    const stale = function () { return gens.get(el) !== myGen }
    const doc = el.ownerDocument
    el.textContent = ''

    /** 顶端说明:这一页管的是"谁在说、说的是谁"的归一(P1 语义,写死在页面上 —— 他不用猜)。 */
    const intro = mk(doc, 'p', 'hint')
    intro.appendChild(mk(doc, 'b', '', '别名的归一:谁在说、说的是谁'))
    intro.appendChild(mk(doc, 'span', '', ' —— 每一行把一种叫法(别名 alias)归到它真正的名字(正名 canonical);'
      + 'tier 是确定性等级:1 = 已经认定,2 = 待人工确认。'
      + '规则表是**下次引擎调用生效**,不会动图谱里已经落下的节点。'))
    el.appendChild(intro)

    const body = mk(doc, 'div', 'aliases-form')
    el.appendChild(body)

    /** 错误槽(内联;契约要求 class 就是 `hint err`)。 */
    const errBox = mk(doc, 'div', 'hint err')
    errBox.style.color = '#ff9a9a'
    errBox.style.display = 'none'
    errBox.textContent = ''

    function showErrors (err) {
      errBox.textContent = errText(err)
      errBox.style.display = ''
    }

    /** 规则列表:每行 = 一份规范行 + 它那几个控件的引用(`_el`,保存时会被 `rowFrom` 剥掉)。 */
    const listBox = mk(doc, 'div', '')
    body.appendChild(listBox)
    const state = { rows: [] }

    function pushRow (row) {
      const r = rowFrom(row)
      r._el = {}
      state.rows.push(r)
    }

    /** 从 DOM 把值收回状态(增删行之前先同步,免得刚打一半的字丢了)。 */
    function syncRows () {
      for (const row of state.rows) {
        const e = row._el || {}
        row.alias = strOf(valOf(e.alias))
        row.canonical = strOf(valOf(e.canonical))
        row.tier = tierOf(valOf(e.tier))
        row.why = strOf(valOf(e.why))
      }
    }

    /** 画第 i 行(控件是**新建**的,所以删行时按状态里的下标走)。 */
    function paintRow (i) {
      const row = state.rows[i]
      const line = mk(doc, 'div', 'cfg-row')
      line.style.display = 'flex'
      line.style.gap = '6px'
      line.style.alignItems = 'center'

      const alias = mk(doc, 'input', 'cfg-input')
      alias.type = 'text'
      alias.placeholder = '别名(谁在说)'
      alias.value = row.alias
      alias.setAttribute('data-field', 'alias')
      alias.setAttribute('data-row', String(i))

      const canonical = mk(doc, 'input', 'cfg-input')
      canonical.type = 'text'
      canonical.placeholder = '正名(说的是谁)'
      canonical.value = row.canonical
      canonical.setAttribute('data-field', 'canonical')
      canonical.setAttribute('data-row', String(i))

      const tier = mk(doc, 'select', 'cfg-input')
      tier.setAttribute('data-field', 'tier')
      tier.setAttribute('data-row', String(i))
      for (const t of TIERS) {
        const opt = mk(doc, 'option', '', String(t))
        opt.value = String(t)
        tier.appendChild(opt)
      }
      tier.value = String(row.tier)

      const why = mk(doc, 'input', 'cfg-input')
      why.type = 'text'
      why.placeholder = '为什么(可留空)'
      why.value = row.why
      why.setAttribute('data-field', 'why')
      why.setAttribute('data-row', String(i))

      const del = mk(doc, 'button', 'btn ghost', '删')
      del.type = 'button'
      del.setAttribute('data-field', 'del')
      del.addEventListener('click', function () {
        syncRows()
        state.rows.splice(i, 1)
        paintRows()
      })

      line.appendChild(alias)
      line.appendChild(canonical)
      line.appendChild(tier)
      line.appendChild(why)
      line.appendChild(del)
      row._el = { alias: alias, canonical: canonical, tier: tier, why: why }
      listBox.appendChild(line)
    }

    /** 整片重画(顺序 = 状态顺序)。 */
    function paintRows () {
      listBox.textContent = ''
      for (let i = 0; i < state.rows.length; i += 1) paintRow(i)
    }

    /** 表单当前值(先同步 DOM,再交出去)。 */
    function readRows () {
      syncRows()
      return state.rows.slice()
    }

    /** 盘上的值 ⇒ 填进列表(空表也留一行,他可以直接打字)。 */
    let current = null
    function fill (value) {
      current = value
      const rules = normalizeRules((value !== null && typeof value === 'object') ? value.rules : null)
      state.rows = []
      for (const r of rules) pushRow(r)
      if (state.rows.length === 0) pushRow({})
      paintRows()
    }

    /** 工具栏:「+ 加一条」与「从图谱提候选」。 */
    const tools = mk(doc, 'div', 'fw')
    const addBtn = mk(doc, 'button', 'btn ghost', '+ 加一条')
    addBtn.type = 'button'
    addBtn.addEventListener('click', function () {
      syncRows()
      pushRow({})
      paintRows()
    })
    tools.appendChild(addBtn)

    const candBtn = mk(doc, 'button', 'btn ghost', '从图谱提候选')
    candBtn.type = 'button'
    tools.appendChild(candBtn)
    body.appendChild(tools)

    /** 候选区:点一下 = 加一行进编辑器(**不落盘**);`hint cand` 便于测试与样式挂钩。 */
    const candBox = mk(doc, 'div', 'hint cand')
    body.appendChild(candBox)

    let pending = []

    function paintCandidates () {
      candBox.textContent = ''
      if (pending.length === 0) return
      candBox.appendChild(mk(doc, 'span', '', '图谱里的候选(点一下加进规则,不会自动保存):'))
      for (const name of pending) {
        const b = mk(doc, 'button', 'btn ghost', name)
        b.type = 'button'
        b.setAttribute('data-candidate', name)
        b.addEventListener('click', function () {
          syncRows()
          // 候选是图谱里**已经存在的实体名** ⇒ 当正名用;别名留空等他补(或改成别的写法),
          // `why` 记一句来源,免得以后看不出这条是怎么来的。
          pushRow({ alias: '', canonical: name, tier: 1, why: '图谱候选(来自 nodes)' })
          pending = pending.filter(function (x) { return x !== name })
          paintRows()
          paintCandidates()
        })
        candBox.appendChild(b)
      }
    }

    candBtn.addEventListener('click', function () {
      if (api === null || typeof api !== 'object' || typeof api.get !== 'function') {
        candBox.textContent = '数据通道还没接上,先别急着提候选。'
        return
      }
      let got
      try {
        got = api.get(GRAPH_PATH)
      } catch (e) { showErrors(e); return }
      Promise.resolve(got).then(function (res) {
        if (stale()) return
        pending = candidatesFromGraph(res, readRows())
        if (pending.length === 0) {
          // 图谱读到了但没有可用的节点名(空图 / 节点名都进了规则)⇒ 如实说,不装死。
          candBox.textContent = '图谱里没挑出候选:要么节点名都已经进了规则,要么这次没读到图谱节点。'
          return
        }
        paintCandidates()
      }, function (err) { if (!stale()) showErrors(err) })
    })

    /** 保存:完整对象 PUT(未管字段一个不丢)→ 生效文案 → 重画。 */
    function save () {
      errBox.textContent = ''
      errBox.style.display = 'none'
      if (api === null || typeof api !== 'object' || typeof api.put !== 'function') {
        showErrors({ status: 0, payload: { error: '数据通道还没接上,先别急着存' } })
        return
      }
      const payload = mergeAliasesPayload(current, readRows())
      let p
      try {
        p = api.put(DATA_PATH, payload)
      } catch (e) { showErrors(e); return }
      Promise.resolve(p).then(function () {
        api.toast(EFFECTIVE_TEXT, 'ok')
        api.reload()
      }, function (err) { if (!stale()) showErrors(err) })
    }

    const foot = mk(doc, 'div', 'fw')
    const saveBtn = mk(doc, 'button', 'btn', '保存')
    saveBtn.type = 'button'
    saveBtn.addEventListener('click', function () { save() })
    const reloadBtn = mk(doc, 'button', 'btn ghost', '重新载入')
    reloadBtn.type = 'button'
    reloadBtn.addEventListener('click', function () { draw(el, api) })
    foot.appendChild(saveBtn)
    foot.appendChild(reloadBtn)
    el.appendChild(foot)
    el.appendChild(errBox)

    // 没有可用 api(单测 / 页面没注入)⇒ 用空模板打底,页面结构照样在。
    if (api === null || typeof api !== 'object' || typeof api.get !== 'function') {
      fill(baseValue(null))
      return
    }
    let got
    try {
      got = api.get(DATA_PATH)
    } catch (e) { showErrors(e); return }
    Promise.resolve(got).then(function (res) {
      if (stale()) return
      fill(baseValue(res))
    }, function (err) {
      if (stale()) return
      fill(baseValue(null))
      showErrors(err)
    })
  }

  return {
    draw,
    /** 纯逻辑(零 DOM、零 io)—— 单测的入口。 */
    pure: {
      DATA_PATH,
      GRAPH_PATH,
      EFFECTIVE_TEXT,
      TIERS,
      strOf,
      tierOf,
      rowFrom,
      normalizeRules,
      baseValue,
      mergeAliasesPayload,
      nodeName,
      nodesOf,
      candidatesFromGraph,
      errText
    }
  }
})()
