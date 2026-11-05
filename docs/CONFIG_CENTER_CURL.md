# P2 配置中心 · 验收 curl 清单(B0 + B1)

> 用法:重启 `dsh web` 后在**同一台机器**上逐条跑(`/api/echo/*` 只回环可写)。
> 写操作要两个头:**回环 Origin** + **`x-echo-edit: 1`**(§6.1 写保护)。
> 下面 `BASE=http://127.0.0.1:3080`。数据目录默认 `~/.dsh/echo`(Windows:`$env:USERPROFILE\.dsh\echo`)。
> ⚠️ **宿主跑的是旧代码时不重启 ⇒ 新端点会 404**,不是坏了。

```bash
BASE=http://127.0.0.1:3080
EDITS=(-H 'content-type: application/json' -H 'x-echo-edit: 1' -H 'origin: http://127.0.0.1:3080')
```

## 1. 配置体检(B0)

```bash
curl -s $BASE/api/echo/setup
```
**期待**:`configured:true`(你的目录) + `files` 8 条 + `missing/empty/broken` 是数组。
我这边真数据实测:`configured=true`、`empty=["graph.json","state-defaults.json"]`、`missing=[]`、`broken=[]`。
**一眼验**:`echo $? `=0 且 JSON 里能看到 `"deepLink":"#/tuning"` 这类深链。

## 2. 读一个数据文件(B1)

```bash
curl -s $BASE/api/echo/data/profile.json
curl -s "$BASE/api/echo/data/profile.json?raw=1"     # 强制回原文(raw 恒等于盘上字节)
```
**期待**:默认**不带** `raw`;带 `?raw=1` 才有。文件不在 ⇒ `{"exists":false,...}`(**不是 404**)。

## 3. 写保护与白名单(一眼验)

```bash
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/echo/data/echo.db                    # 期待 404
curl -s -o /dev/null -w '%{http_code}\n' -X PUT -H 'content-type: application/json' \
  -d '{}' $BASE/api/echo/data/profile.json                                             # 期待 403(没带头)
curl -s -X PUT "${EDITS[@]}" -d '{"schemaRev":1,"userName":123}' \
  $BASE/api/echo/data/profile.json                                                     # 期待 400 + errors[]
```
**一眼验**:400 那条之后,`profile.json` 的**字节没变**(`Get-FileHash` 或 `ls -l` 对比)。

## 4. 一次真写(会不会备份 + 原子)

```bash
cp ~/.dsh/echo/profile.json /tmp/before.json
curl -s -X PUT "${EDITS[@]}" \
  -d "$(python -c 'import json,sys;d=json.load(open("'"$HOME"'/.dsh/echo/profile.json"));d["userName"]="测试";print(json.dumps(d,ensure_ascii=False))')" \
  $BASE/api/echo/data/profile.json
ls -lt ~/.dsh/echo/backup/ | head -3          # 期待:当场多一个 profile.json.<ts>.bak
diff <(cat /tmp/before.json) ~/.dsh/echo/backup/profile.json.*.bak | head    # 期待:无差异(备份=旧内容)
```
**一眼验**:回包 `{"ok":true,...,"effective":"now"}`;`backup/` 多一份且内容 = 改前。

## 5. 导出 / 导入(B1)

```bash
curl -s $BASE/api/echo/data/export > /tmp/bundle.json
grep -c 'echo.db' /tmp/bundle.json          # 期待 0
python -c 'import json;b=json.load(open("/tmp/bundle.json"));print(sorted(b["files"]),b["missing"])'   # 期待 8 个文件名
curl -s -o /dev/null -w '%{http_code}\n' -X POST "${EDITS[@]}" \
  -d '{"bundle":{}}' $BASE/api/echo/data/import      # 期待 400(缺 confirm:true)
```
**一眼验**:导出包里**没有** `echo.db`;不带 `confirm` 的导入被拒;带 `confirm:true` 的导入会先在 `backup/` 留痕(我这边在真数据副本上实测:8 个文件整包导回 ✓)。

## 6. 面板数据体检页(⑧,B3 交付后)

- 打开 `#/data-health`:能看到 8 个文件的**大小 / schemaRev / 空 / 坏 / 深链**;
- 点「导出」:下载/弹出 bundle;点「备份」:回包带 `files[]` 明细;
- 备份列表**只列不删**(定死的纪律)。

## 7. B3 四页 + 两个新只读端点(⑤⑥⑦⑧)

