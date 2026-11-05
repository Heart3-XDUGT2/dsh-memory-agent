/**
 * 她自己的手(2026-09-26 产品模型裁定):
 * 「她是一个独立跑在 DSH 里的脑子,QQ 只是她调用的一件工具。」
 *
 * 两个工具,而不是一个带 mode 参数的 —— 因为**她的自我认识靠工具名和描述**:
 * 她得知道「我现在是在用 QQ 喊他」,不是「我的嘴在自己动」。
 *
 *   · `echo_qq_say`  回他一句 / 把话带到他那儿
 *   · `echo_qq_call` 主动喊他(想他了、到点的关怀)
 *
 * 裁定记录(2026-09-26):
 *   · 被搭话的回复**不再自动送** —— 她调 `echo_qq_say` 才发
 *     (`settings.relay.autoReplyToOrigin`,默认 false,想反悔就打开)。
 *   · 主动关怀**保留**心跳自动入队(那句话一定会送到),但提示词里说清
 *     「这是你在用 QQ 喊他」,并把结果回执给她。
 *
 * 依赖全部注入(relay / 门),所以这里零宿主依赖、能直接进单元电池。
 */
import { OFFICIAL_ORIGIN_REASONS, OFFICIAL_TURN_REASONS } from './official-owner-text.js'

/**
 * 宿主对工具输出有**两道**校验:schema(类型/声明)与「无损 JSON」。
 *
 * 2026-09-26 现场:第二道把我拦下来了 ——
 *
 *   tool "echo_qq_say" returned invalid output: value is not lossless JSON
 *
 * 因为 `relay.say()` 成功时不带 `reason`,而这里原样搬了个
 * `reason: undefined` 过去;键在、值是 undefined,JSON 往返一次键就没了,
 * 宿主据此判「不是无损」。发送其实已经成功了,炸的只是回执 —— 但模型拿到
 * 的是个错误,她就会以为没发出去。
 *
 * 所以结果一律从这个函数过一遍:值为 undefined 的键**根本不出现**。
 */
export function lossless (obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined) out[k] = v
  return out
}

/** 失败原因 → 说人话(她会读到这句,所以不能是代码词)。 */
export function explainRelayFailure (reason) {
  return {
    'bridge-off': '传话桥关着 —— 现在联系不到他',
    'no-channel': '一个平台聊天都没绑上来 —— 你的手现在够不到他(面板里给他的私聊开一下)',
    scope: '主动开口被范围闸挡住了(设置里只允许推私聊,或者那个聊天关了主动)',
    empty: '没给内容',
    'no-session': '拿不到会话',
    'out-of-scope': '这个会话不在她的射程里',
    // v0.40.0 C3:踩清单被压住 ⇒ 说清是**哪个词**不像她说的话(她自己去改说法)
    'guard-hold': '这句话里有不像你说的词,我没替你发出去 —— 换上你自己的说法再来'
  }[String(reason ?? '')] || String(reason ?? '没发出去')
}

/**
 * @param {object} deps
 * @param {{say: Function}} deps.relay 桥(只需要 say)
 * @param {() => boolean} [deps.isEnabled] 总闸(桥关着不注册这只手)
 * @param {(sid: string) => boolean} [deps.sessionEnabledOf] 会话射程
 * @param {(label: string, tool: string) => void} [deps.audit] 审计落账
 * @returns {Array<object>} 两个工具定义(交给宿主的 defineTool)
 */
