# 一次性落地总计划 —— 把参考资料里还没搬的全部搬完

> 2026-09-28 夜。**本文件只出计划，不动代码**（他的裁定：「准备全部plan，等会一次性全部落地」）。
> 执行方式：**按批推进，一批一提交、一批一跑门**；批与批之间可停、可单独回滚。
> 范围来源：`docs/REFERENCE_ANALYSIS.md`（21 项全分析）§9.3 可借鉴清单 + §1.5 宿主漏用扩展点
> + `docs/PLAN_CORTICO_ADOPTION.md` 的 P3/P4。

---

## 零、这份计划管什么

**已经落地的（不在本计划内）**：契约版本+能力探测（P1）、纪律三件套（reason 枚举／否定必留痕／豁免带理由）、
心跳退避 + 关怀账 + 她自己的闹钟（P2）、候选箱隔离与晋升（`lib/store.js:531`）、三态降级链、审计黑匣子（27 种 tool_call）。

**明确不做的（§9.4，9 条）**：EA-master 的 BiLSTM/CNN、cnsenti 的 7 类计数当锚点、giftia 的 `S×24+1` 遗忘式与
「分层」、Mio 的随机静默窗与单体形态、Neuro-master 的整段取消、aura 的假 interruption 代价、人格写死常量。

**本计划覆盖 8 批 47 条**（A 地基 4 · B 观测 5 · C 更像人 5 · D 记得更准 5 · E 面板 6 · F 外部与自愈 4 ·
G 小修 5 · H 他的主线 2 大条含 7 小项）。

**三条追加纪律（在 `docs/DISCIPLINE.md` 五条之上）**：
1. **每个特性一个开关**，默认值在本计划里写死；账本类（"失败必须可见"的地板）**不设开关**。
2. **每批都能单独回滚**：一批一提交，回滚 = 关开关或 revert 那一个提交，不牵连别的批。
3. **"改完" ≠ "在跑"**（这项目最贵的教训）：每批都带一个**真机探针**写进 `scripts/accept-*.mjs`，
   探针不全绿就不算落地。探针一律**只读**。

**现状基线（2026-09-28 下午实测）**：主仓 716/716、`check` 0（含 `check:tools`）、`hygiene` 0；
新仓 112/112、体检 12 项正常；`accept:p2` 16 条全绿。

---

## 一、批次总表

| 批 | 名字 | 条 | 依赖 | 风险 | 主要开关 | 真机探针 | 量 |
|---|---|---|---|---|---|---|---|
| **A** | 注入位置工程（地基） | 4 | — | **高**（动上下文结构） | `injectAtTail`（默认 **off**→灰度） | `accept-inject.mjs`：真实会话里数注入块重复数 | 大 |
| **B** | 观测与黑匣子 | 5（B4/B5 待探测，可能不成立） | A0 | 低 | `auditAllTools`（默认 on） | `accept-observe.mjs`：审计流里出现非自家工具 | 中 |
| **C** | 更像人（单轮闭环/插话） | 5 | B1 | 中 | `emotionSameTurn`（默认 on） | `accept-emotion.mjs`：同轮情绪生效率 | 中 |
| **D** | 记得更准（检索） | 5 | — | **高**（动检索排序） | `retrievalFusion`（默认 **off**） | `accept-retrieval.mjs`：黄金集对照 | 大 |
| **E** | 面板与可视化 | 6 | — | 低 | `sidebarTab`（默认 on） | 手工 + 离线 DOM 断言（挂点已在装机包核到） | 中 |
| **F** | 外部唤醒与自愈 | 4 | A | 低 | `externalWake`（默认 off） | `accept-wake.mjs`（已有雏形） | 中 |
| **G** | 小修与收尾（可夹带） | 5 | — | 低 | 各自 3~5 行 | 单元测试即可 | 小 |
| **H** | 他的两条主线（P3/P4） | 2 大 | E | 中 | 见 `PLAN_CORTICO_ADOPTION` | 他拍板后定 | 大 |

---

## 一之二、落地进度总账（每批一提交，照实记）

