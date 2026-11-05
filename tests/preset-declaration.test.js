// v0.44.0 — 0.2.0 预设声明(preset.patch.yml)的纯函数电池。
//
// 背景:0.2.0 起预设不再是一个目录,而是 bundle patch 里的一行
// `@deepseek-ai/dsh-agent-preset` 声明(见 lib/preset-patch.js 里的出处引文)。
// 这里钉住那台手术:出厂声明整份拷来,**只换压缩那一行**,其余逐字一致。
//
// fixture = 出厂 `dsh-web-app/presets/standard.patch.yml` 的真实形状
// (0.2.0-rc.2 实读,缩进照抄;只裁掉了与手术无关的长 prompt 段)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  presetDeclarationPatch, emptyPresetPatch, setBundlePatchForm,
  patchPresetComposition, DEFAULT_ENTRY_NAME, DEFAULT_ROW_ID,
  PRESET_PATCH_FILE, PRESET_PATCH_MANIFEST
} from '../lib/preset-patch.js'

const STOCK = `# Agent preset standard: one \`@deepseek-ai/dsh-agent-preset\` declaration inserted
# after the web patch. Edits saved from the Web editor override this row's
# \`config.plugins\` by id from the profile patch.
- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              suffix: Your working directory is {{cwd}}.
              prefix: You are a coding agent powered by the {{model}} model.
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
              - id: tool-result-pruner
                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
                config:
                  thresholdChars: 8192
          - id: delegation
            name: cordis:group
            group: true
            config:
              - id: tool-subagent
                name: '@deepseek-ai/dsh-tool-subagent'
`

test('声明手术:压缩那一行换了,别的逐字不动', () => {
  const r = presetDeclarationPatch(STOCK, { version: '0.44.0', at: 'T' })
  assert.equal(r.changed, true)
  assert.equal(r.reason, 'patched')
  // 压缩行:compaction-basic → dsh-echo/compaction,带我们的 config
  assert.match(r.text, /- id: compaction-echo\n\s+name: dsh-echo\/compaction\n\s+config:\n\s+thresholdRatio: 0\.3\n\s+retainRatio: 0\.25/)
  assert.doesNotMatch(r.text, /dsh-compaction-basic/)
  // 同伴行不动(整表替换的风险就在这:只许换那一行)
  assert.match(r.text, /- id: command-compact\n\s+name: '@deepseek-ai\/dsh-command-compact'/)
  assert.match(r.text, /- id: tool-result-pruner/)
  assert.match(r.text, /disabled: !!js process\.platform === 'win32'/)
  // 内层别的行一字不动
  assert.match(r.text, /suffix: Your working directory is \{\{cwd\}\}\./)
})

