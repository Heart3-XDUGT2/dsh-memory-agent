/**
 * 方案 C 的直调通道(`lib/llm-channel.js`)单测。
 *
 * 全程用**假 llm 服务**(自己写的对象):不联网、不起子代理、不碰真模型 ——
 * 这个文件的职责是把通道的**契约**钉住:
 *   · 失败一律 `null`(fail-soft,绝不上抛);
 *   · `llm` 缺席 / 直调关 / provider-model 未配置 ⇒ 干脆不调假流;
 *   · 四格统计(ok / timeout / queued / failed)+ 溢出 / 跳过;
 *   · 全局并发闸 + 队列(满了才放弃);
 *   · `sessionId` 透传;
 *   · 超时**真的会收手**(不是挂在那等)。
 *
 * 假流的形状照宿主契约(`dsh-llm/lib/types/assistant-stream.js`):
 * `llm.stream(options)` 回一个**异步可迭代**,chunk 形如
 * `{ type: 'text-delta', index, text }`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLlmChannel, DEFAULT_MAX_QUEUE } from '../lib/llm-channel.js'
import { normalizeSettings } from '../lib/toggle.js'

/** 通道要用得起来的最小配置(provider/model 都不是空串)。 */
const CFG = { llmProvider: 'fake-provider', llmModel: 'fake-model' }

/**
 * 假 llm 服务:`factory(options, nth)` 回一个**异步可迭代**(通常写
 * `async function * () {…}`)。每次调用都把 options 记进 `calls` ——
 * 「有没有调」「传了什么」两个问题都由它回答。
 */
function fakeLlm (factory) {
  const calls = []
  return {
    calls,
    stream (options) {
      calls.push(options)
      return factory(options, calls.length)
    }
  }
}

/** 常见形态:吐几段正文。 */
function textLlm (...parts) {
  return fakeLlm(async function * () {
    for (const text of parts) yield { type: 'text-delta', index: 0, text }
  })
}

const makeChannel = (llm, settings = {}) => createLlmChannel({
  llm,
  getSettings: () => ({ ...CFG, ...settings }),
  log: { warn: () => {} }
})

// ── ① 缺席:available() false,runStructured() null ─────────────────────────

test('① llm 缺席(null / 没有 stream)⇒ available() 假、runStructured() 回 null', async () => {
  for (const llm of [null, undefined, {}, { stream: 'not-a-function' }, 42]) {
    const channel = createLlmChannel({ llm, getSettings: () => ({ ...CFG }) })
    assert.equal(channel.available(), false, String(llm) + ' 不该算可用')
    assert.equal(await channel.runStructured({ system: 's', user: 'u', schema: { type: 'object' } }), null)
    assert.equal(channel.snapshot().mode, 'off', '缺席时状态面该说 off')
    // 一次调用都没发生 ⇒ 四格统计原封不动
    const snap = channel.snapshot()
    assert.deepEqual(
      [snap.ok, snap.timeout, snap.failed, snap.skipped, snap.overflow],
      [0, 0, 0, 0, 0]
    )
  }
})

// ── ② 正常路径(带 schema)────────────────────────────────────────────────

test('② 两段 text-delta 拼起来 ⇒ 带 schema 时返回解析后的对象,ok=1', async () => {
  const llm = fakeLlm(async function * () {
    yield { type: 'text-delta', index: 0, text: '{"a":' }
    yield { type: 'text-delta', index: 0, text: '1}' }
  })
  const channel = makeChannel(llm)
  const out = await channel.runStructured({ system: 's', user: 'u', schema: { type: 'object' }, label: 't2' })
  assert.deepEqual(out, { a: 1 })
  const snap = channel.snapshot()
  assert.equal(snap.ok, 1)
  assert.equal(snap.failed, 0)
  assert.equal(snap.timeout, 0)
  assert.equal(snap.mode, 'llm')
  assert.equal(llm.calls.length, 1, '调用次数 1')
  // 只收正文:思考增量(reasoning-delta)不进结果
  assert.equal(snap.lastOk, true)
})

test('②b 思考增量被丢掉,拼出来的仍是纯正文', async () => {
  const llm = fakeLlm(async function * () {
    yield { type: 'reasoning-delta', index: 0, text: '想想要不要…' }
    yield { type: 'text-delta', index: 0, text: '{"a":1}' }
  })
  const channel = makeChannel(llm)
  assert.deepEqual(await channel.runStructured({ system: 's', user: 'u', schema: {} }), { a: 1 })
})

