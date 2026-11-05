(() => {
  "use strict";

  const endpoints = {
    status: "/api/echo/status",
    longing: "/api/echo/longing",
    conversations: "/api/echo/conversations?limit=100",
    threads: "/api/echo/threads",
    diary: "/api/echo/diary"
  };
  const $ = (id) => document.getElementById(id);
  const missing = "—";
  const conversationBase = 3;
  const threadBase = 2;
  const diaryBase = 2;

  // 九条路由，顺序即导航顺序。wired 为 false 的屏只有壳：刷新按钮置灰、屏名旁挂「未启用」，
  // 因为那里还没有可读的数据，给一个按下去什么也不发生的按钮就是假控件。
  const ROUTES = [
    { id: "overview", title: "近况", lead: "她现在怎么样。", wired: true },
    { id: "emotion", title: "情绪", lead: "她此刻什么心情，为什么。", wired: true },
    { id: "talk", title: "对话", lead: "最近她跟他说了什么。", wired: true },
    { id: "threads", title: "待跟进", lead: "她心里还有哪些事没结掉。", wired: true },
    { id: "memory", title: "记忆", lead: "她记得多少、记得多牢。", wired: true },
    { id: "graph", title: "图谱", lead: "她的记忆之间连成什么。", wired: true },
    { id: "audit", title: "审计", lead: "她这一轮到底做了什么。", wired: true },
    // 一轮的整页流程图。它不在导航里（index.html 的导航是静态的），只能从审计列表点进来；
    // key 是 turnKey 的 10 位短摘要，不是内部分组键原文（地址栏会进历史与截图）。
    { id: "round", title: "这一轮", lead: "她这一轮是怎么一步步走过来的。", wired: true, hidden: true },
    { id: "system", title: "系统", lead: "本机能转得动吗。", wired: true },
    { id: "maintenance", title: "维护", lead: "查看文件与运行状态，审查后再执行维护。", wired: true },
    { id: "injection", title: "注入透视", lead: "最近一份实际注入的上下文。", wired: true },
    { id: "config", title: "设置", lead: "调整她的陪伴方式，保存前集中看看这次改了什么。", wired: true }
  ];

  const view = { conversations: [], threads: [], diary: [] };
  // 只剩日记还在原地展开：它固定七条，全开也有限。对话与待跟进的全量各有一屏（决定 A）。
  const diary = { expanded: false, open: "", query: "" };

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null || value === "" ? missing : String(value);
  }

  function numberOrDash(value, digits = 0) {
    if (typeof value !== "number" || !Number.isFinite(value)) return missing;
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
  }

  function arrayOf(value) { return Array.isArray(value) ? value : []; }
  function objectOf(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  function isNum(value) { return typeof value === "number" && Number.isFinite(value); }

  function makeEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  // A KPI figure: no digit is ever invented — a missing number prints the same dash the rest of the page uses.
  function setMetric(id, value, digits = 0) {
    const el = $(id);
    if (!el) return;
    const main = el.querySelector(".value-main");
    if (main) main.textContent = numberOrDash(value, digits);
  }

  // A footnote of one to three facts. Each fact is unbreakable and carries its own separator, so a
  // narrow card wraps between facts instead of cutting a word in half ("取代" → "取 / 代").
  function setNote(id, parts) {
    const el = $(id);
    if (!el) return;
    if (parts.length < 2) {
      el.textContent = parts[0] ?? missing;
      return;
    }
    const fragment = document.createDocumentFragment();
    parts.forEach((part, index) => {
      const span = document.createElement("span");
      span.className = "note-part";
      span.textContent = index < parts.length - 1 ? `${part} ·` : part;
      fragment.appendChild(span);
    });
    el.replaceChildren(fragment);
  }

  async function fetchJson(path, signal) {
    const response = await fetch(path, { headers: { Accept: "application/json" }, cache: "no-store", signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function stripEnvelope(value) {
    let text = String(value ?? "").trim();
    text = text.replace(/^(?:【(?:QQ|voice|dsh|群聊|私聊)[^】]*】\s*)+/u, "");
    text = text.replace(/^(?:(?:QQ|voice|dsh)[·:：][^\n:：]{1,24}(?:说|留言|消息)\s*[:：]\s*)/u, "");
    text = text.replace(/^(?:私聊|群聊|语音|消息)?(?:回复|回(?:你|我|他|她)?了?)\s*[:：]?\s*/u, "");
    text = text.replace(/^(?:Echo\s*[:：]\s*)/u, "");
    text = text.replace(/^>\s?/gm, "");
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    return text;
  }

  function relativeTime(epochSeconds) {
    if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds) || epochSeconds <= 0) return missing;
    const delta = Math.max(0, Date.now() - epochSeconds * 1000);
    const minutes = Math.floor(delta / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} 天前`;
    return new Date(epochSeconds * 1000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }

  function absoluteDate(epochSeconds) {
    if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds) || epochSeconds <= 0) return missing;
    return new Date(epochSeconds * 1000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }

  // Some replies carry light markdown. Printing them as text is right, but the marks themselves are
  // noise, so paired **__ and ` are unwrapped and the line-leading #, > and - * are dropped. Only those:
  // a lone * or _ she typed is her punctuation and stays exactly where it is.
  function stripMarkdown(text) {
    const lines = String(text ?? "").split("\n").map((line) => {
      let current = line;
      for (let pass = 0; pass < 3; pass += 1) {
        const next = current
          .replace(/^\s{0,3}#{1,6}\s+/u, "")
          .replace(/^\s{0,3}>\s?/u, "")
          .replace(/^\s{0,3}[-*]\s+/u, "");
        if (next === current) break;
        current = next;
      }
      return current;
    });
    return lines
      .join("\n")
      .replace(/\*\*([^*\n]+?)\*\*/gu, "$1")
      .replace(/__([^_\n]+?)__/gu, "$1")
      .replace(/`([^`\n]+?)`/gu, "$1");
  }

  function makeCopy(text, className = "row-copy") {
    const el = document.createElement("div");
    el.className = className;
    const p = document.createElement("p");
    p.textContent = text || missing;
    el.appendChild(p);
    return el;
  }

  function appendEmpty(container, text) {
    const p = document.createElement("p");
    p.className = "empty-copy";
    p.textContent = text;
    container.replaceChildren(p);
  }

  function appendError(container, text) {
    const p = document.createElement("p");
    p.className = "error-copy";
    p.textContent = text;
    container.replaceChildren(p);
  }

  // ---------------------------------------------------------------------------
  // 公共组件：一次实现，两屏共用（P2 起）。分页、筛选、三态只在这里写一遍，
  // 各屏只管把数据摆进来 —— 视觉与键盘行为才可能真的长得一样。
  // ---------------------------------------------------------------------------

  // Which slice of `total` the pager is on. Clamped, so a stale page after a reload still lands on a
  // real range. Returns the 0-based page, the page count and the half-open row range.
  function pageWindow(state, total) {
    const size = Math.max(1, Number(state.size) || 1);
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(Math.max(Number(state.page) || 0, 0), pages - 1);
    state.page = page;
    const start = total === 0 ? 0 : page * size;
    const end = Math.min(start + size, total);
    return { page, pages, start, end, total };
  }

  // A page of rows replaces the previous one, so the control must never grow with the list: two buttons
  // and one range, and the range is written from the same numbers the list is sliced with.
  //
  // `totalNote` 是口径限定词（docs/plan-ui-phases.md 的 B3）：state.total 若是「本机能读到的窗口」
  // 而不是全部历史，就必须在总数后说清楚，否则「共 100 条」会被读成她总共只跟他说过 100 轮。
  // 传了它就用短写 `第 1–12 / 100（本机上限）`：390 实测一行只剩 158px，全写
  // `第 1–12 条 / 共 100 条（本机上限）` 要 217px，会被挤到第二行。不传则逐字与以前一致。
  //
  // `unit` 是这一页数的什么：审计一页 25 **轮**，写成「第 1–25 条」会被读成审计行数。
  // 不传就是老的「条」写法，对话 / 待跟进逐字不变。
  // `compact(win)` 是窄屏（<768）上的另一句：390 实测翻页器一行只剩 190px（358 − 两颗 76 的
  // 按钮 − 两道 8px 缝），宽屏那句「第 1–25 轮 / 共 175 轮（本机窗口 200 行）」要 243px，会折行。
  // 给了它就写两个 span、由 CSS 挑一句，不在 JS 里读 innerWidth，窗口一缩那句就失真了。
  function createPager(state, options = {}) {
    const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
    const note = String(options.totalNote ?? "").trim();
    const unit = String(options.unit ?? "").trim();
    const compact = typeof options.compact === "function" ? options.compact : null;
    const el = makeEl("div", "pager");
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", "翻页");
    const prev = makeEl("button", "pager-button", "上一页");
    prev.type = "button";
    const next = makeEl("button", "pager-button", "下一页");
    next.type = "button";
    const label = makeEl("p", "pager-label");
    // 只有真要写两句时才拆 span：另外两屏的 DOM 与 innerText 逐字不变。
    const labelWide = compact ? makeEl("span", "pager-label-wide") : label;
    const labelShort = compact ? makeEl("span", "pager-label-short") : null;
    if (labelShort) label.append(labelWide, labelShort);
    el.append(prev, label, next);

    // Turning the button you just pressed into a disabled one makes the browser drop the focus to <body>.
    // Hand it to the sibling that can still be pressed, so a keyboard reader never loses its place.
    function hold() {
      const active = document.activeElement;
      if ((active === prev || active === next) && !active.disabled) return;
      if (!prev.disabled) prev.focus();
      else if (!next.disabled) next.focus();
    }

    function step(delta) {
      state.page = pageWindow(state, Math.max(0, Number(state.total) || 0)).page + delta;
      onChange();
      hold();
    }

    // 文案只在这一个地方拼：宽屏那句、窄屏那句都从同一组数字出来，两句不可能各说各的。
    function written(win) {
      const range = `第 ${numberOrDash(win.start + 1)}–${numberOrDash(win.end)}`;
      const total = numberOrDash(win.total);
      if (win.total === 0) return unit ? `共 ${total} ${unit}` : `共 ${total} 条`;
      if (unit) return note ? `${range} ${unit} / 共 ${total} ${unit}（${note}）` : `${range} ${unit} / 共 ${total} ${unit}`;
      return note ? `${range} / ${total}（${note}）` : `${range} 条 / 共 ${total} 条`;
    }

    function sync() {
      const win = pageWindow(state, Math.max(0, Number(state.total) || 0));
      prev.disabled = win.page <= 0;
      next.disabled = win.page >= win.pages - 1;
      labelWide.textContent = written(win);
      if (labelShort) labelShort.textContent = win.total === 0 ? "" : String(compact(win) ?? "");
      el.hidden = win.total === 0;
      prev.setAttribute("aria-label", win.page <= 0 ? "上一页，已经在第 1 页" : `上一页，到第 ${numberOrDash(win.page)} 页`);
      next.setAttribute("aria-label", win.page >= win.pages - 1
        ? `下一页，已经在最后一页（第 ${numberOrDash(win.pages)} 页）`
        : `下一页，到第 ${numberOrDash(win.page + 2)} 页`);
      return win;
    }

    prev.addEventListener("click", () => step(-1));
    next.addEventListener("click", () => step(1));
    return { el, sync };
  }

  // Chips are reconciled, not rebuilt: the one you pressed keeps its focus after the list swaps under
  // it, and a category that reads 0 is hidden instead of printed as "0".
  function createChipRow(items, options = {}) {
    const onPick = typeof options.onPick === "function" ? options.onPick : () => {};
    const el = makeEl("div", "chip-row");
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", options.label || "筛选");
    const slots = new Map();

    function slotFor(item) {
      let slot = slots.get(item.key);
      if (slot) return slot;
      const button = makeEl("button", "filter-chip");
      button.type = "button";
      const label = makeEl("span", "chip-label");
      const count = makeEl("span", "chip-count");
      button.append(label, count);
      // 计数变了也只是这里重建一次；被按下的那颗始终是同一个 DOM 节点。
      button.addEventListener("click", () => onPick(item.key));
      slot = { button, label, count };
      slots.set(item.key, slot);
      return slot;
    }

    function sync(nextItems, active) {
      const list = Array.isArray(nextItems) ? nextItems : [];
      const seen = new Set();
      for (const item of list) {
        seen.add(item.key);
        const slot = slotFor(item);
        slot.label.textContent = item.label;
        slot.count.textContent = numberOrDash(item.count);
        slot.button.hidden = !(Number(item.count) > 0);
        slot.button.setAttribute("aria-pressed", item.key === active ? "true" : "false");
        if (!slot.button.isConnected) el.appendChild(slot.button);
      }
      for (const [key, slot] of slots) if (!seen.has(key)) slot.button.hidden = true;
    }

    sync(items, options.active);
    return { el, sync };
  }

  // Same height as the rows that will replace it, so the list does not jump when the data lands.
  function loadingState(rows = 3) {
    const wrap = makeEl("div", "state-block");
    wrap.appendChild(makeEl("p", "loading-copy", "正在读取…"));
    const bars = makeEl("div", "skeleton");
    bars.setAttribute("aria-hidden", "true");
    for (let i = 0; i < rows; i += 1) bars.appendChild(makeEl("span", "skeleton-row"));
    wrap.appendChild(bars);
    return wrap;
  }

  function emptyState(text) {
    const wrap = makeEl("div", "state-block");
    wrap.appendChild(makeEl("p", "empty-copy", text || "这里还没有记录。"));
    return wrap;
  }

  // An error is one honest sentence and one real way out; nothing here pretends to be data.
  function errorState(message, retry) {
    const wrap = makeEl("div", "state-block");
    wrap.appendChild(makeEl("p", "error-copy", message || "暂时读不到这一屏的数据。"));
    if (typeof retry === "function") {
      const button = makeEl("button", "state-retry", "重试");
      button.type = "button";
      button.addEventListener("click", retry);
      wrap.appendChild(button);
    }
    return wrap;
  }

  // While a list is open, the column beside it would be empty: the grid hands the open list the whole
  // width and the shorter card moves underneath it (see .is-reading in app.css).
  function syncReadingMode() {
    const grid = document.querySelector(".content-grid");
    if (!grid) return;
    grid.classList.toggle("is-reading", diary.expanded);
  }

  function renderConversations(payload) {
    const rows = arrayOf(objectOf(payload).rows);
    view.conversations = rows.slice().sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0));
    drawConversations();
  }

  // The rest window stays the rest window: the full list lives on #/talk, so the button here is a link,
  // not an expander (决定 A).
  function drawConversations() {
    const list = $("conversation-list");
    const total = view.conversations.length;
    const more = $("conversation-more");
    const wrap = more ? more.closest(".panel-more") : null;
    if (wrap) wrap.hidden = total <= conversationBase;
    if (!total) {
      appendEmpty(list, "还没有记录到对话。");
      setText("conversation-count", "共 0 条 · 显示最近 0 条");
      return;
    }
    const shown = view.conversations.slice(0, conversationBase);
    setText("conversation-count", `共 ${numberOrDash(total)} 条 · 显示最近 ${numberOrDash(shown.length)} 条`);
    const fragment = document.createDocumentFragment();
    for (const item of shown) {
      const row = document.createElement("article");
      row.className = "conversation-row";
      const time = document.createElement("time");
      time.className = "row-channel";
      time.textContent = relativeTime(Number(item?.createdAt));
      const user = makeCopy(stripMarkdown(stripEnvelope(item?.userText)));
      const reply = makeCopy(stripMarkdown(stripEnvelope(item?.replyText)), "row-copy reply");
      row.append(time, user, reply);
      fragment.appendChild(row);
    }
    list.replaceChildren(fragment);
  }

  function renderThreads(payload) {
    const data = objectOf(payload);
    const due = arrayOf(data.due);
    const waiting = arrayOf(data.waiting);
    const untimed = arrayOf(data.untimed);
    const byUrgency = (a, b) => (Number(a?.followUpAfter) || Number(a?.updatedAt) || 0) - (Number(b?.followUpAfter) || Number(b?.updatedAt) || 0);
    // A row is "定时" when the API dated it (due + waiting), "待安排" otherwise — the same split the
    // caption counts, so the caption can never disagree with the list under it.
    view.threads = [
      ...due.sort(byUrgency).map((item) => ({ item, scheduled: true })),
      ...waiting.sort(byUrgency).map((item) => ({ item, scheduled: true })),
      ...untimed.sort(byUrgency).map((item) => ({ item, scheduled: false }))
    ];
    const scheduledCount = due.length + waiting.length;
    setText("threads-count", view.threads.length);
    setMetric("reading-followups", scheduledCount);
    setNote("reading-followups-note", [
      `${numberOrDash(due.length)} 到期`,
      `${numberOrDash(waiting.length)} 计划中`,
      `${numberOrDash(untimed.length)} 待安排`
    ]);
    drawThreads();
  }

  function drawThreads() {
    const list = $("thread-list");
    const total = view.threads.length;
    const scheduled = view.threads.filter((row) => row.scheduled).length;
    const undated = total - scheduled;
    const more = $("threads-more");
    const wrap = more ? more.closest(".panel-more") : null;
    if (wrap) wrap.hidden = total <= threadBase;
    setText("threads-caption", `显示最近 ${numberOrDash(Math.min(threadBase, total))} / ${numberOrDash(total)} 条 · ${numberOrDash(scheduled)} 件有时间 · ${numberOrDash(undated)} 件待安排`);
    if (!total) {
      appendEmpty(list, "目前没有需要留心的安排。");
      return;
    }
    const shown = view.threads.slice(0, threadBase);
    const fragment = document.createDocumentFragment();
    for (const { item } of shown) {
      const row = document.createElement("article");
      row.className = "thread-row";
      const copy = document.createElement("div");
      copy.className = "thread-copy";
      copy.textContent = stripEnvelope(item?.content) || missing;
      const kind = document.createElement("span");
      kind.className = "thread-kind";
      const scheduledAt = Number(item?.followUpAfter);
      kind.textContent = scheduledAt > 0 ? absoluteDate(scheduledAt) : "待安排";
      row.append(copy, kind);
      fragment.appendChild(row);
    }
    list.replaceChildren(fragment);
  }

  function renderDiary(payload) {
    const rows = arrayOf(objectOf(payload).rows).slice().sort((a, b) => String(b?.date ?? "").localeCompare(String(a?.date ?? "")));
    view.diary = rows;
    diary.expanded = false;
    diary.open = "";
    setMetric("reading-diary", rows.length);
    const newest = rows[0];
    setNote("reading-diary-note", newest?.date ? ["最近记录", String(newest.date)] : ["本机记录"]);
    if (!rows.length) {
      drawDiary();
      return;
    }
    drawDiary();
  }

  function diaryKeyOf(item) {
    return String(item?.date ?? "");
  }

  function diaryFullId(item) {
    const key = diaryKeyOf(item).replace(/[^0-9A-Za-z]/gu, "");
    return key ? `diary-full-${key}` : "";
  }

  // A few entries were imported with their own date on the first line; the row already carries one, so
  // the leading date and the separator that follows it are dropped. Only at the start: a date inside the
  // text is part of what she wrote.
  function stripLeadingDate(text) {
    return String(text ?? "").replace(/^\s*\d{4}-\d{2}-\d{2}[ \t]*[-:：,，.。、·\u2014]?[ \t]*(?:\r?\n)?\s*/u, "");
  }

  function diaryText(item) {
    const raw = String(item?.content ?? "").replace(/\r\n?/gu, "\n").trim();
    return stripLeadingDate(raw).trim() || raw;
  }

  // The whole entry, one paragraph per blank-line block. Single line breaks survive because the block
  // keeps its own newlines and the CSS prints them with white-space: pre-line.
  function diaryParagraphs(item) {
    return diaryText(item)
      .split(/\n{2,}/u)
      .map((block) => block.trim())
      .filter((block) => block.length > 0);
  }

  // The one toggle the diary panel owns: gone while the entries fit in the rest window, "收起" once open.
  function syncDiaryToggle(total) {
    const button = $("diary-more");
    const wrap = button ? button.closest(".panel-more") : null;
    const expandable = total > diaryBase;
    if (!expandable) {
      diary.expanded = false;
      diary.open = "";
    }
    if (wrap) wrap.hidden = !expandable;
    syncReadingMode();
    if (!button) return;
    button.textContent = diary.expanded ? "收起" : "查看更多日记";
    button.setAttribute("aria-expanded", diary.expanded ? "true" : "false");
  }

  function drawDiary() {
    const list = $("diary-list");
    const filtered = view.diary.filter(item => !diary.query || [item?.date, item?.content]
      .some(value => typeof value === "string" && value.toLocaleLowerCase().includes(diary.query)));
    const total = filtered.length;
    const count = $("diary-search-count");
    if (count) count.textContent = "本次窗口 " + numberOrDash(view.diary.length) + " 篇，匹配 " + numberOrDash(total) + " 篇；最近最多7篇，非全部历史";
    syncDiaryToggle(total);
    if (diary.open && !filtered.some((item) => diaryKeyOf(item) === diary.open)) diary.open = "";
    const shown = diary.expanded ? filtered : filtered.slice(0, diaryBase);
    if (!shown.length) { appendEmpty(list, diary.query ? "当前日记窗口没有匹配内容，可调整关键词。" : "还没有日记记录。"); return; }
    const fragment = document.createDocumentFragment();
    for (const item of shown) {
      const key = diaryKeyOf(item);
      const open = key !== "" && diary.open === key;
      const row = document.createElement("article");
      row.className = "diary-row";
      const date = document.createElement("time");
      date.className = "row-date";
      date.dateTime = key;
      date.textContent = item?.date ? String(item.date) : missing;
      const copy = document.createElement("div");
      copy.className = "row-copy";
      const rawContent = diaryText(item);
      const fullId = diaryFullId(item);
      if (!open) {
        const summary = document.createElement("p");
        summary.textContent = rawContent.split(/\n\s*\n/u)[0].slice(0, 70) || missing;
        copy.appendChild(summary);
      }
      const full = document.createElement("div");
      full.className = "diary-full";
      if (fullId) full.id = fullId;
      full.hidden = !open;
      if (open) {
        for (const text of diaryParagraphs(item)) {
          const paragraph = document.createElement("p");
          paragraph.textContent = text;
          full.appendChild(paragraph);
        }
      }
      copy.appendChild(full);
      const mood = document.createElement("span");
      mood.className = "diary-mood";
      mood.textContent = isNum(item?.mood) ? `心情 ${numberOrDash(item.mood)}/10` : `心情 ${missing}`;
      copy.appendChild(mood);
      // The rest view keeps the two-line summary it always had; reading an entry in full is what the
      // expanded view is for, so the toggle lives there and nowhere else. It sits in the row's own action
      // column, level with the text, instead of taking a line of its own under it.
      const toggle = diary.expanded ? document.createElement("button") : null;
      if (toggle) {
        toggle.type = "button";
        toggle.className = "diary-toggle";
        toggle.textContent = open ? "收起全文" : "展开全文";
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        if (fullId) toggle.setAttribute("aria-controls", fullId);
        toggle.dataset.diaryKey = key;
        toggle.setAttribute("aria-label", `${open ? "收起" : "展开"} ${item?.date ? String(item.date) : missing} 的日记全文`);
      }
      row.append(date, copy);
      if (toggle) row.appendChild(toggle);
      fragment.appendChild(row);
    }
    list.replaceChildren(fragment);
  }

  function renderLonging(payload) {
    const rows = arrayOf(objectOf(payload).rows);
    const row = rows[0];
    setMetric("reading-longing", row?.value, 1);
    const threshold = isNum(row?.threshold)
      ? `阈值 ${numberOrDash(row.threshold, 1)}`
      : `阈值 ${missing}`;
    setNote("reading-longing-note", row?.shouldCare === true ? [threshold, "需要留心"] : [threshold]);
  }

  // "人格基线:P 2 / A 3 (手填)" → { p: 2, a: 3 }. Anything unexpected falls back to a plain footer.
  function baselineOf(text) {
    const raw = String(text ?? "");
    const p = raw.match(/(?:^|[^A-Za-z])P\s*(-?\d+(?:\.\d+)?)/u);
    const a = raw.match(/(?:^|[^A-Za-z])A\s*(-?\d+(?:\.\d+)?)/u);
    if (!p || !a) return null;
    const pv = Number(p[1]);
    const av = Number(a[1]);
    return Number.isFinite(pv) && Number.isFinite(av) ? { p: pv, a: av } : null;
  }

  function renderStatus(payload) {
    const data = objectOf(payload);
    const memory = objectOf(data.memory);
    const relay = objectOf(data.relay);
    const queue = objectOf(relay.queue);
    const engine = objectOf(data.engine);
    const sidecar = objectOf(engine.sidecar);
    const embed = objectOf(data.embed);
    const compat = objectOf(data.compat);
    const power = objectOf(data.power);
    const scope = objectOf(data.scope);
    const active = data.status === "active" && data.enabled === true;
    const online = data.memoryOnline === true;
    const service = active ? "运行中" : data.enabled === false ? "已暂停" : missing;
    const memoryStatus = online ? "在线" : data.memoryOnline === false ? "离线" : missing;
    const engineStatus = typeof sidecar.running === "boolean" ? (sidecar.running ? "运行中" : "已停止") : missing;
    const relayStatus = isNum(relay.channels) ? `${numberOrDash(relay.channels)} 个通道` : missing;
    const queueParts = [["排队", queue.queued], ["已发", queue.sent], ["丢弃", queue.dropped]];
    const queueStatus = queueParts.every(([, value]) => isNum(value))
      ? queueParts.map(([key, value]) => `${key} ${numberOrDash(value)}`).join(" · ")
      : missing;
    const scopeStatus = scope.scope === "all" ? "全部" : scope.scope === "whitelist" ? "白名单" : missing;
    const statusRows = [
      ["Echo", service, active ? "is-good" : data.enabled === false ? "is-alert" : ""],
      ["记忆", memoryStatus, online ? "is-good" : data.memoryOnline === false ? "is-alert" : ""],
      ["引擎", engineStatus, sidecar.running === true ? "is-good" : sidecar.running === false ? "is-alert" : ""],
      ["引擎 PID", isNum(sidecar.pid) ? String(sidecar.pid) : missing, ""],
      ["引擎重启", isNum(sidecar.restarts) ? `${numberOrDash(sidecar.restarts)} 次` : missing, ""],
      ["断路器", typeof sidecar.breakerOpen === "boolean" ? (sidecar.breakerOpen ? "已打开" : "正常") : missing,
        typeof sidecar.breakerOpen === "boolean" ? (sidecar.breakerOpen ? "is-alert" : "is-good") : ""],
      ["嵌入预热", typeof embed.warmed === "boolean" ? (embed.warmed ? "已预热" : "未预热") : missing,
        embed.warmed === true ? "is-good" : ""],
      ["兼容性", typeof compat.ok === "boolean" ? (compat.ok ? "正常" : "异常") : missing,
        typeof compat.ok === "boolean" ? (compat.ok ? "is-good" : "is-alert") : ""],
      ["电源", typeof power.enabled === "boolean" ? (power.enabled ? "开启" : "已休眠") : missing,
        typeof power.enabled === "boolean" ? (power.enabled ? "is-good" : "is-alert") : ""],
      ["会话范围", scopeStatus, ""],
      ["消息通道", relayStatus, "", true],
      ["桥队列", queueStatus, "", true]
    ];
    const list = $("status-list");
    const fragment = document.createDocumentFragment();
    for (const [label, value, tone, wide] of statusRows) {
      const row = document.createElement("div");
      row.className = wide ? "status-row is-wide" : "status-row";
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      if (tone) dd.classList.add(tone);
      row.append(dt, dd);
      fragment.appendChild(row);
    }
    if (list) list.replaceChildren(fragment);
    // 侧栏与抽屉那两处标签归壳管（paintServiceStatus），这一屏只管它自己的 12 行与读数。
    setMetric("reading-mood", memory.moodIntensity);
    const baseline = baselineOf(data.herBaseline);
    setNote("reading-mood-note", baseline
      ? [`基线 P${numberOrDash(baseline.p)} / A${numberOrDash(baseline.a)}`]
      : ["本机记录"]);
    setMetric("reading-memory", memory.episodicActive);
    setNote("reading-memory-note", [
      `总计 ${numberOrDash(memory.episodicTotal)}`,
      `隔离 ${numberOrDash(memory.quarantined)}`,
      `取代 ${numberOrDash(memory.superseded)}`
    ]);
    setMetric("reading-graph", memory.graphNodes);
    setNote("reading-graph-note", [
      `${numberOrDash(memory.graphEdges)} 条边`,
      `L0 ${numberOrDash(memory.l0)}`
    ]);
    const greetingNote = $("greeting-note");
    if (greetingNote) greetingNote.hidden = true;
  }

  function updateDate() {
    const date = new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" }).format(new Date());
    setText("current-date", date);
  }

  // ---------------------------------------------------------------------------
  // 服务状态：这是壳的事，不是哪一屏的事。侧栏左下与抽屉底部在任何屏上都得说真话，
  // 所以壳启动时自己取一次，取到就写两处标签；屏只复用这一份结果，绝不各自再打一遍。
  // ---------------------------------------------------------------------------

  let statusRequest = null;

  function fetchServiceStatus() {
    if (!statusRequest) {
      statusRequest = fetchJson(endpoints.status).then(
        (data) => ({ ok: true, data }),
        () => ({ ok: false, data: null })
      );
    }
    return statusRequest;
  }

  function paintServiceStatus(result) {
    if (!result) return;
    if (!result.ok) {
      setText("sidebar-status", "连接失败");
      setText("sheet-status", "连接失败");
      return;
    }
    const data = objectOf(result.data);
    const label = data.status === "active" && data.enabled === true ? "运行中" : data.enabled === false ? "已暂停" : "状态未知";
    setText("sidebar-status", `Echo ${label}`);
    setText("sheet-status", `Echo ${label}`);
  }

  async function loadPanel(path, render, containerId, errorMessage) {
    try {
      render(await fetchJson(path));
    } catch {
      const container = $(containerId);
      if (container) appendError(container, errorMessage);
    }
  }

  // 近况的「运行状态」卡：数据来自壳的那一次请求，失败时只剩屏头那句实话 —— 与改前一致。
  function loadStatusPanel() {
    return fetchServiceStatus().then((result) => {
      paintServiceStatus(result);
      if (result.ok) {
        renderStatus(result.data);
        return;
      }
      const list = $("status-list");
      if (list) list.replaceChildren();
      const greetingNote = $("greeting-note");
      if (greetingNote) {
        greetingNote.hidden = false;
        greetingNote.textContent = "暂时无法读取本机状态。";
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 壳：路由、调度、导航状态。屏自己的东西一律在 views/<id>.js 或下面的 overview 里，
  // 壳只做四件事，别的都不管。
  // ---------------------------------------------------------------------------

  const EchoViews = (globalThis.EchoViews = globalThis.EchoViews || {});
  let activeId = "";
  // 路由参数（现在只有 round 用：一轮的短 key）。同 id 不同 key 也必须重挂。
  let activeParam = null;
  let activeScope = "companion";
  let activeController = null;
  let overviewLoad = null;

  function routeById(id) {
    for (const route of ROUTES) if (route.id === id) return route;
    return ROUTES[0];
  }

  // A screen's container is made once and then only hidden: page numbers, filters and open rows keep
  // their place across a switch because nothing is thrown away.
  function viewRoot(route) {
    const existing = $(`view-${route.id}`);
    if (existing) return existing;
    const host = $("view-host");
    if (!host) return null;
    const section = document.createElement("section");
    section.className = "view";
    section.id = `view-${route.id}`;
    section.hidden = true;
    section.setAttribute("aria-labelledby", "view-title");
    host.appendChild(section);
    return section;
  }

  function paintChrome(route) {
    const title = $("view-title");
    if (title) title.textContent = route.title;
    const lead = $("view-lead");
    if (lead) lead.textContent = route.lead;
    const date = $("current-date");
    if (date) date.hidden = route.id !== "overview";
    const tag = $("view-tag");
    if (tag) tag.hidden = route.wired === true;
    const refresh = $("view-refresh");
    if (refresh) {
      refresh.disabled = route.wired !== true;
      refresh.setAttribute("aria-label", route.wired === true ? `重新读取${route.title}` : `${route.title}这一屏还没有可读的数据`);
    }
    const pageName = $("mobile-page-name");
    if (pageName) pageName.textContent = route.title;
    document.title = `Echo · ${route.title}`;
    // 两处导航读同一份状态：侧栏与抽屉各标一次，页面上真正可见的当前项永远只有一条。
    // 一轮的整页图属于「审计」这条线：导航高亮仍落在审计上，别让侧栏一项都不亮。
    const navId = route.id === "round" ? "audit" : route.id;
    for (const link of document.querySelectorAll(".nav-link[data-route]")) {
      if (link.dataset.route === "audit") link.href = globalThis.EchoAuditScope.href("audit", null, activeScope);
      const current = link.dataset.route === navId;
      link.classList.toggle("is-active", current);
      if (current) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  function focusTitle() {
    const title = $("view-title");
    if (title) title.focus();
  }

  // unmount 只解绑事件、掐掉在飞的请求，不清数据 —— 切走再回来还是原来那一屏。
  function leave(id) {
    const instance = EchoViews[id];
    if (instance && typeof instance.unmount === "function") {
      try { instance.unmount(); } catch { /* 一屏的卸载失败不该带走整个壳 */ }
    }
    if (activeController) {
      try { activeController.abort(); } catch { /* 已经结束的请求 */ }
      activeController = null;
    }
    const root = $(`view-${id}`);
    if (root) root.hidden = true;
  }

  function activate(id, { focus = false, param = null, scope = activeScope } = {}) {
    const route = routeById(id);
    if (route.id === activeId && activeId !== "" && param === activeParam && scope === activeScope) {
      // 已经在这一屏（同一个参数）：只补一遍页头与导航状态，不重挂、不重拉数。
      paintChrome(route);
      if (focus) focusTitle();
      return Promise.resolve(null);
    }
    if (activeId) leave(activeId);
    // 冷启动直接进深链（#/memory）时并没有"上一屏"可以收：这里把不是目标的那几屏一律隐藏，
    // 否则总览会和目标屏一起画出来（实测被 inspect 抓成 ragged-row / panel-void）。
    for (const el of document.querySelectorAll(".view")) {
      el.hidden = el.id !== `view-${route.id}`;
    }
    const root = viewRoot(route);
    activeId = route.id;
    activeParam = param;
    activeScope = scope;
    if (root) root.hidden = false;
    paintChrome(route);
    let pending = null;
    const instance = EchoViews[route.id];
    if (root && instance && typeof instance.mount === "function") {
      activeController = new AbortController();
      try {
        pending = instance.mount(root, makeApi(activeController, scope), param);
      } catch (error) {
        console.error(error);
      }
    }
    if (focus) focusTitle();
    return Promise.resolve(pending);
  }

  // 地址栏是唯一真相：空 hash 与不认识的 hash 都改写成 #/overview，但绝不整页刷新。
  function applyLocation(options) {
    const first = options instanceof Event ? false : options && options.first === true;
    const hash = String(location.hash || "");
    let id = "";
    let param = null;
    let focus = !first;
    if (hash === "" || hash === "#") {
      history.replaceState(null, "", "#/overview");
      id = "overview";
    } else if (hash.slice(0, 2) === "#/") {
      const raw = hash.slice(2).split("?")[0].replace(/\/+$/u, "");
      const cut = raw.indexOf("/");
      const head = cut >= 0 ? raw.slice(0, cut) : raw;
      const tail = cut >= 0 ? raw.slice(cut + 1) : "";
      if (head === "round" && /^[0-9a-f]{10}$/u.test(tail)) {
        // 一轮的整页图：key 只允许 10 位短摘要这一种形态，其余一律按"不认识的地址"处理。
        id = "round";
        param = tail;
      } else if (ROUTES.some((route) => route.id === head)) {
        id = head;
      } else {
        history.replaceState(null, "", "#/overview");
        id = "overview";
      }
    } else {
      // 「跳到主要内容」这类页内锚点不是路由：不改地址栏，也不打断当前屏。
      id = activeId || "overview";
      param = activeParam;
      focus = false;
    }
    const scope = id === "audit" || id === "round" ? globalThis.EchoAuditScope.scopeOf(hash) : activeScope;
    return activate(id, { focus, param, scope });
  }

  function makeApi(controller, scope) {
    const get = (path, signal) => fetchJson(path, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal);
    const audit = globalThis.EchoAuditScope.create({ scope, get, signal: controller.signal,
      change: (value) => { location.hash = globalThis.EchoAuditScope.href(activeId, activeParam, value); } });
    return {
      el: makeEl,
      missing,
      get,
      signal: controller.signal,
      audit,
      abort: () => controller.abort(),
      // fmt 是壳里那一套格式化：屏不自带第二份剥信封、剥 markdown、相对时间的实现。
      fmt: {
        number: numberOrDash,
        relative: relativeTime,
        absolute: absoluteDate,
        stripEnvelope,
        stripMarkdown
      },
      route: (id) => { location.hash = `#/${id}`; },
      // 公共组件（P2 起两屏共用）：分页、筛选 chips、空/错/载三态。
      pager: (state, options) => createPager(state, options),
      chipRow: (items, options) => createChipRow(items, options),
      states: { loading: loadingState, empty: emptyState, error: errorState },
      // 没接数据的屏共用这一块：左边一块浅底说明（一句实话 + 数据来源），右边一张将要显示什么的表。
      // 表里只打缺值短横，不编数字、不做成能点的控件。端点各自成块，窄屏才会在两条路径之间换行，
      // 不会把一条路径从中间劈开。
      placeholder: (root, spec) => {
        const wrap = document.createElement("div");
        wrap.className = "placeholder";
        const note = document.createElement("div");
        note.className = "placeholder-note";
        const source = makeEl("p", "spec-source", "数据来源");
        for (const path of spec.source) source.appendChild(makeEl("span", "source-path", path));
        // 屏上一段一段排，读屏软件念的时候要有分隔。
        source.setAttribute("aria-label", `数据来源 ${spec.source.join("、")}`);
        note.append(makeEl("p", "view-state", spec.state), source);
        const list = document.createElement("dl");
        list.className = "spec-list";
        for (const item of spec.items) {
          const row = document.createElement("div");
          row.className = "spec-row";
          row.append(makeEl("dt", null, item), makeEl("dd", null, missing));
          list.appendChild(row);
        }
        wrap.append(note, list);
        root.appendChild(wrap);
      }
    };
  }

  function loadOverview(force) {
    // 刷新是「重新读一遍」：壳缓存的那份服务状态跟着作废，否则按了刷新还是旧结果。
    if (force) statusRequest = null;
    const jobs = [
      loadStatusPanel(),
      loadPanel(endpoints.longing, renderLonging, "reading-longing-note", "暂时无法读取牵挂值。"),
      loadPanel(endpoints.conversations, renderConversations, "conversation-list", "暂时无法读取对话记录。"),
      loadPanel(endpoints.threads, renderThreads, "thread-list", "暂时无法读取待跟进事项。"),
      loadPanel(endpoints.diary, renderDiary, "diary-list", "暂时无法读取日记记录。")
    ];
    return Promise.allSettled(jobs);
  }

  EchoViews.overview = {
    mount() {
      if (overviewLoad) return null; // 首次进入拉一次；之后用缓存，刷新按钮才重拉
      updateDate();
      overviewLoad = loadOverview();
      return overviewLoad;
    },
    unmount() {},
    refresh() { return loadOverview(true); }
  };

  function setupMenu() {
    const trigger = $("menu-trigger");
    const scrim = $("menu-scrim");
    const sheet = $("mobile-menu");
    const close = $("menu-close");
    if (!trigger || !scrim || !sheet || !close) return;
    let previousOverflow = "";

    function getFocusable() {
      return [...sheet.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.getClientRects().length > 0);
    }
    function closeMenu(returnFocus = true) {
      if (scrim.hidden) return;
      scrim.hidden = true;
      document.body.classList.remove("menu-open");
      document.body.style.overflow = previousOverflow;
      trigger.setAttribute("aria-expanded", "false");
      if (returnFocus) trigger.focus();
    }
    function openMenu() {
      previousOverflow = document.body.style.overflow;
      scrim.hidden = false;
      document.body.classList.add("menu-open");
      document.body.style.overflow = "hidden";
      trigger.setAttribute("aria-expanded", "true");
      close.focus();
    }

    trigger.addEventListener("click", () => scrim.hidden ? openMenu() : closeMenu());
    close.addEventListener("click", () => closeMenu());
    scrim.addEventListener("click", (event) => { if (event.target === scrim) closeMenu(); });
    document.addEventListener("keydown", (event) => {
      if (scrim.hidden) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      } else if (event.key === "Tab") {
        const focusable = getFocusable();
        if (!focusable.length) {
          event.preventDefault();
          sheet.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    });
    // 抽屉里点一项：先关抽屉（焦点不还回汉堡按钮），路由随后把焦点送到那一屏的 h1。
    sheet.querySelectorAll('a[href^="#"]').forEach((link) => {
      link.addEventListener("click", () => closeMenu(false));
    });
  }

  // 点的是当前这一屏时 hash 不变，不会有 hashchange：手动把焦点送到屏名，别让人停在原地。
  function setupNavLinks() {
    document.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest("a[data-route]") : null;
      if (!link || link.dataset.route !== activeId) return;
      event.preventDefault();
      activate(activeId, { focus: true });
    });
  }

  function setupRefresh() {
    const button = $("view-refresh");
    if (!button) return;
    button.addEventListener("click", () => {
      const instance = EchoViews[activeId];
      if (!instance || typeof instance.refresh !== "function") return;
      Promise.resolve(instance.refresh()).catch(() => {});
    });
  }

  function bindClick(id, handler) {
    const button = $(id);
    if (button) button.addEventListener("click", handler);
  }

  function setupToggles() {
    const diarySearch = $("diary-search");
    if (diarySearch) diarySearch.addEventListener("input", () => {
      diary.query = diarySearch.value.trim().toLocaleLowerCase(); diary.open = ""; drawDiary();
    });
    bindClick("diary-more", () => {
      if (view.diary.filter(item => !diary.query || [item?.date, item?.content]
        .some(value => typeof value === "string" && value.toLocaleLowerCase().includes(diary.query))).length <= diaryBase) return;
      diary.expanded = !diary.expanded;
      if (!diary.expanded) diary.open = "";
      drawDiary();
    });
    // Diary rows are rebuilt on every draw, so the "全文" toggles are handled on the list itself and the
    // clicked one is given the focus back after the redraw.
    const diaryList = $("diary-list");
    if (diaryList) {
      diaryList.addEventListener("click", (event) => {
        const toggle = event.target instanceof Element ? event.target.closest(".diary-toggle") : null;
        if (!toggle) return;
        const key = toggle.dataset.diaryKey || "";
        diary.open = diary.open === key ? "" : key;
        drawDiary();
        const list = $("diary-list");
        const restored = list ? [...list.querySelectorAll(".diary-toggle")].find((button) => button.dataset.diaryKey === key) : null;
        if (restored) restored.focus();
      });
    }
  }

  function init() {
    setupMenu();
    setupNavLinks();
    setupRefresh();
    setupToggles();
    // 先让壳自己取一次服务状态：深链冷启动（#/memory）根本不挂 overview，也得有话可说。
    fetchServiceStatus().then(paintServiceStatus);
    window.addEventListener("hashchange", applyLocation);
    const first = applyLocation({ first: true });
    Promise.resolve(first)
      .catch(() => {})
      .then(() => { document.documentElement.dataset.dataReady = "true"; });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
