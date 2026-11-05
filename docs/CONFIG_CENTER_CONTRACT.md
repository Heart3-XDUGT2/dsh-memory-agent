# P2 配置中心 · 接口契约(冻结版)

> 依据:`数据程序分离设计-2026-10-05.md` **§6**(§6.2 页面 / §6.3 API / §6.4 保存时序 / §6.5 热加载)。
> 冻结日期:**2026-10-05**;冻结人:主控(B0)。**子代理不许自行改本文件里的任何形状** —— 要改先停下报告。
> 口径:本文档是 B1/B2/B3/B4 的**唯一接口真源**;与本文不符的实现一律视为错。

---

## 0. 三条不可能越过的纪律

1. **数据唯一真源** = `~/.dsh/echo/` 下的 8 个白名单数据文件;前端**不读文件**,一律走 API。
2. **写盘只有一条路** = `lib/data-write.js` 的 `writeDataFile()`(备份 → 校验 → `.tmp`+rename → 失效缓存)。
   端点/页面**不许**出现 `writeFileSync` / `resolveDataFilePath` / 任何裸文件路径。
3. **`echo.db` 永不在这条路上**:不在白名单、不进导出、不进导入、不可读不可写。

---

## 1. 七条新 API(§6.3;现有 28 条不动)

所有路径都在 `lib/index.js` 里注册(`webServer.register({kind:'exact', path, handler})`)。

| # | 方法 | 路径 | 载荷 | 成功回包 | 错误 |
|---|---|---|---|---|---|
| 1 | GET | `/api/echo/setup` | — | `200 setupStatus`(见 §5) | `405` |
| 2 | GET | `/api/echo/data/:file` | `?raw=1` 可选 | `200 {file, exists, value, bytes}`;坏文件另带 `{unreadable:true, raw, parseError}` | `404` 白名单外;`405` |
| 3 | PUT | `/api/echo/data/:file` | 该文件**完整**新对象(不是 patch) | `200 {ok, file, savedAt, effective, backupPath, bytes, schemaRev, warnings[], notes[]}` | `403` 写保护未过;`404` 白名单外;`400 {error, errors[], warnings[]}` 校验不过(**文件不变**);`500 {error, detail}` 备份/写盘失败(**不继续**) |
| 4 | POST | `/api/echo/data/:file/validate` | 同 3 的 body | `200 {ok, errors[], warnings[], file}`(**不落盘**) | `404`;`405` |
| 5 | POST | `/api/echo/data/backup` | `{file?}`(缺省 = 全部 8 个) | `200 {ok, path?, bytes, files:[{file, backedUp, path, bytes}]}` | `403`;`500` |
| 6 | GET | `/api/echo/data/export` | — | `200 bundle`(见下) | `405` |
| 7 | POST | `/api/echo/data/import` | `{bundle, confirm:true}` | `200 {ok, imported[], backupPath, savedAt}` | `403`;`400` 缺 `confirm` / 形状不对;`404` bundle 里有白名单外的文件 |

**写保护(§6.1)**:2 是只读;3/5/7 必须先过 `writeAllowed(req)`(回环 Origin + `x-echo-edit: 1`)⇒ 否则 `403`。

**`raw` 语义(用户 2026-10-05 明确,已实现)**
- **默认不回** `raw`(好文件只给 `value`,不把整份原文塞第二遍);
- **只在"读不出对象"时回**:JSON 坏了 ⇒ `200 {value:null, unreadable:true, raw:'<原文>', parseError:'…'}` —— 面板的 JSON 编辑器靠它修坏文件;
- **`?raw=1` 强制回**(给"看原文"按钮),此时 `raw` 恒等于盘上字节;
- `exists:false` 时回 `{file, exists:false, value:null, bytes:0}`(**不是 404** —— `404` 只留给白名单外)。

**已有一条**:`GET/POST /api/echo/persona`(`lib/index.js:3332`)内部改走 `/data/persona.json` 的**同一套写路径**(B1 做);`GET/POST /api/echo/settings`(`:3721` 附近)**不动**。
> ⚠️ **此项待批准**:改 `/persona` 的 POST 需要对 `lib/persona.js` 动 2 行(它不在 B1 文件白名单里)⇒ 已停下报告,等用户点头;**`PUT /api/echo/data/persona.json` 这条正路已经可用**,面板可以先用它。

