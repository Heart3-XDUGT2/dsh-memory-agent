# QQ 桥 DIY 换装计划(借现成 OneBot 层 + 拆成独立插件)

> 裁决(2026-09-27,他的原话):「**在保留原本功能的基础上使用外部的现成代码,然后进行一个
> DIY 改变部分的代码结构来适应我们现在的架构**」。
> 三条追认(同日):① 新插件**自带一页**(不塞进主包设置页);② 旧桥代码**封存到 `archive/`**
> (不删 —— 答辩时要能说"换的是传输,不是丢了功能");③ 把**整个插件搬到正常的 DSH 插件目录**
> 里,方便管理(见 **§S-1 搬家**)。
> 参考物:`$env:USERPROFILE\Desktop\qq桥接参考\dsh-qq-onebot-bridge-main`(第三方 DSH 插件
> v0.5.7,128 个文件;**只读参考,一个字节都不写它**)。

## 0. 一句话结论

**功能全留、AstrBot 全退、QQ 那一层换成"抄来的 OneBot 客户端 + 我们自己写的薄壳"。**

换掉的是**传输**:今天 `AstrBot(Python 薄壳) → POST /api/echo/relay/* → 她回复 → 2 秒轮询
outbox → 发回 QQ`(`astrbot_adapter/main.py:412-431`、`relay_core.py:48`)。
留下的是**语义**:信封→她的一轮(`lib/relay.js:325-468`)、出站分泡与节奏(`lib/bubble.js`)、
打断残句(`lib/interrupted.js`)、关怀保鲜期(`relay.js:22`)、她的两只手(`lib/relay-tools.js`)、
主动开口的三条路(`lib/heartbeat.js:171-187`、`lib/say-again.js:127-186`)、审计证据链。

**不采用"整包换"的三个理由**(逐条有据):
1. 它**每条 QQ 聊天各建一个 DSH 会话**(`lib/bridge.js:2958` `ctx.agents.create` / `:2974` `resume`)
   —— 与我们的 D1 裁决「全平台全场合共用同一个她」(`docs/RELAY_PLAN.md:131`、
   `lib/toggle.js:393` 的 `session-echo-companion`)直接冲突;
2. 它**在每条 `assistant/message` 就发一次 QQ**(`bridge.js:4609`,作者自述多步回合会发多条 `:5623`)
   —— 与我们的"整回合切泡、按泡的到期时刻发、能被打断"冲突;
3. 它带 217 个配置键的业务层(命令/群运营/运势/积分/生图/TTS)+ 一个独立控制台进程
   (`control/lib/server.mjs:80`)—— 我们只要它**一层**:OneBot 收发的那个文件。

---

## 1. 目标形态(脑 / 嘴 两个插件,同一个她)

| | `dsh-echo`(脑,本仓库) | `dsh-echo-qq`(嘴,新包) |
|---|---|---|
| 拥有 | 人格·记忆·情绪·审计·面板·python 侧车;信封语义;分泡与节奏;打断;关怀保鲜期;她的两只手;图片落附件(`lib/eyes.js`);**渠道注册表与出站队列** | OneBot **反向 WS** 连接与鉴权;私聊收发;消息段解析;引用解析;图片下载(可选);心跳探活;信封构造;送达/重试/去重 |
| 不认识 | NapCat / OneBot / QQ 协议细节 | 记忆、人格、情绪,"她该不该说话"、分泡节奏 |
| 依赖 | 只依赖宿主服务(`ctx.get('tools'\|'systemPrompt'\|'webServer'\|'agents'\|'attachments'…）`,见 `lib/index.js:715-726`) | `echo` 服务 + `ws`(唯一真依赖,照参考实现 `package.json:49-51`) |

### 四条不许破的不变式(每条都要有验收测试)

1. **一脑一嘴**:QQ 与 DSH 窗口共用 `session-echo-companion`、同一份记忆、同一个人格实例。
2. **她决定才说**:DSH 窗口里的回复**不许**自动泼到 QQ(`lib/index.js:1535` 的 `held` 语义)。
3. **私聊 + 单主人**:群聊一律拒收(`lib/relay.js:23-25`,v0.29.0 的裁决)。
4. **分泡/打断/保鲜期原样**:话一个字不改,只换它走的路(`relay.js:26-27`)。

---

## 2. 核心侧改动:把"嘴"从桥对象里抽出来(渠道无关)

### 2.1 新增 `lib/speak.js`

```js
// 与渠道无关的"她的嘴":渠道注册表 + 出站队列 + 送达回执
export function createSpeaker ({ logger }) {
  const channels = new Map()
  return {
    registerChannel (ch) { channels.set(ch.name, ch) },   // ch: {name, send({chatId,text,kind}), status(), targets(), close()}
    hasChannel () { return channels.size > 0 },
    list () { return [...channels.values()].map((c) => ({ name: c.name, ...c.status() })) },
    captureSegment (sid, text) {},        // 原 relay.captureSegment(relay.js:474-505)
    finishTurn (sid, { kind, proactive }) {},  // 原 relay.finishTurn(relay.js:506-666):分泡→入队→渠道扇出
    say ({ sessionId, text, mode, chat }) {},   // 原 relay.say(relay.js:683-770):她的手
    onDelivered (fn) {},                  // 原 onAcked(relay.js:786-793)
    targets (sessionId) {},               // 原"渠道表"(relay.js:558-563/692-697)
    status () {}
  }
}
```

**核心从此只认 `{kind:'reply'|'proactive'|'reminder'}` 与 `sessionId`**,不再认
`platform` / `chatId` / `'global'` / 渠道表。

### 2.2 六处硬缝与修法(耦合面诊断的产出,逐条给依据)

