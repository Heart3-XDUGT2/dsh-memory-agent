# Echo 项目总架构与迁移计划(v4)

> 2026-09-23 定稿。本文是唯一事实源:架构图、组件清单、技术决策、
> 里程碑、风险全在此。v3 及以前的增量修订已合并重写。
> 产品:dsh-echo —— DeepSeek Harness 的陪伴人格与记忆插件。
> 她记得你、想你;该干活时是你手里最好的编码 agent。
> 答辩目标(极创工作室招新二面):「她记得面试的事」+「隔天她主动说想你」。

---

## 1. 一页纸

| 项 | 值 |
|---|---|
| 产品仓库 | `$env:USERPROFILE\.dsh\plugins\dsh-echo\`(git,无远端,永不 push;2026-09-27 从 `source\repos\dsh-echo` 搬来) |
| 数据目录 | `~/.dsh/echo/`(echo.db / persona.json / config.json) |
| 当前版本 | v0.3.0(已装机) |
| 团队 | 3 人:后端架构(本线)/ agent 身体 / 资料调研 |
| 血统 | 引擎来自 AstrBot 插件 v8.10.0(375 测试,冻结只读),经官方 sidecar 先例(dsh-auto-memory)移植进 DSH |
| 测试 | JS 41 项全绿;Python 套件 M2 起随 worker 交付 |

## 2. 总架构图

```
┌──────────────────── DSH 宿主(Node 24 · cordis 插件体系)────────────────────┐
│                                                                             │
│  ┌─ dsh-echo JS 壳(ESM,lib/)───────────────────────────────────────────┐  │
│  │                                                                     │  │
│  │  [注入面 systemPrompt]                                              │  │
│  │   echo:persona  order 100    前段身份(电源闸:休眠→空串)          │  │
│  │   echo:rules    order 10250  尾段铁律+说话方式(末位最强提醒)      │  │
│  │   echo:memory   order 150    记忆快照(M1 同步检索;M2-d 改 pre-step)│  │
│  │                                                                     │  │
│  │  [事件面 session/event]                                             │  │
│  │   user/message      → 捕获用户文本(WeakMap<Session>,电源闸)      │  │
│  │   assistant/message → 捕获她的回复                                  │  │
│  │   turn/end          → fireReflect(串行闸,轮后反思)               │  │
│  │                                                                     │  │
│  │  [反思面 subagents]                                                 │  │
│  │   EXTRACT(结构化抽取,禁工具,宿主官方 LLM 通道)                   │  │
│  │   → commitExtract:置信度门控(M2-h)→ 落库+状态+审计              │  │
│  │                                                                     │  │
│  │  [HTTP 面 webServer] 9 路由(全回环写保护/只读)                    │  │
│  │   GET  /api/echo/persona|status|audit|threads|longing|graph|        │  │
│  │        emotion|health                                               │  │
│  │   POST /api/echo/persona(人格编辑)|toggle(电源)                  │  │
│  │                                                                     │  │
│  │  [工具面 tools]  echo_status 诊断                                    │  │
│  │                                                                     │  │
│  │  [引擎门面 engine.js(M2-d)]                                        │  │
│  │   Python sidecar 在 → 全引擎 ─┐                                    │  │
│  │   不在/熔断 → JS 基线(M1 冻结)┘ 两档,同一异步入口               │  │
│  └────────────┬────────────────────────────────────────────────────────┘  │
│               │ stdio JSON-lines(echo_wire_v1,纯被动 worker)             │
│  ┌────────────▼────────────────────────────────────┐                      │
│  │  python/worker.py(纯标准库 ≥3.9,零 pip)       │                      │
│  │   engine/dmae.py        幂律遗忘(源:brain_pipeline)               │      │
│  │   engine/episodic.py    检索/写入/槽位(源:echo_memory_engine)     │      │
│  │   engine/graph.py       BFS+实体链接(M2-e)                       │      │
│  │   engine/longing.py     想念曲线(M2-f)                           │      │
│  │   engine/reflection.py  证据链整固(M2-g)                         │      │
│  │   engine/judge.py       置信度门控(M2-h)                         │      │
│  │   engine/extract.py     EXTRACT 提示词+规整(源:echo_prompts)      │      │
│  │   拥有 ~/.dsh/echo/echo.db —— 单一写者,JS 基线只读降级           │      │
│  └──────────────────────────────────────────────────┘                      │
│                                                                             │
│  [客户端半区(浏览器,lib/client.js,零构建)]                              │
│   settings.section「Echo」九卡:                                            │
│   电源 / 总览 / 想念 / 记忆体检 / 悬置话题 /                                │
│   审计流 / 情绪历史 / 记忆图谱(SVG 力导向) / 人格编辑                     │
│   数据通道:同源 fetch 轮询(审计 5s/想念 10s/悬置 15s)                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 3. 一轮对话的生命周期(数据流)