**导出 bundle(定死)**:
```json
{ "schemaRev": 1, "exportedAt": "2026-10-05T…Z", "program": "echo",
  "files": { "persona.json": {...}, "config.json": {...} },
  "missing": ["lexicon.json"] }
```
- 默认 **JSON 单文件**(`?format=zip` 后置,不在本批);
- **只含白名单 8 个文件**,`echo.db` / `backup/` / `workspace/` **永不进**;
- `missing[]` = 不存在或读不出来的文件名(导出不是错误,缺就列出来);
- 导入 = **整包覆盖**:先备份(每个被覆盖的文件各一份)→ 逐文件校验 → 全过才写(**一个不过就整包不落盘,连别的文件也不写**)→ 原子写;回包 `{ok, imported[{file,bytes,effective}], backups[{file,path,bytes}], backupPath, savedAt, warnings[]}`。

**判定层函数(B1 新增,端点只是薄适配)**:`handleDataRequest({method, url, body, allowed, dir}) ⇒ {status, payload}` · `buildExportBundle()` · `importBundle(bundle, {dir})` —— 全部纯函数,状态码表被 `tests/data-api.test.js` 测穿。

---

## 2. 写路径:`lib/data-write.js`(唯一落盘入口)

```js
// 写:先备份 → 校验 → .tmp+rename → 失效缓存;校验不过 ⇒ 一个字节都不写
writeDataFile(name, obj, { dir, now, actor, backup }) 
//   ⇒ {ok, file, savedAt, effective, backupPath, bytes, schemaRev, warnings[], notes[]}
//   抛 DataWriteError(code): 'not-allowed' | 'invalid' | 'backup-failed' | 'write-failed'

validateDataFile(name, obj)          // 干跑:{ok, errors[], warnings[], file}
readDataFile(name, {dir})            // 只读:{file, exists, value, raw, bytes, parseError?, unreadable?}
backupDataFile(name, {dir, now})     // 备份到 backup/<file>.<ts>.bak;文件不存在 ⇒ {backedUp:false}
listBackups({dir, limit})            // ⇒ [{name, file|null, bytes, mtime}](**只列不删**)
fileStatus(name, {dir})              // 体检一行
setupStatus({dir})                   // §5 的回包
registerCacheInvalidator(fn)         // 宿主注册"某文件变了"的回调(fn(name, obj, ctx))
```

**错误码 → HTTP**(端点层映射,不许另立):`not-allowed`→`404` · `invalid`→`400` · `backup-failed`/`write-failed`→`500` · 写保护未过→`403`。

**缓存失效**:`persona.json` 落盘后由宿主重新 `loadPersona()`(已在 `lib/index.js` 注册);回调抛错**不影响**已完成的写盘(进 `notes[]`)。

### 2.1 白名单文件 / 生效语义 / 深链(唯一出处)

| 文件 | 生效 | 面板深链 |
|---|---|---|
| `config.json` | `now` | `#/cfg` |
| `persona.json` | `next-turn` | `#/persona` |
| `profile.json` | `now` | `#/profile` |
| `aliases.json` | `next-engine-call` | `#/aliases` |
| `names.json` | `next-engine-call` | `#/aliases` |
| `graph.json` | `next-engine-call` | `#/tuning` |
| `state-defaults.json` | `next-engine-call` | `#/state-lexicon` |
| `lexicon.json` | `next-engine-call` | `#/state-lexicon` |

---

## 3. 前端视图协议(照既有 `web/audit-view.js` 先例)

每个页面 = **一个独立文件** `web/views/<id>.js`,在 `index.html` 里 **先于 `app.js`** 加载:

```js
globalThis.EchoViews = globalThis.EchoViews || {}
EchoViews['<id>'] = {
  draw (el, api) { /* 只画 DOM;数据全靠 api */ }
}
```

- **`api` 是唯一取数通道**(主控注入):`api.get(path)` / `api.put(path, body)` / `api.post(path, body)` / `api.profile()`;
  **视图里不许出现 `fetch`、不许出现数据文件名与文件路径**。
- **`el`** = 该页面的 `<section>`;视图自带内联样式类,复用现有 CSS class(`card` / `btn` / `hint` …)。
- **三处 id 必须一致**(契约测试钉):
  1. `web/app.js` 的 `PANELS[]` 条目 `{id, nav, group, title, sub, draw}`
  2. `web/index.html` 的 `<section id="<id>" class="panel">` + nav 项 `id="nav-<id>"`
  3. `EchoViews['<id>']`
- **页面 id 表(冻结)**:`persona` `profile` `naming` `aliases` `tuning` `state-lexicon` `data-health`(① 引导条是全局横幅,无 id)。
- **深链** = 既有 hash 路由 `#/<id>`;引导条的 `deepLink` 只能取 §2.1 表里的值。
- **只读/写保护**:页面上的"保存"按钮必须走 PUT/POST;只读项(如 `/persona` 的 `defaults`、`relay.token`)只展示,不给编辑框。

