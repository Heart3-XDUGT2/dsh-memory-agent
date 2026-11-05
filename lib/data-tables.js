/**
 * P3-a「通路先行」:数据文件的**通用读点**(只读、容错、每次现读)。
 *
 * 为什么单独一个文件:在此之前,"谁读数据文件"散在各自模块里(`graph-aliases.js`
 * 读 `aliases.json`、`names.js` 读 `names.json`……),而 `graph.json` /
 * `lexicon.json` / `state-defaults.json` **一个读点都没有** —— 面板能写、没人读
 * (P3 迁移设计 §1.5 点名的"哑字段")。P3 的迁移(把代码里的表搬进文件)必须
 * **先有读点**,否则导进去等于白写。
 *
 * 纪律(与既有读点同姿势,见 `lib/graph-aliases.js:43-60`):
 *   · **只读**,永不写(写只有 `lib/data-write.js` 一条路);
 *   · **每帧现读**,不缓存 ⇒ 面板改了下一帧生效(与"引擎每帧现读 config.json"同一条);
 *   · 文件缺 / 坏 / 空 ⇒ 返回空对象 **不抛** ⇒ 调用方回"代码里的通用默认";
 *   · 这里**只做解析与取值**,不放任何值(值 = 数据文件的事)。
 *
 * 关键约定:**"空"不是一个错误**。老文件没有 `schemaRev`、新字段不存在,都合法
 * (P3 迁移设计 §6 风险 2)⇒ 一律"缺 ⇒ 回通用默认",不许因此判坏或重建。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolveDataFilePath } from './data-dir.js'

/** 空读点的统一返回值(冻结,免得调用方改坏)。 */
const EMPTY = Object.freeze({})

/** 通用的 JSON 对象读取:缺 / 坏 / 不是对象 ⇒ null(调用方兜底)。 */
function readJsonObject (name, env) {
  try {
    const path = resolveDataFilePath(name, env)
    if (path === null || path === undefined || !existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    return raw
  } catch {
    return null // 坏文件 = 没有数据(降级到代码默认,绝不抛)
  }
}

/** 取一个"普通对象"字段(数组/标量/缺 ⇒ null)。 */
export function objectField (obj, key) {
  const v = (obj === null || obj === undefined) ? undefined : obj[key]
  return (v !== null && typeof v === 'object' && !Array.isArray(v)) ? v : null
}

/** 取一个字符串数组字段(脏元素丢掉;缺 / 坏 ⇒ null)。 */
export function listField (obj, key) {
  const v = (obj === null || obj === undefined) ? undefined : obj[key]
  if (!Array.isArray(v)) return null
  return v.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
}

/** 取一个有限数字字段(布尔 / 空串 / NaN ⇒ null;`0` 是合法值)。 */
export function numberField (obj, key) {
  const v = (obj === null || obj === undefined) ? undefined : obj[key]
  if (typeof v === 'boolean' || v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** `graph.json`(图论配置:关系表 / 显示调参 / 窗口)。缺 ⇒ `{}`。
 *  @param {Record<string,string|undefined>} [env] 显式环境(测试/多实例用;不传 = `process.env`) */
export function graphCfgOf (env) { return readJsonObject('graph.json', env) ?? EMPTY }

/** `lexicon.json`(词表)。缺 ⇒ `{}`。同上 env 口子。 */
export function lexiconOf (env) { return readJsonObject('lexicon.json', env) ?? EMPTY }

/** `state-defaults.json`(状态初值)。缺 ⇒ `{}`。同上 env 口子。 */
export function stateDefaultsOf (env) { return readJsonObject('state-defaults.json', env) ?? EMPTY }

/**
 * 随帧下发给 python 引擎的 **data 块**(P3-a 的通路;引擎侧解析见
 * `python/engine/graph_gate.py::data_from_frame`)。
 *
 * 形状固定、**只列读点要用的段**,每段缺 ⇒ `{}` —— 引擎一律"帧里没有 ⇒ 空/默认
 * 且不抛"。`version` 是给引擎的版本位:认不出就忽略整块(壳/引擎版本错配兜底)。
 */
export function frameData (env) {
  const g = graphCfgOf(env)
  const l = lexiconOf(env)
  const s = stateDefaultsOf(env)
  return {
    version: 1,
    graph: {
      relations: objectField(g, 'relations') ?? {},
      display: objectField(g, 'display') ?? {},
      windows: objectField(g, 'windows') ?? {}
    },
    lexicon: {
      timeWords: objectField(l, 'timeWords') ?? {},
      stopwords: listField(l, 'stopwords') ?? [],
      topicStopwords: listField(l, 'topicStopwords') ?? [],
      longingMarkers: listField(l, 'longingMarkers') ?? [],
      powerWords: objectField(l, 'powerWords') ?? {}
    },
    stateDefaults: {
      moodIntensity: numberField(s, 'moodIntensity'),
      prevMoodIntensity: numberField(s, 'prevMoodIntensity'),
      userEmotion: (typeof s.userEmotion === 'string' && s.userEmotion.trim() !== '') ? s.userEmotion.trim() : null,
      emotionVector: objectField(s, 'emotionVector'),
      affinity: numberField(s, 'affinity'),
      longing: numberField(s, 'longing'),
      energy: numberField(s, 'energy')
    }
  }
}
