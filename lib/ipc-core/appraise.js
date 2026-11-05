/**
 * 对话 → 关系打分层（纯 LLM 版）。
 *
 * 这里只负责**离线可测的那部分**：怎么问、怎么把模型的回答解析成两个坐标。
 * 「什么时候问、用哪个模型问」由 host 侧决定。
 *
 * ## 为什么一次要问两个姿态
 *
 * PAD 只问「角色的情绪」。IPC 的关系量是**二元函数**，只问一个点算不出互补性，
 * 所以每次打分必须同时给出两个位置：
 *
 * - `self` —— **角色此刻对用户**的互动方式（行为）。
 * - `other` —— **角色读到的、用户此刻对角色**的互动方式。
 *
 * ⚠️ `other` 是**角色的解读**，不是客观事实。这一条必须写在提示词里，也必须写在
 * 数据结构里（`perceived: true`）：模型扮演的是角色，它没有全知视角。把「角色以为
 * 用户在冷淡」当成「用户在冷淡」，就会让整段关系读数建立在幻觉上。这与 PAD 插件
 * 踩过的那个坑同源——**归属错了，数值再准也没意义**（当初关键词路径读的是用户
 * 说的话，却记成角色自己的情绪）。
 *
 * ## 为什么没有关键词兜底
 *
 * 同 PAD：在用户消息里找「强势 / 冷淡」这类词，命中了就推关系，测的是文本而不是
 * 理解。用户说「我今天被人凶了一顿」（在讲自己的事）不该让角色对用户变敌对。
 *
 * @module dsh-interpersonal-circumplex/core/appraise
 */

import {
  AXES,
  AXIS_META,
  OCTANTS,
  angleDeg,
  clamp01,
  fromBipolar,
  octantOf,
  quantizePoint,
  relationship,
} from './circumplex.js';
import { LEXICON } from './lexicon.js';

/**
 * 要求模型返回的 JSON 形状。
 *
 * 刻意用**嵌套**结构：`self` / `other` 两个块各自完整，模型不容易把两个视角的
 * 数字串在一起（扁平的 `selfA` / `otherA` 更容易让模型写反）。解析层同时兼容
 * 扁平写法，见 {@link parseAppraisal}。
 */
export const APPRAISAL_JSON_SHAPE = Object.freeze({
  self: {
    a: '谁在主导：角色说了算（1.0）还是听用户的（0.0），0.5 是中间',
    c: '多亲近：角色想靠近这个用户（1.0）还是想保持距离（0.0），0.5 是中间',
    label: '概括角色此刻这个姿态的短词（中文，如「主导」「退让」「亲近友好」）',
  },
  other: {
    a: '角色读到的：用户此刻是自己说了算（1.0）还是听角色的（0.0）',
    c: '角色读到的：用户此刻是想靠近角色（1.0）还是想保持距离（0.0）',
    label: '概括用户此刻这个姿态的短词（中文）',
  },
  confidence: '你对这次判断的把握，0.0~1.0',
  reason: '一句话说明这段关系为什么是这个样子（中文，不超过 40 字）',
});

/**
 * 渲染八种姿态的参考表，给模型一个「方向」的刻度参照。
 *
 * 八种姿态是**按角度切出来的**，不像 PAD 那样能靠三个轴的正负推出来，所以这张
 * 表必须显式给出——否则模型不知道 45° 和 135° 的区别在哪。
 * @returns {string} 形如 `主导（拿主意、给方向、说了算容易）` 的紧凑文本。
 */
export function renderOctantTable() {
  return OCTANTS
    .map((octant) => `${octant.zh}（${octant.gloss}）`)
    .join('；');
}

/**
 * 构造打分用的 system 提示词。
 *
 * 四条刻意的约束：**归属**（两个视角各自是谁）、**行为而非特质**、**两个轴分开
 * 判**、**不要主动去凑互补**。最后一条尤其重要：互补性是理论用来**预测**互动的
 * 量，不是角色应当追求的规范；让模型去凑互补，打出来的就不是观测而是角色扮演者
 * 的一厢情愿。
 * @returns {string} system 提示词。
 */
