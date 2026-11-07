# 审计屏改版方案（P3.5）· 供审查

**这一版要解决的问题**：审计必须「清晰明了、不丢信息、详细但可读」。
矛盾的两个词是**不丢信息**与**可读**。本方案不靠「只展示前 N 行」或「只留摘要」解决，
而是靠**同一份数据的四层阶梯**：每往下一层，信息更全、密度更低、默认收起。

- 只做方案，**不动任何代码**；`web/mock/final/`、产品 `web/`、`lib/` 本轮零改动，不 commit。
- 本文所有数字都是 2026-10-25 13:25 在 `http://127.0.0.1:3080` **现跑现测**的，命令与出处逐条给了。
- 上一版基线（已交付，commit 6281f2c）：`web/mock/final/views/audit.js` 一行一轮 + 25 轮/页。

---

## 一、证据（读了什么、跑了什么、量到什么）

### 1.1 旧审计面板：它想对了什么，错在哪

读了 `web/audit-view.js`（663 行，纯逻辑）、`web/audit-cards.html`（383 行，独立页）、
`web/app.js:779-1010`（产品里的审计流渲染）。

**它做对的（本方案沿用的思想）**

1. **换组织方式，不删数据**。`audit-view.js:1-28` 的头部注释写死了这条纪律：
   40 行里 20 多行是 `structured_output` 原始 JSON，真正的对话被埋住 —— 修法不是删，是分层折叠。
2. **折轮主键是 `stageDetail.turnTrace`，退回时间窗 + 桶**（`audit-view.js:289-331`，`ATTACH_SEC=900`）。
   这个判据已经被产品自己的单测钉住，本方案**只引用、不复制**。
3. **机器的话翻译成人话**：`TOOL_HUMAN`（`audit-view.js:44-60`）、`machineTags`（:227-267）。
4. **没发生的阶段收成一行灰字，不占等宽方块**（`audit-cards.html:51-56,159-174`，2026-10-18 P2 的教训）。
   当时 9 格里常有 5 格是虚线「这轮没发生」，主视觉大半在说「这里什么都没有」。
5. **重文本默认收起**。他 2026-09-29 第三轮的原话被抄在 `app.js:885-888`：
   「确实能读了，但是又显得太过于冗杂了，最好能够起个折叠功能」。
6. **截断必须标注**：`audit-cards.html:110,189-190` 的 `[截断,原长 N]` 会被印出来。
7. **骨架屏 + 真能点的重试**（`audit-cards.html:207-217`）。

**它做错的（本方案弃掉的）**

1. **控件太多**：密度三档（对话优先/全部/排障，`app.js:866`）+ 桶筛（`app.js:870`）+ 来源筛（`app.js:868`）
   + 检索框（`app.js:414`）+ 全部收起/展开（`app.js:419-439`）。五处控件抢同一件事。
   这就是「冗杂」的来源；`plan-ui-phases.md:187` 已经把新屏的控件上限写成一排。
2. **右栏永远铺 8 个重文本小节**：注入全文 / 注入画像 / 情绪包 / 联合空间读数 / 内部状态 /
   情绪向量 / 情绪差分 / 情绪余波（`app.js:1522-1550`）。收起只是缓解，位置仍全在第二层。
3. **深色 navy 主题 + 五套强调色**（`audit-cards.html:5` 的 `--amb/--tea/--ros/--sky/--vio`）。
   `app-screens.md §13` 明写「深色或饱和侧栏 / navy 或 slate 深色主题」属禁项，彩虹色也禁。
4. **`innerHTML` 拼字符串**（`audit-cards.html:180` 等）。mock 的纪律是 `createElement` + `textContent`
   （`plan-ui-phases.md:578`，`web/mock/final/app.js:141-148`）。
5. **`audit-cards.html:219` 拉 200 行时没带 `light=1`**。`plan-ui-phases.md:76` 记录 `limit=200` 是
   532,679 字节；同一天我量到 `light=1` 是 379,968 字节（数据在长，两个数都不是常数）。
6. **九阶段流程图 / 并行支甘特图**（`audit-cards.html:143-152`）：固定 9 格 + 两条并行支。
   本窗口 `stageDetail` 只有 61/200 行非空、跨 39 种键、没有固定 schema —— 图画出来 139 行是空的。

### 1.2 当前 mock 审计屏（要改的这一屏）

- `views/audit.js:14` 端点 `limit=200&light=1`；`:16` 一页 25 轮；`:44` `clip(…,44)`；`:94-107` `summaryOf`。
- 折轮**不在本屏算**，只调 `EchoAuditView.buildTurns`（`:14-15, :315`）——这条纪律继续遵守。
- 一行四列：时间 / 类型 / 一句话 / 次数·耗时（`app.css:761-776`），390 折两行（`app.css:790-805`）。
- 屏首：`figure-label 窗口内轮数` + 40px 数字 + 一句口径（`views/audit.js:229-234`，`app.css:635-646`）。

**实测它的两个病**（截图 `docs/screenshots/p3-audit-1440.png` 上肉眼可见）：

**病一：一行的话全是工具名。** 用本屏现有 `summaryOf` 逻辑跑当前 200 行：
172 轮里 **171 轮的一句话是工具名**（`跑命令` 59、`读文件` 36、`改文件` 21、`emotion_decay` 11…），
只有 1 轮说得出「她说了什么」。整屏读起来就是一张日志。

**病二：主指标是数量本身。** 40px 的 `173` 后面写着「最近 200 行审计」——这正是他这次点名不要的。

### 1.3 端点字段全貌（实测 `/api/echo/audit?limit=200&light=1`，379,968 字节）

顶层只有 `rows`；**一行 21 个键**：

```
traceId | sessionId | userInput | injectedProfile | injectedMemories |
emotionPack | emotionPackStructured | agentState | llmReply | latency |
moodIntensity | prevMoodIntensity | emotionVector | emotionDelta |
toolCall | stage | step | stageDetail | sayAgain | extraReply | timestamp
```

