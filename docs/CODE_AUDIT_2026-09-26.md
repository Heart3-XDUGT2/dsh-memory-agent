# 全仓审查 2026-09-26 —— 卫生与功能问题

**起因**:他问「细致审查一下全体代码,查找有没卫生或者功能问题」。
**做法**:八个只读子代理分片通读(`lib/` ~12k 行、`python/engine` 3.7k、`scripts/` 4.6k、
`web/` 1.3k、`astrbot_adapter/` 2k、`tests/` 12k),加我自己一组机械扫描
(垃圾文件 / 孤儿模块 / 调试输出 / 裸 `except: pass` / 可变默认参数 / 硬编码绝对路径 / 定时器重复启动)。
**纪律**:审查本身只读;发现的问题**我先独立复核**(下面每一条都带我自己复核过的证据),
确认是 bug 的当场修掉并配沙袋电池(把修复回退,电池必须红);凡不能复核的一律标「待判」。

结论一句话:**主脊梁是通的,但"面板上的东西到不了代码"这一类病一次抓出三处** ——
它们全都不报错、不留日志,肉眼看配置项"存在且数值一致",所以能一直藏着。

---

## 一、当场修掉(每条都配了"会红的电池")

### A1 [高·我自己的 bug] 测试会写进他的真实配置
`tests/toggle.test.js` 顶部曾有一行**静态** `import { normalizeSettings } from '../lib/toggle.js'`。
`lib/toggle.js` 的 `CONFIG_PATH` 是**模块级常量、按首次 import 时的 `DSH_HOME` 定死** ⇒
那行先于 `process.env.DSH_HOME = tmpdir()` 执行,于是整套电池的 31 处写操作**全落到
`~/.dsh/echo/config.json`**:他的 `settings.relay.token` 被写成测试占位值 `good`,还多出一块顶层垃圾 `relay`。
后果是 QQ 中继静默 401(适配器侧令牌与壳侧不一致),而他只会看到"她发不出话"。

- 修复:去掉静态 import,改用例内动态 import;`freshToggle()` 里加闸 —— **每一次**都断言
  `mod.CONFIG_PATH.startsWith(tmpdir())`,不成立当场炸并说明怎么改。
- 为什么是"每一次":第一版只验第一次,我沙袋时亲眼看到「第一次抛了、后面 16 条照跑照写」——
  真实配置又被写脏一次。第二版改成每次都验,沙袋下去 17 条全红,一个字节都出不去。
- 证据:跑完整套电池前后 `config.json` 的 mtime 与 token **完全一致**
  (`19:04:04.040` / `echo-d12632a5feae962325018624d20ed8c6`)。
- 已把他的配置恢复原样(备份 `~/.dsh/echo/config.json.pre-audit-restore.bak`、
  `…pre-restore2.bak`),令牌与适配器侧 `astrbot_plugin_echo_relay_config.json` 一致。

### A2 [高] `normalizeSettings` 漏掉两个键组 ⇒ 面板开关是假的
`lib/toggle.js` 的归一化返回值里**没有** `longing.must_say`,也**没有整组** `compaction`:

```
normalize 产出 48 项
longing.must_say 在不在: false
compaction 组在不在: false
读出来 must_say 的值: undefined
读出来 compaction 的值: undefined
```

后果两条,都不报错:
- `readSettings().longing?.must_say !== false`(index.js)恒真 ⇒ 面板上的「想念必须说出口」**永远关不掉**;
- `readSettings().compaction` 恒为 `undefined` ⇒ `lib/compaction.js` 只拿到 `{}`,
  「压缩改走策展块」关不掉、`budgetTokens` 改了不生效。

为什么电池没抓住:原来只有「字段表 ↔ 默认值」和「normalize 幂等」两条断言,
而漏键对这两条都**同时隐形**(漏的键在默认值里在、幂等也稳定)。
- 修复:补 `must_say` 与 `compaction{curated,budgetTokens}` 的钳位;`writeSettings` 的嵌套合并
  从 2 组补到 7 组(否则任何"按字段 patch"的调用方会把同组其它键打回默认)。
- 新闸:`tests/settings-fields.test.js` 加「字段表键集 == normalize 产出键集」逐键相等。
  沙袋(把 `must_say` 换成别的名字)→ 红,报错直接点名 `longing.must_say`。

