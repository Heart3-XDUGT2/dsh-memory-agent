# AstrBot 插件「Echo」职责清单（代码考古报告）

> 范围：`data/plugins/` 下 3 个插件。只读，未修改任何文件，未 commit。
> 行号均为实际读到的行。读不到的地方明确写「读不到」。
> 参考副本：`Desktop\参考资料\` 里**没有**这三个插件的源码副本（只有 AstrBot 源码 `AstrBot_src`/`AstrBot-master` 与若干无关项目）。

## 0. 结论先行

1. **Echo 的「灵魂」和「身体」已经分得很干净了**：`brains/`+`core/`+`audit/` 与 5 个 Mixin 里，AstrBot 依赖只有 6 个文件共 14 行 import，其中 12 行集中在 `main.py`（平台钩子）；器官层只用到 `logger`（+1 处类型注解、+1 处 provider 兜底）。`dsh_port/04` §8.5 悬而未决的「Star/event 剥离面」本次已定界（见 §D）。
2. **入站只有一个口**：`@filter.event_message_type(ALL)` 的 `gateway()`（`main.py:519`）。出站有两个口：网关内 `yield event.plain_result()`（`main.py:661/669`）与主动发言 `context.send_message()`（`main.py:1469/1602`）。
3. **有两条不等价的写入链**（这是本次最重要的发现之一）：网关模式走 `_gateway_brain2`（有 Memory Judge、图三元组、悬置话题登记、命令式提醒），legacy 模式走 `_extract_pipeline`（**没有** Judge / 三元组 / 悬置话题登记，只有 `emotion_score >= min_emotion_score` 的老闸门）。`main.py:677` vs `brains/echo_memory_engine.py:368`。
4. **给模型的工具数 = 0**：全插件无 `llm_tool`/`register_llm_tool`/`tools=`/`tool_calls`。它跟模型的耦合是「自己 httpx 直连 OpenAI 兼容接口 + 拼字符串」，不是工具协议。对外只有 7 个聊天命令。
5. **平台耦合几乎为零**：无 aiocqhttp/OneBot/CQ 码；发消息全走 AstrBot 抽象层，宿主侧 `context.send_message` 按 `platform_name` 路由到 `platform.send_by_session`（`AstrBot_src/astrbot/core/star/context.py:641-643`）。唯一真接口是 **session_id = `event.unified_msg_origin` 字符串**。
6. **后台循环共 3 个 + 3 类一次性任务**（见 §A2）。DSH 侧只要有「一个时钟 + 一处 JSON-RPC」就够平移。
7. **有对外 HTTP/WS**：审计仪表盘 `0.0.0.0:8420`(HTTP) + `0.0.0.0:8421`(WebSocket)，随插件启动（`main.py:240-248`）。这是唯一对外端口，也是纯 DSH 侧面板的替代对象。
8. **DSH 侧已存在共享库目标**：`$env:USERPROFILE\.dsh\echo\echo.db`（308KB + 4MB WAL）实际存在；插件已支持 `db_path` 指向它（`main.py:221-225`，`_conf_schema.json:304-308`）。

---

## A. 入口与生命周期

### A1. 基类、钩子、入站/出站

| 项 | 位置 |
|---|---|
| 插件基类 | `class MemoryMiddlewarePlugin(Star, SchemaMixin, MemoryEngineMixin, LLMClientMixin, AuditMixin, LongingMixin)` `main.py:174` |
| 自动注册 | 文件末尾 `main.py:2587`（Star 子类被发现即注册，无 `register()` 调用） |
| **入站总入口** | `@filter.event_message_type(EventMessageType.ALL)` → `gateway()` `main.py:519-520` |
| 大脑1（legacy 注入） | `@filter.on_llm_request()` → `inject_memory()` `main.py:1088-1089`（`gateway_enabled=True` 时第 1097-1098 行直接 return 让路） |
| 大脑2（legacy 固化） | `@filter.on_llm_response()` → `extract_memory()` `main.py:1325-1326`（同样让路，`main.py:1331-1332`） |
| 生命周期 | `initialize()` `main.py:215`；`terminate()` `main.py:251` |
| 命令 ×7 | `audit` 2213 / `mem` 2312 / `threads` 2367 / `mem_forget` 2434 / `mem_clear` 2457 / `master` 2479 / `graph` 2542 |
| **出站（网关主链路）** | `yield event.plain_result(reply)` `main.py:669`；切泡时逐泡 `yield event.plain_result(_b)` `main.py:661`；随后 `event.stop_event()` `main.py:671` 掐掉原生 LLM |
| **出站（主动发言，无事件）** | `await self.context.send_message(session, chain)` `main.py:1469`；`await self.context.send_message(session_id, MessageChain([Plain(text)]))` `main.py:1602` |
| 出站兜底 | `await event.send(chain)` `main.py:1475` |

`initialize()` 做的事（`main.py:215-249`）：确定库路径（221-222）→ 连接 + `WAL` + `busy_timeout=5000`（223-225）→ 建表/建图/两次迁移（226-230）→ 主人 ID 文件（231）→ 起 2 个后台循环（238-239）→ 启动仪表盘（240-248）。

### A2. 后台循环 / 定时任务

| 名字 | 周期 | 干什么 | 位置 |
|---|---|---|---|
| `_emotion_decay_loop` | `emotion_decay_interval_minutes`（默认 30min） | 每轮先 `_longing_tick()`（想念补差 + 抗议尖峰），再 `_emotion_decay_pass()`（多维情绪按小时衰减写回） | `audit/echo_audit.py:264-288`；tick `brains/echo_longing.py:266`；pass `audit/echo_audit.py:290-325` |
| `_reminder_loop` | `reminder_check_interval_seconds`（默认 60s） | 一个 60s 时钟串三件事：`_reminder_pass`（悬置话题闹钟）→ `_care_pass`（想念关怀心跳）→ `_reflection_pass`（反思整固） | `main.py:1484-1517`；三 pass 分别在 `main.py:1519` / `1613` / `1903` |
| `_gateway_brain2`（一次性） | 每轮 | 抽取/判定/落库/画像/审计/漂移/治理 | `asyncio.create_task` `main.py:627-632`，主体 `main.py:677-1083` |
| `_say_again_after`（一次性） | 2~5s 随机 | 情绪余波追加一句；用户抢话即取消 | 投递 `main.py:1395-1418`，主体 `main.py:1428-1455` |
| `_persona_drift_check`（一次性） | 每 `drift_check_every`（默认 8）轮 | 人格体检 | 投递 `main.py:1058`（legacy 同款 `brains/echo_memory_engine.py:523`），主体 `audit/echo_audit.py:190` |
| 治理扫描（非独立循环） | 每写 `cleanup_every`（默认 10）条 | `_cleanup_stale_memories()`：TTL 过期且低分软删 + 3×TTL 物理删 | 触发 `main.py:1063-1069`、`brains/echo_memory_engine.py:528-536`；实现 `brains/echo_memory_engine.py:1239-1257` |
| 仪表盘 WS 轮询 | 2s | 推想念真值 | `audit/echo_audit_dashboard.py:61`、`:1702` |
| **不属于本插件**：agent_state 衰减循环 | `decay_interval_minutes` | 心情衰减 | `astrbot_plugin_agent_state/main.py:310-362`，由 `@filter.on_astrbot_loaded()` `:146-150` 启动 |

反思的触发判定：重要性累计 ≥ `reflection_importance_threshold`（默认 30）**或** 夜间窗口（23~8 点）且距上次 >12h，`main.py:1948-1953`。

### A3. 配置

- 全部配置项来自 `_conf_schema.json`（310 行，**51 个键**），运行时经 `_cfg()` 读 `self.config`：`main.py:282-292`；默认值副本在 `core/echo_constants.py:17-84`（`DEFAULTS`）。
- 关键开关（行号为 `_conf_schema.json`）：`gateway_enabled` 202（网关接管 vs legacy）、`db_path` 304（共享灵魂库）、`persona_anchor_enabled` 159、`emotion_filter_enabled` 165、`drift_check_enabled` 171、`emotion_decay_enabled` 189、`reminder_enabled` 238、`longing_enabled` 250、`reflection_enabled` 51、`agenda_enabled` 45、`bubble_split_enabled` 214、`audit_enabled` 129、`brain1_enabled` 99、`min_emotion_score` 81、`memory_ttl_days` 87、`inject_top_k` 75。
- 主人身份有两个来源：`master_ids.txt`（文件，5s 缓存）> 配置 `master_id`；两者皆空 = 无人是主人（`main.py:304-340`，生成 `:499-514`）。

---

## B. 能力清单

### B4. 记忆写入链（消息进来 → 落库）

**网关链（`gateway_enabled=True`，主链路）**：`gateway()` `main.py:520` → `python_brain_pipeline()` `brains/brain_pipeline.py:1020`（出回复）→ 异步 `_gateway_brain2()` `main.py:677`：

| 步 | 动作 | 位置 |
|---|---|---|
| ① | EXTRACT：`_call_llm_json(EXTRACT_SYSTEM_PROMPT, EXTRACT_USER_TEMPLATE…)` | `main.py:704-710`；模板 `core/echo_prompts.py:23/62` |
| ② | 情绪向量/标量落库 `_save_state()`（表 `agent_state`） | `main.py:744-753` |
| ③ | **Judge**：`_memory_judge.judge(self, text, reply, session_id, recent_turns=…)` | 调用 `main.py:780-783`；类 `brains/brain_pipeline.py:1904`，方法 `:1917` |
| ④ | 情景记忆落库 `_insert_memory()`（表 `episodic_memory`） | `main.py:813-829` → `brains/echo_memory_engine.py:647`（INSERT `:722-750`；槽位取代查 `:690-696`、同摘要「强化不新增」`:699-719`、旧行退役 `:755-759`） |
| ⑤ | 图三元组 `_graph_learn()` → `_graph_add_edge()`（表 `graph_edges`/`graph_nodes`） | `main.py:883-886` → `brains/echo_memory_engine.py:305`（`_graph_add_edge` `:122`：查 `:169-176`、让位 `:196-201`/`:235-240`、复活 `:202-219`、INSERT edges `:221-231`；INSERT nodes `:97-100`） |
| ⑥ | 悬置话题：先 `resolve_pending_thread()` 消解，再 `remember_pending_thread()` 登记（表 `pending_threads`） | 消解 `main.py:901`（实现 `:921-946`）、登记 `main.py:910-915`（实现 `:766-818`，30 条内双向子串去重 `:797-812`）；顺序不可反，注释 `:895-898` |
| ⑦ | 命令式提醒（确定性，不走 Judge）：`_register_explicit_reminder()` | `main.py:922-930` → `:2070-2100`；正则 `_REMINDER_CMD_RE` `main.py:138` |
| ⑧ | 画像更新 `_apply_profile_update()`（表 `user_profile`） | `main.py:955-962` → `brains/echo_memory_engine.py:581`（UPSERT `:631-644`） |
| ⑨ | 审计落库 `_write_audit()`（表 `audit_logs`） | `main.py:1043-1048` → `audit/echo_audit.py:36`（INSERT `:78-113`） |

Judge 的三层防线：prompt 级 `_build_judge_system_prompt()` `brains/brain_pipeline.py:1776` → schema 级 `_validate_candidate()` `:1533`（L0 双重门控）→ 代码后处理 `_post_filter_candidates()` `:1602`（绝对化术语 `_has_unsupported_absolute` `:1520`）；三元组 `_validate_triple`/`_post_filter_triples` `:1685/1734`；悬置话题 `_validate_pending_threads` `:1654`；统计字段 `judge_stats` `:2044-2059`。

**legacy 链（`gateway_enabled=False`）**：`extract_memory()` `main.py:1326` → 投递 `_extract_pipeline()` `main.py:1365` → `brains/echo_memory_engine.py:368`：EXTRACT `:398` → `_insert_memory` `:424` → `_apply_profile_update` `:445` → `_save_state` `:473` → `_write_audit` `:502` → 漂移 `:523` → 治理 `:532`。
**注意差异**：这条链**没有** Judge、**没有**图三元组、**没有**悬置话题登记/命令式提醒 —— 只有 `min_emotion_score` 老闸门（`:420-442`）。迁移时不要把 legacy 当等价实现。

**读取侧的重要否定结论（已逐行确认）**：记忆检索**没有 embedding、没有向量库、没有 FTS5** —— 只有关键词/子串/字符重叠，检索实现 `brains/echo_memory_engine.py:948-1132`，总分公式 `total = hits*2.0 + r_now*2.0 + emotion_score*0.1`（`:1066`）。图谱扩散也不是朴素 BFS 而是 **best-first 堆搜索**（`heapq` `brains/brain_pipeline.py:607-617`，双向邻接表 `:590-591`，R 闸门 `:641-643`，L0 pinned 强制注入 `:555-576`）。迁 DSH 时如果要上向量检索，是**新增**而非移植。

**落哪张表**：`episodic_memory`（情景）、`graph_nodes`/`graph_edges`（图）、`pending_threads`（悬置）、`her_agenda`（议程）、`user_profile`（画像）、`agent_state`（情绪/话题台账）、`audit_logs`（审计）、`reflection_state`（反思游标）、`longing_state`（想念）。DDL 全在 `core/echo_schema.py:24-205` 与 `:405-423`。

### B5. 记忆读取 / 注入链

**网关拼装**：`python_brain_pipeline()` `brains/brain_pipeline.py:1020`，拼装体在 `cog_parts` `:1242-1282`，顺序即注入顺序：

1. `【现在】` 钟面 `:1249`
2. `【你刚才被插嘴了】` 残句 `:1250-1255`（来源 `plugin._interrupted_tail`，`main.py:198`）
3. `MEMORY_TIME_DISCIPLINE` 时间纪律 `:1257`（常量 `:685`）
4. `【关联知识路径】` `:1258-1259`（`render_paths` `:730`）
5. `【情景记忆】` `:1260-1261`（`render_episodic` `:762`）
6. `【到了可以跟进时间的话题】` `:1262-1269`
7. 画像 `【用户画像…】` `:1270-1271`
8. `agent_state_text`（= 内部状态 + 想念行 + 认账行，`main.py:612-615`）`:1274-1275`
9. 近期对话窗口 `:1276-1281`（`_render_recent_rounds` `:990`）

数据来源逐项：图 `plugin._graph_load(uid)` `:1053` → 种子 `direct_seed_hits` `:1112`（`brains/brain_pipeline.py:486`）+ `match_seeds_to_graph` `:1113`（`:443`）→ `graph_activate` `:1116`（best-first 关联扩散，`ACTIVATION_MAX_HOPS=5` `:58`、`ACTIVATION_TOP_K=5` `:59`、`ACTIVATION_DECAY=0.5` `:56`；函数 `:513`）；情景 `plugin._retrieve(uid, text+seeds, EPISODIC_TOP_K=8)` `:1155` → `brains/echo_memory_engine.py:948`（子串/字符重叠命中 → 幂律 R → 情感分加权，`LIMIT 500` `:964`，L0 强制占位 `:1099-1107`，命中即强化 `:1114-1131`）；悬置 `list_due_pending_threads(uid, now, 4)` `:1165-1174`，**注入即归零** `mark_pending_thread_mentioned` `:1178-1184`；画像 `plugin._get_profile(uid)` `:1191`；情绪滤镜 `plugin.build_filter_for(...)` `:1220`（`main.py:414`）。

**legacy 拼装**：`_build_context_block()` `main.py:2126` → `INJECT_TEMPLATE` `core/echo_prompts.py:120-131`，层级写死为：核心人格锚点(121) → 当前发言人(122) → 当前情境(123) → 情绪滤镜(124) → 用户画像(125) → 核心特征(126) → 相关回忆(127) → 行为准则优先级(128-131)；注入点 `main.py:1172-1184`（前插 `req.prompt`）。

**想念行**（被动路径）：`main.py:564-571` `【想念】距离上次对话 x.x 小时…`。

### B6. 人格（persona）

- 定义处：配置项 `persona_anchor`（`_conf_schema.json:141`）全文；读取 `_persona_anchor_config_text()` `main.py:431`（无视开关）/ `persona_anchor_text()` `main.py:439`（尊重 `persona_anchor_enabled`）；兜底 `GENERIC_PERSONA_ANCHOR` `core/echo_prompts.py:136`。**没有独立的人格文件**，人格 = 配置字符串。
- 提示词组装两路：网关 `mouth_system` 第 1 段 `anchor_text` `brains/brain_pipeline.py:1326`；legacy `INJECT_TEMPLATE[核心人格锚点]` `core/echo_prompts.py:121`。
- **人格锚点**：有。每轮注入，硬性优先级「锚点 > 身份 > 滤镜 > 记忆」（`core/echo_prompts.py:128-129`）；漂移强化期双份注入 `main.py:1166-1167`。
- **别名接地**：有。`speaker_identity_text()` `main.py:464-484`，尾部追加「他的别名/昵称：X、Y —— 这些称呼都指他本人，不要当成陌生词」(`:480-483`)；别名列表来自 `master_aliases` 配置（`_master_aliases()` `:486-497`）。动机注释写的是「<称呼>」事故（`:470-471`）。
- 漂移检测：`persona_summary`/`persona_rules`（`main.py:448/456`，兜底 `core/echo_prompts.py:147-152`）；prompt `DRIFT_SYSTEM_PROMPT`/`DRIFT_USER_TEMPLATE` `core/echo_prompts.py:96/111`；体检 `_persona_drift_check` `audit/echo_audit.py:190-235`；漂移事件写审计 `:237-259`；强化期滤镜正向覆写 `positive_override_vector()` `main.py:1149`。

### B7. 情绪（emotion / mood / affinity）

- **已废弃好感度**：`user_profile.affinity` 列保留但代码不再读写（`core/echo_schema.py:32-34`），渲染处也刻意不渲染（`brains/brain_pipeline.py:1203-1204`）。
- 维度与范围：`EMOTION_RANGES` `brains/echo_emotion.py:85-103` —— `global`: fatigue/valence/arousal；`target_master`: affection/playfulness/sadness/dependency；`target_group`: patience/contempt/defensiveness/anger。中文标签 `:106-118`，行为剧本短语 `:120-132`（每个维度 4 档）。
- **怎么算**：LLM 打分，不是词典。网关：EXTRACT 一次调用同时返回 `emotion_vector` + `mood_intensity`（`main.py:726-739`，夹取 `clamp_emotion_vector` `brains/echo_emotion.py:165`，对象隔离兜底 `main.py:731-732`）；legacy 同款 `brains/echo_memory_engine.py:461-484`。另有 brain1 轻量情绪评估（仅 legacy/主链路非网关）：`_evaluate_emotion()` `main.py:1219-1246`（`EMOTION_SYSTEM_PROMPT` `core/echo_prompts.py:73`，超时 6s）。
- **存哪**：`agent_state.emotion_vector` / `previous_emotion_vector` / `mood_intensity` / `prev_mood_intensity`（DDL `core/echo_schema.py:109-119`；写 `_save_state` `brains/echo_memory_engine.py:1176`）。
- **衰减**：`decayed_emotion_vector()` `brains/echo_emotion.py:322-342` —— 疲惫 -1/h；arousal/valence 向基线 0.5/h；群聊 anger/defensiveness/contempt **-2/h**、patience +1/h；主人向基线挪 5%~20%（爱意/依赖极慢）。驱动 `_emotion_decay_pass()` `audit/echo_audit.py:290-325`（30min 一次）。
- **怎么影响回复**：滤镜文本 `build_emotion_filter()` `brains/echo_emotion.py:277` → 网关 `mouth_system` `【多维情绪行为滤镜】` `brains/brain_pipeline.py:1336` / legacy `INJECT_TEMPLATE:124`；另影响想念阈值（心情越委屈/依赖，阈值越低）：`_care_threshold()` `brains/echo_longing.py:303-326`（钳位 4.5~9.5）。
- ⚠️ 同名不同物：`astrbot_plugin_agent_state` 的 `mood` 是另一个插件的 `state.db.agent_state.mood`（`agent_state/main.py:169-181`），与本插件 `memory.db.agent_state` 无关（注释 `core/echo_schema.py:106`）。

### B8. 主动开口（proactive）

四条独立触发路径：

| 路径 | 触发 | 组稿 | 发送 |
|---|---|---|---|
| 悬置话题闹钟 | `_reminder_pass()` `main.py:1519`，候选 `list_remindable_threads(limit=3)` `:1529`；到点必发，无免打扰（`:1522-1524`），发送成功才归零 `:1540` | `_compose_reminder_text()` `:1564`（`REMINDER_*` `core/echo_prompts.py:161/169`，失败退确定性模板 `:1574/1590`） | `_send_session_text()` `:1593` → **`context.send_message` `main.py:1602`** |
| 想念关怀 | `_care_pass()` `main.py:1613` → `_longing_should_care()` `brains/echo_longing.py:339`：阈值 `:355` → 冷却 `care_cooldown_minutes`（默认 120）`:357-359` → 夜间憋话 23~8 `:360-364` | `_compose_care_text()` `main.py:1755-1853`（`CARE_*` `core/echo_prompts.py:181/193`；失败/超 120 字即沉默 `:1851`） | 同上 `:1644`；发送成功 ×0.5 缓解 `_longing_on_care_sent` `brains/echo_longing.py:250` |
| 情绪余波 say_again | 大脑2 里 `say_again==1 and extra_reply` `main.py:967`；延迟 2~5s `:1403-1406`；用户抢话即取消 `:1421-1426` | 由 EXTRACT 直接给 `extra_reply` `:966` | `_send_proactive_text()` `:1457` → `context.send_message` `:1469`（失败退 `event.send` `:1475`） |
| 议程簿 | `agenda_enabled` 时关怀组稿取 top-1 `_pick_agenda()` `main.py:1683`（效用 = weight × 1/(1+天数) × 想念匹配 `:1734-1736`；48h 冷却 `:1702-1710`） | 拼进 `[你想聊的]` `:1827-1830` | 随关怀一起 |

- 想念值数学：`M(s)=10·s/(s+H)`，H 默认 3h（`_conf_schema.json:257-260`）；惰性补差 `_longing_current()` `brains/echo_longing.py:105-119`；每 30min tick（+抗议尖峰）`:266-297`；用户消息脉冲削减（按消息长度调制）`:172-248`。
- 所有主动消息都会写回对话窗口：`_record_round(session_id, PROACTIVE_ROUND_MARKER, text)` `main.py:1558`/`1668`，下一轮由 `_build_proactive_line()` `main.py:1855-1898` 注入「【你刚主动说过】」+ 防火墙条款（内存窗口丢了就查 `audit_logs` 兜底，10 分钟窗口 `:1880-1887`）。
- 主动行为审计：`_write_action_audit("reminder"/"care"/"reflection", …)` `audit/echo_audit.py:133-179`。

### B9. 工具 / function calling

**一个都没有。** 全插件 grep `llm_tool|register_llm_tool|tools=|tool_calls|function_call` **零命中**。暴露给用户的只有 7 个聊天命令（`main.py:2213-2584`）。`audit_logs.tool_call` 是审计里的行为类型标记（`audit/echo_audit.py:133-179`），不是给模型的工具。
→ 迁移含义：DSH 版 `echo_recall`/`echo_feeling`（`dsh_port/04:52`）是**新增**能力，不是移植。

### B10. 平台相关性 / 发消息调用点

- **没有平台专有代码**：本插件无 `aiocqhttp`/OneBot/CQ 码目。grep `aiocqhttp` 只在 `tests/selftest_v8_4.py` 的测试夹具里（如 `:891` 会话字符串）。宿主侧平台是抽象过的：`context.send_message` 按 `session.platform_name` 找 `platform_insts` 再 `platform.send_by_session`（`AstrBot_src/astrbot/core/star/context.py:614-643`，抽象基类 `platform.py:38/134`，实现 `sources/aiocqhttp/aiocqhttp_platform_adapter.py:109`）。
- **发消息的确切 API 行**：
  - `main.py:1602` `await self.context.send_message(session_id, MessageChain([Plain(text=text)]))` ← 提醒/关怀的唯一出口
  - `main.py:1469` `await self.context.send_message(session, chain)`（余波，优先）
  - `main.py:1475` `await event.send(chain)`（余波兜底）
  - `main.py:661` / `main.py:669` `yield event.plain_result(...)`（网关回复）
  - `setu_on_proactive` **不发消息**：`main.py:187` `await queue.put(new_event)`（伪造事件塞回宿主队列）
- 唯一软耦合：**session_id 是 umop 字符串**（`main.py:410` `event.unified_msg_origin`），格式如 `aiocqhttp:Private:123`（测试里可见 `tests/selftest_v8_4.py:891/906`）。
- 群/私聊判定：`event.get_message_type()`，`main.py:370-405`。

### B11. 群聊/私聊、非主人消息

- **不丢弃任何消息，也没有"只回主人"**：`gateway()` 只对两种情况放行原链路 —— 空文本（`main.py:535-537`）与命令前缀 `/ ! # .`（`:539`）；其余全部走 `brain_pipeline`。全文无 `_is_master` 判断。
- 单用户模式：`_resolve_speaker()` `main.py:346-368` 恒返回 `is_master=True`、`key=__shared__`（`core/echo_constants.py:7`）；`member_key()`（群友桶 `member:<id>`）仍存在但注释标注为历史遗留（`main.py:342-344, 2316-2317`）。
- 真正的权限检查只在管理命令里：`_is_master()` `main.py:332`；`/audit` 2227、`/threads` 2378、`/mem_forget` 2446、`/mem_clear` 2464、`/master` 2498；`/graph` 注释承认旧版无检查（`:2546-2548`）。
- 群/私聊的实际影响：写进记忆 `source`/`source_label`（`main.py:817-819`）、注入措辞（`recall_hint` 群里/私聊 `main.py:2147-2150`）、按会话隔离情绪差分（`_session_id` `main.py:407-412`）。

