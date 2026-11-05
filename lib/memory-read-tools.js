/**
 * 阶段 2「记忆工具化」形态 (b):给**子代理通道**的 4 个只读记忆工具(**默认关**)。
 * ============================================================================
 * 设计依据:`docs/PLAN_MEMORY_GRAPH_ACTION.md` §3(阶段 2)。
 *
 * 落点(为什么在这里):
 *   · 子代理通道的唯一出口是 `lib/reflect.js` 的 `runStructured` —— 它今天传的是
 *     `toolFilter: { allow: [] }`(子代理**一个工具都没有**)。
 *   · `toolFilter` 在这台宿主上是**限制(restrict)语义**:in-process 驱动把它翻成
 *     `childCtx.tools.restrict(...)`,而 `restrict` 只能从子代理**继承来的**工具面里
 *     **拿掉**工具,不能凭空加。所以"只给子代理"这件事的正确做法 = 工具先存在于
 *     全局层 + 在子代理那一轮用 `allow` 把它的可见面**收到只剩这 4 个**。
 *     ⚠️ 代价(必须照实说):工具一旦注册就在全局层,因此**开关打开时主会话也会看到
 *     这 4 个工具** —— 这台宿主**没有**"只给某个 child 注册工具"的原语
 *     (`dsh-subagent-in-process-driver` 的 `setup` 由驱动自己拥有,调用方注入不进去)。
 *     想做到真正的"只给子代理",需要宿主加一个 per-child 的注册钩子 —— 那是宿主侧
 *     的需求,不是本插件能改的。⇒ **所以本模块的开关默认关:关掉时 0 个工具注册,
 *     逐位不变**。
 *
 * 三条硬纪律(读代码前先看这三条):
 *   ① **默认关 = 逐位相同**:`subagentToolFilter(false)` 必须返回与改动前**同一个形状**
 *      `{ allow: [] }`;且关掉时本模块**不注册任何工具**。这条有单测钉住
 *      (`tests/subagent-memory-tools.test.js`)。
 *   ② **只读**:4 个工具**只调 store 的只读读口**(`listMemories` / `memoriesByIds` /
 *      `graphData`)与纯函数打分器(`lib/retrieve.js` 的 `rankMemories`)。
 *      **绝不**走 `store.retrieve()` 或引擎的 `memory_search` 帧 —— 那两条路**会强化**
 *      (检索即写:`lib/store.js` 的 retrieve 结尾对命中项 UPDATE `half_life` /
 *      `recall_count` / `last_recalled`;`python/worker.py` 的 memory_search 帧自述
 *      "含强化")。只读工具若接到它们身上,就是"查一次改一次库",与 DMAE 每小时
 *      `plan_prune` 打架(`PLAN_MEMORY_GRAPH_ACTION.md` §9.3:幂等、不记水位)。
 *   ③ **失败不许静默返回空**:每个工具的结果都带 `ok`。没命中 = `{ ok: true, ...,
 *      空数组, note: 'no-hit' }`;**出错 = `{ ok: false, reason: '<工具>-failed: …' }`**。
 *      两者在模型眼里必须长得不一样 —— 空结果与"她真的没这段记忆"混在一起,
 *      她会当场说"我不记得"。
 *
 * 依赖全部注入(reader),所以本模块零宿主依赖、可离线单测。
 *
 * ★ 2026-10-01 阶段 2f:**第三路开关搬到网页面板**(他的裁定:「应当在网页仪表盘里改」)。
 *   面板开关落在 `$DSH_HOME/echo/config.json` 顶层 `memorySubagentTools`
 *   (与 enabled/scope 同层;读写在 `lib/toggle.js` 的 readMemoryTools/setMemoryTools),
 *   由 `toggle.readMemoryToolSetting()` 合成进 `settings` 那一份喂给下面的
 *   **同一个** `memoryToolsEnabled` —— 判据仍然只有这一处,没长第二份。
 *   端点与"点了立即生效"的实现在 `lib/index.js`(4b2 段):POST 里当场重算 +
 *   动态 register/dispose 那 4 个工具 + 重设 toolFilter provider
 *   (宿主 `tools.register()` 返回 disposer、`reflect.js` 每次调用现读 provider)。
 *   本模块**依旧零宿主依赖**:上面那两个新导出(来源报表 / 来源人话)也都是纯函数。
 */

