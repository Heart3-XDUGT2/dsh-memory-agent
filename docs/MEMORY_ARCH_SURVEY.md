# 记忆架构调研汇总（MEMORY_ARCH_SURVEY）

> 本文件是**四份调研笔记的汇总**：`arch-A.md`（889 行）、`arch-B.md`（295 行）、`arch-C.md`（451 行）、`research-arch.md`（377 行）。
> 汇总代理：只读素材、只写本文件；**没有改动任何代码 / config / tests / 既有笔记**；**没有 commit**；**没有重启 host**。
> 汇总时间：2026-10-01。所有事实、数字、行号、链接一律来自上述四份笔记；笔记标「未读到」的，本文件**同样标「未读到」**。

---

## §0 怎么读这份文档

### 0.1 深度分档标记（全文统一使用这四个标记）

四份笔记的取证深度不齐（有的读到了源码，有的只读到摘要），所以**每个架构的每一条事实都带深度档**，请据此决定可信度与是否需要回查一手材料：

| 标记 | 含义 | 典型例子（本文件中） |
|---|---|---|
| **【源码】** | 读到了**实现文件或 LICENSE 文件本体**（非文档、非 README 投影） | Letta 的 `letta/functions/function_sets/base.py`、`letta-leaderboard` 的 `locomo_benchmark.py`；MemoryOS / MemOS / Letta 的 LICENSE；Mem0 2.2.1 的 sdist 全源码；Memobase / Supermemory 的 wheel 源码 |
| **【论文 Method】** | 读到了**论文的正文章节**（Method / 系统设计 / 实验），不是只读摘要 | MemGPT §2、MemoryOS §3、MemOS §4–§5、MAGMA §3、sleep-time compute §3–§7、Auto-Dreamer §3–§4、MIRIX §3、HyperSU §4.1–§4.2 |
| **【文档·abstract】** | 只读到**官方文档 / 商店页 README 投影 / arXiv 摘要页 / 论文小节标题**，未到源码、也未到论文方法正文 | Basic Memory 的 docs 正文、灵枢与 opencontext 与 dsh-memory-eternal 的商店页 README、honcho 商店页前段、dsh-ontology 的商店页 README 全文、ontology-to-tools 的 §1–§3 正文 + §6 标题级、Navet 2026 的 HAL 摘要级 |
| **【未读到】** | 笔记明确标注「未读到」的项 | 大量 GitHub 源码与许可、MemOS §6.2/§6.3/§7、Generative Agents §4.2、MIRIX §4.1 细节等（汇总见 §7） |

**用法**：看到 **【源码】** 的机制可以直接照抄（表/字段/函数/公式都能落地）；看到 **【论文 Method】** 的机制可以照抄**设计与公式**，但实现细节要自己补；看到 **【文档·abstract】** 的机制只能当**方向**，数字与字段别当真；看到 **【未读到】** 的项**不要替它推断**。

### 0.2 口径纪律（两条，全文强制）

1. **跨协议数字不可直比。** 四份笔记反复出现同一基准（主要是 LoCoMo）的不同口径：Letta 报**单一准确率**、MemoryOS 报 **F1 + BLEU-1**、MemOS 报 **LLM-Judge 分数**、opencontext 报**自家 harness 自评**、灵枢报**内部标尺**。**任何把两个不同来源的数字并排排名或做差值的写法都是错的**（详见 §4）。
2. **引用带条件的数字必须带条件。** 例：MemGPT 的「70% / 100% / 50% 上下文阈值」在论文原文里都写作 **e.g.**，是**可配置量**（`warning token count` / `flush token count` / `evict count`），不是硬编码常量；MemoryOS 的「+49.11% F1 / +46.18% BLEU-1」是**相对基线的平均提升**而非绝对分；Letta 的 74.0% 必须**同时**带上 Letta 自己写的 caveat（见 §4.3）。凡本文件出现数字，均在**同一条目内**注明出处与口径备注。

### 0.3 结构导航与一处偏离说明

- §1 横向总表（22 行）→ §2 逐个架构详述（同 22 个，按 A/B/C 分组，每个用统一模板 ①–⑫）→ §3 六条横向专题对比 → §4 口径与可比性 → §5 与我们现状的对照 → §6 可选借鉴路线 → §7 未读到清单 → §8 来源与文档状态。
- **偏离说明（必须知情）**：任务建议 §1 为「18–22 行」。四份笔记合计登记了 **29 个**架构/系统，全部成行会超出建议区间。本文件的处理是：**§1 正表 22 行**（决策相关性最高的一批）+ **§1 附表 7 行**（并列登记：honcho、Supermemory、HERO、EAR、TRACE、Navet 2026、Generative Agents）；§2 对正表 22 个用完整模板，对附表 7 个用**同一模板的简版**（明确标注「简版」）。**没有丢弃素材**，只是分了主次。

---

## §1 横向总表

> 判定基准（四份笔记共同前提）：**纯 SQLite · 单用户 · 几百条记忆 · 要可审计 · 不许常驻服务**。
> 「依赖」列只答三问：**要不要常驻服务 / 要不要图库 / 要不要向量库**。
> 深度档取该架构在本轮笔记里的**最高**取证深度。

| # | 名称 | 范式类 | 一句话 | 依赖（常驻服务·图库·向量库） | 许可 | 在我们约束下的判定 | 深度档 |
|---|---|---|---|---|---|---|---|
| A-1 | **MemoryOS** | 分层/分页（OS 类比） | STM 页队列 → MTM 分段分页 → LPM 画像，FIFO 晋升 + Heat 淘汰；检索先选段再选页 | 不必须常驻；不必须图库；需嵌入向量 | 论文：arXiv perpetual non-exclusive；代码：**Apache-2.0**（已核） | **需改造** | 【论文 Method】 |
| A-2 | **MemGPT（论文）** | 分层/分页 | 上下文=物理内存、外部库=磁盘，用函数调用分页；`request_heartbeat` 串多次调用做多跳 | **要常驻数据库**（默认 PostgreSQL + pgvector）；无需图库；向量=库查询 | 论文 **CC BY 4.0**（已核） | **不可行（原样）** | 【论文 Method】 |
| A-3 | **Letta（实现：记忆工具 + 双代理写权分离 + MemFS）** | 分层/分页 + 工具化 | 常驻 agent 服务：core memory 定长块 + recall/archival + agent 自主调用的记忆工具；新形态把**改记忆的权限从会话 agent 拿走** | **要常驻服务**；无需图库；需嵌入服务 | **Apache-2.0**（已核，LICENSE 本体 + wheel METADATA） | **不可行（原样）**；写权分离这半边可行 | 【源码】 |
| A-4 | **Letta Filesystem（「文件+grep」跑分）** | 纯文件/Markdown 库 | 整段对话史塞进一个 `.txt`，agent 用 `grep`/`search_files`/`open`/`close` 自己翻；LoCoMo 74.0% | 依赖同 Letta（服务器 + 嵌入）；无图库；向量=文件自动嵌入 | 博客=Letta 版权（非开源许可）；跑分代码仓许可**未读到** | **不可行（原样）**；「文件+工具」这半边**高度可行** | 【源码】 |
| A-5 | **MemOS** | 分层/分页 + 资源化生命周期 | 把记忆当可调度资源；MemCube（内容+元数据）统一三类载体；生命周期状态机 + Time Machine/冻结 | 论文**未读到**依赖清单；Cross-Type Conversion 需模型权重 | 论文 **CC BY 4.0**（已核）；代码 **Apache-2.0**（已核） | **需改造**（整段丢弃激活/参数层） | 【论文 Method】 |
| A-6 | **Basic Memory** | 纯文件/Markdown 库 | 文件为真源、SQLite/Postgres 只是二级索引；`- [category]` 观察 + `[[wikilink]]` 关系构成图谱；混合检索 | **不要常驻服务**（本地 SQLite+sqlite-vec；File Watcher 可选）；无图库；向量=本地 fastembed | **AGPL-3.0**（自官方文档 Licensing 章节读到；LICENSE 本体检未读到） | **可行度最高**（唯一硬卡点=许可） | 【文档·abstract】 |
| A-7 | **dsh-memory「灵枢」** | 纯文件/Markdown 库 + 零 LLM 裁决 | 纯 md 认知图 + 确定性规则引擎（含 Rust 内核）+ 显式遗忘，以 stdio MCP 挂载 | **要常驻**（stdio 长驻进程 + Python）；无图库；无向量（方向拍板「不上向量」） | **未读到**（商店页无 license 段） | **需改造** | 【文档·abstract】 |
| A-8 | **opencontext** | 时序上下文图 | `valid_from`/`valid_until` 的时序 DAG + 统一 memory API + 确定性 Loop 引擎 | **可常驻可选**（默认 SQLite + 本地嵌入，可纯库内嵌 / 可 daemon / 可 mcp）；无图库；向量=sqlite-vec 等 | **Apache-2.0**（商店页 README 自述；LICENSE 本体检未读到） | **需改造**（底层选型最接近） | 【文档·abstract】 |
| A-9 | **dsh-memory-eternal / memory-eternal** | 纯文件/Markdown 库 + 人机协同审核 | 会话结束自动沉淀「知识卡」到本地 Markdown Vault，新卡进审核中心、人工批准才入主库 | **可退化无常驻**（MCP 用完即退；默认 web 47MB 常驻可关）；无图库；无向量（自研 CJK 检索） | **MIT**（已核，`npm view` 双包） | **需改造**（数据形态最对齐） | 【文档·abstract】 |
| B-1 | **MAGMA** | 超图/多视图（四正交图） | 每条记忆当节点、四张正交关系图（semantic/temporal/causal/entity）解耦；检索=意图加权策略式 beam 遍历；写入=快通道+异步慢通道 | **不必常驻**（后端抽象，可换内存实现）；图库/向量库**不是架构硬要求** | 论文 arXiv perpetual non-exclusive / `nonexclusive-distrib/1.0`（已核）；代码**未读到** | **可行（需改造）** | 【论文 Method】 |
| B-2 | **sleep-time compute** | 睡眠/巩固 | 睡眠期把已有上下文 c 重写成再表征 c′，测试期用 c′ 顶替 c；用极少 test-time compute 换同等精度 | **无需图库/向量库**，只要一个能跑 prompt 的 LLM | 论文 **CC BY 4.0**（已核）；代码**未读到** | **可行（需改造）**；本身不是记忆架构，是预推理层 | 【论文 Method】 |
| B-3 | **Auto-Dreamer** | 睡眠/巩固（离线区域重写） | 快写（append-only typed 记忆）+ 慢整理（离线 consolidator 做区域重写：`B*=(B\R)∪S`，supersede 原区域） | 无需常驻；无图库；无向量库（读=冻结编码器+余弦）；**需要一个训练过的 14B** | 论文 **CC BY 4.0**（已核）；代码**未读到**（论文未给出） | **需改造**（抄语义、别抄训练） | 【论文 Method】 |
| B-4 | **MIRIX** | 超图/多视图（六类记忆 + 多智能体） | 六类异构记忆（Core/Episodic/Semantic/Procedural/Resource/Knowledge Vault）+ Meta Memory Manager 路由 + Active Retrieval | **无常驻硬依赖**；无图库；**存储后端就是 SQLite** | 论文 **CC BY 4.0**（已核）；代码许可**未读到** | **可行（需改造）**（同构度最高） | 【论文 Method】 |
| B-5 | **mnemon** | 超图/多视图（四图，Go 单二进制） | 本地单二进制：宿主 LLM 当监督者（二进制做确定性计算、LLM 只做判断）；三原语 `remember/link/recall`，底层 MAGMA 四图 | **不要常驻服务**；无图库；向量**可选**（SQLite BLOB + 本地 Ollama，不可用则退化 token 重叠） | **Apache-2.0**（pkg.go.dev + 仓库 License）；npm `dsh-mnemon` **MIT**（旧文档已核） | **可行（可直接照抄）** | 【文档·abstract】（仓库 docs 正文级） |
| B-6 | **HyperSU** | 超图 | 把「一段连贯文本片段（SU）」本身当超边；实体感知 MDL 分割切 SU；检索=线索引导双向扩展 + 收敛奖励 | **不要常驻服务**（关联矩阵即可）；无图库；句 embedding + 本地 GLiNER | 论文 arXiv perpetual non-exclusive；代码**未读到**（未给出） | **可行（需改造）**，但几百条规模收益可疑 | 【论文 Method】（§5 正文未读到） |
| B-7 | **dsh-ontology** | 本体/类型化（TBox+ABox） | 先声明词汇表（TBox），每句断言落库前过模型；能推出的结论**读时推导、不落库** | **无外部服务**；无图库；无向量（纯 JSON 存储） | **MIT**（商店 REPOSITORY FACTS 明确标 MIT） | **可行**（存储层需换 SQLite） | 【文档·abstract】 |
| B-8 | **ontology-to-tools** | 本体/类型化（编译成工具） | 把 T-Box 编译成 MCP 工具，agent **只能用这些工具**建/改实例 ⇒ **生成期强制语义约束**（非事后校验） | **要 MCP server + triple store + ReAct 流水线** | 论文 **CC BY 4.0**（已核）；代码**未读到** | **需改造**（照搬形态不可行，照搬机制可行） | 【论文 Method】（标题级） |
| C-1 | **Mem0 OSS 2.2.1** | 纯向量/混合检索（不建真图） | LLM 抽事实（ADD-only）+ 两条向量库（记忆条目库 + 实体条目库）；检索=语义+BM25+实体加成加性打分 | **不要常驻服务**（库形态）；无图库；**要外部向量库** + spaCy + LLM | **Apache-2.0**（已核，pyproject + 包内 LICENSE） | **需改造**（公式可移植，向量判定需改） | 【源码】 |
| C-2 | **Memobase** | 纯向量/服务化（画像+事件） | 结构化用户画像（`topic/sub_topic/content`）+ 事件时间线；每用户一个 buffer，异步批量 flush | **要常驻服务**（FastAPI + Postgres + Redis，docker） | 客户端 **Apache-2.0**（已核，METADATA）；服务端许可**未读到** | **不可行（原样）** | 【源码】（客户端本体） |
| C-3 | **MemoryLLM** | 参数化/权重式 | 在冻结的 Llama2 每层插一段定长 memory pool（+1B 参数），新知识直接写进隐向量 | **要训练 + 改模型架构 + GPU** | 论文 **CC BY 4.0**（已核）；代码**未读到**（DNS 拦） | **不可行** | 【论文 Method】（§4 未读到） |
| C-4 | **WISE** | 参数化/权重式（双参数记忆） | main memory（预训练知识）+ side memory（被编辑知识，FFN `W_v` 副本）+ 训练 router；分片 + 合并 | **要训练 router + 改权重 + 模型合并** | 论文 arXiv perpetual non-exclusive；代码**未读到** | **不可行** | 【论文 Method】（§2.3.2/§3/§5 未读到） |
| C-5 | **MemX** | 纯向量/混合检索（local-first） | Rust + libSQL + FTS5；检索=向量召回+关键词召回 → RRF → 四因子重排 → z-score/sigmoid → **低置信拒答** → 两层去重 | **不要常驻服务**；无图库；libSQL 向量扩展 + 嵌入 API | **未读到**（笔记只标明形态；GitHub 拦） | **可行（首选参照）** | 【论文 Method】 |

### §1 附表 并列登记（7 项，未单独成行；判定与深度档照录）

| # | 名称 | 范式类 | 一句话 | 判定 | 深度档 | 为什么在附表 |
|---|---|---|---|---|---|---|
| X-1 | **honcho** | 纯向量/服务化（推理优先） | FastAPI 常驻服务：Store → 后台 Reason → Query → Inject，产出 per-peer representation | **不可行**（核心即常驻服务，无进程即无价值） | 【文档·abstract】 | 与 Memobase 同属「服务化不可行」；正表保留 Memobase 作代表 |
| X-2 | **Supermemory** | 纯向量/服务化（纯托管） | 纯托管 REST 记忆服务（默认 `api.supermemory.ai`），以 container 分桶 | **不可行**（第三方云 + API key，算法黑盒） | 【源码】（SDK 本体） | 正表保留 Memobase 作服务化代表 |
| X-3 | **HERO** | 图 + Personalized PageRank | 异质记忆图：Episodic Layer + Profile Layer；三阶段检索（锚定 → K 轮 cue-context-cue 游走 → 全局相关性传播） | **需改造**（图/迭代超出「纯向量」，但 SQLite 上可迭代实现） | 【论文 Method】 | C 组「有余力项」；判定与 C-5 同层但更重 |
| X-4 | **EAR** | 反思式检索精炼 | Exploratory Reflection（迭代搜索收集经验）+ Assimilating Reflection（replay 精炼全局 reranker） | **需改造（偏重）**（含学习循环，不是纯检索） | 【论文 Method】 | C 组「有余力项」 |
| X-5 | **TRACE** | 时间证据图 | Temporal Evidence Graph 上的 state-aware 查询：三层顶点 + 二部关联扩展 + 有效性标记 + answer plan | **需改造（偏重）**（完整图 + 路径生成 + answer plan 是过设计） | 【论文 Method】 | C 组「有余力项」 |
| X-6 | **Navet 2026** | 本体/类型化（标准化 RDF/OWL 栈） | 把 agent 记忆锚定在开放标准（RDF/RDFS/OWL 2 RL/SHACL/SPARQL）上，用形式推理 + 声明式校验改善六种记忆操作 | **需改造**（可借「六操作 + SHACL 校验 + PROV-O 溯源」三点） | 【文档·abstract】（提案阶段·无实验结果） | B 组 B8c **只登记、不采信**（本次未读到任何一手材料） |
| X-7 | **Generative Agents（reflection 层）** | 睡眠/巩固（早期形态） | 三层：memory stream + reflection（递归综合成更高层推断）+ planning；reflection 与 plan 回写同一 stream | **可行（需改造）**（memory stream = 一张 append-only 表） | 【论文 Method】（§4.2 未读到） | 关键章节（触发时机/摘要层级）未读到，只能给形态 |

---

## §2 逐个架构详述

> 统一模板：① 代表/链接/许可/我读到哪一段 ② 一句话架构 ③ 数据形状 ④ 写入路径 ⑤ 检索路径 ⑥ 整理/巩固 ⑦ 遗忘/失效 ⑧ 依赖与成本 ⑨ 实测数字 ⑩ 适配判定 + 一句理由 ⑪ 能照抄的具体机制 ⑫ 已知失败模式。
> 缺项一律写「未读到」。出处用笔记文件名 + 章节名或 `文件:行`（笔记给的源码行号**照录**；凡笔记自己标注「转述未验证」的，本文件同样标注）。

### A 组（分层/分页 + 纯文件·Markdown 库 + 记忆工具化）

#### A-1 MemoryOS

- **① 代表/链接/许可/读到哪**：MemoryOS / Kang, Ji, Zhao, Bai（北邮 + 腾讯 AI Lab）。论文 <https://arxiv.org/abs/2506.06326>；代码 <https://github.com/BAI-LAB/MemoryOS>。论文许可 = `arXiv.org perpetual non-exclusive license`（abs 页 view license 链接）；**代码 Apache-2.0（已核**，`raw.githubusercontent.com/BAI-LAB/MemoryOS/main/LICENSE`，附录版权行 `Copyright [2025] [BAITING]`，占位符原文如此）。读到：**全文** —— `arxiv.org/html/2506.06326v1` §3.1 总览 / §3.2 Storage / §3.3 Update / §3.4 Retrieval / §3.5 Generation、§4.1–§4.5（含超参全表与 Table 1/2/3）。**实现文件与行号：未读到**（`api.github.com` / jsDelivr 均 422）。【论文 Method】
- **② 一句话架构**：把 OS「段页式虚拟内存」搬到对话记忆：STM（近期页队列）→ MTM（按主题分段 + 段内分页）→ LPM（用户/AI 画像），三段之间由 **FIFO 晋升 + Heat 分数淘汰** 驱动；检索「先选段、再选页」两跳召回。
- **③ 数据形状**：STM 是 *dialogue page* 队列，`page_i={Q_i,R_i,T_i}`，每页带 `meta_chain`（Eq.1）。*dialogue chain* 由 LLM 两步生成（先判定新页与既有页相关性决定接链或重开，再把链上所有页总结成 `meta^chain_i`）。MTM 的 `segment_i={page_i | F_score(page_i,segment_i)>θ}`（Eq.2），段内容由 LLM 基于所属页总结。LPM：*User Persona* = User Profile（静态属性）+ User KB（增量事实）+ User Traits（**90 维、三大类**）；*Agent Persona* = Agent Profile（固定）+ Agent Traits（演化）。相似度 `F_score = cos(e_s,e_p) + Jaccard(K_s,K_p)`（Eq.3）。
- **④ 写入路径**：STM 由对话自然追加（每轮一页）；MTM/LPM 由 Updating 模块写。**写前闸门有且具体**：① STM→链：LLM 先做上下文相关性判定，不连续就**重置链**而不是硬接；② 页→段：必须 `F_score > θ(0.6)` 才允许并入，否则视为新主题；③ 段→LPM：必须 `Heat > τ(5)`，且**迁完后 `L_interaction` 重置为 0**（使该段 Heat 立刻下降，避免重复注入画像）；④ User KB / Agent Traits：定长队列 100、FIFO。
- **⑤ 检索路径**：STM **全量**取回；MTM **两跳**（先按 Eq.3 选 top-m=5 个候选段，再在段内选 top-k 页，GVD k=5 / LoCoMo k=10，检索后更新该段 `N_visit` 与 `R_recency`）；LPM User KB/Agent Traits 各取语义最相关 top-10，User Profile/Agent Profile/User Traits **全量**注入。**多跳=是（段→页），但不是图扩散**。**agent 不能迭代调用**：召回是每轮固定流水线（`F_Retrieval(STM,MTM,LPM|Q)`，Eq.5），agent 不自主发起检索、不能多轮改写查询 —— 这是它与 MemGPT/Letta 的**根本分野**。
- **⑥ 整理/巩固**：链摘要 / 段摘要 / 画像抽取都由 **LLM 调用**完成；由**更新规则触发**（队列满 / 分数越阈），非人工、非定时。留痕/回滚：**未读到**。
- **⑦ 遗忘/失效**：STM→MTM 的 FIFO 是**迁移不是删除**；MTM 段数超上限（**max 200**）时 **Heat 最低的段被驱逐**（这是删除）；LPM 无删除、只有 FIFO 定长（100）滚动覆盖。**没有打戳/冻结、没有软删除。**
- **⑧ 依赖与成本**：需嵌入向量（段/页 embedding 做 cos）+ LLM（关键词提取、摘要、相关性判定）；硬件 **8×H20 GPU**（§4.1）。Table 3（LoCoMo）：MemoryOS **3,874 tokens / 4.9 次 LLM 调用 / F1 36.23**；对照 MemoryBank 4323/6.84/18.01、TiM 1274/2.6/18.01、**MemGPT 16,977/4.3/29.13**、A-Mem* 2712/**13.0**/26.55。⚠️ **口径备注**：token 数论文只说是「memory retrieval 中消耗的 token」，**未说明是否含摘要阶段的离线调用**；跨方案 token 口径是否严格可比论文未声明。
- **⑨ 实测数字**：GVD（Table 1，GPT-4o-mini）Acc. **93.3** / Corr. 91.2 / Cohe. 92.3，对最佳基线 A-Mem（90.4/86.5/91.4）提升 **3.2%/5.4%/1.0%**；GVD（Qwen2.5-7B）91.8/82.3/90.5。LoCoMo（Table 2，GPT-4o-mini，F1/BLEU-1）：Single Hop 35.27/25.22、Multi Hop 41.15/30.76、Temporal 20.02/16.52、Open Domain 48.62/42.99；平均 rank F1 1.0、BLEU-1 1.0。**摘要里的 49.11% F1 / 46.18% BLEU-1 是「相对基线的平均提升」**，且类别间差异极大（Temporal 相对 +118.80%，Single Hop +32.35%）。⚠️ 论文自己把 A-Mem 分成 `A-Mem`（原论文报告值）与 `A-Mem*`（**同环境重跑**）两栏，只把 `A-Mem*` 算进 Avg. Rank —— **本组唯一主动做「同环境重跑」的方案，是「apple-to-apples 纪律」的正面样板**。评估器：GVD 的 Acc./Corr./Cohe. **由 DeepSeek-R1 自动打分**（LLM-as-judge，非人工）。消融（Fig.2）：影响排序 **MTM > LPM > Chain**。
- **⑩ 适配判定**：**需改造**。三段结构用 SQLite 三张表就能表达（几百条可全量算相似度），但**每一条晋升/淘汰路径都要一次 LLM 调用**，在「不许常驻服务」下只能召回前同步跑，会显著抬高单轮延迟；且 LLM 打分/摘要**天然不可审计**。
- **⑪ 能照抄的具体机制**：**Heat 三因子** `Heat=α·N_visit+β·L_interaction+γ·R_recency`，`R_recency=exp(-Δt/μ)`、`μ=1e+7`（字段 `visit_count`/`page_count`/`last_access_ts`，**按需计算不物化**）；**「迁完之后把 `L_interaction` 归零」**（消费即清零，零额外存储，本组最值得照抄的一条）；`F_score = cos + Jaccard(LLM关键词)` 双通道（`cos` 可换成关键词命中/字段匹配，是**去向量库化**的现成退路）；「语义不连续就重置链」；阈值常数集 **7 / 200 / 100 / τ=5 / θ=0.6 / μ=1e7** 当超参起点锚；**同环境重跑的口径声明习惯**。
- **⑫ 已知失败模式**：论文对竞品的批评 —— MemGPT「flat FIFO queue causes **topic mixing** as dialogue length grows」、A-Mem「heavy, multi-step link generation **inflates latency and error accumulation**」。**对自己基本没有自陈**。可推得（**属我方推断、非作者自陈，引用需标注**）：FIFO 会让长期未访问但重要的页在 MTM 段被 Heat 淘汰；90 维 trait 抽取一旦错会污染后续所有轮次且无回滚；Heat 里 `N_visit` 只增不减 ⇒ 访问越多越难淘汰（富者愈富，论文未讨论）。

#### A-2 MemGPT（论文）

- **① 代表/链接/许可/读到哪**：MemGPT（MemoryGPT）/ Packer, Wooders, Lin, Fang, Patil, Stoica, Gonzalez（UC Berkeley）。<https://arxiv.org/abs/2310.08560>。许可 **CC BY 4.0**（abs 页 view license → creativecommons.org/licenses/by/4.0/）。读到：**全文** —— `arxiv.org/html/2310.08560v2` §2.1–§2.4、§3.1–§3.2、§6.1.1–§6.1.3（提示词全文）。【论文 Method】
- **② 一句话架构**：把上下文窗口当「物理内存」、外部库当「磁盘」，用**函数调用实现分页**；LLM 自己决定何时换入换出，并用 `request_heartbeat=true` 把多次函数调用**串起来**做多跳检索。
- **③ 数据形状**：main context（prompt tokens）三段**连续**拼接 —— `system instructions`（只读静态）→ `working context`（**定长读写字块**，只能经函数调用写）→ `FIFO Queue`（滚动消息历史）。FIFO 第 0 位固定放一条系统消息 = **被逐出消息的递归摘要**。external context = `recall storage`（消息数据库）+ `archival storage`（任意长度文本对象读写库）。
- **④ 写入路径**：**LLM 自己写**（self-directed：「Memory edits and retrieval are entirely self-directed」）；函数调用触发，或在收到 **memory pressure 警告**后主动把重要信息搬入 working context/archival。**写前闸门在解析层**：输出串由 MemGPT 解析以确保正确，parser 校验函数参数后执行；执行期错误（如「上下文已满还想加」）**回灌给处理器**形成反馈回路。**这是「解析+容量」闸门，不是「内容正确性」闸门 —— 没有任何一致性/事实校验。** ⚠️ **阈值确切口径**：论文原文「exceed the 'warning token count' … (**e.g. 70% of the context window**)」→ 插 memory pressure；「flush token count (**e.g. 100%**)」→ 刷队列；「evicts … (**e.g. 50%**)」→ 生成新递归摘要。**「70%/100%/50%」在论文里都是 e.g.**，是可配置量，**引用必须带 e.g.**
- **⑤ 检索路径**：**多跳=是，且是 agent 自主的** —— `request_heartbeat=true` 让函数执行完立刻把控制权交回处理器（不暂停），从而「navigating through multiple pages of results from a single query or collating data from different documents」；不带该 flag 则是 *yield*（等下个外部事件）。**agent 能迭代多次调用**：nested KV 任务里靠反复函数查询完成 4 层嵌套查找。有明确**分页机制**防检索结果撑爆上下文。被换出的消息**仍永久存于 recall storage**，可再用函数读回，读回时由 queue manager 追加到队列尾部重新进入上下文。
- **⑥ 整理/巩固**：**有递归摘要**（「generates a new recursive summary using the existing recursive summary and evicted messages」= 摘要的摘要，不是每轮重摘全文）；由 **queue manager** 在 token 越阈时触发（自动）。⚠️ 准确表述：递归摘要发生在 **flush（100%）** 时；**FIFO** 描述的是队列换出顺序；两者同属 §2.2 Queue Manager。
- **⑦ 遗忘/失效**：**从上下文「遗忘」，但不从存储删除** —— 「the evicted messages are no longer in-context and immediately viewable to the LLM, however they are **stored indefinitely in recall storage**」。**这是软遗忘/打戳式失效，不是删除**；论文全篇没有描述任何真正的 delete 动作。
- **⑧ 依赖与成本**：默认 archival memory 用 **PostgreSQL + pgvector**（HNSW 索引，「approximate, sub-second query times」），embedding 用 OpenAI `text-embedding-ada-002` ⇒ **需要常驻数据库服务**（对我们的关键冲突点）。**没有独立检索器组件**：文档 QA 里「the retriever naturally emerges via the archival storage search functionality」。需要长上下文 LLM 作为「主存」。
- **⑨ 实测数字**：DMR（Table 2）：GPT-3.5 Turbo 38.7% → **+MemGPT 66.9%**（ROUGE-L 0.394→0.629）；GPT-4 32.1% → **92.5%**（0.296→0.814）；GPT-4 Turbo 35.3% → **93.4%**（0.359→0.827）。Conversation opener（Table 3）：Human SIM-1/SIM-3/SIM-H = 0.800/0.800/1.000；GPT-4 SIM-H 0.773、GPT-4 Turbo 0.767、GPT-3.5 0.817 ⇒ **能「偶尔超过人写的开场白」**。Nested KV：GPT-3.5 在 **1 层**就掉到 0%；GPT-4 / GPT-4 Turbo 在 **3 层**归零；**MemGPT+GPT-4 不受嵌套层数影响**；MemGPT+GPT-4 Turbo/GPT-3.5 在 2 层开始掉。⚠️ 口径备注：DMR 用 **ROUGE-L recall (R)** 而非 precision/F1（作者理由：生成回应普遍比 gold 冗长，用 recall 抵消）；评测含 **LLM judge（GPT-4）**，judge prompt 全文在 §6.1.2 并显式要求 "be generous with your grading"；**baseline 设定对 MemGPT 有利**（baseline 只能看到过去五段对话的有损摘要，而 MemGPT 可经分页搜索访问完整历史）。
- **⑩ 适配判定**：**不可行（按原样）；思想需改造**。默认实现绑 **PostgreSQL + pgvector**（常驻服务），能力上限强依赖底层模型的多跳函数调用能力（GPT-3.5 在嵌套 KV 1 层即 0%）；几百条记忆下分页/换出收益近零，复杂度与不可审计的 LLM 自编辑风险是实打实的。
- **⑪ 能照抄的具体机制**：**递归摘要**（新摘要 = f(旧摘要, 被逐出片段)，常数级摘要成本）；**FIFO 首槽固定放摘要哨兵**；**`request_heartbeat` 协议手法**（把「是否继续追问」变成模型输出的一个布尔参数，而不是外层循环猜 —— 要工具化记忆时这是最小可用的多跳开关）；**换出≠删除 + 永久可读回**；**检索器即数据库查询**（不引独立检索组件）；**运行期错误回灌**（把「上下文已满」当反馈喂回模型）。
- **⑫ 已知失败模式**：**自陈** —— 文档 QA 里「MemGPT will often **stop paging through retriever results before exhausting the retriever database**」（该多跳时提前收手）；**自陈** —— GPT-3.5 因「limited function calling capabilities」性能显著退化。**第三方（MemoryOS）批评**：flat FIFO 导致 topic mixing。

