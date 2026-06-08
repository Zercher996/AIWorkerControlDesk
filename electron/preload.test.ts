import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/types/workerDesk'
import { registerIpcHandlers } from './ipc/handlers'
import { ipcChannels } from './ipc/channels'

vi.mock('./providers/currentClaudeConfig', () => ({
  readCurrentClaudeConfig: vi.fn(async () => ({
    source: 'current-claude-config',
    baseUrl: 'http://127.0.0.1:53159',
    model: 'gpt-5.4',
    apiKeySource: 'ANTHROPIC_AUTH_TOKEN',
    env: {
      ANTHROPIC_AUTH_TOKEN: 'secret-token',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:53159',
      ANTHROPIC_MODEL: 'gpt-5.4'
    }
  }))
}))

type MockElectronModule = {
  contextBridge: { exposeInMainWorld: ReturnType<typeof vi.fn> }
  ipcRenderer: { invoke: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> }
  dialog: { showOpenDialog: ReturnType<typeof vi.fn>; showSaveDialog: ReturnType<typeof vi.fn> }
  __exposeInMainWorld: ReturnType<typeof vi.fn>
  __invoke: ReturnType<typeof vi.fn>
  __on: ReturnType<typeof vi.fn>
  __off: ReturnType<typeof vi.fn>
}

vi.mock('electron', () => {
  const exposeInMainWorld = vi.fn()
  const invoke = vi.fn()
  const on = vi.fn()
  const off = vi.fn()
  const showOpenDialog = vi.fn()
  const showSaveDialog = vi.fn()
  return {
    contextBridge: {
      exposeInMainWorld
    },
    ipcRenderer: {
      invoke,
      on,
      off
    },
    dialog: {
      showOpenDialog,
      showSaveDialog
    },
    __exposeInMainWorld: exposeInMainWorld,
    __invoke: invoke,
    __on: on,
    __off: off
  }
})

describe('preload workerDesk api', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('exposes updateProject through workerDesk api', async () => {
    const electron = await import('electron') as unknown as MockElectronModule
    await import('./preload')

    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('workerDesk', expect.any(Object))
    const workerDesk = electron.__exposeInMainWorld.mock.lastCall?.[1]
    expect(workerDesk).toBeDefined()

    const patch: Pick<Project, 'autoDispatchGenericAgent'> = {
      autoDispatchGenericAgent: true
    }

    await workerDesk.updateProject('project-1', patch)

    expect(electron.__invoke).toHaveBeenCalledWith('workerDesk:updateProject', 'project-1', patch)
  })

  it('exposes removeProject through workerDesk api', async () => {
    const electron = await import('electron') as unknown as MockElectronModule
    await import('./preload')

    const workerDesk = electron.__exposeInMainWorld.mock.lastCall?.[1]
    expect(workerDesk).toBeDefined()

    await workerDesk.removeProject('project-1')

    expect(electron.__invoke).toHaveBeenCalledWith(ipcChannels.removeProject, 'project-1')
  })

  it('exposes provider catalog api through workerDesk preload bridge', async () => {
    const electron = await import('electron') as unknown as MockElectronModule
    await import('./preload')

    const workerDesk = electron.__exposeInMainWorld.mock.lastCall?.[1]
    expect(workerDesk).toBeDefined()

    const patch = {
      providers: [{ id: 'provider-1', name: 'Anthropic Direct' }]
    }

    await workerDesk.listProviderCatalog()
    await workerDesk.saveProviderCatalogPatch(patch)
    await workerDesk.getCurrentClaudeConfig()

    expect(electron.__invoke).toHaveBeenNthCalledWith(1, ipcChannels.listProviderCatalog)
    expect(electron.__invoke).toHaveBeenNthCalledWith(2, ipcChannels.saveProviderCatalogPatch, patch)
    expect(electron.__invoke).toHaveBeenNthCalledWith(3, ipcChannels.getCurrentClaudeConfig)
  })

  it('exposes session attention event subscription through workerDesk preload bridge', async () => {
    const electron = await import('electron') as unknown as MockElectronModule
    await import('./preload')

    const workerDesk = electron.__exposeInMainWorld.mock.lastCall?.[1]
    expect(workerDesk).toBeDefined()
    const handler = vi.fn()
    const dispose = workerDesk.onSessionAttentionChanged(handler)

    expect(electron.__on).toHaveBeenCalledWith(ipcChannels.sessionAttentionChanged, expect.any(Function))
    const listener = electron.__on.mock.lastCall?.[1]
    const event = { sessionId: 'session-1', state: 'needsReview', source: 'claude-code-hook', hookName: 'Stop', occurredAt: '2026-05-25T00:00:00.000Z' }
    listener(undefined, event)
    expect(handler).toHaveBeenCalledWith(event)

    dispose()
    expect(electron.__off).toHaveBeenCalledWith(ipcChannels.sessionAttentionChanged, listener)
  })
  it('exposes session AI event subscription through workerDesk preload bridge', async () => {
    const electron = await import('electron') as unknown as MockElectronModule
    await import('./preload')

    const workerDesk = electron.__exposeInMainWorld.mock.lastCall?.[1]
    expect(workerDesk).toBeDefined()
    const handler = vi.fn()
    const dispose = workerDesk.onSessionAiEvent(handler)

    expect(electron.__on).toHaveBeenCalledWith(ipcChannels.sessionAiEvent, expect.any(Function))
    const listener = electron.__on.mock.lastCall?.[1]
    const event = { id: 'event-1', sessionId: 'session-1', timestamp: '2026-05-29T00:00:00.000Z', source: 'desk', type: 'user_message', text: 'hi' }
    listener(undefined, event)
    expect(handler).toHaveBeenCalledWith(event)

    dispose()
    expect(electron.__off).toHaveBeenCalledWith(ipcChannels.sessionAiEvent, listener)
  })

  it('exposes slash assist index through workerDesk preload bridge', async () => {
    const electron = await import('electron') as unknown as MockElectronModule
    await import('./preload')

    const workerDesk = electron.__exposeInMainWorld.mock.lastCall?.[1]
    expect(workerDesk).toBeDefined()

    const input = { projectId: 'project-1', query: '/re', limit: 10, refresh: true }
    await workerDesk.listSlashAssistIndex(input)

    expect(electron.__invoke).toHaveBeenCalledWith(ipcChannels.listSlashAssistIndex, input)
  })

  it('keeps the legacy slash command suggestions bridge as a compatibility alias', async () => {
    const electron = await import('electron') as unknown as MockElectronModule
    await import('./preload')

    const workerDesk = electron.__exposeInMainWorld.mock.lastCall?.[1]
    expect(workerDesk).toBeDefined()

    const input = { projectId: 'project-1', query: '/re', limit: 10 }
    await workerDesk.listSlashCommandSuggestions(input)

    expect(electron.__invoke).toHaveBeenCalledWith(ipcChannels.listSlashCommandSuggestions, input)
  })

})

