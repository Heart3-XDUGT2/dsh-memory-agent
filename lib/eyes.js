/**
 * 她的眼睛:把入站信封里的图,变成**附件库里的字节**。
 *
 * 为什么不是「把 URL 交给模型」—— 2026-09-26 读宿主源码确认的两件事:
 *   · `ImageBlock = { type:'image', attachment: ImageAttachmentRef }`,而
 *     `ImageAttachmentRef` 的注释是「Immutable bytes … owned by the
 *     attachment service」—— 图存的是**不可变字节**,不是链接;
 *   · 所以 URL 只是**传输形式**。对 QQ 这恰好是必需的:QQ 给的是带签名的
 *     临时地址,收到不抓,几个小时后就失效;抓进附件库反而成了可以回看的。
 *
 * 本模块**不 import 任何宿主包** —— 抓取、嗅探、上限全都能离线测
 * (fetch 可注入)。宿主真正的落库调用在 lib/index.js 的注入那一段。
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

/** 兜底上限:宿主给得出 `attachments.imageLimits` 时就以宿主为准。 */
const DEFAULT_LIMITS = {
  maxImageBytes: 8 * 1024 * 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 20 * 1024 * 1024
}

/** 抓一张图的默认超时(QQ 的 CDN 在国内,本地到它一般 <1s;5s 已经很长)。 */
const DEFAULT_TIMEOUT_MS = 5000

const EXT_OF = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }

/**
 * 从字节头认图片类型。**不信声明** —— `saveImages` 会拿声明的 mediaType
 * 跟解码后的字节对,对不上就是一次 admission 失败;而 A 侧给过来的
 * `mime` 是 QQ 说的,不一定靠谱。认不出来就当她没看见(宁缺勿错)。
 * @param {Uint8Array} bytes
 * @returns {string|null} mediaType 或 null(不是我们认得的图)
 */
export function sniffMediaType (bytes) {
  const b = bytes
  if (b === null || b === undefined || b.length < 12) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  const ascii = (i, s) => String.fromCharCode(...b.slice(i, i + s.length)) === s
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return null
}

