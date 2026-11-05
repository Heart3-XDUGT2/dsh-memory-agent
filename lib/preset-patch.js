/**
 * v0.20.0 D1:把一份 preset 组合里的压缩后端换成 Echo 的策展后端(纯文本变换)。
 *
 * 为什么用「改一份副本」而不是让插件在运行时抢占:
 *   - `CompactionEngine` 是 cordis `Service`,名字 `compaction`,**一个 context
 *     只能有一个**(基类注释:`Load one implementation per context as ctx.compaction`);
 *   - web profile 自己把 `compaction-basic` 关了(dsh-web-app 的 patch 原话:
 *     *"only the compaction backend that reads it moves"*)—— 后端住在 **preset
 *     平面**:三个出厂 preset 各自挂一份;
 *   - 所以换后端 = **另立一份 Echo 预设**(dsh_port/03 §5 的裁决),不改别人、
 *     不动 node_modules 里的出厂文件。
 *
 * 低风险是设计出来的:预设是**按会话挂载**的,坏掉的预设只让那一行 roster
 * 显示不健康(default discovery 的"health"语义),不拦 DSH 启动;不选这份
 * 预设 ⇒ 一切照旧。
 *
 * 只做一件事:把 compaction 域里的
 *     - id: compaction-basic
 *       name: '@deepseek-ai/dsh-compaction-basic'
 * 换成
 *     - id: compaction-echo
 *       name: dsh-echo/compaction
 *       config:
 *         thresholdRatio: 0.3
 *         retainRatio: 0.25
 * 别的一个字不动(出厂组合会随宿主升级变化,所以**不把出厂文件抄进仓库**,
 * 每次生成时**现读现改** —— 这样宿主升级后重跑一次就跟上了)。
 */

// v0.39.0 F3:指纹用真 sha256(node 内置),不在单测里 mock 摘要 ——
// 摘要算法被换掉这种事,只有用真货才测得出来。
import { createHash } from 'node:crypto'

export const DEFAULT_ENTRY_NAME = 'dsh-echo/compaction'
/** 出厂那行的 id 与包名(装机版 `presets/standard/agent.cordis.yml:145-146`)。 */
const STOCK_ENTRY_ID = 'compaction-basic'
const STOCK_ENTRY_PACKAGE = '@deepseek-ai/dsh-compaction-basic'
/** 03 §5 的急切阈值:早压早替换,表层 ≈ [人格][策展块][近期尾]。 */
export const DEFAULT_THRESHOLD_RATIO = 0.3
export const DEFAULT_RETAIN_RATIO = 0.25

/**
 * @param {string} text 出厂 preset 组合的原文
 * @param {object} opts {entryName, thresholdRatio, retainRatio, force}
 * @returns {{text:string, changed:boolean, reason:string}}
 */
export function patchPresetComposition (text, opts = {}) {
  const src = String(text ?? '')
  const entryName = String(opts.entryName || DEFAULT_ENTRY_NAME)
  const threshold = Number(opts.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO)
  const retain = Number(opts.retainRatio ?? DEFAULT_RETAIN_RATIO)
  if (src.trim() === '') return { text: src, changed: false, reason: 'empty' }
  if (src.includes(entryName)) return { text: src, changed: false, reason: 'already-patched' }
  // 精确匹配出厂那两行(缩进与 dump 出来的组合树一致)。注意尾部只许吃
  // **水平**空白:`\s*$` 会把行尾换行也吃掉,那就在条目之间少一个空行。
  const pattern = new RegExp(
    '^([ \\t]*)- id: ' + STOCK_ENTRY_ID + '[ \\t]*\\n\\1  name: [\'"]?'
    + STOCK_ENTRY_PACKAGE.replace(/[/@.]/g, (c) => '\\' + c) + '[\'"]?[ \\t]*$',
    'm')
  const m = pattern.exec(src)
  if (m === null) {
    return { text: src, changed: false, reason: 'stock-entry-not-found' }
  }
  const indent = m[1]
  const replacement = [
    indent + '- id: compaction-echo',
    indent + '  name: ' + entryName,
    indent + '  config:',
    indent + '    thresholdRatio: ' + threshold,
    indent + '    retainRatio: ' + retain
  ].join('\n')
  return { text: src.slice(0, m.index) + replacement + src.slice(m.index + m[0].length), changed: true, reason: 'patched' }
}

