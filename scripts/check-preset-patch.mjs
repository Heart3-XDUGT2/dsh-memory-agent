#!/usr/bin/env node
/**
 * v0.44.0 — `preset.patch.yml` 的存在性 / 世代匹配门(接进 npm run check)。
 * ============================================================
 * 为什么要有这道门:`package.json` 的 `dsh.bundle.patch` **点名**了
 * preset.patch.yml(文件本体不能删),而它的内容**按宿主世代分两种** ——
 *   * 0.2.0 世代 ⇒ 真声明行(@deepseek-ai/dsh-agent-preset);
 *   * 0.1.x 世代 ⇒ 空存根(0.1.5 认不出那个包,一行真声明有搞坏插件树的风险)。
 * 世代装反了不会当场炸,而是"预设不见了"或"插件树报错"这种隔夜才撞上的事 ——
 * 所以每次 npm run check 都对一遍:宿主什么世代、文件就该是什么内容。
 *
 * 找出厂 patch 的路子与 scripts/install-preset.mjs 一致(那边是生成,这边是验收;
 * 两处都读同一份出厂文件,谁变了都要能看出来)。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { PRESET_PATCH_FILE, PRESET_PATCH_MANIFEST, DEFAULT_ENTRY_NAME, DEFAULT_ROW_ID } from '../lib/preset-patch.js'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** 出厂 preset patch(0.2.0 世代底稿)在不在 —— 在就说明宿主是 0.2.0 世代。 */
function shippedPresetPatch (name) {
  const marks = []
  if (process.env.DSH_WEB_APP) marks.push(process.env.DSH_WEB_APP)
  marks.push(join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-web-app'))
  marks.push(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-web-app'))
  marks.push(join(dshHome, 'node_modules', '@deepseek-ai', 'dsh-web-app'))
  try {
    const req = createRequire(join(dshHome, 'profiles', 'web', 'package.json'))
    // 两条腿:package.json 子路径(有的包不导出)与主入口反推包根
    try { marks.push(dirname(req.resolve('@deepseek-ai/dsh-web-app/package.json'))) } catch { }
    try { marks.push(dirname(dirname(req.resolve('@deepseek-ai/dsh-web-app')))) } catch { }
    try {
      const dshDir = dirname(req.resolve('@deepseek-ai/dsh/package.json'))
      marks.push(join(dshDir, 'node_modules', '@deepseek-ai', 'dsh-web-app'))
      marks.push(join(dirname(dshDir), 'dsh-web-app'))
    } catch { }
  } catch { }
  for (const base of marks.filter(Boolean)) {
    const f = join(base, 'presets', name + '.patch.yml')
    if (existsSync(f)) return f
  }
  return null
}

const stockPatchFile = shippedPresetPatch('standard')
const generation = stockPatchFile !== null ? '0.2.0' : '0.1.x'
const problems = []
const notes = []

// ---- manifest 形态也按世代(0.1.5 只吃字符串,0.2.0 才收一串)----
{
  const pkg = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))
  const patchField = pkg?.dsh?.bundle?.patch
  const isArray = Array.isArray(patchField)
  const namesPatchFile = isArray
    ? patchField.some((f) => String(f).includes(PRESET_PATCH_FILE))
    : String(patchField ?? '').includes(PRESET_PATCH_FILE)
  if (generation === '0.2.0') {
    if (!isArray || !namesPatchFile) {
      problems.push('[形] 宿主是 0.2.0 世代,但 package.json 的 dsh.bundle.patch '
        + (isArray ? '没点名 ' + PRESET_PATCH_FILE : '还是字符串形态(只点名一个文件)')
        + ' —— ' + PRESET_PATCH_FILE + ' 进不了组合树,声明白生成;'
        + ' 重跑 node scripts/install-preset.mjs 会摆正')
    }
  } else {
    if (isArray) {
      problems.push('[险] 宿主是 0.1.x 世代,但 dsh.bundle.patch 是数组 ——'
        + ' 0.1.5 的 loadProfileDirectory 会 path.join 当场炸(实测);'
        + ' 重跑 node scripts/install-preset.mjs 摆回字符串形态')
    } else if (namesPatchFile) {
      problems.push('[险] 0.1.x 世代的 dsh.bundle.patch 只该点名 cordis.patch.yml;'
        + ' 现在点的是 ' + PRESET_PATCH_FILE + '(那意味着 echo 主行没挂上)')
    }
  }
}

const patchFile = join(pkgRoot, PRESET_PATCH_FILE)
if (!existsSync(patchFile)) {
  problems.push('[缺] ' + PRESET_PATCH_FILE + ' 不在 —— bundle patch 列表要点名它,文件本体不能缺;'
    + ' 跑 node scripts/install-preset.mjs 生成')
} else {
  const body = await readFile(patchFile, 'utf8')
  const hasRow = /^\s*- id: /m.test(body)
  if (generation === '0.2.0') {
    if (!hasRow) {
      problems.push('[空] 宿主是 0.2.0 世代(出厂 ' + join('presets', 'standard.patch.yml') + ' 在),'
        + '但 ' + PRESET_PATCH_FILE + ' 还是空存根 —— Echo 预设不会进名单;'
        + ' 重跑 node scripts/install-preset.mjs 把声明填上')
    } else {
      if (!body.includes(DEFAULT_ENTRY_NAME)) {
        problems.push('[错] 声明里没有 ' + DEFAULT_ENTRY_NAME + '(压缩那一行没换)')
      }
      if (body.includes('@deepseek-ai/dsh-compaction-basic')) {
        problems.push('[错] 声明里还有 @deepseek-ai/dsh-compaction-basic(压缩那一行没换)')
      }
      if (body.includes('- id: preset-standard')) {
        problems.push('[撞] 声明行 id 还是出厂的 preset-standard —— 会跟出厂那行同 id(Load 编辑地址撞车),得是 ' + DEFAULT_ROW_ID)
      }
    }
  } else {
    if (hasRow) {
      problems.push('[险] 宿主是 0.1.x 世代,但 ' + PRESET_PATCH_FILE + ' 里有声明行 ——'
        + ' 0.1.5 会去解析一个不存在的包(@deepseek-ai/dsh-agent-preset),有搞坏插件树的风险;'
        + ' 重跑 node scripts/install-preset.mjs 换回空存根')
    }
  }
  if (!body.includes('generated-by: dsh-echo@')) {
    notes.push(PRESET_PATCH_FILE + ' 没有 generated-by 标记(不是本脚本那条生成链写的)')
  }
}

if (!existsSync(join(pkgRoot, PRESET_PATCH_MANIFEST))) {
  notes.push(PRESET_PATCH_MANIFEST + ' 不在(指纹保护会按"没清单"处理:升级时不会覆盖你手改过的东西)')
}

if (problems.length > 0) {
  for (const p of problems) console.log(p)
  process.exit(1)
}
console.log('preset.patch.yml OK(' + generation + ' 世代:' + (generation === '0.2.0' ? '声明行 ' + DEFAULT_ROW_ID : '空存根') + ')')
if (stockPatchFile !== null) console.log('  出厂底稿在: ' + stockPatchFile)
for (const n of notes) console.log('  提醒:' + n)
