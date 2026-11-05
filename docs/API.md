# Echo 审查台 — 前端 API 契约

> 队友的开发圣经。本文档描述审查台前端可用的全部 HTTP 端点、写保护、
> SSE 事件流与开发环境配置。**本文档是契约**:端点签名与响应形状
> 变更必须同步改这里;前端按这里写,不猜。

## 0. 总览

- **生产住址**:`http://127.0.0.1:3080/echo/`(插件认领的前缀路由,
  静态文件来自插件包的 `web/` 目录,每请求现读 + `no-store` ——
  改完文件 `node scripts/install.mjs` + 浏览器刷新即见,**不用重启
  dsh web**)。
- **API 前缀**:`/api/echo/*`,与页面同源 —— `fetch` 与 `EventSource`
  直接用,零 CORS。
- **数据约定**:JSON;字段一律 camelCase;**时间戳一律 Unix 秒**;
  引擎离线时读端点返回 `{ "offline": true }`(200),前端要兜。
- **错误形状**:`{ "error": "..." }`,状态码 400/403/405/500。

## 1. 读端点(全 GET,无鉴权)

### GET /api/echo/status — 插件总状态

```json
{
  "status": "active",
  "enabled": true,                  // 电源开关(false = 她下线,纯 agent)
  "version": "0.11.2",
  "dataDir": "<DSH_HOME>/echo",
  "dbPath": "...\\echo.db",
  "memoryOnline": true,             // 记忆库是否打开
  "engine": {                       // v0.11.2 起文档对齐真实形状(对象)
    "mode": "python",               // 'python' | 'baseline' | 'offline'
    "python": { "path": "...", "major": 3, "minor": 14 },   // null = 未探测到
    "sidecar": {                    // null = 引擎未挂载
      "running": true, "breakerOpen": false,
      "failures": 0, "restarts": 0, "version": 5,
      "pid": 1234, "lastError": null
    }
  },
  "personaChars": { "prefix": 300, "suffix": 900 },
  "personaCustomized": false,       // 用户是否改过人格文本
  "maxChars": 4000,
  "lastLoadAt": 1695000000,
  "scope": { "scope": "all", "whitelist": [], "exempt": [] },  // v0.9.0 会话范围
  "memory": { "episodicActive": 108, "episodicTotal": 124, "l0": 0,
              "graphNodes": 25, "graphEdges": 26, "quarantined": 0,
              "moodIntensity": 3, "lastMemoryAt": 1790088264, "updatedAt": 1790146039 }
}
```

> 历史教训(v0.11.2):本文档曾把 `engine` 写成字符串,payload 演进
> 成对象后文档没跟上,审查台占位页照旧文档写,页面又因路由雷
> 404 半个月没人跑过 —— 三重叠加才暴露。改 payload 形状必须同步
> 本文档。

### GET /api/echo/memories — 记忆浏览器(原始行分页,M6-b 新增)

Query(全可选):

| 参数 | 默认 | 说明 |
|---|---|---|
| `page` | 1 | 1 起;越界自动钳到最后一页 |
| `limit` | 50 | 1~200 |
| `state` | `active` | `active`(正式行)/ `quarantined`(隔离待观察)/ `forgotten`(已遗忘,行留档可审计)/ `all` |
| `layer` | 空 | 按层过滤:`L0`(核心)/ `L1` / `L2`;空 = 不过滤 |
| `source` | 空 | 按来源过滤(如 `qq`、`dsh`) |
| `q` | 空 | 模糊搜索,匹配 summary 与 keywords |
| `sort` | `recent` | `recent`(时间倒序)/ `value`(I 值倒序) |
| `ids` | 空 | **v0.16.0 M1:按 id 直取(回指用)**。逗号分隔,最多 50 个;给了 `ids` 就忽略上面所有分页/过滤参数,返回 `{rows, total}`,顺序按传入顺序、缺的 id 静默丢弃、**包含已让位的行**(`isActive=0` 也是历史)。图谱页点「依据 #42」走的就是这条 |

> 回指为什么要单独一个参数:图谱里的边记着「我是从哪几条记忆学来的」
> (`evidenceIds`),点开要看原文。用 `q=` 搜是搜不准的(同一句话换个说法
> 就搜不到),而回指必须是**确定的那一条** —— 所以按 id 直取。

