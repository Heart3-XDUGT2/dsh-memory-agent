/**
 * v0.18.1 C1 认账条款的离线电池。
 *
 * A 侧出处:`main.py:1855-1900 _build_proactive_line`(v8.8.0「主动消息不进对话历史」根修:
 * 主动消息不进对话历史,没有这条她会翻脸不认自己刚说的话)。
 * 这里钉三件事:①措辞逐字;②她主动说过 → 取得到原文;③他回过一轮 → 自然消失。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore, MASTER_ID, PROACTIVE_ROUND_MARKER } from '../lib/store.js'
import { ageText, renderProactiveAckLine, buildProactiveAck, SPEAKING_TOOL_CALLS } from '../lib/proactive-ack.js'

const NOW = () => Date.now() / 1000

function freshStore () {
  const store = openStore(':memory:')
  store.db.prepare("INSERT INTO user_profile (user_id, name) VALUES (?, '阿岚')").run(MASTER_ID)
  return store
}

test('认账条款:措辞逐字照 A 侧(含 80 字截断与「刚才 / N分钟前」分档)', () => {
  const line = renderProactiveAckLine('醒了没。昨晚陪你修到三点多,记得吃点东西', 30)
  assert.equal(line,
    '\n【你刚主动说过】刚才你主动说:「醒了没。昨晚陪你修到三点多,记得吃点东西」'
    + '——这是你亲口说的,用户现在回应的就是这句话,先对上话头再往下聊;'
    + '记不起具体细节就如实说你一直惦记这事,不许否认自己说过,'
    + '也不许编造细节。')
  assert.ok(renderProactiveAckLine('x', 185).startsWith('\n【你刚主动说过】3分钟前你主动说:'))
  // 空文本 = 没有这一行
  assert.equal(renderProactiveAckLine('', 10), '')
  assert.equal(renderProactiveAckLine('   ', 10), '')
  // 80 字截断(A 侧 text[:80])
  const long = renderProactiveAckLine('あ'.repeat(120), 5)
  assert.ok(long.includes('「' + 'あ'.repeat(80) + '」'))
  assert.ok(!long.includes('あ'.repeat(81)))
  assert.equal(ageText(59.9), '刚才')
  assert.equal(ageText(60), '1分钟前')
  assert.equal(ageText(600), '10分钟前')
})

test('认账条款:她最后一条是主动说的 → 取她那句话 + 真实时长', () => {
  const store = freshStore()
  try {
    store.writeConversation({
      sessionId: 'sess-1', channel: 'QQ·私聊',
      userText: PROACTIVE_ROUND_MARKER,
      replyText: '醒了没。昨晚陪你修到三点多,记得吃点东西'
    })
    store.db.prepare('UPDATE conversation_log SET created_at = ?').run(NOW() - 240)
    const line = buildProactiveAck({
      store, sessionId: 'sess-1', now: NOW(), marker: PROACTIVE_ROUND_MARKER
    })
    assert.ok(line.startsWith('\n【你刚主动说过】4分钟前你主动说:「醒了没。'))
    assert.ok(line.includes('不许否认自己说过'))
  } finally { store.close() }
})

test('认账条款:他回过一轮 → 这一行自然消失(A 侧「她认过账就不再唠叨」)', () => {
  const store = freshStore()
  try {
    store.writeConversation({
      sessionId: 'sess-1', userText: PROACTIVE_ROUND_MARKER, replyText: '想你了,忙完了吗'
    })
    assert.ok(buildProactiveAck({ store, sessionId: 'sess-1', now: NOW(), marker: PROACTIVE_ROUND_MARKER }) !== '')
    // 他回了一句(轮末落库,末行变成对话轮)
    store.writeConversation({ sessionId: 'sess-1', userText: '刚忙完', replyText: '那就好' })
    assert.equal(
      buildProactiveAck({ store, sessionId: 'sess-1', now: NOW(), marker: PROACTIVE_ROUND_MARKER }),
      '',
      '认过账之后不该再唠叨')
  } finally { store.close() }
})

test('认账条款兜底:对话记录丢了也能从审计里捞回她那句话', () => {
  const store = freshStore()
  try {
    // 现场形状:relay 出站审计的 user_input 是「[标签] 正文」
    store.writeAudit({
      traceId: 'a1', sessionId: 'global', userKey: MASTER_ID,
      userInput: '[QQ·私聊] 醒了没。昨晚陪你修到三点多',
      toolCall: 'relay_proactive', llmReply: ''
    })
    // writeAudit 的时间戳由它自己写(不接受注入),落库后再改成"2 分钟前"
    store.db.prepare('UPDATE audit_logs SET timestamp = ? WHERE trace_id = ?').run(NOW() - 120, 'a1')
    const line = buildProactiveAck({
      store, sessionId: 'sess-1', now: NOW(), marker: PROACTIVE_ROUND_MARKER
    })
    assert.ok(line.startsWith('\n【你刚主动说过】2分钟前你主动说:「醒了没。'))
    assert.ok(!line.includes('[QQ·私聊]'), '标签是审计的内部格式,不许进她的视野')
  } finally { store.close() }
})

test('认账条款兜底:审计行有 llm_reply 时优先用它(A 侧读的就是这一列)', () => {
  const store = freshStore()
  try {
    store.writeAudit({
      traceId: 'a2', sessionId: 'global', userKey: MASTER_ID,
      userInput: '(想念主动关怀)', toolCall: 'care',
      llmReply: '外面下雨了,带伞'
    })
    store.db.prepare('UPDATE audit_logs SET timestamp = ? WHERE trace_id = ?').run(NOW() - 30, 'a2')
    const line = buildProactiveAck({
      store, sessionId: 'sess-1', now: NOW(), marker: PROACTIVE_ROUND_MARKER
    })
    assert.ok(line.includes('你主动说:「外面下雨了,带伞」'))
  } finally { store.close() }
})

test('认账条款:太老的主动话不算(10 分钟外不许装作刚说过)', () => {
  const store = freshStore()
  try {
    store.writeAudit({
      traceId: 'a3', sessionId: 'global', userKey: MASTER_ID,
      userInput: '[QQ] 很久以前那句', toolCall: 'relay_proactive',
      llmReply: ''
    })
    store.db.prepare('UPDATE audit_logs SET timestamp = ? WHERE trace_id = ?').run(NOW() - 3600, 'a3')
    assert.equal(
      buildProactiveAck({ store, sessionId: 'sess-1', now: NOW(), marker: PROACTIVE_ROUND_MARKER }),
      '')
    // 什么都没有时同样是空串(她没主动说过,就不许提)
    assert.equal(buildProactiveAck({ store, sessionId: 'sess-2', now: NOW(), marker: PROACTIVE_ROUND_MARKER }), '')
  } finally { store.close() }
})

test('认账条款:store 缺席 / 会话为空时安全返回空串(不炸整轮注入)', () => {
  assert.equal(buildProactiveAck({ store: null, sessionId: 'sess-1' }), '')
  const store = freshStore()
  try {
    assert.equal(buildProactiveAck({ store, sessionId: '', now: NOW() }), '')
    assert.equal(buildProactiveAck({ store, sessionId: 'sess-9', now: NOW() }), '')
  } finally { store.close() }
})

/**
 * 2026-10-10 回归:**并行支观测行被当成"她说过的话"**。
 *
 * 现场:2026-10-09「期 0 并行支观测」给每一支写一条审计
 * (`lib/index.js:2337-2361`,tool_call = arm 名、session_id = 真实会话),
 * 而旧兜底只判 `toolCall !== ''` ⇒ 命中它 ⇒ 渲染出
 * 「你刚主动说过:(并行支 same_turn_emotion) 起跑 2026-10-09T16:16:31Z」
 * 外加"用户现在回应的就是这句话"(而那是内部事件)。
 *
 * 活库实证(2026-10-10):`same_turn_emotion` 共 9 行,原文与上面逐字一致。
 */
