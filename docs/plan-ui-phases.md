# Echo 控制台 · 分屏化实施规划（阶段 2 起）

> 状态：**规划稿，等<称呼>签字**。本轮只读代码与接口，没有改任何文件。
> 依据：`web/mock/final/` 三文件（阶段 1 已验收）、产品 `web/index.html|app.js`、`lib/` 只读、
> 13 个只读端点的实测（2026-10-25，`127.0.0.1:3080`）、`lint --app` / `inspect --app` 实跑。
> 唯一的硬约束是他那句：**「后面最好不要全都一块一块往下加，会很影响使用」**。

---

## 1. 现状盘点（全部有证据）

### 1.1 mock 现在的结构（`web/mock/final/`）

三个文件，一条 HTML 树，一次 init 拉 5 个端点，没有任何路由。

| 块 | 位置 | 状态 | 证据 |
|---|---|---|---|
| 顶部品牌 + 导航（4 条锚点） | `index.html:22-36` | 锚点跳转，非视图 | `href="#home/#conversations/#threads/#diary"` |
| 6 个 KPI（牵挂/情绪/可用记忆/图谱/待跟进/日记） | `index.html:46-77` | 活数据 | 渲染在 `app.js:469-544` |
| 最近对话：静息 3 条 → 12/页 | `index.html:80-97` | 分页器 + 原地展开 | `app.js:13,22,210-244` |
| 运行状态 12 行 | `index.html:99-112` | 活数据 | `app.js:491-522` |
| 要记得的事：静息 2 条 → 10/页 + 3 筛选 | `index.html:114-139` | 分页器 + chips | `app.js:16,246-338` |
| 最近日记：静息 2 条 → 全 7 条 + 全文展开 | `index.html:141-153` | 无分页 | `app.js:17,340-446` |
| 展开时切单列 | `app.css:288-291` | `.content-grid.is-reading` | 由 `app.js:195-200` 控制 |
| 手机吸顶条 + 抽屉 | `index.html:13-19,160-177` | 静态页名「近况」 | `index.html:15` |

**规模实测**（`docs/screenshots/final-1440-viewport.json`、`final-expanded-1440-viewport.json`）：

| 状态 | scrollHeight @1440×900 | 屏数 |
|---|---|---|
| 静息 | **1,157px** | 1.3 |
| 对话展开（12 条） | **2,890px** | 3.2 |
| 日记全开 + 一条全文 | **2,461px** | 2.7 |
| 待跟进展开 | 1,870px | 2.1 |

这就是他那句话的量化版本：**同一个页面，点一下就从 1.3 屏变成 3.2 屏**。再加屏必然继续往上长。

### 1.2 mock 里的 bug / 口径问题（只记录，本轮不动手）

| # | 现象 | 证据 | 判断 |
|---|---|---|---|
| B1 | 导航写死「首页是当前页」：点「待跟进」后跳过去了，`aria-current="page"` 仍留在首页 | `index.html:27`、`index.html:170`，`app.js` 全文 0 处 `nav-link`/`aria-current` | **真 bug**（可访问性 + 状态撒谎）。分屏后必须由路由接管 |
| B2 | 手机吸顶条的页名写死「近况」 | `index.html:15` + `app.css:425` | **真 bug**，分屏后必须跟路由变 |
| B3 | 对话标题写「共 100 条」——100 是服务端硬上限，不是总数 | `app.js:228-230`；上限在 `lib/store.js:1969`（`Math.min(100, …)`） | **文案无据**（不是数据错），分屏后改写「最近 100 轮（本机上限）」 |
| B4 | 待跟进 KPI 显示 **1**，同一块面板写「共 **57** 条」（那个数是活的：实测快照 57，今天端点给 90） | `app.js:265-271`（KPI=due+waiting）与 `app.js:311-313`（caption=全部） | **口径不同，不是 bug**，但屏上必须一句话交代，否则读作矛盾 |
| B5 | 「最近日记 7」既是条数又像天数 | `app.js:345`；端点固定 7 条 `lib/index.js:5100` | **口径含糊**，分屏时写「最近 7 条」 |
| B6 | 牵挂值取数失败时把 `<p>` 塞进 `<p>` | 容器是 `index.html:50` 的 `<p class="reading-note">`，错误分支 `app.js:551-568` | 无效嵌套（DOM API 允许、语义错）。**低优先，记录** |

### 1.3 产品的导航与端点（`web/index.html` / `web/app.js`）

导航是 **20 条链接 / 6 个分组**（`web/index.html:29-55`，`grep class="navlink"` = 20），
导航表是 `PANELS` 一张表 20 项（`web/app.js:304-327`），**已经是 hash 路由**
（`panelFromHash` `app.js:387-392`、`hashchange` `app.js:448-450`、`showPanel` `app.js:367-385`）。

产品的端点面（`web/app.js` 里出现的路径常量 22 条 + `web/index.html:193-194` 的 `export`
两条下载链接 + 只在注释里出现的 `session-label`）：

```
status longing conversations threads diary audit memories graph graph-arch graph-gate
emotion health profile scope settings setup memory-tools export events(SSE)
toggle context/clear relay/* data/* session-label
```

**mock 只用了 5 个**：`status / longing / conversations / threads / diary`（`app.js:4-10`）。
用户清单里剩下的 **8 个一个都没进**：`audit / memories / graph / emotion / health / profile / scope / settings`。

### 1.4 13 个只读端点的实测规模（2026-10-25，端口 3080）

