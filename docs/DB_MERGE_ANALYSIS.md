# AstrBot 库与 DSH 库能不能合并（分析，2026-09-25）

> 问题：能不能把 AstrBot 那份库（`memory.db`）和 DSH 这份库（`echo.db`）合并？
>
> 答案分三层：**数据一次性合并——能，而且应该做，但不能用 `--fresh`**（会抹掉
> DSH 自己长出来的 57 条记忆）；**同库双写（两个大脑一份库）——技术上比 9 月 24 日
> 那次裁决时更接近可行，但代价是四条不可逆风险**，其中「两个清空按钮互相抹库」
> 一条就足够否掉它；**传话桥（一个大脑一具嘴）——已定裁决，仍是推荐终态**。
>
> 本文所有数字都是本轮**只读探针**现场读出来的（2026-09-25，两侧库都在原机），
> 不是回忆，也不是估算。

---

## 一、先把「合并」拆成三件不同的事

| 说法 | 含义 | 现状 |
|---|---|---|
| **A. 数据合并**（一次性搬家） | 把 A 库里 DSH 没有的行，并进 `echo.db`，合并完 A 库归档 | 已有 `scripts/import-astrbot.mjs`，但只支持「全量 `--fresh`」，**没有增量合并** |
| **B. 同库双写**（共享灵魂库） | 两侧插件指向**同一个 `.db` 文件**，各自写、各自读，实时互相可见 | A 侧 v8.10.1 已内置 `db_path` 配置项；DSH 侧路径硬编码。2026-09-24 曾落地 a/b 两步后被裁决放弃 |
| **C. 传话桥**（一脑一嘴） | 只保留 DSH 一个大脑，AstrBot 退化成传话筒（HTTP 中继） | 已定裁决并设计完（`docs/PLAN.md` M8），A 侧传话插件尚未开工 |

用户问的「合并」多半是 A；但既然 B 也问得起，本文把三条都摆平了再给结论。

---

## 二、两侧库的现状（只读探针实测）

### 2.1 位置与形状

| | A 侧（QQ 身体） | DSH 侧（现在的她） |
|---|---|---|
| 文件 | `~/.astrbot/data/plugin_data/astrbot_plugin_memory_middleware/memory.db`（3.4 MB） | `~/.dsh/echo/echo.db` |
| 另有一份 | `plugin_data/astrbot_plugin_agent_state/state.db`（**另一个插件的库**，只有 `agent_state` 一张表，7 列，3 行，形状与两边都不同） | — |
| 表 | 10 张 | 12 张 |
| 情景记忆 | 134 行（133 条不同文本） | 183 行（180 条不同文本） |
| 图谱 | 26 节点 / 28 边 | 28 节点 / 33 边 |
| 审计 | 200 行 | 80 行 |
| 悬置话题 | 9 行（**8 开 + 1 已结**） | **0 行** |
| 议程簿 | 4 条 | 10 条 |
| 想念 | 1 行（`__shared__`） | 1 行（`master`） |
| 认知状态 | 3 行（**按会话分**：`Echo:FriendMessage:…`、两个群） | 1 行（`global`） |
| DSH 独有 | — | `conversation_log`（35 行）、`diary`（1 行） |

**A 侧还活着**：AstrBot 桌面端进程 12:05 启动，插件的循环是
`max(15, reminder_check_interval_seconds)`（`main.py:1485`）；实测读库前约 20 秒
`longing_state.updated_at` 与 `agent_state.updated_at` 刚被写过，20 秒窗口内无写入
⇒ 活着、周期写、间隔大于 20 秒。**合并前必须停它**，否则搬的是一个移动目标。

### 2.2 表结构差异（逐表，实测）

| 表 | 差异 |
|---|---|
| `episodic_memory` | A 少 **`status`** 一列（DSH 的置信度门控列）；其余 23 列两边都有 |
| `graph_edges` | DSH 少 A 的三列：`model_silence` / `recent_user_hits` / `user_silence`（A 的 DMAE 时间列） |
| `graph_nodes` | **A 少 10 列**：`activation`、`half_life`、`intrinsic_value`、`learned_at`、`occurred_at`、`recall_count`、`temporal_status`、`owner_key`、`model_silence`、`user_silence` |
| `agent_state`（A-memory vs DSH） | 列集相同（A-state 那份是不同的老插件形状，缺 `mood_reason`/`emotion_vector` 等） |
| `audit_logs` | 两边都是 20 列，**列集相同** |
| `conversation_log` / `diary` | 只有 DSH 有（A 的 DDL 全是 `CREATE TABLE IF NOT EXISTS`，多出来的表对它无害） |

