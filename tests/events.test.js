/**
 * v0.5.2 「SSE 半推」(M3-c):审计流真推送的离线电池。
 * events.js 依赖全注入(store 真件 + res 假件),不碰宿主 ——
 * 对齐先例:宿主 HMR 事件流(handler 写头即返回,close 收尾)。
 *
 * v0.9.1 追加:宿主 SessionEvent 形状防回归闸。根因:SessionEvent =
 * { type, seq, time, data }(dsh-session types.d.ts)—— user/message
 * 的 data 就是 UserMessage 本体,assistant/message 的消息体在
 * data.message。旧代码按自猜的 { type, message } 取值,两头落空,
 * session/event 全链路(捕获/反思/想念削减/情绪更新/心跳路由/
 * 范围标记)在 live 空转了整个 M2→M9 时代。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { openStore, MASTER_ID } from '../lib/store.js'
import { createEchoEvents } from '../lib/events.js'
import { messageOfEvent } from '../lib/session-events.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freshStore () {
  const store = openStore(':memory:')
  store.db.prepare("INSERT INTO user_profile (user_id, name) VALUES (?, '阿岚')").run(MASTER_ID)
  return store
}

/** 假 res:收集写入,模拟 close 生命周期。 */
function fakeRes () {
  const writes = []
  let onClose = null
  return {
    writes,
    destroyed: false,
    writeHead (status, headers) { writes.push({ kind: 'head', status, headers }) },
    write (s) { writes.push({ kind: 'data', text: String(s) }) },
    on (ev, fn) { if (ev === 'close') onClose = fn },
    emitClose () { if (onClose) onClose() },
    destroy () { this.destroyed = true; this.emitClose() }
  }
}

const dataTexts = (res) => res.writes.filter((w) => w.kind === 'data').map((w) => w.text)
const auditEvents = (res) => dataTexts(res).filter((t) => t.startsWith('event: audit'))

test('连接握手:写 SSE 头 + 注释行,不重放历史', () => {
  const store = freshStore()
  try {
    store.writeAudit({
      traceId: 't1', userInput: '旧事', llmReply: '', moodIntensity: 3,
      prevMoodIntensity: 3, emotionVector: {}, toolCall: 'extract'
    })
    const events = createEchoEvents({ store, intervalMs: 30 })
    const res = fakeRes()
    events.attach(res)
    const head = res.writes[0]
    assert.equal(head.kind, 'head')
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-type'], 'text/event-stream')
    assert.ok(dataTexts(res).includes(': connected\n\n'))
    // 游标 = 连接时最新:旧行不推
    assert.equal(auditEvents(res).length, 0)
    events.dispose()
  } finally { store.close() }
})

test('增量推送:新审计行落库 → 3s 内推 audit 事件(带计数与游标)', async () => {
  const store = freshStore()
  try {
    const events = createEchoEvents({ store, intervalMs: 30 })
    const res = fakeRes()
    events.attach(res)
    await sleep(70) // 一两个空转周期:确认无增量不推
    assert.equal(auditEvents(res).length, 0)
    store.writeAudit({
      traceId: 't2', userInput: '新事', llmReply: '', moodIntensity: 3,
      prevMoodIntensity: 3, emotionVector: {}, toolCall: 'extract'
    })
    store.writeAudit({
      traceId: 't3', userInput: '更新的新事', llmReply: '', moodIntensity: 3,
      prevMoodIntensity: 3, emotionVector: {}, toolCall: 'care'
    })
    await sleep(70)
    const evts = auditEvents(res)
    assert.equal(evts.length, 1) // 一个窗口一批,不逐行刷屏
    const payload = JSON.parse(evts[0].match(/^event: audit\ndata: (.*)\n\n$/)[1])
    assert.equal(payload.count, 2)
    assert.ok(payload.upTo > 0)
    // 之后没有更多增量 → 不再推
    await sleep(70)
    assert.equal(auditEvents(res).length, 1)
    events.dispose()
  } finally { store.close() }
})

test('连接关闭:close 事件清定时器,连接集回收', async () => {
  const store = freshStore()
  try {
    const events = createEchoEvents({ store, intervalMs: 30 })
    const res = fakeRes()
    events.attach(res)
    res.emitClose() // 浏览器断开
    store.writeAudit({
      traceId: 't4', userInput: 'x', llmReply: '', moodIntensity: 3,
      prevMoodIntensity: 3, emotionVector: {}, toolCall: 'extract'
    })
    await sleep(70)
    assert.equal(auditEvents(res).length, 0) // 关了就不再收
    events.dispose()
  } finally { store.close() }
})

