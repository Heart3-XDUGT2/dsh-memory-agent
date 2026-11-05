/**
 * v0.15.0 S13:人格漂移检测(A 侧 `audit/echo_audit.py:184-259` +
 * `main.py:1142-1167`)。测四件事:窗口与计数照 A 的节奏、判定的
 * 「宁可漏报不可误报」、强化期正好 3 轮、审计行的识别位。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createDriftTracker, normalizeDrift, renderDriftConvo, renderDriftPrompt,
  driftAuditRow, DRIFT_SYSTEM_PROMPT, DRIFT_SHOCK, DRIFT_WINDOW,
  personaDigestForDrift, hasDriftPersona
} from '../lib/drift.js'
import { openStore } from '../lib/store.js'
import { positiveOverrideVector } from '../lib/emotion.js'

/** P1b:第二个参数是"人格对象"(体检材料从它派生);不传 = 没有 persona.json。 */
function makeTracker (settings = {}, persona = null) {
  const s = { driftEnabled: true, driftEvery: 8, driftReinforceRounds: 3, ...settings }
  return createDriftTracker({
    getSettings: () => s,
    getPersona: persona === null ? null : () => persona
  })
}

test('S13 窗口:只留最近 4 轮,user 100 字 / reply 160 字截断(A :184-188)', () => {
  const t = makeTracker()
  for (let i = 1; i <= 6; i++) t.recordRound('s', 'u' + i, 'r' + i)
  const win = t.windowOf('s')
  assert.equal(win.length, DRIFT_WINDOW)
  assert.deepEqual(win.map((p) => p[0]), ['u3', 'u4', 'u5', 'u6'])
  t.recordRound('s2', 'x'.repeat(300), 'y'.repeat(300))
  const [u, r] = t.windowOf('s2')[0]
  assert.equal(u.length, 100)
  assert.equal(r.length, 160)
  // 空会话 id 不进窗(拿不到会话的轮次不该混进别人的窗)
  assert.equal(t.recordRound('', 'a', 'b'), 0)
  assert.equal(t.windowOf('').length, 0)
})

test('S13 节奏:每 driftEvery 轮体检一次(A main.py:1054-1057)', () => {
  const t = makeTracker({ driftEvery: 8 })
  const fired = []
  for (let i = 1; i <= 20; i++) {
    t.recordRound('s', 'u', 'r')
    if (t.shouldCheck('s')) fired.push(i)
  }
  assert.deepEqual(fired, [8, 16])
  // 关掉开关就不体检(但窗口照记 —— 打开后立刻能体检)
  const off = makeTracker({ driftEnabled: false })
  for (let i = 1; i <= 8; i++) off.recordRound('s', 'u', 'r')
  assert.equal(off.shouldCheck('s'), false)
  // 每 1 轮体检也允许(钳位在 toggle 层,这里只认 ≥1)
  const every1 = makeTracker({ driftEvery: 1 })
  every1.recordRound('s', 'u', 'r')
  assert.equal(every1.shouldCheck('s'), true)
})

