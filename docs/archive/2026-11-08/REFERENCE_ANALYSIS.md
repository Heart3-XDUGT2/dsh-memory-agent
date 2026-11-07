# 参考资料全分析 —— 21 个开源项目对 dsh-echo 的参照

> 分析时间 2026-09-27,对应 dsh-echo **v0.30.1**。
> 对象:`$env:USERPROFILE\Desktop\参考资料\` 下全部 **21 个开源项目**(含 1 个重复副本)。
> 方法:逐项目只读精读(源码 + README + 设计文档),带 `file:line`;凡未读到处标「(未核实)」。
> 目的:回答一个问题 —— **dsh-echo 站在哪、该抄什么、不该抄什么。**

---

## 零、总览

| # | 项目 | 文件数 | 定位 | 与 dsh-echo 的关系 |
|---|---|---|---|---|
| 1 | `deepseek-harness-master` | 11998 | **DSH 宿主本体** | 扩展点的权威出处 |
| 2 | `AstrBot-master` | 1747 | 聊天机器人平台 | 她出生与「嘴和耳朵」所在 |
| 3 | `AstrBot_src` | 1747 | 同上(带 `.git` 的另一份副本) | 重复,不单独分析 |
| 4 | `koishi-master` | 186 | TS 聊天机器人框架 | 同为 cordis 血统,插件模型参照 |
| 5 | `dsh-auto-memory-main` | 427 | **DSH 跨会话记忆插件** | 同生态直接竞品 |
| 6 | `dsh-pad-emotion` | 30 | **DSH PAD 三维情绪插件** | 同生态直接竞品 |
| 7 | `dsh-roleplay-main` | 49 | DSH 角色扮演 | 提示词工程样板 |
| 8 | `dsh-cosplay-main` | 11 | DSH 角色扮演(轻) | 人格注入写法参照 |
| 9 | `dsh-humanized-deepseek-maid-main` | 12 | DSH 人设+长期记忆 | 记忆注入位置参照 |
| 10 | `dsh-aura-scheduler-master` | 15 | DSH 主动调度 | 主动开口的另一种解法 |
| 11 | `Mio-main` | 458 | **个人 AI Agent(最像的竞品)** | 全维度对照 |
| 12 | `giftia-main` | 84 | 多层认知记忆情感伴侣 | 遗忘曲线 / RRF 对照 |
| 13 | `my-neuro-main` | 666 | Neuro-sama 复刻工作台 | 检索工程栈参照 |
| 14 | `Neuro-master` | 36 | 本地复刻 Neuro-Sama | 人格原型 + 实时管线 |
| 15 | `neuro-sdk-main` | 225 | Neuro 游戏接入协议/SDK | 「外部通道必须窄」的范本 |
| 16 | `Cortico-main` | 749 | 事件驱动 persona bot 框架 | 契约版本 / 可观测性 |
| 17 | `Cyrene-Agent-master` | 1737 | Electron 桌面陪伴 Agent | 插件契约 / 资源归属 |
| 18 | `Cyrene-main` | 1370 | Java 企业级 ReAct 框架 | trace 设计最完整 |
| 19 | `cnsenti-master` | 33 | 中文情感词典库 | 传统情感计算路线 |
| 20 | `Text2Emotion-master` | 13 | 单句情绪值服务 | **大连理工本体库完整版** |
| 21 | `EA-master` | 77 | 情绪原因/分类/词典论文复现 | 情绪维度关系矩阵 |

**一句话结论**:在「有状态、会遗忘、会想念、可审计」这一层,dsh-echo **明显领先全部 21 项**;
在「语义检索、可观测性、契约版本化、注入位置工程」这四层,**别人有现成的、我们该抄**。

### 落地状态表(2026-09-28 G5 对账)

这段只做一件事:**"哪些已经搬了、落在哪个提交里"**。明细账在 `PLAN_LAND_ALL.md`(第一轮)
与 `PLAN_ROUND2.md`(第二轮,进度表在文末)—— 这里是索引与结论,不是第二本账
(**两处数字打架时以那两份计划为准**)。

| 抄的什么 | 出处 | 状态 | 落在哪 |
| --- | --- | --- | --- |
| 宿主兼容闸 + 注入探针(先量再改) | DSH 宿主扩展点(§1.5) | ✅ | A0/A1a · `c38d055` |
| 全量工具审计(只观察、不改 decision) | Cyrene trace 设计 | ✅ | B1 · `98ee0dd` · `lib/tool-audit.js` |
| 一轮一个 trace + 轮内不变快照 + 反思留痕 | Cyrene / `dsh-auto-memory` | ✅ | B2/B3+B4 · `58f36a6` · `391e5a0` |
| 干活时不插话(quiet-while-working) | Mio 主动调度 | ✅ | B5 · `971777e` |
| 开口前的过期失效检查(两条判据分开) | Mio `proactive_service.py:588-592` | ✅ | C5 · `5e4c5a9` |
| **情绪单轮闭环**(他这句话惹到她,这一轮就带上) | pad-emotion `index.js:833-846` | ✅ 代码 | C1 · `3c2f8cb` · `lib/emotion-score.js`;**待重启窗口验同轮生效率** |
| **思考风格双档**(干活档一行,聊天轮一个字不加) | `dsh-cosplay` `THINKING_DIRECTIVES` | ✅ 代码 | C2 · `d0931b2` · `lib/thinking-style.js`;**待重启** |
| **出站清单**(禁词/防重复) | roleplay `prompts.ts:52-110` | ✅ | C3 · `7e94200` · `lib/speech-guard.js`(只做检查器,**不注入** —— 理由见该文件顶部) |
| **她说话时的插入优先级四档** | neuro-sdk `API/SPECIFICATION.md:160` | ✅ | F4 · `7e94200` · `lib/insert-priority.js` |
| 外部事件入口 / 日记缺口补写 / preset 不许被升级盖掉 | 各侧 | ✅ | F1+F2 · `a9ec75b`;F3 · `d424f1b` |
| 改名后旧记忆不重贴 / 降级要说话 | `dsh-humanized-deepseek-maid` | ✅ | G2+G3 · `fab705d` |
| 向量臂:能不能上(先量再说) | giftia / `my-neuro`(RRF+向量) | ✅ **可行性已量**(无模型/无 numpy/无 sqlite-vec;FTS5 中文默认分词瞎) | RT12 · `e0a1fe1`;落地(RT13)**等他点头** |
| 注入位置工程(A1b/A2/A3:`injectAtTail` 灰度) | roleplay / `dsh-humanized-deepseek-maid` | ⏳ **等一次真对话的基线读数** | `PLAN_LAND_ALL.md` A 批余量 |
| RRF 三臂 + 绝对阈值 + 滞回(D1) | giftia(`cnsenti`/`Text2Emotion` 亦相关) | ⏳ 排在 RT9 之后 | `PLAN_ROUND2.md` |
| E 批面板六条 / H 批两条(含 H1 语音) | Cortico / roleplay / neuro-sdk | ⏳ | `PLAN_ROUND2.md` |

**明确不抄的**(理由写在各篇原文,别再来回搬):上游小说文风注入段(会重演 09-26 的"演"与"怪")、
A 侧群聊维度、`dsh-auto-memory` 的多写者账本、Mio 的"无想念模型"路线。

---

## 一、DSH 宿主本体(`deepseek-harness-master`)

这是最有价值的一份 —— 它回答了「我们的插件到底能挂在哪」。

> ⚠️ **版本差**:参考副本是 **`@deepseek-ai/dsh-root` 0.1.6-alpha.2**,而本机现役是
> **`@deepseek-ai/dsh` 0.1.5-rc.3**(`$env:USERPROFILE\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`)。
> 下文凡涉及「现役宿主有没有」的结论,均已到现役安装目录复核。

### 1.1 三种派发模式(`docs/cordis-primer.zh.md:23-26`)

| 模式 | 可拦截 | 语义 |
|---|---|---|
| `emit` | 否 | 监听器按注册顺序**观察** |
| `waterfall` | 是 | **环绕中间件**,收 `(...args, next)`;不调 `next()` 即短路 |
| `serial` | 是 | 按序执行,可拦截 |
| `parallel` | 否 | 并行扇出 |
| `bail` | 是 | 停在首个 bail 值 |

**dsh-echo 用到的六个钩子,模式已核实**(`docs/event-producer-consumer.zh.md` 生成表):

| 钩子 | 模式 | 声明处 | dsh-echo 用法 |
|---|---|---|---|
| `system-prompt/assemble` | `waterfall` | `packages/core/system-prompt/src/index.ts:31` | 注入快照段 |
| `agent/pre-step` | `waterfall` | `packages/core/agent/src/runtime-types.ts:320` | 存 agent 句柄 |
| `agent/turn-stopping` | `serial` | `runtime-types.ts:381` | 想念硬保证 |
| `agent/created` | `serial` | `runtime-types.ts:261` | 装 60s 心跳 |
| `agent/inbox/claimed` | `emit` | `runtime-types.ts:299` | 记他原话 |
| `session/event` | `emit` | `packages/core/session/src/index.ts:72` | 捕获三类事件 |

### 1.2 宿主事件全清单(36 个 emit + 钩子)

实测从 `packages/` + `apps/` 全量 grep 出的 emit 事件:

```
agent/assistant-stream  agent/error  agent/inbox/{claimed,discarded,inserted}
agent/status  agent-preset/selected  api-session/{activity,added,error,removed,status}
connection/reset  cordis/{dynamic-package,dynamic-retract,inspect-query,
inspect-query-resolved,request-run,request-run-resolved}
credentials/{record-updated,reference-updated}  domain/changed  fs/observed
goal/{activation-changed,changed}  hmr/{change,reload}  internal/status
locale/change  plugin-manager/{changed,install-log,install-state}  slots/changed
subagent/{end,provider-added,start}  system-prompt/change  theme/change
tools/change  webserver/index-inject
```

**dsh-echo 漏用但可能有用**(详见 §1.5)。

### 1.3 插槽 slot 全树(`docs/subsystems/slots.zh.md:111-177`)

```
root
├─ sidebar
│  ├─ sidebar.brand.mark / .name / sidebar.panellist / sidebar.footer.action
│  ├─ sidebar.workspaces └─ .directoryFlow
│  └─ sidebar.settings
│     ├─ settings.trigger / .header / .action / .close / .onboarding
│     └─ settings.section
│        ├─ settings.general.item / settings.models.provider-card
│        ├─ settings.models.footer / settings.plugins.tab
├─ main
│  ├─ plugins.item / plugins.bundle.config / plugins.row.config
│  └─ main.conversation
│     ├─ conversation.session └─ conversation.view
│     │  ├─ conversation.chat.node
│     │  │  ├─ conversation.chat.assistant-actions / .commandview / .turnTail
│     │  │  └─ tool.call.toolview └─ tool.call.images / tool.view.cordis
│     │  ├─ conversation.message.images / conversation.trajectory.images
│     ├─ conversation.session.header
│     │  ├─ .lineage / .leading / .actions / .utilities / .corner
│     ├─ conversation.composer ├─ .approval.detail / .plan-review.actions
│     ├─ conversation.composer.bar
│     │  ├─ conversation.input.attachments / .permission / .plan / .model
│     ├─ conversation.input.overlay / .dock / conversation.composer.dock
│     ├─ conversation.input.left / .right
│     ├─ conversation.hero.brand.mark / .workspace / .agentPreset
├─ rightbar └─ rightbar.session
│  ├─ sidebar.right.pane.tab ├─ sidebar.right.tab.guide / .guide.entry
│  ├─ sidebar.right.pane.tab.title / sidebar.right.tab.menu.item
└─ shell.overlay
```

**dsh-echo 只占了 2 个**:`settings.section`(id `echo`,order 20)与
`conversation.session.header.utilities`(id `echo-session-toggle`,order 90)。

**cardinality 四型**(`slots.zh.md:48-58`):`single`(单格,priority 胜者)/
`list`(必填 `id`,按 order 排)/ `keyed`(owner 传 `entryKey`)/ `chain`(纯 `select` 选举)。
**scope 三型**:`root` / `session-maybe` / `session`。

> 关键澄清:子代理曾把 DSH 的 slot 类比成 koishi 的插件 filter —— **不对**。
> DSH 的 slot 是**前端 React 组合系统**(`dsh-client-ui-slots` + `ui-renderer`),
> 与「哪棵插件子树对哪些 session 生效」是两回事。dsh-echo 的 `echo_scope` 是自建闸,不是 slot。

### 1.4 提示词三件套 —— 现役宿主已核实可用

`dsh-system-prompt` 的 `SystemPrompt` 服务提供**四种**贡献方式
(`lib/types/index.d.ts:233/252/267/276`):

| API | 产物 | 位置 |
|---|---|---|
| `section({name, order, text})` | 系统提示**段** | 按 order 升序拼接 |
| `context({name, order, text})` | **动态上下文**,物化为**持久 user-role 快照** | 独立于 sections |
| `variable(name, provider)` | `{{变量}}` 插值 | 严格模式,未定义即抛 |
| `tools(provider)` | 工具 schema | — |

**`context()` 是 dsh-echo 完全没用的一件武器。** 类型注释原文:
「Dynamic model context materialized as a durable user-role snapshot」
(`index.d.ts:69-77`);`Config.includeRuntimeContext` 默认 `true`
(「Include dynamic runtime-context snapshots in model history」,`index.d.ts:166-167`)。

**中央分配的 order 常量**(`index.d.ts:109-150`):

- `SECTION_ORDERS`:HARNESS_IDENTITY −1000 / DEPLOYMENT_PERSONA_PREFIX 0 /
  PLAN_POLICY 500 / … / DEPLOYMENT_PERSONA_SUFFIX **10200**
- `CONTEXT_ORDERS`:**只有三个** —— SANDBOX_POLICY 110 / APPROVAL_POLICY 115 /
  SUBAGENT_DELEGATION 120(自定 order 可用,只是不占中央位)

**两个可替换的具名段**(`index.d.ts:157-159`):
`deployment:persona-prefix` / `deployment:persona-suffix` ——
**同名即替换,异名即并列**。dsh-echo 用的是异名 `echo:persona`/`echo:rules`(并列)。

### 1.5 dsh-echo 漏用的扩展点(可落地)

| 漏用 | 能做什么 | 价值 |
|---|---|---|
| **`systemPrompt.context()`** | 把「此刻的状态/悬置话题/想念行」从系统提示层挪到**贴近消息尾部的 user 快照** | ★★★ 直接提升遵从度(roleplay 实测) |
| `systemPrompt.variable()` | 人格段写成 `{{echo_persona}}`,开关/换装下一模型步骤即生效 | ★★ 比现在直接返回 `''` 更干净 |
| `tools/pre-execute` / `post-execute`(waterfall) | 审计**每一次工具调用**(现在只审计自己的 7 个工具) | ★★★ 补上「她干了什么」的黑匣子 |
| `agent/assistant-stream` | 流式感知她正在说什么(气泡/barge-in 更早介入) | ★★ |
| `agent/disposed` | 会话销毁时清心跳/路由,现在靠 `stopped` 标志 | ★ |
| `subagent/start` / `subagent/end` | 反思子代理的耗时/成败结构化留痕 | ★★ 补可观测性 |
| `goal/activation-changed` | 她进入 goal 循环时的心跳降频(别在长任务里插话) | ★★ |
| `conversation.chat.turnTail` | 在**每一轮回复尾部**挂 Echo 状态徽章 | ★ |
| `conversation.input.dock` / `.left` / `.right` | 输入框旁的「让她主动说一句」按钮 | ★★ |
| `shell.overlay` | 全局悬浮状态(她正在想念/正在写日记) | ★ |
| `sidebar.right.pane.tab` | 把 `/echo` 仪表盘做成**右侧栏原生标签页**(现在是独立网页) | ★★★ 体验提升最大 |
| `settings.plugins.tab` | 插件自己的设置页(现在挤在 `settings.section`) | ★★ |

### 1.6 客户端半区机制(`docs/subsystems/client-modules.zh.md`)

- 宿主扫 `dsh.client` 声明的包 → 组合 `window.__DSH_BOOT__` entry 图 →
  在 `/plugins` 下提供带版本的单/多资源 combo 脚本(`client-modules.zh.md:5`)。
- `WebBootEntry{id,url,rev,inject?,immediately?,external?}` —— `rev` 是
  **HMR 缓存失效用的不透明修订号**(`:22-35`)。
- 没有有效 manifest 的页面**无法启动**(解析器拒绝畸形 row/未知成员)。
- dsh-echo 的声明:`dsh.client = {platform:'web', inject:[locale, runtime, ui-primitives]}`
  —— **合规**。

---

## 二、同生态 DSH 插件(5 项)

### 2.1 `dsh-auto-memory`(跨会话记忆,427 文件 / v3.0.0)★ 同生态最强竞品

**定位**:自称「主动联想记忆 + Astra 式上下文管理」(`package.json:2-4`);
**零运行时依赖**(仅 optional `@huggingface/transformers`)。
**★ 存储是明文 Markdown + HTML 注释锚点 + JSON sidecar,不是数据库**
(`lib/memory-index.js:1-7`)—— 与 dsh-echo 的 SQLite 是两条完全不同的路。

**集成**:`inject = ['webServer','tools','systemPrompt','subagents','llm']`(`lib/index.js:134`);
**无 Config schema**,配置真源是 `DEFAULT_CONFIG`(`:215`)。
钩子:`agent/pre-step`(`:8713`)/ `agent/turn-stopping`(`:8674`,600ms 后 `consolidateTurn` `:8704`)/
`session/event`(`:8764`)/ **`tools/result`**(`:8767`)。
**注入走 3 个同步 text 回调**:`ctx.systemPrompt.context({name:'dsh:auto-memory', order:10000})`
(`:8774`)+ 静态 `section` 纪律(`:8899`)+ `dsh:m6-reference-tail`(`:8909`)——
**不 await、不阻塞**(与 pad-emotion 相反)。

**捕获**:每轮结束 `consolidateTurn`(`:6724`),门槛 minChars=240 / cooldown 30 分钟
(夜间×2)/ dailyMax=8 / turn 去重(`:6733-6748`);另有 09:30 定时固化、10:00 的 30 天蒸馏
(`:6370-6399`)。提炼由子代理做(`runSubagent :6488`,默认超时 90s,并发 ≥3 拒绝 `:6501`)。

**存(字段级)**:
- 记忆本体每条用 `<!-- memory:mem_<32hex> -->` **锚定身份**(`lib/l0-extract.js:35`)。
- 文件索引:`{sourceFile, heading, lineStart, lineEnd, byteStart, byteEnd, bytes, chars,
  recordDigest, sourceVersion, fileDigest}` —— UTF-8 半开字节区间 + **sha256 双层 digest 判 stale**
  (`lib/memory-index.js:55-104,115-128`)。
- **L0 向量索引每条只存 `{id, vector, l0, source, l0Hash, layer, status, updatedAt}`,
  绝不存原文**,384 维(`lib/l0-index.js:1-60`)。
- **三层记忆**:episodic(Episode 六元组 `{intent,actions,entities,unresolved,outcome,provenance}`,
  段上限 64/保留 256/≥2 段才巩固,`lib/episodic-store.js:8,34-40`)/
  fact(`{scope,subject,predicate,object,provenance,confirmedAt,ttl,revoked}` +
  **时间三价 occurred/mentioned/ingested** + `epistemicStatus{fact|observation|directive}`,
  `lib/fact-store.js:38-60`;**explicit > inference,冲突保留双方不覆盖**)/
  procedure(**五态** observed→candidate→validated→active→deprecated,晋升门槛
  跨会话 ≥3 且成功 ≥2 且 correction ≤30%,90 天未用自动归档,`lib/procedure-store.js:41-68`)。
- 证据:append-only JSONL 按日分片,六类 seen/read/cite/reuse/success/correction
  (`lib/context-bridge.js:45`),保留 30 天 / 32MiB(`lib/evidence-store.js:19-26`)。

**检索(公式级)**:
- 词法臂 BM25(k1=1.2,b=0.75;覆盖率 = idf 加权命中 / idf 加权查询量,
  `lib/shadow-retrieval.js:57-58,481-532`)+ 语义臂(python dense,失败回退 JS)+
  时间臂(中文时间表达→命中 1/0,`lib/temporal-parse.js:1-14`)。
- **融合 = rank-space RRF:`fused = Σ_arms 1/(k + rank/divisor)`,k = divisor = 60**
  (`lib/recall-fusion.js:19-22,75-96`)。
- **★ 决策与排序解耦**:RRF 分**只排序**,「是否注入」必须用**绝对分与校准阈值**比
  (`:10-12`)。阈值:hysteresisOn 0.65 / Off 0.42 / retrieve 0.80 / prefetch 0.55
  (`shadow-retrieval.js:41-46`)。
- **importance 不是独立加项,而是乘进语义臂**:`dense = sem × (0.5 + 0.5·imp)`
  (`lib/index.js:5589`),再进 RRF;明文**禁止作为唯一排序依据**(`memory-importance.js:23`)。
  `imp = clamp01(0.5 + 0.3×pos − 0.5×correctionRate)`(`:16-18`)。
- **注入侧另有一条 minmax 融合** `fuseD6Pre`:`dense 0.7 / lexical 0.3`
  (`lib/semantic-js.js:25,34-64`)—— **同一插件里两套融合并存**,是作者刻意保留的。
- **分层注入**:Tier-0 常驻目录每题 1 行 ≤**B0=800 token**(project ≤60%、
  whiteboard/user 各保底 10%)→ 命中才 Tier-1(≤140 字符 × K=8)→
  要证据才 Tier-2(≤2400 字符)(`docs/internal/THREE-LAYER-CONTRACT.md:17-24`)。
  总预算 `injectBudgetChars=8000`(`lib/index.js:245`)。
- **★ 分项账本硬不变式**:`chars.total === text.length`(`lib/memory-envelope.js:18-24`)。

**跨窗口延续**:水位在 pre-step 测、节流 5s、`ratio≥0.75`(**抢在官方 0.80 压缩前**)→
确认卡 35s / 宿主兜底 → 刷新仪式(写 PLAN.md + 四段账本,90s 超时 fail-soft)→
`buildContinueCarry` 四层材料(白板 3000/账本 8000/近期线程 20×700/转写按需)
总 18000 字符 → 新会话首轮注入(`docs/CONTINUITY-FLOW.md:13-102`)。
账本**权重化截断**:失败原因 .35 > 进度与下一步 .30 > 目标 .20 > 任务状态 .15
(`lib/handoff-anchor.js:18-23`);写入门硬判据 H1-H4 不过即拒(`lib/ledger-criteria.js:59-101`)。

**遗忘**:**没有 DMAE 那种连续遗忘曲线** —— 只有证据 30 天/32MiB retention、
日志 30 天蒸馏、技能 90 天归档、TTL 过期事实读时过滤、冲突保留+可撤销、
按 recordDigest/memoryId 去重。**importance 不含时间项** —— 这是与 dsh-echo 最本质的差别。

**Python 侧车**:`worker_v1.py`(657 行)JSONL 单行帧 `m7_wire_v1`,
`MAX_LINE_BYTES=256KiB`;只写 `<dsh-home>/memory/semantic/` 派生语料,
**不读任何 DSH 文件**(`:10-15`);`index_sync` 有 `sync-in-progress`/takeover(150s)。
`worker_semantic_v1.py`(1382 行)**不新增帧类型**,commit 后按 `m7_chunk_v1` 分块+embed;
启动时 identity 不符即 stale 拒服务。`m7_embedding_v1.py`:provider `bge-m3-v1`
(CLS pooling + L2 归一,**DIMENSION=1024**)。JS 侧 lazy start + workerEpoch 校验 +
256KiB 行上限 + 超时 5s + pending 64 + **熔断 3 次/30s**(`lib/m7-wire.js:23-30`)。

**与 dsh-echo DMAE 逐点对比**:

| 维度 | dsh-auto-memory | dsh-echo |
|---|---|---|
| 强度衰减 | **无**(只有存储层 retention) | **连续 `R=1/(1+Δt/H)` + 间隔效应强化** |
| importance 语义 | 「检索排多前」的证据派生量,禁作唯一依据 | `I=100·Tier·Trust·Salience^0.5` = 「值不值得记」 |
| 写入门控 | 硬判据 + 认识论状态(fact/observation/directive)+ hard gates | **四层置信度门控(0.55/0.75)** |
| 检索 | **三臂 RRF k=60 + 决策/排序解耦** | 六档关键词,`总分=hits×2+R×2+情感×0.1` |
| 情感进检索 | **不进**(情绪是另一个插件的事) | 进(×0.1 加项) |
| 图谱 | SPO 事实 + 白板 graph 工具,**非自动扩散激活** | **三元组 BFS + LTP** |
| 悬置话题 | Episode.unresolved + 账本「进度与下一步」 | **独立 `pending_threads` 表** |
| 存储 | **明文 Markdown + sidecar** | SQLite |
| 粒度 | 更粗更工程(文件+索引+预算+审计) | 更细更数学(连续强度+双时标+概率门控) |

**可借鉴点**:① **显式降级标注** —— 索引未就绪/语义臂不可用/某层被裁光都写成
`[降级] …` + `[层账]` 逐层候选/进入/裁剪账(`tier-layer-inject.js:13-15`)
(★★★,直接对应 dsh-echo 的「自动注入没覆盖到」);② **rank-space RRF 替代加权求和**
(★★★,作者列了 minmax 加权三宗罪,`recall-fusion.js:4-6`);
③ **L0 摘要压缩**(814→118 字符,6.9:1;向量索引只存 URI+向量+元数据)(★★);
④ **决策/排序解耦 + 校准阈值 + 滞回**(★★★);⑤ **分项账本硬断言**(★★);
⑥ `tools/result` 钩子(★★,dsh-echo 没接)。
**⚠️ 不该学**:把核心卖点**外挂在上游 opt-in 特性上** —— 插件自承「跨会话检索完全外挂在
DSH 的 opt-in 特性上」,而 guidance 却让模型去用 `scope='sessions'`,
作者自己定性为**产品缺陷**(`docs/internal/CROSS-SESSION-SEARCH-PATH-DECISION.md:11-31`)。

### 2.2 `dsh-pad-emotion`(PAD 三维情绪,30 文件 / v0.1.0)★ 最值得抄的情绪设计

**定位**:给角色一个**可观察、可更新、真的影响回复**的 PAD 三维情绪状态(`README.md:3-8`)。
纯 JS ESM;`core/` **零 DSH 依赖可直接 `node --test`**(`README.md:516-520`)。
`inject=['tools','systemPrompt','llm']`(`index.js:97`),`webServer` 走可选
`ctx.inject(['webServer'],…)`(`:1097`)。

**PAD 定义**:Mehrabian & Russell 1974 三近正交维 **P 愉悦 / A 唤醒 / D 优势**
(`core/pad.js:1-9,21-49`);双极 [−1,1] 统一换算单极 [0,1](`:131`),
中性点 = 几何中心 (0.5,0.5,0.5)(`:62`);
**0.1 精度 → 每轴 11 档 → 11³ = 1331 格**(`:55-60`),格子键 `"0.4,0.6,0.5"`(`core/state.js:81`)。
八象限(README.md:44-75 **记录初版把 Anxious/Bored、Hostile/Disdainful 配反了**,
按 Mehrabian 原文 + `bored=(−0.65,−0.62,−0.33)` 纠正并落断言)。
51 词锚点、4 套互不兼容量表;匹配用**欧氏最近邻**、**刻意不用余弦**
(方向同而强度不同不该同分,`core/match.js:1-9,42-68`)。

**★ 判定 = 独立模型请求**:每条用户消息到达发一次 `ctx.llm.stream`(`index.js:606-607`),
问「角色听完这段对话是什么情绪」,要 JSON `{p,a,d,dominant,confidence,reason}`
(`core/appraise.js:26-33`);system prompt 把「**只标角色自己的情绪**」写最前并重复
(`:80-101`),带 16 个跨象限锚点。**关键词兜底已删除**(归属错误 + 认词不认事,`appraise.js:7-18`);
打分失败**状态不动**只走衰减(`index.js:50-51`)。
**触发点 = `session/event: agent/inbox/spliced`**(`:741-748`),**不是 user/message** ——
实测落库序是 step/start → system 提示词 → user/message → 请求,
**prompt 在消息落库前已定稿**(`:733-740`)。

**★ 注入(影响紧接着那一句)**:必须是 **`system-prompt/assemble` 异步 waterfall**
(`:833-846`),**不能是同步 provider**(只能读到打分没回来的旧状态);
`await Promise.race([pending.run, sleep(appraiseTimeoutMs=2500)])`,
**超时用旧状态、打分稍后照写** —— 「同轮生效」与「不变慢」唯一的旋钮(`:834-838`)。
渲染 `<pad_emotion>`:三维数值 + 情绪词 + 象限 + 成因 + 趋势 + **语气指引**
(p≥0.7 偏暖、a≥0.7 短促、d≤0.3 多征询,`core/describe.js:170-207`)。
座位默认 `context`(order 8600,**显著性最高**),preset 关 `includeRuntimeContext`
时可切 `section`(`index.js:99-105,816`)。

**衰减动力学**:惯性 `(目标−当前)×reactivity×confidence`,reactivity=**0.8**
(配 0.1 网格算出的下限:低于 ~0.714 推不动格子,角色永远卡中性);
**指数半衰期 `k = 1 − 2^(−t/halfLife)`,默认 30 分钟**;maxStepPerTurn=0.4;
顺序**先衰减后混合**(`core/dynamics.js:31-53,86-108`)。
**★ 网格 + 残差**:对外严格落 0.1 网格,内部留连续 latent,
残差 [−0.05,0.05) 让 +0.03 微调不被抹掉(`dynamics.js:10-13,261-268`)。
**派生字段一律现算不存**(`state.js:63-71`);概述词优先采信打分器的词、
漂移 >0.3 才退回词表最近邻(`:95-121`)。

**★ Web 三维坐标系画法**:右侧栏页签(`slots.inject('sidebar.right.pane.tab.body'/'title')`,
`client.js:668-678`);**手写 3D 投影** —— Canvas2D + 绕 Y(yaw)/X(pitch) 旋转矩阵(`rotate:113`)
+ 透视除法(`project:133`)+ 世界坐标(`world:149`);画立方体 6 面(按面心 z 排序做**画家算法**,
`:198-209`)、12 棱、每棱 0.1 刻度、当前发光小球 + 到三轴投影线、基线灰十字、
轨迹折线(越旧越暗)、最近锚点小圆点+标签;拖拽旋转(pitch clamp ±1.45)+
自动微旋 `yaw += 0.0035`(`:506-507,518-531`)。
**刻意不用 three.js**(几百行数学 vs 多几百 KB 包,1331 格用 WebGL 是杀鸡用牛刀,`:15-17`);
**`__internals` 导出 draw/rotate/project/world 供离线冒烟**(`:686-697`)。

**与 dsh-echo 7 维对比**:

| 维度 | dsh-pad-emotion | dsh-echo |
|---|---|---|
| 维度设计 | 心理学正交基,可枚举、有文献锚点,**无 target 概念** | **人格专属 + 分 global/target 两层**,能表达「依赖<称呼>」 |
| 判定成本 | **每轮额外一次模型请求**(+600 字符转写、+400 输出 token、等 2.5s) | 每轮反思**顺带**产出(边际成本≈0) |
| 衰减 | 指数半衰期 + 惯性 + 步长上限 + **网格残差** | 衰减回基线 + 心境强度调制想念阈值 |
| 注入时机 | **「听完你这句之后」的状态**(waterfall 等待) | **上一轮结尾的快照**(这轮输入还没算进去) |

**可借鉴点**:① **异步 waterfall 同轮生效三件套**(★★★):
(a) 打分挂在**最早的能赶上装配的事件**;(b) 注入走**异步 waterfall** 而非同步 provider;
(c) **超时旋钮 `Promise.race`** 降级用旧状态 ——
dsh-echo 现在做不到「他这句话惹到她了 → 下一句回复就带情绪」,学这套即可。
② **打分归属纪律**(`appraise.js:80-101`)应写进 dsh-echo 的反思(★★★)。
③ **网格 + 残差**与「派生字段一律现算、**UI 词与模型词同源**」(`describe.js:1-11`)
—— 后者正是 dsh-echo 同类不一致问题的解药(★★★)。
④ **可旋转三维可视化**:Canvas2D + 约 30 行旋转矩阵即可画立方体 + 轨迹 + 投影线,
零 three.js、带拖拽惯性;dsh-echo 的 7 维可退化为「3 主轴画立方体 + 其余 4 维雷达/条形」;
更关键是 **`__internals` 让「面板是否真的画出来了」可离线断言**(★★★)。
⑤ 八象限配反后**落断言**的纠错纪律(★★)。
**⚠️ 不该学**:每轮多一次模型往返的成本结构(可折中为「仅当 |Δ情绪| 超阈才独立打分」);
以及 pad **缺失 target 层**,dsh-echo 不要退回单角色状态。

### 2.3 `dsh-roleplay`(提示词工程样板)★ 最值得抄

- **形态**:TS + esbuild;主机行 `inject = ['settings','storageDomain','webServer','tools']`
  (`index.ts:16`);会话行 `inject = ['roleplay','systemPrompt','tools']`(`agent.ts:37`)。
- **人格注入**:与 cosplay 相反 —— 它**顶替**部署人格槽:段名取
  `PERSONA_SECTION_NAME`、order 取 `personaSectionOrder(ctx)`,即与宿主
  `deployment:persona-prefix` **同名同序**(`dsh-compat.ts:72-88`)→ 替换而非并列。
- **六段常驻规则**(`prompts.ts:113-122`):基础扮演 / NSFW 增强 /
  **防抢话**(`:52-61`,不许替用户说话、决定、推进时间)/
  **防重复**(`:64-72`)/ 文风(`:75-85`)/ **禁止规则**(`:88-110`,逐条禁词禁句式)。
- **★ 关键设计**:per-turn 动态指令走 `ctx.systemPrompt.context()`
  (order 100/200/220/240/300,`agent.ts:199-250`),渲染成**保留历史之后、贴近最新用户消息**
  的 user 角色快照 —— 注释原文:「per-turn 指令贴近用户输入,**遵从度好得多**」(`agent.ts:184-190`)。
- **两条硬机制**:① 一次性舞台指示经 `agent/pre-step` 把 `[系统指令: …]` 追加到下一条用户消息
  (`:256-282`);② 选项模式经 `agent/turn-stopping` + `agent.steer` 强制补一次
  `ask_user_question`(`:296-315`)—— **「设置是保证,不是建议」**。
- **preset 托管**:把 agent preset 写进 `<dshHome>/.agent-presets/`,带 **generated-by 标记**;
  无标记的文件视为用户所有、不动它(`presets.ts:129-145`)。
- **兼容层**:`dsh-compat.ts` 用 namespace import 探测符号,避免宿主升级直接
  SyntaxError 死插件。

**可借鉴**:① `context()` 贴近尾部注入(★★★);② 防抢话/防重复/禁词清单(★★);
③ preset 文件 + generated-by 标记(★★);④ 兼容层探测(★★)。

### 2.4 `dsh-cosplay`(轻量人格注入)

- 纯 JS ESM、无构建;`inject = ['settings','systemPrompt','tools','typert','skills']`(`index.js:44`)。
- **变量 + 段**:注册变量 `cosplay_active`(每次模型步骤求值)+ 追加段 `cosplay-persona`,
  `order: PERSONA_ORDER + 1`,正文就是 `{{cosplay_active}}`(`index.js:260-265`)。
  开关关 → 变量渲染空串 → **人格静默回退,无需重建会话**。
- **思考风格双档**:`THINKING_DIRECTIVES` 分 neutral / role 两套思维链指令
  (`store.js:142-145`),追加在 persona 末尾(`:165-167`)。作者注释自认系统提示位
  比 DeepSeek 训练位弱、概率触发(`store.js:139-141`)。
- 酒馆 v2 卡导入导出(`store.js:187-224`)。
- 客户端挂 `settings.section`;因 settings 命名空间对 Web 有硬编码白名单,
  设置页改走**插件自有 typert Remote 通道**(`client.js:12-13,145-155`)。

**可借鉴**:① 变量化人格段(★★);② **思考风格双档** —— Echo 现在全程角色化思考,
可给「干活时中立思考」一档(★★★,这是很妙的一招)。

### 2.5 `dsh-humanized-deepseek-maid`(轻量长期记忆)★ 最值得抄

- 纯 JS ESM、**零运行时依赖**;`inject = ['webServer','systemPrompt','settings']`(`index.mjs:32`)。
- **人格段 order 0**(`index.mjs:388-397`),正文含【PERSONA_LOAD】标签块 + 强制身份 +
  铁律(先完成工作再扮演)+ 沉浸规则 + 似曾相识 + 人设自检 + **性格成长**(第 7 条)。
- **记忆**:纯文本文件 `DeepseekMemory`,两段式(稳定事实 + 互动记录,
  `parseMemory:285-303`),上限 60 行 / 20 条(`:41-43`)。
  抽取用四条自我披露正则(`:99-104`);去重用字符二元组 **Dice 相似度 ≥0.6**(`:189-196,336`)。
  检索是**查询诱导召回**:当前消息切二元组、剔除虚词表(`:171-186`),对非最近行打分取 top3(`:438-454`)。
- **★ 注入位置**:在 `agent/pre-step`、仅 `step===1`,以一条
  `source.kind='session-reference'` 的 **user 消息追加到尾部**,预算 500 字(`:406-474`)。
  注释原文:**人设段刻意不含易变记忆,让系统提示字节级稳定以命中前缀缓存**(`:350-353`)。
- **两个妙细节**:`relabelLine` 用**当前称呼重贴旧记忆标签**、`userSideOf` 丢掉女仆回复原文,
  避免旧称呼惯性(`:216-231`)。
- 记录只在 turn/end 落一行、且只记 `source.kind==='user'`(`:499-518`)。
- 配置原子写 + `/dsh-humanized-maid/status|config` 路由(带 CSRF),保存后
  emit `system-prompt/change` 失效缓存(`:604-606`)。

**可借鉴**:① **系统提示稳定 + 记忆只动尾部**(★★★,直击 dsh-echo 前缀缓存痛点);
② 二元组 + 虚词表 + top-k 的零依赖召回(★★,可做引擎降级路径);
③ **旧记忆按当前称呼重贴标签**(★★★,正是「改了称呼却带偏」的解药);
④ 单行互动记录(★)。

### 2.6 `dsh-aura-scheduler`(主动调度)

- TS + cordis + schemastery;无客户端半区、不注册工具或提示词段,
  只提供服务 `ctx.aura`(`src/index.ts:111-113`)。
- `start()` 立即跑一次 tick,然后 `setInterval(..., 60_000)`(`index.ts:118-128`)。
- **价值网络**:`V = α·idleRatio + β·relevance − δ·interruption`(`:216-221`),
  `V > 0.2` 或超 maxInterval 才开口(`:226-227`);闸门:静默时段(`:256-261`)→
  off-peak 省钱窗(`:263-268`)→ 冷却(`:211`)。
- 传感器(file/process/http/port)按状态翻转触发,首次探测只做基线(`sensors.ts:35-44`);
  webhook 走 HMAC-SHA256 + 每分钟限流(`webhook.ts:51-61,76-89`)。
- **开口动作只是 `ctx.emit(cb)` 或 POST 一个 URL**(`:238-249`)—— 事件里**没有话**。

**与 dsh-echo 的本质不同**:echo 的 `M(s)=10s/(s+H)` 是「沉默时长 → 想念强度」的连续曲线,
心跳**直接产出一句要发出去的话**,与人格/记忆绑定;aura 是通用价值网络,
`relevance` 是配置常数、`_interruptionCost()` 写死 0.3(`index.ts:270-273`,注释自称 placeholder),
**不注入任何提示词**。**echo 是「她想说话了」,aura 是「闹钟到点了」。**

**可借鉴**:① off-peak + 冷却 + 静默时段三层闸(echo 有夜间憋话,可再补省钱窗)(★);
② **传感器/webhook 作为外部唤醒源**(★★,「<称呼>的构建跑完了」也能让她开口);
③ 把「打扰代价」显式建模 —— 可用「上次被已读不回」当 interruption 项(★★)。

---

## 三、最像的竞品:`Mio-main`

**定位**:Windows 本地优先单机 Agent,Python + Vue 单体后端,**非插件化框架**。
FastAPI(仅 127.0.0.1)+ Vue 3.5 + pywebview 桌面壳 + Electron 桌宠。
**单一 SQLite**(`app/db.py`,4719 行),**无向量库、无 embedding**(全局 grep 确认)。

- `main.py:65-77` 一次 `create_task` 拉起 **13 条常驻循环** ——
  是「进程内多定时器」,不是 dsh-echo 的单 60s 心跳。

### 3.1 记忆(对照 DMAE)

- 表 `structured_memories`(`db.py:110-132`):layer/category/memory_key/content/
  source_*/confidence/occurred_at/learned_at/valid_from/valid_until/last_confirmed_at/
  time_confidence/temporal_status/status/superseded_by/last_seen_at。
- 分层 **L0**(identity/preference/relationship/person)/ **L1** 近期状态 / **L2** 长期经历;
  门槛 L0≥0.90、L1/L2≥0.75、候选≥0.55(`memory_service.py:152-155,214`)。
- 检索(`memory_service.py:266-305`):FTS5 + bm25(`db.py:1190-1205`)+ 启发式
  `_relevance`(`:249-263`)= overlap×3 + confidence×4 + layer_bonus(L0=8/L1=5/L2=2)
  + recency + evidence_bonus(有源消息 1.5)。
- **遗忘:没有连续曲线** —— 仅二值休眠 `sleep_stale_structured_memories`
  (`db.py:1240-1253`),last_seen_at 早于 **21 天**的 L1 置 `sleeping`,L0/L2 永不衰减。
- **换代**:按 `(memory_key, category)` 找 active 行;内容全同 → reinforced;
  不同 → 插新行、旧行置 superseded 并指 `superseded_by`(`db.py:910-1020`)。
- **时间纪律**:5 态 `temporal_status`(current/historical/planned/enduring/time_unknown),
  拒绝相对时间(`_iso_time` 抛错 `:67`);注入时逐条拼「发生时间 / 用户在X提到,
  事情发生时间未确认 / 记录维护于(不是事件日期)」(`:344-352`)。
- **候选箱**:0.55~0.74 落 `save_structured_memory_candidate`(`:183-239`),
  **永不进上下文**,待确认才升 active。
- 群聊 `qq_group_*` 一律禁写私人记忆(`:139-140,309`)。

### 3.2 日记(对照 22:30)

**不是定时 22:30,而是轮询补「昨天」缺口**:
- `daily_diary_loop`(`daily_diary_service.py:194-202`)每 60s 跑一次;
  `_target_date` = 记录日 −1(`:82-84`);`_missing_dates`(`:40-54`)扫出
  「有素材无日记」的历史日期,**可一次补多天**。记录日边界 `day_boundary_hour=4`。
- 素材双源:聊天记录 + 独立**日记素材暂存箱** `diary_materials`(`db.py:153-166`)。
- 组稿强制骨架:今日事件/今日情绪/今日成长/做得不错/可以调整的地方/明天最小行动/标签
  (`prompts.py:203-272`)。
- 失败指数退避 `300×2^min(n-1,4)` ≤3600s(`:150-158`),配置变更即释放退避。
- 另有 daily/weekly/monthly_reviews 独立循环与表。

### 3.3 主动联系(重点:**无想念模型**)

> **全局 grep `想念|思念|miss_|longing` 零命中。**

- 心跳 `proactive_loop`(`proactive_service.py:767-797`):默认 **300s**
  (`config.py:322`,可 30~3600)。
- **唯一量化处**:`_idle_delta()` = `random.randint(min_idle, max_idle)` 分钟
  (`:353-356`),默认 min=max=**120**;`next_prompt_at` = 最后用户消息 + `_idle_delta`(`:592`)。
  **是随机静默窗,不是单调爬升到阈值** —— 不会「越久越想说」。
- 话题打分(`:379-432`):到期悬置话题 100−4i / 今日最小行动 72 / 主线 58 /
  最近用户消息 64−6i;对已用 topic 去重惩罚(同 key 扣 85、语面包含扣 55);
  最高分 <20 退回 `light_check_in`。
- **六道闸**统一在 `autonomy_service._decision`(`:566-640`):paused / 能力单独关 /
  白天窗(默认 9-22)/ quiet(22-8)/ relevance<0.5 / confidence<0.55 /
  interruption_cost≥0.5 且前台活跃 → wait / daily_behavior_limit=3 /
  daily_budget_yuan=0.05 / minimum_interval_minutes=120 /
  权限级 observe|suggest|auto_low_risk|confirm_high_risk。
- **过期抑制**:事件带 `last_user_message_at`,投递前若用户已继续聊则 ignore(`:588-592`)。
- 夜间收尾窗 **23:00-01:00**(`config.py:348-349`),要求今天聊过、静默≥45min、当日无日记。

### 3.4 QQ 接入

NapCat + **OneBot 11 反向 WS**:后端是 WS 服务端 `/onebot/ws`(`routes/onebot.py:1318-1381`);
发 `send_private_message(_receipt)`(`:855-894`)走 per-connection outbox + echo 回执,
超时判 `delivery_unknown` 并关连接**不重发**。
**多入口模型不同**:主动消息「应用为主投递通道,QQ 在线才同步同一组消息」
(`proactive_service.py:466-509`)—— QQ 是**可选镜像**,不是唯一出口。

### 3.5 结论

| 维度 | Mio | dsh-echo |
|---|---|---|
| 遗忘 | 21 天二值休眠 | **连续曲线 `R=1/(1+Δt/H)`** |
| 想念 | 随机静默窗 | **`M(s)=10s/(s+H)` + 阈值 7.0** |
| 检索 | FTS5 词面 | 六档关键词 + L0 强制占位 |
| 情绪 | 标量 `mood_score` 0-5 | **7 维向量 + 衰减回基线** |
| 审计 | agent_events 留痕 | **审计黑匣子** |
| 形态 | 单体应用(4719 行 db.py) | 可挂载插件 + 侧车 |

**最值得抄**:① **候选箱**(0.55~0.75 隔离、不进上下文)(★★★);
② **时间三分注记**(发生/得知/记录维护)(★★★);
③ 话题去重惩罚 + `proactive_topic_history` 表(★★);
④ **开口前的事件过期失效检查**(★★);
⑤ 统一「事件→决策」六道闸管道 + 留痕(★★);
⑥ 日记缺口补写 + 指数退避 + 素材暂存箱(★★)。

---

## 四、记忆体系对照(giftia / my-neuro / Neuro-master)

### 4.1 `giftia`(心理学驱动)

- FastAPI + React + **LangGraph** + SQLite(WAL) + 智谱 embedding-3。
- **四层**:工作记忆(覆盖式更新,`working_memory.py:21-98`)/ 档案卡 /
  长期记忆三层(CORE S=10 / IMPORTANT S=2 / REGULAR S=1,`memory_layer.py:22-29`)。
- **艾宾浩斯**:`strength = 0.3 + importance×0.5 + min(access_count×0.15, 1.0)`,
  `R = exp(−Δt_hours/(strength×24+1))`(`memory_manager.py:192-198`)。
  ⚠️ README.md:328 写 `R=e^(−t/S)`,**与代码不符**(文档漂移)。
- ⚠️ **实测缺陷**:`add_memory` 构造 MemoryItem 时不传 layer(`:619-628`),
  `from_importance` 全仓只在 `migration_v2.py:86-91` 出现 →
  **新记忆恒为 REGULAR,分层实际未接线**。
- **RRF 检索**:查询改写(LLM,5s 超时,`:496-535`)产 ≤4 查询 → 每查询跑语义+关键词两路 →
  累加 `1/(60+rank+1)`(`:670-683`)→ 五特征 rerank:RRF 0.5 / 时间 0.2 / 情感 0.15 /
  重要性 0.10 / layer 0.05(`:815-821`)。
- 三 Agent 图边是**串行**(`emotion_graph.py:583-593`),真并行只在流式路径
  `asyncio.gather`(`:680-684`)。

**与 DMAE 对比**:
- **心理学原版**:艾宾浩斯原曲线是指数,giftia 的 exp 更贴原版;DMAE 是幂律同族近似。
- **工程化 DMAE 更好**:① `R(H)=0.5` 有可解释的半衰期语义,giftia 的 `S×24+1` 无直观含义;
  ② DMAE 只存 H/last_accessed/recall_count,R 永远现算;③ 强化按「想起时多吃力」自适应,
  是真间隔效应,giftia 的 `access_count` 线性加成只是粗代理;④ DMAE 永不归零、三态可唤醒,
  giftia 会硬删。

### 4.2 `my-neuro`(检索工程驱动)

- Electron + Live2D 工作台;ASR(FunASR)/ TTS(GPT-SoVITS)/ BERT / RAG(:8002)/
  **MEMOS**(:8003,Qdrant + NetworkX + BM25 + 可选 Neo4j)。
- **演化引擎**(`core/evolution.py:152-246`):访问≥3 或(importance≥0.7 且 age≥7d)晋升;
  60 天无访问且 importance<0.2 归档;importance 每轮 ×0.95、floor 0.1;
  相似度≥0.95 合并并记 `merged_from`。**不物理删除,可恢复。**
- **检索全链**:chunk 500/overlap 50、段落优先(`utils/document_loader.py:85-162`)→
  三层向量召回(`recall_top_k=max(top_k×3,8)`,`:2225`)+ BM25(中英 2-gram,
  `utils/search_utils.py:37-56`)→ 图谱 boost 0.15/0.1/0.2 →
  加权 `similarity×(1+importance×0.3+type+layer+recency+frequency)+graph_boost`
  (`:2531-2534`)→ 阈值 → **CrossEncoder 精排**(bge-reranker-v2-m3,**默认关**,
  缺失回退粗排,`:2553-2568`)。
- **上下文压缩**(`ContextCompressor.js:76-161`):超 15 条异步触发,保留最近 4 轮,
  旧消息 + 上次总结一起送 LLM 做**累积式**总结(max_tokens 500),替换为单条 system。

**相对 dsh-echo 六档的优势**:① 向量语义路补同义改写(「面试」vs「找工作」),
且「**仅一路命中不稀释**」的打分(`:2330-2344`)比简单加权稳;② CrossEncoder 作
**可选后置层**(默认关、缺失自动回退、API 模式带熔断);③ 画像候选池要求
**3 个不同日期、跨度≥3 天**才晋升,单日多次只算一次
(`plugins/community/user-profile/index.js:374-396`);④ 只归档不删除。

### 4.3 `Neuro-master`(人格原型)

- Python 3.11,全局共享 `Signals` 对象(`main.py:40`);LLM 走 text-generation-webui
  OpenAI 兼容端点(`constants.py:17`)。
- 管线:STT(RealtimeSTT + faster-whisper tiny.en)→ `signals.history` →
  `Prompter` 每 0.1s 轮询 → SSE 流式 → **整段生成完**才 `tts.play`(`abstractLLMWrapper.py:148`)。
  **TTS 不是逐句流式**。
- **人格**:写死在 `constants.py:66-78` 的 `SYSTEM_PROMPT` 字符串。
  组装按 `Injection.priority` 升序:SYSTEM_PROMPT=10 / memory=60 / chat=100 /
  twitch=150 / custom_prompt=200(`injection.py:6-9`)。
- **防漂移:几乎没有** —— 只有一句「keep responses short」+ `STOP_STRINGS=["\n"]`
  (`constants.py:85`)。无自检条款、无冲突优先级、无尾部锚点概念。
- **记忆**:ChromaDB(`memory.py:23`);每 20 条消息触发 reflection 生成 3 个 QA 对
  (`:63-99`);检索用最近 5 条 + twitch 消息当 query,`n_results=5`。
  **没有遗忘、没有衰减、没有强化**,只有手动删除(`:113-123`)。
- **打断**:`cancel_next` 置标志、流循环 `continue` 丢弃 chunk,同时发
  `/v1/internal/stop-generation`(`:175-178`);`abort_current_message` → `tts.stop()`。
  **是整段取消,没有残句记忆。**
- **主动开口**:`PATIENCE=60` 秒没人说话就开口(`constants.py:13`)——
  **纯无聊计时器**,没有情绪/想念状态。

**可借鉴**:① `Injection` 优先级表(模块自声明 priority + `cleanup()`,`module.py:22-27`)(★);
② reflection 每 20 条的批处理节奏(★);③ 输出黑名单过滤(`:34-39,142-145`)(★);
④ 多模态截屏注入(`imageLLMWrapper.py:20-34`)(★)。

---

## 五、外部接入协议:`neuro-sdk`

- **协议**:WebSocket 明文 JSON(`API/SPECIFICATION.md:24-26`),信封 `{command, game, data}`。
  C2S:`startup`/`context`/`actions/register`/`actions/unregister`/`actions/force`/`action/result`;
  S2C:`startup`/`action`/`speech_finished`。未识别 command **静默忽略**(`:33-34`)。
- **防作弊三层**:① **动作白名单** —— 只有注册过的 action 名可执行,`actions/force`
  的 `action_names` 再收窄(`:161`);② **游戏侧 Validate 必须自己校验** ——
  文档明确警告 `data` 可能畸形、无效 JSON、不匹配 schema(`:238-240`);③ **20 秒超时 +
  `success:false` 自动重试**语义(`:168-192`)。
  `BEST_PRACTICES.md:49` 原文:「don't let her cheat… Prefer giving her the same
  information a human player would have」。
- SDK 侧 `ActionWindow` 四态(Building/Registered/Forced/Ended)+ 注册后**不可变冻结**
  (`Unity/Assets/Actions/ActionWindow.cs:55-98`)。

**对「平台只当嘴和耳朵」的启发**:**这是同一哲学的镜像**。
dsh-echo 的 QQ 适配器被明令禁止调 LLM、写记忆、判断人格;
neuro-sdk 的游戏被明令禁止假设数据合法、必须自己 Validate。
**同一条边界:外部只负责「喂事实」和「执行」,判断权与人格权留在核心。**

**可借鉴**:① `action/result` 的 `message` 字段当「小上下文回灌」(`BEST_PRACTICES.md:31`)(★);
② **`ephemeral_context` 开关** —— 大块状态只对本次决策可见、**不进长期记忆**(`:159`)(★★★,
对注入预算有直接价值);③ **`priority` 四档** low/medium/high/critical 控制
「她正在说话时怎么插入」(`:160`)(★★,echo 现在只有「忙则下分钟再来」一档);
④ `speech_finished` 的 `isFinal`/`cancelled` 语义(`:242-260`)(★)。

---

## 六、Agent 框架(3 项)

### 6.1 `Cortico`(事件流为中心)

- TS 框架 + 本地服务(express + React 控制台,`127.0.0.1:7788`)。
- **严格四层**:Core(无语义,只管 session/事件流/模型调用生命周期)/
  Persona / Memory(Core 视为不透明)/ World / Bot。
  硬约束:**World 与 Persona 互不依赖、不能互调程序接口**,
  只通过「事件投递 + 工具描述」通信(`src/core/types.ts`)。
- **扩展机制**:npm 包 + `keywords:["cortico-world"]` + `cortico:{kind,api,consoleClient}`;
  **契约版本是复数表 `EXTENSION_API_VERSIONS`(world 5 / provider 5 / bot 6),严格相等即拒、
  无兼容窗口**;拒绝文案分新旧两条(过旧=「扩展需要升级」/过新=「框架需要升级」)
  (`src/extensions/manifest.ts:17-21,113-117`)。
  ~~`EXTENSION_API_VERSION`(单数,现为 4),不符即拒载~~ —— **此处原文写错了**:
  仓内不存在单数常量(2026-09-28 复核)。
- **Agent 循环**:`WakeBus` 合批总线,四种触发 `preempt`/`flush`/`debounce`/`piggyback`;
  单常驻 session + 多 fork。
- **可观测性**:run 目录(`run.json`/`events.jsonl`/`log.jsonl`/`transcript.jsonl`/
  `toolcalls.jsonl`/`incidents/`);`LogRecord` 带 `sess`/`round`/`resp`/`call`/`ev`/`task`
  关联字段(AsyncLocalStorage 注入);`pnpm logq` 提供 `timeline`/`turn <N>`/`doctor`/`bundle`。

> **2026-09-28 深挖**:`docs/REFERENCE_CORTICO_2026-09-28.md` —— 15 份亲核 + 6 份子代理报告,
> 逐条给「抄 / 改后抄 / 拒」与落点。要紧的六条:①三条**文本纪律**(内心戏≠说出口 / 沉默合法 /
> 旧发言不作句式范本,零成本改 `persona.json`);②**可维护的文体宪法**段
> (`avoid / use less / use cautiously / prefer`,归梦修订,治"报告体"最结构性的一招);
> ③视觉描述**七段式**(事实/推测/不可辨认彻底分开,治 `lib/eyes.js`);
> ④**起草-确认门**(`qq_draft` `barrierAfter` + 草稿期 drain 新消息回注 + 未确认作废);
> ⑤心跳**只报事实**("已安静 N 分钟")+ 指数退避 + `schedule_wake` 投递闸门;
> ⑥**否定判断当账写**(枚举 reason 可 GROUP BY、全通过才静默、任一否定必留痕)。
> 另:我们的**压缩**实为挂宿主 `BasicCompactionEngine`、覆写 `summarize()`
> (`lib/compaction.js:83-106`),`lib/context.js` 是情绪/记忆渲染 —— 该文已按此纠正。

### 6.2 `Cyrene-Agent`(Electron 桌面陪伴)

- Electron 43 + React 19 + Vite + Live2D 桌宠。
- **公开契约唯一来源** `src/plugins/api.ts`(明确不 import `src/main` 或 `src/shared`)。
  插件能力三类:**Contribution**(registerTool/registerChannelAdapter/
  registerPromptProvider/open)/ **Capability**(`ctx.deps` 窄接口)/
  **Observation**(只读宿主事件)。
- `PluginManifest{apiVersion,id,version,entry,deps}`;`deps` 明确声明
  **「不是安全权限、不是沙箱」**。
- **`PluginContext` 是资源归属的核心不变量**:工具、监听器、IPC、调度任务、语音租约
  全登记到创建它的 context,停用时**逆序清理**。
- 用户插件首次发现**一律停用**(即使 `defaultEnabled:true`),须用户点启用。
- **明确不开放**:改审批结果、替换 Agent Loop/Harness、拿 Harness 实例、`before*` 拦截钩子。
- **Agent 循环**:`CyreneHarness` 单入口 `run(input)`,while + function calling,
  **每轮 1 次 LLM**;`ask_user` **排他**(同轮其他工具返回
  `not_executed_due_to_clarification`);**`uncertainEffects` 数组阻止伪完成与重复副作用**;
  双时钟(用户等待不计入执行超时);mid-loop compaction 阈值 0.7 + 配对安全切点。
- **可观测性**:`execution-ledger.ts`(进程内 bounded,按 `runId + toolCallId` replay);
  宿主事件**异步旁路、at-most-once、不持久化不重放**,且 tool 事件
  **不含参数/输出/密钥/提示词**(脱敏)。

### 6.3 `Cyrene-main`(Java 企业级)

- Java 21 Maven 八模块,依赖**单向** `core → provider/input/tool/react/trace → agent → server`。
- **工具注册双层**:`ToolRegistry` 可变(支持热加载)+ **`RunToolCatalog` 每次 run
  一个不可变快照**(同一快照既供模型定义又解析调用)。
- **扩展不是插件系统,是配置驱动**:全部 `HARNESS_*` 键,优先级
  「显式覆盖 > 进程环境 > .env > 默认」。工具四路来源:内置 / MCP / Skill /
  **项目 API 自动发现**(OpenAPI 优先,否则受限工具扫描 → `project-apis.json` → 热加载)。
- **★ trace 最完整**:`harness-trace` 模块 —— `TraceCollector implements RunTrace`
  作**跨切面**实现(`recordInput`/`recordPreprocess`/`recordLlmMeta`/`addStep`/`addTokens`/
  `recordModelUsage`);`TraceStore` 接口三实现(Mysql/Sqlite/File)+ 工厂;
  含 `findBySession` 游标分页、`cleanup(retentionDays)` + `AuditCleanupScheduler`、
  `updateMetadata`(点赞点踩回写)。
- 另有 **`ReplyAuditor`** —— **无模型调用的启发式终稿审计**(检查过短、错误措辞、
  残留工具 JSON)。

### 6.4 dsh-echo 的架构隐患(它们已解决)

| # | 隐患 | 别人怎么做 |
|---|---|---|
| 1 | **契约无版本协商** —— `echo_wire_v1` 只是名字 | Cortico `cortico.api`(数字契约,不符即拒载,但**无兼容窗口**);Cyrene-Agent `apiVersion` + SDK 单一来源 |
| 2 | **无不可变运行快照** —— 工具/记忆运行中可变 | Cyrene-main `RunToolCatalog` |
| 3 | **可观测性偏弱** —— 只有 `audit_logs` + 3s 轮询 SSE 半推 | Cortico run 目录 + logq;Cyrene-main TraceStore + 保留期 |
| 4 | **扩展粒度粗** —— `cordis.patch.yml` 只做 insert | Cyrene-Agent manifest + deps + 资源归属 + 逆序清理 |
| 5 | **外部副作用无保护** —— `echo_qq_call`/`echo_qq_say` 不可重试 | Cyrene-Agent `uncertainEffects` + 非幂等不重试 |
| — | **反向优点**:三态降级链(python → 熔断 → JS 基线 → offline) | **三个框架都假设依赖可用,没有等价设计** |

---

## 七、平台框架(AstrBot / koishi)

### 7.1 AstrBot(v4.28.1)

- **分层**:平台适配器层(30 余个 `sources/`)/ 事件总线(一个 `asyncio.Queue`,
  `event_bus.py:39-54`)/ **管道**(9 个固定阶段写死在 `stage_order.py:3-13`:
  WakingCheck → WhitelistCheck → SessionStatusCheck → RateLimit → ContentSafety →
  PreProcess → Process → ResultDecorate → Respond;洋葱模型 `scheduler.py:36-80`)/
  插件系统 `core/star/` / LLM 供应商 / 持久化(SQLite + faiss)。
- **插件机制**:「Star 就是插件」;`Star.__init_subclass__` 自动注册(`base.py:64-75`);
  生命周期只有 `initialize()`/`terminate()`;Handler 走装饰器
  (`@filter.command`/`@filter.event_message_type`/…);16 种 `EventType` 钩子
  (`star_handler.py:219-241`)。
- **`stop_event()` 是设计好的语义**(`astr_message_event.py:348`),不是 hack。
- **内置 LLM 管线很重**:`PersonaManager` 拼进 `req.system_prompt` 的
  `# Persona Instructions`(`astr_main_agent.py:554-558`);记忆 = 会话对话 + 平台历史 +
  知识库向量检索 + 群聊长上下文。**形态是「助手式」,没有陪伴型长时记忆/情绪/想念。**

