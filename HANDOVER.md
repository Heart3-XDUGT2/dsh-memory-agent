# dsh-echo 交接文档

> 写给接手的人(或下一个我)。里面每一条路径 / 命令都是**从代码里查实的**,不是凭记忆写的。
> 最后核对时间:2026-10-02(0.2.0-rc 适配 + 记忆架构 v2 落地后)。

---

## 〇、2026-10-02 增补:接手前先看这三块

1. **宿主世代:DSH 0.2.0-rc.2**(2026-10-02 升级完毕)。预设发行机制换了代,插件已做
   **双世代适配** —— 全文与实测收据在 [`docs/COMPAT_DSH_0.2.md`](docs/COMPAT_DSH_0.2.md)。
   ⚠️ **升级/换机装完后必做一步**:在本目录跑 `node scripts/install-preset.mjs`
   (自动生成 0.2.0 的预设声明行「Echo 陪伴模式」+ 把 `dsh.bundle.patch` 摆成当代形态;
   不跑也不坏,只是预设名单里没有它)。验证:`node scripts/check-preset-patch.mjs`。
   ⚠️ **已知 0.2.0-rc 地雷(2026-10-03 已修)**:v4 会话格式要求**注入消息的
   `source.kind` 写"产出者自有"形状**(`plugin:dsh-echo`)—— 旧的 `kind:'plugin'` 会被
   宿主直接拒(`format v4 message requires a producer-owned source kind`),整轮运行失败、
   她在 QQ 上不回(子代理会话不受影响,看着像"只坏一条会话")。常量/容错判定/红线兼容视图
   都在 `lib/source-kind.js`,防回退钉在 `tests/source-kind.test.js`。
   **别再手抄 source 字面量** —— 用 `ECHO_SOURCE_KIND`。
2. **记忆架构 v2 已落地**(A1/A2/A4a/A5 + 图谱门/幽灵层/凭据债等 A1–A20):
   计划与全部实测数在 [`docs/PLAN_MEMORY_ARCH_V2.md`](docs/PLAN_MEMORY_ARCH_V2.md),
   真库执行手册 [`docs/A_APPLY_RUNBOOK.md`](docs/A_APPLY_RUNBOOK.md)。
   面板图谱页多了「史/联想」两个幽灵层开关(默认关);共现只做**证据层**不进检索。
3. **打包交接的三条红线**(`lib/relay.js` / `persona.json` 注入点 / `cordis.patch.yml`
   不许改,详见七-红线)+ **交接前必办清单**:见文末「附:打包交接检查单」。

---

## 一、这是什么、和另一个包的关系、当前版本

**`dsh-echo` 是「脑」**:DeepSeek Harness(DSH)的陪伴人格与记忆插件 —— 人格、记忆库、
气泡与节奏、打断、想念曲线、主动性、工具族(`echo_remember` / `echo_forget` / `echo_memory` /
`echo_wake` / `echo_scope` / `echo_qq_say` / `echo_qq_call` …)、设置区面板、网页审查台(`/echo/`)。
她给 DSH 装上灵魂,而不是变成另一个聊天机器人。

**`dsh-echo-qq` 是「嘴」**(另一个独立仓库:`~/.dsh/plugins/dsh-echo-qq`):
QQ(OneBot 11 / NapCat)渠道插件 —— 只负责私聊收发、送达回执、心跳、一页自己的诊断页。
**她要不要说、说什么、分几泡、什么时候说,全在主包**;嘴只搬运。

两个包怎么接上:主包在 `lib/index.js` 里 `ctx.provide('echo:relay', {…})`(服务名见
`lib/speak.js` 的 `SERVICE_NAME = 'echo:relay'`),渠道插件用 `ctx.get('echo:relay')` **能力探测**。
主包不在 ⇒ 嘴说不出话(渠道插件状态里如实报 `none`,旧的 HTTP 兜底已随旧桥于 2026-09-28 退役)。
契约:`lib/speak.js` 的 `SERVICE_VERSION` / `SERVICE_API` / `SERVICE_CAPABILITIES`,消费端在同仓
`dsh-echo-qq/lib/contract.js`,跨仓各钉一条测试。

