/* Echo 配置中心 ② 人格页 — 前缀/后缀两段自由文本(classic script,运行时自建 DOM)
 * ==================================================================
 * 契约:docs/CONFIG_CENTER_CONTRACT.md
 *   §3 / §3.1  页面协议:classic script、`EchoViews['persona']`、`draw(el, api)` 幂等、
 *              取数与写盘**只走 api**(这一页不许自己发请求)
 *   §4         生效文案 = 「下一轮生效」(persona.json 的 effective = next-turn)
 *   §4.1       ② 人格 = `GET /persona` + `PUT /data/persona.json`(唯一写路)
 *   §2.1       深链 #/persona
 *   §1 表第 2/3 条:读 `/data/persona.json` 拿"原 value"(文件不存在回 {exists:false});
 *              写 = 该文件的**完整**新对象(不是 patch)
 *
 * P1e 之后没有「恢复默认文本」这回事:空 = 空 = 不注入。所以这一页只有两段文本、
 * 一个「恢复为空」、一块预览 —— 默认文本(defaults)只展示用途,不回填。
 *
 * 纪律:这一页不出现任何文件系统路径,也**不直接发请求**(一切走 api);
 * 写盘只有一处字符串:`/api/echo/data/persona.json`。
 *
 * 为什么纯逻辑单独挂出来:页面文件是 classic script,离线测不了 DOM;所以把字数、
 * 预览拼接、提交对象这些判断做成 `pure`(零 DOM、零 io),用
 * `new Function('globalThis', src)(sandbox)` 拿去跑(同 tests/audit-view.test.js)。
 */
globalThis.EchoViews = globalThis.EchoViews || {}