**薄壳实际只用了很小一片**:`Star` + `initialize/terminate` + `@filter.event_message_type` +
读 `AstrMessageEvent` 字段 + `event.stop_event()` + `Context.send_message(umo, MessageChain)` +
`Context.platform_manager.get_insts()` + `metadata.yaml`/`_conf_schema.json`
(`astrbot_adapter/main.py:31-42,155-201,224-230,320-323,592-607`)。
**完全没碰 pipeline 内部、provider、persona、db。**

> **唯一结构性风险**:平台框架**默认自己会答**(原生 LLM 链路),所以「接管」必须是
> 显式开关,且授权坏掉时**不能回落、只能挡住** —— 薄壳已经这么做了
> (`enabled=false` 默认不接管 + 401 时宁可挡下也不放行)。

### 7.2 koishi(4.18.11)

- `Context` 是全部:继承 `@satorijs/core` 的 Context,再继承 **cordis** 的 Context
  (`packages/core/src/context.ts:50`)。四大抽象:**Context / Service / Event / Session**。
- **与 DSH 同源**:koishi 依赖 `cordis ^3.18.1`,DSH 依赖 `@deepseek-ai/cordis 4.0.2`。
  共同思想:**一切皆 Context、一切皆 effect 作用域、事件驱动、服务按名 provide/inject、
  可整树 fork/dispose**。
