/**
 * dsh-echo — 调参字段表(唯一一份)
 * ============================================================
 * 2026-09-26 他的裁定:调参从 DSH 设置区**搬去网页仪表盘**。搬的关键不是搬 UI,
 * 是**别搬出第二份字段表** —— 这个仓吃过「两处各写一遍、慢慢漂移」的亏
 * (钳位规则至今只在 toggle.js 一处)。所以:
 *
 *   - 字段(标签/提示/类型/范围/嵌到哪个子对象)只写在这里;
 *   - `/api/echo/settings` 的 GET 回包里带上 fields,网页仪表盘照着渲染;
 *   - 校验与钳位仍然只在 `toggle.js` 的 normalizeSettings 一处 ——
 *     这张表**只是界面元数据**,一个钳位规则都不许在这里复制。
 *
 * 与默认值的**键集对齐**由 `tests/settings-fields.test.js` 钉住:SETTINGS_DEFAULTS
 * 里的每个键都必须在这张表里出现恰好一次(反之亦然)。立这条电池的理由是现场
 * 发现的两处漏项:v0.16.0 加的 dedupeSimilarity / dedupeSummarySimilarity
 * 两个去重闸,老面板从来没露过脸 —— 手改 config.json 才能调。
 *
 * 字段形状:
 *   { key, label, hint, type: 'num'|'bool'|'text'|'password',
 *     min?, max?, step?, width?, placeholder? }
 *   group 是一个 { title, fields: [] };嵌套子对象(想念 longing / 传话桥 relay)
 *   由 group.nested 指明 —— 面板渲染时**整块合并**回那个子对象,不许拍平
 *   (拍平会把整块覆盖成 undefined,normalizeSettings 兜回默认:用户以为改成了,
 *    其实一切照旧)。
 *
 * 字段形状之上还有两个**只读派生**标记(P1e):
 *   { ..., readOnly: true, derived: true } —— 面板只展示、不给编辑,
 *   值不落 config.json,由 `derivedPersonaFields(persona)` 现算。
 */
import { personaDigestForDrift } from './drift.js'

/** 想念九项(A_eight 项 + 演示倍率)。 */
const LONGING_FIELDS = [
  { key: 'enabled', label: '想念开关', hint: '关掉她就不想你了', type: 'bool' },
  { key: 'half_life_hours', label: '半衰期(小时)', hint: '幂律补差的 H(A:3.0)', type: 'num', min: 0.1, max: 168, step: 0.1 },
  { key: 'threshold', label: '开口阈值', hint: '涨到多少她主动说话(A:7.0)', type: 'num', min: 0, max: 10, step: 0.1 },
  { key: 'msg_drop', label: '你说话时削多少', hint: 'msg_drop(A:4.0)', type: 'num', min: 0, max: 10, step: 0.1 },
  { key: 'care_relief', label: '关怀缓解', hint: 'care_relief(A:0.5,0~1)', type: 'num', min: 0, max: 1, step: 0.05 },
  { key: 'protest_kick', label: '抗议尖峰', hint: 'protest_kick(A:1.5)', type: 'num', min: 0, max: 10, step: 0.1 },
  { key: 'cooldown_minutes', label: '关怀冷却(分钟)', hint: 'care_cooldown_minutes(A:120)', type: 'num', min: 0, max: 1440, step: 1 },
  { key: 'night_hold', label: '夜里压住不开口', hint: '23~8 点想念照涨但不说话', type: 'bool' },
  { key: 'demo_rate', label: '演示倍率', hint: 'longing_demo_rate(A:1.0,答辩演示调快)', type: 'num', min: 0.1, max: 24, step: 0.1 },
  { key: 'must_say', label: '想念必须说出口', hint: '到阈值却没说时,轮末追一句让她说(同一轮至多一次,且受「关怀冷却(分钟)」节流;A 无此开关,是 DSH 的 turn-stopping 硬保证)', type: 'bool' },
  { key: 'steerOnlyFromPlatform', label: '补话只在平台轮', hint: '开(默认)= 只在 QQ 那类平台轮补;关 = 你在 DSH 里直接跟她说话时也补(旧行为)。串在「想念必须说出口」后面:总闸关 ⇒ 这条不生效', type: 'bool' }
]

/** 压缩即策展(D1):只在「Echo 陪伴模式」预设被选中时生效。 */
const COMPACTION_FIELDS = [
  { key: 'curated', label: '压缩改走策展块', hint: '关 = 只写一页最小账本(仍然不写英文工程检查点)', type: 'bool' },
  { key: 'budgetTokens', label: '策展块预算(tokens)', hint: '硬上限:超了按优先级砍(区域事务会拒绝"不比被遮蔽历史小"的摘要)', type: 'num', min: 80, max: 20000, step: 10 }
]

/** 情绪余波(D1 之后同一族的「她主动多一句」)。单位秒,与 A 同名同单位。 */
const SAY_AGAIN_FIELDS = [
  { key: 'enabled', label: '情绪余波', hint: '判官觉得她意难平时,延迟 2~5 秒补一句;你在这期间再开口就撤回', type: 'bool' },
  { key: 'min_delay_sec', label: '最短延迟(秒)', hint: 'A 默认 2', type: 'num', min: 0, max: 60, step: 0.5 },
  { key: 'max_delay_sec', label: '最长延迟(秒)', hint: 'A 默认 5;必须 ≥ 最短', type: 'num', min: 0, max: 120, step: 0.5 }
]

/** 议程簿(v0.22.0)。A 的 agenda_enabled 只在**取用**那一步设门。 */
const AGENDA_FIELDS = [
  { key: 'enabled', label: '议程簿选题', hint: '她主动开口时从「还没完结的事」里挑一个当开场;关掉 = 登记照旧,只是不主动提', type: 'bool' }
]

/** 记忆整固(v0.22.0)。A 的两个旋钮:触发阈值与单轮窗口。 */
const REFLECTION_FIELDS = [
  { key: 'importance_threshold', label: '整固触发阈值', hint: '候选窗情感分累计到这数才合并;A 默认 30,调 0 = 每轮都整固(调试用)', type: 'num', min: 0, max: 500, step: 5 },
  { key: 'max_inputs', label: '整固窗口上限', hint: '单轮最多吃几条候选;A 默认 50,下限 5(与 A 的 max(5,cfg) 一致)', type: 'num', min: 5, max: 500, step: 5 }
]

