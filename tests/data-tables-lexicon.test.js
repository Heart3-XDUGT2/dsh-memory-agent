/**
 * P3 B1「词表」批次:#1/#2/#3 三个 JS 读点的行为电池。
 *
 * 核心纪律(P3 迁移设计 §5.2 的"指纹法"):
 *   **数据为空 ⇒ 与迁移前逐位一致** —— 所以每个读点都有一份"迁移前那张表"的
 *   字面副本,空数据时读回来的必须与它**逐词相等**(集合语义:代码表里有重复项,
 *   比对前两边都去重+排序)。数据填了 ⇒ 以数据为准。
 *
 * 另外两条:
 *   · 坏文件 / 缺键 / 空数组 ⇒ 一律回默认表且**不抛**;
 *   · #3 的真称呼**不许落盘也不许留在代码里** —— 它由 `profile.json.userName`
 *     运行时拼(空 ⇒ 只用词根)。
 *
 * 隔离纪律(照 tests/data-tables.test.js):显式传 `env` 指向临时目录,
 * 绝不依赖真数据目录里的私料。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { topicStopwordsOf, topicKeywords } from '../lib/care-report.js'
import { powerWordsOf, parseSessionMarker } from '../lib/toggle.js'
import { longingMarkersOf, shouldSteerLonging, LONGING_SAID_MARKERS } from '../lib/turn-stopping.js'
// 称呼兜底要读的**用户值**就在库里 ⇒ 这条链的端到端用例得自己种一个临时库。
import { openStore } from '../lib/store.js'

/** 造一个临时"数据目录"(与 tests/data-tables.test.js 同款,`DSH_HOME` 指到 `<tmp>/<home>`)。 */
function tempEnv (files = {}) {
  const home = mkdtempSync(join(tmpdir(), 'echo-lexicon-'))
  const dir = join(home, 'echo')
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  }
  return { DSH_HOME: home }
}

const readSource = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
/** 集合语义比对:去重 + 排序(代码表里有重复项,顺序也不承诺)。 */
const canon = (xs) => [...new Set(xs)].sort()

// ═══ #1 话题停用词(care-report)═══════════════════════════════════════════════

/** 迁移前那张表(`lib/care-report.js` 的 TOPIC_STOPWORDS)的字面副本。 */
const OLD_TOPIC_STOPWORDS = [
  '今天', '明天', '昨天', '后天', '以后', '以前', '现在', '最近', '时候', '一个', '我们', '他们',
  '用户', '什么', '自己', '因为', '所以', '然后', '可以', '已经', '还是', '这个', '那个', '就是',
  '不是', '有点', '真的', '感觉', '知道', '觉得', '应该', '需要', '如果', '但是', '而且', '还有',
  '或者', '一起', '一下', '一直', '可能', '大概', '一直', '关于', '对于', '之后', '之前', '正在'
]

test('#1 话题停用词:空数据 ⇒ 与迁移前那张表逐词一致', () => {
  const got = topicStopwordsOf(tempEnv())
  assert.deepEqual(canon([...got]), canon(OLD_TOPIC_STOPWORDS))
  assert.equal(topicKeywords('今天的火车', { env: tempEnv() }).includes('今天'), false,
    '默认表照样剔「今天」')
})

test('#1 话题停用词:坏文件 / 空数组 / 脏值 ⇒ 回默认表,绝不抛', () => {
  for (const body of ['{ 这不是 json', { schemaRev: 1, topicStopwords: [] },
    { schemaRev: 1, topicStopwords: [7, '', '  '] }]) {
    const got = topicStopwordsOf(tempEnv({ 'lexicon.json': body }))
    assert.deepEqual(canon([...got]), canon(OLD_TOPIC_STOPWORDS))
  }
})

test('#1 话题停用词:数据填了 ⇒ 整表以数据为准(默认表不再生效)', () => {
  const env = tempEnv({ 'lexicon.json': { schemaRev: 1, topicStopwords: ['火车', '今天'] } })
  assert.deepEqual([...topicStopwordsOf(env)].sort(), ['今天', '火车'])
  const keys = topicKeywords('用户坐今晚10点的火车回家', { env })
  assert.equal(keys.includes('火车'), false, '数据表生效')
  assert.equal(keys.includes('用户'), true, '数据是整表 ⇒ 默认表里的「用户」不再剔')
})

