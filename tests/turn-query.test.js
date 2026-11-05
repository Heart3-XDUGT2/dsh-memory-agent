import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latestDirectUserText, humanTurn } from '../lib/turn-query.js'

// 2026-09-26 现场:他问「你这上下文注入是不是没注入角色人格啊」。
// 人格没丢(它走 systemPrompt 段),丢的是**记忆/画像那一整块** ——
// 因为判断「哪条是他说的」时只认 source.kind==='user',而桥注入的是 'plugin',
// 于是 query 空、pre-step 在检索之前就 early-return。审计里能直接看出来:
// 本地轮次 injected_memories 1700~2200 字节,QQ 那几轮是空的。

const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
// 2026-10-03:注入的形状升为"产出者自有"kind(`plugin:dsh-echo`)—— 0.2.0-rc 的 v4
// 会话格式直接拒绝 `kind:'plugin'`(整轮运行失败)。判据容错两种都认,所以下面
// 另留一条**旧形状**夹具钉住容错(迁移前的历史事件就是那个样子)。
const ECHO_KIND = 'plugin:dsh-echo'
const relayMsg = (framed, raw) => ({
  role: 'user',
  content: [{ type: 'text', text: framed }],
  source: { kind: ECHO_KIND, form: 'relay', platform: 'qq', chatId: '<your-qq>', chatType: 'private', rawText: raw }
})
const careMsg = (framed, raw) => ({
  role: 'user',
  content: [{ type: 'text', text: framed }],
  source: { kind: ECHO_KIND, form: 'care', rawText: raw }
})
const snapshotMsg = (text) => ({
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: ECHO_KIND, form: 'snapshot' }
})
/** 旧形状(0.1.x / v3 日志里的样子):判据必须照样认得出。 */
const legacyRelayMsg = (framed, raw) => ({
  role: 'user',
  content: [{ type: 'text', text: framed }],
  source: { kind: 'plugin', plugin: 'dsh-echo', form: 'relay', rawText: raw }
})

test('本地轮次:照旧取真人那条', () => {
  assert.equal(latestDirectUserText([userMsg('我刚才给你发了谁的图片？')]), '我刚才给你发了谁的图片？')
})

test('QQ 进来的那一轮:算他的话(这就是修掉的那个洞)', () => {
  const m = [snapshotMsg('[她的记忆与心情]\n【现在】…'), relayMsg('【QQ·私聊】阿岚说:猜猜这是谁\n(回他请用 echo_qq_say —— 你的回复不会自动送出去了)', '猜猜这是谁')]
  assert.equal(latestDirectUserText(m), '猜猜这是谁', '要拿他打的原话,不是带包装的正文')
})

test('查询词里不许出现包装框架(否则检索被「(回他请用…)」污染)', () => {
  const q = latestDirectUserText([relayMsg('【QQ·私聊】阿岚说:月亮拍糊了\n(回他请用 echo_qq_say)', '月亮拍糊了')])
  assert.equal(q.includes('【QQ·私聊】'), false)
  assert.equal(q.includes('回他请用'), false)
  assert.equal(q, '月亮拍糊了')
})

test('他发图不写字:不拿包装当查询词,回退到上一条有字的话', () => {
  const m = [
    relayMsg('【QQ·私聊】阿岚说:看看这个', '看看这个'),
    relayMsg('【QQ·私聊】阿岚发来1张图(没写字)\n(回他请用 echo_qq_say)', '')
  ]
  assert.equal(latestDirectUserText(m), '看看这个', '纯图那轮用上一条话的语境')
})

test('纯图且没有更早的话:返回空串(调用方据此跳过注入,而不是拿框架去检索)', () => {
  assert.equal(latestDirectUserText([relayMsg('【QQ·私聊】阿岚发来1张图(没写字)', '')]), '')
})

test('我们自己的注入绝不能当查询词(记忆块不许检索自己)', () => {
  const block = snapshotMsg('[她的记忆与心情] 阿岚喜欢吃章鱼小丸子')
  assert.equal(latestDirectUserText([block]), '')
  assert.equal(latestDirectUserText([block, relayMsg('【QQ·私聊】…说:在吗', '在吗')]), '在吗')
})

test('她主动开口那一轮:用心事当查询词(以前是空 ⇒ 一点记忆都没有)', () => {
  const m = [careMsg('(这是你在用 QQ 喊他)\n她答应给 Echo 拍月亮照片，此事还没有结果。', '她答应给 Echo 拍月亮照片，此事还没有结果。')]
  assert.equal(latestDirectUserText(m), '她答应给 Echo 拍月亮照片，此事还没有结果。')
})

