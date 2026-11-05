/**
 * C3 出站清单的电池(禁词 / 防重复 / 总闸)。
 *
 * 最要紧的一条:**默认不许静默改她的话**。命中禁词默认是 `flag`(照发 + 落账 +
 * 告诉她),`hold` 才是真的不发,`mask` 必须**明说改过**。他 2026-09-26 的原话是
 * "清单太严会把她的个性一起过滤掉" —— 所以这一层的默认行为必须是"看见但不拦"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  splitList, checkBanned, maskText, checkRepeat, similarityOf, guardOutbound,
  normalizeAction, DEFAULT_BANNED_WORDS, loadBannedWords, bannedWordsFor,
  DEFAULT_BANNED_ACTION, DEFAULT_REPEAT_ACTION,
  DEFAULT_REPEAT_SIMILARITY, MAX_LIST_ITEMS, BANNED_ACTIONS, REPEAT_ACTIONS
} from '../lib/speech-guard.js'

test('C3:动作白名单本身是导出的常量(面板/文档照它写,不许漂)', () => {
  assert.deepEqual(BANNED_ACTIONS, ['flag', 'hold', 'mask'])
  assert.deepEqual(REPEAT_ACTIONS, ['flag', 'hold'])
})

test('C3:清单解析 —— 中英逗号/顿号/分号/换行都能分,去空去重,超上限截断且报数', () => {
  const r = splitList('一抹, 弧度、不容置疑;不易察觉\n微不可察,, 一抹 ')
  assert.deepEqual(r.items, ['一抹', '弧度', '不容置疑', '不易察觉', '微不可察'])
  assert.equal(r.dropped, 0)
  const big = splitList(Array.from({ length: MAX_LIST_ITEMS + 5 }, (_, i) => 'w' + i).join(','))
  assert.equal(big.items.length, MAX_LIST_ITEMS)
  assert.equal(big.dropped, 5, '截断了几个必须说得出来')
  assert.deepEqual(splitList('').items, [])
  assert.deepEqual(splitList(null).items, [])
})

test('P1b:代码里的默认表是**空的**,那批小说腔词住在 lexicon.json', (t) => {
  assert.deepEqual([...DEFAULT_BANNED_WORDS], [], 'P1b:程序里零词表(清空 = 显式无禁词)')
  assert.equal(DEFAULT_BANNED_ACTION, 'flag', '默认必须是不改行为的那一档')
  const src = readFileSync(new URL('../lib/speech-guard.js', import.meta.url), 'utf8')
  for (const w of ['一抹', '弧度', '不容置疑', '生理性地']) {
    assert.ok(!src.includes(w), '代码里还留着禁词:' + w)
  }
  // 真词表在数据文件里(换机/清过数据目录时只验降级形状)
  const fromData = loadBannedWords()
  if (fromData.length === 0) {
    t.diagnostic('本机 lexicon.json 的 bannedWords 为空:只验了"空 ⇒ 无禁词"这条降级路')
    return
  }
  for (const w of ['一抹', '弧度', '不容置疑', '生理性地']) assert.ok(fromData.includes(w), w)
  assert.ok(fromData.every((w) => w.trim() !== ''), '不许有空串')
})

test('P1b:loadBannedWords —— 缺文件/坏文件/脏条目一律降级,永不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-lexicon-'))
  try {
    const p = join(dir, 'lexicon.json')
    assert.deepEqual(loadBannedWords(p), [])
    assert.deepEqual(loadBannedWords(null), [])
    writeFileSync(p, '{坏', 'utf8')
    assert.deepEqual(loadBannedWords(p), [])
    writeFileSync(p, JSON.stringify({ bannedWords: [' 一抹 ', '', 3, null, '弧度'] }), 'utf8')
    assert.deepEqual(loadBannedWords(p), ['一抹', '弧度'], '去空白、丢空串与非字符串')
    writeFileSync(p, JSON.stringify({ bannedWords: '不是数组' }), 'utf8')
    assert.deepEqual(loadBannedWords(p), [])
    writeFileSync(p, JSON.stringify({}), 'utf8')
    assert.deepEqual(loadBannedWords(p), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P1b:bannedWordsFor —— 他填的优先;留空读 lexicon.json;都没有 = 无禁词(不回落)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'echo-lexicon-for-'))
  try {
    const p = join(tmp, 'lexicon.json')
    writeFileSync(p, JSON.stringify({ bannedWords: ['数据文件里的词'] }), 'utf8')
    assert.deepEqual(bannedWordsFor('他填的词, 再一个'), ['他填的词', '再一个'], '填了就用他的')
    assert.deepEqual(bannedWordsFor('   '), loadBannedWords(), '空白也算留空 ⇒ 走数据文件')
    assert.deepEqual(loadBannedWords(p), ['数据文件里的词'])
    // 数据文件也空 + 面板留空 ⇒ 空表 = 显式无禁词
    writeFileSync(p, JSON.stringify({ bannedWords: [] }), 'utf8')
    assert.deepEqual(loadBannedWords(p), [])
    assert.equal(checkBanned('她的嘴角有一抹弧度', { words: loadBannedWords(p) }).hit, false, '无禁词 ⇒ 恒不命中')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('C3:命中 —— 报出哪几个词、在第几个字,外加一句人话原因', () => {
  const r = checkBanned('她的嘴角有一抹弧度', { words: ['一抹', '弧度'] })
  assert.equal(r.hit, true)
  assert.deepEqual(r.words, ['一抹', '弧度'])
  assert.equal(r.positions[0].word, '一抹')
  assert.equal(r.positions[0].at, 5)
  assert.match(r.reason, /不像你说的/)
  assert.match(r.reason, /一抹/)
})

test('C3:空清单恒不命中(他清空 = 这条闸不动任何东西);同一个词出现两次也只报一次', () => {
  assert.equal(checkBanned('一抹一抹', { words: [] }).hit, false)
  assert.equal(checkBanned('', { words: ['一抹'] }).hit, false)
  const r = checkBanned('一抹又一抹', { words: ['一抹'] })
  assert.deepEqual(r.words, ['一抹'])
  assert.equal(r.positions.length, 2, '位置记两次(他自己会看有几处)')
})

test('C3:动作白名单 —— 乱填回落 flag;mask 把词换掉', () => {
  assert.equal(normalizeAction('HOLD', ['flag', 'hold', 'mask'], 'flag'), 'hold')
  assert.equal(normalizeAction('胡说', ['flag', 'hold', 'mask'], 'flag'), 'flag')
  assert.equal(checkBanned('一抹', { words: ['一抹'], action: '胡说' }).action, 'flag')
  assert.equal(maskText('一抹弧度', ['一抹']), '…弧度')
})

test('C3:相似度 —— 一模一样 = 1,不相干 ≈ 0,空串不比', () => {
  assert.equal(similarityOf('今天好累啊', '今天好累啊'), 1)
  assert.ok(similarityOf('今天好累啊', '明天要下雨') < 0.2)
  assert.equal(similarityOf('', '今天好累啊'), 0)
})

test('C3:防重复 —— 跟她自己最近三句比,过了门槛才叫复读,而且报相似度', () => {
  const prev = ['我先去洗个澡', '外面在下雨']
  const r = checkRepeat('我先去洗个澡', prev)
  assert.equal(r.repeat, true)
  assert.equal(r.similarity, 1)
  assert.match(r.reason, /刚才说过/)
  assert.equal(checkRepeat('我出门了', prev).repeat, false)
  assert.equal(checkRepeat('我先去洗个澡', [], {}).repeat, false, '没得比 ⇒ 不算复读')
  // 门槛 0 = 关掉这条(不许把"0"当成"永远复读")
  assert.equal(checkRepeat('我先去洗个澡', prev, { similarity: 0 }).repeat, false)
})

test('C3:总闸默认不拦 —— 命中禁词照发,但把理由带出来(不静默)', () => {
  const g = guardOutbound('她的嘴角有一抹弧度', { words: ['一抹', '弧度'] })
  assert.equal(g.ok, true, '默认 flag ⇒ 照发')
  assert.equal(g.masked, false)
  assert.equal(g.banned.hit, true)
  assert.equal(g.text, '她的嘴角有一抹弧度', '文本一个字不改')
  assert.match(g.reason, /不像你说的/)
})

test('C3:hold 只对回话生效 —— 关怀/提醒是履约,压下不发不行', () => {
  const hold = guardOutbound('一抹', { words: ['一抹'], bannedAction: 'hold', kind: 'reply' })
  assert.equal(hold.ok, false, '回话:压住不发')
  assert.match(hold.reason, /不像你说的/)
  const care = guardOutbound('一抹', { words: ['一抹'], bannedAction: 'hold', kind: 'proactive' })
  assert.equal(care.ok, true, '关怀:照发')
  assert.match(care.note, /压下不发不行/)
})

test('C3:mask ⇒ 换成「…」并**明说改过**', () => {
  const g = guardOutbound('她的嘴角有一抹弧度', { words: ['一抹'], bannedAction: 'mask' })
  assert.equal(g.masked, true)
  assert.equal(g.text, '她的嘴角有…弧度')
  assert.equal(g.ok, true)
})

test('C3:复读与禁词同时命中 ⇒ 两条理由都在(不许只报一条)', () => {
  const g = guardOutbound('我先去洗澡', {
    words: ['洗澡'], prevTexts: ['我先去洗澡'], repeatSimilarity: DEFAULT_REPEAT_SIMILARITY
  })
  assert.equal(g.banned.hit, true)
  assert.equal(g.repeat.repeat, true)
  assert.equal(g.notes.length, 2)
  assert.equal(DEFAULT_REPEAT_ACTION, 'flag')
})

test('C3:清单乱填不会让它抛(整条通道必须能吃垃圾输入)', () => {
  assert.doesNotThrow(() => guardOutbound(null, { words: [null, '', 3], prevTexts: [null, {}], repeatSimilarity: 'x' }))
  assert.doesNotThrow(() => checkRepeat(undefined, undefined, { similarity: NaN }))
  assert.doesNotThrow(() => guardOutbound('x', { words: 5 }))
})