| 端点 | 字节 | 形状 | 关键数字 | 上限 / 陷阱 |
|---|---|---|---|---|
| `/status` | 9,023 | 29 键，含 engine/embed/relay/reflect/toolAudit/retrieval/queryExpand/ipcAppraise/sameTurnEmotion/inject/care/voiceReceipts | `memory.episodicActive 629 / total 749 / quarantined 18 / l0 19 / graphNodes **64** / graphEdges **97** / auditRows 1000 / superseded 59`，`moodIntensity 5`，sidecar `pid 6132 restarts 0 breakerOpen false`，embed `warmed false`，relay `channels 6`，queue `queued 6 sent 1574 dropped 11` | 含 `dataDir`/`dbPath` **绝对路径**（不上屏） |
| `/longing` | 187 | `rows[1]` | value 6.819、threshold 5.5、shouldCare false、careCount 53、sinceMessage 443s | 引擎在=python，不在=baseline |
| `/conversations?limit=100` | 70,253 | `rows[100]` + `labels{3}` | 100 轮 | **硬上限 100**（`store.js:1969`）；无总数，无 offset |
| `/threads` | 30,687 | 7 桶 | waiting 1 / due 0 / done 2 / untimed 56 / cooling 29 / resolved 2 / archived 0 = **90** | **硬上限 90**（`listThreads` SQL `LIMIT 30*3`，`store.js:1268`）；`/health.threads.open = 115` ⇒ **有 25 条没进窗口** |
| `/diary` | 10,328 | `rows[7]` | 7 条，date/content/mood/longingValue | **固定 7 条**（`lib/index.js:5100` 写死），无分页参数 |
| `/audit?limit=200` | 532,679 | 21 字段 | 200 行；`light=1` 时 **280,617** | **硬上限 200**（`store.js:1213`）；**没有"更早"分页**（只有 `since` 往前，`store.js:1212`） |
| `/audit?limit=200&light=1` | 280,617 | — | distinct traceId **200/200**；`stage: tool:*` **192/200**；有 `injectedMemories` 的只有 **2/200**；`emotionVector` 200/200 | **不能一行一轮**（见 1.5） |
| `/memories?limit=100` | 51,072 | total/page/limit/rows | active **629**，all **749**，quarantined **18**，forgotten **102** | 服务端分页 `page/limit≤200/state/layer/source/q/sort` |
| `/graph` | 66,400 | nodes/edges/layers | nodes **56**、edges **84**、shadow **48**、evidence **118** | 与 `/status` 的 64/97 **不一致**（见 1.5） |
| `/emotion` | 1,335 | `rows[1]` | moodIntensity 5 / prev 5 / userEmotion loving / moodReason / currentTopic / `emotionVector{global{fatigue0,valence2,arousal3}, target_master{affection6,playfulness6,sadness0,dependency6}, ipc_dyad{gate"yellow", scale"unipolar", gain0.88}}` | 只有 global 一行 |
| `/health` | 284 | dmae/temporal/temporalEdges/threads | dmae `573/41/15, avgR .782, total 629`；temporal 5 档；threads `open 115, due 0` | — |
| `/profile` | 249 | 9 键 | userName <称呼> / agentName 助手 / agentSelfRef Echo / locale zh-CN / timezone Asia/Shanghai | 中性兜底，绝不留真名 |
| `/scope` | 7,243 | scope/sessions/exempt/manualOff/power | sessions **30**、exempt 26、manualOff 26、whitelist 0、power on | `sessions[]` 有 sessionId/lastAt/turns/label |
| `/settings` | 56,622 | settings/defaults/fields/derived | **21 组 / 131 项 / 80 个值**、relayTokenSet true | 只读；写路径本轮禁用 |

顺带实测（不在清单内，只读）：`/setup` 3KB、`/memory-tools` 1KB、`/graph-arch` 8KB、`/graph-gate` 1KB。
`/api/echo/events` 是 SSE 长连接，**本轮未探测**（会挂死命令）。

### 1.5 两个必须写进屏里的口径冲突

**（a）图谱 64/97 vs 56/84 —— 不是 bug，是两个口径。**
`/status.memory.graphNodes` 数的是**全量**（`store.js:1160-1161`，`COUNT(*) FROM graph_nodes/graph_edges`）；
`/graph` 只给**能画的**：节点 `WHERE COALESCE(is_active,1)=1`（`store.js:1356-1359`），
边再按存活节点过滤掉悬空边（`store.js:1442`）。差 8 个墓碑节点、13 条边。

**（b）审计 200 行折不成 200 轮。**
`traceId` 每行一个（实测 200/200 不重复），它是"这一次工具调用"不是"这一轮"。
产品早就解决了，主键是 `stageDetail.turnTrace`，没有就退回时间窗 + 桶
（`web/audit-view.js:289-331`，`ATTACH_SEC=900`）。**执行时直接复用这个文件，不许自己发明第二套折轮规则。**

---

## 2. 信息架构（本文件最重要的一节）

### 2.0 先签字：唯一的争议决定

> **决定 A（推荐）**：总览的 6 KPI、12 行状态、三个列表的静息条数与位置**一个像素都不动**；
> 只改一处——**「查看更多对话」与「查看更多（待跟进）」两个按钮**的动作，从**原地展开**改成
> **跳到那一屏**（`#/talk`、`#/threads`）。日记的「查看更多日记」**保持现状原地展开**
> （端点固定 7 条，全开也只有 761px，且本轮不做日记屏，见 §4.3）。
>
> 理由：他嫌的就是"往下加"，而实测展开一次就是 2,890px（1.1 节）；
> 仪表盘领域规范也明确"总览不放分页，封顶几行 + View all"（`app-screens.md §7.8`）。
>
> **备选 B**：原地展开保留，只在总览**不再新增任何块**。
> 代价：那段 1,465px 的展开还在，且 `#/talk` 会与总览重复一份。

其余全部按 A 写。**A 若被推翻，只影响阶段 P1 的一处 handler 与按钮文案，回滚成本 ≈ 10 行。**

### 2.1 屏的划分：每屏只回答一个问题

| # | 路由 | 屏名 | 它回答的唯一问题 | 主指标（唯一一个大数字） | 数据来源 |
|---|---|---|---|---|---|
| 1 | `#/overview` | 近况 | 她现在怎么样？ | 牵挂值 6.8/10 | `/status` `/longing` `/conversations?limit=100` `/threads` `/diary` |
| 2 | `#/talk` | 对话 | 最近她跟他说了什么？ | 最近 100 轮（上限） | `/conversations?limit=100` |
| 3 | `#/threads` | 待跟进 | 她心里还有哪些事没结掉？ | 未结 90（窗口内） | `/threads`（+`/health.threads`） |
| 4 | `#/emotion` | 情绪 | 她此刻什么心情、为什么？ | 情绪强度 5/10 | `/emotion` `/longing` |
| 5 | `#/audit` | 审计 | 她这一轮到底做了什么？ | 窗口内的**轮数** | `/audit?limit=200&light=1` |
| 6 | `#/memory` | 记忆 | 她记得多少、记得多牢？ | 可用记忆 629 | `/memories` `/health` |
| 7 | `#/graph` | 图谱 | 她的记忆之间连成什么？ | 56 节点 / 84 边 | `/graph` |
| 8 | `#/system` | 系统 | 本机能转得动吗？ | **异常 0 处**（12 项检查汇总，现算） | `/status` `/health` |
| 9 | `#/config` | 配置 | 她现在被设成什么样？ | **被改过 N 项 / 共 131**（N 现算，默认只列改过的） | `/settings` `/profile` `/scope` `/setup` |

