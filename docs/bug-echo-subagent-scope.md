# Bug：子代理会话默认被 Echo 接管（scope=all 下）

2026-10-25 由主会话（`little-tree-gpt-gift/gpt-6.1-sol` 之后的审查会话）定位。仅描述问题与证据，未改任何代码。

## 一、现象

任何会话**派生子代理之后**，子代理会话被当成普通会话对待：

- 它出现在 Echo 的会话列表里，并带 `turns` 计数（即被当作"有对话的会话"统计/落库）；
- 按代码路径推断，它会在 `system-prompt/assemble` 阶段**收到 Echo 的人格与记忆注入**（见下文"未直接观测"）。

用户在 2026-10-25 报的原话：「任何会话开了子代理后都默认开启 echo 插件」。

## 二、复现（三步）

1. 确认全局范围是 `all`：
   `GET http://127.0.0.1:3080/api/echo/scope` → `scope = "all"`（实测 2026-10-25 13:5x：`scope=all whitelist=0 exempt=27 manualOff=27`）。
2. 任意会话里派一个子代理（本会话当天派了 5 个）。
3. 再看同一个端点：`sessions` 里出现这些子代理会话，并带 `turns`：

```json
{"sessionId":"0d0b2bef-6cf1-4334-b750-86202e92bd32","turns":2}
{"sessionId":"081f2c03-551c-489a-a7f3-456cc440ca3d","turns":3}
{"sessionId":"018bc5d7-bdf2-48cd-b4b4-48a0fa50acba","turns":3}
{"sessionId":"8f8e3c32-5b7c-4f04-8d2a-f02e3d2cd993","turns":3}
```

这些 ID 与本会话当天派出的执行/规划子代理一一对应 —— 它们确实被 Echo 计入了。

## 三、根因链（每步带位置）

1. **`scope=all` 是默认放行**：`/api/echo/scope` 实测 `scope=all`，即"未列入黑名单的会话都在范围内"。

2. **"新会话默认关"的登记逻辑刻意跳过子代理**：
   `dsh-echo/lib/index.js:2699-2734`
   ```js
   ctx.on('session/created', (session) => {
     const sid = String(session?.id ?? '')
     if (sid === '' || !isTopLevelSession(session)) return   // ← 子代理在这里被放走
     ...
     if (readSettings().newSessionOn?.dsh !== true) setSessionOn(sid, false)
   })
   ```
   同文件 `:2698` 的注释明说：「**子代理会话不登记**（不该出现在他的开关名单里）」。
   于是子代理既不在 `exempt`、也不在 `manualOff`。

3. **`sessionEnabled()` 因此对子代理返回 true**：`client.js:502-503` 的判据是"不在 exempt 且不在 manualOff"，子代理两条都不占 ⇒ 视为开启。

4. **注入闸只看 `sessionEnabled`，没有看"是不是子代理"**：
   `dsh-echo/lib/index.js:2752`
   ```js
   if (sid === '' || !sessionEnabled(sid)) return target
   ```
   这一行之后就是 `turnSnapshot.compose(session)` 并把人格/记忆 section 推进 `target.sections`。

5. **同一个插件里，别处已经用了子代理判据**，说明这是漏做而不是设计：
   - `dsh-echo/agent-scope.js:99` `isSubagentSession()`（依据 `origin === 'subagent'`、`parentSession` 非空、`delegationDepth`）
   - `dsh-echo/agent-scope.js:108` `isTopLevelSession()`
   - `dsh-echo/compaction.js:99`：`if (!isTopLevelSession(agent) || !sessionEnabled(sid)) return ...`
   - `dsh-echo/lib/index.js:2624`：`if (sid !== '' && !isSubagentSession(agent) && sessionEnabled(sid))`
   - `dsh-echo/context-clear.js:130`：子代理直接拒绝清上下文
   即：登记、压缩、清理都记得排除子代理，**唯独注入闸（2752）与回合采集没排除**。

## 四、影响

1. **子代理被灌人格与记忆**：干活用的子代理会带着"陪伴型 AI"的系统提示与个人记忆工作，既污染判断，也把私人记忆扩散到不该出现的地方。
2. **采集污染**：子代理的工具流水被计入会话列表/turns；若落进记忆或日记，就是往她的记忆里灌"工具噪音"。
3. **与设计意图冲突**：代码注释明确写"子代理不该出现在他的开关名单里""压缩只对顶层"，说明维护者本意就是隔离子代理 —— 现在只是没做全。
4. **难以察觉**：面板上只表现为"多出几个不认识的会话"，不会报错。

## 五、期望行为

无论 `scope` 是 `all` 还是 `whitelist`：

- 子代理会话**不注入**人格/记忆；
- 子代理会话**不采集**为可展示会话（不进 `/api/echo/scope` 的 `sessions`，或不带 `turns`）；
- 子代理的轮次**可以**继续进审计（审计是排障用的），但**不得**喂给记忆/日记/情绪；
- 顶层会话与陪伴会话（`relay.sessionId` / `DEFAULT_COMPANION_ID`）行为**完全不变**。

## 六、修复建议（给执行者，非规定实现）

1. 在 `lib/index.js:2752` 的闸上加子代理判据，例如
   `if (sid === '' || isSubagentSession(session) || !sessionEnabled(sid)) return target`。
   注意 `context.scope.session` 是否带 `origin`/`parentSession`/`delegationDepth`；`agent-scope.js:74` 会读 `SUBAGENT_HEADER_FIELDS`，若该对象不带这些字段，需要改用带 header 的载体（`agent`）或补判据。
2. 同一判据应用到**回合采集 / 记忆写入 / 情绪打分 / 反思**入口（`claim`、`sameTurnEmotion`、`reflect` 已有 `subagentSkipped` 计数器，说明有现成钩子可复用）。
3. 把"`scope=all` = 所有**顶层**会话"写进 `data-schema.js` 里 `scope` 的 note，避免下次再按字面理解。

## 七、验收标准（可证伪）

1. 派一个子代理后，`/api/echo/scope` 的 `sessions` 不再出现该子代理 ID（或出现但 `turns = 0`）。
2. 在该子代理的会话里触发一次 `system-prompt/assemble`，注入探针（`/api/echo/status` 的 `inject.occurrences`）**不增加**；断言注入 section 中不含 Echo 标记行。
3. 顶层会话/陪伴会话回归：`/api/echo/status` 的 `memory.episodicActive`、`relay.enabled`、`inject.occurrences` 与改动前一致；陪伴会话仍能收发。
4. 审计仍记录子代理的工具行（`/api/echo/audit?limit=5` 里 `sub` 来源的行数不为 0），证明"只隔离注入与采集，不切断排障"。

## 八、未直接观测（诚实边界）

- 我**没有**抓取子代理实际收到的 prompt 文本，因此"子代理被注入人格/记忆"是从闸门代码 + 会话被计入这两个事实**推断**的，不是实测。
- `scope.sessions` 里子代理带 `turns` 是实测（见第二节 JSON）；这两个事实足以证明"采集"发生，注入需按第七节第 2 条实测确认。
