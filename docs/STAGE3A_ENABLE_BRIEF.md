# 阶段 3a 启用前汇总(给人类决策:要不要真写库)

> 2026-10-01 · 口径:快照 `.scratch/echo-db-snapshot-306.db`(`--max-memory-id 306`,只读复现)
> 现状:**开关默认关、活库零写入**;下面所有数字都是"打开开关会发生什么"的推演 + 副本实测。

## 一句话

打开开关 = 写 **47 条"影子边"**(同记忆共现 5 条 + 同天共现 42 条)。它们
**不进检索、不进 L0、不参与 DMAE 老化**,只在她自己的一个独立维度里躺着;
随时可以一条 SQL 抹掉,且**对任何读者零副作用**。

> ⚠️ **落地口径(2026-10-01 路线 2,已验收)**:这 47 条落在一张**独立的表**
> `graph_shadow_edges` 里(**不是** `graph_edges` 里挂 `owner_key='__shadow__'` 的那种做法)。
> 因此下表"启用后"的合并数字(活跃边 23→70 等)是**合并视图**口径 —— 真要看到它,
> 得显式 UNION 那张表;现有读口(`load`/DMAE/渲染/L0)一条 SQL 都不碰它。

## 数字(现在 → 启用后)

| 指标 | 现在 | 启用后 | 说明 |
|---|---|---|---|
| 活跃边(`is_active=1`) | 23 | **70** | +47 |
| 不含说话人节点的活跃边 | 1 | **48** | 这是"路网到底建起来没有"的判据 |
| 节点 | 28 | 28 | 端点全是**既有概念节点**,不建新节点 |
| L0 图位(人格注入那层) | 3 | **3** | 实测:L0 治理**不抓**影子边 |
| 写入行 | — | **47** | `kind=cooccur_same_memory / cooccur_same_day` |
| 回执行(丢边留痕) | — | **77** | 全是 `speaker-node`(说话人端点),不是"静默丢弃" |
| 丢边 | — | **0** 条零重合 | 同记忆判交集、同天判两端各自有据 |

派生口径(对账用):同记忆候选 30 → R1 后 5;同天候选 94 → R1 后 42(与冻结契约 30/25/5、94/52 一致)。

## 读者可见性(全部实测,不是推断)

| 读口 | 看不看得见影子边 | 证据 |
|---|---|---|
| 检索 `load(owner)` → `graph_activate` → 人格注入 | **看不见** | `load('master')` 指纹 `c02fea9dc6400636` **逐位不变**(边 42→42);`render_paths` 文本逐位不变 |
| L0 图位治理 `l0_tier.migrate` | **看不见** | L0 边 3 → 3;`owner_key='__shadow__'` 里进 L0 的 = 0 |
| 谓词归并 `merge_relation_variants` | **看不见** | 归并后 `master` 边行逐位一致 |
| DMAE 强化/物化/剪枝 | **看不见** | +61 天推演:影子边 47 → 47(被剪 0),`activation` 一条没被写 |
| 度数榜 `graph.top_nodes(20)`(engine,喂反思提示词) | **看不见**(已修) | 2026-10-01 真写库时被并行代理抓到:原本只过滤节点 owner ⇒ `音理` 第 7 → **第 2**;已改成 `ON` 子句过滤 + 单测钉住 |
| 度数榜 `store.topEntityNames(20)`(壳侧,喂 `extract_prompt` 的 `knownEntities`) | **看不见**(2026-10-01 路线 2 落地后更新) | 影子边住进 `graph_shadow_edges` ⇒ 这个读口读的那张表里**没有影子行**;`lib/store.js` 一个字没改 |
| 面板 `graphData()` / `memoryStats()` / `memoryHealth()` / 记忆工具 `neighbors()` | **看不见**(同上) | 同上 —— 全部只读 `graph_edges`;两个库逐项比过(见文末「路线 2 落地」) |
| 影子边自己的读口 `load('__shadow__')` | 看得见 | 14 节点 / 47 边,一条不丢 |

落库位置:`graph_edges` 47 行(`owner_key='__shadow__'`)+ `graph_edge_receipts` 77 行。

## 成本 / 触发时机

