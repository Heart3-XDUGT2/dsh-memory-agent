/**
 * 面板 ↔ 设置项的契约(防「卡上有个开关,但它根本不落库」)。
 *
 * 2026-09-26 起调参面搬到了网页仪表盘,控件的**唯一来源**变成
 * `lib/settings-fields.js`(由 /api/echo/settings 的 fields 发给前端,
 * 设置区那半区不再有第二份)。所以这里扫的不再是 `lib/client.js` 的
 * `relayField(...)` 调用,而是那张字段表 —— 契约因此更强了:两个前端
 * (网页 / 设置区残余)渲染的都是同一份,谁漂了都是这张表漂了。
 *
 * 契约:字段表里 relay 那一组的每个键,都必须是真的设置项;反过来,
 * 每个设置项也必须有控件(否则用户改不了)。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SETTINGS_FIELDS } from '../lib/settings-fields.js'

const { SETTINGS_DEFAULTS } = await import('../lib/toggle.js')

/** 字段表里某一组(nested)的键与字段对象。 */
function panelGroupKeys (nested) {
  const group = SETTINGS_FIELDS.find((g) => g.nested === nested)
  assert.ok(group !== undefined, '字段表里没有 ' + nested + ' 这一组')
  const keys = new Set()
  const byKey = new Map()
  for (const f of group.fields) { keys.add(f.key); byKey.set(f.key, f) }
  return { keys, byKey, title: group.title }
}

test('面板「传话」卡的控件键 = 设置项键(一个不多一个不少)', () => {
  const { keys: panel, title } = panelGroupKeys('relay')
  const settings = new Set(Object.keys(SETTINGS_DEFAULTS.relay))
  assert.ok(panel.size >= 8, `只抠到 ${panel.size} 个控件("${title}"那一组),扫描规则可能失效了`)
  const ghosts = [...panel].filter((k) => !settings.has(k))
  const orphan = [...settings].filter((k) => !panel.has(k))
  assert.deepEqual(ghosts, [], '面板画了不存在的设置项(拨了不落库)')
  assert.deepEqual(orphan, [], '设置项在面板上没有控件(用户改不了)')
})

test('总闸/令牌是默认安全的那一档(装上不改变行为)', () => {
  assert.equal(SETTINGS_DEFAULTS.relay.enabled, false)
  assert.equal(SETTINGS_DEFAULTS.relay.token, '')
})

test('未拍板项按推荐默认:只读权限 + 只推私聊(v0.29.0:群聊一律拒收)', () => {
  assert.equal(SETTINGS_DEFAULTS.relay.permissionPreset, 'read-only')
  assert.equal(SETTINGS_DEFAULTS.relay.proactiveScope, 'private')
  // v0.29.0 个人机器人:groupProactive 随群聊一起退役,设置项不存在了
  assert.equal('groupProactive' in SETTINGS_DEFAULTS.relay, false)
})

test('面板把 token 当密码框(不该在屏幕上明文躺着)', () => {
  const { byKey } = panelGroupKeys('relay')
  const token = byKey.get('token')
  assert.ok(token !== undefined, '找不到 token 控件')
  assert.equal(token.type, 'password', 'token 控件必须是 password')
  assert.match(String(token.hint), /留空/, '得说清「留空 = 不改」,否则用户以为空着就是清掉')
})
