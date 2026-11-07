/**
 * dsh-echo — 一轮的「记忆与心情」快照:从哪来、怎么算、以什么形式进模型
 * ==================================================================
 * 2026-09-26 现场(他问「dsH 里的消息为什么也在 qq 里出来」时顺手量出来的,
 * 比那个 bug 更贵):
 *
 * 这份快照原来是在 `agent/pre-step` 里**追加一条 user 消息**(`form:'snapshot'`)。
 * 宿主的语义是:每步把 `decision.messages` 原样 `surfaceOp:"append"` 进 surface,
 * 而 surface 是「派生模型历史的唯一来源」—— **追加进去的永不消失**。
 * 逐条重放那条会话流量出来的实况(13:20:54 那一轮):
 *
 *   Echo 的记忆/心情注入块   62 条  57,105 字  ← 从 09-24 22:10 到 09-26 13:20
 *   Echo 的心声/提醒注入      8 条   6,107 字
 *   她的回复                101 条   6,294 字
 *   系统提示词(7 次更新都是 replace,只留最新一份) 1 条 10,003 字
 *   他讲的话                 67 条     625 字  ← 0.7%
 *   合计                    278 条 ≈84,464 字,其中她自己刷的注入占 75%
 *
 * 于是同一段上下文里躺着 62 个互相矛盾的「[她此刻的状态]」和 62 个「【现在】」。
 *
 * **A 案(他 2026-09-26 拍板)**:快照不再走 user 消息,改走**系统提示词里的一节**。
 * 系统提示词的更新带 replace 语义(现场证据:`session/message` 节点只有 8 条、
 * 7 条 replace 全是系统提示词自我替换),所以上下文里永远只有最新一份。
 * 代价他认了:系统提示词每轮都变 ⇒ 前缀缓存每轮失效(尾部本来就不在缓存区,
 * 但系统提示词一动,它之后的历史也跟着重算 —— 这笔账要盯着)。
 *
 * 新鲜度怎么保住:宿主的顺序是 `inbox.claim()` → 发 `agent/inbox/claimed` →
 * **组装系统提示词** → 跑 `agent/pre-step` 瀑布。所以「他这一轮说了什么」必须在
 * **claim 事件**里记下(那时组装还没发生)—— 这就是 `noteClaimed()` 的用途;
 * 快照本身在 `system-prompt/assemble` 瀑布里算(那里可以 await sidecar 检索)。
 */

import { renderLongingLine, renderSharedContext } from './context.js'
import { latestDirectUserText } from './turn-query.js'
import { positiveOverrideVector } from './emotion.js'
import { DRIFT_SHOCK } from './drift.js'
import { takeInterrupted } from './interrupted.js'
import { buildProactiveAck } from './proactive-ack.js'
import { PROACTIVE_ROUND_MARKER } from './store.js'
// v0.37.0 G2:记忆里的旧称呼 → 现在的称呼(纯函数;历史对话不动)
import { rewriteRetiredAliases } from './alias-rewrite.js'
import { normalizeGroupAudience, groupAudienceKey } from './group-dialogue-context.js'

/** 系统提示词里那一节的唯一名字(免得别处再注册一份)。 */
export const SNAPSHOT_SECTION = 'echo:snapshot'
/**
 * 顺序:10250 是人格后段(`echo:rules`)、10240 是「她知道自己在用 QQ」。
 * 快照排在**最后**:它是生成前最后读到的场景与行为要求,而人设那两句
 * (铁律 / 说话方式)仍在它前面 —— 语域锚点不动,场景贴近尾部。
 */
export const SNAPSHOT_ORDER = 10260

/**
 * @param {object} deps
 * @param {{retrieve: (query: string, topK: number, opts: object) => Promise<{text?: string, graphHits?: object}|null>}} deps.engine 引擎门面(可缺席)
 * @param {object|null} deps.store 库(可 offline)
 * @param {() => object} deps.readSettings 读调参
 * @param {(session: object) => object} deps.captureOf 拿这一轮的捕获槽
 * @param {() => string[]} [deps.readAliases] 别名接地
 * @param {(info: object) => void} [deps.onInject] 注入留痕(2026-10-06):算完一轮快照后
 *   回调一次,由调用方写审计(`tool_call='inject'`)。**只在这一轮真算过时调**——
 *   轮内复用不重复调(一行/轮)。实现方自吞异常,这里再兜一层
 * @param {{warn?: (msg: string) => void}} [deps.logger]
 */
