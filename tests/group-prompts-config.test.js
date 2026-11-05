/**
 * 群聊三句提示词开放成可配 —— 2026-10-19（他拍的「甲方案」）
 * ==================================================================
 * 这三句原来硬编码在 `lib/relay.js` 的 `renderInboundText` 里，他改不了口吻：
 *
 *   ① `brevity`      群聊简短回复 + 「这句话也许不是对你说的」
 *   ② `masterNote`   主人标记（可以亲近/撒娇/主动关心）
 *   ③ 非主人警示      别擅自答应、别透隐私、别替主人承诺
 *
 * 现在：`settings.groupChatPrompts.{shortReply,masterHint,guestWarning}`
 *   · **留空 = 用内置默认**（`GROUP_PROMPT_DEFAULTS`）⇒ 老配置行为一字不变
 *   · 填了就用他的；没带 `[...]` 会自动补一层（`composeGroupPrompt`）
 *
 * ⚠️ **只开放这三句**。`extract` / `reflection` 的 prompt 绑死 JSON schema，
 *   开放出去改坏就是解析失败（整固停 13 天那种事故），丙方案不做。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GROUP_PROMPT_DEFAULTS,
  composeGroupPrompt,
  renderInboundText,
  parseEnvelope
} from '../lib/relay.js'

/** 造一条群聊信封（走真实的 parseEnvelope，别手搓 value）。 */
function groupEnv (over = {}) {
  const { isMaster = false, historyDigest = '', ...rest } = over
  const r = parseEnvelope({
    v: 1,
    platform: 'qq',
    msgId: 'm1',
    chat: { id: '875432047', type: 'group', title: '摸鱼群' },
    sender: { id: '123456', name: '阿岚', isMaster },
    text: '在吗',
    ...(historyDigest !== '' ? { historyDigest } : {}),
    ...rest
  })
  assert.equal(r.ok, true, '协议信封没造对: ' + String(r.reason))
  return r.value
}

/** 私聊信封（同一套 parseEnvelope）。 */
function privateEnv (over = {}) {
  const r = parseEnvelope({
    v: 1,
    platform: 'qq',
    msgId: 'm2',
    chat: { id: '999', type: 'private' },
    sender: { id: '1', name: '阿岚', isMaster: true },
    text: '在吗',
    ...over
  })
  assert.equal(r.ok, true, '私聊信封没造对: ' + String(r.reason))
  return r.value
}

test('① ★ 默认值就是原来那三句（向后兼容的基准）', () => {
  assert.ok(GROUP_PROMPT_DEFAULTS.shortReply.includes('这句话也许不是对你说的'))
  assert.ok(GROUP_PROMPT_DEFAULTS.shortReply.includes('简短直接'))
  assert.ok(GROUP_PROMPT_DEFAULTS.masterHint.includes('这是主人'))
  assert.ok(GROUP_PROMPT_DEFAULTS.guestWarning.includes('非主人'))
  assert.ok(GROUP_PROMPT_DEFAULTS.guestWarning.includes('不要透露主人的隐私'))
  // 三句都以换行 + 方括号开头（注入时的形状）
  for (const [k, v] of Object.entries(GROUP_PROMPT_DEFAULTS)) {
    assert.ok(v.startsWith('\n['), k + ' 该以「换行 + [」开头，实际 ' + JSON.stringify(v.slice(0, 6)))
    assert.ok(v.endsWith(']'), k + ' 该以 ] 结尾')
  }
})

test('② ★ 留空 / 空白 / 非字符串 ⇒ **原样回退默认**（老配置一字不变）', () => {
  const d = GROUP_PROMPT_DEFAULTS.guestWarning
  for (const empty of ['', '   ', '\n\t ', undefined, null]) {
    assert.equal(composeGroupPrompt(empty, d), d,
      JSON.stringify(empty) + ' 应回退默认，实际被改成了别的')
  }
  // 数字/对象这种脏值也不许炸，回默认
  assert.equal(composeGroupPrompt(123, d), d)
  assert.equal(composeGroupPrompt({ a: 1 }, d), d)
})