EchoViews['persona'] = (function () {
  'use strict'

  // ── 契约常量(§4 文案表 / §4.1 / §6.2) ──────────────────────────────
  const READ_PATH = '/api/echo/persona'                 // §4.1:GET,只读
  const WRITE_PATH = '/api/echo/data/persona.json'      // §1 表第 3 条:唯一写路
  const TOAST_TEXT = '下一轮生效'                        // §4:persona 的生效文案(不许自创)
  const MAX_FALLBACK = 4000                             // 取不到 maxChars 时的兜底上限(§6.2)
  const EMPTY_NOTE = '(空,不注入)'                      // 空段在预览里的显式写法(§6.2)
  const OVER_COLOR = '#fca5a5'
  const ERR_COLOR = '#fca5a5'
  const BRACE_NOTE = '预览给的是原文 —— 注入系统提示时花括号会被转义(连续的 { 之间插空格,见 escapePromptBraces),真正注入的样子与这里不完全一样。'
  const INTRO_TEXT = '这两个框就是她的人格。空 = 不注入这一段(P1e 之后没有「恢复默认文本」;空就是空)。改完点保存,下一轮对话生效。'
  const CLEARED_HINT = '两个框已清空 —— 空就是不注入;要点「保存」才算数'

  /** 两段在系统提示里的位置(§6.2:前缀段 + 后缀段)。 */
  const SEGMENTS = [
    { key: 'prefix', label: '人格前缀(身份段,挂 order 10245)' },
    { key: 'suffix', label: '人格后缀(铁律 + 说话方式,挂 order 10250)' }
  ]

  // ── 纯逻辑(零 DOM、零 io)─────────────────────────────────────────
  function str (v) {
    return typeof v === 'string' ? v : (v === undefined || v === null ? '' : String(v))
  }

  /** 字数 = **UTF-16 长度**,与 lib/data-schema.js 的 maxLen 校验同一口径
   *  (中文/空白/换行各记一个;服务端也是 `.length`,不一致就会出现"看着没超、保存被拒")。 */
  function countChars (text) {
    return str(text).length
  }

  /** 「N / 4000」里的那一行。 */
  function counterText (count, max) {
    return count + ' / ' + max
  }

  /** 超限判定(上限取不到就用兜底 4000)。 */
  function overLimit (count, max) {
    const cap = Number(max) > 0 ? Number(max) : MAX_FALLBACK
    return count > cap
  }

  /** 从 `GET /persona` 回包里取上限;取不到(字段缺失/非正数)⇒ 4000。 */
  function maxOf (res) {
    const n = res && typeof res === 'object' ? Number(res.maxChars) : NaN
    return Number.isFinite(n) && n > 0 ? n : MAX_FALLBACK
  }

  /** 两段都没超才允许保存(§6.2:超限变红并禁用保存)。 */
  function canSave (fields, max) {
    const f = fields && typeof fields === 'object' ? fields : {}
    return !overLimit(countChars(f.prefix), max) && !overLimit(countChars(f.suffix), max)
  }

  /** 预览:把拼出来的系统提示段摊开;空段显式写「(空,不注入)」。 */
  function buildPreview (prefix, suffix) {
    const src = { prefix: str(prefix), suffix: str(suffix) }
    const segments = SEGMENTS.map(function (s) {
      const text = src[s.key]
      const empty = text === ''
      return {
        key: s.key, label: s.label, text: text, count: countChars(text),
        empty: empty, shown: empty ? EMPTY_NOTE : text, braces: text.indexOf('{') >= 0
      }
    })
    let emptyCount = 0
    let braces = false
    for (const s of segments) {
      if (s.empty) emptyCount += 1
      if (s.braces) braces = true
    }
    const text = segments.map(function (s) {
      return '【' + s.label + '】\n' + s.shown
    }).join('\n\n')
    return { segments: segments, text: text, emptyCount: emptyCount, braces: braces }
  }

  /** 提交对象的底子 = 文件里**原有字段**(读回包可能是 {exists,value},也可能就是对象本身)。 */
  function basePersonaValue (read) {
    if (read === null || typeof read !== 'object' || Array.isArray(read)) return { schemaRev: 1 }
    if (read.exists === false) return { schemaRev: 1 }           // 文件不存在 ⇒ 空对象打底 + schemaRev:1
    const v = read.value
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return Object.assign({}, v)
    if (read.exists === true || read.file !== undefined || read.bytes !== undefined) return { schemaRev: 1 }
    return Object.assign({}, read)
  }

  /** 时间戳:允许传 Date / ISO 串 / 毫秒数(测试要确定性),缺省用当下。 */
  function stampOf (now) {
    if (typeof now === 'string' && now !== '') return now
    if (now instanceof Date) return now.toISOString()
    if (typeof now === 'number' && Number.isFinite(now)) return new Date(now).toISOString()
    return new Date().toISOString()
  }

  /** §3.1 的提交对象:`{ ...原 value, prefix, suffix, edited: true, savedAt }`。 */
  function nextPersonaPayload (read, fields, now) {
    const f = fields && typeof fields === 'object' ? fields : {}
    const out = basePersonaValue(read)
    out.prefix = str(f.prefix)
    out.suffix = str(f.suffix)
    out.edited = true                       // true = 用户拥有的文本(数据层永不覆盖)
    out.savedAt = stampOf(now)
    return out
  }

  /** 失败取文案:`err.payload.errors[]` 优先(§3.1-3:内联显示,禁用 alert)。 */
  function errorsOf (err) {
    const payload = err && typeof err === 'object' ? err.payload : null
    const list = payload && Array.isArray(payload.errors) ? payload.errors : []
    if (list.length > 0) return list.map(function (e) { return str(e) })
    if (payload && payload.error) return [str(payload.error)]
    if (err && err.message) return [str(err.message)]
    return ['保存失败(没拿到原因)']
  }

  // ── DOM 小工具(运行时自建;不碰 index.html)──────────────────────
  function clearChildren (node) {
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  function h (doc, tag, props, kids) {
    const node = doc.createElement(tag)
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k]
        if (v === undefined || v === null) continue
        if (k === 'class') node.className = v
        else if (k === 'text') node.textContent = v
        else if (k === 'on') { for (const type of Object.keys(v)) node.addEventListener(type, v[type]) }
        else node[k] = v
      }
    }
    if (kids) for (const kid of kids) if (kid) node.appendChild(kid)
    return node
  }

  /** 「标签 + 大 textarea + 计数」一块(§6.2 的两个大框)。 */
  function buildBox (doc, opts) {
    const box = h(doc, 'div', { class: 'persona-box' })
    box.appendChild(h(doc, 'label', { class: 'cfg-name', text: opts.label }))
    const ta = h(doc, 'textarea', {
      class: 'cfg-input persona-ta', rows: opts.rows, spellcheck: false,
      placeholder: opts.placeholder, value: ''
    })
    box.appendChild(ta)
    const counter = h(doc, 'div', { class: 'cfg-hint persona-count', text: counterText(0, MAX_FALLBACK) })
    box.appendChild(counter)
    return { box: box, ta: ta, counter: counter }
  }

  /** 计数行:超限变红(靠颜色,不靠 CSS 新类 —— 这一页不改共享样式表)。 */
  function paintCounter (node, count, max) {
    const over = overLimit(count, max)
    node.textContent = counterText(count, max)
    node.className = over ? 'cfg-hint persona-count over' : 'cfg-hint persona-count'
    node.style.color = over ? OVER_COLOR : ''
  }

  /** 预览块:拼出来的两段 + 转义提示。 */
  function renderPreview (node, fields) {
    const p = buildPreview(fields.prefix, fields.suffix)
    const lines = [p.text, '', p.emptyCount === 2
      ? '两段都是空的 ⇒ 这一页等于「不注入人格」。'
      : (p.emptyCount === 1 ? '还有一段是空的 ⇒ 那一段不注入。' : '')]
    if (p.braces) lines.push('这段里有花括号:注入时会被转义(连续的 { 之间插空格)。')
    lines.push(BRACE_NOTE)
    node.textContent = lines.filter(function (l) { return l !== '' }).join('\n')
  }

  // ── draw(§3.1-2:可重复调用,绝不重复叠加)───────────────────────
  function draw (el, api) {
    if (!el || !api || typeof api.get !== 'function') return
    const doc = el.ownerDocument || globalThis.document
    if (!doc || typeof doc.createElement !== 'function') return

    // 幂等:每次重画先清空旧树,再用序号把"上一轮的异步续写"作废。
    const seq = (Number(el.__echoPersonaSeq) || 0) + 1
    el.__echoPersonaSeq = seq
    clearChildren(el)
    const alive = function () { return el.__echoPersonaSeq === seq }

    const state = { maxChars: MAX_FALLBACK, saving: false }

    const wrap = h(doc, 'div', { class: 'persona-wrap' })
    wrap.appendChild(h(doc, 'div', { class: 'hint', text: INTRO_TEXT }))

    const prefixBox = buildBox(doc, {
      label: '人格前缀 —— 身份段(§6.2)', rows: 10,
      placeholder: '例:你是…(空 = 不注入这一段)'
    })
    const suffixBox = buildBox(doc, {
      label: '人格后缀 —— 铁律 + 说话方式(§6.2)', rows: 14,
      placeholder: '例:…(空 = 不注入这一段)'
    })
    wrap.appendChild(prefixBox.box)
    wrap.appendChild(suffixBox.box)

    const errBox = h(doc, 'div', { class: 'hint err', hidden: true })
    errBox.style.color = ERR_COLOR
    wrap.appendChild(errBox)

    const saveBtn = h(doc, 'button', { class: 'btn', type: 'button', text: '保存', on: { click: onSave } })
    const clearBtn = h(doc, 'button', {
      class: 'btn ghost', type: 'button', text: '恢复为空', on: { click: onClear }
    })
    const statusLine = h(doc, 'span', { class: 'cfg-hint', text: '' })
    const toolbar = h(doc, 'div', { class: 'toolbar' }, [saveBtn, clearBtn, statusLine])
    wrap.appendChild(toolbar)

    const preview = h(doc, 'div', { class: 'note persona-preview' })
    wrap.appendChild(preview)

    el.appendChild(wrap)

    function value () {
      return { prefix: prefixBox.ta.value, suffix: suffixBox.ta.value }
    }

    function hideErr () {
      errBox.hidden = true
      errBox.textContent = ''
    }

    function showErr (lines) {
      errBox.textContent = lines.join('\n')
      errBox.hidden = false
    }

    function refresh () {
      const v = value()
      const pc = countChars(v.prefix)
      const sc = countChars(v.suffix)
      paintCounter(prefixBox.counter, pc, state.maxChars)
      paintCounter(suffixBox.counter, sc, state.maxChars)
      saveBtn.disabled = state.saving || !canSave(v, state.maxChars)
      renderPreview(preview, v)
    }

    function onClear () {
      prefixBox.ta.value = ''
      suffixBox.ta.value = ''
      hideErr()
      statusLine.textContent = CLEARED_HINT
      refresh()
    }

    async function onSave () {
      if (state.saving) return
      const v = value()
      if (!canSave(v, state.maxChars)) {
        showErr(['超过上限 ' + state.maxChars + ' 字:先删到上限以内再保存。'])
        return
      }
      state.saving = true
      saveBtn.disabled = true
      statusLine.textContent = '保存中…'
      hideErr()
      try {
        // 原 value 从数据接口拿(§1 表第 2 条;文件不存在 ⇒ {exists:false} ⇒ 空对象打底)。
        const raw = await api.get(WRITE_PATH)
        const body = nextPersonaPayload(raw, v)
        await api.put(WRITE_PATH, body)                       // 完整对象,不是 patch
        if (!alive()) return
        statusLine.textContent = '已保存 · ' + TOAST_TEXT
        if (typeof api.toast === 'function') api.toast(TOAST_TEXT, 'ok')
        if (typeof api.reload === 'function') api.reload()
      } catch (err) {
        if (!alive()) return
        state.saving = false
        showErr(errorsOf(err))
        refresh()
      }
    }

    prefixBox.ta.addEventListener('input', refresh)
    suffixBox.ta.addEventListener('input', refresh)
    refresh()                                  // 骨架先能用(计数/预览/禁用态都到位)

    return api.get(READ_PATH).then(function (res) {
      if (!alive()) return
      state.maxChars = maxOf(res)
      prefixBox.ta.value = str(res && res.prefix)
      suffixBox.ta.value = str(res && res.suffix)
      statusLine.textContent = '已载入 · 改完点保存,' + TOAST_TEXT
      refresh()
    }).catch(function (err) {
      if (!alive()) return
      showErr(errorsOf(err))
    })
  }

  return {
    draw: draw,
    pure: {
      READ_PATH: READ_PATH, WRITE_PATH: WRITE_PATH, TOAST_TEXT: TOAST_TEXT,
      MAX_FALLBACK: MAX_FALLBACK, EMPTY_NOTE: EMPTY_NOTE, SEGMENTS: SEGMENTS,
      str: str, countChars: countChars, counterText: counterText, overLimit: overLimit,
      maxOf: maxOf, canSave: canSave, buildPreview: buildPreview,
      basePersonaValue: basePersonaValue, stampOf: stampOf,
      nextPersonaPayload: nextPersonaPayload, errorsOf: errorsOf
    }
  }
})()
