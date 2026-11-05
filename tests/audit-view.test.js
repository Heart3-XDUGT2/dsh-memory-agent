/**
 * 审计流"看法"的单测(web/audit-view.js,2026-09-29)。
 *
 * 他那天的话:「仪表盘网页的审计流太乱了,我希望你能设计清晰一点,人性化,
 * 但是信息一定要全面。」—— 这个文件用两条纪律把它钉住:
 *   ① **人味**的部分(分类、人话标签、相对时间)得有确定行为,不能靠感觉;
 *   ② **全面**是硬约束:折轮/分组**一行都不能丢**,也不许改原行内容
 *      (下头有"不变量"用例:输入 N 行,出来 rows 加起来必须还是 N 行)。
 *
 * 加载方式:页面文件是 classic script(无 import/export),所以照
 * tests/graph-force.test.js 抽 graph.html 的老办法 —— 把源码喂给
 * `new Function('globalThis', src)`,它只往 globalThis 上挂一个对象,沙箱隔离。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../web/audit-view.js', import.meta.url)), 'utf8')
const sandbox = {}
new Function('globalThis', src)(sandbox) // eslint-disable-line no-new-func
const V = sandbox.EchoAuditView
const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8')

/** 这个文件是纯逻辑、**看不见网络** —— 名字改由 app.js 取到 `GET /api/echo/profile`
 *  后**推**进来(`setProfile`,P1d 2026-10-05)。所以照 app.js 的口径把这份名字先喂
 *  回去,下面那些"逐类点名"的旧期望(阿岚 / Echo)才有个来源 —— 期望值一个都没改。
 *  "没推 profile"时的中性兜底另有一条用例钉着(见文件末尾)。 */
V.setProfile({ userName: '阿岚', agentName: 'Echo' })

/** 活库实测的字段形状(2026-09-29 快照):只有这些列,别加不存在的。 */
const row = (over = {}) => Object.assign({
  timestamp: 1759100000, sessionId: 'session-2d2a4aae-70b8-4916-96d8-e1829e07a4a5',
  toolCall: 'relay_in', userInput: '【QQ·私聊】阿岚说:在吗', llmReply: '',
  latency: 0, traceId: 'tr-1', injectedMemories: '', emotionPack: ''
}, over)

test('分类:每行的桶 / 来源 / 主语(逐类点名,不靠猜)', () => {
  const cases = [
    [{ toolCall: 'relay_in' }, 'talk', 'qq', '阿岚'],
    [{ toolCall: 'echo_qq_say' }, 'talk', 'qq', 'Echo'],
    [{ toolCall: 'relay_out' }, 'talk', 'qq', 'Echo'],
    [{ toolCall: 'echo_qq_call' }, 'her', 'qq', 'Echo'],
    [{ toolCall: 'care', sessionId: 'global' }, 'her', 'bg', 'Echo'],
    [{ toolCall: 'extract' }, 'reflect', 'dsh', '提取器'],
    [{ toolCall: 'reflection' }, 'reflect', 'dsh', '记忆整固'],
    [{ toolCall: 'structured_output', sessionId: '9c2d5b70-1111-2222-3333-444444444444' }, 'machine', 'sub', ''],
    [{ toolCall: 'read' }, 'work', 'dsh', ''],
    [{ toolCall: 'pwsh' }, 'work', 'dsh', ''],
    [{ toolCall: 'memory_edit' }, 'system', 'dsh', ''],
    [{ toolCall: 'relay_refused' }, 'bridge', 'dsh', ''],
    [{ toolCall: '', userInput: '[QQ:私聊] 嗯' }, 'other', 'dsh', '']
  ]
  for (const [over, bucket, source, actor] of cases) {
    const c = V.classify(row(over))
    assert.equal(c.bucket, bucket, JSON.stringify(over) + ' → 桶')
    assert.equal(c.source, source, JSON.stringify(over) + ' → 来源')
    assert.equal(c.actor, actor, JSON.stringify(over) + ' → 主语')
  }
  // 没点名的工具:`(工具) …` 这类机器旁白算后台,其余算"其他"(不吞、不冒充)
  assert.equal(V.classify(row({ toolCall: 'weird_tool', userInput: '(工具) weird_tool {"a":1}' })).bucket, 'machine')
  assert.equal(V.classify(row({ toolCall: 'weird_tool', userInput: '面板手动编辑记忆 #12' })).bucket, 'other')
})

