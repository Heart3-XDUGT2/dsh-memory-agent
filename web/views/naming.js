/* Echo 配置中心 — ④ 称呼与显示页(id = 'naming')
 * ============================================================
 * 三块,全都读写**同一个画像文件**、同一条写路(契约 §3.1 / §4):
 *   ① 昵称正则生成器 → `nicknamePatterns`
 *      从画像里的 userName / userAliases 派生一组「旧信封前缀」规则
 *      (可选的【…】前缀 + 名字 + 「说:」,名字进捕获组)。名字里的正则符号
 *      先转义再拼 —— `a+b`、`(x)` 这种叫法不许把正则拼崩(app.js 的 reEsc 同款)。
 *   ② UI 索引前缀 → `uiIndexPrefix`(字符串;空 = 用默认「对」)
 *      用途:情绪向量标题那类「对XX」。
 *   ③ 兜底称呼 → `fallbackAddress`(字符串;空 = 用中性「用户」)
 *      用途:面板拿不到名字时显示什么。
 *
 * 纪律(与 web/audit-view.js 同款):classic script(不带模块语法);
 * `draw(el, api)` 运行时自建 DOM 且**幂等**(重画前先清空);取数只走 api;
 * 页面里**不出现 fetch**、不出现文件系统路径。纯逻辑挂在 `.pure` 上给单测。
 */