describe('registerIpcHandlers provider catalog handlers', () => {
  const projectStore = {
    listProjects: vi.fn().mockResolvedValue([]),
    addProject: vi.fn(),
    updateProject: vi.fn(),
    removeProject: vi.fn().mockResolvedValue({ id: 'project-2' })
  }
  const loadGenericAgentConfigs = vi.fn().mockResolvedValue([])
  const sessionManager = {
    startSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    selectSession: vi.fn(),
    getOutputBuffer: vi.fn().mockReturnValue('buffer output'),
    sendSessionMessage: vi.fn(),
    getSessionAiEvents: vi.fn().mockResolvedValue({ events: [], totalBytes: 0 }),
    writeSessionInput: vi.fn(),
    resizeSession: vi.fn(),
    stopSession: vi.fn()
  }
  const sessionStore = {
    listHistory: vi.fn().mockResolvedValue([]),
    getOutput: vi.fn(),
    getSummary: vi.fn(),
    getCliSummary: vi.fn(),
    search: vi.fn(),
    buildExportText: vi.fn(),
    writeSummary: vi.fn(),
    writeCliSummary: vi.fn()
  }
  const summaryGenerator = {
    generateSummary: vi.fn(),
    generateCliSummary: vi.fn()
  }
  const cliHistory = {
    listCliHistory: vi.fn(),
    getCliSessionOutput: vi.fn(),
    searchCliHistory: vi.fn()
  }
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates getOutputBuffer IPC handler to sessionManager', async () => {
    const handle = vi.fn()

    registerIpcHandlers({
      ipcMain: { handle } as never,
      getMainWindow: () => null,
      projectStore: projectStore as never,
      loadGenericAgentConfigs,
      sessionManager: sessionManager as never,
      sessionStore: sessionStore as never,
      summaryGenerator,
      cliHistory: cliHistory as never
    })

    const handlers = new Map(handle.mock.calls.map(([channel, registeredHandler]) => [channel, registeredHandler]))
    const getOutputBufferHandler = handlers.get(ipcChannels.getOutputBuffer)

    expect(getOutputBufferHandler).toBeTypeOf('function')
    expect(getOutputBufferHandler(undefined, 'session-1')).toBe('buffer output')
    expect(sessionManager.getOutputBuffer).toHaveBeenCalledWith('session-1')
  })

  it('delegates removeProject IPC handler to projectStore', async () => {
    const handle = vi.fn()

    registerIpcHandlers({
      ipcMain: { handle } as never,
      getMainWindow: () => null,
      projectStore: projectStore as never,
      loadGenericAgentConfigs,
      sessionManager: sessionManager as never,
      sessionStore: sessionStore as never,
      summaryGenerator,
      cliHistory: cliHistory as never
    })

    const handlers = new Map(handle.mock.calls.map(([channel, registeredHandler]) => [channel, registeredHandler]))
    const removeHandler = handlers.get(ipcChannels.removeProject)

    expect(removeHandler).toBeTypeOf('function')
    await expect(removeHandler(undefined, 'project-1')).resolves.toEqual({ id: 'project-2' })
    expect(projectStore.removeProject).toHaveBeenCalledWith('project-1')
  })

  it('delegates provider catalog IPC handlers to providerCatalogStore', async () => {
    const handle = vi.fn()
    const providerCatalogStore = {
      loadProviderCatalog: vi.fn(),
      listProviderCatalogSafe: vi.fn().mockResolvedValue([{ id: 'provider-1' }]),
      saveProviderCatalog: vi.fn(),
      saveProviderCatalogPatch: vi.fn().mockResolvedValue({ version: 1, providers: [{ id: 'provider-1' }] })
    }

    registerIpcHandlers({
      ipcMain: { handle } as never,
      getMainWindow: () => null,
      projectStore: projectStore as never,
      loadGenericAgentConfigs,
      sessionManager: sessionManager as never,
      sessionStore: sessionStore as never,
      summaryGenerator,
      cliHistory: cliHistory as never,
      providerCatalogStore
    })

    const handlers = new Map(handle.mock.calls.map(([channel, registeredHandler]) => [channel, registeredHandler]))
    const listHandler = handlers.get(ipcChannels.listProviderCatalog)
    const saveHandler = handlers.get(ipcChannels.saveProviderCatalogPatch)
    const currentClaudeHandler = handlers.get(ipcChannels.getCurrentClaudeConfig)
    const patch = { providers: [{ id: 'provider-2' }] }

    expect(listHandler).toBeTypeOf('function')
    expect(saveHandler).toBeTypeOf('function')
    expect(currentClaudeHandler).toBeTypeOf('function')
    await expect(listHandler()).resolves.toEqual([{ id: 'provider-1' }])
    await expect(saveHandler(undefined, patch)).resolves.toEqual({
      version: 1,
      providers: [{ id: 'provider-1' }]
    })
    await expect(currentClaudeHandler()).resolves.toEqual(expect.objectContaining({ source: 'current-claude-config' }))
    expect(providerCatalogStore.listProviderCatalogSafe).toHaveBeenCalledTimes(1)
    expect(providerCatalogStore.saveProviderCatalogPatch).toHaveBeenCalledWith(patch)
  })

  it('fails provider catalog IPC calls clearly when providerCatalogStore is unavailable', async () => {
    const handle = vi.fn()

    registerIpcHandlers({
      ipcMain: { handle } as never,
      getMainWindow: () => null,
      projectStore: projectStore as never,
      loadGenericAgentConfigs,
      sessionManager: sessionManager as never,
      sessionStore: sessionStore as never,
      summaryGenerator,
      cliHistory: cliHistory as never
    })

    const handlers = new Map(handle.mock.calls.map(([channel, registeredHandler]) => [channel, registeredHandler]))
    const listHandler = handlers.get(ipcChannels.listProviderCatalog)
    const saveHandler = handlers.get(ipcChannels.saveProviderCatalogPatch)

    await expect(listHandler()).rejects.toThrow('Provider catalog store is unavailable')
    await expect(saveHandler(undefined, { providers: [] })).rejects.toThrow('Provider catalog store is unavailable')
  })

  it('delegates slash assist IPC handler to discovery service', async () => {
    const handle = vi.fn()
    const slashCommandDiscovery = {
      listSlashAssistIndex: vi.fn().mockResolvedValue({ items: [], sourceStatus: 'empty' })
    }

    registerIpcHandlers({
      ipcMain: { handle } as never,
      getMainWindow: () => null,
      projectStore: projectStore as never,
      loadGenericAgentConfigs,
      sessionManager: sessionManager as never,
      sessionStore: sessionStore as never,
      summaryGenerator,
      cliHistory: cliHistory as never,
      slashCommandDiscovery
    })

    const handlers = new Map(handle.mock.calls.map(([channel, registeredHandler]) => [channel, registeredHandler]))
    const assistHandler = handlers.get(ipcChannels.listSlashAssistIndex)
    const legacyHandler = handlers.get(ipcChannels.listSlashCommandSuggestions)
    const input = { projectId: 'project-1', query: '/re' }

    await expect(assistHandler(undefined, input)).resolves.toEqual({ items: [], sourceStatus: 'empty' })
    await expect(legacyHandler(undefined, input)).resolves.toEqual({ items: [], sourceStatus: 'empty' })
    expect(slashCommandDiscovery.listSlashAssistIndex).toHaveBeenCalledWith(input)
  })
})

