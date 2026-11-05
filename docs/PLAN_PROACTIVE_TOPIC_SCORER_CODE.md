# PLAN(代码级):主动性 v2 —— 话题打分器

> 配套概念稿:`PLAN_PROACTIVE_TOPIC_SCORER.md`(原则/维度/禁语清单/分期)
> 本文是**照着真实表结构与函数签名**写的施工图。状态:**草案,未开工,未提交。**
> 原则不变:**念头不生成,只打分**;只有"过线 + 时机合适"才走现有那**一次**开口调用。

---

## 0. 已发现的既有资产(少写一半代码)

| 资产 | 位置 | 状态 |
|---|---|---|
| **`topicRepeatPenalty({prevTopics, topic})`** | `lib/thread-dedupe.js:87`(常量 77/79:penalty 0.5 / 相似度 0.6) | **已写、已有 5 条单测(`tests/topic-repeat.test.js`),至今未接线** —— `docs/PLAN_ROUND2.md:36` 白纸黑字:"接线到'开口前挑话题'未做" |
| `care-report.js` | `lib/care-report.js:2` 自述"纯函数、无任何 IO" | 打分器同一条先例:纯函数独立成文件 |
| 幂等补列惯例 | `store.js:389-397`(care_beats 补 `target_session_id`)、`366-373`、`377-388` | 迁移照抄,不引入 `PRAGMA user_version`(全仓 0 命中) |

---

## 1. 候选话题来源(**真实列名**)

| 类型 | 表/文件 | 关键列 | 过滤 | 产出字段 |
|---|---|---|---|---|
| 悬置话题 | `pending_threads`(建表 `store.js:160-171`,引擎镜像 `python/engine/db.py:24-35`) | `thread_id, user_id, content, status, follow_up_after, source_memory_id, session_id, last_mentioned_at, created_at, updated_at` | `status='open'` | `{id:'thread:'+thread_id, type:'thread', text:content, createdAt, lastMentionedAt, sessionId}` |
| 记忆 | `episodic_memory`(`store.js:58-90`) | `memory_id, summary, emotion_score(INTEGER), timestamp, is_active, status, layer, memory_key` | `is_active=1 AND status='active' AND summary!=''` | `{id:'mem:'+memory_id, type:'memory', text:summary, emotionScore, createdAt:timestamp}` |
| 图谱 | `graph_nodes/graph_edges`(`store.js:174-196`) | `node_id, name, node_type, is_active` | ⛔ 实测 28 条**全是 `concept`,belief 0 条** ⇒ `soul-snapshot.js:38` 的 beliefs 恒 0 | **P1/P2 不用** |
| 自由活动 | `diary`(`store.js:143-149`:`date PK, content, mood, longing_value, created_at`);真库 3 行 | `date, content, created_at` | 近 N 天 | `{id:'diary:'+date, type:'artifact', text, hasArtifact:true}` |
| 核心记忆/画像 | `episodic_memory` 的 `layer='L0'` 行 + `user_profile`(`store.js:50-57`)+ `~/.dsh/echo/persona.json` | `layer, memory_key, name, core_traits, affinity` | `layer='L0'` | `{type:'identity'}` |
| 关系账本 | `her_agenda`(`store.js:150-159`:`item_id, content, origin, source_ids, weight, created_at, last_used_at, is_active`) | 同上 | `is_active=1` | `{type:'agenda'}`;**JS 侧无读口**,只有引擎 `agendaPick(engine.js:593)` |

**真库样例(截断)**
- `pending_threads`:`{"thread_id":19,"status":"open","follow_up_after":1790812800,"session_id":"session-2d2a4aae…","last_mentioned_at":0,"created_at":1790731232.43,"content":"用户坐今晚10点的火车回家,预计…"}`(open 16 / resolved 3)
- `episodic_memory`:`{"memory_id":7,"emotion_score":9,"intrinsic_value":42.094,"timestamp":1789712378.9,"occurred_at":0,"temporal_status":"time_unknown","summary":"用户说以后会学做章鱼小丸子,并与Echo拉钩约定。"}`

### 1.1 缺字段清单(要加的列 + 加在哪)

1. `pending_threads.score REAL DEFAULT 0`、`pending_threads.score_at REAL DEFAULT 0`
   ⚠️ **必须同步改 `python/engine/db.py:24-35` 的 `_DDL`** —— 见 §3.1。
