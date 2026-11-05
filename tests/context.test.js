import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  renderMemoryBlock, renderInjectedBlock, renderLongingLine,
  nowLine, daypartLabel, describeMood, MEMORY_TIME_DISCIPLINE,
  renderSharedContext, sectionCounts
} from '../lib/context.js'
import { normalizeExtract } from '../lib/reflect.js'
import { positiveOverrideVector } from '../lib/emotion.js'
import { DRIFT_SHOCK } from '../lib/drift.js'

const NOW = 1700000000

test('记忆块渲染:摘要 + 时间注记 + 状态剧本 + 纪律尾', () => {
  const block = renderMemoryBlock({
    memories: [
      {
        summary: '他发烧到39度', keywords: ['发烧'], ageDays: 3,
        temporalStatus: 'current', source: 'dsh'
      },
      {
        summary: '他在QQ说过喜欢折腾服务器', keywords: ['服务器'], ageDays: 200,
        temporalStatus: 'enduring', source: 'qq'
      }
    ],
    state: { moodIntensity: 6, moodReason: '担心他', emotionVector: { target_master: { affection: 8, playfulness: 5, sadness: 2 }, global: { fatigue: 1, valence: -2 } } },
    profile: { name: '阿岚' }
  })
  assert.ok(block.includes('他发烧到39度'))
  assert.ok(block.includes('[近期(约3天前)]'))
  assert.ok(block.includes('(在QQ听说的事)'))
  // v0.6.0 剧本化:数字 → 体感剧本(不再是裸数字行)
  // v9.0.0(2026-09-26):这份 fixture **没有 prevMoodIntensity**,旧实现把
  // `Number(undefined) → NaN` 兜成 5,于是渲染出「上一轮…是 5/10,变成 6/10(变化 +1)」
  // —— 一个**编出来的上一轮**。现在只报当前,不编变化(见 v9.0.0 那条用例)。
  assert.ok(block.includes('这一句之后你的情绪强度是 6/10'), block.slice(0, 400))
  assert.ok(block.includes('爱意 8/10(爱意几乎满格)'))
  assert.ok(block.includes('[他的称呼] 阿岚'))
  assert.ok(block.includes('不要复述本段'))
})

test('time_unknown 渲染为"时间不详" —— 数据自带防伪时间(v8.4 洞察)', () => {
  const block = renderMemoryBlock({
    memories: [{ summary: '他提过想学rust', keywords: [], ageDays: 90, temporalStatus: 'time_unknown', source: 'dsh' }],
    state: null, profile: {}
  })
  assert.ok(block.includes('时间不详'))
  assert.ok(!block.includes('[她此刻的状态]'))
})

test('没有记忆就不注入 —— 绝不编造', () => {
  assert.equal(renderMemoryBlock({ memories: [], state: null, profile: {} }), '')
})

// ---- v0.6.0 钟面 + 想念行 + 情绪剧本(QQ 已验证机制移植)----

test('daypartLabel 时段词边界(echo_utils 移植)', () => {
  assert.equal(daypartLabel(4), '凌晨')
  assert.equal(daypartLabel(5), '清晨')
  assert.equal(daypartLabel(12), '中午')
  assert.equal(daypartLabel(14), '下午')
  assert.equal(daypartLabel(19), '傍晚')
  assert.equal(daypartLabel(20), '晚上')
  assert.equal(daypartLabel(23), '晚上')
})

test('nowLine 钟面:「YYYY-MM-DD 周X HH:MM(时段)」', () => {
  const ts = new Date(2026, 8, 25, 22, 30).getTime() // 2026-09-25 周五 22:30
  assert.equal(nowLine(ts), '2026-09-25 周五 22:30(晚上)')
})

