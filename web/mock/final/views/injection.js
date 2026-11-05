globalThis.EchoViews = globalThis.EchoViews || {};
globalThis.EchoViews.injection = (function () {
  "use strict";
  const P = globalThis.EchoPanels, limit = 40, names = new P.SessionNames();
  let reader, api, built = false, block, labels, scope = "companion";
  function split(text) {
    const sections = []; let current = null;
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*(?:【([^】]+)】|\[([^\]]+)\])/u);
      const rest = match ? line.slice(match[0].length).trim() : "";
      if (match && (rest === "" || /^(现在|时间纪律|关联知识路径|情景记忆|她此刻的状态|他的称呼|他的画像|使用纪律|别处刚说过的|你刚主动说过|你刚才被插嘴了)/u.test(match[1] || match[2]))) {
        current = { title: match[1] || match[2], lines: rest ? [rest] : [] }; sections.push(current);
      } else {
        if (!current) { current = { title: "开头", lines: [] }; sections.push(current); }
        current.lines.push(line);
      }
    }
    return sections.map(section => ({ title: section.title, text: section.lines.join("\n").trim() }));
  }
  function input(row) {
    if (typeof row.injectedMemories === "string") return row.injectedMemories;
    return Array.isArray(row.injectedMemories) ? row.injectedMemories.map(item => "- " + (item?.summary || "")).join("\n") : "";
  }
  function build(root) {
    root.classList.add("dp-page", "mb-page");
    block = P.section(root, "最近一次注入", "从所选范围最近40行审计窗口寻找实际非空注入；本页不使用轻量裁剪，没有命中不代表全部历史从未注入。");
    const select = P.select("注入会话范围", [["companion", "陪伴会话"], ["all", "全部会话"]], scope, value => {
      scope = value; load(true);
    });
    block.node.insertBefore(P.field("读取范围", select), block.status);
    block.actions.append(P.button("重新读取注入", () => load()));
    labels = P.section(root, "来源标签", "只用于区分记录所属会话，原始会话标识不会直接展示。");
    labels.actions.append(P.button("重新读取标签", loadLabels));
  }
  function draw(payload, root, chosen) {
    if (!Array.isArray(payload.rows) || !payload.rows.every(P.object)) throw P.schemaError();
    const rows = [...payload.rows].sort((a, b) => (P.number(b.timestamp) || 0) - (P.number(a.timestamp) || 0));
    const row = rows.find(item => input(item).trim());
    P.note(root, "本次读取 " + P.value(rows.length) + " 行；范围：" + (chosen === "all" ? "全部会话" : "设置中的陪伴会话") + "。");
    if (!row) { P.note(root, "当前窗口没有带正文的注入记录，可重新读取或切换范围。"); return; }
    const text = input(row), sections = split(text);
    P.pairs(root, [["记录时间", P.date(row.timestamp)], ["来源会话", names.marker(row.sessionId), "node"],
      ["原文长度", P.value(text.length, 0, " 字符")], ["分段数量", P.value(sections.length)]]);
    P.note(root, "以下是当时被注入的上下文记录，不是主人本轮原话；可见文本已隐藏内部标识和路径。");
    for (const section of sections) {
      if (!section.text) { P.note(root, section.title); continue; }
      const details = P.el("details", "mb-injection-part");
      details.append(P.el("summary", "", P.text(section.title) + " · " + P.value(section.text.length, 0, " 字符")));
      details.append(P.el("p", "mb-prose", section.text)); root.append(details);
    }
    P.note(root, "正文按审计接口本次实际返回记录读取，没有请求轻量裁剪；写入审计之前的裁剪仍无法恢复，不代表全部历史。");
  }
  function load(reset = false) {
    if (!reader || reader.closed) return Promise.resolve();
    const chosen = scope;
    return reader.load(block, "injection:" + chosen, (payload, root) => draw(payload, root, chosen), { reset });
  }
  function loadLabels() {
    if (!reader || reader.closed) return Promise.resolve();
    // Use a separate reader to avoid the audit preparation adapter intercepting scope.
    return labelReader.load(labels, "/api/echo/scope", (payload, root) => {
      if (!P.object(payload.sessionLabels)) throw P.schemaError();
      P.note(root, "来源标签已读取；未命名记录使用稳定的中性会话别名。");
      return () => names.apply(payload);
    });
  }
  let labelReader;
  function refresh() { return Promise.allSettled([load(), loadLabels()]); }
  function mount(root, screenApi) {
    api = screenApi;
    const original = screenApi;
    reader = new P.Reader({
      ...screenApi,
      get: async (key, signal) => {
        const chosen = key === "injection:all" ? "all" : "companion";
        const url = "/api/echo/audit?limit=" + limit + "&light=0";
        if (chosen === "all") return original.get(url, signal);
        const settings = await original.get("/api/echo/settings", signal);
        if (signal.aborted || original.signal?.aborted) throw new DOMException("aborted", "AbortError");
        const session = settings?.settings?.relay?.sessionId;
        if (typeof session !== "string" || !session.trim()) throw Error("companion unavailable");
        return original.get(url + "&sessionId=" + encodeURIComponent(session), signal);
      }
    });
    labelReader = new P.Reader(api);
    if (!built) { build(root); built = true; } return refresh();
  }
  function unmount() { reader?.close(); labelReader?.close(); }
  return { mount, unmount, refresh };
})();
