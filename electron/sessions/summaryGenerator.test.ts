import { describe, expect, it } from 'vitest'
import type { ProviderProfile, Session } from '../../src/types/workerDesk'
import { createSummaryGenerator } from './summaryGenerator'

const session: Session = {
  id: 'session-1',
  projectId: 'project-1',
  providerProfileId: 'provider-1',
  workerType: 'claude-code',
  interactionMode: 'pty',
  status: 'exited',
  title: 'Test Session',
  createdAt: '2026-05-11T00:00:00.000Z',
  lastActivityAt: '2026-05-11T00:00:01.000Z',
  exitedAt: '2026-05-11T00:00:02.000Z',
  exitCode: 0,
  outputRef: 'file:sessions/session-1/output.jsonl'
}

const provider: ProviderProfile = {
  id: 'provider-1',
  name: 'Anthropic',
  apiFormat: 'anthropic',
  protocol: 'anthropic',
  auth: { type: 'api-key', apiKey: 'secret-key' },
  endpoint: { baseUrl: 'https://api.example.test' },
  model: { id: 'claude-sonnet-4-6', apiFormat: 'anthropic', enabled: true },
  models: [{ id: 'claude-sonnet-4-6', apiFormat: 'anthropic', enabled: true }],
  defaults: { modelId: 'claude-sonnet-4-6' },
  adapters: {
    claudeCode: {
      enabled: true,
      permissionMode: 'default',
      useSettingsEnv: true
    }
  }
}

const compatibleProvider: ProviderProfile = {
  id: 'provider-1',
  name: 'Mimo V2.5 Pro',
  apiFormat: 'anthropic',
  protocol: 'anthropic-compatible',
  auth: { type: 'api-key', apiKey: 'bearer-token' },
  endpoint: { baseUrl: 'https://mimo.example.test/v1' },
  model: { id: 'mimo-v2.5-pro', apiFormat: 'anthropic', enabled: true },
  models: [{ id: 'mimo-v2.5-pro', apiFormat: 'anthropic', enabled: true }],
  defaults: { modelId: 'mimo-v2.5-pro' },
  adapters: {
    claudeCode: {
      enabled: true,
      permissionMode: 'default',
      apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN',
      useSettingsEnv: true
    }
  }
}

const noopReadCli = async () => ''

