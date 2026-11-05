// Reuse real public-host assembly and its pre-import filesystem/network isolation.
import { host, createUserMessage } from './echo020-host.mjs'
import { MemoryMetadataStore } from './echo022-state.mjs'
import { createOfficialOwnerText } from '../../lib/official-owner-text.js'
import { relayToolDefinitions } from '../../lib/relay-tools.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
export { response, local, traces, isolation, cleanTmp } from './echo020-host.mjs'
export { identity, gate } from './echo022-state.mjs'
export async function until (predicate, timeout = 3000) {
  const end = Date.now() + timeout
  while (!predicate()) { if (Date.now() > end) throw Error('synthetic_timeout'); await new Promise(resolve => setTimeout(resolve, 2)) }
}
export async function coreHost (t, options = {}) {
  const h = await host(t, { script: options.script, preStep: options.preStep })
  const store = options.metadataStore ?? new MemoryMetadataStore()
  const oldCalls = [], oldAuto = [], rendered = [], registered = new Set()
  let targetCurrent = true, enabled = true, legacyEnabled = !!options.legacy, selections = 0, owner
  const register = () => {
    for (const def of relayToolDefinitions({
      relay: { say: args => { oldCalls.push(args); return { ok: true, sent: 1, chars: args.text.length, kind: args.mode, targets: ['synthetic-legacy'] } } },
      isEnabled: () => legacyEnabled, sessionEnabledOf: () => true,
      dispatchOfficial: value => owner.dispatchTool(value), guard: options.guard
    })) {
      if (registered.has(def.name) || (def.name === 'echo_qq_call' && !legacyEnabled)) continue
      const render = def.output.render
      def.output.render = (args, value) => { const result = render(args, value); rendered.push({ value, result }); return result }
      h.ctx.tools.register(defineTool(def)); registered.add(def.name)
    }
  }
  owner = createOfficialOwnerText({
    resolveTarget: async () => { selections++; return { agent: h.agent, session: h.agent.session, isCurrent: () => targetCurrent } },
    createMessage: createUserMessage, isEnabled: () => enabled, isSessionEnabled: options.sessionAllowed ?? (() => true),
    supportsHost: () => !!h.ctx.get('sessionProjections'), onBindingChange: register,
    allowMemoryMetadata: options.allowMemoryMetadata ?? store.durability === 'memory-test'
  })
  h.ctx.on('agent/inbox/claimed', payload => owner.observeClaim(payload))
  h.ctx.on('session/event', (session, event) => {
    const observation = owner.observeSessionEvent(session, event)
    if (legacyEnabled && !observation.suppressLegacy && ['assistant/message', 'turn/end'].includes(event.type)) oldAuto.push(event.type)
  })
  h.ctx.provide('echo:relay', { officialOwnerText: owner.service })
  t.after(async () => { await owner.dispose() })
  let binding
  const scope = (await import('./echo022-state.mjs')).identity().scope
  if (options.bind !== false) binding = await owner.service.openBinding({ scope,
    authorization: { kind: 'local-explicit-owner', authorized: true, appId: scope.appId, ownerHash: scope.ownerHash }, metadataStore: store })
  return { h, owner, service: owner.service, binding, store, oldCalls, oldAuto, rendered, registered, scope,
    selections: () => selections, invalidate: () => { targetCurrent = false }, restoreTarget: () => { targetCurrent = true }, powerOff: () => { enabled = false },
    enableLegacy: () => { legacyEnabled = true; register() },
    async reply (claimKey = 'synthetic-claim') {
      let taken
      await until(() => h.requests.length > 0)
      await h.agent.whenIdle()
      for (let i = 0; i < 100; i++) {
        taken = await binding.takeReply({ claimKey })
        if (taken.reply) return taken.reply
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      throw Error('synthetic_reply_missing:' + binding.status().reason)
    },
    async quiet () { await new Promise(resolve => setTimeout(resolve, 20)); await h.agent.whenIdle(); await new Promise(resolve => setTimeout(resolve, 5)) }
  }
}
