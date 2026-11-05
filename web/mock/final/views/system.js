globalThis.EchoViews = globalThis.EchoViews || {};
globalThis.EchoViews.system = (function () {
  "use strict";
  const P = globalThis.EchoPanels;
  let reader, built = false, statusBlock, memoryBlock;
  function build(root) {
    root.classList.add("dp-page");
    statusBlock = P.section(root, "本机运行", "按来源读数列出；启用不代表已连接，工作进程上报不等于实时测量。");
    statusBlock.actions.append(P.button("重新读取状态", loadStatus));
    memoryBlock = P.section(root, "记忆体检", "记忆库独立读取；状态面暂时失败时，体检仍可查看。");
    memoryBlock.actions.append(P.button("重新读取体检", loadHealth));
    const next = P.section(root, "维护与注入", "维护页先读取状态，任何操作都要单独审查并确认；注入页只读。");
    next.status.hidden = true;
    const row = P.el("div", "dp-deferred");
    for (const [id, label] of [["maintenance", "查看维护"], ["injection", "查看注入透视"]]) {
      const node = P.el("a", "dp-button", label); node.href = "#/" + id; row.append(node);
    }
    next.content.append(row);
  }
  function drawStatus(payload, content) {
    if (typeof payload.status !== "string") throw P.schemaError();
    P.stats(content, [
      ["Echo", P.bool(payload.enabled, "在线", "休眠")],
      ["记忆库", P.bool(payload.memoryOnline, "可用", "离线")],
      ["当前范围", P.mode(payload.scope?.scope)]
    ]);
    const groups = P.el("div", "dp-columns"); groups.style.marginTop = "24px";
    for (const [title, fields] of globalThis.EchoSystemFields) {
      const details = P.el("details", "dp-breakdown");
      details.open = title === "服务" || title === "传话与队列";
      details.append(P.el("summary", "", title));
      P.measured(details, payload, fields);
      if (title === "嵌入上报快照") P.note(details, "文件可能保留上次上报，以上报时间判断新鲜度；缺值不表示占用为零。");
      if (title === "工具审计") P.dictionary(details, "按工具累计", payload.toolAudit?.byName);
      if (title === "检索与扩展") P.dictionary(details, "检索引擎累计", payload.retrieval?.byEngine);
      groups.append(details);
    }
    content.append(groups);
    const extra = P.el("details", "dp-breakdown"); extra.append(P.el("summary", "", "范围与宿主能力"));
    P.pairs(extra, [
      ["启用名单数量", Array.isArray(payload.scope?.whitelist) ? P.value(payload.scope.whitelist.length) : P.missing],
      ["例外名单数量", Array.isArray(payload.scope?.exempt) ? P.value(payload.scope.exempt.length) : P.missing],
      ["人工关闭数量", Array.isArray(payload.scope?.manualOff) ? P.value(payload.scope.manualOff.length) : P.missing],
      ["系统区段挂点", P.bool(payload.compat?.section)], ["上下文挂点", P.bool(payload.compat?.context)],
      ["变量挂点", P.bool(payload.compat?.variable)], ["注入标记次数", P.value(payload.inject?.occurrences)],
      ["注入字符数", P.value(payload.inject?.chars)], ["重复注入", P.bool(payload.inject?.duplicated)],
      ["语音回执累计", P.value(payload.voiceReceipts?.total)]
    ]);
    P.note(extra, "单轮内部状态未由这个接口提供；轻量窗口下取不到。");
    content.append(extra);
  }
  function loadStatus() { return reader?.load(statusBlock, "/api/echo/status", drawStatus); }
  function loadHealth() {
    return reader?.load(memoryBlock, "/api/echo/health", (payload, content) => {
      if (!P.object(payload.dmae)) throw P.schemaError();
      P.measured(content, payload, [
        ["dmae.total", "体检样本数"], ["dmae.active", "可回忆"], ["dmae.dormant", "休眠"],
        ["dmae.archived", "低可回忆"], ["dmae.avgR", "平均可回忆度", 3],
        ["threads.open", "开放话题"], ["threads.due", "已到期话题"]
      ]);
    });
  }
  function refresh() { return Promise.allSettled([loadStatus(), loadHealth()]); }
  function mount(root, api) { reader = new P.Reader(api); if (!built) { build(root); built = true; } return refresh(); }
  function unmount() { reader?.close(); }
  return { mount, unmount, refresh };
})();