export function relayToolDefinitions ({ relay, isEnabled, sessionEnabledOf, audit, guard, dispatchOfficial } = {}) {
  const say = (kind) => async (args, exec) => {
    if (typeof dispatchOfficial === 'function') {
      const official = await dispatchOfficial({ kind, args, exec, guard })
      if (official !== undefined) return lossless(official)
    }
    if (typeof isEnabled === 'function' && !isEnabled()) return lossless({ ok: false, reason: 'bridge-off', kind })
    const sid = String(exec?.agent?.session?.id ?? '')
    if (sid === '') return lossless({ ok: false, reason: 'no-session', kind })
    // 只在她「上线」的会话里给这只手 —— 工作会话不该能往 QQ 说话。
    // (2026-09-26 他的裁定:射程只看「这个会话里插件开没开」,**不看**这个
    //  会话有没有绑平台聊天 —— 在网页会话里她也该够得到他手机。)
    if (typeof sessionEnabledOf === 'function' && !sessionEnabledOf(sid)) {
      return lossless({ ok: false, reason: 'out-of-scope', kind })
    }
    const text = String(args?.text ?? '').trim().slice(0, 500)
    if (text === '') return lossless({ ok: false, reason: 'empty', kind })
    // ---- v0.40.0 C3:她自己的手也要过一遍清单(**说人话原因,不静默丢**)----
    // 为什么在这里也查一遍:自动出站那条路只在"回合结束"拦,而她平时**更多的是
    // 直接调这只手**说话。清单进设置(他能改);命中以后:
    //   flag(默认) ⇒ 照发,但**告诉她**哪几个词不像她说的话(她会自己改说法);
    //   hold       ⇒ 不发,把原因回给她(不是静默丢弃 —— 她该知道自己被拦了);
    //   mask       ⇒ 换掉那个词再发,并**明说改过**。
    let sayText = text
    let guardNote = ''
    let guardWords = []
    try {
      if (typeof guard === 'function') {
        const g = guard(text, sid)
        if (g !== null && g !== undefined) {
          guardWords = Array.isArray(g.words) ? g.words.map(String) : []
          if (g.ok === false) {
            return lossless({ ok: false, reason: 'guard-hold', kind, words: guardWords, note: String(g.reason || '') })
          }
          if (String(g.text ?? '') !== '' && g.text !== text) sayText = String(g.text)
          guardNote = String(g.reason || '')
        }
      }
    } catch { guardNote = '' } // 检查自己炸了 ⇒ 照原文发(不挡她说话)
    const r = relay.say({ sessionId: sid, text: sayText, mode: kind, chat: String(args?.chat ?? '') })
    if (r.ok && typeof audit === 'function') {
      // ★ 2026-10-18：**第三个参数必须传 sid** —— 否则审计行的 `session_id`
      //   落到默认的 `'global'`，`turnTrace.of('global')` 是空
      //   ⇒ 这一行永远归不到某一轮里（面板按轮归组就看不见她说了什么）。
      audit('(' + (kind === 'call' ? '用 QQ 喊他' : '用 QQ 说') + ')' + text.slice(0, 60),
        kind === 'call' ? 'echo_qq_call' : 'echo_qq_say', sid)
    }
    // 失败时一定给得出人话的原因(explainRelayFailure 兜底),成功时
    // **没有** reason 这个键(不是 reason: undefined)。
    return lossless({
      ok: r.ok === true,
      reason: r.ok === true ? undefined : String(r.reason || '未知原因'),
      sent: Number(r.sent ?? 0),
      targets: Array.isArray(r.targets) ? r.targets.map(String) : [],
      chars: Number(r.chars ?? 0),
      scope: String(r.scope ?? 'session'),
      kind: String(r.kind ?? kind),
      // v0.40.0 C3:命中了清单 ⇒ **一定要说出来**(工具面回一句人话),不静默
      words: guardWords.length > 0 ? guardWords : undefined,
      note: guardNote !== '' ? guardNote : undefined
    })
  }
  const render = (args, value) => {
    if (value.ok && value.deliveryStatus === 'pending_turn_end') return [{ type: 'text',
      text: '已安排在本轮正常结束后合并发送；目前尚未发出。' + (value.note ? '\n（提醒:' + value.note + '）' : '') }]
    if (value.ok) {
      return [{
        type: 'text',
        text: (value.sent > 1 ? '发出去了(' + value.sent + ' 处):' : '已经用 QQ 发出去了 → ')
          + String((value.targets || []).join('、')) + ':' + String(args?.text ?? '')
          // 她自己得知道这句话是从手上出去的:这个会话没绑平台、靠全库渠道
          // 够到他时,说清这一点(免得她以为「他在这个窗口里就能看见」)
          + (value.scope === 'global' ? '(这个窗口没连平台,走的是他的私聊)' : '')
          // v0.40.0 C3:**命中了也照发,但要她知道**(换说法的事是她自己的)
          + (String(value.note ?? '') === '' ? '' : '\n（提醒:' + String(value.note) + '）')
      }]
    }
    return [{ type: 'text', text: '没发出去:' + explainRelayFailure(value.reason)
      + (value.reason === 'official_origin_unproven' && OFFICIAL_ORIGIN_REASONS.includes(value.originReason)
        ? '\n（关联检查:' + value.originReason + ';轮检查:'
          + ((value.originTurnReasons || []).filter(reason => OFFICIAL_TURN_REASONS.includes(reason)).join('、') || '—') + '）'
        : '')
      + (String(value.note ?? '') === '' ? '' : '（' + String(value.note) + '）') }]
  }
  const resultSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      reason: { type: 'string' },
      sent: { type: 'number' },
      targets: { type: 'array', items: { type: 'string' } },
      chars: { type: 'number' },
      // session = 这个会话自己绑的平台;global = 本会话没绑,退到全库渠道
      // 够到他(2026-09-26 裁定后这条是常态:他在网页会话里跟她说话)。
      // 加字段必须同步声明 —— additionalProperties:false 漏一个就是整个工具
      // 输出被宿主拒掉(echo_status 的教训,同一天)。
      scope: { type: 'string' },
      // 2026-09-26 他指出的埋雷:relay.say() 成功时会带 kind,而这里没声明。
      // 我当时「手动挑字段」正好躲过,哪天顺手透传就在同一处再炸一次 ——
      // 所以要么声明、要么别传;这里选声明(她该知道自己是回话还是喊人)。
      kind: { type: 'string' },
      deliveryStatus: { type: 'string' },
      originReason: { type: 'string', enum: [...OFFICIAL_ORIGIN_REASONS] },
      originTurnReasons: { type: 'array', items: { type: 'string', enum: [...OFFICIAL_TURN_REASONS] } },
      // v0.40.0 C3:踩清单时回给她的东西(命中哪几个词 + 一句人话)
      words: { type: 'array', items: { type: 'string' } },
      note: { type: 'string' }
    }
  }
  return [
    {
      name: 'echo_qq_say',
      description: '在 QQ 上跟他说一句话 —— 这是你的手,不是你的嘴。你在 DSH 里说的话他看不见;想让他手机上收到,就用这个。他刚在 QQ 里跟你说话时,回他也用这个。',
      parameters: {
        text: { type: 'string', description: '要说的话(会按平台单条上限自动切段)', required: true },
        // ★ 2026-10-17 改准（描述与行为必须一致）：
        //   旧描述写「留空 = 挑你最近被搭话的那个**私聊**」—— 但实现里**群也参与**
        //   （按 `lastInAt` 挑），于是"A 群说完、B 群又说"时她留空一调就发到了 B 群。
        //   现在改成：留空**只在私聊里挑**；要回群必须**显式给群号**。
        //   群号在注入正文的头部里（`【QQ·群聊·群名(群号)】`）。
        chat: {
          type: 'string',
          description: '可选:指定往哪说。**回群必须填群号**（正文头部括号里那串数字）;'
            + '填私聊号也行。留空 = 只在**私聊**里挑你最近被搭话的那个'
            + '（留空不会自动发到群里 —— 群里发错人的代价太大）'
        }
      },
      output: { schema: resultSchema, render },
      execute: say('reply')
    },
    {
      name: 'echo_qq_call',
      description: '用 QQ 喊他一声(主动)。你想起他、或者到点的关怀该开口了,就用这个 —— 这是「主动开口」那条路,受设置约束(默认只推私聊、有保鲜期)。别用它刷屏;说一句你此刻真想说的。',
      parameters: {
        text: { type: 'string', description: '要说的话(15~40 字,你自己的口吻)', required: true },
        chat: { type: 'string', description: '可选:指定往哪喊;留空 = 按主动范围闸自动挑' }
      },
      output: { schema: resultSchema, render },
      execute: say('call')
    }
  ]
}