test('来源:三种会话 id 形状 + 空/global;短名只留前 8 位', () => {
  assert.equal(V.sourceOf(''), 'bg')
  assert.equal(V.sourceOf('global'), 'bg')
  assert.equal(V.sourceOf('session-echo-companion'), 'companion')
  assert.equal(V.sourceOf('session-2d2a4aae-70b8-4916-96d8-e1829e07a4a5'), 'dsh')
  assert.equal(V.sourceOf('9c2d5b70-1111-2222-3333-444444444444'), 'sub')
  assert.equal(V.sourceOf(undefined), 'bg')
  assert.equal(V.shortSid('session-2d2a4aae-70b8'), '2d2a4aae')
  assert.equal(V.shortSid('global'), '')
})

test('来源徽章看**工具**不看会话:裁定 A 之后 QQ 的话记进他的 DSH 窗口账上', () => {
  // 现场形状(2026-09-29 活库):`relay_in` 记在 session-2d2a4aae… 这条**他的窗口**上,
  // 但这条话是从 QQ 来的 —— 按会话标就会写成「DSH」,把最要紧的事实说反。
  const qq = row({ toolCall: 'relay_in', sessionId: 'session-2d2a4aae-70b8-4916-96d8-e1829e07a4a5' })
  assert.equal(V.sourceOf(qq.sessionId), 'dsh', '会话归属确实是 DSH')
  assert.equal(V.rowSource(qq), 'qq', '但来源必须是 QQ')
  assert.equal(V.classify(qq).source, 'qq')
  // 她在同一个窗口里自己干的活:来源跟着会话走
  assert.equal(V.rowSource(row({ toolCall: 'read', sessionId: 'session-2d2a4aae-70b8-4916-96d8-e1829e07a4a5' })), 'dsh')
  assert.equal(V.rowSource(row({ toolCall: 'structured_output', sessionId: '9c2d5b70-1111-2222-3333-444444444444' })), 'sub')
})

test('折轮:活库那条形状(入站 → 她说的 + 桥副本 → 提取)折成**一轮**', () => {
  const rows = [
    row({ timestamp: 1000, toolCall: 'relay_in', userInput: '【QQ·私聊】阿岚说:在吗' }),
    row({ timestamp: 1011, toolCall: 'echo_qq_say', sessionId: 'global', userInput: '(用 QQ 说) 在的呀', latency: 900 }),
    row({ timestamp: 1011, toolCall: 'relay_out', userInput: '(用 QQ 说) 在的呀' }),
    row({ timestamp: 1027, toolCall: 'extract', llmReply: '已回他:「在的呀」' })
  ]
  const turns = V.buildTurns(rows)
  assert.equal(turns.length, 1, '一轮就是一轮:同一句话不该出现三遍')
  const t = turns[0]
  assert.equal(t.bucket, 'talk')
  assert.equal(t.in.toolCall, 'relay_in')
  assert.equal(t.out.length, 2, '她的真话 + 桥副本(显示时只取一份)')
  assert.equal(t.reflect.toolCall, 'extract')
  assert.equal(t.sessions.length, 2, '两个会话都记着(他的窗口 + global)')
  assert.equal(t.rows.length, 4)
})