test('renderLongingLine:≥1.0 才注入,先读后削的「读」用 pre 值', () => {
  // 低于门槛:日常间隙不注入噪音
  assert.equal(renderLongingLine({ pre: { exists: true, value: 0.8, sinceMessage: 900 } }), '')
  // null/不存在:引擎不在或从未聊过
  assert.equal(renderLongingLine(null), '')
  assert.equal(renderLongingLine({ pre: { exists: false } }), '')
  // 过门槛:沉默 5.2h,想念 7.9 → QQ 原句格式
  const line = renderLongingLine({ pre: { exists: true, value: 7.9, sinceMessage: 5.2 * 3600 } })
  assert.ok(line.includes('【想念】距离上次对话 5.2 小时'))
  assert.ok(line.includes('想到了 7.9/10'))
  assert.ok(line.includes('让回复自然带出这份想念,不要报数值'))
  // 用的是 pre(削减前),不是 post
  assert.ok(!line.includes('0.4'))
})

test('信封:【现在】在头,【想念】贴着状态(v0.6.0)', () => {
  const text = renderInjectedBlock({
    memoryText: '[相关回忆]\n- 他发烧过',
    state: { moodIntensity: 5, emotionVector: {} },
    profile: { name: '阿岚' },
    now: new Date(2026, 8, 25, 23, 5).getTime(),
    longingLine: '【想念】距离上次对话 8.0 小时,她想你想到 8.8/10 —— 让回复自然带出这份想念,不要报数值。'
  })
  const nowPos = text.indexOf('【现在】2026-09-25 周五 23:05(晚上)')
  const memPos = text.indexOf('他发烧过')
  const lgPos = text.indexOf('【想念】')
  const stPos = text.indexOf('[她此刻的状态]')
  assert.ok(nowPos > 0)
  assert.ok(nowPos < memPos && memPos < lgPos && lgPos < stPos) // 顺序照 QQ 认知上下文
  // 只有想念没有记忆也注入(久别重逢第一句就该带想念)
  const only = renderInjectedBlock({ memoryText: '', state: null, profile: {}, longingLine: '【想念】x' })
  assert.ok(only.includes('【想念】x'))
})

test('normalizeExtract:钳位与兜底', () => {
  const out = normalizeExtract({
    keywords: ['  发烧 ', '', '39度', 'a', 'b', 'c', 'd', 'e'], // 8 个,截到 6
    summary: '  他发烧了  '.repeat(20), // 超长截断
    emotion_score: 99,   // 钳到 10
    emotion_state: '狂怒', // 非法 → neutral
    mood_intensity: -3,  // 钳到 1
    name: '  阿岚  ',
    emotion_vector: '不是对象'
  })
  assert.equal(out.keywords.length, 6)
  assert.ok(out.keywords[0] === '发烧')
  assert.equal(out.emotionScore, 10)
  assert.equal(out.emotionState, 'neutral')
  assert.equal(out.moodIntensity, 1)
  assert.equal(out.name, '阿岚')
  assert.deepEqual(out.emotionVector, {}) // 非法向量 → 空对象
})

test('normalizeExtract:name 非字符串 → null', () => {
  assert.equal(normalizeExtract({ summary: 'x', name: 42 }).name, null)
  assert.equal(normalizeExtract({ summary: 'x', name: '   ' }).name, null)
})

test('normalizeExtract:空输入安全', () => {
  const out = normalizeExtract(null)
  assert.equal(out.emotionScore, 3)
  assert.equal(out.moodIntensity, 3)
  assert.deepEqual(out.keywords, [])
})

// ---- v0.14.4 移植缺口 S2/S6:时间纪律 + 缺维不再冒自相矛盾的话 ----