import { rankMemories } from './retrieve.js'
import { loadNames } from './names.js'

/** 4 个工具名(也是 `toolFilter.allow` 的名单 —— 两处必须同源)。 */
export const SUBAGENT_MEMORY_TOOL_NAMES = Object.freeze([
  'memory_search', 'memory_get', 'memory_neighbors', 'memory_timeline'
])

/** 硬上限:在**工具侧**强制,不信任调用方给的 limit(照 §3③a)。 */
export const MEMORY_TOOL_LIMITS = Object.freeze({
  searchLimit: 12, searchDefault: 5, summaryChars: 120,
  getChars: 1200, getDefault: 400,
  neighborsLimit: 20, neighborsDefault: 8, depthMax: 1,
  timelineLimit: 20, timelineDefault: 10, daysMax: 30, daysDefault: 7,
  // 声明值:单次工具调用超过它即标 `overBudget`(同步只读函数没法真中断,
  // 所以这里**报数**而不是假装能掐断 —— 报数能被量台看见,假装会被忘掉)。
  callTimeoutMs: 1500,
  // 候选池上限:`store.listMemories` 自己硬顶 200(它的既有契约),这里跟着写清。
  poolLimit: 200
})

/**
 * 说话人 / 人格节点(与 §9.1 的 R1 同一份名单):出参要标出来,别让它们混进"事实"。
 * ★ P1b(模块6):名单搬进了 `<数据目录>/names.json` 的 `speakers`(一次性种子迁移导入);
 *   这里只剩**空默认**(空 ⇒ 没有节点被标成说话人 —— 中性,不猜)。
 */
export const SPEAKER_NODES = Object.freeze([])

/** 现读说话人名单(names.json;缺/空 ⇒ 空表)。循环里请**先取一次**再用。 */
export function speakerNodes () {
  return loadNames().speakers
}

/** 开关的环境变量名(默认关)。 */
export const MEMORY_TOOL_ENV = 'ECHO_MEMORY_SUBAGENT_TOOLS'

/**
 * 开关的**配置键**(默认关;认 loader 传给 `apply(ctx, config)` 的 config,也认插件自己的
 * 设置文件 `settings.memorySubagentTools`)。
 *
 * 为什么要有除环境变量以外的第二条路 —— **环境变量只能靠重启宿主才改得动**:
 *   ① `process.env` 在宿主进程启动时就固定了;② 本插件只在 `apply()` 里读它一次
 *   (`lib/index.js` "5b" 段),而 `apply()` 在插件装载时只跑一次。
 * 而**配置**这一路可以不重启:本部署的 web profile 是 `patchReload: "live"`
 * (`$DSH_HOME/profiles/web/package.json` → `dsh.profile.patchReload`),宿主会监视
 * `$DSH_HOME/profiles/web/cordis.patch.yml` 与 `$DSH_HOME/cordis.patch.yml`,**有效编辑
 * 无需重启即可重新组合**(宿主依据:`dsh-app-boot/lib/index.js` 的 `watchUserPatches()`
 * → `entry.update({config:{patches}})`;`dsh/lib/profile-boot-*.js` 321-338 行)。
 * ⚠️ 但**代码**层不会热加载(`dsh-base/cordis.patch.yml` 的 `hmr` 行是 `disabled: true`,
 * 注释自述 "Module reload is opt-in per profile")⇒ 这条路的生效前提是**这份代码已经在跑**。
 */
export const MEMORY_TOOL_CONFIG_KEY = 'memorySubagentTools'

/** 开关读数:`ECHO_MEMORY_SUBAGENT_TOOLS=1` 才算开,其它一切(含未设)都是关。 */
export function memoryToolsEnabledFromEnv (env) {
  return String((env || {})[MEMORY_TOOL_ENV] ?? '') === '1'
}

/** 配置读数:config / settings 里那一项**严格等于 `true`** 才算开。 */
export function memoryToolsEnabledFromConfig (config) {
  const c = config ?? {}
  if (typeof c !== 'object') return false
  return c[MEMORY_TOOL_CONFIG_KEY] === true
}

