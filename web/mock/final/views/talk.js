// 对话 · 最近 100 轮（本机上限）。这一屏只回答「最近她跟他说了什么」。
// 数据：/api/echo/conversations?limit=100 —— 服务端硬上限 100 轮，所以屏上写「窗口内轮数」，
// 翻页器里的 100 也必须带「本机上限」（它是窗口，不是全部历史）。
globalThis.EchoViews = globalThis.EchoViews || {};
globalThis.EchoViews.talk = (function () {
  "use strict";

  const ENDPOINT = "/api/echo/conversations?limit=100";
  const LIMIT = 100; // 与 ENDPOINT 的 limit 同一个数：请求多少轮，屏上就说多少轮
  const SIZE = 12;
  const state = { page: 0, size: SIZE, total: 0, open: "", rows: [], loaded: false };
  const P = globalThis.EchoPanels, channels = new Map();
  let keyword = "", selectedChannel = "", appliedChannel = "", windowRows = [], sourceHost, loadState, requestJob = null, mounted = false;

  let api = null;
  let built = false;
  let loadId = 0;
  let rowsHost = null;
  let pager = null;
  let figureValue = null;
  let figureNote = null;

  // 她的回复常常是几段。段与段之间只留一个换行：空一行的段距在夹到三行的行里等于白吃一整行，
  // 而正文里该有的换行照原样留着。
  function copyOf(value) {
    return P.text(api.fmt.stripMarkdown(api.fmt.stripEnvelope(value)).replace(/\n{2,}/gu, "\n"));
  }

  function build(root) {
    const form = P.el("form", "dp-toolbar"), search = P.el("input");
    search.type = "search"; search.placeholder = "搜索当前对话窗口"; search.setAttribute("aria-label", "对话关键词");
    const find = P.button("搜索窗口", () => {}); find.type = "submit";
    form.append(P.field("关键词", search), find);
    form.addEventListener("submit", event => {
      event.preventDefault(); keyword = search.value.trim().toLocaleLowerCase(); state.page = 0; state.open = ""; applyFilter();
    });
    sourceHost = P.el("div", "pb-source-chips"); sourceHost.setAttribute("aria-label", "对话来源筛选");
    loadState = P.el("p", "dp-read-state"); loadState.setAttribute("role", "status");
    const downloads = P.el("details", "pb-downloads");
    downloads.append(P.el("summary", "", "下载对话复现包"));
    P.note(downloads, "仅在你点击后下载。复现包包含设置、状态、画像和审计等全局快照，可能含敏感信息；对话来源筛选不会缩小整个包的内容。");
    const links = P.el("div", "dp-actions");
    for (const [format, title] of [["md", "下载Markdown"], ["json", "下载JSON"]]) {
      const link = P.el("a", "dp-button", title); link.href = "/api/echo/export?format=" + format; link.download = "";
      links.append(link);
    }
    downloads.append(links); root.append(form, sourceHost, loadState);
    const figure = api.el("div", "figure");
    figureValue = api.el("p", "figure-value", api.missing);
    figureNote = api.el("p", "figure-note", `本机一次最多返回 ${api.fmt.number(LIMIT)} 轮，按时间倒序`);
    figure.append(api.el("p", "figure-label", "窗口内轮数"), figureValue, figureNote);

    const block = api.el("div", "list-block");
    rowsHost = api.el("div", "list");
    rowsHost.setAttribute("aria-live", "polite");
    pager = api.pager(state, { onChange: draw, totalNote: "本机上限" });
    const pagerHost = api.el("div", "pager-host");
    pagerHost.appendChild(pager.el);
    block.append(rowsHost, pagerHost);
    const content = P.el("div", "pb-talk-content"); content.append(block, downloads);
    root.append(figure, content);

    // 行是每次翻页重建的，所以点开全文的监听挂在列表上，点完把焦点还给同一行的同一颗按钮。
    rowsHost.addEventListener("click", (event) => {
      const toggle = event.target instanceof Element ? event.target.closest(".talk-toggle") : null;
      if (!toggle) return;
      const index = toggle.dataset.index || "";
      state.open = state.open === index ? "" : index;
      draw();
      const restored = rowsHost.querySelector(`.talk-toggle[data-index="${index}"]`);
      if (restored) restored.focus();
    });
  }

  function draw() {
    const win = pager.sync();
    figureValue.textContent = api.fmt.number(state.total);
    figureNote.textContent = "当前来源窗口 " + P.value(windowRows.length) + " 轮，关键词匹配 " + P.value(state.total)
      + " 轮；服务端本机上限100轮，非全部历史";
    if (!state.total) {
      rowsHost.replaceChildren(api.states.empty(windowRows.length ? "当前窗口没有匹配的对话，可调整关键词或来源。" : "这个来源窗口还没有对话。"));
      pager.el.hidden = true; return;
    }
    pager.el.hidden = false;
    const shown = state.rows.slice(win.start, win.end);
    const fragment = document.createDocumentFragment();
    shown.forEach((item, offset) => {
      const index = win.start + offset;
      const open = state.open === String(index);
      const row = api.el("article", "list-row talk-row");

      const meta = api.el("div", "talk-meta");
      const time = api.el("p", "talk-time");
      const stamp = api.el("time");
      const seconds = Number(item?.createdAt);
      stamp.textContent = api.fmt.relative(seconds);
      if (Number.isFinite(seconds) && seconds > 0) stamp.dateTime = new Date(seconds * 1000).toISOString();
      time.appendChild(stamp);
      meta.append(time);
      meta.append(P.el("p", "dp-note", channelName(item)));

      // 「展开全文」贴着正文块的末尾（右对齐），不挂在左栏时间下面：被夹掉的是正文，
      // 能看全文的那颗按钮就该站在正文后面，而不是站在时间底下像上一行的残留。
      const toggle = api.el("button", "talk-toggle", open ? "收起" : "展开全文");
      toggle.type = "button";
      toggle.dataset.index = String(index);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-controls", `talk-reply-${index}`);
      toggle.setAttribute("aria-label", `${open ? "收起" : "展开"}第 ${api.fmt.number(index + 1)} 轮全文`);

      const body = api.el("div", "talk-body");
      const said = api.el("div", open ? "row-copy is-open" : "row-copy");
      said.appendChild(api.el("p", "talk-user", copyOf(item?.userText) || api.missing));
      const reply = api.el("div", open ? "row-copy reply is-open" : "row-copy reply");
      const replyText = api.el("p", "talk-reply", copyOf(item?.replyText) || api.missing);
      replyText.id = `talk-reply-${index}`;
      reply.appendChild(replyText);
      body.append(said, reply, toggle);

      row.append(meta, body);
      fragment.appendChild(row);
    });
    rowsHost.replaceChildren(fragment);
    // 只有真被截断的那一条才留「展开全文」。读得完的两句后面挂一颗按下去什么也不变的按钮，
    // 就是假控件。clamp 之后的 scrollHeight 不会透露被裁掉的部分，所以先记下夹紧后的高度，
    // 再把 clamp 摘掉量一次真实高度：写完一次、读一次、立刻恢复，中间没有一帧会被画出来。
    const built = [...rowsHost.querySelectorAll(".talk-row")];
    const probes = [];
    for (const row of built) {
      if (row.querySelector(".row-copy.is-open")) continue; // 展开着的那条必须留着「收起」
      for (const p of row.querySelectorAll(".row-copy p")) probes.push(p);
    }
    const clamped = probes.map((p) => p.clientHeight);
    for (const p of probes) p.classList.add("is-measuring");
    const full = probes.map((p) => Math.round(p.getBoundingClientRect().height));
    for (const p of probes) p.classList.remove("is-measuring");
    const clipped = new Set();
    probes.forEach((p, index) => { if (full[index] > clamped[index] + 1) clipped.add(p); });
    for (const row of built) {
      if (row.querySelector(".row-copy.is-open")) continue; // 展开着的那条必须留着「收起」
      const toggle = row.querySelector(".talk-toggle");
      if (!toggle) continue;
      if (![...row.querySelectorAll(".row-copy p")].some((p) => clipped.has(p))) toggle.remove();
    }
  }
  function channelName(row) {
    const raw = typeof row?.channel === "string" ? row.channel : "";
    if (!raw) return "未标注来源";
    if (!channels.has(raw)) channels.set(raw, "来源 " + (channels.size + 1));
    return channels.get(raw);
  }
  function sourceChips() {
    sourceHost.replaceChildren();
    for (const [raw, title] of [["", "全部来源"], ...channels]) {
      const chip = P.button(title, () => {
        if (!mounted || selectedChannel === raw) return;
        selectedChannel = raw; state.page = 0; state.open = ""; sourceChips(); load();
      });
      chip.setAttribute("aria-pressed", String(raw === selectedChannel)); sourceHost.append(chip);
    }
  }
  function applyFilter() {
    state.rows = windowRows.filter(row => !keyword || [row.userText, row.replyText, row.channel, channelName(row)]
      .some(value => typeof value === "string" && value.toLocaleLowerCase().includes(keyword)));
    state.total = state.rows.length; draw();
  }

  function showError() {
    figureValue.textContent = api.missing;
    pager.el.hidden = true;
    rowsHost.replaceChildren(api.states.error("暂时无法读取对话记录。", () => { load(); }));
  }

  async function load() {
    const channel = selectedChannel;
    if (requestJob?.channel === channel) return requestJob.promise;
    requestJob?.controller.abort();
    const controller = new AbortController(), job = { channel, controller, promise: null }; requestJob = job;
    const id = (loadId += 1);
    loadState.textContent = state.loaded ? "正在刷新；旧窗口保留到读取成功。" : "正在读取对话窗口";
    if (!state.loaded) { figureValue.textContent = api.missing; pager.el.hidden = true; rowsHost.replaceChildren(api.states.loading(SIZE)); }
    const current = () => mounted && id === loadId && !controller.signal.aborted;
    job.promise = (async () => { try {
      const payload = await api.get(ENDPOINT + (channel ? "&channel=" + encodeURIComponent(channel) : ""), controller.signal);
      if (!current()) return;
      if (payload?.offline === true || !Array.isArray(payload?.rows)) throw Error("read unavailable");
      const rows = Array.isArray(payload?.rows) ? payload.rows.slice() : [];
      rows.sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0));
      for (const row of rows) {
        const raw = typeof row?.channel === "string" ? row.channel : "";
        if (!raw) continue;
        const label = payload.labels?.[row.sessionId] || payload.labels?.[raw];
        if (typeof label === "string" && label.trim() && P.text(label.trim()) === label.trim()) channels.set(raw, label.trim());
        else channelName(row);
      }
      windowRows = rows;
      appliedChannel = channel;
      state.page = 0;
      state.open = "";
      state.loaded = true;
      sourceChips(); applyFilter(); loadState.textContent = "读取于 " + P.date(Date.now(), true);
    } catch (error) {
      if (!current() || error?.name === "AbortError") return;
      loadState.textContent = state.loaded ? "对话刷新失败，保留上次窗口；新的来源筛选尚未应用，可重试。" : "暂时无法读取对话窗口，可重试。";
      if (!state.loaded) showError();
    } finally { if (requestJob === job) requestJob = null; } })();
    return job.promise;
  }

  function mount(root, screenApi) {
    api = screenApi;
    mounted = true;
    if (!built) {
      build(root);
      built = true;
    }
    if (state.loaded) {
      selectedChannel = appliedChannel; sourceChips();
      draw(); // 回来还是原来那一页，不重拉
      return null;
    }
    return load();
  }

  // 只丢在飞的请求，不清数据：页码、展开的那一条都留在这屏自己的 state 上。
  function unmount() {
    mounted = false; requestJob?.controller.abort(); requestJob = null;
    selectedChannel = appliedChannel;
    if (state.loaded) {
      loadState.textContent = "读取已取消，保留已应用来源的上次窗口。"; sourceChips();
    }
    loadId += 1;
  }

  return { mount, unmount, refresh: load };
})();