// ── ③ 不带 schema ⇒ 纯文本 ────────────────────────────────────────────────

test('③ 不带 schema ⇒ 原样回纯文本(不做 JSON 解析)', async () => {
  const llm = textLlm('{"a":', '1}')
  const channel = makeChannel(llm)
  const out = await channel.runStructured({ system: 's', user: 'u', label: 't3' })
  assert.equal(out, '{"a":1}')
  assert.equal(typeof out, 'string')
  assert.equal(channel.snapshot().ok, 1)
})

test('③b 不带 schema 时,非 JSON 的正文照收(它只是文本)', async () => {
  const channel = makeChannel(textLlm('随便说说'))
  assert.equal(await channel.runStructured({ system: 's', user: 'u' }), '随便说说')
})

// ── ④ 非法 JSON ⇒ null + failed 增 ────────────────────────────────────────

test('④ 产出不是合法 JSON ⇒ null,且 failed 加一', async () => {
  const channel = makeChannel(textLlm('这不是 JSON,连大括号都没有'))
  const before = channel.snapshot().failed
  const out = await channel.runStructured({ system: 's', user: 'u', schema: { type: 'object' }, label: 't4' })
  assert.equal(out, null)
  const snap = channel.snapshot()
  assert.equal(snap.failed, before + 1)
  assert.equal(snap.ok, 0, '失败不许算成功')
  assert.equal(snap.lastOk, false)
})

// ── ⑤ 直调总闸关 ⇒ 不调假流 ───────────────────────────────────────────────

test('⑤ llmDirectEnabled: false ⇒ 直接 null,假流一次都没被调用', async () => {
  const llm = textLlm('不应该出现')
  const channel = makeChannel(llm, { llmDirectEnabled: false })
  assert.equal(await channel.runStructured({ system: 's', user: 'u', schema: {} }), null)
  assert.equal(llm.calls.length, 0, '关掉的通道不许碰模型')
  assert.equal(channel.snapshot().skipped, 1, '跳过要留痕')
  assert.equal(channel.snapshot().ok, 0)
})

test('⑤b 只有显式 false 才关:字符串与 0 都按开(与 readCfg 同口径)', async () => {
  for (const bad of ['false', 0, null, undefined, 1]) {
    const llm = textLlm('ok')
    const channel = makeChannel(llm, { llmDirectEnabled: bad })
    assert.equal(await channel.runStructured({ system: 's', user: 'u' }), 'ok', String(bad) + ' 不该把通道关掉')
  }
})

// ── ⑥ 未配置 provider / model ⇒ 不调假流 ─────────────────────────────────

test('⑥ provider / model 为空串 ⇒ null,假流不调用', async () => {
  for (const settings of [{ llmProvider: '' }, { llmModel: '' }, { llmProvider: '   ' }, { llmProvider: '', llmModel: '' }]) {
    const llm = textLlm('不应该出现')
    const channel = makeChannel(llm, settings)
    assert.equal(await channel.runStructured({ system: 's', user: 'u', label: 't6' }), null)
    assert.equal(llm.calls.length, 0, '没配好就不许调模型:' + JSON.stringify(settings))
    assert.equal(channel.snapshot().skipped, 1)
  }
})

// ── ⑦ 超时 ───────────────────────────────────────────────────────────────

