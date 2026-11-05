/**
 * P3-a「通路先行」:数据文件的通用读点(`lib/data-tables.js`)。
 *
 * 这组测试要钉三件事:
 *   1. **空 / 缺 / 坏 ⇒ 空对象且不抛** —— 调用方才能"回落代码里的通用默认",
 *      这是 P3「迁移前后行为等价」的地基;
 *   2. **有值 ⇒ 读得到**,并且 `frameData()` 的形状就是引擎侧
 *      `python/engine/gate.py::data_from_frame` 认的那三块;
 *   3. **初值读点真的接了数据**(`emotion.js` 的默认向量)。
 *
 * 纪律:一律用**显式 env 指向临时目录**(`{ DSH_HOME: tmp }`)——
 * `resolveDataDir` 首次调用就冻结(见 `lib/data-dir.js:83-87`),所以测试
 * 绝不靠改 `process.env` 注入,更不许读到真数据目录里的私料。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  graphCfgOf, lexiconOf, stateDefaultsOf, frameData, objectField, listField, numberField
} from '../lib/data-tables.js'
import { defaultEmotionVector, EMOTION_RANGES } from '../lib/emotion.js'

/** 造一个临时"数据目录":`<tmp>/<home>/echo/`(`DSH_HOME` 指到 `<tmp>/<home>`)。
 *  口径见 `lib/data-dir.js:59-64`(`ECHO_DATA_DIR` > `$DSH_HOME/echo` > `~/.dsh/echo`)。 */
function tempEnv (files = {}) {
  const home = mkdtempSync(join(tmpdir(), 'echo-tables-'))
  const dir = join(home, 'echo')
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  }
  return { DSH_HOME: home }
}

const readSource = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('空目录:三个读点都是空对象,frameData 也是空壳(且不抛)', () => {
  const env = tempEnv()
  assert.deepEqual(graphCfgOf(env), {})
  assert.deepEqual(lexiconOf(env), {})
  assert.deepEqual(stateDefaultsOf(env), {})
  const d = frameData(env)
  assert.equal(d.version, 1)
  assert.deepEqual(d.graph, { relations: {}, display: {}, windows: {} })
  assert.deepEqual(d.lexicon, {
    timeWords: {}, stopwords: [], topicStopwords: [], longingMarkers: [], powerWords: {}
  })
  assert.deepEqual(d.stateDefaults, {
    moodIntensity: null, prevMoodIntensity: null, userEmotion: null,
    emotionVector: null, affinity: null, longing: null, energy: null
  })
})

test('坏文件 / 不是对象 / 数组:一律当"没有数据",绝不抛', () => {
  const env = tempEnv({
    'graph.json': '{ 这不是 json',
    'lexicon.json': '[1,2,3]',
    'state-defaults.json': '"just a string"'
  })
  assert.deepEqual(graphCfgOf(env), {})
  assert.deepEqual(lexiconOf(env), {})
  assert.deepEqual(stateDefaultsOf(env), {})
  assert.deepEqual(frameData(env).graph.relations, {})
})

test('有值:读得到,且 frameData 只搬"读点用得上的段"', () => {
  const env = tempEnv({
    'graph.json': {
      schemaRev: 1, updatedAt: 'x',
      relations: { canonical: { 读于: '就读于' }, singleValue: ['是'] },
      display: { wMax: 10 },
      windows: { nightHoldFromHour: 23 }
    },
    'lexicon.json': {
      schemaRev: 1,
      timeWords: { day: { 今天: 0 } },
      stopwords: ['的', '  ', 7],
      topicStopwords: ['今天', '']
    },
    'state-defaults.json': {
      schemaRev: 1, moodIntensity: 6, prevMoodIntensity: 4, userEmotion: 'neutral',
      emotionVector: { global: { fatigue: 1.5 }, target_master: { affection: 9 } },
      affinity: 50, longing: 0, energy: 7
    }
  })
  assert.deepEqual(graphCfgOf(env).relations.canonical, { 读于: '就读于' })
  assert.deepEqual(lexiconOf(env).timeWords, { day: { 今天: 0 } })
  assert.equal(stateDefaultsOf(env).moodIntensity, 6)

  const d = frameData(env)
  assert.deepEqual(d.graph.relations.singleValue, ['是'])
  assert.equal(d.graph.display.wMax, 10)
  assert.equal(d.graph.windows.nightHoldFromHour, 23)
  assert.deepEqual(d.lexicon.timeWords, { day: { 今天: 0 } })
  assert.deepEqual(d.lexicon.stopwords, ['的'], '脏元素(空白/数字)丢掉')
  assert.deepEqual(d.lexicon.topicStopwords, ['今天'])
  assert.deepEqual(d.stateDefaults, {
    moodIntensity: 6, prevMoodIntensity: 4, userEmotion: 'neutral',
    emotionVector: { global: { fatigue: 1.5 }, target_master: { affection: 9 } },
    affinity: 50, longing: 0, energy: 7
  })
})