export function createTurnSnapshot ({
  engine, store, readSettings, captureOf, readAliases = () => [], readRetiredAliases = () => [],
  sameTurnOf = null, expandOf = null, onInject = null, logger = {}, groupAudienceOf = null
}) {
  // 会话 → 这一轮该拿去检索的那句话。只由 claim 事件写,「没写过」= 这一步不注入。
  const queries = new Map()
  /**
   * v0.35.0 B3:轮内**不变**快照 —— 同一个查询词(同一轮)只算一次。
   *
   * 为什么:宿主**每一步**都组装一次系统提示词(带工具的一轮有好几步),
   * 而 compose 每次都要往引擎跑一趟检索 + 读共享轮次 + 攒认账条款。
   * 于是同一轮里:① 白跑 N 次检索;② 更要紧的是**她看到的那块会在轮内变**
   * (后面几步读到的"此刻状态"与前面几步不是同一份)—— 一轮之内她自己都在漂。
   * 现在按 (会话, 查询词) 钉住:他再开口(claim)= 新的一轮 ⇒ 立刻重算。
   */
  const composed = new Map() // sid → { query, at, snap }
  const COMPOSE_TTL_MS = 10 * 60 * 1000 // 兜底:超过 10 分钟不许再用旧的
  let reused = 0

  /**
   * 宿主 claim 了一条消息(组装之前)—— 记下他这一轮说的话。
   * 只认「人话」:`latestDirectUserText` 认他的话、也认桥注入的 QQ 信封,
   * 但不认我们自己的注入(记忆快照、心声、提醒)—— 拿自己的注入去检索
   * 记忆是 2026-09-26 之前的一个真 bug(lib/turn-query.js 里有现场记录)。
   */
  function noteClaimed (sessionId, message) {
    const sid = String(sessionId ?? '')
    if (sid === '') return false
    const query = latestDirectUserText([message])
    if (query === '') return false
    queries.set(sid, query)
    composed.delete(sid) // v0.35.0 B3:他再开口 = 新的一轮 ⇒ 丢掉旧快照(哪怕这句话一模一样)
    return true
  }

  /** 这一轮拿去检索的话(测试与诊断用)。 */
  function queryOf (sessionId) {
    return queries.get(String(sessionId ?? '')) ?? ''
  }

  /** 复用了几次(B3 的省钱账;`compose` 的次数 - 真正算过的次数)。 */
  function stats () {
    return { reused, cached: composed.size }
  }

  /** 会话清空/下线时忘掉它,别把上一轮的查询留给下一轮。 */
  function forget (sessionId) {
    const sid = String(sessionId ?? '')
    queries.delete(sid)
    composed.delete(sid)
  }

  /**
   * 算这一轮的快照文本。返回 `{ text, memoryText, sharedText }` 或 `null`
   * (没得注入:没记过他的话 / 检索与共享都空)。
   *
   * 副作用(与老实现一致,都是尽力而为):
   *  - `capture.graphHits` 攒本轮想起的图谱边(轮末回传 graph_reinforce);
   *  - `capture.lastInjected` / `capture.profileSnapshot` 供面板与审计。
   */
  async function compose (session) {
    const sid = String(session?.id || '')
    if (sid === '') return null
    const query = queries.get(sid) ?? ''
    if (query === '') return null
    const audienceOf = () => {
      try { return normalizeGroupAudience(groupAudienceOf?.(session)) } catch { return null }
    }
    const groupAudience = audienceOf()
    const audienceKey = groupAudienceKey(groupAudience)
    // 2026-10-06:注入留痕的耗时(这一轮检索+攒认账条款花了多久)。
    const composeStartedAt = Date.now()
    // v0.35.0 B3:这一轮算过了 ⇒ 原样交回(不重跑检索、不重攒边),她轮内看到的是同一份。
    const memo = composed.get(sid)
    if (memo !== undefined && memo.query === query && (memo.audienceKey ?? '') === audienceKey
      && (Date.now() - memo.at) < COMPOSE_TTL_MS) {
      reused += 1
      if (memo.snap !== null) {
        try { // 审计字段照旧写上(面板/审计每次组装都要看到"她这轮读了什么")
          const capture = captureOf(session)
          capture.lastInjected = memo.snap.text
          const prof = store === null ? null : store.getProfile()
          capture.profileSnapshot = '[他的称呼] ' + ((prof && prof.name) || '未定')
        } catch { /* 攒不到就是本轮审计缺字段,注入照常 */ }
      }
      if (reused === 1 && typeof logger?.info === 'function') {
        logger.info('echo: 轮内快照复用 —— 同一轮多步只检索一次(B3)')
      }
      return memo.snap
    }
    // 想念行:先读后削的「读」(削前的值才是她等你时攒下的)。
    let longingLine = ''
    try {
      const capture = captureOf(session)
      const pending = capture.longingRead ?? null
      longingLine = renderLongingLine(pending === null ? null : await pending)
    } catch { /* 想念读不到就不注入,不影响记忆 */ }
    let r = null
    try {
      const cap = captureOf(session)
      const reinforce = cap.driftReinforce === true
      // v0.40.0 C1:同轮情绪读数(他在他开口那一刻起跑的,组装时取)
      let sameTurnEmotion = null
      try {
        if (typeof sameTurnOf === 'function') {
          const st = await sameTurnOf(sid)
          if (st !== null && st !== undefined && st.score !== null && st.score !== undefined) {
            sameTurnEmotion = { vector: st.score.vector, intensity: st.score.intensity, reason: st.score.reason }
          }
        }
      } catch { sameTurnEmotion = null } // 取不到 = 这一轮延续旧情绪(照常回复)
      // (v0.29.0:渠道维度随群聊拒收一起退役 —— 检索不再按渠道过滤。)
      const rs = readSettings()
      // RT11b(2026-09-30):这一轮的查询扩展词元(取走即删;没有 ⇒ null ⇒ 引擎照旧)
      //
      // ★★ 2026-10-21：**必须把 `query` 递进去**。扩展是**按 sid + 那句话**交接的 ——
      //   只传 sid 的话，只要扩展迟到一次（本轮 take() 之后才 settle），它就会躺在
      //   pending 里被**下一轮**取走，当成下一句的扩展词元送进检索 ⇒ **静默用错词**。
      //   `query` 就是本轮那句话（`:127` 取的），与 `:181` 传给 `engine.retrieve` 的是同一个。
      let expandTerms = null
      try {
        if (typeof expandOf === 'function' && rs.recallExpand !== false) {
          const ex = expandOf(sid, query)
          if (ex !== null && ex !== undefined && Array.isArray(ex.terms) && ex.terms.length > 0) {
            expandTerms = ex.terms
          }
        }
      } catch { expandTerms = null } // 取不到 = 这一轮少一点召回,不许拖慢
      r = await engine.retrieve(query, rs.injectTopK, {
        ...(groupAudience === null ? {} : { groupAudience }),
        now: Date.now(),
        // ★ 2026-10-18：**必须把 sid 递进去**，否则 `retrieve` 那条审计行
        //   落到默认会话、`stage_detail.turnTrace` 永远是空的（实测 0%），
        //   面板就没法把它归到某一轮里。
        //   `engine.js:263` 早就写了 `sessionId: String(extras.sessionId ?? '')`，
        //   缺的只是**调用方没传** —— 那行注释自己都说了
        //   「engine 侧拿不到当轮 trace，要挂当轮得由壳把 sid/trace 递进来」。
        sessionId: sid,
        longingLine,
        emotionVector: reinforce ? positiveOverrideVector() : null,
        sameTurnEmotion,
        shock: reinforce ? DRIFT_SHOCK : '',
        aliases: readAliases(),
        // 2026-09-30:检索各项(实测见 docs/RETRIEVAL_OPT_2026-09-30.md)
        retrievalOpts: {
          coreBlock: rs.recallCoreBlock,
          timeArm: rs.recallTimeArm,
          fusion: rs.recallLexArm === true
            ? { enabled: true, mode: 'reorder', lexArm: true }
            : null,
          expandTerms,
          expandScore: true,
          // 2026-09-30 第三批:写入侧"说法键"进打分正文(数据门控:没键的行不受影响)
          augKeys: rs.recallAugKeys !== false
        }
      })
    } catch { r = null } // 门面自身承诺 fail-soft,这里兜底双保险
    if (groupAudienceKey(audienceOf()) !== audienceKey || queries.get(sid) !== query) return null
    let sharedText = ''
    try {
      const rounds = readSettings().sharedRounds
      if (rounds > 0 && store !== null && typeof store.listConversations === 'function') {
        sharedText = renderSharedContext(
          store.listConversations({ limit: Math.min(100, rounds + 8) }),
          sid,
          rounds
        )
      }
    } catch { sharedText = '' } // 补连续性失败不影响记忆注入
    let memoryText = r === null ? '' : String(r.text || '')
    // ---- v0.37.0 G3:降级要说话(以前是**静默**少一段)----
    // 两种降级都得让**她**知道:① 检索整条没应答(引擎死了/炸了)⇒ 她手上
    // 一条记忆都没有,却会以为"确实没想起来" —— 空表和"查不到"是两件事;
    // ② 走的是本地兜底基线(引擎不在,JS 那套弱检索)—— 能出东西,但不如引擎全。
    // 标注进**注入块**(她自己读得到),不是只写日志。
    let degradeLine = ''
    try {
      const eng = r === null ? '' : String(r.engine || '')
      if (r === null) {
        degradeLine = '[降级] 这一刻的记忆检索没有应答 —— 你手上是空的,'
          + '不许把"没想起来"当成"没有过",也别硬编;先把这一轮聊好。'
      } else if (eng === 'baseline') {
        degradeLine = '[降级] 记忆走的是本地兜底(引擎不在),可能有遗漏 —— 想起来什么就说什么,别补细节。'
      }
    } catch { degradeLine = '' }
    // ---- v0.37.0 G2:记忆里的旧称呼按现在的称呼写 ----
    // 只动**记忆**这一块:共享轮次/他的原话/她的残句一个字不改 ——
    // 改历史就是把记录改成假的,那比叫错名字严重得多。
    let aliasFixed = 0
    try {
      const retired = typeof readRetiredAliases === 'function' ? readRetiredAliases() : []
      if (memoryText !== '' && Array.isArray(retired) && retired.length > 0) {
        const cur = String(((store === null ? null : store.getProfile()) || {}).name || '').trim()
        const rw = rewriteRetiredAliases(memoryText, { current: cur, retired })
        if (rw.changed) {
          memoryText = rw.text
          aliasFixed = rw.hits.reduce((s, h) => s + h.count, 0)
        }
      }
    } catch { /* 改写失败 ⇒ 用原文(宁可叫错,不许少一段记忆) */ }
    // v0.18.0 barge-in:上一轮她说到一半被他插话,残句在这一轮交给她。
    // A 侧出处:`brain_pipeline.py:1234-1240` 从 `_interrupted_tail` **pop**
    // (读一次就消费),措辞在 `:1250-1255`(逐字照抄在下面)。
    // 位置差一处: A 侧紧跟【现在】,这里挂在块的末尾 —— 因为 B 的记忆块在
    // JS 基线与 Python 引擎两处渲染,只有这一层是两条路共用的唯一真相源;
    // 挂末尾反而是他开口前她读到的最后一句。
    const interrupted = takeInterrupted(sid)
    const interruptedText = renderInterruptedLine(interrupted)
    // v0.18.1 认账条款(她主动说过什么):A 侧 `main.py:1855-1900` 的逐字移植,
    // 拼在**最后**(A 侧也是最后:`... + longing_line + proactive_line`)。
    // 他回过一轮后会话最后一行变成对话轮 ⇒ 这一行自然消失。
    let ackText = ''
    try {
      ackText = buildProactiveAck({
        store,
        sessionId: sid,
        now: Date.now() / 1000,
        marker: PROACTIVE_ROUND_MARKER
      })
    } catch { ackText = '' }
    const text = [degradeLine, memoryText, sharedText, interruptedText, ackText].filter((t) => t !== '').join('\n\n')
    if (text === '') {
      // v0.35.0 B3:这一轮"没什么可注入"也要钉住 —— 否则同一轮每步都去引擎跑一趟空检索。
      composed.set(sid, { query, audienceKey, at: Date.now(), snap: null })
      return null
    }
    try {
      const capture = captureOf(session)
      if (r !== null && r.graphHits !== null && r.graphHits !== undefined) {
        if (capture.graphHits === null || capture.graphHits === undefined) {
          capture.graphHits = { hitEdgeIds: new Set(), ltpEdgeIds: new Set() }
        }
        for (const id of r.graphHits.hitEdgeIds || []) capture.graphHits.hitEdgeIds.add(id)
        for (const id of r.graphHits.ltpEdgeIds || []) capture.graphHits.ltpEdgeIds.add(id)
      }
    } catch { /* 攒不到就是本轮不回传,注入照常 */ }
    // v0.14.5 S10:`injected_profile` 列 —— 画像注入就是「[他的称呼] X」这一行。
    let profileSnapshot = ''
    try {
      const prof = store === null ? null : store.getProfile()
      profileSnapshot = '[他的称呼] ' + ((prof && prof.name) || '未定')
    } catch { profileSnapshot = '' }
    try {
      const capture = captureOf(session)
      capture.lastInjected = text
      if (profileSnapshot !== '') capture.profileSnapshot = profileSnapshot
    } catch { /* 攒不到就是本轮审计缺字段,注入照常 */ }
    // ---- 2026-10-06:注入留痕 ----
    // 组装完 prompt 就把"她这一轮读到了什么"写进审计(`tool_call='inject'`)。
    // 以前这一列的**唯一产地**是轮末反思成功那行(`'extract'`)⇒ 反思跳过/失败的
    // 轮次,证据彻底消失(活库 160 行全空)。纪律:尽力而为 —— 回调炸了只丢这一行,
    // 绝不影响注入与这一轮回复(所以这里 try 住,且不 await)。
    if (typeof onInject === 'function') {
      try {
        onInject({
          sessionId: sid,
          query,
          text,
          profileSnapshot,
          memoryChars: memoryText.length,
          sharedChars: sharedText.length,
          degraded: degradeLine !== '',
          engine: r === null ? '' : String(r.engine || ''),
          ms: Date.now() - composeStartedAt
        })
      } catch { /* 留痕失败不影响这一轮 */ }
    }
    const snap = { text, memoryText, sharedText, degraded: degradeLine !== '', aliasFixed }
    // v0.35.0 B3:钉住这一轮(同一步之后再来组装就复用,不再重跑检索)
    composed.set(sid, { query, audienceKey, at: Date.now(), snap })
    return snap
  }

  /** 系统提示词那一节的形状(host 的 section 只吃同步 text ⇒ 先算好再给)。 */
  function sectionOf (text) {
    // ★ 2026-09-26 全仓审查抓到的真高危:这一节里 4/5 是**自由文本**
    // (他的原话、她的残句、LLM 摘要、审计行)。宿主的 assemble 会对每一节做
    // 严格 `{{变量}}` 插值(dsh-system-prompt/lib/index.js:164-167)——名字没注册
    // 就 `throw new Error('unknown prompt variable …')`,**整轮当场失败**,
    // 而且那份快照会在窗口里反复重现 ⇒ 他会连续多轮收不到回复。
    // 他只要在 QQ 里打一句 `{{随便}}` 就能触发。
    // 所以注入前把 `{{` 打断成 `{ {`(渲染出来几乎一样,插值器不再认它)。
    return { name: SNAPSHOT_SECTION, order: SNAPSHOT_ORDER, text: escapePromptBraces(text) }
  }

  return { noteClaimed, queryOf, forget, compose, sectionOf, size: () => queries.size, stats }
}

