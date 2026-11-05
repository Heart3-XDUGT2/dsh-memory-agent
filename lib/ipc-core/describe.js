/**
 * 把关系状态渲染成可读文本——同时服务三个消费者：
 *
 * 1. **注入 prompt 的那段话**，让模型知道此刻自己与用户处在什么关系里；
 * 2. **Web 面板上的摘要行**；
 * 3. **审计日志里的一行记录**。
 *
 * 三者共用同一份渲染函数，是为了保证「模型看到的」和「用户看到的」和「日志里记的」
 * 不会互相矛盾。这是 `dsh-pad-emotion/core/describe.js` 用过的同一条约束。
 *
 * ## 这个模块最要紧的一件事：把度量翻译成行为
 *
 * 只有数值而没有指引，模型多半会无视它；只有「请对用户热情一点」而没有数值，
 * 状态就退化成了一句提示词。所以 {@link guidanceFor} 是这里的重点：它把
 * 「互补 / 反互补 / 对应」这些理论量翻译成**下一步该怎么做**。
 *
 * @module dsh-interpersonal-circumplex/core/describe
 */

import {
  AXES,
  AXIS_META,
  PROTOTYPES,
  informationNote,
  summarizeRelationship,
} from './circumplex.js';
import { hintFor, relationshipStates } from './states.js';

/**
 * 渲染「关系状态词」一行。
 *
 * 这些词来自已核实的中文量表维度名（友谊质量、师生关系、亲子关系、NRI 等），
 * 作用是把两个冷冰冰的数**说成一句人话**：现在这段关系像「亲密袒露与交流」，
 * 还是像「冲突与背叛」。详细出处见 `core/states.js`。
 * @param {object} metrics {@link import('./circumplex.js').relationship} 的结果。
 * @param {number} [limit=8] 最多列几个词。
 * @returns {string} 例如 `  关系状态：亲密袒露与交流、肯定与关心、信任尊重`。
 */
function stateLine(metrics, limit = 8) {
  // 提示词比面板多给一点：面板要简洁（6 个、每个维度一个词，避免近义刷屏），
  // 而模型这边多一两个同维度的近义说法是加强，不是啰嗦。
  const { words } = relationshipStates(metrics, { limit, maxPerFacet: 2 });
  if (words.length === 0) return '';
  return `  关系状态：${words.map((word) => word.zh).join('、')}`;
}

/**
 * 渲染一方姿态的一行描述。
 * @param {string} who 这一方的人称，例如 `你对用户`。
 * @param {object} person 单方派生视角。
 * @param {string} displayWord 选定的概述词。
 * @param {boolean} fromAppraisal 概述词是否来自打分器。
 * @returns {string} 例如 `你对用户：谁主导0.8 多亲近0.4 —— 明显主导（拿主意、给方向）`。
 */
function sideLine(who, person, displayWord, fromAppraisal) {
  const { grid, region } = person;
  const values = `${AXIS_META.a.short} ${grid.a.toFixed(1)}，${AXIS_META.c.short} ${grid.c.toFixed(1)}`;
  if (region.neutral) {
    return `  ${who}：很平淡，说不上主导还是退让、也谈不上亲疏（${values}）`;
  }
  // ⚠️ 姿态词排在两个数**前面**。
  //
  // 依据是消融实验（`_padipc_exp/out/ablation.md`）：状态块里真正推动回复的是
  // 「那个词」，不是数值（情绪词主效应 +2.03、抽掉它 4.50 → 2.10；数值单独
  // 只 +0.55、p=0.107、抽掉只掉 0.30）。IPC 侧的可读层就是这一行姿态词与它的
  // 释义；`关系结构/最弱的一半/相隔度数`那一行在同一批实验里读不出来
  // （四种关系结构的回复在亲近度、相符度、字数上都没有差别）。
  // 数值仍然保留——面板、圆盘、动力学都要它，只是它不是模型读的那一条。
  const name = fromAppraisal ? displayWord : region.label;
  return `  ${who}：${name}（${region.octant.gloss}）—— ${values}`;
}

