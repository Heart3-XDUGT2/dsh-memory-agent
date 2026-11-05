/**
 * dsh-echo — 渠道无关的「她的嘴」(S1 · 核心抽象)
 * ============================================================
 * 今天的问题是:**出站被写死在桥对象上**。`lib/index.js:1490` 直接
 * `relay.captureSegment(...)`、`:1526` 直接 `relay.finishTurn(...)`,
 * 于是核心（人格/记忆/气泡/节奏）里渗着"桥"这个词 —— 换一条传输就要动核心。
 *
 * 这一步只做**解耦**,不改行为:
 *   - 核心从此只对 `speaker` 说话(`captureSegment` / `finishTurn` / `say`);
 *   - 今天唯一在跑的传输是 HTTP 桥(`lib/relay.js`),所以默认 `transport = 桥`,
 *     facade **只转发**:参数原样进、返回值原样出、异常照旧往上抛(调用点已有
 *     try/catch,行为逐字不变);
 *   - 新插件上线后,它可以 `registerChannel()` 当一个渠道,或整条接管 transport ——
 *     核心那边一行都不用再改(接缝契约见 `docs/QQ_BRIDGE_DIY_PLAN.md` §2.1)。
 *
 * S3-a(2026-09-28):往外长了一张**扇出面** —— 渠道插件可以 `onOutbound(fn)`
 *   订阅「她要说的话」(`notifyOutbound` 只在**真的入队了**那一刻喊:`finishTurn` 的
 *   `rows > 0` 或 `say()` 的 `sent > 0`),主包再用
 *   `ctx.provide('echo:relay', …)` 把它交给 `dsh-echo-qq`。默认 `transport = 桥`、
 *   没人订阅时 `notifyOutbound` 是**零操作** ⇒ 行为仍逐字不变。
 *
 * 边界(有意留白,不是漏):
 *   - `hasChannel()` 今天的定义**必须**与旧门 `relayEnabled()` 等价,否则
 *     「总闸关 / 没有渠道」两种情形下工具注册与提示词段会换行为 —— 那是 S3 切换时
 *     才动的判据,且要配专门验收。所以这里走 transport.status().enabled(= relay 的
 *     `gate()`),不是"有没有渠道行"。
 *   - `'global'`(没有渠道可归属时的归属地)保留字面量,收敛在这里的 NO_CHANNEL_SCOPE;
 *     表名/列名一个字不动(迁移脚本与审计证据链依赖)。
 *   - 群聊一律不收(v0.29.0 裁决):渠道行只认 `chatType === 'private'`。
 */

/** 没有渠道可归属时的归属地。字面量保留是为了兼容历史审计与审查台。 */
export const NO_CHANNEL_SCOPE = 'global'

/**
 * 提供给渠道插件的服务名/版本(cordis 服务 DI:`ctx.provide` / `ctx.get`)。
 * 消费端是 `dsh-echo-qq` 的 `lib/contract.js`,它那边也钉着同样的字面量
 * (两个仓各自一条测试钉住这一个名字 —— 跨仓没有共享常量,只能靠契约 + 钉子)。
 */
export const SERVICE_NAME = 'echo:relay'
export const SERVICE_VERSION = 1

/**
 * 契约的**版本区间**与**能力清单**(2026-09-28 加,见 `docs/PLAN_CORTICO_ADOPTION.md` §3A2)。
 *
 * 为什么是**区间**而不是单值:两个仓独立发布,拿单值做严格相等比较会把发布顺序锁死
 * (Cortico 就是这条路:`EXTENSION_API_VERSIONS` 不符即拒、**无兼容窗口**,一旦主包先发
 * 新版本,老消费端连启动都过不去)。所以:
 *   - 判定**以能力名为准**(消费端算 `requires - capabilities`);
 *   - 版本只做**文案**(提示该升谁),对更新的主包只 warning、不拒。
 *
 * `api.max` = "提供端说到第几版":1 = 老形状(version/inject/subscribeOutbound/ack/lease/status);
 * 2 = 加 `hello()`(契约自报)与 `selftest()`(干跑自检)。
 *
 * 对外面(尤其语音通道)的接口草案见 `docs/VOICE_INTERFACE_DRAFT.md`。
 */
export const SERVICE_API = Object.freeze({ min: 1, max: 2 })

/** 提供端**真的提供**的能力名。消费端按名字对账,不按版本号猜。 */
export const SERVICE_CAPABILITIES = Object.freeze([
  'inject', 'subscribeOutbound', 'ack', 'lease', 'registerChannel', 'status', 'selftest',
  // 2026-10-04:语音回执落账(单参 entry;契约 docs/voice-receipts.md)。
  // 能力名=方法名,判定以能力名为准 —— 只加不改,老消费端不看它照旧跑。
  'registerVoiceReceipt'
])

