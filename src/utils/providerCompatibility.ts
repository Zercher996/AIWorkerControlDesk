import type { ProviderApiFormat, ProviderModel, SafeProviderCatalog, SafeProviderProfile, WorkerType } from '../types/workerDesk'

function getProviderModels(provider: SafeProviderProfile): ProviderModel[] {
  const models = Array.isArray(provider.models) ? provider.models : []
  if (models.length > 0) return models
  return provider.model ? [provider.model] : []
}

function getProviderApiFormat(provider: SafeProviderProfile): ProviderApiFormat {
  if (provider.apiFormat) return provider.apiFormat
  return provider.protocol === 'openai-compatible' ? 'openai_chat' : 'anthropic'
}

export function getModelApiFormat(provider: SafeProviderProfile, model: ProviderModel): ProviderApiFormat {
  return model.apiFormat ?? getProviderApiFormat(provider)
}

export function isModelEnabled(model: ProviderModel): boolean {
  return model.enabled !== false
}

export function isModelCompatibleWithWorker(provider: SafeProviderProfile, model: ProviderModel, workerType: WorkerType): boolean {
  if (!isModelEnabled(model)) return false
  const apiFormat = getModelApiFormat(provider, model)
  if (workerType === 'claude-code') {
    const ccRelayAllowed = apiFormat === 'openai_chat' && provider.adapters?.claudeCode?.extraConfig?.relay === true
    return provider.adapters?.claudeCode?.enabled !== false && (apiFormat === 'anthropic' || ccRelayAllowed)
  }
  const sessionType = provider.adapters?.genericAgent?.sessionType
  if (sessionType === 'native_claude') return apiFormat === 'anthropic'
  if (sessionType === 'native_oai') return apiFormat === 'openai_chat' || apiFormat === 'openai_responses'
  return apiFormat === 'anthropic'
}

export function getCompatibleModels(provider: SafeProviderProfile, workerType: WorkerType): ProviderModel[] {
  return getProviderModels(provider).filter((model) => isModelCompatibleWithWorker(provider, model, workerType))
}

export function getCompatibleProviders(catalog: SafeProviderCatalog | undefined, workerType: WorkerType): SafeProviderProfile[] {
  return (catalog?.providers ?? []).filter((provider) => getCompatibleModels(provider, workerType).length > 0)
}

export function getDefaultProviderModelId(provider: SafeProviderProfile | undefined): string | undefined {
  if (!provider) return undefined
  const defaultModel = provider.defaults?.modelId
  const models = getProviderModels(provider)
  if (defaultModel && models.some((model) => model.id === defaultModel && isModelEnabled(model))) {
    return defaultModel
  }
  const legacyModel = provider.model?.id
  if (legacyModel && models.some((model) => model.id === legacyModel && isModelEnabled(model))) {
    return legacyModel
  }
  return models.find(isModelEnabled)?.id
}

export function hasProviderModel(provider: SafeProviderProfile | undefined, providerModelId: string | undefined): boolean {
  if (!provider || !providerModelId) return false
  return getProviderModels(provider).some((model) => model.id === providerModelId && isModelEnabled(model))
}