| # | 硬缝(今天) | 修法 |
|---|---|---|
| 1 | 出站被写死在桥对象上:`index.js:1490` `relay.captureSegment`、`index.js:1525-1531` `relay.finishTurn` | 改成 `speaker.captureSegment/finishTurn`;`relay.js` 降级为"HTTP 兼容传输"(见 S1) |
| 2 | `form` 字面量渗进核心判据:`relay.js:265`、`index.js:1360-1376`(`msg.source.form !== 'relay'`)、`turn-query.js:43`(`HUMAN_FORMS={'relay','care'}`) | 归一成渠道无关枚举 `form ∈ {'inbound','care','reminder','say_again'}`;**旧值 `'relay'` 保留为别名**(审查台与历史数据依赖,`web/app.js:641-697`) |
| 3 | 「送出去了」由桥的 ack 定义:`relay.js:786-793` → `index.js:963-965` → `heartbeat.js:219-236`(想念×0.5 只认 `row.kind==='proactive'`,`store.js:271`) | `speaker.onDelivered(({kind, sessionId, channel}) =>…)`,判据从"桥的表"改成"渠道无关的出站行";**表名与列名不动**(迁移脚本 `rehearse-migration.mjs:34`、审计证据链依赖) |
| 4 | 手与自我认识:`index.js:2790-2799`(工具只在 `relayEnabled()` 时注册)、`index.js:1090-1127`(她"知道自己有手"的提示词段) | 门槛从 `relayEnabled()` 改成 `speaker.hasChannel()`;**工具名 `echo_qq_say`/`echo_qq_call` 不改**(人格指纹与历史审计依赖,`docs/VOICE_BASELINE_2026-09-26.md`) |
| 5 | `'global'` 是桥的形状:`store.js:22`、`proactive-ack.js:75-88`、`cleanup-guard.js:122/169`、`web/app.js:641-697` | **字面量保留**(兼容历史与审查台),语义改成"没有渠道可归属时的归属地",在 `speak.js` 里收敛成一个常量 |
| 6 | 核心出站作用域依赖桥的渠道表:`relay.js:558-563`、`:692-697`、`index.js:1098-1104` | `speaker.targets(sid)` / `speaker.list()` |

### 2.3 留在核心、不动的

`store.js` 的 relay 三表与 11 个方法(`245-298/317-326/1450-1796`)、`lib/bubble.js`、
`lib/relay-tools.js`、`lib/eyes.js`、`lib/interrupted.js`、`lib/inbound-filter.js`、
`lib/webpage.js`、`settings-fields.js:65-79` 的 relay 键组(只增不改)。

---

## 3. 新插件:`dsh-echo-qq`

### 3.1 借来的代码(逐文件,附 DIY 改动)

| 借自 | 为什么要 | DIY 改什么 |
|---|---|---|
| `lib/onebot.js`(**必抄**,自包含) | 反向 WS 服务端(`:188-203`)、Bearer 鉴权(`:216-220`)、消息段解析 `text/at/reply/image/record/file/forward`(`:25-87`)、`echo` 关联 + 10s 超时(`:646-656`)、60+ action 封装 | **删**:群相关的全部分支(`:247` `message_type==='group'`、`:252-254` 的 @ 判定)、60+ action 只留 6 个:`send_private_msg`、`get_msg`(引用解析)、`get_status`(探活)、`get_image`/`download_file`(图片,可选)、`set_input_status`(可选"正在输入")、`delete_msg`(撤回,可选) |
| `lib/send.js` | 出站路径白名单 + 体积校验(纯函数,`:12-15/45-50`) | 只借**发送前的校验**;**分段不用它**(我们的 `bubble.js` 有自己的节奏,`send.js` 的长文转卡片不要) |
| `lib/actions.js` | 写操作令牌桶 + 日上限 + 审计(`:12-37`) | 默认**不带**(我们私聊单主人,量级不同);若 P3 发现需要再加 |
| **只读不搬** | `bridge.js:4520-4617`(事件驱动、零轮询的发送形状)、`bridge.js:2890-3032`(会话建立/续接/prompt 注入) | 读它的**形状**,但我们的发送路径走自己的 outbox→speaker→channel(理由见 §0 第 2 条) |

### 3.2 我们必须自己补的三个窟窿(参考实现的短板,逐条有据)

1. **心跳与探活**:它没有(它是 server,NapCat 连它)。反向 WS 下我们**无法主动重连**,能做的是:
   每 30s `get_status` 探活 → 连续失败判"断线" → **告警到面板** + 可选拉起 NapCat
   (形如它的 `autoHealEnabled`,`lib/index.js:101-104`,只拉起、不杀进程)。
2. **断线不许销毁会话**:它在断连时销毁在跑的会话(`bridge.js:4619-4628`)—— 对我们等于
   "她当场失忆";我们的渠道插件断线只标记 offline,核心侧会话与上下文**一点不动**。
3. **工具收窄**(安全,必须在 S2 做):它接进来的 agent 只传 provider/model、从不收窄工具
   (`bridge.js:4206-4211`、`:2999-3032` 只加不减)⇒ 谁在白名单里,谁就能驱动一个**完整 DSH
   agent**(写文件、跑命令)。我们的 QQ 渠道会话必须显式收窄到"只能说话 + 看图"。

### 3.3 插件骨架(照参考实现的形状)

```
dsh-echo-qq/
  package.json      # dsh.bundle.patch → ./cordis.patch.yml；只声明 ws，其余 peer（参考 package.json:44-61）
  cordis.patch.yml  # 往 profile 插一个实例（参考 cordis.patch.yml:1-4 + examples/cordis.patch.example.yml:7-16）
  lib/index.js      # export const name / inject / Config / apply（参考 lib/index.js:17-18,278-292）
  lib/onebot.js     # 抄来 + DIY（§3.1）
  lib/chat.js       # 信封构造（QQ 私聊 → 我们的信封）、送达/重试/去重、chat 映射
  lib/client.js     # 前端半侧：**自带一页**（照本仓库 package.json:29-36 的 dsh.client + lib/client.js）
  web/              # 那一页的静态资源（伺服方式照 lib/webpage.js：按请求读、no-store）
  test/*.mjs        # 单测（照参考 test/onebot-api-unit.mjs 的形状）
```

**"自带一页"的落点**:新插件走 `dsh.client`(平台 `web`)注册自己的前端半侧,并自己伺服一个页面
(建议 `/echo-qq/`,与 `/echo/` 并列):连接状态 · 心跳 · 最近收发 · 重连记录 · 工具收窄命中记录。
主包面板里那一栏同时撤掉(同一件事不在两处显示)。

**as-built 对照(2026-09-27 S2-a 落地后,以代码为准 —— 计划与实际的每一处偏差都列出来)**:

| 计划里写的 | 实际建成的 | 说明 |
|---|---|---|
| `lib/index.js` 导出 `name / inject / Config / apply` | `name` / `inject` / `apply`,**不导出 `Config`** | 配置住数据目录 `~/.dsh/echo-qq/config.json`,由 `lib/config.js` 自己读(与主包同款;主包也刻意不导出 Config) |
| `lib/chat.js` 一个文件 | 拆成 `lib/envelope.js`(QQ 事件 → 信封)+ `lib/contract.js`(**接缝消费端**) | 接缝是这一版的重心,单独成文件;`contract.js` 顶部写死了 S1 要照它实现的服务契约 |
| `lib/client.js`(`dsh.client` 前端半侧) | **没做**;只有 `web/` + `webServer` 前缀路由 `/echo-qq/` | 页面实有:总闸与连接 / 接缝模式 / 收发计数 / 最后收发 / 配置问题。「重连记录」「工具收窄命中」**未做**(后者要等 S2-b 的工具收窄接上才有意义) |
| `lib/onebot.js` 27.8 KB / 593 行 | **29.9 KB / 725 行** | 593 是上游原文件;725 是 DIY 后(心跳状态机、入站信封校验、`sha256` 恒定时间鉴权、id 归一) |
| `test/*.mjs` 照参考 `test/onebot-api-unit.mjs` 形状 | 5 个文件 **29 项** | 参考只测 action 表;我们加了**真开 WebSocketServer、真连 ws 的收发回归**(见 §S2-a) |
| 只声明 `ws`,其余 peer | 同 | `ws: ^8.18.0`;宿主包不声明(走 `ctx.get`),参考实现同样把宿主包放 `peerDependencies` |
| 全仓 LF-only | 同,且加了 `.gitattributes`(`* text=auto eol=lf`) | 主仓靠本机 `core.autocrlf=true` 顶着;新仓**不依赖本机配置** |

**借用许可(必须随代码一起带走,答辩要能说清出处)**:参考实现是 **MIT**
(`LICENSE` 首行 `MIT License`,版权行 `Copyright (c) 2026 dsh-qq-onebot-bridge contributors`)。
所以抄 `lib/onebot.js` 时:① 新插件里放 `THIRD_PARTY.md`/或文件头注明来源与 MIT 全文;
② 保留原版权行;③ 在 `CHANGELOG.md` 写明"本文件来自 dsh-qq-onebot-bridge v0.5.7
(github.com/cheesehaqi/dsh-qq-onebot-bridge),MIT,已按 §3.1 改动 X 处"。**不是"参考思路"而是整块代码,
出处必须写在代码旁边**。体量实测:`lib/onebot.js` 27.8 KB / 593 行,只 import `node:events` 与 `ws`
(自足、可整块借用)。

---

## 4. 分五步走(每步都能停、都能回退;门槛都是"答辩级绿色")

### S-1 · 搬家(半天,先做;与代码改动无关)

**为什么**:他要"把整个插件移到一个正常的 DSH 插件目录里,好管理"。先探到的事实(2026-09-27):
- `~/.dsh/<名字>/`(`afaccess`/`dsh-pet`/`dsh-pocket`/`dsh-safe`/`echo`)**全是数据目录**
  (log / memory.json / token / echo.db),**没有一个是插件源码** ⇒ 这台机器上还没有
  "插件源码目录"这个约定,得由我们定义;
- 今天 `~/.dsh/profiles/web/package.json` 把 `dsh-echo` 记成
  `file:./.dsh-echo-local/dsh-echo-0.30.1.tgz`,装机位 `node_modules/dsh-echo` 是**真目录(复制品)**,
  不是链接;
- `dsh plugin --profile web --help` 实际转发给 **pnpm** ⇒ 本地目录可以走 pnpm 的 `link:`
  (参考实现 README 的「安装/卸载」一节就是这么装的:先 `npm install --omit=dev`,再 add)。

**目标布局**:
```
~/.dsh/plugins/           # 新目录 = 插件源码区（与数据区 ~/.dsh/<名字>/ 分开）
  dsh-echo/               # 从 $env:USERPROFILE\source\repos\dsh-echo 整体搬来（git 一起搬）
  dsh-echo-qq/            # S2 新建
```

**装机方式:link 还是继续 copy**

| | **link(推荐)** | copy(今天的样子) |
|---|---|---|
| 改动生效 | 源目录即装机位:`web/` 刷新就见效;`lib/` 仍需重启 `dsh web` | 每次都要跑 `install.mjs` 复制 |
| 一致性校验 | 退化成"是否链接到本仓库" | 保留"装机副本 vs 仓库逐字节"(`install.mjs:88-131`) |
| 被 `pnpm install` 冲掉 | 不会(link 依赖写在 `package.json` 里) | 会(当年就是因此才加 tarball,`CHANGELOG.md:1144-1155`) |
| 侧车 `.pyc`/`__pycache__` | 会落进**仓库**(`install.mjs:308-309` 正是在治这个) | 落在装机副本,不脏仓库 |
| 回退 | 摘 link 登记 + 恢复 `package.json` | 恢复 tarball 依赖 |

**步骤(每步可回退)**:
**执行记录(2026-09-27,已完成)**:备份落在 `~/.dsh/backup-relocate-20260927-223318/`
(`package.json` / `pnpm-lock.yaml` / `cordis.yml` / `.dsh-echo-local/`)→ 仓库 `Move-Item` 到
`~/.dsh/plugins/dsh-echo`(git 完整、工作树干净)→ `dsh plugin --profile web add` 装成
**link**(依赖登记 = `link:$env:USERPROFILE/.dsh/plugins/dsh-echo`,装机位 = **Junction**)→
全量绿:node **651/651**、python OK、`npm run check` exit 0、hygiene exit 0、
`install.mjs --check/--doctor` 六项一致 exit 0。

**搬家中查出的真雷(已堵)**:Node 会把 junction **还原成真实路径**,裸 import 的解析起点因此
落在源码区;`~/.dsh/plugins/` 不在 profile 树里 ⇒ `@deepseek-ai/dsh-tools`
**ERR_MODULE_NOT_FOUND**(v0.1.0 的 junction 装法就是这么崩的,所以当年才改成复制装机)。
堵法:`New-Item -ItemType Junction -Path ~/.dsh/plugins/node_modules -Target
~/.dsh/profiles/node_modules` —— afaccess 那种"往上走一层"命中的正是这份宿主依赖树。
已写进 `scripts/install.mjs`:① `verify()` 专验这条(缺了 ⇒ exit 1 + 指名修法,不再假绿);
② 默认运行在 link 形态下**退化成只校验**(否则一次习惯性的 `install.mjs` 会把链接摘掉、
再复制一份进去 = 悄悄回退搬家)。反证验过:junction 挪走 → exit 1;挪回 → exit 0。