### A3 [高] 想念九项里七项到不了引擎(键名 camelCase vs snake_case)
`lib/engine.js` 四条 longing 帧**原样转发** settings(snake_case),而
`python/engine/longing.py` 的 `merge_config` 读 camelCase(`halfLifeHours`、`msgDrop`、`careRelief`、
`protestKick`、`cooldownMinutes`、`nightHold`、`demoRate`)⇒
**九项里只有同名的 `enabled`/`threshold` 生效,其余七项永远走 DEFAULTS**。
数值两边本来就一致(所以肉眼看不出),差的是键名 —— 面板上调半衰期/冷却/夜间静默,
她那边一点变化都没有。
- 修复:`LONGING_KEY_MAP` + `longingFrameConfig()`,四个帧(tick/message/care/check)全过它。
- 新闸:`tests/longing-config-keys.test.js` 走**真接线**(给引擎注入一个假 client,直接查发出的帧),
  断言四条帧的 `config` 逐个键都是引擎认的名字。
- 我第一版电池只测了翻译函数,**沙袋没炸**(把帧里换回原样转发照样绿)—— 正是审查里批的
  "测了复制品没测产品";改成注入 client 的真接线后,沙袋立刻红。顺带在 `createEngine` 上留了
  `clientOpts.client` 这个测试缝,以后"帧里到底发了什么"都能直接被断言。

### A4 [高] 自由文本里的 `{{…}}` 会打死整轮
宿主 `dsh-system-prompt/lib/index.js:164-167` 对**每一节**跑严格插值:遇到未注册的
`{{名字}}` 直接 `throw new Error('unknown prompt variable …')`。而我们往提示词节里塞的
全是自由文本 —— 他的原话、她被打断的残句、LLM 摘要、审计行、人格资产、渠道标签。
他只要在 QQ 里打一句 `{{随便}}`,那一轮就整轮失败;更糟的是那份快照会在窗口里
反复重现(242 个压缩点还在),**连续多轮收不到回复**。
- 修复:`escapePromptBraces()`(`{{` → `{ {`),用在 `echo:snapshot` / `echo:persona` /
  `echo:rules` / `echo:relay` 四处注入路径上。**只转义注入的那一份**,审计/面板/落库仍是他的原话。
- 我的第一版转义不彻底(`{{{x}}}` 替换后又会拼出相邻 `{{`),是电池当场抓到的;
  改成按"连续 `{` 整段"拆开,并加了任意长度的用例。
- 沙袋(把 `sectionOf` 的转义拿掉)→ 红。

### A5 [中] 议题兴趣:数组被当字符串切,`['` 进她的开场
`agenda.pick` 只认字符串(`str(interests).split(",")`),而壳侧发的是数组
(`listOf(herInterests)`)⇒ 议题文本会带着 `['`、`']` 直接进她的开场白。
- 修复:`agenda.py` 认 list/tuple,并剥掉两侧的方括号与引号;两种形状实测都得到 `写代码`。

### A6 [卫生] 装机副本把测试与本机缓存一起搬进宿主
`scripts/install.mjs` 整目录 `cp(python/)`,`package.json` 的 `files` 也含 `python/` ⇒
实测装机位里有 `python/tests`(**12 个文件**)与 **24 个 `.pyc`**。
坏处:污染宿主的 `node_modules`;让"装机副本 vs 仓库"的字节比对失去意义;测试里的假数据/假钥匙跟着分发。
另外 `scripts/hygiene.mjs` 把 `__pycache__` 放进了 `SKIP_DIRS`,于是它自己那条专查
`__pycache__|.pyc` 的垃圾闸**永远命中不到**(自废)。
- 修复:`install.mjs` 复制 `python/` 时过滤 `tests|__pycache__|*.pyc`,并清理上一次装机留下的残渣。
- 证据:重装后装机位 `python/tests` 不存在、`.pyc` **0 个**、`worker.py` 在、`engine/` 13 个 `.py`、
  `install.mjs --check` 通过。

### A7 [卫生/文档] 一批漂移与文案
- `web/index.html` 导航缺 `#th`(悬置话题)与 `#cfg`(调参)两个锚点 —— 这两节都是 v0.22.0 新加的,
  加完忘了挂导航;已补。