/** 预设元数据(roster 里显示的那两行)。 */
export function presetMetadata (opts = {}) {
  const name = String(opts.name || 'Echo 陪伴模式')
  const description = String(opts.description
    || '她的会话用这份:压缩改由 Echo 从自己的记忆库策展(关系账本 / 没结掉的事 / 她记得的你),不再生成英文工程检查点。其余能力与标准模式一致。')
  const order = Number.isFinite(Number(opts.order)) ? Number(opts.order) : 0
  // v0.39.0 F3:`generated-by` 钉在元数据里(照 roleplay `presets.ts:129-145`)——
  // 半年后翻到这份 preset,要一眼看出是哪个版本的插件生成的、什么时候生成的。
  // ⚠️ 真机演练连抓两次(第一版:标记后没补换行 ⇒ `name:` 被粘进注释;
  // 第二版:`.replace(/^/gm,'# ')` 把结尾空行也加了前缀 ⇒ 还是粘)。所以这里
  // **老老实实拼一行注释**,不玩正则。
  return '# ' + generatedByLine(opts) + '\n' + 'name: ' + name + '\ndescription: ' + description + '\norder: ' + order + '\n'
}

// ---- v0.39.0 F3:preset 的"生成标记"与"他的人格资产保护壳" ----
//
// 出处:roleplay `presets.ts:129-145`。两件事:
//   ① **生成标记**:每份生成的 preset 带上 `generated-by` + 版本 + 时间 ——
//      宿主升级后重跑一次,能看出"这份是谁生成的、对不对得上当前插件版本";
//   ② **不覆盖他手改过的东西**:他手改过的 preset 是**他的人格资产**
//      (那份 agent.cordis.yml / preset.yml 里可能有他调了很久的措辞)。
//      升级的正确行为是**停下来告诉他哪几个文件动过**,而不是 rm -rf 重铺
//      (旧脚本就是这么干的:`scripts/install-preset.mjs` 老代码直接删目录)。
//      指纹 = 上次**我们自己**写下的内容摘要;对不上 ⇒ 有人动过 ⇒ 不覆盖。

/** 生成标记那一行(注释形态;YAML 顶部 + 元数据里各一份)。 */
export function generatedByLine (opts = {}) {
  const version = String(opts.version || '').trim() || 'unknown'
  const at = String(opts.at || '').trim() || ''
  return 'generated-by: dsh-echo@' + version + (at === '' ? '' : ' at ' + at)
}

/** 生成清单文件名(放在 preset 目录里,和它生成的东西待在一起)。 */
export const PRESET_MANIFEST = '.echo-generated.json'

/**
 * 内容指纹:排序后把 `路径\n长度\n内容` 串起来做 sha256(用 node 内置 crypto)。
 * 只算**我们生成的**那几个文件 —— 出厂带过来的 skills/ 之类的目录不掺进来。
 */
export function fingerprintOf (files) {
  const names = Object.keys(files || {}).sort()
  const parts = []
  for (const n of names) {
    const body = String(files[n] ?? '')
    parts.push(n + '\n' + body.length + '\n' + body)
  }
  return sha256(parts.join('\n\u0000\n'))
}

/**
 * 该不该覆盖?回 `{ok, reason, hint, edited}`。
 *   - `ok:true`  ⇒ 这些文件还是我们上次写的那份(或与即将生成的一字不差),可以写;
 *   - `edited`   ⇒ 对不上的文件名单(要**报给他看**,不是安静盖掉);
 *   - 没有清单   ⇒ 认不出来(早于 v0.38.0 的安装 / 他手搓的),**默认不动**。
 */