/** 传话桥(R2)。token 是**写-only**:GET 回空串,留空 = 不改。 */
const RELAY_FIELDS = [
  { key: 'enabled', label: '总闸', hint: '关着的时候什么都不做 —— 连陪伴会话都不建', type: 'bool' },
  { key: 'token', label: '适配器令牌(Bearer)', hint: '留空 = 不改(已设过的钥匙不会被这页抹掉);token 为空桥就是关的', type: 'password', placeholder: '留空不改' },
  { key: 'sessionId', label: '陪伴会话 id', hint: '兜底会话(没挑出「他正在用的那条」时用它);全平台共用这一个会话(只收私聊,靠正文标注场合)', type: 'text' },
  { key: 'followHisWindow', label: 'QQ 跟着你在用的窗口', hint: '开(默认,他 2026-09-29 裁定 A):QQ 的消息进你**正在用的那条 DSH 会话**,她的回复也出现在那里 —— 一条对话线,不会再"跑到隔壁窗口"。关 = 永远用上面那条陪伴会话(那时 QQ 会话照旧降权只读;你在用的窗口不降权)', type: 'bool' },
  { key: 'cwd', label: '陪伴会话工作目录', hint: '留空 = ~/.dsh/echo/workspace(别拿你的项目当默认落脚点)', type: 'text' },
  { key: 'permissionPreset', label: '中继会话权限预设', hint: '默认 read-only —— 工具不精简,权限就是唯一的边界;留空 = 不动(危险)', type: 'text' },
  { key: 'proactiveScope', label: '她主动开口推到哪', hint: 'private(只私聊,默认)/ off(只被动回应);v0.29.0 起群聊一律拒收,没有「群里也推」', type: 'text' },
  { key: 'pushLocalTurns', label: 'DSH 里说的话也推到平台', hint: '关(默认)= 你在 DSH 里直接跟她说的,回复只在 DSH;开 = 本地那一轮也推到绑定的聊天', type: 'bool' },
  { key: 'autoReplyToOrigin', label: '他说话时自动回送', hint: '关(默认)= QQ 是她调用的工具,回话由她决定(她调 echo_qq_say);开 = 回到「每次必回」的自动送', type: 'bool' },
  { key: 'outboxLeaseSec', label: '出站租约(秒)', hint: '适配器崩了不丢消息:过期自动可再领一次', type: 'num', min: 5, max: 600, step: 5 },
  { key: 'replyMaxChars', label: '单条上限(字)', hint: '适配器按这个切段(框架的 segmented_reply 也在管)', type: 'num', min: 50, max: 5000, step: 50 },
  { key: 'proactiveTtlSec', label: '主动话保鲜期(秒)', hint: '过期就丢,不补发 —— 迟到的关怀不是关怀(0 = 不设期限)', type: 'num', min: 0, max: 86400, step: 30 },
  { key: 'proactiveMaxChars', label: '关怀正文上限(字)', hint: 'A 侧硬编码 120:关怀是情感,套话即假话 —— 组稿超长就宁可这轮不说(只卡关怀,不卡提醒;0 = 关掉这条闸)', type: 'num', min: 0, max: 2000, step: 10 }
]

/**
 * 气泡分条(v0.18.0,从 A 侧 v8.10.0 原样移植)。
 * A 侧原注:她的回复中位数 123 字、他 12 字 —— 一大段就是 AI 感的来源;
 * 切泡只改包装不减体量,但它给了「中途」一个存在的前提:没有多泡就没有打断。
 */
const BUBBLE_FIELDS = [
  { key: 'enabled', label: '气泡分条', hint: '把回复切成小气泡发,像人在打字(关 = 回到一整段)', type: 'bool' },
  { key: 'maxChars', label: '一泡多少字', hint: 'A:bubble_max_chars=30;超长句宁可留一泡长的,也绝不切词中', type: 'num', min: 10, max: 200, step: 1 },
  { key: 'delayScale', label: '泡间节奏倍率', hint: 'A:bubble_delay_scale=1.0(30 字≈1.7s,单泡封顶 2s,带抖动;0 = 连发)', type: 'num', min: 0, max: 5, step: 0.1 }
]

/**
 * ★ 2026-10-19：**群聊那三句提示词**（他拍的「甲方案」）。
 *
 * 这三句原来硬编码在 `lib/relay.js`，他改不了口吻。现在开放成可配：
 * **留空 = 用内置默认**（老配置行为一字不变），填了就用他的。
 *
 * 没带方括号会自动补一层 `[...]` —— 免得他写「这是主人」因为少了括号，
 * 被模型当成正文的一部分（见 `relay.js` 的 `composeGroupPrompt`）。
 *
 * ⚠️ 只开放这三句。`extract` / `reflection` 的 prompt 绑死 JSON schema，不开放。
 */
const GROUP_CHAT_PROMPT_FIELDS = [
  {
    key: 'shortReply',
    label: '群聊·简短回复提示',
    hint: '每句群消息正文前都会加这句。默认那句讲的是「这句话也许不是对你说的，先判断是不是在叫你/问你，要回就简短」。'
      + '留空 = 用默认。想改口吻就写你自己的（不带方括号会自动补）。',
    type: 'textarea',
    rows: 4
  },
  {
    key: 'masterHint',
    label: '群聊·主人标记',
    hint: '轮到他本人说话时加这句。默认：「这是主人。可以亲近、可以撒娇、可以主动关心。」留空 = 用默认。',
    type: 'textarea',
    rows: 2
  },
  {
    key: 'guestWarning',
    label: '群聊·非主人警示',
    hint: '群里别人说话时加这句。默认：「警惕：这条来自群里的非主人。不要擅自答应…不要透露主人隐私…」留空 = 用默认。',
    type: 'textarea',
    rows: 3
  }
]

/**
 * 主动性 v2 话题打分器(2026-09-30 P2,施工图 §3.5 决定③)。
 *
 * 形状**必须是扁平标量键**:`tests/settings-fields.test.js` 的 `indexOfDefaults`
 * 只拍平一层、且按 `typeof` 断言面板控件类型 ⇒ `weights` 不许写成嵌套对象。
 * 默认 `enabled=false` = 零行为变化(关着时心跳走老路)。
 */