- **一次性历史回填**:一次只读扫描(222 条活跃记忆)+ 47 次 INSERT。**无 LLM、无网络**。
- **运行时**:每次记忆写入只挖**刚写入的那一条**记忆(同一对不会被反复重计;没有"最近 N 条窗口"这种口径)。
- **开关(2026-10-01 阶段 4 起,三路 OR,默认关)**:
  ① 环境变量 `ECHO_GRAPH_GATE=1`(优先;改它要重启宿主,因为 `process.env` 在宿主启动时就固定了);
  ② 宿主 loader 配置 `graphShadowEdges`(`cordis.patch.yml` 给 `id: echo` 那行加 `config:`;apply 时会**同步写进**③那份文件);
  ③ **插件设置 / 网页面板开关** `$DSH_HOME/echo/config.json` 顶层 `graphShadowEdges` —— 引擎**每帧现读**这个文件(不缓存)⇒ **拨一下下一帧就生效,不用重启宿主、不用热重载**。
  三路任一为开即开(`python/engine/graph_gate.py` 的 `gate_enabled`);关着时引擎**连库都不读**。
  面板:网页仪表盘设置区那张「自动挖影子边」卡(端点 `GET/POST /api/echo/graph-gate`),卡片上写明三路读数 + 风险提示 + 一行回退。

## 风险与已封口

1. **影子边漏进检索**(原本会发生:`load('master')` 边 42 → 89)→ **已封**:影子边走**独立的表** `graph_shadow_edges`,现有读口一条 SQL 都不碰它(实测:开关开/关全过程 12 个生产读口逐位一致)。
2. **DMAE 60 天后把影子边当噪声整批删掉**(原本会发生:47 → 0)→ **已封**:DMAE 只看事实边,且既有 42 条事实边的老化行为逐位不变。
3. **影子边的保留谓词槽位若被事实边占用** → 不动它 + 打一行告警 + 计数 `warnings`(风险≈0)。
4. **槽位让位**(事实边用保留谓词在同槽位换宾语)会把影子边停用 → 有留痕测试盯着,风险≈0。

## 回退(一键)

1. 关掉开关(面板里拨回去 / 清掉那三路任一为真的那一路)⇒ 不再挖、不再写,**逐位回到现状**(实测:关掉时连库都不读,三张表差量全 0)。
2. 已经写下的影子行:因为对任何读者都不可见,抹掉零副作用 —— **一行**:
   `DELETE FROM graph_shadow_edges;`
   (回执表里那些 `route='shadow-table'` 的审计行只是留痕,想一起清:`DELETE FROM graph_edge_receipts WHERE route='shadow-table';` —— 阶段 1 之前的老行没有 route 列,别拿 `LIKE` 去扫。)
3. 不删任何既有行、不改 config、不重启 host、`master` 名下一行不动。

---

# 影子边存储:两条路线的施工清单

> 2026-10-01 追加(等待人类在"选项 1 / 选项 2"之间裁决时写)。**本节只是清单,未施工。**
> 触发原因:`top_nodes()` 与 `store.topEntityNames(20)` 在真写库时被抓到泄漏(卡口 2/3)。

## 0. `graph_edges` 读点全表(grep 判定,决定"路线 1 要补几处")

方法:`grep -n graph_edges` 扫全仓(Python + JS + 脚本),逐个判定"归属过滤 / kind 过滤 / 影子边会不会进去"。