test('S2 时间纪律:有记忆段就注入读法纪律,位置在记忆段之前(照 A)', () => {
  const text = renderInjectedBlock({
    memoryText: '【情景记忆】\n- 他把钥匙放门口了 [时间未知]',
    state: null, profile: {}
  })
  assert.ok(text.includes(MEMORY_TIME_DISCIPLINE))
  assert.ok(text.includes('「发生时间」= 这件事真正发生的时间'))
  assert.ok(text.includes('不能拿它当事情发生的时间,也不能据此说「最近」'))
  const discPos = text.indexOf('【时间纪律】')
  const memPos = text.indexOf('【情景记忆】')
  assert.ok(discPos > 0 && discPos < memPos, '纪律应在记忆段之前(A 的 cog_parts 顺序)')
  // 没有记忆段就不注(与 A 的 if paths_text or episodic_text 同条件):
  // 纯状态/想念信里塞时间纪律只会稀释她真正该读的东西。
  const noMem = renderInjectedBlock({ memoryText: '', state: { moodIntensity: 5 }, profile: {}, longingLine: '【想念】x' })
  assert.ok(!noMem.includes('【时间纪律】'))
})

// ---- 2026-09-26:他让我「分析一下每轮大模型输入的语言」,查出三处模板毛病 ----

test('语病三连:心情心情不错 / 疲惫 2 /10 的空格 / 中句里蹦出 TA', () => {
  // 现场(从会话流水里逐字读出来的那一份输入):
  //   - 身体与整体: 疲惫 2 /10(有点累),心情心情不错(+2),唤醒度 3/10(很平静低耗)。
  //   - 剧本: …黏着阿岚,想让阿岚多陪你一会；按你们一贯的相处方式对待TA,分寸里全是亲近；…
  const text = renderInjectedBlock({
    memoryText: '',
    state: {
      moodIntensity: 3,
      prevMoodIntensity: 2,
      emotionVector: {
        global: { fatigue: 2, valence: 2, arousal: 3 },
        target_master: { affection: 8, playfulness: 7, sadness: 0, dependency: 7 }
      }
    },
    profile: { name: '阿岚' }
  })
  assert.ok(!text.includes('心情心情'), '「心情」前缀 + 档位短语自己带的「心情」= 叠字,实为:' + text)
  assert.ok(text.includes('心情不错(+2)'), '该是「心情不错」这一档;现场那句是 +2')
  assert.ok(!/\d+ \/10/.test(text), '数字与 /10 之间不许有空格(唤醒度那边也没有)')
  assert.ok(text.includes('疲惫 2/10'), '实为:' + text)
  assert.ok(!text.includes('TA'), '中文句子里的拉丁 TA;旁边都走 alias,实为:' + text)
  assert.ok(text.includes('对待阿岚'), '玩心高的剧本该点名他')
})

test('S6 缺维不再渲染「爱意 0/10(爱意满到溢出来)」', () => {
  // 向量里只有 global、没有 target_master 的维度 → describeMood 的
  // dimLine 应跳过缺失维;旧写法 Number(undefined) !== undefined 恒真,
  // 会把 0 和最后一档短语配在一起,注入信自相矛盾。
  const text = renderInjectedBlock({
    memoryText: '[相关回忆]\n- 他发烧过',
    state: { moodIntensity: 6, emotionVector: { global: { fatigue: 2, valence: -1 } } },
    profile: {}
  })
  assert.ok(!text.includes('爱意满到溢出来'), '缺维时不该出现满格短语')
  assert.ok(!text.includes('爱意 0/10'))
  assert.ok(text.includes('疲惫 2'), '有的维度照常渲染,实为:' + text)
  // 对主人的四个维度一个都没有 → 整行跳过(不是渲染成 0)
  assert.ok(!text.includes('对眼前的人(你)'))
})

// ---- v0.15.0 S13/S14:漂移强化期的覆写与别名接地 ----