#### A-3 Letta（实现：记忆工具 + 双代理写权分离 + MemFS）

- **① 代表/链接/许可/读到哪**：Letta（MemGPT 发行版）/ Letta 团队。<https://github.com/letta-ai/letta>；博客 <https://www.letta.com/blog/benchmarking-ai-agent-memory/>；基准代码 <https://github.com/letta-ai/letta-leaderboard>；产品文档 <https://docs.letta.com/configuration/memory>（"Memory & dreaming"）。许可 **Apache-2.0（已核**，两份：`raw.githubusercontent.com/letta-ai/letta/main/LICENSE`，版权行 `Copyright 2023, Letta authors`；以及 PyPI wheel `letta-0.34.1` 的 METADATA `License-Expression: Apache-2.0`）。读到（**源码级**）：`letta` PyPI **sdist `letta-0.6.7.tar.gz`** 内 `letta/functions/function_sets/base.py` **全文**；`letta-leaderboard/main/leaderboard/locomo/locomo_benchmark.py` **全文**；Letta 博客全文；Letta docs 页 "Memory & dreaming" 全文；论文 Appendix F（见 B-2）的 `rethink_memory`/`finish_rethinking` 代码已解码。⚠️ 未读到：`letta/constants.py` 与 `letta/agent.py` 的**行号级**内容（见 §7）。【源码】
- **② 一句话架构**：一个**常驻 agent 服务**：core memory（定长字块，随 prompt 常驻）+ recall/archival storage（外部库）+ 一套 **agent 可自主调用**的记忆工具；新增的 **Filesystem/MemFS** 把文件当一等记忆载体。**写权分离（"双代理"）这半边**：创建 sleep-time 型 agent 时，Letta 在底层起**两个 agent** —— primary（对话、调工具、搜外部记忆，但**没有编辑自己 core memory 的工具**）与 sleep-time agent（持有那批编辑工具，可改 primary 的 in-context memory）；记忆整理因此**异步**发生在会话轮之外。
- **③ 数据形状**：core memory = 按 **label** 寻址的定长 block，实现里出现的 label 是 **`persona` / `human`**（见 `core_memory_append` docstring：「Section of the memory to be edited (persona or human)」）；archival memory = passage（`insert_passage`/`list_passages`，带 `created_at`）；recall/message = 消息库（`list_user_messages_for_agent` 可按 `query_text` 过滤）；MemFS = **git-backed 的记忆文件系统**（agent 可检视与编辑；记忆跨会话共享）。写权分离的粒度就是 **block 级**：`agent_state.memory.get_block / create_block / update_block_value(label, value)`。
- **④ 写入路径**：谁写 = agent 自己（append/replace/insert）；**写权分离后只由 sleep-time agent 写**。**写前闸门是「精确匹配」型，不是「内容正确」型**（源码级证据）：`core_memory_replace` 里 `if old_content not in current_value: raise ValueError(...)` —— 要求 `old_content` 是现存文本的**精确子串**；函数返回值一律 `None`（docstring: "None is always returned as this function does not produce a response"）⇒ **工具层不回显写没写成功，确认要靠后续读**；无长度上限校验写在工具函数里（定长约束应在上层）。何时写（docs "Dreaming"）：**① 完成 N 个 agent step 之后；② 上下文窗口被压缩（compaction）时**；频率可调（「频率越高 token 越多，但 agent 有更多时间修订 learned context」）。另有一条数据源摄入路径：上传 data source → sleep-time agent 后台解析并修改 primary 的记忆。**可选二次审阅**：「Select Agent reviews before applying」让 agent 在**第二个后台会话**里审阅并修订待写入的更新（「uses more model tokens and **does not ask you for approval**」⇒ 自动审阅、非人工审批）。`/doctor` 可审计记忆层级的位置漂移、重复与 system-prompt token 占用。
- **⑤ 检索路径**：**两条截然不同的通道（源码级）**：`conversation_search` docstring 明写 **「using case-insensitive string matching」**（词法，非语义）；`archival_memory_search` docstring 明写 **「using semantic (embedding-based) search」**（实现走 `agent_manager.list_passages(..., embed_query=True)`）。**即：Letta 的「对话搜索」是字符串匹配，「档案搜索」才是向量 —— 这两者常被混为一谈。** 分页：两个搜索都带 `page`/`start`，页大小取 `RETRIEVAL_QUERY_DEFAULT_PAGE_SIZE`；`archival_memory_search` 是**先取 `count + start` 条再切片**（`all_results[start:end]`）的朴素分页。**多跳=是，agent 自主**。sleep-time agent 的读取路径是「读上下文（含 memory blocks）+ 可能遍历会话历史」，不是检索器。
- **⑥ 整理/巩固**：**离线=是**（异步、会话轮之外）。触发 = 配置驱动调度（N 步之后 / 压缩时）+ 数据源摄入事件。**留痕/回滚 —— 这是它最强的一点**：① **MemFS 是 git-backed**，天然有版本历史；② "Reorganize memory" 工作流在执行大清理（拆大文件、并重复、重构层级）**之前会先备份当前仓库**（原文：backs up the current repository before splitting large files, merging duplicates, or restructuring the hierarchy）；③ `/doctor` 可审计重复/放置/token 占用。**回滚靠 git，不靠自定义机制。** 另（Filesystem 基准路径下）：无摘要/巩固，代码里摘要能力是可选项且默认关（`use_summary: bool = False`）；`chunking_strategy` 四种（`turn`/`session` 默认/`time_window` 窗口 10 轮/`secom`，`secom` 失败则退化为**每 8 轮一切**）。
- **⑦ 遗忘/失效**：**未读到**明确的 decay/TTL 语义（那是 mnemon/MAGMA 的路线）；Letta 这边是**重写/合并/去重**（block 换写 + reorganize 拆并），不是打分衰减。LoCoMo 实现里文件是预置的、只读使用，**没有遗忘路径**。
- **⑧ 依赖与成本**：**重** —— 完整 agent 服务器；基准里还要 `client.sources.create(...)` + `sources.files.upload(...)` + **轮询 job 直到 completed/failed**。需嵌入服务：`EmbeddingConfig(embedding_model="text-embedding-3-large", embedding_endpoint_type="openai", embedding_endpoint="https://api.openai.com/v1", embedding_dim=1536, embedding_chunk_size=100000)`。⚠️ **源码里有个可疑点，如实记录**：模型名是 `text-embedding-3-large`，但 `embedding_dim` 写成 **1536**（`-large` 原生维度是 3072，1536 是 `-small` 的维度）；**可能是刻意降维也可能是笔误，源码未加注释，引用时不要替它解释。** 文件被自动解析+嵌入。**两个 agent = 两倍会话开销**；sleep-time 用**更强模型**（官方推荐 primary 用快模型如 gpt-4o-mini、sleep-time 用更大更慢的如 gpt-4.1 / Sonnet 3.7，理由是它不受延迟约束）；"Agent reviews before applying" 再多一个后台会话的 token。**无图库/向量库的硬依赖**（MemFS 是文件系统 + git）。产品侧 dream 频率默认值与实测成本：**未读到**。
- **⑨ 实测数字**：与 A-4 同源（74.0% 见 A-4）；本条的产品侧无独立 benchmark 数字（**未读到**）；论文侧数字见 B-2。
- **⑩ 适配判定**：**不可行（按原样）；「写权分离」这半边是 B 组最值得照抄的样板**。理由：完整 Letta 不可接受（常驻服务 + Postgres/pgvector + 嵌入 API），且**不要真起两个 agent**（成本翻倍且要常驻）；改成「同一进程内，会话轮内的写入路径不持有改核心记忆的权限；巩固走另一个一次性调用、另一份权限」即可。
- **⑪ 能照抄的具体机制**：**写权分离的最小实现**（会话轮 agent **不注册** update/delete 类工具，只注册 `remember_candidate` 追加候选；巩固任务**单独一次调用**才拿 `update_block / merge / reorganize` 权限 —— 不需要第二个 agent）；**触发时机二选一**：`completed_steps % N == 0` 或 `context_compacted == true`（docs 原文就是这两种）；**巩固前先备份**（任何 reorganize/合并/拆分前先落快照，对应 "backs up the current repository before…"）；**"anytime" 写入**（巩固异步写、主 agent 随时能读到已写好的部分，**不必等巩固跑完**）；**可选二次审阅**（在更便宜的第二个会话里让模型审自己刚生成的更新，**自动通过不找人批**）；**`rethink_memory` 语义**（重新评估某 block，整合新事实与更新事实，**把过时信息替换成最可能为真的版本，避免与其它 block 冗余，并保持与其它 block 一致**；`source_block_label` 为 None 时终止循环 —— 可作巩固提示词骨架）；**`tool_rules` 三件套**（见 A-4）。
- **⑫ 已知失败模式**：**自陈** —— MemGPT 式单 agent 的记忆管理与会话挤在一起 ⇒ **更慢、更不可靠**（同一 agent 同时调记忆工具和普通工具）；论文侧失败模式见 B-2（只在 query 可预测时有效；高 test-time 预算下反而更差）；**自陈**（博客）—— LoCoMo 只测检索、不测 agentic memory；跨框架/工具/模型比较「like comparing apples to oranges」；Letta **没有原生方式摄入 LoCoMo 这类对话历史**，需要「significant refactoring」；因 GPT-4o mini 弱，不得不把 agent 做成「only partially autonomous」。**我方观察**：双 agent 方案在单用户、几百条记忆的规模下，收益（异步 + 更干净的记忆）**很可能被两倍 token 与运维复杂度吃掉** —— 所以只抄「权限分离 + 巩固前备份」，不抄「两个 agent」。

#### A-4 Letta Filesystem（「文件+grep」跑分，LoCoMo 74.0%）

- **① 代表/链接/许可/读到哪**：Letta 研究博客《Benchmarking AI Agent Memory: Is a Filesystem All You Need?》（2025-08-12）+ `letta-ai/letta-leaderboard` 的 `locomo_benchmark.py`。**许可：博客为 Letta 版权（非开源许可）**；其公布的跑分代码在 `letta-ai/letta-leaderboard`（**仓库许可未读到**）。读到：博客全文（含 74.0% 的协议与口径自述）+ 跑法源码全文（函数级细节）。【源码】
- **② 一句话架构**：**把整段对话历史塞进一个文件，交给 agent 自己用文件工具查**。agent 只拿到四个工具：**`grep` / `search_files` / `open` / `close`**（外加 `answer_question` 收尾）；文件**自动解析并做 embedding**，所以 `search_files` 是语义检索、`grep` 是字面匹配。（基准代码里实际启用的是 `tools=["search_files","answer_question"]`，并注释掉了 `grep`/`open_file`/`close_file`。）
- **③ 数据形状**：每个 session 一个 `.txt` 文件，写在 `leaderboard/locomo/data/sample_<id>/` 下；文件名由**时间戳**把 `/` 和 `:` 替换成 `-` 生成（`filename = timestamp.replace("/","-").replace(":","-") + ".txt"`），并**按文件名排序**得到确定顺序；文件内首行是 `Timestamp: ...`，之后是会话正文。
- **④ 写入路径**：**LoCoMo 侧写入是离线预置的** —— 文件在 benchmark `__init__` 里就创建好（`_create_files_for_all_samples`），用 16 线程池并发写，且**已存在则跳过**（`if not file_path.exists()`），**幂等**。写前校验：**未读到**（基准场景不需要）。
- **⑤ 检索路径**：**agent 自主多跳，而且这正是 74.0% 的成因**。博客原文「What it searches for and **how many times it calls tools is up to the agent**」。用 **tool_rules 约束形状**而不是禁止多跳：`TerminalToolRule(tool_name="answer_question")`（终止工具）、`InitToolRule(tool_name="search_files")`（**必须以 search_files 开头**）、`ContinueToolRule(tool_name="grep")` / `ContinueToolRule(tool_name="search_files")`（**调用完必须继续、不许就此收尾**）。博客自述动机：「we made the agent **only partially autonomous** by defining tool rules to limit the agent's tool-calling patterns」（因为 GPT-4o mini 较弱）。
- **⑥ 整理/巩固**：Filesystem 路径下**没有摘要/巩固**（原文「by simply placing the LoCoMo conversational history into a file, **without any specialized memory tools**」）。
- **⑦ 遗忘/失效**：**未读到**（文件预置、只读使用，无遗忘路径）。
- **⑧ 依赖与成本**：同 A-3（Letta 服务器 + sources 上传 + job 轮询 + 嵌入服务；`embedding_dim=1536` 的可疑点同 A-3）。
- **⑨ 实测数字**：**Letta Filesystem = 74.0% on LoCoMo**，模型 **GPT-4o mini**，「minimal prompt tuning」。对照口径（博客自己写的）：Mem0 自报的**最佳图变体 68.5%**。⚠️ **引用 74.0% 必须同时带它自己的 caveat（逐句）**：① 「Evaluating the effectiveness of these memory tools **in isolation** is extremely challenging」② 「The quality of an agent's memory often depends **more on the underlying agentic system's ability to manage context and call tools** than on the memory tools themselves」③ 「Comparing agent frameworks and agent memory tools is **like comparing apples to oranges**」④ 替代口径 **Letta Leaderboard** 才是「apples-to-apples」（固定框架与工具、只比模型），且「creates memory interactions **on-the-fly**」。⑤ 它还点名质疑 **Mem0 公布的 MemGPT 跑分**（「results were puzzling…unable to determine a way to backfill LoCoMo data into MemGPT/Letta without significant refactoring」，Mem0 未回应）—— 这是**两家的口径之争，本文件只记录双方主张，不裁定**。Letta 对 74.0% 的归因：**agent 对文件系统工具的训练熟悉度**（「large due to post-training optimization for agentic coding tasks」）而非记忆机制本身。
- **⑩ 适配判定**：**不可行（按原样）；「文件 + grep」这一半高度可行**。理由：完整 Letta 不可接受（常驻服务 + Postgres/pgvector + 嵌入 API），但博客揭示的结论 —— **「文件 + 让 agent 自己 grep/search」能超过专用记忆工具** —— 恰好是「纯文件/Markdown 库式」路线最强的外部支撑，且**几乎零基础设施**。⚠️ 但要先定 **SSOT**（文件为真相还是 SQLite 为真相；Basic Memory 靠 file-watcher + 定期 sync 解决）。
- **⑪ 能照抄的具体机制**（本组最值得抄的一组）：**`tool_rules` 三件套**（InitToolRule 强制先检索 + ContinueToolRule 禁止检索后立刻收尾 + TerminalToolRule 显式终止）——「逼 agent 多跳」的最小提示词外机制，比在 prompt 里写「请多查几次」可靠；**把「终止」做成一个工具**（`answer_question`），让「我查完了」成为**可被规则约束的动作**而不是沉默；**文件按时间戳命名 + 排序**得到确定性检索顺序（可审计）；**文件名即索引**（不建额外索引也能按时间轴定位）；**「文件为真源 + 自动嵌入只是派生」**（文件不在库中也能重建索引）；**幂等写入**；**caveat 写法本身**（把「apple to oranges」和「我们自己的复现困难」写进博客）。
- **⑫ 已知失败模式**：**自陈** —— LoCoMo 只测**检索**、不测 **agentic memory**；跨框架/工具/模型「like comparing apples to oranges」；Letta **没有原生方式摄入 LoCoMo 这类对话历史**（文件注入是为基准新加的、非成熟路径）；因 GPT-4o mini 弱，不得不把 agent 做成「only partially autonomous」。

#### A-5 MemOS

- **① 代表/链接/许可/读到哪**：MemOS / MemTensor (Shanghai) + 上海交大等（作者 40+，Zhiyu Li、Shichao Song 等领衔）。论文 <https://arxiv.org/abs/2507.03724>（v1 2025-07-04 / **v4 2025-12-03**，36 页 10 图 5 表）；项目页 <https://memos.openmem.net/>；代码 <https://github.com/MemTensor/MemOS>。**论文 CC BY 4.0（已核**，abs 页 + HTML 页首 `[License: CC BY 4.0]`）；**代码 Apache-2.0（已核**，`raw.githubusercontent.com/MemTensor/MemOS/main/LICENSE`，版权行 `Copyright 2025 - Present MemTensor Research`）。读到：`arxiv.org/html/2507.03724v1` §1、§2.1–2.4、§3.1/3.2、§4.1/4.2、§5.1/5.2/5.3/5.4.1/5.4.2/5.4.3、§6.1（Table 3）。⚠️ 过程：**第一次经桥取回时被截断在 §3.1 末**，桥随后整条 402 失效，改**本机直连**二次抓取成功并补齐 §4/§5/§6.1。**仍然未读到**：§6.2（Memory Retrieval 专项评测）、§6.3（KV-Based Memory Acceleration）、§7（Applications）。【论文 Method】
- **② 一句话架构**：把「记忆」当**可调度、可演化的系统资源**，用 OS 式中间层统一 **纯文本记忆 / 激活记忆 / 参数记忆** 三种异构载体；基本单位 **MemCube**（统一封装「记忆内容 + 元数据」），用 **生命周期五段**驱动，支持 compose / migrate / fuse 与跨类型迁移。
- **③ 数据形状（§4.2 字段级）**：**MemCube 三组属性** —— ① **Descriptive Identifiers**（identity/classification/organization，称 "semantic fingerprints"）：`Timestamp`（创建或最后更新，「for lifecycle modeling」）、`Origin Signature`（**inference extraction / user input / external retrieval / parameter finetuning** 四选一）、`Semantic Type`（如 **task prompt / fact / user preference**，「to support semantic composition」）；② **Governance Attributes**（每个记忆单元一套规则集）：`Access Control`（read/write/share **scope**）、`Lifespan Policy`（**TTL 或 decay 规则**）、`Priority Level`（供调度）、`Compliance & Traceability`（**sensitivity tags / watermarks / logs**）；③ **Behavioral Usage Indicators**：`Access Patterns`（frequency + recency）、`Contextual Fingerprint`（轻量语义签名，用于快速检索与任务对齐）、`Version Chain`（**修改历史与派生谱系**，「enabling version control, conflict resolution, and rollback」）。MemCube 设计灵感自陈来自 Memory³ 的 "controllable externalization"。三种载体 = `plaintext memory` / `activation memory` / `parameter memory`；§2.1 二维分类法：`implicit`（parameter memory / KV-cache / hidden states）vs `explicit`（text & context based），时间尺度分 sensory/short-term/long-term 且**把 sensory 并入 short-term**。组件：MemReader / MemScheduler / MemLifecycle / MemOperator。
- **③b 架构分层（§5.1/§3.2）**：三层 —— **Memory Interface Layer**（MemReader / Memory API / Memory Pipeline）→ **Memory Operation Layer**（MemOperator / MemScheduler / MemLifecycle）→ **Memory Infrastructure Layer**（MemGovernance / MemVault / MemLoader & MemDumper / MemStore）。OS 类比映射：Scheduler ↔ MemScheduler；File System ↔ **MemVault（Versioned store）**；System Call ↔ Memory API；Device Driver ↔ MemLoader/Dumper；Package Manager ↔ MemStore；Activation Memory ↔ Fast working state；Plaintext Memory ↔ I/O Buffer / External episodes。
- **④ 写入路径**：两条路 —— **用户动作显式发起**，或**系统启发式隐式驱动**（§5.4.3 原文：「Transitions can be **explicitly initiated by user actions**, or **implicitly driven by system heuristics** such as **recency, contextual salience, or successful merge events**」）。**写前闸门有，而且是「治理」级的**（§4.2 Governance Attributes：Access Control / Lifespan Policy / Priority Level / Compliance & Traceability）；**即写入/访问的闸门是 per-memory-unit 的规则集，而非统一的内容校验**。MemGovernance 是独立的基础设施层组件。⚠️ **注意**：论文**没有描述类似「一致性/事实校验」的内容闸门**（与灵枢的 CCG 六要素闸门形成对比）。
- **⑤ 检索路径**：`MemOperator` = 多视角记忆结构化 + **混合检索与动态派发** + 管线耦合与缓存 + **任务对齐的记忆路由**；跨异构记忆类型与上下文维护「semantic indexes, and **graph-based topologies**」。`MemScheduler` = 「selects **appropriate memory types**（Plaintext / activation / parameter）**based on task intent and context**, and dynamically plans **invocation order and integration strategy** to optimize for low latency and task relevance」。**多跳=是（调度级多跳，不是图遍历级）**；**未读到**明确的「图扩散若干跳」参数（如 depth/k）。**agent 能否迭代多次调用：未读到明确描述**（有统一 Memory API 作为系统调用面，但论文未展示 agent 自主多轮调用循环）。
- **⑥ 整理/巩固**：**`fusion` 是生命周期的一段**，且「MemCubes can be **composed, migrated, and fused** over time」；合并语义：语义重叠的历史记忆会「consolidated into a **new version** and marked as **"Merged"**」（§5.4.3 例子）；跨类型转换与迁移由 `MemScheduler` 的「**Cross-Type Conversion and Migration**」承担。⚠️ **一个具体的不可行点**：Cross-Type Conversion（Plaintext⇒Activation⇒Parameter）**需要模型权重层面的可写能力**，我们根本没有参数记忆 ⇒ **这一整块必须整段丢弃**。
- **⑦ 遗忘/失效（§5.4.3 —— 任务点名的「时间机器/冻结」，已读到）**：`MemLifecycle` 追踪「**creation, activation, expiration, and reclamation**」以保障 memory resource 的 **controllability and freshness**。⚠️ **辨析**：§1 给的五段是 `generation → activation → fusion → archiving → expiration`，而 §5.4.3 正文给的是 `creation → activation → expiration → reclamation` —— **两处清单不完全一致**（正文多出 `reclamation`、少了 `fusion/archiving`）；**引用时不要合并成「五段」就完事，原文本身有两种列举**。状态机（§5.4.3 的例子，四个状态名）：`Generated`（自动生成的摘要初始标 Generated）→ `Activated`（被后续任务引用后转为 Activated）→ `Merged`（用户补充数据或系统检测到与历史记忆语义重叠 ⇒ 合并为新版本并标 Merged）→ `Archived`（「If a memory is **no longer accessed for a prolonged period**, it is **demoted to the "Archived" state and moved to cold storage**」）。**Time Machine**：`offers a "Time Machine" capability that **snapshots memory states and supports historical rollbacks**`；用法 = 把 archived 或 merged 的记忆**恢复到某个特定版本**，重新用于推理与上下文注入；用途 = **检测模型遗忘 / 处理用户撤回 / 反事实模拟**。**Frozen 状态**：`MemOS also supports a **"Frozen" state for critical memories—like legal agreements or standard guidelines—where updates are disabled and full modification histories are retained** for auditing, compliance, or education`。🔑 **最值得抄的一句**：`a user might unarchive an old clause to perform "**what-if**" simulations, **without impacting the canonical frozen version and its audit trail**` ⇒ **回滚/反事实演练发生在一个副本上，不影响「权威冻结版本」及其审计链**。调度后果：「**Lifecycle states directly influence scheduling priority and storage allocation**」。`Version Chain` 提供版本控制/冲突消解/回滚的底层；`MemVault` = "Versioned store"。
- **⑧ 依赖与成本**：**未读到**明确的常驻服务/图库/向量库依赖清单与延迟数字（§6.2/§6.3 未读）。可读到的线索：MemScheduler 以「optimize for **low latency**」为目标；MemOperator 有「Pipeline Coupling and **Caching Strategy**」；有「KV-Based Memory Acceleration」专节（**内容未读到**）。⚠️ DSH 商店里 **MemTensor/MemOS** 条目自述「with **35.24% token savings** and DeepSeek Harness support」—— **这是商店页的营销描述，不是读到的论文章节，引用时须标明出处不同**。
- **⑨ 实测数字（Table 3，§6.1 "End-to-End Evaluation on LOCOMO"）**：主指标 **LLM Judge Score**（带标准差），另列 F1/RL/B1/B2/METEOR/BERT-F1/Sim；**Top-K 一律 20**。single hop：langmem 68.21±0.06 · zep 50.42±0.29 · openai 61.83±0.10 · mem0 73.33±0.20 · **memos-0630 78.44±0.11**；multi hop：56.74 / 42.20 / 60.28 / 58.75 / **64.30±0.44**；open domain：49.65 / 38.19 / 32.99 / 45.83 / **55.21**；temporal reasoning：24.09 / 19.11 / 28.25 / 52.34 / **73.21±0.25**。Chunk/Mem Tok：memos-0630 各任务 1511–1655；对照 openai 3924–4141、zep 2276–2351、langmem 134–209（最省）、mem0 1141–1176 ⇒ **MemOS 的 token 用量介于 zep 与 openai 之间，不是最省的**。⚠️ **口径备注（必须带）**：① 主指标是 **LLM-Judge 分数**（**不是** MemoryOS 的 F1/BLEU-1、也不是 Letta 的单一准确率）；② 表里 F1 等指标**未与 LLM Judge 同尺度**；③ 基线是 langmem/zep/openai(memory)/mem0，**不含 Letta、不含 MemoryOS**，**所以它无法与 Letta 74.0% 对话**；④ 结论句自述在 multi-hop 与 temporal reasoning 上尤其强；⑤ **一处可疑来源已如实记录**：抓取的是论文 HTML 文本流，下标/上标在去标签时会把数字拆开（部分 F1 列出现 `4 5.55`、`3 8.32` 这类断字）⇒ **只采信 LLM Judge Score 列（该列无断字），其余列未采信**。
- **⑩ 适配判定**：**需改造**。设计哲学（生命周期、provenance、versioning、权限、可审计、Time Machine/Frozen）与我们「可审计」目标**高度同向**（论文也明确批评 RAG「lacks lifecycle tracking, versioning, and permission-aware scheduling」），**但它的价值主张有一大块建立在「参数记忆/激活记忆/KV 加速」这些我们完全不用的载体上** ⇒ **真正可迁移的是数据模型与状态机，不是它的系统**。可行点：§4.2 的三组属性**全部可以用 SQLite 列表达**，无需任何额外基础设施。
- **⑪ 能照抄的具体机制（按 §4.2 三组属性逐条落到列）**：`Origin Signature` 四值枚举当 `source` 列；`Semantic Type` 三值枚举当 `kind` 列；`Timestamp` 用于 lifecycle modeling（Creation 或 Last update）；**`Version Chain`（修改历史 + 派生谱系）** —— 「可审计」最核心的一条；`Compliance & Traceability` = sensitivity tags + watermarks + logs（敏感度标签直接可用）；`Lifespan Policy`（TTL 或 decay）+ `Priority Level` 两列；`Access Control`（read/write/share scope）对应会话分闸；状态机取值 `Generated → Activated → Merged → Archived`；**Time Machine 的实现语义**（快照 + 历史回滚 + 「what-if 演练不影响权威冻结版本及其审计链」= **回滚走副本、权威版本只读**，比「直接改回去」安全得多）；**Frozen = 禁写但全历史保留**；`Archived` 的触发条件是「长时间未被访问」且是**降级不是删除**；论文的问题陈述可当「卖点清单」（长期依赖建模 / 知识演化 / 个性化与多角色 / 跨平台迁移与 **"memory islands"（记忆孤岛）**）。
- **⑫ 已知失败模式**：**对 RAG 的诊断**（§1）：「RAG remains fundamentally an "on-the-fly retrieval and transient composition" pipeline … lacks core memory manageability features such as **lifecycle tracking, versioning, and permission-aware scheduling**」；「it may **cite outdated and new regulations simultaneously without reconciliation**. It cannot **retire obsolete facts**, prioritize reliable ones, or track knowledge evolution」。**对工具化记忆（Stage 3，含 Letta）的诊断**（§2.3/§2.4）：「most work in this stage remains limited to **interface-level utilities**」；「"tooling" memory lacks a sustainable and scalable governance architecture … **Just as system calls alone cannot build a complete OS**」。**对闭源助手的批评**：「ChatGPT and Claude now offer memory, issues persist: **capacity limits, unstable access, opaque updates, and missing editability**」。**对自己的失败模式：作者基本没有自陈**；可如实记录的只有一处**内部不一致**（生命周期五段 vs 四段，**属我方观察，非作者自陈**）。另：§6.2/§6.3/§7 未读到 ⇒ 「Memory Retrieval 专项」与「KV 加速」的效果无法评估。

#### A-6 Basic Memory

