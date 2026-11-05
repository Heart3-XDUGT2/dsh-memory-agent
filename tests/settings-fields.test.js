import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SETTINGS_FIELDS, derivedPersonaFields } from '../lib/settings-fields.js'
import { personaDigestForDrift } from '../lib/drift.js'
import { SETTINGS_DEFAULTS, normalizeSettings, unknownSettingsKeys } from '../lib/toggle.js'

// 2026-09-26 调参从 DSH 设置区搬去网页仪表盘。搬的时候最容易出的事不是 UI 崩,
// 是**字段表悄悄跟默认值脱钩** —— 现场就抓到过:v0.16.0 加的
// dedupeSimilarity / dedupeSummarySimilarity 两个去重闸,老面板从来没露过脸,
// 只能手改 config.json。所以这里把两边钉在一起:默认值里每个键,字段表里必须
// 出现恰好一次(反之亦然);嵌套子对象(longing / relay)按子键对齐。

/** 把字段表拍成 { 'longing.threshold': field } 这种扁平索引。 */
function indexOfFields (groups = SETTINGS_FIELDS) {
  const out = new Map()
  for (const g of groups) {
    for (const f of g.fields) {
      const key = g.nested === undefined ? f.key : g.nested + '.' + f.key
      if (out.has(key)) throw new Error('字段表里 ' + key + ' 写了两次')
      out.set(key, { group: g.title, nested: g.nested, field: f })
    }
  }
  return out
}

/** 把默认值拍成同一套扁平键。 */
function indexOfDefaults (d = SETTINGS_DEFAULTS) {
  const out = new Map()
  for (const [k, v] of Object.entries(d)) {
    if (v !== null && typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v)) out.set(k + '.' + k2, v2)
    } else out.set(k, v)
  }
  return out
}

test('✓ 字段表 × SETTINGS_DEFAULTS:键集完全对齐(漏一项就是「面板上摸不到」)', () => {
  const fields = indexOfFields()
  const defaults = indexOfDefaults()
  const missing = [...defaults.keys()].filter((k) => !fields.has(k))
  const extra = [...fields.keys()].filter((k) => !defaults.has(k))
  assert.deepEqual(missing, [], '默认值里有、字段表里没有的:' + missing.join('、'))
  assert.deepEqual(extra, [], '字段表里有、默认值里没有的(写错键名?):' + extra.join('、'))
})

test('✓ 现场那两处漏项(dedupe 两个去重闸)现在露脸了', () => {
  const fields = indexOfFields()
  for (const k of ['dedupeSimilarity', 'dedupeSummarySimilarity']) {
    assert.ok(fields.has(k), k + ' 应该在调参面板上')
    assert.equal(fields.get(k).field.type, 'num')
  }
})

test('✓ 类型对得上:布尔→开关,数字→数字框(且范围合法),字符串→文本框', () => {
  const fields = indexOfFields()
  const defaults = indexOfDefaults()
  for (const [key, { field }] of fields) {
    const value = defaults.get(key)
    if (typeof value === 'boolean') {
      assert.equal(field.type, 'bool', key + ' 默认是布尔,面板该给开关而不是 ' + field.type)
    } else if (typeof value === 'number') {
      assert.equal(field.type, 'num', key + ' 默认是数字,面板该给数字框')
      if (field.min !== undefined) assert.ok(field.min <= value, key + ' 的下界比默认值还大,一打开面板就超范围')
      if (field.max !== undefined) assert.ok(field.max >= value, key + ' 的上界比默认值还小,一打开面板就超范围')
    } else {
      assert.ok(field.type === 'text' || field.type === 'password' || field.type === 'textarea',
        key + ' 默认是字符串,面板该给文本框(或 textarea 多行)')
    }
  }
})

test('✓ 每个字段都得有标签与人话提示(提示是给「半年后的他」看的)', () => {
  for (const g of SETTINGS_FIELDS) {
    assert.ok(String(g.title || '') !== '', '有个分组没标题')
    assert.ok(g.fields.length > 0, g.title + ' 是空分组')
    if (g.nested !== undefined) {
      assert.ok(['longing', 'relay', 'bubble', 'compaction', 'say_again', 'agenda', 'reflection', 'proactiveScoring', 'herActivity', 'groupChatPrompts'].includes(g.nested), '未知的嵌套子对象:' + g.nested)
    }
    for (const f of g.fields) {
      assert.ok(String(f.label || '') !== '', g.title + ' 里有字段没标签:' + f.key)
      assert.ok(String(f.hint || '') !== '', f.key + ' 缺人话提示')
      assert.ok(['num', 'bool', 'text', 'password', 'textarea'].includes(f.type), f.key + ' 的类型不认识:' + f.type)
    }
  }
})

