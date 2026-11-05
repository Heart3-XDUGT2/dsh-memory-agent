/**
 * @ 感知（接收侧·主包层）—— 2026-10-21
 * ==================================================================
 * 渠道侧（`dsh-echo-qq`）已经把 `atMe` / `atOthers` 算好放进信封了
 * （见那边的 `test/at-hints.test.mjs`），这一组钉主包这边的两件事：
 *
 *   ① `parseEnvelope` **放行**这两个字段（坏字段丢掉、不炸整条信）
 *   ② `renderInboundText` 把她们拼成一句人话
 *
 * ## 格式（他拍的）
 *
 *   · 只 @ 她      ⇒ `（张三@了你）`
 *   · @ 她 + 别人  ⇒ `（张三@了你，还@了 李四、王五）`
 *   · 只 @ 别人    ⇒ `（张三@了 李四）`
 *   · 都没有       ⇒ **不拼**（正文形状与从前逐位一致）
 *
 * ## 两条硬纪律
 *
 *   · **`text` 一个字不动** —— 塞 `@你` 会把「单发图/表情 ⇒ 不用回」的判据
 *     和记忆检索的 query 一起弄坏。
 *   · **没 @ 时正文逐位不变** —— 老测试（含 `stripEnvelope`）都依赖那个形状。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseEnvelope, renderInboundText, renderAtHint } from '../lib/relay.js'

/** 一封最小的合法群聊信。 */
function envelope (over = {}) {
  return {
    v: 1,
    platform: 'qq',
    chat: { id: '822309315', type: 'group' },
    sender: { id: '880000002', name: '张三', isMaster: false },
    text: '看这个',
    msgId: 'm-1',
    ...over
  }
}

// ---- ① parseEnvelope 放行 ------------------------------------------------

test('① ★ parseEnvelope 放行 atMe / atOthers', () => {
  const r = parseEnvelope(envelope({ atMe: true, atOthers: [{ qq: '111', name: '李四' }] }))
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.value.atMe, true)
  assert.deepEqual(r.value.atOthers, [{ qq: '111', name: '李四' }])
})

test('② ★ 没有 @ ⇒ 信封不多出任何键（老形状不变）', () => {
  const r = parseEnvelope(envelope())
  assert.equal(r.ok, true)
  assert.equal('atMe' in r.value, false)
  assert.equal('atOthers' in r.value, false)
})

test('③ 坏 atOthers（不是数组 / 元素不是对象）⇒ 丢掉，**不炸整条信**', () => {
  const r1 = parseEnvelope(envelope({ atOthers: 'x' }))
  assert.equal(r1.ok, true, '一个坏字段不该让他连字都白打')
  assert.equal('atOthers' in r1.value, false)

  const r2 = parseEnvelope(envelope({ atOthers: [null, 42, { qq: '111', name: '李四' }] }))
  assert.equal(r2.ok, true)
  assert.deepEqual(r2.value.atOthers, [{ qq: '111', name: '李四' }])
})

test('④ atOthers 上限 8 个', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ qq: String(100 + i), name: '' }))
  const r = parseEnvelope(envelope({ atOthers: many }))
  assert.equal(r.value.atOthers.length, 8)
})

test('⑤ ★★ `text` 一个字不动（@ 不进 text）', () => {
  const r = parseEnvelope(envelope({ atMe: true, atOthers: [{ qq: '111', name: '李四' }] }))
  assert.equal(r.value.text, '看这个')
  assert.equal(r.value.text.includes('@'), false,
    '★ text 是 noReply 判据 + 记忆检索的 query，塞标记会两处一起坏')
})

// ---- ② renderAtHint ------------------------------------------------------

test('⑥ ★ 只 @ 她 ⇒ （张三@了你）', () => {
  assert.equal(renderAtHint({ atMe: true, atOthers: [], senderName: '张三' }), '（张三@了你）')
})

test('⑦ ★ @ 她 + 别人 ⇒ （张三@了你，还@了 李四）', () => {
  const line = renderAtHint({ atMe: true, atOthers: [{ qq: '111', name: '李四' }], senderName: '张三' })
  assert.equal(line, '（张三@了你，还@了 李四）')
})