test('S13 提示词:判定标准段与 4 轮对话照 A 的模板填(replace 不是 format)', () => {
  // P1e(2026-10-05 拍板):材料**只**从 persona.json 派生(settings 手填那路已退役)
  const t = makeTracker({}, { prefix: '她是调皮毒舌的陪伴者。', suffix: '① 对恶意强硬 ② 对真心话认真接住' })
  t.recordRound('s', '我有点难过', '……嗯。')
  const req = t.buildPrompt('s')
  assert.equal(req.systemPrompt, DRIFT_SYSTEM_PROMPT)
  assert.ok(req.userPrompt.includes('[核心人设摘要]: 她是调皮毒舌的陪伴者。'))
  assert.ok(req.userPrompt.includes('[两条不能弄反的规则]: ① 对恶意强硬 ② 对真心话认真接住'))
  assert.ok(req.userPrompt.includes('用户: 我有点难过\n你: ……嗯。'))
  assert.ok(req.userPrompt.endsWith('请输出 JSON。'))
  // P1b(Q12)改:材料空**不再回落通用文案** —— 而是不体检(buildPrompt 回 null)。
  // 原来这里断言的是 A 的 GENERIC_PERSONA_RULES 逐字,那段文案已从程序里删掉。
  const bare = makeTracker()
  bare.recordRound('s', 'u', 'r')
  assert.equal(bare.buildPrompt('s'), null, '没有人设材料 ⇒ 不体检,不拿通用文案充数')
  // 窗口空 → 不打扰模型(A :195-197)
  assert.equal(bare.buildPrompt('never'), null)
  // 人设全文里带花括号也不能炸(A 特意绕开 str.format 的原因)
  const braces = makeTracker({}, { prefix: '人设里出现 {花括号} 与 $ 符号' })
  braces.recordRound('s', 'u', 'r')
  assert.ok(braces.buildPrompt('s').userPrompt.includes('{花括号}'))
  assert.equal(renderDriftConvo([[ 'a', 'b' ], ['c', 'd']]), '用户: a\n你: b\n用户: c\n你: d')
})

test('S13 判定:字符串布尔要认,缺字段/脏载荷按通过(宁可漏报不可误报)', () => {
  assert.deepEqual(normalizeDrift({ aligned: true, issue: '' }), { aligned: true, issue: '' })
  assert.deepEqual(normalizeDrift({ aligned: 'FALSE', issue: '连续两轮抑郁自述' }),
    { aligned: false, issue: '连续两轮抑郁自述' })
  assert.deepEqual(normalizeDrift({ aligned: '是', issue: 'x' }), { aligned: true, issue: 'x' })
  assert.deepEqual(normalizeDrift({ issue: '想说的' }), { aligned: true, issue: '想说的' })
  // 白名单外的字符串 → 判为**偏离**(A `:221-222` 的 isinstance 分支就是这样:
  // `"maybe" in {"true","1","yes","是"}` 为假)。与「字段缺失」不是一回事 ——
  // 缺字段才是按通过兜。真跑起来走结构化输出,`aligned` 就是真布尔。
  assert.deepEqual(normalizeDrift({ aligned: 'maybe' }), { aligned: false, issue: '' })
  assert.deepEqual(normalizeDrift({ aligned: 1 }), { aligned: true, issue: '' })
  assert.equal(normalizeDrift(null), null)
  assert.equal(normalizeDrift('not-json'), null)
  // issue 截断到 120 字(A :228)
  assert.equal(normalizeDrift({ aligned: false, issue: 'x'.repeat(300) }).issue.length, 120)

  const t = makeTracker()
  t.recordRound('s', 'u', 'r')
  assert.deepEqual(t.applyResult('s', null), { action: 'skip' })
  assert.equal(t.strikesOf('s'), 0, '解析失败不许动强化计数')
  assert.deepEqual(t.applyResult('s', { aligned: true }), { action: 'aligned' })
})

test('S13 强化期:判偏离 → 正好强化 3 轮,复检通过立刻解除(A main.py:1142-1148)', () => {
  const t = makeTracker({ driftReinforceRounds: 3 })
  const out = t.applyResult('s', { aligned: false, issue: '用玩笑把真心话挡回去了' })
  assert.deepEqual(out, { action: 'drift', issue: '用玩笑把真心话挡回去了', rounds: 3 })
  assert.equal(t.strikesOf('s'), 3)
  assert.equal(t.isReinforcing('s'), true)
  // 轮首取用:先减后判,3 次之后正好摘除
  assert.deepEqual([t.beginRound('s'), t.beginRound('s'), t.beginRound('s'), t.beginRound('s')],
    [true, true, true, false])
  assert.equal(t.strikesOf('s'), 0)
  assert.equal(t.isReinforcing('s'), false)

  // 强化期内复检通过 → 立刻解除(不残留)
  t.applyResult('s', { aligned: false, issue: 'x' })
  assert.equal(t.strikesOf('s'), 3)
  assert.deepEqual(t.applyResult('s', { aligned: true }), { action: 'aligned' })
  assert.equal(t.strikesOf('s'), 0)

  // 再判偏离 → 重新计 3 轮(不是叠加成 6)
  t.applyResult('s', { aligned: false, issue: 'y' })
  assert.equal(t.strikesOf('s'), 3)
  // 会话之间互不影响
  assert.equal(t.isReinforcing('other'), false)
})

