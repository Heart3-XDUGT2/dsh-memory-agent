/* Echo 审查台 — 审计流的**看法**(纯逻辑,零 DOM)
 * ============================================================
 * 2026-09-29 他:「仪表盘网页的审计流太乱了,我希望你能设计清晰一点,人性化,
 * 但是信息一定要全面。」
 *
 * 现状(他截图那一屏):40 行里 20 多行是 `structured_output` 的原始 JSON,
 * 每行占三四行高度,全是「系统」徽章 —— 真正的对话被埋在中间;同一个人的话
 * 又按"一次工具调用一行"平铺,读起来像日志,不像"她这一天发生了什么"。
 *
 * 这一版的做法(信息一条不删,只换组织方式):
 *   ① **先分层,再折叠**:每行先归进一个「桶」(对话 / 她主动 / 提取 / 后台 /
 *      干活 / 系统 / 桥),桶决定它在"对话优先"档里露不露面 —— 后台的那些
 *      调用不是删掉,是折进它所服务的那一轮脚下(「⛭ 后台 9 次」),点开全在。
 *   ② **机器的话也要像人话**:`structured_output {"keywords":[…],"summary":…}`
 *      拆成「词 梅菜扣肉、晚饭 / 记 〈称呼〉说自己已经吃完…」这样一行标签,
 *      原文一个字不少地留在展开区(排障档默认显示)。
 *   ③ **三档密度**(对话优先 / 全部 / 排障)是同一份数据的三副面孔,不换数据源。
 *   ④ **时间有层次**:今天用相对时间(刚刚 / 12 分钟前),跨天加日期分隔线。
 *
 * 为什么单独一个文件(而不是塞进 app.js):这些判断**要能离线测**。
 * 页面文件是 classic script `<script src>`,没有 import/export —— 所以本文件也
 * 写成 classic script,只往 globalThis 上挂一个对象;测试里用
 * `new Function('globalThis', src)(sandbox)` 拿去跑(见 tests/audit-view.test.js,
 * 与 tests/graph-force.test.js 抽 graph.html 的分法同源)。
 *
 * 纪律:这里**不改行、不造行、不丢字段** —— 只贴标签、算折叠关系。
 * 页面渲染时原文一律 textContent(app.js 的老规矩,不留 XSS 坏习惯)。
 */