- `web/index.html` 想念提示写「阈值起步 5.5」,实际默认 **7.0**(下限 4.5);已改。
- `README.md` 字段表一行与 `lib/client.js` 注释写「调参 34 项」,实际 **51 项**;已改。
- `docs/PORT_GAP_AUDIT_2026-09-26.md` 里**我自己写反**的两行:A 的 `audit_keep` 是 **200**
  (`_conf_schema.json` 实测),B 是 **100**(有意留少一半,`tests/toggle.test.js` 钉着),
  文档却说 A 100 / B 200,理由("留多一点")也是反的;`inject_top_k` A 默认 **3**(网关另写死 8)、
  B **6** 也是有意的差并已被用例钉着。两行都已按两侧源码更正并注明"曾被写反"。

### A8 [高] 关怀日上限的真相源被自己裁掉(store 片)

`lib/store.js` 的 `trimAudit()` 每次写审计都把 `audit_logs` 无差别裁到最近 100 行,
而 `careCountSince()` 正是从这张表里数「今天(本地午夜起)主动开口几次」,
`heartbeat.js:276` 用它挡 `CARE_DAILY_CAP = 3`。

**活库只读实测**:`audit_logs` 恰好 100 行(= keep)、**全部是当天**(02:41:55~19:11:42)、
`care` 行只剩 1 条 ⇒ 当天早些时候的关怀行已被自己删掉 ⇒
**一天最多主动开口三次这条护栏越到晚上越数不准,静默失效**(她能一天喊他超过三次)。

- 修复:裁剪切出一个例外 —— **当天的 `tool_call='care'` 行永不裁**(每天最多 3 条,增长可忽略);
  其余行照旧只留最近 `keep` 条,面板与导出的体量不变。
- 新闸:`tests/store.test.js` 的「日上限真相源」用例 —— 先写 3 条关怀 + 60 条日常,
  断言 `careCountSince(午夜)` 仍是 3、而普通行照旧裁到 20。沙袋(把例外去掉)→ 红。
- 顺带把 `trimAudit` 那句"审计是**唯一无界增长**的表"的注释改对:
  `relay_outbox` 也在无界增长(见 B43)。

### A9 [中] 面板「画像字段 N 项」数的是表行数,恒为 0/1

`profileFields` 原实现是 `COUNT(*) FROM user_profile`,而这张表是「一人一行、
字段都塞在 `core_traits` JSON 里」的形状 ⇒ 恒为 0/1。活库实测该行 `core_traits='{}'`,
面板却显示「画像字段 1 项」。
- 修复:改成数 `core_traits` 的键数(解析失败按 0)。
- 新闸:`tests/store.test.js` 用例 —— 空画像 0、写入 `语言`/`代词` 两个常驻项得 2、
  逐个删回 0;顺带修正旧 G22 用例里那条 `profileFields === 1` 的断言
  (它以前钉的是错语义,`setName` 写的是 `name` 列不是常驻项)。沙袋 → 红。

### A10 [中] 引擎对自己 DDL 里没有的表做无保护 DELETE

`python/engine/episodic.py` 的 `clear_all` 直接 `DELETE FROM user_profile`(无 try),
而 `user_profile` 是**壳拥有的表**、引擎 DDL 里没有(`test_ddl_parity.py` 也把它列在 `JS_ONLY_TABLES`)。
- 复核:引擎自建库实测 `user_profile` 不存在,旧写法当场
  `OperationalError: no such table: user_profile`(已复现)。
- 修复:抽 `_delete_profile()`,缺表按 0 处理(引擎侧全仓本来就没有任何 SELECT user_profile,
  即"没得删"),真库照删不误;两种库都实测过。

---

## 二、已经查清、**没修**(给他决定;都附文件:行与建议)

> **补:v0.25.0(2026-09-26 夜)已修掉其中三条** —— B3、B17、B28。
> 起因是他发现「最近几条 QQ 走的是 astrbot 的线路」:桥的 401 让消息落到 AstrBot
> 原生链路,由 A 侧另一个 Echo 冒名答了 85 分钟。详见 `CHANGELOG.md` 的 v0.25.0
> 与 `astrbot_adapter/README.md` 里那张「桥关着 / 桥坏了」对照表。
>
> - **B3** 已修:dup 按成功办(掐事件、不补"我有点忙"),电池
>   `test_duplicate_is_a_success_not_a_gave_up`(破坏 → 红)。
> - **B17** 已修:`install-adapter.mjs` 先归档旧副本到 `data/echo_adapter_backups/`
>   (放 `plugins/` 之外,免得被 AstrBot 多扫一份同名插件)。
> - **B28** 已修,而且比原建议更狠:401 不再放行原生链路(挡下 + 兜底话),
>   静默期按原因分「挡人/放行」,并退避 + 限流日志;
>   DSH 侧同时给出拒签计数(`/api/echo/health` 的 `relay` 字段 + 面板告警)。
>   电池:`test_auth_401_never_lets_another_llm_impersonate_her`、
>   `test_auth_gate_blocks_without_asking_dsh_again`、
>   `test_scope_off_gate_still_lets_the_native_chain_answer`、
>   `test_401_poll_backs_off_and_stops_spamming`(四条各做了破坏验证)。