/**
 * 构造打分用的 system 提示词。
 * @param {object} [options] 选项。
 * @param {boolean} [options.opening=false] 是否为**开局判断**（判的是角色刚登场时的默认相处方式）。
 * @returns {string} system 提示词。
 */
export function buildAppraisalSystemPrompt(options = {}) {
  const opening = options.opening === true;
  const axisLines = AXES.map((axis) => {
    const meta = AXIS_META[axis];
    return `- ${axis}（${meta.zh}）：${meta.question}`
      + ` 0.0 是「${meta.lowLabel}」，1.0 是「${meta.highLabel}」。`;
  });

  const rules = opening
    ? [
      '规则（这是**开局判断**，与逐轮标注不同）：',
      '1. **此刻还没有发生过对话**，所以不要去找「这一轮他们怎么互动的」——要判的是',
      '   **角色在这个人面前刚登场时的默认相处方式**。',
      '2. 唯一的依据是**角色卡**：人设里写的性情、说话习惯、以及它跟这个人的关系，',
      '   就是角色此刻的位置。黏人、爱撒娇、一见人就凑上来的角色，开场就是高亲近',
      '   （多亲近明显高于 0.5）；冷淡、克制、公事公办的角色，开场就是低亲近。',
      '   主导性同理：爱抢话、爱拿主意的角色开场就偏高，顺从、看脸色的角色开场就偏低。',
      '3. **不许因为「还没有剧情输入」就退回 0.5/0.5。** 平坦只在人设确实没有相处倾向时',
      '   才成立，而绝大多数角色卡不是这样。默认相处方式是人格的一部分，不是',
      '   「没有输入」的同义词。',
      '4. `other` 仍然只能写成**角色的解读**：角色卡里若写了它怎么看待用户（饲主、搭档、',
      '   陌生人、上级……），就照那个视角写；不确定时给 0.5 并在理由里说明。',
      '5. 不要凭空编造剧情。用户开局说的第一句话只做微调——它通常很轻，不该把你从',
      '   人设的默认位置拉回平坦。',
    ]
    : [
      '规则：',
      '1. **标行为，不标人格**。要回答的是「此时此刻他是怎么跟对方相处的」，不是「他是个强势的人」。',
      '   同一个人对同一个人，在不同轮次里位置本来就会移动，这是正常的。',
      '2. **两个视角必须分开判**：',
      '   - `self` 是**角色**此刻对用户的相处方式；',
      '   - `other` 是**角色读到的**用户此刻的相处方式。',
      '   `other` 是角色的解读，不是客观事实。角色只有自己的视角，就照它的视角写。',
      '3. **不要镜像**。用户强势不代表角色也强势，也不代表角色一定退让；要看角色实际上',
      '   是怎么回应的。这正是要捕捉的东西。',
      '4. **两个维度分开判**。一个人可以既热络又强势（热络 + 主导），也可以既亲近又退让',
      '   （亲近友好 + 退让）。不要把两者绑在一起推。',
      '5. **不要为了「凑得好看」而调数值**。这里只要求如实标注；一个人带一个跟这类判断由程序算。',
      '6. **朴素的社交输入也有姿态**：被招呼、被回应、有人愿意搭话，角色通常会有轻微到中度的',
      '   亲近（多亲近这一项高于 0.5）。不要因为「内容不多」就判成完全没反应。',
      '7. **有惯性**：延续上一段气氛时不要剧烈跳变，除非本轮内容本身有明确指向。',
      '   惯性只是对第 1 条的修正，不能盖过它。',
      '8. 只有一种情况不需要反应：双方都只是在**讨论**某个说法本身（例如问「什么叫主导」），',
      '   此时两人的位置不因这个讨论而改变。',
    ];

  return [
    opening
      ? '你在标注一段**双人互动**里两个人各自的位置。这一轮标注的是**角色刚登场时的默认相处方式**。'
      : '你在标注一段**双人互动**里两个人各自的位置。',
    '标的是**此刻两个人分别是怎么跟对方相处的**——不是他们是什么样的人。',
    '',
    '两个维度，都是 0.0~1.0，0.5 是中间：',
    ...axisLines,
    '',
    `八种常见姿态（用来对号入座）：${renderOctantTable()}。`,
    '例如 谁主导=0.8、多亲近=0.5 读作「主导」；谁主导=0.2、多亲近=0.6 读作「退让」；'
    + '谁主导=0.5、多亲近=0.8 读作「亲近友好」。',
    '',
    ...rules,
    '',
    '只输出一个 JSON 对象，不要代码块、不要任何解释：',
    JSON.stringify(APPRAISAL_JSON_SHAPE, null, 2),
  ].join('\n');
}

