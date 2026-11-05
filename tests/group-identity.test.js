/**
 * 群聊认人：主人标记 + 群友区分 —— 2026-10-18
 * ==================================================================
 * 他提的两个缺口：
 *
 *   ① **主人没标记** —— 原来 `master ? '' : '（非主人）'`，
 *      主人那一栏**什么都不加** ⇒ 她看不出这是主人，只能靠"私聊只有主人"的旧习惯猜。
 *      群里现在两种人都有，这个空白就是"她不知道在跟谁说话"。
 *
 *   ② **普通群友之间分不清** —— 原来只有昵称，而昵称会重名（"张三"可能有两个）、
 *      也可能为空（OneBot 拿不到昵称时）⇒ 两个张三在她眼里是同一个人。
 *
 * 修法：
 *   · 主人：头部 `（主人）` + 正文前一句 `[这是主人。可以亲近、可以撒娇、可以主动关心。]`
 *   · 群友：头部 `昵称#QQ号后四位（非主人）` + 原有的警惕提示
 *   · 昵称为空：直接用完整 QQ 号（不加后缀，否则 `QQ5556667777#7777` 冗余）
 *   · **私聊逐字节不变**（老形状被 `stripEnvelope` 与老测试依赖）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../lib/relay.js', import.meta.url)), 'utf8')
// 只取 renderInboundText + 它依赖的 platformLabel（避免整模块的副作用）
const { renderInboundText } = await import('../lib/relay.js')

/** 造一个群聊 env（默认在摸鱼群）。 */
function groupEnv (over = {}) {
  return {
    platform: 'qq',
    chatType: 'group',
    chatId: '822309315',
    chatTitle: '摸鱼群',
    senderId: '1234567890',
    senderName: '张三',
    isMaster: false,
    text: '我也觉得',
    images: [],
    ...over
  }
}

/** 取第一行（头部）。 */
const headOf = (env) => renderInboundText(env).split('\n')[0]

test('① 群聊 + 主人 ⇒ 头部带「（主人）」，且正文前有主人提示', () => {
  const t = renderInboundText(groupEnv({ senderId: '880000001', senderName: '阿岚', isMaster: true }))
  assert.equal(headOf(groupEnv({ senderId: '880000001', senderName: '阿岚', isMaster: true })),
    '【QQ·群聊·摸鱼群(822309315)】阿岚（主人）')
  assert.ok(t.includes('[这是主人。可以亲近、可以撒娇、可以主动关心。]'),
    '★ 主人必须有一句行为指令（光有头部那个括号容易被当成装饰）')
  assert.equal(t.includes('警惕'), false, '主人不贴警惕')
  // 主人提示要在正文之前
  assert.ok(t.indexOf('这是主人') < t.indexOf('我也觉得'), '主人提示要在正文之前')
})

test('② 群聊 + 非主人 ⇒ 昵称 + #后四位 + （非主人）+ 警惕', () => {
  const env = groupEnv({ senderId: '1234567890', senderName: '张三' })
  const t = renderInboundText(env)
  assert.equal(headOf(env), '【QQ·群聊·摸鱼群(822309315)】张三#7890（非主人）',
    '★ 必须有 QQ 号后四位 —— 否则重名的群友分不清')
  assert.match(t, /\[警惕：这条来自群里的\*\*非主人\*\*/)
  assert.equal(t.includes('这是主人'), false, '非主人不该有主人提示')
})

test('③ ★ 两个同名群友 ⇒ 渲染出的标识必须不同（这是缺口 2 的核心）', () => {
  const a = headOf(groupEnv({ senderId: '1234567890', senderName: '张三' }))
  const b = headOf(groupEnv({ senderId: '9876543210', senderName: '张三' }))
  assert.notEqual(a, b, '★ 两个"张三"的头部必须不同，实际都是: ' + a)
  assert.ok(a.includes('#7890') && b.includes('#3210'), '靠后四位区分')
})

test('④ 昵称为空 ⇒ 直接用完整 QQ 号（不再拼后缀，避免 QQ…7777#7777 冗余）', () => {
  const h = headOf(groupEnv({ senderId: '5556667777', senderName: '' }))
  assert.equal(h, '【QQ·群聊·摸鱼群(822309315)】QQ5556667777（非主人）')
  assert.equal(h.includes('#'), false, '完整号后面不该再跟 #后四位')
})

test('⑤ 私聊 ⇒ 逐字节不变（老形状是硬约束）', () => {
  const priv = { platform: 'qq', chatType: 'private', chatId: '880000001', senderId: '880000001', senderName: '阿岚', isMaster: true, text: '在吗', images: [] }
  assert.equal(renderInboundText(priv), '【QQ·私聊】阿岚说:在吗')
  // 私聊里 isMaster 不影响形状（私聊白名单只放主人，不需要标）
  assert.equal(renderInboundText({ ...priv, isMaster: false }), '【QQ·私聊】阿岚说:在吗')
  // 空昵称的老回退也要保住
  assert.equal(renderInboundText({ ...priv, senderName: '' }), '【QQ·私聊】他说:在吗')
})

test('⑥ 群友昵称里的 `】` 不许破坏头部形状（否则 stripEnvelope 会切错）', () => {
  const h = headOf(groupEnv({ senderName: '恶】意', senderId: '11112222' }))
  // 头部只能有一个 `】`（前缀那个）
  assert.equal((h.match(/】/g) || []).length, 1, '★ 昵称里的 】 必须被清掉，实际: ' + h)
  assert.ok(h.startsWith('【QQ·群聊·摸鱼群(822309315)】'))
})

test('⑦ 主人也可以有 ID，但**不加后缀**（isMaster 本身唯一，加了反而乱）', () => {
  const h = headOf(groupEnv({ senderId: '880000001', senderName: '阿岚', isMaster: true }))
  assert.equal(h.includes('#'), false, '主人头部不该有 # 后缀')
  assert.ok(h.includes('（主人）'))
})

test('⑧ 静态闸：源码里两种身份都必须显式分支（不许再靠"什么都不加"表达主人）', () => {
  assert.ok(src.includes("'（主人）'"), '要有明确的「（主人）」标记')
  assert.ok(src.includes('这是主人。可以亲近、可以撒娇、可以主动关心。'), '要有主人提示句')
  assert.ok(src.includes('groupWho'), '群聊昵称要用独立变量（私聊的 who 不许动）')
  assert.ok(src.includes('tail'), '要有 QQ 号后四位的计算')
  // 反证：不许再出现"主人分支返回空字符串"的老写法
  assert.equal(src.includes("who + (master ? '' : '（非主人）')"), false,
    '★ 那个 `master ? \'\'` 就是缺口 1 的根源，不许回来')
})
