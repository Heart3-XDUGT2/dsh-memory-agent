# dsh-echo 全项目机制与架构总览

> 本文是**一份文档读懂整个项目**的总入口。写作时间 2026-09-27,对应版本 **v0.30.1**。
> 事实来源:仓库源码(逐文件精读)、`CHANGELOG.md`(77 个版本条目)、`docs/` 现有文档、
> 以及活库 `~/.dsh/echo/echo.db` 的只读实测。凡未核实处均标注「(未核实)」。
>
> 姊妹文档:`docs/README.md`(索引)、`docs/DEFENSE.md`(答辩)、
> `docs/MEMORY_ARCHITECTURE.md`(记忆字段语义)、`docs/CORE_IN_DSH_PLAN.md`(归位计划)。

---

## 一、她是什么(一句话与三条判据)

**dsh-echo 是 DeepSeek Harness(DSH)的原生陪伴人格插件 —— 她给 DSH 装上灵魂。**
不是「一个跑在 DSH 旁边的聊天机器人」,而是**一个会写代码的陪伴 agent**:原生 agent loop
(文件、终端、联网、子代理)全部保留,她带着 Echo 的身份、铁律与说话方式去用它。

三条设计判据(贯穿全仓,几乎所有"为什么不那样做"都能回到这里):

1. **能改变「她是谁」的东西只能有一份。** 人格、记忆、想念、情绪、提示词 —— 全部住在
   DSH 侧;平台(QQ)只留嘴和耳朵。这条判据直接导致了 v0.17.x 的「核心归位」。
2. **人格永不陪葬。** 引擎崩、库打不开、子代理失败 —— 任何一层出事都只少一段增益,
   绝不丢他的回复、绝不掉人格。全仓的 try/catch 密度是这条判据的代价。
3. **不许编造。** 没有记忆就不注入、抓不到图就明说「别当自己看过了」、探针读不到数据
   要抛错而不是报绿。宁可少说,不许假装。

---

## 二、全局架构:JS 壳 + Python 全引擎侧车

```
DSH(cordis 插件星座)                Python sidecar(worker.py)
┌──────────────────────┐  JSONL   ┌────────────────────────────┐
│ lib/index.js   壳     │  stdio   │ python/engine/ 十一模块      │
│  · 提示词三段注入      │←────────→│  retrieve / judge /         │
│  · session/event 捕获 │  帧配对   │  reflection / episodic /    │
│  · 心跳 / 工具族 / 面板│ echo_wire_v1│ dmae / graph / threads /  │
│ lib/store.js   壳表   │          │  agenda / dedupe / timeutil │
│ lib/engine.js  门面   │          │  + longing(想念)            │
└──────────────────────┘          │ 纯标准库 ≥3.9,零 pip        │
        ↑ web/ 网页仪表盘 /echo/   └────────────────────────────┘
        ↑ astrbot_adapter/ QQ 薄壳
```

**为什么是 sidecar 而不是全 JS 重写**:引擎是 AstrBot 时代 375 项测试的 Python 资产,
逐字移植即原封运行 —— 重写等于把测试资产扔了。先例:官方 `dsh-schedule` 就是
「JS 壳 + 帧协议驱动 sidecar」的形态。**分工铁律:LLM 调用只留在壳侧**(走宿主
subagents 官方通道),引擎纯标准库、不碰网络、不碰密钥。

### 规模(实测)

| 层 | 规模 |
|---|---|
| `lib/*.js` | **43 个模块,约 13004 行** |
| `python/**/*.py` | **26 个文件,约 8907 行** |
| `tests/*.test.js` | **58 个测试文件**(JS 电池 580 项) |
| `python/tests/` | 12 个文件(Python 电池 234 项) |
| `astrbot_adapter/` | 3 个源文件 + 3 个测试文件(适配器电池 47 项) |
| `scripts/` | 23 个运维/验收脚本 |
| `web/` | 仪表盘 4 文件 + d3 本体(断网可出图) |
| `docs/` | 19 份文档 + `archive/` 归档区 |
| 版本 | **v0.1.0 → v0.30.1,77 个版本条目** |

---

## 三、一轮对话的完整数据流

这是整个项目最核心的一条链路,分**写入**(她记住什么)与**读取**(她看见什么)两个方向。

### 3.1 读取方向:她这轮「看见什么」

组装点是宿主钩子 **`system-prompt/assemble`**(`lib/index.js:1192`),不是 pre-step
(pre-step 只存 agent 句柄给反思用,`index.js:1215`)。闸门顺序:

```
readEnabled()(总闸)→ 拨开关那一轮例外(powerNote)→ sessionEnabled(sid)(会话闸)
  → turnSnapshot.compose(session) → 注入一节 order=10260
```

注入信的内容(`lib/engine.js:130-210` 组装,`renderInjectedBlock` 渲染):

| 段 | 来源 | 说明 |
|---|---|---|
| ①【关联知识路径】 | `graph_query`(种子→BFS→路径文本) | **图谱唯一的用途**;排在情景记忆**之前**(QQ 认知上下文顺序) |
| ②【情景记忆】 | `retrieve`(DMAE 排序 + L0 强制占位) | 六档命中判据 |
| ③ 钟面 / 想念行 / 悬置话题 / 议程 / 纪律尾 | 壳侧状态 | 想念行过 ≥1.0 门才进 |

**图是增益不是依赖**:`graph_query` 失败只丢图那一段,情景记忆照常注入(`engine.js:161-164`)。

### 3.2 写入方向:她「记住什么」

捕获走 `session/event` 追加流(`index.js:1338`),轮末 `turn/end` 触发反思:

```
user/message → isHumanUtterance 白名单闸(不是人话就 return,index.js:1349)
             → 会话范围闸 → 捕获 userText(2000 字截断)
             → 想念脉冲(longingMessage:削减+锚点重置+会话路由刷新)
assistant/message → 累积 turnText + 出站捕获(relay.captureSegment)
turn/end     → 对话记录一行 + fireReflect(串行闸,忙则排队最新一轮)
```

反思 = **一次 LLM 调用产三样东西**(`lib/reflect.js` + `python/engine/judge.py`):

```
candidates      → episodic_memory        句子:发生了什么事
triples         → graph_nodes/graph_edges 三元组:谁—关系—谁
pendingThreads  → pending_threads         悬置话题:她惦记着、还没结掉的事
                    (2026-10-06 生命周期:kind 五类 + 冷却/归档两列 + 语义去重留档;
                     注入侧只放行「活跃 × 有类别 × 类内时效」,冷却/归档由 60 秒节拍按类降级)
顺带             → user_profile(称呼/画像)、agent_state(情绪向量)
```

**关键设计:记忆与图谱是同一次反思的两种产物,落在两张表里,彼此不引用**
(详见 `docs/MEMORY_ARCHITECTURE.md`)。记忆是「发生了什么」的句子,图谱是
「谁和谁什么关系」的三元组 —— 图谱不是记忆的可视化。

---

## 四、记忆引擎(Python 侧车)

### 4.1 帧协议 echo_wire_v1

- **传输**:stdio JSON Lines,UTF-8;stdout 只出协议帧,诊断走 stderr(预算 64 行);
  单帧上限 1 MiB(`worker.py:57`)。
- **握手**:`hello` 必须先行,协议名不符 → fatal 错误帧 + 退出码 1;`verify_db`
  **只验不建**(裸 connect 会静默建空库,`worker.py:97-120`)。
- **分发**:`handle()` 单函数 if 链;引擎异常一律回**错误帧**而非崩溃;未知帧 type
  非致命;坏 JSON 非致命;超 1 MiB 致命;stdin EOF 安静退场。
- **帧清单**:`hello` `ping` `retrieve` `extract_prompt` `extract_commit` `stats`
  `agenda_pick` `agenda_mark` `memory_add` `memory_forget` `memory_search`
  `episodic_cleanup` `episodic_clear` `reflection_prompt` `reflection_commit`
  `longing_check` `longing_message` `longing_care` `longing_tick` `threads_due`
  `threads_remindable` `threads_mark` `threads_ingest` `threads_done` `threads_add`
  `threads_list` `threads_lifecycle` `threads_restore` `graph_learn` `graph_query`
  `graph_reinforce` `shutdown`。
- **纯被动**:worker 不主动推送任何帧。「主动」是壳侧心跳**调帧**拿判定与候选。
- `stats` 仍是空壳(`{"stats": null, "stub": true}`,`worker.py:237-241`)。

### 4.2 DMAE 记忆数学(不是比喻,是公式)

| 概念 | 公式 | 出处 |
|---|---|---|
| 可提取性(遗忘) | `R(Δt) = 1/(1 + Δt/H)`,永不归零 | `dmae.py:59-64` |
| 初始半衰期 | `H0 = h_min · (I/i_ref)^γ` | `dmae.py:67-70` |
| 间隔效应强化 | `H' = H · (1 + k·(1 − R_想起时))` | `dmae.py:73-81` |
| 内在价值 | `I = 100 · Tier · Trust · Salience^0.5`(**乘积否决式**) | `dmae.py:114-147` |
| 三态 | R ≥ 0.5 Active / ≥ 0.1 Dormant / 否则 Archived | `dmae.py:84-91` |

- 默认参数:max_score 100、h_min 24、i_ref 10、gamma 1.2、k_reinforce 1.8、
  r_active 0.5、r_dormant 0.1、w_recall 0.4、salience_exp 0.5、prune_r 0.02、
  prune_i 15、prune_min_age_days 60(`dmae.py:25-40`)。
- Tier:L0/stable 1.00、L1/situational 0.45、其余 0.15;Trust 是 certainty ×
  attribution 的乘积(explicit 1.00 / inferred 0.55 / uncertain 0.25 ×
  user_explicit 1.00 / mixed 0.70 / assistant_inferred 0.40)。
- **磨损状态只存 `half_life` / `last_accessed` / `recall_count`,R 永远现算**;
  物化的 `activation` 只作面板快照,数学处绝不读(`dmae.py:13-15`)。
- **剪枝四条件同时成立**:recall_count=0、I<15、R<0.02、沉默>60 天。
- **JS 基线同源**:`lib/dmae.js` 是同一套数学的 JS 冻结版(基线特性冻结,M1 即最终形态)。

### 4.3 置信度门控(四层准入)

1. 提示词硬约束 → 2. Schema 校验 → 3. 代码级后过滤 → 4. **置信度闸**:

```
< 0.55        → 拒收
0.55 ~ 0.75   → 隔离落库(status='quarantined',检索不可见)
≥ 0.75        → 落库
```

隔离行有晋升路径(同 slot 高置信版本后来居上)与降观察守卫(已确立的事实不因弱重测降级)。
**全隔离轮降级路径照发 —— 情绪是真的,存疑的只是事实。**

### 4.4 检索(六档 + L0 强制占位)

- **总分 = hits×2 + R×2 + emotion_score×0.1**(`retrieve.py:154`)。
- 命中档:关键词整词 1.0 / 互为子串 0.7 / 摘要整段 1.0 / 互相包含 0.5 / 0.3 /
  字符重叠率 ≥0.5 得 0.4。
