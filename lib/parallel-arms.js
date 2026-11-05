/**
 * dsh-echo — **并行支接线**（2026-10-21）
 * ============================================================
 * ## 为什么有这个文件
 *
 * 原来这段逻辑内联在 `lib/index.js` 的 claim 回调里，两个**正交**的开关被写成了**嵌套**：
 *
 * ```
 * if (st.emotionSameTurn !== false) {        ← 外层
 *   const auditArm = …                       ← 只在这个块里有
 *   const t0Expand = Date.now()              ← 也只在这个块里有
 *   sameTurnEmotion.begin(…)
 *   if (st.recallExpand !== false) {         ← 内层
 *     queryExpander.begin({ onSettle: auditArm('query_expand', 22, t0Expand) })  ← 出作用域
 *   }
 * }
 * ```
 *
 * `auditArm` / `t0Expand` 在**外层块**里声明、在**内层块**里引用 —— 内层块是外层的子作用域，
 * 所以能解析。但真正的伤病是：**只要外层开关关掉，内层那一支就跟着一起死**，
 * 而那两个变量之所以能"跨块"用，纯粹因为它们碰巧在同一个父块里。
 *
 * 现场（`query_expand` 全库 0 行，拖了 11 天）就是这么来的：
 * 后来有人把扩展支**挪到了外层块的闭合之后**（它本来就该是平级的），
 * 于是 `auditArm` / `t0Expand` 真的出了作用域 ⇒ 每次 claim 都
 * `ReferenceError: auditArm is not defined`，而求值发生在构造 `begin()` 实参时
 * ⇒ **`queryExpander.begin()` 一次都没被调用**。
 * 同一个 `try` 里更早的 `sameTurnEmotion.begin` 在块内、变量都在作用域 ⇒ 它照常跑，
 * 所以只有扩展支死了，而且是**静默**的（错误进了 `ctx.logger.warn`，没人看）。
 *
 * ## 所以这里不"把变量提出来"，而是换形状
 *
 * 只把 `auditArm` / `t0Expand` 挪到 `if` 外面能修好这一次，但**下一次有人再加一个并行支，
 * 同一个病会再来一次**。抽成函数之后：
 *
 *   ① **两个开关平级判定**（`wantEmotion` / `wantExpand` 是兄弟，谁也不在谁的块里）；
 *   ② 每支的 `t0` 在**自己的块内**声明 ⇒ 另一支**结构上够不到**；
 *   ③ `onSettleOf` 是**注入进来的工厂**，每支自己调它拿 onSettle
 *      ⇒ 不需要任何跨块共享变量；
 *   ④ 每支**独立 try**，一支炸不带另一支。
 *
 * 想再加第三支？照抄一个 `if (wantX) { const t0 = now(); try { … } catch { … } }` 块就行 ——
 * **它天然引用不到别人的变量**，因为根本不存在"别人的块"。
 */

/**
 * 起这一轮的所有并行支。
 *
 * **永不抛。** 任何一支失败只记进 `errors` 并 `warn`，另一支照旧。
 *
 * @param {object} deps
 * @param {object|null} deps.st
 *        设置快照。`null` = 全用默认（两支都开）。
 * @param {string} deps.sid 会话 id；空串 ⇒ 一支都不起。
 * @param {object} deps.agent 宿主 agent（作为两支的 `parent` 透传）。
 * @param {object|null} deps.prev `store.getState()` 的结果（情绪支取 `emotionVector`）。
 * @param {string} deps.userText 这一轮他说的那句（两支共用）。
 * @param {{begin: Function}} deps.sameTurnEmotion 情绪打分器。
 * @param {{begin: Function}} deps.queryExpander 查询扩展器。
 * @param {(arm: string, step: number, t0: number) => Function} deps.onSettleOf
 *        审计工厂：给一支造一个 `onSettle` 回调。
 *        **由调用方注入** —— 本模块完全不知道 `store` / `turnTrace` / `randomUUID` 的存在，
 *        所以它能离线单测。
 * @param {() => number} [deps.now]
 * @param {(msg: string) => void} [deps.warn]
 * @returns {{emotion: boolean, expand: boolean, errors: string[]}}
 *          哪几支**真的起了**（测试与诊断用；失败的不算）
 */
export function startParallelArms (deps = {}) {
  const {
    st = null, sid = '', agent = null, prev = null, userText = '',
    sameTurnEmotion = null, queryExpander = null, onSettleOf = null
  } = deps
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const warn = typeof deps.warn === 'function' ? deps.warn : () => {}

  const out = { emotion: false, expand: false, errors: [] }
  const id = String(sid ?? '').trim()
  if (id === '') return out

  // ★ 两个开关**正交**：各判各的，谁也不嵌套在谁的块里。
  //   `emotionSameTurn` 只管情绪支，`recallExpand` 只管扩展支 ——
  //   这正是 2026-10 那次 bug 炸掉的契约。
  const wantEmotion = st === null || st.emotionSameTurn !== false
  const wantExpand = st === null || st.recallExpand !== false

  /** 单支失败的唯一出口：写清**是哪个支**、什么错，绝不上抛。 */
  const fail = (arm, err) => {
    const why = arm + ': ' + String((err && err.message) || err).slice(0, 140)
    out.errors.push(why)
    warn('echo: 并行支起跑失败（' + why + '）—— 这一支不跑，另一支照旧')
  }

  if (wantEmotion) {
    // ★ 自己的 t0，在自己的块里 —— 扩展支**够不到**它
    const t0 = now()
    try {
      sameTurnEmotion.begin(id, {
        userText,
        prevVector: (prev && prev.emotionVector) || null,
        parent: agent,
        onSettle: onSettleOf('same_turn_emotion', 21, t0)
      })
      out.emotion = true
    } catch (err) { fail('same_turn_emotion', err) }
  }

  if (wantExpand) {
    // ★ 同上：这条 t0 与上面那个**完全独立**（以前它们挤在一个块里共用一行）
    const t0 = now()
    try {
      queryExpander.begin(id, {
        userText,
        parent: agent,
        onSettle: onSettleOf('query_expand', 22, t0)
      })
      out.expand = true
    } catch (err) { fail('query_expand', err) }
  }

  return out
}
