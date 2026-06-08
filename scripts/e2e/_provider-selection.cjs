function isEnabled(value) {
  return value !== false
}

function apiFormatForModel(provider, model) {
  return model?.apiFormat ?? provider.apiFormat
}

function isClaudeCodeModelCompatible(provider, model) {
  const apiFormat = apiFormatForModel(provider, model)
  return apiFormat === 'anthropic' || (apiFormat === 'openai_chat' && provider.adapters?.claudeCode?.extraConfig?.relay === true)
}

function isGenericAgentModelCompatible(provider, model) {
  const apiFormat = apiFormatForModel(provider, model)
  const sessionType = provider.adapters?.genericAgent?.sessionType
  if (sessionType === 'native_claude') return apiFormat === 'anthropic'
  if (sessionType === 'native_oai') return apiFormat === 'openai_chat' || apiFormat === 'openai_responses'
  return false
}

function pickEnabledCompatibleModel(provider, workerKey, isCompatible, requestedModelId) {
  const models = Array.isArray(provider.models) ? provider.models : []
  const enabledModels = models.filter((model) => isEnabled(model.enabled))
  if (requestedModelId) {
    const requested = enabledModels.find((model) => model.id === requestedModelId)
    return requested && isCompatible(provider, requested) ? requested.id : null
  }

  const preferredIds = [provider.defaults?.apps?.[workerKey]?.modelId, provider.defaults?.modelId, provider.model?.id].filter(Boolean)
  for (const id of preferredIds) {
    const preferred = enabledModels.find((model) => model.id === id)
    if (preferred && isCompatible(provider, preferred)) return preferred.id
  }
  return enabledModels.find((model) => isCompatible(provider, model))?.id ?? null
}

function pickClaudeCodeProvider(catalog, requestedProviderId, requestedModelId) {
  const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
  const candidates = providers.filter((provider) => provider.adapters?.claudeCode?.enabled === true)
  const providerCandidates = requestedProviderId
    ? candidates.filter((item) => item.id === requestedProviderId)
    : candidates
  for (const provider of providerCandidates) {
    const modelId = pickEnabledCompatibleModel(provider, 'claudeCode', isClaudeCodeModelCompatible, requestedModelId)
    if (modelId) return { provider, modelId, reason: null }
  }
  if (requestedProviderId && providerCandidates.length === 0) {
    return {
      provider: null,
      modelId: null,
      reason: `Provider ${requestedProviderId} is not available for Claude Code; available Claude Code providers: ${candidates.map((item) => item.id).join(', ') || 'none'}`
    }
  }
  return {
    provider: providerCandidates[0] ?? null,
    modelId: null,
    reason: requestedProviderId
      ? `Provider ${requestedProviderId} has no enabled Claude Code-compatible model`
      : `No Claude Code-compatible provider with an enabled model is available; catalog providers: ${providers.map((item) => item.id).join(', ') || 'none'}`
  }
}

function pickGenericAgentProvider(catalog, requestedProviderId, requestedModelId) {
  const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
  const candidates = providers.filter((provider) => provider.adapters?.genericAgent?.enabled === true)
  const providerCandidates = requestedProviderId
    ? candidates.filter((item) => item.id === requestedProviderId)
    : candidates
  for (const provider of providerCandidates) {
    const modelId = pickEnabledCompatibleModel(provider, 'genericAgent', isGenericAgentModelCompatible, requestedModelId)
    if (modelId) return { provider, modelId, reason: null }
  }
  if (requestedProviderId && providerCandidates.length === 0) {
    return {
      provider: null,
      modelId: null,
      reason: `Provider ${requestedProviderId} is not available for GenericAgent; available GenericAgent providers: ${candidates.map((item) => item.id).join(', ') || 'none'}`
    }
  }
  return {
    provider: providerCandidates[0] ?? null,
    modelId: null,
    reason: requestedProviderId
      ? `Provider ${requestedProviderId} has no enabled GenericAgent-compatible model`
      : `No GenericAgent-compatible provider with an enabled model is available; catalog providers: ${providers.map((item) => item.id).join(', ') || 'none'}`
  }
}

module.exports = {
  pickClaudeCodeProvider,
  pickGenericAgentProvider
}
