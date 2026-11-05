import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const sandbox = {}
new Function('globalThis', readFileSync(new URL('../web/mock/final/background-events.js', import.meta.url), 'utf8'))(sandbox)
const model = sandbox.EchoBackgroundEvents
const row = (toolCall, extra = {}) => ({ toolCall, timestamp: 1701000000, ...extra })
const field = (event, module, label) => event.modules.find(m => m.title === module).fields.find(f => f.label === label)
const value = (event, module, label) => field(event, module, label).value
const missing = String.fromCharCode(0x2014)

test('正常日记仅凭严格日期关联，摘要与全文独立，保留来源', () => {
  const event = model.project(row('diary', { stage: 'diary', step: 90, userInput: '(日记补写) 2024-02-29', llmReply: '独立审计摘要', moodIntensity: 0, stageDetail: '{"diaryDate":"2024-02-29"}' }))
  assert.equal(event.diaryDate, '2024-02-29')
  assert.deepEqual(event.modules.map(m => m.title), ['触发', '处理', '产出'])
  assert.equal(value(event, '处理', '审计摘要'), '独立审计摘要')
  assert.equal(value(event, '处理', '该行情绪强度'), '0')
  assert.equal(field(event, '触发', '日记日期').source, 'stageDetail.diaryDate')
  assert.equal(value(event, '触发', '触发说明'), '补写（该行明确标记）')
  assert.equal(value(event, '处理', '模型 / 素材 / 耗时'), missing)
  assert.equal(event.links.length, 2)
  assert.equal('start' in event, false)
  assert.equal('duration' in event, false)
})

test('旧日记不从时间、摘要或补写说明猜日期；坏JSON与缺字段分开', () => {
  for (const stageDetail of [undefined, '', '{broken', '[]', '{"diaryDate":"2023-02-29"}', '{"diaryDate":"2024-02-29\\n"}']) {
    const event = model.project(row('diary', { userInput: '(日记补写) 2024-02-29', llmReply: '2024-02-29 摘要', stageDetail }))
    assert.equal(event.diaryDate, null)
    assert.equal(value(event, '产出', '日记关联'), '未关联日记，仅保留审计摘要')
  }
  assert.equal(model.project(row('diary')).detailState, 'missing')
  assert.equal(model.project(row('diary', { stageDetail: '{broken' })).detailState, 'invalid')
  assert.equal(model.project(row('diary', { stageDetail: '{}' })).detailState, 'valid')
})

test('整固只展示保存的计数/夜窗/游标，0和false保留，不替代成记忆全文', () => {
  const event = model.project(row('reflection', { userInput: '(记忆整固·夜窗)', stageDetail: JSON.stringify({ importance: 0, candidates: 2, items: 3, written: 0, merged: 1, agenda: 0, cursorAdvanced: false, reason: '暂无新条目' }) }))
  assert.equal(value(event, '触发', '触发标记'), '夜窗')
  assert.equal(value(event, '触发', '累计情感'), '0')
  assert.equal(value(event, '触发', '候选条数'), '2')
  assert.equal(value(event, '处理', '整理条数'), '3')
  assert.equal(value(event, '产出', '写成'), '0')
  assert.equal(value(event, '产出', '合并'), '1')
  assert.equal(value(event, '产出', '待跟进'), '0')
  assert.equal(value(event, '产出', '游标推进'), '否')
  assert.equal(value(event, '产出', '结果原因'), '暂无新条目')
  assert.equal(value(event, '处理', '模型输入'), missing)
})

test('衰减仅取当次变化和保存向量，不推算之前值', () => {
  const event = model.project(row('emotion_decay', { stageDetail: JSON.stringify({ hours: 0.5, delta: { closeness: 0, mood: -0.2 } }), emotionVector: { closeness: 4, mood: 0 } }))
  assert.equal(value(event, '触发', '间隔（小时）'), '0.5')
  assert.equal(value(event, '产出', '本次变化'), 'closeness：0\nmood：-0.2')
  assert.equal(value(event, '产出', '该行保存的向量'), 'closeness：4\nmood：0')
  assert.equal(value(event, '产出', '衰减前向量'), missing)
})

test('清理只解析严格计数，不泄露或读取manifest', () => {
  const event = model.project(row('session-reaper', { llmReply: 'reaped=0 kept=7 unknown=0 freed=2048B turns=8 boundary=1700000000000 manifest=C:\\private\\manifest.jsonl' }))
  assert.deepEqual(event.modules[2].fields.map(f => f.value), ['0', '7', '0', '2048'])
  assert.equal(value(event, '处理', '轮数边界'), '8')
  assert.equal(value(event, '处理', '时间边界（毫秒）'), '1700000000000')
  assert.equal(JSON.stringify(event).includes('manifest'), false)
  const bad = model.project(row('session-reaper', { llmReply: 'reaped=-1 kept=2oops unknown=null freed=4 turns=- boundary=-' }))
  assert.deepEqual(bad.modules[2].fields.map(f => f.value), [missing, missing, missing, missing])
})

test('人际打分准确区分失败、跳过、门槛不足、已判定和未判定', () => {
  for (const [tag, expected] of [['失败', '失败'], ['跳过', '跳过'], ['门槛不足', '跳过'], ['已判定', '已判定'], ['', '未判定']]) {
    const event = model.project(row('ipc-appraise', { userInput: tag ? '(人际打分·' + tag + ')' : '', llmReply: tag === '已判定' ? 'other={"name":"隐藏"} gain=0 gate=hold' : '原因记录' }))
    assert.equal(event.status, expected)
    assert.equal(value(event, '产出', '判定状态'), expected)
    assert.equal(value(event, '产出', '增益'), tag === '已判定' ? '0' : missing)
    assert.equal(value(event, '产出', '门控'), tag === '已判定' ? 'hold' : missing)
    assert.equal(JSON.stringify(event).includes('隐藏'), false)
    assert.equal(JSON.stringify(event).includes('已更新关系'), false)
  }
})