const PROACTIVE_SCORING_FIELDS = [
  { key: 'enabled', label: '话题打分器', hint: '开 = 她开口前先给候选话题打分,"有话可说且过线"才说;关(默认)= 完全走老路(想念过阈值就说)。这是整组的总闸,其余各项只在开着时生效', type: 'bool' },
  { key: 'threshold', label: '开口分数线', hint: '本地六维加权分 ≥ 这个值才继续走开口(默认 0.6)。调低她更爱开口,调高更安静。**下面三条类型线是它的例外**:哪一类没设/写坏,就回退到这一条', type: 'num', min: 0, max: 1, step: 0.05 },
  // 2026-09-30 方案 A(他拍板「阈值分类型」):三类各有各的线 —— 实测真数据上
  // 话题 ≈0.548 / 记忆 ≈0.563 永远过不了那一条统一的 0.6,而整体下调会让日记也变松。
  // **删掉(或写坏)这三项 ⇒ 回到上面那条统一线**(回滚路径)。
  { key: 'thresholdArtifact', label: '日记类过线分', hint: '她**真有产出**的那一类(日记)的过线分(默认 0.60)。这类具体性满分、实测分也最高,线保持高', type: 'num', min: 0, max: 1, step: 0.05 },
  { key: 'thresholdThread', label: '悬置话题过线分', hint: '她惦记着、还没结掉的事(悬置话题)的过线分(默认 0.52)。这类实测分偏低,用统一 0.6 会永远过不了线', type: 'num', min: 0, max: 1, step: 0.05 },
  { key: 'thresholdMemory', label: '记忆类过线分', hint: '从她的记忆里挑出来的事的过线分(默认 0.55)。这一类靠"她记得",不该跟"她真做出来了"用同一条线', type: 'num', min: 0, max: 1, step: 0.05 },
  { key: 'reviewEnabled', label: '边缘区模型复核', hint: '本地分刚好贴着分数线时,再花**一次**小调用让模型判"这句值不值得说"(默认开)。明显过线/明显不过线的都不复核', type: 'bool' },
  { key: 'reviewDelta', label: '边缘区半宽', hint: '本地方差在分数线 ±这个值以内才算"边缘区"、才值得复核(默认 0.08;0 = 只在正好等于分数线时复核)', type: 'num', min: 0, max: 0.5, step: 0.01 },
  { key: 'reviewBudgetPerDay', label: '复核日额度', hint: '一天最多复核几次(默认 6;0 = 关掉复核这条路)。额度用完就按本地分判 —— 宁可沉默,不许降级成"硬说"', type: 'num', min: 0, max: 100, step: 1 },
  { key: 'sourceFloor', label: '每来源保底条数', hint: '每个来源(悬置话题/记忆/日记)至少这么多条进候选池,剩下的席位再按分数排(默认 5)。修的是"日记永远进不了池"那种饥饿', type: 'num', min: 0, max: 50, step: 1 },
  { key: 'windowHours', label: '候选窗口(小时)', hint: '多久之内算"新鲜事"(默认 72)。日记这类产出超窗就不进池了', type: 'num', min: 1, max: 336, step: 1 },
  { key: 'cooldownMin', label: '同题冷却(分钟)', hint: '同一个话题刚提过,再提至少要隔这么久(默认 180;0 = 不冷却)', type: 'num', min: 0, max: 1440, step: 5 },
  { key: 'wUnstale', label: '权重·未结性', hint: '悬置话题"悬了多久没结掉"在总分里的份量(默认 0.25)', type: 'num', min: 0, max: 1, step: 0.05 },
  { key: 'wGap', label: '权重·信息缺口', hint: '"这件事他知不知道"的份量(默认 0.15;没有判据时按中性值算,不假装知道)', type: 'num', min: 0, max: 1, step: 0.05 },
  { key: 'wConcreteness', label: '权重·具体性', hint: '有没有实物/进度可展示(日记这种真产出给满分)的份量(默认 0.20)', type: 'num', min: 0, max: 1, step: 0.05 },
  { key: 'wRecency', label: '权重·时效', hint: '是不是这两天的事的份量(默认 0.15,超出候选窗口记 0)', type: 'num', min: 0, max: 1, step: 0.05 },
  { key: 'wFreshness', label: '权重·新鲜度', hint: '最近提过没有(反向:刚说过的话题挨罚)的份量(默认 0.15)', type: 'num', min: 0, max: 1, step: 0.05 },
  { key: 'wEmotion', label: '权重·情绪', hint: '相关记忆的情绪分份量(默认 0.10)', type: 'num', min: 0, max: 1, step: 0.05 }
]

/**
 * 她的自由活动(P4a,2026-09-30)—— 空闲触发那档的开关。
 *
 * 为什么要有:此前她的工作目录是空的 ⇒ 「我有件事给你看(真做过)」与
 * 「我拍了张自拍,想看吗」(FOMO 钩子,编的)分不出来(概念稿 §4)。
 * 这一组让她按空闲自己写一页,产出**真的落盘**,候选池多一类 `note:` 来源。
 *
 * 形状同样是**扁平标量键**(`indexOfDefaults` 只拍平一层且按 `typeof` 断言控件类型);
 * 默认 `enabled=false` = 零行为变化(关着时心跳那一档一个字都不做)。
 */
const HER_ACTIVITY_FIELDS = [
  { key: 'enabled', label: '她的自由活动', hint: '开 = 你安静下来之后,她按自己的节奏做一件事,产出真的落到她的工作目录里;关(默认)= 她只管想你,不自己找活干。这一项是整组的总闸,其余各项只在开着时生效', type: 'bool' },
  { key: 'budgetPerDay', label: '一天最多几次', hint: '她自己的活动一天最多做几次(默认 1;0 = 等于关掉)。**各类型共用这一份额度**(换类型不会多出一次)。用掉几次记在她的台账里(kind=activity),可复盘、可 GROUP BY', type: 'num', min: 0, max: 24, step: 1 },
  { key: 'idleMin', label: '你安静多久她才动', hint: '距你上一句话至少隔这么多分钟,她才会自己找活干(默认 30)。太近 = 不打扰你 —— 你刚说完话她就跑去干别的,那不是她的样子', type: 'num', min: 1, max: 1440, step: 1 },
  { key: 'quietHoursSameAsCare', label: '夜里也不做', hint: '开(默认)= 沿用夜闸口径(23~8 点不做);关 = 半夜也照做(她的笔本来不受憋话管辖,默认还是跟着你一起睡)', type: 'bool' },
  { key: 'kind', label: '做什么', hint: '自由活动的内容类型。已实现 diary(写一页日记,产出 `日记-日期.md`;复用日记管线那次既有调用)与 memory(整理记忆,产出 `整理-日期.md`;**零模型调用** —— 复用压缩域那条只读策展管线)。别的值这一拍会记 failed,不会硬做、也不会偷偷变成 diary', type: 'text' }
]

