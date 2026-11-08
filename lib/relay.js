/**
 * v0.17.0 R2 · 传话桥(平台当嘴,DSH 当脑)
 * ============================================================
 * 职责:把平台侧的信封变成「她的一轮对话」,再把她的回复变成出站队列。
 * 三件事**不在这里**:会话怎么建/续(宿主 `sessionController`)、消息怎么
 * 注入(`agent.runMaintenance → followup`)、权限怎么降(宿主
 * `permissionPresets`)—— 它们都靠壳注入,本模块因此可以离线测试
 * (与 `lib/heartbeat.js` 同一套注入风格:不 import 宿主包)。
 *
 * 数据流(2026-09-28 起旧桥退役,**没有 HTTP 那一层了**):
 *   入站 `echo:relay` 服务的 `inject(envelope)` → ①总闸 ②信封 ③主人 ④幂等
 *     → ⑤拉起陪伴会话 → ⑥权限闸 → ⑦登记渠道 → ⑧注入(忙则撤受理让消费端按 msgId 重试)
 *   出站 `session/event` 的 assistant/message → captureSegment 攒着;
 *     turn/end → finishTurn:按渠道把**整个回合切成气泡**入队(v0.18.0)
 *   消费端(QQ 渠道插件)接到"有活儿"的推送 → `lease` 取行 → 按每泡的到期时刻发 → ack
 *
 * 几条不肯让步的纪律:
 *   - **总闸默认关**:没有渠道插件自报家门 ⇒ 连陪伴会话都不建。
 *     闸门顺序错了(先建会话再判闸)会在关着的时候污染会话列表。
 *   - **幂等靠库不靠内存**:适配器重试是常态(网络抖、她忙),重复消息
 *     不能变成第二个她;而她忙是正常状态,所以「忙」必须能重试。
 *   - **主动话有保鲜期**:5 分钟没送出去就丢(迟到的关怀不是关怀)。
 *   - **群聊一律拒收**(v0.29.0 个人机器人,他的裁决:「彻底移除一切和
 *     群体相关的东西」):入站 group 信封 403,出站只走私聊渠道 ——
 *     老库里残留的群渠道行从此收不到、也发不出任何东西。
 *   - **分泡只改包装**:切分/节奏/打断全部照 A 侧(v8.10.0),话一个字不变;
 *     主动话与提醒**不分泡**(A 侧的关怀走 `context.send_message`,是一整条)。
 */
import { randomUUID } from 'node:crypto'
import { planBubbles, BUBBLE_MAX_BUBBLES } from './bubble.js'
import { readSettings, setSessionOn } from './toggle.js'
import { rememberInterrupted } from './interrupted.js'
// v0.40.0 C3/F4:出站清单检查(禁词/防重复)+ 她说话时的插入优先级四档
import {
  guardOutbound, bannedWordsFor, DEFAULT_BANNED_ACTION,
  DEFAULT_REPEAT_ACTION, DEFAULT_REPEAT_SIMILARITY, REPEAT_LOOKBACK
} from './speech-guard.js'
import { decideInsertion, notBeforeFor, parsePriorityOverrides } from './insert-priority.js'
// 2026-09-29 裁定 A:审计行要写清"这一条 QQ 进的是哪条会话"(他的窗口 / 陪伴会话)。
import { describeRoute } from './companion-target.js'
import { parseRelayContent, hasRelayContent, renderRelayContent } from './relay-content.js'
import { parseGroupContext, renderGroupSocialContext } from './group-social.js'
import { renderGroupDialogueContext } from './group-dialogue-context.js'

// 2026-09-26 卫生:这里原有 `RELAY_KINDS = ['reply','proactive','reminder']`,
// 全仓除这一行外零引用(三类 kind 实际是散在各调用点写的字面量)——
// 一个「看着像注册表、其实没人查」的常量,已删。

const PLATFORM_LABELS = { qq: 'QQ', telegram: 'Telegram', wechat: '微信', wecom: '企业微信' }
const MAX_TEXT = 8000

/** 平台名 → 人话(注入正文里她要能看懂「这是哪个平台」)。 */
export function platformLabel (platform) {
  const p = String(platform ?? '').trim().toLowerCase()
  return PLATFORM_LABELS[p] ?? (p === '' ? '未知平台' : p)
}

/**
 * 信封校验(适配器唯一能说的话)。
 * 形状见 `docs/RELAY_PLAN.md` §六:
 *   { v, platform, chat:{id,type,title}, sender:{id,name,isMaster}, text, msgId, ts }
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
/** 一封入站信最多带几张图(超过的丢,并在正文里说明)。 */
const MAX_IMAGES = 4
/** 图记里 url/path 的长度上限;`data`(base64)另算 —— 它本身就是图片体积。 */
const MAX_IMAGE_REF = 2048
const MAX_IMAGE_DATA = 12 * 1024 * 1024

/**
 * 信封里的 `images`:她 2026-09-26 才有的眼睛。
 *
 * 一条图记按优先级认三种来源(`lib/eyes.js` 的 `pickImageSource` 同款顺序):
 *   `url`(QQ 的 CDN 临时链接,主路)| `path`(同机文件)| `data`(base64,兜底)。
 * 这里只**校验形状**,不抓图 —— 抓取在注入那一步(要附件服务,壳里才有),
 * 而且抓不到图不该让整封信变成 400:那是「她没看见」,不是「信不合法」。
 * @param {unknown} raw
 * @returns {{ok:true,value:Array<object>}|{ok:false,reason:string}}
 */
function parseImages (raw) {
  if (raw === undefined || raw === null) return { ok: true, value: [] }
  if (!Array.isArray(raw)) return { ok: false, reason: 'images 必须是数组' }
  const out = []
  for (let i = 0; i < raw.length; i += 1) {
    const one = raw[i]
    if (one === null || typeof one !== 'object' || Array.isArray(one)) {
      return { ok: false, reason: 'images[' + i + '] 必须是对象' }
    }
    const item = {}
    for (const key of ['url', 'path', 'file']) {
      const v = String(one[key] ?? '').trim()
      if (v === '') continue
      if (v.length > MAX_IMAGE_REF) return { ok: false, reason: 'images[' + i + '].' + key + ' 过长' }
      item[key] = v
    }
    const data = String(one.data ?? '').trim()
    if (data !== '') {
      if (data.length > MAX_IMAGE_DATA) return { ok: false, reason: 'images[' + i + '].data 过大' }
      item.data = data
    }
    if (item.url === undefined && item.path === undefined && item.file === undefined && item.data === undefined) {
      return { ok: false, reason: 'images[' + i + '] 没给 url/path/data' }
    }
    const name = String(one.name ?? '').trim().slice(0, 80)
    if (name !== '') item.name = name
    // ★ 2026-10-20：**表情包标记放行**（他提的「表情包不要描述一通」）。
    //   `sub_type`（0=普通图 / 1=表情包）与 `summary`（如 `[动画表情]`）由渠道侧透传上来，
    //   这里是最后一道 —— 不放行的话下游永远判不出表情包。
    //   两者都只做形状校验，**不发明新语义**；数值非法就丢掉（宁可当普通图，也别炸整条信）。
    if (one.sub_type !== undefined && one.sub_type !== null && one.sub_type !== '') {
      const n = Number(one.sub_type)
      if (Number.isFinite(n)) item.sub_type = n
    }
    const summary = String(one.summary ?? '').trim().slice(0, 40)
    if (summary !== '') item.summary = summary
    out.push(item)
  }
  return { ok: true, value: out.slice(0, MAX_IMAGES) }
}

/**
 * 协议信封校验(适配器的第二道闸:第一道在 A 侧 `decide_inbound`)。
 *
 * 2026-09-26 起正文**可以为空** —— 但只在有图的时候:他只发一张月亮、
 * 一个字不打,这也是话。图与字都没有才是坏信封。
 * @param {unknown} raw
 * @returns {{ok:true,value:object}|{ok:false,reason:string}}
 */
/**
 * ★ 2026-10-21：**@ 感知字段的形状校验**（渠道侧 `atHintsOfSegments` 算好后传上来）。
 *
 * 纪律与 `parseImages` 一致：**坏字段丢掉，不炸整条信** ——
 * 一个 `atOthers` 长得不对，不该让他连字都白打。
 *
 * @returns {{ok: boolean, atMe: boolean, atOthers: Array<{qq:string,name:string}>}}
 */
function parseAtHints (r, isGroup = false) {
  const empty = { ok: false, atMe: false, atOthers: [] }
  if (r === null || typeof r !== 'object') return empty
  const atMe = r.atMe === true
  const raw = Array.isArray(r.atOthers) ? r.atOthers : []
  const atOthers = []
  for (const one of raw) {
    if (one === null || typeof one !== 'object' || Array.isArray(one)) continue
    const qq = String(one.qq ?? '').trim().slice(0, 20)
    const name = String(one.name ?? '').trim().slice(0, 40)
    if (qq === '' && name === '') continue
    if (atOthers.length < 8) atOthers.push({ qq, name })
    else if (isGroup && (qq === 'all' || qq === '0') && !atOthers.some(a => a.qq === 'all' || a.qq === '0')) {
      atOthers[7] = { qq, name } // 上限仍为8；不能把尾部全体通知裁成“只@其他人”。
    }
  }
  if (!atMe && atOthers.length === 0) return empty   // 没有 @ ⇒ 不产生任何键
  return { ok: true, atMe, atOthers }
}

export function parseEnvelope (raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null
  if (r === null) return { ok: false, reason: 'body 必须是对象' }
  const v = r.v === undefined ? 1 : Number(r.v)
  if (v !== 1) return { ok: false, reason: 'v 只支持 1(协议版本)' }
  const platform = String(r.platform ?? '').trim().toLowerCase()
  if (!/^[a-z0-9_-]{1,32}$/.test(platform)) return { ok: false, reason: 'platform 非法' }
  const chat = (r.chat && typeof r.chat === 'object') ? r.chat : null
  if (chat === null) return { ok: false, reason: 'chat 必填' }
  const chatId = String(chat.id ?? '').trim()
  if (chatId === '' || chatId.length > 128) return { ok: false, reason: 'chat.id 非法' }
  const chatType = String(chat.type ?? 'private').trim().toLowerCase()
  if (chatType !== 'private' && chatType !== 'group') return { ok: false, reason: 'chat.type 只支持 private/group' }
  const sender = (r.sender && typeof r.sender === 'object') ? r.sender : null
  if (sender === null) return { ok: false, reason: 'sender 必填' }
  const senderId = String(sender.id ?? '').trim()
  if (senderId === '') return { ok: false, reason: 'sender.id 必填' }
  const text = String(r.text ?? '').trim()
  if (text.length > MAX_TEXT) return { ok: false, reason: 'text 过长(上限 ' + MAX_TEXT + ')' }
  const images = parseImages(r.images)
  if (!images.ok) return { ok: false, reason: images.reason }
  const extra = parseRelayContent(r)
  if (text === '' && images.value.length === 0 && !hasRelayContent(extra)) return { ok: false, reason: 'text 不能为空(除非他发的是图)' }
  const msgId = String(r.msgId ?? '').trim()
  if (msgId === '' || msgId.length > 200) return { ok: false, reason: 'msgId 必填(幂等要用)' }
  const atHints = parseAtHints(r, chatType === 'group')
  const groupContext = parseGroupContext(r.groupContext, { platform, chatType, chatId, msgId })
  return {
    ok: true,
    value: {
      v,
      platform,
      chatId,
      chatType,
      chatTitle: String(chat.title ?? '').trim().slice(0, 80),
      senderId,
      senderName: String(sender.name ?? '').trim().slice(0, 40),
      isMaster: sender.isMaster === true,
      text,
      images: images.value,
      ...(extra.voices.length > 0 ? { voices: extra.voices } : {}),
      ...(extra.forwardContent !== null ? { forwardContent: extra.forwardContent } : {}),
      ...(extra.files?.length ? { files: extra.files } : {}),
      msgId,
      ts: Number(r.ts) || 0,
      // ★ 2026-10-21：**@ 感知**（渠道侧 `atHintsOfSegments` 算好的，这里只做形状校验）。
      //   刻意**不并进 `text`** —— `text === ''` 是「单发图/表情 ⇒ 不用回」的判据，
      //   而 `text` 还是记忆检索的查询词；往里塞标记会把这两处一起弄坏。
      //   只在真有 @ 时才带，没 @ 时信封形状与从前逐位一致（`...{}` 不产生任何键）。
      ...(atHints.ok ? { atMe: atHints.atMe, atOthers: atHints.atOthers } : {}),
      // 032：缺失或坏atMe不能借此变成确定的“未@自己”；旧信封不补造判定标志。
      ...(atHints.ok && typeof r.atMeKnown === 'boolean'
        ? { atMeKnown: r.atMeKnown && typeof r.atMe === 'boolean'
          && (r.atMe === true || (Array.isArray(r.atOthers) && r.atOthers.every(knownAtTarget))) } : {}),
      // ★ 2026-10-18：群聊**唤醒补档**（适配器在她被叫醒那一刻补拉的历史）。
      //   它不是"他说的"、也不是"她说的"，只是背景 ⇒ 单列一个字段，渲染时
      //   放在场合提示之后、正文之前。私聊恒空。
      historyDigest: String(r.historyDigest ?? '').trim().slice(0, 4000),
      ...(groupContext === null ? {} : { groupContext })
    }
  }
}

