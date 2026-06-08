import { describe, expect, it } from 'vitest'
import type { SafeProviderCatalog } from '../types/workerDesk'
import { getCompatibleModels, getCompatibleProviders } from './providerCompatibility'

const catalog: SafeProviderCatalog = {
  version: 2,
  providers: [
    {
      id: 'anthropic-provider',
      name: 'Anthropic Provider',
      apiFormat: 'anthropic',
      auth: { type: 'api-key', hasApiKey: true, apiKeyPreview: 'sk-***' },
      endpoint: { baseUrl: 'https://api.anthropic.com' },
      models: [
        { id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true },
        { id: 'disabled-claude', apiFormat: 'anthropic', enabled: false }
      ],
      defaults: { modelId: 'claude-opus-4-7' },
      adapters: {
        claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true },
        genericAgent: { enabled: true, sessionType: 'native_claude' }
      }
    },
    {
      id: 'openai-provider',
      name: 'OpenAI Provider',
      apiFormat: 'openai_chat',
      auth: { type: 'api-key', hasApiKey: true, apiKeyPreview: 'sk-***' },
      endpoint: { baseUrl: 'https://openrouter.ai/api/v1' },
      models: [
        { id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true },
        { id: 'openai/gpt-5-responses', apiFormat: 'openai_responses', enabled: true }
      ],
      defaults: { modelId: 'openai/gpt-4o' },
      adapters: {
        genericAgent: { enabled: true, sessionType: 'native_oai' }
      }
    },
    {
      id: 'mimo-relay-provider',
      name: 'MIMO Relay Provider',
      apiFormat: 'openai_chat',
      auth: { type: 'api-key', hasApiKey: true, apiKeyPreview: 'sk-***' },
      endpoint: { baseUrl: 'https://test.404888.xyz' },
      models: [
        { id: 'mimo-v2.5', apiFormat: 'openai_chat', enabled: true },
        { id: 'disabled-mimo', apiFormat: 'openai_chat', enabled: false }
      ],
      defaults: { modelId: 'mimo-v2.5' },
      adapters: {
        claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true, extraConfig: { relay: true } },
        genericAgent: { enabled: true, sessionType: 'native_oai' }
      }
    }
  ]
}

describe('providerCompatibility', () => {
  it('returns Anthropic and OpenAI relay models for Claude Code', () => {
    expect(getCompatibleProviders(catalog, 'claude-code').map((provider) => provider.id)).toEqual(['anthropic-provider', 'mimo-relay-provider'])
    expect(getCompatibleModels(catalog.providers[0], 'claude-code').map((model) => model.id)).toEqual(['claude-opus-4-7'])
    expect(getCompatibleModels(catalog.providers[1], 'claude-code').map((model) => model.id)).toEqual([])
    expect(getCompatibleModels(catalog.providers[2], 'claude-code').map((model) => model.id)).toEqual(['mimo-v2.5'])
  })

  it('returns GenericAgent models based on sessionType', () => {
    expect(getCompatibleModels(catalog.providers[0], 'generic-agent').map((model) => model.id)).toEqual(['claude-opus-4-7'])
    expect(getCompatibleModels(catalog.providers[1], 'generic-agent').map((model) => model.id)).toEqual(['openai/gpt-4o', 'openai/gpt-5-responses'])
    expect(getCompatibleProviders(catalog, 'generic-agent').map((provider) => provider.id)).toEqual(['anthropic-provider', 'openai-provider', 'mimo-relay-provider'])
  })
})