导航分 4 组（沿用产品的分组写法，`web/index.html:30,37,42,47`）：

```
此刻      近况 · 情绪
她说与记挂  对话 · 待跟进
记忆      记忆 · 图谱 · 审计
本机      系统 · 配置
```

**总览是被豁免的**：它已有 6 个 KPI，是阶段 1 的验收结果，不改。**新屏一律遵守 2.3 的单指标规则。**

### 2.2 路由约定（hash 路由，不用 path 路由）

```js
// app.js 里唯一的路由表；顺序即导航顺序
const ROUTES = [
  { id: 'overview', title: '近况', page: '近况', group: '此刻',     mount, unmount },
  { id: 'emotion',  title: '情绪', page: '情绪', group: '此刻',     mount, unmount },
  { id: 'talk',     title: '对话', page: '对话', group: '她说与记挂', mount, unmount },
  { id: 'threads',  title: '待跟进', page: '待跟进', group: '她说与记挂', mount, unmount },
  { id: 'memory',   title: '记忆', page: '记忆', group: '记忆',     mount, unmount },
  { id: 'graph',    title: '图谱', page: '图谱', group: '记忆',     mount, unmount },
  { id: 'audit',    title: '审计', page: '审计', group: '记忆',     mount, unmount },
  { id: 'system',   title: '系统', page: '系统', group: '本机',     mount, unmount },
  { id: 'config',   title: '配置', page: '配置', group: '本机',     mount, unmount }
]
```

**为什么必须是 hash：** 静态伺服是"前缀 + 白名单扩展名"，**无扩展名的路径一律 404**
（`lib/webpage.js:66-70`），且没有 SPA 回退。`#/audit` 不会打到服务器，刷新、前进、后退、
复制链接全都成立；`/echo/mock/final/audit` 会直接 404。

行为约定：

1. 进页面时 `location.hash` 为空或未知 ⇒ `history.replaceState(null,'','#/overview')`，
   **不整页刷新**（照抄产品 `web/app.js:445-447` 的同一手法）。
2. `hashchange` ⇒ `renderRoute()`：`unmount` 上一屏 → 隐藏（`hidden`，不删 DOM）→ 显示并 `mount`。
3. 屏内状态（页码、筛选、展开项、选中轮）存在屏自己的 `state` 对象上，**切走不丢**；
   `unmount` 只解绑事件、`AbortController.abort()` 掉在飞的请求，**不清数据**。
4. `mount` 只在**首次进入**拉一次数据；重复进入用缓存。刷新按钮（每屏标题行右侧一个）才重拉。
5. 导航高亮与 `aria-current="page"` 由 `renderRoute()` 统一写，两处导航（侧栏 `index.html:26` +
   抽屉 `index.html:169`）读同一份状态 —— 顺手修掉 B1。
6. 手机吸顶条的 `.mobile-page-name` 写 `ROUTES[i].page` —— 顺手修掉 B2。

### 2.3 怎么防止"每屏又变成 KPI 卡堆"（写死，验收要查）

1. **新屏禁止使用 `.reading`**（那 6 张 16px 内边距的灰卡是总览专属）。新屏的主指标是**裸文字**，
   跟 12px 灰标签上下叠，不套卡片。
2. **新屏只有 1 个 ≥24px 的数字**（总览那 6 个 32px 是阶段 1 的既有结果，豁免）；
   其余数字一律 ≤20px，且只出现在表格/列表的行里。由整屏状态汇总出来的结论性数字（系统屏的「异常 0 处」、配置屏的「被改过 N 项」）**就是这一个数字**，不许再配装饰性大字；数量本身（如「131 项」）只进小字口径，不许当主指标。
3. 屏首只有三样：`h1`（屏名，24px）+ 一句话（这一屏最重要那条事实/口径，14px 灰）+ 一个控件
   （搜索或刷新）。
4. **每屏必须有一块占页面 ≥60% 面积的列表/表格**；只有 2–5 行的屏（如情绪）如实稀疏，不拉伸。
5. 控件最多一排：筛选 chips **或** 搜索框，不同屏逐屏决定，不叠两排。**窄屏（≤767）允许同一组 chips 折行**——折行仍算"一排控件"；禁止的是两组不同控件上下叠放，也禁止横向滚动。
9. **说话人标签必须名实相符**：只有真的从他那来的文本才能标「他」——`relay_in` / `extract` 这类；`inject`（stage=assemble，被注入的旧上下文）与 `retrieve`（检索查询）**不是**他说的话。子代理来源（`sub`）的提示词也不得标「他」。纯标记文本（如 `（她主动开口）`）不算任何一方说话。
6. 首屏（390×844）必须能看见**第一行数据**，不能被标题+控件挤出屏幕。
7. 空/零/缺三态，按 `app-screens.md §11`：真的 0 打 `0`，拿不到打灰色 `—`（沿用现有 `missing = "—"`，
   `app.js:12`）。`—` 在 lint 里算 em-dash WARN，属既定用法，**允许并记录**，不驱逐。
8. 屏内文案不出现：内部 ID（`turnId`/`threadId`/`memoryId`/节点 hash）、trace、绝对路径、进程名以外的敏感项。
   引擎 PID 已在阶段 1 验收里展示，**保留**。

### 2.4 三档宽度的导航行为

| 断点 | 现状（`app.css`） | 分屏后 |
|---|---|---|
| **≥1181** | 侧栏 224px 常驻（`app.css:39`、`83-91`），内容 2 列 12 格 | 侧栏常驻 + 4 组 9 项；选中=灰胶囊 `.nav-link.is-active`（`app.css:113`，已符合规范）。内容单列，`max-width` 不变（1100） |
| **768–1180** | 侧栏压到 200px（`app.css:387`），`content-grid` 先 12 格再折成 1 列（`app.css:391-405`） | 侧栏仍常驻 200px；9 项 + 4 组标签在 768 高度下约 580px，够用。给 `.primary-nav` 加 `overflow-y:auto` 兜底（1024×600 这类矮屏），**不新增断点**。内容单列 |
| **<768** | 侧栏 `display:none`（`app.css:411`），48px 吸顶条（`412-423`）+ 抽屉（`476-489`），`body.menu-open` 锁滚动（`app.css:64`） | 全部保留：吸顶条显示**当前屏名**（B2 修复）；抽屉里 9 项 + 4 组标签，路由点击后关抽屉并把焦点送到该屏 `h1`（`tabindex="-1"`）。`Esc` / scrim 点击 / 焦点陷阱都沿用 `app.js:571-629` 那一套，不改 |