test('插件卸载:dispose 销毁所有活连接(destroy 触发 close 链)', async () => {
  const store = freshStore()
  try {
    const events = createEchoEvents({ store, intervalMs: 30 })
    const a = fakeRes()
    const b = fakeRes()
    events.attach(a)
    events.attach(b)
    events.dispose()
    assert.equal(a.destroyed, true)
    assert.equal(b.destroyed, true)
    // dispose 后再写也不推(定时器已清)
    store.writeAudit({
      traceId: 't5', userInput: 'x', llmReply: '', moodIntensity: 3,
      prevMoodIntensity: 3, emotionVector: {}, toolCall: 'extract'
    })
    await sleep(70)
    assert.equal(auditEvents(a).length, 0)
    assert.equal(auditEvents(b).length, 0)
  } finally { store.close() }
})

// ---- v0.9.1 宿主事件形状(防回归闸)----

const userMsg = (text, source = { kind: 'user' }) => ({
  role: 'user',
  content: [{ type: 'text', text }],
  source
})

test('宿主形状:user/message 的 data 就是 UserMessage 本体', () => {
  const ev = { type: 'user/message', seq: 7, time: 1695000000000, data: userMsg('echo下线') }
  const msg = messageOfEvent(ev)
  assert.equal(msg.content[0].text, 'echo下线')
  assert.equal(msg.source.kind, 'user')
})

test('宿主形状:assistant/message 的消息体在 data.message', () => {
  const ev = {
    type: 'assistant/message', seq: 8, time: 1695000001000,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '……哼,知道了。' }] } }
  }
  const msg = messageOfEvent(ev)
  assert.equal(msg.content[0].text, '……哼,知道了。')
})

test('边界:非消息事件 → null;旧形状兜底仍在', () => {
  assert.equal(messageOfEvent({ type: 'turn/end', data: { turn: 1, reason: 'end' } }), null)
  assert.equal(messageOfEvent(null), null)
  // 历史自猜形状(旧测试与文档可能出现):message 字段兜底
  const legacy = { type: 'user/message', message: userMsg('旧形状') }
  assert.equal(messageOfEvent(legacy).content[0].text, '旧形状')
})

// ---- v0.18.2 C6:想念削减不许被"长文"绕过(纪律闸)----

test('纪律:v0.18.2 起想念削减不再有 2000 字豁免,长文也照常捕获', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // ① 想念那一帧:不许再有长度豁免,改成截 400 字(削满系数 40 字即饱和)
  const at = src.indexOf('engine.longingMessage(')
  assert.ok(at > 0, '找不到想念帧的调用点')
  const pre = src.slice(Math.max(0, at - 800), at)
  assert.equal(pre.includes('length <= 2000'), false,
    '长度豁免会把贴长文的想念削减整条绕过去(A 侧无条件调)')
  const call = src.slice(at, at + 300)
  assert.ok(call.includes('text.slice(0, 400)'),
    '削满系数 40 字就饱和,所以截 400 字(10 倍饱和点)送帧 —— 数学中性')
  // ② 捕获那一处:长文要**截断捕获**,不许整轮丢掉(丢了会话/反思/漂移
  //    三处都看不见这一轮)
  const capLine = src.split('\n').find((l) => l.includes('capture.userText = text'))
  assert.ok(capLine, '找不到用户正文捕获点')
  assert.ok(capLine.includes('slice(0, 2000)'), '长文该截断捕获,不是整轮丢')
})

// ---- v0.19.0 D2:轮末硬保证的挂点纪律(参考实现的血泪)----

test('纪律:agent/turn-stopping 的注册被 try/catch 包住(抛错会炸整轮)', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const at = src.indexOf("ctx.on('agent/turn-stopping'")
  assert.ok(at > 0, '找不到 agent/turn-stopping 的挂点')
  // 钩子在轮**内部**运行:任何抛错都会炸掉整轮(丢的是整轮 = 丢用户的回复)。
  // 所以挂点必须自己兜住 —— 外壳 try/catch + handle() 内部再一层。
  const around = src.slice(Math.max(0, at - 400), at + 900)
  assert.ok(around.includes('try {'), '挂点外壳必须有 try')
  assert.ok(around.includes('catch'), '挂点外壳必须有 catch(降级,不炸轮)')
  const stopper = readFileSync(new URL('../lib/turn-stopping.js', import.meta.url), 'utf8')
  assert.ok(stopper.includes('} catch (err) {'),
    'handle() 内部也要整体 try/catch —— 降级只许丢一句想念,不许丢回复')
})

test('纪律:轮末硬保证的判定在引擎侧(壳不许自己算阈值)', () => {
  const stopper = readFileSync(new URL('../lib/turn-stopping.js', import.meta.url), 'utf8')
  assert.ok(stopper.includes('pre.threshold') || stopper.includes('pre.due'),
    '阈值/到期要读引擎给的字段(与 should_care 同源同数学)')
  const py = readFileSync(new URL('../python/engine/longing.py', import.meta.url), 'utf8')
  assert.ok(py.includes('def due_snapshot'), '引擎侧要有判定快照')
  assert.ok(py.includes('care_threshold(conn, cfg=cfg)'),
    'due_snapshot 必须复用 care_threshold(心境调制 + 下限 4.5)')
})
