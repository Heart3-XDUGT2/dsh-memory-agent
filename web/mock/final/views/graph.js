globalThis.EchoViews = globalThis.EchoViews || {};
globalThis.EchoViews.graph = (function () {
  "use strict";
  const P = globalThis.EchoPanels;
  const types = { person: "人", concept: "概念", habit: "习惯", preference: "偏好", event: "事件" };
  let reader, built = false, graphBlock, storeBlock, dataset = null;
  const filter = { q: "", weight: "", page: 0, size: 10, rank: "degree", nodePage: 0,
    shadow: false, evidence: false, shadowPage: 0, evidencePage: 0 };
  function build(root) {
    root.classList.add("dp-page", "dp-graph");
    graphBlock = P.section(root, "记忆之间的联系");
    graphBlock.actions.append(P.link("打开完整动态图谱", "/echo/graph.html"), P.button("重新读取图谱", loadGraph));
    const form = P.el("form", "dp-toolbar"), search = P.el("input"), minimum = P.el("input");
    search.type = "search"; search.placeholder = "关系词或节点名称"; search.setAttribute("aria-label", "图谱关键词");
    minimum.type = "number"; minimum.min = "0"; minimum.step = "0.1"; minimum.placeholder = "不限"; minimum.setAttribute("aria-label", "最小关系权重");
    const submit = P.button("筛选关系", () => {}); submit.type = "submit";
    const rank = P.select("节点榜排序", [["degree", "连接度"], ["weight", "节点权重"]], filter.rank, value => {
      filter.rank = value; filter.nodePage = 0; renderCached();
    });
    const apply = () => {
      if (!reader || reader.closed) return;
      filter.q = search.value.trim().toLocaleLowerCase(); filter.weight = minimum.value;
      filter.page = 0; renderCached();
    };
    form.append(P.field("关键词", search), submit);
    form.addEventListener("submit", event => { event.preventDefault(); apply(); });
    const extra = P.el("div", "dp-extra-filters"); extra.hidden = true; extra.id = "graph-extra-filters";
    const more = P.button("更多筛选", () => {
      extra.hidden = !extra.hidden; more.setAttribute("aria-expanded", extra.hidden ? "false" : "true");
      more.textContent = extra.hidden ? "更多筛选" : "收起筛选";
    });
    more.setAttribute("aria-expanded", "false"); more.setAttribute("aria-controls", extra.id);
    const advanced = P.el("div", "dp-toolbar");
    advanced.append(P.field("最小权重", minimum), P.field("节点排序", rank)); extra.append(advanced);
    minimum.addEventListener("change", apply);
    P.note(extra, "筛选只作用于本次读取图谱；事实关系、影子层、证据层分开计数。");
    graphBlock.node.insertBefore(form, graphBlock.status);
    graphBlock.node.insertBefore(more, graphBlock.status); graphBlock.node.insertBefore(extra, graphBlock.status);
    storeBlock = P.section(root, "状态面的图谱计数", "状态面与当前可画图谱口径可能不同，数值并列展示，不凭差值推断丢失。");
    storeBlock.actions.append(P.button("重新读取状态", loadStore));
  }
  function table(root, headings, rows, numeric = []) {
    const node = P.el("table", "dp-table"), head = P.el("thead"), tr = P.el("tr");
    headings.forEach((label, i) => { const th = P.el("th", numeric.includes(i) ? "dp-num" : "", label); th.scope = "col"; tr.append(th); });
    head.append(tr); node.append(head);
    const body = P.el("tbody");
    for (const row of rows) {
      const line = P.el("tr");
      row.forEach((cell, i) => {
        const td = P.el("td", numeric.includes(i) ? "dp-num" : "");
        if (cell?.nodeType === 1) td.append(cell); else td.textContent = P.text(cell);
        line.append(td);
      });
      body.append(line);
    }
    node.append(body); root.append(node); return node;
  }
  function drawGraph(payload, root) {
    if (!Array.isArray(payload.nodes) || !Array.isArray(payload.edges)
      || !payload.nodes.every(P.object) || !payload.edges.every(P.object)) throw P.schemaError();
    const nodes = payload.nodes, edges = payload.edges;
    const maxWeight = nodes.reduce((max, node) => Math.max(max, P.number(node.weight) ?? 0), 0);
    const names = new Map(nodes.map(n => [n.id, P.text(n.name || "未命名节点")]));
    const name = id => names.get(id) || "未命名节点";
    root.replaceChildren();
    P.stats(root, [["可画节点", P.value(nodes.length)], ["事实关系", P.value(edges.length)]]);
    const byType = new Map(), degree = new Map(nodes.map(n => [n.id, 0])), relations = new Map();
    for (const node of nodes) {
      const label = types[node.type] || P.text(node.type || "未标注");
      byType.set(label, (byType.get(label) || 0) + 1);
    }
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
      const label = P.text(edge.relation || "未标注");
      relations.set(label, (relations.get(label) || 0) + 1);
    }
    const overview = P.el("div", "dp-columns"); overview.style.marginTop = "24px";
    const rankings = P.el("div"), distribution = P.el("div");
    rankings.append(P.el("h3", "", filter.rank === "weight" ? "节点权重榜" : "连接度榜"));
    const nodePages = Math.max(1, Math.ceil(nodes.length / 8));
    filter.nodePage = Math.min(filter.nodePage, nodePages - 1);
    const ranked = [...nodes].sort((a, b) => filter.rank === "weight"
      ? (P.number(b.weight) ?? -Infinity) - (P.number(a.weight) ?? -Infinity)
      : (degree.get(b.id) || 0) - (degree.get(a.id) || 0)).slice(filter.nodePage * 8, (filter.nodePage + 1) * 8);
    if (ranked.length) {
      const figure = P.el("figure", "dp-node-chart");
      figure.append(P.el("figcaption", "dp-note", "节点名称、连接数与节点权重；条长以本次最大节点权重为基准。"));
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "100%"); svg.setAttribute("height", String(32 + ranked.length * 54));
      svg.setAttribute("role", "img"); svg.setAttribute("aria-label", ranked.map(n =>
        name(n.id) + "，连接数" + P.value(degree.get(n.id)) + "，节点权重" + P.value(n.weight, 1)).join("；"));
      const mark = (tag, attributes, text) => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const [key, val] of Object.entries(attributes)) node.setAttribute(key, String(val));
        if (text !== undefined) node.textContent = P.text(text);
        svg.append(node); return node;
      };
      for (const [x, label] of [["0", "节点"], ["70%", "连接数"], ["100%", "节点权重"]]) {
        mark("text", { x, y: 18, "text-anchor": x === "0" ? "start" : "end", class: "dp-chart-label" }, label);
      }
      ranked.forEach((n, index) => {
        const y = 44 + index * 54, label = name(n.id), weight = P.number(n.weight);
        const title = mark("text", { x: 0, y, class: "dp-chart-name" }, label.length > 12 ? label.slice(0, 12) + "…" : label);
        const fullName = document.createElementNS("http://www.w3.org/2000/svg", "title"); fullName.textContent = label; title.append(fullName);
        mark("text", { x: "70%", y, "text-anchor": "end", class: "dp-chart-number" }, P.value(degree.get(n.id)));
        mark("text", { x: "100%", y, "text-anchor": "end", class: "dp-chart-weight" }, P.value(weight, 1));
        if (weight !== null && weight >= 0 && maxWeight > 0) {
          mark("rect", { x: 0, y: y + 10, width: Math.max(0, Math.min(100, weight / maxWeight * 100)) + "%",
            height: 6, rx: 3, class: "dp-chart-weight-bar" });
        }
      });
      figure.append(svg); rankings.append(figure);
    } else P.note(rankings, "当前没有可画节点。");
    const nodePager = P.el("div", "dp-pager"), nodePrev = P.button("上一组节点", () => { filter.nodePage--; renderCached(); });
    const nodeNext = P.button("下一组节点", () => { filter.nodePage++; renderCached(); });
    nodePrev.disabled = filter.nodePage <= 0; nodeNext.disabled = filter.nodePage >= nodePages - 1;
    nodePager.hidden = nodePages <= 1;
    nodePager.append(nodePrev, P.el("p", "", P.value(filter.nodePage + 1) + " / " + P.value(nodePages)), nodeNext); rankings.append(nodePager);
    distribution.append(P.el("h3", "", "类型分布"));
    if (byType.size) P.pairs(distribution, [...byType].map(([label, count]) => [label, P.value(count, 0, " 个")]));
    else P.note(distribution, "当前没有类型样本。");
    const relationRank = P.el("div", "dp-breakdown"); relationRank.append(P.el("h3", "", "关系词分布"));
    if (relations.size) P.pairs(relationRank, [...relations].sort((a, b) => b[1] - a[1]).map(([label, count]) => [label, P.value(count, 0, " 条")]));
    else P.note(relationRank, "当前没有事实关系。");
    distribution.append(relationRank); overview.append(rankings, distribution); root.append(overview);

    const matched = edges.filter(edge => {
      const q = filter.q;
      const hit = !q || [name(edge.source), name(edge.target), P.text(edge.relation)].some(v => v.toLocaleLowerCase().includes(q));
      const minimum = filter.weight === "" ? null : Number(filter.weight);
      const weight = P.number(edge.weight);
      return hit && (minimum === null || Number.isFinite(minimum) && weight !== null && weight >= minimum);
    });
    const pages = Math.max(1, Math.ceil(matched.length / filter.size));
    filter.page = Math.min(filter.page, pages - 1);
    const visible = matched.slice(filter.page * filter.size, (filter.page + 1) * filter.size);
    const detail = P.el("div", "dp-breakdown"); detail.style.marginTop = "24px";
    detail.append(P.el("h3", "", "事实关系明细"));
    P.note(detail, "本次读取 " + P.value(edges.length) + " 条；筛选匹配 " + P.value(matched.length) + " 条，当前页 " + P.value(visible.length) + " 条。", "dp-result-count");
    if (!visible.length) P.note(detail, "没有匹配的关系。可调整关键词或最小权重。");
    else table(detail, ["两端节点", "关系", "权重"], visible.map(e => [name(e.source) + " → " + name(e.target), P.text(e.relation), P.value(e.weight, 1)]), [2]);
    const pager = P.el("div", "dp-pager"), previous = P.button("上一页", () => { filter.page--; renderCached(); });
    const next = P.button("下一页", () => { filter.page++; renderCached(); });
    previous.disabled = filter.page <= 0; next.disabled = filter.page >= pages - 1;
    pager.hidden = pages <= 1;
    pager.append(previous, P.el("p", "", "第 " + P.value(filter.page + 1) + " / " + P.value(pages) + " 页"), next);
    detail.append(pager); root.append(detail);

    for (const [key, label] of [["shadow", "历史影子层"], ["evidence", "共现证据层"]]) { // taste-skill-ignore: backend data-layer key, not a CSS shadow.
      const layer = payload.layers?.[key], box = P.el("details", "dp-breakdown");
      box.open = filter[key]; box.append(P.el("summary", "", label));
      box.addEventListener("toggle", () => { filter[key] = box.open; });
      P.pairs(box, [
        ["本次读取条数", Array.isArray(layer?.rows) ? P.value(layer.rows.length) : P.missing],
        ["检索参与", P.bool(layer?.inRetrieval, "参与检索", "不参与检索")],
        ["性质", P.text(layer?.nature)]
      ]);
      if (typeof layer?.note === "string" && layer.note) P.note(box, layer.note);
      const rows = Array.isArray(layer?.rows) ? layer.rows : null;
      if (rows?.length) {
        const pageKey = key + "Page", pages = Math.max(1, Math.ceil(rows.length / 8));
        filter[pageKey] = Math.min(filter[pageKey], pages - 1);
        const shown = rows.slice(filter[pageKey] * 8, (filter[pageKey] + 1) * 8);
        table(box, ["两端节点", key === "shadow" ? "关系 / 权重" : "关系 / 支持数"], // taste-skill-ignore: backend data-layer comparison, not a CSS shadow.
          shown.map(e => [name(e.source) + " → " + name(e.target), P.text(e.relation) + " / " + P.value(key === "shadow" ? e.weight : e.support)])); // taste-skill-ignore: reads backend layer weights, not a CSS shadow.
        const pager = P.el("div", "dp-pager"), previous = P.button("上一组层记录", () => { filter[pageKey]--; filter[key] = true; renderCached(); });
        const next = P.button("下一组层记录", () => { filter[pageKey]++; filter[key] = true; renderCached(); });
        previous.disabled = filter[pageKey] <= 0; next.disabled = filter[pageKey] >= pages - 1;
        pager.hidden = pages <= 1;
        pager.append(previous, P.el("p", "", "第 " + P.value(filter[pageKey] + 1) + " / " + P.value(pages) + " 页"), next);
        box.append(pager); P.note(box, "本次读取 " + P.value(rows.length) + " 条，当前页 " + P.value(shown.length) + " 条；不以端点是否可画过滤记录。");
      } else P.note(box, rows ? "这一层当前没有记录。" : "接口未提供这一层。");
      root.append(box);
    }
    return () => { dataset = payload; };
  }
  function renderCached() {
    if (!dataset || !reader || reader.closed) return;
    const scratch = P.el("div"), committed = drawGraph(dataset, scratch);
    graphBlock.content.replaceChildren(...scratch.childNodes); committed();
  }
  function loadGraph() { return reader?.load(graphBlock, "/api/echo/graph", drawGraph); }
  function loadStore() {
    return reader?.load(storeBlock, "/api/echo/status", (payload, content) => {
      if (payload.memoryOnline === false) throw Object.assign(new Error("offline"), { category: "offline" });
      if (payload.memoryOnline !== true) throw P.schemaError();
      if (!P.object(payload.memory)) throw P.schemaError();
      P.measured(content, payload.memory, [["graphNodes", "状态面节点数"], ["graphEdges", "状态面关系数"]]);
      P.note(content, "这些是状态报告值；上方的可画节点和事实边只按图谱接口当前返回的内容计算。");
    });
  }
  function refresh() { return Promise.allSettled([loadGraph(), loadStore()]); }
  function mount(root, api) {
    reader = new P.Reader(api); if (!built) { build(root); built = true; } return refresh();
  }
  function unmount() { reader?.close(); }
  return { mount, unmount, refresh };
})();
