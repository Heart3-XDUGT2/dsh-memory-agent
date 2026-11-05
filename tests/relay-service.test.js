/**
 * S3 服务契约钉子:`dsh-echo` 是提供端,`dsh-echo-qq` 是消费端。
 *
 * 两个仓**没有共享常量**(各自独立打包),所以跨仓对齐只能靠:
 *   ① 一个字面量:服务名 + 版本;
 *   ② 一个形状:消费端 `dsh-qq-bridge/lib/contract.js` 顶部写着它要什么 ——
 *      `{ version, inject(envelope), subscribeOutbound(fn), ack(ids), lease(opts), status() }`
 *      外加可选的 `registerChannel`(渠道自报家门)。
 *
 * 这条测试**读源码**钉住这两件事:字段名被改名、或被悄悄删掉,这里立刻红。
 * (本仓已有先例:`compaction.test.js:218` 就是这么钉 `CURATION_PROVIDER` 的。)
 * 运行时的真账在计划文档里:2026-09-28 拿 cordis 实跑,兄弟 fiber 读得到 provided 值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolateTestHome, assertHomeIsolated } from './fixtures/test-home.js'

// 2026-10-10 测试隔离加固:先隔离 `DSH_HOME`,再**动态** import 库模块。
// 本文件用真 `lib/relay.js`(其余三条 relay 电池同批加固)—— 它的
// `handleInbound()` 在活配置 `settings.newSessionOn[qq] === true` 时会调
// `setSessionOn` ⇒ `writeConfig()` ⇒ 写真机 config.json。
// 顺序是硬约束(toggle.js 的 CONFIG_PATH 是模块级常量),配套自检见 test-home.js。
isolateTestHome()
const { CONFIG_PATH } = await import('../lib/toggle.js')
assertHomeIsolated(CONFIG_PATH)
const { createSpeaker, SERVICE_NAME, SERVICE_VERSION, SERVICE_API, SERVICE_CAPABILITIES } = await import('../lib/speak.js')
const { createRelay } = await import('../lib/relay.js')
const { openStore } = await import('../lib/store.js')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

test('① 服务名与版本是钉子(消费端也钉同一个字面量)', () => {
  assert.equal(SERVICE_NAME, 'echo:relay')
  assert.equal(SERVICE_VERSION, 1)
})

test('② index.js 真的把服务提供出去了,且字段名与消费端契约一字不差', () => {
  const src = read('lib/index.js')
  const at = src.indexOf('ctx.provide(SERVICE_NAME, {')
  assert.ok(at > 0, '没找到 ctx.provide(SERVICE_NAME, { … }) 调用点')
  const end = src.indexOf("ctx.logger.info('echo: service provided", at)
  assert.ok(end > at, '没找到提供成功后的日志(它也是"真的挂上了"的证据)')
  const block = src.slice(at, end)
  for (const key of ['version:', 'inject:', 'subscribeOutbound:', 'ack:', 'lease:', 'registerChannel:', 'status:']) {
    assert.ok(block.includes(key), '契约里少了 ' + key)
  }
  // 三项关键接线:少一样都等于换了个契约
  assert.ok(block.includes('relay.handleInbound'), 'inject 必须走主包那条九步入站管道(不许另起一条)')
  assert.ok(block.includes('speaker.onOutbound(fn)'), 'subscribeOutbound 必须接到 speaker 的扇出面')
  assert.ok(block.includes('relay.ack'), 'ack 必须销主包同一份账(否则想念 ×0.5 不落)')
  // ⚠️ lease:推送只喊"有活儿"(不带正文),消费端要靠它现取自己平台那份队列。
  // 少了这一项 ⇒ 渠道收到叫醒也拿不到行 ⇒ 一个字发不出去,而且**静默**(2026-09-28 发现)。
  assert.ok(block.includes('relay.lease'), 'lease 必须接到 relay.lease(现取她要说的话)')
  // 挂了要能摘:ctx.provide 返回注销函数 —— 必须接住(否则插件卸载后服务还挂在那)
  assert.ok(src.includes('disposeRelayService'), 'provide 的返回值必须被接住并在卸载时调用')
})

test('③ speak.js 的扇出面是真的导出(消费端通过服务拿到的就是它)', () => {
  const speaker = createSpeaker({ transport: null })
  for (const name of ['onOutbound', 'notifyOutbound', 'registerChannel', 'status', 'dispose']) {
    assert.equal(typeof speaker[name], 'function', 'return 面上少了 ' + name)
  }
  assert.equal(speaker.onOutbound(() => {}).constructor.name, 'Function', 'onOutbound 返回退订函数')
})

// ---- 2026-09-28 加:版本区间 + 能力清单 + 干跑自检(骨架,见 docs/PLAN_CORTICO_ADOPTION.md §3A2) ----

test('④ 版本是【区间】不是单值:对更新的主包只 warning,不把发布顺序锁死', () => {
  // ⚠️ 跨仓钉子:这条字面量在**新仓** `lib/contract.js` 的 `API_RANGE` 与
  //    `test/contract-probe.test.mjs` 里各钉了一次(两个仓没有共享常量)。
  //    要改版本区间,两边一起改 —— 单边改会在这里或那边红。
  assert.deepEqual({ ...SERVICE_API }, { min: 1, max: 2 })
  assert.ok(SERVICE_API.min <= SERVICE_API.max, '区间上下界不许反')
  for (const name of ['inject', 'subscribeOutbound', 'ack', 'lease', 'registerChannel', 'status', 'selftest']) {
    assert.ok(SERVICE_CAPABILITIES.includes(name), '能力清单里少了 ' + name)
  }
  assert.equal(new Set(SERVICE_CAPABILITIES).size, SERVICE_CAPABILITIES.length, '能力名不许重复')
})

test('⑤ 提供端真的挂上了 hello()/selftest(),且 status 只【追加】字段', () => {
  const src = read('lib/index.js')
  const at = src.indexOf('ctx.provide(SERVICE_NAME, {')
  const end = src.indexOf("ctx.logger.info('echo: service provided", at)
  assert.ok(at > 0 && end > at, '没找到 provide 块或它的成功日志')
  const block = src.slice(at, end)
  assert.ok(block.includes('hello: () => ({'), '消费端要能 hello() 自报')
  assert.ok(block.includes('selftest: () => relay.selftest()'), 'selftest 必须接到 relay.selftest')
  assert.ok(block.includes('api: SERVICE_API'), 'hello 必须带上版本区间')
  assert.ok(block.includes('capabilities: SERVICE_CAPABILITIES'), 'hello 必须带上能力清单')
  // 老消费端与验收脚本读的键一个不动:先展开老形状,再追加
  assert.ok(block.includes('...speaker.status(), api: SERVICE_API'), 'status 必须"展开老形状 + 只追加"')
})

test('⑥ selftest() 真跑:坏信封被拒、链路在,且【不产生任何状态】', () => {
  const store = openStore(':memory:')
  const relay = createRelay({
    store,
    logger: { info: () => {}, warn: () => {} },
    config: () => ({ sessionId: 'session-echo-companion', permissionPreset: 'read-only', proactiveScope: 'private', outboxLeaseSec: 30, replyMaxChars: 500, token: 'T' }),
    isEnabled: () => true,
    ensureCompanion: async () => ({ sessionId: 'session-echo-companion' }),
    injectInbound: async () => ({ ok: true })
  })
  const before = { queue: store.relayQueueStats({}), channels: store.relayListChannels().length }
  const r = relay.selftest()
  assert.equal(r.ok, true, '自检该过:' + JSON.stringify(r.checks))
  assert.ok(r.checks.some((c) => c.name === 'envelope-valid' && c.ok), '正例信封必须能解析')
  assert.ok(r.checks.some((c) => c.name === 'envelope-invalid-rejected' && c.ok), '坏信封必须被拒')
  assert.equal(r.checks.filter((c) => !c.ok).length, 0, '自检里不该有失败项')
  const after = { queue: store.relayQueueStats({}), channels: store.relayListChannels().length }
  assert.deepEqual(after, before, '自检不许写库/建渠道(它必须无副作用)')
  assert.match(String(r.note ?? ''), /不写库/, '自检必须自报"无副作用",别让人误以为它跑过真链路')
})