test('提取产出来自图账，助手原回复不冒充提取产物', () => {
  const event = model.project(row('extract', { userInput: '该次素材', llmReply: '助手原回复不作为提取产物', stageDetail: JSON.stringify({ triplesRaw: 3, triplesSchemaRejected: 0, triplesRejected: 1, triplesWritten: 2, learned: 0, graphError: '一次处理错误', dropReasons: [{ reason: '不可归因', subject: '不要展示原始对象' }, '未通过条件'] }) }))
  assert.equal(value(event, '触发', '当时素材'), '该次素材')
  assert.equal(value(event, '处理', '原始三元组'), '3')
  assert.equal(value(event, '处理', '格式拒绝'), '0')
  assert.equal(value(event, '处理', '拒绝条数'), '1')
  assert.equal(value(event, '产出', '写入三元组'), '2')
  assert.equal(value(event, '产出', '学习条数'), '0')
  assert.equal(value(event, '产出', '丢弃原因'), '不可归因\n未通过条件')
  assert.equal(JSON.stringify(event).includes('助手原回复'), false)
  assert.equal(JSON.stringify(event).includes('不要展示原始对象'), false)
})

test('两类失败记录保留失败事实与重试说明，不假称成功', () => {
  const diary = model.project(row('diary_fail', { userInput: '(日记组稿失败) 第 2 次', llmReply: '退避 4 分钟后重试' }))
  assert.equal(diary.status, '失败')
  assert.equal(diary.diaryDate, null)
  assert.equal(value(diary, '处理', '失败记录'), '(日记组稿失败) 第 2 次')
  assert.equal(value(diary, '产出', '重试说明'), '退避 4 分钟后重试')
  const reflection = model.project(row('reflection_failed', { llmReply: '引擎未回应' }))
  assert.equal(reflection.status, '失败')
  assert.equal(value(reflection, '处理', '失败原因'), '引擎未回应')
  assert.equal(value(reflection, '产出', '写成'), missing)
})

test('null、空串、缺字段、坏数值不转成0；真实0保留', () => {
  for (const v of [null, '', undefined, false, '0', NaN]) {
    const e = model.project(row('reflection', { stageDetail: { written: v, candidates: v } }))
    assert.equal(value(e, '产出', '写成'), missing)
    assert.equal(value(e, '触发', '候选条数'), missing)
  }
  assert.equal(value(model.project(row('reflection', { stageDetail: { written: 0 } })), '产出', '写成'), '0')
})

test('多事件保留实际行数与逐行来源；混合管线extract不复制', () => {
  const rows = [row('diary'), row('reflection'), row('emotion_decay')]
  const pure = model.ofTurn({ rows })
  assert.equal(pure.pure, true)
  assert.equal(pure.rowCount, 3)
  assert.deepEqual(pure.events.map(e => [e.kind, e.rowIndex]), [['diary', 0], ['reflection', 1], ['emotion_decay', 2]])
  const mixed = model.ofTurn({ rows: [row('relay_in'), row('extract', { step: 6 }), row('emotion_decay')] }, [{ rowIndex: 0, outsider: false }, { rowIndex: 1, outsider: false }, { rowIndex: 2, outsider: true }])
  assert.equal(mixed.pure, false)
  assert.equal(mixed.rowCount, 3)
  assert.deepEqual(mixed.events.map(e => [e.kind, e.rowIndex]), [['emotion_decay', 2]])
  assert.equal(model.ofTurn({ rows: [row('read')] }).events.length, 0)
  assert.equal(model.ofTurn({ rows: [] }).pure, false)
  assert.equal(model.ofTurn({ rows: [row('extract', { step: 6, stage: 'extract' })] }, [{ rowIndex: 0, outsider: false }]).events.length, 0)
})

test('类型工具优先，来源会话不改事件或范围归组', () => {
  assert.equal(model.kindOf(row('reflection_failed', { stage: 'reflection' })), 'reflection_failed')
  assert.equal(model.kindOf(row('read', { stage: 'diary' })), '')
  assert.equal(model.kindOf({ stage: 'diary' }), 'diary')
  const a = model.project(row('diary', { sessionId: 'fixture-a' }))
  const b = model.project(row('diary', { sessionId: 'fixture-b' }))
  assert.deepEqual(a, b)
})

test('公历校验严格；安全显示不截普通长文段落但收口路径ID和JSON', () => {
  for (const valid of ['0001-01-01', '2000-02-29', '2400-02-29', '9999-12-31']) assert.equal(model.dateValid(valid), true)
  for (const invalid of ['0000-01-01', '1900-02-29', '2100-02-29', '2024-04-31', '2024-2-29', '2024-02-29\n', ' 2024-02-29', '2024-13-01']) assert.equal(model.dateValid(invalid), false)
  const long = '同一前缀。'.repeat(150) + '\n\n独立尾部。'
  assert.equal(model.safe(long), long)
  assert.equal(model.safe('["raw", {"value": 1}]'), '（原始字段已隐藏）')
  const secret = 'C:\\private\\file.txt\n' + 'session-' + '1234abcd' + ' 12345678-1234-1234-1234-123456789abc\n{"private":1}'
  const safe = model.safe(secret)
  assert.equal(/[A-Za-z]:\\|session-[0-9a-f]{8}|[0-9a-f]{8}-|\{"/u.test(safe), false)
})