| 批次 | 状态 | 提交 | 门（主仓 test / check / hygiene） | 探针 |
|---|---|---|---|---|
| A0 兼容闸 | ✅ v0.32.0 | `c38d055` | 727 / 0 / 0 | `accept:inject`（重启前如实报"字段不在"） |
| A1a 注入探针 | ✅ v0.32.0 | `c38d055` | 同上 | 同上 |
| A1b 尾部注入 | ⏳ 等重启（先读基线份数） | — | — | `accept:inject` |
| A2 字节稳定 + A3 variable() | ⏳ | — | — | `accept:inject` |
| **G1 退避不吃到点的事** | ✅ v0.32.0 | `0a37112` | 729 / 0 / 0 | 单测两条（闹钟 + 约定提醒在退避窗口里照样准点） |
| **B1 全量工具审计** | ✅ v0.33.0 | `98ee0dd` | 741 / 0 / 0 | `accept:observe`（重启前 2 条 FAIL，如实） |
| **B5 干活时不插话** | ✅ v0.34.0 | `971777e` | 743 / 0 / 0 | 单测三条（挡住 shouldCare / 闹钟仍响 / 关开关放行） |
| **B3 轮内不变快照** | ✅ v0.35.0 | （本提交） | 748 / 0 / 0 | `tests/turn-snapshot.test.js` +5 条 |
| **B4 反思留痕** | ✅ v0.35.0 | （本提交） | 748 / 0 / 0 | `accept:observe` 加 B4 两问 |
| **B2 trace 结构化** | ✅ v0.36.0 | `58f36a6` | 756 / 0 / 0 | `accept:observe` 加"trace 挂多行"一问 |
| **G2 旧称呼不重贴 + G3 降级要说话** | ✅ v0.37.0 | `fab705d` | 766 / 0 / 0 | 单测 10 条（改写只动记忆 / 两种降级 / 引擎好时不多话） |
| **BOM 闸 + python DDL 齐平** | ✅ v0.37.0 | `fab705d` | 766 / 0 / 0 | `check-bom.mjs`（上线即抓到一处旧 BOM）；`test:py` 305 OK 转绿 |
| **F1 外部事件入口** | ✅ v0.38.0 | `a9ec75b` | 784 / 0 / 0 | `accept-wake.mjs`（默认只读；`--post` 才真敲门） |
| **F2 日记缺口补写 + 退避** | ✅ v0.38.0 | `a9ec75b` | 784 / 0 / 0 | 单测 9 条（漏拍能补 / 一拍拍一页 / 连败退避封顶） |
| **F3 preset 标记 + 手改保护** | ✅ v0.39.0 | `d424f1b` | 792 / 0 / 0 | 单测 8 条 + 真机演练（手改⇒停、--force⇒先备份） |
| **C5 开口前过期失效检查** | ✅ v0.39.0 | `5e4c5a9` | 801 / 0 / 0 | 单测 9 条（两条判据分开 / 坏阈值回落 / 不知道≠过期） |
| ↳ **C5 事故与门**:搬代码搬出 fatal load failure | ✅ 已修 | `5e4c5a9` | 801 / 0 / 0 | 见 CHANGELOG:注释收尾被搬走 ⇒ 函数体被注释;`npm test` 挂住 ⇒ `--test-force-exit` |
| **真机读数(2026-09-28 夜,宿主已重启到 v0.39.0)** | 🔶 已加载 | — | — | `accept:inject` 探针在位但 `readings=0`(重启后陪伴会话还没人来过话);`accept:observe` **exit 0**(钩子在跳、trace_id 列在,欠"一轮多行"样本);`accept:wake` **exit 0**(externalWake 关着=设计,staleHours=24 在读) |
| **A1b · A2 · A3**(注入位置工程余下三步) | ⏳ **等一次真对话** | — | — | 要先有 A1a 的基线读数才敢动(09-26 那场 62 份重复块的教训) |
| **F4 插入优先级四档** | ⏳（与 C 批同做） | — | — | 单测：Speaking 状态下四档行为 |
| C1–C4 · D 检索（5）· E 面板（6）· H 主线（2） | ⏳ | — | — | — |

> 两次重启窗口不变：**A+B+G** 一个窗口、**D+F+E** 一个窗口（见 §九）。
> 需要他重启或拍板时**停下来报告**，不擅自重启。

---

## 二、A 批：注入位置工程（地基，必须先做）

> 为什么排第一：**它决定后面所有注入物落在哪儿**。B/C/D 都会往上下文里加东西，
> 位置不定就先别加。也是 §9.3 里唯一"四家独立选了同一条路"的条目（★★★#1/#2）。

> **落地进度（2026-09-28 夜，v0.32.0）**：**A0 ✅ + A1a ✅** 已提交（`lib/compat.js`、
> `lib/inject-probe.js`、`scripts/accept-inject.mjs`、`tests/inject-probe.test.js` 11 条；
> 门：727/727 · check 0（含 `check:tools`）· hygiene 0）。状态面新增 `compat` 与 `inject`
> 两个字段（schema 同步声明 —— P2 那条教训）；重启前的探针基线 = 两个字段都不在
> ⇒「新代码还没被宿主加载」，正是它该报的样子。**A1b / A2 / A3 待做**（A1b 必须在
> 重启后先看 `inject` 的基线份数再搬）。

### A0 兼容闸（安全网，**先于一切**）
- **出处**：roleplay `dsh-compat.ts`（★★#25）。
- **抄什么**：动手前先**探测符号**：`ctx.systemPrompt.context`、`ctx.tools.on?('post-execute')`、
  slot 名是否存在；不存在就退回今天的行为（`section`），并把"退回了"写进审计。
- **改哪里**：新 `lib/compat.js`（探测 + 缓存结果 + 一行日志）；`lib/index.js` 的所有 `ctx.effect` 注册点先过它。
- **验收**：单测喂一个"没有 `context()` 的假 ctx" ⇒ 不抛、退回 `section`。
- **风险**：无（纯增）。**量**：小。