### 高危(建议尽快)
| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| B1 | `python/worker.py:972` | `verdict = handle(frame, state)`,而多处 `int()/float()` 转换在每帧 try 之外(`:173/:638/:662/:810/:836/:861/:915/:186`)⇒ 一个坏帧就能让侧车整个死掉(壳侧表现为引擎离线) | 整帧包一层 try/except,回 `{error}` 而不是崩进程 |
| B2 | `judge.py:565-570` | 钳位只 catch `(TypeError, ValueError)`;`round(float('inf'))` 抛 **OverflowError** 漏网 | except 里加 `OverflowError`,或先判 `math.isfinite` |

### 中危
| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| B3 | ~~`astrbot_adapter/main.py:287-292 / 322-324`~~ **已修(v0.25.0)** | 幂等重放(200+duplicate)落进「送不进去」分支:掐事件、发兜底话「我这会儿有点忙」——而 `relay_core.py:337` 的契约写明 200+duplicate 应当**当成功** | dup 与 ok 同路;400 才走 gave_up |
| B4 | `lib/relay.js:54` ↔ `lib/index.js:111` | `MAX_IMAGE_DATA=12MiB` 与 `readBody` 的 `>65536` 上限矛盾 ⇒ 带图的信封 body 变 null → 400 → 撞上 B3,**他这条消息连图带字全丢** | 两侧对齐(要么抬 body 上限,要么改由多段上传) |
| B5 | `lib/graph.py:774-777 / 827-838` | `update_and_persist` 物化+剪枝三条 SQL **无 `owner_key` 过滤**,会删别的归属者的边(与同文件 `load` 的 `WHERE owner_key=?` 和文件头自述矛盾) | 加 `owner_key` 参数并逐条过滤 |
| B6 | `graph.py:846-849` | 裸 `except Exception` 把整轮失败吞成**成功形状**(changed/pruned=0),未 commit 的强化全丢;触发口含 `:826-831` 未分片的 `IN (…)` | 分批 DELETE;失败回 error 帧 |
| B7 | `heartbeat.js:225` | `pendingCare` 只按 sessionId 配对,而 `echo_qq_call` 也落 `kind='proactive'` ⇒ 她"喊一声"的 ack 会替未送达的关怀销账 | 用 ack 行里的 turnId/outbox id 配对 |
| B8 | `heartbeat.js:257` | `threadsMark` 返回值不检查,引擎帧失败返回 null 被静默吞 ⇒ 同一条约定的提醒**每分钟重发一次**到他手机 | null 时 warn 并留在池里 |
| B9 | `heartbeat.js:276/319` | 日上限读的是"入队"审计行,与 C5「送到才算说过」冲突 ⇒ 掉线时空送三次也能把当天额度用光 | 改按 send_ok 审计行计数 |
| B10 | `turn-query.js:29` | 提醒轮不算"人话"(`HUMAN_FORMS={relay,care}`),heartbeat 专门传的 rawText 成死数据;该轮检索为空或沿用旧查询词 | `HUMAN_FORMS` 补 `'reminder'` |
| B11 | `turn-snapshot.js:85-88` | `forget()` 全仓零调用(死代码),`queries` 只写不删 ⇒ 没有 claim 的轮次会拿上一轮甚至几天前的查询词检索 | 轮末清该会话查询词 |
| B12 | `judge.py:129/201`、`longing.py` 同类 | `bool("false")` → True(手写配置 `"false"` 会变开) | python 侧也做 `"false"/"0"` 归一(JS `boolOf` 已归一,当前不可达) |
| B13 | `judge.py:782-787` + `episodic.py:26-34` | fallback 路径不传去重阈值 | 与主路径对齐 |
| B14 | `scripts/merge-astrbot.mjs:328` / `graph-merge.mjs:173` / `memory-dedupe.mjs:104` | `--write --json` 时 `finish()` 先 `process.exit(0)` 再执行落库 ⇒ **一个字节都不写却退 0**,报告里还写 `write:true` | 写入段挪到 asJson 之前,或两标志互斥报错 |
| B15 | `scripts/import-astrbot.mjs:59-63` | `--fresh` 无备份无确认直接 `rmSync` 真库三件套;而同脚本非 fresh 又拒绝重复导入 ⇒「重导 = 删真库」 | 先备份到 `backup/` 再删 |
| B16 | `scripts/graph-merge.mjs:195-212` | `--apply` 的合并循环不在事务里,中途抛错留下「节点已墓碑、边没改指」的半并状态 | 包 `BEGIN IMMEDIATE`/`ROLLBACK`(照 merge-astrbot) |
| B17 | ~~`scripts/install-adapter.mjs:75-79`~~ **已修(v0.25.0)** | 递归删 AstrBot 插件目录里的旧装机副本,无确认无备份 —— 他在插件目录手改过的 `main.py`/`_conf_schema.json` 一并消失 | 先归档到 `data/echo_adapter_backups/<名字>-<时间戳>/`(放 `plugins/` **之外**:放里面会被 AstrBot 多扫一份) |
| B18 | `scripts/install.mjs:279-282` | `--remove` 删 `.dsh-echo-local/` 却留着仍指向它的 `pnpm-lock.yaml`(`dsh-echo@file:./.dsh-echo-local/…tgz`)⇒ 悬挂依赖,下次 install 失败 | 一并处理 lock 条目或明确提示 |
| B19 | `install-preset.mjs:58-59` | `--from ptc`(空格写法)过了 known 校验却静默回落 standard;只有 `--from=ptc` 生效 | 两写法都认,或直接报错 |

