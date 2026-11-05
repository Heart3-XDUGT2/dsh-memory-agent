/**
 * 真昵称 lint —— 「代码里根本不该有真昵称」这条纪律的本地闸(2026-10-06)。
 *
 * 为什么要有它:发布脚本的硬闸只查四类(用户名边界 / 盘符绝对前缀 / token 形态 /
 * 数据目录路径),**真称呼不在其中** —— 2026-10-06 干跑实测:真昵称在发布树里
 * 87 处 / 20 文件(另 21 处别名 / 8 文件)却一路绿灯。口径缺口不能靠"发布时洗"
 * 补,得在**开发时**拦住。
 *
 * 纪律:真值只活在数据目录的 `profile.json`(做法 B);仓里只许出现**中性假值**
 * (测试夹具:`阿岚` / `阿乙`;文档:`<称呼>`;代码注释:描述性说法)。
 *
 * 判据(**不写死、不猜**):
 *   · 针 = `profile.json` 的 `userAliases` + `agentAliases`(trim + 去重)。
 *   · **通用词不拦**:`userName` / `agentName` / `agentSelfRef` 常是「用户」「助手」
 *     这种角色槽,`agentAliases` 里还可能有**项目自己的公开名**(如 `Echo`)——
 *     这些进 `GENERIC_NAMES`,不当针(否则误伤整仓:文档里到处是 Echo)。
 *   · ASCII 针走**词边界**(`kuroCount` 不算命中,`kuro说` 算);
 *     CJK 针直接子串(中文里名字天然贴着别的字,边界没有意义)。
 *   · 例外白名单**集中在一处**(`WHITELIST`),每条必须写清为什么;默认空 = 不许例外。
 *
 * 纯逻辑住这里(可离线测);遍历文件系统的部分在 `scripts/check-names.mjs`。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolveDataFilePath } from './data-dir.js'

/** 角色槽与**项目公开名** —— 不作为针(它们进代码/文档是正常的)。 */
export const GENERIC_NAMES = Object.freeze([
  '用户', '助手', '她', '他', '你', '我', '主人', '对方',
  'user', 'assistant', 'master', 'agent', 'system',
  'Echo' // 项目自己的名字(repo 名、文档、包名里必须有)
])

/** 扫描范围(目录)与排除项。 */
export const SCAN_DIRS = Object.freeze(['lib', 'python', 'web', 'tests', 'docs', 'scripts'])
export const SKIP_DIRS = Object.freeze(['node_modules', '.git', 'archive', '.scratch', '__pycache__', 'data', 'backup'])
export const SKIP_EXT = Object.freeze([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.woff', '.woff2', '.ttf', '.otf',
  '.db', '.ico', '.zip', '.gz', '.pyc', '.log'
])
/** 根文档:与目录一起扫(README/CHANGELOG/HANDOVER 这些不进任何子目录)。 */
export const ROOT_FILES = Object.freeze([
  'README.md', 'CHANGELOG.md', 'HANDOVER.md', 'LICENSE', 'package.json',
  'cordis.patch.yml', 'preset.patch.yml'
])

/**
 * 例外白名单 —— **默认空**;要加必须写清为什么。
 *
 * 现存唯一一条:发布脚本把作者身份写死成提交身份(`git commit --author`)——
 * 那是**刻意公开**的名字(推上去的 commit 署名就是它),不是泄漏。
 *
 * 自净纪律(与 `scripts/publish-org.ps1` 同款):本文件自己也在扫描范围内,
 * 所以这里**不写死**那个字的整段字面量(拆开拼),否则闸会把自己闸死。
 */
export const WHITELIST = Object.freeze([
  Object.freeze({
    file: 'scripts/publish-org.ps1',
    needle: 'yo' + 'tao',
    why: '发布脚本的提交身份 AuthorName/AuthorEmail:刻意公开(远程 commit 署名就是它),非隐私泄漏'
  })
])

/** 该针在该文件里是否被白名单豁免(大小写不敏感的同义词也算)。 */
export function whitelistedFor (file, needle) {
  const f = String(file ?? '').replace(/\\/g, '/').toLowerCase()
  const n = String(needle ?? '').toLowerCase()
  return WHITELIST.some((w) => {
    const wf = String(w.file).replace(/\\/g, '/').toLowerCase()
    const wn = String(w.needle).toLowerCase()
    return (f === wf || f.endsWith('/' + wf)) && wn === n
  })
}