**回退**:恢复备份里的两个文件 + `pnpm install`;或 `--remove` 后按老路(复制装机)重装。

**待他做的一步**:重启 `dsh web`(插件代码变更本来就要重启)。面板不用等:装机位那条路径
现在通过 junction 直接指向仓库,`web/` 是按请求读的。

**S0 顺手调整**:试装参考实现改成走**第二个 profile**(`dsh plugin --profile qqtest …`),
不再隔离整个 `DSH_HOME` —— 那个 profile 里**不加载 Echo**(她的库一个字节都不会被碰)。
唯一注意:NapCat 的反向 WS 端口一次只能指一处,试装时 AstrBot 与新桥别同时接。

### S0 · 探针(1~2 小时,零风险)
- **探针 A**:插件**间**服务(`ctx.provide`/`inject`)在本版本 DSH 里可不可用。注意:插件级
  `export const inject` 我们自己**已经在用**(2026-09-27 link 装机探针实测:入口导出
  `apply,inject,memoryToolDefinitions,name,statusPayload,statusToolDefinition`),所以这里要验的
  只是**新的**服务名(`echo:relay` 之类)能不能被另一个插件 `inject` 到。参考实现 `lib/index.js:18`
  在用 `inject`;`Context.provide` 见 `cordis/lib/types/reflect.d.ts:43/144`。
  **结论决定 S1 走服务注入还是 HTTP 长轮询兜底。**
  > **✅ 结论(2026-09-27 已探,结论:可用,S1 走服务注入)**:这不是赌注 —— **第一方插件自己在用**:
  > - 提供侧(服务端第一方):`dsh-app-boot/lib/index.js:1530` `ctx.provide("dshHomePath", dshHomePath)`;
  > - 注入侧(插件级 `inject`):`dsh-api-gateway/lib/types/client/index.js:16`
  >   `export const inject = ['typert','connection']`,而 `connection` 由
  >   `dsh-client-connection/lib/client.js:6417` 提供;
  > - **最贴近我们的先例**(一个插件开注册表、另一个往里注册):
  >   `dsh-client-ui-sidebar-right/lib/client.js:3667` `ctx.reflect.provide("sidebarRightTabs", tabs)`
  >   ← `dsh-client-ui-sidebar-files/lib/client.js:684/694` 声明该名并 `ctx.sidebarRightTabs.register(...)`。
  >
  > 另:`ctx.get(name)` 在**没提供**时返回 `undefined`(`cordis/lib/types/reflect.d.ts:7/115`
  > 原话 "Read a service from the store without the inject requirement"),所以能力探测可以写得很干净
  > (主包在 ⇒ 走注入;主包不在 ⇒ 退回 HTTP 长轮询,插件不崩)。
  > 附带查到的事实:`reflect.d.ts:18-21` 写明 **只有提供该服务的那个 fiber 能改它的值**
  > ("Only the fiber that provided the service may set it; setting an unprovided name throws") ——
  > 这条对我们的所有权设计有用:渠道服务由主包提供,新插件只能读。
- **探针 B**:在**第二个 profile**(`--profile qqtest`,里面**不加载 Echo**)只装参考实现,
  真机跑通"他发 → 她答 → 回 QQ"(不接我们的任何东西;NapCat 的反向 WS 端口别与 AstrBot 撞)。
- 产出:两份结论 + 一张真机证据(日志/截图)。
- 兜底:若服务注入不可用,S1 改为 `GET /outbox?wait=20` **长轮询**(核心把请求挂到气泡到期),
  延迟同样归零,架构不动。

### S1 · 核心抽象(1~2 天,行为零变化)
- 新增 `lib/speak.js`;`lib/index.js` 六处缝改造(§2.2);`relay.js` 降级为"HTTP 兼容传输"
  (继续走今天的 5 个端点,**默认不动**)。
- **门槛**:`node --test tests/*.test.js`(651)+ python(305)+ `npm run check` + `hygiene` 全绿;
  真机 QQ 一轮对话行为与今天**完全一致**(分泡条数、节奏、审计行都照旧)。
- 可回退:纯新增 + 转发,`speaker` 后面可以什么都不接(= 今天)。
- **进度(2026-09-27 深夜)**:`S1-a` ✅ —— 新增 `lib/speak.js`(渠道无关的嘴:渠道注册表 +
  出站转发 + 送到回执 `onDelivered` + 只读渠道视图 `targets/allTargets` + `hasChannel()`),
  与 `tests/speak.test.js` 7 项电池。最重要那条用例是「**纯转发**:参数原样进、返回值原样出
  (同一个对象,不复制)、异常照旧往上抛」—— 因为这一步的验收标准只有"行为逐字不变"。
  **核心尚未换调用点** ⇒ 纯新增、零行为变化、随时可退。
  全量 **658/658**(原 651 + 新 7)、`npm run check` 0、`hygiene` 0;`lib/speak.js` 已补进
  `package.json:40` 的逐文件 `node --check` 清单(`install.mjs` 是整目录拷 `lib/`,不用改)。
  两条**有意留白**写进了 `speak.js` 顶部:① `hasChannel()` 今天的定义必须与旧门 `relayEnabled()`
  等价(走 `transport.status().enabled`),否则「总闸关 / 没有渠道行」两种情形下工具注册与提示词段
  会换行为 —— 那是 S3 切换才动的判据,要配专门验收;② `'global'` 字面量收敛成 `NO_CHANNEL_SCOPE`,
  表名列名一个字不动。
