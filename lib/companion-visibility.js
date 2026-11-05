/**
 * 「这条会话在网页上看得见吗」—— 兜底会话选择的**纯规则**。
 *
 * 为什么单独成一个文件:2026-10-01 的现场 bug(重启后第一条 QQ 消息**静默**落进
 * 一条**已归档、网页里一处都看不见**的会话,他在 GUI 里再也找不到那次对话)就长在
 * 这套规则上。它必须能被单测直接钉住,而不是藏在 `index.js` 的两千行里。
 *
 * 三条规则:
 *   1. **归档集读不到 ⇒ `null` = 不知道**。调用方按"能用"处理(不阻断旧行为),
 *      但**绝不退化成空集** —— 空集会让"已归档"判定恒为假,那个坑静默复发。
 *   2. 候选 = 工作区**登记过**、且不在归档集里的会话(去重、保序)。
 *   3. 替身挑选顺序 = ①他正在用的那条(仍须可见) ②候选里"他最后说话最晚"的
 *      ③候选里最后一条;挑不出来 ⇒ `null`(调用方必须**明确失败**,不许静默)。
 *
 * 输入形状(`$DSH_HOME/storages/workspace.json` 实测):
 * ```json
 * { "global": { "archivedSessionIds": ["session-…"] },
 *   "tables": { "workspaces": { "<wsId>": { "sessionIds": ["session-…"] } } } }
 * ```
 */

/**
 * 归档集。坏形状/缺字段 ⇒ `null`(**不知道**,不是空集)。
 * @param {unknown} raw 解析后的 workspace.json
 * @returns {Set<string>|null}
 */
export function parseArchivedIds (raw) {
  const ids = raw?.global?.archivedSessionIds
  if (!Array.isArray(ids)) return null
  return new Set(ids.filter((x) => typeof x === 'string' && x !== ''))
}

/**
 * 工作区里登记过的会话 id(扁平化,保序,不在此去重 —— 交给候选函数)。
 * @param {unknown} raw 解析后的 workspace.json
 * @returns {string[]}
 */
export function parseWorkspaceSessionIds (raw) {
  const table = raw?.tables?.workspaces
  if (table === null || typeof table !== 'object') return []
  const out = []
  for (const ws of Object.values(table)) {
    if (!Array.isArray(ws?.sessionIds)) continue
    for (const sid of ws.sessionIds) if (typeof sid === 'string' && sid !== '') out.push(sid)
  }
  return out
}

/**
 * 读并解析 workspace.json。读不到/坏 JSON ⇒ `{ archived: null, sessionIds: [] }`
 * (归档那一路是"不知道",不是"空")。
 * @param {string} path
 * @param {(p: string, enc: string) => string} readFile 注入进来 ⇒ 单测不用碰磁盘
 * @returns {{ archived: Set<string>|null, sessionIds: string[] }}
 */
export function readWorkspaceState (path, readFile) {
  try {
    const raw = JSON.parse(readFile(path, 'utf8'))
    return { archived: parseArchivedIds(raw), sessionIds: parseWorkspaceSessionIds(raw) }
  } catch { return { archived: null, sessionIds: [] } }
}

/**
 * 候选可见会话:排除 `exclude`,去掉归档的,去重保序。
 * @param {string[]} sessionIds
 * @param {Set<string>|null} archived
 * @param {string} [exclude]
 * @returns {string[]}
 */
export function visibleCandidates (sessionIds, archived, exclude = '') {
  const out = []
  const seen = new Set()
  for (const sid of sessionIds) {
    if (sid === exclude || seen.has(sid)) continue
    if (archived !== null && archived.has(sid)) continue
    seen.add(sid)
    out.push(sid)
  }
  return out
}

/**
 * 挑一条替身会话。
 * @param {object} input
 * @param {string[]} input.sessionIds 工作区登记过的会话
 * @param {Set<string>|null} input.archived 归档集(见上:null = 不知道)
 * @param {string} [input.exclude] 不可用的那条(通常就是被归档的兜底会话)
 * @param {string|null} [input.preferred] 他正在用的那条(优先,但必须可见)
 * @param {((sid: string) => number)|null} [input.lastTurnAt] 取"他最后说话时间"
 * @returns {string|null} null = 挑不出来(调用方明确失败)
 */
export function pickVisibleSession ({ sessionIds, archived, exclude = '', preferred = null, lastTurnAt = null }) {
  const usable = (sid) => typeof sid === 'string' && sid !== '' && sid !== exclude
    && (archived === null || !archived.has(sid))
  if (usable(preferred)) return preferred
  const pool = visibleCandidates(sessionIds, archived, exclude)
  if (pool.length === 0) return null
  let best = pool[pool.length - 1]
  if (typeof lastTurnAt === 'function') {
    // ★ 账本读不到(全是 0 / 抛错)时必须**退到末尾那条** —— 早先写成"bestAt 从 -1
    // 开始",于是第一条 0 也算"更晚",最后一个候选反而永远选不上。
    let bestAt = 0
    let sawTime = false
    for (const sid of pool) {
      let at = 0
      try { at = Number(lastTurnAt(sid)) || 0 } catch { at = 0 }
      if (at <= 0) continue
      sawTime = true
      if (at > bestAt) { bestAt = at; best = sid }
    }
    if (!sawTime) best = pool[pool.length - 1]
  }
  return best
}
