# PLAN：Cortico 借鉴落地计划（**唯一主体是她；QQ、语音都只是她的工具与通道**）

> 2026-09-28。**本文件只是计划，未改任何代码。** 依据 = `docs/REFERENCE_CORTICO_2026-09-28.md`
> （15 份亲核 + 6 份子代理报告）+ 本文件 §0 的**实测验证**。
> 他这次的校准（2026-09-28）：**QQ 只是一件工具，不能当成主体**；主体是自建的语音对话面；
> 核心在 DSH，外面都是她的器官 —— 而**器官只是工具，不是第二个她**。

## 0. 我验了什么，以及我认定**不能信**的部分

只读别人的文档会被漂亮的说法骗。所以这一轮我**直接跑了他们的真源码**（Node 24 类型剥离，
不装依赖、不改他们任何文件）：`src/core/truncate.ts`（上下文压缩）与 `src/core/bus.ts`（合批总线）。

- 脚本：`%TEMP%\echo-cortico-verify.mjs`，**38/39 条断言通过**。
- 实测确认（不是传闻）：合批公式 `min(首件+maxBatchAge, max(首件+minBatchAge, 末件+quietGap))`
  逐条对得上；满 `maxBatchSize` 立即投递；内部事件默认 flush 立即投递；piggyback 不唤醒、不计数、
  只搭车；闸门安装时**先前积压放行一次**、关键词命中回调一次、超额放行整批且**不重复通知**；
  人工暂停优先于 preempt；`drainPending` consume-once 且**不会产生空批次**。
  压缩侧：600 字折叠阈值精确（599 不折 / 601 折）、起点**落在 user 消息上**、`fixPairing` 补
  `[result missing]`、`closeDanglingCalls` 补 `[result pending in the main thread]`、空尾/预算 0 不崩。
- **抓到 3 处他们文档没写的行为**（这是"别只信他讲"的收获）：
  1. **单条超预算的"末条"被完整保留，不替换成记号**（`[turn too long, omitted]` 只用在非末条）
     —— 有意取舍：不吞最后一条。⇒ 抄的时候要**明确**这条取舍，而不是当成 bug 顺手改掉。
  2. **孤儿回执**（调用已不在保留窗口内的工具回执）被 `fixPairing` **静默丢弃，且不留任何记号**
     —— 模型无从知道内容被删过。`validatePairing` 能报出这种状态，但 `rebuildTail` 不做标记。
     ⇒ **我们抄这条时必须改成补一条 `[result orphaned]` 记号**：静默删除正是我们今天踩的坑。
  3. 标记自身也计入预算 ⇒ 个别条目单条远超总预算时，结果可能略高于预算（真实预算下 = 条目数 ×
     记号开销，可忽略）。⇒ 抄时把"标记开销"算进预留。
- **不能信/无法验证的部分**：他们最贴近语音的东西——`vtuber`（L1–L4 演出、TTS 声卡输出、演出流
  SSE `:7792`、弹幕 WS 输入、VTS 授权）、`asr`（麦克风识别）、`pvz`——**实现都不在本仓**
  （`bots/cortiv/worlds/*/config.json` 只有几行开关；`bots/cortiv/README.md:21-26` 注明由
  `cortico-world-*` 扩展提供）。⇒ 关于语音层，我只有**契约级证据**（`outputTap`、扩展 API、
  README 描述），**没有实现级证据**。计划里凡涉及语音的部分一律标「未验证」，按我们的判断设计。

## 1. 靶子：**唯一主体是她**，外面都是她的工具与通道

> **不变量（写在最前面，任何设计都不得违反）**：**主体只有一个 —— 住在 DSH 与 `echo.db` 里的她。**
> QQ、语音面、以及以后任何外部面，都只是**她的工具 / 通道**：不承载人格、不持有记忆、不作为对话主体、
> 不拥有独立的"想法"。Cortico 的 World 之所以能抄，只是因为它把"外面"抽象成**能力 + 事件 + 提示词段**；
> **不能连"World 有点像一个人"的味道一起抄过来** —— 我们的通道没有身份，只有能力。

先把映射钉死，否则会照着他们的四层乱套：