**迁移能力对比（决定「谁是宿主」）**：

- **A 侧会自适应别人的库**：`core/echo_schema.py:207` 的 `_ensure_columns` 会
  `ALTER TABLE ADD COLUMN` 补齐它需要的 26 列（含 `speaker_id`/`intrinsic_value`/
  `learned_at`/`evidence`…），`:405` 起还会补图谱列，随后回填 `learned_at`。
  ⇒ **A 指向 DSH 建的库，A 自己会补齐，零额外改造。**
- **DSH 侧只会补三样**：`store.js:231` 补 `episodic_memory.status`；`python/engine/db.py`
  的 `_migrate_graph_edges` 补 `graph_edges` 的扩展列、`_migrate_episodic_status`
  补 status、v0.15.1 新加的 `_ensure_indexes` 建索引。**`graph_nodes` 的 10 个扩展列
  没有任何迁移函数**（那些列来自 DSH 自己的建表语句）。
  ⇒ 若共享库以 **A 的 `memory.db` 为宿主**，DSH 一读 `graph_nodes.activation` 之类
  就会炸（表已存在，`CREATE TABLE IF NOT EXISTS` 不会补列）。
  **所以真要同库，宿主只能是 DSH 的 `echo.db`**（或先给 DSH 补一段 graph_nodes 迁移）。

### 2.3 键约定分叉（这条是 B 路线的头号语义障碍）

| | 记忆/想念/反思游标主键 | 认知状态键 |
|---|---|---|
| A | **`__shared__`**（`core/echo_constants.py:7` 的 `MEMORY_OWNER_ID`，`main.py:38` 明说「所有发言统一归 `__shared__`」） | 按会话：`Echo:FriendMessage:<id>` / `Echo:GroupMessage:<id>` |
| DSH | **`master`**（`lib/store.js` 的 `MASTER_ID`） | 单行 `global` |

同库双写时，**两侧各写各的键空间**：A 新记的进 `__shared__`，DSH 新记的进 `master`，
谁检索都看不见对方的新记忆 —— 库合并了，「她」却仍然是两个。

### 2.4 增量差（真正要搬的东西）

按 `summary` 逐条对齐（A 133 / DSH 180 条不同文本）：

- **同文命中 123 条**（当年那次搬家确实搬到了）
- **只在 A：10 条**，全是现役、无一是死行，时间集中在 09-23 19:36–22:53，内容是
  面试预算/150 美元/逃课/迎新晚会这一类 —— 说明**搬完之后 A 又长了 10 条**
- **只在 DSH：57 条**，来源是 `reflection` 37 + `private` 17 + `user_taught` 3，
  **没有一条是 `qq`** ⇒ DSH 这些全是它自己长出来的，不是漏搬
- 图谱：节点只在 A 1 个 / 只在 DSH 3 个，交集 25；边只在 A 2 条 / 只在 DSH 7 条，交集 26
- 悬置话题：**A 8 条 open 一条都没搬**（其中 4 条是同一件事的近重复措辞：
  「用户计划明天开始学习数据结构」等），DSH 是 0 行
- 议程簿：A 的 4 条内容 DSH 里都有（子集）
- 审计：A 200 行的时间区间与 DSH 80 行**完全不重叠**（A 的全在 DSH 最早一行之前）
- 想念：A `value=10.0, kicked=1`（两天没人来找她，早触发过关怀）；DSH `0.0715`
  且锚点就是刚才 ⇒ **A 的想念是旧状态，不该搬**，搬过去她会立刻关怀刷屏
- 反思游标：A `last_memory_id=453`、DSH `141` —— **游标是各库 memory_id 空间的
  局部量，绝不可跨库搬**（搬过去会让整固跳到错误窗口）

---

## 三、结论一：数据合并能做，但 `--fresh` 是错的

`docs/PLAN.md:344` 的 M8-c 当初写的是「停两侧 → `import-astrbot.mjs --fresh`
→ 启 dsh web → 记忆 134 行」。**今天照做会删掉 DSH 自己长的东西**：

| 会被 `--fresh` 抹掉 | 数量 |
|---|---|
| DSH 自长的记忆 | 57 条（反思 37 + 私聊 17 + 直教 3） |
| 对话回放 | 35 轮 |
| 审计证据链 | 80 行 |
| 日记 | 1 篇 |

而换回来的只是 A 的 **10 条**新记忆 + 1 节点 + 2 边 + 8 条话题。**代价与收益完全倒挂。**
⇒ M8-c 的正确形态是**增量合并**（新脚本，见 §5），不是重播种。

---

## 四、结论二：同库双写（B）——技术上更近了，但四条不可逆风险

