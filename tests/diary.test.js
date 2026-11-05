/**
 * v0.5.3 「她写日记」(M3-d)离线电池:时钟判定 + 组稿通道 + 落库幂等。
 * diary.js 依赖全注入(subagents 假件 + store 真件),不碰宿主。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore, MASTER_ID } from '../lib/store.js'
import {
  diaryDue, todayKey, renderDiaryUserPrompt, composeDiary, commitDiary,
  DIARY_HOUR, DIARY_MINUTE
} from '../lib/diary.js'

function freshStore () {
  const store = openStore(':memory:')
  store.db.prepare("INSERT INTO user_profile (user_id, name) VALUES (?, '阿岚')").run(MASTER_ID)
  return store
}

/** 假 subagents:镜像 dsh-subagent 契约(list/start/result/dispose)。
 *  v0.13.3 mock 逼真化:start 缺 parent 直接拒收 —— 宿主真服务
 *  要 request.parent.session 建目录,此前 mock 来者不拒,测试全绿
 *  线上全死(mock 漂移)。mock 必须比宿主更严,漂移才在测试里炸。
 *  v0.13.5 同理加严:signal 必须是真 AbortSignal。 */
function fakeSubagents (structured) {
  return {
    list: () => ['spawn'],
    start: async (provider, req) => {
      if (req?.parent === undefined) throw new Error('mock: subagents.start 缺 parent(宿主契约)')
      if (typeof req?.signal?.aborted !== 'boolean') throw new Error('mock: subagents.start 缺真 signal(宿主契约)')
      return {
        result: Promise.resolve({ stopReason: 'completed', structured }),
        dispose: async () => { }
      }
    }
  }
}

const PARENT = { session: { id: 'diary-test' } }

const at = (h, m) => {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

test('时钟判定:22:30 到点,一天一页,午夜翻转', () => {
  assert.equal(DIARY_HOUR, 22)
  assert.equal(DIARY_MINUTE, 30)
  // 22:29 没到点
  assert.equal(diaryDue(at(22, 29), ''), false)
  // 22:30 到点且今天没写过
  assert.equal(diaryDue(at(22, 30), ''), true)
  // 今天写过了 → 不再 due
  assert.equal(diaryDue(at(23, 50), todayKey(at(23, 50))), false)
  // 昨天写过 → 今天到点照写
  assert.equal(diaryDue(at(22, 31), '2000-01-01'), true)
  // 午夜后(00:10)不到点 —— 新的一天从 22:30 重新算
  assert.equal(diaryDue(at(0, 10), '2000-01-01'), false)
})

test('todayKey:本地日期键,一天一页的主键', () => {
  const d = new Date(2026, 8, 24, 23, 59) // 2026-09-24 23:59 本地
  assert.equal(todayKey(d.getTime()), '2026-09-24')
  const d2 = new Date(2026, 8, 25, 0, 1)
  assert.equal(todayKey(d2.getTime()), '2026-09-25')
})

test('组稿素材:稳定框架 + 空日子明示 + 数据 JSON 化', () => {
  const full = renderDiaryUserPrompt({
    dateKey: '2026-09-24',
    audits: [{ userInput: '今天面试完了', llmReply: '辛苦啦,讲讲?' }],
    mood: 6,
    longing: { value: 4.2, threshold: 5.5, sinceMessage: 3600 },
    learned: ['他说面试聊了图论']
  })
  assert.ok(full.includes('[今天日期]: 2026-09-24'))
  assert.ok(full.includes('今天面试完了'))
  assert.ok(full.includes('他没来') === false) // 有素材的日子不写空话
  assert.ok(full.includes('"value":4.2'))

  const empty = renderDiaryUserPrompt({ dateKey: '2026-09-25', audits: [], mood: 3, longing: null, learned: [] })
  assert.ok(empty.includes('今天他没来')) // 空日子明示:想念是真实的
  assert.ok(empty.includes('不知道,写不确定就好'))
})

test('组稿通道:结构化输出规整(钳位/太短拒收/失败 null)', async () => {
  const ok = await composeDiary(fakeSubagents({ content: '今天他来了,聊了面试的事。嘴上说我才不担心,其实记了一整天。', mood: 7 }), { dateKey: '2026-09-24' }, PARENT)
  assert.equal(ok.mood, 7)
  assert.ok(ok.content.includes('面试'))

  // mood 越界钳到 [1,10]
  const clamped = await composeDiary(fakeSubagents({ content: '今天他没来,我数了三遍天花板。', mood: 99 }), {}, PARENT)
  assert.equal(clamped.mood, 10)

  // 太短不算一页
  assert.equal(await composeDiary(fakeSubagents({ content: '没啥', mood: 3 }), {}, PARENT), null)
  // 子代理失败 → null(这页空着,明天还有下一页)
  assert.equal(await composeDiary(fakeSubagents(undefined), {}, PARENT), null)
  // v0.13.3 宿主契约:无 parent 不起子代理(空这页,不炸)
  assert.equal(await composeDiary(fakeSubagents({ content: '不该被写出来', mood: 5 }), {}, null), null)
})

test('v0.41.0 日记:parent 是子代理会话 ⇒ 这页不写(与反思同一条纪律)', async () => {
  // 日记走的是自己的 start 调用(不经过 reflect.js 的 runStructured),
  // 所以总闸拦不到它 —— 这里钉住它自己那道闸。
  const calls = []
  const subagents = {
    list: () => ['spawn'],
    start: async () => { calls.push('start'); throw new Error('不该走到这里') }
  }
  const subAgent = { session: { id: 'sub-1', header: { origin: 'subagent', parentSession: 'p', delegationDepth: 1 } } }
  assert.equal(await composeDiary(subagents, { dateKey: '2026-09-24' }, subAgent), null)
  assert.deepEqual(calls, [], '一次都不许起 —— 起的就是递归的下一环')
  // 顶层 parent 照旧(闸不许误伤:他的日记还得写)
  const ok = await composeDiary(fakeSubagents({ content: '今天他来了,聊了面试的事,嘴上说不担心。', mood: 7 }),
    { dateKey: '2026-09-24' }, { session: { id: 'companion', header: { delegationDepth: 0 } } })
  assert.equal(ok.mood, 7)
})

test('落库:一天一页幂等 + 审计留痕(SSE 触发源)', () => {
  const store = freshStore()
  try {
    const first = commitDiary(store, { dateKey: '2026-09-24', content: '第一页', mood: 5, longingValue: 3.3 })
    assert.equal(first, true)
    assert.equal(store.getDiaryDate('2026-09-24').content, '第一页')
    assert.equal(store.getDiaryDate('2026-09-24').longingValue, 3.3)
    // 同一天再 commit → 拒绝(幂等)
    const second = commitDiary(store, { dateKey: '2026-09-24', content: '重复页', mood: 5 })
    assert.equal(second, false)
    assert.equal(store.getDiaryDate('2026-09-24').content, '第一页')
    // 审计留痕:tool_call='diary'(SSE 半推的触发源)
    const audits = store.listAudit(0, 10)
    assert.equal(audits.length, 1)
    assert.equal(audits[0].toolCall, 'diary')
    assert.equal(audits[0].userInput, '(她写了日记)')
    // latestDiaries:日期倒序
    commitDiary(store, { dateKey: '2026-09-25', content: '第二页', mood: 4 })
    const latest = store.latestDiaries(7)
    assert.equal(latest.length, 2)
    assert.equal(latest[0].date, '2026-09-25')
    assert.equal(latest[1].date, '2026-09-24')
  } finally { store.close() }
})