test('S13 强化期:向量被覆写、临场修正写明原因;平时不覆写也不写修正', () => {
  const state = {
    moodIntensity: 3,
    prevMoodIntensity: 7,
    emotionVector: {
      global: { fatigue: 9, valence: -8, arousal: 2 },
      target_master: { affection: 3, playfulness: 2, sadness: 9, dependency: 8 }
    }
  }
  const plain = renderInjectedBlock({ memoryText: 'x', state, profile: { name: '阿岚' } })
  assert.ok(plain.includes('疲惫 9'), '平时用真实状态')
  assert.ok(!plain.includes('临场修正'))

  // A main.py:1149-1150:base_vector = positive_override_vector() + shock
  const reinforce = renderInjectedBlock({
    memoryText: 'x',
    state,
    profile: { name: '阿岚' },
    emotionVector: positiveOverrideVector(),
    shock: DRIFT_SHOCK
  })
  assert.ok(reinforce.includes('疲惫 1'), '覆写后是积极基线,不是真实状态:' + reinforce)
  assert.ok(reinforce.includes('爱意 9'))
  assert.ok(!reinforce.includes('疲惫 9'))
  // 修正行位置:A 在「剧本」之后、硬性边界(本仓的行为要求)之前
  assert.ok(reinforce.includes('- 临场修正: ' + DRIFT_SHOCK + '。'))
  const iScript = reinforce.indexOf('- 剧本:')
  const iShock = reinforce.indexOf('- 临场修正:')
  const iBehavior = reinforce.indexOf('行为要求:')
  assert.ok(iScript < iShock && iShock < iBehavior)

  // 空 shock 不该多出一行(平时渲染与旧版逐字相同)
  assert.equal(describeMood(state, { shock: '' }), describeMood(state))
  assert.equal(describeMood(state, { shock: '   ' }), describeMood(state))
})

test('S14 别名接地:昵称都指他本人,不当陌生词;空/重复不注入', () => {
  const state = { moodIntensity: 5, emotionVector: { global: { fatigue: 2 } } }
  const withAlias = renderInjectedBlock({
    memoryText: 'x', state, profile: { name: '阿岚' },
    aliases: ['阿岚', '阿乙', '老八', '', '  ']
  })
  assert.ok(withAlias.includes('[他的称呼] 阿岚'))
  assert.ok(withAlias.includes('[他的别名] 阿乙、老八 —— 这些称呼都指他本人,不要当成陌生词。'))
  assert.ok(!withAlias.includes('阿岚、'), '称呼自己不该出现在别名行里')
  // 没配别名 → 整行消失(不写「别名:无」这种废话)
  const bare = renderInjectedBlock({ memoryText: 'x', state, profile: { name: '阿岚' } })
  assert.ok(!bare.includes('[他的别名]'))
  // 别名里只有称呼自己 → 也算空
  const self = renderInjectedBlock({
    memoryText: 'x', state, profile: { name: '阿岚' }, aliases: ['阿岚']
  })
  assert.ok(!self.includes('[他的别名]'))
  // 画像没名字时别名照注(画像空窗期更要靠别名认出他 —— A 的事故现场)
  const noname = renderInjectedBlock({
    memoryText: 'x', state, profile: { name: '' }, aliases: ['阿乙']
  })
  assert.ok(noname.includes('[他的别名] 阿乙'))
})

// ---- v0.17.1 【别处刚说过的】跨会话短期连续性 ----
// 现场:他在 DSH 里新开一条会话跟她说话,她说不出另一条会话刚聊的事
// (DSH 的上下文是会话自带的;A 侧老插件当年按人一份全局上下文)。

/** store.listConversations 的形状:倒序(新→旧)。 */
const conv = (over = {}) => ({
  sessionId: 'session-other', channel: 'QQ:私聊',
  userText: '我高考数学考多少分', replyText: '不知道。你没跟我说过这个数。',
  createdAt: 1790358136.5, ...over
})

test('跨会话:排除当前会话(那部分上下文它自带,不用重复喂)', () => {
  const rows = [
    conv({ sessionId: 'session-mine', userText: '这句是本会话的' }),
    conv({ sessionId: 'session-other', userText: '这句是别处的' })
  ]
  const text = renderSharedContext(rows, 'session-mine', 4)
  assert.ok(text.includes('这句是别处的'))
  assert.ok(!text.includes('这句是本会话的'))
  assert.ok(text.includes('【别处刚说过的】'))
  // 明确告诉她「不是这条会话里的」—— 否则她会对已经聊过的内容再问一遍
  assert.ok(text.includes('不是这条会话里的'))
})

