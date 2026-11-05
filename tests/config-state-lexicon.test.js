/**
 * 配置中心 ⑦ 状态与词库页(`web/views/state-lexicon.js`,P2 / B3-C)的单测。
 *
 * 四条纪律钉住(照 tests/config-profile.test.js 的先例):
 *   ① **契约扫描**:classic script、无 fetch、无弹窗、不碰文件系统;两个端点与生效文案都在;
 *      **只许出现它管的那两个数据文件名**(state-defaults / lexicon),别的文件一个都不许露头;
 *   ② **纯逻辑**:数字口径、同义词组往返、两份载荷各归一(未管字段一个不丢、不串文件);
 *   ③ **桩 + 幂等**:DOM 桩只验"画了几笔、值对不对、画两遍不翻倍"——
 *      诚实标注:它**不是**浏览器 DOM,不验样式与真实布局;
 *   ④ **两次保存各写各的**(本页最容易串的一条):保存状态只 PUT 状态,保存词库只 PUT 词库。
 *
 * 加载方式:页面文件是 classic script,所以把源码喂给 `new Function('globalThis', src)`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../web/views/state-lexicon.js', import.meta.url)), 'utf8')
const sandbox = {}
new Function('globalThis', src)(sandbox) // eslint-disable-line no-new-func
const V = sandbox.EchoViews && sandbox.EchoViews['state-lexicon']
const P = V.pure

/** 等一轮 macro task:draw 的回包填充走微任务,等一拍最稳。 */
const tick = () => new Promise((resolve) => setImmediate(resolve))

/** 本页管的两个文件(自测里只许出现这两个名字)。 */
const STATE_FILE = 'state-defaults.json'
const LEXICON_FILE = 'lexicon.json'

/* ── ① 契约扫描 ─────────────────────────────────────────────── */