/**
 * 构造打分用的 user 消息内容。
 * @param {object} params 输入。
 * @param {string} params.transcript 最近的对话文本（已裁剪、已标注说话人）。
 * @param {{self:{a:number,c:number}, other:{a:number,c:number}}} [params.current] 双方当前位置。
 * @param {{self?:string, other?:string}} [params.previousLabels] 上一轮的姿态短语。
 * @param {string} [params.roleName='角色'] 角色名。
 * @param {string} [params.userName='用户'] 用户名。
 * @param {string} [params.persona] 角色卡正文；只在**开局判断**时传。
 * @returns {string} user 消息文本。
 */
export function buildAppraisalUserContent({
  transcript,
  current,
  previousLabels,
  roleName = '角色',
  userName = '用户',
  persona,
}) {
  const lines = [];
  if (current !== undefined) {
    const labelOf = (key) => {
      const text = previousLabels?.[key];
      return text === undefined || text === '' ? '' : `（上一轮标为「${text}」）`;
    };
    lines.push(
      `【当前双方位置】${roleName}：谁主导 ${current.self.a.toFixed(1)}、多亲近 ${current.self.c.toFixed(1)}${labelOf('self')}；`
      + `${userName}：谁主导 ${current.other.a.toFixed(1)}、多亲近 ${current.other.c.toFixed(1)}${labelOf('other')}`,
      '',
    );
  }
  // 开局判断：光看一句「你好」是判不出关系姿态的（实测开局打分稳定落在平坦区）。
  // 把角色卡一起喂进去，判的才是「这个角色开局时怎么跟人相处」。
  //
  // ⚠️ 传进来的往往是**整段 persona**，而它前面可能还拼着一段通用的扮演规则
  // （roleplay 插件就是这么拼的：六段规则 + 角色卡）。所以这里必须说清「哪一部分
  // 才是依据」——上一版没说清，加上调用方按字符数从头部截断，结果喂进去的全是
  // 规则、一个字的人设都没有，模型只能抱怨「角色卡未提供具体性情」。
  const opening = typeof persona === 'string' && persona.trim() !== '';
  if (opening) {
    lines.push(
      '【开局：角色设定】（这是判断的唯一依据）',
      '下面这段文字取自本次会话的系统提示词。其中**描述这个角色的部分**（名字、设定、',
      '当前场景、它跟用户的关系）才是你的判断依据；其余与本角色无关的通用扮演规则请忽略。',
      '请据此判断角色在**刚见到用户这一刻**的默认位置。',
      persona,
      '',
    );
  }
  lines.push(
    opening ? '【开局时用户说的第一句话】（只做微调）' : '【最近对话】',
    transcript,
    '',
    `请输出此刻这段互动里，\`self\`（${roleName}对${userName}）与 \`other\`（${roleName}读到的${userName}）各自的位置。`,
  );
  if (opening) {
    lines.push('依据是上面的角色设定，不是「有没有互动内容」——不要因为还没有剧情就退回 0.5/0.5。');
  }
  return lines.join('\n');
}

