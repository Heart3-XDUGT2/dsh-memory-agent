/* Echo 配置中心 ⑦ 状态与词库页(id = 'state-lexicon')
 * ============================================================
 * 一页管**两个**数据文件,各存各的、**两个保存按钮分开**(契约 §3.1 / §4):
 *   ① 状态初值 —— 情绪强度 / 好感度 / 想念值 / 7 维情绪向量。
 *      这几项是**初值 / 兜底**:状态库里已经有值时,一律以库里的为准。
 *      7 维按 `lib/emotion.js` 铺:global(疲惫 / 心情 / 唤醒度)+
 *      target_master(爱意 / 调皮 / 委屈 / 依赖)。
 *   ② 词库 —— 同义词组 / 时间词 / 禁词 / 她的兴趣 / 旧称呼 / 停用词。
 *      词库是**程序不再内置**的那部分(以前写死在代码里的表,现在归他填);
 *      空 = 该项无数据,**不是**报错。
 *
 * 纪律(契约 §3.1):
 *   · classic script(无 import / export),末尾只往 `EchoViews['state-lexicon']` 上挂东西;
 *   · 取数只走注入的 `api`:两条 API 路径各读各写;这里不出现 `fetch`、
 *     不出现文件系统路径;纯逻辑挂在 `.pure` 上给单测;
 *   · 保存成功:`api.toast('下次引擎调用生效', 'ok')` → `api.reload()`;
 *     校验失败:`err.payload.errors[]` 内联进 `.hint.err`,**不弹窗**(零 alert)。
 *
 * 整块包在 IIFE 里:视图文件都在同一张页面里当普通脚本跑,顶层 `const`
 * 是**共享**的词法环境 —— 不包起来,两个页面文件同名一个变量就整页报错。
 */