- **进度(2026-09-27 深夜)**:`S1-a` ✅ + `S1-b` ✅ —— **六处硬缝全部换到 `speaker`**(§2.2):
  ① 出站 `index.js:1516/1552` → `speaker.captureSegment/finishTurn`;
  ③ 送到回执 `onAcked` → `speaker.noteDelivered` → 注册钩子(今天只有一个:心跳;
  **已核实** `noteProactiveAcked([])` 无副作用 ⇒ "空行不触发钩子"与旧行为逐字相同);
  ④ 门 `relayEnabled()` → `speaker.hasChannel()`,**可证等价**(`relay.js:314-315` 的 `gate()`
  就是 `isEnabled()`,即 `index.js:944` 传进去的 `relayEnabled`),她那只手也从对"桥"说话
  改成对"嘴"说话(`relay-tools.js` 只用 `say()`,形状一致);
  ⑥ 渠道表 → `speaker.targets(sid)/allTargets()`(只读视图由 `index.js` 注入 store 查询,
  `speak.js` 不认识 store);
  ② `form` 归一:`speak.js` 新增 `FORM/formOf/isHumanForm`,`index.js:1388` 与 `turn-query.js`
  的 `HUMAN_FORMS={'relay','care'}` 改问 `isHumanForm()` —— **旧值 `'relay'` 保留为别名**,
  **写入侧仍写 `'relay'`**(S3 才切,要配验收)⇒ 今天行为不变;
  ⑤ `'global'` 收敛成 `NO_CHANNEL_SCOPE`,**表名/列名一个字不动**。
  门槛全绿:`node --test` **659/659**(原 651 + 新 8)、python **305 OK**、`npm run check` 0、
  `hygiene` 0、`install.mjs --check` 0。**没动** `store.js`/`bubble.js`/`relay-tools.js`/
  `settings-fields.js`(§2.3「留在核心、不动」那批)。
- **明确不在 S1 里的两件(别记错)**:① 入站侧 `handleInbound` 仍住在 `relay`(它就是 HTTP 传输的
  入口,归传输所有);② 主包侧 `ctx.provide('echo:relay', …)` **属 S3** —— 它要求"渠道扇出 +
  传输切换 + 一条配置回退",不是 S1 的"只解耦、行为零变化"。(新插件 README 里那行一度写成 S1,
  已订正。)
- 下一步:**S3 的第一半** —— `speaker` 接渠道扇出(新插件注册成 `{name:'qq'}`)+ 主包
  `ctx.provide('echo:relay', …)` + `settings.relay.transport = 'http' | 'plugin'` 回退开关;
  或先做 **S2-b**(装机 + 真机一轮),两者都能停能退,先后由你定。

### S2 · 新插件(2~3 天)
- `dsh-echo-qq` 骨架 + 抄改 `lib/onebot.js` + `lib/chat.js` + 注册 `{name:'qq'}` 渠道。
- 装机与仓库校验同步(耦合面诊断的清单):
  - `package.json:40` `npm run check` 的逐文件清单(主包删桥行、新包自带);
  - `scripts/install.mjs` 复制清单(`:311-316`)、相对 import 自检(`:325-343`)、
    **verify 要求新插件同时进 profile 的 `dsh.profile.bundles` 与 `dependencies`**(`:102-113`);
  - `scripts/hygiene.mjs` 的跨包扫描(`:60-80`)需要认识第二个包。
- **门槛**:隔离 profile 里真机一轮(纯文本 + 带图),并出一张**分段耗时表**(§5)。
- 可回退:`settings.relay.transport = 'http' | 'plugin'`,一条配置切回去。

#### S2-a · 骨架(✅ 已完成 2026-09-27;新仓 `dsh-echo-qq` 首次提交 `abd24e0`)

- **仓库**:`$env:USERPROFILE\.dsh\plugins\dsh-echo-qq` —— **独立 git 仓**(无 remote,永不推送),
  20 个被跟踪文件:`lib/{index,contract,envelope,config,webpage,onebot}.js`、`web/{index.html,app.js}`、
  `test/*.test.mjs` ×5、`README.md`、`CHANGELOG.md`、`THIRD_PARTY.md`、`.gitattributes`、
  `package.json`、`cordis.patch.yml`。
- **已做**:① `lib/onebot.js` 借 `dsh-qq-onebot-bridge` v0.5.7 并 DIY(删群聊、action 收窄到 6 个、
  心跳只标 `stale` 不销毁状态、断线只回 `listening`、恒定时间鉴权、id 一律字符串);
  ② `lib/contract.js` 接缝消费端(**服务注入优先 / HTTP 轮询兜底**,运行时探测);
  ③ 信封、配置(三条纪律)、自带一页。
- **验收**:29/29 单测(`node --test`,含真开 WebSocketServer、真连 ws 的收发回归)、`node --check` 全绿、
  全仓 LF-only 无 BOM。**没动主包一个字节**,运行中的 `dsh web` 零影响。
- **真机级单测当场抓到两处不一致(已修,可复现)**:
  1. **id 类型**:`onEvent.userId` 曾给数字 `3783`,与全仓字符串 id 不一致(会一路影响主包的幂等与白名单比对)
     ⇒ 改 `String(...).trim()`;出网给 NapCat 的 `user_id` 仍转数字(协议如此),回执 `messageId` 也字符串化。
  2. **心跳形同虚设**:`heartbeatMs=40, maxMisses=2`、连接在而客户端不应答 `get_status` 时,**1.5 s 后仍
     `stale=false`** —— 因为探测要等 `ACTION_TIMEOUT_MS` 才回。改法:`call(action, params, { timeoutMs })`
     + 心跳用 `max(300, min(heartbeatMs, 2000))`,于是**「多久算不活」由配置决定**,而不是由 action 超时决定
     (实测 684 ms 变 `stale`;恢复应答后归位,连接与计数一个不丢)。
- **另两处收口**:`lib/index.js` 曾**漏传** `heartbeatMs/maxMisses`(配置到不了客户端,真机永远用默认 30000/3);
  鉴权比较改 `sha256 + timingSafeEqual`(长度不等提前返回会泄漏 token 长度上界)。
- **零依赖/零联网**:`ws` 这台机器已有(`~/.dsh/profiles/node_modules/ws`;插件区 `node_modules` junction 可见)
  ⇒ **S2-b 不需要联网装包**,也不需要在插件目录 `npm install`。临时给小工加的那条本地 junction 已按
  「只删链接不跟进目标」的方式撤掉,全局检出未受影响。
