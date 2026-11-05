/**
 * 阶段 2 形态 (b):子代理通道的 4 个只读记忆工具 —— 闸。
 * ============================================================================
 * 设计依据:`docs/PLAN_MEMORY_GRAPH_ACTION.md` §3。这里钉住四件事:
 *   ① **开关关 = 逐位不变**:`subagentToolFilter(false)` 深等于 `{ allow: [] }`,
 *      且没注入 provider 时 `runStructured` 传的就是这个对象(改动前的硬编码值)。
 *   ② **只读**:4 个工具只走 store 的只读读口 —— `recall_count` / `half_life` /
 *      `last_recalled` 前后逐位不变,且**绝不**碰会强化的 `store.retrieve()`。
 *   ③ **上限生效**:limit / maxChars / depth 的硬顶在工具侧强制。
 *   ④ **出错与空结果可区分**:没命中 = `ok:true` + 空数组 + `note`;出错 = `ok:false` + `reason`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../lib/store.js'
import {
  SUBAGENT_MEMORY_TOOL_NAMES, MEMORY_TOOL_LIMITS, MEMORY_TOOL_ENV, MEMORY_TOOL_CONFIG_KEY,
  memoryToolsEnabledFromEnv, memoryToolsEnabledFromConfig, memoryToolsEnabled, subagentToolFilter,
  createReadOnlyReader, memoryReadToolDefinitions
} from '../lib/memory-read-tools.js'
import { runStructured, setSubagentToolFilterProvider } from '../lib/reflect.js'

// ---------------------------------------------------------------- ① 默认关 = 逐位不变

test('① subagentToolFilter(false) 与改动前逐位相同:{ allow: [] }', () => {
  const off = subagentToolFilter(false)
  assert.deepEqual(off, { allow: [] })
  assert.equal(JSON.stringify(off), JSON.stringify({ allow: [] }))
  // 非 true 的一切(undefined / null / 0 / 'true' 字符串)都算关
  for (const v of [undefined, null, 0, '', 'true', 1]) {
    assert.deepEqual(subagentToolFilter(v), { allow: [] })
  }
})

test('① 开关开时只允许这 4 个(名单与工具定义同源)', () => {
  assert.deepEqual(subagentToolFilter(true), { allow: [...SUBAGENT_MEMORY_TOOL_NAMES] })
  assert.equal(SUBAGENT_MEMORY_TOOL_NAMES.length, 4)
  const store = openStore(':memory:')
  const names = memoryReadToolDefinitions(createReadOnlyReader(store)).map((d) => d.name).sort()
  assert.deepEqual(names, [...SUBAGENT_MEMORY_TOOL_NAMES].sort())
  store.close()
})

test('① 开关读数:只有 ECHO_MEMORY_SUBAGENT_TOOLS=1 才算开', () => {
  assert.equal(MEMORY_TOOL_ENV, 'ECHO_MEMORY_SUBAGENT_TOOLS')
  assert.equal(memoryToolsEnabledFromEnv({}), false)
  assert.equal(memoryToolsEnabledFromEnv(undefined), false)
  assert.equal(memoryToolsEnabledFromEnv({ [MEMORY_TOOL_ENV]: '0' }), false)
  assert.equal(memoryToolsEnabledFromEnv({ [MEMORY_TOOL_ENV]: 'yes' }), false)
  assert.equal(memoryToolsEnabledFromEnv({ [MEMORY_TOOL_ENV]: '1' }), true)
})

// ①b 配置那条路(不重启宿主的唯一入口):key 名 + 严格 true + 三路 OR + 全缺=关。
// 依据:环境变量只能重启才改得动(process.env 在宿主启动时固定、apply 只跑一次);
// 配置路线靠 profile 的 `patchReload: live` 重新组合生效 —— 见 lib/memory-read-tools.js 注释。
test('①b 配置读数:key 必须是 memorySubagentTools,且严格 === true', () => {
  assert.equal(MEMORY_TOOL_CONFIG_KEY, 'memorySubagentTools')
  assert.equal(memoryToolsEnabledFromConfig({ memorySubagentTools: true }), true)
  // 不是 true 的一切都不算开(字符串 'true' / 1 / '1' / 缺键 / 非对象)
  for (const v of [undefined, null, {}, { memorySubagentTools: false },
    { memorySubagentTools: 'true' }, { memorySubagentTools: 1 },
    { memorySubagentTools: '1' }, { other: true }, 'true', 1, []]) {
    assert.equal(memoryToolsEnabledFromConfig(v), false, '不该把 ' + JSON.stringify(v) + ' 当开')
  }
})

test('①b 总读数:env 或 config 或 settings 任一为真即开;全缺 ⇒ 关(与改动前逐位相同)', () => {
  // 全缺 = 关,source 只用于留痕
  assert.deepEqual(memoryToolsEnabled({}), { on: false, source: 'off' })
  assert.deepEqual(memoryToolsEnabled({ env: {}, config: {}, settings: {} }), { on: false, source: 'off' })
  assert.equal(memoryToolsEnabled({ env: {}, config: { memorySubagentTools: false } }).on, false)
  // 三条路各自单独为真
  assert.equal(memoryToolsEnabled({ env: { [MEMORY_TOOL_ENV]: '1' } }).on, true)
  assert.equal(memoryToolsEnabled({ config: { memorySubagentTools: true } }).on, true)
  assert.equal(memoryToolsEnabled({ settings: { memorySubagentTools: true } }).on, true)
  // 来源留痕(判定不看它,但日志要能指着说"是哪条路开的")
  assert.equal(memoryToolsEnabled({ env: { [MEMORY_TOOL_ENV]: '1' } }).source, 'env:' + MEMORY_TOOL_ENV)
  assert.equal(memoryToolsEnabled({ config: { memorySubagentTools: true } }).source, 'loader-config:' + MEMORY_TOOL_CONFIG_KEY)
  assert.equal(memoryToolsEnabled({ settings: { memorySubagentTools: true } }).source, 'settings:' + MEMORY_TOOL_CONFIG_KEY)
  // env 优先于 config(两条同时给 ⇒ 报 env)
  assert.equal(memoryToolsEnabled({
    env: { [MEMORY_TOOL_ENV]: '1' }, config: { memorySubagentTools: true }
  }).source, 'env:' + MEMORY_TOOL_ENV)
})

/** 假 subagents:抓 request 后立刻"成功完成",不真起子代理。 */
function fakeSubagents (captured) {
  return {
    list: () => ['spawn'],
    start: async (provider, req) => {
      captured.push(req)
      return {
        result: Promise.resolve({ stopReason: 'completed', structured: { ok: true } }),
        dispose: async () => {}
      }
    }
  }
}

