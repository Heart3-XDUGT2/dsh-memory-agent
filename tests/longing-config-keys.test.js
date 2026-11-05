/**
 * 想念九项 / 整固旋钮的**接线**电池(2026-09-26 全仓审查补)。
 *
 * 真实漏洞:四个 longing 帧**原样**转发 settings,而引擎 `longing.merge_config`
 * 读 camelCase —— 九项里只有同名的那两个(enabled/threshold)生效,其余七项
 * 面板上调了没用(永远走 DEFAULTS)。整固那两个旋钮也是同一类病(已修)。
 *
 * 第一版电池只测了翻译函数 `longingFrameConfig`,**沙袋没炸**(把帧里的翻译
 * 换回原样转发,电池照样绿)—— 那正是审查里批的"测了复制品没测产品"。
 * 所以这版走真接线:注入一个假 client,直接看**引擎发出去的帧**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, longingFrameConfig } from '../lib/engine.js'

/** 假侧车:记下每一个请求,回一个够用的形状。 */
function fakeClient () {
  const frames = []
  return {
    frames,
    running: true,
    state: () => ({ breakerOpen: false }),
    start: async () => ({ version: 'fake' }),
    stop: async () => {},
    request: async (type, payload) => {
      frames.push({ type, payload })
      if (type === 'longing_check') return { value: 1, kicked: 0 }
      if (type === 'longing_tick') return { pre: 1, post: 1 }
      if (type === 'longing_message') return { pre: 1, post: 1 }
      if (type === 'reflection_prompt') return { triggered: false }
      return {}
    }
  }
}

async function engineWith (client) {
  const engine = createEngine({
    logger: null, dbPath: ':memory:', store: null,
    detect: async () => ({ path: '/fake/python' }),
    clientOpts: { client }
  })
  await engine.init()
  return engine
}

const PANEL = {
  enabled: true,
  half_life_hours: 5.5,
  threshold: 6.5,
  msg_drop: 3.5,
  care_relief: 0.4,
  protest_kick: 2.5,
  cooldown_minutes: 60,
  night_hold: false,
  demo_rate: 12
}

test('接线:四条想念帧发的都是引擎认的 camelCase(面板调了真的到得了)', async () => {
  const client = fakeClient()
  const engine = await engineWith(client)
  await engine.longingTick(PANEL)
  await engine.longingMessage('master', '在吗', 's1', PANEL)
  await engine.longingCare('master', PANEL)
  await engine.longing('master', PANEL)
  const names = client.frames.map((f) => f.type)
  assert.deepEqual(names, ['longing_tick', 'longing_message', 'longing_care', 'longing_check'])
  const expect = {
    enabled: true, halfLifeHours: 5.5, threshold: 6.5, msgDrop: 3.5,
    careRelief: 0.4, protestKick: 2.5, cooldownMinutes: 60,
    nightHold: false, demoRate: 12
  }
  for (const f of client.frames) {
    assert.deepEqual(f.payload.config, expect,
      f.type + ' 的 config 键名不对 —— 引擎会静默当没配过,面板就是个摆设')
  }
})

test('接线:整固两个旋钮也真的随帧走(不是只写在文档里)', async () => {
  const client = fakeClient()
  const engine = await engineWith(client)
  await engine.reflectionPrompt(1, { importance_threshold: 12, max_inputs: 8 })
  const f = client.frames.find((x) => x.type === 'reflection_prompt')
  assert.deepEqual(f.payload.config, { importanceThreshold: 12, maxInputs: 8 })
  // 不带 config 时不许凭空塞一份,否则引擎默认值就再也用不上了
  await engine.reflectionPrompt(1)
  const last = client.frames.filter((x) => x.type === 'reflection_prompt').pop()
  assert.equal(last.payload.config, undefined)
})

test('翻译函数本身:零/false 原样送,没有 config 不发空对象', () => {
  const out = longingFrameConfig({ cooldown_minutes: 0, night_hold: false })
  assert.equal(out.cooldownMinutes, 0)
  assert.equal(out.nightHold, false)
  assert.equal(longingFrameConfig(null), null)
  assert.equal(longingFrameConfig({}), null)
})
