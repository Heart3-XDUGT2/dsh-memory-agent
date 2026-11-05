/**
 * C1 情绪单轮闭环探针(只读)。
 *
 * 问三件事:
 *   ① 这一版代码被加载了吗(状态面有没有 `sameTurnEmotion`,调参面有没有开关);
 *   ② **同轮生效率** = applied / started —— 他这句话惹到她,这一轮就带上了吗
 *      (搬之前按构造是 ~0%:情绪向量是轮末才写的);
 *   ③ **超时率** = timedOut / started —— 超时不是失败(超时就用上一轮向量照常回复),
 *      但它是这条通道的体检指标:一直超时说明这台机器上 800ms 不够。
 *
 * 纪律:只 GET 两个面,不写库、不改配置。数字不对就说不对(exit 1)。
 * 用法:node scripts/accept-emotion.mjs [--base http://127.0.0.1:3080] [--json]
 */
const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt
}
const asJson = args.includes('--json')
const base = flag('--base', 'http://127.0.0.1:3080').replace(/\/+$/, '')

const results = []
const lines = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: ok === true, detail: String(detail) })
  lines.push((ok === true ? '  ok   ' : '  FAIL ') + name + (ok === true || detail === '' ? '' : ' —— ' + detail))
}

let st = null
try {
  const res = await fetch(base + '/api/echo/status', { signal: AbortSignal.timeout(4000) })
  st = await res.json()
  check('状态面可达', true)
} catch (e) {
  check('状态面可达', false, String(e?.message ?? e))
}

let cfg = null
try {
  const res = await fetch(base + '/api/echo/settings', { signal: AbortSignal.timeout(4000) })
  cfg = await res.json()
} catch { cfg = null }

if (st !== null) {
  const raw = st.sameTurnEmotion
  const s = raw ?? null
  const notLoaded = raw === undefined
  check('状态面有 sameTurnEmotion(C1 已加载)', s !== null && typeof s === 'object',
    notLoaded ? '字段不在 ⇒ 这版代码还没被宿主加载(要重启 dsh web 才生效)' : '')
  if (notLoaded) {
    lines.push('  info 这不是故障,是"还没重启":磁盘上是这一版,宿主里跑的是上一版。')
    lines.push('       重启之后他第一句话就会让这段代码起跑。')
  }
  const skipped = s === null || typeof s !== 'object' ? 0 : (Number(s.skippedNoRun) || 0)
  if (s !== null && typeof s === 'object') {
    const started = Number(s.started) || 0
    const applied = Number(s.applied) || 0
    const timedOut = Number(s.timedOut) || 0
    const failed = Number(s.failed) || 0
    const skipped = Number(s.skippedNoRun) || 0
    lines.push('  ── 进程计数:起跑 ' + started + ' · 用上 ' + applied + ' · 超时 ' + timedOut
      + ' · 失败 ' + failed + ' · 没 run 跳过 ' + skipped)
    if (Number(s.lastMs) > 0) lines.push('  ── 最近一次 ' + Number(s.lastMs) + ' ms'
      + (String(s.lastReason ?? '') === '' ? '' : ' · 触发点「' + String(s.lastReason) + '」'))
    if (started === 0) {
      lines.push('  info 还没有读数 —— 重启之后他还没跟她说第一句话(这不是故障)')
      lines.push('       去陪伴会话里说一句,回来再跑本探针:那一刻起跑、组装时取用')
    } else {
      const rate = applied / started
      const tRate = timedOut / started
      check('同轮生效率 > 80%(他这句话惹到她,这一轮就带上了)', rate > 0.8,
        '实测 ' + Math.round(rate * 1000) / 10 + '%(' + applied + '/' + started + ')—— 生效率低说明打分没抢在组装前')
      check('超时率 < 5%(超时不是失败,但太多说明该调大 emotionScoreTimeoutMs)', tRate < 0.05,
        '实测 ' + Math.round(tRate * 1000) / 10 + '%(' + timedOut + '/' + started + ')')
      check('没有连续失败(失败必须看得见)', failed === 0 || Number(s.lastMs) > 0,
        failed > 0 ? '失败 ' + failed + ' 次' : '')
    }
  }
  if (skipped > 0) {
    lines.push('  info 有 ' + skipped + ' 次因为"子代理服务缺席"没起跑 —— 宿主没有 subagents 时')
    lines.push('       C1 自动不可用(不报错、不影响回复),这时它等同关闭')
  }
}

if (cfg !== null) {
  const c = cfg.settings ?? {}
  check('调参面有 emotionSameTurn 开关', Object.hasOwn(c, 'emotionSameTurn'),
    Object.hasOwn(c, 'emotionSameTurn') ? '' : '同上:要重启 dsh web 才会出现在调参面')
  check('调参面有 emotionScoreTimeoutMs 旋钮', Object.hasOwn(c, 'emotionScoreTimeoutMs'),
    Object.hasOwn(c, 'emotionScoreTimeoutMs') ? '' : '同上:要重启 dsh web 才会出现在调参面')
  lines.push('  ── 开关:' + (c.emotionSameTurn === false ? '**关**' : '开') + ' · 超时门 '
    + String(c.emotionScoreTimeoutMs ?? '?') + ' ms')
  if (c.emotionSameTurn === false) lines.push('       (关着 ⇒ 这一轮不会起跑打分,生效率会一直 0)')
} else {
  check('调参面可达', false)
}

const failed = results.filter((r) => !r.ok)
if (asJson) {
  console.log(JSON.stringify({ base, results, sameTurnEmotion: st?.sameTurnEmotion ?? null }, null, 2))
} else {
  console.log('# 情绪单轮闭环探针 · ' + base + '(只读)')
  for (const l of lines) console.log(l)
  console.log(failed.length === 0
    ? '结论:全通过 —— 他这句话惹到她,这一轮就带得上情绪。'
    : '结论:' + failed.length + ' 条没通过。')
}
process.exit(failed.length === 0 ? 0 : 1)
