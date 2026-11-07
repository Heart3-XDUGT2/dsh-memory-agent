/** Actual public host -> claim -> snapshot -> both JS-rendered retrieval routes. */
import { createSocialHost, response, isolation } from './group-social-host.mjs'
import fs from 'node:fs'
import crypto from 'node:crypto'
const [{ createEngine }, { createTurnSnapshot, escapePromptBraces }] = await Promise.all([
  import('../../lib/engine.js'), import('../../lib/turn-snapshot.js')
])

export async function renderPair ({ envelope, contextFixture = {} }) {
  const variants = {}
  for (const enabled of [false, true]) {
    const cleanup = [], captures = new WeakMap(), frameKinds = [], sections = []
    let snapshot, engine, observedAudience = null, messages = [], inputIndex = 0
    const observedAudiences = [], turnMessages = [], turnSections = [], audienceProofs = []
    const retrievalEngines = []
    const state = structuredClone(contextFixture.state ?? {})
    const profile = structuredClone(contextFixture.profile ?? { name: '合成主人' })
    const store = { getState: () => state, getProfile: () => profile,
      retrieve: () => structuredClone(contextFixture.memories ?? []),
      listConversations: () => structuredClone(contextFixture.sharedConversations ?? []) }
    const python = ['python', 'python-down'].includes(contextFixture.engineMode)
    const persona = typeof contextFixture.echoPersona === 'string'
      ? { prefix: contextFixture.echoPersona, suffix: '' } : contextFixture.echoPersona ?? {}
    const personaSections = [
      { name: 'echo:persona', order: 10245, text: typeof persona.prefix === 'string' ? escapePromptBraces(persona.prefix) : '' },
      { name: 'echo:rules', order: 10275, text: typeof persona.suffix === 'string' ? escapePromptBraces(persona.suffix) : '' }
    ].filter(section => section.text !== '')
    const client = { running: true, state: () => ({ breakerOpen: false }),
      start: async () => ({ version: 'synthetic-only' }), stop: async () => {},
      request: async (kind) => {
        frameKinds.push(kind)
        return kind === 'retrieve' ? { text: contextFixture.memoryText ?? '合成背景', items: [] }
          : { pathsText: '', hitEdgeIds: [], ltpEdgeIds: [] }
      } }
    engine = createEngine({ store, dbPath: ':memory:', detect: async () => python
      ? { path: 'synthetic-client-only' } : null, clientOpts: { client } })
    await engine.init()
    if (contextFixture.engineMode === 'python-down') client.running = false
    const h = await createSocialHost({ after: fn => cleanup.push(fn) }, {
      autoReply: false, renderOptions: { groupDialogueContextEnabled: enabled },
      script: request => {
        messages = structuredClone(request.messages); turnMessages.push({ inputIndex, messages })
        return response('合成回复，不发送')
      },
      claimed: ({ agent, message }, participation) => {
        observedAudience = participation.audienceOf(agent.session)
        observedAudiences.push(observedAudience)
        audienceProofs.push(participation.audienceOf({ id: agent.session.id }) === null)
        snapshot.noteClaimed(agent.session.id, message)
      },
      assemble: async (assembly, context, next, participation) => {
        const out = await next(), target = out ?? assembly
        target.sections.push(...personaSections)
        const session = context?.scope?.session
        const snap = await snapshot.compose(session)
        if (snap) {
          const section = snapshot.sectionOf(snap.text)
          target.sections.push(section); sections.push({ name: section.name, text: section.text })
          turnSections.push({ inputIndex, text: section.text })
        }
        return target
      }
    })
    snapshot = createTurnSnapshot({ engine, store,
      readSettings: () => ({ sharedRounds: contextFixture.sharedRounds ?? 0 }),
      captureOf: session => {
        if (!captures.has(session)) captures.set(session, {})
        return captures.get(session)
      },
      readAliases: () => [], readRetiredAliases: () => [],
      onInject: info => retrievalEngines.push(info.engine),
      groupAudienceOf: session => enabled ? h.participation.audienceOf(session) : null })
    try {
      let inboundResult
      for (const input of Array.isArray(envelope) ? envelope : [envelope]) {
        inboundResult = await h.follow(structuredClone(input)); inputIndex++
      }
      variants[enabled ? 'candidate' : 'baseline'] = { messages, sections, enabled, inboundResult,
        audience: observedAudience, observedAudiences, audienceProofs, turnMessages, turnSections,
        endedAudience: h.participation.audienceOf(h.agent.session), frameKinds, inputChars: JSON.stringify(messages).length,
        estimatedInputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(messages), 'utf8') / 4),
        tokenEstimate: 'UTF-8 bytes / 4 heuristic; not model token usage',
        personaIncluded: personaSections.length > 0, personaSections, retrievalEngines,
        sources: ['relay.parseEnvelope/renderInboundText', 'actual agent/inbox/claimed',
          'groupParticipation.audienceOf(actualSession)', 'turnSnapshot.compose',
          contextFixture.engineMode === 'python-down' ? 'unavailable synthetic Python -> JS fallback render'
            : python ? 'synthetic Python material -> JS engine render' : 'JS baseline engine render',
          ...(personaSections.length ? ['synthetic echoPersona -> production escapePromptBraces and actual section names/orders']
            : ['persona absent: no default or real persona file was loaded'])],
        modelRequests: h.requests.length, outboxRows: h.queued.length }
    } finally {
      await engine.stop()
      for (const done of cleanup.reverse()) await done()
    }
  }
  const sourceFiles = ['group-dialogue-context.js', 'group-social.js', 'relay.js', 'context.js', 'engine.js', 'turn-snapshot.js']
    .map(name => ({ path: 'lib/' + name, sha256: crypto.createHash('sha256')
      .update(fs.readFileSync(new URL('../../lib/' + name, import.meta.url))).digest('hex') }))
  return { ...variants, syntheticOnly: true, networkAttempts: isolation.networkAttempts,
    provenance: { sourceFiles, engineMode: contextFixture.engineMode ?? 'baseline',
      personaIncluded: variants.candidate.personaIncluded,
      personaSource: variants.candidate.personaIncluded ? 'provided synthetic echoPersona only' : 'absent',
      groundTruthIncluded: false, runtime: 'real public AgentLoop/ToolRuntime with synthetic adapter' } }
}
