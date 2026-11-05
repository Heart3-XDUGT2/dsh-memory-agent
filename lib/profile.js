/**
 * 用户画像 / 称呼 —— 数据文件 `profile.json` 的**唯一读点**
 * ======================================================
 * P1d(2026-10-05):"数据与程序分离"里,称呼链的真源是 `<数据目录>/profile.json`
 * (`lib/data-schema.js` 的 SPECS['profile.json'])。在这之前:
 *   · web 面板把"<称呼>""对XX"**写死在代码里**(web/app.js:718、app.js:286、
 *     web/audit-view.js:153),换个人用就得改代码;
 *   · JS 侧没有任何读点,profile.json 是个只写不读的文件。
 * 现在:本模块是 JS 侧**唯一读点** —— 面板走 `GET /api/echo/profile`
 * (`lib/index.js`),服务端要称呼就 `loadProfile()`。**前端不读文件**。
 *
 * 纪律(与 `lib/names.js` 同一套):只读、缺文件/坏文件/脏值一律降级、
 * **永不抛**;`publicProfile()` 的兜底是**中性角色词**(用户 / 助手),
 * 代码里绝不留真名。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolveDataFilePath } from './data-dir.js'

/** 空画像(冻结):读不到就是它 —— 中性,不猜。 */
export const EMPTY_PROFILE = Object.freeze({
  userName: '',
  userAliases: [],
  agentName: '',
  agentSelfRef: '',
  agentAliases: [],
  nicknamePatterns: [],
  nicknameStrict: null,
  // P2 §6.2 ④(2026-10-05):这两项从代码搬进数据 —— 空 = 代码里的默认行为
  // (`uiIndexPrefix` 空 ⇒ 面板用「对」;`fallbackAddress` 空 ⇒ 面板用中性「用户」)
  uiIndexPrefix: '',
  fallbackAddress: '',
  locale: '',
  timezone: ''
})

/** 字符串字段:trim;非字符串/空 ⇒ ''。 */
function str (v) {
  return typeof v === 'string' ? v.trim() : ''
}

/** 数组字段:丢非字符串、去空白、去重。 */
function strList (v) {
  const out = []
  for (const x of Array.isArray(v) ? v : []) {
    if (typeof x !== 'string') continue
    const s = x.trim()
    if (s !== '' && !out.includes(s)) out.push(s)
  }
  return out
}

/**
 * 读 profile.json(只读 / 缺文件 / 坏文件 / 脏值 ⇒ 逐字段降级,**永不抛**)。
 * @param {string|null} [path]
 * @returns {typeof EMPTY_PROFILE}
 */
export function loadProfile (path = resolveDataFilePath('profile.json')) {
  try {
    if (path === null || path === undefined || !existsSync(path)) return EMPTY_PROFILE
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_PROFILE
    return {
      userName: str(raw.userName),
      userAliases: strList(raw.userAliases),
      agentName: str(raw.agentName),
      agentSelfRef: str(raw.agentSelfRef),
      agentAliases: strList(raw.agentAliases),
      nicknamePatterns: strList(raw.nicknamePatterns),
      nicknameStrict: typeof raw.nicknameStrict === 'boolean' ? raw.nicknameStrict : null,
      uiIndexPrefix: str(raw.uiIndexPrefix),
      fallbackAddress: str(raw.fallbackAddress),
      locale: str(raw.locale),
      timezone: str(raw.timezone)
    }
  } catch { return EMPTY_PROFILE }
}

/**
 * 面板要的**称呼/名字**(`GET /api/echo/profile` 的回包):
 * 在 `loadProfile()` 之上把"没填"换成**中性角色词** —— 面板拿不到真名时
 * 显示「用户 / 助手」,而不是一个空白格或代码里的旧真名。
 * `agentAliases` 是**识别层**用的(喂 `toggle.js` 的 SELF_WORDS),显示层只认 agentName;一起发出去。
 * 永不抛。
 */
export function publicProfile (path = resolveDataFilePath('profile.json')) {
  const p = loadProfile(path)
  return {
    userName: p.userName === '' ? '用户' : p.userName,
    userAliases: p.userAliases,
    agentName: p.agentName === '' ? '助手' : p.agentName,
    agentSelfRef: p.agentSelfRef === '' ? '助手' : p.agentSelfRef,
    agentAliases: p.agentAliases,
    // ④ 页的两项:`uiIndexPrefix` 原样发(空 = 面板自己用「对」);
    // 兜底称呼按"中性角色词"同款处理 —— 空 ⇒ 「用户」(代码里不留真名)
    uiIndexPrefix: p.uiIndexPrefix,
    fallbackAddress: p.fallbackAddress === '' ? '用户' : p.fallbackAddress,
    locale: p.locale === '' ? 'zh-CN' : p.locale,
    timezone: p.timezone
  }
}