test('⑦ 挂住的流(只有 abort 叫得醒)⇒ 200ms 超时、~1 秒内回 null,timeout=1', { timeout: 5000 }, async () => {
  // 「永远挂住」的那种流:它自己不会结束 —— 真流在 abort 时会结束,
  // 所以这里也照真流的契约监听 options.signal(否则这条用例会真的挂死)。
  const llm = fakeLlm(async function * (options) {
    await new Promise((resolve, reject) => {
      if (options.signal.aborted) { reject(new Error('aborted')); return }
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  })
  const channel = makeChannel(llm, { llmTimeoutMs: 200 })
  const startedAt = Date.now()
  const out = await channel.runStructured({ system: 's', user: 'u', schema: { type: 'object' }, label: 't7' })
  const ms = Date.now() - startedAt
  assert.equal(out, null)
  assert.ok(ms < 1000, '要果断收手,实际等了 ' + String(ms) + 'ms')
  const snap = channel.snapshot()
  assert.equal(snap.timeout, 1)
  assert.equal(snap.failed, 0, '超时不算失败')
  assert.equal(snap.running, 0, '超时也要把闸放干净')
  assert.equal(snap.waiting, 0)
})

// ── ⑧ 并发闸 + 排队 / 队列满 ──────────────────────────────────────────────

test('⑧a llmMaxConcurrent: 1,三连发都成功,且中途确有排队(waiting ≥ 1)', { timeout: 5000 }, async () => {
  let channel = null
  const seen = []
  const llm = fakeLlm(async function * () {
    // 观测点就在假流里:它跑起来的那一刻,后面的人应该正在队列里等。
    if (channel !== null) seen.push(channel.snapshot())
    await new Promise((resolve) => setTimeout(resolve, 50))
    yield { type: 'text-delta', index: 0, text: 'ok' }
  })
  channel = makeChannel(llm, { llmMaxConcurrent: 1 })
  const results = await Promise.all([0, 1, 2].map(() => channel.runStructured({ system: 's', user: 'u', label: 'q' })))
  assert.deepEqual(results, ['ok', 'ok', 'ok'], '排队不等于丢')
  assert.ok(seen.some((s) => s.waiting >= 1), '至少有一个时刻队列里有人在等(实际观测:' + JSON.stringify(seen.map((s) => s.waiting)) + ')')
  const snap = channel.snapshot()
  assert.equal(snap.ok, 3)
  assert.equal(snap.running, 0, '跑完闸要放干净')
  assert.equal(snap.waiting, 0)
})

test('⑧b 队列满(DEFAULT_MAX_QUEUE=' + String(DEFAULT_MAX_QUEUE) + '):一次 30 发 ⇒ 有 null 且 overflow 增', { timeout: 10000 }, async () => {
  const llm = fakeLlm(async function * () {
    await new Promise((resolve) => setTimeout(resolve, 20))
    yield { type: 'text-delta', index: 0, text: 'ok' }
  })
  const channel = makeChannel(llm, { llmMaxConcurrent: 1 })
  const results = await Promise.all(
    Array.from({ length: 30 }, () => channel.runStructured({ system: 's', user: 'u', label: 'over' }))
  )
  const nulls = results.filter((r) => r === null).length
  assert.ok(nulls >= 1, '至少要有一个被队列满挡回去')
  assert.ok(channel.snapshot().overflow >= 1, '放弃要留痕(overflow)')
  // 上限 1 人正在跑 + 16 个在队列里 ⇒ 30 发至少溢出 13 个
  assert.ok(nulls >= 30 - 1 - DEFAULT_MAX_QUEUE, '实际溢出 ' + String(nulls) + ' 个')
  assert.equal(results.filter((r) => r === 'ok').length, 30 - nulls, '没被挡回去的都得真的跑成')
  const snap = channel.snapshot()
  assert.equal(snap.running, 0)
  assert.equal(snap.waiting, 0)
})

// ── ⑨ sessionId 透传 ─────────────────────────────────────────────────────

test('⑨ 传了 sessionId 就出现在 options 里;没传则没有这个键', async () => {
  const llm = textLlm('ok')
  const channel = makeChannel(llm)
  await channel.runStructured({ system: 's', user: 'u', sessionId: 'sess-echo-9' })
  await channel.runStructured({ system: 's', user: 'u' })
  assert.equal(llm.calls.length, 2)
  assert.equal(llm.calls[0].sessionId, 'sess-echo-9')
  assert.equal('sessionId' in llm.calls[1], false, '没传就不许凭空多一个键')
  // 空串 / null 同样视作"没传"(readCfg 的判据)
  await channel.runStructured({ system: 's', user: 'u', sessionId: '' })
  assert.equal('sessionId' in llm.calls[2], false)
  // 顺手钉住其余接线:provider / model / maxTokens / system / messages
  assert.equal(llm.calls[0].provider, 'fake-provider')
  assert.equal(llm.calls[0].model, 'fake-model')
  assert.equal(llm.calls[0].maxTokens, 4096, '默认 4096(2026-10-06 由 1024 提高)')
  assert.equal(llm.calls[0].system, 's')
  assert.equal(llm.calls[0].messages[0].content[0].text, 'u')
  assert.equal(typeof llm.calls[0].signal.aborted, 'boolean', '要带真 signal(宿主契约)')
})

// ── ⑩ 2026-10-06 方案 C:route 从外面传进来(面板覆盖 / 继承本会话)+ 跳过必留原因 ──
// 现场:这两个键默认空 ⇒ 通道每轮 `skipped` 而**状态面一片空白**(活状态面
// `llmSkipped=8`、其余四格全 0、lastNote 空 ⇒ 35 小时零记忆没人发现)。B 的钉子:
// 跳过必须说得出为什么;route 传进来必须真的用上。

test('⑩a 传进来的 route 优先于设置里的(继承来的会话 route 也能跑起来)', async () => {
  const llm = textLlm('ok')
  // 设置里两个键是空的 —— 但 route 齐 ⇒ 照跑(这就是"默认就能跑")
  const channel = createLlmChannel({ llm, getSettings: () => ({}), log: { warn: () => {} } })
  assert.equal(await channel.runStructured({
    system: 's', user: 'u', label: 'echo-extract', provider: 'deepseek', model: 'deepseek-v4.1-flash'
  }), 'ok')
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].provider, 'deepseek')
  assert.equal(llm.calls[0].model, 'deepseek-v4.1-flash')
  assert.equal(channel.snapshot().ok, 1)
  // 设置里有、route 也有 ⇒ route 赢(它是更"近"的那一份)
  const llm2 = textLlm('ok')
  const ch2 = makeChannel(llm2)
  await ch2.runStructured({ system: 's', user: 'u', provider: 'session-p', model: 'session-m' })
  assert.equal(llm2.calls[0].provider, 'session-p')
  assert.equal(llm2.calls[0].model, 'session-m')
})