### A1 `systemPrompt.context()` —— 动态快照搬到消息尾部（★★★#1）
- **出处**：roleplay `agent.ts:199-250` / maid `index.mjs:406-474` / auto-memory `index.js:8774` /
  pad-emotion `index.js:816`；宿主 `docs/subsystems/system-prompt.zh.md:79-88`（`PromptContext`，
  "Dynamic model context materialized as a **durable user-role snapshot**"）。
- **现状（我们的）**：`lib/index.js:1366` 的 `system-prompt/assemble` 瀑布里
  `target.sections.push(turnSnapshot.sectionOf(...))`（`:1380`/`:1385`），`order: 10260`
  （`lib/turn-snapshot.js:42/48/186`）——**全压在系统提示层**，且**系统提示每轮变 ⇒ 前缀缓存每轮失效**
  （代价他 2026-09-26 认过，`lib/index.js:1351`）。
- **⚠️ 已知地雷（必须先看）**：`lib/index.js:1340-1346` 记着上一版做法（pre-step 里 append 一条 user 消息）
  的现场：**62 条重复的「[她此刻的状态]」、57,105 字、占上下文 75%** —— 因为 surface append **永不消失**。
  `context()` 是 user-role **durable snapshot**，语义上更接近后者而不是前者 ⇒
  **它到底是"替换"还是"累积"，必须先用探针量，不能靠文档推断。**
- **所以 A1 分两步（本计划的核心安全设计）**：
  1. **A1a 探针先行**：不改产品代码，写 `scripts/accept-inject.mjs` —— 开一段真实会话，逐轮统计
     派生历史里我们注入块的**份数**与**字节占比**（今天 = 1 份 / 系统提示内）。数字留档。
  2. **A1b 灰度搬**：开关 `injectAtTail`（默认 **off**）。开 = 快照改走 `context({name:'echo:snapshot',
     order: 9000})`；**只搬「此刻状态 + 悬停话题 + 想念行」**，记忆块（`renderMemories`）留在
     `section` 不动（它才是缓存杀手）。开完再跑 A1a 探针 ⇒ 份数必须仍是 1。
- **兜底**：若探针显示份数 > 1，则加**去重器**（`lib/compaction.js` 里按标记只留最新一份），
  仍不成立就**整体退回**（关开关），并把结论写进 `REFERENCE_ANALYSIS` 的"未核实项"。
- **改哪里**：`lib/index.js:1366-1388`（注册点 + `target.contexts`）、`lib/turn-snapshot.js:186`
  （`sectionOf` → 加 `contextOf`，两者并存以便回滚）、新开关落 `lib/settings-fields.js`。
- **验收**：探针份数 = 1、字节占比不高于今天、`npm test` 全绿、她连续 3 轮不回退到"复述注入块"。
- **风险**：中高（上下文结构）+ 可回滚（开关）。**量**：大。

### A2 系统提示字节稳定（★★★#2）
- **出处**：maid `index.mjs:350-353`。
- **抄什么**：`echo:persona`(10245) / `echo:rules`(10275) / `echo:relay`(10240) 三段**只随
  「会话 + 渠道集合 + 开关」变**，不随轮次变；A1b 生效后"每轮都变"的东西已不在系统提示里。
- **验收**：探针连跑 5 轮，三段的**哈希**除首轮外不变（今天 `echo:relay` 已字节稳定，persona/rules 本就静态）。
- **风险**：低。**量**：小（主要是证明，而不是改）。

### A3 `systemPrompt.variable()` 人格变量化（★）
- **出处**：宿主 §1.5 表；roleplay 的变量用法。
- **抄什么**：人格段改成 `{{echo_persona}}`，开关/换装后**下一模型步骤即生效**（比现在 `text:` 返回 `''` 干净）。
- **⚠️ 陷阱**：`variable` 是**严格模式，未定义即抛** ⇒ 必须 `try` 包住供应器并给空串兜底，
  否则一次注册失败会打死整轮（这是"人格不陪葬"的反例）。
- **改哪里**：`lib/index.js:1195/1221`（两段）、`lib/persona.js`（供应器）。
- **验收**：单测 —— 供应器抛错时整轮仍能组装（有 `section` 兜底）。
- **风险**：低（有兜底）。**量**：小。

---

## 三、B 批：观测与黑匣子

### B1 全量工具审计（★★#8、§1.5）★★★ ✅（2026-09-28 夜，v0.33.0）
- **出处**：宿主 `docs/subsystems/tools.zh.md:388`：`tools/pre-execute` 监听 `(exec, next) → PreToolDecision`、
  `tools/post-execute` 监听 `(exec, result, next) → PostToolDecision`；真在跑的消费者
  `dsh-hooks-claude-code/lib/index.js:265`。
- **落地**：`lib/tool-audit.js`（只观察、一律 `next()` 原样交回；截断 + 原始长度；四档 skip 计数；
  写库失败计数不静默）；状态面 `toolAudit`；探针 `npm run accept:observe`（只读）。
