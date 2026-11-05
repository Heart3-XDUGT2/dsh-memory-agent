# ACKNOWLEDGMENTS

Echo(`dsh-memory-agent`)站在这些项目、论文与笔记上。下面分四段:**1.** 开源项目(代表条目) ·
**2.** 学术文献(代表条目) · **3.** 引用位置索引(全量:哪一行提过谁) · **4.** 方法与口径。

> 索引里的行号指本仓文件的当前形态;`CHANGELOG.md` 一栏指本地全量档 `archive/CHANGELOG_FULL.md`
> (公开版 `CHANGELOG.md` 是同一段落的切片,段落标题一致)。同一来源在多处出现**未合并去重**。

---
# REFERENCES(草案)

> 本文件由**只读扫描**抽取而成:全仓(代码注释 / docs / 根文档 / CHANGELOG)里"参考过谁、受谁启发、借了谁的算法"
> 的痕迹,汇总成一份独立引用清单。**不含真实聊天引文、不含真名、不含绝对路径、不含账号/token。**
>
> 扫描方式:关键词(参考 / 借鉴 / 引用 / 致谢 / 受…启发 / 来源 / 出处 / based on / inspired by / see also / 移植 / 借自)
> + 链接形态(`github.com/owner/repo`、arXiv 号、HF/DOI)。**增量落盘**:每扫完一个文件/一段就把条目追加进来,
> 随时中断都不会半成品报废。

**状态:首遍种子已入(下表);四个分段扫描(R1 CHANGELOG / R2 docs+根文档 / R3 代码注释 / R4 CHANGELOG 三分类)
正在追加各自的 `_refs/*.md`,到齐后合并进下面三节。**

---

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

## 3. 引用位置索引(全量,按文件 · 行号)

> 三段来源:**CHANGELOG.md 行内引用**(掩码后逐行)、**docs/ + archive/ + 根文档**(R2:393 条)、**代码注释**(R3:212 条)。
> 同一来源在多处出现**未做合并去重** —— 代表条目见上面 §1/§2;这一节要的是"哪一行提过谁"的完整索引。

### 3.1 CHANGELOG.md(114 行,掩码;行号指本地全量档 `archive/CHANGELOG_FULL.md` —— 公开版 CHANGELOG.md 是同一段落的切片)

# CHANGELOG.md 的引用/致谢行(掩码后逐行)

> 规则:只取命中「参考/借鉴/引用/致谢/启发/来源/出处/借用/移植/借自」的**行内引用半边**;
> 对话引文(`「…」`/引号段)掩成 `[…]`,真称呼/账号/节点/话题/地点掩成 `[称呼]` 之类;每行截 70 字。
> 共 114 行。纯行号分布见 `CHANGELOG-三分类分析.md` §3.1。