test('⑩b 跳过(未配置 / 开关关)必须留下**原因**,不许静默', async () => {
  // 未配置:设置空 + 没 route
  const bare = createLlmChannel({ llm: textLlm('x'), getSettings: () => ({}), log: { warn: () => {} } })
  assert.equal(await bare.runStructured({ system: 's', user: 'u', schema: {}, label: 'echo-extract' }), null)
  const sb = bare.snapshot()
  assert.equal(sb.skipped, 1)
  assert.equal(sb.lastOk, false)
  assert.match(sb.lastNote, /未配 provider\/model/)
  assert.match(sb.lastNote, /echo-extract/, '哪一路没跑也要说得出来')
  // 开关关:原因与未配置分开(面板上要能分辨)
  const off = makeChannel(textLlm('x'), { llmDirectEnabled: false })
  assert.equal(await off.runStructured({ system: 's', user: 'u', schema: {}, label: 'echo-consolidate' }), null)
  const so = off.snapshot()
  assert.match(so.lastNote, /直调开关关/)
  assert.match(so.lastNote, /echo-consolidate/)
})

test('⑩c usable():服务在 + 开关开 + route 齐(传进来或设置里)⇒ 真;否则假', () => {
  const svc = textLlm('x')
  const bare = createLlmChannel({ llm: svc, getSettings: () => ({}) })
  assert.equal(bare.usable({ provider: 'p', model: 'm' }), true)
  assert.equal(bare.usable(null), false, '两边都没有 ⇒ 不能跑(运输口据此退子代理)')
  assert.equal(bare.usable({ provider: 'p', model: '' }), false, '半个 route 不算')
  const cfg = makeChannel(svc)
  assert.equal(cfg.usable(null), true, '设置里有 route 也算能跑')
  const off = makeChannel(svc, { llmDirectEnabled: false })
  assert.equal(off.usable({ provider: 'p', model: 'm' }), false, '总闸关 ⇒ 不能跑')
  assert.equal(createLlmChannel({ llm: null, getSettings: () => ({}) }).usable({ provider: 'p', model: 'm' }), false, '没服务 ⇒ 不能跑')
})

// ── ⑪ 2026-10-06 终局块:宿主把适配器失败放在 finish 里,**不抛异常** ────────────
// 现场:`llmFailed=2`、终端一行日志都没有、`lastNote` 还是选路说明 —— 因为消费方
// 只收 text-delta、把终局块整条丢了。这组电池就是钉住"错误必须读出来"。

/** 假流:先吐给定 chunk,最后按需补一条终局块。 */
function finishLlm (chunks, reason) {
  return fakeLlm(async function * () {
    for (const c of chunks) yield c
    if (reason !== null) yield { type: 'finish', reason }
  })
}

