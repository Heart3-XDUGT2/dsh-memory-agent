import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseExpansion, clampExpandTimeoutMs, expandPrompt, expandOnce, createQueryExpander,
  normalizeQueryKey, EXPAND_SCHEMA, EXPAND_DEFAULT_TIMEOUT_MS, EXPAND_DEFAULT_MAX_TERMS
} from '../lib/query-expand.js'
import { createTurnSnapshot } from '../lib/turn-snapshot.js'

test('RT11b:模型产出必须先过清洗(去原话/去重/限长/限数)', () => {
  const user = '他跑校园跑有什么要求'
  const got = parseExpansion({ terms: ['跑步', '跑步', '打卡', '校园跑', '这是一个特别特别长的词元不应该要', '', '里程'] },
    { userText: user, maxTerms: 4 })
  assert.deepEqual(got, ['跑步', '打卡', '里程', '学校任务'].slice(0, 3).concat([]), '原话里的词与超长词都要丢')
  assert.equal(got.length, 3)
})

test('RT11b:模型给不出东西时不许凑数(空/怪形状一律当"没有")', () => {
  assert.deepEqual(parseExpansion(null), [])
  assert.deepEqual(parseExpansion({ terms: '不是数组' }), [])
  assert.deepEqual(parseExpansion([]), [])
  assert.deepEqual(parseExpansion({ nope: 1 }), [])
})

test('RT11b:超时旋钮坏值回落默认(宁可不扩展,不许拖慢回复)', () => {
  assert.equal(clampExpandTimeoutMs(0), EXPAND_DEFAULT_TIMEOUT_MS)
  assert.equal(clampExpandTimeoutMs('胡说'), EXPAND_DEFAULT_TIMEOUT_MS)
  assert.equal(clampExpandTimeoutMs(999999), 8000)
  assert.equal(clampExpandTimeoutMs(500), 500)
})

test('RT11b:schema 是"只认 terms"的严格形状(宿主按它校验,多一个键就会被拒)', () => {
  assert.equal(EXPAND_SCHEMA.additionalProperties, false)
  assert.deepEqual(EXPAND_SCHEMA.required, ['terms'])
  assert.ok(expandPrompt({ userText: 'x' }).includes('只输出 JSON'))
  assert.equal(normalizeQueryKey('  a\n b  '), 'a b')
})

test('RT11b:并起一次调用,取走即删(取不到 ⇒ 检索照旧走)', async () => {
  const calls = []
  const ex = createQueryExpander({
    run: (prompt, schema) => { calls.push(prompt); return Promise.resolve({ terms: ['跑步', '打卡'] }) },
    now: () => 1000
  })
  await ex.begin('s1', { userText: '他跑校园跑有什么要求' })
  const got = ex.take('s1', '他跑校园跑有什么要求')
  assert.deepEqual(got.terms, ['跑步', '打卡'])
  assert.equal(ex.take('s1', '他跑校园跑有什么要求'), null, '取走即删')
  assert.equal(ex.stats().applied, 1)
  assert.equal(calls.length, 1)
})

test('RT11b:同一句问两遍 ⇒ 走缓存不重复调模型', async () => {
  let n = 0
  const ex = createQueryExpander({ run: () => { n += 1; return Promise.resolve({ terms: ['学校'] }) } })
  await ex.begin('s1', { userText: '他上的是哪所大学' })
  ex.take('s1', '他上的是哪所大学')
  await ex.begin('s2', { userText: '他上的是哪所大学' })
  const second = ex.take('s2', '他上的是哪所大学')
  assert.equal(n, 1, '第二次不该再调模型')
  assert.deepEqual(second.terms, ['学校'])
  assert.equal(ex.stats().cacheHit, 1)
})

test('RT11b:超时与失败都记账,且这一轮照常过(不许把她的话卡住)', async () => {
  const slow = createQueryExpander({
    run: () => new Promise(() => {}),   // 永不返回
    getTimeoutMs: () => 1000
  })
  const r = await expandOnce({ run: () => new Promise(() => {}), userText: 'x', timeoutMs: 60 })
  assert.equal(r.timedOut, true)
  assert.equal(r.ok, false)
  const bad = createQueryExpander({ run: () => Promise.reject(new Error('炸')) })
  await bad.begin('s1', { userText: '他上的是哪所大学' })
  assert.equal(bad.take('s1', '他上的是哪所大学'), null)
  assert.equal(bad.stats().failed, 1)
  const none = createQueryExpander({})
  await none.begin('s1', { userText: 'x' })
  assert.equal(none.stats().skippedNoRun, 1)
  assert.equal(slow.stats().started, 0)
})