- **① 代表/链接/许可/读到哪**：Basic Memory / basicmachines-co。文档 <https://docs.basicmemory.com>；仓库 <https://github.com/basicmachines-co/basic-memory>。许可 **AGPL-3.0** —— 文档页 `/raw/reference/technical-information.md` 有专节「Licensing」明写「Basic Memory is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**」，并列出后果：**Copyleft**（Derivative works must be distributed under the same license）、**Network Use**（Network users must be able to receive the source code）、Commercial Use 允许但受许可约束。⚠️ **未读到 LICENSE 文件本体**（`.../LICENSE` 与 `.../LICENSE.md` 经桥均 **HTTP 422**）⇒ **许可是从官方文档页读到的，不是从 LICENSE 文件读到的，引用时请标这个区别**。读到：文档站结构化正文（走 `/raw/*.md`）：`reference/technical-information`（架构 / 数据存储与隐私 / 实现细节 / Files as Source of Truth / Sync Process 五步 / 组件交互四层 / 性能特征 / 许可）、`concepts/knowledge-format`（frontmatter / Observations / Relations / wikilink 解析 / permalink / 文件组织 / schemas）、`concepts/semantic-search`（三种检索模式 / 混合融合公式 / chunking / 去重 / 嵌入提供方 / 阈值 / reranking / inspect 工具）、`reference/mcp-tools-reference`（全部 MCP 工具与参数）。**未读到源码**。【文档·abstract】
- **② 一句话架构**：**文件为真源（file-first）、SQLite/Postgres 只是二级索引**：「所有知识都是标准 Markdown 文件，数据库只当二级索引」。五个组件：Core Knowledge Engine（解析/索引 Markdown）/ Database / MCP Server / CLI / **File Watcher**；知识模型 = Entities + Observations + Relations + Tags；检索是「全文 + 向量」混合。
- **③ 数据形状**：文件 = 普通 `.md` + YAML frontmatter（`title`/`type`/`tags`/`permalink`/`created`/`modified`，可加任意字段）。实体内三层：**Entities**（一个 md 文档）→ **Observations**（`- [category] content #tags`，每条独立索引）→ **Relations**（`- relation_type [[Target Note]]`，edge）。`permalink` 由文件路径派生、**文件改名/移动后不变**（内部寻址标识，形如 `memory://authentication-design`）。库侧 = Knowledge Graph Schema（图谱表）+ Search Index（全文索引），**chunk 级**存储；**每条 observation/relation 有自己的 permalink**（事实级寻址）；示例 JSON 里 entity 有 `checksum`（sha256 形），且**每个 chunk 有内容哈希**用于去重。
- **④ 写入路径**：谁写 = **AI 通过 MCP 工具写**（`write_note`/`edit_note`），人也直接编辑文件（编辑器/Git）；何时写 = 对话中，或人改文件 → **File Watcher** 侦测。**写前闸门（本组最值得抄的部分）**：① `write_note` 的 `overwrite` 默认 false（写已存在路径**返回错误**）；② **拒绝「命名孪生」**（若目录已有 `Project Plan.md` 的常规等价物，写 `project-plan.md` 返回错误）；③ `edit_note` 的 `expected_replacements` 默认 1（find_replace 必须精确命中预期次数）；④ `expected_checksum`（Cloud，「stale or intersecting edits are rejected」= **乐观并发控制**）；⑤ `schema_validate`/`schema_diff`（对某 `note_type` 做结构校验与漂移检测）；⑥ `schema_infer` 的 `threshold` 默认 0.25（字段出现频率低于 25% 不进 schema）。⚠️ **这些都是结构与并发闸门，没有「内容真实性」闸门。**
- **⑤ 检索路径**：三种模式 `text`（关键词，支持 AND/OR）/ `vector`（语义）/ **`hybrid`（默认）**；未指定时 resolves to hybrid when semantic search enabled。**混合融合的具体算法**：文本与向量各自打分后 score fusion —— 「Results found by both keyword and meaning match rank highest. **The dominant signal (whichever source scored higher) is preserved, while the weaker signal adds a 30% bonus.** Items found by only one source keep their original score.」**查询放宽**：strict **all-words** 文本查询返回空时，hybrid search **retries it as a relaxed any-word query**（v0.23 起对 CJK 等非拉丁文字也生效）。**多跳=是，有专门的图遍历工具**：`build_context(url=memory://..., depth=1(默认), max_related=10, timeframe=7d(默认))` 从起始实体沿关系遍历到可配置深度（depth 可给 2/3）。**agent 能迭代调用**（工具集齐全：search_notes / build_context / read_note / recent_activity / list_directory / read_content / view_note…）。过滤：`note_types`、`entity_types`、`categories`、`tags`/`tag:`、`metadata_filters`、`after_date`、`min_similarity`（per-query 覆盖全局阈值）、`search_all_projects`。
- **⑥ 整理/巩固**：有持续整理，**但不是 LLM 摘要式** —— **Sync Process 五步**：① Detect Changes ② Parse Files ③ Update Database ④ **Resolve References**（「Resolves forward references when new entities are created」= 解决悬空 wikilink）⑤ Update Search Index。触发 = **File Watcher**（real-time）。**去重/增量**：每个 chunk 有内容哈希，重同步时**未变 chunk 跳过重索引**，「Editing one note in a thousand-note knowledge base only re-indexes the chunks that changed」= **几百条规模下最省钱的机制**。重建：`bm reindex`（增量）/`--full`/`--embeddings`/`--search`；且明确「**索引只是派生物，随时可重建**」。
- **⑦ 遗忘/失效**：**只有显式删除**（`delete_note`，可 `is_directory`；`delete_project` 有 `delete_notes` 参数，**默认 false（文件保留）**）。版本/回滚（Cloud 侧）：`Snapshots`（时间点备份）、`File history`（每笔记的版本历史，可恢复或合并）。**无静默淘汰**（没有任何类似 Heat/FIFO 的自动衰减机制）。
- **⑧ 依赖与成本（稀有的实测量级）**：组件见 ②；本地默认 **SQLite + `sqlite-vec`**（「SQLite always uses sqlite-vec」），可选 Postgres（pgvector 或 milvus）；嵌入默认**本地** `fastembed` + **`BAAI/bge-small-en-v1.5`，384 维**，「no API key, no network calls, no cost」（可选 OpenAI `text-embedding-3-small` 1536 维）；`semantic_min_similarity` 默认 **0.55**、`semantic_search_enabled` 默认 true。性能：「For **a few hundred notes**, expect **1–3 minutes** for the initial index build」（**正对我们规模**）；「Handles knowledge bases with **thousands of documents**」；reranking 短文 **~90 ms at p50**、长转写 **p95 从 420 ms 升到约 2.1 s（约 5×）**。chunking：prose 段合并为 **~900 字符 / ~120 字符重叠**，Headers/Observations/Relations 各自成 chunk。rerank 默认 `reranker_enabled=false`、`fastembed`、`jinaai/jina-reranker-v1-tiny-en`、`candidates=20`、`timeout=30.0`。**失败行为（值得抄）**：rerank 失败**不回退**到原顺序 —— 临时失败返 **503**、响应畸形返 **502**。借鉴来源自陈：draws on ideas from **QMD**（BM25 + 向量，local-first）。
- **⑨ 实测数字**：**未读到任何 benchmark 分数**（文档里没有 LoCoMo 之类），只有上列性能/延迟数字与「几千文档」的量级声明 —— **如实标注**。
- **⑩ 适配判定**：**可行度最高的一条**。理由：SQLite + sqlite-vec + 本地 fastembed **全部是进程内/文件级**（无需常驻服务、无需 API key）；「几百条 → 1~3 分钟首次索引」正对我们规模；「文件为真源、索引可重建」天然可审计（git 可版本化）。**唯一实质冲突：许可**（AGPL-3.0 + Network Use ⇒ **借机制，不借代码**）。次要改造点：MCP Server + File Watcher 是常驻进程 ⇒ 要么接受一个轻量 watcher，要么在写入时同步触发（「懒同步」）代替 watcher。
- **⑪ 能照抄的具体机制（最多）**：**`- [category] content #tags` 的 observation 语法 + 每条独立索引**（「纯 Markdown 也能做事实级检索」的核心技巧：能直接命中单条事实而非整篇；**配套陷阱**：`[ ]`/`[x]`/`[X]`/`[-]`/`[/]`/`[>]`/`[?]` 这些 checkbox 标记**不算 category**，时间戳形前缀也不算）；**`- relation_type [[Target]]` + 「关系可指向尚不存在的笔记」**（配合 sync 的 Resolve References = 「先写边、后补节点」的廉价做法）；**混合融合「主信号保留 + 次信号 ×30% 加成」**；**全词空则放宽为任意词**；**chunk 内容哈希去重 + 只重索引变更 chunk**；**permalink 不随文件移动而变**（稳定 ID，对可审计极重要）；**写入门槛三连**（默认拒绝覆盖 / 拒绝命名孪生 / expected_replacements 默认 1）；**`schema_infer` 阈值 0.25**（从既有笔记「长」出 schema 而不是先定 schema）；**chunking 参数 900/120**；**rerank 失败不回退 + 503/502 语义**（宁可明确失败，也不给「看起来还行」的静默降级）；**检索可解释工具**（`bm inspect query --show-misses`「shows every stage and why candidates were dropped」+ `inspect chunks` 的 per-chunk 状态 `ready/pending/stale/orphaned`，其中 **orphaned = 换了模型后向量检索返回空**）；**图扩散的保守默认值**（`timeframe` 默认 7d、`build_context` depth 默认 1、`max_related` 默认 10）。
- **⑫ 已知失败模式**：**自陈** —— reranker 失败会**让整个请求失败**（「A retryable failure from any project **aborts a multi-project result page** instead of returning partially reranked results」，作者把它写成有意的取舍：用可用性换顺序契约）；**自陈** —— 换 embedding provider/model 后**必须 `bm reindex --embeddings`**，否则向量检索**静默返回空**（`orphaned`），这是一个**已知的、由配置变更触发的静默失效**；**自陈** —— Intel Mac 上默认本地嵌入模型**跑不了**（需改 OpenAI 或钉住 `onnxruntime<1.24`）；**自陈** —— `bm reindex --embeddings` 失败时 exits nonzero，「Treat that as an **incomplete vector index**」。**未读到**作者对检索质量/幻觉类失败模式的自陈。

#### A-7 dsh-memory「灵枢 LINGSHU」

- **① 代表/链接/许可/读到哪**：`FuRongJun-1999/dsh-memory`。商店 <https://dsh.deepseek404.com/detail.php?id=FuRongJun-1999%2Fdsh-memory>；仓库 <https://github.com/FuRongJun-1999/dsh-memory>。**许可：未读到**（商店详情页无 license 段；源码经桥不可达）。规模信号：Stars 298 / Forks 22 / Issues 6 / 更新「今天」；自称 **v0.6.1**。读到：**商店详情页全文**（README 投影，含架构图、工具表、FAQ、发布说明索引），以及页面里**引用的源码行号锚点**（如 `md_cg/mcp_server.py#L578`、`#L2051`、`#L3104`）—— ⚠️ **行号来自 README 表格里的链接，我只据其转述、未验证内容** ⇒ 本文件凡引这些行号处均标「**转述未验证**」。【文档·abstract】
- **② 一句话架构**：**记忆本体是一份纯 md「认知图」（`md_cg/`），检索与写入裁决由确定性规则引擎（含自研 Rust 内核）完成，全程零 LLM 判断**；以标准 stdio MCP server 形式给任何 MCP 宿主挂载。
- **③ 数据形状**：真源 = `md_cg/` 下的**纯 markdown 认知图节点**（「记忆本体是纯 md 文档，任何编辑器可直接打开审阅」）。**CCG 六要素记忆卡**：`# 功能名 / # 生效条件 / # 子功能 / # 执行 / # 验证方式 / # 不适用条件`（各占一行、以 `# 要素名：` 起首）。**两个基元 + 40 个 op**：`cg`（认知图统一入口，**36 个 op**）与 `stg`（「语义时空图」入口，**4 个 op**：`relation`/`timeline`/`anchors`/`consistency`）；`MDCG_MCP_SURFACE=full` 时另暴露 **31 个 `mdcg_*` 工具**（`mdcg_remember`/`mdcg_recall`/`mdcg_search`/`mdcg_forget`/`mdcg_protect`/`mdcg_identity`/`mdcg_metacognition`/`mdcg_flywheel`/…）；三档 `tools` 模式 `core`（默认，2 工具）/`brain`（30）/`all`（30，排除 3 个宿主级风险工具）。**记忆分层命名**（`--layers-allow` 取值）：`knowledge`/`contextual`/`structural`/`self`/`goals`/`unresolved`/`rejected`。检索门控有「S1 域收敛 / S1b 桶收敛 / S2 条件硬槽」，且提到「仅 1 个桶的库不说『分区正常』」。
- **④ 写入路径**：谁写 = agent 显式归档（`cg(op=write)` / `mdcg_remember`），或**自动记忆钩子**（DSH session/event：自动召回注入 + 自动记忆）。**写前闸门（本组最重的一套）**：**三道闸门**「`cg(op=write)` 需依次穿过 **audit → 一致性 → gated 三问四态** 三道闸门，非 ACCEPT 均不新增落盘点」；**落盘充要条件 = 最终判定 `ACCEPT`**，返回体 `{"ok": true, "committed": false, "moved_to": "review_queue"}`，并明确警告「**别把 `ok: true` 当写成功**」（是否落盘只看 `committed`）；**策略闸门 fail-closed**：`text` 类写入按 `<包>/data/policy.json`（可用 `MDCG_POLICY_FILE` 覆盖）审核，**缺 CCG 六要素或命中禁表即 `REJECT`**（`moved_to: "rejected"`，**记入负记忆**）；**策略不可用时 fail-closed**（既不落盘也不进审核队列，`moved_to: "policy_unavailable"`）；**策略形状校验**：`forbidden`/`required`/`required_kinds`/`required_labels` 任一写成标量即 `policy_bad_shape`（「数组之外的值没有唯一读法，闸门不猜」）；**权限闸门**：写入凭据 token 分角色（`designer` / `recorder` 最小权限）+ `--ops-allow`/`--layers-allow`，未配凭据即**只读 `guest`**；**可验证类型旁路**：`content_kind: 'code'`，**AST 解析通过即 ACCEPT**；**编译者不得自证**：`cg(op=ccg)` 三步骤「① 编译 → ② 复核（编外单元裁决）→ ③ 落库」，机械拒绝码 **`E041` 自证拒绝**（「不依赖 prompt 自觉」）。幂等：`init` 重跑输出一致；「幂等提交」在 v0.5.1 修复列表里。
- **⑤ 检索路径**：**规则化检索引擎**，「记什么、取什么 … 全部由确定性规则裁决，**零 LLM 黑箱判断**」。两跳/多跳：`cg(op=route)`（条件路由）+ `stg(op=timeline)`（时间线回溯）跨会话取出；README 示例把「召回注入」与「条件路由+时间线」分成两段动作。**agent 能否迭代多次调用：能**（40 op + 31 细粒度工具，全是 MCP 工具面）。检索性能（自报）：「Rust 检索内核（零第三方依赖）」；**中文检索 hit@1 99.0%**。缓存开关：`MDCG_READ_CACHE`（默认开）、`MDCG_HOTCACHE`（默认关）、`MDCG_RETRIEVAL_PIPELINE`（默认关）、`MDCG_UNIFY_QUERY`（默认关）。
- **⑥ 整理/巩固**：**有，且是显式 op**：`cg(op=consolidate)`（知识固化）、`mdcg_flywheel`（知识飞轮）、`cg(op=maintain)`/`cg(op=sustain)`（自维持巡检）、`cg(op=scrub)`（记忆自净）、`cg(op=session)`（重要性评分·预算装包·分层注入）。**结构变更账本/回滚**：`cg(op=evolution)` + `mdcg_restore`。
- **⑦ 遗忘/失效**：**只显式遗忘，无静默淘汰（核心卖点）** —— 「遗忘只能由显式 `cg(op=forget)` 发起、**不做静默淘汰**」；`mdcg_forgetting_history` 留档；`cg(op=protect)` 加密/保护；「**检索索引只是派生物、随时可重建，原文即真源**」；**负记忆**：`REJECT` 的写入**记入负记忆**（`mdcg_rejected`、`mdcg_unresolved`）—— 「拒绝过什么」也是一等记忆。
- **⑧ 依赖与成本**：前置 = Node ≥ 22.19；DSH 内核 ≥ 0.1.2-rc.1（**已验证至 DSH 0.17.2**）；**Python 解释器**（插件自选 `python`/`python3`）；「大脑零安装」（`md_cg` 随包自带）。**常驻进程：是** —— 「灵枢的大脑（`md_cg`）是 **stdio 长驻进程**」，且**升级后必须重启**（有跨代混用的 `ImportError` 已知坑与 `code_generation`/`disk_generation` 自检）。**成本/延迟数字：未读到**。
- **⑨ 实测数字**：**中文检索 hit@1 99.0%**（自报，「六家横评同口径登顶」）；可复现数据集（随仓公开）`locomo-zh-500`（500 题）、`bench6-100-zh-en`（六家横评·中英双查）；第三方复评：七轮统一评分 **9.258**（收敛轨迹 7.79→9.258）；**LoCoMo 独立复现**「自报数字**逐位一致**」，归因拆解「中文摘要层 vs 英文归一化 **81.0%**」。⚠️ **诚实的负面/边界（作者自曝，很难得）**：端到端 LoCoMo QA 同口径对照 —— **检索注入 QA 17.2% / full-context 16.4%**；**自然问句诚实下界 hit@10 40.2% vs 派生题面 92.0%**；统一归一层 A/B **CCG+RRF 形态 −11.7pp**（批次 15 边界反馈）；防火墙与 LLM 裁决对**无标记干扰均无增益**（REJECT 恒 0）；端到端干扰池评测 LoCoMo 上游 gold **43.3%/40.0%**；方向拍板「**认知图概念桥接（不上向量）**」；自评声明「能力自评与第三方复评 … **内部标尺非横评声明**」。⚠️ **口径备注**：这些数字**多为自报或自组织评测**，且作者**自己标注了「非横评声明」**，引用须带这层限定。
- **⑩ 适配判定**：**需改造**。理由：**理念几乎完全对齐我们的约束**（纯 md 真源、索引可重建、不静默淘汰、显式遗忘、可审计、fail-closed 不假装成功），**但代价是常驻 stdio 进程 + Python + Rust 内核 + npm 插件 + 一套 token 权限体系**，对「几百条记忆」是**严重过度工程**；而且它是以 DSH 插件形式落地，要不要引入一个完整 MCP 记忆服务器是需要单独决策的事。
- **⑪ 能照抄的具体机制**：**`committed` 字段与「绝不假装成功」**（「别把 `ok: true` 当写成功」，落盘只看 `committed`）—— **本组最值得抄的一条**；**fail-closed 而非 fail-open**（策略读不到 → 不落盘、也不进队列）；**`policy_bad_shape` 的判据哲学**（「数组之外的值没有唯一读法，闸门不猜、也不会把字符串按字符拆成规则」= 歧义即拒绝）；**负记忆**（被拒绝/未决的写入也当记忆存 + 完整缺失清单 `verdict.detail.missing`）；**显式遗忘 + 遗忘历史留档**；**记忆分层授权 + token 角色分级**；**「编译者不得自证」（E041）**（产出候选的一方不得自己批准落库 —— 不需要 LLM 的职责分离机制）；**可验证类型旁路**（`content_kind:'code'` → AST 通过即 ACCEPT，用确定性验证器替代 LLM 审核）；**`stale_on_disk` / `restart_required` 自检字段**（进程持有的代码代次 vs 盘面代码代次）；**自动召回注入 + 不可信边界声明**（注入的记忆要标「这是不可信内容」，v0.6.1 修复项之一）。
- **⑫ 已知失败模式**：**自陈** —— 升级后不重启会跨代混用 → `ImportError: cannot import name 'mint_auto_id'`，且「**报错点离根因很远**，极易被误判成『代码坏了』」；**自陈** —— 端到端能力**远低于**其检索指标（自然问句 hit@10 40.2% vs 派生题面 92.0%；端到端 QA 17.2%）；**自陈** —— 统一归一层是**负收益（−11.7pp）**；**自陈** —— 证据防火墙对无标记干扰**无增益**；**自陈** —— 未配凭据时**只读**，写入**静默不落盘**（用户容易误以为写了）；**自陈** —— 一个未解决的口径问题「召回与时间线读写两侧会话口径同尺」（v0.6.1 才修）。

#### A-8 opencontext

- **① 代表/链接/许可/读到哪**：`melandlabs/opencontext`。商店 <https://dsh.deepseek404.com/detail.php?id=melandlabs%2Fopencontext>；仓库 <https://github.com/melandlabs/opencontext>；项目页 <https://openloomi.ai>。许可 **Apache-2.0（自述）** —— 商店页 README 末尾「## License — [Apache-2.0](.../LICENSE). © 2026 Meland Labs.」+ 页首 LICENSE 徽章；⚠️ **LICENSE 文件本体未读到**（经桥不可达），**许可是从商店页 README 读到的**。规模：Stars 76 / Forks 7 / Issues 5 / 更新「今天」。读到：**商店详情页全文**（README 投影：Features 表、Benchmarks、Quick Start 六种接入、Architecture 图、Why It Is Different、文档索引、License）。**源码未读到**。【文档·abstract】
- **② 一句话架构**：**库优先的「上下文运行时」**（不是记忆库、也不是向量库）：一个 `valid_from`/`valid_until` 的**时序有向无环图** + 统一 memory API + 检索原语 + 确定性 Loop 引擎 + 多平台集成网格。
- **③ 数据形状**：**Temporal Context Graph** —— 「A directed acyclic graph where **every fact has `valid_from`/`valid_until`**. **Supersession, contradiction, and merge are first-class edges** — corrections are **append-only, not destructive**.」消息/事实：一条 message 就是一条事实，字段形如 `{ messageId, userId, content, platform, botId, timestamp, createdAt }`，**`messageId` 使重复摄入幂等**。`IntegrationRecord`：跨 Gmail/Slack/Telegram/Linear/Jira/iMessage/Feishu/Weixin 的统一形状。三层索引：`memory` + `insights` + `knowledge`（统一检索会 fan-out 到三者；未接的源只发 warning）。标签/来源：`--source` / `--kind` / `--tag key=value` / `--at`。
- **④ 写入路径**：谁写 = 宿主应用 / CLI（`opencontext add`）/ MCP 工具（`oc_remember`）/ 自动捕获（DSH 插件「Captures user messages into durable memory」）。**写前校验/闸门：偏弱** —— 公开材料里**未见内容闸门**；有的是**幂等**（`messageId`）、**凭据/策略**（`policies` 是 doctor 的一个 section）、**URL allowlist/blocklist**（出站调用）、Fernet 对称加密（secrets）。⚠️ 注意 CLI 一句很关键：「`add` writes a single raw message to the active manager **with no LLM roundtrip**」⇒ **写入路径不含 LLM**。
- **⑤ 检索路径**：统一 search `store.search({userId, query, limit})`，返回 `hits.count` / `hits.sources`（**实际被查询的子索引**）/ `hits.warnings`（**按源的降级**，如缺 embedder）；模式 `--mode {auto|lex|sem}`、`--k`、`--threshold`、`--since`/`--until`、`--explain`（surface reasoning + warnings alongside the hits）。**融合**：CLI 明写「Plain hybrid search (**RRF** across memory + insights + knowledge)」= 用 **RRF（倒数排名融合）**。**`--context-only`**：「Inspect what would have been sent to the LLM, **no synthesis call**」= **可审计性做进 CLI**。**多跳/扩散：未读到**明确的图扩散检索 API。**agent 能否迭代调用：未读到**。
- **⑥ 整理/巩固**：**`memory-consolidation job`**（在 `packages/ai` 里）；DSH 插件「Summarizes sessions at natural breakpoints (**opt-in**)」。
- **⑦ 遗忘/失效**：**不是删除，是「被取代」**：`valid_from`/`valid_until` + supersession/contradiction 边；「corrections are **append-only, not destructive**」；**可答历史态** —— 「"**what did we believe last quarter?**" is a real, citable query」；**合规**：明确对齐 **MiFID II / SEC retention rules**；`packages/audit` → 结构化审计日志写 `~/.opencontext/logs/audit.jsonl`。
- **⑧ 依赖与成本**：单依赖 `pnpm add @melandlabs/opencontext`（bundles contracts · memory · rag · loop · agent）；存储后端 `sqlite-vec` · `postgres` · `indexeddb` · `chroma` · `pgvector`，**默认 SQLite**（`MEMORY_STORE_DB_PATH`，默认 `./memory.db`）；嵌入 `--embedding-provider local`（本地）或云端；**可常驻可选**（HTTP daemon 默认 `127.0.0.1:7421`；也可 `mcp` 模式；也可以**纯库内嵌**，无服务）；成本自述：「the deterministic Loop engine **only invokes the LLM when there is real work**, so it does not become a token-burning always-on loop」。
- **⑨ 实测数字（⚠️ 自报，且作者自己加了双重免责）**：**LongMemEval-S 97.6%**、**LoCoMo-V2 97.4%**、**BEAM @ 10M 67.0%**（"Factual recall at a 10M-token context window"，标注 **current as of 2026-08**）。⚠️ **作者自己的口径声明（原文）**：「Scores above are **opencontext self-evaluations** on the public datasets, produced by **our own harnesses** under `benchmark/`. They are **not Agent Memory Leaderboard (AML) results** — AML evaluates against **private refined datasets** on its own platform.」⇒ **97.4% 这个数字不能与 Letta 74.0% 并列比较**；**这是本组里「自报 vs 第三方」分歧最大的一个**。
- **⑩ 适配判定**：**需改造（但底层选型与我们最接近）**。理由：**默认就是 SQLite（`sqlite-vec`）+ 本地嵌入 + `./memory.db`**，且**可以纯库内嵌、不起服务** —— 完全符合「纯 SQLite、不许常驻服务」；**但它是 TypeScript/pnpm 生态**（我们是 Python 侧则需跨栈桥接），且它自称 "runtime substrate"、要接管 Loop，**超出「只借记忆机制」的范围**。
- **⑪ 能照抄的具体机制**：**`valid_from`/`valid_until` 两列 + supersession/contradiction/merge 三种一等边 + append-only 更正** —— 「可审计 + 能回答历史态」的最小实现，**纯 SQLite 两列即可**（本组内第二条最值得照抄的机制）；**`messageId` 幂等**；**检索可解释性三件套**（返回体带 `sources` 与 `warnings`；CLI 带 `--explain` 与 `--context-only`）；**RRF 做多源融合**（比「主信号+30%」更标准、更少调参）；**`opencontext doctor`**（只读、9 个 section：runtime/filesystem/loop/memory-store/embedding/policies/audit/security/integrations，每段 pass/warn/fail，「No auto-fix in v1」，健康时 **exit 0**、`--json` 给 CI 用）；**审计日志固定落一个 jsonl 文件**；**Loop 引擎的「先判断有没有真活再调 LLM」**（「LLM calls are not the foundation — they are the last step.」）；**`add` 不含 LLM roundtrip**。
- **⑫ 已知失败模式**：**自陈** —— benchmark 分数是**自评**，「not AML results」，AML 用**私有精炼数据集**；**自陈** —— 未接的子索引只会 **warning 降级**（「Sources you haven't wired up just emit a warning — fine for a single-backend deploy」）⇒ **检索结果是「部分源」的，可能静默不全**；**自陈** —— `doctor` **不做自动修复**（"No auto-fix in v1"）。

#### A-9 dsh-memory-eternal / memory-eternal

- **① 代表/链接/许可/读到哪**：`EternalNight996/dsh-memory-eternal`。商店 <https://dsh.deepseek404.com/detail.php?id=EternalNight996%2Fdsh-memory-eternal>；仓库 <https://github.com/EternalNight996/dsh-memory-eternal>；新仓库（升级版）<https://github.com/EternalNight996/memory-eternal>。**许可 MIT（已核，用 npm registry 元数据独立复核，非仅采信任务情报）**：`npm view dsh-memory-eternal license version` → `license = 'MIT'`, `version = '0.7.0'`；`npm view memory-eternal license version` → `license = 'MIT'`, `version = '0.10.0'`（`npm registry` 本机可直连 ⇒ 这条许可是**包元数据级**证据）。规模：Stars 14 / Forks 1 / Issues 4 / 更新「1 个月前」；**README 顶部显式声明已升级为独立新项目 `memory-eternal`**（npm `memory-eternal`，v0.10.0，1 天前）。读到：**商店详情页全文**（README 投影：定位 / 五分钟上手四端 / 命令速查 / 服务自管理 / 记忆配置全表 / 审核中心与回收中心 / 三套一键配置 / 部署强度表）。**源码未读到**（GitHub 不可达）。【文档·abstract】
- **② 一句话架构**：**对话结束自动把知识沉淀成「知识卡」写进本地 `~/.dsh/memory-vault`（纯 Markdown，可 git 管理）**，agent 用 `memory_recall` 按需召回；**新卡先进审核中心（pending），人工批准才进主库**。
- **③ 数据形状**：**纯 Markdown Vault**，默认目录 **`~/.dsh/memory-vault`**；「**SQLite/纯 Markdown 存储，零第三方依赖**」（商店摘要原文）。单位 = **知识卡（knowledge card）**，带 **`submittedBy`** 字段区分作者（`DeepSeek Harness` / `claude-code` / `codex` / `cursor`）—— **同一套库、三种 agent 共用，靠 `submittedBy` 溯源**。知识图谱 + 分类/日期/智能体三个筛选维度；**主库 vs 待审库分离**（「主库只显已审核、审核中心管新卡」）。
- **④ 写入路径**：谁写 = ① **自动沉淀**（每轮对话结束自动发生，默认开）② 手动 `dsh-memory capture "…"`（`-` 可读 stdin）③ `dsh-memory sweep ~/.claude/projects`（**挖掘已有会话记录**）。何时写 = **会话结束**（Claude Code 写 `~/.claude/settings.json` 的 `SessionEnd` hook；Codex 写 `~/.codex/hooks.json` 的 `Stop` hook；Cursor 写 `~/.cursor/hooks.json` 的 `stop`/`sessionEnd` hook）。**写前闸门（本组里「人机协同」最明确的）**：**新卡默认进审核中心（`pending`）**，「由你确认后才入主库」；**驳回的进「已驳回」，可恢复或删除进回收站**；**免审条件** = `审核模式=全部免审` / `免审智能体` / `免审类型` 命中则直接入库；**回收站软删 30 天内可恢复，超期自动永久删除**（`回收保留天数` 可配）；**成本/防滥用闸门（很具体）** = **`捕获最小长度` 默认 200**（「对话太短不存，避免闲聊浪费」）、**`日配额` 默认 60**（「一天最多存几张，防 AI 烧钱」）、**`召回相关性阈值` 默认 2**（越大越准但漏得越多、越省）；**去重闸门** = `语义去重喂 AI` 默认开（调 AI 判断是否重复），**关掉则退回「简单去重」，省一次 AI 调用**；**蒸馏** = `蒸馏知识卡` 默认开（把对话压缩成精炼卡，**要调 AI、花钱**），**关掉 = 存原文，一分钱不花**；`蒸馏输出上限` 默认 **900** 字。
- **⑤ 检索路径**：工具 = **`memory_recall`**（agent 按需召回）+ CLI `dsh-memory recall "数据库选型"`；设计要点自述「召回**只取相关小块**，省 token 少噪音」= **chunk 级召回而非整篇**；**自研 CJK 检索**（商店摘要标注的自研点）；**自动召回**默认开（「AI 需要历史时自动帮你查记忆」）。**是否多跳 / agent 能否迭代多次调用：未读到**明确的 tool_rules / 多跳机制（只知道 `memory_recall` 是一个 MCP 工具，可被多次调用）。可解释性：有 web UI 的「用量」页签。
- **⑥ 整理/巩固**：**有** —— 蒸馏（compress 成知识卡）+ 语义去重 + 合并（知识卡「增删改**合并**导入导出」）；触发 = 会话结束 hook（自动）/ 手动 capture / sweep 批量挖掘。
- **⑦ 遗忘/失效**：**软删 + 回收站**（软删卡 **30 天内可恢复，超期自动永久删除** —— **本组里唯一给出明确保留期的**）；**驳回留档**（「已驳回」页签保留，可恢复或删除）；**无静默淘汰**（没有任何自动衰减/Heat/FIFO 机制 —— 遗忘**必须经审核/回收流程**）。
- **⑧ 依赖与成本**：**零第三方依赖**（商店摘要原话）；「不改 DSH 源码」；**MCP 是协议不是常驻服务**（「agent 开会话才 spawn，用完即退，没有『开机自启』一说」）；**web 服务三种保活强度（内存数字很具体）**：个人开发（默认）`autoWebMode=init` + `watchdogAutoSpawn=off` → **web 47 MB 常驻**；7×24 `watchdogAutoSpawn=on` → **web + watchdog 47+47 MB**；真正开机自启（无 DSH）用 Windows 计划任务跑 `dsh-memory watchdog --port 7799 --interval 5000 --max-restart 10`，同样 ~94 MB。三套一键配置取舍表（A 轻量省心 / B 极致省钱 / C 高质量）含内存与 LLM 成本两列。⚠️ **一处不一致**：正文「服务自管理」段说 `watchdogAutoSpawn，默认开`，但同页表格里 A 方案（个人开发＝默认）写「看门狗 **关**」—— **两处关于默认值不一致，如实记录**。
- **⑨ 实测数字**：**未读到任何 benchmark 分数**（商店页没有）；性能/成本数字见上（47/94 MB 是稀有的**具体内存占用声明**）。
- **⑩ 适配判定**：**需改造（「纯 Markdown + SQLite」这一支最可用）**。理由：数据形态完全对齐（纯 Markdown Vault + 可 git + 零第三方依赖 + SQLite）且明确「不改 DSH 源码」；**审核中心 + 回收中心 = 我们要的「可审计 + 显式遗忘」**，且给了 30 天保留期这个具体数字；**但**它默认带一个 **web server（47 MB 常驻）** 与 **node 看门狗进程** —— 与「不许常驻服务」直接冲突，**不过 `autoWebMode=manual` + `watchdogAutoSpawn=off` 可以关掉** ⇒ **可退化为「只有 MCP 工具、用完即退」的形态**，这正是目标形态。次要：TypeScript/npm 生态。
- **⑪ 能照抄的具体机制**：**`捕获最小长度=200` / `日配额=60` / `召回相关性阈值=2` 三个默认值**（防闲聊灌库 + 防烧钱的现成参数）；**新卡默认 `pending`，人工批准才入主库** —— 且给出理由：「多数记忆产品（mem0 / Zep / agentmemory…）对话一结束就自动全量入库，好坏不论 —— 噪音、错误事实、敏感内容一起进库，之后又被召回，**污染上下文、放大幻觉**」（**这段批评是我们「审核闸门」最有力的外部论据**）；**主库/待审库分离 + 免审三条件**；**`submittedBy` 溯源字段**；**回收站 30 天 + 超期永久删除**（软删必须带保留期，否则软删等于永久删）；**`sweep` 命令挖掘既有会话记录**（冷启动回填的现成思路）；**「蒸馏关掉 = 存原文，一分钱不花」**（把「要不要调 LLM」做成用户可见开关而不是内建强制）；**服务强度的三档显式枚举（init / interval / manual）+ 内存代价标注**；**`dsh-memory setup --dry-run`**（幂等 + 预览：配置变更先预览再应用）；**「MCP 是协议不是常驻服务：用完即退」**（本身就是「不许常驻服务」约束下的设计立场表述）。
- **⑫ 已知失败模式**：**自陈** —— 默认会带来 **47 MB 常驻 web**，7×24 模式翻倍到 ~94 MB，并明确「**只在要 7×24 保活时开**」；**自陈** —— **蒸馏默认开、要花钱**（「💰 想省钱：把『蒸馏知识卡』关掉、调低『蒸馏输出上限』、调高『召回相关性阈值』」）；**自陈** —— `autoMcpSetup` 默认关，因为「关 = **不碰你本机配置文件**」（承认自动改用户配置是风险）；**自陈（跨版本）** —— 本项目**已被作者的 `memory-eternal` 取代**，「不再只依赖单一 DSH 服务」⇒ **若采用 `dsh-memory-eternal`，等于采用一个已被官方标记为过渡态的项目**（这是一个**必须写进结论的采用风险**）。**未读到**作者对检索质量/幻觉类失败模式的自陈。