| # | 读点 | 归属过滤 | kind 过滤 | 影子边的后果 | 判定 |
|---|---|---|---|---|---|
| 1 | `graph.py:499-506` `load()` 边查询 | ✅ `owner_key=?` | ✗(不需要) | 看不见(**方案 A 的地基**) | OK |
| 2 | `graph.py:484-493` `load()` 节点子查询 | ✅ owner | ✗ | 看不见 | OK |
| 3 | `graph.py:390-397` `add_edge` 三元组查找 | ✅ owner | ✗ | 看不见(写路径) | OK |
| 4 | `graph.py:143-157` `merge_relation_variants` | ✅ owner | ✗ | 看不见 | OK |
| 5 | `graph.py:282-311` **`top_nodes()`** | 节点 owner ✅ | ✅ 已加 | **已修**(卡口 2,过滤进 `ON`) | ✅ |
| 6 | `graph.py:963-984` DMAE `all_edges` | ✗(有意:全局老化) | ✅ 已加 | **已修** | ✅ |
| 7 | `graph.py:1025-1028` DMAE prune DELETE | — | ✅(吃 6 的 ids) | **已修** | ✅ |
| 8 | **`graph.py:1030-1036` 孤儿节点回收** | ❌ 无 | ❌ 无 | **影子边让"只被影子边连着"的节点免于回收** ⇒ 节点留在 `graph_nodes`,再经 5/15 进入名单尾部 | ❌ **新发现,路线 1 必补** |
| 9 | `l0_tier.py:89-93` demote | ✅ owner | ✗(不需要) | 看不见 | OK |
| 10 | `l0_tier.py:163-168` promote | ✅ owner | ✗(不需要) | 看不见 | OK |
| 11 | `graph_gate.py:853-859` 影子写口槽位查找 | ✅ `__shadow__` | ✗(有意) | 这是影子边**自己的**通道 | OK |
| 12 | `graph_gate.py:1067-1071` 既有事实槽位 | ✗ | ✅ `kind IN ('','fact')` | 看不见(22 个真槽位) | OK |
| 13 | `graph_mine.py:581` `_read_active_edges` | ✗ | ❌ 无 | **测量口径**:合并视图"23 → 70"本来就含影子边 | OK(仅测量) |
| 14 | `store.js:1122-1125` **`graphData()`** | ❌(节点与边都不看 owner) | ❌ | **面板 `/graph` 画出 47 条影子边**;`memory-read-tools.neighbors()` 也吃它 | ❌ **泄漏** |
| 15 | `store.js:1219-1226` **`topEntityNames(20)`** | ❌ 边不看 | ❌ | **喂 `extract_prompt.knownEntities`** ⇒ 提示词级泄漏,`音理` 第 7→第 2 | ❌ **泄漏(待裁决)** |
| 16 | `store.js:948` `memoryStats()` 边计数 | ✗ | ✗ | 面板"边数" 42 → 89 | ⚠️ 显示级 |
| 17 | `store.js:1275-1278` health 时间态直方图 | ✗ | ✗ | 面板时间态统计 +47(全落 `time_unknown`) | ⚠️ 显示级 |
| 18 | `memory-read-tools.js:216-253` `neighbors()` | ❌(自述 `ownerFiltered:false`) | ❌ | 记忆工具的"一跳邻域"返回 `共现`/`同日共现` 边 | ❌ **泄漏(并行 agent 的读口,已自述)** |
| 19 | `scripts/*`(memory-doctor / graph-merge / import / merge-astrbot / retire-a-side / arch-facts / graph-baseline) | 各不同 | ✗ | 一次性/诊断;`graph-baseline.mjs` 已冻结 | 记事即可 |

**结论:真泄漏读口 = 4 处**(5 `top_nodes` **已修** / 8 孤儿回收 / 14 `graphData()` / 15 `topEntityNames` / 18 `neighbors`),
**显示级 = 2 处**(16 边数 / 17 时间态直方图),其余 13 处**结构性看不见**(它们按 `owner_key` 过滤)。
其中 14 与 18 是同一个根:`graphData()` 不过滤边 owner;18 的注释已经承认"没有归属过滤"。
**另:并行 workstream 还在长新读口**(`lib/memory-read-tools.js` / `scripts/memory-tools-*` 是这两天才出现的)⇒ 路线 1 是"会一直追着补"的形态。

## 路线 1:继续打补丁(影子边留在 `graph_edges`)