- **区别在「插件表怎么长出来」**:koishi 用 Loader 的 `plugins` 树(运行时从配置挂/卸,
  支持 `group`/`~` 禁用/`$if`/`$filter`);DSH 用 **`cordis.patch.yml` 声明式补丁**。
- **跨平台**:平台抽象在 `@satorijs/core` —— `Adapter`/`Bot`/`Session`/`MessageEncoder` +
  统一消息元素 `h`/`Fragment`;业务插件只对 `Session`/`Context` 编程,完全不感知平台。

**koishi 有、DSH 没看到等价物的**:完整指令系统(argv 解析/别名/权限位)、i18n、
`Computed`/`Eval` 式插件过滤器、minato ORM。
**DSH 强而 koishi 弱的**:严格的服务 ownership 与 disposal 审计、goal/session/jobs 一等域对象。

**要做多平台值得抄的**:① satori 的 Adapter/Bot/Session 三层 + 统一消息元素(★★);
② koishi 的**插件级 filter**(`fork.parent.filter`,`loader/src/shared.ts:349-352`)——
「哪棵插件子树对哪些 session 生效」的声明式模型(★★)。

---

## 八、情感计算(3 项)—— 关键判断

### 8.1 三个项目

| 项目 | 表示 | 算法 | 词典规模 |
|---|---|---|---|
| `cnsenti` | 离散 7 类词频 + pos/neg 连续分 | jieba + set 查表;程度副词乘数 + 否定奇偶反转 + 感叹号 +2 | 好 11081 / 恶 10262 / 哀 2312 / 乐 1967 / 惧 1176 / 怒 389 / 惊 227 |
| `Text2Emotion` | **单一连续标量** `emotionNum` | 讯飞 LTP 分词 + 本地词典 | **`emos.json` 27315 词**,含 strength(1/3/5/7/9)+ polarity + 21 类码 |
| `EA-master` | 离散类别 / 8 维多标签 | Python2 + TF1;BiLSTM+Attention;Calibrated Label Ranking | **仓库内无任何数据文件** |