```json
{
  "total": 108, "page": 1, "limit": 50,
  "rows": [{
    "memoryId": 42,
    "summary": "他喜欢章鱼小丸子",
    "keywords": ["章鱼小丸子", "食物"],
    "emotionScore": 6,          // 提炼时的情绪分 1~10
    "intrinsicValue": 60,       // I 值(DMAE):决定半衰期,0~100
    "halfLife": 720,            // 半衰期(小时)
    "recallCount": 3,           // 被想起次数(想起即强化)
    "lastRecalled": 1695000000, // 最近一次被想起(0 = 从未)
    "layer": "L1", "status": "active", "isActive": true,
    "source": "qq", "sourceLabel": "", "memoryKey": "偏好:章鱼小丸子",
    "supersededBy": 0,          // 被哪条换代行取代(0 = 无)
    "occurredAt": 1694000000,   // 事件发生时间(0 = 时间未知)
    "learnedAt": 1694100000,    // 她得知这件事的时间
    "temporalStatus": "time_known",  // time_known | time_unknown | outdated
    "timestamp": 1694100000     // 行写入时间
  }]
}
```

### GET /api/echo/audit?since=&limit= — 审计流(她的黑匣子)

`since` = Unix 秒(只取更新的行);`limit` 1~200 默认 50。**这是答辩
主展**:每轮对话的完整轨迹。

```json
{ "rows": [{
  "traceId": "a1b2c3", "sessionId": "sess-x",
  "userInput": "还记得面试的事吗",
  "injectedMemories": "[她的记忆与心情…]\n【现在】…\n【情景记忆】\n- [核心] …",  // 本轮注入块的**渲染全文**(纯文本,实测 1300~2230 字符;不是数组)
  "agentState": { "mood": "…" },          // 引擎认知状态(可 null)
  "llmReply": "记得呀…",
  "moodIntensity": 5, "prevMoodIntensity": 4,   // 情绪强度 1~10 与上一轮值
  "emotionVector": { "爱意": 7, "委屈": 2 },    // 可 null
  "emotionDelta": { "爱意": 1 },                // 本轮变化,可 null
  "toolCall": "",                            // 'care' | 'diary' | '' 等
  "timestamp": 1695000000
}] }
```

### GET /api/echo/longing — 想念值(答辩主仪表)

```json
{ "rows": [{
  "userId": "master",
  "value": 6.25,             // 0~10,幂律增长,消息走心削减
  "threshold": 7.0,          // 过线她会主动开口
  "sinceMessage": 18000,     // 距他上一句话多少秒
  "kicked": 0,               // 已主动开口几次
  "lastCareAt": 0, "careCount": 0,
  "engine": "python"         // 'python' = 引擎真值;'baseline' = JS 复刻
}] }
```

### GET /api/echo/diary — 她的日记(最近 7 天)

```json
{ "rows": [{ "date": "2026-09-25", "content": "今天<称呼>…",
             "mood": 6, "longingValue": 4.2, "createdAt": 1695000000 }] }
```

### GET /api/echo/health — 记忆体检(DMAE 三态)

```json
{
  "dmae": { "active": 80, "dormant": 20, "archived": 8,
            "avgR": 0.72, "total": 108 },   // R = 可提取性均值
  "temporal": { "time_known": 60, "time_unknown": 48 },
  "temporalEdges": { "time_known": 20, "time_unknown": 6 },
  "threads": { "open": 4, "due": 1 }        // 悬置话题
}
```

### GET /api/echo/threads — 悬置话题(她记着要跟进的事)

**2026-10-06(D5)起是七桶**:老四桶(`waiting`/`due`/`done`/`untimed`)是**活跃档
内部的渲染子状态**(语义与位置不变),另加三档 `cooling` / `resolved` / `archived`。
每行都带 `kind`(类别徽标)· `coolingAt` · `archivedAt` · `supersededBy`。

```json
{
  "waiting": [{ "threadId": 1, "content": "他说周五要答辩",
                "followUpAfter": 1695100000, "lastMentionedAt": 0,
                "kind": "schedule", "coolingAt": 0, "archivedAt": 0, "supersededBy": 0,
                "updatedAt": 1695000000, "state": "waiting", "secondsLeft": 86400 }],
  "due": [], "done": [], "untimed": [],
  "cooling": [{ "threadId": 7, "content": "两分钟后提醒洗衣服", "kind": "reminder",
                "coolingAt": 1695200000, "archivedAt": 0, "supersededBy": 0, "updatedAt": 1695200000 }],
  "resolved": [], "archived": [],
  "now": 1695000000
}
```

档位判据(全在 `lib/store.js` 的 `listThreads`,只读):

| 档 | 判据 |
|---|---|
| 活跃(waiting/due/untimed/done) | `archived_at=0` ∧ `status='open'` ∧ `cooling_at=0` |
| `cooling` | `cooling_at>0` ∧ `archived_at=0`(过时或提过 ⇒ 不再问,还记着) |
| `resolved` | `status='resolved'` ∧ `archived_at=0` |
| `archived` | `archived_at>0`(退出所有通路,只留档;面板默认折叠) |

