/* Echo 配置中心 ⑧ 数据体检页 —— `web/views/data-health.js`
 * ============================================================
 * P2「配置中心」B3:这一页回答三个问题 ——
 *   1. 8 个数据文件在不在、空不空、读不读得出来(`GET /api/echo/setup`);
 *   2. 出了事能不能就地修:缺文件 / 读不出来 ⇒ 「重建」写回空模板
 *      (先 `GET /api/echo/data/<file>.json` 取 `template`,再 PUT 回去;
 *       两步确认:第一下只亮说明,第二下才发请求);
 *   3. 备份看得见、动得着吗:一键备份全部(`POST /api/echo/data/backup`)
 *      + 备份清单(`GET /api/echo/data/backups`)—— **只列不删**。
 *
 * 纪律(契约 §3.1):
 *   · classic script:无模块语法,末尾只往 `EchoViews['data-health']` 上挂东西;
 *   · 取数只走注入的 `api`;这一份文件里不发 `fetch`、也不出现任何文件系统路径
 *     (唯一单文件读写路就是 API:`/api/echo/data/<file>.json`);
 *   · 重建 / 备份成功:`api.toast('已生效,刷新页面看界面', 'ok')` → `api.reload()`;
 *     失败:`err.payload.errors[]` 内联进 `.hint.err`,不弹窗(零 alert)。
 *
 * 整块包在 IIFE 里:视图文件都在同一张页面里当普通脚本跑,顶层 `const`
 * 是**共享**的词法环境 —— 不包起来,两个页面文件同名一个变量就整页报错。
 */