test('一批里最后一条他的话胜出(工具步会重复进入)', () => {
  const m = [relayMsg('【QQ·私聊】…说:第一句', '第一句'), relayMsg('【QQ·私聊】…说:第二句', '第二句')]
  assert.equal(latestDirectUserText(m), '第二句')
})

test('humanTurn:认什么、不认什么', () => {
  assert.deepEqual(humanTurn({ kind: 'user' }), { kind: 'user', rawText: '' })
  assert.equal(humanTurn({ kind: ECHO_KIND, form: 'relay', rawText: 'x' }).kind, 'relay')
  assert.equal(humanTurn({ kind: ECHO_KIND, form: 'care' }).kind, 'care')
  assert.equal(humanTurn({ kind: ECHO_KIND, form: 'snapshot' }), null)
  assert.deepEqual(humanTurn({ kind: ECHO_KIND, form: 'relay' }), { kind: 'relay', rawText: '' },
    '没写 rawText 就是空串(发图不写字那条路)')
  // 旧形状照样认(容错:迁移前的历史事件就是那个样子)
  assert.equal(humanTurn({ kind: 'plugin', plugin: 'dsh-echo', form: 'relay', rawText: 'x' }).kind, 'relay')
  assert.equal(humanTurn({ kind: 'plugin', plugin: 'dsh-echo', form: 'snapshot' }), null)
  // 别家的:两种形状都不认
  assert.equal(humanTurn({ kind: 'plugin', plugin: '别人家的插件', form: 'relay' }), null)
  assert.equal(humanTurn({ kind: 'plugin:别人家的插件', form: 'relay' }), null)
  assert.equal(humanTurn({ kind: 'tool' }), null)
  assert.equal(humanTurn(undefined), null)
  // 助手/工具消息不该被当查询词(只认 role==='user' 在 latestDirectUserText 里把关)
  assert.equal(latestDirectUserText([{ role: 'assistant', content: [{ type: 'text', text: '她说的话' }], source: { kind: 'user' } }]), '')
})

// ── F9(2026-09-27):宿主噪声也走这道门 ──────────────────────────────
// 审计对出来:22 条 extract 里 3 条的 `user_input` 是 `Current runtime context…`
// / `<goal_complete>…` / `[model changed…]` —— DSH 的运行时快照与子代理通告
// 被当成"用户输入"参与了她的 QQ 检索。漏点:它们也是 `source.kind==='user'`
// (宿主眼里就是"用户这一轮的输入"),于是 humanTurn 放行、正文直接成了查询词。

test('F9 宿主注入不当查询词:runtime context(整批都是噪声 ⇒ 空串)', () => {
  const rc = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: danger-full-access.'
  assert.equal(latestDirectUserText([userMsg(rc)]), '',
    '拿运行时快照去检索,等于把整条管线带进沟里')
})

test('F9 宿主注入不当查询词:<goal_complete> / <goal_*> 信封', () => {
  assert.equal(latestDirectUserText([userMsg('<goal_complete>目标已完成:修好 F7。</goal_complete>')]), '')
  assert.equal(latestDirectUserText([userMsg('<goal_continue>继续第 3 轮</goal_continue>')]), '')
})

test('F9 宿主注入不当查询词:[model changed / <system> / <task>', () => {
  assert.equal(latestDirectUserText([userMsg('[model changed: assistant turns above this point were generated by deepseek-flash]')]), '')
  assert.equal(latestDirectUserText([userMsg('<system>你是一个有用的助手</system>')]), '')
  assert.equal(latestDirectUserText([userMsg('<task>去开源社区找现成图谱实现作参照</task>')]), '')
})

test('F9 噪声夹在中间:回退到上一条真话,而不是整轮没注入', () => {
  const rc = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
  const m = [userMsg('帮我看看记忆图谱'), userMsg(rc)]
  assert.equal(latestDirectUserText(m), '帮我看看记忆图谱',
    '有真话就用真话 —— 噪声只是被跳过,不该让这一轮的记忆整块消失')
})

test('F9 噪声之后又有真话:真话照样胜出', () => {
  const m = [userMsg('<goal_complete>done</goal_complete>'), userMsg('在吗')]
  assert.equal(latestDirectUserText(m), '在吗')
})

test('F9 他的话里有合法尖括号不许被误杀', () => {
  // 宁少不多:只有"一出现就不可能是他打的字"的体裁才挡
  assert.equal(latestDirectUserText([userMsg('这个 <div> 怎么不居中?')]),
    '这个 <div> 怎么不居中?')
  assert.equal(latestDirectUserText([userMsg('目标：把 F9 修了')]), '目标：把 F9 修了')
})
