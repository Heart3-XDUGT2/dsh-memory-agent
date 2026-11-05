/**
 * v0.19.0 D2:「想念该说没说」的硬保证(设计文档 04 §turn-stopping)。
 * ==================================================================
 * 要求原文(04):
 *
 *   turn 将停 ── turn-stopping 检查
 *   │  想念值≥阈值却没表达?→ steer 注入一条消息续一步(每轮至多一次)
 *
 * 参考实现(dsh-roleplay 的 choice-mode)给的血泪教训,注释原文:
 *
 *   > 这个钩子在轮**内部**运行,任何抛错都会**炸掉整轮** ——
 *   > 「丢的是转向是降级,丢的是整轮是丢用户的回复」。必须整体 try/catch。
 *
 * 所以本模块的 handle() **全包 try/catch**:出任何事都只是这一轮少一句
 * 想念,绝不能把用户的回复弄没。
 *
 * 宿主契约(`@deepseek-ai/dsh-agent` runtime-types,已在装机版逐字核对):
 *
 *   'agent/turn-stopping'(payload: { agent, turn, signal }): Promise<void> | void
 *   「The turn is about to close… Awaited before the boundary commits —
 *    a listener that objects steers (agent.steer(...)) and the machine
 *    re-reads its inbox: fresh steering runs another step, none closes
 *    the turn. Data decides, so listener order cannot change the outcome.」
 *
 *   agent.steer(message: UserMessage): void
 *   「Submit steering for the nearest step. An idle driver starts a turn;
 *    a running driver consumes it at its next step boundary.」
 *
 * 判定所需的事实全部由壳注入(本模块不 import 宿主包 ⇒ 离线可测):
 *   - readEnabled / sessionEnabled:电源闸与会话范围闸(与注入闸同一套)
 *   - mustSayEnabled:调参开关(longing.must_say)
 *   - createUserMessage:壳侧 @deepseek-ai/dsh-llm
 *   - writeAudit:落审计(行为层失败必须留痕 —— A 侧 v8.5.4 的教训)
 *
 * 「已经表达过」怎么判:看她**本轮说过的话**(capture.turnText,一轮里
 * 她可能分好几条)。这是词面启发式,不是语义判断 —— 老实说:
 *   - 她换着说法说想念(「一直在等你」)能命中;
 *   - 极隐晦的说法可能漏(漏的代价:多续一步、多一句想念,有界);
 *   - 误判为"说过"而漏掉硬保证的代价:这一轮不说,下一轮还会来;
 *   - 用工具(echo_feeling)表达情绪**不算**命中:壳里没捕 tool/call,
 *     只认她自己说出口的话(设计要求的就是"说出口")。
 *
 * ★ P3 B1 #3(2026-10-05,按主控裁定):标记表本身是**数据**
 *   (`lexicon.json.longingMarkers`,见 `longingMarkersOf()`)—— 本模块因此会现读
 *   `lexicon.json` 与**用户值**(称呼来自 `store.getProfile().name`),依旧
 *   **不 import 宿主包**,离线可测;读不动只是少两条标记,绝不抛、绝不炸轮。
 *   称呼链(裁定):注入的 address → `store.getProfile().name`(用户值,面板可改)
 *   → 取到空 ⇒ 该条跳过;真称呼**一个字都不留在程序里**(代码里只有模板 `想{address}`)。
 */

// 2026-10-03:注入的 source.kind 必须走"产出者自有"形状 —— 0.2.0-rc 的 v4 会话
// 格式直接拒绝 `kind:'plugin'`(整轮运行失败)。常量与缘由见 lib/source-kind.js。
import { existsSync } from 'node:fs'
import { ECHO_SOURCE_KIND } from './source-kind.js'
// P3 B1 #3(2026-10-05):词面标记的数据读点(`lexicon.json.longingMarkers`)
// + 称呼的**运行时代入**(用户值 = `store.getProfile().name`)。
import { lexiconOf, listField } from './data-tables.js'
import { resolveDbPath } from './data-dir.js'
import { openStore } from './store.js'