- **验收**：✅ 单测 12 条；探针在重启前如实报「字段不在 + 没有 `(工具)` 行」（重启后应变绿）。
- **顺手抓到**：探针第一版拿"不以 `echo_` 开头"当判据是**假阳性**（自家内部标签也不带前缀），
  已改成认 B1 独有的 `user_input LIKE '(工具)%'` 签名 —— 教训写在脚本原地。

### B2 trace 结构化（★★#11）—— ✅（2026-09-28 夜，v0.36.0）
- **落地口径**：一轮（一次「他开口」）一个 `trace_id`（`lib/turn-trace.js`，TTL 30 分钟兜底），
  本轮的工具行（`lib/tool-audit.js` 的 `traceOf`）与她回复那一行（`index.js → engine.reflect
  → commitExtract` 传 `traceId`）**共用它** ⇒ 一行 SQL 把整轮拉出来。
- **`duration_ms`**：用宿主**已有的** `latency` 列，靠 `tools/pre-execute`/`post-execute` 配对量
  （拿不到 = null，不编）。
- **`parent_id` 没加**（诚实记）：turn 内共用同一个 trace 已经表达了父子关系，
  单开一列要动活库的 `ALTER TABLE` —— 等真有"子代理各自独立 trace"的需求再加，别为凑条目动库。
- **出处**：Cyrene-main `harness-trace`。
- **抄什么**：审计行补 `trace_id` / `parent_id` / `duration_ms`，父子关联（P2 的 `care_beats.trace_id` 已有先例，
  这次推到全部审计）；保留期靠现有 `auditKeep`。
- **改哪里**：`lib/store.js` 的 `audit_*` 表加列（迁移）+ `lib/events.js`。
- **验收**：一条轮次内 3 个工具调用共享同一 `trace_id` 且 `parent_id` 正确。
- **风险**：低。**量**：中。

### B3 一轮内不可变运行快照（★★#10）—— ✅（2026-09-28 夜，v0.35.0）
- **落地口径（比原计划更省也更准）**：原计划说"冻结工具目录/人格资产/设置" ——
  实测那些本来就是每轮读一次的快照。**真正在漂的是记忆/心情那份 `compose()`**：
  宿主每一步组装一次，它就再检索一次 ⇒ 同一轮里她读到的"此刻状态"前后不一。
  所以 B3 = 按 `(会话, 查询词)` 钉住 compose，**claim 即失效**。
- **出处**：Cyrene-main `RunToolCatalog`。
- **抄什么**：一轮（一次 pre-step→turn/end）内，**工具目录、人格资产、设置**冻结 ——
  中途改配置不改变已开跑的这一轮（今天 `personaCache` 有缓存但语义没写死）。
- **改哪里**：`lib/turn-snapshot.js`（冻结点显式化）、`lib/persona.js`。
- **验收**：单测 —— 一轮中途改设置，这一轮读到的仍是旧值，下一轮才是新值。
- **风险**：低。**量**：小。

### B4 子代理留痕（★★）—— ✅ 改成自己调用点留痕（2026-09-28 夜，v0.35.0）
- **出处**：宿主 `subagent/start|end`。
- **装机包实测（2026-09-28）**：这两个名字**只出现在 `dsh-hooks-claude-code` 这座桥的 `lib/index.js:309/322`**，
  在 `@deepseek-ai/dsh-agent` 里**没有** ⇒ **不能假定插件 ctx 上能监听**。
- **处置（不写永远不会响的死代码）**：改为**在我们自己的子代理调用点留痕** ——
  `runReflection(subagents, …)`（`lib/index.js` 反思那一段）补耗时/成败字段到审计行。
  **不为凑条目造一次子代理调用**。**量**：小。

### B5 goal 期心跳降频（★★）—— ✅ 改成数据驱动（2026-09-28 夜，v0.34.0）
- **出处**：宿主 `goal/activation-changed`。
- **装机包实测**：该名字在 `@deepseek-ai/dsh-api-remotes/lib/types/remote-events.d.ts:40` ——
  **是"远端事件"类型**，不是插件 `ctx.on` 的本地事件 ⇒ 不靠它。
- **落地（把意图做出来，而不是把死接口写上）**：心跳新增 ⓪-a「干活闸」——
  判据是**我们自己的审计表**（`store.recentToolCallAt(sid, 5 分钟)`；B1 之后自家与宿主的工具调用都在里面）：
  他最近有工具在跑 ⇒ 这一拍**不插话**，落一行 `care_beats.reason='working'`（与 `backoff` 分开：
  一个"他在忙"、一个"没人在变"），`care-report.js` 文案表同步。
- **位置**：与退避同在 ⓪、**在 ①（提醒）与 ①b（她的闹钟）之后** —— 干活闸压不到"到点的事"。
- **开关**：`quietWhileWorking`（默认 **on**）。**验收**：✅ 单测两条（干活闸挡住引擎的 shouldCare；
  她的闹钟在干活期间照样响；关掉开关 ⇒ 照常开口）。
  > ⚠️ **2026-09-29 已整条退役**（他裁定：「我觉得我在干活就不说话，这个闸可以删掉」）。
  > 理由：它的判据读的是"**这一拍抽到的那条会话**有没有在跑工具"，于是她开不开口取决于会话竞速；
  > 连设置项一起删（调参 70 项）。数据源 `store.recentToolCallAt` 保留。
  > 现场与处置见 `docs/CARE_DIAG_2026-09-29.md`。
