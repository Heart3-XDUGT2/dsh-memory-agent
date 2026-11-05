# Echo × DSH 隐患台账(2026-09-26,三路只读审计合并)

他问「你到底在这个屎山代码里面还积累了多少隐患」。三路独立只读审计(① 注入与
上下文 ② 数据与并发 ③ 裁定漂移与老链路)各出 10 条,这里**去重、按族归并、
逐条带证据与最小复现**,并标出「已复现」与「代码推断」。

方法(都可复现):解 `~/.dsh/sessions/<项目>/<会话>/session.v3.jsonl.zstd`
(多帧 zstd,逐帧解)按顶层 `surfaceOp` 重放 surface;`~/.dsh/echo/echo.db`
只读;宿主与仓库只读代码。

**当天已处理的两条**:族 A 的 A1(A 案,`0e99ecd`)、「改完 lib 分不清活的是哪一版」
(`629dd6e` 构建指纹)。

---

## 族 A:上下文只进不出(最贵)

| # | 隐患 | 证据 | 标签 |
| --- | --- | --- | --- |
| A1 | 记忆/心情快照每轮以 `form:'snapshot'` 追加进 user 消息,**永不回收** | `a165b0d0` 最终 surface 里 62 块共 57,105 字(跨 09-24 22:10→09-26 13:20),占派生上下文的 67.6% 字数;宿主逐条 `surfaceOp:"append"`(`dsh-agent-loop/lib/index.js:1028`),271 append / 7 replace 而**快照 0 条被替** | 已复现 → **已修(A 案)** |
| A2 | 工具结果无字节上限、进历史,且是压缩第一批牺牲品 | 同会话 `tool/result` 27 条共 73,757 字(47%),单条最大 14,733 字(`glob $env:USERPROFILE\Desktop` `*`,seq 709);父会话最近一次压缩 239 条 shadowedSeqs 里 115 条是工具结果。工具自身只限 100 条路径,**不限字节** | 已复现 |
| A3 | 上下文撞限(≈20 万 tokens)触发压缩,按最老区间切,先吃工具结果与她的旧回复 | 父会话 90 分钟压 4 次(104,417 / 108,864 / 96,273 / 93,487 shadowedTokenCount);触发前 209,373 tokens(14:08)→ 压后 143,982 / 82,227。最近一次被吃:118 她的回复 / 115 工具结果 / 3 他的话 | 已复现 |
| A4 | 压缩临近度的现状 | Echo 测试会话 106,444 tokens(阈值 53%)、QQ 伴聊 42,168(22 轮 ⇒ ~1,900 tokens/轮)⇒ QQ 再约 85 轮、测试会话再约 65 轮进压缩区 | 已复现 |

## 族 B:写库没有事务/幂等(崩溃与并发)

| # | 隐患 | 证据 | 标签 |
| --- | --- | --- | --- |
| B1 | 多步逻辑写没有事务(`lib/store.js` 全文无 BEGIN/COMMIT) | `store.js:412` 旧记忆退位 → `:416-428` INSERT → `:429-436` 回填 id → `:439-442` 降级候选,四条各自 autocommit;`relay.js:487-501`、`store.js:1359-1379` 同样两条一组。崩溃在中间 ⇒ 旧记忆**永久静默失活**(没有清扫器修 `superseded_by=-1`) | 推断(活库 `superseded_by=-1` 0 行 ⇒ 未发生) |
| B2 | outbox 认领不是原子的 | `store.js:1400-1406` 先 `SELECT` 再逐行 `UPDATE … leased_until`,无事务、无 CAS、无进程内互斥;两个轮询者(双薄壳/框架重试/手动 curl)可领到同一 `out_id` ⇒ 同一条发两遍 | 推断(活库按 text 分组无重复) |
| B3 | 入站幂等表会「吃掉」崩溃后的重试 | `store.js:1230-1243` 先插 `pending`,`staleSec`(默认 60s)内重试直接 `duplicate` 丢弃 ⇒ 平台重试的这条 QQ 消息**到不了她** | 推断(16 行全 `accepted`) |
| B4 | 出站 at-least-once,重试计数只在内存 | `astrbot_adapter/main.py:404-430` 发成功才 ack;`_send_attempts` 是内存 dict,`store.js:1420-1432` ack 无幂等键 ⇒ send 成功后 ack 前退出/断网 ⇒ 重启再发一份同文 | 推断 |
| B5 | 审计可以整条静默丢失(而审计是证据源) | `relay.js:499-501/516-517/360/603` 四处 `try { audit?.(…) } catch { }`,`writeAudit`(`store.js:581`)自己不吞;`busy_timeout=5000` 一到就丢,而 `audit_logs` 又被 `trimAudit` 裁到 100 行 ⇒ 事后查不出 | 推断 |
| B6 | WAL 停在检查点阈值上,主库 14 分钟没被回写 | 40 秒采样 4 次:`echo.db-wal` 恒定 4,144,752B(≈1006 帧,`wal_autocheckpoint=1000`)、mtime 一直前进,而 `echo.db` mtime 冻在 14:42:13;`lib/` 下无 `.iterate()` ⇒ 排除插件自己持读快照。风险:`-wal` 损坏则这段时间的审计/outbox/状态全丢 | 现象已复现,原因未定 |

