/**
 * dsh-echo — 硬开关工具(2026-09-26 现场)
 * ============================================================
 * 他问的原话:「你是一个工作的 agent,为什么我跟你说 Echo 下线,你还在
 * 使用 Echo 插件?……你应该搞一个硬性的按钮出来。」
 *
 * 现场三条根因(都已核实):
 *   ① 我手上**根本没有**「关她」这只手 —— 工具列表里没有开关,于是他说
 *      「跟 agent 说」时,agent 无事可做(这是上一版的错答);
 *   ② 唯一的会话内路径要求**整条消息正好等于**「echo下线」,说「Echo
 *      下线吧」不匹配,而且**不匹配时一声不吭**(静默失败);
 *   ③ 就算写进去,`autoScope()` 会被下一条入站消息静默覆盖回来。
 *
 * 本文件给的是 ①:两只硬开关的手,与面板/仪表盘写**同一份 config**。
 *   echo_power  总闸(在线/休眠)—— 等价于 A 侧的电源开关
 *   echo_scope  分闸(某个会话 / 全局模式 / 硬开关名单)
 *
 * 纪律:开关是运行时偏好,不是安全边界 —— 读失败 fail-soft 向「被召唤」
 * 一侧倒;但**写失败必须说清**(她不能以为自己关上了而其实没关)。
 */

import { isSubagentSession } from './agent-scope.js'

/** 把参数里的布尔说清楚 —— 字符串 'false' / 0 / 'off' 都要能表达"关"。 */
function asBool (v) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const s = String(v ?? '').trim().toLowerCase()
  if (['1', 'true', 'on', 'yes', 'y', '开', '在线', '上线'].includes(s)) return true
  if (['0', 'false', 'off', 'no', 'n', '关', '休眠', '下线'].includes(s)) return false
  return null
}

const scopeShape = {
  scope: { type: 'string' },
  whitelist: { type: 'array', items: { type: 'string' } },
  exempt: { type: 'array', items: { type: 'string' } },
  manualOff: { type: 'array', items: { type: 'string' } }
}

/**
 * 硬开关工具族。
 *
 * @param {{
 *   readPower?: () => {enabled: boolean, by?: string, at?: number},
 *   setPower?: (on: boolean, by: string) => boolean,
 *   readScope?: () => object,
 *   setScope?: (scope: string, by: string) => object,
 *   setSessionOn?: (sid: string, on: boolean) => object,
 *   sessionEnabledOf?: (sid: string) => boolean,
 *   currentSessionId?: () => string
 * }} deps
 * @returns {object[]} 工具定义(交给宿主的 defineTool)
 */
