/**
 * F3 的电池:preset 带 `generated-by` 标记,而且**他手改过的部分不许被升级盖掉**。
 *
 * 最要紧的一条是最后那组:升级遇到手改过的 preset 必须**停下来报**,而不是 rm -rf
 * 重铺 —— 旧脚本就是直接删目录的,那等于把他调了很久的措辞一起删了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  generatedByLine, presetMetadata, fingerprintOf, checkUpgrade, makeManifest, PRESET_MANIFEST
} from '../lib/preset-patch.js'

const FILES = {
  'agent.cordis.yml': '- id: compaction-echo\n  name: dsh-echo/compaction\n',
  'preset.yml': 'name: Echo 陪伴模式\norder: 9\n'
}

test('F3:元数据里钉着 generated-by(哪个版本生成的一眼看出)', () => {
  const line = generatedByLine({ version: '0.39.0', at: '2026-09-28T21:00:00Z' })
  assert.equal(line, 'generated-by: dsh-echo@0.39.0 at 2026-09-28T21:00:00Z')
  assert.equal(generatedByLine({ version: '0.39.0' }), 'generated-by: dsh-echo@0.39.0')
  assert.match(generatedByLine({}), /unknown/, '没给版本也别写出个假版本')
  const meta = presetMetadata({ version: '0.39.0', at: '2026-09-28T21:00:00Z', order: 9 })
  // ⚠️ 真机演练连抓两次:先是标记后没补换行、再是 `.replace(/^/gm,'# ')` 把结尾
  // 空行也加了前缀 —— 两次都把 `name:` 粘进了注释行(名字整行被注释掉)。
  // 所以这里要求:第一行是标记、**第二行正好是 name**、结尾只有一个换行。
  const lines = meta.split('\n')
  assert.equal(lines.length, 5, '4 行内容 + 结尾空串')
  assert.match(lines[0], /^# generated-by: dsh-echo@0\.39\.0 at 2026-09-28T21:00:00Z$/)
  assert.match(lines[1], /^name: Echo 陪伴模式$/, 'name 必须自己占一行(不许被粘进注释)')
  assert.match(lines[2], /^description: .+$/)
  assert.equal(lines[3], 'order: 9')
  assert.equal(lines[4], '', '结尾只留一个换行')
  // 与老版本(没有标记那种)只差第一行 —— 不能让升级顺手改掉别的字
  const legacy = presetMetadata({ version: '0.39.0', at: '2026-09-28T21:00:00Z', order: 9 }).split('\n').slice(1).join('\n')
  assert.ok(legacy.startsWith('name: Echo 陪伴模式\n'))
})

test('F3:指纹对内容敏感(改了任何一处都不一样)', () => {
  const a = fingerprintOf(FILES)
  assert.equal(a, fingerprintOf({ 'preset.yml': FILES['preset.yml'], 'agent.cordis.yml': FILES['agent.cordis.yml'] }), '与键序无关')
  assert.notEqual(a, fingerprintOf({ ...FILES, 'agent.cordis.yml': FILES['agent.cordis.yml'] + '# 我加的\n' }))
  assert.notEqual(a, fingerprintOf({ 'preset.yml': FILES['preset.yml'] }), '少一个文件也算变了')
})

test('F3:清单记下逐文件内容 + 指纹(以后才能指出"哪几个文件动过")', () => {
  const m = makeManifest({ version: '0.39.0', at: 'now', files: FILES })
  assert.equal(m.generatedBy, 'dsh-echo')
  assert.equal(m.version, '0.39.0')
  assert.equal(m.fingerprint, fingerprintOf(FILES))
  assert.deepEqual(Object.keys(m.files).sort(), ['agent.cordis.yml', 'preset.yml'])
})

test('F3:还是上次那份 ⇒ 可以写(clean)', () => {
  const m = makeManifest({ version: '0.38.0', at: 'x', files: FILES })
  const v = checkUpgrade({ manifest: m, current: FILES, next: { ...FILES, 'preset.yml': 'name: Echo 陪伴模式\norder: 9\n# 新版本会加的东西\n' } })
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'clean')
  assert.deepEqual(v.edited, [])
})

test('F3:内容与即将生成的一字不差 ⇒ 直接写(没必要拦)', () => {
  const v = checkUpgrade({ manifest: null, current: FILES, next: FILES })
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'identical')
})

test('F3:⚠️他手改过 ⇒ **不覆盖**,而且报出是哪几个文件', () => {
  const m = makeManifest({ version: '0.38.0', at: 'x', files: FILES })
  const edited = { ...FILES, 'preset.yml': 'name: 我的 Echo\norder: 9\n' }
  const v = checkUpgrade({ manifest: m, current: edited, next: { ...FILES, 'preset.yml': 'name: Echo 陪伴模式\norder: 9\n# 新版\n' } })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'hand-edited')
  assert.deepEqual(v.edited, ['preset.yml'], '要指名道姓说哪个文件被动过')
  assert.match(v.hint, /--force/)
  assert.match(v.hint, /不该被升级盖掉/)
})

test('F3:没有清单(早于 v0.38.0 的安装 / 他手搓的)⇒ 默认一个字节都不动', () => {
  const v = checkUpgrade({ manifest: null, current: FILES, next: { ...FILES, 'agent.cordis.yml': '别的\n' } })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'no-manifest')
  assert.deepEqual(v.edited, ['agent.cordis.yml', 'preset.yml'])
  assert.match(v.hint, new RegExp(PRESET_MANIFEST.replace(/\./g, '\\.')))
})

test('F3:清单坏了(不是对象 / 没有 fingerprint)也算认不出来,不冒险', () => {
  assert.equal(checkUpgrade({ manifest: '不是对象', current: FILES, next: { ...FILES, a: 1 } }).ok, false)
  assert.equal(checkUpgrade({ manifest: {}, current: FILES, next: { ...FILES, a: 1 } }).reason, 'no-manifest')
})
