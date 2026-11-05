/**
 * 被打断的残句(barge-in 方案 A:残句丢弃,但她知道)。
 *
 * A 侧出处:
 *   - 写入 `main.py:655`:`self._interrupted_tail[session_id] = _tail[:120]`
 *   - 读取 `brains/brain_pipeline.py:1234-1240`:`_tails.pop(session_id, "")`
 *     —— **读一次就消费**,并 `strip()[:120]`
 *   - 卸载清空 `main.py:262`:`self._interrupted_tail.clear()`
 *
 * 为什么单独一个模块:A 侧它是插件实例上的一个 dict,而 B 侧写入方在
 * `relay.js`(入站那一步)、读取方在 `context.js`(拼注入块),两个模块互相
 * import 会成环。这里只放一个 Map,谁都能用,谁也不依赖谁。
 *
 * 进程内存储,与 A 侧一致 —— 插件重载就丢。丢了的后果只是"她不知道上一轮
 * 被打断过",不会说错话(残句本来就没发出去)。
 */
const tails = new Map()

/** 记下一条残句(他刚插话,她没说完的那些字)。 */
export function rememberInterrupted (sessionId, tail, { max = 120 } = {}) {
  const sid = String(sessionId ?? '')
  const body = String(tail ?? '').trim()
  if (sid === '' || body === '') return ''
  const cut = body.slice(0, Math.max(1, Number(max) || 120))
  tails.set(sid, cut)
  return cut
}

/** 取走残句(读一次就消费,A 侧 `pop` 语义)。 */
export function takeInterrupted (sessionId) {
  const sid = String(sessionId ?? '')
  if (sid === '' || !tails.has(sid)) return ''
  const v = String(tails.get(sid) ?? '')
  tails.delete(sid)
  return v
}

/** 偷看(不消费)—— 只给诊断/测试用。 */
export function peekInterrupted (sessionId) {
  return String(tails.get(String(sessionId ?? '')) ?? '')
}

/** 卸载时清空(A 侧 `on_unload` 同款)。 */
export function clearInterrupted () {
  tails.clear()
}

// 2026-09-28 G5:`interruptedCount()` 删了 —— 全仓零引用(hygiene 第 2 段里唯一一条
// "只有声明、连自己文件都不用它"的)。残句的账由 `takeInterrupted(sid)` 自己报;
// 留一个"看着像仪表盘、其实没人查"的函数,只会让下一个读代码的人多绕一圈。