export function checkUpgrade ({ manifest = null, current = {}, next = null } = {}) {
  const now = fingerprintOf(current)
  if (next !== null && fingerprintOf(next) === now) {
    return { ok: true, reason: 'identical', hint: '', edited: [] }
  }
  if (manifest === null || typeof manifest !== 'object' || typeof manifest.fingerprint !== 'string') {
    return {
      ok: false,
      reason: 'no-manifest',
      hint: '这份 preset 里没有 ' + PRESET_MANIFEST + '(不是本脚本生成的,或早于 v0.38.0)'
        + ' —— 里面可能有你手改过的东西,所以我不动它;确实要重铺就加 --force',
      edited: Object.keys(current || {}).sort()
    }
  }
  if (manifest.fingerprint !== now) {
    const recorded = (manifest.files && typeof manifest.files === 'object') ? manifest.files : {}
    const edited = Object.keys(current || {}).filter((n) => recorded[n] !== String(current[n] ?? '')).sort()
    return {
      ok: false,
      reason: 'hand-edited',
      hint: '上次生成之后这几个文件被改过:' + (edited.length === 0 ? '(整个目录)' : edited.join('、'))
        + ' —— 你改过的部分不该被升级盖掉;要重铺就加 --force(会先备份)',
      edited
    }
  }
  return { ok: true, reason: 'clean', hint: '', edited: [] }
}

/** 一份新清单(生成完那一刻写下)。 */
export function makeManifest ({ version, at, files } = {}) {
  const f = {}
  for (const n of Object.keys(files || {})) f[n] = String(files[n] ?? '')
  return {
    generatedBy: 'dsh-echo',
    version: String(version || 'unknown'),
    at: String(at || ''),
    fingerprint: fingerprintOf(f),
    files: f
  }
}

function sha256 (s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex')
}

// ---- v0.44.0:0.2.0 起预设是「声明行」,不再是一个目录 ----
//
// 出处(0.2.0-rc.2 源码与 README,2026-10-02 实读):
//   * `@deepseek-ai/dsh-agent-preset-registry` README:*"Definitions are ordinary
//     plugin rows; the registry neither scans directories nor accepts preset paths"*
//     ⇒ 旧目录(`<DSH_HOME>/.agent-presets/`)那条发现路**在 0.2.0 没了**,发布说明
//     说的"旧目录预设需迁移"就是指这个。
//   * *"...is a bundle patch: an insert of a `@deepseek-ai/dsh-agent-preset` row,
//     or a patch keyed by that row's id"* ⇒ 迁移目标 = 我们 bundle 的一份 patch,
//     insert 一行 `@deepseek-ai/dsh-agent-preset`,config 里带**完整**子插件列表。
//   * *"A user override replaces the complete child list and does not automatically
//     merge future changes to the builtin list."* ⇒ 覆盖就是整表替换,**没有继承**;
//     所以"抄一份出厂列表 + 只换压缩那一行"就是官方姿势,漂移风险官方自己也认。
//
// 于是这里做的是**同一台手术、换一张纸**:旧路径改 `presets/standard/agent.cordis.yml`
// 那份组合文本;新路径改出厂 `presets/standard.patch.yml`(dsh-web-app 包里的
// patch 形态)。压缩那一行的替换**复用上面那个测过的 regex**(它本来就是缩进通用的)。

/** 0.2.0 生成物:bundle patch 文件名(dsh.bundle.patch 里点名它)。 */
export const PRESET_PATCH_FILE = 'preset.patch.yml'
/** 0.2.0 生成物的清单(指纹 + 逐文件内容,和旧目录那份一个规矩)。 */
export const PRESET_PATCH_MANIFEST = '.preset-patch-generated.json'
/** 声明行的行 id(Loader 编辑地址)。config.id(会话保存的 preset 标识符)另给。 */
export const DEFAULT_ROW_ID = 'preset-echo'

