# A1–A5 上真库 · 执行手册(照念版)

> 这份是给**那一次**用的:每一步 = **一条命令 + 一个预期数 + 一句回退**。
> 纪律:①真库只在最后那一步碰;②**每一步都先看数,数不对就停**;③真库上的**报表**只许
> `mode=ro` 直连(**不许**跑走 `db.connect()` 的引擎模块 —— 它会纯增建表,2026-10-02 我就这么踩过一次);
> ④不重启宿主;插件重挂载由他说时间。

## 〇、上之前(冷备)

```powershell
cd $env:USERPROFILE\.dsh\plugins\dsh-echo
python .scratch\a9-snapshot.py          # 一致快照(只读源 + sqlite3.backup)
# 记下它打印的 snapshot_path —— 这就是**回退点**;真库读数与快照必须一致(same: true)
$b = Get-Content .scratch\config-baseline.json -Raw | ConvertFrom-Json
(Get-FileHash $b.path -Algorithm SHA256).Hash.ToLower() -eq $b.sha256    # 活配置 sha 必须 True
```

**回退点**:`.scratch/snapshots/echo-<ts>-chain-pre.db`。真库出事 ⇒ 停进程,拿这份覆盖回去。

## 一、A1 换代语义修复(形态 **E**:同题重复守卫默认开)

```powershell
cd python
python -m engine.repair_multivalue --db $env:USERPROFILE\.dsh\echo\echo.db --json        # ① 只演:先看数
python -m engine.repair_multivalue --db $env:USERPROFILE\.dsh\echo\echo.db --apply --json # ② 真写
```

**预期数(链前副本实测,已用**代码里的守卫**逐档复验过)**:唤回**边 5**、唤回**记忆 3**
(#126/#291/#313)、**按住 2**(#127←现役 #169 盖 0.615;#128←现役 #169 盖 0.778)、**单值换代不动**、
回执 **+8**(5 边 + 3 记忆);活跃边 24→**29**,活跃记忆 236→**239**,活跃 L0 5→**8**。
⚠️ 想回"全量形态"加 `--no-repeat-guard`;想回"形态 C"加 `--active-cover 0.40`(会把 #126 也按住)。

**回退**:`Copy-Item .scratch\snapshots\echo-<ts>-chain-pre.db <真库>`(事实层不是回执制)。
**代价(已知并接受)**:R1BM25 mrr@10 0.694→**0.671**、SEH@3 **不动**(76.2%)、图臂 0.135→0.084。

**读档小坑**:PowerShell 的 `Out-File -Encoding utf8` 在这里会写 **带 BOM** 的 UTF-8 ⇒
python 读它要 `encoding="utf-8-sig"`(否则 `JSONDecodeError: Unexpected UTF-8 BOM`)。

## 二、A2 谓词归一

```powershell
python -m engine.normalize_relations --db $env:USERPROFILE\.dsh\echo\echo.db --apply --json
python -m engine.normalize_relations --db $env:USERPROFILE\.dsh\echo\echo.db --report ..\.scratch\a2-live-map.md
```

**预期**:改名 **1 条**(边 #40 `读于 → 就读于`)、合并 0;活跃谓词 **34 → 23**,
扣掉**待你裁定的 8 条 pending** 后 **15**(≤16 达标)。那 8 条**等你的裁定**,这次不碰。

**回退**:同上一份快照覆盖(改的是 `relation/relation_raw` 两列)。

## 三、A4a 证据层(13 行,从影子表派生)

```powershell
python -m engine.cooc --db $env:USERPROFILE\.dsh\echo\echo.db --apply --json
```

**预期**:`graph_cooc_evidence` **13 行**(same_memory 8 + same_day 5)、派生对 52;
影子表 **48 行一字不动**;**边/记忆/回执/槽位逐位不变**(这一步零副作用)。

**回退**:`python -m engine.arch --db <真库> --rollback cooc-evidence --apply`(要回来再 `engine.cooc --apply`)。

## 四、A5 主题簇(2 簇)

```powershell
python -m engine.topics --db $env:USERPROFILE\.dsh\echo\echo.db --apply --json
python -m engine.topics --db $env:USERPROFILE\.dsh\echo\echo.db --prompts ..\.scratch\topics-prompts.json   # 要摘要才跑
```

**预期**:现行 **2 簇 / 14 成员 / 1 软归属**,批次 `topic-<ts>`;事实层**逐位不动**。
⚠️ 簇数是 **2**,不是计划里写的 3~12 —— 因为证据层只有 13 行(验收①如实记为"未达标")。

**回退**:`python -m engine.arch --db <真库> --rollback topic-view --apply`。

## 五、上完立刻核(三条)

```powershell
# ① 既有检索台:拿 A1 之后的数当新基线(它已经含 A1 的代价)
python ..\scripts\retrieval-bench.py --db $env:USERPROFILE\.dsh\echo\echo.db > ..\.scratch\a-live-bench.txt
python ..\scripts\assoc-bench.py --tiers ..\.scratch\a-live-bench.txt --baseline ..\.scratch\a9-bench-a1.txt   # 期望:全档不退(退出码 0)
# ② 证据债:分母该缩
cd python; python -m engine.evidence_debt --db <副本>      # 真库上**只在副本**跑这个(它是 db.connect)
# ③ 面板:GET /api/echo/graph-arch 该回 200 且各格有数(要插件重挂载之后)
```

## 六、插件重挂载(不是重启宿主)

新端点(`/api/echo/graph-arch`)与面板那张「记忆架构 v2」卡**只在重挂载后生效**。
**时间由他定,我不动宿主**。挂上之后核:`/api/echo/graph-arch` 回 200(当前是 401 ⇒ 没挂上)。

## 七、别做的事(红线与纪律)

- 不 `git add -A`、不 commit、不改宿主文件、不重启宿主;三条红线(压缩域 / 人格注入点 / `lib/relay.js`)不碰。
- 新读口**不进** `load()`/`render_paths()`;PPR **只报表**,接进 prompt 要他单独批准。
- 每一步的 `.scratch` 副本演练报告:A1 `a1-*`、A2 `a2-*`、A4 `a4*`、A5 `a5*`、全链 `a9-report.md`、
  A1 代价与形态选择 `a11-report.md`、面板与回退 `a7-report.md`。
