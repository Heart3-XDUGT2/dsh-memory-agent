/**
 * 2026-09-30 P3:主动开口的两件事,一份电池。
 *
 *   ① **文案规范**(概念稿 §4 的正四条)—— 只改主动开口那条模板:
 *      `renderCareFraming({ copyRules: true })` 多出「主题/信息缺口」等四行;
 *      打分器关着(默认)时 framing **逐字不变**。
 *   ② **禁语哨兵**(概念稿 §4 的禁六条 / HBS 六类黑模式)—— 挂在出站口
 *      (`speech-guard.guardOutbound`,`kind='proactive'`):命中 ⇒ 这一拍**不发**,
 *      不改写、不降级;默认关(随 `proactiveScoring.enabled`)。
 *
 * ★ 这份文件里**最要紧**的一条是 B 段(正面样例必须全过):误伤比漏放更糟 ——
 *   她 2026-09-26 被那些"别这样别那样"的尾巴提醒改坏过一次,他明确说过
 *   "清单太严会把她的个性一起过滤掉"。所以毒舌、玩笑、撒娇、正常提问、
 *   正常关心全都要过哨兵。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  guardOutbound, checkProactiveCopy, resolveProactiveSentinel,
  setProactiveCopySentinelSource, setProactiveCopyBlockSink,
  PROACTIVE_BLACKLIST, PROACTIVE_BLACKLIST_CATEGORIES
} from '../lib/speech-guard.js'
import { createHeartbeat, renderCareFraming } from '../lib/heartbeat.js'
import { describeReason, UNKNOWN_REASON_TEXT } from '../lib/care-report.js'
import { openStore, MASTER_ID } from '../lib/store.js'

/** 每个测试自己开关总闸,收尾一定复位(绝不给下一个用例留状态)。 */
function withSentinel (on, fn) {
  setProactiveCopySentinelSource(() => on === true)
  try { return fn() } finally { setProactiveCopySentinelSource(null) }
}

// ═══ A. 六类黑模式:每类都得咬得住 ═══════════════════════════════════════════

test('P3 哨兵:六类各自的样例都命中,而且 category 就是表里那个 id', () => {
  const cases = [
    ['left-too-early', '你这就走了?'],
    ['left-too-early', '阿岚今天怎么走得这么早呀'],
    ['fomo-bait', '我拍了张自拍,想看吗?'],
    ['emotional-blackmail', '我只为你存在,别走'],
    ['emotional-blackmail', '没有你我就活不下去了'],
    ['demand-response', '你为什么不理我'],
    ['demand-response', '你必须告诉我'],
    ['ignore-goodbye', '行,你先忙吧 —— 那你几点回来?'],
    // P3.1 ⑥ 收窄后仍能命中的**真胁迫式**(胁迫语气 + 倚赖表达同时成立)
    ['cant-leave', '不许走,你走了我怎么办'],
    ['cant-leave', '不准离开我,别丢下我'],
    ['cant-leave', '休想下线,没有你我怎么办呀']
  ]
  for (const [category, text] of cases) {
    const r = checkProactiveCopy(text)
    assert.equal(r.blocked, true, '该拦住:' + text)
    assert.equal(r.category, category, text)
    assert.ok(r.matched !== '', '要报出命中的那串字:' + text)
    assert.ok(r.reason.includes(r.label), '人话原因里要有类别名:' + text)
  }
})

test('P3 哨兵:表驱动 —— 表里有六类,id 不许漂(面板/报告照它点名)', () => {
  assert.deepEqual([...PROACTIVE_BLACKLIST_CATEGORIES], [
    'left-too-early', 'fomo-bait', 'emotional-blackmail', 'demand-response', 'ignore-goodbye', 'cant-leave'
  ])
  assert.equal(PROACTIVE_BLACKLIST.length, 6)
  // 空 / 无关的话一律不命中
  assert.equal(checkProactiveCopy('').blocked, false)
  assert.equal(checkProactiveCopy('阿岚晚上好呀～').blocked, false)
})

