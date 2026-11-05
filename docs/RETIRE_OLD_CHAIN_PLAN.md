> **状态:已执行(2026-09-28)** —— 旧桥完整退役,见 CHANGELOG 同日那一节。
> 本文是**当时的计划**,留作记录;里面提到的 HTTP 端点已经不存在了。

# 遗弃老链路 —— 收尾计划

> 2026-09-26 编制。这份文档管的是**切换之后**的事:老链路整条怎么停、怎么归档、
> 按什么判据说它**真死了**。
> `docs/R4_ACCEPTANCE.md` 管的是**切换那天**的顺序与 20 项逐条验收 —— 两份不重复:
> 那份是「怎么切」,这份是「切完怎么埋」。
>
> **状态**:2026-09-26 三条已拍(卫星**两个都停** / 观察窗口**当天收尾** /
> 归档范围**库 + 两份老配置并做进脚本**)。归档脚本已按此改好并自测通过
> (现场 dry-run 现在列 8 个文件)。**卡在人手动作**:S1 停卫星、S2 补一次群消息。
> 剩下 3 条(⑤⑥ 与窗口延长的条件)按推荐默认走。

---

## 0. 结论先行

1. **老链路已经不写库了。** A 侧五表自冻结基线(09-26 01:25)起**零增长**,而同期 QQ
   流量一直在(DSH 侧 `relay_in` 10 / `relay_out` 15 / `relay_proactive` 9)。
2. **最后一次增量合并也已经做完。** 五个口径的 dry-run 全是「本次插入 0 / 登记 0」。
3. **但它只是「脑死」,还没埋。** 老插件代码(133KB `main.py` + `brains/ core/ audit/`)
   与 51 项配置仍在原位;两张库没归档;卫星 `astrbot_plugin_agent_state` **此刻还在写**
   (`state.db-wal` 1.25MB,最后写入 13:42)。
4. **剩下的动作只有两步要人手**(AstrBot 界面里停用卫星插件、插件列表里确认一眼),
   其余一条命令跑完,全部 **5 分钟内可回滚**。

---

## 1. 老链路与新链路

```
[老链路]  QQ ─▶ AstrBot 框架 ─▶ memory_middleware(脑) ─┬─▶ A 侧 memory.db(真相源①)
            钩子/白名单/分泡    ▲ agent_state(状态机)   │
                                └─▶ 平台模型 deepseek-chat ─▶ QQ

[新链路]  QQ ─▶ AstrBot 框架 ─▶ echo_relay(薄壳) ──POST /relay/inbound──▶ DSH 桥
            同上那把闸                              ◀──轮询 outbox + ack──┘
                                                        │
                                     dsh-echo 插件(脑)+ 引擎(sidecar)
                                                        └─▶ echo.db(真相源②,唯一)
```

归属判据(`docs/CORE_IN_DSH_PLAN.md` §2):**写「她是谁」的状态 → 必须 DSH**;
**要平台凭据/协议/限频/身份 → 必须 A**;两条都沾 → 数据面 DSH、传输面 A。

所以「遗弃老链路」= 把**脑**那一整列(插件 + 它的库 + 它的卫星 + 它的配置)停掉并归档,
**不是**把 AstrBot 拆掉 —— 框架与它的白名单/分泡是终局的一部分,留着。

---

## 2. 现状快照(2026-09-26 14:0x 现场核过,都可复现)

| 项 | 现场值 | 怎么核的 |
|---|---|---|
| 新链路 | 桥通、插件侧**接管中**、outbox `{sent:27, dropped:0}`、渠道 1 个(private·主动) | `npm run accept` |
| A 侧记忆库 | `136/9/4/26/28` = 基线(`09-26 01:25`)完全一致,**零增长** | `npm run accept` |
| A 侧 `memory.db-wal` | **停在 01:25:50**(0 字节)⇒ 老链路最后一次性写入之后没再动 | `npm run retire` |
| 同期 DSH 侧 | `extract` 31 / `relay_out` 15 / `echo_qq_say` 14 / `relay_in` 10 / `relay_proactive` 9,最后一条 13:20:56 | `echo.db` → `audit_logs` |
| 最后一次增量合并 | **已做完**:136→已在库 136;26 节点全在库或已接地;28 边 27+1 自环;8 话题命中;4 议程在库 | `node scripts/merge-astrbot.mjs` |
| 老插件是否加载 | 间接证据指向**已停用**:自带仪表盘 8420/8421 **未监听**。它是加载即起(`main.py:241-246` → `start_dashboard()`,日志会打「审计仪表盘已自动启动」) | `Get-NetTCPConnection` |
| 卫星 `agent_state` | **还在写**:`state.db-wal` 1.25MB、mtime **今天 13:42:01**(与表里三行 `updated_at` 同一时刻批量更,间隔 27 分钟前) | 文件 mtime + sqlite 只读 |
| 运行时耦合 | `lib/` 对 `.astrbot` / `memory.db` / `memory_middleware` **零引用** ⇒ 拔管动不到她 | `grep`(只有 `scripts/` 里的迁移与验收工具碰 A 侧) |
| 归档就绪度 | `npm run retire` dry-run ✓「**可以归档**」:**8 件**(两库 × db/wal/shm + 两份老配置)文件名、大小、mtime、sha256、备份目标都列好了 | `npm run retire` |