test('✓ 字段表只是界面元数据:一个钳位规则都没在这里复制', () => {
  const raw = JSON.stringify(SETTINGS_FIELDS)
  for (const forbidden of ['clamp', 'normalize', 'Math.min', 'Math.max', 'dflt']) {
    assert.equal(raw.includes(forbidden), false, '字段表里出现了 ' + forbidden + ' —— 钳位只许在 toggle.js 一处')
  }
})

test('✓ 老面板的九组字段(除新增的去重闸外)没搬丢', () => {
  const fields = indexOfFields()
  const must = [
    'injectTopK', 'sharedRounds', 'auditKeep', 'memoryTtlDays', 'cleanupEvery',
    'reflectionEnabled', 'driftEnabled', 'driftEvery', 'driftReinforceRounds',
    'emotionDecayEnabled', 'emotionDecayIntervalMinutes',
    'herInterests', 'masterAliases',
    // P1e(2026-10-05 拍板):`personaSummary` / `personaRules` 两个手填字段已退役
    // (真源 = persona.json,面板只读展示)⇒ 不在"没搬丢"清单里。
    'longing.enabled', 'longing.half_life_hours', 'longing.threshold', 'longing.msg_drop',
    'longing.care_relief', 'longing.protest_kick', 'longing.cooldown_minutes',
    'longing.night_hold', 'longing.demo_rate', 'longing.must_say',
    'compaction.curated', 'compaction.budgetTokens',
    'say_again.enabled', 'say_again.min_delay_sec', 'say_again.max_delay_sec',
    'agenda.enabled', 'reflection.importance_threshold', 'reflection.max_inputs',
    'relay.enabled', 'relay.token', 'relay.sessionId', 'relay.cwd', 'relay.permissionPreset',
    'relay.proactiveScope', 'relay.pushLocalTurns',
    'relay.autoReplyToOrigin', 'relay.outboxLeaseSec', 'relay.replyMaxChars', 'relay.proactiveTtlSec'
  ]
  const gone = must.filter((k) => !fields.has(k))
  assert.deepEqual(gone, [], '搬丢的字段:' + gone.join('、'))
})

test('✓ 「恢复默认」有东西可回:默认值过一遍 normalizeSettings 形状不变(幂等)', () => {
  const once = normalizeSettings(SETTINGS_DEFAULTS)
  const twice = normalizeSettings(once)
  assert.deepEqual(twice, once, '默认值不是 normalizeSettings 的不动点 —— 点「恢复默认」会得到第三个样子')
})

/**
 * ★ 2026-09-26 全仓审查补的闸(这条以前**没有**,所以两个真 bug 藏了很久)。
 *
 * 上面两条只比对「字段表 ↔ 默认值」和「幂等」—— 而 `normalizeSettings`
 * **漏掉整组键**时,两边同时看不见:漏掉的键在默认值里有、在幂等里也稳定。
 * 实际漏的是 `longing.must_say` 与整组 `compaction`:
 *   - 面板上的「想念必须说出口」永远关不掉(消费端判 `!== false`)
 *   - 「压缩改走策展块」关不掉、预算改了不生效(`compaction.js` 只拿到 `{}`)
 * 所以这里直接比**键集**:normalize 产出必须与字段表**逐键相等**。
 */
test('✓ 字段表 × normalizeSettings 产出:键集完全对齐(漏一组就是「面板开关是假的」)', () => {
  const fields = indexOfFields()
  const out = new Map()
  const walk = (o, pre) => {
    for (const [k, v] of Object.entries(o)) {
      const key = pre ? pre + '.' + k : k
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) walk(v, key)
      else out.set(key, v)
    }
  }
  walk(normalizeSettings(SETTINGS_DEFAULTS), '')
  const dropped = [...fields.keys()].filter((k) => !out.has(k)).sort()
  const invented = [...out.keys()].filter((k) => !fields.has(k)).sort()
  assert.deepEqual(dropped, [], '字段表里有、normalize 之后没有的(面板上摸得到、代码里读不到):' + dropped.join('、'))
  assert.deepEqual(invented, [], 'normalize 产出里有、字段表里没有的:' + invented.join('、'))
})

test('README settings promises use the current entry and any declared field count is accurate', () => {
  const total = SETTINGS_FIELDS.reduce((n, g) => n + g.fields.length, 0)
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(total > 0)
  assert.ok(readme.includes('设置'))
  assert.ok(readme.includes('/echo/mock/final/index.html'))
  const counts = [...readme.matchAll(/(?:调参|设置)[^\n]*?(\d+)\s*项/gu)]
  for (const m of counts) assert.equal(Number(m[1]), total, 'README declared field count differs from schema')
})