**比 9 月 24 日那次裁决时更容易了**：A 侧有现成的 `db_path` 开关（当前值为空，
即它现在用的是自己的本地库）；A 侧会自适应别人的 schema；DSH 侧 v0.10.0 起有
`busy_timeout=5000` + WAL。所以「接上线」这一层不再难。

难的是接上之后。要真做，**六条硬条件缺一不可**：

1. **宿主只能是 DSH 的 `echo.db`**，A 的 `db_path` 指过来（§2.2：反过来 DSH 会炸）。
2. **统一主键**：A 侧把 `MEMORY_OWNER_ID` 改成 `master`，并把库里 134 行的
   `__shared__` 一并 UPDATE（这本身就是一次数据合并）。
3. **认知状态二选一**：A 的按会话 3 行 vs DSH 的单行 `global` —— 得指定谁写谁读，
   否则「她的心情」有两个版本。
4. **治理单点**：审计裁剪（A `keep=200` vs DSH `keep=100`，两边都是
   `DELETE ... NOT IN (… LIMIT keep)` 的**全局**删除，会互删对方的证据链）、
   TTL 清理（同一算法两套参数，谁跑谁说了算）、索引与回填各建各的。
5. **tick 单点**：想念值/关怀心跳/提醒循环两边都在跑（A：`max(15, …)` 秒），
   同一行 `longing_state` 会被两条节奏推着走 —— 要么关掉一边，要么接受数值抖动。
6. **写入纪律**：A 的 `_clear_all`（`/mem_clear`）与 DSH 的 `echo_memory_clear`
   **操作的是同一张表**：任一具身体的「清空记忆」都会把另一具的记忆一起抹掉。
   DSH 侧刚加的危险区面板还会写审计、要求手打短语确认 —— 这些确认**保护不了
   A 侧的记忆**。

**四条不可逆风险**（按严重度）：双清空互删 > 双 tick 抖动 > 审计/TTL 互删 >
两个「她」（同库不同键时记忆互盲）。再加一条工程风险：AstrBot 那边是
**另一个进程、另一套代码**，改它要连带它的自测（`tests/selftest_v8_4.py`，114 KB）。

⇒ 我的判断：**除非「QQ 与 DSH 必须实时共享同一份记忆」是硬需求，否则不值得**。
而这正是 2026-09-24 那次三修裁决的结论（「一脑一嘴」让整类分布式状态问题蒸发）。

---

## 五、推荐路线：先做增量合并，再让 A 退化成嘴（C）

### 步骤

1. **停两侧**：关 AstrBot（否则边搬边长）、`dsh web` 也停（避免边搬边写）。
2. **双侧备份**（两侧都自带备份惯例，别省）：
   - DSH：`echo.db`、`echo.db-wal`、`echo.db-shm` 三个文件一起复制到
     `~/.dsh/echo/.backups/_backup_before_merge_<时间戳>/`；
   - A：`memory.db` 三件套已有多份 `.backups/`，再补一份当前状态。
3. **干跑合并**（`--dry-run` 先看清单，不写库）。
4. **真跑合并**（幂等，可重复执行）。
5. **A 的审计导出留档**：200 行是「她当年看到什么」的证据链，DSH 的
   `audit_keep=100` 会立刻把老行裁掉 —— 所以**导出成 `.md`/`.json` 存盘**，
   而不是并库（并库等于搬完就删）。
6. **不搬**：想念值（DSH 是活脑）、`agent_state`（键语义不同）、反思游标（局部量）、
   `A-state/state.db`（另一个老插件的形状，DSH 的状态更全，归档即可）。
7. **A 库归档**：`memory.db` 改名留档（答辩是「旅程证据」，`docs/PLAN.md` 明说不删）；
   A 侧插件改成传话插件（方案 C，未开工）或先停用。
8. **验收**：见 §5.2。

### 5.1 增量合并算法规格（供实现 `scripts/merge-astrbot.mjs`）

> **已实现（2026-09-25，v0.17.0）**：`scripts/merge-astrbot.mjs`，并已在活库跑完 ——
> 插入 10 条记忆 / 1 节点 / 2 边 / 8 话题，复跑全 0（幂等），A 的 200 行审计导出留档。
> 计划与落地记录见 `docs/CORE_IN_DSH_PLAN.md` §3.1。下面的规格保留原样，
> 实际实现比它多三条：**近重复第二道闸**（不只 summary 全等）、
> **图谱搬进来就接地**（先查 `graph_aliases` 别名，Tier2 不自动并）、
> **不记水位、每次以当前库为准**（图谱每小时会被 DMAE 维护段删边清孤点）。