| # | 改哪里 | 怎么改 | 零行为变化论证 | 老库无 `kind` 列的风险 | 单测 |
|---|---|---|---|---|---|
| 8 | `graph.py:1030-1036` 孤儿回收的两个子查询 | 两个 `NOT IN (SELECT ... FROM graph_edges)` 各加 `AND COALESCE(kind,'')=''` | 既有边 `kind` 全 `''` ⇒ 子查询结果不变 ⇒ 回收集合逐位不变 | 无:回收只在 DMAE 路径(库必已迁移) | 造"只挂影子边的节点" ⇒ 不许被删;对照:无影子边时照旧被删 |
| 15 | `store.js:1221` | `ON` 后加 `AND COALESCE(e.kind,'')=''` | 42 条既有边过滤前后 20/20 逐位一致(已在副本实测) | **🔴 有**:JS DDL 与迁移数组都没有 `kind`(红线不许动)⇒ 无列库抛 `no such column: e.kind` ⇒ 被 `lib/index.js:397` 的 `catch` 吞成 `knownEntities=[]`(**静默变空**) | 临时库插影子边 ⇒ 名单不变;再造"无 `kind` 列"的库 ⇒ 按是否加列探测断言 |
| 14 | `store.js:1122-1125` `graphData()` | edges 查询加 `WHERE COALESCE(kind,'')=''`(或加列探测后拼) | 同上(面板读数 42 → 42) | 同上,**而且这里是 `/graph` 页面的主读口**,静默退化=图谱页空白 ⇒ 必须做列探测 | 面板口径:有/无影子边两种库的 `graphData().edges.length` 相等 |
| 18 | `memory-read-tools.js:217` | 与 14 同源:改为按 `kind` 过滤后的 `graphData()`(或让它自己加过滤) | 同上 | 同上 | 邻域返回里不许出现 `共现`/`同日共现` |
| 16 | `store.js:948` | `WHERE COALESCE(kind,'')=''` | 42 → 42 | 同上(显示级,可接受退化) | 面板边数 == 事实边数 |
| 17 | `store.js:1275-1278` | 同上 | 同上 | 同上 | 时间态直方图和 == 事实边数 |
| — | **列探测统一件** | 14/15/16/17 都需要"库有没有 `kind`":在 `openStore` 闭包里探一次(`PRAGMA table_info(graph_edges)`)缓存复用 | 一次性探测,不改任何读数 | **这是消除上述 🔴 的唯一办法**(JS 迁移数组不许动 ⇒ 只能在读侧探) | 探测件单测:无列库返回 false 且 SQL 退回原口径 |

**守卫测试怎么写,才能在"将来出现新读口"时报警**(这是路线 1 最关键的一件):
1. **静态守卫(进 `npm test`)**:扫全仓,凡是 `graph_edges` 的 **SELECT** 语句所在的函数,必须命中白名单;白名单外的 SQL 一旦出现 (a) 带 `JOIN graph_edges` 或 (b) `FROM graph_edges` 且不是 `COUNT(*)` 单表计数,就断言它**必须**含 `owner_key` 过滤**或** `kind` 过滤,否则红。白名单写成**显式文件名+函数名+理由**(新增读口必须显式登记,登记时被迫回答"这条要不要过滤")。
   - 反面清单(已知豁免,写明理由):`load()`(owner 过滤)、`l0_tier`(owner 过滤)、`graph_gate` 写口(自己的通道)、`graph_mine._read_active_edges`(测量口径)、`scripts/*`(非生产)。
2. **动态守卫(进 `python/tests` + `npm test`)**:建一个"**哨兵影子边**"夹具(1 条 `owner_key='__shadow__'`、两端挂在有事实边的节点上、relation 用保留谓词),然后**枚举所有生产读口函数**跑一遍,断言每个函数的输出与"没有哨兵影子边"时**逐位一致**(白名单里"应当看得见"的读口除外,例如 `load('__shadow__')`、合并视图测量)。
   - 这条的价值:新读口一旦被加进"枚举清单"之外就漏;所以配套静态守卫 3。
3. **新增读口的"登记强制"**:把读口清单**落在代码里**(例如 `python/engine/graph_read_ports.py` 里一个 `READ_PORTS` 表 + 一条断言"表里的函数名必须都能 import"),动态守卫遍历这张表 ⇒ 新增读口若没登记就没有守卫,静态守卫 1 会因"没在白名单里"报红 ⇒ 两条咬合。
4. 每次真写库前跑一次 `python -B .scratch/stage3a-live-4-verify-rollback.py` 之类的**端到端对照**(有/无影子边的两库逐位比读数),作为最后一道人工闸。

**路线 1 的总账**:要改 7 处(4 真泄露 + 2 显示级 + 1 列探测统一件),其中壳侧 5 处**都在"喂提示词 / 面板"红线邻域**;且**形态上永远追不上新读口**(本清单 24 小时内就长出来 2 条)。

## 路线 2:影子边另立一张表(推荐)

**表名**:`graph_shadow_edges`(与 `graph_edges` 并列,不做视图、不做触发器 —— 触发器会把红线带进写入路径)。