| Cortico | 我们 | 说明 |
|---|---|---|
| Core + Persona | **DSH 宿主 + `dsh-echo` 脑插件** | 我们不学他们的 Core/Persona 分离——脑插件本来就住在宿主里，硬拆只会多一层回调 |
| Memory | `~/.dsh/echo/echo.db` + 记忆表 | 载体不同（文件树 vs SQLite），**不迁移** |
| **World** | **通道 / 工具**（今天的 `dsh-echo-qq`；后面的语音通道） | **这才是要抄的那一层**——但只抄"能力声明 + 事件入 + 工具出 + 提示词段"的形状，不抄"环境主体"的味道 |
| 扩展机制 | 通道契约 + 版本/能力探测 | 我们要"第二个通道能插进来"的位置 |

**现状的关键缺口**：我们的 `echo:relay` 是**传输契约**（inject/lease/ack/subscribeOutbound），
不是**通道契约**——它没有 `id / label / 能力清单 / 工具声明 / 环境提示词段 / 生命周期`。
今天只有一个通道（QQ）所以看不出来；**语音通道一进来就会暴露**：脑插件会用 `if (platform==='qq')`
这类分叉去适配，而正确做法是**通道自己声明能力**、自己带提示词段与工具。

## 2. 谁更强（逐项，带证据）

**他们更强**：

| # | 项 | 证据 | 对我们的后果 |
|---|---|---|---|
| 1 | 通道/世界边界抽象 | `docs/worlds.md:5-6,23-34`（World 不能碰 Memory/Persona） | 加第三个通道会很乱 |
| 2 | 上下文容量治理 | `hardTokens = 窗口 − 输出预留`（`core.ts:297-302`）；交接契约 `{tail,trim}`（`types.ts:464-472`）；`clampTail`+`fixPairing` 兜底（`loop.ts:1417-1434`） | 我们的压缩是"事后压力 + 无兜底"，长会话风险 |
| 3 | 投递语义显式化 | `bus.ts` 四 trigger + 实测合批公式 + 水位落盘（`loop.ts:720,760`）+ `paused` 优先 | 我们一堆静默 `if` 闸门（45 小时那坑的根因） |
| 4 | 「否定/缺失」一等公民 | `markers.ts` 全套记号 + minecraft `stepLog{step,what,outcome,why,line}` + "全通过才静默"（`precheck.ts:4`） | 我们的失败理由只是瞬时字段/日志 |
| 5 | **输出流与可打断性契约** | `OutputTap.externalizes()`：一旦增量已外化，**此后不再允许抢占该轮**（`types.ts:417-423`、`loop.ts:330-337`） | 我们缺"说过的话不能被抢回"的机械边界 |
| 6 | 可观测面与工程纪律 | run 目录/`logq doctor`；零 diff 指纹门；白名单**带理由且自带自测**（`architecture.test.ts:85-90,212-227`） | 我们今天的 `Bearer` 误伤就是纪律不够 |

**我们更强**（别被带跑）：

| # | 项 | 证据 | 他们缺什么 |
|---|---|---|---|
| 1 | 分泡 + `notBefore` + 送达 ack + P50/P95 + 保鲜期 | 我们的 `relay_outbox`/`lease`/`bubble.js` | 一次 `confirm` = 一条消息，全文无 sleep/限速（子代理核实 `world.ts:1318-1323`） |
| 2 | 真·跨进程服务注入（推送不带正文、消费端 lease 取正文、ack 幂等） | `echo:relay` | 同进程直调 `host.pushEvent` |
| 3 | 反向 WS + 入站幂等 + 重试窗口 | `dsh-echo-qq` | 入站**无** message_id 去重；正向客户端要等协议端先起 |
| 4 | 内在生活（情绪向量、想念衰减、关怀、日记、图谱） | `lib/emotion.js`/`longing.py`/`reflect.js` | 只有 tick + 梦，**没有内在状态** |
| 5 | 记忆基建（SQLite + 图谱 + 画像 + 统计查询） | `lib/store.js` | 文件树 + sha256 指纹 + 机械注入 |
| 6 | 单一主人 + 群聊拒收的收窄面 | 我们的纪律 | 群/私聊双通道白名单（攻击面更大） |