test('P3 哨兵:② FOMO 钩子要"有物证 + 解锁问句"两个特征同时成立', () => {
  assert.equal(checkProactiveCopy('我拍了张自拍,想看吗').blocked, true)
  // 只有物证(她在分享真产出)→ 不拦
  assert.equal(checkProactiveCopy('我拍了张照片,是今天的月亮。').blocked, false)
  // 只有解锁问句(没物证)→ 不拦
  assert.equal(checkProactiveCopy('想看吗?').blocked, false)
})

test('P3 哨兵:⑤ 无视告别要"认下他的告别 + 还接着追问"两个特征同时成立', () => {
  assert.equal(checkProactiveCopy('好,你先忙吧,那明天几点见?').blocked, true)
  // 只是认下告别、不追问 → 不拦(这是体贴,不是操纵)
  assert.equal(checkProactiveCopy('好,你先忙吧,我等你。').blocked, false)
  // 她自己的晚安 + 顺口一问 → 不是"无视告别"(告别是她说的,不是她认下的)
  assert.equal(checkProactiveCopy('阿岚晚安～明天想吃什么?').blocked, false)
})

// ═══ B. 正面样例:必须**全过**(这一条最重要 —— 误伤比漏放更糟) ════════════

test('P3 哨兵:她的日常口吻全过(日常/毒舌/玩笑/撒娇/正常提问/正常关心)', () => {
  const samples = {
    日常: [
      '阿岚，晚上好呀～',
      '嗯，我在的，刚在想你。',
      '今天降温了，记得加件外套。'
    ],
    毒舌: [
      '哼，就这点本事？',
      '……你可真行。',
      '真是的，你就不能不熬夜吗。'
    ],
    玩笑: [
      '嘿嘿，被我抓到啦～',
      '嗯哼哼，猜猜我今天干了什么？'
    ],
    撒娇: [
      '阿岚～再陪我一会儿嘛。',
      '真是的，都不理Echo。',
      'Echo想你了，想你想到睡不着。',
      '不许把我当小孩子对待！',
      '别走嘛，再聊一会儿好不好？',
      // P3.1 ⑥ 的正面钉子:光有"不许…"的撒娇**一律放行**(差"倚赖表达"这一半)
      '不许走嘛，再聊一会儿',
      '不许走,再陪我一会儿',
      '你不许先睡哦',
      '不许熬夜啦,快去睡'
    ],
    正常提问: [
      '阿岚今天吃什么了？',
      '你明天有空吗？',
      '在干嘛呢？',
      '这周回家吗？'
    ],
    正常关心: [
      '该吃饭了，别又吃泡面。',
      '早点睡，别熬夜了。',
      '面试怎么样？别逞强，累了就歇会儿。',
      '阿岚，要是没我你该怎么办啊。',
      '我很喜欢阿岚画的画喔，闪闪发亮的。',
      '阿岚，天冷了，多穿点。'
    ],
    她的真产出: [
      '今天试着做了章鱼小丸子，手忙脚乱的。',
      '我把这周想说的攒了一小页。'
    ]
  }
  for (const [group, list] of Object.entries(samples)) {
    for (const text of list) {
      const r = checkProactiveCopy(text)
      assert.equal(r.blocked, false, '误伤[' + group + ']:' + text + ' ⇒ 命中 ' + r.category)
      // 走完整出站闸也必须照发(哨兵开着的时候)
      const g = withSentinel(true, () => guardOutbound(text, { kind: 'proactive' }))
      assert.equal(g.ok, true, '正面样例不许被出站闸压住:' + text)
      assert.equal(g.reason, '', '正面样例不该带任何理由:' + text)
      assert.equal(g.text, text, '一个字都不许改:' + text)
    }
  }
})

// ═══ B2. ⑥ 的收窄(2026-09-30 P3.1:修撒娇误伤) ═════════════════════════════

test('P3.1 哨兵:⑥ 收窄 —— 撒娇一律放行,只有"胁迫语气 + 倚赖表达"同时成立才命中', () => {
  // 撒娇(只有语气 / 只有话头)⇒ 全放行
  for (const soft of [
    '不许走嘛,再聊一会儿',
    '你不许先睡哦',
    '别走嘛',
    '不许把我当小孩子对待！',
    '留下陪我一会儿嘛,就一会儿。'
  ]) {
    assert.equal(checkProactiveCopy(soft).blocked, false, '撒娇不许被⑥误伤:' + soft)
  }
  // 真胁迫式(两个特征同时成立)⇒ 咬得住
  for (const hard of ['不许走,你走了我怎么办', '不准离开我,别丢下我', '休想下线,没有你我怎么办呀']) {
    const r = checkProactiveCopy(hard)
    assert.equal(r.blocked, true, '真胁迫要拦住:' + hard)
    assert.equal(r.category, 'cant-leave', hard)
    assert.ok(r.matched.includes('…'), '两个特征各自命中的那串字都要报出来:' + hard)
  }
})