test('折轮:后台/干活挂到最近一轮说过话的轮脚下(数得清),太远的自己成轮', () => {
  const rows = [
    row({ timestamp: 1000, toolCall: 'relay_in' }),
    row({ timestamp: 1001, toolCall: 'echo_qq_say', sessionId: 'global', userInput: '嗯' }),
    row({ timestamp: 1003, toolCall: 'structured_output', userInput: '(工具) structured_output {"keywords":["吃饭"]}' }),
    row({ timestamp: 1004, toolCall: 'read', userInput: '读文件:lib/store.js' }),
    // 半小时之后的机器行:挂不上前面那一轮
    row({ timestamp: 1000 + 1800, toolCall: 'structured_output', userInput: '(工具) structured_output {"summary":"自言自语"}' })
  ]
  const turns = V.buildTurns(rows)
  assert.equal(turns.length, 2, '一轮对话 + 一轮挂不上的后台')
  assert.equal(turns[0].extra.length, 2, '后台与干活都折在它服务的那一轮脚下')
  assert.deepEqual(V.countByBucket(turns[0]), { talk: 2, machine: 1, work: 1 })
  assert.equal(turns[1].bucket, 'machine')
})

test('折轮:**一行都不许丢、不许改**(输入 N 行 ⇒ 出来的 rows 加起来=N)', () => {
  const rows = [
    row({ timestamp: 5, toolCall: 'diary', userInput: '日记:今天有人陪我吃饭' }),
    row({ timestamp: 1000, toolCall: 'relay_in' }),
    row({ timestamp: 1002, toolCall: 'extract' }),
    row({ timestamp: 1003, toolCall: 'structured_output', sessionId: '9c2d5b70-1111-2222-3333-444444444444', userInput: '(工具) structured_output {"a":1}' }),
    row({ timestamp: 2000, toolCall: 'memory_cleanup', userInput: '清掉 3 条' })
  ]
  const snapshot = JSON.stringify(rows)
  const turns = V.buildTurns(rows)
  const total = turns.reduce((n, t) => n + t.rows.length, 0)
  assert.equal(total, rows.length, '折轮不许丢行')
  assert.equal(JSON.stringify(rows), snapshot, '折轮不许改原行(只贴标签,不动数据)')
  // 每行都只出现在一轮里
  const seen = []
  for (const t of turns) for (const r of t.rows) seen.push(r.timestamp + ':' + r.toolCall)
  assert.equal(new Set(seen).size, rows.length, '一行不能同时属于两轮')
})

test('后台行的人话标签:关键词 / 摘要 / 情绪 / 对你好感 —— 认不出就照给原文', () => {
  const tags = V.machineTags(row({
    toolCall: 'structured_output',
    userInput: '(工具) structured_output {"keywords":["梅菜扣肉","晚饭"],"summary":"阿岚说自己已经吃完","emotion_score":2,"global":{"fatigue":0.3,"valence":7.5},"target_master":{"affection":10,"playfulness":9.5}}'
  }))
  const got = Object.fromEntries(tags.map((t) => [t.k, t.v]))
  assert.equal(got['词'], '梅菜扣肉、晚饭')
  assert.ok(got['记'].startsWith('阿岚说自己已经吃完'))
  assert.equal(got['情绪分'], '2')
  assert.equal(got['全局'], '疲惫 0.3 · 心情 7.5')
  assert.equal(got['对你'], '爱意 10 · 调皮 9.5')
  // 认不出的 JSON:列前三个字段名(绝不返回空 —— 空就是静默)
  assert.deepEqual(V.machineTags(row({ toolCall: 'structured_output', userInput: '(工具) structured_output {"alpha":1,"beta":2}' })),
    [{ k: '字段', v: 'alpha、beta' }])
  // 根本不是 JSON:把原文当标签(而且别把整段 JSON 都塞进来)
  assert.deepEqual(V.machineTags(row({ toolCall: 'x', userInput: '面板手动编辑记忆 #12' })), [{ k: '原文', v: '面板手动编辑记忆 #12' }])
  assert.deepEqual(V.machineTags(row({ toolCall: 'x', userInput: '' })), [])
  // 尾部带人话的 JSON 也要能解出来(桥那种「… → 他在用的那条会话」)
  assert.deepEqual(V.payloadJson('(工具) structured_output {"a":1} → 他在用的那条会话'), { a: 1 })
  assert.equal(V.payloadJson('没有 JSON'), null)
})

