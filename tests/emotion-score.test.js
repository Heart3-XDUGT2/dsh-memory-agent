/**
 * C1 情绪单轮闭环的电池。
 *
 * 要钉住的不是"她会不会生气",而是三件容易写坏的事:
 *   ① 超时 ⇒ **照常回复**(用旧向量),而且**算超时不算失败**(超时率是体检指标,
 *      混进 failed 里就再也看不出这条通道健不健康);
 *   ② 解析不出来 ⇒ **不换**(半个读数/NaN 不许塞进她脑子);
 *   ③ 它**只改渲染**:向量本体不许从这儿进库(写库那条路归轮末反思 —— 两个写者
 *      同时 apply 会互相覆盖)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseScore, sameTurnState, scorePrompt, clampScoreTimeoutMs, scoreOnce, createSameTurnScorer,
  EMOTION_SCORE_DEFAULT_MS, EMOTION_SCORE_MIN_MS, EMOTION_SCORE_MAX_MS, EMOTION_SCORE_MAX_REASON,
  EMOTION_SCORE_SCHEMA, EMOTION_SCORE_RAW_MAX, rawForAudit
} from '../lib/emotion-score.js'
import { EXTRACT_SYSTEM_PROMPT } from '../lib/reflect.js'

const good = () => ({
  global: { fatigue: 2, valence: -6, arousal: 7 },
  target_master: { affection: 5, playfulness: 3, sadness: 4, dependency: 6 },
  intensity: 8,
  reason: '他那句"随你便"'
})

test('C1:正常读数 ⇒ 换成新向量,情绪强度与触发点都写得出', () => {
  const s = parseScore(good())
  assert.notEqual(s, null)
  assert.equal(s.vector.global.valence, -6)
  assert.equal(s.intensity, 8)
  assert.equal(s.reason, '他那句"随你便"')
})

test('C1:三维缺一维 ⇒ 不换(半个读数不是读数)', () => {
  assert.equal(parseScore({ global: { fatigue: 1, valence: 2 } }), null)
  assert.equal(parseScore({ global: { fatigue: 1, valence: 2, arousal: NaN } }), null)
})

/**
 * ★ 2026-10-17：`reason` 的样板值黑名单 —— 不依赖模型自觉。
 *
 * 现场：本地 3B 把 `scorePrompt` 样板 JSON 里 `reason` 的字面值**抄了回来**。
 * 活库最近 8 条里 4 条是它（含变体）：
 *   「他说今天开会到十点」4 次 /「他说了今天开会到十点」1 次 /
 *   「他说了这句」1 次 /「他那句 XX」1 次；**真正抄对的只有 1 条**。
 *
 * 为什么在代码里挡：prompt 写「不许照抄示例」模型未必听 ——
 * prompt 是劝，代码是墙（与 `is_self_referential` 同一套思路）。
 *
 * ⚠️ 判据是「整条像样板」，不是"包含样板词"：
 * 「他说今天开会到十点，累坏了」这种**真写了事**的必须留下。
 */
test('★ 2026-10-17:reason 命中样板 ⇒ 清空;真写了内容的照留', () => {
  const withReason = (r) => ({ ...good(), reason: r })
  // ① 样板及变体 ⇒ 清空（空串是诚实的：「这轮没说清触发点」）
  for (const p of ['他说今天开会到十点', '他说了今天开会到十点', '他说了这句',
                   '他那句 XX', '示例']) {
    assert.equal(parseScore(withReason(p)).reason, '', '样板该被清空: ' + p)
  }
  // ② 真写了事的 ⇒ 保留（这是最容易误伤的一类）
  for (const real of ['他面试通过了', '他说今天开会到十点，累坏了',
                      '晚上好，我面试通过了', '他说他累了']) {
    assert.equal(parseScore(withReason(real)).reason, real, '真内容不该被动: ' + real)
  }
  // ③ 空/缺省不受影响
  assert.equal(parseScore(withReason('')).reason, '')
  assert.equal(parseScore(withReason(undefined)).reason, '')
})

test('C1:认不出来 ⇒ 不换(垃圾/空/数组/字符串都不许变成情绪)', () => {
  assert.equal(parseScore(null), null)
  assert.equal(parseScore('胡说'), null)
  assert.equal(parseScore([1, 2, 3]), null)
  assert.equal(parseScore({}), null)
  assert.equal(parseScore({ global: 'x' }), null)
})