### B 组（离线巩固/睡眠 + 多视图·超图·本体）

#### B-1 MAGMA

- **① 代表/链接/许可/读到哪**：MAGMA（Multi-Graph based Agentic Memory Architecture）/ Dongming Jiang, Yi Li, Guanpeng Li, Bingzhe Li（UT Dallas / U Florida）。arXiv **2601.03236v2**（**ACL 2026 Main**，另有 ACL Anthology `2026.acl-long.1709`），2026-01-06 投、2026-04-16 修；HTML <https://arxiv.org/html/2601.03236v2>；代码 <https://github.com/FredJiang0324/MAGMA>（**本机 GitHub 被 DNS 拦，未读到源码**）。许可：**论文 arXiv perpetual non-exclusive license**（arXiv 侧显示 `nonexclusive-distrib/1.0`）；**代码仓库许可未读到**。读到：**HTML 全文** —— §1 Introduction、§3 MAGMA Design（§3.1 架构三层 / §3.2 Data Structure Layer / §3.3 Query Process 四阶段 + Algorithm 1 / §3.4 Memory Evolution（Write/Update）+ Algorithm 3 / §3.5 Implementation）、§4 Experiments（Table 1–5）、§6 Limitations；**参考文献段被截断**。【论文 Method】
- **② 一句话架构**：把每条记忆当节点、用**四张正交关系图（semantic / temporal / causal / entity）解耦表示**，检索 = 按 query 意图加权的**策略式图遍历（beam search）**，并把写入拆成「**快通道摄取 + 异步慢通道结构巩固**」双流。
- **③ 数据形状**：**时变有向多重图** `G_t=(N_t,E_t)`。节点 `n_i=⟨c_i,τ_i,v_i,A_i⟩`：`c_i` 事件内容、`τ_i` 离散时间戳、`v_i∈R^d` 稠密向量（进向量库，引 FAISS）、`A_i` 结构化元数据（实体引用、时间线索、上下文描述符）。节点集**分层**：细粒度 atomic event → 高层 episodic grouping。边集分四子空间：**Temporal**（严格有序对 `(n_i,n_j)` 且 `τ_i<τ_j`，**不可变链**）、**Causal**（有向，边 `e_ij` 存在当 `S(n_j|n_i,q)>δ`，**由 consolidation 模块推断**）、**Semantic**（无向，`cos(v_i,v_j)>θ_sim`）、**Entity**（事件连到抽象实体节点，解决跨时间线「对象永久性」）。
- **④ 写入路径**：**双流**。**Fast path（Synaptic Ingestion）**：写入即建节点并 `Queue.Enqueue(n_t.id)` 触发慢通道 —— 低延迟、会话轮内同步完成。**Slow path（Asynchronous Consolidation，Algorithm 3）**：后台 worker 循环 `Queue.Dequeue()` → `G.GetNode(id)` → `GetNeighborhood(n_t, hops=2)` → `Format(N_local)` 拼 prompt → `Φ_LLM(Prompt)` 得 `E_new` → `G.AddEdges(E_new)`，**只加因果/实体边**（原文表述：trading compute time for relational depth）。**写前校验：无独立校验/审批环节、无 schema 层强制** —— 论文只在 Limitation 说「用结构化提示 + 保守推断阈值（conservative inference thresholds）减少伪边」；**「未读到具体校验实现」**。
- **⑤ 检索路径**：**多跳 + 扩散**，四阶段 —— (1) **Query Analysis**：轻量分类器把 q 映到 `T_q∈{Why, When, Entity}`（决定边类型偏好）；时间 tagger 把「last Friday」解成绝对窗口 `[τ_s,τ_e]`；同时出稠密向量 q→ 与稀疏关键词 q_key。(2) **Multi-Signal Anchor**：**RRF** 融合 vec/key/time 三路排名得锚点集，`S_anchor=Top_K(Σ 1/(k+r_m(n)))`。(3) **Adaptive Traversal**：**Heuristic Beam Search**，转移分 `S(n_j|n_i,q)=exp(λ1·φ(type(e_ij),T_q) + λ2·sim(n→_j,q→))`，其中 `φ(r,T_q)=w_{T_q}ᵀ·1_r`（意图专属权重向量，Why 给 CAUSAL 高权）；累积分 `score_v = score_u·γ + s_uv`（γ 为 decay）；每步保留 top-k，到 **MaxDepth 或 Budget** 停（**硬上限**）。(4) **Narrative Synthesis**：按意图拓扑排序（When 按 τ 排；Why 对因果边做拓扑排序保证因先于果）→ 每节点序列化成 `<t:τ_i> content <ref:id>`（**带溯源 ID，抗幻觉**）→ 按 Eq.(5) 分数做 salience token budgeting，低分节点折成 brevity code（如 `"…3 intermediate events…"`）。**agent 能否迭代调用**：**能** —— 检索本身是 agentic 的 policy-guided traversal（多步、有预算、可自选视图）；论文框架内是「路由器 + 遍历器」自动执行，**是否由 LLM 主动发多轮检索请求未读到明确描述**。
- **⑥ 整理/巩固**：**离线？是** —— 异步后台 worker（非阻塞会话）。**谁触发**：写入路径 enqueue 一条事件即触发队列，由专属 worker 消费。**留痕/回滚：未读到** —— 慢通道只 `AddEdges`，论文未描述边的版本、来源审计、撤销机制。
- **⑦ 遗忘/失效**：**未读到显式遗忘/删除策略**。只有遍历期的 salience budgeting 折叠（那是**上下文层压缩**，不是记忆层删除）。没有 TTL、没有打戳冻结的描述。
- **⑧ 依赖与成本**：存储层是「抽象异构物理后端」：typed memory graph + dense vector index + sparse keyword index，**可换内存实现或生产级图库/向量库**（论文称 seamless substitution）⇒ **常驻图库/向量库不是架构硬要求**（属实现层选择）。数字：**Build Time** MAGMA **0.39 h**（Nemori 0.29 / A-MEM 1.01 / MemoryOS 0.91）；**Tokens/Query** MAGMA **3.37k**（A-MEM 2.62k / Nemori 3.46k / MemoryOS 4.76k / Full Context 8.53k）；**Latency** MAGMA **1.47 s（最快）**（A-MEM 2.26 / Nemori 2.59 / Full Context 1.74 / MemoryOS **32.68**）；超长上下文下 **0.7k–4.2k tokens/query** vs Full Context **>100k**（即 **降低 >95%**）。
- **⑨ 实测数字**：**LoCoMo，LLM-as-a-Judge（gpt-4o-mini judge，同 backbone LLM 对比）**：MAGMA Overall **0.700** vs Full Context 0.481 / A-MEM 0.580 / MemoryOS 0.553 / Nemori 0.590（**Table 1**）；分类：Multi-Hop 0.528 / Temporal 0.650 / Open-Domain 0.517 / Single-Hop 0.776 / Adversarial **0.742**。**LongMemEval**：MAGMA avg **61.2%** vs Full-context 55.0% / Nemori 56.2%（Table 2）。**消融（Table 4）**：去 Adaptive Policy 跌幅最大（0.700→**0.637**），去 Causal 0.644，去 Temporal 0.647，去 Entity 0.666。**单图消融（Table 5）**：Causal Only 0.590 最高，Temporal Only 0.577（**Temporal 题 0.620 最好**），Entity Only 0.531 最低 ⇒ **单图最强也明显低于四图 0.700**。⚠️ **口径备注**：LLM-as-a-Judge 分数，**与 MemoryOS 的 F1/BLEU-1、Letta 的单一准确率不可比**；judge 与 backbone 同为 gpt-4o-mini 是**同类对比**（比 MemoryOS 的 DeepSeek-R1 自动打分更保守）；**规模门槛（几百条是否够）：未读到**论文给出的显式节点/边规模要求（**未读到**）。
- **⑩ 适配判定**：**可行（需改造）**。理由：**四张图 = 四张边表 + 一张节点表**；向量在几百条规模可退化为 `FTS5` 或存 BLOB 用 Python 算余弦；beam search 在几百节点上纯 Python/SQL 递归完全跑得动；**慢通道可以降级为「按需触发的进程内一次性巩固任务」**，不需要 worker 进程 —— 即**本体不依赖常驻服务，慢通道可降级**。
- **⑪ 能照抄的具体机制**：**四边表 schema** —— `nodes(id, content, ts, embedding)`；`edges_semantic / edges_temporal / edges_causal / edges_entity`（建议合并成带 `edge_type` 列的单表 + 部分索引）且 **causal 边必须带 `confidence` 与 `source_run_id`**；**`intent_weights(intent, edge_type, weight)` 表**（把 `φ(r,T_q)=w_{T_q}ᵀ·1_r` 落成配置表，Why/When/Entity 三套权重）；**转移分公式 `S=exp(λ1·φ+λ2·sim)` + 累积 `score_v=score_u·γ+s_uv`**（可直接照抄成打分函数）；**beam width / MaxDepth / token Budget 的硬上限**；**溯源序列化格式 `<t:ts> content <ref:memory_id>`**（每个进 prompt 的节点都带 ID —— 抗幻觉 + 可审计）；**consolidation 提示词骨架**（输入 = hops=2 邻域，输出 = **只输出新增 causal/entity 边的 JSON**，并要求写明 `source_run_id`）；**「只在慢通道加因果/实体边、语义边靠余弦阈值」的分工**。
- **⑫ 已知失败模式**：**作者自陈（§6 Limitations）** —— ① 图质量依赖底层 LLM 的推理能力，抽取错误/幻觉会**沿图传播**；② 多图基座带来额外的存储与工程复杂度；③ benchmark 只覆盖 LoCoMo/LongMemEval 两个数据集。**可推得（我方观察）**：slow path **只加边、不删边** ⇒ 长期运行边数**单调增长**（没有遗忘机制）；LLM 推断的因果边**有伪边风险**，而论文**没有审计/回滚** ⇒ 一旦写错无法定位与撤销。

#### B-2 sleep-time compute（Letta / UC Berkeley）

- **① 代表/链接/许可/读到哪**：Kevin Lin（Letta）、Charlie Snell（UC Berkeley）、Yu Wang、Charles Packer、Sarah Wooders、Ion Stoica、Joseph Gonzalez。论文《Sleep-time Compute: Beyond Inference Scaling at Test-time》arXiv **2504.13171v1**（2025-04-17）；代码 <https://github.com/letta-ai/sleep-time-compute>（仓库链路经 arXiv 摘要页 "this https URL" 确认）。论文许可 **CC BY 4.0**（arXiv abs 页 view license 已核）；**代码许可未读到**（未取仓库 LICENSE）。**读到哪：HTML 全文** —— §1–§7 + Appendix A/D/F；**关键补充**：HTML 只到 §7，但 Appendix F **给出了 Letta 侧最终代码**（我解码了 `rethink_memory` / `finish_rethinking` 两个工具定义）。**未读到**：Figure 12–18 的 prompt 正文（图片，本引擎不吃）。【论文 Method】
- **② 一句话架构**：**推理不必都发生在提问之后** —— 在用户提问**之前**的睡眠期，对已有上下文 `c` 做推断并**重写成更易解的再表征 `c′`**；测试期用 `c′` 顶替 `c` 回答。形式化：`T_B(q,c)→a`；睡眠期 `S(c)→c′`；测试期 `T_b(q,c′)→a` 且 **`b≪B`**。收益来自「**上下文内预先算过一遍**」，而非换模型或加检索。
- **③ 数据形状**：**不是结构化记忆库，而是「上下文的再表征」** —— `c′` 是自然语言文本（「关于 c 的推断集合」），不是条目表。论文把它类比为「在自然语言空间里做表征学习」；多轮扩展 = `k` 次并行生成 `c₁…c_k` 拼在一起。
- **④ 写入路径**：谁写 = **睡眠期调同一个 LLM 写 `c′`**（写的是上下文再表征，不是记忆条目）；何时写 = **用户提问之前 / 模型空闲时**（论文用 `S(c)` 描述，没有任务到达）；**无写前校验、无 schema**。**调度/空闲检测的具体实现未读到** —— `pipeline` 里只有一个 `sleep_time_agent` 的占位类（docstring: 「Sleep time compute agent that runs after the conversation agent has finished processing a request」）。
- **⑤ 检索路径**：**没有检索、没有多跳、没有扩散** —— 它**不查库**，因为答案已在 `c′` 里（论文明确把睡眠期计算类比为 **prefetch / caching / OLAP data cube**）。睡眠期自身可以迭代：**sequential test-time scaling**（多轮 sleep-time 循环）、**parallel test-time scaling**（`k` 路并行生成）、**best-of-N**；但那是对 `c′` 的再生成，**不涉及记忆的迭代检索**。⚠️ **对我们最相关的一句**：「Sleep-time compute fundamentally **requires stateful AI agents**」（无持久状态则睡眠期的洞见在下一轮消失）—— 这是它**用「持久状态」换「预计算」**的前提。
- **⑥ 整理/巩固**：**离线巩固的「上下文版」** —— 巩固的对象是上下文而不是记忆库。触发 = 交互间隙。**留痕/回滚：未读到**。
- **⑦ 遗忘/失效**：**未读到**显式遗忘（`c′` 顶替 `c` 时旧 `c` 不出现在 prompt 里，等于「不写回就丢」，但论文没有把它描述成遗忘策略）。
- **⑧ 依赖与成本**：**无图库、无向量库**，只需一个能跑 prompt 的 LLM（实验用 GPT-4o/GPT-4o-mini、o1、o3-mini、Claude 3.7 Sonnet、DeepSeek-R1）。**成本口径（关键）**：论文用**线性成本模型**，test-time token 成本 = 睡眠期 token 成本的 **`t` 倍**，实测 **`t=10`**（Databricks 吞吐基准，§5.3 脚注 4）。**LLM 调用次数：未读到**（论文 not stated）。
- **⑨ 实测数字（全部来自 arXiv 摘要与正文原句，已核）**：测试期所需计算量降至 **~5× 更少**（Stateful GSM-Symbolic 与 Stateful AIME）；scaling sleep-time compute 可再涨 **最高 +13%（GSM-Symbolic）/ +18%（AIME）**；按上下文摊销到多个相关查询，**每查询平均成本降 2.5×**；**睡眠期计算在 pass@k 上 pareto 占优**；**「用户查询的可预测性」与 sleep-time compute 的有效性强相关**（原文 finding）；**睡眠期并行 5 路优于 10 路**；SWE-Features（33 个 PR，F1）低预算下约 1.5× 下降但**高预算纯 test-time 更好**。⚠️ 口径备注：这些是**相对同 backbone 的推理侧收益**，与 LoCoMo 类记忆基准**不同量纲**，不能与 §4 的任何一个记忆分数并列。
- **⑩ 适配判定**：**可行（需改造），但它本身不是记忆架构** —— 它是「记忆之上的**预推理层**」，只能改造成「**记忆整理**」而非「检索替代」。改造点：睡眠期改为**关机前 / 空闲 / 新会话前显式触发一次**；`c′` **必须落盘并带 `source_memory_ids`**，否则不满足可审计。
- **⑪ 能照抄的具体机制**：**两段式预算模型** `cost = sleep_tokens*1 + test_tokens*t`（`t=10` 当起点参数；**该比值就是「值不值得预计算」的判据**）；**睡眠期提示词形态**（推断「可能被问的问题」+ 通用推理 + 重写 c —— Figure 12–18 的 prompt 正文**未读到**，只能照抄形态不能照抄原文）；**Letta 侧 `rethink_memory(agent_state, new_memory, target_block_label, source_block_label)` 的语义**（重新评估 block，**整合新事实与更新事实**，**把过时信息替换成最可能为真的版本**，避免与其它 block 冗余，保持与其它 block 一致；`source_block_label` 为 None 时终止循环）+ **`finish_rethinking` 作为终止工具**。
- **⑫ 已知失败模式**：**自陈** —— 只在 **query 可从上下文预测**时有效（不可预测场景收益趋零）；**自陈** —— 两阶段假设过于简化（真实任务未必可「先睡眠再提问」）；**自陈** —— **高 test-time 预算下反输给纯 test-time**（`c′` 引入分心信息）；**自陈** —— SWE 案例中睡眠期 agent 探索更多文件 ⇒ **改的文件更多、precision 偏低**。⚠️ **对我们最该记住的一条**：睡眠期**自主重写记忆**若不落审计，会与「可审计」约束**直接冲突**（**原文没有审计设计**）。

#### B-3 Auto-Dreamer

- **① 代表/链接/许可/读到哪**：Auto-Dreamer / Chongrui Ye, Yuxiang Liu, Yu Wang, Haofei Yu, Yining Zhao, Ge Liu, Julian McAuley, Jiaxuan You（UIUC / UCSD）；arXiv **2605.20616v1**（2026-05-20）；许可 **CC BY 4.0**；代码仓库**论文未给出 / 未读到**。读到：**HTML 全文** —— §1–§6（§3 含 Read/Write 形式化、§4 含 Algorithm 1、§5.1–§5.5 含 Table 1–2 / Figure 3）+ GRPO 奖励公式。**未读到**：Appendix B/E（writer prompt、工具接口）只在正文被引用、内容未取到。【论文 Method】
- **② 一句话架构**：借鉴 CLS 理论 —— **快写（每会话追加式 typed 记忆）+ 慢整理（离线学出来的 consolidator 做「区域重写」）**；整理时把**选中的记忆区当只读证据**，允许有界 tool-use 查条目与溯源轨迹，**合成一整套全新的紧凑替换集去 supersede 原区域**（原条目默认不保留）。
- **③ 数据形状**：**typed memory bank** `B` = 条目集合；条目 = 短名 `n` + 正文 `s` + **provenance links**（指向 `trajectory log T`）；类型只两种：`semantic` / `procedural`。`T` 是原始 session 记录。**读**：`Read(q;B)=Top-K cos(φ(q), φ(n_e⊕s_e))`（`φ` = **冻结句编码器**）。**写**：`Write(B,R,T_R)=(B\R)∪C_θ(R,T_R)`，即 `B*=(B\R)∪S` —— **R 之外完全不动**。
- **④ 写入路径**：**两条快慢通道**。① **快通道**：**frozen prompted writer**，每 session 结束**追加** typed 条目 + provenance 指针，**故意做得局部且 append-only**（「不检索已有库、不跨会话比较、不重写旧记忆」，保证快 + 可追溯）。② **慢通道**：学习的 consolidator `C_θ`，**每 `k` 个 session 触发一次「固化事件」**（ALFWorld `k=8`、ScienceWorld `k=10`；消融扫 `k∈{1,5,20}`）；**工作区 `R`** = 「该区间**新写入**的条目」∪「该区间**被任务 agent 检索过**的旧条目」。**写前校验：无独立校验环节** —— 替代机制是「**先证据后合成**」+ RL 训练出来的选择性（**无 schema 强制、无人工审批**）；可审计性依赖 provenance 链接而非规则。
- **⑤ 检索路径**：读路径是**单跳 top-K 余弦**（冻结编码器），**非多跳、非扩散**；写入侧的整理是**多步 tool-use rollout**（有界 `turn budget T_max`：search bank → inspect candidate entries → 拉 provenance 源轨迹 → emit terminate；工具接口 Appendix E.2 **未读到**）。**整理器能多步，任务 agent 不能**。
- **⑥ 整理/巩固**：**离线=是**（跨 session）。**触发** = cadence `k` 个 session 的固化事件 + **region selector** 选 `R`。**留痕**：**provenance links**（替换集条目仍指向源轨迹），论文测了 provenance fan-in 分布，**峰值 fan-in = 5**（Figure 3(e)）。**回滚：未读到** —— 无版本号、无 supersede 历史留档、无回滚实验；「旧条目不默认保留」是设计选择 ⇒ **原区域内容在替换后不保证可恢复，与「要能审计」直接冲突**。
- **⑦ 遗忘/失效**：**不删、不冻结，而是「不重合成即消失」** —— omission-based forgetting 是算子默认行为：只有**被重新合成进替换集**的信息才继续 active；重复/过时/过细的条目在重写中自然被丢弃。**遗忘是替换集边界效应，不是显式 delete、不是 TTL。**
- **⑧ 依赖与成本**：无常驻图库/向量库要求（读靠冻结句编码器 + 余弦）；**但需要一个训练过的 14B consolidator**（`Qwen3-14B` 初始化，GRPO 训练，ScienceWorld 轨迹）。`#Tok` 指标：WebArena 仅 **927 tokens**（LightMem 370k、Mem0 43.4k）；ScienceWorld **6.9k**（UMEM 80.9k、ReasoningBank 155.1k）；ALFWorld **10,954**（UMEM 62,947）。**训练成本（GPU 小时）：未读到**；**LLM 调用次数/成本：未读到**。
- **⑨ 实测数字（Table 1，口径 SR% / #Tok / AUC）**：持续记忆部署 —— ScienceWorld **41.1%**（超 UMEM 34.1% 即 **+7.0 pt**，bank 小 **12×**）、ALFWorld **60.2%**（UMEM 58.4 / Mem-α 57.4，bank **6×** 小）、WebArena **52.3%**（最高，927 tokens）；固定 bank 受控固化 —— ALFWorld **72.7%**、ScienceWorld **44.3%**（超 ExpeL 70.1 / Mem0 42.0 各 **2.6/2.3 pt**）。**消融（Table 2）**：writer-only 48.0/29.6/44.2、untrained 区域重写 59.2/31.4/46.6、trained **60.2/41.1/52.3** ⇒ **区域重写本身贡献大部分压缩（6–11× 更小）**，GRPO 训练主要贡献**质量与选择性**（ScienceWorld **+9.7 pp**、WebArena **+5.7 pp**）。**反事实奖励消融**（Fig 3c/3d）：不加 `r_cf` 时 bank 单调增长；加了之后**先涨后缩且性能不降**。**cadence 消融**（Fig 3f）：ScienceWorld 对 `k` 敏感（`k=1` 证据不足、`k=20` 工作区过大噪声高，都不如 `k=10`），ALFWorld 稳健（约 5 pp，`k=5` 比主设定好 1.1 pp）。⚠️ 口径备注：**SR%/#Tok 是 agent 任务成功率与 token 成本**，与 LoCoMo 类问答指标**不同量纲**。
- **⑩ 适配判定**：**需改造（可抄语义、别抄训练）**。理由：三点改造 —— ① **提示词 consolidator 替代 GRPO 的 14B**；② **provenance 改硬外键 + 把 `B\R` 旧区域归档而非丢弃**（补回 rollback/审计）；③ **固化事件改为「关机前 / 用户显式触发」的进程内一次性任务**（不需要常驻 worker）。
- **⑪ 能照抄的具体机制**：**区域重写写算子 `B*=(B\R)∪S`**（建议表：`memories(id, kind, name, body, created_session, superseded_by, archived)`、`memory_provenance(memory_id, trajectory_id)`、`rewrite_runs(run_id, started_at, k, region_json, model, prompt_hash)`）；**「一次重写一整片」而不是逐条 CRUD**（这是它比「逐条 update」省 token 的根源）；**provenance 是硬链接**（fan-in 峰值 5 ⇒ **多对多表**）；**反事实掩码打分**（`r_cf` 的**廉价版**：不训练，只在离线体检脚本里对「某条被删掉的记忆」做替换测试，看性能是否下降 ⇒ 判断「这条是不是真冗余」）；**固化节奏 `k` 的经验区间 8~10 个会话**（太快证据不足、太慢噪声高）。
- **⑫ 已知失败模式**：**自陈（Pattern 3）** —— **过度压缩局部有用的细节**（把 `look_at_obj_in_light` 这类**当前有用**的 episodic 位置信息压成通用流程条目导致掉分；去掉该族后 ALFWorld trained-vs-untrained 的 SR 差从 **+1.0 pp 扩到 +4.9 pp**：65.8 vs 60.9）；**自陈（Pattern 2）** —— 通过抽象**滤掉互相矛盾 / 措辞错误的条目**；**自陈** —— 需要**强函数调用的训练设施**；**自陈** —— WebArena 上部分基线因上下文窗口放不下而未跑（† 脚注）。**可推得** —— 「旧条目不保留」+「无版本号」= **不可回滚**，是它对我们最硬的冲突点。

#### B-4 MIRIX

- **① 代表/链接/许可/读到哪**：MIRIX / Yu Wang, Xi Chen（MIRIX AI / UCSD / NYU Stern）；arXiv **2507.07957v1**（2025-07-10）；<https://mirix.io>；代码 <https://github.com/Mirix-AI/MIRIX>（`public_evaluation` 分支）。论文许可 **CC BY 4.0**（已核）；**代码许可未读到**。读到：**HTML 全文** —— §1–§6（含 **§3.1 六类记忆逐条字段定义**、§3.2 Active Retrieval、§3.3 多智能体工作流、§4.1 数据集与实现细节、§4.2 Table 1、§4.3 Table 2、§5）；Figure 1–7 为图片，**图内细节未读到**（本引擎不吃图片/PDF）。【论文 Method】
- **② 一句话架构**：记忆按认知类型切成**六个异构组件**（各有专属字段与专属 Memory Manager），**Meta Memory Manager 路由**，写入时**并行更新以避免冗余**；检索先由 agent 生成「**当前话题**」再对六类各取 **top-10** 注入 system prompt（**Active Retrieval**）。
- **③ 数据形状（六类，逐条）**：① **Core**：`persona` / `human` 两个 block；**超 90% 容量触发受控重写**；② **Episodic**：`event_type`(user_message / inferred_result / system_notification) + `summary` + `details` + `actor` + `timestamp`；③ **Semantic**：`name` / `summary` / `details` / `source`(user_provided / Wikipedia / inferred)；④ **Procedural**：`entry_type`(workflow / guide / script) + `description` + `steps`；⑤ **Resource**：`title` / `summary` / `resource_type`(doc / markdown / pdf_text / image / voice_transcript) + `content`；⑥ **Knowledge Vault**：`entry_type`(credential / bookmark / contact_info / api_key) + `source` + `sensitivity`(low / medium / high) + `secret_value`（**高敏感走访问控制并被排除在随意检索之外**）。**每类内部有层级**（Semantic 树、Procedural 列表）。
- **④ 写入路径**：**六个专属 Memory Manager 并行写**，由 **Meta Memory Manager（共 8 个 agent）** 先决定路由；何时写 = 收到新输入即走更新工作流（自动搜一遍 → 检索结果 + 用户输入交 Meta → 路由 → 并行更新 → 回报 → Meta 确认完成）。**闸门 = 去冗余约束 + Core 90% 换写**；**没有 schema 强制的写前校验，也没有人工审批**。Chat Agent 可在用户给新事实/更正时**直接与对应 Memory Manager 做精确更新**。
- **⑤ 检索路径**：**Active Retrieval 两阶段**（先生成 `current topic` → 六类**各取 top-10** → 按来源打标签 `<episodic_memory>…</episodic_memory>` 注入 system prompt）。**动机（原文例子）**：「Twitter CEO」问题 —— 库里存了 Linda Yaccarino，但若不问记忆就会答 Elon Musk。**非图遍历**，是跨六类**并行 top-k + agent 自选检索函数**（`embedding_match` / `bm25_match` / `string_match`，论文称在扩展）。**agent 能否迭代：能** —— 先粗检索（只返回高层 summary）→ 分析 query 决定哪几类细查 → 选方法 → 再检索 → 汇总（粗到细两级，agent 主导）。
- **⑥ 整理/巩固**：**不是离线巩固**（与 cat⑥ 的本质差别）—— 整理**发生在写入路径内**（路由 + 并行更新 + 去冗余 + Core 90% 换写）；触发 = Meta Memory Manager。**留痕/回滚：未读到**（无版本、无溯源 ID、无审计日志、无回滚描述；Knowledge Vault 的 `sensitivity` 是**权限标签**，不是审计）。
- **⑦ 遗忘/失效**：**未读到**显式遗忘；只有两处近似 —— Core 超 90% 的**受控重写**（压缩而非删除）、Semantic 除非被概念性覆写否则持久；**无 TTL、无打戳冻结**。
- **⑧ 依赖与成本**：需支持**强函数调用**的 LLM（LOCOMO 用 `gpt-4.1-mini`，理由：Berkeley Function Calling Benchmark 多轮 acc **29.75 vs gpt-4o-mini 22.12**）；ScreenshotVQA 用 `gemini-2.5-flash-preview-04-17`；**步均多次调用**（每次约 **1 次 meta + 0–6 次 memory manager**）；应用侧 Electron + Uvicorn，**每 1.5 s 截屏**、相似度 **>0.99 去重**、攒满 **20 张唯一截图（约 60 s）触发一次更新**；流式上传把端到端延迟从**约 50 s 降到 5 s 以内**；**存储后端 = SQLite**（ScreenshotVQA 的 storage 指标直接报 `sqlite.db` 文件大小）。
- **⑨ 实测数字**：**LOCOMO 85.4%（摘要）/ 85.38（正文）**。**协议（重点，必须带）**：**10 段对话、每段 600 轮、平均约 26,000 tokens、每段约 200 题**；类别 single / multi-hop / temporal / open-domain（**adversarial 按 Mem0 做法排除**）；**限制 Chat Agent 只能靠检索到的记忆作答，不给原始对话记录**；指标 **LLM-as-a-Judge（judge = GPT-4.1）**；backbone **gpt-4.1-mini**（**所有基线同 backbone 重跑**）；**MIRIX 与 Full-Context 各跑 3 次取平均、基线只跑 1 次**。Table 2：MIRIX Overall **85.38**（Single-Hop 85.11 / Multi-Hop 83.70 / Open Domain 65.62 / Temporal 88.39）；同 backbone Zep 79.09 / LangMem 78.05 / Mem0 62.47 / RAG-500 51.62；**Full-Context 87.52**（作者称本数据集上界，因平均长度仅 9k）；跨 backbone（gpt-4o-mini）Mem0 66.88 / Zep 75.14。ScreenshotVQA Table 1：MIRIX Overall **0.5950 / 15.89 MB** vs SigLIP@50 0.4410 / 15.07 GB（**+35% 精度、−99.9% 存储**）vs Gemini 长上下文 0.1166 / 236.70 MB（**+410%、−93.3%**）。**自陈单跳差距原因**：存的是「已确认发生的事件」，问早先计划日期时会优先给确认事实。
- **⑩ 适配判定**：**可行（需改造）**，而且**本来就是 SQLite 后端，同构度最高**。理由：六类记忆全是普通表；无需常驻服务、无图库、无外部向量库（存储后端就是 sqlite.db）；`Meta Memory Manager` 可退化。改造：**六类各一张表 + 一个路由层**（一次 LLM 调用或关键词规则）；**8 个 agent 压成「一次路由调用 + 每类一次写入调用」**；补审计字段；**每类 top-10 固定值改成分数阈值**（top-10 在几百条规模下过宽）。
- **⑪ 能照抄的具体机制**：**六张表 + 字段定义**（`core_blocks` / `episodic` / `semantic` / `procedural` / `resource` / `vault`）—— **「按记忆类型分栏」最具体的落地清单**；**Active Retrieval「先生成 topic 再检索」**（一条零成本提示词层改进，直接把「语义相似」换成「话题对齐」）；**检索结果按来源打标签注入**（`<episodic_memory>` 等，让模型知道自己在读哪类记忆）；**Core 90% 容量触发换写**（一个具体阈值代替无限 append）；**Vault 的 `sensitivity` 分级 + 高敏感排除常规检索**（权限而非加密）。
- **⑫ 已知失败模式**：**自陈** —— **Open-Domain 是短板**（65.62 vs Full-Context 71.88），作者称「仍靠 RAG 取回重要信息，**这可能是瓶颈**」（= 缺全局理解）；**自陈** —— 单跳因优先确认事实，略低于 Full-Context 上界；**自陈** —— 多轮函数调用**高度依赖小模型的函数调用能力**；**自陈（隐含于成本）** —— 多智能体带来大量 LLM 调用（成本/延迟）。

