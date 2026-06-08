import { ProviderError } from './providerErrors'
import type { ProviderProfile, ProviderCatalog, PermissionMode, GenericAgentSessionType, ProviderApiFormat, ProviderModel, ProviderModelSource, ProviderProtocol, WorkerType } from '../../src/types/workerDesk'

const VALID_ROOT_FIELDS = new Set([
  'id', 'name', 'apiFormat', 'protocol', 'auth', 'endpoint', 'model', 'models',
  'defaults', 'adapters', 'notes'
])

const VALID_MODEL_FIELDS = new Set([
  'id', 'displayName', 'apiFormat', 'enabled', 'source'
])

const VALID_MODEL_SOURCE_FIELDS = new Set([
  'type', 'providerId', 'appType', 'modelId'
])

const VALID_DEFAULTS_FIELDS = new Set([
  'modelId', 'apps', 'timeoutSeconds', 'readTimeoutSeconds', 'maxRetries', 'stream', 'proxy'
])

const VALID_DEFAULTS_APPS_FIELDS = new Set(['claudeCode', 'genericAgent', 'summary'])

const VALID_DEFAULT_APP_FIELDS = new Set(['modelId'])

const VALID_CC_FIELDS = new Set([
  'enabled', 'permissionMode', 'apiKeyEnv', 'useSettingsEnv', 'extraEnv', 'extraConfig'
])

const VALID_GA_FIELDS = new Set([
  'enabled', 'sessionType', 'name', 'apiMode',
  'fakeCcSystemPrompt', 'thinkingType', 'thinkingBudgetTokens',
  'reasoningEffort', 'contextWindow', 'maxTokens', 'temperature',
  'userAgent', 'extraConfig'
])

const VALID_PERMISSION_MODES: PermissionMode[] = [
  'default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk'
]

const VALID_PROTOCOLS = new Set(['anthropic', 'anthropic-compatible', 'openai-compatible'])

const VALID_API_FORMATS: ProviderApiFormat[] = ['anthropic', 'openai_chat', 'openai_responses', 'gemini_native']

const VALID_MODEL_SOURCE_TYPES: ProviderModelSource['type'][] = ['manual', 'ccswitch']

const VALID_MODEL_SOURCE_APP_TYPES: NonNullable<ProviderModelSource['appType']>[] = ['claude', 'codex', 'gemini']

const VALID_SESSION_TYPES: GenericAgentSessionType[] = ['native_claude', 'native_oai']

export function normalizeProviderCatalog(raw: unknown): ProviderCatalog {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('catalog must be an object')
  }

  const catalog = raw as { version?: unknown; providers?: unknown }
  if (catalog.version !== 1 && catalog.version !== 2) {
    throw new Error('version must be 2')
  }
  if (!Array.isArray(catalog.providers)) {
    throw new Error('providers must be an array')
  }

  const normalized: ProviderCatalog = {
    version: 2,
    providers: catalog.providers.map((provider) => normalizeProviderProfile(provider))
  }
  validateProviderCatalog(normalized)
  return normalized
}

export function normalizeProviderProfile(raw: unknown): ProviderProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('provider must be an object')
  }

  const provider = raw as ProviderProfile & { protocol?: ProviderProtocol; model?: ProviderModel; models?: ProviderModel[] }
  const protocol = provider.protocol
  const apiFormat = provider.apiFormat ?? apiFormatFromProtocol(protocol)
  const models = normalizeModels(provider.models, provider.model, apiFormat)
  const defaultModelId = provider.defaults?.modelId ?? provider.model?.id ?? models[0]?.id

  return {
    ...provider,
    apiFormat,
    ...(protocol !== undefined ? { protocol } : {}),
    ...(provider.model !== undefined ? { model: normalizeModel(provider.model, apiFormat) } : { model: models[0] }),
    models,
    defaults: {
      ...(provider.defaults ?? {}),
      ...(defaultModelId ? { modelId: defaultModelId } : {})
    }
  }
}

function apiFormatFromProtocol(protocol: ProviderProtocol | undefined): ProviderApiFormat {
  if (protocol === 'openai-compatible') return 'openai_chat'
  return 'anthropic'
}

function normalizeModels(models: ProviderModel[] | undefined, legacyModel: ProviderModel | undefined, apiFormat: ProviderApiFormat): ProviderModel[] {
  const sourceModels = Array.isArray(models) && models.length > 0
    ? models
    : legacyModel
      ? [legacyModel]
      : []
  return sourceModels.map((model) => normalizeModel(model, apiFormat))
}

function normalizeModel(model: ProviderModel, fallbackApiFormat: ProviderApiFormat): ProviderModel {
  return {
    ...model,
    apiFormat: model.apiFormat ?? fallbackApiFormat,
    enabled: model.enabled ?? true,
    ...(model.source ? { source: copyModelSource(model.source) } : {})
  }
}