test('C1:越界数字被钳位(她不会因为模型手滑变成 -80 的心情)', () => {
  const s = parseScore({ global: { fatigue: -99, valence: 99, arousal: 50 }, intensity: 99 })
  assert.equal(s.vector.global.fatigue, 0)
  assert.equal(s.vector.global.valence, 10, '心情列的上界由钳位器说了算')
  assert.equal(s.intensity, 10)
})

test('C1:触发点截到 40 字;强度缺省给 5(不硬凑一个"她超激动")', () => {
  const s = parseScore({ global: { fatigue: 1, valence: 1, arousal: 1 }, reason: 'x'.repeat(300) })
  assert.equal(s.reason.length, EMOTION_SCORE_MAX_REASON)
  assert.equal(s.intensity, 5)
})

test('C1:state 替身 —— 这一轮是新读数,上一轮的值挪到 prev(于是她会读到"上一轮 X,这一句之后 Y")', () => {
  const state = { moodIntensity: 4, prevMoodIntensity: 3, moodReason: '旧事', emotionVector: { global: { valence: 1 } } }
  const s = parseScore(good())
  const patched = sameTurnState(state, { vector: s.vector, intensity: s.intensity, reason: s.reason })
  assert.notEqual(patched, state, '不许原地改他的状态对象')
  assert.equal(patched.moodIntensity, 8)
  assert.equal(patched.prevMoodIntensity, 4)
  assert.equal(patched.moodReason, '他那句"随你便"')
  // 没有读数 ⇒ 原样交回(这一轮延续旧情绪)
  assert.equal(sameTurnState(state, null), state)
})

test('C1:提示词里带着零点与"没被碰到的维别动";不带她的人设长篇', () => {
  const p = scorePrompt({ userText: '你今天怎么这么晚才回我', prev: { global: { fatigue: 3, valence: 2, arousal: 3 } } })
  assert.match(p, /没被这句话碰到的那几维,原样返回/)
  assert.match(p, /你今天怎么这么晚才回我/)
  assert.match(p, /intensity/)
  assert.ok(p.length < 1200, '这是个小调用,提示词不许写成小作文')
  assert.equal(EMOTION_SCORE_SCHEMA.additionalProperties, false, '结构化 schema 必须锁死多余字段')
})

/**
 * 2026-10-17：补 JSON 输出要求（本地 3B 模型暴露的 bug）。
 *
 * 现场：切到本地 `qwen2.5:3b` 后，`same_turn_emotion` 连续 3 条
 * `ok:false / raw:null / 286~441ms`，`llm-channel` 记 `BAD_JSON 产出不是合法 JSON(3 字)`。
 *
 * 根因不在模型也不在通道：`llm-channel.runStructured` **从不把 schema 发给模型**
 * （宿主 `GenerateOptions` 没有 `outputSchema`，schema 只用来决定"要不要走 JSON 阶梯"），
 * 而这份提示词以前**只说「只给数字」，从没说过输出 JSON** ——
 * 云端大模型自己猜到要给 JSON，本地小模型老实按字面写了自然语言。
 *
 * 对照：`lib/query-expand.js` 一直有 `'只输出 JSON:{"terms": ["…", "…"]}'` 那行，
 * 所以它不犯这个病。⇒ 这一组断言钉住「那行必须有」，并且**键名与 schema 对齐**。
 */