## 族 C:闸认元数据,而某条路径不填元数据(静默降级)

| # | 隐患 | 证据 | 标签 |
| --- | --- | --- | --- |
| C1 | 「他的话」有两张 form 表,必然漂移 | `lib/turn-query.js:25` `HUMAN_FORMS=['relay','care']`(决定这轮要不要注入记忆)对 `lib/relay.js:211` `VOICE_FORMS=['care','reminder','mind']`(决定这轮算不算她主动开口):集合不同、互不引用、无共用注册表。新增 form 只改一处 ⇒ 静默降级(建议收成一张 fail-loud 注册表) | 推断 |
| C2 | 她主动开口的轮次,历史上一次记忆都没注入 | `a165b0d0` 8 个只含 `plugin/-@dsh-echo`(CARE/REMIND,form 缺省)的轮,快照 0 块;与 `lib/heartbeat.js:169` 今天才补的 `form:'care'` 及注释逐字吻合 | 已复现(今天之后 care 轮还没有新样本) |
| C3 | QQ「只发图不配字」的入站,那一轮零记忆 | `session-echo-companion` 09/26 01:09–02:50 的 11 个 relay 轮 `rawText` 全 0 字、同轮快照 0 块(14:22 起 rawText 2~17 字、每轮 1 块)。闸在 `index.js` `query===''` 即 return | 历史已复现,现状推断 |
| C4 | `finishTurn`/`captureSegment` 不在会话范围闸内 | `lib/index.js` 的 `sessionEnabled` 早退只在 user/message 分支;`relay.js:441-446` 会话无渠道即退全库 ⇒ 范围外会话(工作会话/引擎子会话)的回复会落到他 QQ 私聊。`relay.js:344-346` 注释与实现矛盾(doc drift) | 推断(现场 `pushLocalTurns=false` ⇒ 今天不触发) |
| C5 | `echo_qq_say` 绕过主动范围闸与保鲜期 | `relay.js:560-581` 只有 `kind==='proactive'` 才过 `proactiveScope`/渠道过滤、才设 `expiresAt`;`relay-tools.js:132` 把 `echo_qq_say` 映射成 `mode='reply'` ⇒ 她能在 `groupProactive:false` 的群里发、往任何 enabled 渠道发,且不吃 TTL | 推断 |
| C6 | 配置缺失/损坏 ⇒ 失败「开」 | `lib/toggle.js:36/55-56` 两处回退都是 `{enabled:true, scope:'all'}` ⇒ 插件在她**所有**会话里开(含工作会话与 exempt);relay 侧仍失败关闭 ⇒ 不漏 QQ | 推断 |
| C7 | 未知设置键被静默丢弃 | `normalizeSettings`(`lib/toggle.js`)会丢未知键 ⇒ 版本降级/回滚时设置无声消失 | 推断 |

## 族 D:主动关怀的后路(时间与丢弃)

| # | 隐患 | 证据 | 标签 |
| --- | --- | --- | --- |
| D1 | 主动消息 TTL 过期被丢时没人记 | `store.js:1393-1398` 过期行标 `dropped_at`,`lease()` 返回 `dropped`,适配器侧完全不读(`main.py` 无 dropped 字样),插件侧只有面板计数 ⇒ 「她主动说的话被时间丢掉」不留审计 | 已复现(代码 + 计数存在) |
| D2 | 迁移无版本号 + 逐条吞 ALTER ⇒ 静默降级 | 活库 `PRAGMA user_version = 0`;`store.js:297-348` 靠 `table_info` + 逐条 ALTER,失败一律 `catch {}`;`store.js:1399` 自承「列缺失:老库还没迁移,跳过」—— 那条正是**过期闸** ⇒ 缺 `expires_at` 时旧关怀照发 | 推断 |
| D3 | `relay_outbox` 只写不删;`relayPruneInbox` 是死代码 | 全仓无 `DELETE FROM relay_outbox`;活库 34 行全 `acked`、最早 01:09、正文全文留存;`relayPruneInbox`(`store.js:1265`)除 export 外无调用点 | 已复现(行数 + 代码) |

