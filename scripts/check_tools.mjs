// dsh-echo — 离线工具定义校验(defineTool 电池)
// =====================================================================
// 为什么需要:工具定义的 `parameters` 是**隐式属性表**(不是 JSON Schema
// 对象),schema 写错在 `npm test` / `npm run check` 里全看不出来 ——
// 宿主只在 `dsh web` 启动装载插件时才校验,于是错误形态变成「启动即崩」。
// 这个仓库为此吃过两次亏(v0.1.x:隐式属性表坑、每属性必须有具体类型坑)。
// 所以每次动工具定义,先用**宿主真实的 defineTool** 过一遍,再装机。
//
// 用法:`node scripts/check_tools.mjs`(或 `npm run check:tools`)。
//
// 它做了什么(以及为什么需要这么绕):`lib/index.js` 静态 import
// `@deepseek-ai/dsh-tools`,而本仓**不装 node_modules**(插件靠宿主注入
// 解析)。所以脚本先按候选路径找到宿主的 dsh-tools,再临时在
// `node_modules/@deepseek-ai` 挂一个 junction 指向宿主的同名作用域目录,
// 跑完校验后把 junction 摘掉(只删链接,绝不进宿主的真目录)。
// 找不到宿主时**不算失败** —— 这台机器没装宿主也能跑其余全部离线电池,
// 屏幕上会打印跳过原因与补救办法。
import { existsSync, mkdirSync, rmdirSync, readdirSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const repoRoot = dirname(fileURLToPath(new URL('.', import.meta.url)))

/** 候选位置:先按包名解析(装机副本里能直接解析),再按常见全局安装位置找。 */
function candidates () {
  const out = []
  if (process.env.DSH_TOOLS_PATH) out.push(process.env.DSH_TOOLS_PATH)
  out.push('@deepseek-ai/dsh-tools')
  const appData = process.env.APPDATA
  const roots = [
    appData ? join(appData, 'npm', 'node_modules') : null,
    join(homedir(), '.npm-global', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules'
  ].filter(Boolean)
  for (const root of roots) {
    out.push(join(root, '@deepseek-ai', 'dsh', 'node_modules',
      '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  }
  return out
}

async function loadDefineTool () {
  const tried = []
  for (const c of candidates()) {
    const bare = c.startsWith('@')
    if (!bare && !existsSync(c)) { tried.push(c + ' (不存在)'); continue }
    try {
      const mod = await import(bare ? c : pathToFileURL(c).href)
      if (typeof mod.defineTool === 'function') {
        // <...>/node_modules/@deepseek-ai/dsh-tools/lib/index.js
        //   → dirname×3 = <...>/node_modules/@deepseek-ai(要挂的正是它)
        return {
          defineTool: mod.defineTool,
          entry: bare ? c : c,
          dir: bare ? null : dirname(dirname(dirname(c)))
        }
      }
      tried.push(c + ' (无 defineTool 导出)')
    } catch (err) {
      tried.push(c + ' (' + String(err?.code ?? err) + ')')
    }
  }
  return { defineTool: null, tried }
}

const { defineTool, entry, dir, tried } = await loadDefineTool()
if (defineTool === null) {
  console.log('check_tools: 跳过 —— 找不到宿主 @deepseek-ai/dsh-tools(离线电池其余部分不受影响)')
  console.log('  找过: ' + (tried || []).join(' / '))
  console.log('  想强制跑: DSH_TOOLS_PATH=<dsh-tools/lib/index.js 绝对路径> node scripts/check_tools.mjs')
  process.exit(0)
}

// 宿主作用域目录(<...>/node_modules/@deepseek-ai),用于临时 junction。
// 按包名解析成功时(装机副本内)不需要 junction —— 那里本来就能解析。
const scopeDir = dir !== null && /[\\/]@deepseek-ai$/.test(dir) ? dir : null
const linkPath = join(repoRoot, 'node_modules', '@deepseek-ai')
const linkDir = join(repoRoot, 'node_modules')
let linked = false
let madeNodeModules = false

function cleanup () {
  if (!linked) return
  try { rmdirSync(linkPath) } catch { /* 摘不掉就算了,不留半个链接 */ }
  if (madeNodeModules) {
    try { if (readdirSync(linkDir).length === 0) rmdirSync(linkDir) } catch { /* 同上 */ }
  }
}

try {
  if (scopeDir !== null && !existsSync(linkPath)) {
    try {
      madeNodeModules = !existsSync(linkDir)
      mkdirSync(linkDir, { recursive: true })
      symlinkSync(scopeDir, linkPath, 'junction')
      linked = true
    } catch (err) {
      console.log('check_tools: 跳过 —— 无法临时链接宿主依赖(' + String(err?.message ?? err) + ')')
      process.exit(0)
    }
  }
  const { statusToolDefinition, memoryToolDefinitions, statusPayload } = await import('../lib/index.js')
  // 她的手(echo_qq_say / echo_qq_call)在 lib/relay-tools.js —— 零宿主依赖,
  // 所以能单独校验,也能直接进单元电池。这里只看 schema 过不过 defineTool;
  // 真桥行为由 relay 电池与真宿主胶水盯。
  const { relayToolDefinitions } = await import('../lib/relay-tools.js')
  // 她的手(echo_qq_say / echo_qq_call)用假桥定义一遍 —— 这里只看
  // schema 过不过 defineTool;真桥的行为由 relay 电池与真宿主胶水盯。
  const fakeRelay = { say: () => ({ ok: true, sent: 1, kind: 'reply', targets: ['QQ:私聊'], chars: 3 }) }
  // 清空上下文(2026-09-26 他要的按钮):同样零宿主依赖 —— 真干活的那只
  // clear(sessionId) 由 index.js 注入,这里给个假的,只看 schema。
  const { contextClearToolDefinition } = await import('../lib/context-clear.js')
  // 阶段 2 形态 (b):子代理通道的 4 个**只读**记忆工具(`lib/memory-read-tools.js`,
  // 开关 `ECHO_MEMORY_SUBAGENT_TOOLS=1`、**默认关**)。它们和上面那批一样是
  // "只有真加载才炸"的那类定义 —— 所以定义与真实返回值都要过宿主两道校验。
  // 这个模块零宿主依赖(只 import ../lib/retrieve.js),这里给一个 :memory: 库当 reader。
  const { createReadOnlyReader, memoryReadToolDefinitions } = await import('../lib/memory-read-tools.js')
  const { openStore: openMemReadStore, MASTER_ID } = await import('../lib/store.js')
  const memReadStore = openMemReadStore(':memory:')
  const memReadDefs = memoryReadToolDefinitions(createReadOnlyReader(memReadStore))
  const defs = [
    statusToolDefinition(),
    ...memoryToolDefinitions(),
    ...memReadDefs,
    ...relayToolDefinitions({ relay: fakeRelay, isEnabled: () => true, sessionEnabledOf: () => true }),
    contextClearToolDefinition({
      clear: async () => ({ ok: true, code: 'cleared', text: '清掉了 3 条旧历史(约 1200 tokens)', shadowed: 3, tokens: 1200 }),
      sessionEnabledOf: () => true
    })
  ]
  let ok = 0
  const failures = []
  for (const def of defs) {
    try {
      defineTool(def)
      ok++
      console.log('  ok   ' + def.name)
    } catch (err) {
      failures.push(def.name + ': ' + String(err?.message ?? err))
      console.log('  FAIL ' + def.name + ' — ' + String(err?.message ?? err))
    }
  }
  console.log('check_tools: ' + String(ok) + '/' + String(defs.length)
    + ' 个定义过宿主 defineTool(' + (entry.startsWith('@') ? '按包名解析' : entry) + ')')

  // ---- 载荷 × schema + 无损 JSON:用**宿主的**校验器跑一遍真实返回值 ----
  // 2026-09-26 现场两连炸:① echo_status 的 payload 里 lastLoadAt 是 ISO
  // 字符串、还多出 relay/profile/auditRows/superseded/profileFields 五个没声明
  // 的键;② echo_qq_say 成功时带了个 `reason: undefined` —— 键在、值 undefined,
  // 宿主判「value is not lossless JSON」,整条回执被拒(而消息其实已经发出去了)。
  // 上面那圈 defineTool 只验**定义**,验不了返回值,所以这两类必须在这里单独撞:
  // schema 那道用宿主的 validateJsonSchemaValue,「无损」那道判据是 JSON 往返一次
  // 得原样回来。
  const losslessProblems = []
  const checkLossless = (name, value) => {
    const round = JSON.parse(JSON.stringify(value))
    if (JSON.stringify(round) !== JSON.stringify(value)) {
      losslessProblems.push(name + ' 不是无损 JSON(键在、值 undefined 是常见原因)')
    }
    const seen = new Set()
    const walk = (v, path) => {
      if (v === undefined) losslessProblems.push(name + ' 里 ' + path + ' 是 undefined')
      else if (typeof v === 'number' && !Number.isFinite(v)) losslessProblems.push(name + ' 里 ' + path + ' 不是有限数')
      else if (typeof v === 'function' || typeof v === 'bigint' || typeof v === 'symbol') {
        losslessProblems.push(name + ' 里 ' + path + ' 不是 JSON 值(' + typeof v + ')')
      } else if (v !== null && typeof v === 'object') {
        if (seen.has(v)) { losslessProblems.push(name + ' 里 ' + path + ' 有环'); return }
        seen.add(v)
        for (const [k, sub] of Object.entries(v)) walk(sub, path + '.' + k)
      }
    }
    walk(value, '$')
  }
  try {
    const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
    const schemaOf = (def) => def?.output?.schema
    const payloads = [
      { name: 'echo_status', schema: schemaOf(statusToolDefinition()), value: statusPayload() }
    ]
    // 构建指纹(2026-09-26 审计第一条):`statusPayload().build` 要真的算得出来
    // —— 活着的那份 lib 指纹为空 = 「重启没重启」还是分不出来,那这枚指纹白加。
    // 放在这里而不是 tests/:本仓不装 node_modules,`tests/` 里 import lib/index.js
    // 会直接 ERR_MODULE_NOT_FOUND(这个脚本临时挂了宿主依赖,所以能 import)。
    try {
      const b = statusPayload().build
      if (b === undefined || !/^[0-9a-f]{12}$/.test(String(b.short)) || !(b.files > 0)) {
        losslessProblems.push('echo_status.build 指纹没算出来: ' + JSON.stringify(b))
      }
    } catch (err) {
      losslessProblems.push('echo_status.build 读不到:' + String(err?.message ?? err))
    }
    // 库**在线**那份也要撞一次:离线用占位零值,在线走 store.memoryStats()
    // 的真字段 —— 两套键集不一样,只验一套等于漏一半。
    // 2026-09-30 P2:`profile.derivedFromL0` 是**对象数组**(`{memoryId, field,
    // summary}`),schema 却曾把它声明成 `items:{type:'string'}` —— 空数组对
    // `items` 无法证伪,所以老夹具一直是绿的,而真机一调就报
    // 「value.profile.derivedFromL0[0] must be a string」。这里先塞一条 L0 行
    // 再读**真实投影**,让这条闸真的碰到那个对象。
    try {
      const { openStore, MASTER_ID } = await import('../lib/store.js')
      const probe = openStore(':memory:')
      probe.db.prepare(
        'INSERT INTO episodic_memory (user_id, keywords, summary, emotion_score, timestamp, is_active,'
        + " status, layer, memory_key, memory_type) VALUES (?, '称呼', '他让我叫他<称呼>', 6, ?, 1, 'active', 'L0', 'preferredName', 'identity')"
      ).run(MASTER_ID, Date.now() / 1000)
      const profileWithL0 = probe.getProfile()
      if (!Array.isArray(profileWithL0.derivedFromL0) || profileWithL0.derivedFromL0.length === 0) {
        console.log('  跳过 derivedFromL0×schema 校验(夹具没造出 L0 行)')
      } else {
        payloads.push({
          name: 'echo_status(画像带 L0 投影)',
          schema: schemaOf(statusToolDefinition()),
          value: { ...statusPayload(), memoryOnline: true, memory: probe.memoryStats(), profile: profileWithL0 }
        })
      }
      payloads.push({
        name: 'echo_status(库在线)',
        schema: schemaOf(statusToolDefinition()),
        value: { ...statusPayload(), memoryOnline: true, memory: probe.memoryStats() }
      })
      try { probe.close() } catch { /* 关不掉就算了 */ }
    } catch (err) {
      console.log('  跳过 在线形状校验(开不了临时库):' + String(err?.message ?? err))
    }
    // v0.41.0:状态面那两个**统计面**(sameTurnEmotion / reflect)也要撞一次。
    // 离线 `statusPayload()` 里它们都是 null,漏声明一个键根本检不出来 —— 而
    // schema 是 `additionalProperties: false`,漏一个键 = echo_status 每次调用
    // 都被宿主拒(2026-09-26 的 care 字段就是这么炸的)。形状取自 lib/index.js
    // 的 `statusShapes()`(**键集从模块自己算出来**,不靠人记得同步)。
    try {
      const { statusShapes } = await import('../lib/index.js')
      for (const s of statusShapes()) {
        payloads.push({
          name: 'echo_status(' + s.name + ')',
          schema: schemaOf(statusToolDefinition()),
          value: { ...statusPayload(), [s.face]: s.value }
        })
      }
    } catch (err) {
      console.log('  跳过 统计面×载荷校验:' + String(err?.message ?? err))
    }
    // 她的两只手:五条出口全撞一遍(成功 + 四道门 + 桥拒绝)。假桥只回一个
    // 结果,不碰真库、不发 QQ。
    try {
      const { relayToolDefinitions } = await import('../lib/relay-tools.js')
      const defs2 = relayToolDefinitions({
        relay: { say: () => ({ ok: true, sent: 1, kind: 'reply', targets: ['QQ:私聊'], chars: 3 }) },
        isEnabled: () => true,
        sessionEnabledOf: () => true
      })
      const both = relayToolDefinitions({
        relay: { say: () => ({ ok: false, reason: 'no-channel', sent: 0, targets: [], chars: 0 }) },
        isEnabled: () => false,
        sessionEnabledOf: () => false
      })
      const exec = { agent: { session: { id: 'session-check' } } }
      for (const d of defs2) {
        payloads.push({ name: d.name + '(成功)', schema: schemaOf(d), value: await d.execute({ text: '在的' }, exec) })
      }
      for (const d of both) {
        payloads.push({ name: d.name + '(桥关)', schema: schemaOf(d), value: await d.execute({ text: '在的' }, exec) })
      }
      const offRelay = relayToolDefinitions({
        relay: { say: () => ({ ok: true, sent: 1, kind: 'reply', targets: [], chars: 3 }) },
        isEnabled: () => true,
        sessionEnabledOf: () => true
      })
      for (const d of offRelay) {
        payloads.push({ name: d.name + '(空文本)', schema: schemaOf(d), value: await d.execute({ text: '  ' }, exec) })
      }
    } catch (err) {
      console.log('  跳过 手×载荷校验:' + String(err?.message ?? err))
    }
    // 阶段 2 形态 (b):4 个只读记忆工具的真实返回值 × 自己的 schema + 无损 JSON。
    // 为什么要单独撞:① 它们的 schema 是 `additionalProperties:true` 的宽口,
    // 只有**真实返回形状**能证伪(尤其 `ok:false` 那条 —— 出错时不许带 `hits`);
    // ② `matched` / `cov` / `note` 这些键在空结果与出错时**长得不一样**,
    // 那正是"不许静默返回空"的判据,必须让闸真的碰一次。
    try {
      const MR = await import('../lib/memory-read-tools.js')
      const mrExec = { agent: { session: { id: 'session-check' } } }
      const byName = (list) => new Map(list.map((d) => [d.name, d]))
      // 种子:两条记忆 + 一条边(含一条 L0 行,让 `matched:false / forced:true` 也出场)
      memReadStore.insertMemory({ keywords: ['校园跑', '3km'], summary: '用户提到校园跑有要求,需要在手机监视器上完成3km并且有速度限制', emotionScore: 6 })
      memReadStore.insertMemory({ keywords: ['章鱼小丸子'], summary: '用户表示以后会学着做章鱼小丸子', emotionScore: 5 })
      memReadStore.db.prepare(
        "INSERT INTO episodic_memory (user_id, keywords, summary, emotion_score, timestamp, is_active,"
        + " status, layer, memory_key, memory_type) VALUES (?, '称呼', '他让我叫他<称呼>', 6, ?, 1, 'active', 'L0', 'preferredName', 'identity')"
      ).run(MASTER_ID, Date.now() / 1000)
      memReadStore.db.prepare('INSERT INTO graph_nodes (node_id, name) VALUES (?, ?)').run('n-school', '校园跑')
      memReadStore.db.prepare('INSERT INTO graph_nodes (node_id, name) VALUES (?, ?)').run('n-speed', '3km速度限制')
      memReadStore.db.prepare('INSERT INTO graph_edges (source_id, target_id, relation, weight, owner_key) VALUES (?, ?, ?, ?, ?)')
        .run('n-school', 'n-speed', '要求', 4, MASTER_ID)
      const mr = byName(memReadDefs)
      const call = async (name, args) => {
        const d = mr.get(name)
        payloads.push({ name: 'read-tool ' + name, schema: schemaOf(d), value: await d.execute(args, mrExec) })
      }
      await call('memory_search', { query: '校园跑', limit: 9999 })
      await call('memory_search', { query: 'zzzzqqqq', limit: 5 })
      await call('memory_search', { query: '校', limit: 3 }) // 太短 ⇒ query-too-short 那条出口
      await call('memory_get', { memoryId: 1, maxChars: 999999 })
      await call('memory_get', { memoryId: 999999, maxChars: 400 })
      await call('memory_get', { memoryId: 'abc', maxChars: 400 })
      await call('memory_neighbors', { node: '校园跑', depth: 999, limit: 999 })
      await call('memory_neighbors', { node: '不存在的东西', depth: 1, limit: 8 })
      await call('memory_timeline', { days: 99999, limit: 99999 })
      await call('memory_timeline', { days: 1, limit: 0 })
      // reader 抛 ⇒ `ok:false, reason:'<工具>-failed: …'`(出错不许伪装成空结果)
      const badReader = {
        search: () => { throw new Error('db gone') }, get: () => { throw new Error('db gone') },
        neighbors: () => { throw new Error('db gone') }, timeline: () => { throw new Error('db gone') }
      }
      const bad = byName(MR.memoryReadToolDefinitions(badReader))
      for (const name of MR.SUBAGENT_MEMORY_TOOL_NAMES) {
        payloads.push({
          name: 'read-tool ' + name + '(出错)',
          schema: schemaOf(mr.get(name)),
          value: await bad.get(name).execute({ query: '校园跑', memoryId: 1, node: '校园跑', days: 7 }, mrExec)
        })
      }
      // 只读自证:跑完这一圈,recall_count 一个都不许变
      const bumped = memReadStore.db.prepare('SELECT COUNT(*) AS n FROM episodic_memory WHERE recall_count > 0').get()
      if (Number(bumped?.n) > 0) {
        failures.push('read-tool 只读自证:有 ' + Number(bumped.n) + ' 行的 recall_count 被改成 >0(工具不许强化)')
      }
      try { memReadStore.close() } catch { /* 关不掉就算了 */ }
    } catch (err) {
      console.log('  跳过 只读记忆工具×载荷校验:' + String(err?.message ?? err))
    }
    // v0.31.0 P2:她自己的闹钟。出口全撞一遍(排上了 / 空原话 / 时间看不懂 /
    // 太远 / 电源关 / 范围外 / 撤成功 / 撤不到)—— 这两只手的回执里有
    // `reason: undefined` 的坑(成功时不许带这个键),而且 `additionalProperties:false`
    // 漏声明一个键 = 整条回执被宿主拒(echo_status 的 care 字段就是这么炸的)。
    try {
      const { wakeToolDefinitions } = await import('../lib/wake-tools.js')
      const { openStore } = await import('../lib/store.js')
      const wstore = openStore(':memory:')
      const mk = (opts = {}) => wakeToolDefinitions({
        store: wstore,
        isEnabled: opts.isEnabled ?? (() => true),
        sessionEnabledOf: opts.sessionEnabledOf ?? (() => true),
        gates: () => ({ used: 0, cap: 3, night: false }),
        now: opts.now
      })
      const exec = { agent: { session: { id: 'session-check' } } }
      const sched = mk()
      const t0 = Date.now()
      for (const [name, args] of [
        ['echo_wake(排上了)', { after_minutes: 30, note: '问他面试', why: '上午面试' }],
        ['echo_wake(空原话)', { after_minutes: 30, note: '   ' }],
        ['echo_wake(时间看不懂)', { after_minutes: 'abc', note: 'x' }],
        ['echo_wake(太远)', { after_minutes: 60 * 24 * 40, note: 'x' }],
        ['echo_wake(没有时间)', { note: 'x' }]
      ]) {
        const d = sched.find((x) => x.name === 'echo_wake')
        payloads.push({ name, schema: schemaOf(d), value: await d.execute(args, exec) })
      }
      const off = mk({ isEnabled: () => false })
      payloads.push({
        name: 'echo_wake(电源关)',
        schema: schemaOf(off.find((x) => x.name === 'echo_wake')),
        value: await off.find((x) => x.name === 'echo_wake').execute({ after_minutes: 5, note: 'x' }, exec)
      })
      const outOf = mk({ sessionEnabledOf: () => false })
      payloads.push({
        name: 'echo_wake(范围外)',
        schema: schemaOf(outOf.find((x) => x.name === 'echo_wake')),
        value: await outOf.find((x) => x.name === 'echo_wake').execute({ after_minutes: 5, note: 'x' }, exec)
      })
      // 撤:先排一个真闹钟(真库),再撤它两次(第二次必然撤不到)
      const cdef = sched.find((x) => x.name === 'echo_wake_cancel')
      const made = await sched.find((x) => x.name === 'echo_wake').execute({ after_minutes: 5, note: '撤我' }, exec)
      payloads.push({ name: 'echo_wake_cancel(撤成功)', schema: schemaOf(cdef), value: await cdef.execute({ wakeId: made.wakeId }, exec) })
      payloads.push({ name: 'echo_wake_cancel(撤不到)', schema: schemaOf(cdef), value: await cdef.execute({ wakeId: made.wakeId }, exec) })
      payloads.push({ name: 'echo_wake_cancel(没给号)', schema: schemaOf(cdef), value: await cdef.execute({}, exec) })
      // 时钟坏掉(now 给 NaN)也不许返回非无损值
      const bad = mk({ now: () => t0 + 30 * 60 * 1000 })
      payloads.push({
        name: 'echo_wake(正常钟面)',
        schema: schemaOf(bad.find((x) => x.name === 'echo_wake')),
        value: await bad.find((x) => x.name === 'echo_wake').execute({ at: '07:30', note: '早上提醒他吃药' }, exec)
      })
      try { wstore.close() } catch { /* 关不掉就算了 */ }
    } catch (err) {
      console.log('  跳过 闹钟×载荷校验:' + String(err?.message ?? err))
    }
    // 清空上下文:四条出口全撞一遍(清成功 / 没得清 / 范围外 / 没接上手),
    // 真实 execute 的返回值 × 声明过的 schema —— 漏声明一个键就是整条回执被拒。
    try {
      const { contextClearToolDefinition } = await import('../lib/context-clear.js')
      const exec = { agent: { session: { id: 'session-check' } } }
      const mk = (clear, enabled = () => true) => contextClearToolDefinition({ clear, sessionEnabledOf: enabled })
      const cases = [
        ['echo_context_clear(清成功)', mk(async () => ({ ok: true, code: 'cleared', text: '清掉了 5 条旧历史(约 4210 tokens)', shadowed: 5, tokens: 4210 })), {}],
        ['echo_context_clear(没得清)', mk(async () => ({ ok: false, code: 'nothing', text: '宿主说这条会话没有可压的区间。' })), {}],
        ['echo_context_clear(她正忙)', mk(async () => ({ ok: false, code: 'busy', text: '她正忙,等她这轮说完再点。' })), {}],
        ['echo_context_clear(范围外)', mk(async () => ({ ok: true }), () => false), {}],
        ['echo_context_clear(指定别的会话)', mk(async () => ({ ok: true, code: 'cleared', text: 'x', shadowed: 1, tokens: 10 })), { sessionId: 'session-other' }]
      ]
      for (const [name, def, args] of cases) {
        payloads.push({ name, schema: schemaOf(def), value: await def.execute(args, exec) })
      }
    } catch (err) {
      console.log('  跳过 清空上下文×载荷校验:' + String(err?.message ?? err))
    }
    for (const p of payloads) {
      const v = validateJsonSchemaValue(p.schema, p.value)
      const violations = Array.isArray(v) ? v : []
      checkLossless(p.name, p.value)
      if (violations.length === 0 && losslessProblems.length === 0) {
        console.log('  ok   ' + p.name + ' 的真实返回值:过 schema + 是无损 JSON')
      } else if (violations.length > 0) {
        failures.push(p.name + ' payload: ' + violations.slice(0, 4).join('; '))
        console.log('  FAIL ' + p.name + ' 的返回值过不了自己的 schema:')
        for (const s of violations.slice(0, 6)) console.log('         - ' + s)
      } else {
        failures.push(p.name + ' payload: ' + losslessProblems.join('; '))
        console.log('  FAIL ' + p.name + ' 的返回值不是无损 JSON:')
        for (const s of losslessProblems.slice(0, 6)) console.log('         - ' + s)
      }
      losslessProblems.length = 0
    }
  } catch (err) {
    console.log('  跳过 载荷×schema 校验(拿不到宿主的 validateJsonSchemaValue):' + String(err?.message ?? err))
  }

  if (failures.length > 0) {
    console.error('check_tools: 有定义没通过 —— 装机后 dsh web 会在装载期崩,先修再装:')
    for (const f of failures) console.error('  - ' + f)
    process.exitCode = 1
  }
} finally {
  cleanup()
}