> 老插件配置里那些开关(`gateway_enabled: true`、`brain1_enabled: true`…)是**配置文件**,
> 插件被框架停用时它不会被改写 —— 所以那几行 `true` **不能**当作「还在跑」的证据。
> 也不该照它们去「关开关」:`gateway_enabled=false` 只关网关分支,插件会**掉回 legacy**
> (`on_llm_request` 注入 + `on_llm_response` 反思固化)继续写自己的库(`R4_ACCEPTANCE.md:101-103`)。
> 要拔管就整只插件停用。

---

## 3. 判据:什么算「老链路已死」

三条,缺一条不算:

| # | 判据 | 机器怎么看 | 现状 |
|---|---|---|---|
| **D1** | **零增长**:A 侧五表在冻结基线上不涨,且窗口内**有 QQ 流量**(否则「没涨」可能只是没人说话) | `npm run accept`(逐表比基线)+ `echo.db` 的 `relay_*` 计数 | ✅ 已满足 12.7h(01:25→14:09),中继行 34 = `relay_in` 10 + `relay_out` 15 + `relay_proactive` 9 |
| **D2** | **不自启**:框架层是停用状态;AstrBot 重启后 8420/8421 仍不监听 | 重启 AstrBot → `Get-NetTCPConnection -LocalPort 8420,8421` 空;插件列表肉眼确认 | ⚠️ **间接证据成立,需你确认一眼** |
| **D3** | **单脑**:入站只进 DSH,没有第二个人在答;legacy 回落路径不再触发 | QQ 里一句只收一条回复;审计有 `relay_in` 无重复;A 侧 `-wal` 不更新 | ✅ 今天 01:25 起成立 |

**窗口长度**(已拍:**当天收尾**):保守值是 ≥ 24h,他选当天办 —— 前置条件是把
「最容易漏的两条路径」补上:**一次群消息**(主人说 / 群友说各一条)+ 已经跨过的
**一次主动关怀**(今天 01:25→14:09 已有)。补完群消息、D1/D3 仍成立即可归档;
**若群里那两条有任何异常**(群友被答了、或两个人都答了),窗口就延长到 24h 再归档。

---

## 4. 逐项处置表(老链路清单)

