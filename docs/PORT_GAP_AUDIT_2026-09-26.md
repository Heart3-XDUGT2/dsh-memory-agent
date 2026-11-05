# A → B 逐项对账总表(2026-09-26 当晚)

**为什么会写这份**:他说「我让你 1:1 的复刻,你到底有没有完整的复刻过?」——查完的答案是
**没有完整复刻**。根因不是偷懒,是**这个仓里从来没有一张 A→B 的对照清单**:A 侧的家底只
活在 `docs/ASTRBOT_PLUGIN_ARCHAEOLOGY.md`(那份表第三列是「与平台强耦合」,不是"是否已移
植")和我的记忆里,于是"待重新设计"的东西就再也没人回头看。

**这份表就是那张清单。以后每移一项,在这里划掉一项。**

三路只读审计(记忆 / 情绪·想念·主动 / 表达·反思·议程·可观测)的原始结论,证据全部是
`文件:行`。审计口径:A 侧 = `~/.astrbot/data/plugins/astrbot_plugin_memory_middleware`
主目录当前代码(不含 `.backups/`);B 侧 = 本仓 `lib/*.js`(壳)+ `python/engine/*.py`
(sidecar 引擎)+ `astrbot_adapter/`。**未读 `data_v4.db`,未运行 A 侧代码。**

## 总账

| 面 | 等价 | 部分 | 缺失 |
| --- | --- | --- | --- |
| 记忆系统(DMAE / 双层 / 图谱 / Judge / 治理) | 6 | 6 | 3 |
| 情绪 · 想念 · 主动 | 5 | 4 | 6 |
| 表达 · 反思 · 议程 · 可观测 | 13 | 9 | 9 |

**一句结论**:`DMAE 幂律遗忘`、`情景记忆检索打分`、`Memory Judge 三层防线`、`图论记忆三件套`、
`Reflection 反思整固`、`议程簿`、`想念曲线/削减/尖峰/夜闸` —— 这些**数学与算法层是逐式
1:1 的**(常数都对得上,活库在跑)。缺的集中在三处:**她怎么把话说出去**(气泡/打断)、
**他不在时她怎么开口**(关怀组稿层)、**当时设计文档要求的后端与界面**(策展压缩/Live2D/
面板)。

---

## 一、表达层(影响「像不像人」最直接)—— **v0.18.0 已补,见每行「B 侧」**

| # | 机制 | A 侧证据 | B 侧 | 判定 |
| --- | --- | --- | --- | --- |
| E1 | **气泡分条切分** | `core/echo_utils.py:82 split_bubbles(text, max_chars=30, max_bubbles=5)` + `:55 _split_long_sentence`(换行即界 / 句末切句 / 装箱 / 超长退逗号 / **绝不切词中** / 封顶 5 泡尾巴合并) | ✅ `lib/bubble.js: splitBubbles`(逐条对应;字数按码点算以对齐 Python `len`);电池 `tests/bubble.test.js` | **已补** |
| E2 | **泡间节奏** | `main.py:1384 _bubble_delay`:`base = min(2.0, 0.4 + len(bubble)*0.045)`,`base * scale * uniform(0.7, 1.3)`(30 字≈1.7s,单泡封顶 2s,总时长由 ≤5 泡兜在 ~8s) | ✅ `lib/bubble.js: bubbleDelaySec` + `planBubbles`(每泡带 `notBefore`);适配器 `_deliver` 等到点再发,轮询间隔由 `nextDueAt` 决定 | **已补** |
| E3 | **barge-in:插话即停** | `main.py:650-660`:`_session_seq` 抢话序号,`!= seq_now` 就把**没发的残句**存 `_interrupted_tail[session_id][:120]` 并 break;已发的泡不撤回 | ✅ 入站那一步 `relayCancelBubbles`(`lib/store.js`,只作废 `leased_until = 0` 的泡);租约**一次只放一泡**保证"手里这泡发完就停" | **已补** |
| E4 | **被打断的认账** | `brains/brain_pipeline.py:1250-1255` 下一轮注入:`【你刚才被插嘴了】你当时没说完的话:「…」——想继续就说,不想接就自然放下,也可以就他插嘴这件事说一句。不要硬接。` | ✅ `lib/interrupted.js`(pop 读一次就消费)+ `lib/turn-snapshot.js: renderInterruptedLine`(措辞逐字) | **已补** |
| E5 | **情绪余波 say_again** | `main.py:1395-1479`:延迟 2~5 秒追加一句,用户抢话立刻取消 | ✅ **v0.21.0 已补**:判官出 `say_again/extra_reply`(`python/engine/judge.py`,A 原文规则)、调度在 `lib/say-again.js`(注入定时器,离线钉时序)、接线在 `lib/index.js` 的 reflect 回程与 `user/message`(抢话即撤)、审计两列**写入端+读侧+面板+复现包**全通。**机制偏离**:A 直接发文本,B 把那句台词交给 agent 说(维护相 followup,与关怀同一条路)⇒ 平台侧出站/气泡/租约全复用。**边界**:序号只在投递前核一次(与 A 同窗口);投递失败不重试 | **已补** |
| E6 | 三项配置 | `bubble_split_enabled` / `bubble_max_chars`(30)/ `bubble_delay_scale`(1.0) | ✅ `settings.bubble.{enabled,maxChars,delayScale}`,默认与 A 同(`lib/toggle.js` + `lib/settings-fields.js` 面板一组) | **已补** |

## 二、关怀组稿层(他不在时她怎么开口)—— **v0.18.1 补 C1/C2/C3/C5,v0.18.2 补 C4/C6**

| # | 机制 | A 侧证据 | B 侧 | 判定 |
| --- | --- | --- | --- | --- |
| C1 | **认账防火墙** | `main.py:1855-1898`:`【你刚主动说过】…不许否认自己说过,也不许编造细节` + 内存窗口丢失时**查审计 10 分钟兜底还原原文** | ✅ `lib/proactive-ack.js`(措辞逐字,含 80 字截断与「刚才/N分钟前」分档);主路径走**落库**的 `conversation_log` 哨兵行(比 A 的内存窗口结实),兜底走审计;接在 `turn-snapshot.compose` 末尾(A 也是最后:`+ longing_line + proactive_line`) | **已补** |
| C2 | **「上次聊到」话头行 + 反思信念优先** | `main.py:1797-1826`:话题行取**最新 reflection summary**(证据版),占位符 `{topic}` `core/echo_prompts.py:199` | ✅ `store.latestReflectionSummary()` + `heartbeat.js` 逐字行 `[上次聊到] …(仅供参考,别当开场锚)`(反思比状态行新才覆盖;没有话头整行消失);顺带补上 A 系统提示里那条纪律句 | **已补** |
| C3 | **组稿失败即沉默 + 长度闸** | `main.py:1641-1643` `if not text: continue # 宁可沉默,不说套话`;`:1848-1852` 异常/空/`len>120` 一律 `return ""` | ✅ `lib/relay.js` 出站口 `CARE_MAX_CHARS = 120`(`relay.proactiveMaxChars` 可配,0=关):超长整条不发 + 审计 `care_silent`(不静默地不说);空正文本来就不发。**只卡关怀,不卡提醒**(A 侧提醒走模板兜底) | **已补** |
| C4 | **提醒/Judge 的 ±120s 到期防重** | `main.py:2088-2094` `if abs(resolve_follow_up_time(th["follow_up_after"]) - due) < 120: return` | ✅ `python/engine/threads.py: remember_pending_thread(due_window_sec=...)`:措辞之外再比到期,窗口内即并成一条;命令式(壳传 `dueWindowSec:120`)与 Judge(`judge.py` 传 120)**两侧都开** ⇒ 顺序无关。代价写进代码注释:两条不同约定恰好相距 <2 分钟会被并(这个面很窄,换顺序无关) | **已补** |
| C5 | **安抚以"真送达"为准** | `main.py:1644-1646` 以 `context.send_message` 返回真值为准 | ✅ 降权与 ×0.5 从「followup 入队成功」挪到**适配器 ack** 那一刻:`relay.onAcked` → `heartbeat.noteProactiveAcked`(只认本会话的 `kind='proactive'`);投递只记一条待兑现账 | **已补** |
| C6 | **>2000 字消息绕过想念削减** | A 无条件调 `echo_longing.py:195-200` | ✅ 两半都修:①想念帧删掉长度豁免,改送前 400 字(削满系数 40 字即饱和 ⇒ 数学逐位一致,`test_longing.py` 用 40/400/5000 三档证明同值);②**捕获**那处也不再把整轮丢掉,改成截 2000 字捕获(以前贴长文那一轮在会话/反思/漂移三处都看不见) | **已补** |
| C7 | 群友向情绪渲染 / brain1 逐句情绪冲击 | `echo_emotion.py:255-274`;`main.py:1219-1246` | 无 | A 侧自述单用户不可达 / 默认路径不生效 ⇒ **不补** |

## 三、记忆层

| # | 机制 | 现状 | 判定 |
| --- | --- | --- | --- |
| M1 | DMAE 可回忆度 / 强化 / 三态 / 剪枝 | `lib/dmae.js` + `python/engine/dmae.py` 逐式;常数 100/24/10/1.2/1.8/0.5/0.1 与 A `brain_pipeline.py:127-133` 逐条一致;活库 H=24/36/130.5h、26/40 被强化 | **等价** |
| M2 | 检索打分 `hits*2 + R*2 + emotion*0.1`、L0 豁免与强制占位、情景记忆列集 | `lib/retrieve.js:102` / `python/engine/retrieve.py:154` 同式;`coreCap = min(8, max(1, topK-2))` 同 | **等价** |
| M3 | **常驻画像 core_traits(语言/代词)** | ✅ **v0.18.3 已补**:写侧 `store.saveProfileTraits` 逐条搬 A 的 `_apply_profile_update` 纪律(白名单只有 `语言/代词`、键 ≤24 字、值 ≤32 字、总数 ≤5、`null` = 删除、非白名单键记日志);读侧 `getProfile` 也按白名单筛(A v8.1:旧库残留几十个键也不漏进 prompt);`engine.js` 不再只打 `profileUpdate deferred`;`context.js` 渲染 `[他的画像] 语言:中文`(A 是同一批白名单项拼一行 `用户画像: 称呼:X, 语言:中文`) | **已补**(`代词` 见下方注) |
| M4 | **图谱 / BFS 联想 / LTP / Judge / TTL 治理** | **只在 `python/engine/*.py` 里有**;`lib/*.js` 基线内 grep `graph_activate/heapq/visited_best/cleanup` = 0 ⇒ Python 探不到时这四项**一起消失** | **部分**(引擎在=等价) |
| M5 | 多用户隔离桶 `member:` | A 有可恢复路径(`member_key()` + 迁移 + `include_members`);B 无生成函数、无迁移 ⇒ 要恢复得新写 | **缺失**(单用户下不可达) |
| M6 | `inject_top_k` 默认值 | A `_conf_schema.json` 默认 **3**(网关侧另写死 8);B 可配默认 **6** —— **有意的差**:3 条对"她还记得多少"太薄,8 条挤占上下文;B 取中间值,面板上可调(`tests/toggle.test.js:184` 钉着) | 部分 |
| M7 | 归属键 `__shared__` vs `master`;认知状态 A 按会话 / B 全局一行;近轮窗口 A 内存 / B `conversation_log` | 行为等价,字面分叉;后两条是**有意设计不同** | 部分 |
| M8 | B 独有(不是缺口):置信度准入闸(0.55 拒收/0.75 隔离)、`graph_aliases`、`evidence` 列 | — | 增项 |

**M3 的产出端(v0.22.0 已补)**:A 的 `profile_update` 是**模型直接输出**的封闭两键
(`core_prompts`:`{"语言": "中文", "代词": "自称或被称呼方式"}`);B 原来只从 L0 候选
**派生** `language → 语言`,`代词` 在 B **没有任何产出端**。现在判官按 A 的原样输出
(`build_extract_schema` 的 `profile_update` + 提示词规则 + `normalize_extract` 白名单再筛),
并与派生路**合并** —— 顺序照 A(`profile_update.update(judge_profile)`,派生值覆盖模型)。
落地侧(白名单/上限/渲染)本来就是通的,所以这一格现在真能装东西了。

## 四、设计文档(`dsh_port/01–05`)要求但没做 ✗

| # | 要求 | 出处 | 状态 |
| --- | --- | --- | --- |
| D1 | **compaction 策展后端**(`extends BasicCompactionEngine` 只覆写 `summarize()`,`thresholdRatio 0.3`/`retainRatio 0.25`,策展块当摘要) | 03 §4/§5、04 §1/§4 | ✅ **v0.20.0 已补**(`lib/compaction.js` + Echo 预设;见下方第 6 条的宿主要点更正) |
| D2 | **`turn-stopping + steer`**:「想念该说没说」的硬保证 | 04 §1/§2 | ✅ **v0.19.0 已补**(`lib/turn-stopping.js` + 引擎 `longing.due_snapshot` + 设置 `longing.must_say`) |
| D3 | `shell.overlay` **Live2D 悬浮 Echo** | 04 §1、01 §4 | **没做** |
| D4 | `conversation.chat.node` **动作标签渲染** | 04 §1、01 §4 | **没做** |
| D5 | `typert Remote` + `typert events` 数据通道 | 04 §1、01 §2.6 | **没做**(改 webServer + SSE,属文档的"自有 HTTP 兜底"路径) |
| D6 | `tests/consistency_probe.py` 一致性探针(主动认领/记忆认领/别名) | 05 §4 | ✅ **v0.23.0**:三个探针跑在临时库上(证据链部分**离线可判定**),3/3 通;「回复半」用 `--reply` 贴她的真回复判否认/编造。`npm run probe` | **已补**(回复半待人跑) |
| D7 | `rightbar.session` 伴侣面板 / `systemPrompt.variable {{echo_demo}}` | 04 §1/§2 | **部分**(数据在设置页+网页审查台,位置不对;演示倍率改走 `longing.demo_rate`) |
| D8 | `soul_server.py` JSON-RPC over stdio + 崩溃重启 | 04 §1/§4 | **部分**(有 `python/worker.py` + `sidecar-client.js`,但是**熔断降级到 JS 基线**而非重启) |
| D9 | `/mem`、`/graph` 的会话内形态;`/master` | A `main.py:2213-2584` | 部分(工具+HTTP 替代;`/master` 因单用户消失) |
| D10 | 注入包装:设计文档要 `pre-step` 追加 3 条 notice | 01 §4、04 §4 | **有意修正**(改 `echo:snapshot` 系统提示词一节;`lib/turn-snapshot.js:3-25` 记录了原方案泄漏 62 条 57,105 字注入块,占上下文 75%)⇒ **不算遗漏** |

## 五、可观测性

| # | 项 | A | B | 判定 |
| --- | --- | --- | --- | --- |
| O1 | 审计黑匣子列 | 20 列 | 逐列同构(`lib/store.js:85-106`) | 等价 |
| O2 | 保留深度 | 默认 200 | 默认 **100**(`toggle.js:209` 有意缩减,理由 SSE 3s 轮询) | 部分 |
| O3 | `agent_state` 颗粒度 | 装整条 pipeline 自陈(含 `interrupted_tail`/judge 统计) | 只装状态 JSON | 部分 |
| O4 | 实时面 | 独立进程 :8420 HTTP + :8421 WS 全量推六面板 | 宿主 `webServer` 路由 + SSE 半推(只推 audit 信号)+ 10s 轮询;九区面板 | 部分 |
| O5 | **悬置话题面板** | A `:1674-1679` 独立面板 | ✅ **v0.22.0 已补**:`#th` 一区 + `renderThreads`(进 10s 轮询)+ 四态配色;判据仍在 `store.listThreads`,前端只渲染。装机后在活服务上验过(`GET /echo/index.html` 有 `#th`,`/api/echo/threads` 返回四桶)。README 与实现不再打架 | **已补** |
| O6 | 想念仪表进度条 | `renderLongingPanel` bar+阈值线 | `echo-bar/echo-bar-fill/echo-bar-mark` 同数学(×10 归一刻度) | 等价 |
| O7 | 漂移/主动行为进审计流 | `_write_action_audit` | `auditToolCall` + `tool_call` 词表更全 | 等价 |

## 六、开关与可配性

| 项 | A | B |
| --- | --- | --- |
| `agenda_enabled` | 有,可关 | ✅ **v0.22.0 已补**:`agenda.enabled`;设门位置照 A(`main.py:1818` 只在**取用**那一步 —— 登记照旧,关掉只是她不再主动提) |
| `reflection_importance_threshold` / `reflection_max_inputs` | 可配(30/50) | ✅ **v0.22.0 已补**:`reflection.{importance_threshold,max_inputs}`,随 `reflection_prompt` 帧下发;窗口下限 5 与 A 的 `max(5,cfg)` 一致;不带 config 时引擎默认,老行为不变 |
| `bubble_*` | 3 项 | 有(`bubble` 组);另有 A 没有的 `say_again` / `compaction` 两组 |

---

## 优先队列(我按这个顺序做,除非他改)

1. ~~**E1–E4 + E6 气泡层**~~ ✅ **v0.18.0 已补**(`lib/bubble.js` / `lib/interrupted.js` / `relay.js` / `store.js` / `turn-snapshot.js` / 适配器 / 配置面板)。
2. ~~**C1–C3 + C5 关怀组稿层**~~ ✅ **v0.18.1 已补**(`lib/proactive-ack.js` / `heartbeat.js` 话头行与 ack 落账 / `relay.js` 关怀闸 / `store.js` 两个读口)。
3. ~~**C4 ±120s 防重、C6 >2000 字绕过削减**~~ ✅ **v0.18.2 已补**(`python/engine/threads.py` 到期窗口 / `judge.py`+壳双侧开窗 / `index.js` 想念帧与捕获都不再有长度豁免)。
4. ~~**M3 画像层**:`core_traits` 写入 + 注入(语言/代词常驻)~~ ✅ **v0.18.3 已补**(`store.saveProfileTraits` / `getProfile` 读侧白名单 / `engine.js` 落库 / `context.js` 渲染);只剩 `代词` 的**产出端**(要动 Judge 的 outputSchema,单独一版)。
5. ~~**D2 turn-stopping + steer**:「想念该说没说」的硬保证~~ ✅ **v0.19.0 已补**。落点:`lib/turn-stopping.js`(挂点 + 词面判定 + 每轮至多一次 + 整体 try/catch)、引擎 `longing.due_snapshot`(阈值与 `should_care` **同源同数学**,含心境调制与 4.5 下限;`window` 只读不落账)、设置 `longing.must_say`(可关)、审计 `longing_steer`。**刻意偏离**:不套 cooldown/night_hold —— 那两条是「别打扰他」的闸,而此刻他就在跟她说话。**未覆盖**:她用工具(`echo_feeling`)表达情绪不算"说出口"(壳里没捕 `tool/call`);词面启发式对极隐晦的说法会漏(代价有界:多续一步)。
6. ~~**D1 compaction 策展后端**(03/04 的核心裁决)~~ ✅ **v0.20.0 已补**。落点:`lib/compaction.js`(`EchoCompactionEngine extends BasicCompactionEngine`,只覆写 `summarize(input, agent, signal)`;零额外 LLM 调用)、`lib/curation.js`(四段策展文本 + 预算硬裁)、`lib/soul-snapshot.js`(soul 库**只读**快照)、`lib/preset-patch.js` + `scripts/install-preset.mjs`(生成「Echo 陪伴模式」预设)。**宿主要点更正 03 号文档的两处猜测**:① 后端住在 **preset 平面**(web profile 自己把 `compaction-basic` 关了,dsh-web-app 原话 *"only the compaction backend that reads it moves"*),所以换法是**另立一份预设**,不是改 profile;② 钩子真实签名是 **3 个参数**(`input, agent, signal`),不是 §8 写的 5 个;③ §6.2 的猜测被代码证实 —— `frameSummary()` 由基类在钩子之后套。**刻意偏离**:不把出厂组合抄进仓库(现读现改,宿主升级后重跑;换写法就报 `stock-entry-not-found`);策展块不写想念/检索回响(压缩后每轮重算,写进去=双重记忆)。**未覆盖**:按模型策略分别配预算(`modelPolicies` 继承基类解析,预算只有一份)。
7. ~~**E5 say_again 情绪余波**~~ ✅ **v0.21.0 已补**;**M3 代词产出端** ✅ **v0.22.0 已补**(Judge 的 `profile_update` 封闭两键 + 与派生路按 A 的顺序合并)。
8. ~~**O5 悬置话题面板**;开关与可配性(agenda/reflection 阈值)~~ ✅ **v0.22.0 已补**(面板活服务上验过;两只旋钮随帧下发,引擎传 None = 原默认)。**顺带修掉**:`clampNum` 把 `null`/`true` 当 0 钳成下限的真坑;新增「README 项数 = 字段表项数」的闸。
9. ~~**D6 consistency_probe**~~ ✅ **v0.23.0 已补**(`python/tests/consistency_probe.py` + `npm run probe`)。**D3/D4/D5** 的口径见下节(不做)。
10. **到这里,对照 A 侧的功能面已经逐项收口**(剩下的都在下节"明确不做/等价"里,或 backlog 里)。下一版该做的是他跑 live 单后按观察结果修 —— 没有别的待办能靠读代码推出来了。

---

## 明确不做 / 等价的口径(答辩就这么答)

这一节存在的理由:审计里每一行都得有**结论**,不能挂着"待定" —— 挂着待定的,
他下次问起来我就又得现编。以下每一条都说清「不做/等价 + 为什么 + 代价是什么」。

### 不做(有意的,答辩正面答)

| 项 | A 侧是什么 | B 侧为什么不照做 | 答辩口径 | 代价 |
| --- | --- | --- | --- | --- |
| **D3 Live2D 立绘/悬浮窗** | AstrBot 平台侧立绘插件,靠平台渲染层 | DSH 的呈现层是**宿主**的(GUI 是它的),插件往里塞渲染会跨过壳的边界,而且每个平台都得重写一遍 | 「表现层留给宿主:她换平台还是同一个人 —— 记忆、人格、想念曲线都在插件里。立绘是壳的事,不是她的事。」 | 目前 DSH 里没有立绘(视觉少一层) |
| **D4 动作标签(`<action>…</action>`)** | 文本里插动作给前端播 | ① DSH 侧没有动作渲染端,标签会原样出现在聊天里 = 掉分;② 它属于"平台表现协议",不是人格内核 | 「动作标签跟渲染端成对出现;没有渲染端时插标签只会让文本变脏。这层协议在宿主手里。」 | 她的"动作"只在文字里(语气词/标点/分条) |
| **D5 typert 打字状态通道** | AstrBot 平台的 typing 事件通道 | DSH 侧对应的"在打字"信号由 **bubble 分条 + 出站节奏**承担(已经做了,而且更接近人);另开一条平台通道等于把两条节奏源放进同一个房间 | 「'在打字'这个信号我们用**气泡节奏**表达(E1–E4),那是比平台 typing 事件更细的表达;多一路信号会让节奏互相打架。」 | 宿主 UI 的"正在输入"指示不由我们驱动 |

### 等价(名字/位置不同,功能在)

| 项 | A 侧 | B 侧的等价物 |
| --- | --- | --- |
| **M4 记忆体检** | `memory_doctor` 脚本 + 面板 | `scripts/memory-doctor.mjs` + 网页「记忆体检」区(**v0.18.x 起就在**) |
| **M5 图谱合并** | 合并脚本 + `graph_aliases` | `scripts/graph-merge.mjs` 写同一张 `graph_aliases` 表;引擎 `graph.get_or_create_node` 每次取节点先过别名表(`python/engine/graph.py:104`)—— **写入自动接地**,合并结果不会被下一轮重新长出来 |
| **M7 手动遗忘** | `/mem_forget` 命令 | 工具 `echo_forget`(读侧 `reinforce=False`,查到要忘的事**不强化**它)+ `/api/echo/forget` |
| **O2 审计保留条数** | 默认 **200**(`_conf_schema.json`,可配) | 默认 **100**(`auditKeep` 可调)。**这是有意的差**:本仓留得**少**一半 —— 审计是排障面,100 条足够回看最近几轮,库别无限长;`tests/toggle.test.js:183` 把这条决定钉在用例里(`// A 是 200;本仓定案 100`)。**注:本行 v0.23.0 版曾把两侧写反(说 A 100 / B 200,理由也反了),2026-09-26 全仓审查时按两侧源码更正。** |
| **O3 关系/亲密度面板** | 独立面板 | 「记忆体检 + 想念曲线 + 她的日记」三处合起来看(`/echo/` 里),没有单独一栏 —— 单开一栏会把同一批数字画两遍 |

### 明确未证(不许说"已验证")

- **D2 想念转舵**:`longing.value=0.025`、`kicked=0` —— 阈值远没到,**没触发过**。
  判据已改成硬的(`SELECT COUNT(*) … tool_call='longing_steer'` 0 → ≥1),等他跑 live 单。
- **D1 策展压缩**:后端已被宿主加载(日志有据),但**默认预设下不生效** ——
  要他**选一次「Echo 陪伴模式」预设**才会走到。那 242 条老检查点也不会被重写。
- **悬置话题的到点提醒**:库里 11 条**全不带时间**,解析器实测正常 ⇒ 还差一句带时间的约定才能判。
- **E5 情绪余波**:只证了"闸关着时一行不发";开闸那一半等一个真情绪轮。
- **一致性探针的"回复半"**:离线半(证据链)3/3 已跑通;**她认账与否要贴真回复**才算走完。

## 审计纪律(这次学到的)

- 对账必须**逐项落到 `文件:行`**,不能靠"我记得移过了"。
- A 侧的表里「与平台强耦合=是」**不等于**"不用做" —— E1–E4 就是这么被挂掉的。
- 移植完成前不许说"已完整复刻";每次只报**这次动了哪几行 + 电池结果**。
- **"待定"也是一种结论,但不能挂着** —— 要么做、要么写清不做的理由与代价(本文件上一节)。