- **源**：只读打开 A 的 `memory.db`（`--src` 可覆盖，默认 A 活库路径）。
- **情景记忆**：按 `summary` 精确匹配去重（A 的 10 条新行）：
  - 命中已有 → 跳过（不更新、不改情感分，避免「合并把她的记忆改了」）；
  - 未命中 → 插入，字段映射照 `import-astrbot.mjs`（DMAE 状态
    `half_life`/`recall_count`/`last_recalled`/`intrinsic_value` 原样搬，
    `source='qq'`，`user_id='master'`，`is_master=1`）；
  - `status` 一律写 `'active'`（A 无此列，等价于「未隔离」）；
  - 追加一层**近重复保护**：`summary` 归一化（去空白/去尾句号/全角半角）后
    若与已有行相同，也跳过 —— A 自己的话题表就有 4 条这种近重复，记忆同理。
- **图谱**：节点按 `node_id`、边按 `(source_id, target_id, relation, owner_key)`
  去重后插入；`owner_key` 缺失时按 A 的约定补 `__shared__ → master` 映射，
  否则 DSH 的槽位取代链查不到这些边（v0.15.1 刚建好的 `idx_graph_edge_slot`
  正是给这条链用的）。
- **悬置话题**：走引擎现有的 `threads.remember_pending_thread`（它自带
  `_norm_content` 去重），把 A 的 8 条 open 逐条登记；`follow_up_after` **清零**
  （A 的 8 条到期值都是 0，历史提醒早该过期，不该在 DSH 里补发）。
- **议程簿**：按 `content` 去重（A 的 4 条 DSH 已有 → 实际 0 插入）。
- **审计/想念/状态/游标**：不搬（理由见上）。
- **幂等**：重复执行第二次应报告「新增 0 条」。
- **默认 dry-run**：不加 `--write` 不落库（与 `install.mjs` 的谨慎风格一致）。

### 5.2 验收标准

| 检查 | 期望 |
|---|---|
| `store.memoryStats().episodicTotal` | 183 + 10 = **193**（去重后可能更少，取决于近重复保护命中） |
| 只在 A 的记忆条数（重跑探针） | **0** |
| `pending_threads` open | 8 条（DSH 侧从 0 变 8） |
| 她在会话里提「数据结构」 | 检索能带上那条话题（注入信里出现） |
| 图谱节点/边 | 29 / 35（+1 / +2） |
| DSH 自长的 57 条 + 35 轮对话 + 80 审计 + 1 篇日记 | **一条不少** |
| 审计行数 | 仍是 80（没有被合并污染） |

---

## 六、如果一定要同库（B）：最便宜的正确形状

不推荐，但把路铺出来，免得将来重新研究一遍：

1. A 侧配置 `db_path` 指向 `~/.dsh/echo/echo.db`（**A 侧零代码改动**）。
2. A 侧 `MEMORY_OWNER_ID` 由 `__shared__` 改成 `master`（**一行**），并把库里旧行
   `UPDATE` 成 `master` —— 这一步实际上就是本文 §5 的合并。
3. DSH 侧给 `graph_nodes` 补一段 `_ensure_columns` 风格的迁移（若宿主不是 DSH 库，
   这一步必须有；宿主是 DSH 库则可省）。
4. 关掉 A 侧的治理与定时：`audit_keep`、TTL 清理、想念/关怀 tick、提醒循环
   （**或者**关掉 DSH 侧的对应项 —— 二选一，不能两边都开）。
5. 两侧的「清空记忆」入口加互认：至少让它们在执行前提示「会影响另一具身体的记忆」，
   最好干脆只保留一个。
6. 重跑 A 的 `tests/selftest_v8_4.py`（它的自测会真实读写这个库）。

工作量：中等（约一到两批）；风险：中高（清单里四条不可逆风险全部保留）；
收益：QQ 与 DSH 实时共享同一份记忆。**这需要重新裁决一次**（2026-09-24 的裁决
是「一脑一嘴」）。

---

## 七、需要你决定的事

1. **只做数据合并**（推荐）：我写 `scripts/merge-astrbot.mjs`（默认 dry-run、
   幂等、带双侧备份检查），你停 AstrBot 与 `dsh web` 后跑一次 → 收工。
2. **要同库双写**：按 §6 铺路，我会先出「改动清单 + 回滚方案」再动手，
   并且需要你确认接受清单里那四条风险。
3. **走传话桥**：A 侧另写传话插件（`docs/PLAN.md` M8-b 已有设计），
   QQ 只当嘴 —— 数据合并仍要按 §5 做一次（否则 DSH 缺那 10 条）。
