/**
 * v0.36.0 B2:一轮一个 trace —— 让"这一轮到底发生了什么"能**串起来查**。
 *
 * 现场:`audit_logs.trace_id` 一直是**每行一个随机 uuid**(`lib/reflect.js:347`、
 * `lib/index.js` 各处、渠道审计…),于是这一轮的行彼此无从关联。想回答
 * "他 14:24 那句话,她读了哪些记忆、调了哪些工具、她怎么回的、心情怎么变的",
 * 只能靠时间戳猜 —— 同一秒里可能有好几行。
 *
 * 做法:一次「他开口」= 一轮 ⇒ `begin(sid)` 换一个新的 trace id;这一轮里所有
 * 写审计的地方**先问它**(`of(sid)`),拿不到再退回各自的新 uuid(老行为)。
 * 于是:一轮的行共用一个 `trace_id`,聚合查询一行 SQL 就能把整轮拉出来。
 *
 * 纪律:
 *   - **不过期就永远算"这一轮"**:所以带 TTL(默认 30 分钟)兜底 —— 他走了、
 *     会话挂着不动,旧 trace 不许把几小时后的一轮并进来(那比不串更误导);
 *   - 只存内存:插件重启/重载 = 从新开始,历史行照旧按原样留在库里;
 *   - 纯函数式(时间与 uuid 都可注入),离线可测。
 */
import { randomUUID } from 'node:crypto'

export const TURN_TRACE_TTL_MS = 30 * 60 * 1000

export function createTurnTrace ({ now = () => Date.now(), ttlMs = TURN_TRACE_TTL_MS, uuid = () => randomUUID() } = {}) {
  const live = new Map() // sid → { id, at }
  const stats = { rotated: 0, expired: 0, asked: 0, hit: 0 }

  /** 他开口了(或她主动开口了):换一轮,返回新的 trace id。 */
  function begin (sessionId) {
    const sid = String(sessionId ?? '')
    if (sid === '') return ''
    const id = String(uuid())
    live.set(sid, { id, at: now() })
    stats.rotated += 1
    return id
  }

  /** 这一轮(该会话)的 trace id;没有 / 过期了 ⇒ 空串(调用方退回老行为)。 */
  function of (sessionId) {
    const sid = String(sessionId ?? '')
    if (sid === '') return ''
    stats.asked += 1
    const e = live.get(sid)
    if (e === undefined) return ''
    if (now() - e.at > ttlMs) {
      live.delete(sid)
      stats.expired += 1
      return ''
    }
    stats.hit += 1
    return e.id
  }

  function forget (sessionId) {
    live.delete(String(sessionId ?? ''))
  }

  return { begin, of, forget, stats: () => ({ ...stats, live: live.size }) }
}
