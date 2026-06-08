import { describe, expect, it } from 'vitest'
import { appReducer, initialAppState } from './appStore'
import type { Project, SafeProviderCatalog, SessionAiEvent } from '../types/workerDesk'

const aiEvent = (sessionId: string, id: string, text: string): SessionAiEvent => ({
  id,
  sessionId,
  timestamp: '2026-05-30T00:00:00.000Z',
  source: 'desk',
  type: 'user_message',
  text
})

describe('appStore project lifecycle', () => {
  const firstProject: Project = {
    id: 'project-1',
    name: 'Project One',
    path: '/tmp/project-1',
    createdAt: '2026-06-07T00:00:00.000Z',
    lastUsedAt: '2026-06-07T00:00:00.000Z',
    autoDispatchGenericAgent: false
  }
  const secondProject: Project = {
    id: 'project-2',
    name: 'Project Two',
    path: '/tmp/project-2',
    createdAt: '2026-06-07T00:00:00.000Z',
    lastUsedAt: '2026-06-07T00:00:00.000Z',
    autoDispatchGenericAgent: false
  }

  it('removes a project and falls back to the next project when the selected one is removed', () => {
    const state = appReducer({
      ...initialAppState,
      projects: [firstProject, secondProject],
      selectedProjectId: 'project-1',
      history: [{
        id: 'history-1',
        projectId: 'project-1',
        workerType: 'claude-code',
        interactionMode: 'native-jsonl',
        status: 'exited',
        title: 'Old Session',
        createdAt: '2026-06-07T00:00:00.000Z',
        lastActivityAt: '2026-06-07T00:00:00.000Z',
        exitedAt: '2026-06-07T00:00:01.000Z',
        outputRef: 'jsonl:history-1',
        source: 'desk'
      }],
      cliHistory: [{
        id: 'cli-history-1',
        projectId: 'project-1',
        firstMessage: 'old cli',
        createdAt: '2026-06-07T00:00:00.000Z',
        updatedAt: '2026-06-07T00:00:01.000Z',
        fileSizeBytes: 12,
        cwd: '/tmp/project-1',
        source: 'cli'
      }],
      selectedHistorySessionId: 'history-1',
      historyOutputBySessionId: { 'history-1': 'old output' },
      summaryBySessionId: { 'history-1': 'old summary' },
      historyOutputNextOffset: { 'history-1': 128 },
      historyOutputTotalBytes: { 'history-1': 256 },
      isSummaryLoading: true,
      isHistoryOutputLoading: true
    }, { type: 'projectRemoved', projectId: 'project-1', nextProjectId: 'project-2' })

    expect(state.projects).toEqual([secondProject])
    expect(state.selectedProjectId).toBe('project-2')
    expect(state.history).toEqual([])
    expect(state.cliHistory).toEqual([])
    expect(state.selectedHistorySessionId).toBeUndefined()
    expect(state.historyOutputBySessionId).toEqual({})
    expect(state.summaryBySessionId).toEqual({})
    expect(state.historyOutputNextOffset).toEqual({})
    expect(state.historyOutputTotalBytes).toEqual({})
    expect(state.isSummaryLoading).toBe(false)
    expect(state.isHistoryOutputLoading).toBe(false)
  })

  it('clears project-scoped state when the last selected project is removed', () => {
    const state = appReducer({
      ...initialAppState,
      projects: [firstProject],
      selectedProjectId: 'project-1',
      historyQuery: 'error'
    }, { type: 'projectRemoved', projectId: 'project-1', nextProjectId: undefined })

    expect(state.projects).toEqual([])
    expect(state.selectedProjectId).toBeUndefined()
    expect(state.history).toEqual([])
    expect(state.cliHistory).toEqual([])
    expect(state.historyQuery).toBe('')
  })

  it('keeps state unchanged when the removed project is not in the desk list', () => {
    const state = {
      ...initialAppState,
      projects: [firstProject],
      selectedProjectId: 'project-1'
    }

    expect(appReducer(state, { type: 'projectRemoved', projectId: 'missing-project' })).toBe(state)
  })
})

