# ACKNOWLEDGMENTS

感谢下列开源项目与学术研究。实际随源码分发的第三方代码及许可见 [THIRD_PARTY.md](THIRD_PARTY.md)。表中的出处用于说明设计脉络，部分早期资料不随发布树分发。

## 1. 开源项目

| 名称 | 引用方式 / 用在哪 | 出处(相对路径:行号) |
|---|---|---|
| `0xedgelessblade/contextual-neural-map` | 列在参考资料里 | `CHANGELOG.md:1844` |
| `getzep/graphiti`(Zep) | 临时知识图、边失效、双时态;`docs/ASSOC_GRAPH_SURVEY.md:88` 列为对标的图记忆代表 | `docs/ASSOC_GRAPH_SURVEY.md:88`、`:460`(版本 0.30.2 / Apache-2.0) |
| `agiresearch/A-mem` | Zettelkasten 式链接生成 + 记忆演化;"参考不抄"(与已有图 + 谓词归并同题) | `docs/ASSOC_GRAPH_SURVEY.md:89`、`docs/RETRIEVAL_RESEARCH.md:112`、`docs/PLAN_MEMORY_GRAPH.md:438` |
| `microsoft/graphrag` | Leiden 层级社群 + 社群报告(对标) | `docs/ASSOC_GRAPH_SURVEY.md:90` |
| `HKUDS/LightRAG` | 双级检索、增量更新、对社群法成本的批评 | `docs/ASSOC_GRAPH_SURVEY.md:91`、`docs/PLAN_MEMORY_GRAPH.md:460`(1.5.7 / MIT) |
| `OSU-NLP-Group/HippoRAG`(HippoRAG / HippoRAG 2) | OpenIE + 同义词边 + PPR | `docs/ASSOC_GRAPH_SURVEY.md:92`、`docs/PLAN_MEMORY_GRAPH.md:460`(2.0.0a4 / MIT) |
| `mem0ai/mem0`(Mem0) | ADD/UPDATE/DELETE/NOOP 冲突解决;整合(去重/换代)同题,**参考不抄**(已方留档语义更严) | `docs/ASSOC_GRAPH_SURVEY.md:93`、`docs/RETRIEVAL_RESEARCH.md:114`、`docs/MEMORY_ARCH_SURVEY.md:350`(2.2.1 / Apache-2.0)、`:460` |
| `LHRLAB/HyperGraphRAG` | n 元超边 + 双向扩展 | `docs/ASSOC_GRAPH_SURVEY.md:94` |
| `BAI-LAB/MemoryOS` | 记忆操作系统,论文 + 代码(代码 Apache-2.0,已核) | `docs/MEMORY_ARCH_SURVEY.md:90`、`docs/PLAN_MEMORY_GRAPH.md:444` |
| `letta-ai/letta`(Letta / MemGPT 发行版) | 记忆与 dreaming(`rethink_memory` / `finish_rethinking` 工具已解码);Apache-2.0 | `docs/MEMORY_ARCH_SURVEY.md:120`、`:105`(MemGPT) |
| `letta-ai/sleep-time-compute` | Sleep-time Compute 的官方实现(附录 F 给出最终代码) | `docs/MEMORY_ARCH_SURVEY.md:243` |
| `letta-ai/letta-leaderboard` | 基准代码(LoCoMo 基准脚本全读) | `docs/MEMORY_ARCH_SURVEY.md:120` |
| `MemTensor/MemOS` | 记忆操作系统,论文 + 代码(Apache-2.0 已核) | `docs/MEMORY_ARCH_SURVEY.md:150` |
| `basicmachines-co/basic-memory` | Files as Source of Truth、混合检索公式、wikilink 解析;**AGPL-3.0**(许可从官方文档页读到) | `docs/MEMORY_ARCH_SURVEY.md:166` |
| `FredJiang0324/MAGMA` | 多图 agentic 记忆架构(ACL 2026) | `docs/MEMORY_ARCH_SURVEY.md:228` |
| `Mirix-AI/MIRIX` | 六类记忆字段定义 + Active Retrieval | `docs/MEMORY_ARCH_SURVEY.md:273` |
| `wangyu-ustc/MemoryLLM` | 自更新大模型记忆池 + 遗忘分析 | `docs/MEMORY_ARCH_SURVEY.md:381` |
| `zjunlp/EasyEdit` | WISE 的代码并入该仓(知识记忆 / 终生编辑) | `docs/MEMORY_ARCH_SURVEY.md:396` |
| `plastic-labs/honcho` | 商店在售的 DSH 记忆插件(对标) | `docs/MEMORY_ARCH_SURVEY.md:434` |
| `supermemoryai/python-sdk` | 官方 Python SDK(仅客户端;服务端不在包内) | `docs/MEMORY_ARCH_SURVEY.md:449` |
| `memodb-io/memobase` | 客户端本体源码全读(Apache-2.0) | `docs/MEMORY_ARCH_SURVEY.md:366` |
| `mem0ai` / `Cognee` / `Graphiti` 等版本清单 | 版本 + 许可对照表 | `docs/PLAN_MEMORY_GRAPH.md:460` |
| `xiaowu0162/LongMemEval` | 长对话记忆基准(借它的题型自建小型金标,**不引依赖**) | `docs/MEMORY_EVAL_PROTOCOL.md:6,160`、`docs/RETRIEVAL_RESEARCH.md:116` |
| `joonspk-research/generative_agents` | Generative Agents(memory stream / reflection 高层描述;未读到源码) | `docs/MEMORY_ARCH_SURVEY.md:519`、`docs/PLAN_MEMORY_GRAPH.md:445` |
| `FuRongJun-1999/dsh-memory` | 商店在售的同生态记忆插件(行号系其 README 转述,**未验证**) | `docs/MEMORY_ARCH_SURVEY.md:181` |
| `melandlabs/opencontext` | 商店在售的同生态插件(Apache-2.0 自述) | `docs/MEMORY_ARCH_SURVEY.md:196` |
| `EternalNight996/dsh-memory-eternal` | 商店在售的同生态插件(MIT,经 npm 元数据复核) | `docs/MEMORY_ARCH_SURVEY.md:211` |
| `cheesehaqi/dsh-qq-onebot-bridge` | **整块代码借用**(不是"参考思路"):`lib/onebot.js` 借自其 v0.5.7,MIT,已 DIY 改动 | `docs/QQ_BRIDGE_DIY_PLAN.md:149`、`LICENSE` 末段 |
| `wu81313-lab/dsh-company-kb` | 离线知识库(15 条金标同思路) | `docs/RETRIEVAL_RESEARCH.md:62` |
| `NousResearch/hermes-agent` | 其 `hermes_state_fts.py` 作 FTS 参照 | `docs/RETRIEVAL_RESEARCH.md:79` |
| `xybruceliu/thoughtful-agents` | **借鉴其评估层**,不抄其念头生成层 | `docs/PLAN_PROACTIVE_TOPIC_SCORER.md:193` |
| `defilantech/LLMKube` / `NousResearch/hermes-agent` issue | 全量重新 prefill 的实例(证据引用) | `archive/docs/RELAY_PLAN.md:289-290` |
| `dsh-interpersonal-circumplex`(队友插件,**MIT**) | **整目录代码副本**(不是"参考思路"):`core/` 8 个 `.js` 复制进 `lib/ipc-core/`,上游 `LICENSE` 原样带走;只读、不改动,升级整目录覆盖 | `lib/ipc-core/README.md:1-38`、`ACKNOWLEDGMENTS.md` 本节、`LICENSE` 末段 |

