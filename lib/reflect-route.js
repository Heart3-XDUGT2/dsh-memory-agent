/**
 * 反思直调通道的 **route 决议**(纯逻辑,2026-10-06 方案 C + B)。
 * ==========================================================
 * 现场(诊断:2026-10-06):方案 C 的直调通道要求面板手填 `llmProvider`/`llmModel`,
 * 而**这两个键默认是空的** ⇒ 每一轮反思都在通道第一道闸被 `skipped`(活状态面:
 * `llmSkipped=8`,其余四格全 0,5ms)。更糟的是运输口按"宿主 llm 服务在不在"选路
 * (`available()`),服务在 ⇒ **永远走直调、子代理退路一次都没接上** ⇒ 反思静默零产出
 * (35 小时没写进一条记忆,没人发现)。P2 那次 45 小时静默是同一个病。
 *
 * 所以这一版把"要人记得填"变成"默认就能跑",并把"静默"焊死:
 *   ① 面板配了 provider+model ⇒ 用它(**覆盖项**;想给反思单独配小模型时才填);
 *   ② 没配 ⇒ **继承本会话的 route**(宿主 `session/event` 的 `request/header`
 *      `header.config.provider/model` —— 与 `dsh-session-title-llm/lib/index.js:138-146`
 *      的 resolveRoute 同源);
 *   ③ 都没有(拿不到 route / 直调关了 / 宿主没有 llm 服务)⇒ **明确退回子代理**,
 *      并把**为什么**写进状态面(`reflectStats.lastNote`),面板看得见 —— 不许静默。
 *
 * 纪律:本模块**零 IO、零 ctx**;`index.js` 只做装配(读设置、拿 route、选路)。
 */

/** 宿主 `request/header` 事件里那条 route(取不到/不完整 ⇒ null)。 */
export function routeOfRequestHeader (event) {
  const d = (event !== null && typeof event === 'object' && event.data !== undefined) ? event.data : event
  if (d === null || typeof d !== 'object') return null
  const header = (d.header !== null && typeof d.header === 'object') ? d.header : null
  if (header === null) return null
  const cfg = (header.config !== null && typeof header.config === 'object') ? header.config : null
  if (cfg === null) return null
  const provider = String(cfg.provider ?? '').trim()
  const model = String(cfg.model ?? '').trim()
  if (provider === '' || model === '') return null   // 半个 route 不算 route(宿主自己也是成对要)
  return { provider, model }
}

/**
 * 这一趟反思走哪个 provider/model:面板覆盖优先,其次继承会话 route。
 * @returns {{provider: string, model: string, source: 'settings'|'session'|'none', note: string}}
 */
export function resolveReflectRoute ({ settings = {}, sessionRoute = null } = {}) {
  const p = String(settings.llmProvider ?? '').trim()
  const m = String(settings.llmModel ?? '').trim()
  if (p !== '' && m !== '') {
    return { provider: p, model: m, source: 'settings', note: '反思直调:用面板配的 provider/model(覆盖会话 route)' }
  }
  const sp = String(sessionRoute?.provider ?? '').trim()
  const sm = String(sessionRoute?.model ?? '').trim()
  if (sp !== '' && sm !== '') {
    return { provider: sp, model: sm, source: 'session', note: '反思直调:继承本会话 route(' + sp + '/' + sm + ')' }
  }
  return { provider: '', model: '', source: 'none', note: '未配 llmProvider/llmModel,也拿不到本会话的 route' }
}

/**
 * 选运输口:**配不齐就退回子代理**,而不是原地跳过。
 * @returns {{mode: 'llm'|'subagents'|'none', route: {provider: string, model: string}|null, note: string}}
 */
export function chooseReflectTransport ({ settings = {}, sessionRoute = null, llmAvailable = false, subagentsAvailable = false } = {}) {
  const directEnabled = settings.llmDirectEnabled !== false
  const route = resolveReflectRoute({ settings, sessionRoute })
  if (directEnabled && llmAvailable === true && route.source !== 'none') {
    return { mode: 'llm', route: { provider: route.provider, model: route.model }, note: route.note }
  }
  const why = directEnabled === false
    ? '直调开关关(llmDirectEnabled=false)'
    : (llmAvailable !== true ? '宿主没有 llm 服务' : route.note)
  if (subagentsAvailable === true) {
    return { mode: 'subagents', route: null, note: '反思退回子代理:' + why }
  }
  return { mode: 'none', route: null, note: '反思本轮不跑:' + why + ',且子代理不可用' }
}