describe('summaryGenerator', () => {
  it('generates Desk Session summary and persists under desk session id when not bound to a CLI jsonl', async () => {
    const calls: unknown[] = []
    let written: { primaryKey: string; summary: string } | undefined
    const generator = createSummaryGenerator({
      getSession: async () => session,
      getProviderProfile: async (providerProfileId) => {
        expect(providerProfileId).toBe('provider-1')
        return provider
      },
      readDeskOutputTail: async () => 'final output',
      readCliOutputTail: noopReadCli,
      writeSummary: async (primaryKey, summary) => { written = { primaryKey, summary } },
      createClient: (input) => ({
        messages: {
          create: async (payload: unknown) => {
            calls.push({ input, payload })
            return { content: [{ type: 'text', text: '# Session Summary\n\n完成。' }] }
          }
        }
      })
    })

    await expect(generator.generateSummary({ kind: 'desk-session', deskSessionId: session.id }, 'provider-1')).resolves.toContain('完成')
    // Without a bound cliSessionId, primaryKey falls back to the desk session id
    expect(written).toEqual({ primaryKey: session.id, summary: '# Session Summary\n\n完成。' })
    expect(calls[0]).toMatchObject({ input: { apiKey: 'secret-key', baseURL: 'https://api.example.test' } })
    expect(JSON.stringify((calls[0] as { payload: unknown }).payload)).not.toContain('secret-key')
  })

  it('persists Desk Session summary under cliSessionId when the session is bound to a CLI jsonl', async () => {
    let written: { primaryKey: string; summary: string } | undefined
    const generator = createSummaryGenerator({
      getSession: async () => ({ ...session, cliSessionId: 'cli-session-abc' }),
      getProviderProfile: async () => provider,
      readDeskOutputTail: async () => 'final output',
      readCliOutputTail: noopReadCli,
      writeSummary: async (primaryKey, summary) => { written = { primaryKey, summary } },
      createClient: () => ({
        messages: {
          create: async () => ({ content: [{ type: 'text', text: '# Summary\n\n完成。' }] })
        }
      })
    })

    await generator.generateSummary({ kind: 'desk-session', deskSessionId: session.id }, 'provider-1')
    // Bound cliSessionId is the primaryKey, so a future CLI-card summary regen
    // would land on the same file.
    expect(written?.primaryKey).toBe('cli-session-abc')
  })

  it('uses auth token input and provider model for compatible providers by default', async () => {
    const calls: unknown[] = []
    const generator = createSummaryGenerator({
      getSession: async () => session,
      getProviderProfile: async () => ({
        ...compatibleProvider,
        adapters: {
          claudeCode: {
            enabled: true,
            permissionMode: 'default',
            useSettingsEnv: true
          }
        }
      }),
      readDeskOutputTail: async () => 'output',
      readCliOutputTail: noopReadCli,
      writeSummary: async () => undefined,
      createClient: (input) => ({
        messages: {
          create: async (payload: unknown) => {
            calls.push({ input, payload })
            return { content: [{ type: 'text', text: '# Summary\n\n完成。' }] }
          }
        }
      })
    })

    await expect(generator.generateSummary({ kind: 'desk-session', deskSessionId: session.id }, 'provider-1')).resolves.toContain('完成')
    expect(calls[0]).toMatchObject({ input: { authToken: 'bearer-token', baseURL: 'https://mimo.example.test/v1' } })
    expect((calls[0] as { input: { apiKey?: string } }).input.apiKey).toBeUndefined()
    expect((calls[0] as { payload: { model?: string } }).payload.model).toBe('mimo-v2.5-pro')
    expect(JSON.stringify((calls[0] as { payload: unknown }).payload)).not.toContain('bearer-token')
  })

  it('uses auth token input when compatible providers explicitly select auth token env', async () => {
    const calls: unknown[] = []
    const generator = createSummaryGenerator({
      getSession: async () => session,
      getProviderProfile: async () => compatibleProvider,
      readDeskOutputTail: async () => 'output',
      readCliOutputTail: noopReadCli,
      writeSummary: async () => undefined,
      createClient: (input) => ({
        messages: {
          create: async (payload: unknown) => {
            calls.push({ input, payload })
            return { content: [{ type: 'text', text: '# Summary\n\n完成。' }] }
          }
        }
      })
    })

    await expect(generator.generateSummary({ kind: 'desk-session', deskSessionId: session.id }, 'provider-1')).resolves.toContain('完成')
    expect(calls[0]).toMatchObject({ input: { authToken: 'bearer-token', baseURL: 'https://mimo.example.test/v1' } })
    expect((calls[0] as { input: { apiKey?: string } }).input.apiKey).toBeUndefined()
  })

  it('generates CLI session summary from CLI output and persists under cliSessionId', async () => {
    const calls: unknown[] = []
    let written: { primaryKey: string; summary: string } | undefined
    const generator = createSummaryGenerator({
      getSession: async () => { throw new Error('CLI summary should not need desk session lookup') },
      getProviderProfile: async (providerProfileId) => {
        expect(providerProfileId).toBe('provider-1')
        return provider
      },
      readDeskOutputTail: async () => { throw new Error('desk output should not be used for CLI summary') },
      readCliOutputTail: async (sessionId, projectId) => {
        expect(sessionId).toBe('cli-session/../danger')
        expect(projectId).toBe('project-1')
        return 'cli output tail'
      },
      writeSummary: async (primaryKey, summary) => { written = { primaryKey, summary } },
      createClient: (input) => ({
        messages: {
          create: async (payload: unknown) => {
            calls.push({ input, payload })
            return { content: [{ type: 'text', text: '# CLI Summary\n\nCLI 完成。' }] }
          }
        }
      })
    })

    await expect(
      generator.generateSummary({ kind: 'cli-session', cliSessionId: 'cli-session/../danger', projectId: 'project-1' }, 'provider-1')
    ).resolves.toContain('CLI 完成')
    expect(written).toEqual({ primaryKey: 'cli-session/../danger', summary: '# CLI Summary\n\nCLI 完成。' })
    const payload = (calls[0] as { payload: unknown }).payload
    expect(JSON.stringify(payload)).toContain('cli output tail')
    expect(JSON.stringify(payload)).not.toContain('secret-key')
  })

  it('does not write summary when API call fails', async () => {
    let wrote = false
    const generator = createSummaryGenerator({
      getSession: async () => session,
      getProviderProfile: async () => provider,
      readDeskOutputTail: async () => 'desk output',
      readCliOutputTail: async () => 'cli output',
      writeSummary: async () => { wrote = true },
      createClient: () => ({
        messages: {
          create: async () => { throw new Error('API error secret-key') }
        }
      })
    })

    await expect(
      generator.generateSummary({ kind: 'cli-session', cliSessionId: 'cli-session', projectId: 'project-1' }, 'provider-1')
    ).rejects.toThrow('[REDACTED]')
    expect(wrote).toBe(false)
  })

  it('fails before API call when provider is missing auth', async () => {
    const generator = createSummaryGenerator({
      getSession: async () => session,
      getProviderProfile: async () => ({
        ...provider,
        auth: { type: 'api-key', apiKey: '' }
      }),
      readDeskOutputTail: async () => 'output',
      readCliOutputTail: noopReadCli,
      writeSummary: async () => undefined,
      createClient: () => { throw new Error('should not create client') }
    })

    await expect(generator.generateSummary({ kind: 'desk-session', deskSessionId: session.id }, 'provider-1')).rejects.toThrow('Provider provider-1 missing API key')
  })

  it('turns invalid API key errors into a safe actionable message', async () => {
    const generator = createSummaryGenerator({
      getSession: async () => session,
      getProviderProfile: async () => provider,
      readDeskOutputTail: async () => 'output',
      readCliOutputTail: noopReadCli,
      writeSummary: async () => undefined,
      createClient: () => ({
        messages: {
          create: async () => { throw new Error('401 {"error":{"message":"Invalid API Key","param":"Please provide valid API Key","code":"401","type":"invalid_key"}}') }
        }
      })
    })

    await expect(generator.generateSummary({ kind: 'desk-session', deskSessionId: session.id }, 'provider-1')).rejects.toThrow('Provider Anthropic 的 API Key 无效，请检查模型连接配置')
  })

  it('turns rate limit errors into a safe actionable message', async () => {
    const generator = createSummaryGenerator({
      getSession: async () => session,
      getProviderProfile: async () => provider,
      readDeskOutputTail: async () => 'output',
      readCliOutputTail: noopReadCli,
      writeSummary: async () => undefined,
      createClient: () => ({
        messages: {
          create: async () => { throw new Error('429 {"type":"error","error":{"type":"rate_limit_error","message":"usage limit exceeded, resets at 2026-05-12T15:00:00+08:00"}}') }
        }
      })
    })

    await expect(generator.generateSummary({ kind: 'desk-session', deskSessionId: session.id }, 'provider-1')).rejects.toThrow('Provider Anthropic 的 API 使用额度已达上限，请稍后重试或切换模型连接')
  })

  it('error message does not leak provider secrets or endpoint', async () => {
    const generator = createSummaryGenerator({
      getSession: async () => session,
      getProviderProfile: async () => provider,
      readDeskOutputTail: async () => 'output',
      readCliOutputTail: noopReadCli,
      writeSummary: async () => undefined,
      createClient: () => ({
        messages: {
          create: async () => { throw new Error('API error: invalid key secret-key at https://api.example.test') }
        }
      })
    })

    try {
      await generator.generateSummary({ kind: 'desk-session', deskSessionId: session.id }, 'provider-1')
      expect.unreachable('should have thrown')
    } catch (err) {
      const message = (err as Error).message
      expect(message).not.toContain('secret-key')
      expect(message).not.toContain('https://api.example.test')
    }
  })

  it('uses summary default model for summary generation', async () => {
    const calls: unknown[] = []
    const multiModelProvider: ProviderProfile = {
      ...provider,
      models: [
        { id: 'claude-sonnet-4-6', apiFormat: 'anthropic', enabled: true },
        { id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true }
      ],
      defaults: {
        modelId: 'claude-sonnet-4-6',
        apps: { summary: { modelId: 'claude-opus-4-7' } }
      }
    }
    const generator = createSummaryGenerator({
      getSession: async () => session,
      getProviderProfile: async () => multiModelProvider,
      readDeskOutputTail: async () => 'output',
      readCliOutputTail: noopReadCli,
      writeSummary: async () => undefined,
      createClient: (input) => ({
        messages: {
          create: async (payload: unknown) => {
            calls.push({ input, payload })
            return { content: [{ type: 'text', text: '# Summary\n\n完成。' }] }
          }
        }
      })
    })

    await generator.generateSummary({ kind: 'desk-session', deskSessionId: session.id }, 'provider-1')
    expect((calls[0] as { payload: { model?: string } }).payload.model).toBe('claude-opus-4-7')
  })

  it('uses explicit providerModelId over summary default', async () => {
    const calls: unknown[] = []
    const multiModelProvider: ProviderProfile = {
      ...provider,
      models: [
        { id: 'claude-sonnet-4-6', apiFormat: 'anthropic', enabled: true },
        { id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true }
      ],
      defaults: {
        modelId: 'claude-sonnet-4-6',
        apps: { summary: { modelId: 'claude-opus-4-7' } }
      }
    }
    const generator = createSummaryGenerator({
      getSession: async () => session,
      getProviderProfile: async () => multiModelProvider,
      readDeskOutputTail: async () => 'output',
      readCliOutputTail: noopReadCli,
      writeSummary: async () => undefined,
      createClient: (input) => ({
        messages: {
          create: async (payload: unknown) => {
            calls.push({ input, payload })
            return { content: [{ type: 'text', text: '# Summary\n\n完成。' }] }
          }
        }
      })
    })

    await generator.generateSummary({ kind: 'desk-session', deskSessionId: session.id }, 'provider-1', 'claude-sonnet-4-6')
    expect((calls[0] as { payload: { model?: string } }).payload.model).toBe('claude-sonnet-4-6')
  })

  it('rejects non-anthropic summary models', async () => {
    const generator = createSummaryGenerator({
      getSession: async () => session,
      getProviderProfile: async () => ({
        ...provider,
        model: { id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true },
        models: [{ id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true }],
        defaults: { modelId: 'openai/gpt-4o' }
      }),
      readDeskOutputTail: async () => 'output',
      readCliOutputTail: noopReadCli,
      writeSummary: async () => undefined,
      createClient: () => ({
        messages: {
          create: async () => ({ content: [{ type: 'text', text: '# Summary\n\n完成。' }] })
        }
      })
    })

    await expect(generator.generateSummary({ kind: 'desk-session', deskSessionId: session.id }, 'provider-1')).rejects.toThrow('Summary requires apiFormat "anthropic"')
  })
})