/** 信封里一条图记的是什么:`url`(http/https)| `path`(同机文件)| `data`(base64)。 */
export function pickImageSource (one) {
  const r = (one && typeof one === 'object') ? one : {}
  const url = String(r.url ?? '').trim()
  if (/^https?:\/\//i.test(url)) return { kind: 'url', value: url }
  const path = String(r.path ?? '').trim()
  if (path !== '') return { kind: 'path', value: path }
  const file = String(r.file ?? '').trim()
  if (/^file:\/\//i.test(file)) return { kind: 'path', value: file }
  if (/^https?:\/\//i.test(file)) return { kind: 'url', value: file }
  const data = String(r.data ?? '').trim()
  if (data !== '') return { kind: 'data', value: data }
  return null
}

/** 显示名:只留文件名、掐长度、去路径语义(附件服务的 name「never interpreted as a path」)。 */
function displayName (declared, mediaType) {
  let name = basename(String(declared ?? '').trim()).slice(0, 80)
  if (name === '' || name === '.' || name === '..') name = 'photo'
  if (extname(name) === '') name += EXT_OF[mediaType] ?? ''
  return name
}

/**
 * 抓一张图。
 * @param {object} one 信封里的一条图记
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl] 注入用(默认全局 fetch)
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:true,data:Uint8Array,mediaType:string,name:string,from:string}
 *   | {ok:false,reason:string}>}
 */
export async function loadImage (one, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const maxBytes = Number(opts.maxBytes ?? DEFAULT_LIMITS.maxImageBytes)
  const timeoutMs = Number(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const src = pickImageSource(one)
  if (src === null) return { ok: false, reason: '没给 url/path/data' }
  let bytes = null
  try {
    if (src.kind === 'url') {
      if (typeof fetchImpl !== 'function') return { ok: false, reason: '这个进程里没有 fetch' }
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      let res = null
      try {
        res = await fetchImpl(src.value, { signal: ac.signal, redirect: 'follow' })
      } finally {
        clearTimeout(timer)
      }
      if (res === null || typeof res !== 'object') return { ok: false, reason: '抓取没有响应' }
      if (!res.ok) return { ok: false, reason: '抓取失败(HTTP ' + String(res.status) + ')' }
      // 先看声明长度,再真读:省得为一个 100MB 的 body 分配内存
      const declared = Number(res.headers?.get?.('content-length') ?? 0)
      if (declared > maxBytes) return { ok: false, reason: '图太大(' + declared + ' 字节)' }
      const buf = await res.arrayBuffer()
      bytes = new Uint8Array(buf)
    } else if (src.kind === 'path') {
      const p = src.value.startsWith('file://') ? new URL(src.value) : src.value
      const info = await stat(p)
      if (!info.isFile()) return { ok: false, reason: '不是文件:' + src.value }
      if (info.size > maxBytes) return { ok: false, reason: '图太大(' + info.size + ' 字节)' }
      bytes = new Uint8Array(await readFile(p))
    } else {
      const b64 = src.value.replace(/^base64:\/\//i, '').replace(/\s+/g, '')
      bytes = new Uint8Array(Buffer.from(b64, 'base64'))
    }
  } catch (err) {
    const name = String(err?.name ?? '')
    if (name === 'AbortError' || name === 'TimeoutError') return { ok: false, reason: '抓取超时' }
    return { ok: false, reason: '抓取出错:' + String(err?.message ?? err).slice(0, 80) }
  }
  if (bytes === null || bytes.length === 0) return { ok: false, reason: '抓到的是空字节' }
  if (bytes.length > maxBytes) return { ok: false, reason: '图太大(' + bytes.length + ' 字节)' }
  const mediaType = sniffMediaType(bytes)
  if (mediaType === null) return { ok: false, reason: '这不是一张我认得的图(jpeg/png/webp/gif)' }
  const got = {
    ok: true,
    data: bytes,
    mediaType,
    name: displayName(one?.name ?? one?.file ?? one?.path ?? '', mediaType),
    from: src.kind
  }
  // ★ 2026-10-20：把**表情包标记**一路带下去 —— 下游 `describeImages` 靠它选文案。
  //   丢了它，抓到的表情包就又被当成普通图。
  if (one !== null && typeof one === 'object') {
    if (one.sub_type !== undefined && one.sub_type !== null && one.sub_type !== '') {
      const n = Number(one.sub_type)
      if (Number.isFinite(n)) got.sub_type = n
    }
    const summary = String(one.summary ?? '').trim().slice(0, 40)
    if (summary !== '') got.summary = summary
  }
  return got
}

/**
 * 一封信里的图全抓一遍。**永远不抛** —— 抓不到图不该让这一轮消失,
 * 只该让她知道「他发了图,但图没到手」(§3.2.1 不静默)。
 * @returns {Promise<{images: Array<object>, problems: Array<{index:number,reason:string}>, bytes:number}>}
 */
export async function collectImages (list, opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) }
  const maxCount = Number(opts.maxCount ?? limits.maxImagesPerMessage)
  const budget = Number(opts.maxTotalBytes ?? limits.maxMessageImageBytes)
  const images = []
  const problems = []
  let total = 0
  const arr = Array.isArray(list) ? list : []
  for (let i = 0; i < arr.length; i += 1) {
    if (images.length >= maxCount) { problems.push({ index: i, reason: '一条消息里的图太多,这条没看' }); continue }
    const got = await loadImage(arr[i], { ...opts, maxBytes: Math.min(Number(opts.maxBytes ?? limits.maxImageBytes), limits.maxImageBytes) })
    if (!got.ok) { problems.push({ index: i, reason: got.reason }); continue }
    if (total + got.data.length > budget) { problems.push({ index: i, reason: '这次发的图加起来太大' }); continue }
    total += got.data.length
    images.push(got)
  }
  return { images, problems, bytes: total }
}

/**
 * ★ 2026-10-20：**这张是不是表情包**。
 *
 * 判据就两条（都来自 OneBot 的既有字段，不发明新语义）：
 *   ① `sub_type === 1` —— OneBot v11 约定：0 = 普通图，1 = 表情包
 *   ② `summary` 里含「表情」—— 常见值 `[动画表情]`；有的实现不发 `sub_type` 只发这个
 *
 * ⚠️ 两条件**任一成立**就算。宁可把一张普通图当表情包（少说一句），
 * 也不要把表情包当普通图（正经描述一通 —— 那正是他嫌生硬的那个）。
 *
 * @param {object} ref 图记（`{url?, file?, path?, sub_type?, summary?}`）
 * @returns {boolean}
 */
export function isStickerImage (ref) {
  if (ref === null || typeof ref !== 'object') return false
  const subType = Number(ref.sub_type)
  if (Number.isFinite(subType) && subType === 1) return true
  return String(ref.summary ?? '').includes('表情')
}

/**
 * 抓图结果 → 贴在她正文旁边的一行。
 *
 * ★ 2026-10-20：**分成两句，按"是图还是表情包"选**（他拍的）。
 *
 * 原来只有一句「他发来N张图 —— 图就在下面,你看得到」：
 * 只说了"你看得见"，**没说怎么用** ⇒ 她按"看图说话"的默认行为走，
 * 逐张描述画面。现场表现就是他说的「识别描述一通，很生硬」。
 *
 * 现在：
 *   · **普通图** ⇒ 明说"当聊天里看到的东西，用你自己的话说一句"，并**明确禁止**
 *     逐张描述 / 罗列画面细节。
 *   · **表情包** ⇒ **给她判断权**：单独发或明显在表达情绪/梗 ⇒ 接一下；
 *     跟在话后面当语气点缀 ⇒ 正常回话，不用专门提。
 *
 * ★★ 2026-10-20 再改（他拍的「她应该能识别表情，但是不做回复」）：
 *   **`opts.noReply === true`（= 他单发了图/表情、没写字）时，换成"单发"句式**：
 *
 *     (他单发了个表情包,这条不用回 —— 你自己心里有数就行)
 *     (他单发了一张图,这条不用回 —— 你自己心里有数就行)
 *
 *   ⚠️ 关键区别：**图照样进她的上下文**（所以"能识别"），
 *   只是明说"不用回"（所以"不回复"）。
 *   上一版做的是"暂存、压根不注入" —— 那是**看不到**，不叫识别，是个方向性错误。
 *
 * @param {number} count 一共拿到几张
 * @param {Array<{index:number, reason:string}>} problems 没抓到的
 * @param {{stickers?:number, noReply?:boolean}} [opts]
 *   `stickers` = 其中几个是表情包（0 或省略 = 都当普通图）；
 *   `noReply` = 他这条没写字（单发图/表情）⇒ 用"单发+不用回"句式
 */
export function describeImages (count, problems = [], opts = {}) {
  const total = Math.max(0, Number(count) || 0)
  const problemsArr = Array.isArray(problems) ? problems : []
  if (total === 0 && problemsArr.length === 0) return ''

  const stickers = Math.max(0, Math.min(total, Number(opts.stickers) || 0))
  const normal = total - stickers
  const noReply = opts.noReply === true
  const parts = []

  if (noReply) {
    // ★ "单发"句式：他什么都没写 ⇒ 她看到就好，别回。
    //   单数用**中文**（照他给的原话：「他单发了一张图」/「他单发了个表情包」），
    //   复数才用数字 —— 免得拼出「他单发了3 张图」这种夹生的句子。
    let what
    if (normal === 1 && stickers === 0) {
      what = '一张图'
    } else if (stickers === 1 && normal === 0) {
      what = '个表情包'
    } else {
      const bits = []
      if (normal > 0) bits.push(normal + ' 张图')
      if (stickers > 0) bits.push(stickers + ' 个表情包')
      what = ' ' + bits.join(' + ')
    }
    parts.push('(他单发了' + what + ',这条不用回 —— 你自己心里有数就行)')
  } else {
    if (normal > 0) {
      parts.push('(他发来 ' + normal + ' 张图 —— 当聊天里看到的东西,用你自己的话说一句就好,'
        + '不要逐张描述、不要罗列画面细节)')
    }
    if (stickers > 0) {
      parts.push('(他发来 ' + stickers + ' 个表情包 —— 看情况:'
        + '有信息量(比如单独发、或者明显在表达情绪/梗)就接一下;'
        + '只是跟在话后面当语气点缀的,就正常回他的话,不用专门提这个表情包)')
    }
  }
  if (problemsArr.length > 0) {
    parts.push('(有' + problemsArr.length + '张图没抓下来:' + problemsArr.map((p) => p.reason).join(';')
      + ' —— 别当自己看过了)')
  }
  return parts.filter((s) => s !== '').join('\n')
}

/**
 * 抓到的字节 → 宿主的不可变附件引用 → 她上下文里的 image block。
 *
 * 这一步是**唯一**碰宿主服务的地方(调用方把 `ctx.get('attachments')` 递进来),
 * 所以它必须在离线电池里过得去:附件服务不在、返回单个引用而不是数组、
 * 中途抛错 —— 每一种都不能让这一轮消失(调用方降级成纯文本)。
 * @param {{saveImages: Function}} store 宿主的附件服务
 * @param {Array<{data: Uint8Array, mediaType: string, name: string}>} images
 * @returns {Promise<Array<{type:'image', attachment: object}>>}
 */
export async function saveImageBlocks (store, images) {
  if (!Array.isArray(images) || images.length === 0) return []
  if (store === null || store === undefined || typeof store.saveImages !== 'function') {
    throw new Error('这个部署里没有 attachments 服务')
  }
  const refs = await store.saveImages(images.map((img) => ({
    data: img.data, mediaType: img.mediaType, name: img.name
  })))
  const list = Array.isArray(refs) ? refs : [refs]
  return list
    .filter((ref) => ref !== null && ref !== undefined)
    .map((attachment) => ({ type: 'image', attachment }))
}

/**
 * 一封入站信 → 注入用的 content:图在前、文字在后。
 *
 * 顺序是**故意**的:模型读到的最后一段是正文(谁说的、在哪说的),图贴在它上面。
 * (2026-09-26 当晚:正文后面原本还挂着「回他请用 echo_qq_say」这句逐轮工具指令,
 * 已按他的裁定去掉 —— 那句曾是「图为什么贴在上面」的主要理由,现在理由只剩
 * 「最后读到的是他的话」。)
 */
export function inboundContent (blocks, text) {
  return [...(Array.isArray(blocks) ? blocks : []), { type: 'text', text: String(text ?? '') }]
}