| 字段 | 非空行/200 | 总量字数 | 单行最长 | 备注（实测） |
|---|---|---|---|---|
| `userInput` | 200 | 102,870 | 2,000 | **137 行含盘符绝对路径**；写入侧就截 2000 字（`lib/index.js:3216`） |
| `llmReply` | 156 | 55,666 | 518 | **95 行含盘符路径**（工具返回值，不是她的话） |
| `emotionVector` | 18 | 14,291 | 797 | JSON |
| `injectedMemories` | 5 | 11,119 | 2,396 | `light=1` **不裁**（`lib/store.js:1224`） |
| `traceId` | 200 | 7,385 | 54 | 内部 ID，不上屏 |
| `sessionId` | 200 | 6,768 | 44 | 内部 ID，6 行含 `session-` |
| `stageDetail` | 61 | 5,803 | 195 | JSON；43 行含 `turnTrace`（ID） |
| `stage` | 195 | 1,937 | 22 | 取值 15 种，前几种：`tool:pwsh 63 / tool:read 38 / retrieve 27 / tool:edit 22 / emotion_decay 11 / tool:send_message 10 / tool:read_image 7 / assemble 4`，空 5 |
| `toolCall` | 200 | 1,252 | 17 | 20 种：`pwsh 63 / read 38 / retrieve 27 / edit 22 / emotion_decay 11 / send_message 10 / read_image 7 / inject 4 / write 4 / session-reaper 4 …` |
| `latency` | 181 | 434 | 6 | 单行最大 **121,116 ms** |
| `emotionDelta` | 12 | 166 | 37 | 短句（`lib/store.js:1233-1235`） |
| `emotionPack` | 7 | 4,010 | 600 | `light=1` 裁到 600（`store.js:1225`） |
| `emotionPackStructured` | 6 | 3,600 | 600 | 同上（`store.js:1226`） |
| `injectedProfile` | 5 | 50 | 10 | `light=1` 裁到 600（`store.js:1218`） |
| `sayAgain` | 1 | 1 | 1 | NULL 原样透出（`store.js:1244`） |
| `agentState` | **0** | 0 | 0 | `light=1` 截断后 JSON 解析失败 ⇒ `null`（`store.js:1227`）。**必须写成「轻量窗口下取不到」，不许当成「没有」** |
| `extraReply` | 0 | 0 | 0 | 同上，NULL 透出 |

**这批数据的形状（决定设计，不是装饰）**

- 窗口 = **200 行 / 172 轮 / 13 小时**（10-25 00:22:28 → 13:25:15，同一天）。
- 行桶：`work 139 / other 30 / machine 25 / reflect 6`，**`talk 0`、`her 0`**。
- 轮桶：`work 127 / machine 25 / other 16 / reflect 4`。
- 来源：**`sub 178 / bg 16 / dsh 6`** —— 这一窗几乎全是子代理的账（他说的是「她」，实际大多是「她的手下」）。
- 轮内行数：`min 1 / 中位 1 / max 6`，**172 轮里 159 轮只有 1 行**。
- `turnTrace` 覆盖：**43/200 行、15 个 turnTrace**（21.5%）⇒ 折轮主要仍靠时间窗 + 桶。
- 小时分布（轮数）：`00 时 76 / 01 时 26 / 02 时 20 / 03 时 7 / 04 时 9 / 05 时 27 / 06 时 2 / 08 时 2 / 10 时 1 / 13 时 2`。
- 「需要看」实测：**单行 ≥30 秒的轮 11 个**（最慢 121 s，其次 117/78/56/42/41/37/36/32/32/30），
  **有失败标记的轮 1 个**（`stageDetail.ok === false`，00:33:46 那轮，6 行），两者不重叠 ⇒ **12 轮**。
  阈值参考：≥10 秒的轮 14 个。

### 1.4 「不丢信息」的真实边界

1. **窗口边界**：200 行是端点硬上限（`lib/store.js:1213` `Math.min(200, …)`），
   且**没有更早的游标**（`:1212` 只有 `WHERE timestamp > ?`）。所以屏上永远不能写「共 N」。
