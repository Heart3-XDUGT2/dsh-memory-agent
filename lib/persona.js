/**
 * 「Echo 的人格」:读写 + 分类。
 *
 * ★ 数据与程序分离 P1b(2026-10-05):**程序里不再有人格文本**。
 *   · `DEFAULT_PERSONA` 从此是空串 —— 「人格为空」的含义是**不注入人格**,
 *     不再"回落出厂文本"(那正是 P1b 要改掉的行为)。
 *   · 插件历史上写过的那几版默认人格搬进了 `persona-legacy-defaults.json`
 *     (只读史料,路径见 lib/data-dir.js 的 resolvePersonaLegacyPath)。
 *     程序只在两处用它:①认出一份 persona.json 是"插件写的旧默认,不是他写的"
 *     ②面板要出厂文本时当兜底。它**永不**被程序写回,也永不覆盖他写的字。
 *   · 旧默认副本**不再被自动升级/覆盖**(插件已经没有"当前默认"可升):
 *     文本原样留着,只补一个 `legacyDefault: true` 标记(不静默清空)。
 *
 * 注入位置:前段挂 order 10245、后段挂 10250,两段挨着;
 * 末位=最强提醒位(character.ai 的经验:行为规则放尾部)。
 *
 * 2026-09-26 改:前段原先挂 order 100(整段 system prompt 的 1.1% 处,后面
 * 隔着 8000 字工具说明),实测她说话完全不听前段 —— 角色定义离语域锚点太远。
 * 现在前段 10245、后段 10250,两段挨着;判据见 scripts/check-echo-persona.mjs。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
// P2 §6.3 末行(2026-10-05 用户批准):人格落盘也走**唯一写路径**(备份→校验→
// .tmp+rename→失效缓存)。钳位仍用本文件自己的 `sanitize`,不复制到别处。
import { writeDataFile } from './data-write.js'
import {
  resolveDataDir, resolvePersonaPath, resolvePersonaLegacyPath
} from './data-dir.js'

export const DATA_DIR = resolveDataDir()
export const PERSONA_PATH = resolvePersonaPath()
export const LEGACY_PERSONA_PATH = resolvePersonaLegacyPath()

/**
 * 出厂人格 = **空**。P1b 之前这里是一整段真人写的人格文本;现在它是空的:
 * 空 = 不注入人格(而不是"回落出厂文本")。要那几版旧文本请读史料。
 */
export const DEFAULT_PERSONA = { prefix: '', suffix: '' }

/** 单段人格文本的硬上限(防面板粘贴整本小说撑爆系统提示)。 */
export const PERSONA_MAX_CHARS = 4000

/**
 * 插件最后一次写默认人格时的修订号。P1b 起程序不再写默认,
 * 这个号只剩一个用处:史料丢了的时候,还能认出"defaultsRev < 3 = 旧默认"。
 */
export const DEFAULTS_REV = 3

/**
 * ⚠️ P1b 起是**空数组**:程序里不再内嵌任何冻结的真人文本。
 * 冻结史料搬去了 persona-legacy-defaults.json —— 要用请走 `knownStaleSuffixes()`。
 * 保留这个导出只为"老读者一眼看到它空了",也让下游 import 不至于直接炸。
 */
export const KNOWN_STALE_SUFFIXES = Object.freeze([])

/** 史料缺失时的降级形状:rev 号用程序常量、文本全空(认得出版本号,认不出文本)。 */
const EMPTY_LEGACY = Object.freeze({
  finalDefaultsRev: DEFAULTS_REV,
  finalDefault: { prefix: '', suffix: '' },
  staleDefaults: []
})

/**
 * 读史料(**只读、缺文件/坏文件 ⇒ 空史料,永不抛**)。
 * 每次现读、不缓存:史料是一次性写入的小文件,而"迁移写完之后同进程再读"
 * 如果吃到缓存,就会拿陈值判人格 —— 不值得为这点 IO 冒这个险。
 * @param {string} [path]
 * @returns {{ finalDefaultsRev: number, finalDefault: {prefix: string, suffix: string}, staleDefaults: Array<{rev: number, prefix: string, suffix: string}> }}
 */
export function legacyPersonaDefaults (path = LEGACY_PERSONA_PATH) {
  try {
    if (!existsSync(path)) return EMPTY_LEGACY
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw === null || typeof raw !== 'object') return EMPTY_LEGACY
    const finalRev = Number(raw.finalDefaultsRev)
    return {
      finalDefaultsRev: Number.isFinite(finalRev) ? finalRev : DEFAULTS_REV,
      finalDefault: {
        prefix: typeof raw.finalDefault?.prefix === 'string' ? raw.finalDefault.prefix : '',
        suffix: typeof raw.finalDefault?.suffix === 'string' ? raw.finalDefault.suffix : ''
      },
      staleDefaults: Array.isArray(raw.staleDefaults)
        ? raw.staleDefaults.filter((d) => d !== null && typeof d === 'object' && typeof d.suffix === 'string')
        : []
    }
  } catch {
    return EMPTY_LEGACY // 史料读不出来 = 没有史料,不影响人格读写
  }
}

