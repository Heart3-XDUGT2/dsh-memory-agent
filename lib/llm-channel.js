/**
 * 方案 C:反思类调用的**直调通道**(不起子代理)。
 *
 * 为什么要有这个文件(2026-10-05 诊断结论,报告在桌面《子代理积压诊断-2026-10-05.md》):
 *   反思子代理今天的工具面就是 `{ allow: [] }`(`lib/reflect.js:195`)—— 它一个工具都不用,
 *   要的只是"一次带 schema 的 LLM 调用"。但每起一次就产生**一个子代理会话**
 *   (`~/.dsh/sessions/<ws>/<sid>/session.v4.jsonl.zstd`,宿主只回收句柄、不删会话记录),
 *   于是会话目录越积越多(实测 835 个 / 67.41 MB)。
 *
 * 宿主其实有公开的 LLM 服务面,现成插件就在用(证据):
 *   · `node_modules/@deepseek-ai/dsh-session-title-first-prompt-llm/lib/index.js`
 *     `inject = ["sessionTitle", "llm", "sessions"]` —— `llm` 是可注入服务名;
 *   · `node_modules/@deepseek-ai/dsh-session-title-llm/lib/index.js:205-217`
 *     `ctx.llm.stream({ provider, model, messages, system, maxTokens, sessionId, purpose, signal })`;
 *   · 宿主主循环自己也是这么调的:`dsh-agent-loop/lib/index.js:1072/1189`
 *     (`loopCtx.llm.stream` / `.prepareCall`)。
 *
 * 与 subagents 通道的**唯一能力差**:宿主 `GenerateOptions` 里没有 `outputSchema`
 *   (`dsh-llm/lib/typert.host.js:313`)⇒ 结构化输出靠"提示词要 JSON + parseJsonLadder 兜底",
 *   这正是今天宿主退化时已经走的那条路(`lib/reflect.js:265-278`)。
 *
 * 纪律:
 *   · 本模块**纯 transport**(组好的 system/user 进来、对象出去),提示词构造仍在
 *     `lib/reflect.js`,`index.js` 只做装配 —— 三条通道的行为可逐位对照;
 *   · 一切失败都回 `null`(fail-soft,与 `runStructured` 契约一致),绝不上抛;
 *   · 超时默认 **120 秒**(2026-10-05 拍板;原 subagents 通道 300 秒,见 `lib/reflect.js:41`);
 *   · 有**全局并发闸 + 溢出排队**(拍板:超限由"丢弃"改"排队"),队列满才 fail-soft 放弃;
 *   · 四格统计:成功 ok / 超时 timeout / 排队 queued / 失败 failed(面板可见)。
 */

import { randomUUID } from 'node:crypto'
import { parseJsonLadder } from './jsonfix.js'
import { ECHO_SOURCE_KIND } from './source-kind.js'

/** 拍板值:反思类调用 120 秒(原来是 subagents 通道的 300 秒)。 */
export const DEFAULT_TIMEOUT_MS = 120_000
/** 全局并发上限缺省:反思是增益不是依赖,小并发足够,别和主对话抢。 */
export const DEFAULT_MAX_CONCURRENT = 1
/** 队列上限:溢出即放弃(留痕在 stats.skipped / overflow),不无限堆。 */
export const DEFAULT_MAX_QUEUE = 16

/**
 * ★★ 2026-10-21：**直调通道拆池（舱壁隔离）**。
 *
 * ## 现场（为什么非拆不可）
 *
 * 一条全局闸（`llmMaxConcurrent`）同时装着六种任务：组装前的情绪打分 / 查询扩展
 * （**有 5s / 10s 截止期，拿不到就整轮作废**）和轮末的反思（墙钟 21 秒，**纯增益**）。
 * 实测：反思 #2 起跑 `21:29:16`、#3 起跑 `21:29:37`，**串成一条线横跨到下一轮开口**
 * （轮 3 于 `21:29:23.98` 起跑）—— 下一轮的情绪与扩展**全程排在它后面**，
 * 一起到期，一起作废。纯增益的任务把关键路径饿死了。
 *
 * ## 两个池
 *
 *   · `live` = **组装前、有截止期、要进这一轮回复**的那几条（情绪打分 / 查询扩展）。
 *     它**复用 `llmMaxConcurrent` 键名** —— 语义不变，所以老配置与老测试仍然成立。
 *   · `bulk` = **轮末纯增益**（反思、日记那类），走 `llmMaxConcurrentBulk`。
 *
 * ## ⚠️ 这不是性能承诺
 *
 * 舱壁只保证「**调度上不再互相挡**」—— 不保证端到端变快。
 * 总并发上去之后 provider 侧自己也会变慢（实测单次 2650ms → 8269/9409ms）。
 * 别把这次拆分当成"响应变快了"的理由。
 */
