/**
 * 会话角落开关(v0.30.0)的契约。
 *
 * 他的裁定:「每一个会话的页面的一个角落里面加上一个 echo 开启或者关闭的小按钮」。
 *
 * 这个按钮有三件事最容易在重构里悄悄坏掉,而且坏了**看不出来**(按钮还在,
 * 只是点错会话 / 点不动 / 假装能开):
 *
 *   ① 注册的插槽名必须是 `conversation.session.header.utilities` ——
 *      它是 `kind: list`(能与 open-in-app / 后台任务 / 会话日志并存)。
 *      曾经想挂 `...header.corner`,那是 `kind: single`,右侧栏的展开按钮
 *      已经坐着,占它会把人家挤掉。
 *   ② 会话 id 必须来自**插槽 props**(`sessionId`),不许从 URL / 全局猜 ——
 *      猜错就是「在 A 会话点下线,关掉的是 B」。
 *   ③ 总闸关着时必须**不可点** —— 会话闸开不了总闸,假装能开就是骗他。
 *
 * 这里扫源码(不是跑浏览器):这些是注册面契约,扫得动、跑得快、坏得响。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
const INDEX = readFileSync(join(HERE, '..', 'lib', 'index.js'), 'utf8')

test('按钮注册在 utilities 插槽(list),不是 corner(single)', () => {
  assert.match(CLIENT, /slots\.inject\("conversation\.session\.header\.utilities"/,
    '会话角落开关必须挂在 conversation.session.header.utilities')
  assert.match(CLIENT, /id:\s*"echo-session-toggle"/, '插槽条目要有稳定的 id')
  // corner 是单座,右侧栏占着 —— 不许碰
  assert.doesNotMatch(CLIENT, /slots\.inject\("conversation\.session\.header\.corner"/,
    'corner 是 kind:single(右侧栏展开按钮坐着),挂上去会把人家挤掉')
})

test('会话 id 来自插槽 props,不靠猜', () => {
  assert.match(CLIENT, /function SessionToggleButton\(\{\s*sessionId\s*\}\)/,
    '组件必须从 props 解构 sessionId(插槽标准 kit 发给 session 作用域每个席位)')
  // 反例:从 URL / location 抠会话 id
  assert.doesNotMatch(CLIENT, /new URLSearchParams\([^)]*location/,
    '不许从 URL 猜会话 id')
})

test('写走已有的 scope 端点,且带写保护头', () => {
  const body = CLIENT.slice(CLIENT.indexOf('function SessionToggleButton'))
  assert.match(body, /fetchJson\("\/api\/echo\/scope",\s*\{[\s\S]*?method:\s*"POST"/,
    '按钮要 POST /api/echo/scope')
  assert.match(body, /"x-echo-edit":\s*"1"/, '写操作必须带 x-echo-edit 写保护头')
  assert.match(body, /JSON\.stringify\(\{\s*sessionId,\s*on:\s*!on\s*\}\)/,
    '载荷是 { sessionId, on }(与设置区那张卡同一个端点、同一份语义)')
})

test('总闸关着时按钮不可点(会话闸开不了总闸)', () => {
  const body = CLIENT.slice(CLIENT.indexOf('function SessionToggleButton'))
  assert.match(body, /masterOff/, '要读总闸状态')
  assert.match(body, /disabled:\s*busy\s*\|\|\s*masterOff/,
    '总闸关着必须 disabled —— 不许假装能开')
  assert.match(body, /echo-sess-master-off/, '总闸关要有自己的视觉态(虚线橙)')
})

test('scope 端点回带总闸快照(GET 与 POST 都要)', () => {
  // 按钮靠它区分「这条会话关了」和「总闸关了」;少了它按钮会显示成可点,
  // 点了什么也不会发生 —— 正是他最讨厌的「假开关」。
  const scope = INDEX.slice(INDEX.indexOf("path: '/api/echo/scope'"))
  const handler = scope.slice(0, scope.indexOf("'echo.api.scope()'"))
  const hits = handler.match(/power:\s*powerSnapshot\(\)/g) || []
  assert.equal(hits.length, 2, 'GET 与 POST 都要带 power(GET 1 处 + POST 1 处)')
  assert.match(handler, /readPower\(\)/, 'power 快照来自 readPower()')
})

test('审计行带上真实会话 id(否则面板列表认不出会话)', () => {
  // v0.30.0 修的病:writeAudit 的兜底是 `row.sessionId || GLOBAL_SESSION`,
  // 反思两条路不传 sessionId ⇒ 每行都落成字面量 'global' ⇒ 活库 100 行
  // 审计全叫 'global',面板「她见过的会话」永远只有一行、认不出谁是谁。
  const engine = readFileSync(join(HERE, '..', 'lib', 'engine.js'), 'utf8')
  const reflect = readFileSync(join(HERE, '..', 'lib', 'reflect.js'), 'utf8')
  assert.match(engine, /sessionId: sessionId \|\| undefined/, 'engine 的审计行要带 sessionId')
  assert.match(reflect, /sessionId: sessionId \|\| undefined/, 'reflect 的审计行要带 sessionId')
  // 中继那条以前硬编码 'global'
  assert.doesNotMatch(INDEX, /traceId: randomUUID\(\), sessionId: 'global'/,
    '中继审计不该硬编码 global')
  assert.match(INDEX, /sessionId: String\(sid \|\| ''\) \|\| 'global'/,
    '中继审计要用调用方带来的真实 sid')
})

test('按钮跟着 SSE 变(别的窗口拨了开关,这里要跟着动)', () => {
  const body = CLIENT.slice(CLIENT.indexOf('function SessionToggleButton'))
  // 事件名必须是服务端**真的会发**的那个。events.js 只发 `audit`;
  // 订阅 `echo` 会静默失效(EventSource 对未知事件名不报错)。
  assert.match(body, /subscribeEchoEvent\("audit"/, '要订阅 audit 事件(服务端唯一会发的事件名)')
  assert.doesNotMatch(body, /subscribeEchoEvent\("echo"/,
    '服务端从没发过 echo 事件,订阅它等于静默失效')
})
