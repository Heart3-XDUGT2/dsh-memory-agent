/**
 * 配置中心 · ① 上手引导条(P2 §6.2 的"① 上手引导条" + 契约 §4.1 的"(横幅)"一行)
 * =====================================================================
 * 它**不是一页** —— 没有导航项、没有 hash 路由、不进 `PANELS`(那张表管的是
 * "能导航到的分区")。它是一个**常驻横幅**:数据没配好就红着提醒,配好了就自己
 * 消失,免得用户在一片空白里猜"我是不是哪没弄对"。
 *
 * 契约(不许自创):
 *   · 只读 `GET /api/echo/setup`(§4.1 那一行写的就是它),不写任何东西;
 *   · 深链只能是 §2.1 表里的值(`setup.files[].deepLink` 发下来的,自己不许编);
 *   · 判"要提醒"的口径与 ⑧ 页同一套:missing > broken > empty > ok(§5);
 *   · 视图里零 `fetch`、零文件系统路径。
 *
 * 挂载:`globalThis.EchoViews['setup-banner']`,由 `web/app.js` 的
 * `drawSetupBanner()` 在启动时与每次 `refreshAll()`(10 秒轮询)里调 —— 所以
 * **必须幂等**,且失败要静默降级(体检都读不到时,别再往页面上撒红字;
 * 那是 ⑧ 数据体检页的活)。
 */