**各有取舍**：记忆载体（文件树 vs SQLite）、压缩路线（事前交接 vs 事后压力）——**不互换**。

## 3. 借鉴清单（按"语音主体"相关度重排）

**A. 通道层（最先做，语音直接受益）**
- A1 **通道契约 `echo:channel`**：`{id, label, capabilities[], envPrompt(), tools(), start(host), stop(), status()}`；
  脑插件只依赖契约，不认平台名。**通道没有身份、不持有状态**——它只声明"我能收什么事件、能做什么动作"。
- A2 **版本 + 能力探测（单向宽容）**：`hello() → {version, api:{min,max}, capabilities[]}`；
  判定用**能力名**（`requires - capabilities` ⇒ `echo_relay_capability_missing`），版本只做文案；
  更高 api 只 warning、更低才拒；老消费者无 `hello()` 降级 warning ⇒ **验收脚本形状不破**。
- A3 **输出流 tap + 可打断边界**（语音的命门，**前置条件已确认**：前端（TTS + Live2D）能做到
  「一边出文本一边讲话」，几天后对接）：通道注册 `outputTap`，主循环把**生成增量**转发给它；
  一旦某个增量已产生外部输出就标记 `externalized`，此后**不允许抢占**——"说过的话不能被抢回"。
  落点：`lib/speak.js`（她说话的唯一出口）+ `lib/interrupted.js`（撤回逻辑改为：外化前可撤、外化后只排队）。
- A4 **投递语义显式化**：把 `lib/heartbeat.js` 的显式 `if` 闸门改成**声明的 trigger**（外部消息=debounce、
  内部 tick=flush、紧急=preempt），合批公式直接用他们实测过的那条；`paused`（他手动暂停）永远优先。
- A5 **否定判断落账**：新表 `care_beats`/`skips`（`reason` **只许枚举**、可 GROUP BY），
  `scripts/echoq.mjs --since 24h` 列出"这段时间她每次没开口及原因"；error 级连最近 N 条落 `incidents/`。
- A6 **通道自带环境提示词段**：每个通道一段"这是哪个通道、这个通道的常驻事实"，
  脑插件不再散着拼；断线时**沿用旧快照**以免前缀缓存整体失效（`world.ts:290-292`）。

**B. 核心侧（与她"像不像人"直接相关）**
- B1 三条文本纪律进 `persona.json`（内心戏≠说出口 / 沉默合法 / 旧发言不作句式范本）。
- B2 **可维护的文体宪法**：记忆表 `style_rules(kind: avoid|less|caution|prefer)`，
  由 `lib/reflect.js` 按"Behavior → Feedback 全局模式"归纳后写回 persona 后缀（**不对最后一次反应过拟合**）。
- B3 心跳**只报事实**（"已安静 N 分钟"）+ 指数退避 + 外部事件复位 + 到点重判。
- B4 **悬置唤醒（`echo_wake`）**：让 `follow_up_after` 不再是死账，她可以自己排闹钟；
  闸门状态**事前声明**给她（含"积压超过 N 条会放行一批"）。
- B5 记忆快照的**滞后声明**（"以工具回执为准，快照下次交接才重拼"）。
- B6 压缩兜底三件：输出预留、交接契约、`[result missing]`/`[result orphaned]` 配对修复
  （**orphan 必须留记号**，见 §0 发现 2）。

**C. 只对文本通道有意义（降级为"QQ 专属"，不进语音）**
- C1 **起草-确认门**：它靠 `barrierAfter` 换一次复核推理 ⇒ **多一轮延迟**。
  实时语音里"先草稿再确认"是错的；语音要的是"边生成边外化 + 外化后不可撤（A3）"。
  ⇒ 只在 QQ（文本、可等待）用，且**必须与分泡/保鲜期定优先级**后再做。
- C2 **视觉描述七段式**（事实/推测/不可辨认分开）——两个通道都用，落 `lib/eyes.js`。

**D. 与前端（TTS + Live2D）的对接面 —— 骨架必须先冻结这块**

