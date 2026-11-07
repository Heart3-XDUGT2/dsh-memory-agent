import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { renderPair } from './fixtures/group-dialogue-pair.mjs'
const [{ createTurnSnapshot }] = await Promise.all([import('../lib/turn-snapshot.js')])
const contextFixture = { state: { moodIntensity: 7, prevMoodIntensity: 6,
  emotionVector: { global: { fatigue: 6, valence: 2, arousal: 5 },
    target_master: { affection: 8, playfulness: 7, sadness: 4, dependency: 8 } } },
  profile: { name: '合成主人' }, memoryText: '合成背景', memories: [] }
const envelope = patch => ({ v: 1, platform: 'qq', chat: { id: '33', type: 'group', title: '合成讨论' },
  sender: { id: '22', name: '小周', isMaster: false }, text: '小周，这次日志可归你了。',
  msgId: 'current-' + Math.random(), ts: 100, groupContext: { v: 1, chatId: '33', recent: [
    { messageId: 'earlier', senderId: '44', senderName: '小周', ts: 90, text: '部署日志我来整理。',
      direction: 'incoming', source: 'live' }
  ] }, ...patch })

for (const engineMode of ['baseline', 'python', 'python-down']) {
  test('046 actual host claim -> snapshot -> ' + engineMode + ' JS render distinguishes guest and owner',
    { timeout: 15000 }, async () => {
      const result = await renderPair({ envelope: envelope(), contextFixture: { ...contextFixture, engineMode } })
      assert.equal(result.networkAttempts, 0)
      assert.match(result.baseline.sections.at(-1).text, /对眼前的人\(合成主人\)/)
      assert.match(result.candidate.sections.at(-1).text, /对主人\(合成主人\)的关系/)
      assert.match(result.candidate.sections.at(-1).text, /\[主人的称呼\] 合成主人/)
      assert.match(result.baseline.sections.at(-1).text, /\[他的称呼\] 合成主人/)
      assert.doesNotMatch(result.candidate.sections.at(-1).text, /对眼前的人|看到合成主人来了/)
      assert.ok(result.candidate.audienceProofs.every(Boolean))
      assert.equal(result.candidate.audience.speakers[0].senderId, '22')
      assert.equal(result.candidate.endedAudience, null)
      const texts = result.candidate.messages.flatMap(m => m.content ?? [])
        .filter(b => b.type === 'text').map(b => b.text).join('\n')
      assert.match(texts, /多人群聊现场/)
      assert.match(texts, /部署日志我来整理。/)
      assert.equal(result.candidate.modelRequests, 1)
      assert.equal(result.baseline.modelRequests, 1)
      assert.equal(result.candidate.outboxRows, 0)
      assert.equal(result.candidate.frameKinds.includes('retrieve'), engineMode === 'python')
      assert.equal(result.candidate.retrievalEngines[0], engineMode === 'python' ? 'python' : 'baseline')
      if (process.env.ECHO_046_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.ECHO_046_EVIDENCE_DIR,
        'pair-' + engineMode + '.json'), JSON.stringify(result, null, 2) + '\n')
    })
}

test('046 pair: provided synthetic persona uses the original sections identically in both variants', { timeout: 15000 }, async () => {
  const result = await renderPair({ envelope: envelope(), contextFixture: {
    ...contextFixture, echoPersona: { prefix: '合成Echo：有自己的见解。', suffix: '合成语域：自然表达，保留温度。' },
    groundTruth: '不应进入模型的评价约束'
  } })
  assert.equal(result.provenance.personaIncluded, true)
  assert.deepEqual(result.baseline.personaSections, result.candidate.personaSections)
  const text = JSON.stringify(result.candidate.messages)
  assert.match(text, /合成Echo：有自己的见解/)
  assert.match(text, /合成语域：自然表达/)
  assert.doesNotMatch(text, /不应进入模型的评价约束/)
})
test('046 same actual session and same raw query: group -> private -> other group does not reuse relationship audience',
  { timeout: 15000 }, async () => {
    const result = await renderPair({ envelope: [
      envelope({ msgId: 'g1' }),
      envelope({ msgId: 'p1', chat: { id: '11', type: 'private' },
        sender: { id: '11', name: '合成主人', isMaster: true } }),
      envelope({ msgId: 'g2', chat: { id: '55', type: 'group' },
        groupContext: { v: 1, chatId: '55', recent: [] } })
    ], contextFixture })
    const states = result.candidate.observedAudiences
    assert.equal(states[0].chatId, '33'); assert.equal(states[1], null); assert.equal(states[2].chatId, '55')
    const text = i => result.candidate.turnSections.find(s => s.inputIndex === i).text
    assert.match(text(0), /对主人\(合成主人\)的关系/)
    assert.match(text(1), /对眼前的人\(合成主人\)/)
    assert.match(text(2), /对主人\(合成主人\)的关系/)
  })

test('046 stale asynchronous group snapshot cannot enter a newer private audience with the same sid/query', async () => {
  let release, started
  const gate = new Promise(resolve => { release = resolve }), calls = []
  let audience = { chatType: 'group', chatId: '33', turn: 1,
    speakers: [{ senderId: '22', senderName: '合成群友', isMaster: false }] }
  const session = { id: 'same-synthetic-sid' }, cap = {}
  const snapshot = createTurnSnapshot({ engine: { retrieve: async (_query, _k, options) => {
    calls.push(options); started = true
    if (calls.length === 1) await gate
    return { text: options.groupAudience ? '旧群快照' : '当前私聊快照' }
  } }, store: null, readSettings: () => ({ sharedRounds: 0 }), captureOf: () => cap,
    groupAudienceOf: () => audience })
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '完全相同原话' }] }
  snapshot.noteClaimed(session.id, message)
  const pending = snapshot.compose(session)
  assert.equal(started, true)
  audience = null
  snapshot.noteClaimed(session.id, message)
  release()
  assert.equal(await pending, null)
  assert.match((await snapshot.compose(session)).text, /当前私聊快照/)
  assert.equal(calls.length, 2)
  assert.equal(Object.hasOwn(calls[1], 'groupAudience'), false)
})

test('046 same-query memo distinguishes group audience even without another noteClaimed', async () => {
  let audience = { chatType: 'group', chatId: '33', turn: 1,
    speakers: [{ senderId: '22', senderName: '群友', isMaster: false }] }, reads = 0
  const session = { id: 'synthetic-memo' }
  const snapshot = createTurnSnapshot({ engine: { retrieve: async (_q, _k, options) => {
    reads++; return { text: options.groupAudience ? '群关系' : '私聊关系' }
  } }, store: null, readSettings: () => ({}), captureOf: () => ({}), groupAudienceOf: () => audience })
  snapshot.noteClaimed(session.id, { role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '相同一句' }] })
  assert.match((await snapshot.compose(session)).text, /群关系/)
  audience = null
  assert.match((await snapshot.compose(session)).text, /私聊关系/)
  assert.equal(reads, 2)
})
