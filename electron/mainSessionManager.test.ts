import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Notification, shell } from 'electron'
import type { GenericAgentConfig, Project, ProviderCatalog, SessionOutputEvent } from '../src/types/workerDesk'
import { ipcChannels } from './ipc/channels'
import { createMainSessionManager } from './mainSessionManager'

const { mockCreateClaudeHookBridge, mockNotificationShow } = vi.hoisted(() => ({
  mockCreateClaudeHookBridge: vi.fn(),
  mockNotificationShow: vi.fn()
}))

vi.mock('electron', () => ({
  Notification: vi.fn(function MockNotification() {
    return { show: mockNotificationShow }
  }),
  shell: {
    beep: vi.fn()
  }
}))

vi.mock('./sessions/claudePty', () => ({
  startPtyProcess: vi.fn(({ onData }) => {
    onData('ready')
    return { pid: 12345, write: vi.fn(), resize: vi.fn(), kill: vi.fn() }
  })
}))

vi.mock('./sessions/claudeHookBridge', () => ({
  createClaudeHookBridge: mockCreateClaudeHookBridge
}))

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => true) },
  existsSync: vi.fn(() => true)
}))

const project: Project = {
  id: 'project-1',
  name: 'Project One',
  path: 'E:/project-one',
  createdAt: '2026-05-14T00:00:00.000Z',
  lastUsedAt: '2026-05-14T00:00:00.000Z',
  autoDispatchGenericAgent: false
}

const genericAgentConfig: GenericAgentConfig = {
  id: 'generic-agent-local',
  name: 'GenericAgent Local',
  home: 'E:/GenericAgent',
  pythonCommand: 'python',
  entryScript: 'agentmain.py',
  env: {}
}

const providerCatalog: ProviderCatalog = {
  version: 2,
  providers: [
    {
      id: 'provider-1',
      name: 'Provider One',
      apiFormat: 'anthropic',
      protocol: 'anthropic',
      auth: { type: 'api-key', apiKey: 'sk-provider' },
      endpoint: { baseUrl: 'https://api.anthropic.com' },
      model: { id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true },
      models: [{ id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true }],
      defaults: { modelId: 'claude-opus-4-7' },
      adapters: {
        claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true },
        genericAgent: { enabled: true, sessionType: 'native_claude' }
      }
    }
  ]
}