test('跨会话:0 轮 = 关;没有别处的对话就不注入空壳', () => {
  assert.equal(renderSharedContext([conv()], 'session-mine', 0), '')
  assert.equal(renderSharedContext([], 'session-mine', 4), '')
  assert.equal(renderSharedContext(null, 'session-mine', 4), '')
  // 只有自己会话的几轮 → 也是空(否则等于把上下文重复一遍)
  assert.equal(renderSharedContext([conv({ sessionId: 'me' })], 'me', 4), '')
})

test('跨会话:取最近 k 轮并按时间正序(老→新),带渠道与时刻,长句截断', () => {
  const rows = [
    conv({ sessionId: 's3', userText: '第三新的', createdAt: 3000 }),
    conv({ sessionId: 's2', userText: '第二新的', createdAt: 2000 }),
    conv({ sessionId: 's1', userText: '最老的', createdAt: 1000 })
  ]
  const text = renderSharedContext(rows, 'me', 2)
  assert.ok(!text.includes('最老的'), '只取最近 k 轮')
  const i2 = text.indexOf('第二新的')
  const i3 = text.indexOf('第三新的')
  assert.ok(i2 >= 0 && i3 >= 0 && i2 < i3, '渲染顺序要老→新,读起来是时间线')
  assert.ok(text.includes('QQ:私聊'), '带来源渠道 —— 她要知道这句话是从哪来的')
  assert.ok(text.includes('01-01') || text.includes('12-31') || /\d\d-\d\d \d\d:\d\d/.test(text), '带时刻')

  const long = '啊'.repeat(200)
  const clipped = renderSharedContext([conv({ userText: long, sessionId: 's9' })], 'me', 1)
  assert.ok(clipped.includes('…'), '长句要截断(别把上下文预算吃掉)')
  assert.ok(clipped.length < 400)
})

test('跨会话:宿主注入残留不许当成「他刚说过的话」(2026-09-26 现场)', () => {
  // 活库实测:conversation_log 100 行里 44 行正文是宿主每轮注入的
  // runtime context。这段补的是「他刚刚在别处说了什么」—— 不过滤的话,
  // 她会把「Current runtime context. This snapshot supersedes…」当成
  // 他刚说的话读进去(与记忆层同一个病,同一份判据挡)。
  const rows = [
    conv({ sessionId: 's1', userText: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }),
    conv({ sessionId: 's2', userText: '阿岚，我今天很累' })
  ]
  const text = renderSharedContext(rows, 'me', 4)
  assert.ok(!text.includes('Current runtime context'), '宿主注入不许进共享窗口:' + text)
  assert.ok(!text.includes('snapshot supersedes'))
  assert.ok(text.includes('阿岚，我今天很累'), '真的人话照旧注入')
  // 全是噪音 → 不注入空壳(与「没有别处的对话」同款)
  const only = renderSharedContext([conv({ sessionId: 's1', userText: 'This snapshot supersedes earlier runtime-context snapshots.' })], 'me', 4)
  assert.equal(only, '')
})