function copyModelSource(source: ProviderModelSource): ProviderModelSource {
  return {
    type: source.type,
    ...(source.providerId !== undefined ? { providerId: source.providerId } : {}),
    ...(source.appType !== undefined ? { appType: source.appType } : {}),
    ...(source.modelId !== undefined ? { modelId: source.modelId } : {})
  }
}

export function validateProviderCatalog(catalog: ProviderCatalog): void {
  if (catalog.version !== 2) {
    throw new Error('version must be 2')
  }
  if (!Array.isArray(catalog.providers)) {
    throw new Error('providers must be an array')
  }
  for (const provider of catalog.providers) {
    validateProviderProfile(provider)
  }
}

function validateProviderProfile(provider: ProviderProfile): void {
  for (const key of Object.keys(provider)) {
    if (!VALID_ROOT_FIELDS.has(key)) {
      throw new Error(`unsupported root field "${key}"`)
    }
  }

  if (provider.protocol !== undefined && !VALID_PROTOCOLS.has(provider.protocol)) {
    throw new Error(`invalid protocol "${provider.protocol}"`)
  }

  if (!VALID_API_FORMATS.includes(provider.apiFormat)) {
    throw new Error(`invalid apiFormat "${provider.apiFormat}"`)
  }

  if (provider.auth.type !== 'api-key' || !provider.auth.apiKey) {
    throw new Error('missing auth.apiKey')
  }

  if (!provider.endpoint?.baseUrl?.startsWith('http')) {
    throw new Error('invalid endpoint.baseUrl')
  }

  if (provider.model !== undefined) {
    validateProviderModel(provider.model, 'model')
  }

  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    throw new Error('missing models')
  }
  provider.models.forEach((model, index) => validateProviderModel(model, `models[${index}]`))

  if (provider.notes !== undefined && typeof provider.notes !== 'string') {
    throw new Error(`unsupported root field "notes"`)
  }

  if (provider.defaults) {
    for (const key of Object.keys(provider.defaults)) {
      if (!VALID_DEFAULTS_FIELDS.has(key)) {
        throw new Error(`unsupported defaults field "${key}"`)
      }
    }
    if (provider.defaults.modelId !== undefined && typeof provider.defaults.modelId !== 'string') {
      throw new Error(`unsupported defaults field "modelId"`)
    }
    if (provider.defaults.apps !== undefined) {
      if (typeof provider.defaults.apps !== 'object' || provider.defaults.apps === null || Array.isArray(provider.defaults.apps)) {
        throw new Error(`unsupported defaults field "apps"`)
      }
      for (const [appKey, appDefaults] of Object.entries(provider.defaults.apps)) {
        if (!VALID_DEFAULTS_APPS_FIELDS.has(appKey)) {
          throw new Error(`unsupported defaults.apps field "${appKey}"`)
        }
        if (appDefaults !== undefined) {
          if (typeof appDefaults !== 'object' || appDefaults === null || Array.isArray(appDefaults)) {
            throw new Error(`unsupported defaults.apps.${appKey}`)
          }
          for (const key of Object.keys(appDefaults)) {
            if (!VALID_DEFAULT_APP_FIELDS.has(key)) {
              throw new Error(`unsupported defaults.apps.${appKey} field "${key}"`)
            }
          }
          if (appDefaults.modelId !== undefined && typeof appDefaults.modelId !== 'string') {
            throw new Error(`unsupported defaults.apps.${appKey}.modelId`)
          }
        }
      }
    }
    if (provider.defaults.timeoutSeconds !== undefined && typeof provider.defaults.timeoutSeconds !== 'number') {
      throw new Error(`unsupported defaults field "timeoutSeconds"`)
    }
    if (provider.defaults.readTimeoutSeconds !== undefined && typeof provider.defaults.readTimeoutSeconds !== 'number') {
      throw new Error(`unsupported defaults field "readTimeoutSeconds"`)
    }
    if (provider.defaults.maxRetries !== undefined && typeof provider.defaults.maxRetries !== 'number') {
      throw new Error(`unsupported defaults field "maxRetries"`)
    }
    if (provider.defaults.stream !== undefined && typeof provider.defaults.stream !== 'boolean') {
      throw new Error(`unsupported defaults field "stream"`)
    }
    if (provider.defaults.proxy !== undefined && typeof provider.defaults.proxy !== 'string') {
      throw new Error(`unsupported defaults field "proxy"`)
    }
  }

  if (provider.adapters?.claudeCode) {
    const cc = provider.adapters.claudeCode
    for (const key of Object.keys(cc)) {
      if (!VALID_CC_FIELDS.has(key)) {
        throw new Error(`unsupported adapters.claudeCode field "${key}"`)
      }
    }
    if (cc.permissionMode !== undefined && !VALID_PERMISSION_MODES.includes(cc.permissionMode)) {
      throw new Error(`invalid adapters.claudeCode.permissionMode "${cc.permissionMode}"`)
    }
    if (cc.useSettingsEnv !== undefined && cc.useSettingsEnv !== true) {
      throw new Error(`invalid adapters.claudeCode.useSettingsEnv`)
    }
    if (cc.extraEnv !== undefined && (typeof cc.extraEnv !== 'object' || Array.isArray(cc.extraEnv))) {
      throw new Error(`invalid adapters.claudeCode.extraEnv`)
    }
    if (cc.extraEnv) {
      for (const [k, v] of Object.entries(cc.extraEnv)) {
        if (typeof v !== 'string') {
          throw new Error(`invalid adapters.claudeCode.extraEnv value for key "${k}"`)
        }
      }
    }
    if (cc.extraConfig !== undefined && (typeof cc.extraConfig !== 'object' || Array.isArray(cc.extraConfig))) {
      throw new Error(`invalid adapters.claudeCode.extraConfig`)
    }
  }

  if (provider.adapters?.genericAgent) {
    const ga = provider.adapters.genericAgent
    for (const key of Object.keys(ga)) {
      if (!VALID_GA_FIELDS.has(key)) {
        throw new Error(`unsupported adapters.genericAgent field "${key}"`)
      }
    }
    if (ga.sessionType !== undefined && !VALID_SESSION_TYPES.includes(ga.sessionType)) {
      throw new Error(`invalid adapters.genericAgent.sessionType "${ga.sessionType}"`)
    }
    if (ga.enabled !== undefined && typeof ga.enabled !== 'boolean') {
      throw new Error(`invalid adapters.genericAgent.enabled`)
    }
    if (ga.fakeCcSystemPrompt !== undefined && typeof ga.fakeCcSystemPrompt !== 'boolean') {
      throw new Error(`invalid adapters.genericAgent.fakeCcSystemPrompt`)
    }
    if (ga.thinkingBudgetTokens !== undefined && typeof ga.thinkingBudgetTokens !== 'number') {
      throw new Error(`invalid adapters.genericAgent.thinkingBudgetTokens`)
    }
    if (ga.contextWindow !== undefined && typeof ga.contextWindow !== 'number') {
      throw new Error(`invalid adapters.genericAgent.contextWindow`)
    }
    if (ga.maxTokens !== undefined && typeof ga.maxTokens !== 'number') {
      throw new Error(`invalid adapters.genericAgent.maxTokens`)
    }
    if (ga.temperature !== undefined && typeof ga.temperature !== 'number') {
      throw new Error(`invalid adapters.genericAgent.temperature`)
    }
    if (ga.extraConfig !== undefined && (typeof ga.extraConfig !== 'object' || Array.isArray(ga.extraConfig))) {
      throw new Error(`invalid adapters.genericAgent.extraConfig`)
    }
  }
}