/**
 * 0.1.5 存根:声明行在 0.1.5 会解析不到 `@deepseek-ai/dsh-agent-preset` 那个包
 * (0.1.5 里那叫 `dsh-agent-presets`,是旧目录发现机制),一行错的声明有把整个
 * 插件树搞出"plugin tree failed to load"的风险。所以**按宿主世代生成**:
 * 0.1.5 宿主 ⇒ 空 patch(纯注释 + 空 insert);升级 0.2.0 后重跑生成脚本,
 * 这里才会填进真声明。空 patch 的失败模式是"Echo 预设暂时不在名单里",不报错。
 */
export function emptyPresetPatch (opts = {}) {
  const version = String(opts.version || '').trim() || 'unknown'
  const at = String(opts.at || '').trim() || ''
  const base = String(opts.base || 'standard')
  return [
    '# ' + generatedByLine({ version, at }) + ' — scripts/install-preset.mjs 生成,别手改',
    '# 当前宿主是 0.1.x 世代:预设住在旧目录 <DSH_HOME>/.agent-presets/echo/(那条流程照旧)。',
    '# 这里本该有一行 @deepseek-ai/dsh-agent-preset 声明(0.2.0 的预设形态);0.1.5 认不出那个包,',
    '# 所以**故意留空**(升级到 0.2.0 后重跑 node scripts/install-preset.mjs,自动把声明填进来)。',
    '# 出厂底稿:' + base,
    '- insert: []',
    ''
  ].join('\n')
}

/**
 * 0.2.0 声明:把出厂 preset patch(dsh-web-app/presets/<base>.patch.yml)整份拿来,
 * 做四件事 ——
 *   ① 压缩那一行:compaction-basic → <entryName>(复用 patchPresetComposition);
 *   ② 声明行 id:preset-standard → preset-echo(Loader 编辑地址,不能跟出厂撞);
 *   ③ config.id:standard → echo(会话保存的 preset 标识符);
 *   ④ 元数据:name/description/order 插进 config 顶上(照旧路径 preset.yml 那份)。
 * 别的一个字不动(出厂列表随宿主升级变化,所以**不把出厂文件抄进仓库**,每次
 * 生成时现读现改)。
 *
 * @param {string} stockText 出厂 `presets/<base>.patch.yml` 原文
 * @param {object} opts {rowId, presetId, name, description, order, entryName,
 *                       thresholdRatio, retainRatio, version, at, base}
 * @returns {{text:string, changed:boolean, reason:string}}
 */
