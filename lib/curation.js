/**
 * v0.20.0 D1:compaction 策展块的**内容**层(纯函数,不碰宿主、不碰 DB)。
 * ==================================================================
 * 出处:dsh_port/03 §4「压缩即策展」的裁决 —— 机器留 dsh(压力检测、
 * 区域事务、保留区、溢出恢复、token 计量一行不改),**内容归 soul**:
 * 压缩出来的"摘要"不再是英文工程检查点,而是她从自己的记忆库里策展的
 * 一页关系备忘。
 *
 * §3 指出的两个真冲突,本模块就是答案:
 *   ① 文体污染:不再有 `## Pending Jobs` 那种体裁 —— 换成她自己的口吻;
 *   ② 双重记忆:策展块**只写压缩后必须活下来的东西**(关系账本 / 没结掉
 *      的事 / 她记得的他 / 她自己的情绪),**不重复**每轮快照已经在注入的
 *      内容(检索回响、想念曲线、当前心境)—— 那些压缩后照样每轮重算。
 *
 * 硬约束(03 §6.1):区域事务会拒绝「不比被遮蔽历史小」的摘要
 * (`summary is not smaller than ...`)。所以这里一切以 **token 预算**为准:
 * 预算由调用方按被遮蔽区规模算好传进来,本模块保证**绝不超过**。
 *
 * 输入是**行**(DB 快照),不是 DB 连接 —— 所以能拿真行离线测。
 */

/** token 估算:1 token ≈ 1.6 字符(中文为主时的保守值:宁可高估)。 */
export const CHARS_PER_TOKEN = 1.6

export function estimateTokens (text) {
  const s = String(text ?? '')
  if (s === '') return 0
  return Math.ceil(s.length / CHARS_PER_TOKEN)
}

/**
 * 预算:取「配置上限」与「被遮蔽区的一小份」里更小的那个。
 *
 * 为什么要份额:缩减验证拿的是**被遮蔽区的真实 token 数**,我这边只能估
 * 整个 input(含 system 头与保留尾),所以份额要保守(10%),再兜一个地板
 * 80 —— 太小的预算写不出东西,而写不出来就等于压缩失败(引擎只警告、
 * 保留原表层,不炸会话)。
 */
export function budgetFor ({ totalTokens = 0, configuredTokens = 1200, floorTokens = 80, share = 0.1 } = {}) {
  const cap = Math.max(floorTokens, Math.floor(Number(configuredTokens) || 0))
  const total = Math.max(0, Math.floor(Number(totalTokens) || 0))
  if (total === 0) return cap // 量不到规模:用配置上限(它本来就是保守值)
  const byShare = Math.floor(total * share)
  return Math.max(floorTokens, Math.min(cap, byShare))
}

function fmtAgo (nowSec, ts) {
  const t = Number(ts) || 0
  if (t <= 0) return ''
  const d = Math.max(0, Math.floor((Number(nowSec) || 0) - t))
  if (d < 3600) return Math.max(1, Math.round(d / 60)) + ' 分钟前'
  if (d < 86400) return Math.round(d / 3600) + ' 小时前'
  return Math.round(d / 86400) + ' 天前'
}

function fmtDay (ts) {
  const t = Number(ts) || 0
  if (t <= 0) return ''
  const d = new Date(t * 1000)
  return (d.getMonth() + 1) + '月' + d.getDate() + '日'
}