function validateProviderModel(model: ProviderModel, path: 'model' | `models[${number}]`): void {
  for (const key of Object.keys(model)) {
    if (!VALID_MODEL_FIELDS.has(key)) {
      throw new Error(`unsupported ${path} field "${key}"`)
    }
  }
  if (!model.id) {
    throw new Error(path === 'model' ? 'missing model.id' : `missing ${path}.id`)
  }
  if (model.displayName !== undefined && typeof model.displayName !== 'string') {
    throw new Error(`invalid ${path}.displayName`)
  }
  if (model.apiFormat !== undefined && !VALID_API_FORMATS.includes(model.apiFormat)) {
    throw new Error(`invalid ${path}.apiFormat "${model.apiFormat}"`)
  }
  if (model.enabled !== undefined && typeof model.enabled !== 'boolean') {
    throw new Error(`invalid ${path}.enabled`)
  }
  if (model.source !== undefined) {
    validateProviderModelSource(model.source)
  }
}

function validateProviderModelSource(source: ProviderModelSource): void {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('invalid models.source')
  }
  for (const key of Object.keys(source)) {
    if (!VALID_MODEL_SOURCE_FIELDS.has(key)) {
      throw new Error(`unsupported models.source field "${key}"`)
    }
  }
  if (!VALID_MODEL_SOURCE_TYPES.includes(source.type)) {
    throw new Error(`invalid models.source.type "${source.type}"`)
  }
  if (source.providerId !== undefined && typeof source.providerId !== 'string') {
    throw new Error('invalid models.source.providerId')
  }
  if (source.appType !== undefined && !VALID_MODEL_SOURCE_APP_TYPES.includes(source.appType)) {
    throw new Error(`invalid models.source.appType "${source.appType}"`)
  }
  if (source.modelId !== undefined && typeof source.modelId !== 'string') {
    throw new Error('invalid models.source.modelId')
  }
}