#### B-5 mnemon

- **① 代表/链接/许可/读到哪**：`mnemon-dev/mnemon`；版本 **v0.2.9**（2026-09-14）；提供 npm 启动器 `@mnemon-dev/mnemon`（Node 22+）。语言 **Go**。**许可 Apache-2.0**（`pkg.go.dev` Licenses 段 + 仓库 License）；npm 侧 `dsh-mnemon` **MIT**（旧文档已核）。读到（**走 GitHub 被 DNS 拦后的替代路径**）：**pkg.go.dev README 全文** + **jsDelivr 文件树**（含每文件字节数）+ **jsDelivr 直出 `docs/design/04-graph-model.md`（四图模型全文，含公式与意图权重表）**、**`06-lifecycle.md`（EI 衰减公式全文）**。**Go 源码正文未读** ⇒ **没有 `文件:行`**。【文档·abstract】（仓库设计文档正文级）
- **② 一句话架构**：**本地单二进制记忆库，宿主 LLM 当监督者** —— 二进制只做**确定性计算**（存储 / 建图索引 / 搜索 / 衰减），**LLM 只做判断**（记什么 / 怎么连 / 何时忘）；对外三原语 `remember` / `link` / `recall`，底层是**四图模型**（`04-graph-model.md` 开篇明写方法来源 **MAGMA**，含引用 arXiv 2601.03236）；另有子代理（Claude Code/Codex）作为**可选**执行策略。
- **③ 数据形状（四图 schema，`04-graph-model.md` 正文）**：**Temporal** —— `backbone`（新 insight → 同来源最近一条，双向）+ `proximity`（**24 小时窗口**内其它 insight，双向，权重 `w=1/(1+hours_diff)`，**最多 10 条**；`metadata {"sub_type","hours_diff"}`）；**Entity** —— 混合抽取：正则（CamelCase / ALL_CAPS / 文件路径 / URL / @提及 / 中文书名号）+ **200+ 技术词典** + `--entities` 直给；`--entity-mode merge|provided|auto`；新 insight ↔ 每个共享实体**最多 5 条**已有 insight，权重 **1.0**（`metadata {"entity"}`）；**Causal** —— 三条件：因果关键词、token 重叠 **≥15%**、方向推断；**LLM 辅助**：`remember` 经 **2-hop BFS** 输出候选因果对，宿主 LLM 评估后 `link --type causal`；子类型 `causes`/`enables`/`prevents`，示例权重 **0.75**；**Semantic** —— **两档置信度**：`cos ≥0.80` 自动连双向边、**最多 3 条**；**0.40~0.79 交 LLM 评审**；`<0.40` 忽略；**无 embedding 时退化为 token 重叠率 >0.10**。**第五类边 `narrative`：README 说 5 种 edge types，但建边规则未读到**。意图自适应权重表（**可直接进配置**）：`WHY` → causal 0.70 / temporal 0.20 / entity 0.05 / semantic 0.05；`WHEN` → 0.15 / 0.65 / 0.10 / 0.10；`ENTITY` → 0.10 / 0.05 / 0.55 / 0.30；`GENERAL` → 0.25 ×4。
- **④ 写入路径**：谁写 = **宿主 LLM 决定、二进制执行**（`remember` 抽节点 + 实体并输出候选；`link` 建边）。**何时**（**钩子生命周期**）= `Prime → Remind → agent 干活 → Nudge → Compact`（对应 Claude Code / Codex 的 `SessionStart` / `UserPromptSubmit` / `Stop`，或 Pi 扩展事件）。**写前闸门：有，但很轻** —— `remember`/`import` **跳过完全重复内容、保留不同事实、相似内容给 review 建议**；写入结果带 `candidate` 列表交 LLM 决定连边。**没有 schema 强制、没有审批队列、没有 fail-closed**（与灵枢/ontology-to-tools 是两个极端）。
- **⑤ 检索路径**：**意图感知 `recall` = 图遍历 + 可选向量搜索**（**RRF 融合**，默认对所有查询开启）；**多跳=是**（**读路径与写路径对称化**：`Extract → Candidate → Associate`，读侧 `Associate` = traverse edges & rank）；**agent 能迭代**（三原语本身即面向 agent 调用；多信号加权重排含 **KW + Entity + Similarity + Graph 四路**）。
- **⑥ 整理/巩固**：**部分** —— 有 `gc`（手动）与自动 prune，但**没有 cat⑥ 那种离线跨会话合成/supersede 巩固层**（`supersede` 只用在 `import` 场景：`import_supersedes_test.go` / `recall_supersedes_test.go`）。**触发** = active insight 超阈值自动触发。**留痕（很具体）** = **oplog**（每次自动删除都是**软删并在 oplog 出现 `prune` 操作**，触发命令用 `auto_pruned_ids` 按 ID 报告）+ **privacy-safe receipts**（**哈希化操作回执**，「不暴露原始记忆内容与查询本身」⇒ 直接解决「审计 vs 隐私」冲突）。
- **⑦ 遗忘/失效（EI 公式，`06-lifecycle.md`）**：`EI = base_weight(importance) × access_factor × decay_factor × edge_factor`；`base_weight`: imp5→1.0 / 4→0.8 / 3→0.5 / 2→0.3 / 1→0.15；`access_factor = max(1.0, log(1+access_count))`；`decay_factor = 0.5^(days_since_access/30)`（**半衰期 30 天**）；`edge_factor = 1.0+0.1×min(edge_count,5)`（最多 +0.5）。**免疫规则**：**`importance>=4` 或 `access_count>=3` 免自动清理**。**自动剪枝触发**：`active insights > 1000` 时算全部 EI → 排除免疫项 → 按 EI 升序**每批最多 10 条** → **软删（置 `deleted_at`）** → 级联删除相关边。手动：`mnemon gc --threshold 0.5` / `--keep <id>`（`access_count` **+3**）。环境变量 `MNEMON_MAX_INSIGHTS=1000`（**0=关**）、`MNEMON_AUTO_PRUNE_MIN_AGE=24h`。
- **⑧ 依赖与成本**：**单二进制 + 零 API key**；存储 = **SQLite**（「current SQLite backend is the first adapter」），数据目录 `~/.mnemon`；**向量可选**，存 `insights.embedding` 列（little-endian float64 BLOB，**768×8 = 6144 B/条**）；嵌入走**本地 Ollama**（默认 `http://localhost:11434`、`nomic-embed-text`，**可用性探测 2 秒超时，不可用则优雅退化为 token 重叠**）；也支持 OpenAI 兼容端点（endpoint 以 `/v1` 结尾即切换协议）；**无常驻服务要求**。数字：文档给了「一个真实知识图谱：**87 insights / 2150 edges / 四类图**」（README）；**没有精度/延迟 benchmark**（**未读到** —— 它不是论文）。
- **⑨ 实测数字**：**无 benchmark**（非论文，**不可引用为性能证据**）。
- **⑩ 适配判定**：**可行（可直接照抄，与本约束同构度最高）**。理由：单二进制、SQLite 后端、**无 API key**、无常驻服务；四图就是**边表 + 节点表**；EI 公式**纯 SQL 可算**；`oplog` + `receipts` **天然满足可审计**。**唯一要改的**：把 **1000 条的剪枝阈值下调**到我们的几百条规模，并把 `importance>=4` 的免疫项设为「**永不自动删**」。
- **⑪ 能照抄的具体机制**：**四图 schema（可直接落 SQLite）**：`insights(id, content, importance, access_count, created_at, last_access_at, deleted_at, embedding BLOB)`、`edges(id, src, dst, type, sub_type, weight, metadata_json, created_at)`（`type ∈ temporal|entity|causal|semantic|narrative`）；**EI 衰减公式照抄**（含 **30 天半衰期**、log 访问加成、连边加成）+ **免疫规则**（高重要度或高频访问**永不自动删**）；**软删 + oplog + `auto_pruned_ids`**（裁剪只置 `deleted_at`、写一条 `prune` oplog、按 ID 回报 —— 完全满足「要可审计」）；**privacy-safe receipts（哈希回执）**（导出「某次 recall/remember 碰了哪些记忆」的哈希化回执，不暴露原文与查询本身）；**意图 → 边权权重表**（WHY/WHEN/ENTITY/GENERAL 那张表）可直接进配置；**LLM 监督的候选-判断分工**（二进制出候选：2-hop BFS / 正则+token 重叠 / cosine 分档；LLM 只对**灰区**（0.40~0.79 的相似、因果候选）做判断 —— **大幅省 token，且是「可审计的确定性计算 + 有界 LLM 判断」**）；**写前去重**（`remember` 跳过完全重复、保留不同事实、相似给 review 建议）。
- **⑫ 已知失败模式**：**非论文、无 benchmark**，所以**没有可信的精度/延迟数字**（「未读到」，**不可引用为性能证据**）；**文档自身承认**把 `link` 折叠进 `remember` 的做法（OpenViking 路线）「**在记忆量超出上下文时失去优势**」，反向说明**其自身强依赖「写时就建好边」**；**`narrative` 边规则未读到**，四图之外的第五类边语义不完整；**依赖宿主 LLM 的判断质量**（因果/相似灰区判断错了就写错边）。

#### B-6 HyperSU（语义单元超图）

- **① 代表/链接/许可/读到哪**：HyperSU / Jiate Liu, Liuyi Chen, Zhengyi Yang, Chuan He, Mingchen Ju, Bocheng Han, Ruyi Liu, Xu Zhou（UNSW / 湖南大学 / 悉尼大学 / Euler AI / Vecton AI）。arXiv **2606.28351**，**v1 2026-06-03、v2 2026-09-27**，24 页 / 6 图 / 23 表。**许可：arXiv perpetual non-exclusive license**。**代码仓库：未给出 / 未读到**。读到：v2 HTML 的 §1 Introduction、§2 Related Work、§3 Preliminaries（含 Definition 1/2、Proposition 1）、**§4.1 Offline Indexing：Semantic-Unit Hypergraph Construction（含全部公式与 DP）**；再经 ar5iv 拿到 **§4.2 Online Retrieval: Clue-Guided Bidirectional Expansion 全文**（Clue Agent、`α(u)`、双向 frontier、bridge score、convergence bonus、evidence projection）。**§5 Experiments 正文数字未读到**（只到摘要口径）；**§5.5 Computational Efficiency 的墙钟时间/单查询成本未读到**；**附录 C.3 超参值未读到**。【论文 Method】
- **② 一句话架构**：**不用 LLM 生成超边**，而是把「**一个连贯的文本片段（semantic unit, SU）**」**本身当作一条超边**，其上的实体就是这条超边连接的多个实体；用**实体感知的 MDL 分割**从原文切出 SU；检索时把 query 拆成多条线索，在超图上做**线索引导的双向扩展**（前向找远端桥接实体、后向做答案侧锚定验证）。
- **③ 数据形状**：超图 `G_H=(V,E_H,H)`；`V` = 规范化实体节点；`E_H` = SU 超边；**关联矩阵 `H∈{0,1}^{|V|×|E_H|}`，`H[v,e_H]=1` 当且仅当实体 v 出现在该 SU 中**（可等价编码为 **entity–hyperedge 二部图**）。**一条 SU 超边的形状** = 一个**连续的句子跨度** `u=(s_i,…,s_j)` + 其共现实体集 `V_u` + **可回溯的原文 passage**。**没有预物化的 n-ary 谓词事实** —— SU 在检索时才被复用组合成 query 专属的推理链。
- **④ 写入路径（超边怎么建）**：① **实体抽取**：逐句用 **GLiNER**（通用 NER 模型）抽 mention，规范化成 canonical 实体名 —— **注意：GLiNER 是编码器模型，不是生成式 LLM**。② **实体感知 SU 归纳 = 双通道 MDL 分割**：句子 embedding L2 归一化后，语义通道用**合成向量长度** `R_u=‖Σ_{i=a..b}x_i‖`（越大越说明方向一致=越连贯）；实体通道惩罚「混了很多弱相关实体」的跨度：`Φ(u)=N_u·H(π_u)+((|U_u|−1)/2)·log N_u`（`N_u`=实体提及总数、`π_u`=提及经验分布、`H`=熵）；单段奖励 `r(u)=κ·R_u−Φ(u)−((d_eff−1)/2)·log n`，目标 `Q_MDL=Σ_{u∈U_p} r(u)`，约束 `w_min≤words(u)≤w_max`；**一维动态规划**求最优切分（`dp[i]=max_{j∈J(i)}{dp[j]+r(s_{j+1}..s_i)}`，利用**句子 embedding 前缀和**与句级实体计数，回溯父指针恢复切分）。③ **超图装配**：实体名精确匹配（规范化名/标签）归一，**可选再做一次高阈值 embedding 合并**近同义 mention；然后「**每个 SU = 一条超边**」。**写前校验/闸门：未读到**（离线索引一次性构建）。**溯源（关键）**：**Proposition 1（有形式化证明，附录 B.1）** —— 把多实体证据单元表示成超边，**保留了该单元级的成员关系与 provenance**；反之**投影成两两实体边会丢掉「原本同属一组」的身份**，除非额外加辅助的事件/溯源节点或标签。**「0 indexing token」的准确口径（脚注 1 原文）**：*"zero LLM indexing cost means **zero offline generative-LLM API calls and tokens**. Indexing still runs **GLiNER, an encoder-based NER model, locally**, and its wall-clock cost is reported in §5.5; an LLM is used **online** by the Clue Agent, whose per-query cost is also reported there."* ⇒ **省掉的是「离线用生成式 LLM 生成摘要/超边」那部分**；本地 NER 仍有计算成本，**在线仍有 LLM 成本**。
- **⑤ 检索路径**：**多跳 + 受控扩散**，明确针对「one-hop 漏桥、PageRank 乱扩」两个反例设计：① **Clue Agent** 把 query 拆成并列线索 `C_q={c_1..c_M}`（**无 planner 时退化为整句 query embedding 单线索**）。② **SU 激活（容错）**：`α(u)=clamp((max_i sim(c_i,u)−δ)/(1−δ),0,1)^γ` —— **取所有线索的最大值**，所以只要有一条线索匹配上就能激活该 SU，**不要求生成的线索/多跳计划全对**。③ **双向 frontier 扩展**：两个方向同一传播规则，第 t 跳未激活实体 `v` 得 `c_t(v)=max_{u:v∈V_u}[α(u)·max_{z∈F_t∩V_u}a(z)]`；取 top-K 新实体并施加**跳数衰减 `a(v)=c_t(v)·β^t`**。每条边记 bridge 分 `b(u)=max_t[α(u)·max_{z∈F_t∩V_u}a(z)]`，前向得 `b^fwd`、后向得 `b^bwd`。④ **前向 vs 后向**：**前向偏 recall**（多跳找远端桥接）；**backward anchoring 从 top 稠密检索到的 passage 里的实体出发，做答案侧验证，偏 precision**。⑤ **收敛奖励**：两向都激活的 SU 集合 `U_meet=supp(b^fwd)∩supp(b^bwd)` 获得收敛加成 `s(u)=b^fwd(u)·μ`（否则 `s(u)=b^fwd(u)`）；**只被后向激活的 SU 不参与排序，仅用于验证/提升前向命中的证据** —— 这样避免「稠密检索的种子主导最终排序」。⑥ **Evidence Projection**：把激活的 SU 映射回其源 passage 做排序与生成（§4.2 末尾被截断，投影与排序细节**未读到**）。**agent 能否迭代调用**：检索本身是**自动的多轮 frontier 迭代**，**不是** agent 主动发多轮；在线**只有一次 Clue Agent 的 LLM 调用**（除非用 planner）。
- **⑥ 整理/巩固**：**无离线巩固层**；索引阶段**一次性构建**（离线的只有确定性计算：NER + embedding + DP 分割）。**留痕很强**（每条超边可回溯原文 span，原文称这是「a property recent work argues data systems should provide by design」）；**无版本、无撤销**。
- **⑦ 遗忘/失效**：**未读到**（无 decay / TTL / 剪枝）。
- **⑧ 依赖与成本**：离线 = GLiNER（本地编码器）+ 句 embedding + DP（**无常驻服务、无图库要求**，关联矩阵即可）；在线 = Clue Agent **一次 LLM**（成本 §5.5 **未读到**）；存储 = 实体表 + 超边表 + 关联表（或 incidence 稀疏矩阵）。
- **⑨ 实测数字**：**仅摘要口径**（§5 正文**未读到**）：GraphRAG-Bench 平均精度 **68.7** vs 最强基线 **63.2**（**+5.5 点**）；相对提升 **v1 摘要 14.1% / v2 摘要 14.7%**（⚠️ **两版本口径不一致，需注意**）；HotpotQA / 2WikiMultiHopQA / MuSiQue 最佳 GPT-Accuracy。⚠️ 口径备注：**这是多跳问答基准，不是 LoCoMo**；数字来自**摘要**而非 §5 正文。
- **⑩ 适配判定**：**可行（需改造），但对几百条收益可疑**。① **不依赖常驻服务**，关联矩阵可以就是两张 SQLite 表；② **但** GLiNER + 句 embedding + DP 是**为大语料多跳问答设计的重机制**，用在几百条口语化记忆上性价比低；③ **超边 = 可溯源 span，与「可审计」天然契合** —— 这是它真正的可迁移价值。
- **⑪ 能照抄的具体机制**：**超边落表**：`su_hyperedge(id, source_span_text, passage_id, start_sent, end_sent, created_at)` + `su_incidence(entity_id, su_id)`（**每条超边必须带 `source_span`/`passage_id`** —— 这是「可溯源」的硬要求）；**不把「一次连多个实体」压成 pairwise 边**（Proposition 1 的形式化理由，对应我们「图侧无内容」的病灶）；**MDL 分割的降级版**（用相邻句 embedding 相似度 + 实体共现紧密度做贪心切分，把 `R_u`/`Φ(u)` 直接当评分函数）；**双向检索 + 收敛加成**（前向偏 recall / 后向偏 precision，**取交集加权 μ、只后向命中的不参与排序**）—— 这条**与实现无关**，可直接搬到任何混合检索上；**跳数衰减 `β^t` + top-K frontier**（限制扩散半径）。
- **⑫ 已知失败模式**：**依赖 NER 质量**（GLiNER 抽错 ⇒ 超边实体集错）；**在线仍需 LLM**（「0 成本」只指离线索引 —— 摘要措辞容易误导，**引用必须带脚注口径**）；**分段超参敏感**（附录 D.3 专做 κ、d_eff 敏感度分析 ⇒ 默认值不稳）；对超长/跨段证据可能**切不出合理 SU**（受 `w_min`/`w_max` 词数约束）；**论文自陈动机**即已有 HyperRAG 的两个病（LLM 生成超边会引入**无支撑实体 / 漏关键桥接实体**；one-hop 漏证据、PageRank 语义漂移）。

#### B-7 dsh-ontology

- **① 代表/链接/许可/读到哪**：`tancheng33/dsh-ontology`（DSH 插件）。商店 <https://dsh.deepseek404.com/detail.php?id=tancheng33%2Fdsh-ontology>。**许可 MIT**（商店 REPOSITORY FACTS 明确标 MIT）；语言 TypeScript；Stars 14 / Forks 4 / Issues 1；**最后推送 2026-08-16（活跃）**。读到：**DSH 插件商店详情页**（聚合的 README 全文：Why a TBox 对比表 / 四个工具 / Install / Configuration 配置表 / worked example / Query modes 表 / The rules it enforces / Code Mode / Development / Requirements / License）。**源码与测试正文未读到**（README 提到 `pnpm test` **47 个单测**、`tests/memory-domain.ts` 是内存版存储替身）。【文档·abstract】
- **② 一句话架构**：**给 agent 一套必须遵守的词汇表** —— 先声明「**存在哪些种类的东西、它们之间允许怎样关联**」（`TBox`），之后**每一句断言在落库前都要过这套模型**；且**能推出的结论在读的时候推导、不重复存**（`ABox` + 推理）。
- **③ 数据形状**：`TBox` = `classes` + `typed relations`（`subClassOf`、`domain`/`range`、`characteristics: transitive|symmetric`、`inverseOf`、`rangeKind:"literal"`）；`ABox` = `entities`（带 `classes`）+ `facts`（`subject–predicate–object`，可带 `source`）。存储落 `$DSH_HOME/storages/<domain>.json`（bundle 自带 `dsh-storage` + `dsh-storage-json` + `dsh-storage-domain`）；**一个 domain 名 = 一张孤立图**。
- **④ 写入路径**：**不是后置校验，而是写入即校验** —— `ontology_assert` 记录 `entities` 与 `facts` 时**被校验**；违反词汇表就**拒绝并指名违反哪条约束**，README 给的真实返回示例：`REJECTED ada depends_on api: ada is not in the domain of depends_on (requires one of: Component; has: Person)`。配置 `strict: true`（**默认**）=拒绝；`strict: false`=存下来**并记录违规**。同一次调用内**先建实体再建事实**。另两个写入面工具：`ontology_define`（声明 TBox）、`ontology_retract`（删除，**带依赖保护**）。**写入路径的唯一性/工具面 = 四个工具**。
- **⑤ 检索路径**：`ontology_query` **六种模式** —— `schema` / `stats` / `entities`（含子类）/ `facts`（**三元组模式，省略位=通配**，如只给 `predicate`）/ `neighbors`（邻域到深度 N）/ `path`（两实体**最短路**）。**多跳/扩散：有**（`neighbors` 深度、`path` 最短路）；**agent 能迭代**，且提供 **Code Mode**（每个工具都能当类型化调用，返回规范 JSON 值，示例 `const { facts } = await tools.ontology_query({mode:'facts', predicate:'depends_on', includeInferred:true})`）。
- **⑥ 整理/巩固**：**没有离线巩固**；有**读时推理（entailment）**：`transitive`/`symmetric`/`inverseOf` 按**不动点（fixpoint）**应用，规则可组合（传递关系的逆也传递）；**被推出的事实在读时推导、永不存储** —— **撤回一个前提，建立在其上的推得事实随之消失，不留陈旧推导**；**每条推得事实带 `via` 字段**指名是哪条规则产生的。
- **⑦ 遗忘/失效**：`retraction` 有**依赖保护**：撤回实体 → **级联到所有提及它的事实**；撤回术语时**只要还有东西依赖它就拒绝并指名依赖方**；**定义期就拒绝的错**：`subClassOf` 成环（会让「是不是 X」对环上每个类都**不可证伪**）、`literal` 值关系被声明为 `symmetric`/`transitive`/`inverseOf`；**`functional` 关系出现第二个不同宾语是 `functional-conflict` 而不是静默覆盖**；重复断言同一宾语**保持幂等**。
- **⑧ 依赖与成本**：DSH `>= 0.1.0-rc.6`，Node `^22.19 || >=24`；**无外部服务**；**纯 JSON 存储**。配置项：`domain`（默认 `ontology`，须匹配 `/^[a-z][a-z0-9_]*$/`）、`strict`(true)、`inference`(true)、`promptSection`(true)、`promptMaxTerms`(60)、`promptOrder`(150)、`defaultLimit`/`maxLimit`(50/500)、`maxEntities`/`maxFacts`(**20000/100000**，写超界**直接大声失败**)。**规则引擎是纯的**（无 IO / 无存储 / 无 Cordis），可单独 `import` `dsh-ontology/ontology`（`entail` / `findPath` / `validateFactInput`）。
- **⑨ 实测数字**：**无 benchmark**（插件非论文）；可核对的数字是 **47 个单测**、**14 stars**、容量上限 **20000/100000**。
- **⑩ 适配判定**：**可行** —— 这半边**最贴合我们场景**，**但存储层需换成 SQLite**。理由：它证明「**写前校验 + 命名违规约束 + 读时推导不落库 + 撤回依赖保护**」整套在**本地、无服务、JSON 文件**上都跑得动；只需把 `storages/<domain>.json` 换成 SQLite 表，**规则引擎逻辑可原样照搬**（核心是纯函数）。⚠️ **它是别人的插件，本次只读，不得安装/改动**。
- **⑪ 能照抄的具体机制**：**写前校验 + 结构化拒绝**（拒绝信息必须包含「违反了哪条 + 允许取值」，这比「写入失败」有用得多）；**`domain`/`range` + `subClassOf` 闭包**（空列表 = **未约束**，即「**诚实地编码『尚未决定』**」而不是静默允许一切）；**读时推导不落库 + `via` 字段**（**省存储 + 撤回自动一致** —— 对我们「图侧时间列是死列 / 冗余列」的病灶是一剂对症药）；**撤回的依赖保护**（先查依赖，有依赖就拒绝并指名）；**容量护栏 + 大声失败**（20000/100000 上限）；**词汇表摘要进 prompt**（`promptSection` + `promptMaxTerms` 上限，把 schema 以最省 token 的方式递给模型）。
- **⑫ 已知失败模式**：**README 未列 failure modes**（**未读到**）。**设计张力（我方指出）**：① `TBox` **需要人先写好** —— 模型不完整时合法断言会被拒（README 自己把它当信号而非错误）；② `strict:false` 会**积累违规记录**；③ 依赖保护让「改词汇表」变繁琐；④ 功能是**类型/关系约束**，**不解决时间、衰减、巩固**。

#### B-8 ontology-to-tools

- **① 代表/链接/许可/读到哪**：Xiaochi Zhou, Patrick Butler, Changxuan Yang, Simon Rihm, Thitikarn Angkanaporn, Jethro Akroyd, Sebastian Mosbach, Markus Kraft（Cambridge / CARES Singapore / MIT / CMCL / CMPG），报告号 `c4e-343`。arXiv **2602.03439v1**（2026-02-03）。**许可 CC BY 4.0**（已核）；**代码未读到**。读到：abs 页 + HTML 全文 **§1 / §2 / §3 与 §6 Methods 的小节标题级细节**（6.1 Preparation stage: JSON-based task decomposition、Script and MCP tool generation from the T-Box、MCP server construction、Design principles for instantiation MCP servers、Instantiation prompt generation；6.2 Instantiation stage: Loading MCP tools、Plan-driven ReAct execution、Ontology-constrained function calls、Turtle-based persistent memory；6.3 Grounding stage: Grounding tool generation、Lexical grounding）+ §7 附录标题（含 7.2.5 Illustrative trace of constraint-triggered repair）。**§4 评测具体数字未读到**；**§6 各小节正文未读到**（HTML 在 **50000 字符截断**）。【论文 Method】（部分章节标题级）
- **② 一句话架构**：在 The World Avatar（TWA）里把**本体规格「编译」成可执行工具接口**（MCP 工具），LLM agent **只能用这些工具**创建/修改知识图谱实例 ⇒ **语义约束在生成过程中被强制**，而不是生成后再校验。
- **③ 数据形状**：`T-Box`（类/关系/属性/约束）↔ `A-Box`（实例，IRI 标识）；**多本体协同**：`OntoSynthesis`（合成事件、有序步骤、条件、试剂用途）、`OntoSpecies`（化学物种规范身份与标识符）、`OntoMOPs`（MOP 产物、结构概念、派生 CBU）、`OM-2`（量纲与单位）；化学物种在使用实例级 grounding（`owl:sameAs` 链到 OntoSpecies）；**持久记忆用 Turtle**。
- **④ 写入路径**：**编译层**把 T-Box 当**机器可读契约** → prep agent 消费 T-Box + 领域无关 meta-prompt → 产出**本体对齐的运行时 prompt** + 支撑脚本 + **经 MCP 暴露的 LLM 可调用工具接口**，**工具内建校验逻辑**；实例化 agent 对每篇文档**调用工具**建个体与关系，**约束违规以结构化反馈返回**，支撑**迭代补全与修复**；论文强调**不是靠 prompt engineering 或语法限制**，而是通过**工具与持久符号状态的运行时交互**得到；执行形态 = **plan-driven ReAct**。**写入路径唯一化（只能通过工具写）就是它的强制机制。**
- **⑤ 检索路径**：**未读到**（论文不以此为重点）。**整理/清理：未读到。**
- **⑥ 整理/巩固**：**未读到**。**留痕** = Turtle 三元组 + 每条合成配方保留**有序步骤与 provenance**（论文明确要求 KG 记录「每条信息从哪来」，以便 role/amount 等限定词正确挂到对应的化学品使用与合成步骤上）。
- **⑦ 遗忘/失效**：**未读到**。
- **⑧ 依赖与成本**：**MCP server + 三重转换（本体→工具）+ ReAct agent + Turtle 三元组存储**；用 **30 篇 MOP 文献**做案例；§6.7 有 "Token usage and cost" 小节，**具体数字未读到**；**LLM 调用次数未读到**。
- **⑨ 实测数字**：**未读到**（§4 标题为 4.1/4.2/4.3 结论式标题，**无数值**）。
- **⑩ 适配判定**：**需改造（照搬形态不可行，照搬机制可行）**。不可行的是**形态**（MCP server + triple store + ReAct 抽取流水线对几百条记忆是**重装备且要起服务**）；可行的是**机制** —— **把「约束编译成写入方必须调用的接口」降级为「在我们唯一的写入函数里做校验 + 返回结构化拒绝」**：纯 SQLite 场景下**唯一写入路径天然存在**（我们控制代码），**根本不需要 MCP 来做强制**。
- **⑪ 能照抄的具体机制**：**T-Box 当机器可读契约**（用 schema 文件或 `tbox_relations(id, domain_json, range_json, characteristics)` 表，**由它生成校验器与错误信息**）；**结构化违规反馈 + 修复循环**（拒绝时返回「违反了哪条 + 允许取值」，让写入方**自己改一次再提交**）；**写入路径唯一化**（单一写入函数 = 单一闸门，**不需要引入外部服务**）；**provenance 与限定词挂载**（限定词挂条目本身，而不是散在文本里）。
- **⑫ 已知失败模式**：**论文自陈范围**是 **proof-of-principle**，只在 MOP 合成文献**一个案例**验证；**§5.1 Limitations 有专门一节**（内容**未读到**）；**从架构看** —— 「约束编译」要求**先把本体写好**（本体不全 ⇒ 合法数据被拒或非法数据漏过）；**强依赖 agent 的 function calling 能力**。

### C 组（纯向量/服务化 + 参数化 + 评测口径）

#### C-1 Mem0 OSS 2.2.1