test('★ 2026-10-17:打分提示词必须**明说要输出 JSON**（本地小模型不会自己猜）', () => {
  const p = scorePrompt({ userText: '今天开会开到十点', prev: null })
  assert.match(p, /只输出 JSON/, '没有这行 ⇒ 小模型会按字面写自然语言,JSON 阶梯必失败')
  // 键名/层级必须与 EMOTION_SCORE_SCHEMA 逐字对齐（改了 schema 就要改提示词）
  for (const key of ['"global"', '"target_master"', '"fatigue"', '"valence"', '"arousal"',
    '"affection"', '"playfulness"', '"sadness"', '"dependency"', '"intensity"', '"reason"']) {
    assert.ok(p.includes(key), '提示词里缺 schema 键 ' + key)
  }
  // 给的样板本身必须是**合法 JSON**（否则模型照着抄也抄不出合法东西）
  const m = p.match(/只输出 JSON:(\{[\s\S]*\})\s*$/)
  assert.ok(m, '「只输出 JSON:」后面要跟一个样板对象')
  const sample = JSON.parse(m[1])
  assert.deepEqual(Object.keys(sample).sort(), ['global', 'intensity', 'reason', 'target_master'])
  assert.deepEqual(Object.keys(sample.global).sort(), ['arousal', 'fatigue', 'valence'])
  assert.deepEqual(Object.keys(sample.target_master).sort(), ['affection', 'dependency', 'playfulness', 'sadness'])
  // 与 schema 的 properties 对齐（**别用 required** —— 它只有 3 个，
  // `reason` 不在 required 里；样板该给的是"完整的形状"，不是"最少要填的"）
  const props = Object.keys(EMOTION_SCORE_SCHEMA.properties)
  assert.deepEqual(Object.keys(sample).sort(), [...props].sort(),
    '样板顶层键要与 schema.properties 完全一致')
  for (const k of props) {
    assert.ok(k in sample, 'schema 里的 ' + k + ' 没出现在样板里')
  }
})

/**
 * 2026-10-17 第三修（最终结论）：`reason` 的样板**给什么都可能被抄**。
 *
 * 演变史（每一步都是被现场数据逼出来的）：
 *   ① `"他那句 XX"`（占位符）        ⇒ 被抄（活库出现 `"他那句 XX"`）
 *   ② `"他说今天开会到十点"`（真例子）+「不许照抄示例」
 *                                    ⇒ **还是被抄**（8 条里 4 条是它/它的变体：
 *                                       「他说了今天开会到十点」「他说了这句」）
 *   ③ 现在：`〈一句话说清触发点〉`（字段说明体裁）+ **代码黑名单兜底**
 *
 * ⇒ 结论：**样板不值钱，"墙"才值钱**。真正的防线是 `sanitizeReason()`
 *   （下面那条测试钉着）；这里只钉"样板不再长成一个现成答案"。
 */
test('★ 2026-10-17:样板里不许留占位符,reason 用〈〉字段说明体裁', () => {
  const p = scorePrompt({ userText: '今天开会开到十点', prev: null })
  // ① 历代被抄回去的形状都不许回来
  assert.doesNotMatch(p, /XX/, '不许留 XX —— 小模型会照抄')
  assert.doesNotMatch(p, /他那句/, '上一代「他那句 XX」不许回来')
  assert.doesNotMatch(p, /他说今天开会到十点/, '第二代"真例子"正是被抄的那句，不许回来')
  // ② 样板里的 reason 用〈〉包起来的说明（不像现成答案）
  const m = p.match(/只输出 JSON:(\{[\s\S]*\})\s*$/)
  assert.ok(m, '样板对象要在')
  const sample = JSON.parse(m[1])
  assert.equal(typeof sample.reason, 'string')
  assert.match(sample.reason, /^〈.+〉$/, 'reason 样板该是〈…〉字段说明，不是一个可照抄的值')
  // ③ 说明里要讲清"〈…〉不是答案"（文档与样板一致，别互相打架）
  assert.match(p, /〈…〉\s*括起来的[^）]*格式说明/, '要有一句把〈〉的语义讲明')
})

/**
 * 2026-10-10「只升不降」修复的回归门。
 *
 * 为什么值得单钉一组:两处提示词原本**只有向上的规则**——
 *   · `emotion-score.js` 的两条示例里,"爱意/依赖"只出现在升的那条;
 *   · `reflect.js` 的反思纪律只防"虚报热情",不防"虚报冷淡"。
 * 两者都是**同一种不对称**,而且改回去只需要删几个字、不会有任何测试变红。
 * 所以这里断言的是"两个方向都写着",不是措辞本身。
 */
test('2026-10-10:打分器提示词的**两个方向**都在(不再只写"升")', () => {
  const p = scorePrompt({ userText: '哦', prev: { global: { fatigue: 3, valence: 2, arousal: 3 } } })
  // 向上那条:夸/逗 ⇒ 爱意升、委屈降
  assert.match(p, /他夸你、逗你、主动靠近 ⇒ 爱意\/玩心\/心情升,委屈降/)
  // 向下那条:冷落/凶 ⇒ 委屈升、**爱意与依赖降**
  assert.match(p, /他冷落你、凶你、很久不理 ⇒ 委屈升,爱意\/依赖\/心情降/)
  // 反例:旧的单向写法不许再出现("委屈/依赖升"把依赖也写成只升)
  assert.doesNotMatch(p, /委屈\/依赖升/)
})

