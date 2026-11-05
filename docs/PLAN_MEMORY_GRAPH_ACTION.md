# 记忆图谱施工细则（PLAN_MEMORY_GRAPH_ACTION）

- **性质**：**施工细则**。供父代理在动手时**逐阶段对照阅读**。本文不代表任何代码已改动：未改源码 / config / tests，未 commit，未重启 host。
- **日期**：2026-10-01。**版本**：v1 初稿（按人类 2026-10-01 批准的三项裁决 + 阶段清单 0→6 展开）。
- **编码**：UTF-8 无 BOM（写完复检前 3 字节 ≠ `EF BB BF`）。
- **素材**：阶段清单（父代理给定）+ `docs/MEMORY_ARCH_SURVEY.md` + `docs/PLAN_MEMORY_GRAPH.md` + 父代理给定的"纪律与坑"与"现状数字"。
- **不写"要不要做"的辩论**：三项裁决人类已批准（见 §0.2），本文只写**怎么改、什么形状、怎么验、怎么回滚**。

---

## §0 本文件是什么、怎么用

### 0.1 三份文档的分工（不重叠）

| 文档 | 行数 | 回答的问题 | 不做什么 |
|---|---|---|---|
| `docs/MEMORY_ARCH_SURVEY.md` | **769**（给定 765 / 实测 769） | **别人怎么做**：22 个架构横表 + 逐个详述 + 六条横向专题 + **口径与可比性** + 未读到清单 | 不给我们的施工步骤 |
| `docs/PLAN_MEMORY_GRAPH.md` | 495 | **我们的诊断与决策点**：星形成因、C1–C13 冲突、R1–R6 规则、D1–D7 待裁决项 | 不把决策点展开成逐阶段施工细则 |
| **本文件** | — | **逐阶段施工细则**：每阶段 = 改什么 / 什么形状 / 怎么验 / 怎么回滚 / 花几次模型调用 / 前置依赖 / 坑 | 不重述调研、不重开决策辩论 |

**引用习惯（全文强制）**：凡引既有文档的数字，一律带 `文件:行`；凡跨快照比较，一律带**快照日期**（照 `PLAN_MEMORY_GRAPH.md` §3.5(4) 与 `RETRIEVAL_BASELINE.md` 的规矩）。凡本文未给出依据的字段，一律进 §11「未确认的事」，**不许含糊**。

### 0.2 已获人类批准的三项裁决（**人类 2026-10-01 批准**）

1. **`D10.6` 最小解除**：旧文档 `CORE_IN_DSH_PLAN.md:393` 的"不引第二套记忆：分层记忆 / 向量 / RRF / 第二真相源一律不进（D10.6）"—— **放行"只读扩散"**（它**不新增存储**），**收紧"episode 节点"**。
   - 落地含义：阶段 4 的 PPR 是**纯图计算、只读、零新增存储**，故在解除范围内；阶段 3b 的 `episode` 节点必须做成**最小形态**（见 §5），不许借机扩成一层新记忆。
2. **D1**：允许**最小 `episode` 节点**作时间边端点 —— 但**只作端点**，**不进 L0 / 画像 / 人格注入通道**。
3. **阶段顺序**：**`0 → 1 → 2 → 3a → 3b → 4 → 5 → 6`**。每阶段**可独立停下**，失败即回滚到上一阶段，**不留半成品**。

### 0.3 阶段一览与依赖

| # | 做什么 | 关键验收 | 模型调用 | 前置 |
|---|---|---|---|---|
| 0 | 只读测算 + 灰盒开关：把"白送路网"变成可复现基线 | 复现 216 / 30→5 / 94→42 等一串现状数字 | 0 | 无 |
| 1 | 写入侧去噪闸门 + 真值回执 + 补 `node_type` | 0 条泄漏；规则每条带单测；幂等复跑改动数 = 0 | 0 | 0 |
| 2 | 记忆工具化（agent 可迭代调用） | "能否多查一轮"差异报表；**负控逐位一致** | 0 | 1 |
| 3a | 共现影子边（端点 = 既有概念节点，`kind='cooccur'`，先不接检索） | ≤5（同记忆）/ ≤42（同天）；默认关时活跃边 **=23 不变** | 0 | 1、2 |
| 3b | 时间影子边（`kind='temporal'`，需最小 `episode` 节点） | ≤216；与 3a **互不干扰** | 0 | 3a、1（R6） |
| 4 | 只读 PPR 扩散（端口移植 MIT 实现，保留声明；修 `load()` 可见性） | **PPR 必须收敛**；排序差异报表标"未确认增益" | 0 | 3a+3b；**BFS 种子先修**（见 §6 坑） |
| 5 | 遗忘形状：冻结 ≠ 删除（纯增 `valid_from`/`valid_until` + 软删列 + 版本/oplog 表） | "上个季度我们以为是什么"可查；冻结节点全历史保留；保护不再恒 0 | 0 | 1 |
| 6 | 写权分离 + 离线巩固（用已有的 **7 个通道 / 2 个启动点**） | 整理前后可 diff、回滚演练成功、审计链完整、token 有上限 | **有**（离线·受预算约束） | 5；全部 |

### 0.4 全局约束（开工前先背）

- **默认关 = 零行为变化**；**纯增不改**；**只允许 `ALTER TABLE ADD COLUMN`**。
- **不碰三条红线**：压缩域 / 人格注入点 / QQ 桥 `lib/relay.js`。**不做新开口点**。
- **P4 类自产物不得污染主记忆**（必须落在 `episodic_memory` / 图谱 / L0 之外）。
- **三道闸 + BOM 闸**：`npm test`（`node --test tests/*.test.js`）/ `npm run check`（`smoke-lib` + `check-syntax` + `check-bom` + `check_tools`）/ `npm run test:py`（`python -m unittest discover -s python/tests`）；BOM 闸本体是 `scripts/check-bom.mjs`。**新增规则若无单测，视为未落地**。
- **未获明确许可不 commit**、**绝不 `git add -A`**；**失败必须可见**（`docs/DISCIPLINE.md` 规矩 2）：每次丢边 / 改边 / 跳过都留一行可查的痕 + `reason` 枚举，**禁止静默跳过**。

### 0.5 现状数字（验收基线，快照 2026-10-01）

- 节点 **28**（全 `concept`）、边 **42**（**活跃 23**）、`is_protected=1` **0 个**（空真 / 死分支）。
- 度最高 `用户` **20**；**不含用户节点的活跃边 ≤2**；**度 0 节点 8**；`episodic_memory` **活跃 217**（提到 ≥1 个已知节点 **191** / ≥2 个 **85**）。
- 候选量：**时间边 216**；**同记忆共现 30 → 去噪 5**；**同天共现 94 → 去噪 42**。
- 桥节点度数：`音理` 29 / `校园跑` 19 / `章鱼小丸子` 19 / `做章鱼小丸子` 15 / `新工科大学` 10。
- 强共现对：`Echo–用户` 27 / `Echo–她` 16 / `校园跑–用户` 11 / `Echo–音理` 8 / `做章鱼小丸子–章鱼小丸子` 4；同天 `校园跑–章鱼小丸子` 3 / `<称呼>–音理` 4；**反例锚**：`3km速度限制` / `Echo记忆架构` / `软件工程专业` **在任何共现里都不出现**。
- **只读快照（开工前钉住，2026-10-01）**：`.scratch/echo-db-snapshot-306.db`（`.scratch/` 已 gitignore），`sha256=36a8bd37b670b7f54d174854f62f1d1818f93396b701db3d9d8b98104557c648`，1,159,168 字节；读数 **节点 28 / 边 42 / 活跃 23 / 活跃记忆 222 / 全部记忆 312 / max_memory_id 312 / 别名 13 / node_type 全 concept**，且**无 `kind` 列、无 `graph_edge_receipts` 表**（迁移尚未落到活库）。用它复现上面两条候选基线（`--max-memory-id 306` ⇒ 同记忆 30 / 同天 94）。

---

## §1 阶段 0 —— 只读测算 + 灰盒开关

### ① 目标
把"白送路网"从一次性测算变成**可复现的只读基线**，并给后续所有改动装上**默认关**的灰盒开关。

### ② 改动面
- **纯增**只读测算脚本（放 `scripts/`，与既有 `scripts/graph-*.mjs` 同族）；**不改 `python/engine/graph.py` 写路径**、**不改 schema**、不改 `python/engine/db.py` DDL。
- 灰盒开关：**环境变量级、默认关**；关时必须与现状逐位一致。
- 只读：脚本对本阶段**只 SELECT、不 INSERT / UPDATE / DELETE**。

### ③ 数据形状
- 每条候选边一行：`{source_id, target_id, kind: temporal|cooccur_same_memory|cooccur_same_day, evidence_memory_id, speaker_node_excluded: bool}`。
- 报表字段：`{count, dropped_by_reason: {speaker-endpoint, zero_overlap, alias_missing, type_illegal, slot_conflict, no_occurred_at}, degree_map: {node_name: degree}, strong_pairs: [{a, b, n}]}`。
- 函数签名级：`measure_edges(conn, owner_key, *, kinds: list[str], include_speaker: bool) -> report_dict`（描述级，不贴实现）。

### ④ 验收（可测数字，命令级）
- 逐一复现：时间边候选 **216**、同记忆共现 **30 → 去说话人 5**、同天 **94 → 去噪 42**。
- 桥节点度数逐一命中：`音理` 29 / `校园跑` 19 / `章鱼小丸子` 19 / `做章鱼小丸子` 15 / `新工科大学` 10。
- 强共现对逐一命中：`Echo–用户` 27 / `Echo–她` 16 / `校园跑–用户` 11 / `Echo–音理` 8 / `做章鱼小丸子–章鱼小丸子` 4；同天 `校园跑–章鱼小丸子` 3 / `<称呼>–音理` 4。
- **反例断言**：`3km速度限制` / `Echo记忆架构` / `软件工程专业` 在**任何共现结果里都不出现**。
- 命令级描述：跑一次测算脚本 → 输出报表 → 断言上列每个数字；再跑一次 → **报表逐位一致**（只读天然幂等）。

### ⑤ 回滚
删脚本 + 关开关；**零残留**（无写入 ⇒ 无需数据回滚）。

### ⑥ 模型调用
**0**。

### ⑦ 前置依赖
无。

### ⑧ 本阶段的坑
- **不许把测算写成"一次性结论"**：本阶段的产物是**基线**，后续每阶段都要拿它对照。
- **口径必须带快照日期**：旧文档记过 `graph_edges` 33 条 / `graph_nodes` 28→23、`LIVE_CHECK_2026-09-26.md:8` 记 24n/35e，与本轮 42/28 **口径不同** ⇒ 任何前后对比必须带日期（`PLAN_MEMORY_GRAPH.md` §6-14）。
- **`activation` 类死列**：`HAZARD_AUDIT_2026-09-26.md:69 F1` 记节点 `activation`/`recall_count`/`intrinsic_value` **24/24 全 0**，`FIX_PLAN.md:139` 记 `iv` 全 10.0 ⇒ 任何按这些列排序的逻辑对所有节点等价；本阶段**顺带只读复核**，不据此下结论。

**开工检查表（阶段 0）**
- [ ] 脚本只读已确认（无 INSERT/UPDATE/DELETE）
- [ ] 上述每个数字已逐一复现并落盘为基线报表
- [ ] 反例三词（`3km速度限制` / `Echo记忆架构` / `软件工程专业`）断言已过
- [ ] 灰盒开关默认关时基线逐位一致
- [ ] 复跑两次报表逐位一致

---

## §2 阶段 1 —— 写入侧去噪闸门 + 真值回执 + 补 `node_type`

### ① 目标
把去噪从"跑一次的清理"升级为**写入路径的常设闸门**，并让"改了什么、丢了什么"留下**可查回执**；顺带补上 `node_type` 真实写入，使按类型分支的逻辑可信。

### ② 改动面
- **写入侧唯一落点**：`python/engine/graph.py`（**Python 侧唯一写边路径**，`graph.py:88` 注释；`PORT_GAP_AUDIT_2026-09-26.md:61` 证明 `lib/` 侧 `graph_activate` grep = 0）。**不新增第二个写入源**。
- **DDL 纯增**：`python/engine/db.py` 用 `ALTER TABLE ADD COLUMN` 补列（幂等迁移，先查 `PRAGMA table_info` 再加；形状照 `db.py:5` 自述与 `db.py:251` 的既有补列先例）。
- **规则表纯增**：六条规则做成**可扩展的数据表/表驱动**，不改既有规则语义。
- **不物理删**：照 `FIX_PLAN.md:252-270` F10 的既有形状（变体 `is_active=0` 下线、不物理删）。
- 补 `node_type` 属**行为改动**（不属纯增）⇒ **必须默认关 + 可回滚**（`PLAN_MEMORY_GRAPH.md` §6-7b）。

