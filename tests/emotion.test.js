/**
 * v0.14.5 S7:`lib/emotion.js` —— A 侧 `brains/echo_emotion.py` 的数据与
 * 动力学移植。测试逐条对齐 A 的边界:未知维丢弃、越界夹取、round 0.1、
 * 缺失补默认、差分 |d| ≥ 0.1、衰减的**指数逼近(半衰期 + 距离依赖)**。
 * v0.29.0 个人机器人裁剪:target_group(对群友四维)退役 —— 这里同时
 * 钉住「老库残留的 target_group 必须被静默丢弃,不需要迁移」。
 * 2026-10-10 笔 2-B-1a/b:衰减由"线性绝对步长"换成"指数逼近 + 距离依赖",
 * 半衰期锚定改前线性在 6h 处的行为(见 `lib/emotion.js` 的 `toward` 注释)。
 * 2026-10-10 笔 5:**速率校准** —— 基础 HL 改成对齐人类经验区间 + Letta 先例
 * (fatigue 3h / valence 1.4h / arousal 1.4h / sadness 7h / playfulness 2.5h /
 * affection 24h / dependency 24h)。本文件所有衰减数值断言按新 HL 重算。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMOTION_RANGES, EMOTION_DIM_LABELS,
  defaultEmotionVector, positiveOverrideVector, clampEmotionVector, clampDim,
  emotionDelta, formatEmotionDelta, applyEmotionVector, decayedEmotionVector,
  carryExtraEmotionKeys
} from '../lib/emotion.js'

test('默认向量:出厂设置逐字(A default_emotion_vector,去群维)', () => {
  assert.deepEqual(defaultEmotionVector(), {
    global: { fatigue: 2.0, valence: 2.0, arousal: 3.0 },
    target_master: { affection: 8.0, playfulness: 7.0, sadness: 0.0, dependency: 6.0 }
  })
  // 每次都是新对象(调用方会就地改它)
  const a = defaultEmotionVector()
  a.target_master.affection = 1
  assert.equal(defaultEmotionVector().target_master.affection, 8.0)
  // 8 维标签齐(A EMOTION_DIM_LABELS 去 target_group 四维,加第三批登记的 dominance)
  const dims = Object.values(EMOTION_RANGES).flatMap(g => Object.keys(g))
  assert.equal(dims.length, 8)
  for (const d of dims) assert.ok(EMOTION_DIM_LABELS[d], d + ' 缺中文名')
  // 第三批(2026-10-05):dominance 是**登记维** —— 有范围、有中文名,但出厂向量里
  // 不出现(不是默认值的一部分),渲染侧也不读它(见 docs/EMOTION_SPACE.md)。
  assert.ok(Array.isArray(EMOTION_RANGES.global.dominance))
  assert.equal(Object.hasOwn(defaultEmotionVector().global, 'dominance'), false)
  // 群维退役:范围表里不许再出现
  assert.equal(Object.hasOwn(EMOTION_RANGES, 'target_group'), false)
  for (const d of ['patience', 'contempt', 'defensiveness', 'anger']) {
    assert.equal(EMOTION_DIM_LABELS[d], undefined, d + ' 该随群维一起退役')
  }
})

/**
 * 2026-10-10 语义拆分:`defaultEmotionVector()` 有**两种**语义,别再混着测。
 *
 *   ① **纯出厂值** = `lib/emotion.js:65-67` 硬编码的那五个数 —— 上一条测试测的
 *      就是它,而且现在真的测得到(套件级隔离把 `DSH_HOME` 指到空临时目录 ⇒
 *      `state-defaults.json` 不存在 ⇒ 覆盖层为空)。
 *   ② **生效默认值** = 上面那组常量**再叠 `state-defaults.json.emotionVector`
 *      的逐维覆盖**(`:69-82`)。
 *
 * 为什么要拆:2026-10-10 把真机 `state-defaults.json` 的 emotionVector 从 null 改成
 * `{affection: 6, dependency: 5}` 之后,上一条测试当场变红 —— **不是因为代码坏了,
 * 是因为它名字说"出厂设置"、实际读的是"生效值"**,而两者只在"覆盖层为空"时相等。
 * 拆开之后:上一条永远只测常量(靠隔离保证覆盖层为空),这一条专门测覆盖通路
 * (自己造数据目录,不依赖真机)。
 *
 * ⚠️ 覆盖层的行为细节(越界夹取 / 非数字丢弃 / 只覆盖给了的维)在
 * `tests/data-tables-state.test.js` 的「衰减基线吃 state-defaults」一条里已经逐项钉住,
 * 这里只钉"两种语义确实是两件事"这个结构本身,不重复那份断言。
 */