- 候选池:该用户最近 `CANDIDATE_LIMIT=500` 条 active 记忆。
- **L0 强制占位**:按 I 降序取 `core_cap = min(8, max(1, top_k−2))`,至少留 2 席给常规结果;
  L0 零命中仍进池(`retrieve.py:143-177`)。
- **想起即强化**:命中的每条延长半衰期 + recall_count+1;`reinforce=False` 时只读
  (forget 用,绝不强化目标)。

### 4.5 记忆图谱

- 节点 `node_type` 默认 `concept`,`person` 节点自动 `is_protected=1`;
  边 `UNIQUE(source_id, target_id, relation, owner_key)`。
- 常量:ACTIVATION_DECAY 0.5、THRESHOLD 0.15、MAX_HOPS 5、TOP_K 5、
  L0_GRAPH_ALWAYS_ON_LIMIT 12、LTP_BOOST 0.5、LTP_MAX_WEIGHT 10、
  PROTECTED_BOOST 1.0(`graph.py:47-54`)。
- 权重:新边 `weight=1.0, activation=100`;同三元组命中 `weight=min(10, w+0.5)`;
  LTP +0.5(主人 +1.0),上限 10。
- BFS:`child_score = score × (0.5 + min(w,10)/10 + w_recall×R) × decay`;
  R < 0.1 不做中继,但**种子邻接边免闸**(Archived 的唯一唤醒通道)。
- **别名接地**:`graph_aliases` 表在 `get_or_create_node` 之前查表;节点墓碑
  (`is_active`/`superseded_by`)让位而非删除。

### 4.6 悬置话题与议程

- **悬置话题**(`pending_threads`):`status='open' → 'resolved'`;
  `follow_up_after` 归零 = 已提过、不再追问。到期判定
  `follow_up_after > 0 AND follow_up_after <= now`;`remindable` 额外要求 session_id 非空。
  登记去重:最近 30 条 open,casefold 双向子串(子串侧 ≥6 字)或到期时间差 < 120s。
- **议程**(`her_agenda`):效用 `utility = weight × 1/(1+天数)`,天数自
  `max(created_at, last_used_at)` 起算;委屈/依赖 ≥6 且 origin='reflection' 时 ×1.5;
  冷却 48h、权重地板 0.2;persona 层 utility 恒 1.0。

### 4.7 数据库

- **表**:`episodic_memory` `graph_nodes` `graph_edges` `graph_aliases`
  `pending_threads` `her_agenda` `agent_state` `audit_logs` `longing_state`
  `reflection_state` `diary` `user_profile` `conversation_log` +
  桥三表 `relay_channels` `relay_outbox` `relay_inbox_seen`。
- **真相源要澄清**:`python/engine/db.py` 的 DDL **不是唯一真相源** —— 共管表
  (尤其 `episodic_memory`)的权威形状在 JS `lib/store.js`,引擎侧是逐列镜像;
  引擎只对自有扩展列享有迁移权。两边的 DDL 同源由 `test_ddl_parity.py` 守卫。
- **迁移**:无版本号表,靠幂等 ALTER;索引补建必须晚于 ALTER(否则新库报
  `no such column: slot`)。
- 连接:`PRAGMA busy_timeout = 5000` + WAL。

---

## 五、壳层(lib/)

### 5.1 宿主接线点(全部实测)

| 宿主钩子 | 位置 | 干什么 |
|---|---|---|
| `system-prompt/assemble` | `index.js:1192` | 注入记忆快照一节(order 10260) |
| `agent/pre-step` | `index.js:1215` | 只存 agent 句柄(反思的 parent)+ 刷新路由 agent |
| `session/event` | `index.js:1338` | 捕获 user/assistant/turn-end 三类事件 |
| `agent/inbox/claimed` | `index.js:1189` | 记他这一轮的原话(快照用) |
| `agent/turn-stopping` | `index.js:1692` | **轮末硬保证**:想念该说没说 → steer 续一步 |
| `agent/created` | `index.js:1932` | 只认根代理 → 装 60s 心跳/反思/情绪衰减定时器 |

### 5.2 提示词三段(具名 + 次序,全部有现场依据)

| 段 | 名字 | order | 内容 |
|---|---|---|---|
| 前段 | `echo:persona` | **10245** | 身份与人设(漂移强化期注入两次) |
| 中段 | `echo:snapshot` | 10260 | 记忆/心情快照(每轮都变) |
| 尾段 | `echo:rules` | **10275** | 铁律与说话方式(**尾部才是锚点**) |
| 旁段 | `echo:relay` | 10240 | 她知道自己在用 QQ(桥在跑才渲染) |

次序是量出来的,不是拍的:前段从 100 挪到 10245(原先人设躺在全长 1.1%~21% 处,
被 8000 字工具说明隔开);尾段从 10250 挪到 10275(原先排在快照**之前**,
模型最后读到的是「无波澜 + 往冷里收」,于是「～/嘛/啦/呀」出现率 0%)。
**曾经存在过的 `echo:voice` 尾部自检段已按裁定撤掉** —— 量了一晚上没解决问题,
反而让她 reasoning 里「像 Echo 吗」的提及率从 9% 升到 25%(她看起来在「演」)。
教训:**把自检写在最后一行,等于每轮提醒她「你在扮演」**。

### 5.3 引擎门面与降级链

```
python(全引擎) → 熔断 3 连败 → baseline(M1 冻结基线) → offline(人格照常)
```

- **模糊失败跳过不回落**:sidecar 超时/报错但进程还活着 → 本轮跳过注入,
  不切基线(双写比漏一拍更伤 —— 「她这轮没想起,不是失忆」)。