test('声明行 id 与 config.id 都换成 echo 世代,元数据插在 config 顶上', () => {
  const r = presetDeclarationPatch(STOCK, { version: '0.44.0', at: 'T' })
  assert.match(r.text, /^    - id: preset-echo$/m)
  assert.doesNotMatch(r.text, /preset-standard/)
  assert.match(r.text, /^        id: echo$/m)
  assert.doesNotMatch(r.text, /^        id: standard$/m)
  assert.match(r.text, /^        name: 'Echo 陪伴模式'$/m)
  assert.match(r.text, /^        description: '/m)
  assert.match(r.text, /^        order: 9$/m) // 旧路径 preset.yml 的 order: 9,世代连续
  // 内层子插件的 id 行不许被误伤(它们在 10+ 空格)
  assert.match(r.text, /^          - id: persona$/m)
  assert.match(r.text, /^          - id: compaction$/m)
})

test('头注释换成我们的,不再说 "preset standard"', () => {
  const r = presetDeclarationPatch(STOCK, { version: '0.44.0', at: 'T' })
  assert.match(r.text, /^# generated-by: dsh-echo@0\.44\.0 at T — scripts\/install-preset\.mjs 生成,别手改/m)
  assert.match(r.text, /Echo 陪伴模式:出厂 standard 的声明行整份拷来/)
  assert.doesNotMatch(r.text, /Agent preset standard/)
})

test('幂等:再跑一次说 already-patched,一个字不变', () => {
  const once = presetDeclarationPatch(STOCK, { version: '0.44.0', at: 'T' })
  const twice = presetDeclarationPatch(once.text, { version: '0.44.0', at: 'T2' })
  assert.equal(twice.changed, false)
  assert.equal(twice.reason, 'already-patched')
  assert.equal(twice.text, once.text)
})

test('出场换了挂法 ⇒ 老实报 stock-entry-not-found,不写错东西', () => {
  const gone = STOCK.replace(
    "              - id: compaction-basic\n                name: '@deepseek-ai/dsh-compaction-basic'\n",
    '')
  const r = presetDeclarationPatch(gone, { version: '0.44.0', at: 'T' })
  assert.equal(r.changed, false)
  assert.equal(r.reason, 'stock-entry-not-found')
  assert.equal(r.text, gone) // 原样返回
})

test('声明行/配置 id 找不到(出厂形状变了)⇒ 报 reason,不写错东西', () => {
  const noRow = STOCK.replace('    - id: preset-standard', '    - id: preset-别的形状')
  const r1 = presetDeclarationPatch(noRow, { version: '0.44.0', at: 'T' })
  // row 正则是 preset-[A-Za-z0-9_-]+,中文不在类里 ⇒ 找不到 ⇒ 老实报
  assert.equal(r1.changed, false)
  assert.equal(r1.reason, 'preset-row-not-found')
  const noId = STOCK.replace('        id: standard\n', '')
  const r2 = presetDeclarationPatch(noId, { version: '0.44.0', at: 'T' })
  assert.equal(r2.changed, false)
  assert.equal(r2.reason, 'preset-config-id-not-found')
})

test('描述里的单引号被转义(YAML 标量安全)', () => {
  const r = presetDeclarationPatch(STOCK, {
    version: '0.44.0', at: 'T', description: "她的一句话:don't panic"
  })
  assert.match(r.text, /^        description: '她的一句话:don''t panic'$/m)
})

test('空文本原样返回,reason=empty', () => {
  const r = presetDeclarationPatch('   ', { version: '0.44.0', at: 'T' })
  assert.equal(r.reason, 'empty')
  assert.equal(r.changed, false)
})

test('0.1.5 存根:空 insert + 说清为什么空、升级后怎么补', () => {
  const s = emptyPresetPatch({ version: '0.44.0', at: 'T', base: 'standard' })
  assert.match(s, /^# generated-by: dsh-echo@0\.44\.0 at T — scripts\/install-preset\.mjs 生成,别手改/m)
  assert.match(s, /- insert: \[\]/m)
  assert.match(s, /0\.1\.x 世代/)
  assert.match(s, /重跑 node scripts\/install-preset\.mjs/)
  // 存根里不许出现真声明行(0.1.5 会去解析一个不存在的包;注释里提名字无害)
  assert.doesNotMatch(s, /^\s*- id: /m)
  assert.doesNotMatch(s, /name: ['"]?@deepseek-ai\/dsh-agent-preset/)
})

test('文件名常量是钉死的(bundle patch 列表点名的就是它们)', () => {
  assert.equal(PRESET_PATCH_FILE, 'preset.patch.yml')
  assert.equal(PRESET_PATCH_MANIFEST, '.preset-patch-generated.json')
  assert.equal(DEFAULT_ROW_ID, 'preset-echo')
  assert.equal(DEFAULT_ENTRY_NAME, 'dsh-echo/compaction')
})

test('旧路径那把刀还在(0.1.5 世代还要用)', () => {
  const r = patchPresetComposition(STOCK, { entryName: DEFAULT_ENTRY_NAME })
  assert.equal(r.changed, true)
  assert.match(r.text, /name: dsh-echo\/compaction/)
  // 它不认识声明行的事(那不是它的活)
  assert.match(r.text, /- id: preset-standard/)
})

test('manifest 形态:0.1.x = 字符串(只点名 cordis.patch.yml),0.2.0 = 数组带生成物', () => {
  const base = { name: 'x', dsh: { bundle: { patch: './cordis.patch.yml' } } }
  // 0.2.0 世代:摆成数组,带上 preset.patch.yml
  const up = setBundlePatchForm(base, true)
  assert.equal(up.changed, true)
  assert.deepEqual(up.manifest.dsh.bundle.patch, ['./cordis.patch.yml', './preset.patch.yml'])
  // 幂等:再摆一次不动
  const again = setBundlePatchForm(up.manifest, true)
  assert.equal(again.changed, false)
  // 摆回 0.1.x:字符串,只点名 cordis.patch.yml(0.1.5 的 loadProfileDirectory 只吃字符串)
  const down = setBundlePatchForm(up.manifest, false)
  assert.equal(down.changed, true)
  assert.equal(down.manifest.dsh.bundle.patch, './cordis.patch.yml')
  const downAgain = setBundlePatchForm(down.manifest, false)
  assert.equal(downAgain.changed, false)
  // 原对象不动(纯函数)
  assert.deepEqual(base.dsh.bundle.patch, './cordis.patch.yml')
})

test('manifest 形态:缺字段也能补出来(不抛)', () => {
  const r = setBundlePatchForm({}, true)
  assert.deepEqual(r.manifest.dsh.bundle.patch, ['./cordis.patch.yml', './preset.patch.yml'])
  const r2 = setBundlePatchForm(null, false)
  assert.equal(r2.manifest.dsh.bundle.patch, './cordis.patch.yml')
})
