/**
 * v0.32.0 B1:全量工具审计 —— 补上「她干了什么」的最后一格。
 *
 * 现状:`lib/index.js` 只审计**自家 7 个**工具(`auditToolCall`)。她在会话里
 * 用宿主工具做的事(读写文件、跑命令、起子代理、拉网页……)一律不留痕 ——
 * 于是"她昨天到底动了什么"这个问题,答案是"查不到"。
 *
 * 出处与接口(照**真在跑的消费者**抄,不照文档猜):
 *   `@deepseek-ai/dsh-hooks-claude-code/lib/index.js:265`:
 *     `ctx.on('tools/post-execute', async (exec, result, next) => { …; return next() })`
 *   类型(`@deepseek-ai/dsh-tools` types):
 *     `tools/post-execute(exec: ToolExecution, result: Readonly<ToolExecutionResult>,
 *        next: () => Promise<PostToolDecision>): Promise<PostToolDecision>`
 *
 * 纪律(每一条都有代价,写在明面上):
 *   1. **观察者不许改结果** —— 一律返回 `next()`,绝不替换 content;
 *   2. **截断**,参数与结果各留前 N 字 + 记原始长度(否则一段代码就把审计表撑爆);
 *   3. **自家工具不重复记**(`echo_*` 已由 `auditToolCall` 带更全的上下文写过了)
 *      —— 但计入 `ownSkipped`,面板看得到"我没记它们",不是悄悄丢;
 *   4. **闸内才记**:电源关 / 会话射程外 ⇒ 不记(计入 `skipped`,原因分列);
 *   5. **写库失败不许静默** ⇒ 计入 `failed` 报给面板(与 `care_beats.writeFailed` 同款纪律);
 *   6. `ctx.on` 不在(老宿主/测试替身)⇒ 退化成空挂载 + 一行 note,**不抛**。
 */
import { randomUUID } from 'node:crypto'

/** 参数与结果各自最多留多少字(超出的长度单独记,不丢事实)。 */
export const AUDIT_MAX_CHARS = 500

/**
 * 工具审计行的**落库标记**(2026-10-06)。
 *
 * 为什么要有这个常量:`store.trimAudit` 现在分两个预算裁表 —— **证据行**
 * (对话 / 提取 / 注入留痕)与**工具行**(这里写的这些)各留一份。
 * 判据必须只有一个产地:标记在这里,store 那边 import 同一个常量,
 * 不许在 SQL 里再抄一遍字面量(两处迟早会分叉)。
 */
export const TOOL_ROW_MARKER = '(工具) '

/** 截断:回 `{text, len, cut}`,`len` 是**原文**长度(留着才知道被截了多少)。 */
export function clipText (value, max = AUDIT_MAX_CHARS) {
  const s = typeof value === 'string' ? value : safeStringify(value)
  const len = s.length
  if (len <= max) return { text: s, len, cut: false }
  return { text: s.slice(0, max), len, cut: true }
}

/** 保守的 JSON 化:任何东西都能变成一行,绝不抛(审计自己不能炸别人的轮次)。 */
export function safeStringify (value) {
  if (value === undefined) return ''
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  try {
    const seen = new Set()
    const s = JSON.stringify(value, (k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[循环]'
        seen.add(v)
      }
      return v
    })
    return s === undefined ? String(value) : s
  } catch { return String(value) }
}

/** 一次调用的身份与参数:`{name, argsText, argsLen, argsCut}`。 */
export function callOf (exec, max = AUDIT_MAX_CHARS) {
  const name = String(exec?.name ?? exec?.toolName ?? '?')
  // 宿主的 exec 有规范化的参数(`exec.args` 或 `exec.input`,两种拼法都见得到)
  const raw = exec?.args ?? exec?.input ?? exec?.arguments ?? ''
  const c = clipText(raw, max)
  return { name, argsText: c.text, argsLen: c.len, argsCut: c.cut }
}