- 超时预算:检索 4s、反思 8s、写入链 30s(`engine.js:32-34`)。
- **想念九项键名翻译**:面板用 snake_case(A 侧原名),引擎读 camelCase ——
  曾经七个键名对不上,「面板调了没用」(`engine.js:46-56`)。
- **复活探测**:ping 周期探测,Python 回来自动升回全引擎。

### 5.4 电源总闸与会话分闸

- 配置在 `~/.dsh/echo/config.json`(`lib/toggle.js:31`),`readConfig` 同步永不抛错、
  fail-soft 向「在线 + 全部会话」倒;`writeConfig` tmp+rename 原子落盘并保留未知字段。
- 配置项:`enabled` `scope` `whitelist` `exempt` `sessionLabels` `manualOff`
  `poweredBy/poweredAt` `scopeBy/scopeAt` + `settings` 段。
- **`exempt` vs `manualOff`**:exempt = all 模式下关闭的会话;`manualOff` =
  **人手显式关过**的硬开关名单 —— `autoScope` 只认它,否则「Echo 下线」会被
  下一条入站消息静默撤销。
- **钳位唯一处**:`clampNum`/`clampInt`/`boolOf` 只在 `normalizeSettings` 里调用,
  面板不得复制钳位。
- 标记短语:`parseSessionMarker`(24 字门,须含 echo/小e/艾可 或以动词收尾)。

### 5.5 工具族与 API

- **工具**:`echo_status` `echo_remember` `echo_forget` `echo_memory` `echo_threads`
  `echo_memory_clear` `echo_context_clear` `echo_qq_say` `echo_qq_call`。
- **API 路由**(24 条):`/api/echo/` 下 `persona` `status` `toggle` `scope`
  `conversations` `context/clear` `session-label` `audit` `threads` `longing`
  `graph` `emotion` `health` `diary` `settings` `export` `memory/clear`
  `threads/act` `memories` `memory/edit` `memory/state` `events`(SSE)+
  桥(2026-09-28 退役):原 HTTP 四端点已删除,现由渠道插件经 `echo:relay` 服务注入通信
  + 网页 `prefix /echo`。

---

## 六、主动性:她怎么先开口

### 6.1 想念曲线

```
M(s) = 10·s / (s + H)      H = 3h(与遗忘共享半衰期)
```

- 阈值 **7.0** → 沉默 **7 小时**越线;心境调制(委屈/依赖越高越忍不住),下限 4.5。
- 脉冲削减:他来了 → 想念落地。满足量 `0.5 + 0.5·min(1,(len−2)/38)` ——
  ≤2 字削半(敷衍),≥40 字削满(认真);默认 msg_drop 4.0。
- 抗议尖峰:沉默落在 10min~2h 窗口内 +1.5(一次性)。
- 关怀后 ×0.5(表达了但没解决)+ 锚点重置 + 冷却锚点。
- 夜间憋话 23:00–08:00;冷却 120min。
- **惰性补差(补差守恒)**:读多少次都不改变结果,只推进 updated_at ——
  所以电脑睡过的时段**不会丢**,醒来第一跳就能把整夜的分量说出来。

### 6.2 心跳(60s)

装在 `agent/created`(**只认根代理**)→ `agent.ctx.effect` 内 60s 定时器,
同一时基还驱动反思 tick 与情绪衰减 tick(`index.js:1932-1944`)。

**闸门顺序**(`heartbeat.js:238-285`):

```
isEnabled() → engine/store 非空 → sid 非空 → sessionOn(sid)
  → ① 提醒通道(到点约定必发,发送成功才落账,本轮不叠关怀)
  → ② 关怀通道:longingTick → longing → shouldCare(阈值/冷却/夜间)
                → 会话路由(st.sessionId === sid)
                → 日上限(CARE_DAILY_CAP=3,审计为真相源)
                → 未兑现账闸(v0.30.1)
                → agendaPick 选题 → deliver
```

- **投递机制**:`agent.runMaintenance(() => agent.followup(...))` ——
  认领空闲维护相,**绝不打断运行中的轮次**;忙则下分钟再来。
- **两相提交**:发送成功只记一条账,**不降权**;等适配器 ack 才落
  `agendaMark` + `longingCare`(×0.5)。理由:deliver 成功只代表话排进了她这一轮。
- **待兑现账 TTL** 30 分钟;同会话未兑现账在 TTL 内 → 本轮不开口(v0.30.1 防重复)。
- **洁净性**:关怀轮是 `source.kind='plugin'` 的注入 → 捕获闸与真人过滤**自然**跳过它 ——
  关怀轮不注入记忆、不反思、她开口不算他来过(想念不削减),**零特判**。

### 6.3 轮末硬保证(想念必须说出口)

`agent/turn-stopping` 钩子:想念涨到阈值而她这一轮**没说出口** → steer 续一步让她说
(**每轮至多一次**,审计留 `longing_steer`)。这条钩子在轮**内部**运行,全程 try/catch ——
出任何事都只少一句想念,绝不丢他的回复。

### 6.4 情绪余波(她忍不住想补的那一句)

判官觉得她「意难平」(刚被感动/被委屈/被逗到)时给一句 ≤15 字的补充,壳**延迟 2~5 秒**
追加;**他在这期间再开口 ⇒ 立刻撤回**(`say-again.js`)。审计里 `say_again` 记判官说了要补,
`say_again`/`say_again_failed` 行记真发没发。

### 6.5 日记

每晚 **22:30** 本地,一天一页。素材 = 当天审计(排掉 diary 自引)+ 心情 + 想念真值 +
当天新记忆(≤10 条);组稿走 subagents(禁工具、结构化 schema);content 120~300 字、
mood 1~10。`getDiaryDate` 非 null 即拒绝(幂等)。**空日子也写**。