describe('appStore AI session event buckets', () => {
  it('keeps AI events isolated by session id and deduplicates per bucket', () => {
    const first = aiEvent('session-a', 'event-1', 'hello A')
    const second = aiEvent('session-b', 'event-2', 'hello B')
    const withFirst = appReducer(initialAppState, { type: 'sessionAiEventReceived', event: first })
    const withSecond = appReducer(withFirst, { type: 'sessionAiEventReceived', event: second })
    const deduped = appReducer(withSecond, { type: 'sessionAiEventReceived', event: first })

    expect(deduped.sessionAiEventsBySessionId['session-a']).toEqual([first])
    expect(deduped.sessionAiEventsBySessionId['session-b']).toEqual([second])
  })

  it('loads paged AI events without overwriting other session buckets', () => {
    const existing = aiEvent('session-a', 'event-1', 'hello A')
    const loaded = aiEvent('session-b', 'event-2', 'hello B')
    const state = {
      ...initialAppState,
      sessionAiEventsBySessionId: { 'session-a': [existing] }
    }
    const next = appReducer(state, { type: 'sessionAiEventsLoaded', sessionId: 'session-b', events: [loaded], totalBytes: 10 })

    expect(next.sessionAiEventsBySessionId['session-a']).toEqual([existing])
    expect(next.sessionAiEventsBySessionId['session-b']).toEqual([loaded])
  })
})

describe('appStore session attention state', () => {
  it('stores Claude hook attention state by session id', () => {
    const state = appReducer(initialAppState, {
      type: 'sessionAttentionChanged',
      event: {
        sessionId: 'session-1',
        state: 'needsReview',
        source: 'claude-code-hook',
        hookName: 'Stop',
        occurredAt: '2026-05-25T00:00:00.000Z'
      }
    })

    expect(state.userAttentionBySessionId['session-1']).toBe('needsReview')
  })

  it('lets working hook events overwrite needs review state', () => {
    const needsReview = appReducer(initialAppState, {
      type: 'sessionAttentionChanged',
      event: {
        sessionId: 'session-1',
        state: 'needsReview',
        source: 'claude-code-hook',
        hookName: 'Stop',
        occurredAt: '2026-05-25T00:00:00.000Z'
      }
    })
    const working = appReducer(needsReview, {
      type: 'sessionAttentionChanged',
      event: {
        sessionId: 'session-1',
        state: 'working',
        source: 'claude-code-hook',
        hookName: 'UserPromptSubmit',
        occurredAt: '2026-05-25T00:00:01.000Z'
      }
    })

    expect(working.userAttentionBySessionId['session-1']).toBe('working')
  })

  it('marks a handled session as completed by clearing the current hook attention state', () => {
    const withNeedsReview = appReducer(initialAppState, {
      type: 'sessionAttentionChanged',
      event: {
        sessionId: 'session-1',
        state: 'needsReview',
        source: 'claude-code-hook',
        hookName: 'Stop',
        occurredAt: '2026-05-25T00:00:00.000Z'
      }
    })
    const handled = appReducer(withNeedsReview, { type: 'markSessionAttentionHandled', sessionId: 'session-1' })

    expect(handled.handledAttentionSessionIds).toContain('session-1')
    expect(handled.userAttentionBySessionId['session-1']).toBeUndefined()
  })

  it('keeps a handled running session completed until a new working hook arrives', () => {
    const runningSession = {
      id: 'session-1',
      projectId: 'project-1',
      workerType: 'claude-code' as const,
      interactionMode: 'pty' as const,
      status: 'running' as const,
      title: 'Review me',
      createdAt: '2026-05-25T00:00:00.000Z',
      lastActivityAt: '2026-05-25T00:00:00.000Z',
      outputRef: 'jsonl:session-1'
    }
    const handled = {
      ...initialAppState,
      sessions: [runningSession],
      handledAttentionSessionIds: ['session-1']
    }

    const afterRunningUpdate = appReducer(handled, {
      type: 'upsertSession',
      session: {
        ...runningSession,
        lastActivityAt: '2026-05-25T00:00:01.000Z'
      }
    })

    expect(afterRunningUpdate.handledAttentionSessionIds).toContain('session-1')

    const afterWorkingHook = appReducer(afterRunningUpdate, {
      type: 'sessionAttentionChanged',
      event: {
        sessionId: 'session-1',
        state: 'working',
        source: 'claude-code-hook',
        hookName: 'UserPromptSubmit',
        occurredAt: '2026-05-25T00:00:02.000Z'
      }
    })

    expect(afterWorkingHook.handledAttentionSessionIds).not.toContain('session-1')
    expect(afterWorkingHook.userAttentionBySessionId['session-1']).toBe('working')
  })

})

