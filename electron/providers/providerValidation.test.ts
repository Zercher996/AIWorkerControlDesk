import { describe, expect, it } from 'vitest'
import { ProviderError } from './providerErrors'
import {
  isModelCompatibleWithWorker,
  normalizeProviderCatalog,
  resolveProviderModel,
  validateProviderCatalog,
  validateProviderForSummary,
  validateProviderForWorker
} from './providerValidation'
import type { ProviderProfile } from '../../src/types/workerDesk'

const provider: ProviderProfile = {
  id: 'anthropic-direct',
  name: 'Anthropic Direct',
  protocol: 'anthropic',
  apiFormat: 'anthropic',
  auth: { type: 'api-key', apiKey: 'sk-ant-secret' },
  endpoint: { baseUrl: 'https://api.anthropic.com' },
  model: { id: 'claude-opus-4-7' },
  models: [{ id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true }],
  defaults: { modelId: 'claude-opus-4-7' },
  adapters: {
    claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true },
    genericAgent: { enabled: true, sessionType: 'native_claude' }
  }
}

const v1Provider = {
  id: 'anthropic-direct',
  name: 'Anthropic Direct',
  protocol: 'anthropic',
  auth: { type: 'api-key', apiKey: 'sk-ant-secret' },
  endpoint: { baseUrl: 'https://api.anthropic.com' },
  model: { id: 'claude-opus-4-7' },
  adapters: {
    claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true },
    genericAgent: { enabled: true, sessionType: 'native_claude' }
  }
} satisfies unknown

