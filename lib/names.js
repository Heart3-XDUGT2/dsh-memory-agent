/**
 * 人名 / 说话人名单 —— 数据文件 names.json 的**唯一读点**
 * ============================================================
 * P1b(2026-10-05):这两份名单原来硬编码在两处 —— `lib/store.js:1179` 的
 * PERSON_NAMES(14 条,节点类型推断用)与 `lib/memory-read-tools.js:70` 的
 * SPEAKER_NODES(5 条,出参标"这是说话人,不是事实")。设计文档 row 7 指出它们
 * 与 python 侧三处(`graph_gate.py:194/488`、`l0_tier.py:61`)是**同一份口径** ——
 * 五处分头硬编码 = 同一个人被写五遍,以后多用户化要动五遍。
 *
 * 现在:名单住 `<数据目录>/names.json`(`{ speakers, personNames, familyTerms }`,
 * 形状见 `lib/data-schema.js` 的 SPECS);一次性种子迁移已把两份真名单导进去。
 * 本模块是 JS 侧**唯一的读点**(各写一份,就是把刚收回来的口径又拆开)。
 *
 * **空 ⇒ 中性集合**(设计文档 row 7:不给内置兜底,也不猜):
 *   · `speakers` 空 ⇒ 没有节点被标成"说话人";
 *   · `personNames` 空 ⇒ 没有概念节点被改判成 person(全留 concept);
 *   · `ownerNames` 空 ⇒ 自节点只剩代码里的**角色槽**「用户」(见下)。
 *
 * P1c(2026-10-05 拍板)加 `ownerNames` —— **自节点名**(谁算"他自己"),
 * 喂 python 的 `l0_tier.OWNER_NODE_NAMES`:身份事实的主语只可能是他,
 * 别人的学校不该进他的 L0;engine 侧原来硬编码 `("用户","<称呼>")`。
 * 为什么不复用另外两份:`speakers` 含「她 / Echo / 助手」(她的自述边不该进他的 L0),
 * `personNames` 含「妹妹 / 姐姐 / 弟弟 / 朋友 / NPC」(别人的身份事实不该进他的 L0)——
 * 三者语义不同,混一锅是隐患。
 * `ownerNames` 为空时**自动派生**自 `profile.json` 的 `userName` + `userAliases`
 * (他填了称呼就有;没填就没有 ⇒ 只剩角色槽,不猜)。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolveDataFilePath } from './data-dir.js'
import { loadProfile } from './profile.js'

/** 空名单(冻结):读不到就是它 —— 中性,不猜。 */
export const EMPTY_NAMES = Object.freeze({
  speakers: [], personNames: [], ownerNames: [], familyTerms: []
})

/** 数组字段 → 干净字符串表:丢非字符串、去空白、去重(文档 §7:去重、单条 ≤32)。 */
function strList (v) {
  const out = []
  for (const x of Array.isArray(v) ? v : []) {
    if (typeof x !== 'string') continue
    const s = x.trim()
    if (s !== '' && !out.includes(s)) out.push(s)
  }
  return out
}

/**
 * 读 names.json(只读、缺文件/坏文件 ⇒ 空名单,**永不抛**)。每次现读:
 * 读频低(面板刷新 / 一次工具调用),而"改了立刻生效"比省这点 IO 值。
 * @param {string|null} [path]
 * @returns {{speakers: string[], personNames: string[], ownerNames: string[], familyTerms: string[]}}
 */
export function loadNames (path = resolveDataFilePath('names.json')) {
  try {
    if (path === null || path === undefined || !existsSync(path)) return EMPTY_NAMES
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return {
      speakers: strList(raw?.speakers),
      personNames: strList(raw?.personNames),
      ownerNames: strList(raw?.ownerNames),
      familyTerms: strList(raw?.familyTerms)
    }
  } catch { return EMPTY_NAMES }
}

/**
 * 自节点名的**自动派生**来源 = `profile.json` 的 `userName` + `userAliases`
 * (P1c 拍板:ownerNames 默认空数组,只由 profile 派生 —— 他填了称呼就有)。
 * 读 profile.json 走**唯一读点** `lib/profile.js`(`loadProfile`),本函数只做
 * "userName 在前、aliases 去重跟上"这一层组合。**永不抛**(读不到 ⇒ `[]`)。
 * @param {string|null} [path]
 */
export function derivedOwnerNames (path = resolveDataFilePath('profile.json')) {
  const p = loadProfile(path)
  const out = p.userName === '' ? [] : [p.userName]
  for (const a of p.userAliases) if (!out.includes(a)) out.push(a)
  return out
}

/**
 * 引擎帧要的**自节点名**:`names.json.ownerNames` 非空 ⇒ 用它(用户可手编);
 * 空 ⇒ 派生自 profile(见 `derivedOwnerNames`);都空 ⇒ `[]`
 * (engine 侧只剩角色槽「用户」兜着 —— 宁少不错)。
 * @param {{namesPath?: string|null, profilePath?: string|null}} [opts]
 */
export function loadOwnerNames ({ namesPath = undefined, profilePath = undefined } = {}) {
  const own = loadNames(namesPath).ownerNames
  if (own.length > 0) return own
  return derivedOwnerNames(profilePath === undefined ? resolveDataFilePath('profile.json') : profilePath)
}
