globalThis.EchoViews = globalThis.EchoViews || {};
globalThis.EchoViews.memory = (function () {
  "use strict";
  const P = globalThis.EchoPanels;
  const state = { page: 1, limit: 20, state: "active", q: "", layer: "", source: "", sort: "recent" };
  let reader, built = false, listBlock, healthBlock, inputs = {};
  function memoryUrl() {
    const query = new URLSearchParams();
    for (const key of ["page", "limit", "state", "q", "layer", "source", "sort"]) query.set(key, String(state[key]));
    return "/api/echo/memories?" + query;
  }
  function build(root) {
    root.classList.add("dp-page", "dp-memory");
    listBlock = P.section(root, "记得什么");
    const form = P.el("form", "dp-toolbar"), query = P.el("input");
    query.type = "search"; query.maxLength = 100; query.placeholder = "搜索记忆"; query.setAttribute("aria-label", "记忆关键词");
    inputs.q = query;
    inputs.state = P.select("记忆管理状态", [["active", "现役"], ["quarantined", "隔离"], ["forgotten", "留档"], ["all", "全部"]], state.state);
    const submit = P.button("搜索", () => {}); submit.type = "submit";
    form.append(P.field("关键词", query), submit);
    const extra = P.el("div", "dp-extra-filters"); extra.hidden = true; extra.id = "memory-extra-filters";
    const filters = P.el("div", "dp-filter-row"), moreButton = P.button("更多筛选", () => {
      extra.hidden = !extra.hidden; moreButton.setAttribute("aria-expanded", extra.hidden ? "false" : "true");
      moreButton.textContent = extra.hidden ? "更多筛选" : "收起筛选";
    });
    moreButton.setAttribute("aria-controls", extra.id); moreButton.setAttribute("aria-expanded", "false");
    filters.append(P.field("管理状态", inputs.state), moreButton);
    const more = P.el("div", "dp-toolbar");
    for (const [key, label] of [["layer", "层级"], ["source", "来源"]]) {
      const input = P.el("input"); input.setAttribute("aria-label", "记忆" + label); input.placeholder = "留空看全部";
      inputs[key] = input; more.append(P.field(label, input));
    }
    inputs.sort = P.select("记忆排序", [["recent", "最近写入"], ["value", "重要度优先"]], state.sort);
    inputs.limit = P.select("每页记忆数", [["12", "12条"], ["20", "20条"], ["50", "50条"]], String(state.limit));
    more.append(P.field("排序", inputs.sort), P.field("每页条数", inputs.limit)); extra.append(more);
    P.note(extra, "关键词由服务端检索摘要与关键词；列表分页与下面的全库体检分开。");
    listBlock.node.insertBefore(form, listBlock.status); listBlock.node.insertBefore(filters, listBlock.status);
    listBlock.node.insertBefore(extra, listBlock.status);
    const apply = () => {
      if (!reader || reader.closed) return;
      for (const key of ["q", "state", "layer", "source", "sort"]) state[key] = inputs[key].value.trim();
      state.limit = Number(inputs.limit.value);
      state.page = 1; loadList(true);
    };
    form.addEventListener("submit", event => { event.preventDefault(); apply(); });
    more.addEventListener("change", apply);
    inputs.state.addEventListener("change", apply);
    listBlock.actions.append(P.button("重新读取列表", () => loadList()));
    healthBlock = P.section(root, "记得多牢", "可回忆度三态是体检结果，与上方的现役、隔离、留档管理状态是不同口径。");
    healthBlock.actions.append(P.button("重新读取体检", loadHealth));
  }
  function drawList(payload, content) {
    if (!Array.isArray(payload.rows) || !payload.rows.every(P.object)
      || !Number.isInteger(payload.total) || payload.total < 0
      || !Number.isInteger(payload.page) || payload.page < 1
      || !Number.isInteger(payload.limit) || payload.limit < 1) throw P.schemaError();
    const rows = payload.rows, meta = { total: payload.total, page: payload.page, limit: payload.limit };
    content.replaceChildren();
    P.note(content, "匹配总数 " + P.value(meta.total) + " 条；当前页 " + P.value(rows.length) + " 条", "dp-result-count");
    if (!rows.length) P.note(content, state.q || state.layer || state.source ? "没有符合当前筛选的记忆。可清除关键词或更换管理状态。" : "这一管理状态下还没有记忆。");
    const list = P.el("div", "dp-memory-list");
    for (const row of rows) {
      const item = P.el("details", "dp-memory-row");
      const summary = P.text(row.summary), short = summary.length > 90 ? summary.slice(0, 90) + "…" : summary;
      item.append(P.el("summary", "", "记忆 " + P.value(row.memoryId) + " · " + short), P.el("p", "", summary));
      P.pairs(item, [
        ["层级", P.text(row.layer)], ["来源", P.text(row.sourceLabel || row.source)],
        ["情绪分", P.value(row.emotionScore)], ["管理状态", P.memoryState(row)],
        ["重要度", P.value(row.intrinsicValue, 1)], ["被想起", P.value(row.recallCount, 0, " 次")],
        ["半衰期", P.value(row.halfLife, 1, " 小时")], ["时间态", P.temporal(row.temporalStatus)],
        ["发生于", P.date(row.occurredAt)], ["学到于", P.date(row.learnedAt)],
        ["上次回忆", P.date(row.lastRecalled)], ["写入于", P.date(row.timestamp)],
        ["关键词", P.keywords(row.keywords)],
        ["已被替代", P.number(row.supersededBy) === null ? P.missing : row.supersededBy > 0 ? "是，原记录仍保留" : "否"]
      ]);
      list.append(item);
    }
    content.append(list);
    const pages = Math.max(1, Math.ceil(meta.total / meta.limit)), pager = P.el("div", "dp-pager");
    const previous = P.button("上一页", () => { state.page = Math.max(1, meta.page - 1); loadList(true); });
    const next = P.button("下一页", () => { state.page = meta.page + 1; loadList(true); });
    previous.disabled = meta.page <= 1; next.disabled = meta.page >= pages;
    pager.hidden = pages <= 1;
    pager.append(previous, P.el("p", "", "第 " + P.value(meta.page) + " / " + P.value(pages) + " 页"), next);
    content.append(pager);
    return () => { state.page = payload.page; };
  }
  function drawHealth(payload, content) {
    if (!P.object(payload.dmae)) throw P.schemaError();
    content.replaceChildren();
    const d = payload.dmae;
    P.stats(content, [["体检样本", P.value(d.total, 0, " 条")], ["平均可回忆度", P.value(d.avgR, 3)]]);
    const distribution = P.el("div");
    for (const [key, label] of [["active", "可回忆"], ["dormant", "休眠"], ["archived", "低可回忆"]]) {
      const row = P.el("div", "dp-meter-row"), meter = P.el("span", "dp-meter"), fill = P.el("span");
      const n = P.number(d[key]), total = P.number(d.total);
      fill.style.width = n !== null && total !== null && total > 0 ? Math.max(0, Math.min(100, n / total * 100)) + "%" : "0%";
      meter.append(fill); row.append(P.el("span", "", label), meter, P.el("span", "dp-num", P.value(n)));
      distribution.append(row);
    }
    content.append(distribution);
    const groups = P.el("div", "dp-columns"); groups.style.marginTop = "24px";
    const left = P.el("div"), right = P.el("div");
    P.dictionary(left, "情景记忆时间态", payload.temporal, P.temporal); P.dictionary(right, "图边时间态", payload.temporalEdges, P.temporal);
    groups.append(left, right); content.append(groups);
    P.note(content, "待跟进：开放 " + P.value(payload.threads?.open) + "，已到期 " + P.value(payload.threads?.due) + "。");
  }
  const loadList = (reset = false) => reader?.load(listBlock, memoryUrl(), drawList, { reset });
  const loadHealth = () => reader?.load(healthBlock, "/api/echo/health", drawHealth);
  function refresh() { return Promise.allSettled([loadList(), loadHealth()]); }
  function mount(root, screenApi) {
    reader = new P.Reader(screenApi);
    if (!built) { build(root); built = true; }
    return refresh();
  }
  function unmount() { reader?.close(); }
  return { mount, unmount, refresh };
})();