### ③ 数据形状
- **规则表**：`{rule_id: R1..R6, action: drop|rewrite|keep, reason_enum, enabled: bool}`；`reason` 只许枚举（`DISCIPLINE.md` 规矩 1）。
- **真值回执**：`{ts, rule_id, action, reason, source_id, target_id, kind, evidence_memory_id, note}` —— 每次丢边/改边**留一行**。
- **回执落点（阶段 1b 已裁决，2026-10-01）**：落**新表** `graph_edge_receipts`（`db.py` 走 `CREATE TABLE IF NOT EXISTS`，纯增；字段含 `id/run_id/created_at/kind/source_kind/target_kind/source_id/target_id/action/reason/rule_id/occurred_at/occurred_at_source/evidence_memory_id/payload`）。**不落 JSONL**（事后不可 SQL 查）、**不复用 `audit_logs`**（无 `rule_id`/`reason` 维度，往 `tool_call` 文本里塞 = 把结构化审计降级成字符串）。写入侧只在开关开且真有裁决时写；开关关 ⇒ 表只建不写（空表）。
- **回执保留策略（阶段 1b 裁决②，2026-10-01）**：**默认不清理** —— 本轮不加清理任务、不碰 DMAE。**先量化每次运行行数**（同 `run_id` 幂等，跨 `run_id` 每次新增），增长失控再定保留期/上限。**只读**行数报表口径：`node scripts/graph-receipts-report.mjs [--db <path>] [--runs N] [--json]`（纯只读，`mode=ro` + `readOnly: true`，末尾比对库文件 mtime 未变；报表 = 总行数 / 按 `action`·`reason` 分组 / 不同 `run_id` 数 / 最近 N 个 `run_id` 各自行数与时间跨度）。等价 SQL：`SELECT COUNT(*) FROM graph_edge_receipts`；`SELECT run_id, COUNT(*) FROM graph_edge_receipts GROUP BY run_id ORDER BY MAX(id) DESC LIMIT N`。
- **时间来源白名单（阶段 1b 裁决 C，2026-10-01）**：写入侧只认 `episodic_memory` 与 `same_day_group`（同天边的"那一天"，本地 00:00 的 epoch 秒）两个来源，落在 `graph_gate.TIME_SOURCES_ALLOWED`（单一出处，单测钉住）；**`fallback_learned_at` 不进** —— 那是导出侧"拿 learned_at 兜底"的标注（系统时间 ≠ 发生时间），写入侧不许认它当发生时间。⚠️ 校准：R6 只作用于**时间边**（`if kind != KIND_TEMPORAL: return`），共现/同天边本来就不经过 R6 ⇒ 本条**不改同天边行为**，只是让"时间边若显式声明同天来源"不再被误杀。
- **候选挖掘的接法（阶段 3a 第一步，2026-10-01）**：接法 **A** —— 3a **在进程内按闸门入参直接构造候选**（`python/engine/graph_mine.py`），**不把 `scripts/graph-baseline.mjs` 的 NDJSON 契约文件当闸门输入**（契约只做导出/回归/审计的验收基线）。候选自带 `source_memory_ids` / `target_memory_ids`（**两端各自的记忆集，给 R2 用**；契约 v1.1 只有并集式 `evidence_memory_id`，只喂并集会令 R2 退化成"证据非空即过"）。挖掘**只读、只在内存里拼候选、绝不建节点**；落库仍只发生在 `graph_gate.write_accepted_edges`（开关开 + 闸门通过）。CLI `python -m engine.graph_mine --dry-run --db <path>` 只做 dry-run，显式拒绝 `--write`。
- **候选挖掘的两条口径 + 运行时纪律（阶段 3a 第二步，2026-10-01 裁决）**：挖**同记忆共现**与**同天共现**两类（`kind='cooccur_same_memory' / 'cooccur_same_day'`）；同天口径 = **按本地日期分组**、日内取"当天命中的节点并集"两两成对（**跨记忆的共现也算**）、`day` + `occurred_at` = 当天**本地 00:00**、`occurred_at_source='same_day_group'`、`weight=count=`**覆盖天数**、`evidence_memory_id` = 每天"提到各端的最晚一条"拼成的一小组（上限 16，**两端各保一条**）。**运行时纪律**：采用 **"一次性历史回填 + 运行时只挖刚写入的那一条记忆"**；**禁止"最近 N 条窗口"反复挖**（同一对会被反复重计）⇒ 不提供 `--last N`。两条基线（`--max-memory-id 306` 只读复现）：同记忆 **30 → R1 后 5**、同天 **94 → R1 后 42**。
- **reason 枚举单一出处（阶段 1b 已裁决）**：`python/engine/graph_gate.py:REASON_ENUM`（唯一一处）。六码之外**已批准两个扩展码**：`slot-conflict`（R5 槽位隔离）与 `internal-error`（异常降级 —— "异常一律视为 drop 并留 reason"需要它）；规则表登记的 `reason` 必须是它的子集（单测 `test_reason_enum_is_single_source` 钉住）。另：R4 表外谓词"不猜、放行"要**可审计** —— 单独计数 `counters["rule_table_miss"]` + 回执留痕（`note="rule-table-miss"`）。
- **`node_type` 写入**：`get_or_create_node`（`graph.py:220-248`）插入时**显式带 `node_type`**；`episode` 走 `node_type='episode'`（阶段 3b）。
- 函数签名级：`gate_edge(candidate, ruleset, conn) -> {verdict: keep|drop|rewrite, edge: candidate|None, receipt: dict}`。

### ④ 验收（可测数字）
- **泄漏率 0**：注入一批**含说话人节点**的构造输入（每条同时含 `用户` 与另一概念），断言共现边里**说话人端点数 = 0**。
- **规则每条带单测**（照 `DISCIPLINE.md` 规矩 3 / 规矩 4）。
- **幂等**：连跑两次闸门，**第二跑改动数 = 0**（形状照 `DB_MERGE_ANALYSIS.md:177-182`"复跑全 0 = 幂等验收"）。
- **负控 / 空转**：关掉闸门时读数与现状**逐位一致**。
- **别名（R3）**：`西电` 类输入落库后端点必须是 `西安电子科技大学`。
- **类型非法（R4）**：造非法端点类型，断言**要么被自动改正、要么不进图**，且**计数 +1**。
- **零重合（R2）**：构造一条"与查询零重合"的记忆，断言**不被标 `matched`**。
- **不伤 N2（C8）**：闸门开启后 **N2 档逐档不退**（并入判据门，不是只看总分）。
- **`node_type` 分支可信**：真写入后按类型分支的输出与预期一致。

### ⑤ 回滚
- 关闸门 → 写入路径回到现状（逐位一致）；规则表停用；新增列**保留但不读**（`ALTER TABLE ADD COLUMN` 可留）。
- `node_type` 分两步回滚：先关"补写开关"，再决定是否回填既有节点（**回填范围与方式未定**，见 §11）。

### ⑥ 模型调用
**0**。

### ⑦ 前置依赖
阶段 0（去噪规则与度数基线）。

### ⑧ 本阶段的坑
- **失败策略：能改则改、不能改则丢边、绝不拒写入主流程**（`PLAN_MEMORY_GRAPH.md` §4.5(4)）：丢边**可恢复**（边可重算），拒写入**不可恢复**（记忆丢了）。分层：R3 / R4 走**改**；R1 / R2 / R5 / R6 走**丢**。
- **R2 不得做成"检索层阈值拒答"**（C10）：`RETRIEVAL_ARCH_NOTES.md:961-985` 记各 gate 的"负:误取"**恒为 2**、正样本先被误杀（τ=0.90 时 15→8）⇒ 拒答只能落**渲染 / 标注层**。
- **R5 槽位隔离**：不得挤 `slot = source_id||'|'||relation`（`db.py:14` + `graph.py:331/:404-410`）；另 `ARCHITECTURE.md:184` 的 `UNIQUE(source_id,target_id,relation,owner_key)`（`db.py:171` 同形状）是**唯一性约束、不是去噪** ⇒ 新边必须自带新维度。
- **R6 时间只从 `episodic_memory` 取**：图侧时间列是死列，依据见 §11。
- **说话人节点污染共现**（§6-3）：同记忆共现 30 → 去说话人后仅 **5** ⇒ 噪声占 **5/6**，硬排除是必须的。
- **`node_type` 从未写入的直接后果**：28 个全 `concept`、`is_protected=0`；保护逻辑（`graph.py:414-415` 只认 `node_type='person'`）是**从未被触发的分支**（判定依据 `CODE_AUDIT_2026-09-26.md:206` B32；口径见 C5，`ARCHITECTURE.md:183` 本身是条件式陈述、不算打脸）。
- **去重 / 去噪不能盲抄**（C8）：签名去重曾让**纯向量反超全管线**（Hit@5 56.6 vs 51.6）；本仓 R5 同病（压成 67/67/67）⇒ 每条规则**对 N2 档单独测**，阈值 **data-dependent**。

**开工检查表（阶段 1）**
- [ ] 泄漏率 = 0（含说话人节点的构造输入已注入并断言）
- [ ] 六条规则每条都有单测，且三道闸全绿
- [ ] 幂等复跑改动数 = 0
- [ ] 关闸门时读数与现状逐位一致（负控）
- [ ] N2 档逐档不退
- [ ] `node_type` 真写入后按类型分支可信

---

## §3 阶段 2 —— 记忆工具化（agent 可迭代调用）

> **本节施工状态（快照 2026-10-01）**：**只做设计与只读原型**。
> 已落盘 = **本节文字** + **1 个新增只读脚本 `scripts/memory-tools-proto.mjs`**（原型与实测见 §3④ 与 §3⑧）。
> **未接线**：没注册任何工具、没改任何既有代码 / config / tests、没 commit、没重启 host。
> 本节所有"现状"数字都是**本轮在真实库上只读实测**的（口径见 §3④），与 §0.5 的旧快照**不逐位可比**（活库边跑边写）。

### ① 目标
把"记忆"从**每轮固定流水线**变成 **agent 能主动调用的工具**，并产出"**能否多查一轮**"的差异报表 —— 用来判断值不值得。

补一句划界：本阶段的"可迭代调用"是**工具化**（agent 自己决定要不要再问一次，且**默认关**），**不是**把多轮 LLM 检索塞回主路径。判据是报表上的 `new_hits`，不是"感觉更聪明了"。

### ② 改动面

#### ②a 本阶段实际落了什么（2026-10-01）
| 落点 | 是什么 | 是否碰红线 |
|---|---|---|
| `scripts/memory-tools-proto.mjs`（**新增 1 个文件**） | 最小工具集的**只读**原型 + "多一轮"差异报表 | 否（纯新增，不在任何在线路径上） |
| 本节（`docs/PLAN_MEMORY_GRAPH_ACTION.md` §3） | 设计文字 | 否 |

**既有代码改动 = 0 行。** 这条不是节约，是本阶段的验收前提：原型跑不出结果之前，不许动会话侧。

#### ②b "谁来调"的三个形态（含推荐）—— 本节的核心裁决项

三条形态都**不改** `load()`、**不改**既有打分器活路径；差别在"工具挂在谁身上"。

| # | 形态 | 具体落点（本轮核对过） | 改动面 | 碰红线? | 代价 | 能默认关? |
|---|---|---|---|---|---|---|
| **(a)** | **会话侧工具**（她自己在对话里多翻几次） | `lib/index.js:3793-3796` 的 `ctx.tools.register(defineTool(def))` —— 与 `echo_memory` 同一个注册点 | **1 个既有文件** + 新模块（本阶段硬边界**不允许**） | **否，但不干净**：它**不是**人格注入点、也不是压缩域；可是**工具 schema 每轮常驻上下文**，等于**跟压缩域抢预算**（压缩域是红线，不许为工具让路） | ① 4 个工具 schema 常驻 ≈ **400–700 token/轮**；② `echo_remember`（写）与 `memory.search`（读）**同处一个工具面**，模型容易以为自己"已经写过"；③ **工具只能注册、没法注销**（`lib/index.js:3835` 自述，`handRegistered` 幂等就是为这件事）⇒ "默认关"**只能启动时判**，运行中开不了 | 能，但弱：只能靠"启动时读开关，关就根本不注册" |
| **(b)** | **只在子代理通道里给记忆工具** | `lib/reflect.js:218` 的 `toolFilter: { allow: [] }` —— **现状：子代理一个工具都没有**（本轮实测核对） | **1–2 处**（`lib/reflect.js` 的 allow 列表 + 调用点），不新增开口点 | **否**。结构化子代理是**独立会话**，**不注入人格与记忆**（`lib/reflect.js` 的 `runStructured` 全链只递一段 prompt）⇒ 天然不与人格局 / 压缩域重叠 | ① **主对话轮拿不到** ⇒ 不解决"她自己在对话里多翻几次"，只解决"离线 / 后台多轮查"；② 子代理会话的上下文是**新的**，"多一轮"省不下主轮的预算；③ 得先把 `runStructured` 的 `allow` 参数化（今天是硬编码空数组） | 能：`allow` 列表按开关拼装（空数组 = 逐位不变） |
| **(c)** | **只读 CLI / 脚本**（给人工与离线任务用） | 就是 `scripts/memory-tools-proto.mjs` —— 与既有 `scripts/graph-*.mjs` 同族 | **0 行既有代码**（纯新增） | **否**。零在线影响 | ① **agent 调不到** ⇒ 不是"工具化"的完成态；② 只服务人工、量台、以及**阶段 6 的离线巩固**（那条通道本来就在会话轮之外） | **天然关**：它不在任何在线路径上 |

**推荐：(c) 先行（已完成）→ (b) 作为下一小步 → (a) 排最后。** 理由三条，都可验：
1. 本阶段的红线是"只做设计与只读原型"，**(c) 是唯一零改动、零红线风险、且能立刻拿真实数据出差异报表的形态**；它产出的 `new_hits` 数字正是决定"值不值得再往下走"的依据（HippoRAG 消融：**不收敛 / 无增益的迭代就是纯开销**，0.255s → 3.16s）。
2. **(b) 才是"多一轮"最合适的宿主**：子代理会话本身就是多轮、本来就没有任何注入（`toolFilter.allow = []`），所以"工具结果挤上下文"与"跟她的人格注入抢预算"这两个坑在 (b) 里**根本不存在**；而 (b) 的改动是"把空数组换成白名单"= **纯增**。且阶段 6 的离线巩固用的就是这条通道（`subagents.start`），(b) 等于提前把它要用的手准备好。
3. **(a) 收益最大、代价也最大**：它要动红线**邻域**的两样东西 —— 每轮常驻的 token 预算、以及"读工具与写工具同一个工具面"。按 §0.4「默认关 = 零行为变化」与「纯增不改」，(a) 必须等 (b)/(c) 的报表先证明有增益，再单独裁决。

**三个形态共用的禁令**（写在前面，省得实现时忘）：工具**只读**（本阶段）、**不许**成为新开口点、**不许**往 L0 / 画像 / 人格注入里塞一个字。

#### ②c 与现有 `load()` 的关系（明确"不改默认路径"）
- **`load()` 一个字不改。** `python/engine/graph.py:430-484` 的取数口径（节点只加载**被本人边引用到的**、边按 `owner_key` 取）本阶段**原样保留**；工具通道是**另起的一条只读通道**，不插进 `load()`、不插进 `retrieve` 帧、不插进 `turn-snapshot`。
- **同一个打分器，不新开第二条。** `memory.search` 调的是既有纯函数 `lib/retrieve.js:82` `rankMemories`（与 `python/engine/retrieve.py:196` `rank_memories` 同源）。§10.1 记的"活路径只有一处打分器"因此仍然成立。
- **只读 ≠ 无副作用（这条最容易踩）**：线上检索那条路**会写库** —— `lib/store.js:657-668` 检索完就对命中项 `UPDATE episodic_memory SET half_life=…, recall_count=recall_count+1 …`（"被想起来就强化"），而 `echo_memory` 走的正是它（`lib/engine.js:617-621` 自述"含强化"）。⇒ **"只读工具"绝不能接到那个入口**，否则"查一次改一次库"，与 §9.3 的"幂等 / 不记水位"直接对撞。原型的做法：**只调纯函数**，跑完库文件 mtime 必须不变（实测见 §3④）。