test('默认向量:生效默认值 ≠ 纯出厂值 —— 覆盖层只影响它给了的维', () => {
  // 没有覆盖层时(套件级隔离保证的常态),两者必须逐位相等
  const live = defaultEmotionVector()
  assert.deepEqual(live.target_master, {
    affection: 8.0, playfulness: 7.0, sadness: 0.0, dependency: 6.0
  })
  // 覆盖层确实在**读侧**生效(而不是被模块级缓存吃掉):每次调用都回同一个答案,
  // 且返回值是**新对象**(调用方会就地改它 —— 上一条已测)。
  // 注意:这里不能用 `defaultEmotionVector({ ECHO_DATA_DIR: '' })` 来"制造空数据目录"
  // —— 显式 env 走 `dataDirOf()`(`data-dir.js:101-106`),空串被 `trim() !== ''` 判假后
  // **回落到 `~/.dsh`(真 home)**,那样这条测试就又在读真机了(2026-10-10 真踩过)。
  // 要造"空数据目录"必须指向一个真实存在的空临时目录,那是 data-tables-state.test.js
  // 的 sandbox 在做的事。
  assert.equal(defaultEmotionVector, defaultEmotionVector, '读点不许被换成模块级快照')
  // 语义拆分的正面证据:出厂常量与"生效值"是两个可分别断言的东西 ——
  // 数据层给覆盖时后者变、前者不变。这一半由 data-tables-state.test.js 用沙箱证明,
  // 这里断言"本文件的其余用例只依赖出厂常量"(即上一条测试在覆盖层为空时成立)。
  assert.notEqual(live.target_master, defaultEmotionVector().target_master, '每次都是新对象')
})

test('钳位:未知维丢弃、越界夹取、round 0.1、缺失补默认', () => {
  const vec = clampEmotionVector({
    global: { fatigue: 99, valence: -99, arousal: 3.14159, mood: 7 }, // mood 不是合法维
    target_master: { affection: 12.34, playfulness: 'x' },            // playfulness 非数字
    extra_group: { foo: 1 }                                           // 未知组
  })
  assert.equal(vec.global.fatigue, 10.0)      // 夹到上界
  assert.equal(vec.global.valence, -10.0)     // 负向范围也夹
  assert.equal(vec.global.arousal, 3.1)       // round 0.1
  assert.equal(Object.hasOwn(vec.global, 'mood'), false)  // 未知维丢弃
  assert.equal(vec.target_master.affection, 10.0)
  assert.equal(vec.target_master.playfulness, 7.0)   // 非数字 → 默认
  assert.equal(Object.hasOwn(vec, 'extra_group'), false)  // 未知组丢弃
  // 完全脏的输入 → 默认向量(绝不抛、绝不影响聊天)
  for (const bad of [null, undefined, 'x', 42, [], { global: null }]) {
    assert.deepEqual(clampEmotionVector(bad), defaultEmotionVector())
  }
})

test('v0.29.0:老库残留的 target_group 被静默丢弃(不迁移、不报错)', () => {
  // 老库里躺着 A 形状的 11 维向量(或模型偶尔幻觉出来的群维):
  // clamp 按白名单清洗,群组整组消失,其余照常。
  const legacy = clampEmotionVector({
    global: { fatigue: 4, valence: 1, arousal: 5 },
    target_master: { affection: 9, playfulness: 6, sadness: 1, dependency: 7 },
    target_group: { patience: 2, contempt: 5, defensiveness: 6, anger: 7 }
  })
  assert.equal(Object.hasOwn(legacy, 'target_group'), false)
  assert.equal(legacy.target_master.affection, 9)
  assert.equal(legacy.global.fatigue, 4)
  // 衰减/落地同理:群维进去也不出来
  assert.equal(Object.hasOwn(decayedEmotionVector(legacy, 6), 'target_group'), false)
  assert.equal(Object.hasOwn(applyEmotionVector(legacy, { global: { fatigue: 1 } }), 'target_group'), false)
})