### B12. LLM provider / 历史组织

- **自家 OpenAI 兼容 HTTP 客户端**：`_call_openai_compatible()` `brains/echo_llm_client.py:147-186` —— `httpx.AsyncClient` `:182`，URL 拼接 `:161-166`，payload `:167-175`（`temperature=0.2`、`max_tokens`、JSON 模式加 `response_format={"type":"json_object"}` `:176-177`）。配置 `llm_api_key`/`llm_base_url`(默认 `https://api.deepseek.com`)/`llm_model`(默认 `deepseek-chat`)，`_conf_schema.json:2/9/15`。
- **兜底 AstrBot provider**：`_call_astrbot_provider()` `:188-203`（`context.get_using_provider_async()` `:192` / `get_using_provider()` `:194` / `provider.text_chat()` `:200`）。
- 统一入口 `_call_llm_raw()` `:30-56`；JSON 容错三级修复 `_safe_json()` `:205-247`；自由文本 `_call_llm_text()` `:73-108`（含 JSON 外壳抢救 `:110-145`）。
- **每轮调用预算**：网关一轮最多 4 次自家调用 —— 种子提取 `brains/brain_pipeline.py:1070`、内心草稿 `:1303`、嘴巴 `:1382`（失败重试 `:1380`）+ brain1 情绪评估（legacy/被动路径 `main.py:1227`）；轮后再 EXTRACT `main.py:704` + Judge `brains/brain_pipeline.py:1960`。
- **历史/上下文组织**：没有对话历史库，也没有摘要压缩。只有进程内滑动窗口 `_recent_rounds`（每会话最多 4 轮，`audit/echo_audit.py:186-188`），喂 Judge 最近 5 轮（`brains/brain_pipeline.py:1944`，来源 `main.py:769-775`）。其余全靠 `memory.db` 检索。`dsh_port/03/04` 的 compaction 是 DSH 侧新增。
- **`brain_pipeline.py` 自己不连任何 LLM**：顶部只有 `datetime/heapq/json/math/re/time/uuid`（`:24-30`），无 `httpx`/`openai`/`aiohttp`/`requests`。它的 5 个 LLM 调用点（`:429`、`:1070`、`:1304`、`:1383`、`:1960`）全部走宿主注入的 `plugin._call_llm_json/_call_llm_text` —— **这正是 soul 可平移的结构证据**。
- 该客户端**无重试、无并发闸、无退避**（失败即 `return None`，`brains/echo_llm_client.py:54-56`）；并发保护在调用方按用户串行（`brains/echo_memory_engine.py:383-384` 的 `_user_locks`）。