test('时间:相对话 / 日期分组 / 日期标题(今天 · 昨天 · 8 月 26 日)', () => {
  const now = new Date(2026, 8, 29, 21, 0, 0).getTime() // 2026-09-29 21:00 本地
  const at = (ms) => now - ms
  assert.equal(V.relTime(at(5 * 1000), now), '刚刚')
  assert.equal(V.relTime(at(12 * 60 * 1000), now), '12 分钟前')
  assert.equal(V.relTime(at(3 * 3600 * 1000), now), '今天 18:00')
  assert.equal(V.relTime(at(25 * 3600 * 1000), now), '昨天 20:00')
  assert.equal(V.relTime(at(4 * 86400 * 1000), now), '9-25 21:00')
  assert.equal(V.relTime(0, now), '—')
  assert.equal(V.dayKey(at(1000)), '2026-09-29')
  assert.equal(V.dayLabel('2026-09-29', now), '今天')
  assert.equal(V.dayLabel('2026-09-28', now), '昨天')
  assert.equal(V.dayLabel('2026-08-26', now), '8 月 26 日 星期三')
  assert.equal(V.dayLabel('unknown', now), '时间不明')
})

test('按天分组:新的在前,天内也是新的在前', () => {
  const now = new Date(2026, 8, 29, 21, 0, 0).getTime()
  const day = 86400 * 1000
  const turns = V.buildTurns([
    row({ timestamp: Math.round((now - 2 * day) / 1000), toolCall: 'relay_in' }),
    row({ timestamp: Math.round((now - 60 * 1000) / 1000), toolCall: 'relay_in' }),
    row({ timestamp: Math.round((now - 10 * 60 * 1000) / 1000), toolCall: 'relay_in' })
  ])
  const groups = V.groupByDay(turns, now)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].label, '今天')
  assert.equal(groups[1].label, '9 月 27 日 星期日')
  assert.ok(groups[0].turns[0].time > groups[0].turns[1].time, '天内新的在前')
})

test('统计带:桶与来源的计数 + 最近一次有人说话', () => {
  const s = V.summarize([
    row({ timestamp: 1000, toolCall: 'relay_in' }),
    row({ timestamp: 1001, toolCall: 'echo_qq_say', sessionId: 'global' }),
    row({ timestamp: 1002, toolCall: 'structured_output', sessionId: '9c2d5b70-1111-2222-3333-444444444444' }),
    row({ timestamp: 1003, toolCall: 'structured_output', sessionId: '9c2d5b70-1111-2222-3333-444444444444' }),
    row({ timestamp: 1004, toolCall: 'memory_edit' }),
    row({ timestamp: 1005, toolCall: 'relay_refused' })
  ])
  assert.equal(s.rows, 6)
  assert.equal(s.buckets.talk, 2)
  assert.equal(s.buckets.machine, 2)
  assert.equal(s.buckets.system, 1)
  assert.equal(s.buckets.bridge, 1)
  assert.equal(s.sources.qq, 2, 'relay_in 与 echo_qq_say 都算 QQ(桥自己写的工具)')
  assert.equal(s.sources.sub, 2)
  assert.equal(s.sources.dsh, 2, 'memory_edit 与 relay_refused 记在他的窗口账上')
  assert.equal(s.sources.bg, 0, 'echo_qq_say 记在 global,但它是 QQ 的话 ⇒ 不算"全局"')
  assert.equal(s.lastTalkAt, 1001, '"最近一次有人说话"只看说话的行,不看后台')
})

test('检索:一轮的所有字段都能被搜到(工具名 / 他的字 / 她的字 / 注入)', () => {
  const t = V.buildTurns([
    row({ timestamp: 1, toolCall: 'relay_in', userInput: '【QQ·私聊】阿岚说:舞萌是什么' }),
    row({ timestamp: 2, toolCall: 'echo_qq_say', sessionId: 'global', userInput: '(用 QQ 说) 一个音游呀', injectedMemories: '【记忆】他喜欢音游' })
  ])[0]
  const text = V.turnText(t)
  for (const needle of ['舞萌', '一个音游呀', 'relay_in', '入站·他说', '记忆】他喜欢音游', '对话']) {
    assert.ok(text.includes(needle), '检索文本里该有:' + needle)
  }
})

