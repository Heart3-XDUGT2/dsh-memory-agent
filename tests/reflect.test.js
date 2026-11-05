import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshotCapture, stampOf, runReflection, runRawExtract, REFLECTION_SCHEMA } from '../lib/reflect.js'
import { PROACTIVE_ROUND_MARKER } from '../lib/store.js'

test('v0.14.2 排队快照:补跑时不许被槽位清理吃掉', () => {
  // 现场事故:轮末处理器在 fireReflect 之后就地清空 capture ——
  // 忙时排队存的是同一个对象引用,等当前反思跑完(慢模型 3 分钟)
  // 补跑时只剩空串,被空捕获闸静默吞掉。一晚上 4 轮全丢。
  const live = {
    userText: '我喜欢吃什么啊',
    assistantText: '章鱼小丸子。',
    lastInjected: '[她的记忆与心情]',
    sessionId: 's-1',
    agent: { session: { id: 's-1' } },
    longingRead: Promise.resolve(null),
    graphHits: new Set([1, 2])
  }
  const snap = snapshotCapture(live)
  // 轮末清理:槽位被清空(现实里紧接着 fireReflect 就发生)
  live.userText = ''
  live.assistantText = ''
  live.lastInjected = ''
  live.longingRead = null
  live.graphHits = null
  assert.equal(snap.userText, '我喜欢吃什么啊', '快照必须留住内容')
  assert.equal(snap.assistantText, '章鱼小丸子。')
  assert.equal(snap.lastInjected, '[她的记忆与心情]')
  assert.equal(snap.sessionId, 's-1')
  assert.equal(snap.agent, live.agent, 'agent 句柄按引用带走(宿主契约要它)')
  // 快照不带队列不该管的字段(想念读/图命中各有自己的生命周期)
  assert.equal('longingRead' in snap, false)
  assert.equal('graphHits' in snap, false)
})

test('v0.14.2 快照的缺省是空串而不是 undefined', () => {
  // 空捕获闸读的是 snap.userText/.assistantText —— 缺省必须是假值,
  // 不能因为字段缺失就抛。v0.14.5 S10 又添了两件审计辅助
  // (profileSnapshot / startedAt),缺省同样要安全。
  // (v0.29.0:渠道维度随群聊拒收退役,快照不再带 channel 字段。)
  // (2026-10-19:多了 `qzoneComment` —— 空间评论那一格,缺省同样要安全;
  //  它是**独立一格**,不并进 userText,理由见 snapshotCapture 的注释。)
  const snap = snapshotCapture(undefined)
  assert.deepEqual(snap, {
    userText: '', assistantText: '', qzoneComment: '', lastInjected: '', profileSnapshot: '',
    startedAt: 0, sessionId: '', turnTrace: '', turnTraceCaptured: false, agent: null
  })
  assert.equal(snapshotCapture({ userText: null, agent: 0 }).agent, 0)
})

test('F2 时间锚格式(信封第二行的唯一来源)', () => {
  assert.equal(stampOf(new Date(2026, 8, 24, 23, 13, 31).getTime()),
    '2026-09-24 23:13:31 周四')
})

// ---- v0.14.4 移植缺口 S1:反思整固的壳侧一半 ----

const PARENT = { session: { id: 'reflect-test' } }

/** 录制型假子代理:把交给模型的提示词原样留下,供断言。 */
function recSubagents (structured, sink) {
  return {
    list: () => ['spawn'],
    start: async (provider, req) => {
      if (req?.parent === undefined) throw new Error('mock: 缺 parent(宿主契约)')
      if (typeof req?.signal?.aborted !== 'boolean') throw new Error('mock: 缺真 signal(宿主契约)')
      sink.prompt = (Array.isArray(req.prompt) ? req.prompt : [])
        .map((b) => String(b?.text ?? '')).join('\n')
      sink.schema = req.outputSchema
      sink.label = req.label
      return {
        result: Promise.resolve({ stopReason: 'completed', structured }),
        dispose: async () => { }
      }
    }
  }
}

test('S1 runReflection:引擎给的 system/user 原样进提示词,schema 是整固契约', async () => {
  const sink = {}
  const out = await runReflection(recSubagents({ items: [] }, sink), {
    systemPrompt: '你是记忆整固模块(Reflection)。',
    userPrompt: '[待整固的记忆](编号|层次|情感分|摘要):\n#7|普通|情感7|他昨晚熬夜',
    parent: PARENT
  })
  assert.deepEqual(out, { items: [] })
  assert.ok(sink.prompt.startsWith('你是记忆整固模块(Reflection)。'))
  assert.ok(sink.prompt.includes('[待整固的记忆]'))
  assert.equal(sink.label, 'echo-reflection')
  assert.equal(sink.schema, REFLECTION_SCHEMA)
  // 空 items 是合法载荷(引擎侧推游标 —— 「没有值得提炼的就输出空列表」)
  assert.ok(REFLECTION_SCHEMA.properties.items.type === 'array')
})