**列形状**(与 `graph_edges` 关键列对齐,读侧可平移):
```sql
CREATE TABLE IF NOT EXISTS graph_shadow_edges (
  edge_id            INTEGER PRIMARY KEY,
  source_id          TEXT    NOT NULL,
  target_id          TEXT    NOT NULL,
  relation           TEXT    NOT NULL,          -- '共现' / '同日共现'(保留谓词)
  weight             REAL    DEFAULT 1,
  kind               TEXT    NOT NULL,          -- cooccur_same_memory | cooccur_same_day
  owner_key          TEXT    DEFAULT '__shadow__',
  evidence           TEXT    DEFAULT '',        -- '7、33、99…'
  evidence_scope     TEXT    DEFAULT '',        -- same_memory | same_day
  occurred_at        REAL    DEFAULT 0,         -- 同天=当天本地 00:00
  occurred_at_source TEXT    DEFAULT '',
  is_active          INTEGER DEFAULT 1,
  created_at         REAL    DEFAULT 0,
  UNIQUE(source_id, target_id, relation, owner_key)
);
CREATE INDEX IF NOT EXISTS idx_shadow_src ON graph_shadow_edges(source_id, weight DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_slot ON graph_shadow_edges(owner_key, relation, is_active);
```
- **不放** `activation/half_life/recall_count/last_accessed`(影子边不老化;DMAE 天然碰不到它)——这正是"结构上不可能漏"的一半。
- `graph_edges` 一个字节不动 ⇒ 第 5/14/15/16/17/18 条**全部自动免疫**(它们读 `graph_edges`)。

**写入侧改哪**:
- `db.py`:新增这张表的 DDL + 幂等迁移(纯增,**不动** `graph_edges` 的任何列);`write_receipts` 不变。
- `graph_gate.write_accepted_edges`(`graph_gate.py:819-900`):INSERT/UPDATE 目标从 `graph_edges` 换成 `graph_shadow_edges`;S1 累加的 `_merge_existing_shadow` 改读新表;`_existing_fact_slots`/R5 仍然只读 `graph_edges`(**R5 语义不变**,因为它本来就是"别挤事实边")。
- `graph.py` 的 `update_and_persist` 可以**回退**成原来的 `WHERE 1 = 1`(不必再过滤 —— 影子边不在那张表里),但那两行过滤留着也无害(它是"将来若有 kind 列"的保险);**建议留着**,因为它同时挡住了"将来别的东西往 `graph_edges` 塞 kind"。
- **回执表复用**(推荐复用):`graph_edge_receipts` 记的是"候选被怎么裁决了",与边落在哪张表无关;只在 payload/注释里标 `route: 'shadow-table'`,便于新旧两版对账。

**阶段 4 怎么读它**:
- 阶段 4("路网真正可用")需要一条**显式的读口**,例如 `graph_shadow.neighbors(conn, node_id, limit)` 或 `shadow_paths(...)`,由 worker 在"要路网"的帧里显式调用;**不允许**从 `load()`/检索/提示词路径顺手读到它。
- 读数口径要单独报(像现在的合并视图):`active_shadow_edges` / `shadow_nodes` / `pairs_with_fact_edge`(影子对里有多少已经被事实边覆盖,这是"路网有没有变成事实"的指标)。

**"现有读路径一个字不改"的证明口径**(怎么证):
1. **静态**:`git diff` 里除"新增表 + 写口换表"外,`graph_edges` 的 SELECT 语句**零改动**(可用上面路线 1 的静态守卫直接跑:所有读口 SQL 文本与改前逐字相同)。
2. **动态(逐位)**:同一批读数在两种库上比 —— ① 影子边在 `graph_edges`(现状)vs ② 影子边在新表(路线 2):
   - **所有生产读口**在 ①/② 下都必须**逐位一致**?不行:① 本身是泄漏态(5/14/15/16/17/18 会变)。正确口径是**三个库互比**:
     a) **无影子边基线库**;b) **路线 2 库**(影子边在新表);c) **路线 1 修好后的库**(影子边在 `graph_edges` 且 7 处都补完)。
     断言:**b 与 a 的所有读口输出逐位一致**(这就是"零泄漏"的定义 —— 影子边对现有读口不存在);
     再断言 **c 与 a 也一致**(证明路线 1 补完也达标);b 与 c 的差别只应出现在"专门读影子边的新读口"上。
   - 具体读数清单:检索(`load('master')` 指纹 + `render_paths` 文本)、`top_nodes(20)`、`store.topEntityNames(20)`、`graphData().edges.length` + 每条边字段、`memoryStats().edges`、health 时间态直方图、`memory-read-tools.neighbors` 输出、DMAE `pruned/edges`。