test('不变量:模块只挂一个对象,不碰别处(页面靠它做"看法",不能有副作用)', () => {
  const keys = Object.keys(V).sort()
  assert.ok(keys.includes('buildTurns') && keys.includes('classify') && keys.includes('summarize'))
  assert.equal(typeof V.ATTACH_SEC, 'number')
  // 每个桶都有 label/icon/rank/desc(页面直接拿去画,缺一个就是 undefined 上屏)
  for (const [k, b] of Object.entries(V.BUCKETS)) {
    assert.ok(b.label && b.icon && typeof b.rank === 'number' && b.desc, '桶 ' + k + ' 缺字段')
  }
  assert.deepEqual(Object.keys(sandbox), ['EchoAuditView'], '只许挂一个全局对象')
})

test('没推 profile ⇒ 主语标签走中性兜底(用户 / 助手),不崩、不空白', () => {
  // P1d 的真实收益(app.js 侧的对应用例在 tests/web-dashboard.test.js):
  // 端点没就绪 / 还没推到 ⇒ 主语标签回中性词,页面照常画 —— 真名不再写回代码。
  V.setProfile(null)
  assert.deepEqual(V.namesOf(), { userName: '用户', agentName: '助手' })
  // 三个吃名字的桶逐个点名(他 / 她 / 她的后台行)
  assert.equal(V.classify(row({ toolCall: 'relay_in' })).actor, '用户')
  assert.equal(V.classify(row({ toolCall: 'echo_qq_say' })).actor, '助手')
  assert.equal(V.classify(row({ toolCall: 'care', sessionId: 'global' })).actor, '助手')
  // 缺字段 / 空白串也回兜底 —— 标签不许是空白(空白 = 面板上那格没了)
  V.setProfile({ userName: '  ', agentName: '' })
  assert.equal(V.classify(row({ toolCall: 'relay_in' })).actor, '用户')
  assert.equal(V.classify(row({ toolCall: 'echo_qq_call' })).actor, '助手')
  // 不吃 profile 的那些桶照旧(提取器 / 机器行无主语)
  assert.equal(V.classify(row({ toolCall: 'extract' })).actor, '提取器')
  assert.equal(V.classify(row({ toolCall: 'read' })).actor, '')
  // 喂回真名,别把名字串到别的用例上(node --test 同文件内是顺序跑的)
  V.setProfile({ userName: '阿岚', agentName: 'Echo' })
})

test('页面接线:audit-view.js 必须在 app.js **之前**,且容器存在', () => {
  const atView = html.indexOf('audit-view.js')
  const atApp = html.indexOf('/echo/app.js')
  assert.ok(atView > 0, 'index.html 要加载 audit-view.js')
  assert.ok(atApp > 0 && atView < atApp, '顺序反了:app.js 里的 V() 会当场报错')
  for (const id of ['au-stat', 'au-chips', 'au-list', 'au-q', 'au-fold']) {
    assert.ok(html.includes('id="' + id + '"'), 'index.html 缺容器 #' + id)
  }
})

// ── 2026-10-06:注入留痕(报告 §5.4) ────────────────────────────────────────
// `tool_call='inject'` 是组装完 prompt 就写的那一行(与轮末反思成功与否无关)。
// 面板这边钉三件事:它有人话名、归"提取"族(对话优先档里露脸)、统计带能数出
// "这一窗里有几行真的带注入块" —— 活库那次 160 行全空,盯着页面看不出来。

test('注入留痕行:人话名 / 归提取族 / 主语是"注入留痕"', () => {
  const c = V.classify(row({ toolCall: 'inject', userInput: '今天面试怎么样', injectedMemories: '【情景记忆】A' }))
  assert.equal(c.human, '注入留痕', '面板上不许出现裸工具名')
  assert.equal(c.bucket, 'reflect', '归"提取"族:它回答的是这一轮她读到了什么')
  assert.equal(c.actor, '注入留痕')
  // 提取族里原来那两行的分工没被动过
  assert.equal(V.classify(row({ toolCall: 'extract' })).actor, '提取器')
  assert.equal(V.classify(row({ toolCall: 'reflection' })).actor, '记忆整固')
})

