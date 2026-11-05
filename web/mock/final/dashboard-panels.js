/* Shared read-only panel primitives. Each block owns its request and freshness. */
globalThis.EchoPanels = (function () {
  "use strict";
  const missing = String.fromCodePoint(8212);
  const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  function text(value) {
    if (!["string", "number", "boolean"].includes(typeof value)) return missing;
    const source = String(value);
    if (/[{,]\s*"(?:[^"\\]|\\.)*"\s*:/u.test(source)) return "结构化内容未直接展示";
    if (/^\s*[[{]/u.test(source)) {
      try {
        const parsed = JSON.parse(source);
        if (object(parsed) || Array.isArray(parsed)) return "结构化内容未直接展示";
      } catch { /* Bracketed prose is still ordinary content. */ }
    }
    return source
      .replace(/\bauthorization\s*[:=]\s*[^\r\n]+/giu, "Authorization=已隐藏")
      .replace(/[a-z]:[\\/][^\s，。；）)]+/giu, "本机路径")
      .replace(/(?:https?|file):\/\/[^\s，。；）)]+/giu, "网络地址")
      .replace(/\bsession-[0-9a-f]{8,}\b/giu, "会话")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "内部标识")
      .replace(/\b(token|api[-_]?key|authorization|secret)\s*[:=]\s*\S+/giu, "$1=已隐藏") || missing;
  }
  function value(raw, digits = 0, suffix = "") {
    const n = number(raw);
    return n === null ? missing : new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: digits, maximumFractionDigits: digits
    }).format(n) + suffix;
  }
  const bool = (raw, yes = "是", no = "否") => raw === true ? yes : raw === false ? no : missing;
  function memoryState(row) {
    if (!object(row)) return missing;
    if (row.isActive === false) return "留档";
    return ({ active: "现役", quarantined: "隔离", forgotten: "留档" })[row.status] || text(row.status);
  }
  function keywords(raw, depth = 0) {
    if (raw === null || raw === undefined) return missing;
    if (depth > 4) return "更深层关键词";
    if (Array.isArray(raw)) return raw.map(item => keywords(item, depth + 1)).join("、") || "无";
    if (object(raw)) return Object.entries(raw).map(([key, val]) => text(key) + "：" + keywords(val, depth + 1)).join("；") || "无";
    return typeof raw === "boolean" ? bool(raw) : typeof raw === "number" ? value(raw) : text(raw);
  }
  function reason(raw) {
    if (typeof raw !== "string" || !raw.trim()) return missing;
    return ({ idle: "空闲", disabled: "已关闭", "engine-says-no": "引擎判定暂不需要", "night-hold": "夜间暂缓",
      "session-mismatch": "会话范围不匹配", "daily-cap": "已到当日上限", "pending-ack": "等待回执",
      "deliver-busy": "渠道忙", sent: "已经发出", "reminder-sent": "提醒已发", "reminder-busy": "提醒渠道忙",
      "wake-sent": "唤醒已发", "wake-busy": "唤醒渠道忙", "wake-night-hold": "夜间暂缓唤醒",
      "tick-error": "本次检查失败", backoff: "等待退避", cold: "尚未预热", warm: "已经预热",
      "power-off": "总闸已关闭", "empty-query": "没有可用原话", "no-runner": "执行通道不可用",
      "cache-hit": "使用缓存", throttled: "本次受频率限制" })[raw] || "有补充诊断，原文未直接展开";
  }
  function mode(raw) {
    if (typeof raw !== "string" || !raw) return missing;
    return ({ python: "Python引擎", baseline: "JS基线", offline: "离线", private: "仅私聊", group: "群聊",
      all: "全部会话", whitelist: "名单内会话", exempt: "排除名单", companion: "陪伴会话",
      quiet: "静默", reminder: "提醒", wake: "唤醒", direct: "直连", subagent: "辅助执行", off: "关闭",
      shadow: "只读观察", active: "已启用" })[raw] || "其他模式";
  }
  function temporal(raw) {
    if (typeof raw !== "string" || !raw) return missing;
    return ({ time_unknown: "时间未知", current: "当前有效", enduring: "持续有效", past: "过去",
      future: "将来", ongoing: "进行中", expired: "已结束", permanent: "长期有效", bounded: "有时间界限" })[raw] || "其他时间态";
  }
  function date(raw, milliseconds = false) {
    const n = number(raw);
    if (n === null || n <= 0) return missing;
    const d = new Date(milliseconds === "auto" ? n < 1e11 ? n * 1000 : n : milliseconds ? n : n * 1000);
    return Number.isNaN(d.getTime()) ? missing : d.toLocaleString("zh-CN", { hour12: false });
  }
  const el = (tag, className = "", content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = text(content);
    return node;
  };
  function button(label, action, className = "dp-button") {
    const node = el("button", className, label);
    node.type = "button"; node.addEventListener("click", action); return node;
  }
  function link(label, href) {
    const node = el("a", "dp-button", label);
    node.href = href; node.target = "_blank"; node.rel = "noopener noreferrer"; return node;
  }
  function section(root, title, description = "") {
    const node = el("section", "dp-section");
    const head = el("div", "dp-section-head"), copy = el("div", "dp-heading");
    copy.append(el("h2", "", title));
    if (description) copy.append(el("p", "dp-note", description));
    const actions = el("div", "dp-actions"); head.append(copy, actions);
    const status = el("p", "dp-read-state", "尚未读取"); status.setAttribute("aria-live", "polite");
    const content = el("div", "dp-section-content"); node.append(head, status, content); root.append(node);
    return { node, head, actions, status, content, lastAt: null, data: null };
  }
  function pairs(root, rows) {
    const dl = el("dl", "dp-kv");
    for (const [label, raw, kind] of rows) {
      const dd = el("dd", kind === "prose" ? "dp-prose" : "");
      if (kind === "node" && raw?.nodeType === 1) dd.append(raw);
      else dd.textContent = text(raw);
      dl.append(el("dt", "", label), dd);
    }
    root.append(dl); return dl;
  }
  class SessionNames {
    constructor() { this.labels = new Map(); this.neutral = new Map(); this.nodes = new Map(); }
    prune() {
      for (const [node] of this.nodes) if (!node.isConnected) this.nodes.delete(node);
    }
    name(id) {
      if (typeof id !== "string" || !id) return "来源未提供";
      if (this.labels.has(id)) return this.labels.get(id);
      if (!this.neutral.has(id)) this.neutral.set(id, "会话 " + (this.neutral.size + 1));
      return this.neutral.get(id);
    }
    marker(id) {
      const node = el("span", "dp-session-name", this.name(id));
      this.nodes.set(node, id);
      return node;
    }
    apply(scope) {
      const raw = object(scope?.sessionLabels) ? scope.sessionLabels : {};
      const next = new Map();
      for (const [id, label] of Object.entries(raw)) {
        if (typeof label !== "string" || !label.trim()) continue;
        const clean = label.trim();
        if (text(clean) === clean) next.set(id, clean);
      }
      this.labels = next;
      this.prune();
      for (const [node, id] of this.nodes) {
        node.textContent = this.name(id);
      }
    }
  }
  function stats(root, rows) {
    const dl = el("dl", "dp-stats");
    for (const [label, raw] of rows) {
      const item = el("div"); item.append(el("dt", "", label), el("dd", "", raw)); dl.append(item);
    }
    root.append(dl); return dl;
  }
  function note(root, label, className = "dp-note") { root.append(el("p", className, label)); }
  function empty(root, label) { root.replaceChildren(el("p", "dp-empty", label)); }
  function dictionary(root, title, raw, label = text) {
    const entries = object(raw) ? Object.entries(raw) : [];
    const box = el("div", "dp-breakdown"); box.append(el("h3", "", title));
    if (!entries.length) note(box, object(raw) ? "当前没有分布记录。" : "未提供分布明细。");
    else pairs(box, entries.map(([key, count]) => [label(key), value(count, 0, " 条")]));
    root.append(box); return box;
  }
  function field(label, control) {
    const node = el("label", "dp-field"); node.append(el("span", "", label), control); return node;
  }
  function select(label, options, current, change) {
    const control = el("select"); control.setAttribute("aria-label", label);
    for (const [key, title] of options) {
      const option = el("option", "", title); option.value = key; control.append(option);
    }
    control.value = current;
    if (change) control.addEventListener("change", () => change(control.value));
    return control;
  }
  const atPath = (raw, key) => key.split(".").reduce((current, part) => current?.[part], raw);
  function measured(root, data, descriptors) {
    return pairs(root, descriptors.map(([key, label, kind, suffix]) => {
      const raw = atPath(data, key);
      return [label, kind === "bool" ? bool(raw) : kind === "date" ? date(raw)
        : kind === "reason" ? reason(raw) : kind === "mode" ? mode(raw)
          : kind === "ms-date" ? date(raw, true) : kind === "auto-date" ? date(raw, "auto")
          : kind === "text" ? text(raw) : value(raw, kind || 0, suffix || "")];
    }));
  }
  function schemaError() { return Object.assign(new Error("invalid response"), { category: "shape" }); }
  class Reader {
    constructor(api) { this.api = api; this.closed = false; this.jobs = new Map(); }
    load(block, url, draw, { reset = false } = {}) {
      if (this.closed || this.api.signal?.aborted) return Promise.resolve(null);
      const previous = this.jobs.get(block);
      if (previous?.url === url) return previous.promise;
      previous?.controller.abort();
      if (reset) { block.lastAt = null; block.data = null; }
      const controller = new AbortController(), job = { url, controller, promise: null };
      this.jobs.set(block, job);
      const live = () => !this.closed && !this.api.signal?.aborted && !controller.signal.aborted && this.jobs.get(block) === job;
      block.node.setAttribute("aria-busy", "true");
      block.status.className = "dp-read-state";
      block.status.textContent = block.lastAt ? "正在刷新；上次读取 " + date(block.lastAt, true) : "正在读取";
      if (!block.lastAt) block.content.replaceChildren(this.api.states.loading(3));
      for (const node of block.actions.querySelectorAll("button")) node.disabled = true;
      job.promise = Promise.resolve().then(() => live() ? this.api.get(url, controller.signal) : null).then(payload => {
        if (!live()) return null;
        if (!object(payload)) throw schemaError();
        if (payload.offline === true) throw Object.assign(new Error("offline"), { category: "offline" });
        const fragment = document.createElement("div");
        const committed = draw(payload, fragment);
        if (!live()) return null;
        block.content.replaceChildren(...fragment.childNodes);
        if (typeof committed === "function") committed();
        block.data = payload; block.lastAt = Date.now();
        block.status.textContent = "读取于 " + date(block.lastAt, true);
        return payload;
      }).catch(error => {
        if (!live() || error?.name === "AbortError") return null;
        block.status.className = "dp-read-state is-error";
        const label = error?.category === "offline" ? "数据源离线" : error?.category === "shape" ? "返回数据不完整" : "暂时读取失败";
        block.status.textContent = label + (block.lastAt ? "；保留上次读取 " + date(block.lastAt, true) : "，可重试");
        if (!block.lastAt) block.content.replaceChildren(this.api.states.error(label + "。", () => this.load(block, url, draw)));
        return null;
      }).finally(() => {
        if (this.jobs.get(block) !== job) return;
        this.jobs.delete(block); block.node.removeAttribute("aria-busy");
        for (const node of block.actions.querySelectorAll("button")) node.disabled = false;
      });
      return job.promise;
    }
    close() {
      this.closed = true;
      for (const [block, job] of this.jobs) {
        job.controller.abort(); block.node.removeAttribute("aria-busy");
        if (!block.lastAt) block.status.textContent = "读取已取消";
      }
      this.jobs.clear();
    }
  }
  return { missing, number, object, text, value, bool, memoryState, keywords, reason, mode, temporal, date, el, button, link, section, pairs, stats,
    note, empty, dictionary, field, select, measured, atPath, schemaError, Reader, SessionNames };
})();