/**
 * 总读数:**环境变量 OR 配置(loader config / 插件 settings)**,任一为真即开;
 * 全缺 ⇒ 关(**与改动前逐位相同**)。`source` 只用于留痕(日志),不参与判定。
 */
export function memoryToolsEnabled ({ env, config, settings } = {}) {
  if (memoryToolsEnabledFromEnv(env)) return { on: true, source: 'env:' + MEMORY_TOOL_ENV }
  if (memoryToolsEnabledFromConfig(config)) return { on: true, source: 'loader-config:' + MEMORY_TOOL_CONFIG_KEY }
  if (memoryToolsEnabledFromConfig(settings)) return { on: true, source: 'settings:' + MEMORY_TOOL_CONFIG_KEY }
  return { on: false, source: 'off' }
}

/**
 * ★ 2026-10-01 阶段 2f:面板读数 —— 把「三路各是什么」与「总读数是什么」一次给全。
 *
 * 面板要能一眼答出**「为什么现在是开/关」**(他的原话:显示当前状态 + 来源),
 * 所以端点不能只回一个布尔。四个判据**全部**来自上面两个读数函数 ——
 * 这里一个判据都不重写(否则面板显示的和真跑的就成了两回事)。
 *
 * 入参形状与 `memoryToolsEnabled` 逐字相同,便于调用方一处取值、两处复用。
 * @param {{env?: object, config?: object, settings?: object}} [parts]
 * @returns {{on: boolean, source: string, env: boolean, config: boolean, settings: boolean}}
 */
export function memoryToolSourceReport ({ env, config, settings } = {}) {
  const verdict = memoryToolsEnabled({ env, config, settings })
  return {
    on: verdict.on,
    source: verdict.source,
    env: memoryToolsEnabledFromEnv(env),
    config: memoryToolsEnabledFromConfig(config),
    settings: memoryToolsEnabledFromConfig(settings)
  }
}

/**
 * 来源的**人话名字**(纯展示映射,不参与判定)。
 * 端点把它一并发给面板:"为什么现在是开"要能读成人话,而不是一个 `env:` 前缀。
 */
export function memoryToolSourceLabel (source) {
  const s = String(source ?? 'off')
  if (s.startsWith('env:')) return '环境变量 ' + MEMORY_TOOL_ENV
  if (s.startsWith('loader-config:')) return '宿主配置 cordis.patch.yml'
  if (s.startsWith('settings:')) return '插件设置 config.json(网页面板开关)'
  return '关(三路都没开)'
}

/**
 * 子代理那一轮的 `toolFilter`。
 * **关掉时必须与改动前逐位相同**:`{ allow: [] }`(见纪律 ①,单测钉住)。
 */
export function subagentToolFilter (enabled) {
  return { allow: enabled === true ? [...SUBAGENT_MEMORY_TOOL_NAMES] : [] }
}

/** 宿主对工具输出有"无损 JSON"校验:值为 undefined 的键会让整份回执判失败。 */
function lossless (obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined) out[k] = v
  return out
}

function clampInt (v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

function cut (s, n) {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n) + '…[裁到' + n + '字]' : t
}

/**
 * 只读 reader:把 store 的**只读读口**包成 4 个纯读函数。
 *
 * 只允许 `listMemories` / `memoriesByIds` / `graphData` 三个读口 —— 少了任何一个就当场
 * 抛(不静默降级)。**故意不碰** `store.retrieve`(会强化)与 `store.db`(可写句柄)。
 *
 * @param {object} store `lib/store.js` 的 openStore() 返回值
 */