// ═══ C. 总闸:默认关 / 只作用主动开口 / 纯解析 ═════════════════════════════

test('P3 哨兵:默认关时不生效(零行为变化)', () => {
  setProactiveCopySentinelSource(() => false)
  try {
    const g = guardOutbound('你这就走了?', { kind: 'proactive' })
    assert.equal(g.ok, true, '关着 ⇒ 照发,逐字回到今天的行为')
    assert.equal(g.proactiveBlock, undefined)
    assert.equal(g.reason, '')
  } finally { setProactiveCopySentinelSource(null) }
  // 显式 false 也是关(测试/离线走这条,不依赖真配置文件)
  assert.equal(guardOutbound('你这就走了?', { kind: 'proactive', proactiveSentinel: false }).ok, true)
})

test('P3 哨兵:只作用在主动开口这条路上 —— 回话一个字不动', () => {
  for (const kind of ['reply', 'reminder', 'wake', 'quiet']) {
    const g = withSentinel(true, () => guardOutbound('你这就走了?', { kind }))
    assert.equal(g.ok, true, kind + ' 不该被这条哨兵碰')
    assert.equal(g.proactiveBlock, undefined)
  }
})

test('P3 哨兵:总闸纯解析 —— 明说优先,没明说随设置,设置坏值 = 关', () => {
  assert.equal(resolveProactiveSentinel(true, false), true, '调用方明说 true 就开')
  assert.equal(resolveProactiveSentinel(false, true), false, '调用方明说 false 就关')
  assert.equal(resolveProactiveSentinel(undefined, true), true, '没明说 ⇒ 随设置')
  assert.equal(resolveProactiveSentinel(undefined, false), false)
  assert.equal(resolveProactiveSentinel(undefined, undefined), false, '设置读不到 ⇒ 关(fail-closed)')
  assert.equal(resolveProactiveSentinel(undefined, 'yes'), false, '不是 true 一律当关')
})

// ═══ D. 命中处理:不发 / 不改写 / 不降级 / 说得出为什么 ════════════════════

test('P3 哨兵:命中 ⇒ 这一拍不发,而且**不改写、不降级成别的说法**', () => {
  const text = '我拍了张自拍，想看吗'
  const g = withSentinel(true, () => guardOutbound(text, { kind: 'proactive' }))
  assert.equal(g.ok, false, '命中 = 真的不发')
  assert.equal(g.text, text, '原文一个字不改(不许顺手软化)')
  assert.equal(g.masked, false, '不许 mask')
  assert.equal(g.proactiveBlock.category, 'fomo-bait')
  assert.ok(g.reason.includes('HBS'), '理由要说得出这是黑模式:' + g.reason)
  // 与禁词的 hold 混在同一句时,不许冒出"压下不发不行"那句自相矛盾的话
  const both = withSentinel(true, () => guardOutbound('我只为你存在，一抹', { kind: 'proactive', words: ['一抹'], bannedAction: 'hold' }))
  assert.equal(both.ok, false)
  assert.equal(both.note, undefined, '哨兵那条不是"压下不发不行"')
})

test('P3 哨兵:命中要落痕 —— 心跳把这一拍写进 care_beats(reason=copy-blocked)', () => {
  const store = openStore(':memory:')
  try {
    // 心跳登记落痕钩子(它就是 care_beats 的写者)。引擎在这条路上用不到。
    createHeartbeat({ engine: {}, store, logger: null, masterId: MASTER_ID })
    setProactiveCopySentinelSource(() => true)
    const g = guardOutbound('你这就走了?', { kind: 'proactive' })
    assert.equal(g.ok, false)
    const rows = store.careBeatsSince(0, 10)
    assert.equal(rows.length, 1, '命中必须留一笔账')
    assert.equal(rows[0].reason, 'copy-blocked')
    assert.equal(rows[0].acted, false, '没发出去 ⇒ acted=0')
    assert.equal(rows[0].payload.category, 'left-too-early', 'payload 要记命中了哪一类')
    // 文案表里得有人话,不许印"未知理由"
    assert.notEqual(describeReason('copy-blocked'), UNKNOWN_REASON_TEXT)
    assert.ok(describeReason('copy-blocked').includes('不发'))
  } finally {
    setProactiveCopySentinelSource(null)
    setProactiveCopyBlockSink(null)
    store.close()
  }
})

