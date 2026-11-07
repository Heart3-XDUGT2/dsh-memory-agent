# 队友情绪插件评审：`dsh-pad-emotion` / `dsh-interpersonal-circumplex`

> 评审对象：`$env:USERPROFILE\Desktop\情绪队友源码\`（两份发送包，2026-09-27 收到）
> 评审纪律：**全程只读** —— 不安装、不执行插件本体、不写入对方目录（只用 `read`/`grep`/`glob` + `node --check`）。
> 证据纪律：结论带 `文件:行号`；队友自测的数字标「(队友实测,未复核)」；**我复核过的**标「(本仓复核)」；**子代理逐行核实**的标「(深挖核实)」；下不了的判断集中在 §9。

---

## 0. 一页结论

| 维度 | 评价 |
|---|---|
| **理论功底** | ★★★★★ 建立在可引用文献上（Mehrabian PAD / Wiggins IPC），而且**主动纠正常见错误**：PAD 纠正了八象限配对；IPC 有「五处常见说法是错的」整节，并区分 `[F]` 已抓原文 / `[S]` 仅核到文献记录，还点名**「已确认不存在」的论文**。这一层比我们 Echo 的情绪层强。 |
| **工程成熟度** | ★★★★☆ 网格+残差、并发去重、schema 装载坑、失败也写审计、原子落盘 —— 大量细节只有真跑过才知道。**但自检电池整包没发过来**（§3），这些主张目前**无法复现**。 |
| **诚实度** | ★★★★★ 自列「已知限制」十条（PAD §9）与「还没有核实的东西」七条（IPC §13），包括「NRC-VAD 商用要授权」「这条升级机制没有一手来源，只是建模选择」。 |
| **代码层瑕疵** | ★★★☆☆ 有两类可点名的问题：①**静默失效**（趋势行永不出现、`promptOrder` 死配置）②**并发/多会话串味**（与 Echo 之前的群↔私聊串味同一类）+ 若干 README 与代码不符（§4）。 |
| **与我们 Echo 的关系** | **互补 > 重叠**，但有一条正面冲突：**它在回复路径上阻塞等一次打分（同轮生效），而我们的情绪滞后一轮**（§5）。同装 = 每轮多两次阻塞打分 + 三套情绪块同时注入（§6）。 |

**三个决定（需要你裁决）**：① 要不要借"同轮生效"的时序方案？② 要不要装（先只装 PAD、且在独立实例上验证）？③ 要不要向队友要回 `test/`+`scripts/`？

---

## 1. 两包是什么（事实层）

| | `dsh-pad-emotion` | `dsh-interpersonal-circumplex` |
|---|---|---|
| 自述 | 单角色 PAD 三维情绪状态机 + 可旋转三维面板 | **双人**关系状态机（人际环形模型）+ 圆盘面板 |
| 规模 | 10 个 `.js`（`index.js` 1366 行 / `client.js` 678 行） | 12 个 `.js`（`index.js` 1761 行 / `client.js` 935 行） |
| 状态空间 | `[0,1]³`，0.1 精度 → 11³ = **1331 格** | `[0,1]²` 的**内切圆盘**，0.1 精度 → 可达 **81 格**（`core/circumplex.js:676`；README `:211-228` 有推导） |
| 轴 | P 愉悦 / A 唤醒 / D 优势（Mehrabian & Russell 1974） | DOM 掌控 / LOV 联结（Wiggins；`README.md:89-113`） |
| 词表 | **51 条**锚点（文献 48 + 定义 1 + 估计 2） | 姿态锚点 33 条 + **关系状态词 178 条**（文献 44 / 自拟 134） |
| 独有机制 | 分轮 LLM 打分器；网格+残差；`lastTarget` 采信打分词 | `reciprocity/correspondence/complementarity` 等 6 个关系量；非互补升级 `escalation` |
| 落库位置 | `$DSH_HOME/pad-emotion/state.json` + `emotion.jsonl` | `$DSH_HOME/interpersonal-circumplex/state.json` + `relationship.jsonl` |
| 许可 | MIT，但占 48 条文献值里 29 条的 **NRC-VAD 商用需 NRC 同意**（`README.md:653-654`） | MIT |

**两者完全独立**：无互相 import（IPC 包内 "pad-emotion" 只出现在注释里，PAD 包内搜 `interpersonal|circumplex` 零命中），数据目录分开。唯一协同是 prompt 顺序 —— 由 `bundles` 数组 → waterfall 注册顺序决定，关系块落在情绪块之后。

两包共享同一套设计 DNA（0.1 网格 + 内部残差、惯性 `reactivity`、**刻意不做时间衰减**、失败写审计、发送包适配），应是同一人的手笔。

---

## 2. 设计主张 → 核实结果

### 2.1 打分时序（整包的核心）

主张：打分挂 `agent/inbox/spliced`，在 `system-prompt/assemble` 里 `await`，实现**同轮生效**。

| 主张 | 核实 |
|---|---|
| 钩子挂对 | ✅ PAD `index.js:993`(inbox/spliced) / `:1099`(async waterfall)；IPC `index.js:1148` / `:1244` |
| 超时兜底 | ✅ `sleep`(`index.js:1086`) + `Promise.race([run, sleep(appraiseTimeoutMs)])`(`:1104`,`:1138`)，默认 2500ms(`:181`) |
| 「`appraiseTurns` 曾是死配置」的自述 | ✅ 真的：`index.js:648` 注释与 `:653-654` 现在的读取代码对得上（**本仓复核**：`index.js:653` 确在 `slice(-config.appraiseTurns * 2)`） |
| 只读工具注册 | ✅ `index.js:1157` `name: 'pad_emotion'`；IPC `:1300` `interpersonal_circumplex` |
| 状态落盘为投影、内存为真源 | ✅（深挖核实）PAD `core/state.js:132` + `index.js:439-441`；IPC `core/state.js:198-202` + `index.js:676-705`（750ms 防抖 + tmp→rename 原子写） |
| 前端半侧 | ✅ `package.json` 的 `dsh.client.platform=web` + `client.js` 经 `__ModuleLoader__` 注册侧栏页与两个 slot |

**代价（队友实测，未复核）**：关思考后中位 **979ms**（p90 1027ms，2500ms 命中 100%）；开思考中位 **2307ms**（p90 3387ms，命中 58%）。因为 `await` 在装配里，**这段时间加在回复的关键路径上**。

⚠️ **首轮更贵**（深挖核实）：PAD 在首轮会**打两次分** —— `agent/inbox/spliced` 一次，装配时按角色卡再补判一次（`index.js:1113-1141`），各等最多 2500ms → **最坏 +5s**。

### 2.2 状态机细节

- 更新式 `next = cur + (clamp01(target) − cur) × reactivity × gain`，单轴步长 ≤ `maxStepPerTurn`(0.4)，再 `clamp01`（PAD `core/dynamics.js:120-145`；IPC `core/dynamics.js:199-244`）。
- `reactivity: 0.8` 是**从网格反推的下限**：低于约 0.71 时「离中心一格」的打分推不动状态。
- 0.1 落格 `Math.round(v*10)/10`；内部另存残差 `latent = clamp01(grid + residual)`，避免 `+0.04` 的微调被永久抹掉（PAD `core/dynamics.js:197-217`）。
- **不做时间衰减**，三条理由（需求没用 / 时间项让状态不可复现 / 会带来一整套补丁），并断言：`appraisal: null` 时逐轴不变；状态文件多旧恢复出来都逐轴相同。

### 2.3 理论核对（两包各有一批纠错，逐条有出处）

- PAD：八象限表第一版配错（焦虑↔厌倦、敌意↔轻蔑整体对调），依据 Mehrabian 官网原文 + 两篇文献；最硬自检用 Mehrabian 自己的 `bored = (−0.65,−0.62,−0.33)`（`README.md:57-75`）。
- IPC：`README.md:232-256` 列五处常见说法为**错** —— elevation ≠ vector length；`correspondence` ≠ 两轴都相同（那是 `similarity`）；**互补 = 沿联结轴镜像，不是旋转 180°**（只在 `PA–HI` 重合）；octagon ≠ Wiggins 八分仪；Wiggins (1979) 没命名 agency/communion。
- 并标注**「已确认不存在」的文献**：「Francis, Jackson & Brown」（`README.md:693`）。

**文献真伪我没有独立查证**（§9），我认可的是其**内部一致性**与引注纪律。

---

## 3. 交付缺件：自检电池整包没发过来 ★

两份 `package.json` 的自检入口**全部指向不存在的目录**：

| 包 | `npm run check` 调用 | 在包里吗 |
|---|---|---|
| PAD | `test/**/*.test.js`、`scripts/smoke.mjs`、`scripts/client-smoke.mjs` | ❌ 全无 |
| IPC | `test/core.test.js`、`scripts/{check-loadable,check-config,probe-core,probe-geometry,probe-prototypes,client-smoke}.mjs` | ❌ 全无 |

（**本仓复核**：递归列目录只有 `core/`、`docs/`；`.gitignore` 只忽略 `node_modules/` 等，**没忽略 `test/`**。（深挖核实）子代理用 glob + `Test-Path` 双向确认，并实跑 `node --check`：PAD 10 个 js、IPC 12 个 js **全部语法通过**（node v24.21.0）。）

**后果（不是小事）**：

1. README 里最有价值的证据**全部无法复现**：PAD 称「`test/core.test.js` 钉住残差进位」（`README.md:309`）；IPC 称「82 项单测 + `check:loadable` 五项全过」（`:395-403`）。
2. IPC 自己认定「**其它检查全绿也不能保证 `dsh web` 起得来**」，把 `check-loadable` 排第一位（`:405-406`）—— 而这一个恰好没发。它踩过的三个装载坑（缺 `node_modules/@deepseek-ai` junction、静态 import 失败打死 harness、`items` 上标 `required` → `UNSUPPORTED_SCHEMA`）**都会让 `dsh web` 起不来**（`:428-436`）。
3. PAD 引用 `scripts/verify-no-think-wire.mjs`（`:247`）证明"关思考"链路 —— 同缺。
4. **两包的装载加固不对称**：IPC 有 `dsh-deps.js`（动态 import + try/catch，缺依赖时打 warn 返回而不打死 harness，`dsh-deps.js:42-79`）；**PAD 没有**，它是静态 `import`，且 `package.json` 的 `peerDependencies` 里**漏了它正在 import 的 `@deepseek-ai/dsh-tools`**（`index.js:61`；**本仓复核**：PAD `package.json:46-53` 确实没有 `dsh-tools`，而 IPC `package.json:59` 有）。

> **建议动作**：向队友要 `test/` + `scripts/`，或让他跑一遍 `npm run check` 贴原始输出。否则答辩里这两包只能"读代码相信"，不能"复现验证"。

---

## 4. 代码层找到的具体瑕疵

### 4.1 确定是问题（建议反馈）

| # | 包 | 问题 | 证据 |
|---|---|---|---|
| 1 | PAD | **「强度趋势」行永远不出现**：`renderForPrompt` 需要 `previousIntensity` 才能出「情绪正在增强/平复」，而唯一的调用点从不传它 | `core/describe.js:154-160`（`previousIntensity === undefined ? ''`）+ `index.js:1055-1070`（**本仓复核**：传的是 `point/reason/triggerWord/displayWord/options`，无该项）；README `:276` 却把它列为状态块内容 |
| 2 | PAD | **`promptOrder` 是死配置**：定义 8600、注释宣称按它排序，实际 entry 只有 `{name,text}`，从不被读 | `index.js:131` vs `:1145`（深挖核实：全文件仅 3 处命中） |
| 3 | PAD+IPC | **多会话/并发串味**：`activeSessionId` = 最后碰过的会话，注入时只读它；`pendingAppraisal` 单槽并发互相覆盖 | PAD `index.js:454,969,983,1057,583,766`；IPC `index.js:649,768,1210-1211`（IPC 开局路径有 mitigation `:1256`，块本身没有） |
| 4 | IPC | **HTTP 无鉴权**，且 `GET /state?session=<任意>` 会经 `read()→ensure()` **创建并落盘**一个新会话条目 → 本地页面即可灌水 | `core/state.js:230-238`、`index.js:1793,1796,1821` |
| 5 | IPC | **内存增长不一致**：`sessionPersona`、`sessionRoutes` 无上限，而同类的 `claimedMessageIds`/`sessionOpened`/`personaSeeded` 都有 200 上限 | `index.js:1026,766` vs `:973,1036,1045` |
| 6 | PAD | `state.json` 损坏只 warn 后**空状态启动、不备份**；`fromJSON` 不校验 `residual` 类型，坏值会在 `composeLatent→clamp01` 抛 TypeError（**推断，未运行验证**） | `index.js:569-573,470-497`；`core/dynamics.js:200` |
| 7 | IPC | 自有 API 口径不自洽：头注释写 121 格，实际盘内 81；`/lexicon` 回 `cells:121` | `index.js:12,53,1806` vs `core/circumplex.js:676`、`index.js:1455`（README `:11` 是 81，正确） |
| 8 | IPC | `normalizeScale` 整组判双极：任一轴为负，会把另一轴的 0.8 当双极读成 0.9 | `core/appraise.js:393-404` |

### 4.2 README 与代码不符（要改文档，不是改代码）

- PAD `README.md:97` 写 `nrc-vad-0-1` **30 条** → **本仓复核实测 29 条**（mehrabian 11 / rm1977 5 / cas 3 / nrc **29** / definition 1 = 49 条带 `scale`，加 2 条估计 = 51 ✓）。那张表自己加起来是 50，与同文档 `:85` 的「48+1+2=51」也不自洽。
- PAD `README.md:542` 写「66 项核心单测」 vs `:552`/`:674` 写「75 项」。
- PAD `README.md:353` 写打分输出上限「400」 vs 代码 4096（`:207`；README `:596-604` 记的正是"400 翻车"的修复史）。
- PAD `README.md:515` 说默认走 nothink 路由 vs 发送包已置空（`:71,76`）。
- PAD 审计样例里的 `decayed` 字段（`README.md:443,455`）在 `compactTransition`（`:334-346`）里不存在。
- PAD `package.json` 依赖既多又少：漏 `dsh-tools`(`index.js:61`)、漏 `schemastery`(`:62`)，多列未用的 `dsh-session`。
- PAD `client.js:438` 默认自转 + `rAF` 常驻重绘，与 `:507` 注释「静止不烧 CPU」不符。

### 4.3 值得点名的优点（别只挑刺）

- 解析容错：`extractJsonObject` 两级救援（剥围栏→严格 parse→按字段正则捞、标 `__salvaged`）—— 凡"让模型回 JSON"都该这么写。
- **失败也写审计**（`appraise-error`/`appraise-request`）—— README `:612-616` 记着"我一开始是靠读代码猜的，直到加了失败审计才定位到问题"。这条经验我们该抄。
- IPC 的 `dsh-deps.js` fail-soft（PAD 没做，见 §3.4）。
- IPC 把「坐标↔语言」收敛成**唯一转换点**（`core/match.js`），派生字段现算不落盘 → 根治"面板显示"与"模型看到"分叉。

---

## 5. 与 Echo 情绪层的对比 ★

### 5.1 我们的现状（本仓复核）

- 维度：`global{疲惫,心情,唤醒度}` + `target_master{爱意,调皮,委屈,依赖}`（`lib/emotion.js:31-43`；v0.29.0 已砍 `target_group`）。
- 产出者：**`echo-extract` 独立 LLM 调用**，输入是**本轮已完成的转写**（`lib/reflect.js:236` 拼 `'AI：' + t.assistant`、`:244` 传「上一轮结束时的情绪向量」、`:248` `runStructured(... label: 'echo-extract')`）；落库 `lib/engine.js:267`。
- 注入：`lib/context.js:208`「上一轮结束时你的情绪强度是 prev/10，这一句之后变成 current/10」。

### 5.2 关键差异：**我们滞后一轮，它同轮生效**

extract 需要**本轮的回复文本**才能跑（`reflect.js:236`），所以结算必然在回复之后 → 本轮注入的情绪是**上一轮**结算出来的。

这正是 PAD 修掉的那个 bug 的同款。`README.md:256-259`：

> 宿主的 prompt 在用户消息落库**之前**就装配定稿了（实测事件顺序 `step/start → system 提示词 → user/message → 请求`）。所以挂在 `user/message` 上打分，这一轮永远赶不上——「惹角色生气的那句话，不会让它紧接着的回复带情绪」。

| | Echo（现在） | PAD / IPC（队友） |
|---|---|---|
| 情绪从哪来 | 回复**之后**的 `echo-extract`（结构化 JSON） | 回复**之前**的独立打分调用 |
| 是否滞后 | **滞后一轮** | 同轮生效 |
| 关键路径开销 | 0（extract 在回复后） | 中位 ~1s（关思考）/ ~2.3s（开思考），超时 2.5s；首轮最坏 +5s |
| 失败时 | 停在上一轮状态 | 停在上一轮状态 + 落审计 |
| 粒度 | 连续值 + 0–10 强度 | 0.1 网格（+内部残差） |
| 理论出处 | 手搓（爱意/依赖/委屈…） | 可引用文献 + 锚点出处 |
| 对象粒度 | 按对象分桶（对主人…；曾分对群，v0.29.0 已砍） | 只有 sessionId 单桶 |

**判断**：同轮生效这件事，PAD 的方案（装配期 `await` + 超时兜底 + 挂 `agent/inbox/spliced`）是**正解**，也是我们最该借的一条；付不付"每轮 +1 次调用、+1 秒关键路径"这个价，是你的裁决。也可以只借一半：装配期用**不调模型**的便宜判定，或保持滞后一轮但把 `context.js:208` 的措辞写准。

> （未核实）extract 与下一轮装配之间的**逐条事件顺序**我没有在活库逐行对齐；上面结论的根据是 `reflect.js:236/244` 需要回复文本 + `context.js:208` 的措辞。要在活库坐实，得拿相邻两轮的审计行比时间戳与 `emotion_vector` 快照。

### 5.3 值得借的（按性价比）

| # | 借什么 | 为什么 | 怎么借 |
|---|---|---|---|
| 1 | **同轮生效的时序**（inbox/spliced + waterfall await + 超时） | 修掉我们"滞后一轮"的根因；DSH 事件顺序他们已经实测过，省我们摸索 | 照抄时序，判定器可换成便宜的本地判定 |
| 2 | **网格+残差** | 我们 `clampEmotionVector` 后微调会被抹掉，持续温和的推挤永远推不动 | 纯函数思路，移植进 `lib/emotion.js` |
| 3 | **解析救援 + `salvaged` 留痕** | 凡是让模型回 JSON 的路径都该有（我们有 `echo-extract`） | 照抄思路 |
| 4 | **失败也写审计** | 把"这轮情绪为什么没动"变成可答问题 | 我们已有部分，检查覆盖度 |
| 5 | 「已知限制/诚实清单」的写法 | 答辩加分项，与我们文档风格一致 | 照搬进 `docs/` |
| 6 | IPC 的 `reciprocity/correspondence/complementarity` 三分 / 178 词状态表 | 我们把"关系"散在 `graph_edges`/`longing` 里，没有可解释的关系量 | **概念层**借鉴；词表可直接搬，别重造 |

### 5.4 不该跟着改的

- **砍掉时间衰减**：他们砍的理由是"单次会话里惯性够了 + 时间项不可复现"。但 Echo 是**陪伴**场景，`longing`（想念值）本身就是时间函数，"三天没说话"对我们**是信息**。这条不跟。
- **先造词表**：他们自己也踩了（PAD 第 6 条 bug：模型判"内疚"，词表最近邻给"嫉妒"），最后解法是"评分器的词优先，漂开 0.3 后退回词表"。我们连词表都没有，不必先造。

---

## 6. 同装风险（若你想把这两包装到自己机器上）

已核事实：

1. **每轮两次额外打分，都在回复路径上**：两包各自挂 `agent/inbox/spliced` + 各自 `await` 自己的打分（PAD `:993/1099`；IPC `:1148/1244`），互不感知（IPC `index.js:58` 明写"不 import PAD 的"）。两个 2.5s 超时相加 → 最坏 ~5s，典型 +2s 上下。
2. **三套情绪块同时注入**：Echo 的情绪 pack + `<pad_emotion>` + IPC 关系块。三方理论不同、数值不同（Echo「爱意 9/10」vs PAD「P0.3 A0.7 D0.3 惊慌」），**没有协调层** —— 这是设计裁决，不是 bug。
3. **本机配置改动**：两包都要往 profile 的 `dsh.profile.bundles` 里 `insert`，而该列表**只在启动时读一次**（PAD `cordis.patch.yml:14-16`）→ 装完必须**重启 `dsh web`**（由你做，我不动）。IPC 还要求插件目录下有 `node_modules/@deepseek-ai` junction，缺了 `ERR_MODULE_NOT_FOUND` 直接起不来（`README.md:430`）。
4. 本机现状（本仓复核）：`~/.dsh/profiles/web` 已装 `dsh-echo`、`dsh-almost-full-access`、`dsh-pocket`、`dshmarket`；`~/.dsh/settings.yaml` 只有 1.1 KB，**没有**队友那条不思考路由 → 按发送包置空的默认，打分会跟着会话主模型一起思考（**每轮多约 1s**）。

**建议**：先只装 **PAD**（信息增量最大、与 Echo 重叠最少），在**独立 `DSH_HOME` + 独立端口**的实例上验证（他们自己就这么测的），确认三件事再考虑上生产：① 三套块同注入后回复是否变怪；② 每轮实际多花多少毫秒；③ `dsh web` 能否正常起。

---

## 7. 建议动作

| 谁 | 做什么 |
|---|---|
| **你 → 队友** | 要回 `test/` + `scripts/`（或他跑 `npm run check` 的输出）；把 §4.1 的 8 条与 §4.2 的 7 处文案不符反馈给他；问一句 PAD 为什么不跟 IPC 一样加 `dsh-deps.js` fail-soft |
| **你裁决** | ① 借不借"同轮生效"（会不会动 Echo 的情绪时延）；② 装不装（建议先只装 PAD 且独立实例验证）；③ NRC-VAD 商用许可（30/51 → 实为 29/51）在你们对外材料里怎么标注 |
| **我可以做** | ① 把"网格+残差"移植进 `lib/emotion.js`（纯函数 + 测试）；② 写一版"装配期同轮判定"的原型（不调模型，先量时延）；③ 把他们的时序/兜底经验写进 `docs/`；④ 等 `test/` 到手后复核他们的自检 |

---

## 8. 我下不了的判断（诚实清单）

- 51 条锚点的**文献数值**是否逐条如实（只读了 README 的表述与 `docs/PAD_lexicon_sourced.md` 的标题，未回原文献）；§2.3 的"论文不存在"结论同理。
- IPC「五处常见说法是错的」里每一处的**对错** —— 我认可其内部一致性，未独立查证。
- 队友实测的性能表（979ms / 2307ms / 58% / 100%）**未复核**，也没在本机复跑（自检电池没发过来）。
- IPC `escalation` 机制（他们自标"没有一手来源的建模选择"）—— 同意标注，无法进一步验证。
- §4.1 第 6 条（坏 `residual` 抛 TypeError）是**读码推断**，未运行验证。
- 两包与 **Echo 同装**后的实际交互（谁的 waterfall 先跑、块顺序、回复是否变怪）—— **未测**，需要有独立实例才敢动。

---

## 附录：目录与规模（备查）

```
dsh-pad-emotion-package/dsh-pad-emotion-package/   ← 注意：套了两层同名目录
  index.js 1366 · client.js 678 · core/{pad 280, lexicon 465, match 116, state 490,
  dynamics 210, appraise 381, describe 197, index 14}
  docs/PAD_lexicon_sourced.md 413 · README.md 683 · cordis.patch.yml 94
  SETTINGS-SNIPPET.yaml 41 · setup.ps1/verify.ps1/install.cmd
dsh-interpersonal-circumplex-package/
  index.js 1761 · client.js 935 · dsh-deps.js 72
  core/{circumplex 1105(实际 1163), states 735(实际 759), state 588, appraise 525,
        describe 292, dynamics 282, lexicon 268, match 166, index 27}
  README.md 699 · cordis.patch.yml 95 · 安装说明.md 87 · SETTINGS-SNIPPET.yaml
  setup.ps1/verify.ps1/install.cmd
```

**评审方法**：我本人 `read`/`grep` 了 README、`package.json`、`cordis.patch.yml`、`SETTINGS-SNIPPET.yaml`、两份 `index.js` 的关键段、`core/describe.js`、`core/lexicon.js` 计数；两个只读子代理各自逐行核实了一个包的接入点、算法、边界与瑕疵（全程未写入、未执行插件本体，仅 `read`/`grep`/`glob` + `node --check`）。
