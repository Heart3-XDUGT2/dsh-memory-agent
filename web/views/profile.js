/* Echo 配置中心 ③ 用户画像页 —— `web/views/profile.js`
 * ============================================================
 * P2「配置中心」B2:这一页管 `profile.json` 里**称呼的显示与识别**。
 *
 * 页面上必须把两类字段的区别说清(P1 的核心语义,别让他猜):
 *   · **显示层** `userName` / `agentName` —— 面板、审计流上**显示**的称呼;
 *   · **识别层** `userAliases` / `agentAliases` —— 用来认「这句话在说谁」;
 *     `agentAliases` 就是她认得出自己名字的那张别名表(喂 toggle.js 的 SELF_WORDS)。
 *   空 ⇒ 中性兜底(面板显示「用户 / 助手」),**不是**报错 —— 这句也要写在页面上。
 *
 * 纪律(契约 §3.1):
 *   · classic script:没有模块语法,末尾只往 `EchoViews['profile']` 上挂东西;
 *   · 取数只走注入的 `api`:读 `GET /api/echo/data/profile.json`,写
 *     `PUT /api/echo/data/profile.json`(完整对象 —— 未管字段一个都不丢);
 *     这一份文件里既不直连网络、也不出现任何文件系统路径;
 *   · 保存成功:`api.toast('已生效,刷新页面看界面', 'ok')` → `api.reload()`;
 *     校验失败:`err.payload.errors[]` 内联显示在 `.hint.err` 里,不弹窗。
 *
 * 整块包在 IIFE 里:视图文件都在同一张页面里当普通脚本跑,顶层 `const`
 * 是**共享**的词法环境 —— 不包起来,两个页面文件同名一个变量就整页报错。
 */