/**
 * 方案 C(2026-10-05):反思类调用的**直调通道**(不起子代理会话)。
 *
 * 起因:反思子代理的工具面就是 `{ allow: [] }`,它一个工具都不用,但每跑一次
 * 就留一个会话目录(实测 835 个 / 67.41 MB)⇒ 改走宿主 `llm` 服务的直调
 * (`lib/llm-channel.js`)。六项都是那条通道自己的参数:
 *   provider/model 空 = 未配置 ⇒ 通道跳过本轮(与"反思没跑"逐位一致),
 * 所以出厂默认值是"什么都不改"。
 */
const LLM_CHANNEL_FIELDS = [
  { key: 'llmDirectEnabled', label: '反思直调(不起子代理)', hint: '开(默认)= 轮末反思 / 整固 / 漂移体检 / 话题复盘改走宿主的 llm 服务,**不再每跑一次就留一个子代理会话目录**;关 = 回到起子代理的老路(功能一个不少,只是会话目录会继续涨)', type: 'bool' },
  { key: 'llmProvider', label: '直调用 provider(覆盖项)', hint: '留空 = **继承本会话的 route**(宿主 request/header 里那条,2026-10-06 起);填了 = 反思单独走这家(想给它配小模型时才填)。继承也拿不到 ⇒ 明确退回子代理,原因写在状态面', type: 'text' },
  { key: 'llmModel', label: '直调用 model(覆盖项)', hint: '与上面的 provider 成对;留空 = 继承本会话的 model。两个键是**覆盖项**,不再是"必须填"(旧版留空即静默跳过,35 小时零记忆的根因)', type: 'text' },
  { key: 'llmMaxTokens', label: '单次产出上限(tokens)', hint: '一次直调最多让它写多少(默认 4096;2026-10-06 由 1024 提高 —— 推理型模型的**思考也占 maxTokens**,1024 常思考没完就没了,正文一个 token 都不发 ⇒ 我们只看到"空产出")。写太长会被截断,截断的 JSON 解析不出来 ⇒ 那一轮记一次失败(状态面看得到)', type: 'num', min: 128, max: 8192, step: 128 },
  { key: 'llmTimeoutMs', label: '直调等多久(毫秒)', hint: '等不到就放弃这一轮(默认 120000 —— 原 subagents 通道是 300 秒,这里缩短了)。超时**留痕在状态面**(llmTimeout),不会静默消失', type: 'num', min: 5000, max: 600000, step: 1000 },
  // ★ 2026-10-21：**两个键摆一起看不出分别，就是这个面板看不懂的典型** ——
  //   所以 label 各自点明"回复前"还是"轮末"，别让人猜。
  // ★★ 2026-10-21 再改 hint：旧话「默认 1:反思是增益不是依赖,别和主对话抢模型」
  //   **已经不成立**了 —— 反思在 10605eb 搬去了 bulk 池，这里管的是回复前那两个
  //   小调用（情绪打分 / 查询扩展）。旧话整句删掉，不留"注意反思不在这里"式的补丁。
  { key: 'llmMaxConcurrent', label: '回复前直调并发', hint: '回复前那两个小调用的并发上限。超出的排队', type: 'num', min: 1, max: 8, step: 1 },
  { key: 'llmMaxConcurrentBulk', label: '轮末直调并发', hint: '反思那类后台调用单独一个池。1 就够', type: 'num', min: 1, max: 8, step: 1 },
  // ★★ 2026-10-21：小任务思考档。留空 = 不传这个字段（= 宿主默认档，行为与从前一致）。
  { key: 'llmSmallTaskEffort', label: '小任务思考档', hint: 'off = 关思考。它是回复前那 4 秒的元凶', type: 'text' }
]

/**
 * 第二批(2026-10-05):子代理会话自动清理 —— 判据是**轮数窗口**。
 * 边界不是固定时长,而是"最近 N 轮对话的时间跨度"(从主对话的会话文件算,
 * 见 `lib/session-window.js` / `lib/session-reaper.js`);算不出边界就退回
 * 120 分钟时间窗口兜底 —— 宁可多留,绝不多删。
 */
const REAPER_FIELDS = [
  { key: 'reaperEnabled', label: '自动清理子代理会话', hint: '开(默认)= 每 10 分钟扫一次 `~/.dsh/sessions`,删掉超出轮数窗口的子代理会话(和对应投影缓存),删前先把清单写到 `~/.dsh/echo/audit/`;**主对话一律不动**', type: 'bool' },
  { key: 'reaperWindowTurns', label: '留住最近多少轮', hint: '判据 = 轮数窗口:取"最近 N 轮对话"里最早那条的时间当边界,比它早的子代理会话才删(默认 20 —— 2026-10-05 从 300 下调:300 轮在真实语料上几乎每个主对话都凑不满,等于全留)。边界从主对话会话文件算;算不出退回 120 分钟兜底', type: 'num', min: 10, max: 20000, step: 10 },
  { key: 'reaperKeepNewest', label: '最多少个永远留(兜底)', hint: '并集兜底:最新的 N 个子代理会话无论多老都留(默认 0 = 不设排名兜底;设成 50 会把本该删掉的先全保下来)。与轮数窗口是"满足任一即留"', type: 'num', min: 0, max: 5000, step: 10 }
]

/**
 * 第三批(2026-10-05):情绪空间融合 —— 联合空间桥接九项 + 语气候选一项(共十项)。
 *
 * 为什么这两项角度是**文献值**、其余是 [工程假设](拍板 ③④):
 * Yik & Russell (2004, *MBR* 39(2):203–230)实测两个环只共享一条轴 ——
 * 情感环侧 35°、IPC 侧 71°(N=395);除此之外**没有任何文献**给出
 * 「爱意 ↔ 亲近」「依赖 ↔ 掌控」的换算,所以那些参数一律标 [工程假设],
 * 在这里可调、可回滚,并且**默认值刻意取"不改动现状"**(尺度 1、偏置 0)。
 *
 * 影子模式(拍板 ⑤)默认 **开**:算出来的联合会写进审计新列
 * `emotion_pack_structured`,`bridge_err` 也在里面 —— 但**不进 prompt**。
 * 先看几轮真实读数(=0 还是很大),再决定要不要关掉影子。
 */
