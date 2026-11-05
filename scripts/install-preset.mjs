#!/usr/bin/env node
/**
 * v0.20.0 D1 — 生成/校验/删除「Echo 陪伴模式」预设。
 * ============================================================
 * 用法:
 *   node scripts/install-preset.mjs            # 生成(现读出厂标准预设,只换压缩那一行)
 *   node scripts/install-preset.mjs --check    # 校验(不写)
 *   node scripts/install-preset.mjs --remove   # 删除这份预设
 *   node scripts/install-preset.mjs --help
 *
 * 为什么是"另立一份预设",不是改 profile / 改出厂文件:
 *   `CompactionEngine` 是 cordis `Service`(名字 `compaction`),一个 context
 *   只能有一个;而 web profile 自己把 `compaction-basic` 关了 —— 压缩后端
 *   住在 **preset 平面**(见 lib/preset-patch.js 的详细出处)。
 *
 * v0.44.0 起**按宿主世代分两条路**(谁先发现谁说了算,不用你指):
 *   * 0.2.0 世代(出厂 `dsh-web-app/presets/<base>.patch.yml` 在)⇒
 *     预设是 **bundle patch 里的一行 `@deepseek-ai/dsh-agent-preset` 声明**:
 *     生成 `<本包>/preset.patch.yml`(+ `.preset-patch-generated.json` 清单)。
 *     0.2.0 的注册表"不扫目录、不收路径"(README 原话),旧目录那条路没了。
 *   * 0.1.5 世代 ⇒ 走老路:落 `<DSH_HOME>/.agent-presets/echo/`
 *     (自动发现每次读盘重扫,不用重启);同时把 `preset.patch.yml` 写成
 *     **空存根** —— `dsh.bundle.patch` 点名了它,0.1.5 的 loader 也要读得到。
 *
 * 两条路都还是"现读现出厂、只换压缩那一行",都带 generated-by 与指纹保护
 * (你手改过的部分,升级不会盖掉)。
 *
 * 低风险:预设按会话挂载;这份预设坏了只坏它自己,不拦 DSH 启动。
 * 不选它 ⇒ 一切照旧。
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  patchPresetComposition, presetMetadata, DEFAULT_ENTRY_NAME,
  checkUpgrade, makeManifest, generatedByLine, PRESET_MANIFEST,
  presetDeclarationPatch, emptyPresetPatch, setBundlePatchForm,
  PRESET_PATCH_FILE, PRESET_PATCH_MANIFEST, DEFAULT_ROW_ID
} from '../lib/preset-patch.js'

const require_ = null // (占位勿用)
let VERSION = 'unknown'
try {
  // F3:`generated-by` 里要钉版本 —— 从本仓 package.json 现读,不硬编码
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  VERSION = String(JSON.parse(await readFile(pkgPath, 'utf8')).version || 'unknown')
} catch { VERSION = 'unknown' }

const args = new Set(process.argv.slice(2))
const known = new Set(['--check', '--remove', '--help', '--from', '--force'])
for (const a of args) {
  if (!known.has(a) && !a.startsWith('--from=')) {
    console.error('Unknown option: ' + a)
    process.exit(2)
  }
}
if (args.has('--help')) {
  console.log(`dsh-echo preset installer

  node scripts/install-preset.mjs            生成 Echo 陪伴模式预设(现读出厂 standard)
  node scripts/install-preset.mjs --check    只校验,不写
  node scripts/install-preset.mjs --remove   删掉这份预设
  node scripts/install-preset.mjs --force    重铺(会先把动过的文件备份成 *.bak-<时间>)
  node scripts/install-preset.mjs --from=ptc  换一份出厂预设做底(默认 standard)

生成物:<DSH_HOME>/.agent-presets/echo/{agent.cordis.yml,preset.yml,.echo-generated.json}
它只把 compaction 域里的 dsh-compaction-basic 换成 ${DEFAULT_ENTRY_NAME}
(thresholdRatio 0.3 / retainRatio 0.25);其余与出厂预设逐字一致。
v0.39.0 起:生成物带 generated-by + 版本,并且**你手改过的部分不会被升级盖掉**
—— 指纹对不上就停下来告诉你哪几个文件动过(要重铺加 --force,会先备份)。
不做成 profile 层:压缩后端住在 preset 平面(一个 context 只有一个 compaction 服务)。`)
  process.exit(0)
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const presetRoot = join(dshHome, '.agent-presets')
const presetId = process.env.ECHO_PRESET_ID ?? 'echo'
const presetDir = join(presetRoot, presetId)
const fromArg = [...args].find((a) => a.startsWith('--from'))
const basePreset = fromArg ? (fromArg.includes('=') ? fromArg.split('=')[1] : 'standard') : 'standard'

/** 出厂预设根:dsh-agent-presets 包里的 presets/,从 profile 的 node_modules 解析。 */
function shippedPresetDir (name) {
  const candidates = [
    process.env.DSH_AGENT_PRESETS,
    join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-agent-presets'),
    join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-agent-presets'),
    join(dshHome, 'node_modules', '@deepseek-ai', 'dsh-agent-presets')
  ].filter(Boolean)
  for (const base of candidates) {
    const dir = join(base, 'presets', name)
    if (existsSync(join(dir, 'agent.cordis.yml'))) return dir
  }
  // 再试一次正经的模块解析(profile 的依赖树)
  try {
    const req = createRequire(join(dshHome, 'profiles', 'web', 'package.json'))
    const entry = req.resolve('@deepseek-ai/dsh-agent-presets')
    const dir = join(dirname(dirname(entry)), 'presets', name)
    if (existsSync(join(dir, 'agent.cordis.yml'))) return dir
  } catch { }
  return null
}