- **① 代表/链接/许可/读到哪**：`mem0ai` **2.2.1**（作者团队 Mem0，`support@mem0.ai`）。许可 **Apache-2.0**（`pyproject.toml`：`license = "Apache-2.0"`、`license-files = ["LICENSE"]`；wheel/sdist 内含 `LICENSE`）。链接 <https://github.com/mem0ai/mem0>（**本机 DNS 拦，未直读**）；源码经 **PyPI sdist** 读取。读到：`mem0/memory/main.py`（全 **3912 行**）、`mem0/utils/scoring.py`（全 **139 行**）、`mem0/utils/entity_extraction.py`（全 **772 行**）、`mem0/configs/prompts.py`（**1062 行**，重点 464–936 行 "V3 Additive Extraction Prompt (ADD-only with memory linking)" 与 692–701 行 Memory Linking）、`mem0/memory/storage.py`（SQLite 历史库）。⚠️ **版本差异提示**：这与本调研前序版本里「Mem0 用 Neo4j 存图」的做法**不同** —— 2.2.1 已把「关系」退化成「实体条目 + `linked_memory_ids` 数组」。【源码】
- **② 一句话架构**：**LLM 抽事实（ADD-only）+ 两条向量库（记忆条目库 + 实体条目库），不建真图**；检索时语义 + BM25 + 实体链接加成**三者相加**排序。佐证：`main.py:559-580` 实体库是**懒加载的第二个向量库集合** `_entity_collection_name(provider, collection_name)`（`main.py:422-425`）；**全仓库无 graph/neo4j 模块**（源码文件清单无 `graph/`；对 `main.py`/`storage.py`/`configs/base.py` 全文搜 `graph|neo4j|Graph` **零命中**）。
- **③ 数据形状**：记忆条目 payload = `data`(事实文本)、`hash`(md5)、`created_at`/`updated_at`、`text_lemmatized`(供 BM25)、可选 `attributed_to`、`expiration_date`，以及 scope 键 `user_id`/`agent_id`/`run_id`（`main.py:1031-1041`）。实体条目 payload = `{data, entity_type, linked_memory_ids: [...], **search_filters}`（`main.py:638-643`、`1186-1191`）；`entity_type` 取值 **PROPER / QUOTED / TOPIC / IDENTIFIER**（`entity_extraction.py:1-16`、`:748`）。
- **④ 写入路径**（`add()`，`main.py` 881–1220，同步版）：① 取历史消息 + 检索相关旧记忆（`existing_results`）作为上下文；② **一次 LLM 调用**做加法式抽取，输出 `{"memory":[{"id","text","attributed_to"?,"linked_memory_ids"?}]}`（`prompts.py:464+`、`main.py:974-986`）；③ 批量嵌入（`main.py:993-1005`）；④ **写前校验①：哈希去重** —— `md5(text)`，与「库内已有 hash」及「本批次已见 hash」比对，命中即丢弃（`main.py:1007-1026`）；⑤ 批量插入向量库（`main.py:1055-1069`，失败退化为逐条插入）；⑥ **Phase 7 实体链接**：批量 spaCy 抽实体 → 全局按归一化文本去重 → 批量嵌入 → 批量查实体库 → **写前校验②**：`exact_match or (semantic_match if score>=0.95)` 命中则把本批 memory_id 并入 `linked_memory_ids`（`update(vector=None, payload=...)`，**不重嵌入**），否则批量插入新实体（`main.py:1100-1204`）；⑦ 保存对话消息（`main.py:1207`）。⚠️ **实测发现（重要，与文档叙述有落差）**：prompt 里让 LLM 输出 `linked_memory_ids`（`prompts.py:692-701`、`:926`、`:936`），**但 ADD 路径落库时只取 `text` 与 `attributed_to`**（`main.py:1038-1039`）⇒ **LLM 声明的那份链接在 2.2.1 里没有被写入任何 payload**。全包 grep `linked_memory_ids` 只命中 `main.py`，且全部出现在「实体库」语境 ⇒ **实际生效的记忆间链接来源只有 spaCy 实体的共现，LLM 的语义链接声明形同备注**。
- **⑤ 检索路径**（`_search_vector_store`，`main.py:1642-1745`）：① 查询侧同样跑 `lemmatize_for_bm25` + `extract_entities`（`main.py:1648-1649`）；② 语义检索按 `internal_limit = max(limit*4, 60)` **超采**（`main.py:1655`）；③ 关键词检索（向量库支持时）+ BM25 sigmoid 归一化（`main.py:1661-1673`）；④ **实体加成**计算（见下）；⑤ 加性打分 + 阈值门控（`main.py:1694-1701`）。**是否多跳/扩散：否** —— 实体只做「查询实体 → 该实体挂的记忆」的**一跳回捞**，没有从命中记忆再沿链接扩散的循环。**agent 能否迭代调用**：检索 API 是**单次确定性调用**，不是让 agent 反复下钻的接口；`search()` 返回后由上层 agent 自行决定是否再查（无内建迭代/反思循环）。
- **⑥ 整理/巩固**：**无独立的「整理」阶段**。巩固只体现在**实体条目的写时归并**（同归一化文本或 `cos≥0.95` 的实体被合并、`linked_memory_ids` 取并集，`main.py:1166-1181`）；历史消息永久存 SQLite（`storage.py`）。
- **⑦ 遗忘/失效**：**软过期** —— payload 带 `expiration_date`，检索时 `_payload_is_expired` 过滤（`main.py:442-486`、`1684`），可用 `show_expired=True` **旁路**；删除记忆时同步清洗实体库（`_remove_memory_from_entity_store`：从各实体 `linked_memory_ids` 剔除该 id，列表空则删实体条目，`main.py:652-705`）。**无重要性衰减/淘汰排序**。
- **⑧ 依赖与成本**：**需要外部向量库**（Qdrant/Chroma/pgvector… 共 20+ 后端）或至少一个本地向量库；实体抽取需 **spaCy 模型**（`spacy_models.get_nlp_full()`；**不可用则实体功能整体静默降级为空**，`entity_extraction.py:15`、`:751-772`）；另需 LLM 与 embedding。**不是常驻服务**（库形态，进程内调用，SQLite 存历史），但**每次 add 至少一次 LLM 调用 + 每 query 若干 embedding 调用**。**token/延迟官方数字未读到**。
- **⑨ 实测数字**：Mem0 自报 LoCoMo **68.5%**（见 §4）；**本笔记未读到 2.2.1 版本自身的公开评测表**。
- **⑨b 关键公式（可直接照抄）** —— **实体加成**（`_compute_entity_boosts`，`main.py:1747-1827`；异步版 `3433-3500`）：查询实体去重**最多取前 8 个**（`1758-1765`）→ `entity_texts` 批量 embed → 逐个在实体库 `search(top_k=500)` → 对每个命中实体（要求 `similarity >= 0.5`，**低门槛过滤**，`1806-1808`）：`n = max(len(linked_memory_ids),1)`；`memory_count_weight = 1/(1+0.001*(n−1)²)`（`1815-1816`）；`boost = similarity * ENTITY_BOOST_WEIGHT(0.5) * memory_count_weight`（`1817`）；对其每个 `linked_memory_id`：`memory_boosts[m]=max(旧值, boost)`（`1819-1822`）。`ENTITY_BOOST_WEIGHT = 0.5`（`scoring.py:57`）⇒ **单条记忆的实体加成上界 = 0.5**；`memory_count_weight` 是「**实体越热门、单条加成越低**」的抑制项（防「人/地名」这类高频实体把一批记忆全部顶上来）。**加性打分**（`score_and_rank`，`scoring.py:60-139`）：`threshold` **先门控语义分**（`semantic_score < threshold` 直接淘汰、不参与混合，`111-112`）→ `raw_combined = semantic_score + bm25_score + entity_boost` → `max_possible = 1.0 (+1.0 若启用 BM25) (+0.5 若启用实体加成)`（`97-101`）→ `combined = min(raw_combined/max_possible, 1.0)`（`118-119`）；`explain=True` 时返回 `score_details{semantic,bm25,entity,raw,max_possible,final,threshold}`（`126-135`）。**BM25 侧归一化**（`scoring.py:16-54`）：按查询词数选 sigmoid 中点/陡度 —— `num_terms<=3 → (5.0,0.7)`；`<=6 → (7.0,0.6)`；`<=9 → (9.0,0.5)`；`<=15 → (10.0,0.5)`；`>15 → (12.0,0.5)`；`normalized = 1/(1+exp(−steepness*(raw−midpoint)))`。**实体抽取规则**（`entity_extraction.py`，「无监督、无 LLM」）：spaCy NER（**仅接受** PERSON/ORG/GPE/LOC/FAC/PRODUCT/WORK_OF_ART/EVENT/NORP/LAW/LANGUAGE，**显式排除 DATE/TIME/CARDINAL**，`:100-122`）→ 技术标识符正则（`a.b.c` 形，`:404-405`）→ 专名跨度（含 `of/the/for/at/in` 内连接词，`:543-578`）→ **引号内文本**（`:581-588`）→ **名词短语 TOPIC**（需具体修饰语，否则被 `_GENERIC_HEADS`/`_NON_SPECIFIC_ADJ` 过滤，`:590-696`）；最后按 `priority → 置信度 → 跨度长度 → 位置` 排序去重并去重叠（`:705-728`）。**三类候选置信度**：NER 0.95 / 标识符 0.9 / 专名跨度 0.8 / 引号 0.75 / TOPIC 0.45。**记忆链接的 4 种可连条件（原文 `prompts.py:692-701`）**：① **Same entity/topic**（新事实关于已提过的人/地/物）② **Updated preference**（对已捕获内容的改变或演化的看法）③ **Continuation**（先前叙事中的后续事件或下一步）④ **Contradiction**（与既有记忆冲突的新信息）；且明确「**Do NOT link memories that merely share a vague theme** … the linked memories should be about the same specific entity, event, or topic.」
- **⑩ 适配判定**：**需改造（可借鉴，不可直搬）**。理由：**加成公式**与「**实体当条目**」的数据形状可平移到 SQLite（一张 `entities` 表 + 一张 `entity_memory` 关联表即可复刻），但**纯 SQLite 无原生 ANN** —— `semantic_match >= 0.95` 与 `similarity >= 0.5` 这两处**向量判定需要改为「归一化文本精确匹配 + 预计算余弦」或引入本地小向量索引**，否则 spaCy 之外的整条链路（LLM 链接/语义去重）都得换实现。**不需要常驻服务**是合得来的（库形态）。
- **⑪ 能照抄的具体机制**：**实体加成公式**（含 `memory_count_weight` 热门实体抑制项），表：`entity(id, text_norm, type, embed)` + `entity_memory(entity_id, memory_id)`；**加性打分 + `max_possible` 自适应除数 + `threshold` 只门控语义分**（「**先门控语义再混合**」的顺序值得照抄，能挡掉纯靠 BM25/实体顶上来的噪声；`explain` 明细字段名可直接用作审计字段）；**BM25 按查询长度的 sigmoid 参数表**（无需调参即可用）；**实体的 4 类抽取 + 优先级去重**规则（可只用其 `_GENERIC_HEADS`/`_NON_SPECIFIC_ADJ`/`_GENERIC_SINGLE_ENTITY_TERMS` 黑名单，**这几张表对中文场景需自行替换**）；**写前校验双保险**：md5 精确去重（**廉价、必抄**）+ 实体归一化文本去重。
- **⑫ 已知失败模式**：**LLM 链接声明不落库**（见 ④ ⚠️）⇒ 语义上「矛盾/偏好变更」类链接**根本没进库**，检索只能靠实体词面共现，**同义改写即断链**；实体加成**只对上「查询中能被 spaCy 抽出来的实体」**（查询无实体 ⇒ 该路失效，`main.py:1676-1678` 有 `if query_entities`）；`similarity >= 0.5` 门槛偏低 ⇒ **热门实体膨胀**（`memory_count_weight` 只能压幅、不能止损）；spaCy 缺失时**静默降级为空实体**（不报错）⇒ 线上「看起来正常但没链接」；`_remove_memory_from_entity_store` 在实体库未初始化时**直接 no-op**（`main.py:665-667`）⇒ 跨进程场景可能遗留脏链接。

#### C-2 Memobase

- **① 代表/链接/许可/读到哪**：`memobase` **0.0.27**（PyPI wheel，**客户端本体**），服务端另有版本线（README 提到 `0.0.37`）。许可 **Apache-2.0**（`memobase-0.0.27.dist-info/METADATA`：`License: Apache-2.0`；含 `LICENSE`）。链接 <https://github.com/memodb-io/memobase>（**DNS 拦，未直读**）、<https://memobase.io>。读到：**wheel 全源码**（`memobase/core/entry.py`、`blob.py`、`user.py`、`async_entry.py`、`network.py`）+ `METADATA` 内嵌 README（含 profile 输出样例、flush 说明、latency/成本主张）。**服务端实现完全不在包内**。【源码】（客户端本体）
- **② 一句话架构**：**用户画像（profile）+ 事件时间线（event）** 双件套；写入走「**每个用户一个 buffer，异步批量 flush**」，在线只做几次 SQL 取画像/事件 ⇒ 声称**在线延迟 <100ms**。
- **③ 数据形状**（`core/user.py`）：`UserProfile{topic, sub_topic, content}`（`user.py:8-29`，**结构化画像**，`describe()` 可拼成文本塞 system prompt）；`ProfileDelta{topic, sub_topic, content}`；`EventTag{tag, value}`；`EventData{profile_delta[], event_tip?, event_tags[]}`；`EventGistData{content}`（`user.py:39-60`）；`UserEventData{id, event_data, created_at, updated_at}`、`UserEventGistData{id, gist_data, ...}`（`user.py:62-81`）。Blob：`ChatBlob`（写入单元）与 `SummaryBlob`（`memobase/__init__.py:1-4`）。
- **④ 写入路径**：应用侧 `u.insert(ChatBlob)` 把对话**塞进 buffer**（`entry.py:136`）；**默认不同步**（`sync=False`）。**flush 触发条件（README 原文）**：「When the buffer zone becomes too large (**e.g., 1024 tokens**) or remains idle for an extended period (**e.g., 1 hour**), Memobase will flush the entire buffer into memory.」也可 `u.flush(sync=True)` 手动等待。落到 `POST /users/buffer/{user_id}/{blob_type}?wait_process={sync}`（`entry.py:165-168`）—— **服务端**做 LLM 抽取/汇总。**写前校验：未读到**（客户端无去重/冲突校验逻辑；服务器侧不在此 wheel 内）。`u.get(bid)` 明确「**flush 后就取不到了**」⇒ **blob 是缓冲语义，非持久条目**。
- **⑤ 检索路径**：`u.profile()` 返回**结构化画像列表**（`topic/sub_topic/content`），直接放 system prompt（`entry.py:197-235`）；事件侧 `search_event` / `search_event_gist` / `search_event_by_tags`（`entry.py:284-353`）；另有 `context()`（`entry.py:355`）。**无 agent 多跳迭代**；画像本身是全量读取（「only few SQL operations」）。**是否向量检索：未读到**（客户端不暴露）。
- **⑥ 整理/巩固**：**由 flush 承担** —— buffer 批量进入，服务端**在同一批内**产出 `profile_delta` 并合并成 profile（README：「As you insert more blobs, the profile will become better」）。
- **⑦ 遗忘/失效**：有 `delete_profile` / `delete_event`（`entry.py:249-271`）；**主动衰减/淘汰机制未读到**。
- **⑧ 依赖与成本**：**必须常驻服务** —— README 明示「Memobase is building with **FastAPI, Postgres and Redis**, supporting request caching, authing, telemetry… **Fully dockerized**」。客户端还依赖 `pydantic/httpx/openai`（METADATA `Requires-Dist`）。成本主张：内置 buffer 分摊 LLM 开销、「系统中没有 agents 因此不会过度烧钱」；延迟 <100ms —— **均为主张，非可复现实测**。
- **⑨ 实测数字**：README 称在 **900 轮真实聊天**上做画像对照（对比 mem0）→ 见 `docs/experiments/900-chats`（**未读到**）；称在 **LoCoMo** 上「we're SOTA」（属服务端 `0.0.37`）—— **具体分数未读到**。
- **⑩ 适配判定**：**不可行（作为整体方案）；但其画像数据模型可借鉴（需改造）**。理由：**必须常驻 Postgres + Redis + FastAPI**，与「不许常驻服务、纯 SQLite」**直接冲突**；且核心抽取逻辑在服务端、**未读到**。
- **⑪ 能照抄的具体机制**：**`Profile{topic, sub_topic, content}` 这个「按主题分槽、画像与事件分离」的数据形状**（可平移到 SQLite 表 `profile(user_id, topic, sub_topic, content, updated_at)` + `event(user_id, tip, tags, created_at)`）；**「画像常驻 prompt、事件另存时间线」** 的读写分工（**在线零抽取**）；**buffer→异步 flush 的阈值思路**（**规模 or 空闲双触发 + 可手动强制**）可借为「批量整合」的触发策略。
- **⑫ 已知失败模式**：buffer 未 flush 前的数据**不可检索**（`u.get` 会失败）⇒ **崩溃即丢缓冲**；强依赖服务端在线；`flush(sync=False)` 默认异步 ⇒ **读写竞态需应用自己处理**。

#### C-3 MemoryLLM

- **① 代表/链接/许可/读到哪**：`MemoryLLM: Towards Self-Updatable Large Language Models`，Yu Wang 等（UCSD + Amazon），v2 2024-05-26。许可 **CC BY 4.0**（arXiv HTML 页脚明示）。链接 <https://arxiv.org/abs/2402.04624>；代码 <https://github.com/wangyu-ustc/MemoryLLM>（**DNS 拦，未直读**）。读到：**arXiv HTML 全文**（本地引擎取回，**截断于 50000 字符**），覆盖 §2 Preliminaries、§3 MemoryLLM（3.1 Structure Design / 3.1.1 Memory Pool / 3.1.2 Self-Update / **3.1.3 Analysis of Forgetting** / 3.2 Training Strategy）。**§4 实验数字未读到全文**（仅摘要所述）。【论文 Method】
- **② 一句话架构**：把**可自更新的记忆做成参数** —— 在冻结的 Llama2（参数 ϕ）**每一层**里插一段**定长 memory pool**（参数 θ，每层 `N×d` 个 "memory token"），新知识直接**写进这些隐向量**。
- **③ 数据形状**：**不是文本行，是隐向量**。`θ={θ_l}`，`θ_l∈R^{N×d}`；生成时全部 memory token 参与注意力，注意力图 `n_x×(n_x+N)`。**显式实现**：7B 模型 + **1B 参数的记忆池**。
- **④ 写入路径（自更新，§3.1.2）**：输入新知识 `x_c` → 取 `θ_l` 的**最后 K 个 token**（K≪N）与隐状态 `h_l` 拼接送入 `ϕ_l` → 输出 `h_{l+1}` 的**最后 K 个**即新 memory token `e'_θ^l` → 对 `θ_l` **随机丢弃 K 个** token，左移后把新的填到右侧。**无独立「写前校验」**（无去重/冲突检测；陈旧知识靠随机丢弃退场）。
- **⑤ 检索路径**：**没有检索** —— 记忆在权重/隐状态里，靠前向传播被「读到」。**无多跳、无扩散，agent 不能迭代调用**。
- **⑥ 整理/巩固**：**训练阶段**完成 —— ① New knowledge incorporation（取文档切两段 `(x1,x2)`，用 x1 自更新后再预测 x2；两种过程（带/不带梯度）按 50% 随机选）② 增强连续上下文理解 ③ 缓解遗忘。全部需要**预训练式的 next-word-prediction 训练**。
- **⑦ 遗忘/失效（有精确公式，可迁移）**：每次更新丢弃 N 中的 K ⇒ **知识以 K/N 的速率指数遗忘**；经过 `N/K` 步后，注入于 `N/K` 步前的知识**保留率 = (1 − K/N)^{N/K}**，且当 `N/K → ∞` 时极限为 **1/e ≈ 36.8%**（Eq.3–4）。⇒ 结论：**增大 N、减小 K** 才能少忘。
- **⑧ 依赖与成本**：需要**训练 + GPU + 改模型架构**；**token/延迟数字未读到**。
- **⑨ 实测数字**：摘要称在 model editing 基准、长上下文基准、自建知识保留实验上有效，**近百万次更新无性能退化**（摘要 + §1；**具体表格未读到**）。
- **⑩ 适配判定**：**不可行**。理由：**必须训练/更新权重**（要 GPU、要改架构、要重训），与「纯 SQLite、几百条记忆、不许常驻服务」完全不兼容；且**记忆不可按条删除/审计**。
- **⑪ 能照抄的具体机制**：**指数遗忘的闭式表达** `保留率=(1−K/N)^{N/K}`，以及「每次只丢固定比例 K/N」的确定性调度 —— **可降维移植**成 SQLite 上的行级衰减策略（把 `N` 当记忆容量、`K` 当每次整合吸收的条数），得到「**可预测、可审计**」的遗忘曲线，**无需任何权重更新**；另可抄它的**双参数划分**（ϕ 恒定真理 / θ 可变新知）→ 对应「**核心记忆 slot 不动 + 情景记忆滚动**」的分层。
- **⑫ 已知失败模式**：容量固定 ⇒ **必然遗忘**（1/e 是理论上限而非可选项）；**写入无校验** ⇒ 矛盾事实互相覆盖且**无法追溯**；**删除不可行**（只能等它自然衰减）；**错写入无法回滚**。

#### C-4 WISE

- **① 代表/链接/许可/读到哪**：`WISE: Rethinking the Knowledge Memory for Lifelong Model Editing of Large Language Models`，Peng Wang 等（浙大 + 阿里），**NeurIPS 2024**，v3 2024-12-19。许可 **arXiv.org perpetual non-exclusive license**（HTML 页脚）。链接 <https://arxiv.org/abs/2405.14768>；代码并入 <https://github.com/zjunlp/EasyEdit>（**DNS 拦，未直读**）。读到：**arXiv HTML 全文**（**截断于 50000 字符**），覆盖摘要、§1 Introduction、§2.1–§2.3.1（含 Table 1 方法对比、side memory 设计、routing 公式 Eq.3–5）。**§2.3.2、§3、§5 Limitations（目录在但正文未读到）**。【论文 Method】
- **② 一句话架构**：**双参数记忆** —— `main memory` 存预训练知识，`side memory` 存被编辑的知识；**只改 side memory**，并**训一个 router** 决定该 query 走哪套记忆。
- **③ 数据形状**：**FFN 的 value 矩阵**。side memory 初始化为某一层（中后层，如第 27 层）`W_v` 的**副本** `W_v' ← W_v`（§2.3.1）；知识被「**分片**」存进**随机正交子空间**，再**模型合并**回一个共享 side memory（§2.3.2；合并工具链见其引用 `mergekit`）。
- **④ 写入路径**：**没有 add / 写前校验**。每次编辑是一步**带 margin loss 的优化**：`Δ_act(x)=||A(x)·(W_v'−W_v)||₂`（Eq.3），目标是 `min{Δ_act(x_e)} ≫ max{Δ_act(x_i)}`（Eq.4），损失 `L_a` 由三个 hinge 项组成（Eq.5，形似 contrastive/triplet）。⇒ **写入 = 训练**。
- **⑤ 检索路径**：不是检索，是**路由** —— 推理时算 `Δ_act(x)`，落在编辑范围内走 side memory，否则走 main memory（`WISE-Retrieve` 变体在多片 side memory 里取激活最大者）。
- **⑥ 整理/巩固**：**knowledge sharding**（编辑分散到不同随机子空间、避免遗忘）+ **knowledge merging**（把各 shard 无冲突合并）。**这本身是本方法的核心贡献，也是它最重的部分**。
- **⑦ 遗忘/失效**：**没有删除机制**；错误编辑只能靠**再编辑覆盖**；且已并入权重的知识**无法逐条审计或撤销**。
- **⑧ 依赖与成本**：需**训练 router（含 margin loss）、改权重、做模型合并**；额外参数 = 至少一份 FFN value 矩阵 + 路由组件。有 "Inference Time Analysis" 附录（**未读到**具体数字）。**token/延迟未读到**。
- **⑨ 实测数字**：摘要称在 **GPT / LLaMA / Mistral** 上跨 **QA、Hallucination、OOD** 设置**三项指标同时领先**，胜过既有编辑方法并「overcome the impossible triangle」。Figure 1 是 ZsRE、LLaMA-2-7B、T=100 次连续编辑的三角对比。**具体数值表未读到**。
- **⑨b 不可能三角（逐字原文，本文件最重要的论断之一）**：
  > "we find that editing either long-term memory (direct model parameters) or working memory (non-parametric knowledge of neural network activations/representations by retrieval) will result in **an impossible triangle---reliability, generalization, and locality can not be realized together** in the lifelong editing settings. For long-term memory, directly editing the parameters will cause conflicts with irrelevant pretrained knowledge or previous edits (**poor reliability and locality**). For working memory, retrieval-based activations can hardly make the model understand the edits and generalize (**poor generalization**)."
  - 三属性定义（§1 逐字）：i) **reliability** —— 顺序编辑后当前与既往编辑都记得；ii) **locality** —— 编辑不影响无关的预训练知识；iii) **generalization** —— 不是死记 query-target 对，而是理解并泛化到同知识的不同问法。
- **⑩ 适配判定**：**不可行**。理由：需要**训练（router + margin loss）与权重编辑、模型合并**，且知识进入权重后**无法逐条审计/删除**，与我们「纯 SQLite、可审计、不许常驻服务」直接冲突。
- **⑪ 能照抄的具体机制**：**「分层记忆 + 路由」这个抽象**（不是实现）—— 即「**不变的核心层 + 可写的旁路层 + 一个便宜的判据决定查哪层**」。落到我们这里：**核心记忆 slot（不动）+ 情景记忆表（可写）+ 一个廉价的路由判据**（例如「query 是否命中核心 slot 的键」或 Mem0 的实体命中），这能在**零训练**的前提下拿到该架构带来的主要收益。另可抄它的「**side memory 初始化为 main memory 的副本**」思想：新增记忆层时以现有层为初始状态，避免从零重建。
- **⑫ 已知失败模式**：编辑只对**高度相似**的 query 生效（Eq.4 要求 margin 极大），换个说法即失效；sharding/merging 是**误差来源**；**无删除** ⇒ 隐私/错误不可撤回；需为每批编辑付**训练成本**。
- **⑫b 它给出的「预期管理」结论（要写进方案的部分）**：① **纯检索路线有其天花板**（retrieval-based working memory 让模型「难以理解编辑、难以泛化」）；② **但纯参数路线更糟**（直接改参数会与无关预训练知识/既往编辑冲突）；③ ⇒ **两者都不能单独满足全部要求**，「bridge the gap」需要**额外机制**（side memory + router + sharding + merging）—— **代价是训练与额外参数**。**这就是「不可能三角」的预期管理含义：别指望某一层单独包打天下。**

#### C-5 MemX（**与我们约束最贴近的一篇**）

- **① 代表/链接/许可/读到哪**：`MemX: A Local-First Long-Term Memory System for AI Assistants`，Lizheng Sun，2026-03，arXiv **2603.16171**。**许可：未读到**（笔记只标明形态；GitHub 拦）。读到：本地已取回的 `memx.txt` 第 1–435 行（Abstract、§1、§2、§3.1–§3.6）。**GitHub 仓库未直读**。【论文 Method】
- **② 一句话架构**：**local-first** 的长期记忆 —— **Rust + libSQL（SQLite 开源分支，单文件带向量扩展）+ OpenAI 兼容 embedding API**；检索 = 向量召回 + 关键词召回 → **RRF** → **四因子重排** → **低置信拒答** → 去重 → TopK。
- **③ 数据形状（两张表，可近乎照搬）**：`memories`：`content`、`embedding`、`type`、`tags`、`metadata`、`importance` + **`access_count`/`retrieval_count` 及各自时间戳**（`last_retrieved_at`、`created_at`）；`memory_links`：**有向关系表，7 种关系** —— `similar / related / contradicts / extends / supersedes / caused_by / temporal`（§3.2）。⚠️ **注**：**链接表存在但尚未接入检索**（**无多跳遍历、无图感知重排**，§2、§3.2 **自陈**）。
- **④ 写入路径**：文中未给 add 的完整校验流程；有 **result dedup**（内容去重 + **tag-signature 去重**，§3.5）与 **access/retrieval 计数分离**（§3.7）。**是否写前校验 ⇒ 未读到**。
- **⑤ 检索路径（全部可照抄）**：① `Embed(q)` → `VectorRecall(cosine, n)`；`KeywordRecall(FTS5, n)`；② `RRF(V, K)`，**k = 60**；③ **四因子重排** `score(m)=α_s·f_sem + α_r·f_rec + α_f·f_freq + α_i·f_imp`，默认 **α_s=0.45（语义，来自 RRF 分）、α_r=0.25（recency）、α_f=0.05（frequency）、α_i=0.10（importance）**；**权重和 0.85 ≠ 1**（靠后续 z-score 消除绝对尺度）；recency 用 **`last_retrieved_at`** 而非 `last_accessed_at`、frequency 用 **`retrieval_count`** 而非 `access_count`（「排序反映记忆**在检索中多有用**，而非被浏览过多少次」）；`f_rec(m)=2^{−d_m/h}`，`d_m=(now−t_m)/86400` 天，**半衰期 h = 30 天**；`f_freq(m)=min(1, ln(c_m+1)/10)`；④ z-score 后用 **sigmoid** `ŝ=1/(1+exp(−(s−μ)/σ_s))`，`σ_s<1e-6` 时跳过；⑤ **低置信拒答**：**若关键词集为空 且 max 向量相似度 < τ，直接返回空**；**推荐 τ = 0.50**（阈值扫描得出）；⑥ **两层去重**：内容去重（保留最高分那条）+ **tag-signature 去重**（`type::sorted(tags)`，每个签名最多回一条，**防止同主题 procedural 记忆挤占 top-k**；无 tags 的记忆豁免）；⑦ TopK 返回，并把**检索统计写回数据库**。
- **⑥ 整理/巩固**：**未读到**独立巩固层（见 ② 的 local-first 定位与 ⑦ 的统计回写）。
- **⑦ 遗忘/失效**：由 `expiration`/`contradicts`/`supersedes` 三处近似承担（`memory_links` 有这三类边）；**主动衰减/TTL 机制未读到**。
- **⑧ 依赖与成本**：Rust + libSQL 单文件 + 嵌入 API；**无常驻服务**。数字：**FTS5 在 10 万条规模把关键词检索延迟降约 1,100×，端到端检索 < 90 ms**（摘要）。
- **⑨ 实测数字（口径明确，值得引）**：自建中文基准 **43 queries、≤1,014 records**：default 场景 **Hit@1 = 91.3%**，high-confusion **100%**；**LongMemEval（500 queries、最多 220,349 records）**：**fact 粒度 Hit@5 = 51.6%、MRR = 0.380**（约 session 粒度的两倍），**temporal 与 multi-session 仍难（≤43.6% Hit@5）**。⚠️ 口径备注：**Hit@5/MRR 是检索命中指标，不是问答准确率**，与 §4 的 accuracy/F1/LLM-Judge 都不同量纲；其自建中文基准规模很小（43 问）。
- **⑩ 适配判定**：**可行（最接近我们，建议作为主要参照）**。理由：它就是 **SQLite-family + 单用户 + 无服务 + 可解释检索**的形态；唯一与我们不同的是用了 libSQL 向量扩展与嵌入 API（我们可以退化为本地小模型或预计算余弦）。
- **⑪ 能照抄的具体机制**：**低置信拒答**（关键词集空 且 `max cos < τ`）—— **用一行判据换来「无答案时不硬答」**，正好对应 LongMemEval 的 **abstention** 能力与综述说的 **refusal slices**；**RRF k=60**；**四因子重排 + z-score/sigmoid + `last_retrieved_at`/`retrieval_count` 的语义选择**；**两层去重（内容 + tag-signature）**；**`memory_links` 的 7 种关系命名**（`contradicts`/`supersedes`/`caused_by` 直接可用）。
- **⑫ 已知失败模式**：**它把 `memory_links` 建了但没接进检索**（**自陈** "does not yet integrate multi-hop traversal"）⇒ 如果我们也只建表不用，就会复现同样的「**有链接、无多跳**」。**结论（笔记原话）**：**要么真接进检索，要么明说只作审计留痕。**