2. **不上屏字段**（`plan-ui-phases.md:191,502-503` + P3 验收第 4 条）：`traceId`、`sessionId`、
   `stageDetail.turnTrace`、绝对路径。实测这两类在数据里到处都是：`traceId` 200/200，
   `userInput` 137/200 行带 `C:\`，`llmReply` 95/200 行带 `C:\`。
3. **`light=1` 的截断**：只裁 `injectedProfile / emotionPack / emotionPackStructured`（600 字）
   并让 `agentState` 变成 `null`（`store.js:1218-1227`）。`userInput / llmReply / injectedMemories`
   **原样透出**，所以「字数」是可以当事实用的 —— 但 `userInput` 恰为 2000 字时要标「写入即截断」。
4. **她的话在哪里**（这是当前屏的一个**潜在错标**，本方案必须修）：
   `lib/proactive-ack.js:64-91` 写明 `relay_out / relay_proactive / echo_qq_say` 三种行的
   `llm_reply` **全是空**（58/50/9 行，0 行有值），正文在 `user_input` 里（带 `[标签] `/`(……)` 前缀）；
   `care` 才在 `llm_reply`。而当前 `views/audit.js:84-88` 恰恰拿 `llmReply` 当她的话、
   拿 `userInput` 当他的话 —— 本窗口 `talk` 桶 0 行所以没爆；**QQ 流量一进来就会把她的话标成「他：」**。
5. 「他说的话」在 DSH 会话里另有来处：`retrieve`（27 行）与 `inject`（4 行）的 `userInput` 就是他的指令原文
   （实测 10 种不同文本、多数被截到 2000 字）。当前 `spokenOf` 只看 `relay_in / extract` ⇒ 认不出。

### 1.5 闸的基线（我自己跑的，不是抄的）

```
node scripts/lint.mjs --app web\mock\final      → RESULT: 0 FAIL, 1 WARN（em-dash 20 处）
docs/screenshots/p3-inspect-audit.txt           → RESULT: 0 FAIL, 0 WARN
```
另实测：`web/mock/final/` 下 `*.js/*.html/*.css` **当前一个 emoji 都没有**（正则扫过），
`views/audit.js` 只印 `BUCKETS[x].label`，不印 `BUCKETS[x].icon`（`audit-view.js:33-42` 里的 💬📣🧠 全部不上屏）。

---

## 二、三个方案（差异在信息组织与浏览方式，不在配色）

### 方案甲 · 时间账本 + 三级就地展开（**建议选这个**）

1. 组织：**时间唯一主轴**。屏首答「哪几轮值得回去看」，一排 chips 按桶筛（含「需要看」）。
2. 列表按「日期 › 小时」分组，25 轮/页；组头写这小时的轮数与最慢一轮。
3. 点一轮**就地展开**这一轮的行清单（他说了什么 / 她说了什么 / 经过哪些阶段 / 每行一行）。
4. 再点某一行，**就地**展开这一行的 21 个字段（18 个有值 + 1 个标「轻量窗口下取不到」+ 2 个标「不上屏」）。
5. 代价：想知道某句原话里有没有某个词，只能靠浏览器内查找，且只命中第 1 层可见文字；
   第三层要滚（一行最多 21 行字段表）。

### 方案乙 · 主从两栏（旧面板的骨架）

1. 组织：左 172 行索引（**不分页**，一列到底），右**常驻**详情（说的话 / 阶段链 / 行表 / 字段表）。
2. 点左边一行，右边立刻换成那一轮 —— 滚动位置不丢，来回比对两轮最省事。
3. 浏览：「我要找某一轮为什么」一步到位；「我要看她今天干了什么」没有聚合，172 行一坨。
4. 代价：1440 下右栏多数时候只为 1 行服务（实测 159/172 轮只有 1 行），却常驻吃掉一半宽度；
   390 要第二套导航（推入 + 返回）。改动面是甲的两倍。

### 方案丙 · 分类目录优先

1. 组织：首屏先给「她今天干了什么」的目录：按工具族 × 来源分组（`跑命令 63 行 · 读文件 38 · 检索 27 ·
   改文件 22 · 情绪衰减 11 …`，来源 `子代理 178 / 全局 16 / 主会话 6`），点一类进该类的时间列表。
2. 浏览：「看她今天干了什么」最省力（分布一眼看完）；「找某一轮」要先猜类别，猜错就绕一圈。
3. 代价：把审计从「时间序」改成「分类序」，而本窗口的**时间形状本身就是信息**
   （00 时 76 轮、05 时 27 轮、白天 1–3 轮）；且分类口径是我们设计出来的，与「那一轮」没有天然对应。

### 选甲，理由与被放弃的代价

**选甲**：只有甲在不牺牲时间序（审计的第一直觉）的前提下，用「需要看」+ 就地展开补上「找某一轮」。
本窗口 13 小时、172 轮、159 轮单行 —— 小时分组天然把这些轮切成 10 段，每段 1–76 轮，
「扫」是可行的；而乙的常驻右栏在单行轮占 92% 的数据上浪费一半宽度，丙把时间形状丢了。

**被放弃的代价（写清楚，不掩饰）**：
- 乙的「两轮并排比对」能力没有替代品 —— 甲只能收起一条再开另一条（好在同一时刻只开一条是既有的键盘逻辑）。
- 丙的「分布一眼」能力没有替代品 —— 甲用 chips 的计数（`跑命令` 那类）只能看到轮数量级，看不到行数量的分布。

---

## 三、选定方案：四层阶梯（每层不丢、每层更松）

```
L0 屏首（不折叠，一屏之内）
├ h1「审计」（24px，屏名，不是问候）
├ 一句话（14px 灰：这一屏最重要那条事实 —— 哪几轮值得看 + 窗口口径）
├ 主指标（40px，全屏唯一 ≥24px 的数字）：「需要看 12 轮」
├ 一排 chips：全部 172 · 需要看 12 · 干活 127 · 后台 25 · 其它 16 · 提取 4
└ 标题行右侧：「刷新」（壳已有，不改）
│
L1 轮行（25 轮/页，占页 ≥60%）
├ 组头：10 月 25 日 星期六 ／ 00 时 · 76 轮 · 最慢 2 分 1 秒
└ 一行一轮： 16 分钟前 │ 干活 │ List plugin tree and web assets │ 1 次 · 0.8 秒 │ 慢
│
L2 展开这一轮（就地，缩进到「一句话」那列的左线）
├ 这一轮：00:33:46 – 00:33:52 · 6 行 · 来源 子代理 4 · 主会话 2 · 全局 0
├ 他说了什么（`retrieve`/`inject`/`relay_in`/`extract` 的 userInput；剥注记、路径缩写）
├ 她说了什么（`SPEAKING_TOOL_CALLS` 的 llmReply 或剥注记后的 userInput；`care` 走 llmReply）
├ 这一轮经过：assemble › retrieve › tool:pwsh（只列发生过的，未发生的收成一行灰字）
├ 行清单（每行一个按钮 → L3）：00:33:46 │ 检索 │ retrieve │ 1.9 秒 │ 输入 2000 字 · 明细 6 键
└ 折叠的小节：注入块（n 行 · 合计 n 字）/ 情绪（若这轮有 emotionDelta 或 emotionVector）
│
L3 某一行（就地，再缩进一级；默认收起）
└ 该行 21 个键的字段表：18 个有值（JSON 拆成键值对、长文本可滚、路径缩写、截断标注）
                          + 1 个标「轻量窗口下取不到」= agentState + 2 个标「不上屏（内部 ID）」= traceId / sessionId
```

**为什么是"就地"而不是抽屉**：抽屉要焦点陷阱、要 Esc 归还、390 上要全屏 sheet 与返回路径；
就地展开在 1440/768/390 是同一套 DOM，390 只是缩进收窄，滚动位置天然保持。
代价：展开一轮时页面会变长（最坏 6 行 × 一行 + 21 行字段表）；这个代价用「同一时刻只开一条」压住。

### 3.1 每层字段清单（保证不丢）

| 字段（21 键） | L1 | L2 | L3 | 说明 |
|---|---|---|---|---|
| `timestamp` | ✅ 时间列 | ✅ 起–止 | ✅ 原值 | 秒级时间戳，屏上只印钟点 |
| `toolCall` | ✅（聚合成「次数」） | ✅ 人话名 + 原始名 | ✅ 原名 | 原始名只在 L2/L3 露出 |
| `stage` | — | ✅ 仅当 ≠ `tool:<toolCall>` | ✅ | `stage` 与 `toolCall` 不同的行（`assemble`/`retrieve`）两个都印 |
| `step` | — | — | ✅ | 200/200 有值，L2 不印（噪声） |
| `latency` | ✅ 求和 | ✅ 每行 | ✅ 原毫秒 | 单行最大 121,116 ms |
| `llmReply` | ✅（若这轮没人说话，可按规则当一句话） | ✅ 全文（标「工具的返回」还是「她说的」） | ✅ 全文 | 95/200 行含路径 ⇒ 缩写 |
| `userInput` | ✅（可当一句话，取描述/文件名末两段/命令首段） | ✅ 全文（剥注记、缩写） | ✅ 全文 | 137/200 行含路径；恰 2000 字标「写入即截断」 |
| `injectedMemories` | — | ✅ 行数 + 合计字数 + 全文折叠 | ✅ 全文 | 5/200 行有值，最长 2,396 字 |
| `injectedProfile` | — | ✅ 有/无 + 字数（标 light 截断） | ✅ 全文 | 5 行，light 裁 600 |
| `emotionPack` | — | ✅ 有/无 + 字数 | ✅ 键值对 | 7 行，light 裁 600 |
| `emotionPackStructured` | — | ✅ 有/无 + 字数 | ✅ 键值对 | 6 行，light 裁 600 |
| `emotionVector` | — | ✅ 若有差分就一并提一句 | ✅ 键值对 | 18 行，JSON |
| `emotionDelta` | — | ✅ 短句原文 | ✅ | 12 行 |
| `moodIntensity` / `prevMoodIntensity` | — | ✅ 仅当两者不等（`5 → 3`） | ✅ 两值 | 200/200 有值 |
| `sayAgain` | — | — | ✅（`null` 照印 null） | `store.js:1241-1244` 要求「没有」与「0」分开 |
| `extraReply` | — | — | ✅（`null` 照印） | 本窗口 0 行有值 |
| `agentState` | — | — | ✅ 标「轻量窗口下取不到」 | light 下恒 null（`store.js:1227`），不许写成「没有」 |
| `stageDetail` | — | ✅ 键数 + 阶段链 | ✅ 键值对（**剥掉 `turnTrace`**） | 61 行、39 种键 |
| `traceId` | ❌ | ❌ | ✅ **只列键名，值写「不上屏」** | `plan-ui-phases.md:191` |
| `sessionId` | ❌ | ✅（只报来源计数，不报 ID） | ✅ **只列键名，值写「不上屏」** | 同上 |

**不丢的证明**：21 个键每个都有归属层，最底层 L3 列出全部 21 行（18 有值 + 1 取不到 + 2 屏蔽）——
「看不见一个字段」这件事在 L3 里不可能发生。轮级的派生量（次数、耗时、需要看）只从行里算，不引入新数据。

### 3.2 主指标（回答「一屏的第一眼是什么」）

- 这一屏的**唯一问题**：**「这一窗口里，哪几轮值得我回去看，她当时到底做了什么？」**
  （旧问题「她这一轮到底做了什么」保留为 L1/L2 的内容，但它本身不是一个能一眼回答的问题。）
- **主指标 = 需要看的轮数**（本窗口现算 **11**：11 慢 + **0 失败**）。定义写死、可复现：
  「需要看」= 该轮里 **任一行 `latency ≥ 30,000 ms`**（慢）**或** 该轮里任一行被判为**失败**。
  失败只认 `stageDetail` 里这四个键 —— **字段名以写入侧为准，不由面板猜**：
  - `ok === false`、`timedOut === true`、`error` 非空：并行支行 `same_turn_emotion` / `query_expand`
    一次写全这三个（`lib/index.js:2649-2663`；`timedOut` 在 `:2654`、`ok` 在 `:2655`、`error` 在 `:2656`）；
  - `dropReasons` 非空：`extract` 行的图账，被丢的三元组各带一句理由（`lib/engine.js:424-440`，键在 `:437`）。

  反向也是判据的一部分：`ok === true` 不算失败、`timedOut === false` 不算失败、`dropReasons: []` 不算失败。
  慢与失败各算各的，同一轮同时成立也**只按轮计一次**。这个数是**轮级**，不是行级
  —— 行级（`latency ≥ 30,000` 的行数 / 带失败信号的行数）本窗口是 11 / 0，两个口径都能算、都不混用。
- **失败分支现在是活的，写法有讲究**（2026-10-25 复核更新）：本 payload 已有
  **3 行 `ok === false`**（并行支 `9515d152` / `2b5729ed` 的 `same_turn_emotion` 与 `query_expand`），
  而它们的 `error` / `reason` **全为 null** ⇒ 屏上只能写「失败（没留原因）」，**绝不许印「失败：null」**。
  窗口构成会变（此前某窗该分支 0 行、某窗 3 行），所以**任何绝对数只作当次记录**，
  判据永远是「印『失败』的行数 = `failureOf(row) !== null` 的行数」。
  历史注记（为什么以前查不到）：`58a7cbeb…` 那轮的并行支行时间戳早于同轮 `inject`，被 `LIMIT 200`
  切在窗口外，库里是 `ok=false`；窗口滑动会让这类行进出，别把"某次没看到"当成"永远没有"。
- 可复算的凭据：`flagOf(turn)` 返回 `{ slow, failed, reasons[] }`，每次装载把整窗的逐轮清单攒进
  `state.needsDetail`，由 `EchoViews.audit.needsDetail()` 交出 —— 每轮一条
  `{ index, page, turnKey, at, bucket, slow, failed, sources, signals[] }`，每个 signal 是
  `{ source: 'latency' | 'failure', rowIndex, rowStage, rowTool, signal, value }`。
  它**不上屏**（主指标只要一个数），但 `docs/screenshots/p4b-datacheck.json` 的 `needsLookDetail`
  里逐条在，屏上那个数可以一条一条数回来。
- 数字会随窗口动：本文其余处出现的「12 轮 / 172 轮」是 2026-10-25 早些时候那一窗的读数。
  口径永远以上面这段定义为准，当下的读数以 `docs/screenshots/p4b-datacheck.json` 为准
  （它同时给出 `rows / turns / needs / slowTurns / failedTurns / slowRows / failedRows` 七个口径数）。
- 为什么这个数不算「175 那种数量本身」：它是由整屏状态**汇总出来的结论**，
  与 `plan-ui-phases.md:131` 给系统屏定的「异常 0 处」同一条口径（`:183` 明确允许结论性数字当主指标）。
  它可点：点它 = 等价于点「需要看」chip。
- 一句话（figure-note）写口径，不写装饰：`本机窗口 200 行 · 169 轮 · 慢于 30 秒或失败`
  （0 的时候补一句「（这窗口里没有）」，口径句不因状态而消失）。
- **需要他点头的地方（A）**：如果他不认「需要看」这个视角，退路是把这一格换成
  **「最慢的一轮 2 分 1 秒（00:33）」**——同样是结论，同样能点进那一轮。两版实现差 15 行。

---

## 四、浏览方式：选哪些、为什么、各自解决什么读法

| 手段 | 要不要 | 为什么 |
|---|---|---|
| **按时间分组（日期 › 小时）** | **要** | 本窗口 13 小时、00 时 76 轮把白天挤成一条 —— 时间的形状本身就是信息；组头是唯一不用点就能看到「那一小时她干了多少」的地方 |
| **分页 25 轮/页** | **要（沿用）** | 一次铺开就是一万像素级：`views/audit.js:16` 记的是「175 轮 = 9,645px（1440 实测）」。`app-screens.md §7.8` 允许「完整列表屏」分页并显示区间 |
| **按类型筛（chips）** | **要** | 服务「看她今天干了什么」：只看干活 / 只看后台。计数在同一排，且与列表同源（`chipRow` 现有实现，`app.js:258-297`） |
| **只看异常（需要看）** | **要，且是主指标** | 服务「我要找某一轮为什么这样做」的最短路径：12 轮里挑一条，比 172 轮里找快一个数量级 |
| **搜索框** | **本轮不做** | 与 chips 抢同一排（`plan-ui-phases.md:187`「控件最多一排」）。代价是对策：L1 的一句话改成**可搜的具体文本**（命令参数 / 文件末两段 / 描述），让浏览器内查找能命中；见 §5 |
| **按来源筛（旧面板有）** | **不做成控件** | 来源是**事实**不是**筛选维度**（本窗口 178/200 行是子代理）；放在 L2 的「这一轮 · 来源 子代理 4 · 主会话 2」里一句话说完 |
| **三档密度（旧面板有）** | **不做** | 四层阶梯已经替代它：L1 是「对话优先」的外观（没人说话就印命令），L3 是「排障」的外观，同一份列表，不用切档 |
| **九阶段流程图** | **不做** | 见 §1.1 第 6 条；改成 L2 一行文字链「assemble › retrieve › tool:pwsh」 |

**两种任务的具体路径**

- **「我要找某一轮为什么这样做」**
  `需要看`（12 轮）→ 挑时间最接近他那句抱怨的 → 点开 L2 → 看「他说了什么 / 她说了什么 / 经过哪些阶段」
  → 若还不够，点那一行进 L3 看 `userInput` 全文与 `stageDetail` 键值对。
  不知道时间也不异常时：用 chips 缩到「干活」，再用浏览器内查找命中 L1 那句话里的命令/文件名。
- **「我要看她今天干了什么」**
  首屏不用点：主指标（12 轮需要看）+ 一句话（13 小时 172 轮）+ 小时组头（00 时 76 轮 · 最慢 2 分 1 秒）
  → 翻 7 页看每小时段的组头 → 想只看某一类就按 chips（干活 127 / 后台 25）。

---

## 五、一行怎么排（L1）

四列一张表，与现在同一套栅格（`app.css:761-776`），只换内容与优先级：

```
16 分钟前   │ 干活   │ List plugin tree and web assets        │ 1 次 · 0.8 秒  慢
00:33       │ 干活   │ node lint.mjs --app web\mock\final      │ 3 次 · 14 秒  失败
```

- **列宽**：`时间 auto（右不齐，长度固定）· 类型 52px · 一句话 minmax(0,1fr) · 次数·耗时 auto（右对齐）`.
  数字列 `font-variant-numeric: tabular-nums` 右对齐（既有 `app.css:773,776`）。
- **优先级**（一句话从高到低，取第一个命中的）：
  ① 她的话（`SPEAKING_TOOL_CALLS` 的 llmReply，或剥注记后的 userInput）
  ② 他的话（`relay_in` / `extract` / DSH 下的 `retrieve` / `inject` 的 userInput，压成一行、44 字）
  ③ **工具的具体动作**：`pwsh` 的 `description`（实测 43/63 行有）、`read/edit/write/read_image/grep` 的
     `file_path` 末两段、`send_message` 的 `message` 首句、`skill` 的 `name`、其余取首个参数
  ④ 工具名链（现状，`检索、跑命令` 这种）—— 实测 122/172 轮能取到 ②或③ 的具体文本，落到 ④ 的只剩 ≤50 轮
- **类型标记不使用 emoji、不使用彩色标签**：只印 `BUCKETS[x].label` 的中文词（对话 / 她主动 / 提取 / 干活 / 后台 / 系统 / 桥 / 其他），
  颜色只用 `--muted`/`--faint` 两级灰（现状即如此）。
- **异常标记只用文字**：`慢` / `失败`，12px，与「次数·耗时」同列右侧，等宽灰；**慢不给红色**——
  `app-screens.md §11` 写的是「红色是信号不是纹理：一个对象最多一个红标记，落在逾期或失败那一格上；
  一屏十三条红字读起来只是噪声」。本窗口一屏可能有 11 条慢轮 ⇒ 慢用灰字；红色只留给「失败」
  （本窗口正好 1 条）。
- **对齐规则**：一句话 `text-overflow: ellipsis` 单行截断（既有）；截断不吞信息 —— 全文在 L2。

---

## 六、详情怎么放、键盘怎么走、390 怎么放

**放法**：就地展开（无抽屉、无第三级路由）。

**键盘与焦点**
1. L1 行整行是 `<button aria-expanded aria-controls="au-l2-N">`（现状 `views/audit.js:202-206` 已如此）。
   Enter/空格由浏览器给；**同一时刻只开一条 L1**（`state.open`，已实现）。
2. L2 的每个工具行也是 `<button aria-expanded aria-controls="au-l3-N-M">`；
   **同一时刻只开一条 L3**（新增 `state.openRow`）。
3. 打开 L2/L3 **不移动焦点**（焦点留在触发它的按钮上），读屏靠 `aria-expanded` + `aria-controls` 得知展开。
4. 新增 **`Esc` 收回最内层一次**：L3 开着先收 L3，否则收 L2；焦点始终不动。
   仅在这一屏的 `listHost` 上监听 `keydown`，`unmount` 时解绑（`views/audit.js:353-355`）。
5. Tab 顺序 = DOM 顺序，**不设正 tabindex**；L3 容器 `role="group"` + `aria-label="这一行的全部字段"`。
6. 翻页时两层都收起（现状 `turnPage` 已经这样做，理由写在 `views/audit.js:267-273`，继续沿用）。

**390×844 的降级顺序**（先丢什么，后丢什么）
1. 先丢「类型」词（`app.css:740` 已经 `display:none`）——类型仍在 chips 与 L2 里。
2. 一句话截到一行（仍可点开看全文）。
3. 时间改用相对（`16 分钟前`）、次数·耗时合到第一行右端（现状 `app.css:790-805` 的两行制）。
4. 保留 `慢`/`失败` 标记到最后 —— 它是这一屏的结论。
5. L2：行清单改「时钟 + 人话名」一行、「原始名 + 耗时 + 字数」下一行（12px 灰）。
6. L3：字段表改单列（键在上 12px 灰、值在下），一行最多 21 组，靠滚，不靠横滚。
7. 全程禁止横向滚动（`scrollWidth == innerWidth`，`plan-ui-phases.md:202`）。

---

## 七、与旧面板的关系：沿用哪几条、弃掉哪几条

**沿用（6 条）**

| # | 沿用 | 出处 |
|---|---|---|
| 1 | 折轮主键 `turnTrace` 优先、时间窗 + 桶兜底；**只调 `buildTurns`，不复制** | `web/audit-view.js:289-331,359-447` |
| 2 | 「换组织方式，不删数据」的分层思路 | `audit-view.js:1-28`，`app.js:779-788` |
| 3 | 工具名→人话（`TOOL_HUMAN`），认不出就原样给 | `audit-view.js:44-60,166-171` |
| 4 | 「没发生的阶段收成一行灰字」，不占等宽方块 | `audit-cards.html:51-56,159-174` |
| 5 | 截断必须标注（`light=1` 的 600 字、写入侧 2000 字） | `audit-cards.html:110,189-190`，`store.js:1218-1227`，`index.js:3216` |
| 6 | 骨架屏 + 真能点的重试；重文本默认收起 | `audit-cards.html:207-217`，`app.js:885-888` |

**弃掉（6 条）**

| # | 弃掉 | 理由 |
|---|---|---|
| 1 | 密度三档 / 来源筛 / 桶筛 / 检索 / 全部收起五处控件 | `plan-ui-phases.md:187` 一排上限；四层阶梯取代密度档 |
| 2 | 右栏常驻 8 个重文本小节 | `app.js:1522-1550`；本窗口 92% 的轮只有 1 行，右栏为空 |
| 3 | 深色 navy + 五色强调 | `audit-cards.html:5`；`app-screens.md §13` 禁项 |
| 4 | `innerHTML` 拼串 | `plan-ui-phases.md:578`；`app.js:141-148` 的纪律 |
| 5 | 九阶段流程图 / 并行支甘特图 | 本窗口 `stageDetail` 61/200 行、39 种键，图画出来 139 行是空的 |
| 6 | 「她的回复」取 `llmReply`、「他的话」取 `userInput`（不分工具） | `proactive-ack.js:64-91`：出站三行的 llm_reply 恒空、正文在 user_input ⇒ 会把**她的话标成「他」** |

---

## 八、分步实施计划

**通用纪律**（每步都适用）：一步 = 一个 commit；每步跑完 `lint --app` 与 `inspect --app`，
数字贴进提交说明；任一步红就停，不带着红进下一步。
**允许改的文件只有三处**：`web/mock/final/views/audit.js`、`web/mock/final/app.css`（只追加），
必要时 `web/mock/final/app.js`（只加公共组件，不改既有签名）。**不改** `web/audit-view.js`、产品三文件、`lib/`。

### 第 1 步（先做这一步，做完停下报告）（已完成，commit fbc17e7）

**目标**：把「主指标」和「一行的一句话」换掉 —— 这两处是 90% 的可读性问题，且不碰结构。

**改哪里**
- `views/audit.js` 新增三个纯函数（都在 IIFE 内，不导出）：
  - `speechOf(row)`：照 `lib/proactive-ack.js:64-91` 的规则 ——
    白名单 `SPEAKING_TOOL_CALLS = [relay_out, relay_proactive, echo_qq_say, echo_wake, care]`；
    取文本 `llmReply` 非空则用它，否则 `userInput` 剥掉 `^\[[^\]]*\]\s*` 与 `^[（(][^）)]*[）)]\s*`；
    剥完为空 → 不算说话。**不许**再拿任意行的 `llmReply` 当她的话。
  - `gistOf(turn)`：§5 的四级优先级；`pwsh` 读 `userInput` 里的 `"description"`，
    `read/edit/write/read_image/grep` 读 `"file_path"`/`"path"` 取末两段，其余取首个参数。
  - `flagOf(turn)`：`{ slow, failed, reasons }`，按 §3.2 的定义现算；`reasons` 是逐条依据
    （`{ source, rowIndex, rowStage, rowTool, signal, value }`），整窗清单经 `needsDetail()` 交出。
- `figure`：`figure-label` 改「需要看」，值 = 需要看的轮数，note = 口径句。
- `summaryOf` 换成 `gistOf`；`metersOf` 不动。
- `app.css` 追加 `.au-flag`（12px，`--faint`，`white-space:nowrap`）与 `.au-flag.is-bad`（`--negative`）。

**怎么验（可证伪）**
1. 需要看 = 屏上数值 = 独立脚本从同一份 payload 现算的轮数（脚本不读页面）；本窗口实测 **11 = 11**
   （11 慢 + 0 失败），逐条依据在 `docs/screenshots/p4b-datacheck.json` 的 `needsLookDetail`。
2. `turnsWithConcreteGist ≥ 100`（本窗口实测 122/172 能取到具体一句话；改动前是 1/172）。
3. 页面可见文本里 `C:\`、**会话 ID** `session-[0-9a-f]{8}`、UUID、原始 JSON 命中数 = **0**，
   而且**静息态与展开一行后各扫一遍**（展开态才是隐藏文本露出来的地方）；
   `session-reaper` 是**工具名不是 ID**，允许出现在展开区的工具原始名里，只计数并在报告里明说。
4. `lint --app` 0 FAIL（WARN ≤ 基线 1 + 新增记录）；`inspect --app` 0 FAIL / 0 WARN。
5. 三档截图（1440/768/390）打开看过；390 不横滚。

**回滚**：`git checkout -- web/mock/final/views/audit.js web/mock/final/app.css`（本步只碰这两个文件）。

### 第 2 步（已完成，commit 160e03c；修正 31e5545、407e5c0）

**目标**：结构与浏览 —— 小时分组 + chips + L2 行清单（不含 L3）。

**改哪里**
- `views/audit.js`：
  - `build()` 里加 `api.chipRow([...], { onPick })`（`app.js:258-297` 已有实现，不动它）；
  - `draw()` 里在页内切片上按 `dayKey/hour` 插组头（组头只写「N 时 · n 轮 · 最慢 x」）；
  - `detailOf()` 换成「这一轮」块：时间跨度 / 行数 / 来源计数（只报数）/ 他说了什么 / 她说了什么 /
    阶段链 / 行清单（每行 = 一个 `button`，`dataset.row` 指到该行）。
- `app.css` 追加 `.au-hour`（组头，12px 灰，粘性不粘性待看截图）、`.au-rows`、`.au-rowitem`。

**怎么验**
1. chips 计数之和 = 轮数（172）；点「需要看」剩 12，点「干活」剩 127，点「全部」回 172。
2. 组头的轮数之和 = 当前页行数；跨页不重复计。
3. 展开一轮后 `scrollHeight` 增量 = 该轮行清单高度（±4px），不出现空白带。
4. 键盘：Tab 到某行 → Enter 展开 → Tab 进 L2 的第一个行按钮 → Enter 无反应（L3 还没做，占位为空态句）。
5. 闸与截图同第 1 步。

**回滚**：同上（两个文件）。

### 第 3 步（只列标题）（已完成，commit 13bd63c）
L3：某一行 21 键字段表（JSON 拆键值对、`stageDetail` 剥 `turnTrace`、`traceId/sessionId` 只列键名、
路径缩写、`light` 截断与 2000 字写入截断标注、`agentState` 写「轻量窗口下取不到」）。

### 第 4 步（只列标题）（已完成，commit 189c1ee）
键盘与 ARIA 收口：`Esc` 收最内层、`aria-controls` 全链、`unmount` 解绑、390 单列字段表。

### 第 5 步（只列标题）（已完成，commit 05de6d5）
三态与边界：空窗口 / 0 需要看 / 折不出轮 / 端点报错；`light` 截断与 `agentState=null` 的文案。

### 第 6 步（只列标题）（已完成，commit 64707fb）
数据核对脚本 + 三档截图 + 闸的数字写进 `docs/screenshots/p35-*`，再交他看。

---

## 九、验收标准

**闸（必须真跑，数字贴进报告）**
```
node %USERPROFILE%\.dsh\skills\design-taste-frontend\scripts\lint.mjs    --app web\mock\final
node %USERPROFILE%\.dsh\skills\design-taste-frontend\scripts\inspect.mjs --app http://127.0.0.1:3080/echo/mock/final/index.html#/audit --out docs\screenshots\p35
node %USERPROFILE%\.dsh\skills\design-taste-frontend\scripts\inspect.mjs --app --allow emoji http://127.0.0.1:3080/echo/mock/final/index.html#/audit
```
- `lint --app`：**0 FAIL**。WARN 只允许 `plan-ui-phases.md §2.5` 记过的两条（`em-dash` 20 处基线、`hero-void`），
  新增 WARN 必须在报告里逐条辩。
- `inspect --app`：**0 FAIL / 0 WARN**（基线是 0/0，见 `docs/screenshots/p3-inspect-audit.txt`）。
- `--allow emoji`：本屏不用 emoji（实测 `web/mock/final` 当前 0 个），这条放行对本屏是空放行；
  带它的唯一理由是照他给的口令跑一遍，若出现 emoji 就是**回归**（`app-screens.md §13` 禁 emoji 标签）。
- 三档截图 1440×900 / 768×1024 / 390×844，等 `documentElement.dataset.dataReady === "true"` 再拍，
  人肉打开看过（沿用 `docs/screenshots/p3-*.png` 的口径）。

**可证伪的数据核对（每条都能当场算，算不出来就算没做）**

| # | 断言 | 本窗口期望 |
|---|---|---|
| 1 | 主指标 = 独立脚本现算的「需要看」轮数，且 = `needsLookDetail` 条数 | 11（11 慢 + 0 失败） |
| 2 | 第三层字段行数 = 该行对象键数 | 21（18 有值 + 1 标「轻量窗口下取不到」+ 2 标「不上屏」） |
| 3 | 第三层被屏蔽的键**只有** `traceId`/`sessionId`；`stageDetail` 的键值对里**没有** `turnTrace` | 恒真 |
| 4 | chips 计数之和 = 当前窗口轮数 | 172 |
| 5 | 页内可见文本命中 `C:\` / 会话 ID `session-[0-9a-f]{8}` / UUID / 原始 JSON（静息 + 展开各一遍） | 0 / 0 / 0 / 0 |
| 6 | 一句话落在「纯工具名链」的轮，**必须全部属于「本来就没有具体内容」的轮**；凡有可提取内容的轮一律不得落进工具名链（判定：`concreteGist = 可提取轮数`，且 `toolOnly ⊆ 无内容轮`，逐轮可复算） | 关系恒真；**条数随窗口构成变**（某窗实测 74/141：动作 66 + 她 1，其余为情绪衰减/会话清理/跑命令这类机器行）。改造前的 171 是「有话说也印成工具名」，两者不是同一件事，**不要拿这两个绝对数比** |
| 7 | 每页行数 ≤ 25，翻页器区间与总轮数同源 | 25 / 7 页 |
| 8 | 「需要看」= `{单行 latency≥30000}` ∪ `{ok===false\|timedOut===true\|error 非空\|dropReasons 非空}` | 集合运算结果 = 11（失败子集本窗口为空） |
| 9 | 空态：破网络后刷新，三态句各出现一次，`figure` 打 `—` 不编 0 | — |

**表里的绝对数（11 / 172 / 25 / 7 页…）都是当时的读数**：审计窗口每次刷新都会变（同一台机器上 141 与 172 轮都出现过）。判据以**定义与关系**为准（集合运算、等号、子集包含），数值只作当次记录 —— 报告里必须同时写出当次的轮数、需要看数、以及 `gistLayers` 分布，让读的人能自己复算。**任何拿过期绝对数当通过条件的，一律按未验证处理。**

---

## 十、不做清单

1. **不做任何写操作**（`POST /toggle`、`/relay/*`、`/data/*`、`/threads/act`…），沿用 `plan-ui-phases.md:486-498`。
2. **不做力导向图、不做轨道 / 甘特 / 泳道这类图可视化**（理由见 §1.1：单轮 `latency` 之和 ÷ 时间跨度 = 0.01，比例轴只会画出噪声）。
   **允许**「编号步骤清单」：一行一步，带序号 / 时钟 / 耗时 / 状态——它是文本账本，不是图表（见 `plan-audit-flow.md`）。
3. **不编数据**：没有的字段打 `—`；`agentState` 在 light 下写「取不到」而不是「没有」；
   `sayAgain` 的 `null` 照印 `null`（`store.js:1241`）。
4. **不为过闸改设计**：不压行距、不缩触控区、塞装饰块去把 `hero-void`/`em-dash` 刷绿（`plan-ui-phases.md:207`）。
5. **不加搜索框**（本轮），不加密度档，不加来源筛控件。
6. **不做轮询**（`store.js:1202-1204` 的 816KB/10s 事故），只在进入时拉一次 + 刷新按钮重拉。
7. **不改** `web/audit-view.js`、产品 `web/app.js|index.html|style.css`、`lib/`；**不改** `index.html` 的
   `<script>` 顺序（`index.html:10` 是 `/echo/audit-view.js`，`:17` 是 `./views/audit.js`，两行都已在，顺序也对）。
8. **不用 emoji、不用彩色标签、不用深色底、不改路由**。

---

## 十一、需要他点头的两处（其余我按上面写死）

1. **主指标**：`需要看 12 轮`（结论性数字，可点）——还是换成 `最慢的一轮 2 分 1 秒`？
   前者服务「哪几轮值得看」，后者服务「哪里最费时间」。两版差 15 行。
2. **一排控件选 chips（不做搜索框）**：`plan-ui-phases.md:187` 只许一排。
   如果他要搜索，就得把 chips 挪走 —— 那是**违反他自己定的规则**，需要他签字。

**风险（已知、有界）**
- 「需要看」的 30 秒阈值是设计出来的，数据一换就可能变成 30 或 3；阈值写成一个常量，并在 note 里印出来。
- `turnTrace` 覆盖 21.5%，折轮主要靠时间窗 —— 因此 159/172 轮是单行轮，L2 常常只有一行；
  这不是缺陷，是数据形状，屏上不为了"好看"去合并轮。
- 来源 178/200 行是子代理：屏上要说「这一轮的行来自谁」，否则他会以为那是她本人做的。

## 十二、P6 回流（2026-10-25）

用户在用过一版之后的新判断：**「审计不够清晰，每一步骤的具体流程顺序等可读有意义的细节都没展示出来。」**

于是 L2 又改了一轮，依据 `docs/plan-audit-flow.md`：

- **九格阶段图仍然不做**（`§十` 第 2 条继续成立：单轮 `latency` 之和 ÷ 时间跨度 = 0.01，比例轴只会画出噪声）。
- **「阶段链 + 行清单」合并成「这一轮经过」的步骤账本**：一行一步，带序号 / 时钟 / 阶段名 / 一句话 / 耗时 / 标记。
- L0 / L1 / L3 的结构**没有变**：L0 仍是「需要看 N」+ chips，L1 仍是一轮一行，L3 仍是 21 键字段表。
- 新增的判据在 `p6a-check.mjs`（全窗逐轮，47 项），并已挂进总入口 `p35-check.mjs`（合计 146 项）。

**这条改动的边界（写死，别再回头争）**：顺序永远取时间序（`turn.rows` 下标），不按 `step` 重排因果；
并行支按时间插在原位、不画轨道；「又跑了一次」只证明时间上重复，不证明"因失败重试"。