2. `care_beats.candidates INTEGER DEFAULT 0`、`top_score REAL DEFAULT 0`、`rejected_by TEXT DEFAULT ''`、`topic_id TEXT DEFAULT ''`
   (care_beats 是 **JS 独建表**,`python/tests/test_ddl_parity.py:37` 已列入 `JS_ONLY_TABLES` ⇒ 加列不用动 python)
3. 记忆侧**不加列**:时效/未结只能靠现列近似(见 §3.3)。

### 1.2 三条读数据的坑(施工时别踩)

- "悬了多久"**必须用 `created_at`**;`updated_at` 会被引擎到点逻辑改写(`python/engine/threads.py:87`)⇒ 用错会把"到点重算"读成"她提过了"。
- `follow_up_after=0` ⇒ 引擎**永不主动提**(`wake-tools.js:4` 注释),打分应据此降权。
- 悬置话题的**写不在 JS 侧**(`python/engine/threads.py:97/87/188/214`),JS 只经 `lib/engine.js:565 threadsRemindable / 570 threadsMark / 581 threadsIngest`;读用 `store.listThreads()`(993-1020,四态 waiting/due/done/untimed)。

---

## 2. 施工图

### 2.1 新文件 `lib/topic-score.js`

```js
export const DEFAULT_WEIGHTS = Object.freeze({
  unstale: 0.25, gap: 0.15, concreteness: 0.20, recency: 0.15, freshness: 0.15, emotion: 0.10
})
export function scoreTopic (topic, ctx)   // (topic,{now,weights,caps,prevTopics}) → {id,type,text,score,why:{dim:{value,weight,contrib}}}
export function pickTop (cands, opts)     // 纯:过滤 score>=minScore,稳定排序取 top-1;空 → null
export function timingGate (inputs)       // 纯:{now,lastUserAt,lastTopicAt,quotaLeft,cooldownMin,isNight} → {ok,reason,detail}
export function collectCandidates ({ db, now, sessionId, limit })  // 唯一读库:一次 SELECT 组卷
```

- 三个纯函数 ⇒ 无库无模型可测;只有 `collectCandidates` 摸库(可注 `:memory:`)。
- 新鲜度维度**直接 import `topicRepeatPenalty`**(`lib/thread-dedupe.js:87`)—— 白捡的功能。
- `why` 逐维贡献之和必须 **== score**(写进单测,保证可解释性)。

### 2.2 接进哪里(文件:行号)

care 通道全在 **`lib/heartbeat.js:523 async function tick(agent)`**:

| 行 | 现有行为 |
|---|---|
| 673-679 | `st.shouldCare !== true` → `logBeat('care', nightHold?'night-hold':'engine-says-no', st)` |
| 688-693 | `targetFor` / `no-target` |
| 697-703 | `daily-cap` |
| 712-718 | `pending-ack` |
| 719-731 | 选题:`engine.agendaPick` |
| 743-752 | 开口:`deliver(renderCareFraming(...))`(framing 在 `:182`) |
| 753-769 | `sent` + `payload:{agendaItemId}` |

- 台账写入:`lib/heartbeat.js:375 logBeat(kind,reason,st,{acted,payload,targetSessionId})` → `store.careBeatAdd`(`store.js:1266`)。
- **打分器插点**:在 673 之后、719 之前(此时 `targetFor`/`daily-cap` 已有账不重复落):
  `const top = pickTop(collectCandidates({db:store.db, now, sessionId}))`
- **默认不改行为**:`proactiveScoring.enabled=false`(默认)时 `top=null`,走今天一模一样的路;开启且 `top.score >= threshold` 才继续,否则落**新 reason `'no-topic'`**。
- **`value/threshold` 一个都不动**(`tests/care-beats.test.js:128-129` 钉着 `value=8.2/threshold=5.5`);新分数另开 `top_score` 列,同行双读数、语义不混。
- ❗ 全仓**没有** `lib/care-beats*.js` / `lib/care-gate*.js`(152 个 js 文件里只有 `care-report.js` 与 `heartbeat.js`);闸的实现**都在 tick 里**。

### 2.3 配置(三处连锁,漏一处开关就是假的)