test('统计带体检:数得出带注入块的行、注入留痕行、最近一条多少字', () => {
  const s = V.summarize([
    row({ timestamp: 1000, toolCall: 'relay_in', userInput: '在吗' }),
    row({ timestamp: 1001, toolCall: 'inject', injectedMemories: '【情景记忆】短' }),
    row({ timestamp: 1002, toolCall: 'inject', injectedMemories: '【情景记忆】' + 'x'.repeat(200) }),
    row({ timestamp: 1003, toolCall: 'extract', injectedMemories: '【情景记忆】轮末那行也带' }),
    row({ timestamp: 1004, toolCall: 'pwsh', userInput: '(工具) pwsh {"command":"ls"}' }),
    row({ timestamp: 1005, toolCall: 'relay_out', llmReply: '在的' })
  ])
  assert.equal(s.injects.rows, 3, '带注入块的行(注入留痕 2 + 提取 1)')
  assert.equal(s.injects.lines, 2, '注入留痕行单独数得出来')
  // "最近一条块多少字"按**时间**取(这一窗里最新带块的是 1003 那条轮末提取行,
  // 不是 1002 那条最长的) —— 读数说的是"最近一次注入有多厚",不挑类别
  assert.equal(s.injects.lastChars, '【情景记忆】轮末那行也带'.length)
  assert.equal(s.injects.lastAt, 1003)
  assert.equal(s.rows, 6, '总行数不变(体检只加读数,不动行)')
  // 一条注入都没有的那一窗:读数必须是 0(面板据此显红字提示,不许静默)
  const none = V.summarize([row({ timestamp: 1000, toolCall: 'pwsh', userInput: '(工具) pwsh {"command":"ls"}' })])
  assert.equal(none.injects.rows, 0)
  assert.equal(none.injects.lines, 0)
  assert.equal(none.injects.lastChars, 0)
})

test('2026-10-08 F1(不变量):后到的**更早**行会另成一轮,不许掰走已有轮的 id', () => {
  // 轮 id = "定义这一轮的那一行"的 trace_id(折轮时 open() 取的那一行)。
  // 一个**时间更早**的行后到时会自己开一轮(它谁都接不上),**不会**把已有轮的 id 掰走 ——
  // 这条不变量以前靠观察,现在钉住(现场:窗口一重建,他展开的详情就"自己关掉")。
  const IN = row({ toolCall: 'relay_in', traceId: 'tr-IN', timestamp: 1000, userInput: '【QQ·私聊】阿岚说:在吗' })
  const OUT = row({ toolCall: 'echo_qq_say', traceId: 'tr-OUT', timestamp: 1010, userInput: '在的' })
  const before = V.buildTurns([IN, OUT])
  assert.equal(before.length, 1)
  assert.equal(before[0].id, 'tr-IN', 'talk 轮的 id 取"入站那一行"')
  const BG_EARLY = row({ toolCall: 'eyes', traceId: 'tr-BGE', timestamp: 900, userInput: '{"shot":0}' })
  const after = V.buildTurns([BG_EARLY, IN, OUT])
  const talk = after.filter((t) => t.bucket === 'talk')
  assert.equal(talk.length, 1, 'talk 轮还是一个')
  assert.equal(talk[0].id, 'tr-IN', '更早的行不许改已有轮的 id(它自己另成一轮)')
  // 重建幂等:id 是"窗口内容"的纯函数(同一窗口折两次,id 逐轮相同)
  assert.deepEqual(V.buildTurns([BG_EARLY, IN, OUT]).map((t) => t.id), after.map((t) => t.id))
  // id 唯一 —— 它们被当 Set 的键用(auditOpen / auditClosed / auSel)
  const ids = after.map((t) => t.id)
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一')
})