/** 一次结果的样子:`{ok, text, len, cut}`(状态未知就 `ok: null`,不假装成功)。 */
export function resultOf (result, max = AUDIT_MAX_CHARS) {
  let ok = null
  // v0.42.0 审计修复(P1:审计里「成没成」一直是 unknown):原来只认
  // `ok` / `success` / `error`,而**宿主给的结果形状是 `isError: boolean`**
  // (`dsh-tools` 的 `ToolResult.isError`,见其 types/index.d.ts:178)——
  // 两个名字都不在,于是每一条工具审计的 ok 都是 null:
  // 「她这一步到底成没成」从审计表里根本读不出来。现在按宿主真形状先判,
  // 旧的拼法留作兼容(离线电池 / 别的宿主)。
  if (typeof result?.isError === 'boolean') ok = result.isError === false
  else if (typeof result?.ok === 'boolean') ok = result.ok
  else if (typeof result?.success === 'boolean') ok = result.success
  else if (result?.error !== undefined && result?.error !== null) ok = false
  let text = ''
  const blocks = result?.content
  if (Array.isArray(blocks)) {
    text = blocks.map((b) => (typeof b === 'string' ? b : String(b?.text ?? b?.content ?? safeStringify(b)))).join('\n')
  } else if (typeof result?.content === 'string') {
    text = result.content
  } else if (typeof result?.text === 'string') {
    text = result.text
  } else if (result?.error !== undefined && result?.error !== null) {
    text = '[错误] ' + safeStringify(result.error)
  } else {
    text = safeStringify(result)
  }
  const c = clipText(text, max)
  return { ok, text: c.text, len: c.len, cut: c.cut }
}

/**
 * 审计器本体。
 * opts: `{store, isEnabled, sessionEnabledOf, logger, now, maxChars}`
 */