test('契约扫描:classic script、无 fetch / 无弹窗 / 不碰文件系统;两个端点与生效文案都在', () => {
  assert.doesNotMatch(src, /fetch\s*\(/, '视图不许自己发请求(取数只走 api)')
  assert.doesNotMatch(src, /^\s*(import|export)\b/m, 'classic script:不许模块语法')
  assert.doesNotMatch(src, /alert\s*\(/, '校验失败必须内联显示,不许弹窗')
  assert.doesNotMatch(src, /node:fs|writeFileSync|resolveDataFilePath|require\s*\(|\.dsh[\\/]echo/,
    '视图不许出现文件系统路径 / 裸写盘(唯一写路是 API)')
  assert.match(src, /\/api\/echo\/data\/state-defaults\.json/, '状态初值的唯一读写端点')
  assert.match(src, /\/api\/echo\/data\/lexicon\.json/, '词库的唯一读写端点')
  assert.match(src, /下次引擎调用生效/, '生效文案取自契约 §4(next-engine-call),不许自创')
  assert.doesNotMatch(src, /已生效,刷新页面看界面/, '这是 now 那一句,本页两份数据都是 next-engine-call')
  assert.doesNotMatch(src, /(config|persona|profile|aliases|names|graph|data-rev)\.json/,
    '这一页只许碰它管的两个数据文件')
  assert.notEqual(V, undefined, 'EchoViews[\'state-lexicon\'] 得挂上')
  assert.equal(typeof V.draw, 'function', 'draw 必须是函数')
  for (const k of ['numOrNull', 'groupsFromText', 'groupsToText', 'mergeStatePayload', 'mergeLexiconPayload', 'errText']) {
    assert.equal(typeof P[k], 'function', '纯逻辑 ' + k + ' 得挂出来')
  }
  // 7 维按 lib/emotion.js 铺:两组、共 7 维
  const dims = P.EMOTION_GROUPS.reduce((n, g) => n + g.dims.length, 0)
  assert.equal(dims, 7, '情绪向量必须是 7 维')
  assert.deepEqual(P.EMOTION_GROUPS.map((g) => g.key), ['global', 'target_master'])
  assert.deepEqual(P.EMOTION_GROUPS[1].dims.map((d) => d.key), ['affection', 'playfulness', 'sadness', 'dependency'])
})

/* ── ② 纯逻辑 ────────────────────────────────────────────── */

test('numOrNull:空 / 非数字 ⇒ null(绝不写 0);`0` 是真的值', () => {
  for (const v of ['', '   ', null, undefined, 'x', 'abc', NaN, Infinity, {}, []]) {
    assert.equal(P.numOrNull(v), null, '应当算空:' + String(v))
  }
  assert.equal(P.numOrNull('0'), 0, '0 是填过的值,不是空')
  assert.equal(P.numOrNull('3.5'), 3.5)
  assert.equal(P.numOrNull(' -2 '), -2)
  assert.equal(P.numOrNull(7), 7)
  assert.equal(P.numOrNull('1e3'), 1000)
})

test('groupsFromText / groupsToText:逗号 / 顿号 / 空格分隔;去重去空;往返闭合', () => {
  assert.deepEqual(P.groupsFromText('甲,乙\n丙、丁 戊'), [['甲', '乙'], ['丙', '丁', '戊']])
  assert.deepEqual(P.groupsFromText(' a , , a , b \n\n  \n c '), [['a', 'b'], ['c']], '空行丢掉、组内去重去空')
  assert.deepEqual(P.groupsFromText('只一个'), [['只一个']], '一个词的组也保留(该由程序去说他)')
  assert.deepEqual(P.groupsFromText('甲,乙\n甲、乙\n丙'), [['甲', '乙'], ['丙']], '整组重复只留第一次')
  assert.deepEqual(P.groupsFromText(''), [])
  assert.deepEqual(P.groupsFromText(null), [])
  assert.equal(P.groupsToText([['甲', '乙'], ['丙']]), '甲, 乙\n丙')
  assert.equal(P.groupsToText(null), '')
  const g = [['哥', ' 阿岚 ', '哥'], ['妈'], []]
  assert.deepEqual(P.groupsFromText(P.groupsToText(g)), [['哥', '阿岚'], ['妈']], '往返闭合(归一)')
  assert.deepEqual(P.normalizeGroups(P.groupsToText(g)), [['哥', '阿岚'], ['妈']])
  assert.deepEqual(P.normalizeGroups([['甲', '乙']]), [['甲', '乙']], '组字段也吃数组')
  assert.deepEqual(P.normalizeGroups('甲、乙'), [['甲', '乙']])
})

test('tagsOf / timeWordsFromRows:列表归一与键值归一(去重、空键丢、防原型污染)', () => {
  assert.deepEqual(P.tagsOf('禁一, 禁二\n禁一'), ['禁一', '禁二'])
  assert.deepEqual(P.tagsOf(['a ', '', 'a', 'b']), ['a', 'b'])
  assert.deepEqual(P.tagsOf(null), [])
  assert.deepEqual(P.timeWordsFromRows([{ key: ' 今天 ', value: ' 0 ' }, { key: '', value: 'x' }, { key: '今天', value: '9' }, { key: '明天', value: '1' }]),
    { 今天: '0', 明天: '1' }, '空键丢、重复键先到的赢')
  assert.deepEqual(P.timeWordsFromRows({ a: 1, b: 'x' }), { a: '1', b: 'x' }, '现成对象也吃(数字转文本)')
  assert.deepEqual(P.timeWordsFromRows([{ key: '__proto__', value: 'x' }]), {}, '__proto__ 直接跳过')
  assert.deepEqual(P.timeWordsFromRows(null), {})
  assert.deepEqual(P.timeRowsFrom({ 今天: '0', 昨天: -1 }), [{ key: '今天', value: '0' }, { key: '昨天', value: '-1' }])
  assert.deepEqual(P.timeRowsFrom(null), [])
})

test('errText:errors[] 优先,其次 error,再不行给一句人话', () => {
  assert.equal(P.errText({ payload: { status: 400, errors: ['a', 'b'] } }), 'a / b')
  assert.equal(P.errText({ errors: ['x'] }), 'x')
  assert.equal(P.errText({ payload: { error: 'invalid' } }), 'invalid')
  assert.match(P.errText(null), /保存失败/)
  assert.match(P.errText({ payload: {} }), /保存失败/)
})

test('baseValue:好文件原样给;坏文件 / exists:false ⇒ 服务端 template 打底', () => {
  assert.equal(P.baseValue({ exists: false, value: null, template: { schemaRev: 1, moodIntensity: 3 } }, P.EMPTY_STATE).moodIntensity, 3)
  assert.equal(P.baseValue({ value: { b: 2 }, template: { a: 1 } }, P.EMPTY_STATE).b, 2)
  assert.equal(P.baseValue({ unreadable: true, value: null, raw: '{', parseError: 'x' }, P.EMPTY_LEXICON).schemaRev, 1)
  assert.equal(P.baseValue(null, P.EMPTY_STATE).energy, null)
})

test('mergeStatePayload:数字口径 + 7 维按维度铺;未管字段一个不丢;不改入参', () => {
  const original = {
    schemaRev: 1,
    moodIntensity: 7,
    prevMoodIntensity: 6,
    userEmotion: '平静',
    emotionVector: { global: { fatigue: 1, valence: 2, arousal: 3 }, target_master: { affection: 8, playfulness: 7, sadness: 0, dependency: 6 } },
    affinity: 5,
    longing: 4,
    energy: 9,
    updatedAt: '2026-10-05T00:00:00.000Z',
    futureKey: '别丢'
  }
  const before = JSON.parse(JSON.stringify(original))
  const payload = P.mergeStatePayload(original, {
    moodIntensity: '3.5',
    prevMoodIntensity: '',
    userEmotion: ' 开心 ',
    emotionVector: { global: { fatigue: '1', valence: '', arousal: 'x' }, target_master: { affection: '10', playfulness: '', sadness: '', dependency: '' } },
    affinity: '0',
    longing: 'x',
    energy: null
  }, '2026-10-05T12:00:00.000Z')
  assert.equal(payload.schemaRev, 1)
  assert.equal(payload.updatedAt, '2026-10-05T12:00:00.000Z', 'savedAt 用新时间')
  assert.equal(payload.moodIntensity, 3.5)
  assert.equal(payload.prevMoodIntensity, null, '空 ⇒ null,不写 0')
  assert.equal(payload.userEmotion, '开心', '文本字段 trim')
  assert.equal(payload.affinity, 0, '0 是真的值')
  assert.equal(payload.longing, null, '不是数字 ⇒ null')
  assert.equal(payload.energy, null)
  assert.deepEqual(payload.emotionVector, {
    global: { fatigue: 1, valence: null, arousal: null },
    target_master: { affection: 10, playfulness: null, sadness: null, dependency: null }
  }, '7 维逐项铺;空维 null')
  assert.equal(payload.futureKey, '别丢', '未管字段原样带回')
  assert.equal(Object.keys(payload).length, Object.keys(original).length, '不多不少,就是原来那些键 + 覆盖')
  assert.deepEqual(original, before, '纯函数:不许改调用方那份对象')
  // 空模板兜底 + 7 维全空 ⇒ null
  const empty = P.mergeStatePayload(null, {})
  assert.equal(empty.schemaRev, 1)
  assert.equal(empty.moodIntensity, null)
  assert.equal(empty.userEmotion, null)
  assert.equal(empty.emotionVector, null, '7 维全空 ⇒ null(与空模板一致)')
  assert.equal(typeof empty.updatedAt, 'string', '没给 now ⇒ 用此刻')
})

test('mergeLexiconPayload:三套编辑器各归一;未管字段不丢;不串状态那份', () => {
  const original = {
    schemaRev: 1,
    synonymGroups: [['旧']],
    timeWords: { 今天: '0' },
    bannedWords: ['旧禁'],
    herInterests: [],
    retiredAliases: ['小e'],
    stopwords: ['的'],
    topicStopwords: ['今天'],
    updatedAt: '2026-10-05T00:00:00.000Z',
    futureKey: '别丢'
  }
  const before = JSON.parse(JSON.stringify(original))
  const payload = P.mergeLexiconPayload(original, {
    synonymGroups: '哥, 阿岚\n妈、妈妈\n哥, 阿岚\n\n只一个',
    timeWords: [{ key: ' 今天 ', value: ' 0 ' }, { key: '', value: 'x' }, { key: '明天', value: '1' }, { key: '今天', value: '9' }],
    bannedWords: '禁一, 禁二\n禁一',
    herInterests: ['画画 ', ''],
    retiredAliases: '',
    stopwords: [],
    topicStopwords: ' 火车 \n火车\n'
  }, '2026-10-05T12:00:00.000Z')
  assert.equal(payload.schemaRev, 1)
  assert.equal(payload.updatedAt, '2026-10-05T12:00:00.000Z')
  assert.deepEqual(payload.synonymGroups, [['哥', '阿岚'], ['妈', '妈妈'], ['只一个']])
  assert.deepEqual(payload.timeWords, { 今天: '0', 明天: '1' })
  assert.deepEqual(payload.bannedWords, ['禁一', '禁二'])
  assert.deepEqual(payload.herInterests, ['画画'])
  assert.deepEqual(payload.retiredAliases, [])
  assert.deepEqual(payload.stopwords, [])
  assert.deepEqual(payload.topicStopwords, ['火车'], '话题停用词也走同一套标签归一(去空行 / 去重)')
  assert.equal(payload.futureKey, '别丢', '未管字段原样带回')
  for (const k of ['moodIntensity', 'emotionVector', 'affinity', 'longing', 'energy']) {
    assert.equal(Object.prototype.hasOwnProperty.call(payload, k), false, '词库那份不许带状态字段:' + k)
  }
  assert.equal(Object.keys(payload).length, Object.keys(original).length, '不多不少')
  assert.deepEqual(original, before, '纯函数:不许改调用方那份对象')
  // 空模板兜底
  const empty = P.mergeLexiconPayload(null, {})
  assert.deepEqual(empty.synonymGroups, [])
  assert.deepEqual(empty.timeWords, {})
  assert.deepEqual(empty.stopwords, [])
  assert.deepEqual(empty.topicStopwords, [], '空模板兜底:面板摸得到这个键(否则"留空 = 回语言默认表"就无从表达)')
})

/* ── ③ DOM 桩 + 幂等 ─────────────────────────────────────── */

/**
 * 极简 DOM 桩:够跑 draw(`createElement` / `textContent` / `appendChild` / `parentNode` /
 * `addEventListener` / `value` / `style` / `setAttribute`)。
 * **诚实标注**:它不是浏览器 DOM —— 只验结构笔数与取值,不验布局与样式。
 */
function stubDoc () {
  const node = (tag) => {
    let text = ''
    const n = {
      tagName: tag, className: '', value: '', type: '', placeholder: '',
      style: {}, children: [], parentNode: null, attrs: {}, handlers: {},
      setAttribute (k, v) { n.attrs[k] = String(v) },
      getAttribute (k) { return n.attrs[k] },
      appendChild (c) { c.parentNode = n; n.children.push(c); return c },
      removeChild (c) { const i = n.children.indexOf(c); if (i >= 0) n.children.splice(i, 1); c.parentNode = null; return c },
      addEventListener (kind, fn) { (n.handlers[kind] = n.handlers[kind] || []).push(fn) },
      click () { for (const fn of (n.handlers.click || [])) fn() }
    }
    Object.defineProperty(n, 'textContent', {
      get () { return text },
      set (v) { text = String(v); n.children.length = 0 } // 真 DOM 里也是这么替换子节点的
    })
    return n
  }
  return { createElement: node }
}

/** 子树摊平(含自己)。 */
function flatten (node) {
  const out = []
  const go = (x) => { out.push(x); for (const c of x.children) go(c) }
  go(node)
  return out
}

const stateValue = () => ({
  schemaRev: 1,
  moodIntensity: 7,
  prevMoodIntensity: 6,
  userEmotion: '平静',
  emotionVector: { global: { fatigue: 1, valence: 2, arousal: 3 }, target_master: { affection: 8, playfulness: 7, sadness: 0, dependency: 6 } },
  affinity: 5,
  longing: 4,
  energy: 9,
  updatedAt: '2026-10-05T00:00:00.000Z',
  futureKey: '别丢'
})

const lexiconValue = () => ({
  schemaRev: 1,
  synonymGroups: [['哥', '阿岚'], ['妈', '妈妈']],
  timeWords: { 今天: '0', 昨天: '-1' },
  bannedWords: ['禁一'],
  herInterests: ['画画'],
  retiredAliases: ['小e'],
  stopwords: ['的'],
  updatedAt: '2026-10-05T00:00:00.000Z',
  futureKey: '别丢'
})

/** 一套桩:一个 `<section>` + 记账用的 api(两份数据各自回各自的包)。 */
function harness (opts) {
  const opt = opts || {}
  const doc = stubDoc()
  const el = doc.createElement('section')
  el.ownerDocument = doc
  const calls = []
  const reply = (file, kind) => {
    const given = opt[kind + 'Reply']
    if (given !== undefined) return given
    return { file: file, exists: true, value: kind === 'state' ? stateValue() : lexiconValue(), bytes: 120 }
  }
  const api = {
    get (path) {
      calls.push(['get', path])
      if (path === P.STATE_PATH) {
        if (opt.getStateError) return Promise.reject(opt.getStateError)
        return Promise.resolve(reply(STATE_FILE, 'state'))
      }
      if (path === P.LEXICON_PATH) {
        if (opt.getLexiconError) return Promise.reject(opt.getLexiconError)
        return Promise.resolve(reply(LEXICON_FILE, 'lexicon'))
      }
      return Promise.reject({ status: 404, payload: { error: 'wut' } })
    },
    put (path, body) {
      calls.push(['put', path, body])
      if (opt.putError) return Promise.reject(opt.putError)
      return Promise.resolve({ ok: true, file: path.split('/').pop(), effective: 'next-engine-call' })
    },
    toast (text, kind) { calls.push(['toast', text, kind]) },
    reload () { calls.push(['reload']) }
  }
  const fieldsOf = (field) => flatten(el).filter((x) => x.attrs['data-field'] === field)
  const dimOf = (group, dim) => flatten(el).filter((x) => x.attrs['data-group'] === group && x.attrs['data-dim'] === dim)
  const findByClass = (cls) => flatten(el).filter((x) => x.className === cls)
  const findByText = (tag, text) => flatten(el).find((x) => x.tagName === tag && x.textContent === text)
  /** 某个 cfg-row(按 cfg-name 的文案找)。 */
  const rowOf = (label) => {
    const name = flatten(el).find((x) => x.className === 'cfg-name' && x.textContent === label)
    let n = name
    while (n !== undefined && n !== null && n.className !== 'cfg-row') n = n.parentNode
    return n
  }
  const btnIn = (label, text) => {
    const row = rowOf(label)
    if (row === undefined || row === null) return undefined
    return flatten(row).find((x) => x.tagName === 'button' && x.textContent === text)
  }
  return { doc, el, api, calls, fieldsOf, dimOf, findByClass, findByText, rowOf, btnIn }
}

test('draw:两个块都画出来,值填得对;两次 draw 不叠加;无 api 也不炸', async () => {
  const h = harness()
  V.draw(h.el, h.api)
  await tick()
  // 两个块
  assert.equal(h.findByClass('card').length, 2, '上下两块:状态初值 + 词库')
  assert.equal(h.findByClass('hint err').length, 2, '两个块各带一个错误槽(平时空着)')
  // ① 状态初值
  assert.equal(h.fieldsOf('moodIntensity')[0].value, '7')
  assert.equal(h.fieldsOf('prevMoodIntensity')[0].value, '6')
  assert.equal(h.fieldsOf('affinity')[0].value, '5')
  assert.equal(h.fieldsOf('userEmotion')[0].value, '平静')
  assert.equal(h.dimOf('global', 'fatigue')[0].value, '1')
  assert.equal(h.dimOf('global', 'valence')[0].value, '2')
  assert.equal(h.dimOf('target_master', 'sadness')[0].value, '0', '0 要显示成 0(不是空)')
  assert.equal(h.dimOf('target_master', 'dependency')[0].value, '6')
  // ② 词库
  assert.equal(h.fieldsOf('synonymGroups')[0].value, '哥, 阿岚\n妈, 妈妈', '一行一组')
  assert.equal(h.fieldsOf('timeWords.key').length, 2)
  assert.equal(h.fieldsOf('timeWords.key')[0].value, '今天')
  assert.equal(h.fieldsOf('timeWords.value')[0].value, '0')
  assert.equal(h.fieldsOf('bannedWords')[0].value, '禁一')
  assert.equal(h.fieldsOf('herInterests')[0].value, '画画')
  assert.equal(h.fieldsOf('retiredAliases')[0].value, '小e')
  assert.equal(h.fieldsOf('stopwords')[0].value, '的')
  // 幂等:再画一次不叠加
  const nodes = flatten(h.el).length
  V.draw(h.el, h.api)
  await tick()
  assert.equal(flatten(h.el).length, nodes, '重画不许叠加(幂等)')
  // 没注入 api:空模板打底,结构照样在
  const bare = stubDoc()
  const bareEl = bare.createElement('section')
  bareEl.ownerDocument = bare
  V.draw(bareEl, null)
  assert.ok(flatten(bareEl).length > 5)
  assert.equal(flatten(bareEl).filter((x) => x.className === 'card').length, 2)
})

test('draw:exists:false ⇒ 用回包 template 打底(不是报错)', async () => {
  const h = harness({
    stateReply: { file: STATE_FILE, exists: false, value: null, bytes: 0, template: { schemaRev: 1, moodIntensity: 3, energy: 2, updatedAt: null } },
    lexiconReply: { file: LEXICON_FILE, exists: false, value: null, bytes: 0, template: { schemaRev: 1, bannedWords: ['模板词'], timeWords: {}, synonymGroups: [] } }
  })
  V.draw(h.el, h.api)
  await tick()
  assert.equal(h.fieldsOf('moodIntensity')[0].value, '3', '用服务端 template 打底')
  assert.equal(h.fieldsOf('energy')[0].value, '2')
  assert.equal(h.fieldsOf('prevMoodIntensity')[0].value, '', '模板里没有的 ⇒ 空,不是猜')
  assert.equal(h.fieldsOf('bannedWords')[0].value, '模板词')
  assert.equal(h.findByClass('hint err')[0].style.display, 'none', '文件不存在不是错,不许报错')
})

test('编辑器:标签列表与键值表都能增删行(空表也留一行)', async () => {
  const h = harness({
    lexiconReply: { file: LEXICON_FILE, exists: false, value: null, bytes: 0, template: { schemaRev: 1, synonymGroups: [], timeWords: {}, bannedWords: [], herInterests: [], retiredAliases: [], stopwords: [] } }
  })
  V.draw(h.el, h.api)
  await tick()
  // 标签列表:空表留一行
  assert.equal(h.fieldsOf('bannedWords').length, 1, '空表也留一行给他直接打字')
  h.btnIn('禁词', '+ 添加一行').click()
  assert.equal(h.fieldsOf('bannedWords').length, 2, '添加一行')
  assert.equal(h.fieldsOf('bannedWords')[1].value, '')
  h.btnIn('禁词', '删').click()
  assert.equal(h.fieldsOf('bannedWords').length, 1, '删掉一行')
  // 键值表:空表留一行 → 加一行 → 填值 → 删
  assert.equal(h.fieldsOf('timeWords.key').length, 1)
  h.btnIn('时间词', '+ 添加一行').click()
  assert.equal(h.fieldsOf('timeWords.key').length, 2)
  h.fieldsOf('timeWords.key')[1].value = '明天'
  h.fieldsOf('timeWords.value')[1].value = '1'
  h.btnIn('时间词', '删').click()
  assert.equal(h.fieldsOf('timeWords.key').length, 1, '删掉一行(剩下的是先填的那行)')
})

test('保存:两个按钮各写各的文件 —— 保存状态只 PUT 状态,保存词库只 PUT 词库', async () => {
  const h = harness()
  V.draw(h.el, h.api)
  await tick()
  h.fieldsOf('moodIntensity')[0].value = '9'
  h.fieldsOf('userEmotion')[0].value = ' 开心 '
  h.dimOf('global', 'valence')[0].value = '3.5'
  h.findByText('button', '保存状态初值').click()
  await tick()
  let puts = h.calls.filter((c) => c[0] === 'put')
  assert.equal(puts.length, 1, '一次保存只发一次 PUT')
  assert.equal(puts[0][1], P.STATE_PATH)
  assert.equal(puts[0][1], '/api/echo/data/' + STATE_FILE, '路径与被写文件必须一致')
  assert.equal(puts[0][2].moodIntensity, 9)
  assert.equal(puts[0][2].userEmotion, '开心')
  assert.equal(puts[0][2].emotionVector.global.valence, 3.5)
  assert.equal(puts[0][2].emotionVector.target_master.affection, 8, '没动的维度也要原样带上')
  assert.equal(puts[0][2].futureKey, '别丢', '未管字段原样带回')
  for (const k of ['synonymGroups', 'timeWords', 'bannedWords', 'herInterests', 'retiredAliases', 'stopwords', 'topicStopwords']) {
    assert.equal(Object.prototype.hasOwnProperty.call(puts[0][2], k), false, '状态那份不许带词库字段:' + k)
  }
  assert.ok(h.calls.some((c) => c[0] === 'toast' && c[1] === '下次引擎调用生效' && c[2] === 'ok'))
  assert.ok(h.calls.some((c) => c[0] === 'reload'), '成功后要重画本页')

  // 再点词库保存:只动词库那一份
  h.fieldsOf('synonymGroups')[0].value = '哥、阿岚'
  h.fieldsOf('bannedWords')[0].value = '禁一, 禁二'
  h.fieldsOf('timeWords.value')[0].value = '1'
  h.findByText('button', '保存词库').click()
  await tick()
  puts = h.calls.filter((c) => c[0] === 'put')
  assert.equal(puts.length, 2, '第二个按钮再发一次 PUT(不是同一个按钮写两份)')
  assert.equal(puts[1][1], P.LEXICON_PATH)
  assert.equal(puts[1][1], '/api/echo/data/' + LEXICON_FILE, '路径与被写文件必须一致')
  assert.deepEqual(puts[1][2].synonymGroups, [['哥', '阿岚']])
  assert.deepEqual(puts[1][2].bannedWords, ['禁一', '禁二'])
  assert.deepEqual(puts[1][2].timeWords, { 今天: '1', 昨天: '-1' }, '键值表改一个值只动那一个')
  assert.equal(puts[1][2].futureKey, '别丢')
  for (const k of ['moodIntensity', 'prevMoodIntensity', 'userEmotion', 'emotionVector', 'affinity', 'longing', 'energy']) {
    assert.equal(Object.prototype.hasOwnProperty.call(puts[1][2], k), false, '词库那份不许带状态字段:' + k)
  }
  // 两次 PUT 的路径与文件一一对应,谁也没串
  assert.deepEqual(puts.map((c) => c[1]), ['/api/echo/data/' + STATE_FILE, '/api/echo/data/' + LEXICON_FILE])
  assert.equal(puts[0][2].schemaRev, 1)
  assert.equal(puts[1][2].schemaRev, 1)
  assert.equal(typeof puts[0][2].updatedAt, 'string', '保存要写新的 updatedAt')
  assert.equal(typeof puts[1][2].updatedAt, 'string')
  const toasts = h.calls.filter((c) => c[0] === 'toast')
  assert.equal(toasts.length, 2, '两次成功各 toast 一次')
  assert.deepEqual(toasts.map((c) => [c[1], c[2]]), [['下次引擎调用生效', 'ok'], ['下次引擎调用生效', 'ok']])
  assert.equal(h.calls.filter((c) => c[0] === 'reload').length, 2)
})

test('保存失败:err.payload.errors[] 内联进 .hint.err,不 toast、不 reload(零 alert)', async () => {
  const h = harness({ putError: { status: 400, payload: { error: 'invalid', errors: ['moodIntensity:类型不是 number'] } } })
  V.draw(h.el, h.api)
  await tick()
  h.findByText('button', '保存状态初值').click()
  await tick()
  const boxes = h.findByClass('hint err')
  assert.match(boxes[0].textContent, /moodIntensity:类型不是 number/, '错误要出现在页面上')
  assert.equal(boxes[0].style.display, '', '出错时错误槽要露出来')
  assert.equal(h.calls.some((c) => c[0] === 'toast'), false, '没存成就不许说生效')
  assert.equal(h.calls.some((c) => c[0] === 'reload'), false)
  // 词库那边自己的错误槽不受影响
  h.findByText('button', '保存词库').click()
  await tick()
  assert.match(h.findByClass('hint err')[1].textContent, /moodIntensity:类型不是 number/)
})