globalThis.EchoViews = globalThis.EchoViews || {}
// 走 globalThis 而不是裸 EchoViews:浏览器里两者等价,但单测是用
// `new Function('globalThis', src)` 的沙箱跑的(见 tests/config-naming.test.js),
// 那里没有真实全局作用域,裸名会 ReferenceError。
globalThis.EchoViews['naming'] = (function () {
  'use strict'

  /** 唯一读写的 API 路径 —— 本页不许出现别的数据文件。 */
  const PROFILE_PATH = '/api/echo/data/profile.json'
  /** 画像类的生效文案(契约 §4,别页不许自创)。 */
  const EFFECTIVE_TEXT = '已生效,刷新页面看界面'
  /** UI 索引前缀的默认值(填空时程序用它)。 */
  const DEFAULT_UI_PREFIX = '对'
  /** 兜底称呼的默认值(填空时程序用它)。 */
  const DEFAULT_FALLBACK = '用户'

  // ------------------------------------------------------------------
  // 纯逻辑(零 DOM、零 io)—— 单测直接吃这几个
  // ------------------------------------------------------------------

  /** 收字符串:不是字符串/只有空白 ⇒ ''。 */
  function str (v) {
    return typeof v === 'string' ? v.trim() : ''
  }

  /** 正则转义:名字里可能有 `.` `+` `(` 这类字符,直接拼进正则会变味。 */
  function reEsc (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

  /** 去重(保序;老写法,不依赖新语法)。 */
  function dedup (list) {
    const out = []
    for (const x of list) if (out.indexOf(x) === -1) out.push(x)
    return out
  }

  /** 他的称呼集合:userName 在前、userAliases 跟上;去空、去重(与 app.js 的 masterNames 同口径)。 */
  function nameList (profile) {
    const p = (profile !== null && typeof profile === 'object' && !Array.isArray(profile)) ? profile : {}
    const aliases = Array.isArray(p.userAliases) ? p.userAliases : []
    const out = []
    const push = (v) => { const s = str(v); if (s !== '') out.push(s) }
    push(p.userName)
    for (const a of aliases) push(a)
    return dedup(out)
  }

  /** 一个名字 → 一条「旧信封前缀」规则:可选【…】前缀,名字进捕获组,后接「说:」。 */
  function patternFor (name) {
    return '^(?:【[^】]*】\\s*)?(' + reEsc(name) + ')说[:：]\\s*'
  }

  /** 从画像派生一组规则(空名字被过滤,顺序 = userName、别名…,已去重)。 */
  function generatePatterns (profile) {
    return nameList(profile).map(patternFor)
  }

  /** 手改的一行:去空白;能编译才算数,编译不过回 null(调用方内联报错,别抛)。 */
  function sanitizePattern (v) {
    const s = str(v)
    if (s === '') return null
    try {
      new RegExp(s) // eslint-disable-line no-new
      return s
    } catch (e) {
      return null
    }
  }

  /** 列表归一:去空 / 修边 / 去重 / 揪出编译不过的行 ⇒ { ok, bad }。 */
  function normalizePatterns (list) {
    const ok = []
    const bad = []
    const arr = Array.isArray(list) ? list : []
    for (const item of arr) {
      const s = str(item)
      if (s === '') continue
      if (sanitizePattern(s) === null) { bad.push(s); continue }
      if (ok.indexOf(s) === -1) ok.push(s)
    }
    return { ok: ok, bad: bad }
  }

  /**
   * 组装要 PUT 的**完整**画像对象:
   * 原有字段一个不丢(含 nicknameStrict / updatedAt 这类本页不管的),
   * 只覆盖 nicknamePatterns / uiIndexPrefix / fallbackAddress。
   */
  function mergeNamingPayload (raw, edit) {
    const base = (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
    const e = (edit !== null && typeof edit === 'object' && !Array.isArray(edit)) ? edit : {}
    const out = {}
    for (const k of Object.keys(base)) out[k] = base[k]
    out.nicknamePatterns = normalizePatterns(e.nicknamePatterns).ok
    out.uiIndexPrefix = str(e.uiIndexPrefix)
    out.fallbackAddress = str(e.fallbackAddress)
    return out
  }

  // ------------------------------------------------------------------
  // DOM(draw 里自建;页面壳里不写这几个节点)
  // ------------------------------------------------------------------

  function node (tag, cls, text) {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }

  function clearNode (n) { while (n.firstChild) n.removeChild(n.firstChild) }

  function flex (n, dir) {
    n.style.display = 'flex'
    n.style.flexDirection = dir || 'column'
    n.style.gap = '6px'
    return n
  }

  /** 一张卡:标题 + 说明 + 内容体(body 由调用方填)。 */
  function card (title, hint) {
    const box = node('div', 'card')
    box.appendChild(node('div', null, title)).style.fontWeight = '600'
    if (hint) box.appendChild(node('div', 'hint', hint))
    const body = node('div', null)
    body.style.marginTop = '8px'
    box.appendChild(body)
    return { box: box, body: body }
  }

  function textInput (value, placeholder) {
    const i = node('input', 'inp')
    i.type = 'text'
    i.value = value || ''
    i.placeholder = placeholder || ''
    i.spellcheck = false
    i.style.width = '100%'
    i.style.boxSizing = 'border-box'
    return i
  }

  function btn (text, onClick) {
    const b = node('button', 'btn', text)
    b.type = 'button'
    b.addEventListener('click', onClick)
    return b
  }

  /** 失败时把 err.payload 收成一行人话(内联显示,**不用 alert**)。 */
  function errText (payload) {
    if (payload !== null && typeof payload === 'object') {
      if (Array.isArray(payload.errors) && payload.errors.length > 0) return payload.errors.join('；')
      if (typeof payload.error === 'string' && payload.error !== '') return payload.error
    }
    return '保存失败 —— 看看服务端日志,或刷新页面重试'
  }

  /** 页内报错框(`<div class="hint err">`)。 */
  function errBox () {
    const b = node('div', 'hint err')
    b.style.display = 'none'
    return b
  }

  // ------------------------------------------------------------------
  // 页面
  // ------------------------------------------------------------------

  function paint (el, api, raw) {
    clearNode(el)
    let rawValue = raw
    const rows = []

    // ① 昵称正则生成器
    const c1 = card('昵称正则生成器',
      '一行一条「旧信封前缀」规则:可选【…】前缀 + 名字 + 「说:」,名字进捕获组。名字里的正则符号会自动转义;手改的行也要能编译才存得下。')
    const list = flex(node('div', null))
    c1.body.appendChild(list)

    function rowNode (value) {
      const line = flex(node('div', null), 'row')
      const input = textInput(value, '^…说[:：]')
      input.style.flex = '1'
      input.style.minWidth = '0'
      const del = btn('删', () => {
        const i = rows.indexOf(input)
        if (i !== -1) rows.splice(i, 1)
        if (line.parentNode === list) list.removeChild(line)
      })
      rows.push(input)
      line.appendChild(input)
      line.appendChild(del)
      list.appendChild(line)
      return input
    }

    function setRows (patterns) {
      clearNode(list)
      rows.length = 0
      for (const p of patterns) rowNode(p)
    }

    setRows(normalizePatterns(rawValue && rawValue.nicknamePatterns).ok)

    // 「从画像生成」:读画像 → **填进列表**(不直接保存,让他过一眼再点保存)
    function genFrom (value) { setRows(generatePatterns(value)) }
    const actions = flex(node('div', null), 'row')
    actions.style.marginTop = '8px'
    actions.appendChild(btn('从画像生成', () => {
      api.get(PROFILE_PATH).then(
        (res) => {
          rawValue = (res && res.value) || rawValue
          genFrom(rawValue)
        },
        () => { genFrom(rawValue) } // 读不动就用手上这份(同一次读来的)
      )
    }))
    actions.appendChild(btn('+ 一行', () => rowNode('')))
    c1.body.appendChild(actions)

    // ② UI 索引前缀
    const c2 = card('UI 索引前缀',
      '情绪向量标题那类「' + DEFAULT_UI_PREFIX + 'XX」用的前缀;留空就用默认「' + DEFAULT_UI_PREFIX + '」。')
    const pre = textInput(str(rawValue && rawValue.uiIndexPrefix), DEFAULT_UI_PREFIX)
    c2.body.appendChild(pre)

    // ③ 兜底称呼
    const c3 = card('兜底称呼',
      '面板拿不到名字时显示什么;留空就用中性「' + DEFAULT_FALLBACK + '」。')
    const fb = textInput(str(rawValue && rawValue.fallbackAddress), DEFAULT_FALLBACK)
    c3.body.appendChild(fb)

    const err = errBox()
    const save = btn('保存', () => {
      const norm = normalizePatterns(rows.map((r) => r.value))
      if (norm.bad.length > 0) {
        err.textContent = '这些行还不是能用的正则:' + norm.bad.join(' / ')
        err.style.display = ''
        return
      }
      const payload = mergeNamingPayload(rawValue, {
        nicknamePatterns: norm.ok, uiIndexPrefix: pre.value, fallbackAddress: fb.value
      })
      api.put(PROFILE_PATH, payload).then(
        () => {
          err.style.display = 'none'
          api.toast(EFFECTIVE_TEXT, 'ok')
          api.reload()
        },
        (e) => {
          err.textContent = errText(e && e.payload)
          err.style.display = ''
        }
      )
    })
    const foot = flex(node('div', null), 'row')
    foot.style.marginTop = '12px'
    foot.appendChild(save)
    foot.appendChild(node('div', 'hint', '保存后:' + EFFECTIVE_TEXT))

    el.appendChild(c1.box)
    el.appendChild(c2.box)
    el.appendChild(c3.box)
    el.appendChild(err)
    el.appendChild(foot)
  }

  /** 只画 DOM,数据全靠 api。**幂等**:每次先清空自己那块。 */
  function draw (el, api) {
    clearNode(el)
    const status = node('div', 'hint', '正在读画像…')
    el.appendChild(status)
    api.get(PROFILE_PATH).then(
      (res) => { paint(el, api, (res && res.value) ? res.value : null) },
      () => { status.textContent = '读不到画像 —— 刷新页面再试(端点可能还没就绪)' }
    )
  }

  return {
    draw: draw,
    pure: {
      str: str, reEsc: reEsc, dedup: dedup, nameList: nameList,
      patternFor: patternFor, generatePatterns: generatePatterns,
      sanitizePattern: sanitizePattern, normalizePatterns: normalizePatterns,
      mergeNamingPayload: mergeNamingPayload, errText: errText
    }
  }
})()