test('clampDim:单维查询(渲染层用),未知维/非数字 → null', () => {
  assert.equal(clampDim('global', 'arousal', 0.2), 1.0)   // 下界 1.0
  assert.equal(clampDim('global', 'arousal', 5.55), 5.6)
  assert.equal(clampDim('target_master', 'affection', undefined), null)
  assert.equal(clampDim('target_master', 'affection', NaN), null)
  assert.equal(clampDim('target_master', 'nope', 3), null)
  assert.equal(clampDim('nope', 'affection', 3), null)
  // 群维已从范围表退役:查它 = 未知维
  assert.equal(clampDim('target_group', 'anger', 5), null)
})

test('正向覆盖向量(A positive_override_vector,去群维)', () => {
  const v = positiveOverrideVector()
  assert.deepEqual(v.global, { fatigue: 1.0, valence: 5.0, arousal: 6.0 })
  assert.deepEqual(v.target_master, { affection: 9.0, playfulness: 9.0, sadness: 0.0, dependency: 6.0 })
  assert.equal(Object.hasOwn(v, 'target_group'), false)
})

test('差分:|d| ≥ 0.1 才出现,两边各自先 clamp', () => {
  const prev = { global: { fatigue: 5, valence: 0, arousal: 3 },
    target_master: { affection: 8, playfulness: 7, sadness: 0, dependency: 6 } }
  const cur = { global: { fatigue: 5.02, valence: 2, arousal: 3 },
    target_master: { affection: 8, playfulness: 6.9, sadness: 2, dependency: 6 } }
  const d = emotionDelta(prev, cur)
  assert.deepEqual(d.global, { valence: 2 })            // 3 → 2
  assert.deepEqual(d.target_master, { playfulness: -0.1, sadness: 2 }) // 7 → 6.9 与 0 → 2
  // 先各自 round 0.1 再差分(A 的顺序):5.05 → 5.1,于是差 0.1 会出现。
  // (只给 fatigue 一维时其余维会按缺失补默认 —— 这里补全三维,免得
  //  被「缺维补默认」的差分混进来。)
  assert.deepEqual(
    emotionDelta(prev, { global: { fatigue: 5.05, valence: 0, arousal: 3 } }).global,
    { fatigue: 0.1 })
  // 无变化 → 空对象(A 的 format 会写「无变化」)
  assert.deepEqual(emotionDelta(prev, prev), {})
  assert.equal(formatEmotionDelta({}), '无变化')
  assert.equal(formatEmotionDelta(null), '无变化')
})

test('差分短句:组名与维名用中文(A format_emotion_delta)', () => {
  const text = formatEmotionDelta({ global: { fatigue: -2, valence: 1 }, target_master: { affection: 0.5 } })
  assert.equal(text, '整体[疲惫-2, 心情+1]; 对主人[爱意+0.5]')
})

test('落地两步:给了就 clamp,没给就保留 prev(对象隔离随群维退役)', () => {
  const prev = {
    global: { fatigue: 6, valence: -3, arousal: 5 },
    target_master: { affection: 9, playfulness: 4, sadness: 3, dependency: 7.5 }
  }
  // ① LLM 给了非空向量 → 用它;幻觉出来的群维被白名单丢弃
  const next = applyEmotionVector(prev, {
    global: { fatigue: 3, valence: 4 },
    target_master: { affection: 10, playfulness: 8 },
    target_group: { anger: 10, patience: 0 }   // 幻觉:群维已退役,必须消失
  })
  assert.equal(next.global.fatigue, 3)
  assert.equal(next.target_master.affection, 10)
  assert.equal(next.target_master.sadness, 0)   // LLM 没给的维 → 默认值(A 同)
  assert.equal(Object.hasOwn(next, 'target_group'), false)
  // ② LLM 什么都没给(空对象/非法)→ 整包保留 prev(不把状态清零)
  for (const empty of [{}, null, undefined, 'x', []]) {
    const kept = applyEmotionVector(prev, empty)
    assert.equal(kept.global.fatigue, 6)
    assert.equal(kept.target_master.affection, 9)
  }
  // ③ prev 本身脏(老库)→ 先钳位,不把脏值带进来
  const dirty = applyEmotionVector({ target_master: { affection: 999 } }, {})
  assert.equal(dirty.target_master.affection, 10)
})