三档都不允许横向滚动（`scrollWidth == innerWidth`，现有 viewport json 已按此验收）。

### 2.5 已记录的、可辩护的闸内告警（不许为它改设计）

- **`hero-void` 出现在"连续列表"屏**（如 `#/threads` @1440）：首屏右侧空白是因为每行只有一句短句、右侧到分类/时间列之间没有盒子可放。实测 `voidShare` 0.275，`probe.mjs` 先 round 成 0.28 才判，**正好压在 0.28 阈值上**，数据一变就会翻面 —— 说明这条红是**网格量化的脆指标**，不是设计缺陷。
  结论：**允许它红着并记录**，理由写进当轮报告；**禁止**用压缩行距、缩小触控区、塞装饰块去把它刷绿（P2v2 已试过一次，被退回）。
- **`em-dash`**：页面用 `—` 表示"取不到"，属既定写法，长期允许，数量作为基线记录（当前 20）。

---

## 3. 分阶段实施清单

**通用纪律（每阶段都适用，不再重复）**

- 一阶段 = 一个 commit。仓库里 `web/mock/` 目前整目录是 **untracked**（`git status` 显示 `?? web/mock/`），
  所以阶段 P1 的第一件事是 `git add web/mock/final`，让后面每一步都有 diff 可回。
  需要"物理回滚点"时另存 `web/mock/final.bak-<yyyymmdd-hhmmss>/`（仓库已有 `final.bak-20261024-221626` 先例）。
  **严禁 `git add web/mock`（整目录）**：里面还有 `v3/v4/v5/seed/bold` 五套过程稿和旧截图，会一起被提交。只 add `web/mock/final` 与 `docs/plan-ui-phases.md`。
- 每阶段**开跑前**先记三个基线数：`scrollHeight` @1440×900、`lint --app` 的 FAIL/WARN 数、
  `inspect --app` 的 FAIL/WARN 数。跑完对比，**变差就停**。
- **证据文件必须 UTF-8 无 BOM**。PowerShell 的 `Set-Content -Encoding utf8`、`Out-File`、`>` 重定向会写成 UTF-8 带 BOM 或 **UTF-16**，`npm run check` 的 BOM 闸会红（已踩三次）。
  统一用：`[IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`。
  写完自查：前两个字节不能是 `EF BB` 或 `FF FE`。
- 每阶段验收都跑这三条（**必须真跑，不许口头通过**）：
  ```
  node %USERPROFILE%\.dsh\skills\design-taste-frontend\scripts\lint.mjs    --app web\mock\final
  node %USERPROFILE%\.dsh\skills\design-taste-frontend\scripts\inspect.mjs --app http://127.0.0.1:3080/echo/mock/final/index.html --out docs\screenshots\<阶段名>
  （三档 CDP 截图：沿用 web/mock/v9/shots/shoot.mjs 的写法，1440×900 / 768×1024 / 390×844，等 documentElement.dataset.dataReady === "true" 再拍）
  ```
  `--allow`：**默认不加**。今天 `lint --app` = 0 FAIL / 1 WARN（em-dash 20 个，即缺值短横），
  `inspect --app` = 0 FAIL / 0 WARN。若某屏真要用表情符号，按口径加 `--allow emoji`，并在提交说明里写清
  哪一屏、为什么；一直带着 `--allow emoji` 也不会放宽其它规则，但要写明理由，不许默默带着。
- 改完刷新即见：静态页每次请求现读磁盘、带 `cache-control: no-store`
  （`lib/index.js:5758-5772`、`lib/webpage.js:100-107`），**不需要 install、不需要重启**。
- 失败即停：任何一步验收红，停下来报告数字，不带着红进下一阶段。

---

### P1 · 路由壳（总览一个像素不动）

**目标**：导航从"同页锚点"变成"真视图切换"，9 条路由可切、可刷新、可前进后退；
总览的外观与数字不变，唯一的动作变化是 §2.0 的决定 A。

**改动**

| 文件 | 改什么 |
|---|---|
| `web/mock/final/index.html` | ① 两处导航（`:26-31`、`:169-174`）换成 9 条 `#/<id>` + 4 个分组标签；② `<main>` 里总览那一段外面包一层 `<section id="view-overview" class="view">`，其后加一个空的 `<div id="view-host"></div>`；③ 吸顶条页名 `:15` 留空由 JS 填；④ 底部按顺序引入 `views/*.js`（在 `app.js` 之前，照抄产品 `web/index.html:246-258` 的顺序纪律） |
| `web/mock/final/app.js` | ① 现有 5 个 `renderXxx` / `drawXxx` 原样搬进 `overview` 屏对象，**函数体不改**；② 新增 `ROUTES`、`renderRoute()`、`mount/unmount` 调度、导航高亮写入；③ 新增公共组件：`pager()`、`chipRow()`、`statusRow()`、`states()`（空/错/载）、`fetchJson()`（已存在，复用 `app.js:69-73`）；④ **两个**「查看更多」按钮（对话 `:87`、待跟进 `:123`）的 handler 改成 `location.hash = '#/talk' / '#/threads'`（决定 A）；日记那个 `:147` **不动** |
| `web/mock/final/app.css` | 只**追加**：`.primary-nav` 分组标签、`.view[hidden]`、`.view-head`（h1+一句话+控件）、`.view-host`、通用表格 `.table`、以及 `#view-host` 在 <768 的间距。**不改**总览已有选择器（`:53,184-367,385-493` 一个字都不动） |
| `web/mock/final/views/*.js` | 本阶段只建 8 个空壳（`globalThis.EchoViews[id] = (function(){ return { mount, unmount } })()`），各屏显示一句「还在做」 |