| | 值 |
|---|---|
| 包名 | `dsh-echo` |
| **当前版本** | **`0.45.0`**(`package.json` ↔ `CHANGELOG.md` 顶部一致) |
| 仓库位置 | `~/.dsh/plugins/dsh-echo`(独立 git 仓库,**没有 remote**;不许擅自 push) |
| 入口 | `main: lib/index.js`;客户端半侧 `./client` → `lib/client.js` |
| 装机形态 | **link**(装机位是指向源码区的 junction;另有 copy 装机与 tarball 两条,见三) |
| 引擎 | Python 侧车 `python/worker.py`(子进程),壳在 `lib/sidecar-client.js` |

---

## 二、前置条件

| 依赖 | 要求 | 依据 |
|---|---|---|
| **Node.js** | **≥ 22.5**(不是 ≥18 —— 那是假的) | `package.json` 的 `engines`;`lib/store.js` 用的是 **`node:sqlite`** 的 `DatabaseSync`,老 Node 没有这个内置模块 |
| **Python** | **≥ 3.9**(低版本会被探针判不合格,退回基线路径) | `lib/sidecar-client.js` 的 `PY_MIN_MAJOR = 3` / `PY_MIN_MINOR = 9` |
| **Python 依赖** | **零**(不需要 `pip install`) | 引擎 `python/engine/*.py` 与 `python/worker.py` 只 import 标准库:`json` / `re` / `sqlite3` / `math` / `unicodedata` / `uuid` / `heapq` / `pathlib` / `sys` / `time`(仓里**没有** `requirements.txt` / `pyproject.toml`) |
| **pnpm** | 要有(tarball 装机时宿主走自己的包管理器;本机实测 pnpm 12.4.1) | `README.md` 装机段 / `CHANGELOG.md` 条目 |
| 本机实测环境 | Node **v24.21.0**、Python **3.14.7** | 本次交接时现场 `node -v` / `python --version` |

**Python 解释器怎么找**(探测链,从上到下第一个合格的胜出)
——`lib/sidecar-client.js` 的 `detectPython()`:

1. 环境变量 `ECHO_PYTHON`(绝对路径最好);
2. `~/.dsh/echo/config.json` 里的 `pythonPath`(面板可配);
3. `PATH` 上的 `python` → `python3`。

探针实测版本,超时 3s(Windows 应用商店那个"假 python"会在这里被自然淘汰)。
找不到 / 版本低 / 连败 3 次熔断 ⇒ 引擎降级到冻结基线或 offline,**人格照常、绝不陪葬**
(记忆功能降级,不是插件挂掉)。

---

## 三、安装

三条路,**选一条**。

### A. link 装机(本机现形态:源码目录即装机位)

```powershell
# ① 插件源码区要有自己的 node_modules junction —— 这是 link 装机的命门(见九-2)
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\plugins\node_modules" `
  -Target "$env:USERPROFILE\.dsh\profiles\node_modules"
