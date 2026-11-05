// 审计 · 当前范围最近 500 行折成一轮一轮。这一屏只回答「她这一轮到底做了什么」。
//
// 折轮**不在这份文件里算**：归组主键是 stageDetail.turnTrace，没有它才退回「时间窗 + 桶」，
// 那一套（ATTACH_SEC=900）在产品的 web/audit-view.js:289-331 里。本屏只引用
// /echo/audit-view.js 挂在 globalThis 上的 EchoAuditView，一行都不复制 —— 两份折轮规则
// 一旦分叉，同一份审计会在两个面板上给出两个轮数。
//
// 这一屏是「窗口」，不是全量历史：共享 EchoAuditScope 请求最多 500 行，没有更早的游标，
// 所以屏上写「最近 500 行」，不写「共 N 轮」。陪伴范围在服务端先过滤，再截窗。
//
// 屏首那一个数字回答的是「哪几轮值得回去看」：需要看（慢于 30 秒或失败）的轮数，
// 口径写死在 flagOf 里、并在 note 里印出来；0 的时候不编，照实说没有。
// 一行那句「一句话」按 docs/plan-audit.md §5 的四级优先级取：她的话 › 他的话 ›
// 工具的具体动作 › 工具名人话链。只有前三层都取不到具体内容时才退回工具名。
//
// **说话人标签的判据**（三处名实不符修完后的口径，详见 HIS_TOOL_CALLS / HIS_SOURCES /
// isMarkerOnly 三处的注释）：
//   · 只有 `relay_in`（QQ 桥进来他本人那一句）与 `extract`（「他说的 / 她回的」原文）能当他说话；
//     `retrieve`（检索查询）与 `inject`（注入的旧上下文）**不算** —— 它们不是他打的字。
//   · 纯标记不算任何一方说话：剥掉前缀后只剩 `（…）` / `(...)` / `[标签]` 的行 = 没人说话。
//   · 人称还按**来源**收一道：`sub`（子代理，userInput 是上一级代理写的提示词）、`bg`、
//     `companion` 三路不写「他」，改用来源词（子代理 / 全局 / 陪伴）；只有 `qq` / `dsh` 写「他」。
//   · L1 那一句话与 L2 正文出自**同一对函数**（herSaidOf / hisSaidOf），只差压多少字。
//
// 第 2 步加的是**结构与浏览**（plan-audit.md §8 第 2 步）：
//   · 页内切片按 dayKey/hour 插组头，组头只写「N 时 · n 轮 · 最慢 x」（跨天那一页才加日期）；
//   · 一排 chips：全部 / 需要看 / 干活 / 后台 / 其它 / 提取，计数现算；主指标那个数字也点得动，
//     点它 = 点「需要看」那颗 chip（两条入口共用 pickFilter）；
//   · 展开区从「这一轮的工具」换成「这一轮」：时间跨度 / 行数 / 来源计数（只报数）/
//     他说了什么 / 她说了什么 / 阶段链 / 行清单（每行一个 button，data-row 指到该行）。
// 分页仍是 25 轮/页；「需要看」的计数与 needsDetail() 的清单保持第 1 步的实现，一行没动。
//
// **L2 详情按需渲染**（本轮）：这一屏同一时刻只允许开一条，所以详情 DOM 也跟着只在开的那一刻存在 ——
// 点开某轮才 build 那一轮，收起就整块 remove（同一页最多一份详情在 DOM 里）。
// 改前是 25 份详情全预渲染成 `hidden`（display:none），25 × 约 160 字节点 ≈ 4004 字文本节点常驻；
// 那些字进不了屏，却照样进静态文本口径（inspect 的 tiny-text 只看**直接父元素**的 display，
// 而 display 不继承 ⇒ 隐藏容器里的 <p> 自己算 block，隐藏字被算进分母，实测 0.63）。
// 顺带省 DOM：一页的元素数、文本节点数、内存都跟着 25 份详情一起降。
// ARIA 跟着这条渲染方式走（第 4 步收口）：**收起时摘掉 aria-controls**，展开时才挂上 ——
// 因为收起时那一块真的不在 DOM 里，留一个指向空气的 IDREF 是假的「受控区域」。
//
// **L3 逐行字段表**（第 3 步）：行清单里那颗按钮从「占了位、按下去说一句话」变成真的开关 ——
// 点开才建这一行的 21 键字段表（§3.1），同一时刻只开一份，收起即整块 remove（L2 同一套懒渲染）。
// 21 个键一个不少：18 个印值、agentState 印「轻量窗口下取不到」（light 下恒 null，不许写成「没有」）、
// traceId / sessionId 只列键名（值写「不上屏」）。stageDetail 拆键值对并剥掉 turnTrace；
// sayAgain / extraReply 的 null 照印 null（要与 0、空串分开）；两种截断（写入 2000 / light 600）都标注。
// 值一律走 L1/L2 同一道收口（sanitize）：盘符缩末两段、session-*/UUID 换人话、撞上原始 JSON 就截断并说明。
globalThis.EchoViews = globalThis.EchoViews || {};
globalThis.EchoViews.audit = (function () {
  "use strict";

  const LIMIT = globalThis.EchoAuditScope.LIMIT;
  const SIZE = 25; // 一页 25 轮。175 轮一次铺完是 9,645px（1440 实测），25 轮一页约 1,700px
  const SKELETON = 8;

  // needsDetail：主指标那一个数的逐条依据（每一轮一条：这轮为什么被标记、命中的是哪一行、
  // 哪个信号、值多少）。它不上屏，只由 needsDetail() 交给复核脚本 —— 屏上的数字要能被数回来。
  // filter / counts / needsIndex 是第 2 步的浏览状态：计数与筛选**同源**（都出自 load 那一次遍历），
  // 所以 chips 上的数字和筛完的列表长度不可能各说各的。
  const state = {
    page: 0, size: SIZE, total: 0, needs: 0, needsDetail: [], turns: [], rows: 0,
    open: "", filter: "all", counts: null, needsIndex: new Set(), loaded: false,
    // 「取到了行但折不出轮」：与「一行都没取到」是两种状态，屏上两句话、两个 aria-label。
    unfoldable: false,
    // 第三层展开的是「当前那一轮里的第几行」。它只在 state.open 指向的那一轮里成立，
    // 所以 L2 一换（收起 / 翻页 / 换筛 / 重读）就跟着清空 —— 见 clearOpenRow()。
    openRow: ""
  };

  let api = null;
  // 这一轮里最慢的一步（毫秒）：给时长条画端帽用。每渲染一轮前由 detailOf 重置。
  let slowestMs = 0;
  let built = false;
  let loadId = 0;
  let figureValue = null;
  let figureNote = null;
  let listHost = null;
  let pager = null;
  let chips = null;
  let scopeHost = null;
  let loadedScope = null;
  let ownershipContext = null;
  let stopOwnership = () => {};
  function bindOwnership(root, context) {
    stopOwnership();
    ownershipContext = context;
    api.ownership = context;
    scopeHost.querySelector('.ownership-note')?.remove();
    scopeHost.append(globalThis.EchoOwnershipView.note(api, context));
    stopOwnership = api.audit.subscribe(() => globalThis.EchoOwnershipView.update(root));
  }
  // 本页那份「轮 → 建详情要用的材料」：懒渲染必须先找得到这一轮。页一换就整张重填，
  // 所以它永远只描述屏上这一页（25 轮），不是整窗 175 轮。
  let pageTurns = new Map();
  // L3 的「这一行是谁」：挂在行包装元素上（WeakMap，节点没了它跟着没）。
  // 不用 dataset 的理由只有一个 —— 它要装的是数据对象，不是字符串。
  const l3Rows = new WeakMap();

  function auditView() {
    const instance = globalThis.EchoAuditView;
    if (!instance || typeof instance.buildTurns !== "function") {
      throw new Error("EchoAuditView 没有挂上");
    }
    return instance;
  }

  // 她的回复常常带一点轻 markdown、外面还裹一层平台信封（【QQ:私聊】…）。两样都剥掉再上屏：
  // 剥信封、剥 markdown 都用壳里的那一份（app.js:89-139），这里不写第二份。
  function copyOf(value) {
    return api.fmt.stripMarkdown(api.fmt.stripEnvelope(value)).replace(/\n{2,}/gu, "\n").trim();
  }

  function lastTwoSegments(path) {
    const parts = String(path || "").split(/[\\/]+/u).filter((part) => part !== "");
    return parts.slice(-2).join("/");
  }

  // 上屏前的最后一道收口（验收：屏内不许出现盘符路径、`session-`、UUID、原始 JSON）。
  //   · **盘符绝对路径**（`C:\…` / `C:/…`）缩到末两段 —— 盘符与用户名不跟着上屏（§3.1「路径缩写」）；
  //   · 内部 ID（`session-…`、UUID）换成人话，值本来就不该上屏（§1.4 第 2 条）；
  //   · 从 `{"` 起整段截掉：那是原始 JSON，不是一句话（截掉了要标，见 proseOf）。
  // 只认盘符路径：相对路径（`web/mock/final/app.css`）不藏用户名、也不带盘符，缩它只会把
  // 「产品 `web/`、`lib/`」这类话吃掉一半（实测过：`web/` 被连到下一个 token 上）。
  // 缩写不丢事实：末两段足以认出是哪个文件，全文在第三层的字段表里。
  function sanitize(text, keepLines) {
    let out = String(text ?? "");
    let truncated = false;
    const brace = out.indexOf('{"');
    if (brace >= 0) {
      out = out.slice(0, brace);
      truncated = true;
    }
    out = out.replace(/[A-Za-z]:[\\/][^\s"'`<>|,;，。；、：()（）「」《》\]]*/gu,
      (match) => lastTwoSegments(match.replace(/^[A-Za-z]:/u, "")));
    out = out.replace(/session-[A-Za-z0-9_-]*/gu, "会话");
    out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, "…");
    // 一句话那一格压成一行；L2 的正文留着换行 —— 他写的是带小标题的几段话，压平就不好读了。
    out = keepLines
      ? out.replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim()
      : out.replace(/\s+/gu, " ").trim();
    return { text: out, truncated };
  }

  function safeOf(text) {
    return sanitize(text, false).text;
  }

  // L2 的正文（他说了什么 / 她说了什么）：同一道收口，但保留段落与全部字数。
  // 入参是**已经清过的话**（speechOf / hisSpeechOf 的返回值：信封、markdown、标记都剥过了），
  // 所以这里不再跑一遍 copyOf —— 两遍剥出来的是两段字，L1 与 L2 就对不上了。
  // 真的撞上原始 JSON 时截断并**说出来**——静默截断会把「他后面还说了半段」这件事藏起来。
  function proseOf(text) {
    const clean = sanitize(text, true);
    return clean.truncated ? `${clean.text} …（这一段是原始字段，不上屏）` : clean.text;
  }

  function clip(text, max) {
    const line = safeOf(text);
    return line.length > max ? `${line.slice(0, max)}…` : line;
  }

  // EchoAuditView.toolHuman 认不出的工具名，面板上就会露出裸英文（实测这个窗口里四十来轮的
  // 首行是 `retrieve` / `emotion_decay` / `session-reaper` 这类，摘要读起来像日志）。
  // 这张表**只补它不认的**，一个词都不自己造：
  //   · 管线那几个（检索 / 情绪打分 / 查询扩展 / 人际打分 / 情绪衰减 / 图谱检索 / 提醒 / 入站被拒）
  //     逐字抄产品自己的说法，web/audit-cards.html:303-313；
  //   · `session-reaper` → 会话清理，取自 audit-view.js:76-78 的注释（它自己就这么叫）；
  //   · `read_image` / `skill` 是 DSH 的工具，按 AV 给同类工具定的命名法（read→读文件、
  //     grep→搜内容）叫「看图」「读技能」，没有第二处来源；这两条按 AV 命名法推测，行尾已标。
  // AV 认得的名字一律用 AV 的，这张表碰不到那种情况。
  const HUMAN_FALLBACK = {
    retrieve: "检索", graph_query: "图谱检索", same_turn_emotion: "情绪打分",
    query_expand: "查询扩展", "ipc-appraise": "人际打分", emotion_decay: "情绪衰减",
    "session-reaper": "会话清理", remind: "提醒", relay_reject: "入站被拒",
    read_image: "看图", // 推测：按 AV 命名法补，未经产品文案确认
    skill: "读技能" // 推测：按 AV 命名法补，未经产品文案确认
  };

  function humanOf(tool) {
    const human = auditView().toolHuman(tool);
    return human === tool ? HUMAN_FALLBACK[tool] || human : human;
  }

  // 「她对他开口说过的话」只有这几种行 —— 白名单逐字抄 lib/proactive-ack.js:64-66，不自己加一个。
  // 为什么是白名单而不是「llmReply 非空就是她的话」：活库实测 relay_out / relay_proactive /
  // echo_qq_say 三种行的 llm_reply **全是空**（58/50/9 行，0 行有值），正文在 user_input 里，
  // 带 `[标签] ` 或 `(用 QQ 说)` 前缀；care 反过来，正文在 llm_reply。
  // 而别的行的 llmReply 是工具的返回值（实测 read 给 `<path>C:\…</path>`）或机器台账
  // （session-reaper 给 `manifest=C:\…`）—— 印上来既不是她的话，也把绝对路径带上屏。
  const SPEAKING_TOOL_CALLS = ["relay_out", "relay_proactive", "echo_qq_say", "echo_wake", "care"];
  // 「他的话」**只有这两个工具能当**：relay_in 是 QQ 桥进来的他本人那一句；extract 记的是
  // 这一轮的「他说的 / 她回的」原文。
  // `retrieve` / `inject` **不算**，它们的 userInput 不是他打的字：retrieve 的 userInput 是
  // **检索查询**（子代理会话里更是上一级代理写给它的提示词），inject（stage=assemble）的
  // userInput 是被注入的**旧上下文**（他自己的记忆、她的旧话）。
  // 活库这一窗（2026-10-25 15:4x）26 轮里没有一轮是他打的字：22 轮是父代理写给子代理的提示词
  // （retrieve/inject，来源 sub）、2 轮是她自己的旧话（来源 dsh）、2 轮只有 `（她主动开口）`；
  // 其中 25 轮原样印成「他：」。plan-audit.md §7 弃第 6 条，弃的就是「不分工具拿 userInput 当他说的」。
  const HIS_TOOL_CALLS = ["relay_in", "extract"];
  // 谁说的也由**来源**判，不由文本猜：`qq`（桥进来的那句，裁定 A 之后仍记在 QQ 名下）与
  // `dsh`（他自己开着的那条窗口）记的是他本人打的字；其余来源记的都不是他 ——
  //   `sub`：她派出去的子代理（裸 uuid 会话），userInput 是**上一级代理写给它的提示词**；
  //   `companion`：她自己的陪伴会话；`bg`：没有会话的记账行。
  // 于是「他」这个标签只在这两路出现，别处一律用来源词（子代理 / 全局 / 陪伴），
  // 屏上就不会再出现「父代理的提示词被标成他」。来源词取自 view.SOURCES，这里不另造一套。
  const HIS_SOURCES = ["qq", "dsh"];
  // 她那一路不分来源：白名单里五个工具（出站 / 主动 / 喊他 / 闹钟 / 关怀）都只可能是她在说。
  const HER_LABEL = "她";
  // 拿路径当动作的那几族（§5 ③：取末两段）。
  const PATH_TOOLS = ["read", "edit", "write", "read_image", "grep"];
  // 这几个键装的是正文或代码，不是「这一轮干了什么」，不能拿来当一句话。
  const BODY_KEYS = ["content", "new_string", "old_string", "command", "todos"];
  // 「慢」的阈值（毫秒）。写死成一个常量，屏首 note 里印出来 —— 数据一换这个数就该重新定。
  const SLOW_MS = 30000;

  // 一排 chips（§4）：时间序是主轴，这一排只回答「看哪一类」。
  // 四颗分区（干活 / 后台 / 提取 / 其它）把整窗的轮**不重不漏**地分完，所以它们的和 = 轮数；
  // 「需要看」不在这套分区里 —— 它与别的分类**重叠**（本窗口的慢轮多半就是干活轮），
  // 所以加上它就不等于轮数。屏上那个数（主指标）与这颗 chip 是同一个数。
  const FILTERS = [
    { key: "all", label: "全部" },
    { key: "needs", label: "需要看" },
    { key: "work", label: "干活" },
    { key: "machine", label: "后台" },
    { key: "other", label: "其它" },
    { key: "reflect", label: "提取" }
  ];
  const PARTITION = ["work", "machine", "reflect", "other"];
  // 筛完是空的时候要说清是哪一类空，不能只说「没有记录」——那是端点的空，不是筛选的空。
  const EMPTY_FILTER = {
    needs: "这窗口里没有需要看的轮。",
    work: "这窗口里没有干活轮。",
    machine: "这窗口里没有后台轮。",
    reflect: "这窗口里没有提取轮。",
    other: "这窗口里没有其它轮。"
  };
  // 来源的固定顺序（view.SOURCES 的键序）。L2 里只报「哪一路几行」，不报会话 ID。
  const SOURCE_ORDER = ["qq", "dsh", "companion", "sub", "bg"];

  // lib/proactive-ack.js:69-74 的注记剥离：`[QQ:私聊] 正文` / `(用 QQ 说)正文`。
  // ★ 括号只在**短**的时候才当标记剥：`(用 QQ 说)` 6 字、`(她主动开口)` 5 字；
  //   而她常把整句话写在括号里（`（面应该到了吧，他没说，我也不追问。就先安静着。）`），
  //   一刀切会把正文整段剥空 —— 那正是「她说的话在页面上看不见」的直接原因。
  function stripMarkerOf(value) {
    return String(value ?? "")
      .replace(/^\[[^\]]*\]\s*/u, "")
      .replace(/^[（(]([^）)]*)[）)]\s*/u, (match, inner) => (String(inner).length <= 12 ? "" : match))
      .trim();
  }

  // 纯标记不算**任何一方**说话。`（她主动开口）` / `(用 QQ 说)` / `[QQ:私聊]` 是系统写下的
  // 标记，剥完只剩空壳；这种行一旦上屏就成了「他：（她主动开口）」—— 括号里没有一句是他的话。
  // 判据：把整段里的 `[…]` 与 `（…）` 全部抹掉（不限行首：标记也会跟在正文后面），
  // 抹完连空白都不剩 ⇒ 没说话。只用来判空，不改显示文本（显示仍走 stripMarkerOf，只剥行首）。
  //
  // ★ 长度护栏：**整句都被一对括号包住的不一定是标记**。实测 `relay_proactive` 的正文常常就是
  //   「（面应该到了吧，他没说，我也不追问。就先安静着。）」—— 那是她真写的一句话，不是
  //   `(她主动开口)` / `(想念主动关怀)` 那种括注。所以抹空之后再看括号里的字数：
  //   **≤ 12 字才算标记**。这条线是量出来的（全库说话行里"全括号"的只有 15 行：
  //   care 的 `想念主动关怀` 恒 6 字，relay_proactive 的正文是 15–34 字，中间没有样本）。
  //   不设这条，"她说的"整块会因为她习惯把话写在括号里而整轮空白（用户在页面上看到的就是"没回复"）。
  function isMarkerOnly(text) {
    const raw = String(text ?? "").trim();
    const bare = raw
      .replace(/\[[^\]]*\]/gu, "")
      .replace(/[（(][^）)]*[）)]/gu, "")
      .replace(/\s+/gu, "");
    if (bare !== "") return false;
    const inner = raw.replace(/\[[^\]]*\]/gu, "").replace(/[（(）)\s]/gu, "");
    return inner.length <= 12;
  }

  // 被写入侧 2000 字截断的行（lib/index.js:3216）JSON 尾部已经没了，整体 JSON.parse 会失败，
  // 这时按字段名把那一个值抓出来 —— 只抓这几个固定键，不猜结构。
  function unescapeJson(text) {
    return String(text)
      .replace(/\\u([0-9a-fA-F]{4})/gu, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\n/gu, " ")
      .replace(/\\t/gu, " ")
      .replace(/\\"/gu, '"')
      .replace(/\\\\/gu, "\\");
  }

  function argOf(row, key) {
    const text = String(row?.userInput ?? "");
    const parsed = auditView().payloadJson(text);
    if (parsed && typeof parsed === "object" && typeof parsed[key] === "string" && parsed[key].trim() !== "") {
      return parsed[key];
    }
    const found = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "u"));
    return found ? unescapeJson(found[1]) : "";
  }

  // 「其余取首个参数」：参数表里第一个非空的字符串，跳开正文/代码那几个键。
  function firstArgOf(row) {
    const parsed = auditView().payloadJson(String(row?.userInput ?? ""));
    if (!parsed || typeof parsed !== "object") return "";
    for (const key of Object.keys(parsed)) {
      if (BODY_KEYS.indexOf(key) >= 0) continue;
      const value = parsed[key];
      if (typeof value !== "string" || value.trim() === "") continue;
      return value;
    }
    return "";
  }

  // §5 ③ 工具的具体动作：没有具体内容时才返回空串，让调用方退回上一层。
  function actionOf(row) {
    const tool = String(row?.toolCall || "").trim();
    if (tool === "") return "";
    if (tool === "pwsh") return argOf(row, "description"); // 实测 43/61 行有
    if (PATH_TOOLS.indexOf(tool) >= 0) {
      const path = argOf(row, "file_path") || argOf(row, "path");
      return path === "" ? "" : lastTwoSegments(path);
    }
    if (tool === "send_message") return String(argOf(row, "message")).split(/[。！？!?\n]/u)[0];
    if (tool === "skill") return argOf(row, "name");
    return firstArgOf(row);
  }

  // 一行是不是「她说的」，说了什么（全文，不压）。不在白名单里的行一律不算 —— 不是她的话，别替她认。
  // 规则照 lib/proactive-ack.js:64-91：llmReply 优先，否则 userInput 剥标记；剥完只剩括注 ⇒ 没说话。
  function speechOf(row) {
    const tool = String(row?.toolCall || "").trim();
    if (SPEAKING_TOOL_CALLS.indexOf(tool) < 0) return "";
    const reply = copyOf(row?.llmReply);
    const text = reply !== "" ? reply : copyOf(stripMarkerOf(row?.userInput));
    return isMarkerOnly(text) ? "" : text;
  }

  // 一行是不是「他说的」，说了什么（全文，不压）。跟她那一路同一套壳（copyOf + 剥标记 + 纯标记不算），
  // 判据只有白名单不同 —— 这个函数是「他说的」**唯一**的取文本处，L1 与 L2 都从它出。
  function hisSpeechOf(row) {
    const tool = String(row?.toolCall || "").trim();
    if (HIS_TOOL_CALLS.indexOf(tool) < 0) return "";
    const text = stripMarkerOf(copyOf(row?.userInput));
    return isMarkerOnly(text) ? "" : text;
  }

  // 这一行该用哪个来源词：他本人那两路写「他」，其余写来源自己的名字（子代理 / 全局 / 陪伴）。
  function hisLabelOf(row) {
    const view = auditView();
    const source = view.rowSource(row);
    if (HIS_SOURCES.indexOf(source) >= 0) return "他";
    return (view.SOURCES[source] || {}).label || "他";
  }

  // 这一轮某一方说了什么：取**第一个说得出话的行**。一轮里可能有两行都算，
  // 第一行只有标记、正文在第二行（实测 care 的 userInput 是 `(想念主动关怀)`、llmReply 空），
  // 拿第一行就取不到话。返回 { text, label }；text === "" ⇒ 这一方这一轮没说话。
  function saidOf(turn, tools, textOf, labelOf) {
    for (const row of turn.rows) {
      if (tools.indexOf(String(row?.toolCall || "").trim()) < 0) continue;
      const text = textOf(row);
      if (text !== "") return { text, label: labelOf(row) };
    }
    return { text: "", label: "" };
  }

  // L1 那一句话与 L2 的正文**同源**：两个出口只在这里分工，各自只管压多少字。
  function hisSaidOf(turn) {
    return saidOf(turn, HIS_TOOL_CALLS, hisSpeechOf, hisLabelOf);
  }

  function herSaidOf(turn) {
    return saidOf(turn, SPEAKING_TOOL_CALLS, speechOf, () => HER_LABEL);
  }

  // 列表那一行的一句话（§5 的四级优先级，取第一个命中的）：
  //   ① 她的话 → ② 他的话 → ③ 工具的具体动作 → ④ 工具名人话链。
  // 只有 ①②③ 都取不到具体内容时才落到 ④ —— 改动前 172 轮里 171 轮落在 ④，整屏读起来是日志。
  // ①② 的人称**不是写死的「他 / 她」**：她那一路是「她」，他那一路由来源定（hisLabelOf）——
  // 子代理会话记下的是父代理的提示词，就写「子代理」，不冒充他。
  // ★ 返回值分成「层 + 文本」：屏上只用文本；复核口（gistAudit）要的正是**落在哪一层** ——
  //   「具体」与「只是工具名」这件事不能靠肉眼数（第 6 步的 concreteGist 就从这儿来）。
  function gistPartsOf(turn) {
    const view = auditView();
    const her = herSaidOf(turn);
    if (her.text !== "") return { layer: "her", text: `${her.label}：${clip(her.text, 44)}` };
    const his = hisSaidOf(turn);
    if (his.text !== "") return { layer: "his", text: `${his.label}：${clip(his.text, 44)}` };
    for (const row of turn.rows) {
      const action = clip(actionOf(row), 44);
      if (action !== "") return { layer: "action", text: action };
    }
    const names = [];
    for (const row of turn.rows) {
      const raw = String(row?.toolCall || "").trim();
      if (raw === "") continue;
      const name = humanOf(raw);
      if (name !== "" && names.indexOf(name) < 0) names.push(name);
    }
    if (names.length === 0) return { layer: "bucket", text: view.turnGist(turn) };
    if (names.length <= 2) return { layer: "tool", text: safeOf(names.join("、")) };
    return { layer: "tool", text: safeOf(`${names.slice(0, 2).join("、")} 等 ${api.fmt.number(names.length)} 项`) };
  }

  function gistOf(turn) {
    return gistPartsOf(turn).text;
  }

  // 「失败」只认 stageDetail 里这四个键 —— 字段名以**写入侧**为准，不由这一屏猜：
  //   `ok === false` / `timedOut === true` / `error` 非空：并行支行（same_turn_emotion /
  //     query_expand）一次写全这三个，lib/index.js:2649-2663；
  //   `dropReasons` 非空：extract 行的图账（被丢的三元组各带一句理由），lib/engine.js:424-440。
  // ★ 失败分支**现在是活的**（2026-10-25 窗实测）：3 行 `ok === false`（`9515d152` /
  //   `2b5729ed` 的并行支），而它们的 `error` 与 `reason` **都是 null** ⇒ 屏上必须写
  //   「失败（没留原因）」，不许写成「失败：null」，也不许因为没原因就当没失败。
  //   判据只有一条：**印「失败」的行数 = failureOf(row) !== null 的行数**。
  //   （旧注释说「一次都没出现过」是那时窗口构成造成的，数据一换这句就是假话，故删。）
  // stageDetail 是 JSON 字符串，解析不了就当这一行没有标记（不猜、不把解析失败当失败）。
  function failureOf(row) {
    // 与 sdOf 同一条口径：字符串或对象都吃；解析不出来返回 null（这是「解析失败」，不是「失败」）。
    const detail = jsonObjectOf(row?.stageDetail, true);
    if (detail === null) return null;
    if (detail.ok === false) return { signal: "ok=false", value: false };
    if (detail.timedOut === true) return { signal: "timedOut=true", value: true };
    if (detail.error !== undefined && detail.error !== null && String(detail.error).trim() !== "") {
      return { signal: "error", value: String(detail.error).slice(0, 120) };
    }
    return null;
  }

  // §3.2 的「需要看」：这一轮任一行慢于 SLOW_MS，或任一行失败。两者各算各的，可以同时成立。
  // 返回的 reasons 是**可审计的原因**：每一个被标记的 (轮, 行, 信号) 一条。页面不显示它
  // （主指标只要一个数），但整窗的清单攒在 state.needsDetail 里、由 needsDetail() 交出去 ——
  // 这个数字必须能对着同一份 payload 一条一条数回来，否则它就是不可复算的。
  function flagOf(turn) {
    const turnKey = String(turn?.id ?? "");
    const at = auditView().msOf(turn?.time);
    const reasons = [];
    turn.rows.forEach((row, rowIndex) => {
      const rowStage = String(row?.stage ?? "");
      const rowTool = String(row?.toolCall ?? "");
      const latency = Number(row?.latency);
      if (Number.isFinite(latency) && latency >= SLOW_MS) {
        reasons.push({ turnKey, rowIndex, at, source: "latency", rowStage, rowTool, signal: `latency>=${SLOW_MS}`, value: latency });
      }
      const failed = failureOf(row);
      if (failed !== null) {
        reasons.push({ turnKey, rowIndex, at, source: "failure", rowStage, rowTool, signal: failed.signal, value: failed.value });
      }
    });
    return {
      slow: reasons.some((item) => item.source === "latency"),
      failed: reasons.some((item) => item.source === "failure"),
      reasons
    };
  }

  // 口径句：主指标是结论性数字，note 必须把阈值印出来，否则这个数无从复算（§3.2）。
  // 0 的时候也印口径，只是后面补一句「这窗口里没有」—— 口径不在某一种状态下消失。
  // 两种「0 轮」要分开说（第 5 步）：一行都没取到 ≠ 取到了行却折不出轮。
  //   · 空窗口：只说这一句实话，不印阈值（没有可数的东西，印口径只会像在编）；
  //   · 折不出轮：行数照印，并说清是「折不出轮」，不冒充「没有审计行」。
  function figureNoteOf(rows, turns, needs, unfoldable) {
    if (rows === 0) return "这窗口里一行审计都没有";
    if (unfoldable) return `本机窗口 ${api.fmt.number(rows)} 行 · 折不出轮（这些行没有可用的轮键）`;
    const base = `本机窗口 ${api.fmt.number(rows)} 行 · ${api.fmt.number(turns)} 轮`;
    return needs === 0 ? `${base} · 慢于 30 秒或失败（这窗口里没有）` : `${base} · 慢于 30 秒或失败`;
  }

  // 读失败时写在小字里的那一句：只给状态码或原因，不贴异常栈（栈对读屏与人都是噪声）。
  function errorReasonOf(error) {
    const message = String(error?.message || "");
    const http = message.match(/HTTP\s+(\d{3})/u);
    if (http !== null) return `HTTP ${http[1]}`;
    if (/EchoAuditView/u.test(message)) return "折轮脚本没挂上";
    if (error?.name === "TypeError" || /fetch|network|abort/iu.test(message)) return "网络没连上";
    return "读请求失败";
  }

  // 空态 + 重试：壳里的空态只有一句话、没有出路。这一屏有一种「不是空、也不是读失败」的状态
  // ——行取到了，但折不出轮（缺时间 / 轮次键）。它该有个真的会重新请求的按钮，而不是假控件。
  // 样式沿用壳里的 class（state-block / empty-copy / state-retry），不新造一套外观。
  function retryableEmpty(message) {
    const wrap = api.el("div", "state-block");
    wrap.append(api.el("p", "empty-copy", message));
    const button = api.el("button", "state-retry", "重试");
    button.type = "button";
    button.addEventListener("click", () => { load(); });
    wrap.append(button);
    return wrap;
  }

  // ---- 时间形状（第 2 步的小时分组）------------------------------------------------
  // 秒级时钟：L2 的时间跨度与行清单要比「HH:MM」细一档 —— 一轮往往只有几秒，
  // 只写分钟，六秒一轮的跨度就成了「00:33 – 00:33」，等于没说。
  function pad2(value) {
    return value < 10 ? `0${value}` : String(value);
  }

  function stampOf(ts) {
    const ms = auditView().msOf(ts);
    if (!(ms > 0)) return "";
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  // 分组键：**本地时区的日 + 小时**。日与小时分开给：组头平时只写「N 时」，
  // 只有这一页跨天时才把日期加到前面（同一页里十一个组头各带一遍日期只是噪音）。
  function hourKeyOf(ts) {
    const ms = auditView().msOf(ts);
    if (!(ms > 0)) return { day: "unknown", hour: -1 };
    const d = new Date(ms);
    return { day: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, hour: d.getHours() };
  }

  function dayText(key) {
    const parts = String(key).split("-");
    if (parts.length !== 3) return "时间不明";
    return `${api.fmt.number(Number(parts[1]))} 月 ${api.fmt.number(Number(parts[2]))} 日`;
  }

  // 毫秒 → 人话。与行尾「次数 · 耗时」和组头「最慢」共用这一个函数，
  // 屏上三处时间才是同一种写法（毫秒 / 秒一位小数 / 整秒）。
  function durationText(ms) {
    if (!(ms > 0)) return api.missing;
    if (ms < 100) return `${api.fmt.number(Math.round(ms))} 毫秒`;
    if (ms < 10000) return `${(ms / 1000).toFixed(1)} 秒`;
    return `${api.fmt.number(Math.round(ms / 1000))} 秒`;
  }

  // 行尾那一格数字：这一轮动了几次工具、一共花了多久。有才写，没有就是「—」。
  function elapsedOf(turn) {
    const stamps = turn.rows.map(row => auditView().msOf(row?.timestamp)).filter(value => Number.isFinite(value) && value > 0);
    return stamps.length ? Math.max(...stamps) - Math.min(...stamps) : null;
  }

  function metersOf(turn) {
    let tools = 0;
    for (const row of turn.rows) {
      if (String(row?.toolCall || "").trim() !== "") tools += 1;
    }
    const bits = [];
    if (tools > 0) bits.push(`${api.fmt.number(tools)} 次`);
    const elapsed = elapsedOf(turn);
    if (elapsed !== null) bits.push(`记录跨度 ${elapsed === 0 ? "0 毫秒" : durationText(elapsed)}`);
    return bits.join(" · ");
  }

  // 组头只写「N 时 · n 轮 · 最慢 x」。n 与「最慢」都只数**本页切片**里的那几轮：
  // 跨页的那一小时各页各报各的（第 1 页与第 2 页各有一段），所以「组头的轮数之和 = 这一页的行数」
  // 每一页都成立 —— 屏上能证明的只有这一页，组头也不许替整窗作证。
  function hourHeaderOf(group, withDate) {
    // 小时补零：「05 时」与行清单里的「05:12:33」同一种写法，扫的时候不会读成 5 和 05 两回事。
    const parts = [group.hour < 0 ? "时间不明" : `${pad2(group.hour)} 时`];
    parts.push(`${api.fmt.number(group.turns.length)} 轮`);
    let slowest = 0;
    for (const turn of group.turns) slowest = Math.max(slowest, elapsedOf(turn));
    if (slowest > 0) parts.push(`记录跨度最长 ${durationText(slowest)}`);
    const head = withDate ? `${dayText(group.day)} · ` : "";
    return `${head}${parts.join(" · ")}`;
  }

  // ---- L2「这一轮」----------------------------------------------------------------
  // 顶上一行把这一轮的骨架说完（时间跨度 / 行数 / 来源计数），下面按「他说了什么 → 她说了什么
  // → 这一轮经过 → 行清单」往下走。来源只报数、不报会话 ID：屏上不出现任何内部 ID（§1.4 第 2 条）。
  function spanOf(turn) {
    const first = stampOf(turn.rows[0]?.timestamp);
    const last = stampOf(turn.rows[turn.rows.length - 1]?.timestamp);
    if (first === "" && last === "") return api.missing;
    if (first === "" || first === last) return first || last;
    return `${first} – ${last}`;
  }

  function sourceTextOf(turn) {
    const view = auditView();
    const counts = new Map();
    for (const row of turn.rows) {
      const key = view.rowSource(row);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const parts = [];
    for (const key of SOURCE_ORDER) {
      const n = counts.get(key) || 0;
      if (n > 0) parts.push(`${(view.SOURCES[key] || {}).label || key} ${api.fmt.number(n)}`);
    }
    return parts.length === 0 ? `来源 ${api.missing}` : `来源 ${parts.join(" · ")}`;
  }

  function metaOf(turn) {
    return [spanOf(turn), `${api.fmt.number(turn.rows.length)} 行`, sourceTextOf(turn)].join(" · ");
  }

  // ---- 步骤账本（P6）：一轮 = 若干步，一步 = 一行 ---------------------------------
  // 这一屏的顺序**只用时间**：`turn.rows` 已经是 `timestamp` 升序（audit-view.js:318 全局排完
  // 再 push，实测全窗 141 轮 141 轮单调、0 处并列），所以屏上不自己 sort、也不按 `step` 重排。
  // 为什么不能按 `step` 重排：`step` 是**写入点的常量**（每个 stage 一个固定值），不是"第几步"；
  // 主动轮里 care 的 9 打头（`2b5729ed` / `9515d152`），按 step 重排会把因果讲反（实测 3 轮如此）。
  // `step` 只干两件事：判「这一步在不在回复管线上」（轮外）、给阶段取名。
  //
  // 管线序号表：**逐字抄** `web/audit-cards.html:108` 的 N2S；写侧同一套常量在
  // `lib/index.js:3672-3673` 的 EVENT_STEP。两份表一旦分叉，同一行会在两个面板上归到不同的
  // 阶段，所以 `docs/screenshots/p6a-check.mjs` 的 tableSame 一项逐键 diff 它们。
  const PIPE_STEP = {
    relay_in: 1, retrieve: 2, graph_query: 2, assemble: 3, structured_output: 5,
    echo_qq_say: 6, relay_out: 6, extract: 7, reflect: 7, reflection: 7, reflection_failed: 7,
    longing_steer: 8, care: 9, remind: 9, wake: 9,
    same_turn_emotion: 21, query_expand: 22
  };
  // 抄来的那张表漏了三个写侧 EVENT_STEP 有的名字：`relay_proactive: 9` / `care_silent: 9` /
  // `echo_wake: 9`（`lib/index.js:3672-3673`）。分开列：抄来的原样保留（tableSame 才有意义），
  // 另建一张写明"写侧有、抄的表没有"的补充；不补的话，她主动开口那一整行会被判成「轮外」。
  const PIPE_STEP_EXTRA = { relay_proactive: 9, care_silent: 9, echo_wake: 9 };
  // 阶段名：管线阶段用产品自己的九个词（`web/audit-cards.html:102` 的 ST）：
  // 收到 / 检索 / 组装 / 工具 / 回复 / 送信 / 提取 / 补一句 / 她起头；并行支两条用
  // `audit-cards.html:127` 的 gname（情绪打分 / 查询扩展）。工具行仍用人话工具名。
  // 这张表只把产品已有的叫法搬过来，一个新词都不造。
  const STAGE_WORD = {
    relay_in: "收到", retrieve: "检索", graph_query: "图谱检索", assemble: "组装",
    structured_output: "回复", relay_out: "送信", echo_qq_say: "送信",
    relay_proactive: "她起头",
    extract: "提取", reflect: "提取", reflection: "提取", reflection_failed: "提取",
    longing_steer: "补一句", care: "她起头", remind: "提醒", wake: "提醒", echo_wake: "提醒",
    same_turn_emotion: "情绪打分", query_expand: "查询扩展"
  };
  // 一句话的上限：§5 那一格压成一行，40 字是 1440 那一列（约 620px / 47 字）不折行的安全值。
  const WHAT_MAX = 40;
  // 「输入很大」的线：1,000 字以上才算这一步的一个事实（本窗口 2000 字写入截断的那批行
  // 都在线上，普通工具行 168~530 字，不会被这条沾上）。
  const BIG_INPUT = 1000;
  // 病态轮的护栏：超过 12 步先列 10 步 + 「还有 N 步」。本窗口最多 8 步，这两个数只是护栏。
  const GUARD_MAX = 12;
  const GUARD_HEAD = 10;

  // stageDetail 是 JSON 字符串：解析不了就**当这一行没有明细**（不猜、不把解析失败当失败）。
  function sdOf(row) {
    // `stageDetail` 现在以**字符串**（库里是 TEXT）到达，但也有可能被上游解析成对象。
    // 旧写法是 `String(x)` + `JSON.parse` —— 对象进来会变成 "[object Object]"、解析必失败、
    // 静默返回 null，于是失败信号整条丢掉。`jsonObjectOf` 两种形式都吃，解析失败仍返回 null
    // （=「解析不出来」，不是「失败」）。
    return jsonObjectOf(row?.stageDetail, true);
  }

  // 这一行在管线表里叫什么：`tool:<名字>` 去前缀，没有 stage 就用 toolCall。
  function pipeNameOf(row) {
    const stage = String(row?.stage || "").trim();
    if (stage !== "") return stage.indexOf("tool:") === 0 ? stage.slice(5) : stage;
    return String(row?.toolCall || "").trim();
  }

  // 归位序号（0 = 认不出）。四级回退照 `audit-cards.html:113-125`：
  // step → toolCall → stage；`tool:structured_output` 归 5（回复），不能因为 `/^tool:/`
  // 就判成 4（工具）。那是 audit-cards 那份表修过的第二个缺陷。
  function stepOf(row) {
    const direct = Number(row?.step);
    if (Number.isFinite(direct) && direct > 0) return Math.round(direct);
    const name = pipeNameOf(row);
    if (name === "") return 0;
    if (name === "structured_output") return 5;
    if (PIPE_STEP[name] !== undefined) return PIPE_STEP[name];
    if (PIPE_STEP_EXTRA[name] !== undefined) return PIPE_STEP_EXTRA[name];
    return 0;
  }

  // 「轮外」= 写侧没给 step，且管线表里也没有它的名字。
  // 为什么不按「名字里带 tool:」判：pwsh / edit / read 这些工具行的 step 是 4
  // （`lib/tool-audit.js:164` 写死），它们在本轮管线上；而 session-reaper / ipc-appraise /
  // emotion_decay / session_off 是别的写入路径写的、step 为 0，它们只是恰好落在这一轮的
  // 时间窗里（实测 17 行）。把这两类混成「工具」会把"她这一轮做了什么"讲宽。
  function outsiderOf(row) {
    const direct = Number(row?.step);
    if (Number.isFinite(direct) && direct > 0) return false;
    const name = pipeNameOf(row);
    if (name === "") return true;
    return PIPE_STEP[name] === undefined && PIPE_STEP_EXTRA[name] === undefined;
  }

  function stepNameOf(row) {
    const name = pipeNameOf(row);
    if (name === "") return "";
    if (STAGE_WORD[name] !== undefined) return STAGE_WORD[name];
    const tool = String(row?.toolCall || "").trim();
    return humanOf(tool === "" ? name : tool);
  }

  // 单步时长：行 `latency > 0` 优先；并行支只有 `stageDetail.ms`（`latency` 恒 null）。
  // 都没有就是 0 ⇒ 屏上印 api.missing，绝不拿时间戳差冒充耗时（那是"间隔"，不是"这一步花了多久"）。
  function stepMsOf(row) {
    return globalThis.EchoRoundFlowModel.durationOf(row);
  }

  // 失败**为什么**失败：有原因印原因，没原因就写「没留原因」。
  // 本窗口 3 行都是 `ok === false` 而 `error` / `reason` 全 null，那里绝不能拼出一个 `null`。
  function failTextOf(row) {
    const failed = failureOf(row);
    if (failed === null) return "";
    const detail = sdOf(row) || {};
    const reason = String(detail.error ?? detail.reason ?? "").trim();
    if (reason !== "") return clip(reason, WHAT_MAX);
    if (failed.signal === "timedOut=true") return "超时，没留原因";
    if (failed.signal === "dropReasons") return `丢了 ${api.fmt.number(failed.value)} 条，没留原因`;
    return "没留原因";
  }

  // 参数被写入侧截断时（`lib/index.js:3216` 截到 2000 字，尾部留 `…[共 N 字]`），
  // `payloadJson` 的 JSON.parse 一定失败，`actionOf` 就取不到；实测 200 行里 31 行因此没有
  // 一句话（send_message 12 / pwsh 11 / write 3 …）。但**截断点之前通常已经有关键参数**：
  // 这条按"能读到哪儿读到哪儿"取，允许最后一个字符串没有收尾引号（它被切掉了，不是没有）。
  // 只在 L2 的这一句话里用；L1 的 `actionOf` 一个字节不动（那一格与 p35gist 的判据绑在一起）。
  function looseArgOf(row, key) {
    const text = String(row?.userInput ?? "");
    const found = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, "u"));
    if (found === null) return "";
    return unescapeJson(found[1]).trim();
  }

  // 与上一条同一条正则，但**不 unescape**：多行的 shell 命令要按它自己那个 `\n` 切段，
  // unescape 会先把 `\n` 换成空格，于是 `cd X\nnode Y` 就成了一行、段也切不开。
  function looseRawArgOf(row, key) {
    const text = String(row?.userInput ?? "");
    const found = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, "u"));
    return found === null ? "" : found[1];
  }

  function looseActionOf(row) {
    const tool = String(row?.toolCall || "").trim();
    if (tool === "pwsh") {
      const description = looseArgOf(row, "description");
      if (description !== "") return description;
      // 参数整体被截断时 description（在 `command` 之后）也读不到，退回**命令本身的第一条**：
      // 按命令自己的换行/分号切段，跳过 `cd` 这种位置切换（它不是"这一步在干什么"），
      // 路径照 sanitize 缩到末两段。
      const rawCommand = looseRawArgOf(row, "command");
      const parts = rawCommand.split(/\\n|[;\n]|&&/u)
        .map((part) => unescapeJson(part).trim())
        .filter((part) => part !== "");
      const segment = parts.find((part) => !/^(cd|pushd|popd|set-location)\b/iu.test(part));
      if (segment !== undefined) return segment;
      const plain = looseArgOf(row, "command");
      return plain;
    }
    if (tool === "send_message") return String(looseArgOf(row, "message")).split(/[。！？!?\n]/u)[0];
    if (tool === "structured_output") {
      const summary = looseArgOf(row, "summary");
      if (summary !== "") return summary;
      const parsed = auditView().payloadJson(String(row?.userInput ?? ""));
      return parsed && Array.isArray(parsed.keywords) ? `记下 ${api.fmt.number(parsed.keywords.length)} 个关键词` : "";
    }
    if (tool === "present") return looseArgOf(row, "description");
    if (tool === "todo_write") {
      const done = String(row?.llmReply ?? "").match(/(\d+)\s+completed/u);
      return done === null ? "" : `待办 ${api.fmt.number(Number(done[1]))} 条已完成`;
    }
    if (PATH_TOOLS.indexOf(tool) >= 0) {
      // write / edit 的参数是 `content` 在前、`file_path` 在后 ⇒ 截断时路径整个没了。
      // 但 `llmReply` 是写入侧自己的回执，里面有它写/读的那个路径（`<path>…</path>` 或盘符路径）。
      const path = looseArgOf(row, "file_path") || looseArgOf(row, "path") || replyPathOf(row);
      return path === "" ? "" : lastTwoSegments(path);
    }
    if (tool === "grep") return looseArgOf(row, "pattern");
    if (tool === "skill") return looseArgOf(row, "name");
    return "";
  }

  // 工具回执里的路径（`ok · <path>C:\…\x.mjs</path>…` / 纯盘符路径）。只取路径，不取正文。
  function replyPathOf(row) {
    const text = String(row?.llmReply ?? "");
    const tagged = text.match(/<path>([^<]+)<\/path>/u);
    if (tagged !== null) return tagged[1].trim();
    const plain = text.match(/[A-Za-z]:[\\/][^\s<>"'`]+/u);
    return plain === null ? "" : plain[0];
  }

  // 每步「这一步做了什么」一句话（≤40 字）。取到即停；**取不到返回空串**，由渲染层印 api.missing。
  // 素材只来自这一行自己（userInput / llmReply / stageDetail），不跨行拼、不猜。
  // 硬约束：不许出现裸工具名（第一格已经给了）、不许出现 `{"`（sanitize 会截并标）、
  // 不许出现 `tool:`（那是内部标记）。
  // 人际打分的回执是**结果**，不是失败原因。
  // 实测这一行的 `llmReply` 长这样：`other={"a":0.569,"c":0.823} gain=0.72 gate=green`
  // （本窗 6 行全是这种，没有一行 `ok:false`、也没有 error —— 打分是成功的）。
  // 旧写法把任何非空 `llmReply` 当成"没做成"的理由，于是成功的打分被写成
  // 「人际打分没做成：other={...}」。现在的判据：
  //   · 空串 ⇒ 没做成（数据里没有回执）；开头是 error / failed / 失败 ⇒ 没做成 + 原因；
  //   · 解析得出 a(主导) / c(亲近) / gain / gate ⇒ 按数值印结果（`context.js:336-337` 就用
  //     「主导 / 亲近」这两个词，这里照抄，一个新词都不造）；
  //   · 其它解析不出来的 ⇒ 原样印前 40 字，**绝不加**"没做成"。
  // gate=green 与 gate=yellow 分开印：yellow 是"还能用但要注意"，不是成功也不是失败。
  function appraisalOf(reply) {
    const raw = String(reply ?? "").trim();
    if (raw === "") return "人际打分没做成";
    const head = raw.slice(0, 12).toLowerCase();
    if (head.indexOf("error") === 0 || head.indexOf("failed") === 0 || head.indexOf("失败") === 0) {
      return `人际打分没做成：${clip(raw, WHAT_MAX)}`;
    }
    const other = raw.match(/other\s*=\s*(\{[^}]*\})/u);
    const gate = raw.match(/gate\s*=\s*([A-Za-z_]+)/u);
    const gain = raw.match(/gain\s*=\s*(-?\d+(?:\.\d+)?)/u);
    let agency = null;
    let communion = null;
    if (other !== null) {
      let parsed = null;
      try { parsed = JSON.parse(other[1]); } catch { parsed = null; }
      if (parsed !== null && typeof parsed === "object") {
        agency = Number(parsed.a);
        communion = Number(parsed.c);
      }
    }
    const bits = [];
    if (Number.isFinite(communion)) bits.push(`亲近 ${communion.toFixed(2)}`);
    if (Number.isFinite(agency)) bits.push(`主导 ${agency.toFixed(2)}`);
    // gate 排在 gain 前面：这一格只有 40 字，`gate green` / `gate yellow` 是要能分开看出来的那个事实，
    // gain 挤得下才印（挤不下它仍在 L3 的 llmReply 原文里）。
    if (gate !== null) bits.push(`gate ${gate[1]}`);
    if (gain !== null && bits.join(" ").length + ` gain ${Number(gain[1]).toFixed(2)}`.length + 6 <= WHAT_MAX) {
      bits.push(`gain ${Number(gain[1]).toFixed(2)}`);
    }
    if (bits.length === 0) return `人际打分：${clip(raw, 40)}`;
    return `人际打分：${bits.join(" ")}`;
  }

  function whatOf(row) {
    const tool = String(row?.toolCall || "").trim();
    const stage = String(row?.stage || "").trim();
    const detail = sdOf(row) || {};
    let text = "";
    if (stage === "retrieve") {
      const candidates = Number(detail.candidates);
      if (Number.isFinite(candidates)) {
        text = candidates > 0 ? `检索到 ${api.fmt.number(candidates)} 条候选` : "没检索到候选";
        const arms = Array.isArray(detail.arms) ? detail.arms.length : 0;
        if (arms > 0) text += `，走了 ${api.fmt.number(arms)} 路`;
      }
    } else if (stage === "assemble") {
      const total = Number(detail.total);
      if (Number.isFinite(total) && total > 0) {
        text = `注入 ${api.fmt.number(total)} 字`;
        const persona = Number(detail.persona);
        if (Number.isFinite(persona) && persona > 0) {
          const on = detail.personaActive === true ? "在场" : (detail.personaActive === false ? "不在场" : "");
          text += `，人设 ${api.fmt.number(persona)} 字${on}`;
        }
      }
    } else if (stage === "same_turn_emotion" || stage === "query_expand") {
      // 并行支：起止是毫秒级的真数据（`beginAt`/`settleAt`），照它原样写出来 ——
      // 「与主流程同起」这句话不是猜的（两条支的 `beginAt` 就是同一次开口的时刻），
      // 但光说"同起"读不出先后，所以把两个时刻印出来。
      // **不再重复一遍时长**：右边「耗时」那一列印的就是这两条支的 `ms`（同一个数），
      // 一句话里再写一次会把 40 字撑爆、把"没给结果"挤成省略号。
      const begin = Number(detail.beginAt);
      const settle = Number(detail.settleAt);
      if (Number.isFinite(begin) && Number.isFinite(settle)) {
        text = `${clockMsOf(begin)} 起跑，${clockMsOf(settle)} 落定`;
      } else if (Number.isFinite(begin)) {
        text = `${clockMsOf(begin)} 起跑，落定时刻没记`;
      } else {
        // 并行支缺 `beginAt` / `settleAt`（合成数据或旧写法）：这一句话只能写"没有"，
        // 不许编一个 00:00:00 出来，也不许留空让人以为这一步没发生。
        text = "没有起止时刻";
      }
      if (stage === "same_turn_emotion" && detail.ok === false) text += " · 没给结果";
      if (stage === "query_expand" && detail.reason === "cache_hit") text += " · 命中缓存";
    } else if (stage === "emotion_decay") {
      const hours = Number(detail.hours);
      if (Number.isFinite(hours) && hours > 0) text = `替情绪衰减 ${String(hours)} 小时`;
    } else if (stage === "extract" || stage === "reflect" || stage === "reflection" || stage === "reflection_failed") {
      const writtenRaw = detail.triplesWritten !== undefined ? detail.triplesWritten : detail.written;
      const allRaw = detail.triplesRaw !== undefined ? detail.triplesRaw : detail.items;
      const written = Number(writtenRaw);
      const all = Number(allRaw);
      if (Number.isFinite(written) || Number.isFinite(all)) {
        const w = Number.isFinite(written) ? written : 0;
        const r = Number.isFinite(all) ? all : w;
        text = `提出 ${api.fmt.number(r)} 条，写成 ${api.fmt.number(w)} 条`;
        const dropped = Array.isArray(detail.dropReasons) ? detail.dropReasons.length : 0;
        if (dropped > 0) text += `，丢 ${api.fmt.number(dropped)} 条`;
      }
    } else if (tool === "care") {
      const label = stripMarkerOf(row?.userInput);
      text = label === "" ? "主动开口" : `主动开口的理由：${label}`;
    } else if (tool === "relay_proactive" || tool === "echo_qq_say" || tool === "relay_out") {
      // 信封 `[QQ:私聊] 正文` 里那一段是**渠道**，不是正文（正文走 speechOf 那一套）。
      const channel = String(row?.userInput ?? "").match(/^\[([^\]]+)\]/u);
      const said = speechOf(row);
      if (channel !== null) text = `发到 ${channel[1].replace(/[:：]/u, " ")}`;
      else if (said !== "") text = `说了 ${api.fmt.number(said.length)} 字`;
    } else if (tool === "session-reaper") {
      const reaped = String(row?.llmReply ?? "").match(/reaped=(\d+)\s+kept=(\d+)/u);
      if (reaped !== null) text = `清掉 ${api.fmt.number(Number(reaped[1]))} 个会话，留下 ${api.fmt.number(Number(reaped[2]))} 个`;
    } else if (tool === "ipc-appraise") {
      text = appraisalOf(row?.llmReply);
    } else if (tool === "structured_output") {
      // 这一步的"意思"就是它**记下了多少东西** —— 只写「记下摘要」而不带量，等于把
      // 一句话里唯一可核对的事实丢了（输入字数那一列已经在第 1 步撤出 L2）。
      // 句式固定「记下 N 字：<摘要首段>」，整句仍压在 40 字以内。
      const parsed = auditView().payloadJson(String(row?.userInput ?? ""));
      const summary = String(looseArgOf(row, "summary") || (parsed && typeof parsed.summary === "string" ? parsed.summary : "")).trim();
      const body = summary !== "" ? summary : (parsed && Array.isArray(parsed.keywords) ? parsed.keywords.join(" / ") : "");
      if (body !== "") text = `记下 ${api.fmt.number(body.length)} 字：${body}`;
    } else {
      // 工具行：复用「具体动作」那一套（pwsh 取 description、路径族取末两段、其余取首个参数）。
      // 前面**不重复**工具名（第一格已经给了）。参数被截断时退回"容忍截断"的那一条。
      text = actionOf(row);
      if (text === "") text = looseActionOf(row);
    }
    if (text === "") text = firstArgOf(row);
    if (text === "") return "";
    // 「输入很大」本身也是这一步的一个事实（写入侧在 2000 字处就截断，那一批行的一句话
    // 往往只剩命令或路径）：带上量，才算把第 1 步撤掉的那一列补回来。
    // 先把位置留给这个尾巴，再压正文 —— 否则 tag 自己会被 clip 切掉。
    const size = String(row?.userInput ?? "").length;
    if (size >= BIG_INPUT) {
      const tag = ` · 输入 ${api.fmt.number(size)} 字`;
      return `${clip(text, Math.max(8, WHAT_MAX - tag.length - 1))}${tag}`;
    }
    return clip(text, WHAT_MAX);
  }

  // 距上一步多久（只用于「又跑了一次」那半句：证明"又跑了一遍"，不证明"重试"）。
  function gapTextOf(turn, rowIndex) {
    if (rowIndex <= 0) return "";
    const view = auditView();
    const now = view.msOf(turn.rows[rowIndex]?.timestamp);
    const prev = view.msOf(turn.rows[rowIndex - 1]?.timestamp);
    if (!(now > 0) || !(prev > 0) || now <= prev) return "";
    return `距上一步 ${durationText(now - prev)}`;
  }

  // 毫秒级时钟（并行支的起止是毫秒），与 `stampOf` 的秒级写法分开：
  // 秒级那一列是"第几步发生在什么时候"，这一句是"这一步自己跑了多久"。
  function clockMsOf(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) return api.missing;
    const d = new Date(ms);
    const p = (n) => (n < 10 ? `0${n}` : String(n));
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  }

  // 这一轮的步骤表（**纯数据**，不含 DOM）：验收脚本直接调它，不必爬屏。
  // 顺序 = turn.rows 的下标顺序（时间顺序）；序号只在主流程内连续，轮外行不带号。
  function flowOf(turn) {
    const steps = [];
    let no = 0;
    let prevName = "";
    // 两条并行支的 `beginAt` 是同一个数（同一次开口的时刻）—— 先数一遍，
    // 只在**先出现的那一条**上加「与另一路同起」：两条都写就成了一句废话。
    const beginCount = new Map();
    for (const row of turn.rows) {
      const begin = Number((sdOf(row) || {}).beginAt);
      if (Number.isFinite(begin)) beginCount.set(begin, (beginCount.get(begin) || 0) + 1);
    }
    const saidSame = new Set();
    turn.rows.forEach((row, rowIndex) => {
      const name = stepNameOf(row);
      const outsider = outsiderOf(row);
      if (!outsider) no += 1;
      const flags = [];
      if (outsider) flags.push({ kind: "out", text: "轮外", why: "" });
      const step = stepOf(row);
      if (step === 21 || step === 22) {
        const begin = Number((sdOf(row) || {}).beginAt);
        const same = Number.isFinite(begin) && (beginCount.get(begin) || 0) > 1 && !saidSame.has(begin);
        if (same) saidSame.add(begin);
        flags.push({ kind: "parallel", text: "并行", why: same ? "与另一路同起" : "" });
      }
      const latency = Number(row?.latency);
      if (Number.isFinite(latency) && latency >= SLOW_MS) flags.push({ kind: "slow", text: "慢", why: "" });
      const failed = failureOf(row);
      if (failed !== null) flags.push({ kind: "bad", text: "失败", why: failTextOf(row) });
      const again = !outsider && name !== "" && name === prevName;
      if (again) flags.push({ kind: "again", text: "又跑了一次", why: gapTextOf(turn, rowIndex) });
      if (!outsider) prevName = name;
      steps.push({
        row, rowIndex, name, outsider,
        no: outsider ? 0 : no,
        what: whatOf(row),
        ms: stepMsOf(row),
        flags
      });
    });
    return steps;
  }

  // 「最慢 X（第 k 步）」——没有可比的耗时（一步都没有 `latency`/`ms`）就整句不出现，
  // 不许写「最慢 api.missing」。两步显示成同一串时合并号码（1101ms 与 1111ms 都写「1.1 秒」，
  // 只点一个号会让人以为屏算错了）；并列超过 3 步就不列号，直接说「N 步并列」
  // （13 步全 0.2 秒那种轮上列 7 个号，比不列更难读）。轮外行没有序号，不参与点名。
  function slowestTextOf(steps) {
    let max = 0;
    for (const step of steps) if (step.ms > max) max = step.ms;
    if (!(max > 0)) return "";
    const label = durationText(max);
    const nos = steps.filter((step) => step.ms > 0 && !step.outsider && durationText(step.ms) === label)
      .map((step) => api.fmt.number(step.no));
    if (nos.length === 0) return `单条报告最长 ${label}`;
    if (nos.length > 3) return `单条报告最长 ${label}（${api.fmt.number(nos.length)} 条并列）`;
    return `单条报告最长 ${label}（记录 ${nos.join("、")}）`;
  }

  // 「从第 9 步『她起头』起」—— 只在 `step` 序与时间序不一致时出现（本窗 3 轮，全是主动轮：
  // care 的 9 打头）。补这一句是为了让读的人知道"这一轮是她起头的"，
  // 而不是让屏按 step 重排因果（顺序永远是时间顺序）。
  function conflictTextOf(turn) {
    const seq = turn.rows.map((row) => stepOf(row)).filter((value) => value > 0);
    let conflicted = false;
    for (let i = 1; i < seq.length; i += 1) if (seq[i] < seq[i - 1]) conflicted = true;
    if (!conflicted) return "";
    const first = turn.rows.find((row) => stepOf(row) > 0);
    if (first === undefined) return "";
    return `按记录时刻排列；原阶段编号不代表执行顺序`;
  }

  // 块标题：`7 步` / `7 步 · 轮外 1 · 最慢 1.1 秒（第 3、5 步）`。
  // 步数与轮外都数得回来（步数 + 轮外 = 这一轮的行数）。
  // 「最慢」与「从第 N 步起」只在有东西可说的那一轮出现，不相干的轮不印空话。
  function flowHeadOf(turn, steps) {
    // 一行都没有的轮（合成数据或折轮异常）不许写「只有后台记账 · 0 行」——
    // 那不是"记账"，是"什么都没有"。这一句与 detailOf 的空态共用同一条判据。
    if (steps.length === 0) return "这一轮没有可以列出的步骤";
    const background = globalThis.EchoBackgroundEvents.ofTurn(turn, steps);
    if (background.pure) return `后台事件 · ${api.fmt.number(steps.length)} 条真实审计记录 · 每条三个阅读模块`;
    const inside = steps.filter((step) => !step.outsider).length;
    const out = steps.length - inside;
    if (inside === 0) return `只有后台记账 · ${api.fmt.number(steps.length)} 行`;
    const parts = [`${api.fmt.number(inside)} 步`];
    if (out > 0) parts.push(`轮外 ${api.fmt.number(out)}`);
    const slowest = slowestTextOf(steps);
    if (slowest !== "") parts.push(slowest);
    const conflict = conflictTextOf(turn);
    if (conflict !== "") parts.push(conflict);
    return parts.join(" · ");
  }

  // ---- 图形层的数据（P9A）：节点 / 连线 / 并行组 / 真实墙钟窗口 -----------------------
  // 只出**纯数据**（也出成句的文字）：位置怎么摆是渲染层的事（`views/round.js`），这里只给事实。
  // 为什么并进这一个文件：`flowOf` / `stageDetail` 解析 / 折叠口径只有这一份 —— 图形层另抄一套，
  // 两处迟早对同一行说两件事。

  // 只接受完整记录区间；缺任一端时回到记录时刻点，报告时长不参与端点计算。
  function windowOf(row, ms) {
    const detail = sdOf(row) || {};
    const begin = Number(detail.beginAt);
    const settle = Number(detail.settleAt);
    if (Number.isFinite(begin) && begin > 0 && detail.settleAt !== null && detail.settleAt !== undefined && Number.isFinite(settle) && settle >= begin) {
      return { at: begin, end: settle, recorded: true };
    }
    const at = auditView().msOf(row?.timestamp);
    if (!(at > 0)) return { at: 0, end: 0, recorded: false };
    return { at, end: at, recorded: false };
  }

  // 毫秒级时钟：并行支的起止是毫秒数据，只印到秒会把两条支的先后抹平。
  function tickOf(ms) {
    const value = Number(ms);
    if (!(value > 0)) return api.missing;
    const d = new Date(value);
    const p2 = (n) => (n < 10 ? `0${n}` : String(n));
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  }

  // 一格的「入 / 出」：字数与条数**分开说**（`candidates` 是条、`total`/`injected` 是字），
  // 取不到的半边印 api.missing —— 不写 0（0 是一个事实，没记是另一个事实）。
  function ioOf(row) {
    const detail = sdOf(row) || {};
    const valid=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
    const candidates = valid(detail.candidates)?Number(detail.candidates):null;
    const amount=detail.injected!==undefined?detail.injected:detail.total;
    const chars = valid(amount)?Number(amount):null;
    const inChars = String(row?.userInput ?? "").length;
    const outChars = String(row?.llmReply ?? "").length;
    const into = candidates!==null && candidates >= 0
      ? `${api.fmt.number(candidates)} 条候选`
      : (inChars > 0 ? `${api.fmt.number(inChars)} 字` : api.missing);
    const out = chars!==null && chars >= 0
      ? `${api.fmt.number(chars)} 字`
      : (outChars > 0 ? `${api.fmt.number(outChars)} 字` : api.missing);
    return `入 ${into} · 出 ${out}`;
  }

  // 「这一步里她/他说了什么」的短标签。**逐字搬**产品自己那张表（`web/audit-cards.html:302-311`
  // 的 TOOL_HUMAN）：care=关怀 / relay_proactive=她主动 / relay_out=她说 / echo_qq_say=她说 /
  // relay_in=他说。只用来在同名节点之间做区分（一轮里两个「她起头」不能字面一样），一个新词都不造。
  const TOOL_SHORT = {
    relay_in: "他说", relay_out: "她说", echo_qq_say: "她说", echo_qq_call: "她喊",
    relay_proactive: "她主动", care: "关怀", wake: "闹钟", remind: "提醒",
    extract: "提取", retrieve: "检索", graph_query: "图谱检索", inject: "注入留痕",
    same_turn_emotion: "情绪打分", query_expand: "查询扩展", structured_output: "提取子调用",
    emotion_decay: "情绪衰减", "session-reaper": "会话清理"
  };

  // 一轮的图形模型。节点 = 步骤（一行一个，顺序仍是时间序），边 = 上一步交给下一步的东西。
  //   groups：相邻且都带「并行」标记的行算一组（判据与 flowOf 的 flag 同源）；只有一臂的组
  //   **不画分叉**（事实是另一路没记账，不是"没有并行"）。
  //   edges：链上相邻两步一条；组内两臂**互相之间不连**（并行没有先后），改成分叉两条 + 汇合两条。
  //   span / window / wait：整轮的墙钟跨度、活动窗口（主流程首起→末落）、以及两者之差的那段等待。
  function flowGraphOf(turn) {
    const input = turn && Array.isArray(turn.rows) ? turn : { rows: [] };
    const steps = flowOf(input);
    const nodes = steps.map((step, index) => {
      const span = windowOf(step.row, step.ms);
      const failed = hasFlag(step, "bad");
      const parallel = hasFlag(step, "parallel");
      // 原始名（`same_turn_emotion` / `tool:edit` / `session-reaper`）：与行清单 `.au-rowraw` 同一套判据
      // —— 凡是被人话名替换过的都留原文，排障时才对得上写入侧；没被替换的留空串（不印一行废话）。
      const ident = pipeNameOf(step.row);
      const tool = String(step.row?.toolCall || "").trim();
      const raw = [];
      if (ident !== "" && STAGE_WORD[ident] !== undefined && STAGE_WORD[ident] !== ident) raw.push(ident);
      if (tool !== "" && humanOf(tool) !== tool && raw.indexOf(tool) < 0) raw.push(tool);
      // 这一行说出口的话（全文，已剥信封与 markdown）：她的话走 speechOf，他的话走 hisSpeechOf，
      // 两个函数都是 L2 正文的唯一来源，这里不另取一套。
      const hers = speechOf(step.row);
      const his = hisSpeechOf(step.row);
      return {
        index,
        no: step.no,
        name: step.name === "" ? "记账" : step.name,
        rawText: raw.join(" · "),
        sayText: hers !== "" ? hers : his,
        saySide: hers !== "" ? "her" : (his !== "" ? "him" : ""),
        toolShort: TOOL_SHORT[tool] === undefined ? "" : TOOL_SHORT[tool],
        // 产品的长名（audit-view 的 toolHuman：`出站·她说` / `QQ 说话` / `关怀心跳`）：
        // 短标签撞车时用它兜底，比行号更像话。
        toolLong: humanOf(tool) === tool ? "" : humanOf(tool),
        what: step.what,
        ms: step.ms,
        msText: step.ms > 0 ? durationText(step.ms) : api.missing,
        at: span.at,
        end: span.end,
        // 落定时刻是推出来的（起 + 耗时）还是记下来的（settleAt）：浮层里要分开说。
        endRecorded: span.recorded,
        startText: span.at > 0 ? (span.recorded ? tickOf(span.at) : stampOf(step.row?.timestamp)) : api.missing,
        endText: span.end > 0 ? tickOf(span.end) : api.missing,
        ioText: ioOf(step.row),
        outsider: step.outsider,
        parallel,
        failed,
        slow: hasFlag(step, "slow"),
        again: hasFlag(step, "again"),
        failText: failed ? failTextOf(step.row) : "",
        flags: step.flags.map((flag) => flag.text)
      };
    });

    // 同名节点必须分得开：一轮里两个「她起头」（care 与 relay_proactive）光看字认不出谁是谁。
    // 只在**真的重名**时才挂短标签（`她起头·关怀` / `她起头·她主动`）；不重名的节点保持干净。
    // 短标签也撞车时（`relay_out` 与 `echo_qq_say` 都是「她说」），退到产品的长名
    // （`出站·她说` / `QQ 说话`，同取自 audit-view 的 toolHuman），最后才退到行号。
    const nameCount = new Map();
    for (const node of nodes) nameCount.set(node.name, (nameCount.get(node.name) || 0) + 1);
    const usedLabels = new Set();
    for (const node of nodes) {
      node.dup = (nameCount.get(node.name) || 0) > 1;
      let label = node.dup ? `${node.name}·${node.toolShort === "" ? api.fmt.number(node.index + 1) : node.toolShort}` : node.name;
      if (node.dup && usedLabels.has(label) && node.toolLong !== "" && !usedLabels.has(`${node.name}·${node.toolLong}`)) {
        label = `${node.name}·${node.toolLong}`;
      }
      if (node.dup && usedLabels.has(label)) label = `${node.name}·${api.fmt.number(node.index + 1)}`;
      node.label = label;
      usedLabels.add(label);
    }

    return globalThis.EchoRoundFlowModel.build(input, nodes, {
      clean: value => proseOf(copyOf(value)),
      duration: durationText, clock: tickOf, missing: api.missing
    });
  }

  // ---- L3：一行的 21 键字段表 ------------------------------------------------------
  // §3.1 的 21 个键，**一个都不能少**。顺序照那张表走，不按对象键序 —— 屏上的顺序得是文档的
  // 顺序，数据一换（JSON 键序是写入侧决定的）也不会跳。
  //   18 个印值；agentState 在 light 下恒 null，写「轻量窗口下取不到」，不许写成「没有」；
  //   traceId / sessionId 只列键名，值写「不上屏」（plan-ui-phases.md §2.3 第 8 条）；
  //   stageDetail 拆成键值对并**剥掉 turnTrace**（那是内部分组键，不是这一行的数据）。
  const L3_FIELDS = [
    "timestamp", "toolCall", "stage", "step", "latency", "llmReply", "userInput",
    "injectedMemories", "injectedProfile", "emotionPack", "emotionPackStructured",
    "emotionVector", "emotionDelta", "moodIntensity", "prevMoodIntensity",
    "sayAgain", "extraReply", "agentState", "stageDetail", "traceId", "sessionId"
  ];
  // 只列键名的两个：内部 ID 不上屏。值是数据里真有的（200/200 行都有），藏的是**值**不是字段。
  const L3_BLOCKED = ["traceId", "sessionId"];
  const L3_BLOCKED_TEXT = "不上屏";
  // 两个截断口径与写入侧同一个数：userInput 写入即 2000（lib/index.js:3216）、
  // injectedProfile / emotionPack / emotionPackStructured 在 light 下裁 600（lib/store.js:1218,1225,1226）。
  // 「恰好等于阈值」也标：与写入侧同宽，说明它可能还有后半段没进来。
  const WRITE_CLIP = 2000;
  const LIGHT_CLIP = 600;
  const L3_NOTE_WRITE = "写入即截断（2000 字）";
  const L3_NOTE_LIGHT = "light 截断（600 字）";
  const L3_AGENT_STATE = "轻量窗口下取不到";
  // 分组键的名字只在这一处出现：写在这里，剥的时候就不会漏。
  const TURN_TRACE_KEY = "turnTrace";

  // 工具名 / 阶段名：**照原样印**。它们不是内部 ID，`session-reaper` 是工具名而不是会话 ID ——
  // 走 scalarText 会被那道收口改写成「会话」，等于把 L3 该给的原名吃掉（L2 的原始名那一列
  // 本来也是这么印的）。只放行「纯标识符」这一种形状，且显式挡掉 UUID 与 session-<8 位十六进制>，
  // 别的怪值一律退回那道收口 —— 放行的是一类值，不是一条规则。
  function nameText(value) {
    const text = String(value ?? "").trim();
    if (text === "") return "空串";
    const safe = /^[A-Za-z0-9_:.-]{1,64}$/u.test(text)
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-/iu.test(text)
      && !/^session-[0-9a-f]{8}/u.test(text);
    return safe ? text : scalarText(text);
  }

  // 一个标量上屏的字。null 照印 `null`（要与 `0`、空串分开）；空串印「空串」，不印空白。
  // 字符串走 L1/L2 同一道收口（proseOf → sanitize）：盘符缩末两段、session-*/UUID 换人话、
  // 撞上原始 JSON 就截断并说明「这一段不上屏」。
  // JSON 里再套一层就把那一层的键值摊平印出来（`s -0.2 · a -0.66`），第三层才收成「N 键」——
  // 第三层的值是给人扫一眼的，不是 JSON 浏览器；但摊平到第二层是为了别把值换成计数。
  function scalarText(value, depth = 0) {
    if (value === null) return "null";
    if (value === undefined) return api.missing;
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "string") {
      const text = proseOf(value);
      return text === "" ? "空串" : text;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return "空数组";
      if (depth >= 2) return `${api.fmt.number(value.length)} 项`;
      const shown = value.slice(0, 8).map((item) => scalarText(item, depth + 1)).join("、");
      return value.length > 8 ? `${shown}（共 ${api.fmt.number(value.length)} 项，列出前 8）` : shown;
    }
    const keys = Object.keys(value);
    if (keys.length === 0) return "空对象";
    if (depth >= 2) return `${api.fmt.number(keys.length)} 键`;
    const shown = keys.slice(0, 8).map((key) => `${key} ${scalarText(value[key], depth + 1)}`);
    const joined = keys.length > 8 ? `${shown.join(" · ")}（共 ${api.fmt.number(keys.length)} 键，列出前 8）` : shown.join(" · ");
    // 空值（"" / 空数组）会留下两个连着的分隔点：折一下，别让屏上出现「· ·」。
    return joined.replace(/ · (· )+/gu, " · ").replace(/^\s*·\s*/u, "").replace(/\s*·\s*$/u, "");
  }

  // JSON 字段拆键值对。strict=true 只认整段就是 JSON（emotionPack 是散文，别把它误读成对象）；
  // strict=false 时允许尾巴带一句人话（stageDetail 里见过 `{…} 备注` 这种）。
  function jsonObjectOf(value, strict = true) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
    const text = String(value ?? "").trim();
    if (text === "") return null;
    const asObject = (parsed) => (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null);
    try {
      const parsed = asObject(JSON.parse(text));
      if (parsed !== null) return parsed;
    } catch {
      // 落到下面那一步：strict 时到此为止
    }
    return strict ? null : asObject(auditView().payloadJson(text));
  }

  // 键值对子表：`<dl>` 两列（键名 / 值）。JSON 字段用它，不用一行 JSON 顶上去。
  function pairListNode(entries) {
    const list = api.el("dl", "au-l3-sub");
    for (const [key, value] of entries) {
      list.append(api.el("dt", "au-l3-subkey", key), api.el("dd", "au-l3-subval", value));
    }
    return list;
  }

  // 一格的值。返回值一定是个节点（空就印 `—`），所以 21 行永远都在 —— 少一行就是丢字段。
  function fieldValueNode(key, row) {
    const box = api.el("div", "au-l3-val");
    const note = (text) => box.append(api.el("p", "au-l3-note", text));
    const text = () => box.append(api.el("span", "au-l3-text", scalarText(row?.[key])));
    const raw = row?.[key];

    if (L3_BLOCKED.indexOf(key) >= 0) {
      box.append(api.el("span", "au-l3-muted", L3_BLOCKED_TEXT));
      note("内部 ID 不上屏（plan-ui-phases.md §2.3 第 8 条）");
      return box;
    }

    if (key === "timestamp") {
      // 钟点 + 秒级原值：屏上扫时间，排障时要那串原始数字。
      const clock = stampOf(raw);
      box.append(api.el("span", "au-l3-num", `${clock === "" ? api.missing : clock} · 原值 ${scalarText(raw)}`));
      return box;
    }

    if (key === "latency") {
      // 原毫秒：不换算成「1.9 秒」，这一层要的是能跟日志对上的那个数。
      box.append(api.el("span", "au-l3-num", typeof raw === "number" ? `${raw} ms` : scalarText(raw)));
      return box;
    }

    if (key === "step" || key === "moodIntensity" || key === "prevMoodIntensity") {
      box.append(api.el("span", "au-l3-num", scalarText(raw)));
      return box;
    }

    if (key === "toolCall" || key === "stage") {
      // 这两个是名字，不是正文：走 nameText（原名照印，见上面那段）。
      box.append(api.el("span", "au-l3-text", nameText(raw)));
      return box;
    }

    if (key === "agentState") {
      // light=1 把 agent_state 裁到 600 再解析，解析不成就是 null（lib/store.js:1227）——
      // 这是**取不到**，不是「没有」。写成「—」会让人以为她那一刻没有状态。
      if (raw === null || raw === undefined) {
        box.append(api.el("span", "au-l3-muted", L3_AGENT_STATE));
        note("light 下先裁 600 再解析，解析不成即 null（lib/store.js:1227）");
      } else {
        const obj = jsonObjectOf(raw, false);
        const entries = obj === null ? [] : Object.entries(obj);
        if (entries.length > 0) box.append(pairListNode(entries.map(([k, v]) => [k, scalarText(v)])));
        else if (obj !== null) box.append(api.el("span", "au-l3-muted", "空对象"));
        else text();
      }
      return box;
    }

    if (key === "stageDetail") {
      const source = String(raw ?? "").trim();
      const obj = jsonObjectOf(source, false);
      if (obj === null) {
        if (source === "") box.append(api.el("span", "au-l3-muted", api.missing));
        else { text(); note("不是 JSON，按原文给出"); }
        return box;
      }
      const entries = Object.entries(obj).filter(([k]) => k !== TURN_TRACE_KEY);
      if (entries.length > 0) box.append(pairListNode(entries.map(([k, v]) => [k, scalarText(v)])));
      else if (Object.keys(obj).indexOf(TURN_TRACE_KEY) >= 0) {
        // 只剩分组键：说清楚它被剥了，而不是印一个空表让人以为明细丢了。
        box.append(api.el("span", "au-l3-muted", "空"));
        note("这一行只有 turnTrace（内部分组键，不印）");
      } else box.append(api.el("span", "au-l3-muted", "空对象"));
      return box;
    }

    if (key === "emotionPackStructured" || key === "emotionVector" || key === "emotionPack") {
      const source = String(raw ?? "");
      // ★ 传 raw 而不是 source：emotionVector 在数据里**已经是对象**，String(对象) 是
      // "[object Object]" —— 那样判出来的永远是「取不出键值对」。长度与「像不像 JSON」
      // 才用 source（那是原来那个串的长度，截断阈值按它算）。
      const obj = jsonObjectOf(raw, key !== "emotionPack");
      const entries = obj === null ? [] : Object.entries(obj);
      if (entries.length > 0) {
        box.append(pairListNode(entries.map(([k, v]) => [k, scalarText(v)])));
      } else if (obj !== null) {
        // 空对象（emotionVector 在没算出向量的行上就是 `{}`）：印字，别留一格空白 ——
        // 空白会让人以为这一格没渲染出来。
        box.append(api.el("span", "au-l3-muted", "空对象"));
      } else if (source.trim().startsWith("{")) {
        // 被 light 裁在中间的 JSON：键值对取不出来，原文也**不印**（那是原始 JSON）。
        box.append(api.el("span", "au-l3-muted", "JSON 被裁在中间，键值对取不出来"));
      } else text();
      if (source.length >= LIGHT_CLIP) note(L3_NOTE_LIGHT);
      return box;
    }

    if (key === "userInput") {
      text();
      // 这一格必须留一个**字数**：第 2 步起 L2 不再印「输入 N 字」（六格塞不下、且一句话里
      // 已经有更具体的东西），但"这一行带了多大一段输入"仍是排障时要看的一个量，
      // 所以它在 L3 里明写出来。恰好 2000 的仍旧是那句截断标注（写入侧同宽）。
      const size = String(raw ?? "").length;
      note(size >= WRITE_CLIP ? L3_NOTE_WRITE : `原文 ${api.fmt.number(size)} 字`);
      return box;
    }

    if (key === "injectedProfile") {
      text();
      if (String(raw ?? "").length >= LIGHT_CLIP) note(L3_NOTE_LIGHT);
      return box;
    }

    text();
    return box;
  }

  // 一份 L3：21 行字段表 + 一行小字说明这是哪一行的字段。
  // 容器自己 tabindex=0：整表没有可点的控件（它就是个定义列表），但「Enter 展开 → Tab 进 L3」
  // 这条链需要有个能拿焦点的地方，而 Tab 只认 tab 顺序里的元素 —— 所以容器就是那个元素。
  // 焦点**在打开时不移动**（plan-audit.md:335：留在触发它的按钮上），Tab 才进来。
  function l3Of(row, rowIndex, turnIndex) {
    const box = api.el("div", "au-l3");
    box.id = l3IdOf(turnIndex, rowIndex);
    box.tabIndex = 0;
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "这一行的全部字段");
    for (const key of L3_FIELDS) {
      const field = api.el("div", "au-l3-field");
      field.dataset.field = key; // 复核脚本按它数 21 行、按名字对 §3.1
      field.append(api.el("span", "au-l3-key", key), fieldValueNode(key, row));
      box.append(field);
    }
    return box;
  }

  // ---- 流程图的几何：对数时长 + 传参缝 ------------------------------------------------
  // 为什么是对数：本窗"单轮 latency 之和 ÷ 时间跨度 = 0.01"，按真实比例画所有条都是 1px 噪声。
  // 固定域 1 毫秒 → 2 分钟，两端都看得见；1087ms 与 1111ms 只差 0.2%，差异交给条尾的数字。
  const BAR_LO = 1;
  const BAR_HI = 120000;
  function barPctOf(ms) {
    const value = Number(ms);
    if (!(value > 0)) return 0;
    const lo = Math.log10(BAR_LO);
    const hi = Math.log10(BAR_HI);
    const t = (Math.log10(Math.min(Math.max(value, BAR_LO), BAR_HI)) - lo) / (hi - lo);
    return Math.max(4, Math.round(t * 1000) / 10);
  }

  // 一步交给下一步的东西：只在**数据里真有**时才印，没有就是 null（不画缝、不猜"应该是 10 条"）。
  // 单位**按阶段分开**：`retrieve` 的 `candidates` 是「条」，`assemble` 的 `total`/`injected`
  // 是「字」。旧写法 `candidates ?? total` 把「注入 2,088 字」印成「2,088 条候选 交给她起头」
  // （`turn 102` 实测就是这样），一条边把两件事说错了 —— 所以这里按 stage 取，取到即停。
  // 返回 `{ short, text }`：`short` 给图上那条边的标签（`10 条候选`），`text` 给文字明细那一行。
  function transferOf(step, next) {
    const target = next !== undefined && next.name !== "" ? next.name : "";
    if (target === "") return null;
    const row = step.row;
    const detail = sdOf(row) || {};
    const stage = String(row?.stage || "");
    const tool = String(row?.toolCall || "");
    let short = "";
    if (stage === "retrieve") {
      const candidates = Number(detail.candidates);
      if (Number.isFinite(candidates)) short = candidates > 0 ? `${api.fmt.number(candidates)} 条候选` : "没检索到候选";
    } else if (stage === "assemble") {
      const chars = Number(detail.injected !== undefined ? detail.injected : detail.total);
      if (Number.isFinite(chars) && chars > 0) short = `${api.fmt.number(chars)} 字上下文`;
    } else if (stage === "extract" || stage === "reflect" || stage === "reflection" || stage === "reflection_failed") {
      const written = Number(detail.triplesWritten !== undefined ? detail.triplesWritten : detail.written);
      const all = Number(detail.triplesRaw !== undefined ? detail.triplesRaw : detail.items);
      if (Number.isFinite(written) && written > 0) short = `${api.fmt.number(written)} 条记忆`;
      else if (Number.isFinite(all) && all > 0) short = `${api.fmt.number(all)} 条提取`;
    } else if (SPEAKING_TOOL_CALLS.indexOf(tool) >= 0) {
      const said = speechOf(row);
      if (said !== "") short = `${api.fmt.number(said.length)} 字正文`;
    } else if (tool === "structured_output") {
      const summary = String(looseArgOf(row, "summary")).trim();
      if (summary !== "") short = `${api.fmt.number(summary.length)} 字摘要`;
    }
    if (short === "") return null;
    return { short, text: `${short} · 后续记录：${target}（不确认内容交接）` };
  }

  function hasFlag(step, kind) {
    for (const flag of step.flags) if (flag.kind === kind) return true;
    return false;
  }
  function l3IdOf(turnIndex, rowIndex) {
    return `au-l3-${turnIndex}-${rowIndex}`;
  }

  // 行清单里的一行 —— 现在它是「第 N 步」，六格：
  //   序号 / 时钟 / 阶段名（+ 原始名）/ 一句话 / 耗时 / 标记。
  // 序号是**位置**（这一轮的第几步），不是 `step` 字段的值；轮外行不带号，印 api.missing。
  // 整行仍是一颗 button：它就是第三层的开关（aria-expanded / aria-controls），
  // 类名 `.au-rowitem`、`data-row`、包装 `.au-l3row` 一个都没改名 —— 所以 p5a / p5b 那 45 项
  // 是按同一个选择器数的，改造不会让它们失效。包装元素的作用只有一个：让 L3 就地挂在这一行下面。
  function rowItemOf(step, turnIndex) {
    const row = step.row;
    const rowIndex = step.rowIndex;
    const tool = String(row?.toolCall || "").trim();
    const wrap = api.el("div", "au-l3row");
    const button = api.el("button", "au-rowitem");
    button.type = "button";
    button.dataset.row = String(rowIndex);
    button.setAttribute("aria-expanded", "false");
    // 阶段名后面挂原始名（`retrieve` / `same_turn_emotion` / `edit`）：排障时要能对上写入侧的
    // stage / tool 名。**凡是被翻译过的名字都留原文**（旧「阶段链」与旧「行清单」印的都是原文，
    // 删链不能顺手把原文也删掉）：
    //   ① 管线阶段（retrieve / assemble / same_turn_emotion…）被 STAGE_WORD 译成人话 ⇒ 附原文；
    //   ② 工具行（tool:edit / tool:pwsh）人话名与原文不同 ⇒ 附原文；
    //   ③ 认不出的名字（humanOf 原样返回）不附：它本来就在阶段名那一格里。
    // 1180 以下由 CSS 收起来（人话名 + 一句话已经认得出是哪一步），原文仍在 L3 的 stage 子里。
    const name = api.el("span", "au-rowhuman", step.name === "" ? "记账" : step.name);
    const raw = [];
    const ident = pipeNameOf(row);
    if (ident !== "" && STAGE_WORD[ident] !== undefined && STAGE_WORD[ident] !== ident) raw.push(ident);
    if (tool !== "" && humanOf(tool) !== tool && raw.indexOf(tool) < 0) raw.push(tool);
    if (raw.length > 0) name.append(api.el("span", "au-rowraw", ` ${raw.join(" · ")}`));
    name.append(globalThis.EchoOwnershipView.label(api, row, true));
    // 标记只印文字（慢 / 失败 / 并行 / 又跑了一次 / 轮外），一个色块都不用：
    // 慢与"又跑了一次"用 --faint，失败用 --negative（与 L1 的 .au-flag 同一套口径）。
    const flags = api.el("span", "au-stepflag");
    for (const item of step.flags) {
      const chip = api.el("span", `au-stepflag-item is-${item.kind}`, item.text);
      if (item.why !== "") chip.append(api.el("span", "au-stepflag-why", `（${item.why}）`));
      flags.append(chip);
    }
    const bad = hasFlag(step, "bad");
    const rail = api.el("span", "au-rail");
    rail.append(api.el("span", `au-rail-dot${bad ? " is-bad" : ""}`));
    const bar = api.el("span", "au-bar");
    const track = api.el("span", "au-bar-track");
    const fill = api.el("span", `au-bar-fill${bad ? " is-bad" : ""}`);
    fill.style.width = `${barPctOf(step.ms)}%`;
    // 最慢的一步给 1px 端帽：条长按对数，光看长度会比直觉"平"，端帽是给眼睛的锚点。
    if (step.ms > 0 && step.ms === slowestMs) fill.classList.add("is-max");
    track.append(fill);
    // 条放进「耗时」那一格：它和那个数字说的是同一件事，拆成第 7 列会把六格挤坏。
    const meter = api.el("span", "au-rowmeter", step.ms === null ? api.missing : step.ms === 0 ? "0 毫秒" : durationText(step.ms));
    bar.append(track);
    meter.append(bar);
    button.append(
      rail,
      api.el("span", "au-stepno", step.outsider ? api.missing : api.fmt.number(step.no)),
      api.el("span", "au-rowtime", stampOf(row?.timestamp) || api.missing),
      name,
      api.el("span", "au-stepwhat", step.what === "" ? api.missing : step.what),
      meter,
      flags,
    );
    wrap.append(button);
    l3Rows.set(wrap, { row, rowIndex, turnIndex });
    return wrap;
  }

  // 轮级「他 / 她」的全文（L2 用）：**就是 L1 那两个函数**（hisSaidOf / herSaidOf），
  // 只有取多少不同 —— 列表压到 44 字，这里给全文。判据一分叉，「一句话」与展开区就会各说一件事，
  // 所以这里不再另写一套取文本的代码（早先 hisFullOf/herFullOf 各抄了一遍，正是分叉的入口）。
  // ★ 这个函数只在**点开那一刻**被调用（见 attachDetail）：它造出来的 DOM 就是那一份详情。
  // 一轮的**对外 key**：10 位 hex 摘要，用于 `#/round/<key>`。它不是 turnTrace 原文 ——
  // 地址栏会进历史、截图和分享，内部分组键不许出现在那里。两条 FNV-1a 拼出来足够避开碰撞，
  // 且**同步**可算（列表行要用它渲染链接，不能等 async 摘要）。
  function roundKeyOf(turn) {
    const rows = (turn && Array.isArray(turn.rows)) ? turn.rows : [];
    const seed = String((turn && (turn.id || turn.key)) || (rows[0] && rows[0].timestamp) || "");
    let h1 = 0x811c9dc5;
    let h2 = 0xc2b2ae35;
    for (let i = 0; i < seed.length; i += 1) {
      const code = seed.charCodeAt(i);
      h1 = ((h1 ^ code) * 0x01000193) >>> 0;
      h2 = ((h2 ^ code) * 0x85ebca6b) >>> 0;
    }
    return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 10);
  }
  function detailOf(turn, index, showBackground = true) {
    const detail = api.el("div", "au-detail");
    detail.id = `au-detail-${index}`;

    detail.appendChild(api.el("p", "au-detail-label", "这一轮"));
    // 整页入口：列表里展开只是快速看一眼；要"完整流程图 + 大屏宽"就走 #/round/<key>。
    // 已经在轮页里就别再画一个指向自己的链接（点进去还是同一页，纯噪音）。
    let openLink = null;
    if (!/^#\/round\//u.test(String(location.hash || ""))) {
      openLink = api.el("a", "au-open", "整页 →");
      openLink.href = api.audit.href("round", roundKeyOf(turn));
      openLink.setAttribute("aria-label", "打开这一轮的整页流程图");
    }
    detail.appendChild(api.el("p", "au-meta", metaOf(turn)));
    detail.append(globalThis.EchoOwnershipView.label(api, turn));

    // 「他」「她」各占一段，**各自说自己有没有**。两段都空的时候才用一句话说完。
    // 段标题用人称标签本身：他那一段可能是「子代理说了什么」—— 父代理的提示词不冒充他。
    const his = hisSaidOf(turn);
    const her = herSaidOf(turn);
    if (his.text !== "") {
      detail.appendChild(api.el("p", "au-detail-label", `${his.label}说了什么`));
      detail.appendChild(api.el("p", "au-copy", proseOf(his.text)));
    }
    if (her.text !== "") {
      detail.appendChild(api.el("p", "au-detail-label", `${her.label}说了什么`));
      detail.appendChild(api.el("p", "au-copy", proseOf(her.text)));
    }
    if (his.text === "" && her.text === "") {
      detail.appendChild(api.el("p", "au-none", "这一轮没有说话。"));
    }

    // 这一轮**怎么走过来的**：一行块标题（几步 / 有没有轮外 / 最慢哪一步）+ 一步一行的账本。
    // 原来这里是两段：「阶段链」（把 stage 名用 › 连成一行）与「行清单」（光有名字与数字）。
    // 两段说的是同一批行，链还说不出顺序与时长 —— 合成一段之后，信息只增不减：
    // 阶段名一个不少（不折叠），多了序号、耗时、状态与"这一步做了什么"。
    //
    // 一行主流程都没有的轮（emotion_decay / session-reaper / ipc-appraise 这些后台记账，
    // 本窗口 31/141 轮）**不写「这一轮经过」**：她什么都没经过，那四个字是假话。
    // 标题直接写事实「只有后台记账 · 1 行」，下面照 §4.2 把轮外行原样列出来（不带序号）。
    const steps = flowOf(turn);
    const background = globalThis.EchoBackgroundEvents.ofTurn(turn, steps);
    if (showBackground && background.events.length) detail.append(globalThis.EchoBackgroundView.render(background, api, turn.rows));
    // 零行的轮：连"经过"都不成立，只留一句事实（不画块标题、不画提示、不画列表）。
    if (steps.length === 0) {
      detail.appendChild(api.el("p", "au-none", "这一轮没有可以列出的步骤。"));
      return detail;
    }
    if (steps.length > 0 && steps.every((step) => step.outsider)) {
      detail.appendChild(api.el("p", "au-flow-head is-outside", flowHeadOf(turn, steps)));
    } else {
      detail.appendChild(api.el("p", "au-detail-label", "这一轮经过"));
      detail.appendChild(api.el("p", "au-flow-head", flowHeadOf(turn, steps)));
    }
    // 窄档（≤1180）把原始名（`retrieve` / `same_turn_emotion` / `session-reaper`）收进 L3，
    // 屏上只留人话名；但读者得知道去哪儿找，所以这一行小字只在那一档出现
    // （≥1181 由 CSS 关掉：宽版式里原始名本来就在阶段名后面，不需要提示）。
    detail.appendChild(api.el("p", "au-flow-hint", "原始名在点开的那一步里"));
    const rows = api.el("div", "au-rows");
    // turnIndex 进到每一行里：L3 的 id（au-l3-轮-行）与 aria-controls 要用它，一页之内唯一。
    // 刻度用**一句话**而不是六格网格：条只有 92px 宽、贴在行尾，六个刻度标签铺满整行时
    // 位置与条根本对不上——那种"看起来有刻度"比没有更误导。真实值一律印在条左边。
    rows.append(api.el("p", "au-axis", background.pure
      ? "原始审计行账本；阅读模块不计为执行步骤。"
      : "条长按对数（1 毫秒 → 2 分钟），真实值印在条左；横轴是步骤序号，不是时间。"));
    slowestMs = steps.reduce((max, step) => (step.ms > max ? step.ms : max), 0);
    // 其余的点开（或 Tab 到它按 Enter）再补：不分页、不折叠成一段散文、不把 L2 变成墙。
    // 本窗口最多 8 步，这条护栏只在合成数据上被跑到（`p6a-check` 的 13 步那一轮）。
    const head = steps.length > GUARD_MAX ? steps.slice(0, GUARD_HEAD) : steps;
    // 一步一张"站台"，站台之间画传参缝；并行支用「分两路 / 两路汇合」夹住。
    // 缝与括号都是纯文本节点，不可聚焦 —— 键盘序列里仍然只有行按钮。
    head.forEach((step, at) => {
      const next = head[at + 1];
      const prev = head[at - 1];
      const parallelHere = hasFlag(step, "parallel");
      const parallelPrev = prev !== undefined && hasFlag(prev, "parallel");
      if (parallelHere && !parallelPrev) rows.append(api.el("p", "au-fork", "独立准备支（取用见图）"));
      if (!parallelHere && parallelPrev && prev !== undefined) rows.append(api.el("p", "au-fork", "准备支记录结束；不代表共同等待"));
      const station = rowItemOf(step, index);
      station.style.setProperty("--i", String(at)); // 按序淡入的节拍
      rows.appendChild(station);
      const seam = transferOf(step, next);
      if (seam !== null) rows.append(api.el("p", "au-seam", `↓ ${seam.text}`));
    });
    if (steps.length > GUARD_MAX) {
      const rest = steps.slice(GUARD_HEAD);
      const more = api.el("button", "au-more", `还有 ${api.fmt.number(rest.length)} 步`);
      more.type = "button";
      more.addEventListener("click", () => {
        const nodes = rest.map((step) => rowItemOf(step, index));
        for (const node of nodes) rows.insertBefore(node, more);
        // 焦点交给刚补出来的第一步：不交的话，删掉这颗按钮会把焦点丢到 body。
        const first = nodes.length > 0 ? nodes[0].querySelector(".au-rowitem") : null;
        more.remove();
        if (first !== null) first.focus();
      });
      rows.appendChild(more);
    }
    detail.appendChild(rows);
    // 放在行清单之后：放前面会挤进 L2 的 Tab 序，打乱「第一个 Tab 落在第一颗行按钮」这条断言。
    if (openLink !== null) detail.appendChild(openLink);

    // 注入块只报「几行、多长、有没有被裁」，不铺正文：它是她此刻读到的记忆原文，
    // 长度是这一屏问的那件事（这一轮她读到了多少），正文属于记忆屏。
    // light=1 只裁 injectedProfile / emotionPack / emotionPackStructured（lib/store.js:1218,1225,1226），
    // injectedMemories 原样透出（:1224）⇒ 这里数到的长度就是库里的长度，没被裁。
    // 没有注入块的时候不占一段「这一轮没有注入块」：本窗口 5/200 行才有，那样每轮都要念一次否定。
    const injected = turn.rows.filter((row) => String(row?.injectedMemories || "") !== "");
    if (injected.length > 0) {
      const lengths = injected.map((row) => String(row.injectedMemories).length);
      const shown = lengths.slice(0, 3).map((n) => api.fmt.number(n)).join(" + ");
      const rest = lengths.length > 3 ? ` 等 ${api.fmt.number(lengths.length)} 行` : "";
      detail.appendChild(api.el("p", "au-detail-label", "注入记忆"));
      detail.appendChild(api.el("p", "au-inject", `${api.fmt.number(lengths.length)} 行 · ${shown}${rest} 字 · 未截断`));
    }
    return detail;
  }

  function buildRow(turn, index) {
    const view = auditView();
    const key = String(turn.id || `turn-${index}`);
    const row = api.el("article", "list-row au-row");
    row.dataset.key = key;

    const toggle = api.el("button", "au-toggle");
    toggle.type = "button";
    toggle.dataset.key = key;
    toggle.setAttribute("aria-expanded", "false");
    // aria-controls 由 syncOpen 在**展开那一刻**挂上（见那里的注释）：收起时 L2 不在 DOM 里，
    // 就不该有 IDREF 指着空气。

    const when = view.relTime(turn.time);
    const stamp = api.el("time", "au-time", when);
    const at = view.msOf(turn.time);
    if (at > 0) stamp.dateTime = new Date(at).toISOString();
    const kind = api.el("span", "au-kind", (view.BUCKETS[turn.bucket] || {}).label || "其他");
    const gist = api.el("span", "au-gist", gistOf(turn));
    const gistWrap = api.el("span", "au-gist-wrap");
    gistWrap.append(gist, globalThis.EchoOwnershipView.label(api, turn));
    const count = api.el("span", "au-count", metersOf(turn) || api.missing);
    // 异常只用文字（§5）：慢是灰字（本窗口一屏可能有十一条，红字读起来只是噪声），
    // 失败是她这一屏唯一的红（本窗口一条）。
    const flag = flagOf(turn);
    if (flag.slow) count.append(" ", api.el("span", "au-flag", "慢"));
    if (flag.failed) count.append(" ", api.el("span", "au-flag is-bad", "失败"));
    toggle.append(stamp, kind, gistWrap, count);

    // 只画 L1 那一行。详情不在这里造：见 attachDetail（开的那一刻才建，收起就移除）。
    row.append(toggle);
    return row;
  }

  function setState(node) {
    // 三态（载 / 空 / 错）才挂 live：它们是一句话，念出来有用；
    // 把 aria-live 挂在整份列表上，刷新一次等于让读屏软件念一百七十多行。
    listHost.replaceChildren(node);
    listHost.setAttribute("aria-live", "polite");
  }

  function build(root) {
    scopeHost = api.el("div");
    root.append(scopeHost);
    const figure = api.el("div", "figure");
    // 主指标那个数字必须点得动：点它 = 点「需要看」那颗 chip（§3.2），两条入口共用 pickFilter。
    // 用 button 而不是 p：键盘顺序与焦点都由浏览器给，不自己造一颗假链接。
    figureValue = api.el("button", "figure-value figure-button", api.missing);
    figureValue.type = "button";
    figureValue.setAttribute("aria-describedby", "au-figure-note");
    figureValue.addEventListener("click", () => pickFilter("needs"));
    figureNote = api.el("p", "figure-note", `正在读取最近 ${api.fmt.number(LIMIT)} 行审计…`);
    figureNote.id = "au-figure-note";
    figure.append(api.el("p", "figure-label", "需要看"), figureValue, figureNote);
    // 这一块是 live：刷新完该念的是「需要看 12 本机窗口 200 行 · 170 轮 · 慢于 30 秒或失败」。
    // 主指标是结论性数字（§3.2），不是行数本身；口径在同一块里念出来，数字才可复算。
    figure.setAttribute("aria-live", "polite");

    // 一排 chips（§4）：全部 / 需要看 / 干活 / 后台 / 其它 / 提取。只这一排 —— 不做搜索框、
    // 不做来源筛、不做密度档（plan-ui-phases.md:187 只许一排）。
    const chipsHost = api.el("div", "au-chips");
    chips = api.chipRow(chipItems(), {
      label: "按类筛这一屏",
      active: state.filter,
      onPick: (key) => pickFilter(key)
    });
    chipsHost.appendChild(chips.el);

    const block = api.el("div", "list-block");
    listHost = api.el("div", "list au-list");
    // 翻页器数的仍是**筛完之后**的轮数（端点最多给 500 行，折轮一次折完再筛）：主指标与
    // 「需要看」的清单永远数整窗，翻页器数的是眼前这张表 —— 两个数回答的是两个问题。
    // 口径词必须带「本机窗口」：轮数只描述本次窗口，不是她的全部历史。
    pager = api.pager(state, {
      onChange: turnPage,
      unit: "轮",
      totalNote: `本机窗口 ${api.fmt.number(LIMIT)} 行`,
      // 390 一行只剩 190px：宽屏那句 243px 会折行（实测第 5 页「101–125」三位数时翻页器从 44 长到 96）。
      // 短写就是对话/待跟进已验过的那一句（「第 1–12 / 100（本机上限）」同款，实测最坏 177px），
      // 单位「轮」和「200 行」在这个宽度上让位给限定词：图栏那行小字写着 200 行与「窗口内轮数」。
      compact: (win) => `第 ${api.fmt.number(win.start + 1)}–${api.fmt.number(win.end)} / ${api.fmt.number(win.total)}（本机窗口）`
    });
    const pagerHost = api.el("div", "pager-host");
    pagerHost.appendChild(pager.el);
    block.append(listHost, pagerHost);
    root.append(figure, chipsHost, block);

    // 整行就是那颗按钮 ⇒ Enter / 空格由浏览器自己给，不用另写键盘处理。
    // 同时只开一条：状态只有 state.open 一个值，点开就把别的收起。
    listHost.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target === null) return;
      // 行清单里的某一行：它就是第三层的开关（见 toggleL3）。
      const item = target.closest(".au-rowitem");
      if (item) {
        toggleL3(item);
        return;
      }
      const toggle = target.closest(".au-toggle");
      if (!toggle) return;
      const key = String(toggle.dataset.key || "");
      state.open = state.open === key ? "" : key;
      state.openRow = ""; // 换一轮 ⇒ 上一轮那行的字段表作废
      // 先把焦点落到这颗行按钮上，再动 DOM：被收起来的那一份详情里若正拿着焦点，
      // 移除的一瞬间浏览器会把它丢到 body（懒渲染把这件事从「隐藏」变成「删除」，所以要先交接）。
      if (document.activeElement !== toggle) toggle.focus();
      syncOpen();
    });

    // Esc 收最内层**一次只收一层**（plan-audit.md:336）：
    //   L3 开着 → 只收 L3，焦点回那一行的行按钮，L2 还开着；
    //   L2 开着、L3 关 → 只收 L2，焦点回 L1 行按钮。
    // 两种情况都不给浏览器「把焦点丢到 body」的机会：删节点之前先把焦点交给触发它的那颗按钮。
    listHost.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (state.openRow !== "") {
        event.preventDefault();
        const wrap = [...listHost.querySelectorAll(".au-l3row")]
          .find((node) => {
            const item = node.querySelector(":scope > .au-rowitem");
            return item !== null && String(item.dataset.row ?? "") === state.openRow;
          }) || null;
        const item = wrap === null ? null : wrap.querySelector(":scope > .au-rowitem");
        state.openRow = "";
        syncL3(); // detachL3 里若焦点在那块里会先交还；下面这一次是兜底，保证焦点一定落到行按钮
        if (item !== null) item.focus();
        return;
      }
      if (state.open === "") return;
      const open = [...listHost.querySelectorAll(".au-row")]
        .find((row) => String(row.dataset.key || "") === state.open) || null;
      event.preventDefault();
      const toggle = open === null ? null : open.querySelector(".au-toggle");
      state.open = "";
      syncOpen();
      if (toggle !== null) toggle.focus();
    });
  }

  // ---- L3 的开关与懒渲染 ------------------------------------------------------------
  // 打开一份 L3 不动焦点：它挂在行按钮下面，Tab 顺序上紧跟其后，浏览器自己会走进去。
  // 容器是 tabindex=0 ⇒ 「Tab 进 L3」落到的就是它（整表没有别的可聚焦东西）。
  // 收起（再按一次 / Esc）时若焦点在这一块里，detachL3 先把它交还给行按钮再删节点 ——
  // 所以「整表无控件」也不会有焦点掉到 body 的那一下。
  function toggleL3(item) {
    const wrap = item.closest(".au-l3row");
    if (wrap === null) return;
    const index = String(item.dataset.row ?? "");
    state.openRow = state.openRow === index && index !== "" ? "" : index;
    syncL3();
  }

  function attachL3(wrap) {
    const existing = wrap.querySelector(":scope > .au-l3");
    if (existing !== null) return existing; // 已经有一份：不重建
    const data = l3Rows.get(wrap);
    if (data === undefined) return null;
    const l3 = l3Of(data.row, data.rowIndex, data.turnIndex);
    wrap.append(l3);
    return l3;
  }

  function detachL3(wrap, item) {
    for (const node of wrap.querySelectorAll(":scope > .au-l3")) {
      // 焦点若在这一块里，先交还给行按钮：删节点会让浏览器把焦点丢到 body。
      if (node.contains(document.activeElement) && item !== null) item.focus();
      node.remove();
    }
  }

  function syncL3() {
    for (const wrap of listHost.querySelectorAll(".au-l3row")) {
      const item = wrap.querySelector(":scope > .au-rowitem");
      if (item === null) continue;
      const open = state.openRow !== "" && String(item.dataset.row ?? "") === state.openRow;
      wrap.classList.toggle("is-open", open);
      if (open) {
        const l3 = attachL3(wrap);
        item.setAttribute("aria-expanded", "true");
        // 与 L2 同一条口径：只有那张表真的在，才把 aria-controls 挂上。
        if (l3 !== null) item.setAttribute("aria-controls", l3.id);
      } else {
        detachL3(wrap, item);
        item.setAttribute("aria-expanded", "false");
        item.removeAttribute("aria-controls");
      }
    }
  }

  // 「按类筛」的那一排：计数与筛选状态都从 state 来，屏上这排数字和筛完的列表长度同源。
  // 计数的口径在 load 里算一次（chips 与主指标出自同一次遍历）。
  function chipItems() {
    const counts = state.counts || {};
    return FILTERS.map((item) => ({
      key: item.key,
      label: item.label,
      count: Number(counts[item.key]) || 0
    }));
  }

  // 分区键：四颗 chip（干活 / 后台 / 提取 / 其它）把整窗的轮**不重不漏**地分完。
  // 计数（load）与筛选（matchesFilter）共用这一个函数 —— 两处一旦各写一遍，就会出现
  // 「chip 上写 127、点进去 126」这种没人认账的差一。
  function bucketKeyOf(turn) {
    return PARTITION.indexOf(turn.bucket) >= 0 ? turn.bucket : "other";
  }

  function matchesFilter(turn) {
    if (state.filter === "all") return true;
    if (state.filter === "needs") return state.needsIndex.has(state.turns.indexOf(turn));
    return bucketKeyOf(turn) === state.filter;
  }

  function filteredTurns() {
    return state.filter === "all" ? state.turns : state.turns.filter(matchesFilter);
  }

  // 点分类 = 换一张表：回第 1 页、收起展开的那一条（它的位置属于旧的那张表）。
  // 主指标那颗数字走的也是这里 —— 于是「点数字」与「点需要看」是同一件事，不可能出现两种结果。
  function pickFilter(key) {
    if (!FILTERS.some((item) => item.key === key) || state.filter === key) return;
    state.filter = key;
    state.page = 0;
    state.open = "";
    state.openRow = "";
    draw();
    chips.sync(chipItems(), state.filter);
    revealActiveChip();
  }

  // 0 计数的分类由组件自己藏起来（app.js:288 的既有规则，对话/待跟进也一样）。
  // 但**正在筛的那一颗不能藏**：否则筛出空表的时候看不出是谁在筛，也看不出怎么回去。
  function revealActiveChip() {
    for (const button of chips.el.querySelectorAll('.filter-chip[aria-pressed="true"]')) button.hidden = false;
  }

  // 换页 = 换一张新表。展开的那一条属于「旧的第 N 页」，跟着留下来就成了错位的注脚
  // （详情里写的是另一轮的工具），所以翻页时一律收起。这一屏同一时刻只有一条展开，
  // 收起的代价是再点一次，留着的代价是读错一轮。L3 跟着一起收（它属于那一行）。
  function turnPage() {
    state.open = "";
    state.openRow = "";
    draw();
  }

  // 展开区按需建、收起即拆（这一屏同一时刻只有一条展开 ⇒ DOM 里最多一份详情）。
  // ARIA 口径（这一轮收口）：**只在目标存在时才挂 aria-controls**。
  // 懒渲染把「收起」从 display:none 变成「从 DOM 里删掉」，那 aria-controls 就不该再指向一个
  // 不存在的 id —— 读屏软件会把一个指向空气的 IDREF 当成「有受控区域」的承诺。于是：
  // 展开那一刻挂上（id 就是刚建出来的那一块），收起那一刻摘掉；aria-expanded 始终在。
  // 这样换来的是：一页多出来的不是 25 份隐藏详情，而是一份；静态文本口径（inspect 的
  // tiny-text 只承认屏上真有的字）也才对得上人眼看到的那一屏。
  function attachDetail(row) {
    const existing = row.querySelector(":scope > .au-detail");
    if (existing !== null) return existing; // 已经有一份：重开一次不重建
    const info = pageTurns.get(String(row.dataset.key || ""));
    if (info === undefined) return null; // 本页没有这一轮（只可能来自过期的 state.open），不硬造
    state.openRow = ""; // 新的一份 L2：里面的 L3 一律从收起开始
    const detail = detailOf(info.turn, info.index);
    const toggle = row.querySelector(".au-toggle");
    if (toggle !== null && toggle.parentElement === row) toggle.after(detail);
    else row.appendChild(detail);
    return detail;
  }

  function detachDetail(row) {
    for (const node of row.querySelectorAll(":scope > .au-detail")) {
      globalThis.EchoBackgroundView.invalidate(node);
      // 焦点若落在这一块里，先交还给行按钮：删节点会让浏览器把焦点丢到 body。
      if (node.contains(document.activeElement)) {
        const toggle = row.querySelector(".au-toggle");
        if (toggle !== null) toggle.focus();
      }
      node.remove();
    }
    state.openRow = ""; // 那一行已经不在屏上了，它的字段表状态也就不成立
  }

  function syncOpen() {
    for (const row of listHost.querySelectorAll(".au-row")) {
      const key = String(row.dataset.key || "");
      const open = key === state.open && pageTurns.has(key);
      row.classList.toggle("is-open", open);
      const toggle = row.querySelector(".au-toggle");
      if (open) {
        const detail = attachDetail(row);
        if (toggle !== null) {
          toggle.setAttribute("aria-expanded", "true");
          // id 用的是**刚建出来的这一块自己的 id**，不是拼出来的字符串：
          // 关联与实际元素同源，拼错的可能就不存在（而且收起时整条属性摘掉，见上）。
          if (detail !== null) toggle.setAttribute("aria-controls", detail.id);
        }
      } else {
        detachDetail(row); // 拆掉即等于清掉上一条注脚：再展开一次是新的
        if (toggle !== null) {
          toggle.setAttribute("aria-expanded", "false");
          toggle.removeAttribute("aria-controls");
        }
      }
    }
  }

  function draw() {
    globalThis.EchoBackgroundView.invalidate(listHost);
    const list = filteredTurns();
    // 页一换，懒渲染的材料就作废：这张表只描述屏上这一页（见 pageTurns）。
    pageTurns = new Map();
    // 整张表重画 ⇒ 屏上任何一份 L3 都没了，它的状态跟着作废（否则 Esc 会先「收」一个不存在的表）。
    state.openRow = "";
    // 翻页器的总数跟着**筛完的**表走；主指标与 needsDetail 仍数整窗（needsDetail 用的是
    // state.turns.length，不读 state.total）。
    state.total = list.length;
    if (state.turns.length === 0) {
      pager.sync(); // total 0 ⇒ 翻页器自己藏起来（app.js:createPager），屏上不留「第 1–0」
      // 两种空要两句话（第 5 步）：一行都没取到 / 取到了却折不出轮。后者带一颗真的重试。
      setState(state.rows === 0
        ? api.states.empty("这窗口里一行审计都没有。")
        : retryableEmpty(`这 ${api.fmt.number(state.rows)} 行折不出轮（缺时间或轮次键）。`));
      return;
    }
    if (list.length === 0) {
      pager.sync();
      setState(api.states.empty(EMPTY_FILTER[state.filter] || "这一类里没有轮。"));
      return;
    }
    const win = pager.sync();
    // 只画当页：翻页是替换，不是往后追加，页高才会落在同一个数上下，而不是一页比一页长。
    const page = list.slice(win.start, win.end);
    // 这一页跨了两天以上才给组头加日期：同一天里十一个组头各带一遍「10 月 25 日」只是噪音。
    const withDate = new Set(page.map((turn) => hourKeyOf(turn.time).day)).size > 1;
    // 先按「日 + 小时」把这一页切成段（列表是倒序时间 ⇒ 段也是倒序的），再逐段画组头 + 轮。
    const groups = [];
    for (const turn of page) {
      const at = hourKeyOf(turn.time);
      const key = `${at.day} ${at.hour}`;
      const last = groups[groups.length - 1];
      if (last !== undefined && last.key === key) last.turns.push(turn);
      else groups.push({ key, day: at.day, hour: at.hour, turns: [turn] });
    }
    const fragment = document.createDocumentFragment();
    // 页内序号：详情与那句说明的 id 用它（一页之内唯一就够），也是懒渲染时回查这一轮的坐标。
    let index = 0;
    for (const group of groups) {
      const header = api.el("p", "au-hour", hourHeaderOf(group, withDate));
      header.dataset.hour = group.key; // 复核脚本按它数组头（组头轮数之和 = 本页轮数）
      fragment.appendChild(header);
      for (const turn of group.turns) {
        const row = buildRow(turn, index);
        pageTurns.set(String(row.dataset.key || ""), { turn, index });
        fragment.appendChild(row);
        index += 1;
      }
    }
    listHost.replaceChildren(fragment);
    listHost.removeAttribute("aria-live"); // 一百七十多行不念，只有三态与那一格数字念
    syncOpen();
  }

  async function load() {
    globalThis.EchoBackgroundView.invalidate(listHost);
    const id = (loadId += 1);
    state.loaded = false; // 占位已替换列表；中途切回也须重读，不能把占位当缓存复用。
    figureValue.textContent = api.missing;
    figureValue.setAttribute("aria-label", "正在读取，需要看的轮数还不知道");
    figureNote.textContent = `正在读取最近 ${api.fmt.number(LIMIT)} 行审计…`;
    pager.el.hidden = true;
    setState(api.states.loading(SKELETON));
    try {
      const payload = await api.audit.read();
      if (id !== loadId) return; // 切走的屏不该把回来的结果画进来
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      bindOwnership(scopeHost.parentElement, api.audit.ownership());
      state.rows = rows.length;
      // 折轮那一支在脏行上会抛（实测：行是 null 时它在读 timestamp 上直接炸）。
      // 那不是「读不到数据」，是「拿到了行但折不出轮」—— 两种话不能混，所以在这里分开接：
      // 折轮抛错 / 折出 0 轮，都进「折不出轮」这一条路（不抛到外面冒充「读失败」）。
      let turns = [];
      let unfoldable = false;
      try {
        turns = auditView().buildTurns(rows); // 折轮只有这一处：产品那份实现
      } catch (error) {
        if (rows.length === 0) throw error; // 空窗口折轮不该抛；真抛了就当读失败，别吞
        unfoldable = true;
        turns = [];
      }
      if (!unfoldable && rows.length > 0 && turns.length === 0) unfoldable = true;
      state.unfoldable = unfoldable;
      // 倒序在装载时排一次就够：列表本身不随翻页重排，轮数才是大数字。
      state.turns = turns.slice().sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
      state.open = "";
      state.openRow = "";
      state.page = 0; // 刷新是一张新表：回到第 1 页，页码不留在旧的位置上
      state.loaded = true;
      loadedScope = api.audit.scope;
      // 主指标：整窗里「需要看」的轮数（不是当页的，也不是行数）。翻页不动它。
      // 同一趟把**每一条标记的理由**攒下来：数字与清单出自同一次遍历，不会一边 11 一边 12。
      // chips 的分区计数也在这一趟里数 —— 屏上的六颗数字与主指标同源，没有第二次遍历。
      const detail = [];
      const counts = { all: state.turns.length, needs: 0, work: 0, machine: 0, reflect: 0, other: 0 };
      const needsIndex = new Set();
      state.turns.forEach((turn, index) => {
        const bucketKey = bucketKeyOf(turn);
        counts[bucketKey] += 1;
        const flag = flagOf(turn);
        if (!flag.slow && !flag.failed) return;
        counts.needs += 1;
        needsIndex.add(index);
        detail.push({
          index, // 它在倒序列表里的位置（第几轮），与翻页器同一个坐标系
          turnKey: String(turn.id || ""),
          at: auditView().msOf(turn.time),
          bucket: turn.bucket,
          slow: flag.slow,
          failed: flag.failed,
          sources: flag.reasons.map((item) => item.source).filter((item, i, all) => all.indexOf(item) === i),
          signals: flag.reasons
        });
      });
      state.counts = counts;
      state.needsIndex = needsIndex;
      state.needs = counts.needs;
      state.needsDetail = detail;
      figureValue.textContent = api.fmt.number(state.needs);
      // aria-label 也得跟着「有轮 / 折不出 / 空窗口」三种说法走：念到「按一下只看需要看的轮」
      // 却没有任何轮可点，是另一种名实不符。
      figureValue.setAttribute("aria-label", state.turns.length === 0
        ? (unfoldable ? "需要看 0 轮（这些行折不出轮）" : "需要看 0 轮（这窗口里没有审计行）")
        : (state.needs === 0
          ? "需要看 0 轮，按一下只看需要看的轮"
          : `需要看 ${api.fmt.number(state.needs)} 轮，按一下只看需要看的轮`));
      figureNote.textContent = figureNoteOf(rows.length, state.turns.length, state.needs, unfoldable);
      chips.sync(chipItems(), state.filter);
      revealActiveChip();
      draw();
    } catch (error) {
      if (id !== loadId || error?.name === "AbortError") return;
      state.loaded = false;
      state.needs = 0;
      state.rows = 0; // 读不到就没有行数可说：复核口不该拿着上一趟的行数
      state.turns = [];
      state.unfoldable = false;
      state.counts = null;
      state.needsIndex = new Set();
      state.needsDetail = []; // 读不到就没有数字，也没有依据 —— 不留上一趟的清单给复核
      figureValue.textContent = api.missing; // 「—」不是 0：读不到与「0 轮需要看」是两件事
      figureValue.setAttribute("aria-label", "读不到需要看的轮数");
      // 小字给状态码或原因（HTTP 500 / 网络没连上 / 折轮脚本没挂上），不贴异常栈。
      figureNote.textContent = `读不到最近 ${api.fmt.number(LIMIT)} 行（${errorReasonOf(error)}）`;
      pager.el.hidden = true;
      chips.sync(chipItems(), state.filter); // 计数归零 ⇒ chips 一并收起，不留上一趟的数字
      const message = error?.name === "AuditScopeError" ? error.message : /EchoAuditView/u.test(String(error?.message || ""))
        ? "折轮那支脚本没加载上，这一屏读不到审计流。"
        : "暂时无法读取审计流。";
      setState(api.states.error(message, () => { load(); }));
    }
  }

  function mount(root, screenApi) {
    api = screenApi;
    if (!built) {
      build(root);
      built = true;
    }
    scopeHost.replaceChildren(api.audit.controls());
    globalThis.EchoBackgroundView.bind(root, api);
    if (state.loaded && loadedScope === api.audit.scope) {
      bindOwnership(root, ownershipContext);
      globalThis.EchoOwnershipView.update(root);
      // 切回来还是原来那一页：页码与展开的那一轮都在 state 上，不重拉、不重排。
      pager.sync();
      chips.sync(chipItems(), state.filter);
      revealActiveChip();
      syncOpen();
      return null;
    }
    return load();
  }

  // 只丢在飞的请求，不清数据：展开的那一轮留在屏自己的 state 上。
  function unmount() {
    api?.audit.cancel();
    stopOwnership();
    loadId += 1;
    globalThis.EchoBackgroundView.invalidate(listHost);
  }

  // 复核口（不上屏）：主指标是怎么数出来的，一次交全 ——
  //   { rows, turns, needs, slowTurns, failedTurns, slowRows, failedRows, detail[] }
  // slowRows / failedRows 是**行级**口径（命中的行数），slowTurns / failedTurns 是**轮级**
  // （被标记的轮数）。§3.2 的主指标用的是轮级，两者在本窗口恰好相等（每一条慢行各自成轮），
  // 但口径不同 —— 行级只是拿来对账，不当主指标用。
  function needsDetail() {
    const slowRows = new Set();
    const failedRows = new Set();
    for (const turn of state.needsDetail) {
      for (const item of turn.signals) {
        // (轮, 轮内第几行) 就是一行：不带 ID，也不怕同一轮两行同名工具被折成一行
        const key = `${item.turnKey}|${item.rowIndex}`;
        if (item.source === "latency") slowRows.add(key);
        else failedRows.add(key);
      }
    }
    return JSON.parse(JSON.stringify({
      rows: state.rows,
      turns: state.turns.length,
      needs: state.needs,
      slowTurns: state.needsDetail.filter((turn) => turn.slow).length,
      failedTurns: state.needsDetail.filter((turn) => turn.failed).length,
      slowRows: slowRows.size,
      failedRows: failedRows.size,
      slowThresholdMs: SLOW_MS,
      detail: state.needsDetail
    }));
  }

  // 复核口（不上屏）：每一轮的一句话落在哪一层 —— 「具体」与「只是工具名」不靠肉眼数。
  //   { turns, concrete, toolOnly, byLayer {her,his,action,tool,bucket}, detail [{key,layer,text}] }
  // concrete = ①她 + ②他 + ③具体动作；toolOnly = ④工具名链 + 兜底的桶名（没有可用的工具名）。
  // 改造前那一版：172 轮里 171 轮是 toolOnly（§5 的实测），这是这一屏最要紧的一个数字。
  function gistAudit() {
    const byLayer = { her: 0, his: 0, action: 0, tool: 0, bucket: 0 };
    const detail = state.turns.map((turn) => {
      const parts = gistPartsOf(turn);
      byLayer[parts.layer] += 1;
      return { key: String(turn.id || ""), layer: parts.layer, text: parts.text };
    });
    return {
      turns: state.turns.length,
      concrete: byLayer.her + byLayer.his + byLayer.action,
      toolOnly: byLayer.tool + byLayer.bucket,
      byLayer,
      detail
    };
  }

  // ---- 只读复核口：把「一轮 → 步骤账本」的纯数据交出去 -------------------------------
  // 边界（零行轮、并行支缺起止时刻、解析不出 stageDetail 的行）用真实窗口很难凑齐，
  // 所以给复核脚本一个**不碰 DOM**的入口，喂合成行进来，断言与屏上同一条判据。
  // 它不写库、不改 state、不上屏；与 gistAudit 同一性质。
  function flowPreview(turnLike) {
    const turn = turnLike && typeof turnLike === "object" ? turnLike : { rows: [] };
    const steps = flowOf(turn);
    return {
      head: flowHeadOf(turn, steps),
      steps: steps.map((step, at) => {
        const detail = sdOf(step.row) || {};
        const begin = Number(detail.beginAt);
        const settle = Number(detail.settleAt);
        const failed = failureOf(step.row);
        return {
          no: step.no,
          name: step.name,
          what: step.what,
          ms: step.ms,
          outsider: step.outsider,
          flags: step.flags.map((flag) => flag.text),
          // 图与时间轴要的东西：真实起止时刻、交给下一步的是什么、失败原因文案、原始阶段名。
          at: Number(step.row && step.row.timestamp) || 0,
          beginAt: Number.isFinite(begin) ? begin : null,
          settleAt: Number.isFinite(settle) ? settle : null,
          transfer: transferOf(step, steps[at + 1]),
          failWhy: failed === null ? "" : failTextOf(step.row),
          rawName: pipeNameOf(step.row)
        };
      })
    };
  }


  // `#/round/<key>` 用的入口：把"这一轮"整块（元信息 / 他说她说 / 步骤 / L3 开关）挂进容器。
  // 与列表里展开的是**同一份渲染**，所以两处永远一致；round 视图只负责取数、找轮、定位标题。
  function renderTurn(container, turnLike, index, injectedApi, options = {}) {
    const turn = turnLike && typeof turnLike === "object" ? turnLike : { rows: [] };
    // 别的视图（#/round/<key>）借用这套渲染时，没有走过本屏的 mount，模块级的 `api` 还是 null。
    // 用调用方注入的 api 临时顶一下，退出时还原 —— 不把壳的依赖偷偷塞进全局。
    const previous = api;
    if (injectedApi && typeof injectedApi.el === "function") api = injectedApi;
    try {
      container.appendChild(detailOf(turn, typeof index === "number" ? index : 0, options.background !== false));
      return true;
    } finally {
      api = previous;
    }
  }

  // 图形层的入口（`#/round/<key>` 只走这两个，不碰本屏的 state / DOM）：
  //   graphOf —— 这一轮的节点/边/窗口（纯数据 + 成句的文字）；
  //   l3For   —— 一行那 21 个键的字段表（文字明细里点开时现造，与列表同一份 l3Of）。
  // 两个都临时注入调用方的 api：别的视图没走过本屏 mount，模块级的 `api` 是 null。
  function withApi(injectedApi, run) {
    const previous = api;
    if (injectedApi && typeof injectedApi.el === "function") api = injectedApi;
    try {
      return run();
    } finally {
      api = previous;
    }
  }

  function graphOf(turnLike, injectedApi) {
    const turn = turnLike && typeof turnLike === "object" ? turnLike : { rows: [] };
    return withApi(injectedApi, () => flowGraphOf(turn));
  }

  // 这一轮「他说的」「她说的」两段正文（全文，已剥信封与 markdown）：整页顶部要直接读到它们 ——
  // 她说了什么不该藏在悬停或折叠项里。取文本的仍是 hisSaidOf / herSaidOf，与列表那一份同源。
  function saidOf2(turnLike, injectedApi) {
    const turn = turnLike && typeof turnLike === "object" ? turnLike : { rows: [] };
    return withApi(injectedApi, () => ({
      his: hisSaidOf(turn),
      her: herSaidOf(turn)
    }));
  }

  function l3For(row, rowIndex, turnIndex, injectedApi) {
    return withApi(injectedApi, () => l3Of(row, rowIndex, turnIndex));
  }

  return { mount, unmount, refresh: load, needsDetail, gistAudit, flowPreview, roundKeyOf, renderTurn, graphOf, l3For, saidOf2 };
})();