test('字段取值助手:脏值一律 null(好让调用方回代码默认)', () => {
  const o = { a: { x: 1 }, b: ['p', '', 7, 'q'], c: 0, d: '', e: true, f: '3.5', g: [], h: {} }
  assert.deepEqual(objectField(o, 'a'), { x: 1 })
  assert.equal(objectField(o, 'b'), null, '数组不是对象')
  assert.equal(objectField(o, 'g'), null, '空数组也不是对象')
  assert.equal(objectField(o, 'missing'), null)
  assert.deepEqual(listField(o, 'b'), ['p', 'q'])
  assert.deepEqual(listField(o, 'g'), [])
  assert.equal(listField(o, 'a'), null)
  assert.equal(numberField(o, 'c'), 0, '0 是合法值')
  assert.equal(numberField(o, 'd'), null)
  assert.equal(numberField(o, 'e'), null, '布尔不算数')
  assert.equal(numberField(o, 'f'), 3.5)
  assert.equal(numberField(o, 'missing'), null)
})

test('初值读点接了数据:默认情绪向量会被 state-defaults.json 覆盖,空则逐位不变', () => {
  const bare = defaultEmotionVector(tempEnv())
  assert.deepEqual(bare, {
    global: { fatigue: 2.0, valence: 2.0, arousal: 3.0 },
    target_master: { affection: 8.0, playfulness: 7.0, sadness: 0.0, dependency: 6.0 }
  }, '空数据 ⇒ 与迁移前逐位一致')

  const env = tempEnv({
    'state-defaults.json': {
      schemaRev: 1,
      emotionVector: { global: { fatigue: 1.5, valence: 99 }, target_master: { affection: 9, unknown: 5 } }
    }
  })
  const v = defaultEmotionVector(env)
  assert.equal(v.global.fatigue, 1.5, '给了的维度用数据')
  assert.equal(v.global.valence, EMOTION_RANGES.global.valence[1], '越界按 EMOTION_RANGES 夹到上限')
  assert.equal(v.target_master.affection, 9)
  assert.equal(v.target_master.playfulness, 7.0, '没给的维度留出厂值')
  assert.equal(v.global.unknown, undefined, '未知维度忽略')
  assert.deepEqual(defaultEmotionVector(tempEnv({ 'state-defaults.json': { schemaRev: 1, emotionVector: 'x' } })),
    bare, '脏向量 ⇒ 出厂值')
})

test('接线:`frame()` 带上 data 块;schema 的 canonical 已按代码用法定成 object', () => {
  const engine = readSource('../lib/engine.js')
  assert.ok(/names: frameNames\(\), data: frameData\(\)/.test(engine),
    'engine.js 的 frame() 必须同时下发 names 与 data')
  assert.ok(/from '\.\/data-tables\.js'/.test(engine), 'engine.js 要 import data-tables')
  const schema = readSource('../lib/data-schema.js')
  assert.ok(/\{ key: 'canonical', type: 'object' \}/.test(schema),
    'relations.canonical 的形状必须是 object(map;拍板 6:以代码用法为准)')
  const gate = readSource('../python/engine/graph_gate.py')
  assert.ok(/def data_from_frame\(frame\)/.test(gate), '引擎侧要有 data_from_frame')
  const worker = readSource('../python/worker.py')
  assert.ok(/configure_from_data\(_data\)/.test(worker), 'worker 每帧要把数据分发给各模块')
})