test('③ 填了就用自己的；**没带方括号自动补一层**（带了就不重复套）', () => {
  const d = GROUP_PROMPT_DEFAULTS.masterHint
  // 裸文本 ⇒ 自动补 []
  assert.equal(composeGroupPrompt('这是老王，随便聊', d), '\n[这是老王，随便聊]')
  // 自带 [] ⇒ 不重复套
  assert.equal(composeGroupPrompt('[这是老王，随便聊]', d), '\n[这是老王，随便聊]')
  // 前后空白会被 trim（免得注入里多出空行）
  assert.equal(composeGroupPrompt('  这是老王  ', d), '\n[这是老王]')
})

test('④ ★ 渲染：config 为空时，群聊正文里出现的是**默认那三句**', () => {
  const env = groupEnv({ isMaster: true })
  const out = renderInboundText(env)
  assert.ok(out.includes(GROUP_PROMPT_DEFAULTS.shortReply.trim()),
    '★ 默认的"也许不是对你说的"没进正文')
  assert.ok(out.includes(GROUP_PROMPT_DEFAULTS.masterHint.trim()),
    '★ 默认的主人提示没进正文')
  // 非主人那条走另一支
  const guest = renderInboundText(groupEnv({ isMaster: false }))
  assert.ok(guest.includes(GROUP_PROMPT_DEFAULTS.guestWarning.trim()),
    '★ 默认的非主人警示没进正文')
})

test('⑤ 渲染顺序没变：简短提示 → 身份提示 → 正文（群聊补档夹在中间）', () => {
  const out = renderInboundText(groupEnv({ isMaster: false, historyDigest: '[群聊补档 · 测试]' }))
  // ⚠️ 用**各自独有**的文案定位：`非主人` 也出现在头部「（非主人）」里，会比简短提示更早命中。
  const iBrevity = out.indexOf('这句话也许不是对你说的')
  const iWarn = out.indexOf('不要擅自答应')
  const iArchive = out.indexOf('[群聊补档 · 测试]')
  const iBody = out.indexOf('在吗')
  assert.ok(iBrevity > 0, '简短提示没进正文')
  assert.ok(iWarn > iBrevity, '非主人警示要在简短提示之后')
  assert.ok(iArchive > iWarn, '补档要在身份提示之后')
  assert.ok(iBody > iArchive, '正文要在补档之后')
})

test('⑥ 私聊**不受影响**：三句群聊提示一个字都不出现', () => {
  const env = privateEnv()
  const out = renderInboundText(env)
  assert.equal(out.includes('这句话也许不是对你说的'), false, '私聊不该有群聊提示')
  assert.equal(out.includes('这是主人'), false, '私聊不该有群聊主人提示')
  assert.equal(out.includes('非主人'), false, '私聊不该有非主人警示')
})

test('⑦ 设置界面暴露了这三项，且默认值是空串（= 留空用默认）', async () => {
  const { SETTINGS_DEFAULTS } = await import('../lib/toggle.js')
  const d = SETTINGS_DEFAULTS.groupChatPrompts
  assert.ok(d, 'SETTINGS_DEFAULTS 要有 groupChatPrompts 这一组')
  assert.deepEqual(Object.keys(d).sort(), ['guestWarning', 'masterHint', 'shortReply'])
  for (const [k, v] of Object.entries(d)) {
    assert.equal(v, '', k + ' 的默认值必须是空串（空 = 用 relay 的内置默认）')
  }
  // 字段表里也摸得到（否则面板上看不见）
  const { SETTINGS_FIELDS } = await import('../lib/settings-fields.js')
  const grp = SETTINGS_FIELDS.find((g) => g.nested === 'groupChatPrompts')
  assert.ok(grp, '字段表里要有 groupChatPrompts 这一组')
  assert.equal(grp.fields.length, 3)
  for (const f of grp.fields) {
    assert.equal(f.type, 'textarea', f.key + ' 该是多行（提示词是长句）')
    assert.ok(String(f.hint).includes('留空'), f.key + ' 的提示要写清「留空用默认」')
  }
})
