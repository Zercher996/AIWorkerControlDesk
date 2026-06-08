import { describe, expect, it } from 'vitest'
import { buildClaudeCodeLaunchConfig, buildClaudeCodeLaunchConfigFromEnv, withClaudeCodeSettings } from './claudeCodeProviderAdapter'
import type { ProviderProfile } from '../../src/types/workerDesk'

function provider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  const base: ProviderProfile = {
    id: 'anthropic-direct',
    name: 'Anthropic Direct',
    apiFormat: 'anthropic',
    protocol: 'anthropic',
    auth: { type: 'api-key', apiKey: 'sk-ant-secret' },
    endpoint: { baseUrl: 'https://api.anthropic.com' },
    model: { id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true },
    models: [{ id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true }],
    defaults: { modelId: 'claude-opus-4-7' },
    adapters: { claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true } }
  }
  return { ...base, ...overrides }
}

describe('buildClaudeCodeLaunchConfig', () => {
  it('injects provider env without restricting Claude Code settings sources', () => {
    const result = buildClaudeCodeLaunchConfig(provider())
    expect(result.env.ANTHROPIC_API_KEY).toBe('sk-ant-secret')
    expect(result.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
    expect(result.env.ANTHROPIC_MODEL).toBe('claude-opus-4-7')
    expect(result.command.file).toBe('claude')
    expect(result.command.args).toEqual([
      '--settings',
      JSON.stringify({ env: result.env }),
      '--permission-mode',
      'default'
    ])
    expect(result.command.args).not.toContain('--setting-sources')
    expect(result.command.args).not.toContain('local')
    expect(result.command.args).not.toContain('--model')
  })

  it('maps anthropic-compatible provider to ANTHROPIC_AUTH_TOKEN by default', () => {
    const result = buildClaudeCodeLaunchConfig(provider({ protocol: 'anthropic-compatible' }))
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-secret')
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('honors explicit apiKeyEnv', () => {
    const result = buildClaudeCodeLaunchConfig(provider({
      protocol: 'anthropic-compatible',
      adapters: { claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true, apiKeyEnv: 'ANTHROPIC_API_KEY' } }
    }))
    expect(result.env.ANTHROPIC_API_KEY).toBe('sk-ant-secret')
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('merges extraEnv without outputting GenericAgent concepts', () => {
    const result = buildClaudeCodeLaunchConfig(provider({
      adapters: { claudeCode: { enabled: true, permissionMode: 'plan', useSettingsEnv: true, extraEnv: { EXTRA_CC_ENV: '1' } } }
    }))

    expect(result.env.EXTRA_CC_ENV).toBe('1')
    expect(result.command.args).toContain('plan')
    expect(result.env.sessionType).toBeUndefined()
    expect(result.env.llmNo).toBeUndefined()
  })

  it('removes conflicting extraEnv auth token when api key is selected', () => {
    const result = buildClaudeCodeLaunchConfig(provider({
      adapters: { claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true, extraEnv: { ANTHROPIC_AUTH_TOKEN: 'dirty-token' } } }
    }))

    expect(result.env.ANTHROPIC_API_KEY).toBe('sk-ant-secret')
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('merges Claude Code hook settings into existing --settings without restricting settings sources', () => {
    const result = buildClaudeCodeLaunchConfig(provider())
    const merged = withClaudeCodeSettings(result, {
      hooks: {
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook-relay.js Stop' }] }],
        Notification: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook-relay.js Notification' }] }]
      }
    })

    const settingsIndex = merged.command.args.indexOf('--settings')
    expect(settingsIndex).toBeGreaterThanOrEqual(0)
    const settings = JSON.parse(merged.command.args[settingsIndex + 1])
    expect(settings.env).toEqual(result.env)
    expect(settings.hooks.Stop).toHaveLength(1)
    expect(settings.hooks.Notification).toHaveLength(1)
    expect(settings.Stop).toBeUndefined()
    expect(merged.command.args).not.toContain('--setting-sources')
    expect(merged.command.args).not.toContain('local')
  })
})

describe('buildClaudeCodeLaunchConfigFromEnv', () => {
  it('preserves current Claude config env without restricting settings sources', () => {
    const env = {
      ANTHROPIC_AUTH_TOKEN: 'secret-token',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:53159',
      ANTHROPIC_MODEL: 'gpt-5.4'
    }
    const result = buildClaudeCodeLaunchConfigFromEnv(env)
    expect(result.env).toEqual(env)
    expect(result.model).toBe('gpt-5.4')
    expect(result.command.args).toEqual([
      '--settings',
      JSON.stringify({ env }),
      '--permission-mode',
      'default'
    ])
    expect(result.command.args).not.toContain('--setting-sources')
    expect(result.command.args).not.toContain('local')
  })
})