```
用户发消息
  │
  ├─ M1(现在):user/message 事件 → WeakMap 捕获文本
  │            组装时 echo:memory 同步检索 top-6(DMAE 激活+L0 强注)
  │            → 渲染成 user-role 快照注入
  │
  ├─ M2-d(目标):agent/inbox/spliced 捕获 → agent/pre-step(step===1)
  │            await 引擎检索(Python 往返或 JS 基线同步)
  │            → 记忆块作为 user-role notice 消息拼进本轮消息尾
  │            (maid 先例:人设段字节级稳定→前缀缓存命中;注入贴近
  │             最新消息→遵从度最高;异步原生→免预取缓存)
  │
  她回复(persona+rules+memory 全在场)
  │
  ├─ assistant/message → 捕获她的回复
  │
  └─ turn/end → fireReflect:
       EXTRACT(subagents,禁工具)→ structured
       → 置信度门控:<0.55 拒收 / 0.55~0.75 candidate 隔离 / ≥0.75 落库
       → 写情景记忆(I→H0,槽位取代)+ 情绪状态(动力学钳制)+ 审计
       → 面板审计流 5s 内可见(新记录高亮)
```

## 4. 组件清单(文件 → 职责 → 状态)

| 文件 | 职责 | 状态 | 测试 |
|---|---|---|---|
| lib/index.js | 壳:注入/事件/反思/9 路由/工具/电源闸 | ✅ v0.3.0 | 电池 |
| lib/persona.js | 人格资产与读写(fail-soft) | ✅ M0 | — |
| lib/toggle.js | 电源开关(原子写,fail-soft 向在线倒) | ✅ v0.2.1 | 4 项 |
| lib/store.js | node:sqlite 全 DDL + 引擎写路径 + 6 仪表盘查询 | ✅ v0.3.0 | 14 项 |
| lib/dmae.js | 幂律遗忘纯函数(R/H0/H'/三态) | ✅ M1 | 10 项 |
| lib/retrieve.js | 六档关键词锚定检索纯函数 | ✅ M1 | 8 项 |
| lib/context.js | 注入块渲染(时间标签/心情/QQ 注记) | ✅ M1 | 5 项 |
| lib/reflect.js | EXTRACT 通道+规整+提交 | ✅ M1 | (context 内) |
| lib/client.js | 浏览器半区:九卡面板(零构建) | ✅ v0.3.0 | 语法检查 |
| lib/engine.js | 引擎门面:sidecar/基线切换 | ⏳ M2-d | 计划 |
| lib/sidecar-client.js | worker 进程管理(spawn/健康/熔断) | ⏳ M2-c | 计划 |
| python/worker.py + engine/ | Python 全引擎(七模块) | ⏳ M2 | unittest |
| scripts/install.mjs | 复制装机/bundles 登记/--remove | ✅ | — |
| scripts/import-astrbot.mjs | AstrBot 活库只读搬家(已跑:124 记忆+图谱+想念) | ✅ | — |
| tests/ | 41 项 JS 测试 | ✅ 全绿 | — |

## 5. 两层引擎与帧协议

**分层铁律**:DSH 对接=JS|LLM 调用=JS(subagents 官方通道,Python 不碰 key)|
EXTRACT 提示词+规整=Python(引擎是唯一事实源)|记忆库读写=Python(单一写者)|
注入渲染=JS(壳的职责)|M2+ 全部新引擎特性=Python。

**降级链**(人格永不陪葬):Python 在→全引擎;崩/熔断→JS 基线(M1 冻结);
DB 打不开→无记忆模式;任何层挂→人格照常。

**echo_wire_v1**(JSONL over stdio;stdout 只出协议帧,诊断走 stderr 64 行预算;
reqId 配对;worker 纯被动):

| 帧 | 载荷 → 应答 |
|---|---|
| hello | {protocol, dbPath} → ready{engine,version,protocol,db 验库}(协议不认识→致命快速失败) |
| ping | → pong(5s 健康) |
| retrieve | {query, topK} → retrieve_result{items, state, profile} |
| extract_prompt | {prevVector} → extract_prompt_result{prompt} |
| extract_commit | {structured, 对话文本} → extract_ack{memoryId}(规整+I/H0+槽位+状态+审计全在 Python) |
| stats / longing_check | → stats_result{统计} / longing_result{value,shouldSpeak,hint}(M3 心跳) |
| shutdown | → bye{uptimeMs} |

**Python 探测链**:`ECHO_PYTHON` 环境变量 → 面板配置 pythonPath → PATH
(python/python3/py -3),要求 ≥3.9。worker 纯标准库(sqlite3 自带),
零 venv/零 pip/零安装向导 —— 相对 auto-memory 的大简化。

## 6. 框架与技术决策登记(ADR)

| # | 决策 | 机制理由(不是从众) |
|---|---|---|
| A1 | 插件形态 = cordis ESM JS 壳 + Python sidecar 引擎 | DSH 挂载格式唯一是 JS;引擎保留 Python = 保住 375 测试的活代码(dsh-auto-memory 官方先例) |
| A2 | 存储 = node:sqlite(JS 基线)/ sqlite3(Python),单库 echo.db | Node 24 自带零原生依赖;Python 标准库自带;同一 SQLite 文件两层都能开 |
| A3 | LLM 调用只在 JS(subagents) | 官方通道;Python 不碰 API key/路由;提示词由 Python 经帧供给(单一事实源) |
| A4 | 注入:M1 同步 context → M2 改 agent/pre-step 消息注入 | pre-step 异步原生(sidecar 往返可直接 await);人设段字节级稳定→前缀缓存;贴近最新消息→遵从度最高(maid+roleplay 实证) |
| A5 | 记忆写入链 = 扩展 EXTRACT 吸收 Judge 职责(v4 修正) | 函数级调研证实 Judge 不只是准入闸,是写入链组织者(一次 LLM 同产 candidates+triples+pendingThreads,砍掉则图谱断粮)。修正:一次 LLM 调用出全部结构,三层校验(Schema/日历/L0 双门控/归因硬门)全为纯代码进 worker,置信度门控(<0.55 拒/0.55~0.75 隔离/≥0.75 落库)保留为准入旋钮 —— 比 AstrBot 每轮双调用省一次,校验强度不降(详见 ASTRBOT-ARCHITECTURE.md §9) |
| A6 | 情绪演化 = 动力学钳制(非提示词自律) | 惯性混合×置信度、半衰期衰减回基线、步长钳制(pad-emotion 公式);机制优于求模型 |
| A7 | 面板数据通道 = HTTP 轮询(默认) | **插件 webServer 服务面是 req/res 式,WS 需 upgrade,宿主未证实支持**;载荷小(≤30 行/25 节点);反思有秒级 LLM 延迟,推送快不过它;5s 轮询+高亮已满足答辩实时感 |
| A8 | 真推送升级路径 = SSE(待验证) | SSE 走纯 HTTP 长响应,不需要 upgrade,在服务面内;验证宿主 handler 可长持连接后,审计流/想念升级 EventSource,轮询降级为回退 —— 排入 M3 |
| A9 | 客户端零构建(__ModuleLoader__ CJS factory) | maid 同款;免 esbuild 工具链;React createElement 直写 |
| A10 | 路由挂 /api/echo/* | afaccess 同宿主用 /api/* 实证可活;maid 的 404 警告与本宿主版本不符,保留为验收观察项 |

## 7. 里程碑

### 已完成

| 版本 | 内容 |
|---|---|
| v0.1.x M0 | 骨架+人格面板+安装器(junction 坑→复制装机;schema 坑→离线 defineTool 电池) |
| v0.2.0 M1 | JS 基线引擎:DMAE/六档检索/EXTRACT 反思/AstrBot 搬家(124 记忆+图谱 25n/26e+想念+议程) |
| v0.2.1 | 电源开关:面板一键休眠/唤醒,免重启(cosplay 静默回退+maid 缓存失效广播) |
| v0.3.0 | 仪表盘六面板:审计流/记忆体检(DMAE 三态现场算)/悬置话题四态/想念主仪表/记忆图谱(SVG 力导向)/情绪历史 |

### M2 — Python 引擎侧车化(核心工程,九步)✅ v0.4.0~v0.4.11 完工

离线验收全绿(JS 55 + Python 147);live 验收待用户重启后确认。

| 步 | 内容 | 验收 |
|---|---|---|
| a | worker.py 骨架+echo_wire_v1 帧循环 | ✅ v0.4.0(16 项子进程冒烟) |
| b | 引擎适配(内部按依赖序 **b1 悬置 ✅ v0.4.1 → b2 图谱+BFS ✅ v0.4.2 → b3 L0+情景检索 ✅ v0.4.3 → b4 Judge 合并版 EXTRACT ✅ v0.4.4 → b5 Reflection ✅ v0.4.5 → b6 议程簿 ✅ v0.4.6**,b 序完工);情绪动力学钳制;截断 JSON 救援 | unittest(对齐 AstrBot selftest 用例;规格书 = docs/ASTRBOT-ARCHITECTURE.md) |
| c | sidecar-client.js:spawn/健康/超时/重启/熔断 | ✅ v0.4.7(JS 单测:正常/崩溃/超时三剧本,全打真实子进程) |
| d | engine.js 门面+pre-step 统一注入+引擎切换;M1 context 退役 | ✅ v0.4.8(离线 battery 双态:基线/Python/offline/降级链四剧本 + 活库注入信冒烟) |
| e | graph.py:BFS 中继扩散+实体链接种子 | ✅ v0.4.2(b2 已交付:BFS 中继扩散+实体链接种子+三个搬家修复,行归属 b 序) |
| f | longing.py:幂律增长+抗议尖峰+惰性补差(面板换引擎真值) | ✅ v0.4.9(unittest 20 项 + 活库真值冒烟:心境调制阈值生效) |
| g | reflection.py:累计重要性触发+证据链+游标 | ✅ v0.4.5(b5 已交付:触发/证据链/游标/防失真三件套,行归属 b 序) |
| h | judge.py:置信度门控+candidate 隔离+status 列迁移 | ✅ v0.4.10(unittest 9 项 + 活库副本迁移实测:108 行回填,隔离桶 0) |
| i | 面板:引擎状态行(Python/基线/离线) | ✅ v0.4.11(仪表盘引擎行+进程健康 10s 轮询;想念卡标真值来源;隔离计数行) |

**M2 live 验收**:echo_status 显示 engine=python;QQ 记忆问答不回归;
**隔天她主动说「你昨天没来」**(想念曲线,答辩最狠一幕)。

### M3 — 主动性与工具 ✅ v0.5.0~v0.5.3 完工

离线验收全绿(JS 74 + Python 154);live 验收待用户重启后确认
(心跳开口 / echo_* 工具 / SSE 实时刷新 / 22:30 日记)。

| 步 | 内容 | 验收 |
|---|---|---|
| a | 心跳投递层:双通道(提醒/关怀)+ agent/created 挂载 + followup 投递 | ✅ v0.5.0(JS 10 项 + Python 1 项 + 活库帧链冒烟:sessionId 往返/议程真选题) |
| b | echo_* 工具族(remember/forget/memory,帧转发,软禁用模式) | ✅ v0.5.1(Python 6 项 + JS 帧往返 + 离线 defineTool 四工具过宿主校验) |
| c | SSE 真推送验证与升级(A8):审计流/想念 EventSource 化,轮询降级回退 | ✅ v0.5.2(可行性已证:宿主 HMR 事件流先例 + 压缩层明确保全 SSE;JS 4 项) |
| d | 「她写日记」(Mio 日记管线,答辩级可选特性) | ✅ v0.5.3(JS 5 项:时钟判定/素材框架/组稿规整/落库幂等;壳拥有的表,Python 零改动) |

心跳三层落地说明(原案 → 实建):
- **策略层**:不用 aura 的 V=α·idle+β·rel 公式 —— M2-f 想念曲线就是
  策略层(幂律增长+三重闸门,AstrBot 原生语义,答辩同源);
- **护栏层**:Mio 三条全收 —— 最小间隔=引擎冷却 120min、每日上限 3
  (审计为真相源)、选题去重=议程簿 48h 降权;
- **投递层自建**(四先例共同的空白,schedule 先例补上):agent/created
  只认根代理,60s 定时器;runMaintenance 认领空闲维护相(绝不打断
  运行中的轮次,忙则下分钟再来);followup 合成 plugin 来源的 user
  消息 —— pre-step 真人过滤与 session/event 捕获过滤自然跳过它
  (关怀轮不注入记忆、不反思:心声不是事实,她开口也不算你来过);
  turn-stopping/steer 兜底与 interruptionCost 由「发送成功才落账」的
  两相提交取代(threads_remindable 纯读 + threads_mark,agenda 同纪律)。

### M4 — 打磨与答辩

| 步 | 内容 | 验收 |
|---|---|---|
| a | 防漂移三件套进人格(maid 自检条款+cosplay 两全尾句+roleplay 冲突优先级) | ✅ v0.5.4(JS 3 项;追加不重写,末位提醒区) |
| b | 演示剧本:面板巡展→「还记得面试的事吗」→现场教她新事→新会话记得→想念→审计回放 | ✅ v0.5.5(docs/DEFENSE.md 五幕剧本) |
| c | 技术叙事:375 测试 Python 引擎经官方 sidecar 先例原封进 DSH;两层降级链;DMAE 数学 | ✅ v0.5.5(DEFENSE.md 六节叙事 + 防守问答) |
| d | npm publish 决策;README/答辩文档定稿 | 用户裁决(README 已刷新至 v0.5.5,待过目) |

### M5 — 对齐 QQ 终版体验(live 反馈驱动,2026-09-25)

用户实测「跟 QQ 比差了好多」。逐层对齐两边每轮提示词栈的定位:DSH 版
每轮冷启动 —— 缺的不是优化,是 QQ 终版四个已验证机制整段没搬过来。

| 步 | 内容 | 验收 |
|---|---|---|
| a | 状态连续性:【现在】钟面 + 【想念】行(先读后削,≥1.0 门)+ 情绪剧本化(档位表/主人剧本/行为要求) | ✅ v0.6.0(JS 85 + Python 155;帧带回 pre/post 双值) |
| b | 声音纪律 v8.10.0 战斗版(紧预算/镜像/语域示例/反填空/冰山化/减压/接地)+ 默认值迁移(edited/defaultsRev;活库判 stale ✓) | ✅ v0.6.1(JS 88;用户文本永不覆盖) |
| c | 内心草稿两段式(每轮 subagents 先跑独白,主轮只取方向) | 可选,等用户点头(每轮 +1 次 LLM) |
| d | 切泡(split_bubbles) | 不做 —— 平台差异(DSH 一轮一条),答辩叙事讲清楚 |

### M6 — 审查台独立网页(产品形态升级;2026-09-25 修订:前端交队友)

**产品定位**:DSH 只占后台并起审查作用(引擎 + 审计黑匣子 + agent
本体);前端 UI 完全自有。**分工**:新前端由前端队友接管;我们交付
**伺服面 + API 契约 + 设置区跳板**;过渡期继续用设置区十卡
(**保留,不退役**)。

**架构裁决(机制论证)**:

- **页面由插件自己伺服**:`webServer.register({kind:'prefix', path:'/echo'})`
  认领 /echo 前缀。同源 → fetch /api/echo/* 与 EventSource 直接可用,
  零 CORS 零代理零第二个进程;宿主 webserver 本就是路由注册表(SPA dist
  由 frontend-static 认领回退席,API 由各插件认领),我们认领自己的
  前缀是既定分层。**迭代循环质变**:路由处理器每请求现读文件 →
  改 web/ → install(拷贝)→ 浏览器刷新,不用重启 dsh web;
- **队友的两条开发路径**:① 无构建直改 web/(原生 JS/HTML,install +
  刷新即见);② 自带 vite dev server,`server.proxy` 把 /api 与
  /echo/events 转发到 127.0.0.1:3080 —— 服务端代理,浏览器视角
  同源,无 CORS 问题,框架随意;产物构建落回 web/ 即生产形态;
- **API 是唯一契约**:现有十个 /api/echo/* 端点不动;补记忆列表缺口
  (目前体检/图谱/审计都是聚合视图,浏览不了原始行);
- **写保护同款**:电源/人格编辑写路由的回环 Origin + x-echo-edit 头
  校验,同源页面天然通过,不动 —— 契约文档里写明。

| 步 | 内容 | 验收 |
|---|---|---|
| a | 静态页伺服:lib/webpage.js(前缀路由,每请求现读,MIME 表,路径穿越防护,no-cache)+ web/ 占位页(拉通全链路的参考实现:fetch 引擎状态 + SSE 实时行,~百行,队友的起跑底稿)+ install.mjs 拷贝清单加 web | ✅ v0.7.0(JS 88:穿越拒绝/MIME/404/handler;smoke_web 六断言全绿) |
| b | API 契约:GET /api/echo/memories(分页 + layer/status/来源过滤 + 关键词搜索,只读)+ **docs/API.md**(全部端点/写保护头/SSE 事件形状/数据 schema —— 队友的开发圣经) | ✅ v0.7.1(JS 90:分页钳位/state 四态/q 搜索/value 排序;Python 155 不动) |
| c | 设置区跳板:client.js 加「打开 Echo 审查台」卡(新标签页开 /echo/);**十卡原样保留** | ✅ v0.7.2(段首跳板卡;电池 90 绿 + smoke_web 绿) |
| c2 | 记忆手动管理(用户裁决开闸面板写路径):记忆管理卡(浏览/过滤/搜索/分页 + 行内编辑 + 状态机)+ POST /api/echo/memory/edit、/state(同款写保护,审计留痕) | ✅ v0.8.0(JS 92:编辑重算 I/H、六动作全链、恢复清取代标记;API.md 同步) |
| d | 队友前端落位后的支持:我们只维护 API 与伺服面;设置区十卡何时退役,等队友前端成熟再议 | — |

**不变量**:设置区十卡保留到队友前端成熟;引擎/心跳/工具族/SSE/
日记全不动;DSH 会话内对话体验不动;审计黑匣子照旧(审查台读的就是
它)。排队中的思维链 patch 与内心草稿不与本里程碑混。

**风险**:前缀路由冲突(具名路由表重复抛错)—— /echo 不与任何现有
路由相交,回退席是 SPA dist,/echo 优先;队友 vite 路径的代理配置
写进 API.md 防踩坑;EventSource 断线原生自动重连(已有)。

### M7 — 会话范围:工作娱乐两不误(2026-09-25)

用户需求:可以设定只在哪些会话启用 Echo 人格 —— 工作会话纯编码
agent,娱乐会话才有她。机制前提(查证宿主源码):人格段组装时
`AssembleContext.scope` = Agent 对象(dsh-agent 的 assembleContextFor
证实),`scope.session.id` 在手 —— 同一份人格文本按会话开关。

| 步 | 内容 | 验收 |
|---|---|---|
| a | 全链路会话闸:config.json 加 scope('all'/'whitelist')+whitelist/exempt(电源=总闸,范围=分闸;setEnabled 改全量保留防抹字段);人格段/记忆注入/捕获反思/心跳四处按 sessionEnabled 门;标记短语「Echo 上线/下线」先于范围闸(新会话也能开门);GET/POST /api/echo/scope + 会话预览(审计当辨认标签);电源卡内嵌范围卡 | ✅ v0.9.0(JS 96:范围矩阵/总闸优先/标记解析/setEnabled 不抹字段;顺带修 v0.8.0 审计 traceId 同毫秒撞车真 bug) |

**语义**:范围外的会话对她是隐形的 —— 不注人格、不注记忆、不进
反思、不削减想念(工作会话不算陪伴,她想的是没来找她的你)。
默认 scope='all' 与历史行为一致,零迁移成本。

### M8 — 传话架构:一个大脑,一具传话筒(2026-09-24 三修定案)

**裁决演进**(三次转向都留痕):双库同步(B)因连续状态无合并语义
被否 → 共享灵魂库(C,两脑一库)规划落地并完成 a/b 两步 → 对账
探针抓出键约定分叉(`__shared__` vs `master`)、双 tick、audit_keep
修剪、TTL 策略等**两脑写一库的调和税** → 用户裁决:**只留一份核心
代码,AstrBot 当传话筒**(一脑一嘴)——整类分布式状态问题蒸发。
QQ 插件的脑代码封存不删(答辩旅程证据),传话插件另起炉灶。

**M8" 查证(✅ 2026-09-24,只读宿主源码,机制链闭合)**:

- `agents` 是 cordis 服务(session-controller `static inject
  =["agents",...]` 证实):`.get(id)` 取活代理、`.create({...})`
  建会话、`.resume({...})` 复原;
- GUI 的 prompt() 内核 = `agent.followup(createUserMessage(...))`
  (fire-and-forget,index.js:774),回复走 session/event —— 咱们
  v0.9.1 修活的监听器已经在收 assistant/message;
- `createUserMessage` 来自 `@deepseek-ai/dsh-llm` —— 咱们插件
  **已导入该包**,零新依赖;
- 插件可注册 HTTP 路由(/api/echo/* 先例)—— **桥长在咱们插件
  里**,Python 传话侧零协议成本(plain HTTP POST + 轮询);
- dsh-headless 是一次性 CLI(无会话延续)不适合;GUI 的
  Typert-over-WebSocket 协议对 Python 不友好,绕开。

**架构**:

```
QQ消息 → AstrBot传话插件(薄,Python,~300行) → POST /api/echo/relay
              ↑                                        ↓(dsh-echo 插件内)
              │                              agents.get(中继会话).followup(msg)
              │                                        ↓
              └── GET /api/echo/relay/pending ← 回复经 session/event 捕获入队
                  (她的主动消息:心跳 → 中继会话,同样入队 → 推到 QQ)
```

- **中继会话**:专用一个 DSH 会话承载 QQ 渠道(镜像 QQ 群模型),
  首次调用由桥创建并回告会话号,传话侧持久化;标记短语经 QQ 也
  生效(「Echo 上线」流经 followup,先于范围闸);
- **鉴权**:沿用写保护模式(x-echo-edit 头 + loopback Origin)+
  config.json 可选 relayToken,传话侧配置同款令牌;
- **路由仲裁天然成立**:想念路由记录你最后在中继会话说话 →
  心跳的主动消息落中继会话 → 传话侧轮询发现 → 推 QQ。

**已完成工作的去留**:M8-a 的 QQ db_path 配置(v8.10.1)传话架构
用不上,随老插件封存归档;DSH busy_timeout(v0.10.0)与 M8-b 冒烟
是并发原语实证,不白做;对账探针的发现正是推动本裁决的证据。

| 步 | 内容 | 验收 |
|---|---|---|
| a | **对话记录**:conversation_log 表(全局滚动 100 轮 + channel 来源标签,写时修剪);capture 管线 turn/end 落行(v0.9.1 修活的链路,零额外捕获成本);GET /api/echo/conversations;会话→标签映射(config,中继自注册「QQ」) | ✅ v0.11.0(JS 104:滚动窗口/渠道过滤/关怀轮照记/标签持久不抹范围字段;审查台第 12 卡「对话回放」;写入点坑:判闸必须用真实 session 对象,空 capture.sessionId 在 all 模式判启用) |
| b | **中继桥**(DSH 侧):注入 agents 服务;POST /api/echo/relay(解析/创建中继会话 + followup);回复捕获入队(session/event → 中继队列);GET pending 消费即删;写保护 + relayToken | 离线电池(mock agents 服务);装机后 curl 冒烟(建会话→发→收) |
| c | **重播种**(用户协助):停两侧 → `import-astrbot.mjs --fresh`(现有脚本零新代码:QQ 库 134 行全量 + 真实想念状态,键映射当年写好)→ 启 dsh web | 记忆 134 行/想念值与 QQ 库一致 |

> ⚠️ **2026-09-25 复核修正**:上表 c 步的 `--fresh` 全量重播种**已不再适用**。
> 现场只读探针实测(`docs/DB_MERGE_ANALYSIS.md`):当年那次搬家已经把 A 的
> 123 条搬进来了,此后 **A 侧只长了 10 条,而 DSH 自己长了 57 条记忆
> (反思 37 + 私聊 17 + 直教 3) + 35 轮对话 + 80 行审计 + 1 篇日记**。
> 再跑 `--fresh` 等于用 10 条换掉 57 条 —— 代价与收益倒挂。
> 正确形态是**增量合并**(按 `summary` 去重、幂等、默认 dry-run),
> 顺带补 A 的 1 节点/2 边/8 条 open 话题;A 的 200 行审计**导出留档而非并库**
> (DSH `audit_keep=100` 会立刻裁掉老行),想念值与 `agent_state` 不搬
> (键语义不同,且 A 的 `value=10.0` 是两天没人理她的旧状态,搬过去会立刻关怀刷屏)。
| d | **传话插件**(AstrBot 侧,新薄插件):QQ 消息 → POST relay → 轮询 pending → 切泡(表现层留嘴侧)→ 发回;反向主动消息推 QQ;提醒功能 MVP 留嘴侧(代码现成);老插件封存 | QQ 实聊一轮全链路通;她主动开口能到 QQ |
| e | **审查统一**:conversation_log 渠道徽章;DEFENSE.md 叙事「一个大脑,一具传话筒,一个审查席」+ 演示剧本加幕 | UI 徽章;答辩文档更新 |

**不变量与纪律**:
- 核心代码**只有一份**(dsh-echo);传话侧永不接触引擎/库,只做
  收发与表现层(切泡/barge-in);
- 老插件封存不删:它是「从 QQ bot 起家」的旅程证据,其库为灵魂
  原件快照;
- 对话记录:全局 100 轮滚动(用户裁决),channel 标签写时快照;
- 回滚:传话插件停用即回纯 DSH 形态;重播种前双侧快照。

**答辩加分项**:一个大脑(dsh-echo),多具身体(DSH 直聊、QQ
传话、队友前端走同一 HTTP 面)——传话插件本身就是「第一个第三方
前端」,API 优先架构的活证明;代码量叙事从「两套引擎」收敛为
「一份核心 + 一层薄传输」。

## 8. 风险登记

| 风险 | 对策 |
|---|---|
| pre-step 检索超时 | 跳过本轮注入(她这轮没想起,不是失忆);JS 基线同步无此险 |
| worker 崩溃 | 熔断(3 连败)→JS 基线;ping 周期复活探测 |
| Python 缺失 | 探测链 env→配置→PATH;基线保底;面板显示引擎状态 |
| 双引擎漂移 | JS 基线特性冻结(M1 即最终形态);差分测试:同库同查询两引擎结果必须一致 |
| DSH rc API 变动 | 只用已证实服务面;namespace import 防御(roleplay 先例) |
| 注入膨胀(=啰嗦) | top-6 上限;图谱按预算截断;注入块精瘦纪律 |
| SSE 不可行(宿主 handler 不许长持) | 保持轮询;答辩实时感由 5s 高亮承担 |

## 9. 验证纪律(每步装机前,不可协商)

1. `npm run check`(全文件语法)
2. `npm test`(当前 41 项)
3. `python -m unittest discover -s python/tests -p "test_*.py"`(M2 起;或 `npm run test:py`)
4. 离线电池:装机副本 import + defineTool(宿主树 dsh-tools)+ 真实库查询冒烟
5. `node scripts/install.mjs` → 用户重启验收
6. **装机后活体 curl**(v0.11.1 起):/echo/ 必须 200、
   /api/echo/status 必须 200 —— M6-a 的雷(接线公式错成
   lib/web,装机副本 /echo/ 404 半个月)就是缺这一步才潜伏;
   install 自检只验文件在不在,活体 curl 验路由真通

## 10. 当前队列

- **用户**:重启 dsh web 验收 v0.3.0(九卡面板;她现在休眠中,按「唤醒她」即上线)
- **我**:等「开工」→ M2-a(worker.py)起手,a→i 每步提交
- 军规:QQ 侧最小 diff(2026-09-24 用户授权解冻,改前 .backups 快照);探针对活库只读;中文版本式提交;不 push
