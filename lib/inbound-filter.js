/**
 * dsh-echo — 入站消息分类(纯函数,不碰宿主、不碰 DB)
 * ============================================================
 * 2026-09-26 现场(他问「我说这个记忆图谱为什么会出现那么多奇怪的记忆?
 * 我之前在 astrbot 上面可没有这个问题啊,那个记忆图是非常干净的」)。
 *
 * 实测根因之一:宿主每轮注入的 **runtime context**(「Current runtime
 * context. This snapshot supersedes earlier runtime-context snapshots.…」)
 * 被当成「用户说的话」捕获了。活库 `conversation_log` 最近 5 行里 4 行正文
 * 就是这段;它还会被写进对话窗口、喂给反思、最后长成"记忆"。
 *
 * 捕获层原来只挡了两类(`source.kind === 'tool'` 与插件自己的注入),
 * 挡不住宿主换一个 form 再来一次。所以这里改成**白名单**:只有**确实是
 * 他打出来的话**才捕获;剩下的一律不捕获(但仍然会进模型上下文 ——
 * 那是宿主的事,我们只是不把它当"他说的话")。
 *
 * 为什么是白名单而不是黑名单:黑名单每次宿主加一种注入就要补一条,漏一条
 * 就是一条脏记忆;白名单漏判的代价是「这一轮她没记」—— 可接受的损失。
 */

/** 已知的宿主/系统注入前缀(命中即**不是**他的话)。 */
const HOST_INJECTION_MARKERS = [
  'current runtime context',
  'this snapshot supersedes earlier',
  'current dsh file policy',
  'approval prompts are disabled',
  'the dsh file sandbox',
  // 宿主的上下文压缩产物(英文工程检查点体裁)—— 不是他说的
  '## pending jobs',
  '## current work',
  '## next step',
  '## critical context',
  '## files and code',
  '## errors and fixes',
  '<system-reminder>',
  'this is an automatically generated checkpoint',
  // v0.30.1(2026-09-27 中午现场补):宿主还有几种注入体裁漏网。
  // 当天 12:47:52 一条「[model changed: …]」换模型通告混进管线,
  // isHumanUtterance 放行 → 被当成他说话:积了一夜的想念值(7.69)
  // 被全额削减 −4.0、锚点重置 —— 他 20 分钟后看手机,什么都没有。
  // checkpoint 的 <compacted-summary> 包裹标签、技能目录通告同理:
  // 白名单漏判的代价是「这一轮她没记」,错放的代价是想念被机器抹掉。
  '[model changed',
  '<compacted-summary',
  'the available skill catalog changed',
  // 2026-09-27 F9(他自查审计发现的「串味」)。只读核对活库 100 条审计:
  // `user_input` 命中宿主体裁的 **4 条,全是 extract** ——
  //   09-27 00:50:34  Current runtime context…（含 file policy / approval prompts）
  //   09-27 01:02:12  <goal_complete>\nObjective: "把 Echo 的三个问题按他的裁决落地…"
  //   09-27 02:01:59  Current runtime context…（同上）
  //   09-27 12:47:52  [model changed: …glm-5.3 → deepseek-flash]
  // 时间线对下来:捕获闸 `27ebc1c` 落在 00:48,而 00:50/02:01 那两条 runtime context
  // **是装插件滞后**（进程还在跑旧副本）;12:47 那条正是 `b8e88ca` 补 `[model changed`
  // 的原因。**真正还漏着的只有 `<goal_*>`**（01:02 那条就是它)。
  //
  // 只加"一出现就不可能是他打的字"的体裁;宁少不多 —— 漏一条的代价是
  // 「这一轮她没记」,错判的代价是把他的话丢掉。
  '<goal_complete',
  '<goal_',
  '<system',
  '<task',
  '<subagent',
  // v0.30.2(2026-09-27 晚):后台作业/子代理的收尾通告也是宿主写的
  // (「background job pwsh-4 (pwsh: cd …」「Background subagent e421b700… finished
  // and will do no further work unless you send it more」)。改完前两条判据后
  // 活库复量,它们正是**最后残留在【别处刚说过的】里的 3 条机器行**。
  'background job ',
  'background subagent '
]

