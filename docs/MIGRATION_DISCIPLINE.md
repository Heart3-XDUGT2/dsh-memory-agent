# 迁移纪律(MIGRATION_DISCIPLINE)

> 记忆架构 v2(`docs/PLAN_MEMORY_ARCH_V2.md`)的**施工规矩**。凡是要动 `echo.db` 的那一期
> (A1 换代语义、A2 谓词归一、A3 边类型化、A4 证据层、A5 主题簇),**都按这五步走**。
> 一句话:**先在副本上把它弄坏,确认能救回来,再去真库动一次。**

---

## 五步,一步不许省

| 步 | 动作 | 命令 | 过闸条件 |
|---|---|---|---|
| **1 回退点** | 给真库拉一个一致快照 | `node scripts/graph-snapshot.mjs --label=<期名>-before` | `integrity ok` + schema 指纹一致 + 逐表行数一致 + **真库 sha/mtime 未变** |
| **2 副本演练** | 把快照放到 `.scratch` 里,在那上面把迁移**跑到通** | `node scripts/graph-snapshot.mjs --copy-to .scratch/rehearsal/<名>.db` 然后 `--db .scratch/rehearsal/<名>.db` 跑迁移脚本(`--dry-run` 先) | 迁移脚本 exit 0;副本 `integrity ok`;该期"验收数字"在副本上**先看到一遍** |
| **3 报给他** | 把**清单/对照表/数字**贴给他,等点头 | — | 他点头(或明确说"你定" ⇒ 记在文档里) |
| **4 真库一次** | 对真库执行一次 `--apply`(同一命令、同一参数) | 例:`node scripts/graph-repair-multivalue.mjs --apply` | 命令 exit 0;每步写 receipt/留痕 |
| **5 验收 + 留档** | 照该期"④验收"逐项跑数字,并把回退点与报告记进 CHANGELOG | `node scripts/graph-baseline.mjs` / 该期报表 | 数字达标;不达标 ⇒ **立刻回滚**(下节) |

**另有一条随时的体检**:`node scripts/rehearse-migration.mjs` —— 证明"新版代码打开真库"那一秒不会出事
(它会把真库 VACUUM INTO 到临时副本,再验:原有表一张不少、行数逐张一致、`integrity_check` ok)。

---

## 回滚(两种,都默认只演)

```bash
# 只演:显示"如果滚,会变成什么样"(逐表差异)
node scripts/graph-rollback.mjs --snapshot .scratch/snapshots/echo-<stamp>-<label>.db

# 滚一个副本(安全,随便滚)
node scripts/graph-rollback.mjs --snapshot <快照> --to .scratch/rehearsal/x.db --yes

# 滚真库(三重旗标 + 必先备份):**只在 dsh host 没在跑、且他同意时**做
node scripts/graph-rollback.mjs --snapshot <快照> --to-live --live --yes
```

- 默认 **dry-run**:不带 `--yes` 一行都不改。
- 真滚之前**必给目标备份**(`pre-rollback-<stamp>[-live].db`),并且把目标的 `-wal`/`-shm` 挪开
  (文件名后缀 `.pre-rollback-<stamp>`)—— 换库文件却留着旧 WAL 会毁数据。
- 滚完自动验:`integrity_check` ok + 逐表行数 == 快照。
- **真库回滚需要 host 停**:引擎可能正持有那个库的连接。平时只滚副本。

---

## 硬规则(违反即停)

1. **先副本,后真库**。任何 `--apply` 之前必须在副本上成功跑过一遍。
2. **迁移脚本默认 `--dry-run`**,并且 `--dry-run` 必须能产出**给人看的清单**(不是只打"OK")。
3. **纯增优先**:新表 / 新列 / 新脚本 > 改旧逻辑;改旧必须留档列(`slot_v1` / `relation_raw` 之类)。
4. **每期可独立回退**:回退步骤写进该期文档,并在副本上演练过。
5. **三条红线不碰**:压缩域 / 人格注入点 / `lib/relay.js`。新读口(PPR、簇)不进 `load()`/`render_paths()`;
   要进 prompt = **另一次他的独立裁决**。
6. **不 commit、不 `git add`、不改宿主文件、不重启 host**。需要重挂载/重启时 **报告他**。
7. **活配置绊线**:测试跑完 `$DSH_HOME/echo/config.json` 的 sha256 + mtime 必须不变。
8. **快照进 `.scratch/`**(已 gitignore):快照里是真库全量,**绝不能进 git**。
9. **单一判定处**:口径只在引擎里算一次;脚本与面板只显示,不重算。
10. **改动只走一条路**:写边仍只在 `python/engine/graph.py`(既有纪律:Python 是唯一写边源)。

---

## 快照命名与保留

- 形态:`echo-YYYYMMDD-HHMMSS[-label].db` + 同名 `.manifest.json`(含 sha256、逐表行数、schema 指纹、真库 mtime)。
- 默认保留最近 **10** 个(`--keep=N` 可调),**永不删最新那个**。
- 回滚点的"名字"就是 label:`a0-baseline` / `a1-before` / `a1-after` …