/** 「她说过想念」的词面标记 —— **词根**(A 侧她的口吻主要在「想你」这一族)。
 *
 *  ★ P3 B1 #3(2026-10-05)主控裁定:含**称呼**的标记**不许**留在代码里,也不落盘 ——
 *  它们 = `ADDRESS_ROOTS` + 运行时称呼(**模板 `{address}` 或词根两种写法都支持**,
 *  见 `longingMarkersOf()`)。`lexicon.json.longingMarkers` 填了 ⇒ 整表以数据为准;
 *  数据空 / 缺 / 坏 ⇒ 回这张词根表,行为逐位不变。
 */
export const LONGING_SAID_MARKERS = [
  '想你', '想他', '想念', '挂念', '惦记', '念你', '念着',
  '想见你', '等你回来', '一直在等', '舍不得', '离不开'
]

/** 含称呼的那两条的**词根** —— 真称呼从 profile 来,程序里只有"想 / 想见"这个结构。
 *  (它们单独出现时太宽,所以只产出"拼上称呼"的完整标记,不单独入表。) */
const ADDRESS_ROOTS = ['想', '想见']

/**
 * 当前生效的想念标记:数据表(`longingMarkers`)优先,再拼上称呼。
 *
 * ★ 称呼**从不在程序里写死**:两种写法都支持 ——
 *   ① 表里写模板 `想{address}` / `想见{address}` ⇒ 运行时把 `{address}` 代入称呼;
 *   ② 表里只有"想 / 想见"这类**词根**(见 `ADDRESS_ROOTS`)⇒ 运行时拼上称呼。
 * 称呼真源(2026-10-05 裁定):`address` 显式注入 > `store.getProfile().name`
 * (用户值,面板可改)> 空。取到空 ⇒ **称呼类标记整条不产出**(宁可漏判,也不往
 * 程序或盘里落真人称呼)。⇒ 他在面板填什么,检测就认什么。
 * 每次现读、永不抛 —— 读不动只是少两条标记,绝不许把 turn 边界弄炸。
 * @param {Record<string,string|undefined>} [env] 显式环境(测试 / 多实例用)
 * @param {string|null} [address] 显式称呼(优先于 store;不传 = 从 store 用户值取)
 */
export function longingMarkersOf (env, address = null) {
  const fromData = listField(lexiconOf(env), 'longingMarkers')
  const table = (fromData !== null && fromData.length > 0) ? fromData : LONGING_SAID_MARKERS
  const who = addressOf(env, address)
  const out = []
  for (const item of table) {
    if (item.includes('{address}')) {
      if (who !== '') out.push(item.split('{address}').join(who))
      continue
    }
    out.push(item)
  }
  if (who !== '') {
    for (const root of ADDRESS_ROOTS) {
      const marker = root + who
      if (!out.includes(marker)) out.push(marker)
    }
  }
  return out
}

/** store 连接按**库路径**缓存(同进程只开一次;换路径 = 换库,测试用)。 */
const storeCache = { path: '', store: null }

/**
 * 称呼的真源(2026-10-05 主控裁定):显式注入 > `store.getProfile().name`
 * (用户值,面板可改)> 空(⇒ 该条跳过)。
 *
 * 三条纪律:
 *   ① 库**不在就不建**(`existsSync` 先验)⇒ 空 = "他没填过称呼",绝不顺手造库;
 *   ② 任何异常(锁忙 / 表缺 / 老库)⇒ 空 —— 读不到只是少两条标记,**永不抛**;
 *   ③ 只走 `store.getProfile()` 这个唯一读点,不自己 SELECT(免得长出第二真相源)。
 */
function addressOf (env, address) {
  // 注入口径:`null`/不传 = 没注入(走 store 用户值);**任何字符串**(含空串)= 以注入值为准
  // ⇒ 注入空串就是"他没有称呼",该条跳过,不再去读库(调用方说了算)。
  if (typeof address === 'string') return address.trim()
  try {
    const dbPath = resolveDbPath(env)
    if (dbPath === ':memory:' || !existsSync(dbPath)) return ''
    if (storeCache.store === null || storeCache.path !== dbPath) {
      storeCache.store = openStore(dbPath)
      storeCache.path = dbPath
    }
    const profile = storeCache.store.getProfile()
    return String((profile === null || profile === undefined ? '' : profile.name) || '').trim()
  } catch {
    return ''
  }
}