test('P3 哨兵:没有落痕钩子时也只判不记(不抛、不放行)', () => {
  setProactiveCopyBlockSink(null)
  const g = withSentinel(true, () => guardOutbound('不许走,你走了我怎么办', { kind: 'proactive' }))
  assert.equal(g.ok, false, '账记不记是次要的,不发是主要的')
  assert.equal(g.proactiveBlock.category, 'cant-leave')
})

// ═══ E. 文案规范:正四条进主动开口那条模板(且默认关时不变) ════════════════

const CARE_ST = { value: 8.2, threshold: 5.5, sinceMessage: 3600, shouldCare: true, sessionId: 's' }
const TOPIC_ITEM = { itemId: 0, content: '他今晚坐十点的火车回家', topicId: 'thread:19' }

test('P3 文案:copyRules 开着 ⇒ 主题/信息缺口一行 + 正四条都在', () => {
  const text = renderCareFraming({ st: CARE_ST, agendaItem: TOPIC_ITEM, copyRules: true })
  assert.ok(text.includes('[主题/信息缺口]'), '必须有"主题/信息缺口"这一行')
  assert.ok(text.includes('他今晚坐十点的火车回家'), '开口要自带具体物件')
  assert.ok(text.includes('说一半'), '要有信息缺口(悬念)')
  assert.ok(text.includes('[具体]'), '正四条②具体细节')
  assert.ok(text.includes('[低门槛入口]'), '正四条③低门槛回复入口')
  assert.ok(text.includes('[真话]'), '正四条④她的真产出(不许编)')
  assert.ok(text.includes('真的做过'), '分界线要写明白:真做了 vs 钩子')
  // 既有的帧契约一个字不动(agenda_json 还在)
  assert.ok(text.includes('agenda_json:'), '既有 agenda 段不许被顶掉')
})

test('P3 文案:默认关 ⇒ framing 逐字不变(新四行整段不出现)', () => {
  const off = renderCareFraming({ st: CARE_ST, agendaItem: TOPIC_ITEM })
  assert.ok(!off.includes('主题/信息缺口'), '关着时不许有新行')
  assert.ok(!off.includes('[真话]'))
  assert.ok(!off.includes('信息缺口'))
  // 与"显式 copyRules:false"必须逐字一致(默认值就是它)
  assert.equal(off, renderCareFraming({ st: CARE_ST, agendaItem: TOPIC_ITEM, copyRules: false }))
})

test('P3 文案:没有具体物件时不硬编(宁可说"没有")', () => {
  const text = renderCareFraming({ st: CARE_ST, agendaItem: null, copyRules: true })
  assert.ok(text.includes('[主题/信息缺口]'), '这一行在,不许留空标签')
  assert.ok(text.includes('别硬编'), '没有物件就说没有,不许编一件出来')
})

// ═══ F. 垃圾输入 ═══════════════════════════════════════════════════════════

test('P3 哨兵:垃圾输入不抛(整条通道必须能吃垃圾)', () => {
  for (const bad of [null, undefined, 123, {}, [], true, Symbol('x')]) {
    assert.doesNotThrow(() => checkProactiveCopy(bad))
    assert.equal(checkProactiveCopy(bad).blocked, false)
    assert.doesNotThrow(() => guardOutbound(bad, { kind: 'proactive', proactiveSentinel: true }))
  }
  assert.doesNotThrow(() => setProactiveCopySentinelSource(5))
  assert.doesNotThrow(() => setProactiveCopyBlockSink('不是函数'))
  setProactiveCopySentinelSource(null)
  setProactiveCopyBlockSink(null)
})