---

## C. 数据与状态

### C13. SQLite 库与表

| 库 | 路径（实测存在） | 表 |
|---|---|---|
| `memory.db`（Echo 本体） | 默认 `StarTools.get_data_dir(PLUGIN_NAME)/"memory.db"` `main.py:222` = `data\plugin_data\astrbot_plugin_memory_middleware\memory.db`（3.4MB + 2.1MB WAL）；可被 `db_path` 改指 `~/.dsh/echo/echo.db`（`main.py:221`；`_conf_schema.json:304`；实测 `$env:USERPROFILE\.dsh\echo\echo.db` 308KB + 4MB WAL 存在） | `user_profile` `echo_schema.py:28`、`episodic_memory` `:42`、`reflection_state` `:76`、`her_agenda` `:91`、`agent_state` `:109`、`audit_logs` `:130`、`pending_threads` `:164`、`longing_state` `:192`、`graph_nodes` `:409`、`graph_edges` `:416`；索引 `:59/66/155/179/457/507/511` |
| `state.db`（agent_state 插件） | `StarTools.get_data_dir("astrbot_plugin_agent_state")/"state.db"` `agent_state/main.py:138` = `data\plugin_data\astrbot_plugin_agent_state\state.db`（12KB + 1.2MB WAL） | `agent_state`（`session_id` PK / `current_topic` / `mood` / `mood_intensity` / `active_goal` / `last_interaction` / `updated_at`）`agent_state/main.py:169-181`；被本插件直读 `main.py:1287-1296` |
| `data_v4.db`（AstrBot 宿主） | `$env:USERPROFILE\.astrbot\data\data_v4.db`（11MB） | **本插件代码零引用**（全仓 grep 无 `data_v4`）。它存宿主的会话/配置；网关 `stop_event()` 之后对话历史由宿主自己落库，与 `memory.db` 不互通 —— 这正是 `_build_proactive_line` 需要查 `audit_logs` 兜底的原因（`main.py:1858-1861`） |