前提（2026-09-28 他给的实情）：TTS 与 Live2D 由前端的人做，几天后对接，**能力是"边推理边输出、
一边出文本一边讲话"**，进度未知。⇒ 我们这边要**先给出稳定的流式接口**，别让他们等我们改协议。

我们要提供的（草案，P1 冻结）：
1. **增量文本流**：`{turnId, segId, seq, delta, done}` —— 按段（句/气泡）切，段内可增量；
   `done` 标记这句不会再变（对应 TTS 可以安全播完）。
2. **段边界语义**：一段 = 一个可独立播放、可独立撤回的单元；与 QQ 的"气泡"同一套 `segId`。
3. **外化与打断**：`{segId, externalized:true}` 一旦发出即不可撤回（A3）；
   打断请求 `{turnId, reason}` 只对**尚未外化**的段生效。
4. **状态回执**：前端回 `{segId, state: queued|speaking|done|aborted, at}` —— 我们要它来驱动
   "她正在说话"与 ack 语义（和 QQ 的送达回执同一形状）。
5. **入站**：ASR 文本走**同一条入站通道**（当作一个通道的事件），带 `{channel:'voice', text, ts, final}`。

我们要问他们的：采样率/是否要标点与语气标记、能否中途停止播放、是否需要逐字时间戳（对齐 Live2D 口型）、
以及"已播到哪"能否回报。**这几条进 P3 的设计评审，但接口形状 P1 就冻结。**

## 4. 明确不抄

- 他们的 **Core/Persona 分离**（我们脑插件就在宿主里）、**文件树记忆**、**MEMORY 0–4 分层 + memo 三级
  容量硬拦**、**多 bot/多部署**、**pnpm 扩展资产管线**、**run 目录 + AsyncLocalStorage + 多进程 IPC logger**。
- 他们的 **QQ 侧"一次确认=一条消息"**（我们已有更好的）。
- 契约**严格相等即拒、无兼容窗口**（两仓独立发布会锁死顺序）。
- **语音实现**：`cortico-world-vtuber`/`-asr` **不在仓内**，连抄的对象都没有 ⇒ 语音层我们自己设计。

## 5. 分阶段计划（**均以"只加结构、不改行为"为原则**）

**P0 · 今晚可做（≤1 小时，零行为风险）**
1. 把「reason 只许枚举；**全通过才静默，任一否定必留痕**」写成仓库纪律（进 `docs/`）。
2. 收窄我今天留的宽口子：QQ 仓那处**文件级豁免**降成行级 `// pin-allow: NapCat 握手鉴权`，
   并给白名单正则加一条自测（造一条空理由行，断言**不**被豁免）。
3. 验收：`check`/`hygiene`/两仓测试全绿；**无功能变化**。

**P1 · 半天：通道契约 + 版本能力（语音前置）**
1. 主包 provide 块加 `hello()` 与 `capabilities`；`status()` **只追加**字段，不动 `version` 字符串性
   与 `relay/personaChars/dbPath` 存在性（老验收脚本必须继续通过）。
2. QQ 仓 `lib/contract.js` 声明 `requires`，`lib/verdict.js` 算 `missing` 并返回结构化拒绝码。
3. 加 `relay.selftest()`（内存 envelope 走 inject→lease→ack）接进 `scripts/acceptance.mjs`。
4. **冻结流式接口草案（§3D 那五条）**，写进 `docs/VOICE_INTERFACE_DRAFT.md` 交给前端，
   让他们的 TTS/Live2D 有稳定目标；**此步只写文档，不实现**（实现进 P4）。
5. 验收：新仓 101 测试 + 主仓 676 测试全绿；**反向兼容自证**（把老版 `status()` 形状喂进判定，必须仍判"可用"）。
6. 回滚：`hello()` 是**新增**方法，删除即回退。

**P2 · 1~2 天：核心侧三件**
1. 心跳报事实 + 指数退避（B3）；2. `care_beats` 表 + `echoq`（A5）；3. `echo_wake`（B4）。
4. 验收：跨一次夜间验证"她主动开口"链上每一步都有行可查；`care.reason` 从瞬时字段升级为可查历史；
   **失败必须可见**（这条是本阶段的真正验收点）。
