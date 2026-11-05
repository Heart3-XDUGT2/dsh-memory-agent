/**
 * dsh-echo — 入站队列：**她忙着的时候，消息不丢，等下一轮**（2026-10-18）
 * ============================================================
 * 他拍的口径：「只修忙时排队」。
 *
 * 现场（journal 实测，500 行内）：
 *   非主人群消息 成功进轮 187 / **撞上她忙、重试耗尽 52**
 * 链路：
 *   `injectInbound` 用 `agent.runMaintenance(...)` 当**互斥锁**，而 DSH 侧
 *   `dsh-agent-loop/lib/index.js:823` 是
 *       `if (this.phase.kind !== "idle") throw new Error("already has active work")`
 *   ⇒ **抛错**（不是排队）⇒ 适配器重试 6 次 ≈ 22.5 秒 ⇒ 耗尽即丢。
 *
 * 但 DSH 的 inbox **本来就是无损队列**：
 *   · `agent.followup(msg)` → `inbox.splice('next-turn', …)` + `wakeDriver()`
 *   · `wakeDriver` 忙时直接 return（消息留在 inbox 里）
 *   · turn 收尾时 `dsh-agent-loop/lib/index.js:1035`
 *       `if (!this.inbox.hasPending) return false;  return true;`
 *     ⇒ **还有待处理消息就自己开下一轮**，把它消费掉。
 *
 * 所以"排队"这件事 DSH 已经做了，**卡住它的是我们自己那道互斥锁**。
 *
 * ⚠️ 那为什么还要这个模块？因为 `inbox` **没有上限**，而他要一个上限
 *   （"比如 50 条，防止无限堆积"）。所以消息先落在**我们自己的队列**里，
 *   再一条一条交给 DSH —— 上限由我们守，消费由 DSH 保证。
 *
 * ⚠️ 纪律：**只在内存**。插件重启 = 队列清空（与 `groupAwake` 同一条）。
 */

/** 默认上限：他拍的「比如 50 条」。 */
export const DEFAULT_INBOUND_QUEUE_LIMIT = 50
export const INBOUND_QUEUE_LIMIT_MIN = 1
export const INBOUND_QUEUE_LIMIT_MAX = 200

/**
 * 把配置值夹进合法区间。
 * @param {unknown} v
 * @returns {number}
 */
export function clampQueueLimit (v) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return DEFAULT_INBOUND_QUEUE_LIMIT
  if (n < INBOUND_QUEUE_LIMIT_MIN) return INBOUND_QUEUE_LIMIT_MIN
  if (n > INBOUND_QUEUE_LIMIT_MAX) return INBOUND_QUEUE_LIMIT_MAX
  return n
}

/**
 * 建一个入站队列（FIFO，满了丢**最旧**的）。
 *
 * 为什么丢最旧的而不是拒收新的：群里说话是持续的，最新的那句最有意义；
 * 留旧的、拒新的，等于她醒来读到的是"十分钟前的开场白却错过了刚问的问题"。
 *
 * @param {object} deps
 * @param {number|(() => number)} [deps.limit] 上限；给函数则**每次现读**（面板改了即生效）
 * @param {(level: string, msg: string, extra?: object) => void} [deps.log]
 * @param {() => number} [deps.now]
 */
export function createInboundQueue ({ limit = DEFAULT_INBOUND_QUEUE_LIMIT, log = () => {}, now = () => Date.now() } = {}) {
  const items = []
  const stats = { accepted: 0, taken: 0, dropped: 0 }

  const capOf = () => {
    const v = typeof limit === 'function' ? limit() : limit
    return clampQueueLimit(v)
  }

  /**
   * 入队。
   * @returns {{accepted: boolean, dropped: object|null, size: number, limit: number}}
   *          `dropped` 非空 = 这条**被挤掉**（队列满了，丢的是最旧那条）
   */
  function push (item) {
    const cap = capOf()
    if (item === null || item === undefined) return { accepted: false, dropped: null, size: items.length, limit: cap }
    items.push({ ...item, at: now() })
    stats.accepted += 1
    let dropped = null
    while (items.length > cap) {
      dropped = items.shift() ?? null
      if (dropped !== null) stats.dropped += 1
    }
    if (dropped !== null) {
      log('warn', 'echo: 入站队列满，丢掉最旧的一条', {
        limit: cap,
        droppedAt: dropped.at,
        droppedSender: String(dropped?.env?.senderName ?? ''),
        droppedMsgId: String(dropped?.env?.msgId ?? '')
      })
    }
    return { accepted: true, dropped, size: items.length, limit: cap }
  }

  /** 看队头（不取）。 */
  function peek () {
    return items.length > 0 ? items[0] : null
  }

  /** 取队头（取走）。 */
  function shift () {
    const v = items.shift()
    if (v !== undefined) stats.taken += 1
    return v ?? null
  }

  function size () { return items.length }
  function clear () { items.length = 0 }

  function status () {
    return { size: items.length, limit: capOf(), ...stats }
  }

  return { push, peek, shift, size, clear, status }
}