### POST /api/echo/threads/act — 人工动作(结掉 / 登记 / 恢复)

写操作要求**回环 Origin + `x-echo-edit: 1`**(`writeAllowed`),每条都留审计
(`tool_call='threads'`)。

| body | 语义 | 返回 |
|---|---|---|
| `{action:'done', query:'关键词'}` | 走 Judge 平时那条消解(用户原话双向子串,同一把尺子);没匹配上如实回 `threadId: 0`、**不新建** | `{ok, action:'done', threadId}` |
| `{action:'add', content:'…'}` | 人工登记;`follow_up_after=0` ⇒ 永不主动提,只留记录 | `{ok, action:'add', threadId, created}` |
| `{action:'restore', threadId: 7}` | **2026-10-06(D5)新增**:把**冷却中**的话题拉回活跃(清 `cooling_at`)。已归档 / 被取代(`supersededBy>0`)/ 已了结(`resolved`)的**不给恢复** —— 那是语义终态 | `{ok, action:'restore', threadId, restored}` |

调参口径:`GET /api/echo/settings` 无新增项(注入侧配额与类内时效是常量,
见 `lib/soul-snapshot.js` 的 `THREAD_KIND_CAPS` / `THREAD_KIND_MAX_AGE_SEC`)。

### GET /api/echo/emotion — 情绪历史(最近 5 条认知状态)

```json
{ "rows": [{ "moodIntensity": 5, "prevMoodIntensity": 4,
             "userEmotion": "neutral", "moodReason": "…",
             "emotionVector": { "爱意": 7 }, "updatedAt": 1695000000 }] }
```

### GET /api/echo/emotion-space?limit=N — 联合空间读数(面板「情绪空间」)

`limit` 1..50,默认 20(逐轮样本条数)。**只读**:不做换算、不回写任何读数;
`history` 的 `gate` / `bridgeErr` 用**当前**面板参数现算(所以它说的是"今天这两把尺子合不合")。

```json
{
  "schema": "echo.emotion.union.v1", "at": 1791210004189, "mode": "live", "enabled": true,
  "pad": { "p": 0.2, "a": -0.5555, "d": -0.6, "missing": [], "dSource": "derived" },
  "union": { "s": -0.154823, "a": -0.5698, "d": -0.6 },
  "gate": "red", "bridgeErr": 0.467368, "sPad": -0.154823, "sIpc": 0.312545,
  "predicted": 0.145177, "direction": null,
  "ipc": {
    "role": { "a": 0.2, "c": 0.98 },
    "octants": [{ "code": "PA", "zh": "主导", "angle": 90 }],
    "anchors": null,
    "complementPoint": { "a": 0.8, "c": 0.98 },
    "antiComplementPoint": { "a": 0.2, "c": 0.02 },
    "region": { "octant": "JK", "zh": "随和", "angle": 327.99, "label": "明显随和", "word": "随和" },
    "anchor": null,
    "other": { "a": 0.3, "c": 0.55 },
    "metrics": { "self": { "a": 0.2, "c": 0.98 }, "other": { "a": 0.3, "c": 0.55 },
                 "separationDegrees": 73.74, "pattern": { "id": "complementary", "zh": "互补", "fit": 1 },
                 "quantities": { "reciprocity": 1, "correspondence": 1, "complementarity": 1 } },
    "metricsNote": null,
    "ipcErr": { "a": 0.2, "c": 0.02, "maxAbs": 0.2 }, "errGate": "yellow",
    "gain": 0.9, "lowConfidence": false, "at": 1791210000000,
    "labels": { "self": "主导", "other": "随和" }, "src": "appraise@ipc-core"
  },
  "baseline": { "p": 2, "a": 3, "d": null, "unit": { "p": 0.2, "a": -0.5555, "d": null },
                "source": "manual", "updatedAt": 1791000000000, "note": "…" },
  "history": [{ "at": 1791209736028, "pad": { "valence": 0.2, "arousal": -0.5555, "dominance": -0.6 },
                "dSource": "derived", "ipc": { "a": 0.2, "c": 0.98 },
                "union": { "s": -0.154823, "a": -0.5698, "d": -0.6 },
                "sPad": -0.154823, "sIpc": 0.312545, "bridgeErr": 0.467368,
                "gate": "red", "direction": null, "degraded": false, "missing": [] }],
  "degraded": false, "ipcAvailable": true, "missing": [], "dSource": "derived",
  "assumptions": "…不可互推声明…", "note": "只读:面板不做换算、不回写读数;history 的 gate 用当前面板参数现算"
}
```