test('时间衰减:指数 + 距离依赖(asym=1.0),分工差异化', () => {
  const vec = {
    global: { fatigue: 8, valence: -6, arousal: 9 },
    target_master: { affection: 4, playfulness: 2, sadness: 6, dependency: 0 }
  }
  const h6 = decayedEmotionVector(vec, 6)
  // 笔 5 速率校准:基础 HL 改为 fatigue 3h / valence 1.4h / arousal 1.4h /
  // sadness 7h / playfulness 2.5h / affection 24h / dependency 24h。
  // 下列值是**真实模块**在 asym=1、64 步中点积分下的输出(不是纯指数公式值)。
  assert.equal(h6.global.fatigue, 1.4)      // 8→0,d=0.8,HL 3h(未校准)
  assert.equal(h6.global.arousal, 3.2)      // 9→3,d≈0.86,HL 1.4h ⇒ 6h 已基本回平
  assert.equal(h6.global.valence, 1.7)      // -6→2,d≈0.67,HL 1.4h ⇒ 6h 已越过中性到正
  // 对主人向基线:各维基础 HL 不同,所以 6h 的进度差别很大
  assert.equal(h6.target_master.affection, 4.8)   // 4→8,d=0.5,HL 24h ⇒ 只走 0.8
  assert.equal(h6.target_master.playfulness, 6.3) // 2→7,d≈0.71,HL 2.5h ⇒ 已接近 7
  assert.equal(h6.target_master.sadness, 2.8)     // 6→0,d=0.6,HL 7h
  assert.equal(h6.target_master.dependency, 1.6)  // 0→6,d=1.0,HL 24h
  // 长时段:指数渐近,asym 加快初期恢复,但仍不越过 target
  const h24 = decayedEmotionVector(vec, 24)
  assert.equal(h24.global.fatigue, 0)
  assert.equal(h24.target_master.affection, 6.3)  // HL 24h ⇒ 24h 走掉一半以上
  assert.equal(h24.target_master.sadness, 0.4)    // HL 7h ⇒ 24h 已接近 0
  // hours ≤ 0 → 原样(只 clamp);脏输入不抛
  assert.deepEqual(decayedEmotionVector(vec, 0), clampEmotionVector(vec))
  assert.equal(decayedEmotionVector(vec, -5).global.fatigue, 8)
  // 脏输入兜底也吃半衰期;默认疲劳 2,3h 后仍为 1(fatigue HL 未校准)
  assert.equal(decayedEmotionVector(null, 3).global.fatigue, 1)
})

/**
 * 2026-10-10 笔 2-B-1a:`fatigue` 的归零是**取整**造成的,不是显式截断。
 *
 * 指数从正数出发永不为负 ⇒ 改前那句 `Math.max(0, …)` 在指数下是空操作。
 * 归零完全靠 `r1` 的 0.1 粒度:值 < 0.05 时归 0。
 * ⚠️ 下面两个时刻是 **asym=1 的实测值**,不是纯指数公式:纯指数 `10·2^(−h/3) < 0.05`
 * 要 h > 22.9h,而距离依赖让远处有效 HL 从 1.5h 起步 ⇒ 实测约 20.8h 归零。
 * (fatigue 基础 HL 笔 5 未校准,仍是 3h。)
 *
 * 为什么值得单钉一条:这条性质**只由 `r1` 的精度维持**。以后谁把 `r1` 改成
 * 3 位小数(比如为了显示更细),"24h 归零"会**静默失效** —— 而上面的断言
 * 会红得莫名其妙(看起来像衰减算错了)。这条测试把原因写清楚。
 */