**实测交叉验证**:cnsenti 的 7 个 set 就是 `emos.json` 的 7 类归并版 ——
惊=PC **227/227 全等**、怒≈NA 387/389、好≈PH 8555/11081、恶≈NN 7563/10262、
哀≈NB 1493/2312、乐≈PA 1344/1967、惧≈NC 704/1176。
**结论:要词典就用 `emos.json`,不要用 cnsenti 的 pkl**(后者是它的降级投影,
只有词、没有 strength/polarity 字段)。

**EA-master 唯一高价值点**:`Emotion_GRU_att_add_emotion_relation_wheel.py:190-204` ——
一张 **8×8 先验情绪关系矩阵 `omiga`**(对角 1,跨类 ±0.5/±1)作为正则项进损失,
约束维度间关系。**这是三个项目里唯一处理「情绪维度之间结构」的东西。**

### 8.2 关键问题:传统路线值得引入吗?

对照 dsh-echo 现状:情绪由 EXTRACT 提示词让 LLM 顺带打分(`lib/reflect.js:45-67`),
7 维范围见 `lib/emotion.js:31-37`。

**① 廉价实时预判:可做,但只能一维、只能当提示。**
纯查表、零 LLM、零网络,成本近乎零。但 7 维里**只有 `valence` 与词典同构**,
`affection/dependency/playfulness/sadness/fatigue/arousal` **词典根本测不到** ——
它们是关系性/生理性维度。且对话文本形容词稀疏(cnsenti 作者自认「这手机很耐摔」得 pos=0)。
→ **只值得做 valence 的符号级预判,不值得为它建任何服务。**