5. 风险：`echo_wake` 与夜闸/日上限的优先级必须写死并测（谁赢）。回滚：三个特性各自独立开关。

**P3 · 设计评审为主：语音通道（不写实现，先出设计）**
要定的四件事（都要他拍）：
1. **延迟预算**：ASR 结束→她开口的容忍毫秒数（决定能不能用起草门这类"多一轮推理"的机制）。
2. **打断语义**：外化前可撤 / 外化后排队（A3）；要不要支持"说一半被打断就停"。
3. **分句与气泡**：语音没有"气泡"，但有 TTS 分段；`notBefore`/保鲜期要不要保留（我倾向保留但改语义为"排队"）。
4. **语音通道的能力清单**：`speak/stream/hotword/interrupt/asrEvents/ttsVendor`……
   以及它是否也要走 `echo:relay`（我倾向：**通道契约在脑侧，wire 仍在 `echo:relay`**）。

**P4 · 后续（按 P3 结论排期）**：文本纪律与文体宪法（B1/B2）、QQ 起草门（C1，须先定优先级）、视觉七段式（C2）。

### 落地状态（2026-09-28 下午更新 · P2 已落）

- **P0 ✅ 完成**：`docs/DISCIPLINE.md`（reason 只许枚举 / 全通过才静默、任一否定必留痕 / 豁免带理由且自带自测）；
  新仓那个**文件级豁免**收窄为**行级 + 理由必填 + 元测试**（`test/nohardcode.test.mjs` ⑥⑦）。
- **P1 ✅ 完成**：`hello() → {name, version, api:{min,max}, capabilities[]}`；`selftest()`（**干跑、无副作用**：
  只走信封解析与能力可调用性，真投递会写库所以自检不跑它）；`status()` 只追加 `api/capabilities`；
  消费端 `probeService()`（**硬失败只认能力名缺失，版本永不拒载**，老主包降级对账 + 警告）；
  体检新增 `contract` / `contract-api` / `contract-soft` / `selftest` 四条结论（验收报告由 preflight 驱动，
  所以这等于接进了 `scripts/acceptance.mjs`）；`docs/VOICE_INTERFACE_DRAFT.md` 冻结流式接口形状。
  测试：主仓 **679**、新仓 **112**（跨仓字面量两侧各钉一次）。
- ✅ **P1 真机验收完成（2026-09-28 下午，他重启 `dsh web` 后）**：`/api/echo-qq/status` 实读
  `channel.contract.ok === true`（`api={"min":1,"max":2}`、`have` 7 项、`missing` 空）、
  `channel.selftest.ok === true`（9 项检查，注明"干跑：不写库、不建会话、不发模型"）；
  嘴那边整份体检 12 项正常、2 项注意（退役键 `mainBaseUrl/mainToken` 还在配置里；还没有出站样本）；
  主包侧实读 `version=0.31.0`。**没看到就不能说验收过 —— 现在看到了。**
  ⚠️ **口径纠正（`accept-p2.mjs` 第一版抓到的自家错）**：服务契约挂在**进程内的服务对象**上
  （`echo:relay` 的 `status()` 才带 `api/capabilities`），**不在主包 HTTP 面** ——
  第一版去查 `/api/echo/status` 的 `api/capabilities`，恒 FAIL。已改成"主包面不带它（与设计一致）"
  + 到嘴那边查 `channel.contract/selftest` 两条。