async function readJsonSafe (p) {
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return null }
}

// ---- v0.44.0:0.2.0 世代 = 声明式(生成 <本包>/preset.patch.yml)----
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const patchFile = join(pkgRoot, PRESET_PATCH_FILE)
const patchManifestPath = join(pkgRoot, PRESET_PATCH_MANIFEST)

/**
 * 出厂 preset patch(0.2.0 世代的底稿):`dsh-web-app/presets/<base>.patch.yml`。
 * 找包的路子和出厂预设目录那条一样:显式指路 → profile 的 node_modules →
 * 正经模块解析(含 dsh 安装里的内嵌副本与独立安装的同级副本)。
 */
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

/** 声明里的元数据(名字/说明/排序和旧路径那份一字不差 —— 世代换了,人话没换)。 */
function declarationMetadata () {
  return {
    rowId: DEFAULT_ROW_ID,
    presetId,
    name: 'Echo 陪伴模式',
    description: '给她的会话用:压缩时不再写英文工程检查点,改由 Echo 从自己的记忆库策展一页关系备忘(关系账本 / 没结掉的事 / 她记得的你)。其余能力与标准模式一致。',
    order: 9,
    entryName: DEFAULT_ENTRY_NAME,
    version: VERSION,
    at: new Date().toISOString(),
    base: basePreset
  }
}

/**
 * 比对时抹平生成戳(版本号 + 时间):它们每次都变,但**内容**才是要校验的。
 * (老路那条不需要这个 —— 组合文本里本来就没有戳。)
 */
const normalizeStamp = (s) => String(s)
  .replace(/generated-by: dsh-echo@[^\s]+/g, 'generated-by: dsh-echo@<v>')
  .replace(/ at \d{4}-\d{2}-\d{2}T[^\s]+/g, ' at <ts>')

const stockPatchFile = shippedPresetPatch(basePreset)

/**
 * 把 package.json 的 `dsh.bundle.patch` 摆成当前世代该有的形态
 * (0.2.0 = 数组带 preset.patch.yml;0.1.x = 只点名 cordis.patch.yml 的字符串)。
 * 为什么连 manifest 都要生成器管:0.1.5 的 loader 只吃字符串(数组当场炸),
 * 0.2.0 才收一串 —— 形态本身就是"世代的函数",人手摆就一定会忘。
 * 只在形态不对时写盘,幂等。
 */
async function ensureManifestForm (wantArray) {
  const pkgPath = join(pkgRoot, 'package.json')
  const r = setBundlePatchForm(JSON.parse(await readFile(pkgPath, 'utf8')), wantArray)
  if (!r.changed) return false
  await writeFile(pkgPath, JSON.stringify(r.manifest, null, 2) + '\n', 'utf8')
  return true
}