### §2 附：并列登记项（简版模板 —— 只写笔记里已有的项，缺项一律「未读到」）

> 这 7 项在 §1 以「附表」形式登记（**未单独成行**）；此处给同一模板的**简版**，避免素材丢失。**简版 = 部分模板项在笔记里本身就未读到**，不是汇总时省略。

#### X-1 honcho（plastic-labs，「推理优先」的记忆服务）

- **① 代表/链接/许可/读到哪**：`plastic-labs/honcho`。商店 <https://dsh.deepseek404.com/detail.php?id=plastic-labs%2Fhoncho>；仓库 <https://github.com/plastic-labs/honcho>；托管 <https://api.honcho.dev>。**许可：未读到**（商店页有 "License" 目录项，但未落入截取的前 4500 字内；未再抓一次）。规模：Stars **7.4k** / Forks 914 / Issues 146 / 更新「今天」。读到：商店详情页 README **前段**（定位 / Why Honcho 能力表 / The Honcho Loop / Core Concepts / Quickstart 与 Python SDK 代码块开头）。**源码未读到**。【文档·abstract】
- **② 一句话架构**：**FastAPI 常驻服务** —— 把消息/事件存到 session，**后台异步「reason」**更新 **peer representations**，再通过 Chat Endpoint 查询或用自然语言要答案。
- **③ 数据形状**：四层 `workspaces` → `peers`（用户/agent/群组/项目/想法，「entities that change over time」）→ `sessions`（peers 参与）→ `messages`（活在 session 上）。核心产物 = **per-peer representation**（「Extracts **conclusions** from conversations and events, not just matching chunks」）；**`Multi-peer perspective`** =「Models **what one peer knows about another** when configured」（**差异化点：建模「A 眼中的 B」**）。
- **④ 写入路径**：谁写 = 调用方（SDK / MCP / CLI）`session.add_messages([...])`；**关键是「写入同步、推理异步后台」**。**写前校验/闸门：未读到**。
- **⑤ 检索路径**：**The Honcho Loop 四步** —— **Store**（存 messages/events/documents/tool traces）→ **Reason**（「Honcho processes the queue **in the background** and updates peer representations」）→ **Query**（asking for context / search results / peer representations / a **natural-language answer**）→ **Inject**（塞进任意 LLM 调用）。两种取用：`alice.chat("…")`（自然语言问答）与 `session.context(summary=True, tokens=10_000)`（**prompt-ready context，带 token 预算**）。**多跳 / agent 迭代调用：未读到**。
- **⑥ 整理/巩固**：**后台 reason 就是巩固**（**队列驱动的异步巩固**）。**留痕/回滚：未读到**。
- **⑦ 遗忘/失效**：**未读到**。
- **⑧ 依赖与成本**：**明确需要常驻服务** ——「run a local stack with `honcho start`」或「**self-host the FastAPI server yourself**」，或托管 `api.honcho.dev`；FastAPI server 是核心，Python 与 TypeScript SDK 在 `sdks/`。**成本数字未读到**。
- **⑨ 实测数字**：**未读到**具体数值；只有自述「Honcho has defined the **Pareto Frontier of Agent Memory**」并指向 evals page 与 blog（**未读到该页**）。⚠️ **口径备注**：这是**营销性自述**（"Pareto Frontier"），**无数字、无第三方验证信息，不可引用为实测结论**。
- **⑩ 适配判定**：**不可行**。理由：**架构核心就是一台常驻 FastAPI 服务**（或托管 API），与「不许常驻服务」直接冲突；且它的价值来自「后台异步推理」，**没有常驻进程就没有这个价值**。
- **⑪ 能照抄的具体机制**：**`context(summary=True, tokens=10_000)`：可指定 token 预算的上下文装包**（「给召回结果一个显式 token 上限」）；**`Multi-peer perspective`**（建模「一个 peer 眼中的另一个 peer」，对单用户场景价值有限）；**The Honcho Loop 的四段命名**（Store → Reason（后台）→ Query → Inject，一个干净的分层词汇表）。
- **⑫ 已知失败模式**：**未读到**自陈失败模式（仅有的自述都是正面的：「higher retention, more trust, data moats」）。

#### X-2 Supermemory

- **① 代表/链接/许可/读到哪**：`supermemory` **3.62.0**，**官方 Python SDK**（Stainless 生成，`_constants.py:1`）。许可 **Apache-2.0**（`supermemory-3.62.0.dist-info/METADATA:10`）。链接 <https://github.com/supermemoryai/python-sdk>（**DNS 拦，未直读**）；API 文档 `docs.supermemory.ai`（未直读）。读到：**wheel 全文件清单 + README（METADATA）+ `_client.py:74-190` + `resources/*.py` 签名 + `types/*`**。**服务端实现完全不在包内**。【源码】（SDK 本体）
- **② 一句话架构**：**纯托管的 REST 记忆服务** —— SDK 只是 `httpx` 客户端，默认指向 `https://api.supermemory.ai`；记忆以 **container（容器标签）** 分桶。
- **③ 数据形状**：服务端模型不可见；客户端可见资源分 `documents`（文档/内容）、`memories`（记忆条目）、`search`、`connections`（外部源连接）、`settings`；调用形如 `client.memories.update_memory(container_tag="user_123")`、`client.search.documents(...)`、`client.memories.forget(...)`。**字段级 schema 未读到**（只有客户端 `types/*_params.py`）。
- **④ 写入路径**：客户端 `documents.add` / `documents.batch_add` / `memories.update_memory` → **HTTP 写**到托管服务；**写前校验、何时落库、异步与否：未读到**（服务端黑盒）。
- **⑤ 检索路径**：`client.search.documents(...)`；另有 `client.profile`。**静态/动态画像的区分与算法：未读到**。
- **⑥ 整理/巩固**：**未读到**（服务端）。
- **⑦ 遗忘/失效**：有显式 `memories.forget(...)`；`document_delete_bulk`。**自动衰减/TTL：未读到**。
- **⑧ 依赖与成本**：**必须常驻外部服务 + API key**（`api_key` 从 `SUPERMEMORY_API_KEY` 推断，缺失即抛 `SupermemoryError`，`_client.py:105-110`；默认 base URL 可被 `SUPERMEMORY_BASE_URL` 覆盖，**自建有官方 docker 与否：未读到**）；默认超时 60s、重试 2 次。**单价/token 数字未读到**。
- **⑨ 实测数字**：**未读到**（包内无 benchmark；未检索到可引用的官方跑分，故不写）。
- **⑩ 适配判定**：**不可行**。理由：**托管的常驻服务 + 需要 API key 与联网**，违反「不许常驻服务 / 纯 SQLite / 要可审计」；且核心算法**完全不可见（未读到）**，无法审计也无法离线复现。
- **⑪ 能照抄的具体机制**：仅**接口层两点** —— **`container_tag` 式「一用户一容器」命名**（可作为 SQLite `user_id` 分区的概念对照）；**`forget` 作为显式一等 API**（遗忘是一等公民而非附属，对应「可审计的删除」）。其余无。
- **⑫ 已知失败模式**：SDK 对 API key/base_url **强依赖**（缺 key 直接抛错）⇒ 离线/无网不可用；默认重试 2 次 ⇒ **写操作可能重复，需服务端幂等兜底**；网络失败抛 `APIConnectionError`/`RateLimitError`。

#### X-3 HERO

- **① 代表/链接/许可/读到哪**：HERO，arXiv **2608.22310**。许可**未读到**（笔记未记录）。读到：`2608.22310.txt` 第 2、45–535 行（摘要、§1、方法、实验）。【论文 Method】
- **② 一句话架构**：**异质记忆图**两层 —— **Episodic Layer**（Episodic Traces → Episodic Units → Episodic Cues）+ **Profile Layer**（Profile Insights / Profile Cues）；边由**结构包含 + 语义索引 + 时间链**连接。
- **③ 数据形状**：未读到字段级 schema（见 ⑪ 对「profile 节点」的主张）。
- **④ 写入路径**：**支持增量更新**（新对话只加局部节点边，**不整图重建**）；**写前校验未读到**。
- **⑤ 检索路径**：三阶段 —— ① **Initial Anchor Identification**（query 抽实体匹配 cue 节点）→ ② **Iterative Context Expansion**（**K 轮「cue–context–cue」游走**，含同义节点扩展）→ ③ **Global Relevance Propagation**（用 **Personalized PageRank** 初始化 + 证据排序）。
- **⑥ 整理/巩固**：**未读到**（增量加边见 ④）。
- **⑦ 遗忘/失效**：**未读到**。
- **⑧ 依赖与成本**：检索开销 **< 1 s**；图 + PageRank（**要图结构**，但几百条规模可用迭代式稀疏矩阵在 SQLite 上实现）。
- **⑨ 实测数字**：**LoCoMo 87.99% accuracy / 56.06% F1 / 48.38% BLEU-1**；Multi-hop accuracy **85.11%**；**Recall@10 = 0.938**；**PERSONAMEM 70.63% accuracy**；检索开销 < 1 s。⚠️ 口径备注：**它同时报了 accuracy 与 F1/BLEU-1**（同一系统三个口径），**不能与 Letta 的单一 accuracy、MemoryOS 的 F1+BLEU-1 直接比**；**judge 与实际样本数未读到**。
- **⑩ 适配判定**：**需改造**（图 + PageRank 超出「纯向量」；但若已有 `memory_links` 表，**Personalized PageRank 在 SQLite 上可用迭代式稀疏矩阵实现**，规模几百条完全可行）。
- **⑪ 能照抄的具体机制**：**「profile 只导航、不当证据」** —— **原始对话文本作为 episodic 证据被完整保留，profile 只做「导航桥」（"profile nodes act as navigational bridges rather than replacement memories"）** ⇒ **天然抗「摘要丢证据」**；**「增量加边、不整图重建」**。
- **⑫ 已知失败模式（它自己列出的）**：**profile 抽取不准会带偏检索轨迹**（无 confidence 校准）；**时间推理仍需靠 temporal chaining 硬撑**。

#### X-4 EAR

- **① 代表/链接/许可/读到哪**：EAR，arXiv **2607.17879**。许可**未读到**。读到：`2607.17879.txt`（标题、摘要、目录、附录 B.1/B.2 超参表）。【论文 Method】
- **② 一句话架构**：`Exploratory-Assimilating Reflection` —— **Exploratory Reflection**（对每个 query 做**迭代搜索**以自举检索并收集经验）+ **Assimilating Reflection**（把这些经验从 **Experience Buffer** 中 **replay**，用来**精炼一个全局 reranker**）。
- **③ 数据形状**：Experience Buffer + 全局 reranker（**字段级 schema 未读到**）。
- **④ 写入路径**：写入 = 把探索经验存进 Experience Buffer 再 replay；**写前校验未读到**。
- **⑤ 检索路径**：**多跳/迭代=是**（探索阶段对每个 query 迭代搜索）；**agent 能否迭代调用：是（其核心就是迭代检索）**。
- **⑥ 整理/巩固**：**有** —— **replay 经验、精炼全局 reranker**（相当于把检索经验「固化」到排序器）。
- **⑦ 遗忘/失效**：**未读到**。
- **⑧ 依赖与成本**：需要**更新 reranker 的循环**（学习成分）+ 训练/replay 设施；**成本数字未读到**。
- **⑨ 实测数字**：相对 baseline retriever **最多提升 17.9%**（两个长期对话基准）；**样本高效**且**对噪声反馈鲁棒**。超参表（**Recall@5**）：探索步数 2/4/8 → **68.5 / 72.8 / 69.5**；replay batch 2/4/8 → 71.3 / 72.8 / 71.0；采样策略 similarity/reward/random → 72.8 / 69.9 / 70.3。⚠️ **可引的「别调过头」证据**：**探索步数过多反而变差（噪声反馈）**。
- **⑩ 适配判定**：**需改造（偏重）**。理由：它需要**更新 reranker 的循环**（学习成分），不是纯检索。
- **⑪ 能照抄的具体机制**：**「先迭代检索、再把经验沉淀成排序偏好」这个两段式** —— 可用**离线**方式复刻：把小金标上的人工/LLM 判定沉淀成一组**静态排序偏好规则**（**无需在线训练**）。
- **⑫ 已知失败模式**：**在线 replay 更新会引入训练与不可审计的漂移**（笔记判定中明确列为「最该避开」）；探索步数过多反而变差（噪声反馈）。

#### X-5 TRACE

- **① 代表/链接/许可/读到哪**：TRACE，arXiv **2607.00339**。许可**未读到**。读到：`2607.00339.txt`（标题、摘要、§1、方法、实验结论行）。【论文 Method】
- **② 一句话架构**：**Temporal Evidence Graph 上的 state-aware query processing** —— 三层顶点（**event / session / topic**），用 **bipartite incidence expansion** 把嵌套超图变成普通图以便统一遍历。
- **③ 数据形状**：三层顶点（event/session/topic）+ 时间边；每个事件有**有效性标量** `v(e)`（见 ⑦）。
- **④ 写入路径（离线构图四步）**：**session 级事件蒸馏 → cross-session linking（candidate gate 限制候选对，避免 O(|V_e|²) 爆炸）→ temporal & evolution 边推断（before / support / updates / contradicts）→ hierarchy injection**（注入 session/topic 顶点与相邻 session 的时间边，「**只加导航结构、不加事实**」）。**写前校验：未读到**。
- **⑤ 检索路径**：**dense 召回 top-k note → 映射到 event 顶点 → 增广 → 有界双向路径生成 + 剪枝 → 证据排序 → 混合上下文 `C_note`（原文）+ `C_path`（带关系标签与有效性标记的路径）→ 按 query shape 选 answer plan**（temporal→日期归一化指令；preference→偏好聚合；multi-hop→证据链；factual→简洁）→ 生成 → **可选 post-hoc 追溯**。
- **⑥ 整理/巩固**：构图即巩固（离线四步）；**触发与留痕未读到**。
- **⑦ 遗忘/失效（state-aware，本项最有价值的一条）**：每个事件初始 **validity `v(e)=1`**；当新事件经 **`updates` 边**连到旧事件时**下调旧事件有效性** ⇒ **直接对抗「过期事实被当现役」**（论文报 **outdated leakage** 得到控制）。
- **⑧ 依赖与成本**：完整图 + 路径生成 + answer plan；**median 在线延迟 947 / 728 ms**，**tokens 6,948 / 6,058**（对比全文基线大幅缩减）；每段对话蒸馏 **≈2,300–2,500 events**。
- **⑨ 实测数字**：LoCoMo（**n=470**）与 LongMemEval-S；**三层可解释性评测：81.8% 的 cue 含回答问题所需信息**；另有 **59 条 Stress Test**。⚠️ 口径备注：**LoCoMo n=470**（**不是**全量 7512 QA、也不是 LoCoMo-10 的 1986）⇒ 与 §4 的 85.38 / 74.0 / 68.5 **样本数不同，不可比**。
- **⑩ 适配判定**：**需改造（偏重）**。理由：完整图 + 路径生成 + answer plan 对「几百条记忆」是**过设计**。
- **⑪ 能照抄的具体机制**：① **「按 query shape 切换 answer plan」**（零成本、纯提示词层，**直接可加**）；② **有效性标记 `v(e)` + `updates` 边下调**（**一条字段 + 一次更新**，就能让「旧值不再被当现役」**可审计**）；③ **`C_note + C_path` 双段上下文**（原文保真 + 关系标签与有效性标记）。
- **⑫ 已知失败模式**：**未读到**明确自陈；架构上「完整图 + 路径生成」的复杂度与「每段蒸馏 2,300–2,500 个事件」的抽取规模，与我们的规模不匹配。

#### X-6 Navet 2026（**只登记，不采信**）

- **① 代表/链接/许可/读到哪**：**状态 = 博士论文提案（thesis proposal）、无实验结果**。HAL 链接 <https://hal.science/hal-05747244v1>；**许可 CC BY 4.0（已核）**（`research-arch.md` §10 表）。**本次未读到任何一手材料** —— 检索工具全部被限流（`web_search` / `anysearch_search` 均返回 **HTTP 402**），本机 GitHub 被 DNS 拦，DSH 插件商店搜 "navet" **0 命中** ⇒ **没有可核对的内容**。【文档·abstract】（提案阶段）
- **② 一句话架构（据 §10 表，属转述级）**：把 agent 记忆**锚定在开放标准（RDF/RDFS/OWL 2 RL/SHACL/SPARQL）**上，用**形式推理 + 声明式校验**改善**六种记忆操作**。
- **③–⑨**：**全部未读到**（无链接、无作者、无日期、无数字 —— 除上表的 HAL 链接与许可）。
- **⑩ 适配判定**：**需改造**（可借「六操作 + SHACL 校验 + PROV-O 溯源」三点）—— **但此判断属 §10 表的转述级，本次未验证**。
- **⑪ 能照抄的具体机制**：**未读到**（`research-arch.md` §10 表列的「六操作 + SHACL 校验 + PROV-O 溯源」**属转述未验证**）。
- **⑫ 已知失败模式**：**提案阶段、无实证**（这正是 `research-arch.md` 把它归入「**只参照 / 不采信**」的原因）。
- **处理**：**仅登记条目，不作为依据**；若后续需要，请在检索可用后补一次一手读取。

#### X-7 Generative Agents（reflection 层）

- **① 代表/链接/许可/读到哪**：Joon Sung Park, Joseph C. O'Brien, Carrie J. Cai, Meredith Ringel Morris, Percy Liang, Michael S. Bernstein（Stanford / Google）。**UIST '23**，DOI 10.1145/3586183.3606763；arXiv **2304.03442v2**（2023-08-06）。**许可：arXiv perpetual non-exclusive license**。代码 <https://github.com/joonspk-research/generative_agents>（**未读到源码**）。读到：HTML 全文的 §1–§3、**§4 Generative Agent Architecture 开头与 §4.1 Memory and Retrieval**（含 memory stream 定义与前若干 observation 例子），以及其它小节里对 reflection 的高层描述。**§4.2 Reflection 的正文（触发时机、摘要层级、insight 生成与证据引用）未读到** —— 两次抓取都在 §4.1 中间被截断（`web_fetch` 65536 字符 / `read_page` 50000 字符上限），ar5iv 与 arxiv-vanity 走同一份渲染、同样截断；**本引擎不吃 PDF**。【论文 Method】
- **② 一句话架构**：三层 —— **memory stream（自然语言的完整经验记录）+ reflection（把记忆递归综合成更高层推断）+ planning（把推断与当前环境递归分解成行为）**；reflection 与 plan 都**回写进 memory stream** 影响后续行为。
- **③ 数据形状（已读到的部分）**：memory stream = **记忆对象列表**，每个对象含 **① 自然语言描述 ② 创建时间戳 ③ 最近一次被访问的时间戳**；最基本元素是 **observation**（agent 直接感知到的事件：自己做的、他人做的、非 agent 对象发生的）。检索模型**综合 relevance + recency + importance 三个信号**挑记录（**三个信号的公式在 §4.1 后半，未读到**）。
- **④ 写入路径**：谁写 = agent 自身的感知循环把 observation 追加进 memory stream；reflection 与 plan 也写回同一条 stream。**写前校验：未读到**。
- **⑤ 检索路径**：**recency/relevance/importance 加权检索（不是图遍历）**；**agent 能否迭代**：reflection 自身是**递归**的（"recursively synthesized into higher- and higher-level reflections"）。
- **⑥ 整理/巩固（本项重点）**：**只读到「有递归的更高层摘要、且回写 memory stream」**；**具体触发阈值、每次生成多少条 insight、insight 如何引用/回指源记忆、层级如何递归 —— 全部未读到**（在 §4.2）。
- **⑦ 遗忘/失效**：**未读到**（论文有 "events … fade over time" 的动机表述，但**机制未读到**）。
- **⑧ 依赖与成本**：实现用 **gpt3.5-turbo（ChatGPT）**；25 个 agent 的沙盒社会；**无图库/向量库**；reflection 会额外产生 LLM 调用（**具体数字未读到**）。
- **⑨ 实测数字**：论文有**受控评测（"interview" 式，含 ablation：限制 agent 对 memory / reflection / planning 的访问）与端到端两日评测**，结论是**三者各自都对可信度至关重要**；**具体分数未读到**。
- **⑩ 适配判定**：**可行（需改造）** —— memory stream 就是一张 append-only 表（`observations(id, text, created_at, last_accessed_at, importance)`），retrieval 是 SQL 排序；**唯一缺的是触发时机与分层摘要的细节**（未读到，需后续补）。理由：它是纯 prompt + 列表，**零依赖**。
- **⑪ 能照抄的具体机制（仅限已读到部分）**：① **记忆对象三字段（描述 + 创建时间 + 最近访问时间）** —— 「最近访问时间」这一列是 **recency 信号的基础，很多系统会漏**；② **importance 作为独立于相似度的第三信号**（不是只按相似度检索）；③ **reflection 结果回写同一 memory stream**（把「推断」和「事实」放在同一空间，后续检索一视同仁）；④ **递归分层摘要**的方向（越高层越抽象）。
- **⑫ 已知失败模式（已读到）**：**检索失败**、**对记忆做编造性渲染（fabricated embellishments）**、**继承 LLM 的过度正式语气**；以及作者自陈「**记忆不断增长、事件会淡去**」的管理难题。

---

## §3 横向专题对比（本节是精华：跨架构拉通）

> 每条给三问：**谁做得最好 / 谁最便宜 / 我们的差距**。判定一律带出处与口径限制。

### ① 写入路径与写前校验

- **谁做得最好（闸门最严、最可审计）**：**灵枢（A-7）** —— 「**三道闸门（audit → 一致性 → gated 三问四态）非 ACCEPT 不落盘**」+ **fail-closed**（策略读不到就不落盘也不进队列）+ **`policy_bad_shape`「歧义即拒绝」** + **`committed` 字段（别把 `ok:true` 当写成功）** + **负记忆** + **编译者不得自证（E041）**；**dsh-ontology（B-7）** 次之 —— **写入即校验**、**拒绝时指名违反哪条约束并给出允许取值**、**撤回有依赖保护**；**ontology-to-tools（B-8）** 在**机制**上最彻底（**把约束编译成写入方必须调用的工具 ⇒ 生成期强制而非事后校验**），但**形态**不可照搬。**dsh-memory-eternal（A-9）** 的「**新卡默认 `pending` + 人工批准**」是**人工闸门**的代表（理由：自动全量入库会「污染上下文、放大幻觉」）。
- **谁最便宜（零成本且必抄）**：**Mem0（C-1）的 `md5(text)` 精确去重**（笔记原话：「**廉价、必抄**」）+ **实体归一化文本去重**；**mnemon（B-5）** 的 `remember` 写前去重（跳完全重复 / 保留不同事实 / 相似给 review 建议）；**dsh-memory-eternal** 的**三个数字闸门**（**捕获最小长度 200 / 日配额 60 / 召回相关性阈值 2**）。
- **我们的差距**：**`node_type` 从未被写入 ⇒ 「按类型分支」的逻辑全部不可信，`is_protected` 恒 0 = 死代码**（笔记判定：「**schema 写了等于没写**」）；**没有写入期校验层**；**没有 `committed` 式的真值回执**（无法区分「写了」和「工具返回成功」）。

### ② 检索路径与「能否多轮调用」

- **谁做得最好（多跳 + agent 自主）**：**Letta Filesystem（A-4）** —— **agent 自主多跳就是 74.0% 的成因**，并用 **`tool_rules` 三件套**「约束形状而不是禁止多跳」（InitToolRule 强制先检索 + ContinueToolRule 禁止检索后收尾 + TerminalToolRule 显式终止）；**MemGPT（A-2）** 的**`request_heartbeat`** 是最小可用的多跳开关；**Basic Memory（A-6）** 有专门的图遍历工具（`build_context(depth, max_related, timeframe)`）+ 完整 MCP 工具面；**MAGMA（B-1）** 的**意图加权 beam 遍历**（`φ(r,T_q)` 权重表 + 硬 MaxDepth/Budget）；**HyperSU（B-6）** 的**双向扩展 + 收敛奖励**（前向偏 recall / 后向偏 precision）；**MIRIX（B-4）** 的**粗检索→细检索两级、agent 主导**；**灵枢（A-7）** 的 **40 op + 条件路由 + 时间线回溯**。
- **谁最便宜（零 LLM、零服务）**：**MemX（C-5）** —— **向量 + FTS5 → RRF(k=60) → 四因子重排 → 低置信拒答**，**无 LLM 参与检索**、端到端 **< 90 ms**、FTS5 在 10 万条规模把关键词检索延迟降约 **1,100×**；**Mem0（C-1）** 的**一跳实体加成**（无扩散、无迭代，但加性打分公式可移植）。
- **我们的差距**：**`load()` 只认边 + 单轮注入 ⇒ 我们根本没有「让 agent 自己迭代查」的通道**（这是**实现取向**，不是范式缺陷）；且**图谱查询扩展在当前图结构下零增益、16 倍耗时**（**数据形状的必然**，不是图范式的上限）。

### ③ 遗忘 / 失效 / 冻结

- **谁做得最好（最可审计、最接近我们要的形状）**：**MemOS（A-5）** —— **`Version Chain`（修改历史 + 派生谱系）+ Time Machine（快照 + 历史回滚，且「what-if 演练不影响权威冻结版本及其审计链」= 回滚走副本、权威版本只读）+ `Frozen`（禁写但全历史保留）+ `Archived`（长时间未访问→降级到冷存储，**降级不是删除**）**；**mnemon（B-5）** —— **EI 公式（30 天半衰期 + 免疫规则）+ 软删（置 `deleted_at`）+ oplog + `auto_pruned_ids` + privacy-safe receipts（哈希回执）**；**opencontext（A-8）** —— **`valid_from`/`valid_until` + `supersession`/`contradiction`/`merge` 一等边 + 更正 append-only（不破坏）**，因此**能回答「上个季度我们相信什么」**，并对齐 MiFID II / SEC retention。
- **谁最便宜（一个字段就能换来）**：**TRACE（X-5）的有效性标记 `v(e)` + `updates` 边下调**（**一条字段 + 一次更新**，让「旧值不再被当现役」且**可审计**）；**mnemon 的 EI 闭式公式**（**纯 SQL 可算**，无需任何模型）；**MemoryLLM（C-3）的 `(1−K/N)^{N/K}`**（可降维成行级衰减曲线）。
- **我们的差距**：我们**只做了「30 天剪枝」**（据 `research-arch.md`：217 条 episodic 的现状），**没有选择性遗忘 / 冻结 / 软删 / 回滚 / 版本链**；`is_protected` 恒 0 ⇒ **「保护」也是死代码**。

### ④ 整理与巩固

- **谁做得最好（离线、写权分离、可回滚）**：**Auto-Dreamer（B-3）** —— **区域重写 `B*=(B\R)∪S`**（一次重写一整片而非逐条 CRUD；消融证明「区域重写本身贡献 6–11× 的压缩」）+ **provenance 硬链接**（fan-in 峰值 5）+ **反事实掩码打分**；**Letta 的写权分离（A-3）** —— **主代理不持有改 core memory 的工具**、巩固**异步**、**reorganize 前先备份**、可选二次审阅；**sleep-time compute（B-2）** 的**两段式预算（`t=10`）**给出「值不值得预计算」的判据。
- **谁最便宜**：**MemoryOS（A-1）的「迁完之后把 `L_interaction` 归零」**（**消费即清零，零额外存储**，笔记称本组最值得照抄）；**Basic Memory（A-6）的 chunk 哈希 ⇒ 只重索引变更 chunk**（「一千条笔记改一条只重索引变更部分」）；**Auto-Dreamer 的反事实掩码打分**当**离线体检脚本**（不需 RL，只做替换测试）；**dsh-memory-eternal 的「蒸馏关掉 = 存原文，一分钱不花」**。
- **我们的差距**：我们**已经有 7 个一次性子代理通道**，缺的只是「**把 core memory 的写入权从会话轮里摘出来、交给离线代理**」这一条纪律；且**离线整理若不落审计，会与「要能审计」直接冲突**（sleep-time compute **原文没有审计设计**）。

### ⑤ 依赖与成本

- **谁最便宜（最低依赖、可完全离线）**：**mnemon（B-5）** —— **单二进制 + SQLite + 零 API key**，嵌入**可选**（本地 Ollama，不可用则退化 token 重叠）；**Basic Memory（A-6）** —— **本地 fastembed `bge-small-en-v1.5`（384 维），「no API key, no network calls, no cost」**，**几百条首次索引 1–3 分钟**；**MemX（C-5）** —— Rust + libSQL 单文件，**无常驻服务**，端到端 **< 90 ms**；**灵枢（A-7）** —— Rust 内核零第三方依赖、中文 hit@1 **99.0%**（但**要一个 stdio 长驻进程**）；**可开箱关掉常驻的**：Mem0（库形态）、opencontext（**可纯库内嵌**）、dsh-memory-eternal（**MCP 用完即退**，web 可关）。
- **谁最贵 / 必须常驻**：**MemGPT/Letta（A-2/A-3）** —— **PostgreSQL + pgvector** / 完整 agent 服务器 + 嵌入 API（且 **两个 agent = 两倍会话开销**）；**Memobase（C-2）** —— **FastAPI + Postgres + Redis，完全 docker 化**；**Supermemory（X-2）** —— **第三方云 + API key**；**honcho（X-1）** —— **FastAPI 常驻，「无进程即无价值」**；**MemoryLLM/WISE（C-3/C-4）** —— **要训练 + 改权重 + GPU**；**Auto-Dreamer（B-3）** —— 需要一个**训练过的 14B consolidator**（训练成本未读到）；**MIRIX（B-4）** —— **每步 1 次 meta + 0–6 次 memory manager 调用**（多智能体的成本/延迟）。
- **我们的差距**：我们处在「**最便宜那一档**」的天然位置（纯 SQLite / 单用户 / 几百条 / 无服务）；差距在于**我们还没有任何延迟与索引成本的实测数字**（`research-arch.md` 指出我们的量台**缺「抽取层」与「遗忘层」两档**）。

### ⑥ 许可红线

- **绿（宽松、可 vendor）**：**MIT** —— `dsh-memory-eternal` v0.7.0 / `memory-eternal` v0.10.0（**均已核**）、`dsh-ontology`（**已核**）、`dsh-mnemon`（旧文档已核）；**Apache-2.0** —— Letta（**LICENSE 本体 + wheel METADATA 已核**）、MemoryOS（**LICENSE 本体已核**）、MemOS（**LICENSE 本体已核**）、Mem0（**pyproject + 包内 LICENSE 已核**）、Memobase（**METADATA 已核**）、Supermemory SDK（**METADATA 已核**）、mnemon（**pkg.go.dev + 仓库 License**）。
- **红（不能 vendor，只能借思路）**：**Basic Memory = AGPL-3.0**（**Copyleft**「Derivative works must be distributed under the same license」+ **Network Use**「Network users must be able to receive the source code」）；⚠️ **其许可系从官方文档页读到，LICENSE 文件本体检未读到**。
- **论文侧许可**：**CC BY 4.0**（MemGPT、MemOS 论文、MIRIX、sleep-time compute、MemoryLLM、ontology-to-tools、综述 2509.18868、Navet HAL）；**arXiv perpetual non-exclusive / nonexclusive-distrib-1.0**（MemoryOS 论文、HyperSU、WISE、MAGMA、MemoryAgentBench、Generative Agents）；**Letta 博客 = Letta 版权（非开源许可）**。
- **未读到**：**大量代码仓库的许可**（GitHub 被 DNS 拦）：MAGMA、sleep-time-compute、Auto-Dreamer、MIRIX、MemX、HERO、EAR、TRACE、letta-leaderboard；以及 `dsh-memory`（灵枢，商店页无 license 段）、`honcho`（商店页 License 项未落入截取范围）。`opencontext` 的 Apache-2.0 系**商店页 README 自述**。
- **我们的差距/注意**：**AGPL 的 Basic Memory 只能借思路**；其余主流程可在宽松许可内借鉴。**本文件只是调研汇总，不构成任何许可结论** —— 真正 vendor 前须就目标仓库的 LICENSE 本体单独核验。

