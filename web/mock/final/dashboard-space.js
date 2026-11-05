/* Reuse the old public geometry without its paint(), raw JSON or singleton loop. */
globalThis.EchoPanelSpace = (function () {
  "use strict";
  const P = globalThis.EchoPanels;
  const gate = raw => ({ green: "允许进入提示", yellow: "只给方向", red: "不进入提示", unknown: "未知" }[raw] || P.missing);
  const direction = raw => ({ positive: "偏正向", negative: "偏负向", flat: "基本持平" }[raw] || P.missing);
  const dimension = raw => ({ p: "愉悦", a: "唤醒", d: "支配", valence: "愉悦", arousal: "唤醒", dominance: "支配" }[raw] || P.text(raw));
  const source = raw => raw === "derived" ? "推导，属于工程假设" : raw === "measured" ? "实测" : P.missing;
  const pair = raw => P.object(raw) ? "主导 " + P.value(raw.a, 2) + " · 亲近 " + P.value(raw.c, 2) : P.missing;
  // Current backend supplies all three PAD axes in [-1,1]. The old public
  // world/rotate/project geometry still consumes [0,1]; only this boundary adapts.
  function padPoint(pad, inheritedMissing) {
    const raw = P.object(pad) ? pad : {};
    const lists = [raw.missing, inheritedMissing].filter(Array.isArray);
    const missing = [...new Set(lists.flat().map(String))];
    const aliases = { p: ["p", "valence"], a: ["a", "arousal"], d: ["d", "dominance"] };
    const known = new Set(Object.values(aliases).flat());
    const keys = missing.map(key => key.split(".").at(-1));
    const uncertain = keys.some(key => !known.has(key));
    const shown = {}, unit = {};
    for (const key of ["p", "a", "d"]) {
      const absent = uncertain || keys.some(name => aliases[key].includes(name));
      const n = absent ? null : P.number(raw[key]);
      shown[key] = n;
      unit[key] = n === null || n < -1 || n > 1 ? null : (n + 1) / 2;
    }
    return { raw: shown, unit, missing, complete: lists.length > 0 && missing.length === 0
      && ["p", "a", "d"].every(key => unit[key] !== null) };
  }
  function historyPoint(row) {
    return padPoint({ p: row?.pad?.valence, a: row?.pad?.arousal, d: row?.pad?.dominance }, row?.missing);
  }
  function ipcPoint(raw, inheritedMissing) {
    if (!P.object(raw)) return null;
    const a = P.number(raw.a), c = P.number(raw.c);
    if (a === null || c === null || a < 0 || a > 1 || c < 0 || c > 1) return null;
    const irrelevant = new Set(["p", "a", "d", "valence", "arousal", "dominance", "playfulness", "sadness"]);
    const missing = [raw.missing, inheritedMissing].filter(Array.isArray).flat();
    if (missing.some(key => !irrelevant.has(String(key).split(".").at(-1)))) return null;
    return { a, c };
  }
  // Keep the original order. A missing row, source or time must break the path.
  // These arrays contain coordinates only; source identifiers never reach paint.
  function trajectorySegments(rows, project) {
    const segments = [];
    let previous = null, segment = null;
    for (const row of rows) {
      const point = project(row);
      if (!point) { previous = null; segment = null; continue; }
      const session = typeof row.sessionId === "string" ? row.sessionId.trim() : "";
      const at = P.number(row.at), known = session && at !== null && at > 0;
      if (!known || !previous || session !== previous.session || at <= previous.at) {
        segment = []; segments.push(segment);
      }
      segment.push(point);
      previous = known ? { session, at } : null;
    }
    return segments;
  }
  function details(root, title, rows, open = false) {
    const box = P.el("details"); box.open = open; box.append(P.el("summary", "", title)); P.pairs(box, rows); root.append(box); return box;
  }
  function readouts(root, data) {
    const pad = data.pad || {}, ipc = data.ipc || {}, union = data.union || {}, metrics = ipc.metrics;
    const shown = padPoint(pad, data.missing).raw;
    const groups = P.el("div", "dp-space-info");
    details(groups, "情感与共享轴", [
      ["愉悦度（负1至1）", P.value(shown.p, 2)], ["唤醒度（负1至1）", P.value(shown.a, 2)],
      ["支配度（负1至1）", P.value(shown.d, 2)], ["支配来源", source(pad.dSource || data.dSource)],
      ["缺少的维度", Array.isArray(pad.missing) ? pad.missing.map(dimension).join("、") || "无" : P.missing],
      ["共享轴", P.value(union.s, 2)], ["联合激活", P.value(union.a, 2)], ["联合支配", P.value(union.d, 2)],
      ["联合门禁", gate(data.gate)], ["桥接残差", P.value(data.bridgeErr, 2)], ["变化方向", direction(data.direction)],
      ["情感侧共享读数", P.value(data.sPad, 2)], ["姿态侧共享读数", P.value(data.sIpc, 2)], ["预测读数", P.value(data.predicted, 2)],
      ["联合读面启用", P.bool(data.enabled)], ["IPC副本可用", P.bool(data.ipcAvailable)], ["当前降级", P.bool(data.degraded)]
    ], true);
    details(groups, "人际姿态与关系", [
      ["角色姿态", pair(ipc.role)], ["对方姿态", pair(ipc.other)],
      ["所在区域", P.text(ipc.region?.label)], ["区域方位", P.value(ipc.region?.angle, 1, " 度")],
      ["最近姿态词", P.text(ipc.anchor?.zh)], ["互补位置", pair(ipc.complementPoint)],
      ["对立位置", pair(ipc.antiComplementPoint)], ["关系类型", P.text(metrics?.pattern?.zh)],
      ["类型拟合度", P.value(metrics?.pattern?.fit, 2)], ["两点分离角", P.value(metrics?.separationDegrees, 1, " 度")],
      ["互补性", P.value(metrics?.quantities?.complementarity, 2)], ["互动性", P.value(metrics?.quantities?.reciprocity, 2)],
      ["一致性", P.value(metrics?.quantities?.correspondence, 2)], ["相似性", P.value(metrics?.quantities?.similarity, 2)],
      ["对立性", P.value(metrics?.quantities?.opposition, 2)],
      ["关系读数说明", P.text(ipc.metricsNote)], ["分区表条数", Array.isArray(ipc.octants) ? P.value(ipc.octants.length) : P.missing]
    ]);
    details(groups, "两把尺子的差", [
      ["主导方向残差", P.value(ipc.ipcErr?.a, 2)], ["亲近方向残差", P.value(ipc.ipcErr?.c, 2)],
      ["最大绝对残差", P.value(ipc.ipcErr?.maxAbs, 2)], ["坐标门禁", gate(ipc.errGate)],
      ["坐标可信度", P.value(ipc.gain, 2)], ["低于可信门槛", P.bool(ipc.lowConfidence)],
      ["坐标判定时间", P.date(ipc.at, "auto")]
    ]);
    const baseline = data.baseline;
    details(groups, "人格基线", [
      ["基线愉悦", P.value(baseline?.p, 2)], ["基线唤醒", P.value(baseline?.a, 2)],
      ["支配基线", "已登记未启用，不补中性点"], ["基线来源", P.text(baseline?.source)],
      ["基线更新时间", P.date(baseline?.updatedAt, "auto")], ["基线说明", P.text(baseline?.note)]
    ]);
    const hint = data.styleHint;
    details(groups, "朗读语气候选", [
      ["语气提示启用", P.bool(hint?.enabled)], ["当前提示", P.text(hint?.line)],
      ["候选编号", Array.isArray(hint?.candidates) ? hint.candidates.map(n => P.value(n)).join("、") || "无" : P.missing],
      ["不优先编号", Array.isArray(hint?.avoid) ? hint.avoid.map(n => P.value(n)).join("、") || "无" : P.missing],
      ["强度变化", ({ pos: "增强", neg: "减弱", zero: "未变化", unknown: "缺少读数" })[hint?.delta] || P.missing],
      ["唤醒档", ({ high: "较高", mid: "中等", medium: "中等", normal: "正常", low: "较低" })[hint?.arousalBand] || P.missing],
      ["心情方向", ({ positive: "偏愉悦", negative: "偏消沉", zero: "中性", flat: "持平", pos: "偏愉悦", neg: "偏消沉" })[hint?.valenceSign] || P.missing],
      ["共享轴可引用", P.bool(hint?.sTrusted)], ["候选门禁", gate(hint?.gate)],
      ["候选来源", hint?.source === "recomputed" ? "按当前参数重算，并非历史注入原文" : P.missing],
      ["候选对应时间", P.date(hint?.at, "auto")]
    ]);
    root.append(groups);
  }
  function history(root, data, names) {
    const box = P.el("details", "dp-space-info"); box.append(P.el("summary", "", "逐轮变化记录"));
    P.note(box, "以下为本次最多40条的审计窗口，按旧到新排列；门禁使用当前参数重算，不等于当时的判定。");
    if (!data.history.length) P.note(box, "当前窗口还没有可用变化记录。");
    for (const row of data.history) {
      const shown = historyPoint(row).raw;
      const item = P.el("details", "dp-memory-row"); item.append(P.el("summary", "", P.date(row.at, true) + " · 强度 " + P.value(row.moodIntensity, 1)));
      P.pairs(item, [
        ["来源会话", names.marker(row.sessionId), "node"],
        ["情绪", P.text(row.userEmotion)], ["愉悦", P.value(shown.p, 2)], ["唤醒", P.value(shown.a, 2)],
        ["支配", P.value(shown.d, 2)], ["支配来源", source(row.dSource)],
        ["共享轴", P.value(row.union?.s, 2)], ["情感侧共享", P.value(row.sPad, 2)], ["姿态侧共享", P.value(row.sIpc, 2)],
        ["桥接残差", P.value(row.bridgeErr, 2)], ["门禁（重算）", gate(row.gate)], ["方向", direction(row.direction)],
        ["角色主导", P.value(row.ipc?.a, 2)], ["角色亲近", P.value(row.ipc?.c, 2)], ["降级", P.bool(row.degraded)]
      ]); box.append(item);
    }
    root.append(box);
  }
  function scene(root, data) {
    const G = globalThis.EchoViews?.["emotion-space"];
    if (!G?.toScreen || !G?.project || !G?.world) {
      P.note(root, "可视化组件暂不可用，以下坐标与变化记录仍可查看。");
      return { start() {}, stop() {} };
    }
    const shell = P.el("div", "es42"), wrap = P.el("div", "es42-plots");
    const diskHost = P.el("figure", "es42-plot"), cubeHost = P.el("figure", "es42-plot");
    const disk = P.el("canvas"), cube = P.el("canvas");
    disk.setAttribute("role", "img"); disk.setAttribute("aria-label", "角色、对方及历史姿态的人际圆盘；数值见下方人际姿态");
    cube.tabIndex = 0; cube.setAttribute("role", "img"); cube.setAttribute("aria-label", "情感三维坐标，拖动或方向键旋转，Home重置视角；数值见下方情感与共享轴");
    const heading = (host, title, range) => {
      const row = P.el("figcaption", "es42-title"); row.append(P.el("h3", "", title), P.el("span", "", range)); host.append(row);
    };
    heading(diskHost, "人际圆盘", "主导 / 亲近 · 0 至 1");
    heading(cubeHost, "情感坐标", "P / A / D · 负1 至 1");
    const legend = P.el("div", "es42-key");
    for (const [key, label] of [["role", "角色"], ["other", "对方"], ["reference", "互补参照"], ["trail", "历史方向"]]) {
      const item = P.el("span", "es42-key-" + key); item.append(P.el("i"), document.createTextNode(label)); legend.append(item);
    }
    root.append(shell); shell.append(legend, wrap); wrap.append(diskHost, cubeHost);
    diskHost.append(disk); cubeHost.append(cube);
    const camera = { iso: [-0.64, 0.36], front: [0, 0], side: [-Math.PI / 2, 0], top: [0, Math.PI / 2] };
    let active = false, observer = null, frame = 0, spin = false, drag = null, yaw = camera.iso[0], pitch = camera.iso[1];
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const show = { history: true, other: true };
    const controls = P.el("div", "es42-options");
    for (const [key, label] of [["history", "历史轨迹"], ["other", "对方坐标"]]) {
      const input = P.el("input"); input.type = "checkbox"; input.checked = true;
      const field = P.el("label"); field.append(input, P.el("span", "", label)); controls.append(field);
      input.addEventListener("change", () => { show[key] = input.checked; render(); });
    }
    diskHost.append(controls);
    const views = P.el("div", "es42-views"); views.setAttribute("role", "group"); views.setAttribute("aria-label", "情感坐标视角");
    const viewButtons = new Map();
    function chooseView(key) {
      [yaw, pitch] = camera[key]; spin = false; cancelFrame(); syncMotion();
      for (const [name, button] of viewButtons) button.setAttribute("aria-pressed", String(name === key));
      render();
    }
    for (const [key, title] of [["iso", "立体"], ["front", "正面"], ["side", "侧面"], ["top", "俯视"]]) {
      const button = P.button(title, () => chooseView(key));
      button.setAttribute("aria-pressed", String(key === "iso")); viewButtons.set(key, button); views.append(button);
    }
    const reset = P.button("重置视角", () => chooseView("iso"));
    const motion = P.button("自动旋转", () => {
      if (reduced.matches) return;
      spin = !spin; syncMotion(); if (spin) tick(); else cancelFrame();
    });
    function syncMotion() {
      motion.textContent = spin ? "停止旋转" : "自动旋转";
      motion.disabled = reduced.matches; motion.setAttribute("aria-pressed", String(spin));
      motion.title = reduced.matches ? "系统已启用减少动态效果" : "围绕情感坐标旋转视角";
    }
    const cubeControls = P.el("div", "es42-options"); cubeControls.append(reset, motion);
    const gesture = P.el("p", "es42-gesture", "拖动 / 方向键旋转 · Home 重置");
    cubeHost.append(views, cubeControls, gesture); syncMotion();
    const role = ipcPoint(data.ipc?.role, [data.missing, data.pad?.missing, data.ipc?.missing].filter(Array.isArray).flat());
    const other = ipcPoint(data.ipc?.other);
    const complement = role ? ipcPoint(data.ipc?.complementPoint) : null;
    const historyIpc = trajectorySegments(data.history, row => Array.isArray(row.missing) ? ipcPoint(row.ipc, row.missing) : null);
    const historyUnit = trajectorySegments(data.history, row => { const point = historyPoint(row); return point.complete ? point.unit : null; });
    const point = padPoint(data.pad, data.missing);
    const count = segments => segments.reduce((n, segment) => n + segment.length, 0);
    const windowLabel = P.el("p", "es42-window", "历史窗口 " + data.history.length + " 条 · 人际 " + count(historyIpc)
      + " 点 · 三维 " + count(historyUnit) + " 点");
    shell.append(windowLabel);
    function context(canvas) {
      const rect = canvas.getBoundingClientRect();
      if (!active || !canvas.isConnected || rect.width <= 0) return null;
      const width = rect.width, height = rect.height, ratio = devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      const g = canvas.getContext("2d"); if (!g) return null;
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      const style = getComputedStyle(canvas);
      return { g, width, height, ink: style.getPropertyValue("--text").trim(), muted: style.getPropertyValue("--muted").trim(),
        accent: style.getPropertyValue("--accent").trim(), rule: style.getPropertyValue("--border").trim(),
        surface: style.getPropertyValue("--surface").trim(), ground: style.getPropertyValue("--ground").trim(),
        grid: style.getPropertyValue("--control").trim(), font: style.fontFamily, reserved: [] };
    }
    function line(g, points, color, width = 1, dash = []) {
      if (points.length < 2) return;
      g.beginPath(); points.forEach((p, i) => { if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); });
      g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash); g.stroke(); g.setLineDash([]);
    }
    function arrow(g, from, to, color, size = 6) {
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      if (Math.hypot(to.x - from.x, to.y - from.y) < size * 2) return;
      const p = { x: from.x + (to.x - from.x) * 0.68, y: from.y + (to.y - from.y) * 0.68 };
      g.beginPath(); g.moveTo(p.x, p.y);
      g.lineTo(p.x - Math.cos(angle - 0.5) * size, p.y - Math.sin(angle - 0.5) * size);
      g.moveTo(p.x, p.y); g.lineTo(p.x - Math.cos(angle + 0.5) * size, p.y - Math.sin(angle + 0.5) * size);
      g.strokeStyle = color; g.lineWidth = 1.8; g.stroke();
    }
    function mark(ctx, p, type, color, size = 6) {
      const g = ctx.g; g.beginPath();
      if (type === "other") {
        g.moveTo(p.x, p.y - size); g.lineTo(p.x + size, p.y); g.lineTo(p.x, p.y + size); g.lineTo(p.x - size, p.y); g.closePath();
      } else if (type === "reference") g.rect(p.x - size, p.y - size, size * 2, size * 2);
      else g.arc(p.x, p.y, size, 0, Math.PI * 2);
      g.fillStyle = type === "reference" ? ctx.ground : color; g.strokeStyle = type === "reference" ? color : ctx.ground;
      g.lineWidth = 2; g.fill(); g.stroke();
      if (type === "role") { g.beginPath(); g.arc(p.x, p.y, size + 3, 0, Math.PI * 2); g.strokeStyle = color; g.lineWidth = 1.5; g.stroke(); }
    }
    function text(ctx, value, p, color = ctx.muted, size = 12, weight = 400) {
      const g = ctx.g; g.font = weight + " " + size + "px " + ctx.font; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillStyle = color; g.fillText(value, p.x, p.y);
      const rect = { x: p.x - g.measureText(value).width / 2 - 3, y: p.y - size / 2 - 3, w: g.measureText(value).width + 6, h: size + 6 };
      ctx.reserved.push(rect); return rect;
    }
    const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
      * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    // Labels move; measurements never do. Score all candidates before painting.
    function label(ctx, lines, anchor, color, preferred = null, compact = false) {
      const { g, width, height } = ctx, size = compact ? 12 : 13, leading = compact ? 17 : 19;
      g.font = "500 " + size + "px " + ctx.font;
      const w = Math.min(width - 16, Math.max(...lines.map(value => g.measureText(value).width)) + 16), h = lines.length * leading + 10;
      const offsets = preferred ? [preferred] : [];
      offsets.push([16, -h - 10], [16, 12], [-w - 16, -h - 10], [-w - 16, 12],
        [-w / 2, -h - 19], [-w / 2, 20], [26, -h / 2], [-w - 26, -h / 2]);
      const candidates = offsets.map(([dx, dy]) => ({ x: Math.max(8, Math.min(width - w - 8, anchor.x + dx)),
        y: Math.max(8, Math.min(height - h - 8, anchor.y + dy)), w, h }));
      const collision = rect => ctx.reserved.reduce((n, item) => n + overlap(rect, item), 0);
      const score = rect => collision(rect) * 100
        + Math.hypot(rect.x + w / 2 - anchor.x, rect.y + h / 2 - anchor.y);
      // Crowded extrema may need the outer gutter rather than another nearby box.
      // Search the full plot before accepting any collision with an earlier label.
      if (candidates.every(rect => collision(rect) > 0)) {
        for (let y = 8; y <= height - h - 8; y += 16) {
          for (const x of [8, (width - w) / 2, width - w - 8]) candidates.push({ x, y, w, h });
        }
      }
      candidates.sort((a, b) => score(a) - score(b)); const box = candidates[0];
      const foot = { x: Math.max(box.x, Math.min(box.x + w, anchor.x)), y: Math.max(box.y, Math.min(box.y + h, anchor.y)) };
      line(g, [anchor, foot], color, 1);
      g.fillStyle = ctx.ground; g.fillRect(box.x, box.y, w, h);
      g.textAlign = "left"; g.textBaseline = "middle";
      lines.forEach((value, i) => { g.font = (i === 0 ? "600 " : "400 ") + size + "px " + ctx.font;
        g.fillStyle = i === 0 ? color : ctx.muted; g.fillText(value, box.x + 8, box.y + 5 + leading * (i + 0.5)); });
      ctx.reserved.push(box);
    }
    function trails(ctx, segments, project) {
      for (const segment of segments) {
        const points = segment.map(project);
        line(ctx.g, points, ctx.accent, 1.8);
        for (let i = 1; i < points.length; i++) arrow(ctx.g, points[i - 1], points[i], ctx.accent);
        for (const p of points) mark(ctx, p, "trail", ctx.accent, 2.4);
      }
    }
    function drawDisk(ctx) {
      const { g, width, height } = ctx;
      const view = { cx: width / 2, cy: height / 2, r: Math.max(1, Math.min((width - 100) / 2, (height - 120) / 2, 178)) };
      const origin = { x: view.cx, y: view.cy };
      const supplied = Array.isArray(data.ipc?.octants) ? data.ipc.octants.filter(item => P.number(item.angle) !== null && typeof item.zh === "string") : [];
      for (let angle = 0; angle < 360; angle += 45) {
        const start = -(angle + 22.5) * Math.PI / 180, end = -(angle - 22.5) * Math.PI / 180;
        g.beginPath(); g.moveTo(view.cx, view.cy); g.arc(view.cx, view.cy, view.r, start, end); g.closePath();
        g.fillStyle = angle % 90 === 0 ? ctx.surface : ctx.ground; g.fill();
        line(g, [origin, G.polarToScreen(angle + 22.5, 1, view)], ctx.rule);
      }
      for (const ratio of [0.25, 0.5, 0.75, 1]) {
        g.beginPath(); g.arc(view.cx, view.cy, view.r * ratio, 0, Math.PI * 2);
        g.strokeStyle = ratio === 1 ? ctx.grid : ctx.rule; g.lineWidth = ratio === 1 ? 1.5 : 1; g.stroke();
      }
      line(g, [G.polarToScreen(180, 1, view), G.polarToScreen(0, 1, view)], ctx.grid);
      line(g, [G.polarToScreen(270, 1, view), G.polarToScreen(90, 1, view)], ctx.grid);
      for (const [angle, title] of [[90, "主导"], [270, "退让"], [0, "亲近"], [180, "疏远"]]) {
        const p = G.polarToScreen(angle, 1, view), dx = Math.cos(angle * Math.PI / 180), dy = -Math.sin(angle * Math.PI / 180);
        text(ctx, title, { x: p.x + dx * 26, y: p.y + dy * 24 }, ctx.ink, 14, 600);
      }
      const fallback = ["亲近", "主导·亲近", "主导", "主导·疏远", "疏远", "退让·疏远", "退让", "退让·亲近"];
      const sectors = supplied.length ? supplied : fallback.map((zh, index) => ({ zh, angle: index * 45 }));
      for (const sector of sectors) {
        // A missing lexicon uses axis combinations, never guessed personality words.
        const p = G.polarToScreen(sector.angle, 0.76, view);
        const parts = sector.zh.split("·");
        parts.forEach((part, i) => text(ctx, P.text(part), { x: p.x, y: p.y + (i - (parts.length - 1) / 2) * 15 }, ctx.muted, 12));
      }
      for (const n of [0, 0.25, 0.5, 0.75, 1]) {
        const p = G.toScreen({ a: 0.5, c: n }, view);
        line(g, [{ x: p.x, y: p.y - 3 }, { x: p.x, y: p.y + 3 }], ctx.muted);
        text(ctx, String(n), { x: p.x, y: p.y + 14 });
        if (n !== 0.5) {
          const a = G.toScreen({ a: n, c: 0.5 }, view);
          line(g, [{ x: a.x - 3, y: a.y }, { x: a.x + 3, y: a.y }], ctx.muted);
          text(ctx, String(n), { x: a.x - 17, y: a.y });
        }
      }
      if (show.history) trails(ctx, historyIpc, point => G.toScreen(point, view));
      const objects = [];
      if (complement) objects.push({ raw: complement, type: "reference", title: "互补参照", color: ctx.muted });
      if (role) objects.push({ raw: role, type: "role", title: "角色", color: ctx.accent });
      if (show.other && other) objects.push({ raw: other, type: "other", title: "对方", color: ctx.ink });
      // Reserve every true point before placing labels, including coincident ones.
      objects.forEach(item => {
        item.p = G.toScreen(item.raw, view);
        ctx.reserved.push({ x: item.p.x - 12, y: item.p.y - 12, w: 24, h: 24 });
      });
      objects.forEach(item => {
        const small = width < 360 && item.type !== "reference";
        const value = item.type === "reference" ? [] : ["主导 " + P.value(item.raw.a, 2) + " · 亲近 " + P.value(item.raw.c, 2)];
        const lines = small ? [item.title + " " + P.value(item.raw.a, 2) + " / " + P.value(item.raw.c, 2)] : [item.title, ...value];
        label(ctx, lines, item.p, item.color);
      });
      // Concentric marks keep all three identities visible at the same coordinate.
      objects.forEach(item => mark(ctx, item.p, item.type, item.color, item.type === "reference" ? 12 : item.type === "role" ? 7 : 5));
      if (!role) text(ctx, "角色坐标缺值", { x: width / 2, y: 20 }, ctx.muted, 13);
      if (show.other && !other) text(ctx, "对方 " + P.missing, { x: width / 2, y: height - 18 }, ctx.muted, 13);
    }
    function drawCube(ctx) {
      const { g, width, height } = ctx;
      // Fit the unchanged public perspective geometry, allowing gutters for labels.
      const basis = G.CORNERS.map(p => G.project(G.rotate(p, yaw, pitch), { cx: 0, cy: 0, scale: 1 }));
      const minX = Math.min(...basis.map(p => p.x)), maxX = Math.max(...basis.map(p => p.x));
      const minY = Math.min(...basis.map(p => p.y)), maxY = Math.max(...basis.map(p => p.y));
      const scale = Math.min((width - 98) / (maxX - minX), (height - 138) / (maxY - minY));
      const view = { cx: width / 2 - (minX + maxX) * scale / 2, cy: height / 2 - (minY + maxY) * scale / 2, scale };
      const project = p => G.project(G.rotate(p, yaw, pitch), view), origin = project({ x: 0, y: 0, z: 0 });
      // The floor is A=-1; the central reference plane is D=0.
      const planes = [
        [{ x: -1, y: -1, z: -1 }, { x: 1, y: -1, z: -1 }, { x: 1, y: -1, z: 1 }, { x: -1, y: -1, z: 1 }],
        [{ x: -1, y: -1, z: 0 }, { x: 1, y: -1, z: 0 }, { x: 1, y: 1, z: 0 }, { x: -1, y: 1, z: 0 }]
      ];
      planes.sort((a, b) => a.reduce((n, p) => n + project(p).depth, 0) - b.reduce((n, p) => n + project(p).depth, 0));
      for (const plane of planes) {
        const corners = plane.map(project); g.beginPath(); corners.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath();
        g.globalAlpha = 0.76; g.fillStyle = ctx.surface; g.fill(); g.globalAlpha = 1;
        line(g, [...corners, corners[0]], ctx.rule);
      }
      for (const t of [-0.5, 0, 0.5]) {
        line(g, [project({ x: t, y: -1, z: -1 }), project({ x: t, y: -1, z: 1 })], ctx.rule);
        line(g, [project({ x: -1, y: -1, z: t }), project({ x: 1, y: -1, z: t })], ctx.rule);
      }
      const edges = [];
      for (let i = 0; i < G.CORNERS.length; i++) for (let j = i + 1; j < G.CORNERS.length; j++) {
        if (["x", "y", "z"].filter(key => G.CORNERS[i][key] !== G.CORNERS[j][key]).length === 1) {
          const a = project(G.CORNERS[i]), b = project(G.CORNERS[j]); edges.push({ a, b, depth: (a.depth + b.depth) / 2 });
        }
      }
      edges.sort((a, b) => a.depth - b.depth);
      edges.forEach(edge => line(g, [edge.a, edge.b], edge.depth < 0 ? ctx.rule : ctx.grid, edge.depth < 0 ? 1 : 1.4, edge.depth < 0 ? [4, 4] : []));
      const axes = [
        { key: "x", code: "P", negative: "不愉悦", positive: "愉悦" },
        { key: "y", code: "A", negative: "平静", positive: "激动" },
        { key: "z", code: "D", negative: "退让", positive: "主导" }
      ];
      const labels = [];
      for (const axis of axes) {
        const endpoint = value => project({ x: 0, y: 0, z: 0, [axis.key]: value });
        const neg = endpoint(-1), pos = endpoint(1), collapsed = Math.hypot(pos.x - neg.x, pos.y - neg.y) < 16;
        line(g, [endpoint(-1.12), endpoint(1.12)], ctx.muted, 1.4);
        if (collapsed) {
          g.beginPath(); g.arc(origin.x, origin.y, 6, 0, Math.PI * 2); g.strokeStyle = ctx.muted; g.lineWidth = 1; g.stroke();
          labels.push({ title: axis.code + " +1 " + axis.positive, p: pos, preferred: [22, 26] });
          labels.push({ title: axis.code + " -1 " + axis.negative, p: neg, preferred: [-106, 52] });
        } else {
          const dx = pos.x - neg.x, dy = pos.y - neg.y, length = Math.hypot(dx, dy), nx = -dy / length, ny = dx / length;
          for (const n of [-1, -0.5, 0.5, 1]) {
            const p = endpoint(n);
            line(g, [{ x: p.x - nx * 3, y: p.y - ny * 3 }, { x: p.x + nx * 3, y: p.y + ny * 3 }], ctx.muted);
            if (width > 360 && Math.abs(n) === 0.5) text(ctx, String(n), { x: p.x + nx * 13, y: p.y + ny * 13 });
          }
          labels.push({ title: axis.code + " -1 " + axis.negative, p: endpoint(-1.12) });
          labels.push({ title: axis.code + " +1 " + axis.positive, p: endpoint(1.12) });
        }
      }
      if (show.history) trails(ctx, historyUnit, unit => project(G.world(unit)));
      mark(ctx, origin, "origin", ctx.muted, 2.5);
      text(ctx, "0", { x: origin.x - 12, y: origin.y - 12 });
      let current = null;
      if (point.complete) {
        const world = G.world(point.unit); current = project(world);
        const floor = project({ ...world, y: -1 }), neutral = project({ ...world, z: 0 });
        line(g, [current, floor], ctx.accent, 1.3, [4, 4]);
        line(g, [current, neutral], ctx.muted, 1, [3, 4]);
        mark(ctx, floor, "reference", ctx.accent, 3.5); mark(ctx, neutral, "reference", ctx.muted, 3);
        ctx.reserved.push({ x: current.x - 13, y: current.y - 13, w: 26, h: 26 });
      }
      for (const item of labels) label(ctx, [item.title], item.p, ctx.ink, item.preferred, true);
      if (current) {
        const signed = n => (n > 0 ? "+" : "") + P.value(n, 2);
        label(ctx, ["当前", "P " + signed(point.raw.p) + " · A " + signed(point.raw.a) + " · D " + signed(point.raw.d)], current, ctx.accent);
        mark(ctx, current, "role", ctx.accent, 7);
      } else text(ctx, "当前坐标缺维 · 未绘制当前点", { x: width / 2, y: 20 }, ctx.muted, 13);
    }
    function render() {
      if (!active) return;
      const d = context(disk), c = context(cube);
      if (d) drawDisk(d); if (c) drawCube(c);
    }
    function cancelFrame() { if (frame) cancelAnimationFrame(frame); frame = 0; }
    function tick() {
      if (frame || !spin || !active || reduced.matches || document.hidden) return;
      frame = requestAnimationFrame(() => { frame = 0; if (active && spin) { if (!drag) yaw += 0.0035; render(); tick(); } });
    }
    const clearPreset = () => { for (const button of viewButtons.values()) button.setAttribute("aria-pressed", "false"); };
    cube.addEventListener("pointerdown", event => {
      if (!active || (event.button !== undefined && event.button !== 0)) return;
      clearPreset(); drag = { x: event.clientX, y: event.clientY, yaw, pitch };
      try { cube.setPointerCapture(event.pointerId); } catch {}
    });
    cube.addEventListener("pointermove", event => {
      if (!drag || !active) return; yaw = G.dragYaw(drag.yaw, event.clientX - drag.x); pitch = G.dragPitch(drag.pitch, event.clientY - drag.y); render();
    });
    const end = () => { drag = null; };
    for (const name of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) cube.addEventListener(name, end);
    cube.addEventListener("keydown", event => {
      if (!active) return;
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") { chooseView("iso"); return; }
      clearPreset();
      if (event.key === "ArrowLeft") yaw = G.dragYaw(yaw, -12);
      if (event.key === "ArrowRight") yaw = G.dragYaw(yaw, 12);
      if (event.key === "ArrowUp") pitch = G.dragPitch(pitch, -12);
      if (event.key === "ArrowDown") pitch = G.dragPitch(pitch, 12);
      render();
    });
    function motionChanged() { if (reduced.matches) { spin = false; cancelFrame(); } syncMotion(); }
    function visibilityChanged() { if (document.hidden) { drag = null; cancelFrame(); } else { render(); tick(); } }
    return {
      start() {
        if (active) { render(); return; }
        active = true; observer?.disconnect();
        if (typeof ResizeObserver === "function") { observer = new ResizeObserver(render); observer.observe(wrap); }
        reduced.addEventListener("change", motionChanged); document.addEventListener("visibilitychange", visibilityChanged);
        motionChanged(); render(); tick();
      },
      stop() {
        active = false; drag = null; cancelFrame(); observer?.disconnect(); observer = null;
        reduced.removeEventListener("change", motionChanged); document.removeEventListener("visibilitychange", visibilityChanged);
      }
    };
  }
  function build(root, data, names = new P.SessionNames()) {
    if (!P.object(data.pad) || !Array.isArray(data.history) || !data.history.every(P.object)) throw P.schemaError();
    names.prune();
    P.note(root, "模式 " + P.mode(data.mode) + " · 读数时间 " + P.date(data.at, true)
      + " · 当前参数下的只读投影");
    P.note(root, "当前空间读数的来源会话未由接口提供；不与另一条情绪快照强行配对。");
    P.note(root, typeof data.assumptions === "string" ? data.assumptions : "两套坐标系不等价、不可互推；共享轴以外的等价取法属于工程假设。");
    const visual = scene(root, data); readouts(root, data); history(root, data, names);
    return visual;
  }
  return { build, padPoint, historyPoint, ipcPoint, trajectorySegments };
})();