/**
 * 把一串对话消息裁成打分层用的紧凑文本。
 *
 * 超长时**保留最新的**并整条丢弃最旧的，而不是从中间截断——从中间截断会让一句
 * 话只剩半截，比缺少更早的上下文更容易误导模型。单条过长时按尾部截断。
 * @param {Array<{role:'user'|'assistant'|'system', text:string}>} messages 按时间升序的消息。
 * @param {object} [options] 选项。
 * @param {number} [options.maxChars=1000] 预算字符数。
 * @param {number} [options.perMessageChars=200] 单条消息的字符上限。
 * @param {string} [options.roleName='角色'] 角色名。
 * @param {string} [options.userName='用户'] 用户名。
 * @returns {string} 形如 `用户：…\n角色：…` 的紧凑文本。
 */
export function renderTranscript(messages, options = {}) {
  const maxChars = options.maxChars ?? 1000;
  const perMessage = options.perMessageChars ?? 200;
  const roleName = options.roleName ?? '角色';
  const userName = options.userName ?? '用户';

  const labeled = messages
    .filter((message) => typeof message.text === 'string' && message.text.trim() !== '')
    .map((message) => {
      const speaker = message.role === 'assistant' ? roleName : userName;
      const text = message.text.replace(/\s+/gu, ' ').trim();
      const clipped = text.length > perMessage ? `…${text.slice(text.length - perMessage)}` : text;
      return `${speaker}：${clipped}`;
    });

  const kept = [];
  let budget = maxChars;
  for (let i = labeled.length - 1; i >= 0; i -= 1) {
    const line = labeled[i];
    if (line.length > budget && kept.length > 0) break;
    kept.unshift(line);
    budget -= line.length;
  }
  return kept.join('\n');
}

/**
 * 从模型输出里抠出 JSON 对象，并容忍**被截断**的输出。
 *
 * 先剥 Markdown 围栏，再取第一个 `{` 到最后一个 `}` 之间的内容；失败就按字段名
 * 逐个捞。分两级的理由是实测过的：输出预算被推理 token 吃掉时 JSON 会没有收尾的
 * `}`，严格 `JSON.parse` 必然失败，于是一整轮关系就白丢了。
 * @param {string} raw 模型原始输出。
 * @returns {object} 解析出的对象。
 * @throws {SyntaxError} 当连一个字段都捞不出来时。
 */
