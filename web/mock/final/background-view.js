// 两页共用后台阅读图与日记全文控件；生命周期显式重绑，不复用已取消的路由请求。
globalThis.EchoBackgroundView = (function () {
  'use strict';
  const controls = new WeakMap();
  let serial = 0;
  function all(root, action, api) {
    if (!root) return;
    for (const node of root.querySelectorAll('.bg-diary')) controls.get(node)?.[action](api);
  }
  function diary(parent, event, initialApi) {
    const model = globalThis.EchoBackgroundEvents;
    const box = initialApi.el('div', 'bg-diary');
    const button = initialApi.el('button', 'bg-read', '读取日记全文');
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    const body = initialApi.el('div', 'bg-diary-body');
    body.id = `bg-diary-${++serial}`;
    body.hidden = true;
    button.setAttribute('aria-controls', body.id);
    const state = initialApi.el('p', 'bg-read-state');
    state.setAttribute('role', 'status');
    const copy = initialApi.el('p', 'bg-diary-copy');
    const note = initialApi.el('p', 'bg-read-note');
    body.append(state, copy, note);
    box.append(button, body);
    parent.append(box);
    let api = initialApi, ticket = 0, controller = null, live = true, full = '', expanded = false;
    function reset() {
      ticket += 1;
      controller?.abort();
      controller = null;
      full = '';
      expanded = false;
      body.hidden = true;
      copy.textContent = '';
      state.textContent = '';
      note.textContent = '';
      button.textContent = '读取日记全文';
      button.setAttribute('aria-expanded', 'false');
    }
    function invalidate() { reset(); live = false; }
    function bind(next) { reset(); api = next; live = true; }
    controls.set(box, { bind, invalidate });
    parent.addEventListener('toggle', () => { if (!parent.open) reset(); });
    button.addEventListener('click', async () => {
      if (!live) return;
      if (expanded) { reset(); return; }
      expanded = true;
      body.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      button.textContent = '收起日记';
      state.textContent = '正在读取该日期的日记…';
      copy.textContent = '';
      note.textContent = '';
      const current = ++ticket;
      controller = new AbortController();
      const request = controller;
      const accept = () => live && expanded && current === ticket && !request.signal.aborted && box.isConnected && !api.signal?.aborted;
      try {
        const payload = await api.get(`/api/echo/diary?${new URLSearchParams({ date: event.diaryDate })}`, request.signal);
        if (!accept()) return;
        if (payload?.offline === true) { state.textContent = '日记存储离线，暂时无法读取。'; return; }
        if (!payload || !Array.isArray(payload.rows)) { state.textContent = '日记响应格式不符，请重试。'; return; }
        if (payload.rows.length === 0) { state.textContent = '该日期的日记不存在。'; return; }
        const row = payload.rows[0];
        if (payload.rows.length !== 1 || !row || typeof row.content !== 'string') { state.textContent = '日记响应格式不符，请重试。'; return; }
        if (row.date !== event.diaryDate) { state.textContent = '日记响应与请求日期不符，请重试。'; return; }
        full = model.safe(row.content);
        const changed = full !== row.content;
        state.textContent = changed ? '正文已读取，内部标识已隐藏。' : `日记正文 · ${row.content.length} 字`;
        note.textContent = changed ? '显示内容经过安全处理，与权威原文分别核对。' : '';
        copy.textContent = full.length > 600 ? `${full.slice(0, 600)}…` : full;
        if (full.length > 600) {
          const more = api.el('button', 'bg-more', '展开剩余正文');
          more.type = 'button';
          more.setAttribute('aria-expanded', 'false');
          more.addEventListener('click', () => {
            const open = more.getAttribute('aria-expanded') === 'true';
            copy.textContent = open ? `${full.slice(0, 600)}…` : full;
            more.setAttribute('aria-expanded', String(!open));
            more.textContent = open ? '展开剩余正文' : '折叠长文';
          });
          note.append(more);
        }
      } catch (error) {
        if (!accept()) return;
        state.textContent = error?.name === 'AbortError' ? '读取已取消，可收起后重试。' : '日记读取失败，可收起后重试。';
      }
    });
  }
  function render(projection, api, rows = []) {
    const el = api.el;
    const wrap = el('section', 'bg-events');
    wrap.append(el('h3', 'bg-title', '后台事件'), el('p', 'bg-count', `${projection.rowCount} 条真实审计记录 · ${projection.events.length} 条事件可读`),
      el('p', 'bg-explain', '每条事件分为触发、处理、产出三个阅读模块；连线表示内容关系。'));
    for (const event of projection.events) {
      const article = el('article', 'bg-event');
      article.dataset.eventKind = event.kind;
      article.dataset.eventRow = String(event.rowIndex);
      article.append(el('h4', 'bg-event-title', `${event.rowIndex + 1}. ${event.title} · ${event.status}`));
      article.append(globalThis.EchoOwnershipView.label(api, rows[event.rowIndex], true));
      if (event.detailState === 'invalid') article.append(el('p', 'bg-detail-state', '结构字段损坏，无法解析的值显示为缺值。'));
      const graph = el('div', 'bg-flow');
      graph.setAttribute('aria-label', `${event.title}的三个阅读模块`);
      event.modules.forEach((module, i) => {
        const part = el('details', 'bg-module');
        part.open = true;
        part.append(el('summary', 'bg-module-title', module.title));
        const list = el('dl', 'bg-fields');
        for (const item of module.fields) {
          const row = el('div', 'bg-field');
          const value = el('dd', 'bg-value', item.value);
          value.dataset.source = item.source;
          value.title = `来自该条审计的 ${item.source}`;
          row.append(el('dt', 'bg-label', item.label), value);
          list.append(row);
        }
        part.append(list);
        if (i === 2 && event.kind === 'diary' && event.diaryDate) diary(part, event, api);
        graph.append(part);
        if (i < 2) {
          const edge = el('div', 'bg-connection');
          const button = el('button', 'bg-edge', event.links[i].label);
          const detail = el('p', 'bg-edge-detail', event.links[i].detail);
          button.type = 'button';
          button.setAttribute('aria-expanded', 'false');
          detail.hidden = true;
          detail.id = `bg-edge-${++serial}`;
          button.setAttribute('aria-controls', detail.id);
          button.addEventListener('click', () => { detail.hidden = !detail.hidden; button.setAttribute('aria-expanded', String(!detail.hidden)); });
          edge.append(button, detail);
          graph.append(edge);
        }
      });
      article.append(graph);
      wrap.append(article);
    }
    return wrap;
  }
  return { render, bind: (root, api) => all(root, 'bind', api), invalidate: root => all(root, 'invalidate') };
})();