globalThis.EchoViews = globalThis.EchoViews || {}
// 走 `globalThis.EchoViews[...]` 而不是裸名:浏览器里两者等价,但单测是用
// `new Function('globalThis', src)` 的沙箱跑的(见 tests/config-profile.test.js),
// 那里没有真实全局作用域,裸名会 ReferenceError。
globalThis.EchoViews['profile'] = (function () {
  'use strict'

  /** 读写 `profile.json` 的唯一两条路(唯一写路,契约 §1)。 */
  const DATA_PATH = '/api/echo/data/profile.json'

  /** 生效文案(契约 §4 冻结:`profile.json` 的 effective = now;各页不许自创)。 */
  const EFFECTIVE_TEXT = '已生效,刷新页面看界面'

  /** ③ 页只管这 7 个字段;其余(含 ④ 页的 `uiIndexPrefix` / `fallbackAddress`)原样保留。 */
  const MANAGED = ['userName', 'agentName', 'agentSelfRef', 'locale', 'timezone', 'userAliases', 'agentAliases']

  /** 单行文本字段(顺序即页面顺序)。 */
  const TEXT_FIELDS = [
    { key: 'userName', label: '他:你想让她怎么叫你', hint: '显示层 —— 面板上她叫你的那个名字。留空 ⇒ 面板显示中性「用户」。' },
    { key: 'agentName', label: '她:名字', hint: '显示层 —— 面板 / 审计流上她露面的名字。留空 ⇒ 面板显示中性「助手」。' },
    { key: 'agentSelfRef', label: '她:自称', hint: '她自己说话时的第一人称(例如「Echo」);显示层只认上面的名字。' },
    { key: 'locale', label: '语言', hint: '语言标签,如 zh-CN。留空 ⇒ 默认 zh-CN。' },
    { key: 'timezone', label: '时区', hint: 'IANA 时区名,如 Asia/Shanghai。留空 ⇒ 跟宿主。' }
  ]

  /** 标签列表字段(可增删行)。 */
  const TAG_FIELDS = [
    { key: 'userAliases', label: '他:别名表', hint: '识别层 —— 他还能被这么叫(旧名 / 小号 / 网名)。认「这句话在说谁」靠它,面板显示不认它。一行一个。' },
    { key: 'agentAliases', label: '她:别名表', hint: '识别层 —— 她认得出是自己名字的别名表(自指判定用)。显示层仍然只用上面的名字。一行一个。' }
  ]

  /** 空模板(文件不存在 ⇒ 用这份打底;`schemaRev` 是记账字段,不能丢)。 */
  const EMPTY_TEMPLATE = Object.freeze({
    schemaRev: 1,
    userName: '',
    userAliases: [],
    agentName: '',
    agentSelfRef: '',
    agentAliases: [],
    nicknamePatterns: [],
    nicknameStrict: null,
    locale: '',
    timezone: '',
    updatedAt: null
  })

  /* ── 纯逻辑(零 DOM、零 io;测试直接拿去用) ───────────────────── */

  /** 标签分隔符:换行 / 半角逗号 / 全角逗号 / 分号 / 顿号都算。 */
  const TAG_SPLIT = /[\n\r,，;；、]+/

  /** 一段文本 → 标签数组:去空白、丢空串、去重(**保持首次出现的顺序**)。 */
  function parseTags (text) {
    const out = []
    const raw = (text === null || text === undefined) ? '' : String(text)
    for (const piece of raw.split(TAG_SPLIT)) {
      const s = piece.trim()
      if (s !== '' && out.indexOf(s) < 0) out.push(s)
    }
    return out
  }

  /** 标签数组 → 编辑框文本(一行一个;顺手 trim + 丢空)。 */
  function formatTags (list) {
    const out = []
    for (const x of (Array.isArray(list) ? list : [])) {
      if (typeof x !== 'string') continue
      const s = x.trim()
      if (s !== '') out.push(s)
    }
    return out.join('\n')
  }

  /**
   * 空值判定(口径与契约 §5 `isEmptyContent` 同源):
   * 空串 / 全空白 / 空数组 / 空对象 / `null` / `false` 算空;**`0` 算填过**(数字是真的值)。
   * 本页实际只判字符串与字符串数组,其余类型照这个口径顺手给个答案。
   */
  function isBlank (v) {
    if (v === null || v === undefined) return true
    if (typeof v === 'string') return v.trim() === ''
    if (Array.isArray(v)) return v.length === 0
    if (typeof v === 'boolean') return v === false
    if (typeof v === 'object') return Object.keys(v).length === 0
    return false
  }

  /** 字符串字段:非字符串 ⇒ ''。 */
  function strOf (v) { return typeof v === 'string' ? v : '' }

  /** 字符串数组字段:丢非字符串、trim、丢空、去重(与 lib/profile.js 的读法同源)。 */
  function arrOf (v) {
    const out = []
    for (const x of (Array.isArray(v) ? v : [])) {
      if (typeof x !== 'string') continue
      const s = x.trim()
      if (s !== '' && out.indexOf(s) < 0) out.push(s)
    }
    return out
  }

  /** 标签字段:既吃数组(编辑器给的行),也吃文本(逗号 / 换行分隔)。 */
  function tagsOf (v) {
    if (Array.isArray(v)) return parseTags(formatTags(v))
    return parseTags(strOf(v))
  }

  /** 读回包 → 盘上那份对象(坏文件 / `exists:false` / 不是对象 ⇒ 空模板打底)。 */
  function baseValue (res) {
    const d = (res !== null && typeof res === 'object') ? res : {}
    const v = d.value
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v
    return Object.assign({}, EMPTY_TEMPLATE)
  }

  /** 盘上那份对象 → 表单值(缺字段 / 脏值 ⇒ 空,绝不猜)。 */
  function formFromValue (value) {
    const v = (value !== null && typeof value === 'object' && !Array.isArray(value)) ? value : {}
    return {
      userName: strOf(v.userName).trim(),
      agentName: strOf(v.agentName).trim(),
      agentSelfRef: strOf(v.agentSelfRef).trim(),
      locale: strOf(v.locale).trim(),
      timezone: strOf(v.timezone).trim(),
      userAliases: arrOf(v.userAliases),
      agentAliases: arrOf(v.agentAliases)
    }
  }

  /**
   * 表单值 + 盘上原对象 → **PUT 的完整载荷**。
   * 关键:**原对象一个字段都不丢**(`schemaRev` / `nicknamePatterns` / `nicknameStrict` /
   * `updatedAt`,以及 ④ 页的 `uiIndexPrefix` / `fallbackAddress`),只覆盖 ③ 页管的 7 个。
   * 纯函数:不改 `original`。
   */
  function buildProfilePayload (original, form) {
    const src = (original !== null && typeof original === 'object' && !Array.isArray(original)) ? original : EMPTY_TEMPLATE
    const out = Object.assign({}, src)
    const f = (form !== null && typeof form === 'object') ? form : {}
    for (const key of ['userName', 'agentName', 'agentSelfRef', 'locale', 'timezone']) {
      out[key] = strOf(f[key]).trim()
    }
    out.userAliases = tagsOf(f.userAliases)
    out.agentAliases = tagsOf(f.agentAliases)
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

    /** 顶部:两类字段的区别(P1 语义,写死在页面上 —— 他不用猜)。 */
    const intro = mk(doc, 'p', 'hint')
    intro.appendChild(mk(doc, 'b', '', '显示层 / 识别层 的区别:'))
    intro.appendChild(mk(doc, 'span', '', ' 显示层 = 面板上显示给你看的称呼(userName / agentName);'
      + '识别层 = 用来认「这句话在说谁」的别名表(userAliases / agentAliases,她认自己名字也靠它)。'
      + '两类留空都不是错 —— 空 ⇒ 中性兜底,面板显示「用户 / 助手」。'))
    el.appendChild(intro)

    const body = mk(doc, 'div', 'profile-form')
    el.appendChild(body)

    /** 错误槽(内联;契约要求 class 就是 `hint err`)。 */
    const errBox = mk(doc, 'div', 'hint err')
    errBox.style.color = '#ff9a9a'
    errBox.style.display = 'none'
    errBox.textContent = ''

    function showErrors (err) {
      const list = (err !== null && typeof err === 'object' && err.payload !== undefined
        && err.payload !== null && Array.isArray(err.payload.errors)) ? err.payload.errors : []
      let text = list.join(' / ')
      if (text === '') {
        const status = (err !== null && typeof err === 'object' && err.status !== undefined) ? String(err.status) : ''
        const detail = (err !== null && typeof err === 'object' && err.payload !== undefined && err.payload !== null
          && err.payload.error !== undefined) ? String(err.payload.error) : '请稍后重试'
        text = '保存失败(' + status + '):' + detail
      }
      errBox.textContent = text
      errBox.style.display = ''
    }

    /** 单行文本字段。 */
    const inputs = {}
    for (const f of TEXT_FIELDS) {
      const row = mk(doc, 'div', 'cfg-row')
      row.appendChild(mk(doc, 'div', 'cfg-name', f.label))
      const input = mk(doc, 'input', 'cfg-input')
      input.type = 'text'
      input.setAttribute('data-field', f.key)
      row.appendChild(input)
      row.appendChild(mk(doc, 'div', 'cfg-hint', f.hint))
      body.appendChild(row)
      inputs[f.key] = input
    }

    /** 标签列表编辑器:可增删行(一行一个标签)。 */
    const tagState = {}

    function syncTag (key) {
      const st = tagState[key]
      st.values = st.inputs.map(valOf)
    }

    function paintTag (key) {
      const st = tagState[key]
      st.body.textContent = ''
      st.inputs = []
      const list = st.values.length > 0 ? st.values : ['']
      for (const v of list) {
        const row = mk(doc, 'div')
        row.style.display = 'flex'
        row.style.gap = '6px'
        row.style.alignItems = 'center'
        const input = mk(doc, 'input', 'cfg-input')
        input.type = 'text'
        input.value = v
        input.setAttribute('data-field', key)
        input.setAttribute('data-tag', '1')
        const del = mk(doc, 'button', 'btn ghost', '删')
        del.type = 'button'
        del.addEventListener('click', function () {
          syncTag(key)
          const i = st.inputs.indexOf(input)
          if (i >= 0) st.values.splice(i, 1)
          paintTag(key)
        })
        row.appendChild(input)
        row.appendChild(del)
        st.body.appendChild(row)
        st.inputs.push(input)
      }
    }

    for (const f of TAG_FIELDS) {
      const row = mk(doc, 'div', 'cfg-row')
      row.appendChild(mk(doc, 'div', 'cfg-name', f.label))
      const inner = mk(doc, 'div', '')
      const listBox = mk(doc, 'div', '')
      inner.appendChild(listBox)
      const add = mk(doc, 'button', 'btn ghost', '+ 添加一行')
      add.type = 'button'
      add.addEventListener('click', function () {
        syncTag(f.key)
        tagState[f.key].values.push('')
        paintTag(f.key)
      })
      inner.appendChild(add)
      row.appendChild(inner)
      row.appendChild(mk(doc, 'div', 'cfg-hint', f.hint))
      body.appendChild(row)
      tagState[f.key] = { body: listBox, inputs: [], values: [] }
      paintTag(f.key)
    }

    /** 页面 → 表单值(标签走"先同步 DOM,再解析")。 */
    function readForm () {
      const form = {}
      for (const f of TEXT_FIELDS) form[f.key] = valOf(inputs[f.key])
      for (const f of TAG_FIELDS) {
        syncTag(f.key)
        form[f.key] = tagState[f.key].values
      }
      return form
    }

    /** 盘上的值 → 填进表单。 */
    let current = null
    function fill (value) {
      current = value
      const form = formFromValue(value)
      for (const f of TEXT_FIELDS) inputs[f.key].value = form[f.key]
      for (const f of TAG_FIELDS) {
        tagState[f.key].values = form[f.key].slice()
        paintTag(f.key)
      }
    }

    /** 保存:完整对象 PUT(未管字段一个不丢)→ 生效文案 → 重画。 */
    function save () {
      errBox.textContent = ''
      errBox.style.display = 'none'
      if (api === null || typeof api !== 'object' || typeof api.put !== 'function') {
        showErrors({ status: 0, payload: { error: '数据通道还没接上,先别急着存' } })
        return
      }
      const payload = buildProfilePayload(current, readForm())
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
      showErrors(err)
    })
  }

  return {
    draw,
    /** 纯逻辑(零 DOM、零 io)—— 单测的入口。 */
    pure: {
      DATA_PATH,
      EFFECTIVE_TEXT,
      MANAGED,
      EMPTY_TEMPLATE,
      parseTags,
      formatTags,
      isBlank,
      baseValue,
      formFromValue,
      buildProfilePayload
    }
  }
})()