const catalog: SafeProviderCatalog = {
  version: 2,
  providers: [
    {
      id: 'anthropic-provider',
      name: 'Anthropic Provider',
      apiFormat: 'anthropic',
      protocol: 'anthropic',
      auth: { type: 'api-key', hasApiKey: true, apiKeyPreview: 'sk-***' },
      endpoint: { baseUrl: 'https://api.anthropic.com' },
      model: { id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true },
      models: [
        { id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true },
        { id: 'claude-sonnet-4-6', apiFormat: 'anthropic', enabled: true }
      ],
      defaults: { modelId: 'claude-opus-4-7' }
    },
    {
      id: 'openai-provider',
      name: 'OpenAI Provider',
      apiFormat: 'openai_chat',
      protocol: 'openai-compatible',
      auth: { type: 'api-key', hasApiKey: true, apiKeyPreview: 'sk-***' },
      endpoint: { baseUrl: 'https://openrouter.ai/api/v1' },
      model: { id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true },
      models: [{ id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true }],
      defaults: { modelId: 'openai/gpt-4o' }
    }
  ]
}

describe('appStore provider model selection', () => {
  it('selects the first provider and its default model when catalog loads', () => {
    const state = appReducer(initialAppState, { type: 'providerCatalogLoaded', catalog })

    expect(state.selectedProviderProfileId).toBe('anthropic-provider')
    expect(state.selectedProviderModelId).toBe('claude-opus-4-7')
  })

  it('keeps a valid selected model when catalog reloads', () => {
    const state = appReducer({
      ...initialAppState,
      selectedProviderProfileId: 'anthropic-provider',
      selectedProviderModelId: 'claude-sonnet-4-6'
    }, { type: 'providerCatalogLoaded', catalog })

    expect(state.selectedProviderProfileId).toBe('anthropic-provider')
    expect(state.selectedProviderModelId).toBe('claude-sonnet-4-6')
  })

  it('selecting a provider resets the model to that provider default when compatible with the current worker', () => {
    const state = appReducer({
      ...initialAppState,
      providerCatalog: {
        ...catalog,
        providers: [
          catalog.providers[0],
          {
            ...catalog.providers[1],
            adapters: { genericAgent: { enabled: true, sessionType: 'native_oai' } }
          }
        ]
      },
      selectedWorkerType: 'generic-agent',
      selectedProviderProfileId: 'anthropic-provider',
      selectedProviderModelId: 'claude-sonnet-4-6'
    }, { type: 'selectProviderProfile', providerProfileId: 'openai-provider' })

    expect(state.selectedProviderProfileId).toBe('openai-provider')
    expect(state.selectedProviderModelId).toBe('openai/gpt-4o')
  })

  it('selecting a provider picks a compatible model when the provider default is incompatible with the current worker', () => {
    const state = appReducer({
      ...initialAppState,
      providerCatalog: {
        version: 2,
        providers: [{
          id: 'mixed-provider',
          name: 'Mixed Provider',
          apiFormat: 'openai_chat',
          auth: { type: 'api-key', hasApiKey: true, apiKeyPreview: 'sk-***' },
          endpoint: { baseUrl: 'https://gateway.example.com' },
          models: [
            { id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true },
            { id: 'claude-sonnet-4-6', apiFormat: 'anthropic', enabled: true }
          ],
          defaults: { modelId: 'openai/gpt-4o' },
          adapters: { claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true } }
        }]
      },
      selectedWorkerType: 'claude-code'
    }, { type: 'selectProviderProfile', providerProfileId: 'mixed-provider' })

    expect(state.selectedProviderProfileId).toBe('mixed-provider')
    expect(state.selectedProviderModelId).toBe('claude-sonnet-4-6')
  })

  it('selects the first provider compatible with the current worker when catalog loads', () => {
    const state = appReducer({
      ...initialAppState,
      selectedWorkerType: 'generic-agent'
    }, {
      type: 'providerCatalogLoaded',
      catalog: {
        ...catalog,
        providers: [
          {
            ...catalog.providers[0],
            adapters: { genericAgent: { enabled: true, sessionType: 'native_oai' } }
          },
          {
            ...catalog.providers[1],
            adapters: { genericAgent: { enabled: true, sessionType: 'native_oai' } }
          }
        ]
      }
    })

    expect(state.selectedProviderProfileId).toBe('openai-provider')
    expect(state.selectedProviderModelId).toBe('openai/gpt-4o')
  })

  it('falls back to a compatible model when the provider default is incompatible with the current worker', () => {
    const state = appReducer(initialAppState, {
      type: 'providerCatalogLoaded',
      catalog: {
        version: 2,
        providers: [{
          id: 'mixed-provider',
          name: 'Mixed Provider',
          apiFormat: 'openai_chat',
          auth: { type: 'api-key', hasApiKey: true, apiKeyPreview: 'sk-***' },
          endpoint: { baseUrl: 'https://gateway.example.com' },
          models: [
            { id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true },
            { id: 'claude-sonnet-4-6', apiFormat: 'anthropic', enabled: true }
          ],
          defaults: { modelId: 'openai/gpt-4o' },
          adapters: { claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true } }
        }]
      }
    })

    expect(state.selectedProviderProfileId).toBe('mixed-provider')
    expect(state.selectedProviderModelId).toBe('claude-sonnet-4-6')
  })

  it('drops a previously selected model when it is not compatible with the current worker', () => {
    const state = appReducer({
      ...initialAppState,
      selectedProviderProfileId: 'mixed-provider',
      selectedProviderModelId: 'openai/gpt-4o'
    }, {
      type: 'providerCatalogLoaded',
      catalog: {
        version: 2,
        providers: [{
          id: 'mixed-provider',
          name: 'Mixed Provider',
          apiFormat: 'openai_chat',
          auth: { type: 'api-key', hasApiKey: true, apiKeyPreview: 'sk-***' },
          endpoint: { baseUrl: 'https://gateway.example.com' },
          models: [
            { id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true },
            { id: 'claude-sonnet-4-6', apiFormat: 'anthropic', enabled: true }
          ],
          defaults: { modelId: 'openai/gpt-4o' },
          adapters: { claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true } }
        }]
      }
    })

    expect(state.selectedProviderModelId).toBe('claude-sonnet-4-6')
  })

  it('allows selecting a provider model directly', () => {
    const state = appReducer({
      ...initialAppState,
      providerCatalog: catalog,
      selectedProviderProfileId: 'anthropic-provider',
      selectedProviderModelId: 'claude-opus-4-7'
    }, { type: 'selectProviderModel', providerModelId: 'claude-sonnet-4-6' })

    expect(state.selectedProviderModelId).toBe('claude-sonnet-4-6')
  })
})