test('2026-10-10 回归:并行支起跑行不许被当成"她主动说过"', () => {
  const store = freshStore()
  try {
    store.writeAudit({
      traceId: 'arm-1', sessionId: 'sess-1', userKey: MASTER_ID,
      userInput: '(并行支 same_turn_emotion) 起跑 2026-10-10T09:38:13.497Z',
      llmReply: '', toolCall: 'same_turn_emotion'
    })
    store.db.prepare('UPDATE audit_logs SET timestamp = ? WHERE trace_id = ?').run(NOW() - 20, 'arm-1')
    assert.equal(
      buildProactiveAck({ store, sessionId: 'sess-1', now: NOW(), marker: PROACTIVE_ROUND_MARKER }),
      '', '内部观测行不是她说的话 ⇒ 这一行不该出现')
    // 白名单本身也要钉住:并行支 arm 名不在里面
    assert.equal(SPEAKING_TOOL_CALLS.includes('same_turn_emotion'), false)
    assert.equal(SPEAKING_TOOL_CALLS.includes('query_expand'), false)
  } finally { store.close() }
})

test('2026-10-10:其它非"她开口"的 tool_call 同样不许命中(黑名单一定会漏)', () => {
  const store = freshStore()
  try {
    // 抽取产物 / 工具调用 / 内部注记 / 日记 —— 都不是"她对他说的那句话"
    const notSpeech = [
      ['structured_output', '(工具) structured_output {"content":"十月九号…"}', ''],
      ['extract', '【QQ·私聊】阿岚说:活爹你怎么讲话要花这么多钱', '发出去了 → QQ:私聊\n\n> 那 Echo 以后说短点嘛。'],
      ['diary', '(她写了日记)', '十月九号。今天阿岚差点把自己弄丢…'],
      ['longing_steer', '想念 8.7 ≥ 5.0 未表达', ''],
      ['care_silent', '(组稿超长 126 字 > 120,照 A 侧规矩沉默) 发出去了 → QQ:私聊', ''],
      ['read', '(工具) read {"file_path":"x"}', 'file contents'],
      ['remind', '(约定到点提醒)', ''],
      ['wake', '(她自己的闹钟到点)', '']
    ]
    for (const [tool, input, reply] of notSpeech) {
      store.writeAudit({
        traceId: 'ns-' + tool, sessionId: 'sess-1', userKey: MASTER_ID,
        userInput: input, llmReply: reply, toolCall: tool
      })
      store.db.prepare('UPDATE audit_logs SET timestamp = ? WHERE trace_id = ?').run(NOW() - 15, 'ns-' + tool)
    }
    assert.equal(
      buildProactiveAck({ store, sessionId: 'sess-1', now: NOW(), marker: PROACTIVE_ROUND_MARKER }),
      '', '这些都不是她说的话')
  } finally { store.close() }
})