/**
 * ★ 2026-09-30 方案 A(他拍板「阈值分类型」):三个类型线是**扁平键**,
 * 四处连锁(默认值 / normalize / 字段表 / README 项数)缺一处面板就是假的。
 * 这里钉两头:**坏值/越界一律回退统一 `threshold`**(删键即回滚),以及
 * 好值(含数字字符串)照收。
 */
test('✓ 方案 A:类型线进字段表、归一钳位,坏值回退统一 threshold(回滚路径)', () => {
  const fields = indexOfFields()
  for (const [k, line] of [
    ['proactiveScoring.thresholdArtifact', 0.60],
    ['proactiveScoring.thresholdThread', 0.52],
    ['proactiveScoring.thresholdMemory', 0.55]
  ]) {
    assert.ok(fields.has(k), k + ' 应该在调参面板上')
    assert.equal(fields.get(k).field.type, 'num')
    assert.equal(SETTINGS_DEFAULTS.proactiveScoring[k.split('.')[1]], line, k + ' 的出厂值')
  }

  // 好值照收(数字字符串也认 —— 与 clampNum 同一条输入口径)
  const ok = normalizeSettings({ proactiveScoring: { threshold: 0.6, thresholdThread: '0.5' } })
  assert.equal(ok.proactiveScoring.thresholdThread, 0.5)

  // 坏值(负数/NaN/越界/胡写/null/对象)⇒ 一律回退**这一份配置里生效的统一线**
  for (const bad of [-1, NaN, 1.5, 'abc', null, {}, []]) {
    const n = normalizeSettings({ proactiveScoring: { threshold: 0.45, thresholdMemory: bad } })
    assert.equal(n.proactiveScoring.thresholdMemory, 0.45, '坏值 ' + String(bad) + ' 必须回退统一线')
  }
  // 统一线自己也坏 ⇒ 回它的默认 0.6(不许静默变 0 = 永远开口)
  const n2 = normalizeSettings({ proactiveScoring: { threshold: 'x', thresholdThread: 'x' } })
  assert.equal(n2.proactiveScoring.threshold, 0.6)
  assert.equal(n2.proactiveScoring.thresholdThread, 0.6)
  // 缺失(老配置文件里根本没有这三个键)⇒ 回退统一线(删键即回滚)
  const n3 = normalizeSettings({ proactiveScoring: { enabled: true, threshold: 0.7 } })
  assert.equal(n3.proactiveScoring.thresholdArtifact, 0.7)
  assert.equal(n3.proactiveScoring.thresholdThread, 0.7)
  assert.equal(n3.proactiveScoring.thresholdMemory, 0.7)
})

// ------------------------------------------------- P1b 模块8(Q7):未知键不许神隐

test('P1b(Q7):settings 里的未知键搬进 `_unknown` 段并告警(不再静默丢)', () => {
  const warned = []
  const orig = console.warn
  console.warn = (m) => warned.push(String(m))
  try {
    const n = normalizeSettings({ auditKeep: 100, 我的手写字段: '别把我丢了', 另一个开关: 2 })
    assert.equal(n.auditKeep, 100, '认识的键照常钳位')
    assert.deepEqual(n._unknown, { 我的手写字段: '别把我丢了', 另一个开关: 2 }, '未知键要留在数据里(能看懂的字面)')
    assert.equal(unknownSettingsKeys().includes('我的手写字段'), true, '体检口问得出来')
    assert.equal(warned.length, 1, '要告警一次')
    assert.ok(warned[0].includes('_unknown') && warned[0].includes('我的手写字段'), '告警要说清"搬去哪了"和"哪些键"')

    // 幂等:再归一一次结果不变(否则每次写盘都在挪动用户的数据)
    assert.deepEqual(normalizeSettings(n), n)
    // 同一批未知键不重复喊(readSettings() 每轮都跑,不能刷屏)
    normalizeSettings({ 我的手写字段: '别把我丢了', 另一个开关: 2 })
    assert.equal(warned.length, 1, '键集没变 ⇒ 不再喊')

    // 干净配置不该凭空多出 `_unknown`(否则"恢复默认"会得到一个第三样的配置)
    assert.equal(normalizeSettings({ auditKeep: 100 })._unknown, undefined)
    assert.equal(normalizeSettings(SETTINGS_DEFAULTS)._unknown, undefined)
    assert.equal(normalizeSettings(null)._unknown, undefined)
    // 空字符串键名也是未知键(不因为"看起来像空"就吞掉)
    assert.deepEqual(normalizeSettings({ '': 1 })._unknown, { '': 1 })
  } finally { console.warn = orig }
})

// ---------------------------------- P1e(2026-10-05):两个手填字段**退役**