test('跨会话:她自己的 extractor / 别的插件的提示词也不许当成「他刚说过的话」(v0.30.2)', () => {
  // 2026-09-27 晚现场:他问「为什么人格没有改变,依然是冷冰冰的」。
  // 会话存档实测(session-echo-companion,11,846 字那条):【别处刚说过的】
  // 紧跟在人格后段之后,四条里有它自己的 extractor 提示词,渲染成「他:…」。
  // 活库口径:100 行 conversation_log 里 71 行渠道为空,53 行是这类机器提示词。
  const rows = [
    conv({ sessionId: 'sub-1', userText: '你是一个严格的记忆与情绪反思模块,同时是一个保守的记忆候选提取器。 你分析用户(她的唯一主人)与助手 Echo 的最近一轮对话,输出一个 JSON 对象。' }),
    conv({ sessionId: 'sub-2', userText: '你是「Almost Full Access」插件的命令安全审查员，负责审查一条即将在这台 Windows 电脑上执行的命令。' }),
    conv({ sessionId: 'sub-3', userText: '你在为项目 dsh-echo 整理架构文档素材。项目简介：dsh-echo 是一个跑在 DeepSeek Harness 里的陪伴插件' }),
    conv({ sessionId: 's9', userText: '阿岚，我今天很累' })
  ]
  const text = renderSharedContext(rows, 'me', 4)
  assert.ok(!text.includes('记忆与情绪反思模块'), 'extractor 提示词不许进共享窗口:' + text)
  assert.ok(!text.includes('命令安全审查员'), '别的插件的提示词不许进')
  assert.ok(!text.includes('整理架构文档素材'), '子代理任务提示不许进')
  assert.ok(text.includes('阿岚，我今天很累'), '真的人话照旧注入')
  // 只剩机器话 → 不注入空壳(与「没有别处的对话」同款),否则等于白占预算
  const only = renderSharedContext([conv({ sessionId: 'sub-1', userText: '你是一个严格的记忆与情绪反思模块,同时是一个保守的记忆候选提取器。 你分析用户与助手 Echo 的最近一轮对话,输出一个 JSON 对象。' })], 'me', 4)
  assert.equal(only, '')
})

// ── v9.0.0(2026-09-26 当晚):他问「为什么她这个人格还是很偏离我给的要求呢?很冷硬」──
// 两处现场:① 桥的记账行让 0 变成「情绪强度 1」,渲染成「心里基本没什么波澜」——
// 「没数」被读成「她无所谓」;② 实测 78% 的轮次落在低两档,而那两档原来写着
// 「没什么波澜」「还不至于真的动气或动情」—— 她每轮都在读「我不想动情」。

test('v9.0.0 没读数 ≠ 无波澜:0/null 不当成「情绪强度 1」', () => {
  const base = { emotionVector: { global: { fatigue: 2 } } }
  // ① 桥的记账行恒 0 → 沿用上一轮
  const noRead = describeMood({ ...base, moodIntensity: 0, prevMoodIntensity: 3 })
  assert.ok(!noRead.includes('没什么波澜'), '没读到的数不许编成无波澜:' + noRead)
  assert.ok(!noRead.includes('这一句之后变成'), '没有读数就没有「变化」')
  assert.ok(noRead.includes('这一轮没读到新的情绪读数'), noRead)
  assert.ok(noRead.includes('延续上一轮的 3/10'), '沿用上一轮:' + noRead)

  // ② 两边都没有 → 不编强度、也不给档位短语(档位短语会说谎)
  const none = describeMood({ ...base, moodIntensity: null, prevMoodIntensity: 0 })
  assert.ok(none.includes('这一轮没有情绪读数'), none)
  assert.ok(!none.includes('当下整体感受'), '没有数就别给档位短语:' + none)

  // ③ 有当前、没上一轮 → 只说当前,不硬凑 delta
  const onlyCur = describeMood({ ...base, moodIntensity: 6, prevMoodIntensity: null })
  assert.ok(onlyCur.includes('这一句之后你的情绪强度是 6/10'), onlyCur)
  assert.ok(!onlyCur.includes('变化'), '缺上一轮就不谈变化:' + onlyCur)

  // ④ 两边都有 → 与旧版逐字一致(不许回归)
  const both = describeMood({ ...base, moodIntensity: 6, prevMoodIntensity: 4 })
  assert.ok(both.includes('上一轮结束时你的情绪强度是 4/10,这一句之后变成 6/10(变化 +2)'), both)
})