test('2026-10-08 F1′(已做):大窗口折轮 ⇒ 定义行还落在大窗口里,id 就不漂', () => {
  const IN = row({ toolCall: 'relay_in', traceId: 'tr-IN', timestamp: 1000, userInput: '【QQ·私聊】阿岚说:在吗' })
  const OUT = row({ toolCall: 'echo_qq_say', traceId: 'tr-OUT', timestamp: 1010, userInput: '在的' })
  const EX = row({ toolCall: 'extract', traceId: 'tr-EX', timestamp: 1020, llmReply: '{"summary":"聊了在不在"}' })
  // 大窗口 = 三行(折轮用);展示窗口 = 最新 2 行(OUT / EX)
  const shown = V.turnsForDisplay([IN, OUT, EX], 2)
  assert.equal(shown.length, 1, '一轮')
  assert.equal(shown[0].id, 'tr-IN', 'F1′:定义行还在大窗口里 ⇒ id 不漂')
  assert.equal(shown[0].rows.length, 3, '折轮吃的是**大窗口**:三行都在这一轮里(卡片内容也更全)')
  // 对照:旧行为(只拿展示窗口那两行去折)⇒ id 当场漂成 tr-OUT —— 这就是 F1′ 治的那个病
  assert.equal(V.buildTurns([OUT, EX])[0].id, 'tr-OUT', '只折展示窗口就会漂(老行为)')
  // 展示的轮数**不许减少**:只折展示窗口时也是 1 轮
  assert.equal(V.buildTurns([OUT, EX]).length, shown.length, '展示的轮数不许变少')
})

test('2026-10-08 F1′ 边界:定义行**也**滑出大窗口 ⇒ 仍会漂(靠 app.js 的缓存 + 提示兜底)', () => {
  const OUT = row({ toolCall: 'echo_qq_say', traceId: 'tr-OUT', timestamp: 1010, userInput: '在的' })
  const EX = row({ toolCall: 'extract', traceId: 'tr-EX', timestamp: 1020, llmReply: '{"summary":"聊了在不在"}' })
  // 大窗口里已经没有入站那一行 ⇒ 退到"她说过的话";连它也出去 ⇒ 退到 reflect
  assert.equal(V.turnsForDisplay([OUT, EX], 2)[0].id, 'tr-OUT')
  assert.equal(V.turnsForDisplay([EX], 1)[0].id, 'tr-EX')
  // 行数不够一个展示窗口时:与老路径(buildTurns)逐轮一致 —— 不多也不少
  const small = V.turnsForDisplay([EX], 40)
  assert.deepEqual(small.map((t) => t.id), V.buildTurns([EX]).map((t) => t.id))
  // 没有 traceId 的行当"总在窗口里":一个轮里只要有这种行,就**绝不**被窗口筛掉
  // (判据不认得它,宁可多留一轮 —— 展示窗口只有那 1 行时,老路径也是留这一轮)
  const OUT2 = row({ toolCall: 'echo_qq_say', traceId: 'tr-OUT2', timestamp: 1010, userInput: '在的' })
  const noTrace = row({ toolCall: 'extract', traceId: '', timestamp: 1020, llmReply: '{"summary":"缺 id"}' })
  const kept = V.turnsForDisplay([OUT2, noTrace], 1)
  assert.equal(kept.length, 1, '缺 traceId 的行所在的那一轮不许被窗口筛掉')
  assert.equal(kept[0].id, 'tr-OUT2', 'id 仍取"定义这一轮的那一行"(她说过的话)')
})

