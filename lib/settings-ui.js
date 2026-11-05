/** Read-only UI metadata; defaults and validation remain in their existing owners. */
import { SETTINGS_FIELDS } from './settings-fields.js'
import { DATA_FILES, fieldsOf } from './data-schema.js'
import { effectiveOf } from './data-write.js'
import { createHash } from 'node:crypto'

const bookkeeping = new Set(['schemaRev', 'savedAt', 'updatedAt', 'edited', 'defaultsRev'])
const blocked = new Set(['__proto__', 'constructor', 'prototype'])
export function safeSettingsObject (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const safe = v => !v || typeof v !== 'object' || Object.keys(v).every(k => !blocked.has(k) && safe(v[k]))
  return safe(value)
}
export function publicSettings (settings) {
  return { ...settings, relay: { ...settings?.relay, token: '' } }
}
export function settingsRevision (settings) {
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex')
}
export function panelSettingsPatch (patch) {
  if (!safeSettingsObject(patch)) return null
  const next = structuredClone(patch)
  for (const group of SETTINGS_FIELDS) for (const field of group.fields) if (field.readOnly || field.derived) {
    const parts = [...(group.nested ? [group.nested] : []), ...field.key.split('.')]
    let obj = next
    for (const key of parts.slice(0, -1)) obj = obj && typeof obj === 'object' ? obj[key] : null
    if (obj && typeof obj === 'object') delete obj[parts.at(-1)]
  }
  if (next.relay?.token === '') delete next.relay.token
  return next
}
export function settingsUIManifest () {
  return {
    version: 1,
    files: DATA_FILES.filter(file => file !== 'config.json').map(file => ({
      file, effective: effectiveOf(file),
      fields: fieldsOf(file).map(field => ({ ...field, readOnly: bookkeeping.has(field.key) }))
    })),
    controls: [
      { id: 'power', path: '/api/echo/toggle', readPath: '/api/echo/status', readKey: 'enabled', key: 'enabled', label: 'Echo在线', type: 'bool', effective: 'now' },
      { id: 'scope', path: '/api/echo/scope', key: 'scope', label: '启用范围', type: 'enum', options: [{ value: 'all', label: '所有顶层会话' }, { value: 'whitelist', label: '仅选中的会话' }], effective: 'next-turn' },
      { id: 'memory-tools', path: '/api/echo/memory-tools', key: 'enabled', readKey: 'panelValue', label: '子代理只读记忆工具', type: 'bool', effective: 'applied' },
      { id: 'graph-gate', path: '/api/echo/graph-gate', key: 'enabled', readKey: 'panelValue', label: '新记忆自动挖影子边', type: 'bool', effective: 'next-engine-call' },
      { id: 'qq-pin', path: '/api/echo/qq-pin', key: 'sessionId', label: 'QQ兜底会话', type: 'session', effective: 'next-turn' }
    ]
  }
}