test('① runStructured 默认传 { allow: [] }(与改动前逐位相同);provider 只改它', async () => {
  const captured = []
  const subagents = fakeSubagents(captured)
  const base = { prompt: 'p', schema: { type: 'object' }, label: 'echo-test', parent: null, signal: new AbortController().signal }

  // (a) 没注入 provider = 改动前的行为
  setSubagentToolFilterProvider(null)
  await runStructured(subagents, base)
  assert.deepEqual(captured[0].toolFilter, { allow: [] })

  // (b) 注入"关"的 provider = 仍然是 { allow: [] }
  setSubagentToolFilterProvider(() => subagentToolFilter(false))
  await runStructured(subagents, base)
  assert.deepEqual(captured[1].toolFilter, { allow: [] })

  // (c) 注入"开"的 provider ⇒ 子代理只拿这 4 个
  setSubagentToolFilterProvider(() => subagentToolFilter(true))
  await runStructured(subagents, base)
  assert.deepEqual(captured[2].toolFilter, { allow: [...SUBAGENT_MEMORY_TOOL_NAMES] })

  // (d) 显式传的 toolFilter 优先(不经过 provider)
  await runStructured(subagents, { ...base, toolFilter: { allow: ['x'] } })
  assert.deepEqual(captured[3].toolFilter, { allow: ['x'] })

  // (e) provider 返回坏值 ⇒ 退回默认关(不静默传 undefined 给宿主)
  setSubagentToolFilterProvider(() => undefined)
  await runStructured(subagents, base)
  assert.deepEqual(captured[4].toolFilter, { allow: [] })

  setSubagentToolFilterProvider(null) // 别把状态漏给别的测试
})

// ---------------------------------------------------------------- ② 只读