**② 校验/校准 LLM 情绪(防漂移):值得做,这是最实的用法。**
方案:用 `emos.json` + jieba 求 `s = sign(Σ正strength − Σ负strength) ∈ {−1,0,+1}`;
当 `s<0` 而 LLM 给 `valence ≥ 3`(或反之)时,审计里记一条
`lexicon_valence_conflict`。**只标记、不改向量**(已有 `emotionDelta`
`lib/emotion.js:103-116` 与审计列,加一列成本极低,不引入新依赖)。
**边界:只能符号级,不能幅度校准** —— strength 是 1/3/5/7/9 离散档,
与 0~10 连续维度无可比标度。

**③ 本体库当锚点:只对一半。**
本体库给的是**情绪类别**而非**情绪维度**,映射会丢信息。可用锚点只有:
好/乐→valence 正、恶/怒→valence 负、惊→arousal 高。
名字能对上的 `哀` 与 dsh-echo 的 `sadness` 语义不同(后者是「对<称呼>的委屈」)。
→ **不建议**用 7 类计数当锚点:计数是「文本里出现过几个情绪词」,
与「Echo 此刻的心情」不是同一个量。

**④ 明确不值得做的两件**:
(a) **不要把 EA-master 的 BiLSTM/CNN 搬进来** —— Python2+TF1 与 Node 侧不同栈,
要靠标注语料训练而仓库里连数据都没有;更关键是**任务错配**:它读「文本的情绪类别」,
dsh-echo 要写「Echo 自己的情绪状态」—— **前者是识人,后者是自省**。
(b) 不要把 cnsenti 的 7 类计数当向量锚点。