| 行号 | 行(掩码) |
|---|---|
| L156 | - **来源保底**:每个来源(悬置话题 / 记忆 / 日记)先保底 `sourceFloor` 条进池,余下席位按分数 |
| L197 | **只读、不落库、不加列**;启发式判据与数据局限(`conversation_log` 是 100 行滚动窗)**写在 |
| L215 | **第四批:P4a —— 她的自由活动(空闲触发 + 产出落盘 + `note:` 候选来源)(2026-09-30)** |
| L235 | - **第四类候选来源 `lib/topic-score.js`**:`collectCandidates({ activityDir })… |
| L236 | id 前缀 `note:`、`source:'self-activity'`(`scoreTopic` 跟着把来源透出来,便于事后查[…])… |
| L237 | `hasArtifact:true`;来源排在**最后** ⇒ `floor=0` 时前三类逐条不变;目录没给 / 不存在 / |
| L356 | - **左栏 = 索引**:固定行高 34px、**永远单行**、溢出省略号(`时间 · 类别点 · 来源 · |
| L364 | - **顺手松开的**:统计带分[…]两组带小标题与竖分隔(原是一条长龙挤两行)、 |
| L392 | - **来源看工具不看会话**:裁定 A 之后 QQ 的话会被路由进他正开着的 DSH 会话 |
| L394 | 恰恰把最要紧的事实说反。所以桥自己写的工具 ⇒ 来源 QQ,其余才按会话判。 |
| L400 | 人话标签/时间/来源 + 两条不变量[…]);`tests/web-dashboard.test.js` |
| L469 | `python/engine/db.py:_repair_dangling_superseded` 只清 `-1` 引用、**不复活 |
| L568 | 引用 + 两处过时注释一起摘掉,client.js 807 → 731 行。 |
| L678 | ### C5 开口前的过期失效检查(出处 Mio `proactive_service.py:588-592`) |
| L700 | ### C2 思考风格双档(出处 `dsh-cosplay` 的 `THINKING_DIRECTIVES`,`store.js:142-1… |
| L711 | ### C1 情绪单轮闭环(出处 pad-emotion `index.js:833-846`,异步 waterfall + `Promis… |
| L729 | - ⚠️ **`npm run check` 抓到的第二个真问题**(值得记):状态面我一度直接引用 `apply` 里的 |
| L736 | 出处:计划 §3.5 第一步;**直接吃 RT10 的教训** —— RT10 量出[…]是负的(N5 矛盾 |
| L743 | 来源**零依赖、且不是我自己造的**:库里的 `graph_aliases`(**13 行真数据**,他图谱合并的产物: |
| L809 | ### C4 话题去重惩罚(第一刀:纯惩罚器 + 单测)· 出处:Mio `:379-432` |
| L868 | 出处/依据:计划 §3.2。动机:**48 条金标全是我手造的题**,缺真机上[…]的样本 |
| L889 | 出处:roleplay `prompts.ts:52-110`(三段:防抢话 `antiRobberySection`、防重复 |
| L923 | 出处 roleplay `presets.ts:129-145`。这份 preset 是**他的人格资产**（`agent.cordis.y… |
| L948 | **F1 外部事件入口**（`lib/external-event.js` + `POST /api/echo/event`，出处 aura… |
| L962 | **F2 日记缺口补写 + 指数退避**（`lib/diary.js` + `lib/index.js` 日记拍子，出处 Mio `dail… |
| L1099 | - 测试:`tests/tool-audit.test.js` 12 条(截断/循环引用/三态结果/原样交回 next()/ |
| L1433 | 173 条现役记忆该列全空),不引用不迁移不 DROP —— 体检脚本改报 |
| L1455 | - `PLUGIN_ENVELOPE`[…]信封正则删除 —— 定义后从未被引用的 |
| L1533 | - 开关的**来源**可追问:谁拨的(面板/工具/她自己)、什么时候 —— `poweredBy/poweredAt`、 |
| L1662 | 节点名加了底色描边(压在边上也读得清)。以前 17 个名字全挂着,是[…]的一半来源。 |
| L1763 | ### 他说[…](第四次) |
| L1817 | 参数改不动这个 —— 这是**零件问题**,不是数值问题。三处[…]的来源,逐个换成有连续性的做法: |
| L1819 | | 拼凑感来源 | 改法 | |
| L1864 | | 项 | 我原来 | 现在(参考值) | |
| L1866 | | 节点半径 | 11 ~ 23px 大实心圆 | **4.5 ~ 13px** 的点(参考 4~20px,多数 5.5~10px) | |
| L1867 | | 线宽 | 1.2 ~ 4.8px | **0.6 ~ 1.5px** 发丝(参考 0.5/1.2/1.8) | |
| L1869 | | 状态区分 | 靠颜色 | 清醒实线 / 模糊 `6,5` / 遗忘 `2.5,3.5` 虚线(参考的做法) | |
| L1873 | | 投影 | 所有节点都挂 | 去掉(参考只给高权重节点柔影;全挂就成一串珠子) | |
| L2175 | 移植缺口审计里剩下的三个小缺口 + 一处文档与实现不一致。没有新机制, |
| L2235 | 移植缺口审计里 E5 那一行(出处:A `main.py:1382-1479`)。此前 B 侧的审计 |
| L2294 | 移植缺口审计里 D1 那一行(出处:03 号设计文档)。此前压缩走的是宿主 stock |
| L2380 | 移植缺口审计里 D2 那一行(出处:04 号施工图 §1/§2):轮将停时要检查 |
| L2400 | ### 挂点纪律(照参考实现的血泪,它自己的注释原文) |
| L2417 | (壳里没捕 `tool/call`);[…]是**词面启发式**(想你/想[称呼]/挂念/惦记/ |
| L2557 | | # | 补什么 | A 侧出处 | B 侧落点 | |
| L2560 | | 2 | **[…]话头行**:`[上次聊到] {话题}(仅供参考,别当开场锚)`,话题**优先取最新反思信念**(带证据的跨轮归纳),只… |
| L2599 | > 她的回复中位数 123 字,用户 12 字 —— 体量差 10 倍,一大段就是 AI 感的来源。 |
| L2605 | ### 补(六处,全部按 A 侧逐字移植) |
| L2607 | | # | 补什么 | A 侧出处 | B 侧落点 | |
| L2750 | 判据不是[…],而是**引用**(零引用 ≠ 一定死:测试是通配发现的、入口本来就 |
| L2755 | | **归档** `docs/` 9 份 → `archive/docs/` | PORT_FIX_PLAN / PORT_GAP_AUDI… |
| L2756 | | **归档** `scripts/` 4 个 → `archive/scripts/` | diff_retrieve.py / smok… |
| L2758 | | **删** | `lib/relay.js` 的 `RELAY_KINDS` | 全仓除自己那行外零引用(三类 kind 实际是散在各调… |
| L2765 | (都被活着的脚本或代码引用)、`DEFENSE.md`(答辩材料)。 |
| L2768 | 1. `scripts/hygiene.mjs` + `npm run hygiene` —— 报告「没人引用的 import / lib … |
| L2769 | 导出 / 工作区垃圾 / 没人引用的文档」;**故意不判死**(exit 0),因为卫生阈值 |
| L2772 | 3. `docs/README.md` —— docs 索引:哪几份是[…],哪几份是参考。 |
| L2825 | 而 `lib/index.js` 那处判断写的是[…]—— |
| L2889 | […]。 |
| L2894 | | 来源 | 条数 | 字数 | 占比 | |
| L3027 | 语法,[…]它看不出来,而那种错的形态是**他打开设置页整页白屏**。 |
| L3030 | **现场验过它会红**:在没删的审计卡里插一句对已删件 `fmtHours` 的引用 ⇒ 电池报 |
| L3043 | | `SessionSurface` 替换(压缩用的那条路) | ✗ | `assertProvenance` / `assertSyste… |
| L3163 | 1. 新模块 `lib/turn-query.js`:`latestDirectUserText` 认三种来源 —— 宿主真人消息 |
| L3305 | (他连发两张月亮,第二张她永远收不到)。改成用**图的来源**参与兜底 |
| L3631 | `python/engine/graph.py:816-835` 的 DMAE 维护段每小时删边并清掉没人引用的孤点, |
| L3651 | A 插件对它零引用)。 |
| L3743 | 清理语句引用了那列)。所以这一步该在重启前跑,而不是出事后查。 |
| L3940 | 必须发现差异(只会全绿的守卫等于没有),而且专门挑不被索引引用的那一列开刀 |
| L4113 | 零匹配)。三步照 A 侧实现并注明出处(`docs/PORT_FIX_PLAN.md` 记着落地偏差)。 |
| L4147 | 记忆也只有增没有减。六步全部照 A 侧数值实现并注明出处 |
| L4201 | 一律照抄 A 侧并注明出处(`docs/PORT_FIX_PLAN.md` 记录批次与决策)。 |
| L4206 | 引用,信念层至今产出为零**。现在:`engine.js` 出 `reflectionPrompt` / |
| L4257 | 都不是移植缺口(先证伪再动手): |
| L4308 | 的是**活引用**,而轮末处理器紧接着就地清空同一个对象(`userText=''` |
| L4318 | 抓不住。A 侧同样只看模型的槽位命名,属保真行为不是移植缺口;后续可 |
| L4364 | `graph_reinforce` 两个帧在引擎侧完整移植且测试齐全,壳侧却从没 |
| L4369 | 现在(照 QQ 认知上下文的顺序,段头逐字移植): |
| L4555 | 未接线(引擎侧 v0.4.2 全量移植+测试过,壳侧零调用 —— 联想 |
| L4560 | 核对一致;检索排序/写入链逐字移植属实;漂移强化未移植但原版 |
| L4565 | ### 动态记忆图谱:AstrBot /memory_graph.html 完整移植(用户点名) |
| L4571 | 漏掉了本体)。完整移植到 `/echo/graph.html`,数据面换咱们的 |
| L4601 | ### 审查台从占位页升格为活数据仪表盘(用户:参考 AstrBot 的) |
| L4603 | 用户看了修通的 /echo/ 占位页:「仪表盘太简陋了吧,你可以参考 |
| L4619 | 记忆表(层/来源/情绪/状态); |
| L4649 | 不再裸奔 JSON);渲染全 textContent 不拼 innerHTML —— 参考 |
| L4686 | 用户需求:对话数据也要存起来,全局保留约 100 轮,会话带来源 |
| L4700 | - **来源标签**:config.json 加 sessionLabels 映射(sessionId → |
| L4817 | 关键词 chips/I 值/召回/来源/取代链;**行内编辑**(摘要/关键词/ |
| L4878 | 行(审计推送计数)+ 接口速览,~百行原生 JS,全链路参考实现; |
| L4917 | 和这几小时的想念在说话)。本版移植 QQ 三个已验证机制,零新发明: |
| L4919 | - **【现在】钟面**(echo_utils.now_line 移植):LLM 没有墙钟,她说 |
| L4922 | - **【想念】行**(main.py 先读后削移植):longing_message 帧升级, |
| L4928 | - **情绪剧本化**(echo_emotion 移植):数字 → 有温度的剧本。 |
| L4963 | 参考实现各贡献一条的合成防线,**追加不重写**(铁律与说话方式原样): |
| L5066 | 投递层自建(四个参考实现共同的空白,dsh-schedule 先例补上): |
| L5069 | 合成 plugin 来源的 user 消息入队开一轮**。 |
| L5085 | 来源 → pre-step 真人过滤跳过它(关怀轮不注入情景记忆 —— AstrBot |
| L5109 | - 想念卡标题加**引擎真值/JS 复刻**徽章(v0.4.9 的行级来源标记 |
| L5159 | brains/echo_longing.py 逐字移植为 python/engine/longing.py,worker 的 |
| L5185 | 来自 longing_check 帧),行上标 engine 来源;引擎不在或模糊失败回落 |
| L5227 | time-context 先例),再往下游 enter 决策折一条带来源的 UserMessage |
| L5298 | 逐字移植): |
| L5302 | - 想念匹配 v1:委屈/依赖 ≥6 时惦记型(reflection 来源)×1.5 —— |
| L5334 | **engine/reflection.py**(main.py `_run_reflection` 逐字移植): |
| L5374 | **engine/judge.py** —— 三层防线逐字移植: |
| L5411 | **engine/retrieve.py**:echo_memory_engine `_retrieve` 逐字移植 —— |
| L5445 | **engine/dmae.py**:DMAE v6.0 数学逐字移植(参数集/幂律可回忆度/ |
| L5455 | **engine/graph.py**:AstrBot 图谱全量移植 —— |
| L5486 | **engine/threads.py**:AstrBot echo_memory_engine.py:766-946 逐字移植 |
| L5538 | ### […]:AstrBot 审计面板的 DSH 原生移植 |
| L5568 | 移植,长尾永不归零)+ 六档关键词锚定 + L0 核心记忆豁免话题过滤并强制占位(至少 |
| L5579 | 原样移植(v8.9 全列集一次建齐)。归属简化:DSH 单主人(user_id='master'), |
| L5650 | 人格默认值从 AstrBot 活配置整段移植(speaker_identity/persona_anchor/ |

### 3.2 docs/ · archive/ · 根文档(R2:393 条)

# R2 - dsh-echo 引用痕迹(docs/ + archive/ + 根文档)

范围:docs/**/*.md(55 个) + archive/**/*.md(13 个) + 根 README.md / HANDOVER.md(2 个);CHANGELOG.md 不在范围(他人扫)。
格式:| 类型(项目/论文/其它) | 名称 | 引用方式(<=40字) | 相对路径:行号 |
说明:逐文件扫描并即时追加;引文以 […] 省略;不含真名 / 绝对路径 / 账号 id。

## docs/

### docs/ARCHITECTURE.md
| 项目 | dsh-schedule(官方插件) | 先例:官方插件同为逐字移植、不重写 | docs/ARCHITECTURE.md:46 |
| 其它 | 开源社区记忆图谱代码 / 学术论文(泛指) | 被要求去开源社区/论文里找现成图谱实现作参照 […] | docs/ARCHITECTURE.md:599 |

### docs/ASSOC_GRAPH_SURVEY.md
| 项目 | Zep / Graphiti | 借鉴:三元组+有效期窗口、失效不删除、双时态 | docs/ASSOC_GRAPH_SURVEY.md:17 |
| 项目 | A-MEM | 借鉴:两段式建链(向量取候选+LLM 判关系)、笔记多归属 box | docs/ASSOC_GRAPH_SURVEY.md:18 |
| 项目 | GraphRAG | 借鉴:Leiden 层级社群+每级社群报告 | docs/ASSOC_GRAPH_SURVEY.md:19 |
| 项目 | LightRAG | 借鉴:双级检索;明确不做社群报告 | docs/ASSOC_GRAPH_SURVEY.md:20 |
| 项目 | HippoRAG / HippoRAG 2 | 借鉴:同义词边+PPR 扩散检索 | docs/ASSOC_GRAPH_SURVEY.md:21 |
| 项目 | Mem0 | 借鉴:每条新事实显式判 ADD/UPDATE/DELETE/NOOP | docs/ASSOC_GRAPH_SURVEY.md:22 |
| 项目 | HyperGraphRAG | 借鉴:n 元超边、检索双向扩展 | docs/ASSOC_GRAPH_SURVEY.md:23 |
| 论文 | Zep 边失效机制(arXiv:2501.13956) | 借用算法:LLM 比对语义相关新边判矛盾、置 t_invalid […] | docs/ASSOC_GRAPH_SURVEY.md:26 |
| 论文 | A-MEM 链接生成(arXiv:2502.12110) | 借用算法:先取最相关历史记忆再判是否建链 […] | docs/ASSOC_GRAPH_SURVEY.md:27 |
| 论文 | GraphRAG 社群(arXiv:2404.16130) | 借用:Leiden、层级、社群报告、全局 map-reduce | docs/ASSOC_GRAPH_SURVEY.md:28 |
| 论文 | LightRAG(arXiv:2410.05779) | 引用其成本实测:社群数与重建 token 代价 | docs/ASSOC_GRAPH_SURVEY.md:29 |
| 论文 | HippoRAG 2(arXiv:2502.14802) | 借用:OpenIE+同义词边+PPR+LLM 过滤 | docs/ASSOC_GRAPH_SURVEY.md:30 |
| 论文 | Mem0(arXiv:2504.19413) | 借用:冲突解决由 LLM 直接选四操作 | docs/ASSOC_GRAPH_SURVEY.md:31 |
| 论文 | HyperGraphRAG(arXiv:2503.21322) | 借用:n 元超边;二元分解=表示损失 | docs/ASSOC_GRAPH_SURVEY.md:32 |
| 项目 | A-MEM / HippoRAG | 照抄结论:先向量取候选再判关系;同义词边按阈值自动加 | docs/ASSOC_GRAPH_SURVEY.md:39 |
| 项目 | Graphiti / Mem0 | 照抄结论:仅矛盾时失效;四操作显式选 | docs/ASSOC_GRAPH_SURVEY.md:43 |
| 项目 | A-MEM / Graphiti | 照抄结论:一条记忆可多归属;失效逐事实判而非逐槽位 | docs/ASSOC_GRAPH_SURVEY.md:47 |
| 项目 | GraphRAG / LightRAG | 照抄:层级是算法产物;放弃社群的理由是重建代价 | docs/ASSOC_GRAPH_SURVEY.md:51 |
| 项目 | HyperGraphRAG | 照抄论证:二元分解丢 n 元语义、制造孤立边 | docs/ASSOC_GRAPH_SURVEY.md:55 |
| 项目 | HippoRAG | 借用解法:同义词边(向量阈值)接起重复节点 | docs/ASSOC_GRAPH_SURVEY.md:67 |
| 项目 | A-MEM | 借用其第二段判定(LLM 判是否成边) | docs/ASSOC_GRAPH_SURVEY.md:78 |
| 项目 | HippoRAG | 照其做只读 PPR 阶段:双向扩展、LLM 只做过滤 | docs/ASSOC_GRAPH_SURVEY.md:79 |
| 论文 | Zep/Graphiti — arXiv:2501.13956 (repo getzep/graphiti) | 参考:临时知识图、边失效、双时态 | docs/ASSOC_GRAPH_SURVEY.md:88 |
| 论文 | A-MEM — arXiv:2502.12110 (repo agiresearch/A-mem) | 参考:Zettelkasten 式链接生成+记忆演化 | docs/ASSOC_GRAPH_SURVEY.md:89 |
| 论文 | GraphRAG — arXiv:2404.16130 (repo microsoft/graphrag) | 参考:Leiden 层级社群+社群报告 | docs/ASSOC_GRAPH_SURVEY.md:90 |
| 论文 | LightRAG — arXiv:2410.05779 (repo HKUDS/LightRAG) | 参考:双级检索、增量更新、对社群法成本批评 | docs/ASSOC_GRAPH_SURVEY.md:91 |
| 论文 | HippoRAG — arXiv:2405.14831 / HippoRAG 2 — arXiv:2502.14802 (repo OSU-NLP-Group/HippoRAG) | 参考:OpenIE+同义词边+PPR | docs/ASSOC_GRAPH_SURVEY.md:92 |
| 论文 | Mem0 — arXiv:2504.19413 (repo mem0ai/mem0) | 参考:ADD/UPDATE/DELETE/NOOP 冲突解决 | docs/ASSOC_GRAPH_SURVEY.md:93 |
| 论文 | HyperGraphRAG — arXiv:2503.21322 (repo LHRLAB/HyperGraphRAG) | 参考:n 元超边+双向扩展 | docs/ASSOC_GRAPH_SURVEY.md:94 |
| 项目 | Cognee / Graphiti communities / 经典语义网络与扩散激活 | 列为未展开方向,待需要再单独取证 | docs/ASSOC_GRAPH_SURVEY.md:95 |
| 论文 | EM-LLM | 对照:事件分段+时间邻近缓冲检索 | docs/ASSOC_GRAPH_SURVEY.md:109 |
| 论文 | RAPTOR | 对照:递归软聚类(GMM)+LLM 摘要树、collapsed tree | docs/ASSOC_GRAPH_SURVEY.md:110 |
| 论文 | Generative Agents | 对照:recency/importance/relevance 加权+反思写入 | docs/ASSOC_GRAPH_SURVEY.md:111 |
| 论文 | MemoryBank | 对照:艾宾浩斯指数衰减+复述强化 | docs/ASSOC_GRAPH_SURVEY.md:112 |
| 论文 | MemGPT / Letta | 对照:core/recall/archival 三层记忆 | docs/ASSOC_GRAPH_SURVEY.md:113 |
| 论文 | MIRIX | 对照:多组件记忆分层;除非概念性覆盖不删 | docs/ASSOC_GRAPH_SURVEY.md:114 |
| 论文 | KAG | 对照:点名 OpenIE 图噪声根因+类型化表示 | docs/ASSOC_GRAPH_SURVEY.md:115 |
| 论文 | 记忆综述(arXiv:2404.13501) | 对照:写/管理/读三阶段拆解 | docs/ASSOC_GRAPH_SURVEY.md:116 |
| 项目 | HippoRAG、EM-LLM、LightRAG、RAPTOR、HyperGraphRAG | 共识 1 证据:联想在查询期算不落盘 | docs/ASSOC_GRAPH_SURVEY.md:120 |
| 项目 | GraphRAG、RAPTOR、EM-LLM、KAG、A-MEM | 共识 2 证据:分组算出来且允许多归属 | docs/ASSOC_GRAPH_SURVEY.md:121 |
| 项目 | Graphiti、Mem0、MIRIX | 共识 3 证据:换代/失效只在矛盾时发生 | docs/ASSOC_GRAPH_SURVEY.md:122 |
| 论文 | KAG | 共识 4 依据:无类型与粒度不齐是噪声根因 | docs/ASSOC_GRAPH_SURVEY.md:123 |
| 项目 | MemoryBank / Generative Agents | 共识 5 依据:近因+重要+相关;衰减+复述强化 | docs/ASSOC_GRAPH_SURVEY.md:124 |
| 项目 | MemGPT/Letta、MIRIX、LangMem | 共识 6 依据:记忆是分层组件而非一张图 | docs/ASSOC_GRAPH_SURVEY.md:125 |
| 其它 | 共识 3 + MIRIX + Graphiti | S1 修单值化的依据 | docs/ASSOC_GRAPH_SURVEY.md:131 |
| 其它 | 共识 1 + HyperGraphRAG | S2 影子边降级为证据指针的依据 | docs/ASSOC_GRAPH_SURVEY.md:132 |
| 项目 | RAPTOR / GraphRAG | S3 主题簇软聚类+摘要的依据(示例已略 […]) | docs/ASSOC_GRAPH_SURVEY.md:133 |
| 项目 | HippoRAG 2 | S4 只读 PPR 的依据 | docs/ASSOC_GRAPH_SURVEY.md:134 |
| 项目 | KAG / HippoRAG | S5 粒度归一(概念对齐/同义边)的依据 | docs/ASSOC_GRAPH_SURVEY.md:135 |
| 项目 | LightRAG / GraphRAG | 反向证据:为分组重建整图代价高,故不做 | docs/ASSOC_GRAPH_SURVEY.md:137 |

### docs/ASTRBOT_PLUGIN_ARCHAEOLOGY.md
| 项目 | OneBot / aiocqhttp | 对比研究:确认本插件无 CQ 码、平台耦合近零 […] | docs/ASTRBOT_PLUGIN_ARCHAEOLOGY.md:13 |
| 项目 | OneBot / aiocqhttp | 否证:全仓无平台专有代码,仅测试夹具出现 | docs/ASTRBOT_PLUGIN_ARCHAEOLOGY.md:149 |
| 项目 | agent_state(宿主侧插件) | 对比:本仓无该插件,状态来源需重新定义 | docs/ASTRBOT_PLUGIN_ARCHAEOLOGY.md:240 |

### docs/CODE_AUDIT_2026-09-26.md
(无引用痕迹)

### docs/DISCIPLINE.md
| 项目 | Cortico | 对照研究:把"否定与缺失"当一等公民(core/markers.ts 全套记号)[…] | docs/DISCIPLINE.md:7 |

### docs/DEFENSE.md
| 其它 | 四个参考实现(未具名) | 称心跳投递层是四家共同的空白,故自建 | docs/DEFENSE.md:115 |

### docs/FIX_PLAN.md
| 其它 | 开源社区/学术论文的现成图谱实现(泛指) | 被要求去开源社区/论文里找现成图谱实现 […] | docs/FIX_PLAN.md:118 |

### docs/CARE_DIAG_2026-09-29.md
(无引用痕迹)

### docs/CONFIG_CENTER_CONTRACT.md
(无引用痕迹)

### docs/CONFIG_CENTER_CURL.md
(无引用痕迹)

### docs/DB_MERGE_ANALYSIS.md
(无引用痕迹)

### docs/GOLD_MINIMAL_ANSWERS_DRAFT.md
(无引用痕迹)

### docs/GRAPH_MERGE_REVIEW.md
(无引用痕迹)

### docs/HAZARD_AUDIT_2026-09-26.md
(无引用痕迹)

### docs/L4_PRESENTATION_ACCEPTANCE.md
(无引用痕迹)

### docs/MEMORY_ARCH_DESIGN.md
| 项目 | MemReranker / MemX / CPP | 作为依据的三处独立来源:阈值不可设/低置信过滤等 | docs/MEMORY_ARCH_DESIGN.md:49 |

### docs/MEMORY_ARCHITECTURE.md
| 其它 | 参考材料中的分层记忆 / DMAE 变体 / 向量检索 | 明确不引入:不是重构,一律不引入 | docs/MEMORY_ARCHITECTURE.md:113 |

### docs/MEMORY_ARCH_VERDICT.md
| 论文 | A-MEM | 引用其自陈失败模式:多步 LLM 生成链接致延迟与错误累积膨胀 | docs/MEMORY_ARCH_VERDICT.md:56 |
| 论文 | LoCoMo(基准) | 引用纪律:须同时说清版本/能否读原文/多轮/judge/样本数 | docs/MEMORY_ARCH_VERDICT.md:65 |

### docs/MEMORY_DEDUPE_REVIEW.md
(无引用痕迹)

### docs/LIVE_CHECK_2026-09-26.md
(无引用痕迹)

### docs/MEMORY_EVAL_PROTOCOL.md
| 论文 | LongMemEval(arXiv:2410.10813, ICLR 2025) | 采用为公认评测协议:500 题,代码/数据公开 | docs/MEMORY_EVAL_PROTOCOL.md:1 |
| 论文 | LongMemEval | 出处标注:arXiv 2410.10813,ICLR 2025 | docs/MEMORY_EVAL_PROTOCOL.md:5 |
| 项目 | xiaowu0162/LongMemEval(含 HF 数据集) | 引用其公开代码与数据 | docs/MEMORY_EVAL_PROTOCOL.md:6 |
| 论文 | LoCoMo(arXiv:2402.17753) | 作配套:超长对话/多模态侧数据补充 | docs/MEMORY_EVAL_PROTOCOL.md:9 |
| 其它 | 官方 GPT-4o LLM-judge 判定口径 | 采用官方专家提示词,judge 直接输出 yes/no | docs/MEMORY_EVAL_PROTOCOL.md:39 |
| 论文 | LongMemEval meta-eval | 引用其 judge 与人类专家逐档对照的偏差结论 | docs/MEMORY_EVAL_PROTOCOL.md:40 |
| 论文 | SAGE | 引用其声明:跨协议不排名,引用须标注实验条件 | docs/MEMORY_EVAL_PROTOCOL.md:65 |
| 其它 | 官方判定器提示词 | 逐字照抄(含 abstention 变体) | docs/MEMORY_EVAL_PROTOCOL.md:76 |
| 论文 | LongMemEval | 出处节:arXiv 链接与 HTML 版本 | docs/MEMORY_EVAL_PROTOCOL.md:159 |
| 项目 | xiaowu0162/LongMemEval + HF 数据集 | 代码与数据链接 | docs/MEMORY_EVAL_PROTOCOL.md:160 |
| 论文 | LoCoMo | 出处节:arXiv:2402.17753 | docs/MEMORY_EVAL_PROTOCOL.md:161 |

### docs/MEMORY_PRINCIPLES.md
| 其它 | 18 篇原始文献(全文) | 全部结论来源:每个数字标 arXiv 号,核不到不写 | docs/MEMORY_PRINCIPLES.md:4 |
| 其它 | 八条原则的公开文献依据 | 每条原则都带可迁移机制与出处 | docs/MEMORY_PRINCIPLES.md:30 |
| 论文 | SAGE(arXiv:2605.12061) | 反证:LongMemEval 零样本 KU/TR/MS 极低 | docs/MEMORY_PRINCIPLES.md:44 |
| 论文 | MemoryBank | 举例:遗忘曲线机制无无记忆基线、缺消融 | docs/MEMORY_PRINCIPLES.md:83 |
| 论文 | SAGE | 引用其声明:该表不应被当作单一严格排行榜 | docs/MEMORY_PRINCIPLES.md:89 |

### docs/PLAN.md
| 项目 | dsh-auto-memory | 官方 sidecar 先例:引擎经此先例移植进 DSH | docs/PLAN.md:19 |

### docs/PLAN_CORTICO_ADOPTION.md
| 项目 | Cortico | 借鉴落地计划:唯一主体是她,QQ/语音只是工具与通道 | docs/PLAN_CORTICO_ADOPTION.md:1 |
| 项目 | Cortico | 借鉴:它把"外面"抽象成能力+事件+提示词段,故可抄 | docs/PLAN_CORTICO_ADOPTION.md:38 |
| 项目 | Cortico | 逐项对照表(Cortico ↔ 我们) | docs/PLAN_CORTICO_ADOPTION.md:43 |
| 项目 | Cortico | 借鉴清单:按语音主体相关度重排 | docs/PLAN_CORTICO_ADOPTION.md:81 |
| 项目 | Cortico | 借鉴:系统只给事实、她决定开口;我们保留阈值当触发器 | docs/PLAN_CORTICO_ADOPTION.md:218 |
| 其它 | 参考资料条目(8 批 47 条) | 未搬条目另见该清单 | docs/PLAN_CORTICO_ADOPTION.md:243 |

### docs/PLAN_LAND_ALL.md
| 其它 | docs/REFERENCE_ANALYSIS.md §9.3 可借鉴清单 | 范围来源:21 项全分析 + 宿主漏用扩展点 | docs/PLAN_LAND_ALL.md:5 |
| 项目 | roleplay(dsh-compat.ts) | 出处:借鉴点 ★★#25 | docs/PLAN_LAND_ALL.md:91 |
| 项目 | roleplay / maid / auto-memory | 出处:三插件源码行号作借鉴依据 | docs/PLAN_LAND_ALL.md:99 |
| 项目 | maid | 出处:index.mjs:350-353 | docs/PLAN_LAND_ALL.md:124 |
| 项目 | 宿主文档 §1.5 + roleplay | 出处:变量用法 | docs/PLAN_LAND_ALL.md:131 |
| 项目 | DSH 宿主文档 tools.zh.md | 出处:tools/pre-execute 监听签名 | docs/PLAN_LAND_ALL.md:144 |
| 项目 | Cyrene-main | 出处:harness-trace | docs/PLAN_LAND_ALL.md:161 |
| 项目 | Cyrene-main | 出处:RunToolCatalog | docs/PLAN_LAND_ALL.md:173 |
| 项目 | DSH 宿主 | 出处:subagent/start|end 事件 | docs/PLAN_LAND_ALL.md:181 |
| 项目 | DSH 宿主 | 出处:goal/activation-changed 事件 | docs/PLAN_LAND_ALL.md:189 |
| 项目 | pad-emotion | 出处:异步 waterfall + Promise.race | docs/PLAN_LAND_ALL.md:213 |
| 项目 | cosplay | 出处:store.js:142-145 | docs/PLAN_LAND_ALL.md:223 |
| 项目 | roleplay | 出处:prompts.ts:52-110 | docs/PLAN_LAND_ALL.md:231 |
| 项目 | Mio | 出处:源码 :379-432 | docs/PLAN_LAND_ALL.md:238 |
| 项目 | Mio | 出处:proactive_service.py:588-592 | docs/PLAN_LAND_ALL.md:244 |
| 项目 | auto-memory | 出处:RRF 只排序、注入用绝对分比阈值 | docs/PLAN_LAND_ALL.md:255 |
| 项目 | my-neuro | 出处:search_utils.py:481-508 | docs/PLAN_LAND_ALL.md:266 |
| 项目 | my-neuro | 出处:user-profile/index.js:374-396 | docs/PLAN_LAND_ALL.md:271 |
| 项目 | Mio | 出处:memory_service.py:344-352 | docs/PLAN_LAND_ALL.md:277 |
| 项目 | neuro-sdk | 出处:SPECIFICATION.md:159 | docs/PLAN_LAND_ALL.md:285 |
| 项目 | 宿主文档 slots.zh.md | 出处:sidebar 树 + §1.5 表 | docs/PLAN_LAND_ALL.md:295 |
| 项目 | pad-emotion | 出处:client.js:113-697 | docs/PLAN_LAND_ALL.md:307 |
| 项目 | pad-emotion | 出处:state.js:63-71 / describe.js:1-11 | docs/PLAN_LAND_ALL.md:313 |
| 项目 | aura-scheduler | 出处:sensors.ts | docs/PLAN_LAND_ALL.md:338 |
| 项目 | Mio | 出处:daily_diary_service.py:150-158 | docs/PLAN_LAND_ALL.md:350 |
| 项目 | roleplay | 出处:presets.ts:129-145 | docs/PLAN_LAND_ALL.md:364 |
| 项目 | neuro-sdk | 出处:SPECIFICATION.md:160 | docs/PLAN_LAND_ALL.md:370 |
| 项目 | pad-emotion | 出处:G4 派生字段现算不存(与 E3 合并) | docs/PLAN_LAND_ALL.md:383 |
| 其它 | Cortico 计划(同见 P4) | 出处:H2 = P4 文本纪律/QQ 草稿门/视觉七段式 | docs/PLAN_LAND_ALL.md:393 |

### docs/QQ_BRIDGE_DIY_PLAN.md
| 项目 | OneBot | 换装计划:借现成 OneBot 层,拆成独立插件 | docs/QQ_BRIDGE_DIY_PLAN.md:1 |
| 项目 | dsh-qq-onebot-bridge(第三方 DSH 插件 v0.5.7) | 只读参考:128 个文件逐层读过,一个字节都不写它 | docs/QQ_BRIDGE_DIY_PLAN.md:8 |
| 项目 | NapCat / OneBot | 职责边界:协议细节不归我们,NapCat 重连即等它回来 | docs/QQ_BRIDGE_DIY_PLAN.md:37 |
| 项目 | dsh-qq-onebot-bridge(lib/onebot.js) | 借自(必抄,自包含):反向 WS/鉴权/消息段解析/action 封装;DIY 删群聊分支 | docs/QQ_BRIDGE_DIY_PLAN.md:99 |
| 项目 | dsh-qq-onebot-bridge | 参考实现短板:我们必须自己补的三个窟窿(逐条有据) | docs/QQ_BRIDGE_DIY_PLAN.md:104 |
| 项目 | dsh-qq-onebot-bridge | 插件骨架照其形状(package.json/cordis.patch.yml) | docs/QQ_BRIDGE_DIY_PLAN.md:119 |
| 项目 | dsh-qq-onebot-bridge(lib/onebot.js 27.8KB/593 行) | 对照:DIY 后 29.9KB/725 行 | docs/QQ_BRIDGE_DIY_PLAN.md:140 |
| 项目 | 参考 test/onebot-api-unit.mjs | 照其形状写单测(参考只测 action 表) | docs/QQ_BRIDGE_DIY_PLAN.md:141 |
| 项目 | dsh-qq-onebot-bridge(MIT) | 借用许可:MIT 必须随代码带走,答辩须说清出处 | docs/QQ_BRIDGE_DIY_PLAN.md:145 |
| 项目 | dsh-qq-onebot-bridge(版权行) | 保留原版权行 | docs/QQ_BRIDGE_DIY_PLAN.md:146 |
| 其它 | THIRD_PARTY.md / 文件头来源注明 | 抄代码须注明来源与 MIT 全文 | docs/QQ_BRIDGE_DIY_PLAN.md:147 |
| 项目 | cheesehaqi/dsh-qq-onebot-bridge | 出处:整块代码来自该仓库 v0.5.7,MIT,已改动 X 处 | docs/QQ_BRIDGE_DIY_PLAN.md:149 |
| 项目 | dsh-qq-onebot-bridge(lib/onebot.js) | 体量实测:只 import node:events 与 ws | docs/QQ_BRIDGE_DIY_PLAN.md:150 |
| 项目 | dsh-qq-onebot-bridge(lib/index.js:18) | 参照:服务名能否被另一插件 inject | docs/QQ_BRIDGE_DIY_PLAN.md:216 |
| 项目 | dsh-qq-onebot-bridge v0.5.7 | 已做:借其 lib/onebot.js 并 DIY(删群聊、action 收窄到 6 个) | docs/QQ_BRIDGE_DIY_PLAN.md:297 |
| 项目 | dsh-qq-onebot-bridge(onebot.js:311-316) | 参考实现多实例会互串;我们明确只支持单账号 | docs/QQ_BRIDGE_DIY_PLAN.md:413 |
| 项目 | OneBot(record 语音段) | 出站语音段形状参考 bridge.js:1698 | docs/QQ_BRIDGE_DIY_PLAN.md:416 |
| 项目 | dsh-qq-onebot-bridge | 短板:反向 WS 无心跳/重连,由我们补探活 | docs/QQ_BRIDGE_DIY_PLAN.md:445 |
| 项目 | dsh-qq-onebot-bridge | 其业务层(命令/群运营/TTS)一律不接 | docs/QQ_BRIDGE_DIY_PLAN.md:451 |
| 项目 | dsh-qq-onebot-bridge | 文档里写明 lib/onebot.js 是借来的 | docs/QQ_BRIDGE_DIY_PLAN.md:478 |
| 项目 | dsh-qq-onebot-bridge(参考实现审计) | 事实来源:128 个文件逐层读过 | docs/QQ_BRIDGE_DIY_PLAN.md:491 |
| 项目 | dsh-qq-onebot-bridge(行号级审计) | 覆盖 lib/index.js:17-292、lib/onebot.js:4-672 等 | docs/QQ_BRIDGE_DIY_PLAN.md:493 |

### docs/PLAN_MEMORY_ARCH_V2.md
| 其它 | docs/ASSOC_GRAPH_SURVEY.md(16 份材料;原始文本 .scratch/survey/) | 取证与共识来源 | docs/PLAN_MEMORY_ARCH_V2.md:645 |

### docs/PLAN_PROACTIVE_TOPIC_SCORER.md
| 论文 | Inner Thoughts(CHI 2025,arXiv:2501.00383 / ACM) | 采用:把主动开口拆成五阶段 | docs/PLAN_PROACTIVE_TOPIC_SCORER.md:11 |
| 论文 | Inner Thoughts(CHI 2025) | 参考这篇做"思念值",为省 token 数学量化成标量 | docs/PLAN_PROACTIVE_TOPIC_SCORER.md:21 |
| 论文 | Inner Thoughts(CHI 2025) | 其判据之一"信息缺口"被用作打分维度 | docs/PLAN_PROACTIVE_TOPIC_SCORER.md:81 |
| 论文 | Inner Thoughts(CHI 2025,arXiv:2501.00383) | 出处:借鉴其评估层,不抄其念头生成层 | docs/PLAN_PROACTIVE_TOPIC_SCORER.md:193 |
| 项目 | xybxruceliu/thoughtful-agents | 该论文开源实现,借鉴其评估层 | docs/PLAN_PROACTIVE_TOPIC_SCORER.md:193 |

### docs/PLAN_ROUND2.md
| 其它 | 参考资料余量(A/C/F4/E/G5/H 批) | 第二轮:PLAN_LAND_ALL 里还没搬完的参考资料条目 | docs/PLAN_ROUND2.md:17 |

### docs/PORT_GAP_AUDIT_2026-09-26.md
(无引用痕迹)

### docs/R4_ACCEPTANCE.md
(无引用痕迹)

### docs/PLAN_PROACTIVE_TOPIC_SCORER_CODE.md
(无引用痕迹)

### docs/CORE_IN_DSH_PLAN.md
(无引用痕迹)

### docs/COMPAT_DSH_0.2.md
(无引用痕迹)

### docs/REFERENCE_CORTICO_2026-09-28.md
| 项目 | Cortico(Pal-AI-Lab/Cortico,MIT,TypeScript) | 源码分析:同题作文,能抄什么 | docs/REFERENCE_CORTICO_2026-09-28.md:1 |
| 项目 | Pal-AI-Lab/Cortico(MIT,1538 文件/17MB) | 参考物:外部开源项目本地只读副本 | docs/REFERENCE_CORTICO_2026-09-28.md:3 |
| 项目 | Cortico(语音层) | 只有契约级证据:不能照抄,只能自己设计 | docs/REFERENCE_CORTICO_2026-09-28.md:47 |
| 项目 | Cortico | 借鉴:最小先验干预,基础设施不干涉模型 | docs/REFERENCE_CORTICO_2026-09-28.md:62 |
| 项目 | Cortico | 借鉴:诚实的认知论,只陈述可确认的事实 | docs/REFERENCE_CORTICO_2026-09-28.md:63 |
| 项目 | Cortico(src/worlds/qq/) | 对照研究:他们有起草-确认门与引用语义,我们有自己的分泡与送达统计 | docs/REFERENCE_CORTICO_2026-09-28.md:75 |
| 项目 | Cortico | 可借鉴清单(按性价比排序) | docs/REFERENCE_CORTICO_2026-09-28.md:81 |
| 项目 | Cortico(subagent driver.ts:185-198) | 借鉴:失败返结构化 error 供降级 | docs/REFERENCE_CORTICO_2026-09-28.md:245 |
| 项目 | Cortico | 借鉴:消息引用语义(行首 #id、reply_to 约束、跨会话拒绝) | docs/REFERENCE_CORTICO_2026-09-28.md:246 |
| 项目 | Cortico | 未核实/来源节 | docs/REFERENCE_CORTICO_2026-09-28.md:340 |
| 项目 | Cortico(MIT;src/protocol/open-responses 自带 LICENSE) | 版权说明 | docs/REFERENCE_CORTICO_2026-09-28.md:356 |


### docs/RETRIEVAL_ARCH_NOTES.md
| 其它 | arXiv 公开 API(export.arxiv.org) | 取文献的路子:web_fetch + arXiv API,无需 key | docs/RETRIEVAL_ARCH_NOTES.md:7 |
| 论文 | MemX(arXiv:2603.16171) | 参考:向量+FTS5 双召回→RRF→四因子重排→低置信拒绝 | docs/RETRIEVAL_ARCH_NOTES.md:24 |
| 论文 | ConvMemory v2(arXiv:2606.10842) | 参考:召回保全级联,重排只动受保护的 top-10 | docs/RETRIEVAL_ARCH_NOTES.md:25 |
| 论文 | Training-Free Lexical-Dense Fusion(arXiv:2606.04194) | 参考:分数级融合增益;复现"重排是负的" | docs/RETRIEVAL_ARCH_NOTES.md:26 |
| 论文 | Chronos(arXiv:2603.16862) | 参考:事件日历/轮次日历 + 迭代取数 | docs/RETRIEVAL_ARCH_NOTES.md:27 |
| 论文 | ENGRAM(arXiv:2511.12960) | 参考:记忆类型化 + 集合运算合并(不是 RRF) | docs/RETRIEVAL_ARCH_NOTES.md:28 |
| 论文 | MemConflict(arXiv:2605.20926) | 参考:答案正确率常与检索/排序脱钩 | docs/RETRIEVAL_ARCH_NOTES.md:29 |
| 论文 | Structural Memory of LLM Agents(arXiv:2412.15266) | 参考:四结构×三检索,迭代稳定胜出 | docs/RETRIEVAL_ARCH_NOTES.md:30 |
| 论文 | MemGAS(arXiv:2505.19549) | 参考:多粒度记忆单元 + 熵路由选粒度 | docs/RETRIEVAL_ARCH_NOTES.md:31 |
| 论文 | MemReranker(arXiv:2605.06132) | 参考:记忆专用重排的三个病,正对上我们的门槛问题 | docs/RETRIEVAL_ARCH_NOTES.md:33 |
| 其它 | arXiv HTML / PDF、Semantic Scholar、emergentmind、HF papers | 取文献工具的限制记录(截断/不支持 PDF/429) | docs/RETRIEVAL_ARCH_NOTES.md:118 |
| 论文 | AutoViewMem(arXiv:2609.21940) | 参考:视图引导的带出处抽取,解耦挪到写入期 | docs/RETRIEVAL_ARCH_NOTES.md:258 |
| 论文 | EgoCITE(arXiv:2608.12627) | 参考:碎片转写变自包含原子记忆索引 | docs/RETRIEVAL_ARCH_NOTES.md:266 |
| 论文 | A Graph-Native Bitemporal Memory Store(arXiv:2607.26520) | 参考:双时态记忆存储 | docs/RETRIEVAL_ARCH_NOTES.md:272 |
| 论文 | LycheeMemory V2(arXiv:2608.12990) | 参考:语义分段级整合替换轮次级 | docs/RETRIEVAL_ARCH_NOTES.md:280 |
| 论文 | 记忆投毒与防御(arXiv:2601.05504) | 参考:结论句正对要害 | docs/RETRIEVAL_ARCH_NOTES.md:288 |
| 项目 | Zep / Graphiti(时序知识图引擎)驱动的记忆层服务 | 引用:摘要称其在 DMR 上胜过 MemGPT | docs/RETRIEVAL_ARCH_NOTES.md:636 |
| 项目 | 该记忆层服务 | 参考:每条消息带参考时间戳 t_ref,入库即解相对日期 | docs/RETRIEVAL_ARCH_NOTES.md:638 |
| 论文 | (⑧ 新鲜度/衰减因子的原始理论出处) | 引用:MemX 的 f_rec 只是它的一个特例 | docs/RETRIEVAL_ARCH_NOTES.md:648 |
| 论文 | (Reader 侧四件:结构化查询规划/软寻址/预激活) | 参考:认知启发的检索设计 | docs/RETRIEVAL_ARCH_NOTES.md:663 |
| 论文 | MemoryBank(Ebbinghaus 原始出处) | 引用:衰减/新鲜度机制的原始出处 | docs/RETRIEVAL_ARCH_NOTES.md:689 |
| 论文 | MemoryOS | 引用摘要原句:把 OS 的段/页/热度搬到记忆 | docs/RETRIEVAL_ARCH_NOTES.md:704 |
| 论文 | MemoryBank | 警告:其 Ebbinghaus 机制无单独数字证据 | docs/RETRIEVAL_ARCH_NOTES.md:720 |
| 论文 | IRCoT | 引用:迭代轮次与 IRCoT 是它最实的增益来源 | docs/RETRIEVAL_ARCH_NOTES.md:784 |
| 其它 | MemRL(按引用溯源) | 教训:按引用溯源比按关键词搜准 | docs/RETRIEVAL_ARCH_NOTES.md:798 |
| 其它 | CPP 自认的局限 | 照抄不美化 | docs/RETRIEVAL_ARCH_NOTES.md:842 |
| 其它 | 机制->出处->已核数字索引表 | 把机制挂到出处并补缺口出处 | docs/RETRIEVAL_ARCH_NOTES.md:906 |
| 论文 | MemoryBank(Ebbinghaus 1964) | 标注:无消融,是设计主张而非量出的增益 | docs/RETRIEVAL_ARCH_NOTES.md:920 |
| 其它 | scripts/judge-llm.py(官方判定器) | 提示词逐字照抄,采用版规范见 MEMORY_EVAL_PROTOCOL | docs/RETRIEVAL_ARCH_NOTES.md:994 |
| 其它 | 自造"引用式"判定口径 | 教训:引用命中 != 答对,口径过松 | docs/RETRIEVAL_ARCH_NOTES.md:1020 |

### docs/RETRIEVAL_RESEARCH.md
| 项目 | dsh-auto-memory(lib/shadow-retrieval.js) | 参考其查询计划与来源加权 | docs/RETRIEVAL_RESEARCH.md:38 |
| 项目 | dsh-auto-memory(buildQueryPlan :221) | 参考:按来源加权(trigger/最近用户/工具结果) | docs/RETRIEVAL_RESEARCH.md:44 |
| 项目 | wu81313-lab/dsh-company-kb(MIT,纯离线) | 参考:15 条金标的自建思路 | docs/RETRIEVAL_RESEARCH.md:62 |
| 项目 | NousResearch/hermes-agent(hermes_state_fts.py) | 参考其 FTS 实现 | docs/RETRIEVAL_RESEARCH.md:79 |
| 论文 | A-Mem(arXiv:2502.12110) | 参考:Zettelkasten 式自动建链,结构化生成关键词 | docs/RETRIEVAL_RESEARCH.md:112 |
| 论文 | HippoRAG / HippoRAG 2 | 借 PPR 概念;全量 OpenIE 建图不照搬 | docs/RETRIEVAL_RESEARCH.md:113 |
| 论文 | Mem0(arXiv:2504.19413) | 参考不抄:整合/换代与我们已有留档语义同题 | docs/RETRIEVAL_RESEARCH.md:114 |
| 项目 | Zep / Graphiti(graphiti-core 0.4.3) | 同构:四时间戳;我们已有,不换 | docs/RETRIEVAL_RESEARCH.md:115 |
| 论文 | LongMemEval / LoCoMo | 借其题型自建小型金标,不引依赖 | docs/RETRIEVAL_RESEARCH.md:116 |
| 项目 | dsh-auto-memory(e5-small ONNX) | 参考其本地嵌入做法 | docs/RETRIEVAL_RESEARCH.md:147 |
| 项目 | HippoRAG / Zep | 不建议照搬的理由(贵/已有) | docs/RETRIEVAL_RESEARCH.md:151 |
| 其它 | 哈工大 507 停用词表(参考实现用) | 抄 BM25 必须连停用词一起抄 | docs/RETRIEVAL_RESEARCH.md:232 |
| 其它 | RRF | 用途纪律:融合不同检索来源,不是同一来源算两遍 | docs/RETRIEVAL_RESEARCH.md:248 |

### docs/RETRIEVAL_PLAN.md
| 其它 | 哈工大 507 停用词表 | 可选,采用须注明来源(先落自制最小表) | docs/RETRIEVAL_PLAN.md:220 |

### docs/RETRIEVAL_BASELINE.md
| 论文 | CPP | 三处独立来源都指向同一件事:低置信度过滤 + abstention 单列一档 | docs/RETRIEVAL_BASELINE.md:200 |

### docs/README.md
| 其它 | 参考资料余量(A 余/C 余/F4/E/G5/H) | docs 索引:第二轮总计划主线 | docs/README.md:16 |
| 其它 | docs/REFERENCE_ANALYSIS.md | docs 索引:21 个开源项目精读 + DSH 宿主扩展点全清单 | docs/README.md:36 |
| 项目 | dsh-pad-emotion / dsh-interpersonal-circumplex | 队友情绪插件评审:C1 情绪单轮闭环的出处 | docs/README.md:38 |
| 其它 | docs/ASTRBOT_PLUGIN_ARCHAEOLOGY.md | docs 索引:A 侧插件考古(relay_core.py 引用) | docs/README.md:44 |

### docs/REFERENCE_ANALYSIS.md
| 项目 | deepseek-harness-master(DSH 宿主本体) | 参考:扩展点的权威出处 | docs/REFERENCE_ANALYSIS.md:14 |
| 项目 | AstrBot-master | 参考:她出生与"嘴和耳朵"所在 | docs/REFERENCE_ANALYSIS.md:15 |
| 项目 | koishi-master | 参考:同为 cordis 血统,插件模型参照 | docs/REFERENCE_ANALYSIS.md:17 |
| 项目 | dsh-auto-memory-main | 参考:同生态直接竞品(DSH 跨会话记忆) | docs/REFERENCE_ANALYSIS.md:18 |
| 项目 | dsh-pad-emotion | 参考:同生态直接竞品(PAD 三维情绪) | docs/REFERENCE_ANALYSIS.md:19 |
| 项目 | dsh-roleplay-main | 参考:提示词工程样板 | docs/REFERENCE_ANALYSIS.md:20 |
| 项目 | dsh-cosplay-main | 参考:人格注入写法 | docs/REFERENCE_ANALYSIS.md:21 |
| 项目 | dsh-humanized-deepseek-maid-main | 参考:记忆注入位置 | docs/REFERENCE_ANALYSIS.md:22 |
| 项目 | dsh-aura-scheduler-master | 参考:主动开口的另一种解法 | docs/REFERENCE_ANALYSIS.md:23 |
| 项目 | Mio-main | 参考:最像的竞品,全维度对照 | docs/REFERENCE_ANALYSIS.md:24 |
| 项目 | giftia-main | 参考:遗忘曲线 / RRF 对照 | docs/REFERENCE_ANALYSIS.md:25 |
| 项目 | my-neuro-main | 参考:检索工程栈参照 | docs/REFERENCE_ANALYSIS.md:26 |
| 项目 | Neuro-master | 参考:人格原型 + 实时管线 | docs/REFERENCE_ANALYSIS.md:27 |
| 项目 | neuro-sdk-main | 参考:"外部通道必须窄"的范本 | docs/REFERENCE_ANALYSIS.md:28 |
| 项目 | Cortico-main | 参考:契约版本 / 可观测性 | docs/REFERENCE_ANALYSIS.md:29 |
| 项目 | Cyrene-Agent-master | 参考:插件契约 / 资源归属 | docs/REFERENCE_ANALYSIS.md:30 |
| 项目 | Cyrene-main | 参考:trace 设计最完整 | docs/REFERENCE_ANALYSIS.md:31 |
| 项目 | cnsenti-master | 参考:传统情感计算路线 | docs/REFERENCE_ANALYSIS.md:32 |
| 项目 | Text2Emotion-master | 参考:大连理工本体库完整版 | docs/REFERENCE_ANALYSIS.md:33 |
| 项目 | EA-master | 参考:情绪原因/分类/词典论文复现 | docs/REFERENCE_ANALYSIS.md:34 |
| 其它 | 参考资料库(本地只读) | 对象:21 个开源项目(含 1 个重复副本) | docs/REFERENCE_ANALYSIS.md:4 |
| 其它 | @deepseek-ai/dsh-root 0.1.6-alpha.2 vs 现役 0.1.5-rc.3 | 版本差警示:扩展点以参考副本文档为准 | docs/REFERENCE_ANALYSIS.md:72 |
| 项目 | @huggingface/transformers | 参考副本的零运行时依赖(仅 optional) | docs/REFERENCE_ANALYSIS.md:222 |
| 项目 | Mio(memory_service.py:266-305 / db.py:1190-1205) | 引用:FTS5 + bm25 + 启发式检索 | docs/REFERENCE_ANALYSIS.md:496 |
| 项目 | Cortico(cortico.api) / Cyrene-Agent(apiVersion) | 对照:契约版本协商,数字契约单一来源 | docs/REFERENCE_ANALYSIS.md:745 |
| 其它 | 可借鉴清单(按优先级) | 逐条列借鉴->出处->改什么 | docs/REFERENCE_ANALYSIS.md:902 |
| 项目 | pad-emotion(state.js:63-71 / describe.js:1-11) | 借鉴#12:派生字段现算不存 + UI 词与模型词同源 | docs/REFERENCE_ANALYSIS.md:919 |
| 其它 | 13 条未核实项 | 引用纪律:只能引它明确核过的行 | docs/REFERENCE_ANALYSIS.md:978 |
| 项目 | Cortico(三个参考 Persona / templates / src/core/loop.ts) | 2026-09-28 已补读,见 REFERENCE_CORTICO 文档 | docs/REFERENCE_ANALYSIS.md:986 |
| 项目 | dsh-auto-memory(三臂 RRF、决策/排序解耦、离线金标) | 强项在检索工程,可借鉴 | docs/REFERENCE_ANALYSIS.md:1009 |

### docs/TEAMMATE_EMOTION_REVIEW.md
| 项目 | dsh-pad-emotion / dsh-interpersonal-circumplex | 队友情绪插件评审(两包对照) | docs/TEAMMATE_EMOTION_REVIEW.md:1 |
| 论文 | Mehrabian PAD / Wiggins IPC | 两插件的理论出处:建立在可引用文献上并主动纠错 | docs/TEAMMATE_EMOTION_REVIEW.md:13 |
| 项目 | dsh-pad-emotion(§9) / dsh-interpersonal-circumplex(§13) | 引用其自列已知限制与未核实清单 | docs/TEAMMATE_EMOTION_REVIEW.md:15 |
| 项目 | dsh-interpersonal-circumplex(core/circumplex.js:676) | 对照:IPC 状态空间 [0,1]² 内切圆盘 81 格 | docs/TEAMMATE_EMOTION_REVIEW.md:29 |
| 项目 | 两包 | 理论核对:各有一批纠错,逐条有出处 | docs/TEAMMATE_EMOTION_REVIEW.md:68 |
| 项目 | dsh-pad-emotion(scripts/verify-no-think-wire.mjs) | 引用其"关思考"链路的证明 | docs/TEAMMATE_EMOTION_REVIEW.md:93 |
| 项目 | dsh-interpersonal-circumplex(index.js:1455) | 引用其 API 口径不自洽的问题 | docs/TEAMMATE_EMOTION_REVIEW.md:112 |
| 项目 | dsh-interpersonal-circumplex(core/match.js) | 借鉴:坐标↔语言唯一转换点,派生字段现算不落盘 | docs/TEAMMATE_EMOTION_REVIEW.md:130 |
| 论文 | 可引用文献 + 锚点出处 | 对照:我们的情绪理论出处是手搓 | docs/TEAMMATE_EMOTION_REVIEW.md:157 |
| 项目 | 两插件 | 照抄:同轮生效的时序(inbox/spliced + waterfall await + 超时) | docs/TEAMMATE_EMOTION_REVIEW.md:168 |
| 项目 | 两插件 | 移植:网格+残差思路进 lib/emotion.js | docs/TEAMMATE_EMOTION_REVIEW.md:169 |
| 项目 | 两插件 | 照抄思路:解析救援 + salvaged 留痕 | docs/TEAMMATE_EMOTION_REVIEW.md:170 |
| 项目 | dsh-interpersonal-circumplex | 概念层借鉴:三分关系量 + 178 词状态表可直接搬 | docs/TEAMMATE_EMOTION_REVIEW.md:173 |
| 项目 | dsh-pad-emotion(docs/PAD_lexicon_sourced.md) | 未核实:51 条锚点的文献数值是否逐条如实 | docs/TEAMMATE_EMOTION_REVIEW.md:207 |
| 项目 | dsh-interpersonal-circumplex | 其 escalation 机制自标"没有一手来源" | docs/TEAMMATE_EMOTION_REVIEW.md:210 |

### docs/VOICE_INTERFACE_DRAFT.md
| 其它 | 前端 TTS / Live2D(他方实现) | 接口草案对接:语音通道实现不在本仓 | docs/VOICE_INTERFACE_DRAFT.md:84 |

### docs/RETIRE_OLD_CHAIN_PLAN.md
(无引用痕迹)

### docs/RT11_THIRD_CUT.md
(无引用痕迹)

### docs/STAGE3A_ENABLE_BRIEF.md
(无引用痕迹)

### docs/VOICE_BASELINE_2026-09-26.md
(无引用痕迹)

### docs/RETRIEVAL_OPT_2026-09-30.md
(无引用痕迹)

### docs/PLAN_MEMORY_GRAPH.md
| 项目 | Graphiti / StructMem | 对照:节点类型显式区分(entity/episode/community 或 entry 双视角) | docs/PLAN_MEMORY_GRAPH.md:76 |
| 项目 | HyperSU / StructMem | 对照:边来源以共现/时间为主,LLM 只做补 | docs/PLAN_MEMORY_GRAPH.md:78 |
| 项目 | Cognee / graph-memory | 对照:度数种子/有界邻域、向量 Top-K 兜底 | docs/PLAN_MEMORY_GRAPH.md:81 |
| 其它 | docs/REFERENCE_ANALYSIS.md(21 个开源项目逐项精读) | 引用其硬判据/去重/换代等旁证 | docs/PLAN_MEMORY_GRAPH.md:141 |
| 项目 | Cortico | 外部参考取证:文件工作区 + MEMORY 0-4;MEMORY 0-4 不照搬 | docs/PLAN_MEMORY_GRAPH.md:142 |
| 项目 | HippoRAG / Zep·Graphiti / Mem0 / MemoryBank / Generative Agents / MemoryOS / MemGAS / TRACE / CPP / HaluMem | 重叠部分一律引旧文档 | docs/PLAN_MEMORY_GRAPH.md:177 |
| 项目 | graph-memory(src/graph/pagerank.ts,MIT,TypeScript,244 行) | 算法参照:PPR;在 Python 侧重写(port 非 vendor),保留 MIT 声明 | docs/PLAN_MEMORY_GRAPH.md:279 |
| 项目 | Graphiti | 教训:失效是纯确定性规则,没时间戳就静默不失效 | docs/PLAN_MEMORY_GRAPH.md:372 |
| 项目 | memtrace-public / dsh-tavern-v2 / Mem0 Neo4j graph variant | 引用红线:只借思路不 vendor | docs/PLAN_MEMORY_GRAPH.md:379 |
| 项目 | Graphiti / Cognee / A-MEM / HippoRAG / LightRAG / graph-memory / mnemon | 可 vendor 者须保留版权与许可声明(Apache-2.0/MIT) | docs/PLAN_MEMORY_GRAPH.md:379 |
| 项目 | graph-memory | 裁决 D4:参照 MIT 实现 Python 重写(port,保留 MIT 声明) | docs/PLAN_MEMORY_GRAPH.md:423 |
| 论文 | A-MEM — arXiv:2502.12110(v11,NeurIPS 2025) | 引用与来源清单 | docs/PLAN_MEMORY_GRAPH.md:438 |
| 论文 | AriGraph — arXiv:2407.04363 | 引用与来源清单 | docs/PLAN_MEMORY_GRAPH.md:439 |
| 论文 | Graph-based Agent Memory 综述 — arXiv:2602.05665 | 引用与来源清单 | docs/PLAN_MEMORY_GRAPH.md:440 |
| 论文 | HyperSU — arXiv:2606.28351 | 引用与来源清单 | docs/PLAN_MEMORY_GRAPH.md:441 |
| 论文 | StructMem — arXiv:2604.21748(ACL 2026 main) | 引用与来源清单 | docs/PLAN_MEMORY_GRAPH.md:442 |
| 论文 | MemGPT / Letta — arXiv:2310.08560 | 引用与来源清单 | docs/PLAN_MEMORY_GRAPH.md:443 |
| 论文 | MemoryOS — arXiv:2506.06326 | 引用与来源清单 | docs/PLAN_MEMORY_GRAPH.md:444 |
| 论文 | Generative Agents — arXiv:2304.03442(UIST '23) | 引用与来源清单 | docs/PLAN_MEMORY_GRAPH.md:445 |
| 论文 | Synapse — arXiv:2601.02744(Findings of ACL 2026) | 引用与来源清单 | docs/PLAN_MEMORY_GRAPH.md:446 |
| 论文 | HippoRAG — arXiv:2405.14831(NeurIPS 2024) | 引用与来源清单 | docs/PLAN_MEMORY_GRAPH.md:447 |
| 论文 | HippoRAG 2 — arXiv:2502.14802(ICML 2025) | 引用与来源清单 | docs/PLAN_MEMORY_GRAPH.md:448 |
| 论文 | Zep / Graphiti — arXiv:2501.13956 | 引用与来源清单 | docs/PLAN_MEMORY_GRAPH.md:449 |
| 论文 | GraphRAG(Microsoft) — arXiv:2404.16130 | 引用与来源清单 | docs/PLAN_MEMORY_GRAPH.md:450 |
| 论文 | MemoryBank — arXiv:2305.10250 | 引用与来源清单 | docs/PLAN_MEMORY_GRAPH.md:451 |
| 论文 | LightRAG — arXiv:2410.05779 | 引用与来源清单 | docs/PLAN_MEMORY_GRAPH.md:452 |
| 论文 | SAGE — arXiv:2605.12061 | 第三方横向对比来源 | docs/PLAN_MEMORY_GRAPH.md:456 |
| 项目 | A-MEM 0.2.6(MIT) / Mem0 2.2.1(Apache-2.0) / Graphiti 0.30.2(Apache-2.0) / HippoRAG 2.0.0a4(MIT) / Cognee 1.6.2(Apache-2.0) / LightRAG 1.5.7(MIT) | 开源实现:本机 pip download / npm pack 取源码 | docs/PLAN_MEMORY_GRAPH.md:460 |
| 论文 | Mem0 论文(arXiv:2504.19413) / Zep 双时间论文 | 标注:OSS 包中已无该模块,细节未读到 | docs/PLAN_MEMORY_GRAPH.md:485 |

### docs/PLAN_MEMORY_GRAPH_ACTION.md
| 项目 | MIT 的 PPR 实现(graph-memory) | 只读 PPR 扩散:端口移植并保留声明 | docs/PLAN_MEMORY_GRAPH_ACTION.md:39 |
| 项目 | graph-memory(D4 裁决) | 用词纪律:算法参照一律写 port(衍生实现),不是 vendor | docs/PLAN_MEMORY_GRAPH_ACTION.md:378 |
| 项目 | Graphiti | 教训:无 occurred_at 不建时间边 | docs/PLAN_MEMORY_GRAPH_ACTION.md:423 |
| 项目 | HippoRAG 2 | 承重 vs 装饰:查询->节点链接值 12.5 点、passage 节点 6.1 点 | docs/PLAN_MEMORY_GRAPH_ACTION.md:473 |
| 项目 | Letta(Apache-2.0,源码) / sleep-time compute(CC BY 4.0,论文) / Auto-Dreamer(CC BY 4.0,论文) | 机制参照:写权分离、睡眠期重写、快写+慢整理 | docs/PLAN_MEMORY_GRAPH_ACTION.md:541 |
| 项目 | GraphRAG / A-MEM / Basic Memory(AGPL) | 不做清单:不学社区摘要、不照抄 A-MEM links、不 vendor Basic Memory | docs/PLAN_MEMORY_GRAPH_ACTION.md:614 |
| 其它 | docs/HAZARD_AUDIT_2026-09-26.md F1/F3 | 出处:图侧时间列是死列、activation 全 0 | docs/PLAN_MEMORY_GRAPH_ACTION.md:654 |

### docs/MEMORY_ARCH_SURVEY.md
| 其它 | 灵枢(DSH 商店插件) | 出处:商店页 README;自述"内部标尺非横评声明" | docs/MEMORY_ARCH_SURVEY.md:19 |
| 项目 | dsh-ontology | 出处:商店页 README 全文;domain/range + subClassOf 闭包校验 | docs/MEMORY_ARCH_SURVEY.md:19 |
| 其它 | LoCoMo 等基准 | 引用纪律:四家口径互不可比,不同来源数字不可直比 | docs/MEMORY_ARCH_SURVEY.md:26 |
| 论文 | MemGPT / MemoryOS / Letta | 引用带条件的数字必须带条件(阈值原文写作 e.g.) | docs/MEMORY_ARCH_SURVEY.md:27 |
| 项目 | MemoryOS(repo BAI-LAB/MemoryOS) | 参考:STM/MTM/LPM 分层分页 + Heat 淘汰;代码 Apache-2.0 | docs/MEMORY_ARCH_SURVEY.md:44 |
| 论文 | MemGPT — arXiv:2310.08560(CC BY 4.0) | 参考:上下文=物理内存,函数调用分页 | docs/MEMORY_ARCH_SURVEY.md:45 |
| 论文 | MemOS — arXiv:2507.03724(CC BY 4.0,repo MemTensor/MemOS) | 参考:MemCube + 生命周期状态机 + Time Machine/冻结 | docs/MEMORY_ARCH_SURVEY.md:48 |
| 论文 | MAGMA — arXiv:2601.03236(ACL 2026,repo FredJiang0324/MAGMA) | 参考:四张正交关系图 + 意图加权 beam 遍历 | docs/MEMORY_ARCH_SURVEY.md:53 |
| 论文 | sleep-time compute — arXiv:2504.13171(CC BY 4.0,repo letta-ai/sleep-time-compute) | 参考:睡眠期把上下文重写成再表征 | docs/MEMORY_ARCH_SURVEY.md:54 |
| 论文 | Auto-Dreamer — arXiv:2605.20616(CC BY 4.0) | 参考:快写 + 离线区域重写 supersede 原区域 | docs/MEMORY_ARCH_SURVEY.md:55 |
| 论文 | MIRIX — arXiv:2507.07957(CC BY 4.0,repo Mirix-AI/MIRIX) | 参考:六类记忆 + Active Retrieval;存储后端 SQLite | docs/MEMORY_ARCH_SURVEY.md:56 |
| 项目 | mnemon(Apache-2.0;npm dsh-mnemon MIT) | 参考:Go 单二进制 + 宿主 LLM 当监督者;底层 MAGMA 四图 | docs/MEMORY_ARCH_SURVEY.md:57 |
| 论文 | HyperSU — arXiv:2606.28351 | 参考:文本片段当超边 + MDL 分割 + 双向扩展 | docs/MEMORY_ARCH_SURVEY.md:58 |
| 论文 | ontology-to-tools — arXiv:2602.03439(CC BY 4.0) | 参考:把 T-Box 编译成 MCP 工具以强制约束 | docs/MEMORY_ARCH_SURVEY.md:60 |
| 项目 | Mem0 OSS 2.2.1(Apache-2.0,repo mem0ai/mem0) | 参考:LLM 抽事实 + 双向量库 + 加性打分 | docs/MEMORY_ARCH_SURVEY.md:61 |
| 论文 | MemoryLLM — arXiv:2402.04624(CC BY 4.0,repo wangyu-ustc/MemoryLLM) | 参考:每层插定长 memory pool | docs/MEMORY_ARCH_SURVEY.md:63 |
| 论文 | WISE — arXiv:2405.14768(NeurIPS 2024,代码并入 zjunlp/EasyEdit) | 参考:双参数记忆 + 训练 router | docs/MEMORY_ARCH_SURVEY.md:64 |
| 论文 | MemX — arXiv:2603.16171 | 参考(首选参照):向量+FTS5 -> RRF -> 四因子重排 -> 低置信拒答 | docs/MEMORY_ARCH_SURVEY.md:65 |
| 论文 | HERO — arXiv:2608.22310 | 参考:异质记忆图 + PPR 三阶段检索 | docs/MEMORY_ARCH_SURVEY.md:73 |
| 论文 | EAR — arXiv:2607.17879 | 参考:反思式检索精炼 | docs/MEMORY_ARCH_SURVEY.md:74 |
| 论文 | TRACE — arXiv:2607.00339 | 参考:时间证据图 + 有效性标记 + answer plan | docs/MEMORY_ARCH_SURVEY.md:75 |
| 论文 | Generative Agents — arXiv:2304.03442(repo joonspk-research/generative_agents) | 参考:memory stream + reflection + planning | docs/MEMORY_ARCH_SURVEY.md:77 |
| 论文 | MemoryOS — arXiv:2506.06326(repo BAI-LAB/MemoryOS) | 出处:全文;代码 Apache-2.0(已核) | docs/MEMORY_ARCH_SURVEY.md:90 |
| 论文 | MemGPT — arXiv:2310.08560(CC BY 4.0) | 出处:全文;70/100/50 阈值原文均写作 e.g. | docs/MEMORY_ARCH_SURVEY.md:105 |
| 项目 | Letta(repo letta-ai/letta 与 letta-leaderboard,Apache-2.0) | 出处:源码级读取(PyPI sdist、基准代码、博客、docs) | docs/MEMORY_ARCH_SURVEY.md:120 |
| 项目 | Letta Filesystem 74.0% / Mem0 自报 68.5% | 引用须带其自述 caveat | docs/MEMORY_ARCH_SURVEY.md:143 |
| 论文 | MemOS — arXiv:2507.03724(repo MemTensor/MemOS) | 出处:全文读到 §6.1;论文 CC BY 4.0 | docs/MEMORY_ARCH_SURVEY.md:150 |
| 论文 | Memory³ | MemCube 设计灵感自陈来源:"controllable externalization" | docs/MEMORY_ARCH_SURVEY.md:152 |
| 论文 | MemOS §5.4.3 | 引用:Time Machine / Frozen 语义(回滚走副本、权威版本只读) | docs/MEMORY_ARCH_SURVEY.md:157 |
| 项目 | MemTensor/MemOS(DSH 商店条目) | 引用须标明:token savings 数字是商店页营销描述 | docs/MEMORY_ARCH_SURVEY.md:159 |
| 项目 | Basic Memory(repo basicmachines-co/basic-memory) | 出处:文档级;许可 AGPL-3.0(从文档页读到) | docs/MEMORY_ARCH_SURVEY.md:166 |
| 项目 | sqlite-vec / fastembed / BAAI/bge-small-en-v1.5 / jinaai/jina-reranker-v1-tiny-en / QMD | 参考副本依赖与借鉴来源自陈 | docs/MEMORY_ARCH_SURVEY.md:173 |
| 项目 | FuRongJun-1999/dsh-memory | 出处:商店页 README + 标"转述未验证"的源码行号 | docs/MEMORY_ARCH_SURVEY.md:181 |
| 项目 | melandlabs/opencontext(Apache-2.0 自述) | 出处:商店页 README;valid_from/valid_until + 一等边 | docs/MEMORY_ARCH_SURVEY.md:196 |
| 项目 | EternalNight996/dsh-memory-eternal(MIT) | 参考:待审库分离;批评 Mem0/Zep 等自动全量入库 | docs/MEMORY_ARCH_SURVEY.md:211 |
| 论文 | MAGMA — arXiv:2601.03236v2(ACL 2026,repo FredJiang0324/MAGMA) | 出处:HTML 全文;代码许可未读到 | docs/MEMORY_ARCH_SURVEY.md:228 |
| 论文 | sleep-time compute — arXiv:2504.13171(repo letta-ai/sleep-time-compute) | 出处:全文 + Appendix F 代码 | docs/MEMORY_ARCH_SURVEY.md:243 |
| 论文 | Auto-Dreamer — arXiv:2605.20616 | 出处:全文;代码仓库论文未给出 | docs/MEMORY_ARCH_SURVEY.md:258 |
| 论文 | MIRIX — arXiv:2507.07957(repo Mirix-AI/MIRIX) | 出处:全文(含六类记忆字段定义) | docs/MEMORY_ARCH_SURVEY.md:273 |
| 项目 | mnemon(04-graph-model.md) | 自陈方法来源 MAGMA(引用 arXiv:2601.03236) | docs/MEMORY_ARCH_SURVEY.md:289 |
| 项目 | mnemon(SQLite + 本地 Ollama 嵌入) | 参考:向量可选、嵌入不可用则优雅退化 | docs/MEMORY_ARCH_SURVEY.md:295 |
| 论文 | HyperSU — arXiv:2606.28351(v2) | 出处:§4.1/§4.2 全文;代码未给出 | docs/MEMORY_ARCH_SURVEY.md:303 |
| 论文 | ontology-to-tools — arXiv:2602.03439v1(报告号 c4e-343,CC BY 4.0) | 出处:abs + 小节标题级;代码未读到 | docs/MEMORY_ARCH_SURVEY.md:333 |
| 项目 | mem0ai 2.2.1(Apache-2.0) | 出处:经 PyPI sdist 读源码本体 | docs/MEMORY_ARCH_SURVEY.md:350 |
| 项目 | memobase(repo memodb-io/memobase,Apache-2.0) | 出处:wheel 全源码;服务端实现不在包内 | docs/MEMORY_ARCH_SURVEY.md:366 |
| 论文 | MemoryLLM — arXiv:2402.04624(repo wangyu-ustc/MemoryLLM,CC BY 4.0) | 出处:HTML 全文(截断 5 万字符) | docs/MEMORY_ARCH_SURVEY.md:381 |
| 论文 | WISE — arXiv:2405.14768(NeurIPS 2024,repo zjunlp/EasyEdit) | 出处:HTML 全文(截断) | docs/MEMORY_ARCH_SURVEY.md:396 |
| 论文 | MemX — arXiv:2603.16171 | 出处:本地 memx.txt 第 1-435 行 | docs/MEMORY_ARCH_SURVEY.md:415 |
| 项目 | plastic-labs/honcho | 出处:商店页 README 前段;许可未读到 | docs/MEMORY_ARCH_SURVEY.md:434 |
| 项目 | supermemory(supermemoryai/python-sdk,Apache-2.0) | 出处:SDK wheel 与类型定义;服务端不在包内 | docs/MEMORY_ARCH_SURVEY.md:449 |
| 论文 | HERO — arXiv:2608.22310 | 出处:摘要/§1/方法/实验 | docs/MEMORY_ARCH_SURVEY.md:464 |
| 论文 | EAR — arXiv:2607.17879 | 出处:标题/摘要/目录/附录超参表 | docs/MEMORY_ARCH_SURVEY.md:479 |
| 论文 | TRACE — arXiv:2607.00339 | 出处:标题/摘要/§1/方法 | docs/MEMORY_ARCH_SURVEY.md:494 |
| 论文 | Navet(HAL hal-05747244,CC BY 4.0) | 博士论文提案阶段;未读到一手材料 | docs/MEMORY_ARCH_SURVEY.md:509 |
| 论文 | Generative Agents — arXiv:2304.03442(UIST '23) | 出处:HTML 全文(§4.2 未读到) | docs/MEMORY_ARCH_SURVEY.md:519 |
| 项目 | MemX / Mem0 | 谁最便宜:无 LLM 检索 < 90ms;一跳实体加成公式可移植 | docs/MEMORY_ARCH_SURVEY.md:547 |
| 项目 | MemOS / mnemon / opencontext | 谁做得最好:Version Chain/Time Machine、软删+oplog、双时字段与一等边 | docs/MEMORY_ARCH_SURVEY.md:552 |
| 项目 | MemoryOS / Basic Memory / Auto-Dreamer / dsh-memory-eternal | 谁最便宜:消费即清零、chunk 哈希、反事实掩码打分、蒸馏关掉 | docs/MEMORY_ARCH_SURVEY.md:559 |
| 其它 | 论文与代码许可汇总 | 引用:CC BY 4.0 / arXiv perpetual non-exclusive / 博客版权 | docs/MEMORY_ARCH_SURVEY.md:572 |
| 项目 | Basic Memory(AGPL) | 注意:AGPL 只能借思路;vendor 前须单独核 LICENSE | docs/MEMORY_ARCH_SURVEY.md:574 |
| 其它 | LoCoMo 口径对照表 | 引用纪律:逐家列口径与关键限定 | docs/MEMORY_ARCH_SURVEY.md:582 |
| 论文 | MemoryOS — arXiv:2506.06326 §4.2 | 引用:F1+BLEU-1 口径与限定 | docs/MEMORY_ARCH_SURVEY.md:585 |
| 论文 | MemOS — arXiv:2507.03724 §6.1 | 引用:LLM-Judge 口径与限定 | docs/MEMORY_ARCH_SURVEY.md:586 |
| 论文 | HERO | 引用:一个系统三套口径并存 | docs/MEMORY_ARCH_SURVEY.md:595 |
| 论文 | LoCoMo / LoCoMo-10 / MIRIX / MemoryAgentBench | 引用:同一基准被三套长度口径引用 | docs/MEMORY_ARCH_SURVEY.md:599 |
| 论文 | MIRIX — arXiv:2507.07957 | 引用:85.38% overall,自称 SOTA | docs/MEMORY_ARCH_SURVEY.md:605 |
| 项目 | Mem0 68.5%(经 Letta 博客二手引用) | 引用:Mem0 自己的协议文档未读到 | docs/MEMORY_ARCH_SURVEY.md:607 |
| 项目 | Letta 74.0% | 引用必须同时带其五条 caveat | docs/MEMORY_ARCH_SURVEY.md:624 |
| 其它 | LoCoMo 分数引用五要件 | 缺任一项即视为不可比 | docs/MEMORY_ARCH_SURVEY.md:626 |
| 其它 | research-arch.md §4.3/§11.1 | 来源:本节只复述结论,不新增测量 | docs/MEMORY_ARCH_SURVEY.md:632 |
| 其它 | §6 可选借鉴路线(非本代理结论) | 逐条标"参考" | docs/MEMORY_ARCH_SURVEY.md:655 |
| 项目 | sleep-time compute / Letta / Auto-Dreamer | R-1 写权分离 + 离线巩固【参考】 | docs/MEMORY_ARCH_SURVEY.md:659 |
| 项目 | Basic Memory / Letta Filesystem / dsh-memory-eternal | R-2 文件为真源 + 记忆工具化【参考】 | docs/MEMORY_ARCH_SURVEY.md:666 |
| 项目 | dsh-ontology / ontology-to-tools | R-3 最小类型集 + 写入期强制【参考】 | docs/MEMORY_ARCH_SURVEY.md:673 |
| 项目 | MIRIX 六类 / MemOS MemCube | R-4 记忆类型分栏 + 元数据契约【参考】 | docs/MEMORY_ARCH_SURVEY.md:680 |
| 项目 | MAGMA / mnemon / TRACE | R-5 表示纪律:先拆 temporal/entity 视图【参考】 | docs/MEMORY_ARCH_SURVEY.md:687 |
| 项目 | MemOS / mnemon / opencontext / Auto-Dreamer | R-6 遗忘/冻结的形状:冻结 != 删除【参考】 | docs/MEMORY_ARCH_SURVEY.md:694 |
| 其它 | docs/PLAN_MEMORY_GRAPH.md 等一批旧文档 | 转引说明:未回读旧文档本体 | docs/MEMORY_ARCH_SURVEY.md:749 |
| 其它 | 数字纪律 | 所有数字/引用/行号均来自四份调研笔记 | docs/MEMORY_ARCH_SURVEY.md:751 |

### docs/A_APPLY_RUNBOOK.md
(无引用痕迹)

### docs/API.md
(无引用痕迹)

### docs/astrbot-audit-2026-09-25T13-07-13-030Z.md
(无引用痕迹)

### docs/MIGRATION_DISCIPLINE.md
(无引用痕迹)

## archive/
> 封存区,不随包发布;引用须与 docs/ 一眼区分。

### archive/docs/RELAY_PLAN.md
| 其它 | D10 上下文压缩:论文与开源实现调研 | 计划条目:热 10 轮+三层压缩(免费优先) | archive/docs/RELAY_PLAN.md:15 |
| 项目 | AstrBot(master / member: 隔离) | 不移植 A 的多用户 member: 隔离 | archive/docs/RELAY_PLAN.md:150 |
| 其它 | 开源社区/论文里的最省钱上下文压缩法(泛指) | 其调研方向 | archive/docs/RELAY_PLAN.md:256 |
| 项目 | LLMKube issue #1286 | 引用其证据:被迫全量重新 prefill | archive/docs/RELAY_PLAN.md:289 |
| 项目 | NousResearch/hermes-agent issue #4319 | 引用其证据 | archive/docs/RELAY_PLAN.md:290 |
| 项目 | my-neuro context-compressor / Mio(等三份实现) | 三份独立实现的收敛结论作参考 | archive/docs/RELAY_PLAN.md:296 |
| 其它 | 参考材料里的 L0/L1/L2 分层、DMAE、向量/RRF | 一律不引入 | archive/docs/RELAY_PLAN.md:321 |
| 项目 | Cortico(truncate.ts:46-50) | 借鉴硬规则:切点必须落在 user 消息上 | archive/docs/RELAY_PLAN.md:350 |
| 项目 | Cortico | 对比:token 估算我们取 1.1 vs Cortico 的 CJK 公式 | archive/docs/RELAY_PLAN.md:365 |
| 项目 | Cortico | 借鉴两条结构性纪律 | archive/docs/RELAY_PLAN.md:392 |
| 项目 | Cortico | 借鉴:标记语言与语义解释分开 | archive/docs/RELAY_PLAN.md:396 |
| 项目 | Cortico | 借鉴:超预算单条折叠成记号而不丢 | archive/docs/RELAY_PLAN.md:400 |
| 项目 | Cortico | 对照:其 600 字符阈值偏低,我们按 token 定 | archive/docs/RELAY_PLAN.md:403 |
| 项目 | Cortico | 借鉴卡片骨架四段(facts/threads/mood/anchors)+原话回指 | archive/docs/RELAY_PLAN.md:404 |
| 项目 | Cortico | 借鉴:不丢历史 reasoning;不引 md 文件树记忆 | archive/docs/RELAY_PLAN.md:440 |
| 其它 | 参考资料实证表(抄了什么/拒了什么) | 逐来源取用清单 | archive/docs/RELAY_PLAN.md:446 |
| 项目 | dsh-auto-memory(同类 DSH 插件) | 抄:L0 零 LLM 规则抽取/注入块字节稳定/常驻预算;拒:四路拼装检索编排 | archive/docs/RELAY_PLAN.md:448 |
| 项目 | Cortico / Cyrene-Agent | 抄:切点配对自检/三元标记/折叠/阈值 0.7/前缀与 tail 分离/血缘回滚;拒:DMAE 全套等 | archive/docs/RELAY_PLAN.md:452 |
| 项目 | Cortico / Cyrene-Agent | 借鉴:triggerRatio 取 0.7 | archive/docs/RELAY_PLAN.md:460 |
| 其它 | 参考项目(分层记忆/DMAE/向量) | 一律不引入 | archive/docs/RELAY_PLAN.md:651 |

### archive/docs/R0_PROBE.md
| 项目 | dsh-headless(lib/index.js:134-147) | 照抄:setup(agentCtx) 里跑 installModelSelection | archive/docs/R0_PROBE.md:51 |

### archive/docs/PLAN_2026-09-26_三问题_群串私聊_硬开关_记忆脏.md
| 其它 | 开源社区/学术论文的现成实现(泛指) | 他要求去开源社区与学术论文中找现成的记忆图谱实现 | archive/docs/PLAN_2026-09-26_三问题_群串私聊_硬开关_记忆脏.md:93 |


### archive/README.md
(无外部引用痕迹;仅 A 侧->DSH 内部移植)

### archive/docs/astbot-pipeline-detail.md
(无外部引用痕迹;仅 A 侧->DSH 内部移植)

### archive/docs/ASTRBOT-ARCHITECTURE.md
(无外部引用痕迹;仅 A 侧->DSH 内部移植)

### archive/docs/MEMORY_AUDIT.md
(无外部引用痕迹;仅 A 侧->DSH 内部移植)

### archive/docs/MEMORY_FIX_PLAN.md
(无外部引用痕迹;仅 A 侧->DSH 内部移植)

### archive/docs/PORT_FIX_PLAN.md
(无外部引用痕迹;仅 A 侧->DSH 内部移植)

### archive/docs/PORT_GAP_AUDIT.md
(无外部引用痕迹;仅 A 侧->DSH 内部移植)

### archive/docs/graph-merge-tier2-2026-09-25.md
(无外部引用痕迹;仅 A 侧->DSH 内部移植)

### archive/astrbot_adapter/README.md
(无外部引用痕迹;仅 A 侧->DSH 内部移植)

### archive/docs/HANDS_PLAN.md
(无外部引用痕迹;仅 A 侧->DSH 内部移植)

## 根文档

### README.md
| 项目 | OneBot v11 | 渠道插件:dsh-echo-qq 走 OneBot v11 反向 WS 服务端 | README.md:130 |
| 其它 | archive/README.md / docs/README.md | 引用其作为清理规矩与 docs 索引出处 | README.md:243 |
| 其它 | 参考资料余量账本 | docs 索引:PLAN_LAND_ALL / PLAN_ROUND2 | README.md:304 |
| 其它 | docs/REFERENCE_ANALYSIS.md | docs 索引:21 个开源项目逐项精读+可借鉴清单 | README.md:311 |
| 项目 | Cortico | docs 索引:源码分析(2026-09-28) | README.md:312 |
| 项目 | OneBot | docs 索引:QQ 桥 DIY 换装计划(OneBot 层) | README.md:322 |

### HANDOVER.md
| 项目 | OneBot 11 / NapCat | QQ 渠道插件只负责私聊收发、回执、心跳与诊断页 | HANDOVER.md:38 |

### 3.3 代码注释 lib/ · python/ · web/ · scripts/ · tests/(R3:212 条)

# R3 · dsh-echo 代码注释里的引用痕迹
范围:仅 `lib/**/*.js`、`web/**/*.js`、`scripts/**/*.mjs`、`tests/**/*.js`、`python/**/*.py` 的注释与文档字符串。
格式:`| 类型 | 名称 | 引用方式(原文 ≤40 字) | 相对路径:行号 |`;内部文档/本仓出处单列为「其它/内部出处」。
## lib/
| 项目 | AstrBot | 气泡分条 + 泡间节奏 —— 从 AstrBot 原样移植 | dsh-echo/lib/bubble.js:2 |
| 项目 | AstrBot | A 侧出处:切分 core/echo_utils.py:82 split_bubbles | dsh-echo/lib/bubble.js:4 |
| 项目 | AstrBot | 她的回复中位数 123 字,用户 12 字…一大段就是 AI 感的来源 | dsh-echo/lib/bubble.js:10 |
| 项目 | openclaw | 这是 A 侧抄 openclaw 的教训 | dsh-echo/lib/bubble.js:20 |
| 项目 | Mio | 照 Mio proactive_service.py:588-592 | dsh-echo/lib/care-report.js:68 |
| 其它/内部出处 | 概念稿 §3 | 出处:概念稿 §3「指标三列」 | dsh-echo/lib/care-report.js:272 |
| 其它 | 开源社区/学术论文(泛称) | 去开源社区与学术论文里找现成图谱实现作参照 | dsh-echo/lib/cleanup-guard.js:19 |
| 项目 | AstrBot | 想念卡(答辩主仪表:AstrBot v8.6 移植) | dsh-echo/lib/client.js:740 |
| 其它/内部出处 | dsh_port/03 | 出处:dsh_port/03 的裁决 —— 机器留 dsh,内容归 soul | dsh-echo/lib/compaction.js:4 |
| 项目 | AstrBot | 记忆上下文渲染 —— AstrBot INJECT_TEMPLATE 的 DSH 适配版 | dsh-echo/lib/context.js:2 |
| 项目 | AstrBot | v0.6.0 三段移植(QQ 已验证机制,零新发明) | dsh-echo/lib/context.js:12 |
| 项目 | AstrBot | 【现在】钟面(echo_utils.now_line) | dsh-echo/lib/context.js:13 |
| 项目 | AstrBot | (echo_emotion._master_script 移植,措辞照抄) | dsh-echo/lib/context.js:164 |
| 项目 | AstrBot | build_emotion_filter 的合并移植 | dsh-echo/lib/context.js:183 |
| 项目 | AstrBot | 照抄 A brain_pipeline.py:685-692 | dsh-echo/lib/context.js:354 |
| 其它/内部出处 | dsh_port/03 §4 | 出处:dsh_port/03 §4「压缩即策展」的裁决 | dsh-echo/lib/curation.js:4 |
| 其它/内部出处 | 设计 §4.2 | 键 → 目标位置(设计 §4.2 的表,逐字照抄) | dsh-echo/lib/data-migrate.js:38 |
| 项目 | Mio | 照 Mio daily_diary_service.py:150-158 | dsh-echo/lib/diary.js:38 |
| 项目 | AstrBot | DMAE 幂律遗忘模型 —— 从 AstrBot brain_pipeline.py 原样移植 | dsh-echo/lib/dmae.js:2 |
| 项目 | AstrBot | A 侧 audit/echo_audit.py:184-259 + main.py:1142-1167 逐条移植 | dsh-echo/lib/drift.js:4 |
| 项目 | AstrBot | 三条纪律(照抄 A 的注释精神) | dsh-echo/lib/drift.js:18 |
| 项目 | AstrBot | A core/echo_prompts.py:96-109 逐字 | dsh-echo/lib/drift.js:29 |
| 项目 | AstrBot | A core/echo_prompts.py:111-118 逐字(只做 .replace()) | dsh-echo/lib/drift.js:45 |
| 项目 | heart-tts | 是 heart-tts(语音输出插件 v1.2.0)的行内语气指令 | dsh-echo/lib/emo-marker.js:6 |
| 项目 | heart-tts | dsh-plugin-heart-tts-main/host/impl.js:148 的 MARKER 正则 | dsh-echo/lib/emo-marker.js:8 |
| 项目 | heart-tts | 逐字照抄 heart-tts 的 MARKER(impl.js:148) | dsh-echo/lib/emo-marker.js:28 |
| 项目 | heart-tts | 出处:host/impl.js:148(逐字同源) | dsh-echo/lib/emo-marker.js:48 |
| 项目 | AstrBot | 情绪向量:数据与动力学 —— A 侧 brains/echo_emotion.py 的移植 | dsh-echo/lib/emotion.js:2 |
| 项目 | AstrBot | global/target_master 逐字照抄 echo_emotion.py:85-103 | dsh-echo/lib/emotion.js:29 |
| 项目 | AstrBot | 默认向量:中性、微正(照抄 echo_emotion.py:135-151,数值逐字) | dsh-echo/lib/emotion.js:49 |
| 项目 | AstrBot | (照抄 emotion_delta,两边都先各自 clamp) | dsh-echo/lib/emotion.js:120 |
| 项目 | AstrBot | 差分字典 → 日志/审计友好的短句(照抄 format_emotion_delta) | dsh-echo/lib/emotion.js:137 |
| 项目 | AstrBot | 按时间衰减多维情绪(照抄 decayed_emotion_vector) | dsh-echo/lib/emotion.js:176 |
| 项目 | pad-emotion | 出处:pad-emotion index.js:833-846(异步 waterfall + Promise.race) | dsh-echo/lib/emotion-score.js:4 |
| 项目 | aura-scheduler | 出处:aura-scheduler 的 sensors.ts | dsh-echo/lib/external-event.js:4 |
| 其它 | (未具名参考实现 ×4) | schedule 先例 —— 四个参考实现共同的空白 | dsh-echo/lib/heartbeat.js:8 |
| 项目 | AstrBot | 会话路由(只对她聊过的那个会话开口,AstrBot 安全默认) | dsh-echo/lib/heartbeat.js:14 |
| 项目 | Mio | 日上限 3(护栏层,Mio 先例:防骚扰) | dsh-echo/lib/heartbeat.js:15 |
| 论文 | HBS 2025 | 主动开口禁语哨兵(HBS 六类黑模式)的落痕钩子 | dsh-echo/lib/heartbeat.js:43 |
| 项目 | Cortico | 空拍指数退避(借自 Cortico cormini/persona/heartbeat.ts:8,53) | dsh-echo/lib/heartbeat.js:54 |
| 项目 | Mio | 开口前的过期失效检查(照 Mio proactive_service.py:588-592) | dsh-echo/lib/heartbeat.js:145 |
| 项目 | Cortico | 「安静了多久」的人话(Cortico heartbeat.ts:84-86 的 quietLine) | dsh-echo/lib/heartbeat.js:211 |
| 项目 | Cortico | B3(借自 Cortico heartbeat.ts:84-86):只报事实 | dsh-echo/lib/heartbeat.js:302 |
| 论文 | CHI 2025 / HBS | 出处:CHI 2025「信息缺口」是判据;HBS 那条分界线 | dsh-echo/lib/heartbeat.js:329 |
| 项目 | Cortico | B4 / 借自 Cortico bots/corti-soulmate/persona/rhythm.ts:44-83 | dsh-echo/lib/heartbeat.js:345 |
| 项目 | Cortico | 与 Cortico「每 30 分钟重估」同款 | dsh-echo/lib/heartbeat.js:486 |
| 项目 | Mio | 他下的命令也要看一眼是不是已经过去了(照 Mio […] | dsh-echo/lib/heartbeat.js:744 |
| 其它/内部出处 | docs/PLAN_PROACTIVE_TOPIC_SCORER.md | 出处:docs/PLAN_PROACTIVE_TOPIC_SCORER.md §2.1 | dsh-echo/lib/her-activity.js:4 |
| 项目 | heart-tts | `<emo>` / `<skip>` 语气标签在文字渠道剥掉(语音那半边在 heart-tts 里自己剥) | dsh-echo/lib/index.js:120 |
| 项目 | heart-tts | 语音回执账:heart-tts 的 voice.external / voice.interrupted 落账 | dsh-echo/lib/index.js:186 |
| 项目 | dsh-cosplay | 思考风格双档(出处 dsh-cosplay 的 THINKING_DIRECTIVES) | dsh-echo/lib/index.js:1928 |
| 项目 | dsh-cosplay | 诚实标注:dsh-cosplay 作者自认系统提示位比训练位弱 | dsh-echo/lib/index.js:1942 |
| 项目 | Cortico | 心跳的空拍退避立刻复位(Cortico:任何外部事件复位) | dsh-echo/lib/index.js:2458 |
| 其它 | (未具名参考实现) | steer 续一步(每轮至多一次)。参考实现的血泪注释 | dsh-echo/lib/index.js:2912 |
| 项目 | AstrBot | A 侧出处 main.py:1382-1479。判官(judge.py)每轮多给两个字段 | dsh-echo/lib/index.js:2980 |
| 项目 | AstrBot | AstrBot echo_audit_dashboard 六面板的 DSH 原生化 | dsh-echo/lib/index.js:3467 |
| 项目 | neuro-sdk | 出处 neuro-sdk API/SPECIFICATION.md:160(priority 参数) | dsh-echo/lib/insert-priority.js:4 |
| 项目 | neuro-sdk | 上游的四个 priority 名(照抄,不另起名) | dsh-echo/lib/insert-priority.js:21 |
| 项目 | AstrBot | A 侧出处:写入 main.py:655……读取 brain_pipeline.py:1234-1240 | dsh-echo/lib/interrupted.js:4 |
| 项目 | AstrBot | A 侧 core/echo_utils.py:262-323 + echo_llm_client.py:205-247 逐字移植 | dsh-echo/lib/jsonfix.js:2 |
| 项目 | AstrBot | 所以 A 的三级阶梯在 DSH 几乎没有调用点。移植的价值在于兜底可达 | dsh-echo/lib/jsonfix.js:16 |
| 其它/内部出处 | python/engine/lexical.py | 与 python/engine/lexical.py 的 STOPWORDS 逐字一致 | dsh-echo/lib/lexical.js:61 |
| 项目 | dsh-roleplay | 出处:roleplay presets.ts:129-145 | dsh-echo/lib/preset-patch.js:91 |
| 项目 | dsh-agent-preset-registry | 出处(0.2.0-rc.2 源码与 README,2026-10-02 实读) | dsh-echo/lib/preset-patch.js:177 |
| 项目 | AstrBot | A 侧出处:main.py:1855-1900 _build_proactive_line | dsh-echo/lib/proactive-ack.js:4 |
| 项目 | AstrBot | 措辞逐字照抄,连 [:80] 的截断和「刚才 / N分钟前」的分档都一样 | dsh-echo/lib/proactive-ack.js:8 |
| 项目 | AstrBot | 轮后反思(EXTRACT)—— AstrBot 大脑2 的 DSH 移植 | dsh-echo/lib/reflect.js:2 |
| 项目 | AstrBot | echo_utils 的 now_str 移植 | dsh-echo/lib/reflect.js:197 |
| 项目 | AstrBot | barge-in:他插话了(v0.18.0,A 侧 main.py:650-660 移植) | dsh-echo/lib/relay.js:378 |
| 项目 | AstrBot | 气泡分条(v0.18.0,A 侧 main.py:640-673 移植) | dsh-echo/lib/relay.js:618 |
| 项目 | neuro-sdk | 出处 neuro-sdk SPECIFICATION.md:160 | dsh-echo/lib/relay.js:638 |
| 项目 | Cortico | 对照 Cortico 的 dry-mount | dsh-echo/lib/relay.js:909 |
| 项目 | AstrBot | A 侧 main.py v8.5.2 的逐字移植:_REMINDER_CMD_RE(触发层) | dsh-echo/lib/reminder.js:4 |
| 项目 | Mio | A 侧原话:Mio 教训,行为决策层必须确定性 | dsh-echo/lib/reminder.js:13 |
| 项目 | AstrBot | 策略照抄 A:砍唤醒前缀 → 找时间短语 → 取其后的话 | dsh-echo/lib/reminder.js:31 |
| 项目 | AstrBot | AstrBot 真值 8(echo_memory_engine L0_ALWAYS_ON_LIMIT) | dsh-echo/lib/retrieve.js:31 |
| 项目 | AstrBot | A 侧出处 main.py:1382-1479 | dsh-echo/lib/say-again.js:4 |
| 项目 | AstrBot | 气泡分条(v0.18.0,从 A 侧 v8.10.0 原样移植) | dsh-echo/lib/settings-fields.js:88 |
| 项目 | dsh-roleplay | 出处 roleplay prompts.ts:106-108 | dsh-echo/lib/settings-fields.js:236 |
| 项目 | neuro-sdk | 出处 neuro-sdk SPECIFICATION.md:160:low 等她说完成… | dsh-echo/lib/settings-fields.js:240 |
| 项目 | Cortico | Cortico 就是这条路:EXTENSION_API_VERSIONS 不符即拒 | dsh-echo/lib/speak.js:47 |
| 项目 | dsh-roleplay | 禁词 / 防重复清单 —— 清单进设置,不硬编码(出处 roleplay prompts.ts:52-110) | dsh-echo/lib/speech-guard.js:2 |
| 项目 | dsh-roleplay | 原来这里躺着 12 个词(出处 roleplay prompts.ts:106-108) | dsh-echo/lib/speech-guard.js:50 |
| 项目 | dsh-roleplay | 防重复:…(出处 roleplay antiRepeatSection | dsh-echo/lib/speech-guard.js:176 |
| 论文 | HBS 2025 | 出处:概念稿 §4「禁六条」= HBS 2025《Emotional Manipulation by AI Companions》 | dsh-echo/lib/speech-guard.js:260 |
| 项目 | AstrBot | 表结构从 AstrBot echo_schema.py 原样移植 | dsh-echo/lib/store.js:3 |
| 项目 | AstrBot | 写入一条情景记忆(移植 _insert_memory:I 决定 H0) | dsh-echo/lib/store.js:523 |
| 项目 | AstrBot | 检索 top_k(移植 _retrieve:打分纯函数化,命中即强化回写) | dsh-echo/lib/store.js:649 |
| 项目 | AstrBot | 「仪表盘」:AstrBot echo_audit_dashboard 六面板的查询层 | dsh-echo/lib/store.js:1050 |
| 项目 | AstrBot | 悬置话题四态(AstrBot v8.5.7 生命周期逐字移植) | dsh-echo/lib/store.js:1096 |
| 项目 | AstrBot | AstrBot build_api_longing 的兜底数学:H=3h、阈值 7.0、s/(s+h) 幂律 | dsh-echo/lib/store.js:1128 |
| 项目 | AstrBot | AstrBot 的节点类型推断逐字移植(人物名单/习惯/偏好/事件) | dsh-echo/lib/store.js:1235 |
| 项目 | AstrBot | A 侧出处 main.py:650-660:_session_seq 一变 | dsh-echo/lib/store.js:2186 |
| 项目 | AstrBot | 兼容 AstrBot v5.x 旧格式(逗号拼接) | dsh-echo/lib/store.js:2359 |
| 项目 | dsh-cosplay | 出处:dsh-cosplay 的 THINKING_DIRECTIVES | dsh-echo/lib/thinking-style.js:4 |
| 项目 | Mio | RT10/C4 话题去重惩罚(出处:Mio :379-432) | dsh-echo/lib/thread-dedupe.js:66 |
| 项目 | AstrBot | 标注「A」的照抄 AstrBot 侧 _conf_schema.json 与 echo_constants.DEFAULTS | dsh-echo/lib/toggle.js:513 |
| 项目 | dsh-cosplay | (出处 dsh-cosplay 的 THINKING_DIRECTIVES) | dsh-echo/lib/toggle.js:615 |
| 项目 | pad-emotion | 出处 pad-emotion index.js:833-846 | dsh-echo/lib/toggle.js:622 |
| 项目 | neuro-sdk | 出处 neuro-sdk SPECIFICATION.md:160 | dsh-echo/lib/toggle.js:636 |
| 项目 | AstrBot | 气泡分条(v0.18.0,从 A 侧 v8.10.0 原样移植) | dsh-echo/lib/toggle.js:750 |
| 项目 | dsh-hooks-claude-code | 出处与接口(照真在跑的消费者抄):dsh-hooks-claude-code/lib/index.js:265 | dsh-echo/lib/tool-audit.js:8 |
| 其它/内部出处 | docs/PLAN_PROACTIVE_TOPIC_SCORER_CODE.md | 出处:docs/PLAN_PROACTIVE_TOPIC_SCORER_CODE.md §2.1 / §3.5 / §4 | dsh-echo/lib/topic-score.js:4 |
| 项目 | AstrBot | A 侧出处:brain_pipeline.py:1234-1240 从 _interrupted_tail pop | dsh-echo/lib/turn-snapshot.js:240 |
| 项目 | AstrBot | A 侧 main.py:1855-1900 的逐字移植 | dsh-echo/lib/turn-snapshot.js:247 |
| 其它/内部出处 | 设计文档 04 | 硬保证(设计文档 04 §turn-stopping) | dsh-echo/lib/turn-stopping.js:2 |
| 项目 | dsh-roleplay | 参考实现(dsh-roleplay 的 choice-mode)给的血泪教训 | dsh-echo/lib/turn-stopping.js:9 |
| 项目 | dsh-roleplay | 防重复 steer(参考实现的 Map<sessionId, turn>) | dsh-echo/lib/turn-stopping.js:153 |
| 项目 | heart-tts | 语音回执账(voice_receipts)—— heart-tts 的 voice.external / voice.interrupted 落账 | dsh-echo/lib/voice-receipts.js:2 |
| 项目 | heart-tts | 背景:heart-tts v1.2.0(主对话 DSH+TTS 的语音输出)按契约软发现 | dsh-echo/lib/voice-receipts.js:4 |
| 项目 | Cortico | 借 Cortico 的做法(persona/rhythm.ts:44-83) | dsh-echo/lib/wake-tools.js:6 |
## python/
| 项目 | AstrBot | main.py:_pick_agenda/_mark_agenda_used 逐字移植 | dsh-echo/python/engine/agenda.py:2 |
| 项目 | AstrBot | v0.18.0 气泡分条(A 侧 split_bubbles 移植) | dsh-echo/python/engine/db.py:213 |
| 项目 | AstrBot | 引擎扩展列:AstrBot 图引擎需要、JS 基线 DDL 没有的 | dsh-echo/python/engine/db.py:234 |
| 项目 | AstrBot | DMAE v6.0 数学 —— brain_pipeline.py:105-384 逐字移植 | dsh-echo/python/engine/dmae.py:2 |
| 项目 | AstrBot | DMAE v6.0 可调参数集(默认值与 AstrBot 逐字段一致) | dsh-echo/python/engine/dmae.py:23 |
| 项目 | AstrBot | echo_memory_engine._insert_memory:647-761 逐字移植 | dsh-echo/python/engine/episodic.py:2 |
| 论文 | LongMemEval | 写入侧的「说法键」(fact-augmented keys,LongMemEval 里的 +9.4% 那一招) | dsh-echo/python/engine/episodic.py:102 |
| 项目 | AstrBot | 逐字移植 A 侧 echo_memory_engine._cleanup_stale_memories:1239-1257 | dsh-echo/python/engine/episodic.py:267 |
| 项目 | AstrBot | 这是唯一不可逆的入口,所以语义上照抄 A:只清情景记忆与画像 | dsh-echo/python/engine/episodic.py:327 |
| 项目 | AstrBot | AstrBot 移植源与行号: | dsh-echo/python/engine/graph.py:4 |
| 项目 | AstrBot | 常量(与 AstrBot 逐值一致) | dsh-echo/python/engine/graph.py:48 |
| 项目 | AstrBot | 三层防线(brain_pipeline.py:1496-2071 逐字移植) | dsh-echo/python/engine/judge.py:9 |
| 项目 | AstrBot | 规则照抄 A:say_again 只认 1,其余一律 0;extra_reply 裁到 80 字 | dsh-echo/python/engine/judge.py:718 |
| 项目 | dsh-auto-memory | 单字 CJK 一律丢弃:噪声大,参考实现(dsh-auto-memory […] | dsh-echo/python/engine/lexical.py:25 |
| 论文 | LongMemEval | 就写好的"以后他可能怎么问这件事"的说法(LongMemEval 的 fact-augmented keys) | dsh-echo/python/engine/lexical.py:184 |
| 项目 | AstrBot | 想念值引擎(M2-f)—— brains/echo_longing.py 逐字移植 | dsh-echo/python/engine/longing.py:2 |
| 论文 | AstrBot 侧论文推荐值 | AstrBot 论文推荐值(壳侧面板配置由 M3 心跳层喂进来) | dsh-echo/python/engine/longing.py:37 |
| 论文 | AstrBot 侧论文推荐值 | AstrBot 论文推荐值(echo_constants.py 逐字) | dsh-echo/python/engine/longing.py:54 |
| 论文 | HippoRAG | 概念↔记忆行(照 HippoRAG:节点与记忆同图) | dsh-echo/python/engine/ppr.py:16 |
| 项目 | AstrBot | main.py:_run_reflection@1910 逐字移植 | dsh-echo/python/engine/reflection.py:2 |
| 项目 | AstrBot | DSH 帧拆分:AstrBot 在一个函数里做「读窗口→判触发→跑 LLM→落库」 | dsh-echo/python/engine/reflection.py:20 |
| 项目 | AstrBot | 候选情感分累计阈值(AstrBot 默认) | dsh-echo/python/engine/reflection.py:31 |
| 项目 | AstrBot | AstrBot 原版这里无条件 +1(工单数,不是退役数) | dsh-echo/python/engine/reflection.py:257 |
| 论文 | Zep/Graphiti (arXiv:2501.13956) | 只在「语义相关且时间重叠的矛盾」上 | dsh-echo/python/engine/relations.py:17 |
| 论文 | Mem0 (arXiv:2504.19413) | 每条新事实由 LLM 显式判 | dsh-echo/python/engine/relations.py:19 |
| 论文 | MIRIX (arXiv:2507.07957) | 语义条目「除非被概念性覆盖,否则长期保留」 | dsh-echo/python/engine/relations.py:21 |
| 论文 | A-MEM (arXiv:2502.12110) / RAPTOR (arXiv:2401.18059) | 一条记忆… | dsh-echo/python/engine/relations.py:22 |
| 论文 | KAG (arXiv:2409.13731) | KAG(arXiv:2409.13731)把这… | dsh-echo/python/engine/relations.py:98 |
| 其它/内部出处 | RELATION_ALIASES 注释 | 两条纪律(继承自既有 RELATION_ALIASES 的注释,现在搬到这里) | dsh-echo/python/engine/relations.py:102 |
| 项目 | AstrBot | 情景记忆检索(M2-b3)—— echo_memory_engine.py:948-1132 逐字移植 | dsh-echo/python/engine/retrieve.py:2 |
| 项目 | AstrBot | JS M1 的 L0 上限误写 4,AstrBot 真值 8 | dsh-echo/python/engine/retrieve.py:34 |
| 论文 | LongMemEval | 时间臂(2026-09-30,默认关;LongMemEval 的 time-aware query expansion) | dsh-echo/python/engine/retrieve.py:82 |
| 项目 | AstrBot | 关键词解析:JSON 数组优先,兼容 AstrBot v5.x 逗号拼接旧格式 | dsh-echo/python/engine/retrieve.py:115 |
| 项目 | AstrBot | AstrBot 原文跑两轮切分(第二轮字符集是第一轮的子集,防御性冗余) | dsh-echo/python/engine/retrieve.py:142 |
| 论文 | LongMemEval | 时间臂(默认关):LongMemEval 的 time-aware query expansion | dsh-echo/python/engine/retrieve.py:218 |
| 项目 | AstrBot | brain_pipeline.py:762-780 逐字移植(行首 '- ',不编号) | dsh-echo/python/engine/retrieve.py:606 |
| 项目 | AstrBot | AstrBot echo_memory_engine.py:766-946 的逐字移植 | dsh-echo/python/engine/threads.py:4 |
| 项目 | AstrBot | 与 AstrBot 的两处显式偏差(可观测性增强,不改变行为) | dsh-echo/python/engine/threads.py:19 |
| 项目 | AstrBot | 列名 snake_case(与 AstrBot 返回字典、JS 面板消费形状一致) | dsh-echo/python/engine/threads.py:26 |
| 项目 | AstrBot | 空白折叠 + 300 字硬顶(AstrBot 同款规整) | dsh-echo/python/engine/threads.py:36 |
| 论文 | LongMemEval (arXiv 2410.10813, ICLR 2025) | LongMemEval 对"时间推理"给的 | dsh-echo/python/engine/timeintent.py:4 |
| 项目 | AstrBot | 时间解析(M2-b4)—— core/echo_utils.py:130-259 逐字移植 | dsh-echo/python/engine/timeutil.py:2 |
| 项目 | AstrBot | 与 AstrBot 同构 —— 不按 userId 过滤 | dsh-echo/python/engine/worker.py:280 |
| 论文 | AstrBot 侧论文推荐值 | 最低半衰期 […] 缺省用论文推荐值 | dsh-echo/python/engine/worker.py:567 |
| 项目 | AstrBot | 语义与 AstrBot 相同:人到了,想念才落地 | dsh-echo/python/engine/worker.py:594 |
| 项目 | AstrBot | 读取侧 = AstrBot 大脑1 的图部分:load → 直扫打底 → LLM 种子 | dsh-echo/python/engine/worker.py:916 |
| 项目 | AstrBot | ltpEdgeIds = 仅非pinned路径边(LTP 只打路径边 —— AstrBot 同款) | dsh-echo/python/engine/worker.py:920 |
| 项目 | AstrBot | JS DDL 建的表与索引,引擎库里必须都在(引擎有 AstrBot 侧的历史表) | dsh-echo/python/tests/test_ddl_parity.py:11 |
| 项目 | AstrBot | v0.18.0 气泡分条(A 侧 split_bubbles 移植):这四列是有意变更 | dsh-echo/python/tests/test_ddl_parity.py:159 |
| 项目 | AstrBot | 数学差分锚点 —— 数值即规格(与 AstrBot/JS 基线三方一致) | dsh-echo/python/tests/test_graph.py:25 |
| 论文 | AstrBot 侧论文推荐值 | 帧携带配置:显式 0 合法(v8.7.2 语义),缺省用论文推荐值 | dsh-echo/python/tests/test_longing.py:68 |
| 项目 | AstrBot | 关怀心跳只对「她聊过的那个会话」开口(AstrBot 安全默认) | dsh-echo/python/tests/test_longing.py:132 |
| 项目 | AstrBot | 直教 = stability 稳定 → tier 1.0(AstrBot 权重表原语义) | dsh-echo/python/tests/test_memory_tools.py:92 |
| 论文 | HippoRAG | 路径该经过记忆行(HippoRAG 的同图口径) | dsh-echo/python/tests/test_ppr.py:113 |
| 项目 | AstrBot | AstrBot v5.x 逗号串关键词(DSH 修复,与 JS safeJsonArray 对齐) | dsh-echo/python/tests/test_retrieve.py:80 |
| 项目 | AstrBot | 上限 8 生效:topK=12 时 L0 占 min(8, 10)=8 席(AstrBot 真值) | dsh-echo/python/tests/test_retrieve.py:140 |
| 项目 | AstrBot | 直接调 engine/threads.py,逐条验证 AstrBot 语义保真 | dsh-echo/python/tests/test_threads.py:5 |
| 项目 | AstrBot | AstrBot echo_memory_engine.py:766-946 语义逐条保真 | dsh-echo/python/tests/test_threads.py:22 |
## scripts/
| 其它 | (草稿区) | .scratch = 仓库里唯一的草稿区:检索实验的 dump / 论文 HTML | dsh-echo/scripts/check-bom.mjs:19 |
| 其它/内部出处 | lib/memory-read-tools.js | 三个开关来源的判定与 lib/memory-read-tools.js 的 memoryToolsEnabled 同源 | dsh-echo/scripts/enable-memory-tools.mjs:11 |
| 其它/内部出处 | docs/PLAN_MEMORY_GRAPH.md | docs/PLAN_MEMORY_GRAPH.md 把「时间相邻 + 共现统计」定为新增边的两条主来源 | dsh-echo/scripts/graph-baseline.mjs:69 |
| 其它/内部出处 | python/engine/topics.py | 因为提示词与校验规则只能有单一出处;这里只做编排 + 报告 | dsh-echo/scripts/graph-topics-build.mjs:6 |
| 项目 | AstrBot | 记忆搬家:AstrBot 活库 → 本地 echo.db(一次性,M1-d) | dsh-echo/scripts/import-astrbot.mjs:3 |
| 其它/内部出处 | lib/preset-patch.js | 住在 preset 平面(见 lib/preset-patch.js 的详细出处) | dsh-echo/scripts/install-preset.mjs:14 |
| 项目 | AstrBot | R1 · 增量合并:AstrBot 活库 → 本地 echo.db(M1-e) | dsh-echo/scripts/merge-astrbot.mjs:3 |
| 项目 | AstrBot | A 侧审计留档(AstrBot 时期) | dsh-echo/scripts/merge-astrbot.mjs:287 |
| 项目 | AstrBot | (文件被占用?先停用老插件/重启 AstrBot) | dsh-echo/scripts/retire-a-side.mjs:238 |
| 项目 | AstrBot | 默认插件根 = AstrBot 数据目录的 astrbot_plugin_memory_middleware | dsh-echo/scripts/smoke_shared_soul.mjs:14 |
## tests/
| 其它 | 宿主契约 | 字段逐字照抄宿主 childSessionMeta() | dsh-echo/tests/agent-scope.test.js:18 |
| 其它 | 开源社区/学术论文(泛称) | 其中 #248 就是[…]「去开源社区与学术论文里找现成图谱实现作参照」的那条请求 | dsh-echo/tests/cleanup-guard.test.js:6 |
| 项目 | AstrBot | v0.6.0 钟面 + 想念行 + 情绪剧本(QQ 已验证机制移植) | dsh-echo/tests/context.test.js:55 |
| 项目 | AstrBot | daypartLabel 时段词边界(echo_utils 移植) | dsh-echo/tests/context.test.js:57 |
| 项目 | AstrBot | 对账基准 = AstrBot audit/echo_audit_dashboard.py 的 API 层 | dsh-echo/tests/dashboard.test.js:3 |
| 项目 | heart-tts | 口径与 heart-tts 一致 —— 正则源头 dsh-plugin-heart-tts-main/host/impl.js:148 | dsh-echo/tests/emo-marker.test.js:5 |
| 项目 | AstrBot | 动力学移植。测试逐条对齐 A 的边界 | dsh-echo/tests/emotion.test.js:3 |
| 其它 | (未具名参考实现) | 轮末硬保证的挂点纪律(参考实现的血泪) | dsh-echo/tests/events.test.js:187 |
| 项目 | contextual-neural-map | 投影由参考实现的结论改成"只给该强调的节点" | dsh-echo/tests/graph-force.test.js:227 |
| 项目 | contextual-neural-map | 参考实现:contextual-neural-map 的边色 #cdc6bb / #a09888 / #8a8279 | dsh-echo/tests/graph-force.test.js:266 |
| 项目 | contextual-neural-map | 状态靠虚线区分(参考实现用 5,4 / 8,3 区分关系类型) | dsh-echo/tests/graph-force.test.js:280 |
| 项目 | contextual-neural-map | 标签默认是"暗"的(参考实现 opacity .55) | dsh-echo/tests/graph-force.test.js:314 |
| 项目 | AstrBot | v0.14.5 S12:框架纪律与接地字段(照抄 A 的两套提示词) | dsh-echo/tests/heartbeat.test.js:802 |
| 项目 | neuro-sdk | F4 插入优先级四档的电池(出处 neuro-sdk API/SPECIFICATION.md:160) | dsh-echo/tests/insert-priority.test.js:2 |
| 项目 | AstrBot | plugin_set —— AstrBot 的启用面 | dsh-echo/tests/preflight.test.js:7 |
| 项目 | AstrBot | AstrBot 的启用面(权威):turn_off_plugin 往这张表里塞 | dsh-echo/tests/preflight.test.js:56 |
| 项目 | dsh-agent-preset 0.2.0-rc.2 | 声明(见 lib/preset-patch.js 里的出处引文) | dsh-echo/tests/preset-declaration.test.js:4 |
| 项目 | dsh-agent-preset 0.2.0-rc.2 | (0.2.0-rc.2 实读,缩进照抄) | dsh-echo/tests/preset-declaration.test.js:8 |
| 项目 | AstrBot | A 侧出处:main.py:1855-1900 _build_proactive_line | dsh-echo/tests/proactive-ack.test.js:4 |
| 其它/内部出处 | lib/index.js | 接线照抄 lib/index.js 的 mouthOpen | dsh-echo/tests/relay-gate.test.js:6 |
| 项目 | AstrBot | 剥命令动词表里连「给」一起剥掉 —— A 侧原样照抄 | dsh-echo/tests/reminder.test.js:12 |
| 项目 | AstrBot | 强制占位上限 8 生效(AstrBot 真值) | dsh-echo/tests/retrieve.test.js:148 |
| 其它/内部出处 | python/engine/db.py | python/engine/db.py 的 _repair_dangling_superseded 只清引用、不复活 is_active | dsh-echo/tests/store.test.js:99 |
| 项目 | AstrBot | 关键词格式兼容:JSON 与 AstrBot v5.x 逗号拼接 | dsh-echo/tests/store.test.js:219 |
| 项目 | AstrBot | 归属简化:单主人 + 全局状态(AstrBot 多会话 → 单主人) | dsh-echo/tests/store.test.js:231 |
| 项目 | AstrBot | busy_timeout:对齐 python 引擎与 AstrBot 侧的 5000ms | dsh-echo/tests/store.test.js:454 |
| 其它 | 宿主契约 | subagents.start 起一个子代理会话(header 逐字照抄宿主) | dsh-echo/tests/subagent-recursion.test.js:38 |
| 其它 | 宿主契约 | claim 的接线照抄 index.js,但故意少掉那一层 | dsh-echo/tests/subagent-recursion.test.js:40 |
| 项目 | AstrBot | 调参:文件缺失 → 全套默认值(A 侧默认照抄) | dsh-echo/tests/toggle.test.js:313 |
| 项目 | dsh-roleplay | 挂点的血泪(参考实现 dsh-roleplay 的注释原文) | dsh-echo/tests/turn-stopping.test.js:4 |
## web/
| 其它 | (未具名参考实现) | 全部 textContent,不拼 innerHTML(参考实现不留 XSS 坏习惯) | dsh-echo/web/app.js:6 |
| 其它/内部出处 | docs/ARCHITECTURE.md | 会话 → 来源。DSH 里会话的三种 id 形状(见 docs/ARCHITECTURE.md) | dsh-echo/web/audit-view.js:106 |
| 其它/内部出处 | lib/store.js | 候选来源:真图谱端点(由 lib/store.js 的 graphData() 供) | dsh-echo/web/views/aliases.js:38 |