export function powerToolDefinitions ({
  readPower, setPower, readScope, setScope, setSessionOn, sessionEnabledOf, currentSessionId
} = {}) {
  const canWrite = typeof setPower === 'function' && typeof setScope === 'function' &&
    typeof setSessionOn === 'function'
  const pick = (out) => {
    const o = out !== null && typeof out === 'object' ? out : {}
    const v = {
      ok: o.ok === true,
      code: String(o.code ?? (o.ok === true ? 'ok' : 'error')),
      enabled: o.enabled === true,
      text: String(o.text ?? '')
    }
    if (o.by !== undefined) v.by = String(o.by || '')
    if (Number.isFinite(Number(o.at))) v.at = Number(o.at)
    if (typeof o.sessionId === 'string') v.sessionId = o.sessionId
    if (o.sessionOn === true || o.sessionOn === false) v.sessionOn = o.sessionOn
    if (o.scope !== null && typeof o.scope === 'object') {
      v.scope = {
        scope: String(o.scope.scope || ''),
        whitelist: Array.isArray(o.scope.whitelist) ? o.scope.whitelist.map(String) : [],
        exempt: Array.isArray(o.scope.exempt) ? o.scope.exempt.map(String) : [],
        manualOff: Array.isArray(o.scope.manualOff) ? o.scope.manualOff.map(String) : []
      }
    }
    return v
  }
  const stateText = (p) => {
    const who = p.by ? '(由 ' + p.by + ' 拨的)' : ''
    return p.enabled ? 'Echo 在线' + who : 'Echo 休眠中' + who
  }

  const powerResultSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      code: { type: 'string' },
      enabled: { type: 'boolean' },
      by: { type: 'string' },
      at: { type: 'number' },
      text: { type: 'string' },
      scope: { type: 'object', additionalProperties: false, properties: scopeShape }
    }
  }
  const scopeResultSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      code: { type: 'string' },
      text: { type: 'string' },
      sessionId: { type: 'string' },
      sessionOn: { type: 'boolean' },
      enabled: { type: 'boolean' },
      scope: { type: 'object', additionalProperties: false, properties: scopeShape }
    }
  }

  const readState = () => {
    let p = { enabled: true, by: '', at: 0 }
    try { if (typeof readPower === 'function') p = { ...p, ...(readPower() || {}) } } catch { /* 读不到按在线 */ }
    let s = null
    try { if (typeof readScope === 'function') s = readScope() } catch { /* 读不到就不带 */ }
    return { p, s }
  }

  /**
   * 调用方是谁(v0.42.0 审计修复 P1)。
   *
   * 为什么必须有:这两只工具**全局注册**,任何会话的 agent(以及子代理)都
   * 看得见 —— 于是模型能自己把总闸打开(他亲手关掉的硬关等于白关);而且原来
   * 「当前会话」取的是壳里那个 `routeAgent`(= **最后说过话**的顶层会话),
   * 从别的会话调 `echo_scope` 会改到另一条会话身上去。
   *
   * 判据归 `lib/agent-scope.js`(与 v0.41.0 子代理递归闸同一份,纯函数可离线测);
   * 调用方会话 id 走宿主契约 `exec.agent.session.id`(与 context-clear.js 同款。
   * 宿主契约:`dsh-tools` 的 `ToolRunContext.agent` = 「The calling agent」)。
   */
  const callerOf = (exec) => {
    const agent = exec?.agent ?? null
    let sid = ''
    try { sid = String(agent?.session?.id ?? '') } catch { sid = '' }
    return { sid, subagent: isSubagentSession(agent) }
  }

  return [
    {
      name: 'echo_power',
      description: '硬开关:让 Echo 立刻上线或休眠(总闸,管所有会话)。休眠 = 她不注入人格与记忆、不捕获对话、不反思、不主动开口 —— '
        + '插件本体和这只开关本身不受影响,所以随时能再唤醒。他明确让你「下线 / 别说话 / 休眠」时用这个,'
        + '而不是只在嘴上答应;他会看到面板上的状态真的变了。',
      parameters: {
        on: { type: 'boolean', description: 'true = 上线,false = 休眠', required: true },
        reason: { type: 'string', description: '可选:为什么拨(会写进审计,便于事后追问)' }
      },
      output: {
        schema: powerResultSchema,
        render: (args, v) => [{
          type: 'text',
          text: v.ok === true ? stateText(v) + (v.text ? '(' + v.text + ')' : '')
            : '开关没拨成(' + v.code + '):' + v.text
        }]
      },
      execute: async (args, exec) => {
        const on = asBool(args?.on)
        if (on === null) return pick({ ok: false, code: 'bad-arg', text: 'on 要 true/false。' })
        // v0.42.0 审计修复(P1):总闸**不许从子代理里拨**。子代理是「她自己
        // 内部的活」(EXTRACT / 打分 / 整理),它不是他本人 —— 它没有资格改她
        // 的电源状态,更没有资格把他亲手关掉的硬关再打开。
        const caller = callerOf(exec)
        if (caller.subagent) {
          return pick({ ok: false, code: 'subagent-refused', text: '子代理不许拨总闸 —— 这条要在他本人的会话里说。' })
        }
        if (typeof setPower !== 'function') return pick({ ok: false, code: 'no-service', text: '插件没接上电源开关。' })
        try {
          const enabled = setPower(on, 'tool')
          return pick({
            ok: true, code: on ? 'online' : 'asleep', enabled, by: 'tool',
            at: Math.floor(Date.now() / 1000),
            text: on ? '她醒了。' : '她睡了(总闸关)。'
          })
        } catch (err) {
          // 写失败必须说清:她不能以为自己关上了而其实没关
          return pick({ ok: false, code: 'write-failed', text: '开关没落到盘上:' + String(err?.message ?? err) })
        }
      }
    },
    {
      name: 'echo_scope',
      description: '硬开关的「分闸」:管哪个会话里 Echo 生效。不带 sessionId = 当前这条会话;'
        + '带 scope 可切全局模式(all 全部会话 / whitelist 只白名单)。'
        + '关掉某个会话 = 进硬开关名单,autoScope 之后**再也不会自动把它打开**。'
        + '他要「这条会话别让她看 / 只让 QQ 上那条生效」时用这个。',
      parameters: {
        sessionId: { type: 'string', description: '可选:哪条会话(留空 = 当前这条)' },
        on: { type: 'boolean', description: '可选:true = 这个会话上线,false = 下线' },
        scope: { type: 'string', description: '可选:切模式 —— all | whitelist(与 on 二选一)' }
      },
      output: {
        schema: scopeResultSchema,
        render: (args, v) => {
          if (v.ok !== true) return [{ type: 'text', text: '范围没改(' + v.code + '):' + v.text }]
          const parts = []
          if (v.sessionId) parts.push('会话 ' + v.sessionId + ' → ' + (v.sessionOn ? '开' : '关'))
          if (v.scope) {
            parts.push('模式=' + v.scope.scope
              + ',白名单=[' + v.scope.whitelist.join(' ') + ']'
              + ',例外=[' + v.scope.exempt.join(' ') + ']'
              + ',硬关=[' + v.scope.manualOff.join(' ') + ']')
          }
          return [{ type: 'text', text: parts.join(';') || '没变' }]
        }
      },
      execute: async (args, exec) => {
        if (!canWrite) return pick({ ok: false, code: 'no-service', text: '插件没接上范围开关。' })
        // v0.42.0 审计修复(P1):分闸同样不许从子代理里拨(同 echo_power 的理由)
        const caller = callerOf(exec)
        if (caller.subagent) {
          return pick({ ok: false, code: 'subagent-refused', text: '子代理不许改范围 —— 这条要在他本人的会话里说。' })
        }
        const wantScope = String(args?.scope ?? '').trim()
        try {
          if (wantScope !== '') {
            const s = setScope(wantScope, 'tool')
            return pick({ ok: true, code: 'scope', scope: s, text: '模式切到 ' + String(s?.scope || '') })
          }
          const asked = String(args?.sessionId ?? '').trim()
          // v0.42.0 审计修复(P1):不带 sessionId 时用**调用方自己的会话**
          // (exec.agent.session.id),不再用壳里那个 routeAgent —— 后者是
          // 「最后说过话的顶层会话」,从别的会话调就会改错会话。
          // 宿主没给 exec(离线电池/异常)才退回 routeAgent 那条老路。
          const sid = asked !== ''
            ? asked
            : (caller.sid !== ''
                ? caller.sid
                : String((typeof currentSessionId === 'function' ? currentSessionId() : '') || ''))
          if (sid === '') return pick({ ok: false, code: 'no-session', text: '没拿到会话 id。' })
          const on = asBool(args?.on)
          if (on === null) return pick({ ok: false, code: 'bad-arg', text: '要给我 on,或者 scope。' })
          const s = setSessionOn(sid, on)
          let sessionOn = null
          try { sessionOn = typeof sessionEnabledOf === 'function' ? sessionEnabledOf(sid) === true : null } catch { sessionOn = null }
          const out = { ok: true, code: on ? 'session-on' : 'session-off', sessionId: sid, scope: s, text: on ? '开了' : '关了' }
          if (sessionOn !== null) out.sessionOn = sessionOn
          return pick(out)
        } catch (err) {
          return pick({ ok: false, code: 'write-failed', text: '范围没落到盘上:' + String(err?.message ?? err) })
        }
      }
    }
  ]
}