# ② 装成 link,并写进 profile 的 dsh.profile.bundles
dsh plugin --profile web add "$env:USERPROFILE\.dsh\plugins\dsh-echo"
# ③ 校验 / 诊断
node scripts\install.mjs --check    # 装机位 + 登记 + 宿主包解析
node scripts\install.mjs --doctor   # 起不来时先跑这条:逐条指名问题与修法
```

重启 `dsh web`,浏览器**硬刷新**。改 `lib/` 或 `python/` 必须重启;改 `web/` 刷新页面即可;
只有 `cordis.patch.yml` 是 live 重载。

### B. tarball 装机(发给别人 / 换机器)

```powershell
cd $env:USERPROFILE\.dsh\plugins\dsh-echo
npm pack                                    # ⇒ dsh-echo-0.45.0.tgz(会先跑 prepack 清 pyc)
dsh plugin --profile web add "$env:USERPROFILE\.dsh\plugins\dsh-echo\dsh-echo-0.45.0.tgz"
dsh --profile web --dump-config             # 两处登记都在、零错误才算装对
```

> ⚠️ **别用裸名装**:`dsh plugin add dsh-echo` 装的是 **npm 上的同名占位包 `dsh-echo@0.0.1`**
> —— 它**没有 `dsh.bundle`**,CLI 只会警告「declares no dsh.bundle — installed as a plain
> dependency」。要装本插件,一定给 **tgz 的绝对路径**(或本目录路径)。

### C. copy 装机(旧形态,与 afaccess 同构)

```powershell
node scripts\install.mjs            # 复制装机 + 登记 bundle/依赖(tgz),自检装机位
```

link 形态下直接跑它会**退化成"只校验"**;要真改回复制装机,先 `--remove` 再跑。
它还会 `npm pack` 一个 tgz 到 `profiles/web/.dsh-echo-local/` 并写进 profile 的 `dependencies`
—— 这样万一有人 wipe 掉 `node_modules` 再 `dsh plugin install`,文件能被装回来,
不至于 `cannot resolve profile bundle` 把整个 `dsh web` 拦在启动外面。

### 可选:换压缩后端(D1 策展压缩)

```powershell
node scripts\install-preset.mjs          # 生成「Echo 陪伴模式」预设
node scripts\install-preset.mjs --check  # 宿主升级后跑这条看要不要重新生成
node scripts\install-preset.mjs --remove # 删掉
```

生成物落在 `<DSH_HOME>/.agent-presets/echo/{agent.cordis.yml,preset.yml,.echo-generated.json}`。
**不选这份预设 ⇒ 一切照旧**,可回退。

---

## 四、配置

配置**不在代码里、也不在 profile 里**,住在数据目录:
`~/.dsh/echo/config.json`(`lib/toggle.js` 的 `CONFIG_PATH = join(DATA_DIR, 'config.json')`,
`DATA_DIR` 见 `lib/persona.js`;`DSH_HOME` 可改根)。

配置面有三处,**改完下一轮生效**(设置卡保存人格后无需重载):

| 面 | 在哪 | 管什么 |
|---|---|---|
| **设置 → Echo** | DSH 设置区 | 电源开关 / 状态仪表盘 / 想念值 / 情绪历史 / 人格编辑器(前段身份 + 尾段铁律与说话方式)/ 危险区(整库清空)/ 「打开审查台 ↗」 |
| **网页审查台** | `/echo/` | 看板(记忆图谱 / 悬置话题 / 对话回放 / 记忆管理 / 记忆体检 / 日记 / 审计流 SSE)+ **调参 111 项**(字段表由 `GET /api/echo/settings` 发下来,清单在 `lib/settings-fields.js`,数量由 `tests/settings-fields.test.js` 钉着;面板副标题里的数字由 `web/app.js` 的 `countSettingsFields()` **现算**,不写死) |
| 文件 | `~/.dsh/echo/config.json` | 开关 / 会话范围 / 白名单 / 标签 / `pythonPath` / 陪伴会话 `cwd` / `sessionId` 等 |

常用键(在 `config.json` 里):
- `enabled`(总闸)、`scope`(`all` / `whitelist`)、`whitelist`、`exempt`、`sessionLabels`
- `pythonPath` —— 指定 Python 解释器(空 = 走探测链)
- `cwd` —— 陪伴会话的工作目录;**留空 = `~/.dsh/echo/workspace`**(`lib/index.js` 的 `companionCwd()`)
- `sessionId` —— 陪伴会话 id,默认即 `lib/companion-target.js` 的 `DEFAULT_COMPANION_ID`

网页 API:`GET /api/echo/status`(仪表盘 / `care` 当场结论)、`GET|POST /api/echo/persona`、
`GET /api/echo/settings`。

---

## 五、数据与备份

**数据根**:`~/.dsh/echo/`(`DSH_HOME` 可改;`DATA_DIR` 见 `lib/persona.js`)。
**源码在 `~/.dsh/plugins/dsh-echo/`,两个地方必须分清。**

| 路径 | 是什么 | 私密? |
|---|---|---|
| `~/.dsh/echo/echo.db`(+ `-wal` / `-shm`) | **SQLite 记忆库**(`node:sqlite`):情景记忆 / 图谱 / 悬置话题 / 关怀留痕 `care_beats` / 出站队列 `relay_outbox` / 入站幂等 | **是** —— 他和她的真实对话,最私密的一件 |
| `~/.dsh/echo/persona.json` | 人格(前段身份 + 尾段铁律与说话方式) | 是 |
| `~/.dsh/echo/config.json` | 设置(见四) | 一般 |
| `~/.dsh/echo/backup/` | 图谱合并 / 迁移前的 JSON 备份(`graph-merge.mjs` 写) | 是(含记忆内容) |
| `~/.dsh/echo/workspace/` | **陪伴会话的工作目录** —— 她干活(读写文件)的落脚点 | 看内容 |
| `~/.dsh/attachments/v1/` | **附件库**:他发来的图片字节(宿主 `attachments` 服务持有,`lib/eyes.js` 经 `ctx.get('attachments')` 存取) | 是 |
| `~/.dsh/sessions/` | 会话记录(宿主自己的) | 是 |

**`inbound.jsonl` 是「嘴」那边的**(`~/.dsh/echo-qq/inbound.jsonl`),不在本包数据目录里。

**备份怎么做(顺序重要)**

```powershell
# 1) 先停 dsh web —— SQLite 有 WAL,活着拷容易拷到半截
# 2) 用 sqlite 自己的一致性备份最稳(没装 sqlite3 就直接整组拷贝,见下)
Copy-Item "$env:USERPROFILE\.dsh\echo\echo.db*"   <备份目录>\ -Force   # db + -wal + -shm 一起拷
Copy-Item "$env:USERPROFILE\.dsh\echo\persona.json" <备份目录>\ -Force
Copy-Item "$env:USERPROFILE\.dsh\echo\config.json"  <备份目录>\ -Force
Copy-Item "$env:USERPROFILE\.dsh\echo\backup"       <备份目录>\backup -Recurse -Force
# 3) 图片另算(它不在 echo.db 里)
Copy-Item "$env:USERPROFILE\.dsh\attachments"       <备份目录>\attachments -Recurse -Force
```

> **`echo.db`、`echo.db-wal`、`echo.db-shm` 必须一起拷**。本机现场 `echo.db-wal` 有 4 MB
> —— 只拷 `echo.db` 会丢掉还没落盘的那部分(WAL 里的新记忆)。
>
> 只想导记忆本身:网页审查台的导出按钮(`lib/export.js` 的 `buildExportPack`,HTTP 出口在
> `lib/index.js`)—— **没有独立 CLI**(旧文写的 `scripts/export.mjs` 是死链,2026-10-02 查实不存在);
> 只读统计:`node scripts\echoq.mjs --since 7d`。

**回滚**:`~/.dsh/echo/backup/` 里的 JSON + 各 `*.bak-*` 文件就是回滚依据(改配置前会留一份)。

---

## 六、装完怎么验

按顺序,每条都有"该看到什么":

```powershell
# ① 两处登记都在、宿主解析得到,零错误
dsh --profile web --dump-config
#    期望:dsh-echo(以及 dsh-echo-qq)都出现;不出现 "cannot resolve profile bundle"