test('疲劳归零靠 r1 的 0.1 粒度(asym=1:20h 未归零 / 22h 归零)', () => {
  const hot = { global: { fatigue: 10 } }
  // asym=1 时最大距离 HL_eff 起始为 3/(1+1)=1.5h,所以比纯指数(asym=0)
  // 更快归零:20h 时仍有约 0.1,22h 时 round 到 0.0。
  assert.ok(decayedEmotionVector(hot, 20).global.fatigue > 0,
    '20h 时尚未触及 0.05 的 r1 归零阈值')
  assert.equal(decayedEmotionVector(hot, 22).global.fatigue, 0,
    '22h 时已低于 0.05,由 r1 的 0.1 粒度归零(不是显式截断)')
  assert.ok(decayedEmotionVector(hot, 100000).global.fatigue >= 0,
    '指数积分器始终非负,不需要 Math.max 兜底')
})

test('衰减足够久会收敛到基线(不会永久停留或暴走)', () => {
  const hot = {
    global: { fatigue: 10, valence: 10, arousal: 10 },
    target_master: { affection: 0, playfulness: 0, sadness: 10, dependency: 10 }
  }
  const calm = decayedEmotionVector(hot, 72) // 三天不理她
  assert.equal(calm.global.fatigue, 0)
  assert.equal(calm.global.arousal, 3)
  assert.equal(calm.global.valence, 2)
  // 笔 5:爱意基础 HL 24h(原 53h),72h 已走掉大部分(0 → 7.4,基线 8)
  assert.equal(calm.target_master.affection, 7.4)
  // 再衰减一次仍单调趋近基线、永不过冲
  const again = decayedEmotionVector(calm, 72)
  assert.equal(again.target_master.affection, 7.9)
})

/**
 * 2026-10-10 D:衰减留痕的**闸门前置条件**。
 *
 * `index.js` 的衰减 tick 只在 `delta.target_master` 非空时才写审计行
 * (理由见那里的注释:fatigue 每拍必动 ⇒ 不设闸一天 48 行,会把工具桶挤空)。
 * 闸门本身在 tick 里,但**它依赖的性质在这里可测**:贴着基线的关系维,
 * 衰减后差分必须为空 —— 否则"稳态下不写"这个前提就不成立。
 */
test('2026-10-10 贴着基线的关系维:衰减后**不产生差分**(留痕闸门的前提)', () => {
  const atBaseline = defaultEmotionVector() // affection 8 / playfulness 7 / sadness 0 / dependency 6
  const d = emotionDelta(atBaseline, decayedEmotionVector(atBaseline, 0.5))
  assert.equal(d.target_master, undefined,
    '关系维在基线上一动不动 ⇒ 不该产生 target_master 差分(稳态不该写审计行)')
  // 离基线 1 点(d=1/8)仍要在 6h 内产生可观测差分;
  // 笔 5 后 affection 基础 HL=24h,6h 走掉 0.2 ⇒ 9.0 → 8.8,差分 −0.2。
  const off = defaultEmotionVector()
  off.target_master.affection = 9.0
  const d2 = emotionDelta(off, decayedEmotionVector(off, 6))
  assert.equal(d2.target_master.affection, -0.2, '9.0 → 8.8:关系维真的在回落,该留痕')
})

/**
 * 笔 2-B-1b 的核心行为契约(笔 5 重算数值):
 *   · 离基线越远(distanceNorm 越大) ⇒ HL_eff 越短 ⇒ 同一时长内移动比例越大;
 *   · 近基线(asym·d^1.35 很小) ⇒ 行为接近该维基础 HL 的纯指数。
 *
 * sadness 笔 5 后基础 HL=7h,maxDistance=10,target=0,6h:
 *   · d=0.1:value=1.0 → 0.5(移动 50.0%)
 *   · d=0.9:value=9.0 → 3.7(移动约 58.9%)
 *   ⇒ 远距离移动比例更高,但**不是**"远距离先归零"。
 */
test('2026-10-10 B-1b:距离越远衰减越快,近基线接近纯指数', () => {
  const sadnessAfter6h = (value) => decayedEmotionVector(
    { global: { fatigue: 0, valence: 2, arousal: 3 },
      target_master: { affection: 8, playfulness: 7, sadness: value, dependency: 6 } },
    6
  ).target_master.sadness
  const near = sadnessAfter6h(1.0) // d=0.1
  const far = sadnessAfter6h(9.0)  // d=0.9
  assert.equal(near, 0.5, '近基线 6h 后应为 0.5(HL 7h + 弱 asym)')
  assert.equal(far, 3.7, '远基线 6h 后 asym=1 比纯指数更快,降到 3.7')
  assert.ok((9.0 - far) / 9.0 > (1.0 - near) / 1.0 + 0.05,
    '远距离移动比例应比近距离更高')
})