- **顺序偏差(有意)**:先做了 S2 的前半(**骨架**)而不是 S1(**主包核心抽象**)。理由:骨架在**独立仓**、
  零风险,而且它把**接缝契约**钉死了(§S1 的 `speak.js` 照 `contract.js` 顶部的服务契约实现即可)——
  反过来给 S1 定了对外面。**S1 仍未开工,主包行为零变化。**
- **未做(S2-b 清单)**:装机(隔离 profile + `install.mjs` verify 认第二个包 + `hygiene` 跨包扫描)、
  真机一轮(纯文本 + 带图)、**工具收窄的实际拒绝日志**(§3.2 第 3 条,必须在 S2 做)、分段耗时表(§5)、
  前端卡片(`dsh.client` 半侧)。
- **阶段名订正**:本次一度把骨架写成「S1」,与 §4 的编号冲突(那是主包核心抽象);已在新插件的
  README / CHANGELOG / 页面 footer / 代码注释里统一改成 **S2-a**,并写明「阶段名以本文件为准」。

### S3 · 切换与退役(1 天 + 观察 3 天)

**S3-a 执行记录(2026-09-28,行为零变化的那一半 —— 已完成)**:
- **主包侧提供端上线**:`ctx.provide('echo:relay', …)`(`lib/index.js`,S3 那一段),字段名**以消费端为准**
  (`dsh-echo-qq/lib/contract.js` 顶部那份契约一字不改):`{ version, inject, subscribeOutbound, ack,
  status }` + 可选的 `registerChannel`。`inject` 只把 `relay.handleInbound` 的 `body` 交出去
  (HTTP 状态码对插件没意义),`subscribeOutbound` 接到 `speaker.onOutbound`,`ack` 销主包同一份账
  (所以想念 ×0.5 照旧落)。卸载时用 `ctx.effect(() => () => disposeRelayService())` 摘掉。
- **扇出面**(`lib/speak.js`):`onOutbound(fn)` 订阅 + `notifyOutbound(payload)` 只在**真的入队了**那一刻喊
  (`finishTurn` 的 `rows > 0`、`say()` 的 `sent > 0`);没人订阅 = 零操作 ⇒ 默认部署行为逐字不变。
  钩子抛错被隔离(不计入叫醒数,与 `noteDelivered` 同一把尺子)。
- **传输开关**(新仓 `lib/config.js` + `lib/contract.js`):`transport = auto | service | http`(默认 `auto`)。
  `auto` = 有服务用服务、没服务回落 HTTP;`service`/`http` 是**严格模式**(不回落),专供"零轮询那条路
  真的通了 / 回退那条路还活着"两条验收。严格模式在 `inject`/`onOutbound`/`ack` 三条路上都生效
  (第一版漏了 HTTP 分支与 `ack`,被 `test/contract.test.mjs` 抓出来 —— 漏了的话"验收零轮询"就是假的)。
- **跨插件 DI 已实测**(2026-09-28 拿 cordis 真跑一遍,写在 `lib/index.js` 注释里):插件 fiber 里 provide
  的值落在 **root store**,**兄弟 fiber 读得到**;消费端先挂载时读到 `undefined`、之后现取才拿到
  (所以消费端每次 `ctx.get` 现取 = 顺序无关);`dispose` 后干净摘除;别的 fiber 抢改被拒
  (`cannot set property … in multiple fibers`)。
- **门槛**:主仓 651 → **665**(+`speak.test.js` 8、+`relay-service.test.js` 3)、python 305、
  `check`/`hygiene` 0;新仓 29 → **40**(+transport 开关 4、+打包纪律 5、+现推 1)、`check` 0。

- **⚠️ 契约缺口(2026-09-28 落地真机前抓出来,已补)**:主包推送只喊"有活儿"(`rows` 是**计数**,
  不带正文 —— 故意的,见 `lib/speak.js:170-171` 的注释),而新仓消费端原来却**期望推送里带正文**
  (`contract.js` 的 `Array.isArray(rows)` 分支)⇒ 两边一接就是**一个字发不出去、而且不报错**(静默失灵)。
  补法:服务加 `lease({platform, limit, leaseSec})`(内部就是 `relay.lease`,与 HTTP 那条
  `GET /api/echo/relay/outbox` 是**同一个动作**,按平台取 ⇒ 天然分渠);消费端收到叫醒后**现取**、
  发完照旧 `ack`(账仍在主包那一份上:租约/销账/`held`/想念 ×0.5 全不变)。另加**取行之前先问一句
  "发得出去吗"**(新仓 `canSend`):过渡期 AstrBot 那条老路还在跑、两条路共用同一份出站队列 ——
  没连接就不 lease,不抢他一轮租约(否则白晚 30s),计数 `skippedNoClient` 留痕。
  主仓 `tests/relay-service.test.js` 已钉住 `lease:` 这个字段(改名/删掉立刻红)。

**S3-b 执行记录(2026-09-28,前半 —— 已完成)**:
- **切换点 = 入站那道门**。旧的 `relayEnabled()`(旧桥总闸 + token)换成 `mouthOpen()`:
  **旧桥总闸 或 有渠道插件自报家门**。没插件注册时逐字等价(多了个 `|| false`)⇒ 现有部署不变。
- **⚠️ 踩过的坑(已写成验收用例钉住)**:门**不能**直接接 `speaker.hasChannel()` —— 没注册渠道时
  它会去问 `transport.status()`,而那正是这条 relay:`gate → isEnabled → hasChannel → status → gate …`
  递归到栈溢出,又被 `hasChannel` 内部的 try/catch **吞掉** ⇒ 静默返回 `false`
  (= 总闸明明开着,入站却全被 409,日志里一个字都没有)。所以新增**非递归**的
  `speaker.hasRegisteredChannels()` 专供门用(`speak.test.js` ⑫⑬ + `relay-gate.test.js` ④)。
- **陪伴会话常驻也走新门**(`if (relayEnabled())` → `if (mouthOpen())`):否则退役旧桥之后,
  "她够得到他的手机"这句承诺又会在没人跑心跳的夜里落空 —— v0.30.1 那个坑的同类。
- **消费端自报家门**(新仓):`syncMouth()` + 纯函数 `registrationAction()` + 每 5 秒对账
  (unref 定时器;主包可能比插件晚挂)。**自家总闸关了会撤回** —— 一条已关掉的嘴还挂着,
  主包就会以为她够得到他;注销/卸载也撤回。
