/**
 * 反思 route 决议的电池(2026-10-06 方案 C + B)。
 *
 * 现场(这份电池要焊死的三件事):
 *   ① 面板那两格**留空**时,反思必须**继承本会话 route** 而不是原地跳过
 *      (旧版:留空 ⇒ 直调通道 skip ⇒ 35 小时零记忆);
 *   ② 继承也拿不到 ⇒ **明确退回子代理**,并把"为什么"写进状态面 ——
 *      **不许静默**(旧的运输口按"服务在不在"选路,把退路焊死了);
 *   ③ 面板填了 ⇒ 它是**覆盖项**,优先于会话 route(想给反思单独配小模型)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { routeOfRequestHeader, resolveReflectRoute, chooseReflectTransport } from '../lib/reflect-route.js'

const headerEvent = (provider, model) => ({
  type: 'request/header',
  data: { header: { config: { provider, model } }, reason: 'initial' }
})

test('routeOfRequestHeader:取 header.config 里的成对 provider/model', () => {
  assert.deepEqual(routeOfRequestHeader(headerEvent('deepseek', 'deepseek-v4.1-flash')),
    { provider: 'deepseek', model: 'deepseek-v4.1-flash' })
  // 半个 route 不算 route(宿主自己也是成对要的)
  assert.equal(routeOfRequestHeader(headerEvent('deepseek', '')), null)
  assert.equal(routeOfRequestHeader(headerEvent('', 'x')), null)
  // 兼容直接给 data / 给整条事件两种包法;别的形状一律 null(不猜)
  assert.deepEqual(routeOfRequestHeader({ header: { config: { provider: 'p', model: 'm' } } }),
    { provider: 'p', model: 'm' })
  assert.equal(routeOfRequestHeader(null), null)
  assert.equal(routeOfRequestHeader({ type: 'user/message' }), null)
  assert.equal(routeOfRequestHeader({ data: { header: {} } }), null)
})

test('resolveReflectRoute:面板配了 = 覆盖项;没配 = 继承会话;都没有 = none', () => {
  const sess = { provider: 'deepseek', model: 'deepseek-v4.1-flash' }
  // ① 面板填了 ⇒ 用它(覆盖),并说明这是覆盖
  const bySettings = resolveReflectRoute({ settings: { llmProvider: 'mini', llmModel: 'mini-1' }, sessionRoute: sess })
  assert.deepEqual([bySettings.provider, bySettings.model, bySettings.source], ['mini', 'mini-1', 'settings'])
  assert.match(bySettings.note, /覆盖/)
  // ② 只有一半也等于没配 ⇒ 继承会话 route
  const half = resolveReflectRoute({ settings: { llmProvider: 'mini', llmModel: '' }, sessionRoute: sess })
  assert.deepEqual([half.provider, half.model, half.source], ['deepseek', 'deepseek-v4.1-flash', 'session'])
  // ③ 都没 ⇒ none(由上层退回子代理,不许静默)
  const none = resolveReflectRoute({ settings: {}, sessionRoute: null })
  assert.equal(none.source, 'none')
  assert.match(none.note, /未配 llmProvider\/llmModel/)
})

test('chooseReflectTransport:配齐走直调 / 没配走继承 / 都不行退回子代理且说明原因', () => {
  const sess = { provider: 'deepseek', model: 'deepseek-v4.1-flash' }
  // ① 面板配了 + 服务在 ⇒ 直调
  const a = chooseReflectTransport({ settings: { llmProvider: 'mini', llmModel: 'mini-1' }, llmAvailable: true, subagentsAvailable: true })
  assert.equal(a.mode, 'llm')
  assert.deepEqual(a.route, { provider: 'mini', model: 'mini-1' })
  // ② 面板没配但拿得到会话 route ⇒ 直调(继承)—— 这就是"默认就能跑"
  const b = chooseReflectTransport({ settings: {}, sessionRoute: sess, llmAvailable: true, subagentsAvailable: true })
  assert.equal(b.mode, 'llm')
  assert.deepEqual(b.route, sess)
  assert.match(b.note, /继承本会话 route/)
  // ③ 未配 + 无 route + 子代理在 ⇒ **退回子代理**,note 说清为什么(不静默)
  const c = chooseReflectTransport({ settings: {}, sessionRoute: null, llmAvailable: true, subagentsAvailable: true })
  assert.equal(c.mode, 'subagents')
  assert.equal(c.route, null)
  assert.match(c.note, /退回子代理/)
  assert.match(c.note, /未配 llmProvider\/llmModel/)
  // ④ 直调开关关 ⇒ 也退回子代理(开关是总闸,不是静默门)
  const d = chooseReflectTransport({ settings: { llmDirectEnabled: false }, sessionRoute: sess, llmAvailable: true, subagentsAvailable: true })
  assert.equal(d.mode, 'subagents')
  assert.match(d.note, /直调开关关/)
  // ⑤ 宿主没有 llm 服务 ⇒ 退回子代理
  const e = chooseReflectTransport({ settings: {}, sessionRoute: sess, llmAvailable: false, subagentsAvailable: true })
  assert.equal(e.mode, 'subagents')
  assert.match(e.note, /宿主没有 llm 服务/)
  // ⑥ 两条路都不行 ⇒ none,但**仍然有 note**(状态面看得见)
  const f = chooseReflectTransport({ settings: {}, sessionRoute: null, llmAvailable: true, subagentsAvailable: false })
  assert.equal(f.mode, 'none')
  assert.ok(f.note.length > 0)
})

test('接线:index.js 记住会话 route、按决议选路、把原因写进状态面', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /const sessionRoutes = new Map\(\)/, '要有一张会话 → route 的表')
  assert.match(src, /event\.type === 'request\/header'/, 'route 从 request/header 事件来')
  assert.match(src, /sessionRoutes\.set\(sid, route\)/, '取到 route 要存起来')
  assert.match(src, /chooseReflectTransport\(\{/, '选路必须走纯逻辑决议(可离线测)')
  assert.match(src, /reflectTransport\(snap\.sessionId\)/, '按这一轮的会话 id 选路')
  assert.match(src, /reflectStats\.lastNote = String\(transport\.note/, '为什么走这条/为什么没跑要写进状态面')
  // 旧病不许复发:按"服务在不在"选路的写法必须消失(它就是静默的根源)
  assert.equal(src.includes('llmChannel.available() ? {'), false, '不许再用 available() 直接选路')
  assert.equal(src.includes('engine.reflect(reflectTransport(),'), false, 'reflectTransport 必须带会话 id')
  // 2026-10-06 第二批(读到错因):错误原文与 chunk 面必须上状态面,且失败时
  // lastNote 不许停在选路说明上(现场:llmFailed=2 而面板写着"继承本会话 route")
  assert.match(src, /reflectStats\.llmLastError = String\(ls\.lastError/, 'lastError 要抄进状态面')
  assert.match(src, /reflectStats\.llmLastChunks = String\(ls\.lastChunks/, 'chunk 面也要抄')
  assert.match(src, /llmLastError: '', llmLastChunks: ''/, 'REFLECT_STATS_SHAPE 键集同批声明')
  assert.match(src, /llmLastError: \{ type: 'string' \}/, 'echo_status 的 schema 也要同批声明(拒答事故的坑)')
  assert.match(src, /未成功:' \+ why/, '失败时把错因顶到 lastNote')
})