function seededStore () {
  const store = openStore(':memory:')
  const idA = store.insertMemory({
    keywords: ['校园跑', '3km'],
    summary: '用户提到校园跑有要求,需要在手机监视器上完成3km并且有速度限制',
    emotionScore: 6
  })
  const idB = store.insertMemory({
    keywords: ['章鱼小丸子'],
    summary: '用户表示以后会学着做章鱼小丸子',
    emotionScore: 5
  })
  // 图:一条 校园跑 -要求-> 3km速度限制
  store.db.prepare('INSERT INTO graph_nodes (node_id, name) VALUES (?, ?)').run('n-school', '校园跑')
  store.db.prepare('INSERT INTO graph_nodes (node_id, name) VALUES (?, ?)').run('n-speed', '3km速度限制')
  store.db.prepare('INSERT INTO graph_edges (source_id, target_id, relation, weight, owner_key) VALUES (?, ?, ?, ?, ?)')
    .run('n-school', 'n-speed', '要求', 4, 'master')
  return { store, idA, idB }
}

const fingerprint = (store) => store.db.prepare(
  'SELECT memory_id, half_life, recall_count, last_recalled FROM episodic_memory ORDER BY memory_id'
).all().map((r) => [r.memory_id, r.half_life, r.recall_count, r.last_recalled])

/** 跑一遍全部 4 个工具(通过宿主工具定义的 execute,而不是直接调 reader)。 */
async function runAllTools (store) {
  const defs = memoryReadToolDefinitions(createReadOnlyReader(store))
  const byName = new Map(defs.map((d) => [d.name, d]))
  const out = {}
  out.search = await byName.get('memory_search').execute({ query: '校园跑', limit: 5 })
  out.get = await byName.get('memory_get').execute({ memoryId: 1, maxChars: 400 })
  out.neighbors = await byName.get('memory_neighbors').execute({ node: '校园跑', depth: 1, limit: 8 })
  out.timeline = await byName.get('memory_timeline').execute({ days: 30, limit: 10 })
  return out
}

test('② 只读:跑完 4 个工具,recall_count / half_life / last_recalled 逐位不变', async () => {
  const { store, idA } = seededStore()
  const before = fingerprint(store)
  const out = await runAllTools(store)
  assert.equal(out.search.ok, true)
  assert.ok(out.search.hits.some((h) => h.memoryId === idA), 'search 应该命中校园跑那条')
  assert.deepEqual(fingerprint(store), before)
  // 强化回写的正面证据:同一批行里 recall_count 一个都没涨(「被想起」才会 +1)
  for (const row of fingerprint(store)) assert.equal(row[2], 0)
  store.close()
})

test('② 只读:reader 绝不走会强化的 store.retrieve()', async () => {
  const { store } = seededStore()
  store.retrieve = () => { throw new Error('只读工具不许走强化路径 store.retrieve') }
  const out = await runAllTools(store) // 走了就抛 ⇒ 被 wrap 转成 ok:false ⇒ 下面断言会红
  assert.equal(out.search.ok, true)
  assert.equal(out.get.ok, true)
  assert.equal(out.neighbors.ok, true)
  assert.equal(out.timeline.ok, true)
  store.close()
})

test('② reader 起不来时**当场抛**(不静默降级):store 缺席 / 缺读口', () => {
  assert.throws(() => createReadOnlyReader(null), /store 缺席/)
  assert.throws(() => createReadOnlyReader({}), /少了只读读口/)
  assert.throws(() => createReadOnlyReader({ listMemories: () => {} }), /store 少了只读读口 `memoriesByIds`/)
  assert.throws(() => memoryReadToolDefinitions(null), /reader 缺席/)
})

// ---------------------------------------------------------------- ③ 上限生效