/**
 * 插件 / 子代理**自己的提示词** —— 不是他打的话。
 *
 * v0.30.2(2026-09-27 晚现场,他问「为什么人格没有改变,依然是冷冰冰的」)。
 *
 * 【别处刚说过的】、捕获层、检索取词**共用这一份判据**,而它原来只挡宿主那
 * 几种英文体裁。活库实测 `conversation_log` 100 行里 **90 行过筛**,其中 71 行
 * 渠道为空(系统写的),按出现次数:
 *   21× 她自己的 extractor 提示词(「你是一个严格的记忆与情绪反思模块…输出一个 JSON 对象」)
 *    9× 子代理任务提示(「只读分析任务,禁止修改任何文件…」)
 *    6× Almost Full Access 的命令安全审查员提示词
 *    6× 「你在为项目 dsh-echo 整理架构文档素材…」   5×「你是只读资料提取员…」
 *    2× 「你要**只读**分析一个第三方 DSH 插件包…」  2×「你是只读代码分析员…」
 *
 * 后果(实测,见会话存档 `session-echo-companion`):它们每轮按 `sharedRounds`
 * (默认 4)条被渲染成「**他:**…」喂回给她,**位置在人格后段之后** ——
 * 于是「<称呼>刚在别处说的话」读起来是「你是…审查员」「输出一个 JSON 对象」。
 * 模型跟着最近上下文的语域走:工程腔就是这么被喂出来的。
 *
 * 记忆层没被污染(活库 `episodic_memory` 命中 0 行)—— 因为提取只读**她自己
 * 会话**的轮次,别的会话的行进不来。漏的只有「别处刚说过的」这条路。
 */
const INTERNAL_PROMPT_MARKERS = [
  // 逐字取自活库,不是猜的形状
  '你是一个严格的记忆与情绪反思模块',
  '你是「almost full access」插件的命令安全审查员'
]

/**
 * 开头就是「任务指令」的行(命中即拒,不设长度门槛)。
 *
 * 为什么单列:@子代理那条「只读分析任务,禁止修改任何文件…」只有 45 字,
 * 用长度门槛会漏(第一版就漏了,测试当场抓住)。但它**开头**的体裁是
 * 他绝不会打出来的:「只读任务」「你在为项目…」「你要**只读**分析…」。
 *
 * v0.41.0 事故修复补一条:`你只做一件事` —— C1 情绪单轮打分器的提示词开头
 * (`emotion-score.js` 的 `scorePrompt`)。它当时是**唯一**漏过三道判据的
 * 内部提示词(开头不是指令式体裁,长度又够),于是子代理会话的 claim 被当成
 * 「他这一轮说的话」,配合「打分器每跑一次起一个子代理」把递归闭合成环。
 * 结构性那道闸在 `lib/agent-scope.js`(子代理会话一律不算他的话);这里是
 * 第二层 —— 就算哪天那道闸被人挪走,这段提示词也进不了捕获层。
 */
const INTERNAL_PROMPT_OPENINGS = /^(你只做一件事|只读任务|只读分析|只读代码分析|只读资料提取|你是只读|你在为项目|整理架构文档|请你?只读|你要.{0,6}只读)/

/**
 * agent 指令体裁的形状判据:**三条同时成立**才算 ——
 *   ① 够长(≥80 字;他打的话通常十几字)
 *   ② 开头是指令式(「你要…」「你是…」「你的任务…」「只读任务…」…)
 *   ③ 前 120 字里带着动作词(只读/禁止/分析/审查/输出/JSON/素材…)
 *
 * 宁可漏判(换个写法就漏过去):漏判的代价是「别处刚说过的」里多一条机器话;
 * 错判的代价是**把他的真话丢掉** —— 所以这里刻意保守。
 */
const AGENT_DIRECTIVE = /^(你要|你将|你是|你的任务|请你|你在为|只读任务|只读分析|整理架构文档|重写|为项目)/
const AGENT_ACTION = /(只读|禁止|分析|审查|提取|整理|重写|评测|报告|输出|JSON|json|素材|审查员|候选|模块|提示词)/

/** 这段文本是不是**插件/子代理自己**的提示词。纯函数,离线可测。 */
export function isInternalPrompt (text) {
  const t = String(text ?? '').trim()
  if (t === '') return false
  const low = t.toLowerCase()
  for (const m of INTERNAL_PROMPT_MARKERS) {
    if (low.startsWith(m)) return true
  }
  if (INTERNAL_PROMPT_OPENINGS.test(t)) return true
  return t.length >= 80 && AGENT_DIRECTIVE.test(t) && AGENT_ACTION.test(t.slice(0, 120))
}

// (v0.29.0:PLUGIN_ENVELOPE「【QQ·群聊|私聊】」信封正则随群聊拒收一起
// 删掉 —— 它定义后从未被引用(isHumanUtterance 走的是宿主注入白名单),
// 留着只会让人以为群聊信封还是合法输入。)

/**
 * 这段文本是不是**他打出来的话**?
 *
 * @param {string} text 消息正文
 * @returns {boolean} true = 当他说的话捕获;false = 宿主注入/系统噪音,不捕获
 */
