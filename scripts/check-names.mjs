#!/usr/bin/env node
/**
 * 真昵称闸(仓内扫描)—— `npm run check` 与 `tests/name-lint.test.js` 共用。
 *
 * 针从**数据目录的 profile.json** 现读(不写死);判据与白名单在 `lib/name-lint.js`。
 * 命中即非零退出,并逐条打印 `文件:行 针(次数)` + 那一行原文。
 *
 * 用法:
 *   node scripts/check-names.mjs                 # 扫仓(找不到 profile ⇒ 跳过,退出 0)
 *   node scripts/check-names.mjs --profile <p>   # 指定 profile(测试用)
 *   node scripts/check-names.mjs --quiet         # 只在命中时打印
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, relative, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDataFilePath } from '../lib/data-dir.js'
import {
  buildNeedles, scanFiles, GENERIC_NAMES, SCAN_DIRS, SKIP_DIRS, SKIP_EXT, ROOT_FILES, WHITELIST
} from '../lib/name-lint.js'

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)))
const ROOT = resolve(HERE, '..')

function argOf (flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : ''
}
const QUIET = process.argv.includes('--quiet')

/** 读 profile.json(显式路径 > 数据目录);读不到/坏 ⇒ null(= 跳过扫描)。 */
export function loadProfile (explicit) {
  const p = explicit !== '' ? explicit : resolveDataFilePath('profile.json')
  if (!p || !existsSync(p)) return { profile: null, path: p }
  try {
    return { profile: JSON.parse(readFileSync(p, 'utf8')), path: p }
  } catch {
    return { profile: null, path: p }
  }
}

function walk (dir, out = []) {
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.includes(e.name)) continue
      if (e.name.startsWith('.')) continue
      walk(full, out)
    } else if (e.isFile()) {
      if (SKIP_EXT.includes(extname(e.name).toLowerCase())) continue
      out.push(full)
    }
  }
  return out
}

export function collectFiles (root = ROOT) {
  const files = []
  for (const d of SCAN_DIRS) {
    const dir = join(root, d)
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir, files)
  }
  for (const f of ROOT_FILES) {
    const full = join(root, f)
    if (existsSync(full) && statSync(full).isFile()) files.push(full)
  }
  return files
}

export function scanRepo ({ root = ROOT, profilePath = '' } = {}) {
  const { profile, path } = loadProfile(profilePath)
  const needles = buildNeedles(profile)
  if (needles.length === 0) return { skipped: true, needles, hits: [], profilePath: path }
  const payload = []
  for (const full of collectFiles(root)) {
    let text = ''
    try { text = readFileSync(full, 'utf8') } catch { continue }
    if (text.indexOf('\u0000') >= 0) continue
    payload.push({ path: relative(root, full).replace(/\\/g, '/'), text })
  }
  return { skipped: false, needles, hits: scanFiles(payload, needles), profilePath: path }
}

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const r = scanRepo({ profilePath: argOf('--profile') })
  if (r.skipped) {
    if (!QUIET) console.log('真昵称闸:跳过(读不到 profile.json 的别名 —— 换机/清过数据目录)')
    process.exit(0)
  }
  if (!QUIET) {
    console.log('真昵称闸:针 = ' + r.needles.map((n) => n.needle + '(' + n.kind + ')').join(' , ')
      + ' | 通用词豁免 = ' + GENERIC_NAMES.join(' '))
    console.log('真昵称闸:白名单 ' + WHITELIST.length + ' 条'
      + (WHITELIST.length ? ' — ' + WHITELIST.map((w) => w.file + ':' + w.needle).join(' , ') : '(空 = 不许例外)'))
  }
  if (r.hits.length === 0) {
    console.log('真昵称闸:过 —— 0 命中(' + r.needles.length + ' 条针,扫 lib/python/web/tests/docs/scripts + 根文档)')
    process.exit(0)
  }
  console.log('真昵称闸:❌ 命中 ' + r.hits.length + ' 处 —— 仓里只许出现中性假值(测试夹具 阿岚/阿乙,文档 <称呼>)')
  for (const h of r.hits) {
    console.log('  [' + h.kind + '] ' + h.file + ':' + h.line + '  ' + h.needle + ' ×' + h.count + '  | ' + h.excerpt)
  }
  process.exit(1)
}