### 低危 / 卫生
| # | 位置 | 问题 |
|---|---|---|
| B20 | `web/app.js:553` + `lib/index.js:2258` | 设计上"写-only"的桥令牌被 POST **回显**进前端状态与 DOM(`cfgForm = r.settings` 含明文 token),与 `index.js:2231` 的注释自相矛盾 ⇒ 建议 POST 只回 `{ok:true}` 或同 GET 一样抹成 `''` |
| B21 | `web/app.js:609` + `:21-25` | 10s 轮询无 in-flight 闸、fetch 无超时:慢请求会叠批,旧响应可覆盖新内容 |
| B22 | `web/app.js:600` + `index.js:2577` | SSE 报错时显示「重连中…」但**永不重连**(库离线时该路由 404,EventSource 对非 200 直接 fail) |
| B23 | `web/app.js:437-451` | 「清空上下文」要几十秒,而 10s 轮询会把按钮/结果节点整块重画 ⇒ 结果永远看不到、还能重复提交 |
| B24 | `web/app.js:580-583` | `Promise.allSettled` 的 rejection 无人处理:失败的那一段永远停在「加载中…」,控制台也没日志 |
| B25 | `lib/client.js:734/751` | 用了未定义的类名 `echo-field-hint`、`echo-error`(CSS 里不存在)⇒ 传话卡错误提示无样式 |
| B26 | `lib/client.js:70-121`、`:669-674` | 六个看板撤走后的死 CSS 与一个从未被调用的 `load()` |
| B27 | `sidecar-client.js:315-327` | 注释声称的 1MiB 防线**不可达**:体积检查在 `while(indexOf('\n'))` 循环体内,无换行的病态流会无限增长 |
| B28 | ~~`main.py:397-400`~~ **已修(v0.25.0,比建议更狠)** | 401 时 `_gate.pause()` 只被入站查,出站循环照跑 ⇒ 令牌错时每 2s 刷一条 error 日志 | 401 期间**挡住入站**(不放行原生链路,否则别的 LLM 冒她的名)、退避到 60s、日志第 1 次 + 每 5 分钟;DSH 侧加拒签计数与面板告警 |
| B29 | `main.py:489-493` | 分段发送不记进度:整条重试时已送出的前几段会**在 QQ 上出现第二遍** |
| B30 | `timeutil.py:32` | `text[:19]` 静默截掉时区再按本地时区解释(`Z`/`+08:00` 差 8 小时落进 `occurred_at`);`:112` 与 `:113-115` 加天方式不自洽 |
| B31 | `threads.py:212` | resolve 侧无最短长度闸,回「嗯/好」可能误关话题(登记侧有 ≥6 字规则) |
| B32 | `graph.py:31/187/287` | 「person 节点受保护」是**死分支**:全仓无一处写 `node_type='person'`(活库全是 concept) |
| B33 | `db.py:250-253/317-323` + `worker.py:94` | 每个业务帧 `connect()` 都跑四条全表回填 `UPDATE` 并 commit ⇒ 每帧拿一次写锁 |
| B34 | `reflect.js:368`、`curation.js:65`、`diary.js:61`、`export.js:30`、`say-again.js:41`、`interrupted.js:24`、`proactive-ack.js:38` | 截断按 UTF-16 切,emoji 会被切成半个代理对(`bubble.js` 特意用码点对齐 Python —— 这几处没有) |
| B35 | `toggle.js:64` | 配置损坏时静默 `keep={}`,下一次任意写入会把 `whitelist/exempt/sessionLabels` 一并抹掉 |
| B36 | `webpage.js:108-111` | 与 `:79` 注释不符:catch 一律 404,吞掉 EACCES/EISDIR |
| B37 | `compaction.js:75` | `estimateTokens('x'.repeat(chars))` 为一次除法复制整段输入,并绕开 `curation.js` 的 `CHARS_PER_TOKEN` |
| B38 | `relay_core.py:110` | 兜底幂等键 `abs(hash((chat_id,text,int(now))))` 跨进程加盐且按秒变(自述"随机键等于没有幂等") |
| B39 | 4 处硬编码他机器路径 | `import-astrbot.mjs:26`、`merge-astrbot.mjs:54`、`install-adapter.mjs:23`、`smoke_shared_soul.mjs:24`;同仓 `r4-preflight.mjs:31` 已有正确写法(`ASTRBOT_DATA ?? ~/.astrbot/data`) |
| B40 | 默认值散落两份 | `say-again.js:27-28`、`drift.js:180/222`、`compaction.js:51`、`curation.js:83` 各写一遍,toggle.js 里又一遍 ⇒ 改一处不带另一处 |
| B41 | 注释与实现不符 | `reflect.js:9`(说砍了 say_again,实际有)、`emotion.js:60`(说没调用方,实际 turn-snapshot 在调)、`turn-snapshot.js:43-48`(说 10250,实际 10275)、`heartbeat.js:20-24`(说关怀轮不注入,实际已改)、`turn-stopping.js:117-119`(注释说绝不 await,实现 await 了) |
| B42 | 死代码 | `index.js:160` 的 `queryOf`(被 `:2003` 局部实现遮蔽)、`context-clear.js:62-71` 的 `clearLabel`、`turn-snapshot.js:85` 的 `forget`、`store.js` 的 `relayPruneInbox`(导出但全仓无调用) |
| B43 | `lib/store.js:1433/1722` | `relay_outbox` **只写不删**(全仓没有一处 `DELETE FROM relay_outbox`),活库 39 行全留正文 —— 与"审计是唯一无界增长表"的自述矛盾(该注释本轮已改对) |
| B44 | `lib/store.js:205/207/210` vs `python/engine/db.py:229/231/234` | `graph_edges` 三个引擎列默认值两边漂移:壳 `intrinsic_value DEFAULT 0` vs 引擎 `DEFAULT 10.0`;壳 DDL `slot/layer TEXT`(NULL)vs 引擎 `DEFAULT ''`,而壳自己的 ALTER 路径又与自己 DDL 不一致。`retrieve.py:150` 用 `or 10.0` 兜住了读数 ⇒ 现在是语义漂移+隐患。**parity 测试照不到**:`test_ddl_parity.py:133-142` 对共有表只比列名子集,不比默认值 |
| B45 | `lib/store.js:1546-1550` | `last_out_at` 在**入队**时写,面板当「最近回话」显示;`relayAckOutbox`/`relayCancelBubbles` 都不更新它 ⇒ 从没发出去的话也算"回过话" |
| B46 | `lib/store.js:745-749` | `setAuditKeep` 无生产调用点(注释自称"面板改动后调用")⇒ 面板改 `auditKeep` 必须重启才生效 |
| B47 | `lib/store.js:1766` | `clampAuditKeep` 仍是 v0.22.0 修掉的 `Number(null)=0` 坑(静默钳成下限 20 而非回默认);`toggle.js` 的 `clampNum` 已修,这个本地副本没跟 |
| B48 | `lib/thread-dedupe.js:53` vs `threads.py:76` | `toLowerCase()` vs `casefold()`(ß→ss 这类会分叉;中文语料下影响≈0,但"逐字镜像"要留注) |
| B49 | `episodic_memory` 缺列迁移 | 只迁移 `status` 一列,而注释自称老库可能缺 `speaker_id`/`memory_key`/`learned_at` —— 真遇到会让 `insertMemory`/`getProfile` 抛(缺列只被三行索引 try 吞掉)。**要人判**:v0.4.x 形状是否真会出现 |