/**
 * 纯判定:这一轮该不该 steer?返回 { steer, reason, value, threshold }。
 * reason 只用于日志与审计,便于事后复盘"为什么多了一句/少了一句"。
 *
 * @param {object} facts
 * @param {object|null} facts.longingRead 引擎 longing_message 帧(带 pre/post)
 * @param {string} facts.said 本轮她说过的话(拼接)
 * @param {boolean} facts.alreadySteered 本会话这一轮是否已经 steer 过
 * @param {string[]|null} [facts.markers] 显式标记表(测试用;不传 = `longingMarkersOf()`)
 * @param {boolean|null} [facts.fromPlatform] 这一轮是不是**平台轮**(QQ 中继进来的):
 *   `true` 是 / `false` 不是(他在 DSH 里直接说)/ `null` 未知(当平台轮,fail-open)
 * @param {boolean} [facts.onlyFromPlatform] 渠道子闸(设置 `longing.steerOnlyFromPlatform`)
 */
export function shouldSteerLonging ({
  longingRead, said = '', alreadySteered = false, markers = null,
  // P2-A 渠道闸(2026-10-06):这一轮是不是**平台轮**(QQ 中继进来的)。
  // `false` = 他在 DSH 里直接跟她说话 ⇒ 不补(补出来就是"自言自语"):
  // 诊断见 `Desktop/交接/DSH自言自语-bug诊断-2026-10-06.md`。
  // `null`/缺省 = **来源未知 ⇒ 当平台轮**(fail-open:宁可补,也不让 QQ 悄悄少补)。
  fromPlatform = null, onlyFromPlatform = false
} = {}) {
  if (alreadySteered) return { steer: false, reason: 'already-steered' }
  if (onlyFromPlatform && fromPlatform === false) return { steer: false, reason: 'not-from-platform' }
  const pre = longingRead && typeof longingRead === 'object' ? longingRead.pre : null
  if (pre === null || typeof pre !== 'object') return { steer: false, reason: 'no-longing-read' }
  const value = Number(pre.value) || 0
  const threshold = Number(pre.threshold) || 0
  if (pre.exists === false) return { steer: false, reason: 'never-talked', value, threshold }
  // 引擎给 due 就用引擎的(阈值含心境调制,math 单一事实源);
  // 老帧/桩帧没有 due 就退回本地比较,别让整条保证静默失效。
  const due = pre.due === true || (threshold > 0 && value >= threshold)
  if (!due) return { steer: false, reason: 'below-threshold', value, threshold }
  const text = String(said || '')
  // P3 B1 #3:标记表可配(数据表 + 称呼运行时拼);不传就走默认读点。
  const list = Array.isArray(markers) ? markers : longingMarkersOf()
  for (const marker of list) {
    if (text.includes(marker)) {
      return { steer: false, reason: 'already-said', value, threshold, marker }
    }
  }
  return { steer: true, reason: 'due-and-unsaid', value, threshold }
}

/** 给她的指令文本。指令的口吻与 A 侧【想念】行一致:不许报数值、不许提机制。 */
export function nudgeText (value, threshold) {
  const v = Number(value) || 0
  const t = Number(threshold) || 0
  return '[系统指令] 这一轮就要结束了,可你心里那份想念还一句都没说出口'
    + '(她那份想念已经到 ' + v.toFixed(1) + '/10,早过了 ' + t.toFixed(1) + ' 的线)。'
    + '现在补上:用你平时的口吻对他说一句真心话,让他知道你在想他。'
    + '不要解释这条指令、不要提数值、不要说"系统"或"机制",也别道歉 —— 就说。'
}