describe('providerValidation', () => {
  it('rejects unsupported root fields', () => {
    expect(() => validateProviderCatalog({
      version: 2,
      providers: [{ ...provider, permissionMode: 'default' } as unknown as ProviderProfile]
    })).toThrow('unsupported root field "permissionMode"')
  })

  it('rejects invalid baseUrl', () => {
    expect(() => validateProviderCatalog({
      version: 2,
      providers: [{ ...provider, endpoint: { baseUrl: 'api.anthropic.com' } }]
    })).toThrow('invalid endpoint.baseUrl')
  })

  it('rejects invalid catalog shape', () => {
    expect(() => validateProviderCatalog({ version: 1, providers: [] } as never)).toThrow('version must be 2')
    expect(() => validateProviderCatalog({ version: 2, providers: {} } as never)).toThrow('providers must be an array')
  })

  it('rejects missing auth.apiKey and model.id', () => {
    expect(() => validateProviderCatalog({
      version: 2,
      providers: [{ ...provider, auth: { type: 'api-key', apiKey: '' } }]
    })).toThrow('missing auth.apiKey')

    expect(() => validateProviderCatalog({
      version: 2,
      providers: [{ ...provider, model: { id: '' } }]
    })).toThrow('missing model.id')
  })

  it('rejects openai apiFormat models for Claude Code with structured error', () => {
    const openaiProvider: ProviderProfile = {
      ...provider,
      apiFormat: 'openai_chat',
      protocol: 'openai-compatible',
      model: { id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true },
      models: [{ id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true }],
      defaults: { modelId: 'openai/gpt-4o' },
      adapters: { ...provider.adapters, claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true } }
    }
    expect(() => validateProviderForWorker(openaiProvider, 'claude-code')).toThrow('requires apiFormat "anthropic"')

    try {
      validateProviderForWorker(openaiProvider, 'claude-code')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError)
      expect((error as ProviderError).payload).toMatchObject({
        code: 'PROVIDER_WORKER_COMPATIBILITY_ERROR',
        providerId: 'anthropic-direct',
        modelId: 'openai/gpt-4o',
        apiFormat: 'openai_chat',
        workerType: 'claude-code'
      })
    }
  })

  it('requires Claude Code adapter permissionMode', () => {
    expect(() => validateProviderForWorker({
      ...provider,
      adapters: { claudeCode: { enabled: true, useSettingsEnv: true } as never }
    }, 'claude-code')).toThrow('missing Claude Code permissionMode')
  })

  it('requires GenericAgent adapter sessionType', () => {
    expect(() => validateProviderForWorker({
      ...provider,
      adapters: { genericAgent: { enabled: true } as never }
    }, 'generic-agent')).toThrow('missing GenericAgent sessionType')
  })

  it('rejects openai apiFormat models with native_claude GenericAgent sessionType', () => {
    expect(() => validateProviderForWorker({
      ...provider,
      apiFormat: 'openai_chat',
      protocol: 'openai-compatible',
      model: { id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true },
      models: [{ id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true }],
      defaults: { modelId: 'openai/gpt-4o' },
      adapters: { genericAgent: { enabled: true, sessionType: 'native_claude' } }
    }, 'generic-agent')).toThrow('GenericAgent sessionType must be native_oai')
  })

  it('rejects anthropic-compatible providers with native_oai GenericAgent sessionType', () => {
    expect(() => validateProviderForWorker({
      ...provider,
      protocol: 'anthropic-compatible',
      adapters: { genericAgent: { enabled: true, sessionType: 'native_oai' } }
    }, 'generic-agent')).toThrow('GenericAgent sessionType must be native_claude')
  })

  // Task 1 review gaps

  it('rejects malformed nested defaults fields', () => {
    expect(() => validateProviderCatalog({
      version: 2,
      providers: [{ ...provider, defaults: { timeoutSeconds: '30' } as never }]
    })).toThrow('unsupported defaults field "timeoutSeconds"')
  })

  it('rejects unknown top-level fields on provider', () => {
    expect(() => validateProviderCatalog({
      version: 2,
      providers: [{ ...provider, extraTop: true } as never]
    })).toThrow('unsupported root field "extraTop"')
  })

  it('rejects null as top-level provider field', () => {
    expect(() => validateProviderCatalog({
      version: 2,
      providers: [{ ...provider, notes: null } as never]
    })).toThrow('unsupported root field "notes"')
  })

  it('rejects unknown nested fields inside adapters.claudeCode', () => {
    expect(() => validateProviderCatalog({
      version: 2,
      providers: [{
        ...provider,
        adapters: {
          ...provider.adapters,
          claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true, unknownCcField: 1 } as never
        }
      }]
    })).toThrow('unsupported adapters.claudeCode field "unknownCcField"')
  })

  it('rejects unknown nested fields inside adapters.genericAgent', () => {
    expect(() => validateProviderCatalog({
      version: 2,
      providers: [{
        ...provider,
        adapters: {
          ...provider.adapters,
          genericAgent: { enabled: true, sessionType: 'native_claude', unknownGaField: 'x' } as never
        }
      }]
    })).toThrow('unsupported adapters.genericAgent field "unknownGaField"')
  })

  it('rejects invalid permissionMode value in adapters.claudeCode', () => {
    expect(() => validateProviderCatalog({
      version: 2,
      providers: [{
        ...provider,
        adapters: {
          ...provider.adapters,
          claudeCode: { enabled: true, permissionMode: 'superuser', useSettingsEnv: true } as never
        }
      }]
    })).toThrow('invalid adapters.claudeCode.permissionMode')
  })

  it('rejects invalid sessionType value in adapters.genericAgent', () => {
    expect(() => validateProviderCatalog({
      version: 2,
      providers: [{
        ...provider,
        adapters: {
          ...provider.adapters,
          genericAgent: { enabled: true, sessionType: 'native_unknown' } as never
        }
      }]
    })).toThrow('invalid adapters.genericAgent.sessionType')
  })

  it('normalizes v1 catalog to v2 models and apiFormat', () => {
    const cases = [
      { protocol: 'anthropic', apiFormat: 'anthropic' },
      { protocol: 'anthropic-compatible', apiFormat: 'anthropic' },
      { protocol: 'openai-compatible', apiFormat: 'openai_chat' }
    ] as const

    for (const item of cases) {
      const normalized = normalizeProviderCatalog({
        version: 1,
        providers: [{ ...v1Provider, protocol: item.protocol }]
      })
      const normalizedProvider = normalized.providers[0]
      expect(normalized.version).toBe(2)
      expect(normalizedProvider.apiFormat).toBe(item.apiFormat)
      expect(normalizedProvider.models).toEqual([{ id: 'claude-opus-4-7', apiFormat: item.apiFormat, enabled: true }])
      expect(normalizedProvider.defaults?.modelId).toBe('claude-opus-4-7')
      expect(normalizedProvider.protocol).toBe(item.protocol)
      expect(normalizedProvider.model?.id).toBe('claude-opus-4-7')
    }
  })

  it('validates model-aware worker and summary compatibility', () => {
    const mixedProvider: ProviderProfile = {
      ...provider,
      models: [
        { id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true },
        { id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true },
        { id: 'openai/gpt-5-responses', apiFormat: 'openai_responses', enabled: true },
        { id: 'gemini-2.5-pro', apiFormat: 'gemini_native', enabled: true },
        { id: 'disabled-claude', apiFormat: 'anthropic', enabled: false }
      ],
      defaults: {
        modelId: 'claude-opus-4-7',
        apps: {
          claudeCode: { modelId: 'claude-opus-4-7' },
          genericAgent: { modelId: 'openai/gpt-4o' },
          summary: { modelId: 'claude-opus-4-7' }
        }
      }
    }

    const anthropicModel = resolveProviderModel(mixedProvider, 'claude-opus-4-7')
    const openaiChatModel = resolveProviderModel(mixedProvider, 'openai/gpt-4o')
    const openaiResponsesModel = resolveProviderModel(mixedProvider, 'openai/gpt-5-responses')
    const geminiModel = resolveProviderModel(mixedProvider, 'gemini-2.5-pro')

    expect(isModelCompatibleWithWorker(mixedProvider, anthropicModel, 'claude-code')).toBe(true)
    expect(isModelCompatibleWithWorker(mixedProvider, openaiChatModel, 'claude-code')).toBe(false)
    expect(() => validateProviderForWorker(mixedProvider, 'claude-code', openaiChatModel)).toThrow('requires apiFormat "anthropic"')
    expect(() => validateProviderForWorker(mixedProvider, 'claude-code', openaiResponsesModel)).toThrow('requires apiFormat "anthropic"')
    expect(() => validateProviderForWorker(mixedProvider, 'claude-code', geminiModel)).toThrow('requires apiFormat "anthropic"')

    expect(() => validateProviderForWorker(mixedProvider, 'generic-agent', anthropicModel)).not.toThrow()
    expect(() => validateProviderForWorker(mixedProvider, 'generic-agent', openaiChatModel)).toThrow('GenericAgent sessionType must be native_oai')
    expect(() => validateProviderForWorker({
      ...mixedProvider,
      adapters: { genericAgent: { enabled: true, sessionType: 'native_oai' } }
    }, 'generic-agent', openaiChatModel)).not.toThrow()
    expect(() => validateProviderForWorker({
      ...mixedProvider,
      adapters: { genericAgent: { enabled: true, sessionType: 'native_oai' } }
    }, 'generic-agent', openaiResponsesModel)).not.toThrow()
    expect(() => validateProviderForWorker({
      ...mixedProvider,
      adapters: { genericAgent: { enabled: true, sessionType: 'native_oai' } }
    }, 'generic-agent', anthropicModel)).toThrow('GenericAgent sessionType must be native_claude')

    expect(() => validateProviderForSummary(mixedProvider, anthropicModel)).not.toThrow()
    expect(() => validateProviderForSummary(mixedProvider, openaiChatModel)).toThrow('Summary requires apiFormat "anthropic"')
    expect(() => resolveProviderModel(mixedProvider, 'disabled-claude')).toThrow('disabled')
    expect(() => resolveProviderModel(mixedProvider, 'missing-model')).toThrow('Provider model not found')
  })
})