/** 已知历史默认的后缀(从史料读;程序里不再内嵌)。 */
export function knownStaleSuffixes (legacy = legacyPersonaDefaults()) {
  return legacy.staleDefaults.map((d) => d.suffix)
}

/**
 * 盘上人格文件的分类:'user'(他写的文本,永远尊重)/ 'stale'(插件写下的
 * 旧默认副本)/ 'current'(插件最后一版默认)。纯函数,离线可测。
 *
 * P1b 起判据从**史料**读(第二个参数可注入 fixture);
 * 注意 'stale' 的含义变了:以前是"该升级",现在是"该被认出来但**不许覆盖**"。
 * @param {unknown} raw
 * @param {{ finalDefaultsRev?: number, finalDefault?: {prefix?: string, suffix?: string}, staleDefaults?: Array<{suffix: string}> }} [legacy]
 */
export function classifyPersonaFile (raw, legacy = legacyPersonaDefaults()) {
  if (raw === null || typeof raw !== 'object') return 'user'
  if (raw.edited === true) return 'user'
  const rev = Number(raw.defaultsRev)
  const finalRev = Number.isFinite(legacy?.finalDefaultsRev) ? legacy.finalDefaultsRev : DEFAULTS_REV
  if (rev === finalRev) return 'current'
  if (Number.isFinite(rev) && rev >= 1 && rev < finalRev) return 'stale'
  // legacy(无标记的旧文件):文本命中已知历史默认 → 旧默认副本;
  // 不命中 = 他改过 —— 宁可漏认,绝不覆盖他写的字。
  const prefix = typeof raw.prefix === 'string' ? raw.prefix : ''
  const suffix = typeof raw.suffix === 'string' ? raw.suffix : ''
  const known = Array.isArray(legacy?.staleDefaults) ? legacy.staleDefaults : []
  if (prefix === (legacy?.finalDefault?.prefix ?? '') && known.some((d) => d?.suffix === suffix)) return 'stale'
  return 'user'
}

/**
 * 文本规整:非字符串 / 空 / 纯空白 ⇒ **空串**。
 * P1b 起不再有 fallback —— 空就是空(空 = 不注入人格)。
 */
function sanitize (text) {
  if (typeof text !== 'string') return ''
  const trimmed = text.trim()
  if (trimmed === '') return ''
  return trimmed.slice(0, PERSONA_MAX_CHARS)
}

/**
 * 给"插件写的旧默认副本"补一个 `legacyDefault: true`(文本与未知字段一字不动)。
 * 只有命中史料、且他没编辑过的文件才会走到这里。
 */
async function markLegacyDefault (raw) {
  if (raw.legacyDefault === true) return null
  const payload = { ...raw, legacyDefault: true, legacyMarkedAt: new Date().toISOString() }
  await writeFile(PERSONA_PATH, JSON.stringify(payload, null, 2), 'utf8')
  return payload
}

/**
 * 读人格。P1b 之后的规矩:
 *  · 文件不在 / 读不出来 ⇒ **不注入**(前后段都空)、**不写盘**、不塞出厂文本;
 *  · `edited:true`(他编辑过)⇒ 原样尊重,永不覆盖;
 *  · 插件写的旧默认副本 ⇒ 文本原样留着(不静默清空),标 `legacyDefault: true`。
 * 永不抛错 —— 人格是提示词,不是账本。
 */
export async function loadPersona () {
  try {
    if (existsSync(PERSONA_PATH)) {
      const raw = JSON.parse(await readFile(PERSONA_PATH, 'utf8'))
      const cls = classifyPersonaFile(raw)
      const prefix = sanitize(raw.prefix)
      const suffix = sanitize(raw.suffix)
      if (cls === 'stale') {
        await markLegacyDefault(raw).catch(() => {})
        return { prefix, suffix, customized: false, legacyDefault: true }
      }
      return { prefix, suffix, customized: cls === 'user' }
    }
  } catch { /* 损坏:不写盘 —— 宁可"这次不注入",也不清空他盘上的字 */ }
  return { prefix: '', suffix: '', customized: false }
}

/**
 * 写人格:面板编辑(默认 `edited: true` = 用户拥有文本,迁移永不覆盖);
 * 插件写默认时传 `edited: false`。
 *
 * P1b:非字符串**直接拒绝** —— "空"是合法语义(不注入),但"缺字段"不是:
 * 那是坏请求,不许拿它清空他写的话。失败上抛由调用方降级。
 */
export async function savePersona (prefix, suffix, { edited = true } = {}) {
  if (typeof prefix !== 'string' || typeof suffix !== 'string') {
    throw new TypeError('savePersona: prefix/suffix 必须是字符串(缺字段的坏请求不许清空人格)')
  }
  await mkdir(DATA_DIR, { recursive: true })
  const payload = {
    prefix: sanitize(prefix),
    suffix: sanitize(suffix),
    edited,
    defaultsRev: DEFAULTS_REV,
    savedAt: new Date().toISOString()
  }
  // P2:走唯一写路径(它有备份/原子/失效)。校验不过照样抛 —— 由调用方降级。
  writeDataFile('persona.json', { schemaRev: 1, ...payload }, { dir: DATA_DIR })
  return payload
}