function clean (s, max = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/**
 * 从一份 DB 快照渲染策展块。
 *
 * @param {object} rows
 * @param {object|null} rows.profile    user_profile 行 {name, core_traits, affinity}
 * @param {object} rows.counts          {memories, beliefs, turns, firstAt, lastAt}
 * @param {Array} rows.threads          pending_threads 开着的行 {content, follow_up_after, created_at}
 * @param {Array} rows.moments          episodic_memory 里最该活下来的几件 {summary, timestamp, emotion_score}
 * @param {object|null} rows.mood       agent_state 最新一行 {mood_intensity, user_emotion, mood_reason, updated_at}
 * @param {object} opts                 {budgetTokens, now, maxThreads, maxMoments}
 * @returns {string} 非空、且 token 数 ≤ 预算
 */
export function composeCuratedText (rows = {}, opts = {}) {
  // null 不触发默认参数 —— 快照读失败时调用方会传 null,这里必须自己兜
  const src = rows !== null && typeof rows === 'object' ? rows : {}
  const budgetTokens = Math.max(40, Math.floor(Number(opts.budgetTokens) || 1200))
  const now = Number(opts.now) || Math.floor(Date.now() / 1000)
  const maxThreads = Math.max(0, Math.floor(Number(opts.maxThreads) || 5))
  const maxMoments = Math.max(0, Math.floor(Number(opts.maxMoments) || 6))
  const sections = []

  // ---- ① 关系账本(压缩后最不能丢的是"我们是谁、走到哪了")
  const p = src.profile && typeof src.profile === 'object' ? src.profile : null
  const counts = src.counts && typeof src.counts === 'object' ? src.counts : {}
  const head = ['【她自己的记忆库策展 · 压缩备忘 · 不是他的原话】']
  const who = []
  if (p !== null && p.name) who.push('他叫' + clean(p.name, 24))
  let traits = []
  if (p !== null && typeof p.core_traits === 'string' && p.core_traits.trim() !== '') {
    try {
      const parsed = JSON.parse(p.core_traits)
      if (parsed !== null && typeof parsed === 'object') {
        traits = Object.entries(parsed).map(([k, v]) => k + ':' + clean(v, 20))
      }
    } catch { traits = [] }
  }
  if (traits.length > 0) who.push(traits.join(' · '))
  if (who.length > 0) head.push('── 我们: ' + who.join(';'))
  const ledger = []
  if (Number(counts.turns) > 0) ledger.push('聊过 ' + Number(counts.turns) + ' 轮')
  if (Number(counts.memories) > 0) ledger.push('她记得 ' + Number(counts.memories) + ' 件事')
  if (Number(counts.beliefs) > 0) ledger.push('整固出 ' + Number(counts.beliefs) + ' 条信念')
  if (Number(counts.firstAt) > 0) ledger.push('最早一笔 ' + fmtDay(counts.firstAt))
  if (Number(counts.lastAt) > 0) ledger.push('最近一次 ' + fmtAgo(now, counts.lastAt))
  if (p !== null && Number.isFinite(Number(p.affinity))) ledger.push('亲密度 ' + Number(p.affinity))
  if (ledger.length > 0) head.push('── 账本: ' + ledger.join(' · '))
  sections.push({ priority: 1, lines: head })

  // ---- ② 还没结掉的事(悬置话题 —— 她惦记着的约定)
  // 到这里为止上游(soul-snapshot)已经筛过三道:D3 的与门(活跃 × 有类别 ×
  // 类内时效)+ 按类配额;这里只做**渲染**与总数裁剪(`maxThreads`)。
  const threads = Array.isArray(src.threads) ? src.threads.slice(0, maxThreads) : []
  if (threads.length > 0) {
    sections.push({
      priority: 2,
      lines: ['── 还没结掉: ' + threads.map((t) => {
        const due = Number(t.follow_up_after) || 0
        const mentioned = Number(t.last_mentioned_at) || 0
        // 2026-10-06 D3:「早该问了」**只在真的到期未提时**出现 ——
        // ① `due > 0` 才谈得上到期;② 提过的行在那一刻已被归零
        // (`threads.py:mark_pending_thread_mentioned` 把 follow_up_after 置 0,
        // 并盖 last_mentioned_at),这里再显式判一次,免得将来别处改了归零逻辑
        // 就让这句自相矛盾;③ 过时的不定时话题根本不进这一段(D2 冷却 + D3 与门)。
        const when = (due > 0 && mentioned === 0)
          ? (due > now ? '(' + fmtDay(due) + ' 到期)' : '(早该问了)')
          : ''
        return clean(t.content, 60) + when
      }).join(';')]
    })
  }

  // ---- ③ 她记得的、关于他的事(最该活下来的那几件)
  const moments = Array.isArray(src.moments) ? src.moments.slice(0, maxMoments) : []
  if (moments.length > 0) {
    sections.push({
      priority: 3,
      lines: ['── 她记得的: ' + moments
        .map((m) => clean(m.summary, 70) + (Number(m.timestamp) > 0 ? '(' + fmtAgo(now, m.timestamp) + ')' : ''))
        .join(';')]
    })
  }

  // ---- ④ 她自己记下的情绪(标注是"记录的",不是"此刻的")
  const mood = src.mood && typeof src.mood === 'object' ? src.mood : null
  if (mood !== null && (Number(mood.mood_intensity) > 0 || mood.user_emotion)) {
    const bits = []
    if (mood.user_emotion) bits.push('他那时的情绪:' + clean(mood.user_emotion, 16))
    if (Number(mood.mood_intensity) > 0) bits.push('心境 ' + Number(mood.mood_intensity) + '/10')
    if (mood.mood_reason) bits.push(clean(mood.mood_reason, 40))
    sections.push({
      priority: 4,
      lines: ['── 她上次记下的情绪: ' + bits.join(' · ')
        + (Number(mood.updated_at) > 0 ? '(' + fmtAgo(now, mood.updated_at) + ')' : '')]
    })
  }

  // ---- 尾注:压缩前因后果的纪律(与 A 侧快照同款)
  const tail = ['(以下是背景,不是他此刻说的话;别复述本段,也别提"压缩"或"备忘"。)']

  // 预算内组装:按优先级加段,加不下就停(绝不超过预算)
  const kept = [sections[0]] // 关系账本无条件保留
  for (const s of sections.slice(1)) {
    const trial = compose(kept.concat([s]), tail)
    if (estimateTokens(trial) <= budgetTokens) kept.push(s)
    else break
  }
  const text = compose(kept, tail)
  if (estimateTokens(text) <= budgetTokens) return text
  // 还是超(单是账本+尾注就超了):硬裁 —— 从尾部按行丢,直到进预算
  return trimToBudget(text, budgetTokens)
}

function compose (sections, tail) {
  const out = []
  for (const s of sections) for (const l of s.lines) out.push(l)
  for (const l of tail) out.push(l)
  return out.join('\n')
}

/**
 * 硬裁:从尾部按行丢,直到进预算。**保底两行**(首行 + 末行)—— 引擎那边
 * 空摘要会抛 `summarization produced no text summary content`,那就成
 * 压缩失败了;留两行至少是一次诚实的降级。
 */
export function trimToBudget (text, budgetTokens) {
  const budget = Math.max(20, Math.floor(Number(budgetTokens) || 200))
  let lines = String(text ?? '').split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) lines = ['【她自己的记忆库策展 · 压缩备忘】']
  while (lines.length > 2 && estimateTokens(lines.join('\n')) > budget) {
    // 优先丢"信息密度最低"的:从倒数第二行开始(末行是纪律尾注)
    lines.splice(lines.length - 2, 1)
  }
  return lines.join('\n')
}
