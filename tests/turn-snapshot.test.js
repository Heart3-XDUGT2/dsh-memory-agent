/**
 * A 案(2026-09-26)的电池:记忆/心情快照从「每轮追加一条 user 消息」改成
 * 「系统提示词里的一节」。
 *
 * 这里钉三件事,每件都对应一个真出过问题的现场:
 *   1. **检索拿的是他这一轮说的那句话** —— 组装发生在 `agent/pre-step` 之前,
 *      所以查询词只能在 `agent/inbox/claimed` 记下;如果哪天有人把 compose
 *      改成读「会话里最后一条用户消息」,新鲜度就悄悄退化一轮,这里要红。
 *   2. **我们自己的注入绝不当查询词** —— `form:'snapshot'`/`care` 里的包装
 *      正文回去检索自己,只会把噪声越滚越大(turn-query.js 的纪律)。
 *   3. **老路不许回来** —— index.js 里不能再出现「追加 form:'snapshot' 的
 *      user 消息」;那段代码每轮往 surface 里塞一份、永不回收(现场:62 块
 *      57,105 字),它必须走系统提示词 section 的可替换通道。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PROACTIVE_ROUND_MARKER } from '../lib/store.js'
import {
  createTurnSnapshot, SNAPSHOT_SECTION, SNAPSHOT_ORDER
} from '../lib/turn-snapshot.js'

const userMsg = (text) => ({
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' }
})

// 2026-10-03:注入形状升为"产出者自有"kind(`plugin:dsh-echo`)—— 0.2.0-rc 的 v4
// 会话格式拒绝 `kind:'plugin'`(整轮运行失败);判据容错,新旧都认。
const relayMsg = (rawText, wrapped) => ({
  role: 'user',
  content: [{ type: 'text', text: wrapped }],
  source: { kind: 'plugin:dsh-echo', form: 'relay', rawText }
})

const ourInjection = (form, text) => ({
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'plugin:dsh-echo', form }
})

function fixtures (over = {}) {
  const calls = []
  const hits = [] // 每次 retrieve 返回的图谱边
  const caps = new Map()
  const engine = {
    retrieve: async (query, topK, opts) => {
      calls.push({ query, topK, opts })
      const h = hits.length > 0 ? hits.shift() : { hitEdgeIds: [], ltpEdgeIds: [] }
      if (h === 'throw') throw new Error('sidecar 不在')
      return { text: '[记忆] 关于「' + query + '」', graphHits: h }
    }
  }
  const store = {
    listConversations: () => over.conversations ?? [],
    getProfile: () => ({ name: over.name ?? '阿柴' })
  }
  const snap = createTurnSnapshot({
    engine,
    store: over.store === undefined ? store : over.store,
    readSettings: () => ({ injectTopK: over.injectTopK ?? 6, sharedRounds: over.sharedRounds ?? 0 }),
    captureOf: (session) => {
      let c = caps.get(session)
      if (c === undefined) { c = {}; caps.set(session, c) }
      return c
    },
    readAliases: () => [],
    // 2026-10-06:注入留痕回调(可不给) —— 电池用它验证"一行/轮 + 落原文"
    ...(typeof over.onInject === 'function' ? { onInject: over.onInject } : {}),
    logger: {}
  })
  return { snap, calls, hits, caps, store }
}

test('没 claim 过他的话 → 这一步不注入(不拿旧查询硬凑)', async () => {
  const { snap, calls } = fixtures()
  assert.equal(await snap.compose({ id: 's1' }), null)
  assert.equal(calls.length, 0, '没查询词就不该去检索')
})

test('claim 之后:检索用的是**这一轮刚 claim 的那句话**', async () => {
  const { snap, calls } = fixtures()
  snap.noteClaimed('s1', userMsg('你讲话好难听啊'))
  const r = await snap.compose({ id: 's1' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].query, '你讲话好难听啊', '新鲜度:必须是这一轮他的话')
  assert.equal(calls[0].topK, 6, '注入条数走调参(injectTopK)')
  assert.match(r.text, /你讲话好难听啊/)
})

test('换一轮话,查询词跟着换(不是钉在第一次)', async () => {
  const { snap, calls } = fixtures()
  snap.noteClaimed('s1', userMsg('第一句'))
  await snap.compose({ id: 's1' })
  snap.noteClaimed('s1', userMsg('第二句'))
  await snap.compose({ id: 's1' })
  assert.deepEqual(calls.map((c) => c.query), ['第一句', '第二句'])
  assert.equal(snap.queryOf('s1'), '第二句')
})

test('桥注入的 QQ 那条:查询用他打的 rawText,不是包装正文', async () => {
  const { snap, calls } = fixtures()
  snap.noteClaimed('s1', relayMsg('今天面试炸了', '【QQ·私聊】…说:今天面试炸了\n(回他请用 echo_qq_say…)'))
  await snap.compose({ id: 's1' })
  assert.equal(calls[0].query, '今天面试炸了')
})

test('我们自己的注入不当查询词(否则噪声自己滚自己)', async () => {
  const { snap, calls } = fixtures()
  // 记忆快照、心声——都不是他的话
  snap.noteClaimed('s1', ourInjection('snapshot', '[她的记忆与心情] 【现在】…'))
  snap.noteClaimed('s1', ourInjection('mind', '[ECHO MIND] 她想起他了'))
  assert.equal(await snap.compose({ id: 's1' }), null)
  assert.equal(calls.length, 0)
})

test('会话之间互不串味', async () => {
  const { snap, calls } = fixtures()
  snap.noteClaimed('s1', userMsg('这是 s1 说的话'))
  snap.noteClaimed('s2', userMsg('这是 s2 说的话'))
  await snap.compose({ id: 's1' })
  await snap.compose({ id: 's2' })
  assert.deepEqual(calls.map((c) => c.query), ['这是 s1 说的话', '这是 s2 说的话'])
})

test('检索挂了只丢记忆这一半,不许抛出去打断这一轮', async () => {
  const { snap, hits } = fixtures()
  hits.push('throw')
  snap.noteClaimed('s1', userMsg('随便说点什么'))
  const r = await snap.compose({ id: 's1' })
  // v0.37.0 G3 起:整条没应答不再"整块消失",而是留一句降级说明给**她**看
  // (空表和"查不到"是两件事 —— 她不能以为自己真的没想起来)
  assert.ok(r !== null)
  assert.match(r.text, /\[降级\]/)
  assert.equal(r.memoryText, '', '记忆那一半确实丢了')
})

test('审计字段照旧:lastInjected / profileSnapshot(面板要看)', async () => {
  const { snap, caps } = fixtures({ name: '阿柴' })
  snap.noteClaimed('s1', userMsg('在吗'))
  const session = { id: 's1' }
  const r = await snap.compose(session)
  const cap = caps.get(session)
  assert.equal(cap.lastInjected, r.text)
  assert.equal(cap.profileSnapshot, '[他的称呼] 阿柴')
})

test('本轮想起的图谱边取并集(多步轮不许只剩最后一步)', async () => {
  const { snap, hits, caps } = fixtures()
  hits.push({ hitEdgeIds: ['e1'], ltpEdgeIds: ['L1'] })
  hits.push({ hitEdgeIds: ['e2'], ltpEdgeIds: [] })
  const session = { id: 's1' }
  snap.noteClaimed('s1', userMsg('第一步'))
  await snap.compose(session)
  snap.noteClaimed('s1', userMsg('第二步'))
  await snap.compose(session)
  const g = caps.get(session).graphHits
  assert.deepEqual([...g.hitEdgeIds].sort(), ['e1', 'e2'])
  assert.deepEqual([...g.ltpEdgeIds], ['L1'])
})

test('空文本不落 section(sectionOf 只做形状)', async () => {
  const { snap } = fixtures()
  const s = snap.sectionOf('  ')
  assert.equal(s.name, SNAPSHOT_SECTION)
  assert.equal(s.order, SNAPSHOT_ORDER)
})

test('v0.18.1 C1 接线:他回她主动那句时,注入块里带认账条款', async () => {
  const { snap } = fixtures({
    store: {
      listConversations: () => [],
      getProfile: () => ({ name: '阿柴' }),
      latestConversation: () => ({
        userText: PROACTIVE_ROUND_MARKER,
        replyText: '醒了没。昨晚陪你修到三点多,记得吃点东西',
        createdAt: Date.now() / 1000 - 120
      }),
      listAudit: () => []
    }
  })
  snap.noteClaimed('s1', userMsg('刚醒,你昨晚说啥了'))
  const text = (await snap.compose({ id: 's1' })).text
  assert.ok(text.includes('【你刚主动说过】'), '认账条款要真的进到注入块')
  assert.ok(text.includes('醒了没。昨晚陪你修到三点多'))
  assert.ok(text.includes('不许否认自己说过'))
  // 他回过一轮(末行不再是主动哨兵)→ 下一轮不再带这一行
  const { snap: snap2 } = fixtures({
    store: {
      listConversations: () => [],
      getProfile: () => ({ name: '阿柴' }),
      latestConversation: () => ({ userText: '刚醒', replyText: '那就好', createdAt: Date.now() / 1000 }),
      listAudit: () => []
    }
  })
  snap2.noteClaimed('s1', userMsg('那我先去上课了'))
  const text2 = (await snap2.compose({ id: 's1' })).text
  assert.equal(text2.includes('【你刚主动说过】'), false, '认过账就不再唠叨(A 侧语义)')
})

// ---- v0.35.0 B3:轮内不变快照(同一轮多步只算一次)--------------------------

test('B3:同一轮多步组装 ⇒ 检索只跑一次,她看到的是**同一份**文本', async () => {
  const { snap, calls } = fixtures()
  snap.noteClaimed('s1', userMsg('在忙吗'))
  const session = { id: 's1' }
  const a = await snap.compose(session)
  const b = await snap.compose(session)
  const c = await snap.compose(session)
  assert.equal(calls.length, 1, '一轮三步 ⇒ 一次检索(修前是三次)')
  assert.equal(a, b, '同一份对象(她轮内不会看到自己漂)')
  assert.equal(b.text, c.text)
  assert.equal(snap.stats().reused, 2, '复用次数要能报出来')
})

test('B3:他再开口 = 新的一轮 ⇒ 立刻重算(哪怕这句话一模一样)', async () => {
  const { snap, calls } = fixtures()
  snap.noteClaimed('s1', userMsg('在吗'))
  await snap.compose({ id: 's1' })
  await snap.compose({ id: 's1' })
  assert.equal(calls.length, 1)
  // ⚠️ 新鲜度优先于省钱:同一句话再说一遍也是**新的一轮**(想念行/共享轮次都要重读)
  snap.noteClaimed('s1', userMsg('在吗'))
  await snap.compose({ id: 's1' })
  assert.equal(calls.length, 2, 'claim 必须让快照失效')
})

test('B3:"没什么可注入"的轮也钉住(否则每步都白跑一趟引擎)', async () => {
  const { snap, calls } = fixtures()
  // 让检索返回空文本 ⇒ 共享/残句/认账都空 ⇒ compose 给 null
  snap.noteClaimed('s1', userMsg('嗯'))
  const empty = createTurnSnapshot({
    engine: { retrieve: async (query) => { calls.push({ query }); return { text: '', graphHits: null } } },
    store: { listConversations: () => [], getProfile: () => ({ name: '阿柴' }) },
    readSettings: () => ({ injectTopK: 6, sharedRounds: 0 }),
    captureOf: () => ({}),
    readAliases: () => [],
    logger: {}
  })
  empty.noteClaimed('s1', userMsg('嗯'))
  assert.equal(await empty.compose({ id: 's1' }), null)
  assert.equal(await empty.compose({ id: 's1' }), null)
  assert.equal(calls.length, 1, '空结果也只算一次')
})

test('B3:forget(会话清空)⇒ 缓存一起清掉,别把旧快照留给下一轮', async () => {
  const { snap, calls } = fixtures()
  snap.noteClaimed('s1', userMsg('睡了吗'))
  await snap.compose({ id: 's1' })
  snap.forget('s1')
  assert.equal(snap.stats().cached, 0)
  assert.equal(await snap.compose({ id: 's1' }), null, '查询词也忘了 ⇒ 不注入')
  assert.equal(calls.length, 1, '忘了之后不该再有旧快照可用')
})

test('B3:复用不重复累加图谱边(集合天然去重,但别再往上叠一份)', async () => {
  const { snap, hits, caps } = fixtures()
  hits.push({ hitEdgeIds: ['e1'], ltpEdgeIds: ['L1'] })
  const session = { id: 's1' }
  snap.noteClaimed('s1', userMsg('第一步'))
  await snap.compose(session)
  await snap.compose(session)
  await snap.compose(session)
  const g = caps.get(session).graphHits
  assert.deepEqual([...g.hitEdgeIds], ['e1'])
  assert.deepEqual([...g.ltpEdgeIds], ['L1'])
})

// ---- v0.37.0 G2/G3:旧称呼改写 + 降级要说话 --------------------------------

test('G3:引擎整条没应答 ⇒ 注入块里带 [降级] 标注(以前是静默少一段)', async () => {
  const calls = []
  const snap = createTurnSnapshot({
    engine: { retrieve: async () => { calls.push(1); return null } },
    store: { listConversations: () => [], getProfile: () => ({ name: '阿柴' }) },
    readSettings: () => ({ injectTopK: 6, sharedRounds: 0 }),
    captureOf: () => ({}),
    readAliases: () => [],
    logger: {}
  })
  snap.noteClaimed('s1', userMsg('在吗'))
  const r = await snap.compose({ id: 's1' })
  assert.ok(r !== null, '降级也要说一句 —— 不许整块消失')
  assert.match(r.text, /\[降级\]/)
  assert.match(r.text, /没有应答/, '要写清是哪一种降级')
  assert.equal(r.degraded, true, '降级要有标志位(审计/面板看得见)')
})

test('G3:走本地兜底(引擎不在)⇒ 另一种降级标注,不是"没有应答"', async () => {
  const snap = createTurnSnapshot({
    engine: { retrieve: async () => ({ engine: 'baseline', text: '[记忆] 本地兜底搜到的两条' }) },
    store: { listConversations: () => [], getProfile: () => ({ name: '阿柴' }) },
    readSettings: () => ({ injectTopK: 6, sharedRounds: 0 }),
    captureOf: () => ({}),
    readAliases: () => [],
    logger: {}
  })
  snap.noteClaimed('s1', userMsg('在吗'))
  const r = await snap.compose({ id: 's1' })
  assert.match(r.text, /\[降级\].*本地兜底/)
  assert.equal(r.degraded, true)
  assert.match(r.text, /本地兜底搜到的两条/, '兜底搜到的东西仍然给她')
})

test('G3:引擎好好的 ⇒ 一个字都不多(不许无中生有)', async () => {
  const { snap } = fixtures()
  snap.noteClaimed('s1', userMsg('在吗'))
  const r = await snap.compose({ id: 's1' })
  assert.equal(r.degraded, false)
  assert.equal(r.text.includes('[降级]'), false)
})

test('G2:记忆里的旧称呼被改写成现在的称呼,而**共享轮次/他的话一个字不改**', async () => {
  const snap = createTurnSnapshot({
    engine: {
      retrieve: async () => ({ engine: 'python', text: '[记忆] 阿柴说他今天面试炸了' })
    },
    store: {
      listConversations: () => [{
        sessionId: 'other', userText: '阿柴你听着', replyText: '我在', createdAt: Date.now() / 1000
      }],
      getProfile: () => ({ name: '阿澈' })
    },
    readSettings: () => ({ injectTopK: 6, sharedRounds: 3 }),
    captureOf: () => ({}),
    readAliases: () => [],
    readRetiredAliases: () => ['阿柴'],
    logger: {}
  })
  snap.noteClaimed('s1', userMsg('在吗'))
  const r = await snap.compose({ id: 's1' })
  assert.ok(r.memoryText.includes('阿澈说他今天面试炸了'), '记忆那一块按现在的称呼写')
  assert.equal(r.aliasFixed, 1, '改了几处要报出来')
  assert.ok(r.sharedText.includes('阿柴你听着'), '⚠️他自己说过的话一个字不许改(改历史比叫错名字严重)')
})

test('纪律:index.js 里老路(追加 user 消息的快照)必须已经搬走', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.equal(src.includes("form: 'snapshot'"), false,
    'index.js 里不该再有 form:\'snapshot\' 的注入 —— 那条路每轮追加一份、永不回收')
  assert.match(src, /ctx\.on\('system-prompt\/assemble'/, '快照要走组装瀑布')
  assert.match(src, /ctx\.on\('agent\/inbox\/claimed'/, '查询词要在 claim 那一刻记下(组装之前)')
  // pre-step 钩子里不许再出现检索 —— 它已经搬进组装
  const hookAt = src.indexOf("ctx.on('agent/pre-step'")
  const hookEnd = src.indexOf("'echo.preStep()'", hookAt)
  assert.ok(hookAt > 0 && hookEnd > hookAt, '找不到 pre-step 钩子')
  const hook = src.slice(hookAt, hookEnd)
  assert.equal(hook.includes('engine.retrieve'), false, 'pre-step 里不该再检索记忆')
})

// ── 2026-10-06:注入留痕(报告 §5.4) ────────────────────────────────────────
// 现场:`audit_logs.injected_memories` 活库 160 行全空 —— 因为那一列的**唯一产地**
// 是轮末反思成功那行(`'extract'`),反思跳过/失败的轮次,"她读到了什么"没人记。
// 现在组装完 prompt 就地写一行 `'inject'`(独立于反思)。这组电池钉四件事:
// 一行/轮、落的是真正注入的原文、轮内复用不重复、回调炸了不影响注入。

test('注入留痕:一行/轮,落的是**真正注入的那段原文**', async () => {
  const seen = []
  const { snap } = fixtures({ onInject: (info) => seen.push(info) })
  snap.noteClaimed('s1', userMsg('你讲话好难听啊'))
  const r = await snap.compose({ id: 's1' })
  assert.equal(seen.length, 1, '一轮留痕一次')
  assert.equal(seen[0].text, r.text, '落库的必须是真正进提示词的那段(不是重算的第二份)')
  assert.equal(seen[0].sessionId, 's1')
  assert.equal(seen[0].query, '你讲话好难听啊', '留痕要记下"这一轮拿什么去检索的"')
  assert.equal(typeof seen[0].ms, 'number', '记下这一轮检索+组装花了多久')
  assert.ok(seen[0].profileSnapshot.includes('他的称呼'), '画像那行(与审计的 injected_profile 同源)')
})

test('注入留痕:轮内复用不重复写;他再开口 = 新一轮,再写一次', async () => {
  const seen = []
  const { snap } = fixtures({ onInject: (info) => seen.push(info) })
  snap.noteClaimed('s1', userMsg('第一句'))
  await snap.compose({ id: 's1' })
  await snap.compose({ id: 's1' })   // 宿主同一步之后又组装一次(B3 的轮内复用)
  assert.equal(seen.length, 1, '同一步里的重复组装不许写成两行(面板会数不清)')
  snap.noteClaimed('s1', userMsg('第二句'))
  await snap.compose({ id: 's1' })
  assert.equal(seen.length, 2, '他再开口就是新的一轮 ⇒ 再留一行')
})

test('注入留痕:没得注入就不写行;回调炸了照常注入', async () => {
  const seen = []
  const a = fixtures({ onInject: (info) => seen.push(info) })
  assert.equal(await a.snap.compose({ id: 's9' }), null, '没 claim 过他的话 ⇒ 不注入')
  assert.equal(seen.length, 0, '没注入就不许写空行(空行会把"没注入"与"没记下来"搅成一件)')
  const b = fixtures({ onInject: () => { throw new Error('审计写库炸了') } })
  b.snap.noteClaimed('s1', userMsg('随便说点什么'))
  const r = await b.snap.compose({ id: 's1' })
  assert.ok(r !== null && r.text.length > 0, '留痕失败只是丢那一行,注入与回复照常')
})

test('注入留痕接线:index.js 只有一处写入端,写的必须是 toolCall=inject', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /\bonInject: \(info\) => \{/, 'index.js 要把 onInject 接上')
  assert.equal((src.match(/toolCall: 'inject'/g) || []).length, 1, '写入端只许一处')
  assert.match(src, /injectedMemories: text/, '落库的必须是注入块原文')
  assert.match(src, /if \(text === ''\) return/, '空块不许写行')
  // 回调在 turn-snapshot 里只许调一次(轮内复用不重复写)
  const t = readFileSync(new URL('../lib/turn-snapshot.js', import.meta.url), 'utf8')
  assert.equal((t.match(/onInject\(/g) || []).length, 1, 'onInject 只许调一次')
  assert.match(t, /typeof onInject === 'function'/, '可缺席:老调用方/测试替身不许因此报错')
})