/**
 * 注入 form 的**渠道无关枚举**(plan §2.2 缝 2)。
 * 今天真正在用的字面量:`'relay'`(平台中继注入的人话)、`'care'`、`'reminder'`、
 * `'say_again'`、`'mind'`、`'snapshot'`。归一之后核心只认下面这四个,
 * **旧值 `'relay'` 保留为别名**(审查台 `web/app.js:641-697` 与历史审计行依赖它)。
 * 边界(有意):这一步只让**读判据**认两套;写入侧仍写 `'relay'`(S3 切换才动写入,要配验收)。
 */
export const FORM = Object.freeze({
  INBOUND: 'inbound',
  CARE: 'care',
  REMINDER: 'reminder',
  SAY_AGAIN: 'say_again'
})

/** 旧字面量 → 新枚举。别名只在这一处。 */
const FORM_ALIASES = Object.freeze({ relay: FORM.INBOUND })

/** 任意 form 字面量 → 归一后的枚举(认不出就原样返回,不猜)。 */
export function formOf (raw) {
  const v = String(raw ?? '').trim()
  return FORM_ALIASES[v] ?? v
}

/** 这个 form 是不是「他刚说的话」(今天 = 平台中继的人话与关怀轮)。 */
export function isHumanForm (raw) {
  const v = formOf(raw)
  return v === FORM.INBOUND || v === FORM.CARE
}

/** 一个渠道的形状(文档用;JS 不强制)。 */
export const CHANNEL_SHAPE = Object.freeze({
  name: 'string',
  send: '(payload) => Promise<{ok, error?}>',
  status: '() => object',
  targets: '() => array',
  close: '() => void'
})

/**
 * @param {object} opts
 * @param {object} [opts.logger]      有就报一句,没有也不影响
 * @param {object|null} [opts.transport] 今天 = `lib/relay.js` 的桥对象;可为 null(= 没有嘴)
 * @param {{ofSession:(sid:string)=>any[], all:()=>any[]}} [opts.channelView]
 *        渠道表的**只读视图**(由 index.js 注入 store 查询)—— speak.js 不认识 store
 */