**为什么允许新增 `views/*.js`（破了"三文件"）**
`app.js` 现在 724 行 / 31KB（读全文确认）。再加 8 屏必然破 100KB 单文件，改一处要读一整块，
且没有任何边界。产品自己就是这条路：`web/views/*.js` 每个视图一个文件、classic script、
只往 `globalThis.EchoViews[id]` 上挂（`web/views/data-health.js:24-35`）。伺服侧本来就支持子目录
（`lib/webpage.js:71-74` 解析 + `MIME['.js']`）。**壳仍然三件：`index.html` / `app.css` / `app.js`。**

**数据口径**：本阶段不新增取数，全部沿用现有 5 个端点与现有渲染函数。

**验收（逐条可执行）**

1. `#/overview`、`#/talk`、`#/threads`、`#/emotion`、`#/audit`、`#/memory`、`#/graph`、`#/system`、`#/config`
   九个 hash 都能进；未知 hash（如 `#/nope`）落到 `#/overview` 且地址栏被改写。
2. 刷新 `#/memory` 后仍停在记忆屏；浏览器后退回到上一屏；前进回来。
3. **总览零回归**：@1440×900 `scrollHeight` = 1157 ± 40；6 个 KPI 文字与阶段 1 一致；
   状态行 = 12；`kpiBottomSpread` = 0。
4. 导航：当前项 `.is-active` + `aria-current="page"`，**且只有一项**；390px 抽屉打开后同样只有一项高亮。
5. 390px：吸顶条页名随屏变化（依次切 3 屏检查）；抽屉点一项后自动关闭、焦点落在该屏 `h1`。
6. `lint --app` 0 FAIL（WARN 允许 1 个 em-dash）；`inspect --app` 0 FAIL。
7. 三档截图各一张存 `docs/screenshots/p1-<w>.png`，肉眼过一遍。

**回滚**：`git revert <P1 commit>`；或 `rmdir /s web\mock\final\views` + 恢复 `.bak` 目录。

---

### P2 · 对话 + 待跟进（用已有数据把路由跑热）

**目标**：两屏，各一屏一问；验证"全量列表在独立屏"这件事成立，且分页状态与总览互不干扰。

**改动**：`views/talk.js`、`views/threads.js` 实现 `mount`；`app.js` 把
`renderConversations/renderThreads` 的 `base/size` 参数化（`paging` 对象按屏实例化，
`app.js:21-25` 现在是一份全局）——这是本阶段唯一的"改公共函数"动作，改完总览仍传 3/12/2/10。

**数据口径**

| 屏 | 口径 |
|---|---|
| 对话 | `/conversations?limit=100`；标题写「最近 100 轮（本机上限）」，**不写"共 N 条"**（B3）；12/页 → 9 页（末页 4 行）；时间相对（`relativeTime`，`app.js:86-97`）；正文 3 行 clamp；`channel` 缺失时打 `—` |
| 待跟进 | `/threads` 7 桶；**窗口上限 90 行**，`/health.threads.open=115` ⇒ 标题写「窗口内 90 / 未结 115」（B2 口径）；chips：全部 / 定时 / 待安排 / 冷却 / 已了结（`done 2 + resolved 2`）；**计数为 0 的 chip 不出现**（归档 0 ⇒ 不显示）；10/页；`kind` 用中性词（承诺/行程/提醒/关心/话题），不显示 `threadId` |

**验收**

1. 对话：第 1 页 12 行、末页 4 行、共 9 页；上一页/下一页在首末页 disabled；翻页后焦点不回 `<body>`（沿用 `app.js:638-646`）。
2. 待跟进：每个出现的 chip 计数与列表条数逐一对上（全部 90 = 定时 1 + 待安排 56 + 冷却 29 + 已了结 4，
   实测和必须是 90）；在「冷却」下翻到底不出现空页。
3. 两屏的页码互不影响：对话翻到第 5 页 → 切待跟进 → 切回对话，仍在第 5 页；总览的静息条数仍是 3 / 2。
4. 空态：手动把 URL 改成 `?limit=0` 之类无效值时（或后端停掉时）出现 `error-copy`，不白屏。
5. `lint --app` / `inspect --app` 0 FAIL；三档截图。

**回滚**：`git revert`；两屏的 `views/*.js` 删回空壳即可，总览不受影响。

---

### P3 · 审计（本批最有价值、也最容易做歪的一屏）

**目标**：一屏回答"她这一轮到底做了什么"。左索引一轮一行，右详情是那一轮的全部行。

**改动**

| 文件 | 改什么 |
|---|---|
| `index.html` | 在 `app.js` 之前插 `<script src="/echo/audit-view.js"></script>`（**只引用，不改它**） |
| `views/audit.js` | 新建。`mount` 里：`fetch('/audit?limit=200&light=1')` → `EchoAuditView.buildTurns(rows)` → 索引列表 + 详情区；搜索用 `EchoAuditView.turnText(turn)` 本地过滤；chips 用 `BUCKETS`（对话/工具/后台/系统…） |
| `app.css` | 追加 `.au-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:16px}`、`.au-idx`（行高 44px、单行省略）、<768 时单列（一次只显示一个区域，选行推到详情，带"返回"） |

**折轮与字段口径（写死，不许自创）**

- 折轮主键 `stageDetail.turnTrace`；缺失退回时间窗 + 桶（`ATTACH_SEC=900`）——直接调
  `EchoAuditView.buildTurns`，**不复制这 663 行逻辑**。
- 索引行显示：时间（`clock`）+ 桶的中文标签 + 一句话摘要（`turnGist`）；**不显示 traceId / turnId / sessionId**。
- 详情显示：那一轮里各行的"人话工具名"（`toolHuman`）、她的回复全文、注入块长度与全文
  （`injectedMemories`，实测最大 8,812 字节 / 仅 2 行有值 ⇒ 详情里默认折叠，点开才铺）。
- `light=1` 会把 `injectedProfile/emotionPack/emotionPackStructured` 裁到 600 字
  （`store.js:1218-1227`）⇒ 详情里若显示"已截断"必须注明，不许假装是全文。
- **不做翻页**：端点没有"更早"参数（`store.js:1212` 只有 `WHERE timestamp > ?`）。
  屏标题写「最近 200 条（本机上限）」。
- **不做轮询**。`store.js:1202-1204` 记着一次真事故：面板每 10 秒拉 200 行 = 816KB 把宿主卡死。
  本屏只在进入时拉一次，刷新按钮才重拉。