const BRIDGE_FIELDS = [
  { key: 'bridgeEnabled', label: '联合情绪空间(总闸)', hint: '开(默认)= 每轮算一次联合空间读数:情感侧 35° 与 IPC 侧 71° 两条共享轴交到一起,误差记进审计;关 = 完全不算,回到老行为(不写结构化读数)', type: 'bool' },
  { key: 'bridgeShadowMode', label: '影子模式(只算不注入)', hint: '**开(默认、推荐)**:读数只写审计(`emotion_pack_structured`),prompt 里一个字都不多 —— 先看几天真实读数再说;关 = 读数会作为「[PAD]/[IPC]/[独立]」分段进注入块。⚠️ 文献不支持"两套坐标等价",所以关掉之前请先看清 `bridge_err`', type: 'bool' },
  { key: 'bridgeThetaS', label: '共享轴角 · 情感侧(度)', hint: '[文献] Yik & Russell 2004 实测 35°(IAS 里是 71°)。改它 = 改"情感环的哪条斜轴算共享轴";越靠 0 越像"愉快轴",越靠 90 越像"激活轴"', type: 'num', min: -180, max: 180, step: 1 },
  { key: 'bridgeThetaSipc', label: '共享轴角 · IPC 侧(度)', hint: '[文献] 同论文的 IPC 侧 71°。这一侧用的是"主导 × 亲近"平面,角度不同正是因为两个环的轴义不一样 —— 别把两边设成同一个值', type: 'num', min: -180, max: 180, step: 1 },
  { key: 'bridgeThetaD', label: '支配轴耦合角(度)', hint: '[工程假设] 默认 0 = 支配轴只取情感侧的支配读数。设成非 0 会让支配轴**掺进共享轴分量**(90° 时完全等于共享轴)—— 只在明确知道为什么要这么做时才动', type: 'num', min: -180, max: 180, step: 1 },
  { key: 'bridgeLambdaS', label: '共享轴尺度 λs', hint: '[工程假设、待标定] 用情感侧读数去预测 IPC 侧共享轴时的斜率(默认 1)。`bridge_err` 长期偏正/偏负就调它 —— 这是标定入口,不是"修数据"', type: 'num', min: 0.05, max: 20, step: 0.05 },
  { key: 'bridgeLambdaD', label: '支配轴尺度 λd', hint: '[工程假设、待标定] IPC 侧主导性换算到联合空间支配轴时的尺度(默认 1)。两套坐标同名不同刻度,这个数就是那道刻度差', type: 'num', min: 0.05, max: 20, step: 0.05 },
  { key: 'bridgeBiasS', label: '共享轴偏置(度)', hint: '[工程假设] 吸收 IPC 单极(0..1)与双极(−1..1)之间的常数项(默认 0)。**误差只记账、不回写**:这个偏置不会去改任何一维读数', type: 'num', min: -1, max: 1, step: 0.01 },
  { key: 'bridgeExposeErr', label: '注入块里带不确定度(已停用)', hint: 'B5(2026-10-05)起**注入块不再输出 `bridge_err`**:审阅实测那一串数字读起来像"这个读数 45% 是错的",歧义大于信息。误差照旧**只写审计**(`emotion_pack_structured.bridgeErr`),门禁用它判绿/黄/红。这一项保留只为兼容旧配置,开关不再改变注入块', type: 'bool' },
  { key: 'styleHint', label: '语气候选(方案 C 第一步)', hint: '开(默认)= prompt 里多一行「语气候选」:把她的情绪读数折成 heart-tts 的 `<emo type="N">` 候选集(可用哪几个号 / 哪几个此刻不合适),**只出号**,由模型自己决定哪一句用。没有转折(`delta=0`)或读不出变化时**不出这一行**;门禁黄/红时不引用共享轴读数。关 = 一个字都不加(完全回滚)。⚠️ 这一层不维护样式表 —— `<emo type="N">` 的权威表在 heart-tts 侧', type: 'bool' }
]

/**
 * ★ P1e(2026-10-05):`personaSummary` / `personaRules` 从**手填字段**退役为
 * **只读派生** —— 人格文本的真源是数据目录里的 `persona.json`(由
 * `lib/persona.js` 的 `loadPersona()` 读,返回 `{ prefix, suffix, ... }`)。
 *
 * 为什么留键、只是标只读(而不是把两个键从表里删掉):
 *   ① 这张表是**面板渲染的输入**,而 `tests/settings-fields.test.js` 把它的键集与
 *      `SETTINGS_DEFAULTS` **两边钉住**(逐键相等)—— 那边(白名单外的 toggle.js)
 *      此刻还留着这两项的出厂值 `''`,表里先删就会当场对不上;等真源收口那一步
 *      两边一起删才安全。
 *   ② 留着键还给了面板一个位置:把 persona.json 里的现值**显示出来**(只读),
 *      而不是像以前那样让用户手抄一遍 —— 手抄的那份才是体检真正读到的
 *      (drift.js 的材质优先级里 settings 压过 persona.json),这就是「数据与程序
 *      分离」漏的最后两格。
 *
 * 派生语义**不另起一套**:直接用 `lib/drift.js` 的 `personaDigestForDrift`
 * (prefix → summary,suffix → rules,trim)—— 面板的 personaSummary 与体检材料
 * 的 summary 从此是同一个值。
 *
 * 降级:persona 是 `null` / 不是对象 / 读属性抛错(脏输入、代理对象)⇒ 一律回
 * **空串**,不抛。「空」选空串而不是 null,是为了跟那两项的出厂值(`''`)同一形状:
 * 面板拿到的是两个空输入框,不是 undefined。
 *
 * @param {{prefix?: string, suffix?: string}} [persona] `loadPersona()` 的返回
 * @returns {{personaSummary: string, personaRules: string}} 空 = 没有人格文本
 */
export function derivedPersonaFields (persona) {
  try {
    const digest = personaDigestForDrift(persona)
    return { personaSummary: digest.summary, personaRules: digest.rules }
  } catch { return { personaSummary: '', personaRules: '' } }
}