globalThis.EchoViews = globalThis.EchoViews || {}
;(function () {
  const SETUP_PATH = '/api/echo/setup'
  /** 横幅里最多列几行(再多就劝去 ⑧ 页看全表)。 */
  const MAX_ROWS = 8

  /** 取个能看的字符串(脏值 ⇒ '')。 */
  function toText (v) {
    return typeof v === 'string' ? v.trim() : (v === null || v === undefined ? '' : String(v))
  }

  /**
   * 一个文件的状态(与 ⑧ 页同口径:missing > broken > empty > ok)。
   * @returns {{state:string, label:string, badge:string}}
   */
  function statusRow (f) {
    const d = (f !== null && typeof f === 'object') ? f : {}
    if (d.exists === false || d.missing === true) return { state: 'missing', label: '文件不在', badge: '✖' }
    if (d.broken === true || d.unreadable === true) return { state: 'broken', label: '读不出来', badge: '⚠' }
    if (d.empty === true) return { state: 'empty', label: '还没填', badge: '○' }
    return { state: 'ok', label: '正常', badge: '✓' }
  }

  /** 深链 `#/persona` ⇒ `persona`;不是深链就回 ''(自己不许编深链)。 */
  function deepLinkId (link) {
    const s = toText(link)
    if (!s.startsWith('#/')) return ''
    const id = s.slice(2).replace(/^\/+|\/+$/g, '')
    return /^[a-z][a-z0-9-]*$/.test(id) ? id : ''
  }

  /** 要提醒的文件:缺 / 坏 / 空(**正常的不列**)。 */
  function troubleRows (setup) {
    const s = (setup !== null && typeof setup === 'object') ? setup : {}
    const files = Array.isArray(s.files) ? s.files : []
    const out = []
    for (const f of files) {
      const d = (f !== null && typeof f === 'object') ? f : {}
      const st = statusRow(d)
      if (st.state === 'ok') continue
      out.push({
        file: toText(d.file),
        state: st.state,
        label: st.label,
        badge: st.badge,
        pageId: deepLinkId(d.deepLink),
        deepLink: toText(d.deepLink),
        hint: toText(d.hint)
      })
    }
    // 顺序照契约 §5 的分级:缺 → 坏 → 空(同级按文件名字典序,稳定)
    const rank = { missing: 0, broken: 1, empty: 2 }
    out.sort((a, b) => (rank[a.state] - rank[b.state]) || (a.file < b.file ? -1 : 1))
    return out
  }

  /** 一句话结论(给人看的,不是 JSON)。 */
  function summaryText (rows) {
    const list = Array.isArray(rows) ? rows : []
    if (list.length === 0) return '还没配好:一份数据文件都没读到 —— 去「数据体检」页看看'
    const n = (k) => list.filter((r) => r.state === k).length
    const parts = []
    if (n('missing') > 0) parts.push(n('missing') + ' 个文件不在')
    if (n('broken') > 0) parts.push(n('broken') + ' 个读不出来')
    if (n('empty') > 0) parts.push(n('empty') + ' 个还没填')
    return '还没配好:' + parts.join('、') + ' —— 点右面的分区去补'
  }

  /** 一行文件的说明(优先用服务端给的 hint,没有就按状态兜底)。 */
  function hintFor (row) {
    const r = (row !== null && typeof row === 'object') ? row : {}
    if (r.hint !== '') return r.hint
    if (r.state === 'missing') return '点「重建」可以写一份空模板(⑧ 数据体检页)'
    if (r.state === 'broken') return '文件读不出来了,去 ⑧ 页看原文 / 重建'
    return '这个文件还是空的,不影响启动'
  }

  const pure = { toText, statusRow, deepLinkId, troubleRows, summaryText, hintFor, MAX_ROWS }

  /**
   * 画横幅(幂等:先清空再铺)。
   * @param {HTMLElement} el  `#setup-banner` 容器
   * @param {{get:Function}} api  app.js 给的取数通道(只用 get)
   */
  async function draw (el, api) {
    if (el === null || el === undefined) return
    if (api === null || api === undefined || typeof api.get !== 'function') return
    const hide = () => { el.hidden = true; el.textContent = '' }
    let setup = null
    try {
      setup = await api.get(SETUP_PATH)
    } catch {
      return hide()   // 体检读不到:静默降级(那是 ⑧ 页的活,这里不撒红字)
    }
    const rows = troubleRows(setup)
    // 开关条件是**`configured`**(服务端那句"至少有一个文件是有内容的"):
    // 已配置 ⇒ 自己消失 —— **哪怕还有空的文件**(空是合法状态:B0 §5 的口径,
    // 你库里 graph.json / state-defaults.json 就是"空但正常")。那种"配好了但
    // 哪几项还空着"的账,归 ⑧ 数据体检页,不在这儿天天红着催。
    if (setup.configured === true) return hide()
    // 回包是脏的(既没说已配置、也没有任何可列的项)⇒ 也不知道该说什么,别撒红字
    if (rows.length === 0 && setup.configured !== false) return hide()

    const doc = el.ownerDocument || globalThis.document
    if (doc === null || doc === undefined || typeof doc.createElement !== 'function') return
    while (el.firstChild) el.removeChild(el.firstChild)

    const head = doc.createElement('div')
    head.className = 'sb-head'
    head.textContent = '⚠ ' + summaryText(rows)
    el.appendChild(head)

    const list = doc.createElement('ul')
    list.className = 'sb-list'
    for (const r of rows.slice(0, MAX_ROWS)) {
      const li = doc.createElement('li')
      if (r.pageId !== '') {
        const a = doc.createElement('a')
        a.href = '#/' + r.pageId
        a.textContent = r.file
        li.appendChild(a)
      } else {
        const span = doc.createElement('span')
        span.className = 'sb-name'
        span.textContent = r.file
        li.appendChild(span)
      }
      const tag = doc.createElement('span')
      tag.className = 'sb-state sb-' + r.state
      tag.textContent = r.badge + ' ' + r.label
      li.appendChild(tag)
      const hint = doc.createElement('span')
      hint.className = 'sb-hint'
      hint.textContent = hintFor(r)
      li.appendChild(hint)
      list.appendChild(li)
    }
    el.appendChild(list)

    if (rows.length > MAX_ROWS) {
      const more = doc.createElement('div')
      more.className = 'sb-more'
      more.textContent = '还有 ' + (rows.length - MAX_ROWS) + ' 项 —— 全部在「数据体检」页'
      el.appendChild(more)
    }
    el.hidden = false
  }

  globalThis.EchoViews['setup-banner'] = { draw, pure }
})()