test('v9.0.0 低两档读起来是暖的常态(不再教她「不想动情」)', () => {
  const base = { emotionVector: { global: { fatigue: 2 } } }
  // 档位表是**大于等于**语义(pickLevel:`value >= threshold` 才上抬):
  // 实测 1~3 落第 1 档、4~5 落第 2 档、6~7、8~9、10 依次往上。
  const low1 = describeMood({ ...base, moodIntensity: 3, prevMoodIntensity: 3 })
  const low3 = describeMood({ ...base, moodIntensity: 5, prevMoodIntensity: 5 })
  assert.ok(low1.includes('安静,但在他身边是松的'), low1)
  assert.ok(low3.includes('有一点在意,语气里带得出亲近'), low3)
  for (const t of [low1, low3]) {
    assert.ok(!t.includes('心里基本没什么波澜'), '旧措辞必须走干净:' + t)
    assert.ok(!t.includes('还不至于真的动气或动情'), '旧措辞必须走干净:' + t)
  }
  // 高两档不动(那是战斗档,本来就该硬);10 才落到最后一档(9 是「情绪上头」)
  assert.ok(describeMood({ ...base, moodIntensity: 9, prevMoodIntensity: 9 }).includes('情绪上头'), '9 应落第 4 档')
  assert.ok(describeMood({ ...base, moodIntensity: 10, prevMoodIntensity: 10 }).includes('几乎压不住'), '10 应落第 5 档')
})

test('v9.0.0 行为要求尾巴补上「安静不等于变冷」,而且它是最后一句', () => {
  const t = describeMood({ moodIntensity: 3, prevMoodIntensity: 3, emotionVector: { global: { fatigue: 2 } } })
  assert.ok(t.includes('情绪往下掉时,回复更轻、更慢、更少主动挑起话题'), '原来的行为要求还在:' + t)
  assert.ok(t.includes('但安静不等于变冷'), '补的边界要在')
  assert.ok(t.trim().endsWith('别把话收干。'), '它该是最后一句(尾部才是锚点):' + t.slice(-40))
})

// ---- v0.18.3 M3:画像常驻锚点进信封(A `brain_pipeline.py:1199-1213`)----

test('M3:画像常驻锚点在信封里出现,称呼仍单独一行', () => {
  const block = renderMemoryBlock({
    memories: [], state: { moodIntensity: 5 }, profile: { name: '阿岚', coreTraits: ['语言:中文', '代词:他'] }
  })
  assert.ok(block.includes('[他的称呼] 阿岚'), block)
  assert.ok(block.includes('[他的画像] 语言:中文 · 代词:他'), block)
})

test('M3:没有常驻锚点就整行不出现;空数组也不留空壳', () => {
  const none = renderMemoryBlock({ memories: [], state: { moodIntensity: 5 }, profile: { name: '阿岚' } })
  assert.ok(!none.includes('[他的画像]'), none)
  const empty = renderMemoryBlock({
    memories: [], state: { moodIntensity: 5 }, profile: { name: '阿岚', coreTraits: ['', '  '] }
  })
  assert.ok(!empty.includes('[他的画像]'), empty)
  // 旧形状(直接给对象/字符串)不该炸,也不该渲染出半句
  const weird = renderMemoryBlock({
    memories: [], state: { moodIntensity: 5 }, profile: { name: '阿岚', coreTraits: { 语言: '中文' } }
  })
  assert.ok(!weird.includes('[他的画像]'), weird)
})

test('M3:画像行有硬上限(≤5 项、≤100 字)—— 旧库带进长内容也不污染 prompt', () => {
  const many = Array.from({ length: 8 }, (_, i) => '项' + i + ':' + '值'.repeat(30))
  const block = renderMemoryBlock({
    memories: [], state: { moodIntensity: 5 }, profile: { name: '阿岚', coreTraits: many }
  })
  const line = block.split('\n').find((l) => l.startsWith('[他的画像]'))
  assert.ok(line.length <= '[他的画像] '.length + 100, '这一行不该超过 100 字,实为 ' + line.length)
  // A 的写法是先取前 5 项、再整体截 100 字,所以末项可能被截断 —— 这里只
  // 保「不超过 5 项」,不假定 5 项都完整。
  assert.ok(line.split(' · ').length <= 5, '最多 5 项,实为 ' + line.split(' · ').length)
  assert.ok(line.includes('项0:'), '前几项必须在')
})

