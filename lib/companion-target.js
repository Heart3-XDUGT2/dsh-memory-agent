/**
 * dsh-echo — 「他正在用的那条会话」是谁(2026-09-29 他裁定 A)
 * ==================================================================
 * 他 2026-09-29 的原话:「不能把 QQ 会话锁在一个会话里…全平台所有会话全都
 * 统一在一个会话里面…dsh 内置的直接聊天会话和 QQ 所在的会话是同一个」;
 * 现场他看到的是:他在 DSH 里开着窗口 A 跟她说话,而 QQ 来的消息进了插件
 * 自建的那条 B(`session-echo-companion`)—— 她的回复于是出现在"隔壁窗口"。
 *
 * 裁定 A(他当天点的):**QQ 跟着他走** —— 他在哪条 DSH 会话里说话,QQ 的
 * 消息就进那条,她的回复也出现在那条;没有任何可用窗口时才退回陪伴会话
 * (建/续,`ensureCompanion`)。
 *
 * 判据(四条全都要成立才算"他在用的窗口"):
 *   · 活着 —— 宿主里那条会话的 agent 还在(否则注入不进去);
 *   · **顶层** —— 不是子代理会话(`lib/agent-scope.js` 的判据):她自己的
 *     打分子代理、提取子代理都在跑会话,它们不是"他在用";
 *   · **在范围内** —— 面板上关掉的会话不算(`sessionEnabled`);
 *   · 他最近在里面说过话 —— `lastUserTurnAt` 在 `since` 之后。
 * 多条成立时取**最近**的那一条。
 *
 * 为什么"最近说过话"能代表"他在用":GUI 每条窗口是一个会话,他跟她说话
 * 必然落在某个窗口里;窗口之间没有别的信号能区分"他在看哪个"。
 *
 * 这个模块是**纯函数**(不碰宿主、不碰库)⇒ 可离线测
 * (`tests/companion-target.test.js`);壳侧只负责把真数据喂进来
 * (`lib/index.js` 的 `hisActiveSession()`)。
 */

/** 陪伴会话的缺省 id(与 `lib/index.js` 的 `ensureCompanion` 同一口径)。 */
export const DEFAULT_COMPANION_ID = 'session-echo-companion'

/**
 * 在多条候选里挑出「他正在用的那条会话」。
 *
 * @param {object} args
 * @param {Array<{sessionId?: string, agent?: unknown, lastUserTurnAt?: number}>} args.candidates
 *        候选(通常来自宿主 `ctx.agents.roots()`;每条只要能读出 id 与"他最后说话的时刻")
 * @param {(sid: string) => boolean} [args.inScope]     面板范围闸(`sessionEnabled`)
 * @param {(agent: unknown) => boolean} [args.isTopLevel] 顶层会话判据(`isTopLevelSession`)
 * @param {string} [args.companionId] 陪伴会话 id(它**不参与**挑选:它是兜底,不是"他的窗口")
 * @param {number} [args.since] 他"最近说过话"的窗口下界(epoch 秒)
 * @returns {{sessionId: string, agent: unknown, lastUserTurnAt: number}|null}
 *          挑不出来回 `null`(调用方据此退回陪伴会话)
 */
export function pickHisSession ({ candidates, inScope, isTopLevel, companionId, since } = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  const scopeOk = typeof inScope === 'function' ? inScope : () => true
  const topOk = typeof isTopLevel === 'function' ? isTopLevel : () => true
  const companion = String(companionId ?? DEFAULT_COMPANION_ID)
  const floor = Number(since)
  let best = null
  for (const c of list) {
    if (c === null || typeof c !== 'object') continue
    const sid = String(c.sessionId ?? '')
    if (sid === '') continue
    // 陪伴会话不参与:"他的窗口"与"插件自己的会话"是两种东西
    // (后者由 ensureCompanion 兜底,见 resolveCompanion)
    if (sid === companion) continue
    if (c.agent === undefined || c.agent === null) continue
    if (!topOk(c.agent)) continue
    if (!scopeOk(sid)) continue
    const at = Number(c.lastUserTurnAt) || 0
    if (!Number.isFinite(floor) || at <= floor) continue
    if (best === null || at > best.lastUserTurnAt) {
      best = { sessionId: sid, agent: c.agent, lastUserTurnAt: at }
    }
  }
  return best
}

/** 路由来源 → 一句人话(审计行与状态面共用一处,免得两边漂)。 */
export function describeRoute (via) {
  const v = String(via ?? '')
  if (v === 'his-window') return '他在用的那条会话'
  if (v === 'companion') return '陪伴会话(兜底)'
  if (v === 'fixed') return '固定陪伴会话(面板关掉了"跟着他走")'
  return '陪伴会话'
}