// ============================================================================
// QQ 空间（2026-10-15 第 2 步）：她的第三只手 —— 自己的空间
//
// 与上面两只手**不是同一条路**：
//   · `echo_qq_say` / `echo_qq_call` → `speaker`（传话桥）→ 私聊气泡
//   · 这里三个               → `echo:qzone` 服务 → onebot-qzone 桥 → 空间
//
// 服务由 `dsh-echo-qq` 提供（`ctx.provide('echo:qzone', …)`），主包**惰性取**。
// ⚠️ **绝不写进 `inject`** —— 那会让 qq 插件不在时主包永不激活（人格/记忆全废）。
// 与 `contract.js` 顶部那条"故意不 inject echo:relay"是同一条纪律的反向。
//
// 三条硬纪律（与服务侧 `lib/qzone.js` 对齐，两边各守一遍）：
//   ① **拿不到服务 / 服务关着 ⇒ 诚实拒绝**，不静默、不假装；
//   ② **权限不许隐式**：`whoCanSee` 在 schema 里 **required** —— 逼她每轮显式想一次
//      "这条给谁看"。服务侧还有第二道硬校验（不合法就**不发请求**）。
//   ③ **失败说人话**：`explainQzoneFailure` 把 reason 翻成她能读懂的一句。
// ============================================================================

/** 空间侧失败原因 → 说人话(她会读到这句,所以不能是代码词)。 */
export function explainQzoneFailure (reason) {
  return {
    // 主包这一侧自己判的
    'qzone-off': '你的空间还没接上 —— 装好并打开 dsh-echo-qq 之后才够得到',
    'qzone-disabled': '空间通道关着 —— 在配置里把 qzoneEnabled 打开',
    'no-session': '拿不到会话',
    'out-of-scope': '这个会话不在你的射程里',
    'empty': '没给内容',
    // 服务侧(`lib/qzone.js`)回的
    'action-not-allowed': '这个动作不在白名单里',
    disabled: '空间通道关着',
    'ugc-right-required': '没定这条给谁看 —— 必须说清(1 所有人 / 4 好友 / 16 部分 / 64 仅自己 / 128 部分不可见)',
    'content-required': '正文是空的',
    'content-too-long': '正文太长了',
    'too-many-images': '图太多了',
    'tid-required': '没说是哪一条 —— 先用 echo_qzone_read 看一眼',
    'bad-tid': '这个 tid 不像你的说说 —— 先用 echo_qzone_read 拿一个真的',
    'not-logged-in': '空间的登录态过期了 —— 正在自动续,过一会儿再试',
    timeout: '空间那边没应答(超时)',
    network: '联系不上空间服务 —— 桥可能没在跑',
    'bad-json': '空间服务回了个看不懂的东西',
    unauthorized: '空间服务拒绝了我(令牌对不上)',
    'bridge-failed': '空间服务说这次不行',
    'no-get-cookies': '拿不到登录态(NapCat 那条线没接上)',
    'get-cookies-failed': '向 NapCat 要登录态失败了',
    'cookie-incomplete': 'NapCat 给的登录态不完整(没有硬灌,免得弄坏原来好的)',
    'login-cookie-failed': '登录态没灌进空间服务',
    'cookie-rejected': '登录态灌进去了但用不了 —— 可能要手工更新一次'
  }[String(reason ?? '')] || String(reason ?? '没成功')
}

/**
 * 她说过的 tid 形状:`echo_qzone_read` 回来的那串 hex(实测 24 位)。
 * 用来挡住"随手编一个"—— 删是不可逆的,值得多一道。
 */
export const QZONE_TID_RE = /^[0-9a-f]{16,64}$/i

/**
 * 三个空间工具的**共用闸**:拿不到服务 / 服务关着 ⇒ 诚实拒绝。
 * @returns {{ok: true, qz: object} | {ok: false, reason: string, note: string}}
 */