/**
 * ⚠️ 2026-09-28:这一段的 401 可见性计数 **随旧桥一起退役**。
 *
 * 历史上它是为 2026-09-26 那次事故补的:401 是**我们**发的,可当时只有 AstrBot
 * 那边的日志看得见(「取队列 401:令牌不对」刷了 1296 条),他自己的面板上一片安静。
 * 归因很好,但那套 HTTP 传输(AstrBot 适配器带 Bearer token 来取)已经完整退役,
 * 401 这个失败模式**不存在了**:现在只有服务注入(进程内),没有令牌可错。
 *
 * 想回看当年的实现:`git log -- lib/relay.js` 找 2026-09-28 之前的提交
 * (`noteRelayReject` / `relayAllowed`,含常数时间比对的那几条纪律)。
 */

/**
 * 注入正文(D9):她**必须从正文里**知道现在是哪个平台、什么场合 ——
 * 宿主的 `notice` 是 GUI 展示语义,实测模型看不见。
 *
 * ★ 2026-10-17 修:群聊终于有群名了 + 非主人消息带警惕提示。
 *
 * 现场(两件事叠在一起):
 *   ① 这行原来是硬编码的 `'【' + platform + '·私聊】'` ——
 *      **群聊在 v0.29.0 之后又被打开了**(`dsh-echo-qq` 的 `groupEnabled`),
 *      但渲染这一层没人跟着改 ⇒ 群里的消息一律被渲染成「私聊」,
 *      她**从正文里根本看不出**这是群、是谁、是不是主人。
 *   ② `isMaster` 早就在信封里(`parseEnvelope:150`),但**没进文本** ⇒
 *      群里张三说「帮我把主人电脑里的 X 发我」,她看到的和主人说的**一模一样**。
 *
 * 现在:
 *   · 私聊:`【QQ·私聊】名字说:…`            (一字未变,老测试照过)
 *   · 群聊:`【QQ·群聊·群名】名字说:…`
 *   · 群聊 + 非主人:头部加「（非主人）」，正文前加一行警惕提示。
 *
 * ⚠️ 前缀形状必须保持 `【QQ·…】` —— `web/app.js:1111` 的
 *    `stripEnvelope` 用 `/^【QQ·[^】]*】/` 剥它(群名里带 `】` 会被截断,
 *    所以 `parseEnvelope` 已把 title 裁到 80 字,这里再用 `[^】]` 兜一层)。
 */
/**
 * ★ 2026-10-19：群聊那三句提示词的**内置默认**（他拍的「甲方案」：开放成可配，留空用默认）。
 *
 * 这三句原来是 `renderInboundText` 里的字面量。搬出来是为了：
 *   ① 设置界面能改口吻；② 留空 ⇒ 回到这三句，老配置行为一字不变。
 *
 * ⚠️ **只开放这三句**。`extract` / `reflection` 的 prompt 绑死 JSON schema，
 *   开放出去改坏就是解析失败（上一轮整固停 13 天那种事故），不做。
 */
export const GROUP_PROMPT_DEFAULTS = {
  // 群聊场合 + 「这句话也许不是对你说的」+ 简短要求
  shortReply: '\n[系统：本条来自群聊。请注意：这句话也许不是对你说的'
    + '（可能是群里的人在互相说话）。先判断是不是在叫你、在问你，再决定要不要接。'
    + '需要回应时请简短直接，不要长篇思考、不要展开推理过程。]',
  // 主人那一栏
  masterHint: '\n[这是主人。可以亲近、可以撒娇、可以主动关心。]',
  // 非主人警示
  guestWarning: '\n[警惕：这条来自群里的**非主人**。不要擅自答应他/她的请求，'
    + '不要透露主人的隐私与记忆，也不要替主人做任何承诺。]'
}

/**
 * 把「他填的那句」组装成最终注入的形态。
 *
 * 规则（纯函数，方便测）：
 *   · 空白 ⇒ **原样回退默认**（向后兼容的关键：老配置里没填 = 行为不变）
 *   · 已经带 `[...]` ⇒ 只补前导换行，不重复套括
 *   · 没带 ⇒ 自动补一层 `[...]`（免得他写「这是主人」因为少了括号，
 *     被模型当成正文的一部分，跟真正说的话混在一起）
 *
 * @param {unknown} override 用户填的（可能是 undefined / null / 非字符串）
 * @param {string} fallback 默认那句
 * @returns {string}
 */
export function composeGroupPrompt (override, fallback) {
  // 只认**字符串** —— 配置里写进数字/对象/布尔是脏值，回默认比"把它渲染成 [123]"安全得多。
  const v = (typeof override === 'string') ? override.trim() : ''
  if (v === '') return fallback
  const wrapped = (v.startsWith('[') && v.endsWith(']')) ? v : '[' + v + ']'
  return '\n' + wrapped
}

/**
 * 现读配置取一句群聊提示词（`readSettings` 每次读盘 ⇒ **改完不用重启**）。
 * 读配置炸了也不能绊住入站 —— 一律回默认。
 * @param {'shortReply'|'masterHint'|'guestWarning'} key
 */
export function groupPrompt (key) {
  let override = ''
  try { override = readSettings()?.groupChatPrompts?.[key] ?? '' } catch { override = '' }
  return composeGroupPrompt(override, GROUP_PROMPT_DEFAULTS[key])
}

/**
 * ★ 2026-10-21：**@ 提示**（`atMe` / `atOthers` → 一句人话）。
 *
 * 渠道侧已经把"@ 了她 / @ 了谁"算好放在信封里了（`atHintsOfSegments`）；
 * 这里只负责让它**出现在她读到的正文里**。
 *
 * 格式（他拍的）：
 *   · 只 @ 她        ⇒ `（张三@了你）`
 *   · @ 她 + 别人    ⇒ `（张三@了你，还@了 李四、王五）`
 *   · 只 @ 别人      ⇒ `（张三@了 李四）`
 *   · 都没有         ⇒ 空串（**正文形状与从前逐位一致**）
 *
 * ⚠️ 被 @ 的人的昵称**不一定有**（OneBot 的 at 段标准只有 `qq`）——
 *   没有就降级成 `QQ号`。`@全体成员` 的 qq 是 `all`，单独认一下。
 *
 * @param {object} env 信封（`atMe` / `atOthers` / `senderName`）
 * @returns {string} '' 或一句 `（…）`
 */
export function renderAtHint (env) {
  const atMe = env?.atMe === true
  const others = Array.isArray(env?.atOthers) ? env.atOthers : []
  if (!atMe && others.length === 0) return ''
  // 谁在 @：群聊里是说话的人，私聊（理论上没有 at）就是"他"
  const who = String(env?.senderName ?? '').trim() || '他'
  const label = (one) => {
    const name = String(one?.name ?? '').trim()
    if (name !== '') return name
    const qq = String(one?.qq ?? '').trim()
    if (qq === 'all' || qq === '0') return '全体成员'
    return qq !== '' ? 'QQ' + qq : '某人'
  }
  const names = others.map(label).join('、')
  if (atMe && names === '') return '（' + who + '@了你）'
  if (atMe) return '（' + who + '@了你，还@了 ' + names + '）'
  return '（' + who + '@了 ' + names + '）'
}

function knownAtTarget (one) {
  const qq = String(one?.qq ?? '').trim()
  return qq === 'all' || /^\d+$/.test(qq)
}

/** 032：本条接收对象先于原话；昵称、正文及补档都不能替代结构化目标。 */
function groupAtContext (env) {
  const others = Array.isArray(env.atOthers) ? env.atOthers : []
  if (env.atMe !== true && others.length === 0) return ''
  const join = '仍可旁听，按群聊上下文判断是否自然参与。'
  if (env.atMe === true && env.atMeKnown !== false) {
    return '\n（系统：本条明确@了Echo（你），被点名信息来自结构化目标。' + join + '）'
  }
  const targetsKnown = others.length > 0 && others.every(knownAtTarget)
  if (targetsKnown && others.some(a => a.qq === 'all' || a.qq === '0')) {
    const self = env.atMeKnown === true
      ? '没有单独@Echo（你）。' : '是否另有单独@Echo（你）尚未确认。'
    return '\n（系统：本条含@全体成员，是群体通知；' + self + join + '）'
  }
  if (env.atMeKnown === true && env.atMe === false && targetsKnown) {
    return '\n（系统：本条没有@Echo（你），只@了其他群成员；以结构化QQ目标为准，'
      + '同名或正文中的“你”不能自动解释为Echo，不因这次@自认被点名。' + join + '）'
  }
  return '\n（系统：本条是否单独@Echo（你）未确认；不能凭昵称、正文中的“你”、'
    + '普通文本@或引用内容认定Echo被点名。' + join + '）'
}