test('⑪a 终局块 kind=error ⇒ 失败 + lastError 带 code/message + lastNote 说明', async () => {
  const llm = finishLlm([], { kind: 'error', failure: { code: 'INVALID_CREDENTIAL', message: 'API key 无效' } })
  const channel = makeChannel(llm)
  const out = await channel.runStructured({ system: 's', user: 'u', schema: {}, label: 'echo-extract' })
  assert.equal(out, null)
  const snap = channel.snapshot()
  assert.equal(snap.failed, 1, '终局块 error 算失败(不是"空产出")')
  assert.match(snap.lastError, /INVALID_CREDENTIAL/)
  assert.match(snap.lastError, /API key 无效/)
  assert.match(snap.lastNote, /适配器报错/)
  assert.match(snap.lastNote, /echo-extract/, '哪一路失败也要说得出来')
})

test('⑪b 终局块 kind=max-tokens ⇒ 记成"思考把 maxTokens 吃光"', async () => {
  const llm = finishLlm([{ type: 'reasoning-delta', index: 0, text: '想…想…想…' }],
    { kind: 'max-tokens' })
  const channel = makeChannel(llm)
  assert.equal(await channel.runStructured({ system: 's', user: 'u', schema: {}, label: 'echo-extract' }), null)
  const snap = channel.snapshot()
  assert.equal(snap.failed, 1)
  assert.match(snap.lastError, /MAX_TOKENS/)
  assert.match(snap.lastNote, /思考把 maxTokens 吃光/)
  assert.equal(snap.lastReasoningChars, 6, '思考字数要数下来(分水岭)')
})

test('⑪c kind=aborted / tool-calls / 未知 kind 各自成句;kind=stop 不算终局失败', async () => {
  const mk = (reason, chunks = []) => makeChannel(finishLlm(chunks, reason))
  const ab = mk({ kind: 'aborted', failure: { code: 'ABORTED', message: '人按了停' } })
  await ab.runStructured({ system: 's', user: 'u', schema: {}, label: 't' })
  assert.match(ab.snapshot().lastNote, /被中止/)
  const tc = mk({ kind: 'tool-calls' })
  await tc.runStructured({ system: 's', user: 'u', schema: {}, label: 't' })
  assert.match(tc.snapshot().lastNote, /要调工具/)
  const wt = mk({ kind: 'weird-thing' })
  await wt.runStructured({ system: 's', user: 'u', schema: {}, label: 't' })
  assert.match(wt.snapshot().lastNote, /未知终局原因/)
  const ok = mk({ kind: 'stop' })
  await ok.runStructured({ system: 's', user: 'u', schema: {}, label: 't' })
  assert.match(ok.snapshot().lastNote, /空产出/, 'stop 但流里没正文 ⇒ 仍算空产出')
  assert.equal(ok.snapshot().lastError.startsWith('EMPTY'), true)
})

test('⑪d classifyFinish():纯函数,stop / 取不到 ⇒ null', async () => {
  const { classifyFinish } = await import('../lib/llm-channel.js')
  assert.equal(classifyFinish(null), null)
  assert.equal(classifyFinish(undefined), null)
  assert.equal(classifyFinish({ kind: 'stop' }), null)
  assert.equal(classifyFinish({ kind: '' }), null)
  assert.equal(classifyFinish({ kind: 'error', failure: { code: 'X', message: 'Y' } }).code, 'X')
  assert.equal(classifyFinish({ kind: 'error' }).code, 'LLM_ERROR', '没给 failure 也要有 code')
})

test('⑪e 空产出的诊断面:chunk 类型计数 + 思考字数都留痕', async () => {
  const llm = fakeLlm(async function * () {
    yield { type: 'reasoning-delta', index: 0, text: '一二三' }
    yield { type: 'block-start', index: 0, blockType: 'text' }
  })
  const channel = makeChannel(llm)
  await channel.runStructured({ system: 's', user: 'u', schema: {}, label: 'echo-extract' })
  const snap = channel.snapshot()
  assert.equal(snap.lastChunks, '正文×0 思考×1 其他×1')
  assert.equal(snap.lastReasoningChars, 3)
  assert.match(snap.lastNote, /空产出:echo-extract\(正文×0 思考×1 其他×1\)/)
})

// ── ⑫ messages 形状:与官方先例 dsh-session-title-llm 逐位一致(除 purpose)──────

