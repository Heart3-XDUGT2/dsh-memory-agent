globalThis.EchoViews = globalThis.EchoViews || {};
globalThis.EchoViews.maintenance = (function () {
  "use strict";
  const P = globalThis.EchoPanels, A = globalThis.EchoMaintenanceActions;
  const files = ["config.json", "persona.json", "profile.json", "aliases.json", "names.json", "graph.json", "state-defaults.json", "lexicon.json"];
  const titles = { "config.json": "主配置", "persona.json": "人格", "profile.json": "称呼与画像", "aliases.json": "别名",
    "names.json": "人名词表", "graph.json": "图谱规则", "state-defaults.json": "新状态初值", "lexicon.json": "词库" };
  const routes = { "cooc-evidence": "最近一批共现证据", "topic-view": "现行主题簇" };
  let reader, built = false, mounted = false, api, health, backups, sessions, arch, operationBox, selected = "", scopeData = null, repairRequest = 0;
  const action = new A.Action(renderOperation);
  const backupNames = new Map();
  function readableTime(raw) {
    if (P.number(raw) !== null) return P.date(raw, "auto");
    if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(raw)) return P.missing;
    const stamp = Date.parse(raw); return Number.isFinite(stamp) ? P.date(stamp, true) : P.missing;
  }
  function renderOperation() {
    if (!mounted || !operationBox) return;
    operationBox.replaceChildren(); operationBox.hidden = action.state === "idle";
    if (action.state === "idle") return;
    operationBox.append(P.el("h3", "", action.target?.label || "维护操作"));
    P.note(operationBox, action.target?.consequence || "");
    if (action.state === "confirm") {
      P.note(operationBox, "确认后会发出一次维护请求。更换对象需要重新确认。");
      operationBox.append(P.button("确认执行", () => action.submit(A.interpret(action.target.kind))),
        P.button("取消", () => action.cancel()));
    } else {
      P.note(operationBox, action.message, action.state === "unconfirmed" ? "dp-read-state is-error" : "dp-note");
      if (action.state === "pending") P.note(operationBox, "离开页面不代表撤销服务端操作；请勿重复提交。");
    }
  }
  function prepare(target, request) {
    if (action.state === "pending") return;
    repairRequest++;
    action.prepare(target, request); operationBox?.scrollIntoView({ block: "nearest" });
  }
  function build(root) {
    root.classList.add("dp-page", "mb-page");
    operationBox = P.el("section", "dp-section mb-operation"); operationBox.setAttribute("aria-live", "polite"); operationBox.hidden = true;
    health = P.section(root, "数据文件体检", "八个受管文件分别检查。缺失、空内容、损坏和校验提醒是不同状态；不会自动修复。");
    health.actions.append(P.button("重新读取体检", loadHealth));
    root.append(operationBox);
    backups = P.section(root, "备份清单", "最近最多50份，只列文件、时间与大小，不读取备份正文，不自动恢复或删除。");
    backups.actions.append(P.button("重新读取清单", loadBackups));
    backups.actions.append(P.button("备份全部", () => prepare({
      kind: "backup", label: "备份八个受管文件", consequence: "拷贝现有文件到备份区，不改原文件；不存在的文件会跳过。"
    }, { url: "/api/echo/data/backup", body: {} })));
    sessions = P.section(root, "清空会话上下文", "把所选会话的旧上下文压缩为摘要，历史记录和记忆库不删除。可能需要等待她空闲。");
    sessions.actions.append(P.button("重新读取会话", loadSessions));
    arch = P.section(root, "图谱架构", "主题簇、证据、历史影子和回执分开查看。回退仅提供后端现有的两条路线。");
    arch.actions.append(P.button("重新读取架构", loadArch));
    const tasks = P.el("nav", "mb-tasks"); tasks.setAttribute("aria-label", "维护任务");
    const groups = [["文件体检", health], ["备份", backups], ["会话压缩", sessions], ["图谱架构", arch]], buttons = new Map();
    for (const [label, section] of groups) {
      const title = section.node.querySelector("h2"); title.tabIndex = -1;
      section.node.hidden = section !== health;
      const button = P.button(label, () => {
        repairRequest++; action.resetConfirmation();
        for (const [, group] of groups) { group.node.hidden = group !== section; buttons.get(group).setAttribute("aria-pressed", String(group === section)); }
        title.focus({ preventScroll: true });
      });
      button.setAttribute("aria-pressed", String(section === health)); buttons.set(section, button); tasks.append(button);
    }
    root.prepend(tasks);
  }
  async function prepareRepair(file) {
    if (!mounted || action.state === "pending") return;
    action.resetConfirmation();
    const generation = ++repairRequest;
    const identity = reader, data = await api.get("/api/echo/data/" + encodeURIComponent(file)).catch(() => null);
    if (!mounted || reader !== identity || identity.closed || generation !== repairRequest || action.state === "pending") return;
    if (!P.object(data) || !P.object(data.template) || (data.exists !== false && data.unreadable !== true)) {
      action.prepare({ kind: "repair", label: titles[file] || "文件", consequence: "" }, {});
      action.state = "refused"; action.message = "当前文件不再是缺失或损坏状态，或模板不可读取。请重新体检，不会覆盖。"; renderOperation(); return;
    }
    prepare({ kind: "repair", file, label: "重建" + titles[file],
      consequence: "使用该文件的空模板重建。现有坏文件会先按服务端流程备份；不会恢复用户旧内容。" },
    { url: "/api/echo/data/" + encodeURIComponent(file), method: "PUT", body: data.template });
  }
  function drawHealth(data, root) {
    if (!Array.isArray(data.files)) throw P.schemaError();
    P.note(root, "检查于 " + readableTime(data.checkedAt) + "；本次返回 " + P.value(data.files.length) + " 个文件状态。");
    const list = P.el("div", "mb-files");
    for (const row of data.files) {
      if (!files.includes(row.file)) continue;
      const item = P.el("article", "mb-file");
      const state = row.exists === false ? "缺失" : row.broken === true || row.unreadable === true ? "损坏"
        : Array.isArray(row.errors) && row.errors.length ? "校验未通过" : row.empty === true ? "内容为空" : row.exists === true ? "可读取" : "未知";
      const heading = P.el("div", "mb-file-heading"); heading.append(P.el("h3", "", titles[row.file]), P.el("span", "", state)); item.append(heading);
      const details = P.el("details", "mb-file-details"); details.append(P.el("summary", "", "文件详情"));
      P.pairs(details, [["状态", state], ["大小", P.value(row.bytes, 0, " 字节")], ["结构版本", P.value(row.schemaRev)],
        ["校验问题", Array.isArray(row.errors) ? P.value(row.errors.length) : P.missing],
        ["校验提醒", Array.isArray(row.warnings) ? P.value(row.warnings.length) : P.missing]]);
      item.append(details);
      const link = P.el("a", "dp-button", "前往设置"); link.href = "#/config"; item.append(link);
      if (row.exists === false || row.broken === true || row.unreadable === true) item.append(P.button("准备重建", () => prepareRepair(row.file)));
      list.append(item);
    }
    root.append(list);
  }
  function drawBackups(data, root) {
    if (!Array.isArray(data.files)) throw P.schemaError();
    P.note(root, "本次清单 " + P.value(data.files.length) + " 份；不代表全部历史备份。");
    if (!data.files.length) P.note(root, "尚未读取到备份。可在上方明确确认后备份现有文件。");
    for (const row of data.files) {
      const item = P.el("article", "mb-file");
      const key = typeof row.name === "string" && row.name ? row.name : JSON.stringify([row.file, row.mtime, row.bytes]);
      if (!backupNames.has(key)) backupNames.set(key, "备份 " + (backupNames.size + 1));
      P.pairs(item, [["备份记录", backupNames.get(key)], ["文件", titles[row.file] || "其他备份"],
        ["备份时间", readableTime(row.mtime)], ["大小", P.value(row.bytes, 0, " 字节")]]);
      root.append(item);
    }
  }
  function drawSessions(data, root) {
    if (!Array.isArray(data.sessions)) throw P.schemaError();
    scopeData = data;
    const names = new P.SessionNames(); names.apply(data);
    const choices = data.sessions.filter(row => typeof row.sessionId === "string" && row.sessionId);
    if (!choices.some(row => row.sessionId === selected)) selected = "";
    let prepareButton;
    const select = P.select("选择要压缩上下文的会话", [["", "选择会话"], ...choices.map(row => [row.sessionId, names.name(row.sessionId)])], selected, value => {
      selected = value; repairRequest++; action.resetConfirmation(); prepareButton.disabled = !selected;
    });
    root.append(P.field("会话", select));
    prepareButton = P.button("准备清空上下文", () => {
      if (!selected || !scopeData.sessions.some(row => row.sessionId === selected)) return;
      prepare({ kind: "clear", sessionId: selected, label: "清空上下文：" + names.name(selected),
        consequence: "仅压缩这个会话的旧上下文；历史记录不删除，也不清空记忆。服务端可能唤醒该会话，最长等待约三分钟。" },
      { url: "/api/echo/context/clear", body: { sessionId: selected }, timeoutMs: 190000 });
    });
    prepareButton.disabled = !selected; root.append(prepareButton);
    if (!choices.length) P.note(root, "当前没有可选择的会话，不会猜测最近会话。");
  }
  function drawArch(data, root) {
    if (!P.object(data.status)) throw P.schemaError();
    const state = data.status;
    P.pairs(root, [["主题簇当前数", Array.isArray(state.topics?.clusters) ? P.value(state.topics.clusters.length) : P.missing],
      ["主题摘要数", P.value(state.topics?.summaries)], ["证据行", P.value(state.evidence?.rows)],
      ["证据配对", P.value(state.evidence?.pairs)], ["证据节点", P.value(state.evidence?.nodes)],
      ["历史影子行", P.value(state.shadow?.rows)], ["事实节点", P.value(state.graph?.nodes)],
      ["事实关系", P.value(state.graph?.edges)], ["有效事实关系", P.value(state.graph?.active_edges)],
      ["回执累计", P.value(state.receipts?.total)], ["缺少依据关系", state.debt?.present === true ? P.value(state.debt?.weak_total) : P.missing]]);
    P.note(root, "架构检查于 " + P.date(state.generated_at) + "；" + (Array.isArray(state.notes) && state.notes.length
      ? "有 " + state.notes.length + " 项后台说明，按以下各层是否可用核对。" : "没有附加后台说明。"));
    const clusters = P.el("details", "mb-injection-part"); clusters.append(P.el("summary", "", "主题簇与摘要"));
    P.pairs(clusters, [["主题层存在", P.bool(state.topics?.present)], ["最近计算", P.date(state.topics?.computed_at)],
      ["当前批次", state.topics?.active_batch ? "已记录" : "未记录"]]);
    for (const row of Array.isArray(state.topics?.clusters) ? state.topics.clusters : []) {
      const item = P.el("article", "mb-file");
      item.append(P.el("h3", "", row.label || "未命名主题"));
      P.pairs(item, [["成员数", P.value(row.size)],
        ["软归属数量", Array.isArray(row.soft) ? P.value(row.soft.length) : P.missing],
        ["陈旧天数", P.value(row.stale_days, 1)]]);
      if (typeof row.summary === "string" && row.summary) item.append(P.el("p", "mb-prose", row.summary));
      clusters.append(item);
    }
    root.append(clusters);
    const debt = P.object(state.debt) && state.debt.present === true ? state.debt : null;
    const active = debt?.active, mixed = P.number(active?.mixed), real = P.number(active?.real);
    const debtView = P.el("details", "mb-injection-part"); debtView.append(P.el("summary", "", "有效关系依据分类"));
    P.pairs(debtView, [
      ["分类读数可用", P.bool(state.debt?.present)], ["活跃关系数", P.value(active?.edges)],
      ["无依据", P.value(active?.none)], ["仅推定", P.value(active?.inferred)],
      ["混合依据", P.value(mixed)], ["直接依据", P.value(real)],
      ["有依据合计", mixed !== null && real !== null ? P.value(mixed + real) : P.missing],
      ["弱依据关系总数", P.value(debt?.weak_total)]
    ]);
    const weak = Array.isArray(debt?.weak) ? debt.weak.filter(P.object) : null;
    P.note(debtView, weak ? "本次可读弱依据关系 " + P.value(weak.length) + " 条；总数按上方报告，不以窗口条数替代。"
      : "接口未提供弱依据关系明细，不能按零条解释。");
    if (weak?.length === 0) P.note(debtView, "本次返回的弱依据关系列表为空。");
    for (const [index, row] of (weak || []).entries()) {
      const item = P.el("article", "mb-file"); item.append(P.el("h3", "", "弱依据关系 " + P.value(index + 1)));
      P.pairs(item, [
        ["关系词", P.text(row.relation)],
        ["依据类型", ({ none: "无依据", inferred: "仅推定", mixed: "混合依据", real: "直接依据" })[row.strength] || P.missing],
        ["层级", P.text(row.layer)], ["学到于", P.date(row.learned_at)]
      ]);
      debtView.append(item);
    }
    P.note(debtView, "本次接口没有提供的两端名称保持缺席；内部关系编号与原始依据串不直接展示。");
    root.append(debtView);
    const evidence = P.el("details", "mb-injection-part"); evidence.append(P.el("summary", "", "证据层与失效回执"));
    P.pairs(evidence, [["证据层存在", P.bool(state.evidence?.present)], ["历史影子冻结", P.bool(state.shadow?.frozen)],
      ["凭据调查可用", P.bool(state.debt?.present)], ["异常事实类型行", P.value(state.debt?.nonfact_kind_rows)]]);
    P.dictionary(evidence, "证据范围分布", state.evidence?.by_scope, key => ({
      session: "会话内", turn: "同轮", global: "全局", document: "文档内", dialogue: "对话内"
    })[key] || "其他范围");
    const receipts = Array.isArray(state.receipts?.recent) ? state.receipts.recent : [];
    P.note(evidence, "本次返回最近回执 " + P.value(receipts.length) + " 条。");
    for (const row of receipts) {
      P.pairs(evidence, [["动作", row.action === "rollback" ? "回退" : "后台处理"],
        ["路线", routes[row.route] || "其他维护路线"], ["记录时间", P.date(row.created_at || row.at)]]);
    }
    root.append(evidence);
    P.note(root, "历史影子层已冻结，没有回退操作。以下路线仅处理当前后端报告可回退的批次。");
    for (const row of Array.isArray(state.rollback) ? state.rollback : []) {
      if (!Object.hasOwn(routes, row.route)) continue;
      const box = P.el("article", "mb-file"); box.append(P.el("h3", "", routes[row.route]));
      P.pairs(box, [["当前可退", P.bool(row.available)], ["影响行数", P.value(row.rows)], ["可重新计算", P.bool(row.recomputable)]]);
      if (row.available === true) box.append(P.button("审查回退", () => prepare({
        kind: "rollback", route: row.route, label: "回退：" + routes[row.route],
        consequence: "按后端现有路线回退当前批次，预计影响 " + P.value(row.rows) + " 行。不会执行浏览器提供的SQL；需重新读取核对。" },
      { url: "/api/echo/graph-arch", body: { action: "rollback", route: row.route, confirm: true } })));
      root.append(box);
    }
  }
  function loadHealth() { return reader?.load(health, "/api/echo/setup", drawHealth); }
  function loadBackups() { return reader?.load(backups, "/api/echo/data/backups?limit=50", drawBackups); }
  function loadSessions() { return reader?.load(sessions, "/api/echo/scope", drawSessions); }
  function loadArch() { return reader?.load(arch, "/api/echo/graph-arch", drawArch); }
  function refresh() { repairRequest++; action.resetConfirmation(); return Promise.allSettled([loadHealth(), loadBackups(), loadSessions(), loadArch()]); }
  function mount(root, screenApi) {
    api = screenApi; mounted = true; reader = new P.Reader(api);
    if (!built) { build(root); built = true; } renderOperation(); return refresh();
  }
  function unmount() { mounted = false; repairRequest++; action.resetConfirmation(); reader?.close(); }
  return { mount, unmount, refresh };
})();
