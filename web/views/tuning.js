/* Echo 配置中心 ⑥ 图论与显示调参页 —— `web/views/tuning.js`
 * ============================================================
 * P2「配置中心」B3:这一页管图论打分与图谱显示的**可调刻度**。
 *
 * 五块(契约 §4.1 + lib/data-schema.js 的 graph SPEC):
 *   · `weights` / `thresholds` / `windows` / `relations` —— 纯**键值编辑器**:
 *     键集**不写死**,盘上有什么键就铺什么行;一行 = 键 + 值 + 「删」,
 *     底部有「+ 加一项」。文件是空的(⑧ 页体检实测 `graph.json` 是空文件)
 *     也**不是报错** —— 空表 + 提示「还没有值,填一个就是第一个」。
 *   · `display` —— 图谱页的显示调参,一行一项;每行尾注出 `web/graph.html` 里
 *     **现行的硬编码值**(标了行号),让他一眼看见改之前是什么。
 *
 * 纪律(契约 §3.1):
 *   · classic script:没有模块语法,末尾只往 `EchoViews['tuning']` 上挂东西;
 *   · 取数只走注入的 `api`:读 `GET /api/echo/data/graph.json`,写
 *     `PUT /api/echo/data/graph.json`(完整对象 —— 未管字段一个都不丢);
 *     这一份文件里既不直连网络、也不出现任何文件系统路径;
 *   · 保存成功:`api.toast('下次引擎调用生效', 'ok')` → `api.reload()`;
 *     校验失败:`err.payload.errors[]` 内联显示在 `.hint.err` 里,不弹窗。
 *
 * 整块包在 IIFE 里:视图文件都在同一张页面里当普通脚本跑,顶层 `const`
 * 是**共享**的词法环境 —— 不包起来,两个页面文件同名一个变量就整页报错。
 */