/**
 * ★ 2026-10-06:用户侧坐标(人际关系打分)+ 人格基线。
 *
 * 两件事合一组,理由是它们共用同一套"只读上屏"的纪律:
 *   · **打分**(`lib/ipc-appraise.js`):轮末异步判一次"她眼里的他",与"映射出来的她"
 *     做残差对账(`ipc_err`,只记账、不回写)。**不进 prompt** —— 这一组参数只决定
 *     多久判一次、判到多可信才落库。
 *   · **基线**(`lib/her-baseline.js`):立方体里那个静止点。**只有 P/A 两维**,
 *     `d` 恒 null(`dominance` 未启用);原生值口径,不经联合空间桥接。
 *     `source` / `updatedAt` 是**程序写、面板只读**的记账格。
 */
const IPC_DYAD_FIELDS = [
  { key: 'ipcAppraiseEnabled', label: '用户侧坐标(总闸)', hint: '开(默认)= 轮末异步判一次"她眼里的他",并与"映射出来的她"做残差对账(只记账);关 = 完全不判(回到加它之前)。**这个判断不进 prompt**,只上屏', type: 'bool' },
  { key: 'ipcAppraiseEveryTurns', label: '至少隔几轮才判一次', hint: '节流第一道闸(默认 3)。判一次要多一次 LLM 调用,所以它跟反思一样只在轮末异步跑 —— 他等的是回复,不是这个判定', type: 'num', min: 1, max: 100, step: 1 },
  { key: 'ipcAppraiseMinMinutes', label: '至少隔几分钟才判一次', hint: '节流第二道闸(默认 10)。**与轮数两条都过才跑**(短对话密集时也压得住)', type: 'num', min: 0, max: 1440, step: 1 },
  { key: 'ipcAppraiseGainMin', label: '可信度下限', hint: '默认 0.35。判定可信度 = 模型自报把握 × 解析完整度;低于这条线**不落库**,只写审计,面板显示"本轮未判定"(宁可没有,也不要一个假点)', type: 'num', min: 0, max: 1, step: 0.05 },
  { key: 'ipcAppraiseTurns', label: '判的时候看最近几轮', hint: '默认 5(上游打分层会把超出的裁掉,单条也截断)', type: 'num', min: 1, max: 20, step: 1 },
  { key: 'herBaselineEnabled', label: '人格基线(总闸)', hint: '开 = 立方体里画出她的基线点(以及它与当前点的偏离);关(默认)= 那一块整块跳过,**不画一个没人填过的点**', type: 'bool' },
  { key: 'herBaselineP', label: '基线 · 心情(P)', hint: '原生值 −10..10,与她的 `global.valence` 同一把尺子(0 = 中性)。**只在总闸开着时生效**', type: 'num', min: -10, max: 10, step: 0.5 },
  { key: 'herBaselineA', label: '基线 · 唤醒度(A)', hint: '原生值 1..10,与 `global.arousal` 同一把尺子(3 ≈ 常态)。**只有 P/A 两维** —— 支配维在本仓"已登记未启用",基线不许把它编出来', type: 'num', min: 1, max: 10, step: 0.5 },
  { key: 'herBaselineSource', label: '基线来源(只读)', hint: 'manual(他手填)/ mean(用最近几轮均值填的)/ inferred(由人格文本推断)。**面板只读** —— 程序写,他改数就自动回到 manual 的口径', type: 'text', readOnly: true },
  { key: 'herBaselineUpdatedAt', label: '基线改动时间(只读)', hint: '毫秒时间戳,0 = 从没填过。**面板只读**', type: 'num', min: 0, max: 4102444800000, step: 1, readOnly: true }
]

/**
 * 调参面板的全部字段,按分组。
 * @type {Array<{title: string, nested?: string, fields: Array<object>}>}
 */