⚠️ 表名冲突：`agent_state` 在 `state.db` 与 `memory.db` 里重名且字段完全不同 —— 写审计脚本必须带库路径。

### C14. 游标 / 水位

| 水位 | 落在哪 | 位置 |
|---|---|---|
| 反思游标 | `reflection_state(user_id PK, last_memory_id, last_at)` | DDL `core/echo_schema.py:76-80`；读 `main.py:1930-1935`；推进 `main.py:2051-2058` |
| 想念状态 | `longing_state(value, anchor_at, updated_at, kicked, last_user_msg_at, last_care_at, care_count, session_id)` | DDL `core/echo_schema.py:192-202`；语义与惰性求值 `brains/echo_longing.py:105-119` |
| 悬置话题到点水位 | `pending_threads.follow_up_after`（提过即归零）、`last_mentioned_at` | DDL `core/echo_schema.py:164-172`；归零 `main.py:1540` |
| 议程冷却 | `her_agenda.last_used_at`（48h） | DDL `core/echo_schema.py:98`；写 `main.py:1743-1753` |
| 最后一条主动消息（兜底水位） | `audit_logs` 最新行 + 10min 窗口 | `main.py:1880-1887` |
| 进程内（不落库，重启即失） | `_handled_keys` 去重 `main.py:191/1358-1363`、`_session_seq` `:195`、`_recent_rounds` `:210`、`_drift_strikes` `:206`、`_round_counts` `:208`、`_writes_since_cleanup` `:193`、`_interrupted_tail` `:199`、`_bubble_done` `:201`；DMAE 节流水位 `_last_materialize_bucket` `brains/brain_pipeline.py:902-903`、`_last_prune_bucket` `:914-915` | `main.py:186-210` |
| 记忆条目的时间/衰减持久量 | `episodic_memory.last_recalled / half_life / recall_count`（`core/echo_schema.py:225-228`）、三分时间 `occurred_at/learned_at/timestamp`（`:236-237`）、槽位 `memory_key/superseded_by`（`:244-245`）；`graph_edges.last_accessed/half_life/recall_count/slot/is_active/superseded_by`（`:419-421`、`:476-478`） | `core/echo_schema.py`（补列 `_ensure_columns` `:207-298`） |