降级:`ipc-core` 不可用 ⇒ `ipc.octants = null`、`ipcAvailable: false`(面板画空盘);
缺维 ⇒ `pad.missing` 列名、对应值为 `null`(**不填 0**);支配维 `dSource ∈ derived|measured|null`。

#### 顶层字段(契约)

| 字段 | 类型 | 含义 | 缺失语义 |
|---|---|---|---|
| `schema` | string | `echo.emotion.union.v1`(与 `lib/emotion-space.js` 的 `SPACE_ID` 同源) | 恒有 |
| `at` | number | 本次读数时间(ms) | 恒有 |
| `mode` | string | `live` / `off`(总闸)/ … | 恒有 |
| `enabled` | boolean | 桥接总闸是否开着 | 恒有 |
| `pad` | object | `{p, a, d, missing[], dSource}` — 宿主口径:p 已是 `[0,1]`,`a`/`d` 是双极 `[-1,1]` | 缺维 ⇒ 该键 `null`,列名进 `missing` |
| `union` | object\|null | 联合读数 `{s, a, d}` | 总闸关/降级 ⇒ `null` |
| `gate` | string | **门禁档**:`green` / `yellow` / `red` / `unknown` | 算不出 ⇒ `"unknown"` |
| `bridgeErr` | number\|null | 残差 \|s_pad − s_ipc\|(挂着门禁的那个数) | `null` |
| `sPad` / `sIpc` | number\|null | 两侧的共享轴读数(情感侧 / IPC 侧) | `null` |
| `predicted` | number\|null | 用 IPC 侧**预测**的情感侧共享轴 | `null` |
| `direction` | string\|null | 本轮相对上一轮的方向:`positive` / `negative` / `flat` | 没有上一轮向量 ⇒ `null` |
| `styleHint` | object\|null | **语气候选**(② 2026-10-05):`<emo type="N">` 候选集与那一行 prompt 文案;见下 | 取数/计算抛了 ⇒ `null` |
| `ipc` | object | 见下(IPC 侧姿态与几何) | 副本不可用 ⇒ 各键 `null` |
| `history` | array | 逐轮样本(端点返回前**按旧 → 新**排好);见下 | 没有带情绪向量的审计行 ⇒ `[]` |
| `degraded` | boolean | 本轮计算是否降级 | 恒有 |
| `ipcAvailable` | boolean | IPC 副本是否可用 | `false` ⇒ 面板画空盘 |
| `missing` | array | 顶层缺维清单(与 `pad.missing` 同义) | 恒有 |
| `dSource` | string\|null | 支配维来源:`derived`(反推·[工程假设])/ `measured`(实测)/ `null` | 无支配维 ⇒ `null` |
| `assumptions` | string | 不可互推声明(面板原样展示) | 恒有 |
| `note` | string | 端点自述(只读、gate 现算口径) | 恒有 |
| `error` | string | **仅故障时**出现:取数/计算抛了,此时 `history: []` 并**仍返回 200** | — |

#### 六件套(`gate` / `bridgeErr` / `sPad` / `sIpc` / `predicted` / `direction`)

面板顶部「联合空间(共享轴)」卡**直接读这六个顶层字段** —— 它们是"当前这一轮"的读数,
`history[].*` 里的同名字段是**逐轮**的。为什么单列出来说:
**② 版端点漏给了这六个**,面板上显示成"门禁:未知 · 残差 —",是 ③ 画圆盘时发现的
(commit `1f8c8e5` 补上)。谁改端点都别把它们挪进 `union` 里 —— 面板按顶层读。
`gate` 的四档语义与 `lib/space-bridge.js` 的 `GATE_BANDS` 一致:**绿给块 / 黄只给方向 / 红不给块**。

#### `styleHint` 段(② 2026-10-05,面板「情绪空间」页第四张卡)

把情绪读数折成 heart-tts 行内语气标签 `<emo type="N">…</emo>` 的**候选集** —— 计算全在
`lib/style-hint.js`(纯函数 `statusToStyleCandidates()`),端点只做搬运。