test('2026-10-08 降噪:心跳刷屏 40 行时,"内容窗口"仍要把对话凑进来', () => {
  // 现场:会话清理每分钟级刷屏(实测 10 分钟一条 / 24h 52 条),而对话优先档只取最新 40 行
  // ⇒ 40 行全是清理行,真实对话被挤出窗口(他报的"对话优先里没有对话")。
  const reapers = []
  for (let i = 0; i < 50; i += 1) {
    reapers.push(row({ toolCall: 'session-reaper', traceId: 'rp' + i, timestamp: 5000 + i, userInput: '(会话清理)' }))
  }
  const IN = row({ toolCall: 'relay_in', traceId: 'tr-IN', timestamp: 1000, userInput: '【QQ·私聊】阿岚说:在吗' })
  const OUT = row({ toolCall: 'echo_qq_say', traceId: 'tr-OUT', timestamp: 1010, userInput: '在的' })
  const rows = reapers.concat([IN, OUT])          // 清理行更新(时间更大)

  // ① 分桶:会话清理是**机器行**(以前没点名 ⇒ 兜底 'other' ⇒ 躲过"对话优先"的过滤)
  assert.equal(V.classify(row({ toolCall: 'session-reaper', userInput: '(会话清理)' })).bucket, 'machine',
    'session-reaper 必须归机器行')

  // ② 内容窗口:只算 talk/her/reflect,从最新往回翻到凑够 40 行
  const shown = V.contentRows(rows, 40)
  assert.equal(shown.filter((r) => r.toolCall === 'session-reaper').length, 0, '心跳行不许占内容窗口')
  assert.ok(shown.some((r) => r.traceId === 'tr-IN'), '对话行必须被凑进来')

  // ③ 显示侧:用这份内容窗口挑轮 ⇒ 那一轮是对话(talk),id 取定义行
  const turns = V.turnsForDisplay(rows, shown)
  const talk = turns.filter((t) => t.bucket === 'talk')
  assert.equal(talk.length, 1, '对话优先档要有一个对话轮(实为 ' + talk.length + ')')
  assert.equal(talk[0].id, 'tr-IN')
  // 对照:老口径(只取最新 40 行)在同样输入下**一个对话轮都没有**
  const oldShown = rows.slice().sort((a, b) => b.timestamp - a.timestamp).slice(0, 40)
  assert.equal(V.turnsForDisplay(rows, oldShown).filter((t) => t.bucket === 'talk').length, 0,
    '老口径(只按行数取最新)正是把对话挤没的那个行为')
})

test('2026-10-08 内容窗口边界:白名单可换 · 空窗口 ⇒ 不显示任何轮', () => {
  const rows = [
    row({ toolCall: 'read', traceId: 'w1', timestamp: 3000, userInput: '(工具) read x' }),
    row({ toolCall: 'relay_in', traceId: 't1', timestamp: 2000, userInput: '【QQ·私聊】阿岚说:在吗' })
  ]
  // 默认白名单(talk/her/reflect):read 是 work ⇒ 不进
  assert.deepEqual(V.contentRows(rows, 10).map((r) => r.traceId), ['t1'])
  // 换白名单:work 也算"内容" ⇒ 两行都进,最新的在前
  assert.deepEqual(V.contentRows(rows, 10, ['work']).map((r) => r.traceId), ['w1'])
  // 一条都不在白名单里 ⇒ 空内容窗口 ⇒ 显示侧返回空(面板走"空态给话"那条路,不是空白)
  const none = V.contentRows(rows, 10, ['bridge'])
  assert.equal(none.length, 0)
  assert.deepEqual(V.turnsForDisplay(rows, none), [], '空展示窗口 ⇒ 一个轮都不显示(交空态处理)')
})

test('2026-10-08 autofill 兜底:5 个检索框都关掉浏览器自动填充', () => {
  for (const id of ['au-q', 'mm-q', 'di-q', 'cv-q', 'cfg-q']) {
    const m = html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'))
    assert.ok(m, id + ' 该在 index.html 里')
    // 2026-10-08 修正:Chrome 自 2021 起对 type=search 忽略 autocomplete="off" ⇒
    // 用官方推荐的 one-time-code,并给一个**不可被 autofill 识别**的 name。
    assert.ok(/autocomplete="one-time-code"/.test(m[0]), id + ' 该带 autocomplete="one-time-code":' + m[0])
    assert.ok(/name="naf-/.test(m[0]), id + ' 该有个不可识别的 name(naf-*):' + m[0])
    assert.ok(/spellcheck="false"/.test(m[0]), id + ' 该带 spellcheck="false"')
    assert.ok(/autocapitalize="off"/.test(m[0]), id + ' 该带 autocapitalize="off"')
    assert.ok(/type="search"/.test(m[0]), id + ' 的 type="search" 要保留(只关自动填充)')
  }
})