test('2026-10-10:轮末反思的"反思纪律"两个方向都在(不只防虚报热情)', () => {
  assert.match(EXTRACT_SYSTEM_PROMPT, /不要为了表现热情而虚报强度/)
  assert.match(EXTRACT_SYSTEM_PROMPT, /也不要为了显得矜持而虚报冷淡/)
})

test('C1:超时旋钮坏值回落默认(0/负数/乱填都不许把通道关死)', () => {
  assert.equal(clampScoreTimeoutMs(0), EMOTION_SCORE_DEFAULT_MS)
  assert.equal(clampScoreTimeoutMs(-5), EMOTION_SCORE_DEFAULT_MS)
  assert.equal(clampScoreTimeoutMs('胡说'), EMOTION_SCORE_DEFAULT_MS)
  assert.equal(clampScoreTimeoutMs(999999), EMOTION_SCORE_MAX_MS)
  assert.equal(clampScoreTimeoutMs(EMOTION_SCORE_MIN_MS), EMOTION_SCORE_MIN_MS, '下界本身是合法的')
  assert.equal(clampScoreTimeoutMs(1500), 1500)
})

test('C1:赛跑 —— 模型慢过门 ⇒ **超时**(照常回复),不算失败', async () => {
  const never = () => new Promise(() => {})
  const r = await scoreOnce({ run: never, userText: '在吗', timeoutMs: 20 })
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, true, '超时与失败必须分得开')
  assert.equal(r.score, null)
})

test('C1:赛跑 —— 模型抢在门内 ⇒ 拿到读数', async () => {
  const r = await scoreOnce({ run: async () => good(), userText: '在吗', timeoutMs: 500 })
  assert.equal(r.ok, true)
  assert.equal(r.timedOut, false)
  assert.equal(r.score.intensity, 8)
})

test('C1:赛跑 —— 调用抛错 ⇒ 记失败(不是超时),这一轮延续旧情绪', async () => {
  const boom = async () => { throw new Error('provider 挂了') }
  const r = await scoreOnce({ run: boom, userText: '在吗', timeoutMs: 500 })
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, false)
})

test('C1:门面 —— 计数分开记,而且 take 取走即清(下一步不许复用陈旧读数)', async () => {
  const sc = createSameTurnScorer({ run: async () => good(), getTimeoutMs: () => 500, now: () => 1000 })
  assert.equal(sc.begin('s1', { userText: '在吗' }), true)
  const got = await sc.take('s1')
  assert.equal(got.score.intensity, 8)
  assert.equal(await sc.take('s1'), null, '取过一次就没了')
  const st = sc.stats()
  assert.equal(st.started, 1)
  assert.equal(st.applied, 1)
  assert.equal(st.timedOut, 0)
  assert.equal(st.failed, 0)
})

test('C1:门面 —— 没有 run(子代理服务缺席)⇒ 不启动、记 skippedNoRun,绝不影响回复', () => {
  const sc = createSameTurnScorer({ run: null })
  assert.equal(sc.begin('s1', { userText: '在吗' }), false)
  assert.equal(sc.stats().skippedNoRun, 1)
  assert.equal(sc.stats().started, 0)
})

/**
 * ★ 2026-10-17：空 query 不白跑 + 不静默。
 *
 * 现场：`turnSnapshot.queryOf(sid)` 同时喂 `same_turn_emotion` 和 `query_expand`。
 * `query_expand` 有判空闸（`normalizeQueryKey(text) === ''` ⇒ 早退），**这里没有**
 * ⇒ 收到空串照样拼 prompt、**白烧一次 LLM 调用**。
 * 表现就是"情绪打分跑了、查询扩展没跑"—— 看着像矛盾，其实是判空策略不同。
 *
 * 这一组同时钉两件事：
 *   ① 空 query ⇒ **不调 run**（省一次 LLM）；
 *   ② 但**要留痕**（`emptyQuery` 加 1、`onSettle` 带 `reason:'empty_query'`）
 *      —— 否则又是"跑了但状态面上没数"的老病。
 */