if (stockPatchFile !== null) {
  // ================= 0.2.0 世代:声明式 =================
  const meta = declarationMetadata()
  const buildPatch = async () => {
    const raw = await readFile(stockPatchFile, 'utf8')
    const r = presetDeclarationPatch(raw, meta)
    if (r.changed === false && r.reason !== 'already-patched') {
      throw new Error('出厂声明 ' + stockPatchFile + ' 里做不了手术(' + r.reason + ')'
        + ' —— 宿主大概换过预设声明的形状或压缩后端的挂法;本脚本故意现读现改,'
        + '就是为了这种情况能被发现,而不是悄悄写成错的')
    }
    return r.text
  }

  if (args.has('--check')) {
    const built = await buildPatch()
    const installed = existsSync(patchFile) ? await readFile(patchFile, 'utf8') : null
    if (installed === null) {
      console.log('[缺] ' + patchFile + ' 不在 —— 跑 node scripts/install-preset.mjs 生成')
      process.exit(1)
    }
    const notes = []
    if (normalizeStamp(installed) !== normalizeStamp(built)) {
      console.log('[旧] ' + PRESET_PATCH_FILE + ' 与当前出厂 ' + basePreset + ' 不一致(宿主升级过或改过)'
        + ' —— 重跑 node scripts/install-preset.mjs 就会跟上')
      process.exit(1)
    }
    const manifestPath = patchManifestPath
    if (!existsSync(manifestPath)) notes.push(PRESET_PATCH_MANIFEST + ' 不在(不是本脚本生成的;升级会停下来先问你)')
    else {
      const m = await readJsonSafe(manifestPath)
      const current = { [PRESET_PATCH_FILE]: installed }
      const v = checkUpgrade({ manifest: m, current, next: null })
      if (m && m.version !== VERSION) notes.push('生成于 v' + m.version + ',当前插件 v' + VERSION + '(重跑一次就跟上)')
      if (!v.ok) notes.push('⚠️ 指纹对不上:' + v.edited.join('、') + '(你手改过的部分,升级不会盖掉)')
    }
    if (!installed.includes(DEFAULT_ENTRY_NAME)) notes.push('⚠️ 压缩那一行没换(找不到 ' + DEFAULT_ENTRY_NAME + ')')
    if (installed.includes('- id: preset-standard')) notes.push('⚠️ 声明行 id 还是出厂的 preset-standard(会跟出厂那行撞)')
    if (setBundlePatchForm(JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8')), true).changed) {
      notes.push('⚠️ package.json 的 dsh.bundle.patch 还不是 0.2.0 世代形态(数组)—— 重跑生成会摆正')
    }
    console.log('没问题:' + PRESET_PATCH_FILE + ' 与出厂 ' + basePreset + ' 逐字一致,只有压缩那一行换成了 ' + DEFAULT_ENTRY_NAME)
    console.log('  ' + patchFile + '(声明行 ' + DEFAULT_ROW_ID + ' / config.id ' + presetId + ')')
    console.log('  底稿: ' + stockPatchFile)
    for (const n of notes) console.log('  提醒:' + n)
    process.exit(notes.length === 0 ? 0 : 1)
  }

  if (args.has('--remove')) {
    // `preset.patch.yml` 被 dsh.bundle.patch 点名,**文件本体不能删**
    // (删了整个 bundle 会读不到 patch)。删 = 声明换回空存根。
    const stub = emptyPresetPatch({ version: VERSION, at: new Date().toISOString(), base: basePreset })
    await writeFile(patchFile, stub, 'utf8')
    await writeFile(patchManifestPath, JSON.stringify(makeManifest({
      version: VERSION, at: new Date().toISOString(), files: { [PRESET_PATCH_FILE]: stub }
    }), null, 2) + '\n', 'utf8')
    console.log('声明已撤(' + PRESET_PATCH_FILE + ' 换回空存根,文件本身留着给 bundle patch 列表)')
    process.exit(0)
  }

  const built = await buildPatch()
  const currentFiles = existsSync(patchFile) ? { [PRESET_PATCH_FILE]: await readFile(patchFile, 'utf8') } : {}
  const nextFiles = { [PRESET_PATCH_FILE]: built }
  const oldManifest = await readJsonSafe(patchManifestPath)
  const verdict = Object.keys(currentFiles).length === 0
    ? { ok: true, reason: 'fresh', hint: '', edited: [] }
    : checkUpgrade({ manifest: oldManifest, current: currentFiles, next: nextFiles })
  if (!verdict.ok && !args.has('--force')) {
    console.log('[停] ' + patchFile)
    console.log('  ' + verdict.hint)
    console.log('  对不上的:' + (verdict.edited.length === 0 ? '(整个文件)' : verdict.edited.join('、')))
    console.log('  想看现在是什么样:node scripts/install-preset.mjs --check')
    console.log('  确实要重铺(会先备份成 *.bak-<时间>):node scripts/install-preset.mjs --force')
    process.exit(1)
  }
  if (!verdict.ok && args.has('--force')) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (const n of Object.keys(currentFiles)) {
      if (currentFiles[n] !== nextFiles[n]) await writeFile(patchFile + '.bak-' + stamp, currentFiles[n], 'utf8')
    }
    console.log('[重铺] 先把动过的文件备份成 *.bak-' + stamp + ',再写新的(你说 --force 了)')
  }
  await writeFile(patchFile, built, 'utf8')
  await writeFile(patchManifestPath, JSON.stringify(makeManifest({
    version: VERSION, at: new Date().toISOString(), files: nextFiles
  }), null, 2) + '\n', 'utf8')
  const flipped = await ensureManifestForm(true)
  console.log('生成 ' + patchFile)
  console.log('  ' + generatedByLine(meta))
  console.log('  底稿: ' + stockPatchFile + '(整份拷来,只换压缩那一行)')
  console.log('  改动: ' + DEFAULT_ENTRY_NAME + ' ← @deepseek-ai/dsh-compaction-basic(thresholdRatio 0.3 / retainRatio 0.25)')
  console.log('  声明行 id: ' + DEFAULT_ROW_ID + ' / config.id(会话保存的 preset 标识符): ' + presetId)
  console.log('这份声明会随 bundle patch 进组合树;预设名单里出现「Echo 陪伴模式」后,选它才会生效。')
  if (flipped) console.log('  package.json 的 dsh.bundle.patch 已摆成 0.2.0 世代形态(数组);降回 0.1.x 时重跑本脚本会摆回去')
  console.log('想撤:node scripts/install-preset.mjs --remove')
  process.exit(0)
}
// ================= 0.1.5 世代:老路(目录式预设)=================