export function isHumanUtterance (text) {
  const raw = String(text ?? '')
  const t = raw.trim()
  if (t === '') return false
  const low = t.toLowerCase()
  // 宿主注入:开头命中,或正文里就带着那句特征声明(它常常排在一段的前面)
  for (const m of HOST_INJECTION_MARKERS) {
    if (low.startsWith(m)) return false
  }
  // v0.30.2:插件/子代理自己的提示词(extractor、审查员、子代理任务…)——
  // 它们不是他打的话。判据见 isInternalPrompt。
  if (isInternalPrompt(t)) return false
  // 「Current runtime context」这类可能被包在别的段里:整段里出现且位于前半
  const rc = low.indexOf('current runtime context')
  if (rc !== -1 && rc < 200) return false
  if (low.indexOf('supersedes earlier runtime-context snapshots') !== -1) return false
  return true
}

/**
 * 这段文本该不该进「反思信封 / 对话窗口」。
 *
 * 与 `isHumanUtterance` 分开是因为两者判据不同:
 *   · 捕获(他说的话)要严 —— 脏东西进去了会长成记忆;
 *   · 反思窗口宁松勿严?**不**,一样严:A 侧的记忆脏就是这么来的。
 * 所以目前两者同判据,分开写只是给以后留一个不同的口子(比如他贴的
 * 超长文档:捕获要,但反思信封自己另有裁剪)。
 */
export function shouldEnterMemory (text) {
  return isHumanUtterance(text)
}

/**
 * 记忆该不该**拒绝收下**(工程自指 / 系统噪音)。
 *
 * 他的裁决(2026-09-26):「一律拒收」—— A 侧的记忆图干净,是因为加一条
 * 记忆要过一道道审查;DSH 侧我们把这些"关于插件自己"的工作话也记成了
 * 他的记忆,于是他看到 `Echo记忆架构 / agent后端架构 / 网站后端架构` 这种
 * 节点躺在她的图谱里。
 *
 * **两层判据**(第一版把「做后端的」也拒了 —— 那是他的职业,不是噪音):
 *   · A 层「一出现就是工程」:记忆图谱 / 审查台 / 插件 / dsh-echo /
 *     runtime context / 界面视觉词(页面、配色、箭头样式…);
 *   · B 层「要跟这套东西一起出现才算」:前端、后端、代码、测试、报错、
 *     部署、节点、连线、夹角…—— 单独出现时可能是他的课业或职业。
 *
 * 宁可漏拒(少记一条工作话),不许错拒(把他的生活当成工程噪音扔掉)。
 *
 * @param {string} text 待写入的记忆正文(候选 summary)
 * @returns {{reject: boolean, reason: string}}
 */
// A 层:出现即工程自指
const SELF_A = [
  /记忆图谱|图谱页面|记忆图里|记忆架构|审查台|关系图/,
  /插件|dsh[-_ ]?echo/i,
  /runtime context|snapshot supersedes|file policy|approval prompts/i,
  /agent后端|agent的架构|提示词|系统提示|人设段/,
  // 界面/视觉迭代(他那些「太丑了」的原话)
  /(页面|界面|按钮|配色|字体|动画|布局|箭头样式|渲染|图谱)/,
  // 只留"工程动作"与"代码库自指";**裸的「前端/后端」不放这里** ——
  // 「他做后端的」是他的职业,不是噪音(第一版误拒过,Python 电池当场抓住)。
  /(代码库|仓库|分支|提交|部署|编译|构建|单元测试|测试用例|报错|堆栈|pytest|npm run)/
]
// B 层:要跟"这套东西"一起出现才算(避免误伤他的职业/课业)
const SELF_B = /(前端|后端|代码|测试|节点|连线|夹角|斥力|调试|重构|接口|数据库|性能)/
const ARTIFACT = /(插件|echo|图谱|页面|界面|审查台|箭头|渲染|这个项目|这套|agent|提示词|记忆库)/i

export function rejectReason (text) {
  const t = String(text ?? '').trim()
  if (t === '') return { reject: true, reason: 'empty' }
  if (!isHumanUtterance(t)) return { reject: true, reason: 'host-injection' }
  if (isInternalPrompt(t)) return { reject: true, reason: 'internal-prompt' }
  for (const re of SELF_A) {
    if (re.test(t)) return { reject: true, reason: 'self-referential' }
  }
  if (SELF_B.test(t) && ARTIFACT.test(t)) return { reject: true, reason: 'self-referential' }
  return { reject: false, reason: '' }
}
