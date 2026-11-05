// 列表与轮页共用范围、请求和中性深链；会话原值只传给服务端。
(function () {
  "use strict";
  const LIMIT = 500;
  const normalize = (value) => value === "all" ? "all" : "companion";
  const scopeOf = (hash) => normalize(new URLSearchParams(String(hash).split("?")[1] || "").get("scope"));
  function href(id, key, scope) {
    return `#/${id === "round" ? `round/${key}` : "audit"}?scope=${normalize(scope)}`;
  }
  function endpoint(scope, session) {
    const query = new URLSearchParams({ limit: String(LIMIT), light: "1" });
    if (normalize(scope) === "companion") {
      if (typeof session !== "string" || session.trim() === "") throw scopeError("尚未配置陪伴会话，请切到全部会话查看。");
      query.set("sessionId", session);
    }
    return `/api/echo/audit?${query}`;
  }
  function scopeError(message) {
    const error = new Error(message);
    error.name = "AuditScopeError";
    return error;
  }
  function create({ scope, get, signal, change, timeoutMs = 3000 }) {
    scope = normalize(scope);
    let current = null;
    let hint = null;
    let follows = false;
    let windowContext = null;
    let cancelCheck = () => {};
    const listeners = new Set();
    function notify() { for (const listener of listeners) listener(); }
    const hintText = () => scope === "all" ? "包含陪伴、其他会话与全局后台。"
      : follows ? "QQ 会跟随正在使用的窗口；找不到时可切到全部会话。全局后台也在全部会话中。"
        : "只读设置中的陪伴会话；QQ 若跟随其他窗口，可切到全部会话。全局后台也在全部会话中。";
    async function read() {
      cancelCheck();
      if (current) current.abort();
      current = new AbortController();
      const request = AbortSignal.any([signal, current.signal]);
      const identity = current;
      let context = null;
      let metadata = { state: scope === 'all' ? 'checking' : 'unchecked' };
      windowContext = null;
      let finished = false, timer = null;
      const optional = new AbortController();
      function settle(next) {
        if (finished || current !== identity) return;
        finished = true;
        clearTimeout(timer);
        request.removeEventListener('abort', cancel);
        metadata = next;
        context?.update(next);
        notify();
      }
      function cancel() {
        settle({ state: 'unchecked' });
        optional.abort();
      }
      cancelCheck = cancel;
      request.addEventListener('abort', cancel, { once: true });
      let session = "";
      if (scope === "companion") {
        let settings;
        try { settings = await get("/api/echo/settings", request); }
        catch (error) {
          request.throwIfAborted();
          throw scopeError("陪伴会话设置读取失败，请重试或切到全部会话。");
        }
        request.throwIfAborted();
        session = settings?.settings?.relay?.sessionId;
        settle({ state: 'known', session });
        follows = settings?.settings?.relay?.followHisWindow === true;
        if (hint) hint.textContent = hintText();
      } else {
        timer = setTimeout(cancel, timeoutMs);
        // 可选核对与审计独立；迟到且忽略取消的响应也不能改变旧窗口。
        Promise.resolve().then(() => get('/api/echo/settings', AbortSignal.any([request, optional.signal])))
          .then(settings => {
            const value = settings?.settings?.relay?.sessionId;
            settle(globalThis.EchoAuditOwnership.valid(value) ? { state: 'known', session: value } : { state: 'unchecked' });
          }, () => settle({ state: 'unchecked' }));
      }
      const payload = await get(endpoint(scope, session), request);
      request.throwIfAborted();
      context = globalThis.EchoAuditOwnership.create(Array.isArray(payload?.rows) ? payload.rows : [], metadata);
      windowContext = context;
      return payload;
    }
    function controls() {
      const wrap = document.createElement("section");
      wrap.className = "audit-scope";
      const group = document.createElement("div");
      group.className = "audit-scope-options";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "审计会话范围");
      for (const [value, label] of [["companion", "陪伴会话"], ["all", "全部会话"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.dataset.scope = value;
        button.setAttribute("aria-pressed", String(scope === value));
        button.addEventListener("click", () => { if (value !== scope) change(value); });
        group.append(button);
      }
      const caption = document.createElement("p");
      caption.className = "audit-scope-caption";
      caption.textContent = `本次读取最近 ${LIMIT} 行 · ${scope === "all" ? "全部会话" : "陪伴会话"}`;
      hint = document.createElement("p");
      hint.className = "audit-scope-hint";
      hint.textContent = hintText();
      wrap.append(group, caption, hint);
      return wrap;
    }
    return { scope, read, controls, href: (id, key) => href(id, key, scope),
      ownership: () => windowContext,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      cancel: () => cancelCheck() };
  }
  globalThis.EchoAuditScope = { LIMIT, normalize, scopeOf, href, endpoint, create };
})();