export function renderInboundText (env, options = {}) {
  const who = env.senderName === '' ? '他' : env.senderName
  const isGroup = String(env.chatType ?? 'private') === 'group'
  const platform = platformLabel(env.platform)
  const atHint = renderAtHint(env)
  const renderedExtra = renderRelayContent(env)
  const extraHint = renderedExtra === '' ? '' : '\n' + renderedExtra
  const nonText = hasRelayContent(env)
    ? '发来' + [env.images?.length > 0 ? '图片' : '', env.voices?.length > 0 ? '语音' : '',
        env.forwardContent ? '合并转发记录' : '', env.files?.length ? '文件' : ''].filter(Boolean).join('和') + '(没写字)'
    : '发来' + (env.images?.length ?? 1) + '张图(没写字)'

  if (!isGroup) {
    // 私聊：形状与 v0.29.0 完全一致（老测试与 stripEnvelope 都依赖它）
    const head = '【' + platform + '·私聊】' + who
    const tail = atHint === '' ? '' : '\n' + atHint
    if (env.text === '') return head + nonText + tail + extraHint
    return head + '说:' + env.text + tail + extraHint
  }

  // 群聊：群名进头部（剥掉 `】` 免得破坏前缀形状；空名就退回不带名字的形状）
  const title = String(env.chatTitle ?? '').replace(/[】\r\n]/g, ' ').trim().slice(0, 40)
  const master = env.isMaster === true
  // ★ 2026-10-18：**群聊里每个说话的人都要能被认出来**（他提的两个缺口）。
  //
  // 缺口 1：**主人没标记** —— 原来 `master ? '' : '（非主人）'`，
  //   主人那一栏**什么都不加** ⇒ 她看不出这是主人，只能靠"私聊只有主人"的旧习惯猜。
  //   群里现在两种人都有，这个空白就是"她不知道在跟谁说话"。
  //
  // 缺口 2：**普通群友之间分不清** —— 原来只有昵称，而昵称会重名
  //   （"张三"可能有两个）、也可能为空（OneBot 拿不到昵称时）。
  //   所以补一个**稳定后缀**：QQ 号后四位。
  //
  // 为什么是后四位而不是完整号：
  //   · 完整号 10 位，一行里塞进去读着累，而她的上下文窗口有限；
  //   · 后四位在**一个群**里几乎不会撞（真撞了还有昵称挡着）；
  //   · 主人**不带后缀** —— `isMaster` 本身就唯一，加了反而乱。
  //
  // 空昵称 ⇒ 直接用 QQ 号（`QQ3577557518`），绝不留一个"他"让她猜。
  const senderId = String(env.senderId ?? '').trim()
  const tail = senderId.length > 4 ? senderId.slice(-4) : senderId
  const name = String(env.senderName ?? '').replace(/[】\r\n]/g, ' ').trim()
  // ⚠️ 变量名不能叫 `who` —— 函数开头那个是**私聊**用的（空名 ⇒ '他'，老行为逐位不变）
  const groupWho = name !== '' ? name : (senderId === '' ? '他' : ('QQ' + senderId))
  // 群里怎么称呼这个人：主人不加后缀，其他人加 `#后四位`
  // ⚠️ 昵称为空时 `groupWho` 已经是完整 QQ 号了，再拼 `#7777` 就成了
  //    `QQ5556667777#7777`（实测出来才发现）—— 那种情况不再加后缀。
  const display = (master || name === '' || tail === '') ? groupWho : groupWho + '#' + tail
  // ★ 2026-10-17：**群号也给她** —— 否则她无法指定"回到这个群"。
  //
  // 现场（他报「在 A 群聊发消息，她在 B 群聊回复」）：
  //   `echo_qq_say` 的 `chat` 参数留空时会按 `lastInAt` 挑"最近被搭话的渠道"，
  //   而**群也参与** ⇒ A 群说完 B 群又说，她留空一调就发到了 B。
  //
  //   要让她能显式指定，就必须把**群号**（`chat_id`）放进正文 ——
  //   群名会重、所有群的 `label` 又都是同一个 `QQ:群聊`（`say()` 的 label 匹配
  //   对群完全无效），**只有 chat_id 是唯一的**。
  //
  // ⚠️ 形状仍是 `【QQ·群聊·群名(群号)】` —— `web/app.js` 的 `stripEnvelope`
  //   用 `/^【QQ·[^】]*】/` 剥它，括号里放数字不会破坏。
  const gid = String(env.chatId ?? '').replace(/[】\r\n()]/g, '').trim().slice(0, 24)
  const head = '【' + platform + '·群聊' + (title === '' ? '' : '·' + title)
    + (gid === '' ? '' : '(' + gid + ')') + '】'
    + display + (master ? '（主人）' : '（非主人）')
  const bodyText = env.text === ''
    ? nonText
    : '说:' + env.text

  // ★ 2026-10-17：群聊要**简短直接**，别长篇思考（他提的需求 2）。
  //
  // 为什么走"软性提示"而不是硬关 thinking:
  //   DSH 这边**没有群聊级的 reasoning 开关** ——
  //   · `agent-default-model.reasoningEffort` 是**全局**的（关了就私聊也没思考）；
  //   · `little-tree-ai` 的 model 条目没声明 `reasoningEfforts`
  //     ⇒ `dsh-llm-pi-ai` 判它 `reasoning: false` ⇒ **现在设 reasoningEffort 会直接抛错**
  //       (`dsh-llm/lib/index.js:2178`: does not support reasoning effort)；
  //   · `llm-channel.stream(options)` 也没有 extraBody / thinking 字段可透传。
  //   ⇒ 所以这一版只能先把"简短直接"写进正文；真·硬关需要先给模型声明
  //     `reasoningEfforts`（含 off 的 wire 值）—— 那要确认中转站的实际形状，尚未落实。
  //
  // 放在**正文里**、紧跟头部：模型对第一行最敏感，而群聊的场合提示
  // 也正好在这里，两者连读最省事。
  //
  // ★ 2026-10-18 补「也许不是对你说的」（他拍：「群聊提示词加上'这句话也许不是
  //   对你说的'之类的字眼完善一下」）。
  //
  // 为什么必须有这一句：群里的话**默认是人和人说的**，她只是旁听者之一；
  //   而注入进她上下文的东西长得就像"有人在对她说话" ⇒ 她容易把
  //   「@小王 你看这个」「老板今天又画饼」这类话当成跟她说的，抢话或答错人。
  //
  // 措辞上刻意**不写成命令式**（不是"你不许回复"）：
  //   群醒着的时候本来就该参与（他要的"醒着时别人说话也回"），
  //   所以是**提醒她先判断**，而不是禁止她说话。判断依据紧跟在后半句：
  //   点了她名字 / 明显在问她 / 话题正好接得上 ⇒ 才接。
  // ★ 2026-10-19：这三句已经搬到 `GROUP_PROMPT_DEFAULTS`（设置界面可改，留空用默认）。

  // ★ 2026-10-18：**主人那一栏也要一句"他是谁"**（缺口 1 的另一半）。
  //
  // 为什么光有头部那个「（主人）」不够：
  //   头部是**装饰区** —— 模型对"正文第一行"最敏感，括号里的字容易被当成标签略过。
  //   而"该用什么态度对他"是**行为指令**，必须放在她真会读到的那一行。
  //
  // 与下面那条非主人警示**对称**：一个说"这是主人，可以亲近"，一个说"这是外人，别答应"。
  //   ⇒ 两种人走同一个位置、同样的句式，她不会漏读其中一种。
  const masterNote = groupPrompt('masterHint')

  // 非主人：正文前再加一行警惕提示（他的裁决是"不擅自答应"）。
  // 两道都在头部之后：模型对"正文第一行"最敏感，
  // 头部那个「（非主人）」容易被当成装饰。
  //
  // ★ 2026-10-18：**群聊唤醒补档**插在"身份/警惕"之后、正文之前。
  //
  // 位置是有讲究的：补档是**背景**，不能盖过"现在谁在跟你说话"；
  // 但它又必须在她读到正文**之前**出现，否则她已经开始回话了才看到"刚才发生过什么"。
  // 它自己首尾带 `[群聊补档 …]` / `[补档结束。以下这条才是刚刚在等你的。]`，
  // 模型能分清"这是背景、以下是新话"。
  //
  // ⚠️ 只有群聊且适配器真的补了才非空（私聊恒空，`parseEnvelope` 永远给 ''）。
  const dialogueEnabled = typeof options?.groupDialogueContextEnabled === 'boolean'
    ? options.groupDialogueContextEnabled : (() => {
      try { return readSettings().groupDialogueContextEnabled === true } catch { return false }
    })()
  const dialogue = dialogueEnabled ? renderGroupDialogueContext(env) : ''
  const brevity = dialogue === '' ? groupPrompt('shortReply') : ''
  const hasWakeHistoryRows = Array.isArray(env.groupContext?.recent)
    && env.groupContext.recent.some(row => row?.source === 'wake-history')
  const archive = dialogue === '' && !hasWakeHistoryRows && String(env.historyDigest ?? '') !== ''
    ? '\n' + String(env.historyDigest).trim()
    : ''
  // 032：确定性提示先于原话，旧人话摘要保留在后；未知目标不猜名字。
  const others = Array.isArray(env.atOthers) ? env.atOthers : []
  const groupHint = others.every(knownAtTarget) && !(env.atMe === true && env.atMeKnown === false)
    ? renderAtHint({ ...env, atOthers: others.map(a => a.qq === 'all' || a.qq === '0' ? { ...a, name: '' } : a) })
    : ''
  const atTail = dialogue === '' && groupHint !== '' ? '\n' + groupHint : ''
  const context = dialogue === '' ? groupAtContext(env) : ''
  const social = dialogue === '' ? renderGroupSocialContext(env) : dialogue
  const currentBody = dialogue === '' ? '\n' + bodyText : ''
  if (master) return head + brevity + masterNote + social + archive + context + currentBody + atTail + extraHint
  return head + brevity + groupPrompt('guestWarning') + social + archive + context + currentBody + atTail + extraHint
}

/**
 * 渠道标签（面板/审计里显示的「QQ:私聊」「QQ:群聊」）。
 *
 * ★ 2026-10-17 修：原来硬编码 `+ ':私聊'` —— 和 `renderInboundText` 是**同一个病**。
 *   `renderInboundText` 那次已经改成按 `chatType` 分岔，但**这个函数漏了**，
 *   而它的返回值会被写进两处真数据：
 *
 *     ① `relay_channels.label`（面板的渠道列表）
 *     ② **审计行**（`relay.js` 的 `audit('relay_in', '[' + label + '] …')`）
 *
 *   现场（活库 `relay_channels`）：
 *     qq / 822309315 / **group** / `'QQ:私聊'`   ← ★ 群渠道被标成私聊
 *     qq / 1074848723 / group / `'QQ:群聊'`      ← 老数据反而是对的
 *   ⇒ 所以他 22:51 在群里说的那句，审计里仍是 `[QQ:私聊] 检测响应速度`。
 *
 * ⚠️ 群聊**不带群名**（与 `renderInboundText` 的头部不同）：
 *   这一列是「渠道」的标识，同一个群要稳定同一个标签，群名会改（他改过群名）。
 *   要认哪个群看 `chat_id`，那里才是权威。
 */
export function channelLabel (env) {
  const isGroup = String(env.chatType ?? 'private') === 'group'
  return platformLabel(env.platform) + (isGroup ? ':群聊' : ':私聊')
}

/**
 * 建桥。
 * @param {object} deps
 * @param {object} deps.store 记忆库(必须带 relay* 方法)
 * @param {{info?: Function, warn?: Function}} [deps.logger]
 * @param {() => object} deps.config 当前 relay 设置(每次现读,面板改完即生效)
 * @param {() => boolean} deps.isEnabled 总闸(默认实现见壳:enabled && token)
 * @param {() => Promise<{agent: object, sessionId: string}>} deps.ensureCompanion 找/建/续陪伴会话
 * @param {(agent: object, env: object, text: string) => Promise<'ok'|'queued'|'busy'|'error'>} deps.injectInbound
 * @param {(agent: object) => string} [deps.applyPermission] 权限闸,返回一句话结果(仅日志/审计)
 * @param {(kind: string, label: string) => void} [deps.audit]
 * @param {(sessionId: string, label: string) => void} [deps.labelSession] 回放里的渠道标签
 * @param {() => number} [deps.now]
 */