test('③ 上限在工具侧强制(不信任调用方给的 limit / maxChars / depth)', async () => {
  const store = openStore(':memory:')
  for (let i = 0; i < 20; i++) {
    store.insertMemory({ keywords: ['校园跑'], summary: '第 ' + i + ' 条:校园跑相关的事', emotionScore: 5 })
  }
  const { idA } = { idA: 1 }
  const long = '长'.repeat(3000)
  store.db.prepare('UPDATE episodic_memory SET summary = ? WHERE memory_id = ?').run(long, idA)
  // 图也要有,才验得到 depth 硬顶
  store.db.prepare('INSERT INTO graph_nodes (node_id, name) VALUES (?, ?)').run('n-school', '校园跑')
  store.db.prepare('INSERT INTO graph_nodes (node_id, name) VALUES (?, ?)').run('n-speed', '3km速度限制')
  store.db.prepare('INSERT INTO graph_edges (source_id, target_id, relation, weight, owner_key) VALUES (?, ?, ?, ?, ?)')
    .run('n-school', 'n-speed', '要求', 4, 'master')

  const defs = memoryReadToolDefinitions(createReadOnlyReader(store))
  const byName = new Map(defs.map((d) => [d.name, d]))

  const s = await byName.get('memory_search').execute({ query: '校园跑', limit: 9999 })
  assert.equal(s.ok, true)
  assert.ok(s.hits.length <= MEMORY_TOOL_LIMITS.searchLimit, 'search 条数必须 ≤ 硬顶')

  const g = await byName.get('memory_get').execute({ memoryId: idA, maxChars: 999999 })
  assert.equal(g.ok, true)
  assert.ok(g.summary.length <= MEMORY_TOOL_LIMITS.getChars + 20, 'get 必须截断到硬顶附近')

  const n = await byName.get('memory_neighbors').execute({ node: '校园跑', depth: 999, limit: 999 })
  assert.equal(n.ok, true)
  assert.equal(n.depth, MEMORY_TOOL_LIMITS.depthMax, 'depth 硬顶 = 1')

  const t = await byName.get('memory_timeline').execute({ days: 99999, limit: 99999 })
  assert.equal(t.ok, true)
  assert.equal(t.days, MEMORY_TOOL_LIMITS.daysMax, 'days 硬顶 = 30')
  assert.ok(t.items.length <= MEMORY_TOOL_LIMITS.timelineLimit, 'timeline 条数必须 ≤ 硬顶')
  store.close()
})

// ---------------------------------------------------------------- ④ 出错 vs 空结果

test('④ 空结果与出错长得不一样:no-hit = ok:true + 空数组;出错 = ok:false + reason', async () => {
  const { store } = seededStore()
  const defs = memoryReadToolDefinitions(createReadOnlyReader(store))
  const byName = new Map(defs.map((d) => [d.name, d]))

  // 空结果
  const empty = await byName.get('memory_search').execute({ query: 'zzzzqqqq', limit: 5 })
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.hits, [])
  assert.equal(empty.note, 'no-hit')

  // 出错(reader 抛)⇒ 绝不是"空数组"
  const bad = memoryReadToolDefinitions({
    search: () => { throw new Error('db gone') },
    get: () => { throw new Error('db gone') },
    neighbors: () => { throw new Error('db gone') },
    timeline: () => { throw new Error('db gone') }
  })
  const badByName = new Map(bad.map((d) => [d.name, d]))
  for (const name of SUBAGENT_MEMORY_TOOL_NAMES) {
    const r = await badByName.get(name).execute({ query: '校园跑', memoryId: 1, node: '校园跑', days: 7 })
    assert.equal(r.ok, false, name + ' 出错必须 ok:false')
    assert.match(String(r.reason), /-failed: db gone$/, name + ' 的 reason 必须带工具名与原因')
    assert.equal(r.hits, undefined, name + ' 出错不许伪装成"空结果"')
  }
  store.close()
})

test('④ 出参必须带 matched / cov(L0 常在场不许和真实命中混在一起)', async () => {
  const { store } = seededStore()
  const defs = memoryReadToolDefinitions(createReadOnlyReader(store))
  const r = await defs.find((d) => d.name === 'memory_search').execute({ query: '校园跑', limit: 5 })
  for (const h of r.hits) {
    assert.equal(typeof h.matched, 'boolean')
    assert.equal(typeof h.cov, 'number')
    assert.equal(typeof h.forced, 'boolean')
  }
  store.close()
})

test('④ 输出必须是无损 JSON(宿主第二道校验)', async () => {
  const { store } = seededStore()
  const out = await runAllTools(store)
  for (const v of Object.values(out)) {
    assert.deepEqual(JSON.parse(JSON.stringify(v)), v)
  }
  store.close()
})