| 键 | 类型 | 含义 |
|---|---|---|
| `enabled` | boolean | 调参开关 `styleHint` 是否开着(关 = prompt 里没有这一行 = 回滚态) |
| `source` | string | **恒为** `recomputed` —— 这是按最近一轮读数**现算**的,不是当时注入的原文 |
| `at` | number\|null | 用于现算的那一轮的时间(ms) |
| `delta` | string | 触发量:`pos` / `neg` / `zero` / `unknown`(**不是绝对强度**) |
| `arousalBand` | string | `up` / `mid` / `down` / `unknown`(读不到就是 `unknown`,不假装居中) |
| `arousalKnown` / `valenceKnown` | boolean | 这两个读数到底有没有(文案只写"真读到"的字段) |
| `valenceSign` | string | `pos` / `neg` / `unknown` |
| `valenceFromS` | boolean | 心情读缺、由共享轴 `s` 兜底判出的符号(**不许**当"读到的心情"展示) |
| `sTrusted` | boolean | `gate === 'green'`;黄/红/未知一律 `false`(**不引用共享轴**) |
| `candidates` / `avoid` | number[] | 候选 / 不优先的号;**永远不含 `1`(自然)与 `6`(突出)**;平静 ⇒ 两个都空 |
| `line` | string | **真正会进 prompt 的那一行**(`''` = 不出行);≤ 101 字(旧方括号语法时是 80,换 XML 后每个标记由 7 字变 14 字,重标到实测最长 101) |

**为什么"不出行"**:`delta = 0` / 读不出变化 / 候选被掏空(平静、或自身读数全缺)。
自身读数全缺时**任何门禁**都不出行 —— 共享轴 `s` 单独一条不足以挑语气
(两套坐标"不等价、不可互推")。

**为什么现算而不是存列**:输入(强度 / 上一轮强度 / 向量)本来就在审计行里,
端口不新增列;代价是**改了 `style-hint.js` 之后,面板显示的会按新逻辑重算** ——
所以卡里写明 `source: 'recomputed'`。要"当时原文"就得加一列(未做)。

#### `ipc` 段

| 字段 | 含义 | 缺失语义 |
|---|---|---|
| `role` | 角色(她)自己的姿态 `{a, c}`,各 `[0,1]` | 依赖/爱意缺维 ⇒ `null` |
| `octants` | 八个分仪词表 `[{code, zh, angle}]` | 副本不可用 ⇒ `null` |
| `anchors` | ⚠️ **已砍(2026-10-06 拍板 ⑨)**:与 `region.label` 功能重复 ⇒ 恒 `null` | 恒 `null` |
| `anchor` | 最近锚点 `{id, zh, octant}` | 拿不到 ⇒ `null` |
| `complementPoint` / `antiComplementPoint` | 互补位 / 对立位 `{a, c}`(圆盘上两个虚线圈) | 缺 ⇒ `null` |
| `region` | 区域解读 `{octant, zh, angle, label, word, …}`(圆盘大字用它) | 缺 ⇒ `null` |
| `other` | **她眼里的他**(用户侧坐标,轮末异步判定,`emotion_vector.ipc_dyad`) | 没判过 / 红档 / 判定不可信 ⇒ `null` |
| `metrics` | 关系度量(**要两个坐标**):`{self, other, separationDegrees, pattern{id,zh,fit}, quantities{…}}` | 缺任一个点 ⇒ `null` |
| `metricsNote` | 上面那条的人话解释(面板原样显示);正常给出数时是 `null` | 恒有 |
| `ipcErr` | `{a, c, maxAbs}` — 同一次打分的 `self` 与**映射出来的她**的残差(对账用) | 缺一侧 ⇒ `null` |
| `errGate` | 残差分带:`green` / `yellow` / `red` / `unknown`(口径与 `space-bridge` 同一套阈值) | 算不出 ⇒ `"unknown"` |
| `gain` / `lowConfidence` | 这次判定的可信度 / 是否低于门槛 | 没判 ⇒ `null` / `false` |
| `at` / `labels` / `src` | 判定时间(ms) / 双方标签 / 来源标记 `appraise@ipc-core` | 没判 ⇒ `null` |

**只记账、不回写**(拍板 ①):`other` 与 `ipcErr` **不参与**任何 prompt、不写进任何坐标,
也不进 `space-bridge` 的 `s` / 门禁 —— 它是**同源路线的对账**(两把尺子差多少),
不是"修正值"。红档时 `other` / `metrics` 都不给(面板照旧画灰环占位),**不填 0**。

#### `baseline` 段(人格基线,2026-10-06)

`{p, a, d, unit, source, updatedAt, note}` —— **只有 P/A 两维,`d` 恒 `null`**
(支配维在本仓"已登记未启用",基线不许把它编出来)。`p`/`a` 是**原生值**
(与 `global.valence` / `global.arousal` 同尺),`unit` 是立方体口径的双极坐标
(`[−1,1]`,`d: null`)。没开总闸 / 没填 ⇒ 整个 `baseline` 是 `null`(面板整块跳过)。
存 `config.json`(`herBaseline*`),**不入向量、不入库表**。

#### `history[]` 行