test('⑫ messages 走宿主工厂形状:id/role/content/source,且**不传 purpose**', async () => {
  const llm = textLlm('ok')
  const channel = makeChannel(llm)
  await channel.runStructured({ system: 's', user: 'u', label: 't' })
  const m = llm.calls[0].messages[0]
  assert.equal(m.role, 'user')
  assert.equal(typeof m.id, 'string')
  assert.ok(m.id.length > 0, '宿主 createUserMessage 会带 id')
  assert.equal(m.content[0].type, 'text')
  assert.equal(m.content[0].text, 'u')
  assert.equal(typeof m.source?.kind, 'string', 'source.kind 要有(先例同款)')
  assert.equal('purpose' in llm.calls[0], false, 'purpose 值域只有 compaction/session-title ⇒ 我们不传')
})


// ══════════════════════════════════════════════════════════════════════
// ★★ 2026-10-21：**舱壁隔离（拆池）的四条契约**
// ══════════════════════════════════════════════════════════════════════
//
// 背景：一条 `llmMaxConcurrent` 闸同时装着六种任务。组装前的情绪打分 / 查询扩展
// **有 5s/10s 截止期，拿不到就整轮作废**；轮末的反思**墙钟 21 秒，纯增益**。
// 实测反思横跨到下一轮开口（21:29:16 → 21:29:37，轮 3 于 21:29:23.98 起跑），
// 下一轮的情绪与扩展全程排在它后面、一起到期。
//
// 这四条钉的是「两个池真的互不相干」，不是「能跑就行」。

/** 轮询到条件成立（默认 2s）。并发测试里"等一格被占住"用固定 sleep 不稳。 */
async function waitFor (cond, ms = 2000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { if (cond()) return true } catch { /* 还没成型 */ }
    await new Promise((r) => setTimeout(r, 10))
  }
  return false
}