---

### 3.1 视图实现细则(v1.1,2026-10-05 主控补;子代理照此实现)

1. **文件必须是 classic script**(无 `import`/`export`),照 `web/audit-view.js` 的样子;
   顶部 `globalThis.EchoViews = globalThis.EchoViews || {}`,结尾 `EchoViews['<id>'] = {...}`。
2. `draw(el, api)`:`el` = 该页的 `<section>`(页面**运行时自建 DOM**;子代理不许改 `index.html`)。
   **可重复调用**:重画/原地刷新都行,但不许重复叠加(幂等)。
3. **`api` 通道(冻结)**:
   ```js
   api.get(path)              // GET  → resolve 回包 JSON
   api.put(path, body)        // PUT  → 成功 resolve 回包;失败 reject({status, payload})
   api.post(path, body)       // POST → 同上
   api.profile()              // → 面板手里那份称呼对象(缓存;P1d)
   api.reload()               // 重画本页(保存成功后调)
   api.toast(text, kind)      // 顶部提示(文案见 §4;kind='ok'|'err')
   ```
   保存成功流程:**`api.toast('…生效文案…','ok')` → `api.reload()`**。
   失败流程:`err.payload.errors[]` **内联**显示在页内的 `<div class="hint err">` 里 —— **禁用 alert**。
4. **"不许出现文件名"的准确含义**:不许出现**文件系统路径**(`~/.dsh/echo`、`resolveDataFilePath`、`node:fs`、裸 `*.json` 当路径用);
   **必须**出现 API 路径 `/api/echo/data/<file>.json`(那是唯一写路)。**`fetch` 一律不许出现**(走 `api`)。
5. **可测性**:视图对象上要挂一份**纯逻辑**(零 DOM、零 io)给单测用,例如
   `EchoViews['<id>'].pure = { … }`;每个子代理的自测文件必须覆盖:契约扫描 + 纯逻辑行为。
6. `profile.json` 在 v1.1 加两个字段(主控已加进 SPECS):`uiIndexPrefix`(UI 索引前缀,空 = 用默认「对」)、
   `fallbackAddress`(兜底称呼,空 = 用中性「用户」)—— ④ 页读写它们。

## 4. 生效提示文案(§6.5;**不许各页自创**)

保存成功后必须显示下面对应的一句:

| `effective` | 文案 | 用在哪 |
|---|---|---|
| `now` | **已生效** | 调参(`config.json`)、显示类调参 |
| `now` | **已生效,刷新页面看界面** | 画像/称呼(`profile.json`) |
| `next-turn` | **下一轮生效** | 人格(`persona.json`) |
| `next-engine-call` | **下次引擎调用生效** | 别名/人名/图论/状态初值/词表 |

### 4.1 页面 ↔ 文件 ↔ API

| 页面 id | 内容(§6.2) | 文件 | 用到的 API |
|---|---|---|---|
| (横幅) | ① 上手引导条 | 只读聚合 | `GET /setup` |
| `persona` | ② 人格(升级现有编辑器) | `persona.json` | `GET /persona` + `PUT /data/persona.json` |
| `profile` | ③ 用户画像 | `profile.json` | `GET/PUT /data/profile.json` |
| `naming` | ④ 称呼与显示 | `profile.json` | `GET/PUT /data/profile.json` |
| `aliases` | ⑤ 别名与人名 | `aliases.json`、`names.json` | `GET/PUT /data/{aliases,names}.json` |
| `tuning` | ⑥ 图论与调参 | `graph.json` + 显示调参 | `GET/PUT /data/graph.json` |
| `state-lexicon` | ⑦ 状态与词表 | `state-defaults.json`、`lexicon.json` | `GET/PUT /data/…` |
| `data-health` | ⑧ 数据体检 | 全部白名单 + `backup/` | `GET /data/:file`、`POST /backup`、`GET /export`、`POST /import` |

**两条后续变更(2026-10-05)**:

- **「调参」副标题里的项数**由 `web/app.js` 的 `countSettingsFields(fields)` 从
  `GET /api/echo/settings` 的 `fields` **现算**(G9)—— 此前写死过 51 / 71,而字段表
  实际 `109`(真值由 `tests/settings-fields.test.js` 钉 README、`tests/web-dashboard.test.js`
  钉面板)。**新规矩:这个数字只许现算;拿不到字段表就不显示数字,不许猜。**