### 测试本身的弱点(会影响"绿"的可信度)
| # | 位置 | 问题 |
|---|---|---|
| T1 | `tests/relay-tools.test.js:80-88` | 断言的是测试**自己刚造的局部数组**(`out.length === 1`),产品代码从未碰过 ⇒ 恒真、零信息 |
| T2 | `tests/manifest.test.js:64-70` | 用**源码字符串搜索**代替行为验证(`src.includes('dsh.profile.bundles')`)⇒ 注释掉也绿 |
| T3 | `tests/events.test.js:189-210` | 同上:断言 `includes('try {')` / `includes('def due_snapshot')`,测文本不测降级行为 |
| T4 | `tests/say-again.test.js:197-206` | 「投递抛异常:吞掉」全篇没有断言,只靠"跑完不抛" |
| T5 | 假 subagents 契约假件抄三份 | `diary/engine/reflect.test.js` 各一份,`freshStore` 抄六处 ⇒ 宿主契约一变容易漏 |
| T6 | `tests/build-stamp.test.js:22-30` | 全程假 fs(`mtimeMs` 恒 1000),真实 `readdir/stat` 分支零电池 |

---

## 三、查过、确认**干净**的部分(这些不用再怀疑)

- **无 XSS**:`web/` 全程 `el()`/`textContent`,无 `innerHTML/insertAdjacentHTML/document.write`;
  `lib/client.js` 走 `React.createElement`(自动转义),无 `dangerouslySetInnerHTML`。
