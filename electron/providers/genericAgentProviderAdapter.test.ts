import { describe, expect, it } from 'vitest'
import type { GenericAgentConfig, ProviderProfile } from '../../src/types/workerDesk'
import { buildGenericAgentLaunchConfig } from './genericAgentProviderAdapter'

const genericAgent: GenericAgentConfig = {
  id: 'ga-local',
  name: 'GA Local',
  home: 'E:/GenericAgent',
  pythonCommand: 'python',
  entryScript: 'agentmain.py',
  env: { GA_CUSTOM_VAR: '1' }
}

function provider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  const base: ProviderProfile = {
    id: 'openrouter-gpt',
    name: 'OpenRouter GPT',
    apiFormat: 'openai_chat',
    protocol: 'openai-compatible',
    auth: { type: 'api-key', apiKey: 'sk-or-secret' },
    endpoint: { baseUrl: 'https://openrouter.ai/api/v1' },
    model: { id: 'openai/gpt-5.4', apiFormat: 'openai_chat', enabled: true },
    models: [{ id: 'openai/gpt-5.4', apiFormat: 'openai_chat', enabled: true }],
    defaults: { modelId: 'openai/gpt-5.4' },
    adapters: { genericAgent: { enabled: true, sessionType: 'native_oai', name: 'openrouter-gpt', apiMode: 'chat_completions', reasoningEffort: 'high' } }
  }
  return { ...base, ...overrides }
}

describe('buildGenericAgentLaunchConfig', () => {
  it('serializes openai-compatible provider into GENERIC_AGENT_PROVIDER_CONFIG_JSON', () => {
    const result = buildGenericAgentLaunchConfig({ provider: provider(), genericAgent })
    const parsed = JSON.parse(result.providerConfigJson)
    expect(result.env.GENERIC_AGENT_PROVIDER_CONFIG_JSON).toBe(result.providerConfigJson)
    expect(parsed.sessionType).toBe('native_oai')
    expect(parsed.config).toMatchObject({
      name: 'openrouter-gpt',
      apikey: 'sk-or-secret',
      apibase: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5.4',
      api_mode: 'chat_completions',
      reasoning_effort: 'high'
    })
    expect(parsed.config.permissionMode).toBeUndefined()
    expect(parsed.config.ANTHROPIC_API_KEY).toBeUndefined()
    expect(parsed.config.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('serializes anthropic-compatible native_claude fields', () => {
    const result = buildGenericAgentLaunchConfig({
      genericAgent,
      provider: provider({
        id: 'kimi-coding',
        name: 'Kimi Coding',
        apiFormat: 'anthropic',
        protocol: 'anthropic-compatible',
        endpoint: { baseUrl: 'https://api.kimi.com/coding' },
        model: { id: 'kimi-for-coding', apiFormat: 'anthropic', enabled: true },
        models: [{ id: 'kimi-for-coding', apiFormat: 'anthropic', enabled: true }],
        defaults: { modelId: 'kimi-for-coding' },
        adapters: { genericAgent: { enabled: true, sessionType: 'native_claude', fakeCcSystemPrompt: true, thinkingType: 'adaptive' } }
      })
    })
    const parsed = JSON.parse(result.providerConfigJson)
    expect(parsed.sessionType).toBe('native_claude')
    expect(parsed.config.fake_cc_system_prompt).toBe(true)
    expect(parsed.config.thinking_type).toBe('adaptive')
  })

  it('builds python command, cwd, env defaults, and absolute entry script', () => {
    const result = buildGenericAgentLaunchConfig({ provider: provider(), genericAgent })

    expect(result.command.file).toBe('python')
    expect(result.command.cwd).toBe('E:/GenericAgent')
    expect(result.command.args).toEqual(['E:/GenericAgent/agentmain.py'])
    expect(result.env.GA_CUSTOM_VAR).toBe('1')
    expect(result.env.PYTHONUTF8).toBe('1')
    expect(result.env.PYTHONIOENCODING).toBe('utf-8')
    expect(result.env.GA_LANG).toBe('zh')
  })

  it('keeps selected provider config authoritative over local GenericAgent env', () => {
    const result = buildGenericAgentLaunchConfig({
      provider: provider(),
      genericAgent: {
        ...genericAgent,
        env: {
          GENERIC_AGENT_PROVIDER_CONFIG_JSON: JSON.stringify({ sessionType: 'native_oai', config: { name: 'local-provider' } })
        }
      }
    })

    expect(result.env.GENERIC_AGENT_PROVIDER_CONFIG_JSON).toBe(result.providerConfigJson)
    expect(JSON.parse(result.env.GENERIC_AGENT_PROVIDER_CONFIG_JSON).config.name).toBe('openrouter-gpt')
  })

  it('uses selected model and validates apiFormat against sessionType', () => {
    const selectedModel = { id: 'openai/gpt-4o', apiFormat: 'openai_chat' as const, enabled: true }
    const result = buildGenericAgentLaunchConfig({ provider: provider(), model: selectedModel, genericAgent })
    expect(JSON.parse(result.providerConfigJson).config.model).toBe('openai/gpt-4o')

    expect(() => buildGenericAgentLaunchConfig({
      provider: provider({ adapters: { genericAgent: { enabled: true, sessionType: 'native_claude' } } }),
      model: selectedModel,
      genericAgent
    })).toThrow('GenericAgent sessionType must be native_oai')

    expect(() => buildGenericAgentLaunchConfig({
      provider: provider({ adapters: { genericAgent: { enabled: true, sessionType: 'native_oai' } } }),
      model: { id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true },
      genericAgent
    })).toThrow('GenericAgent sessionType must be native_claude')
  })
})