- **配置改成活视图**:channel 拿到的是 getter 视图,改 `transport` / 主包地址**不用重启**。
- **验收**(真件:真 `speak` + 真 `relay` + 真内存库)`tests/relay-gate.test.js` 五条:
  ① 没嘴 ⇒ 照旧 409;② 插件自报家门 ⇒ **旧桥关着也能进能出**(退役那一步);
  ③ 旧桥还开着 ⇒ 与今天一模一样;④ 错接线的**静默**失败(不是崩,所以更危险);⑤ 源码钉子。
- 门槛:主仓 **672/672**、新仓 **42/42**、`check`/`hygiene` 0。

**S3-b 后半(还没做)**:
- **装机侧已完成(2026-09-28)**:新仓自带 `scripts/install.mjs`(`--check/--doctor/--remove/--profile`),
  已装进 `profiles/web`(junction + `dsh.profile.bundles` + `dependencies: link:`)并写出
  `~/.dsh/echo-qq/config.json`(`enabled:true`、`host:0.0.0.0`、`port:6199`、口令与 NapCat 一致、
  白名单从 `echo.db` 的 `relay_channels` 核出唯一私聊渠道 `<your-qq>`);
  **`dsh --profile web --dump-config` 里两个插件都解析到、零错误** ⇒ 重启不会"起不来"。
  绑不上端口会**退避重试**(15s × 20)⇒ "先重启、后关 AstrBot"这个顺序也走得通。
- **他两步都做完了(2026-09-28 当晚)**:AstrBot 整机退了(`6199` 换成我们的 node,pid 23048);
  重启后 NapCat **当场连上我们**(`client-connected`、口令一次过、心跳在跑)⇒ 她真的听见了:
  6 条入站进来、8 泡出去、**推送→送达 P50 127ms / P95 179ms**(旧桥是 2s 一拍)。
- **真机第一二轮抓到的三处丢话点(都在新仓修掉并钉了测试)**:① 信封少 `sender.isMaster`
  ⇒ 主包 `relay.js:341` 的 `not-master` 把每条都 403(且理由只在宿主 stdout 里,面板看不见);
  ② 出站行带的 `notBefore`(这一泡什么时候该发)没等 ⇒ 分泡节奏被压平,而"手里这泡发完就停"
  正是 barge-in 的前提;③ 超长回复被 `slice` **截断**(旧适配器是切段发)⇒ 新增 `lib/split.js`;
  外加"她正忙"时的入站重试(旧适配器的 `inbound_retry_times` 6 次/约 22s)与"接上就冲一遍积压"
  (`drain()`)。

**S3-b 后半 · 退役执行记录(2026-09-28,已完成)**:
- **删掉的传输面**:5 个 `/api/echo/relay/*` 路由(`index.js:2520-2633`)+ `relayGate`/`relayToken`
  + `relayAllowed`/`noteRelayReject`/`relayRejectStats`(401 拒签计数)+ `/api/echo/health` 的
  `relay` 字段 + 面板那张"传话桥"卡片(`web/app.js` 的告警块、`lib/client.js` 的 `RelayCard`)。
  **401 这个失败模式从此不存在**(没有令牌可错了)。
- **门只剩一个判据**:`mouthOpen()` = `speaker.hasRegisteredChannels()`;`settings.relay.enabled`
  不再算数(留着不读)。`relay-gate.test.js` ③ 从"旧桥开着照收"翻成"旧桥开着也不再算数"。
- **归档(不是删,`git log --follow` 追得到)**:`archive/astrbot_adapter/`(614+506 行 + 3 个测试)、
  `archive/scripts/`(relay-accept / install-adapter / test-adapter-host / adapter-live-check /
  smoke_relay)、`archive/docs/RELAY_PLAN.md`、`archive/tests/`(relay-rejects / relay-config-path)。
  npm scripts `smoke:relay`/`accept`/`preflight`/`test:adapter`/`test:adapter:host`/
  `check:adapter:live`/`install-adapter` 一并摘掉(`check` 里 5 条 `node --check` 也去掉了)。
- **没动内核**:`lib/relay.js` 的 `handleInbound/lease/ack/setChannel` 一个字没改 ⇒
  `relay.test.js`(868 行)一个用例都没改就全绿 = "拆传输、留内核"的证据。记忆迁移四件套
  (import/merge/rehearse/retire-a-side)与 `python/worker.py`(她的**引擎侧车**,不是桥)照旧。
- **门槛**:主仓 **666/666**(672 − 归档掉的 6 条:relay-rejects 3 + relay-config-path 3)、
  `check`/`hygiene` 0;新仓 **94/94**、`check` 0。
- 回滚:旧桥代码在本条提交的父提交(`git show <父>:lib/index.js`);A 侧适配器在
  `archive/astrbot_adapter/`。

### S4 · 加固与前端接口(1~2 天)
- 心跳探活 + 断线不销毁 + 工具收窄的实际拒绝日志;多账号隔离(参考实现多实例会互串
  `onebot.js:311-316`,我们明确只支持单账号,并在配置里拒第二个)。
- **给 TTS / Live2D 的接口**(前端在做,我们只提供契约):
  - **TTS**:出站语音段(OneBot `record`,`bridge.js:1698` 的形状);建议我们只在渠道层
    暴露 `sendVoice(chatId, file)`,TTS 由前端/外部服务生成。
  - **Live2D**:事件流订阅"她开始说 / 说完了 / 被打断"——建议**统一到一条流**
    (我们 `lib/events.js` 的 SSE,而不是两套),事件名与字段写进 `docs/API.md`。
- 面板:桥那一栏改成"渠道卡"(读 `speaker.status()`),或等新插件稳定后自带一页。

---

## 5. 验证:同一把尺子

**延迟**(现在的基线,活库 20 轮实测):入站 → 她交出话 **中位 8.61 s**(6.0~26.5 s,
大头是模型思考);出站段 = 2 s 轮询 ⇒ 平均 **~1000 ms**、最差 ~2000 ms
(`astrbot_adapter/relay_core.py:48`)。
- 打点五段:`in 到达 / 她入队 / out 入队 / 出站调用 / ack 回来`。
- 目标:出站段 P95 ≤ 100 ms;整轮**只减不增**;一条 QQ 也不许丢。