**没有**「最后处理消息 id」式的追赶水位：记忆写入是每轮即时触发，不是扫表。

### C15. 对外 HTTP / IPC

- **有**：审计仪表盘，独立线程 + 独立事件循环。HTTP `0.0.0.0:8420`（`HTTPServer` `audit/echo_audit_dashboard.py:1613`，端口常量 `:59`），WebSocket `0.0.0.0:8421`（`websockets.serve` `:1714`，端口 `:60`，轮询 2s `:61`）。REST 含 `/api/longing`，由想念真值回调供数（`echo_longing.py:328-337`，注释 `echo_audit_dashboard.py:1608`）。随插件启动 `main.py:240-248`，`terminate` 停止 `main.py:254-255`。另有只读导出脚本 `audit/export_conversation.py`（`mode=ro` `:65-67`）。
- 除此之外**纯进程内插件**，无 HTTP/IPC 服务。与另两个插件的耦合是：① 事件属性 `event._echo_agent_state`（本插件读 `main.py:1263-1273` ← 写入 `agent_state/main.py:416-426`）；② 直读对方 sqlite（`main.py:1287`）。反向为零。
- `setu_on_proactive` 与另两者**零耦合**（`setu_on_proactive/main.py:40-51` 只 import 标准库与 astrbot）。