export const POOL_LIVE = 'live'
export const POOL_BULK = 'bulk'
/** 后台池缺省并发：反思是增益不是依赖，1 就够（与 live 池老缺省同值）。 */
export const DEFAULT_MAX_CONCURRENT_BULK = 1
/**
 * 单次产出上限缺省。**2026-10-06 从 1024 提到 4096** —— 诊断现场:`llmFailed=2`
 * 而终端一行日志都没有,终局块读回来是 `max-tokens`(推理型模型的思考也吃
 * maxTokens,1024 常常思考没完就没了 ⇒ 正文一个 `text-delta` 都不发 ⇒ 我们这边
 * 只看到"空产出")。反思一次要吐 JSON,给它留够。
 */
export const DEFAULT_MAX_TOKENS = 4096

/**
 * 把宿主的**终局块**翻译成"是哪一类失败"(纯函数,可离线测)。
 *
 * 为什么必须有这一步(2026-10-06 诊断,与官方先例
 * `dsh-session-title-llm/lib/index.js:161-174` 的 `finishError()` 同源):
 * 宿主 `dsh-llm/lib/index.js:2360-2387` 的契约原话是 —— 适配器选择 / 派发 /
 * 迭代失败**不抛异常**,而是变成一条终局 `{type:'finish', reason:{kind:'error',
 * failure}}`。只收 `text-delta` 的消费方**会把错误整条吞掉**,现场表现就是
 * "failed 在涨、日志一行没有、lastNote 还是选路说明"。
 *
 * @param {object|null|undefined} reason 终局块的 `reason`(取不到 ⇒ null)
 * @returns {{code: string, note: string}|null} null = 正常收尾(或没有终局块)
 */
export function classifyFinish (reason) {
  if (reason === null || reason === undefined || typeof reason !== 'object') return null
  const kind = String(reason.kind || '')
  if (kind === '' || kind === 'stop') return null
  const failure = (reason.failure !== null && typeof reason.failure === 'object') ? reason.failure : null
  const code = String(failure?.code || '').trim()
  const message = String(failure?.message || '').trim()
  if (kind === 'max-tokens') {
    return { code: code !== '' ? code : 'MAX_TOKENS', note: '思考把 maxTokens 吃光了(没轮到正文)' }
  }
  if (kind === 'tool-calls') {
    return { code: code !== '' ? code : 'TOOL_CALLS', note: '模型要调工具(我们没给它工具)' }
  }
  if (kind === 'aborted') {
    return { code: code !== '' ? code : 'ABORTED', note: '被中止(' + (code !== '' ? code : 'aborted') + ')' }
  }
  if (kind === 'error') {
    const tail = [code, message].filter((x) => x !== '').join(' ')
    return { code: code !== '' ? code : 'LLM_ERROR', note: '适配器报错:' + (tail !== '' ? tail.slice(0, 120) : '(没给 failure)') }
  }
  return { code: 'FINISH_' + kind.toUpperCase(), note: '未知终局原因:' + kind }
}

/**
 * 把宿主 llm 服务包成一条可用的直调通道。
 *
 * @param {object} opts
 * @param {object} opts.llm 宿主 `llm` 服务(通常 `ctx.get('llm')`);缺席时 `available()` 为 false
 * @param {() => object} [opts.getSettings] 每次调用现读设置(面板改完下一轮生效,同 reflect 的写法)
 * @param {object} [opts.log] `{ warn }`;失败留痕用
 * @returns 通道对象:`available() / runStructured() / snapshot() / stats()`
 */
