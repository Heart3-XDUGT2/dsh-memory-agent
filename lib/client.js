/**
 * dsh-echo — 静态 Client 半区(浏览器)
 * ============================================================
 * 标准 dsh 客户端模块格式:window.__ModuleLoader__.load({ id, factory })。
 * 通过 package.json 的 dsh.client 声明 + exports["./client"] 被发现,
 * 由 dsh-client-modules 扫描加载 —— 重启后 UI 永久存在。
 *
 * 职责:在设置区(settings.section)注册专属「Echo」面板 —— 只放「在里面才顺手」
 * 的东西:电源开关、**子代理记忆工具开关(2026-10-01 阶段 2f:他的裁定「网页上
 * 也该能改」)**、状态仪表盘、想念值、情绪历史、
 * 人格编辑器(前后两段双栏,POST /api/echo/persona,保存后下一轮生效)、
 * 危险区(整库清空),以及一张「打开审查台」的跳板。
 *
 * 2026-09-26 他的裁定(两批):
 *   ① **六个看板撤出设置区** —— 记忆图谱 / 悬置话题 / 对话回放 / 记忆管理 /
 *      记忆体检 / 她的日记,以后用网页仪表盘(插件静态页 /echo/)看。那六张卡
 *      连同它们的 SVG 力导向布局、DMAE 三态、话题四态、回放分页一起删了。
 *   ② **审计流也撤**,**调参搬去网页** —— 调参是 51 项配置面(字段表在
 *      lib/settings-fields.js,由 /api/echo/settings 一并发给前端,
 *      web/app.js 照着渲染;这里不再有第二份字段表)。
 * 端点一个没删:POST /api/echo/* 全在,网页仪表盘用的就是同一批。
 *   ③ 2026-09-29 他的裁定:**「会话范围」卡撤出设置区** —— 卡的读写在
 *      `/api/echo/scope`(端点、审查台那栏、会话角落的开关都留着),后端闸
 *      一行没动;撤的只是设置区里那张卡。
 *
 * CSS 使用 --dsw-alias-* 产品变量,自动跟随 light/dark 主题。
 */
