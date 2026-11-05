// Memory-only transaction fixture. This proves logical serialization, not disk.
import * as codec from '../../lib/official-c2c-codec.js'
import { createOfficialInput } from '../../lib/official-input.js'
const copy = v => structuredClone(v)
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) }; return v }
export const gate = () => Promise.withResolvers()
export const tick = () => new Promise(resolve => setImmediate(resolve))
export { codec, createOfficialInput }
export class MemoryMetadataStore {
  contract = 'official-input-metadata-v1'
  durability = 'memory-test'
  records = new Map()
  tails = new Map()
  commits = []
  calls = 0
  before = null
  afterCommit = null
  async transaction (key, reducer) {
    // Required secondary uniqueness: the same inbound hash cannot bind two scopes.
    const k = key.inboundKey
    const previous = this.tails.get(k) ?? Promise.resolve()
    const lock = gate()
    this.tails.set(k, previous.catch(() => {}).then(() => lock.promise))
    await previous.catch(() => {})
    try {
      await this.before?.({ key, record: copy(this.records.get(k)), call: ++this.calls })
      const decision = reducer(copy(this.records.get(k)))
      if (decision?.then) throw Error('async reducer forbidden')
      if (decision.next !== undefined) this.records.set(k, freeze(copy(decision.next)))
      this.commits.push({ key: copy(key), record: copy(decision.next) })
      await this.afterCommit?.({ key, record: copy(decision.next), value: copy(decision.value) })
      return copy(decision.value)
    } finally { lock.resolve() }
  }
  async read (key) {
    const k = key.inboundKey
    await (this.tails.get(k) ?? Promise.resolve()).catch(() => {})
    return copy(this.records.get(k))
  }
}
export function identity (n = 'a', overrides = {}) {
  const appId = 'SyntheticApp'
  const id = codec.deriveMessageIdentity({ appId, rawOpenid: 'SyntheticOwnerA', rawMsgId: 'synthetic-message-' + n, indexKind: 'missing', indexValue: '' })
  return { scope: { platform: 'qq-official', appId, ownerHash: id.ownerHash, chatId: id.chatId }, inboundKey: id.inboundKey, replyAnchorKey: id.replyAnchorKey, text: 'synthetic input ' + n, ...overrides }
}
export function fixture (options = {}) {
  const store = options.metadataStore ?? new MemoryMetadataStore()
  const scheduled = [], published = [], registered = [], constructed = []
  let currentGeneration = 1, targetCurrent = true, ids = 0
  const session = { id: 'same-original-session' }
  const agent = { session, followup: message => { published.push(message) } }
  const tracker = { registerSource: source => { registered.push(source); return { ok: true } }, sourceStatus: () => null }
  const target = { agent, session, tracker, isCurrent: () => targetCurrent }
  const worker = { schedule: fn => scheduled.push(fn), wait: async () => ({ kind: 'ready' }), publish: async (_target, fn) => { fn(); return { kind: 'published' } }, ...options.worker }
  const makeMessage = input => {
    const message = freeze({ ...input, id: 'fixed-message-' + ++ids })
    constructed.push(message); return message
  }
  const component = createOfficialInput({ scope: identity().scope, generation: 1, getGeneration: () => currentGeneration, codec,
    metadataStore: store, resolveTarget: async () => target, createMessage: makeMessage, worker,
    clock: { now: Date.now, setTimeout, clearTimeout }, ...options, worker })
  return { component, store, scheduled, published, registered, constructed, target, agent, tracker,
    generation: value => { currentGeneration = value }, replaceTarget: () => { targetCurrent = false },
    async settle () { for (let n = 0; n < 5; n++) await tick() },
    async run () { while (scheduled.length) { scheduled.shift()(); for (let n = 0; n < 5; n++) await tick() }; await tick() }
  }
}