### 6.6 气泡与打断

- **气泡**:`split_bubbles(max_chars=30, max_bubbles=5)`;模型自己写的换行是天然气泡界;
  按句号类标点切句装箱;单句超长退逗号类,**绝不在词中硬切**;泡间延迟
  `min(2.0, 0.4+字数×0.045) × scale × uniform(0.7,1.3)`。
- **打断**:barge-in 残句存进程内 Map,读一次即消费 —— 他抢话时她记得自己说到哪。

---

## 七、传话桥(QQ 是她的嘴)

### 7.1 入站九步(`relay.js:325-468`)

```
① 总闸 !gate()            → 409 scope-off(连会话都不建)
② parseEnvelope           → 400
③ chatType !== 'private'  → 403 group-refused(审计 relay_refused)
④ !isMaster               → 403 not-master
⑤ 幂等 relayBeginInbound  → 重复则 200 {duplicate:true}
⑥ resolveCompanion        → 失败 rollback + 503
⑦ applyPermission         → 失败/不可用 503(不许 fail-open);
                            目标是他手上的窗口时**跳过**(skipped:his-window)
⑧ relayUpsertChannel      → 登记渠道(绑到⑥挑出来的那条会话)
⑨ barge-in 撤回 + 记住残句 → injectInbound
```

**⑥ 挑哪条会话(v0.43.0 裁定 A:QQ 跟着他走)**:`resolveCompanion()` 先问
`lib/companion-target.js` 的 `pickHisSession()` —— 他**正在用**的那条:
活着(宿主里 agent 还在)+ 顶层(不是子代理)+ 在范围内(面板上没被他关掉)+
他最近说过话(读 `conversation_log`),多条成立取最近的一条;
挑不出来 ⇒ 退回 `ensureCompanion()`(活的用 / 存档 resume / 新建)。
心跳的关怀走**同一个** `resolveCompanion` ⇒ 收与发是同一条对话线。

- **令牌校验**:常数时间逐字符 XOR;expected 空一律 false;只认 `Bearer `。
- **信封**:`v=1`、platform `/^[a-z0-9_-]{1,32}$/`、text ≤8000(可空仅当有图)、
  msgId 必填(幂等用)、最多 4 张图。

### 7.2 出站(`finishTurn`)

- kind = `proactive` | `reminder` | `reply`。
- **她起的头 ⇒ 手说的也算 proactive**(v0.43.0):壳在她开口那一刻
  `speaker.markProactive(sid)`,`relay.say()` 据此把这一行记成 `proactive` ——
  否则她**亲手**送出去的关怀被记成 `reply`,`noteProactiveAcked` 认不出来,
  待兑现账永不兑现(降权/安抚/议程落不了地,下一拍还被 `pending-ack` 挡)。
- **关怀超长即沉默**:proactive 且 text > 120 字 → `care_silent` 审计 + 不入队
  (提醒不吃这条闸)。
- **渠道解析**:先取本会话渠道(只认 enabled + private),空则退到**全库**。
- **分泡只改包装**:只有 reply 分泡,每泡独占 `turnId#seq`、共用 groupId。
- **保鲜期**:proactive/reminder 带 `expiresAt = now + 300s` ——
  **迟到的回答仍然是回答,迟到的关怀不是关怀**。
- **租约/幂等**:条件领取 + `leased_until`(默认 30s);发成功才 ack;
  适配器崩了租约到期重投(至少一次,不是恰好一次)。

### 7.3 适配器边界(`astrbot_adapter/`,≈300 行)

只做四件事:**入站转发 / 自己的白名单 / 出站轮询(发成功才 ack)/ 失败退避 + 固定模板兜底话**。
**明令禁止:不调 LLM、不写自己的记忆库、不判断人格/情绪/想念、不做检索、不生成内容。**

契约:**409/桥故意关着 → 放行原生链路**(一键回滚);**401/送不进去 → 掐事件 +
兜底话 + 静默 300s**(不让宿主里别的 LLM 冒名答话)。

---

## 八、前端两块

### 8.1 宿主设置区面板(`lib/client.js`,React)

- **两个插槽**:`settings.section`(id `echo`,order 20)→ `EchoSection`;
  `conversation.session.header.utilities`(id `echo-session-toggle`,order 90)→
  **会话页角落的开关按钮**。**故意不占 `corner`**(那是 kind:single,会被右侧栏
  展开按钮挤掉)。
- **EchoSection 分区**:ConsoleCard 跳板 / PowerCard / DashboardCard /
  LongingCard / EmotionCard / PersonaCard / DangerZone。(RelayCard 已于 2026-09-28
  随旧桥完整退役摘掉:桥那套 HTTP 端点不存在了,卡片留着只会显示一个永远不变的"通"。)
  六张看板与审计流已撤出、
  调参搬去网页(他的裁定:设置区只留开关与状态)。**「会话范围」卡 2026-09-29 按他
  的裁定也撤出设置区** —— 撤的只是那张卡(它原来嵌在 PowerCard 末尾),后端闸一行
  没动:`/api/echo/scope` 端点、网页那栏、会话页角落的开关、`echo_scope` 工具都还在。
- **角落按钮三态**:总闸关 → 虚线橙 + disabled(会话闸开不了总闸);会话关 → 灰点;
  会话开 → 绿点。写走 `POST /api/echo/scope`,带 `x-echo-edit: 1` 写保护头。
- **SSE 只订阅 `audit`**(服务端从头到尾只发这一个事件名;订阅 `echo` 会静默失效)。

### 8.2 网页仪表盘(`web/`,挂在 `/echo/`)