- **`lexicon.json.topicStopwords` 进面板**(⑦ 状态与词表 → 词库的标签字段)——
  与 `stopwords` 并排,口径一致:**留空 = 回程序里的语言默认表**(`lib/care-report.js`
  的 `TOPIC_STOPWORDS`),填了就**整表以数据为准**。读点 `topicStopwordsOf()`。

---

## 5. `GET /api/echo/setup` 回包(字段级冻结)

```json
{
  "configured": false,
  "dataDir": "C:\\Users\\…\\.dsh\\echo",
  "checkedAt": "2026-10-05T…Z",
  "files": [
    { "file": "persona.json", "exists": true, "empty": false, "broken": false,
      "unreadable": false, "bytes": 2794, "schemaRev": 1, "fieldCount": 6,
      "errors": [], "warnings": [], "deepLink": "#/persona",
      "hint": "她的人格前缀/后缀(下一轮对话生效)", "mtime": "2026-10-05T…Z" }
  ],
  "missing": ["lexicon.json"],
  "empty": ["names.json"],
  "broken": [],
  "hints": [ { "file": "lexicon.json", "deepLink": "#/state-lexicon", "hint": "情绪/话题词表(下次引擎调用生效)" } ]
}
```

- `configured` = 8 个文件里**至少一个存在、不空、不坏**(判定函数 `isEmptyContent`:"空串/空数组/空对象/`null`/`false`" 算空;`0` 算填过;`schemaRev`/`updatedAt` 这类结构记账不算)。
- `hints` = `missing ∪ empty ∪ broken`,顺序同上;`hint` 文案取自 `lib/data-write.js` 的 `HINT_BY_FILE`(单一出处)。
- 永不抛:读不动也回一个 `configured:false` 的形状。

---

## 6. 验收 curl 清单(B0 已交付 1 条)

```bash
# 1) 配置体检(B0)
curl -s http://127.0.0.1:3080/api/echo/setup
#    期待:{configured:true, files:[8 条], missing/empty/broken 是数组}
#    把 names.json 临时改名 ⇒ missing 里出现 "names.json";改回来 ⇒ 消失

# 以下 B1 交付后逐条可跑(路径进 docs/CONFIG_CENTER_CURL.md)
curl -s http://127.0.0.1:3080/api/echo/data/profile.json              # 2 读
curl -s -X PUT -H 'content-type: application/json' -H 'x-echo-edit: 1' \
  -d '{"schemaRev":1,"userName":123}' http://127.0.0.1:3080/api/echo/data/profile.json
#    ⇒ 400 + errors[];并且该文件字节不变
curl -s http://127.0.0.1:3080/api/echo/data/echo.db                    # ⇒ 404(白名单外)
curl -s -X PUT -H 'x-echo-edit: 1' -d '{}' http://127.0.0.1:3080/api/echo/data/profile.json
#    ⇒ 403(缺回环 Origin / 头不对)
curl -s http://127.0.0.1:3080/api/echo/data/export | grep -c 'echo.db' # ⇒ 0
```

> ⚠️ **宿主是旧代码**:新端点要**重启 `dsh web`** 才在 3080 上出现;在那之前上面第 1 条会 404。

---

## 7. 冻结记录

| 项 | 值 | 备注 |
|---|---|---|
| 契约版本 | v1 (2026-10-05) | B0 冻结;用户只审这一份 |
| 白名单 | `data-schema.js` 的 `DATA_FILES`(8 个) | 加文件 = 改契约,需报告 |
| 页面 id | §3 表 | 加页面 = 改契约,需报告 |
| 文案 | §4 四条(§6.5 五行) | 各页不许自创 |
| 深链 | §2.1 表 | 引导条只能取表内值 |

### v1.1(2026-10-05,B1+B2 期间主控补,已报告用户)