export function createSpeaker ({ logger = null, transport = null, channelView = null } = {}) {
  const channels = new Map()
  const deliveredHooks = []
  const outboundHooks = []
  /** 「嘴一出现就叫我」的钩子(见 onRegistered —— 手不许被启动顺序决定)。 */
  const registeredHooks = []
  let disposed = false

  function warn (msg) {
    try { if (typeof logger?.warn === 'function') logger.warn('echo: ' + msg) } catch { /* 日志失败不绊流程 */ }
  }

  /** 注册一个渠道(新插件/未来传输用)。返回注销函数。 */
  function registerChannel (channel) {
    if (channel?.platform === 'qq-official' || channel?.name === 'qq-official') throw new Error('speak: reserved official platform')
    const name = String(channel?.name ?? '').trim()
    if (name === '') throw new Error('speak: registerChannel 需要 channel.name')
    channels.set(name, channel)
    // 第一个渠道进来的这一瞬:叫醒所有等着"嘴出现"的人(每只钩子只叫一次)。
    if (channels.size === 1) {
      for (const fn of registeredHooks.splice(0)) {
        try { fn() } catch { warn('registered 钩子抛错(不影响注册)') }
      }
    }
    return () => { channels.delete(name) }
  }

  /**
   * 「嘴一出现就叫我这句」—— **给她的那只手用**。
   *
   * 为什么需要它:2026-09-28 退役旧桥后,"她有嘴吗"从**配置**(总闸,启动那一刻
   * 就是 true)变成了**注册**(渠道插件晚几秒才自报家门)。而 `echo_qq_say`/
   * `echo_qq_call` 这两只工具**只能注册、没法注销** ⇒ 启动时判一次是不够的:
   * 判早了(最常见:宿主先起、渠道插件后到)手就永远不登记,可她那一轮的提示词
   * 是**动态**读 `hasChannel()` 的,还会让她"用 echo_qq_say 发" ⇒ 她会一直去试
   * 一只不存在的手,话全卡在手里。注册过就立刻回调,没注册就排队等(
   * 返回一个撤销函数)。
   */
  function onRegistered (fn) {
    if (typeof fn !== 'function') return () => {}
    if (hasRegisteredChannels()) {
      try { fn() } catch { warn('registered 钩子抛错(立刻回调那条路)') }
      return () => {}
    }
    registeredHooks.push(fn)
    return () => {
      const at = registeredHooks.indexOf(fn)
      if (at >= 0) registeredHooks.splice(at, 1)
    }
  }

  function unregisterChannel (name) {
    channels.delete(String(name ?? ''))
  }

  /**
   * 「她有嘴吗」—— 提示词段的门,以及那只手的动态开关。
   * 渠道注册了算有;没有注册的渠道时问 transport(它自己报 `enabled`)。
   *
   * ⚠️ 2026-09-28 之前这里还含一个"配置总闸"(`relayEnabled()`),旧桥退役后
   * 那个分支删了 —— 所以 `hasChannel()` 现在**在启动那一刻可能是 false**
   * (渠道插件晚几秒才注册)。谁要是用它决定"注册不注册什么东西",必须走
   * `onRegistered()`,不能只在启动判一次。
   */
  function hasChannel () {
    if (channels.size > 0) return true
    if (transport === null) return false
    try { return transport.status?.()?.enabled === true } catch { return false }
  }

  /**
   * 「有**注册的**渠道吗」—— **非递归**的那一半(S3-b 的切换要用它)。
   *
   * ⚠️ 别把 `hasChannel()` 接回 transport 的 `isEnabled`:那会
   * `relay.status() → gate() → isEnabled() → hasChannel() → transport.status() → …`
   * **无限递归**(没注册渠道时 hasChannel 会去问 transport)。要用就用这个。
   */
  function hasRegisteredChannels () {
    return channels.size > 0
  }

  /** 渠道一览:注册的渠道 + 传输自身(给面板/体检看)。 */
  function list () {
    const out = []
    for (const channel of channels.values()) {
      out.push({ name: String(channel.name), ...safeStatus(channel) })
    }
    if (transport !== null) out.push({ name: 'http', ...safeStatus(transport) })
    return out
  }

  function safeStatus (obj) {
    try {
      const st = obj?.status?.()
      return (st && typeof st === 'object') ? st : {}
    } catch (err) {
      // 一个渠道的 status() 炸了不该带倒整张表(面板还要能看见别的渠道)
      warn('渠道 status() 抛错:' + String(err?.message ?? err))
      return { error: 'status-failed' }
    }
  }

  // ---- 出站:今天全部转发给传输,行为逐字不变 ----

  /** 攒一个回合的碎片(`assistant/message` 可能来好几条)。 */
  function captureSegment (sessionId, text) {
    if (transport === null) return false
    return transport.captureSegment(sessionId, text)
  }

  /** 标这一轮是**她主动开口**(关怀/提醒),不是被搭话。 */
  function markProactive (sessionId) {
    if (transport === null) return false
    return transport.markProactive(sessionId)
  }

  /** 回合收尾:攒下的正文按渠道入队。返回值形状与 relay.finishTurn 一致。 */
  function finishTurn (sessionId, opts) {
    if (transport === null) return { queued: 0, channels: 0, chars: 0 }
    const r = transport.finishTurn(sessionId, opts)
    // 只有**真的写进了出站队列**才喊一嗓子(沉默/没渠道/超长丢弃都不喊)。
    // 喊出去的是"有活儿"而不是正文:渠道自己去自己的那条路上取行(与桥同一份账)。
    try {
      if (Number(r?.rows ?? 0) > 0) {
        notifyOutbound({
          kind: 'queued',
          sessionId: String(sessionId ?? ''),
          rows: Number(r.rows),
          queued: Number(r.queued ?? 0),
          scope: String(r.scope ?? ''),
          turnKind: String(opts?.kind ?? '')
        })
      }
    } catch { /* 喊不出去不影响入队本身 */ }
    return r
  }

  /** 她的手:`echo_qq_say` / `echo_qq_call` 落到这里。形状与 relay.say 一致。 */
  function say (args) {
    if (transport === null) {
      const kind = String(args?.mode ?? 'reply') === 'call' ? 'proactive' : 'reply'
      return { ok: false, reason: 'no-channel', sent: 0, kind, targets: [], chars: 0, scope: NO_CHANNEL_SCOPE }
    }
    const r = transport.say(args)
    try {
      if (Number(r?.sent ?? 0) > 0) {
        notifyOutbound({
          kind: 'sent',
          sessionId: String(args?.sessionId ?? ''),
          rows: Number(r.sent),
          queued: Number(r.sent),
          scope: String(r.scope ?? ''),
          turnKind: String(r.kind ?? '')
        })
      }
    } catch { /* 同上:喊不出去不影响入队 */ }
    return r
  }

  /**
   * 渠道订阅「她要说的话」(S3-a)。返回退订函数。
   * 钩子抛错**绝不影响**入队/销账本身(隔离 + 记账),与 onDelivered 同一条纪律。
   */
  function onOutbound (fn) {
    if (typeof fn !== 'function') return () => {}
    outboundHooks.push(fn)
    return () => {
      const i = outboundHooks.indexOf(fn)
      if (i >= 0) outboundHooks.splice(i, 1)
    }
  }

  /**
   * 有活儿了:逐个钩子(钩子之间互不牵连)。返回**叫醒成功**的钩子数
   * (抛错的那个被隔离并 warn 记账,不计入 —— 与 noteDelivered 同一把尺子)。
   * 没有订阅者 = 零操作(所以默认部署的行为逐字不变)。
   * 钩子是**同步**调用的:它该做的就是"叫一声",别在这里做网络 IO(那条在渠道自己那边)。
   */
  function notifyOutbound (payload) {
    if (outboundHooks.length === 0) return 0
    let fired = 0
    for (const fn of [...outboundHooks]) {
      try { fn(payload); fired += 1 } catch (err) {
        warn('subscribeOutbound 钩子抛错(已隔离):' + String(err?.message ?? err))
      }
    }
    return fired
  }

  /**
   * 「真的送到他手机上了」的回执 —— 渠道无关。
   * 关怀降权、想念 ×0.5 都挂在这上面(A 侧纪律:发送成功才降权)。
   * 返回注销函数;钩子抛错绝不影响销账本身。
   */
  function onDelivered (fn) {
    if (typeof fn !== 'function') return () => {}
    deliveredHooks.push(fn)
    return () => {
      const i = deliveredHooks.indexOf(fn)
      if (i >= 0) deliveredHooks.splice(i, 1)
    }
  }

  /** 传输的 ack 打到这儿:`{rows}` → 逐个钩子(钩子之间互不牵连)。 */
  function noteDelivered (rows, meta) {
    const list = Array.isArray(rows) ? rows : []
    if (list.length === 0) return 0
    let fired = 0
    for (const fn of [...deliveredHooks]) {
      try { fn(list, meta ?? null); fired += 1 } catch (err) {
        warn('onDelivered 钩子抛错(已隔离):' + String(err?.message ?? err))
      }
    }
    return fired
  }

  /** 这个会话的渠道(给提示词段用:只读视图由 index.js 注入)。 */
  function targets (sessionId) {
    if (channelView !== null) {
      try { return (channelView.ofSession(String(sessionId ?? '')) ?? []).filter(ch => ch.platform !== 'qq-official') } catch { return [] }
    }
    return []
  }

  /** 全库渠道(只读视图;今天 = store.relayListChannels())。 */
  function allTargets () {
    if (channelView !== null) {
      try { return (channelView.all() ?? []).filter(ch => ch.platform !== 'qq-official') } catch { return [] }
    }
    return []
  }

  /** 给面板/体检:门、渠道、传输状态。**不含 token**(由 transport.status 自己保证)。 */
  function status () {
    const t = transport === null ? null : safeStatus(transport)
    return {
      hasChannel: hasChannel(),
      registeredChannels: channels.size,
      channels: list(),
      transport: t,
      deliveredHooks: deliveredHooks.length,
      outboundHooks: outboundHooks.length,
      pendingTurn: t === null ? 0 : Number(t.pendingTurn ?? 0)
    }
  }

  function dispose () {
    disposed = true
    for (const channel of channels.values()) {
      try { channel.close?.() } catch { }
    }
    channels.clear()
    deliveredHooks.length = 0
    outboundHooks.length = 0
  }

  /**
   * 这个渠道**能不能往外发**?
   *
   * 「入站-only 的渠道」是真实存在的一类:语音输入插件把你说的话送进来,
   * 但你的屏幕就在面前 —— 她的回复不该再绕一圈送回那个渠道。旧行为分不出
   * 这两者,于是轮末把回复排进出站队列(现场:`relay_outbox` 里躺着一条
   * kind='reply',而她其实只是在你面前说话)。
   *
   * 判据以**渠道自己的声明**为准:
   *   - 显式 `canSend === false` ⇒ 不能发;
   *   - 否则看有没有 `send`(主包契约里 `send` 就是出站那一条);
   *   - 没有渠道认领这个平台 ⇒ 返回 true,**一字不改旧行为**。
   */
  function channelCanSend (platform) {
    const p = String(platform ?? '').trim().toLowerCase()
    if (p === '') return true
    for (const ch of channels.values()) {
      const cp = String(ch?.platform ?? ch?.name ?? '').trim().toLowerCase()
      if (cp !== p) continue
      if (ch?.canSend === false) return false
      return typeof ch?.send === 'function'
    }
    return true
  }

  return {
    registerChannel, unregisterChannel, onRegistered, hasChannel, hasRegisteredChannels, list,
    channelCanSend,
    captureSegment, markProactive, finishTurn, say,
    onDelivered, noteDelivered, onOutbound, notifyOutbound,
    targets, allTargets, status, dispose,
    /** 诊断用(单测断言"今天确实是纯转发")。 */
    isDisposed: () => disposed,
    transportRef: () => transport
  }
}
