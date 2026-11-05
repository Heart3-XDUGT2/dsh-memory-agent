/* Safe, labelled status projections; private paths and account keys are never rows. */
globalThis.EchoSystemFields = [
  ["服务", [
    ["enabled", "Echo在线", "bool"], ["memoryOnline", "记忆库可用", "bool"],
    ["version", "插件版本", "text"], ["build.files", "构建模块数"],
    ["engine.mode", "引擎模式", "mode"], ["engine.python.major", "Python主版本"], ["engine.python.minor", "Python次版本"],
    ["engine.sidecar.running", "工作进程运行", "bool"], ["engine.sidecar.pid", "工作进程编号"],
    ["engine.sidecar.breakerOpen", "断路器已打开", "bool"], ["engine.sidecar.failures", "连续失败"],
    ["engine.sidecar.restarts", "工作进程重启"], ["engine.sidecar.version", "引擎版本", "text"]
  ]],
  ["传话与队列", [
    ["relay.enabled", "传话桥启用", "bool"], ["relay.channels", "已登记渠道数"],
    ["relay.pendingTurn", "等待轮数"], ["relay.queue.queued", "排队消息"],
    ["relay.queue.leased", "在途消息"], ["relay.queue.sent", "已发消息"], ["relay.queue.dropped", "丢弃消息"],
    ["relay.queue.channels", "队列渠道数"], ["relay.proactiveScope", "主动会话范围", "mode"]
  ]],
  ["嵌入上报快照", [
    ["embed.warmed", "预热完成", "bool"], ["embed.ms", "预热耗时", 0, " 毫秒"],
    ["embed.rssMb", "内存占用", 1, " MB"], ["embed.at", "最后上报", "auto-date"],
    ["embed.reason", "上报原因", "reason"]
  ]],
  ["后台反思", [
    ["reflect.runs", "运行次数"], ["reflect.fails", "失败次数"], ["reflect.lastMs", "最近耗时", 0, " 毫秒"],
    ["reflect.lastAt", "最近运行", "auto-date"], ["reflect.lastOk", "最近成功", "bool"],
    ["reflect.busySkipped", "忙时跳过"], ["reflect.queueMerged", "排队合并"],
    ["reflect.noAgentSkipped", "缺少执行者"], ["reflect.subagentSkipped", "辅助会话跳过"],
    ["reflect.llmMode", "模型通道", "mode"], ["reflect.llmOk", "模型成功"],
    ["reflect.llmTimeout", "模型超时"], ["reflect.llmFailed", "模型失败"],
    ["reflect.llmQueued", "模型排队累计"], ["reflect.llmSkipped", "模型跳过"],
    ["reflect.llmRunning", "正在运行"], ["reflect.llmWaiting", "正在等待"],
    ["reflect.llmLastMs", "模型最近耗时", 0, " 毫秒"],
    ["reflect.llmPool.live.running", "交互池运行"], ["reflect.llmPool.live.waiting", "交互池等待"],
    ["reflect.llmPool.bulk.running", "后台池运行"], ["reflect.llmPool.bulk.waiting", "后台池等待"]
  ]],
  ["工具审计", [
    ["toolAudit.seen", "观察次数"], ["toolAudit.written", "写入次数"], ["toolAudit.failed", "写入失败"],
    ["toolAudit.skippedPower", "电源关闭跳过"], ["toolAudit.skippedScope", "范围外跳过"], ["toolAudit.ownSkipped", "自有工具单独记账"]
  ]],
  ["同轮情绪与坐标打分", [
    ["sameTurnEmotion.started", "情绪请求"], ["sameTurnEmotion.applied", "情绪应用"], ["sameTurnEmotion.timedOut", "情绪超时"],
    ["sameTurnEmotion.failed", "情绪失败"], ["sameTurnEmotion.lastMs", "情绪最近耗时", 0, " 毫秒"],
    ["sameTurnEmotion.lastReason", "情绪最近原因", "reason"],
    ["ipcAppraise.turns", "坐标观察轮数"], ["ipcAppraise.runs", "坐标判定"], ["ipcAppraise.ok", "坐标成功"],
    ["ipcAppraise.skipped", "坐标跳过"], ["ipcAppraise.failed", "坐标失败"], ["ipcAppraise.lowGain", "坐标低可信度"],
    ["ipcAppraise.lastGate", "最近坐标门禁", "text"], ["ipcAppraise.lastReason", "最近坐标原因", "reason"]
  ]],
  ["检索与扩展", [
    ["retrieval.pushed", "检索记录累计"], ["retrieval.zeroHit", "零命中次数"], ["retrieval.lastRows", "最近返回行数"],
    ["retrieval.avgRows", "平均返回行数", 1], ["retrieval.kept", "当前保留记录"], ["retrieval.cap", "记录上限"],
    ["retrieval.dropped", "已淘汰记录"], ["retrieval.lastAt", "最近检索", "auto-date"],
    ["queryExpand.started", "扩展请求"], ["queryExpand.applied", "扩展应用"], ["queryExpand.timedOut", "扩展超时"],
    ["queryExpand.failed", "扩展失败"], ["queryExpand.cacheHit", "扩展缓存命中"], ["queryExpand.cacheSize", "扩展缓存项"],
    ["queryExpand.pending", "等待扩展"], ["queryExpand.lastTerms", "最近扩展词数"], ["queryExpand.lastMs", "扩展耗时", 0, " 毫秒"]
  ]],
  ["关怀判定", [
    ["care.at", "最近判定", "auto-date"], ["care.kind", "判定类别", "mode"], ["care.reason", "判定原因", "reason"],
    ["care.shouldCare", "需要关怀", "bool"], ["care.acted", "已执行", "bool"], ["care.value", "当前牵挂值", 2],
    ["care.threshold", "判定阈值", 2], ["care.quietStreak", "连续静默次数"], ["care.nextPollAt", "下次检查", "auto-date"],
    ["care.writeFailed", "关怀记账失败"]
  ]]
];