`{at, pad{valence, arousal, dominance}, dSource, ipc{a, c}|null, union, sPad, sIpc, bridgeErr, gate, direction, degraded, missing}`
—— `gate` / `bridgeErr` / `sPad` / `sIpc` 用**当前**面板参数对那一轮的向量**现算**(所以它回答的是
"今天这两把尺子合不合",不是"当时合不合");`limit` 只截样本条数,不改任何计算。

#### 边界

- `limit` 越界 ⇒ 夹到 `1..50`(默认 20);面板按 **40 轮**取(`?limit=40`,拍板 D5 的轨迹上限)。
- 非 GET / 路径写错 ⇒ 宿主其它路由;本端点**只读、无鉴权、不写任何库**。
- 端点内部抛异常 ⇒ **仍 200** + `{error, history: [], note}`,前端照常渲染降级态(不许白屏)。
- 面板侧:视图文件由宿主**静态托管** ⇒ 改完刷新即生效;但**本路由是新增的** ⇒
  `dsh web` 不重启则该路径 404,面板会显示"取数失败"。

### GET /api/echo/graph — 记忆图谱

```json
{
  "nodes": [{ "id": "章鱼小丸子", "name": "章鱼小丸子",
              "type": "preference", "isProtected": 0, "weight": 3,
              "activation": 62, "intrinsicValue": 15, "halfLife": 40,
              "recallCount": 3, "temporalStatus": "current" }],
  "edges": [{ "id": 1, "source": "<称呼>", "target": "章鱼小丸子",
              "relation": "喜欢", "weight": 1, "halfLife": 720,
              "recallCount": 2, "temporalStatus": "current",
              "intrinsicValue": 12, "activation": 55,
              "occurredAt": 1790000000, "layer": "L1",
              "isActive": true, "supersededBy": 0 }]
}
```

`type`:`person` / `habit` / `preference` / `event` / `concept`;
`weight` = 度数(连线数),可直接当节点大小。
v0.13.0 起带引擎超集字段(动态图谱 `/echo/graph.html` 的数据面):
`activation` **现算激活度**(v0.13.2:R(Δt,H)×100,Δt = 距
`last_accessed`,H 缺失按内在价值给初值;节点无半衰期,取最清醒
邻边的现算值)、`activationStored` 物化快照(引擎侧
graph_query/graph_reinforce 接线前恒为导入时序值,可对照)、
`intrinsicValue` 内在价值、`occurredAt` 发生时刻、`layer`
(L0 = 核心)、`isActive` + `supersededBy`(取代链,被取代的边
是留档历史)。边配色三态按现算激活度:≥30 绿 / >0 琥珀 / 其余红,
<10 虚线;≥50 清醒 / ≥10 模糊 / 其余遗忘。

### GET /api/echo/persona — 人格文本

```json
{
  "prefix": "你是 Echo…", "suffix": "【Echo 的两条铁律】…",
  "defaults": { "prefix": "…", "suffix": "…" },  // 当前默认(对照用)
  "customized": false, "enabled": true, "maxChars": 4000
}
```

## 2. 写端点(POST,需写保护头)

写保护 = **回环 Origin + 自定义头**,防跨站写:

```
POST /api/echo/persona   { "prefix": "...", "suffix": "..." }
  → { "ok": true, "savedAt": 1695000000 }
  403 若缺头;400 若 body 非法;长度上限 4000 字/段

POST /api/echo/toggle    { "enabled": false }
  → { "ok": true, "enabled": false }

GET /api/echo/scope
  → { "scope": "all", "whitelist": [], "exempt": [],
      "sessions": [{ "sessionId": "…", "lastAt": 1695000000,
                     "turns": 12, "label": "还记得面试的事吗" }] }
  sessions = 审计里出现过的会话(label = 最新一条用户输入,辨认用)

POST /api/echo/scope     { "scope": "whitelist" }          // 切模式
                    或   { "sessionId": "…", "on": true }  // 切单会话
  → { "ok": true, "scope": …, "whitelist": […], "exempt": […], "sessions": […] }
  语义:all 模式 on=摘出例外名单 / off=进例外名单;
       whitelist 模式 on=进白名单 / off=摘出。
  会话内更快的路:发「Echo 上线」/「Echo 下线」切当前会话。

POST /api/echo/context/clear  { "sessionId": "…" }        // 2026-09-26 新增:清空她的上下文
  → 200 { "ok": true,  "code": "cleared", "text": "清掉了 5 条旧历史(约 4210 tokens)…",
          "shadowed": 5, "tokens": 4210 }
  → 200 { "ok": false, "code": "nothing"|"busy"|"cancelled"|"no-service"|"no-agent"|"error",
          "text": "人话原因" }
  400 若 sessionId 非法;403 若缺写保护头。
  语义:调宿主的压缩服务(compaction.compactNow,与宿主 `/compact` 同一条路,
  selectCompactableRange 时 retain 传 0)—— 旧历史整段压成一条摘要,旧消息从
  她视野里消失,**会话记录不删**(还能翻旧账)。插件没有「删历史」的手:
  SessionSurface 的替换被来源校验锁着、只给压缩用;sessions.create 是调用方
  fiber 所有、不进 agent 生命周期就不落盘。
  会话睡着时(她几小时没说话)会先走 sessionController.create 唤醒/resume,
  再压。同一件事她自己也有一只手:`echo_context_clear` 工具。

GET /api/echo/conversations?limit=20&channel=QQ        // v0.11.0 对话回放
  → { "rows": [{ "turnId": 7, "sessionId": "…", "channel": "QQ",
                 "userText": "…", "replyText": "…", "createdAt": 1790000000 }],
      "labels": { "…sessionId…": "QQ中继" } }
  一轮一行,倒序(最新在前);全局滚动 100 轮(写时修剪);
  channel 过滤可选;只有她在线的会话进日志,关怀轮 userText 为空
  (她主动开口,replyText 是她说的);labels = 全部会话来源标签。

POST /api/echo/session-label   { "sessionId": "…", "label": "QQ中继" }
  → { "ok": true, "labels": { "…": "QQ中继" } }
  写会话来源标签(≤24 字,写时快照进对话记录的 channel 列);
  空标签 = 摘除;中继桥(M8-b)自注册「QQ」走这里。

POST /api/echo/memory/edit   { "memoryId": 42, "summary": "...", "keywords": "词1、词2", "emotionScore": 8 }
  → { "ok": true, "memoryId": 42 }
  字段全可选(至少一个);keywords 收数组或「、,;」分隔字符串;
  改 emotionScore(1~10)按 DMAE 口径重算 I 值与半衰期;
  404 = 记忆不存在;400 = 空摘要/无字段

POST /api/echo/memory/state  { "memoryId": 42, "action": "quarantine" }
  → { "ok": true, "memoryId": 42, "action": "quarantine" }
  action ∈ quarantine(隔离,检索不可见)| activate(转正)|
           forget(遗忘 = 留档可审计,绝不物理删除)|
           restore(恢复;被取代的行会清取代标记,与换代行并存时由人定夺)|
           l0(置顶为核心:引擎零命中豁免 + 强制占位 + [核心] 标记)|
           unl0(取消核心,回到未分层)

GET /api/echo/settings                                  // 调参面(2026-09-26 起在网页仪表盘)
  → { "settings": { ... }, "defaults": { ... }, "relayTokenSet": false,
      "fields": [ { "title": "记忆与注入",
                    "fields": [ { "key": "injectTopK", "label": "每轮注入记忆条数",
                                  "hint": "…", "type": "num", "min": 1, "max": 12 } ] },
                  { "title": "想念(引擎九项)", "nested": "longing", "fields": [ … ] } ] }
  settings.relay.token 一律回空串(写-only:一个 GET 就能读走桥钥匙的接口不该存在),
  relayTokenSet 告诉面板「设过没有」。`fields` 是调参的**字段表**(标签/提示/类型/范围),
  唯一一份在 lib/settings-fields.js —— 调参从 DSH 设置区搬去网页后由这里发下去,
  前端照着渲染,不许再抄第二份;钳位规则仍只在 toggle.js 一处。
  (字段表与 defaults 的键集必须完全对齐,由 tests/settings-fields.test.js 钉住。)

POST /api/echo/settings   { "settings": { ... } }
  → { "ok": true, "settings": { ...同 GET 的形状... } }
  403 若缺 x-echo-edit。relay.token 传空串 = **不改**(否则每存一次调参都会把桥的
  钥匙抹掉);要停桥关 relay.enabled。嵌套对象(longing / relay)必须整块带着走 ——
  只传改过的那一项会被 normalizeSettings 兜回默认(用户以为改成了、其实一切照旧)。

GET /api/echo/memory-tools                              // 2026-10-01 新增:子代理只读记忆工具开关
  → { "key": "memorySubagentTools", "envVar": "ECHO_MEMORY_SUBAGENT_TOOLS",
      "on": false, "source": "off", "sourceLabel": "关(三路都没开)",
      "sources": { "env": false, "config": false, "settings": false },
      "applied": false, "registered": 0,
      "toolNames": ["memory_search", "memory_get", "memory_neighbors", "memory_timeline"],
      "storeOnline": true, "panelValue": false, "immediate": true }

POST /api/echo/memory-tools   { "enabled": true }
  → { "ok": true, ...同 GET 的形状..., "reason": "on" }
  403 若缺 x-echo-edit(回环 Origin 同样必需);400 若 enabled 不是**严格布尔**
  (字符串 "true" 不算 —— 判定只认 `=== true`);405 其他方法。
  落盘位置 = `$DSH_HOME/echo/config.json` **顶层** `memorySubagentTools`
  (与 enabled / scope 同层,**不在** `settings` 那段里:那段是 51 项调参面,
  键集被 tests/settings-fields.test.js 钉着)。写走 toggle.writeConfig(tmp+rename 原子、
  保留未知字段、失败上抛 ⇒ 这里回 500,**不静默**)。
  语义:落盘之后**当场**重算并重挂(注册/摘除那 4 个只读工具 + 重设 reflect 的
  名单 provider)⇒ **立即生效,不用重启宿主**,也**不写** `cordis.patch.yml`。
  `applied` 说的是"真挂上了没有":三个来源(env / 宿主配置 / 这个开关)按 OR 取值,
  判定只走一处 `memoryToolsEnabled()`(lib/memory-read-tools.js),面板不复制第二份。
  ⚠️ 这 4 个只读工具挂上时,**主会话也会看到它们** —— 宿主的 toolFilter 是 restrict
  语义(只能从继承来的工具面里拿掉)。要"只给子代理"得宿主侧支持,当前做不到。
```