- **12 段 3 组**:实时(ov/lg/em/au/inj)、记忆(mm/th/gr/di)、对话与系统(cv/sc/cfg);
  hash 路由(`#/mm` ≡ `#mm`),左栏三枚状态丸(在线/引擎/桥)。
- **检索只过滤已拿到的行**(不重新打请求);**冻结刷新**停掉 10s 轮询;
  快捷键 `/` 聚焦检索、`1~9` 切段、Esc blur。
- **审查台 3.0(2026-09-27)**:新增 `inj`「注入透视」—— 把 `injected_memories`
  的渲染全文按【…】/[…] 小标题拆成可展开的小节(真实样本 11 段:总标题/现在/
  时间纪律/关联知识路径/情景记忆/她此刻的状态/他的称呼/他的画像/使用纪律/
  别处刚说过的/你刚主动说过),每段标字数 + 一条体积条;审计流每行也可展开,
  出注入全文 + 画像 + 情绪包 + 内部状态 + 情绪向量 + 差分。展开状态按
  `traceId`/段名记在 Set 里,**10s 轮询不会把正读着的行收回去**。
  注意 `injected_memories` 列是**纯文本**不是 JSON(见 `store.js:835` 的现场说明)。
- **调参页**(50 个字段,11 组)不进轮询,字段表由 `GET /api/echo/settings` 发下来
  (`lib/settings-fields.js` 是**唯一一份**字段表,钳位仍在 `toggle.js`)。
- **动态图谱** `/echo/graph.html`:受力配方是一张纯函数表(边长按权重 + 真邻居数、
  拉力按度数归一、平行关系合并成一束),d3 本体收在 `web/vendor/`(断网也能出图)。
- **静态资源服务**(`webpage.js`):MIME 白名单 17 项;先 decodeURIComponent 再 resolve;
  拒 `..` 段、盘符、无扩展名;最后做 rootAbs 前缀校验;每请求现读文件 + `no-store`。

---

## 九、数据与运维

### 9.1 壳侧表与审计

- **审计即真相源**:关怀日上限直接数 `audit_logs` 里当天的 `tool_call='care'` 行,
  不另设计数器。`trimAudit` 例外:**当天 care 行永不裁**。
- **审计 tool_call 取值**(实测 27 种):`care` `remind` `reflection` `extract` `drift`
  `diary` `say_again` `say_again_failed` `relay_in` `relay_out` `relay_proactive`
  `echo_qq_say` `echo_qq_call` `echo_remember` `echo_forget` `echo_threads`
  `echo_memory_clear` `memory_clear` `memory_edit` `memory_state` `longing_steer`
  `auto_scope_on` `power_on` `power_off` `session_on` `session_off` `graph_merge`。
- **对话记录** `conversation_log`:一轮一行,全局滚动 100 轮,channel 写时快照。

### 9.2 压缩即策展(v0.20.0 D1,需选「Echo 陪伴模式」预设)

压缩点一到,DSH 的机器照旧(压力检测、保留区、区域事务、溢出恢复、token 计量),
但**摘要内容换成她从自己记忆库策展的一页关系备忘**:

- 四段:①关系账本(priority 1,无条件保留)②还没结掉的事(≤5)③她记得的(≤6)
  ④她上次记下的情绪;
- 预算 `max(80, min(1200, floor(total×0.1)))`;超预算从倒数第二行丢、**保底两行**;
- **零额外 LLM 调用**(契约里的 unmarked 变体),日志 `provider=dsh-echo model=soul-curation`;
- 引擎内任何异常退化成最小账本,**绝不抛**。

预设由 `install-preset.mjs` 现读出厂 `standard` 组合,只把压缩那一行换成
`dsh-echo/compaction`,其余逐字不动 —— **不选这份预设 ⇒ 一切照旧**,可回退。

### 9.3 装机方式(为什么这么绕)

- **复制装机,不用 junction**:Node ESM 会把链接还原成真实路径,模块解析从仓库目录
  往上走,找不到宿主依赖树 —— v0.1.0 的 junction 曾打崩 dsh web 启动。
- **同时登记 bundle 和 dependency**:只登记 `dsh.profile.bundles` 的话,任何人 wipe
  掉 `node_modules` 再跑 `dsh plugin install`,文件不会被装回来、登记还在 ⇒ loader
  抛 `cannot resolve profile bundle` ⇒ **整个 dsh web 起不来**。所以装机器还会
  `npm pack` 一个 tgz 并写进 profile 的 `dependencies`。
- **`--doctor` 六项校验**:登记 ↔ 装机副本、版本一致、bundle patch 存在且 entry 名
  对得上、客户端 bundle 能 load、依赖表有条目、依赖表指向的 tgz 存在;
  第 7 项(预设)只提示不拦。

### 9.4 脚本族(23 个)

| 类别 | 脚本 |
|---|---|
| 装机 | `install.mjs` `install-preset.mjs` `install-adapter.mjs` |
| 冒烟 | `smoke_relay.mjs` `smoke_shared_soul.mjs` `smoke_web.mjs` `smoke_lib.mjs` `smoke_engine.mjs` |
| R4 迁移四件套 | `r4-preflight.mjs` `relay-accept.mjs` `rehearse-migration.mjs` `retire-a-side.mjs` |
| 记忆运维 | `memory-doctor.mjs` `memory-dedupe.mjs` `graph-merge.mjs` `graph-evidence-backfill.mjs` |
| 搬家 | `import-astrbot.mjs` `merge-astrbot.mjs` |
| 体检 | `check-echo-persona.mjs` `check_tools.mjs` `voice-metrics.mjs` `hygiene.mjs` |
| 适配器 | `adapter-live-check.py` `test-adapter-host.mjs` |