/**
 * 渲染关系度量的一行。
 *
 * 只给三个数：最像哪种关系、有多像、以及「最弱的一半」。最后一个必须留着——
 * 它是真正驱动「关系会不会继续升级」的那个数（见 `complementarityOf` 的注释），
 * 不显示它，模型看到的数和系统实际在做的事就对不上。
 * @param {object} metrics {@link import('./circumplex.js').relationship} 的结果。
 * @returns {string} 例如 `  两人的关系：结构上是「互补」（0.92，只表示两个数各自相同还是相反，不含好坏）；最弱的一半 1.00`。
 */
function metricLine(metrics) {
  if (metrics.flat) {
    return '  两人的关系：都很平淡，还说不上是什么关系。';
  }
  // 「互补」在日常汉语里听着像好话，但 IPC 里的互补**不含好坏**：冷淡×冷淡同样是互补。
  // 不写这句限定，状态块就会出现「最像互补」和「苛责干涉、批评」并排的观感矛盾。
  return `  两人的关系：结构上是「${metrics.pattern.zh}」（${metrics.pattern.fit.toFixed(2)}`
    + '，只表示两个数各自相同还是相反，不含好坏）'
    + `${informationNote(metrics)}；最弱的一半 ${metrics.complementarityFloor.toFixed(2)}`
    + `；两人姿态相隔 ${Math.round(metrics.separationDegrees)}°`;
}

/**
 * 渲染一行紧凑摘要，适合日志与面板副标题。
 * @param {object} view 状态机 `read()` 的结果。
 * @returns {string} 例如 `互补拟合 0.92 | 角色 PA × 用户 HI | 互补性 0.96`。
 */
export function summarize(view) {
  const { metrics } = view;
  if (metrics.flat) return '两人都很平淡，说不上是什么关系';
  return `${summarizeRelationship(metrics)} | 姿态明显程度 ${metrics.meanIntensity.toFixed(2)}`;
}

/**
 * 渲染一段完整的中文描述，作为工具 `get` 动作的正文。
 *
 * 刻意**不**列四个分数的完整清单：那属于调试信息，模型读了只会分心。这里只给
 * 「最像哪种关系 + 有多像 + 最弱的一半」，其余用大白话补一句就够。
 * @param {object} view 状态机 `read()` 的结果。
 * @returns {string} 多行描述。
 */
export function describe(view) {
  const { self, other, metrics } = view;
  const lines = [];

  lines.push(sideLine('你对用户', self, view.displaySelf.zh, view.displaySelf.fromAppraisal));
  lines.push(sideLine('你读到的用户对你', other, view.displayOther.zh, view.displayOther.fromAppraisal));
  lines.push(metricLine(metrics));
  const states = stateLine(metrics, 6);
  if (states !== '') lines.push(states);

  if (!metrics.flat) {
    lines.push(
      `  谁更投入：${describeGap(metrics)}；两人姿态的明显程度 ${metrics.meanIntensity.toFixed(2)}。`,
    );
  }

  if (view.lastReason) lines.push(`  成因：${view.lastReason}`);
  return lines.join('\n');
}

/**
 * 把「双方强度之差」说成一句人话。
 * @param {object} metrics {@link import('./circumplex.js').relationship} 的结果。
 * @returns {string} 例如 `差不太多` / `角色这边更明显`。
 */
function describeGap(metrics) {
  const gap = metrics.radiusGapRatio;
  if (gap < 0.15) return '差不太多';
  return metrics.selfRadius > metrics.otherRadius
    ? '角色这边的态度更明显'
    : '用户那边的态度更明显';
}


/**
 * 按状态生成行为指引。
 *
 * ## 唯一数据源原则
 *
 * 这里**只读 `metrics.pattern` 与四个轴级分量**，绝不另立一套阈值。第一版用
 * `metrics.complementarity >= 0.7` 来断言「互补」，而同一段文本上方显示的却是
 * `metrics.pattern.zh`——两者在「掌控几乎互补、联结明显相反」的配对上会给出
 * **相反**的结论，于是注入给模型的块自己跟自己打架（实测出现过「对立拟合 0.93」
 * 与「这段互动是互补的」同时出现在一个块里）。所以现在分类断言一律走分类器，
 * 数值只用来描述程度。
 * @param {object} view 状态机 `read()` 的结果。
 * @returns {string} 一到三句指引。
 */