- **关键**：这条**必须落进 P2 的账本**（`care_beats.reason='goal-focus'`）+ `care-report.js` 文案表，
  否则"为什么没开口"就又变回看不见 —— 复用 P2 的地板，正是它的价值。
- **验收**：`tests/care-beats.test.js` 加一例（goal 期每拍留 `goal-focus` 行且不投递）。
- **风险**：低。**量**：小。

---

## 四、C 批：更像人（单轮闭环与插话）

### C1 情绪单轮闭环 + 超时旋钮（★★★#3）★★★
- **出处**：pad-emotion `index.js:833-846`（异步 waterfall + `Promise.race`）。
- **抄什么**：他这句话惹到她 ⇒ **这一轮回复就带情绪**；打分与组装**并发**，超时（默认 **800ms**）就用
  上一轮旧向量，打分稍后照写库（"慢比错好，错比没有好"）。
- **改哪里**：`lib/emotion.js`（现 175 行，轮末快照）、`lib/index.js` 的 `agent/pre-step`（`:1389`）、
  `lib/engine.js`（`writeEmotion` 路径）。
- **开关**：`emotionSameTurn`（默认 **on**）+ `emotionScoreTimeoutMs`（默认 800）。
- **验收**：`accept-emotion.mjs`：同轮情绪生效率（今天 ≈0%，目标 > 80% 且**超时率** < 5%）。
- **风险**：中 —— 她可能"更冲"，且**每轮多一次引擎往返**（延迟）。**量**：中。

### C2 思考风格双档（★★★#9）
- **出处**：cosplay `store.js:142-145`。
- **抄什么**："干活时中立思考"一档（工具密集/长任务轮），其余保持角色化。
- **⚠️ 他的红线**：他抱怨过"演"和"怪"（`lib/index.js:1244-1250` 有现场）。
  ⇒ 默认**只在"这一轮有工具调用/长任务"时**切中立档，不做全局风格改造。
- **验收**：单测（判档函数）+ 抽样 20 轮看她 reasoning 里"像 Echo 吗/自检"提及率**不升**（今天 25% 那个坑）。
- **量**：小。

### C3 防抢话/防重复/禁词清单（★★#20）
- **出处**：roleplay `prompts.ts:52-110`。
- **抄什么**：**可配置清单**（不硬编码）：禁词、重复话术、抢话时机的排除规则。
- **改哪里**：`lib/inbound-filter.js`（现 209 行，已有一层拒收逻辑）+ `lib/relay.js` 出站前检查。
- **验收**：单测；`check_tools.mjs` 加"踩禁词"用例（返回人话原因，不静默丢）。
- **风险**：中 —— 清单太严会**把她的个性一起过滤掉**，故清单进 `settings`（他能改）。**量**：中。

### C4 话题去重惩罚（★★#16）
- **出处**：Mio `:379-432`。
- **抄什么**：检索/开口前对"刚说过的话题"加惩罚，别复读。
- **改哪里**：`lib/thread-dedupe.js`（现 57 行）+ 与 D1 的排序解耦**同一处**改（一次改两用）。
- **验收**：单测（同一话题连续两拍，第二拍分下降）。**量**：小。

### C5 开口前过期失效检查（★★#15）
- **出处**：Mio `proactive_service.py:588-592`。
- **抄什么**：开口前检查 payload 是否已过期/已被解决（例：提醒的约定他已提前说过 ⇒ 别再说）。
- **关键**：每次"因过期作废"也**落账**（`care_beats.reason='stale-drop'`）+ 文案表。
- **改哪里**：`lib/heartbeat.js`（wake/reminder 分支）、`lib/care-report.js`。
- **验收**：单测 + 账上真出现 `stale-drop`。**量**：小。

---

## 五、D 批：记得更准（检索）

### D1 两段解耦：RRF 三臂排序 + 绝对阈值 + 滞回（★★★#8、★★#9）
- **出处**：auto-memory `recall-fusion.js:10-12`（"RRF 分只排序，是否注入用绝对分比阈值"）。
- **现状**：`lib/retrieve.js:82 rankMemories()`，权重写死 `W_REL=1.0 / W_REC=0.15 / W_EMO=0.02`
  （`:38-40`），`CANDIDATE_LIMIT=500`（`:34`），六档关键词（`lexical.js` 238 行）。
- **抄什么**：① 排序 = 三臂 RRF（词法/向量/情绪）**只决定顺序**；② **是否注入**用绝对分比阈值；
  ③ **滞回**（进去容易出来难，防抖动）。研究已做完：`docs/RETRIEVAL_RESEARCH.md` + `RETRIEVAL_PLAN.md`。
- **开关**：`retrievalFusion`（默认 **off**，灰度：先在他自己的会话上开，黄金集对不上就关）。
- **验收**：`accept-retrieval.mjs` 跑既有黄金集（`scripts/` 里那套 + `tests/fixtures`），
  报 **P@k / 注入条数 / 重复率** 三项对照；**对不上就不许开**。