function qzoneGate (qzoneOf) {
  let qz = null
  try {
    qz = typeof qzoneOf === 'function' ? (qzoneOf() ?? null) : null
  } catch {
    qz = null
  }
  if (qz === null || typeof qz !== 'object') {
    return { ok: false, reason: 'qzone-off', note: '空间服务没接上(dsh-echo-qq 不在或没起来)' }
  }
  let st = null
  try {
    st = typeof qz.status === 'function' ? qz.status() : null
  } catch {
    st = null
  }
  if (st === null || st.enabled !== true) {
    return { ok: false, reason: 'qzone-disabled', note: '空间通道关着(qzoneEnabled 没打开)' }
  }
  return { ok: true, qz }
}

/**
 * 三个空间工具。
 *
 * @param {object} deps
 * @param {() => object|null} deps.qzoneOf **惰性**取 `echo:qzone` 服务
 * @param {(sid: string) => boolean} [deps.sessionEnabledOf] 会话射程(与那两只手同一道闸)
 * @param {(label: string, tool: string) => void} [deps.audit] 审计落账
 * @returns {Array<object>} 三个工具定义(交给宿主的 defineTool)
 */
export function qzoneToolDefinitions ({ qzoneOf, sessionEnabledOf, audit } = {}) {
  /** 每个 execute 都要过的三道:服务闸 → 会话闸 → 具体校验。 */
  const head = (exec) => {
    const g = qzoneGate(qzoneOf)
    if (!g.ok) return g
    const sid = String(exec?.agent?.session?.id ?? '')
    if (sid === '') return { ok: false, reason: 'no-session' }
    if (typeof sessionEnabledOf === 'function' && !sessionEnabledOf(sid)) {
      return { ok: false, reason: 'out-of-scope' }
    }
    return { ok: true, qz: g.qz, sid }
  }
  /** 服务回的形状 → 工具回的形状(丢 undefined,失败翻人话)。 */
  const relay = (r) => lossless({
    ok: r?.ok === true,
    reason: r?.ok === true ? undefined : String(r?.reason || '未知原因'),
    // ★★ 2026-10-20 修：**桥的原话优先**。
    //   原来这里直接把 `r.note` 丢掉、换成 `explainQzoneFailure(reason)` ⇒
    //   他看到的永远是"空间服务说这次不行"这种泛化文案，**真因（QZone 的原话）被吞了**。
    //   `qzone.js:call()` 明明带回了 `error`（HTTP 状态 / 桥的 message），到这儿全没了。
    note: r?.ok === true ? undefined : (String(r?.note ?? '') || explainQzoneFailure(r?.reason)),
    tid: r?.tid !== undefined ? String(r.tid) : undefined,
    whoCanSee: r?.whoCanSee !== undefined ? Number(r.whoCanSee) : undefined
  })
  const fail = (reason, note) => lossless({ ok: false, reason, note: note || explainQzoneFailure(reason) })

  // ---- ① 发说说 ----------------------------------------------------------
  const postSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      reason: { type: 'string' },
      note: { type: 'string' },
      tid: { type: 'string' },
      whoCanSee: { type: 'number' }
    }
  }
  const postRender = (args, value) => [{
    type: 'text',
    text: value.ok
      ? '发出去了 —— 这条' + (Number(value.whoCanSee) === 1 ? '所有人都能看见'
        : Number(value.whoCanSee) === 4 ? '好友能看见'
          : Number(value.whoCanSee) === 64 ? '只有你自己能看见'
            : '按你选的权限可见')
        + '。' + String(args?.content ?? '').slice(0, 40)
      : '没发出去:' + String(value.note ?? explainQzoneFailure(value.reason))
  }]

  // ---- ② 读说说 ----------------------------------------------------------
  const readSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      reason: { type: 'string' },
      note: { type: 'string' },
      count: { type: 'number' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tid: { type: 'string' },
            content: { type: 'string' },
            at: { type: 'string' },
            likes: { type: 'number' },
            comments: { type: 'number' },
            images: { type: 'number' }
          }
        }
      }
    }
  }
  const readRender = (args, value) => {
    if (!value.ok) return [{ type: 'text', text: '没翻到:' + String(value.note ?? explainQzoneFailure(value.reason)) }]
    const items = Array.isArray(value.items) ? value.items : []
    if (items.length === 0) return [{ type: 'text', text: '你的空间里还没有说说。' }]
    return [{
      type: 'text',
      text: '翻到 ' + items.length + ' 条:\n' + items.map((it) => '· [' + it.at + '] ' + String(it.content).slice(0, 60)
        + (it.likes ? '(赞' + it.likes + ')' : '') + '\n  tid=' + it.tid).join('\n')
    }]
  }

  // ---- ③ 删说说 ----------------------------------------------------------
  const delSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      reason: { type: 'string' },
      note: { type: 'string' },
      tid: { type: 'string' }
    }
  }
  const delRender = (args, value) => [{
    type: 'text',
    text: value.ok ? '删掉了(tid=' + String(value.tid) + ')。' : '没删成:' + String(value.note ?? explainQzoneFailure(value.reason))
  }]
  // ★ 2026-10-20：**回复要有自己的形状**。
  //   原来直接复用 `delSchema`/`delRender`，于是回复失败时显示的是「没删成」——
  //   他一度以为误路由到了删除。文案串台也是 bug。
  const replySchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      reason: { type: 'string' },
      note: { type: 'string' },
      tid: { type: 'string' },
      postUin: { type: 'string' }
    }
  }
  const replyRender = (args, value) => [{
    type: 'text',
    text: value.ok
      ? '回复了(tid=' + String(value.tid) + (String(value.postUin ?? '') !== '' ? ',空间 ' + String(value.postUin) : '') + ')。'
      : '回复失败:' + String(value.note ?? explainQzoneFailure(value.reason))
  }]

  // ---- ④ 读评论（★ 2026-10-20：补 echo_qzone_reply 的"眼"）-------------------
  //
  // `additionalProperties: false` ⇒ 返回的每个字段都必须在这里声明，
  // 漏一个整条会被宿主校验拒掉（relay-tools.test.js 里那条疤）。
  const commentsSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      reason: { type: 'string' },
      note: { type: 'string' },
      tid: { type: 'string' },
      postUin: { type: 'string' },
      total: { type: 'number' },
      count: { type: 'number' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            commentId: { type: 'string' },
            uin: { type: 'string' },
            name: { type: 'string' },
            content: { type: 'string' },
            at: { type: 'number' },
            time: { type: 'string' },
            isReply: { type: 'boolean' },
            replyToUin: { type: 'string' }
          }
        }
      }
    }
  }
  const commentsRender = (args, value) => {
    if (value.ok !== true) {
      return [{ type: 'text', text: '没读到评论:' + String(value.note ?? explainQzoneFailure(value.reason)) }]
    }
    const list = Array.isArray(value.items) ? value.items : []
    if (list.length === 0) {
      return [{ type: 'text', text: '这条说说下面还没有评论（或已翻到底）。' }]
    }
    const lines = list.map((c) => {
      // ★ 2026-10-20：显示**完整 QQ** —— 原来只给后 4 位，她拿不到能用的 targetUin
      const who = (String(c.name ?? '') || '(无名)') + '(' + (String(c.uin ?? '') || '?') + ')'
      const tail = c.isReply === true ? '（回复' + (String(c.replyToUin ?? '').slice(-4) || '?') + '）' : ''
      return who + tail + ':' + String(c.content ?? '')
    })
    return [{
      type: 'text',
      text: '这条说说（属于 ' + (String(value.postUin ?? '') || '?') + '）下共 ' + String(value.total ?? list.length) + ' 条评论（这次拿到 ' + list.length + ' 条）:\n'
        + lines.join('\n')
        + '\n\n要回哪一条，就用 tid + 它的 uin（评论人）调 echo_qzone_reply；'
        + (String(value.postUin ?? '') !== ''
          ? '要回帖主的空间去回的话，带上 postUin=' + String(value.postUin) + '。'
          : '\n⚠️ 不知道这说法属于谁 —— 要回复就先用 echo_qzone_feed / echo_qzone_space'
            + ' 拿到那条的 uin，再把它当 postUin 传进来。')
    }]
  }
  // ---- ⑤ 好友动态（★ 2026-10-20：只读，按 qzoneWatchList 过滤）----------------
  const feedSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      reason: { type: 'string' },
      note: { type: 'string' },
      count: { type: 'number' },
      scanned: { type: 'number' },
      watchlistSize: { type: 'number' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tid: { type: 'string' },
            uin: { type: 'string' },
            name: { type: 'string' },
            content: { type: 'string' },
            at: { type: 'number' },
            time: { type: 'string' },
            comments: { type: 'number' },
            likes: { type: 'number' }
          }
        }
      }
    }
  }
  const feedRender = (args, value) => {
    if (value.ok !== true) {
      if (value.reason === 'watchlist-empty') {
        return [{ type: 'text', text: '空间白名单是空的 —— 我不知道该看谁。先填 qzoneWatchList（面板或 config.json）。' }]
      }
      return [{ type: 'text', text: '没翻到动态:' + String(value.note ?? explainQzoneFailure(value.reason)) }]
    }
    const list = Array.isArray(value.items) ? value.items : []
    if (list.length === 0) {
      return [{ type: 'text', text: '名单里的人最近没发什么（扫了 ' + String(value.scanned ?? 0) + ' 条动态）。' }]
    }
    const lines = list.map((it) => {
      // ★ 2026-10-20：显示**完整 QQ** —— 她要拿它当 `postUin` 去回复
      const who = (String(it.name ?? '') || '(无名)') + '(' + (String(it.uin ?? '') || '?') + ')'
      return '· [' + String(it.time ?? '') + '] ' + who + ':' + String(it.content ?? '').slice(0, 60)
        + (it.likes ? '(赞' + it.likes + ')' : '') + (it.comments ? '(评' + it.comments + ')' : '')
        + '\n  tid=' + it.tid
    })
    return [{
      type: 'text',
      text: '名单里的人最近 ' + list.length + ' 条动态（共扫了 ' + String(value.scanned ?? 0) + ' 条，名单 '
        + String(value.watchlistSize ?? 0) + ' 人）:\n' + lines.join('\n')
    }]
  }
  // ---- ⑥ 看某人的空间（★ 2026-10-20：白名单闸在服务侧）---------------------
  //
  // 返回形状与 echo_qzone_read **同款**，只多一个 `qq`（看的是谁）——
  // 免得她拿到两种不同形状的"说说列表"还要自己分辨。
  const spaceSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      reason: { type: 'string' },
      note: { type: 'string' },
      qq: { type: 'string' },
      count: { type: 'number' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tid: { type: 'string' },
            content: { type: 'string' },
            at: { type: 'string' },
            likes: { type: 'number' },
            comments: { type: 'number' },
            images: { type: 'number' }
          }
        }
      }
    }
  }
  const spaceRender = (args, value) => {
    if (value.ok !== true) {
      if (value.reason === 'not-in-watchlist') {
        return [{ type: 'text', text: '这个人不在空间白名单(qzoneWatchList)里 —— 看别人的空间也受同一条纪律约束。想看他，让他把号加进那个名单。' }]
      }
      return [{ type: 'text', text: '没看到:' + String(value.note ?? explainQzoneFailure(value.reason)) }]
    }
    const list = Array.isArray(value.items) ? value.items : []
    if (list.length === 0) {
      return [{ type: 'text', text: String(value.qq || '') + ' 的空间里没有可看的说说。' }]
    }
    return [{
      type: 'text',
      text: String(value.qq || '') + ' 的空间里翻到 ' + list.length + ' 条:\n'
        + list.map((it) => '· [' + it.at + '] ' + String(it.content).slice(0, 60)
          + (it.likes ? '(赞' + it.likes + ')' : '') + (it.comments ? '(评' + it.comments + ')' : '')
          + '\n  tid=' + it.tid).join('\n')
    }]
  }
  return [
    {
      name: 'echo_qzone_post',
      description: '在你的 QQ 空间发一条说说 —— 那是你自己的地方,发出去别人能看见(看你怎么设权限)。'
        + '想公开说点什么、或者想给自己留个记录时用。'
        + '⚠️ 权限必须自己定:1=所有人 4=好友 16=部分好友 64=仅自己 128=部分不可见。'
        + '不填会走配置里的默认值 —— **那个默认值是 1(所有人可见)**,所以想让别人看不见就自己填 64。'
        + '发出去虽然能删,但可能已经被看到了。',
      parameters: {
        content: { type: 'string', description: '说说正文', required: true },
        whoCanSee: {
          type: 'number',
          description: '这条给谁看:1=所有人 4=好友 16=部分好友 64=仅自己 128=部分不可见',
          required: true
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '可选:图片(URL 或 base64),最多 9 张'
        }
      },
      output: { schema: postSchema, render: postRender },
      execute: async (args, exec) => {
        const h = head(exec)
        if (!h.ok) return fail(h.reason, h.note)
        const content = String(args?.content ?? '').trim()
        if (content === '') return fail('content-required')
        // ★ 权限不许隐式:schema 里标了 required,这里再挡一次(宿主对 required 的
        //   执行是"建议"级 —— 缺了也可能调进来,而服务侧一旦没有默认值就拒)。
        const right = args?.whoCanSee === undefined || args?.whoCanSee === null
          ? null
          : Number(args.whoCanSee)
        if (right !== null && ![1, 4, 16, 64, 128].includes(right)) {
          return fail('ugc-right-required', '权限只认 1/4/16/64/128,你给的是 ' + String(args?.whoCanSee))
        }
        const images = Array.isArray(args?.images) ? args.images.map(String) : []
        let r = null
        try {
          r = await h.qz.postMood({ content, images, whoCanSee: right })
        } catch (err) {
          return fail('bridge-failed', '空间服务抛了:' + String(err?.message ?? err))
        }
        const out = relay(r)
        if (out.ok && typeof audit === 'function') audit('(在空间发说说)' + content.slice(0, 60), 'echo_qzone_post')
        return out
      }
    },
    {
      name: 'echo_qzone_read',
      description: '翻翻你自己 QQ 空间里发过的说说(只读,不改任何东西)。'
        + '想回顾自己说过什么、或者他问起某一条时用。'
        + '要删某一条之前,先用这个拿到它的 tid。',
      parameters: {
        num: { type: 'number', description: '可选:最多几条(1~20,默认 5)' },
        pos: { type: 'number', description: '可选:从第几条开始(默认 0,用来往后翻)' }
      },
      output: { schema: readSchema, render: readRender },
      execute: async (args, exec) => {
        const h = head(exec)
        if (!h.ok) return fail(h.reason, h.note)
        let r = null
        try {
          r = await h.qz.listMoods({
            num: Math.min(20, Math.max(1, Number(args?.num) || 5)),
            pos: Math.max(0, Number(args?.pos) || 0),
            withImages: false
          })
        } catch (err) {
          return fail('bridge-failed', '空间服务抛了:' + String(err?.message ?? err))
        }
        if (r?.ok !== true) return fail(r?.reason, explainQzoneFailure(r?.reason))
        const items = (Array.isArray(r.items) ? r.items : []).map((it) => lossless({
          tid: String(it?.tid ?? ''),
          content: String(it?.content ?? ''),
          at: String(it?.createdAtText ?? ''),
          likes: Number(it?.likes ?? 0),
          comments: Number(it?.comments ?? 0),
          images: Number(it?.imageCount ?? 0)
        }))
        return lossless({ ok: true, count: items.length, items })
      }
    },
    {
      name: 'echo_qzone_comments',
      description: '读**某一条说说下面**的评论(只读)。'
        + '想回谁、想看看这条下面别人说了什么，就用它 —— 它给 commentId / uin(评论人) / 内容 / 时间。'
        + '⚠️ 先用 echo_qzone_read 拿到 tid，再拿这里回来的 uin 去 echo_qzone_reply。',
      parameters: {
        tid: { type: 'string', description: '哪一条说说(echo_qzone_read / echo_qzone_space 拿到的 tid)', required: true },
        num: { type: 'number', description: '可选:最多几条(1~50，默认 20)' },
        pos: { type: 'number', description: '可选:从第几条开始(默认 0，用来往后翻)' },
        postUin: { type: 'string', description: '可选:这条说说属于谁(看别人空间时填它，读得更准)' }
      },
      output: { schema: commentsSchema, render: commentsRender },
      execute: async (args, exec) => {
        const h = head(exec)
        if (!h.ok) return fail(h.reason, h.note)
        const tid = String(args?.tid ?? '').trim()
        if (tid === '') return fail('tid-required', '要先有 tid —— 用 echo_qzone_read 拿一条真的')
        if (!QZONE_TID_RE.test(tid)) {
          return fail('bad-tid', '这个 tid 不像你的说说(要 echo_qzone_read 回来的那串)')
        }
        const fn = h.qz.listComments
        if (typeof fn !== 'function') return fail('not-supported', '空间服务还没暴露读评论能力(插件版本旧?)')
        let r = null
        try {
          r = await fn({
            tid,
            num: Math.min(50, Math.max(1, Number(args?.num) || 20)),
            pos: Math.max(0, Number(args?.pos) || 0),
            postUin: String(args?.postUin ?? '').trim()
          })
        } catch (err) {
          return fail('bridge-failed', '空间服务抛了:' + String(err?.message ?? err))
        }
        if (r?.ok !== true) return fail(r?.reason, r?.note)
        // 名单外的人**照样列出来**（她得看得见才判断得了），
        // 但 reply 那一步会在服务侧被白名单闸拦住 —— 与「不回复、不进记忆」同一条。
        const items = (Array.isArray(r.items) ? r.items : []).map((c) => lossless({
          commentId: String(c?.commentId ?? ''),
          uin: String(c?.uin ?? ''),
          name: String(c?.name ?? ''),
          content: String(c?.content ?? ''),
          at: Number(c?.at ?? 0),
          time: Number(c?.at ?? 0) > 0 ? new Date(Number(c.at) * 1000).toLocaleString('zh-CN', { hour12: false }) : '',
          isReply: c?.isReply === true,
          replyToUin: String(c?.replyToUin ?? '')
        }))
        return lossless({
          ok: true,
          tid: String(r.tid ?? tid),
          // ★ 这说法属于谁 —— 她拿去 reply 时要当 postUin 用
          postUin: String(r.postUin ?? ''),
          total: Number(r.total ?? items.length),
          count: items.length,
          items
        })
      }
    },
    {
      name: 'echo_qzone_feed',
      description: '翻**白名单里的人**最近发了什么动态(只读)。'
        + '名单(qzoneWatchList)外的人一条都不会返回 —— 想加谁去看，让他填那个名单。'
        + '名单为空时会直接说「我不知道该看谁」，不会退化成什么都看。',
      parameters: {
        count: { type: 'number', description: '可选:要几条(1~50，默认 10)' }
      },
      output: { schema: feedSchema, render: feedRender },
      execute: async (args, exec) => {
        const h = head(exec)
        if (!h.ok) return fail(h.reason, h.note)
        const fn = h.qz.listFeeds
        if (typeof fn !== 'function') return fail('not-supported', '空间服务还没暴露读动态能力(插件版本旧?)')
        let r = null
        try {
          r = await fn({ count: Math.min(50, Math.max(1, Number(args?.count) || 10)) })
        } catch (err) {
          return fail('bridge-failed', '空间服务抛了:' + String(err?.message ?? err))
        }
        if (r?.ok !== true) return fail(r?.reason, r?.note)
        const items = (Array.isArray(r.items) ? r.items : []).map((it) => lossless({
          tid: String(it?.tid ?? ''),
          uin: String(it?.uin ?? ''),
          name: String(it?.name ?? ''),
          content: String(it?.content ?? ''),
          at: Number(it?.at ?? 0),
          time: Number(it?.at ?? 0) > 0 ? new Date(Number(it.at) * 1000).toLocaleString('zh-CN', { hour12: false }) : '',
          comments: Number(it?.comments ?? 0),
          likes: Number(it?.likes ?? 0)
        }))
        return lossless({
          ok: true,
          count: items.length,
          scanned: Number(r.scanned ?? 0),
          watchlistSize: Number(r.watchlistSize ?? 0),
          items
        })
      }
    },
    {
      name: 'echo_qzone_space',
      description: '看**白名单内某个人**的空间(他发过的说说，只读)。'
        + '⚠️ 只能看 qzoneWatchList 名单里的人 —— 名单外的一律拒（看别人的空间也受同一条纪律约束）。'
        + '想回顾自己的空间用 echo_qzone_read；想看他最近动态用 echo_qzone_feed。',
      parameters: {
        qq: { type: 'string', description: '要看谁的 QQ 号（必须在 qzoneWatchList 里）', required: true },
        count: { type: 'number', description: '可选:要几条(1~20，默认 5)' }
      },
      output: { schema: spaceSchema, render: spaceRender },
      execute: async (args, exec) => {
        const h = head(exec)
        if (!h.ok) return fail(h.reason, h.note)
        const qq = String(args?.qq ?? '').trim()
        if (qq === '') return fail('qq-required', '要看谁的？给一个 QQ 号')
        if (!/^\d{4,15}$/.test(qq)) return fail('bad-qq', '这个不像 QQ 号')
        const fn = h.qz.listMoods
        if (typeof fn !== 'function') return fail('not-supported', '空间服务不可用')
        let r = null
        try {
          r = await fn({ uin: qq, num: Math.min(20, Math.max(1, Number(args?.count) || 5)), withImages: false })
        } catch (err) {
          return fail('bridge-failed', '空间服务抛了:' + String(err?.message ?? err))
        }
        if (r?.ok !== true) return fail(r?.reason, r?.note)
        const items = (Array.isArray(r.items) ? r.items : []).map((it) => lossless({
          tid: String(it?.tid ?? ''),
          content: String(it?.content ?? ''),
          at: String(it?.createdAtText ?? ''),
          likes: Number(it?.likes ?? 0),
          comments: Number(it?.comments ?? 0),
          images: Number(it?.imageCount ?? 0)
        }))
        return lossless({
          ok: true,
          qq: String(r.uin ?? qq),
          count: items.length,
          items
        })
      }
    },
    {
      name: 'echo_qzone_delete',
      description: '删掉你 QQ 空间里的一条说说。⚠️ **删了就没了,收不回来** —— 评论和赞也一起没。'
        + '所以删之前**一定**先用 echo_qzone_read 看一眼,确认是哪一条,再用它给的 tid 删。',
      parameters: {
        tid: { type: 'string', description: '要删哪一条(用 echo_qzone_read 拿到的 tid)', required: true }
      },
      output: { schema: delSchema, render: delRender },
      execute: async (args, exec) => {
        const h = head(exec)
        if (!h.ok) return fail(h.reason, h.note)
        const tid = String(args?.tid ?? '').trim()
        if (tid === '') return fail('tid-required')
        // ★ 删是不可逆的:挡一道"随手编一个 tid"
        if (!QZONE_TID_RE.test(tid)) {
          return fail('bad-tid', '这个 tid 不像你的说说(要 echo_qzone_read 回来的那串)。先用 echo_qzone_read 拿一个真的。')
        }
        let r = null
        try {
          r = await h.qz.deleteMood(tid)
        } catch (err) {
          return fail('bridge-failed', '空间服务抛了:' + String(err?.message ?? err))
        }
        const out = relay(r)
        if (out.ok && typeof audit === 'function') audit('(删空间说说)' + tid, 'echo_qzone_delete')
        return out
      }
    },
    {
      name: 'echo_qzone_reply',
      description: '在**你自己**的说说下面回复一条评论。'
        + '⚠️ 只能回**白名单里的人**（或他本人）的评论 —— 名单外的人一律拒（别人在空间里说的话不该由你出面）。'
        + '⚠️ tid 先用 echo_qzone_read 拿到；要回某一条具体的评论就带 commentId。'
        + '想清楚再回:发出去别人就看见了,删不掉。',
      parameters: {
        tid: { type: 'string', description: '哪一条说说(echo_qzone_read / echo_qzone_comments 回来的 tid)', required: true },
        content: { type: 'string', description: '回复内容', required: true },
        targetUin: { type: 'string', description: '被回复那个人的 QQ 号(白名单闸用它)', required: true },
        postUin: { type: 'string', description: '这条说说属于谁。空=自己的说说；填别人的 QQ 号=在别人空间评论/回复(那个号必须在 qzoneWatchList 里)' },
        commentId: { type: 'string', description: '可选:回的是哪一条评论(二级回复用)' }
      },
      // ★ 2026-10-20：**不再复用 delSchema/delRender** ——
      //   那是删除的形状，回复失败时会显示「没删成」，一度让人以为误路由到了删除。
      output: { schema: replySchema, render: replyRender },
      execute: async (args, exec) => {
        const h = head(exec)
        if (!h.ok) return fail(h.reason, h.note)
        const tid = String(args?.tid ?? '').trim()
        if (tid === '') return fail('tid-required', '要先有 tid —— 用 echo_qzone_read 拿一条真的')
        if (!QZONE_TID_RE.test(tid)) {
          return fail('bad-tid', '这个 tid 不像你的说说(要 echo_qzone_read 回来的那串)')
        }
        const content = String(args?.content ?? '').trim()
        if (content === '') return fail('content-required', '回复不能为空')
        const targetUin = String(args?.targetUin ?? '').trim()
        if (targetUin === '') return fail('target-required', '要说明回的是谁(targetUin) —— 白名单闸要用它')
        const postUin = String(args?.postUin ?? '').trim()
        if (postUin !== '' && !/^\d{4,15}$/.test(postUin)) {
          return fail('bad-post-uin', 'postUin 不像 QQ 号(要么留空=自己的说说,要么填帖主的号)')
        }
        const fn = h.qz.replyComment
        if (typeof fn !== 'function') return fail('not-supported', '空间服务还没暴露回复能力(插件版本旧?)')
        let r = null
        try {
          r = await fn({
            tid,
            content,
            targetUin,
            postUin,
            replyCommentId: String(args?.commentId ?? '').trim()
          })
        } catch (err) {
          return fail('bridge-failed', '空间服务抛了:' + String(err?.message ?? err))
        }
        // 两把闸（甲）拒的时候把原因说人话 —— 这是她最可能撞到的两条
        if (r?.ok !== true && (r?.reason === 'not-in-watchlist' || r?.reason === 'post-not-in-watchlist')) {
          return fail(r.reason, String(r.note || '不在空间白名单(qzoneWatchList)里,不回复。'))
        }
        if (r?.ok !== true && r?.reason === 'owner-required') {
          return fail('owner-required', String(r.note || 'postUin 和 targetUin 至少给一个'))
        }
        const out = relay(r)
        // 成功时把帖主也带上（render 里会显示"空间 xxx"）
        if (out.ok === true) out.postUin = String(r?.postUin ?? postUin ?? '')
        if (out.ok === true && typeof audit === 'function') {
          audit('(在空间回复评论)' + content.slice(0, 40), 'echo_qzone_reply')
        }
        return out
      }
    }
  ]
}