// ---- 2026-10-10:审计段划分 —— 接话块单列,别并进 rules ----
// 现场:面板上 `rules` 在 224 / 208 / 64 之间跳,被误读成「人设没送到」。
// 真相:`[使用纪律]` 是 renderInjectedBlock 硬编码的固定一行(64 字,永不条件
// 渲染),而【你刚主动说过】拼在它**之后** ⇒ 因为 `[使用纪律]` 是最后一个
// 段头,那一整块被算进了 `rules`。⭐ 这三个数是**活库实测的原文**,不是编的。

const DISCIPLINE_LINE = '[使用纪律] 把这些当作你真实的记忆与感受,自然融入回复;不要复述本段。回忆与当前话题无关时不必硬提;能自然接住他的话头就带上。'

test('段划分:接话块单列成 ack,rules 不再吸走接话块', () => {
  assert.equal(DISCIPLINE_LINE.length, 64, '固定行长度就是 64 —— 这个数变了说明渲染改了')

  // 20:41 那轮的真实形状:rules=208,其中 64 是那一行、3 是换行、141 是接话块本体
  const ackBody = '【你刚主动说过】' + '字'.repeat(141 - '【你刚主动说过】'.length)
  const text = DISCIPLINE_LINE + '\n\n\n' + ackBody
  const c = sectionCounts(text)
  // ⚠️ 口径:段 = 「从本段头到下一个段头」。所以两段头之间的换行算进**前一段**。
  // 故 rules = 64 + 3(换行),不再是修之前的 208(把整个接话块都吞了)。
  assert.equal(c.rules, 64 + 3, 'rules 只应是那一行 + 分隔换行;修之前这里是 208')
  assert.equal(c.ack, ackBody.length, '接话块要能单独看见')
  assert.equal(c.rules + c.ack, text.length, '两段相加 = 全文(没有字被漏掉)')
  assert.ok(!String(c.rules).startsWith('2'), '回归守卫:rules 绝不该再出现 200 量级')

  // 没有接话块的那轮(21:59):rules=64、ack=0
  const alone = sectionCounts(DISCIPLINE_LINE)
  assert.equal(alone.rules, 64, '无接话块时 rules 恰为那一行')
  assert.equal(alone.ack, 0, '没接话块时 ack 记 0(没出现的段记 0)')
})

test('段划分:ack 出现在中间也切得对(不是"只认最后一个")', () => {
  const text = DISCIPLINE_LINE + '\n【你刚主动说过】接了话\n尾巴'
  const c = sectionCounts(text)
  assert.equal(c.rules, DISCIPLINE_LINE.length + 1, 'rules = 那一行 + 1 个换行')
  assert.equal(c.ack, text.length - DISCIPLINE_LINE.length - 1)
})

test('段划分:真实注入块的七段齐全,且各段不重叠', () => {
  const block = renderInjectedBlock({
    memoryText: '【关联知识路径】\n1. [核心] 用户-[就读于]-> 西电\n【情景记忆】\n- 某件事',
    state: { moodIntensity: 5 },
    profile: { name: '阿岚' },
    now: NOW
  })
  const c = sectionCounts(block)
  // 没出现的段记 0,出现的段必须 > 0
  assert.ok(c.now > 0 && c.time > 0 && c.paths > 0 && c.epi > 0 && c.state > 0 && c.rules > 0)
  assert.equal(c.ack, 0, '这一块没有接话块')
  // ⚠️ 各段之和不等于全文 —— **首行抬头**(`[她的记忆与心情 …]`,29 字)在第一个
  // 段头之前,不属于任何一段(口径如此:只从段头往后算)。要钉的是**上界**
  // 与**不重叠**,不是"铺满"。
  const sum = c.now + c.time + c.paths + c.epi + c.state + c.rules + c.ack
  assert.ok(sum <= c.total, '各段之和不得超过全文(有重叠就会超)')
  assert.ok(c.total - sum <= 40, '未被计入的只应是那个抬头,实差 ' + (c.total - sum))
})