```bash
# 备份清单(⑧ 页的列表;只读、只列不删、回包不带路径)
curl -s "$BASE/api/echo/data/backups" | python -m json.tool | head -20
curl -s "$BASE/api/echo/data/backups?file=profile.json"    # 只列这个文件的备份
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE $BASE/api/echo/data/backups   # ⇒ 405(根本没有删除路由)

# 空模板(⑧ 页「重建」用;GET 一个文件就顺带拿到)
curl -s "$BASE/api/echo/data/lexicon.json" | python -c 'import json,sys;d=json.load(sys.stdin);print(sorted(d["template"]))'

# 四页各自的数据(改之前先看一眼)
curl -s "$BASE/api/echo/data/aliases.json"        # ⑤ rules[]（别名 → 正名 / tier）
curl -s "$BASE/api/echo/data/graph.json"          # ⑥ weights/thresholds/windows/relations/display
curl -s "$BASE/api/echo/data/state-defaults.json" # ⑦ 初值
curl -s "$BASE/api/echo/data/lexicon.json"        # ⑦ 词库
```

**四页一眼验**(重启 `dsh web` 后):

| 页面 | 一眼验 |
|---|---|
| ⑤ `#/aliases` | 列出 `rules[]`;加一行 `别名=小e / 正名=Echo / tier=1` 保存 → 顶部出现「**下次引擎调用生效**」;`backup/` 多一份 `aliases.json.<ts>.bak` |
| ⑥ `#/tuning` | `graph.json` 现在是**空的** ⇒ 页面应显示"还没有值,填一个就是第一个",**不该报错**;填一个权重保存 → 回包 `effective=next-engine-call`;`display` 那组行尾能看到"现行默认,来自 `web/graph.html`"的说明 |
| ⑦ `#/state-lexicon` | 上半是状态初值、下半是词库;两个**各自的**保存按钮;改 `bannedWords` 保存 ⇒ `lexicon.json` 变、`state-defaults.json` 一字节不动(反之亦然) |
| ⑧ `#/data-health` | 顶部「configured ✓」+ 人话结论;表里 `graph.json`/`state-defaults.json` 标 **empty**(你现在的真实现状),其余 ok;每行有 `#/<页>` 深链;<br>「一键备份全部」⇒ `backup` 数从 6 变 7;列表里**没有**任何删除按钮(页内写明"本页不删任何东西") |

> ⚠️ 同 §5 的提醒:旧进程上新端点不存在,先重启。

## 8. ① 上手引导条(B4 收尾)

```bash
curl -s $BASE/api/echo/setup | python -c 'import json,sys;s=json.load(sys.stdin);print("configured=",s["configured"]);print("empty=",s["empty"]);print("missing=",s["missing"])'
```
**一眼验**(引导条**不是一页**:左栏没有它的条目、地址栏也不会有它的 hash):

| 你现在的状态 | 横幅该长什么样 |
|---|---|
| `configured=true`(你此刻:`empty=[graph.json, state-defaults.json]`) | **完全不出现**(只在"什么都没配"时才红) |
| 想看它长什么样 | 把 `~/.dsh/echo/lexicon.json` 临时改名 ⇒ 刷新页面 ⇒ 页顶出现红色横幅「⚠ 还没配好:1 个文件不在 —— 点右面的分区去补」,行里 `lexicon.json ✖ 文件不在` + 可点深链「状态与词库」;改回来 ⇒ 自己消失 |
| 想让"空"也提醒 | 契约口径:横幅只列 **missing / broken / empty**(`empty` 那两行你现在就有,只是 `configured` 已 true ⇒ 不红) |

判定口径与 ⑧ 页同一套(missing > broken > empty > ok),深链**只认服务端发的 `deepLink`** —— 视图里一个写死的 `#/xxx` 都没有(有测试钉着)。

---

## 我这边的真数据实测结果(B1,只读 + 副本)

| 检查 | 结果 |
|---|---|
| `GET /data/export`(你的真目录) | `200`,含 8 个文件、`missing=[]`、**无 `echo.db`** ✓ |
| `GET /data/profile.json` | `200`,`value.userName=用户`,**不带 raw** ✓ |
| `GET /data/profile.json?raw=1` | `raw` 与盘上字节**逐字一致** ✓ |
| `GET /data/echo.db` | `404` ✓ |
| `PUT /data/profile.json`(无写保护) | `403` ✓ |
| `PUT /data/profile.json`(**目录副本**上) | `200`,`effective=now`,备份=旧值,文件已变 ✓ |
| `POST /data/import`(整包 → 空目录) | `200`,8 个文件全导回 ✓ |
| **你的原件** | `profile.json` 仍是 `用户`,一字节未动 ✓ |