- **风险**：**高**（检索一差就是"她记不住事"）。**量**：大。

### D2 CrossEncoder 可选精排（★★#17）
- **出处**：my-neuro `search_utils.py:481-508`。
- **抄什么**：默认**关**、缺失回退；只在候选 > N 时才加载模型。
- **诚实标注**：这动**Python 侧车**（`python/worker.py`），不是 JS 仓 —— 谁维护要他说一句。**量**：中。

### D3 画像候选池跨天证据晋升（★★#18）
- **出处**：my-neuro `user-profile/index.js:374-396`。
- **抄什么**：新画像项要**跨天多次证据**才晋升为长期画像（防一句玩笑变成"她眼里的他"）。
- **改哪里**：`lib/store.js` 新表 `profile_candidates(first_seen,last_seen,evidence,state)`。
- **验收**：单测（同日 3 次证据不晋升；跨 2 天 2 次晋升）。**量**：中。

### D4 时间三分注记（★★★#6）
- **出处**：Mio `memory_service.py:344-352`。
- **抄什么**：记忆渲染时标"**发生 / 得知 / 记录维护**"三种时间语义，治"把旧事当新事"。
- **数据可行性**：`lib/soul-snapshot.js:36-47` 已证真列名是 `timestamp / occurred_at / learned_at`
  （这张"列名写错"的坑我们踩过）⇒ 数据在，**纯渲染层活**。
- **改哪里**：`lib/context.js`（渲染）；`candidate`：只对"他讲他自己的事"的行标注。
- **验收**：单测（同一行三种时间分别渲染）。**量**：小。

### D5 `ephemeral_context`：大块状态不进长期记忆（★★#13）
- **出处**：neuro-sdk `SPECIFICATION.md:159`。
- **抄什么**：注入块打 `ephemeral` 标记，反思/压缩时**跳过**（别把"她此刻的状态"记成回忆）。
- **改哪里**：`lib/reflect.js`（354 行）、`lib/compaction.js`、`lib/turn-snapshot.js`。
- **验收**：单测（注入块不进反思候选）+ 真库抽样（反思产出里无注入块原句）。**量**：中。

---

## 六、E 批：面板与可视化

### E1 侧栏原生标签页（★★★#10）★★★
- **出处**：宿主 `slots.zh.md:113-120`（sidebar 树）、§1.5 表。
- **装机包实测（2026-09-28）—— 有现成样板可抄**：
  `@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/types/client/index.d.ts:5-8` 原文：
  体走 `ctx.sidebarRightTabs`（插件侧 API），座位是 **`sidebar.right.pane.tab`**、
  标题走 **`sidebar.right.pane.tab.title`**，子座位 `sidebar.right.tab.document`
  （`TextPreview.d.ts:16`）。⇒ **不是照文档猜，是照一个真在跑的插件抄。**
- **抄什么**：把 `/echo` 仪表盘做成右侧栏标签页（现在是独立网页，他自己说过"太丑了，也不方便"）。
- **改哪里**：`package.json` 的 `dsh.client` + 新 `web/panel.js`（`ctx.sidebarRightTabs`）；
  **保留**独立网页入口（两条路都在）。
- **验收**：GUI 里肉眼可见 + 离线 DOM 断言（`__internals`）。**风险**：低（纯 UI）。**量**：中。

### E2 三维情绪可视化 + `__internals` 离线断言（★★★#11）
- **出处**：pad-emotion `client.js:113-697`。
- **抄什么**：7 维退化渲染成"3 主轴立方体 + 4 维雷达"；"真的画出来了"用离线断言钉住（不靠肉眼）。
- **改哪里**：`web/graph.html` 已有 d3（`web/d3.v7.min.js`）⇒ 只加一块渲染。
- **风险**：低。**量**：中。

### E3 派生字段现算不存 + UI 词与模型词同源（★★★#12）
- **出处**：pad-emotion `state.js:63-71` / `describe.js:1-11`。
- **抄什么**：面板措辞与引擎措辞**同源**（一张表两处用）—— 我们刚在 `care-report.js` 做过一遍同款
  （`REASON_TEXT` + 枚举闭环测试），把这条**推广**到情绪档位/记忆档位/档位名。
- **改哪里**：`lib/settings-fields.js` 已有"字段表只有一份"的先例，照它办。
- **验收**：源扫描测试（枚举 ↔ 文案表闭环，`tests/care-report.test.js` 已有范式）。**量**：小。

### E4~E6（★/★★，可夹带）—— 挂点已在装机包里逐个核到
- `conversation.chat.turnTail` 状态徽章（★）—— 核到：`dsh-client-ui-chat/lib/types/client/chat/TurnTailNodeView.d.ts:3`；
- `conversation.input.dock`「让她主动说一句」按钮（★★）—— 核到：`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:187`
  （同族还有 `.left/.right/.overlay` 与 `conversation.composer.dock`）；调 heartbeat 的 force-once，
  **不写库、当场只响一次**；