1. `lib/toggle.js:299 SETTINGS_DEFAULTS` 加整组 `proactiveScoring{enabled:false, threshold:0.6, wUnstale:0.25, wGap:0.15, wConcreteness:0.20, wRecency:0.15, wFreshness:0.15, wEmotion:0.10, windowHours:72, cooldownMin:180}`;
2. `lib/toggle.js:531 normalizeSettings()` —— **必须在 551-680 的返回对象里加回整组**(`tests/settings-fields.test.js:130` 专抓这个坑);
3. `lib/settings-fields.js:97 SETTINGS_FIELDS` 加 group `{title:'主动开口打分', nested:'proactiveScoring', …}`,并同步:
   - a) `tests/settings-fields.test.js:76` 的 nested 白名单硬编码 → 加 `'proactiveScoring'`;
   - b) `indexOfDefaults`(27-35)**只拍平一层**且按 `typeof` 断言 ⇒ **`weights` 不能写成嵌套对象**;**用扁平标量键**(`wUnstale…`);
   - c) `tests/settings-fields.test.js:147-152` 钉着 `README.md:85` 的"调参 71 项" → 加字段必须同步改 README。
4. 面板 API **不用改**:`/api/echo/settings`(`index.js:3305-3344`)自动带出 fields/defaults。

### 2.4 DB 迁移(确切 SQL 与放置)

惯例 = `openStore()`(`store.js:354`)内 `PRAGMA table_info` + `try{ALTER TABLE ADD COLUMN}catch{}`。

**care_beats**(DDL `store.js:308-325`,`target_session_id` 之后追加):
```sql
candidates INTEGER DEFAULT 0, top_score REAL DEFAULT 0,
rejected_by TEXT DEFAULT '', topic_id TEXT DEFAULT '',
```
openStore 紧跟 389-397 那段加幂等补列循环(照 `target_session_id` 写法);`mapBeat`(`store.js:1285-1303`)补这四个键。

**pending_threads**(JS/引擎**共有表**):
```sql
score REAL DEFAULT 0, score_at REAL DEFAULT 0,
```
⚠️ `python/tests/test_ddl_parity.py:137-146 test_shared_tables_engine_is_superset` 要求"引擎列 ⊇ JS 列" ⇒ **必须同改 `python/engine/db.py:24-35`**,改完跑 `npm run test:py`(**它不在 `npm test` 里,最容易漏**)。

测试建库:`openStore(':memory:')`(`care-beats.test.js:23`)或自建 fixture DDL —— **旧形状 fixture 不会自动带新列**,凡在其上跑新写入的用例都要补列。

### 2.5 唯一那次模型调用(**复用,不新增**)

- 现有开口点:`lib/heartbeat.js:423 async deliver(agent,text,queryText,form)` → `agent.runMaintenance(() => agent.followup(createUserMessage({...})))`(426-429)。它**不直连 LLM**,是把消息排进她那一轮。
- 打分器只决定"走不走到 deliver"。**新增第二个调用点 = 违背"只有一次模型调用"**。
- 失败即不动(现成写法):投递忙 → 不开口(`deliver` 返 false → `logBeat('care','deliver-busy',st)`,770-773);超时降级 → `lib/emotion-score.js:227` 的 `Promise.race`(233-238),Abort 版 `lib/reflect.js:39 runSignal`。

### 2.6 审计

- 开口了:`heartbeat.js:767 auditCare('care','(想念主动关怀)',targetSid)` → `store.writeAudit`。
- **topic 细节不塞 `audit_logs`**(那是"她说了一句"的贵账),放 `care_beats.rejected_by` + `payload_json:{candidates,topScore,why}` —— `store.js:303-307` 注释把这张表的存在理由写死了:"她**没**说什么及为什么"。
- 两条会红的联动:① 新 reason 必须进 `lib/care-report.js:31 REASON_TEXT`,否则 `tests/care-report.test.js:195-209`(从源码抠 `logBeat(...)` 枚举)当场红;② 给 `careTrace` 加字段必须同步 `lib/index.js:656-676`(`additionalProperties:false`)。

### 2.7 测试

新增:`tests/topic-score.test.js`(六维单调/封顶/权重/空候选→null/全同分稳定/`why` 求和==score)、`tests/timing-gate.test.js`(表驱动:夜闸/空闲上下界/额度/同题冷却/冲突闸)、`tests/proactive-copy.test.js`(六类黑模式禁语哨兵,挂 `renderCareFraming`)、`tests/care-ledger.test.js`(四新列写入 + `rejected_by` 归因 + `mapBeat` 透出 + 老库幂等补列)。