// ═══ #2 开关口令(toggle)════════════════════════════════════════════════════

/** 迁移前那两张表(`lib/toggle.js` 的 OFF_WORDS / ON_WORDS)的字面副本。 */
const OLD_OFF_WORDS = ['下线', '关闭', '关掉', '关了', '休眠', '睡觉', '睡吧', '别说话', '安静点', '安静', '闭嘴', '停一下', '休息吧']
const OLD_ON_WORDS = ['上线', '唤醒', '醒来', '回来', '回来吧', '醒醒']

test('#2 开关口令:空数据 ⇒ 与迁移前那两张表逐词一致', () => {
  const got = powerWordsOf(tempEnv())
  assert.deepEqual(got.off, OLD_OFF_WORDS)
  assert.deepEqual(got.on, OLD_ON_WORDS)
  // 消费点:裸动词那一支不看自称 ⇒ 与 profile 无关,可离线钉死
  assert.equal(parseSessionMarker('下线', tempEnv()), 'off')
  assert.equal(parseSessionMarker('上线', tempEnv()), 'on')
})

test('#2 开关口令:只填一侧 ⇒ 另一侧仍回默认表(逐键兜底)', () => {
  const env = tempEnv({ 'lexicon.json': { schemaRev: 1, powerWords: { off: ['滚'] } } })
  const got = powerWordsOf(env)
  assert.deepEqual(got.off, ['滚'])
  assert.deepEqual(got.on, OLD_ON_WORDS, '缺键 ⇒ 那一侧回默认表')
  assert.equal(parseSessionMarker('滚', env), 'off', '数据里的口令生效')
  assert.equal(parseSessionMarker('滚', tempEnv()), null, '空数据 ⇒ 不认这条自定义口令')
})

test('#2 开关口令:坏形状 / 空数组 ⇒ 回默认表,绝不抛', () => {
  for (const body of ['{ 坏', { schemaRev: 1, powerWords: 'x' },
    { schemaRev: 1, powerWords: { off: [], on: [] } },
    { schemaRev: 1, powerWords: { off: [7, ''], on: {} } }]) {
    const got = powerWordsOf(tempEnv({ 'lexicon.json': body }))
    assert.deepEqual(got.off, OLD_OFF_WORDS)
    assert.deepEqual(got.on, OLD_ON_WORDS)
  }
})

// ═══ #3 想念标记(turn-stopping)═════════════════════════════════════════════

/** 迁移前那张表的**词根**部分(去掉两条含真称呼的);含称呼的两条由 userName 拼。 */
const OLD_LONGING_ROOTS = [
  '想你', '想他', '想念', '挂念', '惦记', '念你', '念着',
  '想见你', '等你回来', '一直在等', '舍不得', '离不开'
]

test('#3 想念标记:空数据 + 没有用户值 ⇒ 只用词根(逐词一致),且不建库', () => {
  const env = tempEnv()
  assert.deepEqual(canon(longingMarkersOf(env)), canon(OLD_LONGING_ROOTS))
  assert.deepEqual(canon([...LONGING_SAID_MARKERS]), canon(OLD_LONGING_ROOTS))
  assert.equal(existsSync(join(env.DSH_HOME, 'echo', 'echo.db')), false,
    '读称呼绝不许顺手建库(库不在 = 他没填过称呼 ⇒ 称呼类标记整条不产出)')
})