- `settings.plugins.tab` 独立设置页（★★）—— 核到：`dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:80`；
- `shell.overlay` 全局悬浮（★）—— 核到：`dsh-client-ui-layout/lib/types/client/AppFrame.d.ts:4`（别做成常驻噪音）。

---

## 七、F 批：外部唤醒与自愈

### F1 传感器/webhook 外部事件入口（★★#19）· ✅ 已落地 v0.38.0（`a9ec75b`）
- **落地**：`lib/external-event.js`（纯解析：时间三写法/过去即现在/认不出就拒收/文本截断留痕）
  + `POST /api/echo/event`（写闸同款 + `externalWake` 默认关，关着 403）+ 审计 `event_in`。
- **只排 wake**：`store.wakeAdd({at,note,why:'外部事件:<kind>',sessionId})` ——
  投递/夜闸/留账全走 P2 那条老路，**没有第二条投递链**（这是本条最要紧的纪律）。
- **探针**：`scripts/accept-wake.mjs`（只读问门与账；`--post` 端到端）。

- **出处**：aura-scheduler `sensors.ts`。
- **抄什么**：外部事件（**将来语音平台的"他到家了"/视觉事件**）能唤起她 —— 这正是"主体是语音平台、
  QQ 只是工具"那条主线的接口。
- **关键**：**复用 P2 已经建好的手**（`echo_wakes` + 心跳投递路径），外部事件只负责**排一个到点的事件**，
  不新开第二条投递链（否则又长出"看不见的失败"）。
- **改哪里**：新 `POST /api/echo/event`（回环 + `x-echo-edit` 头，与现有写口同一道闸）+ `lib/wake-tools.js` 复用。
- **开关**：`externalWake`（默认 **off**）。**验收**：`accept-wake.mjs` 造一个事件 ⇒ 账上有 `wake-sent`。**量**：中。

### F2 日记缺口补写 + 指数退避（★★#23）· ✅ 已落地 v0.38.0（`a9ec75b`）
- **落地**：`missingDiaryDates` / `diaryRetryMs` / `planDiaryTick`（纯判据，离线可测）
  + 拍子执行（一拍拍一页、最早在前、一天最多补 7 页）+ `(日记补写)` / `diary_fail` 两种留账。

- **出处**：Mio `daily_diary_service.py:150-158`。
- **抄什么**：22:30 那拍错过了（她没起/引擎不在）**要补写**，退避重试；补写结果要落账。
- **改哪里**：`lib/diary.js`（131 行）+ `lib/index.js` 日记定时器。
- **验收**：单测（跳过一拍后能补上；连败走退避）。**量**：小。

### F3 preset 文件 + `generated-by` 标记（★★#24）· ✅ 已落地 v0.39.0
- **落地**：`lib/preset-patch.js` 新增 `generatedByLine` / `fingerprintOf` / `checkUpgrade` /
  `makeManifest`（纯函数，sha256 用真 `node:crypto`）+ 安装脚本写 `.echo-generated.json`
  并在升级前**先看清单**：指纹对不上 ⇒ **停下来报出哪几个文件动过**，`--force` 才重铺（先备份）；
  没有清单 ⇒ 默认一个字节不动。`--check` 多看一眼标记与指纹。
- **一次性**：现有那份预设没有清单，第一次重跑会停一次 —— `--force` 之后就是干净路径。
- **真机演练抓到 2 个 bug**（标记粘掉 `name:` 那行，两种写法各一次）—— 单测当时没抓住，
  已改成逐字比对。

- **出处**：roleplay `presets.ts:129-145`。
- **抄什么**：`lib/preset-patch.js`（75 行）+ `scripts/install-preset.mjs` 生成的 preset 带
  **`generated-by` + 版本**，升级时**不覆盖他手改过的部分**（这是"他的人格资产"的保护壳）。
- **验收**：单测（他改过 ⇒ 升级只提示不覆盖）。**量**：小。

### F4 插入优先级四档（★★#14）
- **出处**：neuro-sdk `SPECIFICATION.md:160`。
- **抄什么**：她**正在说话**时外部/内部事件怎么插（等她说完成/打断/排队/丢弃）—— 与 C3 同批做。
- **验收**：单测（Speaking 状态下四档行为）。**量**：小。

---

## 八、G 批：小修与收尾（可随时夹带）

