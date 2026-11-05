/**
 * v0.20.0 D1:Echo 的压缩后端(「压缩即策展」)。
 * ==================================================================
 * 出处:dsh_port/03 的裁决 —— **机器留 dsh,内容归 soul**。
 *
 *   继承 `BasicCompactionEngine`(装机版逐行核对的契约):
 *     压力检测(agent/pre-step)、保留区选择、区域事务与锁、溢出恢复、
 *     工具配对边界、token 计量、缩减验证 —— **一行不改**。
 *   只覆写它留给子类的**唯一**钩子 `summarize(input, agent, signal)`
 *     (真实签名是**三个**参数,03 §8 猜的五个 —— 以装机版代码为准),
 *     把"英文工程检查点"换成她从自己库里策展的一页关系备忘。
 *   零额外 LLM 调用:返回 **unmarked 变体**(不带 `llmStreamCall`)——
 *     契约里这是"template, remote, or other summarizer"的一等公民,
 *     不是 hack(03 §1)。
 *
 * `frameSummary()`(`<compacted-summary>` 标签 + 英文前导)由基类在钩子
 * **之后**套用(装机版 `summarizeCompaction` 第 567-568 行)⇒ 我们继承它,
 * 不必自己加框(03 §6.2 的猜测被代码证实)。
 *
 * 安全性质(重要):
 *   - 本后端**只在被显式选中的 Echo 预设里挂载**(scripts/install-preset.mjs
 *     生成那份预设)。不选它 ⇒ 一切照旧 —— 零风险上线。
 *   - `summarize()` 内任何异常都退化成"一页最小账本",绝不抛:抛了就是
 *     压缩白跑(引擎只警告、保留原表层,不炸会话)。
 *   - 缩减验证(`summary is not smaller than ...`)由引擎执行 ⇒ 策展块
 *     **按预算裁剪**(lib/curation.js),预算按 input 规模算。
 *   - 只读 DB(`lib/soul-snapshot.js`),绝不写 soul 库。
 *
 * 溯源诚实(03 §6.3):`compaction/summary` 事件里 provider=`dsh-echo`、
 * model=`soul-curation` —— 「这份摘要是谁写的」在日志里有真实答案。
 *
 * 这个文件是**宿主耦合**的(要 import `@deepseek-ai/dsh-compaction-basic`),
 * 所以离线电池只做静态契约检查;能测的都搬到了
 * `lib/curation.js` / `lib/soul-snapshot.js`。
 */
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { readSettings, sessionEnabled } from './toggle.js'
import { isTopLevelSession } from './agent-scope.js'
import { estimateTokens, budgetFor, composeCuratedText } from './curation.js'
import { dbPathOf, readSoulSnapshot, fallbackText } from './soul-snapshot.js'

export const CURATION_PROVIDER = 'dsh-echo'
export const CURATION_MODEL = 'soul-curation'

/** 策展设置:随 Echo 自己的 config.json 走(网页调参,与别的参数同一处)。 */
function readCurationSettings () {
  try {
    const s = readSettings()
    const c = s && typeof s.compaction === 'object' && s.compaction !== null ? s.compaction : {}
    return {
      curated: c.curated !== false,
      budgetTokens: Number(c.budgetTokens) > 0 ? Number(c.budgetTokens) : 1200
    }
  } catch {
    return { curated: true, budgetTokens: 1200 }
  }
}

/** 估算被遮蔽区的规模:input.messages 的文本 + 工具 schema(粗估,宁大不小)。 */
function estimateInputTokens (input) {
  const msgs = input && Array.isArray(input.messages) ? input.messages : []
  let chars = 0
  for (const m of msgs) {
    const blocks = m && Array.isArray(m.content) ? m.content : []
    for (const b of blocks) {
      if (b === null || typeof b !== 'object') continue
      if (typeof b.text === 'string') chars += b.text.length
      else if (typeof b.content === 'string') chars += b.content.length
      else if (b.type === 'tool_use' || b.type === 'tool_result') chars += JSON.stringify(b).length
    }
  }
  const tools = input && Array.isArray(input.tools) ? input.tools : []
  for (const t of tools) {
    if (t && typeof t === 'object') chars += String(t.name ?? '').length + 200
  }
  return estimateTokens('x'.repeat(chars)) // 只借估算器的除法
}

/**
 * Echo 压缩后端。挂法(03 §5;dsh-base 自己的注释:*"Backend independent, so it
 * follows whichever compaction service this leaf mounts"*):在 **Echo 预设**的
 * compaction 域里把这行换成本插件,别的预设继续用 stock。
 */
export class EchoCompactionEngine extends BasicCompactionEngine {
  static inject = [...BasicCompactionEngine.inject]

  /**
   * 唯一的子类钩子。签名以装机版为准:`(input, agent, signal)`。
   * @returns {Promise<{summary: Array<{type:'text',text:string}>, provider: string, model: string}>}
   */
  async summarize (input, agent, signal) {
    // ★ 2026-10-08(路 B:策展跟「Echo 会话开关」联动):
    //   不是**顶层会话**(子代理那类)、或这条会话**没开 Echo**(电源 / 范围闸判 false)⇒ 原样交回宿主默认。
    //   为什么能这么回落:基类 `summarize` 与我们**同签名**,它的默认实现就是"调 LLM 写摘要"
    //   (`dsh-compaction-basic/lib/index.js:899-902`)⇒ 行为等价于"这个会话根本没挂本后端"。
    //   ⚠️ 本文件里**不许**出现那个 LLM 钩子的符号名(契约电池 `tests/compaction.test.js` 会红)。
    //   零行为变化的地基:今天 `enabled=true` + `scope='all'` ⇒ 所有顶层会话都 `sessionEnabled` ⇒ 走原路。
    const sid = String(agent?.session?.id ?? '')
    if (!isTopLevelSession(agent) || !sessionEnabled(sid)) return super.summarize(input, agent, signal)
    const log = this?.ctx?.logger ?? null
    const warn = (msg) => { try { log?.warn?.('echo: ' + msg) } catch { } }
    const settings = readCurationSettings()
    const totalTokens = estimateInputTokens(input)
    const budgetTokens = budgetFor({ totalTokens, configuredTokens: settings.budgetTokens })
    let text = ''
    if (settings.curated) {
      try {
        const rows = readSoulSnapshot(dbPathOf(), Math.floor(Date.now() / 1000))
        text = composeCuratedText(rows, { budgetTokens })
      } catch (err) {
        warn('策展块组装失败,退化成最小账本(压缩照常): ' + String(err?.message ?? err))
      }
    }
    if (String(text).trim() === '') text = fallbackText()
    // 溯源诚实:谁写的这份摘要,日志里要有真实答案(sid 已在函数开头取好)
    try {
      log?.info?.('echo: 压缩改走策展后端 provider=' + CURATION_PROVIDER
        + ' model=' + CURATION_MODEL + ' 预算≈' + budgetTokens + ' tokens'
        + ' 估计输出≈' + estimateTokens(text) + (sid ? ' session=' + sid : ''))
    } catch { }
    return { summary: [{ type: 'text', text }], provider: CURATION_PROVIDER, model: CURATION_MODEL }
  }
}

export default EchoCompactionEngine