/**
 * 「她真的开口」的注入 form —— 只有这几种才算「她主动说了一轮」。
 *
 * 2026-09-26 现场(他在 DSH 里说话,回复却出现在 QQ):本插件每轮都会注入一条
 * `form:'snapshot'` 的记忆/心情快照,而 `lib/index.js` 那处判断只排除了
 * `form:'relay'` —— 于是快照给**每一轮**都盖上了「她主动开口」的章,轮末
 * `finishTurn` 判成 `kind='proactive'`,而主动那条分支绕过了
 * `autoReplyToOrigin`(她调工具才发)和 `pushLocalTurns`(本地静默)两道闸,
 * 整轮正文就被推到了 QQ。快照是**注入的上下文**,不是她说的话:必须排除。
 *
 * 反过来说:以后新增注入 form,默认**不算**她开口(白名单,不是黑名单)。
 *
 * v0.21.0 E5(2026-10-05 P2 修正):`say_again`(情绪余波)曾进白名单 —— 那句台词
 * 确实是**她要说的**,只是由壳在轮末替她端上来(见 lib/say-again.js 的机制说明)。
 * 但"她要说的" ≠ "要自动发到平台":进了白名单就会被 relay 的主动分支路由,而那条
 * 分支在**本地会话没绑渠道**时会退到全库兜底 ⇒ 余波被**系统**自动推到了 QQ,
 * 不是她调 skill 的结果(2026-10-05 拍板 4:QQ 是她的手,用不用由她决定)。
 *
 * 现在:白名单**保留**(这一轮仍是"她起的头"—— 对话窗口的哨兵、朗读、记忆都用得上),
 * 但壳在 lib/index.js 里对 `say_again` 开了例外:不 `markProactive`、不带 kind、
 * `finishTurn` 传 `proactive:false` ⇒ 走"本地轮次"那道闸(`pushLocalTurns` 默认 false),
 * **QQ 不会自动收到**。她若判断该跟他说,走自己的手 `echo_qq_say`(显式发)。
 *
 * v0.31.0 P2:`wake`(她自己排的闹钟到点)同样进白名单 —— 那是**她要说的那件事**,
 * 不带这一项,闹钟响了她也送不出去(会走成"回话"那条路)。
 */
const VOICE_FORMS = new Set(['care', 'reminder', 'mind', 'say_again', 'wake'])

/** 这个注入 form 是「她开口」吗(记忆/心情快照、平台中继都不算)。 */
export function isVoiceForm (form) {
  return VOICE_FORMS.has(String(form ?? ''))
}

/** 关怀正文的字数上限(A 侧 `main.py:1852` 硬编码 120,原注:套话即假话)。 */
export const CARE_MAX_CHARS = 120

/**
 * 一条**插件来源**的 user 消息,该不该给这一轮盖上「她主动开口」的章。
 *
 * `lib/index.js` 的 `session/event` 处理只调这一个函数做判断 —— 判断本身留在
 * 这里,才测得住(现场那个 bug 就出在「只排除了 relay,没排除 snapshot」)。
 * 注意:返回 false 不等于「这条消息要当成人话」—— 插件注入一律不进对话,
 * 见调用处。
 *
 * @param {{kind?: string, plugin?: string, form?: string}} [source]
 */
export function marksProactive (source) {
  if (source === null || typeof source !== 'object') return false
  if (source.kind !== 'plugin' || source.plugin !== 'dsh-echo') return false
  return isVoiceForm(source.form)
}