// ---- 2026-10-10:onSettle 抛异常必须留痕 ----
// 现场:`query_expand` 恒 0 行,而五条出口看起来全都正常调了 onSettle。
// 以前这里是空 `catch { }` ⇒ 回调抛了就被静默吞掉:**行不落、也没有一句话**。
// 这与 same_turn_emotion 缺 raw 是同一类病 —— 看不见的失败。

test('审计留痕:onSettle 抛错 ⇒ 不许静默,logger.warn 必须被调到', async () => {
  const warns = []
  const logger = { warn: (m) => warns.push(String(m)) }

  // ① 正常 settle 出口
  const ex = createQueryExpander({ run: async () => ({ terms: ['学校'] }), logger })
  await ex.begin('s1', { userText: '他上的是哪所大学', onSettle: () => { throw new Error('审计炸了') } })
  assert.equal(warns.length, 1, 'settle 出口的回调抛了必须留痕')
  assert.ok(warns[0].includes('query_expand'), '日志要认出是哪一支')
  assert.ok(warns[0].includes('审计炸了'), '要带上真实原因,不是一句"出错了"')

  // ② 早退出口(empty_query)—— 这条以前最容易静默
  const ex2 = createQueryExpander({ run: async () => ({ terms: [] }), logger })
  await ex2.begin('s2', { userText: '   ', onSettle: () => { throw new Error('早退也炸') } })
  assert.equal(warns.length, 2, '早退出口也要留痕')
  assert.ok(warns[1].includes('empty_query'), '要指明是哪条早退路径')

  // ③ 没有 logger 时不许反过来把这一轮弄崩
  const ex3 = createQueryExpander({ run: async () => ({ terms: ['x'] }) })
  const r3 = await ex3.begin('s3', { userText: '随便什么', onSettle: () => { throw new Error('没人接') } })
  assert.deepEqual(r3, ['x'], '留痕失败绝不影响返回值')
})

test('审计留痕:onSettle 抛错不影响统计与这一轮的产出', async () => {
  const logger = { warn: () => { throw new Error('连日志都炸') } }  // logger 自己抛
  const ex = createQueryExpander({ run: async () => ({ terms: ['学校'] }), logger })
  const got = await ex.begin('s1', { userText: '他上的是哪所大学', onSettle: () => { throw new Error('x') } })
  assert.deepEqual(got, ['学校'], 'logger 抛了也不许把这一轮弄坏')
  assert.equal(ex.stats().started, 1)
  assert.equal(ex.stats().failed, 0)
})

// ══════════════════════════════════════════════════════════════════════
// ★★ 2026-10-21：**串轮隐患**（这一轮唯一的交付物）
// ══════════════════════════════════════════════════════════════════════
//
// 现场：`pending` 按 **sid** 存，`take(sid)` **不校验是不是同一句问话**。
//
// 只要扩展"迟到"一次（本轮 `take()` 已经过去了它才 resolve），它就会躺在
// `pending` 里，被**下一轮**的 `take()` 取走，当成下一轮那句话的扩展词元
// 送进检索 ⇒ **静默用错词**（不报错、不记日志，只是召回的东西不对）。
//
// 现在线上 100% 超时**恰好掩盖**了这条路（terms 永远空、pending 永远不写）。
// 而唯一能让扩展成功的办法就是放开容量/超时 —— 那正好会引爆它。
// **所以顺序必须是：先堵雷，再放容量。**

const Q_RUN = '他跑校园跑有什么要求'
const Q_UNI = '他上的是哪所大学'

test('① ★★ 迟到不许串轮：q1 的扩展迟到，绝不许喂给 q2', async () => {
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const ex = createQueryExpander({
    run: async () => { await gate; return { terms: ['跑步', '打卡'] } }
  })

  const p = ex.begin('s1', { userText: Q_RUN })      // 起跑，但**还没 settle**
  assert.equal(ex.take('s1', Q_UNI), null, '还没 settle ⇒ 取不到（这条本来就对）')

  release()                                          // 现在 q1 才 settle（= 迟到了）
  await p

  // ★ 关键：q1 的词**绝不许**被 q2 取走
  assert.equal(ex.take('s1', Q_UNI), null,
    '★ 旧写法这里会拿到 ["跑步","打卡"] —— 那是上一句的扩展词，喂错轮 = 静默用错词')

  // 而且那条不匹配的已经被**丢弃**了（不留着等下一轮再被误用）
  assert.equal(ex.take('s1', Q_RUN), null, '不匹配那次已经把它丢掉（这正是设计）')
  assert.equal(ex.stats().applied, 0, '一次都没真正交付过')
})