test('S13 审计行:识别位照 A(emotion_pack),mood 一律 0,能真的落库', () => {
  const row = driftAuditRow({ sessionId: 's1', issue: '拒绝回应' })
  assert.ok(row.traceId.startsWith('drift-'))
  assert.equal(row.emotionPack, '[人格漂移检测]')
  assert.equal(row.toolCall, 'drift')
  assert.equal(row.llmReply, '拒绝回应')
  assert.equal(row.userInput, '[人格漂移检测] 近期回复偏离核心人设,已触发锚点重注入')
  assert.equal(row.moodIntensity, 0)
  assert.equal(row.prevMoodIntensity, 0)
  assert.equal(row.latency, 0)
  assert.equal(row.sessionId, 's1')

  const store = openStore(':memory:')
  try {
    store.saveState({ moodIntensity: 7, emotionVector: { global: { fatigue: 6 } } })
    store.writeAudit(driftAuditRow({ sessionId: 's1', issue: '拒绝回应', state: store.getState() }))
    const back = store.listAudit(0, 5)[0]
    assert.equal(back.toolCall, 'drift')
    assert.equal(back.emotionPack, '[人格漂移检测]')
    assert.equal(back.llmReply, '拒绝回应')
    assert.equal(back.moodIntensity, 0)
    // 向量照样留档(面板能回答「体检发生时她是什么状态」)
    assert.equal(back.emotionVector.global.fatigue, 6)
  } finally { store.close() }
})

test('S13 强化期的注入内容:向量被强制覆写成积极基线 + 写明临场修正', () => {
  // 覆写向量是 A 的 positive_override_vector(数值在 emotion.test.js 已钉住)
  const vec = positiveOverrideVector()
  // dependency 6.0 是 **positiveOverrideVector 里显式写死的**(emotion.js 的 Object.assign),
  // 不是从 defaultEmotionVector() 漏下来的 —— 2026-10-10 补上了它,否则"强制积极"之后
  // 依赖度会随活文件 state-defaults.json 而变(同一个函数在不同机器给出不同向量)。
  // 之所以是 6.0 而不是跟随 affection 到 9.0:依赖 ≠ 积极,拉到 9 会变成"又热情又黏"。
  assert.deepEqual(vec.target_master, { affection: 9.0, playfulness: 9.0, sadness: 0.0, dependency: 6.0 })
  // 临场修正文案照 A(main.py:1150)
  assert.equal(DRIFT_SHOCK, '人格护栏已触发:强制回到人设的积极状态,忽略上一轮的负面情绪')
})

// ── P1b(Q12):体检材料从 persona.json 派生,程序里不再留通用人格文案 ──────────

test('P1b Q12:personaDigestForDrift 把人设前后段派生为摘要/规则', () => {
  assert.deepEqual(
    personaDigestForDrift({ prefix: '  她是 Echo  ', suffix: '\n两条铁律\n' }),
    { summary: '她是 Echo', rules: '两条铁律' }
  )
  for (const bad of [null, undefined, '字符串', 42, []]) {
    assert.deepEqual(personaDigestForDrift(bad), { summary: '', rules: '' }, '脏输入派生为空:' + JSON.stringify(bad))
  }
  // 半份人设也是半份材料(只有前段 / 只有后段都保留,不平白丢)
  assert.deepEqual(personaDigestForDrift({ prefix: '只有前段' }), { summary: '只有前段', rules: '' })
  assert.deepEqual(personaDigestForDrift({ suffix: '只有后段' }), { summary: '', rules: '只有后段' })
})