/**
 * 把自由文本里的 `{{` 打断,免得被宿主的严格插值器当成变量引用。
 *
 * 宿主 `dsh-system-prompt` 的 assemble 会对每一节跑 `interpolate`:碰到
 * `{{名字}}` 而这个变量没注册(节里所有自由文本都不可能是注册变量)就抛
 * `unknown prompt variable "{{…}}"` —— 抛在 system prompt 组装里 = **整轮失败**。
 * 他的原话、她自己的话、LLM 摘要都可能包含 `{{`,所以每个"把外文塞进提示词节"
 * 的地方都要过一遍这个函数(`lib/index.js` 的 echo:relay 节同理)。
 *
 * 只在**进提示词的路径**上转义:审计/面板/落库里仍是原话(证据不许被我改)。
 */
export function escapePromptBraces (text) {
  // 按**连续 `{` 的整段**拆,而不是简单 `{{`→`{ {`:后者在 `{{{x}}}` 这种
  // 三重括号上会留下新的相邻 `{{`(第一处替换后第 2、3 个 `{` 又挨上了),
  // 宿主照样抛 malformed。每个 `{` 之间插一个空格,任何相邻都不可能再出现。
  return String(text ?? '').replace(/\{+/g, (run) => run.split('').join(' '))
}

/**
 * 被打断的残句 → 注入给她的一行(v0.18.0 barge-in)。
 *
 * 措辞**逐字**来自 A 侧 `brains/brain_pipeline.py:1250-1255`:
 *   【你刚才被插嘴了】你当时没说完的话:「…」——想继续就说,不想接就自然放下,
 *   也可以就他插嘴这件事说一句。不要硬接。
 * 那一段注释写着「措辞刻意留给 LLM 裁量:接话/放下/就插嘴本身说一句都行,
 * 不硬编码剧情」—— 所以这一行一个字都不许改。
 */
export function renderInterruptedLine (tail) {
  const body = String(tail ?? '').trim()
  if (body === '') return ''
  return '【你刚才被插嘴了】你当时没说完的话:「' + body + '」'
    + '——想继续就说,不想接就自然放下,也可以就他插嘴这件事说一句。不要硬接。'
}