---

## D. 总结表

| 能力 | A 侧实现（文件:行） | 与平台强耦合 | 迁移难度 | 一句话理由 |
|---|---|---|---|---|
| 入站网关 / 出站回复 | `main.py:519-675` | 否 | 中 | 逻辑纯 Python，但它替换掉的是宿主的模型轮，DSH 侧由 agent loop 接管 |
| 大脑2 记忆写入（网关链） | `main.py:677-1083` | 否 | 低 | 入口只有文本，内部全是 HTTP + SQLite |
| 大脑2 记忆写入（legacy 链） | `echo_memory_engine.py:368-540` | 否 | 低 | 同上；但功能是网关链的子集，别当等价实现 |
| Memory Judge | `brain_pipeline.py:1904-2071` | 否 | 低 | 纯 prompt + schema + 后处理，零宿主 API |
| 情景记忆落库 / 槽位取代 | `echo_memory_engine.py:647-761` | 否 | 低 | SQL 可原样搬 |
| 图记忆 / 三元组 / BFS 扩散 | `echo_memory_engine.py:305-366`；`brain_pipeline.py:443-673` | 否 | 低 | 纯算法 + 两表 |
| DMAE 遗忘数学（R/H0/强化/剪枝） | `brain_pipeline.py:159-190`, `:260-390` | 否 | 低 | 纯函数，无状态 |
| 治理扫描 / TTL 清理 | `echo_memory_engine.py:1239-1257` | 否 | 低 | SQL |
| 认知上下文拼装（网关） | `brain_pipeline.py:1242-1282` | 否 | 中 | 内容可搬，但装配时机要换成 DSH `systemPrompt.context` |
| 注入块拼装（legacy） | `main.py:2126-2208` + `echo_prompts.py:120-131` | 否 | 低 | 纯字符串；DSH 侧建议直接不用这条 |
| 人格锚点 | `main.py:431-446`；`echo_prompts.py:136-152` | 否 | 低 | 就是一段配置字符串 |
| 别名接地 | `main.py:464-497` | 否 | 低 | 字符串拼接 |
| 人格漂移体检 | `echo_audit.py:190-259` | 否 | 低 | 一次 LLM 判定 + 审计 |
| 情绪向量算法 | `echo_emotion.py:85-350` | 否 | 低 | 纯数学 |
| 情绪评估 brain1（LLM 语言半） | `main.py:1219-1246` | 否 | 中 | 04 §6 R3 已建议删除（嘴巴自己看得见情绪包） |
| 情绪衰减循环 | `echo_audit.py:264-325` | 否 | 低 | 只要有个时钟 |
| 想念值曲线 / tick / 三重闸门 | `echo_longing.py:105-365` | 否 | 低 | 数学 + SQLite，已在 `dsh_port/04` 规划为 soul 时钟 |
| 主动关怀组稿 | `main.py:1755-1853` | 否 | 低 | 需要一处 LLM + 沉默纪律 |
| 悬置话题提醒 | `main.py:1519-1591`；`echo_memory_engine.py:766-946` | 否 | 低 | 只差时钟与一个发送出口 |
| 议程簿 | `main.py:1683-1753`；`echo_schema.py:91-101` | 否 | 低 | SQL |
| 审计黑匣子 | `echo_audit.py:36-179`；`echo_schema.py:130-153` | 否 | 低 | SQLite，且是主动消息的兜底记忆 |
| 情绪余波 say_again | `main.py:1395-1479` | **是** | 中 | 依赖「第二条消息 + 抢话检测」，DSH 侧要给对应通道与插话信号 |
| 切泡发送 / barge-in | `main.py:640-673`, `:1384-1393` | **是** | 高 | QQ 的分气泡节奏在 DSH 是一条流式回复，语义要重新设计 |
| 进程内状态（去重/序号/窗口） | `main.py:186-210` | 否 | 低 | 但必须搬进 soul 进程内才有意义 |
| 状态机接入（agent_state 插件） | `main.py:1263-1308` ↔ `agent_state/main.py:388-474` | 否 | 中 | DSH 侧没有这个插件，状态来源要重新定义（或并入 soul） |
| 审计仪表盘 HTTP+WS | `echo_audit_dashboard.py:59-61`, `:1605-1785` | 否 | 中 | DSH 侧换成 typert Remote + 伴侣面板（04 §5） |
| 管理命令 ×7 | `main.py:2213-2584` | 否 | 中 | DSH 侧应做成工具/面板而不是聊天命令 |
| 共享灵魂库双身体 | `main.py:216-225`；`_conf_schema.json:304` | 否 | 低 | 已具备（WAL + busy_timeout + db_path），DSH 库已存在 |
| **setu_on_proactive（整个插件）** | `setu_on_proactive/main.py:83-190` | **是** | 高 | 它靠伪造 AstrBot 事件队列触发别的命令插件（`:187`），DSH 侧无对应物。建议**不迁移** |

