/**
 * dsh-echo — 「清空她的上下文」的结果翻译 + 判据(纯函数,离线可测)
 * ============================================================
 * 现场(2026-09-26 他要一个「清空上下文」按钮):背景是她跑了一整天默认人格、
 * 历史里攒了一堆冷硬的旧回复,而模型的语域锚点会跟着那些旧回复走 —— 把上下文
 * 清掉,人设(已挪到 prompt 尾部)才有机会说话。
 *
 * **插件做不了「删历史」**:宿主 SessionSurface 的替换被来源校验锁着
 * (`assertProvenance` / `assertSystemHeadRewrite`),只给压缩用;而
 * `sessions.create()` 是「调用方 fiber 所有」且不进 agent 生命周期就**不落盘**。
 * 宿主给用户自己的手是 `/compact` —— `compaction.compactNow(agent, signal)`,
 * 它走 `selectCompactableRange(session, measure, **0**)`:把旧历史整段压成一条
 * 摘要(retain 0),旧消息从她的视野里彻底消失,而会话记录**仍在**(可追溯、
 * 可翻旧账)。这个按钮就是给那只手装个把手 —— 不自己造一套。
 */

import { isSubagentSession } from './agent-scope.js'

/**
 * 把压缩服务的「返回/异常」翻译成人话 + 一个稳定的 code(面板按 code 上色)。
 *
 * @param {{result?: {shadowedSeqs?: unknown[], shadowedTokenCount?: number}|null, error?: unknown}} input
 * @returns {{ok: boolean, code: string, text: string, shadowed?: number, tokens?: number}}
 */
export function clearOutcome ({ result = null, error = null } = {}) {
  if (error !== null && error !== undefined) {
    const msg = String(error?.message ?? error)
    const name = String(error?.name ?? '')
    if (/cancel|abort/i.test(msg) || /Abort/i.test(name)) {
      return { ok: false, code: 'cancelled', text: '中途取消了 —— 她的上下文没动。' }
    }
    if (/idle agent|no waking queued work|busy/i.test(msg)) {
      return { ok: false, code: 'busy', text: '她正忙(有没跑完的活)。等她这轮说完再点。' }
    }
    if (/not allowed|unsupported|no .*compaction/i.test(msg)) {
      return { ok: false, code: 'no-service', text: '宿主的压缩服务不认这次调用:' + msg }
    }
    return { ok: false, code: 'error', text: '清空失败:' + msg }
  }
  if (result === null || result === undefined) {
    // 宿主原话:「No compactable history yet.」——历史太短,或已经压过。
    return { ok: false, code: 'nothing', text: '宿主说这条会话没有可压的区间(历史太短,或已经压过一次了)。' }
  }
  const shadowed = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0
  const tokens = Number(result.shadowedTokenCount ?? 0)
  if (shadowed === 0) {
    return { ok: false, code: 'nothing', text: '宿主这次没有压掉任何旧历史。' }
  }
  return {
    ok: true,
    code: 'cleared',
    shadowed,
    tokens,
    text: '清掉了 ' + shadowed + ' 条旧历史(约 ' + tokens + ' tokens):她的视野里只剩系统提示 + 一条摘要。'
      + '会话记录没删,还能翻旧账。'
  }
}

/**
 * 面板/审计里用的短标签(纯函数)。
 * @param {string} code clearOutcome 的 code
 * @returns {string}
 */
export function clearLabel (code) {
  return ({
    cleared: '已清空',
    nothing: '没得清',
    busy: '她正忙',
    cancelled: '已取消',
    'no-service': '宿主无此服务',
    'no-agent': '会话没醒',
    error: '失败'
  })[String(code)] ?? '未知'
}

/**
 * 「清空上下文」这只手 —— 她**自己**也能清(2026-09-26 他要按钮时顺手给的:
 * 语气被旧回复带偏、或这条会话太长时,她自己能把旧历史压掉一截)。
 *
 * 零宿主依赖:真正干活的那只 `clear(sessionId)` 由 index.js 注入(它要
 * compaction / agents / sessionController 四个服务),这里只管 schema、
 * 参数校验与回话 —— 所以能在离线电池里被 defineTool 过一遍。
 *
 * @param {{clear?: (sessionId: string) => Promise<object>, sessionEnabledOf?: (sid: string) => boolean}} deps
 * @returns {object} 工具定义(交给宿主的 defineTool)
 */
export function contextClearToolDefinition ({ clear, sessionEnabledOf } = {}) {
  const pick = (out) => {
    const o = out !== null && typeof out === 'object' ? out : {}
    const v = {
      ok: o.ok === true,
      code: String(o.code ?? (o.ok === true ? 'cleared' : 'error')),
      text: String(o.text ?? '')
    }
    // 只带声明过的键:additionalProperties:false 漏一个就是整个工具输出被宿主拒掉
    if (Number.isFinite(Number(o.shadowed))) v.shadowed = Number(o.shadowed)
    if (Number.isFinite(Number(o.tokens))) v.tokens = Number(o.tokens)
    return v
  }
  return {
    name: 'echo_context_clear',
    description: '清空上下文:把这条会话的旧历史压成一条摘要,旧消息从你视野里消失,而会话记录不删(还能翻旧账)。'
      + '你被自己的旧回复带着走(语气跑偏)、或者这条会话太长快撑满时,用它。'
      + '清掉之后你会「不记得」这段对话的细节 —— 但记忆库里的记忆不受影响。',
    parameters: {
      sessionId: { type: 'string', description: '可选:要清哪条会话(留空 = 当前这条,也就是你正在说话的这条)' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          code: { type: 'string' },
          text: { type: 'string' },
          shadowed: { type: 'number' },
          tokens: { type: 'number' }
        }
      },
      render: (args, v) => [{
        type: 'text',
        text: v.ok === true ? '上下文清好了:' + String(v.text)
          : '没清成(' + String(v.code) + '):' + String(v.text)
      }]
    },
    execute: async (args, exec) => {
      // v0.42.0 审计修复(与 echo_power 同一族):子代理不许清上下文 ——
      // 它是「她自己内部的活」,不该动会话历史(它自己的会话短命,清它没意义;
      // 清别人的会话更是越权)。判据同一份:lib/agent-scope.js。
      if (isSubagentSession(exec?.agent ?? null)) {
        return pick({ ok: false, code: 'subagent-refused', text: '子代理不许清上下文 —— 这条要在他本人的会话里说。' })
      }
      const asked = String(args?.sessionId ?? '').trim()
      const sid = asked !== '' ? asked : String(exec?.agent?.session?.id ?? '')
      if (sid === '') return pick({ ok: false, code: 'no-agent', text: '没拿到会话 id,清不了。' })
      if (typeof sessionEnabledOf === 'function' && !sessionEnabledOf(sid)) {
        return pick({ ok: false, code: 'out-of-scope', text: '那条会话里 Echo 是关着的,不动它。' })
      }
      if (typeof clear !== 'function') return pick({ ok: false, code: 'no-service', text: '插件没接上清空的手。' })
      try {
        return pick(await clear(sid))
      } catch (err) {
        return pick({ ok: false, code: 'error', text: '清空失败:' + String(err?.message ?? err) })
      }
    }
  }
}