---

## §4 口径与可比性

### 4.1 五种口径互不可比（原文层面各不相同）

| # | 口径 | 报的是什么 | 出处 | 关键限定 |
|---|---|---|---|---|
| 1 | **Letta** | **单一准确率**（74.0%，gpt-4o-mini） | Letta 官方博客，2025-08-12（**全文读到**） | 必须带 Letta 自己的 caveat（见 4.3） |
| 2 | **MemoryOS** | **F1 + BLEU-1**（LoCoMo 原生 token-level） | arXiv 2506.06326 §4.2（**全文读到**） | 摘要里的 **+49.11% F1 / +46.18% BLEU-1 是相对基线的平均提升**，不是绝对分；且它主动做了**同环境重跑的 `A-Mem*` 列** |
| 3 | **MemOS** | **LLM-Judge 分数**（Table 3，**Top-K=20**，带标准差） | arXiv 2507.03724 §6.1（**读到**） | 基线只有 langmem/zep/openai/mem0 ⇒ **不含 Letta/MemoryOS，无法与 74.0% 对话**；表中 F1 列有抓取断字，**只采信 LLM Judge 列** |
| 4 | **opencontext** | **自评 harness**（LongMemEval-S 97.6 / LoCoMo-V2 97.4 / BEAM@10M 67.0） | 商店页 README（**文档级**） | **作者自陈**：opencontext self-evaluations、**our own harnesses**、**not AML results**（AML 用 **private refined datasets**） |
| 5 | **灵枢** | **内部标尺**（自报中文 hit@1 99.0%；第三方复评 7 轮统一评分 9.258；LoCoMo 独立复现逐位一致） | 商店页 README（**文档级**） | **作者自陈**：「能力自评与第三方复评 … **内部标尺非横评声明**」；另有诚实负面（自然问句 hit@10 40.2%、端到端 QA 17.2%） |

**结论（笔记原话的口径纪律）**：**四家的 LoCoMo 数字互不可比** —— Letta 自己写了「apples to oranges」；opencontext 自己声明「self-evaluations, not AML」；MemoryOS 主动同环境重跑基线并加 `A-Mem*` 列；灵枢自己声明「内部标尺非横评声明」。**任何引用都应带上它的自述限定。**

### 4.2 另外两条容易混进来的口径（同样不可比）

- **MAGMA（B-1）**：**LLM-as-a-Judge 0.700**（**judge 与 backbone 同为 gpt-4o-mini**，同 backbone 对比）—— 是 **judge 口径**，与 F1/BLEU-1、单一 accuracy、Hit@k 都不同。
- **HERO（X-3）**：**同时报 accuracy 87.99% 与 F1 56.06% / BLEU-1 48.38%** —— **一个系统三套口径并存**，恰好证明「LoCoMo 上不同论文在报不同的东西」。
- **TRACE（X-5）**：**LoCoMo n=470**（不是全量 7512、也不是 LoCoMo-10 的 1986）⇒ **样本数也不同**。
- **MemX（C-5）**：**Hit@5 / MRR**（检索命中指标）+ 自建中文基准 43 问 ⇒ **与问答准确率不同量纲**。
- **Auto-Dreamer（B-3）**：**SR% / #Tok / AUC**（agent 任务成功率）⇒ **不同量纲**。
- **LoCoMo 版本本身有三套长度口径**（必须写明用哪个）：原论文 **每段 300 turns / 约 9K tokens / 最多 35 sessions**；**LoCoMo-10 发布版 = 10 段对话、1,986 QA**（样本内 19–32 sessions、369–689 turns）；另有工作给出「公开子集平均 **27.2 sessions / 20,000 tokens**」；**MIRIX 正文写的是「around 26,000 tokens on average」**。**MemoryAgentBench 表里另记 LoCoMo #Q=7512 / context depth 10k。**

### 4.3 MIRIX 85.38% / Letta 74.0% / Mem0 68.5% 的冲突（**照录不裁**）

| 系统 | 分数 | 出处 | 读到哪 |
|---|---|---|---|
| **MIRIX** | **85.38%**（摘要写 85.4%，正文写 85.38）overall accuracy，自称 SOTA、「outperforming the best existing method by 8.0%」 | arXiv 2507.07957（abs 页 + **HTML 全文**） | 摘要 + §1（含评测设置一段）；**§4.1 细节未读到** |
| **Letta Filesystem** | **74.0%** accuracy（gpt-4o-mini） | Letta 官方博客，2025-08-12 | **全文读到**（含 BRIEF 与各节） |
| **Mem0** | **68.5%**（「their top-performing graph variant」） | **由 Letta 博客引用（Mem0 自报）；Mem0 自己的协议文档未读到** | **二手引用** |

**三方协议差异（查到的部分，逐条）**：
1. **输入长度口径不一致**：MIRIX 正文说 LoCoMo「around **26,000 tokens** on average」，而 LoCoMo 原论文是 **≈9K**、LoCoMo-10 被记为 **≈20K** ⇒ **同一基准被三套长度口径引用**。
2. **信息可见性口径不一致**：**MIRIX 明确「constrain the Chat Agent to answer questions using only retrieved memories, without access to the original conversation transcripts」**；而 **Letta 是把完整对话史放进文件、由 agent 多轮工具检索后再答**。⇒ 一个「只准看记忆」，一个「能反复翻原文」。
3. **是否允许 agent 迭代查询**：**Letta 明确允许**（「Agents can generate their own queries rather than simply searching the original questions… they can continue searching until the right data is found」），并主张「**specialized memory tools that may have originally been designed for single-hop retrieval are less effective than simply allowing the agent to autonomously search**」⇒ **单跳检索式记忆系统与之不可直接比**。
4. **自主度/提示词不一**：Letta 自述 **gpt-4o-mini**、**「partially autonomous」**（tool rules 限制：必须先 `search_files`、反复搜、最后 `answer_question` 终止）、**「minimal prompt tuning」**；**MIRIX 未读到同级别的自主度描述**。
5. **judge 是否同一个：未读到**。LoCoMo 原生指标是 **token-F1 / BLEU-1**，但三家的「85.4 / 74.0 / 68.5」都是 **accuracy** 口径 ⇒ **必须假设走了 LLM-as-judge**（Mem0 评测脚本在 GitHub、DNS 拦未直读；**MIRIX 称 "following Mem0"**）。
6. **样本数：未读到**三家各自实际评测的样本数（LoCoMo 全量 7512 QA、LoCoMo-10 是 1986 QA 是**数据集事实**，不等于各家实际跑了多少）。Letta 博客未报样本数；MIRIX 未读到。

**Letta 对 Mem0 跑分口径的公开质疑（逐字照录，不裁定）**：
> 「One memory tool creator, **Mem0, published controversial results claiming to have run MemGPT on LoCoMo**. The results were puzzling, since our research team (**the same team behind MemGPT**) was unable to determine a way to backfill LoCoMo data into MemGPT/Letta without significant refactoring of the codebase. **Mem0 did not respond to requests for clarification on how the benchmarking numbers were computed, or provide any modified MemGPT implementation that supports meaningful backfill of LoCoMo data.**」

**Letta 的进一步主张（同样照录）**：「**current memory benchmarks may not be very meaningful**」；「**memory is more about how agents manage context than the exact retrieval mechanism used**」；「Comparing agent frameworks and agent memory tools is like comparing **apples to oranges**, as you can always mix and match frameworks and tools (and of course, models)」；并主张改用 **Letta Leaderboard**（固定框架与工具、只比模型）与 **Terminal-Bench** 这类需要记忆的长任务。**Letta 对 74.0% 的归因**：**agent 对文件系统工具的训练熟悉度**（"large due to post-training optimization for agentic coding tasks"）**而非记忆机制本身**。

**双方主张（不裁定）**：**Mem0 方**（经其分数被引用）主张其图变体在 LoCoMo 达 68.5%，且曾给出含 MemGPT 在内的对比；**Letta 方**主张 Mem0 的 MemGPT 跑分**无法复现/无法解释**，且简单文件系统（74.0%）已超过之 ⇒ 该榜区分度可疑；**MIRIX 方**主张 85.38% 为 SOTA，且是 **「following Mem0」** 的设置 ⇒ **MIRIX 与 Mem0 同源口径，而 Letta 与两者都不是同一口径**。

⚠️ **引用 74.0% 必须同时带 Letta 自己的 caveat**（原文要点，逐句）：① in isolation 评估极难；② quality **更多取决于 agentic system 管理上下文与调工具的能力**；③ 跨框架/工具比较 **like apples to oranges**；④ **Letta Leaderboard** 才是 apples-to-apples；⑤ 它点名质疑 **Mem0 的 MemGPT 跑分**且 Mem0 未回应。

**对我们的直接结论（写法，非裁定）**：**凡引用 LoCoMo 分数，必须同时写清 ① 用哪个 LoCoMo 版本 ② 是否允许读原文 ③ 是否允许多轮检索 ④ 用的什么 judge ⑤ 实际判分样本数。缺任一项即视为不可比。**

---

## §5 与我们现状的对照

> 来源：`research-arch.md` §4.3 / §11.1（该节明确标注「证据全部来自旧文档实测口径，本报告不重测」）。**本节只复述这些结论，不新增测量。**

**我们目前的形状（对照五条）**：
1. **星形拓扑**：`graph_nodes` **28 个，全部是 `concept`**；`graph_edges` **42 条（活跃 23）**；**中心 `用户` 的度 = 20**；**不含用户的活跃边 ≤ 2**。
2. **两套存储互不相通（记忆 ↔ 图无任何回指）**：这是**结构性**而非调参问题（`MEMORY_ARCHITECTURE.md` §三.4）。
3. **`node_type` 从未被写入** ⇒ `is_protected` 是**死代码** ⇒ **所有「按类型分支」的逻辑不可信**（旧文档 C5 已认「二者必有一错」）。
4. **`is_protected` 恒 0**（笔记里同时写作「恒 0 = 死代码」，并作为「空/无效」的证据）。
5. **图谱查询扩展在当前图结构下零增益、16 倍耗时**（`RETRIEVAL_RESEARCH.md` §七发现四，转引）。
6. **`load()` 只认边 + 单轮注入** ⇒ **我们没有任何「让 agent 自己迭代查」的通道**（这是**实现取向**，不是范式缺陷）。
7. **只做了「30 天剪枝」**（217 条 episodic 的现状）⇒ **缺少「选择性遗忘」这一档**。

**星形的成因（笔记给出的分两层，逐条）**：
- **属于「实现没做到」（可修，不必换范式）**：① `node_type` 从未写入（连带 `is_protected` 死代码）；② 记忆 ↔ 图无任何回指；③ **星形拓扑（度 20 的中心）⇒ 图谱扩展扩出的邻居词是无区分度的 `用户`/`<称呼>`⇒ 零增益是「数据形状」的必然，不是图范式本身的上限**；④ `load()` 只认边 + 单轮注入。
- **属于「范式限制」（把实现补好也拿不到）**：① **参数化的泛化拿不到**（WISE 的不可能三角：检索式工作记忆在 generalization 上先天弱）；② **更新/时间类问题在检索与排序层有硬上限**（旧文档 P3 + TRACE 关掉 **−10.17pp** + SAGE 反证 **KU 23.5 / TR 13.8 / MS 9.4** 而单会话类 60~81）⇒ **只能由写入侧编码**；③ **「检索机制」的边际收益在这个规模上会被「agent 会不会迭代用工具」盖过**（Letta 用文件 + grep/search 在 LoCoMo 拿 **74.0%**，高于 Mem0 自报的图变体 **68.5%**，并明说「memory is more about how agents manage context than the exact retrieval mechanism」）；④ **无界检索随深度退化**（P6，K 有峰值）、**压缩有损**（P5，存储召回 0.671）—— 属范式内禀。

**一句话总括（笔记原话）**：> **我们的短板里，「实现没做到」占多数且可修；唯一真正的范式级短板（参数化）在我们的硬约束下本来就不可行 —— 所以「换范式」不是当前最该做的事。**

⚠️ **两条「任务点名要求写、但四份笔记中未读到依据」的项（按规矩标注、不编）**：
- **「图侧时间列是死列」** —— **在四份笔记（`arch-A.md` / `arch-B.md` / `arch-C.md` / `research-arch.md`）中未找到该表述或其依据**。笔记里对「死列/死代码」的表述只涉及 **`node_type` 从未写入 ⇒ `is_protected` 是死代码**。**故本文件不对「图侧时间列」下结论。**
- **「星形成因三层」** —— 笔记给出的成因结构是**两层**（「实现没做到」4 条 + 「范式限制」4 条）。**「三层」这一分层表述在四份笔记中未读到**；本文件按笔记的两层如实呈现。

---

## §6 可选借鉴路线（供人类判断，**非本代理结论**；标注「参考」）

> **本节只写「借什么机制 / 代价 / 风险 / 是否需要推翻现有表结构」，不写实施步骤。** 以下判定素材来自四份笔记的适配判定（多为 `research-arch.md` §11.2/§11.3），**均标「参考」**，不代表本文档或任何代理的最终结论。

### R-1 写权分离 + 离线巩固（借 cat⑥：sleep-time compute / Letta / Auto-Dreamer）——【参考】

- **借什么机制**：把 **L0 核心 / 画像 / 图谱的「整理」写权从会话轮里摘出来**，交给**离线子代理**（我们已有 7 个一次性子代理通道）。照 **Auto-Dreamer** 四步：**① 把选定工作区当只读证据 → ② 检视条目及其 provenance 链 → ③ 合成一组紧凑替换集（跨会话抽象）→ ④ supersede 原区域（不删）**；照 **Letta** 的形状：**主代理不带 core memory 编辑工具**；触发用 Letta 的两种时机（`completed_steps % N == 0` 或 `context_compacted == true`）。
- **代价**：**整理频率越高 token 越多**；需要一个触发点；离线代理可用更强更慢的模型（Letta 的分档做法）。
- **风险**：★ **自主重写记忆** —— 若不留痕/不可回滚，就**同时违背「要能审计」与「任一否定必须留痕」** ⇒ **必须**「整理产物只增不删（supersede 而非 delete）+ 可回滚 + 留变更记录」。
- **是否需要推翻现有表结构**：**不需要**（纯增「整理记录 / 版本」即可，借 MemOS 的 **provenance + versioning** 形状）。

### R-2 文件为真源 + 记忆工具化（借 cat③：Basic Memory / Letta Filesystem / dsh-memory-eternal）——【参考】

- **借什么机制**：**记忆当人可读、可 git 版本化的文件**（SQLite 降为二级索引）；并把检索**暴露成 agent 可迭代调用的文件工具（`grep` / `open` / `search_files`）**，而不是继续强化单轮注入。先例：**`dsh-memory-eternal`（MIT，Markdown Vault + 自研去重 + 自研 CJK 检索 + 可 git 管理）**；方法先例：**Basic Memory（AGPL-3.0）**；效果先例：**Letta Filesystem**。
- **代价**：文件 ⇄ 数据库的**双向同步**（file-watcher + checksum）；语义检索仍需 embedding（或退回 **FTS5** —— 我们**已有 FTS5 先例**）。
- **风险**：**必须先定 SSOT**（文件为真相 还是 SQLite 为真相）；**Basic Memory 是 AGPL-3.0 ⇒ 只能借思路，不能 vendor 进仓库**。
- **是否需要推翻现有表结构**：**不需要（作为导出 / 审计视图纯增即可）**。⚠️ 但**若反过来让「文件成为 SSOT、SQLite 降级为索引」，那一步会动现状，必须单独裁决**。

### R-3 最小类型集 + 写入期强制（借 cat⑦：dsh-ontology / ontology-to-tools）——【参考】

- **借什么机制**：**ontology-to-tools 的洞见** —— 「**把约束编译成写入方必须调用的接口，让它在生成期生效而不是事后校验**」；落到我们（**唯一写入路径天然存在，因为我们控制代码**）：**写入函数里做校验 + 返回结构化拒绝**（拒绝时给「违反了哪条 + 允许取值」）；配套 **dsh-ontology** 的三件事：**`domain`/`range` 闭合 + 空列表=未约束（诚实编码「尚未决定」）**、**读时推导不落库 + `via` 字段**、**撤回的依赖保护**。
- **代价**：要一份**小而稳的 schema**；每次写入走一次工具/校验。
- **风险**：**schema 太紧会压扇出** —— 旧文档已踩过「槽位约束顶掉旧边」；且 `TBox` **需要人先写好**（模型不完整时合法断言会被拒）。
- **是否需要推翻现有表结构**：**不需要**（`ALTER TABLE ADD COLUMN` 的纯增先例已有：`aug_keys`）。**但要先修 `node_type` 真写入**，否则 schema 仍等于没写。

### R-4 记忆类型分栏 + 元数据契约（借 cat⑧/资源化：MIRIX 六类 / MemOS MemCube）——【参考】

- **借什么机制**：**六类记忆表 + 字段定义**（`core_blocks` / `episodic` / `semantic` / `procedural` / `resource` / `vault`）与 **MemCube 的三组属性**（`Origin Signature` 四值当 `source`、`Semantic Type` 三值当 `kind`、`Timestamp` 用于 lifecycle、`Lifespan Policy`、`Priority Level`、`Access Control`、`Compliance & Traceability`、`Version Chain`）；检索侧借 MIRIX 的 **Active Retrieval（先生成 current topic 再检索）+ 结果按来源打标签注入**。
- **代价**：写入侧要**多一次路由**（一次 LLM 调用或关键词规则），召回侧要**多类分别取 top-k**（可改成分数阈值）。
- **风险**：MIRIX 的 **8 个 agent ⇒ 大量 LLM 调用**（必须压成「一次路由 + 每类一次写入」）；MemOS 的 **Cross-Type Conversion 需要可写模型权重 ⇒ 整段不可用**；**六类在几百条规模上可能大量空转**。
- **是否需要推翻现有表结构**：**不需要**（纯增类型列或分栏表；`kind` 列即可承载四/六视图）。

### R-5 表示纪律：先拆 temporal / entity 视图（借 cat⑧：MAGMA / mnemon / TRACE）——【参考】

- **借什么机制**：**四张图（semantic / temporal / causal / entity）当四张边表** + **意图→边权权重表**；**TRACE 的有效性标记 `v(e)` + `updates` 边下调**；**mnemon 的 EI 公式（30 天半衰期 + 免疫规则）+ 软删 + oplog + 哈希回执**。论文立论直接命中我们的病：「现有方法大多依赖单一记忆库上的语义相似度，把 temporal / causal / entity 信息纠缠在一起」。
- **代价**：四套写路径（可合并成一张带 `edge_type` 的边表 + 部分索引）；一次巩固调用（慢通道可降级为**按需触发的进程内一次性任务**）。
- **风险**：**图质量依赖底层 LLM 的推理保真度**（抽取错误/幻觉沿图传播）；**slow path 只加边不删边 ⇒ 长期单调增边**（无遗忘）；**几百条规模上大概率空转**（笔记判定就写了这一条）。
- **是否需要推翻现有表结构**：**不需要**（边表纯增 `edge_type`/`confidence`/`source_run_id` 列即可）。

### R-6 遗忘/冻结的形状：冻结 ≠ 删除（借 cat⑦/生命周期：MemOS / mnemon / opencontext / Auto-Dreamer）——【参考】

- **借什么机制**：**`valid_from`/`valid_until` 两列 + `supersession`/`contradiction`/`merge` 一等边 + append-only 更正**；**MemOS 的 Time Machine 语义**（快照 + 历史回滚，**回滚走副本、权威冻结版本只读、不影响其审计链**）；**`Frozen`（禁写但全历史保留）**；**`Archived` = 长时间未访问 ⇒ 降级到冷存储（降级不是删除）**；**mnemon 的免疫规则**（高重要度或高频访问**永不自动删**）。
- **代价**：需要**保留期/剪枝阈值**等参数（mnemon 用 `MNEMON_MAX_INSIGHTS=1000` + `24h` 最小年龄；dsh-memory-eternal 用 **回收站 30 天**）；**离线整理必须留痕**，否则与审计冲突。
- **风险**：**Auto-Dreamer 式「旧条目不保留」不可接受**（无版本号、无 supersede 历史留档、无回滚实验 ⇒ 原区域内容替换后不保证可恢复，**与「要能审计」直接冲突**）；`is_protected` 若继续恒 0，「保护」仍是死代码。
- **是否需要推翻现有表结构**：**不需要**（两列时间戳 + 一个软删列 + 一张版本/oplog 表即可）。

---

## §7 未读到清单（四份笔记汇总、去重、标原因）

> 原因编码：**[GH]** = GitHub 被本机 DNS 拦（`github.com` / `raw.githubusercontent.com`；A 组前半程 raw 经桥可达、后半程本机 DNS 解析为 `::`）；**[402]** = 桥失效（`web_fetch` / `anysearch_search` / `web_search` 中途全部 **HTTP 402**；Firecrawl keyless 429）；**[50k]** = HTML 全文在 **50000 字符**处截断（`read_page` 上限；`web_fetch` 为 65536）；**[PDF]** = 本引擎**不吃 PDF**；**[预算]** = 预算取舍（主动放弃）。

| # | 未读到的东西 | 原因 |
|---|---|---|
| 1 | **MemoryOS 的任何实现文件与行号** | [GH] `api.github.com` / `cdn.jsdelivr.net` / `data.jsdelivr.com` 均 **422**；只成功取到 `raw.githubusercontent.com` 上的 LICENSE |
| 2 | **Letta `constants.py` / `agent.py` 的行号级内容** | **会话访问闸门**：已把 sdist 下到 `%TEMP%`，但后续从该路径读取的命令被拒（写工作区外路径），且**本会话审批提示已禁用、无法升级**；首次读取（`base.py` 全文）成功、后续被拒（**闸门不稳定**）⇒ 70%/100%/50% 阈值与 FIFO 递归摘要的口径**改由论文原文承担**（并标注 `e.g.`） |
| 3 | **PyPI 包本体解压到工作区外** | 同上（`New-Item`/`Copy-Item`/`Expand-Archive` 写 `%TEMP%` 被拒）；改用**内存内读取归档**（`python -c` + `zipfile`/`tarfile`）部分成功；**下载本身（`pip download`）被允许** |
| 4 | **MemOS §6.2 / §6.3 / §7**（Memory Retrieval 专项评测、KV-Based Memory Acceleration、应用场景） | [402] + [预算]：桥在取回 §3.1 后即 402 失效；虽改用本机直连补取 §4/§5/§6.1，但**未对 §6.2 之后再抓一次** |
| 4b | **MemOS 的常驻服务/图库/向量库依赖清单、token/延迟数字** | 因 §6.2/§6.3 未读 ⇒ 其**纯文本路径的实际成本无法判定** |
| 4c | **MemTensor/MemOS 的 `deepseek-harness` 插件本体** | [预算]：商店搜索命中该条目但**未打开详情页**（时间分配给了 `dsh-memory-eternal`）⇒「35.24% token savings / DSH 支持」**只到商店摘要级** |
| 5 | **Basic Memory 的 LICENSE 文件本体与源码** | [402]：`raw.githubusercontent.com/.../LICENSE` 与 `.../LICENSE.md` 均 **HTTP 422** ⇒ 许可**改由官方文档页 Licensing 章节承担** |
| 6 | **`dsh-memory-eternal` 的实现源码** | [GH]（商店 README 全文已读；**许可已用 `npm view` 独立复核为 MIT**） |
| 6b | **honcho 的许可名与 benchmark 数字** | [预算]：商店页有 "License" 目录项但未落入截取的文本前 4500 字内，未再抓一次；benchmark 只有 "Pareto Frontier" 这类自述、**无数字** |
| 7 | **`dsh-memory`（灵枢）/ `opencontext` / `dsh-memory-eternal` 的源码与行号** | [GH]：只读到商店 README 投影（页面渲染后的文本）；灵枢的**行号锚点来自 README 表格的转述，未验证** |
| 8 | **`memsearch(zilliztech)` 的「记忆工具化」做法** | [预算]：任务标注「有余力」，预算已用于补齐 MemOS §4–§6.1 与 `dsh-memory-eternal`；**honcho 已完成部分覆盖** |
| 9 | **各家 LoCoMo 数字的严格可比性** | **不可得** —— 四家口径不同（Letta 单一准确率 / MemoryOS F1+BLEU-1 / MemOS LLM-Judge / opencontext 自评 harness）。**这是结论，不是缺口** |
| 10 | **MAGMA 源码与代码仓库许可**；参考文献段 | [GH] + 论文 HTML 参考文献段被截断 |
| 11 | **sleep-time-compute 与 Auto-Dreamer 的代码许可 / 仓库内容** | [GH]（Auto-Dreamer 的**论文未给出**仓库） |
| 12 | **Auto-Dreamer 的 writer prompt 与工具接口（Appendix B/E）正文**；**训练成本（GPU 小时）**；**LLM 调用次数** | 附录只在正文被引用、内容未取到；训练成本论文未给 |
| 13 | **MIRIX Figure 1–7 的图内细节；§4.1 评测细节（样本数、judge、LoCoMo 版本）** | [PDF]（图片/PDF 不吃）+ [50k]（HTML 全文截断未覆盖到 §4） |
| 14 | **MemoryAgentBench 各数据集题数细分（附录 B）** | [50k] |
| 15 | **WISE §2.3.2、§3、§5 Limitations 正文**；**MemoryLLM §4 实验表、§3.3 Model Instantiation 细节** | [50k] |
| 16 | **GraphRAG-Bench 的 Method / 规模明细（题数、教材清单）**；**综述 2509.18868 的 50 页正文与 DMM-Gov 细节** | 仅读到 **abs 页** |
| 17 | **ontology-to-tools §4 评测数字、§6 各小节正文** | [50k]（只读到 §1–§3 + §6 标题级） |
| 18 | **HyperSU §5 Experiments 正文数字、§5.5 墙钟/单查询成本、附录 C.3 超参值、Evidence Projection 后半** | [50k] + §4.2 末尾被截断 |
| 19 | **Generative Agents §4.2 Reflection 正文（触发时机、摘要层级、insight 生成与证据引用）**；检索三信号的公式 | [50k] / 65536 上限；ar5iv 与 arxiv-vanity 走同一份渲染、同样截断；[PDF] |
| 20 | **Navet 2026 的任何一手材料** | [402]（`web_search` / `anysearch_search` 均 402）+ [GH] + 商店搜 "navet" 0 命中 ⇒ **只有 HAL 链接与 CC BY 4.0 许可（可核）** |
| 21 | **Mem0 的官方 LoCoMo 协议与 68.5% 的一手文档**；**Mem0 评测脚本**；MIRIX 的 judge/样本数细节 | [GH]（评测脚本在 GitHub）；68.5% 目前**只有 Letta 博客的二手引用**；issue `mem0ai/mem0#3004` 与相关 Reddit 帖未直读 |
| 22 | **三家（MIRIX / Letta / Mem0）各自实际评测的样本数与 judge 细节** | 未读到；Letta 博客未报样本数 |
| 23 | **Mem0 / Memobase / Supermemory 的官方 token / 延迟数字** | 未找到可引用的一手数字（Memobase 仅有 README 主张 `<100ms`） |
| 24 | **`dsh-ontology` 源码、测试正文；ABox 是否落在 SQLite** | [GH]（只有商店 README）；存储层现状**未读到** |
| 25 | **mnemon 的 Go 源码正文** | [GH]（走 pkg.go.dev + jsDelivr 拿到 README 与 `docs/design/*.md`，**无 `文件:行`**） |
| 26 | **`dsh-memory-eternal` 的去重 / CJK 检索实现细节** | [GH]（npm 元数据不给实现） |
| 27 | **TRACE / HERO / EAR 的 GitHub 仓库与许可** | [GH]（C 组四篇的正文取自本地已取回的同批 arXiv 全文；**仓库一律未直读**） |
| 28 | **任何 PDF 版内容** | [PDF] |
| 29 | **B 组工具侧连带损失**：`web_fetch`/`web_search`/`anysearch_*` 全部 402；`pwsh` 联网 / 写工作区外路径被拒；`read_page` 是唯一可用通道（**截断 50000 字符，无 LLM 综合**） | [402] + 会话闸门 |

**GitHub 内容的可行替代路径（B 组本轮已验证，供后续代理复用）**：① **pkg.go.dev** 读 Go 项目 README；② **`data.jsdelivr.com/v1/packages/gh/<owner>/<repo>[@ver]`** 拿完整文件树 + 每文件字节数；③ **`cdn.jsdelivr.net/gh/<owner>/<repo>@<ver>/<path>`** 直出仓库内任意文本文件正文；④ **DSH 插件商店 `dsh.deepseek404.com`**（`index.php?q=` 搜索、`detail.php?id=<owner>%2F<repo>` 给 README 全文 + LICENSE/语言/stars/最后推送）。**A 组的教训**：**不要假设工具通道全程可用**；桥失效时**先测本机直连**（`curl.exe -o NUL -w "%{http_code}"`），它比桥更稳，只是**拿不到 GitHub**。

---

## §8 来源与文档状态

- **本文件性质**：**调研汇总**。它把四份调研笔记（`arch-A.md` / `arch-B.md` / `arch-C.md` / `research-arch.md`）汇总成一份人类可读文档，**不代表任何代码已改动**；**没有任何代码 / config / tests / 既有笔记被修改**；**没有 commit**；**没有重启 host**。
- **与 `docs/PLAN_MEMORY_GRAPH.md` 的关系**：**兄弟文档** —— **那份讲「我们的计划」，这份讲「别人的做法」**。`research-arch.md` 自身也引用了 `PLAN_MEMORY_GRAPH.md` §3.5/§8.3 与一批旧文档（`MEMORY_PRINCIPLES.md` / `RETRIEVAL_ARCH_NOTES.md` / `RETRIEVAL_RESEARCH.md` / `REFERENCE_ANALYSIS.md` / `research-edges.md` / `research-oss.md` / `research-spread.md` / `MEMORY_ARCHITECTURE.md` / `MEMORY_EVAL_PROTOCOL.md` / `DISCIPLINE.md`），本文件对它们的引用**一律是转引**（即「笔记说旧文档这么说」），**未回读旧文档本体**。
- **素材范围**：本文件**未新增任何外部检索**（桥 402、GitHub 被拦，检索不可靠）—— **一律以四份笔记为准**。凡笔记标注「转述未验证」之处（尤其 **灵枢的行号锚点**、**Navet 2026 的 §10 表内容**），本文件**同样标注**。
- **数字纪律**：所有数字/引用/行号**均来自四份笔记**；凡本文件出现但笔记中没有的表述，已在 §5 明确标出（「图侧时间列是死列」「星形成因三层」两条）。
- **文件编码与自检**：UTF-8 无 BOM（由 `write`/`edit` 工具写入；未使用 PowerShell `Set-Content`）。**前 3 字节自检结果见下方「BOM 自检」段。**
- **生成时间**：2026-10-01。

### BOM 自检

由汇总代理在写完后用 `[System.IO.File]::ReadAllBytes()` 读取本文件**前 3 字节**并核对**不是** `EF BB BF`，结果：

执行命令（PowerShell）：`$p='$env:USERPROFILE\.dsh\plugins\dsh-echo\docs\MEMORY_ARCH_SURVEY.md'; $b=[System.IO.File]::ReadAllBytes($p); (($b[0..2] | % { $_.ToString('X2') }) -join ' ')`

**实测输出**：`first3 = 23 20 E8`；`isBOM = False`；`lines = 765`；`bytes = 238340`

⇒ **前 3 字节为 `23 20 E8`（即 `#`、空格、UTF-8 汉字首字节），不是 `EF BB BF` ⇒ 本文件为 UTF-8 无 BOM，自检通过。**






