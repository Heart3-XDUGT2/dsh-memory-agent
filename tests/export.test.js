/**
 * v0.15.1 G16:对话导出复现包(A `export_conversation.py`)。
 * 导出是**证据链**:纯函数、无副作用、缺的字段写「(无)」不编 ——
 * 这三条性质就是这里的测试内容。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildExportPack, renderExportMarkdown, exportTime } from '../lib/export.js'

const FIXTURE = {
  meta: { version: '0.15.1', generatedAt: 1789000000000, dataDir: 'D:\\data', dbPath: 'D:\\data\\echo.db' },
  settings: { auditKeep: 100, injectTopK: 6, memoryTtlDays: 30 },
  state: {
    moodIntensity: 6, prevMoodIntensity: 4, userEmotion: 'tired',
    moodReason: '他今天加班到很晚', currentTopic: '加班', updatedAt: 1789999999,
    emotionVector: { global: { fatigue: 4, valence: 3 }, target_master: { affection: 9 } }
  },
  profile: { name: '阿岚', likes: ['咖啡'] },
  audit: [
    {
      traceId: 'b', timestamp: 1789999900, sessionId: 's1', toolCall: '',
      userInput: '今天好累', injectedProfile: '他最近在加班', injectedMemories: [{ summary: '他上周也加班' }],
      emotionPack: '强度 6/10', agentState: { mood: 6 }, emotionVector: { global: { fatigue: 4 } },
      emotionDelta: '整体[疲惫+1]', moodIntensity: 6, prevMoodIntensity: 4, latency: 1.25, llmReply: '那就早点睡'
    },
    {
      traceId: 'a', timestamp: 1789990000, sessionId: 's2', toolCall: 'echo_remember',
      userInput: '(直教记忆)喜欢深烘焙', injectedProfile: '', injectedMemories: [],
      emotionPack: '', agentState: null, emotionVector: null, emotionDelta: '',
      moodIntensity: 4, prevMoodIntensity: 4, latency: null, llmReply: ''
    }
  ],
  threads: { waiting: [{ threadId: 3, content: '面试', followUpAfter: 1790000000, updatedAt: 1789999000 }], due: [], untimed: [], done: [] },
  longing: [{ userId: 'master', value: 3.5, threshold: 7, since: '2 小时前' }],
  health: { active: 12, dormant: 3, archived: 1, temporal: { recent: 8 }, threads: 1 },
  sessions: [{ sessionId: 's1', turns: 2, label: '加班' }],
  filter: { sessionId: '' }
}

test('G16 复现包:升序时间线 + 全套事实字段', () => {
  const pack = buildExportPack(FIXTURE)
  assert.equal(pack.kind, 'dsh-echo-export')
  assert.equal(pack.version, '0.15.1')
  assert.equal(pack.scope, 'all')
  assert.deepEqual(pack.turns.map((t) => t.traceId), ['a', 'b'], '按时间升序讲故事')
  const t = pack.turns[1]
  assert.equal(t.time, exportTime(1789999900))
  assert.equal(t.injectedMemories[0].summary, '他上周也加班')
  assert.equal(t.emotionDelta, '整体[疲惫+1]')
  assert.equal(t.latency, 1.25)
  assert.equal(t.agentState.mood, 6)
  // 没写 latency 的行 → null(而不是 0:0 会被误读成「秒回」)
  assert.equal(pack.turns[0].latency, null)
  assert.equal(pack.settings.injectTopK, 6)
  assert.equal(pack.threads[0].state, 'waiting')
})

test('G16 复现包:会话过滤 + 快照隔离(不改入参)', () => {
  const audit = FIXTURE.audit.map((r) => ({ ...r }))
  const input = { ...FIXTURE, audit: audit, filter: { sessionId: 's1' } }
  const pack = buildExportPack(input)
  assert.equal(pack.scope, 's1')
  assert.deepEqual(pack.turns.map((t) => t.traceId), ['b'])
  assert.equal(audit[0].traceId, 'b', '入参数组顺序不该被就地排序')
  assert.equal(audit.length, 2)
})

test('G16 Markdown:人读版含六段,缺字段写(无)不编', () => {
  const md = renderExportMarkdown(buildExportPack(FIXTURE))
  for (const section of ['# Echo 复现包', '## 她此刻的状态', '## 画像', '## 记忆体检', '## 想念', '## 悬置话题', '## 轮次回放']) {
    assert.ok(md.includes(section), '缺段:' + section)
  }
  assert.ok(md.includes('心情强度: 6/10(上一轮 4)'))
  assert.ok(md.includes('情绪向量: global.fatigue=4, global.valence=3, target_master.affection=9'))
  assert.ok(md.includes('- 他说: 今天好累'))
  assert.ok(md.includes('- 她回: 那就早点睡'))
  assert.ok(md.includes('用时 1.3s') || md.includes('用时 1.25s'), 'latency 要显示出来')
  assert.ok(md.includes('«他上周也加班»'))
  assert.ok(md.includes('#3 [waiting] «面试»'))
  // 空包(全新安装、一句话没说)也要能导出,不炸不编
  const empty = renderExportMarkdown(buildExportPack({}))
  assert.ok(empty.includes('(没有轮次记录'))
  assert.ok(empty.includes('(无)'))
  assert.ok(!empty.includes('undefined'))
})

test('G16 时间:0 → (无),不把 1970 当真实时间', () => {
  assert.equal(exportTime(0), '(无)')
  assert.equal(exportTime(null), '(无)')
  assert.equal(exportTime('x'), '(无)')
  assert.match(exportTime(1789999900), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
})

// 2026-10-06:注入留痕行(组装完提示词就写的那行,tool_call='inject')——
// 导出里要认出它,别读成「她回:(无)」(那会把"她读到了什么"说成"她没说话")。
test('注入留痕行:导出标成「注入留痕」,并写明这不是一轮回复', () => {
  const md = renderExportMarkdown(buildExportPack({
    ...FIXTURE,
    audit: [{
      traceId: 'i1', timestamp: 1789999900, sessionId: 's1', toolCall: 'inject',
      userInput: '今天面试怎么样', injectedProfile: '[他的称呼] 阿岚',
      injectedMemories: '【情景记忆】\n- 他今天面试炸了', llmReply: '',
      emotionPack: '', agentState: null, emotionVector: null, emotionDelta: '',
      moodIntensity: 6, prevMoodIntensity: 4, latency: 0.812
    }]
  }))
  assert.ok(md.includes('### ' + exportTime(1789999900) + ' · 注入留痕 · s1'), '标题要写人话,不写裸工具名')
  assert.ok(md.includes('- 注入记忆(全文):'), '注入块要以文本块原样导出')
  assert.ok(md.includes('- 他今天面试炸了'))
  assert.ok(md.includes('这一行只记'), '别让它读成"她回:(无)"')
  assert.equal(md.includes('- 她回: (无)'), false)
})