会被改到的现有测试(grep 出的真名):`tests/store.test.js`(603 补列、580)、`tests/care-beats.test.js`(87-88、128-129)、`tests/heartbeat.test.js`(338/347)、`tests/care-report.test.js`(195-209)、`tests/settings-fields.test.js`(37/76/93-112/130/147 + README:85)、`tests/history-prune.test.js`(29)、`tests/dashboard.test.js`(41)、`tests/retire.test.js`(26 表级计数:加**表**会红、加列不会)、`python/tests/test_ddl_parity.py`(137-146)、`tests/topic-repeat.test.js`(复用其函数,不改也应重跑)。

### 2.8 分期(每期独立可回滚)

| 期 | 改动 | 验收 | 回滚 |
|---|---|---|---|
| **P1** | 新增 `lib/topic-score.js` + `tests/topic-score.test.js` + `tests/timing-gate.test.js`,**不接线不碰现有文件** | `npm test` 全绿 + `node -e` 只读喂真库两条 open 话题看分数表 | 删文件 |
| **P2** | `lib/store.js`(DDL+迁移+mapBeat+careBeatAdd)、`lib/heartbeat.js`(tick 插打分 + payload)、`lib/care-report.js`(REASON_TEXT 加 `no-topic`)、`lib/toggle.js`(默认+normalize)、`lib/settings-fields.js`、`python/engine/db.py`(两列)、`README.md`;加 `tests/care-ledger.test.js`;改上述 6 个 js 测试 | `npm test` + `npm run test:py` + 只读看 `care_beats.candidates/top_score/rejected_by` | 开关默认关 = 零行为变化 |
| **P3** | `lib/heartbeat.js:182 renderCareFraming`(主题+信息缺口行)、`lib/speech-guard.js:167 guardOutbound`(禁语哨兵)、`lib/care-report.js`(reply_rate/follow_up/revisit) | 新增 `tests/proactive-copy.test.js` | 文案回退,打分照旧 |
| **P4** | `lib/index.js:1169 companionCwd` 让自由活动真产出写盘 + 新增"活动产出"候选来源 | 无人值守跑出真产出 | 不注册该来源 |

---

## 3. 风险与需拍的点

### 3.1 共有表漂移(必踩)
`pending_threads` 加列必须同改 `python/engine/db.py:24-35`,否则 `test_ddl_parity.py:137` 红;而 python 套件**不在 `npm test` 里**。

### 3.2 `echo_status` 的 schema **现在就是坏的**(实测)
调用返回:`invalid output: "value.profile.derivedFromL0[0]" must be a string; "value.care" must match exactly one oneOf branch (matched 0)`。
根因:`heartbeat.js:322/332` 的 `careTrace()` **始终**带 `targetSessionId`,而 `lib/index.js:656-673` 的 care schema 没声明它(`additionalProperties:false`);另 `derivedFromL0` 声明成 string 但 `store.getProfile()`(`store.js:744-746`)返回对象。
⇒ **给 careTrace 加打分段之前必须先修这条**,否则新字段踩同一个坑(`npm run check:tools` 抓不到 —— 它的 care 夹具没带这两个键)。

### 3.3 时效维度几乎无料
`occurred_at` 实测全 0、`temporal_status` 多为 `time_unknown`、记忆**无 session 归属** ⇒ "是不是这两天的事"只能用 `timestamp`(写入时刻,非发生时刻)近似。

### 3.4 需用户拍
1. "只有一次模型调用"是否允许变成 care + 打分各一次?**我不允许**(复用 `deliver`,永不新增调用点);
2. 新枚举 `'no-topic'` 可接受吗?(开关打开后,白天那批 `engine-says-no` 会变成 `no-topic`,历史口径变);
3. `weights` 配置形状:扁平标量键(推荐)vs 单个 JSON 文本键;
4. P4 需要她真产出素材 —— 现在 `~/.dsh/echo/workspace` **是空的**、无产物表;概念稿 §4 那条"真做了 vs FOMO 钩子"的分界线**目前不存在**,要不要做、谁触发。

---

## 3.5 决定已拍(2026-09-30,用户拍板)