test('⑧ ★ 只 @ 别人 ⇒ （张三@了 李四）', () => {
  const line = renderAtHint({ atMe: false, atOthers: [{ qq: '111', name: '李四' }], senderName: '张三' })
  assert.equal(line, '（张三@了 李四）')
})

test('⑨ ★★ name 缺失 ⇒ 降级成 QQ 号（他拍的「乙方案」）', () => {
  const line = renderAtHint({ atMe: false, atOthers: [{ qq: '880000002', name: '' }], senderName: '张三' })
  assert.equal(line, '（张三@了 QQ880000002）')
})

test('⑩ name 有就用 name，没有才降级（同一条里混着）', () => {
  const line = renderAtHint({
    atMe: false,
    atOthers: [{ qq: '111', name: '李四' }, { qq: '222', name: '' }],
    senderName: '张三'
  })
  assert.equal(line, '（张三@了 李四、QQ222）')
})

test('⑪ @全体成员（qq=all）⇒ 说人话，不显示 QQall', () => {
  const line = renderAtHint({ atMe: false, atOthers: [{ qq: 'all', name: '' }], senderName: '张三' })
  assert.equal(line, '（张三@了 全体成员）')
})

test('⑫ 都没有 ⇒ 空串', () => {
  assert.equal(renderAtHint({}), '')
  assert.equal(renderAtHint({ atMe: false, atOthers: [] }), '')
  assert.equal(renderAtHint(null), '')
})

test('⑬ senderName 为空 ⇒ 退回「他」', () => {
  assert.equal(renderAtHint({ atMe: true, atOthers: [], senderName: '' }), '（他@了你）')
})

// ---- ③ renderInboundText 拼进去 -----------------------------------------

test('⑭ ★ 群聊 @ 她 ⇒ 正文里有「@了你」', () => {
  const r = parseEnvelope(envelope({ atMe: true }))
  const text = renderInboundText(r.value)
  assert.match(text, /@了你/)
  assert.match(text, /^【QQ·群聊/)
})

test('⑮ ★ 群聊 @ 她 + 别人 ⇒ 正文里有「还@了」', () => {
  const r = parseEnvelope(envelope({ atMe: true, atOthers: [{ qq: '111', name: '李四' }] }))
  const text = renderInboundText(r.value)
  assert.match(text, /@了你，还@了 李四/)
})

test('⑯ ★ 群聊只 @ 别人 ⇒ 正文里有「@了」但没有「@了你」', () => {
  const r = parseEnvelope(envelope({ atOthers: [{ qq: '111', name: '李四' }] }))
  const text = renderInboundText(r.value)
  assert.match(text, /@了 李四/)
  assert.equal(text.includes('@了你'), false)
})

test('⑰ ★★ 没 @ ⇒ 正文**与从前逐位一致**（不多一行）', () => {
  const withAt = renderInboundText(parseEnvelope(envelope({ atMe: true })).value)
  const without = renderInboundText(parseEnvelope(envelope()).value)
  assert.equal(without.includes('@'), false, '★ 没 @ 时正文里不该出现 @')
  // 去掉 @ 那一行之后，正文应与"从没有过 @ 这个功能"一模一样
  const stripped = withAt.split('\n').filter((l) => !l.startsWith('（') || !l.includes('@')).join('\n')
  assert.equal(stripped, without)
})

test('⑱ @ 提示在**正文之后**（不是头部）', () => {
  const r = parseEnvelope(envelope({ atMe: true }))
  const lines = renderInboundText(r.value).split('\n')
  assert.ok(lines[lines.length - 1].includes('@了你'), '最后一行才是 @ 提示')
})

test('⑲ 私聊里有 at（理论上没有）⇒ 也照样拼出来，不吞', () => {
  const r = parseEnvelope(envelope({
    chat: { id: '880000002', type: 'private' },
    sender: { id: '880000002', name: '张三', isMaster: true },
    atMe: true
  }))
  const text = renderInboundText(r.value)
  assert.match(text, /@了你/)
})