export function createToolAudit ({
  store, isEnabled = () => true, sessionEnabledOf = null, logger = null, now = () => Date.now(), maxChars = AUDIT_MAX_CHARS,
  // v0.36.0 B2:这一轮(该会话)的 trace id —— 有就跟着走(整轮的行能串起来),
  // 没有就给这一行一个自己的 uuid(老行为)。
  traceOf = null
} = {}) {
  const stats = { seen: 0, written: 0, skippedPower: 0, skippedScope: 0, ownSkipped: 0, failed: 0, byName: {} }
  // v0.40.0 C2:本轮(这个会话)用过几件**宿主工具** —— 给"思考风格双档"当判据。
  // 只数进了账的那些(射程内、她醒着、不是自家工具):她调 echo_qq_say 是在**说话**,
  // 不是在"干活",不该把她切到中性档。换轮由壳在"他开口"那一刻 reset。
  const turnTools = new Map()
  // v0.36.0 B2:配对量耗时 —— pre 记开始、post 相减。键是**宿主给的
  // `exec` 对象本身**(它是不变的执行身份,两个钩子看到的是同一个),
  // 用 WeakMap 不会把内存拴住。
  const startedAt = new WeakMap()
  let warned = false
  const warnOnce = (msg) => {
    if (warned || logger === null || typeof logger.warn !== 'function') return
    warned = true
    logger.warn('echo: 工具审计 — ' + msg)
  }

  /** 记一次调用(纯逻辑,测试直接调它;返回 'written' | 'skip:…')。 */
  function record (exec, result) {
    stats.seen += 1
    let out = 'written'
    try {
      const call = callOf(exec, maxChars)
      stats.byName[call.name] = (Number(stats.byName[call.name]) || 0) + 1
      // ① 电源闸:她整个睡着 ⇒ 不记(她没在做事)
      if (isEnabled() !== true) { stats.skippedPower += 1; return 'skip:power' }
      // ② 自家工具不重复记(它们自己带更全的上下文写过审计了)
      if (call.name.startsWith('echo_')) { stats.ownSkipped += 1; return 'skip:own' }
      // ③ 会话射程闸:工作会话不是她的现场(与注入/心跳同一把尺)
      const sid = String(exec?.agent?.session?.id ?? exec?.session?.id ?? exec?.sessionId ?? '')
      if (typeof sessionEnabledOf === 'function' && sid !== '' && sessionEnabledOf(sid) !== true) {
        stats.skippedScope += 1
        return 'skip:scope'
      }
      // v0.40.0 C2:数得着"干活"的时刻 = 这条真的会进账(射程内、她醒着、非自家工具)。
      // 放在**这一步之后、写库之前** —— 写库失败不该抹掉"她确实动过手"这个事实。
      if (sid !== '') turnTools.set(sid, (Number(turnTools.get(sid)) || 0) + 1)
      const r = resultOf(result, maxChars)
      // v0.36.0 B2:耗时 —— 靠 pre/post-execute 配成对(见 attach;拿到才算,
      // 拿不到就 null,**不编一个数字出来**)
      const t0 = startedAt.get(exec)
      startedAt.delete(exec)
      const ms = typeof t0 === 'number' ? Math.max(0, now() - t0) : null
      if (store === null || store === undefined || typeof store.writeAudit !== 'function') {
        stats.failed += 1
        return 'fail:nostore'
      }
      const turnTrace = typeof traceOf === 'function' ? String(traceOf(sid) || '') : ''
      store.writeAudit({
        traceId: randomUUID(),
        stageDetail: turnTrace !== '' ? JSON.stringify({ turnTrace }) : '',
        stage: 'tool:' + call.name,
        step: 4,
        sessionId: sid,
        userInput: TOOL_ROW_MARKER + call.name + ' ' + call.argsText + (call.argsCut ? ' …[共 ' + call.argsLen + ' 字]' : ''),
        injectedMemories: '',
        emotionPack: '',
        llmReply: (r.ok === false ? 'failed' : (r.ok === true ? 'ok' : '? undefined')) + ' · ' + r.text
          + (r.cut ? ' …[共 ' + r.len + ' 字]' : ''),
        latency: ms,
        toolCall: call.name
      })
      stats.written += 1
      return 'written'
    } catch (err) {
      stats.failed += 1
      warnOnce('写库失败(第 ' + stats.failed + ' 次): ' + String(err?.message ?? err))
      out = 'fail:write'
      return out
    }
  }

  /**
   * 挂上宿主。**瀑布里只观察**:两处都是 `next()` 的结果原样交回,绝不替换。
   *
   * v0.36.0 B2:`tools/pre-execute` 只做一件事 —— 给这次执行记个开始时间,
   * 到 post 相减就是耗时(落审计的 `latency` 列)。同样**不改任何 decision**。
   */
  function attach (ctx) {
    if (ctx === null || ctx === undefined || typeof ctx.on !== 'function') {
      if (logger !== null && typeof logger.info === 'function') {
        logger.info('echo: 工具审计没挂上 —— 这个 ctx 没有 `on`(老宿主或测试替身)')
      }
      return () => {}
    }
    const offPre = ctx.on('tools/pre-execute', async (exec, next) => {
      try { startedAt.set(exec, now()) } catch { /* 记不上开始时间 ⇒ 这一行耗时是 null */ }
      return await next()
    })
    const offPost = ctx.on('tools/post-execute', async (exec, result, next) => {
      try { record(exec, result) } catch { /* record 自己已经不抛了,这里双保险 */ }
      return await next()
    })
    return () => {
      try { offPre() } catch { /* 卸载尽力而为 */ }
      try { offPost() } catch { /* 卸载尽力而为 */ }
    }
  }

  return {
    attach,
    record,
    // v0.40.0 C2:本轮工具计数(思考风格双档的判据)。壳在"他开口换一轮"时 reset。
    turnTools: (sid) => Number(turnTools.get(String(sid)) || 0),
    turnReset: (sid) => { turnTools.delete(String(sid)) },
    turnResetAll: () => { turnTools.clear() },
    stats: () => ({ ...stats, byName: { ...stats.byName }, at: now() })
  }
}