export function guidanceFor(view) {
  const { metrics, self, other } = view;
  // `?.` 是防守：`other.region` 在任何一处缺失时，旧写法会在 `metrics.flat` 为真时抛
  // TypeError（读 undefined 的 neutral）。真跑起来视图总是完整的，但一个渲染函数不该因为
  // 调用方少传一个字段就炸——测试里传精简视图时就踩到了。
  if (metrics.flat && other.region?.neutral === true) {
    return '  行为指引：此刻这段互动很平淡，不必刻意渲染关系，按内容本身回应即可。';
  }

  const parts = [];
  const runnerUp = metrics.prototypes[1];

  if (!metrics.flat) {
    // ---- 该怎么做。
    //
    // 刻意**不**在这里重复关系名（上面那行已经说过了）。原来每一条都以「你们是一个带、
    // 一个跟」开头，和上面那行字面重复；这里只讲下一步怎么做。
    switch (metrics.pattern.id) {
      case 'complementary':
        parts.push('顺着这套配合走就行，不必刻意制造转折');
        break;
      case 'similar':
        parts.push('你们容易同频，顺着走没问题，但留意别一起走极端——要么一起热络，要么一起冷下去');
        break;
      case 'contrast':
        parts.push(
          '这种组合最容易一轮轮升级：要么明确降温，要么把分歧直接说开，不要继续加码',
        );
        break;
      case 'opposite':
        parts.push('很难自动接上对方的节奏，需要有一方先把差异点破，否则会各说各话');
        break;
      default:
        break;
    }

    if (metrics.patternAmbiguous && runnerUp !== undefined) {
      // 只说「分不清」等于把信息丢掉，所以把次名一起给出来。
      parts.push(
        `上面这个判断别说得太死：也像「${runnerUp.zh}」（${runnerUp.fit.toFixed(2)}，`
        + `和 ${metrics.pattern.fit.toFixed(2)} 差不多），区别主要在「多亲近」那一半上`,
      );
    } else if ((metrics.undeterminedAxes ?? []).length === 1) {
      // 一个轴没有信息时必须照实说，否则模型会把结论当成「两件事都读到了」。
      const labels = { a: AXIS_META.a.zh, c: AXIS_META.c.zh };
      const missing = metrics.undeterminedAxes[0];
      const known = AXES.filter((axis) => axis !== missing).map((axis) => labels[axis]);
      parts.push(
        `（只读到「${known.join('、')}」这一半：两人在「${labels[missing]}」上都居中）`,
      );
    }
  }

  // ---- 升级风险：与动力学实际在做的事对齐（判据用的是「最弱的一半」，不是均值）
  if (metrics.complementarityFloor < 0.5 && metrics.meanIntensity > 0.4) {
    parts.push('而且系统会让双方各自越走越远，留意别把话说死');
  }

  // ---- 具体做法：**由当前的关系状态词驱动**。
  //
  // 这一段是补一个实测出来的缺口：改之前指引只按结构类型给固定一句话，而四个类型里
  // 66% 都是「互补」，于是 58 轮真实打分里最常见的两种指引覆盖了 71%、47% 干脆是
  // 「很平淡」这种空信号——状态词每轮都在变，却一个字都没进建议。
  // 现在取最贴的两三个侧面的「具体做法」（同一句只出现一次）。
  const hints = [];
  const pickedStates = relationshipStates(metrics, { limit: 3, maxPerFacet: 1 });
  for (const word of pickedStates.words) {
    // 方向传**这段关系的**方向，不传词自己的：「有主有次」这类不带方向的词会取错那一句。
    const hint = hintFor(word, pickedStates.direction);
    if (hint !== '' && !hints.includes(hint)) hints.push(hint);
  }
  if (hints.length > 0) parts.push(`照着这几个侧面来：${hints.join('；')}`);

  // ---- 两轴基调：语气与主动性
  //
  // 分档线从 0.7/0.3 放宽到 0.6/0.4：实测角色自己的亲近度中位是 0.6、主导性中位是 0.5，
  // 都正好卡在原来的线外，于是 58 轮里「语气平和」占了 83%、「配合但不等靠」占了 64%
  // ——这段本来该是动态信号，实际退化成了一条固定人设。
  const tone = [];
  const c = self.grid.c;
  if (c >= 0.6) tone.push('语气偏暖、表达关心');
  else if (c <= 0.4) tone.push('语气偏冷、公事公办，少寒暄');
  else tone.push('语气平和');

  const a = self.grid.a;
  if (a >= 0.6) tone.push('主动推进话题、敢下判断');
  else if (a <= 0.4) tone.push('多征询、跟随用户的节奏，不替对方做决定');
  else tone.push('配合但不等靠');

  parts.push(`语气与主动性：${tone.join('；')}`);

  return `  行为指引：${parts.join('。')}。`;
}