window.__ModuleLoader__.load({
	id: "dsh-echo",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let React = require("react");

		//#region css(主题令牌=产品变量+规格fallback)
		const css = [
			// 2026-09-29 深色模式修复(他的报告:「切深色按钮一片空白 / 空白位置挺多」)。
			// 三处成因,全是「同一元素的两个颜色只跟了一半主题」:
			//   ① primary 按钮的填充 brand-primary 在深色下是**近白**
			//      (浅 #0f1115 / 深 #f9fafb),而文字写死 #FFFFFF ⇒ 深色白字白底=全空。
			//      改用 --dsw-alias-label-primary-foreground —— 它正是 brand-primary
			//      的对比色(浅 #fff / 深 #0f1115),DSH 自己的按钮就是这么配的。
			//   ② .echo-badge/.echo-chip/.echo-audit-new/.echo-ev-chip 用的
			//      --dsw-alias-interactive-bg-hover-info 在 DSH 主题表里**根本不存在**
			//      (只有 ...-hover / -hover-accent / -hover-danger / -hover-solid),
			//      于是兜底 #EFF4FF(浅蓝)生效 ⇒ 深色下浅底浅字=空白。
			//      换成真实存在的一对:bg --dsw-alias-state-business-tertiary,
			//      前景 --dsw-alias-state-business-primary。
			//   ③ --dsw-alias-state-info-primary 同样不存在 ⇒ 用 state-business-primary。
			".echo-page{max-width:860px;margin:0 auto;padding:8px 4px 32px;display:flex;flex-direction:column;gap:16px;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif;color:var(--dsw-alias-label-primary,#1F2329)}",
			".echo-card{box-sizing:border-box;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,#E5E7EB);background:var(--dsw-alias-bg-layer-2,#FFFFFF);padding:16px 18px}",
			".echo-card-title{font-size:14px;font-weight:600;margin:0 0 4px}",
			".echo-card-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#6B7280);margin:0 0 14px;line-height:18px}",
			".echo-field-label{display:flex;align-items:baseline;justify-content:space-between;margin:0 0 6px}",
			".echo-field-name{font-size:12.5px;font-weight:600}",
			".echo-field-count{font-size:11px;color:var(--dsw-alias-label-tertiary,#9CA3AF);font-family:\"SF Mono\",\"JetBrains Mono\",Consolas,monospace}",
			".echo-field-count.echo-over{color:var(--dsw-alias-state-error-primary,#DC2626);font-weight:600}",
			".echo-textarea{box-sizing:border-box;width:100%;min-height:150px;resize:vertical;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#E5E7EB);background:var(--dsw-alias-bg-layer-1,#FAFBFC);color:var(--dsw-alias-label-primary,#1F2329);font-size:12.5px;line-height:20px;font-family:inherit;outline:none}",
			".echo-textarea:focus{border-color:var(--dsw-alias-brand-primary,#2563EB)}",
			".echo-actions{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:14px}",
			".echo-btn{height:30px;padding:0 14px;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit}",
			".echo-btn:disabled{opacity:.55;cursor:not-allowed}",
			".echo-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary,#6B7280);border:1px solid var(--dsw-alias-border-l1,#E5E7EB)}",
			".echo-btn-ghost:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary,#DC2626);color:var(--dsw-alias-state-error-primary,#DC2626)}",
			".echo-btn-primary{background:var(--dsw-alias-brand-primary,#2563EB);color:var(--dsw-alias-label-primary-foreground,#FFFFFF);border:none;font-weight:600}",
			".echo-btn-primary:hover:not(:disabled){filter:brightness(.92)}",
			".echo-feedback{font-size:12px;margin-left:auto;margin-right:10px}",
			".echo-feedback-ok{color:var(--dsw-alias-state-success-primary,#16A34A);font-weight:600}",
			".echo-feedback-err{color:var(--dsw-alias-state-error-primary,#DC2626);font-weight:600}",
			".echo-feedback-dirty{color:var(--dsw-alias-state-warn-primary,#D97706)}",
			".echo-kv{display:grid;grid-template-columns:150px 1fr;row-gap:8px;column-gap:12px;font-size:12.5px}",
			".echo-kv-key{color:var(--dsw-alias-label-secondary,#6B7280)}",
			".echo-kv-val{font-family:\"SF Mono\",\"JetBrains Mono\",Consolas,monospace;font-size:12px;word-break:break-all}",
			".echo-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:var(--dsw-alias-state-business-tertiary,#EFF4FF);color:var(--dsw-alias-state-business-primary,#2563EB);margin-left:8px;vertical-align:1px}",
			".echo-power-row{display:flex;align-items:center;gap:10px}",
			".echo-power-dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary,#16A34A)}",
			".echo-power-dot.echo-power-off{background:var(--dsw-alias-label-tertiary,#9CA3AF)}",
			".echo-power-state{font-size:13px;font-weight:600}",
			".echo-power-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#6B7280)}",
			".echo-loading{font-size:12.5px;color:var(--dsw-alias-label-tertiary,#9CA3AF);padding:8px 0}",
			".echo-num-big{font-size:34px;font-weight:700;font-family:\"SF Mono\",\"JetBrains Mono\",Consolas,monospace;line-height:1.1}",
			".echo-bar{position:relative;height:10px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,#FAFBFC);border:1px solid var(--dsw-alias-border-l1,#E5E7EB);overflow:hidden}",
			".echo-bar-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:var(--dsw-alias-state-error-primary,#DC2626);transition:width .6s ease}",
			".echo-bar-mark{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--dsw-alias-label-secondary,#6B7280)}",
			".echo-hbar{display:flex;height:12px;border-radius:6px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1,#E5E7EB)}",
			".echo-hbar-seg-active{background:var(--dsw-alias-state-success-primary,#16A34A)}",
			".echo-hbar-seg-dormant{background:var(--dsw-alias-state-warn-primary,#D97706)}",
			".echo-hbar-seg-archived{background:var(--dsw-alias-label-tertiary,#9CA3AF)}",
			".echo-chip{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;background:var(--dsw-alias-state-business-tertiary,#EFF4FF);color:var(--dsw-alias-label-secondary,#6B7280);margin:2px 4px 2px 0;cursor:pointer}",
			".echo-chip-on{background:var(--dsw-alias-state-business-primary,#2563EB);color:var(--dsw-alias-label-primary-foreground,#FFFFFF)}",
			".echo-thread-item{padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-l1,#E5E7EB);font-size:12.5px;display:flex;justify-content:space-between;gap:12px}",
			".echo-thread-item:last-child{border-bottom:none}",
			".echo-thread-meta{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#9CA3AF);font-family:\"SF Mono\",\"JetBrains Mono\",Consolas,monospace}",
			".echo-group-title{font-size:12px;font-weight:600;margin:10px 0 2px;color:var(--dsw-alias-label-secondary,#6B7280)}",
			".echo-audit-item{padding:8px 0;border-bottom:1px dashed var(--dsw-alias-border-l1,#E5E7EB);font-size:12.5px}",
			".echo-audit-item:last-child{border-bottom:none}",
			".echo-audit-new{background:var(--dsw-alias-state-business-tertiary,#EFF4FF);border-radius:6px;padding:8px 6px}",
			".echo-audit-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#9CA3AF);font-family:\"SF Mono\",\"JetBrains Mono\",Consolas,monospace;margin-bottom:2px}",
			".echo-graph-svg{width:100%;height:auto;display:block}",
			".echo-legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#6B7280)}",
			".echo-legend-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:-1px}",
			".echo-mem-item{padding:10px 0;border-bottom:1px dashed var(--dsw-alias-border-l1,#E5E7EB);font-size:12.5px}",
			".echo-mem-item:last-child{border-bottom:none}",
			".echo-mem-summary{font-size:13px;line-height:19px;margin-bottom:2px;word-break:break-all}",
			".echo-mem-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#9CA3AF);font-family:\"SF Mono\",\"JetBrains Mono\",Consolas,monospace;margin:4px 0}",
			".echo-mem-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}",
			".echo-mem-btn{height:24px;padding:0 10px;border-radius:5px;font-size:11px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary,#6B7280);border:1px solid var(--dsw-alias-border-l1,#E5E7EB);font-family:inherit}",
			".echo-mem-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#2563EB);color:var(--dsw-alias-brand-primary,#2563EB)}",
			".echo-mem-btn:disabled{opacity:.5;cursor:not-allowed}",
			".echo-mem-btn-danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary,#DC2626);color:var(--dsw-alias-state-error-primary,#DC2626)}",
			".echo-mem-form{margin-top:8px;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#FAFBFC);border:1px solid var(--dsw-alias-border-l1,#E5E7EB)}",
			".echo-input,.echo-select{height:28px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#E5E7EB);background:var(--dsw-alias-bg-layer-1,#FAFBFC);color:var(--dsw-alias-label-primary,#1F2329);font-size:12px;font-family:inherit;outline:none}",
			".echo-input:focus,.echo-select:focus{border-color:var(--dsw-alias-brand-primary,#2563EB)}",
			".echo-mem-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}",
			".echo-pager{display:flex;align-items:center;gap:8px;justify-content:center;margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#6B7280)}",
			// v0.16.0 M1/M5 图谱依据下钻:命中层 + 「依据」面板 + 原话气泡
			".echo-graph-hit{stroke:transparent;stroke-width:12;fill:none;cursor:pointer}",
			".echo-graph-node{cursor:pointer}",
			// 圆环=现算激活度。用 class 而不是给 stroke 属性塞 var(...) ——
			// 呈现属性(presentation attribute)不解析 var(),塞进去会被整条
			// 忽略、描边直接消失;class 里的 var() 才真的按主题走。
			".echo-graph-ring-ok{stroke:var(--dsw-alias-state-success-primary,#16A34A)}",
			".echo-graph-ring-warn{stroke:var(--dsw-alias-state-warn-primary,#D97706)}",
			".echo-graph-ring-old{stroke:var(--dsw-alias-label-tertiary,#9CA3AF)}",
			".echo-ev-panel{margin-top:10px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#FAFBFC);border:1px solid var(--dsw-alias-border-l1,#E5E7EB)}",
			".echo-ev-title{font-size:12.5px;font-weight:600}",
			".echo-ev-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#9CA3AF);font-family:\"SF Mono\",\"JetBrains Mono\",Consolas,monospace;margin-top:4px;line-height:16px}",
			".echo-ev-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}",
			".echo-ev-chip{height:22px;padding:0 9px;border-radius:999px;font-size:11px;cursor:pointer;font-family:\"SF Mono\",\"JetBrains Mono\",Consolas,monospace;background:var(--dsw-alias-state-business-tertiary,#EFF4FF);color:var(--dsw-alias-state-business-primary,#2563EB);border:1px solid var(--dsw-alias-border-l1,#E5E7EB)}",
			".echo-ev-chip:hover{border-color:var(--dsw-alias-brand-primary,#2563EB)}",
			".echo-ev-chip.echo-ev-chip-on{background:var(--dsw-alias-brand-primary,#2563EB);color:var(--dsw-alias-label-primary-foreground,#FFFFFF)}",
			".echo-ev-mem{margin-top:8px;padding:8px 10px;border-radius:0 6px 6px 0;border-left:3px solid var(--dsw-alias-brand-primary,#2563EB);background:var(--dsw-alias-bg-layer-2,#FFFFFF)}",
			".echo-ev-mem-sum{font-size:12.5px;line-height:19px;word-break:break-all}",
			".echo-ev-mem-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#9CA3AF);font-family:\"SF Mono\",\"JetBrains Mono\",Consolas,monospace;margin-top:4px}",
			".echo-ev-dead{color:var(--dsw-alias-state-error-primary,#DC2626);font-weight:600}",
			".echo-ev-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9CA3AF);margin-top:6px;line-height:17px}",
			// 会话角落开关(v0.30.0):会话页头部右对齐的一枚小按钮。
			".echo-sess-btn{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#E5E7EB);background:transparent;color:var(--dsw-alias-label-secondary,#6B7280);font-size:11.5px;font-family:inherit;cursor:pointer;white-space:nowrap}",
			".echo-sess-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#2563EB);color:var(--dsw-alias-brand-primary,#2563EB)}",
			".echo-sess-btn:disabled{opacity:.55;cursor:not-allowed}",
			".echo-sess-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary,#16A34A)}",
			".echo-sess-btn.echo-sess-off{color:var(--dsw-alias-label-tertiary,#9CA3AF)}",
			".echo-sess-btn.echo-sess-off .echo-sess-dot{background:var(--dsw-alias-label-tertiary,#9CA3AF)}",
			".echo-sess-btn.echo-sess-master-off{border-style:dashed;color:var(--dsw-alias-state-warn-primary,#D97706)}",
			".echo-sess-btn.echo-sess-master-off .echo-sess-dot{background:var(--dsw-alias-state-warn-primary,#D97706)}"
		].join("\n");
		const cssTagId = "echo-panel-css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + cssTagId + "\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-echo";
			tag.dataset.pluginCss = cssTagId;
			tag.textContent = css;
			document.head.append(tag);
		}
		//#endregion

		//#region 数据通道(同源 fetch + SSE 半推)
		async function fetchJson(path, options) {
			const res = await fetch(path, options);
			if (!res.ok) throw new Error("HTTP " + res.status);
			return res.json();
		}

		// SSE 事件通道(M3-c):面板级单例,卡与卡共享一条连接。
		// 断线由浏览器 EventSource 内建自动重连;订阅失败(老宿主/
		// 非浏览器环境)静默降级 —— 轮询兜底本来就在,推送只是让
		// 刷新从「下一轮轮询」变成「此刻」。
		let echoEventSource = null;
		function subscribeEchoEvent(name, handler) {
			try {
				if (echoEventSource === null && typeof EventSource === "function") {
					echoEventSource = new EventSource("/api/echo/events");
				}
				if (echoEventSource === null) return () => { };
				echoEventSource.addEventListener(name, handler);
				return () => echoEventSource.removeEventListener(name, handler);
			} catch {
				return () => { };
			}
		}
		//#endregion

		//#region 电源卡(v0.2.1:一键休眠/唤醒,下一轮对话即生效)
		// 2026-09-26 现场(他:「你应该搞一个硬性的按钮出来」):这张卡就是那个
		// 按钮 —— 但它以前只显示「在线/休眠」,不显示**谁拨的、什么时候拨的**,
		// 也不显示分闸状态。现在两样都摊开:总闸 + 硬关名单 + 每会话开关。
		function PowerCard() {
			const [enabled, setEnabledState] = React.useState(null);
			const [power, setPower] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState("");

			React.useEffect(() => {
				let alive = true;
				fetchJson("/api/echo/status").then((data) => {
					if (!alive) return;
					setEnabledState(data.enabled !== false);
					setPower(data.power || null);
				}).catch((err) => alive && setError(String(err?.message ?? err)));
				return () => { alive = false; };
			}, []);

			async function flip() {
				if (enabled === null || busy) return;
				setBusy(true);
				try {
					const data = await fetchJson("/api/echo/toggle", {
						method: "POST",
						headers: { "content-type": "application/json", "x-echo-edit": "1" },
						body: JSON.stringify({ enabled: !enabled })
					});
					setEnabledState(data.enabled !== false);
					setPower({ enabled: data.enabled !== false, by: data.by || "panel", at: data.at || 0 });
				} catch (err) {
					setError(String(err?.message ?? err));
				} finally {
					setBusy(false);
				}
			}

			const when = (t) => {
				if (!t) return "";
				try { return new Date(t * 1000).toLocaleString(); } catch { return ""; }
			};

			if (error !== "") return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, "电源"),
				React.createElement("div", { className: "echo-loading" }, "加载失败: " + error));

			if (enabled === null) return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, "电源"),
				React.createElement("div", { className: "echo-loading" }, "加载中…"));

			const by = power && power.by ? power.by : "";
			const at = power && power.at ? when(power.at) : "";
			return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, "电源"),
				React.createElement("div", { className: "echo-power-row" },
					React.createElement("span", { className: "echo-power-dot" + (enabled ? "" : " echo-power-off") }),
					React.createElement("span", { className: "echo-power-state" }, enabled ? "在线" : "休眠"),
					React.createElement("span", { className: "echo-power-hint" },
						enabled ? "注入人格与记忆,记录你们说的话" : "不注入、不记录 —— 她在睡觉,没在偷听"),
					React.createElement("div", { style: { marginLeft: "auto" } },
						React.createElement("button", {
							className: "echo-btn " + (enabled ? "echo-btn-ghost" : "echo-btn-primary"),
							disabled: busy, onClick: flip
						}, busy ? "切换中…" : (enabled ? "让她休眠" : "唤醒她")))),
				by !== "" ? React.createElement("div", { className: "echo-card-sub", style: { marginTop: "6px" } },
					"上一次拨动:" + (by === "panel" ? "面板" : by === "tool" ? "她自己(工具)" : by === "marker" ? "会话里的标记短语" : by)
					+ (at !== "" ? " · " + at : "")) : null);
		}
		//#endregion


		//#region 子代理记忆工具开关(v0.41.0 阶段 2f:网页上也能改)
		// 他的裁定(2026-10-01):「`memorySubagentTools` 的 true/false **应当也能在网页
		// 仪表盘里改**才对。」以前只能手改 `$DSH_HOME/profiles/web/cordis.patch.yml`。
		//
		// 这张卡就是那个开关(端点 `GET/POST /api/echo/memory-tools`)。三件事必须一起
		// 说清,少一件这张卡就是个骗人的按钮:
		//   ① **现状 + 来源**:开/关,以及是哪一路把它打开的(env / 宿主配置 / 插件设置);
		//   ② **拨了立即生效**:POST 里当场重算并注册/摘除那 4 个只读工具(不用重启宿主);
		//   ③ **真挂上了没有**(`applied`):开关开着但记忆库离线时照实显示"没挂上"。
		//
		// 为什么落盘不走调参那一面:那不是调参项,是**开关**;详见 lib/toggle.js
		// `readMemoryTools()` 上方,以及 lib/index.js 的 4b2 段。
		function MemoryToolsCard() {
			const [state, setState] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState("");
			const [note, setNote] = React.useState("");

			React.useEffect(() => {
				let alive = true;
				fetchJson("/api/echo/memory-tools").then((data) => {
					if (!alive) return;
					setState(data);
				}).catch((err) => alive && setError(String(err?.message ?? err)));
				return () => { alive = false; };
			}, []);

			async function flip() {
				if (state === null || busy) return;
				setBusy(true);
				setNote("");
				try {
					const data = await fetchJson("/api/echo/memory-tools", {
						method: "POST",
						headers: { "content-type": "application/json", "x-echo-edit": "1" },
						body: JSON.stringify({ enabled: state.panelValue !== true })
					});
					setState(data);
					setNote(data.applied === true
						? ("已生效:" + String(data.registered) + " 个只读工具现在就挂在子代理那一轮上。")
						: (data.on === true
							? ("已落盘,但**没挂上**(原因:" + String(data.reason || "?") + ")—— 状态栏照实显示。")
							: "已落盘:关。4 个工具已摘除,子代理那一轮又是零工具。"));
				} catch (err) {
					setError(String(err?.message ?? err));
				} finally {
					setBusy(false);
				}
			}

			if (error !== "") return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, "子代理记忆工具"),
				React.createElement("div", { className: "echo-loading" }, "加载失败: " + error));

			if (state === null) return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, "子代理记忆工具"),
				React.createElement("div", { className: "echo-loading" }, "加载中…"));

			const on = state.on === true;
			const checked = state.panelValue === true;
			const src = state.sources || {};
			const whyOff = on ? "" : (src.env === true || src.config === true
				? "" : (state.storeOnline === false ? "(记忆库离线)" : ""));
			return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, "子代理记忆工具"),
				React.createElement("p", { className: "echo-card-sub" },
					"给子代理那一轮挂 4 个**只读**记忆工具(memory_search / memory_get / memory_neighbors / memory_timeline)。默认关。"),
				React.createElement("div", { className: "echo-power-row" },
					React.createElement("input", {
						type: "checkbox", id: "echo-memory-tools", checked,
						disabled: busy, onChange: flip
					}),
					React.createElement("label", { htmlFor: "echo-memory-tools", className: "echo-power-state" },
						"给子代理开只读记忆工具"),
					React.createElement("span", { className: "echo-power-hint" },
						on
							? ("现在:开 · 来源:" + String(state.sourceLabel || state.source || ""))
							: ("现在:关" + whyOff)),
					React.createElement("div", { style: { marginLeft: "auto" } },
						React.createElement("button", {
							className: "echo-btn " + (on ? "echo-btn-ghost" : "echo-btn-primary"),
							disabled: busy, onClick: flip
						}, busy ? "切换中…" : (on ? "关掉它" : "打开它")))),
				// ⑶ 真实状态:开关开着 ≠ 挂上了(记忆库离线 / 注册抛错都会落到这一行)
				on === true
					? React.createElement("div", { className: "echo-card-sub", style: { marginTop: "6px" } },
						state.applied === true
							? ("已注册 " + String(state.registered) + "/" + String((state.toolNames || []).length) + " 个工具 · 拨动**立即生效**(不用重启宿主)。")
							: ("开关是开的,但**没挂上**(原因:" + String(state.reason || "未知") + ")。"))
					: null,
				// ① 三路各是什么 —— 「为什么现在是开」要一眼看得出
				React.createElement("div", { className: "echo-card-sub", style: { marginTop: "6px" } },
					"三路读数 —— env:" + (src.env === true ? "开" : "关")
					+ " · 宿主配置(cordis.patch.yml):" + (src.config === true ? "开" : "关")
					+ " · 插件设置(本页开关):" + (src.settings === true ? "开" : "关")),
				// ★ 2026-10-01 尾:「谁在什么时候拨的」—— 事故驱动(2026-10-01 21:33 这个键
				// 曾是 true 而谁也说不清是哪只手,见 lib/toggle.js 上方那段记录)。
				// 老配置没有这对字段 ⇒ 如实显示「没记来源」,不猜。
				React.createElement("div", { className: "echo-card-sub", style: { marginTop: "6px" } },
					"开关留痕:" + String(state.flipLabel === undefined || state.flipLabel === "" ? "(没记来源)" : state.flipLabel)),
				React.createElement("div", { className: "echo-card-sub", style: { marginTop: "6px" } },
					"⚠️ 打开时**主会话也会看到**这 4 个工具 —— 宿主的 toolFilter 是 restrict 语义(只能从继承来的工具面里拿掉),没有「只给某个子代理注册」的原语。"),
				note !== "" ? React.createElement("div", { className: "echo-card-sub", style: { marginTop: "6px" } }, note) : null);
		}
		//#endregion


		//#region 自动挖影子边开关(阶段 4:同一个范式,消费者在引擎侧)
		// 他的裁定(2026-10-01):「把"运行时自动挖边"也做成能在网页仪表盘拨、拨了立即生效
		// 的开关(默认关,不改任何现有行为)。」
		//
		// 与隔壁那张「子代理记忆工具」卡的差别只有一个,但很关键:
		//   · 隔壁的消费者**在壳里**(挂/摘 4 个工具)⇒ POST 里要当场注册/摘除;
		//   · 这张的消费者是 **Python 引擎**(`worker.py` 的 graph_learn → 闸门 →
		//     写 `graph_shadow_edges`),壳侧**没有东西要挂** ⇒ 落盘就是全部动作,
		//     "立即生效"靠引擎**每帧现读** `$DSH_HOME/echo/config.json`(不缓存)。
		//
		// 三件事照隔壁那张卡说清(少一件就是个骗人的按钮):
		//   ① 现状 + 来源(env / 宿主配置 / 插件设置,三路各报各的);
		//   ② 拨了**下一帧**就生效(不重启、不热重载);
		//   ③ 显眼的风险提示 + 一行回退。默认关 ⇒ 关着时引擎连库都不读。
		function GraphGateCard() {
			const [state, setState] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState("");
			const [note, setNote] = React.useState("");

			React.useEffect(() => {
				let alive = true;
				fetchJson("/api/echo/graph-gate").then((data) => {
					if (!alive) return;
					setState(data);
				}).catch((err) => alive && setError(String(err?.message ?? err)));
				return () => { alive = false; };
			}, []);

			async function flip() {
				if (state === null || busy) return;
				setBusy(true);
				setNote("");
				try {
					const data = await fetchJson("/api/echo/graph-gate", {
						method: "POST",
						headers: { "content-type": "application/json", "x-echo-edit": "1" },
						body: JSON.stringify({ enabled: state.panelValue !== true })
					});
					setState(data);
					setNote(data.panelValue === true
						? "已落盘:开。引擎**下一帧**挖边时就认这个值(不用重启;只写 graph_shadow_edges,现有读口看不见)。"
						: "已落盘:关。引擎下一帧起就不再挖边(一条都不写),影子表里已有的边不会被动。");
				} catch (err) {
					setError(String(err?.message ?? err));
				} finally {
					setBusy(false);
				}
			}

			const title = "自动挖影子边";
			if (error !== "") return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, title),
				React.createElement("div", { className: "echo-loading" }, "加载失败: " + error));

			if (state === null) return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, title),
				React.createElement("div", { className: "echo-loading" }, "加载中…"));

			const on = state.on === true;
			const checked = state.panelValue === true;
			const src = state.sources || {};
			return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, title),
				React.createElement("p", { className: "echo-card-sub" },
					"每写一条新记忆就自动挖影子边(同记忆共现 → 过 R1–R6 去噪 → 落 graph_shadow_edges)。默认关。"),
				React.createElement("div", { className: "echo-power-row" },
					React.createElement("input", {
						type: "checkbox", id: "echo-graph-gate", checked,
						disabled: busy, onChange: flip
					}),
					React.createElement("label", { htmlFor: "echo-graph-gate", className: "echo-power-state" },
						"每写一条新记忆就自动挖影子边"),
					React.createElement("span", { className: "echo-power-hint" },
						on
							? ("现在:开 · 来源:" + String(state.sourceLabel || state.source || ""))
							: "现在:关"),
					React.createElement("div", { style: { marginLeft: "auto" } },
						React.createElement("button", {
							className: "echo-btn " + (on ? "echo-btn-ghost" : "echo-btn-primary"),
							disabled: busy, onClick: flip
						}, busy ? "切换中…" : (on ? "关掉它" : "打开它")))),
				// ① 三路各是什么 —— 「为什么现在是开」要一眼看得出
				React.createElement("div", { className: "echo-card-sub", style: { marginTop: "6px" } },
					"三路读数 —— env:" + (src.env === true ? "开" : "关")
					+ " · 宿主配置(cordis.patch.yml):" + (src.config === true ? "开" : "关")
					+ " · 插件设置(本页开关):" + (src.settings === true ? "开" : "关")),
				// ★ 2026-10-01 尾:「谁在什么时候拨的」(与隔壁那张卡同一对来源标记)。
				React.createElement("div", { className: "echo-card-sub", style: { marginTop: "6px" } },
					"开关留痕:" + String(state.flipLabel === undefined || state.flipLabel === "" ? "(没记来源)" : state.flipLabel)),
				// ② 拨一下立即生效(机制:引擎每帧现读这个文件,不是承诺)
				React.createElement("div", { className: "echo-card-sub", style: { marginTop: "6px" } },
					"拨一下**立即生效**:引擎每一帧都现读这个开关(不缓存)⇒ 不用重启宿主,也不用热重载。"),
				// ③ 风险提示(**显眼**,与隔壁那张卡的 ⚠️ 同一位置)
				React.createElement("div", { className: "echo-card-sub", style: { marginTop: "6px" } },
					"⚠️ 打开后,每写一条新记忆都会往 graph_shadow_edges 写边(对现有读口仍不可见,可随时关 / 可一行清空:DELETE FROM graph_shadow_edges)。"),
				note !== "" ? React.createElement("div", { className: "echo-card-sub", style: { marginTop: "6px" } }, note) : null);
		}
		//#endregion


		//#region 会话角落开关(v0.30.0:他的裁定「每一个会话的页面的一个角落里面加上一个
		// echo 开启或者关闭的小按钮」)
		// 位置:`conversation.session.header.utilities` —— 会话页头部右对齐的一排按钮
		// (open-in-app / 后台任务 / 会话日志都挂这儿)。**不挂 corner 座位**:那个是
		// `kind: single`,右侧栏的展开按钮已经坐着,占它会把人家挤掉。
		//
		// 会话 id 从插槽 props 直接来(`sessionId`,session 作用域的标准 kit 每个席位
		// 都发),不用猜 URL、不用问后端 —— 按钮天生知道「我在哪个会话里」。
		//
		// 三态(读 /api/echo/scope 那份事实 —— 设置区那张范围卡 2026-09-29 已撤,
		// 这里现在是这套闸唯一的 UI):
		//   总闸关   → 整条虚线橙,点了提示「总闸关着」——**不假装能开**(会话闸开不了总闸)
		//   会话关   → 灰点「Echo 已关」,点一下上线
		//   会话开   → 绿点「Echo」,点一下下线
		// 写走已有的 POST /api/echo/scope { sessionId, on } —— 后端一行没改。
		function SessionToggleButton({ sessionId }) {
			const [data, setData] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [failed, setFailed] = React.useState(false);

			const load = React.useCallback(() => {
				fetchJson("/api/echo/scope")
					.then((d) => { setData(d); setFailed(false); })
					.catch(() => setFailed(true));
			}, []);
			React.useEffect(() => { load(); }, [load]);

			// 别的窗口/面板拨了开关,这里跟着变 —— 复用面板级那条 SSE。
			// 事件名是 `audit`(服务端 events.js 只发这一个;拨开关会写审计行,
			// 所以它一定会来)。**不是** `echo` —— 那个名字服务端从没发过,
			// 订阅它等于静默失效(EventSource 对未知事件名不报错)。
			React.useEffect(() => subscribeEchoEvent("audit", () => load()), [load]);

			if (failed || data === null || !sessionId) return null;
			// ★ 2026-10-25(第二拍,docs/bug-echo-new-session-default.md §5.1):**子代理会话不画这个按钮**。
			//   它本来就不在开关名单里(`session/created` 对子代理提前 return),而后端
			//   `sessionEnabled()` 也已判它「关」⇒ 这里画出来的只是一颗**假开关**:
			//   绿点「Echo」,点一下什么也不会变(他最讨厌的就是这个)。
			//   两道判据与后端**同源**,前端不重写:名单(/scope 回的 `subagents`)+
			//   id 形态(`subagentIdShape` 就是 lib/agent-scope.js 的 SUBAGENT_ID_PATTERN 原文)。
			const subIds = data.subagents || [];
			const subShape = typeof data.subagentIdShape === "string" ? data.subagentIdShape : "";
			const subagentSession = subIds.indexOf(sessionId) !== -1
				|| (subShape !== "" && new RegExp(subShape).test(sessionId));
			if (subagentSession) return null;
			const scope = data.scope === "whitelist" ? "whitelist" : "all";
			const on = scope === "whitelist"
				? (data.whitelist || []).indexOf(sessionId) !== -1
				: (data.exempt || []).indexOf(sessionId) === -1;
			const hardOff = (data.manualOff || []).indexOf(sessionId) !== -1;
			// 总闸:data.power 由 /api/echo/scope 一并带回(没有就当在线,老后端兼容)
			const masterOff = data.power !== undefined && data.power !== null && data.power.enabled === false;

			async function flip() {
				if (busy) return;
				setBusy(true);
				try {
					const d = await fetchJson("/api/echo/scope", {
						method: "POST",
						headers: { "content-type": "application/json", "x-echo-edit": "1" },
						body: JSON.stringify({ sessionId, on: !on })
					});
					setData(d);
				} catch { /* 失败就保持原样,下一次 SSE/重挂载会纠正 */ } finally {
					setBusy(false);
				}
			}

			const cls = "echo-sess-btn"
				+ (masterOff ? " echo-sess-master-off" : (on ? "" : " echo-sess-off"));
			const label = masterOff ? "Echo 总闸关" : (on ? "Echo" : "Echo 已关");
			const title = masterOff
				? "总闸在休眠 —— 去「设置 → Echo → 电源」唤醒她,单条会话开不了总闸"
				: (on ? "这条会话已上线(点此下线)" : "这条会话已下线(点此上线)")
				+ (hardOff ? " · 硬关名单:不会被自动打开" : "");

			return React.createElement("button", {
				type: "button",
				className: cls,
				disabled: busy || masterOff,
				title,
				"aria-label": title,
				onClick: flip
			},
				React.createElement("span", { className: "echo-sess-dot" }),
				React.createElement("span", null, busy ? "…" : label));
		}
		//#endregion

		//#region 人格编辑卡
		function PersonaCard() {
			const [persona, setPersona] = React.useState(null);
			const [defaults, setDefaults] = React.useState(null);
			const [dirty, setDirty] = React.useState(false);
			const [saving, setSaving] = React.useState(false);
			const [feedback, setFeedback] = React.useState(""); // "" | "ok" | "err"
			const [error, setError] = React.useState("");

			React.useEffect(() => {
				let alive = true;
				fetchJson("/api/echo/persona").then((data) => {
					if (!alive) return;
					setPersona({ prefix: data.prefix, suffix: data.suffix });
					setDefaults({ prefix: data.defaults.prefix, suffix: data.defaults.suffix });
				}).catch((err) => alive && setError(String(err?.message ?? err)));
				return () => { alive = false; };
			}, []);

			if (error !== "") return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, "人格编辑"),
				React.createElement("div", { className: "echo-loading" }, "加载失败: " + error + "(插件宿主是否已随 dsh web 启动?)"));

			if (persona === null) return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, "人格编辑"),
				React.createElement("div", { className: "echo-loading" }, "加载中…"));

			const maxChars = 4000;
			const over = persona.prefix.length > maxChars || persona.suffix.length > maxChars;

			function update(field, value) {
				setPersona((p) => Object.assign({}, p, { [field]: value }));
				setDirty(true);
				setFeedback("");
			}

			function resetDefaults() {
				setPersona({ prefix: defaults.prefix, suffix: defaults.suffix });
				setDirty(true);
				setFeedback("");
			}

			async function save() {
				setSaving(true);
				setFeedback("");
				try {
					await fetchJson("/api/echo/persona", {
						method: "POST",
						headers: { "content-type": "application/json", "x-echo-edit": "1" },
						body: JSON.stringify({ prefix: persona.prefix, suffix: persona.suffix })
					});
					setDirty(false);
					setFeedback("ok");
				} catch (err) {
					setFeedback("err");
				} finally {
					setSaving(false);
				}
			}

			return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, "人格编辑"),
				React.createElement("p", { className: "echo-card-sub" },
					"前段是她的身份(挂在系统提示开头),尾段是铁律与说话方式(挂在提示词末尾,提醒位最强)。保存后下一轮对话即生效,无需重载。"),
				React.createElement("div", { className: "echo-field-label" },
					React.createElement("span", { className: "echo-field-name" }, "前段 · 身份"),
					React.createElement("span", { className: "echo-field-count" + (persona.prefix.length > maxChars ? " echo-over" : "") }, persona.prefix.length + " / " + maxChars)),
				React.createElement("textarea", {
					className: "echo-textarea", value: persona.prefix, spellCheck: false,
					onChange: (e) => update("prefix", e.target.value)
				}),
				React.createElement("div", { style: { height: "12px" } }),
				React.createElement("div", { className: "echo-field-label" },
					React.createElement("span", { className: "echo-field-name" }, "尾段 · 铁律与说话方式"),
					React.createElement("span", { className: "echo-field-count" + (persona.suffix.length > maxChars ? " echo-over" : "") }, persona.suffix.length + " / " + maxChars)),
				React.createElement("textarea", {
					className: "echo-textarea", value: persona.suffix, spellCheck: false,
					onChange: (e) => update("suffix", e.target.value)
				}),
				React.createElement("div", { className: "echo-actions" },
					feedback === "ok" ? React.createElement("span", { className: "echo-feedback echo-feedback-ok" }, "已保存,下一轮对话生效 ✓") : null,
					feedback === "err" ? React.createElement("span", { className: "echo-feedback echo-feedback-err" }, "保存失败(检查宿主日志)") : null,
					dirty && feedback === "" ? React.createElement("span", { className: "echo-feedback echo-feedback-dirty" }, "有未保存的修改") : null,
					React.createElement("button", { className: "echo-btn echo-btn-ghost", onClick: resetDefaults }, "恢复默认"),
					React.createElement("button", { className: "echo-btn echo-btn-primary", disabled: saving || over, onClick: save }, saving ? "保存中…" : "保存"))
			);
		}
		//#endregion

		//#region 仪表盘卡
		function DashboardCard() {
			const [status, setStatus] = React.useState(null);
			const [error, setError] = React.useState("");

			React.useEffect(() => {
				let alive = true;
				// 引擎状态是活指标(熔断/重启随时变),10s 轮询保持新鲜
				async function poll() {
					try {
						const data = await fetchJson("/api/echo/status");
						if (alive) { setStatus(data); setError(""); }
					} catch (err) { if (alive) setError(String(err?.message ?? err)); }
				}
				poll();
				const t = setInterval(poll, 10000);
				return () => { alive = false; clearInterval(t); };
			}, []);

			if (error !== "") return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, "仪表盘"),
				React.createElement("div", { className: "echo-loading" }, "加载失败: " + error));

			if (status === null) return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, "仪表盘"),
				React.createElement("div", { className: "echo-loading" }, "加载中…"));

			const mem = status.memory || {};
			const memOnline = status.memoryOnline !== false;
			const eng = status.engine || {};
			const sc = eng.sidecar || null;
			const rows = [
				["版本", status.version],
				["运行状态", status.enabled === false ? "休眠(不注入不记录)" : "在线"],
				["状态", status.status + (memOnline ? "" : "(记忆库离线)")],
				["引擎", engineLabel(eng)],
				["引擎进程", sc === null ? "—" :
					(sc.running ? "运行中" : "已停止") + (sc.version ? " · worker v" + sc.version : "")
					+ " · 失败 " + String(sc.failures ?? 0) + " · 重启 " + String(sc.restarts ?? 0)
					+ (sc.breakerOpen ? " · 熔断中" : "")],
				["数据目录", status.dataDir],
				["人格字数", (status.personaChars ? status.personaChars.prefix : "?") + " + " + (status.personaChars ? status.personaChars.suffix : "?") + (status.personaCustomized ? "(已定制)" : "(默认)")],
				["最近加载", status.lastLoadAt || "—"],
				["情景记忆", memOnline ? (String(mem.episodicActive ?? 0) + " 现役 / " + String(mem.episodicTotal ?? 0) + " 总计") : "—"],
				["待观察(隔离)", memOnline ? (String(mem.quarantined ?? 0) + " 条(置信度 0.55~0.75,检索不可见)") : "—"],
				["核心记忆(L0)", memOnline ? String(mem.l0 ?? 0) + " 条" : "—"],
				["图谱", memOnline ? (String(mem.graphNodes ?? 0) + " 节点 / " + String(mem.graphEdges ?? 0) + " 边") : "—"],
				["她的心情", memOnline ? (String(mem.moodIntensity ?? 0) + " / 10") : "—"],
				["审计行(证据链)", memOnline ? (String(mem.auditRows ?? 0) + " 行(保留上限见调参卡)") : "—"],
				["换代过的记忆", memOnline ? (String(mem.superseded ?? 0) + " 条(被她更新过)") : "—"],
				["画像字段", memOnline ? (String(mem.profileFields ?? 0) + " 项") : "—"],
				// v0.16.0 M4:画像**不复制**核心记忆 —— 这里显示的是
				// 只读投影(身份事实的真值在 L0 记忆里)。鼠标停上去
				// 能看到是哪几条(带 memory_id,能去记忆卡里查原文)。
				["称呼(画像)", (status.profile && status.profile.name) ? status.profile.name : "未定"],
				["身份事实(投影自 L0)", memOnline
					? React.createElement("span", { title: profileList(status.profile) },
						String((status.profile && status.profile.derivedFromL0) ? status.profile.derivedFromL0.length : 0) + " 条"
						+ (profileFirst(status.profile) ? ":" + profileFirst(status.profile) : ""))
					: "—"],
				["最近记忆", memOnline && mem.lastMemoryAt ? new Date(mem.lastMemoryAt * 1000).toLocaleString() : "—"]
			];

			return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, "仪表盘",
					React.createElement("span", { className: "echo-badge" }, status.version)),
				React.createElement("div", { className: "echo-kv" },
					rows.map((row, i) => React.createElement(React.Fragment, { key: i },
						React.createElement("span", { className: "echo-kv-key" }, row[0]),
						React.createElement("span", { className: "echo-kv-val" }, row[1]))))
			);
		}
		//#endregion

		//#region 通用小工具(v0.3.0 仪表盘)
		function fmtDur(sec) {
			if (!(sec > 0)) return "—";
			const h = sec / 3600;
			if (h < 1) return Math.max(1, Math.round(sec / 60)) + " 分钟";
			if (h < 48) return (Math.round(h * 10) / 10) + " 小时";
			return Math.round(h / 24) + " 天";
		}
		function fmtTime(ts) { return ts > 0 ? new Date(ts * 1000).toLocaleString() : "—"; }
		/** v0.16.0 M4:画像的 L0 只读投影 —— 一行摘要 + 完整清单给 hover。 */
		function profileFirst(prof) {
			const list = (prof && Array.isArray(prof.derivedFromL0)) ? prof.derivedFromL0 : [];
			if (list.length === 0) return "";
			const s = String(list[0].summary || "");
			return s.length > 24 ? s.slice(0, 24) + "…" : s;
		}
		function profileList(prof) {
			const list = (prof && Array.isArray(prof.derivedFromL0)) ? prof.derivedFromL0 : [];
			if (list.length === 0) return "还没有身份类核心记忆(L0):她说得出你的名字,是因为你在对话里告诉过她";
			return list.map((x) => "#" + String(x.memoryId) + "[" + String(x.field || "?") + "] " + String(x.summary || "")).join("\n");
		}
		function clipText(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; }
		// M2-i 引擎状态行:Python 全引擎 / JS 基线(M1 冻结)/ 离线
		function engineLabel(eng) {
			if (!eng || !eng.mode) return "未知";
			if (eng.mode === "python") {
				const s = eng.sidecar || {};
				return "Python 全引擎" + (s.version ? "(worker v" + s.version + ")" : "");
			}
			if (eng.mode === "baseline") return "JS 基线(M1 冻结)";
			return "离线";
		}
		//#endregion

		//#region 想念卡(答辩主仪表:AstrBot v8.6 移植)
		function LongingCard() {
			const [row, setRow] = React.useState(null);
			const [offline, setOffline] = React.useState(false);

			React.useEffect(() => {
				let alive = true;
				async function poll() {
					try {
						const data = await fetchJson("/api/echo/longing");
						if (!alive) return;
						setOffline(data.offline === true);
						if (data.rows && data.rows.length > 0) setRow(data.rows[0]);
					} catch (err) { if (alive) setOffline(true); }
				}
				poll();
				const t = setInterval(poll, 10000);
				// SSE 半推(M3-c):她主动开口(关怀落审计)→ 想念值减半,
				// 面板此刻跟上,不用等 10s 轮询
				const offEvent = subscribeEchoEvent("audit", poll);
				return () => { alive = false; clearInterval(t); offEvent(); };
			}, []);

			return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, "想念",
					React.createElement("span", { className: "echo-badge" }, "答辩主仪表"),
					row && row.engine ? React.createElement("span", { className: "echo-badge" },
						row.engine === "python" ? "引擎真值" : "JS 复刻") : null),
				React.createElement("p", { className: "echo-card-sub" }, "她有多想你:幂律增长,消息脉冲削减,关怀后减半重积。阈值 7.0 起步,她的委屈与依赖越高越忍不住(下限 4.5)。"),
				offline ? React.createElement("div", { className: "echo-loading" }, "记忆库离线") :
				row === null ? React.createElement("div", { className: "echo-loading" }, "加载中…") :
				React.createElement("div", null,
					React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: "10px" } },
						React.createElement("span", { className: "echo-num-big" }, row.value.toFixed(2)),
						React.createElement("span", { className: "echo-power-hint" }, "/ 10 · 阈值 " + row.threshold + (row.kicked ? " · 被安抚过" : ""))),
					React.createElement("div", { style: { height: "8px" } }),
					React.createElement("div", { className: "echo-bar" },
						React.createElement("div", { className: "echo-bar-fill", style: { width: Math.min(100, row.value * 10) + "%" } }),
						React.createElement("div", { className: "echo-bar-mark", style: { left: (row.threshold * 10) + "%" } })),
					React.createElement("div", { style: { height: "10px" } }),
					React.createElement("div", { className: "echo-kv" },
						React.createElement("span", { className: "echo-kv-key" }, "距上次和你说话"),
						React.createElement("span", { className: "echo-kv-val" }, fmtDur(row.sinceMessage)),
						React.createElement("span", { className: "echo-kv-key" }, "主动关心次数"),
						React.createElement("span", { className: "echo-kv-val" }, String(row.careCount)))));
		}
		//#endregion

		//#region 情绪历史卡
		function EmotionCard() {
			const [rows, setRows] = React.useState(null);
			const [offline, setOffline] = React.useState(false);

			React.useEffect(() => {
				let alive = true;
				fetchJson("/api/echo/emotion").then((data) => {
					if (!alive) return;
					setOffline(data.offline === true);
					setRows(data.rows || []);
				}).catch(() => alive && setOffline(true));
				return () => { alive = false; };
			}, []);

			const vec = (v) => {
				// v0.15.1 G22:全维列出(此前只列对主人的 4 维 —— 她自己
				// 那一路的疲惫/心情/清醒度在面板上根本看不见)。
				// v0.29.0 个人机器人裁剪:7 维(target_group 群维已退役)。
				// 标签表镜像 lib/emotion.js 的 EMOTION_DIM_LABELS:面板只
				// 负责显示,钳位与真相仍在 emotion.js 一处。
				const LABELS = {
					valence: "心情", arousal: "清醒", fatigue: "疲惫",
					affection: "爱意", playfulness: "玩心", sadness: "难过", dependency: "依赖"
				};
				if (v === null || v === undefined) return "—";
				const groups = [
					["她", v.global],
					["对眼前的人", v.target_master]
				];
				const out = [];
				for (const [title, dims] of groups) {
					if (!dims || typeof dims !== "object") continue;
					const parts = Object.keys(dims)
						.filter((k) => dims[k] !== undefined && dims[k] !== null)
						.map((k) => (LABELS[k] || k) + " " + dims[k]);
					if (parts.length > 0) out.push(title + ":" + parts.join("·"));
				}
				return out.length > 0 ? out.join(" / ") : JSON.stringify(v).slice(0, 40);
			};

			return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, "情绪历史"),
				React.createElement("p", { className: "echo-card-sub" },
					"每行是一次状态落库:她的 7 维向量 + 当前话题 + 会话。v0.14.5 起这些值还会随时间衰减。"),
				offline ? React.createElement("div", { className: "echo-loading" }, "记忆库离线") :
				rows === null ? React.createElement("div", { className: "echo-loading" }, "加载中…") :
				rows.length === 0 ? React.createElement("div", { className: "echo-loading" }, "还没有状态记录") :
				React.createElement("div", { className: "echo-kv" },
					rows.map((r, i) => React.createElement(React.Fragment, { key: i },
						React.createElement("span", { className: "echo-kv-key" }, fmtTime(r.updatedAt)),
						React.createElement("span", { className: "echo-kv-val" },
							"心情 " + r.moodIntensity + "/10(前值 " + r.prevMoodIntensity + ")· 你:" + r.userEmotion
							+ (r.currentTopic ? " · 话题:" + clipText(r.currentTopic, 24) : "")
							+ (r.sessionId ? " · 会话:" + clipText(r.sessionId, 14) : "")
							+ " · " + vec(r.emotionVector))))));
		}
		//#endregion

		//#region 危险区(v0.15.1 G14:整库清空 —— 手打确认短语才给点)
		// A 侧 `/mem_clear` 要求主人 + confirm 参数(二次确认)。DSH 没有
		// 「主人」这道身份闸(单用户),所以把确认做**更重**而不是更轻:
		// 必须手打「清空记忆」四个字,按钮才解除禁用;后端还会再验一次
		// 短语,引擎帧自己也会拒收没有 confirm 的请求 —— 三层,任一层
		// 都不许「点一下就没」。
		function DangerZone() {
			const [phrase, setPhrase] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [msg, setMsg] = React.useState("");
			const [show, setShow] = React.useState(false);
			const NEED = "清空记忆";
			const armed = phrase.trim() === NEED;

			function clear() {
				setBusy(true); setMsg("");
				fetchJson("/api/echo/memory/clear", {
					method: "POST",
					headers: { "content-type": "application/json", "x-echo-edit": "1" },
					body: JSON.stringify({ confirm: phrase.trim() })
				}).then((d) => {
					setBusy(false); setPhrase("");
					setMsg("已彻底清空:情景记忆 " + d.episodic + " 条、画像 " + d.profile + " 项");
				}).catch((err) => { setBusy(false); setMsg("失败:" + String(err.message || err)); });
			}

			return React.createElement("div", { className: "echo-mem-form", style: { marginTop: "14px", borderColor: "var(--dsw-alias-state-error-primary,#DC2626)" } },
				React.createElement("div", { className: "echo-group-title", style: { marginTop: 0 } }, "危险区"),
				React.createElement("div", { className: "echo-card-sub", style: { margin: "0 0 6px" } },
					"整库清空情景记忆与画像(A 的 /mem_clear 语义),不可恢复。图谱、悬置话题、审计、日记不动 —— 所以「她记得的事」会清空,「她怎么想事」还在。"),
				show ? React.createElement("div", null,
					React.createElement("div", { className: "echo-field-label" },
						React.createElement("span", { className: "echo-field-name" }, "输入「" + NEED + "」以确认"),
						React.createElement("input", {
							className: "echo-input", style: { width: "140px" },
							value: phrase,
							onChange: (e) => setPhrase(e.target.value)
						})),
					React.createElement("div", { className: "echo-mem-actions" },
						React.createElement("button", {
							className: "echo-mem-btn echo-mem-btn-danger", disabled: busy || !armed,
							onClick: clear
						}, busy ? "清空中…" : "确认清空"),
						React.createElement("button", {
							className: "echo-mem-btn", disabled: busy,
							onClick: () => { setShow(false); setPhrase(""); }
						}, "取消"))) : React.createElement("div", { className: "echo-mem-actions" },
					React.createElement("button", { className: "echo-mem-btn echo-mem-btn-danger", onClick: () => setShow(true) }, "清空记忆…")),
				msg !== "" ? React.createElement("div", { className: "echo-feedback", style: { margin: "8px 0 0" } }, msg) : null);
		}
		//#endregion

		//#region 审查台跳板(M6-c):看板全在网页那侧,这里留一个门
		function ConsoleCard() {
			return React.createElement("div", { className: "echo-card" },
				React.createElement("h3", { className: "echo-card-title" }, "Echo 审查台"),
				React.createElement("p", { className: "echo-card-sub" },
					"打开新版审查台，查看近况、情绪、记忆图谱、对话、日记与审计，管理设置和维护操作。新版页脚保留旧审查台入口。"),
				React.createElement("div", { className: "echo-actions", style: { justifyContent: "flex-start" } },
					React.createElement("button", {
						className: "echo-btn echo-btn-primary",
						onClick: () => { try { window.open("/echo/mock/final/index.html", "_blank"); } catch (e) { /* 弹窗被拦:用户手动点链接 */ } }
					}, "打开审查台 ↗"),
					React.createElement("span", { className: "echo-kv-val", style: { alignSelf: "center" } }, "/echo/mock/final/index.html")));
		}
		//#endregion

		//#region 设置区段组件(跳板 + 电源 + 子代理记忆工具开关 + 仪表盘 + 想念 + 情绪 + 人格 + 危险区)
		// 2026-09-26 他的两批裁定:六个看板(图谱/话题/回放/记忆管理/体检/日记)撤走,
		// 审计流也撤,**调参搬去网页** —— 以后都用网页仪表盘 /echo/ 看。
		// 这里只留「在里面才顺手」的东西:开关、状态、人格,以及
		// 危险区(整库清空是**动作**不是看板 —— 原来嵌在记忆管理卡里,跟着卡一起
		// 消失就成了「能力静默消失」,所以把它提成独立一张卡留着)。
		function EchoSection() {
			return React.createElement("div", { className: "echo-page" },
				React.createElement(ConsoleCard, null),
				React.createElement(PowerCard, null),
				React.createElement(MemoryToolsCard, null),
				React.createElement(GraphGateCard, null),
				React.createElement(DashboardCard, null),
				React.createElement(LongingCard, null),
				React.createElement(EmotionCard, null),
				React.createElement(PersonaCard, null),
				React.createElement(DangerZone, null));
		}
		//#endregion

		//#region QQ 常驻对话按钮(v0.44.0:他的需求「在一个对话界面的角落加上
		// 『设置为 qq 常驻对话』的按钮,且只能设置一个」)
		// 常驻 = **兜底**(不抢"跟着他走"那条):QQ 仍然优先落进他正在用的窗口,
		// 只有挑不出来时才落这条。位置 = `conversation.session.header.utilities`
		// (list 槽,与 echo-session-toggle 同一排,order 91 ⇒ 排在它右边);
		// `sessionId` 由插槽 props 直接给。写入走 `/api/echo/qq-pin`(服务端
		// `writeSettings({relay:{sessionId}})`;单值 ⇒ 只能设一个)。
		function QqPinButton({ sessionId }) {
			const [data, setData] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [note, setNote] = React.useState("");

			const load = React.useCallback(() => {
				fetchJson("/api/echo/qq-pin").then((d) => { setData(d); }).catch(() => { setData(null); });
			}, []);
			React.useEffect(() => { load(); }, [load]);
			React.useEffect(() => subscribeEchoEvent("audit", () => load()), [load]);

			if (data === null || !sessionId) return null;
			const pinned = String(data.sessionId || "");
			const isMine = pinned === String(sessionId);
			// 已经归档的常驻 = 那个"消息落进去就找不着"的老坑 ⇒ 按钮上直接报警
			const broken = data.pinnedArchived === true;

			async function pin() {
				if (busy) return;
				setBusy(true); setNote("");
				try {
					const d = await fetchJson("/api/echo/qq-pin", {
						method: "POST",
						headers: { "content-type": "application/json", "x-echo-edit": "1" },
						body: JSON.stringify({ sessionId })
					});
					setData(d); setNote("已设为常驻");
				} catch (err) {
					setNote("失败:" + String(err && err.message ? err.message : err));
				} finally { setBusy(false); }
			}

			const text = isMine ? (broken ? "QQ 常驻 ⚠️" : "QQ 常驻 ✓") : "设为 QQ 常驻";
			const title = "常驻 = 兜底:QQ 优先跟着你正在用的窗口走,挑不出来时落这条(当前:"
				+ pinned + ")" + (broken ? "。⚠️ 这条已归档,网页里看不见,建议换一条" : "");
			return React.createElement("button", {
				className: "echo-sess-btn" + (isMine && !broken ? "" : " echo-sess-off"),
				disabled: busy, title, onClick: pin
			}, note === "" ? text : text + " · " + note);
		}
		//#endregion

		//#region 本会话预设选择器(2026-10-01 尾:他的裁定「工作与娱乐各用各的预设,
		// 在一个会话里选,不影响其他会话」)
		// 宿主**早就支持** per-session preset(机制完整),缺的只是界面;但它有一条硬
		// 限制:**会话一旦开过一轮就拒绝换**(`agent-preset/locked` —— 理由:已记录的
		// 工具调用跟新组装对不上)⇒ 这里做成「空白时可点、开聊后置灰并写明原因」。
		// **不假装能换**(那会变成界面撒谎,而且与"面板显示的和真跑的不是一回事"
		// 是同一条纪律)。
		//
		// 位置 = `conversation.session.header.actions`(list 槽,scope session,
		// props 自带 `sessionId`);宿主自己的只读预设标签(id `agent-preset`)坐在
		// 同一排,我们用**自己的 id** 并排,不挤它。
		function PresetPicker(props) {
			// 没有宿主那份 `useSessions` 就什么都不画(**必须早返回**:下面要无条件调 hook)
			if (typeof props.useSessions !== "function") return null;
			return React.createElement(PresetPickerInner, props);
		}
		function PresetPickerInner({ sessionId, useSessions, loadPresets, selectPreset }) {
			const [roster, setRoster] = React.useState([]);
			const [busy, setBusy] = React.useState(false);
			const [err, setErr] = React.useState("");
			// 当前这条会话的组装(宿主投影里的 `agentPreset`;没有 = 用部署默认)
			const current = useSessions((state) => {
				const row = state && state.byId ? state.byId[sessionId] : null;
				const v = row && row.projectionValues ? row.projectionValues.agentPreset : null;
				return typeof v === "string" ? v : "";
			});
			// blank === false ⇒ 已经开聊过 ⇒ 宿主会拒绝换(提前置灰,不等报错)
			const blank = useSessions((state) => {
				const row = state && state.byId ? state.byId[sessionId] : null;
				return row && typeof row.blank === "boolean" ? row.blank : null;
			});
			React.useEffect(() => {
				let alive = true;
				if (typeof loadPresets !== "function") { setErr("预设名单拿不到"); return () => { alive = false; }; }
				loadPresets().then((r) => {
					if (!alive) return;
					if (r && r.ok === false) {
						setErr(String(r.error && r.error.message ? r.error.message : "预设名单拿不到"));
						return;
					}
					const value = r && r.ok === true ? r.value : r;
					setRoster(value && Array.isArray(value.presets) ? value.presets : []);
				}).catch((e) => { if (alive) setErr(String(e && e.message ? e.message : e)); });
				return () => { alive = false; };
			}, [loadPresets]);

			const locked = blank === false;
			async function pick(ev) {
				const id = String(ev && ev.target ? ev.target.value : "");
				if (id === "" || busy || typeof selectPreset !== "function") return;
				setBusy(true); setErr("");
				try {
					const r = await selectPreset(sessionId, id);
					if (r && r.ok === false) {
						const code = r.error && r.error.code ? String(r.error.code) : "";
						setErr(code === "agent-preset/locked"
							? "宿主拒绝:这条会话已开聊,预设锁定"
							: String(r.error && r.error.message ? r.error.message : "换不了"));
					}
				} catch (e) { setErr(String(e && e.message ? e.message : e)); } finally { setBusy(false); }
			}

			return React.createElement("span", {
				className: "echo-kv",
				title: locked
					? "已开聊 ⇒ 宿主锁定(agent-preset/locked):会话的组装开聊后固定"
					: "只影响这一条会话(部署默认不受影响)"
			},
				React.createElement("span", { className: "echo-kv-key" }, "预设"),
				React.createElement("select", {
					className: "echo-kv-val", value: current, disabled: locked || busy, onChange: pick,
					style: { background: "transparent", border: "none", color: "inherit", font: "inherit" }
				}, current === "" ? React.createElement("option", { value: "" }, "(默认)") : null,
					roster.map((o) => React.createElement("option", { key: String(o.id), value: String(o.id) },
						String(o.name || o.id)))),
				err !== "" ? React.createElement("span", { className: "echo-kv-val" }, "⚠️ " + err) : null);
		}
		//#endregion

		exports.inject = ["slots"];
		exports.apply = (ctx) => {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			// 设置区专属「Echo」导航段(settings-plugins 同款注册姿势:
			// register(描述, 组件))。人格编辑器 + 仪表盘同页堆叠。
			ctx.effect(() => slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: "echo", order: 20, label: () => "Echo" },
				EchoSection
			)), "echo: settings section");
			// 会话页角落开关(v0.30.0):每个会话头部右对齐一枚小按钮。
			// `utilities` 是 list(能与 open-in-app / 后台任务 / 会话日志并存),
			// order 给大一点,排在最右 —— 视觉上就是他要的「角落」。
			ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register(
				{ name: "conversation.session.header.utilities", id: "echo-session-toggle", order: 90 },
				SessionToggleButton
			)), "echo: session header toggle");
			// QQ 常驻对话按钮(2026-10-01 尾):order 91 ⇒ 排在会话开关右边。
			// 它只跟本插件的 `/api/echo/qq-pin` 说话,不需要宿主任何服务。
			ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register(
				{ name: "conversation.session.header.utilities", id: "echo-qq-pin", order: 91 },
				QqPinButton
			)), "echo: session header QQ pin");
			// 本会话预设选择器(2026-10-01 尾):要宿主的 `remote.agentPresets`。
			// 用 `ctx.inject` **软等**那个服务(等不到就不挂这一枚),**绝不写进
			// exports.inject** —— 写进去等于"没有它整段 Echo UI 都不起来",那代价太大。
			try {
				ctx.inject(["remote.agentPresets"], (scope) => {
					scope.effect(() => scope.slots.inject("conversation.session.header.actions", () => scope.slots.register(
						{
							name: "conversation.session.header.actions",
							id: "echo-preset-picker",
							order: 10,
							inject: () => ({
								loadPresets: () => scope.remote.agentPresets.list(),
								selectPreset: (sid, id) => scope.remote.agentPresets.select(sid, id)
							})
						},
						PresetPicker
					)), "echo: session preset picker");
				});
			} catch (err) {
				try {
					ctx.logger?.warn?.('echo: 预设选择器没挂上(宿主 agentPresets remote 不可用)— ' + String(err?.message ?? err));
				} catch { /* 日志失败也不许拖垮 apply */ }
			}
		};
		return module.exports;
	}
});