| 项 | 变 | 为什么 |
|---|---|---|
| §1 row2 `raw` 语义 | 只在不读不出对象时回 / `?raw=1` 强制 | 用户 B1 前点名要明确 |
| §1 导出包 `missing[]` / 导入回包 `backups[]` | 新增字段(增量) | 缺文件要列出来、备份要看得见 |
| §2 判定层函数 | `handleDataRequest` / `buildExportBundle` / `importBundle` 公开 | 端点只做写保护;状态码表可被临时目录测穿 |
| §3.1 `api.reload()` / `api.toast()` | 新增(契约原 `api` 只有 get/put/post/profile) | 用户 B2 里说"保存后调 ctx.onChange()" —— 契约没有它,落到 `reload` |
| §3.1 第 6 条 | `profile.json` 加 `uiIndexPrefix` / `fallbackAddress` | §6.2 ④ 页要写它们;原先这两个值是 `web/app.js` 里的硬编码 |
| `lib/persona.js` | 落盘改走 `writeDataFile`(钳位仍用它自己的 `sanitize`) | §6.3 末行;**用户 2026-10-05 明确批准** |
| 新只读端点 `GET /api/echo/data/backups` | `{ok, count, files:[{name,file,bytes,mtime}]}`,倒序,`?limit=&file=` 可选,**只列不删、回包不带路径** | ⑧ 页要显示备份清单;契约原来没有这一条(原 7 条 API 里没有列备份) |
| `GET /api/echo/data/:file` 回包加 `template` | 该文件的空模板(与 `exists` 无关,恒有) | ⑧ 页"重建坏文件/新装"要用;视图不许读 `lib/**`,所以模板得由端点给 |
| `GET /api/echo/setup` 回包加 `backup` | `{count, newest}`(只数不删) | ⑧ 页要在同一屏显示"有几个备份 / 最新的是哪个" |
| ⑤ 候选读路 = **`GET /api/echo/graph`** | 不是 `data/graph.json`(那是图论调参,没 `nodes`) | 契约 §6.2 说"从**图谱**提候选";真图谱由 `store.graphData()` 供(`lib/store.js:1118`),每项 `{id,name,type,…}`。裁决于 B3,主控已同步子代理 |
| ① 引导条落地 | 视图 id **`setup-banner`**(`web/views/setup-banner.js`),容器 `#setup-banner`;**不进 `PANELS`、没有 nav、没有 hash 路由** —— 它不是一页 | 契约 §4.1 那行"(横幅)"本来就只读聚合 `GET /setup`;`PANELS` 管的是"能导航到的分区",横幅常驻 |

### v1.2(P3-a「通路先行」,2026-10-05)

| 项 | 定下来的东西 | 为什么 |
|---|---|---|
| `graph.json.relations.canonical` 的形状 | **`object`(map:`{现场写法: 规范写法}`)** —— `lib/data-schema.js` 从误写的 `object[]` 改成 `object` | 拍板 6「以代码用法为准」:引擎侧 `relations.CANONICAL_RELATION` 就是 map,且靠"值==键"认自映射(`python/engine/relations.py:103-121`) |
| 新读点模块 `lib/data-tables.js` | graph / lexicon / state-defaults 三个文件的**通用只读读点**(缺 / 坏 / 空 ⇒ 空对象且不抛) | P3 迁移前必须先有读点,否则"导进去等于写哑字段"(P3 迁移设计 §1.5);旧读点散在各模块,这三份一个都没有 |
| 引擎帧新增 `data` 键 | `lib/engine.js::frame()` 下发 `data: frameData()`;形状 `{version, graph:{relations,display,windows}, lexicon:{timeWords,stopwords,topicStopwords,longingMarkers,powerWords}, stateDefaults:{…}}` | 数据要下发到 python 才有读点;引擎侧解析 = `python/engine/graph_gate.py::data_from_frame()` |
| 引擎侧数据覆盖口径 | `relations` / `timeintent` / `judge` 各有一个 `configure_from_data(data)`;`python/worker.py::handle()` 每帧分发一次(数据块与整帧两种形状都认) | 空 / 缺 / 坏 ⇒ **回落内置表 = 迁移前行为**(P3 的等价性要求);任何脏数据都不许把这一帧带崩 |
| 已接的三条通路(每条一个读点,先证明路通) | ① `state-defaults.json` → `lib/emotion.js::defaultEmotionVector()` + `lib/store.js::getState()`(JS)、`judge._mood_default()`(引擎) ② `graph.json.relations.canonical` → `relations.canonical_relation()` ③ `lexicon.json.timeWords` → `timeintent` 的 6 张线索表 | A 步(通路先行)的验收;**其余读点与"搬值"由 P3-b/c/d 分批补**,不在这里重复 |
| 新增数据的 schema 形状 | `lexicon.json` 加 `topicStopwords` / `powerWords` / `longingMarkers`;`graph.json.relations` 加 `multiValueKeys` / `identityRelations`(形状先定死,四个搬运批次照它写) | 迁移落点若没有 SPEC,写入会被判"未知字段";预置一次胜过分批各写各的 |
| `python/engine/normalize_relations.py:80` 的待定表读点 | 一行改走 `relations.pending_relations()`(B2 落,P3-e 记档) | #9 的唯一消费点就在 `survey()` 报表里 —— 不改这一行,`graph.json.relations.pending` 就是哑字段 |