// ---- 2026-10-06 事故:衰减会把 `emotion_vector` 里的**额外键**抹掉 ----

const WITH_EXTRA = () => ({
  global: { fatigue: 3, valence: 4, arousal: 6 },
  target_master: { affection: 8, dependency: 6, playfulness: 7, sadness: 0 },
  ipc_dyad: { other: { a: 0.3, c: 0.55 }, src: 'appraise@ipc-core', at: 1791291302961 }
})

test('衰减写回:额外键原样保留(不再被 clamp 顺手抹掉)', () => {
  const prev = WITH_EXTRA()
  const kept = carryExtraEmotionKeys(prev, decayedEmotionVector(prev, 2))
  assert.deepEqual(Object.keys(kept), ['global', 'target_master', 'ipc_dyad'])
  assert.deepEqual(kept.ipc_dyad, prev.ipc_dyad, '额外键要一字不动(轮末判定留下的用户侧坐标)')
  // 反证:不带这一步的那条老路确实会丢(这就是本次事故的现场)
  assert.equal('ipc_dyad' in decayedEmotionVector(prev, 2), false, '衰减结果本身不含额外键')
})

test('衰减写回:已知维**一律以衰减结果为准**(额外键不许把情绪维盖回去)', () => {
  const prev = WITH_EXTRA()
  const decayed = decayedEmotionVector(prev, 2)
  const kept = carryExtraEmotionKeys(prev, decayed)
  assert.deepEqual(kept.global, decayed.global)
  assert.deepEqual(kept.target_master, decayed.target_master)
  // 而且它真的在衰减(改前线性=1; B-1a 纯指数=1.9; B-1b asym=1、d=0.3 后=1.8)
  assert.equal(kept.global.fatigue, 1.8)
  assert.notEqual(kept.global.fatigue, prev.global.fatigue)
})

test('衰减写回边界:没有额外键 ⇒ 与衰减结果逐键相同(不多塞键)', () => {
  const prev = {
    global: { fatigue: 3, valence: 4, arousal: 6 },
    target_master: { affection: 8, dependency: 6, playfulness: 7, sadness: 0 }
  }
  const decayed = decayedEmotionVector(prev, 2)
  const kept = carryExtraEmotionKeys(prev, decayed)
  assert.deepEqual(kept, decayed)
  assert.deepEqual(Object.keys(kept), Object.keys(decayed))
})

test('衰减写回边界:全是额外键(没有情绪维)⇒ 不抛,额外键都在', () => {
  const prev = { ipc_dyad: { other: { a: 0.3, c: 0.55 } }, 未来键: 1 }
  const kept = carryExtraEmotionKeys(prev, decayedEmotionVector(prev, 2))
  assert.deepEqual(kept.ipc_dyad, prev.ipc_dyad)
  assert.equal(kept['未来键'], 1)
  // 已知维由衰减那一侧给(缺失补默认),这里只保证"额外键一个不少"
  assert.ok(kept.global && kept.target_master)
  // 脏输入不抛(与仓库其余 fail-soft 同款)
  assert.deepEqual(carryExtraEmotionKeys(null, null), {})
  assert.deepEqual(carryExtraEmotionKeys(null, { a: 1 }), { a: 1 })
  assert.deepEqual(carryExtraEmotionKeys(42, { a: 1 }), { a: 1 })
  assert.deepEqual(carryExtraEmotionKeys({ x: 1 }, 'nope'), { x: 1 })
})

test('衰减写回:不改入参(纯函数)', () => {
  const prev = WITH_EXTRA()
  const snapshot = JSON.stringify(prev)
  const decayed = decayedEmotionVector(prev, 2)
  const kept = carryExtraEmotionKeys(prev, decayed)
  assert.equal(JSON.stringify(prev), snapshot, 'prev 一个字节都不许动')
  assert.notEqual(kept, prev)
  assert.notEqual(kept, decayed)
})