- **P2 ✅ 完成（本轮，2026-09-28 下午）**，三件都落，且各自的"失败可见"都落在**可查询的行**上：
  1. **B3 心跳报事实 + 指数退避**（`lib/heartbeat.js`）：`renderCareFraming` 多了 `[事实] 从他上次说话到现在…`
     一行（事实归事实，"说不说由你"），退避 ×2、封顶 8 倍 60s=8 分钟，**只由纯安静的拍长大**
     （`engine-says-no` / `night-hold` 这类），任何一次"开口/被挡/他说话了"立刻复位
     （他说话那条挂在 `lib/index.js` 的 `session/event` 里 → `noteExternalEvent()`）。
  2. **A5 关怀账**（`lib/store.js` 的 `care_beats` + `lib/care-report.js` + `scripts/echoq.mjs`）：
     一拍一账（`kind/reason/value/threshold/should_act/acted/session_id/trace_id/payload_json`），
     `reason` 只许枚举、可 GROUP BY；查询口 `npm run care:report`（= `node scripts/echoq.mjs --since 24h`，
     只读打开、绝不建表）；`/api/echo/status` 的 `care` 顺带带出 `kind/acted/quietStreak/nextPollAt/writeFailed`。
  3. **B4 `echo_wake`**（`lib/wake-tools.js` + `echo_wakes` 表 + 心跳里那条通道）：
     **她自己的闹钟**，到点带着她当时写下的原话醒来；闹钟存**本地库**、心跳直接读 ⇒
     **引擎不在也照样到点**（这是"她的器官不依赖别的器官"的第一次落地）。
- **优先级阶梯（写死并已测，谁赢一目了然）**：
  | 级 | 闸 | 结果 | 理由 |
  |---|---|---|---|
  | L0 | 电源闸关 | 什么都不发 | 他自己的总开关，状态面上看得见（不落账：否则休眠期每分钟一行） |
  | L1 | 会话射程外 | 什么都不发 | 工作会话纯 agent |
  | L2 | 约定提醒（他下的命令） | 照发 | 无夜闸、无日上限 |
  | L3 | **她自己的闹钟** | 受**夜闸**、**不受日上限**（日上限是给"想念关怀"的护栏） | 是她自己的决定，但深夜不吵他；夜里压住**不消耗**，早上第一拍放行 |
  | L4 | 想念关怀 | 阈值 + 冷却 + 夜闸 + 日上限 + 待兑现 | 原样 |
  | — | 空拍退避（不是"闸"，是节流） | **只压 L4**（`lib/heartbeat.js` tick 里的 ⓪，**排在 ①b 之后**） | G1（2026-09-28 夜修）：它原来排在最前面，把到点的闹钟与约定提醒都推迟了最多 8 分钟 —— 他亲测"她喊我有点慢"。退避是"没人在变，别空查"的省力策略，不该拖到点的事 |
- **有意偏差（抄了机制，改了判据，写在明面上）**：
  ① Cortico 是"系统只给事实、她决定要不要开口"；我们**保留阈值当触发器**（省一次模型调用、也不产生空回合），
  把"只报事实"落在**事实行进 framing** + **每拍落账**上。② 它的退避是整条心跳的节流；我们**只节流纯安静的拍**。
  ③ 夜闸窗口在本地与引擎各写一份（`lib/heartbeat.js:46` 与 `night_hold` 设置），漂移后果只是早/晚一小时，
  且每次被压住都留 `wake-night-hold` 账。
- **P2 顺手抓到的真事故（不是本轮引入的）**：`echo_status` 的 payload 从 v0.30.2 起就带 `care`，
  而它的输出 schema **没声明**这个键 ⇒ 宿主按 `additionalProperties:false` **逐键判**，于是
  `echo_status` 每次调用都被拒（`value.care is not a declared property`）。
  没被发现的唯一原因是 `npm run check:tools` 自 v0.30.2 起**没再跑过**。
  已修（schema 补 `care`，用 `oneOf` 兼容 `null`），并把 `check_tools.mjs` **并进 `npm run check`**
  —— 这类"加字段忘声明"从此在常跑的门上就炸。
- 测试：主仓 **714**（新增 `tests/care-beats.test.js` 19 条 + `tests/care-report.test.js` 16 条）；
  `check` 0、`check:tools` 0（含 `echo_wake` 11 条出口）、`hygiene` 0。
- **真机验收口**：`npm run accept:p2`（`scripts/accept-p2.mjs`，只读）——
  从外面看四件：状态面版本 ≥ 0.31.0（= 宿主真的加载了新代码）、`care` 带 `quietStreak/nextPollAt/writeFailed`、
  心跳在跳（`care.at` 在 15 分钟内）、活的账本里 `care_beats`/`echo_wakes` 真有表真有行且 `reason` 全在枚举里。
  **重启前的基线已跑过**（2026-09-28 下午）：`version=0.30.2`、`care_beats` 表还没建、
  `care.reason=engine-says-no`（1 分钟前，心跳确实在跳）—— 6 条 FAIL，正是"还没重启"的样子。
  重启后同一条命令应当**全 ok**；不全绿就不算验收过。
