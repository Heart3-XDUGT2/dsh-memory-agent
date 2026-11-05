/**
 * F4 插入优先级四档 —— 她**正在说话**时,来的事件怎么插队。
 *
 * 出处 neuro-sdk `API/SPECIFICATION.md:160`(`priority` 参数):
 *   `low`      = 等她说完成再回应(默认)
 *   `medium`   = 让她**尽快说完**当前这句
 *   `high`     = 立刻处理:缩短她这句话,然后回应
 *   `critical` = **打断**她的话,马上回应(原文提示:慎用,会很突兀)
 * 原文还有一句关键限定:**她不在说话时,这个参数没有任何作用。**
 *
 * 落到我们的机器上,"说话"不是声波,是 `relay_outbox` 里**还没发出去的气泡**
 * (`group_id != ''`、`kind = 'reply'`、未送达/未作废)。四档于是正好映射到
 * 我们手上已有的三件工具:
 *   · 等他**说完成**  = 新事件入队的 `notBefore` 排到**最后一泡之后**;
 *   · **尽快说完**    = `notBefore` 只排在**当前那一泡之后**;
 *   · **缩短**        = 取消她**还没发出去**的泡(`store.relayCancelBubbles`),残句留给她下一轮,立刻发;
 *   · **打断**        = 同上,但连"当前这一泡发完"都不等(立刻入队、不等节拍)。
 * 已经递到适配器手里的那一泡**不撤回**(真人被插嘴,说出去的话也收不回 —— 与 barge-in 同一条纪律)。
 */

/** 上游的四个 priority 名(照抄,不另起名)。 */
export const PRIORITY_LEVELS = ['low', 'medium', 'high', 'critical']

/** priority ⇒ 我们这一侧的四档动作。 */
export const TIER_OF_PRIORITY = {
  low: 'wait',
  medium: 'finish-soon',
  high: 'shorten',
  critical: 'interrupt'
}

export const TIERS = ['wait', 'finish-soon', 'shorten', 'interrupt']

/** 不在说话时:优先级不生效(上游原话),一律按"直接发"。 */
export const TIER_IDLE = 'immediate'

/**
 * 默认分配(**谁更急**,理由写在每一行上;他能用 `insertPriority` 覆盖):
 *   · `reply`    他说话了 = high。他是主人,她说一半也该**缩短**去接他的话;
 *                但**不用 critical** —— 强行打断她正在发的那一泡会很突兀,
 *                而且他的新消息本来就会走 barge-in(残句留给她下一轮认账)。
 *   · `reminder` 他下的提醒到点 = medium:到点就该说,但不必把气泡砍断。
 *   · `wake`     她自己的闹钟到点 = medium:同上(她自己在意的时刻,不该被无限期排队)。
 *   · `care`     想念关怀 = low:等她说完成 —— 关怀插在她说一半时最像"打断"。
 *   · `event`    外部事件 = low:默认不急(将来的语音平台可以自带 priority)。
 */
export const DEFAULT_PRIORITY = {
  reply: 'high',
  reminder: 'medium',
  wake: 'medium',
  care: 'low',
  event: 'low'
}

export const INSERT_KINDS = Object.keys(DEFAULT_PRIORITY)

/** 他填的覆盖表:`care=medium, wake=low`(认不出来的键与档位**忽略**,不报错)。 */
export function parsePriorityOverrides (raw) {
  const out = {}
  for (const piece of String(raw ?? '').split(/[,，、;；\n\r\t]+/)) {
    const s = piece.trim()
    if (s === '') continue
    const i = s.indexOf('=')
    if (i <= 0) continue
    const k = s.slice(0, i).trim()
    const v = s.slice(i + 1).trim().toLowerCase()
    if (!INSERT_KINDS.includes(k)) continue
    if (!PRIORITY_LEVELS.includes(v)) continue
    out[k] = v
  }
  return out
}

/** 这个 kind 现在是哪一档(覆盖表优先,认不出来回落默认;都不认识 ⇒ low)。 */
export function priorityOf (kind, overrides = null) {
  const k = String(kind ?? '')
  const ov = overrides !== null && typeof overrides === 'object' ? overrides : {}
  const v = ov[k]
  if (PRIORITY_LEVELS.includes(String(v ?? '').toLowerCase())) return String(v).toLowerCase()
  if (PRIORITY_LEVELS.includes(DEFAULT_PRIORITY[k])) return DEFAULT_PRIORITY[k]
  return 'low'
}

/**
 * 决定这一件事该怎么插。`speaking` = 她的气泡还在队列里(还没发完)。
 * 返回 `tier`(四档 / `immediate`)、是否要砍掉她没发出去的泡(`cutRemaining`)、
 * 以及 `notBeforeAt`('now' | 'after-current' | 'after-all')—— 壳照它算入队时刻。
 */
export function decideInsertion ({ kind = 'care', speaking = false, overrides = null, priority = null } = {}) {
  const given = PRIORITY_LEVELS.includes(String(priority ?? '').toLowerCase())
    ? String(priority).toLowerCase()
    : null
  const p = given ?? priorityOf(kind, overrides)
  if (speaking !== true) {
    return {
      kind: String(kind),
      priority: p,
      tier: TIER_IDLE,
      cutRemaining: false,
      notBeforeAt: 'now',
      reason: '她没在说话 —— 按上游规矩,优先级不生效,直接发'
    }
  }
  const tier = TIER_OF_PRIORITY[p]
  return {
    kind: String(kind),
    priority: p,
    tier,
    cutRemaining: tier === 'shorten' || tier === 'interrupt',
    notBeforeAt: tier === 'wait' ? 'after-all' : (tier === 'finish-soon' ? 'after-current' : 'now'),
    reason: '她正在说话(队列里还有泡)+ 这件事是 ' + p + ' ⇒ ' + tier
  }
}

/** 入队时刻(秒)。`gap` 是插队事件与她说的话之间留的那口气。 */
export function notBeforeFor ({ tier = TIER_IDLE, now = 0, currentNotBefore = 0, lastNotBefore = 0, gap = 0.4 } = {}) {
  const t = Number(now)
  if (!Number.isFinite(t) || t <= 0) return 0 // 时间都给不出来 ⇒ 立刻发,不编一个时刻
  const g = Number.isFinite(Number(gap)) ? Math.max(0, Number(gap)) : 0.4
  if (tier === 'wait') return Math.max(t, (Number(lastNotBefore) || 0) + g)
  if (tier === 'finish-soon') return Math.max(t, (Number(currentNotBefore) || 0) + g)
  return t
}
