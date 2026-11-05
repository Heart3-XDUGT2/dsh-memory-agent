globalThis.EchoViews = globalThis.EchoViews || {};
globalThis.EchoViews.emotion = (function () {
  "use strict";
  const P = globalThis.EchoPanels;
  const dimensions = [
    ["global", "全局感受", [["fatigue", "疲惫"], ["valence", "心情"], ["arousal", "唤醒"]]],
    ["target_master", "关系感受", [["affection", "爱意"], ["playfulness", "调皮"], ["sadness", "委屈"], ["dependency", "依赖"]]]
  ];
  const names = new P.SessionNames();
  let reader, built = false, currentBlock, longingBlock, spaceBlock, sourceBlock, visual = null;
  function build(root) {
    root.classList.add("dp-page");
    currentBlock = P.section(root, "现在的心情", "最近保存的状态快照；更新时间和本页读取时间分开，缺少的维度不补零。");
    currentBlock.actions.append(P.button("重新读取心情", loadCurrent));
    longingBlock = P.section(root, "牵挂与关怀", "来源为已有想念接口；没有可用坐标或牵挂值时保留缺值。");
    longingBlock.actions.append(P.button("重新读取牵挂", loadLonging));
    spaceBlock = P.section(root, "情绪空间", "情感、人际与共享轴并列查看；只读，不回写坐标。");
    spaceBlock.actions.append(P.button("重新读取空间", loadSpace));
    sourceBlock = P.section(root, "会话来源", "优先使用会话标签；名称不可用时，用本页稳定的中性会话别名区分来源。");
    sourceBlock.actions.append(P.button("重新读取来源标签", loadSources));
  }
  function vectors(root, raw) {
    const groups = P.el("div", "dp-columns"); groups.style.marginTop = "24px";
    for (const [key, title, fields] of dimensions) {
      const group = P.el("div"); group.append(P.el("h3", "", title));
      for (const [name, label] of fields) {
        const n = P.number(raw?.[key]?.[name]), row = P.el("div", "dp-meter-row");
        const meter = P.el("span", "dp-meter"), fill = P.el("span");
        fill.style.width = n === null ? "0%" : Math.max(0, Math.min(100, n * 10)) + "%";
        meter.append(fill); row.append(P.el("span", "", label), meter, P.el("span", "dp-num", P.value(n, 1))); group.append(row);
      }
      groups.append(group);
    }
    root.append(groups);
  }
  function drawCurrent(payload, root) {
    if (!Array.isArray(payload.rows) || !payload.rows.every(P.object)) throw P.schemaError();
    names.prune();
    const rows = [...payload.rows].sort((a, b) => (P.number(b.updatedAt) ?? -1) - (P.number(a.updatedAt) ?? -1));
    if (!rows.length) { P.empty(root, "还没有保存的心情快照。对话形成状态后可在这里读取。"); return; }
    const current = rows[0];
    P.stats(root, [["当前强度", P.value(current.moodIntensity, 1, " /10")], ["上一轮强度", P.value(current.prevMoodIntensity, 1, " /10")]]);
    P.pairs(root, [
      ["来源会话", names.marker(current.sessionId), "node"],
      ["情绪", P.text(current.userEmotion)], ["心情理由", P.text(current.moodReason), "prose"], ["当时话题", P.text(current.currentTopic), "prose"],
      ["状态更新时间", P.date(current.updatedAt)]
    ]);
    vectors(root, current.emotionVector);
    const history = P.el("details", "dp-space-info"); history.append(P.el("summary", "", "近期状态快照"));
    P.note(history, "本次返回 " + P.value(rows.length) + " 份会话最新状态，不是全部逐轮历史；逐轮变化见下方情绪空间。");
    rows.forEach((row, index) => {
      const item = P.el("details", "dp-memory-row"); item.append(P.el("summary", "", P.date(row.updatedAt) + " · 强度 " + P.value(row.moodIntensity, 1)));
      P.pairs(item, [
        ["显示序号", P.value(index + 1)], ["当前强度", P.value(row.moodIntensity, 1)], ["上一轮强度", P.value(row.prevMoodIntensity, 1)],
        ["来源会话", names.marker(row.sessionId), "node"],
        ["情绪", P.text(row.userEmotion)], ["理由", P.text(row.moodReason), "prose"], ["话题", P.text(row.currentTopic), "prose"]
      ]); vectors(item, row.emotionVector); history.append(item);
    });
    root.append(history);
  }
  function drawLonging(payload, root) {
    if (!Array.isArray(payload.rows) || !payload.rows.every(P.object)) throw P.schemaError();
    if (!payload.rows.length) { P.empty(root, "还没有可用牵挂读数。"); return; }
    payload.rows.forEach((row, index) => {
      const box = P.el("div", "dp-breakdown"); box.append(P.el("h3", "", payload.rows.length > 1 ? "牵挂记录 " + P.value(index + 1) : "牵挂读数"));
      P.pairs(box, [
        ["当前牵挂值", P.value(row.value, 2)], ["判定阈值", P.value(row.threshold, 2)],
        ["距上次来访", P.value(row.sinceMessage, 0, " 秒")], ["已关怀", P.value(row.careCount, 0, " 次")],
        ["上次关怀", P.date(row.lastCareAt)], ["需要关怀", P.bool(row.shouldCare)], ["读数来源", row.engine === "python" ? "引擎真值" : row.engine === "baseline" ? "JS基线" : P.missing]
      ]); root.append(box);
    });
  }
  function loadCurrent() { return reader?.load(currentBlock, "/api/echo/emotion", drawCurrent); }
  function loadLonging() { return reader?.load(longingBlock, "/api/echo/longing", drawLonging); }
  function loadSpace() {
    return reader?.load(spaceBlock, "/api/echo/emotion-space?limit=40", (payload, root) => {
      const next = globalThis.EchoPanelSpace.build(root, payload, names);
      return () => { visual?.stop(); visual = next; visual.start(); };
    });
  }
  function loadSources() {
    return reader?.load(sourceBlock, "/api/echo/scope", (payload, root) => {
      if (!P.object(payload.sessionLabels)) throw P.schemaError();
      P.note(root, "会话标签已读取。未命名来源继续使用中性别名，内部会话标识不直接展示。");
      return () => names.apply(payload);
    });
  }
  function refresh() { return Promise.allSettled([loadCurrent(), loadLonging(), loadSpace(), loadSources()]); }
  function mount(root, api) {
    reader = new P.Reader(api); if (!built) { build(root); built = true; } visual?.start(); return refresh();
  }
  function unmount() { reader?.close(); visual?.stop(); }
  return { mount, unmount, refresh };
})();