/** 是不是"纯 ASCII 词"(词边界规则只对它有意义)。 */
export function isAsciiWord (s) {
  return /^[A-Za-z0-9_]+$/.test(s)
}

/**
 * profile → 针表。喂进来的是 `profile.json` 解析后的对象(缺字段/坏形状都容)。
 * @returns {Array<{needle: string, kind: 'user'|'agent', ascii: boolean}>}
 */
export function buildNeedles (profile) {
  const p = (profile !== null && typeof profile === 'object') ? profile : {}
  const generic = new Set(GENERIC_NAMES.map((s) => s.toLowerCase()))
  const seen = new Map()
  const push = (raw, kind) => {
    const v = String(raw ?? '').trim()
    if (v === '' || v.length < 2) return           // 单字不当针(太容易误伤)
    if (generic.has(v.toLowerCase())) return       // 角色槽 / 公开名
    const key = v.toLowerCase()
    if (seen.has(key)) return
    seen.set(key, { needle: v, kind, ascii: isAsciiWord(v) })
  }
  for (const a of Array.isArray(p.userAliases) ? p.userAliases : []) push(a, 'user')
  for (const a of Array.isArray(p.agentAliases) ? p.agentAliases : []) push(a, 'agent')
  // 姓名本身也当针,但**只在它不是通用词时**(「用户」「助手」会被 generic 挡掉)
  push(p.userName, 'user')
  push(p.agentName, 'agent')
  push(p.agentSelfRef, 'agent')
  return [...seen.values()]
}

/**
 * 从**数据目录的 `profile.json`** 现读针表 —— 仓里不写死真值,换机就跟着换。
 * 读不到 / 坏文件 ⇒ 空表(调用方据此降级成"只验形状",不留安静的绿)。
 */
export function loadNeedles () {
  const p = resolveDataFilePath('profile.json')
  if (!p || !existsSync(p)) return []
  try {
    return buildNeedles(JSON.parse(readFileSync(p, 'utf8')))
  } catch {
    return []
  }
}

/** 在 `idx` 处的命中是否踩到词边界规则(ASCII 针才需要判)。 */function boundaryOk (text, idx, needle) {
  const before = idx > 0 ? text[idx - 1] : ''
  const after = idx + needle.length < text.length ? text[idx + needle.length] : ''
  const isWordChar = (c) => c !== '' && /[A-Za-z0-9_]/.test(c)
  return !isWordChar(before) && !isWordChar(after)
}

/**
 * 扫一段文本。返回每条针的命中(带行号,便于人去看)。
 * @returns {Array<{needle: string, kind: string, count: number, line: number, excerpt: string}>}
 */
export function scanText (text, needles) {
  const src = String(text ?? '')
  const out = []
  for (const n of Array.isArray(needles) ? needles : []) {
    const needle = String(n?.needle ?? '')
    if (needle === '') continue
    const lower = src.toLowerCase()
    const target = needle.toLowerCase()
    let i = 0
    let count = 0
    let first = -1
    while ((i = lower.indexOf(target, i)) >= 0) {
      const ok = n.ascii === true ? boundaryOk(src, i, needle) : true
      if (ok) {
        count += 1
        if (first < 0) first = i
      }
      i += needle.length
    }
    if (count > 0) {
      const line = src.slice(0, first).split('\n').length
      const lineStart = src.lastIndexOf('\n', first) + 1
      const lineEnd = src.indexOf('\n', first)
      const excerpt = src.slice(lineStart, lineEnd < 0 ? Math.min(src.length, lineStart + 120) : lineEnd).trim().slice(0, 120)
      out.push({ needle, kind: String(n.kind ?? ''), count, line, excerpt })
    }
  }
  return out
}

/**
 * 扫一批已读进来的文件(纯函数:调用方给 `{path, text}`)。
 * @returns {Array<{file: string, needle: string, kind: string, count: number, line: number, excerpt: string}>}
 */
export function scanFiles (files, needles) {
  const out = []
  for (const f of Array.isArray(files) ? files : []) {
    const path = String(f?.path ?? '')
    if (path === '') continue
    for (const hit of scanText(f.text, needles)) {
      if (whitelistedFor(path, hit.needle)) continue
      out.push({ file: path, ...hit })
    }
  }
  return out
}