globalThis.EchoAuditView = (function () {
  'use strict'

  /** 桶 = 这一行"是什么事"。顺序即优先级(折叠时靠前的先露面)。 */
  const BUCKETS = {
    talk: { label: '对话', icon: '💬', rank: 0, desc: '有人说了话:他说的 / 她说的' },
    her: { label: '她主动', icon: '📣', rank: 1, desc: '没人问她,她自己开口(关怀 / 喊他 / 情绪余波)' },
    reflect: { label: '提取', icon: '🧠', rank: 2, desc: '把这一轮收成记忆(提取器旁白 / 记忆整固)' },
    work: { label: '干活', icon: '🛠', rank: 3, desc: '她真的动了手:读文件 / 跑命令 / 派子代理' },
    machine: { label: '后台', icon: '⛭', rank: 4, desc: '打分与抽取这类机器调用(内容都在展开区)' },
    system: { label: '系统', icon: '⚙️', rank: 5, desc: '开关 / 记忆编辑 / 清理 / 漂移' },
    bridge: { label: '桥', icon: '🌉', rank: 6, desc: 'QQ 桥的信令:入站被拒 / 出站失败这类事实' },
    other: { label: '其他', icon: '·', rank: 7, desc: '没归类的工具行(原文照给)' }
  }

  /** 工具名 → 人话。面板上不该出现裸英文 —— 但原始名永远在展开区里。 */
  const TOOL_HUMAN = {
    relay_in: '入站·他说', relay_out: '出站·她说', relay_proactive: '出站·她主动',
    echo_qq_say: 'QQ 说话', echo_qq_call: 'QQ 喊他',
    extract: '提取', reflection: '记忆整固', structured_output: '提取子调用',
    inject: '注入留痕',
    care: '关怀心跳', say_again: '情绪余波', longing_steer: '想念计量',
    memory_edit: '记忆编辑', memory_state: '记忆状态', memory_clear: '清空记忆',
    memory_cleanup: '记忆清理', session_on: '会话上线', session_off: '会话下线',
    auto_scope_on: '自动挂载', power: '总开关', diary: '她的日记', drift: '漂移',
    graph_merge: '图谱合并', graph_cleanup: '图谱清理', wake: '闹钟',
    read: '读文件', write: '写文件', edit: '改文件', glob: '找文件', grep: '搜内容',
    pwsh: '跑命令', send_message: '给子代理捎话', subagent: '派子代理',
    subagent_fork: '派子代理(带上下文)', list_agents: '列子代理', interrupt_agent: '打断子代理',
    job_output: '读后台任务', job_kill: '杀后台任务', todo_write: '写待办',
    relay_refused: '出站被拒', relay_silent: '出站静默', relay_dropped: '入站丢弃'
  }

  /** 桶的判据(逐个点名,别拿"以 ( 开头"当主判据 —— 那条 app.js 里踩过)。 */
  const TOOL_BUCKET = {
    relay_in: 'talk', echo_qq_say: 'talk', relay_out: 'talk',
    echo_qq_call: 'her', relay_proactive: 'her', care: 'her', say_again: 'her', wake: 'her',
    extract: 'reflect', reflection: 'reflect',
    // ★ 2026-10-19：整固**失败**那一行原来是漏的，落默认 other 桶；
    //   而 app.js:801 的 CONTENT_BUCKETS=[talk,her,reflect] 是「对话优先」档的**白名单**
    //   ⇒ 默认档位下整固失败被整个滤掉，看不见。
    //   失败也是「提取」这件事的一部分（它告诉你这次没提成），归 reflect 与成功行同档。
    reflection_failed: 'reflect',
    // 2026-10-06:注入留痕(组装完 prompt 就写,与轮末反思成功与否无关)——
    // 归「提取」族:它回答的是"这一轮她读到了什么",和"收记忆"是同一件事的两面。
    inject: 'reflect',
    structured_output: 'machine',
    // ★ 2026-10-08:会话清理的心跳行**也是机器行**。以前它没被点名 ⇒ 兜底成 'other'
    // (它的 user_input 是 `(会话清理)`,不匹配 `/^\(工具\)/`)⇒ 恰好躲过"对话优先"的过滤,
    // 于是每 10 分钟一条把展示窗口占满,真实对话被挤到窗口外(现场:「对话优先里没有对话」)。
    'session-reaper': 'machine',
    memory_edit: 'system', memory_state: 'system', memory_clear: 'system', memory_cleanup: 'system',
    session_on: 'system', session_off: 'system', auto_scope_on: 'system', power: 'system',
    diary: 'system', drift: 'system', longing_steer: 'system',
    graph_merge: 'system', graph_cleanup: 'system',
    relay_refused: 'bridge', relay_silent: 'bridge', relay_dropped: 'bridge',
    read: 'work', write: 'work', edit: 'work', glob: 'work', grep: 'work', pwsh: 'work',
    send_message: 'work', subagent: 'work', subagent_fork: 'work', list_agents: 'work',
    interrupt_agent: 'work', job_output: 'work', job_kill: 'work', todo_write: 'work'
  }

  /** 她的话(审计里"她说"的那几列由这些工具写) —— 与 app.js 的老清单同源。 */
  const HER_TOOLS = ['echo_qq_say', 'echo_qq_call', 'relay_out', 'relay_proactive']
  /** 系统行:点名清单(见 app.js 里那段"别把括号当主判据"的说明)。 */
  const SYS_TOOLS = ['memory_edit', 'memory_state', 'memory_clear', 'memory_cleanup',
    'session_on', 'session_off', 'auto_scope_on', 'power', 'diary', 'drift',
    'reflection', 'longing_steer', 'say_again', 'graph_merge', 'graph_cleanup']

  /** 主语标签用的两个称呼(数据与程序分离 P1d,2026-10-05)。
   *
   *  这个文件是纯逻辑、零 DOM,看不见 `/api/echo/profile` —— 所以名字由 app.js
   *  取到后**推**进来(`setProfile`),这里只留一份缓存。
   *  端点在没就绪 / 还没推到 ⇒ **中性兜底**('用户' / '助手'):主语标签是显示名,
   *  判错了不伤数据,但**不许把真名写回代码**。 */
  const NEUTRAL_NAMES = { userName: '用户', agentName: '助手' }
  let names = { userName: NEUTRAL_NAMES.userName, agentName: NEUTRAL_NAMES.agentName }

  /** app.js 取到 profile 后调它(缺字段/整块 null ⇒ 该字段回中性兜底)。 */
  function setProfile (p) {
    const d = (p !== null && typeof p === 'object') ? p : {}
    names = {
      userName: (typeof d.userName === 'string' && d.userName.trim() !== '') ? d.userName.trim() : NEUTRAL_NAMES.userName,
      agentName: (typeof d.agentName === 'string' && d.agentName.trim() !== '') ? d.agentName.trim() : NEUTRAL_NAMES.agentName
    }
    return names
  }

  /** 此刻的名字(别名不参与"谁说的"的判断:别名一律指他,名字已经够用)。 */
  function namesOf () { return names }

  /** 会话 → 来源。DSH 里会话的三种 id 形状(见 docs/ARCHITECTURE.md)。 */
  const SOURCES = {
    qq: { label: 'QQ', cls: 'src-qq', title: 'QQ 这条线(桥进来的)' },
    dsh: { label: 'DSH', cls: 'src-dsh', title: 'DSH 里的一条会话窗口' },
    companion: { label: '陪伴', cls: 'src-companion', title: '兜底陪伴会话(session-echo-companion)' },
    sub: { label: '子代理', cls: 'src-sub', title: '她派出去的子代理(裸 uuid 会话)' },
    bg: { label: '全局', cls: 'src-bg', title: '没有会话的记账行(global)' }
  }

  /** 会话 id → 来源键(**只按会话形状判**:空的/`global` 算全局;`session-<uuid>` 是
   *  窗口;裸 uuid 是子代理)。注意这只是"这条记在谁的账上",**不等于"这条从哪来"** ——
   *  后者要用 `rowSource()`,理由见那里的注释。 */
  function sourceOf (sessionId) {
    const s = String(sessionId === null || sessionId === undefined ? '' : sessionId).trim()
    if (s === '' || s === 'global') return 'bg'
    if (s === 'session-echo-companion') return 'companion'
    if (s.indexOf('session-') === 0) return 'dsh'
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return 'sub'
    return 'bg'
  }

  /** QQ 桥自己写的那几个工具(来源永远是 QQ,不管它被记进哪条会话)。 */
  const QQ_TOOLS = ['relay_in', 'relay_out', 'relay_proactive', 'echo_qq_say', 'echo_qq_call']

  /**
   * 一行**从哪来**(面板上的来源徽章、统计带的来源分布都用它)。
   *
   * 为什么不直接用 `sourceOf(row.sessionId)`:2026-09-29 裁定 A 生效后,
   * **QQ 的消息会被路由进他正开着的那条 DSH 会话**(`relay_in` 就记在那条会话账上)。
   * 若按会话标,他手机上说的一句会显示成「DSH」—— 恰恰把最要紧的事实说反了。
   * 所以:QQ 桥自己写的工具 ⇒ 来源 QQ;其余才按"记在谁的账上"判。
   */
  function rowSource (row) {
    const tool = String((row && row.toolCall) || '')
    if (QQ_TOOLS.indexOf(tool) >= 0) return 'qq'
    return sourceOf(row && row.sessionId)
  }

  /** 会话 id → 短名(面板上只留前 8 位,鼠标悬停看全)。 */
  function shortSid (sessionId) {
    const s = String(sessionId || '')
    if (s === '' || s === 'global') return ''
    const m = s.match(/^session-(.{8})/)
    if (m) return m[1]
    return s.slice(0, 8)
  }

  /** 工具名 → 人话(认不出就原样给 —— 不猜)。 */
  function toolHuman (t) {
    const k = String(t || '')
    if (k === '') return '对话'
    return TOOL_HUMAN[k] || k
  }

  /** 一行归桶。返回 { bucket, source, actor, human } —— 不碰原行。 */
  function classify (row) {
    const tool = String((row && row.toolCall) || '')
    let bucket = TOOL_BUCKET[tool]
    const u = String((row && row.userInput) || '').trim()
    if (bucket === undefined) {
      // 没点名的工具:文本像机器旁白 `(工具) xxx {json}` 就当后台,否则算系统动作。
      // 默认**不吞**:桶只是"怎么显示",原文永远在。
      bucket = /^\(工具\)/.test(u) ? 'machine' : 'other'
    }
    const source = rowSource(row)
    // 谁说的:**只有真说了话的行**才有人称。她主动开口那几行(关怀/喊他/闹钟)
    // 是她写的 —— 主语是她,不是他(2026-09-29 单测当场抓到这个:care 被标成"<称呼>")。
    // ★ P1d:名字从 profile 来(`setProfile` 推的那份),没推到就用中性兜底。
    let actor = ''
    if (bucket === 'talk') {
      actor = HER_TOOLS.indexOf(tool) >= 0 ? names.agentName : names.userName
    } else if (bucket === 'her') {
      actor = names.agentName
    } else if (bucket === 'reflect') {
      actor = tool === 'extract' ? '提取器' : (tool === 'inject' ? '注入留痕' : '记忆整固')
    }
    return { bucket, source, actor, human: toolHuman(tool) }
  }

  /** 一行是不是"有人说了话"(折叠时用来决定归属谁)。 */
  function isTalk (bucket) { return bucket === 'talk' || bucket === 'her' }

  /**
   * 从 `(工具) structured_output {…json…}` 里取出 JSON(取不到就 null)。
   * 别用正则硬啃整段 JSON —— 括号里有括号,老老实实从第一个 `{` 配对到末尾。
   */
  function payloadJson (text) {
    const s = String(text || '')
    const at = s.indexOf('{')
    if (at < 0) return null
    let body = s.slice(at).trim()
    // 有的行尾部还有一句人话(「→ 他在用的那条会话」这种),截到最后一个 `}` 为止
    const last = body.lastIndexOf('}')
    if (last < 0) return null
    try { return JSON.parse(body.slice(0, last + 1)) } catch { return null }
  }

  /** 数值保留一位小数,整数不留 `.0`。 */
  function num (v) {
    const n = Number(v)
    if (!Number.isFinite(n)) return String(v)
    return String(Math.round(n * 10) / 10)
  }

  /**
   * 后台行的**人话标签**(信息不删:原文在展开区,这里只是让人一眼看懂)。
   * 认得出几类就标几类,认不出就列前三个字段名 —— 绝不返回空(空了就成了静默)。
   */
  function machineTags (row) {
    const u = String((row && row.userInput) || '')
    const j = payloadJson(u)
    if (j === null || typeof j !== 'object') {
      const flat = u.replace(/\s+/g, ' ').trim()
      return flat === '' ? [] : [{ k: '原文', v: flat.slice(0, 80) }]
    }
    const tags = []
    const list = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x !== '') : [])
    if (list(j.keywords).length > 0) tags.push({ k: '词', v: list(j.keywords).slice(0, 8).join('、') })
    if (list(j.terms).length > 0) tags.push({ k: '词', v: list(j.terms).slice(0, 8).join('、') })
    if (typeof j.summary === 'string' && j.summary.trim() !== '') tags.push({ k: '记', v: j.summary.trim().slice(0, 90) })
    if (list(j.items).length > 0) tags.push({ k: '条', v: list(j.items).length + ' 条待整固' })
    const g = j.global && typeof j.global === 'object' ? j.global : null
    if (g !== null) {
      const bits = []
      if (g.fatigue !== undefined) bits.push('疲惫 ' + num(g.fatigue))
      if (g.valence !== undefined) bits.push('心情 ' + num(g.valence))
      if (g.arousal !== undefined) bits.push('唤醒 ' + num(g.arousal))
      if (g.intensity !== undefined) bits.push('强度 ' + num(g.intensity))
      if (bits.length > 0) tags.push({ k: '全局', v: bits.join(' · ') })
    }
    const tm = j.target_master && typeof j.target_master === 'object' ? j.target_master : null
    if (tm !== null) {
      const bits = []
      if (tm.affection !== undefined) bits.push('爱意 ' + num(tm.affection))
      if (tm.playfulness !== undefined) bits.push('调皮 ' + num(tm.playfulness))
      if (tm.sadness !== undefined) bits.push('委屈 ' + num(tm.sadness))
      if (tm.dependency !== undefined) bits.push('依赖 ' + num(tm.dependency))
      if (bits.length > 0) tags.push({ k: '对你', v: bits.join(' · ') })
    }
    if (j.emotion_score !== undefined) tags.push({ k: '情绪分', v: num(j.emotion_score) })
    if (typeof j.emotion_state === 'string' && j.emotion_state !== '') tags.push({ k: '情绪', v: j.emotion_state.slice(0, 40) })
    if (typeof j.reason === 'string' && j.reason.trim() !== '') tags.push({ k: '理由', v: j.reason.trim().slice(0, 70) })
    if (typeof j.tone === 'string' && j.tone !== '') tags.push({ k: '语气', v: j.tone.slice(0, 30) })
    if (tags.length === 0) {
      const keys = Object.keys(j).slice(0, 3)
      if (keys.length > 0) tags.push({ k: '字段', v: keys.join('、') })
    }
    return tags
  }

  /** 一轮的**一句话摘要**(她这一轮干了什么),用于折叠行的标题。 */
  function turnGist (turn) {
    const t = turn
    if (t.out.length > 0) return '她说了话'
    if (t.reflect !== null) return '收记忆'
    return BUCKETS[t.bucket] ? BUCKETS[t.bucket].label : '记账'
  }

  /**
   * 把审计行折成**轮**(2026-09-27 那版状态机的续作,判据不变,只多了桶与归属)。
   *
   * 为什么不能靠 traceId 折:`trace_id` 每行一个(活库 100 行全不重复),它标的是
   * "这一次工具调用"不是"这一轮";会话也不行(她的话记在 global、桥记在陪伴会话)。
   * 所以按时间序 + 工具族状态机折 —— 活库实测形状:
   *   `relay_in` 18:52:33 → `echo_qq_say` 18:52:44 + `relay_out` 18:52:44 → `extract` 18:53:00
   * 2026-09-29 增补:后台/干活/系统行**挂到最近一轮说过话的轮**脚下(`ATTACH_SEC` 内),
   * 挂不上的自己成轮 —— 这样"这一轮后台跑了 9 次"才数得清。
   */
  const ATTACH_SEC = 900

  /**
   * 从一行里取它的「轮次」键（`stage_detail.turnTrace`）。
   *
   * ★ 2026-10-18：这是**归组的主键**，优先于时间窗口。
   *
   * 现场（他报「审计面板数据缺了很多」）：一次对话轮写成 6~8 行，而
   * `buildTurns` 原来只按**时间窗口 + 桶**折，于是
   * `retrieve` / `same_turn_emotion` / `ipc-appraise` 这些 `bucket='other'`
   * 的行**各自孤立成一组**（实测 60 行归成 34 组，8 行的一轮被拆成 4 组）。
   *
   * 现在：同一 `turnTrace` ⇒ 一定是同一轮（不受 `ATTACH_SEC` 和桶限制）。
   * 没有 `turnTrace` 的行（老数据 / 系统事件）⇒ **退回原来的时间窗口逻辑**，
   * 一行行为都不变（向后兼容）。
   */
  function traceOf (row) {
    const sd = String(row?.stageDetail ?? '')
    if (sd === '') return ''
    try {
      const o = JSON.parse(sd)
      if (o !== null && typeof o === 'object') {
        const v = o.turnTrace
        return typeof v === 'string' ? v.trim() : ''
      }
    } catch { /* 不是 JSON 就当没有 —— 绝不因为解析失败丢行 */ }
    return ''
  }

  function buildTurns (rows) {
    const list = (Array.isArray(rows) ? rows.slice() : [])
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    const turns = []
    // ★ 2026-10-18：turnTrace → 轮 的索引（见 `traceOf` 的注释）。
    //   只在 buildTurns 这一次调用内有效 —— 不跨渲染缓存，避免行变了索引不更新。
    const traceIndex = new Map()
    const lastTalk = () => {
      for (let i = turns.length - 1; i >= 0; i--) {
        if (isTalk(turns[i].bucket) || turns[i].out.length > 0) return turns[i]
      }
      return null
    }
    const open = (r, bucket) => {
      const t = {
        id: (String(r.traceId || '') !== '' ? String(r.traceId) : ('t' + turns.length + '-' + bucket)),
        bucket,
        source: rowSource(r),
        sessions: [],
        time: Number(r.timestamp || 0),
        lastTime: Number(r.timestamp || 0),
        in: null,
        out: [],
        reflect: null,
        talk: null,
        extra: [],
        rows: [],
        // 这一轮属于哪个 turnTrace（同一轮的行共用一个；老数据为空）
        turnTrace: ''
      }
      turns.push(t)
      return t
    }
    const isOut = (t) => t === 'echo_qq_say' || t === 'relay_out'
    const isProactive = (t) => t === 'echo_qq_call' || t === 'relay_proactive' || t === 'care' || t === 'wake'
    for (const r of list) {
      const tool = String(r.toolCall || '')
      const at = Number(r.timestamp || 0)
      const cls = classify(r)
      // ★ 2026-10-18：**turnTrace 优先** —— 同一个 turnTrace 一定是同一轮。
      //   这比时间窗口可靠得多：一轮里 8 行的时间可能散在 35 秒里，
      //   而 `retrieve` / `same_turn_emotion` / `ipc-appraise` 的桶是 `other`，
      //   老的「挂到最近说过话的轮」分支会因为 `cls.bucket !== 'other'` 把它们踢开。
      const tt = traceOf(r)
      let turn
      if (tt !== '') {
        // ① 这一轮已经登记过 ⇒ 直接并进去（不论桶、不论隔多久）
        const known = traceIndex.get(tt)
        if (known !== undefined) {
          turn = known
        } else {
          // ② 没登记过 ⇒ 先看"最近一轮"能不能**认领**这个 trace。
          //
          //    为什么需要这一步：真实数据里**第一个到达的行（`relay_in`）往往没有
          //    `turnTrace`**（写入端是在注入/出站时才拿到轮标的），而紧接着的
          //    `inject` / `retrieve` 才有。若直接给它们开新组，
          //    就会出现「relay_in 孤零零一组 + 其余行另一组」——
          //    这正是第一版实测到的那 3 组分裂。
          //
          //    所以：最近一轮若还没主，就让它认领这个 trace（把身份补上），
          //    这一行并进去；否则才开新组。
          const target = lastTalk()
          const since = target === null ? Infinity : at - target.lastTime
          if (target !== null && target.turnTrace === '' && since <= ATTACH_SEC) {
            target.turnTrace = tt
            traceIndex.set(tt, target)
            turn = target
          } else {
            turn = open(r, cls.bucket)
            turn.turnTrace = tt
            traceIndex.set(tt, turn)
          }
        }
      } else if (tool === 'relay_in') {
        turn = open(r, 'talk')
        turn.in = r
      } else if (isOut(tool)) {
        const target = lastTalk()
        const since = target === null ? Infinity : at - target.lastTime
        turn = (target !== null && since <= 300) ? target : open(r, 'talk')
        turn.out.push(r)
      } else if (isProactive(tool)) {
        turn = open(r, 'her')
        turn.out.push(r)
      } else if (tool === 'extract') {
        // 提取归到"刚说完话、还没提取过"的那一轮(**必须出过话**:`out.length > 0`)。
        // 2026-09-29 差点改错:曾想放宽成"有入站也算",可活库 18:51~18:52 那条交错里,
        // r1 反思的是**上一轮**(它排在新入站之后)—— 放宽就会挂到新入站那一轮上,
        // 测试「一进一出不许被夹在中间的反思卡拆开」当场抓住。判据不动。
        let target = null
        for (let i = turns.length - 1; i >= 0; i--) {
          const t = turns[i]
          if (at - t.lastTime > ATTACH_SEC) break
          if (t.out.length > 0 && t.reflect === null) { target = t; break }
        }
        turn = target !== null ? target : open(r, 'reflect')
        turn.reflect = r
      } else {
        // 后台 / 干活 / 系统 / 桥:挂到最近一轮说过话的轮(超时自己成轮)
        const target = lastTalk()
        const since = target === null ? Infinity : at - target.lastTime
        if (target !== null && since <= ATTACH_SEC && cls.bucket !== 'other') {
          turn = target
        } else {
          turn = open(r, cls.bucket)
        }
        turn.extra.push(r)
      }
      turn.lastTime = at
      turn.rows.push(r)
      // 索引已在上面的 `tt !== ''` 分支里登记过；这里只兜底"没走那个分支但轮上没 trace"的情况
      if (tt !== '' && turn.turnTrace === '') turn.turnTrace = tt
      const sid = String(r.sessionId || '')
      if (sid !== '' && turn.sessions.indexOf(sid) < 0) turn.sessions.push(sid)
    }
    // 轮自己的桶:说过话就是对话/她主动;否则看主力行
    for (const t of turns) {
      if (t.in !== null) t.bucket = 'talk'
      else if (t.out.length > 0) t.bucket = t.bucket === 'her' ? 'her' : 'talk'
      else if (t.reflect !== null) t.bucket = t.bucket === 'machine' ? 'machine' : 'reflect'
      else if (t.extra.length > 0) t.bucket = classify(t.extra[0]).bucket
      // ★ 2026-10-18：有 turnTrace 就用它当轮 id。
      //
      // 为什么：`open()` 里的 id 取的是"开轮那一行"的 `traceId`，而归组规则一改，
      // 开轮的行就可能换（比如原来 `relay_in` 开轮，认领 trace 之后变成别的行）
      // ⇒ **id 漂移** ⇒ 面板上按 id 记的「展开/收起」状态（`app.js` 的 `auSel`）
      // 会对不上、整组塌掉（`app.js:881` 那条注释记的正是这个老坑）。
      // `turnTrace` 是一轮一个的稳定标识 ⇒ 拿它当 id，同一轮永远同一个 id。
      if (t.turnTrace !== '') t.id = t.turnTrace
    }
    return turns
  }

  /**
   * ★ 2026-10-08(窗口按内容凑数):从大窗口里挑"值得占展示位"的行。
   *
   * 现场:会话清理每 10 分钟写一行审计(实测 24h 52 条),而"对话优先"档只取最新 40 行
   * ⇒ 40 行 ≈ 6.7 小时的清理行,真实对话被顶到窗口外,左栏只剩一串「会话清理」。
   *
   * 判据:只算 `whitelist` 里的桶(默认 talk / her / reflect),从最新往回取,取满 `limit` 行为止
   * —— **宁可多往回翻行,也要把对话凑够**。没有 traceId 的行一律保留(认不出也绝不丢)。
   *
   * @param {object[]} rows 大窗口(新的在前;本函数自己按时间排序,不依赖顺序)
   * @param {number} limit 要凑多少行
   * @param {string[]} [whitelist] 哪些桶算"内容"(默认 talk/her/reflect)
   */
  function contentRows (rows, limit, whitelist) {
    const all = Array.isArray(rows) ? rows : []
    const n = Math.max(1, Math.floor(Number(limit) || all.length))
    const allow = (Array.isArray(whitelist) && whitelist.length > 0) ? whitelist : ['talk', 'her', 'reflect']
    const sorted = all.slice().sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    const out = []
    for (const r of sorted) {
      if (out.length >= n) break
      const t = String((r && r.traceId) || '')
      if (t === '') { out.push(r); continue }   // 认不出的行:保留(与 turnsForDisplay 同口径)
      if (allow.indexOf(classify(r).bucket) >= 0) out.push(r)
    }
    return out
  }

  /**
   * ★ 2026-10-08 F1′:折轮的窗口**比展示的窗口大**。
   *
   * 轮的 id 来自"定义这一轮的那一行"的 traceId(折轮时 `open()` 取的那一行)⇒ 那一行
   * 一旦滑出折轮窗口,同一个逻辑轮就会换 id(app.js 里 `auditOpen` / `auditClosed` / `auSel`
   * 存的全是旧 id ⇒ 他展开的详情"自己关掉")。所以分两步:
   *   ① 用**大窗口**折轮 —— 定义行只要还在大窗口里,id 就稳定;
   *   ② 再用**展示窗口**挑出该显示的轮 —— 行在展示窗口里出现过的轮才算。
   *
   * @param {object[]} rows 大窗口的行(接口是新的在前;本函数不依赖顺序)
   * @param {number|object[]} limitOrRows 展示窗口:行数(40 / 120),**或**直接给一份行
   *        (app.js 用 `contentRows` 算出来的"内容窗口"—— 见上一个函数)
   */
  function turnsForDisplay (rows, limitOrRows) {
    const all = Array.isArray(rows) ? rows : []
    const turns = buildTurns(all)
    let newest
    if (Array.isArray(limitOrRows)) {
      newest = limitOrRows
    } else {
      const n = Math.max(1, Math.floor(Number(limitOrRows) || all.length))
      if (all.length <= n) return turns
      newest = all.slice()
        .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
        .slice(0, n)
    }
    const shown = new Set()
    for (const r of newest) {
      const t = String((r && r.traceId) || '')
      if (t !== '') shown.add(t)
    }
    if (shown.size === 0 && newest.length === 0) return []   // 展示窗口空 ⇒ 什么都不显示(空态)
    return turns.filter((turn) => turn.rows.some((r) => {
      const t = String((r && r.traceId) || '')
      return t === '' || shown.has(t)   // 没有 traceId 的行当"总在窗口里":绝不因为缺 id 丢轮
    }))
  }

  /** 一轮里各类行的计数(折叠行「⛭ 后台 9 次 · 提取 1 次」用它)。 */
  function countByBucket (turn) {
    const out = {}
    for (const r of turn.rows) {
      const b = classify(r).bucket
      out[b] = (out[b] || 0) + 1
    }
    return out
  }

  /** 时间戳 → 毫秒。**两套单位都要吃**:审计库里的 `timestamp` 是**秒**
   *  (SQLite `strftime('%s')`),而 `Date.now()` 给的是毫秒 —— 混着用会把
   *  "12 分钟前"算成"50 年前"(2026-09-29 单测抓到)。判据:秒级量级都 < 1e11
   *  (即 5138 年之前),比它大的当毫秒原样用。 */
  function msOf (ts) {
    const n = Number(ts || 0)
    if (!Number.isFinite(n) || n <= 0) return 0
    return n > 1e11 ? n : n * 1000
  }

  /** 本地 `HH:MM`(自己拼,不用 toLocaleTimeString —— 它在 Node 与浏览器里给的
   *  秒/格式不一致,而"看法"是要离线测的:同一份数据必须给同一串字)。 */
  function clock (ts) {
    const d = new Date(msOf(ts))
    const p = (n) => (n < 10 ? '0' + n : String(n))
    return p(d.getHours()) + ':' + p(d.getMinutes())
  }

  /** 时间 → 相对话(人味):刚刚 / N 分钟前 / 今天 19:35 / 昨天 19:35 / 9-26 19:35。
   *  `ts` 与 `now` 都可以给秒或毫秒(见 msOf);`ts = 0` 给「—」。 */
  function relTime (ts, now) {
    const t = msOf(ts)
    if (!(t > 0)) return '—'
    const ref = msOf(now) || Date.now()
    const d = ref - t
    if (d < 45 * 1000) return '刚刚'
    if (d < 3600 * 1000) return Math.max(1, Math.round(d / 60000)) + ' 分钟前'
    const date = new Date(t)
    const c = clock(t)
    const today = new Date(ref)
    const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
    if (sameDay) return '今天 ' + c
    const yest = new Date(ref - 86400 * 1000)
    const isYest = date.getFullYear() === yest.getFullYear() && date.getMonth() === yest.getMonth() && date.getDate() === yest.getDate()
    if (isYest) return '昨天 ' + c
    return (date.getMonth() + 1) + '-' + date.getDate() + ' ' + c
  }

  /** 时间 → 日期分组键(本地时区,`YYYY-MM-DD`;秒/毫秒都吃)。 */
  function dayKey (ts) {
    const ms = msOf(ts)
    if (!(ms > 0)) return 'unknown'
    const d = new Date(ms)
    const p = (n) => (n < 10 ? '0' + n : String(n))
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }

  /** 日期键 → 标题(今天 / 昨天 / 9 月 26 日 星期五)。 */
  const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  function dayLabel (key, now) {
    if (key === 'unknown') return '时间不明'
    const ref = new Date(msOf(now) || Date.now())
    const p = (n) => (n < 10 ? '0' + n : String(n))
    const todayKey = ref.getFullYear() + '-' + p(ref.getMonth() + 1) + '-' + p(ref.getDate())
    const y = new Date(ref.getTime() - 86400 * 1000)
    const yKey = y.getFullYear() + '-' + p(y.getMonth() + 1) + '-' + p(y.getDate())
    if (key === todayKey) return '今天'
    if (key === yKey) return '昨天'
    const parts = String(key).split('-')
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
    return Number(parts[1]) + ' 月 ' + Number(parts[2]) + ' 日 ' + WEEK[d.getDay()]
  }

  /** 轮 → 按天分组(新的在前;天内的轮也新的在前)。 */
  function groupByDay (turns, now) {
    const map = new Map()
    for (const t of (Array.isArray(turns) ? turns : [])) {
      const k = dayKey(t.time)
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(t)
    }
    const keys = Array.from(map.keys()).sort().reverse()
    return keys.map((k) => ({
      key: k,
      label: dayLabel(k, now),
      turns: map.get(k).slice().sort((a, b) => b.time - a.time)
    }))
  }

  /** 一屏顶部的统计带:行数分布 + 来源分布 + 最近一次有人说话。 */
  function summarize (rows, now) {
    const list = Array.isArray(rows) ? rows : []
    const buckets = { talk: 0, her: 0, reflect: 0, work: 0, machine: 0, system: 0, bridge: 0, other: 0 }
    const sources = { qq: 0, dsh: 0, companion: 0, sub: 0, bg: 0 }
    let lastTalkAt = 0
    let oldest = 0
    let newest = 0
    // 2026-10-06:证据链体检 —— 这一窗里**有几行真的带着注入块**、最近那条多少字。
    // 面板上原来只看得到"这一轮注入了多少字"(得点开轮卡片),看不到"整窗有没有证据";
    // 活库那次 160 行全空,盯着页面也看不出来,只有翻数据库才发现。
    let injRows = 0
    let injectRows = 0
    let lastInjAt = 0
    let lastInjChars = 0
    for (const r of list) {
      const c = classify(r)
      buckets[c.bucket] = (buckets[c.bucket] || 0) + 1
      sources[c.source] = (sources[c.source] || 0) + 1
      const at = Number(r.timestamp || 0)
      if (at > 0) {
        if (newest === 0 || at > newest) newest = at
        if (oldest === 0 || at < oldest) oldest = at
      }
      if (isTalk(c.bucket) && at > lastTalkAt) lastTalkAt = at
      const injChars = String(r.injectedMemories || '').length
      if (injChars > 0) {
        injRows += 1
        if (at >= lastInjAt) { lastInjAt = at; lastInjChars = injChars }
      }
      if (String(r.toolCall || '') === 'inject') injectRows += 1
    }
    return {
      rows: list.length, buckets, sources, lastTalkAt, oldest, newest,
      injects: { rows: injRows, lines: injectRows, lastAt: lastInjAt, lastChars: lastInjChars },
      days: dayKey(newest || Number(now || Date.now()))
    }
  }

  /** 检索:把一轮里所有能搜的字段拼成一串(与老版同源,加了桶名与人话工具名)。 */
  function turnText (turn) {
    const parts = []
    for (const r of turn.rows) {
      parts.push(String(r.toolCall || ''), toolHuman(r.toolCall), String(r.userInput || ''),
        String(r.llmReply || ''), String(r.sessionId || ''), String(r.extraReply || ''),
        String(r.injectedMemories || ''), String(r.emotionPack || ''), String(r.injectedProfile || ''))
    }
    parts.push(BUCKETS[turn.bucket] ? BUCKETS[turn.bucket].label : '')
    return parts.join(' ')
  }

  return {
    BUCKETS, SOURCES, TOOL_HUMAN, TOOL_BUCKET, HER_TOOLS, SYS_TOOLS, ATTACH_SEC,
    setProfile, namesOf,
    classify, isTalk, sourceOf, rowSource, QQ_TOOLS, shortSid, toolHuman, clock, msOf,
    buildTurns, turnsForDisplay, contentRows, countByBucket, turnGist, machineTags, payloadJson,
    traceOf,
    relTime, dayKey, dayLabel, groupByDay, summarize, turnText
  }
})()
