/**
 * 0.2.0-rc.2 的 v4 会话格式**收紧了「谁说的话」的署名规则**:
 * `source.kind === 'plugin'` 被明令拒绝 ——
 * `dsh-session-format-v3-to-v4/lib/index.js:126`:
 *   `format v4 message requires a producer-owned source kind`
 * 产出者必须直接写自己的身份,我们的是 `plugin:dsh-echo`。
 *
 * 这不是猜的:官方把 v3 旧日志搬进 v4 时就是这么"提升"的
 * (`rewritePluginSource`,`lib/index.js:101-107`)—— kind 换成 `plugin:<plugin>`、
 * `plugin` 字段丢掉。所以**迁移后的历史里看到的正是 `plugin:dsh-echo`**
 * (现场:2026-10-02 16:52 她那条会话的落盘事件逐字如此)。
 *
 * 现场事故(2026-10-03 00:06):桥注入的那条 user 消息被 v4 拦下,整轮
 * 「运行失败 / format v4 message requires a producer-owned source kind」——
 * 她从此在 QQ 上永远不回;而子代理会话不走这条注入,一切正常(所以看起来
 * 只坏了一个会话)。宿主不会替我们补这个字段,必须自己写对。
 *
 * 约束:`lib/relay.js` 是**红线**(一字不动),而它导出的 `marksProactive`
 * 仍按旧形状(`kind === 'plugin' && plugin === 'dsh-echo'`)认自己的注入。
 * 所以这里另给一个**兼容视图** `legacySourceView`:由调用侧喂给那个冻结的
 * 判据 —— 新格式落盘、旧判据照旧,两边都不用动。
 */

/** 本插件在宿主里的身份名(旧形状的 `plugin` 字段就是它)。 */
export const ECHO_PLUGIN_ID = 'dsh-echo'

/** v4 会话格式要求的产出者 kind(与官方提升结果逐字一致)。 */
export const ECHO_SOURCE_KIND = `plugin:${ECHO_PLUGIN_ID}`

/** 旧形状的 kind 字面量(0.1.x / v3 日志里认得的那个)。 */
const LEGACY_PLUGIN_KIND = 'plugin'

/**
 * 这条 source 是不是本插件的注入?
 *
 * 两种形状都认:活消息只可能是新形状(旧形状现在**写不进去**,v4 直接拒),
 * 但历史、测试、以及迁移前的旧事件里仍要认得出旧形状 —— 判据宽一点,
 * 不会把别家插件的注入误认成自己的(旧形状要求 `plugin === 'dsh-echo'`)。
 *
 * @param {{kind?: string, plugin?: string, form?: string}} [source]
 */
export function isEchoSource (source) {
  if (source === null || typeof source !== 'object') return false
  if (source.kind === ECHO_SOURCE_KIND) return true
  return source.kind === LEGACY_PLUGIN_KIND && source.plugin === ECHO_PLUGIN_ID
}

/**
 * 把新形状**折回旧判据看得懂的样子**,只给冻结的红线判据用
 * (`lib/relay.js` 的 `marksProactive`)。旧形状原样透传。
 *
 * 那边只读 kind / plugin / form 三个字段,其余字段照抄不影响它;
 * 返回新对象(不动原 source —— 调用方还要拿原样的去别处)。
 *
 * @param {{kind?: string, plugin?: string, form?: string}} [source]
 */
export function legacySourceView (source) {
  if (source === null || typeof source !== 'object') return source
  if (source.kind !== ECHO_SOURCE_KIND) return source
  return { ...source, kind: LEGACY_PLUGIN_KIND, plugin: ECHO_PLUGIN_ID }
}
