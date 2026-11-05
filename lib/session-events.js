/**
 * dsh-echo — 宿主 SessionEvent 形状提取(v0.9.1 根因修复)
 * ============================================================
 * dsh-session types.d.ts 证实:SessionEvent = { type, seq, time, data }
 * —— user/message 的 data 就是 UserMessage 本体;assistant/message
 * 的消息体在 data.message(SessionEventMap:'assistant/message' 的
 * data = { turn, step, message, stream, ... })。
 *
 * 旧代码按自猜的 { type, message } 形状取值(event.message ??
 * event),两头落空:守卫全过、文本恒空 —— session/event 全链路
 * (捕获/反思/想念削减/情绪更新/心跳路由/范围标记)自 M2-d 起
 * 在 live 空转,电池没喂过宿主形状,绿得心安理得。
 *
 * 本模块零宿主依赖(可离线单测)—— 宿主契约钉在 tests/events.test.js。
 */

/** 从 SessionEvent 提取消息体;非消息事件 → null。 */
export function messageOfEvent (event) {
  if (event?.type === 'user/message') return event.data ?? event.message ?? null
  if (event?.type === 'assistant/message') return event.data?.message ?? event.message ?? null
  return null
}
