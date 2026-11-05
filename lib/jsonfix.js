/**
 * dsh-echo — JSON 修复阶梯(A 侧 `core/echo_utils.py:262-323` +
 * `brains/echo_llm_client.py:205-247` 逐字移植)
 * ============================================================
 * 模型"必须返回 JSON"时的经典事故:多行中文直接写进字符串字面量(真换行
 * 而不是 `\n`)、整段用中文智能引号当定界符。RFC 8259 一个字符都不认,
 * 解析当场失败 —— 而失败的代价是这一轮的记忆/体检白跑。
 *
 * A 的阶梯(**严格解析永远排第一,保证零回归**):
 *   ① 原样解析 —— 绝大多数情况在这一步就够了;
 *   ② 转义字符串**内部**的裸控制字符;
 *   ③ 全角引号当定界符的形态 → 先把 “ ” 归一成 ASCII 引号,再做②。
 *
 * DSH 的实话(为什么这里只有薄薄一层接线):壳侧的模型输出一律走宿主的
 * `structured_output` 通道 —— 结构化由宿主保证,**壳从不解析模型文本**,
 * 所以 A 的三级阶梯在 DSH 几乎没有调用点。移植的价值在于**兜底可达**:
 * 宿主把文本原样交回来时(`structured` 是字符串,例如 provider 忽略了
 * schema),没有这一层就是静默丢弃一轮。宁可多一层解析,不可少一轮记忆。
 *
 * 两个纯函数都对**本来合法的输入逐字返回原样**(A 的承诺),所以可以放心
 * 盲用:不合法才动,合法什么都不动。
 */

/** A `echo_utils.py:313-323`:全角引号当定界符 → ASCII 引号。 */
export function normalizeJsonDelimiterQuotes (text) {
  return String(text ?? '').replace(/\u201c/g, '"').replace(/\u201d/g, '"')
}

/**
 * A `echo_utils.py:267-310`:把 JSON **字符串字面量内部**的裸控制字符转义。
 *
 * 为什么只动字符串内部:字符串**外**的换行是合法 JSON 空白,动了反而会
 * 把本来能解析的输入搞坏。所以这里用状态机跟踪 inString,只处理确实非法
 * 的字符。对本来合法的输入,输出与输入逐字相同。
 */
export function repairJsonControlChars (text) {
  const src = String(text ?? '')
  const out = []
  let inString = false
  let escaped = false
  for (const ch of src) {
    if (inString) {
      if (escaped) {
        out.push(ch)
        escaped = false
      } else if (ch === '\\') {
        out.push(ch)
        escaped = true
      } else if (ch === '"') {
        out.push(ch)
        inString = false
      } else if (ch === '\n') {
        out.push('\\n')
      } else if (ch === '\r') {
        out.push('\\r')
      } else if (ch === '\t') {
        out.push('\\t')
      } else if (ch === '\b') {
        out.push('\\b')
      } else if (ch === '\f') {
        out.push('\\f')
      } else if (ch.codePointAt(0) < 0x20) {
        out.push('\\u' + ch.codePointAt(0).toString(16).padStart(4, '0'))
      } else {
        out.push(ch)
      }
    } else {
      if (ch === '"') inString = true
      out.push(ch)
    }
  }
  return out.join('')
}

/** A `_safe_json:217-219`:剥掉 ```json 围栏(多行围栏也能剥)。 */
export function stripCodeFence (text) {
  return String(text ?? '').trim().replace(/^```(?:json)?|```$/gm, '').trim()
}

/**
 * A `_safe_json:205-247` 的三级阶梯 + **本仓多垫的一级**。返回
 * `{ value, level }`:level 0 = 原样解析成功(零回归的正常路径),
 * 1 = 控制字符修复后成功,2 = 全角引号归一后成功,3 = 归一后再修
 * 控制字符后成功。彻底失败返回 null(调用方保持原有行为)。
 *
 * 第 3 级的由来(A 的 ③ 只归一、不重扫控制字符):`repairJsonControlChars`
 * 靠 **ASCII 引号** 跟踪字符串边界,所以「全角定界符 + 字符串里真换行」
 * 这种组合 A 修不动 —— 换行在归一之前不在字符串里,归一之后没人再扫一遍。
 * 而 A 的实测形态恰恰是「整段中文智能引号 + 多行长文」,两者同现并不稀奇。
 * 垫这一级的代价是零:它排在严格解析与前三级之后,合法输入怎么也走不到;
 * 收益是少丢一轮记忆。**记在案:这是本仓对 A 的唯一一处行为增强**
 * (A `echo_llm_client.py:224-228` 只有三个候选)。
 *
 * 只接受对象(result 是 dict 才算数,A `:233`):数组/数字/字符串一律当
 * 失败 —— 我们的契约是「一个 JSON 对象」,拿到别的东西说明模型跑偏了,
 * 不如老老实实当失败。
 */
export function parseJsonLadder (text) {
  if (typeof text !== 'string') return null
  const fenced = stripCodeFence(text)
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  const body = fenced.slice(start, end + 1)
  const repaired = repairJsonControlChars(body)
  const normalized = normalizeJsonDelimiterQuotes(repaired)
  const candidates = [
    body, repaired, normalized, repairJsonControlChars(normalized)
  ]
  for (let level = 0; level < candidates.length; level++) {
    try {
      const value = JSON.parse(candidates[level])
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return { value, level }
      }
    } catch { /* 下一级 */ }
  }
  return null
}