test('② ★★ 同句正常交付：begin(q) → settle → take(sid, q)', async () => {
  const ex = createQueryExpander({ run: async () => ({ terms: ['跑步', '打卡'] }) })

  await ex.begin('s1', { userText: Q_RUN })
  const got = ex.take('s1', Q_RUN)

  assert.ok(got, '同句必须交付（加 key 校验不是把功能关掉）')
  assert.deepEqual(got.terms, ['跑步', '打卡'])
  assert.equal(got.fromCache, false)
  assert.equal(ex.stats().applied, 1, '真正交付才 +1')
})

test('③ ★★ cacheHit 那条路**也必须带 key**（漏了 ⇒ 扩展永远交付不了）', async () => {
  let n = 0
  const ex = createQueryExpander({ run: async () => { n += 1; return { terms: ['学校'] } } })

  await ex.begin('s1', { userText: Q_UNI })
  ex.take('s1', Q_UNI)                       // 第一次正常取走
  await ex.begin('s2', { userText: Q_UNI })   // 同句 ⇒ 走 cacheHit
  assert.equal(n, 1, '第二次没再调模型（走了缓存）')
  assert.equal(ex.stats().cacheHit, 1)

  const got = ex.take('s2', Q_UNI)
  assert.ok(got,
    '★ 缓存命中必须能交付 —— 漏了 key 的话这里会是 null，'
    + '所有缓存命中都被 take 拒收，扩展从此永远交付不了')
  assert.deepEqual(got.terms, ['学校'])
  assert.equal(got.fromCache, true)
})

test('③′ cacheHit 的条目也**不许串给别的句子**', async () => {
  const ex = createQueryExpander({ run: async () => ({ terms: ['学校'] }) })
  await ex.begin('s1', { userText: Q_UNI })
  ex.take('s1', Q_UNI)
  await ex.begin('s1', { userText: Q_UNI })   // cacheHit ⇒ pending 里又有一条
  assert.equal(ex.take('s1', Q_RUN), null, '★ 缓存命中的条目也不许串给别的句子')
})

test('④ ★ applied 只在**真正交付**时 +1（不匹配的 take 不许让它涨）', async () => {
  const ex = createQueryExpander({ run: async () => ({ terms: ['跑步'] }) })
  await ex.begin('s1', { userText: Q_RUN })

  assert.equal(ex.stats().applied, 0, '还没取过')
  assert.equal(ex.take('s1', '完全不同的一句'), null)
  assert.equal(ex.stats().applied, 0, '★ 不匹配的 take 不许记账（语义要收紧）')

  // 对照：真交付时才涨
  const ex2 = createQueryExpander({ run: async () => ({ terms: ['跑步'] }) })
  await ex2.begin('s1', { userText: Q_RUN })
  assert.ok(ex2.take('s1', Q_RUN))
  assert.equal(ex2.stats().applied, 1)
})

test('⑤ ★ 接线钉子：turnSnapshot 必须把**本轮 query** 递给 expandOf', async () => {
  const seen = []
  const snap = createTurnSnapshot({
    engine: {
      retrieve: async (q) => ({ text: '[记忆] ' + q, graphHits: { hitEdgeIds: [], ltpEdgeIds: [] } })
    },
    store: { listConversations: () => [], getProfile: () => ({ name: '阿柴' }) },
    readSettings: () => ({ injectTopK: 6, sharedRounds: 0 }),
    captureOf: () => ({}),
    readAliases: () => [],
    // 假 expandOf：记录实参，然后返回 null（不真正扩展）
    expandOf: (sid, q) => { seen.push({ sid: String(sid ?? ''), q: String(q ?? '') }); return null },
    logger: {}
  })

  snap.noteClaimed('s1', {
    role: 'user',
    content: [{ type: 'text', text: Q_RUN }],
    source: { kind: 'user' }
  })
  await snap.compose({ id: 's1' })

  assert.equal(seen.length, 1, 'expandOf 要被调到')
  assert.equal(seen[0].sid, 's1')
  assert.equal(seen[0].q, Q_RUN,
    '★ 第二个参数必须是**本轮那句话** —— 不传的话 take 无从校验"是不是同一句"，'
    + '迟到的扩展就会被下一轮误用')
})
