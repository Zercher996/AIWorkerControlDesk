import { readJsonFile, writeJsonFileAtomic } from '../storage/jsonStore'
import type {
  ClaudeCodeProviderOptions,
  GenericAgentProviderOptions,
  ProviderCatalog,
  ProviderCatalogPatch,
  ProviderDefaults,
  ProviderModel,
  ProviderProfile,
  SafeProviderCatalog
} from '../../src/types/workerDesk'
import { normalizeProviderCatalog } from './providerValidation'

export type ProviderCatalogStore = ReturnType<typeof createProviderCatalogStore>

export function createProviderCatalogStore(filePath: string) {
  return {
    async loadProviderCatalog(): Promise<ProviderCatalog> {
      const raw = await readJsonFile<unknown>(filePath, { version: 2, providers: [] })
      return normalizeProviderCatalog(raw)
    },

    async listProviderCatalogSafe(): Promise<SafeProviderCatalog> {
      return toSafeCatalog(await this.loadProviderCatalog())
    },

    async saveProviderCatalog(rawCatalog: unknown): Promise<SafeProviderCatalog> {
      const catalog = normalizeProviderCatalog(rawCatalog)
      rejectPlaceholderKeys(catalog)
      await writeJsonFileAtomic(filePath, catalog)
      return toSafeCatalog(catalog)
    },

    async saveProviderCatalogPatch(patch: ProviderCatalogPatch): Promise<SafeProviderCatalog> {
      const current = normalizeProviderCatalog(await readJsonFile<unknown>(filePath, { version: 2, providers: [] }))
      const currentById = new Map(current.providers.map((provider) => [provider.id, provider]))
      const next = normalizeProviderCatalog({
        version: patch.version,
        providers: patch.providers.map((provider) => {
          const old = currentById.get(provider.id)
          const apiKey = provider.auth.apiKey ?? old?.auth.apiKey
          if (!apiKey) {
            throw new Error(`[ProviderValidation] Provider "${provider.name}" is missing auth.apiKey.`)
          }
          const model = mergeModel(old?.model, provider.model)
          return {
            ...old,
            ...provider,
            auth: { type: 'api-key', apiKey },
            endpoint: {
              ...old?.endpoint,
              ...provider.endpoint
            },
            model,
            models: provider.models ?? (provider.model !== undefined ? undefined : old?.models),
            defaults: mergeDefaults(old?.defaults, provider.defaults),
            adapters: mergeAdapters(old?.adapters, provider.adapters)
          }
        })
      })
      rejectPlaceholderKeys(next)
      await writeJsonFileAtomic(filePath, next)
      return toSafeCatalog(next)
    }
  }
}

function mergeModel(oldModel: ProviderModel | undefined, patchModel: ProviderModel | undefined): ProviderModel | undefined {
  if (patchModel === undefined) return oldModel
  return {
    ...oldModel,
    ...patchModel,
    source: patchModel.source ?? oldModel?.source
  }
}

function mergeDefaults(oldDefaults: ProviderDefaults | undefined, patchDefaults: ProviderDefaults | undefined): ProviderDefaults | undefined {
  if (!oldDefaults && !patchDefaults) return undefined
  return {
    ...oldDefaults,
    ...patchDefaults,
    apps: oldDefaults?.apps || patchDefaults?.apps
      ? {
          ...oldDefaults?.apps,
          ...patchDefaults?.apps,
          claudeCode: oldDefaults?.apps?.claudeCode || patchDefaults?.apps?.claudeCode
            ? { ...oldDefaults?.apps?.claudeCode, ...patchDefaults?.apps?.claudeCode }
            : undefined,
          genericAgent: oldDefaults?.apps?.genericAgent || patchDefaults?.apps?.genericAgent
            ? { ...oldDefaults?.apps?.genericAgent, ...patchDefaults?.apps?.genericAgent }
            : undefined,
          summary: oldDefaults?.apps?.summary || patchDefaults?.apps?.summary
            ? { ...oldDefaults?.apps?.summary, ...patchDefaults?.apps?.summary }
            : undefined
        }
      : undefined
  }
}

function mergeAdapters(
  oldAdapters: ProviderProfile['adapters'] | undefined,
  patchAdapters: ProviderProfile['adapters'] | undefined
): ProviderProfile['adapters'] | undefined {
  if (!oldAdapters && !patchAdapters) return undefined
  const claudeCode = mergeClaudeCodeAdapter(oldAdapters?.claudeCode, patchAdapters?.claudeCode)
  const genericAgent = mergeGenericAgentAdapter(oldAdapters?.genericAgent, patchAdapters?.genericAgent)
  return claudeCode || genericAgent ? { claudeCode, genericAgent } : undefined
}