3. **迁移安全**:新表是**纯增**;`graph_edges` 的行数/内容在 ①②③ 里均不变(唯一例外是 ① 里那 47 行本身就是我们要搬走的)。

## 两条路线对比(一节)

| 维度 | 路线 1(留 `graph_edges` 打补丁) | 路线 2(另立 `graph_shadow_edges`) |
|---|---|---|
| 要改的处 | **7 处**(4 真泄漏 + 2 显示级 + 1 列探测),其中 5 处在壳侧红线邻域 | **3 处**(`db.py` 建表 / 写口换表 / 阶段 4 新读口),`graph_edges` 读点零改 |
| 泄漏面 | 已泄漏 4 类;**新读口一出现就得追着补**(本清单 24h 内长出 2 条) | **结构上为 0**:现有读口读的是另一张表 |
| 老库无 `kind` 列 | 壳侧 5 处都要列探测;漏一处 = **静默退化**(提示词名单/面板空白),难发现 | **不存在这个问题**(新表自己建,`kind` 是它的原生列) |
| 数据形状 | 影子边与事实边同表混居,靠 `owner_key`+`kind` 区分;UNIQUE/让位/槽位语义都要继续小心 | 两张表各自干净:`graph_edges` 只有事实,新表只有影子 |
| 阶段 4 | 读的时候要"记得过滤",容易再漏 | 读口显式、可单独演进(加列不惊动事实边) |
| 迁移/回退 | 回退 SQL 一条(`DELETE ... WHERE owner_key='__shadow__'`) | 回退 = `DROP TABLE graph_shadow_edges`(或留着不读);**更干净** |
| 工作量 | 中(改动分散、每处都要单测与列探测) | 中(改动集中,但写口与阶段 4 读口要重写) |
| 风险 | **长期风险**:维护性洞(每次新读口都是潜在泄漏)+ 静默退化 | **一次性风险**:写口换表的回归(靠 S1 累加/幂等/槽位告警那 6 条现有单测平移覆盖) |
| 结论 | 只是把已知的洞一个个补上,追不上增长 | **推荐**:让"影子边不接检索"变成结构事实,而不是纪律 |

---

# 路线 2 落地(2026-10-01,人类裁决后施工完成)

- **建表**:`graph_shadow_edges`(`source_id / target_id / relation / weight / kind /
  owner_key / evidence / evidence_scope / occurred_at / occurred_at_source /
  is_active / created_at` + `UNIQUE(source_id,target_id,relation,owner_key)`;
  **不含** `activation / half_life / recall_count / last_accessed / layer / slot` ⇒
  影子边结构上不老化、不进 L0、不参与槽位让位)。`graph_edges` 的列 / 约束 / 索引一个字没动。
- **写口**:`graph_gate.write_accepted_edges` 只写新表(S1 累加语义原样平移);
  `graph_gate.py` 里不再有 `INSERT/UPDATE/DELETE ... graph_edges`(静态守卫盯着)。
- **回执**:`graph_edge_receipts` 复用,新增 `route` 列,本批 77 行 = `shadow-table`。
- **活库**:47 条已写入新表(同记忆 5 / 同天 42);`graph_edges` 仍 **42 行 / 活跃 23 /
  owner 只有 master**;同 `run_id` 复跑 `inserted 0 / updated 0 / skipped 47`。
- **零泄漏证明(两库逐项比,全部一致)**:`load('master')` 指纹 + `render_paths` 文本 /
  `top_nodes(20)` / `topEntityNames(20)` / `graphData()`(边数 29 + 每边字段)/
  `memoryStats()` / `memoryHealth()` / `neighbors()` / DMAE 的 `pruned`、`edges`。
- **回退(一行)**:`DELETE FROM graph_shadow_edges;` —— 副本演练过:删 47 行后
  所有读数**逐位回到写前**(回执是审计,不删)。
- **阶段 4 怎么读它**:显式读口 `graph_gate.shadow_stats()`(现有数字:活跃影子边 47 /
  影子节点 14 / 与事实边重合的对 **0**)⇒ 影子对全是新信息,一条都还没被事实边覆盖。