describe('createMainSessionManager', () => {
  beforeEach(() => {
    mockCreateClaudeHookBridge.mockReset()
    mockNotificationShow.mockClear()
    vi.mocked(Notification).mockClear()
    vi.mocked(shell.beep).mockClear()
  })

  it('wires the real GenericAgent process starter into session startup without requiring profileId', async () => {
    mockCreateClaudeHookBridge.mockReturnValue({ registerSession: vi.fn() })
    const events: SessionOutputEvent[] = []
    const window = { webContents: { send: vi.fn() } }
    const manager = createMainSessionManager({
      projectStore: { listProjects: vi.fn().mockResolvedValue([project]) } as never,
      getGenericAgentConfigs: vi.fn().mockResolvedValue([genericAgentConfig]),
      providerCatalogStore: { loadProviderCatalog: vi.fn().mockResolvedValue(providerCatalog) } as never,
      sessionStore: {
        createSession: vi.fn().mockResolvedValue(undefined),
        updateSession: vi.fn().mockResolvedValue(undefined),
        appendOutput: vi.fn((event: SessionOutputEvent) => {
          events.push(event)
          return Promise.resolve()
        })
      } as never,
      hookEventsPath: 'E:/tmp/hooks',
      getMainWindow: () => window as never
    })

    const session = await manager.startSession({
      projectId: 'project-1',
      workerType: 'generic-agent',
      genericAgentConfigId: 'generic-agent-local',
      providerProfileId: 'provider-1'
    })

    expect(session.status).not.toBe('failed')
    expect(session.errorMessage).toBeUndefined()
    expect(session.processId).toBe(12345)
    expect(events.some((event) => event.chunk === 'ready')).toBe(true)
  })

  it('notifies the OS and flashes the taskbar only when a session newly enters needs review', async () => {
    let onEvent: ((event: { sessionId: string; state: 'working' | 'needsReview'; source: 'claude-code-hook'; hookName: 'Stop' | 'Notification' | 'UserPromptSubmit'; occurredAt: string }) => void) | undefined
    const registerSession = vi.fn(async (sessionId: string) => ({
      eventFilePath: `hooks/${sessionId}.jsonl`,
      settings: {
        hooks: {
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook Stop' }] }],
          Notification: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook Notification' }] }],
          UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook UserPromptSubmit' }] }],
          PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook PreToolUse' }] }],
          PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook PostToolUse' }] }]
        }
      },
      dispose: vi.fn()
    }))
    mockCreateClaudeHookBridge.mockImplementation((input: { onEvent(event: { sessionId: string; state: 'working' | 'needsReview'; source: 'claude-code-hook'; hookName: 'Stop' | 'Notification' | 'UserPromptSubmit'; occurredAt: string }): void }) => {
      onEvent = input.onEvent
      return { registerSession }
    })
    let focusHandler: (() => void) | undefined
    const window = {
      isFocused: vi.fn(() => false),
      once: vi.fn((eventName: string, handler: () => void) => {
        if (eventName === 'focus') focusHandler = handler
        return window
      }),
      flashFrame: vi.fn(),
      webContents: { send: vi.fn() }
    }
    const manager = createMainSessionManager({
      projectStore: { listProjects: vi.fn().mockResolvedValue([project]) } as never,
      getGenericAgentConfigs: vi.fn().mockResolvedValue([genericAgentConfig]),
      providerCatalogStore: { loadProviderCatalog: vi.fn().mockResolvedValue(providerCatalog) } as never,
      sessionStore: {
        createSession: vi.fn().mockResolvedValue(undefined),
        updateSession: vi.fn().mockResolvedValue(undefined),
        appendOutput: vi.fn().mockResolvedValue(undefined)
      } as never,
      hookEventsPath: 'E:/tmp/hooks',
      getMainWindow: () => window as never
    })

    const session = await manager.startSession({
      projectId: 'project-1',
      workerType: 'claude-code',
      providerProfileId: 'provider-1'
    })

    onEvent?.({
      sessionId: session.id,
      state: 'needsReview',
      source: 'claude-code-hook',
      hookName: 'Stop',
      occurredAt: '2026-05-26T00:00:00.000Z'
    })
    onEvent?.({
      sessionId: session.id,
      state: 'needsReview',
      source: 'claude-code-hook',
      hookName: 'Notification',
      occurredAt: '2026-05-26T00:00:01.000Z'
    })

    expect(shell.beep).toHaveBeenCalledTimes(1)
    expect(Notification).toHaveBeenCalledTimes(1)
    expect(Notification).toHaveBeenCalledWith({
      title: '任务需要查看',
      body: 'Project One / Provider One 已完成本轮响应',
      silent: true
    })
    expect(mockNotificationShow).toHaveBeenCalledTimes(1)
    expect(window.flashFrame).toHaveBeenCalledTimes(1)
    expect(window.flashFrame).toHaveBeenCalledWith(true)
    expect(window.once).toHaveBeenCalledWith('focus', expect.any(Function))
    focusHandler?.()
    expect(window.flashFrame).toHaveBeenLastCalledWith(false)
    expect(window.webContents.send).toHaveBeenCalledWith(
      ipcChannels.sessionAttentionChanged,
      expect.objectContaining({ sessionId: session.id, state: 'needsReview' })
    )

    onEvent?.({
      sessionId: session.id,
      state: 'working',
      source: 'claude-code-hook',
      hookName: 'UserPromptSubmit',
      occurredAt: '2026-05-26T00:00:02.000Z'
    })
    onEvent?.({
      sessionId: session.id,
      state: 'needsReview',
      source: 'claude-code-hook',
      hookName: 'Stop',
      occurredAt: '2026-05-26T00:00:03.000Z'
    })

    expect(shell.beep).toHaveBeenCalledTimes(2)
    expect(Notification).toHaveBeenCalledTimes(2)
    expect(mockNotificationShow).toHaveBeenCalledTimes(2)
    expect(window.flashFrame).toHaveBeenCalledTimes(3)
    expect(window.flashFrame).toHaveBeenLastCalledWith(true)
  })
})