- **桥的安全面**:四个 relay 端点全部过 `relayGate`(常数时间比较、空 token 一律拒);
  reqId 严格配对,超时先删 pending 再 reject,迟到帧走 unpaired 忽略;租约 ack 才销账。
- **机械层面**:无 tracked 垃圾文件;`.gitignore` 覆盖 `node_modules/__pycache__/logs/data`;
  无孤儿 `lib` 模块;`lib/` 零 `console.*`;`python/engine` 零 `print(`;无裸 `except: pass`;
  无可变默认参数;无硬编码绝对路径(脚本侧 4 处已列 B39);`web/app.js` 只在 boot 时起一个 `setInterval`。
- **数值面**:想念九项/整固阈值的**值**与 A 侧逐值一致;`dmae.py` 公式与注释一致;
  `graph_activate` 单调收敛无溢出;`longing_curve` 有防除零;时间戳单位统一 epoch 秒。
- **主脊梁**:人格段/快照段接线、心跳投递、轮末硬保证在**宿主装机版代码里**逐条核对过
  (`runMaintenance` 返回值、`agentEvents` 融合 `agent`、`turn` 为数字、`renderPrompt` 插值),
  没有"整块静默失效";`echo:snapshot` 在真实系统提示词里确实出现。
- **电池纪律**:无 `.skip`/`todo`;桥与子代理都是注入点真跑;`test_ddl_parity.py` 有
  "故意拆一列证明比较器会红"的反向用例;`retire/rehearse/probe` 电池真跑脚本并按退出码断言。

## 四、未证 / 需人判(不许当"已验证"说)
- 侧车单帧崩溃(B1)、judge 的 `inf` 溢出(B2):静态读码推断,**没有现场复现**。
- 图谱 `owner_key` 缺口(B5):单用户下不可达,只在"导入器/未来 member 桶"接入时才危险。
- `superseded_by` 悬空、`apply_ltp` 的 `boosted` 不是 rowcount、`mark_used` 不看 rowcount:
  需要看面板/导出是否依赖这些数字才能定性。
- `main.py:512-516` 用 `context.send_message` 的返回值当"送达":宿主语义是"找到平台了吗",
  平台侧失败也可能为 True —— 与"发成功才 ack"的纪律是否冲突,需人判。
- `lib/relay.js:513-514` 的 `spokeViaTool` 若某轮没有配对 turn/end,标记会留到**下一轮**
  把整轮回复无声吞掉(该分支无审计)。
