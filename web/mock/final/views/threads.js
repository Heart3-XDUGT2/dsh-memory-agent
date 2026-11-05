// 待跟进 · 窗口里读得到的事与她心里还没结的事。这一屏只回答「她心里还有哪些事没结掉」。
// 数据：/api/echo/threads（7 个桶，本机窗口上限 90 行）+ /api/echo/health（threads.open = 本机未结总数）。
// 两个数必须分开说：屏上的大数字是「未结」（due+waiting+untimed），小字才是窗口条数与本机未结总数。
globalThis.EchoViews = globalThis.EchoViews || {};
globalThis.EchoViews.threads = (function () {
  "use strict";

  const ENDPOINT = "/api/echo/threads";
  const HEALTH = "/api/echo/health";
  const SIZE = 10;
  // 分类键就是服务端的桶名，只有「定时」与「已了结」是两桶合一 —— 这样任何一颗 chip 的计数
  // 都等于它下面那串行的长度，chip 不可能与列表打架。
  const CATEGORIES = [
    { key: "all", label: "全部" },
    { key: "scheduled", label: "定时" },
    { key: "untimed", label: "待安排" },
    { key: "cooling", label: "冷却" },
    { key: "closed", label: "已了结" }
  ];
  const state = { page: 0, size: SIZE, total: 0, filter: "all", rows: [], openTotal: null, loaded: false };
  // state.openTotal：本机未结总数（/health.threads.open），只用来写小字口径，拿不到就是 null。

  // 服务端的 kind 是英文键，屏上用中性词。认不出来的键原样打出来，不编一个类别给它。
  const KINDS = { promise: "承诺", schedule: "行程", care: "关心", topic: "话题", reminder: "提醒" };

  let api = null;
  let built = false;
  let loadId = 0;
  let rowsHost = null;
  let chips = null;
  let pager = null;
  let figureValue = null;
  let figureNote = null;

  function bucketOf(name) {
    if (name === "due" || name === "waiting") return "scheduled";
    if (name === "done" || name === "resolved") return "closed";
    return name; // untimed / cooling / archived
  }

  function byUrgency(a, b) {
    return (Number(a?.followUpAfter) || Number(a?.updatedAt) || 0) - (Number(b?.followUpAfter) || Number(b?.updatedAt) || 0);
  }

  function filteredRows() {
    if (state.filter === "all") return state.rows;
    return state.rows.filter((row) => row.category === state.filter);
  }

  function counts() {
    const out = { all: state.rows.length, scheduled: 0, untimed: 0, cooling: 0, closed: 0 };
    for (const row of state.rows) {
      if (row.category === "archived") continue; // 归档没有自己的 chip，只出现在「全部」里
      out[row.category] = (out[row.category] || 0) + 1;
    }
    return out;
  }

  function build(root) {
    const figure = api.el("div", "figure");
    figureValue = api.el("p", "figure-value", api.missing);
    figureNote = api.el("p", "figure-note", api.missing);
    figure.append(api.el("p", "figure-label", "未结"), figureValue, figureNote);

    chips = api.chipRow(CATEGORIES.map((item) => ({ key: item.key, label: item.label, count: 0 })), {
      active: state.filter,
      onPick: pick
    });
    chips.el.hidden = true; // 计数没读回来之前不挂一排空 chip

    const block = api.el("div", "list-block");
    rowsHost = api.el("div", "list");
    rowsHost.setAttribute("aria-live", "polite");
    // 翻页器的总数是「当前分类在这个窗口里读到几条」，不是她心里的事总共几条，
    // 所以带「本机窗口」，与下面 figure-note 的「窗口内读到 N 条」同一个口径。
    pager = api.pager(state, { onChange: draw, totalNote: "本机窗口" });
    const pagerHost = api.el("div", "pager-host");
    pagerHost.appendChild(pager.el);
    block.append(rowsHost, pagerHost);

    root.append(figure, chips.el, block);
  }

  // 换分类是一张新表：回到第 1 页，总页数重算。被按下的 chip 是同一个 DOM 节点，焦点不丢。
  function pick(key) {
    if (state.filter === key) return;
    state.filter = key;
    state.page = 0;
    chips.sync(rowsOfChips(), state.filter);
    draw();
  }

  function rowsOfChips() {
    const tally = counts();
    return CATEGORIES.map((item) => ({ key: item.key, label: item.label, count: tally[item.key] || 0 }));
  }

  function draw() {
    const rows = filteredRows();
    state.total = rows.length;
    const win = pager.sync();
    if (!rows.length) {
      rowsHost.replaceChildren(api.states.empty(state.rows.length ? "这个分类里现在没有事。" : "本机还没有记下要跟进的事。"));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const { item } of rows.slice(win.start, win.end)) {
      const row = api.el("article", "list-row threads-row");
      const text = api.fmt.stripEnvelope(item?.content) || api.missing;
      const when = api.el("span", "list-when");
      const at = Number(item?.followUpAfter);
      when.textContent = at > 0 ? api.fmt.absolute(at) : "待安排";
      const kind = String(item?.kind ?? "").trim();
      row.append(api.el("p", "list-text", text), api.el("span", "list-kind", KINDS[kind] || kind || api.missing), when);
      fragment.appendChild(row);
    }
    rowsHost.replaceChildren(fragment);
  }

  function showFigure() {
    // 未结 = 到点了 + 还没到点 + 待安排（due+waiting+untimed）。冷却与已了结是她已经收下的，
    // 不算在这一个数里；窗口条数与本机未结总数写在小字里，两个口径不混成一个数。
    let unresolved = 0;
    for (const row of state.rows) if (row.category === "scheduled" || row.category === "untimed") unresolved += 1;
    figureValue.textContent = api.fmt.number(unresolved);
    const open = state.openTotal == null ? `本机未结 ${api.missing}` : `本机未结 ${api.fmt.number(state.openTotal)} 条`;
    figureNote.textContent = `窗口内读到 ${api.fmt.number(state.rows.length)} 条 · ${open}`;
  }

  function showError() {
    figureValue.textContent = api.missing;
    figureNote.textContent = api.missing;
    chips.el.hidden = true;
    pager.el.hidden = true;
    rowsHost.replaceChildren(api.states.error("暂时无法读取待跟进事项。", () => { load(); }));
  }

  async function loadOpenTotal() {
    try {
      const health = await api.get(HEALTH);
      const open = Number(health?.threads?.open);
      return Number.isFinite(open) ? open : null;
    } catch {
      return null; // 拿不到就打缺值短横，不编一个数
    }
  }

  async function load() {
    const id = (loadId += 1);
    figureValue.textContent = api.missing;
    figureNote.textContent = api.missing;
    chips.el.hidden = true;
    pager.el.hidden = true;
    rowsHost.replaceChildren(api.states.loading(SIZE));
    try {
      const [payload, open] = await Promise.all([api.get(ENDPOINT), loadOpenTotal()]);
      if (id !== loadId) return;
      const data = payload && typeof payload === "object" ? payload : {};
      const rows = [];
      for (const bucket of ["due", "waiting", "untimed", "cooling", "done", "resolved", "archived"]) {
        const list = Array.isArray(data[bucket]) ? data[bucket].slice().sort(byUrgency) : [];
        for (const item of list) rows.push({ item, category: bucketOf(bucket) });
      }
      state.rows = rows;
      state.openTotal = open;
      state.filter = "all";
      state.page = 0;
      state.loaded = true;
      showFigure();
      chips.el.hidden = rows.length === 0;
      chips.sync(rowsOfChips(), state.filter);
      draw();
    } catch (error) {
      if (id !== loadId || error?.name === "AbortError") return;
      state.loaded = false;
      showError();
    }
  }

  function mount(root, screenApi) {
    api = screenApi;
    if (!built) {
      build(root);
      built = true;
    }
    if (state.loaded) {
      draw(); // 回来还是原来那个分类与页码
      return null;
    }
    return load();
  }

  function unmount() {
    loadId += 1;
  }

  return { mount, unmount, refresh: load };
})();