globalThis.EchoViews = globalThis.EchoViews || {}
// 走 `globalThis.EchoViews[...]` 而不是裸名:浏览器里两者等价,但单测是用
// `new Function('globalThis', src)` 的沙箱跑的(见 tests/config-data-health.test.js),
// 那里没有真实全局作用域,裸名会 ReferenceError。
globalThis.EchoViews['data-health'] = (function () {
  'use strict'

  /** 三个冻结端点(契约 §1;各页不许自创路径)。 */
  const SETUP_PATH = '/api/echo/setup'
  const BACKUPS_PATH = '/api/echo/data/backups'
  const BACKUP_PATH = '/api/echo/data/backup'

  /** 生效文案(契约 §4:重建 / 备份成功都用这一句,不许自创)。 */
  const EFFECTIVE_TEXT = '已生效,刷新页面看界面'

  /** 四态的人话标签与机器徽标(顺序即优先级:missing > broken > empty > ok)。 */
  const STATE_LABEL = Object.freeze({
    missing: '文件不在',
    empty: '还没填',
    broken: '读不出来',
    ok: '正常'
  })

  const STATE_BADGE = Object.freeze({
    missing: 'missing',
    empty: 'empty',
    broken: 'broken',
    ok: 'ok'
  })

  /** 表头(顺序即列顺序)。 */
  const COLUMNS = ['文件', '大小', '标记', 'schemaRev', '深链', '操作']

  /* ── 纯逻辑(零 DOM、零 io;测试直接拿去用) ───────────────────── */

  function strOf (v) { return typeof v === 'string' ? v : '' }

  function isObj (v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

  /**
   * 单文件读写路:`/api/echo/data/<file>.json`(唯一写路,契约 §1)。
   * 端点回包里的 `file` 已经带 `.json`(例如 `persona.json`)⇒ 别把后缀叠两遍。
   */
  function dataPathOf (file) {
    const name = String(file)
    return '/api/echo/data/' + (/\.json$/.test(name) ? name : name + '.json')
  }

  /** 一行的状态归位:missing > broken > empty > ok(契约 §5 的口径)。 */
  function statusRow (row) {
    const r = isObj(row) ? row : {}
    // `exists` 缺席时按"在"算(缺字段兜底:宁可少报失踪,不乱扣帽子)
    const exists = (r.exists === undefined) ? true : r.exists === true
    let state = 'ok'
    if (!exists) state = 'missing'
    else if (r.broken === true || r.unreadable === true) state = 'broken'
    else if (r.empty === true) state = 'empty'
    return { state, label: statusLabel(state), badge: STATE_BADGE[state] }
  }

  /** 状态 → 人话(不认识的状态不装懂,回「未知」)。 */
  function statusLabel (state) {
    const label = STATE_LABEL[String(state)]
    return label === undefined ? '未知' : label
  }

  /** 这一行要不要给「重建」(缺文件 / 读不出来;empty 只是提示,不催)。 */
  function needsRebuild (row) {
    const st = statusRow(row).state
    return st === 'missing' || st === 'broken'
  }

  /** 深链 `#/persona` → 页面 id `persona`;脏值(缺 #/、多段路径、非串)⇒ 空串。 */
  function deepLinkId (link) {
    const s = (link === null || link === undefined) ? '' : String(link).trim()
    const m = /^#\/([A-Za-z0-9._-]+)$/.exec(s)
    return m === null ? '' : m[1]
  }

  /** 字节 → 人话:0 / 1 / <1024 ⇒ B,再上 KB、MB(一位小数)。 */
  function bytesText (n) {
    const b = Number(n)
    if (!isFinite(b) || b <= 0) return '0 B'
    if (b < 1024) return String(Math.round(b)) + ' B'
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
    return (b / (1024 * 1024)).toFixed(1) + ' MB'
  }

  /** ISO 时间 → `YYYY-MM-DD HH:mm`;认不出来 ⇒ 空串(不编时间)。 */
  function mtimeText (iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(strOf(iso))
    if (m === null) return ''
    return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]
  }

  /** 一条备份 → 一行字(名字 · 对应数据文件 · 大小 · 时间);没名字 ⇒ 空串。 */
  function backupLabel (entry) {
    const e = isObj(entry) ? entry : {}
    const name = strOf(e.name).trim()
    if (name === '') return ''
    const file = strOf(e.file).trim()
    const parts = [name, file === '' ? '来源未知' : file, bytesText(e.bytes)]
    const t = mtimeText(e.mtime)
    if (t !== '') parts.push(t)
    return parts.join(' · ')
  }

  /** 失败回包 → 一句内联错误(`err.payload.errors[]` 优先;没有就给状态码 + 原因)。 */
  function errText (err) {
    const e = isObj(err) ? err : {}
    const payload = isObj(e.payload) ? e.payload : {}
    const list = Array.isArray(payload.errors) ? payload.errors : []
    const joined = list.map(function (x) { return String(x) }).join(' / ')
    if (joined !== '') return joined
    const status = (e.status === undefined || e.status === null) ? '' : String(e.status)
    const detail = (payload.error === undefined || payload.error === null) ? '' : String(payload.error)
    if (status === '' && detail === '') return '出错了,稍后再试'
    return '操作失败(' + status + '):' + (detail === '' ? '未知原因' : detail)
  }

  /** 单文件读回包 → 要 PUT 回去的空模板(`template` 缺席 / 脏值 ⇒ 最小打底,不瞎编字段)。 */
  function templateOf (res) {
    const r = isObj(res) ? res : {}
    if (isObj(r.template)) return Object.assign({}, r.template)
    return { schemaRev: 1 }
  }

  /** configured → 徽标字。 */
  function configuredLabel (v) {
    if (v === true) return '已配置'
    if (v === false) return '还没配置'
    return '状态未知'
  }

  /** 体检回包 → 顶端那句人话结论(全好 / 有几个要修;empty 只算"还没填",不算要修)。 */
  function summaryText (setup) {
    const s = isObj(setup) ? setup : {}
    const files = Array.isArray(s.files) ? s.files : []
    if (files.length === 0) return '还没读到体检结果'
    let bad = 0
    let blank = 0
    for (const r of files) {
      const st = statusRow(r).state
      if (st === 'missing' || st === 'broken') bad += 1
      else if (st === 'empty') blank += 1
    }
    if (bad === 0 && blank === 0) return '全好 —— ' + files.length + ' 个文件都在、都能读、都填过了'
    const bits = []
    if (bad > 0) bits.push(bad + ' 个要修(缺文件或读不出来)')
    if (blank > 0) bits.push(blank + ' 个还没填(不急)')
    return bits.join(' / ')
  }

  /* ── DOM:小工具 ──────────────────────────────────────────── */

  /** 建一个节点(一律 `textContent`,不拼 HTML —— 不留 XSS 坏习惯)。 */
  function mk (doc, tag, cls, text) {
    const node = doc.createElement(tag)
    if (cls !== undefined && cls !== '') node.className = cls
    if (text !== undefined) node.textContent = text
    return node
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

    const hasApi = !(api === null || typeof api !== 'object' || typeof api.get !== 'function')

    /* 顶端:`configured` 徽标 + 人话结论。 */
    const head = mk(doc, 'div', 'cfg-head')
    const badge = mk(doc, 'span', 'badge badge-warn', '状态未知')
    const summary = mk(doc, 'span', 'hint', '还没读到体检结果')
    const reloadBtn = mk(doc, 'button', 'btn ghost', '刷新')
    reloadBtn.type = 'button'
    reloadBtn.addEventListener('click', function () { draw(el, api) })
    head.appendChild(badge)
    head.appendChild(summary)
    head.appendChild(reloadBtn)
    el.appendChild(head)

    /* 说明行:真源与边界(他不用猜这一页能干什么)。 */
    el.appendChild(mk(doc, 'p', 'hint',
      '数据目录是唯一真源 —— 这一页不读文件,看到的一切都来自 API。'
      + '本页只做两件写事:「重建」缺 / 坏的文件、一键备份全部;其余一律只读。'))

    /* 文件表。 */
    const table = mk(doc, 'table', 'cfg-table')
    const thead = mk(doc, 'thead', '')
    const htr = mk(doc, 'tr', '')
    for (const t of COLUMNS) htr.appendChild(mk(doc, 'th', '', t))
    thead.appendChild(htr)
    table.appendChild(thead)
    const tbody = mk(doc, 'tbody', '')
    table.appendChild(tbody)
    el.appendChild(table)

    /* 备份区(只列不删)。 */
    const card = mk(doc, 'div', 'card backup-card')
    card.appendChild(mk(doc, 'h3', '', '备份'))
    const backupBtn = mk(doc, 'button', 'btn', '一键备份全部')
    backupBtn.type = 'button'
    backupBtn.addEventListener('click', function () { doBackup() })
    card.appendChild(backupBtn)
    card.appendChild(mk(doc, 'div', 'hint', '备份 = 把 8 个文件各拷一份进 backup/;备份不动盘上那份真源。'))
    card.appendChild(mk(doc, 'div', 'hint',
      '本页不删任何东西 —— 要还原请手工从 backup/ 拷回去。'))
    const backupList = mk(doc, 'div', 'backup-list')
    card.appendChild(backupList)
    el.appendChild(card)

    /* 错误槽(内联;契约要求 class 就是 `hint err`)。 */
    const errBox = mk(doc, 'div', 'hint err')
    errBox.style.color = '#ff9a9a'
    errBox.style.display = 'none'
    errBox.textContent = ''
    el.appendChild(errBox)

    function showErrors (err) {
      errBox.textContent = errText(err)
      errBox.style.display = ''
    }

    /** 写成功:生效文案 → 重画本页(契约 §3.1 固定流程)。 */
    function onOk () {
      if (stale()) return
      api.toast(EFFECTIVE_TEXT, 'ok')
      api.reload()
    }

    /* ── 文件表:一行 ─────────────────────────────────────── */

    /** 一行 = 文件 / 大小 / 标记 / schemaRev / 深链 / 操作。 */
    function paintRow (row) {
      const r = isObj(row) ? row : {}
      const st = statusRow(r)
      const tr = mk(doc, 'tr', '')
      tr.setAttribute('data-file', strOf(r.file))
      tr.setAttribute('data-state', st.state)

      tr.appendChild(mk(doc, 'td', 'f-name', strOf(r.file)))
      tr.appendChild(mk(doc, 'td', 'f-bytes', bytesText(r.bytes)))

      const stTd = mk(doc, 'td', 'f-state')
      stTd.appendChild(mk(doc, 'span', 'badge badge-' + st.badge, st.label))
      tr.appendChild(stTd)

      const rev = (r.schemaRev === null || r.schemaRev === undefined) ? '—' : String(r.schemaRev)
      tr.appendChild(mk(doc, 'td', 'f-rev', rev))

      // 深链:锚点,不用 JS 跳转 —— 壳的 hashchange 会接手(契约 §3)
      const linkTd = mk(doc, 'td', 'f-link')
      const id = deepLinkId(r.deepLink)
      if (id === '') {
        linkTd.appendChild(mk(doc, 'span', 'hint', '—'))
      } else {
        const a = mk(doc, 'a', 'link', '深链')
        a.setAttribute('href', '#/' + id)
        linkTd.appendChild(a)
      }
      tr.appendChild(linkTd)

      const actTd = mk(doc, 'td', 'f-act')
      if (needsRebuild(r)) {
        const noteBox = mk(doc, 'div', 'hint')
        noteBox.style.display = 'none'
        noteBox.textContent = ''
        const btn = mk(doc, 'button', 'btn ghost rebuild-btn', '重建')
        btn.type = 'button'
        btn.addEventListener('click', function () { onRebuild(r, btn, noteBox) })
        actTd.appendChild(btn)
        actTd.appendChild(noteBox)
        if (st.state === 'broken') rawToggle(r, actTd)
      } else if (st.state === 'empty') {
        actTd.appendChild(mk(doc, 'span', 'hint', '还没填,不急'))
      } else {
        actTd.appendChild(mk(doc, 'span', 'hint', '不用动'))
      }
      tr.appendChild(actTd)
      return tr
    }

    /**
     * 「看原文」:坏文件的原文(`raw`)在页内**折叠**显示,别弹窗。
     * 走 `?raw=1` 强制回原文(契约 §1 的 raw 语义)。
     */
    function rawToggle (row, host) {
      const fold = mk(doc, 'pre', 'hint raw-fold')
      fold.style.display = 'none'
      fold.textContent = ''
      const btn = mk(doc, 'button', 'link raw-btn', '看原文')
      btn.type = 'button'
      let loaded = false
      btn.addEventListener('click', function () {
        if (fold.style.display === '') { fold.style.display = 'none'; return }
        if (loaded) { fold.style.display = ''; return }
        let got
        try { got = api.get(dataPathOf(row.file) + '?raw=1') } catch (e) { showErrors(e); return }
        Promise.resolve(got).then(function (res) {
          if (stale()) return
          const raw = (isObj(res) && typeof res.raw === 'string') ? res.raw : ''
          fold.textContent = raw === '' ? '(原文取不到 —— 文件可能是空的)' : raw
          loaded = true
          fold.style.display = ''
        }, function (err) { if (!stale()) showErrors(err) })
      })
      host.appendChild(btn)
      host.appendChild(fold)
    }

    /* ── 重建:两步确认 ───────────────────────────────────── */

    // 已"上膛"的文件(第一下只亮说明,第二下才发请求)
    const armed = {}

    function onRebuild (row, btn, noteBox) {
      const file = strOf(row.file)
      if (armed[file] !== true) {
        armed[file] = true
        btn.textContent = '确认重建'
        noteBox.textContent = '将写入空模板(出厂默认值)—— 盘上现有的那一份会先被备份;'
          + '再点一次「确认重建」才真的写入。'
        noteBox.style.display = ''
        return
      }
      armed[file] = false
      btn.textContent = '重建'
      noteBox.style.display = 'none'
      rebuild(file)
    }

    /** 取 template(`GET`)→ PUT 完整空模板 → 生效文案 → 重画。 */
    function rebuild (file) {
      const path = dataPathOf(file)
      let got
      try { got = api.get(path) } catch (e) { showErrors(e); return }
      Promise.resolve(got).then(function (res) {
        if (stale()) return
        let p
        try { p = api.put(path, templateOf(res)) } catch (e) { showErrors(e); return }
        return Promise.resolve(p).then(function () { onOk() }, function (err) { if (!stale()) showErrors(err) })
      }, function (err) { if (!stale()) showErrors(err) })
    }

    /* ── 备份:一键全部 + 清单 ────────────────────────────── */

    function doBackup () {
      let p
      try { p = api.post(BACKUP_PATH, {}) } catch (e) { showErrors(e); return }
      Promise.resolve(p).then(function () { onOk() }, function (err) { if (!stale()) showErrors(err) })
    }

    function paintBackups (reply) {
      const r = isObj(reply) ? reply : {}
      const list = Array.isArray(r.files) ? r.files : []
      backupList.textContent = ''
      if (list.length === 0) {
        backupList.appendChild(mk(doc, 'div', 'hint', '还没有备份 —— 点上面的「一键备份全部」就会有了。'))
        return
      }
      const headRow = mk(doc, 'div', 'backup-row backup-head')
      for (const t of ['备份文件', '对应数据文件', '大小', '时间']) {
        headRow.appendChild(mk(doc, 'span', 'b-cell', t))
      }
      backupList.appendChild(headRow)
      for (const entry of list) {
        const e = isObj(entry) ? entry : {}
        const line = mk(doc, 'div', 'backup-row')
        line.appendChild(mk(doc, 'span', 'b-cell b-name', strOf(e.name)))
        line.appendChild(mk(doc, 'span', 'b-cell b-file', strOf(e.file) === '' ? '来源未知' : strOf(e.file)))
        line.appendChild(mk(doc, 'span', 'b-cell b-bytes', bytesText(e.bytes)))
        const t = mtimeText(e.mtime)
        line.appendChild(mk(doc, 'span', 'b-cell b-mtime', t === '' ? '—' : t))
        backupList.appendChild(line)
      }
    }

    /* ── 体检回包 → 页面 ──────────────────────────────────── */

    function paintSetup (reply) {
      const r = isObj(reply) ? reply : {}
      const files = Array.isArray(r.files) ? r.files : []
      badge.textContent = configuredLabel(r.configured)
      badge.className = 'badge badge-' + (r.configured === true ? 'ok' : 'warn')
      summary.textContent = summaryText(r)
      tbody.textContent = ''
      if (files.length === 0) {
        const tr = mk(doc, 'tr', '')
        const td = mk(doc, 'td', 'hint', '体检结果没读到(端点没回 files)')
        td.setAttribute('colspan', '6')
        tr.appendChild(td)
        tbody.appendChild(tr)
        return
      }
      for (const row of files) tbody.appendChild(paintRow(row))
    }

    // 先把骨架画出来(不依赖回包);回包来了再填。
    paintSetup(null)
    paintBackups(null)

    if (!hasApi) {
      summary.textContent = '数据通道还没接上'
      return
    }
    let setupGot
    let backupsGot
    try { setupGot = api.get(SETUP_PATH) } catch (e) { showErrors(e) }
    try { backupsGot = api.get(BACKUPS_PATH) } catch (e) { showErrors(e) }
    if (setupGot !== undefined) {
      Promise.resolve(setupGot).then(function (res) {
        if (stale()) return
        paintSetup(res)
      }, function (err) { if (!stale()) showErrors(err) })
    }
    if (backupsGot !== undefined) {
      Promise.resolve(backupsGot).then(function (res) {
        if (stale()) return
        paintBackups(res)
      }, function (err) { if (!stale()) showErrors(err) })
    }
  }

  return {
    draw,
    /** 纯逻辑(零 DOM、零 io)—— 单测的入口。 */
    pure: {
      SETUP_PATH,
      BACKUPS_PATH,
      BACKUP_PATH,
      EFFECTIVE_TEXT,
      STATE_LABEL,
      STATE_BADGE,
      dataPathOf,
      statusRow,
      statusLabel,
      needsRebuild,
      deepLinkId,
      bytesText,
      mtimeText,
      backupLabel,
      errText,
      templateOf,
      configuredLabel,
      summaryText
    }
  }
})()
