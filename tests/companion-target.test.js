/**
 * 「他正在用的那条会话」是谁 —— 2026-09-29 裁定 A(QQ 跟着他走)。
 *
 * 现场:他在 DSH 里开着窗口 A 跟她说话,QQ 的消息却进了插件自建的
 * `session-echo-companion` ⇒ 她的回复出现在"隔壁窗口"(他当场问:
 * 「为什么给他发消息,他是在另外一个会话上面进行回复的」)。
 * 裁定 A = QQ 进他正在用的那条;挑不出来才退回陪伴会话。
 *
 * 这里钉的是**挑选判据**本身(纯函数):哪些候选算"他在用"、哪些必须被排除。
 * 排除掉任何一条,线上表现就是"她的回复又跑到别的窗口去了"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickHisSession, describeRoute, DEFAULT_COMPANION_ID } from '../lib/companion-target.js'

const agent = (id) => ({ session: { id } })

/** 一次挑选:候选用 {id, at} 描述,范围闸由 `outOfScope` 指定。 */
function pick (rows, { outOfScope = [], companionId = DEFAULT_COMPANION_ID, since = 0, topLevel = () => true } = {}) {
  const list = Array.isArray(rows) ? rows : null
  return pickHisSession({
    // `agent` 显式给了就用给的(测"没有 agent"那一档),没给才合成一个
    candidates: list === null ? null : list.map((r) => ({
      sessionId: r.id,
      agent: Object.hasOwn(r, 'agent') ? r.agent : agent(r.id),
      lastUserTurnAt: r.at ?? 0
    })),
    inScope: (sid) => !outOfScope.includes(sid),
    isTopLevel: topLevel,
    companionId,
    since
  })
}

test('挑最近说过话的那条(多条都合格时它赢)', () => {
  const hit = pick([
    { id: 'sess-a', at: 100 },
    { id: 'sess-b', at: 300 },
    { id: 'sess-c', at: 200 }
  ], { since: 50 })
  assert.equal(hit.sessionId, 'sess-b')
  assert.equal(hit.lastUserTurnAt, 300)
})

test('陪伴会话不参与挑选(它是兜底,不是"他的窗口")', () => {
  const hit = pick([
    { id: DEFAULT_COMPANION_ID, at: 999 },
    { id: 'sess-a', at: 100 }
  ], { since: 50 })
  assert.equal(hit.sessionId, 'sess-a')
  // 只有陪伴会话在说话 ⇒ 挑不出来(null)⇒ 壳会退回 ensureCompanion
  assert.equal(pick([{ id: DEFAULT_COMPANION_ID, at: 999 }], { since: 50 }), null)
})

test('面板上关掉的会话不算(他关它是为了让她别在那儿冒头)', () => {
  const hit = pick([
    { id: 'sess-off', at: 999 },
    { id: 'sess-on', at: 100 }
  ], { outOfScope: ['sess-off'], since: 50 })
  assert.equal(hit.sessionId, 'sess-on')
})

test('子代理会话不算(她的打分/提取子代理也在跑会话)', () => {
  const hit = pick([
    { id: 'sess-child', at: 999 },
    { id: 'sess-top', at: 100 }
  ], { since: 50, topLevel: (a) => a.session.id !== 'sess-child' })
  assert.equal(hit.sessionId, 'sess-top')
})

test('太久没说话的不算(窗口期外的会话不是"他正在用")', () => {
  assert.equal(pick([{ id: 'sess-old', at: 10 }], { since: 50 }), null)
})

test('没有 agent 的候选不算(注入不进去)', () => {
  assert.equal(pick([{ id: 'sess-x', at: 999, agent: null }], { since: 50 }), null)
})

test('一条都不合格 ⇒ null(壳据此退回陪伴会话,不是报错)', () => {
  assert.equal(pick([], { since: 0 }), null)
  assert.equal(pick(null, { since: 0 }), null)
})

test('路由文案:两种路各有一句人话(审计与状态面共用)', () => {
  assert.ok(describeRoute('his-window').includes('他在用'))
  assert.ok(describeRoute('companion').includes('兜底'))
  assert.ok(describeRoute('fixed').includes('固定'))
  assert.ok(describeRoute(undefined).length > 0, '未知来源也要有话说,不许空串')
})