globalThis.EchoViews = globalThis.EchoViews || {}
// 走 `globalThis.EchoViews[...]` 而不是裸名:浏览器里两者等价,但单测是用
// `new Function('globalThis', src)` 的沙箱跑的(见 tests/config-tuning.test.js),
// 那里没有真实全局作用域,裸名会 ReferenceError。
globalThis.EchoViews['tuning'] = (function () {
  'use strict'

  /** 读写 `graph.json` 的唯一两条路(唯一写路,契约 §1)。 */
  const DATA_PATH = '/api/echo/data/graph.json'

  /**
   * 生效文案(契约 §4 冻结,不许自创):`lib/data-write.js` 的 EFFECTIVE_BY_FILE
   * 把 `graph.json` 定成 `next-engine-call` ⇒ 用「下次引擎调用生效」那一句。
   */
  const EFFECTIVE_TEXT = '下次引擎调用生效'

  /** 记账版本(契约 §3.1:写入时钉 `schemaRev:1`)。 */
  const SCHEMA_REV = 1

  /** 本页管的五块;其余顶层字段(含 `schemaRev` / `updatedAt`)原样保留。 */
  const MANAGED = ['weights', 'thresholds', 'windows', 'relations', 'display']

  /** 键值编辑器的四块(标题 + 说明;顺序即页面顺序)。 */
  const BLOCKS = [
    {
      key: 'weights',
      title: 'weights —— 打分权重',
      hint: '每类线索在打分里的权重(乘数)。值可以带小数,例如 1.2。'
    },
    {
      key: 'thresholds',
      title: 'thresholds —— 判定阈值',
      hint: '过线才算的分值门槛(话题 / 悬置话题 / 记忆 / 状态模糊 / 已遗忘)。'
    },
    {
      key: 'windows',
      title: 'windows —— 时间窗',
      hint: '候选窗口与冷却时间(小时 / 分钟),单位照键名走。'
    },
    {
      key: 'relations',
      title: 'relations —— 谓词 / 关系表',
      hint: '关系判定表。值是数组或对象时,用 JSON 写(例如 ["是","属于"]);写不动的 JSON 会原样当字符串存,但校验可能不认。'
    }
  ]

  /**
   * `display` 的每一行(键集来自 graph SPEC,是**冻结**的)。
   * `line` = `web/graph.html` 里那个常量所在行;`cur` = 现行硬编码值 —— 行尾照抄给他看。
   * 这些数是读完 graph.html 的 `GRAPH_TUNING` 表逐个对出来的,不是猜的。
   */
  const DISPLAY_FIELDS = [
    { key: 'wMin', label: '权重下限', line: 390, cur: '1' },
    { key: 'wMax', label: '权重上限', line: 391, cur: '10' },
    { key: 'radiusBase', label: '半径基数(px)', line: 399, cur: '4.5' },
    { key: 'radiusScale', label: '半径系数(px)', line: 399, cur: '8.5' },
    { key: 'edgeWidthMin', label: '边宽下限(px)', line: 404, cur: '0.6' },
    { key: 'edgeWidthMax', label: '边宽上限(px)', line: 404, cur: '1.5' },
    { key: 'flowSlowSec', label: '流动最慢(s)', line: 410, cur: '3.4' },
    { key: 'flowFastSec', label: '流动最快(s)', line: 410, cur: '1.6' },
    { key: 'enterDelayMaxMs', label: '入场延迟上限(ms)', line: 412, cur: '320' }
  ]

  /* ── 纯逻辑(零 DOM、零 io;测试直接拿去用) ───────────────────── */

  /** 纯对象判定(数组不算;`null` 不算)。 */
  function isObj (v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

  /** 值 → 编辑框里的文本:标量直写,数组 / 对象走 JSON(读不回来也给个字符串)。 */
  function valText (v) {
    if (v === null || v === undefined) return ''
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    try { return JSON.stringify(v) } catch (e) { return String(v) }
  }

  /**
   * 编辑框文本(或原值)→ 落盘值:
   * 布尔 / 数字 / 数组 / 对象**原样过**;文本先 trim ——
   * 空 ⇒ 空串;`[` / `{` 开头 ⇒ 试 JSON.parse;**纯数字形状 ⇒ 数字**(权重/阈值要的是数);其余当字符串。
   */
  function coerce (v) {
    if (typeof v === 'boolean' || typeof v === 'number') return v
    if (v === null || v === undefined) return ''
    if (typeof v === 'object') return v
    const s = String(v).trim()
    if (s === '') return ''
    const head = s.charAt(0)
    if (head === '[' || head === '{') {
      try { return JSON.parse(s) } catch (e) { return s }
    }
    if (NUM_RE.test(s)) return Number(s)
    return s
  }

  /** 数字形状(整数 / 小数 / 科学计数)。 */
  const NUM_RE = /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/

  /** 盘上那块的键值对 → 行数组(顺序照盘上 Object.keys 的次序;空 / 坏 ⇒ 空表)。 */
  function kvRows (obj) {
    const src = isObj(obj) ? obj : {}
    const rows = []
    for (const key of Object.keys(src)) rows.push({ key: key, value: src[key] })
    return rows
  }

  /** 行数组 → 对象:键 trim、空键丢掉;**同键后者覆盖前者**;值过 `coerce`。 */
  function rowsToObj (rows) {
    const out = {}
    for (const r of (Array.isArray(rows) ? rows : [])) {
      if (r === null || typeof r !== 'object') continue
      const key = (r.key === null || r.key === undefined) ? '' : String(r.key).trim()
      if (key === '') continue
      out[key] = coerce(r.value)
    }
    return out
  }

  /** 文本 → 数字或 `null`:空串 / 非数字形状 / 布尔 ⇒ `null`(不猜)。 */
  function numOrNull (v) {
    if (v === null || v === undefined || typeof v === 'boolean') return null
    if (typeof v === 'number') return isFinite(v) ? v : null
    const s = String(v).trim()
    if (s === '' || !NUM_RE.test(s)) return null
    const n = Number(s)
    return isFinite(n) ? n : null
  }

  /** 文本 → 布尔或 `null`:只认 true/false、1/0(数字 0/1 也算);其余 ⇒ `null`。 */
  function boolOrNull (v) {
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return (v === 0) ? false : ((v === 1) ? true : null)
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase()
      if (s === 'true' || s === '1') return true
      if (s === 'false' || s === '0') return false
    }
    return null
  }

  /** 保存失败的错因文本:`err.payload.errors[]` 优先,否则状态码 + 摘要,再否则一句兜底。 */
  function errText (err) {
    const list = (isObj(err) && isObj(err.payload) && Array.isArray(err.payload.errors)) ? err.payload.errors : []
    const joined = list.map(function (x) { return String(x) }).join(' / ')
    if (joined !== '') return joined
    const status = (isObj(err) && err.status !== undefined) ? String(err.status) : ''
    const detail = (isObj(err) && isObj(err.payload) && err.payload.error !== undefined)
      ? String(err.payload.error) : '请稍后重试'
    return '保存失败(' + status + '):' + detail
  }

  /** 读回包 → 盘上那份对象(坏文件 / `exists:false` / 不是对象 ⇒ 空对象打底,永不抛)。 */
  function baseValue (res) {
    const d = isObj(res) ? res : {}
    return isObj(d.value) ? d.value : {}
  }

  /**
   * 盘上原对象 + 五个块的现值 → **PUT 的完整载荷**。
   * 关键:**原对象里未管的顶层字段一个都不丢**;五块被整体覆盖(行删掉 = 键删掉);
   * `schemaRev` 钉 1,`updatedAt` 换新(给了 `now` 就用它 —— 纯函数要可测)。
   * 不改 `original`。
   */
  function mergeGraphPayload (original, blocks, now) {
    const src = isObj(original) ? original : {}
    const out = Object.assign({}, src)
    const b = isObj(blocks) ? blocks : {}
    for (const key of MANAGED) out[key] = isObj(b[key]) ? Object.assign({}, b[key]) : {}
    out.schemaRev = SCHEMA_REV
    out.updatedAt = (typeof now === 'string' && now !== '') ? now : new Date().toISOString()
    return out
  }

  /* ── DOM:小工具 ──────────────────────────────────────────── */

  /** 建一个节点(一律 `textContent`,不拼 HTML —— 不留 XSS 坏习惯)。 */
  function mk (doc, tag, cls, text) {
    const node = doc.createElement(tag)
    if (cls !== undefined && cls !== '') node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }

  /** 输入框当前值(桩 / 真 DOM 都给字符串)。 */
  function valOf (input) {
    return String((input === null || input === undefined || input.value === undefined) ? '' : input.value)
  }

  /** 一行行内排布(键 / 值 / 删 / 说明都在一行里,窄屏自动折)。 */
  function flexRow (doc) {
    const row = mk(doc, 'div', 'cfg-row')
    row.style.display = 'flex'
    row.style.gap = '6px'
    row.style.alignItems = 'center'
    row.style.flexWrap = 'wrap'
    return row
  }

  /** 重画序号:同一个 `el` 上后一次 draw 作废前一次的回包(幂等的另一半)。 */
  const gens = new WeakMap()
  let seq = 0

  /* ── 行编辑器(键值块与 display 块共用) ───────────────────── */

  /**
   * 可增删行的编辑器。`seed` 每项 = `{key, text, bool, fixed, hint}`:
   *   · `bool !== null` ⇒ 这一行是**复选框**(布尔值),否则是文本输入;
   *   · `fixed === true` ⇒ 键不可改(display 的九个固定项),只画成文字;
   *   · `hint` ⇒ 行尾说明文字(display 用它标现行默认与 graph.html 行号)。
   * 返回 `{ collect, box }`:`collect()` 读当前 DOM(先 `sync`),回行数组。
   */
  function makeEditor (doc, seed) {
    const box = mk(doc, 'div', 'cfg-rows')
    const st = { rows: [], keyInputs: [], valInputs: [] }
    for (const s of (Array.isArray(seed) ? seed : [])) {
      st.rows.push({
        key: (s.key === null || s.key === undefined) ? '' : String(s.key),
        text: (s.text === undefined) ? '' : String(s.text),
        bool: (s.bool === undefined) ? null : s.bool,
        fixed: s.fixed === true,
        hint: (s.hint === undefined) ? '' : String(s.hint)
      })
    }

    /** 行 → 编辑框里的值(先收 DOM,行对象原地改 —— 这样 `indexOf` 还认得出)。 */
    function sync () {
      st.rows.forEach(function (r, i) {
        const k = st.keyInputs[i]
        if (k !== null && k !== undefined) r.key = String(valOf(k))
        const v = st.valInputs[i]
        if (r.bool !== null) r.bool = !!(v !== null && v !== undefined && v.checked)
        else r.text = String(valOf(v))
      })
    }

    /** 按 `st.rows` 重建这一块的行(幂等的关键:每次全清重建,不叠)。 */
    function paint () {
      box.textContent = ''
      st.keyInputs = []
      st.valInputs = []
      for (const r of st.rows) {
        const row = flexRow(doc)
        let keyInput = null
        if (r.fixed) {
          row.appendChild(mk(doc, 'span', 'cfg-name', r.key))
        } else {
          keyInput = mk(doc, 'input', 'cfg-input')
          keyInput.type = 'text'
          keyInput.value = r.key
          keyInput.setAttribute('data-key', '1')
          keyInput.style.maxWidth = '180px'
          row.appendChild(keyInput)
        }
        const valInput = mk(doc, 'input', 'cfg-input')
        if (r.bool !== null) {
          valInput.type = 'checkbox'
          valInput.checked = (r.bool === true)
        } else {
          valInput.type = 'text'
          valInput.value = r.text
        }
        valInput.setAttribute('data-value', '1')
        row.appendChild(valInput)
        const del = mk(doc, 'button', 'btn ghost', '删')
        del.type = 'button'
        del.addEventListener('click', function () {
          sync()
          const i = st.rows.indexOf(r)
          if (i >= 0) st.rows.splice(i, 1)
          paint()
        })
        row.appendChild(del)
        if (r.hint !== '') row.appendChild(mk(doc, 'span', 'cfg-hint', r.hint))
        box.appendChild(row)
        st.keyInputs.push(keyInput)
        st.valInputs.push(valInput)
      }
    }

    paint()

    return {
      box: box,
      /** DOM → 行数组(`value` 可能是布尔 —— 复选框那一行)。 */
      collect: function () {
        sync()
        return st.rows.map(function (r) {
          return { key: r.key, value: (r.bool !== null) ? r.bool : r.text }
        })
      },
      /** 加一行空的(键 / 值都留给他填)。 */
      addRow: function () {
        sync()
        st.rows.push({ key: '', text: '', bool: null, fixed: false, hint: '' })
        paint()
      },
      /** 还有几行(测试想看空表也行)。 */
      size: function () { return st.rows.length }
    }
  }

  /**
   * 行数组 → 落盘对象:空键丢;「新填的行没值」也丢(不然九行空白 display 会写成九个空串),
   * 但**盘上原本就有这个键的行照收**(他把值清空 = 有意清空)。
   */
  function collectBlock (rows, origKeys) {
    const keep = []
    for (const r of (Array.isArray(rows) ? rows : [])) {
      if (r === null || typeof r !== 'object') continue
      const key = (r.key === null || r.key === undefined) ? '' : String(r.key).trim()
      if (key === '') continue
      const isBool = (typeof r.value === 'boolean')
      const blank = !isBool && String(r.value === null || r.value === undefined ? '' : r.value).trim() === ''
      if (blank && !origKeys.has(key)) continue
      keep.push({ key: key, value: r.value })
    }
    return rowsToObj(keep)
  }

  /* ── 页面 ───────────────────────────────────────────────── */

  /**
   * 画这一页。`el` = 该页的 `<section>`;`api` = 主控注入(见契约 §3.1)。
   * 幂等:先清空再建;每次 draw 带序号,老回包回来发现序号变了就丢掉。
   */
  function draw (el, api) {
    if (el === null || el === undefined || typeof el.appendChild !== 'function') return
    const myGen = (seq += 1)
    gens.set(el, myGen)
    const stale = function () { return gens.get(el) !== myGen }
    const doc = el.ownerDocument
    el.textContent = ''

    /** 顶部:这一页管什么、改完什么时候生效(不让他猜)。 */
    const intro = mk(doc, 'p', 'hint')
    intro.appendChild(mk(doc, 'b', '', '图论打分 / 图谱显示的可调刻度:'))
    intro.appendChild(mk(doc, 'span', '', ' weights、thresholds、windows、relations 是打分与判定用的键值对'
      + '(键集不写死 —— 盘上有什么键就铺什么行);display 是图谱页的显示参数,'
      + '每行尾注出它在 web/graph.html 里的现行硬编码值与行号。'
      + '改完保存**立刻生效**:下一次页面渲染 / 下一轮挖边就按新值走(引擎进程里的快照下次调用生效)。'))
    el.appendChild(intro)

    const body = mk(doc, 'div', 'tuning-form')
    el.appendChild(body)

    /** 错误槽(内联;契约要求 class 就是 `hint err`)。 */
    const errBox = mk(doc, 'div', 'hint err')
    errBox.style.color = '#ff9a9a'
    errBox.style.display = 'none'
    errBox.textContent = ''

    function showErrors (err) {
      errBox.textContent = (typeof err === 'string') ? err : errText(err)
      errBox.style.display = ''
    }

    /** 四块键值编辑器:先建壳,等回包回来再按盘上的键铺行。 */
    const editors = {}
    for (const meta of BLOCKS) {
      const card = mk(doc, 'div', 'card')
      card.appendChild(mk(doc, 'div', 'cfg-name', meta.title))
      card.appendChild(mk(doc, 'div', 'cfg-hint', meta.hint))
      const slot = mk(doc, 'div', '')
      card.appendChild(slot)
      const add = mk(doc, 'button', 'btn ghost', '+ 加一项')
      add.type = 'button'
      add.addEventListener('click', function () {
        const ed = editors[meta.key]
        if (ed !== undefined && ed.editor !== null) ed.editor.addRow()
      })
      card.appendChild(add)
      body.appendChild(card)
      editors[meta.key] = { meta: meta, slot: slot, editor: null, emptyHint: null }
    }

    /** display 块:九个固定项 + 盘上多出来的键。 */
    const dispCard = mk(doc, 'div', 'card')
    dispCard.appendChild(mk(doc, 'div', 'cfg-name', 'display —— 图谱页显示调参'))
    dispCard.appendChild(mk(doc, 'div', 'cfg-hint', '图谱页(web/graph.html)画图时用的刻度。'
      + '左边是键(不可改),中间是值 —— 数字填数、布尔勾框;行尾「现行默认…」= 页面里写死的那个值。'
      + '留空 = 不写这一项(页面继续用它自己的硬编码默认)。'))
    const dispSlot = mk(doc, 'div', '')
    dispCard.appendChild(dispSlot)
    const dispAdd = mk(doc, 'button', 'btn ghost', '+ 加一项')
    dispAdd.type = 'button'
    dispAdd.addEventListener('click', function () { dispEditor.addRow() })
    dispCard.appendChild(dispAdd)
    body.appendChild(dispCard)

    /** display 的行:固定键 + 现行默认说明;盘上有值的填值,没有的留空。 */
    function displaySeed (value) {
      const d = isObj(value) ? value : {}
      const seed = []
      const used = {}
      for (const f of DISPLAY_FIELDS) {
        used[f.key] = true
        const has = Object.prototype.hasOwnProperty.call(d, f.key)
        seed.push({
          key: f.key,
          text: has ? valText(d[f.key]) : '',
          bool: has && typeof d[f.key] === 'boolean' ? d[f.key] : null,
          fixed: true,
          hint: '现行默认:' + f.cur + '(来自 graph.html:' + f.line + ')'
        })
      }
      for (const key of Object.keys(d)) {
        if (used[key]) continue
        seed.push({
          key: key,
          text: valText(d[key]),
          bool: typeof d[key] === 'boolean' ? d[key] : null,
          fixed: true,
          hint: '现行默认:—(不在 graph.html 的常量表里,原样保留)'
        })
      }
      return seed
    }

    let dispEditor = makeEditor(doc, displaySeed(null))
    dispSlot.appendChild(dispEditor.box)

    /** 盘上的值 → 五块的行(空块 ⇒ 留一行空白 + 提示,绝不报错)。 */
    function fill (value) {
      const v = isObj(value) ? value : {}
      for (const meta of BLOCKS) {
        const ed = editors[meta.key]
        const rows = kvRows(v[meta.key])
        ed.emptyHint = null
        if (rows.length === 0) {
          ed.emptyHint = mk(doc, 'div', 'hint', '还没有值 —— 填一个就是第一个。')
          ed.slot.textContent = ''
          ed.slot.appendChild(ed.emptyHint)
        }
        const seed = (rows.length > 0 ? rows : [{ key: '', value: '' }]).map(function (r) {
          return {
            key: r.key,
            text: valText(r.value),
            bool: typeof r.value === 'boolean' ? r.value : null,
            fixed: false,
            hint: ''
          }
        })
        ed.editor = makeEditor(doc, seed)
        ed.slot.appendChild(ed.editor.box)
      }
      dispSlot.textContent = ''
      dispEditor = makeEditor(doc, displaySeed(v.display))
      dispSlot.appendChild(dispEditor.box)
    }

    /** 盘上那块的键集合(「新填的行没值」判定要它)。 */
    let current = null
    function origKeysOf (blockKey) {
      const v = isObj(current) ? current : {}
      const block = isObj(v[blockKey]) ? v[blockKey] : {}
      return new Set(Object.keys(block))
    }

    /** 五块 + 原对象 → 完整载荷 → PUT(未管字段一个不丢)。 */
    function save () {
      errBox.textContent = ''
      errBox.style.display = 'none'
      if (api === null || typeof api !== 'object' || typeof api.put !== 'function') {
        showErrors({ status: 0, payload: { error: '数据通道还没接上,先别急着存' } })
        return
      }
      const blocks = {}
      for (const meta of BLOCKS) {
        const ed = editors[meta.key]
        blocks[meta.key] = ed.editor === null
          ? {}
          : collectBlock(ed.editor.collect(), origKeysOf(meta.key))
      }
      blocks.display = collectBlock(dispEditor.collect(), origKeysOf('display'))
      const payload = mergeGraphPayload(current, blocks, new Date().toISOString())
      let p
      try {
        p = api.put(DATA_PATH, payload)
      } catch (e) { showErrors(e); return }
      Promise.resolve(p).then(function () {
        if (typeof api.toast === 'function') api.toast(EFFECTIVE_TEXT, 'ok')
        if (typeof api.reload === 'function') api.reload()
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

    // 没有可用 api(单测 / 页面没注入)⇒ 用空对象打底,页面结构照样在。
    if (api === null || typeof api !== 'object' || typeof api.get !== 'function') {
      current = {}
      fill(current)
      return
    }
    let got
    try {
      got = api.get(DATA_PATH)
    } catch (e) { showErrors(e); return }
    Promise.resolve(got).then(function (res) {
      if (stale()) return
      current = baseValue(res)
      fill(current)
    }, function (err) {
      if (stale()) return
      showErrors(err)
    })
  }

  return {
    draw,
    /** 纯逻辑(零 DOM、零 io)—— 单测的入口。 */
    pure: {
      DATA_PATH,
      EFFECTIVE_TEXT,
      SCHEMA_REV,
      MANAGED,
      BLOCKS,
      DISPLAY_FIELDS,
      isObj,
      valText,
      coerce,
      kvRows,
      rowsToObj,
      numOrNull,
      boolOrNull,
      errText,
      baseValue,
      mergeGraphPayload,
      collectBlock
    }
  }
})()