#### ②d 形态 (b) 的实现记录（2026-10-01，代码已落盘=仍默认关）
- **落点**：`lib/reflect.js` 的 `runStructured` 一处 —— 原来写死的 `toolFilter: { allow: [] }` 改成 `toolFilter: resolveSubagentToolFilter(toolFilter)`；解析规则是"显式传的优先 → 壳注入的 provider → **否则回落到 `{ allow: [] }` 这个原值**"。壳（`lib/index.js`）在开关打开时注册 4 个只读工具并把 provider 设成 `{ allow: [memory_search, memory_get, memory_neighbors, memory_timeline] }`；开关 = 环境变量 **`ECHO_MEMORY_SUBAGENT_TOOLS=1`（默认关；非 `1` 的一切值都算关）**。新增 `lib/memory-read-tools.js`（工具定义 + 只读 reader）、`tests/subagent-memory-tools.test.js`。
- **⚠️ 宿主限制（本阶段最值钱的负结论）**：这台宿主的 `toolFilter` 是 **restrict 语义** —— `dsh-subagent` 的 `applyChildComposition()` 把它翻成 `childCtx.tools.restrict(...)`，而 `restrict` **只能从子代理继承来的工具面里拿掉工具**，不能加；in-process 驱动的 `setup(childCtx)` 由驱动自己拥有，调用方注入不进去。⇒ **"只给子代理"在这台宿主上做不到**：工具必须注册在全局层，**开关打开时主会话也会看到这 4 个工具**。要真正的 per-child 注册，需要**宿主侧**加钩子（本插件改不了）。这正是开关**必须默认关**的理由，也是 (a)/(b) 差别比原设计小的地方。
- **⚠️⚠️ 推论（写给后来人，别再把 (b) 当"安全的小步"）**：**形态 (b) 与形态 (a) 不是两个安全等级，而是同一件事。** 两者都**只能把工具注册在全局层**；区别仅在于 (b) 在子代理那一轮用 `allow` 把可见面收到 4 个，而 (a) 把同一批工具留给主会话。**只要打开开关，(b) 和 (a) 一样暴露在全局工具面上** —— 宿主**没有 per-child 注册原语**（`dsh-subagent-in-process-driver` 的 `setup(childCtx)` 由驱动自己拥有，调用方注入不进去；`tools.restrict()` 只能减不能加）。真正的 per-child 注册**必须由宿主侧提供注册钩子**；**在拿到那个钩子之前，(b) 不许开成默认**。
- **只读纪律（同时写进代码注释）**：4 个工具**只调 store 的只读读口** `listMemories` / `memoriesByIds` / `graphData` + 纯函数 `lib/retrieve.js` 的 `rankMemories`；**绝不**走 `store.retrieve()`（它会 `UPDATE … recall_count+1`）或引擎 `memory_search` 帧（`python/worker.py:397-399` 自述"含强化"）。单测里用"把 `store.retrieve` 换成 throw"的方式钉住，并比对 `recall_count/half_life/last_recalled` 前后逐位不变。
- **负控**：`git diff` 只动 `reflect.js` 那一处 + `index.js` 的两段；**关掉时**实测注册工具集 = 11 个（与 HEAD 同集）、`subagentToolFilter` = `{"allow":[]}`（与 HEAD 写死的字面量逐位相同）。
- **坑（实测撞到，已改名避开）**：`store.graphData()` 是**面板口径** —— 它在内存里把说话人名与按关系命名的节点改写成 `person/habit/preference/event`（`lib/store.js:1172-1181`），**库里那一列仍是 `concept`**（实测活库 `用户` 的 `node_type='concept'`，走 `graphData()` 出来是 `person`）。所以 `memory.neighbors` 的出参字段叫 **`displayType`**，不叫 `nodeType` —— 叫 `nodeType` 就是一句假话。要拿库里的真值必须另开一条 SELECT（= 第三个读口），本阶段**不做**。
- **与 §3③a 的两处已知偏差（照实列，不当已实现）**：① `memory.get` **没有** `evidence(截断300)` —— `memoriesByIds()` 的 `rowToMemory()` 不带这个字段，而 `evidence` 在 `graph_edges` 上（要另开读口）；② `memory.neighbors` 的**归属过滤做不到**：`graphData()` 不暴露 `owner_key`，所以出参带 `ownerFiltered:false` 自曝（单主人现实下无害，但不许静默）。
- **启用路径（2026-10-01 stage2e 核定：有一条**不用重启宿主**的路）**：开关是**配置驱动、默认关**，读法 = **`env OR loader-config OR settings` 任一为真即开**，且**配置那条必须是严格 `true`**（`lib/memory-read-tools.js:83-103` 的 `memoryToolsEnabled`）。**不重启的做法**（⚠️ 2026-10-01 stage2f 起**降级为备选**：首选是面板那条，见本段末追加）：编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`，给 `id: echo` 那一条追加 `config:` → `memorySubagentTools: true`（同文件里 `browserskill` 那条就是同款写法）；本部署 web profile 是 `patchReload: "live"`（`profiles/web/package.json`）⇒ 宿主 `dsh-app-boot` 的 `watchUserPatches()`（`node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1109-1122`）用 HMR 监视该文件，文件一变即 `entry.update({config:{…patches}})` → Include 的 `internal/update` 监听（同文件 `:141-148`）→ `root.update(data)` → loader `Entry.update`：**只改 `config` 时 `replace=false`** ⇒ 走 `_patchContext` → `fiber.update(config,true)`（`@deepseek-ai/cordis/src/fiber.ts:736-752`）→ `restart()` → dispose 后 `_reload()` **原地重跑 `apply(ctx, newConfig)`** ⇒ `pluginConfig.memorySubagentTools===true` 命中 `loader-config:` 支路，注册 4 个工具并给子代理设 `allow` 名单。**必须重启的只有环境变量那条**：`process.env` 在宿主进程启动时固定、`apply()` 又只在装载时读一次。**⚠️ 边界照实说**：这条路的代价是"**echo 整插件 dispose + re-apply**"，不是"只挂 4 个工具"；宿主进程与**别的**插件（含正在进行的会话）不受影响 —— 这就是"不重启宿主"能做到的极限。失败降级：注册块 `try/catch` 里出错会 `setSubagentToolFilterProvider(()=>subagentToolFilter(false))` **一起退回关**（半截状态=名单有工具不在=宿主 loud 拒绝，比没开更危险）。**⚑ 2026-10-01 stage2f 追加（**首选**的一条路，已落地；上面那条 patch 路降级为备选）**：网页仪表盘「调参」页顶部多了一个开关（`GET/POST /api/echo/memory-tools`，落 `<DATA_DIR>/config.json` **顶层** `memorySubagentTools`）—— **拨一下就当场注册/摘除那 4 个工具：既不用改 `cordis.patch.yml`、也不触发 fiber restart**；判定仍只走 `memoryToolsEnabled()` 一处（三路 OR：env / loader-config / settings）。**生效口径（别混）**：经**面板/端点**拨 = **立即生效**；只有**手改 `config.json` 文件、不经过面板**才是"下次启动生效"（`apply()` 只在装载时读一次）。**两句话也别混**：「配置怎么写」看 `scripts/enable-memory-tools.mjs --check`；「真机注册成功」只有 `apply()` 日志或面板卡片的 `registered` = 4 能证。细节与实测读数见 §11 row 19。

### ③ 数据形状

#### ③a 工具面的最小集（**4 个**，全部只读、全部限条 / 限深 / 限时）
| 工具 | 入参 | 出参 | 边界（硬上限在**工具侧**强制，不信任调用方给的 limit） | 能看到原文? | 能跨会话? |
|---|---|---|---|---|---|
| `memory.search` | `query: str`、`limit: int`（默认 **5**） | `hits[] = {memoryId, summary(截断), cov, total, matched, layer, ageDays, entities[]}` | ≤ **12** 条 / 单次声明超时 **1500ms** / summary 截断 **120 字** | 否（只给摘要片段，不给原文） | **否**（一律锚 `owner_key='master'`） |
| `memory.get` | `memoryId: int`、`maxChars: int`（默认 **400**） | `{memoryId, summary(截断), keywords[], layer, timestamp, occurredAt, temporalStatus, halfLife, recallCount, evidence(截断 300), supersededBy}` | 单条 / ≤ **1200 字** | **是**（截断后的原文） | **否** |
| `memory.neighbors` | `node: str`（名或 id）、`depth: int`、`limit: int`（默认 **8**） | `{node, seedVisibleInLoad, depth, ownerFiltered, neighbors[]={nodeId,name,displayType,relation,weight,direction,isSpeakerNode}, totalNeighbors, truncated}` | `depth` 硬顶 **1**（多跳是阶段 4 的 PPR，本阶段不做）/ ≤ **20** 邻 | 否（只有节点名与边） | **否** |
| `memory.timeline` | `days: int`（默认 **7**）、`limit: int`（默认 **10**） | `{days, from, totalInWindow, items[]={memoryId, summary(截断), timestamp, occurredAt, layer, entities[]}, truncated}` | ≤ **30** 天 / ≤ **20** 条 | 否 | **否** |

**四个签名级形状**（描述级，不是提示词全文）：
`memory_search(query, limit) -> {hits[]}` · `memory_get(memory_id, max_chars) -> row` · `memory_neighbors(node, depth, limit) -> {neighbors[]}` · `memory_timeline(days, limit) -> {items[]}`。
对照本节原稿的 `memory_search / memory_fetch`：**`memory_fetch` 定名 `memory.get`**（"fetch"容易被读成"取原文全文"），**`memory_trace(seed_ids) -> paths[]` 本阶段不做** —— 它需要多跳，而多跳是阶段 4（且现图 **23 条活跃边**，见 §3④ 实测：图跳增益 = **0**）。

**选这四个的机制出处（只借思路，不 vendor）**：`memory.neighbors` 的形状照 `MEMORY_ARCH_SURVEY.md` §1 A-6（Basic Memory）的 `build_context(depth, max_related, timeframe)` —— **硬 MaxDepth + 硬条数**；两级粒度（粗 `search` → 细 `get`）照 `MEMORY_ARCH_SURVEY.md` §3② 记的 MIRIX；"终止"这个动作本身要显式（照 A-4 的 `TerminalToolRule`），所以报表里 `stop_reason` 是**必填字段**。

#### ③b 差异报表形状（"多一轮"多拿到多少）
```
{ query, limit,
  baseline_once: { topK, memoryIds[] },                        // 现状一轮注入口径
  tool_round1:   { memoryIds[], ms, equalsBaseline: bool },     // R1 必须与 baseline 逐位一致
  tool_round2:   { ch1_graph: {seeds[], calls[], memoryIds[], ms},
                   ch2_time:  {days, memoryIds[], inWindow, ms} },
  new_hits:      { vs_round1, vs_baseline, by_channel: {graph, time}, ids[], idsNotInBaseline[] },
  changed_rank:  int,
  union_with_tools: int,
  gain_vs_baseline: int,
  stop_reason:   'budget:轮数硬顶 2' | 'no-new-hit(再跳也拿不到新的)' | 'no-seed(…)'
}
```
- **R1 的口径固定 = `baseline_once.topK`（=6）**，不是工具自己的 `limit` —— 否则"增益"里会混进"少取几条"的假差。`equalsBaseline` 这个布尔是**现场证据**：工具通道 = 同一个打分器。
- **R2 拆两条独立通道**，`by_channel` 分开报，因为**两条通道的增益性质完全不同**（实测见 §3④）：`ch1_graph` 是"相关性的多一跳"，`ch2_time` 是"最近还发生了什么"（**与查询词无关**）。
- `stop_reason` 是**必填**（照 A-4 的 TerminalToolRule：把"我查完了"变成可被规则约束的动作，而不是沉默）。

#### ③c 负控报表形状
```
{ mode: 'tools-off',
  baseline_once: { topK, memoryIds[] },   // 必须与 mode:'tools-on' 里的 baseline_once 逐位一致
  diff: { baseline_identical: bool, mtimeUnchanged: bool, calledTools: [] } }