export function extractJsonObject(raw) {
  const text = String(raw ?? '').replace(/```(?:json)?/giu, '').trim();
  if (text === '') {
    throw new SyntaxError('模型输出为空：多半是 maxTokens 预算被推理 token 耗尽（调大 appraiseMaxTokens）');
  }
  const start = text.indexOf('{');
  if (start === -1) {
    throw new SyntaxError(`模型输出里没有 JSON 对象：${text.slice(0, 120)}`);
  }

  const end = text.lastIndexOf('}');
  if (end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // 落到下面的字段救援：可能是尾部被截断，也可能是中途出现了坏字符。
    }
  }

  const salvaged = salvageFields(text.slice(start));
  if (Object.keys(salvaged).length === 0) {
    throw new SyntaxError(`模型输出里没有可用的 JSON 字段：${text.slice(0, 120)}`);
  }
  Object.defineProperty(salvaged, '__salvaged', { value: true, enumerable: false });
  return salvaged;
}

/**
 * 从一段残缺 JSON 里捞出双方坐标。
 *
 * 两种布局都捞：嵌套（`"self":{"a":…}`）与扁平（`"selfA":…`）。模型在截断时经常
 * 把嵌套结构写坏，扁平写法更容易活下来，所以不能只认一种。
 * @param {string} text 从第一个 `{` 开始的文本。
 * @returns {object} 捞到的字段；一个都没捞到时为空对象。
 */
function salvageFields(text) {
  const out = {};
  /**
   * 在一段文本里按正则取第一个捕获组的数值。
   * @param {string} source 搜索范围。
   * @param {RegExp} pattern 带一个捕获组的正则。
   * @returns {number|undefined} 数值，未命中时为 `undefined`。
   */
  const numberIn = (source, pattern) => {
    const match = pattern.exec(source);
    return match === null ? undefined : Number(match[1]);
  };
  /** 同上，但取字符串。 */
  const stringIn = (source, pattern) => {
    const match = pattern.exec(source);
    return match === null || match[1] === '' ? undefined : match[1];
  };

  const A_PATTERN = /"(?:a|A|agency|Agency|掌控|支配)"\s*:\s*(-?\d+(?:\.\d+)?)/u;
  const C_PATTERN = /"(?:c|C|communion|Communion|联结|亲和)"\s*:\s*(-?\d+(?:\.\d+)?)/u;
  const LABEL_PATTERN = /"(?:label|word|name|姿态|短词)"\s*:\s*"([^"]*)"?/u;

  // ---- 嵌套写法：先切出 self / other 两个块，再在块内找 a / c。
  for (const [key, blockPattern] of [
    ['self', /"(?:self|agent|character|角色|assistant)"\s*:\s*\{([^}]*)\}/u],
    ['other', /"(?:other|user|partner|对方|用户|interlocutor)"\s*:\s*\{([^}]*)\}/u],
  ]) {
    const block = blockPattern.exec(text);
    if (block === null) continue;
    const inner = block[1];
    const side = out[key] ?? {};
    const a = numberIn(inner, A_PATTERN);
    const c = numberIn(inner, C_PATTERN);
    const label = stringIn(inner, LABEL_PATTERN);
    if (a !== undefined) side.a = a;
    if (c !== undefined) side.c = c;
    if (label !== undefined) side.label = label;
    if (Object.keys(side).length > 0) out[key] = side;
  }

  // ---- 扁平写法：selfA / otherC / self_label 等。
  for (const [key, pattern] of [
    ['selfA', /"self[_\s]?a"\s*:\s*(-?\d+(?:\.\d+)?)/iu],
    ['selfC', /"self[_\s]?c"\s*:\s*(-?\d+(?:\.\d+)?)/iu],
    ['otherA', /"other[_\s]?a"\s*:\s*(-?\d+(?:\.\d+)?)/iu],
    ['otherC', /"other[_\s]?c"\s*:\s*(-?\d+(?:\.\d+)?)/iu],
  ]) {
    const value = numberIn(text, pattern);
    if (value === undefined) continue;
    const side = key.startsWith('self') ? 'self' : 'other';
    const axis = key.endsWith('A') ? 'a' : 'c';
    out[side] = { ...(out[side] ?? {}), [axis]: value };
  }
  for (const [side, pattern] of [
    ['self', /"(?:self|role)[_\s]?label"\s*:\s*"([^"]*)"?/iu],
    ['other', /"(?:other|user)[_\s]?label"\s*:\s*"([^"]*)"?/iu],
  ]) {
    const label = stringIn(text, pattern);
    if (label !== undefined) out[side] = { ...(out[side] ?? {}), label };
  }

  const confidence = numberIn(text, /"(?:confidence|把握|置信度)"\s*:\s*(-?\d+(?:\.\d+)?)/u);
  if (confidence !== undefined) out.confidence = confidence;
  const reason = stringIn(text, /"(?:reason|rationale|why|理由|原因)"\s*:\s*"([^"]*)"?/u);
  if (reason !== undefined) out.reason = reason;

  return out;
}

/**
 * 从对象里按多组别名取第一个存在的键。
 * @param {object} source 源对象。
 * @param {readonly string[]} names 候选键名。
 * @returns {unknown} 取到的值，或 `undefined`。
 */
function pick(source, names) {
  for (const name of names) {
    if (source?.[name] !== undefined && source[name] !== null) return source[name];
  }
  return undefined;
}

/**
 * 把一组轴值统一到 `[0, 1]`。
 *
 * 量表判定：**若全都解析成数字且其中任意一个为负，则整组按双极 `[-1, 1]` 处理**，
 * 否则按单极处理。判定必须整组一致——逐轴判定会让 0.3 这种值在两种解释间反复横跳。
 * @param {number[]} values 待判定的轴值。
 * @returns {{scale:'bipolar'|'unipolar', values:number[]}} 判定结果与换算后的值。
 */
export function normalizeScale(values) {
  const numeric = values.map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined));
  const anyNegative = numeric.some((value) => value !== undefined && value < 0);
  const scale = anyNegative ? 'bipolar' : 'unipolar';
  return {
    scale,
    values: numeric.map((value) => {
      if (value === undefined) return undefined;
      return scale === 'bipolar' ? fromBipolar(value) : clamp01(value);
    }),
  };
}

/**
 * 在词表里按中文词、英文词或别名查找条目。
 * @param {string} word 姿态词。
 * @param {ReadonlyArray<object>} [lexicon] 词表。
 * @returns {object|undefined} 命中的条目。
 */
export function findByWord(word, lexicon = LEXICON) {
  const needle = String(word).trim().toLowerCase();
  if (needle === '') return undefined;
  for (const entry of lexicon) {
    if (entry.zh === word || entry.en.toLowerCase() === needle || entry.id === needle) return entry;
  }
  for (const entry of lexicon) {
    if (entry.aliases.some((alias) => alias.toLowerCase() === needle)) return entry;
  }
  return undefined;
}

/**
 * 把一侧的原始字段规范成一个 IPC 点。
 *
 * 三级回退，优先级从高到低：
 * 1. `a` 与 `c` 都在 → 直接用（并按整组量表判定换算）；
 * 2. 缺数值但给了 `label` → 到词表里查那个词的坐标；
 * 3. 只有部分轴 → 缺失的轴取 0.5（均衡），而不是报错。
 *
 * 第 2 条是有用的兜底：模型偶尔只给词不给数，而「退让」这个词本身在词表里就有
 * 坐标，比整轮丢弃划算。
 * @param {object} side 一侧的原始对象。
 * @param {ReadonlyArray<object>} lexicon 词表。
 * @returns {{point:{a:number,c:number}, label:string|undefined, matched:object|undefined, complete:boolean}} 规范化结果。
 */
function normalizeSide(side, lexicon) {
  const rawA = pick(side, ['a', 'A', 'agency', 'Agency', '掌控', '支配']);
  const rawC = pick(side, ['c', 'C', 'communion', 'Communion', '联结', '亲和']);
  const labelRaw = pick(side, ['label', 'word', 'name', '姿态', '短词']);
  const label = labelRaw === undefined ? undefined : String(labelRaw).trim();
  const matched = label === undefined ? undefined : findByWord(label, lexicon);

  const { values } = normalizeScale([rawA, rawC].map(Number));
  const complete = values.every((value) => value !== undefined);
  if (complete) {
    return { point: quantizePoint({ a: values[0], c: values[1] }), label, matched, complete: true };
  }
  if (matched !== undefined) {
    return { point: { a: matched.a, c: matched.c }, label, matched, complete: false };
  }
  // 部分轴：给了的那个照用，没给的取均衡。
  return {
    point: quantizePoint({ a: values[0] ?? 0.5, c: values[1] ?? 0.5 }),
    label,
    matched,
    complete: false,
  };
}

/**
 * 解析并规范化一次关系打分。
 * @param {string|object} raw 模型输出（字符串或已解析对象）。
 * @param {object} [options] 选项。
 * @param {ReadonlyArray<object>} [options.lexicon] 词表，用于把 `label` 解析成坐标。
 * @returns {{
 *   self:{a:number,c:number}, other:{a:number,c:number},
 *   labels:{self:string|undefined, other:string|undefined},
 *   confidence:number, reason:string|undefined,
 *   scale:'bipolar'|'unipolar', complete:boolean, perceived:true,
 *   metrics:object
 * }} 规范化后的打分。
 * @throws {SyntaxError|TypeError} 当输出无法解析，或两侧都没给出可用信息时。
 */
export function parseAppraisal(raw, options = {}) {
  const lexicon = options.lexicon ?? LEXICON;
  const object = typeof raw === 'string' ? extractJsonObject(raw) : raw;
  if (object === null || typeof object !== 'object') {
    throw new TypeError('打分结果不是对象');
  }

  const selfRaw = pick(object, ['self', 'agent', 'character', '角色', 'assistant']);
  const otherRaw = pick(object, ['other', 'user', 'partner', '对方', '用户']);

  /**
   * 读扁平写法：`selfA` / `self_a` / `selfC` / `selfLabel` 等。
   *
   * 提示词要的是嵌套结构，但模型有时会平铺。这条路径**必须**在正常解析里也有，
   * 不能只放在 `salvageFields` 里——救援只在「字符串解析失败」时才跑，而一份合法
   * 的扁平 JSON 会解析成功、然后在找不到 `self` 键时报错。这是实测踩到的：
   * 扁平输入直接被判成「既没有 self 也没有 other」。
   * @param {string} prefix `self` 或 `other`。
   * @returns {object|undefined} 拼出的一侧，三个键都没有时返回 `undefined`。
   */
  const flatSide = (prefix) => {
    const names = (suffix) => [
      `${prefix}${suffix}`,
      `${prefix}${suffix.toLowerCase()}`,
      `${prefix}_${suffix.toLowerCase()}`,
      `${prefix}_${suffix}`,
    ];
    const a = pick(object, names('A'));
    const c = pick(object, names('C'));
    const label = pick(object, [...names('Label'), `${prefix}label`]);
    if (a === undefined && c === undefined && label === undefined) return undefined;
    return { a, c, label };
  };

  // 容忍「模型把两个视角都塞进了一个块」：若 self 缺失而顶层直接有 a/c，就当 self。
  const selfSide = selfRaw
    ?? flatSide('self')
    ?? (pick(object, ['a', 'agency']) !== undefined ? object : undefined);
  const otherSide = otherRaw ?? flatSide('other');

  if (selfSide === undefined && otherSide === undefined) {
    throw new TypeError('打分结果里既没有 self 也没有 other');
  }

  const self = normalizeSide(selfSide ?? {}, lexicon);
  const other = normalizeSide(otherSide ?? {}, lexicon);

  // 量表判定整组一致：把两侧四个值放在一起判，避免 self 按单极、other 按双极。
  const rawValues = [selfSide, otherSide].flatMap((side) => (
    side === undefined ? [] : [Number(pick(side, ['a', 'A'])), Number(pick(side, ['c', 'C']))]
  ));
  const { scale } = normalizeScale(rawValues);

  const confidenceRaw = Number(pick(object, ['confidence', '把握', '置信度']));
  const reasonRaw = pick(object, ['reason', 'rationale', 'why', '理由', '原因']);

  return {
    self: self.point,
    other: other.point,
    labels: { self: self.label, other: other.label },
    matched: { self: self.matched, other: other.matched },
    confidence: Number.isFinite(confidenceRaw) ? clamp01(confidenceRaw) : 0.6,
    reason: reasonRaw === undefined ? undefined : String(reasonRaw).trim().slice(0, 160),
    scale,
    complete: self.complete && other.complete,
    /** 固定为 true：`other` 永远是角色的解读，不是客观事实。 */
    perceived: true,
    /** 由打分直接算出的关系度量，供审计与「本轮发生了什么」使用。 */
    metrics: relationship(self.point, other.point),
    /** 输出被截断、靠字段救援拼出来的结果。上层应当把它记进审计。 */
    salvaged: object.__salvaged === true,
  };
}

/**
 * 把 IPC 点渲染成一行紧凑文本，供提示词与日志复用。
 * @param {{a:number,c:number}} point IPC 点。
 * @returns {string} 例如 `A0.8 C0.4`。
 */
export function formatSide(point) {
  return AXES.map((axis) => `${AXIS_META[axis].short}${point[axis].toFixed(1)}`).join(' ');
}

/** 再导出轴与分仪常量，方便调用方不额外 import。 */
export { AXES, OCTANTS, angleDeg, octantOf };