function mergeClaudeCodeAdapter(
  oldAdapter: ClaudeCodeProviderOptions | undefined,
  patchAdapter: ClaudeCodeProviderOptions | undefined
): ClaudeCodeProviderOptions | undefined {
  if (!oldAdapter && !patchAdapter) return undefined
  return {
    ...oldAdapter,
    ...patchAdapter,
    extraEnv: oldAdapter?.extraEnv || patchAdapter?.extraEnv
      ? { ...oldAdapter?.extraEnv, ...patchAdapter?.extraEnv }
      : undefined
  } as ClaudeCodeProviderOptions
}

function mergeGenericAgentAdapter(
  oldAdapter: GenericAgentProviderOptions | undefined,
  patchAdapter: GenericAgentProviderOptions | undefined
): GenericAgentProviderOptions | undefined {
  if (!oldAdapter && !patchAdapter) return undefined
  return {
    ...oldAdapter,
    ...patchAdapter,
    extraConfig: oldAdapter?.extraConfig || patchAdapter?.extraConfig
      ? { ...oldAdapter?.extraConfig, ...patchAdapter?.extraConfig }
      : undefined
  } as GenericAgentProviderOptions
}

function toSafeCatalog(catalog: ProviderCatalog): SafeProviderCatalog {
  return {
    version: catalog.version,
    providers: catalog.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      apiFormat: provider.apiFormat,
      protocol: provider.protocol,
      auth: {
        type: 'api-key',
        hasApiKey: provider.auth.apiKey.length > 0,
        apiKeyPreview: maskApiKey(provider.auth.apiKey)
      },
      endpoint: provider.endpoint,
      model: provider.model ? toSafeModel(provider.model) : undefined,
      models: provider.models.map((model) => toSafeModel(model)),
      defaults: provider.defaults,
      adapters: provider.adapters
        ? {
            claudeCode: provider.adapters.claudeCode
              ? {
                  enabled: provider.adapters.claudeCode.enabled,
                  permissionMode: provider.adapters.claudeCode.permissionMode,
                  apiKeyEnv: provider.adapters.claudeCode.apiKeyEnv,
                  useSettingsEnv: provider.adapters.claudeCode.useSettingsEnv,
                  extraEnv: undefined,
                  extraConfig: provider.adapters.claudeCode.extraConfig
                }
              : undefined,
            genericAgent: provider.adapters.genericAgent
              ? {
                  enabled: provider.adapters.genericAgent.enabled,
                  sessionType: provider.adapters.genericAgent.sessionType,
                  name: provider.adapters.genericAgent.name,
                  apiMode: provider.adapters.genericAgent.apiMode,
                  fakeCcSystemPrompt: provider.adapters.genericAgent.fakeCcSystemPrompt,
                  thinkingType: provider.adapters.genericAgent.thinkingType,
                  thinkingBudgetTokens: provider.adapters.genericAgent.thinkingBudgetTokens,
                  reasoningEffort: provider.adapters.genericAgent.reasoningEffort,
                  contextWindow: provider.adapters.genericAgent.contextWindow,
                  maxTokens: provider.adapters.genericAgent.maxTokens,
                  temperature: provider.adapters.genericAgent.temperature,
                  userAgent: provider.adapters.genericAgent.userAgent,
                  extraConfig: provider.adapters.genericAgent.extraConfig
                }
              : undefined
          }
        : undefined,
      notes: provider.notes
    }))
  }
}

function toSafeModel(model: ProviderModel): ProviderModel {
  return {
    id: model.id,
    ...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
    ...(model.apiFormat !== undefined ? { apiFormat: model.apiFormat } : {}),
    ...(model.enabled !== undefined ? { enabled: model.enabled } : {}),
    ...(model.source
      ? {
          source: {
            type: model.source.type,
            ...(model.source.providerId !== undefined ? { providerId: model.source.providerId } : {}),
            ...(model.source.appType !== undefined ? { appType: model.source.appType } : {}),
            ...(model.source.modelId !== undefined ? { modelId: model.source.modelId } : {})
          }
        }
      : {})
  }
}

export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 7) return `${apiKey.slice(0, 1)}***${apiKey.slice(-1)}`
  return `${apiKey.slice(0, 3)}***${apiKey.slice(-4)}`
}

function isPlaceholder(value: string): boolean {
  if (!value || value.includes('***')) return true
  if (value === '<your-api-key>' || value === 'your-api-key') return true
  if (/^sk-[x]+$/.test(value)) return true
  if (/^sk-xxx/i.test(value)) return true
  return false
}

function rejectPlaceholderKeys(catalog: ProviderCatalog): void {
  for (const provider of catalog.providers) {
    if (isPlaceholder(provider.auth.apiKey)) {
      throw new Error(`[ProviderValidation] Refusing to save placeholder apiKey for provider "${provider.name}".`)
    }
    if (provider.adapters?.claudeCode?.extraEnv) {
      for (const [key, value] of Object.entries(provider.adapters.claudeCode.extraEnv)) {
        if (isPlaceholder(value)) {
          throw new Error(`[ProviderValidation] Refusing to save placeholder value in adapters.claudeCode.extraEnv.${key} for provider "${provider.name}".`)
        }
      }
    }
  }
}
