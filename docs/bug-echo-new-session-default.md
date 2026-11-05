# Bug：新会话没有默认关（子代理会话尤其）

2026-10-25 复核。上一轮修的是「注入」和「面板过滤」，**没修「默认关」这件事本身**。下面是实测。

## 一、现象（用现在的数据说）

`GET /api/echo/scope` → `scope = "all"`，`sessions` 共 **27** 个：

| 类别 | 数量 | 说明 |
|---|---|---|
| 裸 UUID（无 `session-` 前缀） | **25** | 这些都是子代理会话（`dsh-subagent` 给子会话的命名方式） |
| 具名：`global` | 1 | 面板范围的伪会话，turns 105 |
| 具名：`session-b9f1692e-…` | 1 | 陪伴/桥落点（`relay.sessionId`），turns 335 |

而 `~/.dsh/echo/config.json` 的 `subagentSessions` 只有 **3** 条 ⇒ 上一轮加的「展示前滤掉」只挡掉 3 个，**另外 22 个子代理会话照旧出现在面板列表里**，看起来就是"子代理默认开启了 Echo"。

## 二、已经修好的部分（别重复查）

- **注入确实被挡住了**：`/api/echo/status` 的 `inject.occurrences = 0`；用刚跑过的子代理 `efac6b41-…` 做探针，它在审计里有 31 行，**`retrieve` 行为 0**（`retrieve` 只在 `turnSnapshot.compose()` 里跑，而 `compose` 在注入闸后面）⇒ 注入路径没被执行。
- 新增的子代理确实没进 `/scope`（`efac6b41-…` 被记进 `subagentSessions` 后过滤掉了）。

## 三、根因（三条，逐条带位置）

1. **`sessionEnabled()` 不知道"子代理"这回事**
   `client.js:502-503` 的判据是「不在 `exempt` 且不在 `manualOff`」。子代理既不在 `exempt` 也不在 `manualOff`（见第 2 条），所以 `sessionEnabled(sid) === true`。
   上一轮只在**注入闸**（`lib/index.js:2775`）和 **`/scope` 展示**（`:4647`）两处加了子代理判据，**没有把 `subagentSessions` 接进 `sessionEnabled`**。

2. **子代理会话从一开始就不进"默认关"名单**
   `lib/index.js:2702`：`if (sid === '' || !isTopLevelSession(session)) return` —— 子代理直接放走，注释（`:2698`）写的是「子代理会话不登记（不该出现在他的开关名单里）」。
   意图是对的（别污染用户的开关表），但它同时意味着**子代理永远不是"关"的**。

3. **历史会话没有回填**
   `subagentSessions` 只在 `session/created` 当时记录；重启前就存在的子代理会话没有记录（配置里只有 3 条），而 `/scope` 的过滤是「按名单滤」，不是「按 id 形态滤」⇒ 22 个老会话漏出来。

## 四、用户要的语义（这次写死）

> **新会话（无论顶层还是子代理）默认就是关的**；只有他明确说「Echo 上线」，或者那是陪伴/桥的落点会话，才在范围里。

推论：
- 顶层新会话：`settings.newSessionOn = {dsh:false, qq:true, other:false}` ⇒ 已经默认关（登记进 `manualOff`+`exempt`），这条不用改。
- **子代理会话：必须默认关**，而不是"开着但注入被挡"。
- `global`（面板伪会话）与 `relay.sessionId`（陪伴落点）必须保持可用。

## 五、修法（最小改动，不动审计）

1. **把"子代理"接进 `sessionEnabled`**
   `sessionEnabled(sid)` 增加一条：`sid` 在 `subagentSessions` 里 ⇒ `false`。
   同时用 **id 形态**兜底：裸 UUID（`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`，且不以 `session-` 开头）⇒ 视为子代理。理由：这是 `dsh-subagent` 给子会话的命名方式，实测 25/25 命中，比"等它被登记"可靠。

2. **回填历史**
   启动时把 `/scope` 里能看到的裸 UUID 会话补进 `subagentSessions`（幂等、上限沿用现有 200），让那 22 个老会话立刻从列表消失，且今后不再需要靠"当时登记"。

3. **`/scope` 过滤改成 id 形态 + 名单双判**
   不再只按名单滤；裸 UUID 一律不列。`global` 与 `session-*` 不动。

4. **不动** `/api/echo/audit`（排障要留子代理的工具流水）、不动 `sessionEnabled` 对顶层/陪伴会话的语义、不动 `exempt`/`manualOff`。

## 六、验收（重启后逐条跑）

1. `GET /api/echo/scope` → `sessions` 里**没有任何裸 UUID**；只剩 `global` 与 `session-b9f1692e-…` 这类具名会话；总数 ≤ 5。
2. 派一个新子代理，跑 3 轮以上：
   - `/api/echo/scope` 不出现它的 id；
   - `/api/echo/status` 的 `inject.occurrences` 与派之前**相等**；
   - 该子代理会话的审计行里 **`retrieve` 计数为 0**（这是"注入没跑"的可证伪证据，比计数器更硬）。
3. 陪伴会话回归：QQ 私聊仍能收发；`relay.enabled = true`；`memory.episodicActive` 正常增长。
4. 排障没被切断：`/api/echo/audit?limit=20` 里仍能看到子代理的工具行（来源 `sub`）。
5. `subagentSessions` 条数 ≥ 回填前的 3 条，且**不包含** `global` 与 `relay.sessionId`。

## 七、未验证 / 边界

- 我没有直接抓到子代理的 prompt 文本；"注入没跑"是从 `retrieve` 行数为 0 与 `inject.occurrences` 不涨两条**同时**推出来的。
- 重启前的旧会话如果不回填，它们会继续出现在列表里 —— 这正是第五节第 2 条要解决的事。
- 改完需要**重启 `dsh web`** 才生效（插件在启动期读配置与事件）。