test('★ 2026-10-17:空 query 不白跑(不调 run),但 must 留痕(emptyQuery + onSettle)', () => {
  const settles = []
  let called = 0
  const sc = createSameTurnScorer({
    run: async () => { called += 1; return { ok: true } },
    getTimeoutMs: () => 500
  })
  // 各种"空"：空串、纯空白、只有空白段落
  for (const empty of ['', '   ', '\n\t\n', ' ']) {
    const ret = sc.begin('s1', { userText: empty, onSettle: (r) => settles.push(r) })
    assert.equal(ret, false, '空 query 该早退: ' + JSON.stringify(empty))
  }
  assert.equal(called, 0, '★ 一次 LLM 都不该调 —— 这就是"不白跑"')
  assert.equal(sc.stats().emptyQuery, 4)
  assert.equal(sc.stats().started, 0, '没真跑，started 不该涨')
  assert.equal(settles.length, 4, '每次都要 settle（不静默）')
  for (const s of settles) {
    assert.equal(s.reason, 'empty_query')
    assert.equal(s.ok, false)
    assert.equal(s.ms, 0)
  }
  // 反面：非空 query 照常跑
  assert.equal(sc.begin('s1', { userText: '在吗' }), true)
  assert.equal(sc.stats().started, 1)
  assert.equal(sc.stats().emptyQuery, 4, '非空不该碰 emptyQuery')
})

test('C1:门面 —— 超时进 timedOut 那一栏,不进 failed', async () => {
  const sc = createSameTurnScorer({ run: () => new Promise(() => {}), getTimeoutMs: () => 100 })
  sc.begin('s1', { userText: '在吗' })
  assert.equal(await sc.take('s1'), null)
  const st = sc.stats()
  assert.equal(st.timedOut, 1)
  assert.equal(st.failed, 0, '超时混进 failed ⇒ 这条通道的体检指标就废了')
})

// ---- v0.41.0 事故修复:子代理会话不许评分(否则无限递归)----
// 现场:打分器每跑一次就起一个子代理(`subagents.start`),而子代理会话的
// `agent/inbox/claimed` 一样打到这里 ⇒ A 起 B、B 起 C……**每一趟都是真 LLM
// 调用**,宿主卡死。判据归 lib/agent-scope.js,守门在 begin() 里 —— 所以
// 这条用例既钉行为(run 一次都不许被调到),也钉账(skippedSubagent 要能看见)。
const rootAgent = { session: { id: 'companion', header: { delegationDepth: 0 } } }
const subAgent = { session: { id: 'sub-1', header: { parentSession: 'companion', origin: 'subagent', delegationDepth: 1 } } }

test('C1:子代理会话的 claim ⇒ 不评分、不起子代理、记 skippedSubagent', async () => {
  const calls = []
  const sc = createSameTurnScorer({ run: async () => { calls.push('run'); return good() } })
  assert.equal(sc.begin('sub-1', { userText: '你只做一件事:读下面这句话…', parent: subAgent }), false)
  const st = sc.stats()
  assert.equal(st.skippedSubagent, 1, '跳过要记账(静默跳过是 P2 那次 45 小时静默的教训)')
  assert.equal(st.started, 0)
  assert.deepEqual(calls, [], '一次 run 都不许被调到 —— 那一趟就是递归的下一环')
  assert.equal(await sc.take('sub-1'), null, '没起过跑,取不到读数')
})

test('C1:顶层会话照常评分(闸不许误伤他那一边)', () => {
  const sc = createSameTurnScorer({ run: async () => good() })
  assert.equal(sc.begin('companion', { userText: '在吗', parent: rootAgent }), true)
  assert.equal(sc.stats().skippedSubagent, 0)
  assert.equal(sc.stats().started, 1)
})

test('C1:拿不到会话头(老会话/测试替身)⇒ 按顶层放行', () => {
  const sc = createSameTurnScorer({ run: async () => good() })
  assert.equal(sc.begin('s1', { userText: '在吗' }), true, '没有 parent / 没有 header 不许被判成子代理')
  assert.equal(sc.begin('s2', { userText: '在吗', parent: { session: { id: 's2' } } }), true)
  assert.equal(sc.stats().skippedSubagent, 0)
})