```
负控的可测定义：**工具不注册时，本轮的注入内容与现状逐位一致**；且**只读通道跑完，库文件 mtime 不变**。

#### ③d 跨会话 / 隐私口径（本阶段**取最保守的一档**）
- 一律锚 `owner_key='master'`（`lib/store.js:21` 的 `MASTER_ID`），**不暴露渠道维度**。库里确实有 `channel` / `channel_chat` / `speaker_id` / `is_master` 四列（本轮只读核对），**按渠道过滤与否 = 未确定**（**待裁决项**；本轮硬边界只允许改 §3 ⇒ 未写入 §11），所以本阶段**只做"不给模型任何跨渠道选择"**这一件事。
- ⚠️ **节点的可见性不能按 `graph_nodes.owner_key` 过滤**：本轮实测 28 个节点里 **5 个 `owner_key` 是 `NULL`**（`音理` / `舞萌` / `计算机大类` / `老乡鸡的梅菜扣肉` / `麦当劳随心配1+1`），**包含度数最高的桥节点 `音理`**。而 `load()` 的可见性口径是"**被本人边引用到**"（`graph.py:442-443`），不是节点自己的 `owner_key` ⇒ 原型照 `load()` 的口径（全表读 + 另算 `visibleInLoad` 标志）。若照 `node.owner_key` 过滤，会**静默藏掉 `音理`** —— 这正是 §9.3 说的"静默跳过"式事故。

### ④ 验收（可测判据 + 本轮实测）

**判据（命令级，可在原型上一次跑全）**
1. **差异报表已产出**：每个查询都有 `new_hits`（**分通道**）/ `changed_rank` / `stop_reason`。
2. **`tool_round1.equalsBaseline == true`**：工具通道与现状一轮注入**逐位一致**（同打分器的证据）。
3. **负控逐位一致**：工具不注册时，`baseline_once.memoryIds` 与开工具时同查询的 `baseline_once.memoryIds` **逐位相同**；且脚本跑完 **库文件 mtime 不变**（`mtimeUnchanged == true`）。
4. **只读自证**：mtime 前后比对 + 脚本末尾固定打印 **"本工具只读,未修改任何数据"**。
5. **幂等**：连跑两次，除耗时字段外**报表逐位一致**（本轮已测）。
6. **上限生效**：任何工具返回条数 ≤ 硬上限；`overBudgetCalls == 0`（本库规模下）。
7. **红线未触**：`npm run check` / `node scripts/check-bom.mjs` 全绿；`git status --porcelain` 只多 1 个新增脚本 + 本节改动。

**本轮实测（真实库 `$env:USERPROFILE\.dsh\echo\echo.db`，快照 2026-10-01，只读）**
- 库口径：**222 条活跃记忆**（`user_id='master'`、`is_active=1`、`status` 为空或 `'active'`）/ **28 节点**（`load()` 口径可见 **20** 个）/ **42 边（活跃 23）** / 别名 13 条。⚠️ 与 §0.5 的 **217** 差 5 —— 活库边跑边写，**不同快照不可逐位比**（§0.1 引用纪律）。
- **工具耗时（22 次调用 / 20.895 ms，全部远低于 1500ms 预算）**：`memory.search` **2.1–5.2 ms** / `memory.neighbors` **0.001–0.088 ms** / `memory.timeline` **0.03–0.12 ms**。
- `memory.timeline(days=7, limit=10)` → 窗口内 **142** 条，返回 10 条（已裁）。
- `memory.neighbors(node='音理', depth=1)` → **2** 个邻居（`用户` ×2，关系 `想念` / `在意`，权重各 8）；`node='校园跑'` → **3** 个（`用户` `参加` 权重 10 / `3km速度限制` `要求` 权重 4 / `用户` `进行` 权重 1）。**每个查询的第一批邻居都是说话人节点 `用户`** —— 所以 `isSpeakerNode` 是出参的**必需字段**（R1 的教训，见 §9.1）。
- **"多一轮"到底多拿到多少（核心数字）**：

| 查询 | 现状 top6 | 工具 R1 | R2 图跳新增 | R2 时间新增 | 总新增 | 名次变化 | 停止原因 |
|---|---|---|---|---|---|---|---|
| `校园跑` | 6 | **6（逐位同）** | **0** | **18** | 18 | 0 | budget:轮数硬顶 2 |
| `章鱼小丸子` | 6 | **6（逐位同）** | **0** | **18** | 18 | 0 | budget:轮数硬顶 2 |
| `合肥` | 6 | **6（逐位同）** | **0** | **16** | 16 | 0 | budget:轮数硬顶 2 |

  - **图跳通道（ch1）增益 = 0，三个查询全是 0。** 原因本轮可查：R1 给的一跳种子（`校园跑` / `计算机大类` / `舞萌` / `西安电子科技大学`）的邻居名再检索一遍，拿不到任何不在 R1 里的条目 —— 现图**只有 23 条活跃边**（星形：度最高 `用户` 20、**不含用户节点的活跃边 ≤2**，§0.5），一跳就到底。这正是 §0.5 与 §9.7 那条负结论（图谱查询扩展**零增益、16× 耗时**）在**工具面**上的复现。
  - **时间通道（ch2）增益 = 16–18 条，但它们与查询词无关**（就是"最近两天还有什么"）。**这个数字不能读成"多一轮更准了"** —— 它是"多给了上下文"（拿上下文成本换来的），不是召回质量。⇒ 照 §3⑧ 的划界：**增益必须分通道记账，且默认关**。
  - **`changed_rank` 恒 0**：多查一轮**没有改变** R1 内部的次序（R2 只做并集，不重排 —— 重排是阶段 4 的事）。
  - ⚠️ **R1 的 6 条里有 3 条是 L0 强制占位、`cov = 0`、`matched = false`**（`291` 舞萌 / `307` 回合肥 / `280` 西电）。⇒ 出参**必须带 `matched`**，否则模型会把"常在场"当成"查询命中"（`lib/retrieve.js:74` 记的漏洞②就是这个）。

### ⑤ 回滚
- **(c)（已落地的那种）**：删 `scripts/memory-tools-proto.mjs` 即回到现状；**零数据回滚**（只读，`mtimeUnchanged == true`）。
- **(b)**：把 `lib/reflect.js:218` 的 `toolFilter.allow` 拼装退回**空数组** ⇒ 与现状**逐位一致**（空数组就是今天的行为）。
- **(a)**：注册点前那个开关回到 `false` ⇒ **根本不注册**（注意 `lib/index.js:3835`：工具**只能注册、没法注销**，所以 (a) 的开关只在**启动时**有效；不许设计成"运行中可切"——切不了）。
- 本阶段**没有新增存储**（无表、无列）⇒ **不需要数据回滚**。工具通道若将来要写（阶段 6 之后），才需要真值回执（阶段 1 已给形状）。

### ⑥ 模型调用
**0**（本阶段只做工具化与报表；不投 LLM）。**原型实测也是 0 次模型调用** —— 全部是 SQLite 只读 + 纯函数打分。

### ⑦ 前置依赖
阶段 1（写入侧闸门与真值回执 —— 工具化会放大写入面，闸门必须先到位）。

### ⑧ 本阶段的坑

1. **与"不做多轮 LLM 迭代检索"的边界必须写清**（原样保留）：不做清单里有"**不做多轮 LLM 迭代检索（越迭代越差）**"（HippoRAG：$0.1/73.4 vs IRCoT $1/67.0 vs IRCoT+HippoRAG $3/64.9；耗时 0.255s → 3.16s）。本阶段是**工具化**（agent 自主问、且**默认关**）；若差异报表显示"多查一轮"无增益，**照不做清单办，留痕并收手**。**本轮实测已给出这个信号的一半**：图跳通道增益 **0 / 0 / 0**。
2. **机制参照（只借思路不 vendor）**（原样保留）：`MEMORY_ARCH_SURVEY.md` §1 A-3 / A-2 的"记忆工具 + **写权分离**"（Letta，Apache-2.0，【源码】）与 MemGPT 的 **`request_heartbeat` 协议**（把"是否继续追问"变成模型输出的一个布尔参数，而不是外层循环猜）。后者是"要工具化记忆时最小可用的多跳开关"（A-2 ⑪）。
3. **不许把工具做成新开口点**（全局约束）。
4. **工具过多会挤上下文**：4 个工具 schema 常驻 ≈ **400–700 token/轮**，而且它挤的是**压缩域的预算** —— 压缩域是红线，**不许为了让工具结果留下而调压缩阈值**。⇒ 这也是推荐 (c)→(b)→(a) 顺序的理由之一：先证明有增益，再花这份预算。
5. **结果无上限会爆 token**：每个工具都必须有**工具侧强制的**硬上限（条数 / 深度 / 天数 / 字符），**不许信任调用方给的 limit**（照 `lib/index.js:953` 既有做法 `Math.min(12, Math.max(1, …))`）。本原型的全部上限见 §3③a；`memory.timeline(days=7)` 一次就够返回 **142** 条 —— 不设上限就是一次灌爆。
6. **只读工具会被模型当写工具**：`echo_remember`（写）与 `memory.search`（读）如果**同处一个工具面**，模型容易以为"我已经记下了"。⇒ ① 名字与描述必须显式写"只读"；② **不要把只读工具与写工具注册到同一个会话工具面**（又是 (c)/(b) 优于 (a) 的一条理由）；③ 阶段 6 的写权分离到位后，这个坑才真正消失。
7. **跨会话可见性 = 隐私**：库里有 `channel` / `channel_chat` / `speaker_id` / `is_master`（本轮只读核对）。工具若不过滤，不同渠道的记忆会互相可见。本阶段**一律 `owner_key='master'` 且不暴露渠道维度**；**按渠道过滤与否 = 未确定**（**待裁决项**，本轮未写入 §11）—— 不许在实现时"顺手选一个"。
8. **与压缩域抢上下文预算**：工具结果进上下文就占预算。红线语义是"**压缩域不动**" ⇒ 工具侧必须自己收口（上限 + 摘要截断），而不是"多占一点后面压缩会兜住"。
9. **失败时的降级**：`file:…?mode=ro` 打不开 / 表缺列 / 引擎不在 ⇒ **诚实回报不可用**（照 `lib/index.js:794-803` `softOffReason` 的形状），**绝不许静默返回空结果** —— 空结果与"她真的没这段记忆"在模型眼里**无法区分**，她会当场说"我不记得"。同理，工具内部异常要带 `reason`（照 `DISCIPLINE.md` 规矩 2「失败必须可见」）。
10. **只读 ≠ 无副作用（最隐蔽的一条）**：`lib/store.js:657-668` 的"检索即强化"（`UPDATE … recall_count+1`）会让"只读工具"每查一次改一次库，并与 DMAE **每小时 `plan_prune`** 打架（§9.3：幂等、不记水位）。⇒ 只读通道必须**只调纯函数**（`lib/retrieve.js:82`，只 import 纯数学的 `lib/dmae.js` / 纯分词的 `lib/lexical.js`），并用 **mtime 前后比对**自证。
11. **节点可见性不能按 `node.owner_key` 过滤**：28 个节点里 **5 个是 `NULL`**（含度最高的桥节点 `音理`）⇒ 会静默藏掉最该被查到的节点。必须照 `load()` 的"被本人边引用到"口径（§3③d）。
12. **`load()` 口径下度 0 的节点天然查不到**：`load()` 只加载被本人边引用到的节点，本轮 **8 个度 0 节点**全在可见集之外 —— 工具面要么**明说**"只覆盖有边节点"，要么单独走 `graph_nodes` 全表（原型走后者并标 `visibleInLoad`）。含糊过去就是"她问起某个词，工具永远查不到"。

**开工检查表（阶段 2）**
- [ ] 差异报表已产出（"能否多查一轮"可查，且**分通道**记账）
- [ ] `tool_round1.equalsBaseline == true`（同打分器的现场证据）
- [ ] 负控逐位一致（含"工具不注册时注入内容不变"）
- [ ] 只读自证：mtime 前后不变 + 末尾打印"本工具只读,未修改任何数据"
- [ ] 幂等：连跑两次报表（除耗时）逐位一致
- [ ] 工具默认关，且不新增注入 / 压缩 / 人格通道
- [ ] 未把"多轮 LLM 迭代检索"塞回主路径（已书面划界）

---

## §4 阶段 3a —— 共现影子边（端点 = 既有概念节点）

### ① 目标
把"已经躺在记忆里"的共现关系**第一次写成边**，但**只写不接检索**（影子边），默认关。

### ② 改动面
- `python/engine/graph.py` 新增**只写路径**，写 `kind = cooccur_same_memory | cooccur_same_day` 的边。
- **DDL 纯增**：`ALTER TABLE ADD COLUMN kind`（`graph_edges` 现有 DDL 见 `db.py:158-172`，**不挤原槽位**）。
- **必须排除说话人节点**（`用户`/`<称呼>`/`她`/`Echo`/`助手`）。
- **不做删除、不做 LLM**。
- **裁决①（2026-10-01）：同天边过 R2 用 `kind-aware R2`** —— 同记忆边仍判**两端记忆集交集非空**；同天边判**两端各自的证据都非空**（跨记忆的同天对没有共同记忆，交集判据会把 42 条全抹掉）。候选与回执都带 `evidence_scope`（`same_memory` / `same_day`，回执表新增可 SQL 查的同名列）。⇒ 同天应写入 **42**（= R1 之后全量），同记忆仍是 **5**，合计 **47**；合并视图随之变成活跃边 **23 → 70**、不含说话人节点的活跃边 **1 → 48**。
- **裁决②（2026-10-01）：S1 累加** —— 同一对再被表述 ⇒ **不新开行、不吞掉**，`evidence = 旧∪新(≤16,保新)`、`weight = max(旧,新)`、`occurred_at = max(旧,新)`，**只 UPDATE**；`last_accessed / half_life / recall_count / activation` 一律不动（影子边不是"被想起"）。返回 `{inserted, updated, skipped, warnings}`；第二跑 `updated = 0`（幂等）。S2（加 `days` 列存精确天数集）推迟。留痕：若影子边槽位上坐着事实边 ⇒ 不动作 + `warnings` + stderr 一行；写口只吃影子边（事实边形状的输入静默跳过）。
- **✅ 卡口 1 已裁决并落地（方案 A，2026-10-01）**：影子边落库用**独立归属键** `graph_gate.SHADOW_OWNER = '__shadow__'`（单一出处常量；`worker.py` 调用点传它，不再传事实边的 `owner`）。硬验收（快照副本、写满 47 条）：`load('master')` 指纹 `c02fea9dc6400636` **逐位不变**（边 42 → 42）、检索端到端（`graph_activate` + `render_paths`）**逐位不变**、谓词归并 + L0 治理后 `master` 边行**逐位一致**（L0 边 3 → 3，影子边进 L0 = 0）、影子边自身一条不丢（`load('__shadow__')` = 14 节点 / 47 边）、owner 分布 = `[('__shadow__', 47), ('master', 42)]`。**未采用**方案 B（`load()` 加 kind 过滤；实测对既有数据也零变化，但改了检索路径本身，留作以后"若要让影子边可检索"的开关）。
- **✅ DMAE 卡口已裁决并落地（治本，2026-10-01）**：`graph.py` 的 `update_and_persist` 里 `all_edges` 读取口加 `AND COALESCE(kind,'')=''`（**只看事实边**；老库还没 `kind` 列时用 `PRAGMA table_info` 判一下退回不过滤）。硬验收（快照副本，+61 天推演 `now=1.8e9`）：影子边 **47 → 47（被剪 0）**、影子边 DMAE 字段**零改动**（`activation > 0` 的 = 0 条）、喂给 DMAE 的边数 42 只含事实边、**既有事实边行为与"没有影子边的对照副本"逐位一致**（`pruned` 都是 1，剩余 41 条事实边逐位相同）。
- **⚠️→✅ 卡口 2（2026-10-01 实测：真写库之后被并行代理抓到，已回退 + engine 侧已修）**：影子边虽然被 `load('master')` 挡住了，却进了**两个生产读口** —— `graph.top_nodes()`（`python/engine/graph.py:282`）与壳侧 `store.topEntityNames(20)`（`lib/store.js:1221`）：这两处的 `LEFT JOIN graph_edges` **只过滤节点 owner、不过滤边 owner** ⇒ 影子边灌度数，`音理` 从第 7 名窜到 **第 2 名**（实测），而 `topEntityNames` 正是喂 `extract_prompt` 的 `knownEntities`。**处置**：① 立刻回退活库（`DELETE FROM graph_edges WHERE owner_key='__shadow__'`，删 47 行；回执 77 行按审计保留），六条读数与两个榜单**逐位还原**；② engine 侧已修：`top_nodes` 的 `AND COALESCE(e.kind,'')=''` **追加在 `ON` 子句**里 —— **不能写进 `WHERE`**：`LEFT JOIN` 先匹配上影子行、再被 `WHERE` 打掉 ⇒ 只挂影子边的节点会从榜单**整条消失**（实测 12 → 3）；而且 `WHERE` 里那串 `OR` 不加括号时因 `AND` 比 `OR` 结合得紧，owner 命中的节点**照样**灌影子边度数；③ 壳侧那一行（`lib/store.js:1221` 同类 JOIN）属"喂提示词的壳侧路径"（红线邻域），**未动，等人类点头**；④ 47 条回填**等修完 + 复验通过**再做。
- **✅ 路线 2 已落地（2026-10-01 人类裁决：影子边另立一张表）**：影子边改住 `graph_shadow_edges`（纯增表；`graph_edges` 的列/约束/索引一个字没动），写口 `write_accepted_edges` 只写新表、S1 累加语义原样平移，回执复用 `graph_edge_receipts` 并加 `route='shadow-table'` 标记。**零泄漏证明（两库逐项比）：`load('master')` 指纹 + `render_paths` 文本 / `top_nodes(20)` / `topEntityNames(20)` / `graphData()` / `memoryStats()` / `memoryHealth()` / `neighbors()` / DMAE `pruned`、`edges` —— 全部逐位一致**；活库 47 条已入新表（同记忆 5 / 同天 42），`graph_edges` 仍 42 行 / 活跃 23 / owner 只有 master，同 run_id 复跑 `inserted 0 / updated 0 / skipped 47`。回退 = 一行 `DELETE FROM graph_shadow_edges`（副本演练：删后读数逐位回写前）。
- **启用前汇总（给人类）**：`docs/STAGE3A_ENABLE_BRIEF.md`（一页：数字 / 读者可见性 / 风险与封口 / 一键回退）。

### ③ 数据形状
- 端点 = **既有概念节点**（`校园跑` 与 `章鱼小丸子` 同现于一条记忆 ⇒ 边落在两个概念之间），**不需要新节点**。
- 边：`{source_id, target_id, kind: 'cooccur', relation: <新维度>, weight, owner_key, evidence_memory_id}`。
- 报表：`{written, skipped, dropped_by_reason}`（与阶段 0 报表字段同源）。

### ④ 验收
- 影子边数在上界内：**同记忆 ≤ 5**、**同天 ≤ 42**。- **默认关时 `graph_edges` 活跃数与 23 逐位一致**（零行为变化）。
- **带 C3 的"零重合不得注入"自检**。
- **脚本幂等**：连跑两次，第二跑**改动数 = 0**，且**不记水位**（C11）。

### ⑤ 回滚
关开关 → 影子边不参与任何读路径；或按 `kind='cooccur'` 删边（删边安全，**不删节点** —— 本阶段无新节点）。

### ⑥ 模型调用
**0**。

### ⑦ 前置依赖
阶段 1（去噪规则与度数基线）、阶段 2（工具化后写入面已收口）。

### ⑧ 本阶段的坑
- **C11 图谱不是只增不减**：DMAE **每小时 `plan_prune` 删边清孤点**（`CORE_IN_DSH_PLAN.md:139-140`、`DB_MERGE_ANALYSIS.md:182`、`DEFENSE.md:137`）⇒ 任何建边 / 闸门脚本**必须幂等、不许记水位**。
- **只写不接读的副作用**（§6-8）：`load()` 只加载被本人边引用到的节点（`graph.py:423`），清理逻辑（`graph.py:973-974`）会删无边节点 ⇒ **本阶段必须确认新增边能让节点免于清理**。
- **D4 类来源的用词纪律**：任何算法参照一律写作 **port（衍生实现）**，不是 vendor —— 跨语言不能直接搬（`PLAN_MEMORY_GRAPH.md` §7 D4）。

**开工检查表（阶段 3a）**
- [ ] 默认关时活跃边 = 23 逐位一致
- [ ] 边数在 ≤5 / ≤42 上界内
- [ ] 幂等复跑改动数 = 0，且未记水位
- [ ] 说话人节点端点数 = 0
- [ ] 零重合不得注入自检已过
- [ ] 新增边确实让被引用节点免于清理（已实测）

---

## §5 阶段 3b —— 时间影子边（需最小 `episode` 节点）

### ① 目标
用**最小 `episode` 节点**给时间边提供端点，把 **216 条时间候选**变成 `kind='temporal'` 的影子边；节点**只作端点**。

### ② 改动面
- 一条现役记忆 ⇒ 一个节点：**显式写 `node_type='episode'`**、`properties` 带 `occurred_at`、`name` 指向该记忆（形如 `mem:<memory_id>`）。
- **只作时间边端点** —— **不进 L0 / 画像 / 人格注入通道**；不做摘要、不做 embedding。
- **顺带修掉的坑**：`get_or_create_node`（`graph.py:220-248`）从不写 `node_type` ⇒ 本阶段**必须显式写入**。
- **DDL 纯增**：`kind` 列已在 3a 引入；本阶段不新增列（`occurred_at` 列已存在，见 `db.py:150`）。

### ③ 数据形状
- 节点：`{node_id, name: 'mem:<memory_id>', node_type: 'episode', properties: {occurred_at}, owner_key}`。
- 边：`{source_id, target_id, kind: 'temporal', relation: <新维度>, owner_key, evidence_memory_id}`。
- 时间来源**唯一**：`episodic_memory.occurred_at`（`db.py:60`；时间三分口径见 `PLAN_LAND_ALL.md:276-282`）。

### ④ 验收
- 时间边数 **≤ 216**。
- `episode` 节点数 **= 被时间边引用到的记忆条数**。
- **关掉开关后 `graph_nodes` / `graph_edges` 与开前逐位一致**。
- **`is_protected` 不因此变化**。
- **与 3a 互不干扰**：开 3b 不影响 3a 的边数与读数（反之亦然）。

### ⑤ 回滚
关开关 → 影子边与 `episode` 节点都不参与任何读路径；或**先删边、再删 `node_type='episode'` 节点**（**顺序反了会撞清理逻辑** `graph.py:973-974`）。

### ⑥ 模型调用
**0**。

### ⑦ 前置依赖
阶段 3a；阶段 1 的 **R6**（无 `occurred_at` 不建时间边）。

### ⑧ 本阶段的坑
- **R6**：**无 `occurred_at` 不建时间边** —— 不猜、不取默认值。理由：Graphiti 静默不失效的教训 + 图侧时间列是死列（出处见 §11）。
- **`episode` 节点的三个连带风险**（§6-13）：① **膨胀**（一条现役记忆 = 一个节点，217 条 ⇒ 节点数近 8 倍），会同时压到 `load()`、清理与面板；② **与清理逻辑耦合** ⇒ 关掉时间边却不删节点，节点会被静默清掉，形成"开关关了、数据也没了"的假象（违 `DISCIPLINE.md` 规矩 2）；③ **端点语义被挪用**：一旦被别的路径（L0 / 人格注入 / 画像投影）当概念用，就等于**偷偷动了架构**（C1）。
- **最小形态是批准条件**：D10.6 只"放行只读扩散"、**收紧 episode 节点**（§0.2-1）⇒ 节点超出"端点"用途即为越界。
- **回填是"改"不是"纯增"**：既有节点的 `node_type` 回填**范围与方式未定**（§11），不得顺手扩范围。

**开工检查表（阶段 3b）**
- [ ] 时间边 ≤ 216，且时间只取自 `episodic_memory.occurred_at`
- [ ] `episode` 节点数 = 被时间边引用到的记忆条数
- [ ] 关开关后两表读数逐位一致
- [ ] `is_protected` 未变化
- [ ] 3a 与 3b 互不干扰（双向已测）
- [ ] 无 `occurred_at` 的记忆**没有**被建时间边（R6 单测）

---

## §6 阶段 4 —— 只读 PPR 扩散

### ① 目标
让"**查询→节点链接**"成为承重件：在图上做**收敛的 PPR**，纯图计算、零在线 LLM、**只读**。

### ② 改动面
- 检索模块新增**只读**扩散函数；**不改**写边路径、**不改** DDL。
- **DDL 无改动**；`load()` 的可见性需要修（`graph.py:423`），使"有边但未被本人引用"的节点可见 —— 这是**读路径**改动，默认关。
- **算法参照**：`graph-memory` 的 `src/graph/pagerank.ts`（MIT / **TypeScript** / 244 行 / seed-only teleport / dangling 回灌 / 30s 图缓存，默认 damping 0.85、20 迭代）—— 但**必须在 Python 侧重写**：本仓图侧写路径与检索侧都在 Python，`lib/` 侧明确不写图边。**这是 port（衍生实现），不是 vendor**；即便如此仍属衍生作品，**须保留 MIT 版权与许可声明**（`MIT License / Copyright (c) 2026 adoresever`）。

### ③ 数据形状
- 函数签名级：`expand(query_nodes, graph, damping, iterations) -> ranked_nodes`。
- **收敛判据**：迭代终止条件 + 残差上界（收敛是**验收硬项**，不是调优项）。
- **排序差异报表**：`{query, before_rank, after_rank, delta, verdict: '未确认增益'}` —— 增益未确认时必须**明写"未确认增益"**，不许写成"提升"。

### ④ 验收
- 走**既有判据门**：六档总分不退 / **逐档不退** / **N4 覆盖 94% 不许掉**（同 run 对比，按 `RETRIEVAL_BASELINE.md` 的口径）。
- **PPR 必须收敛**（对照 HippoRAG 消融：不收敛的"种子+邻居"更差 —— R@2 57.4→50.7、→42.2）。
- 排序差异报表**标"未确认增益"**。
- **若仍零增益**：按 C2 处置 —— **搁置并留痕**（不推翻旧结论）。

### ⑤ 回滚
扩散函数默认关；失败则回到"只认边"的原行为。

### ⑥ 模型调用
**0**（PPR 是纯图计算；成本参照 HippoRAG ≈ **$0.1 / 1000 queries**、单步 **0.255s**）。

### ⑦ 前置依赖
阶段 3a + 3b（路网先建起来）；且**另加一条硬前置**：`FIX_PLAN.md:33-46` 显示 **BFS 种子三通道全废、每轮 0 条** ⇒ **先修种子，再谈扩散**。

### ⑧ 本阶段的坑
- **C2 旧结论必须先复述**：图谱查询扩展在**星形图**上已实测**零增益、16× 耗时**（`RETRIEVAL_RESEARCH.md`）⇒ 本阶段成立的前提是**路网已建**，且须**重测同批金标**；若仍零增益，照旧搁置。
- **引擎在跑、种子全废**（§6-16）：三条种子通道全废（`:487` 字面命中 / `extraSeeds` 从未接上 / `:419` 机械切分），反证是"输入里带实体名时 BFS 出 8 条" ⇒ **不能假设"路网建好、扩散就有效"**。
- **PPR 不能退化为"只用种子"**（HippoRAG 消融）⇒ 验收必须卡**收敛**。
- **C12**：**不承诺用扩散修"更新 / 时间 / 多会话"三档**（SAGE 零样本 KU 23.5 / TR 13.8 / MS 9.4；迭代只救召回型档）—— 那三档的正手是既有 L1 写入侧时间/有效性编码。
- **承重 vs 装饰（引用要带出处）**：**承重** = fan 稀释 / 时间衰减 / **查询→节点链接（HippoRAG 2 里值 12.5 点）** / passage 节点（6.1 点）；**装饰 = 在线 LLM 过滤三元组（0.7 点）**。
- **在线 LLM 迭代的反向证据**：见 §9.8 ⇒ 任何"再加一轮 LLM 精修"的提案都需先推翻这条。

**开工检查表（阶段 4）**
- [ ] 种子三通道已修（BFS 不再每轮 0 条）
- [ ] PPR 收敛（残差/迭代上界已测，且对照"种子+邻居"更差）
- [ ] 判据门：六档总分 / 逐档 / N4 覆盖 94% 不退
- [ ] 排序差异报表已标"未确认增益"
- [ ] C2 旧结论已复述并入档
- [ ] 默认关时与开前逐位一致

---

## §7 阶段 5 —— 遗忘形状：冻结 ≠ 删除

### ① 目标
把"失效"做成**冻结**而不是删除：让"**上个季度我们以为是什么**"**可查**，且**全历史保留**。

### ② 改动面
- **纯增**（`ALTER TABLE ADD COLUMN`）：`valid_from` / `valid_until`、**软删列**。
- **纯增**：**版本 / oplog 表**（新表，不改既有表语义）。
- `is_protected` 的修复（让保护**不再恒 0**）：依赖阶段 1 补上的 `node_type` 真实写入。
- 复用既有墓碑先例：`graph_nodes.superseded_by`（`db.py:156`）/ `episodic_memory.superseded_by`（`db.py:64`）与 `is_active`（`db.py:155`）。

### ③ 数据形状
- `valid_from` / `valid_until`：**区间语义**（`valid_until` 为空 = 仍有效）；冻结 = 写 `valid_until`，**不删行**。
- 软删列：`is_active` 已有；新增软删标记只作**纯增**。
- **版本 / oplog 表**：`{op_id, ts, table, row_id, op: insert|update|freeze|supersede, before, after, reason, actor}` —— 只增不删。
- 查询形状级：`as_of(memory_id, t) -> row`（"上个季度我们以为是什么"）。

### ④ 验收
- "**上个季度我们以为是什么**"**可查**（`as_of` 型查询能取回当时的说法）。
- **冻结节点全历史保留**（行数不因冻结减少）。
- **保护不再恒 0**（`is_protected=1` 计数 > 0，且对应类型节点确实为受保护类型）。

### ⑤ 回滚
新增列 / 新表**只增不改** ⇒ 回滚 = 停止读新列/新表；**不 drop 列**（SQLite 亦不便）。

### ⑥ 模型调用
**0**。

### ⑦ 前置依赖
阶段 1（`node_type` 真写入 —— 没有它，保护恒 0）。

### ⑧ 本阶段的坑
- **`is_protected` 恒 0 的根因**（§6-4 / §2）：`graph.py:414-415` 只认 `node_type='person'`，而 `get_or_create_node` 从不写 `node_type` ⇒ **修保护必须先补 `node_type` 写入**，否则保护逻辑永远是死代码。
- **C9 时间从哪取**：`HAZARD_AUDIT_2026-09-26.md:71 F3` 记图侧 `occurred_at` 全 0、`temporal_status` 全 `time_unknown`（**死列**）⇒ 区间的时间**只能从 `episodic_memory` 侧取**。
- **C11 图谱不是只增不减**：`plan_prune` 每小时删边清孤点 ⇒ 冻结 / 软删不许与清理路径打架（**关掉开关后必须能与清理路径共存**）。
- **不物理删**（既有谱系）：`RETIRE_OLD_CHAIN_PLAN.md:101/:151` 的"**归档改名、永不删除**"、`FIX_PLAN.md:252-270` F10 的"变体下线不物理删"。

**开工检查表（阶段 5）**
- [ ] 只有 `ADD COLUMN` / 新表，无 ALTER 既有列语义
- [ ] `as_of` 型查询可回答"上个季度我们以为是什么"
- [ ] 冻结后行数不减（全历史保留）
- [ ] `is_protected=1` 不再为 0，且 `node_type` 已真写入
- [ ] 与 `plan_prune` 共存已实测

---

## §8 阶段 6 —— 写权分离 + 离线巩固

### ① 目标
把"**改记忆的权限从会话 agent 拿走**"（写权分离），并让"整理"在线下、可回滚、有预算上限地发生。

### ② 改动面
- **写权分离**：改记忆的入口收敛（**不新增开口点**）；会话侧退为**读 / 建议**，巩固侧才写。
- **离线巩固**：用**已有的 7 个通道 / 2 个启动点**（`subagents.start` + `dispose`；口径与证据见 §11-3）—— 离线、**受预算约束**。
- **必进 `episodic_memory` / 图谱 / L0 之外**：P4 类自产物**不得污染主记忆**。
- **机制参照（只借思路不 vendor）**：`MEMORY_ARCH_SURVEY.md` §1 A-3 记的 Letta"**把改记忆的权限从会话 agent 拿走**"（Apache-2.0，【源码】）；B-2 sleep-time compute（**睡眠期把已有上下文 c 重写成再表征 c′**，用极少 test-time compute 换同等精度，CC BY 4.0，【论文 Method】）；B-3 Auto-Dreamer"**快写（append-only typed 记忆）+ 慢整理（离线区域重写 `B*=(B\R)∪S`，supersede 原区域）**"（CC BY 4.0，【论文 Method】）。

### ③ 数据形状
- 巩固任务：`{job_id, scope, budget_tokens_cap, subagent: 1..7, status, diff_ref, rollback_ref, audit_chain[]}`。
- **diff**：整理前后两版可比（结构差异，不是自然语言描述）。
- **审计链**：每步可追（写者 / 时间 / 依据 / 结果）。

### ④ 验收
- **整理前后可 diff**。
- **回滚演练成功**（有演练记录，不只是"设计上能回滚"）。
- **审计链完整**。
- **token 有上限**（预算硬顶，超额即停）。

### ⑤ 回滚
按 diff_ref / rollback_ref 回到整理前版本；回滚**本身要走审计链**。

### ⑥ 模型调用
**有**（离线·受预算约束）—— 本阶段是**唯一有模型调用**的阶段。

### ⑦ 前置依赖
阶段 5（冻结 ≠ 删除 —— 没有可回滚的形状，离线巩固不敢写）。

### ⑧ 本阶段的坑
- **不做清单红线**：**不投 LLM 抽三元组当主边源**、**不做在线 LLM 过滤**、**不做多轮 LLM 迭代检索**、**不学 GraphRAG 社区摘要**、**不做参数化记忆**、**不引入常驻服务 / 图库 / 向量库**。
- **承重 vs 装饰**：**在线 LLM 过滤三元组只值 0.7 点** ⇒ 钱要花在"查询→节点链接"（12.5 点）上，不花在在线过滤上（§9.7）。
- **token 上限是硬项**：Mem0 图版建图 **35.825M tokens / 53514 calls**、LoCoMo 只得 **68.44** —— 这是"无上限"的反例。
- **P4 自产物隔离**：巩固产物不得进 `episodic_memory` / 图谱 / L0。
- **"7 个通道 / 2 个启动点"的计数出处**见 §11-3（已复核；本文不再沿用旧口径）。

**开工检查表（阶段 6）**
- [ ] 写权已分离（会话侧不再直写记忆）
- [ ] 整理前后可 diff，且回滚演练成功
- [ ] 审计链完整（每步可追）
- [ ] token 有硬上限，超额即停
- [ ] P4 自产物未进主记忆（已断言）
- [ ] 未引入常驻服务 / 图库 / 向量库

---

## §9 纪律与坑总表（来自调研，已核实）

### 9.1 写入侧去噪六条规则

| # | 规则 | 违反时 | 依据 |
|---|---|---|---|
| **R1** | **说话人 / 人格节点**（`用户`/`<称呼>`/`她`/`Echo`/`助手`）**不得成为共现边端点** | **丢边 + 记 `reason`** | 本仓实测（去噪后仅剩 5 条）；C3 |
| **R2** | **零重合不得注入** | **丢该条**（降级为未命中）；**且不得做成检索层阈值**（见 9.4） | C3 = `RETRIEVAL_OPT_2026-09-30.md` §6.1 现场；`RETRIEVAL_PLAN.md` RT3 |
| **R3** | **别名归一**（先过既有 `graph_aliases`） | **自动改**（规范名不存在则**丢边**） | `GRAPH_MERGE_REVIEW.md` Tier1 已生效；RT8"同义词优先走 `graph_aliases`（数据）" |
| **R4** | **端点类型 / 方向约束表** | **类型非法 ⇒ 丢边；方向违约 ⇒ 自动改正**，改不了则丢边 | `graph-memory` `extractor/extract.ts:17-32` 两张 Set + `correctEdgeType()`（MIT，**仅作参照、不 vendor**） |
| **R5** | **槽位隔离**（不挤 `slot = source_id\|\|'\|'\|\|relation`） | **改走新 `kind` 维度** | `db.py:14` + `graph.py:331`/`:404-410`；`ARCHITECTURE.md:184` |
| **R6** | **无 `occurred_at` 不建时间边**（时间只从 `episodic_memory` 取） | **不建边**（不猜、不取默认值） | C9；`HAZARD_AUDIT_2026-09-26.md:71` F3 |

### 9.2 失败策略
**能改则改、不能改则丢边、绝不拒写入主流程**。理由三条（`PLAN_MEMORY_GRAPH.md` §4.5(4)）：① 主流程不能被图挂住；② 既有先例就是"类型乱写就自动改，改不了就丢"；③ **丢边可恢复**（边可重算）、**拒写入不可恢复**（记忆丢了）。**不做**：不因丢边回滚记忆写入；不因丢边抛异常中断本轮。

### 9.3 幂等 / 不记水位
DMAE **每小时删边清孤点** ⇒ 任何建边 / 闸门脚本**必须幂等、不许记水位**；一律"**以当前库为准**"。

### 9.4 拒答只能落渲染 / 标注层
"在检索信号上设阈值做拒答"**端到端不成立**：各 gate"负:误取"**恒为 2**，正样本先被误杀（τ=0.90 时 15→8）；负控置信度 0.507/1.000 与正样本 0.27~1.0 **完全重叠** ⇒ R2 **不得实现为检索层阈值拒答**。

### 9.5 去重 / 去噪不能盲抄
签名去重曾让**纯向量反超全管线**（Hit@5 **56.6 vs 51.6**；MRR .406 vs .380），元凶是"去重挤掉同会话**并列答案**"；本仓 R5 同病（压成 67/67/67）⇒ 每条规则**对 N2 档单独测**，**阈值 data-dependent**。

### 9.6 侧抑制
**侧抑制会剪掉低度数叶子**（Synapse 失败案例：绿夹克 0.11 被 hub 0.85 压死），而**我们叶子最多**（**度 0 节点 8 个**、`校园跑`/`Echo` 各 3）⇒ 若将来做侧抑制，**β 取 0.10–0.15** 或对**单跳关闭**。另：**Hub Explosion 只有断言、无实验**，不能拿它当"必须侧抑制"的理由。

### 9.7 承重 vs 装饰（引用要带出处）
- **承重**：fan 稀释 / 时间衰减 / **查询→节点链接（HippoRAG 2 里值 12.5 点）** / **passage 节点（6.1 点）**。
- **装饰 / 可省**：**在线 LLM 过滤三元组（0.7 点）**；uncertainty gating 去掉只掉 0.2（40.5→40.3）。
- **本仓负结论（必须继承）**：RRF / 融合**已三次被否**（同族打平、异族 = BM25、N5 单量 100→66.7）；图谱查询扩展在星形图上**零增益、16× 耗时** ⇒ **不再引入"再多投一票"的融合臂**。

### 9.8 不做清单
不投 LLM 抽三元组当主边源 · 不做在线 LLM 过滤 · **不做多轮 LLM 迭代检索（越迭代越差）** · 不学 GraphRAG 社区摘要 · 不做参数化记忆 · **不引入常驻服务 / 图库 / 向量库** · **不照抄 A-MEM 的 links**（单向 + 下标对齐）· **不 vendor Basic Memory**（AGPL）· **不引用 LoCoMo 榜单数字**（五种口径不可比）。

---

## §10 文档与代码的地图

### 10.1 哪些文件动、哪些文件只是读

| 文件 | 角色 | 本计划里怎么动 |
|---|---|---|
| `python/engine/graph.py`（985 行） | **唯一写边处** | 阶段 1 闸门、3a 共现边、3b 时间边 + `episode` 节点、4 的 `load()` 可见性（读路径） |
| `python/engine/db.py`（446 行） | **DDL / 幂等迁移** | 唯一允许 `ALTER TABLE ADD COLUMN` 的地方（阶段 1 / 3a / 5） |
| `python/engine/judge.py`（923 行） | 语义锚（"关系 = 用户确立的事实"） | **只读**：解释"边为何长不出来"，不改 |
| `python/engine/l0_tier.py`（160 行） | L0 分层 | **只读**；`episode` 节点**不进**这里 |
| `python/engine/retrieve.py`（36814 B） | 检索侧活路径（唯一打分器） | 阶段 2 / 4 在此新增**只读**函数；**不开第二条打分器** |
| `python/engine/dmae.py` | 每小时删边清孤点 | **只读 / 必须共存**（幂等、不记水位） |
| `lib/index.js`（3812 行） | JS 壳 | **只读 `ctx.sessions`**（仅一处只读，`:3284`）；**不写图边** |
| `lib/relay.js` | QQ 桥 | **红线，不碰** |
| `scripts/`（40 个） | 运维脚本 | 新增**只读**测算脚本（阶段 0）；沿用 `graph-*.mjs` 族 |
| `tests/*.test.js`（90+ 个） | JS 闸 | 新增规则单测 |
| `python/tests/test_graph.py` 等 | Py 闸 | 新增规则单测（R1–R6 每条一条） |
| `docs/` | 文档 | **只读**（本计划不动既有文档；只新增本文件） |

### 10.2 三条不变量
1. **写边只有 Python 一处**：`python/engine/graph.py`（`graph.py:88` 注释；`PORT_GAP_AUDIT_2026-09-26.md:61` 证明 `lib/` 侧 grep `graph_activate` = 0）。
2. **JS 侧不写图边**：`lib/index.js` 对 `ctx.sessions` 只有一处只读（`:3284`，本轮核对）。
3. **`ALTER TABLE ADD COLUMN` 只在 `db.py`**：既有先例含 `db.py:251` 的 `("evidence", "TEXT DEFAULT ''")` 补列表与 `db.py:70` 的 `aug_keys`。

### 10.3 验证命令（三道闸 + BOM 闸）
- `npm test` → `node --test --test-force-exit "tests/*.test.js"`
- `npm run check` → `smoke-lib` + `check-syntax` + `check-bom` + `check_tools`
- `npm run test:py` → `python -m unittest discover -s python/tests -p "test_*.py"`
- BOM 闸 = `scripts/check-bom.mjs`（前 3 字节 ≠ `EF BB BF`）

---

## §11 未确认的事（标清出处，不许含糊）

| # | 项 | 出处 / 状态 |
|---|---|---|
| 1 | **"图侧时间列是死列"的依据来自审计，不是调研笔记** | 出处 = `docs/HAZARD_AUDIT_2026-09-26.md:71` **F3**（图 `occurred_at` 全 0、`temporal_status` 全 `time_unknown`）**与本计划引用的调研笔记**（`research-edges.md` / `research-spread.md` / `research-oss.md`）**无关**；同族 **F1**（`:69`）记节点 `activation`/`recall_count`/`intrinsic_value` **24/24 全 0**。两份审计均为 **2026-09-26** 快照，**本轮未复核**（`PLAN_MEMORY_GRAPH.md` §3.5(4) 同此口径）。 |
| 2 | **`is_protected` 死分支的判定依据** | `CODE_AUDIT_2026-09-26.md:206` **B32**（全仓无一处写 `node_type='person'`）；`ARCHITECTURE.md:183` 是**条件式陈述**，**不算打脸**（口径见 C5）。 |
| 3 | **"7 个一次性子代理"的计数 —— 本轮已复核** | 出自 `PLAN_MEMORY_GRAPH.md` §3（"7 个一次性子代理通道（`subagents.start` + `dispose`）"）。**本轮已复核（证据）**：**7 个通道标签** = `echo-diary`（`lib/diary.js:199`）、`echo-emotion`（`lib/index.js:1848`）、`echo-expand`（`lib/index.js:1866`）、`echo-topic-review`（`lib/index.js:2621`）、`echo-drift`（`lib/index.js:2879`）、`echo-extract`（`lib/reflect.js:281`）、`echo-reflection`（`lib/reflect.js:346`）；**`subagents.start()` 字面启动点仅 2 处** = `lib/diary.js:198`、`lib/reflect.js:212`（其余通道复用这两条路径）⇒ **结论口径："7 个通道 / 2 个启动点"**。另有契约说明在 `lib/agent-scope.js:9`、`lib/engine.js:376`、`lib/index.js:2025`（不计入通道数）。 |
| 4 | **真值回执的落点（既有审计表 vs 新表）** | 既有两份文档**未给出**回执的存储位置；本文只给**回执形状**（§2③）。**本轮核对**：仓内存在 `tests/tool-audit.test.js` / `tests/audit-view.test.js`，说明有审计面，**但其表名 / 字段未在既有文档中出现** ⇒ 不据此断言。 |
| 5 | **既有节点 `node_type` 回填的范围与方式** | `PLAN_MEMORY_GRAPH.md` §6-7b 明确标"**范围与方式未定**（待确认）"；且回填属"**改**"不属"**纯增**"。 |
| 6 | **`episode` 节点 `name` 的具体形** | `PLAN_MEMORY_GRAPH.md` §4 二期 b 记"形如 `mem:<memory_id>`，**具体形待定**"。 |
| 7 | **`graph_activate` 的函数名出处** | 既有四份文档（`ARCHITECTURE`/`API`/`README`/`DEFENSE`）内 **0 命中**；出处是 `ASTRBOT_PLUGIN_ARCHAEOLOGY.md:103`/`:221`、`CODE_AUDIT:247`、`PORT_GAP_AUDIT:61`。 |
| 8 | **图边的写前校验 / allow-list、端点类型约束、说话人节点排除** | 既有文档 **0 命中** ⇒ 后两项是**本计划新增的规则**，不是既有结论（`PLAN_MEMORY_GRAPH.md` §8.3 末行）。 |
| 9 | **`docs/RELAY_PLAN.md` 的"D10 不做清单"** | 文件在本机**不存在** ⇒ 无法核对，不作为依据；可核对的替代出处是 `CORE_IN_DSH_PLAN.md:393` 的 D10.6。 |
| 10 | **文档行数口径** | 本文写作时按父代理给定：`MEMORY_ARCH_SURVEY.md` = **765** 行、`PLAN_MEMORY_GRAPH.md` = **495** 行。**本轮实测（2026-10-01）**：`MEMORY_ARCH_SURVEY.md` = **769** 行、`PLAN_MEMORY_GRAPH.md` = **495** 行（**保留"给定 765 / 实测 769"的差异记录**，疑为尾行 / 换行计法差异）⇒ 引用行数时以"**快照日期 + 口径**"为准。 |
| 11 | **`DEFENSE.md` 的数字与公式** | 全篇**不可引用**（C13：`:103` 的 `R(t)=2^(−t/H)` 与 `ARCHITECTURE.md:140` 的 `1/(1+Δt/H)` **互相冲突**；`:170-172` 停在 v0.5.4 快照）。 |
| 12 | **`is_protected` / `activation` 本轮是否复核** | **未复核**（沿用旧审计）；阶段 0 只读测算应当把它纳入基线。 |
| 13 | **本宿主无 per-child 注册原语 ⇒ `toolFilter` 只是 restrict（不可扩权）** | **本轮实测（2026-10-01）**：`dsh-subagent` 的 `applyChildComposition()` 把 `toolFilter` 翻成 `childCtx.tools.restrict(...)`，`restrict` **只能从子代理继承来的工具面里拿掉工具**；`dsh-subagent-in-process-driver` 的 `setup(childCtx)` 由驱动自己拥有，调用方注入不进去（`childCtx.tools.register` 只在驱动内部用于 `structured_output`）。**⇒ 形态 (b) 与 (a) 是同一件事（工具都在全局层），差别只是子代理那一轮的 `allow` 名单**；要让工具**只**对子代理可见，必须**宿主侧**加 per-child 注册钩子。**在拿到钩子前 (b) 不许开成默认**（现状：`ECHO_MEMORY_SUBAGENT_TOOLS` 默认关，关掉时注册工具集与 `toolFilter` 与 HEAD 逐位相同）。 |
| 14 | **节点 `owner_key` 的读路径审计 ⇒ "补 `owner_key` = 零行为变化"** | **本轮只读审计（2026-10-01，全仓 `owner_key` 逐处判定）**：**没有任何读路径会因为节点 `owner_key` 为 NULL 而看不见该节点**。① `python/engine/graph.py:433 load()` 的节点可见性**只按边的 `owner_key`**（`:445-450` 的 `node_id IN (SELECT source_id/target_id FROM graph_edges WHERE owner_key=?)` + `is_active=1`），**不读节点那一列**；② `graph.py:261 top_nodes()` 与 `lib/store.js:1217 topEntityNames()` 是**宽容谓词**（`= ? OR IS NULL OR = ''`，NULL **包含在内**）；③ `lib/store.js:1089 graphData()`（面板）、`:941 memoryStats()`、`lib/soul-snapshot.js:38`、`python/engine/graph_gate.py:1039 build_context_from_db()` **压根没有 `owner_key` 谓词**；④ 其余 `owner_key` 命中**全是边侧或写入/DDL**（`l0_tier.py` 全在 `graph_edges`；`graph_mine.py:581` 读边；`graph.py add_edge/merge_relation_variants`；`lib/store.js:194/208/227` 与 `db.py:153/165/171` 是建表/索引）。**实测**：5 个 NULL 节点全部 `load() 口径可见=是`（各被 1–2 条 `owner_key='master'` 的活跃边引用，e36–e42），且**全部在 `top_nodes` / `topEntityNames` 的 20 名名单里**（进了反思提示词的"已有实体"名单）⇒ **修 `graph.py:252` 的 INSERT + 一次性回填这 5 个节点 = 零行为变化（仅补齐不变量）**。**方案（已交父代理裁定，本轮未实施）**：【建议批准】最小方案 = 只改 `graph.py:252-256` 的 INSERT 列表补 `owner_key`（写死 `"master"`，或把它做成 `get_or_create_node` 的入参默认 `"master"`），**新节点从此不再留 NULL**；那 5 行的**一次性回填**是可选第二步（`UPDATE graph_nodes SET owner_key='master' WHERE owner_key IS NULL`），因读路径全宽容 ⇒ **回填前后所有读结果逐位相同**。注意：**若将来有人把某条读路径改成"严格按节点 `owner_key` 过滤"（不加 `OR IS NULL`），那 5 行会当场变得不可见** —— 所以回填的收益是"提前把不变量补齐"，不是"修可见性"。 |
| 15 | **"graph-merge 到底跑过没有"——审计不可用，改用别名表定证** | `audit_logs` 只保留 **100** 行（实测 **101** 行，仅覆盖 **2026-10-01 07:57–11:11**，见 `trimAudit`）⇒ `tool_call='graph_merge'` **0 条不能证明"没跑过"**（老审计已剪）。**替代证据**：`graph_aliases` 里 **13 条 `source='merge'`** 行（最后一批 **2026-09-26 16:39:08**），而该 INSERT（`scripts/graph-merge.mjs:124`）只在 `--apply` 路径上执行、与无主节点补齐（`:200`）**同一趟** ⇒ 补齐确实跑过。 |
| 16 | **`graph_query` 是不是死路径 ⇒ 影子边"只写不接检索"的安全性靠什么** | **本轮实测（2026-10-01，全仓逐处 grep `graph_query`/`graphQuery`）**：**不是死路径 —— 它有发送方，且发送方就在生产链路上**。① **发送方唯一** = `lib/engine.js:195` 的 `client.request('graph_query', {userId, text, now, extraSeeds})`（条件 `mode === 'python' && !pythonDown()` = 引擎在线的正常路径）。⚠️ `archive/docs/MEMORY_AUDIT.md:70` 那句"壳侧 `lib/*.js` 对 `graph_query`/`graph_reinforce` **零引用**"是**旧审计结论，已过期**，不得当现状引用。② **完整调用链（进人格注入）**：`lib/index.js:1948` `turnSnapshot.compose(session)` → `lib/index.js:1950` `target.sections.push(turnSnapshot.sectionOf(snap.text))`（= 系统提示词 section）→ `lib/turn-snapshot.js:176` `engine.retrieve(...)` → `lib/engine.js:195` `client.request('graph_query', …)` → `python/worker.py:894` `if ftype == "graph_query":` → `python/worker.py:928` `graph.load(conn, owner)`（`load()` 的**唯一**生产调用者）→ `python/engine/graph.py:433 load()`；回程 `lib/engine.js:211` `pathsText` → `:221` `parts.push('【关联知识路径】\n' + pathsText)` → `:223-224` `renderInjectedBlock({memoryText})` → `lib/turn-snapshot.js:208` `memoryText = r.text` → `:259` 拼进 `text` → `:297` `{name:'echo:snapshot', order:10260}`。⇒ **现状确实会进人格注入**（【关联知识路径】那一段就是这条路进去的）。③ **但影子边今天还没进去，且挡住它的不是"没人读"，而是归属键本身**：`load()` 的边谓词是 `WHERE owner_key = ?`（`graph.py:463`），影子边落在 `graph_gate.SHADOW_OWNER = "__shadow__"`（`graph_gate.py:123`；`:117-121` 的注释写明"换成本常量后 `load('master')` 指纹逐位不变"）⇒ `load('master')` 看不见它们。**⇒ 风险等级：不下调、也不升为"已进人格注入"，如实记为"读口是活的、安全垫只剩归属键一层"**：一旦有任何读口以 `__shadow__` 为 owner 调 `load()`（阶段 4 的 PPR、将来的记忆工具、任何新检索面），影子边**当场**进人格注入；若有人把 `load()` 的边谓词放宽（去掉 `owner_key` 或加 `OR owner_key = '__shadow__'`），同样当场进。影子边的隔离**不得**依赖"当前没有读口"这一条已经不成立的假设。④ 附带查清：`lib/engine.js:397` 的 `store.topEntityNames(20)` **不是**人格注入通道 —— 它是 `client.request('extract_prompt', {knownEntities})`（`:398`）的**反思/抽取提示词**输入。 |
| 17 | **阶段 2d：节点 `owner_key` 写入修复 + 回填脚本（本轮已落地）** | **本轮实施（2026-10-01）**：① `python/engine/graph.py` 的 `get_or_create_node(conn, name, node_type="concept", owner_key="master")` —— `owner_key` 做**显式入参、默认 `"master"`**，INSERT 列带上（此前列里没有它 ⇒ 引擎现场新建的节点 `owner_key` 全是 NULL）；既有 2 个调用点（`graph.py:331/332`，都在 `add_edge` 内）**一个字没改**（⚠️ 任务书说"既有 3 个调用点"，**全仓逐处扫完实为 2 个**，第 3 处不存在 —— 按实测记，不硬凑）。单测 `python/tests/test_graph_owner_key.py`（10 例，临时库）钉住"新建节点 `owner_key` 非 NULL"。② 新增 `scripts/graph-owner-key-backfill.mjs`：**默认 dry-run**、`--apply` 才写、SQL 里**写死**谓词 `owner_key IS NULL OR owner_key = ''`、dry-run 只读双保险（`file:…?mode=ro` + `readOnly:true`）；**没有**任何自动路径接进 `python/engine/db.py` 的 `connect()`。**活库 dry-run 实测**：节点 28 / 无主 5 ⇒「**将改 5 行**」，行名 = `音理`/`舞萌`/`计算机大类`/`老乡鸡的梅菜扣肉`/`麦当劳随心配1+1`，库文件 sha256 **前后一致**（`78b308fe964b5983…`）。**幂等**：对副本（`.scratch`）预填后跑同一谓词 ⇒「将改 0 行」。**本阶段未 `--apply`**（往她真库写要等人类裁决）。 |

| 18 | **stage2e：形态 (b) 的"启用路径"已核定（不重启宿主可行）+ 两个口径澄清** | **本轮核定（2026-10-01）**：① **不用重启的路** = 改 `$DSH_HOME/profiles/web/cordis.patch.yml` 给 `id: echo` 加 `config: { memorySubagentTools: true }`；依据是 `patchReload: "live"` + 宿主监视 patch 文件后走 loader `Entry.update` 的"**只改 config ⇒ `fiber.update` ⇒ restart ⇒ 重跑 `apply(ctx,newConfig)`**"分支（逐行核过：`dsh-app-boot/lib/index.js:1109-1122`、`:141-148`；`cordis-plugin-loader/src/config/entry.ts` `_patchContext`；`cordis/src/fiber.ts:736-752`）。**环境变量 `ECHO_MEMORY_SUBAGENT_TOOLS=1` 那条必须重启**（`process.env` / `apply()` 都只在启动读一次）；插件自己的 `settings.memorySubagentTools`（`<DATA_DIR>/config.json`）**不触发** fiber restart ⇒ 不算"不重启"路径（**⚑ stage2f 修正**：这句只对"**手改文件**"成立 —— 经**面板/端点** `POST /api/echo/memory-tools` 拨一下是**立即生效**的，既不写宿主文件也不重跑 apply，见 row 19）。② **token 成本两档实测**（口径 = 宿主 `defineTool` 编译后的 `name`+`description`+`inputSchema`，脚本 `scripts/memory-tools-cost.mjs`，**估算非真实分词**）：全量 **1159 字符/轮**（≈290 tok @4chars、≈773 tok @1.5chars 中文口径）；只算 description **237 字符/轮**（≈59 / ≈158 tok）⇒ 旧文里"每轮 400–700 token"落在两档之间，现以两档实数替代。③ **"定义过闸" ≠ "运行时注册成功"**：`scripts/check_tools.mjs` 的 **13/13** 只证明这 4 个定义能过宿主 `defineTool` 的 schema/无损校验（**离线**、与开关无关、永远跑）；真机是否**注册**取决于 `apply()` 那一刻 `memoryToolsEnabled(...)` 的读数与 `store !== null`，失败则 `try/catch` 退回关。两者**互不替代**。（开关仍默认关；本条只记路径与口径，未改默认值、未动宿主 config。） |
| 19 | **stage2f：开关搬进网页仪表盘（他的裁定：「`memorySubagentTools` 的 true/false **应当也能在网页仪表盘里改**才对」）⇒ 不再需要改宿主文件、也不触发 fiber restart** | **本轮实施（2026-10-01）**：① **落盘** = `$DSH_HOME/echo/config.json` **顶层** `memorySubagentTools`（与 `enabled`/`scope` 同层；**不放进 `settings` 段** —— 那段是 51 项调参面，键集被 `tests/settings-fields.test.js:37/130/147` 与 README 的「调参(**N 项」三处钉着，塞进去就得改仓根 README）。写走既有 `toggle.writeConfig()`（`lib/toggle.js:71-80`，`.tmp`+`renameSync` 原子、保留未知字段、失败上抛）。② **新端点** `GET/POST /api/echo/memory-tools`（`lib/index.js` §4b2，写在 `echo.api.settings()` 之后；POST 过 `writeAllowed(req)`，只认**严格布尔**，非布尔 400、缺头 403、异常 500）。③ **立即生效** = 落盘后**当场** `syncSubagentMemoryTools('panel')`：`ctx.tools.register()` 4 个只读工具（host 契约：`register()` 返回**就是** disposer，`dsh-tools/lib/index.js:2768-2782`）+ 重设 reflect 的名单 provider；关掉时先设 provider 再逐个 dispose。**⇒ 走这条路不需要**改 `cordis.patch.yml`、**不 restart fiber**（比 row 18 那条更轻）。④ **判定仍只有一处**：`memoryToolsEnabled()` / `memoryToolSourceReport()`（`lib/memory-read-tools.js`），面板三路读数（env / 宿主配置 / 插件设置）照它显示，`sourceLabel` 出人话。⑤ **两处 UI**：网页仪表盘 `web/app.js` 的「调参」页顶部一张卡（`#cfg-mt`，**刻意不在 `#cfg-form` 内**，否则会把「输入框数 = 字段表条数」的契约挤掉）+ 设置区 `lib/client.js` 的 `MemoryToolsCard`。⑥ **顺手修掉两个既有隐患**（都在 §5b 那段）：**ON→OFF 留死名单**（provider 是模块级变量、只在开的时候被设 ⇒ 关回来时子代理拿到的是"名单里有 4 个、工具已不在"的陈旧值）；**重复 apply 撞 `already registered`**（工具注册挂在**调用者** ctx 的 fiber 上 —— cordis tracker 语义，`cordis/lib/index.js:84-165`、`:128` `if (prop === tracker.property) return ctx` ⇒ echo 卸载时随 fiber 一起摘；本插件现在另外用自己的收尾 effect 显式兜住）。⑦ **实测三态**（`.scratch/verify-memory-tools-panel.mjs`，真 `apply()` + 真 `defineTool` + 真 store，`DSH_HOME` 指临时目录）：改前 `{"on":false,"source":"off","applied":false,"registered":0}` → POST true → `{"on":true,"source":"settings:memorySubagentTools","applied":true,"registered":4,"reason":"on"}` 且 `runStructured` 收到的 `toolFilter` 正好是那 4 个 → POST false → `{"on":false,"applied":false,"registered":0}` 且名单回 `{"allow":[]}`、常驻工具（`echo_status` 等 11 个）没被连累。**边界照实说**：`applied=false` 的兜底口径没变（store 离线 / 注册失败 ⇒ 落盘是开、真挂不上，面板照实显示，不假装）。 |

---

## §12 开工前的总检查单

- [ ] 三项裁决（§0.2）已入档，且 `episode` 节点写成"**最小 + 只作端点 + 不进 L0/画像/人格**"
- [ ] 阶段顺序锁定 `0 → 1 → 2 → 3a → 3b → 4 → 5 → 6`，每阶段可独立停
- [ ] `npm test` / `npm run check` / `npm run test:py` 三道闸 + BOM 闸全绿（改动前先跑一遍记基线）
- [ ] 全库默认关（无新开关默认开）；关掉时与现状**逐位一致**
- [ ] 只允许 `ALTER TABLE ADD COLUMN`；未 drop / 未改既有列语义
- [ ] 未碰三条红线（压缩域 / 人格注入点 / `lib/relay.js`）；未做新开口点
- [ ] P4 类自产物不进 `episodic_memory` / 图谱 / L0
- [ ] 每条新规则都有单测（无单测 = 未落地）
- [ ] 未 commit、未 `git add -A`（**未获明确许可前不 commit**）
- [ ] §0.5 基线数字可复现，且对比带快照日期

---

## §13 文档状态

- 本文件的**阶段 2 设计**（§3）已落到**只读原型 + 子代理通道的默认关实现**上；文档**自身仍不代表任何"已接线到线上行为"的改动**：三条红线未碰（压缩域 / 人格注入点 / `lib/relay.js`）、未 commit、未 `git add`、未动 config、未重启 host。凡本文未给出依据的字段，一律进 §11。
- **本文件当前关联的产出**（截至 2026-10-01，阶段 2）：
  - `docs/PLAN_MEMORY_GRAPH_ACTION.md`（本文件：§3 = 阶段 2 设计与实测记录）；
  - `scripts/memory-tools-proto.mjs`（**只读原型**：最小工具集的只读实现 + "多一轮"差异报表；**未接线**、不在任何在线路径上、跑完库 mtime 不变）；
  - `lib/memory-read-tools.js` + `lib/reflect.js` 的 `toolFilter` 一处 + `lib/index.js` 的注册一处（**形态 (b)**：子代理通道的 4 个只读记忆工具，**环境变量级、默认关**）与其单测 `tests/subagent-memory-tools.test.js`。
  - **除上述以外**，本仓的源码 / config / tests 未因本文件而改动。

---

## §14 运行时挖边的开关(阶段 4:三路 OR · 默认关 · 面板可拨)

> 人类裁定(2026-10-01):「把"运行时自动挖边"也做成能在网页仪表盘拨、拨了**立即生效**
> 的开关(默认关,不改任何现有行为)。」范式照 §3 阶段 2f 的 `memorySubagentTools`(判定
> 单一出处 / 三路 OR / 面板可拨),**键名 `graphShadowEdges`**。

### 14.1 判据(只有一处)

| 层 | 键 / 名 | 谁读 | 改了要重启吗 |
|---|---|---|---|
| ① 环境变量 | `ECHO_GRAPH_GATE`(=1/true/on/yes) | 引擎(`gate_enabled`) | **要**(`process.env` 在宿主启动时固定) |
| ② 宿主 loader 配置 | `graphShadowEdges`(`cordis.patch.yml` → `id: echo` 的 `config:`) | 壳(`graphGateEnabledFromConfig`);`apply()` 时**同步写进③** | 不用 |
| ③ 插件设置 / 网页面板 | `$DSH_HOME/echo/config.json` 顶层 `graphShadowEdges` | **引擎每帧现读**(`config_flag_enabled`) | **不用**(下一帧生效) |

三路 **OR**,env 优先(先判、命中也**不读文件**);全缺 ⇒ 关。壳侧判据在
`lib/graph-gate.js`(`graphGateEnabled` / `graphGateSourceReport` / `graphGateSourceLabel`),
引擎侧在 `python/engine/graph_gate.py`(`gate_enabled` / `config_flag_enabled` / `gate_source`),
**两侧字符串由单测钉住同字**(`tests/graph-gate-switch.test.js` ⑥c)。

### 14.2 引擎读法:为什么选 (b)「每帧现读 `$DSH_HOME/echo/config.json`」

候选 (a)"壳把 flag 放进帧里" 在**这个部署里根本送不到**:
1. 壳**从不发** `graph_learn`(全仓 `lib/**` 没有这个帧的发送点;`lib/store.js:1095` 自己
   就注着"壳侧未接线")⇒ 帧里带 flag 等于把一个开关挂在一条没人走的路上;
2. 宿主代码层热重载是关的(`dsh-base` `hmr: disabled`)⇒ 长跑进程里的"放进帧里"也不会更新,
   谈不上"拨一下立即生效"。
(b) 不需要动 `worker.py` 的逻辑(只改了调用点上方那段注释)、纯 stdlib、**永不抛错**
(文件缺失/坏 JSON/权限 ⇒ 关)、env 仍然优先,且面板那份写入是**原子 rename** ⇒ 不会读到半截文件。
路径推法与 `lib/persona.js` 的 `DATA_DIR` 同一条(`DSH_HOME ?? ~/.dsh` + `/echo/config.json`);
另有 `ECHO_GRAPH_GATE_CONFIG` 可覆盖路径(测试/离线用)。

### 14.3 关掉时的零行为变化口径

开关关 ⇒ `maybe_gate_shadow_edges` 立刻返回(`written`/`receipts` 都是 `null`),**连库都不读**。
实测(同一进程内翻文件):关 = `graph_shadow_edges` / `graph_edges` / `graph_edge_receipts`
差量**全 0**;开 = 影子表 +N、回执 +M,而 `graph_edges` 差量仍是 **0**;再关 = 又全 0。
另有:开关开/关全过程 **12 个生产读口逐位一致**(`load_master`、`render_paths`、`top_nodes`、
`graph_edges` 全表、`graph_nodes` 全表、图读数聚合、DMAE、`topEntityNames`、`graphData`、
`memoryStats`、`memoryHealth`、`neighbors`);唯一增长的是**回执表行数**(那是开关自己要写的
审计行,不属于读口,单独列账)。

### 14.4 面板长什么样

网页仪表盘设置区 → 卡片**「自动挖影子边」**(独立容器 `#cfg-gt`,**不放进** `#cfg-form`:
那一格的输入框数被"字段数 = 字段表条数"的契约钉着;端点 `GET/POST /api/echo/graph-gate`,
写口同 2f:回环 Origin + `x-echo-edit: 1`,**只认严格布尔**)。卡上写明:现状 + 来源、
三路读数、**拨一下立即生效**(引擎每帧现读)、以及显眼的风险提示:

> ⚠️ 打开后,每写一条新记忆都会往 `graph_shadow_edges` 写边(对现有读口仍不可见,
> 可随时关 / 可一行清空:`DELETE FROM graph_shadow_edges`)。

设置区那张卡(`lib/client.js` 的 `GraphGateCard`)与网页那张(`web/app.js`)说同样的话。

### 14.5 回滚

1. 拨回关(或去掉三路里为真的那一路)⇒ 不再挖、不再写,逐位回到现状;
2. 已写的影子行:`DELETE FROM graph_shadow_edges;`(回执留痕可选清:`... WHERE route='shadow-table'`);
3. 不改 config(除非你就是要改)、不重启 host、`master` 名下一行不动。

### 14.6 本轮**没**解决的一件事(留给下一步)

"每写一条新记忆都会挖"这句在**生产路径**上还没完全成立:壳从不发 `graph_learn`,而真实
的事实边写入走 `python/engine/judge.py` 的 `graph.learn(...)`(`extract_commit` 那条),那里
**还没有**挖边钩子。也就是说:开关、面板、引擎判据都通了,但要把"每写一条新记忆"变成
线上真事,还需要在 `judge.py` 那一处加 2 行钩子(本轮允许改的文件只有 `graph_gate.py` /
`worker.py`,所以**没动**,在此记账)。

> ✅ **2026-10-01 已补**:人类裁定「必须补,否则'自动挖边'永远没有活的触发点」⇒ 见 §15。

### 14.7 本轮产出清单

`lib/graph-gate.js`(新)、`lib/toggle.js`(读写+默认键)、`lib/index.js`(4b3 端点 + loader 配置同步)、
`lib/client.js`(`GraphGateCard`)、`web/index.html`+`web/app.js`(`#cfg-gt`)、
`python/engine/graph_gate.py`(两路读法 + `gate_source`)、`python/worker.py`(调用点注释)、
`tests/graph-gate-switch.test.js`(新)、`tests/client-render.test.js`、`tests/web-dashboard.test.js`、
`python/tests/test_graph_gate.py`,以及 `.scratch/stage4-e2e.py`(四态实测)、
`.scratch/route2-compare.py`(12 读口比对,已把回执从读口里摘出来单列)。
- 编码：**UTF-8 无 BOM**（写完复检前 3 字节 ≠ `EF BB BF`）。

---

## §15 最后一跳:真实写边点上的挖边钩子(2026-10-01)

> 人类裁定:「把 `judge.py` 里那条真实写边路径(`graph.learn(...)`)接上挖边钩子 ——
> 默认关、零行为变化、只在开关开时真写、绝不干扰主流程。」

### 15.1 钩子落在哪、什么形态

| 位置 | 形态 |
|---|---|
| `python/engine/judge.py` `commit()` **③b**(事实边 `graph.learn(...)` 之后、悬置话题 `④` 之前) | **一句** `graph_gate.mine_after_memory_write(conn, [w["memoryId"] for w in written ...])`,外面再套一层 `try/except: pass` 作最后保险 |
| `python/engine/graph_gate.py` `mine_after_memory_write()` | 真正的钩子:判开关 → 逐条挖边(`graph_mine.candidates_for_latest_memory(conn, memory_id=…)`)→ 交给 `maybe_gate_shadow_edges()` 过闸门落边/落回执 |

`graph_mine` 是**函数内延迟 import**(它在模块级 import `graph_gate`,反向 import 会成环)。

### 15.2 候选口径(与 `worker.py:graph_learn` **逐字同口径**)

**只挖"这一轮刚写进去的那几条记忆"**:`memory_ids` 来自 `commit()` 里 `written` 条的
`memoryId`(上限 `MAX_HOOK_MEMORIES = 8`,防病态轮次拖慢主流程),每条一行
`candidates_for_latest_memory(conn, memory_id=…)` ⇒ **同记忆共现**类。
**不扫全库**;**同天类**只属于一次性历史回填那条路(一条刚写的记忆本身构不成"同天"),
窗口反复挖被禁止 —— 这一点与 §4 阶段 3a 的运行时裁决一致。

### 15.3 关掉时:逐位零行为变化(**比"差量为 0"更强的口径**)

1. **连库都不读**:`mine_after_memory_write(..., enabled=False)` 先判开关再碰 `conn`
   —— 单测直接拿"一 execute 就抛"的假连接喂它(`test_hook_off_never_touches_the_db`);
2. **≡ 根本不调它**:把钩子换成空实现跑同一次 `judge.commit`,**ack 逐位相同、三张表逐位相同、
   耗时无差**(`test_commit_off_is_identical_to_not_calling_the_hook_at_all`;
   实测 空实现 0.0039s / 真实钩子(关) 0.0030s);
3. **返回值不动**:钩子的产物**不进** `commit()` 的返回字典(源码级断言 + 上面那条对照)。

### 15.4 实测(临时 `DSH_HOME` + **活库副本**,`.scratch/stage4-tail-e2e.py`)

真机入口 = `extract_commit` 帧 → `worker.py:244 judge.commit` → 钩子。五态:

```
① 关(默认)         shadow +0 / edges +0 / receipts +0
② 开(只改文件,同进程) shadow +1 / edges +0 / receipts +2   ← 一对进影子表 + 两对 R1 丢(留痕)
③ 开 + 挖边抛错(monkeypatch) shadow +0 / edges +0 / receipts +1(internal-error,note 有 memory_id)
④ 再关(同进程)      shadow +0 / edges +0 / receipts +0
⑤ env=1(另起进程,文件 false) shadow +1 / edges +0 / receipts +0   ← env 优先
```
③ 的**记忆照旧写进去了**(`extract_ack.written` 一条不少),返回值与①②④同形;
一/二/四三态的 `extract_ack`(只去掉每次新拿到的 `memoryId`)**逐位一致**
⇒ 开关不参与主流程的返回值。

**12 个生产读口**(干净 A/B:两跑发**同样的 3 帧**、写入的记忆行完全相同,唯一差别是开关;
`.scratch/stage4-tail-readports.py` + `.scratch/route2-compare.py report`):
`load_master`、`render_paths`、`top_nodes`、`graph_edges` 全表、`graph_nodes` 全表、图读数聚合、
DMAE、`topEntityNames`、`graphData`、`memoryStats`、`memoryHealth`、`neighbors` ——
**12/12 逐位一致,不一致项 = 0**;影子读数 47→49、回执 77→79(回执是**写侧审计**,单列)。

> ⚠️ 口径说明:五态那一轮的"写前/写后快照"会让 `memoryStats`/`memoryHealth` 变(因为
> **本身就在写测试记忆**,`episodicActive` 222→224)—— 那是被测动作,不是泄漏。所以"读口不变"
> 这句只用**干净 A/B** 那张证据(同输入、只差开关)。

### 15.5 回滚

同 §14.5:拨回关 ⇒ 下一帧起不再挖;**已经写下的行**一行清空
`DELETE FROM graph_shadow_edges;`。钩子**不需要**单独回滚(关着等于没接)。

### 15.6 还没做的(记账)

* 钩子只在 `judge.commit` 这一条写边路径上;`python/engine/reflection.py` 的反思写边
  (`reflection.commit`)与一次性回填脚本**没有**接(反思那条要不要挖,是下一轮的产品判断)。
* 同天类影子边在**运行时**依然不产生(要产生就得允许"扫当天窗口",那会破坏
  "同一对不被反复重计"的裁决)—— 现在同天边只来自一次性回填。
* 本轮**没有**跑真机(宿主里那一次真实对话):验证都在副本 + 帧驱动上;
  真机首次触发时,期望看到的正是"影子表 +N、回执 +M、`extract_ack` 不变"。