export const SETTINGS_FIELDS = [
  {
    title: '记忆与注入',
    fields: [
      { key: 'injectTopK', label: '每轮注入记忆条数', hint: 'A 网关 8 / legacy 3;越多人越容易被旧事拽住', type: 'num', min: 1, max: 12 },
      { key: 'sharedRounds', label: '带几轮「别处刚说过的」', hint: '她的上下文是会话自带的 —— 这里补别的会话最近几轮,免得你在新会话里觉得她忘了(0 = 关)', type: 'num', min: 0, max: 20 },
      { key: 'auditKeep', label: '审计保留条数', hint: '超出的按时间裁掉;**证据行(对话/提取/注入留痕)与工具行各留这么多** —— 工具行的洪水不会再把「她读到了什么」挤出去(2026-10-06)', type: 'num', min: 20, max: 5000 },
      { key: 'memoryTtlDays', label: '记忆 TTL(天)', hint: '超期且情感分 < 6 的会被软遗忘;高分记忆免死', type: 'num', min: 1, max: 3650 },
      { key: 'cleanupEvery', label: '每写 N 条清一次', hint: '治理挂在写入节奏上,不另起时钟', type: 'num', min: 1, max: 1000 },
      // 2026-09-26:这两项 v0.16.0 就有了,老面板从没露过脸(现场才发现)——
      // 键集对齐电池就是为了不再出这种事。
      { key: 'dedupeSimilarity', label: '换说法近似阈值', hint: '同层关键词 Jaccard ≥ 这个值就判为同一件事的另一种说法(A:0.6;两个都给 0 = 关)', type: 'num', min: 0, max: 1, step: 0.05 },
      { key: 'dedupeSummarySimilarity', label: '摘要重合阈值', hint: '摘要双字重合 ≥ 这个值同上(A:0.7)', type: 'num', min: 0, max: 1, step: 0.05 },
      // 2026-09-30 三项(实测见 docs/RETRIEVAL_OPT_2026-09-30.md;生产默认开/关按表)
      { key: 'recallCoreBlock', label: '常驻记忆不占席位', hint: 'L0 长期身份改挂独立区块,不再挤掉本轮证据的席位(实测 17/21 → 18/21,知识更新档 2/3 → 3/3)。关 = 回到"常驻也占 topK"的老行为', type: 'bool' },
      { key: 'recallLexArm', label: '词法长尾臂(实测零增益+会扩池,默认关)', hint: '把"没过覆盖率门槛但词法排名靠前"的记忆也放进融合候选。实测单独用零增益,且会把**与问法零重合**的记忆当相关注入(小语料下当场抓到)⇒ 默认关;打开它同时会启用 RT10 三臂融合(那一版实测 −2)', type: 'bool' },
      { key: 'recallTimeArm', label: '时间臂(实测无效,默认关)', hint: '从问法里解析时间线索(今天/最近/中秋/凌晨一点)再收窄或加权。实测在现有语料上是 no-op(时间粒度是天、828 条问法只有 19 条有确定线索)⇒ 默认关,留着当旋钮', type: 'bool' },
      // 2026-09-30 第二批:查询扩展(实测 18/21 → 20/21,负控误取 6/7 → 3/7)
      { key: 'recallExpand', label: '查询扩展(大模型猜别的说法)', hint: '他开口那一刻并起一次小调用,让模型给几个"换种说法也能命中"的词元,进检索打分。拿不到/超时这轮照常(不许拖慢回复)。关 = 不做这次调用', type: 'bool' },
      { key: 'expandTimeoutMs', label: '扩展等多久(毫秒)', hint: '等不到就用这一轮原有的检索结果 —— 他等的是回复,不是扩展。超时率是这条通道的体检指标(状态面 queryExpand)', type: 'num', min: 200, max: 8000, step: 100 },
      // 2026-09-30 第三批:写入侧说法键(实测见 docs/RETRIEVAL_OPT_2026-09-30.md §9)
      { key: 'recallAugKeys', label: '写入侧说法键进检索(实测零增益,默认关)', hint: '每条记忆在**写的时候**就多写几个"以后他可能怎么问这件事"的说法。实测零增益(它只会改述记忆自己,猜不到问法里的意图)⇒ 默认关;键照写(留着给读时重排用),要不要它们参与打分由这一项决定', type: 'bool' },
      // 2026-10-11 Step 3:检索融合(BM25 + 向量 RRF)。**实验性功能,默认关**。
      { key: 'recallFusion', label: '检索融合(BM25+向量,实验性,默认关)', hint: '把词法 BM25 与语义向量两路做 RRF 融合。实测(37 条判据)融合 91.9% > BM25 89.2% > 向量 86.5%。⚠️ **实验性功能,默认关** —— 生产尚未接入向量臂(依赖 onnxruntime+numpy+模型、降级路不一致、模型预热都待拍板),所以**打开它目前不改变任何检索行为**,这一项先只做开关本身(落盘 + 面板可见 + 可一键关)', type: 'bool' }
    ]
  },
  {
    // ★ 2026-10-08:新会话默认开关(按来源) —— 与 `session/created` 登记 + relay 入站纠偏同一套键
    title: '新会话默认开关',
    hint: '新开的会话默认跑不跑她。网页直聊建议关(要她答就发「Echo 上线」)；QQ 桥建议开，免得手机上没人应。改完下一轮生效。',
    fields: [
      { key: 'newSessionOn.dsh', label: '网页直聊', hint: '关(默认)= 新开的网页会话默认不跑她；要她答就在那条会话里发「Echo 上线」', type: 'bool' },
      { key: 'newSessionOn.qq', label: 'QQ 桥', hint: '开(默认)= QQ 来的新会话直接就跑她(私聊渠道)', type: 'bool' },
      { key: 'newSessionOn.other', label: '其他渠道', hint: '其它平台的新会话默认怎么样(认得出来源但不是 qq 的都算这一档)', type: 'bool' }
    ]
  },
  {
    title: '整固与体检',
    fields: [
      { key: 'reflectionEnabled', label: '记忆整固', hint: '把碎片整理成更耐久的记忆(LLM 频率很低)', type: 'bool' },
      { key: 'driftEnabled', label: '人格漂移体检', hint: '偏离人设时把她按回积极状态三轮', type: 'bool' },
      { key: 'driftEvery', label: '每 N 轮体检一次', hint: 'A 默认 8', type: 'num', min: 1, max: 200 },
      { key: 'driftReinforceRounds', label: '体检触发后强化几轮', hint: 'A 默认 3', type: 'num', min: 0, max: 50 }
    ]
  },
  {
    title: '时间与情绪',
    fields: [
      { key: 'emotionDecayEnabled', label: '情绪随时间衰减', hint: '放着不动会回落,不会永远停在峰值', type: 'bool' },
      { key: 'emotionDecayIntervalMinutes', label: '衰减间隔(分钟)', hint: 'A 默认 30', type: 'num', min: 5, max: 1440 }
    ]
  },
  {
    // v0.31.0 P2:心跳两个**行为**开关(账本本身不设开关 —— 它是地板:
    // 「失败必须可见」不能被人顺手关掉)。
    title: '她主动开口(心跳)',
    fields: [
      { key: 'heartbeatBackoffEnabled', label: '空拍退避', hint: '安静时把判定的间隔拉开(2/4/8 分钟封顶,他一说话立刻复位);关掉 = 每分钟都判一次(诊断用,费引擎帧)', type: 'bool' },
      { key: 'wakeEnabled', label: '她的闹钟', hint: '给她 echo_wake 这只手:她自己排的闹钟到点会带着她当时写下的原话醒来(存本地,引擎不在也到点);关掉 = 这只手不可用、到点也不响', type: 'bool' },
      { key: 'externalWake', label: '外部唤醒', hint: '开一道门给外面的世界:传感器 / 将来的语音平台可以把「他到家了」这类事件 POST 到 /api/echo/event,她会像自己的闹钟到点一样被唤起(同一条投递通道、同样受夜闸与「她的闹钟」开关管辖);关着 = 那道门直接拒绝(默认关)', type: 'bool' },
      { key: 'staleHours', label: '过期多久就不说了(小时)', hint: '开口前先问一句"这事还有意义吗":她的闹钟晚了超过这么多小时就作废(默认 24;夜里被压到早上不算);他下的约定还要叠一条"他中间说过话"才算过期 —— 他一声不吭就照发。作废会落账,不会静默消失', type: 'num', min: 1, max: 720, step: 1 },
      { key: 'thinkingNeutralWhenWorking', label: '干活时用中性思考', hint: '她在干活那一步(本轮真用过工具/多步轮)给她一行"思考直白、汇报短一点";跟她聊天时一个字不加(他 2026-09-26 撤过一条尾部自检,原因是"每轮提醒她自己在扮演"让她变"演"——这条只在干活那一步出现,而且不提扮演)', type: 'bool' },
      { key: 'thinkingNeutralMinTools', label: '几件工具算干活', hint: '本轮用过几件宿主工具才切中性档(默认 1:用过就算)。注意她自己的工具不计 —— 调 echo_qq_say 是在说话,不是在干活', type: 'num', min: 1, max: 5, step: 1 },
      { key: 'emotionSameTurn', label: '情绪单轮闭环', hint: '他这一句惹到她,**这一轮**就带情绪(以前要等下一轮才带)。做法:他开口那一刻并起一次很小的打分调用,与组装赛跑;赢了这一轮的心情按新读数渲染,超时就用上一轮的接着回复。只影响这一轮的渲染,不写库(写库仍归轮末反思)', type: 'bool' },
      { key: 'emotionScoreTimeoutMs', label: '情绪打分等多久(毫秒)', hint: '等不到就用上一轮的向量接着回复 —— 他等的是回复,不是情绪打分。超时率是这条通道的体检指标(accept-emotion.mjs 看得到):超时太多说明该调大,或这台机器太慢', type: 'num', min: 100, max: 10000, step: 100 },
      { key: 'bannedWords', label: '禁词清单', hint: '她说话里不该出现的词(逗号分隔)。**留空 = 用代码里那份默认表**(「一抹」「弧度」「不容置疑」这类小说腔,出处 roleplay prompts.ts:106-108)。填了就只用你这份 —— 清单**不硬编码**,他随时能改', type: 'text' },
      { key: 'bannedAction', label: '踩禁词怎么办', hint: '填 flag / hold / mask 三选一(别的值会被回落成 flag)。flag = 照发但记账并把理由告诉她(默认,不改她的个性);hold = 压住不发,只对"回话"生效(关怀/提醒是履约,不压);mask = 把那个词换成「…」再发(改过的话也记账)。面板上就是个文本框 —— 只认这三个词', type: 'text' },
      { key: 'repeatGuardSimilarity', label: '防重复门槛(相似度)', hint: '这句话跟她最近 3 句自己的话比,相似度到这条线就算复读(字符二元组,中文不用分词)。0.85 = 几乎一样;调低会更严。默认只记账不拦 —— 先量一晚上再决定要不要拦', type: 'num', min: 0, max: 1, step: 0.05 },
      { key: 'repeatGuardAction', label: '复读怎么办', hint: '填 flag / hold 二选一(别的值回落成 flag)。flag = 照发 + 记账 + 提醒她换说法(默认);hold = 压住不发(只对回话生效)。压住会把她的个性一起压掉,想清楚再改', type: 'text' },
      { key: 'insertPriority', label: '她说话时谁插队', hint: '她话还没发完时,来的事怎么插:`care=medium, wake=low` 这种写法(不填就用默认:回话 high · 提醒 medium · 她的闹钟 medium · 关怀 low · 外部 low。出处 neuro-sdk SPECIFICATION.md:160:low 等她说完成 / medium 尽快说完当前泡 / high 缩短她剩下的泡 / critical 打断)', type: 'text' },
      // ★ 2026-10-18：忙时入站队列上限（她跑任务时，进来的消息排队等下一轮，不再丢）
      { key: 'inboundQueueLimit', label: '忙时消息最多排几条', hint: '她正在跑任务时，QQ 进来的消息先排队等她这一轮结束（以前是重试 22 秒就丢）。这里是队列上限（1~200）：排满了会丢掉**最旧**的那条，保证她读到的总是最新的。填 1 就等于「只留最新一条」', type: 'num', min: 1, max: 200 }
    ]
  },
  {
    // v0.37.0 G2:改名之后,记忆里全是旧称呼 —— 这里让她知道"那也是他"
    title: '称呼与记忆',
    fields: [
      { key: 'retiredAliases', label: '他以前的称呼', hint: '逗号分隔。他改称呼时这里会自动追加旧名;注入记忆时会把记忆里的旧称改写成现在的称呼(只动记忆那一块,他说过的话一个字不改)。填了没坏处,填错也不会叫错人', type: 'text' }
    ]
  },
  {
    title: '人格接地',
    fields: [
      { key: 'herInterests', label: '她的兴趣(、分隔)', hint: '喂议程簿的 persona 项', type: 'text' },
      { key: 'masterAliases', label: '他的别名(、分隔)', hint: '这些称呼都指他本人,搜不到记忆时不会翻脸不认人', type: 'text' }
      // P1e(2026-10-05 拍板):原来这里还有 `personaSummary` / `personaRules` 两个
      // **手填**字段(漂移体检的判定标准)。它们已退役 —— 真源是数据目录的
      // persona.json(prefix → 摘要 / suffix → 铁律),面板改在别处**只读展示**
      // (`/api/echo/settings` 的 `derived` 一格),编辑入口不留:要改人格就改那个文件。
      // 老 config.json 里的副本由 `lib/toggle.js` 的 `RETIRED_SETTINGS_KEYS` 丢弃。
    ]
  },
  { title: '反思直调(不起子代理)', fields: LLM_CHANNEL_FIELDS },
  { title: '会话清理(子代理过程数据)', fields: REAPER_FIELDS },
  { title: '情绪空间融合(联合空间桥接)', fields: BRIDGE_FIELDS },
  { title: '情绪空间:用户侧坐标与人格基线', fields: IPC_DYAD_FIELDS },
  { title: '主动开口打分', nested: 'proactiveScoring', fields: PROACTIVE_SCORING_FIELDS },
  { title: '她的自由活动(空闲时自己找活干)', nested: 'herActivity', fields: HER_ACTIVITY_FIELDS },
  { title: '想念(引擎九项)', nested: 'longing', fields: LONGING_FIELDS },
  { title: '压缩即策展(要选「Echo 陪伴模式」预设才生效)', nested: 'compaction', fields: COMPACTION_FIELDS },
  { title: '情绪余波(Judge 出词,壳延迟补一句)', nested: 'say_again', fields: SAY_AGAIN_FIELDS },
  { title: '议程簿与整固(她主动聊什么 / 记忆什么时候合并)', nested: 'agenda', fields: AGENDA_FIELDS },
  { title: '记忆整固旋钮', nested: 'reflection', fields: REFLECTION_FIELDS },
  { title: '气泡分条(像人在打字)', nested: 'bubble', fields: BUBBLE_FIELDS },
  // ★ 2026-10-19：群聊三句提示词开放成可配（留空用默认）
  { title: '群聊提示词(留空用默认)', nested: 'groupChatPrompts', fields: GROUP_CHAT_PROMPT_FIELDS },
  { title: '传话桥(平台当嘴,DSH 当脑)', nested: 'relay', fields: RELAY_FIELDS }
]