**唯一值得抄 EA-master 的**:把 `omiga` 思路手写成 **7×7 先验表**,
在 `clampEmotionVector`(`lib/emotion.js:85-97`)之后做一次**轻量一致性提示**
(如 `valence` 高同时 `sadness` 高 → 记一条矛盾审计),零模型零依赖。

**⚠️ 许可提醒**:大连理工本体库商用需邮件协商(`chinese_readme.md:30-36`);
个人自用无碍,若发布需在文档里声明出处。

---

## 九、横向总结:dsh-echo 站在哪

### 9.1 三层能力对照

| 能力 | 21 项里最强的 | dsh-echo | 判断 |
|---|---|---|---|
| **遗忘数学** | giftia(指数,贴原版) | **DMAE 幂律,工程化最好** | **领先** |
| **想念/主动** | Mio(随机窗)、aura(价值网络) | **`M(s)=10s/(s+H)` 连续曲线** | **领先** |
| **关系性情绪** | — (pad 无 target 层) | **7 维向量 + global/target 分层** | **独有** |
| **情绪单轮闭环** | **pad-emotion(异步 waterfall 同轮生效)** | 注入上一轮快照 | **落后** |
| **记忆治理** | Mio(候选箱/时间五态)、auto-memory(认识论状态) | 四层置信度门控 + 隔离 | 各有千秋 |
| **检索** | **auto-memory(三臂 RRF + 决策解耦)**、my-neuro(向量+精排) | 六档关键词 | **落后** |
| **可观测性** | **Cyrene-main(TraceStore)**、auto-memory(分项账本+降级标注) | audit_logs + SSE 半推 | **落后** |
| **契约版本** | **Cortico(不符即拒载)** | `echo_wire_v1` 只是名字 | **落后** |
| **注入位置工程** | **roleplay / maid / auto-memory / pad-emotion(4 家都用 `context()`)** | 全在系统提示层 | **落后** |
| **降级链** | — | **三态降级(python→基线→offline)** | **独有** |
| **审计黑匣子** | — | 27 种 tool_call 全留痕 | **独有** |
| **人格不陪葬** | — | 全仓 try/catch 密度 | **独有** |