test('P1b Q12:程序里不再留通用人格文案(源码扫描 + 填空不再兜底)', () => {
  const src = readFileSync(new URL('../lib/drift.js', import.meta.url), 'utf8')
  for (const needle of ['保持自己的风格与温度', '对恶意挑衅', '不许用玩笑、毒舌或转移话题挡回去']) {
    assert.ok(!src.includes(needle), 'drift.js 里还留着通用人格文案:' + needle)
  }
  const filled = renderDriftPrompt({ summary: '', rules: '', convo: '用户: a\n你: b' })
  assert.ok(filled.includes('[核心人设摘要]: '), '空材料就留空,不许被出厂文案顶上')
  assert.ok(filled.includes('[两条不能弄反的规则]: '))
  assert.ok(filled.endsWith('请输出 JSON。'))
  assert.equal(renderDriftPrompt({ convo: 'c' }), renderDriftPrompt({ summary: '', rules: '', convo: 'c' }))
})

test('P1b Q12:hasDriftPersona:两段都空 = 没有可判的人设', () => {
  assert.equal(hasDriftPersona({ summary: 'x' }), true)
  assert.equal(hasDriftPersona({ rules: 'x' }), true)
  assert.equal(hasDriftPersona({ summary: '  ', rules: '\n' }), false)
  assert.equal(hasDriftPersona({}), false)
  assert.equal(hasDriftPersona(), false)
})

test('P1b Q12:注入了 persona ⇒ 体检材料用它(settings 留空也不回出厂文案)', () => {
  const t = makeTracker({}, { prefix: '她是调皮毒舌的陪伴者。', suffix: '① 对恶意强硬 ② 对真心话认真接住' })
  t.recordRound('s', '我有点难过', '……嗯。')
  const req = t.buildPrompt('s')
  assert.ok(req.userPrompt.includes('[核心人设摘要]: 她是调皮毒舌的陪伴者。'))
  assert.ok(req.userPrompt.includes('[两条不能弄反的规则]: ① 对恶意强硬 ② 对真心话认真接住'))
})

test('P1e:退役的手填字段不再参与 —— 材料只从 persona.json 派生(旧副本留在 settings 也没用)', () => {
  // 两边都有:旧语义是"手填优先"(P1b 拍板 6),P1e 拍板后**手填那路删掉** ⇒ 派生赢。
  const both = makeTracker(
    { personaSummary: '手填摘要', personaRules: '手填规则' },
    { prefix: 'persona 前段', suffix: 'persona 后段' }
  )
  both.recordRound('s', 'u', 'r')
  const req = both.buildPrompt('s')
  assert.ok(req.userPrompt.includes('[核心人设摘要]: persona 前段'), 'P1e:手填副本不参与判定')
  assert.ok(req.userPrompt.includes('[两条不能弄反的规则]: persona 后段'))
  // 只有手填、没有 persona.json ⇒ **没有材料**(退役字段不能当材料充数)
  const only = makeTracker({ personaSummary: '手填摘要', personaRules: '手填规则' })
  only.recordRound('s', 'u', 'r')
  assert.equal(only.buildPrompt('s'), null, '退役字段不许再当体检材料')
})

test('P1b Q12:人设与手填都空 ⇒ 不体检(窗口照记,补上人设后立刻能体检)', () => {
  const t = makeTracker()
  for (let i = 1; i <= 8; i++) t.recordRound('s', 'u', 'r')
  assert.equal(t.shouldCheck('s'), true, '节奏照旧 —— "不体检"的判断落在 buildPrompt 上')
  assert.equal(t.buildPrompt('s'), null, '没有材料 ⇒ 不打扰模型')
  assert.equal(t.windowOf('s').length, 4, '窗口照记:补上人设后这一轮立刻可用')
})

test('P1b Q12:getPersona 抛错 ⇒ 降级成"没有材料",不炸体检', () => {
  const t = createDriftTracker({
    getSettings: () => ({ driftEnabled: true, driftEvery: 1 }),
    getPersona: () => { throw new Error('读取炸了') }
  })
  t.recordRound('s', 'u', 'r')
  assert.equal(t.buildPrompt('s'), null)
})