两个记忆写端点都写审计行(`toolCall` = `memory_edit` / `memory_state`),
SSE 照常推 —— 现场改一条记忆,审计流立刻可见。

前端发写请求时带:

```js
fetch('/api/echo/toggle', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-echo-edit': '1' },
  body: JSON.stringify({ enabled: false })
})
```

同源页面 Origin 天然回环,`x-echo-edit` 头是第二道闸(跨站表单
伪造带不了自定义头)。**注意**:自定义头会触发 CORS 预检 —— 只在
同源或代理(见 §4)下用,别直连跨域。

## 3. SSE 实时事件流

```
GET /api/echo/events   →   text/event-stream
```

- 连接建立先收到注释行 `: connected`;
- 每 3 秒服务端查审计表增量,有新行就推:

```
event: audit
data: {"upTo":1695000000,"count":2}
```

- **信号语义**:「有新审计行」,行内容自己拉 `/api/echo/audit?since=`;
- 断线用浏览器内建重连(`EventSource` 自动),前端只需处理
  `onerror` 的 UI 状态。

```js
const es = new EventSource('/api/echo/events')
es.addEventListener('audit', (ev) => {
  const { upTo } = JSON.parse(ev.data)
  refreshAudit(upTo)   // 拉增量
})
```

## 4. 开发环境(两条路)

### 路径 A:直改 web/(无构建)

原生 HTML/JS/CSS 放 `web/`,改完 `node scripts/install.mjs` +
浏览器刷新。伺服冒烟:`node scripts/smoke_web.mjs`(不依赖 dsh web,
临时起服务断言页面可达/穿越被拒)。

### 路径 B:自带 dev server(vite 等)

dev server 起在别的端口,把 API 与 SSE 代理到 3080 —— 服务端代理,
浏览器视角同源,无 CORS,写保护头照常工作:

```js
// vite.config.js
export default {
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3080',
      '/echo': 'http://127.0.0.1:3080'
    }
  }
}
```

构建产物落回 `web/` 即生产形态(`base: '/echo/'` 记得配)。

## 5. 约定与坑

- **时间戳全是 Unix 秒**,不是毫秒(`new Date(ts * 1000)`);
- 引擎离线 ≠ 插件离线:读端点回 `{ "offline": true }`,人格/电源
  照常工作,前端别把 offline 当 500;
- `emotionVector` / `agentState` / `emotionDelta` 可为 `null`;
- 审计 `toolCall` 的特殊值:`care`(她主动开口)、`diary`(写日记)、
  `reflect`(反思落库)、`forget`(执行遗忘)、`memory_edit` /
  `memory_state`(面板手动操作)、`session_on` / `session_off`
  (会话范围标记)—— 审查台可按此过滤;
- **会话范围**(v0.9.0):电源是总闸,范围是分闸。范围外的会话对
  她是隐形的(不注人格/记忆、不反思、不削减想念)。默认
  `scope='all'` 全部启用;`'whitelist'` 只开白名单内的。
- 记忆的主路仍是**对话**(教她/让她忘);面板写路径是审查席的
  手动修正权(用户裁决开闸),每次修正留审计痕 —— 修正本身可审查。
