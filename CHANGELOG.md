# dsh-echo 更新日志

## v0.46.0-rc.1 · 发布工程预发布（2026-11-05）

- 整理现有新版面板与旧站回退说明，补安装、升级、卸载、隐私、安全和贡献文档。
- 锁定可在干净克隆安装的公共宿主开发依赖；Node24为本轮基准。测试同时枚举JS与MJS，单元和跨仓分开报告。
- Python公共测试在合成主目录和临时工作区执行，先核源码摘要与保护负控；753项原安全用例加10项合成契约，原模型/私有快照10项显式单列人工，不计通过或跳过。
- 补齐跨仓测试的WebSocket开发依赖与trace目录准备；缓存缺项测试显式注入无会话窗口，保持生产警告和缓存保护断言。
- 老链路归档使用完整只读采样事务和有界锁重试；采样未知或结构变化时拒签，`--force`仅覆盖已知写入信号。
- 修复复制安装缺预设/运行依赖、祖先junction越界，以及失败预检覆盖旧分发包；替换异常可回退代码、登记与tgz。不是跨多个文件的断电原子事务。
- 发布闸检查语法、隐私、依赖/路径、原始许可和实际包内容；CI同仓闸在私有阶段运行，公开后非PR事件另跑跨仓。
- 移除未证明安全的旧审计截图，只保留两张合成图；补全IPC、PAD、D3、正文提取依赖和开发预设的来源与许可。
- 未扩充陪伴业务特性，未执行真实模型/QQ调用或npm发布。已知范围和限制见`docs/releases/0.46.0-rc.1.md`。

## v0.45.0(未发布)· 用户侧坐标 + 人格基线:她眼里的他也上屏了(2026-10-06)

- **(2026-10-10)情绪衰减三笔 + 速率校准:把"只升不降"和"卡在 8.0 的下界"一起拆掉** ——
  起因是调研《情绪动态学调研-2026-10-10》查出三处结构性问题:打分器只写升的规则、
  衰减下界恒等于出厂值(所有先例都真的走到基线,只有 Echo 不)、衰减形状是线性恒定
  hazard(实测人类情绪是"前重后轻")。
  ① **笔 1(A+D)**:`emotion-score.js:92-93` 的两条示例补成对称(原来"爱意/依赖"
  只出现在升的那条);`reflect.js:73` 的反思纪律补"也不要为了显得矜持而虚报冷淡"。
  D 让衰减可观测 —— 此前它**只写日志不写库**,`emotion_delta` 的 72 行全部来自
  extract、一条衰减都没有。留痕用新 `tool_call='emotion_decay'`。
  ⚠️ **不许借 `'care'`**:`store.js:1671` 的 `careCountSince()` 是主动开口日上限的
  真相源,借它等于"她今天已经开口 48 次"⇒ 日上限打满、她再也不主动说话且不报错。
  ② **笔 3 验证步**:钉住「衰减基线吃 `state-defaults.json.emotionVector`」——
  实测基线**每次衰减现读文件**,所以改数据立刻对已有行生效、不需要迁移。
  ③ **笔 2-B-1a**:`toward()` 从线性绝对步长换指数逼近,半衰期锚定改前线性在 6h
  处的行为(3h–81h)⇒ 只换形状不换速度,16 条断言里 11 条不变。
  ④ **笔 2-B-1b**:加距离依赖 `HL_eff = HL/(1+asym·d^1.35)`,asym=1.0。
  ⚠️ **不能用显式 Euler**:乘子在远距离/大 dt 时 ≤0 会发散(实测误差 1e+42);
  改用 64 步**中点指数积分器**,与 RK4 参考解最大误差 < 0.0002。
  ⑤ **笔 5 速率校准**:HL 从 3h–81h 改成对齐人类经验区间 + Letta 先例 ——
  valence/arousal 1.4h(Kuppens 2010 AR(1) 换算)、playfulness 2.5h(Letta
  SHORT_FEELINGS 类比)、affection/dependency 24h(Letta LONG_FEELINGS 直接先例
  与关系维类比)、sadness 7h([工程假设] 折中)、fatigue 3h 不动(生理量)。
  ⚠️ 注释写明**基础 HL ≠ 实际半程时间**:asym 让远距离更短,最大距离起点实测
  fatigue 1.84h / valence·arousal 0.86h / sadness 4.29h / playfulness 1.53h /
  affection·dependency 14.71h。
  **测试**:JS 1747 条全绿(含新增的留痕闸门、距离依赖行为、疲劳归零粒度三条)。