| # | 修什么 | 依据 | 验收 |
|---|---|---|---|
| **G1** ✅ | **闹钟被退避推迟**（已修，2026-09-28 夜）：tick 里退避早退**排在闹钟之前** ⇒ 到点的闹钟最多晚 8 分钟（他今天亲测"有点慢"）。改：退避闸挪到①b 之后、只压②关怀通道 | 他 2026-09-28 实测 | ✅ 单测两条：退避窗口里到点的**闹钟**与**约定提醒**照样准点响（`tests/care-beats.test.js`） |
| **G2** ✅ | **改名后旧记忆不重贴**（已修，v0.37.0）：`setName()` 只改画像 ⇒ 旧记忆里的旧称呼把她带偏。改：改名时自动把旧名收进 `retiredAliases`，注入前**只对记忆那一块**改写（保守替换 + 命中封顶 + 换不动留理由；他原话一个字不改） | maid `index.mjs:216-231` | ✅ 单测 6 条（`tests/alias-rewrite.test.js`）+ 2 条接线 |
| **G3** ✅ | **降级要说话**（已修，v0.37.0）：注入被裁光/引擎降级时以前**静默少一段**。改：`[降级]` 标注进**注入块**（她读得到），返回值带 `degraded` 标志 | auto-memory `tier-layer-inject.js:13-15` | ✅ 单测 3 条（两种降级 + 引擎好时一个字不多） |
| **G4** | **派生字段现算不存** + 面板词同源（与 E3 合并） | pad-emotion | 源扫描测试 |
| **G5** | 文档与命名对齐：`REFERENCE_ANALYSIS` 落地状态表、`DISCIPLINE` 索引、`README` 数字钉 | 本仓惯例 | `npm run hygiene` 0 |

---

## 九、H 批：他的两条主线

- **H1 = P3 语音通道**（详见 `docs/PLAN_CORTICO_ADOPTION.md`）：延迟预算 / 打断语义 / 分句与气泡 /
  能力清单与走不走 `echo:relay` —— **四问仍等他拍**，见 `docs/VOICE_INTERFACE_DRAFT.md`。
  与本文的接口：**F1 的外部事件入口就是语音平台将来打进来的那道门**，建议 P3 落地前先把 F1 落。
- **H2 = P4 文本纪律 / QQ 草稿门 / 视觉七段式**（同见 Cortico 计划）：草稿门（先落草稿再发）、
  七段式视觉描述。

---

## 十、执行方式：他说的"一次性全部落地"怎么走

1. **一批一提交**，提交信息写清"抄谁 + 开关名 + 探针结果"；顺序：**A → B → C → G（夹带）→ D → F → E → H**。
   - A 先（地基）；B 紧随（**没有观测就别改行为**：后面每一批都要靠 B1 审计看现场）；
   - G 夹在中间（小、稳、立刻减少他的日常摩擦 —— 尤其 G1）；
   - D 与 C 可并行（互不依赖，但都要 B1 的现场数据）；
   - E 纯 UI 放后面（不阻塞任何人）。
2. **每批结束跑三个门**：`npm test` / `npm run check`（含 `check:tools`）/ `npm run hygiene`，
   外加该批的**真机探针**（`scripts/accept-*.mjs`，只读）。任一不绿就停在那批，不带病往下走。
3. **重启窗口**：宿主改动（A/B/C/D/F，凡走 `ctx.effect` 注册的）**只有重启 `dsh web` 才生效** ——
   我不许自己重启，所以每批落地后要攒到一起，**由他重启一次**，然后我跑全套探针。
   ⇒ 建议：A+B+C+G 落完重启一次；D+F+E 落完再重启一次。**两次窗口，不是八次。**
4. **回滚总表**（写进 `docs/DISCIPLINE.md`）：`injectAtTail` / `auditAllTools` / `emotionSameTurn` /
   `retrievalFusion` / `externalWake` / `sidebarTab` —— 全部能在面板上拨，并且**拨回 false = 回到今天的行为**。

---

## 十一、要他拍板的 5 处（不阻塞开工，但影响默认值）

1. **A1 灰度**：注入位置改到尾部会让系统提示的**字节构成变化** ⇒ 他看到的语域可能有细微变化。
   默认灰度开启（只在他自己的会话先试），他要不要先看两轮再放开？
2. **C1 默认开**：情绪单轮闭环 = 她**这一轮就可能带情绪**（更冲、更真），每轮多一次引擎往返。
3. **D2 精排**：动的是 **Python 侧车**（外面那个引擎团队？），谁维护要他说一句。
4. **E1 入口**：侧栏标签页要不要**取代**独立网页 `/echo`，还是两条路都留（我建议都留）。
5. **H1 语音四问**（延迟预算 / 打断 / 分句 / 能力清单）—— 仍挂在他名下。

---

## 十二、明确不做与未核实

- **不做**：§9.4 那 9 条（理由已写在那份文档里，不再重复）。
- **未核实（写清楚，不装懂）** —— **2026-09-28 已把宿主挂点在装机包里逐个核过**（见 E1/E4~E6/B4/B5 的实测行），剩下的不确定是：
  1. `systemPrompt.context()` 的 durable snapshot 在**派生历史里是替换还是累积** —— A1a 探针量，不靠推断；
  2. `sidebar.right.pane.tab` **座位在、样板在**，但"**这份 GUI 里真的渲染出来**"要 E1 当轮实测（本地客户端半区机制要先确认已生效）；
  3. `subagent/start|end` 与 `goal/activation-changed` **在插件 ctx 上到底可不可监听**（B4/B5）；
  4. Python 侧车（精排 D2）的归属与发布方式；
  5. 今天那次"闹钟有点慢"的**精确延迟数值**没量（只有单测能证顺序错，现场数字缺）—— G1 落地时补量。