## 族 E:退役闸看不见卫星(挡住 R4 的那条,最要紧的操作风险)

| # | 隐患 | 证据 | 标签 |
| --- | --- | --- | --- |
| E1 | dry-run 判「✓ 可以归档」,而卫星还在写 | `scripts/retire-a-side.mjs:141-153` 漂移只采样 memory.db 五表、新鲜度只看 `-wal`;活体状态库**没有 wal**。今天 14:56 dry-run 末行「✓ 可以归档」,而 `plugin_data\astrbot_plugin_agent_state\state.db` mtime = 14:21:31(memory.db 冻在 01:15) | 已复现 |
| E2 | 唯一能查双脑的 preflight 不在计划步骤里,且只看两个插件 | `docs/RETIRE_OLD_CHAIN_PLAN.md:122-133` 全文一次没提 `npm run preflight`;`r4-preflight.mjs:160-161` 只判 echo_relay / memory_middleware ⇒ 卫星活着也全绿 | 已复现 |
| E3 | 电池把退役闸的真实缺口挡住了(测试骗人反例) | `tests/retire.test.js:37-40` 夹具给两张库都造了 `-wal`(活体状态库没有);`:75` 共用 `run()` 默认 `--fresh-seconds=0` 关掉新鲜度闸 ⇒ 全绿的同时「无 wal 的 state.db 还在写」无人验 | 已复现 |
| E4 | 老链路与新链路「两边都记账」没有自动发现 | adapter 全仓只有 `main.py:17` 一句注释提双脑,没有运行期比对;插件侧也不看 A 侧 ⇒ 老脑被重新启用后,直到下次人工跑 merge/preflight 才发现 | 推断 + 已复现(卫星写入) |

## 族 F:老数据里的死列/脏值(低危,但会误导排序与统计)

| # | 隐患 | 证据 | 标签 |
| --- | --- | --- | --- |
| F1 | graph 节点激活值/内在价值是死列 | 24/24 `graph_nodes.activation=0`、`recall_count=0`、`intrinsic_value=0`,而 `last_accessed` 全 >0;对照 `graph_edges` 17/35 `recall_count>0` ⇒ 任何按这些列排序/加权的逻辑对所有节点等价 | 已复现 |
| F2 | `layer` 列混入非层值 | `episodic_memory.layer`: `reflection`=84、空=66、`L2`=49、`L0`=17、`L1`=12 ⇒ 按 `L0` 过滤漏 150 行(`memoryStats` 的 L0 只数到 17) | 已复现 |
| F3 | 图的 `occurred_at` 全是 0 | `graph_nodes` 24/24、`graph_edges` 35/35 `occurred_at=0`(0 当「未设置」哨兵),`temporal_status` 全 `time_unknown` ⇒ 图没有任何时间依据,而 0 与真实 epoch 同型 | 已复现 |

## 查过但不成立(别重复怀疑)

心跳的 `ticking` 有 try/finally(`heartbeat.js:200-270`);反思的 `reflecting` 在
`.finally` 复位且有 `.catch`(`index.js:1211-1220`);`writeConfig` 是原子写
(`toggle.js:61`);`npm run accept` 探针只读不 lease(`relay-accept.mjs:194`);
`x-echo-edit` 在 `lib/client.js` 5 处与 `web/app.js:32` 都在;`retire-a-side.mjs:58-67`
的库/配置路径与活体一致;`smoke_relay.mjs:28` 用临时库跑完即删;
`subagent/catalog`、`agent/inbox/spliced`、turn/step 边界、`request/header`、
`tool/call` **全部 0 条带 `surfaceOp`** ⇒ 不进 history、不累积(系统提示词 8 条
靠 replace 自我替换,只留最新 1 份);37 个电池文件没有「assert 少于 test」的空验
(只 `sidecar.test.js:107` 一处 typeof-only)。

## 修的顺序(建议)

1. **族 E 先于一切** —— 它决定 R4 能不能安全走:退役闸改看每个库**自身** mtime
   (不只 `-wal`)、把 `agent_state`/`setu` 纳进 preflight、补上电池那一格。
2. **族 B 一次改完** —— `store.js` 加事务 + outbox 用 `UPDATE … RETURNING` 原子
   认领 + ack 幂等键,一次改动覆盖 B1–B4;B5 把四处空吞改成「至少写一行日志」。
3. **A2/A3** —— 工具结果加字节闸(超出落文件 + 摘要),别让它继续当压缩的第一批
   牺牲品。
4. **族 C** —— 两张 form 表收成一张 fail-loud 注册表(C1),顺带修 C4/C5 这两条
   「可能漏到 QQ」的闸。