### 9.2 生态惯例(四小插件 + 宿主共同套路)

**一个 cordis 插件行(`cordis.patch.yml` 的 `insert`)+ `package.json` 的
`dsh.bundle.patch` 声明 + 可选 `dsh.client` 浏览器半区**;能力落在五类挂点:

1. `ctx.systemPrompt.section/variable/context` —— 人格与上下文
2. `ctx.tools.register` —— 模型可见工具
3. `ctx.settings.register` —— 配置与 UI 卡片
4. `ctx.on('agent/pre-step'|'agent/turn-stopping'|'session/event')` —— 轮次干预
5. `ctx.webServer.register` —— 自有 HTTP 面

> **重要惯例**:settings 命名空间对 Web 有**硬编码白名单**,第三方插件一律得自建通道 ——
> cosplay 用 typert Remote、roleplay 用 `/x-roleplay`、maid 用 `/dsh-humanized-maid`、
> **dsh-echo 用 `/api/echo/*` + `/echo` 前缀**。**dsh-echo 的做法与生态一致。**

**生态惯例总结**:人格注入用**段/变量**、记忆注入用**消息尾部**、
配置用 **settings 命名空间**、UI 用 **slots**。

### 9.3 可借鉴清单(按优先级)

#### ★★★ 立刻值得做