/** 造一个"挂住直到被 abort"的假流（与 ⑦ 那条同款契约：真流 abort 时会结束）。 */
function hangingFactory (sink) {
  return async function * (options) {
    await new Promise((resolve, reject) => {
      sink.push(resolve)
      if (options.signal.aborted) { reject(new Error('aborted')); return }
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    yield { type: 'text-delta', index: 0, text: 'x' }
  }
}

test('① ★★ live 池打满 ⇒ bulk **不排队、立刻跑**（舱壁隔离的本体）', { timeout: 8000 }, async () => {
  const ac = new AbortController()
  const gates = []
  const llm = fakeLlm(async function * (options) {
    // 第一条（live）挂住；第二条（bulk）立刻吐字
    if (llm.calls.length === 1) {
      await new Promise((resolve, reject) => {
        gates.push(resolve)
        if (options.signal.aborted) { reject(new Error('aborted')); return }
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      yield { type: 'text-delta', index: 0, text: 'live' }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'bulk' }
  })
  const channel = makeChannel(llm, { llmMaxConcurrent: 1, llmMaxConcurrentBulk: 1 })

  // ① 先占住 live 那唯一一格
  const liveP = channel.runStructured({ system: 's', user: 'u', label: 'live', pool: 'live', signal: ac.signal })
  const ok = await waitFor(() => channel.snapshot().pool.live.running === 1)
  assert.equal(ok, true, 'live 池要先被占住（不然这条测不出东西）')

  // ② 发一个 bulk：**不许排队**，必须立刻跑完
  const bulkOut = await channel.runStructured({ system: 's', user: 'u', label: 'bulk', pool: 'bulk' })
  assert.equal(bulkOut, 'bulk',
    '★ 旧写法（单池，上限 1）这里会**排在 live 后面**、一直拿不到闸；'
    + '拿到的应该是 bulk 自己的产出')
  assert.equal(channel.snapshot().pool.bulk.waiting, 0, 'bulk 队列不该涨')
  assert.equal(channel.snapshot().pool.live.waiting, 0, 'live 那边也没被 bulk 影响')

  ac.abort()
  await liveP
})

test('② ★★ snapshot 两池分开记；顶层 running/waiting 仍是两者之和', { timeout: 8000 }, async () => {
  const ac = new AbortController()
  const gates = []
  const llm = fakeLlm(hangingFactory(gates))
  const channel = makeChannel(llm, { llmMaxConcurrent: 1, llmMaxConcurrentBulk: 1 })

  // 两个池各占满 1 + 各排 1
  const ps = [
    channel.runStructured({ system: 's', user: 'u', label: 'l1', pool: 'live', signal: ac.signal }),
    channel.runStructured({ system: 's', user: 'u', label: 'l2', pool: 'live', signal: ac.signal }),
    channel.runStructured({ system: 's', user: 'u', label: 'b1', pool: 'bulk', signal: ac.signal }),
    channel.runStructured({ system: 's', user: 'u', label: 'b2', pool: 'bulk', signal: ac.signal })
  ]

  const ok = await waitFor(() => {
    const s = channel.snapshot()
    return s.pool.live.running === 1 && s.pool.bulk.running === 1
      && s.pool.live.waiting === 1 && s.pool.bulk.waiting === 1
  })
  assert.equal(ok, true, '两池各 1 跑 1 等；实得 ' + JSON.stringify(channel.snapshot().pool))

  const snap = channel.snapshot()
  assert.equal(snap.pool.live.running, 1)
  assert.equal(snap.pool.bulk.running, 1)
  assert.equal(snap.pool.live.waiting, 1)
  assert.equal(snap.pool.bulk.waiting, 1)
  // ★ 顶层语义不许改：老测试与面板断言的就是这两个数
  assert.equal(snap.running, 2, '顶层 running = 两池之和')
  assert.equal(snap.waiting, 2, '顶层 waiting = 两池之和')

  ac.abort()
  await Promise.all(ps)
})

test('③ ★★ 不配 llmMaxConcurrentBulk ⇒ 回落 1（第二个 bulk 必须排队）', { timeout: 8000 }, async () => {
  const ac = new AbortController()
  const gates = []
  const llm = fakeLlm(hangingFactory(gates))
  // ★ settings 里**一个并发键都不给** ⇒ 两个池都该回落到 1
  const channel = makeChannel(llm)

  const p1 = channel.runStructured({ system: 's', user: 'u', label: 'b1', pool: 'bulk', signal: ac.signal })
  const p2 = channel.runStructured({ system: 's', user: 'u', label: 'b2', pool: 'bulk', signal: ac.signal })

  const ok = await waitFor(() => {
    const s = channel.snapshot()
    return s.pool.bulk.running === 1 && s.pool.bulk.waiting === 1
  })
  assert.equal(ok, true,
    '★ 缺省必须是 1：第二个 bulk 要排队。实得 ' + JSON.stringify(channel.snapshot().pool.bulk))

  ac.abort()
  await Promise.all([p1, p2])
})

test('④ ★★ 池名拼错 ⇒ 归 live，不许静默降级进后台池', { timeout: 8000 }, async () => {
  const ac = new AbortController()
  const gates = []
  const llm = fakeLlm(hangingFactory(gates))
  const channel = makeChannel(llm, { llmMaxConcurrent: 1, llmMaxConcurrentBulk: 1 })

  // 先占住 live 唯一一格
  const liveP = channel.runStructured({ system: 's', user: 'u', label: 'live', pool: 'live', signal: ac.signal })
  const ok = await waitFor(() => channel.snapshot().pool.live.running === 1)
  assert.equal(ok, true, 'live 要先被占住')

  // 拼错的池名：必须等同 live ⇒ **排队**（不是等同 bulk 立刻跑）
  const typoP = channel.runStructured({ system: 's', user: 'u', label: 'typo', pool: 'bulkk', signal: ac.signal })
  const queued = await waitFor(() => channel.snapshot().pool.live.waiting === 1)
  assert.equal(queued, true,
    '★ 拼错的池名必须归 live ⇒ 排到 live 队列里。'
    + '如果它降级进了 bulk，就会立刻跑 —— 一个手滑把关键路径埋进后台池')
  assert.equal(channel.snapshot().pool.bulk.waiting, 0, 'bulk 队列不许被拼错的名字污染')
  assert.equal(channel.snapshot().pool.bulk.running, 0, 'bulk 池一个都不许跑')

  ac.abort()
  await Promise.all([liveP, typoP])
})

// ══════════════════════════════════════════════════════════════════════
// ★★ 2026-10-21：**per-call reasoningEffort（小任务思考档）**
// ══════════════════════════════════════════════════════════════════════
//
// 现场：情绪打分一个 6 字段 JSON 要 4–6 秒，占一句回复总等待的 **70–82%**
// （实测 5.83s 里 4.09s 是它；主模型生成只要 1.3–1.7s）。
// 根因不是模型慢 —— 是 llm-channel **从不传 reasoningEffort** ⇒ 落进宿主默认 high
// （dsh-llm-deepseek/lib/index.js:1694）。原生适配器里 reasoningEffort:"off"
// 在线上就是 thinking:{type:"disabled"}（同文件 :1707），**是真关**；
// 宿主自己对 session-title 就这么干（:1694）。
//
// ⚠️ 空字符串 = **不传这个字段**（= 宿主默认档，行为与改动前逐位一致）。
//    所以第 ② 条用 (in options) 判，**不许用 undefined 判**
//    —— undefined 判在"键存在但值是 undefined"时会漏掉，那正是要防的形态。

test('⑬ ★ llmSmallTaskEffort=off ⇒ 假 llm 收到的 options.reasoningEffort 就是 off', { timeout: 8000 }, async () => {
  const llm = textLlm('ok')
  const channel = makeChannel(llm, { llmSmallTaskEffort: 'off' })

  await channel.runStructured({ system: 's', user: 'u', label: 'effort-off' })

  assert.equal(llm.calls.length, 1, '要真的调到假 llm')
  assert.equal(llm.calls[0].reasoningEffort, 'off',
    '★ 不传这一档 ⇒ 落进宿主默认 high ⇒ 小任务白白思考 4 秒（这次改动就是来治它的）')
})

test('⑭ ★★ llmSmallTaskEffort 为空串 ⇒ options 里**根本没有 reasoningEffort 这个键**', { timeout: 8000 }, async () => {
  const llm = textLlm('ok')
  const channel = makeChannel(llm, { llmSmallTaskEffort: '' })

  await channel.runStructured({ system: 's', user: 'u', label: 'effort-empty' })

  assert.equal('reasoningEffort' in llm.calls[0], false,
    '★ 空串 = 不传字段（宿主的默认档）。'
    + '用 in 判而不是 undefined 判 —— 键存在但值是 undefined 也算违规')
})

test('⑮ ★★ 不配这一项 ⇒ 走真实缺省 off（SETTINGS_DEFAULTS 那条链）', { timeout: 8000 }, async () => {
  // ⚠️ 缺省不是 llm-channel 里写死的：readCfg 只做 String(s.llmSmallTaskEffort || '')，
  //    'off' 这个缺省值在 lib/toggle.js 的 SETTINGS_DEFAULTS 里，由 normalizeSettings 落地。
  //    ⇒ 这里必须走真实那条链，自己编一个 'off' 就测不到"缺省还在不在"。
  const normalized = normalizeSettings({})
  assert.equal(normalized.llmSmallTaskEffort, 'off', '缺省必须还是 off')

  const llm = textLlm('ok')
  const channel = createLlmChannel({
    llm,
    // ⚠️ 顺序要紧：normalizeSettings 会把**所有**键填满（llmProvider/llmModel 是空串），
    //    所以 CFG 必须**后**展开去覆盖它们 —— 否则 runStructured 会因为"未配 provider"
    //    提前 return，假 llm 一次都调不到（llm.calls[0] 是 undefined）。
    getSettings: () => ({ ...normalized, ...CFG }),
    log: { warn: () => {} }
  })
  await channel.runStructured({ system: 's', user: 'u', label: 'effort-default' })

  assert.equal(llm.calls[0].reasoningEffort, 'off', '★ 不配也要关思考')
})

test('⑯ ★★ 反思（bulk 池）永远拿不到这一档 ⇒ 保住它的质量', { timeout: 8000 }, async () => {
  // 这一条钉的是 llm-channel 里的**池闸**：
  //   `llmSmallTaskEffort` 治的是**组装前那两个小调用**（live 池；一个 6 字段 JSON
  //   白思考 4 秒）。而 reflectTransport（轮末反思）走的也是 runStructured，
  //   只是它在 **bulk 池** —— 反思是**要质量**的，跟着降到 off 等于省 4 秒把自省砍了。
  //
  //   ⚠️ 那条线画在**池**上，而不是去改 reflectTransport 那个调用点（不许动它）。
  const llm = textLlm('ok')
  const channel = makeChannel(llm, { llmSmallTaskEffort: 'off' })

  await channel.runStructured({ system: 's', user: 'u', label: 'reflect', pool: 'bulk' })

  assert.equal('reasoningEffort' in llm.calls[0], false,
    '★ bulk 池（反思）不许被降档 —— 省略这个键才是宿主的默认档')

  // 对照：同一个 channel、同一个设置，live 池必须拿到 off
  await channel.runStructured({ system: 's', user: 'u', label: 'emotion', pool: 'live' })
  assert.equal(llm.calls[1].reasoningEffort, 'off', '同设置下 live 池要关思考')
})