async function build () {
  const shipped = shippedPresetDir(basePreset)
  if (shipped === null) {
    throw new Error('找不到出厂预设目录(' + basePreset + ')—— 先确认 DSH 装好、'
      + 'profiles/web/node_modules/@deepseek-ai/dsh-agent-presets 在')
  }
  const raw = await readFile(join(shipped, 'agent.cordis.yml'), 'utf8')
  const patched = patchPresetComposition(raw, { entryName: DEFAULT_ENTRY_NAME })
  if (patched.reason === 'stock-entry-not-found' && !patched.text.includes(DEFAULT_ENTRY_NAME)) {
    throw new Error('出厂预设 ' + basePreset + ' 里找不到 compaction-basic 那两行 —— '
      + '宿主大概换过压缩后端的挂法,先看 ' + join(shipped, 'agent.cordis.yml')
      + '(本脚本故意现读现改,就是为了这种情况能被发现,而不是悄悄写成错的)')
  }
  return { shipped, text: patched.text, changed: patched.changed }
}

if (args.has('--check')) {
  const built = await build()
  const installed = existsSync(join(presetDir, 'agent.cordis.yml'))
    ? await readFile(join(presetDir, 'agent.cordis.yml'), 'utf8') : null
  if (installed === null) {
    console.log('[缺] ' + presetDir + ' 里没有预设 —— 跑 node scripts/install-preset.mjs 生成')
    process.exit(1)
  }
  if (installed !== built.text) {
    console.log('[旧] 预设与当前出厂 ' + basePreset + ' 不一致(宿主升级过或改过)'
      + ' —— 重跑 node scripts/install-preset.mjs 就会跟上')
    process.exit(1)
  }
  // v0.39.0 F3:顺手看一眼元数据与清单 —— 它们旧了不一定是坏事(可能是他改的),
  // 但**要说出来**:"名字那行被注释掉了"这种错,只有这里看得见。
  const notes = []
  const metaPath = join(presetDir, 'preset.yml')
  if (!existsSync(metaPath)) notes.push('preset.yml 不在(预设元数据缺)')
  else {
    const body = await readFile(metaPath, 'utf8')
    if (!body.includes('generated-by: dsh-echo@')) notes.push('preset.yml 没有 generated-by 标记(早于 v0.39.0 生成)')
    if (!/^name: /m.test(body)) notes.push('⚠️ preset.yml 里没有 `name:` 那一行 —— 名字读不出来(是不是被注释掉了?)')
  }
  const manifestPath = join(presetDir, PRESET_MANIFEST)
  if (!existsSync(manifestPath)) notes.push(PRESET_MANIFEST + ' 不在(不是本脚本生成的,或早于 v0.39.0;升级会停下来先问你)')
  else {
    const m = await readJsonSafe(manifestPath)
    const files = {}
    for (const n of ['agent.cordis.yml', 'preset.yml']) if (existsSync(join(presetDir, n))) files[n] = await readFile(join(presetDir, n), 'utf8')
    const v = checkUpgrade({ manifest: m, current: files, next: null })
    if (m && m.version !== VERSION) notes.push('生成于 v' + m.version + ',当前插件 v' + VERSION + '(重跑一次就跟上)')
    if (!v.ok) notes.push('⚠️ 指纹对不上:' + v.edited.join('、') + '(你手改过的部分,升级不会盖掉)')
  }
  // v0.44.0:顺手看一眼 bundle patch 那份 —— 0.1.5 世代它是**空存根**,
  // 但文件本体必须在(package.json 的 dsh.bundle.patch 点名了它)。
  if (!existsSync(patchFile)) notes.push(PRESET_PATCH_FILE + ' 不在(bundle patch 列表要点名它)— 重跑 node scripts/install-preset.mjs 生成')
  else {
    const body = await readFile(patchFile, 'utf8')
    if (/^\s*- id: /m.test(body)) {
      notes.push('⚠️ ' + PRESET_PATCH_FILE + ' 里有声明行,但当前宿主是 0.1.x 世代 —— 0.1.5 会去解析一个不存在的包,有搞坏插件树的风险;重跑生成换回存根')
    }
  }
  console.log('没问题:预设与出厂 ' + basePreset + ' 逐字一致,只有压缩后端换成了 ' + DEFAULT_ENTRY_NAME)
  console.log('  ' + join(presetDir, 'agent.cordis.yml'))
  for (const n of notes) console.log('  提醒:' + n)
  process.exit(notes.length === 0 ? 0 : 1)
}