### 必须留在 A 侧（平台面）

1. **消息收发通道**：`context.send_message` / `event.plain_result` / `event.send`（`main.py:661/669/1469/1475/1602`）—— 迁 DSH 后对应物是 GUI 通道，A 侧这层不能搬。
2. **会话标识（唯一真接口改造点）**：`session_id = event.unified_msg_origin`（`main.py:410`），umop 字符串形状是 AstrBot 的约定；DSH 要换成自己的会话标识，且 `longing_state.session_id` / `audit_logs.session_id` / `pending_threads.session_id` 都是按它写的。
3. **群/私聊元数据**：`event.get_message_type()`（`main.py:373`）、`event.get_group_id()`（`:383`）—— 注入措辞与记忆 source 都依赖它。
4. **命令注册与命令前缀放行**：7 个 `@filter.command`（`main.py:2213-2584`）+ 前缀放行（`:539`）。
5. **QQ 特有节奏**：无「正在输入」指示器所以用泡间延迟模拟打字（代码注释 `main.py:1387`）。
6. **agent_state 插件的钩子时机**：它靠 `on_decorating_result` 在网关掐掉 LLM 前入库（`agent_state/main.py:474`），本插件才读得到（注释 `main.py:1278-1281`）。DSH 无此钩子。
7. **setu_on_proactive**：伪造事件队列（`setu_on_proactive/main.py:187`），纯 A 侧机制。
8. **宿主的模型调用与对话历史（data_v4.db）**：网关模式下已被 `stop_event()` 绕过，DSH 侧由宿主承担。