## 2. 学术文献

| 文献 | 主题 / 用在 | 出处 |
|---|---|---|
| Zep / Graphiti — arXiv 2501.13956 | 临时知识图、边失效、双时态 | `docs/ASSOC_GRAPH_SURVEY.md:88` |
| A-MEM — arXiv 2502.12110(NeurIPS 2025) | Zettelkasten 式链接生成 + 记忆演化 | `docs/ASSOC_GRAPH_SURVEY.md:89`、`docs/PLAN_MEMORY_GRAPH.md:438` |
| GraphRAG — arXiv 2404.16130 | Leiden 层级社群 + 社群报告 | `docs/ASSOC_GRAPH_SURVEY.md:90` |
| LightRAG — arXiv 2410.05779 | 双级检索、增量更新 | `docs/ASSOC_GRAPH_SURVEY.md:91` |
| HippoRAG — arXiv 2405.14831;HippoRAG 2 — arXiv 2502.14802 | OpenIE + 同义词边 + PPR | `docs/ASSOC_GRAPH_SURVEY.md:92` |
| Mem0 — arXiv 2504.19413 | ADD/UPDATE/DELETE/NOOP 冲突解决 | `docs/ASSOC_GRAPH_SURVEY.md:93`、`docs/RETRIEVAL_RESEARCH.md:114` |
| HyperGraphRAG — arXiv 2503.21322 | n 元超边 + 双向扩展 | `docs/ASSOC_GRAPH_SURVEY.md:94` |
| MemoryOS — arXiv 2506.06326 | 记忆操作系统(Kang, Ji, Zhao, Bai) | `docs/MEMORY_ARCH_SURVEY.md:90`、`docs/PLAN_MEMORY_GRAPH.md:444` |
| MemGPT — arXiv 2310.08560(Packer et al., UC Berkeley) | 分层记忆 + 自管理 | `docs/MEMORY_ARCH_SURVEY.md:105`、`docs/PLAN_MEMORY_GRAPH.md:443` |
| Sleep-time Compute — arXiv 2504.13171v1(Kevin Lin et al.) | 离线"睡眠期"计算 | `docs/MEMORY_ARCH_SURVEY.md:243` |
| MemOS — arXiv 2507.03724(v4 2025-12-03) | 记忆操作系统(训练/推理双阶段) | `docs/MEMORY_ARCH_SURVEY.md:150` |
| MAGMA — arXiv 2601.03236v2(ACL 2026 Main) | 多图 agentic 记忆架构 | `docs/MEMORY_ARCH_SURVEY.md:228` |
| MIRIX — arXiv 2507.07957v1 | 六类记忆 + 多智能体工作流 | `docs/MEMORY_ARCH_SURVEY.md:273` |
| MemoryLLM — arXiv 2402.04624v2 | 自更新记忆池 + 遗忘分析 | `docs/MEMORY_ARCH_SURVEY.md:381` |
| WISE — arXiv 2405.14768(NeurIPS 2024) | 终生模型编辑的知识记忆 | `docs/MEMORY_ARCH_SURVEY.md:396` |
| Generative Agents — arXiv 2304.03442v2(UIST '23) | memory stream / reflection / retrieval | `docs/MEMORY_ARCH_SURVEY.md:519`、`docs/PLAN_MEMORY_GRAPH.md:445` |
| LongMemEval — arXiv 2410.10813(ICLR 2025) | 长对话记忆基准 | `docs/MEMORY_EVAL_PROTOCOL.md:159-160` |
| LoCoMo — arXiv 2402.17753 | 长对话记忆基准 | `docs/MEMORY_EVAL_PROTOCOL.md:161`、`docs/RETRIEVAL_RESEARCH.md:116` |
| Inner Thoughts — CHI 2025 / arXiv 2501.00383 / DOI 10.1145/3706598.3713760 | 主动开口五阶段;借鉴**评估层** | `docs/PLAN_PROACTIVE_TOPIC_SCORER.md:11,193` |
| AriGraph — arXiv 2407.04363 | 图记忆 | `docs/PLAN_MEMORY_GRAPH.md:439` |
| Graph-based Agent Memory 综述 — arXiv 2602.05665 | 综述 | `docs/PLAN_MEMORY_GRAPH.md:440` |
| HyperSU — arXiv 2606.28351 | 图记忆 | `docs/PLAN_MEMORY_GRAPH.md:441` |
| StructMem — arXiv 2604.21748(ACL 2026 main) | 结构化记忆 | `docs/PLAN_MEMORY_GRAPH.md:442` |
| MemX — arXiv 2603.16171 | 向量 + FTS5 双召回 → RRF → 四因子重排;local-first 最贴 | `docs/RETRIEVAL_ARCH_NOTES.md:24` |
| ConvMemory v2 — arXiv 2606.10842 | 召回保全级联 | `docs/RETRIEVAL_ARCH_NOTES.md:25` |
| Training-Free Lexical-Dense Fusion — arXiv 2606.04194 | 分数级融合(复现"重排是负的") | `docs/RETRIEVAL_ARCH_NOTES.md:26` |
| Chronos — arXiv 2603.16862 | 事件日历 / 轮次日历 | `docs/RETRIEVAL_ARCH_NOTES.md:27` |
| ENGRAM — arXiv 2511.12960 | 记忆类型化 + 集合运算合并 | `docs/RETRIEVAL_ARCH_NOTES.md:28` |
| MemConflict — arXiv 2605.20926 | 答案正确率与检索排序脱钩 | `docs/RETRIEVAL_ARCH_NOTES.md:29` |
| Structural Memory of LLM Agents — arXiv 2412.15266 | 四结构 × 三检索(迭代胜出) | `docs/RETRIEVAL_ARCH_NOTES.md:30` |
| MemGAS — arXiv 2505.19549 | 多粒度 + 熵路由 | `docs/RETRIEVAL_ARCH_NOTES.md:31` |
| MemReranker — arXiv 2605.06132 | 记忆专用重排的三个病 | `docs/RETRIEVAL_ARCH_NOTES.md:33` |
| Yik & Russell 2004 — *Multivariate Behavioral Research* 39(2):203–230,doi 10.1207/s15327906mbr3902_4 | **情绪空间融合的共享轴唯一依据**:两个环形模型实测只重叠**一条轴**(情感环侧 35°、IPC 侧 71°,N=395;Browne CIRCUM-extension)。它同时是本文档"不可等价"结论的证据源 | `lib/emotion-space.js:16-41`、`lib/space-bridge.js`(θs/θs_ipc 默认值)、`docs/EMOTION_SPACE.md` |
| Yik 2010(replication) | 复现同样的 37° / 76° —— 说明那两个角不是抽样偶然 | `docs/EMOTION_SPACE.md` |
| Mehrabian 1996 — *Australian Journal of Psychology* 48(2):86–92,doi 10.1080/00049539608259510 | PAD 三维与 IPC 两维的**因子层**关系(正向 5 条 OLS + 反向 3 条 OLS,**不是代数互逆**)⇒ 双向双射不可能;λs/λd 这类标定参数的"该不该有"由此而来 | `docs/EMOTION_SPACE.md`、`lib/space-bridge.js`([工程假设] 标注) |
| Mehrabian 1995 — *The Journal of Psychology* 129(5):565–581,doi 10.1080/00223980.1995.9914929,PMID 7473304 | 公共因子需**三个**(pleasantness / dominance / arousability)⇒ 3 维 vs 2 维,维数上就否掉了双射 | `docs/EMOTION_SPACE.md` |
| McCrae & Costa 1989 — *JPSP* 56:586–595 | IPC 平面更接近 **E × A(外向性 × 宜人性)** 而非 P×D(与 Yik & Russell 2004 注 2 的 ≈23.5° 旋转一致)—— 这条是"别把两套坐标当同一个"的旁证 | `docs/EMOTION_SPACE.md` |
| Russell 1980(affect circumplex)/ Russell & Mehrabian 1977(PAD) | 情感环本身是 **P×A 二维**,`D` 是 PAD 第三个因子才出现的 —— 本仓的 `dominance` 因此只登记、不渲染 | `lib/emotion.js:31-45`、`docs/EMOTION_SPACE.md`(登记未渲染) |