if (args.has('--remove')) {
  if (existsSync(presetDir)) {
    await rm(presetDir, { recursive: true, force: true })
    console.log('已删除预设 ' + presetDir)
  } else {
    console.log('没找到 ' + presetDir)
  }
  // v0.44.0:bundle patch 那份文件留着(列表要点名它),写成空存根就是"没有预设"
  const stub = emptyPresetPatch({ version: VERSION, at: new Date().toISOString(), base: basePreset })
  await writeFile(patchFile, stub, 'utf8')
  await writeFile(patchManifestPath, JSON.stringify(makeManifest({
    version: VERSION, at: new Date().toISOString(), files: { [PRESET_PATCH_FILE]: stub }
  }), null, 2) + '\n', 'utf8')
  await ensureManifestForm(false)
  console.log(PRESET_PATCH_FILE + ' 换回空存根(文件本身留着给 bundle patch 列表)')
  process.exit(0)
}

const built = await build()
// v0.44.0:bundle patch 那份存根**先写** —— 它是空占位,不是他的人格资产,
// 不该被下面老目录那道门(指纹/手改保护)牵连;那边拦的是 agent.cordis.yml。
{
  const stub = emptyPresetPatch({ version: VERSION, at: new Date().toISOString(), base: basePreset })
  await writeFile(patchFile, stub, 'utf8')
  await writeFile(patchManifestPath, JSON.stringify(makeManifest({
    version: VERSION, at: new Date().toISOString(), files: { [PRESET_PATCH_FILE]: stub }
  }), null, 2) + '\n', 'utf8')
  await ensureManifestForm(false)
}
// ---- v0.39.0 F3:先看清单,再决定动不动(他手改过的部分不许被升级盖掉)----
const manifestPath = join(presetDir, PRESET_MANIFEST)
const oldManifest = await readJsonSafe(manifestPath)
const nextFiles = {
  'agent.cordis.yml': built.text,
  'preset.yml': presetMetadata({
    name: 'Echo 陪伴模式',
    description: '给她的会话用:压缩时不再写英文工程检查点,改由 Echo 从自己的记忆库策展一页关系备忘(关系账本 / 没结掉的事 / 她记得的你)。其余能力与标准模式一致。',
    order: 9,
    version: VERSION,
    at: new Date().toISOString()
  })
}
const currentFiles = {}
if (existsSync(presetDir)) {
  for (const n of Object.keys(nextFiles)) {
    if (existsSync(join(presetDir, n))) currentFiles[n] = await readFile(join(presetDir, n), 'utf8')
  }
}
const verdict = Object.keys(currentFiles).length === 0
  ? { ok: true, reason: 'fresh', hint: '', edited: [] }
  : checkUpgrade({ manifest: oldManifest, current: currentFiles, next: nextFiles })
