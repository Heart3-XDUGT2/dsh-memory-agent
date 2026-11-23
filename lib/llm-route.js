const clean = value => typeof value === 'string' ? value.trim() : ''

export function resolveLlmRoute ({ settings = {}, sessionRoute = null } = {}) {
  const configuredProvider = clean(settings.llmProvider)
  const configuredModel = clean(settings.llmModel)
  if (configuredProvider && configuredModel) {
    return { provider: configuredProvider, model: configuredModel, source: 'plugin-config' }
  }
  const provider = clean(sessionRoute?.provider)
  const model = clean(sessionRoute?.model)
  if (provider && model) return { provider, model, source: 'session' }
  return { provider: '', model: '', source: 'none' }
}