export function createReadOnlyReader (store) {
  if (store === null || typeof store !== 'object') {
    throw new Error('memory-read-tools: store 缺席 —— 只读 reader 起不来')
  }
  for (const m of ['listMemories', 'memoriesByIds', 'graphData']) {
    if (typeof store[m] !== 'function') {
      throw new Error('memory-read-tools: store 少了只读读口 `' + m + '` —— 拒绝降级')
    }
  }

  /** 候选池 = 现役记忆(listMemories 的 `active` 档:is_active=1 且 status='active')。 */
  const candidates = () => store.listMemories({
    limit: MEMORY_TOOL_LIMITS.poolLimit, state: 'active', sort: 'recent'
  }).rows

  /** rankMemories 要的行形状(listMemories 的行差一个 augKeys;默认打分不用它)。 */
  const toScoringRow = (r) => ({
    memoryId: r.memoryId,
    summary: r.summary,
    keywords: r.keywords,
    emotionScore: r.emotionScore,
    intrinsicValue: r.intrinsicValue,
    halfLife: r.halfLife,
    recallCount: r.recallCount,
    lastRecalled: r.lastRecalled,
    layer: r.layer,
    timestamp: r.timestamp,
    occurredAt: r.occurredAt,
    learnedAt: r.learnedAt,
    temporalStatus: r.temporalStatus
  })

  return {
    /** 与线上**同一个**打分器(纯函数),但**不做**强化回写。 */
    search (query, limit) {
      const q = String(query ?? '').slice(0, 120)
      const rows = candidates()
      const ranked = rankMemories(rows.map(toScoringRow), q, limit, Date.now() / 1000,
        { dedupe: false }) // 枚举用途:折叠近重复会少报(与 memory_search 帧同一立场)
      return {
        pool: rows.length,
        hits: ranked.map((it) => ({
          memoryId: it.memoryId,
          summary: cut(it.summary, MEMORY_TOOL_LIMITS.summaryChars),
          cov: it.hits, // 覆盖率(连续值)
          total: it.total,
          matched: it.matched !== false, // false = 只是 L0 常在场,不是命中
          forced: it.forced === true, // true = L0 强制占位(不算"被想起")
          layer: it.layer,
          ageDays: Math.round((Number(it.ageDays) || 0) * 10) / 10
        }))
      }
    },

    get (memoryId, maxChars) {
      const row = store.memoriesByIds([memoryId])[0]
      if (row === undefined) return { found: false }
      return {
        found: true,
        memoryId: row.memoryId,
        summary: cut(row.summary, maxChars),
        keywords: row.keywords,
        layer: row.layer,
        timestamp: row.timestamp,
        occurredAt: row.occurredAt,
        temporalStatus: row.temporalStatus,
        halfLife: row.halfLife,
        recallCount: row.recallCount,
        // 只读读口不做 is_active 过滤(memoriesByIds 自述"被取代的旧行也是历史")
        // ⇒ 把状态透出来,让调用方能分清"现役 / 已遗忘 / 隔离".
        isActive: row.isActive === true,
        status: row.status,
        supersededBy: row.supersededBy
      }
    },

    /** 一跳邻域。⚠️ `nodeType` 给的是**面板口径**(见下),不是库里的 `node_type`。 */
    neighbors (node, depth, limit) {
      const g = store.graphData()
      const key = String(node ?? '')
      const seed = (g.nodes || []).find((n) => n.name === key || String(n.id) === key)
      if (seed === undefined) return { found: false }
      const out = []
      const speakers = speakerNodes()   // P1b:名单现读**一次**,循环里不再逐个读文件
      for (const e of g.edges || []) {
        if (e.isActive !== true) continue
        let other = null
        let direction = null
        if (String(e.source) === String(seed.id)) { other = e.target; direction = 'out' }
        else if (String(e.target) === String(seed.id)) { other = e.source; direction = 'in' }
        else continue
        const n = (g.nodes || []).find((x) => String(x.id) === String(other))
        if (n === undefined) continue
        out.push({
          nodeId: String(n.id), name: n.name,
          // ⚠️ 这个**不是** `graph_nodes.node_type`:`graphData()` 是**面板口径**,
          // 它会把说话人名与按关系命名的节点在内存里改写成 person/habit/preference/event
          // (`lib/store.js:1172-1181`),库里那一列仍是 concept。所以字段名不许叫 nodeType。
          displayType: n.type,
          relation: e.relation, weight: e.weight, direction,
          isSpeakerNode: speakers.includes(n.name)
        })
      }
      out.sort((a, b) => (b.weight - a.weight) || (a.name < b.name ? -1 : 1))
      return {
        found: true,
        node: seed.name,
        depth,
        // graphData() 的读口**不暴露 owner_key**(它是面板的读口)⇒ 邻域这一步
        // 没有归属过滤。单主人现实下无害,但**不许静默**:照实标 false。
        ownerFiltered: false,
        neighbors: out.slice(0, limit),
        totalNeighbors: out.length,
        truncated: out.length > limit
      }
    },

    timeline (days, limit) {
      const nowSec = Date.now() / 1000
      const from = nowSec - days * 86400
      const items = candidates()
        .filter((r) => Number(r.timestamp) >= from)
        .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0) ||
          (Number(b.memoryId) || 0) - (Number(a.memoryId) || 0))
      return {
        days,
        from: Math.floor(from),
        totalInWindow: items.length,
        items: items.slice(0, limit).map((r) => ({
          memoryId: r.memoryId,
          summary: cut(r.summary, MEMORY_TOOL_LIMITS.summaryChars),
          timestamp: r.timestamp,
          occurredAt: r.occurredAt,
          layer: r.layer
        })),
        truncated: items.length > limit
      }
    }
  }
}