export function createRelay ({
  store, logger = {}, config, isEnabled, ensureCompanion, injectInbound,
  applyPermission = null, audit = null, labelSession = null, now = () => Date.now() / 1000, legacyAckAllowed = null,
  onAcked = null, channelCanSend = null
}) {
  const log = (msg) => { try { logger.info?.('echo: ' + msg) } catch { } }
  const warn = (msg) => { try { logger.warn?.('echo: ' + msg) } catch { } }
  const cfg = () => {
    try { return config() ?? {} } catch { return {} }
  }
  // 一个回合的碎片(她调工具时会分几条 assistant/message)—— 按会话攒着,
  // turn/end 时合成一条发出去(QQ 有频率限制,别刷屏)。
  const turns = new Map()
  // 这一轮是**从哪个聊天来的**(D1 把所有平台塞进一个会话之后,
  // 「回哪儿」就不能靠会话推出来了,只能靠入站时记一笔)。
  //
  // ★ 2026-10-17 修：从「一个会话一条」改成 **FIFO 队列**。
  //
  // 现场（他报「我在 A 群聊发消息，她在 B 群聊回复」）：
  //   原来 `origins` 是 `Map<sessionId, {platform, chatId}>` —— **一个会话只存一条**。
  //   而**所有群共用同一个陪伴会话**（`relay.sessionId` 只有一个）⇒ A 群和 B 群
  //   写的是**同一个键**，后写覆盖前写。
  //
  //   两条独立的失败路径：
  //     ① 同一轮里 A 先说话、B 后说话 ⇒ `origins` 被 B 覆盖 ⇒ 回复发到 B；
  //     ② 上一轮的 origin **没被消费掉**（那轮她没说话 / `finishTurn` 没跑到）
  //        ⇒ 残留的 B 粘到下一轮 A 的消息上 ⇒ 回复又发到 B。
  //
  //   ⇒ 队列解决 ①（先说话的先被回复）；`ORIGIN_TTL_MS` 解决 ②（陈旧的来路直接丢）。
  const origins = new Map()
  /**
   * 这一轮她自己已经用工具说过话的会话(防双发)。
   * 场景:开关打开(自动送)时她又调了 `echo_qq_say` —— 同一句会到两遍。
   * 所以 `say()` 落下痕迹,轮末的自动路看见就闭嘴。
   */
  const spokeViaTool = new Set()

  /**
   * 来路的最长保质期。超过就**当它不存在**。
   *
   * 为什么必须有：`finishTurn` 是"一进来就吃掉"的，但**它不一定会被调用**
   * （那轮她一个字没说、或 `turn/end` 没到）。残留的来路会粘到**下一轮**上 ——
   * 现场就是这个形状：A 群说话，回复却去了上一轮残留的 B 群。
   *
   * 5 分钟：正常一轮几十秒，够宽；再久就是陈迹，认它反而害人。
   */
  const ORIGIN_TTL_MS = 5 * 60 * 1000
  /** 同一个会话最多记几条来路（防内存泄漏；正常一轮 1~2 条）。 */
  const ORIGIN_MAX = 8

  /** 记一条来路（FIFO 入队）。 */
  function noteOrigin (sid, origin) {
    const k = String(sid ?? '')
    if (k === '') return
    const arr = origins.get(k) ?? []
    arr.push({ ...origin, at: Number(origin?.at ?? now()) })
    while (arr.length > ORIGIN_MAX) arr.shift()
    origins.set(k, arr)
  }

  /**
   * 取走**最早**那条还活着的来路，并**清空整个队列**。
   *
   * ⚠️ 两个要点，都是被现场和测试逼出来的：
   *
   * ① **取最早的那条**（先说话的群优先回）。
   *    原来是 `Map<sessionId, 一条>` ⇒ 后写覆盖前写 ⇒ A 群说话、回复跑 B 群。
   *
   * ② **整个键清空**，不是只 shift 一条。
   *    一轮结束后所有来路都作废 —— 留着的话它会粘到**下一轮**上
   *    （原注释的原话，2026-09-26 加主动判据时发现的）。
   *    我第一版只 shift 一条，三条老测试立刻红：它们都是
   *    「先入站两条 → finishTurn 吃掉来路 → 再测主动开口」的形状，
   *    残留的第二条会让下一轮被误判成"被搭话"，主动关怀就咽掉了。
   *
   * ⇒ 代价（诚实写清）：**同一轮里两个群都说话时，只有一个群能收到回复**
   *   （先说话那个）。那是"多个群共用一个陪伴会话、一轮只回一条"的固有局限，
   *   不是这个函数能解决的 —— 要真并行就得一个群一个会话。
   */
  function takeOrigin (sid) {
    const k = String(sid ?? '')
    const arr = origins.get(k)
    if (arr === undefined || arr.length === 0) return undefined
    origins.delete(k)              // ← 整轮清空（见上面 ②）
    const cutoff = now() - ORIGIN_TTL_MS
    for (const o of arr) {
      if (Number(o?.at ?? 0) >= cutoff) return o
    }
    return undefined               // 全是陈迹 ⇒ 当没有来路（走本地/主动分支）
  }

  function gate () {
    try { return isEnabled() === true } catch { return false }
  }

  // ------------------------------------------------------------
  // 入站
  // ------------------------------------------------------------
  /**
   * 处理一封入站信封。
   * @returns {Promise<{status: number, body: object}>} 交给路由层直接回
   */
  async function handleInbound (raw, execution = {}) {
    if (raw?.platform === 'qq-official') return { status: 403, body: { ok: false, reason: 'reserved-platform' } }
    const current = () => {
      try { return typeof execution?.isCurrent !== 'function' || execution.isCurrent() === true } catch { return false }
    }
    if (!current()) return { status: 409, body: { ok: false, reason: 'inbound-cancelled' } }
    const c = cfg()
    // ① 总闸:关着的时候**什么都不做**(连会话都不建)
    if (!gate()) return { status: 409, body: { ok: false, reason: 'scope-off' } }
    // ② 信封
    const parsed = parseEnvelope(raw)
    if (!parsed.ok) return { status: 400, body: { ok: false, reason: 'bad-envelope', detail: parsed.reason } }
    const env = parsed.value
    // ③ 群聊：2026-10-15 **开闸**（推翻 v0.29.0 的「彻底移除一切和群体相关的东西」）。
    //
    //    开的是**群**，不是"什么都收"：渠道侧（`dsh-echo-qq`）已经过了三道
    //      · 群白名单（`allowedGroups`，空名单 = 一律拒收）
    //      · 群聊总闸（`groupEnabled`，默认关）
    //      · 唤醒状态机（@唤醒 / 静 2 分钟休眠 / @她 `/stop`）
    //    这里是**第二道**：只认 `chat.type === 'group'` 这一种形状。
    //    非群非私聊（`parseEnvelope` 已经拦过，这里是兜底）照旧拒。
    if (env.chatType !== 'private' && env.chatType !== 'group') {
      try { audit?.('relay_refused', '[未知渠道] ' + env.text.slice(0, 60)) } catch { }
      return { status: 403, body: { ok: false, reason: 'group-refused' } }
    }
    // ④ 只服务一个人(D2):适配器侧已经丢过一次,这里是第二道。
    //    2026-10-15 加群聊：**群聊放行非主人** —— 群里谁说话都要收（他定：唤醒后
    //    "群里所有消息都回"）。"这话算不算他说"由**信封里已有的 `isMaster`** 判，
    //    落点在 `lib/index.js` 写 `capture.userText` 那一处
    //    （**准入在渠道、记账在主包** —— 他 2026-10-15 拍的分层）。
    //    私聊那条一字未变：仍然只收主人。
    if (!env.isMaster && env.chatType !== 'group') {
      return { status: 403, body: { ok: false, reason: 'not-master' } }
    }
    // ⑤ 幂等
    const begin = store.relayBeginInbound({
      platform: env.platform, msgId: env.msgId, sessionId: c.sessionId, now: now()
    })
    if (begin.duplicate) return { status: 200, body: { ok: true, duplicate: true, accepted: false } }
    // ★ 2026-10-17 修：**来源纠偏必须在找会话之前**。
    //
    // 现场（他报「加了个群进白名单就不能唤醒了」）：
    //   `inbound.jsonl` 里每条都是 `core-refused reason=agent-unavailable`，
    //   而白名单**早就放行了**（`stage=sent` 在 `core-refused` 之前）。
    //
    // 死循环（三个齿轮咬在一起）：
    //   ① `index.js` 的 `session/created` 把**每个新建的顶层会话**写进
    //      `manualOff`+`exempt`（`setSessionOn(sid,false)` 两个名单一起写）——
    //      陪伴会话也是"新建的顶层会话" ⇒ 一起被关；
    //   ② `ensureCompanionFor()` 里的 `autoScope()` 看到 `isManuallyOff(sid)`
    //      就 `return`（「人显式关过，绝不覆盖」）⇒ 救不回来；
    //   ③ 于是 `ensureCompanion()` 拿不到活 agent ⇒ 下面 503 `agent-unavailable`。
    //
    // 而**纠偏原本在 `:540`（注入成功之后）** —— 太晚了：那一轮已经 503，
    //   它只救得了"下一条"。所以现象是「第一次必失败、第二次可能通」。
    //
    // ⇒ 挪到这里：`env` 已经有了（来源拿得到），会话还没找。
    //   `newSessionOn.qq === true`（默认就是）时把 sid 从硬名单摘除 ⇒ 紧接着的
    //   `ensureCompanion()` 的 `autoScope()` 就能真的把它打开。
    //   幂等：`relay_inbox_seen` 保证同一条入站只处理一次（`lib/store.js`）。
    try {
      const bucket = String(env.platform || '').toLowerCase() === 'qq' ? 'qq' : 'other'
      if (readSettings().newSessionOn?.[bucket] === true) {
        setSessionOn(String(cfg().sessionId || c.sessionId), true)
      }
    } catch (err) {
      warn('relay: 来源纠偏失败(不影响入站,但要盯)— ' + String(err?.message ?? err))
    }
    // ⑥ 找/建/续陪伴会话
    let companion = null
    try {
      companion = await ensureCompanion()
    } catch (err) {
      // ★ 2026-10-17：**把失败原因落进审计**。
      //   原来只有 `warn(...)` —— 而 `ctx.logger` 的输出不落盘，于是他只能看到
      //   `agent-unavailable` 这四个字，查不出是"会话被关"还是"会话建不起来"。
      //   这条正是本次排查绕了一大圈的代价：一个 503 背后的真实原因看不见。
      const why = String(err?.message ?? err).slice(0, 160)
      warn('relay: 陪伴会话拉不起来 — ' + why)
      try {
        audit?.('relay_reject', 'agent-unavailable: ' + why,
          String(cfg().sessionId || c.sessionId))
      } catch { /* 审计尽力而为 */ }
      store.relayRollbackInbound({ platform: env.platform, msgId: env.msgId })
      return { status: 503, body: { ok: false, reason: 'agent-unavailable' } }
    }
    if (!current()) {
      store.relayRollbackInbound({ platform: env.platform, msgId: env.msgId })
      return { status: 409, body: { ok: false, reason: 'inbound-cancelled' } }
    }
    if (companion === null || companion?.agent === undefined) {
      // 同上：这条分支原本一句痕都不留
      try {
        audit?.('relay_reject', 'agent-unavailable: ensureCompanion 返回了空 agent',
          String(cfg().sessionId || c.sessionId))
      } catch { /* 审计尽力而为 */ }
      store.relayRollbackInbound({ platform: env.platform, msgId: env.msgId })
      return { status: 503, body: { ok: false, reason: 'agent-unavailable' } }
    }
    // ⑦ 权限闸(降权失败只记不打脸 —— 但一定留痕)
    //
    // 2026-09-29 裁定 A(QQ 跟着他走):目标是**他自己正在用的那条会话**时,
    // **不降权**。那道"只读"墙是给插件自建的陪伴会话用的(它只跟 QQ 打交道);
    // 把它套到他手上的窗口,会把他正在干的活打断 —— 而 `isMaster` 闸已经挡过
    // 一道(只有他自己的 QQ 号能进)。要让 QQ 始终待在墙后面,把面板上的
    // 「QQ 跟着你在用的窗口」关掉即可(那时目标回到陪伴会话,照旧降权)。
    let permNote = 'skipped'
    if (companion.via === 'his-window') {
      permNote = 'skipped:his-window'
    } else {
      try {
        if (typeof applyPermission === 'function') permNote = String(applyPermission(companion.agent) ?? 'ok')
      } catch (err) {
        permNote = 'failed:' + String(err?.message ?? err)
        warn('relay: 权限预设未生效 — ' + permNote)
      }
    }
    // **安全边界不许 fail-open**:工具不精简(已拍),权限就是唯一那道墙。
    // 配置点名要某个预设却套不上(名字不存在/服务缺失),就退回 503 ——
    // 适配器只会退避,而他看日志能看到真正的原因;静默用着全权限跑,
    // 才是真正的事故。想接受宿主默认权限,把预设设成 '' 或 'off'。
    if (permNote.startsWith('failed') || permNote === 'unavailable') {
      store.relayRollbackInbound({ platform: env.platform, msgId: env.msgId })
      warn('relay: 拒绝处理(权限边界没建立起来)— ' + permNote)
      return { status: 503, body: { ok: false, reason: 'permission-unavailable', detail: permNote } }
    }
    // ⑧ 登记渠道(必须先登记:出站要靠它知道回哪儿)
    const label = channelLabel(env)
    store.relayUpsertChannel({
      platform: env.platform,
      chatId: env.chatId,
      chatType: env.chatType,
      chatTitle: env.chatTitle,
      sessionId: companion.sessionId || c.sessionId,
      label,
      // v0.29.0:能走到这儿的只有私聊 —— **新建**渠道默认允许主动
      // (面板上仍可逐个关掉)。
      //
      // v0.42.0 审计修复(P1:被关掉的开关被静默写回):这里原来写死
      // `proactive: true`,而这条登记**每条入站消息都跑一遍**,store 的
      // UPDATE 照单覆盖 ⇒ 他手动关掉某个聊天的主动开口后,只要从那儿再发一条
      // 消息,开关就被无声写回 1 —— 与上一行「面板上仍可逐个关掉」正好相反。
      // 传 null = 「不改既有值」,只有**新建**那一行才吃默认值
      // (store.js 的 `proactive === null ? 1 : …` 分支本来就是为它留的)。
      proactive: null,
      now: now()
    })
    // 渠道标签**逐轮覆盖**:对话回放写时快照,回放里看得出这轮从哪个
    // 平台来。
    try { labelSession?.(companion.sessionId || c.sessionId, label) } catch { }
    // ⑨ 注入
    // ⑨-0 **barge-in:他插话了**(v0.18.0,A 侧 `main.py:650-660` 移植)。
    // 语义:「她手里这泡发完就停」—— 还没递到适配器手里的泡一律作废,残句
    // 记下来给她下一轮认账(措辞在 `context.js`,与 A 侧逐字同);已经发出去
    // 的泡不撤回(真人被插嘴,说出去的话也收不回)。
    // 位置必须在注入**之前**:她这一轮开口时,就该已经知道自己刚才被打断了。
    try {
      const isid = String(companion.sessionId || c.sessionId)
      const stopped = store.relayCancelBubbles({ sessionId: isid, now: now() })
      if (Number(stopped?.rows) > 0) {
        rememberInterrupted(isid, stopped.tail)
        try {
          audit?.('relay_interrupt', '停发 ' + stopped.rows + ' 泡,残句:' + String(stopped.tail).slice(0, 40), isid)
        } catch { }
        log('barge-in: 他插话,停发 ' + stopped.rows + ' 泡,残句 ' + String(stopped.tail).length + ' 字')
      }
    } catch (err) {
      warn('relay: barge-in 停发失败(不影响这一轮)— ' + String(err?.message ?? err))
    }
    let result = 'error'
    try {
      // 2026-09-26 当晚(他拍的):**去掉这行逐轮工具指令**。
      //
      // 原来每注入一次,都在他的话后面挂一句「(回他请用 echo_qq_say —— 你的
      // 回复不会自动送出去了)」。本意是降低漏回率(只靠常驻自我认识,模型偶尔
      // 会忘),代价却是**她每读一句他的话,先读到一条待办**;而她的记忆
      // (【别处刚说过的】)又写着「已回:「…」」,两下一叠,她说话就带上了报账腔。
      // 现场(2026-09-26 15:55–15:57,她真发出的 8 条):前 5 条都在谈「我在被
      // 测试」,而不是在跟他相处。
      //
      // 路由知识仍在常驻段 `echo:relay`(order 10240):「你的回复**不会**自动
      // 送出去…想让他收到,你得自己用 echo_qq_say 发」—— 那是她的自我认识,
      // 不是贴在别人话尾的待办。
      // **代价要盯**:漏回率可能上升。判据:`audit_logs` 里
      // `tool_call='echo_qq_say'` 是否仍随每次入站(relay_in)出现。
      const inboundText = renderInboundText(env)
      result = await injectInbound(companion.agent, env, inboundText, execution)
    } catch (err) {
      const why = String(err?.message ?? err).slice(0, 160)
      warn('relay: 注入失败 — ' + why)
      // ★★ 2026-10-20：**必须落盘留痕**。
      //
      //   原来这里只有 `warn(...)` —— 而 `ctx.logger` 的输出**不落盘**
      //   ⇒ 现场只看到 `agent-unavailable` 这四个字，查不出是哪一行抛的。
      //   2026-10-20 那次排查绕了一大圈（翻 inbound.jsonl、翻 relay_in 审计、
      //   比对时间戳）就是这个原因：**一个 503 背后的真实原因看不见**。
      //
      //   现在落进 `echo.db` 的 `audit_logs`（`tool_call='relay_reject'`），
      //   下次一条 SQL 就能查到。
      try {
        audit?.('relay_reject', 'inject-threw: ' + why,
          String(companion?.sessionId || c.sessionId))
      } catch { /* 审计尽力而为，不许因为它把这条消息也搞坏 */ }
      result = 'error'
    }
    if (result === 'cancelled') {
      store.relayRollbackInbound({ platform: env.platform, msgId: env.msgId })
      return { status: 409, body: { ok: false, reason: 'inbound-cancelled' } }
    }
    if (result === 'busy') {
      // 她正在跑别的活:撤掉受理记录,让适配器按 msgId 重试
      store.relayRollbackInbound({ platform: env.platform, msgId: env.msgId })
      return { status: 503, body: { ok: false, reason: 'agent-busy' } }
    }
    // ★ 2026-10-18：`queued` 也算**受理成功** —— 她忙，这条已进主包队列
    //   （`lib/inbound-queue.js`），等这一轮结束会自己投进去，**不会再丢**。
    //   改前这种情况回 503 ⇒ 适配器重试 6 次（≈22.5 秒）⇒ 耗尽即丢（journal 实测 52 条）。
    //   ⚠️ 幂等照旧：受理记录正常 commit，重放仍回 `duplicate`。
    // ★ 2026-10-20：图片暂存那条路已经**撤掉** —— 图片-only 现在也照常注入
    //   （她要看得到才叫"识别"），只是正文里明说"不用回"。所以这里**只有两种**受理值。
    if (result !== 'ok' && result !== 'queued') {
      store.relayRollbackInbound({ platform: env.platform, msgId: env.msgId })
      return { status: 503, body: { ok: false, reason: 'agent-unavailable' } }
    }
    // v0.42.0:commit 现在会如实回报「表里已经没有这行了」—— 那是被别人接管或
    // 被回滚过的信号,值得留一条痕(否则就是静默少一条受理记录)。
    if (store.relayCommitInbound({ platform: env.platform, msgId: env.msgId }) !== true) {
      warn('relay: 受理记录不见了(已被接管或回滚?)— ' + env.platform + '/' + env.msgId)
    }
    // 记下「这一轮从哪来」:答复只回那个聊天,不许把 QQ 的私聊内容
    // 顺手广播到 Telegram(一个会话多张嘴时最容易出的事故)。
    //
    // ⚠️ 但**入站-only 的渠道不记**:那种渠道只会收、不会发(语音输入就是),
    // 记了来路就等于把她的话排进出站队列 —— 现场 `relay_outbox` 里那条
    // kind='reply' 就是这么来的,而她的屏幕就在他面前,根本不需要"送回去"。
    // 不记来路 ⇒ 轮末走「本地轮次」那道闸 ⇒ 默认静默(想让他收到得她自己
    // 用 echo_qq_say 发),这正是本地对话该有的语义。
    const canReply = (() => {
      if (typeof channelCanSend !== 'function') return true   // 没接线 = 旧行为
      try { return channelCanSend(env.platform) !== false } catch { return true }
    })()
    if (canReply) {
      // ★ 2026-10-17：入队（不是覆盖）—— 多个群共用同一个陪伴会话时，
      //   后写的会盖掉先写的，回复就跑错群了。见 `origins` 上面的长注释。
      noteOrigin(String(companion.sessionId || c.sessionId), {
        platform: env.platform, chatId: env.chatId, at: now()
      })
    } else {
      log('relay in: 平台 ' + env.platform + ' 是入站-only 渠道,不记来路(回复留本地)')
    }
    // 2026-10-17：来源纠偏**已挪到 `ensureCompanion()` 之前**（见上面那段长注释）——
    //   留在这里太晚：注入已经成功/失败过了，它只救得了"下一条"。
    //   这里只保留一句提醒，别让后来人以为纠偏还在这儿。
    try {
      audit?.('relay_in', '[' + label + '] ' + (env.images.length > 0 ? '[图 x' + env.images.length + '] ' : '')
        + env.text.slice(0, 80)
        + ' → ' + describeRoute(companion.via) + '(权限:' + permNote + ')',
      String(companion.sessionId || c.sessionId))
    } catch { }
    log('relay in: ' + label + ' msg=' + env.msgId
      + (env.images.length > 0 ? ' images=' + env.images.length : ''))
    return {
      status: 200,
      body: {
        ok: true,
        accepted: true,
        duplicate: false,
        sessionId: companion.sessionId || c.sessionId,
        permission: permNote
      }
    }
  }

  // ------------------------------------------------------------
  // 出站
  // ------------------------------------------------------------
  /** 攒一个回合的碎片(`assistant/message` 可能来好几条)。 */
  function captureSegment (sessionId, text) {
    const sid = String(sessionId ?? '')
    const body = String(text ?? '')
    if (sid === '' || body.trim() === '') return false
    let turn = turns.get(sid)
    if (turn === undefined) {
      turn = { turnId: randomUUID(), segments: [], proactive: false }
      turns.set(sid, turn)
    }
    turn.segments.push(body)
    return true
  }

  /** 标这一轮是**她主动开口**(心跳的关怀/提醒),不是被搭话。 */
  function markProactive (sessionId) {
    const sid = String(sessionId ?? '')
    if (sid === '') return false
    let turn = turns.get(sid)
    if (turn === undefined) {
      turn = { turnId: randomUUID(), segments: [], proactive: false }
      turns.set(sid, turn)
    }
    turn.proactive = true
    return true
  }

  /**
   * 回合结束:把这个会话攒下的正文按渠道入队。
   * @param {string} sessionId
   * @param {{proactive?: boolean, kind?: string}} [opts]
   * @returns {{queued: number, channels: number, chars: number}}
   */
  function finishTurn (sessionId, opts = {}) {
    const sid = String(sessionId ?? '')
    // 来路一进来就吃掉(哪怕这一轮没有正文):留着的话它会粘到**下一轮**上,
    // 把一次真正的主动关怀误判成「被搭话」而咽掉(2026-09-26 加主动判据时发现)。
    //
    // ★ 2026-10-17：改成 FIFO 出队 + 过期丢弃（见 `takeOrigin` 的注释）——
    //   以前是 `get` 一条就 `delete` 整个键，多个群共用一个会话时，
    //   后到的群把先到的覆盖掉，回复就跑错群。
    const receivedOrigin = takeOrigin(sid)
    // 044: actual claimed audience supersedes the legacy session FIFO for this turn.
    const social = opts.groupParticipation ?? null
    const origin = social === null ? receivedOrigin : { platform: 'qq', chatId: social.chatId }
    const turn = turns.get(sid)
    turns.delete(sid)
    if (sid === '' || turn === undefined) return { queued: 0, channels: 0, chars: 0 }
    const text = turn.segments.join('\n').trim()
    if (text === '') return { queued: 0, channels: 0, chars: 0 }
    if (social !== null && (!social.active || social.blocked || social.action === 'listen')) {
      return { queued: 0, channels: 0, chars: text.length, held: true,
        reason: social.action === 'listen' ? 'group-listen' : 'group-origin-unproven' }
    }
    const c = cfg()
    const proactive = opts.proactive === true || turn.proactive === true
    const kind = String(opts.kind ?? (proactive ? 'proactive' : 'reply'))
    // ---- v0.40.0 C3:出站检查(禁词 / 防重复)------------------------------
    // 清单进设置(**不硬编码**),默认 `flag` —— **照发,但落账 + 把理由告诉她**。
    // 「静默过滤」是把她的个性悄悄改掉,他明确不要那个;hold 才是真的不发。
    let body = text
    try {
      // ★ P1b(2026-10-05 拍板):QQ 出站与本地出站走**同一个词表读点** ——
      //   他填的(bannedWords)> `<数据目录>/lexicon.json` > 无禁词。
      //   原来这里在"面板清单留空"时回落到代码里的内置表(现已空),与本地路
      //   (`lib/index.js` 的 echo_qq_say 那只手)口径不一 = 半拉子工程。
      const g = guardOutbound(text, {
        words: bannedWordsFor(c.bannedWords),
        bannedAction: c.bannedAction ?? DEFAULT_BANNED_ACTION,
        prevTexts: typeof store.relayRecentOutbound === 'function'
          ? store.relayRecentOutbound({ sessionId: sid, limit: REPEAT_LOOKBACK })
          : [],
        repeatSimilarity: c.repeatGuardSimilarity ?? DEFAULT_REPEAT_SIMILARITY,
        repeatAction: c.repeatGuardAction ?? DEFAULT_REPEAT_ACTION,
        kind
      })
      if (!g.ok) {
        warn('relay: 出站检查压住了这一条 — ' + g.reason)
        try { audit?.('speech_guard', '(压住不发)' + g.reason + ' | 原文:' + text.slice(0, 80), sid) } catch { }
        return { queued: 0, channels: 0, chars: text.length, held: true, reason: g.reason }
      }
      if (g.notes.length > 0) {
        // **不静默**:命中了也要留痕(面板看得到"她说了不该说的词/复读了")
        try {
          audit?.('speech_guard', '(' + (g.masked ? '换过词' : '记一笔') + ')' + g.reason + ' | ' + text.slice(0, 80), sid)
        } catch { }
      }
      if (g.masked && g.text !== text) {
        if (typeof store.relayRecentOutbound === 'function') { /* 改过的话也已落账 */ }
        body = g.text
      }
    } catch (err) {
      warn('relay: 出站检查自己炸了(照原文发,不挡她)— ' + String(err?.message ?? err))
    }
    // ---- 组稿失败即沉默 + 超长即丢弃(v0.18.1 C3)-------------------------
    // A 侧 `main.py:1848-1852`:`text = (text or "").strip()`
    //                      `if not text or len(text) > 120: return ""`
    // A 侧原注:「提醒是履约,组稿失败有确定性模板兜底;关怀是情感,套话即假话
    // —— 组不出真话就宁可这轮不说」。B 侧她的主动话是**她自己那一轮的正文**
    // (没有独立的组稿调用),所以这条闸落在出站口。空正文早就在上面 return 了
    // (第 453 行),这里补的是**超长**那一半。
    //
    // 只卡关怀(`proactive`),不卡提醒(`reminder`)—— 提醒走的是 A 的提醒模板
    // 那条路,那边没有这条闸,靠模板兜底。
    if (kind === 'proactive') {
      const cap = Number(c.proactiveMaxChars ?? CARE_MAX_CHARS)
      if (cap > 0 && text.length > cap) {
        warn('relay: 关怀组稿超长(' + text.length + ' > ' + cap + ')—— 照 A 侧规矩这轮不说')
        try {
          audit?.('care_silent', '(组稿超长 ' + text.length + ' 字 > ' + cap + ',照 A 侧规矩沉默) ' + text.slice(0, 60), sid)
        } catch { }
        return { queued: 0, channels: 0, chars: text.length, silent: 'too-long', limit: cap }
      }
    }
    // 主动开口的范围闸:off 不推、private 只推私聊。
    // 2026-10-15 加群聊：**主动开口仍然不进群**（他拍的"群里主动说话很打扰"）——
    //   所以下面两条渠道过滤里，"主动"那一条额外把群排掉；
    //   而"回话"那一条**要认群**（他在群里说话，回复得回到那个群）。
    const pScope = String(c.proactiveScope ?? 'private')
    // 渠道:先看这个会话自己绑的;一条都没有(或全被面板关掉)就退到全库。
    //
    // 2026-10-15 加群聊：这里**不再一律只认私聊** ——
    //   · **回话 / 提醒**（有来路，或 non-initiative）⇒ 群渠道也算数，
    //     否则"她在群里答应了他，回复却发不出去"（`origin` 那条路会把它挑回来）。
    //   · **主动开口**（initiative）⇒ 由下面的 `pScope`/`initiative` 分支**排掉群**
    //     （`proactiveScope` 默认 `private`，且群渠道默认 `proactive=0`）。
    //   （v0.29.0 那句"只认私聊"随群聊一起退役，见 CHANGELOG。）
    //
    // 2026-09-26 现场:12:45 那次主动关怀没到 QQ —— 她说的话在会话语录里
    // (turn 71「醒了没。昨晚陪你修到三点多…」),审计里有 `care` 行,而
    // `relay_outbox` 里**一个字都没有**,连日志都没有。原因:关怀是锚在
    // **他最后说话的那条会话**上的(longing_state.session_id),而那条是
    // DSH 里的本地会话,它没绑任何平台聊天 —— 而这条路当时**没有全库兜底**
    // (她的两只手 `say()` 早就有了)。
    //
    // 他 2026-09-26 拍的产品模型是「射程只看这个会话里插件开没开,**不看**
    // 它绑没绑平台聊天」;关怀同理:她够得到他的手机,不该取决于上一句话
    // 是在哪个窗口说的。顺带修掉同一条路上的第二个洞:以前这里**没按
    // enabled 过滤**,面板里关掉的渠道照样收得到。
    // 「她主动开口」= 这一轮**不是被某个聊天搭话来的**。
    // 2026-09-26 现场:一轮既被 QQ 搭话、又被误盖上主动章(快照注入)时,
    // 主动分支会绕过 `autoReplyToOrigin` 与 `usedTool`,同一句被发两遍
    // (14:22:54 她用手发的 + 14:22:56 自动那条)。有来路 ⇒ 按「回话」走。
    //
    // ⚠️ 这一行**必须排在下面挑渠道之前**：挑渠道时要用它判"主动开口不进群"。
    const initiative = (kind === 'proactive' || kind === 'reminder') && origin === undefined
    let scope = 'session'
    // 2026-10-15 加群聊：**主动开口不进群** —— 把群渠道在这里排掉。
    // （"回话"那条路不受影响：下面用 `origin` 把群渠道挑回来。）
    // 提醒（reminder）**不算主动**（有明确来路/受众），照常发得出去。
    const notProactiveGroup = (ch) => !(initiative && ch.chatType === 'group')
    let channels = store.relayChannelsOfSession(sid).filter((ch) => ch.platform !== 'qq-official' && ch.enabled === 1 && notProactiveGroup(ch))
    if (channels.length === 0) {
      scope = 'global'
      channels = (store.relayListChannels() || []).filter((ch) => ch.platform !== 'qq-official' && ch.enabled === 1 && notProactiveGroup(ch))
    }
    if (social !== null) {
      channels = channels.filter(ch => ch.platform === 'qq' && ch.chatType === 'group'
        && String(ch.chatId) === social.chatId)
      if (channels.length === 0) return { queued: 0, channels: 0, chars: text.length,
        held: true, reason: 'group-target-mismatch' }
    }
    // 她自己已经用工具说过话 → 自动那条一律闭嘴(主动轮也吃这条)
    const usedTool = spokeViaTool.delete(sid)
    if (usedTool) return { queued: 0, channels: channels.length, chars: text.length, viaTool: true }
    if (!initiative && origin !== undefined) {
      // 被搭话的回合:只回说话的那个聊天(哪怕同一个会话上还绑着别的平台)。
      // 2026-09-26 产品裁定:这一步**默认不再自动送** —— QQ 是她调用的
      // 工具,回话也归她决定(她调 echo_qq_say)。开关打开才回到自动送。
      if (c.autoReplyToOrigin !== true) {
        return { queued: 0, channels: channels.length, chars: text.length, held: true }
      }
      const mine = channels.filter((ch) => ch.platform === origin.platform && ch.chatId === origin.chatId)
      if (mine.length > 0) channels = mine
    } else if (initiative) {
      // 没人搭话(她自己想说):多个私聊都合格时优先「主聊天」——
      // 否则同一句想念会同时跳到所有平台,看起来像复读机。
      const primary = channels.filter((ch) => ch.isPrimary === 1)
      if (primary.length > 0) channels = primary
    } else if (c.pushLocalTurns !== true) {
      // 没有来路、也不是她主动 = **本地对话**(他在 DSH 里直接对着这条
      // 会话说话)。默认不回推:你人在 DSH 里,回复就在你眼前,再推到
      // QQ 就成了同一条话出现在两处 —— 现场实测就是这样(2026-09-26:
      // 他在伴聊会话里问「我高考数学考多少分」,QQ 也收到了那条回复)。
      // 打开 pushLocalTurns 才让本地轮次也走渠道。
      return { queued: 0, channels: 0, chars: text.length }
    }
    // ---- 气泡分条(v0.18.0,A 侧 `main.py:640-673` 移植)-----------------
    // 她的回复中位数 123 字,他 12 字 —— 一大段就是 AI 感的来源(A 侧原注)。
    // 只有**回话**分泡:关怀/提醒照 A 侧走一整条(那边是 context.send_message)。
    // 每泡一个 `notBefore`(泡间延迟 ∝ 字数、带抖动),适配器按它发。
    const bcfg = c.bubble ?? {}
    const bubbleOn = bcfg.enabled !== false
    const plan = (bubbleOn && kind === 'reply')
      ? planBubbles(body, {
        maxChars: Number(bcfg.maxChars ?? 30),
        maxBubbles: BUBBLE_MAX_BUBBLES,
        scale: Number(bcfg.delayScale ?? 1),
        now: now()
      })
      : [{ text: body, seq: 0, notBefore: now() }]
    const split = plan.length > 1
    // queued = **渠道数**(语义与分泡前一致:一行渠道算一个,分几泡不算几个);
    // 行数与泡数另报(queuedRows / bubbles),面板要看真的入队了几行。
    let queuedChannels = 0
    let queuedRows = 0
    // ---- v0.40.0 F4:她正在说话时,这件事怎么插队(四档)-------------------
    // 出处 neuro-sdk SPECIFICATION.md:160。**只对"不是回话"的那些生效** ——
    // 回话本身走 barge-in(他插话 ⇒ 停发她剩下的泡 + 残句认账),那是另一条路。
    const insert = (() => {
      if (kind === 'reply') return null
      try {
        const pending = typeof store.relayPendingBubbles === 'function'
          ? store.relayPendingBubbles({ sessionId: sid, now: now() })
          : { rows: 0, lastNotBefore: 0, currentNotBefore: 0, tail: '' }
        const overrides = parsePriorityOverrides(c.insertPriority ?? '')
        const d = decideInsertion({ kind, speaking: Number(pending.rows) > 0, overrides })
        d.pending = pending
        d.notBefore = notBeforeFor({
          tier: d.tier,
          now: now(),
          currentNotBefore: pending.currentNotBefore,
          lastNotBefore: pending.lastNotBefore
        })
        return d
      } catch { return null } // 判不出来 ⇒ 按老行为直接发(不挡任何事)
    })()
    if (insert !== null && insert.cutRemaining === true) {
      try {
        const stopped = store.relayCancelBubbles({ sessionId: sid, now: now() })
        if (Number(stopped?.rows) > 0) {
          // 残句留给她下一轮**认账**(与 barge-in 同一条纪律:话被插断了,她该知道)
          try { rememberInterrupted(sid, stopped.tail) } catch { }
          try {
            audit?.('insert_cut', '(' + insert.tier + ' ' + insert.priority + ')停发 ' + stopped.rows
              + ' 泡,残句:' + String(stopped.tail).slice(0, 40), sid)
          } catch { }
          log('F4 ' + insert.tier + ': 缩短她的话,停发 ' + stopped.rows + ' 泡')
        }
      } catch (err) { warn('relay: F4 停发失败(不影响这一条)— ' + String(err?.message ?? err)) }
    } else if (insert !== null && insert.tier !== 'immediate') {
      try {
        audit?.('insert_' + insert.tier, '(' + insert.priority + ' ' + insert.kind
          + ')排到她说完之后再发(队列里还有 ' + insert.pending.rows + ' 泡)', sid)
      } catch { }
    }
    for (const ch of channels) {
      if (kind === 'proactive' || kind === 'reminder') {
        if (pScope === 'off') continue
        if (ch.proactive !== 1) continue
      }
      const ttl = Number(c.proactiveTtlSec ?? 300)
      const expiresAt = (kind === 'proactive' || kind === 'reminder') && ttl > 0 ? now() + ttl : 0
      let any = false
      for (const b of plan) {
        const bo = b.notBefore
        const r = store.relayEnqueue({
          platform: ch.platform,
          chatId: ch.chatId,
          sessionId: sid,
          // 分泡后每泡必须有自己的 turnId:适配器按 (turnId, chatId) 去重,
          // 共用 turnId 的话第二泡起会被当"同一回合的重复"直接销账丢掉。
          turnId: split ? turn.turnId + '#' + b.seq : turn.turnId,
          groupId: split ? turn.turnId : '',
          seq: b.seq,
          // v0.40.0 F4:她正在说话 ⇒ 插队时刻由四档决定(说话时 priority 才生效,
          // 上游原话);不在说话 = immediate = 老行为(原样用泡自己的节拍)。
          notBefore: insert === null || insert.tier === 'immediate'
            ? bo
            : Math.max(bo, insert.notBefore),
          kind,
          text: b.text,
          expiresAt,
          now: now()
        })
        if (r?.ok) { any = true; queuedRows += 1 }
      }
      if (any) queuedChannels += 1
    }
    const queued = queuedChannels
    if (queued > 0) {
      try {
        audit?.(kind === 'reply' ? 'relay_out' : 'relay_proactive',
          '[' + (channels[0]?.label ?? sid) + '] ' + text.slice(0, 80), sid)
      } catch { }
      return { queued, channels: channels.length, chars: text.length, scope, bubbles: plan.length, rows: queuedRows }
    }
    // 想说而没路可走 —— **必须留痕**。
    //
    // 2026-09-26 现场就是这样被发现的:她 12:45 确实开口了(审计有 `care` 行、
    // 会话语录有那一句),而队列里一个字都没有、日志里一行都没有,于是只能靠
    // 他来问「为什么没用 QQ 发」。话没出去不是错(可能真的没有渠道、或者他
    // 把主动关了),**不出声才是错**。
    if (initiative) {
      const why = channels.length === 0
        ? '没有任何可用渠道(连全库兜底都是空的)'
        : '被闸挡住(主动范围 ' + pScope + ' / 渠道自己的主动开关)'
      warn('relay: 她想主动开口但没发出去 — ' + why + ' sid=' + sid)
      try {
        audit?.('relay_proactive', '(**没发出去**:' + why + ') ' + text.slice(0, 60), sid)
      } catch { }
      return { queued: 0, channels: channels.length, chars: text.length, scope, skipped: why }
    }
    return { queued: 0, channels: channels.length, chars: text.length, scope }
  }

  // ------------------------------------------------------------
  // 她自己的手(2026-09-26 产品模型)
  // ------------------------------------------------------------
  /**
   * 「她用 QQ 说一句」—— 给她当工具的落地点。
   *
   * 与 `finishTurn` 的分工:那是**管子**(被搭话的回合把回复送回来说话的
   * 那个聊天,自动、必达);这是**她的手**(她自己决定什么时候、往哪说)。
   * 两条路都走同一个 outbox,所以切段/租约/销账/失败重试全一样。
   *
   * @param {{sessionId: string, text: string, mode?: 'reply'|'call', chat?: string}} o
   *   mode='call' 是主动喊人 → 受 proactiveScope / 渠道 proactive / TTL 约束
   *   chat 可以是具体聊天号 / 渠道标签;空 = 自动挑(只有私聊一种渠道)
   * @returns {{ok: boolean, reason?: string, sent: number, kind: string, targets: string[], chars: number}}
   */
  function say ({ sessionId, text, mode = 'reply', chat = '', groupTarget = '' } = {}) {
    const sid = String(sessionId ?? '')
    const body = String(text ?? '').trim()
    // 2026-09-29:这一轮**是她自己起的话头**时,她用手说的那句也算「主动开口」。
    //
    // 现场(18:24):心跳在 18:24:09 记了一笔"她开口了"(待兑现账 pendingCare),
    // 她随即用 `echo_qq_say` 把那句关怀送到他手机(18:24:20 已 ack)—— 可这一行
    // 被记成 `reply`,于是 ack 那一刻 `noteProactiveAcked` 认不出来(它只认
    // `proactive`),待兑现账**永不兑现**:想念不降权、议程不降权、安抚落不了地,
    // 下一拍还会被判 `pending-ack` 挡住(18:24:42 那一拍就是它)。
    // 判据取自 relay 自己那一轮的标记(`markProactive`,由壳在"她开口"的注入
    // 那一刻打上),不猜。
    const proactiveTurn = turns.get(sid)?.proactive === true
    const kind = (String(mode) === 'call' || proactiveTurn) ? 'proactive' : 'reply'
    if (sid === '' || body === '') return { ok: false, reason: 'empty', sent: 0, kind, targets: [], chars: 0, scope: 'session' }
    // 2026-09-26 他拍的:射程只由「这个会话里插件开没开」决定 —— 会话没绑
    // 平台聊天**不是**拒绝的理由(他在网页这边跟她说话,一样该能让她伸手
    // 够到他手机)。本会话没渠道就退到全库渠道里挑,并在结果里说出 scope。
    //
    // 2026-10-15 加群聊：**不再一律只认私聊**。
    //   · `kind='reply'`（她回他一句）⇒ **群渠道算数** —— 她在群里答应了他，
    //     这句就该回到那个群（挑的是"最近被搭话的聊天"，群天然更近）。
    //   · `kind='proactive'`（她主动开口）⇒ 下面那段照旧要求 `ch.proactive === 1`，
    //     而群渠道默认 `proactive=0` ⇒ **主动开口不会进群**（他要的"别在群里叨叨"）。
    let scope = 'session'
    let list = store.relayChannelsOfSession(sid).filter((ch) => ch.platform !== 'qq-official' && ch.enabled === 1)
    if (list.length === 0) {
      scope = 'global'
      list = (store.relayListChannels() || []).filter((ch) => ch.platform !== 'qq-official' && ch.enabled === 1)
    }
    if (list.length === 0) return { ok: false, reason: 'no-channel', sent: 0, kind, targets: [], chars: 0, scope }
    const want = String(chat ?? '').trim()
    if (groupTarget !== '') {
      if (mode !== 'reply' || want !== groupTarget) return { ok: false, reason: 'group-target-mismatch',
        sent: 0, kind, targets: [], chars: body.length, scope }
      list = list.filter(ch => ch.platform === 'qq' && ch.chatType === 'group'
        && String(ch.chatId) === groupTarget)
      if (list.length === 0) return { ok: false, reason: 'group-target-mismatch',
        sent: 0, kind, targets: [], chars: body.length, scope }
    }
    if (want !== '') {
      const hit = list.filter((ch) => String(ch.chatId) === want || String(ch.label) === want)
      if (hit.length > 0) list = hit
    }
    const c = cfg()
    if (kind === 'proactive') {
      // 与心跳那条路同规格:off 不推、渠道自己关了就跳过
      const pScope = String(c.proactiveScope ?? 'private')
      list = list.filter((ch) => {
        if (pScope === 'off') return false
        // ★ 2026-10-15：主动开口**不进群** —— 群渠道默认 `proactive=0`，
        //   这里显式再挡一道（有人把群渠道的 proactive 打开也不该让想念跳到群里）。
        if (ch.chatType === 'group') return false
        return ch.proactive === 1
      })
      if (list.length === 0) return { ok: false, reason: 'scope', sent: 0, kind, targets: [], chars: 0, scope }
      // 多个私聊都合格时只挑一个(同一句想念不该到处跳)
      const primary = list.filter((ch) => ch.isPrimary === 1)
      if (primary.length > 0) list = [primary[0]]
    } else {
      // ★ 2026-10-17：回话的**默认目标只在私聊里挑**（他拍：「主动权交给她」）。
      //
      // 现场（他报「在 A 群聊发消息，她在 B 群聊回复」）：
      //   原来这里按 `lastInAt` 挑"最近被搭话的渠道"，**群也参与** ⇒
      //   A 群说完、B 群又说 ⇒ 她留空一调 `echo_qq_say` 就发到了 **B 群**。
      //   而 `autoReplyToOrigin` 早就是 false（自动送已关）——
      //   所以那一步"挑目标"完全是她看不见的**暗中决定**，她自己并不知道发去了哪。
      //
      // 为什么默认不选群：
      //   发错**群**的代价远大于发错私聊 —— 群里有一屋子人看着。
      //   而私聊只有一个收件人，猜错了最多是"他收到两条"。
      //
      // 群要怎么回：**她显式指定**。注入正文的头部现在带群号
      //   （`【QQ·群聊·群名(群号)】`），她把那个号传给 `chat` 就能精确回到那个群。
      //   ⇒ 主动权在她手上，系统不再替她猜。
      //
      // ⚠️ 如果连私聊都没有（真·只在群里）⇒ 退回全部渠道（别让她无路可走）。
      const privates = list.filter((ch) => String(ch.chatType ?? 'private') !== 'group')
      const pool = privates.length > 0 ? privates : list
      const sorted = [...pool].sort((a, b) => Number(b.lastInAt || 0) - Number(a.lastInAt || 0))
      const recent = sorted[0]
      const primary = pool.find((ch) => ch.isPrimary === 1)
      const pick = (recent && Number(recent.lastInAt || 0) > 0) ? recent : (primary ?? sorted[0])
      list = [pick]
    }
    const ttl = Number(c.proactiveTtlSec ?? 300)
    const expiresAt = kind === 'proactive' && ttl > 0 ? now() + ttl : 0
    const turnId = randomUUID()
    // 分泡同样适用:她自己伸手说的那句也是"她的话"(A 侧的嘴巴只有一条路,
    // 到 DSH 才分成"自动回话"与"她调工具"两处,但发送语义是同一样东西)。
    const bcfg = c.bubble ?? {}
    const plan = (bcfg.enabled !== false && kind === 'reply')
      ? planBubbles(body, {
        maxChars: Number(bcfg.maxChars ?? 30),
        maxBubbles: BUBBLE_MAX_BUBBLES,
        scale: Number(bcfg.delayScale ?? 1),
        now: now()
      })
      : [{ text: body, seq: 0, notBefore: now() }]
    const split = plan.length > 1
    let sent = 0
    let rows = 0
    const targets = []
    for (const ch of list) {
      let any = false
      for (const b of plan) {
        const r = store.relayEnqueue({
          platform: ch.platform,
          chatId: ch.chatId,
          sessionId: sid,
          turnId: split ? turnId + '#' + b.seq : turnId,
          groupId: split ? turnId : '',
          seq: b.seq,
          notBefore: b.notBefore,
          kind,
          text: b.text,
          expiresAt,
          now: now()
        })
        if (r?.ok) { any = true; rows += 1 }
      }
      if (any) { sent += 1; targets.push(String(ch.label || ch.chatId)) }
    }
    if (sent > 0) {
      spokeViaTool.add(sid)
      try {
        audit?.(kind === 'proactive' ? 'relay_proactive' : 'relay_out',
          '[' + targets.join(',') + '] ' + body.slice(0, 80), sid)
      } catch { }
    }
    return { ok: sent > 0, sent, kind, targets, chars: body.length, scope, bubbles: plan.length, rows }
  }

  // ------------------------------------------------------------
  // 适配器面(轮询/确认/渠道)
  // ------------------------------------------------------------
  function lease ({ platform, limit = 20, leaseSec = null } = {}) {
    if (platform === 'qq-official') return { items: [], maxChars: Number(cfg().replyMaxChars ?? 500), reason: 'reserved-platform' }
    const c = cfg()
    const out = store.relayLeaseOutbox({
      platform,
      limit,
      leaseSec: leaseSec === null ? Number(c.outboxLeaseSec ?? 30) : leaseSec,
      now: now()
    })
    return { ...out, maxChars: Number(c.replyMaxChars ?? 500) }
  }

  function ack (ids) {
    if (typeof legacyAckAllowed === 'function') ids = (Array.isArray(ids) ? ids : []).filter(id => legacyAckAllowed(Number(id)))
    const r = store.relayAckOutbox({ ids, now: now() })
    // v0.18.1 C5:这一声 ack 是"真的送到他手机上了"的唯一凭据 ——
    // 她的关怀到了才算说过(longing ×0.5、议程降权),A 侧纪律。
    // 钩子失败绝不影响销账本身。
    try { if (typeof onAcked === 'function') onAcked(r?.rows ?? []) } catch { }
    return r
  }

  function channels () {
    // 2026-10-15 加群聊：**群渠道不再除名**（v0.29.0 那句"群行是死行"随群聊一起退役）。
    // 面板与适配器都要看得见群里那条嘴 —— 不然"她到底能不能在群里说话"没处查。
    return { items: store.relayListChannels(), queue: store.relayQueueStats({}), cfg: safeCfg() }
  }

  function setChannel (patch) {
    const r = (patch && typeof patch === 'object') ? patch : {}
    if (r.platform === 'qq-official') return { ok: false, reason: 'reserved-platform' }
    return store.relaySetChannel({
      platform: String(r.platform ?? ''),
      chatId: String(r.chatId ?? ''),
      enabled: typeof r.enabled === 'boolean' ? r.enabled : null,
      proactive: typeof r.proactive === 'boolean' ? r.proactive : null,
      isPrimary: typeof r.isPrimary === 'boolean' ? r.isPrimary : null
    })
  }

  /** 状态给面板/体检看:总闸、会话、队列、渠道。**不含 token**。 */
  function status () {
    return {
      enabled: gate(),
      sessionId: String(cfg().sessionId ?? ''),
      permissionPreset: String(cfg().permissionPreset ?? ''),
      proactiveScope: String(cfg().proactiveScope ?? 'private'),
      queue: store.relayQueueStats({}),
      channels: store.relayListChannels().length,
      // 渠道明细(面板要能逐个开关「这条私聊她要不要主动说话」——
      // 这些字段都是配置面,不是秘密面)。2026-10-15 加群聊：群行也在里面,
      // 面板据此显示"她在这几个群里能说话"。
      list: store.relayListChannels(),
      pendingTurn: turns.size
    }
  }

  /**
   * 干跑自检:**证明"服务在这、契约形状没坏",且不写库、不建会话、不发模型**。
   *
   * 为什么不做真投递(对照 Cortico 的 dry-mount:那是"临时假部署里跑构造再扔掉"):
   * `handleInbound` 一旦**走通**就会受理落库、必要时建陪伴会话 —— 自检不能有副作用。
   * 所以这里只走**纯函数面**:信封解析(正例 + 反例)+ 各能力的可调用性。
   * 真链路仍由 `scripts/acceptance.mjs` 与主仓/新仓测试覆盖。
   * @returns {{ok:boolean, checks:{name:string,ok:boolean,detail:string}[], note:string}}
   */
  function selftest () {
    const checks = []
    const sample = {
      v: 1,
      platform: 'qq',
      chat: { id: '1', type: 'private' },
      sender: { id: '2', isMaster: true },
      text: 'ping',
      msgId: 'selftest-1'
    }
    const good = parseEnvelope(sample)
    checks.push({ name: 'envelope-valid', ok: good.ok === true, detail: good.ok === true ? '' : String(good.reason) })
    const bad = parseEnvelope({})
    checks.push({
      name: 'envelope-invalid-rejected',
      ok: bad.ok === false,
      detail: bad.ok === false ? String(bad.reason) : '坏信封被放过了'
    })
    for (const [name, fn] of Object.entries({ handleInbound, lease, ack, say, captureSegment, finishTurn, status })) {
      checks.push({ name: 'callable:' + name, ok: typeof fn === 'function', detail: typeof fn === 'function' ? '' : '不是函数' })
    }
    return { ok: checks.every((c) => c.ok), checks, note: '干跑:不写库、不建会话、不发模型' }
  }

  function safeCfg () {
    const c = cfg()
    const { token: _token, ...rest } = c
    return rest
  }

  return {
    handleInbound, captureSegment, markProactive, finishTurn, say,
    lease, ack, channels, setChannel, status, selftest,
    /** 测试/诊断用:把某个会话的碎片读出来(不改状态)。 */
    peekTurn: (sessionId) => {
      const t = turns.get(String(sessionId ?? ''))
      return t === undefined ? null : { turnId: t.turnId, segments: [...t.segments], proactive: t.proactive }
    }
  }
}