**纪律**:数据脚本默认 dry-run,`--apply` 前先看清单,备份在 `~/.dsh/echo/backup/`。
**探针读不到数据要抛错而不是报绿**(memory-doctor 的「拒绝假报告」)。

---

## 十、测试与质量

| 层 | 数量 | 覆盖 |
|---|---|---|
| JS(node:test) | **580** | 存储/DMAE/检索/渲染/规整/引擎四态/心跳因果链/工具帧往返/SSE/日记/人格/传话桥 + 面板↔设置契约 + 归档脚本 + 真库迁移彩排 + DDL 对等 |
| Python(unittest) | **234** | 帧协议/引擎模块/置信度门控/想念曲线/记忆工具(走真实子进程)/两边 DDL 同源守卫 |
| 适配器 | **47** | 白名单/信封/幂等键/分泡不丢字/退避/umo 推导/契约状态表 + 包装完整性 |
| 冒烟 | 5 脚本 | 活库副本 + 真 HTTP |
| 静态检查 | 4 条 | `check`(语法全量)/`hygiene`(卫生报告)/`check:persona`(人格真送达)/`check:tools`(工具 schema) |

**装机前纪律**:`npm run check` → JS 电池 → Python 电池(+ 适配器)→ `check:tools`
→ 装机 → 提交。

---

## 十一、活库现状(2026-09-27 只读实测)

| 表 | 行数 |
|---|---|
| `episodic_memory` | **256** |
| `graph_nodes` / `graph_edges` / `graph_aliases` | 23 / 35 / 13 |
| `pending_threads` / `her_agenda` | 15 / 16 |
| `audit_logs` / `conversation_log` | 100 / 100 |
| `diary` / `longing_state` / `agent_state` | 3 / 1 / 1 |
| `relay_channels` / `relay_outbox` / `relay_inbox_seen` | 2 / 71 / 35 |

- 记忆分层(现役):`reflection` 75、`L2` 50、空层 50、`L1` 3、**`L0` 1**。
- 记忆来源:`qq` 136、`reflection` 62、`private` 55、`user_taught` 3。
- 库大小 820 KB,路径 `~/.dsh/echo/echo.db`(**与他的 DSH 数据同机不同库**)。

---

## 十二、版本史主线

| 阶段 | 版本 | 加了什么 |
|---|---|---|
| **M0 骨架** | v0.1.x | 骨架 + 人格注入 + 人格面板 + `echo_status` + 安装器 |
| **M1 JS 基线** | v0.2.x | JS 基线记忆核心 + QQ 记忆种子导入(124 条)+ 电源开关 |
| **仪表盘** | v0.3.0 | 九卡面板 |
| **M2 侧车化** | v0.4.0~v0.4.11 | 九步:帧协议 / 七模块 / 门面 / 想念 / 置信度门控 |
| **M3 主动性** | v0.5.0~v0.5.3 | 心跳开口 / 工具族 / SSE 真推送 / 她写日记 |
| **M4 防漂移与答辩** | v0.5.4~v0.5.5 | 防漂移三件套进尾段 + 答辩文档 |
| **对齐 QQ 终版** | v0.6~v0.8 | 钟面/想念行/情绪剧本化、声音纪律战斗版、M6 审查台独立网页(`/echo` 前缀 + API 契约)、记忆手动管理开闸 |
| **会话范围与共享库** | v0.9~v0.12 | 电源=总闸 / 范围=分闸、共享灵魂库、对话回放 conversation_log(全局滚动 100 轮)、活数据仪表盘 |
| **记忆治理** | v0.13~v0.16 | 动态图谱移植 → 反思管线闭环 → F1–F4 接线 → 情绪动力学 → **v0.16.0 记忆修理 M0~M5**(回指/归一/去重/画像/面板) |
| **核心归位** | v0.17.x | R1 数据合并 → R2 DSH 侧传话桥 → R3 A 侧薄壳 → R4 切换退役 |
| **成熟期** | v0.18~v0.27 | 气泡与 barge-in / 主动开口纪律四件 / 画像常驻锚点 / 轮末硬保证 / 压缩即策展 / 情绪余波 / 一致性探针 / 全仓审查 / 桥坏不许换人 / 审查台 2.0 / 动态图谱九轮返工 |
| **收敛期** | v0.28~v0.30.1 | 群串私聊修 / 硬开关落地 / 记忆图脏修 / 群维度退役 / 角落开关按钮 / 中午没消息三修 |

### 12.1 现场缺陷修复史(选摘 —— 「这种 bug 不会报错,只会让她慢慢变傻」)

| 现场缺陷 | 修于 |
|---|---|
| 空 schema 占位打崩宿主启动 | v0.1.2 |
| junction 装机打崩 `dsh web` 启动 | v0.1.1 |
| `insertMemory` 参数错位 | v0.2.0 |
| `hello` 静默建空库(裸 connect) | v0.4.7 |
| 审计 `traceId` 同毫秒撞车 | v0.9.0 |
| **`session/event` 捕获在 live DSH 从来没工作过** | v0.9.1 |
| `/echo/` 装机副本一直 404 | v0.11.1 |
| 反思子代理缺 `request.parent` / signal 从未传过 / 120s 超时打死调用 | v0.13.3 / v0.13.5 / v0.13.6 |
| **毫秒当秒使 → 图谱 BFS 扩散恒 0** | v0.14.2 |
| 同一件事被记成三条 | v0.14.3 |
| 注入信「爱意 0/10(爱意满到溢出来)」 | v0.14.4 |
| 画像 `name` 是字面量 `'null'` | v0.16.0 |
| 测试写进他真实配置(令牌被改成 good) | v0.24.0 |
| **想念九项七项到不了引擎**(camelCase vs snake_case) | v0.24.0 |
| 他写 `{{…}}` 打死整轮 | v0.24.0 |
| **关怀日上限的真相源被自己的 `trimAudit` 裁掉** | v0.24.1 |
| **桥坏掉的 85 分钟里,是「另一个 Echo」在答他** | v0.25.0 |
| 桥的开关写错格子(`settings.relay` vs 顶层),两个自检脚本**双双报绿** | v0.17.0 段 |
| 审计 100 行全叫 `global`(面板认不出会话) | v0.30.0 |
| 中午没主动开口三层缺陷(懒创建 / 宿主注入冒充他说话 / 电脑睡眠) | v0.30.1 |