### 附：本次得到的「Star/event 剥离面」答案（`dsh_port/04` §8.5）

AstrBot 依赖全清单（14 行，6 个文件）：

- `main.py:62-80`：`logger` + `filter`/`EventMessageType`/`AstrMessageEvent`/`Context`/`Star`/`StarTools` + `LLMResponse`/`ProviderRequest` + `MessageChain`/`Plain` —— **唯一真正的平台面，且集中在插件类与 7 个命令上**。
- `core/echo_schema.py:11`、`audit/echo_audit.py:15`、`brains/brain_pipeline.py:37`、`brains/echo_llm_client.py:13`、`brains/echo_memory_engine.py:16`：只有 `logger`。
- `brains/echo_memory_engine.py:17`：`AstrMessageEvent` **仅用于类型注解**（`:370`）。
- `brains/echo_llm_client.py:192-194`：`self.context.get_using_provider*()` —— 唯一的 provider 兜底，删掉即完全脱离宿主。

即：**5 个 Mixin（Schema/MemoryEngine/LLMClient/Audit/Longing）与 `brains/`+`core/`+`audit/` 可以在只替换 logger 的前提下原样成为 soul 子进程**。

### 附二：迁移硬约束与宿主最小契约（给实现用）

1. **宿主最小契约**（`python_brain_pipeline` 只需要这些成员就完整可跑）：`_call_llm_json` / `_call_llm_text`、`_db` / `_db_lock` / `_cfg`、`_retrieve`、`_get_profile`、`_get_state`、`_graph_load`、`persona_anchor_text`、`speaker_identity_text`、`build_filter_for`、`list_due_pending_threads`、`mark_pending_thread_mentioned`。→ DSH 侧 Node 薄层给这些方法一个 JSON-RPC 包装即可。
2. **天然接口边界**：`python_brain_pipeline` 返回一个完整「审计包」dict（`brains/brain_pipeline.py:1462-1479`：reply/draft/paths/episodic/filter/seeds/cognitive_context/mouth_*/ltp/dmae/mouth_failed/latency），这已经是现成的 RPC 响应形状。
3. **异常一律吞掉**：`python_brain_pipeline` 的最外层 `except` 把任何异常变成 `return None`（`:1480-1493`），调用方只能靠日志定位 —— 迁移时建议在 RPC 层补错误字段。
4. **硬约束：提示词模板禁止 `str.format()`**，必须用 `.replace()`（`core/echo_prompts.py:17-19`、`:158-159`，原因：模板内含 JSON 示例的 `{"keywords"` 会被当成字段名）—— 谁改这段谁踩坑。
5. **EXTRACT 失败不早退**（`main.py:714-723`）：降级为空 dict，Judge/悬置话题/命令式提醒照常执行；这是 v8.5「命令要确定性执行」的根修，迁移时别顺手加 early return。
6. **`echo_emotion.py` 是纯函数文件**（全文无 `self._db`/SQL），可直接当纯计算模块平移；数值全部来自 LLM 打分，档位表只做「数字 → 中文剧本」翻译。
7. **`_dmae()` 是惰性导入**（`brains/echo_memory_engine.py:104-120`），拿不到 `brain_pipeline` 时全线降级为硬编码常数（`:160` `h0=24.0`、`:191` `new_h=old_h*1.9`）—— 迁移后如果模块路径变了，会静默退化。
8. **`main.py` 里仍有一份情绪处理活代码**（`:728-732` 与 `brains/echo_memory_engine.py:463-470` 逐行同构；`build_emotion_filter` 在 `main.py:417/1154/1792` 被调用），说明「v8.4.3 机械拆分」后 main.py 不是纯转发壳 —— 剥离时不能只看 import，要核到函数体。

### 其它观察

- `.backups/` 下有 4 份历史快照（2026-09-18 ~ 09-24，含 `_backup_before_dmae_rewrite` 等），不是活代码；`.refactor_tools/`、`tests/`（`selftest_v8_4.py` 2051 行）同理。
- 插件目录里已有 5 份迁移设计稿：`dsh_port/01`~`05`（`04-总体架构-施工图骨架.md` 已画出 soul 子进程 + JSON-RPC over stdio）。本报告可作为该施工图的「A 侧事实核对表」。
- `metadata.yaml:4` 版本 `8.10.1`，`astrbot_version: ">=4.0.0"`（`:7`）；`db_path` 共享库即本版新增（`:5` 大段 changelog 描述）。
