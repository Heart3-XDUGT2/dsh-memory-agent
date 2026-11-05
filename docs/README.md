# docs/ 文档索引

当前预发布先读[安装与排障](INSTALL.md)、[可复现测试](TESTING.md)、
[发行说明](releases/0.46.0-rc.1.md)、[API](API.md)及[第三方来源](../THIRD_PARTY.md)。
下面的研究、迁移和现场记录保留历史上下文，不代表当前安装步骤或本轮验证结果。

这份索引的存在理由:2026-09-26 清完一次仓库,把「已经落地」的施工文件挪进了
`archive/`(见 `archive/README.md` 的规矩)。以后谁打开 docs/ 应该一眼知道
**哪几份是现在还要照着做的**。

2026-09-28 G5 对齐过一遍:① 删掉了指向已归档文件的行(`RELAY_PLAN.md` 那种 ——
照着一份不存在的文件找东西最浪费时间);② 把这两轮新写的文档补进来;
③ 每个名字都点得到(根 `README.md` 的「文档地图」也列了全部,`npm run hygiene`
第 4 段因此归零)。

## 现在还要照着做的

| 文件 | 是什么 |
| --- | --- |
| `PLAN_ROUND2.md` | **当前主线**:第二轮总计划 —— 参考资料余量(A 余/C 余/F4/E/G5/H)+ 检索第二轮(RT9→RT13)。**进度表在文末** |
| `PLAN_LAND_ALL.md` | 第一轮落地总计划(参考资料余量账本;A0/A1a/B1–B5/C5/F1–F3/G1–G3 已 ✅) |
| `PLAN_CORTICO_ADOPTION.md` | H 批主线(H1 语音通道 = P3 语音平台;**唯一主体是她,QQ/语音只是工具与通道**) |
| `CORE_IN_DSH_PLAN.md` | 核心归位 DSH —— R1 数据合并 → R2 传话桥 → R3 A 侧薄壳 → R4 切换退役 |
| `RETIRE_OLD_CHAIN_PLAN.md` | R4 的拔管清单(A 侧怎么退、退到什么程度、哪些不许动) |
| `R4_ACCEPTANCE.md` | 切换前后的验收记录(现场数据,答辩也用得上) |
| `DISCIPLINE.md` | **仓库纪律(reason 与留痕)**:每条闸为什么存在、失败必须可见、不许静默 |
| `VOICE_BASELINE_2026-09-26.md` | **她的语域基线**(他说「很冷硬」→ 量出来的尺子与数字,含一次「量错列」的纠错史)。复量用 `npm run voice` |
| `VOICE_INTERFACE_DRAFT.md` | 语音通道 · 接口草案(给前端 TTS + Live2D) |
| `RETRIEVAL_PLAN.md` | 检索三漏洞修复计划(RT0–RT8 已落地,含 48 条金标) |
| `RETRIEVAL_RESEARCH.md` | 检索升级:开源与学术侧的现成解法(取证 + 方案 —— 向量臂/同义词臂的依据) |
| `FIX_PLAN.md` | 检索链修复工单(2026-09-27 取证) |
| `HAZARD_AUDIT_2026-09-26.md` | 27 条隐患台账(六族:A 上下文只进不出 / B 无事务幂等 / C 闸认元数据 / D 主动关怀后路 / E 退役闸看不见卫星 / F 死列脏值),含已复现 vs 推断标签与修复顺序 |
| `LIVE_CHECK_2026-09-26.md` | Live 验证清单(2026-09-26 傍晚,重启后) |

## 参考/事实源(改动前先读)

| 文件 | 是什么 |
| --- | --- |
| `ARCHITECTURE.md` | **全项目机制与架构总入口**(v0.30.1 写):一份文档读懂整个项目 —— 全局架构/数据流/DMAE 数学/心跳与桥/前端两块/版本史/他的裁决/装机纪律。新人先读这份 |
| `REFERENCE_ANALYSIS.md` | **参考资料全分析**:桌面 `参考资料/` 下 21 个开源项目的逐项精读 + 对 dsh-echo 的可借鉴清单(按 ★ 优先级)+ 明确不该抄的 + **落地状态表**(哪些已搬、落哪一批)。**含 DSH 宿主扩展点全清单(事件/插槽/服务/工具契约)** |
| `REFERENCE_CORTICO_2026-09-28.md` | Cortico 源码分析(2026-09-28):同题作文,能抄什么(契约版本 / 可观测性 / 注入位置) |
| `TEAMMATE_EMOTION_REVIEW.md` | 队友情绪插件评审(`dsh-pad-emotion` / `dsh-interpersonal-circumplex`):C1 情绪单轮闭环的出处 |
| `API.md` | 面板后端 API(`web/app.js` 与它对齐) |
| `MEMORY_ARCHITECTURE.md` | 记忆库现状与字段语义(`scripts/memory-doctor.mjs` 引用) |
| `MEMORY_DEDUPE_REVIEW.md` | 去重判据的复核(`scripts/memory-dedupe.mjs` 引用) |
| `GRAPH_MERGE_REVIEW.md` | 图合并判据(`scripts/graph-merge.mjs` 引用) |
| `DB_MERGE_ANALYSIS.md` | A→DSH 库合并分析(`scripts/merge-astrbot.mjs` 引用) |
| `ASTRBOT_PLUGIN_ARCHAEOLOGY.md` | A 侧插件考古(`archive/astrbot_adapter/relay_core.py` 引用) |
| `QQ_BRIDGE_DIY_PLAN.md` | QQ 桥 DIY 换装计划(借现成 OneBot 层 + 拆成独立插件 —— 今天 `dsh-echo-qq` 那份) |
| `PLAN.md` | v4 总架构与迁移计划(A 侧适配器代码仍指向它,已归档) |
| `CODE_AUDIT_2026-09-26.md` | 全仓审查 2026-09-26(卫生与功能问题) |
| `PORT_GAP_AUDIT_2026-09-26.md` | A → B 逐项对账总表(2026-09-26 当晚) |
| `DEFENSE.md` | **答辩材料**:演示剧本 + 技术叙事 + 防守问答 |
| `astrbot-audit-2026-09-25T13-07-13-030Z.md` | A 侧真机审计的可读版(原始 3.18MB json 已删,需要时从 git 历史取) |

## 工具

- `npm run hygiene` —— 仓库卫生报告(没人引用的 import / 过导出 / 工作区垃圾 /
  没人引用的文档)。只提示,不判死;清理规矩见 `archive/README.md`。
  2026-09-28 G5 之后四段全空 —— 再冒出条目就是新东西,别再当成"历史遗留"。
- `npm run check` —— 门(真调用冒烟 + 全部 JS 语法 + 无 BOM + 工具 schema 对齐)。
- 文档地图的一行版在根 `README.md`(给站在仓库门口的人看的)。