- 进入时 `fetch('/profile')` 并 `EchoAuditView.setProfile(p)`，否则索引里会出现中性词「用户/助手」而不是「<称呼>/Echo」。

**验收**

1. 200 行折出的轮数记为 `N`（实测值写进提交说明，**不许写死进代码或文档**）。
2. 点任意一条索引，右侧换成那一轮的全部行；再点同一行收起。
3. 搜索一个**当前窗口里真实出现过**的工具名（实测 `pwsh` 有 86 行；若换了机器就先用
   `Get-Content` 之类随便搜一个真的），列表只剩含该工具的轮；清空恢复 `N`。
4. 权限/敏感：屏内文本里 `grep` 不到 `session-`、`trace`、`C:\`。
5. 390px：一次只显示一个区域，行高 ≥44px，不横向滚动。
6. `lint --app` / `inspect --app` 0 FAIL；三档截图。

**回滚**：删 `views/audit.js` + 那行 `<script>`，路由项去掉即可；不影响其他屏。

---

### P4 · 记忆

**目标**："她记得多少、记得多牢"：一个主数字 + 一张可筛选可分页的真表。

**数据口径**

- 主指标：`/memories` 的 `total`（实测 active 629）。副行：`隔离 18 · 留档 102 · L0 19 · 平均留存 0.78`（`/health.dmae`）。
- 服务端分页：`page` + `limit=50` → 实测 13 页（629 = 12×50 + 29）。**末页行数必须是
  `total − 12×50` 现算，不许写死 29。** 换页**必须重新请求**，不许把 629 条一次拉下来本地切。
- 筛选：`state`（现役 629 / 隔离 18 / 留档 102）× `layer`（L0 19 …）。chip 计数从 `/health`+`/memories.total` 取，
  **不自己数当前页**。
- 搜索：`q` 走服务端（`summary LIKE`，`store.js:1805-1809`），命中总数随 `total` 更新。
- 表格列（6 列 + 1 操作）：摘要（60 字 + 点开全文）、层、I 值（整数右对齐）、情绪分（右对齐）、
  想起次数（右对齐）、时间态（当前/历史/计划/恒常/未知）。**不显示 `memoryId`、`memoryKey`、`halfLife`**（内部量）。
- 空态：「库里还没有可用的记忆。」；错误态：「暂时无法读取记忆。」

**验收**

1. 第 1 页 50 行、第 13 页 29 行、共 13 页；首末页按钮 disabled 正确。
2. 三个 state chip 的数字与 `/memories?...&state=` 的 `total` 一一相等（629 / 18 / 102）。
3. 搜一个真实关键词（如「考试」），`total` 变小且行里高亮不到的空表不出现。
4. 表格数字全部右对齐、`tabular-nums`；0 打印 `0`（非 `—`）。
5. `lint --app` / `inspect --app` 0 FAIL；三档截图（390 下表格折成两行式列表，字段不丢）。

**回滚**：删 `views/memory.js` + 路由项。

---

### P5 · 图谱

**目标**："她的记忆之间连成什么"：一张"关系榜" + 一张"节点榜"，不画力导向。

**数据口径**

- 主指标：**56 节点 / 84 边**（`/graph`，实测）。旁边一行小字（口径交代，见 1.5a），**差额现算**：
  「另有 `/status` 计到而这里没画的部分：{64−56} 个已让位节点、{97−84} 条边」——括号里的数不许写死，
  因为是「状态面数量 − 绘制集数量」两个端点相减得来的。
- 三块内容：① 关系 Top 10（按 `weight` 降序，显示 `relation`（习惯/喜欢/同日共现…）+ 两端节点名 + 权重）；
  ② 节点连接度 Top 10（按 `weight` = 度数，`store.js:1426`）；③ 类型分布（person / concept / habit / preference / event 计数）。
- 幽灵层只报数不铺开：`layers.shadow` 48 条、`layers.evidence` 118 条，各一行「影子层 48 · 证据层 118（只读，不进检索）」。
- 外链一个「打开动态图谱 ↗」到 `/echo/graph.html`（已存在，只读）。**不在本屏画力导向**。
- 不显示节点 hash id（用 `name`）。

**验收**

1. 屏上节点/边数与 `/graph` 的 `nodes.length/edges.length` 逐字相等；与 `/status` 的 64/97 的差额在屏上有交代。
2. Top 10 权重降序、无并列错序；类型计数之和 = 56。
3. 外链能打开 `graph.html`。
4. `lint --app` / `inspect --app` 0 FAIL；三档截图。

**回滚**：删 `views/graph.js` + 路由项。

---

### P6 · 情绪

**目标**："她此刻什么心情、为什么"：一个强度 + 两组向量条 + 一句理由。

**数据口径**

- 主指标：`/emotion.moodIntensity` = 5/10（副：上一轮 5）。
- 向量条 7 根（`global{fatigue,valence,arousal}` 3 根 + `target_master{affection,playfulness,sadness,dependency}` 4 根），
  0–10，横条只表相对强度；右边写数值，`0` 打 `0`，缺维打 `—`。
- `ipc_dyad` 只显示 `gate` 的中文（`green/yellow/red` → 通行/挂起/不给数）与 `scale`，**不画成第 8 根条**
  （它是门禁不是强度，混进去会读成"她还差一点"）。
- 一句话事实：`moodReason`（如「被摸头安抚，心里软了」）+ `currentTopic`；时间戳用相对时间。
- 侧栏一块小事实（不是 KPI）：`/longing` 的 `value 6.8 / 阈值 5.5 / 已沉默 7 分钟 / 关怀 53 次`。
- 空态：「她还没记下此刻的心情。」；`emotionVector` 缺组时整块显示 `—` 而不是 0。

**验收**

1. 7 根条 + 2 项门禁文字（`gate` / `scale`）；数值与 `/emotion` 逐字对上（实测 fatigue 0、valence 2、arousal 3、affection 6、playfulness 6、sadness 0、dependency 6 —— 值随库变，验收时以端点现值为准）。
2. `moodReason` 全文可读不截断；`currentTopic` 与理由同源同屏。
3. 只有 1 个 ≥24px 数字（5）。
4. `lint --app` / `inspect --app` 0 FAIL；三档截图（390 下 7 根条单列，标签不折行）。

**回滚**：删 `views/emotion.js` + 路由项。

---

### P7 · 系统

**目标**："本机能转得动吗"的第二层。**这是唯一允许没有主数字的屏**：答案是"能"，用分组状态行作答。

**数据口径**（`/status` 29 键里挑，分组如下）

| 组 | 行 | 取值 |
|---|---|---|
| 服务 | Echo / 记忆 / 引擎 / 引擎 PID / 重启 / 断路器 | `status`、`memoryOnline`、`sidecar.running/pid/restarts/breakerOpen`（PID 保留：阶段 1 已同意） |
| 通道 | 消息通道 / 桥队列 | `relay.channels`、`queue{queued,sent,dropped}` |
| 嵌入 | 预热 / 耗时 / 占用 / 读数时间 | `embed{warmed,ms,rssMb,at}`；`at` 超过 10 分钟标「读数停在 HH:MM（已过期）」（口径照 `web/app.js:267-287`） |
| 后台 | 反思 / 工具审计 / 同轮情绪 / IPC 打分 | `reflect{runs,fails,llmPool,lastMs}`、`toolAudit{seen,written,failed}`、`sameTurnEmotion{applied,timedOut}`、`ipcAppraise{ok,skipped}` |
| 检索 | 推送 / 零命中 / 平均行数 / 上限 / 扩展缓存 | `retrieval{pushed,zeroHit,avgRows,kept,cap}`、`queryExpand{cacheHit,cacheSize}` |
| 关怀 | 需不需要留心 / 当前值 / 阈值 / 静默轮次 | `care{shouldCare,value,threshold,quietStreak}` |

- **不上屏**：`dataDir`、`dbPath`（绝对路径）、`scope.exempt` 的 26 个 sessionId 原文、`relay.list` 里的通道 ID。
  需要交代规模就写「26 条豁免」。
- `lastError` 为空**不占一行**；非空才出现，且整行用负面色。
- 第二块：`/health` 的 DMAE 三态（573/41/15）+ 5 个时间态计数。

**验收**

1. 6 组、总行数 ≤ 26；每组首行都不出现绝对路径（`grep C:\` 为 0）。
2. `breakerOpen=false`、`embed.warmed=false`、`care.shouldCare=false` 三处显示与端点一致。
3. 空值行渲染成 `—`，不出现空 `<dd>`。
4. `lint --app` / `inspect --app` 0 FAIL；三档截图。

**回滚**：删 `views/system.js` + 路由项。

---

### P8 · 配置（只读快照）

**目标**："她现在被设成什么样"。**输入框 0 个**，本阶段只读。

**数据口径**

- 主指标：**被改过 N 项 / 共 131**。N = 与 `defaults` 不同的字段数，现算，不写死（产品踩过三次谎报项数的坑，见 `web/app.js:332-357` 的注释）。**不许把「131 项」当主指标**——它是分母，不是这一屏的答案。
- **默认只列改过的项**（N 行），底部一个「显示全部 131 项」开关；默认视图必须一眼看出「她被你改成了什么样」，而不是 131 行参数墙。搜索框在两种视图下都可用。
- 每组一个可折叠段，每项一行：中文标签（`fields[].label`）+ 当前值（右对齐）+ 与 `defaults` 不同则标一个「改过」小字。
- `settings` 里 80 个值对 131 个字段 ⇒ 有字段无值时打 `—`（不是 0）。
- `/profile`（称呼）：显示 userName / agentName / agentSelfRef；**不显示 `uiIndexPrefix` 为空这种内部项**。
- `/scope`：`scope=all`、`whitelist 0`、`exempt 26`、`manualOff 26`、`power on` —— 只报数，不列 sessionId。
- `/setup`：`configured` 与否 + `missing/empty/broken` 条数（数据体检的只读摘要），写操作不做。
- 明确的写禁用提示：屏底一行小字「只读：写入通道本轮关闭」。**不放按钮**（放了就是假控件）。

**验收**

1. 21 组、131 项、**除 1 个搜索框外输入框 0 个**：
   `document.querySelectorAll('input[type=search]').length === 1` 且
   `document.querySelectorAll('input:not([type=search])').length === 0`。
2. 组数/项数与 `/settings` 的 `fields` 逐组相等（脚本比对，不肉眼）。
3. `defaults` 有差异的项被标出，且数量与脚本算出的差值数一致；**默认可见行数 = N**，点「显示全部」后 = 131，再点回 N（三个数都要在报告里写出来）。
4. 搜索框（本地过滤）能按标签筛，清空恢复。
5. `lint --app` / `inspect --app` 0 FAIL；三档截图。

**回滚**：删 `views/config.js` + 路由项。

---

## 4. 风险与不做的事

### 4.1 本轮（及 P1–P8）一律不做的写操作

| 端点 | 为什么不做 |
|---|---|
| `POST /toggle` | 电源/范围总闸，误触代价太大 |
| `POST /context/clear` | 会压缩会话历史，不可逆 |
| `POST /relay/*` | 会真的往 QQ 发消息 |
| `POST/PUT /data/*` | 直改数据文件 |
| `PUT /settings` 写入 | 本轮只读快照 |
| `POST /threads/act`、`/memory/edit`、`/session-label`、`/event` | 全部是写 |

同时不做：`/api/echo/events`（SSE 长连接，**不要探测**）、任何本地定时轮询
（`store.js:1202-1204` 的 816KB/10s 事故）、任何前端构建步骤。

### 4.2 敏感项

- 不上屏：绝对路径（`dataDir`/`dbPath`）、`sessionId` 原文（只报数）、`traceId`/`turnId`/`threadId`/`memoryId`、
  节点 hash id、`relay` 的通道 ID 与令牌（`relayTokenSet` 只显示"已配置"）、`stage_detail` 原文。
- **保留**：引擎 PID（6132）、版本号（0.45.0）、重启次数、断路器、`lastError` 文本。

### 4.3 建议**不做**的屏（并给出理由）

| 候选屏 | 结论 | 理由（证据） |
|---|---|---|
| `#/diary` 日记 | **本轮不做独立屏** | `/diary` 固定返回 **7 条**（`lib/index.js:5100` 写死 `latestDiaries(7)`，虽然 store 允许到 90，`store.js:1780`），没有分页参数。7 条读完就没有第二个问题，做一屏只是把总览现有展开搬个家。**等后端放开 `limit`（那是后端改动）再评估。** 眼下留在总览的现有展开里，代价已知且有界（全开 761px，`final-expanded-1440-viewport.json:220`） |
| `#/inj` 注入透视 | **不做** | 实测 200 行里只有 **2 行**有 `injectedMemories` 内容，撑不起一屏；这些内容在审计详情里已经能看全文 |
| `#/setup` 数据体检 | **不做** | 只有 8 个文件的四态（`/setup` 3KB），并进 `#/config` 的一行摘要足够 |
| 力导向图谱 | **不做** | `/echo/graph.html` 已有全页版本（`web/index.html:168`）；一屏里再画一张会和"每屏一个问题"打架，而且 d3 是 280KB |
| `#/emotion-space` 情绪空间 | **不做** | 端点存在（`lib/index.js:4860-5020`）但本轮不在清单内、没测；产品自己那一页也还在长（`web/app.js:309`） |

### 4.4 主要风险

1. **复用 `audit-view.js` 的隐性耦合**：它只在 `globalThis.EchoAuditView` 上挂东西、无 DOM 依赖
   （`web/audit-view.js:29,636-663`），但 `setProfile` 要显式喂 `/profile`，否则索引里是「用户/助手」。
   忘了喂就是"看起来能用、人称不对"的安静错。
2. **上限三兄弟**：对话 100 / 审计 200 / 待跟进 90 都是**窗口**不是总量。屏上任何"共 N"都要改成
   "最近 N（本机上限）"，否则又是 B3 那种无据措辞。
3. **切屏缓存**：保留了页码与数据，后端重启后回来会看到旧数。刷新按钮必须真的重拉，且每屏都要有。
4. **`views/*.js` 的加载顺序**：必须全部在 `app.js` 之前（产品同款纪律，`web/index.html:244-258`）；
   顺序错了 `EchoViews[id]` 是 `undefined`，屏是空白 —— 验收第 1 条就是抓这个。
5. **决定 A 会被推翻**：这是唯一动了阶段 1 行为的地方。回滚成本小（一处 handler + 文案），
   但要他点头再动。

---

## 5. 给执行子代理的接口约定

### 5.1 路由与渲染

```js
// app.js —— 壳只做四件事：路由、调度、导航状态、公共组件
function renderRoute ()          // 读 location.hash → 找 ROUTES → unmount 旧的 → 显示+挂新的
function mountRoute (route)      // 首次进入才拉数；写 h1/页名/导航高亮
function unmountRoute (route)    // 解绑事件 + abort 在飞请求；不清数据
```

```js
// 每个 views/<id>.js —— classic script，IIFE，只往 globalThis.EchoViews 上挂
globalThis.EchoViews = globalThis.EchoViews || {}
globalThis.EchoViews['audit'] = (function () {
  'use strict'
  const state = { page: 0, filter: 'all', open: '', rows: [], loaded: false }
  async function mount (root, api) { /* 建 DOM、首拉、绑事件；返回 destroy */ }
  return { mount }
})()
```

`api` 只给这些（**不要直接 `fetch`**，方便统一错误态与 abort）：

```js
api = {
  get (path)            // → Promise<json>，内部带 AbortSignal + no-store + Accept
  abort ()              // 取消本屏所有在飞请求
  el (tag, cls?, text?) // 建元素（内部只用 textContent，杜绝 innerHTML）
  missing               // "—"（沿用 app.js:12）
  fmt: { number, relative, absolute, clamp, stripEnvelope, stripMarkdown }  // 复用 app.js 里已有的
  route (id)            // location.hash = '#/' + id
}
```

### 5.2 公共组件（一份实现，九屏共用；overview 也用同一套，**不许各屏各写一套**）

| 组件 | 契约 |
|---|---|
| `pager(state, {size, total, onPage})` | 返回 `{el, sync()}`；按钮 ≥44px、disabled 用属性而非颜色；换页后焦点交给另一个可点按钮（照 `app.js:638-646`） |
| `chipRow(items, {active, onPick})` | `role="group"`、`aria-pressed`、计数在标签内（`全部 90`）；一排，超出横向滚动，不换行堆高 |
| `statusRow(label, value, tone)` | `dt` + `dd`；`tone ∈ {good, alert, none}`；值右对齐、`tabular-nums` |
| `states(container, kind)` | `kind ∈ {loading, empty, error}`；`loading` 用与最终行同高的灰条（不抖动），`empty`/`error` 一行 ≤1 句；错误里给「重试」文本按钮 |
| `head(title, finding, action?)` | 屏首三件套：`h1`（24px，`tabindex="-1"`）、一句话（14px 灰）、可选一个控件 |

### 5.3 硬禁止（每条都要在验收时查）

1. **禁止 `innerHTML` / `insertAdjacentHTML` / `document.write` 注入 API 文本**。
   现有 mock 全程 `createElement` + `textContent`（`app.js:127-148`），新屏照做。API 回来的是她的话、别人的原话，
   里面可能有 `<`、`**`、`#`。