test('S1 runReflection:失败一律 null —— 壳据此不 commit(游标不动)', async () => {
  // 子代理服务不在:不抛,回 null
  assert.equal(await runReflection(undefined, { systemPrompt: 'x', userPrompt: 'y', parent: PARENT }), null)
  // 没有可用 provider
  assert.equal(await runReflection({ list: () => [], start: async () => { throw new Error('不该被调到') } },
    { systemPrompt: 'x', userPrompt: 'y', parent: PARENT }), null)
  // 模型没跑完 / 没有结构化输出(宿主契约的两种失败形态)
  for (const result of [{ stopReason: 'aborted' }, { stopReason: 'completed' }]) {
    const sub = {
      list: () => ['spawn'],
      start: async () => ({ result: Promise.resolve(result), dispose: async () => { } })
    }
    assert.equal(await runReflection(sub, { systemPrompt: 'x', userPrompt: 'y', parent: PARENT }), null)
  }
  // start 抛错(缺 parent/signal 的历史事故形态)→ 上抛给调用方,由 tick 的 catch 兜
  await assert.rejects(() => runReflection({
    list: () => ['spawn'],
    start: async () => { throw new Error('mock: 缺 parent(宿主契约)') }
  }, { systemPrompt: 'x', userPrompt: 'y', parent: undefined }))
})

// ---- v0.14.5 S11:主动轮哨兵在反思信封里的渲染 ----

test('S11 转写:主动轮渲染成【她主动开口】,不伪造用户发言行', async () => {
  const sink = {}
  const out = await runRawExtract(recSubagents({ summary: '' }, sink), {
    userText: PROACTIVE_ROUND_MARKER,
    assistantText: '刚看到你桌上有药,胃又疼了?',
    prevVector: { global: { fatigue: 6 } },
    parent: PARENT,
    sessionId: 'sess-1',
    nowMs: new Date(2026, 8, 25, 2, 10).getTime(),
    recentTurns: [
      { user: '我先去睡了', assistant: '嗯,睡吧' },
      { user: PROACTIVE_ROUND_MARKER, assistant: '刚看到你桌上有药,胃又疼了?' }
    ]
  })
  assert.equal(out.summary, '')
  assert.ok(sink.prompt.includes('第 2 轮:\n【她主动开口】她: 刚看到你桌上有药,胃又疼了?'))
  // 关键:不能出现「用户：(她主动开口)」这种假发言行(模型会把她的话算你说的)
  assert.equal(sink.prompt.includes('用户：(她主动开口)'), false)
  assert.equal(sink.prompt.includes('用户：(她主动开口) '), false)
  // 普通轮照旧
  assert.ok(sink.prompt.includes('第 1 轮：\n用户：我先去睡了\nAI：嗯,睡吧'))
  // 主动轮那行不该带 AI 标签(她就是开口的那一方)
  const proactiveLine = sink.prompt.split('\n').find((l) => l.includes('【她主动开口】'))
  assert.ok(proactiveLine.startsWith('【她主动开口】她: '))
})

// ---- v0.41.0 事故修复:子代理不许再起子代理 ----

test('v0.41.0 runStructured:parent 是子代理会话 ⇒ 不起子代理,回 null(总闸门)', async () => {
  // 这是「子代理不断产生新的子代理」那条无限递归的总闸:所有结构化调用
  // (EXTRACT / 整固 / 情绪打分 / 漂移体检)都从 runStructured 出去。
  const calls = []
  const subagents = {
    list: () => ['spawn'],
    start: async () => { calls.push('start'); throw new Error('不该走到这里') }
  }
  const subAgent = { session: { id: 'sub-1', header: { origin: 'subagent', parentSession: 'p', delegationDepth: 1 } } }
  assert.equal(await runReflection(subagents, { systemPrompt: 'x', userPrompt: 'y', parent: subAgent }), null)
  assert.equal(await runRawExtract(subagents, { userText: 'a', assistantText: 'b', parent: subAgent }), null)
  assert.deepEqual(calls, [], 'subagents.start 一次都不许被调到 —— 那一趟就是递归的下一环')
})

test('v0.41.0 顶层 parent 照旧放行(闸不许误伤他那一边)', async () => {
  const sink = {}
  const out = await runReflection(recSubagents({ items: [] }, sink), {
    systemPrompt: '你是记忆整固模块(Reflection)。',
    userPrompt: 'x',
    parent: { session: { id: 'companion', header: { delegationDepth: 0 } } }
  })
  assert.deepEqual(out, { items: [] })
  assert.ok(sink.prompt.startsWith('你是记忆整固模块(Reflection)。'))
})
