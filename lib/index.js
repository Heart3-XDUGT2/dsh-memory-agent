import { createArmAudit } from './audit-io.js'
import { settingsUIManifest, publicSettings, panelSettingsPatch, settingsRevision } from './settings-ui.js'
/**
 * dsh-echo — Echo:DeepSeek Harness 的陪伴人格与记忆插件(宿主半区)
 * ============================================================
 * M0(骨架 + 人格面板):她不再是一条独立的 QQ 机器人,而是给 DSH
 * 装上灵魂 —— 原生 agent loop(文件/shell/联网/子代理)全部保留,
 * 她带着 Echo 的身份、铁律与说话方式来用它:会写代码的陪伴 agent。
 *
 * 本半区五件事:
 *   1. 人格注入:echo:persona(身份,前段,order 10245)+ echo:rules(铁律+说话
 *      方式,尾段=末位最强提醒位)。文本是每轮组装时从内存缓存现读
 *      的 —— 面板改完下一轮生效,不用重载插件。
 *   2. 记忆注入(M2-d):agent/pre-step 消息注入 —— 每轮检索情景记忆
 *      (Python 引擎优先,JS 基线兜底)+ 她的心情状态,渲染成带来源的
 *      user-role 快照,追加在本步注入批末尾(贴近最新消息,遵从度最高;
 *      人设段字节级稳定,前缀缓存不受损)。
 *   3. 轮后反思(M2-d):session/event 流捕获本轮对话,turn/end 后走
 *      引擎门面 —— Python 路径 extract_prompt/extract_commit 帧(三层
 *      校验在引擎),基线路径 M1 冻结 EXTRACT。
 *   4. webServer 路由:GET/POST /api/echo/persona(面板读写)、
 *      GET /api/echo/status(仪表盘)、GET /api/echo/profile(P1d:称呼链的
 *      唯一出口 —— 面板拼人称/昵称正则只问它,不读数据文件)。POST 校验回环 Origin + 自定义
 *      头(afaccess A5 先例);body 上限 64KB(A10 先例)。
 *   5. echo_status 工具:会话内诊断(afaccess_status 先例)。
 *
 * 数据目录:~/.dsh/echo/(persona.json + echo.db 记忆库)。
 * 记忆层整体 fail-soft:库打不开/服务缺失只降级记忆功能,人格永不陪葬。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DATA_DIR, PERSONA_PATH, DEFAULT_PERSONA, PERSONA_MAX_CHARS,
  loadPersona, savePersona
} from './persona.js'
// P1a(数据与程序分离):路径真源 + 数据目录脚手架(建目录 + 补 8 个空模板 + 写记账)。
// `DATA_DIR`(来自 persona.js)与这里的 `resolveDataDir()` 现在是同一个出处 ——
// 人格 / 开关 / 记忆库三条路径不再各写各的(见 lib/data-dir.js 文件头)。
import { ensureDataDir, describeEnsureResult, resolveDataDir, resolveDbPath } from './data-dir.js'
// P3:一次性迁移的执行器(门 + 记账 + 幂等)。挂在 boot 链上跑,见下面 1240 一带。
import { migrateDataDir } from './data-migrate.js'
// P1d:profile.json 的唯一读点(面板的称呼链走 GET /api/echo/profile)
import { publicProfile } from './profile.js'
// P2 §6:配置中心的**唯一写路径**(校验→备份→原子写→失效缓存)与配置体检。
// 端点只做"写保护 + 白名单 + 状态码映射",落盘时序全在 lib/data-write.js 里。
import { handleDataRequest, registerCacheInvalidator, setupStatus } from './data-write.js'
import { describeMood, renderUnionBlock, sectionCounts } from './context.js'
// 第三批(2026-10-05)情绪空间融合:声明层 + 桥接层 + IPC 适配器 + Echo↔IPC 字典。
// 全部 fail-soft:IPC 副本缺失 / 桥接算不动 ⇒ 只是"这段读数没有",主对话不受影响。
import { SPACE_ID, EQUIVALENCE_NOTE, echoVectorToBipolar, padBipolarFromVector } from './emotion-space.js'
import { createSpaceBridge, gateOf, directionOf } from './space-bridge.js'
import { createIpcAdapter } from './ipc-adapter.js'
import { echoToIpc } from './emotion-ipc-bridge.js'
// 2026-10-01 尾:归档闸要读宿主的 `storages/workspace.json` —— 路径由上面已经
// 导进来的 `DATA_DIR`(`$DSH_HOME/echo`)上一级推出,见 `archivedSessionIds()`。
import { createTurnSnapshot, escapePromptBraces } from './turn-snapshot.js'
// RT9:检索账本(环形缓冲,面板读 stats())
import { createRetrieveLedger } from './retrieve-ledger.js'
import { clearOutcome, contextClearToolDefinition } from './context-clear.js'
import { powerToolDefinitions } from './power-tools.js'
import { isHumanUtterance } from './inbound-filter.js'
// 2026-10-03:注入消息的 `source.kind` 必须写"产出者自有"形状 —— 0.2.0-rc 的 v4
// 会话格式**直接拒绝** `kind:'plugin'`(整轮运行失败)。常量与红线兼容视图都在
// `lib/source-kind.js` 一处,别在各注入点手抄字面量。
import { ECHO_SOURCE_KIND, isEchoSource, legacySourceView } from './source-kind.js'
import { collectImages, describeImages, saveImageBlocks, inboundContent, isStickerImage } from './eyes.js'
import { hasRelayContent, relayFactText } from './relay-content.js'
import { prepareForwardImages } from './relay-image-content.js'
import { createForwardReader } from './forward-read.js'
import { createFileReader } from './qq-file-read.js'
import { createFileService } from './qq-file-service.js'
import { createReceiptPresence } from './qq-receipt-presence.js'
import { createQQFileSender } from './qq-send-file.js'
import { createQQSendArtifacts } from './qq-send-artifacts.js'
import { createQQSendAudit } from './qq-send-audit.js'
import { startParallelArms } from './parallel-arms.js'
import { readEnabled, setEnabled, readPower, readScope, setScope, setSessionOn, sessionEnabled, isManuallyOff, parseSessionMarker, looksLikePowerTalk, sessionLabel, setSessionLabel, readSessionLabels, readSettings, writeSettings, SETTINGS_DEFAULTS, readInterests, readAliases, readMemoryTools, setMemoryTools, readMemoryToolSetting, readGraphShadowEdges, setGraphShadowEdges, readGraphShadowEdgeSetting, readMemoryToolsFlip, readGraphShadowEdgesFlip, rememberSubagentSession, readSubagentSessions, backfillSubagentSessions } from './toggle.js'
import { openStore, MASTER_ID, PROACTIVE_ROUND_MARKER } from './store.js'
// 阶段 2 形态 (b):子代理通道的 4 个只读记忆工具(默认关;见 lib/memory-read-tools.js 文件头)
// 阶段 2f:上面两个新导出是**网页面板**要的读数(来源报表 / 来源人话名)——
// 判据仍只有 memoryToolsEnabled 一处。
import {
  createReadOnlyReader, memoryReadToolDefinitions,
  memoryToolsEnabled, memoryToolSourceReport, memoryToolSourceLabel, subagentToolFilter,
  MEMORY_TOOL_CONFIG_KEY, MEMORY_TOOL_ENV, SUBAGENT_MEMORY_TOOL_NAMES
} from './memory-read-tools.js'
// 阶段 4:同一个范式给「运行时自动挖影子边」那个开关(判定单一出处 / 三路 OR / 面板可拨)。
// 它的消费者在 Python 引擎侧,所以引擎读的是**插件设置文件**里的同一个键
// (见 lib/graph-gate.js 文件头,与 python/engine/ 那份闸门模块的 gate_enabled)。
import {
  graphGateEnabled, graphGateSourceReport, graphGateSourceLabel,
  graphGateEnabledFromConfig, GRAPH_GATE_CONFIG_KEY, GRAPH_GATE_ENV,
  // ★ 2026-10-01 尾:来源标记的人话(「谁在什么时候拨的」)—— 面板两个开关共用一份。
  // (纯展示映射,不参与判定;见 lib/graph-gate.js 的 flipProvenanceLabel。)
  flipProvenanceLabel
} from './graph-gate.js'
import { createEngine } from './engine.js'
import { createHeartbeat, HEARTBEAT_INTERVAL_MS, CARE_DAILY_CAP, isNightHour } from './heartbeat.js'
import { createTurnStopper } from './turn-stopping.js'
import { createSayAgain } from './say-again.js'
import { createEchoEvents } from './events.js'
// v0.38.0 F2:补写缺口 + 连败退避(planDiaryTick 是纯判据;旧的 diaryDue 只在
// 单测里用了 —— 真机判据已经换成 planDiaryTick,别留一个没人调的老函数在进口上)
import { todayKey, composeDiary, commitDiary, planDiaryTick, midnightOfKey, diaryRetryMs } from './diary.js'
// 2026-09-30 P4a:她的自由活动 —— 产出落盘/上限清理/候选读口都在这里一处
// (`runHerActivity` 只借它的写口;候选那一侧由 `lib/topic-score.js` 借读口)。
// P4b:`composeTidyText` / `ACTIVITY_KIND_DEFAULT` 也在同一处(整理那一类的正文
// **零模型调用** —— 复用策展管线,见那边注释)。
import { writeActivityFile, composeTidyText, ACTIVITY_KIND_DEFAULT } from './her-activity.js'
// 2026-09-30 P4b:整理记忆那一类借的正是压缩域既有的那条只读管线
// (`readSoulSnapshot` 开的是 readOnly 连接 —— 不写主记忆)。
import { readSoulSnapshot, dbPathOf } from './soul-snapshot.js'
// 2026-10-01 A7:记忆架构 v2 的面板读口(只读状态 + 一键回退)。
// 口径在 `python/engine/arch.py` 里只有一份;这里只负责把命令拼对、把 JSON 收回来 ——
// 面板**不许**成为第二个判定处(§5.A7 坑)。
import { readArchStatus, rollbackArch, ARCH_ROUTES } from './arch.js'
import { detectReminder } from './reminder.js'
import { createRelay, marksProactive } from './relay.js'
import { createGroupParticipation, observeGroupParticipation } from './group-social.js'
import { createOfficialOwnerText } from './official-owner-text.js'
import { createSpeaker, formOf, FORM, SERVICE_NAME, SERVICE_VERSION, SERVICE_API, SERVICE_CAPABILITIES } from './speak.js'
import { createVoiceReceiptLedger, VOICE_RECEIPTS_FACE_SHAPE } from './voice-receipts.js'
import { relayToolDefinitions, qzoneToolDefinitions } from './relay-tools.js'
// v0.31.0 P2:她自己的闹钟(echo_wake / echo_wake_cancel)
import { wakeToolDefinitions } from './wake-tools.js'
// v0.32.0 A0/A1a:宿主兼容闸(缺挂点就退回旧做法) + 注入探针(只测量,不改行为)
import { createCompat } from './compat.js'
import { createInjectProbe, firstMarkerLine } from './inject-probe.js'
// v0.32.0 B1:全量工具审计(观察 tools/post-execute,只留痕不改结果)
import { createToolAudit, TOOL_ROW_MARKER } from './tool-audit.js'
// v0.36.0 B2:一轮一个 trace(整轮的审计行能串起来查)
import { createTurnTrace } from './turn-trace.js'
// 2026-10-18：忙时入站队列（她跑任务时消息不丢，等下一轮再投）
import { createInboundQueue, clampQueueLimit } from './inbound-queue.js'
// v0.37.0 G2:旧称呼 → 现在的称呼(只动记忆那一块,历史对话一个字不改)
import { splitAliases } from './alias-rewrite.js'
// 2026-10-05 拍板 2-B / 2026-10-07 换 XML 语法:`<emo>`/`<skip>` 标签在**文字渠道**剥掉
import { stripEmoMarkers } from './emo-marker.js'
import { statusToStyleCandidates } from './style-hint.js'
// v0.38.0 F1:外部事件(传感器/语音平台)入口 ── 只排 wake,不新开投递链
import { parseExternalEvent, eventReason } from './external-event.js'
import { snapshotCapture, runReflection, runStructured, callTransport, setSubagentToolFilterProvider } from './reflect.js'
// 2026-10-05 方案 C:反思类调用的直调通道(不再起子代理)—— 见 lib/llm-channel.js 头部。
import { createLlmChannel } from './llm-channel.js'
// 2026-10-06 方案 C + B:直调通道的 route 决议(纯逻辑,可离线测)
import { chooseReflectTransport, routeOfRequestHeader } from './reflect-route.js'
// 2026-10-05 第二批:子代理会话自动清理(存量 + 持续)—— 见 lib/session-reaper.js 头部。
import { reapSessions, DEFAULT_KEEP_NEWEST, DEFAULT_WINDOW_TURNS } from './session-reaper.js'
import { buildExportPack, renderExportMarkdown } from './export.js'
import { decayedEmotionVector, emotionDelta, formatEmotionDelta, carryExtraEmotionKeys } from './emotion.js'
// v0.40.0 C2:思考风格双档(干活档那一行;角色档 = 空串,一个字不加)
import { thinkingText, THINKING_DEFAULT_MIN_TOOLS } from './thinking-style.js'
// v0.40.0 C1:情绪单轮闭环(他开口那一刻起跑,组装时取;只影响这一轮的渲染)
import { createSameTurnScorer } from './emotion-score.js'
// 2026-10-06:用户侧坐标(人际关系打分,轮末异步)+ 人格基线(立方体静止点)。
// 设计全文见桌面《情绪面板缺口补齐设计-2026-10-06.md》§1/§2。
import { createIpcAppraiser, readDyad, applyGate } from './ipc-appraise.js'
import { readBaseline, baselineUnit, describeBaseline } from './her-baseline.js'
// 2026-09-30 P2:边缘区复核(唯一新增的模型调用点 —— 只决定"说不说",不开口)
import { reviewOnce } from './topic-review.js'
// RT11b(2026-09-30):查询扩展门面 —— 写好了从没接线,这次接上(产物进检索的**主打分**)
import { createQueryExpander } from './query-expand.js'
// v0.41.0:会话分类(子代理会话 vs 顶层陪伴会话)—— 事故修复的唯一一份判据,
// 见 lib/agent-scope.js 顶部的现场说明
import { isSubagentSession, isTopLevelSession, isScopeVisibleSession, SUBAGENT_ID_PATTERN } from './agent-scope.js'
// 2026-09-29 裁定 A(QQ 跟着他走):"他正在用的那条会话"的挑选是纯函数,可离线测。
import { pickHisSession, describeRoute, DEFAULT_COMPANION_ID } from './companion-target.js'
// 2026-10-01 尾:兜底会话"看得见吗"的**纯规则**(归档集 / 已登记会话 / 挑替身)单独
// 成模块 ⇒ 能被单测直接钉住;这里只做"读那个文件的薄 wrapper"。
import { readWorkspaceState, pickVisibleSession } from './companion-visibility.js'
// v0.40.0 C3:出站清单(禁词/防重复)—— 自动出站那条路在 relay.js 里查,
// 她**自己动手**调 echo_qq_say 那条路在下面这个 guard 里查(工具面回人话原因)
import {
  guardOutbound, splitList, bannedWordsFor, DEFAULT_BANNED_ACTION,
  DEFAULT_REPEAT_ACTION, DEFAULT_REPEAT_SIMILARITY, REPEAT_LOOKBACK
} from './speech-guard.js'
import {
  createDriftTracker, driftAuditRow, DRIFT_SCHEMA, DRIFT_SHOCK
} from './drift.js'
import { createWebPageHandler, webRootOf } from './webpage.js'
import { SETTINGS_FIELDS, derivedPersonaFields } from './settings-fields.js'
import { buildStampOf } from './build-stamp.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
// P1a:库路径改由路径真源推(ECHO_DB > <数据目录>/echo.db;数据目录 = ECHO_DATA_DIR >
// $DSH_HOME/echo > ~/.dsh/echo)。不设任何 env 时与旧的 `join(DATA_DIR,'echo.db')` 逐字节相同。
// 与 `lib/soul-snapshot.js` 的 `dbPathOf()` 现已是同一个口径(它也跟着 persona 的 DATA_DIR 走)。
const DB_PATH = resolveDbPath()
// 2026-09-26 审计第一条:改完 lib、没重启 dsh web,跑的还是旧代码 ——
// 而 version 三份都一样(仓库/装机位/活进程),分不出来。加载时算一枚
// 构建指纹(lib/*.js 内容哈希),进 echo_status 与启动日志。
const LIB_DIR = dirname(fileURLToPath(import.meta.url))
const BUILD = buildStampOf(LIB_DIR)

/**
 * P1d(2026-10-05):面板要的**称呼与名字** —— 唯一出口。
 *
 * 读出逻辑已经搬去唯一读点 `lib/profile.js` 的 `publicProfile()`(profile.json
 * 这份数据文件只许有一个读点;端点的降级形状也写在那里)。web 侧不许自己写死
 * 称呼,**也不许前端直接读数据文件** —— 它只 `fetch('GET /api/echo/profile')`。
 */

export const name = 'dsh-echo'

export const inject = ['tools', 'systemPrompt', 'webServer', 'sessions', 'subagents', 'agents', 'llm']

// 人格内存缓存:apply 时异步预热,面板保存时原地更新;系统提示段是
// 同步求值,读这个缓存 —— 首轮未加载完时回落默认值(内容相同,无感)。
let personaCache = { prefix: DEFAULT_PERSONA.prefix, suffix: DEFAULT_PERSONA.suffix, customized: false }
let lastLoadAt = ''

// 记忆库句柄(fail-soft:打开失败置 null,记忆功能降级,人格不受影响)
let store = null
// 语音回执账(2026-10-04):heart-tts 的 voice.external / voice.interrupted 落账。
// 独立文件(lib/voice-receipts.js),不进 relay.js 的出站/入站流程;挂载在
// echo:relay 服务的 registerVoiceReceipt 一行桥接上。
let voiceReceiptLedger = null

// 引擎门面句柄(M2-d):apply 时创建;null = 尚未挂载
let engine = null

// 用户侧坐标打分器(2026-10-06):apply 时创建 —— **必须排在 `unionIpc` 之后**
// (它靠 ipc-core 的关系代数:`relationshipSync` / `appraise` 提示词 / 解析)。
// 轮末异步用;状态面与 `/api/echo/emotion-space` 读它。null = 还没挂上(这拍自动跳过)。
let ipcAppraiser = null

// v0.17.0 R2 传话桥句柄:apply 时创建(status 面要用,所以提到模块层)
let relay = null
// S1:渠道无关的"嘴"。今天 transport = 桥(唯一在跑的传输),speaker 只转发。
let speaker = null
// v0.30.2:关怀判定留痕。heartbeat 在 apply 里创建,而 statusPayload 是模块级
// 导出 ⇒ 用这个 holder 过桥(和 speaker 同一个写法)—— 让「她为什么没开口」
// 在 /api/echo/status 的 `care` 上当场可查,不靠猜、也不靠宿主 stdout。
let careTraceOf = () => null

// apply 侧 logger 句柄(工具审计 fail-soft 用;apply 前为 null)
let ctxLogger = null

function engineState() {
  if (engine === null) return { mode: 'offline', python: null, sidecar: null }
  try { return engine.state() } catch { return { mode: 'offline', python: null, sidecar: null } }
}

/**
 * Step B:向量臂状态 —— 读 worker 写的 `<数据目录>/embed-state.json`。
 *
 * 为什么读文件而不是问引擎:壳侧唯一能发帧的地方是 `lib/engine.js`,而它
 * **没有导出 `frame()`**;要主动发 `embed_probe` 帧就得先动 engine.js。
 * 本步纪律是"不改 engine.js" ⇒ 走 **worker 主动上报**(写文件)。
 *
 * 附带好处:worker 死了文件还在,状态面能看到"最后一次已知状态 + 时间"
 * (`at`),而不是一片空白 —— 读的人自己判新鲜度。
 *
 * never-throw:文件不在 / 坏 JSON / 形状不对 ⇒ `null`(状态面显示"没装/没跑",不编)。
 */
function readEmbedState() {
  try {
    const raw = JSON.parse(readFileSync(join(DATA_DIR, 'embed-state.json'), 'utf8'))
    if (raw === null || typeof raw !== 'object') return null
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
    return {
      warmed: raw.warmed === true,
      reason: String(raw.reason || ''),
      ms: num(raw.ms),
      rssMb: num(raw.rss_mb),
      at: num(raw.at),
      source: (raw.source && typeof raw.source === 'object') ? String(raw.source.source || '') : ''
    }
  } catch { return null }
}

function json(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

// afaccess A10 先例:POST body 上限 64KB,超限视为非法请求不进内存。
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let overflow = false
    req.on('data', (c) => {
      size += c.length
      if (size > 65536) { overflow = true; return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (overflow) return resolve(null)
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text === '' ? {} : JSON.parse(text))
      } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

// afaccess A5 先例:写操作要求回环 Origin + 自定义请求头,防跨站表单偷写。
function writeAllowed(req) {
  const origin = String(req.headers.origin ?? '')
  if (origin !== '' && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return false
  return req.headers['x-echo-edit'] === '1'
}

/** v0.15.1 G14:整库清空的确认短语(面板必须手打,不许点一下就没)。 */
const MEMORY_CLEAR_PHRASE = '清空记忆'

/**
 * v0.15.1 G16:导出下载。Content-Disposition 用 RFC 5987 的 filename* ——
 * 文件名带中文时不至于在浏览器里变成一串问号。
 */
function sendDownload(res, filename, contentType, text) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_')
  res.writeHead(200, {
    'content-type': contentType,
    'content-disposition': 'attachment; filename="' + ascii
      + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename),
    'cache-control': 'no-store'
  })
  res.end(text)
}

/** 查询串(URL 解析失败就当选空)。注意 apply() 里另有一个同名的局部
 *  实现(历史代码,行为一致);这个模块级的给模块级助手用。 */
function queryOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

const EMPTY_MEMORY_STATS = Object.freeze({
  episodicActive: 0, episodicTotal: 0, quarantined: 0, l0: 0,
  graphNodes: 0, graphEdges: 0, lastMemoryAt: 0,
  // v0.15.1 G22 三项也要有占位:status 的 schema 是「全字段 object」,
  // 库离线时漏字段会让面板读到 undefined(v0.1.2 的老教训)。
  auditRows: 0, superseded: 0, profileFields: 0,
  moodIntensity: 0, updatedAt: 0
})

/**
 * 状态面(导出是为了离线校验:装机前拿**宿主的** validateJsonSchemaValue
 * 把这份 payload 对的 schema 跑一遍 —— 2026-09-26 现场就是这里漏声明,
 * echo_status 每次调用都被输出校验拒掉,而电池一直没红)。
 */
// v0.32.0 A0/A1a:兼容闸与注入探针的**最近一次结果**(只在 apply() 里被赋值;
// 没起过就是 null —— 面板照实说"还没探",不编一个默认值糊过去)。
let hostCapsState = null
let injectProbeState = null
// v0.32.0 B1:工具审计的统计面(闭包读,与上面两个同款:没起过就是 null)
let toolAuditState = null
// v0.40.0 C1:情绪单轮闭环的计数面(同款闭包读 —— 打分器在 apply 里造,
// 状态面在模块作用域,所以这里必须留个"读它的函数",不能直接抓那个 const。
// 2026-09-28 夜 `npm run check` 抓到过一次:直接抓就是 ReferenceError)
let sameTurnEmotionState = null
// RT11b(2026-09-30):查询扩展的计数面(同款闭包读 —— 门面在 apply 里造)
let queryExpandState = null
// RT9:检索账本的读面(与上面同款理由:账本在 apply 里造,状态面在模块作用域)
let retrieveLedgerState = null
// (2026-09-29:原来这里有 `WORKING_WINDOW_SEC = 300` —— 「他正在干活」的判定窗口。
//  那条闸与它的设置项 `quietWhileWorking` 按他 2026-09-29 的裁定一起删掉了。)
// v0.35.0 B4:反思(子代理那一趟)的留痕面 —— 没起过就是 null
let reflectState = null
/**
 * v0.41.0:那份留痕的**键集模板**(冷形状)。
 *
 * 为什么提到模块作用域:状态面的 schema 是 `additionalProperties: false`
 * (2026-09-26 现场两连炸:payload 多一个没声明的键 ⇒ echo_status 每次调用都被
 * 宿主拒掉)。「加键必须同批声明」这条纪律原来只能靠人记 —— 现在键集在这里
 * 有一份**可被机器读的真值**:`scripts/check_tools.mjs` 拿 `statusShapes()`
 * 去撞宿主的校验器(离线的 `statusPayload()` 里这两个面都是 null,撞不到键)。
 */
const REFLECT_STATS_SHAPE = {
  runs: 0, fails: 0, lastMs: null, lastAt: 0, lastOk: null, lastNote: '',
  busySkipped: 0, queueMerged: 0, noAgentSkipped: 0, subagentSkipped: 0,
  // 2026-10-05 方案 C:四格(成功/超时/排队/失败)+ 运行面。
  // 纪律:键集与 lib/index.js 里 echo_status 的 schema **必须同批声明**
  // (2026-09-26 那次 additionalProperties:false 拒答事故)。
  llmMode: '', llmOk: 0, llmTimeout: 0, llmQueued: 0, llmFailed: 0,
  llmSkipped: 0, llmRunning: 0, llmWaiting: 0,
  // 2026-10-06:错误原文 + 这一趟收到的 chunk 面(适配器报错 / 思考吃光 / 真空产出
  // 三者的分水岭)。以前只有计数,面板上看不出"为什么"。
  llmLastError: '', llmLastChunks: '',
  // ★★ 2026-10-21：**舱壁可观测面的默认值**。必须与上面 A 段的 schema **同批**加 ——
  //   这块形状是 `additionalProperties: false`，缺默认值就是 `undefined`，
  //   第一次填之前的那一拍就可能被判非法（`echo_status` 整个被拒）。
  llmLastMs: 0, llmPool: null
}

/**
 * 2026-09-30 P2:心跳结论面(`care`)的**键集模板**。
 *
 * 为什么在这里:与 `REFLECT_STATS_SHAPE` 同一个坑 —— 离线 `statusPayload()`
 * 的 `care` 是 **null**(插件没挂载),`scripts/check_tools.mjs` 拿真实返回值
 * 撞 schema 时**一个键都撞不到** ⇒ `targetSessionId` 漏声明一整版没人发现
 * (`heartbeat.js:322/332` 一直在带它)。所以把键集在这里留一份可被机器读的
 * 真值,由 check:tools 拿它拼一个"心跳活着"的载荷撞宿主的校验器。
 *
 * 形状必须与 `heartbeat.js` 的 `careTrace` 初始化逐键同形
 * (`{...careTrace, writeFailed}`);`heartbeat.test.js` 有一条对拍闸。
 */
export const CARE_TRACE_SHAPE = {
  at: 0, reason: 'idle', shouldCare: false, value: 0, threshold: 0,
  sessionId: '', targetSessionId: '', kind: 'quiet', acted: false,
  quietStreak: 0, nextPollAt: 0, writeFailed: 0
}

export function statusPayload() {
  return {
    status: 'active',
    enabled: readEnabled(),
    version: VERSION,
    // 活着的到底是哪一版:lib/*.js 的 sha256 前 12 位 + 文件数 + 最新 mtime
    build: { short: BUILD.short, files: BUILD.files, latestMtime: BUILD.latestMtime },
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    memoryOnline: store !== null,
    engine: engineState(),
    // Step B:向量臂(读 worker 主动上报的状态文件;没有就是 null = 没装/没跑)
    embed: readEmbedState(),
    personaChars: { prefix: personaCache.prefix.length, suffix: personaCache.suffix.length },
    personaCustomized: personaCache.customized,
    maxChars: PERSONA_MAX_CHARS,
    lastLoadAt: lastLoadAt,
    // v0.9.0 会话范围:总闸之下还有分闸(工作娱乐两不误)
    scope: readScope(),
    // 2026-09-26 硬开关:面板要能显示「谁拨的、什么时候拨的」—— 开关的
    // 可信度靠这个,不靠他记得自己说过什么。
    power: readPower(),
    // v0.1.2 教训:占位字段也要类型完整 —— memory 是全字段 object,库离线时给零值
    memory: (store !== null ? store.memoryStats() : EMPTY_MEMORY_STATS),
    // v0.16.0 M4:画像只读投影({name, coreTraits, derivedFromL0[]})——
    // 面板的「画像」卡要能回答「她以为我是谁、这条从哪句来的」。库离线
    // 时给同形状空值(老教训:占位字段类型也要完整)。
    profile: (store !== null ? safeProfile() : { name: '', emotionState: 'neutral', coreTraits: null, derivedFromL0: [] }),
    // v0.17.0 R2 传话桥(2026-09-28 旧桥退役后仍在:这是**进程内 relay 核心**的状态面):
    // 「有没有嘴/陪伴会话/队列/渠道数」—— 新仓的验收脚本靠这几个字段认身份,字段形状别动。
    relay: relayStatus(),
    // v0.30.2:她最近一次关怀判定的结论与卡点
    // ({at, reason, shouldCare, value, threshold, sessionId})——
    // reason 取值:tick 内 logBeat 的调用点(engine-says-no / night-hold /
    // session-mismatch / daily-cap / pending-ack / deliver-busy / sent /
    // reminder-sent / reminder-busy / wake-sent / wake-night-hold / wake-busy /
    // tick-error / backoff / idle)。
    // v0.31.0 P2:同一份理由还会落进 `care_beats` 表(可 GROUP BY、能翻历史),
    // 这里额外带 kind / acted / quietStreak / nextPollAt / writeFailed —— 查历史用
    // `node scripts/echoq.mjs --since 24h`。
    care: careTraceOf(),
    // v0.32.0 A0:宿主有哪些挂点(section/context/variable)+ 缺哪个就退回旧做法的说明。
    // A1 要用的 `context()` 在不在,一眼可查 —— 不靠"文档说它有"。
    compat: hostCapsState,
    // v0.32.0 A1a:注入探针 —— 我们这次注入的块,在**数过的语料**里出现几份。
    // `scopes` 说清这份数字管到哪(只数了系统提示段);`duplicated=true` 就是红线。
    inject: injectProbeState,
    // v0.32.0 B1:全量工具审计的计数面(seen/written/各档 skip/failed/byName)
    toolAudit: (typeof toolAuditState === 'function' ? toolAuditState() : null),
    // v0.35.0 B4:反思那一趟(子代理)的耗时/成败/为什么跳过
    reflect: (typeof reflectState === 'function' ? reflectState() : null),
    // v0.40.0 C1:情绪单轮闭环的计数面(started/applied/timedOut/failed/lastMs)
    // —— 「同轮生效率」与「超时率」两个体检指标就在这儿,accept-emotion.mjs 读它
    sameTurnEmotion: (typeof sameTurnEmotionState === 'function' ? sameTurnEmotionState() : null),
    // 2026-10-06:用户侧坐标打分器的计数面(runs/ok/skipped/failed/lowGain/lastGate/
    // lastReason)—— 「这轮为什么没判定」必须有个能查的地方:节流、总闸关闭、
    // ipc-core 不可用、LLM 没产出、可信度不足,五种都在这儿看得见(不许静默)。
    ipcAppraise: (ipcAppraiser === null ? null : ipcAppraiser.stats()),
    // 2026-10-06:人格基线一行人话(没开总闸 / 没填 ⇒ null)
    herBaseline: (() => { try { return describeBaseline(readBaseline(readSettings())) } catch { return null } })(),
    // RT11b(2026-09-30):查询扩展的计数面(started/applied/timedOut/cacheHit/lastTerms)
    // —— 「扩展生效率」与「超时率」的体检指标就在这儿
    queryExpand: (typeof queryExpandState === 'function' ? queryExpandState() : null),
    // RT9:这一问召回了谁 / 各臂有没有读数 / 有没有零命中(retrieval 账本) ——
    // 只记不判,它不改排序也不改阈值;真机漏召回样本靠它捡
    retrieval: (typeof retrieveLedgerState === 'function' ? retrieveLedgerState() : null),
    // 2026-10-04:语音回执摘要(最近 N 条 kind/session/seq/reason,**不含正文**)——
    // 「她说到哪了 / 被打断在哪」在 echo_status 一眼可查。同批加键同批声明
    // (additionalProperties:false,漏一个键 echo_status 就被宿主拒掉)。
    voiceReceipts: safeVoiceReceiptsFace()
  }
}

/**
 * v0.41.0:状态面那两个**统计面**的形状真值(给 `scripts/check_tools.mjs` 用)。
 *
 * 与 `statusPayload()` 里那两项同形:`sameTurnEmotion` 带 `at`(打分器自己加),
 * `reflect` 带 `at`(`reflectState()` 加)。离线调 `statusPayload()` 这两项都是
 * null ⇒ schema 漏声明一个键也检不出来(除非真跑一次 apply)。所以把形状导出,
 * 让 `npm run check` 用宿主的校验器真撞一遍 —— 「同批加键同批声明」从此有闸。
 *
 * 键集**从模块自己算出来**(打分器给一份真的 stats;reflect 用那份模板),
 * 所以这里不需要维护第二份键表;只是可空字段(`lastMs` / `lastOk`)要额外给
 * 一份「有值」的形状 —— 否则把它们声明错类型也检不出来。
 */
export function statusShapes () {
  const sameTurnCold = createSameTurnScorer({}).stats()
  const queryExpandCold = createQueryExpander({}).stats()
  const reflectCold = { ...REFLECT_STATS_SHAPE, at: 0 }
  return [
    { name: 'sameTurnEmotion(冷:还没起过)', face: 'sameTurnEmotion', value: sameTurnCold },
    { name: 'queryExpand(冷:还没起过)', face: 'queryExpand', value: queryExpandCold },
    { name: 'reflect(冷:还没起过)', face: 'reflect', value: reflectCold },
    { name: 'reflect(暖:可空字段有值)', face: 'reflect', value: { ...reflectCold, lastMs: 120, lastOk: true } },
    // 2026-09-30 P2:心跳结论面。离线是 null ⇒ 上面那两圈都撞不到 care 的键,
    // 而它正是这次修掉的坏点(targetSessionId 漏声明)。**必须带一份非空形状**。
    { name: 'care(心跳起来了)', face: 'care', value: { ...CARE_TRACE_SHAPE } },
    // 2026-10-04:语音回执面。离线 statusPayload() 给 null ⇒ 撞不到键;而
    // VOICE_RECEIPTS_FACE_SHAPE 里 seq/reason 各有"有值/为空"两种,声明错
    // 可空类型也能检出来。
    { name: 'voiceReceipts(收到过回执)', face: 'voiceReceipts', value: { ...VOICE_RECEIPTS_FACE_SHAPE } }
  ]
}

/** relay 核心状态:插件还没挂载或库离线时给同形状零值(面板与验收脚本的字段类型都要完整)。 */
function relayStatus () {
  try {
    if (relay !== null) return relay.status()
  } catch { /* 桥自己炸了不能把状态面带走 */ }
  return {
    enabled: false, sessionId: '', permissionPreset: '', proactiveScope: 'private',
    queue: { queued: 0, leased: 0, sent: 0, dropped: 0, channels: 0 }, channels: 0, pendingTurn: 0
  }
}

/** 画像读取的兜底:老库列缺失/脏数据不许把状态面整体打挂。 */
function safeProfile () {
  try {
    const p = store.getProfile()
    return {
      name: p.name || '',
      emotionState: p.emotionState || 'neutral',
      coreTraits: p.coreTraits ?? null,
      derivedFromL0: Array.isArray(p.derivedFromL0) ? p.derivedFromL0 : []
    }
  } catch {
    return { name: '', emotionState: 'neutral', coreTraits: null, derivedFromL0: [] }
  }
}

/** 语音回执摘要的兜底:账本还没挂/查询炸了都不许带走状态面(safeProfile 同款)。 */
function safeVoiceReceiptsFace () {
  try {
    if (voiceReceiptLedger !== null) return voiceReceiptLedger.statusFace()
  } catch { /* 账本自己炸了不能把状态面带走 */ }
  return null
}

/**
 * 宿主 SessionEvent 形状提取见 lib/session-events.js(v0.9.1 根因
 * 修复:零宿主依赖模块,index.js 引宿主包无法离线单测 —— 这正是
 * 该 bug 潜伏一整个时代的原因:接线代码零离线覆盖)。
 */
import { messageOfEvent } from './session-events.js'

/**
 * echo_status 工具定义(纯数据 + execute 闭包,不调 defineTool)。
 * 独立导出是为了离线校验:装机后用宿主树的 dsh-tools 对真实定义跑
 * defineTool,schema 非法在装机阶段就能抓住,不用等 dsh web 崩。
 */
export function statusToolDefinition() {
  return {
    name: 'echo_status',
    description: 'Echo 插件诊断工具:返回版本、人格挂载、记忆库状态(情景记忆条数/L0 核心记忆/图谱规模/她的情绪强度)与数据目录。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          enabled: { type: 'boolean' },
          version: { type: 'string' },
          // 2026-09-26:构建指纹。宿主 HMR 不重载插件模块(profile-boot 的
          // config.root 是空数组)⇒ 改完 lib 必须重启 dsh web 才生效,而这枚
          // 指纹就是「重启了没有 / 活的是哪一版」的自证。**声明必须与 payload
          // 同步**(additionalProperties:false 的坑今天刚踩过)。
          build: {
            type: 'object',
            additionalProperties: false,
            properties: {
              short: { type: 'string' },
              files: { type: 'number' },
              latestMtime: { type: 'number' }
            }
          },
          dataDir: { type: 'string' },
          dbPath: { type: 'string' },
          memoryOnline: { type: 'boolean' },
          personaChars: { type: 'object', additionalProperties: true },
          personaCustomized: { type: 'boolean' },
          // v0.32.0 A0/A1a:compat 与 inject 两个 payload 键**必须在这里声明** ——
          // additionalProperties:false 是逐键判的,漏一个键 = echo_status 每次调用都被拒
          // (v0.30.2 的 `care` 就是这么坏了一整版,教训写在这儿)。
          compat: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ok: { type: 'boolean' },
                  section: { type: 'boolean' },
                  context: { type: 'boolean' },
                  variable: { type: 'boolean' },
                  version: { type: 'string' },
                  note: { type: 'string' }
                }
              },
              { type: 'null' }
            ]
          },
          inject: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  at: { type: 'number' },
                  marker: { type: 'string' },
                  occurrences: { type: 'number' },
                  chars: { type: 'number' },
                  duplicated: { type: 'boolean' },
                  scopes: { type: 'array', items: { type: 'string' } },
                  per: { type: 'object', additionalProperties: true },
                  // v0.40.0:「已加载但还没读数」这两个键 —— 用来把"等一等"
                  // 与"要重启"分开(真机踩过:重启后没人说话 ⇒ 误报"未加载")
                  loadedAt: { type: 'number' },
                  readings: { type: 'number' },
                  note: { type: 'string' }
                }
              },
              { type: 'null' }
            ]
          },
          toolAudit: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  at: { type: 'number' },
                  seen: { type: 'number' },
                  written: { type: 'number' },
                  skippedPower: { type: 'number' },
                  skippedScope: { type: 'number' },
                  ownSkipped: { type: 'number' },
                  failed: { type: 'number' },
                  byName: { type: 'object', additionalProperties: true }
                }
              },
              { type: 'null' }
            ]
          },
          reflect: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  at: { type: 'number' },
                  runs: { type: 'number' },
                  fails: { type: 'number' },
                  lastMs: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                  lastAt: { type: 'number' },
                  lastOk: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
                  lastNote: { type: 'string' },
                  busySkipped: { type: 'number' },
                  queueMerged: { type: 'number' },
                  noAgentSkipped: { type: 'number' },
                  // v0.41.0:子代理会话的轮末被挡下来的次数(递归闸踩刹车的次数)
                  subagentSkipped: { type: 'number' },
                  llmMode: { type: 'string' },
                  llmOk: { type: 'number' },
                  llmTimeout: { type: 'number' },
                  llmQueued: { type: 'number' },
                  llmFailed: { type: 'number' },
                  llmSkipped: { type: 'number' },
                  llmRunning: { type: 'number' },
                  llmWaiting: { type: 'number' },
                  // 2026-10-06:错误原文 + chunk 面(与 REFLECT_STATS_SHAPE 同批)
                  llmLastError: { type: 'string' },
                  llmLastChunks: { type: 'string' },
                  // ★★ 2026-10-21：**舱壁的可观测面** —— 两个池各自的 running / waiting。
                  //
                  //   10605eb 拆了池，但 `/api/echo/status` 里看不见它们 ⇒ 重启之后
                  //   没法验收"反思是不是还在挡轮前那两个小调用"。这一格就是验收口。
                  //
                  //   ⚠️ 与 `REFLECT_STATS_SHAPE` **同批**加：
                  //      这里 `additionalProperties: false`，漏声明一个键
                  //      ⇒ `echo_status` 整个被宿主拒掉（不是"少显示一格"）。
                  llmLastMs: { type: 'number' },
                  llmPool: {
                    oneOf: [
                      {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          live: {
                            type: 'object',
                            additionalProperties: false,
                            properties: { running: { type: 'number' }, waiting: { type: 'number' } }
                          },
                          bulk: {
                            type: 'object',
                            additionalProperties: false,
                            properties: { running: { type: 'number' }, waiting: { type: 'number' } }
                          }
                        }
                      },
                      { type: 'null' }
                    ]
                  }
                }
              },
              { type: 'null' }
            ]
          },
          // v0.40.0 C1:情绪同轮闭环的计数面(同批加的键**必须同批声明** ——
          // additionalProperties:false,漏一个键 echo_status 就被宿主拒掉)
          sameTurnEmotion: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  at: { type: 'number' },
                  started: { type: 'number' },
                  applied: { type: 'number' },
                  timedOut: { type: 'number' },
                  failed: { type: 'number' },
                  skippedNoRun: { type: 'number' },
                  // v0.41.0:子代理会话的 claim 被挡下来的次数(同批加键同批声明)
                  skippedSubagent: { type: 'number' },
                  // 2026-10-17：空 query 早退的次数（与 query_expand 的同一格对齐）。
                  // 为什么必须声明：`additionalProperties: false` 漏一个就是整个工具输出被拒。
                  emptyQuery: { type: 'number' },
                  lastMs: { type: 'number' },
                  lastReason: { type: 'string' }
                }
              },
              { type: 'null' }
            ]
          },
          // 2026-10-06:用户侧坐标打分器的计数面(同批加键**必须同批声明** ——
          // additionalProperties:false,漏一个键 echo_status 就被宿主拒掉)
          ipcAppraise: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  turns: { type: 'number' },
                  runs: { type: 'number' },
                  ok: { type: 'number' },
                  skipped: { type: 'number' },
                  failed: { type: 'number' },
                  lowGain: { type: 'number' },
                  lastAt: { type: 'number' },
                  lastTurnRun: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                  lastGate: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  lastErr: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  lastReason: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  lastNote: { type: 'string' }
                }
              },
              { type: 'null' }
            ]
          },
          // 2026-10-06:人格基线的一行人话(没开总闸 / 没填 ⇒ null)
          herBaseline: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          // RT11b(2026-09-30):查询扩展的计数面(同批加键**必须同批声明** ——
          // additionalProperties:false,漏一个键 echo_status 就被宿主拒掉)
          queryExpand: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  at: { type: 'number' },
                  started: { type: 'number' },
                  applied: { type: 'number' },
                  timedOut: { type: 'number' },
                  failed: { type: 'number' },
                  skippedNoRun: { type: 'number' },
                  // 2026-10-17：空 query 早退的次数。以前这条路**一条 stats 都不记**，
                  // 于是"空查询 / 没跑到 / 超时"在状态面上长得一模一样（全是 0）。
                  emptyQuery: { type: 'number' },
                  cacheHit: { type: 'number' },
                  lastMs: { type: 'number' },
                  lastTerms: { type: 'number' },
                  cacheSize: { type: 'number' },
                  pending: { type: 'number' }
                }
              },
              { type: 'null' }
            ]
          },
          // RT9:检索账本的计数面(queries/zeroHit/avgRows/byEngine/kept/cap)
          retrieval: {            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  pushed: { type: 'number' },
                  zeroHit: { type: 'number' },
                  dropped: { type: 'number' },
                  byEngine: { type: 'object', additionalProperties: false, properties: { python: { type: 'number' }, baseline: { type: 'number' } } },
                  lastAt: { type: 'number' },
                  lastQuery: { type: 'string' },
                  lastRows: { type: 'number' },
                  avgRows: { type: 'number' },
                  kept: { type: 'number' },
                  cap: { type: 'number' },
                  at: { type: 'number' }
                }
              },
              { type: 'null' }
            ]
          },
          // 2026-10-04:语音回执摘要面({at, total, recent[{kind,session,seq,reason}]}),
          // recent 的 seq/reason 是可空的(external 没 reason、interrupted 没 seq)——
          // 宿主校验器不支持 type 数组,一律 oneOf。同批加键同批声明。
          voiceReceipts: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  at: { type: 'number' },
                  total: { type: 'number' },
                  recent: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        kind: { type: 'string' },
                        session: { type: 'string' },
                        seq: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                        reason: { oneOf: [{ type: 'string' }, { type: 'null' }] }
                      }
                    }
                  }
                }
              },
              { type: 'null' }
            ]
          },
          // v0.9.0 教训:payload 加字段必须同步声明 —— schema 是
          // additionalProperties:false,漏声明 = 工具输出校验直接炸
          maxChars: { type: 'number' },
          // 2026-09-26 现场:这里声明成 number,而 statusPayload 塞的是
          // `new Date().toISOString()`(**字符串**)—— 于是 echo_status 每次
          // 调用都被宿主的输出校验拒掉:「value.lastLoadAt must be a number」。
          // 工具从 v0.1 起就是坏的,今天调它取证才发现。类型按实际值改。
          lastLoadAt: { type: 'string' },
          scope: {
            type: 'object',
            additionalProperties: false,
            properties: {
              scope: { type: 'string' },
              whitelist: { type: 'array', items: { type: 'string' } },
              exempt: { type: 'array', items: { type: 'string' } },
              // 2026-09-26 硬开关:人显式关过的会话(面板要显示)
              manualOff: { type: 'array', items: { type: 'string' } },
              by: { type: 'string' },
              at: { type: 'number' }
            }
          },
          // 电源的完整状态(谁拨的/什么时候)—— 与 scope 同款:payload 有、
          // schema 必须声明,否则 additionalProperties:false 直接拒掉整个工具。
          power: {
            type: 'object',
            additionalProperties: false,
            properties: {
              enabled: { type: 'boolean' },
              by: { type: 'string' },
              at: { type: 'number' }
            }
          },
          // Step B:向量臂状态。payload 有、schema 必须声明 ——
          // `additionalProperties:false` 的坑这个仓踩过好几次(漏一个字段
          // 就等于整个 echo_status 工具不可用)。形状与 readEmbedState() 对齐。
          embed: {
            type: 'object',
            additionalProperties: false,
            properties: {
              warmed: { type: 'boolean' },
              reason: { type: 'string' },
              ms: { type: 'number' },
              rssMb: { type: 'number' },
              at: { type: 'number' },
              source: { type: 'string' }
            }
          },
          memory: {
            type: 'object',
            additionalProperties: false,
            properties: {
              episodicActive: { type: 'number' },
              episodicTotal: { type: 'number' },
              quarantined: { type: 'number' },
              l0: { type: 'number' },
              graphNodes: { type: 'number' },
              graphEdges: { type: 'number' },
              lastMemoryAt: { type: 'number' },
              // v0.15.1 G22 的三项 + 情绪两项:memoryStats() 一直在返回,
              // 但 schema 里从来没声明过 —— 同一次现场一起补上(漏一个
              // 就等于工具整体不可用,因为 additionalProperties:false)。
              auditRows: { type: 'number' },
              superseded: { type: 'number' },
              profileFields: { type: 'number' },
              moodIntensity: { type: 'number' },
              updatedAt: { type: 'number' }
            }
          },
          // v0.16.0 M4 画像投影 + v0.17.0 R2 桥状态:同样是「返回值有、
          // schema 里没声明」。两个都按实际形状声明(桥那层 additionalProperties
          // 放开:队列/渠道是它自己的形状,声明太细反而每加一个计数就炸一次)。
          profile: {
            type: 'object',
            additionalProperties: true,
            properties: {
              name: { type: 'string' },
              emotionState: { type: 'string' },
              // safeProfile() 没有画像时给的是 **null**(不是空数组),所以这里
              // 必须写成 oneOf —— 宿主校验器不支持 type 数组(实测:
              // 「type arrays are not supported」),oneOf 它是支持的。
              coreTraits: {
                oneOf: [
                  { type: 'array', items: { type: 'string' } },
                  { type: 'null' }
                ]
              },
              // 2026-09-30 P2 修(实测坏的):这里原本声明成 `items:{type:'string'}`,
              // 而 `store.getProfile()`(`store.js:744-746`)返回的是**对象数组**
              // `[{memoryId, field, summary}]` ⇒ 宿主校验器报
              // 「value.profile.derivedFromL0[0] must be a string」。
              // 它一直没被发现,是因为离线夹具里 L0 行是空的 —— 空数组对
              // `items` 无法证伪(见 `scripts/check_tools.mjs` 补的那条夹具)。
              derivedFromL0: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    memoryId: { type: 'number' },
                    field: { type: 'string' },
                    summary: { type: 'string' }
                  }
                }
              }
            }
          },
          relay: {
            type: 'object',
            additionalProperties: true,
            properties: {
              enabled: { type: 'boolean' },
              sessionId: { type: 'string' },
              permissionPreset: { type: 'string' },
              proactiveScope: { type: 'string' },
              queue: { type: 'object', additionalProperties: true },
              channels: { type: 'number' },
              pendingTurn: { type: 'number' }
            }
          },
          engine: {
            type: 'object',
            additionalProperties: true
          },
          // v0.31.0 P2 抓到的一个**真事故**:`care` 从 v0.30.2 起就一直在
          // payload 里(statusPayload 的一等字段),而 schema 里没声明它 ——
          // 宿主校验器对 additionalProperties:false 的对象**逐键判**,
          // 于是 `echo_status` 每次调用都被拒(「value.care is not a declared
          // property」)。它没被发现,是因为 `npm run check:tools` 自 v0.30.2 起
          // 没被跑过(`check`/`hygiene` 是另外两条)。教训:**加字段必须同步声明**,
          // 而且 check:tools 得进常跑的那两条(见 package.json 的 check)。
          // 插件没挂载/库离线时 careTraceOf 给 null ⇒ 必须 oneOf(S1 的先例)。
          // 2026-09-30 P2 修(实测坏的):`targetSessionId` 从 v0.42.0 起就一直在
          // `careTrace` 里(`heartbeat.js:322/332` —— 它回答"这一拍本该投到哪条
          // 会话开口"),而 schema 里没声明 ⇒「value.care must match exactly one
          // oneOf branch (matched 0)」,**echo_status 每次调用都被拒**。
          // 与 care 那次(v0.30.2)同一个坑:加键必须同批声明。夹具已补
          // (`scripts/check_tools.mjs` 用 CARE_TRACE_SHAPE 撞一次)。
          care: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  at: { type: 'number' },
                  reason: { type: 'string' },
                  shouldCare: { type: 'boolean' },
                  value: { type: 'number' },
                  threshold: { type: 'number' },
                  sessionId: { type: 'string' },
                  targetSessionId: { type: 'string' },
                  kind: { type: 'string' },
                  acted: { type: 'boolean' },
                  quietStreak: { type: 'number' },
                  nextPollAt: { type: 'number' },
                  writeFailed: { type: 'number' }
                }
              },
              { type: 'null' }
            ]
          }
        }
      },
      render: (args, value) => [{ type: 'text', text: [
        'status=' + value.status + ' enabled=' + String(value.enabled) + ' version=' + value.version + ' memoryOnline=' + String(value.memoryOnline),
        'engine=' + (value.engine ? value.engine.mode : 'offline')
          + (value.engine && value.engine.sidecar ? ' running=' + String(value.engine.sidecar.running)
            + ' breaker=' + String(value.engine.sidecar.breakerOpen)
            + (value.engine.sidecar.version ? ' v' + value.engine.sidecar.version : '') : ''),
        'dataDir=' + value.dataDir,
        'persona=' + JSON.stringify(value.personaChars) + ' customized=' + String(value.personaCustomized),
        'memory: episodic=' + value.memory.episodicActive + '/' + value.memory.episodicTotal +
          ' L0=' + value.memory.l0 + ' 待观察=' + value.memory.quarantined +
          ' graph=' + value.memory.graphNodes + 'n/' + value.memory.graphEdges + 'e' +
          ' mood=' + value.memory.moodIntensity + '/10',
        // v0.31.0 P2:心跳的当下结论 —— 「她为什么没开口」当场可答
        value.care === null || value.care === undefined
          ? 'care=(心跳还没起来)'
          : ('care=' + value.care.reason + (value.care.acted ? '(已开口)' : '') +
             ' 安静×' + value.care.quietStreak + (value.care.nextPollAt > 0 ? '(退避中)' : '') +
             (value.care.writeFailed > 0 ? ' 落账失败×' + value.care.writeFailed : '')),
        // v0.32.0 A0/A1a:兼容面与注入探针(只报数,不做判断)
        'compat=' + (value.compat === null || value.compat === undefined
          ? '(还没探)'
          : (['section', 'context', 'variable'].filter((k) => value.compat[k] === true).join('/') || '无') +
            (value.compat.note !== '' ? ' · ' + value.compat.note : '')),
        'inject=' + (value.inject === null || value.inject === undefined
          ? '(还没量)'
          : (value.inject.occurrences + ' 份/' + value.inject.chars + ' 字' +
             (value.inject.scopes.length > 0 ? ' in ' + value.inject.scopes.join('+') : '') +
             (value.inject.duplicated ? ' ⚠重复' : ''))),
        // v0.32.0 B1:工具审计 —— 「她调了什么」当场可答
        'toolAudit=' + (value.toolAudit === null || value.toolAudit === undefined
          ? '(还没挂)'
          : ('记 ' + value.toolAudit.written + '/' + value.toolAudit.seen +
             ' 射程外' + value.toolAudit.skippedScope + ' 自家' + value.toolAudit.ownSkipped +
             ' 电源关' + value.toolAudit.skippedPower +
             (value.toolAudit.failed > 0 ? ' ⚠失败×' + value.toolAudit.failed : '') +
             ' · ' + Object.keys(value.toolAudit.byName).slice(0, 5).join(','))),
        // v0.35.0 B4:反思那一趟 —— 「她今天反思跑了吗、多久、成没成」当场可答
        'reflect=' + (value.reflect === null || value.reflect === undefined
          ? '(还没跑)'
          : ('跑 ' + value.reflect.runs + ' 趟/失败 ' + value.reflect.fails
             + (value.reflect.lastMs === null ? '' : ' · 上次 ' + (value.reflect.lastMs / 1000).toFixed(1) + 's')
             + (value.reflect.lastOk === false ? ' ⚠上次失败' : '')
             + (value.reflect.busySkipped > 0 ? ' · 忙时排队 ' + value.reflect.busySkipped : '')
             + (value.reflect.noAgentSkipped > 0 ? ' · 缺 parent 跳过 ' + value.reflect.noAgentSkipped : '')))
      ].join('\n') }]
    },
    execute: async () => statusPayload()
  }
}

/**
 * echo_* 记忆工具族(M3-b):remember / forget / memory。
 * 独立导出同 echo_status —— 装机后用宿主树 dsh-tools 对真实定义跑
 * defineTool,schema 非法在装机阶段就能抓住。
 *
 * 软禁用纪律:引擎不在 python 态 → 诚实回报不硬撑。基线(M1 冻结)
 * 没有这组特性,假装能用比承认不能用更糟;休眠 = 不记忆(电源闸
 * 语义:不注入不记录,教也白教)。
 */
function softOffReason (reason) {
  switch (reason) {
    case 'asleep': return '她在休眠(不注入不记录),先在面板唤醒她'
    case 'baseline': return '记忆引擎在 JS 基线态,这组工具要 Python 全引擎'
    case 'offline': return '记忆库离线'
    case 'engine-busy': return '引擎这会儿没应答(模糊失败按跳过处理),稍后再试'
    case 'too-broad': return '匹配太宽,说具体点再忘'
    default: return String(reason || '不可用')
  }
}

function memoryToolGate () {
  if (!readEnabled()) return 'asleep'
  if (store === null || engine === null) return 'offline'
  if (engineState().mode !== 'python') return 'baseline'
  return null
}

/**
 * 她用自己的手说了句话 ⇒ 记一行。
 *
 * @param {string} label       `(用 QQ 说)正文前 60 字`
 * @param {string} toolCall    工具名
 * @param {string} [sessionId] ★ 2026-10-18 新增（第三个参数）
 *
 * ★ 为什么补这个参数：`echo_qq_say` 那批审计的 `session_id` 全是
 *   **`'global'`**（`writeAudit` 的默认值），因为这里原来只传了 2 个参数。
 *   而 `turnTraceResolver` 是**按 sid 查**的 ⇒ `turnTrace.of('global')` 是空
 *   ⇒ 这一行永远归不到某一轮里（实测填充率 0%，是缺失那 38% 的大头）。
 */
function auditToolCall (label, toolCall, sessionId = '') {
  try {
    const prev = store.getState()
    store.writeAudit({
      traceId: randomUUID(),
      // ★ 只有真的给了 sid 才写 —— 空串会退回 `GLOBAL_SESSION`（系统事件的老行为）
      ...(String(sessionId ?? '') === '' ? {} : { sessionId: String(sessionId) }),
      userInput: label,
      injectedMemories: '',
      llmReply: '',
      moodIntensity: prev.moodIntensity,
      prevMoodIntensity: prev.moodIntensity,
      emotionVector: prev.emotionVector ?? {},
      toolCall
    })
  } catch (err) {
    ctxLogger?.warn?.('echo: tool audit failed — ' + String(err?.message ?? err))
  }
}

export function memoryToolDefinitions() {
  return [
    {
      name: 'echo_remember',
      description: '把用户亲口要求记住的事写进 Echo 的长期记忆(用户明确说「记住这个」时用)。core=true 存为核心记忆(每轮都在她心里);同一件事的更新填同一个 slot,会换代而不是叠加成两条矛盾记忆。',
      parameters: {
        text: { type: 'string', description: '要记住的事实,一句话说清', required: true },
        slot: { type: 'string', description: '可选:同一件事的稳定槽位名,更新时填同一个' },
        core: { type: 'boolean', description: '可选:true = 核心记忆(每轮都在)' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            reason: { type: 'string' },
            memoryId: { type: 'number' },
            layer: { type: 'string' },
            i: { type: 'number' },
            keywords: { type: 'array', items: { type: 'string' } }
          }
        },
        render: (args, value) => [{ type: 'text', text: value.ok
          ? '记住了:«' + String(args.text || '').slice(0, 60) + '»'
            + (value.layer === 'L0' ? '(核心)' : '')
            + ' I=' + String(value.i) + ' 关键词=' + (value.keywords || []).join(',')
          : '没记住:' + softOffReason(value.reason) }]
      },
      execute: async (args) => {
        const gate = memoryToolGate()
        if (gate !== null) return { ok: false, reason: gate }
        const text = String(args?.text || '').trim().slice(0, 300)
        if (text.length < 2) return { ok: false, reason: 'text 太短,不算一件事' }
        const r = await engine.memoryAdd(MASTER_ID, text, {
          slot: String(args?.slot || '').trim().slice(0, 64),
          layer: args?.core === true ? 'L0' : 'L2'
        })
        if (r === null) return { ok: false, reason: 'engine-busy' }
        auditToolCall('(直教记忆)' + text.slice(0, 60), 'echo_remember')
        return { ok: true, memoryId: r.memoryId, layer: r.layer, i: r.I, keywords: r.keywords || [] }
      }
    },
    {
      name: 'echo_forget',
      description: '按主题抹掉 Echo 的记忆(用户明确说「忘掉这个」时用)。query 是要忘的主题;匹配超过 10 条会拒绝,要求说得更具体。忘掉的是「她想不起」,行留档不销毁(审计可查)。',
      parameters: {
        query: { type: 'string', description: '要忘掉的主题,说具体点', required: true }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            reason: { type: 'string' },
            matched: { type: 'number' },
            forgotten: { type: 'array', items: { type: 'object', additionalProperties: true } },
            count: { type: 'number' }
          }
        },
        render: (args, value) => [{ type: 'text', text: value.ok
          ? (value.count > 0
            ? '忘掉了 ' + String(value.count) + ' 条:' +
              (value.forgotten || []).map((f) => '«' + String(f.summary || '').slice(0, 40) + '»').join('、')
            : '她想了想,没有跟「' + String(args.query || '') + '」对得上的记忆')
          : softOffReason(value.reason) + (value.matched ? '(匹配到 ' + String(value.matched) + ' 条)' : '') }]
      },
      execute: async (args) => {
        const gate = memoryToolGate()
        if (gate !== null) return { ok: false, reason: gate }
        const query = String(args?.query || '').trim().slice(0, 120)
        if (query.length < 2) return { ok: false, reason: 'query 太短,她不知道要忘什么' }
        const r = await engine.memoryForget(MASTER_ID, query)
        if (r === null) return { ok: false, reason: 'engine-busy' }
        if (r.ok !== true) return { ok: false, reason: 'too-broad', matched: r.matched || 0 }
        auditToolCall('(要求遗忘)' + query, 'echo_forget')
        return { ok: true, forgotten: r.forgotten || [], count: (r.forgotten || []).length }
      }
    },
    {
      name: 'echo_memory',
      description: '主动翻 Echo 的长期记忆查一件事(用户问「你还记得…吗」、或自动注入没覆盖到时用)。query 是查询词;翻到就是想起(记忆会因此更牢)。',
      parameters: {
        query: { type: 'string', description: '查询词,比如「面试」「校园跑」', required: true },
        topK: { type: 'number', description: '可选:最多翻几条,默认 6' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            reason: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  summary: { type: 'string' },
                  layer: { type: 'string' },
                  ageDays: { type: 'number' },
                  hits: { type: 'number' }
                }
              }
            }
          }
        },
        render: (args, value) => [{ type: 'text', text: !value.ok
          ? softOffReason(value.reason)
          : ((value.items || []).length === 0
            ? '她想了想,没想起跟「' + String(args.query || '') + '」相关的'
            : '她想起了 ' + String((value.items || []).length) + ' 条:' +
              (value.items || []).map((it) =>
                (it.layer === 'L0' ? '[核心]' : '') + '«' + String(it.summary || '').slice(0, 50) + '»'
              ).join('、')) }]
      },
      execute: async (args) => {
        const gate = memoryToolGate()
        if (gate !== null) return { ok: false, reason: gate }
        const query = String(args?.query || '').trim().slice(0, 120)
        if (query.length < 2) return { ok: false, reason: 'query 太短,没法翻' }
        const topK = Math.min(12, Math.max(1, Number(args?.topK) || 6))
        const r = await engine.memorySearch(MASTER_ID, query, topK)
        if (r === null) return { ok: false, reason: 'engine-busy' }
        return {
          ok: true,
          items: (r.items || []).map((it) => ({
            summary: it.summary, layer: it.layer,
            ageDays: it.ageDays, hits: it.hits
          }))
        }
      }
    },
    {
      name: 'echo_threads',
      description: 'Echo 的悬置话题(她惦记着、还没结掉的事)。action=list 看全部;action=done 用关键词结掉一条(比如「面试」);action=add 手工登记一条 —— 注意手工加的**不带时间,不会被主动提起**,只是留个记录。',
      parameters: {
        action: { type: 'string', description: 'list(默认)/ done / add', enum: ['list', 'done', 'add'] },
        query: { type: 'string', description: 'action=done 时的关键词,比如「面试」' },
        content: { type: 'string', description: 'action=add 时的内容' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            reason: { type: 'string' },
            action: { type: 'string' },
            threadId: { type: 'number' },
            created: { type: 'boolean' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  threadId: { type: 'number' },
                  content: { type: 'string' },
                  due: { type: 'number' },
                  scheduled: { type: 'boolean' },
                  createdAt: { type: 'number' }
                }
              }
            }
          }
        },
        render: (args, value) => {
          if (!value.ok) return [{ type: 'text', text: softOffReason(value.reason) }]
          const act = String(value.action || '')
          if (act === 'done') {
            return [{ type: 'text', text: value.threadId
              ? '结掉了悬置话题 #' + String(value.threadId) + '(「' + String(args?.query || '') + '」),不会再被跟进。'
              : '没找到与「' + String(args?.query || '') + '」匹配的悬置话题。' }]
          }
          if (act === 'add') {
            return [{ type: 'text', text: value.threadId
              ? '登记了悬置话题 #' + String(value.threadId) + '。手工加的不带时间,不会被主动提起。'
              : '内容为空,没有登记。' }]
          }
          const items = value.items || []
          return [{ type: 'text', text: items.length === 0
            ? '目前没有悬置话题。'
            : '悬置话题 ' + String(items.length) + ' 条:' + items.map((it) =>
              '#' + String(it.threadId) + ' «' + String(it.content || '').slice(0, 40) + '»'
              + (it.scheduled ? '(已约时间)' : '(不定时)')).join('、') }]
        }
      },
      execute: async (args) => {
        const gate = memoryToolGate()
        if (gate !== null) return { ok: false, reason: gate }
        const action = String(args?.action || 'list').trim().toLowerCase()
        if (action === 'done' || action === 'close') {
          const query = String(args?.query || '').trim().slice(0, 120)
          if (query.length < 2) return { ok: false, reason: 'query 太短,没法匹配' }
          const r = await engine.threadsDone(query)
          if (r === null) return { ok: false, reason: 'engine-busy' }
          const tid = Number(r.threadId) || 0
          auditToolCall('(结掉话题)' + query, 'echo_threads')
          return { ok: true, action: 'done', threadId: tid }
        }
        if (action === 'add') {
          const content = String(args?.content || '').trim().slice(0, 300)
          if (content.length < 2) return { ok: false, reason: 'content 太短,不算一件事' }
          const r = await engine.threadsAdd(content)
          if (r === null) return { ok: false, reason: 'engine-busy' }
          auditToolCall('(登记话题)' + content.slice(0, 60), 'echo_threads')
          return {
            ok: true, action: 'add',
            threadId: Number(r.threadId) || 0, created: r.created === true
          }
        }
        // list:走面板同一条帧(纯读;engine.threadsList 已转 camelCase)
        const r = await engine.threadsList()
        if (r === null) return { ok: false, reason: 'engine-busy' }
        return {
          ok: true,
          action: 'list',
          items: (r.items || []).map((it) => ({
            threadId: it.threadId,
            content: it.content,
            due: it.followUpAfter,
            scheduled: it.followUpAfter > 0,
            createdAt: it.createdAt
          }))
        }
      }
    },
    {
      name: 'echo_memory_clear',
      description: '⚠️ 不可逆:清空 Echo 的情景记忆与画像(A 的 /mem_clear 语义),图谱/悬置话题/审计/日记不动。只在用户**明确要求**「清空记忆/重新认识一下」时使用,且必须带 confirm=true;调用前先跟用户确认一遍要清的是什么。',
      parameters: {
        confirm: { type: 'boolean', description: '必须为 true 才会执行 —— 这是不可逆操作的二次确认' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            reason: { type: 'string' },
            episodic: { type: 'number' },
            profile: { type: 'number' }
          }
        },
        render: (args, value) => [{ type: 'text', text: value.ok
          ? '已彻底清空:情景记忆 ' + String(value.episodic) + ' 条、画像 ' + String(value.profile) + ' 项。我们重新认识一下吧。'
          : softOffReason(value.reason) }]
      },
      execute: async (args) => {
        const gate = memoryToolGate()
        if (gate !== null) return { ok: false, reason: gate }
        // 二次确认在工具层就挡住 —— 模型手滑(或用户只是抱怨「你根本不记得我」)
        // 时不能把她的记忆抹了。
        if (args?.confirm !== true) {
          return { ok: false, reason: 'needs-confirm: 这是不可逆操作,确认后请带 confirm=true 再调一次' }
        }
        // (v0.29.0:A 侧的 include_members「连群友隔离空间一起清」随群聊
        // 退役 —— 单用户形态下它本来就是同一次清理,参数删掉。)
        const r = await engine.memoryClear()
        if (r === null) return { ok: false, reason: 'engine-busy' }
        auditToolCall('(整库清空)', 'echo_memory_clear')
        return {
          ok: true,
          episodic: Number(r.episodic) || 0,
          profile: Number(r.profile) || 0
        }
      }
    }
  ]
}

export function apply(ctx, pluginConfig) {
  const tools = ctx.get('tools')
  const systemPrompt = ctx.get('systemPrompt')
  // v0.32.0 A0:宿主兼容闸 —— 只探一次、缓存;缺挂点就退回旧做法并留一行 info
  // (退回是**设计好的路径**,不是故障,所以不用 warn)。
  const compat = createCompat({ logger: ctx.logger })
  hostCapsState = compat.check(systemPrompt)
  // v0.32.0 A1a:注入探针 —— 只测量"我们注入的块在最终提示里出现几份"。
  // 先量再搬:上一次"快照当 user 消息 append"的做法在真实会话里累积成 62 条重复块
  // (lib/index.js 下面 1340 起的现场记录),这次不靠推断。
  const injectProbe = createInjectProbe()
// v0.40.0:先记一份"已加载、还没有读数"—— 状态面从此分得清
// 「探针没加载(要重启)」与「还没组装过(等一次真对话)」这两种红。
injectProbeState = injectProbe.loaded()
  let probeSections = { sid: '', marker: '', texts: [] }
  const webServer = ctx.get('webServer')
  if (tools === undefined || systemPrompt === undefined || webServer === undefined) {
    ctx.logger.warn('echo: inactive — required services unavailable (tools/systemPrompt/webServer)')
    return
  }
  const subagents = ctx.get('subagents')
  // ---- 2026-10-05 方案 C:反思类调用的直调通道(零子代理会话)----
  // 背景与证据见 lib/llm-channel.js 头部;`getSettings` 用惰性箭头 —— `readSettings`
  // 在本文件更靠下的位置定义,真正调用发生在运行时(与 readEnabled 同款写法)。
  const llm = ctx.get('llm')
  const llmChannel = createLlmChannel({
    llm,
    getSettings: () => { try { return readSettings() } catch { return {} } },
    log: ctx.logger
  })
  /**
   * 会话 → 最近一次请求的 route(provider/model)。由 `session/event` 的
   * `request/header` 写,键是会话 id(与 capture.sessionId 同一个取法)。
   */
  const sessionRoutes = new Map()
  /**
   * 反思运输口(2026-10-06 方案 C + B;决议在 lib/reflect-route.js):
   *   ① 面板配了 llmProvider+llmModel ⇒ 直调用它(**覆盖项**);
   *   ② 没配 ⇒ **继承本会话 route**(request/header 里那条);
   *   ③ 两者都没有 / 直调关了 / 宿主没有 llm 服务 ⇒ **明确退回子代理**,
   *      并把原因回给调用方写进 `reflectStats.lastNote`(面板看得见,**不许静默**)。
   *
   * 诊断现场:旧版按 `llmChannel.available()`(只看服务在不在)选路 ⇒ 没配
   * provider/model 时**直调照走、原地跳过、子代理退路一次都没接上** ⇒ 35 小时
   * 零记忆而状态面只有一句「⚠上次失败」。
   */
  const reflectTransport = (sid) => {
    let settings = {}
    try { settings = readSettings() || {} } catch { settings = {} }
    const choice = chooseReflectTransport({
      settings,
      sessionRoute: sessionRoutes.get(String(sid || '')) || null,
      llmAvailable: llmChannel.available(),
      subagentsAvailable: subagents !== undefined && subagents !== null
    })
    if (choice.mode === 'llm') {
      return {
        transport: {
          mode: 'llm',
          structured: (args) => llmChannel.runStructured({
            // reflect.js 今天把 system+user 拼成一份 prompt(与子代理通道逐位相同),
            // 所以这里原样放进 user,system 留空 —— 不制造第二种提示词形状。
            system: '',
            user: String((args && args.prompt) || ''),
            schema: (args && args.schema) || undefined,
            label: (args && args.label) || 'echo-llm',
            signal: (args && args.signal) || undefined,
            sessionId: (args && args.sessionId) || '',
            // 2026-10-06 C:route 由决议给(面板覆盖 / 继承本会话),通道不再自己猜
            provider: choice.route.provider,
            model: choice.route.model,
            // ★★ 2026-10-21：**反思走后台池**（`bulk`）。
            //
            //   反思是**轮末纯增益**（墙钟 21 秒），却和组装前的情绪打分 / 查询扩展
            //   共用一条全局闸。现场：反思 #2/#3 串成一条线横跨到下一轮开口
            //   （21:29:16 → 21:29:37，而轮 3 于 21:29:23.98 已起跑），
            //   下一轮的心情与扩展全程排在它后面、一起到期作废。
            //
            //   ⚠️ **只改这一处**。`llmRunFor` 里那处（`label: 'echo-same-turn'`）
            //   是组装前、有截止期、要进这一轮回复的 —— 它必须留在 live 池上。
            //   那一处改错了，这一刀就整个反了。
            pool: 'bulk'
          })
        },
        note: choice.note
      }
    }
    return {
      transport: choice.mode === 'subagents' ? subagents : undefined,
      note: choice.note
    }
  }
  /**
   * ★ 2026-10-08:小任务(情绪同轮打分 / 查询扩展)的**直调**通道。
   *
   * 以前它们注入 `runStructured(subagents, …)` ⇒ 每个小任务起一次**子代理会话**
   * (宿主契约要 `request.parent.session` 建目录) ⇒ 每轮两次小调用 = 两个子代理会话。
   * 方案 C 的直调通道(`llmChannel`)早就造好、反思那条路也在用 ⇒ 这里改走它。
   *
   * **与反思同源**:route 决议复用同一个纯函数(`chooseReflectTransport`)、同一张
   * `sessionRoutes` 表 ⇒ 面板覆盖 / 本会话继承 / 直调开关,三处口径只有一个。
   * 拿不到 llm 通道 / 没配 provider·model / 直调被关 ⇒ 返回 null ⇒ 那两个门面
   * 各自照常降级(本轮延续旧向量 / 少一点召回),**绝不抛**。
   *
   * 入参是**agent 句柄**(`begin(sid, { parent: agent })` 一路带下来 —— 见
   * `lib/emotion-score.js:184` 与 `lib/query-expand.js:109` 的 `run(…, parent)`),
   * 所以这里自己从 `agent.session.id` 反推 sid,两个模块一个字都不用改。
   */
  const llmRunFor = (agent) => {
    const sid = String((agent && agent.session && agent.session.id) || '')
    return (prompt, schema) => {
      let settings = {}
      try { settings = readSettings() || {} } catch { settings = {} }
      const choice = chooseReflectTransport({
        settings,
        sessionRoute: sid === '' ? null : (sessionRoutes.get(sid) || null),
        llmAvailable: llmChannel.available(),
        subagentsAvailable: subagents !== undefined && subagents !== null
      })
      if (choice.mode !== 'llm') return null
      return llmChannel.runStructured({
        // 与反思那条路同款:prompt 原样放 user、system 留空(不制造第二种提示词形状)
        system: '',
        user: String(prompt || ''),
        schema: schema || undefined,
        label: 'echo-same-turn',
        sessionId: sid,
        provider: choice.route.provider,
        model: choice.route.model
      })
    }
  }
  // 她的眼睛(2026-09-26):图要进上下文,得先经宿主的附件服务落成不可变
  // 字节(`ImageBlock.attachment`)。服务缺失只是「看图」降级,不致命 ——
  // 所以这里不放进 required 那三个里。
  const attachments = ctx.get('attachments')
  // sessions 服务 M2-d 起不再直用(pre-step 拿 agent.session);保留
  // inject 声明 —— M3 心跳层要靠它定位会话投递主动消息。

  // ---- 数据目录 + 人格预热(异步,不阻塞挂载) ----
  // 构建指纹进日志:重启前后各一行对比,就知道这次改动到底加载上没有
  // (宿主 HMR 不重载插件模块 —— 不重启 dsh web 的话,改完 lib 也白改)。
  ctx.logger.info('echo: build ' + BUILD.short + ' (' + BUILD.files + ' lib files, v' + VERSION + ')')
  // P1a:`ensureDataDir` 先建目录与 8 个空模板(缺才建,存在只校验,**绝不改写**),
  // 然后 loadPersona 照旧读它自己那份 —— 顺序与行为都不变。
  // dir 从 resolveDataDir() **现取**(不是 import 时定死的 DATA_DIR):设了
  // ECHO_DATA_DIR 时,脚手架与 persona / toggle / DB 三条路径会一起搬过去,不分裂。
  ensureDataDir({ dir: resolveDataDir(), logger: ctx.logger }).then((r) => {
    ctx.logger.info('echo: ' + describeEnsureResult(r))
    for (const f of r.failed) {
      ctx.logger.warn('echo: 数据目录异常 ' + f.file + ' (' + f.action + '):' + f.reason)
    }
    // P3:一次性迁移(默认 T1 = 挂载时自动;新装用户没有别的入口)。永不抛错,
    // 失败项在 notes/返回值里,不阻断挂载 —— 详见 lib/data-migrate.js 文件头。
    migrateDataDir({ dir: resolveDataDir(), logger: ctx.logger })
    return loadPersona()
  }).then((p) => {
    personaCache = p
    lastLoadAt = new Date().toISOString()
  }).catch((err) => {
    ctx.logger.warn('echo: persona preload failed, using defaults: ' + String(err?.message ?? err))
  })

  // ---- 记忆库(fail-soft:打不开只降级记忆,人格照常) ----
  try {
    // v0.14.5 S10:审计保留条数走配置(A 侧 200,本仓定案 100);
    // 配置读坏了就回落 100(store 侧还会再钳一次下界 20)。
    let auditKeep = 100
    try { auditKeep = readSettings().auditKeep } catch { auditKeep = 100 }
    store = openStore(DB_PATH, { auditKeep })
    ctx.logger.info('echo: memory store online at ' + DB_PATH + ' (audit keep ' + auditKeep + ')')
  } catch (err) {
    store = null
    ctx.logger.warn('echo: memory store offline — ' + String(err?.message ?? err))
  }

  // ---- 引擎门面(M2-d):Python sidecar 在→全引擎;不在→JS 基线 ----
  // 初始化异步不阻塞挂载:探测+spawn+握手约一两秒,期间检索走基线
  // (mode 初始值就是 baseline,init 成功后才切 python)。
  // RT9:检索账本 —— 环形缓冲留最近 50 问(只记不判;真机漏召回样本靠它捡)。
  // ⚠️ 它**必须**在 createEngine 之前初始化:2026-09-28 夜我把 `ledger:` 传进去、
  // 而 const 声明留在后面 ⇒ **加载即炸**(TDZ: Cannot access 'retrievalLedger'
  // before initialization),整个 dsh web 起不来 —— node --check 与单测都看不见,
  // 只有真加载才炸。先声明、后使用,这条不许再犯。
  const retrievalLedger = createRetrieveLedger({})
  retrieveLedgerState = () => retrievalLedger.stats()
  engine = createEngine({
    // RT9:检索账本(engine 每检索一问推一条;它自己吞掉任何异常)
    ledger: retrievalLedger,
    // Invoked only at retrieve start, never when its asynchronous audit settles.
    auditTraceOf: (sid) => { try { return turnTrace.of(sid) || '' } catch { return '' } },
    logger: ctx.logger,
    dbPath: DB_PATH,
    store,
    // v0.37.0 G2:他改了称呼 ⇒ 把**旧名**记进调参的 retiredAliases。
    // 为什么非记不可:记忆的摘要是很久以前写的,里面全是旧称呼;
    // 不记下来,她下一轮就会一边看着新称呼、一边从记忆里把旧名贴回他脸上。
    onNameChange: (oldName, newName) => {
      try {
        const list = splitAliases(readSettings().retiredAliases)
        if (!list.includes(oldName)) {
          writeSettings({ retiredAliases: [...list, oldName].join(',') })
          ctx.logger.info('echo: 改名 ' + oldName + ' → ' + newName
            + ' ⇒ 旧名记入 retiredAliases(注入时按现在的称呼改写记忆里的旧名)')
        }
      } catch (err) {
        ctx.logger.warn('echo: 旧名没记下来(改名本身没受影响)— ' + String(err?.message ?? err))
      }
    }
  })
  engine.init().catch((err) => {
    ctx.logger.warn('echo: engine init failed — ' + String(err?.message ?? err))
  })

  // ---- 0.9 传话桥(R2,v0.17.0):平台当嘴,DSH 当脑 ----
  // 四个接线点都靠「壳注入」,桥本身不 import 宿主包(可离线测):
  //   ①会话解析 → 宿主的 sessionController(与 GUI 建会话同一条路:
  //     模型选择、预设、工作目录一次到位,不用自己复刻组合逻辑)
  //   ②注入     → agent.runMaintenance(() => followup(...)),与心跳
  //     同一把锁:她忙就拿不到锁,退回 503 让适配器重试(不丢消息,
  //     也不把消息插进她正在跑的那一轮里)
  //   ③权限闸   → permissionPresets.set(只读起步);名字不在本部署的
  //     预设表里就只记日志,不硬套
  //   ④出站捕获 → 现有 session/event 流(assistant/message 攒碎片,
  //     turn/end 合成一条入队)
  const relayCfg = () => {
    const settings = readSettings()
    return { ...settings.relay, bubble: settings.bubble }
  }
  /**
   * **入站那道门:她有没有嘴**。
   *
   * 旧写法(已退役)= `mouthOpen()`,即"旧桥总闸开着 + token 非空" —— 那是
   * AstrBot 时代的门。2026-09-28 旧桥完整退役后,门**只剩一个判据**:
   * 「有渠道插件自报家门」(`speaker.hasRegisteredChannels()`)。
   *
   * 为什么这样更好:以前是两套总闸(桥的总闸 + 插件的总闸)互相打架,
   * 现在**嘴在不在由嘴自己说** —— 插件关着就不注册 ⇒ 门关 ⇒ `relay.js` 的
   * `gate()` 回 409 `scope-off`(fail-closed,没人注册 = 一律拒收)。
   *
   * **不许写成 `speaker.hasChannel()`**:那条路会经 transport.status() 回到
   * `gate()` 自己(无限递归,见 lib/speak.js 的 hasRegisteredChannels 注释)。
   */
  const mouthOpen = () => {
    try {
      return speaker !== null && speaker.hasRegisteredChannels()
    } catch { return false }
  }
  /** 陪伴会话的工作目录:默认数据目录下的 workspace(别拿他的项目当默认落脚点)。 */
  const companionCwd = () => {
    const raw = String(relayCfg().cwd || '').trim()
    return raw !== '' ? raw : join(DATA_DIR, 'workspace')
  }
  /**
   * 找/建/续那**一个**陪伴会话(D1:全平台全场合共用)。
   * 优先走 sessionController.create({sessionId,cwd}) —— 它自带
   * 「活的就返回、存档里的就 resume、全新的就 create」与预设组合;
   * 服务不在(非 web profile)就明确失败,由桥回 503,而不是悄悄
   * 建一个没有模型路由的空会话。
   */
  /**
   * 宿主的**归档集** —— 归档的会话在网页界面上一处都看不见(工作区列表、侧栏、
   * 顶栏标签全被过滤掉)。
   *
   * 为什么必须由插件自己看:2026-10-01 现场 —— 兜底会话
   * `session-echo-companion` 被归档之后,**重启 + 第一条 QQ 消息会静默落进它**,
   * 他在网页上再也找不到那次对话(`ensureCompanion` 只问 `ctx.agents.get`,
   * 从不问归档集 ⇒ 于是"挑不出来"时永远挑到一条他看不见的会话)。
   *
   * 读不到/文件坏了 ⇒ 返回 `null`(**诚实说"不知道"**)。**不返回空集** ——
   * 空集会让"已归档"判定永远为假,那个坑会静默复发。
   * @returns {Set<string>|null}
   */
  function workspaceStatePath () {
    return join(dirname(DATA_DIR), 'storages', 'workspace.json')
  }
  function archivedSessionIds () {
    return readWorkspaceState(workspaceStatePath(), readFileSync).archived
  }
  /**
   * 工作区里**登记过**的会话 id(候选"看得见的"会话)。读不到 ⇒ 空数组。
   * 形状(2026-10-01 实测):`{ global: {...}, tables: { workspaces: { <id>: { sessionIds: [...] } } } }`。
   * @returns {string[]}
   */
  function workspaceSessionIds () {
    return readWorkspaceState(workspaceStatePath(), readFileSync).sessionIds
  }
  /**
   * 兜底会话不可见时另挑一条**看得见**的:先他正在用的那条,再"工作区里登记过且
   * 未归档"的里挑**他最后说话最晚**的(账本 = `conversation_log`,与
   * `hisActiveSession` 同源)。挑不出来 ⇒ `null`(调用方必须**明确失败**,不许静默)。
   * @returns {string|null}
   */
  function pickVisibleCompanion (badSid, arch) {
    let his = null
    try { his = hisActiveSession() } catch { his = null }
    return pickVisibleSession({
      sessionIds: workspaceSessionIds(),
      archived: arch,
      exclude: badSid,
      preferred: his === null ? null : his.sessionId,
      lastTurnAt: (sid) => (typeof store?.recentUserTurnAt === 'function' ? store.recentUserTurnAt(sid, 0) : 0)
    })
  }
  /**
   * 拿/建/续**指定**会话(实体部分;`ensureCompanion` 只负责"选哪条")。
   */
  async function ensureCompanionFor (sid) {
    const live = ctx.agents?.get?.(sid)
    if (live !== undefined && live !== null) {
      autoScope(sid)
      return { agent: live, sessionId: sid }
    }
    const sc = ctx.get('sessionController')
    if (sc === undefined || typeof sc.create !== 'function') {
      throw new Error('sessionController 不可用(陪伴会话建不起来)')
    }
    const cwd = companionCwd()
    try { await mkdir(cwd, { recursive: true }) } catch { /* 目录建不了让 create 自己报 */ }
    await sc.create({ sessionId: sid, cwd })
    const agent = ctx.agents?.get?.(sid)
    if (agent === undefined || agent === null) throw new Error('会话建好了但拿不到 agent')
    autoScope(sid)
    return { agent, sessionId: sid }
  }
  /**
   * 兜底会话(可被归档闸拦下;2026-10-01 尾加的那道闸)。
   *
   * 语义澄清(他本人裁定):**常驻 = 兜底**,不抢"跟着他走"那条 ——
   * `followHisWindow` 开着时,QQ 仍然优先落进他正在用的窗口,这条只在挑不出来时用。
   *
   * 闸:兜底目标**已归档/网页里看不见** ⇒ **绝不静默往里写**(那正是"第一次重启后
   * 的消息再也找不到"的成因),改挑一条可见的;挑不出来就**明确失败**(桥回 503),
   * 让他看得见"这事需要他点一下「设为 QQ 常驻」"。
   */
  async function ensureCompanion () {
    const sid = String(relayCfg().sessionId || DEFAULT_COMPANION_ID)
    const arch = archivedSessionIds()
    if (arch !== null && arch.has(sid)) {
      ctx.logger.warn('echo: QQ 兜底会话已归档(网页里看不见),拒绝往它写 — ' + sid)
      const alt = pickVisibleCompanion(sid, arch)
      if (alt === null) {
        throw new Error('QQ 兜底会话已归档,且找不到别的可见会话 — ' + sid
          + '(请在网页会话头点「设为 QQ 常驻」换一条)')
      }
      ctx.logger.info('echo: QQ 兜底临时改用可见会话 — ' + alt)
      return ensureCompanionFor(alt)
    }
    return ensureCompanionFor(sid)
  }
  /**
   * `/api/echo/qq-pin` 的状态(页面按钮与诊断共用一份事实 —— 不许两处各算一次)。
   * @returns {object}
   */
  function qqPinState () {
    let s = null
    try { s = readSettings() } catch { s = null }
    const sid = String(s?.relay?.sessionId || DEFAULT_COMPANION_ID)
    const arch = archivedSessionIds()
    return {
      sessionId: sid,
      default: DEFAULT_COMPANION_ID,
      followHisWindow: s?.relay?.followHisWindow !== false,
      archived: arch === null ? null : Array.from(arch),
      pinnedArchived: arch === null ? null : arch.has(sid),
      candidates: workspaceSessionIds().slice(0, 50),
      note: '常驻 = 兜底:QQ 优先跟着他正在用的窗口走;挑不出来才落这条(单值 ⇒ 只能设一个)。'
    }
  }
  /**
   * 「他正在用的那条会话」(2026-09-29 他裁定 A:QQ 跟着他走)。
   *
   * 现场:他在 DSH 里开着窗口 A 跟她说话,QQ 的消息却进了插件自建的
   * `session-echo-companion` ⇒ 她的回复出现在"隔壁窗口"。裁定 A = QQ 进
   * 他正在用的那条;挑不出来的才退回陪伴会话。
   *
   * 挑选本身是纯函数(`lib/companion-target.js` 的 `pickHisSession`),这里
   * 只负责喂真数据:宿主 `ctx.agents.roots()` 拿活着的会话,范围闸用
   * `sessionEnabled`(面板上被他关掉的不算),"他最后说话"用
   * `store.recentUserTurnAt`(账本 = `conversation_log`:每真轮一行;
   * ⚠️ 2026-09-29 之前它读审计表,而那个判据在活库**全库 0 命中** ⇒ 恒为 0,
   * 这条路于是永远挑不出窗口 —— 详见 `lib/store.js` 里那段注释)。
   *
   * ⚠️ 只认**活着**的会话:注入要有 agent;也因此这条路**从不新建会话**
   * (窗口是宿主建的,插件不会替你开窗口)。
   */
  const FOLLOW_HIS_WINDOW_SEC = 24 * 3600
  function hisActiveSession () {
    try {
      if (typeof store?.recentUserTurnAt !== 'function') return null
      const since = Date.now() / 1000 - FOLLOW_HIS_WINDOW_SEC
      const roots = (typeof ctx.agents?.roots === 'function') ? ctx.agents.roots() : []
      const candidates = []
      for (const agent of roots) {
        const sid = String(agent?.session?.id || '')
        if (sid === '') continue
        candidates.push({ agent, sessionId: sid, lastUserTurnAt: Number(store.recentUserTurnAt(sid, since)) || 0 })
      }
      const hit = pickHisSession({
        candidates,
        inScope: (sid) => sessionEnabled(sid),
        isTopLevel: (agent) => !isSubagentSession(agent),
        companionId: String(relayCfg().sessionId || DEFAULT_COMPANION_ID),
        since
      })
      return hit
    } catch (err) {
      ctx.logger.warn('echo: 找他正在用的会话失败(退回陪伴会话)— ' + String(err?.message ?? err))
      return null
    }
  }
  /** A 方案的开关(面板可关:关掉 = 永远用固定陪伴会话)。 */
  const followHisWindow = () => {
    try { return relayCfg().followHisWindow !== false } catch { return true }
  }
  /**
   * 收话/开口的目标(入站 QQ 与她主动开口**共用这一个** —— 一条对话线)。
   *   · 开着 `followHisWindow` 且他在用某条会话 ⇒ 那条;
   *   · 否则 ⇒ 固定陪伴会话(`ensureCompanion`:活的用 / 存档 resume / 新建)。
   */
  async function resolveCompanion () {
    if (followHisWindow()) {
      const his = hisActiveSession()
      if (his !== null) return { agent: his.agent, sessionId: his.sessionId, via: 'his-window' }
    }
    const c = await ensureCompanion()
    return { ...c, via: followHisWindow() ? 'companion' : 'fixed' }
  }
  /**
   * 陪伴会话永远在 Echo 的射程内(whitelist 模式下尤其重要 —— 否则
   * 她在 QQ 上会没有人格也没有记忆,而且**静默**如此)。
   *
   * 2026-09-26 现场(他问「我跟你说 Echo 下线,你还在使用 echo 插件」):
   * 这个函数以前只看 `sessionEnabled()` —— 于是**人亲手关掉的会话,会被
   * 下一条入站消息静默打开**(实测现场 exempt 一直是空的,他的「下线」
   * 从没落地)。现在分两层:
   *   · 人显式关过(`isManuallyOff`)→ **绝不自动开**(这是硬开关的底线);
   *   · 其它情况自动开,但**留审计行**(不再静默),面板看得到。
   */
  function autoScope (sid) {
    const s = String(sid || '')
    if (s === '') return
    try {
      if (isManuallyOff(s)) {
        ctx.logger.info('echo: companion session 被人显式关过,autoScope 不覆盖 — ' + s)
        return
      }
      if (!sessionEnabled(s)) {
        setSessionOn(s, true)
        ctx.logger.info('echo: relay companion session added to scope — ' + s)
        try {
          store?.writeAudit({
            traceId: 'auto-scope-' + randomUUID(),
            userInput: '(自动放行)陪伴会话重新纳入范围 ' + s,
            toolCall: 'auto_scope_on'
          })
        } catch { /* 审计尽力而为 */ }
      }
    } catch { /* 范围写不进去只是这一条提示少一层保险 */ }
  }
  /**
   * 注入一封入站信封:'ok' | 'busy'。
   *
   * 2026-09-26:她长了眼睛。图**不再只是文字** ——
   *   ① `collectImages()` 把图抓成字节(url 主路 / path / base64);
   *   ② `ctx.attachments.saveImages()` 存成宿主认的不可变附件,拿到 ref;
   *   ③ content 里排前的是 `{type:'image', attachment}`,文字在后。
   * 图抓不到**不算这一轮失败**:退回纯文字,并在正文里说清「有图没到手」
   * —— 她宁可知道漏了,也不能以为自己看过了(§3.2.1 不静默)。
   */
  // ★ 2026-10-18：忙时入站队列（上限活读配置，越界夹回 1~200）
  const inboundQueue = createInboundQueue({
    limit: () => clampQueueLimit(settings?.inboundQueueLimit),
    log: (level, msg, extra) => log(level, msg, extra)
  })
  const forwardReader = createForwardReader({
    serviceOf: () => ctx.get('echo:qq-content'),
    isEnabled: () => readEnabled(),
    sessionEnabledOf: sid => sessionEnabled(sid)
  })
  ctx.effect(() => () => forwardReader.dispose(), 'echo.forward-content()')
  const fileService = createFileService({ channelOf: () => ctx.get('echo:qq-content') })
  const fileReader = createFileReader({
    serviceOf: () => fileService,
    isEnabled: () => readEnabled(),
    sessionEnabledOf: sid => sessionEnabled(sid)
  })
  const receiptPresence = createReceiptPresence({
    isEnabled: () => readEnabled(),
    sessionEnabledOf: sid => sessionEnabled(sid),
    heartbeat: { noteExternalEvent: () => heartbeat.noteExternalEvent() },
    engineOf: () => engine, masterId: MASTER_ID, longingOf: () => readSettings().longing
  })
  ctx.effect(() => () => { fileReader.dispose(); return fileService.close() }, 'echo.file-content()')
  const fileSendAudit = createQQSendAudit({ writeAudit: row => store?.writeAudit(row) })
  let groupSocialLive = true
  const groupParticipation = createGroupParticipation({
    isEnabled: () => groupSocialLive && readEnabled(),
    sessionEnabledOf: sid => sessionEnabled(sid),
    audit: row => auditToolCall('群聊参与选择：' + row.action
      + (row.reason ? '（' + row.reason + '）' : ''), 'group_participation', row.sessionId)
  })
  ctx.effect(() => () => { groupSocialLive = false }, 'echo.group-social()')
  const fileSender = createQQFileSender({
    createArtifacts: options => createQQSendArtifacts(options),
    serviceOf: () => ctx.get('echo:qq-file-send'),
    isEnabled: () => readEnabled(),
    sessionEnabledOf: sid => sessionEnabled(sid),
    participation: input => groupParticipation.fileParticipation(input),
    captureAudit: fileSendAudit.capture,
    audit: fileSendAudit.record
  })
  ctx.effect(() => () => fileSender.dispose(), 'echo.file-send()')
  ctx.effect(() => ctx.on('tools/result', (exec, result) => {
    try { fileSender.observeToolResult(exec, result) } catch { /* 无原生成功证明则不登记 */ }
  }), 'echo.file-send-results()')

  async function injectInboundNow (agent, env, text, execution = {}) {
    const current = () => {
      try { return typeof execution?.isCurrent !== 'function' || execution.isCurrent() === true } catch { return false }
    }
    if (!current()) return 'cancelled'
    let content = [{ type: 'text', text }]
    const supplemental = hasRelayContent(env)
    const imageRefs = [
      ...(Array.isArray(env?.images) ? env.images : []),
      ...(Array.isArray(env?.forwardContent?.images) ? env.forwardContent.images : [])
    ]
    const wanted = imageRefs.length
    if (wanted > 0) {
      // ★★ 2026-10-20：**整段图片处理包进 try**（他报的那个 bug 的根因）。
      //
      //   原来这一段（抓图 / 数表情包 / 选文案 / 落附件库 / 拼 content）在 try
      //   **外面**，而 `injectInboundNow` 外面没有任何兜底 ⇒ 这一段里任何一处抛错
      //   都会冒泡到 `relay.js` 的 catch ⇒ `result = 'error'` ⇒ 503
      //   `agent-unavailable` ⇒ **整条消息被拒**（连带下一条也被拖下水）。
      //
      //   现场证据：`inbound.jsonl` 里 12:25:16（表情包）和 12:25:40（紧跟的文字）
      //   都是 `stage=core-refused / agent-unavailable`，而主包的 `relay_in` 审计里
      //   那两条**完全缺失**（`relay_in` 写在受理判定之后）。
      //
      //   纪律：**图片炸了只该少一张图，不该让这句话消失。** 降级成纯文字注入。
      //   （内层那两个 try/catch 仍然保留 —— 它们有更细的降级语义：
      //     抓取失败记 problem、附件库没有记 problem；这里是再外一层的兜底。）
      try {
        if (env.forwardContent?.images?.length) {
          const prepared = await prepareForwardImages(env, {
            collectImages, saveImageBlocks, describeImages, isStickerImage, attachments
          })
          content = inboundContent(prepared.blocks, text + '\n' + prepared.text)
        } else {
        let got = { images: [], problems: [], bytes: 0 }
        try {
          got = await collectImages(imageRefs, { limits: attachments?.imageLimits })
        } catch (err) {
          got.problems = [{ index: 0, reason: '抓取出错:' + String(err?.message ?? err).slice(0, 60) }]
        }
        // ★ 2026-10-20：**数一下其中几个是表情包** —— `describeImages` 靠它选文案
        //   （普通图："不要逐张描述"；表情包："看情况，给她判断权"）。
        const stickerCount = got.images.filter((im) => isStickerImage(im)).length
        // ★★ 他这条**没写字**（单发图/表情）⇒ 用"单发句式"：图照样进上下文（她能识别），
        //    但正文明说"这条不用回"（她不说法）。判据用**原始 `env.text`**，
        //    不是渲染后的正文 —— 渲染后图片-only 会变成「他发来1张图(没写字)」，永远非空。
        const noReply = String(env?.text ?? '').trim() === '' && !supplemental
        const line = describeImages(got.images.length, got.problems, { stickers: stickerCount, noReply })
        let blocks = []
        try {
          blocks = await saveImageBlocks(attachments, got.images)
        } catch (err) {
          // 附件服务在这套部署里不在/拒收:图到手了也进不了她的上下文 ——
          // 那就说清,并把它当「没抓下来」处理(别装作看见了)。
          const why = String(err?.message ?? err).slice(0, 80)
          got.problems = got.problems.concat(got.images.map(() => ({ index: 0, reason: '存不进附件库:' + why })))
          ctx.logger.warn('echo: 图存不进附件库 — ' + why)
        }
        // 走到这里,「看到几张」的最终结论才算得出来(抓取 + 落库两关都过了)
        //
        // ⚠️ `blocks` 不带身份（`saveImageBlocks` 只回附件引用），所以表情包数只能
        //    夹到"实际进了几张"以内。全部落库成功时它是准的；部分失败时可能把
        //    普通图数成表情包 —— 宁可少说一句描述，也不要对着表情包描述一通。
        const effectiveStickers = Math.min(stickerCount, blocks.length)
        const finalLine = describeImages(blocks.length, got.problems, { stickers: effectiveStickers, noReply })
        content = inboundContent(blocks, finalLine === '' ? text : text + '\n' + finalLine)
        ctx.logger.info('echo: relay inbound images — got=' + blocks.length + '/' + wanted
          + (got.problems.length > 0 ? ' problems=' + got.problems.length : '')
          + (line === '' ? '' : ' (' + line.replace(/\n/g, ' ') + ')'))
        }
      } catch (err) {
        // ★ 兜底：图片这条路整个炸了 ⇒ **降级成纯文字注入**，绝不让这条消息消失。
        const why = String(err?.message ?? err).slice(0, 120)
        content = [{ type: 'text', text }]
        ctx.logger.warn('echo: 图片处理整段炸了，降级成纯文字（这条照样注进去）— ' + why)
        try {
          audit?.('relay_reject', 'image-pipeline-crashed:' + why, String(agent?.session?.id ?? ''))
        } catch { /* 审计尽力而为 */ }
      }
    }
    if (!current()) return 'cancelled'
    try {
      let cancelled = false
      const maintenance = agent.runMaintenance(() => {
        if (!current()) { cancelled = true; return Promise.resolve(false) }
        if (env.forwardContent?.ref) {
          try { forwardReader.bind({ agent, env }) } catch { /* 首段照收，读取权限无法证明则拒绝 */ }
        }
        if (env.files?.some(file => file.ref)) {
          try { fileReader.bind({ agent, env }) } catch { /* 元数据照收，无证明则不读正文 */ }
        }
        const inboundMessage = createUserMessage({
          content,
          source: {
            kind: ECHO_SOURCE_KIND, form: 'relay',
            platform: env.platform, chatId: env.chatId, chatType: env.chatType,
            ...(env.groupContext ? { groupParticipation: true } : {}),
            // 2026-09-26:他打的原话(不带「【QQ·私聊】…说:」这层包装)。
            // pre-step 拿它当记忆检索的查询词;发图没写字时是空串。
            rawText: String(env.text || ''),
            ...(supplemental ? { hasSupplementalContent: true } : {}),
            ...(env.forwardContent?.ref ? { forwardRef: env.forwardContent.ref } : {}),
            ...(env.files?.some(file => file.ref)
              ? { fileRefs: env.files.filter(file => file.ref).map(file => file.ref).slice(0, 2) } : {}),
            ...((env.voices?.length || env.files?.length) ? {
              receiptKinds: [env.voices?.length ? 'voice' : '', env.files?.length ? 'file' : ''].filter(Boolean)
            } : {}),
            // ★ 2026-10-15 加群聊：**这话是不是他说的**。
            //   私聊：白名单过了就是"他"（恒 true）。
            //   群里：只有他本人的号是 true —— 别人的话照收（她要看得见才回得了），
            //   但下面 `capture.userText` 那里**不写** ⇒ 不进会话记录/漂移窗/反思。
            isMaster: env.isMaster === true,
            // 群里说话的人是谁（她得知道"这是谁在说"）；私聊时等于他本人。
            senderId: String(env.senderId || ''),
            senderName: String(env.senderName || '')
          }
        })
        try { fileSender.bind({ agent, message: inboundMessage, env, isCurrent: current }) } catch { /* 无发送证明不影响接收 */ }
        try { groupParticipation.bind({ agent, message: inboundMessage, env, isCurrent: current }) } catch { /* 群场景失去证明时不发送 */ }
        agent.followup(inboundMessage)
        return Promise.resolve(true)
      })
      const ok = Boolean(await maintenance)
      return cancelled ? 'cancelled' : (ok ? 'ok' : 'busy')
    } catch {
      return 'busy' // 维护相被占:她现在真的在忙
    }
  }

/**
 * ★ 2026-10-18：她忙的时候，**这条进队列等下一轮**，而不是回 `busy` 让适配器死等。
 *
 * 现场：journal 实测非主人群消息 **52 条**撞上她忙、重试 6 次（≈22.5 秒）耗尽后**真丢**。
 *
 * 为什么排队是安全的：DSH 的 inbox 本来就能无损接住 ——
 *   `agent.followup` 把消息放进 inbox 的 `next-turn`，turn 收尾时
 *   `dsh-agent-loop/lib/index.js:1035` `if (!this.inbox.hasPending) return false;`
 *   ⇒ **还有待处理消息就自己开下一轮**。
 *   卡住它的从来不是 inbox，是我们在外面套的那道 `runMaintenance` 互斥锁。
 *
 * 但 `inbox` 没有上限 ⇒ 消息先落**我们自己的队列**（`lib/inbound-queue.js`），
 * 一条一条交给 DSH：**上限我们守，消费交给 DSH 保证**。
 *
 * @returns {Promise<'ok'|'queued'|'busy'|'error'>} `queued` = 已受理、在队里等
 */
/**
 * 入站注入的唯一入口。
 *
 * ★ 2026-10-20（第二版）：**图片照常注入，只是明说"不用回"**（他拍的
 * 「她应该能识别表情，但是不做回复」）。
 *
 *   · 图片-only ⇒ **照常注入**（所以她**看得到**），正文里带一句
 *     「他单发了个表情包,这条不用回 —— 你自己心里有数就行」⇒ 她**不说法**。
 *   · 图片 + 文字 ⇒ 正常一起注入，正常回。
 *
 * ⚠️ 第一版做的是「图片-only 只暂存、压根不注入」—— 那是**她根本看不到**，
 *    不叫"识别"，是方向性错误。暂存那条路已经整条撤掉。
 */
async function injectInbound (agent, env, text, execution = {}) {
  const r = await injectInboundNow(agent, env, text, execution)
  if (r !== 'busy') return r
  const res = inboundQueue.push({ agent, env, text, execution })
  log('info', 'echo: 她正忙，这条进队列等下一轮', {
    queued: res.size, limit: res.limit, msgId: String(env?.msgId ?? '')
  })
  // 后台冲刷：单飞、不 await（这一条已"受理"，不用等它真投进去）
  Promise.resolve().then(() => flushInboundQueue()).catch(() => {})
  return 'queued'
}

/** 队列冲刷单飞闸（同时只允许一个冲刷循环，否则会重复投递）。 */
let flushingInbound = false

/**
 * 把队列里的入站一条条投进去。
 *
 * 节奏：`agent.whenIdle()` → 投一条 → 看结果。
 *   · `whenIdle` 是 DSH 的公开 API，**跟着"排队唤醒的工作"一起算**
 *     （`runtime-types.d.ts:169`：「whenIdle() follows both the task and any
 *     waking work released behind it」）⇒ 投完一条它也会等那条处理完，天然串行。
 *   · 投的时候如果**又被抢了**（新消息先到）⇒ 退避 1 秒再试；
 *     连续失败 30 次就丢掉这条并 warn —— **绝不活锁**。
 */
async function flushInboundQueue () {
  if (flushingInbound) return
  flushingInbound = true
  let fails = 0
  try {
    while (inboundQueue.size() > 0) {
      const item = inboundQueue.peek()
      if (item === null) break
      try {
        if (typeof item.agent?.whenIdle === 'function') await item.agent.whenIdle()
      } catch { /* 没有 whenIdle / 它自己炸了 ⇒ 当 idle 直接试 */ }
      let r = 'error'
      try {
        r = await injectInboundNow(item.agent, item.env, item.text, item.execution)
      } catch (err) {
        log('warn', 'echo: 队列投递抛错', { error: String(err?.message ?? err) })
        r = 'error'
      }
      if (r === 'busy') {
        fails += 1
        if (fails > 30) {
          inboundQueue.shift()
          log('warn', 'echo: 队列里这条一直投不进（连续 30 次忙），丢弃', {
            msgId: String(item?.env?.msgId ?? ''), left: inboundQueue.size()
          })
          fails = 0
          continue
        }
        await new Promise((resolve) => { setTimeout(resolve, 1000) })
        continue
      }
      fails = 0
      inboundQueue.shift()
      log('info', 'echo: 队列里的入站已投递', {
        result: r, left: inboundQueue.size(), msgId: String(item?.env?.msgId ?? '')
      })
    }
  } finally {
    flushingInbound = false
  }
}
  /** 权限闸:中继会话按配置降权(默认只读 —— 工具不精简,这是唯一的边界)。 */
  function applyRelayPermission (agent) {
    const want = String(relayCfg().permissionPreset || '').trim()
    if (want === '' || want === 'off') return 'skipped'
    const presets = ctx.get('permissionPresets')
    if (presets === undefined || typeof presets.set !== 'function') return 'unavailable'
    try {
      const sid = String(agent?.session?.id || '')
      if (typeof presets.current === 'function' && presets.current(agent.session) === want) return 'already:' + want
      if (typeof presets.resolve === 'function') presets.resolve(want) // 名字不在本部署的表里会抛
      const note = presets.set(agent.session, want)
      ctx.logger.info('echo: relay session permission → ' + want + ' (' + sid + ')')
      return 'applied:' + want + (note === undefined ? '' : '')
    } catch (err) {
      ctx.logger.warn('echo: relay permission preset "' + want + '" 未生效 — ' + String(err?.message ?? err))
      return 'failed:' + want
    }
  }
  /** 库没打开时桥也要能给出人话的错误(而不是 undefined 崩在适配器脸上)。 */
  const requireStore = () => {
    if (store === null || store === undefined) throw new Error('memory store offline')
    return store
  }
  relay = createRelay({
    store: {
      // store 是 fail-soft 的(可能打不开):桥也要能离线降级
      relayBeginInbound: (...a) => requireStore().relayBeginInbound(...a),
      relayCommitInbound: (...a) => requireStore().relayCommitInbound(...a),
      relayRollbackInbound: (...a) => requireStore().relayRollbackInbound(...a),
      relayUpsertChannel: (...a) => requireStore().relayUpsertChannel(...a),
      relayChannelsOfSession: (...a) => requireStore().relayChannelsOfSession(...a),
      relayEnqueue: (...a) => requireStore().relayEnqueue(...a),
      relayLeaseOutbox: (...a) => requireStore().relayLeaseOutbox(...a),
      relayAckOutbox: (...a) => requireStore().relayAckOutbox(...a),
      relayListChannels: () => requireStore().relayListChannels(),
      relaySetChannel: (...a) => requireStore().relaySetChannel(...a),
      relayQueueStats: (...a) => requireStore().relayQueueStats(...a)
    },
    logger: ctx.logger,
    config: relayCfg,
    // 2026-09-28 旧桥完整退役:门就是"她有一条活的嘴"(渠道插件自报家门)。
    // 没插件注册 ⇒ 门关 ⇒ 入站回 409 scope-off(fail-closed,不是"老行为不变")。
    isEnabled: mouthOpen,
    // 2026-10-07:入站-only 的渠道(语音输入)**不记来路** —— 她的回复留本地,
    // 不该被送回一个只会收的渠道。判据见 speak.js 的 channelCanSend()。
    channelCanSend: (platform) => {
      try { return speaker !== null && speaker.channelCanSend(platform) !== false } catch { return true }
    },
    // 2026-09-29 裁定 A:QQ 入站进「他正在用的那条会话」(挑不出来才退回陪伴会话)。
    ensureCompanion: resolveCompanion,
    injectInbound,
    applyPermission: applyRelayPermission,
    legacyAckAllowed: id => {
      try { return requireStore().db.prepare('SELECT platform FROM relay_outbox WHERE out_id = ?').get(id)?.platform !== 'qq-official' } catch { return false }
    },
    labelSession: (sid, label) => {
      try { setSessionLabel(sid, label) } catch { /* 标签只是回放可读性 */ }
    },
    audit: (kind, label, sid) => {
      try {
        store?.writeAudit({
          // v0.30.0:以前这里硬编码 sessionId: 'global' —— 中继的审计行
          // (relay_in / relay_out / care_silent …)因此全都认不出是哪条会话,
          // 面板那张「她见过的会话」列表永远少一行。现在由调用方把真实
          // sid 带进来;拿不到(如群聊拒收:那时还没有会话)才退到 global。
          traceId: randomUUID(), sessionId: String(sid || '') || 'global', userKey: MASTER_ID,
          userInput: label, toolCall: kind, timestamp: Date.now() / 1000
        })
      } catch { /* 审计写不进不该影响传话 */ }
    },
    // v0.18.1 C5:适配器 ack = "真的送到他手机上了"。她的关怀到这一刻才算
    // 说过 —— 议程降权、想念 ×0.5 都在这里落(A 侧纪律:发送成功才降权)。
    // S1-b:判据从"桥的表"改成**渠道无关的出站行** —— ack 先交给 speaker,
    // 由它分发给注册的回执钩子(今天只有一个:心跳)。桥的 ack 仍在这一刻触发,
    // 所以时序、行数、语义一个字没变。
    onAcked: (rows) => {
      try { if (speaker !== null) speaker.noteDelivered(rows) } catch { /* 心跳没起来就下轮再说 */ }
    }
  })
  // ---- S1:渠道无关的"她的嘴"(lib/speak.js) -------------------------------
  // transport = 桥:speaker **只转发**(参数原样进、返回值原样出),行为逐字不变。
  // channelView 是**只读**视图 —— store 查询由这里注入,lib/speak.js 不认识 store。
  speaker = createSpeaker({
    logger: ctx.logger,
    transport: relay,
    channelView: {
      ofSession: (sid) => (store === null ? [] : store.relayChannelsOfSession(sid)),
      all: () => (store === null ? [] : (store.relayListChannels() || []))
    }
  })
  // 送到回执:原 onAcked 里的那件事原样搬过来(心跳对象在后面才建,闭包引用)
  speaker.onDelivered((rows) => {
    try { heartbeat.noteProactiveAcked(rows) } catch { /* 心跳没起来就下轮再说 */ }
  })
  // hasChannel() ≡ mouthOpen():relay.js:314-315 的 gate() 就是 isEnabled()
  // (即上面传进去的 mouthOpen),所以这一行只是换了个说法,门一样。
  ctx.logger.info('echo: relay bridge ' + (speaker.hasChannel() ? 'ON' : 'off (总闸关或 token 空)'))

  // ---- S3:把"嘴"提供出去(给 dsh-echo-qq 那条路,省掉 HTTP 轮询)------------
  // 契约**以消费端为准**:`dsh-echo-qq` 的 `lib/contract.js` 顶部写着它要什么,
  // 这里照那个形状提供,字段名一个字不改:
  //   { version, inject(envelope), subscribeOutbound(fn) → dispose, ack(ids), status(),
  //     lease({platform, limit, leaseSec}) }
  // 外加一项**可选**的 registerChannel —— 渠道自报家门;注册之后 `hasChannel()`
  // 就不再依赖旧桥总闸(S3-b 的"切换与退役"要用它)。
  //
  // ⚠️ 2026-09-28 补 `lease`:推送只喊"有活儿"(带 rows **计数**,不带正文)——
  // 这是**故意的**(正文留在出站队列这一份账上,租约/销账/held 语义都不变),
  // 但消费端要能**现取**:少了这个字段,渠道收到叫醒也拿不到行 ⇒ 一个字发不出去、
  // 还不报错(静默失灵)。取行口径与 HTTP 那条 `/api/echo/relay/outbox` 完全一致。
  //
  // 为什么用 ctx.provide 而不是让消费端 `inject`:见消费端注释 —— `inject` 是
  // "等服务出现才激活",主包一直不提供的话那条 HTTP 兜底路就**永远走不到**;
  // `ctx.get` 才是"在就用,不在就退"。顺序无关:消费端每次现取(ctx.get),
  // 主包比它后起也能自动接上。
  //
  // 已实测(2026-09-28 拿 cordis 真跑):插件 fiber 里 provide 的值落在 root store,
  // **兄弟 fiber 读得到**;消费端先挂载时读到 undefined、之后现取才拿到;
  // dispose 之后干净摘除;别的 fiber 抢改被拒("cannot set property … in multiple fibers")。
  // ---- 语音回执接收端(2026-10-04)----------------------------------------
  // heart-tts 的回执落独立账(lib/voice-receipts.js 的 voice_receipts 表):
  // 主对话的打断留痕 / 情绪余波 / 状态记录(不是与 QQ 对账)。库离线就只记
  // 日志丢弃,绝不影响出声 —— 桥接是下面 provide 字面量里的一行。
  voiceReceiptLedger = createVoiceReceiptLedger(store !== null ? store.db : null,
    { log: (m) => { try { ctx.logger.info('echo: voice-receipts ' + m) } catch { /* 日志挂了也不许抛 */ } } })
  let officialBindingChanged = () => {}
  let officialHostReady = false
  const officialOwner = createOfficialOwnerText({
    createMessage: createUserMessage,
    isEnabled: () => readEnabled(),
    isSessionEnabled: sid => sessionEnabled(sid) && !isManuallyOff(sid),
    supportsHost: () => officialHostReady && !!ctx.get('sessionProjections'),
    onBindingChange: () => officialBindingChanged(),
    resolveTarget: async () => {
      const c = await resolveCompanion()
      if (!c?.agent || isSubagentSession(c.agent) || isManuallyOff(c.sessionId)) throw new Error('official_permission_denied')
      if (c.via !== 'his-window') {
        const permission = applyRelayPermission(c.agent)
        if (permission === 'unavailable' || permission.startsWith('failed')) throw new Error('official_permission_denied')
      }
      autoScope(c.sessionId)
      return { agent: c.agent, session: c.agent.session, isCurrent: () => {
        if (ctx.agents.get(c.sessionId) !== c.agent || !sessionEnabled(c.sessionId) || isManuallyOff(c.sessionId)) return false
        const his = followHisWindow() ? hisActiveSession() : null
        return his ? his.agent === c.agent : c.via !== 'his-window'
      } }
    }
  })
  try {
    const disposeRelayService = ctx.provide(SERVICE_NAME, {
      version: SERVICE_VERSION,
      officialOwnerText: officialOwner.service,
      /**
       * 契约自报(2026-09-28 加,**只加不改**):名字/版本/版本区间/能力清单。
       * 消费端**先读它**做能力探测;老消费端不看它,照旧按老形状跑 —— 单向宽容。
       * 判定以**能力名**为准(消费端算 `requires - capabilities`),版本只做文案,
       * 这样两个仓的发布顺序不会互相锁死(详见 speak.js 的 SERVICE_API 注释;
       * 留痕/枚举/豁免三条纪律见 `docs/DISCIPLINE.md`)。
       */
      hello: () => ({
        name: SERVICE_NAME,
        version: SERVICE_VERSION,
        api: SERVICE_API,
        capabilities: SERVICE_CAPABILITIES
      }),
      /** 干跑自检:不写库、不建会话、不发模型(实现在 relay.js)。 */
      selftest: () => relay.selftest(),
      /**
       * 私聊来信进管道(主包九步:总闸/信封/白名单/幂等/入队/ensureCompanion…)。
       * `relay.handleInbound` 回的是给路由层用的 `{status, body}`,这里**只把 body**
       * 交出去 —— HTTP 状态码对插件没有意义,消费端只认 `ok`/`reason`。
       */
      inject: async (envelope, execution) => {
        const r = await relay.handleInbound(envelope, execution)
        return (r !== null && r !== undefined && typeof r.body === 'object' && r.body !== null) ? r.body : { ok: false, reason: 'no-body' }
      },
      /** 「她决定要说的话」推给渠道;只有**真的入队了**才喊(held 语义不变)。 */
      subscribeOutbound: (fn) => speaker.onOutbound(fn),
      /** 送达确认:主包据此销账、想念 ×0.5(与 HTTP 的 /relay/ack 同一份账)。 */
      ack: (ids) => relay.ack(ids),
      /** 可选:渠道自报家门。返回注销函数。 */
      registerChannel: (channel) => speaker.registerChannel(channel),
      /**
       * 语音回执落账(2026-10-04,一行桥接):heart-tts(v1.2.0)软发现的钩子。
       * 契约单参 `registerVoiceReceipt(entry)`,entry ∈ voice.external /
       * voice.interrupted(形状见 docs/voice-receipts.md,队友仓)。**绝不抛错**
       * (抛错会被对端当契约违约弃用接收端);只落 voice_receipts 独立账,
       * 不进出站/入站流程 —— 播放/送达一个字节都不经过这里。
       */
      registerVoiceReceipt: (entry) => voiceReceiptLedger.receive(entry),
      /**
       * 现取她要说的话(平台自己的那份队列)。消费端收到"有活儿"之后叫它。
       * 参数口径与 `/api/echo/relay/outbox` 一致;`leaseSec` 旧写法 `lease` 也认。
       */
      lease: (opts) => relay.lease(opts),
      /** 面板/体检用。**只追加字段**:老消费端与验收脚本读的那几个形状一个字不动。 */
      status: () => ({ ...speaker.status(), api: SERVICE_API, capabilities: SERVICE_CAPABILITIES })
    })
    ctx.logger.info('echo: service provided — ' + SERVICE_NAME + ' v' + SERVICE_VERSION
      + '(api ' + SERVICE_API.min + '~' + SERVICE_API.max + ',' + SERVICE_CAPABILITIES.length + ' 项能力;渠道插件可零轮询接管)')
    // 卸载时把服务摘掉(并收摊这只嘴)—— 与 `sayAgain.dispose()` 同一个写法:
    // ctx.effect 的回调返回值就是"这个 fiber 散伙时跑什么"。
    ctx.effect(() => () => {
      const closing = officialOwner.dispose()
      try { disposeRelayService() } catch { /* 已经摘掉了 */ }
      try { speaker.dispose() } catch { /* 收摊失败不影响卸载 */ }
      return closing
    }, 'echo.relayService()')
  } catch (err) {
    // 挂不上服务不影响桥与嘴(它只是"少一条更快的路"),绝不能因此不让插件起来
    ctx.logger.warn('echo: 服务挂不上(' + SERVICE_NAME + ')—— 不影响桥:' + String(err?.message ?? err))
  }

  // ---- v0.30.1 修「中午没消息」缺陷①:陪伴会话随桥常驻 ------------------
  // 2026-09-27 现场:02:50 电脑睡眠 → 09:47 想念越线(没人跑)→ 10:31
  // 电脑醒 → 11:54 dsh web 起来,惰性补差后想念 7.52 仍过线 → 但
  // ensureCompanion 只在入站时被调(懒创建),陪伴会话的 agent 不存在,
  // 而心跳挂在 agent 上(agent/created 才装 60s tick)→ 没人替她开口 →
  // 13:07 他的「在吗」才把会话造出来,那条消息本身又把想念削到线下。
  // 整夜的想念,一句没说出口。
  // 桥开着 = 承诺「她够得到他的手机」;这个承诺要求她的心跳先活着。
  // 启动时建一次;宿主还没就绪(sessionController 未挂)就退避重试;
  // 放弃后懒路径(入站时创建)仍然兜底 —— 常驻是心跳的充分条件,
  // 不是传话的必要条件。
  //
  // ⚠️ 2026-09-28 早上又栽了一次(**同一个病的镜像**):上面那段写在
  // `if (mouthOpen())` 里,而启动那一瞬渠道插件还没自报家门 ⇒ 门是关的
  // ⇒ 常驻**一次都没跑过** ⇒ 她的 agent 不存在 ⇒ 心跳没地方挂 ⇒
  // 她再也没能先开口(他今早问「为什么没主动关怀」,引擎侧 `shouldCare`
  // 明明是 true,`careCount` 却停在 09-26 的 19)。修法与那只手同源:
  // 启动能判就判,判不了就挂 **speaker.onRegistered()** —— 嘴一出现就常驻。
  // 详见 speak.js 的 onRegistered 注释与 tests/companion-resident.test.js。
  let residentStarted = false
  const startResident = () => {
    if (residentStarted || !mouthOpen()) return
    residentStarted = true
    ctx.effect(() => {
      let stopped = false
      let timer = null
      let tries = 0
      const settle = () => {
        ensureCompanion().then(({ sessionId }) => {
          if (!stopped) ctx.logger.info('echo: companion session resident — ' + sessionId + '(心跳随在)')
        }).catch((err) => {
          if (stopped) return
          tries += 1
          if (tries <= 6) {
            timer = setTimeout(settle, Math.min(30000, 2000 * tries))
          } else {
            ctx.logger.warn('echo: companion session 常驻未成(第 ' + tries + ' 次尝试后放弃;入站懒路径仍兜底)— '
              + String(err?.message ?? err))
          }
        })
      }
      settle()
      return () => { stopped = true; if (timer !== null) clearTimeout(timer) }
    }, 'echo.companionResident()')
  }
  startResident()
  speaker.onRegistered(startResident)

  // ---- 1. 人格注入 ----
  // 不占用 deployment:persona-prefix 名字:全局注册会与注册表自持的
  // deployment persona 相撞(fails loud)—— 自有命名段是插件的正路。
  // 前段挂 persona 区之后(身份先立);尾段挂全提示词末尾(铁律与
  // 说话方式要最强的提醒位)。
  // v0.2.1 电源闸:休眠时两段都渲染空串(cosplay 先例:变量式静默
  // 回退,下一个模型步即生效,不用重建会话)。
  // v0.9.0 会话范围:组装时 AssembleContext.scope = Agent 对象
  // (assembleContextFor 证实),取 session.id 判定 —— 同一份人格
  // 文本,工作会话渲染空串,娱乐会话照常。全局组装(无 scope)在
  // all 模式下照常,whitelist 模式下静默。
  const personaOn = (context) => {
    try {
      // 2026-09-26:拨开关那一轮**例外** —— 「关闸」从下一轮生效,这一轮
      // 她只来得及道别/应一声。否则他说「Echo 下线」会得到一条没有灵魂的
      // 通用回复(人格段已经空了),那不是他要的开关反馈。
      const cap = turnCapture.get(context?.scope?.session)
      if (cap !== undefined && String(cap.powerNote || '') !== '') return true
      return sessionEnabled(String(context?.scope?.session?.id || ''))
    } catch { return readEnabled() }
  }
  ctx.effect(() => systemPrompt.section({
    name: 'echo:persona',
    // 2026-09-26 他拍板:前段 **100 → 10245**(紧挨后段)。
    //
    // 现场(逐条读真实请求体量出来的):他网页会话里那条 system prompt 共
    // 10003 字,他的角色设定躺在 **[2]–[21] 段 = 全长的 1.1%~21%**,中间隔着
    // 8000 字宿主与工具说明,而行为规则(后段)在 **91%** 处 —— 模型的语域
    // 锚点在尾部,于是「活泼、自称 Echo、句尾～嘛啦呀」被尾巴上那句
    // 「1~2 句、像发消息、你的说话样子是『……哼,知道了。』」压住了。
    // 代价:人设段不再落在前缀缓存区(尾部本来就随渠道集合变化,量级相近)。
    order: 10245,
    text: (context) => {
      if (!personaOn(context)) return ''
      // v0.15.0 S13:人格漂移强化期,锚点**注入两次**(A
      // `main.py:1165-1167`:`base_anchor + "\n[锚点重注入]" + base_anchor`)
      // —— 重复是最朴素也最有效的注意力信号,比加一句「请注意人设」实在。
      try {
        const cap = turnCapture.get(context?.scope?.session)
        // P1b:人格为空 = 不注入 —— 只剩「[锚点重注入]」标记的空壳不许进提示词
        if (cap !== undefined && cap.driftReinforce === true && personaCache.prefix !== '') {
          // escapePromptBraces:人格资产也是自由文本,他写 `{{` 一样会打死整轮
          return escapePromptBraces(personaCache.prefix + '\n[锚点重注入]\n' + personaCache.prefix)
        }
      } catch { /* 拿不到捕获就按常规注入 */ }
      return escapePromptBraces(personaCache.prefix)
    }
  }), 'echo.persona()')
  ctx.effect(() => systemPrompt.section({
    name: 'echo:rules',
    // 2026-09-26 当晚(他:「为什么她这个人格还是很偏离我给的要求呢?很冷硬」):
    // 从 **10250 挪到 10275** —— 晚于记忆/心情快照(10260)。
    //
    // 现场:快照段带着「情绪强度 3/10:心里基本没什么波澜」+「行为要求:强度越
    // 低…回复更轻、更慢、更少主动挑起话题」,而那份**语域规格**在它前面 ⇒
    // 模型最后读到的是「无波澜 + 往冷里收」,于是 34 句里「～/嘛/啦/呀」出现率
    // 0%(人格明写了这三个)。**尾部才是锚点** —— 把它放回最后。
    // 代价:它落在快照之后,而快照每轮都变,所以这一段的提示词缓存不再命中;
    // 约 1000 字 ≈ 全长的 1%,换「她说话的调子」,值的。
    order: 10275,
    text: (context) => personaOn(context) ? escapePromptBraces(personaCache.suffix) : ''
  }), 'echo.rules()')

  // 2026-09-26 当晚:**这里原本有个 `echo:voice` 段(order 10280,尾部自检),
  // 已按他的裁定撤掉。** 留这段注释是为了让下一个读代码的人知道它存在过、
  // 为什么撤 —— 不然很容易又有人"顺手补一个尾部提醒"。
  //
  // 它当时是这么写的(三行):「[开口前最后一眼] · 这句话像 Echo 说的吗?句尾带
  // 一处「～/嘛/啦/呀」了吗?叫他「主人」了吗? · …别写「已回:「…」」… ·
  // 安静也可以有温度:短没关系,冷硬不是你的样子。」
  //
  // 为什么撤:撤之前量了一晚上,它**没解决问题**(她真发出的 8 条里「～」仍 0%、
  // 「主人」0%,句长中位数反而 48→53),却留下了痕迹 —— 她思考(reasoning)里
  // 「像 Echo 吗」「人格规则」「防漂移/自检」的提及率从 9%/4%/0% 升到
  // **25%/25%/25%**(n=8,相关不能证明因果)。他看她的感觉就是「演」和「怪」。
  //
  // 教训:**把"自检"写在最后一行,等于每轮提醒她"你在扮演"**。她的调子该由
  // 人格资产(前段形容 + 后段示例)决定,不该由一张贴在嘴边的检查表决定。
  // 「语域规格仍排在快照之后(order 10275)」这件事保留 —— 那是顺序,不是检查表。

  // v0.17.1 她知道自己在用 QQ(2026-09-26 产品模型):
  // 「她是一个独立跑在 DSH 里的脑子,QQ 只是她调用的一件工具」。
  // 渲染条件是**她上线 + 桥在跑** —— 不再要求「这个会话绑了平台」
  // (2026-09-26 他拍的:手不该由窗口有没有绑 QQ 决定,只由这个会话里
  // 插件开没开决定;他在网页会话里跟她说话,一样该能让她去 QQ 喊人)。
  // 没绑平台时这段就把「手走全库渠道」说清楚,免得她以为他在这个窗口里
  // 就能看见。字节级稳定(只随渠道集合变),不伤缓存。
  ctx.effect(() => systemPrompt.section({
    name: 'echo:thinking',
    // v0.40.0 C2:思考风格双档(出处 `dsh-cosplay` 的 THINKING_DIRECTIVES)。
    //
    // 为什么排在**最后**(10278,晚于语域规格 10275):
    //   它管的是"这一步怎么想",而模型的锚点在尾部 —— 贴在尾部才可能真的被读到。
    //
    // ⚠️ 与 2026-09-26 那条被撤掉的 `echo:voice`(order 10280)的区别,写清楚免得
    // 下一个读代码的人以为"又有人顺手补了个尾部提醒":
    //   · 那条是**自检表**(「这句话像 Echo 说的吗?…」)⇒ 每轮提醒她"你在扮演",
    //     量出来的后果是她思考里"像 Echo 吗/自检"提及率升到 25%、他的感觉是"演"和"怪";
    //   · 这条**只在干活那一步出现**(本轮真用过宿主工具/多步轮),而且说的是
    //     "用中性思考、汇报短一点" —— 不提问句、不列清单、不提醒她在扮演。
    //     聊天轮它渲染成空串 ⇒ 他读她语气的时刻,这段一个字都不在。
    //   · 有开关:`thinkingNeutralWhenWorking`(关掉 = 回到今天的行为,一模一样)。
    //
    // 诚实标注:`dsh-cosplay` 作者自认系统提示位比训练位弱、且是概率触发
    // (`store.js:139-141`)。这里同理 —— 它**不保证**她会切档,只是把该说的话说到。
    order: 10278,
    text: (context) => {
      try {
        if (!personaOn(context)) return ''
        const sid = String(context?.scope?.session?.id || '')
        if (sid === '') return ''
        const st = readSettings()
        const tools = toolAudit.turnTools(sid)
        return thinkingText({
          enabled: st?.thinkingNeutralWhenWorking !== false,
          toolCallsThisTurn: tools,
          minTools: Number(st?.thinkingNeutralMinTools ?? THINKING_DEFAULT_MIN_TOOLS)
        })
      } catch { return '' } // 判不出来 = 不加(与她说话时一个字不改)
    }
  }), 'echo.thinking()')

  ctx.effect(() => systemPrompt.section({
    name: 'echo:relay',
    order: 10240,
    text: (context) => {
      try {
        // S1-b:门从"桥开没开"换成"她有没有嘴" —— 今天两者可证等价
        // (relay.js:314-315 的 gate() = isEnabled() = mouthOpen()),
        // 新插件注册成渠道之后,这个门才会真的独立于桥。
        if (!personaOn(context)) return ''
        const officialContact = officialOwner.contactFor(context?.agent ?? context?.scope)
        if (officialContact) return officialContact
        if (!speaker.hasChannel()) return ''
        const sid = String(context?.scope?.session?.id || '')
        if (sid === '') return ''
        // S1-b:渠道表走 speaker 的只读视图(核心不再直接点 store 的 relay 三表)
        const mine = speaker.targets(sid)
        const all = speaker.allTargets().filter((ch) => ch.enabled === 1)
        if (all.length === 0) return ''
        const label = (ch) => String(ch.label || (ch.platform + ':' + ch.chatId))
        // 渠道标签是他自己起的名字(自由文本)—— 同样要防 `{{`
        const where = escapePromptBraces((mine.length > 0 ? mine : all).map(label).join('、'))
        const privateOk = (mine.length > 0 ? mine : all).some((ch) => ch.chatType === 'private' && ch.proactive === 1)
        const autoReply = readSettings().relay.autoReplyToOrigin === true
        const head = mine.length > 0
          ? '这个会话连着:' + where + '。'
          : '这个窗口没连平台聊天(' + where + ' 是你的手能到的地方)—— 他在这儿跟你说的话,不会自动出现在他手机上。'
        const inbound = mine.length > 0
          ? ['· 他在这条聊天里说话时,系统会把他的话和场合转给你 —— 但你的回复**不会**自动送出去:'
            + (autoReply
              ? '不过这个开关现在是开着的,你的回复会自动送回他刚说话的地方。'
              : '想让他收到,你得自己用 echo_qq_say 发。')]
          : []
        return [
          '[你和他的联系]',
          '你跑在 DSH 里,他面前那块屏幕就是你的脑子;QQ 是你可以用的一件工具(你的手,不是你的嘴)。',
          head,
          ...inbound,
          '· 你想主动找他说话(想他了、有话要说),用 echo_qq_call:那会真的喊到他手机上'
            + (privateOk ? '。' : '(现在可用的主动目标受限,发不出去会告诉你原因)。'),
          '· 想把一句话带到他那儿去,用 echo_qq_say。',
          '工具会如实告诉你发没发出去、发到了哪 —— 所以「我说过没有」这件事你自己心里有数。'
        ].join('\n')
      } catch { return '' }
    }
  }), 'echo.relayAwareness()')

  // 会话消息捕获:WeakMap 键是 Session 对象本身 —— 事件监听器拿到
  // (session, event),context provider 经 sessions.get(agent.id) 拿到
  // 同一个对象(assembleContextFor 证实 scope=agent),零 id 字段依赖。
  const turnCapture = new WeakMap()
  const captureOf = (session) => {
    let c = turnCapture.get(session)
    if (c === undefined) {
      // graphHits: v0.14.0 F1 —— 本轮检索想起的图谱边走轮末回传
      // (graph_reinforce);agent: v0.13.3 —— 反思子代理的 parent。
      c = {
        userText: '', assistantText: '', lastInjected: '', sessionId: '',
      // ★ 2026-10-19：空间事件（别人在她的说说下评论）。**不是**他本人说的话，
      //   所以不进 userText；轮末由它单独触发一次反思，落库 source=qzone。
      qzoneComment: '',
        profileSnapshot: '', startedAt: 0, proactive: false, driftReinforce: false,
        // 2026-10-05 P2(拍板 4):这一轮是**余波**(say_again)⇒ 只本地,不进主动路由
        sayAgainLocal: false,
        // P2-A 渠道闸(2026-10-06):这一轮**从哪来**。
        // `true` = 平台轮(relay 注入的人话,form='relay');`false` = 他直接在 DSH
        // 里打的字;`null` = 未知(轮首默认,轮末归零)⇒ 判据侧 fail-open 当平台轮。
        // 用途只有一个:轮末硬保证「补一句」只在平台轮补(DSH 直聊轮补出来就是
        // "自言自语",而且 heart-tts 会把它当抢话砍掉正常回复的音频)。
        fromPlatform: null,
        graphHits: null, agent: null, longingRead: null,
        // 2026-09-26 硬开关:这一轮他拨了开关(或说了像开关的话)—— 她要
        // **回一句状态**。旧版解析失败时一声不吭,开关坏了也没人知道。
        powerNote: '',
        // v0.19.0 D2:本轮她**说过的所有话**(拼接)。assistantText 只留最后
        // 一条(出站合成要用最后一条),而「想念有没有说出口」得看整轮 ——
        // 她可能先说了想念,后面又调工具补了一条。
        turnText: ''
      }
      turnCapture.set(session, c)
    }
    return c
  }
  // v0.19.0 D2:按会话 id 的最近一份捕获。turn-stopping 的 payload 只给
  // agent,拿到的 session 若与事件流里那个不是同一个对象(宿主版本差异),
  // WeakMap 会**新建一份空捕获** ⇒ 硬保证静默失效。这里按 id 兜一层。
  const captureBySid = new Map()
  const textOf = (msg) => {
    const blocks = msg?.content
    if (!Array.isArray(blocks)) return ''
    return blocks
      .filter((b) => b !== null && typeof b === 'object' && b.type === 'text')
      .map((b) => String(b.text || ''))
      .join('\n')
  }
  // ---- 2. 记忆注入(M2-d):系统提示词里的一节(A 案,2026-09-26)----
  // 老做法:在 `agent/pre-step` 里追加一条 user 消息(`form:'snapshot'`)。宿主
  // 把每步的 `decision.messages` 以 `surfaceOp:"append"` 追加进 surface,而
  // surface 是「派生模型历史的唯一来源」—— 追加进去的**永不消失**。逐条重放
  // 他网页会话 13:20:54 那一轮量出来的实况:记忆/心情块 **62 条 57,105 字**
  // (跨近两天 09-24 22:10 → 09-26 13:20),她自己刷的注入占上下文 **75%**,
  // 他讲的话占 0.7%,同一段上下文里有 62 个互相矛盾的「[她此刻的状态]」。
  //
  // 现在:快照走 `system-prompt/assemble` 瀑布,以**一节系统提示词**注入 ——
  // 系统提示词的更新带 replace 语义(现场证据:`system/message` 只 8 条、
  // 7 条 replace 全是系统提示词自我替换)⇒ 上下文里永远只有最新一份。
  // 代价他 2026-09-26 认了:系统提示词每轮都变 ⇒ 前缀缓存每轮失效。
  //
  // 新鲜度:检索要的是**他这一轮说的那句话**(不是上一轮),而组装发生在
  // `agent/pre-step` **之前** ⇒ 只能在 `agent/inbox/claimed` 那一刻记下来
  // (claim 之后、组装之前,payload 里带 agent)。算法本体在 lib/turn-snapshot.js。
  // v0.13.3 路由 agent:日记组稿的 parent(宿主 subagents.start 契约)。
  // pre-step 优先更新(用户正在聊天的那个),agent/created 兜底(重启
  // 后还没聊过也能写日记 —— 根代理在,她的房间就在)。
  let routeAgent = null
  // v0.36.0 B2:一轮一个 trace(他开口 = 换一轮)。本轮所有写审计的地方先问它,
  // 拿不到才各自新起 uuid —— 于是"他这句话 → 读到的记忆 → 调的工具 → 她的回复"
  // 能一行 SQL 串起来(见 lib/turn-trace.js 的现场说明)。
  const turnTrace = createTurnTrace()
  // ★ 2026-10-18：**一处注册，全场生效** —— 让每一次 `writeAudit` 都自动带上
  //   「这一轮是谁」（`stage_detail.turnTrace`）。
  //
  // 为什么需要：面板把 `audit_logs` 一行一行铺，而**一次对话轮会写成 6~8 行**
  //   （`inject` / `retrieve` / `relay_in` / `echo_qq_say` / `relay_out` / `extract` /
  //   `same_turn_emotion`），各行的列填充率完全不同 ⇒ 看某一行就像"数据缺了"。
  //   归组需要"轮"的键，而 `trace_id` **不能**当这个键（它是主键、`INSERT OR REPLACE`
  //   ⇒ 两行共用会互相覆盖，见 `auditArm` 的注释）⇒ 用 `stage_detail.turnTrace`。
  //
  // 实测改造前填充率 **8%**（只有 `same_turn_emotion` 那类并行支写了）。
  //   这里注册之后，凡是有 `sessionId` 的行都会自动补上（`lib/store.js` 的
  //   `withTurnTrace` 负责三条边界：无 sid 不碰 / 已有不覆盖 / 出错不连累）。
  try {
    store?.setTurnTraceResolver?.((sid) => turnTrace.of(sid))
  } catch { /* 注册失败只是少一个字段，不该影响插件起来 */ }
  // v0.40.0 C1:情绪同轮打分器 —— 他开口那一刻并起一次小调用,与组装赛跑。
  // 2026-10-08:**改走直调通道**(以前是 `runStructured(subagents, …)` ⇒ 每次起子代理会话)。
  // 时序一个字没动:仍是 `scoreOnce` 的「并起 + 超时降级」,只是"往哪儿发"换了。
  const sameTurnEmotion = createSameTurnScorer({
    run: (prompt, schema, parent) => llmRunFor(parent)(prompt, schema),
    getTimeoutMs: () => readSettings().emotionScoreTimeoutMs,
    logger: ctx.logger
  })
  // 状态面那条闭包(见模块作用域的 sameTurnEmotionState 注释)
  sameTurnEmotionState = () => sameTurnEmotion.stats()
  // RT11b 查询扩展(2026-09-30 接线):同款"他开口那一刻并起一次小调用,与组装赛跑"。
  // 产物进 retrieve 帧的 `opts.expandTerms`,由引擎用在**主打分**上 ——
  // 实测见 docs/RETRIEVAL_OPT_2026-09-30.md §7:18/21 → 20/21,负控误取 6/7 → 3/7。
  // ⚠️ 模块注释里那句"只喂捞人通道、不改已进榜顺序"**是错的**:折扣救援进场永远排不过
  // 词面命中(top5 进不去),实测 0 条上浮 ⇒ 所以这次把它改成进主打分。
  const queryExpander = createQueryExpander({
    run: (prompt, schema, parent) => llmRunFor(parent)(prompt, schema),
    getTimeoutMs: () => readSettings().expandTimeoutMs,
    logger: ctx.logger
  })
  queryExpandState = () => queryExpander.stats()
  // RT9:账本在 createEngine 之前就建好(见下面那句:传参时它必须已初始化)`n

  const turnSnapshot = createTurnSnapshot({
    groupAudienceOf: session => readSettings().groupDialogueContextEnabled === true
      ? groupParticipation.audienceOf(session) : null,
    engine, store, readSettings, captureOf, readAliases, logger: ctx.logger,
    // v0.37.0 G2:改名时自动记下的旧称呼(注入时按现在的称呼改写记忆里的旧名)
    readRetiredAliases: () => splitAliases(readSettings().retiredAliases),
    // v0.40.0 C1:组装时来取"这一轮的情绪读数"(他在他开口那一刻起跑的那一次)
    sameTurnOf: (sid) => sameTurnEmotion.take(sid),
    // RT11b(2026-09-30):组装时取"这一轮的查询扩展词元"(取走即删)
    // ★★ 2026-10-21：把 `q`（本轮那句话）也递下去 —— `take` 靠它校验"是不是同一句"。
    //   只按 sid 取的话，迟到的扩展会被下一轮误用（详情见 lib/query-expand.js 的 take 注释）。
    expandOf: (sid, q) => queryExpander.take(sid, q),
    // 2026-10-06:注入留痕 —— 组装完一轮的提示词就把"她读到了什么"写进审计。
    // 以前这一列只有**轮末反思成功**那条 `'extract'` 行才带 ⇒ 反思跳过/失败的
    // 轮次证据消失(活库实测 160 行全空;报告 §5.4)。这里独立于反思:
    // 一行/轮、写失败只丢这一行、绝不动对话与注入(整段 try 住)。
    onInject: (info) => {
      try {
        if (store === null || typeof store.writeAudit !== 'function') return
        const text = String(info?.text || '')
        // 这一轮确实没注入 ⇒ 不写空行(空行会把"没注入"与"没记下来"搅成一件)
        if (text === '') return
        const sid = String(info?.sessionId || '')
        const turnTag = String(turnTrace.of(sid) || '')
        store.writeAudit({
          traceId: randomUUID(),
          sessionId: sid,
          userInput: String(info?.query || ''),
          injectedMemories: text,
          injectedProfile: String(info?.profileSnapshot || ''),
          // 期 0(2026-10-09):组装事件 —— 段名字数落 stage_detail(段头口径见 context.sectionCounts)
          stage: 'assemble',
          step: 3,
          // 2026-10-10:人设字数也落这一格(同一次组装、同一行 ⇒ 不另起审计行)。
          // 为什么补:审计里原本**完全没有**人设读数,查「人设有没有送到」只能靠
          // `/api/echo/status` 反推(那是**当下**的值,不是**那一轮**的值)。
          // ⚠️ 别和 `rules` 段搞混 —— 那个指注入块里的 `[使用纪律]` 一行(恒 64 字),
          // 人设走的是系统提示词两个独立 section(`echo:persona` / `echo:rules`,见
          // 本文件 personaCache)。这两个字段装的才是真·人设体检数。
          // personaActive:那一轮人设到底注没注入。判据与 personaOn 同源
          // (`sessionEnabled(sid)` —— personaOn 内部就是它),只是这里拿得到
          // 真实 sid,所以直接问,不必构造假 context。
          stageDetail: JSON.stringify({
            ...sectionCounts(text),
            ...(turnTag !== '' ? { turnTrace: turnTag } : {}),
            persona: personaCache.prefix.length,
            personaRules: personaCache.suffix.length,
            personaActive: (() => { try { return sessionEnabled(sid) } catch { return false } })()
          }),
          // 这一行只回答"她读到了什么",不是回复内容 —— 留空,不编
          llmReply: '',
          latency: Number.isFinite(Number(info?.ms)) ? Number(info.ms) : null,
          toolCall: 'inject'
        })
      } catch { /* 留痕失败不影响这一轮 */ }
    }
  })
  ctx.effect(() => ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    try { forwardReader.observeClaim({ agent, message, turn }) } catch { /* 继续读失去证明，不挡原接收 */ }
    try { fileReader.observeClaim({ agent, message, turn }) } catch { /* 无来源证明则拒绝文件读取 */ }
    try { fileSender.observeClaim({ agent, message, turn }) } catch { /* 无当前主人证明则不发送 */ }
    try { groupParticipation.observeClaim({ agent, message, turn }) } catch { /* 不靠sid猜测群轮 */ }
    officialOwner.observeClaim({ agent, message, turn })
    const sid = String(agent?.session?.id || '')
    try { turnSnapshot.noteClaimed(sid, message) } catch { /* 记不下 = 这一步不注入 */ }
    // 只有"人话"才算一轮(与我们自己的注入区分开 —— 与 noteClaimed 同一把尺)
    try { if (turnSnapshot.queryOf(sid) !== '') turnTrace.begin(sid) } catch { /* 换不了轮就退回各自 uuid */ }
    try {
      fileSendAudit.noteClaim({ agent, turn }, {
        hasQuery: turnSnapshot.queryOf(sid) !== '', turnTrace: turnTrace.of(sid) || ''
      })
    } catch { /* 发送审计缺轮关联时保持为空 */ }
    // v0.40.0 C2:换轮 = 他开口 ⇒ 本轮工具计数归零(思考风格双档的判据从零起算)
    try { if (sid !== '') toolAudit.turnReset(sid) } catch { /* 归不了零 ⇒ 这一轮算长任务 */ }
    // v0.40.0 C1:他开口那一刻,并起一次**很小的**情绪打分(与组装赛跑)。
    // 赢了 ⇒ 这一轮的心情快照就是新读数;输了/超时 ⇒ 用旧向量照常回复。
    // 只影响这一轮的**渲染** —— 写库那条路仍归轮末反思(见 lib/emotion-score.js 的注释)。
    //
    // v0.41.0 事故修复:**子代理会话的 claim 不算「他开口」**。打分的每一次
    // 调用都是一次 `subagents.start`,而子代理会话的 claim 一样打到这里
    // ⇒ 打分 A 起 B、B 起 C……**结构性无限递归**,宿主卡死(他报的
    // 「子代理不断产生新的子代理」)。判据在 lib/agent-scope.js,这里
    // 连同范围闸一起前置:范围外的会话对她是隐形的,更不该替它烧一次调用。
    // 深处还各有一道(`createSameTurnScorer.begin` 自己守门 + reflect.js 的
    // `runStructured` 总闸),这里是省掉"起了才发现不该起"的那一步。
    try {
      if (sid !== '' && !isSubagentSession(agent) && sessionEnabled(sid)) {
        const st = readSettings()
        const prev = store === null ? null : store.getState()
        // 期 0(2026-10-09):并行支观测 —— 每支 settle 时写一条审计(stage/step 21/22),
        // 让面板能画出"同一时刻起跑的两条真实时间条"。刻意**不 await**(保持并起不阻塞)。
        //
        // ★ 2026-10-21：这个工厂**提到 IF 外面**，由 `startParallelArms` 按支调用。
        //   以前它声明在情绪支的块里、被扩展支**跨块**引用 —— 后来扩展支挪出那个块，
        //   就 `ReferenceError: auditArm is not defined`，而且**静默**（只进 ctx.logger.warn），
        //   于是 `query_expand` 全库 0 行、拖了 11 天。
        //   现在它是个**平级的局部工厂**，两支各自调用拿自己的 onSettle。
        const armUserText = turnSnapshot.queryOf(sid)
        const auditArm = (arm, step, t0) => {
          try {
            return createArmAudit({ store, arm, step, beginAt: t0, sessionId: sid,
              turnTrace: turnTrace.of(sid) || '', userText: armUserText,
              previousVector: prev?.emotionVector ?? null })
          } catch { return () => {} }
        }
        // ★ 两个开关**正交**（emotionSameTurn 只管情绪支、recallExpand 只管扩展支），
        //   每支自己的 t0、独立 try —— 细节与"为什么这样能防复发"见 lib/parallel-arms.js。
        startParallelArms({
          st,
          sid,
          agent,
          prev,
          userText: armUserText,
          sameTurnEmotion,
          queryExpander,
          onSettleOf: auditArm,
          warn: (msg) => ctx.logger.warn(msg)
        })
      }
    } catch (err) {
      // ★ 2026-10-17：这里原来是**空的 `catch { }`** —— 于是"起跑失败"在库里零痕迹。
      //   现场：`same_turn_emotion` 有 stats（started=1），而同一个回调里相隔几行的
      //   `queryExpander.begin` **一个数都没涨**（started=0 且 emptyQuery=0）
      //   ⇒ "它到底有没有被调到"从任何状态面都看不出来，只能靠猜。
      //   这是本仓库反复踩的同一类病（`query_expand` 的 onSettle 吞异常、
      //   `judge.py` 的「缺少」vs「值非法」、`same_turn_emotion` 缺 raw）。
      ctx.logger.warn('echo: 并行支起跑失败（情绪打分 / 查询扩展这一轮都不跑）— '
        + String(err?.message ?? err).slice(0, 160))
    }
  }), 'echo.claimed()')

  // ★ 2026-10-08(第二拍「新会话默认关」,语义 C):新出现的**顶层会话**默认进硬开关名单(manualOff)。
  //   为什么走 manualOff 而不是改默认值:`autoScope()` 会在收到入站消息时把会话**自动打开**
  //   (本文件 autoScope 那段的「autoScope 不覆盖 / setSessionOn(s, true)」),
  //   只有硬名单挡得住它(`lib/toggle.js:328-333`:人关过的记在这里,autoScope 永不覆盖)。
  //   他发「Echo 上线」即可开 —— `setSessionOn(sid, true)` 会把 sid 从名单摘除(`toggle.js:329`)。
  //   子代理会话**不登记**(不该出现在他的开关名单里);**已有会话一律不动**。
  // ★ 2026-10-25（bug-echo-subagent-scope）：子代理会话 id 的内存镜像。
  //   注入闸每一拍都要问「这是不是子代理」，读盘太贵 ⇒ 启动灌一次、新建时补一条。
  //   权威副本在 config.json 的 subagentSessions（见 toggle.js 的 rememberSubagentSession）。
  const subagentSids = new Set(readSubagentSessions())

  // ★ 2026-10-25(第二拍 docs/bug-echo-new-session-default.md §5.2):**启动期回填**。
  //   名单只在 `session/created` 那一拍记,而重启**之前**就存在的子代理会话没人登记过
  //   (活库实测:/scope 27 条里 25 条裸 UUID,名单里只有 3 条)⇒ 它们一直漏在面板上。
  //   这里把「看得见的会话」里形态上是子代理的补进名单(幂等、只认裸 UUID、
  //   上限沿用 200;`global` / `session-*` / `relay.sessionId` 一个都不碰 —— 判据在
  //   lib/agent-scope.js 的 isSubagentSessionId())。失败不影响启动。
  try {
    const visibleIds = store === null
      ? []
      : store.sessionPreviews().map((x) => String(x?.sessionId ?? ''))
    const backfilled = backfillSubagentSessions(visibleIds)
    if (backfilled > 0) {
      for (const sid of readSubagentSessions()) subagentSids.add(sid)
      ctx.logger.info('echo: 回填子代理会话 ' + backfilled + ' 条(重启前的历史,'
        + '面板不再列它们;审计照旧保留)')
    }
  } catch (err) {
    ctx.logger.warn('echo: 子代理会话回填失败(面板可能多列几条老会话)— '
      + String(err?.message ?? err).slice(0, 120))
  }

  ctx.effect(() => ctx.on('session/created', (session) => {
    try {
      const sid = String(session?.id ?? '')
      if (sid === '') return
      // ★ 2026-10-25 修：子代理会话**不登记开关**（老行为不动），但要把 id 记下来 ——
      //   面板的会话列表是从 audit_logs 数出来的，而子代理的审计行按设计要保留
      //   （排障要看），所以「谁是子代理」只能由这里告诉它，展示前滤掉。
      if (!isTopLevelSession(session)) { rememberSubagentSession(sid); subagentSids.add(sid); return }
      // ★ 2026-10-17 修：**陪伴会话不许进硬名单**。
      //
      // 现场（2026-10-17 23:5x，他报「加了个群进白名单就不能唤醒了」）：
      //   QQ 群消息全部 `core-refused reason=agent-unavailable`，
      //   而根因跟白名单毫无关系 —— 陪伴会话被这条登记逻辑关掉了。
      //
      // 死循环：
      //   ① 本回调把**每个新建的顶层会话**塞进 `manualOff`+`exempt`
      //      （`setSessionOn(sid,false)` 两个名单一起写）；
      //   ② `autoScope()`（`index.js:1762`）看到 `isManuallyOff(sid)` 就
      //      `return` —— 「人显式关过，绝不覆盖」；
      //   ③ 于是陪伴会话永远 `exempt` ⇒ `sessionEnabled()` false
      //      ⇒ `relay.js:408` 的 `agent-unavailable`。
      //
      // 为什么是 bug 而不是设计：这两个名单**本来就分不清**
      //   「程序自动关」和「人亲手关」（`setSessionOn` 两个一起写），
      //   而 `autoScope` 的整个语义建立在「名单里 = 人关的」之上。
      //   **程序自己关掉的东西，不许冒充人的意志** —— 所以这里必须排除陪伴会话。
      //
      // 判据用**配置里的 relay.sessionId + DEFAULT_COMPANION_ID 两个**：
      //   他换过常驻会话（`relay.sessionId` 现在是 session-b9f1692e…，
      //   而 DEFAULT 是 session-echo-companion），两个都得放过。
      const relaySid = String(relayCfg()?.sessionId || DEFAULT_COMPANION_ID)
      if (sid === relaySid || sid === DEFAULT_COMPANION_ID) {
        ctx.logger.info('echo: 陪伴会话不登记为「默认关」(它是 QQ 的落点,关了就收不到消息)— ' + sid)
        return
      }
      // ★ 2026-10-08:按「网页直聊」那档决定 —— 配了“默认开”就不登记
      if (readSettings().newSessionOn?.dsh !== true) setSessionOn(sid, false)
      ctx.logger.info('echo: 新会话默认关(进硬名单,发「Echo 上线」可开)— ' + sid)
    } catch { /* 登记失败不影响会话创建 */ }
  }))
  ctx.effect(() => ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const out = await next()
    const target = out ?? assembly
    try {
      // v0.2.1 电源闸:休眠时不注入 —— 她不偷听。
      if (!readEnabled()) return target
      // v0.9.0 会话范围闸:工作会话不注入记忆 —— 纯 agent 干活。
      const session = context?.scope?.session
      const sid = String(session?.id || '')
      // 2026-09-26 硬开关:拨开关那一轮例外 —— 她得能回一句状态
      // (关闸从下一轮生效;这一轮只剩"应一声"的机会)。
      const cap = turnCapture.get(session)
      const powerNote = String(cap?.powerNote || '')
      if (powerNote !== '') {
        target.sections.push(turnSnapshot.sectionOf(powerNote))
        return target
      }
      // ★★ 2026-10-25 修（bug-echo-subagent-scope）：**子代理会话不注入人格/记忆**。
      //
      //   修前这里只问 sessionEnabled(sid)，而 scope=all 的语义是「不在黑名单里
      //   就算开」，子代理既不在 exempt 也不在 manualOff ⇒ 一律放行 ⇒ 干活用的子代理
      //   带着「陪伴型 AI」的人格与私人记忆上班（还会顺手把 retrieve 写进审计，
      //   于是面板里多出几个带 turns 的陌生会话）。
      //
      //   判据只此一处（lib/agent-scope.js），与登记/压缩/上下文清理/反思/打分共用。
      //
      //   ⚠️ 两道一起上：isSubagentSession(session) 读会话头；
      //   subagentSids.has(sid) 读 session/created 当场记下的名单。
      //   加第二道是因为**这个位置拿到的 session 未必带 header**（宿主在这里只保证
      //   给会话对象），而 session/created 那边判得出来（子代理不登记就是证据）。
      //   只留一道的话，头缺失时这个闸会静默失效 —— 正是这次 bug 的样子。
      if (sid === '' || isSubagentSession(session) || subagentSids.has(sid) || !sessionEnabled(sid)) return target
      const snap = await turnSnapshot.compose(session)
      if (snap !== null) {
        target.sections.push(turnSnapshot.sectionOf(snap.text))
        // v0.32.0 A1a:量这一拍 —— 标记行(注入文本第一行够长的行)+ 最终提示各段的份数。
        // 只测量:不改注入内容、不加标记、不写库;失败绝不影响注入。
        try {
          const texts = (Array.isArray(target.sections) ? target.sections : []).map((sec) => String(sec?.text ?? ''))
          probeSections = { sid, marker: firstMarkerLine(snap.text), texts }
          injectProbeState = injectProbe.record({
            at: Date.now(),
            marker: probeSections.marker,
            corpora: { 'system-prompt/sections': texts }
          })
        } catch { /* 探针失败 = 少一个数字,注入照旧 */ }
      }
    } catch { /* 注入失败绝不影响这一轮 */ }
    return target
  }), 'echo.snapshot()')
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent }, next) => {
    // v0.13.3 宿主契约:subagents.start 需要 parent agent 句柄。pre-step 与
    // turn/end 同轮先至 —— 在任何闸之前把 agent 存进 capture(fireReflect 拿它
    // 当反思子代理的 parent),顺带刷新路由 agent(日记用)。记忆注入已搬到
    // `system-prompt/assemble`(见上),这里只剩这一件事。
    //
    // v0.41.0:路由 agent(日记/漂移体检的 parent)**只认顶层会话** ——
    // pre-step 对子代理一样会响,以前这里会把 `routeAgent` 覆盖成子代理,
    // 于是日记/体检的 parent 变成内部会话(既是错误路由,也是递归的入口)。
    try {
      captureOf(agent.session).agent = agent
      if (!isSubagentSession(agent)) routeAgent = agent
    } catch { /* 拿不到 session 就算了,反思会显式 warn */ }
    return await next()
  }), 'echo.preStep()')

  // ---- 3. 轮后反思(M2-d):捕获对话流,turn/end 后走引擎门面 ----
  // 反思是增益不是依赖:引擎/子代理失败只跳过本轮,绝不影响主对话。
  // 串行闸:上一轮反思没跑完就不叠加(反思慢半拍是可接受的)。
  let reflecting = false
  let pendingReflect = null
  /**
   * v0.35.0 B4:反思(子代理那一趟)的留痕。
   *
   * 计划里 B4 要挂宿主 `subagent/start|end` —— 装机包实测那两个名字只在
   * `dsh-hooks-claude-code` 那座桥里,插件的 `ctx.on` 收不到。所以**在我们自己的
   * 调用点留痕**,而不是写一段永远不会响的监听:跑了几趟 / 上一趟多久 / 成没成 /
   * 为什么跳过,都进状态面(失败不许只活在宿主 stdout 里 —— P2 那次 45 小时静默的教训)。
   */
  const reflectStats = { ...REFLECT_STATS_SHAPE }
  // v0.14.5 S9:距上次治理扫描攒了几次真写入(A 是 per-session 计数,
  // DSH 单主人单库 —— 全局计数即等价物)。
  let writesSinceCleanup = 0
  const fireReflect = (capture) => {
    if (store === null || subagents === undefined) return
    // v0.14.2 先快照再判闸:capture 是**活的会话槽**,轮末处理完就地
    // 清空 —— 排队的若存同一个对象引用,补跑时只剩空串(实测:一轮
    // 反思窗口内攒下的 4 轮,全被自己的清理动作吃掉)。快照之后这个
    // 对象与槽位再无关系。
    const snap = snapshotCapture(capture)
    // v0.13.7 空捕获闸前置:辅助会话/子代理自己的轮末也走这个处理器,
    // 它们没有对话内容 —— 挡在排队之前,别白占队位(v0.13.6 实测:
    // 队位被一个 userLen=0 的空捕获占过,虽然后续无害,但会顶掉
    // 真正该补跑的那一轮)。
    // ★ 2026-10-19：空间评论轮 userText 是空的（那是别人的话）⇒ 用 qzoneComment 顶。
    if ((!snap.userText && !snap.qzoneComment) || !snap.assistantText) return
    // v0.41.0 事故修复:子代理会话的轮末**不反思**。它的「对话」是宿主投递的
    // 任务提示词(信封写死 `source:{kind:'user'}`)+ 内部 JSON,既不是他的
    // 话,也不该长成记忆;更要紧的是这一趟 reflection **本身是子代理**
    // ⇒ 从子代理里再起子代理,正是递归的另一半。判据与打分器共用一处
    // (lib/agent-scope.js);这里排在排队之前,别白占队位。
    if (isSubagentSession(snap.agent)) { reflectStats.subagentSkipped += 1; return }
    // 接受任务时冻结归属；已捕获为空也不能在排队补跑时认领新轮。
    if (snap.turnTraceCaptured !== true) {
      snap.turnTraceCaptured = true
      try { snap.turnTrace = String(turnTrace.of(snap.sessionId) || '') } catch { snap.turnTrace = '' }
    }
    if (reflecting) {
      // v0.13.6 忙时不再丢弃:排队最新一轮(中间轮自然合并),当前
      // 反思结束后补跑。慢模型下反思天然滞后对话 —— 滞后可以,漏记
      // 不行。
      pendingReflect = snap
      reflectStats.busySkipped += 1
      reflectStats.queueMerged += 1
      return
    }
    // v0.13.3 宿主契约:反思子代理的 parent = 本轮的 agent(pre-step
    // 存进 capture)。缺了就显式 warn 跳过 —— 不让 TypeError 沉底。
    const parent = snap.agent
    if (parent === null) {
      ctx.logger.warn('echo: reflect skipped — 本轮没有 parent agent(宿主 subagents.start 契约)')
      reflectStats.noAgentSkipped += 1
      return
    }
    reflecting = true
    const reflectAt = Date.now()
    const prevVector = store.getState().emotionVector
    // v0.16.0 M3:近重复闸阈值随轮次读配置(面板改完下一轮就生效)
    let reflectSettings = null
    try { reflectSettings = readSettings() } catch { reflectSettings = null }
    // 2026-10-06 C+B:先按 route 决议选路,并把"为什么走这条/为什么没跑"写进状态面
    // —— 面板上从此看得懂「反思这轮为什么没动」,不再是空白或一句 ⚠上次失败。
    const transport = reflectTransport(snap.sessionId)
    if (String(transport.note || '') !== '') reflectStats.lastNote = String(transport.note).slice(0, 60)
    const reflectRun = Promise.resolve()
      .then(() => engine.reflect(transport.transport, {
        // ★ 2026-10-19：空间评论轮没有 userText（别人的话不进那条通道）⇒ 用 qzoneComment 顶，
        //   并把来源标成 qzone、层级留空（不进 L0/L1）。他本人说话时这两个仍是原样。
        userText: snap.userText !== '' ? snap.userText : snap.qzoneComment,
        source: snap.userText !== '' ? 'dsh' : 'qzone',
        layer: '',
        assistantText: snap.assistantText,
        prevVector,
        sessionId: snap.sessionId,
        injectedMemories: snap.lastInjected,
        injectedProfile: snap.profileSnapshot,
        // 2026-10-09:主动开口轮(care / relay_proactive / care_silent)不走 claim ⇒ `snap.startedAt` 仍是**上一轮**的值,
                    // 于是把跨过的整段空闲算进 extract 的耗时(活库实测 1609707ms ≈ 27 分钟,而该轮只跑了 53 秒)✗
                    // 判据:**主动开口轮 · 没有起点 · 或超过 10 分钟** ⇒ 如实写 null(面板显示"—"),**不写错数**;
                    // 常规对话轮照旧按当轮起点算(实测 5–60 秒 ⇒ 秒级)✓ 历史脏值不清(见提交说明)。
                    latencyMs: (snap.proactive === true || snap.startedAt <= 0 || (Date.now() - snap.startedAt) > 600000)
                      ? null
                      : Math.max(0, Date.now() - snap.startedAt),
        dedupeSimilarity: reflectSettings === null ? undefined : reflectSettings.dedupeSimilarity,
        dedupeSummarySimilarity: reflectSettings === null ? undefined : reflectSettings.dedupeSummarySimilarity,
        // 行主键独立；轮关联沿任务快照传递，不在异步执行时重读当前轮。
        turnTrace: snap.turnTrace,
        turnTraceCaptured: snap.turnTraceCaptured,
        parent
      }))
      .then((result) => {
        // v0.35.0 B4:这一趟的留痕(耗时/成败/摘要首行)—— 状态面看得到,
        // 不必去翻宿主 stdout。
        reflectStats.runs += 1
        // 2026-10-05 方案 C:四格统计(成功/超时/排队/失败)+ 运行面 —— 拍板第 5 项
        // 「反思静默丢失要做统计面」。直调通道每轮把累计值抄进来,`echo_status`
        // 的 reflect 面因此看得见"哪一格在涨"。
        try {
          const ls = llmChannel.snapshot()
          reflectStats.llmMode = String(ls.mode || '')
          reflectStats.llmOk = ls.ok
          reflectStats.llmTimeout = ls.timeout
          reflectStats.llmQueued = ls.queued
          reflectStats.llmFailed = ls.failed
          reflectStats.llmSkipped = ls.skipped
          reflectStats.llmRunning = ls.running
          reflectStats.llmWaiting = ls.waiting
          // 2026-10-06:错误原文也要上来 —— 以前只抄计数,`llmFailed=2` 摆在那儿
          // 却看不到是适配器报错、还是思考吃光 maxTokens(终端也不一定有日志)。
          reflectStats.llmLastError = String(ls.lastError || '')
          reflectStats.llmLastChunks = String(ls.lastChunks || '')
          // ★★ 2026-10-21：**把舱壁的两池状态抄上来** —— 重启后的验收就看这两格：
          //   `llmPool.live` 有人在跑、`llmPool.bulk` 也有人在跑 ⇒ 两个池真的分开了。
          //   `llmLastMs` 是"这一趟直调花了多久"（判"是不是又被通道卡住"的第一眼）。
          reflectStats.llmLastMs = Number(ls.lastMs) || 0
          reflectStats.llmPool = (ls.pool === null || ls.pool === undefined)
            ? null
            : {
                live: { running: ls.pool.live.running, waiting: ls.pool.live.waiting },
                bulk: { running: ls.pool.bulk.running, waiting: ls.pool.bulk.waiting }
              }
        } catch { /* 统计面失败不影响反思留痕 */ }
        reflectStats.lastMs = Math.max(0, Date.now() - reflectAt)
        reflectStats.lastAt = Math.floor(reflectAt / 1000)
        reflectStats.lastOk = result !== null
        if (result !== null) {
          const summary = (result.extract && result.extract.summary) || ''
          reflectStats.lastNote = String(summary).slice(0, 60)
          ctx.logger.info('echo: extract ok — "' + String(summary).slice(0, 40) + '"'
            + ' (' + reflectStats.lastMs + 'ms)')
          // v0.21.0 E5:情绪余波 —— 判官说"忍不住还想补一句"就挂起(延迟
          // 2~5 秒,他再开口即撤)。整段 try/catch:余波是增益,出什么事
          // 都不该影响这一轮的记忆落地。
          try {
            sayAgain.schedule({
              agent: parent,
              sessionId: snap.sessionId,
              sayAgain: result.extract ? result.extract.sayAgain : 0,
              extraReply: result.extract ? result.extract.extraReply : '',
              traceId: randomUUID()
            })
          } catch (err) {
            ctx.logger.warn('echo: 情绪余波挂起失败(已忽略)— ' + String(err?.message ?? err))
          }
          // v0.14.5 S9:治理扫描挂在**写入节奏**上(A `main.py:1063-1069`:
          // 只有本轮真落库了才计数,每 cleanup_every 次扫一遍)—— 不另起
          // 时钟,也不在空写的轮次里白扫。
          const stored = Array.isArray(result.written)
            ? result.written.length > 0
            : Number(result.memoryId) > 0
          if (stored) {
            writesSinceCleanup += 1
            let st = null
            try { st = readSettings() } catch { st = null }
            const every = st === null ? 10 : st.cleanupEvery
            if (writesSinceCleanup >= every) {
              writesSinceCleanup = 0
              const ttlDays = st === null ? 30 : st.memoryTtlDays
              Promise.resolve()
                .then(() => engine.episodicCleanup(ttlDays))
                .then((r) => {
                  if (r !== null && Number(r.removed) > 0) {
                    ctx.logger.info('echo: 记忆治理 — 软删除 ' + String(r.removed)
                      + ' 条过期低分记忆(TTL ' + String(r.ttlDays) + ' 天)')
                  }
                })
                .catch((err) => {
                  ctx.logger.warn('echo: episodic cleanup failed — ' + String(err?.message ?? err))
                })
              // v0.42.0:会随时间**线性长**的三张行流水也一起清(2026-09-29 他的担心
              // 「时间长了会不会卡」的复查结论:子代理用完即弃、不攒;真正无上限的
              // 是这些行 —— care_beats 每拍一行,实测 10 小时 153 行)。与记忆治理
              // 同一个拍子(每 cleanupEvery 次写入),不另起时钟。
              try {
                const nowSec = Date.now() / 1000
                const nb = store === null ? 0 : store.pruneCareBeats({ now: nowSec, keepDays: ttlDays })
                const no = store === null ? 0 : store.pruneRelayOutbox({ now: nowSec, keepDays: ttlDays })
                const ni = store === null ? 0 : store.relayPruneInbox({ now: nowSec, keepDays: ttlDays })
                if (nb + no + ni > 0) {
                  ctx.logger.info('echo: 流水表治理 — care_beats ' + String(nb) + ' / outbox '
                    + String(no) + ' / inbox_seen ' + String(ni) + ' 行(保留 ' + String(ttlDays) + ' 天)')
                }
              } catch (err) {
                ctx.logger.warn('echo: 流水表清理失败 — ' + String(err?.message ?? err))
              }
            }
          }
        } else {
          // 2026-10-06:**失败也要把"为什么"顶到状态面** —— 以前失败时 lastNote
          // 停在调用前写的那句选路说明上(面板显示"继承本会话 route"),而真正的
          // 错因(适配器报错 / 思考吃光 maxTokens / 空产出)只活在通道内存里。
          const why = String(reflectStats.llmLastError || '')
          reflectStats.lastNote = (why !== ''
            ? '未成功:' + why
            : '未成功:这一轮没有产出(看 llm 计数与通道日志)').slice(0, 60)
          ctx.logger.warn('echo: extract 未成功 — ' + reflectStats.lastNote
            + ' (' + String(reflectStats.llmLastChunks || '') + ')')
        }
      })
      .catch((err) => {
        // v0.35.0 B4:失败也要进状态面(宿主日志会被刷走;"她今天反思全挂了"
        // 这种事必须有个能查的地方 —— 与 care_beats.writeFailed 同款纪律)
        reflectStats.runs += 1
        reflectStats.fails += 1
        reflectStats.lastMs = Math.max(0, Date.now() - reflectAt)
        reflectStats.lastAt = Math.floor(reflectAt / 1000)
        reflectStats.lastOk = false
        reflectStats.lastNote = '失败:' + String(err?.message ?? err).slice(0, 60)
        ctx.logger.warn('echo: extract failed — ' + String(err?.message ?? err))
      })
      .finally(() => {
        reflecting = false
        // v0.13.6 补跑排队轮(若有):链式,一次一条,不并发。
        const next = pendingReflect
        pendingReflect = null
        if (next !== null) fireReflect(next)
      })

    // ---- 2026-10-06:轮末异步判一次「她眼里的他」(拍板 ①②③④⑤⑥)----
    // 为什么**串在反思后面**而不是并行:两条路都会写 `emotion_vector`
    // (`reflect` 落完整向量、这边只并一个 `ipc_dyad` 键)—— 并行时后写的那一份会把
    // 对方的键整个覆盖掉。串行只多等一次判定的时间,而且**不占回复时延**
    // (他早就拿到回复了)。节流 / gain 门槛 / 失败留痕都在 `lib/ipc-appraise.js` 里。
    reflectRun
      .catch(() => null)
      .then(() => (ipcAppraiser === null
        ? null
        : ipcAppraiser.run({
          sessionId: snap.sessionId,
          userText: snap.userText,
          assistantText: snap.assistantText
        })))
      .then((out) => {
        if (out !== null && out !== undefined && out.ok === false && out.skipped !== true) {
          ctx.logger.warn('echo: 人际打分未判定 — ' + String(out.reason || ''))
        }
      })
      .catch((err) => {
        // 这一层兜底:打分是增益不是依赖,任何意外都不许影响记忆落地。
        ctx.logger.warn('echo: 人际打分失败(已忽略)— ' + String(err?.message ?? err))
      })
  }

  // v0.35.0 B4:把这一趟的留痕接到状态面(与 care/toolAudit 同款:闭包读,没起过就是 null)
  reflectState = () => ({ ...reflectStats, at: Date.now() })

  ctx.on('session/event', (session, event) => {
    try {
      if (!event || typeof event !== 'object') return
      const officialObservation = officialOwner.observeSessionEvent(session, event)
      const endingGroup = observeGroupParticipation(groupParticipation, session, event)
      try { forwardReader.observeSessionEvent(session, event) } catch { /* 无证明即拒绝继续读 */ }
      try { fileReader.observeSessionEvent(session, event) } catch { /* 无证明即拒绝文件读取 */ }
      try { fileSender.observeSessionEvent(session, event) } catch { /* 无原生轮次证明则不发送 */ }
      // v0.41.0 事故修复:子代理/辅助会话是「她自己内部的活」(EXTRACT、情绪打分、
      // 整固、漂移体检、日记组稿,以及宿主自己的子代理)—— **不是他这一轮说的话**。
      // 这里一律不往下走:不捕获(旧行为会把内部任务提示词当成他的话写进
      // conversation_log —— 活库那 71 行渠道为空的机器话里就有它们)、不记漂移窗、
      // 不出站、**轮末不反思**(fireReflect 那一趟也是子代理 ⇒ 递归的另一半)。
      // 判据只此一处(lib/agent-scope.js),与打分器/反思门/routing 共用。
      if (isSubagentSession(session)) return
      // v0.2.1 电源闸:休眠时不捕获、不反思 —— 她不偷听。
      if (!readEnabled()) return
      // (store 离线不短路整个 handler:范围标记活在 config.json,
      //  审计写入各自 try/catch;反思自身有 store 闸。)
      const capture = captureOf(session)
      // ---- 2026-10-06 方案 C:记住这条会话最近一次请求的 route ----
      // 出处:宿主 `request/header` 事件的 `header.config.provider/model`(与
      // `dsh-session-title-llm/lib/index.js:138-146` 的 resolveRoute 同源)。
      // 用途只有一个:反思直调通道**默认继承它** ⇒ 面板那两格从"必须填"
      // 降级成"覆盖项"。取不到就不放:决议那边会退回子代理并说明原因。
      if (event.type === 'request/header') {
        const route = routeOfRequestHeader(event)
        const sid = String(session?.id || '')
        if (route !== null && sid !== '') sessionRoutes.set(sid, route)
        return
      }
      if (event.type === 'user/message') {
        const msg = messageOfEvent(event)
        if (msg === null) return
        // 工具结果不是对话;超长"用户消息"几乎必是注入的文档/技能内容
        if (msg?.source?.kind === 'tool') return
        // 本插件的心声通道(M3-a)不是「你说的话」:她开口不算你来过
        // (想念脉冲不削减),也不走下面的人话分支。但这一轮**是**对话
        // 的一部分 —— v0.14.5 S11:给它盖个哨兵(与 A 的
        // PROACTIVE_ROUND_MARKER 同字面),轮末照 A 记进对话窗口,
        // 免得反思的最近 5 轮里出现一行空的「用户：」,让模型把她自己
        // 说的话当成你说的。
        // v0.17.0 R2:平台中继注入的人话**不是**她的心声 —— 信封上带
        // form='relay',必须在这里分开:否则 QQ 上说的每句话都会被当成
        // 「她自己开口」,想念不落地、回复被标成主动话(主动范围闸会拦住)。
        // 2026-10-03:注入形状升为"产出者自有"kind(`plugin:dsh-echo`,v4 格式要求)
        // —— 用容错判定,旧形状(v3 历史/迁移前的日志)照样认得出。
        if (isEchoSource(msg?.source)
            && formOf(msg?.source?.form) !== FORM.INBOUND) {
          // ★ 2026-10-15 修「每次回答都追一句关怀」:插件**自己注入**的轮
          // (care / reminder / wake / mind / say_again / longing-steer / snapshot…)
          // **不是平台轮** —— 它没有任何人发言,`fromPlatform` 会停在轮首的
          // `null`,而 `turn-stopping` 对 `null` 是 **fail-open(当平台轮)**
          // ⇒ 这些轮轮末也会被要求"补一句想念",于是**同一轮多出第二条
          // assistant 消息**(症状:关怀/回话说完又追一句想念;heart-tts 还会
          // 把它当用户抢话,砍掉正常回复正在播的音频)。
          // 这里显式记成 `false`(= 这一轮的来源是**插件**,不是平台)。
          // ⚠️ `null` 的 fail-open 语义**一字不动**:来源真未知时仍照旧补,
          // 不碰 `turn-stopping` 的纯函数与其测试。
          capture.fromPlatform = false
          // 2026-09-26 现场(他在 DSH 里说话,回复跑到 QQ):这里原来「除了 relay
          // 都算她开口」,可每轮都有的 `form:'snapshot'` 记忆/心情快照也中招 ——
          // 整轮被盖成「她主动」,主动那条路绕过两道闸,把本地轮次推到了 QQ。
          // 现在只有**她真的开口**的那几种 form 才算 —— 判据在 lib/relay.js 的
          // `marksProactive` 里(白名单,不是黑名单:以后新加的注入 form 默认不算)。
          // 红线 `lib/relay.js` 的判据仍按旧形状认我们(`kind==='plugin'`)——
          // 这里折一个兼容视图喂它:新格式落盘、旧判据一字不动。
          if (marksProactive(legacySourceView(msg.source))) {
            try {
              const cap = captureOf(session)
              // 哨兵要用它(见下面 turn/end 的 PROACTIVE_ROUND_MARKER):
              // 「这轮是她起的头」这个事实**不变**,变的是**出站路由**(见下)。
              cap.proactive = true
              const srcForm = String(msg.source.form || '')
              // 2026-10-05 P2(拍板 4):**余波(say_again)不进主动路由**。
              // 它从 v0.21.0 E5 起就在白名单里(lib/relay.js 的 VOICE_FORMS),
              // 于是这条 2~5 秒后的注入被盖成「她起的头」⇒ relay 的主动分支在
              // **本地会话没绑渠道**时退到全库兜底(relay.js 的渠道解析),把余波
              // 自动推到了 QQ —— 那不是她调 skill,是系统替她决定发 QQ。
              // 现在余波降级成本地轮次:照旧显示、照旧朗读、照旧进对话窗口,
              // QQ 不再自动收到;她真想跟<称呼>说,走她的手 `echo_qq_say`
              // (lib/relay-tools.js,这条路一直都在,不需要新加)。
              // ⚠️ 关怀/提醒/心声/闹钟(care/reminder/mind/wake)**照旧**盖主动章 ——
              // 那是她"该提醒<称呼>"的主动行为,不是被系统替她决定。
              if (srcForm === 'say_again') {
                cap.sayAgainLocal = true
              } else {
                // 2026-09-29:同一时刻告诉出站那一侧「这一轮是她起的头」——
                // 她随后用手(`echo_qq_say`)说的那句因此记成 `proactive`,
                // ack 时才兑现得了待兑现账(降权/安抚/议程)。
                // 之前没这一步 ⇒ 她亲手送出去的关怀被记成 `reply`,
                // `noteProactiveAcked` 只认 `proactive` ⇒ 账永不兑现(见 relay.js 的 say)。
                try { speaker?.markProactive?.(String(session?.id || '')) } catch { /* 标不上只是这一路少一层 */ }
                // v0.18.1:这一轮是**提醒**还是**关怀**要带到出站口 —— 只有关怀
                // 吃 A 侧那条「组稿超长即沉默」闸。
                // v0.31.0 P2:闹钟(wake)在**出站**上按提醒(reminder)同级走 ——
                // 那件事是事先定好的,不许被「组稿超长即沉默」那条闸吞掉
                // (relay.js 的 kind 分支只认 proactive/reminder,所以这里归一成 reminder)。
                cap.proactiveKind = (srcForm === 'reminder' || srcForm === 'wake') ? 'reminder' : 'proactive'
              }
            } catch { /* 拿不到会话就算了 */ }
          }
          return
        }
        // P2-A 渠道闸:`form='relay'` = 平台(QQ)递进来的人话 ⇒ **平台轮**。
        // 只认这一种;下面的人话分支才是"他直接在 DSH 里说"。快照/工具/runtime
        // context 一律不动这个标记(它们既不是平台轮也不是他在说话)。
        if (isEchoSource(msg?.source) && formOf(msg?.source?.form) === FORM.INBOUND) {
          capture.fromPlatform = true
        }
        const text = (msg?.source?.hasSupplementalContent === true ? relayFactText(msg, textOf(msg)) : textOf(msg)).trim()
        // 2026-09-26 现场(他问「为什么会出现那么多奇怪的记忆」):宿主每轮注入的
        // runtime context 被当成「他说的话」捕获了 —— 活库 conversation_log
        // 最近 5 行里 4 行正文就是那段。它不是他的话:不进对话窗口、不喂反思、
        // 不长成记忆。(它仍会进模型上下文 —— 那是宿主的事。)
        // 判据在 lib/inbound-filter.js(纯函数,白名单:只认真的人话)。
        if (!isHumanUtterance(text)) {
          // 034：真实空原话的主人语音/文件只记到访，不造文字或进入事实提取。
          if (receiptPresence.note({ session, message: msg, capture })) return
          try { capture.hostNoise = (capture.hostNoise || 0) + 1 } catch { /* 计数而已 */ }
          return
        }
        // P2-A:走到这里的是**人话**。⚠️ 平台轮(relay)也走这条分支(它
        // 是"他说的话"),所以**不许覆盖**上面标好的 `true` —— 只有在还没标成平台轮
        // 时才落 `false`(= 他就在这条会话里直接跟她说话)。
        if (capture.fromPlatform !== true) capture.fromPlatform = false
        // v0.31.0 P2:他说话了 ⇒ 心跳的空拍退避**立刻复位**(Cortico:任何外部事件复位)。
        // 为什么重要:退避是为了"没人理的时候少打扰",他一开口这条前提就没了 ——
        // 而"他刚说话"往往正是她想接话的时刻,不能还在睡 8 分钟。
        try { heartbeat.noteExternalEvent() } catch { /* 心跳没起来就下轮再说 */ }
        // v0.9.0 会话范围标记:「Echo 上线 / Echo 下线」切换当前会话。
        // 先于范围闸执行 —— 新会话没聊过也能用标记开门(鸡生蛋不
        // 存在);改完广播 system-prompt/change,提示词缓存立即失效,
        // 下一个模型步就按新状态组装。消息照常流入对话:她(或纯
        // agent)自然回应,不用系统腔确认。
        const marker = parseSessionMarker(text)
        if (marker !== null || looksLikePowerTalk(text)) {
          const sid = String(session?.id || '')
          if (marker !== null) {
            setSessionOn(sid, marker === 'on')
            try { ctx.emit('system-prompt/change') } catch { /* 广播失败无妨,下轮组装自然重读 */ }
            try {
              store?.writeAudit({
                traceId: 'marker-' + randomUUID(),
                userInput: (marker === 'on' ? '(Echo 上线标记)' : '(Echo 下线标记)') + ' 会话 ' + sid,
                toolCall: marker === 'on' ? 'session_on' : 'session_off'
              })
            } catch { /* 审计尽力而为 */ }
            ctx.logger.info('echo: session ' + sid + ' → ' + (marker === 'on' ? 'ON' : 'OFF') + ' via marker')
          }
          // 2026-09-26:**必有回话**。旧版解析失败时一声不吭 —— 他发了
          // 「Echo 下线吧」,系统静默,他以为开关坏了(它确实坏了,但
          // 静默让故障不可见)。现在无论成功与否都回一句状态,由她自己的
          // 声音说(注入一条 plugin 消息,form='power-note'),不占用
          // 他的对话轮次。
          try {
            const now = readPower()
            const on = sessionEnabled(sid)
            const note = marker === null
              ? '【系统·开关】他刚才那句像是要拨开关,但没认出来。现在:总闸=' + (now.enabled ? '在线' : '休眠')
                + ',这条会话=' + (on ? '开' : '关') + '。用一句短的告诉他当前状态,并说清可以发「Echo 下线」/「Echo 上线」。'
              : '【系统·开关】他刚把这条会话拨到' + (marker === 'on' ? '上线' : '下线') + '(总闸='
                + (now.enabled ? '在线' : '休眠') + ')。用一句短的确认,别用系统腔。'
            capture.powerNote = note
          } catch { /* 拿不到就算了,不影响这一轮 */ }
        }
        // v0.9.0 会话范围闸:范围外的会话对她是隐形的 —— 不捕获、
        // 不反思、不削减想念(工作会话不算陪伴,她想的是没来找她
        // 的你)。
        if (!sessionEnabled(String(session?.id || ''))) return
        // v0.21.0 E5:他开口了 = 抢话 ⇒ 撤掉还没送出的那句情绪余波
        // (A `main.py:1421-1426` 的 `_cancel_pending_say`)。放在范围闸
        // **之后**:范围外的会话本来就没有余波可撤。整段 try/catch ——
        // 撤回失败绝不能影响这一轮他真正说的话。
        try { sayAgain.bump(String(session?.id || '')) } catch { /* 撤回尽力而为 */ }
        if (text) {
          // v0.18.2 C6(同族缺陷的另一半):以前这里是「超过 2000 字就**不捕获**」,
          // 于是"他贴了一段长文"这一轮在会话语录、漂移窗、反思信封里**整个消失**
          // (用户行变空,她像没听见)。A 侧没有这条闸。
          // 现在改成截断捕获:那一轮留下了,内容按 2000 字截(反思信封自己另有
          // 1500/300 的裁剪,不靠这里兜)。
          //
          // ★ 2026-10-15 加群聊：**只有他本人说的话才记账。**
          //   群里别人的话仍然进模型上下文（她要看得见才回得了），但**不写这里**
          //   ⇒ 不进会话记录、不进漂移窗、不进反思信封（他定的："其他人的消息
          //   不进记忆和反思，只有我的消息进"）。
          //   判据用**信封里已有的** `isMaster`（`lib/relay.js` 的 `sender.isMaster`），
          //   不是新字段 —— 渠道负责"谁能进来"，主包负责"进来了算什么"。
          const fromRelay = isEchoSource(msg?.source) && formOf(msg?.source?.form) === FORM.INBOUND
          const speakerIsMaster = !fromRelay || msg?.source?.isMaster === true
          if (speakerIsMaster) {
            capture.userText = text.length > 2000 ? text.slice(0, 2000) : text
            // v0.14.5 S10:本轮起跑时刻 —— 轮末写审计时算 latency(她这轮
            // 花了多久);审计的 latency 列此前永远是 NULL。
            capture.startedAt = Date.now()
          } else {
            // 群里别人的话：只让她"看见"，不进账。留一个计数，面板/审计能看出发生过。
            try { capture.guestSaid = (capture.guestSaid || 0) + 1 } catch { /* 计数而已 */ }
          }
        }
        // v0.15.0 S13:轮首取一次漂移强化期(A `main.py:1142-1148` ——
        // 读+递减在这里发生,之后本轮的注入只读这个标记)。放在轮首是
        // 因为 pre-step 可能一个回合跑多步(工具调用),而 A 的强化计数
        // 是**按轮**走的:每步都减会 3 轮变 3 步。
        try { capture.driftReinforce = drift.beginRound(String(session?.id || '')) } catch { }
        // sessionId 供引擎侧悬置话题登记(b4 帧);拿不到就空串
        try { capture.sessionId = String(session?.id || '') } catch { }
        // (v0.29.0:渠道维度捕获随群聊拒收一起退役 —— 记忆不再带渠道,
        //  详见 CHANGELOG v0.29.0。)
        // v0.19.0 D2:按 id 记一份(self.sessionId 已就位),给轮末硬保证
        // 当对象身份对不上时的兜底。有界:只留最近 64 个会话。
        if (capture.sessionId !== '') {
          captureBySid.delete(capture.sessionId)
          captureBySid.set(capture.sessionId, capture)
          if (captureBySid.size > 64) {
            const oldest = captureBySid.keys().next()
            if (!oldest.done) captureBySid.delete(oldest.value)
          }
        }
        // 想念脉冲接线(M3-a):真人消息 → 引擎削减 + 锚点重置 +
        // 冷启动回填 + 会话路由刷新。fire-and-forget:想念是背景
        // 情绪,不阻塞对话路径;引擎不在就跳过(下条消息再试)。
        // v0.6.0 先读后削:帧带回削减前后的双值,削减前的想念
        // (她等你时的值)存进本轮捕获 —— pre-step 注入【想念】行
        // 用。语义与 AstrBot 相同:人到了,想念才落地;开口前她
        // 先知道自己有多想你。
        // v0.18.2 C6:以前这里有一条「正文超过 2000 字就不发这一帧」的豁免 ——
        // **贴一段长文就把想念削减整条绕过去了**:想念不落地、锚点不重置、
        // 抗议窗口还按旧时刻判。A 侧无条件调(`echo_longing.py:195-200`)。
        // 引擎拿 text 只做一件事:算"满足量"系数
        // `0.5 + 0.5*min(1,(len-2)/38)` —— 40 字就饱和,所以送前 400 字
        // (10 倍饱和点)在数学上逐位一致,又不会让一整篇长文撑爆这一帧。
        if (engine !== null && text) {
          // v0.14.4 移植缺口 S4:想念参数走配置(引擎 merge_config 一直在等)
          capture.longingRead = engine.longingMessage(
            MASTER_ID, text.slice(0, 400), capture.sessionId, readSettings().longing)
          capture.longingRead.catch(() => { })
        }
      } else if (event.type === 'assistant/message') {
        const msg = messageOfEvent(event)
        // 2026-10-05 拍板 2-B(2026-10-07 换 XML 语法):文字渠道剥掉 `<emo>`/`<skip>` 标签
        // ① QQ 出站(下面 captureSegment)、② 对话记录/漂移(assistantText)、
        // ③ 反思输入。**不影响 heart-tts**:它自己订阅 `agent/assistant-stream`
        // 拿原始文本、在 TTS 层剥(两个消费者各剥一次,互不干扰 —— 它按句挑语气
        // 用的正是被这里剥掉的那串标记,所以**绝不能**在更上游统一剥)。
        const text = msg === null ? '' : stripEmoMarkers(textOf(msg).trim())
        if (text) capture.assistantText = text
        // v0.19.0 D2:整轮累积(有界 4000 字,只给"想念说没说"的判定用)。
        if (text) capture.turnText = (capture.turnText + '\n' + text).slice(-4000)
        // v0.17.0 R2:出站捕获。她一个回合可能分好几条(边调工具边说),
        // 按会话攒着,turn/end 时合成一条再入队(QQ 有频率限制)。
        try { if (text && !officialObservation.suppressLegacy) speaker.captureSegment(String(session?.id || ''), text) } catch { }
      } else if (event.type === 'turn/end') {
        // v0.11.0 对话记录(M8-a):一轮一行,全局滚动 100 轮(用户
        // 裁决),channel = 来源标签写时快照。只有范围内心仪会话进
        // 日志 —— 判闸必须用真实 session 对象取 id:范围外会话的
        // capture.sessionId 是空串(范围闸先 return),空串在 all
        // 模式下判「启用」,工作会话的纯 agent 回复会漏进来。
        // 关怀/提醒轮(v0.14.5 S11):用户侧记哨兵而不是空串 ——
        // 回放能看出「这轮是她主动开口」,反思信封也不会出现假的空用户行。
        if (capture.proactive && !capture.userText) capture.userText = PROACTIVE_ROUND_MARKER
        try {
          const convSid = String(session?.id || '')
          if (store !== null && (capture.userText || capture.assistantText) && sessionEnabled(convSid)) {
            store.writeConversation({
              sessionId: convSid,
              channel: sessionLabel(convSid),
              userText: capture.userText,
              replyText: capture.assistantText
            })
          }
        } catch { /* 记录尽力而为,不绊反思 */ }
        // v0.15.0 S13:漂移体检的滑动窗口(A `main.py:1051-1060` 的同位:
        // 记一轮 → 计数 → 每 driftEvery 轮体检一次)。与对话记录同一道
        // 范围闸,窗里的内容与回放看到的一致。
        try {
          const convSid = String(session?.id || '')
          if ((capture.userText || capture.assistantText) && sessionEnabled(convSid)) {
            drift.recordRound(convSid, capture.userText, capture.assistantText)
            if (drift.shouldCheck(convSid)) fireDriftCheck(convSid)
          }
        } catch { /* 体检是增益不是依赖:窗口记不上就跳过体检 */ }
        fireReflect(capture)
        // v0.17.0 R2:回合收尾 → 出站入队。kind 由 capture.proactive 定
        // (她主动开口 → 'proactive',有保鲜期、受范围闸约束;被搭话 →
        // 'reply',必达)。没有渠道绑在这个会话上时静默无操作。
        try {
          // 2026-10-05 P2(拍板 4):余波轮(`sayAgainLocal`)**不盖主动** ⇒ relay 走
          // 「本地轮次」分支(relay.js:`initiative` 为假 + `pushLocalTurns` 默认 false)
          // ⇒ 不入队、QQ 收不到。DSH 显示与朗读一个字不受影响
          // (`capture.proactive` 仍为 true,哨兵照旧)。
          const sayAgainLocal = capture.sayAgainLocal === true
          const r = officialObservation.suppressLegacy ? { queued: 0 } : speaker.finishTurn(String(session?.id || ''), {
            groupParticipation: endingGroup,
            proactive: capture.proactive === true && !sayAgainLocal,
            // v0.18.1:提醒与关怀在出站口不是同一种东西 —— A 侧提醒走模板兜底、
            // 没有「组稿超长就沉默」那条闸(`main.py:1852` 只在关怀那侧)。
            kind: (capture.proactive === true && !sayAgainLocal && capture.proactiveKind)
              ? capture.proactiveKind
              : undefined
          })
          if (r.queued > 0) ctx.logger.info('echo: relay out → ' + r.queued + ' 条队列(' + r.chars + ' 字)')
          // 2026-09-26 裁定后:入站默认**不自动回**,等她调 echo_qq_say。
          // 所以「她没回」必须是可观测的 —— 记一笔,别让它变成静默。
          else if (r.held === true) ctx.logger.info('echo: 入站未自动回(QQ 是她的手,等她调 echo_qq_say)— ' + String(session?.id || ''))
        } catch (err) {
          ctx.logger.warn('echo: relay 出站入队失败 — ' + String(err?.message ?? err))
        }
        // v0.14.0 F1 轮末图谱回传:本轮想起的边一次性交回引擎
        // (apply_ltp 权重增强 + 时钟前移 + 物化/剪枝节流)。取走即清,
        // 免得下一步的轮末把同一批边再回传一次。fire-and-forget:
        // 回传失败只是这一轮的强化丢了,对话与反思都不受影响。
        const hits = capture.graphHits
        capture.graphHits = null
        // v0.14.4 移植缺口 S3:不再「非空才发帧」—— 物化(10 分钟桶)
        // 与剪枝(1 小时桶)都挂在这一帧里,空集也发才能让桶准点推进
        // (A 侧每轮无条件调用;引擎侧空 user_hit_ids 照常按桶走)。
        const payload = {
          hitEdgeIds: [...((hits && hits.hitEdgeIds) || [])],
          ltpEdgeIds: [...((hits && hits.ltpEdgeIds) || [])]
        }
        Promise.resolve()
          .then(() => engine.reinforceGraph(payload))
          .then((r) => {
            if (r !== null) {
              ctx.logger.info('echo: graph reinforce — ltp=' + String(r.ltp)
                + ' reinforced=' + String(r.reinforced) + ' pruned=' + String(r.pruned))
            }
          })
          .catch((err) => {
            ctx.logger.warn('echo: graph reinforce failed — ' + String(err?.message ?? err))
          })
        // v0.14.1 F4 命令式提醒:确定性登记。Judge 漏登记是天性(A 侧
        // 实测两次漏掉明确的「提醒我X」,嘴上答应了系统里却没有这条
        // 约定,提醒永远不响)—— 命令不该走概率。时间解析在引擎侧
        // (壳只交原话);requireTime 项换算不出时间由引擎丢弃。
        const reminder = detectReminder(capture.userText)
        if (reminder !== null) {
          const rid = String(session?.id || '')
          Promise.resolve()
            .then(() => engine.threadsIngest(MASTER_ID, reminder.raw, rid, [
              // dueWindowSec:A 侧 `main.py:2088-2094` 的 ±120s 到期防重 ——
              // Judge 若已登记同一场约定(措辞不同、到期几乎相同)就并成
              // 一条,免得他收到两次催办。
              { content: reminder.task, followUpAfterText: reminder.raw, requireTime: true, dueWindowSec: 120 }
            ]))
            .then((r) => {
              if (r === null) return
              const made = (r.threads || []).filter((t) => t.created).length
              if (made > 0) {
                ctx.logger.info('echo: 命令式提醒已登记 — 「' + reminder.task.slice(0, 30) + '」')
              }
            })
            .catch((err) => {
              // A 侧 v8.5.4 的血泪:这里曾静默吞掉一次真实失败,约定丢
              // 了而无人知晓 —— 行为层失败必须留痕。
              ctx.logger.warn('echo: 命令式提醒登记失败,这条约定可能丢失 — '
                + String(err?.message ?? err))
            })
        }
        capture.userText = ''
      capture.qzoneComment = ''
        capture.assistantText = ''
        capture.turnText = ''
        capture.lastInjected = ''
        capture.longingRead = null
        capture.powerNote = ''
        // v0.17.0 R2:主动标记**必须归零** —— 它此前只在「她自己开口」时
        // 置 true 而从不复位,下一轮真人搭话会带着上一轮的标记(出站会
        // 被误判成主动话:被范围闸拦住,还得吃 5 分钟保鲜期)。
        capture.proactive = false
        // 2026-10-05 P2:余波标记同样归零(理由同上:标记只在本轮有效)
        capture.sayAgainLocal = false
        // P2-A:来源标记同理 —— 只在本轮有效(下一轮重新判)。
        capture.fromPlatform = null
      }
    } catch (err) {
      ctx.logger.warn('echo: session event handler failed — ' + String(err?.message ?? err))
    }
  })

  /**
   * 2026-09-30 P4a:她自由活动的**执行体**(空闲触发那档的"手")。
   * 2026-09-30 P4b:多了 `kind`(`diary` | `memory`),但**没有**多出模型调用点。
   *
   * 分工:心跳只判"该不该动"(纯函数 `planActivityTick`,额度/夜闸/空闲/防重复),
   * 这里只负责"怎么动"。三条纪律落在本函数里:
   *
   *   ① **复用既有管线**:`diary` 一类的组稿走 `lib/diary.js` 的 `composeDiary`
   *      (取数也与日记那一段同一份:当天审计 + 心情 + 想念 + 新记忆);
   *      `memory`(整理记忆)一类走**策展管线**(`lib/soul-snapshot.js` 的只读
   *      快照 + `lib/her-activity.js` 的 `composeTidyText`)—— 那条**一个模型都不调**。
   *      两条路都**不新增调用点**,也不起第二种组稿方式。
   *   ② **只落盘,不写主表**:日记表那一页仍由 22:30 的既有管线写 ——
   *      空闲触发若也去写表,当天那一页会**提前**在(可能什么素材都没有的)凌晨
   *      落地,22:30 那条"一天一页"的幂等就会把它跳过 ⇒ 那是**改日记的既有行为**,
   *      不许(施工图 §3.5 卫生纪律:一批只干一件事)。所以产出只走
   *      **工作目录里的文件**(`lib/her-activity.js` 的 `writeActivityFile`)。
   *      `memory` 一类同理:整理**只出报告**,不去 commit 整固(那会推游标 + 改主记忆)。
   *   ③ **不污染主记忆**:这里既不写 `episodic_memory`,也不碰图谱/L0;
   *      落盘 + 台账(`care_beats`,kind='activity')就是它的全部痕迹。
   *      (整理那一类读快照走的是 `readOnly` 连接,见 `lib/soul-snapshot.js`。)
   *
   * 失败只回 `{ok:false, error}`(不抛):"失败即不动"是这一档的纪律 ——
   * 她的心跳不该因为一页日记而整拍炸掉。没实现的 `kind` **不硬做**,记
   * `kind-not-implemented`(由心跳那边落成 `failed` 账)。
   *
   * @param {{dateKey?:string, dir?:string, kind?:string}} [opts]
   * @returns {Promise<{ok:boolean, dateKey?:string, path?:string, chars?:number,
   *                    mood?:number, removed?:number, kept?:number, error?:string}>}
   */
  async function runHerActivity ({ dateKey = '', dir = '', kind = 'diary' } = {}) {
    const key = String(dateKey || todayKey())
    const what = String(kind || ACTIVITY_KIND_DEFAULT).trim().toLowerCase()
    const root = String(dir || companionCwd() || '')
    if (root === '') return { ok: false, error: 'no-dir' }

    // ---- 整理记忆(P4b):**零模型调用** —— 复用策展管线(只读快照 + 纯渲染)----
    // 为什么是这条:它是既有的、压缩域早就在用的那一条(`lib/compaction.js:99-100`),
    // 而且**只读** ⇒ 天然满足"不污染主记忆"。空快照不写成"整理"(不拿 fallback 冒充)。
    if (what === 'memory') {
      try {
        const nowSec = Math.floor(Date.now() / 1000)
        const snapshot = readSoulSnapshot(dbPathOf(), nowSec)
        const text = composeTidyText(snapshot, { now: nowSec })
        if (String(text).trim() === '') return { ok: false, error: 'nothing-to-tidy' }
        const w = writeActivityFile(root, { dateKey: key, content: text, kind: 'memory' })
        if (w.ok !== true) return { ok: false, error: String(w.error || 'write-failed'), path: String(w.path || '') }
        return {
          ok: true,
          dateKey: key,
          path: w.path,
          chars: String(text).length,
          removed: Number(w.removed) || 0,
          kept: Number(w.kept) || 0
        }
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) }
      }
    }

    // ---- 写一页日记(P4a,默认那一类)----------------------------------------
    // 别的值**不硬做**,留 failed(消费端与这里同一个判据:不许静默降级成 diary)。
    if (what !== 'diary') return { ok: false, error: 'kind-not-implemented' }
    if (subagents === undefined || subagents === null) return { ok: false, error: 'no-subagents' }
    try {
      // 素材 = 与日记管线**同一份取数**(照 60s 那条日记拍逐行对齐,不另起口径)
      const midnight = midnightOfKey(key) ?? new Date()
      const audits = store.listAudit(midnight.getTime() / 1000 - 1, 30)
        .filter((r) => r.toolCall !== 'diary') // 不自引:日记不进日记素材
        .reverse()
      const learned = store.db.prepare(
        'SELECT summary FROM episodic_memory WHERE timestamp >= ? AND is_active = 1'
        + ' ORDER BY timestamp ASC LIMIT 10'
      ).all(midnight.getTime() / 1000).map((r) => r.summary)
      const st = engine !== null ? await engine.longing(MASTER_ID, readSettings().longing) : null
      const lg = st !== null ? st : (store.longingRows()[0] ?? null)
      const page = await composeDiary(subagents, {
        dateKey: key,
        audits,
        mood: store.getState().moodIntensity,
        longing: lg === null ? null : { value: lg.value, threshold: lg.threshold, sinceMessage: lg.sinceMessage },
        learned
      }, routeAgent)
      if (page === null || page === undefined) return { ok: false, error: 'compose-null' }
      const w = writeActivityFile(root, { dateKey: key, content: page.content, kind: 'diary' })
      if (w.ok !== true) return { ok: false, error: String(w.error || 'write-failed'), path: String(w.path || '') }
      return {
        ok: true,
        dateKey: key,
        path: w.path,
        chars: String(page.content || '').length,
        mood: Number(page.mood) || 0,
        removed: Number(w.removed) || 0,
        kept: Number(w.kept) || 0
      }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  }

  // ---- 3.5 关怀心跳(M3-a):她在你不在的时候想你 ----
  // 投递层自建(schedule 先例):agent/created 只认根代理,每代理
  // 60s 定时器驱动 tick;agent.ctx.effect 作用域 —— 代理关闭自动
  // 清扫,插件卸载全量回收。tick 自身串行重入安全;电源休眠/会话
  // 范围外/引擎不在/会话不匹配/日上限都在 tick 内闸掉,定时器只管
  // 叫醒。
  const heartbeat = createHeartbeat({
    engine, store, logger: ctx.logger, isEnabled: readEnabled,
    isSessionEnabled: sessionEnabled,
    createUserMessage, masterId: MASTER_ID,
    // v0.14.4 移植缺口 S4/S5:调参与兴趣由壳读,心跳不再吃默认值
    getLongingConfig: () => readSettings().longing,
    getInterests: readInterests,
    // v0.14.5 S12 接地字段:主动开口时的称呼与人格锚点(A 的
    // `_master_alias` / `persona_anchor_text`)
    getAlias: () => {
      try {
        const p = store === null ? null : store.getProfile()
        return (p && p.name) || '用户'
      } catch { return '用户' }
    },
    getPersonaAnchor: () => String(personaCache.prefix || ''),
    // v0.22.0:议程簿开关(A `main.py:1818` 只在**取用**那一步设门 ——
    // 登记照旧,关掉只是"她不再主动提议程里的事")
    getAgendaEnabled: () => {
      try { return readSettings().agenda?.enabled !== false } catch { return true }
    },
    // v0.31.0 P2:夜闸开关(判**她自己的闹钟**用 —— 想念那条由引擎判)。
    // 默认 true;只有面板上明确关掉(=== false)才不压。
    getNightHold: () => {
      try { return readSettings().longing?.night_hold !== false } catch { return true }
    },
    // v0.31.0 P2:两个行为开关(账本本身不设开关,它是"失败可见"的地板)。
    getBackoff: () => {
      try { return readSettings().heartbeatBackoffEnabled !== false } catch { return true }
    },
    getWakeEnabled: () => {
      try { return readSettings().wakeEnabled !== false } catch { return true }
    },
    // 2026-09-29 他裁定:**删掉**「他正在干活 ⇒ 这一拍不插话」这条闸
    // (连 `quietWhileWorking` 设置项一起删 —— 他要在干活时也收得到她的话)。
    // 旧判据读的是"这一拍 tick 到的那条会话最近有没有跑工具",于是她开不开口
    // 取决于竞速抽到哪条会话。数据源 `store.recentToolCallAt` 留着(别处有用)。
    //
    // 开口目标(取代旧的"她锚的会话必须 == 这一拍 tick 到的会话"):
    // **她那一条会话** —— `ensureCompanion()` 自带「活的就用 / 存档的 resume /
    // 都没有就新建」,正是他说的「先检查哪个会话可用,没有就新建一条」。
    // QQ 入站(`relay.js`)与启动常驻走的都是这一条 ⇒ DSH 直接聊与 QQ 共用
    // 同一条会话,上下文连贯;QQ 那边只是多调一次工具把话说出去。
    // ⚠️ 心跳只在真的要开口时才调它(`targetFor` 里),所以不会每分钟建会话。
    //
    // 2026-09-29 裁定 A 之后,这条 = `resolveCompanion()`:她在**他正在用的
    // 那条会话**里开口(和 QQ 入站同一条),挑不出来才退回陪伴会话 ——
    // 「一条对话线」对两个方向都成立。
    resolveCareTarget: () => resolveCompanion(),
    // v0.40.0 C5:过期失效检查的两个读数 —— 阈值(小时)+ "他最后说话是什么时候"。
    // 阈值是可调的调参项(默认 24 小时):闹钟/约定晚了超过它就作废(约定还要
    // 叠上"他中间说过话"才是过期)。读数一律来自审计表(原始账)。
    getStaleHours: () => {
      const v = Number(readSettings().staleHours)
      return Number.isFinite(v) && v > 0 ? v : 24
    },
    getUserSpokeAt: (sid) => {
      try {
        if (store === null || typeof store.recentUserTurnAt !== 'function') return 0
        // 窗口:阈值本身决定的 —— 比阈值更早的"他说过话"不算数
        const hours = Number(readSettings().staleHours)
        const win = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600 * 2
        return store.recentUserTurnAt(String(sid ?? ''), Date.now() / 1000 - win)
      } catch { return 0 }
    },
    // ---- 2026-09-30 P2:主动性 v2(话题打分 + 边缘区复核)。默认关 ----
    // 配置整组由壳读(与其它调参项同款);心跳只认一个判据:`enabled === true`。
    getProactiveScoring: () => {
      try {
        const s = readSettings().proactiveScoring
        return (s && typeof s === 'object') ? s : null
      } catch { return null }
    },
    // **唯一新增的模型调用点**(施工图 §3.5 决定①,受边缘区 + 日额度双重约束):
    // 走的就是反思/情绪同款的结构化调用(runStructured),超时即"未过"(沉默)。
    reviewTopic: (opts) => reviewOnce({
      ...opts,
      run: (prompt, schema, parent) => callTransport(reflectTransport().transport, {
        prompt,
        schema,
        label: 'echo-topic-review',
        parent,
        signal: null
      })
    }),
    // ---- 2026-09-30 P4a:她的自由活动(空闲触发)。默认关 ----
    // 配置整组由壳读(与其它调参项同款);心跳只认一个判据:`enabled === true`。
    getHerActivity: () => {
      try {
        const a = readSettings().herActivity
        return (a && typeof a === 'object') ? a : null
      } catch { return null }
    },
    // 产出落在**她的工作目录**(= 陪伴会话的 cwd;默认 `~/.dsh/echo/workspace`)。
    // 同一个函数既给"今天做过了没"的存在性检查,也给执行体的落脚点 —— 两处一个源。
    getActivityDir: () => companionCwd(),
    // 执行体:复用日记管线那次**既有**的模型调用(不新增调用点)。
    runSelfActivity: (opts) => runHerActivity(opts)
  })

  // v0.30.2:关怀留痕接到状态面(见 statusPayload 的 `care` 字段)。
  // 这条通道静默过 45 小时 —— 判定理由从此不许只活在宿主 stdout 里。
  careTraceOf = typeof heartbeat.careTrace === 'function' ? heartbeat.careTrace : () => null

  /** 整固的两个旋钮(A `main.py:1926-1927`,面板可调;缺值 = 引擎默认 30/50)。 */
  const reflectionConfig = () => {
    try { return readSettings().reflection ?? {} } catch { return {} }
  }

  // ---- 3.5a 轮末硬保证(v0.19.0 D2):「想念该说没说」 ----
  // 设计文档 04 §turn-stopping:轮将停时检查「想念值≥阈值却没表达」→
  // steer 续一步(每轮至多一次)。参考实现的血泪注释:**这个钩子在轮内部
  // 运行,抛错会炸掉整轮** —— 丢的是转向是降级,丢的是整轮是丢他的回复。
  // 所以 handle() 全包 try/catch,外壳再兜一层。
  //
  // 事实来源:阈值/是否到期都在引擎(python/engine/longing.py
  // due_snapshot,与 should_care 同源同数学,含心境调制与 4.5 下限);
  // 壳只判「说过没说」这一件词面的事。
// 2026-10-09:这两个审计 wrapper 是 relay_* / echo_qq_say / relay_proactive / care_silent 等的**唯一写入通道**,
// 而调用方大多不传 stage/step ⇒ 活库实测这些事件 0 行带 stage,面板九阶段里显示成「暂未标注」✗
// 这里按**事件名**兜底(调用方给了就不覆盖),口径与 web/audit-cards.html 的 N2S 一致 ✓
const EVENT_STEP = { relay_in: 1, relay_out: 6, echo_qq_say: 6, structured_output: 5, relay_proactive: 9, care_silent: 9, remind: 9, wake: 9, echo_wake: 9 }
const EVENT_STAGE = { relay_in: 'relay_in', relay_out: 'relay_out', echo_qq_say: 'echo_qq_say', structured_output: 'structured_output', relay_proactive: 'relay_proactive', care_silent: 'care_silent', remind: 'remind', wake: 'wake', echo_wake: 'echo_wake' }

  const auditTurnStop = (row) => {
    try {
      const prev = store === null ? null : store.getState()
      const turnTag = row.traceId ? String(row.traceId) : ''
      store.writeAudit({
        // 上游 traceId 是轮关联；独立事件不能复用审计行主键。
        traceId: randomUUID(),
        stageDetail: turnTag !== '' ? JSON.stringify({ turnTrace: turnTag }) : '',
        sessionId: row.sessionId ?? undefined,
        userInput: row.userInput,
        injectedMemories: '',
        llmReply: '',
        moodIntensity: prev?.moodIntensity ?? 0,
        prevMoodIntensity: prev?.moodIntensity ?? 0,
        emotionVector: prev?.emotionVector ?? {},
        toolCall: row.toolCall,
        stage: (row.stage === undefined || row.stage === null || row.stage === '') ? (EVENT_STAGE[row.toolCall] || '') : String(row.stage),
        step: Number(row.step) ? Math.round(Number(row.step)) : (EVENT_STEP[row.toolCall] || 0)
      })
    } catch (err) {
      ctx.logger.warn('echo: longing_steer 审计失败 — ' + String(err?.message ?? err))
    }
  }
  const turnStopper = createTurnStopper({
    logger: ctx.logger,
    groupParticipationOf: (agent, turn) => {
      const social = groupParticipation.snapshot(agent?.session)
      return social && social.turn !== turn ? { ...social, blocked: true, active: false } : social
    },
    isEnabled: readEnabled,
    isSessionEnabled: sessionEnabled,
    mustSayEnabled: () => {
      try { return readSettings().longing?.must_say !== false } catch { return true }
    },
    // P2-A 渠道子闸:默认 true(只在平台轮补)。读不到设置 ⇒ true(治 bug)。
    steerOnlyFromPlatform: () => {
      try { return readSettings().longing?.steerOnlyFromPlatform !== false } catch { return true }
    },
    // ★ 2026-10-15 跨轮节流:复用既有面板项 `longing.cooldown_minutes`
    // (默认 120,标签「关怀冷却(分钟)」)。原来它只管心跳关怀,轮末补话
    // 一点节流都没有 ⇒ 想念一到阈值就**每轮**都追一句「想你」,话题生硬。
    // 读不到 / 传 0 ⇒ 0 = 不节流(退回旧行为)。
    cooldownMinutes: () => {
      try { return Number(readSettings().longing?.cooldown_minutes) || 0 } catch { return 0 }
    },
    createUserMessage,
    writeAudit: store === null ? null : auditTurnStop,
    // 给轮末审计已取得的轮关联，由 wrapper 保留到 stageDetail.turnTrace。
    traceOf: (sid) => { try { return turnTrace.of(sid) || '' } catch { return '' } },
    masterId: MASTER_ID
  })
  // turn-stopping 的 payload 只给 agent:优先用 agent.session 的**对象身份**
  // (与事件流同一对象,WeakMap 命中);万一身份对不上,退回按会话 id 记的
  // 最近一份捕获 —— 硬保证不许因为"对象不相等"静默失效。
  const captureForTurnStop = (agent) => {
    try {
      const session = agent?.session ?? null
      const byRef = session === null || session === undefined ? null : captureOf(session)
      if (byRef !== null && (byRef.longingRead !== null || byRef.turnText !== '')) return byRef
      const sid = String(session?.id ?? '')
      const byId = sid === '' ? null : captureBySid.get(sid)
      return byId ?? byRef
    } catch { return null }
  }
  ctx.effect(() => ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload?.agent ?? null
      if (officialOwner.isCurrentOfficialTurn({ agent, turn: payload?.turn ?? 0 })) return undefined
      const pending = turnStopper.handle({
        agent,
        turn: payload?.turn ?? 0,
        signal: payload?.signal ?? null,
        capture: captureForTurnStop(agent)
      })
      return Promise.resolve(pending).catch((err) => {
        ctx.logger.warn('echo: turn-stopping 降级(不影响本轮回复)— ' + String(err?.message ?? err))
      })
    } catch (err) {
      ctx.logger.warn('echo: turn-stopping 外壳异常(已降级)— ' + String(err?.message ?? err))
      return undefined
    }
  }), 'echo.turnStopping()')

  // ---- 3.5c 情绪余波 say_again(v0.21.0 E5)----
  // A 侧出处 main.py:1382-1479。判官(judge.py)每轮多给两个字段:
  // `say_again`(0/1)与 `extra_reply`(≤15 字补充)。都齐了才挂起一次
  // 延迟 2~5 秒的追加发言;**他再开口 = 抢话 ⇒ 立刻撤回**。
  //
  // 投递走的是她自己的嘴(宿主维护相 + followup),与主动关怀同一条路
  // (heartbeat.js:171),所以平台侧(QQ/网页)的出站/气泡/租约全复用;
  // 代价是多一次极短的模型步,收益是"出口仍然是她"。出处与偏离都记在
  // lib/say-again.js 顶部。
  const deliverSayAgain = async (agent, text, queryText = '') => {
    try {
      const maintenance = agent.runMaintenance(() => {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: ECHO_SOURCE_KIND, form: 'say_again',
            rawText: String(queryText || '')
          }
        }))
        return Promise.resolve(true)
      })
      return Boolean(await maintenance)
    } catch {
      return false // agent 忙或会话没了 —— 这半句话就算了,不重试(A 也不重试)
    }
  }
  const auditSayAgain = (row) => {
    if (store === null) return
    try {
      store.writeAudit({
        traceId: row.traceId,
        stage: (row.stage === undefined || row.stage === null || row.stage === '') ? (EVENT_STAGE[row.toolCall] || '') : String(row.stage),
        step: Number(row.step) ? Math.round(Number(row.step)) : (EVENT_STEP[row.toolCall] || 0),
        sessionId: row.sessionId ?? undefined,
        userInput: row.userInput,
        injectedMemories: '',
        llmReply: '',
        toolCall: row.toolCall,
        sayAgain: row.sayAgain,
        extraReply: row.extraReply
      })
    } catch (err) {
      ctx.logger.warn('echo: say_again 审计失败 — ' + String(err?.message ?? err))
    }
  }
  const sayAgain = createSayAgain({
    logger: ctx.logger,
    deliver: deliverSayAgain,
    writeAudit: store === null ? null : auditSayAgain,
    isEnabled: () => {
      try { return readSettings().say_again?.enabled !== false } catch { return true }
    },
    isSessionEnabled: sessionEnabled,
    settingsOf: () => {
      try {
        // 面板单位是**秒**(与 A 的 say_again_min_delay 同名同单位;调度器收毫秒)
        const s = readSettings().say_again ?? {}
        const min = Number(s.min_delay_sec)
        const max = Number(s.max_delay_sec)
        return {
          minDelayMs: Number.isFinite(min) ? min * 1000 : undefined,
          maxDelayMs: Number.isFinite(max) ? max * 1000 : undefined
        }
      } catch { return {} }
    }
  })
  ctx.effect(() => () => sayAgain.dispose(), 'echo.sayAgain()')

  // ---- 3.5b 反思整固(M2-b5 接线):夜里把白天的事想一遍 ----
  // v0.14.4 移植缺口 S1:引擎侧整层早已就绪(reflection.py 提示词逐字、
  // 阈值 30 / 窗口 50 / 夜窗 23-8 且距上次 >12h、worker 两个帧、连
  // reflection_state 表都建好了),但壳侧此前零引用 —— 信念层从未产出
  // 过一条。这里把两帧接上:判触发在引擎、跑 LLM 在壳侧 subagents、
  // 守卫落库回引擎(check 的候选窗口留在 worker 内存,两帧必须成对)。
  //
  // 三条纪律:
  //   ① 单飞 —— 一轮整固没跑完不叠加(LLM 慢,不抢队列);
  //   ② LLM 失败**不 commit** —— 游标不动,下轮重试(与 A 侧
  //      _run_reflection 同语义;commit 空载荷会推游标,那是丢记忆);
  //   ③ 整固是增益不是依赖 —— 任何异常只 warn,绝不影响主对话。
  // 触发条件保守(重要性累计过阈,或夜间窗口),所以 LLM 频率天然很低;
  // 照 A 的做法不加「他正在聊天时不整固」的自建闸。
  // ---- 3.5a 情绪空间融合(第三批 2026-10-05):联合空间桥接,影子优先 ----
  // 三条纪律:
  //   ① **影子模式默认开**(拍板 ⑤):算了只写审计新列 `emotion_pack_structured`,
  //      prompt 里一个字都不多 —— 先看几天真实读数(bridge_err 到底多大)再决定;
  //   ② **fail-soft**:任何异常只让"这段读数没有",绝不影响体感剧本与主对话;
  //   ③ 参数全走面板(bridge* 九项):文献值 35°/71° 与 [工程假设] 分开标,
  //      改错可回滚(声明层与渲染层都不依赖具体数值)。
  const unionBridge = createSpaceBridge({
    params: (() => {
      try {
        const s = readSettings()
        return {
          enabled: s.bridgeEnabled !== false,
          shadowMode: s.bridgeShadowMode !== false,
          thetaS: Number(s.bridgeThetaS),
          thetaSipc: Number(s.bridgeThetaSipc),
          thetaD: Number(s.bridgeThetaD),
          lambdaS: Number(s.bridgeLambdaS),
          lambdaD: Number(s.bridgeLambdaD),
          biasS: Number(s.bridgeBiasS),
          exposeErr: s.bridgeExposeErr !== false
        }
      } catch { return {} }
    })(),
    ipcAvailable: true,
    log: (level, msg) => { try { ctx.logger.debug('echo: ' + msg) } catch { /* fail-soft */ } }
  })
  const unionIpc = createIpcAdapter({
    log: (level, msg) => { try { ctx.logger.debug('echo: ' + msg) } catch { /* fail-soft */ } }
  })
  // 装配期读一次 IPC(只为日志里能看见"借到没有";读不到也只是降级)。
  Promise.resolve().then(() => unionIpc.inventory()).then((inv) => {
    if (inv !== null) ctx.logger.info('echo: 联合空间就绪 — ' + SPACE_ID + ',IPC ' + String(inv.states && inv.states.total) + ' 词 / ' + String(inv.anchors && inv.anchors.total) + ' 锚点')
    else ctx.logger.warn('echo: 联合空间降级 — IPC 副本不可用(读数只有情感侧,关系代数缺席)')
  }).catch(() => { /* fail-soft */ })

  // ---- 2026-10-06:用户侧坐标打分器(轮末异步,拍板 ①②③④⑤⑥)----
  // 三个接线点都在这里说清:
  // · **通道**:走 `reflectTransport()` 的直调(面板覆盖 route / 继承本会话,与反思同一条);
  //   拿不到直调 ⇒ 这一拍**明确失败并写审计**(不退回子代理:它不是增益型反思,
  //   没必要为它多起一个会话,也不许静默)。
  // · **库**:`store` 是模块级句柄(apply 之后才非空),所以这里传一层薄代理 ——
  //   打分器只用到 `getState()` / `saveEmotionVector()`(后者是**只改两列**的 UPDATE,
  //   不会碰 mood_intensity / topic 等其它列)。
  // · **零 DDL**:结果并进已有的 `emotion_vector` JSON 的新键 `ipc_dyad`
  //   (`agent_state` 是 JS/PY 共有表,一期不加列、不加表)。
  ipcAppraiser = createIpcAppraiser({
    adapter: unionIpc,
    callStructured: (args) => {
      const t = reflectTransport(args && args.sessionId)
      const st = (t && t.transport && typeof t.transport.structured === 'function') ? t.transport.structured : null
      if (st === null) {
        return Promise.reject(new Error('直调通道不可用:' + String((t && t.note) || '')))
      }
      return st({ prompt: (args && args.prompt) || '', label: (args && args.label) || 'echo-ipc-appraise', sessionId: (args && args.sessionId) || '' })
    },
    store: {
      getState: () => (store === null ? {} : store.getState()),
      saveEmotionVector: (v) => (store === null ? false : store.saveEmotionVector(v))
    },
    audit: (fields) => {
      if (store === null) return
      const st = (() => { try { return store.getState() } catch { return {} } })()
      store.writeAudit({
        traceId: randomUUID(),
        ...moodPackForAudit(),
        moodIntensity: st.moodIntensity,
        prevMoodIntensity: st.prevMoodIntensity,
        emotionVector: st.emotionVector ?? {},
        ...(fields && typeof fields === 'object' ? fields : {})
      })
    },
    log: (msg) => { try { ctx.logger.debug('echo: ' + String(msg)) } catch { /* fail-soft */ } },
    getSettings: () => { try { return readSettings() } catch { return {} } },
    recentTurns: (sessionId, limit) => (store === null ? [] : store.recentTurns(sessionId, limit)),
    getPersonaAnchor: () => String(personaCache.prefix || ''),
    getNames: () => {
      const p = (() => { try { return publicProfile() } catch { return null } })()
      return { userName: (p && p.userName) || '用户', agentName: (p && p.agentName) || '角色' }
    }
  })

  /**
   * 算一次联合空间读数(结构化)。**纯读**:不写库、不改 state、不回写任何一维
   * (误差只记在 `bridgeErr`,并按面板开关决定要不要出现在注入块里)。
   */
  function unionSnapshot (state) {
    const settings = (() => { try { return readSettings() } catch { return {} } })()
    const base = { schema: SPACE_ID, at: Date.now(), mode: settings.bridgeShadowMode === false ? 'live' : 'shadow' }
    try {
      if (settings.bridgeEnabled === false) return { ...base, enabled: false, note: '总闸关闭:未计算' }
      const vec = (state && state.emotionVector) || {}
      // 显示口径(拍板 D1/D2/D3):p / a 照实测;d 走「推导优先 → 实测 → 缺」。
      // 只读:不改 state、不回写向量 —— 提示词块也不读 d(context.js 仍写「支配(未启用)」)。
      const pad = padBipolarFromVector(vec)
      const padU = unionBridge.padToUnion(pad, { native: false })
      const ipc = echoToIpc(vec)
      const ipcU = unionBridge.ipcToUnion(ipc.point, { sessionId: 'echo-self' })
      const cmp = unionBridge.compareShared(padU.ok ? padU.union : null, ipcU.ok ? ipcU.union : null)
      // B5 门禁(只读判定):残差 = 当前参数下 |s_ipc − (λs·s_pad + biasS)|。
      // 绿 ⇒ 给块;黄 ⇒ 只给方向;红 ⇒ 不给块(审计照写)。**绝不回写任何读数。**
      const gate = gateOf(cmp.err)
      let direction = null
      try {
        const prevVec = state && state.previousEmotionVector
        if (prevVec && typeof prevVec === 'object') {
          const prevU = unionBridge.padToUnion(echoVectorToBipolar(prevVec), { native: false })
          if (prevU.ok && padU.ok) direction = directionOf(padU.union.s, prevU.union.s)
        }
      } catch { direction = null }
      // 同步取锚点:核心没加载完就是 null(不 await、不抛)—— 审计行是同步构建的。
      const anchor = unionIpc.nearestAnchorsSync(ipc.point, { limit: 1 })
      return {
        ...base,
        union: padU.ok ? padU.union : null,
        unionIpc: ipcU.ok ? ipcU.union : null,
        pad: { valence: pad.p, arousal: pad.a, dominance: pad.d },
        // D2:来源必须随读数一起走(半年后没人知道这个 d 不是测出来的)。
        dSource: pad.dSource ?? null,
        ipc: {
          agency: ipc.point.a,
          communion: ipc.point.c,
          ext: ipc.ext,
          anchor: Array.isArray(anchor) && anchor.length > 0 ? { id: anchor[0].id, zh: anchor[0].zh, octant: anchor[0].octant } : null
        },
        bridgeErr: cmp.err,
        resid: cmp.err,
        gate,
        direction,
        sPad: cmp.sPad,
        sIpc: cmp.sIpc,
        predicted: cmp.predicted,
        degraded: padU.degraded === true || ipcU.degraded === true || ipcU.ok === false,
        missing: [...(pad.missing || []), ...(ipc.missing || [])],
        assumptions: pad.note,
        note: EQUIVALENCE_NOTE
      }
    } catch (err) {
      return { ...base, error: String((err && err.message) || err), note: '联合空间计算失败,已降级(不影响主对话)' }
    }
  }

  /** 审计行的情绪包(文本 + 结构化读数)二合一,三处审计写入点共用。 */
  function moodPackForAudit () {
    const state = store.getState()
    let structured = null
    let packed = null
    try {
      structured = unionSnapshot(state)
      // 影子模式 ⇒ 不进 prompt;正式模式 ⇒ 按门禁出块(红带/未知返回空串 = 不注入,
      // 黄带只给方向)。门禁是**只读判定**,不改任何读数。
      const block = structured.mode === 'live'
        ? renderUnionBlock({
          mode: 'live',
          spaceId: SPACE_ID,
          union: structured.union,
          pad: structured.pad,
          ipc: structured.ipc,
          independent: (() => {
            try {
              const s = store.getState()
              return { fatigue: (s.emotionVector && s.emotionVector.global || {}).fatigue, longing: null, affinity: null }
            } catch { return null }
          })(),
          gate: structured.gate,
          direction: structured.direction,
          degraded: structured.degraded === true,
          note: EQUIVALENCE_NOTE
        })
        : ''
      packed = block === '' ? {} : { unionBlock: block }
      // 方案 C 第一步(2026-10-05):「语气候选」—— 把情绪读数折成 `<emo type="N">` 的
      // 候选集(只出号,不替模型决定哪一句用)。开关 `styleHint` 默认开,置 false 即回滚;
      // 门禁在 style-hint 内部参与降级(黄/红不引用共享轴 s)。
      // 单独包一层 try:提示行读配置/算候选失败,**不许**连累上面那个联合空间块。
      try {
        const hintCfg = readSettings()
        if (packed !== null && hintCfg.styleHint !== false) {
          const hint = statusToStyleCandidates({
            moodIntensity: state.moodIntensity,
            prevMoodIntensity: state.prevMoodIntensity,
            emotionVector: state.emotionVector,
            gate: structured === null ? 'unknown' : structured.gate,
            union: structured === null ? null : structured.union
          })
          if (hint.line !== '') packed.styleHint = hint.line
        }
      } catch { /* 语气候选是锦上添花:失败就这一轮不加提示行 */ }
    } catch (err) {
      structured = { schema: SPACE_ID, error: String((err && err.message) || err), note: '影子读数失败,已降级' }
      packed = {}
    }
    return {
      emotionPack: describeMood(state, packed),
      emotionPackStructured: structured === null ? '' : JSON.stringify(structured)
    }
  }

  // 反思整固的**互斥闸**:同一时刻只跑一次整固(它是 LLM 调用,不是便宜操作)。
  // 2026-10-05 事故复盘:`24f6d86`(情绪空间融合 B1–B4)插接线块时,Edit 的
  // `old_string` 用的锚点就是这一行,而新文本里**没把它带回来** —— 定义被删、
  // 引用还在(`reflectionTick` 里三处),于是心跳一触发就
  // `ReferenceError: reflectingMemory is not defined`,把 `dsh web` 打死。
  // 教训:`check-syntax` 只查语法,`ReferenceError` 要真跑才炸 —— 删/动一行
  // 声明时,必须回头确认"引用还在不在"。
  let reflectingMemory = false

  // 2026-10-11 修(可观测性):整固失败以前只在宿主 stdout 留一行 ——
  // 活库实测 `reflection_state.last_memory_id` 卡在 354(2026-10-05),
  // 而 `tool_call='reflection'` 的审计行**史上为 0**,于是「整固为什么不动」
  // 在库侧完全查不到(只能去翻 stdout)。失败也必须落一行。
  // 限流:同一原因 30 分钟内只记一次 —— 心跳是 60 秒一拍,不限流会把审计表刷满。
  let reflectFailNote = ''
  let reflectFailAt = 0
  /**
   * 整固失败留痕。
   *
   * ⚠️ 2026-10-18 盘清时的判断：**这一行本来就不该有 `turnTrace`**。
   *   整固是**全局夜间批处理**（`reflectionTick` 按引擎的 `triggered` 触发，
   *   一次想的是"白天整段事"，不属于任何一轮"他开口 → 她回"）。
   *   所以这里**不补 `stage_detail.turnTrace`** —— 补了反而是假的归组。
   *
   * 但 `sessionId` 值得带上（如果调用方拿得到）：原来 `session_id` 落到
   * `GLOBAL_SESSION='global'`，面板按会话筛的时候就只能挤在"全局"那一栏。
   *
   * @param {string} note       失败原因
   * @param {string} [sessionId] 触发整固的那个会话（拿不到就留空 → 老行为）
   */
  const reflectFailAudit = (note, sessionId = '') => {
    if (store === null) return
    const nowMs = Date.now()
    const text = String(note).slice(0, 200)
    if (text === reflectFailNote && nowMs - reflectFailAt < 30 * 60_000) return
    reflectFailNote = text
    reflectFailAt = nowMs
    try {
      const st = store.getState()
      store.writeAudit({
        traceId: randomUUID(),
        // ★ 有 sid 就带上（不再一律落 'global'）；turnTrace 仍留空 —— 见上面的判断
        ...(String(sessionId ?? '') === '' ? {} : { sessionId: String(sessionId) }),
        userInput: '(记忆整固·失败)',
        injectedMemories: '',
        llmReply: text,
        moodIntensity: st.moodIntensity,
        prevMoodIntensity: st.prevMoodIntensity,
        emotionVector: st.emotionVector ?? {},
        toolCall: 'reflection_failed',
        stage: 'reflection',
        step: 0
      })
    } catch { /* 审计失败不绊整固 */ }
    ctx.logger.warn('echo: 整固未完成 — ' + text)
  }

  const reflectionTick = (agent) => {
    if (reflectingMemory) return
    if (engine === null || store === null || subagents === undefined) return
    if (!readEnabled()) return // 休眠 = 不反思(记忆不会再长,别白烧调用)
    let settings = null
    try { settings = readSettings() } catch { settings = null }
    if (settings !== null && settings.reflectionEnabled === false) return
    const parent = (agent !== null && agent !== undefined) ? agent : routeAgent
    if (parent === null || parent === undefined) return
    // ★ 2026-10-18：整固失败那行带上触发它的会话（原来一律落 `GLOBAL_SESSION`）。
    //   ⚠️ 但**不补 turnTrace** —— 整固是全局批处理，不属于任何一轮对话（见 reflectFailAudit 的注释）。
    const parentSid = String(parent?.session?.id ?? '')
    reflectingMemory = true
    Promise.resolve()
      .then(() => engine.reflectionPrompt(Date.now(), reflectionConfig()))
      .then(async (p) => {
        if (p === null || p === undefined) {
          // 引擎不可用(帧没回)/ 通道没连上 —— 以前这里静默 return,
          // 游标就此停住而库里毫无痕迹。
          reflectFailAudit('引擎未回应(reflection_prompt 帧为 null)', parentSid)
          return null
        }
        if (p.triggered !== true) return null   // 未到触发条件 = 正常静默,不留痕

        // v0.22.0:命中与否要留痕(A 的日志里也有阈值/累计分)—— 面板把阈值
        // 调高之后"怎么不整固了"必须看得出来,不能靠猜。
        ctx.logger.info('echo: 整固触发 — 累计情感 ' + String(p.importance ?? '?')
          + ' / 阈值 ' + String(reflectionConfig().importance_threshold ?? 30)
          + ' · 窗口 ' + String((p.candidateIds || []).length) + ' 条')
        const out = await runReflection(reflectTransport().transport, {
          systemPrompt: p.systemPrompt,
          userPrompt: p.userPrompt,
          parent
        })
        if (out === null) {
          ctx.logger.warn('echo: reflection skipped — LLM 未产出(游标不动,下轮重试)')
          reflectFailAudit('LLM 未产出结构化结果(游标不动,下轮重试)', parentSid)
          return null
        }
        const items = Array.isArray(out.items) ? out.items : []
        const ack = await engine.reflectionCommit(items, Date.now())
        if (ack === null) {
          reflectFailAudit('reflection_commit 帧未回应(' + String(items.length) + ' 条 items)', parentSid)
          return null
        }
        const line = 'written=' + String(ack.written) + ' merged=' + String(ack.merged)
          + ' agenda=' + String(ack.agenda)
        ctx.logger.info('echo: reflection — ' + line
          + (ack.cursorAdvanced ? ' cursor→' + String(ack.cursor) : ' 游标未动'))
        try {
          store.writeAudit({
            traceId: randomUUID(),
            userInput: '(记忆整固·' + (p.night ? '夜窗' : '过阈') + ')',
            injectedMemories: '',
            ...moodPackForAudit(),
            llmReply: 'items=' + String(items.length) + ' ' + line,
            moodIntensity: store.getState().moodIntensity,
            prevMoodIntensity: store.getState().prevMoodIntensity,
            emotionVector: store.getState().emotionVector ?? {},
            toolCall: 'reflection',
            // 2026-10-11:与失败路同批 —— 整固这一拍的完整账落 stage_detail,
            // 「游标为什么没动」以后不用再靠 stdout。
            stage: 'reflection',
            step: 0,
            stageDetail: (() => {
              try {
                return JSON.stringify({
                  importance: p.importance,
                  candidates: (p.candidateIds || []).length,
                  items: items.length,
                  written: ack.written,
                  merged: ack.merged,
                  agenda: ack.agenda,
                  cursorAdvanced: ack.cursorAdvanced === true,
                  cursor: ack.cursor,
                  reason: ack.reason || ''
                })
              } catch { return '' }
            })()
          })
        } catch { /* 审计失败不绊整固 */ }
        return ack
      })
      .catch((err) => {
        ctx.logger.warn('echo: reflection failed — ' + String(err?.message ?? err))
        reflectFailAudit('抛错:' + String(err?.message ?? err), parentSid)
      })
      .finally(() => { reflectingMemory = false })
  }

  // ---- 2026-10-05 第二批:子代理会话自动清理(存量 + 持续)----
  // 诊断报告《子代理积压诊断-2026-10-05.md》§2:宿主只回收句柄、不删会话记录,
  // 子代理会话(origin=subagent)于是线性堆积(实测 835 个 / 67.41 MB)。
  // 落地件 lib/session-reaper.js 是纯 IO 模块(dry-run 默认、只删子代理、无法解析一律保留、
  // 删前先写 jsonl 清单);这里只负责:**挂 60 秒心跳**(拍板),但**每 10 分钟才真删一次**(降 IO),
  // 以及把清理量与释放空间写进审计。
  let reaperLastAt = 0
  const reaperTick = (agent) => {
    if (engine === null || store === null) return
    if (!readEnabled()) return // 休眠 = 不打扫
    const nowMs = Date.now()
    if (nowMs - reaperLastAt < 10 * 60_000) return
    reaperLastAt = nowMs
    let cfg = null
    try { cfg = readSettings() } catch { cfg = null }
    if (cfg !== null && cfg.reaperEnabled === false) return
    // 轮数窗口(2026-10-05 拍板):主判据 = 最近 N 轮对话的时间跨度,
    // 边界由 `lib/session-window.js` 从**主对话会话文件**的消息时间戳算
    // (走宿主自己的读取实现 `JsonlSessionPersistence`,不自己解混合封装)。
    const windowTurns = (cfg === null || !Number.isFinite(Number(cfg.reaperWindowTurns)))
      ? DEFAULT_WINDOW_TURNS
      : Math.max(10, Math.min(20000, Number(cfg.reaperWindowTurns)))
    const keepNewest = (cfg === null || !Number.isFinite(Number(cfg.reaperKeepNewest)))
      ? DEFAULT_KEEP_NEWEST
      : Math.max(0, Math.min(5000, Number(cfg.reaperKeepNewest)))
    Promise.resolve()
      .then(() => reapSessions({
        // 路径走模块默认(默认即 ~/.dsh/... 那几个真值):不给宿主塞第二种真相源。
        // 轮数窗口是主判据;windowMs 只在"边界算不出来"时兜底(120 分钟)。
        windowTurns,
        windowMs: 120 * 60_000,
        keepNewest,
        apply: true, // 拍板:心跳自动清理是真删(清单先落盘,见模块 §5)
        log: ctx.logger
      }))
      .then((res) => {
        if (res === null || res === undefined) return
        // ★ 2026-10-08(降噪):**只在真删了东西时**写审计行。
        // 旧行为是"每次真跑都留一行" ⇒ 每 10 分钟一条纯心跳(实测 24h 52 条),把审计流
        // 的展示窗口挤满,真实对话被顶到窗口外(现场:「对话优先里没有对话」)。
        // 可审计性没丢:删除清单本来就落盘(`session-reaper.js` 的 reaper-*.jsonl),
        // 这里只在有删除时补一行"摘要 + 清单路径";没删东西 ⇒ 不写,审计表顺带瘦下来。
        if (res.reaped.length > 0) {
          try {
            store.writeAudit({
              traceId: randomUUID(),
              userInput: '(会话清理)',
              injectedMemories: '',
              ...moodPackForAudit(),
              llmReply: 'reaped=' + String(res.reaped.length) + ' kept=' + String(res.kept)
                + ' unknown=' + String(res.unknown.length) + ' freed=' + String(res.freedBytes)
                + 'B turns=' + String(res.turnBoundary === null || res.turnBoundary === undefined
                  ? '-' : res.turnBoundary.turns)
                + ' boundary=' + String(res.turnBoundary === null || res.turnBoundary === undefined
                  ? '-' : res.turnBoundary.ms)
                + ' manifest=' + String(res.manifestPath || ''),
              moodIntensity: store.getState().moodIntensity,
              prevMoodIntensity: store.getState().prevMoodIntensity,
              emotionVector: store.getState().emotionVector ?? {},
              toolCall: 'session-reaper'
            })
          } catch { /* 审计失败不绊清理 */ }
        }
        if (res.reaped.length > 0) {
          ctx.logger.info('echo: 会话清理 — 删 ' + String(res.reaped.length) + ' 个 / 释放 '
            + (res.freedBytes / 1024).toFixed(1) + ' KB;清单 ' + String(res.manifestPath || '?'))
        }
      })
      .catch((err) => { ctx.logger.warn('echo: 会话清理失败 — ' + String(err?.message ?? err)) })
  }

  // ---- 3.5b 人格漂移体检(v0.15.0 S13) ----
  // A 侧是一条完整的链(`echo_audit.py:184-259` 窗口+体检+事件,
  // `main.py:1142-1167` 强化注入)。DSH 此前**一条都没有**(全库搜
  // `drift` 零匹配)。这里只做壳那一半:窗口与计数在轮末(见 session/event),
  // 判定与强化状态机在 `drift.js`,LLM 走与整固同一条结构化通道。
  // 单飞:体检查不完不发下一次(A 是一轮一个 task,同样不叠加)。
  // P1b(Q12):体检材料改成**从 persona.json 派生** —— 注入活的 personaCache
  // (与人格注入用的是同一份,不再有"改了 persona.json 还得同步改设置"的第二处)。
  const drift = createDriftTracker({
    getSettings: () => readSettings(), getPersona: () => personaCache, logger: ctx.logger
  })
  let driftChecking = false
  const fireDriftCheck = (sessionId) => {
    if (driftChecking) return
    if (subagents === undefined || store === null) return
    const req = drift.buildPrompt(sessionId)
    if (req === null) return // 窗口空:没什么可体检的(A `:195-197`)
    const parent = routeAgent
    if (parent === null || parent === undefined) return
    // v0.41.0:体检那一趟也是子代理 —— 父必须是顶层会话(路由 agent 现在已由
    // pre-step 守住,这里再挡一次:这是「子代理不许起子代理」的同一条纪律)。
    if (isSubagentSession(parent)) return
    driftChecking = true
    Promise.resolve()
      .then(() => callTransport(reflectTransport().transport, {
        prompt: req.systemPrompt + '\n\n' + req.userPrompt,
        schema: DRIFT_SCHEMA,
        label: 'echo-drift',
        parent
      }))
      .then((raw) => {
        const outcome = drift.applyResult(sessionId, raw)
        if (outcome.action !== 'drift') return
        // 漂移事件进审计黑匣子(A `echo_audit.py:237-259`)。
        try {
          store.writeAudit(driftAuditRow({
            sessionId, issue: outcome.issue, state: store.getState()
          }))
        } catch { /* 审计失败不影响强化本身 */ }
      })
      .catch((err) => {
        // A `:214-215`:体检调用失败只跳过本轮,绝不误报。
        ctx.logger.warn('echo: drift check skipped — ' + String(err?.message ?? err))
      })
      .finally(() => { driftChecking = false })
  }

  // ---- 3.5c 情绪时间衰减(G2) ----
  // v0.14.5 S8:DSH 此前**没有时间这一维** —— 她的情绪强度与向量只会被
  // 对话改写,放着不动永不回落。A 侧 `echo_audit.py:264-318` 挂 30 分钟
  // 循环做衰减(绝对步长:疲劳 −1/h、爱意向基线 0.05/h……见 emotion.js)。
  //
  // 为什么在壳侧:`agent_state` 是壳拥有的表(引擎只读,`longing.py:277`
  // 自述),A 也把衰减放在 audit mixin 而不是大脑里 —— 同位。
  //
  // 两个刻意的决定,写下来免得被当成漏做:
  //   ① **不跟电源闸**:衰减是时间流逝本身,不是她「在不在」。休眠一周
  //      醒来还是 9 点疲惫才是不自然;何况她开着的时候也照跑。
  //   ② 只改向量两列(`saveEmotionVector`),绝不用整行 UPSERT —— 衰减
  //      不是一轮对话,不该顺手把 current_topic 清空、心情打回 3。
  let lastDecayAt = 0
  const emotionDecayTick = (now = Date.now()) => {
    if (store === null) return
    let settings = null
    try { settings = readSettings() } catch { settings = null }
    if (settings !== null && settings.emotionDecayEnabled === false) return
    const minutes = settings === null ? 30 : settings.emotionDecayIntervalMinutes
    if (now - lastDecayAt < minutes * 60_000) return
    lastDecayAt = now
    try {
      const st = store.getState()
      const prev = st.emotionVector
      if (prev === null || typeof prev !== 'object' || Object.keys(prev).length === 0) return
      const anchor = Number(st.updatedAt) || 0
      if (!(anchor > 0)) return
      const hours = (now / 1000 - anchor) / 3600
      if (!(hours > 0)) return
      // ⚠️ 2026-10-06 事故:`decayedEmotionVector` 内部会 clamp,而 `clampEmotionVector`
      // **只重建已知的情绪维** ⇒ `emotion_vector` 那一列 JSON 里的**额外键**(当场正在
      // 落地的是轮末异步判定留下的 `ipc_dyad`:用户侧坐标 + 残差对账)会被顺手抹掉。
      // 衰减 tick 60 秒叫醒一次(30 分钟桶)⇒ 判定之后 ≤30 分钟面板青点自己消失,
      // 而且没有报错、没有日志("看起来一切正常"是最贵的一类失败)。
      // 所以写回前必须把额外键带回来:衰减只衰减情绪维。详见 `lib/emotion.js`。
      const next = carryExtraEmotionKeys(prev, decayedEmotionVector(prev, hours))
      const delta = emotionDelta(prev, next)
      // 没有实质变化就不写:否则每 30 分钟把 updated_at 往前推一格,
      // 下一次要衰减的时长被自己吃掉,衰减永远停在原地。
      if (Object.keys(delta).length === 0) return
      if (store.saveEmotionVector(next, prev) !== true) return // 没有状态行 = 没有可衰减的东西
      ctx.logger.info('echo: emotion decay — ' + formatEmotionDelta(delta)
        + ' (经过 ' + hours.toFixed(2) + 'h)')
      // ---- D(2026-10-10):衰减留痕 ----
      // 在此之前衰减**只写日志、不写库** ⇒ 无法从库里判断它跑过没有;排查"只升不降"
      // 时只能靠 emotion_delta(而那 72 行全部来自 extract,一条衰减都没有)。
      //
      // 四个刻意的决定:
      //   ① **顺序**:先 saveEmotionVector 再写审计。反过来就会出现"审计里有、库没动"。
      //   ② **不自调 getState()**:`writeAudit` 内部会现读库,而这里刚写完 ⇒ 它读到的
      //      是**衰减后**的值,delta 会算成空。所以把 `agentState` 显式传进去覆盖它。
      //   ③ **tool_call 必须是新值 `emotion_decay`,绝不能借 `'care'`**:
      //      `store.js:1671` 的 `careCountSince()` 就是 `COUNT(*) WHERE tool_call='care'`,
      //      而它喂的是**主动开口的日上限**(`index.js:5464` 的 gates → CARE_DAILY_CAP)。
      //      衰减一天 48 拍 ⇒ 借 care 就等于"她今天已经开口 48 次"⇒ **日上限立刻打满,
      //      她再也不会主动说话,而且不报错**。这正是"看起来一切正常"那一类失败。
      //   ④ **只在 `target_master`(对主人那几维)真的动了时才写**:`fatigue` 按 1.0/h
      //      走,30 分钟桶里必然动 0.5 ⇒ 不加这道闸,每天固定 48 行,而 `trimAudit`
      //      每桶只留 100 行(`store.js:1040`)⇒ 会把真实的工具调用行挤出去。
      //      关系维在稳态下**贴着基线不动**(toward(8.0,8.0,…) 恒等)⇒ 这道闸平时
      //      几乎不触发;**它一亮,就是关系维真的在动** —— 正是要查的那件事。
      //      (代价:疲劳/心情的日常漂移不进审计表,只有日志。已知、可接受。)
      //   `user_input` 打工具行标记 ⇒ 归入工具桶,不占对话行的额度;标记从产地导入,
      //   不在 SQL 或这里抄字面量(`lib/tool-audit.js:37`)。
      try {
        const rel = delta.target_master
        if (rel !== null && typeof rel === 'object' && Object.keys(rel).length > 0) {
          store.writeAudit({
            traceId: 'emotion-decay-' + randomUUID(),
            userInput: TOOL_ROW_MARKER + 'emotion_decay 经过 ' + hours.toFixed(2) + 'h',
            emotionVector: next,
            emotionDelta: formatEmotionDelta(delta),
            toolCall: 'emotion_decay',
            stage: 'emotion_decay',
            stageDetail: JSON.stringify({ hours: Math.round(hours * 100) / 100, delta })
          })
        }
      } catch { /* 留痕尽力而为:写不进去绝不能让衰减本身失败 */ }
    } catch (err) {
      ctx.logger.warn('echo: emotion decay failed — ' + String(err?.message ?? err))
    }
  }

  // ---- 2026-10-06 D2:悬置话题生命周期(**影子期**:只盖两列,谁都不读)----
  // 搭情绪衰减同一趟 60 秒时基,自带 30 分钟桶("没有该动的行"⇒引擎一条 UPDATE
  // 都不发 ⇒ 不推 `updated_at`,"多久没动"这个判据不会被 tick 自己吃掉)。
  // 影子比对:每个自然日的第一拍再发一次 `dryRun` 帧,把"若按新规则,谁该冷却/
  // 归档"整份打一行日志(只读清单、不写一个字节)——照图门影子表的先例。
  // 参数面板化(30 分钟桶)留到 D5:那要一起动 settings-fields/toggle 与项数电池。
  let lastLifecycleAt = 0
  let lastLifecycleLogDay = ''
  const LIFECYCLE_TICK_MINUTES = 30
  const threadLifecycleTick = (now = Date.now()) => {
    if (engine === null) return
    if (now - lastLifecycleAt < LIFECYCLE_TICK_MINUTES * 60_000) return
    lastLifecycleAt = now
    const nowSec = Math.floor(now / 1000)
    const idsOf = (list) => list.slice(0, 12).join(',') + (list.length > 12 ? '…' : '')
    Promise.resolve()
      .then(() => engine.threadsLifecycle({ now: nowSec }))
      .then((out) => {
        if (out === null) return null // 引擎不在:下分钟再来,不回落
        if (out.cooled.length > 0 || out.archived.length > 0) {
          ctx.logger.info('echo: 悬置话题生命周期(影子·已盖列)— 冷却 '
            + String(out.cooled.length) + ' 条[#' + idsOf(out.cooled) + '] / 归档 '
            + String(out.archived.length) + ' 条[#' + idsOf(out.archived) + ']'
            + '(扫描 ' + String(out.scanned) + ' 行)')
        }
        // 每天第一拍:整份"该冷却/该归档"清单(只算不写),给他一条能看的样本
        const day = new Date(now).toISOString().slice(0, 10)
        if (day === lastLifecycleLogDay) return null
        lastLifecycleLogDay = day
        return engine.threadsLifecycle({ now: nowSec, dryRun: true })
      })
      .then((plan) => {
        if (plan === null || plan === undefined) return
        ctx.logger.info('echo: 悬置话题影子比对 ' + new Date(now).toISOString().slice(0, 10)
          + ' — 该冷却 ' + String(plan.cooled.length) + ' 条'
          + (plan.cooled.length > 0 ? '[#' + idsOf(plan.cooled) + ']' : '')
          + ' / 该归档 ' + String(plan.archived.length) + ' 条'
          + (plan.archived.length > 0 ? '[#' + idsOf(plan.archived) + ']' : '')
          + '(扫描 ' + String(plan.scanned) + ' 行;只算不写)')
      })
      .catch((err) => {
        ctx.logger.warn('echo: 悬置话题生命周期 tick 失败(已忽略)— ' + String(err?.message ?? err))
      })
  }

  ctx.effect(() => {
    const disposers = new Map()
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      try {
        if (disposers.has(agent) || !ctx.agents.roots().includes(agent)) return
        routeAgent = agent // v0.13.3:日记 parent 的兜底来源
        const dispose = agent.ctx.effect(() => {
          const timer = setInterval(() => {
            heartbeat.tick(agent)
            // v0.14.4:同一个 60 秒时基带整固 —— A 侧 _reflection_pass
            // 也是 60 秒时钟常跑,触发条件在引擎侧判。
            reflectionTick(agent)
            // 2026-10-05 第二批:同一个 60 秒时基带会话清理(内部每 10 分钟才真跑一次)
            reaperTick(agent)
            // v0.14.5 S8:情绪时间衰减(自带 30 分钟桶,60 秒时基只是叫醒)
            emotionDecayTick()
            // 2026-10-06 D2:悬置话题生命周期(影子期:只盖 cooling_at/archived_at;
            // 同一趟 60 秒时基 + 自带 30 分钟桶;读出侧一行都不引用那两列)
            threadLifecycleTick()
          }, HEARTBEAT_INTERVAL_MS)
          return () => clearInterval(timer)
        }, 'echo.heartbeat()')
        disposers.set(agent, dispose)
      } catch (err) {
        ctx.logger.warn('echo: heartbeat install failed — ' + String(err?.message ?? err))
      }
    })
    return async () => {
      stopCreated()
      const all = [...disposers.values()]
      disposers.clear()
      await Promise.allSettled(all.map((d) => Promise.resolve().then(() => d())))
    }
  }, 'echo.heartbeatLifecycle()')

  // ---- 3.6 她写日记(M3-d):每晚 22:30 一页,写给自己 ----
  // 不是说话:不占关怀通道、不受夜间憋话管辖(23:00 管开口管不住笔)。
  // 空日子也写 ——「今天他没来」是最动人的一页。日记表是壳拥有的
  // 表(LLM 与存储都在壳侧,双引擎行为一致);想念值取引擎真值,
  // 引擎不在回落 JS 复刻(面板同款降级)。60s 一查,到点才组稿;
  // busy 旗防重叠,latestDiaries(1) 做一天一页的幂等键。
  if (subagents !== undefined) {
    let diaryBusy = false
    // v0.38.0 F2:连败计数与下一次允许重试的时刻(退避)。缺口补写见 lib/diary.js
    // 的 planDiaryTick —— 拍子本身只负责执行,判据是纯函数(可离线测)。
    let diaryFail = 0
    let diaryRetryAt = 0
    ctx.effect(() => {
      const timer = setInterval(async () => {
        try {
          if (diaryBusy || !readEnabled() || store === null) return
          const last = store.latestDiaries(1)[0]
          const plan = planDiaryTick({
            nowMs: Date.now(),
            lastDateKey: last ? last.date : '',
            failCount: diaryFail,
            retryAtMs: diaryRetryAt
          })
          if (plan.action !== 'write') return
          diaryBusy = true
          try {
            // 一拍拍一页(**最早那天在前**):补 7 页就是 7 分钟,而不是 7 次组稿一起打过去
            const dateKey = plan.dates[0]
            const isBackfill = dateKey !== todayKey()
            const midnight = midnightOfKey(dateKey) ?? new Date()
            // 素材 = 数据,不是印象:当天审计(正序)+ 心情 + 想念 + 新记忆
            const audits = store.listAudit(midnight.getTime() / 1000 - 1, 30)
              .filter((r) => r.toolCall !== 'diary') // 不自引:日记不进日记素材
              .reverse() // 正序:一天的故事按时间讲
            const learned = store.db.prepare(
              'SELECT summary FROM episodic_memory WHERE timestamp >= ? AND is_active = 1'
              + ' ORDER BY timestamp ASC LIMIT 10'
            ).all(midnight.getTime() / 1000).map((r) => r.summary)
            const st = engine !== null ? await engine.longing(MASTER_ID, readSettings().longing) : null
            const lg = st !== null ? st : (store.longingRows()[0] ?? null)
            const page = await composeDiary(subagents, {
              dateKey,
              backfill: isBackfill,
              audits,
              mood: store.getState().moodIntensity,
              longing: lg === null ? null : {
                value: lg.value, threshold: lg.threshold, sinceMessage: lg.sinceMessage
              },
              learned
            }, routeAgent)
            if (page !== null) {
              const ok = commitDiary(store, {
                dateKey, content: page.content, mood: page.mood,
                longingValue: lg === null ? 0 : lg.value
              })
              diaryFail = 0
              diaryRetryAt = 0
              ctx.logger.info(ok
                ? 'echo: 她写了日记(' + dateKey + (isBackfill ? ',补写' : '') + ')'
                : 'echo: 日记已存在,跳过(' + dateKey + ')')
              // v0.38.0 F2:补写要留账(以后翻历史能看出这页是补的)
              if (ok && isBackfill) {
                try {
                  store.writeAudit({
                    traceId: 'diary-backfill-' + randomUUID(),
                    userInput: '(日记补写) ' + dateKey,
                    injectedMemories: '',
                    llmReply: String(page.content).slice(0, 60),
                    stageDetail: JSON.stringify({ diaryDate: dateKey }),
                    toolCall: 'diary'
                  })
                } catch { /* 留痕尽力而为 */ }
              }
              if (plan.dates.length > 1) {
                ctx.logger.info('echo: 日记还差 ' + (plan.dates.length - 1) + ' 页(下一拍接着补)')
              }
            } else {
              // v0.38.0 F2:连败**不再通宵每 60 秒试** —— 指数退避 + 留账
              diaryFail += 1
              diaryRetryAt = Date.now() + diaryRetryMs(diaryFail)
              ctx.logger.warn('echo: 日记组稿失败(' + dateKey + ',第 ' + diaryFail + ' 次)'
                + ' —— 退避到 ' + new Date(diaryRetryAt).toLocaleTimeString('zh-CN') + ' 再试')
              try {
                store.writeAudit({
                  traceId: 'diary-fail-' + randomUUID(),
                  userInput: '(日记组稿失败) ' + dateKey + ' 第 ' + diaryFail + ' 次',
                  injectedMemories: '',
                  llmReply: '退避 ' + Math.round(diaryRetryMs(diaryFail) / 60000) + ' 分钟后重试',
                  toolCall: 'diary_fail'
                })
              } catch { /* 留痕尽力而为 */ }
            }
          } finally {
            diaryBusy = false
          }
        } catch (err) {
          ctx.logger.warn('echo: diary tick failed — ' + String(err?.message ?? err))
        }
      }, 60000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'echo.diary()')
  }

  // ---- 4. webServer 路由(面板后端) ----
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/persona',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          return json(res, 200, {
            prefix: personaCache.prefix,
            suffix: personaCache.suffix,
            defaults: DEFAULT_PERSONA,
            customized: personaCache.customized,
            enabled: readEnabled(),
            maxChars: PERSONA_MAX_CHARS
          })
        }
        if (req.method === 'POST') {
          if (!writeAllowed(req)) return json(res, 403, { error: 'forbidden' })
          const body = await readBody(req)
          if (body === null || typeof body !== 'object') return json(res, 400, { error: 'bad request' })
          const saved = await savePersona(body.prefix, body.suffix)
          personaCache = {
            prefix: saved.prefix, suffix: saved.suffix,
            customized: saved.prefix !== DEFAULT_PERSONA.prefix || saved.suffix !== DEFAULT_PERSONA.suffix
          }
          lastLoadAt = saved.savedAt
          ctx.logger.info('echo: persona updated via panel (' + personaCache.prefix.length + '+' + personaCache.suffix.length + ' chars)')
          return json(res, 200, { ok: true, savedAt: saved.savedAt })
        }
        return json(res, 405, { error: 'method not allowed' })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.persona()')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/status',
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      return json(res, 200, statusPayload())
    }
  }), 'echo.api.status()')

  // ---- 4b. 电源开关路由(v0.2.1) ----
  // POST {enabled: boolean};同款写保护(回环 Origin + x-echo-edit)。
  // 翻转后广播 system-prompt/change(maid 先例):提示词缓存立即
  // 失效,下一个模型步就按新状态组装,不用重启不用重建会话。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/toggle',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!writeAllowed(req)) return json(res, 403, { error: 'forbidden' })
        const body = await readBody(req)
        if (body === null || typeof body !== 'object' || typeof body.enabled !== 'boolean') {
          return json(res, 400, { error: 'bad request: {enabled: boolean} required' })
        }
        const enabled = setEnabled(body.enabled, 'panel')
        try { ctx.emit('system-prompt/change') } catch { /* 广播失败无妨,下轮组装自然重读 */ }
        ctx.logger.info('echo: power ' + (enabled ? 'ON' : 'OFF') + ' via panel')
        try {
          store?.writeAudit({
            traceId: 'power-' + randomUUID(),
            userInput: '(面板电源)' + (enabled ? '唤醒' : '休眠'),
            toolCall: enabled ? 'power_on' : 'power_off'
          })
        } catch { /* 审计尽力而为 */ }
        return json(res, 200, { ok: true, enabled, ...readPower() })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.toggle()')

  // ---- 4b2. 会话范围路由(v0.9.0):工作娱乐两不误 ----
  // GET  → { scope, whitelist, exempt, sessions, power }(sessions = 审计里
  //        出现过的会话预览,辨认标签是最新一条用户输入);
  // POST → { scope } 切模式 | { sessionId, on } 切单会话。
  // 同款写保护。会话内还有更快的路:发「Echo 上线 / Echo 下线」。
  //
  // v0.30.0:GET/POST 都多带一个 `power`(总闸快照)—— 会话页角落那枚小按钮
  // 要拿它区分「这条会话关了」和「总闸关了」:后者点了也没用(会话闸开不了
  // 总闸),按钮必须显示成不可点,而不是假装能开。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/scope',
    handler: async (req, res) => {
      try {
        const powerSnapshot = () => {
          try { return readPower() } catch { return null }
        }
        if (req.method === 'GET') {
          // ★ 2026-10-25(第二拍,docs/bug-echo-new-session-default.md §5.3):这张表
          //   **按两件事滤,缺一条就漏**:
          //     ① 名单 —— `session/created` 当场记下的 subagentSessions(登记过的那批);
          //     ② id 形态 —— 裸 UUID 一律不列(重启**之前**就有的老会话没有名单可依;
          //        上一轮只按名单滤,于是活库里 22 条老会话照旧露出来)。
          //   判据是 lib/agent-scope.js 的 isScopeVisibleSession()(纯函数,单测喂假列表)。
          //   `global`(面板伪会话)与 `session-*`(顶层/陪伴/桥)一个都不动。
          //   **审计一个字不改**:/api/echo/audit 照旧能查到子代理的轮次(排障要)。
          const hiddenSub = readSubagentSessions()
          const sessions = store === null
            ? []
            : store.sessionPreviews().filter((x) => isScopeVisibleSession(x, hiddenSub))
          return json(res, 200, { ...readScope(), sessionLabels: readSessionLabels(), subagents: hiddenSub, subagentIdShape: SUBAGENT_ID_PATTERN, sessions, power: powerSnapshot() })
        }
        if (req.method === 'POST') {
          if (!writeAllowed(req)) return json(res, 403, { error: 'forbidden' })
          const body = await readBody(req)
          if (body === null || typeof body !== 'object') return json(res, 400, { error: 'bad request' })
          if (typeof body.scope === 'string') {
            setScope(body.scope, 'panel')
          } else if (typeof body.sessionId === 'string' && typeof body.on === 'boolean') {
            setSessionOn(body.sessionId, body.on)
            try {
              store?.writeAudit({
                traceId: 'scope-' + randomUUID(),
                userInput: '(面板范围)' + (body.on ? '上线' : '下线') + ' 会话 ' + body.sessionId,
                toolCall: body.on ? 'session_on' : 'session_off'
              })
            } catch { /* 审计尽力而为 */ }
          } else {
            return json(res, 400, { error: 'bad request: {scope} or {sessionId, on}' })
          }
          try { ctx.emit('system-prompt/change') } catch { /* 广播失败无妨,下轮组装自然重读 */ }
          // POST 回来的这份列表也要滤(GET 滤了它不滤 ⇒ 拨一下开关,面板上的子代理
          // 会话又冒回来 —— 同一个判据,同一份输出)。
          const hiddenSubPost = readSubagentSessions()
          const sessions = store === null
            ? []
            : store.sessionPreviews().filter((x) => isScopeVisibleSession(x, hiddenSubPost))
          return json(res, 200, { ok: true, ...readScope(), subagents: hiddenSubPost, subagentIdShape: SUBAGENT_ID_PATTERN, sessions, power: powerSnapshot() })
        }
        return json(res, 405, { error: 'method not allowed' })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.scope()')

  // ---- 4c. 仪表盘数据路由(v0.3.0,全只读) ----
  // AstrBot echo_audit_dashboard 六面板的 DSH 原生化:不再起独立
  // HTTP+WS 服务器,全部走宿主 webServer;实时感由客户端轮询实现
  // (先例插件无一用 WS,轮询是这个宿主里的惯用姿势)。
  const offline = (res) => json(res, 200, { offline: true })
  const queryOf = (req) => { try { return new URL(req.url, 'http://localhost').searchParams } catch { return new URLSearchParams() } }

  // ---- 4b3. 对话记录路由(v0.11.0,M8-a) ----
  // GET  /api/echo/conversations?limit=&channel= → 最近对话(倒序,
  //      全局滚动 100 轮)+ 全部会话标签;审查台回放 / 队友前端用。
  // POST /api/echo/session-label {sessionId, label} → 写会话来源标签
  //      (「QQ中继」「DSH直聊」…;写保护;中继桥 M8-b 自注册走这里,
  //      空标签 = 摘除)。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/conversations',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        if (store === null) return offline(res)
        const q = queryOf(req)
        const rows = store.listConversations({
          limit: Number(q.get('limit')) || 50,
          channel: q.get('channel') || ''
        })
        return json(res, 200, { rows, labels: readSessionLabels() })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.conversations()')

  // POST /api/echo/context/clear {sessionId} → 清空/压缩那条会话的旧历史
  //
  // 2026-09-26 他要一个「清空上下文」的按钮。查过宿主的 API:插件**没有**删历史
  // 的手(SessionSurface 的替换被来源校验锁着、只给压缩用;sessions.create 是
  // 调用方 fiber 所有、不进 agent 生命周期就不落盘)。宿主给用户自己的手是
  // /compact —— compaction.compactNow(agent, signal),它 selectCompactableRange
  // 时 retain 传 **0**:旧历史整段压成一条摘要,旧消息从她视野里消失,记录仍在。
  // 这个路由就是那只手的把手。判据/人话在 lib/context-clear.js(纯函数,有测试)。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/context/clear',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!writeAllowed(req)) return json(res, 403, { error: 'forbidden' })
        const body = await readBody(req)
        const sid = (body !== null && typeof body === 'object' && typeof body.sessionId === 'string')
          ? body.sessionId.trim()
          : ''
        if (sid === '') return json(res, 400, { error: 'bad request: {sessionId: string}' })
        return json(res, 200, await clearContextOf(sid))
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.contextClear()')

  /**
   * 清空一条会话的上下文(2026-09-26)。
   *
   * 插件**没有**删历史的手:SessionSurface 的替换被来源校验锁着、只给压缩用;
   * sessions.create 又是「调用方 fiber 所有」、不进 agent 生命周期就不落盘。
   * 所以这里走宿主自己给用户的 `/compact` 那条路:
   * compaction.compactNow(agent, signal) → selectCompactableRange(session,
   * measure, **0**) —— 旧历史整段压成一条摘要,旧消息从她视野里消失,记录仍在。
   * 面板按钮与 echo_context_clear 工具共用这一个函数。
   */
  async function clearContextOf (sid) {
    const compaction = ctx.get('compaction')
    if (compaction === undefined || compaction === null || typeof compaction.compactNow !== 'function') {
      return clearOutcome({ error: new Error('compaction unsupported: 宿主没有压缩服务') })
    }
    // 她最后说话可能是几小时前(会话睡着)——走和陪伴会话同一条唤醒路:
    // 活的直接拿、存档的 resume、全新的 create。
    let agent = ctx.agents?.get?.(sid)
    if (agent === undefined || agent === null) {
      const sc = ctx.get('sessionController')
      if (sc === undefined || typeof sc.create !== 'function') {
        return { ok: false, code: 'no-agent', text: '这条会话没有活着的 agent,而宿主也没给续会话的路。' }
      }
      const live = ctx.sessions?.get?.(sid)
      const cwd = String(live?.header?.cwd ?? '') !== '' ? String(live.header.cwd) : companionCwd()
      try { await mkdir(cwd, { recursive: true }) } catch { /* 目录建不了让 create 自己报 */ }
      try {
        await sc.create({ sessionId: sid, cwd })
      } catch (err) {
        return { ok: false, code: 'no-agent', text: '会话唤醒失败:' + String(err?.message ?? err) }
      }
      agent = ctx.agents?.get?.(sid)
      if (agent === undefined || agent === null) {
        return { ok: false, code: 'no-agent', text: '会话唤醒失败:建好了却拿不到 agent。' }
      }
    }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 180000)
    let out
    try {
      out = clearOutcome({ result: await compaction.compactNow(agent, ac.signal) })
    } catch (err) {
      out = clearOutcome({ error: err })
    } finally { clearTimeout(timer) }
    try {
      audit('context_clear', (out.ok ? '清空上下文:' : '清空上下文没成(' + out.code + '):') + sid + ' — ' + out.text)
    } catch { /* 审计写不进去不影响清空本身 */ }
    return out
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/session-label',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!writeAllowed(req)) return json(res, 403, { error: 'forbidden' })
        const body = await readBody(req)
        if (body === null || typeof body !== 'object' || typeof body.sessionId !== 'string' ||
            typeof body.label !== 'string') {
          return json(res, 400, { error: 'bad request: {sessionId: string, label: string}' })
        }
        const labels = setSessionLabel(body.sessionId, body.label)
        return json(res, 200, { ok: true, labels })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.sessionLabel()')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/audit',
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (store === null) return offline(res)
      const q = queryOf(req)
      return json(res, 200, { rows: store.listAudit(Number(q.get('since')), Number(q.get('limit')), q.get('light') === '1', q.get('sessionId') || '') })
    }
  }), 'echo.api.audit()')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/threads',
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (store === null) return offline(res)
      return json(res, 200, store.listThreads())
    }
  }), 'echo.api.threads()')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/longing',
    // M2-f:想念面板换引擎真值 —— 引擎读即刷新(补差落库),行值/
    // 阈值/沉默时长全用引擎口径;引擎不在或模糊失败回落 JS 复刻
    // (longingRows 的兜底数学),行上标 engine 来源,答辩可指着讲。
    handler: async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (store === null) return offline(res)
      const rows = store.longingRows()
      const out = await Promise.all(rows.map(async (row) => {
        try {
          const t = engine === null ? null : await engine.longing(row.userId, readSettings().longing)
          if (t === null || t.exists === false) return { ...row, engine: 'baseline' }
          return {
            ...row,
            value: Number(t.value) || 0,
            threshold: Number(t.threshold) || row.threshold,
            sinceMessage: Number(t.sinceMessage) || row.sinceMessage,
            kicked: Number(t.kicked) || 0,
            shouldCare: Boolean(t.shouldCare),
            engine: 'python'
          }
        } catch {
          return { ...row, engine: 'baseline' }
        }
      }))
      return json(res, 200, { rows: out })
    }
  }), 'echo.api.longing()')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/graph',
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (store === null) return offline(res)
      return json(res, 200, store.graphData())
    }
  }), 'echo.api.graph()')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/emotion',
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (store === null) return offline(res)
      return json(res, 200, { rows: store.emotionStates() })
    }
  }), 'echo.api.emotion()')

  // ---- 2026-10-05 G5/G6 第二步:联合空间读数(只读端点)----
  // 面板「情绪空间」页吃这一份。**不画、不算新东西**:复用 `unionSnapshot`
  // (同一套门禁 / 残差 / 来源标注),逐轮历史用审计行里的 `emotion_vector`
  // **现算** —— 参数取**当前**面板值,所以 history 里的 gate 反映的是今天的
  // 标定,不是当时那一轮的标定(面板上写明这一点)。
  // 三条纪律:只读(不回写任何读数)、fail-soft(IPC 副本缺失 ⇒ 空盘)、
  // 不猜(缺维 / 缺主人坐标一律 null,不填 0)。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/emotion-space',
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (store === null) return offline(res)
      let limit = 20
      try {
        const q = new URL(String(req.url ?? '/'), 'http://127.0.0.1').searchParams.get('limit')
        if (q !== null && q !== '') limit = Math.max(1, Math.min(50, Number(q) || 20))
      } catch { limit = 20 }
      const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v)
      try {
        const state0 = store.getState() // 只多读一次:下面 dyad / 基线都从这一份里取
        const cur = unionSnapshot(state0)
        const lex = unionIpc.lexiconSync() // 核心未加载 ⇒ null(画空盘)
        const roleA = num(cur.ipc && cur.ipc.agency)
        const roleC = num(cur.ipc && cur.ipc.communion)
        const role = (roleA === null || roleC === null) ? null : { a: roleA, c: roleC }
        const rows = store.listAudit(0, 200)
          .filter((r) => r.emotionVector && typeof r.emotionVector === 'object' && Object.keys(r.emotionVector).length > 0)
          .slice(0, limit)
        const history = rows.map((r) => {
          const snap = unionSnapshot({ emotionVector: r.emotionVector, previousEmotionVector: null })
          const a = num(snap.ipc && snap.ipc.agency)
          const c = num(snap.ipc && snap.ipc.communion)
          return {
            at: (Number(r.timestamp) || 0) * 1000,
            sessionId: r.sessionId || '',
            userEmotion: r.userEmotion === undefined ? null : (r.userEmotion || null),
            moodIntensity: r.moodIntensity === undefined ? null : (Number(r.moodIntensity) || 0),
            pad: snap.pad || null,
            dSource: snap.dSource ?? null,
            ipc: (a === null || c === null) ? null : { a, c },
            union: snap.union || null,
            sPad: num(snap.sPad), sIpc: num(snap.sIpc), bridgeErr: num(snap.bridgeErr),
            gate: snap.gate ?? 'unknown',
            direction: snap.direction ?? null,
            degraded: snap.degraded === true,
            missing: snap.missing || []
          }
        }).reverse() // 审计行是倒序 ⇒ 翻成"旧 → 新",轨迹才是顺着走的
        // ②(2026-10-05):面板要看得见「语气候选」那一行(看不见就调不动:
        // debug「她为什么用 <emo type="2">」得查得到)。**不新增列** —— 输入
        // (强度/上一轮强度/向量)本来就在审计行里,gate/union 用上面刚算好的那一行,
        // 口径与注入侧完全同一套函数。`source` 标明这是**现算**、不是当时注入的原文;
        // `enabled` 让面板能显示"开关关着 = 回滚态"。
        const newest = rows.length > 0 ? rows[0] : null
        const newestHist = history.length > 0 ? history[history.length - 1] : null
        let styleHint = null
        try {
          const hint = statusToStyleCandidates({
            moodIntensity: newest === null ? null : newest.moodIntensity,
            prevMoodIntensity: newest === null ? null : newest.prevMoodIntensity,
            emotionVector: newest === null ? null : newest.emotionVector,
            gate: newestHist === null ? 'unknown' : newestHist.gate,
            union: newestHist === null ? null : newestHist.union
          })
          styleHint = {
            enabled: readSettings().styleHint !== false,
            source: 'recomputed',
            at: newestHist === null ? null : newestHist.at,
            ...hint
          }
        } catch { styleHint = null }
        // ---- 2026-10-06:用户侧坐标 + 人格基线(两块都是**只读上屏**)----
        // 拍板 ①:他的点走打分器(存在 `emotion_vector.ipc_dyad` 里),她的点仍走映射;
        // 残差 `ipc_err` 只记账。拍板 ⑦⑧:基线只有 P/A 两维,`d` 恒 null。
        const dyad = readDyad(state0.emotionVector)
        const shown = applyGate(dyad)
        // 六个关系量要**两个**点;门禁红档 / 不可信 ⇒ 一律不给数(不是填 0)。
        const metricsOut = (shown.draw === true && role !== null && shown.other !== null)
          ? unionIpc.relationshipSync(role, shown.other)
          : null
        const baselineRaw = (() => { try { return readBaseline(readSettings()) } catch { return null } })()
        const baselineOut = (baselineRaw === null || baselineRaw.set !== true)
          ? null
          : {
            p: num(baselineRaw.p),
            a: num(baselineRaw.a),
            d: null, // dominance 在本仓"已登记未启用" ⇒ 基线不许把第三维编出来
            unit: baselineUnit(baselineRaw), // 立方体口径(双极 [−1,1]);拿不到 ⇒ null
            source: baselineRaw.source,
            updatedAt: num(baselineRaw.updatedAt),
            note: describeBaseline(baselineRaw)
          }
        return json(res, 200, {
          schema: SPACE_ID,
          at: Date.now(),
          mode: cur.mode ?? 'shadow',
          styleHint,
          enabled: cur.enabled !== false,
          pad: {
            p: num(cur.pad && cur.pad.valence),
            a: num(cur.pad && cur.pad.arousal),
            d: num(cur.pad && cur.pad.dominance),
            missing: cur.missing || [],
            dSource: cur.dSource ?? null
          },
          union: cur.union || null,
          // 当前读数的门禁四件套 + 方向:面板顶部那张「联合空间」卡直接读这六个
          // (③ 画圆盘时发现 ② 漏了它们 —— 卡片会显示"门禁未知 / 残差 —")。
          gate: cur.gate ?? 'unknown',
          bridgeErr: num(cur.bridgeErr),
          sPad: num(cur.sPad),
          sIpc: num(cur.sIpc),
          predicted: num(cur.predicted),
          direction: cur.direction ?? null,
          ipc: {
            role,
            octants: lex === null ? null : lex.octants,
            // 2026-10-06 锚点清单**砍掉**(拍板 ⑨):面板上那份 33 条目录与
            // `region.label`(强度档 + 分仪名)功能重复,而且它不随读数变化 ⇒
            // 同屏三套词只留读数那套。`octants` 留着(画环形分仪要用)。
            // ⚠️ `lib/ipc-core/lexicon.js` 模块**保留**:`describeRegion` 的最近词、
            // 178 条关系状态词、注入侧取姿态词都靠它 —— 砍的是"目录展示",不是词表。
            anchors: null,
            complementPoint: role === null ? null : unionIpc.complementOfSync(role),
            antiComplementPoint: role === null ? null : unionIpc.antiComplementOfSync(role),
            region: role === null ? null : unionIpc.describeRegionSync(role),
            anchor: cur.ipc ? (cur.ipc.anchor ?? null) : null,
            // ---- 2026-10-06:用户侧坐标(拍板 ①②③④⑤⑥)----
            // `other` = 她眼里的他;`metrics` = 六个关系量(两轴级 + 互补/对立/相似
            // + 理想位/原型/分离角)。**红档 / 不可信 ⇒ 两个都不给**(面板照旧画灰环
            // 占位),绝不填 0 —— 与联合空间"缺维不写"同一条纪律。
            other: shown.other,
            metrics: metricsOut,
            metricsNote: shown.note !== null
              ? shown.note
              : (metricsOut === null ? '关系度量要两个点:这一轮还差一个可用坐标' : null),
            // 对账(拍板 ①):同一次 appraise 的 `self` 与"映射出来的她"的差
            // (`ipc_err`)—— **只记账、不回写任何坐标**,也**不进** `space-bridge`
            // 的 s / 门禁(那是联合空间自己的残差,别混)。
            ipcErr: (dyad !== null && dyad.residual && typeof dyad.residual === 'object')
              ? { a: num(dyad.residual.a), c: num(dyad.residual.c), maxAbs: num(dyad.residual.maxAbs) }
              : null,
            errGate: shown.gate,
            gain: dyad === null ? null : num(dyad.gain),
            lowConfidence: dyad !== null && dyad.lowConfidence === true,
            at: dyad === null ? null : num(dyad.at),
            labels: dyad === null ? null : (dyad.labels || null),
            src: dyad === null ? null : (dyad.src ?? null)
          },
          // 人格基线(拍板 ⑦⑧):只读;没开总闸 / 没填 ⇒ `null`(立方体整块跳过)。
          baseline: baselineOut,
          history,
          degraded: cur.degraded === true || lex === null,
          ipcAvailable: unionIpc.available(),
          missing: cur.missing || [],
          dSource: cur.dSource ?? null,
          assumptions: EQUIVALENCE_NOTE,
          note: '只读:面板不做换算、不回写读数;history 的 gate 用当前面板参数现算'
        })
      } catch (err) {
        return json(res, 200, {
          schema: SPACE_ID, at: Date.now(), error: String((err && err.message) || err),
          history: [], note: '联合空间读数失败,已降级(不影响聊天)'
        })
      }
    }
  }), 'echo.api.emotionSpace()')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/health',
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (store === null) return offline(res)
      return json(res, 200, { ...store.memoryHealth() })
    }
  }), 'echo.api.health()')

  // ---- P1d(2026-10-05):称呼链的唯一出口(面板照这个拼人称/昵称正则)----
  // 面板原来把"<称呼>""对XX"写死在 web/app.js、web/audit-view.js 里 —— 换个人用就得
  // 改代码。真源是 `<数据目录>/profile.json`;前端**不读文件**,只问这一个端点。
  // 降级形状见 `readPublicProfile()`(中性角色词,绝不留真名)。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/profile',
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      return json(res, 200, publicProfile())
    }
  }), 'echo.api.profile()')

  // ---- P2 §6.3(2026-10-05):配置体检 —— 引导条(①)与数据体检页(⑧)的唯一数据源 ----
  // 只读:8 个白名单文件的 存在/空/坏/schemaRev + 缺什么该去哪填(深链)。
  // 不含 echo.db(§6.3:"只读文件内容,不读 echo.db")。判定口径见 lib/data-write.js。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/setup',
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      return json(res, 200, setupStatus())
    }
  }), 'echo.api.setup()')

  // P2 §6.4 的"失效缓存"这一步:宿主侧注册回调 —— persona.json 落盘后重新读它,
  // 下一轮组装就拿到新人格(P1e 之后人格真源就是这一个文件)。
  // 回调是**异步补课**:写盘不 await(§6.5 说人格"下一轮生效",没有时序问题)。
  registerCacheInvalidator((name) => {
    if (name !== 'persona.json') return
    loadPersona().then((p) => {
      personaCache = p
      lastLoadAt = new Date().toISOString()
      ctx.logger.info('echo: persona cache reloaded after panel write (' + p.prefix.length + '+' + p.suffix.length + ' chars)')
    }).catch((err) => {
      ctx.logger.warn('echo: persona cache reload failed after write: ' + String(err?.message ?? err))
    })
  })

  // ---- P2 §6.3:数据 API(6 条:GET/PUT /data/:file、validate、backup、export、import)----
  // 用**前缀**路由:`/api/echo/data/…` 后面那截在 `handleDataRequest` 里解析。
  // 本层只做两件事:**写保护**(回环 Origin + `x-echo-edit: 1`)、把 body 读出来;
  // 白名单 / 状态码 / 落盘时序全在 lib/data-write.js(所以那张表能被临时目录测穿)。
  // `echo.db` 不在白名单 ⇒ 403/404 从判定层就返回,够不着任何写函数。
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/api/echo/data',
    handler: async (req, res) => {
      try {
        const method = String(req.method || 'GET').toUpperCase()
        let body = null
        if (method === 'PUT' || method === 'POST') body = await readBody(req)
        const out = handleDataRequest({
          method, url: req.url || '', body, allowed: writeAllowed(req)
        })
        return json(res, out.status, out.payload)
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.data()')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/diary',
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (store === null) return offline(res)
      try {
        const q = queryOf(req)
        if (!q.has('date')) return json(res, 200, { rows: store.latestDiaries(7) })
        const dates = q.getAll('date')
        const date = dates[0]
        if (dates.length !== 1 || date.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
          return json(res, 400, { error: 'invalid date' })
        }
        // 公历按数值校验，不让 Date 自动纠正无效日，也不受时区或 0~99 年偏移影响。
        const [year, month, day] = date.split('-').map(Number)
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] || 0
        if (year < 1 || day < 1 || day > days) return json(res, 400, { error: 'invalid date' })
        const row = store.getDiaryDate(date)
        return json(res, 200, { rows: row === null ? [] : [row] })
      } catch {
        return json(res, 500, { error: 'diary unavailable' })
      }
    }
  }), 'echo.api.diary()')

  // M6-b 记忆浏览器:原始行分页 —— 审查记忆库的只读窗口。
  // 体检/图谱/审计都是聚合视图,这里给队友的前端浏览原始行:
  // 过滤(layer/state/source)+ 搜索(q)+ 排序(recent/value)。
  // ---- 4b-b. v0.32.0 B1:全量工具审计(补上「她干了什么」的最后一格)----
  // 自家 7 个工具由 auditToolCall 带上下文写审计;她在会话里用**宿主工具**
  // 做的事(读写文件/跑命令/子代理/拉网页……)以前一律不留痕。这条挂在
  // `tools/post-execute` 上,**只观察**:返回 next() 原样,绝不替换结果。
  // 闸位与注入/心跳同一把尺:电源 + 会话射程;`echo_*` 不重复记(但计数)。
  const toolAudit = createToolAudit({
    store,
    isEnabled: readEnabled,
    sessionEnabledOf: (sid) => sessionEnabled(String(sid ?? '')),
    logger: ctx.logger,
    traceOf: (sid) => turnTrace.of(sid) // v0.36.0 B2:工具行跟着这一轮的 trace 走
  })
  toolAuditState = () => toolAudit.stats()
  ctx.effect(() => toolAudit.attach(ctx), 'echo.toolAudit()')

  // ---- 4b-b. v0.38.0 F1:外部事件入口(传感器 / 将来的语音平台)----
  // 「他到家了」这类事件只做一件事:**排一个到点的 wake**(P2 已经建好的那只手),
  // 投递/夜闸/留账全走心跳那条老路 —— **不新开第二条投递链**
  // (第二条链就是第二个"45 小时没人发现"的地方)。
  // 默认 **off**(fail-closed):关着就 403,不静默收下。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/event',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!writeAllowed(req)) return json(res, 403, { error: 'forbidden' })
        if (readSettings().externalWake !== true) {
          // 开关关着:**不留痕地收下**才是问题(他以为门开着) ⇒ 明说
          return json(res, 403, { error: 'external-wake-off', hint: '面板「外部唤醒」开关关着(默认关)' })
        }
        const body = await readBody(req)
        const parsed = parseExternalEvent(body, Date.now())
        if (parsed.ok !== true) return json(res, 400, { error: parsed.error })
        if (store === null || typeof store.wakeAdd !== 'function') return json(res, 503, { error: 'store-offline' })
        const sid = parsed.sessionId || String(readSettings().sessionId || '')
        const wakeId = store.wakeAdd({
          at: parsed.at,
          note: parsed.note,
          why: eventReason(parsed.kind),
          sessionId: sid
        })
        try {
          store.writeAudit({
            traceId: 'event-' + randomUUID(),
            sessionId: sid || 'global',
            userInput: '(外部事件) ' + parsed.kind + (parsed.truncated ? '(文本已截断)' : ''),
            injectedMemories: '',
            llmReply: '排了 wake#' + wakeId + ' @ ' + new Date(parsed.at * 1000).toLocaleTimeString('zh-CN'),
            toolCall: 'event_in'
          })
        } catch { /* 留痕尽力而为 */ }
        ctx.logger.info('echo: 外部事件 ' + parsed.kind + ' ⇒ wake#' + wakeId
          + '(等心跳下一拍投递;夜闸/「她的闹钟」开关照样管着它)')
        return json(res, 200, {
          ok: true, kind: parsed.kind, wakeId, at: parsed.at, truncated: parsed.truncated,
          delivered: '等心跳下一拍(与她自己的闹钟同一条通道)'
        })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.event()')

  // ---- 4c. v0.15.1 运维面:调参 / 导出 / 整库清空 / 悬置话题 ----
  // G24 调参面板:GET 回当前值 + 默认值(前端拿默认值画「恢复默认」),
  // POST 走 toggle.writeSettings(校验钳位在同一处,不在面板里复制一份)。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/settings-schema',
    handler: (req, res) => req.method === 'GET'
      ? json(res, 200, settingsUIManifest())
      : json(res, 405, { error: 'method not allowed' })
  }), 'echo.api.settingsSchema()')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/settings',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          // token 是**写-only**:GET 一律回空串,面板只显示「设没设」。
          // (一个 GET 就能把桥的钥匙读走的接口,不该存在。)
          const s = readSettings()
          return json(res, 200, {
            settings: publicSettings(s),
            revision: settingsRevision(s),
            relayTokenSet: String(s.relay.token || '') !== '',
            defaults: SETTINGS_DEFAULTS,
            // 调参的**字段表**(标签/提示/类型/范围)也由这里发 —— 2026-09-26
            // 调参从 DSH 设置区搬去网页仪表盘,绝不能因此长出第二份字段表:
            // 字段只写在 lib/settings-fields.js,面板照着渲染即可。
            fields: SETTINGS_FIELDS,
            // P1e(2026-10-05):两个**只读派生**字段(personaSummary / personaRules)
            // 的值来自 persona.json,不该让用户在面板手抄一遍。派生值单独一格发出去,
            // **不并进 settings**(并进去会被面板回写进 config.json,又变成一份副本):
            // 面板只负责照着 fields 里的 readOnly/derived 展示,写盘侧忽略这两个键。
            derived: derivedPersonaFields(loadPersona())
          })
        }
        if (req.method === 'POST') {
          if (!writeAllowed(req)) return json(res, 403, { error: 'forbidden' })
          const body = await readBody(req)
          if (body === null || typeof body !== 'object') return json(res, 400, { error: 'bad request' })
          const patch = panelSettingsPatch((body.settings && typeof body.settings === 'object') ? body.settings : body)
          if (patch === null) return json(res, 400, { error: 'bad settings object' })
          // 面板留空 = 不改 token(不然每次存调参都会把桥的钥匙抹掉)。
          // 要停桥:关 enabled(总闸),不必清 token。
          if (patch.relay && typeof patch.relay === 'object' && patch.relay.token === '') {
            patch.relay = { ...patch.relay }
            delete patch.relay.token
          }
          const next = writeSettings(patch)
          ctx.logger.info('echo: settings updated via panel (auditKeep=' + String(next.auditKeep)
            + ' injectTopK=' + String(next.injectTopK) + ' ttl=' + String(next.memoryTtlDays) + 'd)')
          return json(res, 200, { ok: true, settings: publicSettings(next), relayTokenSet: String(next.relay.token || '') !== '', effective: 'next-use' })
        }
        return json(res, 405, { error: 'method not allowed' })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.settings()')

  // ---- 4c2. QQ 常驻对话(2026-10-01 尾)--------------------------------------
  // 他的需求:「在一个对话界面的角落加上『设置为 qq 常驻对话』的按钮,且**只能设置
  // 一个**」。配套诊断:重启后第一条 QQ 消息曾静默落进一条**已归档、网页里找不着**
  // 的会话(根因见 `ensureCompanion` 上面那道归档闸)。
  //
  // 这一层只做两件事:①把"当前常驻是谁 + 它可不可见"这份**唯一事实**发出去;
  // ②把按钮的写入落成 `settings.relay.sessionId`(沿用 `writeSettings`,深合并 ⇒
  // relay 组其它键一个字节不动)。**`relay.sessionId` 是单值** ⇒ "只能设一个"
  // 是结构性的,不是靠界面拦。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/qq-pin',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') return json(res, 200, qqPinState())
        if (req.method === 'POST') {
          if (!writeAllowed(req)) return json(res, 403, { error: 'forbidden' })
          const body = await readBody(req)
          if (body === null || typeof body !== 'object') return json(res, 400, { error: 'bad request' })
          if (body.reset === true) {
            writeSettings({ relay: { sessionId: DEFAULT_COMPANION_ID } })
            ctx.logger.info('echo: QQ 常驻恢复默认 — ' + DEFAULT_COMPANION_ID)
            return json(res, 200, { ok: true, ...qqPinState() })
          }
          const sid = String(body.sessionId ?? '').trim()
          if (sid === '') return json(res, 400, { error: 'sessionId 必填(要恢复默认请发 reset:true)' })
          const arch = archivedSessionIds()
          if (arch !== null && arch.has(sid)) {
            // 往归档会话里设常驻 = 复现"他找不到那次对话"的老坑 ⇒ 面板上**直接拒绝**,
            // 并把当前事实一起回给他(不静默、不假装成功)。
            return json(res, 409, {
              error: '这条会话已归档,网页里看不见 —— 换一条看得见的',
              ...qqPinState()
            })
          }
          writeSettings({ relay: { sessionId: sid } })
          ctx.logger.info('echo: QQ 常驻兜底会话 = ' + sid + '(面板设置)')
          return json(res, 200, { ok: true, ...qqPinState() })
        }
        return json(res, 405, { error: 'method not allowed' })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.qq-pin()')

  // ---- 4b2. 网页面板开关:给子代理开只读记忆工具(2026-10-01 阶段 2f)----------
  // 他的裁定:「`memorySubagentTools` 的 true/false **应当也能在网页仪表盘里改**才对。」
  // 以前只能手改 `$DSH_HOME/profiles/web/cordis.patch.yml`(宿主配置)⇒ 本次补一条面板路。
  //
  // 落在哪(为什么不写宿主配置):
  //   · **持久化沿用本插件既有的那一套** —— `toggle.setMemoryTools()` → 同一条
  //     `writeConfig` 原子写 → `$DSH_HOME/echo/config.json` 顶层 `memorySubagentTools`
  //     (与 enabled/scope 同层)。**不碰宿主任何文件**(patch 文件一个字节都没动)。
  //   · **点了立即生效**:POST 里落盘后当场 `syncSubagentMemoryTools('panel')` ——
  //     重算 →(需要开)动态 register 那 4 个只读工具 /(关)逐一个 dispose →
  //     重设 toolFilter provider。宿主依据见上面 5b 段的三条(`register()` 有 disposer、
  //     响应式层、`reflect.js` 每次现读 provider)⇒ **不需要重启、也不需要热重载**。
  //     所以任务里那条"只有既有方式做不到立即生效时才写 cordis.patch.yml"不成立,不选它。
  //   · 若动态注册**失败**(记忆库离线 / 注册抛错),回包里的 `applied:false` + `reason`
  //     会照实告诉面板 —— 面板据此显示「已落盘,但没挂上」,不许假装生效。
  //
  // 读保护与调参那条同款:`writeAllowed`(回环 Origin + `x-echo-edit: 1`)。
  const memoryToolsState = (extra = {}) => {
    const r = memoryToolsReading()
    // ★ 2026-10-01 尾:与挖边开关同一对来源标记(形状 / 判据 / 显示位置都照抄)。
    const flip = (() => { try { return readMemoryToolsFlip() } catch { return { by: '', at: 0 } } })()
    return {
      key: MEMORY_TOOL_CONFIG_KEY,
      envVar: MEMORY_TOOL_ENV,
      // 判定结论(与 apply()/子代理那一轮**同一份**读数)
      on: r.on,
      source: r.source,
      sourceLabel: memoryToolSourceLabel(r.source),
      // 三路各自的读数 —— 面板要能一眼答出"为什么现在是开/关"
      sources: { env: r.env, config: r.config, settings: r.settings },
      // 真实状态:4 个工具到底挂上了没有
      applied: subagentToolsApplied === true,
      // 真在册的个数 = disposer 的条数(半路注册失败时它比 4 小 —— 照实报,不按名义值编)
      registered: subagentToolsDisposers.length,
      toolNames: [...SUBAGENT_MEMORY_TOOL_NAMES],
      storeOnline: store !== null,
      // 面板开关自己的落盘值(未勾 = false;它不是调参项,不在 settings 段)
      panelValue: (() => { try { return readMemoryTools() } catch { return false } })(),
      // ★ 谁在什么时候拨的(照 poweredBy/poweredAt 的形状;'' + 0 = 没记)
      flip,
      flipLabel: flipProvenanceLabel(flip),
      // 「点了立即生效」由端点内的动态重算保证;GET 只是读数,不改任何东西
      immediate: true,
      ...extra
    }
  }
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/memory-tools',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') return json(res, 200, memoryToolsState())
        if (req.method === 'POST') {
          if (!writeAllowed(req)) return json(res, 403, { error: 'forbidden' })
          const body = await readBody(req)
          if (body === null || typeof body !== 'object') return json(res, 400, { error: 'bad request' })
          // 严格布尔:字符串 "true" / 1 / 缺字段一律 400 —— 与判定口径(`=== true`)一致,
          // 不许面板传什么就存什么(否则"打开"与"真的开"又成了两回事)。
          if (typeof body.enabled !== 'boolean') {
            return json(res, 400, { error: 'enabled 必须是严格布尔 true/false(收到的:' + JSON.stringify(body.enabled) + ')' })
          }
          setMemoryTools(body.enabled, 'panel')           // ① 落盘(原子写;失败上抛 → 500,不静默)
          const applied = syncSubagentMemoryTools('panel') // ② 当场对齐真实状态(立即生效)
          ctx.logger.info('echo: 面板拨「给子代理开只读记忆工具」= ' + String(body.enabled)
            + ' ⇒ on=' + String(applied.on) + ' applied=' + String(applied.applied)
            + ' reason=' + applied.reason + ' 来源=' + applied.source)
          return json(res, 200, { ok: true, ...memoryToolsState({ reason: applied.reason }) })
        }
        return json(res, 405, { error: 'method not allowed' })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.memory-tools()')

  // ---- 4b3. 网页面板开关:运行时自动挖影子边(2026-10-01 阶段 4)----------------
  // 他的裁定:「把"运行时自动挖边"也做成能在网页仪表盘拨、拨了立即生效的开关(默认关,
  // 不改任何现有行为)。」
  //
  // 与前一张卡(4b2)的三点不同,其余照抄(落盘方式 / 写保护 / 严格布尔 / 来源读数):
  //   · **消费者在引擎侧** —— 判据与落边都在 `python/engine/` 的闸门模块
  //     (`maybe_gate_shadow_edges`,接线口 = `worker.py` 的 graph_learn)。
  //     ⇒ 面板 POST 这里**没有工具要挂/摘**,落盘就是全部动作。
  //   · **"立即生效"是机制不是承诺**:引擎**每帧现读**这个文件(`gate_enabled()` 里的
  //     `config_flag_enabled()`,不缓存)⇒ 拨一下,下一帧判定就是新的。不用重启宿主、
  //     不用热重载(宿主 `hmr` 是 disabled ⇒ 走 env 那条路反而要重启,所以面板这条是
  //     这个部署里唯一"拨了立刻算数"的路)。
  //   · **默认关**:关掉时引擎 `连库都不读`(`maybe_gate_shadow_edges` 在开关关时
  //     直接返回,`written`/`receipts` 都是 null)⇒ 与现状**逐位零行为变化**,
  //     Python 侧有单测钉住三张表的差量全 0。
  //   · **落点 = 共现证据层**(**v2-A4,2026-10-01**):开着时写进 `graph_cooc_evidence`
  //     (一行 = 一条证据:n 元概念集 + 闸门放行的 pair 文本,pair 由只读视图按需派生)。
  //     `graph_shadow_edges` 那 48 条是 3a 的历史,**从此冻结**、不再增长。
  //
  // ⚠️ 三路 OR 里的 **loader 配置那一路**(②,`cordis.patch.yml` 的 `config:`)引擎
  // **读不到**(引擎只读文件)⇒ 下面紧接着把它**同步写进插件设置文件**(只在宿主配置
  // 显式 true 时写),否则面板显示"开"而引擎那边是关的 —— 那正是 2f 明令禁止的
  // 「显示的和真跑的两回事」。
  const graphGateReading = () => {
    let settingsPart = null
    try { settingsPart = readGraphShadowEdgeSetting() } catch { settingsPart = null }
    return graphGateSourceReport({ env: process.env, config: pluginConfig,
      settings: settingsPart })
  }
  const graphGateState = (extra = {}) => {
    const r = graphGateReading()
    // ★ 2026-10-01 尾:来源标记(谁拨的 / 什么时候)。**事故驱动** —— 这个键曾经
    // 被拨成 true 而谁也说不清是哪只手,面板当时只能显示"文件被写过"。老配置没有
    // 这对字段 ⇒ 如实显示「没记来源」,不猜(见 lib/toggle.js 上方那段记录)。
    const flip = (() => { try { return readGraphShadowEdgesFlip() } catch { return { by: '', at: 0 } } })()
    return {
      key: GRAPH_GATE_CONFIG_KEY,
      envVar: GRAPH_GATE_ENV,
      on: r.on,
      source: r.source,
      sourceLabel: graphGateSourceLabel(r.source),
      // 三路各自的读数 —— 面板要能一眼答出"为什么现在是开/关"
      sources: { env: r.env, config: r.config, settings: r.settings },
      // 引擎侧真读到的两路(env ∨ 插件设置文件);loader 那一路要靠上面的同步才成立
      engineOn: r.env === true || r.settings === true,
      // 面板开关自己的落盘值(未勾 = false;它不是调参项,不在 settings 段)
      panelValue: (() => { try { return readGraphShadowEdges() } catch { return false } })(),
      // ★ 谁在什么时候拨的(照 poweredBy/poweredAt 的形状;'' + 0 = 没记)
      flip,
      flipLabel: flipProvenanceLabel(flip),
      writesTo: 'graph_cooc_evidence(共现证据层:n 元,一行 = 一条证据;影子表 graph_shadow_edges 已冻结不再增长)',
      rollback: 'DELETE FROM graph_cooc_evidence(影子表那 48 条是审计;想一起清:DELETE FROM graph_shadow_edges)',
      // 「拨了立即生效」由"引擎每帧现读文件"保证;GET 只是读数,不改任何东西
      immediate: true,
      ...extra
    }
  }
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/graph-gate',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') return json(res, 200, graphGateState())
        if (req.method === 'POST') {
          if (!writeAllowed(req)) return json(res, 403, { error: 'forbidden' })
          const body = await readBody(req)
          if (body === null || typeof body !== 'object') return json(res, 400, { error: 'bad request' })
          // 严格布尔:与判定口径(`=== true`)一致 —— 面板传什么就存什么会让"打开"
          // 与"真的开"又成了两回事(与 4b2 同一条纪律)。
          if (typeof body.enabled !== 'boolean') {
            return json(res, 400, { error: 'enabled 必须是严格布尔 true/false(收到的:' + JSON.stringify(body.enabled) + ')' })
          }
          // ★ 2026-10-01 尾:'panel' = 「这条路是被网页仪表盘那张卡拨的」。
          // **任何**把该键写成 true 的路径都得留下来源标记(起因见 lib/toggle.js 上方那
          // 段事故记录:这个键 2026-10-01 21:33 曾是 true,谁也说不清是哪只手拨的)。
          setGraphShadowEdges(body.enabled, 'panel')   // 落盘(原子写;失败上抛 → 500,不静默)
          const flip = (() => { try { return readGraphShadowEdgesFlip() } catch { return { by: '', at: 0 } } })()
          ctx.logger.info('echo: 面板拨「自动挖影子边」= ' + String(body.enabled)
            + ' ⇒ on=' + String(graphGateReading().on) + ' 来源=' + graphGateReading().source
            + ' 留痕=' + flipProvenanceLabel(flip)
            + '(引擎下一帧现读该文件生效)')
          return json(res, 200, { ok: true, ...graphGateState() })
        }
        return json(res, 405, { error: 'method not allowed' })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.graph-gate()')

  // ---- A7. 记忆架构 v2:状态 + 一键回退(`GET/POST /api/echo/graph-arch`)----
  // 引擎探测到的那个 python(拿不到就让 `arch.js` 走 PATH 兜底 —— 探测过一次就够,
  // 面板读数不该因为探测时机不同而时好时坏)。
  const enginePythonPath = () => {
    try { const st = engine.state(); return (st && st.python && st.python.path) || null } catch { return null }
  }
  // 这一格是他要求"看得见、审得动、退得回"的那一格(计划 §5.A7):
  //   * GET  只读聚合(主题簇 / 证据层 / 影子表 / 回执 / 回退入口)—— 纯显示;
  //   * POST 一键回退:按 receipt 反做最近一批(**写**,所以要 writeAllowed + 显式 confirm)。
  // 口径全在引擎(`python/engine/arch.py`):这里不判断哪格能退、不重算任何东西。
  // 两条路线之外一律拒(`shadow-table` 已冻结,白名单里就没有它 ⇒ 误点也点不动)。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/graph-arch',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          const r = await readArchStatus({ dbPath: DB_PATH, pythonPath: enginePythonPath() })
          if (!r.ok) return json(res, 503, { error: 'engine-arch-unavailable', detail: r.error })
          return json(res, 200, r.data)
        }
        if (req.method === 'POST') {
          if (!writeAllowed(req)) return json(res, 403, { error: 'forbidden' })
          const body = await readBody(req)
          if (body === null || typeof body !== 'object') return json(res, 400, { error: 'bad request' })
          if (body.action !== 'rollback') {
            return json(res, 400, { error: 'bad request: {action:"rollback", route, confirm:true}' })
          }
          if (body.confirm !== true) {
            return json(res, 400, { error: '需要显式 confirm:true —— 回退是写动作,不许手滑' })
          }
          const route = String(body.route ?? '')
          if (!ARCH_ROUTES.includes(route)) {
            return json(res, 400, {
              error: 'route-not-allowed',
              hint: '可回退的只有:' + ARCH_ROUTES.join(' / ')
                + '(`shadow-table` 已冻结,**没有回退这个动作**)'
            })
          }
          const r = await rollbackArch({ dbPath: DB_PATH, route, pythonPath: enginePythonPath() })
          if (!r.ok) return json(res, 503, { error: 'engine-arch-unavailable', detail: r.error })
          const out = r.data
          ctx.logger.info('echo: 面板一键回退 route=' + route + ' → applied=' + String(out.applied)
            + ' rows=' + String(out.rows) + ' receipts=' + String(out.receipts)
            + (out.refused ? ' refused=' + out.refused : ''))
          if (out.applied !== true) {
            return json(res, 409, { ok: false, refused: out.refused || 'nothing-to-rollback', rollback: out })
          }
          return json(res, 200, { ok: true, rollback: out })
        }
        return json(res, 405, { error: 'method not allowed' })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.graph-arch()')

  // loader 配置那一路(②)落成文件:引擎读不到宿主配置文件(见文件头)。
  // 只在宿主配置**显式 true** 时写 —— 它是"期望值",不是每次 apply 都覆盖用户的面板选择。
  // 失败不上抛(apply 不许因为这个挂掉),但要**说出来**。
  try {
    if (graphGateEnabledFromConfig(pluginConfig) && readGraphShadowEdges() !== true) {
      // ★ 留痕:'loader-config' = 「宿主配置(cordis.patch.yml)里写了 true,apply 时同步进来的」。
      // ⚠️ 本部署里这一路是**死代码**:echo 这条 entry 由 dsh-echo/cordis.patch.yml 插入,
      // 条目上没有 `config:` ⇒ `pluginConfig.graphShadowEdges` 永远是 undefined(见 B 段结论)。
      // 留着它是因为它在本插件被别的 profile 以 `config: {graphShadowEdges: true}` 装载时
      // 才是活路 —— 那时也必须留痕,否则又回到"没人说得清"。
      setGraphShadowEdges(true, 'loader-config')
      ctx.logger?.info?.('echo: 宿主配置 graphShadowEdges=true ⇒ 已同步进插件设置文件'
        + '(引擎每帧现读该文件 ⇒ 生效)')
    }
  } catch (err) {
    ctx.logger?.warn?.('echo: graphShadowEdges 同步进插件设置文件失败 — '
      + String(err?.message ?? err))
  }

  // ---- 4c.(已退役)传话桥 HTTP 路由 ----
  // 2026-09-28:旧桥**完整退役**。这 5 个端点(`/api/echo/relay/{inbound,outbox,ack,channels,channel}`)
  // 与那套「适配器带 Bearer token 来取」的传输一起删掉了 —— 它是 AstrBot 时代的腿,
  // 而"腿"现在由渠道插件走**服务注入**(`echo:relay`,见本文件上面的 provide 段)承担。
  // 留在原地的只有**内核**:`relay.parseEnvelope / handleInbound / lease / ack / setChannel`
  // —— 同一份业务逻辑,换一条更短的管子(可证:`tests/relay.test.js` 一个用例都没改)。
  // 要回看当年的 HTTP 契约:`git show $(上一个提交):lib/index.js` + docs/archive/RELAY_PLAN.md。

  // G16 对话导出(复现包)。A 是 `export_conversation.py`(.md + .json:
  // 轮次/注入画像/记忆/情绪包/内部状态/回复/向量差分/余波 + agent_state/
  // longing/开放话题)。DSH 里这些事实分散在审计流、会话索引、store 的
  // 几张表里,所以导出 = 把同一批真值打成一份人可读 + 一份机器可读。
  // 只读、只 GET(导出不改任何东西)。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/export',
    handler: (req, res) => {
      try {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        if (store === null) return offline(res)
        const q = queryOf(req)
        const format = (q.get('format') || 'md').toLowerCase() === 'json' ? 'json' : 'md'
        const limit = Math.min(2000, Math.max(1, Number(q.get('limit')) || 200))
        const sessionId = String(q.get('session') || '')
        const pack = buildExportPack({
          meta: { version: VERSION, generatedAt: Date.now(), dataDir: DATA_DIR, dbPath: DB_PATH },
          settings: readSettings(),
          state: store.getState(),
          profile: store.getProfile(),
          audit: store.listAudit(0, limit),
          threads: store.listThreads(100),
          longing: store.longingRows(),
          health: store.memoryHealth(),
          sessions: store.sessionPreviews(60),
          filter: { sessionId }
        })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const name = 'echo-export-' + stamp + (sessionId ? '-' + sessionId.slice(0, 12) : '')
        if (format === 'json') {
          return sendDownload(res, name + '.json', 'application/json; charset=utf-8',
            JSON.stringify(pack, null, 2))
        }
        return sendDownload(res, name + '.md', 'text/markdown; charset=utf-8',
          renderExportMarkdown(pack))
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.export()')

  // G14 整库清空(不可逆)。二次确认**两层**:面板必须手打确认短语,
  // 引擎帧还要求 confirm=true(worker 帧自己也会拒收)。A `/mem_clear`
  // 是「主人 + confirm 参数」,这里换成「回环写保护 + 手打短语」——
  // 面板点一下不该能抹掉她的记忆。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/memory/clear',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!writeAllowed(req)) return json(res, 403, { error: 'forbidden' })
        const body = await readBody(req)
        const phrase = String(body?.confirm || '').trim()
        if (phrase !== MEMORY_CLEAR_PHRASE) {
          return json(res, 400, {
            error: 'confirmation-required',
            need: MEMORY_CLEAR_PHRASE,
            hint: '这一步不可逆,请输入确认短语'
          })
        }
        // (v0.29.0:include_members 随群聊退役 —— 单用户下本来就是同一次清理)
        const r = await engine.memoryClear()
        if (r === null) return json(res, 503, { error: 'engine-busy' })
        const episodic = Number(r.episodic) || 0
        const profile = Number(r.profile) || 0
        try {
          store.writeAudit({
            traceId: 'clear-' + randomUUID(),
            userInput: '(整库清空)',
            injectedMemories: '',
            ...moodPackForAudit(),
            llmReply: '情景记忆 ' + String(episodic) + ' 条、画像 ' + String(profile) + ' 项',
            moodIntensity: store.getState().moodIntensity,
            prevMoodIntensity: store.getState().prevMoodIntensity,
            emotionVector: store.getState().emotionVector ?? {},
            toolCall: 'memory_clear'
          })
        } catch { /* 审计失败不改结论 */ }
        ctx.logger.warn('echo: memory cleared via panel — episodic=' + String(episodic)
          + ' profile=' + String(profile))
        return json(res, 200, { ok: true, episodic, profile })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.memoryClear()')

  // G15 悬置话题人工动作(A `/threads done <关键词>` / `/threads add <内容>`)。
  // GET 仍是原来的列表;POST 走人工动作,两条都留审计(toolCall='threads')。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/threads/act',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!writeAllowed(req)) return json(res, 403, { error: 'forbidden' })
        if (store === null) return offline(res)
        const body = await readBody(req)
        const action = String(body?.action || '').trim().toLowerCase()
        if (action === 'done') {
          const query = String(body?.query || '').trim().slice(0, 120)
          if (query.length < 2) return json(res, 400, { error: 'bad request: {action:"done", query}' })
          const r = await engine.threadsDone(query)
          if (r === null) return json(res, 503, { error: 'engine-busy' })
          const threadId = Number(r.threadId) || 0
          auditToolCall('(结掉话题)' + query, 'threads')
          return json(res, 200, { ok: true, action: 'done', threadId })
        }
        if (action === 'add') {
          const content = String(body?.content || '').trim().slice(0, 300)
          if (content.length < 2) return json(res, 400, { error: 'bad request: {action:"add", content}' })
          const r = await engine.threadsAdd(content)
          if (r === null) return json(res, 503, { error: 'engine-busy' })
          auditToolCall('(登记话题)' + content.slice(0, 60), 'threads')
          return json(res, 200, {
            ok: true, action: 'add',
            threadId: Number(r.threadId) || 0, created: r.created === true
          })
        }
        if (action === 'restore') {
          // 2026-10-06 D5:人工"恢复" —— 把冷却中(或误判冷却)的话题拉回活跃。
          // 已归档/被取代/已了结的不给恢复(语义终态;引擎侧只认冷却行)。
          const threadId = Number(body?.threadId) || 0
          if (threadId <= 0) return json(res, 400, { error: 'bad request: {action:"restore", threadId}' })
          const r = await engine.threadsRestore(threadId)
          if (r === null) return json(res, 503, { error: 'engine-busy' })
          auditToolCall('(恢复话题)#' + threadId, 'threads')
          return json(res, 200, {
            ok: true, action: 'restore', threadId, restored: r.restored === true
          })
        }
        return json(res, 400, { error: 'bad request: action must be done|add|restore' })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.threadsAct()')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/memories',
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (store === null) return offline(res)
      const q = queryOf(req)
      // v0.16.0 M1:回指用 —— `?ids=12,13` 按 id 取行(图谱页点「依据」
      // 展开原文走这里)。默认不过滤 is_active/status:被取代的旧行
      // 也是历史,面板照实显示并标出「已让位」。
      const idsRaw = q.get('ids') || ''
      if (idsRaw !== '') {
        const ids = idsRaw.split(/[,，\s]+/).map((s) => Number(s)).filter((x) => Number.isFinite(x) && x > 0)
        return json(res, 200, { rows: store.memoriesByIds(ids), total: ids.length })
      }
      return json(res, 200, store.listMemories({
        page: Number(q.get('page')),
        limit: Number(q.get('limit')),
        layer: q.get('layer') || '',
        state: q.get('state') || 'active',
        source: q.get('source') || '',
        q: q.get('q') || '',
        sort: q.get('sort') || 'recent'
      }))
    }
  }), 'echo.api.memories()')

  // M6-d 记忆手动管理(用户裁决开闸面板写路径):编辑 + 状态机。
  // 同款写保护(回环 Origin + x-echo-edit);审计行留痕
  // (toolCall='memory_edit'/'memory_state'),SSE 照常推 —— 现场改
  // 一条记忆,审计流立刻可见。物理删除不存在:遗忘 = 留档。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/memory/edit',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!writeAllowed(req)) return json(res, 403, { error: 'forbidden' })
        if (store === null) return offline(res)
        const body = await readBody(req)
        if (body === null || typeof body !== 'object' || !Number(body.memoryId)) {
          return json(res, 400, { error: 'bad request: {memoryId, summary?, keywords?, emotionScore?}' })
        }
        const out = store.editMemory(body)
        if (out === null) return json(res, 404, { error: 'memory not found' })
        if (out.error !== undefined) return json(res, 400, out)
        return json(res, 200, out)
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.memoryEdit()')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo/memory/state',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!writeAllowed(req)) return json(res, 403, { error: 'forbidden' })
        if (store === null) return offline(res)
        const body = await readBody(req)
        if (body === null || typeof body !== 'object' || !Number(body.memoryId) || !String(body.action || '')) {
          return json(res, 400, { error: 'bad request: {memoryId, action}' })
        }
        const out = store.setMemoryState(body)
        if (out === null) return json(res, 404, { error: 'memory not found' })
        if (out.error !== undefined) return json(res, 400, out)
        return json(res, 200, out)
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'echo.api.memoryState()')

  // ---- 4d. SSE 半推通道(M3-c):审计流真推送 ----
  // 先例:宿主 HMR 事件流(handler 同步写头即返回,close 收尾;压缩层
  // 明确保全 SSE)。服务端 3s 查审计增量 —— 审计表是壳拥有的唯一事件
  // 日志,三条写入路都过它;推「有新行」信号,行由客户端拉。断线由
  // 浏览器 EventSource 内建重连,轮询兜底不变。
  if (store !== null) {
    const events = createEchoEvents({ store })
    ctx.effect(() => {
      const disposeRoute = webServer.register({
        kind: 'exact',
        path: '/api/echo/events',
        handler: (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405)
            res.end()
            return
          }
          events.attach(res)
        }
      })
      return () => {
        disposeRoute()
        events.dispose()
      }
    }, 'echo.api.events()')
  }

  // ---- 4e. 审查台静态页(M6-a):前端队友的页面住在 web/ ----
  // 前缀路由 /echo → 每请求现读文件(改 web/ → install → 刷新,
  // 不用重启 dsh web)。同源:页面里 fetch /api/echo/* 与
  // EventSource 直接可用,零 CORS。十卡面板原样保留在设置区,
  // 本路由只是给队友的前端一个生产住址。
  {
    // v0.11.1 修(M6-a 潜伏雷):webRoot 公式唯一真源在 webpage.js 的
    // webRootOf —— 包根的 web/(lib 上两级)。原公式 dirname+'web' =
    // lib/web,装机副本里不存在,/echo/ 从 M6-a 起 404,用户点开才
    // 炸雷(smoke 只测了显式传 rootDir 的纯函数,接线无人验)。
    const webRoot = webRootOf(import.meta.url)
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/echo',
      handler: createWebPageHandler({ rootDir: webRoot })
    }), 'echo.webpage()')
  }

  // ---- 5. echo_status 诊断工具 + echo_* 记忆工具族(M3-b)+ 她的手 ----
  ctxLogger = ctx.logger
  ctx.tools.register(defineTool(statusToolDefinition()))
  ctx.tools.register(defineTool(forwardReader.toolDefinition()))
  ctx.tools.register(defineTool(fileReader.toolDefinition()))
  ctx.tools.register(defineTool(fileSender.toolDefinition()))
  for (const def of memoryToolDefinitions()) {
    ctx.tools.register(defineTool(def))
  }
  // ---- 5b. 阶段 2 形态 (b):子代理通道的 4 个只读记忆工具(**默认关**)----
  //
  // 开关**默认关**,三路任一为真即开(键名与判定见 lib/memory-read-tools.js):
  //   ① 环境变量 `ECHO_MEMORY_SUBAGENT_TOOLS=1` —— `process.env` 在宿主进程启动时固定,
  //      本处又只在 `apply()` 里读一次 ⇒ 改它 = **必须重启宿主**才生效;
  //   ② 配置 `memorySubagentTools: true` —— 认 loader 传给 `apply(ctx, config)` 的 config
  //      (在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里给 `id: echo` 那一行加 `config:`);
  //      本部署 web profile 是 `patchReload: "live"`(宿主 `dsh-app-boot` 的
  //      `watchUserPatches()` 监视 profile / home 两份 patch)⇒ **配置改动无需重启即可重新组合**。
  //      ⚠️ 代码层不热加载(`dsh-base` 的 `hmr` 行 disabled)⇒ 这条路的前提是"这份代码已在跑"。
  //   ③ **网页面板开关**(2026-10-01 阶段 2f,他的裁定:「网页仪表盘里也该能改才对」)——
  //      落 `$DSH_HOME/echo/config.json` 顶层 `memorySubagentTools`(与 enabled/scope 同层),
  //      由 `GET/POST /api/echo/memory-tools` 读写,**POST 里当场生效**(见下 sync 的注释),
  //      不用重启、也不用碰宿主任何文件。
  //
  // ⚠️ 已知代价(所以默认必须是关):宿主 `toolFilter` 是 **restrict 语义** ——
  // 只能从子代理**继承来的**工具面里拿掉工具(`dsh-subagent` 的 `applyChildComposition`
  // → `childCtx.tools.restrict(...)`),没有"只给某个 child 注册工具"的原语
  // (in-process 驱动的 `setup` 由驱动自己拥有,调用方注入不进去)。⇒ 工具必须注册在
  // **全局层**才能被子代理看见,**打开开关时主会话也会看到这 4 个工具**。
  // 想做到真正的"只给子代理",要宿主加 per-child 注册钩子 —— 宿主侧需求,本插件改不了。
  //
  // 关 = **一个工具都不注册** + `runStructured` 那边仍是 `{ allow: [] }` ⇒ 逐位不变。
  // 注册与名单必须**同源同刻**(宿主对"名单里有、工具不在"是 loud 拒绝,子代理会直接起不来):
  // 两边都由下面 `syncSubagentMemoryTools()` 一处算,任何失败都一起退回关。
  //
  // ---- 动态注册/摘除的三条宿主依据(checkout 只读,已核)------------------------------
  //   · `dsh-tools/lib/index.js:2768-2782`:`register()` **返回 disposer**,实现是
  //     `layers.effect(this.ctx, …)`(响应式层 + `onChange()` 通知工具目录)⇒ 运行时可加可减;
  //   · `dsh-scope/lib/index.js:189-218`:`ScopedLayers.effect` 就是 `ctx.effect(fn)` + onChange;
  //   · `cordis/lib/index.js:1134-1142`:effect 回调**返回函数**即收作 disposer
  //     ⇒ `ctx.effect(() => () => cleanup())` 合法;
  //   · `lib/reflect.js:180-187`:`resolveSubagentToolFilter` 每次 `runStructured` 都**现读** provider
  //     ⇒ 名单跟着注册走,不需要重载。
  // ----------------------------------------------------------------------------------
  let subagentToolsDisposers = []
  let subagentToolsApplied = false
  // 收尾(本插件 fiber 上的 effect):重载/卸载时把动态注册的 4 个工具**摘干净**。
  // 为什么显式收(cordis 语义核准过,别凭印象):
  //   · `ctx.tools.register()` 里的 effect 用的是服务方法内的 `this.ctx`,而 cordis 的 tracker
  //     会把它解析成**调用者**(=echo)的 ctx(`cordis/lib/index.js:84-165`,关键行 `:128`
  //     `if (prop === tracker.property) return ctx`)⇒ 注册**本来就挂在我们的 fiber 上**,
  //     宿主热重载时随它一起摘掉。
  //   · 但我们**不依赖**那一层:① 这条 effect 让"重载后二次 apply 不会撞
  //     `tool "memory_search" is already registered`"变成我们自己说了算(替身 harness 里可复现);
  //     ② ON→OFF 那条路本来就需要主动摘(见下面 disposeSubagentMemoryTools)。
  // 症状若漏掉:二次 apply 撞名 ⇒ try/catch 退回关 ⇒ 静默少能力(比报错更难发现)。
  ctx.effect(function * () {
    yield () => {
      for (const d of subagentToolsDisposers) {
        try { d() } catch { /* 宿主/工具服务可能已经在拆了 —— 收尾尽力而为,不许抛 */ }
      }
      subagentToolsDisposers = []
      subagentToolsApplied = false
    }
  }, 'echo: subagent memory tools teardown')

  /** 判定结论({on, source})—— 判据就是**上面这一个共享函数**,本处一行判据都不另写。 */
  const readSubagentMemoryTools = () => {
    let settingsPart = null
    try { settingsPart = readMemoryToolSetting() } catch { settingsPart = null }
    return memoryToolsEnabled({ env: process.env, config: pluginConfig, settings: settingsPart })
  }

  /**
   * 当前读数(面板要的完整版):三路 OR 的结论 + 三路各自的布尔。
   * 同样只走 `memoryToolsEnabled`(由 `memoryToolSourceReport` 代调),不另写判据。
   */
  const memoryToolsReading = () => {
    let settingsPart = null
    try { settingsPart = readMemoryToolSetting() } catch { settingsPart = null }
    return memoryToolSourceReport({ env: process.env, config: pluginConfig, settings: settingsPart })
  }

  /** 摘掉当前注册的 4 个工具(先收名单,再摘工具 —— 任何一刻都不让名单比工具长)。 */
  function disposeSubagentMemoryTools () {
    setSubagentToolFilterProvider(() => subagentToolFilter(false))
    for (const d of subagentToolsDisposers) {
      try { d() } catch { /* 已随宿主一起走 */ }
    }
    subagentToolsDisposers = []
    subagentToolsApplied = false
  }

  /**
   * 重算并**当场**对齐真实状态(apply 时一次;面板 POST 时再一次)。
   *
   * 顺序是硬约束(宿主对"名单里有、工具不在"是 loud 拒绝):
   *   ① 先把 provider 关掉(名单立刻为空) → ② 摘掉旧工具 → ③ 需要开才注册新工具
   *   → ④ 全部成功后才把 provider 打开。
   * @param {string} why 留痕:'apply' | 'panel'
   * @returns {{on:boolean, source:string, applied:boolean, reason:string}}
   */
  function syncSubagentMemoryTools (why) {
    disposeSubagentMemoryTools()
    const verdict = readSubagentMemoryTools()
    let applied = false
    let reason = ''
    if (verdict.on !== true) {
      reason = 'off'
      ctxLogger?.info?.('echo: 子代理记忆工具=关(' + why + ')')
    } else if (store === null) {
      // 开关开着但记忆库离线:照实说 —— 不许显示"已开"而其实一个工具都没挂上。
      reason = 'store-offline'
      ctxLogger?.warn?.('echo: 子代理记忆工具开关=开,但记忆库离线 ⇒ 一个工具都没注册(' + why + ')')
    } else {
      try {
        const reader = createReadOnlyReader(store)
        const defs = memoryReadToolDefinitions(reader)
        // 逐个注册、**逐个收进** disposers:半路抛也要能把已经挂上的摘回去。
        const disposers = []
        for (const def of defs) {
          disposers.push(ctx.tools.register(defineTool(def)))
          subagentToolsDisposers = disposers
        }
        setSubagentToolFilterProvider(() => subagentToolFilter(true))
        subagentToolsApplied = true
        applied = true
        reason = 'on'
        ctxLogger?.info?.('echo: 子代理记忆工具已开(' + String(defs.length) + ' 个,只读;来源 '
          + verdict.source + ';' + why + ')')
      } catch (err) {
        // 半截状态(名单里有、工具不在)比"没开"危险得多 ⇒ 连已注册的一起退回关。
        // 半路注册留下的名字也必须摘(否则占着名,下一次注册会撞 already registered)。
        try { disposeSubagentMemoryTools() } catch { /* 尽力而为 */ }
        subagentToolsApplied = false
        reason = 'register-failed'
        ctxLogger?.warn?.('echo: 子代理记忆工具注册失败,已整体退回关 — ' + String(err?.message ?? err))
      }
    }
    return { on: verdict.on, source: verdict.source, applied, reason }
  }

  const subagentMemoryTools = syncSubagentMemoryTools('apply')
  if (subagentMemoryTools.on && !subagentMemoryTools.applied) {
    ctx.logger?.warn?.('echo: 子代理记忆工具开关=开但没挂上(' + subagentMemoryTools.reason
      + ')—— 状态面与面板都会照实显示')
  }
  const settingsWakeOn = () => {
    try { return readSettings().wakeEnabled !== false } catch { return true }
  }
  // v0.31.0 P2:她自己的闹钟(echo_wake / echo_wake_cancel)。
  // 为什么**不**跟手(echo_qq_say / echo_qq_call)一起挂在"嘴出现"上:
  // 排闹钟只写我们自己的库,不需要嘴在 —— 而"嘴不在"恰恰是她最需要留个闹钟
  // 提醒自己"到点要跟他说"的时候(45 小时那次:适配器不在,整条路都是哑的)。
  for (const def of wakeToolDefinitions({
    store,
    // 能不能排 = 电源闸 ×「她的闹钟」开关;理由要分得清(她才知道自己去开哪个)
    isEnabled: () => readEnabled() && settingsWakeOn(),
    offReason: () => (readEnabled() ? 'wake-off' : 'power-off'),
    sessionEnabledOf: (sid) => sessionEnabled(sid),
    // 闸门读数(事前声明给她看):日上限用量 + 夜闸现状。判据只有一份 ——
    // 日上限的真相源是审计表(与心跳同源),夜闸读设置。
    gates: () => {
      const midnight = new Date()
      midnight.setHours(0, 0, 0, 0)
      let used = 0
      try { used = Number(store.careCountSince(midnight.getTime() / 1000)) || 0 } catch { used = 0 }
      let night = false
      try {
        night = readSettings().longing?.night_hold !== false && isNightHour(new Date())
      } catch { night = false }
      return { used, cap: CARE_DAILY_CAP, night }
    },
    audit: auditToolCall
  })) {
    ctx.tools.register(defineTool(def))
  }
  // 她的两只手(echo_qq_say / echo_qq_call)**跟着嘴走,不跟启动顺序走**。
  //
  // 2026-09-28 现场(她突然不说话了):退役旧桥后,"有嘴"从**配置**(总闸,
  // 启动那一刻就是 true)变成**注册**(渠道插件晚几秒才自报家门)⇒ 原来这里只在
  // 启动那一瞬判一次 `hasChannel()`,于是手永远没登记;而她那一轮的提示词是**动态**
  // 读 `hasChannel()` 的(会写"想让他收到,你得自己用 echo_qq_say 发")⇒ 她一直去试
  // 一只不存在的手(`unknown tool`),话全卡在她这边,他一个字收不到。
  // 现在:启动能判就判(快路),判不了就挂一个"嘴一出现就补登记"的钩子。
  // 工具只能注册、没法注销 ⇒ 这里要幂等(`handRegistered`)。
  const handRegistered = new Set()
  const registerHandTools = () => {
    if (!speaker.hasChannel() && !officialOwner.hasBinding()) return
    for (const def of relayToolDefinitions({
      // S1-b:她这只手从对"桥"说话改成对"嘴"说话(relay-tools.js 只用 say(),形状一致)
      relay: speaker,
      groupParticipation,
      dispatchOfficial: officialOwner.dispatchTool,
      isEnabled: () => speaker.hasChannel(),
      sessionEnabledOf: (sid) => sessionEnabled(sid),
      audit: auditToolCall,
      // v0.40.0 C3:清单检查(禁词/防重复)—— 她自己的手也要过一遍,踩了就说人话原因
      guard: (text, sid) => {
        const st = readSettings()
        // P1b(模块4):词表读点 —— 他填的 > lexicon.json > 无禁词
        // (原来"留空"会悄悄回落到代码里的 12 个词,清空面板 = 闸没真关)
        return guardOutbound(text, {
          words: bannedWordsFor(st.bannedWords),
          bannedAction: st.bannedAction ?? DEFAULT_BANNED_ACTION,
          prevTexts: store !== null && typeof store.relayRecentOutbound === 'function'
            ? store.relayRecentOutbound({ sessionId: String(sid || ''), limit: REPEAT_LOOKBACK })
            : [],
          repeatSimilarity: st.repeatGuardSimilarity ?? DEFAULT_REPEAT_SIMILARITY,
          repeatAction: st.repeatGuardAction ?? DEFAULT_REPEAT_ACTION,
          kind: 'reply'
        })
      }
    })) {
      if (handRegistered.has(def.name) || (def.name === 'echo_qq_call' && !speaker.hasChannel())) continue
      ctx.tools.register(defineTool(def))
      handRegistered.add(def.name)
    }
    ctxLogger.info('echo: 她的手已登记(echo_qq_say / echo_qq_call)')
  }
  officialBindingChanged = () => {
    registerHandTools()
    try { ctx.emit('system-prompt/change') } catch {}
  }
  officialHostReady = true
  registerHandTools()

  // ---- 5c. QQ 空间那三只手（2026-10-15 第 2 步）----------------------------
  //
  // 服务由 `dsh-echo-qq` 提供（`ctx.provide('echo:qzone', …)`）。这里**惰性取**：
  //   · **绝不写进 `inject`** —— 那会让 qq 插件不在时主包永不激活（人格/记忆全废）。
  //     与 `contract.js` 顶部那条"故意不 inject echo:relay"是同一条纪律的反向。
  //   · 注册只看"服务在不在"；**开没开**由工具执行时现读 `status().enabled`
  //     ⇒ 面板/配置改完不用重启就生效。
  //   · 服务是**后来才出现**的（qq 插件可能比主包晚起）⇒ 用一个低频对账把注册补上，
  //     别让"谁先起来"决定她有没有这只手。
  const qzoneOf = () => {
    try {
      return (ctx?.get ? ctx.get('echo:qzone') : null) ?? null
    } catch {
      return null
    }
  }
  let qzoneRegistered = false
  const registerQzoneTools = () => {
    if (qzoneRegistered) return
    if (qzoneOf() === null) return
    qzoneRegistered = true
    for (const def of qzoneToolDefinitions({
      qzoneOf,
      // 射程闸与那两只手**同一道**：工作会话不该能往空间发东西。
      sessionEnabledOf: (sid) => sessionEnabled(sid),
      audit: auditToolCall
    })) {
      ctx.tools.register(defineTool(def))
    }
    ctxLogger.info('echo: 空间的手已登记(echo_qzone_post / echo_qzone_read / echo_qzone_delete / echo_qzone_reply)')
  }
  registerQzoneTools()
  ctx.effect(() => {
    const t = setInterval(registerQzoneTools, 15000)
    if (typeof t.unref === 'function') t.unref()
    return () => { try { clearInterval(t) } catch { /* 已经没了 */ } }
  }, 'echo.qzoneToolsRetry()')

  // ── 空间评论 → 让她感知（并进记忆，source=qzone）────────────────────────
  //
  // 链路：dsh-echo-qq 连桥的正向 WS 收 qzone_comment → 按白名单分三路
  //        （master 走用户通道 / 白名单走这里 / 其他人丢）→ 这里把「这是发生在
  //        空间里的事」记进 capture，再当一条正常注入送进她的上下文。
  //
  // 为什么用 capture.qzoneComment 而不是 userText：那条通道**专属于他本人**
  // （lib/index.js 的 speakerIsMaster：群里别人的话也不进）。评论是别人说的，
  // 硬塞进 userText 会把她对别人的评论记成「他跟我说过」。
  let qzoneCommentOff = null

  /**
   * 处理一条白名单内的空间评论。
   * @param {{kind:string, commentId:string, userId:string, userName:string, content:string, postTid:string}} ev
   */
  async function handleSpaceComment (ev) {
    if (ev === null || ev === undefined) return
    if (String(ev.kind || '') !== 'space') return   // 主人那条走用户通道，不在这里处理
    const who = String(ev.userName || '') || String(ev.userId || '')
    const body = String(ev.content || '')
    const text = '【空间评论】' + who + ' 在你的说说下评论了：「' + body + '」'
    let companion = null
    try { companion = await ensureCompanion() } catch { companion = null }
    const agent = (companion === null || companion === undefined) ? null : (companion.agent ?? null)
    if (agent === null || agent === undefined) return
    // 先把「空间事件」记进这一轮的槽 —— 轮末 fireReflect 靠它决定走 qzone 通道
    try { captureOf(agent.session).qzoneComment = text } catch { /* 记不上就不记 */ }
    const env = {
      platform: 'qzone',
      chatId: String(ev.postTid || ''),
      chatType: 'qzone',
      senderId: String(ev.userId || ''),
      senderName: who,
      text: body,
      isMaster: false,
      msgId: 'qzone-comment-' + String(ev.commentId || '')
    }
    // 走与 QQ 入站**同一条**注入路（忙时排队、三绿那些行为都在）—— 但这些行只写在这里
    // 一次，不碰 relay 的幂等表。
    await injectInbound(agent, env, text)
  }

  ctx.effect(() => {
    const sync = () => {
      if (qzoneCommentOff !== null) return
      const qz = qzoneOf()
      if (qz === null || typeof qz.onComment !== 'function') return
      qzoneCommentOff = qz.onComment((ev) => { handleSpaceComment(ev).catch(() => {}) })
      ctxLogger.info('echo: 空间评论订阅已挂上（白名单外的人评论不触发）')
    }
    sync()
    // 空间服务可能比我们晚挂 ⇒ 低频补一次（与 qzoneToolsRetry 同款）
    const t = setInterval(sync, 15000)
    if (typeof t.unref === 'function') t.unref()
    return () => {
      try { clearInterval(t) } catch { /* 已经没了 */ }
      if (qzoneCommentOff !== null) {
        try { qzoneCommentOff() } catch { /* 退订失败无妨 */ }
        qzoneCommentOff = null
      }
    }
  }, 'echo.qzoneCommentWatch()')

  speaker.onRegistered(() => {
    registerHandTools()
    // 手是后补的 ⇒ 让她那一轮的提示词重读一次(不然她还在按旧提示词说话)
    try { ctx.emit('system-prompt/change') } catch { /* 广播失败无妨,下轮自然重读 */ }
  })
  // 她自己的手(2026-09-26 他要「清空上下文」按钮):这只手能清她自己(或指定
  // 会话)的上下文 —— 语气被旧回复带偏、或会话太长时用。与面板按钮共用
  // clearContextOf;桥关着也该有(它跟 QQ 无关)。
  ctx.tools.register(defineTool(contextClearToolDefinition({
    clear: clearContextOf,
    sessionEnabledOf: (sid) => sessionEnabled(sid)
  })))
  // 硬开关(2026-09-26 现场):他说「跟 agent 说 Echo 下线就行」是错的 ——
  // 因为 agent 手上没有那只手。这两只工具与面板/仪表盘写同一份 config。
  // 桥关着、引擎不在都该有:开关属于插件本体,不属于任何一条链路。
  for (const def of powerToolDefinitions({
    readPower: () => readPower(),
    setPower: (on, by) => {
      const v = setEnabled(on, by)
      try { ctx.emit('system-prompt/change') } catch { /* 广播失败无妨,下轮自然重读 */ }
      ctx.logger.info('echo: power ' + (v ? 'ON' : 'OFF') + ' via tool')
      return v
    },
    readScope: () => readScope(),
    setScope: (s, by) => setScope(s, by),
    setSessionOn: (sid, on) => setSessionOn(sid, on),
    sessionEnabledOf: (sid) => sessionEnabled(sid),
    currentSessionId: () => String(routeAgent?.session?.id || '')
  })) {
    ctx.tools.register(defineTool(def))
  }
}
