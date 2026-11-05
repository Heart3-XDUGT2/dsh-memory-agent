/**
 * 气泡分条 + 泡间节奏 —— **从 AstrBot 原样移植**(不是重新设计)。
 *
 * A 侧出处:
 *   - 切分:`core/echo_utils.py:82 split_bubbles(text, max_chars=30, max_bubbles=5)`
 *           与它用的 `_split_long_sentence`(同文件 :55)
 *   - 节奏:`main.py:1384 _bubble_delay(bubble)`
 *
 * A 侧 v8.10.0 原注(照抄,因为它是这个模块存在的理由):
 *   「她的回复中位数 123 字,用户 12 字 —— 体量差 10 倍,一大段就是 AI 感的来源。
 *     切泡只改包装不减体量(体量靠嘴巴的紧预算治),但它给了「中途」一个存在的前提:
 *     没有多泡就没有打断(barge-in)。」
 *
 * 规则(与 A 侧逐条对应):
 *   1. 短的直接直通:≤max_chars 且没有换行 → 一泡
 *   2. **模型自己写的换行是天然气泡界** → 先按 \n+ 切段
 *   3. 段内按 。？！…!?~ 切句,短句装箱到 max_chars(装箱而不是一句一泡,防碎片)
 *   4. 单句超长 → 退逗号 / 顿号 / 分号切;逗号都救不了就整句留着
 *      (「绝不切词中」是铁律:中文没有词边界,任意位置硬切都是切词中,
 *       所以宁可留一泡长的 —— 这是 A 侧抄 openclaw 的教训)
 *   5. 泡数封顶 5,尾巴合并进最后一泡
 *   6. 泡间延迟 = min(2.0, 0.4 + 字数*0.045) × scale × uniform(0.7, 1.3)
 *      (QQ 没有「正在输入」指示器,延迟太久只是沉默;30 字 ≈ 1.7s,单泡封顶 2s,
 *       总时长由泡数封顶天然兜在 ~8s 内)
 *
 * 与 A 侧唯一的实现差别:字数用**码点**数([...s].length),不是 JS 的 UTF-16 长度 ——
 * 否则 emoji 会被算成两个字,箱子会提前满。
 */

/** A 侧硬编码的泡数上限(`split_bubbles` 的默认参数)。 */
export const BUBBLE_MAX_BUBBLES = 5

/** 字数按码点算(与 Python `len(str)` 对齐)。 */
export const charLen = (s) => [...String(s ?? '')].length

/** 单句超过 maxChars 时退到逗号/顿号/分号切;逗号都救不了的长句整句保留。 */
export function splitLongSentence (sent, maxChars = 30) {
  const parts = String(sent ?? '').split(/(?<=[，、；])/).map((x) => x.trim()).filter((x) => x !== '')
  const out = []
  let box = ''
  for (const p of parts) {
    if (charLen(p) > maxChars) {
      if (box !== '') {
        out.push(box)
        box = ''
      }
      out.push(p)
      continue
    }
    if (box !== '' && charLen(box) + charLen(p) > maxChars) {
      out.push(box)
      box = p
    } else {
      box += p
    }
  }
  if (box !== '') out.push(box)
  return out
}

/**
 * 把一段话切成聊天气泡。空输入返回 []。
 * 返回的每一泡都是**原文的子串拼接**,不增字不减字(A 侧同)。
 */
export function splitBubbles (text, { maxChars = 30, maxBubbles = BUBBLE_MAX_BUBBLES } = {}) {
  const body = String(text ?? '').trim()
  if (body === '') return []
  const cap = Math.max(1, Number(maxChars) || 30)
  if (charLen(body) <= cap && !body.includes('\n')) return [body]
  const rawSegments = body.split(/\n+/).map((x) => x.trim()).filter((x) => x !== '')
  const bubbles = []
  for (const seg of rawSegments) {
    if (charLen(seg) <= cap) {
      bubbles.push(seg)
      continue
    }
    const sentences = seg.split(/(?<=[。？！…!?~])/).map((x) => x.trim()).filter((x) => x !== '')
    let box = ''
    for (const sent of sentences) {
      if (charLen(sent) > cap) {
        if (box !== '') {
          bubbles.push(box)
          box = ''
        }
        for (const piece of splitLongSentence(sent, cap)) bubbles.push(piece)
        continue
      }
      if (box !== '' && charLen(box) + charLen(sent) > cap) {
        bubbles.push(box)
        box = sent
      } else {
        box += sent
      }
    }
    if (box !== '') bubbles.push(box)
  }
  const limit = Math.max(1, Number(maxBubbles) || BUBBLE_MAX_BUBBLES)
  if (bubbles.length > limit) {
    const head = bubbles.slice(0, limit - 1)
    head.push(bubbles.slice(limit - 1).join(''))
    return head
  }
  return bubbles
}

/** 泡间延迟(秒):∝ 字数,乘 scale,带抖动。`rand` 可注入,便于测试。 */
export function bubbleDelaySec (bubble, scale = 1, rand = Math.random) {
  const sc = Math.max(0, Number(scale) || 0)
  const base = Math.min(2.0, 0.4 + charLen(bubble) * 0.045)
  const jitter = 0.7 + Math.max(0, Math.min(1, Number(rand()) || 0)) * 0.6
  return base * sc * jitter
}

/**
 * 给她的一段回复排出发送计划:每泡带自己的**到期时刻** `notBefore`。
 *
 * 第一泡立刻发(now);第 i+1 泡的到期时刻 = 第 i 泡的到期时刻 + 第 i 泡的延迟
 * —— 与 A 侧「yield 完这泡,再 sleep _bubble_delay(这泡)」逐字对应。
 *
 * @returns {{text: string, seq: number, delaySec: number, notBefore: number}[]}
 */
export function planBubbles (text, { maxChars = 30, maxBubbles = BUBBLE_MAX_BUBBLES, scale = 1, now = 0, rand = Math.random } = {}) {
  const bubbles = splitBubbles(text, { maxChars, maxBubbles })
  const t0 = Number(now) || 0
  const plan = []
  let at = t0
  for (let i = 0; i < bubbles.length; i++) {
    const delaySec = bubbleDelaySec(bubbles[i], scale, rand)
    plan.push({ text: bubbles[i], seq: i, delaySec, notBefore: i === 0 ? t0 : at })
    at += delaySec
  }
  return plan
}