- ✅ **P2 真机验收完成（同日下午）**：`accept-p2.mjs` 16 条**全通过**（exit 0）——
  `version=0.31.0`（宿主真加载了新代码）、`care.quietStreak=1 / nextPollAt>0`（**退避在动**）、
  `care.writeFailed=0`、心跳 1 分钟前刚判过、`care_beats`/`echo_wakes` 表已建且最近一拍落账
  （`engine-says-no`、带读数 `value=3.96`）、`reason` 全在枚举里；嘴那边两条 P1 结论也 ok。
  **还差两条活体**（都要等时钟或他动手 —— 我不写活的库）：① `echo_wake` 真响一次（她在会话里排一个
  2 分钟后的闹钟 ⇒ 账上应出现 `wake-sent`、`echo_wakes.fired_at` 落值、QQ 收到那句话）；
  ② 跨过夜闸（23:00–08:00）应出现 `night-hold` / `wake-night-hold`，且被压住的闹钟**不消耗**。
- **P3 / P4 未动**（P3 的四件事仍等他拍）。**其余还没搬的参考资料条目（8 批 47 条）另见
  `docs/PLAN_LAND_ALL.md`**（2026-09-28 夜他拍的「准备全部plan，等会一次性全部落地」）——
  那份里也把 P3/P4 编成 H 批、并写清两次重启窗口与回滚开关总表。

## 6. 每阶段通用的门

- `npm run check` / `npm run hygiene` / 两仓 `node --test` 必须 0；新仓 live acceptance 保持 11 ok。
- **新增对照测试**：把本轮的验伪脚本改写进主仓 `tests/`（`cortico-algo-parity.test.js`），
  固化我们**真正采用**的那几条算法行为（合批公式、折叠阈值、配对修复**含 orphan 记号**）——
  借来的算法要有钉子，否则下次重构就漂了。
- 任何"抄他们的机制"都必须同时写下**我们的取舍差异**（本文件 §0 的三条发现就是范例）。

## 7. 待他定的四件（不追问细节，只给选项与影响）

| # | 决定 | 选项 | 影响 |
|---|---|---|---|
| 1 | 先做哪条线 | (a) P0+P1 骨架先行；(b) 先 P2 让"她主动开口"变可信；(c) 直接进 P3 语音设计 | (a) 语音前置；(b) 体验立刻可见；(c) 不写代码只出设计 |
| 2 | 语音通道走不走 `echo:relay` | (a) 走（通道契约在脑侧、wire 复用）；(b) 另开 `echo:voice` 通道 | (a) 一套 wire 两个器官；(b) 更解耦但要维护两条 wire |
| 3 | 起草门要不要给 QQ 上 | (a) 上（多一轮延迟换"发前再看一眼"）；(b) 不上，只保留分泡+保鲜期 | 影响 QQ 体验与实现量；**语音一律不上** |
| 4 | 文体宪法谁来写 | (a) `lib/reflect.js` 夜窗归纳 + 写回 persona 后缀；(b) 只产出建议，他手动确认 | (a) 自动化但可能过拟合；(b) 稳但慢 |

## 8. 证据与未核实

- 验证脚本：`%TEMP%\echo-cortico-verify.mjs`（38/39；3 处发现见 §0）。**脚本本身是我写的**，
  v1 曾有 6 条因我自己误用 API 造成的假失败（piggyback 靠 trigger 声明、`deliver()` 只置 ready），
  v2 已修正——记在这里以免下次误读。
- 亲核 15 份、子代理 6 份：清单见 `docs/REFERENCE_CORTICO_2026-09-28.md` §7。
- **未核实**：`src/providers/**`、`src/protocol/open-responses/**`、`src/web/**` 细节、`console/*` 面板、
  `qface-map.ts`、**以及所有 `cortico-world-*` 扩展的实现（不在仓内）**。
