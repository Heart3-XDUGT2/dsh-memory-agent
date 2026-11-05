/** Single-owner text MVP. No Echo DB/schema/files; the adapter owns the journal. */
import { randomUUID } from 'node:crypto'
import * as codec from './official-c2c-codec.js'
import { createOfficialInput } from './official-input.js'
import { createOfficialTurnTracker } from './official-turns.js'

const copy = v => structuredClone(v)
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) }; return v }
const key = v => typeof v === 'string' && v.length > 0 && v.length <= 256
const hasOfficial = turn => !!turn && [...turn.inputs, ...turn.claims].some(i => ['official', 'untrusted_official'].includes(i.kind))
const terminal = new Set(['confirmed', 'unknown', 'rejected', 'expired'])
const safeError = reason => Object.assign(Error(reason), { code: reason })
// A service hot-reload is not a new Agent lifecycle. Do not wash its bounded
// source/root identity guards by attaching a fresh tracker to that same object.
const observedAgentOwners = new WeakMap()
export const OFFICIAL_ORIGIN_REASONS = Object.freeze([
  'wrong_instance', 'revoked', 'canceled_or_missing_signal', 'no_live_step', 'ineligible_inputs',
  'nested_unverified', 'unpublished_root', 'invalid_observation', 'unknown_diagnostic'
])
export const OFFICIAL_TURN_REASONS = Object.freeze([
  'source_identity_conflict', 'source_capacity', 'message_capacity', 'message_depth', 'non_json_message',
  'invalid_observation', 'claim_boundary', 'invalid_claim', 'input_capacity', 'duplicate_claim', 'source_claim_conflict',
  'invalid_surface_metadata', 'surface_replacement_unproven', 'surface_input_replaced', 'surface_root_replaced',
  'invalid_event', 'event_order', 'turn_boundary', 'feed_integrity_lost', 'step_boundary', 'input_boundary',
  'invalid_input', 'duplicate_input', 'turn_capacity', 'source_enter_conflict', 'proactive_input', 'ambiguous_inputs',
  'assistant_boundary', 'interrupted', 'invalid_assistant', 'root_identity_conflict', 'root_capacity',
  'root_identity_capacity', 'no_official_input', 'event_boundary', 'surface_replacement', 'revoked',
  'turn_blocked', 'turn_error', 'turn_aborted', 'turn_max-tokens', 'turn_interrupted', 'turn_forked', 'turn_unknown'
])

/**
 * Returns {service, observeSessionEvent, observeClaim, dispatchTool, contactFor,
 * hasBinding, dispose}. Publish service as echo:relay.officialOwnerText; forward
 * the complete host feed before legacy early returns. Only explicit injection
 * selects the existing companion, never status/openBinding.
 */