/**
 * 把 reader 包成 4 个宿主工具定义(交给 `ctx.tools.register(defineTool(def))`)。
 *
 * 每个 execute 都:计时 → 夹上限 → 调 reader → 出错转 `{ok:false, reason}`(纪律 ③)。
 * `exec` 只用来取会话 id 做审计,**不写库**。
 */
export function memoryReadToolDefinitions (reader) {
  if (reader === null || typeof reader !== 'object') {
    throw new Error('memory-read-tools: reader 缺席 —— 工具定义起不来')
  }

  /** 统一外壳:计时 + 夹上限 + 错误归一(空结果与出错**必须**长得不一样)。 */
  const wrap = (name, fn) => async (args) => {
    const t0 = Date.now()
    try {
      const value = fn(args || {})
      const ms = Date.now() - t0
      return lossless({
        ok: true,
        toolMs: ms,
        overBudget: ms > MEMORY_TOOL_LIMITS.callTimeoutMs,
        ...value
      })
    } catch (err) {
      const msg = String((err && err.message) || err || 'unknown')
      return lossless({ ok: false, reason: name + '-failed: ' + msg, toolMs: Date.now() - t0 })
    }
  }

  return [
    {
      name: 'memory_search',
      description: '【只读】按一句话去查 Echo 的长期记忆,返回命中的记忆与覆盖率。'
        + '只读:查它**不会**强化任何记忆(不写库)。matched=false 表示这条只是常在场(L0),不是命中。',
      parameters: {
        query: { type: 'string', description: '查询词,比如「校园跑」', required: true },
        limit: { type: 'number', description: '最多几条,默认 ' + MEMORY_TOOL_LIMITS.searchDefault + ',硬顶 ' + MEMORY_TOOL_LIMITS.searchLimit }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' }, reason: { type: 'string' },
            toolMs: { type: 'number' }, overBudget: { type: 'boolean' },
            pool: { type: 'number' },
            hits: { type: 'array', items: { type: 'object', additionalProperties: true } }
          }
        },
        render: (args, value) => [{ type: 'text', text: value.ok
          ? ('查到 ' + String((value.hits || []).length) + ' 条(只读)')
          : ('查询失败:' + String(value.reason || '')) }]
      },
      execute: wrap('memory_search', (args) => {
        const q = String(args.query ?? '').trim().slice(0, 120)
        if (q.length < 2) return { hits: [], note: 'query-too-short' }
        const limit = clampInt(args.limit, 1, MEMORY_TOOL_LIMITS.searchLimit, MEMORY_TOOL_LIMITS.searchDefault)
        const r = reader.search(q, limit)
        return { ...r, note: r.hits.length === 0 ? 'no-hit' : undefined }
      })
    },
    {
      name: 'memory_get',
      description: '【只读】按 memoryId 取一条记忆的详情(摘要截断、带层/时间/是否现役)。只读,不写库。',
      parameters: {
        memoryId: { type: 'number', description: '记忆 id', required: true },
        maxChars: { type: 'number', description: '摘要最多多少字,默认 ' + MEMORY_TOOL_LIMITS.getDefault + ',硬顶 ' + MEMORY_TOOL_LIMITS.getChars }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' }, reason: { type: 'string' },
            found: { type: 'boolean' }, memoryId: { type: 'number' },
            summary: { type: 'string' }, layer: { type: 'string' }
          }
        },
        render: (args, value) => [{ type: 'text', text: value.ok
          ? (value.found === true ? '取到记忆 #' + String(value.memoryId) : '没有这条记忆')
          : ('读取失败:' + String(value.reason || '')) }]
      },
      execute: wrap('memory_get', (args) => {
        const id = Number(args.memoryId)
        if (!Number.isFinite(id) || id <= 0) return { found: false, note: 'bad-id' }
        const maxChars = clampInt(args.maxChars, 80, MEMORY_TOOL_LIMITS.getChars, MEMORY_TOOL_LIMITS.getDefault)
        const r = reader.get(Math.trunc(id), maxChars)
        return { ...r, note: r.found === true ? undefined : 'not-found' }
      })
    },
    {
      name: 'memory_neighbors',
      description: '【只读】查一个记忆节点的一跳邻居(关系/方向/权重)。depth 硬顶 ' + MEMORY_TOOL_LIMITS.depthMax
        + ' —— 多跳扩散不在这一版里。只读,不写库。',
      parameters: {
        node: { type: 'string', description: '节点名或 node id', required: true },
        depth: { type: 'number', description: '跳数,硬顶 ' + MEMORY_TOOL_LIMITS.depthMax },
        limit: { type: 'number', description: '最多几个邻居,默认 ' + MEMORY_TOOL_LIMITS.neighborsDefault + ',硬顶 ' + MEMORY_TOOL_LIMITS.neighborsLimit }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' }, reason: { type: 'string' },
            found: { type: 'boolean' }, node: { type: 'string' },
            neighbors: { type: 'array', items: { type: 'object', additionalProperties: true } }
          }
        },
        render: (args, value) => [{ type: 'text', text: value.ok
          ? (value.found === true ? ('「' + String(value.node) + '」有 ' + String((value.neighbors || []).length) + ' 个邻居(只读)') : '没有这个节点')
          : ('查询失败:' + String(value.reason || '')) }]
      },
      execute: wrap('memory_neighbors', (args) => {
        const node = String(args.node ?? '').trim().slice(0, 64)
        if (node.length < 1) return { found: false, note: 'bad-node' }
        const depth = clampInt(args.depth, 1, MEMORY_TOOL_LIMITS.depthMax, 1)
        const limit = clampInt(args.limit, 1, MEMORY_TOOL_LIMITS.neighborsLimit, MEMORY_TOOL_LIMITS.neighborsDefault)
        const r = reader.neighbors(node, depth, limit)
        return { ...r, note: r.found === true ? undefined : 'node-not-found' }
      })
    },
    {
      name: 'memory_timeline',
      description: '【只读】取最近 N 天里的记忆(倒序,摘要截断)。只读,不写库。',
      parameters: {
        days: { type: 'number', description: '往回几天,默认 ' + MEMORY_TOOL_LIMITS.daysDefault + ',硬顶 ' + MEMORY_TOOL_LIMITS.daysMax },
        limit: { type: 'number', description: '最多几条,默认 ' + MEMORY_TOOL_LIMITS.timelineDefault + ',硬顶 ' + MEMORY_TOOL_LIMITS.timelineLimit }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' }, reason: { type: 'string' },
            days: { type: 'number' }, totalInWindow: { type: 'number' },
            items: { type: 'array', items: { type: 'object', additionalProperties: true } }
          }
        },
        render: (args, value) => [{ type: 'text', text: value.ok
          ? ('窗口内 ' + String(value.totalInWindow || 0) + ' 条,取了 ' + String((value.items || []).length) + ' 条(只读)')
          : ('查询失败:' + String(value.reason || '')) }]
      },
      execute: wrap('memory_timeline', (args) => {
        const days = clampInt(args.days, 1, MEMORY_TOOL_LIMITS.daysMax, MEMORY_TOOL_LIMITS.daysDefault)
        const limit = clampInt(args.limit, 1, MEMORY_TOOL_LIMITS.timelineLimit, MEMORY_TOOL_LIMITS.timelineDefault)
        const r = reader.timeline(days, limit)
        return { ...r, note: r.items.length === 0 ? 'no-hit' : undefined }
      })
    }
  ]
}