test('2026-10-10:纯标记的 care 行不许渲染(剥完注记什么都不剩)', () => {
  const store = freshStore()
  try {
    // care 的正文本该在 llm_reply;只有标记时**不该**把「(想念主动关怀)」当她的话
    store.writeAudit({
      traceId: 'care-marker', sessionId: 'global', userKey: MASTER_ID,
      userInput: '(想念主动关怀)', llmReply: '', toolCall: 'care'
    })
    store.db.prepare('UPDATE audit_logs SET timestamp = ? WHERE trace_id = ?').run(NOW() - 30, 'care-marker')
    assert.equal(
      buildProactiveAck({ store, sessionId: 'sess-1', now: NOW(), marker: PROACTIVE_ROUND_MARKER }),
      '', '纯标记不是她的话')
  } finally { store.close() }
})

test('2026-10-10:她真说过的话仍能正常渲染(白名单内 + 剥掉内部注记)', () => {
  const store = freshStore()
  try {
    // 活库真实形状:relay_out 的 llm_reply 为空,正文在 user_input,带 [QQ:私聊] 前缀
    store.writeAudit({
      traceId: 'ok-1', sessionId: 'sess-1', userKey: MASTER_ID,
      userInput: '[QQ:私聊] 那Echo以后说短点嘛。……不过省token可以,省饭钱不行噢。',
      llmReply: '', toolCall: 'relay_out'
    })
    store.db.prepare('UPDATE audit_logs SET timestamp = ? WHERE trace_id = ?').run(NOW() - 60, 'ok-1')
    const line = buildProactiveAck({ store, sessionId: 'sess-1', now: NOW(), marker: PROACTIVE_ROUND_MARKER })
    assert.ok(line.includes('你主动说:「那Echo以后说短点嘛。'), line)
    assert.ok(!line.includes('[QQ:私聊]'), '标签是审计内部格式,不许进她的视野')

    // echo_qq_say:`(用 QQ 说)<正文>` ⇒ 前缀也要剥掉
    const store2 = freshStore()
    try {
      store2.writeAudit({
        traceId: 'ok-2', sessionId: 'global', userKey: MASTER_ID,
        userInput: '(用 QQ 说)记得吃饭', llmReply: '', toolCall: 'echo_qq_say'
      })
      store2.db.prepare('UPDATE audit_logs SET timestamp = ? WHERE trace_id = ?').run(NOW() - 30, 'ok-2')
      const l2 = buildProactiveAck({ store: store2, sessionId: 'sess-1', now: NOW(), marker: PROACTIVE_ROUND_MARKER })
      assert.ok(l2.includes('你主动说:「记得吃饭」'), l2)
      assert.ok(!l2.includes('(用 QQ 说)'), '内部注记不许进她的视野')
    } finally { store2.close() }
  } finally { store.close() }
})