export function resolveProviderModel(
  provider: ProviderProfile,
  providerModelId?: string,
  app?: 'claudeCode' | 'genericAgent' | 'summary'
): ProviderModel {
  validateProviderProfile(provider)
  const modelId = providerModelId
    ?? (app ? provider.defaults?.apps?.[app]?.modelId : undefined)
    ?? provider.defaults?.modelId
    ?? provider.model?.id
    ?? provider.models[0]?.id
  const model = provider.models.find((item) => item.id === modelId)
  if (!model) {
    throw new Error(`Provider model not found: ${modelId ?? '(none)'}`)
  }
  if (model.enabled === false) {
    throw new Error(`Provider model is disabled: ${model.id}`)
  }
  return model
}

export function resolveModelApiFormat(provider: ProviderProfile, model: ProviderModel): ProviderApiFormat {
  return model.apiFormat ?? provider.apiFormat
}

export function isModelCompatibleWithWorker(provider: ProviderProfile, model: ProviderModel, workerType: WorkerType): boolean {
  const apiFormat = resolveModelApiFormat(provider, model)
  if (workerType === 'claude-code') return apiFormat === 'anthropic'
  const sessionType = provider.adapters?.genericAgent?.sessionType
  if (sessionType === 'native_claude') return apiFormat === 'anthropic'
  if (sessionType === 'native_oai') return apiFormat === 'openai_chat' || apiFormat === 'openai_responses'
  return false
}

export function validateProviderForSummary(provider: ProviderProfile, model: ProviderModel): void {
  validateProviderProfile(provider)
  if (model.enabled === false) {
    throw new Error(`Provider model is disabled: ${model.id}`)
  }
  const apiFormat = resolveModelApiFormat(provider, model)
  if (apiFormat !== 'anthropic') {
    throw new ProviderError(
      `Summary requires apiFormat "anthropic", got "${apiFormat}" for model "${model.id}".`,
      {
        code: 'PROVIDER_WORKER_COMPATIBILITY_ERROR',
        providerId: provider.id,
        modelId: model.id,
        apiFormat,
        workerType: 'summary'
      }
    )
  }
}

export function validateProviderForWorker(
  provider: ProviderProfile,
  workerType: 'claude-code' | 'generic-agent',
  model?: ProviderModel
): void {
  validateProviderProfile(provider)

  const resolvedModel = model ?? resolveProviderModel(provider, undefined, workerType === 'claude-code' ? 'claudeCode' : 'genericAgent')
  if (resolvedModel.enabled === false) {
    throw new Error(`Provider model is disabled: ${resolvedModel.id}`)
  }
  const apiFormat = resolveModelApiFormat(provider, resolvedModel)

  if (workerType === 'claude-code') {
    const ccRelayAllowed = apiFormat === 'openai_chat' && provider.adapters?.claudeCode?.extraConfig?.relay === true
    if (apiFormat !== 'anthropic' && !ccRelayAllowed) {
      throw new ProviderError(
        `Claude Code requires apiFormat "anthropic", got "${apiFormat}" for model "${resolvedModel.id}".`,
        {
          code: 'PROVIDER_WORKER_COMPATIBILITY_ERROR',
          providerId: provider.id,
          modelId: resolvedModel.id,
          apiFormat,
          workerType
        }
      )
    }
    const cc = provider.adapters?.claudeCode
    if (!cc?.permissionMode) {
      throw new Error('missing Claude Code permissionMode')
    }
  }

  if (workerType === 'generic-agent') {
    const ga = provider.adapters?.genericAgent
    if (!ga?.sessionType) {
      throw new Error('missing GenericAgent sessionType')
    }
    if ((apiFormat === 'openai_chat' || apiFormat === 'openai_responses') && ga.sessionType !== 'native_oai') {
      throw new Error('GenericAgent sessionType must be native_oai')
    }
    if (apiFormat === 'anthropic' && ga.sessionType !== 'native_claude') {
      throw new Error('GenericAgent sessionType must be native_claude')
    }
    if (apiFormat === 'gemini_native') {
      throw new ProviderError(
        `GenericAgent does not support apiFormat "${apiFormat}" for model "${resolvedModel.id}".`,
        {
          code: 'PROVIDER_WORKER_COMPATIBILITY_ERROR',
          providerId: provider.id,
          modelId: resolvedModel.id,
          apiFormat,
          workerType
        }
      )
    }
  }
}