2. **禁止写死数据**。所有数字、标签、计数来自端点；没有数字就打 `—`（`app.js:42-48` 的规矩：
   "一个数字都不许编"）。
3. **禁止新增后端接口、禁止改 `lib/`**。只用第 1.4 节里的 13 个 + 顺带的 4 个只读端点。
4. **禁止改产品三文件** `web/app.js|index.html|style.css`（`tests/web-dashboard.test.js` 97KB 钉着它们的形状），
   也**禁止改** `web/audit-view.js`（只允许 `<script>` 引用它）。
5. 禁止第三方库、构建步骤、`alert/confirm`、`localStorage` 存业务数据。
6. 禁止把 `<section>` 一条条往下加来"扩展"某一屏 —— **新内容 = 新路由**，这是本次任务的全部意义。

### 5.4 每个提交的自检口令

```
1. 这一屏只回答一个问题吗？把问题写进提交说明第一行。
2. 屏上 ≥24px 的数字只有一个吗？
3. 上限口径写对了吗（100 / 200 / 90 / 7 是窗口不是总量）？
4. 空 / 零 / 缺三种情况都看到了吗（手动断网试一次）？
5. lint --app 和 inspect --app 的 FAIL 数都是 0 吗？数字贴进提交说明。
6. 1440 / 768 / 390 三张截图都打开看过了吗？
7. 回滚是不是"删一个文件 + 删一行路由"？
```