export function createOfficialOwnerText ({
  resolveTarget, createMessage, isEnabled = () => false, isSessionEnabled = () => false,
  supportsHost = () => false, onBindingChange = () => {},
  clock = { now: Date.now, setTimeout, clearTimeout }, worker = null,
  allowMemoryMetadata = false
} = {}) {
  let binding = null, disposed = false
  const observers = new Map(), sourceOwners = new Map()
  const available = () => {
    try { return !disposed && typeof resolveTarget === 'function' && typeof createMessage === 'function' && isEnabled() === true && supportsHost() === true } catch { return false }
  }
  const permission = target => {
    try { return available() && target.agent.session === target.session && isSessionEnabled(target.session.id) === true && target.originalIsCurrent() === true } catch { return false }
  }
  function observerOf (target) {
    let observer = observers.get(target.agent)
    if (!observer) {
      if (observedAgentOwners.has(target.agent) && observedAgentOwners.get(target.agent) !== serviceEpoch) throw safeError('official_agent_lifecycle_requires_restart')
      if (observers.size >= 4) throw safeError('official_target_capacity')
      observer = { agent: target.agent, session: target.session, tracker: null, agentEpoch: 'owner-agent-' + randomUUID() }
      observer.start = liveFromSeq => {
        if (!observer.tracker) observer.tracker = createOfficialTurnTracker({ agent: observer.agent, session: observer.session,
          bootEpoch: 'owner-service-' + serviceEpoch, agentEpoch: observer.agentEpoch, liveFromSeq })
        return observer.tracker
      }
      observers.set(target.agent, observer)
      observedAgentOwners.set(target.agent, serviceEpoch)
    }
    if (observer.session !== target.session) throw safeError('official_target_changed')
    return observer
  }
  const serviceEpoch = randomUUID()
  function targetView (b, candidate) {
    const agent = candidate?.agent, session = candidate?.session ?? agent?.session
    if (!agent || !session || agent.session !== session || typeof session.eventAt !== 'function' || !session.surface ||
      !['whenIdle', 'runMaintenance', 'followup'].every(k => typeof agent[k] === 'function') || typeof candidate.isCurrent !== 'function') throw safeError('official_host_incompatible')
    if (b.target?.agent === agent && b.target.session === session) {
      b.target.originalIsCurrent = candidate.isCurrent
      return b.target
    }
    const target = { agent, session, originalIsCurrent: candidate.isCurrent }
    if (b.target && (b.target.agent !== agent || b.target.session !== session)) cancelActive(b, 'target_changed')
    const observer = observerOf(target)
    target.isCurrent = () => b.active && b.target === target && permission(target)
    target.tracker = {
      registerSource: source => {
        if (!target.isCurrent()) return { ok: false, reason: 'official_target_changed' }
        // A tracker attached during a busy old turn starts at the next real
        // turn boundary, or here at the idle maintenance publication boundary.
        if (!observer.tracker && agent.status !== 'idle') return { ok: false, reason: 'official_host_busy' }
        return observer.start(session.seq).registerSource(source)
      },
      sourceStatus: sourceKey => observer.tracker?.sourceStatus(sourceKey) ?? null
    }
    b.target = target
    return target
  }
  function track (b, p) {
    const promise = Promise.resolve(p)
    b.tasks.add(promise)
    promise.then(() => b.tasks.delete(promise), () => b.tasks.delete(promise))
    return promise
  }
  function fail (b, reason) {
    b.active = false; b.reason = reason; b.input?.revoke()
    cancelActive(b, reason)
  }
  function transact (b, source, reducer) {
    return track(b, Promise.resolve().then(() => b.store.transaction({ scopeKey: b.scope.scopeKey, inboundKey: source.inboundKey }, old => {
      if (!old?.everAccepted || old.sourceKey !== source.sourceKey || old.scopeKey !== b.scope.scopeKey) throw safeError('official_source_fenced')
      return reducer(old)
    })).catch(() => { fail(b, 'official_storage_unavailable'); throw safeError('official_storage_unavailable') }))
  }
  function cancelActive (b, reason, exceptSourceKey = null) {
    for (const observer of observers.values()) {
      const turn = observer.tracker?.snapshot().current
      for (const input of [...(turn?.inputs ?? []), ...(turn?.claims ?? [])]) {
        const sourceKey = input.sourceKey ?? [...b.sources.values()].find(s => observer.tracker?.sourceStatus(s.sourceKey)?.messageId === input.messageId)?.sourceKey
        if (sourceKey && sourceKey !== exceptSourceKey && b.sources.has(sourceKey)) b.canceledSources.add(sourceKey)
      }
    }
    for (const draft of b.drafts.values()) if (!draft.closed && draft.sourceKey !== exceptSourceKey) { draft.canceled = true; draft.reason = reason }
    for (const item of b.replies.values()) {
      if (!terminal.has(item.outcome) && item.source.sourceKey !== exceptSourceKey) {
        item.canceled = true
        if (b.activeClaim === item.claimKey) b.activeClaim = null
      }
    }
  }
  function contextFor (observer) {
    const turn = observer?.tracker?.snapshot().current
    return { turn, contaminated: hasOfficial(turn) }
  }
  function seal (observer, turn) {
    const draft = [...(binding?.drafts.values() ?? [])].find(d => d.uid === turn.hostTurnUid)
    if (!draft) {
      const source = turn.inputs.find(i => i.kind === 'official')
      const owner = source && sourceOwners.get(source.sourceKey)
      if (owner?.active) owner.reason = turn.associationEligible ? 'no_reply' : 'official_turn_ineligible'
      return
    }
    draft.closed = true
    const b = draft.binding, source = b.sources.get(draft.sourceKey)
    if (!b.active || !source || b.canceledSources.has(source.sourceKey) || draft.canceled || draft.invalid || !turn.associationEligible || !source.target.isCurrent()) return
    const text = [...draft.parts.values()].sort((a, z) => a.order - z.order).map(p => p.text).join('\n')
    if (!text) return
    if ([...text].length > 1500) { b.reason = 'official_reply_too_long'; return }
    if (terminal.has(b.anchors.get(source.replyAnchorKey))) return
    const reply = freeze({ replyId: 'owner_reply_' + randomUUID(), sourceKey: source.sourceKey, inboundKey: source.inboundKey,
      replyAnchorKey: source.replyAnchorKey, scopeKey: b.scope.scopeKey, text, createdAtMs: clock.now() })
    const item = { reply, source, claimKey: null, canceled: false, outcome: null, ready: false }
    b.replies.set(reply.replyId, item)
    void transact(b, source, old => {
      const next = { ...old, ownerText: { reply, claimKey: null, outcome: null }, stateVersion: old.stateVersion + 1 }
      return { next, value: true }
    }).then(() => { item.ready = true }, () => {})
  }
  function observeSessionEvent (session, event) {
    const observer = [...observers.values()].find(o => o.session === session)
    if (!observer) return { suppressLegacy: false }
    // Do not pretend the tail of a turn already in flight was fully observed.
    if (!observer.tracker && event.type !== 'turn/start') return { suppressLegacy: false }
    if (!observer.tracker) observer.start(event.seq)
    const before = contextFor(observer).contaminated
    const result = observer.tracker.observeSessionEvent({ agent: observer.agent, session, event })
    if (event.type === 'turn/end') {
      const turn = result.turn ?? observer.tracker.snapshot().turns.at(-1)
      if (turn?.endSeq === event.seq) seal(observer, turn)
      return { suppressLegacy: before || hasOfficial(turn) }
    }
    return { suppressLegacy: before || contextFor(observer).contaminated }
  }
  function observeClaim ({ agent, message, turn }) {
    const observer = observers.get(agent)
    if (!observer?.tracker) return
    observer.tracker.observeClaim({ agent, session: observer.session, message, turn })
  }
  function isCurrentOfficialTurn ({ agent, turn } = {}) {
    const observer = observers.get(agent)
    const current = observer?.tracker?.snapshot().current
    return !!(observer && observer.session === agent?.session && current?.turn === turn &&
      [...current.inputs, ...current.claims].some(input => input.kind === 'official'))
  }
  async function dispatchTool ({ kind, args, exec, guard }) {
    if (kind !== 'reply') return undefined
    const observer = observers.get(exec?.agent), context = contextFor(observer)
    if (!context.contaminated) return undefined // local/old-platform semantics stay old
    const denied = reason => ({ ok: false, reason, sent: 0, kind: 'reply' })
    const resolved = observer.tracker.resolveToolCall(exec)
    if (!resolved.ok) return { ...denied('official_origin_unproven'),
      originReason: OFFICIAL_ORIGIN_REASONS.includes(resolved.reason) ? resolved.reason : 'unknown_diagnostic',
      originTurnReasons: (context.turn?.reasons ?? []).filter(reason => OFFICIAL_TURN_REASONS.includes(reason)).slice(0, 8) }
    const b = sourceOwners.get(resolved.sourceKey), source = b?.sources.get(resolved.sourceKey)
    if (!b?.active || !source?.target.isCurrent()) return denied('official_binding_closed')
    if (b.canceledSources.has(source.sourceKey)) return denied('official_reply_canceled')
    if (String(args?.chat ?? '') !== '' && args.chat !== b.scope.chatId) return denied('official_target_unavailable')
    const text = typeof args?.text === 'string' ? args.text.trim() : ''
    if (!text) return denied('empty')
    if (text.length > 500) return denied('official_tool_too_long')
    let normalized = text, note = '', words = []
    try {
      const g = typeof guard === 'function' ? guard(text, source.target.session.id) : null
      if (g) {
        words = Array.isArray(g.words) ? g.words.map(String) : []
        if (g.ok === false) return { ...denied('guard-hold'), words, note: String(g.reason ?? '') }
        if (String(g.text ?? '')) normalized = String(g.text)
        note = String(g.reason ?? '')
      }
    } catch { /* same fail-soft guard policy as the existing tool */ }
    if (normalized.length > 500) return denied('official_tool_too_long')
    let draft = b.drafts.get(resolved.hostTurnUid)
    if (!draft) {
      if (b.drafts.size >= 256) return denied('official_draft_capacity')
      draft = { uid: resolved.hostTurnUid, binding: b, sourceKey: source.sourceKey, parts: new Map(), invalid: false, canceled: false, closed: false }
      b.drafts.set(draft.uid, draft)
    }
    const previous = draft.parts.get(resolved.callId)
    if (previous && previous.text !== normalized) { draft.invalid = true; return denied('official_tool_conflict') }
    if (draft.canceled || draft.invalid) return denied('official_reply_canceled')
    draft.parts.set(resolved.callId, { text: normalized, order: resolved.order })
    return { ok: true, sent: 0, kind: 'reply', chars: normalized.length, deliveryStatus: 'pending_turn_end', note, words }
  }
  function contactFor (agent) {
    const observer = observers.get(agent)
    const turn = observer?.tracker?.snapshot().current
    if (!hasOfficial(turn)) return ''
    return '[官方主人文字私聊]\n本轮来自已绑定的官方私聊；想让对方收到文字，用 echo_qq_say。工具内容会等正常轮结束后合并为一条发送，普通助手正文不会自动发送。此渠道不支持主动 call、群聊或媒体。'
  }
  async function openBinding ({ scope, authorization, metadataStore }) {
    if (!available()) throw safeError('official_unavailable')
    const normalized = codec.validateScope(scope)
    const auth = { kind: authorization?.kind, authorized: authorization?.authorized, appId: authorization?.appId, ownerHash: authorization?.ownerHash }
    if (auth.kind !== 'local-explicit-owner' || auth.authorized !== true || auth.appId !== normalized.appId || auth.ownerHash !== normalized.ownerHash) throw safeError('official_owner_authorization_required')
    if (metadataStore?.contract !== 'official-input-metadata-v1' || !['transaction', 'read'].every(k => typeof metadataStore[k] === 'function') ||
      (metadataStore.durability !== 'durable-metadata' && !(allowMemoryMetadata && metadataStore.durability === 'memory-test'))) throw safeError('official_metadata_required')
    if (binding?.active) {
      if (binding.scope.scopeKey === normalized.scopeKey && binding.store === metadataStore) return binding.handle
      throw safeError('official_binding_busy')
    }
    if (binding && (binding.tasks.size || !(await binding.input.drain()).drained)) throw safeError('official_binding_draining')
    const b = { scope: normalized, store: metadataStore, generation: randomUUID(), active: true, reason: null, target: null,
      sources: new Map(), canceledSources: new Set(), drafts: new Map(), replies: new Map(), claims: new Map(), anchors: new Map(), activeClaim: null, tasks: new Set(), serial: Promise.resolve() }
    const publication = worker ?? {
      schedule: (fn, { delayMs }) => { const timer = clock.setTimeout(fn, delayMs); timer?.unref?.() },
      wait: async target => { await target.agent.whenIdle(); return { kind: 'ready' } },
      publish: async (target, commit) => { await target.agent.runMaintenance(async () => commit()); return { kind: 'published' } }
    }
    b.input = createOfficialInput({ scope: normalized, generation: b.generation, getGeneration: () => b.active ? b.generation : null,
      metadataStore, codec, clock, worker: publication,
      resolveTarget: async () => {
        if (!b.active || !available()) throw safeError('official_unavailable')
        const candidate = await resolveTarget()
        let target
        try { target = targetView(b, candidate) } catch (error) { b.reason = String(error.code ?? 'official_target_unavailable'); throw error }
        if (!target.isCurrent()) throw safeError('official_permission_denied')
        return target
      },
      createMessage: value => {
        if (sourceOwners.size >= 256) { b.reason = 'official_source_capacity'; throw safeError('official_source_capacity') }
        const context = value.source.replyContext
        b.sources.set(context.sourceKey, { sourceKey: context.sourceKey, inboundKey: context.inboundKey, replyAnchorKey: context.replyAnchorKey, target: b.target })
        sourceOwners.set(context.sourceKey, b)
        return createMessage(value)
      } })
    const serial = fn => {
      const result = b.serial.then(fn)
      b.serial = result.catch(() => {})
      return track(b, result)
    }
    const canSendReply = ({ replyId, claimKey }) => {
      const item = b.replies.get(replyId)
      if (item && (!available() || !item.source.target.isCurrent())) {
        item.canceled = true
        b.canceledSources.add(item.source.sourceKey)
        if (b.activeClaim === item.claimKey) b.activeClaim = null
      }
      return !!(b.active && available() && item?.ready && !item.canceled && item.claimKey === claimKey && b.claims.get(claimKey) === replyId &&
        !terminal.has(item.outcome) && item.source.target.isCurrent())
    }
    b.handle = Object.freeze({
      inject: async (input, options) => {
        const result = await b.input.inject(input, options)
        if (result.everAccepted && !result.duplicate) cancelActive(b, 'new_input', result.sourceKey)
        return result
      },
      takeReply: ({ claimKey } = {}) => serial(async () => {
        if (!key(claimKey)) throw safeError('official_claim_key_required')
        const existing = b.claims.get(claimKey)
        if (existing) return { reply: copy(b.replies.get(existing).reply) }
        if (!b.active || !available() || b.activeClaim) return { reply: null }
        const item = [...b.replies.values()].find(r => r.ready && !r.canceled && !r.claimKey && !terminal.has(b.anchors.get(r.reply.replyAnchorKey)) && r.source.target.isCurrent())
        if (!item) return { reply: null }
        b.claims.set(claimKey, item.reply.replyId); item.claimKey = claimKey; b.activeClaim = claimKey
        await transact(b, item.source, old => ({ next: { ...old, ownerText: { ...old.ownerText, claimKey }, stateVersion: old.stateVersion + 1 }, value: true }))
        return { reply: copy(item.reply) }
      }),
      canSendReply,
      confirmReply: ({ replyId, claimKey, outcome } = {}) => serial(async () => {
        const item = b.replies.get(replyId)
        if (!item || item.claimKey !== claimKey || b.claims.get(claimKey) !== replyId || ![...terminal, 'rate_limited'].includes(outcome)) return { ok: false, reason: 'official_confirmation_mismatch' }
        if (item.outcome === outcome || terminal.has(item.outcome)) return { ok: item.outcome === outcome, replayed: true, ...(item.outcome !== outcome ? { reason: 'official_terminal' } : {}) }
        const result = await transact(b, item.source, old => {
          const persisted = old.ownerText?.outcome ?? null
          if (persisted === outcome || terminal.has(persisted)) return { next: old, value: { ok: persisted === outcome, replayed: true,
            outcome: persisted, ...(persisted !== outcome ? { reason: 'official_terminal' } : {}) } }
          return { next: { ...old, ownerText: { ...old.ownerText, outcome }, stateVersion: old.stateVersion + 1 }, value: { ok: true, replayed: false, outcome } }
        })
        item.outcome = result.outcome
        if (terminal.has(result.outcome)) { b.anchors.set(item.reply.replyAnchorKey, result.outcome); if (b.activeClaim === claimKey) b.activeClaim = null }
        const { outcome: recorded, ...receipt } = result
        return receipt
      }),
      status: () => ({ active: b.active && available(), available: b.active && available(), reason: b.reason, pendingTasks: b.tasks.size,
        replies: b.replies.size, input: b.input.status().active, inFlightClaim: b.activeClaim !== null }),
      close: async () => {
        b.active = false; b.reason = 'official_closed'; cancelActive(b, 'closed'); b.input.revoke()
        const end = clock.now() + 50
        while (b.tasks.size && clock.now() < end) await new Promise(resolve => clock.setTimeout(resolve, 1))
        const result = await b.input.drain({ timeoutMs: 50 })
        return { ...result, drained: result.drained && b.tasks.size === 0, pendingReplyTasks: b.tasks.size }
      }
    })
    binding = b
    try { onBindingChange() } catch {}
    return b.handle
  }
  const service = Object.freeze({ version: 1, contract: 'owner-text-mvp-1', keyScheme: codec.KEY_SCHEME, codec,
    status: () => ({ available: available(), reason: available() ? null : 'official_unavailable' }), openBinding })
  return Object.freeze({ service, observeSessionEvent, observeClaim, isCurrentOfficialTurn, dispatchTool, contactFor,
    hasBinding: () => binding?.active === true, dispose: () => { disposed = true; return binding?.handle.close() ?? Promise.resolve({ drained: true }) } })
}