| # | 决定 | 落地形态 |
|---|---|---|
| ① | **折中**:本地分先跑,只有落在**边缘区**才花一次模型复核 | 两道闸:本地分 → `|score-threshold| <= reviewDelta` 才进复核;复核受**日额度**约束;复核只决定"说不说",**开口仍复用 `deliver`,不新增开口调用点** |
| ② | **加新 reason** | `no-topic`(本地没过)、`no-topic-after-review`(复核没过)、`pass-after-review`(复核通过并开口 ⇒ reason 仍 `sent`,payload 记 `reviewed:true`)。三者都要进 `lib/care-report.js:31 REASON_TEXT` + 枚举测试 |
| ③ | **扁平标量键 + 仪表盘可设置** | 见下方键表;四处连锁必改(toggle 默认值 / normalize / settings-fields / 测试与 README) |
| ④ | **P4 要做** | 但排在 P1–P3 之后;必须带 `self-activity` 来源标记 + 预算 + 静默 + 清理,不得污染主记忆 |

### 配置键(扁平,全部可在仪表盘设置)

`proactiveScoring`: `enabled`(默认 false)、`threshold`(0.6)、`reviewEnabled`(true)、`reviewDelta`(0.08)、`reviewBudgetPerDay`(6)、`wUnstale`(0.25)、`wGap`(0.15)、`wConcreteness`(0.20)、`wRecency`(0.15)、`wFreshness`(0.15)、`wEmotion`(0.10)、`windowHours`(72)、`cooldownMin`(180)。

连锁四处:`lib/toggle.js:299`(默认值)→ `lib/toggle.js:531 normalizeSettings`(551-680 返回对象里加回整组,漏了面板就是假的)→ `lib/settings-fields.js:97`(新 group `{title:'主动开口打分', nested:'proactiveScoring'}`)→ `tests/settings-fields.test.js:76` nested 白名单 + `:147` README 的"71 项"数字。
面板 API 不用改(`/api/echo/settings`,index.js:3305-3344)。

### 复核调用(`lib/reviewTopic` / 或复用 `lib/query-expand.js:98` 的超时降级写法)

- **唯一允许的新增模型调用点**,三重约束:① 只在边缘区触发;② 日额度 `reviewBudgetPerDay`;③ 超时即**视为未过**(沉默,不开口)。
- 复核的输入只给**候选话题 + 最近上下文摘要**,不给全文(省 token + 不泄隐私);
- 复核结论必须写进台账(`rejected_by` 里记 `local` / `review`),否则②那三个枚举又白加。

### P2 前置:先修 `echo_status` 的 schema(实测已坏)

`careTrace()`(`heartbeat.js:322/332`)总是带 `targetSessionId`,而 `lib/index.js:656-673` 未声明(`additionalProperties:false`);`derivedFromL0` 声明 string 实际返回对象(`store.js:744-746`)。
⇒ **加打分子段之前必须先修这条**,否则新字段踩同一个坑;`npm run check:tools` 抓不到(夹具没带这两个键),要**手动补夹具**。

### 卫生纪律(用户点名:别搞得一团糟)

1. **每批一个主题**:一批只干一件事,干完跑闸、留 commit 点(不混批);
2. **纯新增优先**:P1 只加文件、不碰现有代码 ⇒ 删掉即回现状;
3. **默认关 = 零行为变化**:所有新行为挂在 `enabled` 后面,先灰度再默认;
4. **不碰三处红线**:压缩域、人格注入点、QQ 桥;
5. **不新增开口调用点**(复核是唯一例外且受额度约束);
6. **不污染主记忆**:P4 产出必带来源标记,可一键清;
7. **三闸全跑**:`npm test` + `npm run check` + `npm run test:py`(**python 套件不在 npm test 里**,共有表改动尤其要跑);
8. **BOM 纪律**:所有新文件 UTF-8 无 BOM(仓库有闸);
9. **旧数据只读**:任何形状变更都走幂等 `ALTER TABLE ADD COLUMN`,不删列、不重建表。

## 4. 最小第一步(可立即开工)

1. 加 `lib/topic-score.js`:只放纯函数 `scoreTopic/pickTop/timingGate/DEFAULT_WEIGHTS` + 从 `lib/thread-dedupe.js:87` import `topicRepeatPenalty`。**不接线、不碰任何现有文件**;
2. 加 `tests/topic-score.test.js`(≥8 例:六维各自单调、封顶、空候选 → `pickTop` 返 null、全同分稳定取第一、`why` 逐维求和 == score);
3. 验收:`npm test` 全绿 + `node -e` 只读 `SELECT` 真库那两条 open 的 `pending_threads` 喂进 `scoreTopic` 看分数表;
4. **零风险**:纯新增文件,删掉即回现状。
