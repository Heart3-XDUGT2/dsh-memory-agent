import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseArchivedIds, parseWorkspaceSessionIds, readWorkspaceState,
  visibleCandidates, pickVisibleSession
} from '../lib/companion-visibility.js'

// 2026-10-01 现场:重启后第一条 QQ 消息**静默**落进一条已归档、网页里一处都看不见的
// 会话(`session-echo-companion`)⇒ 他在 GUI 里再也找不到那次对话。
// 这套规则(归档集 / 已登记会话 / 挑替身)从此单独成模块,由这个电池直接钉住。
//
// 形状照抄 `$DSH_HOME/storages/workspace.json` 的实测结构(2026-10-01):
const FIXTURE = {
  global: {
    workspaceIds: ['ws-1'],
    archivedSessionIds: ['session-archived-a', 'session-echo-companion', '']
  },
  tables: {
    workspaces: {
      'ws-1': { path: 'C:\\x', title: 'plugins', sessionIds: ['session-a', 'session-b', 'session-b'] }
    }
  }
}

test('parseArchivedIds:坏形状 ⇒ null(不知道),不返回空集', () => {
  assert.equal(parseArchivedIds(undefined), null)
  assert.equal(parseArchivedIds({}), null)
  assert.equal(parseArchivedIds({ global: { archivedSessionIds: 'session-a' } }), null)
  // 空数组是**合法**的"确实没有归档" ⇒ 空集(与"不知道"是两回事)
  assert.equal(parseArchivedIds({ global: { archivedSessionIds: [] } }).size, 0)
  const set = parseArchivedIds(FIXTURE)
  assert.equal(set.has('session-echo-companion'), true)
  assert.equal(set.has(''), false, '空串是脏数据,不该进集合')
})

test('parseWorkspaceSessionIds:按 tables.workspaces 扁平化;坏形状 ⇒ []', () => {
  assert.deepEqual(parseWorkspaceSessionIds(FIXTURE), ['session-a', 'session-b', 'session-b'])
  assert.deepEqual(parseWorkspaceSessionIds({ tables: { workspaces: {} } }), [])
  assert.deepEqual(parseWorkspaceSessionIds(null), [])
  assert.deepEqual(parseWorkspaceSessionIds({ tables: { workspaces: { w: {} } } }), [])
})

test('readWorkspaceState:注入式读文件 —— 坏 JSON ⇒ archived=null(不知道)且候选为空', () => {
  const good = readWorkspaceState('x', () => JSON.stringify(FIXTURE))
  assert.equal(good.archived.has('session-echo-companion'), true)
  assert.deepEqual(good.sessionIds, ['session-a', 'session-b', 'session-b'])
  const bad = readWorkspaceState('x', () => '{ 坏 json')
  assert.equal(bad.archived, null)
  assert.deepEqual(bad.sessionIds, [])
  const missing = readWorkspaceState('x', () => { throw new Error('ENOENT') })
  assert.equal(missing.archived, null, '读不到 ⇒ 不知道(不阻断旧行为,但也绝不假装"没有归档")')
})

test('visibleCandidates:去重保序、排除给定会话、剔除归档的', () => {
  const arch = parseArchivedIds(FIXTURE)
  assert.deepEqual(visibleCandidates(['a', 'b', 'b', 'session-echo-companion'], arch, 'b'), ['a'])
  // archived=null(不知道)⇒ 谁都不剔除(旧行为:不阻断)
  assert.deepEqual(visibleCandidates(['a', 'session-echo-companion'], null), ['a', 'session-echo-companion'])
})

test('pickVisibleSession:他正在用的优先(但必须可见)', () => {
  const arch = parseArchivedIds(FIXTURE)
  const base = { sessionIds: ['session-a', 'session-b'], archived: arch, exclude: 'session-echo-companion' }
  assert.equal(pickVisibleSession({ ...base, preferred: 'session-b' }), 'session-b')
  // 首选那条自己就是被排除/被归档的 ⇒ 不许选它(这正是那个坑本身)
  assert.equal(pickVisibleSession({ ...base, exclude: 'session-b', preferred: 'session-b' }), 'session-a')
  assert.equal(pickVisibleSession({ ...base, preferred: 'session-echo-companion', lastTurnAt: (sid) => (sid === 'session-a' ? 500 : 100) }), 'session-a',
    '被归档的会话不许当首选 —— 那正是"消息落进黑洞"的复现')
})

test('pickVisibleSession:没有首选时按"他最后说话最晚"挑;挑不出来 ⇒ null', () => {
  const arch = parseArchivedIds(FIXTURE)
  const picked = pickVisibleSession({
    sessionIds: ['session-a', 'session-b'],
    archived: arch,
    lastTurnAt: (sid) => (sid === 'session-a' ? 100 : 200)
  })
  assert.equal(picked, 'session-b')
  assert.equal(pickVisibleSession({ sessionIds: [], archived: arch }), null)
  // 候选全被归档 ⇒ null(调用方必须明确失败,不许静默兜底到一条看不见的会话)
  assert.equal(pickVisibleSession({ sessionIds: ['session-echo-companion'], archived: arch }), null)
})

test('pickVisibleSession:archived=null(读不到)⇒ 不阻断;lastTurnAt 抛错 ⇒ 退到末尾那条', () => {
  assert.equal(pickVisibleSession({ sessionIds: ['x'], archived: null, exclude: 'y' }), 'x')
  assert.equal(pickVisibleSession({
    sessionIds: ['a', 'b'], archived: null, lastTurnAt: () => { throw new Error('账本炸了') }
  }), 'b')
})