/**
 * ★ P1e:`personaSummary` / `personaRules` 的真源是数据目录里的 `persona.json`
 * (`lib/persona.js` 的 `loadPersona()`),面板不该再让用户手抄一遍。
 *
 * 落地方式走过两步:B 先选 (b)(键留字段表、标 `readOnly`/`derived`),随后他拍板
 * **三步同拍**收口 —— 于是键从字段表、`SETTINGS_DEFAULTS`、`normalizeSettings`
 * 三处一起删掉,`lib/drift.js` 的 `material()` 也不再"settings 手填优先"。
 * 值只由 `derivedPersonaFields(persona)` 现算,面板从 `/api/echo/settings` 的
 * `derived` 一格**只读展示**,编辑入口不留。
 *
 * 这条电池钉的就是"**不许悄悄长回来**":字段表里再出现这两格 = 面板又冒出手填框。
 */
test('P1e:两个手填字段已退役 —— 字段表/默认值里都没有,值只从 persona.json 派生', () => {
  const fields = indexOfFields()
  for (const k of ['personaSummary', 'personaRules']) {
    assert.equal(fields.has(k), false, k + ' 该从字段表里删掉(P1e 拍板:改成派生,不留手填框)')
    assert.equal(Object.hasOwn(SETTINGS_DEFAULTS, k), false,
      k + ' 不该还在 SETTINGS_DEFAULTS 里(否则点「恢复默认」会把它写回 config.json)')
  }
  // 派生出来的键名与旧字段同名(消费点/体检材料不用改键名)
  assert.deepEqual(Object.keys(derivedPersonaFields({ prefix: 'x', suffix: 'y' })).sort(), ['personaRules', 'personaSummary'])
  // 老 config.json 里若还留着这两位的副本:丢弃、**不告警**、不写回(toggle.js 的退役键表)
  const tgl = readFileSync(new URL('../lib/toggle.js', import.meta.url), 'utf8')
  assert.match(tgl, /const RETIRED_SETTINGS_KEYS = \['personaSummary', 'personaRules'\]/,
    '退役键表必须在(toggle.js)—— 否则老副本会掉进 _unknown 段,体检报告出现假噪声')
  const norm = normalizeSettings({ driftEnabled: false, personaSummary: '手填摘要', personaRules: '手填规则' })
  assert.equal(norm.personaSummary, undefined, '退役键不许进归一产出')
  assert.equal(norm.personaRules, undefined, '退役键不许进归一产出')
  assert.deepEqual(norm._unknown ?? {}, {}, '退役键不是"未知键":不许进 _unknown 段')
})

test('P1e:persona.json 有内容 ⇒ 派生非空,且与 persona 文本一致(trim 过)', () => {
  const persona = { prefix: '  你是风又Echo,以幽灵形态出现。\n', suffix: '\n  两条不能弄反的铁律……  ' }
  const d = derivedPersonaFields(persona)
  assert.equal(d.personaSummary, '你是风又Echo,以幽灵形态出现。')
  assert.equal(d.personaRules, '两条不能弄反的铁律……')
  assert.ok(d.personaSummary !== '' && d.personaRules !== '', '有内容就不该派生空')
  // 与体检材料同一份语义(prefix → summary / suffix → rules):派生规则只许在 drift.js 一处
  const digest = personaDigestForDrift(persona)
  assert.deepEqual(d, { personaSummary: digest.summary, personaRules: digest.rules })
})

test('P1e:persona.json 为空(prefix/suffix 都是 \'\')⇒ 派生为空串(不是 null)', () => {
  // 选空串而非 null:与 SETTINGS_DEFAULTS 里那两项的出厂值 `''` 同形状,
  // 面板拿到的是两个空输入框而不是 undefined。
  for (const empty of [{ prefix: '', suffix: '' }, { prefix: '   ', suffix: '\n' }, {}]) {
    const d = derivedPersonaFields(empty)
    assert.deepEqual(d, { personaSummary: '', personaRules: '' }, JSON.stringify(empty) + ' 该派生两个空串')
  }
})

test('P1e:persona 是 null / 不是对象 / 读属性抛错 ⇒ 降级为空,不抛', () => {
  for (const bad of [null, undefined, 42, '风又Echo', true, [], { prefix: 5, suffix: null }]) {
    const d = derivedPersonaFields(bad)
    assert.deepEqual(d, { personaSummary: '', personaRules: '' }, String(bad) + ' 该降级成空,不许抛')
  }
  // 脏到「读一下就炸」的对象(代理/坏 getter)也不许把面板带崩
  const boom = new Proxy({}, { get () { throw new Error('读 persona 炸了') } })
  assert.deepEqual(derivedPersonaFields(boom), { personaSummary: '', personaRules: '' })
})