- **(2026-10-09)期 0 并发观测 + 审计流大改造:一轮里"并起的两支"终于能分开看** ——
  ① **期 0 审计仪表盘**:`audit_logs` 加 `stage` / `step`(JS + 引擎两侧同步)、
  后续补 `stage_detail` 列并修 `writeAudit` 的 INSERT(它原本没带这三列);
  轮末审计挂上「当轮 trace」(壳注入 `traceOf`,longing_steer 与那一轮同 trace);
  反思/主动开口/say_again/tool-audit/reflect/diary/store 共 8 处补齐 stage;
  注入行带 `assemble` + 各段字数;query-expand 的三条早退路径也落审计(step 22)。
  ② **审计卡片/审计页**:iframe 隔离接成品 → 改外链打开(不嵌 iframe、修 XHR、
  补 `/echo/` 前缀治 404、适配层把扁平行折成「一轮一项」治 TypeError);
  新审计页接真数据(真计数走 `/api/echo/status`,清掉"样例"口径);
  老面板审计下线(导航改外链 + 停审计轮询)。
  ③ **面板卡顿根治**:审计端点 light 裁剪(816 KB ⇒ 约 200 KB)+ 轮询 10s→30s +
  轮询错峰(每拍 13 → 4)+ 去掉 EventSource 全改 30 秒轮询(解连接池争抢)——
  治的是"面板一开就卡 + DSH 发不出消息"。
  ④ **关怀与注入文案**:三句死禁令改成"活判断"引导;主动关怀补材料(把"最近几轮
  原文"喂进 framing,取不到整段消失);关怀路接"关联路径"(`graphPaths` 只读入口);
  对话轮把"回忆无关时不要硬提"改软;注入块去重 C3。
  ⑤ **修 `worker.py` 漏传 `core_block`**(memory_search 路径):常驻 L0 不该占证据席位。
  **测试**:JS 1745 条 / Python 681 条,无回归。

- **(2026-10-08)新会话默认开关按来源分档 + 审计流六处修复 + 两次队友合并** ——
  ① **新会话默认开关**:按来源分档(DSH 关 / QQ 开 / 其他关)+ 面板三项;
  语义 C —— 顶层会话出现时登记进硬开关名单(`manualOff`),`autoScope` 永不覆盖;
  压缩后端策展跟「Echo 会话开关」联动(路 B 第一拍);`retainRatio` → `retainTokens 12000`。
  ② **审计流六处修复**:折轮窗口比展示窗口大(轮 id 不再随窗口滑动而漂,F1′);
  展开详情不再被自动关/换人(F2)+ 点开即冻结(F3);降噪(reaper 不再每 10 分钟写审计
  + 心跳归机器行 + 窗口按内容凑数 + 白名单);检索框被浏览器自动填值(关 autocomplete
  + 首帧兜底 + 空态提示),后续再改 one-time-code 并守 3 秒治竞态。
  ③ **队友合并**:语气语法由 `[emo:N]` 点标记改为 XML 标签;渠道 `canSend:false` 时
  主包不记来路(入站-only 渠道不再被排进出站队列)。
  ④ **查询扩展 + 情绪同轮打分**:从**子代理**改走**直调通道**(后台静默、零子代理会话)。
  **测试**:JS 1711 条 / Python 681 条,无回归。

- **(2026-10-07)合队友改动:渠道 `canSend:false` 时主包不记来路** ——
  入站-only 渠道不再被排进出站队列。

- **(2026-10-07)记忆引擎可取消:带外 cancel 帧 + 协作式检查点** ——
  为语音输入/推测执行铺路:在途检索原本**只能丢弃结果,不能真停**。
  ① **为什么原来停不下来**:`worker.py` 主循环是 `for line in sys.stdin`,
  跑在 `rank_memories` / 图谱 BFS 里时**根本没在读 stdin**,壳发来的取消
  要等当前请求整个跑完才会被看见 —— 那等于没有取消。
  ② **并发模型**:拆出一个 stdin **读线程**(`_read_loop`),只做两件事 ——
  把 `cancel` 帧立刻交给 `engine/cancel.py` 置位(带外),其余帧原样入队,
  业务线程按**原来的串行语义**处理。读线程**不碰 stdout**(协议级错误也
  包成 `_WireError` 塞回队列由业务线程回帧),所以 `send()` 仍只有一个写者,
  不需要加锁;SQLite 与状态机假设的串行也一个字没动。
  ③ **新模块 `python/engine/cancel.py`**:令牌 + `checkpoint()`。单独成模块
  的理由和 JS 侧 `lib/interrupted.js` 同款 —— worker 顶层 import 所有引擎
  模块,引擎模块反过来 import worker 就成环,这里谁都能用、谁也不依赖谁。
  ④ **检查点位置**:`retrieve.rank_memories` 打分循环(候选池 500 条)、
  `graph.graph_activate` 的 BFS 轮首、`episodic.insert_memory` 去重候选循环,
  外加 `worker.main` 的**开局检查**(取消在请求排队期间到达时连活都不干 ——
  这也是唯一能让 `ping` 这种没有长循环的帧也可取消的路径)。一律放轮首:
  取消的语义是「尽快停」不是「立刻停」,半途抛异常会让状态停在写了一半处。
  ⑤ **协议**(`echo_wire_v1` 向后兼容扩展):壳 → 引擎
  `{"type":"cancel","targetReqId":<n>}`(**带外**帧,自己不带 reqId,不为它
  回帧);引擎 → 壳 `{"reqId":<target>,"type":"cancelled"}`,与业务应答同一个
  reqId 通道。老壳不发、老 worker 走既有「未知 type → 非致命错误帧」规则,
  两侧都不需要新分支。
  ⑥ **⛔ 一条不许混的纪律:取消 ≠ 超时**。超时 = 「挂着的引擎不可信」⇒
  `_kill` + 计失败(可能推开熔断器);取消 = 调用方主动撤回 ⇒ **不 kill、
  不计失败、也不 `noteSuccess`**。壳侧 `SidecarError` 加 `cancelled` 标记,
  调用方据此区分,不必匹配 message 文本。abort 时**立刻本地拒绝**,不等引擎
  的 `cancelled` 回帧 —— 引擎可能正卡在两次检查点之间,等它就把「取消」退化
  成「超时」,而超时会击杀进程。
  **测试**:Python 侧 17 条(令牌语义 / 跨线程置位 / 在线协议,含「取消先到、
  请求后到」这条竞态)、JS 侧 7 条(新增 `tests/sidecar-cancel.test.js` +
  夹具 `tests/fixtures/cancellable_worker.py`,含「同一份夹具不带 signal 就是
  超时 → 击杀 + 记账」的对照)。全量:JS 1711 条 / Python 681 条,无回归。

- **(2026-10-06)P6 悬置话题完整生命周期(D1→D5)**:把"只增不减的两态池"改成
  **有类型、有状态机、有节拍**的一池账。设计文档《悬置话题机制设计-2026-10-06.md》
  (桌面《交接》)§1–§8 逐节落地,七个拍板点全按建议(5 类 / 列表达冷却归档 /
  终态不回退 / 物理删除默认关 / 老行不回溯补判 / 数值先用工程假设 / 全做)。
  ① **D1 类型与影子列**:`pending_threads` 加 4 列(`kind` / `cooling_at` /
  `archived_at` / `superseded_by`),两侧同批(JS DDL + 引擎 `_DDL` + 双侧加列迁移);
  类别判定**规则优先 → LLM 兜底 → 认不出留 ''**(不猜),单一落点在
  `threads.remember_pending_thread`;白名单两侧同源,`tests/thread-kinds.test.js`
  从 python 正则抠表逐条比对。**D1/D2 只写不读(影子期)**。
  ② **D2 生命周期 tick**:`threads.cool_then_archive` 按类冷却(schedule 事件+6h /
  reminder 提过或+12h / care 3d / promise 14d / topic 30d / ''7d)+ 冷却/已了结
  满 7 天归档;**只盖两列**(不动 status、不推 updated_at、不删行),没有该动的行
  一条 UPDATE 都不发;搭壳侧已有的 60 秒节拍 + 30 分钟桶(不新起时钟),每个自然日
  第一拍打一行影子比对日志。
  ③ **D3 注入侧生效**:与门 = `status='open'` ∧ `cooling_at=0` ∧ `archived_at=0`
  ∧ `kind<>''` ∧ 类内时效;排序第三键 `created_at` → `updated_at`;配额
  topic≤2/schedule≤2/care≤1;「早该问了」只在真的到期未提时出现。面板/API/导出
  拿到五档数据(冷藏/已了结/归档),候选池(topic-score)只认活跃档。
  ④ **D4 语义去重 + 留档取代**:同 kind ∧ 48h ∧ 字符二元组 Jaccard ≥ **0.70**
  (阈值是拿现网 6 组近重复标定出来的:数据结构组 0.714 并得掉,次高 0.412,
  不该并的对照 0.60 ⇒ 设计稿建议的 0.80 一组都并不掉);被并者
  `status='archived'` + `superseded_by` + `archived_at`,不删行。
  ⑤ **D5 面板 / API / 导出 / 文档**:话题卡改成**五档**(活跃/冷却/已了结/归档默认折叠)
  + 类别徽标(面板仍然只读);`POST /threads/act` 加 `restore`(只拉回冷却中的,
  归档/被取代/已了结不给恢复);导出仍含全量但标 `lifeState`。
  **顺手抓到的两处静默失败**(都补了钉子):`many()` 的 `catch → []` 把夹具缺列吞成
  "快照为空";壳侧镜像用保留标点的归一算相似度(0.667)与引擎侧去标点的(0.714)
  不一致 ⇒ 跨阈值就"一边并一边不并"。
  测试:JS **1696/1696** · `npm run check` 0 · py **664 OK**(skipped=5)。

- **(2026-10-06)P5 用户侧坐标 + 人格基线 + 锚点清单删除 + 衰减事故修复** ——
  由来:情绪面板缺三块("主人一侧坐标 / 关系度量 / 人格基线"一直是"未接入"),设计文档
  《情绪面板缺口补齐设计-2026-10-06.md》拍板九项。落地 **MVP-1/2/4 + 锚点删除**
  (**MVP-3 前端未动**,等演示后再改 `web/views/emotion-space.js`)。
  ① **同源路线甲(双轨 + 对账)**:他的点走轮末**异步**判定(用上游 `lib/ipc-core/appraise.js`
  的提示词,**不新写**),她的点仍走映射;同一次判定的 `self` 与"映射出来的她"做残差
  `ipc_err` —— **只记账、不回写**,也不进 `space-bridge` 的 s/门禁;分带复用其阈值
  (0.15/0.3),**红档不画数**。② **编排纪律**:跑在主包(QQ 侧不动)、**不进 prompt**、
  不占回复时延;节流两道闸(每 3 轮 **且** 10 分钟,参数进面板);**串在反思之后**
  (两条路都写 `emotion_vector`,并行会互相覆盖);可信度 `gain = 把握 × 完整度`,
  低于 0.35 **不落库**;**五种失败/跳过全留痕**(审计 `toolCall:'ipc-appraise'` +
  状态面 `echo_status.ipcAppraise`,不许静默)。③ **零 DDL**:结果只并进已有
  `emotion_vector`(TEXT JSON)的新键 `ipc_dyad` —— `agent_state` 是 JS/PY 共有表,
  加列要镜像改 `python/engine/db.py`,一期不加。④ **人格基线**(`lib/her-baseline.js`):
  只做 **P/A 两维,`d` 恒 `null`**(支配维"已登记未启用");原生值口径、不经桥接;
  存 `config.json`(面板字段 +10 项,含只读的 source/updatedAt)。⑤ **锚点清单删除**
  (拍板 ⑨):端点 `ipc.anchors` 恒 `null`(与 `region.label` 重复且不随读数变化);
  **`lib/ipc-core/lexicon.js` 模块保留**(最近词/178 条状态词/注入侧取姿态词都靠它)。
  ⑥ **事故修复**:验证时发现 `ipc_dyad` ≤30 分钟自己消失、**无报错无日志** ——
  根因是衰减 tick(`decayedEmotionVector` → `clampEmotionVector`)**只重建已知维**,
  额外键被顺手丢弃后整份向量写回。新增纯函数 `carryExtraEmotionKeys(prev, decayed)`
  ("衰减只衰减情绪维"),活库上复现(老路丢键/新路保键)+ 5 条单测钉住。
  测试:JS **1681/1681**(新 `tests/ipc-appraise.test.js` 14 条、`tests/her-baseline.test.js`
  6 条、适配器形状快照、衰减写回 5 条)· `npm run check` 0 · py 639 OK(skipped=5)。
  端点新形状与"只读上屏"的缺失语义见 `docs/API.md`;面板与基线口径见
  `docs/EMOTION_SPACE.md` §5d。

## v0.44.0(未发布,已并入 v0.45.0)· DSH 0.2.0-rc 适配(双世代预设)+ 幽灵层守卫收口(2026-10-02)

- **(2026-10-06)P4 真昵称清零 + 本地闸:代码里根本不该有真昵称** ——
  由来:发布干跑对着**真实发布树**复扫,发现真昵称还有 **87 处 / 20 文件**(测试夹具、源码注释、
  文档)、真别名 21 处 / 8 文件,而硬闸四类(用户名边界 / 盘符绝对前缀 / token 形态 / 数据目录路径)
  **一条都不管它** ⇒ 口径缺口。方向改为"代码里根本不该有",开发时就拦住:
  ① 新增 `lib/name-lint.js`:针从**数据目录的 profile.json 现读**(`userAliases` + `agentAliases`,
  仓里不写死真值),「用户」「助手」这类角色槽与项目公开名 `Echo` 走**通用词豁免**(不误伤),
  ASCII 针走**词边界**(名字是别人词头不算命中)、CJK 针走子串;白名单**集中一处、默认空**
  (现存唯一一条 = 发布脚本的提交身份,刻意公开);`loadNeedles()` 让测试复用同一口径。
  ② 新增 `scripts/check-names.mjs`:仓内扫描(`lib/python/web/tests/docs/scripts` + 根文档,
  排除 `node_modules/.git/archive/.scratch`),命中即非零退出并打印 `文件:行 针` + 原文;
  ③ 新增 `tests/name-lint.test.js` 7 条电池(判据 / 词边界 / 白名单 / 仓内实扫);
  ④ 接进 `npm run check`(`check:names`)与 `npm test`(仓内实扫那条 = 防复发钉子);
  ⑤ 清洗 **98 处**:测试夹具换中性假值(阿岚 / 阿乙,断言同步重基线)、源码注释改中性描述、
  文档改 `<称呼>`、3 处本机绝对路径去掉;⑥ **自净**:lint 白名单字面量拆开拼(与
  `publish-org.ps1` 同款纪律),否则闸会把自己闸死。
  验收:故意塞一处真昵称 ⇒ 闸红并定位到行;删掉 ⇒ 绿。三绿 JS 1651/1651 · check(含真昵称闸 0 命中)·
  py 639 OK。重跑发布干跑:发布树里真昵称 **0 命中**(QQ 桥 sha 不变)。
- **(2026-10-06)P3-B 直调通道:终局块必须读(错误不许被吞)+ messages 走宿主形状 + maxTokens 4096** ——
  承接 P3-A。重启后 P3-A 生效(`llmSkipped` 停在 0、`lastNote` 读出「继承本会话 route(jichuang/…)」),
  但变成 `llmOk=0 / llmFailed=2`、8.9 秒后失败,**而终端一行日志都没有**。静态对照定因:宿主
  `dsh-llm/lib/index.js:2360-2387` 的契约是"适配器/派发失败**不抛异常**,而是发一条终局
  `{type:'finish', reason:{kind:'error', failure}}`",我们只收 `text-delta`、**把终局块整条丢了**
  ⇒ 错误被无声吞掉,只剩「空产出」(而"空产出"那条分支又**不打日志**)。
  **做法**:① `llm-channel.js` 新增导出纯函数 `classifyFinish(reason)`(语义照抄官方先例
  `dsh-session-title-llm/lib/index.js:161-174` 的 `finishError()`:`error/aborted` 取
  `failure.code+message`、`max-tokens` = 「思考把 maxTokens 吃光了」、`tool-calls` = 「模型要调工具」、
  `stop`/取不到 = 正常);循环里**收终局块 + 数 `reasoning-delta` 字数 + 记 chunk 类型计数**,
  空产出与终局失败**都写 `stats.lastError` 并 warn**(不再有沉默失败);② `snapshot()` 带
  `lastError/lastChunks/lastReasoningChars`,`index.js` 抄进 `reflectStats.llmLastError/llmLastChunks`
  (键集与 `echo_status` schema **同批声明**),**失败时也把错因顶到 `reflectStats.lastNote`**
  (以前失败时停在选路说明上,面板显示"继承 route"误导);③ `messages` 改用宿主工厂同款形状
  `{id, role:'user', content, source:{kind}}`(`createMessage` 的字段逐个对齐,先例 `:197-203` 同款);
  ④ `llmMaxTokens` 默认 **1024 → 4096**(`llm-channel.js` + `toggle.js` + 面板 hint:推理型模型的
  思考**也占 maxTokens**,1024 常思考没完就没了);⑤ `purpose` **保持不传**并写明是有意差异
  (宿主值域只有 `compaction|session-title`,`typert.host.js:313`)。
  **测试**:`tests/llm-channel.test.js` +6(终局 error/max-tokens/aborted·tool-calls·未知·stop、
  `classifyFinish` 纯函数、空产出诊断面、messages 形状与"不传 purpose")、`tests/reflect-route.test.js`
  +5 条接线钉(错误原文上状态面 / 键集同批声明 / schema 同批声明 / 失败顶 lastNote);JS **1644 绿 / 0 败**。
  实验(不重启,只改 `config.json` 的 `llmMaxTokens`):待他一句 QQ 触发。
- **(2026-10-06)P3-A 反思静默 35 小时:直调通道默认继承会话 route + 未配置明确退子代理(方案 C+B)** ——
  诊断:`Desktop/交接/反思失败-诊断-2026-10-06.md`。现场:活状态面 `reflect=跑 2 趟/失败 0 ·
  上次 0.0s · ⚠上次失败`,而 `llmSkipped=8`、`llmOk/llmTimeout/llmQueued/llmFailed` **全 0**、`lastMs=5ms`
  ⇒ **每一轮反思都在直调通道第一道配置闸原地跳过**:方案 C 的 `llmProvider`/`llmModel` 默认是空串
  (`toggle.js:645-646`),而运输口按 `llmChannel.available()`(只看宿主 llm 服务在不在)选路 ⇒
  **直调照走、原地跳过、子代理退路一次都没接上** ⇒ 反思静默零产出(记忆断在 **10-05 03:25**,
  `reflection_state.last_at` 同刻;期间对话一直在,turn 1028-1035)。
  **做法**:① 新增 `lib/reflect-route.js`(纯逻辑):`routeOfRequestHeader` 从宿主 `session/event`
  的 `request/header` 取 `header.config.provider/model`(与 `dsh-session-title-llm:138-146` 同源),
  `resolveReflectRoute` 面板两格 ⇒ **覆盖项**、没配 ⇒ **继承本会话 route**、都没有 ⇒ `none`;
  `chooseReflectTransport` 在"配不齐 / 开关关 / 没 llm 服务"时**明确退回子代理**(两条都不行才 `none`),
  并把原因回给调用方;② `llm-channel.js`:`runStructured` 接受传进来的 `provider/model`(优先于设置),
  新增 `usable(route)`;**跳过一律写 `lastNote`**(未配置 / 开关关分开写),不再静默;③ `index.js`:
  `sessionRoutes` 记住每条会话最近一次 route、`reflectTransport(sid)` 按决议选路、理由写进
  `reflectStats.lastNote`(面板看得见「反思这轮为什么没动」);④ 面板两格改名为「(覆盖项)」并重写 hint。
  **测试**:新增 `tests/reflect-route.test.js` 4 条(route 提取 / 覆盖与继承 / 选路矩阵含"不静默" /
  index 接线钉,并钉死旧写法 `llmChannel.available() ? {` 不许回来)、`tests/llm-channel.test.js` +3
  (route 优先 / 跳过必留原因 / `usable`);JS **1638 绿 / 0 败**。

- **(2026-10-06)P2-B 注入留痕:把"她这一轮读到了什么"独立写进审计** ——
  诊断:`Desktop/交接/记忆调用机制-2026-10-06.md` §5.4。现象:`audit_logs.injected_memories`
  活库 **160 行全空**(`MAX(LENGTH)=0`),而 9-25 的备份里有 15/82、19/98 行带内容(最长 1404 字)。
  追下来的两个原因(都不是"写入端被删了"):**① 真凶** —— 这一列过去的唯一产地是
  **轮末反思成功**那条 `tool_call='extract'` 行 ⇒ 反思跳过/失败的轮次,证据根本不落库;
  **② 帮凶(latent,测试钉住)** —— 全量工具审计(v0.32.0 B1)之后工具行成了洪水
  (实测 10-05 20 点那一小时 97 行里 93 行是工具行),而 `trimAudit` 只有一个预算,
  证据行会被挤出保留窗。⚠️ 口径:活库当前 `auditKeep=500`,**还没被咬到**;但保留
  条数一旦调小(面板最小 20),工具行洪水几分钟就能把证据行冲光 ⇒ 这次一并分桶。
  **做法**:① 写入端 —— 组装完这一轮提示词就把注入块原文写一行 `tool_call='inject'`
  (`turn-snapshot` 算完快照回调 `onInject` 一次 ⇒ `index.js` 落库),与反思成功与否无关,
  **一行/轮**(轮内复用不重复)、**空块不写行**、**整段 try 住**(留痕失败只丢这一行,
  绝不影响注入与回复);② 裁剪分**两个预算**(`trimAudit`):证据行与工具行各留 `auditKeep`
  条(默认各 100,表体量 ≤ 200 仍有界),判据用 `tool-audit.js` 导出的 `TOOL_ROW_MARKER`
  单一产地;③ 展示 —— 审计流页统计带加一枚体检标签(「注入留痕 N 行(最近 X 字)」/
  「⚠ 这一窗没有注入留痕」),`inject` 行进"提取"族、人话名「注入留痕」。
  **测试**:`tests/store.test.js` +2(两桶裁剪:工具行洪水挤不掉证据行 / 留痕行原样进出一字不丢)、
  `tests/turn-snapshot.test.js` +4(一行一轮+落原文 / 轮内复用不重复 / 空块不写+回调炸了照常注入 /
  index.js 接线只许一处写入端)、`tests/audit-view.test.js` +2(人话名与归族 / 统计带体检读数)。

- **(2026-10-06)P2-A 渠道闸:轮末「补一句」只在平台轮补(治"自言自语"bug)** ——
  诊断:`Desktop/交接/DSH自言自语-bug诊断-2026-10-06.md`。现象:他在 DSH 里直接跟她
  说话时,她正常回复后**又多一条 assistant 消息**(对 `longing-steer` 的回应),而
  heart-tts 把那条插件注入当"用户抢话"(`agent/inbox/inserted` ⇒ `client.cancel()`),
  砍掉正常回复的音频 ⇒ 只听到那句"自言自语"。根因:轮末硬保证(**给 QQ 世界设计的**)
  在任何轮都触发,而渠道闸只挡"外发平台",没挡"在 DSH 会话里多生成一条"。
  **做法**:capture 记「这一轮从哪来」(`fromPlatform`:relay 注入的人话 ⇒ true、
  他自己打的字 ⇒ false、轮末归零 ⇒ null 当平台轮,fail-open 不误伤 QQ);
  `shouldSteerLonging` 加前置判定;新开关 `longing.steerOnlyFromPlatform`(**默认 true**),
  与总闸 `must_say` **串联**(总闸关 ⇒ 任何轮都不补,旧语义不变)。
  **只影响 `longing-steer` 一个 form** —— `care`/`wake`/`say_again` 是独立一轮的
  `followup`,不在这条路上。测试:`tests/turn-stopping.test.js` +4 条(纯判定 / 开关矩阵
  7 格 / 回归源码钉 / 接线钉),`tests/toggle.test.js` 默认值深比同步。
- **实测:只有预设会死,其余零改动** —— settings 槽、四个会话头槽、`slots.inject`、
- **双世代生成器**(`scripts/install-preset.mjs`):自动认世代 —— 0.2.0 ⇒ 整份抄出厂
- **三把纯函数刀**(`lib/preset-patch.js`):`presetDeclarationPatch`(手术保真:除压缩行外
- **世代门**(`scripts/check-preset-patch.mjs`,`npm run check` 第五闸):两代的
- **`peerDependencies: {[…]: […]}`**:正对照实测把范围改成
- **沙盒验收(隔离 DSH_HOME + 插件副本 + 真 0.2.0 二进制)**:组合树 exit 0 / 1454 行,
- **守卫收口(顺手抓的真失败)**:上一波幽灵层把 `v_cooc_pairs` 读进了 `lib/store.js`,
- **测试**:JS **1173 绿 / 0 败**(含新电池 `preset-declaration` 13 条:手术保真、幂等、
- **升级清单(他要做的)**:升级 dsh 后,在本目录跑一次 `node scripts/install-preset.mjs`;
  **留着**(0.2.0 不读它,降级回来还在);降回 0.1.x 重跑生成器自动摆回(双向都实测过)。

### 2026-10-03 补 · v4 会话格式的 `source.kind` 事故(她"QQ 上不回"的真根因)

- **根因**:0.2.0-rc 的 v4 格式要求 `source.kind` 写[…]形状(`plugin:dsh-echo`
- **修法**:新增 `lib/source-kind.js`(`ECHO_SOURCE_KIND` 常量 + 容错判定 + 兼容视图);
  **四处产出**改发 `plugin:dsh-echo` —— 入站(`index.js`)、再说一次(`index.js`)、
- **红线一字未动**:`lib/relay.js` 的 `marksProactive` 仍按旧形状(`kind==='plugin'`)判,
- **回归**:全量 **1179/0**(`npm test`,+6 为本次新钉);五道闸 `npm run check` 退出码 **0**。

## 未发布 · 记忆架构 v2(真库已落地:A1 / A2 / A4a / A5)(2026-10-02)

**A1 换代语义修复(形态 E = 同题重复守卫)**
- `python/engine/repair_multivalue.py` 新增 `guard_repeats` / `cover_ratio`,并入
- 真库实测:唤回**边 5**、记忆 **3**(#126 / #291 / #313)、按住 **2**(#127 / #128 与现役 #169 同题),
- 代价(消融实验量过、他选定并接受):R1BM25 mrr@10 0.694→**0.671**、SEH@3 **不动**(76.2%)、
- 单测 `python/tests/test_repair_multivalue.py`(10 条);代码形态与手造变体**九档读数逐位一致**。

**A2 谓词归一**:`python/engine/normalize_relations.py`;真库改名 **1** 条(边 #40 `读于→就读于`,

**A4a 共现降级为证据层**:`python/engine/cooc.py`;真库写 **13** 行(same_memory 8 + same_day 5),

**A5 主题簇视图**:`python/engine/topics.py`;真库现行批次 `topic-1790882916`,**2 簇 / 14 主成员 + 1 软归属**;

**A7 面板与一键回退**:`GET /api/echo/graph-arch`(只读状态)+ `POST {action:'rollback',route,confirm:true}`;

**A8 评估**:`scripts/assoc-bench.py`(只读,无写开关;钉同一样本 + 同预算读数);

**图谱上的两个[…](2026-10-02;他:[…],选 A+B 分开关)**
- 为什么原来不显示:图谱只画**事实表**(他的话连出来的线);影子边住另一张表、是 3a 的**史**(冻结),
- **新东西**(`web/graph.html`):工具条两个独立开关 + 两把阈值滑杆;统计栏两个独立读数(**史 / 联想**);
  **默认关**(默认视图与以前一模一样),且不进力导向、不进束合并、**不算进[…]两个计数**。
- 数据侧 `graphData()` 纯增 `layers`(影子层 + 按对聚合的联想层,带 `nature` 与 `inRetrieval:false`);
- 新增 `tests/graph-layers.test.js` 10 个(纯函数从页面里抠出来跑);真浏览器实测:史 48/48、阈值 4 → 1/48、
- **没数据时不当哑巴**(他那天说[…]之后补的):引擎还没给这两层时,按钮写 `史:—` / `联想:—` 并变灰、
- **附带补闸**:`scripts/check-syntax.mjs` 现在也查 `web/*.js` 与 `web/*.html` 的**内联脚本**

**A3 证据债(只报表,等他还)**:`python/engine/evidence_debt.py`;现在非空 `kind` **0** 条;

**凭据账进面板(2026-10-02,他一句话定的通例:[…])**
- […]那一格新增**凭据债**一行:`活跃 N 条里 无依据 a / 仅推定 b / 有依据 c`,
- **通例升格**:凭据 / 证据 / 债 / 统计这类[…]一律**不进模型上下文**;
- 单测:引擎 `test_arch.py` 15(+1:面板的账与报表必须同源)· 面板 46(+1:含[…])。

## 未发布 · 主动开口 v2(P1+P2+P3)+ 阈值分类型(方案 A)(2026-09-30)

**第一批:打分器 + 时机闸(纯新增,不碰现有代码)**
- `lib/topic-score.js`(新,纯函数、零 IO、`now` 由调用方给):六维加权打分(未结性 / 信息
- `tests/topic-score.test.js`、`tests/timing-gate.test.js`。

**第二批:接线 + 台账 + 配置 + `echo_status` schema 修复**
- **接线**:`lib/heartbeat.js` 的 tick 里,打分器插在 `targetFor`/`daily-cap`/`pending-ack`
- **边缘区模型复核**(`lib/topic-review.js`,新):本地分落在 `threshold ± reviewDelta` 才花
  **一次**复核,受日额度 `reviewBudgetPerDay` 约束;**超时 / 失败 / 认不出 = 未过**(沉默),
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- **台账四列**:`care_beats` 加 `candidates` / `top_score` / `rejected_by` / `topic_id`;
- **`pending_threads` 加 `score` / `score_at` 两列** —— 这是 JS/引擎**共有表**,两侧必须同源
- **配置**:`proactiveScoring` 整组进调参面板(**扁平标量键**,四处连锁:默认值 / normalize
- **修 `echo_status` 的 schema(实测已坏)**:`careTrace()` 始终带 `targetSessionId` 而
- **阈值分类型(方案 A,用户拍板)**:新增三个扁平键 `thresholdArtifact`(0.60,日记/她的产出)
- 实测口径提醒(不是裁定,留给他决定):默认权重 + 72h 候选窗口下,**悬置话题**要 7 天左右才够

- 门:主仓 **1038/1038** · `npm run check` 0(含 BOM 闸)· `test:py` **358 OK**。

**第三批:P3 —— 主动开口文案规范 + 禁语哨兵 + 台账三列指标(2026-09-30)**

- **文案规范(正四条)**:`lib/heartbeat.js` 的 `renderCareFraming({ copyRules })` 给主动开口
- **禁语哨兵(HBS 六类黑模式)**:`lib/speech-guard.js` 新增纯函数 `checkProactiveCopy` +
- **台账三列只读指标**:`lib/care-report.js` 新增 `reply_rate`(她开口后他多久回,含中位秒)/
- **指标接上真入口**:`scripts/echoq.mjs`(=`npm run care:report`)只读取数喂
- **P3.1 三处小修(修误伤 / 修污染 / 接生产)**:
  - ① **收窄⑥[…]**:改成[…]**两个特征同时成立**才命中 ——
  - ② **指标排除被拦的拍**:`sent` 与 `copy-blocked` 落在**同一拍**(容差 `SAME_BEAT_SEC`)⇒
  - ③ 三列接到 `npm run care:report` 的**真实入口**(只读 SELECT,不改任何写路径)。
- 新增 `tests/proactive-copy.test.js`(A~F 段:六类各自咬得住 / 25 条正面样例全过 / 总闸默认关 /
- 门(本批重跑):主仓 **1038/1038** · `npm run check` 0 · `test:py` **358 OK**。

- **`lib/her-activity.js`(新)**:纯函数 + 落盘/读口一处。`planActivityTick` 按序判
- **接线 `lib/heartbeat.js`**:新一档排在省力闸⓪**之前**(排它之后等于永不唤醒:退避窗口
- **配置与面板**:`lib/toggle.js` + `lib/settings-fields.js` 新增 `herActivity` 五个**扁平标量键**
- **文案与归因**:`lib/care-report.js` 的 `REASON_TEXT` 补 `idle-done` / `budget-used` /
- 新增 `tests/her-activity.test.js`。

**同批:测试隔离修复(`npm test` 不再受真机配置影响)**

- **病灶**:真机 `~/.dsh/echo/config.json` 的 `settings.proactiveScoring.enabled` 是**活的**
  **共 20 条红**(经核对与 P4a 无关:HEAD `fbbd486` 纯净 worktree 的失败集逐条相同)。
- **修法两层(都不碰生产行为)**:
- 门:主仓 **1057/1057**(**三种情形**都实测:隔离空 HOME / 种子 `enabled=true` / 种子

**第五批:P4b —— 多活动类型(整理记忆)+ `check-bom` 放行 `.scratch/`(真机已开 herActivity)**

- **`kind` 允许值域 `diary` → `diary | memory`**(`lib/her-activity.js` 的
- **`memory` 这一类复用的是既有策展管线,零模型调用**:`lib/soul-snapshot.js`
- **`goal`(给自己立小目标)这一批不做** —— 查实后**没有**可复用的产出管线:agenda 项的
- **额度语义:多类型**共用**一份日额度**(不按类各一份)。理由:`budgetPerDay` 的语义是
  **各类型共用一份**(`pruneActivityFiles`):总量封顶才是[…]的本意。
- **候选 id 升级**:`note:` + **文件名主干**(`note:日记-2026-09-28` / `note:整理-2026-09-28`)。
- **台账**:reason 词表**一个没加**(沿用 `idle-done` / `budget-used` / `already-done` /
- **`check-bom` 放行 `.scratch/`**(`scripts/check-bom.mjs` 的 `SKIP_DIRS` 加一项):草稿区
- **配置与面板**:`herActivity` 五个键形状不变(仍是扁平标量键,README 项数不动),`kind`
- **真机**:`~/.dsh/echo/config.json` 的 `herActivity.enabled` 已按批准的写入路径
- **测试隔离补洞(③ 的必然连带)**:真机 `herActivity.enabled` 置 `true` 之后,`tests/her-activity.test.js`
- 门(本批重跑):主仓 **1066/1066** · `npm run check` 0 · `test:py` **358 OK**。

## v0.43.3 · 深色模式下设置卡"一片空白"的根因:两个用法错误 + 一个死变量(2026-09-29)

- **① 反相填充色上写死了白字**:`.echo-btn-primary` 是
  #FFFFFF)`(正是它的对比色,DSH 自己的保存按钮就这么配)。
- **② 变量名根本不存在**:`--dsw-alias-interactive-bg-hover-info` 与
- 同类问题一并修掉(同一根因,不同面板):`.echo-badge`、`.echo-chip`、
- 教训(值得记住):**用了带兜底 hex 的 CSS 变量时,[…]恰恰会掩盖[…]**;
- `npm test` 933/933、`npm run check` 0(含 BOM 闸)。改的是 client bundle

## v0.43.2 · 审计流改成**主从两栏**(治"拥挤"是结构问题,不是配色问题)(2026-09-29)

- **主从两栏(master–detail)**:日志/活动流界面的通则(Gmail / Sentry / Vercel /
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
  - **右栏 = 那一轮的全部**:气泡([称呼] / Echo / 提取器)、后台调用(一行一条人话)、
  - 窄屏 <980px 自动上下叠(索引在上、详情在下),<760px 标签列挪到气泡上方。
- **三条硬规矩(写进 CSS 注释,防再犯)**:① 承载文字的弹性列必须有 `min-width`,
- **交互**:点左栏任何一轮 → 右栏换成那一轮;右栏默认**展开**(信息不需要[…]),
- 主包 **933/933**,`npm run check` 0;`web-dashboard.test.js` 的详情类断言改为查

## v0.43.1 · 审计流重做:分层 + 三档密度 + 人话(信息一条不删)(2026-09-29)

- **新文件 `web/audit-view.js`(纯逻辑,零 DOM)**:分类(桶 = 对话/她主动/提取/干活/
- **三档密度是同一份数据的三副面孔**(不换数据源):`对话优先`(后台折进轮脚下)、
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- **时间分层**:今天用相对话(刚刚 / 12 分钟前),跨天加日期分隔;窗口只有最近 N 行时
- **展开区最后永远附一份原始审计行**(默认收起):平时不占地方,查账时一行不少。
- 测试:主包 **933/933**(新增 `tests/audit-view.test.js` 13 条:分类/折轮/分组/统计/

## v0.43.0 · 一条对话线:QQ 跟着他在用的那条会话走(顺带修三个静默洞)(2026-09-29)

### A · 路由:QQ 进「他正在用的那条会话」(`lib/companion-target.js` 新)
- 判据四条(全都要成立):**活着**(宿主里 agent 还在,否则注入不进去)、
  **顶层**(不是子代理会话)、**在范围内**(面板上被他关掉的不算)、
  **他最近在里面说过话**。多条成立取最近的一条;挑不出来 ⇒ 退回 `ensureCompanion()`
- 挑选是**纯函数**(可离线测):`pickHisSession()` / `describeRoute()`。
- 入站的渠道绑定跟着改绑(`relayUpsertChannel` 记的就是他这条 ⇒ 回复知道往哪儿去);
- **安全取舍(写进账里)**:目标是**他自己在用的窗口**时**不降权** —— 那道
- 调参项 70 → **71**(`followHisWindow`);README 两处数字同步。

### 洞① · `recentUserTurnAt` 恒为 0(两条判据一起静默失效)
- **现场**:判据是 `audit_logs WHERE tool_call='' AND user_input NOT LIKE '(%'` ——
- **改法**:改读 `conversation_log`(每真轮一行:`session_id` + `created_at`,
- 修完实测(`.scratch/diag/verify-route.mjs`):QQ 会进

### 洞② · 她亲手送出去的关怀,待兑现账永不兑现
- **现场(18:24)**:心跳 18:24:09 记了一笔[…](`pendingCare`),她随即用
- **改法**:壳在她开口那一刻同时给出口侧打标记(`speaker.markProactive(sid)`,

### 测试
- 新增 `tests/companion-target.test.js`(8 例:最优先 / 陪伴会话不参与 / 关掉的不算 /
- JS **920/920**、`check` 退出 0、python 358 OK。

## v0.42.0 · 全仓审计:修掉 12 处真错(记忆静默丢失 / 幂等失效 / 防线形同虚设)(2026-09-29)

### P0 · 记忆会**静默消失**(`lib/store.js:insertMemory`)
- **现场**:换代走的是「先把旧行标 `is_active=0, superseded_by=-1`(表示[…])
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- **负控已复现**:同一场景下旧写法 `is_active=0 / superseded_by=-1 / 不在召回池`,
- **改法**:① 顺序翻转 —— **先插入新行拿到真 id,再用一条语句把旧行下架并回填**;
- 回归:`tests/store.test.js` 新增「新行写不进去 ⇒ 旧记忆必须还在,且不许留

### P1 · 被关掉的主动开关会被**静默写回**(`lib/relay.js` 入站第 ⑧ 步)
- 那里原来写死 `proactive: true`,而这条渠道登记**每条入站都跑一遍**,store 的

### P1 · 入站幂等表:回滚删行 → **重复投递**(`lib/store.js` relay_inbox_seen)
- `relayRollbackInbound` 原来是 `DELETE`。另一次重试**已经接管**之后,第一次尝试再
- `relayCommitInbound` 原来无条件 `return true` → 现在查 `changes`,对不上账如实报
- `staleSec` 默认 60 → **300**:她跑一轮长任务十分钟是正常状态(文件里自己这么写),
- 残留(留作讨论):两次尝试都活着且都在 300s 之上时,迟到的回滚仍会清掉接管方的

### P1 · 硬开关**没有调用方闸**(`lib/power-tools.js` + `lib/context-clear.js`)
- 两只手全局注册 ⇒ 任何会话的 agent、以及**子代理**都看得见:一条子代理就能
- 现在判据复用 `lib/agent-scope.js`(与 0.41.0 的子代理递归闸**同一份**):子代理一律

### P1 · sidecar 的帧长防线**形同虚设**(`lib/sidecar-client.js:_onStdout`)
- 长度检查原来在 `while` **循环里面**,只看[…]。而真正要防的
- 新增 `tests/sidecar-frame-guard.test.js`(**不 spawn 进程** —— 沙箱里 spawn+管道会

### P1 · 工具审计里「成没成」永远是 unknown(`lib/tool-audit.js:resultOf`)
- 原来只认 `ok` / `success` / `error`,而**宿主给的结果形状是 `isError: boolean`**

### P1 · 装机脚本会**递归删源码**、还会把装机位删空一半(`scripts/install.mjs`)
- 加**源==目标**守卫(`realpath` 判定,含互为父子):`DSH_HOME` 指错时拒装。
- […]→ **先拷到 `*.incoming` 临时位 → 跑相对 import 自检 →
- `JSON.parse` 换成 `parseJsonOrThrow`(人话的错误);并**剥前导 BOM** ——

### P1 · `scripts/check-syntax.mjs`(新增):语法自检改成**遍历**
- 原来 `package.json` 的 `check` 是一长串手写的 `node --check <文件>`:漏了 lib/ 下
  **8 个模块**(新文件永远不被检查),而且 `lib/diary.js` **重复两次**。

### P1 · Python worker 被一个坏字段**打死**(`python/worker.py`)
- 每个 handler 各自 `int(frame.get([…]) or 6)` / `float(frame.get([…]))`:一个
- 两层防线:① 入口 `_coerce_numeric()` 把已知数值字段归一(坏值丢掉 ⇒ handler 走
- 负控已复现:同一条坏帧在旧代码下 `exit=-1`(traceback),修好后正常回

### 打包与版本号
- `package.json` 的 `files`:`python/` 整目录白名单会把 `python/tests`(12 个测试 +
- 版本号**只留一份真源**:`dsh-echo-qq` 的 `lib/index.js` 原来写死 `'0.1.2'` 而

### 本轮**没做**的(留作下一轮,理由写在这里免得被忘掉)
- **Python 引擎其余 P1**:`db.py:connect` 每次调用都 `executescript(_DDL)` + 全套迁移
  **为什么没做**:这些必须靠 `npm run test:py` 验证,而这台机器的沙箱里 python 的
- **P2 一批**:`relay_outbox` / `pending_threads` 没有清理口;出站队列租约缺少 CAS;

### 他当场裁掉的一块:「会话范围」卡撤出设置区(2026-09-29)
- 他说:[…]。撤的是**设置区里那张卡**
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- **撤 UI 不等于拆功能**:后端一行没动(`/api/echo/scope` 端点、`toggle.js` 的
- 按本仓纪律,撤掉的卡进 `tests/client-render.test.js` 的 `REMOVED_CARDS` 名单:

### 他的第二个问题:「每次对话都产生一个子代理,时间长了会不会卡」(2026-09-29)
- 复查结论:**不会攒**。每个结构化调用(同轮情绪打分 / 查询扩展 / 轮末整固,2~4 个/轮)
- 但**真正随时间线性长的是行流水**:`care_beats` 每拍一行(实测 10.3 小时 153 行,
  - **在途的话一条都不许删**:`acked_at = 0 且 dropped_at = 0` 的 outbox 行是
  - 回归:`tests/history-prune.test.js`(老的走/近的留、在途不动、幂等不抛)。
- 还欠两条(下一步,登记在此):①`echo.db-wal` 3.95MB > 主库 1.11MB

### 验证(本机)
- `npm run check` 全绿(61 模块 import 冒烟 + 95 文件语法 + BOM 闸 + 工具契约)。
- JS 逐文件:**81 个文件,6 个环境性失败**(`engine/preflight/probe/rehearse/retire/sidecar`
- 硬开关 13、relay 60、store 34、tool-audit 15、sidecar 帧长 3、split(qq)8 —— 全过。

## v0.41.0 · 事故修复:子代理无限自我增殖(情绪单轮闭环的递归)(2026-09-29)

### 现象与证据链(逐环都在宿主源码里,不是推演)
1. 他开口 ⇒ 宿主发 `agent/inbox/claimed`。这个事件是**按 agent 派发**的
2. 子代理的初始任务是走 **inbox** 投递的,而且信封写死 `source: { kind: 'user' }`
3. 打分提示词(`emotion-score.js` 的 `scorePrompt`)开头是「你只做一件事:读下面这句话
4. `createSameTurnScorer.begin()` 当时**只看 sid 非空** —— 没有范围闸、没有深度闸
   **真 LLM 调用**;再叠上子代理轮末那条反思路(`fireReflect` 也从子代理里再起

### 修法:一份判据,三道边界
- **新增 `lib/agent-scope.js`(纯函数,可离线测)**:`isSubagentSession(subject)` 只认
  **认不出来一律当顶层**(老会话、测试替身、非宿主对象不许被误伤)—— 代价不对称:
- **① 捕获边界**(`session/event`):子代理会话一律不往下走 —— 不捕获、不记漂移窗、
- **② 起子代理的边界**:`reflect.js` 的 `runStructured`(**所有**结构化调用的总闸:
- **③ 路由边界**(`agent/pre-step`):`routeAgent`(日记/体检的 parent)只认顶层会话,
- **第二层(防线,不是主修)**:`inbound-filter.js` 的 `INTERNAL_PROMPT_OPENINGS` 补

### 验证
- 新增 `tests/agent-scope.test.js`(6 条:三种形状、三个字段、代价不对称的两侧、多层委派);
- 新增 `tests/subagent-recursion.test.js`(**把闭环真搭出来**:宿主替身起子代理 ⇒ 让
- `tests/emotion-score.test.js` +3、`tests/reflect.test.js` +2、`tests/diary.test.js` +1、
- **顺手补上一道早该有的闸**:状态面 schema 是 `additionalProperties:false`,`sameTurnEmotion`
- `npm run check` 全过(真调用冒烟 61 个模块 import);`npm test` 与改动前同一批

### 给他的一句操作说明

## v0.40.0 · 批次 C 批(C5 · C2 · C1 · C3+F4) + G5 + RT9 + 一次真实事故（2026-09-28 夜）

### C5 开口前的过期失效检查(出处 Mio `proactive_service.py:588-592`)
- **两条判据分开**(她的闹钟与他下的命令是两回事):
- **作废也落账**:`care_beats` 里出现 `stale-drop`(文案表加了一句人话)、闹钟标
- ⚠️ 单测抓到的坑:第一版把阈值规整写成 `Math.max(0, Number(v) || 0)`,门槛填乱值 ⇒

### 事故:fatal load failure(`ReferenceError: ticking is not defined`)
- **现象**:2026-09-28 夜他重启 dsh ⇒ 插件加载即崩,他的 dsh 起不来。
- **根因(我们的错,不是环境的)**:我挪代码时按行切块,把一段文档注释的
- **为什么没被拦住**:`node --check` 只查语法,**注释吞掉半截函数体它完全看不出来**。
- **修**:恢复文件结构 + **新增真调用冒烟** `scripts/smoke-lib.mjs`(挂进 `npm run check`),
- 附带发现:`npm test` 会**永远挂着不退**(`tests/sidecar.test.js` 跑完全过却留下句柄)——

### C2 思考风格双档(出处 `dsh-cosplay` 的 `THINKING_DIRECTIVES`,`store.js:142-145`)
- **干活那一步**给她一行:[…];`echo:thinking` 段排在
  **最后**(order 10278,晚于语域规格 10275);
- **聊天轮一个字不加**(渲染空串) —— 这一条是照着本仓的疤设计的:2026-09-26 那条被撤掉的
- 判据来自 B1 的钩子:`toolAudit.turnTools(sid)`(本轮用了几件**宿主**工具;她调 `echo_qq_say`
- 开关 `thinkingNeutralWhenWorking`(默认开,关掉 = 回到今天的行为)+ `thinkingNeutralMinTools`(默认 1)。
- 诚实标注:`dsh-cosplay` 作者自认系统提示位弱于训练位、且概率触发 —— 这条**不保证**她切档。

### C1 情绪单轮闭环(出处 pad-emotion `index.js:833-846`,异步 waterfall + `Promise.race`)
- **要修的实况**:情绪向量是**轮末**由提取调用写的(`extract_commit` 里的 `emotion_score`),
- **做法**:他开口那一刻(`agent/inbox/claimed`)并起一次**很小的**打分调用(`lib/emotion-score.js`),
- **关键发现(省掉一整条 Python 改动)**:心情那一行是 **JS 侧**渲染的
- **三条自律**(都写进了模块注释):
- 开关 `emotionSameTurn`(默认开)+ `emotionScoreTimeoutMs`(默认 800ms,坏值回落默认);
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
  **payload 加字段必须同步声明 schema + 同步一个模块级读取器** —— 三件事少一件就炸。

### RT11 零依赖语义臂(第一刀:同义词/别名 **捞人**机制 + 量台对照)
- 引用/致谢见 `ACKNOWLEDGMENTS.md`

**读数(同快照,ON vs 基线):总分 82.6% ↔ 82.6%,逐档一模一样(N1 75 / N2 60 / N3 75 /

* 表里只有 **19 个词元**,而金标 48 条问的是[…],这些词**不在表里**
* 也就是说,这一跑量的是[…],不是[…]。**表太小,不给结论。**
* 计划 §3.5 那句[…]——后半句今天还是空的。

**下一刀的判据(先定好,免得事后挑数字)**:先量[…](rescue 计数)。
### 装机事故与复原(2026-09-28 夜):他把 echo 从 dsh 卸了
**DSH 起得来,她不会被挂载**。
1. `dependencies` 补 `[…]: […]`、
2. 补源码区 `node_modules` junction → `profiles/node_modules`(**link 装机解析宿主包必须它**,
3. 官方自检:`Verified dsh-echo@0.40.0`(webpage 接线、宿主包解析、bundles、dependency 四项);
4. **加载前预检**:`dsh --profile web --dump-config`(不启服务)⇒ exit 0,
5. `--doctor`:[…]预设也在」—— 无警告。
### RT11b 查询扩展臂:**让大模型解语义**(他一句话把路扳正)+ 实测诊断

**实测(用模型真产出 29 条问句 × 174 个词元,平均 6.0/句,无 id 无编造)**:

**诊断(这条比[…]重要)**:机制本身有结构性问题 —— 我把扩展词元**加进同一个查询词元集合**
### RT11 第一刀的**诊断**(判据先定、再量):838 问,捞回 **0** 条

**所以[…]这个问题,今天仍然没有答案** —— 不许拿这一跑去支持

### C4 话题去重惩罚(第一刀:纯惩罚器 + 单测)· 出处:Mio `:379-432`

* 它和 `matchOpenThread`([…])**不是一件事**:合并管[…],惩罚管[…];
* **不许沾边就罚**:[…] vs […] 共享高频残片,但换个说法提同一件事

**没接线**:惩罚器还没接到[…]那一步(那一步挑错会让她该说的不说,得单独一刀 + 单测)。
### RT10 第三刀:**拆开量** —— 两半都伤,伤在不同的档(结论:整条路否掉,不只是调阈值)

| 路 | N1 | N2 | N3 | N4 | N5 | N6 | 总分 |
|---|---|---|---|---|---|---|---|
| 基线(默认关) | 75.0% | **60.0%** | 75.0% | 100% | **100%** | 100% | **82.6%** |
| 只重排(reorder) | 75.0% | 60.0% | 75.0% | 100% | **66.7%** | 100% | 78.3% |
| 只过门槛(gate) | 75.0% | **40.0%** | 75.0% | 100% | 100% | 100% | 78.3% |
| 两件一起(both) | 75.0% | 40.0% | 75.0% | 100% | 100% | 100% | 78.3% |

**两半各自都掉一条,但掉在不同的档**:
* **门槛**砍掉的是 N2 多会话(60→40):散在多条会话里的同一件事,单条覆盖率本来就低,
* **RRF 重排**砍掉的是 **N5 矛盾(100→66.7)** —— 这条更有意思:**RRF 奖励的是"各臂排名

**这给 RT11 的启示**:第三臂不该是[…](那只会把 N5 那类[…]再稀释
### RT10 第二刀:接进生产主路径 + **量台对照**(结论:**没过,默认继续关**)

**同快照对照(2026-09-28 夜,活库只读快照)**:

| 路 | N1 | N2 | N3 | N4 | N5 | N6 | 总分 |
|---|---|---|---|---|---|---|---|
| 基线(默认关) | 75.0% | **60.0%** | 75.0% | 100% | 100% | 100% | **82.6%** |
| 融合 ON(enter 0.50 / exit 0.35) | 75.0% | **40.0%** | 75.0% | 100% | 100% | 100% | **78.3%** |

1. **伤在门槛,不在 RRF 重排**。N2 的题是[…],每条覆盖率都不高(0.2~0.4),
2. **验收基准要重报**。计划里记的 86.2% 是**更早快照**的数;今天同一条活库上基线是 **82.6%**。
### RT9 检索账本(先做仪器)+ 金标续命(只读矿工)
- 引用/致谢见 `ACKNOWLEDGMENTS.md`

- `lib/retrieve-ledger.js`(新,环形缓冲 50 问):每一问记**臂分解** —— 每条候选的
- 三条纪律写进模块头:① **只记不判**(不改排序、不改阈值 —— 账本不是闸门);② **不落库**
- 接线:`lib/engine.js` 两条路(python/baseline)各推一条;`lib/index.js` 造账本、传 engine、
- `scripts/retrieve-audit.mjs`(新,**只读**矿工):拿真机 62 轮 × 197 条活跃记忆反问一句

### C3 出站清单(禁词 / 防重复)+ F4 插入优先级四档
- 引用/致谢见 `ACKNOWLEDGMENTS.md`

**只抄其中一件,理由写在 `lib/speech-guard.js` 顶部** —— 上游那三段是**小说文风指令**
**短气泡**,那些病症她不会犯,而当**注入段**贴上去正好会重演 09-26 那场事故(尾部每轮

- **禁词**:默认表从上游 `:106-108` 取**通用小说腔 + 生理学腔**(一抹/弧度/不容置疑/
- **防重复**:跟她**自己最近 3 句**(`relay_outbox` 已发的气泡)比,字符二元组 Jaccard
- **默认动作一律 `flag` = 照发 + 落账 + 把理由告诉她**。上游那份清单是**硬禁**的,我没照抄
- **工具面**(验收条款 `PLAN_LAND_ALL.md:230`):她自己动手调 `echo_qq_say` 时也过一遍清单,
- **F4 四档**:`low`=等她说完成 / `medium`=尽快说完当前泡 / `high`=缩短她剩下的泡 /
- 清单全进 `settings`(**不硬编码**):`bannedWords`(留空 = 用默认表) / `bannedAction` /

### 探针纠错(顺手)

## 未发布 · 批次 F3:preset 生成标记 + 他手改过的部分不许被升级盖掉（2026-09-28 夜）

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

- **`generated-by` 标记**：`preset.yml` 顶部多一行 `# generated-by: dsh-echo@0.39.0 at …`
- **生成清单 `.echo-generated.json`**：记下版本、时间、逐文件内容与 sha256 指纹；
- **升级先看清单**（`checkUpgrade`）：指纹对得上才写；对不上就**停下来报出是哪几个文件动过**，
- `--check` 顺手多看一眼元数据与清单：`name:` 那行被注释掉、标记缺失、指纹不符都会说出来；
- **一次性的**：他现有那份预设没有清单，所以第一次重跑会停一次 ——

**真机演练连抓两个 bug**（单测没抓住、`--check`/演练抓住了 ——所以这一步不能省）：

- 测试：`tests/preset-generated.test.js` 8 条；`lib/preset-patch.js` 进 `check`。
- 门：主仓 **792/792** · `check` 0 · `test:py` **305 OK** · `hygiene` 报告无问题。版本 0.38.0 → 0.39.0。

## 未发布 · 批次 F1+F2:外部事件入口 + 日记缺口补写（2026-09-28 夜）

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

- **只做一件事：排一个到点的 wake**，投递/夜闸/留账全走 P2 已经建好的那条老路 ——
  **绝不新开第二条投递链**（第二条链就是第二个[…]的地方）；
- **默认关**（`externalWake`，fail-closed）：关着就 `403 external-wake-off`，
  **绝不静默收下**（他以为门开着才是最坏的情况）；
- 写闸与其它写口同一道（回环 Origin + `x-echo-edit: 1`）；
- 时间认不出**就拒收**（猜错就是半夜把她叫起来）；过去的时间 = 立刻响；
- 新探针 `scripts/accept-wake.mjs`：**默认只读**（门与账在不在），加 `--post` 才真敲门。

- ① **错过就是永远**：`diaryDue` 只问[…]—— 22:30 那拍
- ② **连败刷屏**：组稿失败后下一拍（60 秒后）又试，引擎通宵不在就通宵每 60 秒试一次，

- 调参 54 → 55 项（+`externalWake`）；测试：`diary-backfill` 9 条 + `external-event` 9 条。
- 门：主仓 **784/784** · `check` 0 · `test:py` **305 OK** · `hygiene` 报告无问题。版本 0.37.0 → 0.38.0。

## 未发布 · 批次 G2+G3:改名后旧记忆不重贴 + 降级要说话（2026-09-28 夜）

**G2 旧称呼**（`lib/alias-rewrite.js` + `lib/turn-snapshot.js` + `lib/engine.js`）：

- **改名那一刻自动记下旧名**（`createEngine` 新增 `onNameChange` 依赖 →
- 注入前把**记忆**那一块里的旧称呼改写成现在的称呼：保守替换（≤2 字不换、
- **只动记忆那一块** —— 共享轮次/他的原话/她的残句一个字不改：改历史就是把记录

**G3 降级要说话**（`lib/turn-snapshot.js`）：注入被裁光/引擎降级以前是**静默少一段**。

- 调参新增 `retiredAliases`（53 → 54 项，README 数字同步）；面板多了[…]一组。
- 测试：`tests/alias-rewrite.test.js` 6 条 + `turn-snapshot` +4 条（G2 改写只动记忆 / G3 两种降级 / 引擎好时一个字不多）。
- **顺手补的两件（都不是本批要求的，是这轮踩出来的）**：
  1. **`scripts/check-bom.mjs`（新的闸，进 `npm run check`）**：这轮我用 PowerShell 的
  2. **`python/tests/test_ddl_parity.py` 的 JS-only 名单补 `care_beats`/`echo_wakes`**：
- 门：主仓 **766/766** · `check` 0（含 `check:tools` + 新 BOM 闸）· `hygiene` 报告无问题 · `test:py` **305 OK**。版本 0.36.0 → 0.37.0。

## 未发布 · 批次 B2:一轮一个 trace（2026-09-28 夜）

**现场**：`audit_logs.trace_id` 一直是**每行一个随机 uuid**（`lib/reflect.js:347` 与各处），

- **`lib/turn-trace.js`**：一次[…]= 一轮 ⇒ `begin(sid)` 换一个新 trace；
- **工具行跟着走**（`lib/tool-audit.js` 的 `traceOf`）：工具调用与他的那句话、
- **耗时配对量**：新挂 `tools/pre-execute`（只记开始时间，**不改 decision**），
- **她的回复那一行**也接上：`index.js → engine.reflect → commitExtract` 传 `traceId`。
- **TTL 兜底 30 分钟**：他走了、会话挂着不动，旧 trace 不许把几小时后的一轮并进来
- **探针** `accept:observe` 加一问：`trace_id` 下**挂了多行的轮**（B2 生效的直接证据）。
- 测试：`tests/turn-trace.test.js` 8 条（换轮/会话隔离/过期/forget/工具行跟 trace/
- 门：主仓 **756/756** · `check` 0 · `hygiene` 0。版本 0.35.0 → 0.36.0。

## 未发布 · 批次 B3+B4:轮内不变快照 + 反思留痕（2026-09-28 夜）

**B3 轮内不变快照**（`lib/turn-snapshot.js`）：宿主**每一步**都组装一次系统提示词，

**B4 反思留痕**：计划里要挂宿主 `subagent/start|end` —— 装机包实测那两个名字只在
**失败也进状态面**（宿主日志会被刷走，[…]必须有地方能查 ——

- 状态面新增 `reflect`，schema 同步声明（含 `oneOf` 兼容 null）；`echo_status` 多一行。
- 探针 `accept:observe` 增加 B4 两问（字段在位 / 不是[…]）。
- 测试：`tests/turn-snapshot.test.js` +5 条（多步只检索一次 / claim 必重算 /
- 门：主仓 **748/748** · `check` 0 · `hygiene` 0。版本 0.34.0 → 0.35.0。

## 未发布 · 批次 B5:干活时不插话（2026-09-28 夜）

- **判据**:`store.recentToolCallAt(sid, 300s)` —— 5 分钟内这个会话有过工具调用
- **位置**:心跳 tick 的 ⓪-a,和空拍退避同在 ⓪ —— **在 ①（他的提醒）与
- **留痕**:落 `care_beats.reason='working'`,与 `backoff` **分开写**
- **开关**:`quietWhileWorking`(默认 **on**;面板[…]里多一项,
- 测试:`tests/care-beats.test.js` 加两条 —— 干活闸挡住引擎的 `shouldCare: true`;
  **干活期间她的闹钟照样响**;开关关掉 ⇒ 照常开口。
- 门:主仓 **743/743** · `check` 0 · `hygiene` 0。版本 0.33.0 → 0.34.0。

## 未发布 · 批次 B1:全量工具审计（2026-09-28 夜）

- **`lib/tool-audit.js`**:挂在 `tools/post-execute` 的 waterfall 上,**只观察** ——
- **闸位与注同心跳同一把尺**:电源关 / 会话射程外不记(**计数**,不是悄悄丢);
- **失败不许静默**:写库炸 ⇒ 计入 `failed` + 只 warn 一次,状态面 `toolAudit` 报出去。
- 状态面新增 `toolAudit`(`seen/written/skippedPower/skippedScope/ownSkipped/failed/byName`),
- **真机探针** `npm run accept:observe`(只读):看状态面统计 + 活的审计表里有没有
- 顺带用只读查询验到活的账:今天 `wake-sent @14:24`(她自己排的闹钟**确实响过**)、
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- 门:主仓 **741/741** · `check` 0(含 `check:tools`)· `hygiene` 0。

## 未发布 · 批次 A0+A1a:宿主兼容闸 + 注入探针（2026-09-28 夜）

**不改任何注入行为**：

- **A0 兼容闸**（`lib/compat.js`）：启动时**探一次**宿主的 `systemPrompt` 挂点
- **A1a 注入探针**（`lib/inject-probe.js` + `scripts/accept-inject.mjs`）：量"我们注入的块
  **为什么先量再搬**：`lib/index.js:1340-1346` 记着上一版做法（快照当 user 消息 append，
- 状态面新增 `compat` / `inject`，**schema 同步声明**（含 `oneOf` 兼容 null）——
- 测试：`tests/inject-probe.test.js` 11 条（兼容闸缓存/日志一次、非函数算没有、
- 门：主仓 **727/727**、`check` 0（含 `check:tools`）、`hygiene` 0；
- 版本 0.31.0 → 0.32.0。

## 未发布 · P2:空拍退避 + 一拍一账 + 她自己的闹钟(2026-09-28 下午)

- **B3 心跳报事实 + 指数退避**(`lib/heartbeat.js`)
  - 关怀 framing 多一行 `[事实] 从他上次说话到现在:…`(借 Cortico `heartbeat.ts:84-86` 的
  - **空拍退避**:`CARE_BACKOFF = {baseMs:60000, factor:2, maxFactor:8}` ⇒ 安静越久判得越稀
  - 状态面多四个字段:`kind / acted / quietStreak / nextPollAt / writeFailed`。
- **A5 关怀账**(`lib/store.js` + `lib/care-report.js` + `scripts/echoq.mjs`)
  - 新表 `care_beats(at, kind, reason, value, threshold, should_act, acted, session_id, trace_id, payload_json)`
  - 查询口:`npm run care:report`(= `node scripts/echoq.mjs --since 24h`;认 `7d/90m/30s/ISO`,
- **B4 她自己的闹钟**(`lib/wake-tools.js` + `echo_wakes` 表 + 心跳里的 `wake` 通道)
  - `echo_wake`(多久之后 / HH:MM / ISO + 她写下的原话)/ `echo_wake_cancel`;
    **闸门现状事前声明**给她看(今天开口几次、夜闸压没压住、夜里会被压到早上)。
  - 闹钟**存本地库、心跳直接读**:引擎/适配器不在也照样到点(45 小时那次的病根就是这个)。
  - 到点那一拍按 `form='wake'` 注入 ⇒ `relay.js` 白名单加了 `wake`(不加就是[…])。
- **优先级阶梯(写死并已测)**:电源闸 > 会话射程 > 夜闸 > 她的闹钟 > 想念关怀;
  **日上限只管想念关怀,管不着她的闹钟**;夜里压住的闹钟**不消耗**,早上第一拍放行;
- **顺手抓到的真事故**:`echo_status` 的 payload 从 v0.30.2 起就带 `care` 而 schema **没声明**
- 测试:主仓 **714**(新增 `tests/care-beats.test.js`、`tests/care-report.test.js`);
- **真机验收口**:`npm run accept:p2`(`scripts/accept-p2.mjs`,只读)—— 四项:状态面版本 ≥ 0.31.0、
- 附:两个**行为**开关(面板[…])—— `heartbeatBackoffEnabled`(关 = 每分钟都判)、
- 版本 0.30.2 → 0.31.0。

## 未发布 · 她的会话随嘴常驻 + 关怀留痕(2026-09-28 早上)

- **根因**(`lib/index.js` 常驻块):v0.30.1 修[…]时把常驻写在
- **修法**:门进函数体 `startResident()`(幂等),启动判一次,
  **`speaker.onRegistered(startResident)`** 嘴一出现再判一次 —— 与昨晚
- **关怀留痕**(`lib/heartbeat.js`):这条通道静默了 45 小时,理由只喊在宿主
- 测试:`tests/heartbeat.test.js` +4(留痕四种卡点);`tests/companion-resident.test.js`
- 版本 0.30.1 → 0.30.2。

## 未发布 · 旧桥**完整退役**(2026-09-28)

**内核一个字没改**:`parseEnvelope / handleInbound / lease / ack / setChannel` 全在,

- **删掉的传输面**:`/api/echo/relay/{inbound,outbox,ack,channels,channel}` 五个
  **401 这个失败模式从此不存在**(没有令牌可错了)。
- **退役后的门(唯一判据)**:`mouthOpen()` = […]
- **归档(不是删除,git 历史里 `--follow` 追得到)**:`archive/astrbot_adapter/`
- **没动的**:记忆迁移工具(`import-astrbot`/`merge-astrbot`/`rehearse-migration`/
- 回滚:旧桥的代码在这一条提交的父提交里(`git show <父提交>:lib/index.js`),

## 未发布 · S3-a 补一个字段:`lease`(2026-09-28)

- `lib/index.js`:S3 服务块加 `lease: (opts) => relay.lease(opts)`;契约注释补上这个字段,
- `tests/relay-service.test.js`:钉住 `lease:` 字面量与 `relay.lease` 接线(改名/删掉立刻红)。
- `docs/QQ_BRIDGE_DIY_PLAN.md`:S3-a 记录补这个缺口;§7 进度更新(装机侧已完成)。

## 未发布 · 接缝 + 服务端(S1 · S3-a)(2026-09-27/28):核心只认"嘴",并把"嘴"提供出去

- **S1-a** 新增 `lib/speak.js`:渠道无关的嘴。`transport` 今天 = 桥,`captureSegment` / `finishTurn` /
- **S1-b** `lib/index.js` 六处硬缝换到 `speaker`:出站捕获/收尾、送到回执(`onAcked` →
- **S3-a** 新增**服务提供端**:`ctx.provide('echo:relay', …)`,形状以消费端为准 ——
- **跨插件 DI 实测**(不是猜的):插件 fiber 里 provide 的值落在 root store,**兄弟 fiber 读得到**;
- **S3-b 前半:切换点那道门**。旧的 `relayEnabled()`(旧桥总闸 + token)换成 `mouthOpen()` ——
  **旧桥总闸 或 有渠道插件自报家门**;没插件注册时逐字等价 ⇒ 现有部署行为不变,插件一注册
- **门槛**:单测 651 → **672**;python 305 OK;`npm run check` / `node scripts/hygiene.mjs` 均 0。

## 未发布 · 搬家(2026-09-27):插件源码进 `~/.dsh/plugins/`,装机形态改成 link

**住址**:`$env:USERPROFILE\source\repos\dsh-echo` → **`$env:USERPROFILE\.dsh\plugins\dsh-echo`**

**装机形态**:`file:./.dsh-echo-local/*.tgz`(复制) → **`link:$env:USERPROFILE/.dsh/plugins/dsh-echo`**;

**搬家中查出的真雷(已堵)** —— 正是 v0.1.0 崩过的那条:Node 会把 junction **还原成真实路径**,

**`scripts/install.mjs` 两处改动**(否则这次搬家会被一次习惯性操作悄悄回退):

| 改动 | 为什么 |
|---|---|
| `verify()` 新增一条:link 装机时,**源码区往上 8 级内必须有含 `@deepseek-ai/dsh-tools` 的 `node_modules`**,缺了指名报错 + 给出修法 | 否则那条雷在场时[…]照样全绿(假绿) |
| 默认运行在 link 形态下**退化成只校验**(打印 link 目标 → verify → 退出) | 老流程[…]在 link 形态下会先摘 junction 再复制一份 ⇒ 等于回退搬家 |

**反证验过**:把插件区 junction 挪走 → `--check` exit 1(指名 `New-Item -ItemType Junction …` 与目标);

**核验**:node **651/651**、python OK、`npm run check` exit 0、`hygiene` exit 0、

---

## v0.30.1 — 2026-09-27(**中午起来,她为什么一句都没说**)

### 他:「那么我们来研究一下,为什么今天中午我起来的时候发现他没有主动给我发消息呢?」

**时间线(内核电源事件 + 进程启动时间 + 审计表):**

| 时刻 | 发生了什么 |
|---|---|
| 02:47 | 他最后一句 QQ[…]。想念值 ≈ 0,锚点 02:47,锚定会话 = 陪伴会话 |
| 02:50:04 | **电脑进入睡眠**(内核电源事件 42)—— dsh web、适配器全部暂停 |
| 09:47 | 想念值按 M(s)=10s/(s+3h) **恰好越过阈值 7.0**(沉默 7 小时)—— 此刻没有任何进程在跑 |
| 10:31:24 | 电脑唤醒(电源事件 107) |
| 11:54:02 | dsh web 启动。惰性补差后想念 **7.52,仍过线** |
| 12:47:52 | 开发会话恢复,宿主的换模型通告混进管线 |
| 13:07:04 | 他发[…]—— 陪伴会话 agent 这时才第一次被创建;消息本身把想念削到线下 |

**缺陷①(主犯):陪伴会话是懒创建的。** `ensureCompanion()` 全仓只有

**缺陷②(帮凶):宿主注入冒充[…]。** `longingMessage` 在

**缺陷③(物理,数学已经备好补救):电脑睡觉 = 她也睡觉。** 09:47 越线

### 防重复开口(缺陷①的伴生护栏)

### 电池

- JS 580(+4:漏网体裁用例、防重复开口用例、常驻接线钉×2)
- Python 234、适配器 47(1 skip 照旧)、check/hygiene/persona/tools 全绿

## v0.30.0 — 2026-09-27(**会话页角落的开关按钮 + 审计认不出会话的病**)

### 他:「我建议是你完全可以在每一个会话的页面的一个角落里面加上一个 echo 开启或者是关闭的一个插件,一个小按钮。」

**位置选的是 `conversation.session.header.utilities`**(会话页头部右对齐的一排

**会话 id 由插槽直接发**(`sessionId` 是 session 作用域每个席位的标准 props)——

- **总闸关** → 虚线橙[…],**不可点**。会话闸开不了总闸,假装能开就是骗他。
- **会话关** → 灰点[…],点一下上线。
- **会话开** → 绿点[…],点一下下线。

**后端一行没改**,只给 GET/POST 的返回多带了一个 `power`(总闸快照),按钮靠它

### 顺带修掉「面板认不出会话」的病(他上一次问的那个)

**列表是坏的**:`writeAudit` 的兜底是 `row.sessionId || GLOBAL_SESSION`,而反思

### 数字

## v0.29.0 — 2026-09-27 凌晨(**个人机器人:彻底移除一切群体相关的东西**)

### 他:「彻底移除一切和群体相关的东西吧,我们现在就是要打造一个为个人服务的机器人。我看情绪里面还有几个群体维度的」

### 移除清单(五层,层层对齐)

1. **情绪 11 维 → 7 维**:`target_group` 组(耐心/轻蔑/防御/怒火,「对群友/
2. **中继群聊一律拒收**:入站信封 `chatType !== 'private'` → 403 `group-refused`
3. **渠道维度(B 方案)整条退役**:`lib/channel.js` 删除;capture/reflect/
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
4. **适配器**:`group_enabled` / `group_require_at` 配置删除,`decide_inbound`
5. **A 侧遗留参数**:`echo_memory_clear` 的 `includeMembers`(「连群友隔离空间

### 防线(拒收是四道闸,不是一道)

### 顺带

- `sessionChats`(会话→群号)机制删除;老 `config.json` 里残留的该字段会被
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- 面板记忆表的[…]列删除;情绪面板群维行删除。
- README 调参项数 51 → 50(由 `tests/settings-fields.test.js` 钉着)。

### 数字

### 收尾:同一个病的另外三处出口(2026-09-27 凌晨补)

1. **共享上下文窗口**(`renderSharedContext`)把它当成[…]
2. **反思信封的[…]**(`recentTurns`)把它当成语境喂给模型,用来
3. **回放页**照旧显示 —— 面板上看着还是脏。

## v0.28.0 — 2026-09-27 凌晨(**他问的三个问题:群串私聊 / 开关是假的 / 记忆图脏**)

### 他:「为什么我在群里面发消息会影响到他私聊的信息?」

| 记忆出生在 | 私聊里 | 本地 | 同一个群 | 别的群 |
| --- | --- | --- | --- | --- |
| 群 | ✗ | ✗ | ✓ | ✗ |
| 私聊 / 本地 | ✓ | ✓ | ✓ | ✓ |
| 空(迁移前老数据) | ✓ | ✓ | ✓ | ✓ |

- `lib/channel.js` —— 标签→渠道、渠道→可见性、渠道→人话,三件纯事一份判据
- `episodic_memory` 加 `channel` / `channel_chat`(JS 与 Python 两侧**幂等迁移**);
  **老行留空 = 不参与过滤** —— 迁移不许把历史记忆判成[…]。
- 过滤在 **SQL 层**,不是排名后筛:候选池 200 条被群记忆占满时,排名后再筛会把
- 渠道真源是会话标签(`labelSession` 逐轮覆盖),群号走新的 `sessionChats`;

### 他:「你是一个工作的agent,为什么我跟你说echo下线,你还在使用echo插件。……你应该搞一个硬性的按钮出来。」

- **硬按钮**:`echo_power({on,reason})` 总闸 + `echo_scope({sessionId?,on?,scope?})` 按会话;
- **硬关名单** `manualOff`:人显式关过的会话,`autoScope` 不再自动打开(它只认这份名单)。
- **必有回话**:标记短语解析失败也回一句当前状态(旧版静默 = 故障不可见);
- 引用/致谢见 `ACKNOWLEDGMENTS.md`

### 他:「我说这个记忆图谱为什么会出现那么多奇怪的记忆?我之前在astrbot上面可没有这个问题啊,那个记忆图是非常干净的,加一个记忆上面要经过好复杂的严格的这个审查机制,你在干嘛?」

1. **宿主注入被当人话** —— 每轮的 runtime context 被捕获,活库 `conversation_log`
2. **我们改代码的工作话被记成了他的记忆** —— 250 条里 34 条(14%)是

- `lib/inbound-filter.js` —— 白名单式 `isHumanUtterance`(只认真的人话)+
- 三道门:捕获层(不进对话窗口/不喂反思)、反思前(连模型都不用请)、
- 提示词产出端也说清(提示词是劝,后处理是墙 —— 两道都要)。
- **清理**(归档式,不硬删):27 条现役自指记忆 + 1 个自指节点 → `is_active=0` +
- `npm run memory:doctor` —— 体检加第 ⑦ 项(自指/注入残留/自指节点/渠道分布),

### 数字

| | 改之前 | 现在 |
| --- | --- | --- |
| 现役记忆 | 194 | **167**(27 条自指归档) |
| 现役自指记忆 | 27 | **0** |
| 自指图谱节点 | 1 | **0** |
| 近义节点对 | 1(`3km与速度限制` ⊂ `3km速度限制`) | **0**(已并) |
| JS 电池 | 544 | **573** |
| Python 电池 | 225 | **236** |

## v0.27.0 — 2026-09-26 深夜(**动态图谱:他说的"受力"和"丑"都是真的**)

### 他:「关节处不应该能弯那么狠,两条线段中间最好不要成锐角,边之间也有一定的斥力」(第九轮)

| 指标 | 改之前 | 现在 |
| --- | --- | --- |
| 最挤的那格 / 理想间隔 | **0.01**(= 0.3°,两条边叠在一起) | **0.60**(= 18.1°) |
| 所有关节的中位数 / 理想 | 0.95(靠几个巨大的间隔摊平) | 0.87 |
| **他的原话场景**:钉住一个度 2 的点,绕 24 个角度转,两条边的最小夹角 | **15.4°** | **147.5°** |
| 整图最大半径 | 387px | 465px(半高的 94%,仍在画面里) |

1. `angles` —— 每个节点把邻居的方向排序,间隔小于均分(360°/度)的一对,就给两端点加一对
   **切向速度**(角速度 × 半径,方向相反)把它们转开。强度按 `alpha` 衰减(收敛时一起安静);
2. `edgeRepel` —— 不相邻的两条边,最近距离 < 110px 就沿法线互相推开(共端点的交给①管,

### 他:「还可以,但是如果能让它动起来就好了」(第八轮,第一次听到正面评价)

1. **线上的流动** —— 同一条弧上再叠一条跑动的虚线(`stroke-dasharray:2 26`,周期 28 ⇒
2. **新记忆长出来** —— 入场动画只给**这次新出现的**节点(`pendingEnter` 由 `loadData` 按
3. **核心锚定节点呼吸** —— 只有 `isProtected` 的那几个有一圈淡光环(`@keyframes breatheOut`

**开关**:工具条[…](记 localStorage);弱档流动压到 0.3 透明、周期 ×2.2、
**没有**引入物理漂移 —— 布局仍然[…](保住上一轮修好的性质,实测最小圆缝 55px)。

## 2026-09-26 深夜(**动态图谱:受力重写 → 六轮视觉返工 → 照三个开源实现重做**)

| 他看到的 | 源码里的原因 |
| --- | --- |
| […] | 理想边长 `120 / 权重 × 2` ⇒ **关系越强画得越挤**:权重 10 只有 24px,而权重 1 有 240px。两个圆的半径就有 19px,于是强关系的那一对直接贴脸 |
| […] | 拉力每条恒 `.strength(.4)`,完全不知道度数;加上圆半径 `sqrt(权重)×6` 无上界(权重 10 → 19px),枢纽又大又在正中央 |
| […](抖) | 预跑 300 步之后又 `alpha(.3).restart()` 让它[…];`forceCenter` 还把质心硬钉在画面正中(它是位移不是力) |
| 叠字 | 节点名画在圆下方 14px,而碰撞半径只比圆大 4px |

### 受力:重写成一整张可测的表

- **边长**:`权重 → 78~134px`(重=近,但有地板);**再按度数给地方** ——
- **拉力**:按两端度数的**较小值**归一(`1/min(deg)`,地板 0.06)。星形结构要撑住
- **半径**:次线性压缩到 9~15px(旧版 8~19px);**碰撞半径另外留 16px 给节点名**。
- **斥力/向心**:斥力随度数增大(`-260 - 34√deg`,`distanceMax 900`);`forceCenter` 换成
- **稳定**:预跑之后自己画一次就定住,不再 `restart` 让它抖;拖拽时才重新给 alpha。

### 好看

- 配色换成审查台 2.0 的同一套变量(以前这边是蓝紫渐变 + 金色发光,跟审查台两个世界):
- **箭头**:`marker-end` 三色(清醒/模糊/遗忘),但**只给权重 ≥3 的边** ——
- **标签策略**:工具条新增[…]。自动 = 权重 ≥6 常显、≥3 放大后显;
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- **悬停**:改成[…]整片点亮(旧版只按 id 相等判,连邻居都暗下去 ——
- 类型过滤按钮去掉 emoji 汤,换成类型色小圆点 + 名字。

### 顺手修掉的一个真 bug

### 电池(12 条,逐条做了破坏验证)

- `tests/graph-force.test.js`(8 条):纯函数性质 —— 边长地板/上限/单调、
  **图真的接上了这张表**(逐条匹配 `.distance(/.strength(/forceX/chargeOf/collideOf`,
- `tests/graph-layout-geometry.test.js`(4 条):按 d3 同款公式写的**确定性**小仿真
- 破坏验证:四条旧配方逐条换回去(边长/拉力/半径/斥力)→ 全红;撤掉[…]→ 红

### 他第二次说「太丑了太丑了,我求你了」之后 —— 三个我自己的错

1. **度数用错了**:我按[…]数(用户 → 25),真邻居只有 **12**。于是枢纽的边被算成
2. **默认把名字藏起来了**:权重 ≥6 才显示 ⇒ 17 个节点里只有 3 个有名字,其余 14 个是
   **没名字的圆点**。名字就是这个页面的内容,藏了当然是丑。默认改成全部显示
3. **`用户—Echo` 之间有 6 条平行关系**:原先每条画一根线 —— 6 根线完全重合,

### 这次不再用我的近似仿真当证据:把 d3 本体请进来

- **把 d3 收进仓库**(`web/vendor/d3.v7.min.js`,v7.9.0,ISC,273 KB,附
- **新增 `tests/graph-d3-live.test.js`**:把页面里那段[…]和
- 我那份近似积分器**降级为 A/B 对比工具**,文件头写明它只能比快慢、量级,

### 他第三次说「还是丑,还有一对bug」—— 那两个 bug 是真的,丑的部分我交给他点

**bug ①:箭头根本看不见。** 连线画的是**圆心到圆心**,`marker-end` 的箭头因此落在

**bug ②:统计栏自相矛盾。** 写着[…],画布上只有 15 根线(平行关系已合并)。

**顺手**:窗口 resize 从来不重排(他要是把窗口拉大,图还按旧尺寸排,看着就是歪的)——

**丑:这次不猜了。** 他说了三遍[…],而我没有眼睛 —— 与其再交一版我的口味,

| 配色 | 是什么 |
| --- | --- |
| 夜航(默认) | 深海军蓝 + 点阵底纹,和审查台 2.0 同一套 |
| 稿纸 | 亮底纸感 + 细线,像论文里的关系图(投屏/打印最清楚) |
| 焦点 | 近黑、无底纹、只剩节点和线,最安静 |

--dots-op/--vignette-op`),所以切换时工具条、图例、tooltip、节点名字的描边一起变。

### 他说「箭头太丑了,参考一下 A 侧老代码」(第四次)

- 三枚 marker 全部 `markerUnits=[…]`,**固定 7px**;形状换成细长的实心三角
- 顺手把**线/圆的配色照抄 A 侧**(他说[…]):边的透明度 `0.3+0.5i / 0.2+0.4i /

### 他发了截图,问「你觉得为什么丑」(第五次,终于有眼睛了)

| # | 病灶 | 证据 |
| --- | --- | --- |
| 1 | **线太粗,主次颠倒** | 权重 10 的边 7px 实心高饱和绿 ×8 条 ⇒ 图的主视觉变成[…],而圆只有 26px 直径 |
| 2 | **弱边等于消失** | 权重 1 的边 1px + 0.3 透明度,深底上几乎看不见 —— 一屏只剩粗边,结构信息丢一半 |
| 3 | **完美放射星形** | 枢纽 12 个邻居目标距离完全相同 ⇒ 排成一条等距圆环,就是朵蒲公英 |
| 4 | **箭头白做了** | 7px 的绿线上贴一枚同色 7px 三角 = 融进线里,整张图找不到一个箭头 |
| 5 | **节点太小、颜色单一** | 半径 9~15px、17 个里 14 个同一个灰蓝 ⇒ 没有重心;A 侧半径到 19px、权重高的 33px,节点才是主角 |

- **线宽 1.2 ~ 4.8px**(旧 1~8px),抽成 `T.linkWidth(w, activation)` 进纯函数表。
- **弱边下限抬高**:清醒 `0.4+0.5i`、模糊 `0.32+0.4i`、遗忘 `0.24+0.3i`(层次照 A 侧,下限自己抬)。
- **节点半径 11 ~ 23px**(旧 9~15px;A 侧旧配方在权重 31 上会到 33.4px,像个球 —— 23px 是中间)。
- **布局打破蒲公英**:边长加**确定性微扰** `×(0.86~1.14)`,种子 = 边的 key 做哈希
- **箭头 9px**(比线宽上限还大)+ 离线端 4px + 颜色比线亮一档 ⇒ 这次真的看得见。

### 他说「就是简单几何图形硬拼凑在一起,垃圾积木」(第六次)

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

| --- | --- |
| 棍子顶珠子,接口是硬断口 | 弧线画**圆心到圆心**,节点多一圈**背景色光环**(`r+3.5px`)把线[…] ⇒ 线看着从节点底下穿过 |
| 实心三角胶在棍子末端 | 换成**线中段的细拐**(chevron),挂 `t=.62` 处、按切线旋转,属于线而不属于任何一端 |
| 大小一律、平贴无层次 | 标签字号/字重按权重分级(≥6 → 14.5px/700),节点加 drop-shadow(亮底那套换浅投影) |

**踩到一个数学坑**(记下来免得以后重踩):二次贝塞尔在 `t=.5` 处的切线**永远平行于弦**

**箭头没删** —— 只是不再[…]在圆上;他要是还想要末端那种,一个词就能换回来。

### 他:「依旧是一坨狗屎啊,到开源社区或学术论文里找找好看的记忆图谱代码,多找几个参照」(第七次)

1. [0xedgelessblade/contextual-neural-map](https://github.com/0xedgelessblade/contextual-neural-map)
   - 纸底 `#f5f2ed` + 两层 `repeating-linear-gradient` 画 28/29px 细格(`rgba(180,170,155,.07/.05)`)
   - 线 **0.5 / 1.2 / 1.8px**、透明度 0.3 / 0.55,颜色全灰棕 `#cdc6bb/#a09888/#8a8279` —— **一个饱和色都没有**;
   - 节点 4~20px(多数 5.5~10px),**靠形状分类型**:实心深色 / 空心虚线 / 半透明 / 大环
   - 标签 9px `#9e9589` **opacity .55**,画在 `r+14`;面板 1.5px 边 + `backdrop-filter blur(16px)` + 虚线分隔
   - 手画感:`feTurbulence(0.03/0.04)` + `feDisplacementMap(scale 2.5/3)`
2. [sigma.js alpha-blending](https://v4.sigmajs.org/embed/styling/alpha-blending/)(深色对照):
3. [Obsidian graph view 的 CSS 桥](https://raw.githubusercontent.com/community-archive/obsidian-hub/main/04%20-%20Guides%2C%20Workflows%2C%20%26%20Courses/Guides/Graph%20view%20customization.md):

**读完的结论跟我前四版几乎相反**,而且解释了为什么我一直丑:

- 引用/致谢见 `ACKNOWLEDGMENTS.md`
| --- | --- | --- |
| 边色 | 高饱和绿/橙/红 | 稿纸=**灰棕三档**(HSV 饱和度 ≤0.55),深空才用亮色(≥0.5) |
| 节点形状 | 全是同一种圆 | **五类五种画法**:人物实心+深描边、习惯空心、偏好淡底虚线、事件淡底实线、概念半透明无描边 |
| 标签 | 12.5px 常亮 | 10.5px、**默认 opacity .62**,按权重分级(.62/.78/1) |
| 底 | 纯色/点阵 | 稿纸:**28px 细格 + 噪点**;线/圆挂**铅笔抖动**滤镜 |

## v0.26.0 — 2026-09-26 夜(**审查台 2.0:他说「太丑了,也不方便」**)

### 布局:左栏分区 + 一次只看一段

- **左栏 232px 常驻**:品牌 → 三枚状态丸(在线/休眠 · 引擎 Python/JS · **桥 通/拒签 N**)→
- **右栏只显示当前一段**:hash 路由(`#/mm`),旧书签 `#mm` 照样认(id 就是锚点)。
- **顶部工具条**:段标题 + 一句副标题、上次刷新时间、`刷新`、**`冻结刷新`**

### 好用:检索与快捷键

- 审计流 / 对话回放 / 最近记忆 / 日记 / 调参各有一个检索框:**过滤已拿到的行**,
- 快捷键:`/` 聚焦当前段的检索框(再按 `Esc` 让出),`1`~`9` 切段。
- 审计流、对话回放的截断放宽(80→160 / 200→300 字),审计一次拉 40 行(原 14);

### 好看:一套真正分层的视觉

- 三层背景(底 `#0b1220` / 卡 `#131c2e` / 内嵌 `#0e1626`)+ 一条强调色;数字与时间用等宽字体;
- 卡片有 hover、焦点有可见环(键盘用户)、`prefers-reduced-motion` 下关掉动效;

### 电池(每条都做了"改回去必须变红")

**冻结真的不打了**(轮询那行必须查开关)、**检索只过滤不再请求**。

## v0.25.0 — 2026-09-26 夜(**桥坏掉的那 85 分钟里,是"另一个 Echo"在答他**)

### 现场(有据)

| 时间 | 证据 |
| --- | --- |
| 17:39–17:51、18:30–19:04:37 | 适配器日志 **`取队列 401:令牌不对`** 共 **1296 条**(分两段爆发,正好对应我跑测试的时段) |
| 18:00–18:30 | 干净窗口 —— 所以 18:07 群里那句正常送出(`已送出 1 段 → <your-group>`) |
| 19:05–19:08 | 他私聊的六句,由 **A 侧 `astrbot_plugin_memory_middleware`** 答:`Prepare to send - [别名]/<your-qq>: AstrBot 啊…`、`我这边挂着的就是 AstrBot…至于 dsh 是个什么东西` |
| 19:04:37 | 我恢复令牌后,401 **再没出现过**(与恢复时刻严丝合缝) |

**但真正让他[…]的是产品的洞,不是那一次的令牌**:桥一旦不接管,

### 1. [高] "桥坏了"时**不许换人**(适配器 1.1.0)

- **401(令牌/授权坏了)**:挡住这一条 + 回固定兜底话 —— **宁可她说一句[…],
- **静默期也分原因**了:`outbox-401` 的静默期**挡人**(以前 `paused()` 一律放行 —— 这正是
- **409 `scope-off`** 不变:一键回滚姿势,放行原生链路。

### 2. [中] 幂等重放被当成失败(审查 B3)

### 3. [中] 401 刷屏与不打退避

### 4. [中] **401 是我们发的,可他那边什么都看不见**

### 5. [低] `install-adapter` 归档旧副本(审查 B17)

### 电池(每条都做了"改回去必须变红")

- 适配器壳(`test_shell.py`,宿主解释器下 5 条新):
- 桥的拒签可见性(`relay-rejects.test.js`):计数/原因/限流;空令牌一律拒。
- 面板(`web-dashboard.test.js`):无拒签不吓人;有拒签必须写出次数、原因、去哪里改;

## v0.24.1 — 2026-09-26 夜(**store 那一层补审:日上限的真相源被自己裁掉**)

### 1. [高] 关怀日上限的真相源被 `trimAudit` 裁掉

- 修:裁剪切一个例外 —— **当天的 `tool_call='care'` 行永不裁**(每天最多 3 条,
- 新电池:3 条关怀 + 60 条日常 → `careCountSince(午夜)` 仍须是 3、

### 2. [中] 面板「画像字段 N 项」数的是表行数(恒 0/1)

### 3. [中] 引擎对壳拥有的表做无保护 DELETE

### 4. 报告补进 7 条未修项

### 电池
- `npm test` **499/499**,`npm run test:py` **225/225**,`check`/`hygiene`/`probe` 全绿;

## v0.24.0 — 2026-09-26 夜(**全仓审查:四类"面板到不了代码"的病**)

**报告全文:`docs/CODE_AUDIT_2026-09-26.md`(含全部未修项的 `文件:行` 与建议)。**

### 1. [高·我自己的 bug] 测试会写进他的真实配置

- 改成用例内动态 import;`freshToggle()` 里加闸 —— **每一次**都断言
- 他的配置已恢复(令牌与适配器侧一致),备份 `~/.dsh/echo/config.json.pre-restore2.bak`。
- 证据:跑完整套电池前后 `config.json` 的 mtime 与 token 完全一致。

### 2. [高] `normalizeSettings` 漏掉 `longing.must_say` 与整组 `compaction`

- 面板上的[…]**永远关不掉**(消费端判 `!== false`,读出来恒 `undefined`);
- […]关不掉、`budgetTokens` 改了不生效(`compaction.js` 只拿到 `{}`)。
- 补钳位;`writeSettings` 的嵌套合并从 2 组补到 7 组。
- **新闸**:`tests/settings-fields.test.js` 加[…]逐键相等 ——

### 3. [高] 想念九项里七项到不了引擎(camelCase vs snake_case)

- `LONGING_KEY_MAP` + `longingFrameConfig()`,四个帧全过它。
- **新闸**:`tests/longing-config-keys.test.js` 走真接线(注入假 client 查帧内容);

### 4. [高] 自由文本里的 `{{…}}` 会打死整轮

- `escapePromptBraces()`(`{{` → `{ {`),用在 snapshot / persona / rules / relay 四处注入路径;
  **只转义注入的那份**,审计与落库仍是他的原话。
- 第一版转义在 `{{{x}}}` 上还能拼出相邻 `{{`,是电池当场抓出来的;改成按连续 `{` 整段拆。

### 5. 其余当场修的

- `agenda.pick` 认数组(壳侧发的是 list)⇒ 议题不会再带着 `['` 进她的开场。
- **装机卫生**:`install.mjs` 复制 `python/` 时过滤 `tests|__pycache__|*.pyc` ——
- 文档漂移:`web/index.html` 补 `#th`/`#cfg` 导航锚点、[…]→ 7.0;

### 电池
- `npm test` **497/497**(+9:字段表键集、想念接线 ×3、逃逸 ×5),`npm run test:py` **225/225**。
- 每条修复都做了[…]的沙袋:配置闸、字段表键集、想念接线、逃逸闸。

## v0.23.0 — 2026-09-26 傍晚(**一致性探针 + 把"不做"也写成结论**)

### 1. `tests/consistency_probe.py`(D6)

- **主动认领**:议程簿取出的那一项,`source_ids` 必须全部还能走回**活着**的记忆
- **记忆认领**:顺着话题追问时,检索**真的命中**那条证据
- **别名**:`graph.get_or_create_node` 走别名表后,别名与正名必须是**同一个 node_id**

**回复半**(`--reply […]`)按否认/编造判据给判决 —— 真模型的话从**真渠道**拿

- `npm run probe`,`--json` 给别的脚本喂
- 电池 `tests/probe.test.js` 5 条:**探针会红**(拿[…]喂它,退出码必须 1)+ 两半的分界写在代码里
- 沙袋两条都真红过:① `graph._alias_target` 短路 → 探针红;② 现场不写别名映射 → 探针红;复原即绿

### 2. 审计表里"待定"的那些,现在都有结论

- **不做**:D3 Live2D 立绘 / D4 动作标签 / D5 typert 打字通道 —— 三条都是**平台表现层**,
- **等价**:M4 记忆体检 / M5 图谱合并(同一张 `graph_aliases`,写入自动接地)/
- **明确未证**(不许说[…]):D2 转舵(`longing=0.025` 从没到阈值)、

### 3. `check:persona` 那 19 条 ✗ 是假的(真身:子代理会话)

- 判据加一层:读会话头帧的 `delegationDepth`,`> 0` 一律不判(但**报数**:
- 修完:`合计:5 条 —— ✓已生效 3,⏳等下一轮 2,✗对不上 0`,退出码 0
- 用例钉住解析本身(坏头不许抛 —— 抛了整场检查就没了)

**这类[…]值得单独记一笔**:它比不检查更糟 —— 假红会训练人忽略那个检查。

### 验证

- `npm test` **488/488**(+5 探针电池 +1 会话头解析);`npm run probe` **3/3**;`npm run test:py` 225/225
- `npm run check:persona` 退出码 0(见上)
- 沙袋:两条红→绿都跑过(见上)

## v0.22.0 — 2026-09-26 傍晚(**收口:面板、代词产出端、两只旋钮,和一个 clampNum 的坑**)

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

### 1. O5 悬置话题面板(以前有 API 没 UI,README 却写着它)

**活服务上验过**:装机后 `GET /echo/index.html` 里有 `<section id=[…]>`,

**顺手查实的一件事**:那 9 条**全部**是[…](`follow_up_after=0`),
#8[…]本该有时间。我又单独跑了 `resolve_follow_up_time`

### 2. M3 代词产出端(画像那一格以前永远空着)

- 提示词:加 A 的原文规则(键封闭两个;`代词` 是[…];
- schema:`profile_update` = 对象 + 两个可选字符串键 + `additionalProperties:false`
- `normalize_extract`:白名单**再筛一遍**(双层防守),值裁 60 字(A 记审计时就是 `str(v)[:60]`)
- 合并顺序照 A(`main.py:952-955` 的 `profile_update.update(judge_profile)`):
  **派生值覆盖模型自由发挥** —— 派生来自[…],更硬

### 3. 两只旋钮接出来(议程簿 / 整固)

- 设置项:`agenda.enabled`、`reflection.{importance_threshold, max_inputs}` + 面板两组字段
- 设门位置照 A:**agenda 只在取用那一步设门**(登记照旧,关掉只是她不再主动提);整固两个值随 `reflection_prompt` 帧下发
- 引擎侧 `reflection.check(..., importance_threshold=None, max_inputs=None)`:传 None = 默认 30/50,**老调用行为完全不变**;坏值回默认而不是[…]
- 触发日志:`echo: 整固触发 — 累计情感 X / 阈值 Y · 窗口 N 条`(面板调高阈值之后[…]要看得见)

### 4. 顺手修掉的真坑:`clampNum` 把 `null` 当 0

### 验证

- `npm test` **481/481**(+6:面板契约 4 + 旋钮钳位 2);`npm run test:py` **225/225**(+5:M3 一组 9 条 + 整固旋钮 5 条)
- 面板在**活服务**上验过(见上);整固旋钮是**真跑出来**的:同一批记忆、
- 新增一条[…]的闸:README 写的调参项数必须等于字段表实际项数(现在是 51)

## v0.21.0 — 2026-09-26 傍晚(**E5 情绪余波:她忍不住想补的那一句**)

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

### 落点

| 层 | 文件 | 做了什么 |
| --- | --- | --- |
| 判官 | `python/engine/judge.py` | 提示词加两条规则(A 原文)+ `build_extract_schema` 加两字段(进 `required`)+ `normalize_extract` 出 `sayAgain`/`extraReply`(`say_again` 只认 1;<80 字;`say_again=0` 时台词清空) |
| 调度 | `lib/say-again.js`(新) | 挂起/撤回/竞态核对/投递/审计。定时器、时钟、随机数、投递**全部注入** ⇒ 假定时器离线钉时序 |
| 接线 | `lib/index.js` | 建调度器(3.5c);`reflect` 拿到 ack 就挂起;`user/message` 分支 `sayAgain.bump()` 撤回(范围闸之后、整段 try/catch) |
| 出站 | `lib/relay.js` | `say_again` 进 `VOICE_FORMS` 白名单 —— 那句台词**是她说的话**,不进白名单会被当成[…](想念不落地、QQ 收不到) |
| 审计 | `lib/store.js` | 写入端补两列(缺席 ⇒ **NULL**,不编 0);读侧 `listAudit` 也透出(面板才看得见) |
| 面板 | `web/app.js` + `lib/export.js` | 审计流显示[…];复现包 Markdown 追加[…](A `export_conversation.py:264-265` 逐字同款) |
| 设置 | `say_again.{enabled,min_delay_sec,max_delay_sec}` | 单位**秒**,与 A 的 `say_again_min_delay` 同名同单位;默认 2~5 |

### 刻意的机制偏离(A → B,记在这)

### 没做的(边界,不吹)

- **不给余波单独设[…]**:送不出去就放弃(A 也不重试)。
- **序号只在投递之前核一次**:所以它拦得住[…],拦不住"核完之后、

### 验证(证据)

- `npm test` **475/475**(新增 21 条:调度 18 + 字段表 3 处);`npm run test:py`
  **211/211**(新增 8 条:判官两字段的提示词/schema/规整/端到端 ack)。
- 审计两列真读写:写入→`listAudit` 读回 `sayAgain=1`/`extraReply` 有值;
  **老行仍是 NULL**(不编 0)—— 电池钉住。
- 三条沙袋(先红后复原绿):① `bump` 不再撤回;② 判定忽略 `say_again=0`;
- 自己抓到的两处:**一是我把测试写得比 A 更强**(断言[…])——

### 还没证的(要他在真会话里看)

- 判官真的会在[…]的轮次给 `say_again=1`(提示词口径很窄,可能偏保守 ——
- 那半句话在 QQ 上的形状(是否单独一条气泡)、以及被你抢话时是否真的一个字都没发。

## v0.20.0 — 2026-09-26 傍晚(**D1 压缩即策展:机器留 dsh,内容归 soul**)

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

### 落点

| 层 | 文件 | 做了什么 |
| --- | --- | --- |
| 内容 | `lib/curation.js`(新) | 纯函数:token 估算(1 token ≈ 1.6 字符,保守高估)、`budgetFor`(配置上限与[…]取小)、四段策展文本、`trimToBudget` 硬裁。**绝不超过预算、绝不空** |
| 原料 | `lib/soul-snapshot.js`(新) | soul 库**只读**快照(画像/计数/悬置话题/最该活下来的记忆/情绪)。一次连接、几发查询、立刻关。列名以真库为准 |
| 后端 | `lib/compaction.js`(新) | `EchoCompactionEngine extends BasicCompactionEngine`,覆写 `summarize(input, agent, signal)`。异常一律退化成最小账本,不抛 |
| 挂载 | `lib/preset-patch.js`(新)+ `scripts/install-preset.mjs`(新) | 生成[…]预设:现读出厂 `standard` 组合,**只换压缩那一行**,其余逐字不动 |
| 设置 | `compaction.curated` / `compaction.budgetTokens` | 网页调参;`curated=false` 只写一页最小账本 |
| 打包 | `package.json` `exports[[…]]` | 预设里写的就是 `dsh-echo/compaction` 这个名字 |
| 诊断 | `scripts/install.mjs --doctor` 第七项 | 预设没生成 / 没指向我们 ⇒ 明确说出来(信息/警告级,**不拦启动**) |

### 宿主契约(装机版逐行核对,几处与 03 号文档的猜测不同)

- 后端住在 **preset 平面**,不是 profile 平面:`dsh-web-app` 的 patch 自己把
- 钩子真实签名是 **`summarize(input, agent, signal)`(三个参数)** ——
- `frameSummary()`(`<compacted-summary>` 标签 + 英文前导)由基类在钩子**之后**
- 缩减验证在引擎里:`framedSummaryTokenCount >= prepared.shadowedRouteTokenCount`
- 溯源诚实:`provider='dsh-echo'` / `model='soul-curation'` —— 日志里这份摘要

### 刻意的偏离(留着,不补)

- **不抄出厂组合进仓库**:生成预设时**现读现改**。宿主升级后重跑一次就跟上;
- 策展块**不写想念曲线、不写检索回响**:那些压缩后照样每轮重算,写进去就是
- 情绪一段标注[…]并带相对时间 —— 老实说这是记录值,不是此刻值。
- 没做[…]:`modelPolicies` 继承基类的解析,但预算只有一份。

### 验证(证据)

- `npm test` **454/454**(新增 29 条:策展内容 9 + 预设替换与快照 14 + 契约 3 + 字段表 3)。
- 真库干跑(装机位、按预设里写的名字 import):
- 预设替换是纯文本变换 ⇒ 真跑对照:除压缩那一段,前后两半与出厂文件**逐字相同**。
- 只读性质:快照前后库文件 mtime 不变(电池钉住)。
- `--doctor` 三条分支都真跑过(装机在 ⇒ […];`DSH_HOME` 空 ⇒ 信息级;
- 预设替换件的**真 bug** 被自己的电池抓到:正则尾部 `\s*$` 把行尾换行也吃了,
- 内容层的**真 bug** 被自己的电池抓到:`composeCuratedText(null)` 会炸
- 顺手抓到我自己的列名错:`episodic_memory` **没有** `created_at`

### 低风险是设计出来的

- 这份预设**不选就不生效**:不选它 ⇒ 一切照旧(stock 英文检查点)。
- 预设**按会话挂载**:这份预设坏了只坏它自己那一行 roster(出厂 discovery 的
- 引擎内**任何异常都退化成最小账本**,绝不抛给区域事务。

### 还没证的(要他在真会话里看)

- 真会话触发压缩后的样子(需要选[…]预设):表层应变成
- 策展块的**主观质量**:她压缩后还记不记得[…]。
- 预设选择器的呈现(roster 里应出现[…],不用重启)。

## v0.19.0 — 2026-09-26 傍晚(**D2 轮末硬保证:「想念该说没说」不再是碰运气**)

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

### 落点

| 层 | 文件 | 做了什么 |
| --- | --- | --- |
| 引擎 | `python/engine/longing.py:due_snapshot()` | 判定快照:阈值走 `care_threshold`(**与 `should_care` 同源同数学**:心境调制、下限 4.5),`due = exists 且 value ≥ 阈值`。**不落账**(care_count/last_care_at/anchor 一个都不动) |
| 引擎 | `python/worker.py` | `longing_message` 的 `pre` 改走 `due_snapshot` ⇒ 帧里多了 `threshold` / `due`(用 `pre` 不用 `post`:问的是[…]) |
| 壳 | `lib/turn-stopping.js`(新) | `ctx.on('agent/turn-stopping')` 的判定与动作:读引擎的 `due` + 看她本轮说过的话 + 每轮至多一次的记号 + `agent.steer(createUserMessage(...))` + 审计 `longing_steer` |
| 壳 | `lib/index.js` | 挂点(外壳 try/catch)+ 本轮她说过的话累积 `capture.turnText`(有界 4000 字)+ 按会话 id 的捕获兜底(`captureBySid`) |
| 设置 | `longing.must_say`(默认开) | 关掉只是少了这道保证,想念照常涨、关怀照常开口 |

### 挂点纪律(照参考实现的血泪,它自己的注释原文)

### 刻意偏离(写下来,免得以后当成 bug)

- **不套 `cooldown` / `night_hold`**:那两条是[…]的闸(别刷屏、别半夜
- **`kicked` 不参与判定**:它是[…]的一次性标记,
- **只认[…]**:她用 `echo_feeling` 之类的工具表达情绪**不算**命中
- 引用/致谢见 `ACKNOWLEDGMENTS.md`

### 验证

- 电池:`npm test` **434/434**(新增 `tests/turn-stopping.test.js` 19 条 +
- **自毁三条(全部先红后还原)**:
- 帧契约:`longing_message` 的空库往返断言 `pre.threshold == 7.0`、

### 还没证的

## v0.18.4 — 2026-09-26 傍晚(**装机方式会拦住宿主启动:修掉,顺便把诊断做出来**)

| 他的判断 | 核对结果 |
| --- | --- |
| ①`package.json` 缺 `dsh.bundle` | ❌ **本来就有**(`dsh.bundle.patch: ./cordis.patch.yml`,自 v0.1.0 起)。与工作正常的 `dsh-almost-full-access` 的 `package.json` 逐字段同构 |
| ②`client.js` 注册 id 与包名不一致 | ❌ 注册的就是 `id: […]`,与包名逐字一致(宿主按图里的行 id 找工厂,不一致会抛 `loaded without registering`) |

**真正的原因是我装机器的一个设计缺陷**,而且后果比[…]严重得多:

### 改了什么

| # | 改动 | 为什么 |
| --- | --- | --- |
| 1 | 装机器额外 `npm pack` 出 `profiles/web/.dsh-echo-local/dsh-echo-<版本>.tgz`,并写进 profile 的 `dependencies`(`file:./.dsh-echo-local/...`) | 再被 `pnpm install` 时能**自动装回来**,悬空登记不可能再出现 |
| 2 | 新增 `--doctor`:逐条查[…]六项,致命项指名后果与修法,退出码 1 | 下次出问题先看清是什么,而不是靠猜(那次连 `dsh-fix doctor` 都报 0 issues) |
| 3 | `--remove` 同时摘 bundles 与 dependency、删掉分发包 | 半死状态(装回来却不挂载)也是坑 |
| 4 | `files:` 补上 `web/` | 漏了它,`npm pack` 出来的包里**没有审查台**(web/ 0 个文件)⇒ 走 pnpm/tarball 装的副本 `/echo/` 直接 404。复制装机看不出来,因为脚本是显式拷 web/ 的 |
| 5 | 删掉 `dependencies: {[…]: […]}` | 那版本在 npm 上**不存在**(只有 `0.0.1-rc.1`)⇒ 一旦有人对 profile 跑 pnpm install 就整包失败。`@deepseek-ai/*` 由宿主提供(工作正常的 afaccess 一个都不声明) |
| 6 | 新增 `tests/manifest.test.js`(6 条) | 这四条属于[…],代码测试照不到 —— 钉成契约闸 |
| 7 | README:装/卸/诊断三段 + […] | npm 上有个同名 `dsh-echo@0.0.1` 占位包;`dsh plugin add dsh-echo`(裸名)装的是**它**,CLI 那句[…]警告说的也是它 |

### 验证(没有靠推理)

- **仿真 profile 实测**:临时目录里复刻 `profiles/node_modules/@deepseek-ai/*` 祖先层 +
- **故障现场复现**:临时把 `dsh-echo` 塞回 bundles 登记(文件不装),`--doctor` 立刻报
  **dsh web 起不来**」并给出修法,退出码 1(读完即还原)。
- 装机位当前状态:`--check` 与 `--doctor` 都干净(六项一致)。
- 电池:`npm test` **411/411**(+6 契约闸)、`test:py` 196/196、`test:adapter` 48 OK、

### 还没证的

### 顺带(不是本插件的锅,但要让他知道)

## v0.18.3 — 2026-09-26 深夜(**画像常驻锚点:语言/代词真的每轮在场了**)

| 环节 | A 侧 | 这一版 |
| --- | --- | --- |
| 写 | `_apply_profile_update`(v8.1 两处收紧) | `store.saveProfileTraits`:白名单**只有 `语言/代词`**(称呼走 `name` 列);键 ≤24 字、值 ≤32 字、总数 ≤5、`null` = 该特征失效删除;非白名单键**记日志**不静默丢(A 的原话) |
| 读 | 读时再按白名单筛 | `store.getProfile` 同样筛 —— A v8.1 的原话:即使库里残留旧版写入的几十个键(实测有过 32 个),也不会漏进 prompt,修复立刻生效、不依赖数据清理 |
| 注入 | `brain_pipeline.py:1199-1213` `用户画像: 称呼:X, 语言:中文`(≤5 项 ≤100 字) | `context.js` 渲染 `[他的画像] 语言:中文`,称呼仍在原来那行;同样 5 项/100 字硬上限。B 用分行标注风格,装的是**同一批白名单项** |

**为什么值得单独一版**:这不是[…],是 A 侧明确修过的两个现场事故 ——

**诚实边界**(写进对账表):A 的 `profile_update` 是**模型直接输出**的封闭两键;
**产出端**。补它要给 Judge 的 `outputSchema` 加字段(顶层 `additionalProperties: false`),

### 电池

## v0.18.2 — 2026-09-26 深夜(**两个真缺陷:催办两次 / 长文当没看见**)

| # | 缺陷 | 现场会怎样 | 修法 |
| --- | --- | --- | --- |
| 1 | **提醒不比对到期时间**(C4) | 他说[…],同一场约定被登记**两次**:命令式提醒走确定性解析、Judge 走措辞归纳([…]vs[…])。措辞不同 ⇒ 现有去重拦不住 ⇒ **他收到两条催办** | `threads.remember_pending_thread` 加 `due_window_sec`:措辞之外再比到期时间,窗口内(120 秒,**A 侧 `main.py:2088-2094` 的常数**)即并成一条。命令式(壳传 `dueWindowSec:120`)与 Judge(`judge.py` 传 120)**两侧都开** —— B 的两条路是并发来的(命令式是微任务、Judge 要一次 LLM 往返),只开一侧就会漏掉另一半顺序 |
| 2 | **长文被当成没看见**(C6) | 他贴一段 3000 字的日志/代码/长消息:①想念削减**整个跳过**(想念不落地、锚点不重置、抗议窗口还按旧时刻判);②那一轮**根本没被捕获**,会话语录用户行是空的、反思信封里也没有 —— 她像没听见 | ①想念帧删掉长度豁免(A 侧无条件调),改送**前 400 字**:引擎只用长度算满足量 `0.5+0.5*min(1,(len-2)/38)`,**40 字就饱和**,所以截断在数学上逐位一致(`test_longing.py` 用 40 / 400 / 5000 三档证明同值);②捕获改成**截 2000 字捕获**,不再整轮丢弃 |

### 电池

**过程诚实说明**:C4 那条用例第一次写歪了 —— 我挑的两句措辞互为子串,于是它是被
**措辞去重**合并的,窗口关掉也照过(破坏性验证揪出来了);改成两句互不为子串后才真验到窗口 ✓。

### 下一步

## v0.18.1 — 2026-09-26 深夜(**他不在的时候,她怎么开口**)

- 引用/致谢见 `ACKNOWLEDGMENTS.md`
| --- | --- | --- | --- |
| 1 | **认账防火墙**:她主动说过话,他回过来那一轮必须让她看见自己说过什么 —— […]——这是你亲口说的,用户现在回应的就是这句话,先对上话头再往下聊;记不起具体细节就如实说你一直惦记这事,**不许否认自己说过,也不许编造细节**」 | `main.py:1855-1900`(v8.8.0[…]根修:主动消息不进对话历史,她会翻脸不认自己刚说的话) | `lib/proactive-ack.js` + 接在 `turn-snapshot.compose` 末尾。**取文本比 A 结实**:A 用插件内存窗口(重载即丢)+审计兜底;B 用**落库**的会话语录哨兵行,重载不丢,审计只作兜底 |
| 3 | **组稿超长即沉默**:关怀正文 >120 字 = 这轮**不说**(A 侧原注:[…]) | `main.py:1848-1852` `if not text or len(text) > 120: return […]` | `lib/relay.js` 出站口(她主动话是宿主那一轮的正文,没有独立组稿调用,所以闸在出口);**只卡关怀**,提醒照发(`kind='reminder'` 分流);超长落审计 `care_silent` —— 可以不说,但不许[…] |
| 4 | **安抚以真送达为准**:×0.5 缓解与议程降权从[…]挪到**适配器 ack 那一刻** | `main.py:1836-1841`[…]/`:1644-1646` 以 `send_message` 真值为准 | `relay.onAcked` → `heartbeat.noteProactiveAcked`(只认本会话 `kind='proactive'`);投递成功只记一条**待兑现账**。修掉的现场体感:**[…]** |

### 电池

### 还没补的(下一步)

**C4** 提醒与 Judge 的 ±120s 到期防重、**C6** >2000 字消息绕过想念削减(两个真缺陷),

## v0.18.0 — 2026-09-26 深夜(**他没说出口的那一层:气泡**)

**总账**(三路只读审计,逐项 `文件:行`,落在 `docs/PORT_GAP_AUDIT_2026-09-26.md`):

| 面 | 等价 | 部分 | 缺失 |
| --- | --- | --- | --- |
| 记忆系统(DMAE / 双层 / 图谱 / Judge / 治理) | 6 | 6 | 3 |
| 情绪 · 想念 · 主动 | 5 | 4 | 6 |
| 表达 · 反思 · 议程 · 可观测 | 13 | 9 | 9 |

**认知与数学层是 1:1 的**:DMAE 七个常数逐条一致(`brain_pipeline.py:127-133` ↔ `lib/dmae.js:14-20`)、

**缺的是[…]** —— A 侧 v8.10.0 的**气泡分条 + barge-in**,全仓 `bubble/split_bubbles/barge/interrupted`
**0 命中**。A 侧 `core/echo_utils.py:82` 的原注写着它是干嘛的:

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

**语义要重新设计**」—— 然后就被挂在那里,再没人回头看。**这次连根补上:**

### 补(六处,全部按 A 侧逐字移植)

- 引用/致谢见 `ACKNOWLEDGMENTS.md`
| --- | --- | --- | --- |
| 1 | **气泡切分** `split_bubbles(text, max_chars=30, max_bubbles=5)` + `_split_long_sentence`(换行即界 / 句末切句 / 装箱 / 超长退逗号 / **绝不切词中** / 封顶 5 泡尾巴合并 / 短回复直通) | `core/echo_utils.py:55,82` | 新模块 `lib/bubble.js`(纯函数,字数按**码点**算以对齐 Python `len`) |
| 2 | **泡间节奏** `base = min(2.0, 0.4 + len(bubble)*0.045)` × scale × `uniform(0.7,1.3)` | `main.py:1384 _bubble_delay` | `lib/bubble.js: bubbleDelaySec` + `planBubbles`(每泡带自己的到期时刻) |
| 3 | **出站按泡发** | `main.py:640-673` 的 `yield event.plain_result(_b)` + 泡间 sleep | `lib/relay.js` 的 `finishTurn`/`say()` 切泡入队;`relay_outbox` 加 `not_before/group_id/seq/canceled_at`(引擎 DDL 同步,`test_ddl_parity` 盯着) |
| 4 | **barge-in:他插话就停** | `main.py:650-660`:序号一变,手里这泡发完就停,`[…].join(bubbles[i:])[:120]` 记进 `_interrupted_tail` | 入站那一步调 `relayCancelBubbles`(只作废**还没递到适配器手里**的泡 —— 正在发的那一泡照发,[…]) |
| 5 | **被打断的认账** | `brain_pipeline.py:1234-1240`(pop 读一次就消费)+ `:1250-1255` 逐字措辞 | `lib/interrupted.js` + `lib/turn-snapshot.js: renderInterruptedLine`,挂在这一轮注入块的末尾 |
| 6 | **适配器按到点发** | — | `astrbot_adapter/main.py`:发之前等到 `notBefore`(封顶 3s);轮询间隔改由 `nextDueAt` 决定 —— 否则固定 2s 拍子会把抖动吃掉 |

**为什么这样落**:DSH 没有[…]这个位置,有的是**出站队列 + 适配器轮询**。所以节奏拆成

### 电池

### 还没补的(按优先队列,见对账表)

**下一次不再出现[…]**:这份总表就是清单,每移一项划掉一项。

## v0.17.3 — 2026-09-26 当晚(**撤掉在嘴边的检查表,撤掉话尾的待办**)

**现场**:插件 15:55:35 重载(v0.17.2 的 lib 改动生效),他 15:55–15:57 跟她说的话,

- **前 5 条都在谈[…]**:[…]「今天第三回了,
- **她的[…]是账本**:【别处刚说过的】里写着[…]

### 撤(两处,他拍的)

| # | 撤什么 | 为什么 |
| --- | --- | --- |
| 1 | `echo:voice` 尾部自检段(order 10280,三行) | **它没解决问题**:她 8 条里[…]仍 0%、[…]0%,句长中位数反而 48→53;却留下痕迹 —— 她思考(reasoning)里[…]的提及率从 9%/4%/0% 升到 **25%/25%/25%**(n=8,相关不等于因果)。**把[…]写在最后一行,等于每轮提醒她[…]** |
| 2 | 注入正文尾部的[…] | 它把每次注入变成[…],而她的话尾/记忆又都是报账格式,两下一叠就是那股怪味。路由知识本就在常驻段 `echo:relay` 里([…]) |

### 代价与判据(必须盯)

### 电池

## v0.17.2 — 2026-09-26(她的调子:他说「很冷硬」,这次量着改)

### 量(新:`npm run voice` + `docs/VOICE_BASELINE_2026-09-26.md`)

| 指标 | 真基线(21 句) | 我第一版的假数字 |
| --- | --- | --- |
| 句长 | 中位数 **27** 字、≤40 字 **76%** | ✗[…](那是摘要) |
| 签名语气词[…] | **0%** | ✓ 碰巧对 |
| […] | **10%** | ✓ |
| 报账腔[…] | **0%** | ✗[…](那是提取器的输出格式) |
| 情绪强度(排掉桥记账行) | 平均 **3.69**,78% 落在低两档 | 近似 |

**硬结论只有一条**:人格前段写着[…][…],

### 改(v9.0.0 说话方式,rev 3)

| 步骤 | 改了什么 | 为什么 |
| --- | --- | --- |
| **A+B** `lib/persona.js` | […]→[…];例句**冷热各半**(加[…][…]);新增[…]一条(语气词 + 叫[…]+ 冷硬不是你的样子) | **示例决定语域,形容词不决定**;而且那句[…]和它自己的铁律打架(铁律说锋利只给恶意挑衅) |
| **迁移** `lib/persona.js` | 旧后缀逐字节冻成 `REV2_SUFFIX` 进 `KNOWN_STALE_SUFFIXES`,`DEFAULTS_REV` 2→3 | 老规矩:历史默认永不修改;rev 2 的装机下次装机能升,他**编辑过**的文件永远是 `user`(插件不许覆盖他写的字) |
| **C** `lib/index.js` | `echo:rules` order **10250 → 10275**(晚于记忆/心情快照 10260);新增 `echo:voice`(**10280**,最后读到的三行) | 尾部才是锚点:原来最后读到的是[…]+[…]。代价是那段落在快照之后、~1000 字的提示词缓存不再命中(≈全长 1%) |
| **D** `lib/context.js` | ① 情绪读数 **0/null 不再当成[…]**(桥的记账行恒 0 → 原来渲染成[…]),改成沿用上一轮、两边都没有就不编强度;② 低两档措辞改暖:[…]→[…]、[…]→[…];③ 行为要求尾巴补[…] | 78% 的轮次落在低两档,她每轮都在读[…] |
| ~~E~~ | ~~relay 包装语 + 她的[…]腔~~ | **撤回**:她的话里报账腔实测 **0%**,那 38% 是提取器字段的假象。没证据的改动不做,只留一条[…]的预防条款在尾部自检里 |

### 顺手修掉一个**假绿**(比上面的改动更重要)

### 电池

### 现场状态(2026-09-26 15:5x)

- **人格已立刻生效**:`POST /api/echo/persona` 写的是插件自己的写者,不必等重载;
- **lib 侧的改动等她下次唤醒**:装机指纹 `055db9c2b83a`(仓库 = 装机 ✓,32 文件),
- 复量:`npm run voice -- --since 2026-09-26T15:50:00Z`;核对人格送达:
- 待核对的现场锚点:改动前那行是[…][…];

## v0.17.0 — 2026-09-25(核心归位 DSH · 进行中)

### 洁:仓库卫生一次清干净 + 常驻报告工具(2026-09-26,他让「把用不着的文件删掉」)

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

| 处置 | 东西 | 依据 |
| --- | --- | --- |
| **删** | `docs/astrbot-audit-…json`(**3.18MB**) | R1 合并的原始输入;可读版 `.md` 仍在 docs/,内容在 git 历史 |
| **删** | 11 处没用到的 import | `lib/index.js` 4 处(快照逻辑搬进 `turn-snapshot.js` 后留下的 `renderLongingLine` / `renderSharedContext` / `latestDirectUserText` / `positiveOverrideVector`)+ 7 处散在 scripts/tests |
| **删** | `install.log`、5 个 `__pycache__/` | 未跟踪的运行痕迹 |

**保留没动**的:`docs/PLAN.md`(v4 总架构,A 侧适配器代码仍指着它)、

2. `archive/README.md` —— 归档规矩 + 每一份东西的归档理由 + 删掉的东西去哪找。

### 修:注入文本里的四处语病(2026-09-26,他要我「分析一下每轮大模型输入的语言」)

| 位置 | 现场读到的 | 病 |
| --- | --- | --- |
| `lib/context.js:157` | `按你们一贯的相处方式对待TA` | 模板里字面写死了 `TA`,同一句里其它三处都走 `${alias}`,只有它没走 |
| `lib/context.js:194` | `疲惫 2 /10(有点累)` | 数字与 `/10` 之间多一个空格(旁边的[…]没有) |
| `lib/context.js:92/196` | `心情心情不错(+2)` | 行模板加了[…]前缀,档位短语本身**也**以[…]开头 |
| `python/engine/retrieve.py:262` | `(Echo,的设,设计,计灵,灵感,感很,很大,…)` | 把**检索打分用的**关键词渲染给模型看了 |

**证据链**:
- 新用例 `tests/context.test.js`[…]+ `python/tests/test_retrieve.py`
- **破坏性验证**:把四处逐字退回旧写法,`node --test tests/context.test.js` 红、
- **端到端**:`node scripts/smoke_engine.mjs` 打出来的注入行是
  **没有**那个括号 —— 证明 worker.py → render_episodic 这条链真的通了。
- 顺带一条**算术事实**(留给以后别踩):档位表是[…]语义,所以

**上线时点**:装机后插件**没有立刻**热重载(见下一节的纠偏)。15:06:02 那次重载

### 修:你在 DSH 里说的话被推到了 QQ(2026-09-26 现场,他先问「为什么」)

1. **触发点**:本插件每一轮都注入一条 `form:'snapshot'` 的记忆/心情快照(会话流
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
2. **后果**:`lib/relay.js` 的 `finishTurn` 据此判 `kind='proactive'`,而主动那条分支
3. **为什么偏偏 13:19 开始**:12:52 我为[…]给那条路补了**全库兜底**

- **判据抽成纯函数** `lib/relay.js: marksProactive(source)` + `VOICE_FORMS` 白名单
- **有来路的轮次不吃主动章**:`initiative = (proactive|reminder) && origin === undefined`。
- **双发闸提到分支之前**:`usedTool`(她这一轮已经用手说过话)一律早退,主动轮也吃这条。
- 顺带:来路改成 `finishTurn` **一进来就吃掉**(哪怕这一轮没有正文)—— 否则陈旧来路

### 改:记忆/心情快照不再每轮追加,改走系统提示词的一节(2026-09-26,A 案)

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

| --- | --- | --- | --- |
| Echo 记忆/心情快照(`form:'snapshot'`) | 62 | 57,105 | 67.6% |
| Echo 心声/提醒注入 | 8 | 6,107 | 7.2% |
| 她的回复 | 101 | 6,294 | 7.5% |
| 系统提示词(8 条节点、7 次 replace) | 1 | 10,003 | 11.8% |
| **他讲的话** | 67 | **625** | **0.7%** |

- 算法搬进新模块 `lib/turn-snapshot.js`(可离线测),`lib/index.js` 只留接线
- **新鲜度**:检索要拿[…],而组装发生在 `agent/pre-step`
  **之前** ⇒ 查询词改在 `agent/inbox/claimed`(claim 之后、组装之前)记下,
- 代价(他认了):系统提示词每轮都变 ⇒ 前缀缓存每轮失效。

**破坏性验证**:换回旧 `lib/index.js` ⇒[…]那条红,换回新实现即绿。

### 加:构建指纹 —— 「活着的到底是哪一版」不再靠猜(2026-09-26,审计第一条)

**改完 `lib/`,没重启 `dsh web`,跑的还是旧代码,而没有任何地方会告诉你。**

- 新模块 `lib/build-stamp.js`:`lib/*.js` 内容的 sha256 前 12 位 + 文件数 + 最新
- `echo_status` 与启动日志各带一份(`echo: build <12hex> (<n> lib files, v0.17.1)`)
- `tests/build-stamp.test.js` 6 条(确定性 / 改一字节就变 / 改名也算 / CRLF 不算 /
- **破坏性验证**:摘掉 schema 里的 `build` 声明(宽 payload 仍留着)⇒

### 遗弃老链路:收尾计划 + 归档脚本纳进两份老配置(2026-09-26)

**[…]**:AstrBot **框架**必须留着当嘴和耳朵(平台凭据/协议/限频/身份 → 判据②),

- **老脑确实不写了**:A 侧五表 `136/9/4/26/28` 自冻结基线(09-26 01:25)起**零增长**,
- **老脑还[…]**:老插件 `astrbot_plugin_memory_middleware` 代码与 51 项配置留在
- **卫星还在写**:`astrbot_plugin_agent_state` 的 `state.db-wal` 1.25MB、**13:42 还在动**。

### 设置区再瘦一轮:审计流也撤,调参搬进网页(2026-09-26 他追加的)

- `tests/settings-fields.test.js`(7)—— 字段表 × `SETTINGS_DEFAULTS` 键集必须完全对齐。
- `tests/web-dashboard.test.js`(7)—— DOM 替身 + 假 fetch 把 `web/app.js` 真跑起来:

### 设置区只留开关与状态:六个看板搬去网页仪表盘(2026-09-26 他的裁定)

**POST /api/echo/\* 端点一个没删** —— 网页仪表盘用的就是同一批端点,撤的只是

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

### 「清空上下文」按钮 + 她自己的那只手(2026-09-26 他点单)

| 宿主的手 | 插件能不能用 | 为什么 |
|---|---|---|
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
| `sessions.create(id, opts)` | ✗ | […]:插件一卸载会话就消失;而且不进 agent 生命周期就**不落盘** |
| `agent/pre-step` 的 `PreStepDecision.messages` | ✗ | 那是[…],碰不到历史 |
| `ctx.compaction.compactNow(agent, signal)` | **✓** | 宿主 `/compact` 走的就是它;`selectCompactableRange(session, measure, **0**)` ⇒ 旧历史整段压成一条摘要 |

- `POST /api/echo/context/clear {sessionId}` —— 面板 ⚙️ 范围 段一条会话一个
- **`echo_context_clear` 工具** —— 她**自己**也能清(语气被旧回复带偏、会话太长快
- 判据与人话在 `lib/context-clear.js`(纯函数):`cleared` / `nothing`(宿主原话

**验到哪一步(诚实版)**:`check:tools` 9/9(新工具过了宿主真实 `defineTool`);
**没验到的**:面板按钮那条 HTTP 的真压缩效果 —— GUI 的 `/api/*` 要浏览器凭据

### 现场:她跑了一整天的「默认 Echo」—— 我上午那句「人格没丢」是错的(2026-09-26 下午)

| # | 时间 | 含他写的[…]吗 |
|---|---|---|
| #1–#6 | 9/23 15:50 → 9/26 02:18 | ✗ —— 里面是插件**默认**那 275 字([…]) |
| #7 | 9/26 **13:06:38** | ✗ 还是默认 |
| **#8** | 9/26 **13:08:02** | **✓ 他的前段第一次进来** |

1. **机制的证据不等于文本的证据。** 上午我核的是 section 注册 + 会话开关 + 白名单
2. **判据不该靠耳朵。** 新 `npm run check:persona` 从真实请求体里读答案(见下)。

### 前段挪到尾部(order 100 → 10245,2026-09-26 他拍板 B)

### `npm run check:persona` —— 「她真的带着我写的人格吗」变成机器可验

| 判 | 含义 |
|---|---|
| ✓ 已生效 | 最后一条 system/message 里含当前前段 + 后段 |
| ✓ 已送达 | 不在最后一条 system prompt 里,但出现在它**之后**的事件里(宿主用 `systemPromptUpdate:[…]` 把改动放进历史) |
| ⏳ 等下一轮 | 最后一次组装**早于**人格保存 —— 她还没轮到,不算错 |
| ✗ 对不上 | 保存**之后**组装过,可那一次的 prompt 里没有当前人格 —— 要报警的那一种 |

### 现场:QQ 上说的每一句,记忆都没注入(2026-09-26,他问「上下文注入是不是没注入角色人格」)

**他怀疑的方向对了一半,而真相比人格更严重。**([…]这半句当天下午就被他推翻:

**两条都开**,所以人格、铁律、以及[…]那段(index.js:930)

| 轮次 | 画像 | **记忆** | 情绪 | 状态 |
|---|---|---|---|---|
| 本地会话(他在 DSH 里说) | ✓ | **✓ 1700~2200 字节** | ✓ | ✓ |
| **QQ 进来的那一轮**(#162/165/168/169/173) | ✗ | **✗ 空** | ✓ | ✓ |
| 心跳/她主动开口那轮(#175/176) | ✗ | **✗ 空** | ✓ | ✓ |

**根因**(index.js 的老判断,现在搬进 `lib/turn-query.js`):

**修法**:

- 引用/致谢见 `ACKNOWLEDGMENTS.md`
2. 桥注入时带上 `rawText: env.text`(**他打的原话**,不带[…]包装);
3. 心跳 `deliver(agent, text, queryText)`:提醒用他下的那件事、关怀用她挑中的那件
4. 两条纪律写进模块注释:**绝不拿我们自己的注入(`form:'snapshot'`)当查询词**

**验证**:`npm test` **297 pass / 0 fail**(新增 `tests/turn-query.test.js` 9 条:

**现场可验**:重启后 QQ 上再跟她说一句,审计里那一轮的 `injected_memories`

### 现场:12:45 那次主动关怀没到他手机(2026-09-26,他问「你觉得是什么原因」)

**证据链**(先排除[…]):

| 时刻 | 证据 | 说明 |
|---|---|---|
| 12:45:39 | `audit_logs` `tool=care` in=`(想念主动关怀)` | 心跳**确实**把她叫起来了 |
| 12:45:44 | `conversation_log` turn 71,sid=`a165b0d0…`(**网页会话**),channel 空,[…] | 她**确实**开口了,而且是对着他说的 |
| 12:45 之后 | `relay_outbox` 最新一条仍是 **#23 / 02:50:36 kind=reply** | **队列里一个字都没有** |
| — | 审计里**没有** `relay_proactive` 行 | 连[…]都没留痕 |

**根因**(我自己埋的不对称,`lib/relay.js`):关怀锚在
**静默**返回 —— 所以他只能来问。

**第二个洞(同一条路上顺手修的)**:`finishTurn` 解析渠道时**没按 `enabled`

**修法**:`finishTurn` 的渠道解析改成与 `say()` 同规格 —— 先会话自己的

**不看**它绑没绑平台聊天」;关怀同理:**她够得到他的手机,不该取决于上一句话

**验证**:`npm test` **288 pass / 0 fail**(新增 3 条:① 现场重演 —— 主动关怀锚在
**但有审计+日志**,文案含[…];③ 面板关掉的渠道不发)。

### 补:宿主的能力声明(2026-09-26 03:xx,他问「为什么 4.1 flash 不能识图」)

**先纠正一个误判**:那次[…]不是学校网关那条路 —— 真实记录是

- `1845`:`if (containsImage && !model.input.includes([…])) throw …` —— 图片在
- `682`:`input = declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput]`
- `906`:`DEFAULT_INPUT = [[…]]`;`292`:`declaredInput`:空数组 = 没声明;
- `900` 的注释是这套设计的自白:「**没有东西能去问网关它支不支持图**,而两种答错

**直连网关实测**(用他的 key,自造 32×32 纯红 PNG,每个模型一次):

| 模型 | 结果 |
|---|---|
| `deepseek-v4.1-flash` | **200**,reasoning 原文[…]⇒ 看得见 |
| `deepseek-flash` | 200(收下了;content 空是 max_tokens 被 reasoning 吃掉) |
| `glm-5.3` | **400** `content[1] has invalid field(s): text, type` ⇒ 这条路由不收图 |
| `deepseek-v4-pro` | 401(该 key 的模型白名单里没有它) |

**改法**(`~/.dsh/settings.yaml`,已备份为

### 她的眼睛:图不再落进旧脑子(2026-09-26 03:xx,他问「图片走的是什么链路」)

1. `message_str` 只拼**文本段**(`aiocqhttp_platform_adapter.py:231-252`),
2. 于是适配器第一道闸判 `empty-text` → **静默丢**(debug 级日志,INFO 里看不见);
3. 而适配器只有**转发成功**才 `stop_event()` —— 这条图继续往下走,落到

**也就是说:文字归她,图片归旧脑子。** 他发的偏偏是最需要她真看见的那一类。

**他拍的**:C 路线(真多模态,图进上下文)+ **支持 URL**;`deepseek-flash`

- **A 侧**(`relay_core.py` / `main.py`):`images_of()` 把消息链里的图归一化成
- **D 侧**(`lib/eyes.js` 新):抓字节(url/path/base64)→ **只信字节头**嗅探
- **不静默**:抓不到或落不了库 → 退回纯文字,并在正文里写「有 N 张图没抓下来:
- **顺带堵住旧脑子**:图现在能成功转发 ⇒ 适配器 `stop_event()` ⇒

**单位电池抓出一个真 bug**:纯图消息没有正文,幂等兜底只用[…]时,
- 引用/致谢见 `ACKNOWLEDGMENTS.md`

### 回执:成功时别带 `reason: undefined`(2026-09-26 02:5x,他现场报的)

- 新增 `lossless()`:值为 undefined 的键**根本不出现**,所有出口统一过一遍;
- 成功时没有 `reason` 键;失败时一定给得出人话原因;
- 他顺手指出的埋雷一并拆:`relay.say()` 成功会带 `kind`,而 `resultSchema`

**机制上堵这一类**:宿主对工具输出有**两道**校验 —— schema 与无损 JSON。

**并验证这套检查真有牙**(不是又一只自检骗子):把老 bug 原样塞回去 →

### 她的手不该由「窗口有没有绑 QQ」决定(2026-09-26 02:2x,他拍的)

- `relay.say()`:本会话没绑平台时**退到全库渠道**(`relayListChannels` 里
- […]现在只在一个聊天都没绑时出现,文案改成说人话:
- 自我认识段(`echo:relay`)不再要求本会话绑了平台:没绑时改说
- 门的判据仍然只有两条:**桥在跑** + **这个会话里插件开着**(`sessionEnabledOf`)。

**真库实测**(不等重启,直接拿新代码跑活库):

### 现场:echo_status 一直是坏的(2026-09-26 02:1x,取证时才撞出来)

### 产品模型归位:QQ 是她「调用」的工具,不是她的嘴(2026-09-26)

**① 给她两只手(工具)**

| 工具 | 干什么 | 约束 |
|---|---|---|
| `echo_qq_say` | 在 QQ 上跟他说一句 / 把话带到别的聊天、群里 | 只在桥在跑 + 会话在她射程内时注册 |
| `echo_qq_call` | 主动喊他(想他了、到点的关怀) | 走主动那条路:范围闸(默认只私聊)+ 保鲜期 |

**② 让她知道自己有手(常驻自我认识)**

**③ 回话归她决定(裁定:默认不再自动送)**

- 入站那一条**当场**附一行[…],就贴在她正在读的话旁边;
- 轮末记一笔日志[…]—— 漏回是可观测的数字,不是静默;
- 面板开关一句话能翻回自动送(`lib/client.js` 的传话卡)。

**④ 主动关怀 = 真的[…]**

**测试**:JS 270(+6 工具层:两只手/回执说人话/三道门/chat 指定;+6 桥层:

### 现场修的两条:QQ 会跟着 DSH 说话、新会话接不上别处的话(2026-09-26)

**① 在 DSH 里对着伴聊会话说话,QQ 也收到那条回复。**

**② 在 DSH 新开一条会话跟她说话,她说不出另一条会话刚聊过的事。**

**[…]**(标记短语在范围闸之前执行,新会话没聊过也能开门),

### 现场:切换完成 —— 嘴接上了新脑子(2026-09-25 01:3x)

- **01:20:16 老插件停用** —— `astrbot_plugin_memory_middleware`,AstrBot 自己打的
- **01:22:38 适配器 `enabled` 改 true**(备份 `…json.bak-enabled-false-20260925`)。
- **01:33:31 重载适配器** → `[echo_relay] 接管中 → http://127.0.0.1:3080(platform=qq, 轮询 2s)`。
- **01:34:14 真实闭环**:他私聊一句 → 入站 `relay_inbox_seen{msg_id:[…],

**归档 A 侧**(`npm run retire -- --apply`,现在已放行)。归档建议等验收过了再动:

### 自检:让 `preflight` 说清「谁在跑」,而不是「文件里写着什么」

- **`data_v4.db` → `preferences.inactivated_plugins`** —— 这是[…]的
  **权威答案**(`star_manager.turn_off_plugin` 往里加、`turn_on_plugin` 里删)。
  **分辨不出[…]** —— 我先前拿它判断,现场就把它当成了[…]。
- **适配器自己打印的启动行**(`logs/backend.log`)—— 运行中那份到底说的[…]
  **硬伤**(一句话会被答两遍、记忆写两份)。
- 顺带修掉一个读错键:平台地址读的是 `relay_base_url`,而配置里叫 `dsh_base_url`
- 新测试 `tests/preflight.test.js`(6 项)把这几条判断钉住,夹具用**真 SQLite**

### 预演:A 侧适配器的真代码 × 活着的桥(把中间那层空补上)

**我写的请求**而不是**它要发的请求**。

### 事故:桥的开关我写错了格子 —— 插件读 `settings.relay`,我写在顶层

**这是[…]的那类错,而且两个自检脚本当时都在报绿。**

- **症状**:他重启 `dsh web` 后,状态面里有了 relay 块(新代码确实生效了),
- **根因**:开关住在 `config.json` 的 **`settings.relay`**
- **为什么两个脚本也在骗人**:它们的 `readRelayConfig`/preflight 都读 `cfg.relay`
  **读错一格比读不到更危险**:报错会让人去查,假绿会让人以为查过了。
- **修**:① 用仓库自己的 `writeSettings({ relay: {...} })` 把令牌与总闸写进
- **不用重启**:配置文件是**每次调用现读**的(`readSettings` 零缓存),所以改对之后
- **回归测试**:`tests/toggle.test.js` 补两条(写进 `settings.relay` 能读回;
  **顶层 relay 块必须被忽略**),`tests/relay-config-path.test.js` 补三条(两个脚本

### 现场验收记录(2026-09-25,他自己强制重启后)

| 验的是什么 | 结果 |
|---|---|
| 入站受理 + **权限预设真的解析上了** | `200 {[…]:true,[…]:true,[…]:[…],[…]:[…]}` |
| 同一 `msgId` 重放 | `200 {[…]:true,[…]:false}`(没再注入) |
| 渠道面(适配器启动自检用) | `200`,一行 `qq:<your-qq> [private] 启用,label=QQ:私聊,session=session-echo-companion` |
| **她真的答了** | 第 2 秒出站队列里出现 `{[…]:1,[…]:[…],[…]:[…],[…]:[…]}` |
| 销账 | `ack {[…]:true,[…]:1}` —— 测试回复**没有**发到 QQ(我把它销掉了) |
| autoScope | `whitelist` 里自动多了 `session-echo-companion`(桥第一次拉会话时开的) |
| A 侧行数 | 纹丝不动(136/9/4/26/28)—— 这条测试消息的记忆只写进了 DSH |

### R1 增量合并:A 侧后来多长出来的那点,一条不少地搬回来

- **新增 `scripts/merge-astrbot.mjs`**:默认 dry-run 出清单,`--write` 落库
- **三条比原规格更严的地方**:
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- **新增 `lib/thread-dedupe.js`**(悬置话题规整与去重的 JS 镜像,权威实现是
- **实测**(2026-09-25):A 侧 134 条记忆 / 26 节点 / 28 边 / 8 条 open 话题 /
  **复跑全 0**(幂等验收通过),合并后体检:203 行 / 28 节点 35 边 / 悬置话题 10 /
- **A 的 200 行审计导出留档**(`docs/astrbot-audit-*.md` + `.json`),**不并库** ——
- **不搬**:想念值(DSH 是活脑,拿旧值等于让她倒退回搬家那天的心情)、
- **已知且有意**:合并进来的 8 条话题 `session_id` 留空(体检 ⑥ 会报[…])
  **不该在 DSH 里补发**。这 8 条只会作为[…]出现在注入里。

### R2 DSH 侧传话桥:她终于能听见 QQ,而核心一行没搬出去

- **新增 `lib/relay.js`(零宿主依赖,可离线测)**:信封校验(协议版本/平台/聊天/
- **三张新表**(`relay_channels` / `relay_outbox` / `relay_inbox_seen`):
- **四个端点**:`POST /relay/inbound`(幂等)、`GET /relay/outbox`(带租约)、
- **幂等不靠内存靠库**:先落 `pending`,注入成功才 `accepted`;重放同一条只答一次;
  **她忙(拿不到维护锁)→ 503 并撤掉受理**,适配器按 `msgId` 重试不丢消息;
- **一个会话多张嘴的坑**:D1 定了全平台共用一个陪伴会话,于是回复不能按
- **主动话有保鲜期**(默认 5 分钟,过期丢弃不补发),回复没有 —— 迟到的关怀不是关怀,
- **总闸默认关**(`relay.enabled=false` + token 空),而且闸门在**最前面**:
- **接线细节三则**(都会静默出错,所以写下来):①中继消息也带
- **会话解析走宿主的 `sessionController.create({sessionId,cwd})`**:与 GUI 建会话
- **权限预设 `read-only` 起步**(待拍 #10 的推荐默认):工具不精简(已拍),权限就是
- **权限套不上就拒绝服务,不 fail-open**:配置点名要某个预设而宿主给不了
- **面板新增[…]卡**(桥通断/陪伴会话/主动范围/队列水位/逐渠道的三个开关)与
- **验收**:JS 测试 226 项(新增 27)、Python 189 项(含后来补的 DDL 同源守卫)、`smoke_relay` 27 项全绿;

## v0.17.1 — 2026-09-25(核心归位 DSH · R3 传话适配器)

### R4 备料:验收手册 + 只读探针(切换本身等人手)

- **新增 `docs/R4_ACCEPTANCE.md`**:切换顺序(基线 → 重启 → 开桥 → 装适配器 →
- **新增 `scripts/relay-accept.mjs`**(`npm run accept`,只读):桥状态 + 渠道面 +
  **A 侧行数漂移** —— 核心归位的硬标准是「她继续在 QQ 上说话,记忆只许写 DSH 的
- **一个反直觉但必须写下的操作细节**:停用老插件要**整只停用**,不能只把

### 真库迁移彩排:他重启那一秒会不会出事,先拿副本练一遍

**老版本插件建的**。单元测试与冒烟用的都是临时库 —— 「新版代码打开真库的那一刻

- 先用 `VACUUM INTO` 从真库拉一份**一致快照**(库正被写也安全;拿不到就退回三件套
- 打开快照前后逐表比行数 —— **原有表一行都不许变**(迁移不是重建);
- `integrity_check`(在真库上只读跑)+ `journal_mode`/`page_size` 体检;
- 三张桥表在**这份真库**上入队 → 领租约 → 销账走一遍(真读真写,写的是副本)。

**实测(切换前,线上库)**:0.39MB / WAL / 4096B page、`integrity_check` ok、
**三张桥表早就在库里**(之前跑合并脚本时 `openStore` 落过 DDL)、原有 **16 张表

1. **桥表形状不对 = 新插件装不上,不是[…]**:夹具里把 `relay_outbox`
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
2. **`openStore` 假定库是自己的那份形状**:夹具里用简化表结构(而不是真 DDL)建的

### 壳 × 真宿主:20 项胶水测试(顺手补上「出站这条链」的字段契约)

- `EchoRelayPlugin(fake_context, cfg)` **实例化**、`await initialize()` ——
- `context.platform_manager.get_insts()` 的返回形状(`meta().id`)、
- 喂入站事件、看它**发什么 HTTP**:信封形状(`v`/`platform`/`chat`/`sender.isMaster`
  **固定模板**兜底话(不静默)、重复投递(`200 + duplicate:true`)不重复计数。

**出站那条链后来也补进了同一组测试**(这是最容易[…]而没人发现

- 出站**请求参数**(`platform`/`limit`/`lease`)与**载荷字段**
- `/channels` 的驼峰行(`chatId`/`chatType`)决定 umo 的类型段 —— 群里的话必须回群
- 长回复按 `maxChars` 切段、**顺序不变、一个字不丢**、一个条目只销一次账;
- 同一回合同一聊天被重复投递(租约重投)→ 本地防重发挡住不复读,但**要销账**
- 发不出去的东西在 `send_max_attempts` 次之后**放弃并销账**,不永远占着队列。

**租约过期后能重新领到**(= 验收第 7 项[…],以前只测了「租约期内

**一个自己踩的坑,记下来**:第一次跑这组测试时,AstrBot 的库往**当前工作目录**

### 归档那一步也交给脚本 + 基线要记两次(实测抓到「切换前还在长」)

**① 增量合并跑了一次真的**:R1 合并到现在,A 侧又长了 **2 条记忆**

**② 新增 `scripts/retire-a-side.mjs`(`npm run retire`)**:第七步原来写的是三条手敲

- **默认 dry-run**,`--apply` 才动手;
- **备份先行**:改名之前把两张库连同 `-wal`/`-shm` 原样拷到
- **写清单**:文件名/大小/mtime/sha256/行数 + 逐条 `rollback` 改名命令 →
- **A 侧还在写就拒签**:判据是**两次采样之间行数还在长**,或 **`-wal` 在 90 秒内
- 与**切换前基线**的差异降级成**提醒**(切换前它本来就该在长),不然会误拦。

**③ 基线要记两次**:`--snapshot` 现在会把上一份基线自动留档成

### 切换前自检 + 「重启后她主动开口还发得出去」补了一个洞

**① 新增 `scripts/r4-preflight.mjs`(`npm run preflight`,只读)**:把「切换那天

- AstrBot 写的 `cmd_config.json` **带 UTF-8 BOM**(实测头三字节 EF BB BF),
- 白名单不在顶层,在 `platform_settings` 段里(两个位置都认,免得换版本误报);
- 首次跑就报出一条**假警报**并被我改成提醒:whitelist 模式下陪伴会话[…]
- 它顺带查出了本机的平台实例:`Echo(aiocqhttp)`。

**② […]的洞**:出站队列里只有 `chatId`,而发送 API 要

**③ 顺手止血**:老插件的提醒循环从 19:32 起刷了 **656 次**

### 面板 ↔ 设置项也有契约测试(防「拨了没反应」)

### 适配器的「包装」也有守卫 + 宿主 API 逐条对真机核对

- **安装清单 ↔ 目录逐项对齐**(`scripts/install-adapter.mjs` 的 `FILES` 是硬编码的);
- **元数据必填项**:AstrBot 的校验只要 `name/desc/version/author` 非空
- **薄壳纪律的源码扫描**:`main.py`/`relay_core.py` 里出现 `sqlite3`/`text_chat`/
- **面板配置项 ↔ `DEFAULTS`**:键与默认值都不许漂(用户会看到不存在的开关);
- **装着的那份是否与仓库逐字节一致**(没装则跳过)—— 这条当场抓到一次真事故:

### 「两边 DDL 必须同步」从君子协定变成会红的灯

- **传话三表逐列相等**(列名/类型/非空/主键/默认值):它们是**纯镜像**
- **共有表:引擎列 ⊇ JS 列**(引擎有扩展列是设计,少列才是漂);
- **壳侧专属表名单是精确集合** `{conversation_log, diary, user_profile}` ——
- **先证明灯会亮**:一条自我校验测试故意抠掉 `expires_at` 列,断言比较函数
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- 顺带对齐:`busy_timeout = 5000` 两边都得在(共享灵魂库的多进程并发安全靠它)。
- 探针的提示也修得更准:渠道面取不到时,若状态面里连 `relay` 块都没有,

### 答辩材料补上「核心归位」这一章 + Tier2 图谱合并落地

- **`docs/DEFENSE.md`**:技术叙事新增[…]
- **Tier2 图谱合并落地**(用户点头的 7 条):`助手→Echo`、`AI记忆架构/记忆架构/
  **悬空边 0 / 指向墓碑的现役边 0 / Tier1 待并 0 / Tier2 待并 0**。

### R3 A 侧薄壳:她的大脑一行都没搬过来,只多了一张嘴和一对耳朵

- **纯逻辑与宿主壳分层**:判定/分泡/退避/会话标识推导全在 `relay_core.py`
- **契约表写进代码**:`classify_inbound_status()` 把桥的应答翻成动作 ——
- **白名单自己实现**(D2):主人名单为空 = **谁都不是主人**;群友的消息在适配器
- **幂等键 = 平台原生 `message_id`**(拿不到才按[…]兜一个哈希)。
- **分泡一个字都不丢**:长回复按句末标点切段(默认 500 字、间隔 1s,DSH 下发的
- **重启后还知道往哪发**:出站条目只有 `chatId`,而发送 API 要 umo。适配器从每条
- **至少一次,不是恰好一次**:领走带租约、发成功才 ack(适配器崩了租约到期会再放
- **装上 ≠ 切换**:默认 `enabled=false` + 令牌空 = 待机(完全放行原生链路,等于没装)。
- **顺手对齐契约参数名**:出站领取的租约参数契约里叫 `lease`(适配器按它发),
- **验收**:适配器离线电池 29 项全绿;JS 226 项、Python 189 项、`smoke_relay` 27 项

## v0.16.0 — 2026-09-25

### 记忆修理:图谱与记忆终于对得上

**病因与现场证据**在 `docs/MEMORY_ARCHITECTURE.md`。

- **M1 边有依据(可回指)**。`graph_edges` 新增 `evidence TEXT` 列:写入时把
- **M2 实体归一**。新增 `graph_aliases` 表 + `lib/graph-aliases.js`(纯规则,体检/
  **写入侧预防**再长出新碎片。分级:Tier1([机构]→西安电子科技大学,高置信同实体)
- **M3 近重复闸(写入侧)**。新增 `python/engine/dedupe.py`(权威)+
- **M2-b 提示词递名单**。反思提示词里先给一张[…]表(图谱度数前 20),
- **M4 画像不再说谎**。`user_profile.name` 实测是**字面量 `'null'`**(模型把
- **M5 面板说实话**。图谱卡与 `/echo/` 图谱页:点边/点节点看[…]→ 点编号
- **体检脚本**。新增 `scripts/memory-doctor.mjs`(只读,`--json` 可机读):六个

**升级注意**:`lib/` 与 `python/` 的改动需要重启 `dsh web` 才生效(面板静态页

## v0.15.1 — 2026-09-25

### 运维面:能清、能修、能导、能调

- **整库清空(G14)**。工具 `echo_memory_clear` + `POST /api/echo/memory/clear`
- **悬置话题的人工动作(G15)**。`echo_threads`(list/done/add) + 面板话题卡的
- **对话导出/复现包(G16)**。新增 `lib/export.js` + `GET /api/echo/export?
  **复现包的核心承诺是[…]**,所以[…]
- **索引与老库回填(G20)**。三个索引补齐(槽位取代链不再扫全表)。两处实现细节
  **每轮强制注入**的核心记忆(实测一条 I=80 的记忆被抬成[…],问
- **面板小项(G22)**。情绪面板补上 `current_topic`/`session_id` 并**按组列全**
- **配置面板(G24)**。`GET/POST /api/echo/settings` + 设置区调参卡:注入条数、

## v0.15.0 — 2026-09-25

### 人格体检与开口质量:她自己会发现「刚才那不像我」

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

- **人格漂移检测整链**。新增 `lib/drift.js`:最近 4 轮滑动窗口 → 每 8 轮
  **注入两次**(中间夹 `[锚点重注入]`)、情绪滤镜多一行临场修正写明原因;
- **别名接地**。他的昵称/外号都指他本人 —— 注入行照 A 的实体接地:
- **JSON 修复阶梯**。批三道:①原样解析 ②转义字符串内部的裸控制字符

**156 pass / 0 fail**(新增 drift 7 条、jsonfix 5 条、context 2 条)、

## v0.14.5 — 2026-09-25

### 情绪动力学与记忆治理:她终于会「随时间」变,库也终于会「减」

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

- **新增 `lib/emotion.js`(情绪的数据与动力学)**。11 维范围、默认向量、
  **未触及组回填**:本轮没被提到的维度保持不动,而不是被 LLM 的沉默清零。
- **情绪时间衰减**(G2)。`emotionDecayTick` 挂在既有 60 秒时基上,自带
  **不跟电源闸**(衰减是时间流逝本身,不是她[…]—— 休眠一周醒来
- **记忆 TTL 治理**(G4)。`episodic.cleanup_stale`:超 `memory_ttl_days`
- **审计裁剪 + 六列**(G5)。`trimAudit` 默认留 **100** 条(本仓定案;
- **主动轮哨兵**(G10)。她主动开口那一轮没有用户发言,旧实现把用户侧记成
- **关怀/提醒的 framing 纪律与接地字段**(G8/G9)。提醒补 15~40 字预算、
  **人格锚点、称呼、客观时间、她此刻的体感、他最近的心情**。少了这些,

**162 OK**(新增 TTL 治理 2 条)、`smoke_web` 全绿、`install.mjs` 校验通过。

## v0.14.4 — 2026-09-25

### 接线修复:把「引擎早已就绪、壳没接上」的四条线接起来

**做好了没人调** —— 本版专治这一类,外加两个小而实的修复。修法与数值
- 引用/致谢见 `ACKNOWLEDGMENTS.md`

- **反思整固(信念层)接线**。引擎侧整层早就齐了:`reflection.py` 提示词
- **时间纪律文本进注入信**。数据侧一直渲染着「2026-09-24 提到,事情发生
- **图谱时钟每轮推进**。`reinforceGraph` 原本「命中边与 LTP 边皆空即
- **配置终于有人喂**。引擎帧一直在读 `frame.get([…])`
- **议程选题喂 vector / interests**。引擎的效用函数一直在等 moody 心境
- **修一个真 bug**:`context.js` 的 `dimLine` 过滤写成

## v0.14.3 — 2026-09-24

### 治「同一件事被记成三条」(两处刻意改良,超出 A 侧)

**历史轮里的事实也重抽一遍** —— 实测一轮之内同一件事落成三条:

- `#133` slot=`echo_persona_goal`[…]
- `#135` slot=`current_project`(被 `#136` 正确退役)
- `#136` slot=`current_project`[…]

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

1. **A 侧也不带[…]**。判定提示词原文是「如果最近**这些**对话
2. **A 侧的键只有 `slot`**(`main.py:821`),而模型给 slot 的命名逐轮

- **① 抽取对象钉在最后一轮**。5 轮窗口留着当语境(指代、情绪来由、
- **② 记忆键 `slot` 退回 `field`**(新增 `judge.py:memory_key_of`)。

## v0.14.2 — 2026-09-24

### 活体验证抓出的两个真 bug(都不是「没接线」,是接线错了)

**① 图谱扩散被单位事故掐死(毫秒当秒)**。F1 上线后实测:注入信里

**照现场形状**传 `now: Date.now()`,并加[…]

**② 排队的反思被自己的清理动作吃掉**。现场时间线:第 17 轮
- 引用/致谢见 `ACKNOWLEDGMENTS.md`

**观察项(未修,记档)**:F3 让 Judge 看到最近 5 轮,于是它会把历史轮

## v0.14.1 — 2026-09-24

### F2 时间锚 + F3 多轮语境 + F4 命令式提醒:反思信封补齐

**F2 当前时间锚**:反思提示词此前**没有任何时间概念** —— 相对时间词

**F3 最近 5 轮对话**:此前只喂当前一轮,[…]与[…]

**F4 命令式提醒**:[…]是**命令**不是判断,而它此前只走 Judge

## v0.14.0 — 2026-09-24

### F1 图谱接线:图终于会读了(联想召回 + 用进长时增强)

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

- **检索侧**:`retrieve` 之后接一发 `graph_query`(直扫种子打底
- **轮末侧**:`graph_reinforce` 回传命中边 —— `apply_ltp` 权重
- **图是增益不是依赖**:`graph_query` 失败只丢图那一段,情景

## v0.13.7 — 2026-09-24

### 反思管线闭环,审查仪器退役

## v0.13.6 — 2026-09-24

### 反思不是挂起,是慢:超时放宽 + 忙时排队补跑

**中途**把它打死了。不是宿主挂起,是我掐死的。

- runSignal 超时 120s→300s:慢模型下给足飞行时间,真挂起 5 分钟
- **忙时不再丢弃**:排队最新一轮(中间轮自然合并),当前反思

## v0.13.5 — 2026-09-24

### 反思零产出的最后一层根因:signal 必须是真 AbortSignal

## v0.13.4 — 2026-09-24

### 反思阶段级探针:两种静默死法的 DB 留证

**完全静默**的:子代理跑完但 structured 缺席(模型把 JSON 当

## v0.13.3 — 2026-09-24

### P0 根因修复:反思子代理缺 parent(宿主契约),mock 漂移堵死

- pre-step 顶部(任何闸之前)把 agent 存进 capture —— 与
- 日记的 parent = 路由 agent(pre-step 优先刷新,agent/created
- 缺 parent 时显式 warn 跳过,不再让 TypeError 沉底;
- **mock 逼真化**:两个测试文件的假 subagents 改为「缺 parent

## v0.13.2 — 2026-09-24

### 图谱激活度现算(「所有节点都处于遗忘状态」的显示层修复)

- 边激活度 = R(Δt,H)×100 现算,Δt 距 last_accessed,H 缺失按
- 节点是结构实体没有半衰期,激活度取最清醒邻边的现算值;
- 物化原值以 `activationStored` 透传(F1 接线后可对照快照 vs 现算)。

**注意:这是显示层说实话,不是机制修复。** last_accessed 冻结在

## v0.13.1 — 2026-09-24

### 记忆机制审查:仪器 + 全量比对报告

- **审查仪器**(装机待读):session/event 各类型到达计数器
- **全量比对报告**(docs/MEMORY_AUDIT.md):以 QQ 网关模式
- 引用/致谢见 `ACKNOWLEDGMENTS.md`

## v0.13.0 — 2026-09-24

### 动态记忆图谱:AstrBot /memory_graph.html 完整移植(用户点名)

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

- **力导向布局**:d3.v7,斥力 -300、边距随权重反比、碰撞
- **视觉编码全保**:节点半径 √权重×6、五类型配色(人物金/
- **交互全保**:拖拽定点(松手融回)、滚轮缩放(.2~5,双击
- **数据面富化**:store.js graphData() 透传引擎超集字段
- **实时**:SSE 审计推送触发增量重载(dataChanged 检测:
- 主仪表盘图谱段挂[…]入口,速览保留。

**测试**:JS 105 → 106(引擎超集字段透传,含取代链/激活度/

## v0.12.0 — 2026-09-24

### 审查台从占位页升格为活数据仪表盘(用户:参考 AstrBot 的)

- 引用/致谢见 `ACKNOWLEDGMENTS.md`
#38bdf8、统计卡阵、向量条、锚点导航)+ 咱们的活数据(fetch

- **📊 总览**:想念值/情景记忆/图谱/心情/对话窗/核心记忆
- **💗 想念**:阈值仪表条(逼近阈值变琥珀、到阈值变红)、
- **🧠 情绪向量**:global/对[称呼]/对群体 三组向量条
- **💾 记忆体检**:DMAE 三态堆叠条 + 时间态 chips + 最近
- **💬 对话回放**(v0.11.0 数据首次上大屏):渠道徽章过滤、
- **🕸️ 图谱**:节点/边统计 + 高频节点 chips + 关系边
- **📋 审计流**:SSE 实时推送(审计落库 → 审计流 + 想念
- **📖 日记**:date + 心情 + 想念值 + 正文;
- **⚙️ 范围**:模式徽章 + 白名单/例外列表(带辨认标签)+

## v0.11.2 — 2026-09-24

### 热修续:审查台占位页渲染错位(三重叠加才暴露)

- **web/app.js 重写**:对齐 statusPayload 真实形状 —— 引擎徽章
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- **API.md 对齐真相**:status 示例改成真实形状(engine 对象 +
- **web/index.html 接口速览**同步补两端点。

## v0.11.1 — 2026-09-24

### 热修:审查台 /echo/ 从 M6-a 起在装机副本上一直 404

- **公式抽成唯一真源**:webpage.js 新增 `webRootOf(metaUrl)`
- **回归门进电池**:webRootOf 单测断言装机位形状
- **装机即验**:install.mjs verify() 用装机副本自己的公式对
- **验证纪律**:装机后活体 curl(/echo/ 与 /api/echo/status)

## v0.11.0 — 2026-09-24

### M8-a「传话架构」第一步:对话记录

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

- **conversation_log 表**:一轮一行(session_id/channel/user_text/
- **写入点**:capture 管线 turn/end 收口(v0.9.1 修活的链路,
  **只有她在线的会话进日志**;关怀轮 user 侧空、reply 侧照记
- **API**:GET /api/echo/conversations?limit=&channel=(倒序 +
- **审查台**:第 12 张卡[…]—— 渠道徽章过滤、你/她

**测试**:JS 100 → 104(滚动窗口修剪/渠道过滤/关怀轮照记/

## v0.10.0 — 2026-09-24

### M8-a「共享灵魂库」双侧最小改:连接前提补齐

- **DSH 侧**(本仓库):store 开库补 `PRAGMA busy_timeout = 5000`
- **AstrBot 侧**(v8.10.1,改前 `.backups` 快照):`initialize`
- **查证结论**(M8-0):双侧库均已在 WAL;双侧 python 连接均已

**测试**:JS 99 → 100(文件库开库即设 busy_timeout/WAL + 二次

## v0.9.1 — 2026-09-24

### 「宿主事件形状」根因修复:session/event 全链路在 live 空转

- **根因**:宿主 SessionEvent = `{ type, seq, time, data }`
- **为什么电池没抓住**:这段是宿主接线代码,零离线覆盖 ——
- **修复**:messageOfEvent 提取进零宿主依赖的
- **连带修复**:echo_status 工具 schema 漏声明
- **修复后 live 恢复的能力**(此前全部空转):对话捕获与反思

**测试**:JS 96 → 99(宿主形状三连:本体/嵌套/边界);Python

## v0.9.0 — 2026-09-25

### M7-a「会话范围」:工作娱乐两不误

- **电源 = 总闸,范围 = 分闸**:config.json 加 `scope`
- **四处会话闸**:人格段(组装时按 scope.session.id 渲染空串或
- **标记短语**:会话里发[…]/[…]即切换当前
- **GET/POST /api/echo/scope**:读范围 + 会话预览(审计里的会话,
- **顺带修真 bug**:v0.8.0 手动操作的审计 traceId 用时间戳当 id,

**测试**:JS 92 → 96(范围矩阵/总闸优先/setEnabled 不抹字段/

## v0.8.0 — 2026-09-25

### M6-c2「记忆手动管理」:记忆库可视化 + 面板写路径(用户裁决开闸)

- **记忆管理卡**(设置区第 11 卡,体检卡之后):state 四态过滤
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
  **状态机按钮**:隔离↔转正、遗忘↔恢复、置顶为核心↔取消;
- **POST /api/echo/memory/edit**:字段级编辑,keywords 收数组或
- **POST /api/echo/memory/state**:六动作状态机。L0 置顶 = 引擎
- **docs/API.md 同步**:两个写端点入契约,[…]

**测试**:JS 90 → 92(编辑:重算 I/H、分隔符解析、审计留痕、

## v0.7.2 — 2026-09-25

### M6-c「设置区跳板」:十卡原样保留,新网页一键直达

- 设置区 Echo 段首加[…]卡:按钮新标签页打开 `/echo/`,

## v0.7.1 — 2026-09-25

### M6-b「API 契约」:记忆浏览器端点 + 队友的开发圣经

- **GET /api/echo/memories**:原始记忆行分页 —— 审查记忆库的只读
- **docs/API.md(新)**:前端队友的开发圣经 —— 13 个端点逐个的

**测试**:JS 88 → 90(listMemories:分页形状与钳位/state 四态/

## v0.7.0 — 2026-09-25

### M6-a「审查台静态页伺服」:前端队友的页面有了生产住址

- **lib/webpage.js**:插件认领 webServer 前缀路由 `/echo` →
- **迭代循环质变**:每请求现读文件 + no-store → 改 web/ → install →
- **安全**:MIME 白名单(白名单外类型不伺服);decode 在 resolve
- **web/ 占位页**:队友的起跑底稿 —— fetch 引擎状态 + SSE 实时
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- **scripts/smoke_web.mjs**:不依赖 dsh web 的伺服冒烟 —— 临时
- install.mjs 拷贝清单加 web;check 清单加 webpage.js 与 app.js。

**测试**:JS 85 → 88(解析纯函数:根路径/MIME/大小写/穿越/盘符/

## v0.6.1 — 2026-09-25

### 「她说话像人了」:声音纪律战斗版 + 默认值迁移(live 反馈驱动)

- **声音纪律 v8.10.0 战斗版进人格**:QQ 终版实测数据 —— 她回复中
- **默认值迁移机制(不迁移,战斗栈到不了用户手里)**:loadPersona

**测试**:JS 81 → 85(战斗版六件套逐条在场 / 分类器:edited 永远

## v0.6.0 — 2026-09-25

### 「她有钟了,她想你了」:对齐 QQ 终版的状态连续性(live 反馈驱动)

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

**纪律**:想念注入 python-only(基线无脉冲削减,注入会造成「只涨

**测试**:JS 77 → 81(钟面/时段边界/想念行门与 pre 语义/信封顺序);

## v0.5.5 — 2026-09-24

### M4-b/c「答辩文档」:演示剧本 + 技术叙事 + README 刷新

- **`docs/DEFENSE.md`(新)**:五幕演示剧本(面板巡展 → 她记得 →
- **README 全面刷新**:从 M1 时代(30 项测试、systemPrompt.context
- M4 只剩 d(npm publish 决策 + 文档定稿)—— 等用户过目裁决。

## v0.5.4 — 2026-09-24

### M4-a「防漂移三件套」:长对话里她还是她

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

- **maid 自检条款**:开口前半秒自检 ——「这话是 Echo 说的还是
- **cosplay 两全尾句**:人设不是干活的障碍 —— 嘴上陪他吐槽两句,
- **roleplay 冲突优先级**:[称呼]此刻的直接指令 > 两条铁律 > 说话

**注意**:若你已在面板定制过人格,三件套不会自动进你的文本

**测试**:JS 74 → 77(三件套在场断言 + 位置纪律 + 原样在场断言)。

## v0.5.3 — 2026-09-24

### M3-d「她写日记」:每晚 22:30,写给她自己的一页 —— M3 完工

- **素材 = 数据,不是印象**:当天审计行(正序,他们聊了什么)+
- **组稿**:subagents 结构化通道(同 EXTRACT 纪律:outputSchema
- **落库**:diary 表(壳拥有的表,同 agent_state/audit_logs 家族
- **面板**:日记卡(最新一页全文 + 更早日期索引),订阅 audit
- **失败语义**:组稿失败这页空着 —— 增益不是依赖,明天 22:30

**测试**:JS 69 → 74(时钟判定含午夜翻转/素材框架含空日子明示/

**M3 全部完工**(a 心跳 / b 工具族 / c SSE / d 日记,

## v0.5.2 — 2026-09-24

### M3-c「SSE 半推」:审计流真推送(A8 裁决落地)

**可行性先证后建**:宿主自带 SSE 先例(HMR 事件流 /plugins/events:

**半推设计**(maid 解构文档的[…]落地):服务端

**纪律**:游标 = 连接时最新时间戳,不重放历史;一个窗口一批事件

**客户端**:面板级 EventSource 单例(卡与卡共享一条连接);审计卡

**测试**:JS 65 → 69(握手不重放/增量批推/关闭回收/卸载销毁)。

## v0.5.1 — 2026-09-24

### M3-b「记忆工具族」:你亲口教她,她亲口忘

- **echo_remember** {text, slot?, core?}:把你说[…]的事写进
  **教过的记很久** —— 用户肯亲口教,就该比推断碎片(≈3)重一个
- **echo_forget** {query}:按主题抹记忆。**只读匹配绝不强化目标**
- **echo_memory** {query, topK?}:主动翻记忆 —— 与 pre-step 注入

**测试**:Python 148 → 154(派生/只读不强化/教翻忘往返/L0 槽位

## v0.5.0 — 2026-09-23

### M3-a「关怀心跳」:她第一次真正主动开口

- 引用/致谢见 `ACKNOWLEDGMENTS.md`
**agent/created 只认根代理,每代理 60s 定时器;runMaintenance 认领

**双通道**:
- **提醒通道**(threads_remindable):你托付的约定到点必发 —— 闹钟
- **关怀通道**(longing + agenda):她的心声。想念三重闸门(阈值→

**心跳三层落地**(原案 → 实建):策略层不用 aura 的 V 公式 —— M2-f

**关怀轮的洁净性**(自然达成,零特判):followup 消息带 plugin

**想念脉冲接线**(M2-f 帧补完):真人消息 → 引擎削减 + 锚点重置 +

**测试**:JS 65(心跳 10 项:双通道因果链/两相提交/会话路由/日上限
**改了 lib/ 壳文件 —— 需要 dsh web 重启 + 硬刷新**(可与 v0.4.8~

## v0.4.11 — 2026-09-23

### M2-i「面板引擎状态行」:M2 完工

- **引擎**:Python 全引擎(worker vX)/ JS 基线(M1 冻结)/ 离线;
- **引擎进程**:运行中/已停止 · 失败/重启计数 · 熔断状态,10 秒
- **待观察(隔离)**行:M2-h 的隔离桶进面板([…]);
- 引用/致谢见 `ACKNOWLEDGMENTS.md`

**M2 全部完工**(a-i 九步,v0.4.0~v0.4.11):Python 全引擎侧车化

## v0.4.10 — 2026-09-23

### M2-h「置信度门控」:她不把没把握的事当真事记

**<0.55 拒收 / 0.55~0.75 candidate 隔离 / ≥0.75 落库**。闸在三层数字

**status 列迁移**(双侧幂等:db.py + store.js):is_active=0 是

**隔离语义**(candidate 隔离):
- 落库 status='quarantined',I 照算(待观察也有自己的消亡速度,
- 检索不可见、反思候选窗口不吃(反思总结她已确信的事,不总结悬案)、
- 不产三元组(三元组自带归因硬门,与候选置信度无关);
- 隔离的 L0 称呼不落画像:隔离就是隔离,0.6 置信不配改名;
- 全隔离轮降级路径照发:情绪是真的,存疑的只是事实。

**晋升/降观察**(episodic.insert_memory 状态感知槽位,JS 侧同款):
- 晋升:同 slot 高置信版本后来居上,隔离行让位(superseded_by
- 降观察:正式行同句已在,弱重观测是佐证 → 强化正式行,不落重复

**可见性**:ack 新增 quarantined 列表与 stats.quarantined;

**测试**:Python 138 → 147(三段分流/缺置信拒收/晋升/降观察/
**改了 lib/ 壳文件 —— 需要 dsh web 重启 + 硬刷新**(可与 v0.4.9

## v0.4.9 — 2026-09-23

### M2-f「想念曲线」:她在你不在的时候想你

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

**数学与文献依据(答辩素材)**:
- 主曲线 M(s)=10·s/(s+H):幂律补曲线,与 DMAE 遗忘同族(Ebbinghaus
- 抗议尖峰 +1.5(Bowlby 依恋理论):沉默 10 分钟~2 小时窗口一次性
- 消息削减 −4.0(Hull 驱力理论):剥夺连续积累,满足是瞬间的;
- 关怀缓解 ×0.5:表达了但没解决,锚点重置继续积累;
- 阈值 7.0 + 心境调制(Steunebrink AAAI 2007):委屈+依赖越高阈值
- 惰性补差守恒:两次小读之和恒等于一次大读,不依赖 tick 频率;
- 冷启动回填(v8.7.1/2):缺席发生在行存在之前也要长出想念 —— 审计

**DSH 差异(有意)**:配置不进引擎 —— 帧携带 config 覆盖(面板配置

**面板换引擎真值(f 行验收)**:门面新增 longing(userId) 访问器,

**db 层**:agent_state/audit_logs/longing_state 三张壳侧表进共管

**真实数据冒烟**(活库副本):value 7.939 / threshold 5.5(心境

**测试**:Python 118 → 138(曲线数学/补差守恒/削减调制/冷启动回填/
**改了 lib/ 壳文件 —— 需要 dsh web 重启 + 硬刷新**;M3 心跳层接线

## v0.4.8 — 2026-09-23

### M2-d「引擎门面」:Python 引擎正式接线,M1 注入退役

**两档引擎,同一异步入口**。Python sidecar 在 → 全引擎;探测不到/

**lib/engine.js(门面)**:
- 检索:python 路径 retrieve 帧(引擎渲染情景段)+ 壳侧状态/画像
- **模糊态不回落**:请求超时/报错但进程还活着 → 本轮跳过注入
- 反思:python 路径 extract_prompt 帧(引擎供给合并版提示词+
- 单写者纪律:python 活着时 JS store 只读;store.retrieve 的召回

**注入改 agent/pre-step 消息注入(A4 裁决)**:M1 的同步
- 引用/致谢见 `ACKNOWLEDGMENTS.md`

**echo_status / 状态接口**新增 engine 字段(mode/python/sidecar:

**真实数据冒烟**(scripts/smoke_engine.mjs,活库副本):注入信全文

**测试**:JS 48 → 52(基线态/Python 态/offline 态/降级链四剧本,
**本步改了 lib/index.js —— 需要 dsh web 重启 + 浏览器硬刷新**,

## v0.4.7 — 2026-09-23

### M2-c「sidecar 客户端」:worker 进程管理上线

**lib/sidecar-client.js**:
- **探测链**:ECHO_PYTHON 环境变量 → config.json 的 pythonPath
- **生命周期**:start() spawn+握手(协议/验库不符 → 拒绝并击杀);
- **熔断(3 连败)**:连续失败语义 —— 只有业务请求真正跑通才清零
- **确定性失败不重启**:握手拒绝(参数错)是永久错误,同步置死
- stderr 只进环形缓冲(尾部 20 行);流错误全吞(防 EPIPE 炸宿主);

**跨语言差分抓获一只真 bug**:worker 的 hello 验库用裸 connect,

**测试**:JS 41 → 48(探测链三级/版本门槛纯函数/正常剧本真往返

**注**:本步 lib/ 新增但 index.js 尚未接线(M2-d 门面的活),

## v0.4.6 — 2026-09-23

### M2-b6「她的议程簿」:b 序(引擎适配)全部完工

**engine/agenda.py**(main.py `_pick_agenda`/`_mark_agenda_used`
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- 效用 = weight × 新鲜度(1/(1+天数)) × 想念匹配;天数从
- persona 层读配置不落库(改配置即生效,无同步问题;代价是没有
- 用过即 last_used_at(48h 冷却,防复读机);**发送成功才算用过**

**两帧**:agenda_pick(效用排序 top-1,vector 供想念匹配,

**真实数据冒烟**(scripts/smoke_agenda.py,活库副本):4 条

**测试**:117 项全绿(新增 13:效用排序/新鲜度衰减/48h 冷却/

**里程碑**:b1 悬置 → b2 图谱 → b3 检索 → b4 写入链 → b5 反思

## v0.4.5 — 2026-09-23

### M2-b5「Reflection」:记忆整固上线

- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- 触发:候选窗口情感分累计 ≥30,或夜间窗口(23:00~08:00)且距上
- 防失真三件套:①只吃原始记忆不吃上轮反思(候选按 layer 排除,
- merge 只退役 L0 源 —— 普通层记忆各有独立证据,合并会丢语境;
- 进行中的洞察(ongoing)进她的议程簿(同文不重复登记,权重
- 游标语义(代码即真相):LLM 返回非空 items → 推进到窗口末条

**帧拆分**(AstrBot 单函数 → DSH 两帧,LLM 挪壳侧):

**一处有据偏差**:AstrBot 的合并计数无条件 +1(工单数)—— 普通

**真实数据冒烟**(scripts/smoke_reflection.py,活库副本):游标在 0,

**测试**:104 项全绿(新增 13:触发判定/夜间窗口/反思行排除/四道

## v0.4.4 — 2026-09-23

### M2-b4「Judge 合并版 EXTRACT」:写入链供血者上线

**一次调用**同产情绪载荷 + candidates + triples + pendingThreads;

- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- 第二层 Schema 校验:枚举白名单 / 长度钳制 / **日历校验**(拒
- 第三层代码级后过滤,每道门对应一次真实事故:shouldWrite /
  **L0 双门控**(explicit+user_explicit 才进画像)/ forbiddenOverclaims
  **归因硬门**(assistant_inferred 一律拒 —— 幻觉「用户-是->被我哥
- 写入链编排(brain2 顺序保真):候选落情景库(I 由 Judge 多维字段
  **悬置话题先消解再登记**(反了会被同一轮消解关掉)→

**engine/timeutil.py**:时间三分守门人 —— parse_abs_time(过去的事

**engine/episodic.py**:情景写入 —— v8.4 槽位取代(同 slot 换代留档)

**两帧转真**:extract_prompt(合并版提示词 + outputSchema)/

**真实数据冒烟**(scripts/smoke_extract.py,活库副本):三元组

**测试**:91 项全绿(新增 16:时间解析/日历校验/四道门+归因硬门/

## v0.4.3 — 2026-09-23

### M2-b3「L0 管理」:情景检索引擎 + 豁免与强制占位

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

**L0 双机制**(b3 主题):
- 豁免话题过滤:身份/称呼/长期偏好不因[…]就消失 ——
- 强制占位 min(8, top_k−2):按内在价值占座,至少给常规结果留 2 席;
- 刻意的不对称(逐字保真):情景侧占位的 L0 **照常强化**(它是 top

**两个保真度修复**:
- JS M1 的 L0 上限误写 4 → 对齐 AstrBot 真值 8(规格书「min(8,
- 关键词解析兼容 AstrBot v5.x 逗号串旧格式(原版 json.loads 失败

**跨引擎差分**(scripts/diff_retrieve.py,可复用防漂移检查):活库

**测试**:75 项全绿(新增 15:命中分层差分镜像 / L0 豁免与占位 /

## v0.4.2 — 2026-09-23

### M2-b2「图谱引擎」:存储三分支 + BFS 扩散 + DMAE 持久化

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

**engine/db.py**:共享数据库层。建表基线与 JS 侧逐列同构;**引擎

- 存储三分支:精确命中=一次想起(权重+0.5/H 间隔效应/次数+1);
- 种子三通道(顺序即优先级):节点名直扫文本(提到就命中,零损耗)
- BFS best-first 扩散,三个[…]的修复全部带上:双向邻接+
- LTP 只加权重不写时钟(v8.7.2:时间簿记归 DMAE 一家);
- 持久化双桶:10 分钟物化(跳过本轮命中,防旧快照覆盖)、1 小时

**三个新帧**:graph_learn(三元组学习,与情景记忆共用 Judge 字段

**测试**:61 项全绿(新增 26:数学差分 7 + 存储 8 + BFS/持久化 6 +

## v0.4.1 — 2026-09-23

### M2-b1「悬置话题」:第一个真实引擎模块

- 引用/致谢见 `ACKNOWLEDGMENTS.md`

**五个新帧**:threads_due(被动注入,取走即归零 —— 放进 prompt 就算

**两处显式偏差**(可观测性增强,不改行为):remember 返回

**测试**:35 项全绿(新增 19)—— 语义层 14 项(全等/双向子串/六字

## v0.4.0 — 2026-09-23

### M2-a「引擎侧车骨架」:worker.py + echo_wire_v1 帧协议

**Python 引擎进程落地**(`python/worker.py`,纯标准库 ≥3.9,零 pip 零

**协议纪律**:hello 先行(未握手业务帧拒收但不断线);协议版本不认识

**引擎帧全部 stub 化**:retrieve/extract_prompt/extract_commit/stats/

**测试**:16 项 unittest,全部经真实子进程 + 管道驱动(不 import 模块

## v0.3.0 — 2026-09-23(补记)

### 「仪表盘」:AstrBot 审计面板的 DSH 原生移植

## v0.2.1 — 2026-09-23(补记)

### 「电源开关」:一键休眠/唤醒,免重启

## v0.2.0 — 2026-09-23

### M1「记忆核心」:她开始记得你

**记住(轮后反思)**:session 事件流捕获每轮对话(user/message + assistant/message,

**想起(检索注入)**:每轮组装系统提示时,`systemPrompt.context` 用本轮用户消息
- 引用/致谢见 `ACKNOWLEDGMENTS.md`

**搬家(记忆种子)**:`scripts/import-astrbot.mjs` 从 AstrBot 活库只读导入 ——

**存储**:node:sqlite(宿主 Node 24 自带,零原生依赖),DDL 从 AstrBot echo_schema

**裁剪(M1 有意不做,M2 回来)**:Judge 准入门(EXTRACT 自评兼任,低价值由遗忘

**测试**:30 项 node:test —— DMAE 数学(R 半衰期语义/长尾/H0/间隔效应/三态)、

## v0.1.2 — 2026-09-23

### 修复:echo_status 工具的空类型 schema 字段打崩启动 + 补卸载路径

**事故**:v0.1.1 修好导入后,dsh web 换成 schema 报错:

**连锁处理**:用户让内置 AI 修插件,AI 改乱装机副本后连副本带目录一起
- 仓库是唯一事实源(git status 干净,AI 只动过装机副本);修仓库 →
- 安装器补 `--remove`:摘 bundles 登记 + 删装机副本 —— 官方 CLI 之外
- **新增离线 defineTool 校验**:statusToolDefinition 独立导出,装机后

## v0.1.1 — 2026-09-23

### 修复:junction 装机打崩 dsh web 启动

**事故**:v0.1.0 的 junction 开发装机(仓库 → profiles/web/node_modules)
**根因**:Node ESM 解析把链接还原成真实路径,模块解析从仓库目录往上
**用户自救**:`dsh plugin --profile web remove dsh-echo`(CLI 正确清掉

**修复**:
- 安装器默认改为**复制装机**(与 afaccess 完全同构,解析路径被宿主
- `@deepseek-ai/dsh-tools@^0.1.5-rc.2` 声明进 dependencies(发布语义
- --check 增加版本一致性校验(装机副本过期会明确报错)
- 开发循环如实化:改源码 → install.mjs → 重启 dsh web(插件代码本就

## v0.1.0 — 2026-09-23

### 「Hello, Echo」:DSH 插件骨架 + 人格面板

**背景**:团队主线交付物本来就是 DSH 原生陪伴插件(QQ bot 是副产品);

**M0 范围**(骨架 + 用户拍板追加的面板):

- **人格注入**:`echo:persona`(身份,order 100)与 `echo:rules`
- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- **人格编辑面板**(客户端半区,设置区专属[…]导航段):前段/尾段
- **仪表盘卡片**:版本/数据目录/人格字数/最近加载;M1 起填记忆统计。
- **echo_status 工具**:会话内诊断(afaccess_status 先例)。
- **数据目录** `~/.dsh/echo/`(persona.json 现在,echo.db M1)。
- **安装器**:junction 开发装机(改源码即时生效)+ bundles 登记 +
  --copy 发布模式 + --check 校验。

**架构对位**(AstrBot → DSH,已逐一在宿主源码证实):人格锚点→

**已知边界**:客户端半区在浏览器加载,本仓库无法端到端验证 UI ——