export function createLlmChannel ({ llm = null, getSettings = () => ({}), log = null } = {}) {
  const stats = {
    ok: 0, timeout: 0, queued: 0, failed: 0, skipped: 0, overflow: 0,
    lastMs: 0, lastAt: 0, lastOk: false, lastNote: '',
    // 2026-10-06:错误原文与"这一趟到底收到了什么"必须留在状态面 ——
    // 以前只有一句 lastNote,异常/终局块的原文只活在内存里、下一趟就被覆盖。
    lastError: '', lastReasoningChars: 0, lastChunks: ''
  }
  // ★★ 2026-10-21：原来这里是 `let running = 0` + `const queue = []`（一条全局闸）。
  //   现在按舱壁拆成两个互不相干的池 —— **各自的 running / queue，谁也不看谁**。
  const pools = {
    [POOL_LIVE]: { running: 0, queue: [] },
    [POOL_BULK]: { running: 0, queue: [] }
  }
  /**
   * ★ 池名归一：**认不出的一律归 `live`**。
   *
   *   为什么必须这样而不是"认不出就丢进 bulk"：舱壁是**隔离**用的。
   *   拼错一个池名（`'bulkk'`）如果降级进后台池，那条调用就从"关键路径"被
   *   静默挪到了"可以饿死"的那一侧 —— **一个手滑把要害埋了**。
   *   反过来归 `live` 最坏只是多占一格关键路径，不会让该跑的东西跑不掉。
   */
  const poolOf = (name) => (name === POOL_BULK ? POOL_BULK : POOL_LIVE)
  const warn = (msg) => { try { (log && typeof log.warn === 'function' ? log.warn : console.warn)(msg) } catch { /* 留痕失败不影响返回 */ } }

  function available () {
    return llm !== null && llm !== undefined && typeof llm.stream === 'function'
  }

  function readCfg () {
    let s = {}
    try { s = getSettings() || {} } catch { s = {} }
    const int = (v, dflt) => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt
    }
    return {
      provider: String(s.llmProvider || '').trim(),
      model: String(s.llmModel || '').trim(),
      maxTokens: int(s.llmMaxTokens, DEFAULT_MAX_TOKENS),
      timeoutMs: int(s.llmTimeoutMs, DEFAULT_TIMEOUT_MS),
      maxConcurrent: int(s.llmMaxConcurrent, DEFAULT_MAX_CONCURRENT),
      maxConcurrentBulk: int(s.llmMaxConcurrentBulk, DEFAULT_MAX_CONCURRENT_BULK),
      // ★★ 2026-10-21：**小任务思考档**。
      //
      //   现场：情绪打分一个 6 字段 JSON 要 4–6 秒，占一句回复总等待的 **70–82%**
      //   （实测 5.83s 里 4.09s 是它；主模型生成只要 1.3–1.7s）。
      //   根因不是模型慢，是 `llm-channel` **从不传 `reasoningEffort`**
      //   ⇒ 落进宿主默认 `high`（`dsh-llm-deepseek/lib/index.js:1694`）。
      //   原生适配器里 `reasoningEffort:'off'` 在线上就是 `thinking:{type:"disabled"}`
      //   （同文件 :1707），**是真关**；宿主自己对 session-title 就这么干（:1694）。
      //
      //   ⚠️ 空字符串 = **不传这个字段**（= 宿主的默认档，行为与改动前逐位一致）。
      //      绝不在这里塞 'high'/'max' 之类默认值 —— 不传就是宿主的默认，别改语义。
      //   ⚠️ 每次 `readCfg()` 都重读设置 ⇒ 面板改完**不用重启**。
      reasoningEffort: String(s.llmSmallTaskEffort || '').trim(),
      directEnabled: s.llmDirectEnabled !== false
    }
  }

  /**
   * 抢闸：拿得到就返回 release 函数，拿不到就排队等到位；队列满返回 null。
   *
   * ★★ 2026-10-21：**按池抢**。`pool` 经 `poolOf()` 归一（认不出的归 `live`），
   *   然后只动那个池自己的 `running` / `queue`，上限也只取那个池的。
   *
   *   ⚠️ `stats.queued` / `stats.overflow` **故意保持全局计数** ——
   *   它们回答的是"**发生了多少次排队/溢出**"，不是"**谁在跑**"。
   *   拆开会让面板上"总共排了多少次"这个数消失，而它正是诊断通道争用的入口。
   *
   * @param {object} cfg `readCfg()` 的结果
   * @param {string} [pool] 池名（`POOL_LIVE` / `POOL_BULK`，其余一律归 live）
   */
  function acquire (cfg, pool = POOL_LIVE) {
    const which = poolOf(pool)
    const p = pools[which]
    const cap = which === POOL_BULK ? cfg.maxConcurrentBulk : cfg.maxConcurrent
    return new Promise((resolve) => {
      const tryRun = () => {
        if (p.running < cap) {
          p.running += 1
          let released = false
          resolve(() => {
            if (released) return
            released = true
            p.running -= 1
            const next = p.queue.shift()
            if (next) next()
          })
          return true
        }
        return false
      }
      if (tryRun()) return
      if (p.queue.length >= DEFAULT_MAX_QUEUE) {
        stats.overflow += 1
        warn('echo: llm 直调队列已满(' + which + ' 池),本轮放弃(overflow=' + String(stats.overflow) + ')')
        resolve(null)
        return
      }
      stats.queued += 1
      p.queue.push(() => { tryRun() })
    })
  }

  /**
   * 一次带（可选）结构化输出的 LLM 调用。
   *
   * @param {object} args
   * @param {string} args.system 系统提示词
   * @param {string} args.user 用户提示词
   * @param {object} [args.schema] 有 schema ⇒ 走 JSON 解析阶梯并把对象返回;没有 ⇒ 返回纯文本
   * @param {string} [args.label] 留痕用标签
   * @param {AbortSignal} [args.signal] 外部中断信号
   * @param {string} [args.sessionId] 传了 ⇒ 这次调用计入该会话 token 统计(拍板:传)
   * @param {string} [args.pool] 走哪个池：`'bulk'` = 轮末纯增益；其余一律 `live`（默认）
   * @param {string} [args.reasoningEffort]
   *        这一次调用的思考档（per-call 覆盖）。**不传 ⇒ 用 `cfg.reasoningEffort`**
   *        （也就是设置里的 `llmSmallTaskEffort`）；两者都空 ⇒ **不往 options 里放这个键**。
   *        传 `'off'` ⇒ 原生适配器发 `thinking:{type:"disabled"}`，是真关。
   * @returns {Promise<object|string|null>} 失败一律 null
   */
  async function runStructured ({ system = '', user = '', schema = undefined, label = 'llm', signal = undefined, sessionId = '', provider = '', model = '', pool = POOL_LIVE, reasoningEffort = undefined } = {}) {
    if (!available()) return null
    const cfg = readCfg()
    if (!cfg.directEnabled) {
      stats.skipped += 1
      // 2026-10-06 B:跳过也要**说出为什么**(以前只写 warn,状态面上是空白 ⇒
      // 「跑 2 趟 · ⚠上次失败 · 0.0s」这种读不懂的读数就是这么来的)。
      stats.lastOk = false
      stats.lastNote = '直调开关关(llmDirectEnabled=false):' + String(label)
      warn('echo: llm 直调被开关关掉(' + String(label) + ')—— 跳过本轮')
      return null
    }
    // 2026-10-06 方案 C:provider/model 优先用**传进来的 route**(面板配的覆盖项 /
    // 继承来的本会话 route),都没有才回落到设置里那两个键。
    const useProvider = String(provider || '').trim() !== '' ? String(provider).trim() : cfg.provider
    const useModel = String(model || '').trim() !== '' ? String(model).trim() : cfg.model
    if (useProvider === '' || useModel === '') {
      stats.skipped += 1
      stats.lastOk = false
      stats.lastNote = '未配 provider/model:' + String(label)
      warn('echo: llm 直调未配置 provider/model(' + String(label) + ')—— 跳过本轮')
      return null
    }

    const release = await acquire(cfg, pool)
    if (release === null) return null

    const startedAt = Date.now()
    const ac = new AbortController()
    const onOuterAbort = () => { try { ac.abort() } catch { /* 已结束 */ } }
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) onOuterAbort()
      else { try { signal.addEventListener('abort', onOuterAbort, { once: true }) } catch { /* 非真 AbortSignal */ } }
    }
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; onOuterAbort() }, cfg.timeoutMs)
    if (typeof timer?.unref === 'function') timer.unref()

    try {
      // messages 用**宿主工厂产出的同款形状**:`createUserMessage(input)` 的实现是
      // `createMessage({...input, role:'user'})`,而 `createMessage` = `deepFreeze(
      // structuredClone({...input, id}))`(`dsh-llm/lib/index.js:37-64`)⇒ 逐字段对齐:
      // `{id, role, content, source}`。官方先例 `dsh-session-title-llm/lib/index.js:197-203`
      // 喂的就是这个形状(旧版我们喂裸 `{role, content}`,不在 `RequestMessage =
      // Message | RequestUserInput` 里,是诊断里点名的疑似项)。
      //
      // **有意差异**:`purpose` 不传 —— 宿主 `GenerateOptions.purpose` 的值域只有
      // `'compaction' | 'session-title'`(`dsh-llm/lib/typert.host.js:313`),"轮末反思"
      // 不在其中,硬填会去撞宿主的校验器;这不是漏抄,是照值域办事。
      //
      // ★★ 2026-10-21：**per-call `reasoningEffort`**（小任务思考档）。
      //   取值顺序：**参数传入 ?? cfg.reasoningEffort ?? ''**。
      //   传空字符串 = **不传这个字段**（`??` 不把 `''` 当 nullish ⇒ 落到 `''`
      //   ⇒ 下面那个展开不产生任何键）—— 与"传 undefined"行为一致，
      //   现有测试依赖这一点（它们断言 `'reasoningEffort' in options === false`）。
      //
      //   ⚠️ **绝不**填 'high'/'max' 之类的默认值：不传就是宿主的默认档，
      //      那是改动前的行为，别在这里偷偷改语义。
      //
      // ★★ **只对 `live` 池生效（池闸）。**
      //
      //   这一档的名字叫「**小任务**思考档」，它要治的是**组装前那两个小调用**
      //   （情绪打分 / 查询扩展）—— 一个 6 字段 JSON 白思考 4 秒。
      //
      //   而 `reflectTransport`（轮末反思）走的也是 `runStructured`，只是它在
      //   **`bulk` 池**（`lib/index.js` 的 `pool: 'bulk'`）。反思是**要质量**的：
      //   把它一起降到 `off` 等于为了省 4 秒把她的自省砍了 —— 那不是这个开关的意图。
      //
      //   ⇒ 用**池**来划这条线，而不是去改 `reflectTransport` 那个调用点
      //     （那一处不许动）。`bulk` 池**永远拿不到这一档**，行为与改动前逐位一致。
      //
      //   ⚠️ 池名归一在 `acquire` 里已经做过一次（认不出的归 live），这里用同一个
      //      `poolOf`，判据只留一处。
      const which = poolOf(pool)
      const effort = which === POOL_BULK ? '' : (reasoningEffort ?? cfg.reasoningEffort ?? '')
      const options = {
        provider: useProvider,
        model: useModel,
        messages: [{
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: String(user) }],
          source: { kind: ECHO_SOURCE_KIND }
        }],
        system: String(system),
        maxTokens: cfg.maxTokens,
        signal: ac.signal,
        // ★ 只有非空才把键放进去 —— 空串/undefined ⇒ **键根本不存在**
        ...(effort !== '' ? { reasoningEffort: effort } : {})
      }
      if (sessionId !== '' && sessionId !== null && sessionId !== undefined) options.sessionId = sessionId

      let pieces = ''
      let reasoningChars = 0
      let finishReason = null
      const counts = { text: 0, reasoning: 0, other: 0 }
      const streamish = llm.stream(options)
      // 宿主契约:stream 返回 chunk 异步迭代(也容一次 await 拿迭代器的形态)。
      const iterable = (streamish !== null && streamish !== undefined && typeof streamish[Symbol.asyncIterator] === 'function')
        ? streamish
        : await streamish
      for await (const chunk of iterable) {
        if (ac.signal.aborted) break
        if (chunk === null || chunk === undefined || typeof chunk !== 'object') { counts.other += 1; continue }
        // 正文增量(`text-delta`);`reasoning-delta` 是思考过程,不进结果 ——
        // **但字数要数**:它是"思考吃光 maxTokens"与"模型就是不说话"的分水岭
        // (形状出处:`dsh-llm/lib/types/assistant-stream.js:43-49`)。
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') { pieces += chunk.text; counts.text += 1; continue }
        if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') { reasoningChars += chunk.text.length; counts.reasoning += 1; continue }
        // **终局块必须留**:失败就藏在这里(宿主不抛异常,见 classifyFinish 注释)。
        if (chunk.type === 'finish') { finishReason = chunk.reason ?? null; counts.other += 1; continue }
        counts.other += 1
      }
      stats.lastReasoningChars = reasoningChars
      stats.lastChunks = '正文×' + counts.text + ' 思考×' + counts.reasoning + ' 其他×' + counts.other

      const text = pieces.trim()
      stats.lastMs = Math.max(0, Date.now() - startedAt)
      stats.lastAt = Math.floor(startedAt / 1000)
      if (timedOut) {
        stats.timeout += 1
        stats.lastOk = false
        stats.lastNote = '超时 ' + String(cfg.timeoutMs) + 'ms:' + String(label)
        stats.lastError = 'TIMEOUT ' + String(cfg.timeoutMs) + 'ms'
        warn('echo: llm 直调超时(' + String(label) + ' ' + String(cfg.timeoutMs) + 'ms)')
        return null
      }
      // 终局块优先于"空产出":适配器失败时正文当然也是空的,别把它误诊成"模型不说话"。
      const terminal = classifyFinish(finishReason)
      if (terminal !== null) {
        stats.failed += 1
        stats.lastOk = false
        stats.lastError = terminal.code + ' ' + terminal.note
        stats.lastNote = terminal.note + ':' + String(label)
        warn('echo: llm 直调失败(' + String(label) + '): ' + terminal.code + ' ' + terminal.note)
        return null
      }
      if (text === '') {
        stats.failed += 1
        stats.lastOk = false
        stats.lastError = 'EMPTY 空产出(' + stats.lastChunks + ',思考 ' + String(reasoningChars) + ' 字)'
        stats.lastNote = '空产出:' + String(label) + '(' + stats.lastChunks + ')'
        warn('echo: llm 直调空产出(' + String(label) + '):' + stats.lastChunks
          + ',思考 ' + String(reasoningChars) + ' 字 —— 宿主没报错,是流里真没正文')
        return null
      }
      if (schema === undefined || schema === null) {
        stats.ok += 1
        stats.lastOk = true
        stats.lastNote = String(label) + ' ' + String(text.length) + ' 字'
        return text
      }
      const parsed = parseJsonLadder(text)
      if (parsed === null) {
        stats.failed += 1
        stats.lastOk = false
        stats.lastError = 'BAD_JSON 产出不是合法 JSON(' + String(text.length) + ' 字)'
        stats.lastNote = 'JSON 解析失败:' + String(label)
        warn('echo: llm 直调产出不是合法 JSON(' + String(label) + ')—— 本轮不记')
        return null
      }
      stats.ok += 1
      stats.lastOk = true
      stats.lastNote = String(label) + ' ok(阶梯 ' + String(parsed.level) + ')'
      return parsed.value
    } catch (err) {
      stats.lastMs = Math.max(0, Date.now() - startedAt)
      stats.lastAt = Math.floor(startedAt / 1000)
      stats.lastOk = false
      if (timedOut) {
        stats.timeout += 1
        stats.lastNote = '超时:' + String(label)
        stats.lastError = 'TIMEOUT ' + String(cfg.timeoutMs) + 'ms'
      } else {
        stats.failed += 1
        stats.lastNote = '异常:' + String(err?.message ?? err).slice(0, 60)
        stats.lastError = 'THROW ' + String(err?.message ?? err).slice(0, 160)
      }
      warn('echo: llm 直调失败(' + String(label) + '): ' + String(err?.message ?? err))
      return null
    } finally {
      clearTimeout(timer)
      if (signal !== undefined && signal !== null) {
        try { signal.removeEventListener('abort', onOuterAbort) } catch { /* 无事 */ }
      }
      release()
    }
  }

  /**
   * 面板/状态面用的四格统计快照(成功/超时/排队/失败 + 溢出/跳过)。
   *
   * ★★ 2026-10-21：顶层 `running` / `waiting` **仍然等于两池之和** ——
   *   老测试与面板断言的就是这两个数，语义不许改
   *   （它们回答的是"总共几个在跑 / 在等"）。分池明细另开 `pool` 字段，
   *   绝不去动那两个数。
   *
   *   `lastMs` 本来就在 `...stats` 里，这里**显式再放一次到顶层** ——
   *   省得读的人还得知道它藏在 `stats` 底下。
   */
  function snapshot () {
    return {
      ...stats,
      running: pools[POOL_LIVE].running + pools[POOL_BULK].running,
      waiting: pools[POOL_LIVE].queue.length + pools[POOL_BULK].queue.length,
      mode: available() ? 'llm' : 'off',
      lastMs: stats.lastMs,
      pool: {
        live: { running: pools[POOL_LIVE].running, waiting: pools[POOL_LIVE].queue.length },
        bulk: { running: pools[POOL_BULK].running, waiting: pools[POOL_BULK].queue.length }
      }
    }
  }

  /** 这一刻能不能真跑:服务在 + 直调开着 + route 齐(给运输口选路用,不猜)。 */
  function usable (route = null) {
    if (!available()) return false
    const cfg = readCfg()
    if (!cfg.directEnabled) return false
    const p = String(route?.provider || '').trim() || cfg.provider
    const m = String(route?.model || '').trim() || cfg.model
    return p !== '' && m !== ''
  }

  return { available, usable, runStructured, snapshot }
}
