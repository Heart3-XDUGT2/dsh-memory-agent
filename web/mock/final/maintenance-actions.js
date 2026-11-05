/* Writes have a separate lifetime from page reads. Never replay on remount. */
globalThis.EchoMaintenanceActions = (function () {
  "use strict";
  class Action {
    constructor(notify = () => {}, fetcher = (...args) => fetch(...args)) {
      this.notify = notify; this.fetcher = fetcher; this.state = "idle"; this.target = null;
      this.message = ""; this.pending = null;
    }
    prepare(target, request) {
      if (this.state === "pending") return false;
      this.target = Object.freeze({ ...target }); this.request = structuredClone(request);
      this.state = "confirm"; this.message = ""; this.notify(); return true;
    }
    cancel() {
      if (this.state !== "confirm") return false;
      this.state = "idle"; this.target = null; this.request = null; this.notify(); return true;
    }
    resetConfirmation() { if (this.state === "confirm") this.cancel(); }
    async submit(interpret) {
      if (this.state !== "confirm") return this.pending;
      const target = this.target, request = structuredClone(this.request);
      this.state = "pending"; this.message = "请求已提交，正在等待结果。"; this.notify();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs || 40000);
      this.pending = (async () => {
        try {
          const response = await this.fetcher(request.url, {
            method: request.method || "POST", signal: controller.signal,
            headers: { "Content-Type": "application/json", "x-echo-edit": "1" },
            body: JSON.stringify(request.body)
          });
          const body = await response.json();
          const result = interpret(response.status, body, target);
          if (!result || !["success", "refused", "unconfirmed"].includes(result.state)) throw Error("invalid result");
          this.state = result.state; this.message = result.message;
        } catch {
          this.state = "unconfirmed";
          this.message = "结果未确认，服务端可能仍在处理；没有自动重发。请先重新读取相关状态。";
        } finally {
          clearTimeout(timer); this.pending = null; this.notify();
        }
        return { state: this.state, target, message: this.message };
      })();
      return this.pending;
    }
  }
  function refusal(status) {
    if (status === 403 || status === 401) return "没有操作权限，本次请求被拒绝。";
    if (status === 400) return "请求未通过校验，请重新读取后检查对象。";
    if (status === 404 || status === 405) return "此操作接口当前不可用。";
    return null;
  }
  function interpret(kind) {
    return (status, body) => {
      const denied = refusal(status);
      if (denied) return { state: "refused", message: denied };
      if (kind === "rollback" && status === 409) return { state: "refused", message: "现在没有可回退的记录，未确认回退成功。请重新读取架构状态。" };
      if (status < 200 || status >= 300 || !body || typeof body !== "object") return {
        state: "unconfirmed", message: "结果未确认，可能已有部分处理；没有自动重发。请先重新读取相关状态。"
      };
      if (kind === "clear") {
        const messages = { busy: "她正忙，未完成清空。等这轮结束后再决定是否执行。", nothing: "没有可压缩的历史，本次没有清空。",
          cancelled: "服务端报告操作已取消，未完成清空。", "no-service": "宿主暂不提供压缩服务。",
          "no-agent": "未能取得所选会话，未完成清空。", error: "服务端未确认清空成功，请先核对会话状态。" };
        if (body.ok === true && body.code === "cleared") return { state: "success", message: "所选会话的旧上下文已压缩为摘要；历史记录与记忆库没有删除。" };
        return { state: body.ok === false && Object.hasOwn(messages, body.code) ? "refused" : "unconfirmed",
          message: messages[body.code] || "结果未确认，没有自动重发清空请求。" };
      }
      if (kind === "rollback") return body.ok === true && body.rollback?.applied === true
        ? { state: "success", message: "所选路线已回退。请重新读取架构状态核对。" }
        : { state: "unconfirmed", message: "接口没有确认已执行回退；没有自动重发。" };
      if (kind === "backup" && body.ok === true && Array.isArray(body.files)) {
        const done = body.files.filter(file => file.backedUp === true).length;
        const skipped = body.files.filter(file => file.backedUp === false).length;
        if (done + skipped !== body.files.length) return { state: "unconfirmed", message: "备份结果不完整，请先读取清单；没有自动重发。" };
        return { state: "success", message: "已备份 " + done + " 份；" + skipped + " 份没有可备份的源文件。请读取备份清单核对。" };
      }
      if (kind === "repair" && body.ok === true) {
        const effective = { now: "保存后读取", "next-turn": "下一轮对话", "next-engine-call": "下次引擎调用" }[body.effective] || "所属来源下次读取";
        return { state: "success", message: "重建已保存，生效时机：" + effective + "。"
          + (Array.isArray(body.warnings) && body.warnings.length ? "有 " + body.warnings.length + " 项校验提醒，请重新读取体检。" : "请重新读取体检。") };
      }
      return { state: "unconfirmed", message: "接口未给出完整成功结果；没有自动重发，请先重新读取。" };
    };
  }
  return { Action, interpret };
})();
