/**
 * dsh-echo — 对话导出「复现包」(v0.15.1 G16)
 * ============================================================
 * A 侧是 `export_conversation.py`:一份 .md(人读)+ 一份 .json(机器读),
 * 内容是「这一轮次里她看到了什么、想了什么、回了什么」的全套事实 ——
 * 轮次、注入画像、注入记忆、情绪包、内部状态、回复、向量差分、余波,
 * 外加 agent_state / longing / 开放话题。
 *
 * DSH 里这些事实分散在几张表(audit_logs 的 20 列、agent_state、
 * pending_threads、longing_state、episodic_memory),所以这一层做的
 * 是**同一件事**:把同一批真值打成一份可复现的包。
 *
 * 为什么是纯函数:导出是答辩与排障的证据链,**不许有副作用也不许
 * 偷偷补数据** —— 缺的字段就写「(无)」,不编。纯函数也让「同一份输入
 * 永远导出同一份结果」这件事可测(见 tests/export.test.js)。
 */

/** 时间:秒(引擎口径)→「YYYY-MM-DD HH:MM:SS」。0 视为未知。 */
export function exportTime (sec) {
  const n = Number(sec) || 0
  if (n <= 0) return '(无)'
  const d = new Date(n * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

const clip = (s, n) => {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * 组装复现包(纯函数)。
 *
 * 入参(全部是**已经读出来的真值**,不做任何 IO):
 *   meta     { version, generatedAt(ms), dataDir?, dbPath? }
 *   settings 当前调参(注入条数/审计保留/TTL…,复现要的现场)
 *   state    agent_state(她的心情与 11 维向量)
 *   profile  画像
 *   audit    审计行数组(listAudit 的形状,倒序/正序都行,这里按时间升序排)
 *   threads  悬置话题 listThreads() 的返回(四态桶)
 *   longing  想念行(longingRows())
 *   health   记忆体检(memoryHealth())
 *   sessions 会话索引(sessionPreviews())
 *   filter   { sessionId: '' } —— 非空时只导出该会话的审计行
 */
export function buildExportPack (input = {}) {
  const meta = input.meta || {}
  const filter = input.filter || {}
  const sessionId = String(filter.sessionId || '')
  let audit = Array.isArray(input.audit) ? input.audit.slice() : []
  if (sessionId !== '') audit = audit.filter((r) => String(r?.sessionId || '') === sessionId)
  // 升序 = 讲故事的方向(时间从旧到新)
  audit.sort((a, b) => (Number(a?.timestamp) || 0) - (Number(b?.timestamp) || 0))

  const threads = input.threads || {}
  const openThreads = []
  // 2026-10-06 D5:导出**仍含全量**(留档的意义),但每行标出它在哪一档 +
  // 类别徽标 / 生命周期两列 —— 复现时要看得出"这条当时算不算活跃"。
  for (const bucket of ['waiting', 'due', 'untimed', 'done', 'cooling', 'resolved', 'archived']) {
    for (const t of (Array.isArray(threads[bucket]) ? threads[bucket] : [])) {
      openThreads.push({
        threadId: Number(t?.threadId) || 0,
        content: String(t?.content || ''),
        state: bucket,
        kind: String(t?.kind || ''),
        lifeState: bucket === 'cooling' ? 'cooling' : (bucket === 'archived' ? 'archived' : (bucket === 'resolved' ? 'resolved' : 'active')),
        followUpAfter: Number(t?.followUpAfter) || 0,
        coolingAt: Number(t?.coolingAt) || 0,
        archivedAt: Number(t?.archivedAt) || 0,
        supersededBy: Number(t?.supersededBy) || 0,
        updatedAt: Number(t?.updatedAt) || 0
      })
    }
  }

  return {
    kind: 'dsh-echo-export',
    version: String(meta.version || ''),
    generatedAt: Number(meta.generatedAt) || Date.now(),
    scope: sessionId === '' ? 'all' : sessionId,
    meta: {
      dataDir: String(meta.dataDir || ''),
      dbPath: String(meta.dbPath || '')
    },
    // 调参放顶层(不放 meta):复现时要先看的是「当时注入几条、审计留几行、
    // TTL 多少天」—— 它们解释的是行为,不是文件出处。
    settings: input.settings || null,
    state: input.state || null,
    profile: input.profile || null,
    health: input.health || null,
    sessions: Array.isArray(input.sessions) ? input.sessions : [],
    longing: Array.isArray(input.longing) ? input.longing : [],
    threads: openThreads,
    turns: audit.map((r) => ({
      traceId: String(r?.traceId || ''),
      timestamp: Number(r?.timestamp) || 0,
      time: exportTime(r?.timestamp),
      sessionId: String(r?.sessionId || ''),
      toolCall: String(r?.toolCall || ''),
      userInput: String(r?.userInput || ''),
      injectedProfile: String(r?.injectedProfile || ''),
      // 形状原样透传:listAudit 现在给**渲染全文**(string,见 store.js:835
      // 的修复);老的夹具/历史复现包里可能是 [{summary}] —— 渲染层两种都认,
      // 这里不擅自改形(改了会把老复现包读成空)。
      injectedMemories: r?.injectedMemories ?? '',
      emotionPack: String(r?.emotionPack || ''),
      agentState: r?.agentState ?? null,
      emotionVector: r?.emotionVector ?? null,
      emotionDelta: String(r?.emotionDelta || ''),
      moodIntensity: Number(r?.moodIntensity) || 0,
      prevMoodIntensity: Number(r?.prevMoodIntensity) || 0,
      latency: (r?.latency === null || r?.latency === undefined) ? null : Number(r.latency),
      llmReply: String(r?.llmReply || ''),
      // v0.21.0 E5:情绪余波(A 的 export_conversation.py:264 也是
      // `if r["extra_reply"]` 才追加一行;NULL 原样保留 = "那一版没这机制")
      sayAgain: (r?.sayAgain === null || r?.sayAgain === undefined) ? null : Number(r.sayAgain),
      extraReply: (r?.extraReply === null || r?.extraReply === undefined) ? null : String(r.extraReply)
    }))
  }
}

/** 复现包 → Markdown(人读版)。缺的字段写「(无)」,不编。 */
export function renderExportMarkdown (pack) {
  const p = pack || {}
  const L = []
  const st = p.state || {}
  const vec = st.emotionVector || {}
  L.push('# Echo 复现包')
  L.push('')
  L.push('- 生成时间: ' + exportTime((Number(p.generatedAt) || 0) / 1000))
  L.push('- 插件版本: ' + (p.version || '(无)'))
  L.push('- 范围: ' + (p.scope === 'all' ? '全部会话' : '会话 ' + p.scope))
  L.push('- 轮次: ' + String((p.turns || []).length) + ' 行')
  if (p.meta?.dbPath) L.push('- 记忆库: ' + p.meta.dbPath)
  const cfg = p.settings || {}
  L.push('- 当时的调参: 注入 ' + String(cfg.injectTopK ?? '-') + ' 条 / 审计留 '
    + String(cfg.auditKeep ?? '-') + ' 行 / TTL ' + String(cfg.memoryTtlDays ?? '-') + ' 天'
    + ' / 反思 ' + (cfg.reflectionEnabled === false ? '关' : '开')
    + ' / 漂移体检 ' + (cfg.driftEnabled === false ? '关' : '开'))
  L.push('')

  L.push('## 她此刻的状态')
  L.push('')
  L.push('- 心情强度: ' + String(Number(st.moodIntensity) || 0) + '/10(上一轮 ' + String(Number(st.prevMoodIntensity) || 0) + ')')
  L.push('- 他的心情: ' + (st.userEmotion || 'neutral'))
  L.push('- 此刻的想法: ' + (st.moodReason || '(无)'))
  L.push('- 当前话题: ' + (st.currentTopic || '(无)'))
  L.push('- 更新时间: ' + exportTime(st.updatedAt))
  const dims = []
  for (const [group, dimsObj] of Object.entries(vec)) {
    if (dimsObj && typeof dimsObj === 'object') {
      for (const [k, v] of Object.entries(dimsObj)) dims.push(group + '.' + k + '=' + String(v))
    }
  }
  L.push('- 情绪向量: ' + (dims.length > 0 ? dims.join(', ') : '(无)'))
  L.push('')

  const prof = p.profile
  L.push('## 画像')
  L.push('')
  if (prof && typeof prof === 'object') {
    for (const [k, v] of Object.entries(prof)) {
      if (v === null || v === undefined || v === '') continue
      L.push('- ' + k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : String(v)))
    }
  } else {
    L.push('(无)')
  }
  L.push('')

  const h = p.health || {}
  L.push('## 记忆体检')
  L.push('')
  L.push('- 活跃: ' + String(h.active ?? 0) + ' 条(困倦 ' + String(h.dormant ?? 0)
    + ' / 归档 ' + String(h.archived ?? 0) + ')')
  if (h.temporal && typeof h.temporal === 'object') {
    L.push('- 时间状态: ' + Object.entries(h.temporal).map(([k, v]) => k + '=' + String(v)).join(', '))
  }
  L.push('- 悬置话题: ' + String(h.threads ?? 0) + ' 条')
  L.push('')

  if ((p.longing || []).length > 0) {
    L.push('## 想念')
    L.push('')
    for (const r of p.longing) {
      L.push('- ' + String(r.userId || r.user_id || '') + ': ' + String(r.value ?? '')
        + ' / 阈值 ' + String(r.threshold ?? '') + '(' + String(r.since || '') + ')')
    }
    L.push('')
  }

  if ((p.threads || []).length > 0) {
    L.push('## 悬置话题')
    L.push('')
    for (const t of p.threads) {
      L.push('- #' + String(t.threadId) + ' [' + t.state + '] «' + t.content + '»'
        + (t.followUpAfter > 0 ? '(约定 ' + exportTime(t.followUpAfter) + ')' : '(不定时)'))
    }
    L.push('')
  }

  L.push('## 轮次回放')
  L.push('')
  for (const t of (p.turns || [])) {
    // 2026-10-06:注入留痕行(组装完提示词就写的那一行)单独认出来 —— 它没有回复,
    // 读成「她回:(无)」会把"她这一轮读到了什么"当成"她没说话"。
    const isInject = String(t.toolCall || '') === 'inject'
    L.push('### ' + (t.time === '(无)' ? '(时间不详)' : t.time)
      + (isInject ? ' · 注入留痕' : (t.toolCall ? ' · ' + t.toolCall : ''))
      + (t.sessionId ? ' · ' + t.sessionId : ''))
    L.push('')
    L.push('- 他说: ' + (t.userInput || '(无)'))
    if (t.injectedProfile) L.push('- 注入画像: ' + clip(t.injectedProfile, 400))
    // 两种形状都认:新的是渲染全文(string),老夹具/老复现包是 [{summary}]
    // —— 数组按原来的「«摘要»」串起来,字符串原样给(它本来就是给人读的块)。
    if (Array.isArray(t.injectedMemories)) {
      if (t.injectedMemories.length > 0) {
        L.push('- 注入记忆: ' + t.injectedMemories.map((m) =>
          '«' + String(m?.summary ?? m) + '»').join('、'))
      }
    } else if (String(t.injectedMemories || '') !== '') {
      L.push('- 注入记忆(全文):')
      L.push('')
      L.push('```text')
      L.push(String(t.injectedMemories))
      L.push('```')
    }
    if (t.emotionPack) L.push('- 情绪包: ' + t.emotionPack.replace(/\n/g, ' / '))
    if (t.emotionDelta) L.push('- 情绪差分: ' + t.emotionDelta)
    if (t.agentState) L.push('- 内部状态: ' + JSON.stringify(t.agentState))
    L.push('- 心情: ' + String(t.moodIntensity) + '(上一轮 ' + String(t.prevMoodIntensity) + ')'
      + (t.latency === null ? '' : ' · 用时 ' + t.latency.toFixed(1) + 's'))
    if (isInject) {
      L.push('- (这一行只记"她这一轮读到了什么",不是一轮完整的回复 —— 注入块见上)')
    } else {
      L.push('- 她回: ' + (t.llmReply || '(无)'))
    }
    // v0.21.0 E5:A 的 export_conversation.py:264-265 逐字同款
    // (`if r["extra_reply"]: **余波追加**: …`)
    if (t.extraReply) L.push('- **余波追加**: ' + t.extraReply)
    L.push('')
  }
  if ((p.turns || []).length === 0) {
    L.push('(没有轮次记录 —— 审计流为空,或该会话还没说过话)')
    L.push('')
  }
  return L.join('\n')
}