# ② 装机三件套自检
node scripts\install.mjs --check
#    期望:装机位(junction/复制)在、bundles 与 dependencies 都在、宿主包解析得到;退出码 0

# ③ 重启 dsh web,硬刷新浏览器,打开:
#    http://127.0.0.1:3080/echo/           审查台(左栏 11 段 + 三枚状态丸)
#    http://127.0.0.1:3080/api/echo/status 仪表盘 JSON(engine / care / version / build)
#    期望:version = 0.45.0;engine.state 不是 offline(offline 说明 Python 没探到)

# ④ 设置区
#    设置 → Echo 卡能出现:电源开关可拨、仪表盘有数、人格编辑器可保存、三套主题都看得清

# ⑤ 会话内
#    和她说一句话 → 她会用 Echo 的口吻回;让她 `echo_status` → 引擎状态有值
#    教她一件事(echo_remember)→ 换个会话问她(echo_memory)→ 她答得出 = 记忆链通
```

**版本对不上时**:`lib/build-stamp.js` 会把 `lib/*.js` 的内容哈希算成构建指纹(进
`echo_status` 与启动日志)。三份 version 可能一样,但 build 指纹不一样 ⇒ 说明你改完
`lib/` 没重启 `dsh web`。

---

## 七、测试与闸门

**每个包、每条,给确切命令与期望值**(2026-10-02 本次现场实测):

| 命令 | 期望 | 说明 |
|---|---|---|
| `npm test` | **1173 / 1173 通过**,退出码 0 | `node --test --test-force-exit "tests/*.test.js"`(104 个测试文件) |
| `npm run check` | **退出码 0** | 五闸:`smoke-lib.mjs`(真 import 全部 lib 模块)+ `check-syntax.mjs`(遍历 lib/ + scripts/ + web/app.js 语法)+ `check-bom.mjs`(**BOM 闸**)+ `check_tools.mjs`(8 个工具的契约,可 `DSH_TOOLS_PATH` 换 defineTool 版本压)+ `check-preset-patch.mjs`(**预设世代门**:两代的 `preset.patch.yml` 形态 + `dsh.bundle.patch` 形态) |
| `python -m unittest discover -s python\tests -p "test_*.py"` | **Ran 603 tests — OK**,退出码 0 | 28 个 Python 测试文件;`npm run test:py` 是它的别名 |
| `npm run probe` | 三个探针出结论 | 一致性探针(`python/tests/consistency_probe.py`),离线可判定,不碰你的数据 |

> ⚠️ **别给 Python 测试套管道去读退出码**。经 `2>&1 | Select-Object …` 这类管道时,
> Python 的 `ResourceWarning`(unclosed file 之类)会让外层误报 **exit 1**,而测试其实是全绿的。
> **裸跑、取 `$LASTEXITCODE`**:
> ```powershell
> python -m unittest discover -s python\tests -p "test_*.py"; $LASTEXITCODE   # ⇒ 0
> ```
>
> 另:`npm run check` 里的 `check-bom.mjs` 会扫 `.md` —— 新写的文档**必须 UTF-8 无 BOM**
> (见九-3)。

---

## 八、发布流程(打包由用户自己按这条做)

```powershell
cd $env:USERPROFILE\.dsh\plugins\dsh-echo

# 1) 改版本号:package.json 的 version 与 CHANGELOG.md 顶部条目**必须一致**(人工检查,无自动闸)
# 2) 更新 CHANGELOG.md:中文、说清"他现场说了什么 → 根因 → 怎么修的 → 门槛数字"
# 3) 清本机垃圾(打包前必做;prepack 也会自动跑一遍)
npm run clean:pyc
node scripts\clean-pyc.mjs --check     # 期望:"0 个 __pycache__ / *.pyc —— 干净"
# 4) 打包(prepack = clean-pyc 自动执行 ⇒ tarball 里不会混进 .pyc)
npm pack                                # ⇒ dsh-echo-<版本>.tgz
# 5) 交付前对一眼包内容(该有的都在、不该有的都没有)
tar -tzf dsh-echo-<版本>.tgz | Select-String "pyc|__pycache__|\.db$|\.scratch"   # ⇒ 应无输出
```

**为什么 `prepack` 非有不可**:`package.json` 的 `files` 是**白名单**,白名单里的目录
**整目录收**,`.npmignore` / `.gitignore` 一律无效 —— 2026-09-29 实测一次 `npm pack`
带进去 **22 个 `.pyc`**。清理器是 `scripts/clean-pyc.mjs`。

**`files` 白名单**(改包内容只看这里):`lib/`、`web/`、`python/worker.py`、`python/engine/`、
`cordis.patch.yml`、`preset.patch.yml`、`.preset-patch-generated.json`、`scripts/`、`docs/`、
`README.md`、`CHANGELOG.md`、`HANDOVER.md`。
(`docs/` 是 2026-09-29 补的:README 指向 `docs/ARCHITECTURE.md` 与 `docs/API.md`,不进包就是死链;
`python/` 只列 `worker.py` 与 `engine/`,整目录会把 `python/tests` 也打进 tgz;
`preset.patch.yml` + `.preset-patch-generated.json` 是 0.2.0 世代的预设声明与生成台账(2026-10-02 补齐);
`HANDOVER.md` 2026-10-02 加入 —— 交接文档要跟着包走。)

---

## 九、排障(今晚真踩过的坑,按"症状 → 根因 → 修法"排)

### 1. `dsh web` **整个起不来**,报 `cannot resolve profile bundle "dsh-echo"`
**根因**:profile 的 `dsh.profile.bundles` 里登记了它,但装机位(文件)不在 —— 只登记不装机
就是这么个死法。**修法**:`node scripts\install.mjs --check` 看缺哪件;`--doctor` 会指名。
**纪律**:任何装机动作后、重启前,先 `--check`。一个插件的安装方式不该有本事拦住宿主启动。

### 2. link 装机报 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-tools`
**根因**:Node ESM 会把 junction **还原成真实路径**,裸 import 的解析起点因此落在**源码区**
(`~/.dsh/plugins/`),那里够不着 `profiles/node_modules`。这正是 v0.1.0 当年把 `dsh web`
打崩、于是改成复制装机的那条雷。**修法**回到三-A 的第 ① 步:
插件源码区自己要有 `node_modules` junction → `profiles/node_modules`;`install.mjs --check/--doctor`
有专门一条验它,缺了会指名报错,不会假绿。

### 3. `SyntaxError: Unexpected token ''` / 配置读不动 —— **BOM**
**根因**:PowerShell(`Set-Content -Encoding UTF8`,尤其 PS 5.1)会写 UTF-8 **BOM**(头 3 字节
`EF BB BF`)。`require()` 会吞掉它,但 `readFileSync` + `JSON.parse` **不会**。
**修法**:文本文件一律 **UTF-8 无 BOM**;写完用
`[System.IO.File]::WriteAllText($p,$t,(New-Object System.Text.UTF8Encoding($false)))`。
闸门:`node scripts\check-bom.mjs`(在 `npm run check` 里)。

### 4. 记忆功能整个不工作 / `engine.state = offline`
**根因**:`node:sqlite` 是 **Node ≥ 22.5** 才有的内置模块(`lib/store.js` 的 `DatabaseSync`);
Python 侧车探不到合格解释器(≥3.9)也会降级。**修法**:`node -v` 先看版本;
`ECHO_PYTHON` 或 `config.json` 的 `pythonPath` 指名一个真 Python(Windows 应用商店那个假 python 会被探针淘汰)。
降级是**设计内的 fail-soft**:人格照常,只有记忆降级。

### 5. 改完 `lib/` 好像没生效
**根因**:插件代码变更**必须重启 `dsh web`**(只有 `cordis.patch.yml` 是 live 重载,`web/`
是每请求现读)。而且三份 version 可能一样,肉眼分不出来。
**修法**:比 `echo_status` 里的 **build 指纹**(`lib/build-stamp.js`,`lib/*.js` 内容哈希);
重启。另:`npm run check` 里的 `smoke-lib.mjs` 就是为这一类事故设的 —— 2026-09-28 夜一段注释
吞掉 `createHeartbeat` 的函数体导致 `ReferenceError: ticking is not defined`,而 `node --check`
**完全看不出来**(它只查语法),宿主一加载就 fatal。

### 6. 深色模式下设置卡"一片空白"、按钮没字
**根因**:两个用法错误。① 在**反相**填充色 `--dsw-alias-brand-primary`(浅色近黑、深色近白)
上写死白字 ⇒ 深色下白底白字整颗消失;② 变量名**根本不存在**
(`--dsw-alias-interactive-bg-hover-info` / `--dsw-alias-state-info-primary` 不在 DSH 主题表的
79 个 alias 里)⇒ 兜底浅蓝 hex 生效,前景跟着主题变浅 ⇒ 深色下一块白药丸。
**教训(值得刻在墙上)**:**用了带兜底 hex 的 CSS 变量时,"兜底能看"恰恰会掩盖"变量名写错"** ——
浅色正常不代表对。要按主题表逐个核对变量名,并**两套主题都验**。
正确的对手色是 `--dsw-alias-label-primary-foreground`,业务态用
`--dsw-alias-state-business-tertiary / -primary`。

### 7. 审计流"太丑、太拥挤、文字被挤成竖排"
**根因**:不是审美问题,是**布局被压塌** —— 中文最小内容宽度是 1 个字,弹性盒子把文字列压到
头,文字就竖着排。**修法**:主从两栏(master–detail):左栏=索引(固定行高、**永远单行**、
溢出省略号,结构上不可能折行),右栏=那一轮的全部。三条硬规矩写在 `web/style.css` 注释里:
承载文字的弹性列必须有 `min-width`;长文本 `overflow-wrap: break-word` + `word-break: normal`;
标签/徽章一律 `nowrap` + 省略号(**宁可截断,绝不竖排**)。加减一段 = 改 `web/app.js` 的 `PANELS`
一行(与 `index.html` 的同源契约由 `tests/web-dashboard.test.js` 钉着)。

### 8. 子代理无限自我增殖、把 dsh 卡崩(2026-09-29 事故)
**根因**:情绪单轮闭环的**打分器每跑一次就起一个子代理**,而插件的 `ctx.on` 挂在**根上下文**
⇒ 子代理会话的 claim 一样收得到 ⇒ A 起 B、B 起 C……**修法**:结构性闸 ——
`lib/agent-scope.js` 的 `isSubagentSession()`,子代理一律不算(与「两只手全局注册」那条
P1 修复**复用同一份判据**)。**教训**:这类递归不能靠"变慢",要在类型上让它不可能发生。

### 9. 她一条都不说话 / 「另一个 Echo」在答他
**根因**有一族,历史上真见过:旧桥坏掉那 85 分钟里是另一套在答;开关是"假的"(面板拨了不生效);
群聊串进私聊。**修法**:先看 `/api/echo/status` 的 `care`(她"为什么没开口"的原因分布当场可查)
与 `npm run care:report`(`node scripts\echoq.mjs --since 24h`,只读),再翻
`docs/HAZARD_AUDIT_2026-09-26.md` / `docs/CODE_AUDIT_2026-09-26.md`。

---

## 十、目录速查

```
~/.dsh/plugins/dsh-echo/           源码区(= link 装机位)
├─ lib/          壳:人格/记忆门面/工具/面板/网页路由(平铺 .js)
├─ python/       worker.py + engine/(30 个模块)+ tests/(28 个测试文件)
├─ web/          审查台静态页(index.html / app.js / style.css / audit-view.js)
├─ scripts/      装机器、体检、导入导出、bench、清理器
├─ tests/        JS 测试(104 个文件)
├─ docs/         文档活索引 docs/README.md(ARCHITECTURE / API 是进包的两份)
├─ package.json  files 白名单 + engines>=22.5 + prepack
├─ .gitattributes 全仓 LF-only;  .gitignore 拦 .scratch/ 与 *.log/*.pyc
└─ HANDOVER.md   本文
```

---

## 附:打包交接检查单(2026-10-02 全仓审查后)

### A. 已就绪(今天逐条核过,有数)

| 项 | 状态 | 依据 |
|---|---|---|
| 版本账本 | ✅ | 两仓 `package.json` ↔ CHANGELOG 顶 ↔ HANDOVER/README 全对齐(0.45.0 / 0.1.6);漂移 4 处已修 |
| 测试与闸门 | ✅ | JS **1173/0**、python **603 OK**、`npm run check` 五闸 0、qq 全套绿(均为 2026-10-02 现场) |
| 包内容 | ✅ | `npm pack --dry-run`:主包 222 文件 / 4.9MB,qq 21 文件 / 216KB;`HANDOVER.md` 已进两包;`archive/`、`python/tests`、`tests/` 不进包(设计如此);0 个 `.pyc`/`.db`/`.scratch` |
| 可移植性 | ✅ | 代码里写死家目录的 4 处已改 `homedir()` 推导(行为在他机器上逐位等价);文档示例路径 ~15 处**不动**(示例而已) |
| 机密 | ✅ | 零真密钥/零真 API key;凭据按引用名读不打印(`judge-llm.py` / `retrieval-present.py`) |
| 红线 | ✅ | `lib/relay.js` / `persona.json` 注入点 / `cordis.patch.yml` 全程未动,不在 git 改动面里 |

### B. 交接前必办(要他本人拍板,我不代做)

1. **⚠️ 隐私(已处置)**:原 `docs/astrbot-audit-2026-09-25T13-07-13-030Z.md` 里有
   **~200 行真实聊天记录**(学校、面试、身体状况、私房话)——已挪到 `archive/docs/`,而 `archive/`
   不进发布包。注意 git 历史里仍有,真要外发得连历史一起想。
2. **真实 QQ 号 `<your-qq>`(约 60 处:tests/、archive/、qq 的 test 与 docs、两仓 CHANGELOG)
   与群号 `<your-group>`**:外发前批量换占位符(自己的身份,自己定口径)。
3. `dsh-echo-qq/test/onebot-bind.test.mjs:105` 的 `'Bearer <test-token>'` 形似真口令(仅本地测试用),
   建议换占位符。
4. **LICENSE**:qq 有、主包**没有** —— 选哪个许可证是法律决定,定下来后给主包补一份。
5. **git 提交**:记忆架构 v2 + 0.2.0 适配整批还没进版本库(23 改 + 80+ 新)——交接前要 commit
   (按规矩我不代提交;`dsh-echo-0.43.3.tgz` / `dsh-echo-qq-0.1.5.tgz` 两个过期构建残渣已清)。

### C. 已知文档债(不阻塞,接手后慢慢还)

- 8 份历史设计文档指向已搬 `archive/docs/` 的旧路径(RELAY_PLAN 等);`docs/QQ_BRIDGE_DIY_PLAN.md`
  里 `lib/bridge.js` 等是**计划稿**未落地。
- 红线两套口径并存(`MIGRATION_DISCIPLINE.md` 用「压缩域/人格注入点/relay.js」,新文档用三红线)。
- CHANGELOG 的「(未发布)」标记口径:版本已 bump、条目仍挂未发布 —— 发布时摘掉。
- `web/app.js` 一句「调参先放着」的 UI 文案、`docs/PLAN_MEMORY_GRAPH.md` 两条既有待办(D5 / Tier2)。
