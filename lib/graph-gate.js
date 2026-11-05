/**
 * dsh-echo — 运行时自动挖边的开关(阶段 4,2026-10-01)
 * ============================================================
 * 他拨的那个开关:**「每写一条新记忆就自动挖影子边」**。
 * 在这之前它只有一个入口 —— 环境变量 `ECHO_GRAPH_GATE`,而 `process.env` 在宿主
 * 进程启动时就固定了 ⇒ **改它必须重启宿主**。于是本次照 2f 的范式补一条**面板路**:
 * 拨一下落盘,引擎**下一帧**就认(不用重启、不用热重载)。
 *
 * 判定**只有这一处**(`graphGateEnabled`),三路 OR,与 `memory-read-tools.js` 的
 * `memoryToolsEnabled` 逐字同形:
 *   ① **环境变量** `ECHO_GRAPH_GATE`(优先;但它要重启宿主才改得动);
 *   ② **loader 配置** `graphShadowEdges`(`$DSH_HOME/profiles/web/cordis.patch.yml`
 *      给 `id: echo` 那行加 `config:`)—— `apply()` 时会被**同步写进③那份文件**
 *      (见 `lib/index.js` 的 4b3 段):引擎读不到宿主配置文件,所以要让"三路 OR"
 *      在引擎侧也成立,这一路必须落成文件 —— 否则面板显示"开"而引擎那边是关的,
 *      就成了"显示的和真跑的两回事"(2f 明令禁止的那种);
 *   ③ **插件设置(网页面板)** `$DSH_HOME/echo/config.json` 顶层 `graphShadowEdges`
 *      —— **引擎每帧现读这个文件**,这就是"拨了立即生效"的全部机制。
 *
 * ★ 引擎侧镜像:同一个键名与同一个文件路径在
 * `python/engine/graph_gate.py`(`SWITCH_CONFIG_KEY` / `switch_config_path()`)里
 * 有一份**镜像常量 + 同一个推法**;两侧的字符串与路径各由单测钉住(两边必须同字)。
 *
 * 本模块**零宿主依赖**(纯函数 + 一个字符串常量),可离线单测。
 */

/** 开关的环境变量名(**与 `python/engine/graph_gate.py` 的 `SWITCH_ENV` 同字**)。 */
export const GRAPH_GATE_ENV = 'ECHO_GRAPH_GATE'

/**
 * 开关的**配置键名**(默认关)。
 *
 * 与 `memorySubagentTools` 的命名风格一致:名字说的是"它开了以后会做什么"
 * (`graphShadowEdges` = 影子边),而不是泛泛的 `enableGraph`。
 * 三处必须同一个字符串:本文件(壳侧单一出处)、`lib/toggle.js`(读写)、
 * `python/engine/graph_gate.py` 的 `SWITCH_CONFIG_KEY`(引擎侧镜像)。
 */
export const GRAPH_GATE_CONFIG_KEY = 'graphShadowEdges'

/**
 * 环境变量读数。真值口径**与引擎侧 `graph_gate._truthy` 逐字相同**:
 * `1` / `true` / `on` / `yes`(大小写无关、两端空白不算),其它一切(含未设)都是关。
 *
 * 为什么这里比隔壁 `memoryToolsEnabledFromEnv`(只认 `'1'`)宽:那个开关的消费者是
 * **壳自己**,这个开关的消费者是 **Python 引擎** —— 口径必须跟引擎一致,否则
 * `ECHO_GRAPH_GATE=true` 会出现"面板显示关、引擎却在挖边"这种最坏的两回事。
 * (引擎那边是阶段 1b 就定下的口径,本开关只做跟随。)
 */
export function graphGateEnabledFromEnv (env) {
  const raw = (env || {})[GRAPH_GATE_ENV]
  if (raw === undefined || raw === null) return false
  return ['1', 'true', 'on', 'yes'].includes(String(raw).trim().toLowerCase())
}

/** 配置读数:config / settings 里那一项**严格等于 `true`** 才算开。 */
export function graphGateEnabledFromConfig (config) {
  const c = config ?? {}
  if (typeof c !== 'object') return false
  return c[GRAPH_GATE_CONFIG_KEY] === true
}

/**
 * 总读数:**环境变量 OR 配置(loader config / 插件设置)**,任一为真即开;
 * 全缺 ⇒ 关(**与改动前逐位相同**)。`source` 只用于留痕(日志 / 面板),不参与判定。
 *
 * ⚠️ 环境变量那一路必须**先判**:`=1` 不许被配置层顶掉(纪律:env 仍然优先)。
 */
export function graphGateEnabled ({ env, config, settings } = {}) {
  if (graphGateEnabledFromEnv(env)) return { on: true, source: 'env:' + GRAPH_GATE_ENV }
  if (graphGateEnabledFromConfig(config)) return { on: true, source: 'loader-config:' + GRAPH_GATE_CONFIG_KEY }
  if (graphGateEnabledFromConfig(settings)) return { on: true, source: 'settings:' + GRAPH_GATE_CONFIG_KEY }
  return { on: false, source: 'off' }
}

/**
 * 面板读数:把「三路各是什么」与「总读数是什么」一次给全(判据不重写一份)。
 * 入参形状与 `graphGateEnabled` 逐字相同。
 * @returns {{on: boolean, source: string, env: boolean, config: boolean, settings: boolean}}
 */
export function graphGateSourceReport ({ env, config, settings } = {}) {
  const verdict = graphGateEnabled({ env, config, settings })
  return {
    on: verdict.on,
    source: verdict.source,
    env: graphGateEnabledFromEnv(env),
    config: graphGateEnabledFromConfig(config),
    settings: graphGateEnabledFromConfig(settings)
  }
}

/** 来源的人话名字(纯展示映射,不参与判定)。 */
export function graphGateSourceLabel (source) {
  const s = String(source || '')
  if (s === 'off') return '关(三路都没开)'
  if (s.startsWith('env:')) return '环境变量 ' + GRAPH_GATE_ENV + '(要改它得重启宿主)'
  if (s.startsWith('loader-config:')) return '宿主配置 ' + GRAPH_GATE_CONFIG_KEY + '(cordis.patch.yml)'
  if (s.startsWith('settings:')) return '插件设置(网页面板的开关)'
  return s
}

/** 拨动者的人话名字(纯展示映射,不参与判定)。 */
export function flipByLabel (by) {
  const b = String(by || '')
  if (b === 'panel') return '网页面板'
  if (b === 'loader-config') return '宿主配置同步(cordis.patch.yml 里写了 true)'
  if (b === 'tool') return '工具调用'
  if (b === 'marker') return '标记短语'
  if (b === 'api') return '接口'
  return '(没记来源)'
}

/**
 * 来源标记的人话(「谁在什么时候拨的」)—— 面板两个开关共用一份格式化。
 *
 * ★ 2026-10-01 尾新加:起因是一次"谁都说不清是谁把开关拨开的"事故(见
 * `lib/toggle.js` 上方那段)。标记缺失(老配置)如实显示**没记来源**,不猜。
 * @param {{by?: string, at?: number}} flip
 * @returns {string} 例如 `网页面板 · 10-01 21:33`
 */
export function flipProvenanceLabel (flip) {
  const by = String(flip?.by ?? '')
  const at = Number(flip?.at) || 0
  if (by === '' && at === 0) return '(没记来源 —— 这文件是在加标记之前写的)'
  const d = new Date(at * 1000)
  const p = (n) => String(n).padStart(2, '0')
  const when = at === 0 ? '时间没记'
    : p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  return flipByLabel(by) + ' · ' + when
}