| # | 借鉴 | 出处 | 对 dsh-echo 改什么 |
|---|---|---|---|
| 1 | **`systemPrompt.context()` 贴近消息尾部注入** | roleplay `agent.ts:199-250` / maid `index.mjs:406-474` / **auto-memory `index.js:8774`** / **pad-emotion `index.js:816`** | 把「此刻状态 + 悬置话题 + 想念行」从 `echo:snapshot`(系统提示层)挪到尾部 user 快照;系统提示保持字节稳定以命中前缀缓存。**四个同生态/同类插件独立选了同一条路** |
| 2 | **系统提示稳定 + 记忆只动尾部** | maid `index.mjs:350-353` | 同上;`echo:persona`/`echo:rules` 已字节稳定,但 `echo:snapshot` 每轮变 |
| 3 | **异步 waterfall + `Promise.race` 超时旋钮** | pad-emotion `index.js:833-846` | 让「他这句话惹到她了 → 下一句回复就带情绪」成为可能;超时用旧状态、打分稍后照写 |
| 4 | **旧记忆按当前称呼重贴标签** | maid `index.mjs:216-231` | 治「他改了称呼,旧记忆把她带偏」 |
| 5 | **候选箱(0.55~0.75 隔离、永不进上下文)** | Mio `memory_service.py:183-239` | dsh-echo 已有 `quarantined` 状态,但**没有「待确认晋升」的显式通道** |
| 6 | **时间三分注记(发生/得知/记录维护)** | Mio `memory_service.py:344-352` | 记忆渲染时逐条注时间语义,治「把旧事当新事」 |
| 7 | **`[降级]` 显式标注 + 分项账本硬不变式** | auto-memory `tier-layer-inject.js:13-15` / `memory-envelope.js:18-24` | 注入信被裁光/引擎降级时**说出来**,而不是静默少一段 |
| 8 | **决策/排序解耦 + 校准阈值 + 滞回** | auto-memory `recall-fusion.js:10-12` | RRF 分只排序,「是否注入」用绝对分比阈值 |
| 9 | **思考风格双档(干活时中立思考)** | cosplay `store.js:142-145` | Echo 现在全程角色化思考,可给「干活时中立」一档 |
| 10 | **`sidebar.right.pane.tab` 插槽** | 宿主 `slots.zh.md:172` / pad-emotion `client.js:668-678` | 把 `/echo` 仪表盘做成右侧栏原生标签页 |
| 11 | **可旋转三维可视化 + `__internals` 离线断言** | pad-emotion `client.js:113-697` | 7 维退化为「3 主轴立方体 + 4 维雷达」;面板「真的画出来了」可离线断言 |
| 12 | **派生字段现算不存 + UI 词与模型词同源** | pad-emotion `state.js:63-71` / `describe.js:1-11` | 治 dsh-echo 面板与引擎措辞不一致 |

#### ★★ 值得排期

| # | 借鉴 | 出处 |
|---|---|---|
| 8 | `tools/pre-execute`/`post-execute` 审计**全部**工具调用 | 宿主 `tools.zh.md` |
| 9 | **契约版本协商 + 能力探测**(他们严格相等即拒;我们取**数字区间 + 能力名**,双向拒会锁死两仓发布顺序) | Cortico `EXTENSION_API_VERSIONS`(`manifest.ts:17-21,113-117`) |
| 10 | **不可变运行快照** | Cyrene-main `RunToolCatalog` |
| 11 | **trace 结构化**(父子关联 + 耗时 + 保留期清理) | Cyrene-main `harness-trace` |
| 12 | **`uncertainEffects`** 保护不可重试副作用 | Cyrene-Agent |
| 13 | **`ephemeral_context`**(大块状态不进长期记忆) | neuro-sdk `SPECIFICATION.md:159` |
| 14 | **插入优先级四档**(她正在说话时怎么插) | neuro-sdk `:160` |
| 15 | **开口前的事件过期失效检查** | Mio `proactive_service.py:588-592` |
| 16 | **话题去重惩罚** | Mio `:379-432` |
| 17 | **CrossEncoder 可选精排**(默认关、缺失回退) | my-neuro `search_utils.py:481-508` |
| 18 | **画像候选池跨天多次证据才晋升** | my-neuro `user-profile/index.js:374-396` |
| 19 | **传感器/webhook 外部唤醒源** | aura-scheduler `sensors.ts` |
| 20 | **防抢话/防重复/禁词清单** | roleplay `prompts.ts:52-110` |
| 21 | **7×7 情绪先验一致性提示** | EA-master `omiga` 矩阵 |
| 22 | **词典符号级校验 valence**(只标记不改) | cnsenti / `emos.json` |
| 23 | **日记缺口补写 + 指数退避** | Mio `daily_diary_service.py:150-158` |
| 24 | **preset 文件 + generated-by 标记** | roleplay `presets.ts:129-145` |
| 25 | **兼容层符号探测**(宿主升级不打死插件) | roleplay `dsh-compat.ts` |

#### ★ 锦上添花

`systemPrompt.variable()` 变量化人格段 · `agent/disposed` 清理 ·
`subagent/start|end` 留痕 · `goal/activation-changed` 心跳降频 ·
`conversation.chat.turnTail` 状态徽章 · `conversation.input.dock` 主动按钮 ·
`shell.overlay` 全局悬浮 · `settings.plugins.tab` 独立设置页 ·
off-peak 省钱窗 · `Injection` 优先级表 · 输出黑名单过滤 ·
satori 三层适配器抽象 · koishi 插件级 filter · 零依赖二元组召回(降级路径)

### 9.4 明确**不该抄**的

| 不抄 | 为什么 |
|---|---|
| EA-master 的 BiLSTM/CNN | Python2+TF1 不同栈;**任务错配**(识人 ≠ 自省) |
| cnsenti 的 7 类计数当锚点 | 计数 ≠ 心情,不是同一个量 |
| giftia 的 `S×24+1` 遗忘式 | 无半衰期语义;DMAE 的 `R(H)=0.5` 更可解释 |
| giftia 的「分层」 | **实测未接线**(新记忆恒 REGULAR) |
| Mio 的随机静默窗 | 拿不出「为什么现在开口」的数;想念曲线可解释 |
| Mio 的单体形态 | 4719 行 `db.py`、提示词硬编码在服务层,难演进 |
| Neuro-master 的整段取消 | 没有残句记忆;dsh-echo 的 barge-in 残句更好 |
| aura 的假 interruption 代价 | 注释自称 placeholder;但**思路**可抄 |
| 把人格写死在常量里 | Neuro-master `constants.py:66-78`;dsh-echo 人格资产外置是对的 |

---

## 十、未核实项(诚实标注)

1. **`dsh-auto-memory` / `dsh-pad-emotion` 的未读部分**:
   auto-memory 的 `lib/index.js` 全部 10230 行未逐条读(仅按 grep 定位读片段);
   `worker_semantic_v1.py` 内部算法未逐行读;`docs/` 178 个 md 只读了约 10 份;
   47 条 HTTP 路由未逐条读 handler 主体;L0 向量索引的**回读接线**未确认。
   pad-emotion 的整体覆盖较全(30 文件)。
2. `AstrBot_src` 与 `AstrBot-master` 内容一致(均 1747 文件),但**未逐文件 diff**;
   `AstrBot_src` 带 `.git`。
3. 参考副本宿主 **0.1.6-alpha.2** vs 现役 **0.1.5-rc.3** ——
   事件/插槽清单以**参考副本文档**为准,「现役有没有」只复核了 `system-prompt` 包;
   **其余 API 未逐项在现役宿主复核**。
4. `emos.json` 的码值无中文标签;`PA=乐/PB=好/NA=怒/NB=哀/NI=惧/NE=恶/PC=惊`
   来自 `EA-master/Classification/multi_class/Rule/chi_dic/kafang.py:105-106`,
   属**跨项目推断**;`惧≈NC` 同样未核实。
5. `my-neuro` 的 TTS/BERT 具体模型与调用链未逐行读;
   `AI记录室/记忆库.txt` 为空文件。
6. ~~`Cortico` 的三个参考 Persona 实现、`templates/extension/`、`src/core/loop.ts` 逐行未读。~~
   **2026-09-28 已补**:见 `docs/REFERENCE_CORTICO_2026-09-28.md` —— 三个参考 Persona、
   `templates/extension/`、`loop.ts`(结构 + 6 段关键实现)均已覆盖;仅 `src/providers/**` 与
   `src/protocol/open-responses/**` 仍未读(主动砍:模型端点/计费不归我们管)。
7. `Cyrene-Agent` 的 `src/renderer/**`、`native/`、`vendor/cyrene-skills` 未读。
8. `Cyrene-main` 的 `harness-input` 记忆/压缩、`harness-agent` 子 Agent、`sql/`、
   `docker/`、`harness-server` 路由未读。
9. 三个框架的**测试代码**基本未读。
10. `neuro-sdk` 的 `speech_finished` 在 Unity SDK 源码中**未找到对应 handler**
    (grep 零命中),可能只由服务端发送、SDK 未实现。
11. `Neuro-master` 的前端仓库 `neurofrontend` 不在本目录。
12. `koishi` 的 `@satorijs/core` 内部实现不在本仓库,跨平台结论基于 re-export 与
    mock adapter 用法。
13. `AstrBot` 是否另有内置陪伴型记忆插件 —— 仓库内 `builtin_stars/` 只有
    `astrbot` 与 `builtin_commands`。

---

## 附注:同生态两项的取向小结

`dsh-auto-memory` 与 `dsh-pad-emotion` 代表 DSH 生态的两种取向,恰好也是 dsh-echo 的两条腿:

- **auto-memory = 工程化记忆基础设施取向**:文件即真相、索引/分层/预算/审计/容错,
  甚至配了离线金标与两篇论文。**它的强项全在「检索工程」(三臂 RRF、决策/排序解耦、
  校准阈值、分项账本、`[降级]` 标注),弱项全在「记忆动力学」(无时间衰减)。**
- **pad-emotion = 可计算心理模型取向**:把情绪形式化成 1331 格可枚举状态机 + 可视化 +
  单轮闭环,**宁可贵一次模型调用也不退回关键词**。**它的强项全在「一轮闭环」
  (异步 waterfall、超时旋钮、网格残差、同源措辞),弱项在「无 target 层」。**

**共同点**:都强调**可观察、可审计、降级不静默**。

**对 dsh-echo 的意义**:echo 恰好与两者互补 —— 记忆动力学赢(auto-memory 没有)、
关系性情绪赢(pad 没有 target),但检索工程与单轮闭环要补。这三者拼起来,
就是 dsh-echo 下一阶段最完整的改进面。

> 交叉发现:`auto-memory` 的 `systemPrompt.context(order:10000)` 与
> `pad-emotion` 的 `context(order:8600)` **都用了 dsh-echo 完全没用的 `context()` 插槽** ——
> 两个同生态插件独立选了同一条路。这是 §9.3 第 1 条最有力的旁证。