// ---- 2026-10-10:审计补「模型原始返回」----
// 现场:活库出现 `ms=2433, timedOut=false, ok=false` —— 调用跑完了但 parseScore 返回 null,
// 而当时 stage_detail 只有 ms/timedOut/ok,**看不到模型返回了什么** ⇒ 无法诊断。

test('审计 raw:rawForAudit 三种形状(null / 对象 / 字符串)', () => {
  assert.equal(rawForAudit(null), null, 'null 说明"根本没拿到"(超时/通道失败)')
  assert.equal(rawForAudit(undefined), null)
  assert.equal(rawForAudit('   '), null, '空白串等于没内容')
  assert.equal(rawForAudit('{"a":1}'), '{"a":1}', '字符串原样')
  assert.equal(rawForAudit({ global: { fatigue: 1 } }), '{"global":{"fatigue":1}}', '对象要 JSON 化')
  // 不可序列化(循环引用)不许抛 —— 审计写不进去绝不能影响这一轮
  const cyc = {}; cyc.self = cyc
  assert.equal(rawForAudit(cyc), '[不可序列化]')
})

test('审计 raw:合规返回不许被截断(阈值必须盖得住真实形状)', () => {
  // 一份最长的合规返回:8 个数字 + 40 字 reason
  const full = {
    global: { fatigue: 2.5, valence: -6.5, arousal: 7.5 },
    target_master: { affection: 5.5, playfulness: 3.5, sadness: 4.5, dependency: 6.5 },
    intensity: 4,
    reason: '他那句话'.repeat(10)
  }
  const s = JSON.stringify(full)
  assert.ok(s.length < EMOTION_SCORE_RAW_MAX,
    '合规返回(' + s.length + ' 字)必须小于阈值(' + EMOTION_SCORE_RAW_MAX + ')—— 否则截断会把关键字段切掉')
  assert.equal(rawForAudit(full), s, '合规返回要一字不差地存下来')
})

test('审计 raw:超长输出按阈值截断(不全丢,但也不入库无限长)', () => {
  const huge = 'x'.repeat(EMOTION_SCORE_RAW_MAX + 500)
  const got = rawForAudit(huge)
  assert.equal(got.length, EMOTION_SCORE_RAW_MAX)
  assert.equal(got, huge.slice(0, EMOTION_SCORE_RAW_MAX))
})

test('审计 raw:scoreOnce 三种结局都带 raw(超时 null / 解析失败带原文 / 成功带原文)', async () => {
  // ① 成功
  const ok = await scoreOnce({ run: async () => good(), userText: '在吗', timeoutMs: 500 })
  assert.equal(ok.ok, true)
  assert.ok(typeof ok.raw === 'string' && ok.raw.includes('"global"'), '成功也要存原文,便于对照')

  // ② 跑完了但解析不出来 —— 这正是活库那一条的形状
  const bad = await scoreOnce({
    run: async () => ({ global: { fatigue: 1 }, intensity: 3 }), // 缺 valence/arousal
    userText: '在吗', timeoutMs: 500
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.timedOut, false, '不是超时 —— 是解析失败')
  assert.ok(typeof bad.raw === 'string' && bad.raw.includes('fatigue'),
    '解析失败时**必须**留下模型原文,否则没法诊断')

  // ③ 超时 ⇒ 根本没到,raw 恒 null(不是"没读到",是"没发生")
  const to = await scoreOnce({ run: () => new Promise(() => { }), userText: '在吗', timeoutMs: 60 })
  assert.equal(to.timedOut, true)
  assert.equal(to.raw, null, '超时没有返回值可存')
})

test('审计 raw:通道返回 null(runStructured 的失败契约)时 raw 也是 null', async () => {
  const r = await scoreOnce({ run: async () => null, userText: '在吗', timeoutMs: 500 })
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, false)
  assert.equal(r.raw, null, '通道回 null = 没产出,不是"产出了一串 null"')
})

test('审计 raw:run 抛异常时 raw 留痕(不许静默)', async () => {
  const r = await scoreOnce({ run: async () => { throw new Error('boom') }, userText: '在吗', timeoutMs: 500 })
  assert.equal(r.ok, false)
  assert.ok(typeof r.raw === 'string' && r.raw.includes('boom'), '抛出也要留下能看的原因')
})