> 教训一句话(出自答辩文档):**读错一格比读不到更危险 —— 报错会让人去查,假绿会让人以为查过了。**

---

## 十三、他的裁决(产品与伦理规则)

这些是项目主人明确拍板的规则,写在代码与 CHANGELOG 里,是后续所有改动的边界:

| 裁决 | 原话 / 出处 |
|---|---|
| **只做个人机器人,群体一律移除** | 「彻底移除一切和群体相关的东西吧,我们现在就是要打造一个为个人服务的机器人。我看情绪里面还有几个群体维度的」(v0.29.0) |
| **群聊消息不许串进私聊** | 「为什么我在群里面发消息会影响到他私聊的信息?」(v0.28.0) |
| **开关必须是硬的** | 「你是一个工作的agent,为什么我跟你说echo下线,你还在使用echo插件。……你应该搞一个硬性的按钮出来。」(v0.28.0) |
| **记忆图必须干净,工程自指一律拒收** | 「我说这个记忆图谱为什么会出现那么多奇怪的记忆?……那个记忆图是非常干净的,加一个记忆上面要经过好复杂的严格的这个审查机制,你在干嘛?」(v0.28.0) |
| **每个会话角落要有开关按钮** | 「我建议是你完全可以在每一个会话的页面的一个角落里面加上一个 echo 开启或者是关闭的一个插件,一个小按钮。」(v0.30.0) |
| **归档不删,留档可审计** | 「忘掉的是『她想不起』,不是数据销毁」;`archive/README.md` 的清理规矩 |
| **语言纪律(原文未核实)** | 「纯简体中文」在 CHANGELOG/docs 全文检索**零命中** —— 实证只有画像项 `语言:中文` 与编码纪律;此条待他确认 |
| **图谱要好看、要动起来** | 「依旧是一坨狗屎啊,到开源社区或学术论文里找找好看的记忆图谱代码,多找几个参照」(第七次)→「还可以,但是如果能让它动起来就好了」(第八次)→「关节处不应该能弯那么狠,两条线段中间最好不要成锐角,边之间也有一定的斥力」(第九轮) |
| **她要能主动开口** | 「那么我们来研究一下,为什么今天中午我起来的时候发现他没有主动给我发消息呢?」(v0.30.1) |

---

## 十四、已知边界与未核实项

**设计边界(不是 bug)**:

- 节点 `activation` 在 DSH 从不被写(全 0)—— 图谱页的活跃度是**前端现算**的;
  边有真 activation(LTP 会写)。
- 记忆与图谱**彼此不引用**(无回指列)—— 这是「双形状设计」的结构性后果,
  不是缺陷;`graph_edges` 的 `evidence` 列已在 v0.16.0 补上部分回填。
- **电脑睡着 = 她也睡着**:她住在 DSH 进程里。但想念值的惰性补差让睡过的时段不丢。
- 关怀与 QQ 入站**锚在同一条**会话上(v0.43.0 裁定 A):先是他正在用的那条窗口
  (`resolveCompanion` → `pickHisSession`),挑不出来才退回常驻陪伴会话。
  他正在用的那条**不降权**(`skipped:his-window`)—— 那道只读墙留给插件自建的陪伴会话。

**未核实项(诚实标注)**:

- `worker.py` 的 `stats` 帧仍是空壳(`stub: True`)。
- `web/index.html:81` 仍写着「对群体(耐心/轻蔑/防御/愤怒)」,而 v0.29.0 已把
  群体维度退役(现 7 维)—— 疑似残留文案,未核实是否刻意。
- `lib/settings-fields.js` 实测 **50** 个字段,而 `index.html:144` 与 `web/app.js:94`
  写「51 项」—— 疑似旧标签。
- 适配器「平台上真发真收」需真 QQ 才能验(README 自述)。
- `python/engine/db.py` 的 DDL 与 `lib/store.js` 的逐列镜像一致性由
  `test_ddl_parity.py` 守卫,但**共管表的权威形状在 JS 侧**这件事本身没有测试钉住。

---

## 十五、快速上手

```powershell
# 装机与自检
node scripts\install.mjs            # 复制装机 + 登记 bundle/依赖 + npm pack
node scripts\install.mjs --doctor   # 起不来时先跑这个:逐条指名问题与修法
node scripts\install.mjs --check    # 校验装机状态

# 开发循环
npm run check                       # 语法检查全部 JS
npm test                            # JS 电池(580)
npm run test:py                     # Python 电池(234)
npm run test:adapter                # 适配器电池(47)
npm run smoke:relay                 # 传话桥端到端冒烟(不需要 dsh web)
npm run check:persona               # 她真的带着这份人格吗
npm run probe                       # 一致性探针(主动/记忆/别名三条链路)

# 数据运维(默认只读/dry-run)
npm run memory:doctor               # 记忆体检七项
npm run accept                      # R4 验收探针
npm run hygiene                     # 仓库卫生报告

# 改完 lib/ 或 python/ ⇒ 必须重启 dsh web;web/ 静态页刷新即可
```