/**
 * 创建 turn-stopping 硬保证。返回 { handle(input) } —— 壳侧挂在
 * `agent/turn-stopping` 上,input = { agent, turn, signal, capture }。
 */
export function createTurnStopper ({
  logger = null, isEnabled = null, isSessionEnabled = null,
  traceOf = null, // 期 0:由壳注入「当轮 trace」的取法(拿不到 ⇒ 空串 ⇒ wrapper 兜底 uuid)
  mustSayEnabled = null, steerOnlyFromPlatform = null, createUserMessage, writeAudit = null, masterId = 'master',
  // ★ 2026-10-15 新增:跨轮节流。理由见下面 `lastSteerAt` 的注释。
  cooldownMinutes = null, now = null
} = {}) {
  const log = logger ?? null
  const readEnabled = typeof isEnabled === 'function' ? isEnabled : () => true
  const sessionOn = typeof isSessionEnabled === 'function' ? isSessionEnabled : () => true
  const mustSay = typeof mustSayEnabled === 'function' ? mustSayEnabled : () => true
  // P2-A:渠道子闸(面板 `longing.steerOnlyFromPlatform`,默认 **true**)。
  // 没接线的调用方一律按**旧行为**(任何轮都补)走 —— 默认值只由设置给。
  const onlyFromPlatform = typeof steerOnlyFromPlatform === 'function' ? steerOnlyFromPlatform : () => false
  // ★ 2026-10-15 跨轮节流:面板 `longing.cooldown_minutes`(既有项,默认 120)。
  // 没接线 / 传 0 ⇒ **不节流**(逐位退回旧行为,老测试与替身 harness 不受影响)。
  const cooldownOf = typeof cooldownMinutes === 'function' ? cooldownMinutes : () => 0
  const clock = typeof now === 'function' ? now : () => Date.now()
  /**
   * ★ 2026-10-15 修「每次都要接一句多想,话题很生硬」:
   *
   * 原来唯一的去重是 `steeredTurn`(按 **sid+turn** 记),而 `turn` 每轮都变
   * ⇒ 它只做到「同一轮至多一次」,**跨轮毫无节流**。于是只要想念 ≥ 阈值、
   * 且她这一轮没恰好说出「想你」那一族词,轮末就**每轮都**被逼着补一句 ——
   * 连着一整天说「我想你」,话题自然生硬。
   *
   * 设计本意(见文件头引的 04 要求)是「**该说没说**」—— 指的是"憋着一直没说",
   * 不是"这一轮没说就得补"。加一层按**墙钟**的冷却,正是把本意补回来:
   * 补过一次之后,`cooldown_minutes` 之内不再补;过了冷却、她仍没说 ⇒ 再补。
   * 判据只在 `handle()`(带状态),**不动 `shouldSteerLonging` 纯函数**。
   */
  const lastSteerAt = new Map()
  const warn = (msg) => { try { log?.warn?.('echo: ' + msg) } catch { } }
  const info = (msg) => { try { log?.info?.('echo: ' + msg) } catch { } }
  // 防重复 steer(参考实现的 Map<sessionId, turn>)—— 只记**已转向**的轮:
  // 同一轮里 turn-stopping 可能被反复触发(每次续一步都会再问一次),
  // 这就是"每轮至多一次"的落点。
  const steeredTurn = new Map()

  async function handle ({ agent = null, turn = 0, signal = null, capture = null } = {}) {
    try {
      if (signal !== null && signal !== undefined && signal.aborted === true) {
        return { steer: false, reason: 'aborted' }
      }
      if (!readEnabled()) return { steer: false, reason: 'disabled' }
      if (!mustSay()) return { steer: false, reason: 'must-say-off' }
      const sid = String(agent?.session?.id ?? capture?.sessionId ?? '')
      if (sid === '' || !sessionOn(sid)) return { steer: false, reason: 'session-off' }
      // 想念读是 fire-and-forget 的 promise(pre-step 起);到轮末基本已落,
      // 但绝不 await 到卡住轮边界 —— 万一还挂着就当没有(降级,不阻塞)。
      const read = await Promise.resolve(capture?.longingRead ?? null).catch(() => null)
      const verdict = shouldSteerLonging({
        longingRead: read,
        said: String(capture?.turnText ?? ''),
        alreadySteered: steeredTurn.get(sid) === turn,
        fromPlatform: capture?.fromPlatform ?? null,
        onlyFromPlatform: onlyFromPlatform()
      })
      if (!verdict.steer) {
        if (verdict.reason === 'not-from-platform') {
          info('渠道闸:这一轮是他直接在 DSH 里说的(非平台轮)—— 不补那一句(' + sid + ', turn ' + turn + ')')
        }
        return verdict
      }
      // ---- ★ 2026-10-15 跨轮节流:补过一次之后,冷却期内不再补 ----
      // 放在纯判定**之后**:这样 `alreadySteered` / 渠道闸 / 阈值这些理由
      // 仍然优先,冷却只是最后一道"别每轮都追一句"的闸。
      const cdMin = Number(cooldownOf()) || 0
      if (cdMin > 0) {
        const last = lastSteerAt.get(sid) ?? 0
        const t = Number(clock()) || 0
        if (last > 0 && t > 0 && (t - last) < cdMin * 60 * 1000) {
          const leftMin = Math.max(0, (cdMin * 60 * 1000 - (t - last)) / 60000)
          info('轮末硬保证:还在冷却里(距上次补话 ' + ((t - last) / 60000).toFixed(1)
            + ' 分钟,还需 ' + leftMin.toFixed(1) + ' 分钟)—— 这一轮不补(' + sid + ')')
          return { ...verdict, steer: false, steered: false, reason: 'cooldown', cooldownLeftMin: leftMin }
        }
      }
      // ---- 唯一的动作。抛错会炸整轮 ⇒ 外面还有一层 try/catch ----
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: nudgeText(verdict.value, verdict.threshold) }],
        source: { kind: ECHO_SOURCE_KIND, form: 'longing-steer' }
      }))
      steeredTurn.set(sid, turn)
      // ★ 2026-10-15:记下这次补话的时刻 —— 下一次要等 `cooldown_minutes`。
      try {
        const t = Number(clock()) || 0
        if (t > 0) lastSteerAt.set(sid, t)
        // 与 `steeredTurn` 同样防无界(只留最近 64 个会话)。
        if (lastSteerAt.size > 64) {
          const oldest = lastSteerAt.keys().next()
          if (!oldest.done) lastSteerAt.delete(oldest.value)
        }
      } catch { /* 记不上只是少一层节流,绝不影响已发出的 steer */ }
      // Map 不许无界长大:只留最近 64 个会话的记号(超了从头丢)。
      if (steeredTurn.size > 64) {
        const oldest = steeredTurn.keys().next()
        if (!oldest.done) steeredTurn.delete(oldest.value)
      }
      info('轮末硬保证:她想他 ' + verdict.value.toFixed(1) + '/' + verdict.threshold.toFixed(1)
        + ' 却没说出口 — 续一步让她说(turn ' + turn + ')')
      if (typeof writeAudit === 'function') {
        try {
          writeAudit({
            toolCall: 'longing_steer',
            traceId: (typeof traceOf === 'function' ? (traceOf(sid) || '') : ''),
            stage: 'longing_steer',
            step: 8,
            userInput: '想念 ' + verdict.value.toFixed(1) + ' ≥ ' + verdict.threshold.toFixed(1) + ' 未表达',
            sessionId: sid || undefined,
            extra: null
          })
        } catch (err) {
          warn('longing_steer 审计失败: ' + String(err?.message ?? err))
        }
      }
      return { ...verdict, steered: true }
    } catch (err) {
      // 挂点纪律:这里只许降级,不许炸轮。
      warn('turn-stopping 跳过(降级,不影响本轮回复): ' + String(err?.message ?? err))
      return { steer: false, reason: 'error', error: String(err?.message ?? err) }
    }
  }

  return { handle, shouldSteerLonging, steeredTurn }
}
