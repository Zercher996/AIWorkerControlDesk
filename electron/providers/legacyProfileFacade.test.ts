import { describe, expect, it } from 'vitest'
import type { PermissionMode } from '../../src/types/workerDesk'
import { legacyProfileToProviderProfile } from './legacyProfileFacade'

const profile = {
  id: 'legacy-compatible',
  name: 'Legacy Compatible',
  provider: 'anthropic-compatible',
  model: 'claude-sonnet-4-6',
  env: {
    ANTHROPIC_AUTH_TOKEN: 'token-secret',
    ANTHROPIC_BASE_URL: 'https://relay.example/v1',
    EXTRA_ENV: 'extra'
  },
  permissionMode: 'default' as PermissionMode,
  sourcePath: 'profiles.json'
}

describe('legacyProfileToProviderProfile', () => {
  it('converts legacy anthropic-compatible Profile into a virtual ProviderProfile for Claude Code', () => {
    const provider = legacyProfileToProviderProfile(profile)

    expect(provider.id).toBe('legacy:legacy-compatible')
    expect(provider.protocol).toBe('anthropic-compatible')
    expect(provider.auth.apiKey).toBe('token-secret')
    expect(provider.endpoint.baseUrl).toBe('https://relay.example/v1')
    expect(provider.model.id).toBe('claude-sonnet-4-6')
    expect(provider.adapters?.claudeCode).toMatchObject({
      enabled: true,
      permissionMode: 'default',
      useSettingsEnv: true
    })
    expect(provider.adapters?.genericAgent?.enabled).toBe(false)
  })

  it('uses ANTHROPIC_API_KEY and anthropic protocol for anthropic profiles', () => {
    const provider = legacyProfileToProviderProfile({
      ...profile,
      provider: 'anthropic',
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
      }
    })

    expect(provider.protocol).toBe('anthropic')
    expect(provider.auth.apiKey).toBe('sk-ant-secret')
  })

  it('keeps only non-core env in Claude Code extraEnv', () => {
    const provider = legacyProfileToProviderProfile({
      ...profile,
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        ANTHROPIC_AUTH_TOKEN: 'token-secret',
        ANTHROPIC_BASE_URL: 'https://relay.example/v1',
        ANTHROPIC_MODEL: 'claude-from-env',
        EXTRA_ENV: 'extra',
        CUSTOM_TIMEOUT: '30'
      }
    })

    expect(provider.model.id).toBe('claude-from-env')
    expect(provider.adapters?.claudeCode?.extraEnv).toEqual({
      EXTRA_ENV: 'extra',
      CUSTOM_TIMEOUT: '30'
    })
  })
})