**功能**(每条一个测试):分泡条数与泡间节奏、打断残句、关怀保鲜期(5 分钟没送出去就丢)、
主动开口三条路(心跳/提醒/余波)、图片、长文、幂等(重复 `msgId`)、忙时重试、401 计数。

**安全**:白名单、群拒收、工具收窄(实际拒绝日志)、注入纪律(QQ 原文不得改变行为边界)。

**装机**:`install.mjs` verify(profile bundles + dependencies)、`hygiene`、`check` 全绿。

---

## 6. 风险表

| 风险 | 处置 |
|---|---|
| 反向 WS 没有心跳/重连(参考实现短板) | S2 探活 + S4 告警与可选拉起;反向 WS 下"重连"是等 NapCat 回来,写清楚 |
| 它的 action 集合对着某个 NapCat 版本 | 能力探测 + 降级(它的 README v0.5.3 就是这么做的:发不出内联按钮就降级) |
| 断线销毁会话(它的行为) | 我们**不复制**这条;断线只标记 offline |
| 两套事件流(我们的 SSE + 它的 trace) | 前端**只用一套**(建议我方 SSE),写进 API 文档 |
| `'global'` 与历史审计数据 | 字面量保留 + 语义收敛,不改历史 |
| 装机校验(第二个包) | 照 §S2 的清单改,先跑 `--dry-run`/`--check` 再真装 |
| 参考实现的业务层诱人(命令/群运营/TTS) | 一律不接:群聊已裁决不要(私聊单主人),TTS 归前端 |

---

## 7. 工作量与待拍

**工作量**:S0 1~2 h · S1 1~2 天 · S2 2~3 天 · S3 1 天 + 观察 3 天 · S4 1~2 天
≈ **5~8 个工作日**(按我的轮次推进)。

**进度(2026-09-28)**:**S-1 ✅ 搬家** · **S0 ✅ 探针** · **S2-a ✅ 骨架** · **S1 ✅ 完成**(`f40904a`+`201a597`)·
**S3-a ✅**(扇出面 + 服务提供端 + 传输开关 + **契约补 `lease`**)· **S3-b 前半 ✅**(入站门 `mouthOpen()` + 消费端自报家门)·
**S2-b 准备 ✅**(验收体检一条命令 + 真机清单 + **装机器**)· **S2-b 装机侧 ✅**(已装进 `profiles/web`、
配置写好、`dsh --profile web --dump-config` 零错误;主仓 672/672,新仓 74/74)·
S2-b 真机一轮 ⬜(**只剩他两步**)· S3-b 后半 ⬜(退役与观察)· S4 ⬜。
**剩下三块**:① S2-b 真机一轮(**要他两步**:关掉 AstrBot 那条反向 WS(`6199` 现在归它)+ 重启
`dsh web`,然后 `node scripts/acceptance.mjs` 一条命令看清通没通 —— 清单见新仓 `docs/REAL_MACHINE.md`);
② S3-b 后半 退役(默认传输切插件 + 观察 3 天 + 旧桥封存 `archive/` + 桥测试重排 + 面板桥签卡);
③ S4 加固 + TTS/Live2D 接口。

**打包纪律(2026-09-27/28 他拍的:不许写死地址)**:源码里不出现具体的地址 / 端口 / 本机路径 ——
打包出去以后别人的 `dsh web` 跑在哪个端口、插件装在哪个目录,都不是我们说了算。
落法:① 主包地址**现推**(显式配置 → 宿主 `webServer.port` → 空串;`resolveMainBaseUrl`,
新仓 `lib/config.js`);② 监听地址/端口是**默认值**,一律可改;③ 强制手段 = 新仓
`test/nohardcode.test.mjs`(**扫源码,不靠自觉**;允许清单只有 `config.js`(默认值集中地)与借来的
`onebot.js`;规则只认**地址形态**,不认"冒号后跟数字" —— 头一版把 `pollMs: 2000` 与 CSS 的
`:20px` 都误报了,还把 URL 的 `http:/` 当成盘符 `p:/`,两条元测试现在都钉住)。
④ 仓库里**一个密钥都没有**(`config.json` 在数据目录,`.gitignore` 另拦一道);`LICENSE`(MIT)
里写明 `lib/onebot.js` 是借来的。

**你已拍的五件(2026-09-27)**:① ✅ **自带一页**(落点见 §3.3);② ✅ 旧桥代码**封存 `archive/`**;
③ ✅ **搬家**到 `~/.dsh/plugins/`(**已执行**,见 §S-1 执行记录);④ ✅ 装机改成 **link**
(已执行:依赖登记 `link:…`,装机位 = Junction);⑤ ✅ S0 试装用**以前的 QQ 小号 3783207594**。

**S0 只差一步**(不用他拍板,但要他这台机器配合):
1. 试装参考实现走**第二个 profile**(`--profile qqtest`,里面不加载 Echo)—— 装机前先确认
   NapCat 的反向 WS 端口与 AstrBot 错开(一次只能指一处);
2. **他必须做的一步**:重启一次 `dsh web`(搬家改了装机形态;面板不用等,junction 已经生效)。

---

## 附:这份计划的事实来源

- 参考实现审计(128 个文件逐层读过):`lib/index.js:17-292`、`lib/onebot.js:4-672`、
  `lib/bridge.js:376/1395-1400/2958-3032/4206-4211/4520-4617/4609/4619-4628/5541-5571/5623/5652-5666`、
  `control/lib/server.mjs:80`、`package.json:44-61`。
- 我们这边耦合面诊断:`lib/index.js` 15 处接线、`lib/relay.js:107-831`、`lib/relay-tools.js:123-144`、
  `lib/bubble.js:65-133`、`lib/eyes.js:36-201`、`lib/interrupted.js:20-36`、
  `lib/settings-fields.js:65-79`、`lib/toggle.js:390-419`、`lib/heartbeat.js:171-236`、
  `lib/say-again.js:127-186`、`lib/turn-query.js:43`、`lib/store.js:22/105-117/245-326/1450-1796`、
  `store.js:1631-1760`(租约/ack)、`scripts/install.mjs:88-131/311-343`、`scripts/hygiene.mjs:60-80`。
- 活库实测:20 轮"入站→她交出话"中位 8.61 s;出站轮询间隔 `relay_core.py:48`。