export function presetDeclarationPatch (stockText, opts = {}) {
  const src = String(stockText ?? '')
  const rowId = String(opts.rowId || DEFAULT_ROW_ID)
  const presetId = String(opts.presetId || 'echo')
  const version = String(opts.version || '').trim() || 'unknown'
  const at = String(opts.at || '').trim() || ''
  const base = String(opts.base || 'standard')
  if (src.trim() === '') return { text: src, changed: false, reason: 'empty' }
  if (src.includes(rowId)) return { text: src, changed: false, reason: 'already-patched' }

  // ① 压缩行手术(缩进通用的那把刀,和旧路径共用)
  const patched = patchPresetComposition(src, opts)
  if (patched.changed === false && patched.reason !== 'already-patched') {
    return { text: src, changed: false, reason: patched.reason }
  }
  let text = patched.text

  // ② 声明行 id:只吃**恰好 4 空格缩进**的 `- id: preset-…`(内层子插件行在 10+ 空格)
  const rowPat = new RegExp('^([ ]{4})- id: preset-[A-Za-z0-9_-]+[ \\t]*$', 'm')
  const rowMatch = rowPat.exec(text)
  if (rowMatch === null) return { text: src, changed: false, reason: 'preset-row-not-found' }
  text = text.replace(rowPat, rowMatch[1] + '- id: ' + rowId)

  // ③+④ config 顶上那几个键(恰好 8 空格缩进;内层 config 键更深):
  //    id: standard ⇒ id: echo + name + description;order: 1 ⇒ order: <order>
  const idPat = new RegExp('^([ ]{8})id: [A-Za-z0-9_-]+[ \\t]*$', 'm')
  const idMatch = idPat.exec(text)
  if (idMatch === null) return { text: src, changed: false, reason: 'preset-config-id-not-found' }
  const indent = idMatch[1]
  const meta = [
    indent + 'id: ' + presetId,
    indent + 'name: ' + yamlScalar(String(opts.name || 'Echo 陪伴模式')),
    indent + 'description: ' + yamlScalar(String(opts.description
      || '给她的会话用:压缩时不再写英文工程检查点,改由 Echo 从自己的记忆库策展一页关系备忘(关系账本 / 没结掉的事 / 她记得的你)。其余能力与标准模式一致。'))
  ].join('\n')
  text = text.replace(idPat, meta)
  const orderPat = new RegExp('^[ ]{8}order: [0-9]+[ \\t]*$', 'm')
  if (orderPat.test(text)) {
    text = text.replace(orderPat, indent + 'order: ' + (Number.isFinite(Number(opts.order)) ? Number(opts.order) : 9))
  }

  // 头注释换成我们的(出厂那三行说的是"standard",留着会误导半年后的读者)
  const head = [
    '# ' + generatedByLine({ version, at }) + ' — scripts/install-preset.mjs 生成,别手改',
    '# Echo 陪伴模式:出厂 ' + base + ' 的声明行整份拷来,只换压缩那一行('
      + STOCK_ENTRY_ID + ' → ' + String(opts.entryName || DEFAULT_ENTRY_NAME) + ')。',
    '# 0.2.0 起预设 = bundle patch 里的一行 @deepseek-ai/dsh-agent-preset 声明(覆盖 = 整表替换,没有继承)。',
    '# Web 编辑器存的改动仍可按行 id 从 profile patch 覆盖 config.plugins(出厂文件自带的规矩)。'
  ].join('\n')
  const firstLine = text.indexOf('- insert:')
  if (firstLine > 0) text = head + '\n' + text.slice(firstLine)
  return { text, changed: true, reason: 'patched' }
}

/**
 * YAML 单引标量(名字/描述是人话,可能带冒号、井号、方括号 —— 单引号里什么都安全,
 * 只有 `'` 自己要写成两个;我们给的文本不含单引号,含了也会被这里转义)。
 */
function yamlScalar (s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

/**
 * `dsh.bundle.patch` 的**形态**也按世代分(2026-10-02 真测出来的,不是猜的):
 *   * 0.1.5 的 `loadProfileDirectory` 把 patch 值直接 `path.join` —— 数组当场炸
 *     ("The \"path\" argument must be of type string. Received an instance of Array");
 *   * 0.2.0 的 `bundlePatchFiles` 显式收「一个路径,或一串路径」。
 * 所以:0.1.x 世代 manifest 只点名 cordis.patch.yml 一个文件(字符串形态);
 * 0.2.0 世代才把 preset.patch.yml 加进列表(数组形态)。生成器负责摆正,
 * 世代门(check-preset-patch.mjs)负责看住 —— 装反了不悄悄错。
 *
 * @param {object} manifest package.json 解析后的对象(不改原对象)
 * @param {boolean} wantArray true = 0.2.0 世代(数组),false = 0.1.x(字符串)
 * @returns {{manifest:object, changed:boolean}} 新对象(变了才要写盘)
 */
export function setBundlePatchForm (manifest, wantArray) {
  const next = JSON.parse(JSON.stringify(manifest ?? {}))
  const cur = next?.dsh?.bundle?.patch
  const base = Array.isArray(cur) ? cur[0] : String(cur ?? './cordis.patch.yml')
  const want = wantArray ? [base, './' + PRESET_PATCH_FILE] : base
  const same = Array.isArray(cur) && Array.isArray(want) && cur.length === want.length && cur.every((v, i) => v === want[i])
    || (!Array.isArray(cur) && !Array.isArray(want) && cur === want)
  if (same) return { manifest: next, changed: false }
  if (next.dsh === undefined || typeof next.dsh !== 'object') next.dsh = {}
  if (next.dsh.bundle === undefined || typeof next.dsh.bundle !== 'object') next.dsh.bundle = {}
  next.dsh.bundle.patch = want
  return { manifest: next, changed: true }
}
