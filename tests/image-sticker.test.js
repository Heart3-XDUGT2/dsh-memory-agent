/**
 * 表情包区分（主包侧）—— 2026-10-20（第三件）
 * ==================================================================
 * 渠道侧（`dsh-echo-qq`）已经把 `sub_type` / `summary` 透传上来了
 * （见那边的 `test/image-sticker.test.mjs`），主包这边还差两处：
 *
 *   ① `lib/relay.js` 的 `parseImages` —— **最后一道闸**，不放行的话
 *      `parseEnvelope` 会把这两个字段洗掉，下游永远判不出表情包。
 *   ② `lib/eyes.js` 的 `isStickerImage` —— **判据**（`sub_type===1` 或 summary 含「表情」）。
 *
 * `parseImages` 没有单独导出（它是 `parseEnvelope` 的内部步骤），
 * 所以这里**走 `parseEnvelope` 测**——更真实：验的就是"一封真信进来会不会带上标记"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseEnvelope } from '../lib/relay.js'
import { isStickerImage } from '../lib/eyes.js'

/** 一封最小的合法私聊信。 */
function envelope (over = {}) {
  return {
    v: 1,
    platform: 'qq',
    chat: { id: '1', type: 'private' },
    sender: { id: '2', isMaster: true },
    text: '在吗',
    msgId: 'm-1',
    ...over
  }
}

// ---- ① parseImages 放行 --------------------------------------------------

test('① ★ parseEnvelope 必须放行 sub_type / summary', () => {
  const r = parseEnvelope(envelope({
    images: [{ url: 'http://x/s.gif', sub_type: 1, summary: '[动画表情]' }]
  }))
  assert.equal(r.ok, true, JSON.stringify(r))
  const img = r.value.images[0]
  assert.equal(img.sub_type, 1, '★ sub_type 被洗掉 ⇒ 下游永远判不出表情包')
  assert.equal(img.summary, '[动画表情]')
})

test('② 普通图（sub_type:0）也要原样带过来', () => {
  const r = parseEnvelope(envelope({ images: [{ url: 'http://x/a.jpg', sub_type: 0 }] }))
  assert.equal(r.ok, true)
  assert.equal(r.value.images[0].sub_type, 0)
})

test('③ 非法 sub_type ⇒ 丢掉，不许变 NaN（也不许整条被拒）', () => {
  const r = parseEnvelope(envelope({ images: [{ url: 'http://x/a.jpg', sub_type: 'abc' }] }))
  assert.equal(r.ok, true, '一个坏字段不该让整条信被拒 —— 那他就连字都白打了')
  assert.equal('sub_type' in r.value.images[0], false)
})

test('④ summary 超长 ⇒ 截到 40（不许当载荷）', () => {
  const r = parseEnvelope(envelope({ images: [{ url: 'u', summary: '表'.repeat(80) }] }))
  assert.equal(r.ok, true)
  assert.equal(r.value.images[0].summary.length, 40)
})

test('⑤ 没有这两个字段的图 ⇒ 老行为逐位不变', () => {
  const r = parseEnvelope(envelope({ images: [{ url: 'http://x/a.jpg' }] }))
  assert.equal(r.ok, true)
  assert.deepEqual(r.value.images[0], { url: 'http://x/a.jpg' })
})

test('⑥ 图片-only 仍然受理（sub_type 不影响那条判据）', () => {
  const r = parseEnvelope(envelope({ text: '', images: [{ url: 'u', sub_type: 1 }] }))
  assert.equal(r.ok, true, '他单发一个表情包也得收下')
})

// ---- ② isStickerImage 判据 ----------------------------------------------

test('⑦ ★ sub_type===1 ⇒ 表情包', () => {
  assert.equal(isStickerImage({ sub_type: 1 }), true)
  assert.equal(isStickerImage({ sub_type: '1' }), true, '字符串也要认（JSON 里常是字符串）')
})

test('⑧ sub_type===0 / 缺失 ⇒ 普通图', () => {
  assert.equal(isStickerImage({ sub_type: 0 }), false)
  assert.equal(isStickerImage({}), false)
  assert.equal(isStickerImage(null), false)
})

test('⑨ ★ 只有 summary 含「表情」也当表情包（有的实现不发 sub_type）', () => {
  assert.equal(isStickerImage({ summary: '[动画表情]' }), true)
  assert.equal(isStickerImage({ summary: '[表情]' }), true)
})

test('⑩ summary 是普通图描述 ⇒ 不是表情包', () => {
  assert.equal(isStickerImage({ summary: '[图片]' }), false)
  assert.equal(isStickerImage({ summary: '' }), false)
})

test('⑪ 两条判据是"或"：任一成立就算', () => {
  assert.equal(isStickerImage({ sub_type: 1, summary: '[图片]' }), true, 'sub_type 先赢')
  assert.equal(isStickerImage({ sub_type: 0, summary: '[动画表情]' }), true, 'summary 也能赢')
})

test('⑫ 端到端：一封表情包信 → parseEnvelope → isStickerImage 认得出来', () => {
  const r = parseEnvelope(envelope({
    text: '',
    images: [{ url: 'http://x/m.gif', sub_type: 1, summary: '[表情]' }]
  }))
  assert.equal(r.ok, true)
  assert.equal(isStickerImage(r.value.images[0]), true,
    '★ 两道闸都过了才算通：parseImages 放行 + 判据认得')
})