test('#3 想念标记:称呼走"注入 → store 用户值 → 跳过"这条链(程序里零真称呼)', () => {
  const env = tempEnv()
  // ① 显式注入优先 —— 称呼只活在注入里,一个字节都不进程序
  const injected = longingMarkersOf(env, '阿岚')
  assert.ok(injected.includes('想阿岚'), '词根 + 运行时称呼')
  assert.ok(injected.includes('想见阿岚'))
  // ② 不注入 ⇒ 兜底读 store 的**用户值**(`store.getProfile().name`,面板可改的那一份)
  const dbPath = join(env.DSH_HOME, 'echo', 'echo.db')
  const store = openStore(dbPath)
  store.setName('阿岚')
  assert.ok(longingMarkersOf(env).includes('想阿岚'), 'store.getProfile().name 生效')
  // ③ 注入空 ⇒ 当"没有称呼" ⇒ 称呼类标记整条跳过(绝不回落成写死的名字)
  assert.deepEqual(canon(longingMarkersOf(env, '')), canon(OLD_LONGING_ROOTS))
})

test('#3 想念标记:数据表(存词根)整表覆盖 + 照样代入称呼', () => {
  const env = tempEnv({ 'lexicon.json': { schemaRev: 1, longingMarkers: ['念你', '念着'] } })
  assert.deepEqual(longingMarkersOf(env, '阿岚'), ['念你', '念着', '想阿岚', '想见阿岚'])
})

test('#3 想念标记:坏文件 ⇒ 回词根表,绝不抛', () => {
  for (const body of ['{ 坏', { schemaRev: 1, longingMarkers: [] },
    { schemaRev: 1, longingMarkers: [7, '  '] }]) {
    assert.deepEqual(canon(longingMarkersOf(tempEnv({ 'lexicon.json': body }))), canon(OLD_LONGING_ROOTS))
  }
})

test('#3 判定:标记表可按帧注入(纯判定仍可离线测)', () => {
  const read = { pre: { exists: true, value: 9, threshold: 7, due: true } }
  const said = '好想阿猫呀'
  assert.equal(shouldSteerLonging({ longingRead: read, said, markers: ['想阿猫'] }).reason, 'already-said')
  assert.equal(shouldSteerLonging({ longingRead: read, said, markers: OLD_LONGING_ROOTS }).steer, true,
    '只有词根时"想阿猫"不算说过 —— 这正是拼称呼那条的意义')
})

test('#3 词根表只在代码里留词根(含称呼的两条以词根形态存在)', () => {
  const src = readSource('../lib/turn-stopping.js')
  const m = src.match(/export const LONGING_SAID_MARKERS = \[([\s\S]*?)\]/)
  assert.ok(m, '词根表要以数组字面量导出')
  const entries = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])
  assert.deepEqual(entries, OLD_LONGING_ROOTS)
  assert.ok(/const ADDRESS_ROOTS = \['想', '想见'\]/.test(src),
    '含称呼的两条只以"词根"形态存在,称呼从 profile 来')
})

// ═══ 接线(源码级钉子:三个读点真的被消费点用上了)═══════════════════════════

test('接线:三个消费点都走读点,且 worker 的分发白名单带上了 lexical / graph', () => {
  assert.ok(/const stop = topicStopwordsOf\(env\)/.test(readSource('../lib/care-report.js')),
    'care-report 的 topicKeywords 要走 topicStopwordsOf')
  assert.ok(/powerWordsOf\(env\)/.test(readSource('../lib/toggle.js')),
    'toggle 的两个消费点要走 powerWordsOf')
  assert.ok(/longingMarkersOf\(\)/.test(readSource('../lib/turn-stopping.js')),
    'turn-stopping 的判定要走 longingMarkersOf')
  const worker = readSource('../python/worker.py')
  const line = worker.split('\n').find((l) => l.includes('for _mod in (')) ?? ''
  assert.ok(line.includes('graph'), 'worker 每帧要把数据分发给 graph')
  assert.ok(/lexical/.test(line), 'worker 每帧要把数据分发给 lexical')
  const lex = readSource('../python/engine/lexical.py')
  assert.ok(/def configure_from_data\(data\)/.test(lex), 'lexical.py 要有 configure_from_data')
  assert.ok(/_TOKEN_CACHE.clear\(\)/.test(lex), '换表必须清词元缓存(否则"落盘即生效"是假的)')
  assert.ok(/def configure_from_data\(data\)/.test(readSource('../python/engine/graph.py')),
    'graph.py 要有 configure_from_data')
})
