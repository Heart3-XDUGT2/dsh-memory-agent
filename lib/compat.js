/**
 * v0.32.0 A0:宿主兼容闸(照 roleplay 的 `dsh-compat.ts` 抄**思路**,不抄代码)。
 *
 * 为什么需要它:批次 A 之后我们要陆续用上宿主较新的挂点 ——
 * `systemPrompt.context()`(尾部快照)、`systemPrompt.variable()`(人格变量化)、
 * `tools/post-execute`(全量审计)。插件可能被装在一个**没有这些挂点**的宿主上,
 * 或者宿主升级把它们改名/撤掉 —— 那时**必须退回今天的行为**,
 * 而不是让整轮组装炸掉(这项目最贵的教训:"人格不陪葬")。
 *
 * 纪律:
 *   - 纯函数:`hostCaps(service)` 只吃一个服务对象 ⇒ 能离线喂假对象测;
 *   - **探测一次、缓存一次**(进程生命周期内),结果写进 `lastCaps` 供面板/审计看;
 *   - 探测不到不是静默降级:**留一行 note**,让他/我事后查得到"这台机器上少哪个挂点"。
 */

/** 我们依赖的宿主能力(名字就是它给人的可读标签)。 */
export const CAP_KEYS = ['context', 'variable', 'section']

/**
 * 探一个 systemPrompt 服务有哪些挂点。
 * 传 null/undefined(服务没起来)⇒ 全 false + note,调用方据此**整段不注册**。
 */
export function hostCaps (service, version = '') {
  const has = (k) => typeof service?.[k] === 'function'
  const caps = { section: has('section'), context: has('context'), variable: has('variable') }
  const missing = CAP_KEYS.filter((k) => !caps[k])
  caps.ok = service !== null && service !== undefined
  caps.version = String(version ?? '')
  caps.note = !caps.ok
    ? 'systemPrompt 服务不在 —— 人格与记忆注入整段不注册(不是降级,是没地方注入)'
    : (missing.length === 0 ? '' : '这台宿主缺:' + missing.join('/') + ' ⇒ 相关特性自动退回旧做法')
  return caps
}

/** 一个进程一份缓存:探测只做一次,之后都读它。 */
export function createCompat ({ logger = null, version = '' } = {}) {
  let cached = null
  return {
    /** 探一次并缓存(重复调用返回同一份)。 */
    check (service) {
      if (cached !== null) return cached
      cached = hostCaps(service, version)
      if (cached.note !== '' && logger !== null && typeof logger.info === 'function') {
        // info 而不是 warn:退回旧做法本身是**设计好的**,不是故障(没挂点 = 少个特性)
        logger.info('echo: 宿主兼容闸 — ' + cached.note + '(' + CAP_KEYS.filter((k) => cached[k]).join('/') + ' 可用)')
      }
      return cached
    },
    /** 读最近一次探测结果(没探过就是 null,面板照实说"还没探")。 */
    last () { return cached },
    /** 只给测试用:清缓存。 */
    reset () { cached = null }
  }
}