globalThis.EchoViews = globalThis.EchoViews || {}
// 走 `globalThis.EchoViews[...]` 而不是裸名:浏览器里两者等价,但单测是用
// `new Function('globalThis', src)` 的沙箱跑的,那里没有真实全局作用域,裸名会 ReferenceError。
globalThis.EchoViews['state-lexicon'] = (function () {
  'use strict'

  /* ── 常量(本页只认这两条 API 路径) ─────────────────────────── */

  /** 读 / 写状态初值的唯一路径。 */
  const STATE_PATH = '/api/echo/data/state-defaults.json'
  /** 读 / 写词库的唯一路径(与上面是两次独立的保存,不许串)。 */
  const LEXICON_PATH = '/api/echo/data/lexicon.json'
  /** 生效文案(本页两份数据的 effective 都是 next-engine-call,契约 §4 表那一句,不许自创)。 */
  const EFFECTIVE_TEXT = '下次引擎调用生效'
  /** 数据版本:每次保存写 1(契约 §2.1)。 */
  const SCHEMA_REV = 1

  /** 7 维情绪向量:分组 → 维度(逐字照 lib/emotion.js 的 EMOTION_RANGES / 中文名)。 */
  const EMOTION_GROUPS = [
    {
      key: 'global',
      label: '整体',
      dims: [
        { key: 'fatigue', label: '疲惫' },
        { key: 'valence', label: '心情' },
        { key: 'arousal', label: '唤醒度' }
      ]
    },
    {
      key: 'target_master',
      label: '对主人',
      dims: [
        { key: 'affection', label: '爱意' },
        { key: 'playfulness', label: '调皮' },
        { key: 'sadness', label: '委屈' },
        { key: 'dependency', label: '依赖' }
      ]
    }
  ]

  /** ① 状态初值里的数字框(顺序即页面顺序;空 ⇒ null,不写 0)。 */
  const STATE_NUM_FIELDS = [
    { key: 'moodIntensity', label: '情绪强度', hint: '情绪强度初值。' },
    { key: 'prevMoodIntensity', label: '上一轮情绪强度', hint: '上一轮情绪强度初值(算差值用)。' },
    { key: 'affinity', label: '好感度', hint: '好感度初值。' },
    { key: 'longing', label: '想念值', hint: '想念值初值。' },
    { key: 'energy', label: '精力', hint: '精力初值。' }
  ]

  /** ① 状态初值里的单行文本(空 ⇒ null)。 */
  const STATE_TEXT_FIELDS = [
    { key: 'userEmotion', label: '他此刻的情绪标签', hint: '他此刻情绪的初值标签;留空 ⇒ null(还没填)。' }
  ]

  /** ② 词库里的五个 `string[]`(标签式列表:可增删行)。 */
  const LEXICON_TAG_FIELDS = [
    { key: 'bannedWords', label: '禁词', hint: '一行一个;命中之后怎么处理在程序侧,这里只存词。' },
    { key: 'herInterests', label: '她的兴趣', hint: '一行一个(她自己的兴趣词)。' },
    { key: 'retiredAliases', label: '旧称呼', hint: '一行一个;改名后自动记下的那些旧叫法。' },
    { key: 'stopwords', label: '停用词', hint: '一行一个;检索时不算数的词。' },
    // ★ P3 B1 #1 的最后一环(2026-10-05):话题停用词原本只住在 lib/care-report.js 的
    //   语言默认表里,数据文件读点(topicStopwordsOf)先做好了,但面板上摸不到 ⇒ 想改
    //   只能手改 JSON。与 stopwords 并排,口径一致:**留空 = 回程序里的语言默认表**
    //   (不是"没有停用词"),填了就整表以你这份为准。
    { key: 'topicStopwords', label: '话题停用词', hint: '一行一个;从「话题关键词」里剔掉的虚词/时间词(如「今天」)。留空 ⇒ 用程序里的语言默认表;填了就整表以你这份为准。' }
  ]

  /** 空模板(文件不存在 ⇒ 优先用服务端回包的 `template`,它没有才退到这份)。 */
  const EMPTY_STATE = Object.freeze({
    schemaRev: SCHEMA_REV,
    moodIntensity: null,
    prevMoodIntensity: null,
    userEmotion: null,
    emotionVector: null,
    affinity: null,
    longing: null,
    energy: null,
    updatedAt: null
  })
  const EMPTY_LEXICON = Object.freeze({
    schemaRev: SCHEMA_REV,
    synonymGroups: [],
    timeWords: {},
    bannedWords: [],
    herInterests: [],
    retiredAliases: [],
    stopwords: [],
    topicStopwords: [],
    updatedAt: null
  })

  /* ── 纯逻辑(零 DOM、零 io;测试直接拿去用) ───────────────────── */

  /** 是真对象(不是数组 / null)。 */
  function isObj (v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

  /** 收字符串:非字符串 ⇒ ''。 */
  function strOf (v) { return typeof v === 'string' ? v : '' }

  /** 任意值 → 编辑框文本(对象 / 数组给 JSON,免得变成 [object Object])。 */
  function textOf (v) {
    if (v === null || v === undefined) return ''
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    try { return JSON.stringify(v) } catch (e) { return '' }
  }

  /**
   * 数字框口径:`''` / 全空白 / 非有限数 ⇒ **null**(绝不写 0);
   * `'0'` 是 0(数字是真的值,与契约 §5 的 isEmptyContent 同口径)。
   */
  function numOrNull (v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (typeof v !== 'string') return null
    const s = v.trim()
    if (s === '') return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }

  /** 文本字段:trim;空 ⇒ null(= 还没填,与空模板一致)。 */
  function blankToNull (v) {
    const s = strOf(v).trim()
    return s === '' ? null : s
  }

  /** 组内分隔符:空白 / 半角逗号 / 全角逗号 / 顿号 / 分号都算。 */
  const WORD_SPLIT = /[\s,，、;；]+/
  /** 标签分隔符:换行 / 逗号 / 顿号 / 分号都算。 */
  const TAG_SPLIT = /[\n\r,，、;；]+/

  /** 一段文本 → 词数组:去空白、丢空串、去重(**保持首次出现的顺序**)。 */
  function splitWords (text) {
    const out = []
    for (const piece of strOf(text).split(WORD_SPLIT)) {
      const s = piece.trim()
      if (s !== '' && out.indexOf(s) < 0) out.push(s)
    }
    return out
  }

  /**
   * 同义词组编辑器文本 → `[[a,b],[c,d,e]]`:一行一组,组内逗号 / 顿号 / 空格分隔;
   * 空行丢掉,组内去重去空、**整组重复也只留第一次**(组是集合,写两遍等于一遍);
   * 只剩一个词的组**也保留** —— 该由程序校验去说他,视图不许悄悄吞掉他的输入。
   */
  function groupsFromText (text) {
    const out = []
    const seen = []
    for (const line of strOf(text).split(/\r?\n/)) {
      const words = splitWords(line)
      if (words.length === 0) continue
      const key = words.join('\u0000')
      if (seen.indexOf(key) >= 0) continue
      seen.push(key)
      out.push(words)
    }
    return out
  }

  /** 组数组 → 编辑器文本(每行一组,组内用「, 」相连;空组丢掉)。 */
  function groupsToText (groups) {
    const lines = []
    for (const g of (Array.isArray(groups) ? groups : [])) {
      const words = []
      for (const w of (Array.isArray(g) ? g : [])) {
        const s = strOf(w).trim()
        if (s !== '' && words.indexOf(s) < 0) words.push(s)
      }
      if (words.length > 0) lines.push(words.join(', '))
    }
    return lines.join('\n')
  }

  /** 组字段归一:既吃文本(编辑器给的那段),也吃数组;结果一律是规整的组数组。 */
  function normalizeGroups (v) {
    if (Array.isArray(v)) return groupsFromText(groupsToText(v))
    return groupsFromText(strOf(v))
  }

  /** 一段文本 → 标签数组。 */
  function tagsFromText (text) {
    const out = []
    for (const piece of strOf(text).split(TAG_SPLIT)) {
      const s = piece.trim()
      if (s !== '' && out.indexOf(s) < 0) out.push(s)
    }
    return out
  }

  /** 标签字段:既吃数组(编辑器给的行),也吃文本(逗号 / 换行分隔)。 */
  function tagsOf (v) {
    if (Array.isArray(v)) return tagsFromText(v.map(strOf).join('\n'))
    return tagsFromText(strOf(v))
  }

  /**
   * 键值编辑器 → `timeWords` 对象:
   *   接受 `[{key,value}]`(页面给的)、`[[k,v]]`、或现成的对象;
   *   键 trim 后为空 ⇒ 丢;重复键 **先到的赢**;`__proto__` 直接跳过(防原型污染)。
   */
  function timeWordsFromRows (v) {
    const out = {}
    const put = function (k, val) {
      const key = strOf(k).trim()
      if (key === '' || key === '__proto__') return
      if (Object.prototype.hasOwnProperty.call(out, key)) return
      out[key] = textOf(val).trim()
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (Array.isArray(item)) put(item[0], item[1])
        else if (isObj(item)) put(item.key, item.value)
      }
    } else if (isObj(v)) {
      for (const k of Object.keys(v)) put(k, v[k])
    }
    return out
  }

  /** `timeWords` 对象 → 编辑器行(键值各一段文本)。 */
  function timeRowsFrom (v) {
    const out = []
    if (!isObj(v)) return out
    for (const k of Object.keys(v)) out.push({ key: k, value: textOf(v[k]) })
    return out
  }

  /** 表单里的 7 维 → 向量对象;7 维全空 ⇒ `null`(与空模板一致)。 */
  function vectorFromForm (v) {
    const src = isObj(v) ? v : {}
    const out = {}
    let filled = 0
    for (const g of EMOTION_GROUPS) {
      const gsrc = isObj(src[g.key]) ? src[g.key] : {}
      const dims = {}
      for (const d of g.dims) {
        const n = numOrNull(gsrc[d.key])
        dims[d.key] = n
        if (n !== null) filled += 1
      }
      out[g.key] = dims
    }
    return filled === 0 ? null : out
  }

  /** 落盘时间戳:调用方给了就用它(测试可复现),没给就是此刻。 */
  function stampOf (now) {
    if (typeof now === 'string' && now.trim() !== '') return now
    try { return new Date().toISOString() } catch (e) { return null }
  }

  /**
   * 状态初值:盘上原对象 + 表单 → **PUT 的完整载荷**。
   * 关键:**原对象一个字段都不丢**(`schemaRev` / `updatedAt` 以及以后新增的键),
   * 只覆盖本页管的 8 个;`schemaRev` 写 1、`updatedAt` 写新的。
   * 纯函数:不改 `original`、不改 `form`。
   */
  function mergeStatePayload (original, form, now) {
    const src = isObj(original) ? original : EMPTY_STATE
    const out = Object.assign({}, src)
    const f = isObj(form) ? form : {}
    out.schemaRev = SCHEMA_REV
    for (const d of STATE_NUM_FIELDS) out[d.key] = numOrNull(f[d.key])
    for (const d of STATE_TEXT_FIELDS) out[d.key] = blankToNull(f[d.key])
    out.emotionVector = vectorFromForm(f.emotionVector)
    out.updatedAt = stampOf(now)
    return out
  }

  /**
   * 词库:盘上原对象 + 表单 → **PUT 的完整载荷**。
   * 同样原对象一个字段都不丢,只覆盖本页管的那几项 + `schemaRev` / `updatedAt`。
   * 纯函数:不改 `original`、不改 `form`。
   */
  function mergeLexiconPayload (original, form, now) {
    const src = isObj(original) ? original : EMPTY_LEXICON
    const out = Object.assign({}, src)
    const f = isObj(form) ? form : {}
    out.schemaRev = SCHEMA_REV
    out.synonymGroups = normalizeGroups(f.synonymGroups)
    out.timeWords = timeWordsFromRows(f.timeWords)
    for (const d of LEXICON_TAG_FIELDS) out[d.key] = tagsOf(f[d.key])
    out.updatedAt = stampOf(now)
    return out
  }

  /**
   * 失败信息 → 一行页面话(内联显示,**不用 alert**)。
   * 吃两种:reject 的那个对象(带 `payload`),或者 `payload` 本身。
   */
  function errText (err) {
    const payload = (isObj(err) && isObj(err.payload)) ? err.payload : err
    if (isObj(payload)) {
      if (Array.isArray(payload.errors) && payload.errors.length > 0) return payload.errors.join(' / ')
      if (typeof payload.error === 'string' && payload.error !== '') return payload.error
    }
    return '保存失败 —— 看看服务端日志,或刷新页面重试'
  }

  /** 读回包 → 盘上那份对象(坏文件 / `exists:false` ⇒ `template` 打底,再退到本地空模板)。 */
  function baseValue (res, fallback) {
    const d = isObj(res) ? res : {}
    if (isObj(d.value)) return d.value
    if (isObj(d.template)) return d.template
    return Object.assign({}, fallback)
  }

  /* ── DOM:小工具 ──────────────────────────────────────────── */

  /** 建一个节点(一律 `textContent`,不拼 HTML —— 不留 XSS 坏习惯)。 */
  function mk (doc, tag, cls, text) {
    const node = doc.createElement(tag)
    if (cls !== undefined && cls !== '') node.className = cls
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  /** 输入框当前值(桩 / 真 DOM 都给字符串)。 */
  function valOf (input) {
    return String((input === null || input === undefined || input.value === undefined) ? '' : input.value)
  }

  /** 一行弹性排布(输入框 + 删 按钮那种)。 */
  function flexRow (doc, cls) {
    const row = mk(doc, 'div', cls === undefined ? '' : cls)
    row.style.display = 'flex'
    row.style.gap = '6px'
    row.style.alignItems = 'center'
    return row
  }

  /** 重画序号:同一个 `el` 上后一次 draw 作废前一次的回包(幂等的另一半)。 */
  const gens = new WeakMap()
  let seq = 0

  /* ── 页面 ───────────────────────────────────────────────── */

  /**
   * 画这一页。`el` = 该页的 `<section>`;`api` = 主控注入(契约 §3.1)。
   * 幂等:先清空再建;并且每次 draw 都发一个序号,老回包回来发现序号变了就丢掉。
   */
  function draw (el, api) {
    if (el === null || el === undefined || typeof el.appendChild !== 'function') return
    const doc = el.ownerDocument || (typeof document === 'undefined' ? null : document)
    if (doc === null || doc === undefined || typeof doc.createElement !== 'function') return
    const myGen = (seq += 1)
    gens.set(el, myGen)
    const stale = function () { return gens.get(el) !== myGen }
    el.textContent = ''

    const hasApi = isObj(api)
    const canGet = hasApi && typeof api.get === 'function'
    const canPut = hasApi && typeof api.put === 'function'

    function report (box, err) {
      if (stale()) return
      box.textContent = errText(err)
      box.style.display = ''
    }

    function clearErr (box) {
      box.textContent = ''
      box.style.display = 'none'
    }

    /** 保存收尾:成功 → 生效文案 → 重画本页。 */
    function saved () {
      if (stale()) return
      if (typeof api.toast === 'function') api.toast(EFFECTIVE_TEXT, 'ok')
      if (typeof api.reload === 'function') api.reload()
    }

    /* ── 页头:两个文件、两次保存、各存各的 ─────────────────── */

    const intro = mk(doc, 'p', 'hint')
    intro.appendChild(mk(doc, 'b', '', '这一页管两份数据,各存各的:'))
    intro.appendChild(mk(doc, 'span', '', ' 上半是「状态初值」(新状态的初值 / 兜底 —— 库里已经有值时以库里的为准);'
      + '下半是「词库」(程序不再内置的那部分词表)。两个保存按钮互不相干,存哪个只动哪个文件。'))
    el.appendChild(intro)

    /* ── ① 状态初值 ───────────────────────────────────────── */

    const cardA = mk(doc, 'div', 'card')
    cardA.appendChild(mk(doc, 'div', 'cfg-name', '状态初值'))
    cardA.appendChild(mk(doc, 'div', 'hint', '这些是**初值 / 兜底**:状态库里已经有值时,一律以库里的为准。'
      + '数字留空 ⇒ null(不写 0);空着不是错,就是「还没填」。'))
    const bodyA = mk(doc, 'div', 'cfg-form')
    cardA.appendChild(bodyA)

    const numInputs = {}
    for (const f of STATE_NUM_FIELDS) {
      const row = mk(doc, 'div', 'cfg-row')
      row.appendChild(mk(doc, 'div', 'cfg-name', f.label))
      const input = mk(doc, 'input', 'cfg-input')
      input.type = 'number'
      input.setAttribute('step', 'any')
      input.setAttribute('data-field', f.key)
      row.appendChild(input)
      row.appendChild(mk(doc, 'div', 'cfg-hint', f.hint))
      bodyA.appendChild(row)
      numInputs[f.key] = input
    }

    const textInputs = {}
    for (const f of STATE_TEXT_FIELDS) {
      const row = mk(doc, 'div', 'cfg-row')
      row.appendChild(mk(doc, 'div', 'cfg-name', f.label))
      const input = mk(doc, 'input', 'cfg-input')
      input.type = 'text'
      input.setAttribute('data-field', f.key)
      row.appendChild(input)
      row.appendChild(mk(doc, 'div', 'cfg-hint', f.hint))
      bodyA.appendChild(row)
      textInputs[f.key] = input
    }

    /** 7 维:分组铺(维度名照 lib/emotion.js),每维一个数字框。 */
    const dimInputs = {}
    for (const g of EMOTION_GROUPS) {
      const row = mk(doc, 'div', 'cfg-row')
      row.appendChild(mk(doc, 'div', 'cfg-name', '情绪向量 · ' + g.label))
      const inner = mk(doc, 'div', '')
      dimInputs[g.key] = {}
      for (const d of g.dims) {
        const line = flexRow(doc, '')
        line.appendChild(mk(doc, 'span', 'cfg-hint', d.label))
        const input = mk(doc, 'input', 'cfg-input')
        input.type = 'number'
        input.setAttribute('step', 'any')
        input.setAttribute('data-field', 'emotionVector')
        input.setAttribute('data-group', g.key)
        input.setAttribute('data-dim', d.key)
        line.appendChild(input)
        inner.appendChild(line)
        dimInputs[g.key][d.key] = input
      }
      row.appendChild(inner)
      row.appendChild(mk(doc, 'div', 'cfg-hint', '这一组 7 维里的 ' + g.dims.length + ' 维;留空 ⇒ null(程序按默认值走)。'))
      bodyA.appendChild(row)
    }

    const errA = mk(doc, 'div', 'hint err')
    clearErr(errA)

    /** 页面 → ① 的表单值。 */
    function readStateForm () {
      const form = {}
      for (const f of STATE_NUM_FIELDS) form[f.key] = valOf(numInputs[f.key])
      for (const f of STATE_TEXT_FIELDS) form[f.key] = valOf(textInputs[f.key])
      const vec = {}
      for (const g of EMOTION_GROUPS) {
        vec[g.key] = {}
        for (const d of g.dims) vec[g.key][d.key] = valOf(dimInputs[g.key][d.key])
      }
      form.emotionVector = vec
      return form
    }

    /** 盘上的值 → ① 的表单。 */
    let currentState = null
    function fillState (value) {
      currentState = value
      const v = isObj(value) ? value : {}
      for (const f of STATE_NUM_FIELDS) {
        const n = numOrNull(v[f.key])
        numInputs[f.key].value = n === null ? '' : String(n)
      }
      for (const f of STATE_TEXT_FIELDS) textInputs[f.key].value = strOf(v[f.key])
      const vec = isObj(v.emotionVector) ? v.emotionVector : {}
      for (const g of EMOTION_GROUPS) {
        const gv = isObj(vec[g.key]) ? vec[g.key] : {}
        for (const d of g.dims) {
          const n = numOrNull(gv[d.key])
          dimInputs[g.key][d.key].value = n === null ? '' : String(n)
        }
      }
    }

    /** 保存 ①:只 PUT 状态初值那一份(不碰词库)。 */
    function saveState () {
      clearErr(errA)
      if (!canPut) {
        errA.textContent = '数据通道还没接上,先别急着存'
        errA.style.display = ''
        return
      }
      const payload = mergeStatePayload(currentState, readStateForm())
      let p
      try {
        p = api.put(STATE_PATH, payload)
      } catch (e) { report(errA, e); return }
      Promise.resolve(p).then(saved, function (err) { report(errA, err) })
    }

    const footA = mk(doc, 'div', 'fw')
    const saveA = mk(doc, 'button', 'btn', '保存状态初值')
    saveA.type = 'button'
    saveA.addEventListener('click', function () { saveState() })
    footA.appendChild(saveA)
    footA.appendChild(mk(doc, 'div', 'hint', '只写状态初值那一份。保存后:' + EFFECTIVE_TEXT))
    cardA.appendChild(footA)
    cardA.appendChild(errA)
    el.appendChild(cardA)

    /* ── ② 词库 ───────────────────────────────────────────── */

    const cardB = mk(doc, 'div', 'card')
    cardB.appendChild(mk(doc, 'div', 'cfg-name', '词库'))
    cardB.appendChild(mk(doc, 'div', 'hint', '词库是**程序不再内置**的那部分:同义词组 / 时间词 / 禁词 / 她的兴趣 / 旧称呼 / 停用词。'
      + '留空 = 该项没有数据(**不是**报错)。'))
    const bodyB = mk(doc, 'div', 'cfg-form')
    cardB.appendChild(bodyB)

    /** 同义词组:一行一组(组内逗号 / 顿号 / 空格分隔)。 */
    const rowSyn = mk(doc, 'div', 'cfg-row')
    rowSyn.appendChild(mk(doc, 'div', 'cfg-name', '同义词组'))
    const synArea = mk(doc, 'textarea', 'cfg-input')
    synArea.setAttribute('data-field', 'synonymGroups')
    synArea.setAttribute('rows', '4')
    rowSyn.appendChild(synArea)
    rowSyn.appendChild(mk(doc, 'div', 'cfg-hint', '一行一组,组内用逗号 / 顿号 / 空格分隔(例:「哥, <称呼>」一行);一个词的组也行,程序会校验。'))
    bodyB.appendChild(rowSyn)

    /** 时间词:键 + 值,成对的键值编辑器。 */
    const twBox = mk(doc, 'div', '')
    const rowTw = mk(doc, 'div', 'cfg-row')
    rowTw.appendChild(mk(doc, 'div', 'cfg-name', '时间词'))
    const twInner = mk(doc, 'div', '')
    twInner.appendChild(twBox)
    const twAdd = mk(doc, 'button', 'btn ghost', '+ 添加一行')
    twAdd.type = 'button'
    twInner.appendChild(twAdd)
    rowTw.appendChild(twInner)
    rowTw.appendChild(mk(doc, 'div', 'cfg-hint', '键对齐时间线索的 6 张表(单日 / 时段 / 秒级 / 时钟 / 节日 / 模糊);值原样存,程序侧解析。'))
    bodyB.appendChild(rowTw)

    const tw = { rows: [], values: [] }

    function syncTw () { tw.values = tw.rows.map(function (r) { return { key: valOf(r.key), value: valOf(r.value) } }) }

    function paintTw () {
      twBox.textContent = ''
      tw.rows = []
      const list = tw.values.length > 0 ? tw.values : [{ key: '', value: '' }]
      for (const item of list) {
        const line = flexRow(doc, '')
        const ki = mk(doc, 'input', 'cfg-input')
        ki.type = 'text'
        ki.value = item.key
        ki.setAttribute('data-field', 'timeWords.key')
        const vi = mk(doc, 'input', 'cfg-input')
        vi.type = 'text'
        vi.value = item.value
        vi.setAttribute('data-field', 'timeWords.value')
        const del = mk(doc, 'button', 'btn ghost', '删')
        del.type = 'button'
        del.addEventListener('click', function () {
          syncTw()
          const i = tw.rows.indexOf(rec)
          if (i >= 0) tw.values.splice(i, 1)
          paintTw()
        })
        const rec = { key: ki, value: vi }
        line.appendChild(ki)
        line.appendChild(vi)
        line.appendChild(del)
        twBox.appendChild(line)
        tw.rows.push(rec)
      }
    }

    twAdd.addEventListener('click', function () {
      syncTw()
      tw.values.push({ key: '', value: '' })
      paintTw()
    })
    paintTw()

    /** 四个 `string[]`:标签式列表编辑器(可增删行)。 */
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
        const line = flexRow(doc, '')
        const input = mk(doc, 'input', 'cfg-input')
        input.type = 'text'
        input.value = v
        input.setAttribute('data-field', key)
        const del = mk(doc, 'button', 'btn ghost', '删')
        del.type = 'button'
        del.addEventListener('click', function () {
          syncTag(key)
          const i = st.inputs.indexOf(input)
          if (i >= 0) st.values.splice(i, 1)
          paintTag(key)
        })
        line.appendChild(input)
        line.appendChild(del)
        st.body.appendChild(line)
        st.inputs.push(input)
      }
    }

    for (const f of LEXICON_TAG_FIELDS) {
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
      bodyB.appendChild(row)
      tagState[f.key] = { body: listBox, inputs: [], values: [] }
      paintTag(f.key)
    }

    const errB = mk(doc, 'div', 'hint err')
    clearErr(errB)

    /** 页面 → ② 的表单值。 */
    function readLexiconForm () {
      syncTw()
      const form = { synonymGroups: valOf(synArea), timeWords: tw.values.slice() }
      for (const f of LEXICON_TAG_FIELDS) {
        syncTag(f.key)
        form[f.key] = tagState[f.key].values
      }
      return form
    }

    /** 盘上的值 → ② 的表单。 */
    let currentLexicon = null
    function fillLexicon (value) {
      currentLexicon = value
      const v = isObj(value) ? value : {}
      synArea.value = groupsToText(v.synonymGroups)
      tw.values = timeRowsFrom(v.timeWords)
      paintTw()
      for (const f of LEXICON_TAG_FIELDS) {
        tagState[f.key].values = tagsOf(v[f.key])
        paintTag(f.key)
      }
    }

    /** 保存 ②:只 PUT 词库那一份(不碰状态初值)。 */
    function saveLexicon () {
      clearErr(errB)
      if (!canPut) {
        errB.textContent = '数据通道还没接上,先别急着存'
        errB.style.display = ''
        return
      }
      const payload = mergeLexiconPayload(currentLexicon, readLexiconForm())
      let p
      try {
        p = api.put(LEXICON_PATH, payload)
      } catch (e) { report(errB, e); return }
      Promise.resolve(p).then(saved, function (err) { report(errB, err) })
    }

    const footB = mk(doc, 'div', 'fw')
    const saveB = mk(doc, 'button', 'btn', '保存词库')
    saveB.type = 'button'
    saveB.addEventListener('click', function () { saveLexicon() })
    footB.appendChild(saveB)
    footB.appendChild(mk(doc, 'div', 'hint', '只写词库那一份。保存后:' + EFFECTIVE_TEXT))
    cardB.appendChild(footB)
    cardB.appendChild(errB)
    el.appendChild(cardB)

    /* ── 取数:两份各读各的 ───────────────────────────────── */

    // 没有可用 api(单测 / 页面没注入)⇒ 用空模板打底,页面结构照样在。
    if (!canGet) {
      fillState(baseValue(null, EMPTY_STATE))
      fillLexicon(baseValue(null, EMPTY_LEXICON))
      return
    }
    let gotA
    try {
      gotA = api.get(STATE_PATH)
    } catch (e) { report(errA, e); gotA = null }
    if (gotA !== null) {
      Promise.resolve(gotA).then(function (res) {
        if (stale()) return
        fillState(baseValue(res, EMPTY_STATE))
      }, function (err) { report(errA, err) })
    }
    let gotB
    try {
      gotB = api.get(LEXICON_PATH)
    } catch (e) { report(errB, e); gotB = null }
    if (gotB !== null) {
      Promise.resolve(gotB).then(function (res) {
        if (stale()) return
        fillLexicon(baseValue(res, EMPTY_LEXICON))
      }, function (err) { report(errB, err) })
    }
  }

  return {
    draw,
    /** 纯逻辑(零 DOM、零 io)—— 单测的入口。 */
    pure: {
      STATE_PATH,
      LEXICON_PATH,
      EFFECTIVE_TEXT,
      SCHEMA_REV,
      EMOTION_GROUPS,
      STATE_NUM_FIELDS,
      STATE_TEXT_FIELDS,
      LEXICON_TAG_FIELDS,
      EMPTY_STATE,
      EMPTY_LEXICON,
      isObj,
      strOf,
      textOf,
      numOrNull,
      blankToNull,
      splitWords,
      groupsFromText,
      groupsToText,
      normalizeGroups,
      tagsFromText,
      tagsOf,
      timeWordsFromRows,
      timeRowsFrom,
      vectorFromForm,
      stampOf,
      mergeStatePayload,
      mergeLexiconPayload,
      errText,
      baseValue
    }
  }
})()