if (!verdict.ok && !args.has('--force')) {
  // 停下来报给他看:**不覆盖**才是正确行为(那份 preset 是他的人格资产)
  console.log('[停] ' + presetDir)
  console.log('  ' + verdict.hint)
  console.log('  对不上的:' + (verdict.edited.length === 0 ? '(整个目录)' : verdict.edited.join('、')))
  console.log('  想看现在是什么样:node scripts/install-preset.mjs --check')
  console.log('  确实要重铺(会先备份成 <文件>.bak-<时间>):node scripts/install-preset.mjs --force')
  console.log('  (' + PRESET_PATCH_FILE + ' 空存根已经写好 —— 那份是 bundle patch 的占位,不受这道门影响)')
  process.exit(1)
}
if (!verdict.ok && args.has('--force')) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const n of Object.keys(currentFiles)) {
    if (currentFiles[n] !== nextFiles[n]) await writeFile(join(presetDir, n + '.bak-' + stamp), currentFiles[n], 'utf8')
  }
  console.log('[重铺] 先把动过的文件备份成 *.bak-' + stamp + ',再写新的(你说 --force 了)')
}
await mkdir(presetDir, { recursive: true })
// 出厂预设目录里的非组合文件(skills/ 等)一并带上 —— 预设就是"一个目录"
await cp(built.shipped, presetDir, {
  recursive: true, force: true,
  filter: (src) => !src.endsWith('agent.cordis.yml')
})
await writeFile(join(presetDir, 'agent.cordis.yml'), nextFiles['agent.cordis.yml'], 'utf8')
await writeFile(join(presetDir, 'preset.yml'), nextFiles['preset.yml'], 'utf8')
// v0.39.0 F3:生成清单(`generated-by` + 版本 + 时间 + 指纹 + 逐文件内容)
await writeFile(manifestPath, JSON.stringify(makeManifest({
  version: VERSION, at: new Date().toISOString(), files: nextFiles
}), null, 2) + '\n', 'utf8')
console.log('生成 ' + presetDir)
console.log('  ' + generatedByLine({ version: VERSION, at: new Date().toISOString() }))
console.log('  底稿: ' + built.shipped + '/agent.cordis.yml' + (built.changed ? '(已换压缩后端)' : '(本来就换过)'))
console.log('  改动: ' + DEFAULT_ENTRY_NAME + ' ← ' + '@deepseek-ai/dsh-compaction-basic(thresholdRatio 0.3 / retainRatio 0.25)')
console.log('预设列表里会自动出现「Echo 陪伴模式」(发现逻辑每次读盘重扫,不用重启)。')
console.log('想删:node scripts/install-preset.mjs --remove')