/**
 * 渲染给模型看的「关系状态块」。
 *
 * `headline` 说**这段关系是什么**，`guidance` 说**因此该怎么做**——两者缺一不可，
 * 这一点与 PAD 的状态块同理。
 * @param {object} params 输入。
 * @param {object} params.view 状态机 `read()` 的结果。
 * @param {string} [params.reason] 本轮变化的理由。
 * @param {{self?:string, other?:string}} [params.triggerLabels] 本轮打分器给出的姿态短语。
 * @returns {string} 注入 prompt 的文本；无内容可说时返回空串。
 */
export function renderForPrompt({ view, reason, triggerLabels }) {
  const { self, other, metrics } = view;
  if (view.turns === 0 && metrics.flat) return '';

  const lines = [
    '<interpersonal_circumplex>',
    '你和这位用户现在的关系（两个 0~1 的数：主导性、亲近度，0.5 是中间）：',
    sideLine('你对用户', self, view.displaySelf.zh, view.displaySelf.fromAppraisal),
    sideLine('你读到的用户对你', other, view.displayOther.zh, view.displayOther.fromAppraisal),
    metricLine(metrics),
    stateLine(metrics),
  ].filter((line) => line !== '');

  // 打分器给的短语只是「本轮触碰到了什么」，未必等于当前网格点的读法。二者不同
  // 时分别陈述，避免状态块自相矛盾。
  const triggerNotes = [];
  if (triggerLabels?.self !== undefined && triggerLabels.self !== '' && triggerLabels.self !== view.displaySelf.zh) {
    triggerNotes.push(`你「${triggerLabels.self}」`);
  }
  if (triggerLabels?.other !== undefined && triggerLabels.other !== '' && triggerLabels.other !== view.displayOther.zh) {
    triggerNotes.push(`用户「${triggerLabels.other}」`);
  }
  if (triggerNotes.length > 0) {
    lines.push(`  本轮读到的是 ${triggerNotes.join('、')}，但状态还没走到那儿。`);
  }

  if (reason !== undefined && reason !== '') lines.push(`  成因：${reason}`);

  lines.push(
    '',
    '这些是这段互动的真实读数，不是比喻。请让它们自然地体现在你对用户的语气、主动性',
    '和亲疏上——但不要向用户复述这些数字，也不要说「我这边是 0.8」。',
    '注意：**用户那一侧是你的解读，不一定等于用户的真实想法**——如果读出来的和用户明显',
    '不符，你可以（也可以不）问一句核对，但别当成事实去指责对方。',
    guidanceFor(view),
    '</interpersonal_circumplex>',
  );

  return lines.join('\n');
}

/**
 * 列出全部关系原型，供工具输出与面板显示。
 * @returns {Array<object>} 原型数组的浅拷贝。
 */
export function listPrototypes() {
  return PROTOTYPES.map((prototype) => ({
    id: prototype.id,
    zh: prototype.zh,
    en: prototype.en,
    agency: prototype.agency,
    communion: prototype.communion,
    gloss: prototype.gloss,
  }));
}