| # | 东西 | 位置 | 处置 | 停后由谁接管 |
|---|---|---|---|---|
| 1 | `astrbot_plugin_memory_middleware`(脑:133KB `main.py` + `brains/ core/ audit/` + 7 个聊天命令 + 仪表盘 8420/8421) | AstrBot `data/plugins/` | **停用(代码不删)** | DSH 插件(判据①) |
| 2 | `astrbot_plugin_agent_state`(状态机,老脑 brain1 的上游;**此刻还在写**) | 同上 | **停用**(已拍:停) | 文档定「不接管」(§7:键语义不同)⇒ 停用 + 归档 |
| 3 | `astrbot_plugin_setu_on_proactive`(靠伪造宿主事件队列骗框架跑 `/setu`) | 同上 | **停用**(已拍:停) | 文档定「不接管」⇒ 建议一并停 |
| 4 | `astrbot_plugin_md_formatter`(QQ 的 markdown 适配) | 同上 | **保留** | 平台显示,新链路同样吃它 |
| 5 | 框架白名单 + 分泡(`cmd_config.json`:`enable_id_white_list` / `id_whitelist` / `segmented_reply`) | AstrBot 配置 | **保留** | 第二道闸,别重造 |
| 6 | A 侧 `memory.db`(+`-wal`/`-shm`) | `data/plugin_data/astrbot_plugin_memory_middleware/` | **归档改名** | `echo.db`(已在库 136) |
| 7 | A 侧 `state.db`(+`-wal`/`-shm`) | `data/plugin_data/astrbot_plugin_agent_state/` | **归档改名**(前提:#2 先停) | 不接管 |
| 8 | 老插件配置(51 项:persona_anchor/summary/rules、speaker_identity、master_id…) | `data/config/astrbot_plugin_memory_middleware_config.json` + `…agent_state_config.json` | **归档一份**(已拍:已做进 `retire` 脚本,与两库同目录同清单) | 现役人格在 `~/.dsh/echo/persona.json` |
| 9 | 老插件代码本体 | 同上 | **原地不动**(计划明写不删;答辩讲旅程) | — |
| 10 | `data_v4.db`(宿主框架自己的对话历史) | `data/` | **不碰**(§7) | — |
| 11 | 仓内迁移工具:`merge-astrbot.mjs` / `import-astrbot.mjs` / `rehearse-migration.mjs` | 本仓 `scripts/` | **保留为历史工具**(只读源库;已跑完) | — |
| 12 | 仓内归档工具 `retire-a-side.mjs` + 验收探针 `relay-accept.mjs` | 本仓 `scripts/` | **保留** | — |
| 13 | 薄壳 `astrbot_adapter/` | 本仓(装到 AstrBot) | **保留** —— 这是新链路的耳朵和嘴 | — |
| 14 | 引擎 sidecar `python/worker.py` + `python/engine/` | 本仓(DSH 侧) | **保留** —— 归属是 DSH,只是语言是 Python | — |
| 15 | 考古文档 `docs/ASTRBOT_*.md`、`docs/PORT_*.md` | 本仓 | **保留**,文头加一行「2026-09-26 老链路已停用」 | — |

---

## 5. 执行顺序(每步:命令 → 立刻验 → 不对怎么退)

### S0 · 冻结确认(只读,随时可做)

```powershell
npm run accept                      # 全绿 + A 侧行数 == 基线
node scripts\merge-astrbot.mjs      # 五个口径「本次插入/登记」全 0
npm run retire                      # dry-run:8 个文件(两库六件 + 两份老配置)+ 「可以归档」
```
**验**:三份输出都如预期。**不对**:停在这里,先查 `docs/R4_ACCEPTANCE.md` 第二节。

### S1 · 停用卫星(人手,AstrBot 界面)

停 `agent_state` + 停 `setu_on_proactive`(已拍:**两个都停**);**顺手确认** `memory_middleware`
已是停用状态(插件列表里它不该是启用色)。
**验**:重启一次 AstrBot → `Get-NetTCPConnection -State Listen | ? LocalPort -in 8420,8421` **空**。
**不对**:框架界面里再点一次停用;仍是空不了就说明有别的东西在看那两口(查 `Get-Process`)。

### S2 · 观察窗口(已拍:当天收尾 —— 补一次群消息就归档)

```powershell
npm run accept                      # 补群消息前后各看一眼:五表数字必须一动不动
npm run retire                      # 看 memory.db-wal / state.db-wal 的 mtime 是否冻住
```
要补的是**群里两条**:主人说一句(该有回复)、群友说一句(该**没有**回复、面板里也没这轮)。
**验**:D1 + D3 成立;`state.db-wal` mtime 不再前进;群里没有第二个声音。
**不对**:群里那两条有任何异常(群友被答了 / 两个人都答了)⇒ **窗口延长到 24h** 再归档,
并回 `R4_ACCEPTANCE.md` 第二节第 6 条找原因。

### S3 · 重记基线(把冻结值写成新基线)

```powershell
node scripts\relay-accept.mjs --snapshot
```
**验**:探针回读的基线与 S2 结束时的五表数字一致。**不对**:重跑一次(这一步只写
`~/.dsh/echo/r4-baseline.json`,无副作用)。

### S4 · 归档(**改名,永不删除**;库 + 两份老配置一条命令)

```powershell
npm run retire -- --apply
```
它会:① 先把 8 个文件原样拷到 `~/.dsh/echo/backup/a-side-<时间戳>/`;
② 写清单 `retired-a-side-<时间戳>.json`(文件名/大小/mtime/sha256/行数);
③ 逐个改名成 `*.archived-2026-09-26`。覆盖:`memory.db` 三件 + `state.db` 三件 +
`astrbot_plugin_memory_middleware_config.json` + `astrbot_plugin_agent_state_config.json`。
2026-11-05补充采样护栏：行数只读一致快照遇到锁时做有界整次重试；采样失败或表集合变化就拒签，
不写清单、不备份、不改名。`--force` 只覆盖已确认的行数增长/WAL新鲜度，不覆盖未知采样结果。
SQLite只读采样仍可能维护`-shm`共享内存索引，dry-run不执行归档操作，不表示辅助索引逐字节不变。
**验**:`npm run accept` 仍全绿(桥不依赖 A 侧);8 个后缀都在;备份目录里 8 个文件齐全。
**不对**:见 §8 回滚 —— 按清单把后缀去掉就回去了。

### S5 · 核对归档完整性

```powershell
Get-ChildItem ~\.dsh\echo\backup\a-side-* | Select-Object Name, Length, LastWriteTime
Get-ChildItem '$env:USERPROFILE\.astrbot\data\config','$env:USERPROFILE\.astrbot\data\plugin_data' -Recurse -Filter '*.archived-*' | Select-Object FullName
```
**验**:清单里的 8 条与磁盘上的 8 个归档件一一对上,sha256 与原件一致(清单里就记着)。

### S6 · 收尾记录

- `CHANGELOG.md` 加一节「老链路退役完成」,写清日期、当时的五表数字、归档目录、清单文件名;
- `docs/R4_ACCEPTANCE.md` 第六节验收记录打勾(含 A 侧行数不涨那条);
- 本文档 §9 打勾;
- 归档文档文头加「已停用」一行(处置表 #15)。

---

## 6. 不做清单(与计划一致,防范围蔓延)

- **不删**老插件代码、**不删**任何老库(改名归档;答辩要拿它讲旅程);
- **不碰** `data_v4.db`;
- **不把** `gateway_enabled` 当停用开关(legacy 回落陷阱,见 §2 注);
- **不接管** `setu_on_proactive`(它伪造宿主事件队列,DSH 侧没有对应物);
- **不重写**引擎:sidecar 留在 Python,「核心在 DSH」的判据是数据与行为归属,不是语言;
- **不为了「实时」**给 A 侧开公网回调(轮询够用)。

---

## 7. 决策(2026-09-26 已拍 3 条,其余按推荐默认)

| # | 问题 | 裁定 | 落地 |
|---|---|---|---|
| ① | 卫星 `agent_state` 停不停?(它**现在还在写** `state.db`) | **停**(已拍) | S1 停用;S4 归档它的库与配置 |
| ② | `setu_on_proactive` 停不停? | **停**(已拍:两个都停) | S1 一并停;它的配置**不归档**(没进脚本,要用说一声) |
| ③ | 老插件配置要不要也进 `retire` 脚本? | **要**(已拍) | ✅ 已改 `scripts/retire-a-side.mjs`:两份配置与两库同目录同清单;`tests/retire.test.js` 加了 2 条用例(摘掉配置目标会红 4 条) |
| ④ | 观察窗口多长? | **当天收尾**(已拍) | 前置:补一次群消息;异常则延长到 24h(§3 末) |
| ⑤ | 老插件代码留在原地还是挪走? | 留原地(默认) | 挪出 `plugins/` = 变相卸载,与「保留一键切回」冲突 |
| ⑥ | 归档的老库要不要再导一份只读副本进答辩材料? | 先不做(默认) | 只影响答辩展示;要的时候从 `backup/a-side-*` 拷一份即可 |

---

## 8. 回滚(任何一步不对,5 分钟内回来)

1. **归档后想复活老链路**:按 `retired-a-side-<时间戳>.json` 清单,把
   `*.archived-2026-09-26` 的**八个**文件去掉后缀(原名与 sha256 都在清单里),再在 AstrBot
   界面里重新启用老插件(和它的两个卫星)⇒ 30 秒内老链路回来。
2. **⚠️ 不要同时开两个脑**:新链路的薄壳还在跑,老插件一启用就会「两个人答同一句话」。
   要回滚就**先停薄壳**(AstrBot 里 `echo_relay` 关掉)再启用老插件。
3. **DSH 侧不用动**:`lib/` 对 A 侧零引用(§2 那行证据),归档动作碰不到她;
   万一 `echo.db` 也要回,用 `~/.dsh/echo/backup/` 里切换前那份。

---

## 9. 验收记录(执行时打勾)

| 步 | 做了什么 | 日期/时间 | 证据(命令输出/文件名) | ✓ |
|---|---|---|---|---|
| S0 | 冻结确认 | | | ☐ |
| S1 | 停用卫星(+确认老脑已停) | | | ☐ |
| S2 | 观察窗口(当天收尾:补群消息两条) | | | ☐ |
| S3 | 重记基线 | | | ☐ |
| S4 | 归档(库 + 两份配置,`retire --apply`) | | | ☐ |
| S5 | 核对归档完整性(8 件对账) | | | ☐ |
| S6 | 收尾记录(CHANGELOG/R4/本文档) | | | ☐ |
