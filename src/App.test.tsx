import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetGenericAgentReturnRegistryForTesting } from './hooks/genericAgentReturnRegistry'
import { resetAutoReturnDelayMsForTesting, setAutoReturnDelayMsForTesting } from './hooks/useGenericAgentAutoReturn'
import { resetClaudeCodeGenericAgentInstructionDelayForTesting, setClaudeCodeGenericAgentInstructionDelayForTesting } from './hooks/useClaudeCodeGenericAgentInstruction'

beforeEach(() => {
  resetGenericAgentReturnRegistryForTesting()
  resetAutoReturnDelayMsForTesting()
  resetClaudeCodeGenericAgentInstructionDelayForTesting()
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
})
import type { CliHistorySession, DeskHistoryItem, Project, Session, SessionAiEvent, SessionAttentionEvent, SessionOutputEvent } from './types/workerDesk'
import { App } from './App'

type TerminalPaneMockProps = {
  selectedSession?: { id: string; workerType: string; parentSessionId?: string }
  canReturnToParentClaude?: boolean
  onInputAnchorCreated?: (sessionId: string, summary: string) => void
  onReturnToParentClaude?: (sessionId: string, parentSessionId: string) => void
  onReturnToAiPane?: (sessionId: string) => void
}

vi.mock('./components/TerminalPane', () => ({
  TerminalPane: (props: TerminalPaneMockProps) => (
    <section>
      Terminal mock
      {props.selectedSession ? (
        <button
          type="button"
          onClick={() => props.onInputAnchorCreated?.(props.selectedSession!.id, '写一篇 800 字作文')}
        >
          模拟首个输入圆点
        </button>
      ) : null}
      {props.selectedSession ? (
        <button type="button" onClick={() => props.onReturnToAiPane?.(props.selectedSession!.id)}>
          返回 AI 页面
        </button>
      ) : null}
      {props.selectedSession?.workerType === 'generic-agent' && props.selectedSession.parentSessionId ? (
        <button
          disabled={!props.canReturnToParentClaude}
          onClick={() => props.onReturnToParentClaude?.(props.selectedSession!.id, props.selectedSession!.parentSessionId!)}
        >
          返回给 Claude Code
        </button>
      ) : null}
    </section>
  )
}))

const project: Project = {
  id: 'project-1',
  name: 'Project One',
  path: 'E:/project-one',
  createdAt: '2026-05-11T00:00:00.000Z',
  lastUsedAt: '2026-05-11T00:00:00.000Z',
  autoDispatchGenericAgent: false
}

const deskHistory: DeskHistoryItem = {
  id: 'desk-1',
  projectId: 'project-1',
  workerType: 'claude-code',
  interactionMode: 'pty',
  status: 'exited',
  title: 'Desk history',
  // Deliberately distant from cliHistory.updatedAt so the legacy time-window
  // backfill in App.tsx does NOT absorb this card into the cli card. We want
  // it visible as an orphan so we can exercise desk-only history flows.
  createdAt: '2025-01-01T00:00:00.000Z',
  lastActivityAt: '2025-01-01T00:00:01.000Z',
  exitedAt: '2025-01-01T00:00:02.000Z',
  exitCode: 0,
  outputRef: 'file:sessions/desk-1/output.jsonl',
  source: 'desk'
}

const cliHistory: CliHistorySession = {
  id: 'cli-1',
  projectId: 'project-1',
  firstMessage: 'CLI history',
  messageCount: 2,
  createdAt: '2026-05-11T00:00:00.000Z',
  updatedAt: '2026-05-11T00:00:03.000Z',
  // Above the 10KB low-signal threshold so this fixture appears in the primary
  // list. Tests targeting the low-signal collapse use a smaller file explicitly.
  fileSizeBytes: 12 * 1024,
  cwd: 'E:/project-one',
  source: 'cli'
}

const providerCatalogWithProviders = {
  version: 1 as const,
  providers: [
    {
      id: 'provider-1',
      name: 'Provider One',
      protocol: 'anthropic' as const,
      auth: { type: 'api-key' as const, hasApiKey: true, apiKeyPreview: 'sk-...abc' },
      endpoint: { baseUrl: 'https://api.anthropic.com' },
      model: { id: 'claude-sonnet-4-6' },
      adapters: {
        claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true },
        genericAgent: { enabled: true, sessionType: 'native_claude' }
      }
    }
  ]
}

const runningSession: Session = {
  id: 'session-1',
  projectId: 'project-1',
  workerType: 'claude-code',
  interactionMode: 'pty',
  processId: 123,
  status: 'running',
  title: 'Project One / Provider One',
  createdAt: '2026-05-11T00:00:00.000Z',
  lastActivityAt: '2026-05-11T00:00:00.000Z',
  outputRef: 'jsonl:session-1',
  providerProfileId: 'provider-1'
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function createWorkerDesk(overrides: Partial<typeof window.workerDesk> = {}) {
  return {
    listProjects: vi.fn().mockResolvedValue([project]),
    addProject: vi.fn(),
    updateProject: vi.fn(),
    removeProject: vi.fn().mockResolvedValue(undefined),
    pickProjectPath: vi.fn(),
    listGenericAgentConfigs: vi.fn().mockResolvedValue([]),
    startSession: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([] as Session[]),
    selectSession: vi.fn(),
    getOutputBuffer: vi.fn().mockResolvedValue(''),
    sendSessionMessage: vi.fn().mockResolvedValue(undefined),
    getSessionAiEvents: vi.fn().mockResolvedValue({ events: [] as SessionAiEvent[], totalBytes: 0 }),
    writeSessionInput: vi.fn(),
    resizeSession: vi.fn(),
    stopSession: vi.fn(),
    onSessionOutput: vi.fn().mockReturnValue(() => undefined),
    onSessionAiEvent: vi.fn().mockReturnValue(() => undefined),
    onSessionChanged: vi.fn().mockReturnValue(() => undefined),
    onSessionAttentionChanged: vi.fn().mockReturnValue(() => undefined),
    listHistory: vi.fn().mockResolvedValue([deskHistory]),
    listProjectHistory: vi.fn().mockResolvedValue({ desk: [deskHistory], cli: [cliHistory] }),
    getOutput: vi.fn(),
    generateSummary: vi.fn(),
    getSummary: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    exportSession: vi.fn(),
    listCliHistory: vi.fn().mockResolvedValue([cliHistory]),
    getCliSessionOutput: vi.fn(),
    searchCliHistory: vi.fn().mockResolvedValue([]),
    listProviderCatalog: vi.fn().mockResolvedValue({ version: 1, providers: [] }),
    saveProviderCatalogPatch: vi.fn().mockResolvedValue({ version: 1, providers: [] }),
    getCurrentClaudeConfig: vi.fn().mockResolvedValue({
      source: 'current-claude-config' as const,
      baseUrl: 'http://127.0.0.1:53159',
      model: 'gpt-5.4',
      apiKeySource: 'ANTHROPIC_AUTH_TOKEN' as const
    }),
    listCcswitchClaudeProviderPreviews: vi.fn().mockResolvedValue([]),
    importCcswitchClaudeProviders: vi.fn().mockResolvedValue({ version: 1, providers: [] }),
    listSlashAssistIndex: vi.fn().mockResolvedValue({ items: [], sourceStatus: 'empty' }),
    listSlashCommandSuggestions: vi.fn().mockResolvedValue({ items: [], sourceStatus: 'empty' }),
    setWindowTheme: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

describe('App theme modes', () => {
  it('keeps the top menu bar window-level without duplicated panel state', async () => {
    const waitingSession: Session = {
      ...runningSession,
      id: 'waiting-session',
      status: 'waiting',
      title: 'Waiting task'
    }
    const exitedSession: Session = {
      ...runningSession,
      id: 'exited-session',
      status: 'exited',
      title: 'Finished task',
      exitedAt: '2026-05-11T00:00:02.000Z',
      exitCode: 0
    }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([runningSession, waitingSession, exitedSession])
    })
    window.workerDesk = workerDesk

    render(<App />)

    await waitFor(() => expect(screen.getAllByText('Project One').length).toBeGreaterThan(0))
    await screen.findByText('Waiting task')
    const topbar = screen.getByLabelText('顶部调度栏')
    expect(within(topbar).getByText('AIWorkerControlDesk')).toBeInTheDocument()
    expect(within(topbar).getByText('本地 AI Worker 调度台')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '切换到浅色模式' })).toHaveTextContent('浅')
    expect(topbar).not.toHaveTextContent(/Project One|Provider One|claude-sonnet-4-6/)
    expect(topbar).not.toHaveTextContent(/项目|模型|需接管|运行\s+\d|完成\s+\d/)
    expect(screen.queryByText(/Dieter Rams|Rams|健康分|评分|AI 推荐指数|DAG|节点图|工作流/)).not.toBeInTheDocument()
  })

  it('defaults to dark theme without exposing reviewer or fake scoring copy', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders)
    })
    window.workerDesk = workerDesk

    render(<App />)

    expect(await screen.findByRole('button', { name: '当前会话' })).toBeInTheDocument()
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(screen.getByRole('button', { name: '切换到浅色模式' })).toHaveTextContent('浅')
    await waitFor(() => expect(workerDesk.setWindowTheme).toHaveBeenCalledWith('dark'))
    expect(screen.queryByText(/Dieter Rams|Rams|健康分|评分|AI 推荐指数/)).not.toBeInTheDocument()
  })

  it('switches to light theme and persists it', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '切换到浅色模式' }))

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(window.localStorage.getItem('ai-worker-theme')).toBe('light')
    await waitFor(() => expect(workerDesk.setWindowTheme).toHaveBeenLastCalledWith('light'))
    expect(screen.getByRole('button', { name: '切换到深色模式' })).toHaveTextContent('深')
  })

  it('restores a persisted light theme on startup', async () => {
    window.localStorage.setItem('ai-worker-theme', 'light')
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders)
    })
    window.workerDesk = workerDesk

    render(<App />)

    expect(await screen.findByRole('button', { name: '切换到深色模式' })).toBeInTheDocument()
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('falls back to dark theme for invalid persisted values', async () => {
    window.localStorage.setItem('ai-worker-theme', 'solarized')
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders)
    })
    window.workerDesk = workerDesk

    render(<App />)

    expect(await screen.findByRole('button', { name: '切换到浅色模式' })).toBeInTheDocument()
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem('ai-worker-theme')).toBe('dark')
  })
})

describe('App initial loading', () => {
  it('loads provider catalog on startup and selects the first provider', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders)
    })
    window.workerDesk = workerDesk

    render(<App />)

    await waitFor(() => expect(workerDesk.listProviderCatalog).toHaveBeenCalled())
  })

  it('does not override already selected provider when catalog reloads', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders)
    })
    window.workerDesk = workerDesk

    render(<App />)

    await waitFor(() => expect(workerDesk.listProviderCatalog).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: '管理模型' }))
    await waitFor(() => expect(workerDesk.listProviderCatalog).toHaveBeenCalledTimes(2))
  })
})

describe('App session interactions', () => {
  it('uses quiet Chinese labels for right-side tabs', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders)
    })
    window.workerDesk = workerDesk

    render(<App />)

    expect(await screen.findByRole('button', { name: '当前会话' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '历史' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Terminal' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument()
  })

  it('puts the selected task name into the current-session tab instead of a separate right-side header', async () => {
    const nativeJsonlSession: Session = {
      ...runningSession,
      interactionMode: 'native-jsonl',
      status: 'waiting',
      taskTitle: '检查调度台 UI'
    }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([nativeJsonlSession])
    })
    window.workerDesk = workerDesk

    render(<App />)

    expect(await screen.findByRole('button', { name: '当前会话：检查调度台 UI' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '历史' })).toBeInTheDocument()
    expect(screen.queryByText('任务：检查调度台 UI')).not.toBeInTheDocument()
  })

  it('falls back to the selected session title in the current-session tab', async () => {
    const nativeJsonlSession: Session = {
      ...runningSession,
      interactionMode: 'native-jsonl',
      status: 'waiting',
      taskTitle: undefined
    }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([nativeJsonlSession])
    })
    window.workerDesk = workerDesk

    render(<App />)

    expect(await screen.findByRole('button', { name: '当前会话：Project One / Provider One' })).toBeInTheDocument()
    expect(screen.queryByText('会话：Project One / Provider One')).not.toBeInTheDocument()
  })

  it('keeps right-rail AI events isolated when users switch sessions before a previous load resolves', async () => {
    const firstSession: Session = {
      ...runningSession,
      id: 'session-a',
      interactionMode: 'native-jsonl',
      status: 'waiting',
      title: 'First session',
      taskTitle: 'First task'
    }
    const secondSession: Session = {
      ...runningSession,
      id: 'session-b',
      interactionMode: 'native-jsonl',
      status: 'waiting',
      title: 'Second session',
      taskTitle: 'Second task'
    }
    const firstEvents = createDeferred<{ events: SessionAiEvent[]; totalBytes: number }>()
    const secondEvents = createDeferred<{ events: SessionAiEvent[]; totalBytes: number }>()
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([firstSession, secondSession]),
      getSessionAiEvents: vi.fn().mockImplementation(({ sessionId }: { sessionId: string }) => {
        if (sessionId === 'session-a') return firstEvents.promise
        if (sessionId === 'session-b') return secondEvents.promise
        return Promise.resolve({ events: [], totalBytes: 0 })
      })
    })
    window.workerDesk = workerDesk

    render(<App />)

    expect(await screen.findByRole('button', { name: '当前会话：First task' })).toBeInTheDocument()
    fireEvent.click(await screen.findByText('Second task'))

    await waitFor(() => expect(workerDesk.getSessionAiEvents).toHaveBeenCalledWith({ sessionId: 'session-b', offset: 0, limit: 1000 }))
    await act(async () => {
      secondEvents.resolve({
        events: [{
          id: 'session-b-ai-1',
          sessionId: 'session-b',
          timestamp: '2026-05-29T00:00:01.000Z',
          source: 'desk',
          type: 'assistant_text',
          text: 'second output'
        }],
        totalBytes: 12
      })
    })
    expect(await screen.findByText('second output')).toBeInTheDocument()

    await act(async () => {
      firstEvents.resolve({
        events: [{
          id: 'session-a-ai-1',
          sessionId: 'session-a',
          timestamp: '2026-05-29T00:00:00.000Z',
          source: 'desk',
          type: 'assistant_text',
          text: 'stale first output'
        }],
        totalBytes: 18
      })
    })

    expect(screen.getByRole('button', { name: '当前会话：Second task' })).toBeInTheDocument()
    expect(screen.getByText('second output')).toBeInTheDocument()
    expect(screen.queryByText('stale first output')).not.toBeInTheDocument()
  })

  it('keeps live AI events hidden until their own session is selected', async () => {
    const aiEventHandlers: Array<(event: SessionAiEvent) => void> = []
    const firstSession: Session = {
      ...runningSession,
      id: 'session-a',
      interactionMode: 'native-jsonl',
      status: 'waiting',
      title: 'First session',
      taskTitle: 'First task'
    }
    const secondSession: Session = {
      ...runningSession,
      id: 'session-b',
      interactionMode: 'native-jsonl',
      status: 'waiting',
      title: 'Second session',
      taskTitle: 'Second task'
    }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([firstSession, secondSession]),
      onSessionAiEvent: vi.fn().mockImplementation((handler: (event: SessionAiEvent) => void) => {
        aiEventHandlers.push(handler)
        return () => undefined
      })
    })
    window.workerDesk = workerDesk

    render(<App />)

    expect(await screen.findByRole('button', { name: '当前会话：First task' })).toBeInTheDocument()
    await act(async () => {
      aiEventHandlers.forEach((handler) => handler({
        id: 'session-b-live-1',
        sessionId: 'session-b',
        timestamp: '2026-05-29T00:00:02.000Z',
        source: 'desk',
        type: 'assistant_text',
        text: 'second live output'
      }))
    })

    expect(screen.queryByText('second live output')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Second task'))
    expect(await screen.findByText('second live output')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '当前会话：Second task' })).toBeInTheDocument()
  })

  it('keeps the current session as the default AI workbench instead of a terminal shell or fake dashboard', async () => {
    const nativeJsonlSession: Session = {
      ...runningSession,
      interactionMode: 'native-jsonl',
      status: 'waiting',
      taskTitle: '检查调度台 UI'
    }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([nativeJsonlSession]),
      getSessionAiEvents: vi.fn().mockResolvedValue({
        events: [{
          id: 'assistant-1',
          sessionId: 'session-1',
          timestamp: '2026-05-29T00:00:00.000Z',
          source: 'desk',
          type: 'assistant_text',
          text: '结构化 AI 输出'
        }],
        totalBytes: 0
      })
    })
    window.workerDesk = workerDesk

    render(<App />)

    expect(await screen.findByRole('button', { name: '当前会话' })).toBeInTheDocument()
    expect(await screen.findByText('结构化 AI 输出')).toBeInTheDocument()
    expect(screen.queryByText('Terminal mock')).not.toBeInTheDocument()
    expect(screen.queryByText(/健康分|智能评分|效率分|AI 推荐指数|DAG|节点图|工作流平台|Git 工作台|MCP 管理器/)).not.toBeInTheDocument()
  })

  it('shows sanitized CLI summary errors without Electron IPC prefix', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      getCliSessionOutput: vi.fn().mockResolvedValue('CLI output'),
      getSummary: vi.fn().mockResolvedValue(undefined),
      generateSummary: vi.fn().mockRejectedValue(new Error('Error invoking remote method \'workerDesk:generateSummary\': Error: Provider One 的 API 使用额度已达上限，请稍后重试或切换模型连接'))
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '历史' }))
    fireEvent.click(await screen.findByRole('button', { name: /CLI history/ }))
    fireEvent.click(await screen.findByRole('button', { name: '生成 Summary' }))

    expect(await screen.findByText('Provider One 的 API 使用额度已达上限，请稍后重试或切换模型连接')).toBeInTheDocument()
    expect(screen.queryByText(/Error invoking remote method/)).not.toBeInTheDocument()
  })

  it('allows dismissing an error toast', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      getCliSessionOutput: vi.fn().mockResolvedValue('CLI output'),
      getSummary: vi.fn().mockResolvedValue(undefined),
      generateSummary: vi.fn().mockRejectedValue(new Error('生成 Summary 失败'))
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '历史' }))
    fireEvent.click(await screen.findByRole('button', { name: /CLI history/ }))
    fireEvent.click(await screen.findByRole('button', { name: '生成 Summary' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('生成 Summary 失败')
    fireEvent.click(screen.getByRole('button', { name: '关闭错误提示' }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('dismisses the error toast when clicking the toast itself', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      getCliSessionOutput: vi.fn().mockResolvedValue('CLI output'),
      getSummary: vi.fn().mockResolvedValue(undefined),
      generateSummary: vi.fn().mockRejectedValue(new Error('生成 Summary 失败'))
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '历史' }))
    fireEvent.click(await screen.findByRole('button', { name: /CLI history/ }))
    fireEvent.click(await screen.findByRole('button', { name: '生成 Summary' }))

    fireEvent.click(await screen.findByRole('alert'))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('continues desk history by starting a new session from summary with selected provider model', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      startSession: vi.fn().mockResolvedValue(runningSession),
      getOutput: vi.fn().mockResolvedValue({ chunks: [], totalBytes: 0 }),
      getSummary: vi.fn().mockResolvedValue('Desk summary'),
      sendSessionMessage: vi.fn().mockResolvedValue(undefined)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '历史' }))
    fireEvent.click(await screen.findByRole('button', { name: /Desk history/ }))
    fireEvent.click(await screen.findByRole('button', { name: '基于 Summary 继续任务' }))

    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalled())
    expect(workerDesk.startSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      workerType: 'claude-code',
      providerProfileId: 'provider-1',
      providerModelId: 'claude-sonnet-4-6',
      claudeLaunchSource: { type: 'provider', providerProfileId: 'provider-1', providerModelId: 'claude-sonnet-4-6' },
      interactionMode: 'native-jsonl',
      initialPrompt: expect.stringContaining('Desk summary'),
      terminalSize: { cols: 100, rows: 30 }
    })
    expect(workerDesk.startSession).not.toHaveBeenCalledWith(expect.objectContaining({ profileId: expect.anything() }))
    expect(workerDesk.startSession).not.toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: 'desk-1' }))
    expect(workerDesk.sendSessionMessage).not.toHaveBeenCalled()
  })

  it('continues CLI history by starting a new session from summary with selected provider model', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      startSession: vi.fn().mockResolvedValue(runningSession),
      getCliSessionOutput: vi.fn().mockResolvedValue('CLI output'),
      getSummary: vi.fn().mockResolvedValue('CLI summary'),
      sendSessionMessage: vi.fn().mockResolvedValue(undefined)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '历史' }))
    fireEvent.click(await screen.findByRole('button', { name: /CLI history/ }))
    fireEvent.click(await screen.findByRole('button', { name: '基于 Summary 继续任务' }))

    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalled())
    expect(workerDesk.startSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      workerType: 'claude-code',
      providerProfileId: 'provider-1',
      providerModelId: 'claude-sonnet-4-6',
      claudeLaunchSource: { type: 'provider', providerProfileId: 'provider-1', providerModelId: 'claude-sonnet-4-6' },
      interactionMode: 'native-jsonl',
      initialPrompt: expect.stringContaining('CLI summary'),
      terminalSize: { cols: 100, rows: 30 }
    })
    expect(workerDesk.startSession).not.toHaveBeenCalledWith(expect.objectContaining({ profileId: expect.anything() }))
    expect(workerDesk.startSession).not.toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: 'cli-1' }))
    expect(workerDesk.sendSessionMessage).not.toHaveBeenCalled()
  })

  it('waits for a Claude Code GA task block before automatically dispatching GenericAgent', async () => {
    let outputHandler: ((event: SessionOutputEvent) => void) | undefined
    const autoDispatchProject: Project = {
      ...project,
      autoDispatchGenericAgent: true,
      genericAgentConfigId: 'ga-local'
    }
    const parentSession: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code'
    }
    const genericSession: Session = {
      ...runningSession,
      id: 'generic-session',
      workerType: 'generic-agent',
      parentSessionId: 'claude-session',
      dispatchMode: 'auto',
      genericAgentConfigId: 'ga-local'
    }
    const workerDesk = createWorkerDesk({
      listProjects: vi.fn().mockResolvedValue([autoDispatchProject]),
      listGenericAgentConfigs: vi.fn().mockResolvedValue([
        { id: 'ga-local', name: 'Local GenericAgent', home: 'E:/ga', pythonCommand: 'python', entryScript: 'agentmain.py', env: {} }
      ]),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      onSessionOutput: vi.fn().mockImplementation((handler: (event: SessionOutputEvent) => void) => {
        outputHandler = handler
        return () => undefined
      }),
      startSession: vi.fn()
        .mockResolvedValueOnce(parentSession)
        .mockResolvedValueOnce(genericSession)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '开始工作' }))

    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(1))
    outputHandler?.({
      sessionId: 'claude-session',
      chunk: '● [GA_TASK:generic-agent]\n请检查 package scripts\n[/GA_TASK]',
      stream: 'stdout',
      timestamp: '2026-05-11T00:00:01.000Z'
    })

    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(2))
    expect(workerDesk.startSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      projectId: 'project-1',
      workerType: 'generic-agent',
      parentSessionId: 'claude-session',
      dispatchMode: 'auto',
      genericAgentConfigId: 'ga-local',
      providerProfileId: 'provider-1',
      initialPrompt: '请检查 package scripts',
      dispatchTask: '请检查 package scripts',
      terminalSize: { cols: 100, rows: 30 }
    }))
    expect(workerDesk.startSession).toHaveBeenNthCalledWith(2, expect.not.objectContaining({
      profileId: expect.anything()
    }))
  })

  it('dispatches GenericAgent from Claude Code bullet-rendered GA task blocks', async () => {
    let outputHandler: ((event: SessionOutputEvent) => void) | undefined
    const autoDispatchProject: Project = {
      ...project,
      autoDispatchGenericAgent: true,
      genericAgentConfigId: 'ga-local'
    }
    const parentSession: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code'
    }
    const genericSession: Session = {
      ...runningSession,
      id: 'generic-session',
      workerType: 'generic-agent',
      parentSessionId: 'claude-session',
      dispatchMode: 'auto',
      genericAgentConfigId: 'ga-local'
    }
    const workerDesk = createWorkerDesk({
      listProjects: vi.fn().mockResolvedValue([autoDispatchProject]),
      listGenericAgentConfigs: vi.fn().mockResolvedValue([
        { id: 'ga-local', name: 'Local GenericAgent', home: 'E:/ga', pythonCommand: 'python', entryScript: 'agentmain.py', env: {} }
      ]),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      onSessionOutput: vi.fn().mockImplementation((handler: (event: SessionOutputEvent) => void) => {
        outputHandler = handler
        return () => undefined
      }),
      startSession: vi.fn()
        .mockResolvedValueOnce(parentSession)
        .mockResolvedValueOnce(genericSession)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '开始工作' }))
    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(1))
    outputHandler?.({
      sessionId: 'claude-session',
      chunk: '● [GA_TASK:generic-agent]\n    请检查当前项目 package.json 的 scripts，只汇报脚本名，不要修改文件。\n    [/GA_TASK]',
      stream: 'stdout',
      timestamp: '2026-05-11T00:00:01.000Z'
    })

    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(2))
    expect(workerDesk.startSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      workerType: 'generic-agent',
      initialPrompt: '请检查当前项目 package.json 的 scripts，只汇报脚本名，不要修改文件。'
    }))
  })

  it('does not dispatch duplicate GenericAgent sessions from Claude Code status redraws', async () => {
    let outputHandler: ((event: SessionOutputEvent) => void) | undefined
    const autoDispatchProject: Project = {
      ...project,
      autoDispatchGenericAgent: true,
      genericAgentConfigId: 'ga-local'
    }
    const parentSession: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code'
    }
    const genericSession: Session = {
      ...runningSession,
      id: 'generic-session',
      workerType: 'generic-agent',
      parentSessionId: 'claude-session',
      dispatchMode: 'auto',
      genericAgentConfigId: 'ga-local'
    }
    const workerDesk = createWorkerDesk({
      listProjects: vi.fn().mockResolvedValue([autoDispatchProject]),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      onSessionOutput: vi.fn().mockImplementation((handler: (event: SessionOutputEvent) => void) => {
        outputHandler = handler
        return () => undefined
      }),
      startSession: vi.fn()
        .mockResolvedValueOnce(parentSession)
        .mockResolvedValueOnce(genericSession)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '开始工作' }))
    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(1))
    outputHandler?.({
      sessionId: 'claude-session',
      chunk: '● [GA_TASK:generic-agent] 你好 [/GA_TASK]\n',
      stream: 'stdout',
      timestamp: '2026-05-11T00:00:01.000Z'
    })

    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(2))
    outputHandler?.({
      sessionId: 'claude-session',
      chunk: '● [GA_TASK:generic-agent] 你好 [/GA_TASK]✻ Worked for 9s\n[/GA_TASK]\n',
      stream: 'stdout',
      timestamp: '2026-05-11T00:00:02.000Z'
    })

    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(2))
    expect(workerDesk.startSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      workerType: 'generic-agent',
      initialPrompt: '你好',
      dispatchTask: '你好'
    }))
  })

  it('does not treat carriage return redraws as separate GA task lines', async () => {
    let outputHandler: ((event: SessionOutputEvent) => void) | undefined
    const autoDispatchProject: Project = {
      ...project,
      autoDispatchGenericAgent: true,
      genericAgentConfigId: 'ga-local'
    }
    const parentSession: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code'
    }
    const genericSession: Session = {
      ...runningSession,
      id: 'generic-session',
      workerType: 'generic-agent',
      parentSessionId: 'claude-session',
      dispatchMode: 'auto',
      genericAgentConfigId: 'ga-local'
    }
    const workerDesk = createWorkerDesk({
      listProjects: vi.fn().mockResolvedValue([autoDispatchProject]),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      onSessionOutput: vi.fn().mockImplementation((handler: (event: SessionOutputEvent) => void) => {
        outputHandler = handler
        return () => undefined
      }),
      startSession: vi.fn()
        .mockResolvedValueOnce(parentSession)
        .mockResolvedValueOnce(genericSession)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '开始工作' }))
    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(1))
    outputHandler?.({
      sessionId: 'claude-session',
      chunk: '● [GA_TASK:generic-agent] 你好 [/GA_TASK]\r✻ Worked for 9s\n',
      stream: 'stdout',
      timestamp: '2026-05-11T00:00:01.000Z'
    })

    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(2))
    expect(workerDesk.startSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      workerType: 'generic-agent',
      initialPrompt: '你好',
      dispatchTask: '你好'
    }))
  })

  it('does not dispatch GenericAgent when PTY output is user input echo with ANSI controls', async () => {
    let outputHandler: ((event: SessionOutputEvent) => void) | undefined
    const autoDispatchProject: Project = {
      ...project,
      autoDispatchGenericAgent: true,
      genericAgentConfigId: 'ga-local'
    }
    const parentSession: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code'
    }
    const workerDesk = createWorkerDesk({
      listProjects: vi.fn().mockResolvedValue([autoDispatchProject]),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      onSessionOutput: vi.fn().mockImplementation((handler: (event: SessionOutputEvent) => void) => {
        outputHandler = handler
        return () => undefined
      }),
      startSession: vi.fn().mockResolvedValueOnce(parentSession)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '开始工作' }))
    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(1))
    outputHandler?.({
      sessionId: 'claude-session',
      chunk: '\x1b[K\r\n\x1b[7m\x1b[6;3H \x1b[27m\b请只输出下面这个任务块，不要解释：\r\n  [GA_TASK:generic-agent] 你好 [/GA_TASK]\x1b[7m \x1b[27m\x1b[K\x1b[38;2;136;136;136m\r\n',
      stream: 'stdout',
      timestamp: '2026-05-11T00:00:01.000Z'
    })

    expect(workerDesk.startSession).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['single line', '● [GA_TASK:generic-agent] 查看 scripts [/GA_TASK]', '查看 scripts'],
    ['content on close line', '● [GA_TASK:generic-agent]\n查看 scripts [/GA_TASK]', '查看 scripts'],
    ['content on open line', '● [GA_TASK:generic-agent] 查看 scripts\n[/GA_TASK]', '查看 scripts'],
  ])('dispatches GenericAgent for %s GA task format', async (_caseName, chunk, expectedPrompt) => {
    let outputHandler: ((event: SessionOutputEvent) => void) | undefined
    const autoDispatchProject: Project = {
      ...project,
      autoDispatchGenericAgent: true,
      genericAgentConfigId: 'ga-local'
    }
    const parentSession: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code'
    }
    const genericSession: Session = {
      ...runningSession,
      id: 'ga-session',
      workerType: 'generic-agent',
      parentSessionId: 'claude-session'
    }
    const workerDesk = createWorkerDesk({
      listProjects: vi.fn().mockResolvedValue([autoDispatchProject]),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      onSessionOutput: vi.fn().mockImplementation((handler: (event: SessionOutputEvent) => void) => {
        outputHandler = handler
        return () => undefined
      }),
      startSession: vi.fn()
        .mockResolvedValueOnce(parentSession)
        .mockResolvedValueOnce(genericSession)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '开始工作' }))
    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(1))
    outputHandler?.({
      sessionId: 'claude-session',
      chunk,
      stream: 'stdout',
      timestamp: '2026-05-11T00:00:01.000Z'
    })

    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(2))
    expect(workerDesk.startSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      workerType: 'generic-agent',
      initialPrompt: expectedPrompt
    }))
  })

  it.each([
    ['ordinary output', '普通输出，没有任务块'],
    ['bare GA task marker', '[GA_TASK]\n请检查 package scripts\n[/GA_TASK]'],
    ['inline start marker', '用户输入 [GA_TASK:generic-agent]\n请检查 package scripts\n[/GA_TASK]'],
    ['wrong target marker', '[GA_TASK:other-worker]\n请检查 package scripts\n[/GA_TASK]']
  ])('does not dispatch GenericAgent for %s', async (_caseName, chunk) => {
    let outputHandler: ((event: SessionOutputEvent) => void) | undefined
    const autoDispatchProject: Project = {
      ...project,
      autoDispatchGenericAgent: true,
      genericAgentConfigId: 'ga-local'
    }
    const parentSession: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code'
    }
    const workerDesk = createWorkerDesk({
      listProjects: vi.fn().mockResolvedValue([autoDispatchProject]),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      onSessionOutput: vi.fn().mockImplementation((handler: (event: SessionOutputEvent) => void) => {
        outputHandler = handler
        return () => undefined
      }),
      startSession: vi.fn().mockResolvedValue(parentSession)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '开始工作' }))
    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(1))
    outputHandler?.({
      sessionId: 'claude-session',
      chunk,
      stream: 'stdout',
      timestamp: '2026-05-11T00:00:01.000Z'
    })

    expect(workerDesk.startSession).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch GenericAgent for incomplete GA task blocks', async () => {
    let outputHandler: ((event: SessionOutputEvent) => void) | undefined
    const autoDispatchProject: Project = {
      ...project,
      autoDispatchGenericAgent: true,
      genericAgentConfigId: 'ga-local'
    }
    const parentSession: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code'
    }
    const workerDesk = createWorkerDesk({
      listProjects: vi.fn().mockResolvedValue([autoDispatchProject]),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      onSessionOutput: vi.fn().mockImplementation((handler: (event: SessionOutputEvent) => void) => {
        outputHandler = handler
        return () => undefined
      }),
      startSession: vi.fn().mockResolvedValue(parentSession)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '开始工作' }))
    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(1))
    outputHandler?.({
      sessionId: 'claude-session',
      chunk: '[GA_TASK:generic-agent]\n请检查 package scripts',
      stream: 'stdout',
      timestamp: '2026-05-11T00:00:01.000Z'
    })

    expect(workerDesk.startSession).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch GenericAgent when the project has auto dispatch disabled', async () => {
    let outputHandler: ((event: SessionOutputEvent) => void) | undefined
    const parentSession: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code'
    }
    const workerDesk = createWorkerDesk({
      listProjects: vi.fn().mockResolvedValue([{ ...project, autoDispatchGenericAgent: false, genericAgentConfigId: 'ga-local' }]),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      onSessionOutput: vi.fn().mockImplementation((handler: (event: SessionOutputEvent) => void) => {
        outputHandler = handler
        return () => undefined
      }),
      startSession: vi.fn().mockResolvedValue(parentSession)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '开始工作' }))
    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(1))
    outputHandler?.({
      sessionId: 'claude-session',
      chunk: '[GA_TASK:generic-agent]\n请检查 package scripts\n[/GA_TASK]',
      stream: 'stdout',
      timestamp: '2026-05-11T00:00:01.000Z'
    })

    expect(workerDesk.startSession).toHaveBeenCalledTimes(1)
  })

  it('shows an error instead of dispatching when auto dispatch has no GenericAgent config', async () => {
    let outputHandler: ((event: SessionOutputEvent) => void) | undefined
    const parentSession: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code'
    }
    const workerDesk = createWorkerDesk({
      listProjects: vi.fn().mockResolvedValue([{ ...project, autoDispatchGenericAgent: true, genericAgentConfigId: undefined }]),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      onSessionOutput: vi.fn().mockImplementation((handler: (event: SessionOutputEvent) => void) => {
        outputHandler = handler
        return () => undefined
      }),
      startSession: vi.fn().mockResolvedValue(parentSession)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '开始工作' }))
    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledTimes(1))
    outputHandler?.({
      sessionId: 'claude-session',
      chunk: '● [GA_TASK:generic-agent]\n请检查 package scripts\n[/GA_TASK]',
      stream: 'stdout',
      timestamp: '2026-05-11T00:00:01.000Z'
    })

    expect(workerDesk.startSession).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('alert')).toHaveTextContent('当前 Project 未选择 GA 启动器')
  })

  it('starts GenericAgent and passes selected provider model', async () => {
    const genericProject: Project = {
      ...project,
      genericAgentConfigId: 'ga-local'
    }
    const genericSession: Session = {
      ...runningSession,
      id: 'generic-session',
      workerType: 'generic-agent',
      title: 'Project One / Provider One / Local GenericAgent'
    }
    const workerDesk = createWorkerDesk({
      listProjects: vi.fn().mockResolvedValue([genericProject]),
      listGenericAgentConfigs: vi.fn().mockResolvedValue([
        { id: 'ga-local', name: 'Local GenericAgent', home: 'E:/ga', pythonCommand: 'python', entryScript: 'agentmain.py', env: {} }
      ]),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      startSession: vi.fn().mockResolvedValue(genericSession)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.change(await screen.findByLabelText('Worker'), { target: { value: 'generic-agent' } })
    fireEvent.click(await screen.findByRole('button', { name: '开始执行' }))

    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalled())
    expect(workerDesk.startSession).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      workerType: 'generic-agent',
      genericAgentConfigId: 'ga-local',
      providerProfileId: 'provider-1',
      providerModelId: 'claude-sonnet-4-6',
      terminalSize: { cols: 100, rows: 30 }
    }))
    expect(workerDesk.startSession).toHaveBeenCalledWith(expect.not.objectContaining({
      profileId: expect.anything()
    }))
  })

  it('passes selected project slash discovery requests from the AI session pane', async () => {
    const headlessSession: Session = { ...runningSession, interactionMode: 'headless', status: 'waiting' }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([headlessSession]),
      listSlashAssistIndex: vi.fn().mockResolvedValue({
        items: [{
          id: 'project-command:/review',
          displayText: '/review',
          insertText: '/review ',
          title: '/review',
          description: 'Review current changes',
          kind: 'project-command',
          scopeLabel: '当前项目',
          groupLabel: '当前项目 Commands',
          confidence: 'file-backed',
          priority: 0
        }],
        sourceStatus: 'ready'
      })
    })
    window.workerDesk = workerDesk

    render(<App />)

    const composer = await screen.findByPlaceholderText(/输入给 AI 的消息/)
    fireEvent.change(composer, { target: { value: '/re' } })

    expect(await screen.findByText('/review')).toBeInTheDocument()
    expect(workerDesk.listSlashAssistIndex).toHaveBeenCalledWith({ projectId: 'project-1', query: 're', limit: 40, refresh: false })
  })

  it('switches the current Claude Code session to native takeover for plugin slash commands from the AI pane', async () => {
    const nativeJsonlSession: Session = { ...runningSession, interactionMode: 'native-jsonl', status: 'waiting', modelId: 'claude-sonnet-4-6' }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([nativeJsonlSession]),
      startSession: vi.fn().mockResolvedValue(runningSession),
      writeSessionInput: vi.fn().mockResolvedValue(undefined)
    })
    window.workerDesk = workerDesk

    render(<App />)

    const composer = await screen.findByPlaceholderText(/输入给原生 Claude Code/)
    fireEvent.change(composer, { target: { value: '/plugin' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await screen.findByText('这项能力需要 Claude Code 原生界面。将切换当前 Session 到原生接管，不会新建会话。')
    fireEvent.click(await screen.findByRole('button', { name: '切换当前 Session' }))

    await waitFor(() => expect(workerDesk.startSession).not.toHaveBeenCalled())
    await waitFor(() => expect(workerDesk.writeSessionInput).toHaveBeenCalledWith('session-1', '/plugin\r'))
    expect(await screen.findByText('Terminal mock')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '返回 AI 页面' }))
    expect(await screen.findByPlaceholderText(/输入给原生 Claude Code/)).toBeInTheDocument()
  })

  it('shows a direct native takeover action for Claude startup confirmation diagnostics', async () => {
    const nativeJsonlSession: Session = { ...runningSession, interactionMode: 'native-jsonl', status: 'waiting', modelId: 'claude-opus-4-6' }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([nativeJsonlSession]),
      getSessionAiEvents: vi.fn().mockResolvedValue({
        events: [{
          id: 'diag-startup-gate',
          sessionId: nativeJsonlSession.id,
          timestamp: '2026-06-08T07:17:08.000Z',
          source: 'desk',
          type: 'diagnostic',
          level: 'warning',
          stream: 'lifecycle',
          message: 'Claude Code 正在等待 bypass permissions 安全确认。请切到原生 PTY 接管后选择是否接受。'
        }],
        totalBytes: 1
      })
    })
    window.workerDesk = workerDesk

    render(<App />)

    const bannerTitle = await screen.findByText('原生确认等待接管')
    const banner = bannerTitle.closest('.ai-startup-takeover-banner')
    expect(banner).not.toBeNull()
    expect(banner).toHaveTextContent('Claude Code 正在等待 bypass permissions 安全确认。请切到原生 PTY 接管后选择是否接受。')
    fireEvent.click(screen.getByRole('button', { name: '切到原生接管' }))

    expect(await screen.findByText('Terminal mock')).toBeInTheDocument()
  })

  it('starts Claude Code and passes selected provider model', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      startSession: vi.fn().mockResolvedValue(runningSession)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '开始工作' }))

    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalled())
    expect(workerDesk.startSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      workerType: 'claude-code',
      interactionMode: 'native-jsonl',
      providerProfileId: 'provider-1',
      providerModelId: 'claude-sonnet-4-6',
      claudeLaunchSource: { type: 'provider', providerProfileId: 'provider-1', providerModelId: 'claude-sonnet-4-6' },
      terminalSize: { cols: 100, rows: 30 },
      genericAgentConfigId: undefined,
      taskTitle: undefined
    })
    expect(workerDesk.startSession).not.toHaveBeenCalledWith(expect.objectContaining({ profileId: expect.anything() }))
    expect(workerDesk.writeSessionInput).not.toHaveBeenCalled()
  })

  it('uses the first normal AI pane message as the task title when taskTitle is empty', async () => {
    const nativeJsonlSession: Session = { ...runningSession, interactionMode: 'native-jsonl', status: 'waiting', taskTitle: undefined }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([nativeJsonlSession]),
      writeSessionInput: vi.fn().mockResolvedValue(undefined)
    })
    window.workerDesk = workerDesk

    render(<App />)

    const composer = await screen.findByPlaceholderText(/输入给原生 Claude Code/)
    fireEvent.change(composer, { target: { value: '修复右栏任务名显示' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(workerDesk.writeSessionInput).toHaveBeenCalledWith('session-1', '修复右栏任务名显示\r'))
    expect(await screen.findByRole('button', { name: '当前会话：修复右栏任务名显示' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '当前会话：Project One / Provider One' })).not.toBeInTheDocument()
  })

  it('does not let normal AI pane messages override an existing taskTitle', async () => {
    const nativeJsonlSession: Session = { ...runningSession, interactionMode: 'native-jsonl', status: 'waiting', taskTitle: '手填任务名' }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([nativeJsonlSession]),
      writeSessionInput: vi.fn().mockResolvedValue(undefined)
    })
    window.workerDesk = workerDesk

    render(<App />)

    const composer = await screen.findByPlaceholderText(/输入给原生 Claude Code/)
    fireEvent.change(composer, { target: { value: '新的输入不能覆盖' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(workerDesk.writeSessionInput).toHaveBeenCalledWith('session-1', '新的输入不能覆盖\r'))
    expect(screen.getByRole('button', { name: '当前会话：手填任务名' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '当前会话：新的输入不能覆盖' })).not.toBeInTheDocument()
  })

  it('does not use native management slash commands as task titles from the AI pane', async () => {
    const nativeJsonlSession: Session = { ...runningSession, interactionMode: 'native-jsonl', status: 'waiting', taskTitle: undefined }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([nativeJsonlSession]),
      writeSessionInput: vi.fn().mockResolvedValue(undefined)
    })
    window.workerDesk = workerDesk

    render(<App />)

    const composer = await screen.findByPlaceholderText(/输入给原生 Claude Code/)
    fireEvent.change(composer, { target: { value: '/plugin' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await screen.findByText('这项能力需要 Claude Code 原生界面。将切换当前 Session 到原生接管，不会新建会话。')
    expect(screen.getByRole('button', { name: '当前会话：Project One / Provider One' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '当前会话：/plugin' })).not.toBeInTheDocument()
  })

  it('uses the first terminal input anchor as the card title when taskTitle is empty', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([{ ...runningSession, interactionMode: 'pty' as const }])
    })
    window.workerDesk = workerDesk

    render(<App />)

    await screen.findByText('Project One / Provider One')
    fireEvent.click(screen.getByRole('button', { name: '模拟首个输入圆点' }))

    expect(await screen.findByRole('button', { name: '当前会话：写一篇 800 字作文' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '当前会话：Project One / Provider One' })).not.toBeInTheDocument()
  })

  it('does not let terminal input anchors override an existing taskTitle', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([{ ...runningSession, interactionMode: 'pty' as const, taskTitle: '手填任务名' }])
    })
    window.workerDesk = workerDesk

    render(<App />)

    await screen.findByRole('button', { name: '当前会话：手填任务名' })
    fireEvent.click(screen.getByRole('button', { name: '模拟首个输入圆点' }))

    expect(screen.getByRole('button', { name: '当前会话：手填任务名' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '当前会话：写一篇 800 字作文' })).not.toBeInTheDocument()
  })

  it('passes taskTitle when starting Claude Code from the project panel', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      startSession: vi.fn().mockResolvedValue({ ...runningSession, taskTitle: '修复中栏状态' })
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.change(await screen.findByLabelText('任务名'), { target: { value: '修复中栏状态' } })
    fireEvent.click(await screen.findByRole('button', { name: '开始工作' }))

    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalled())
    expect(workerDesk.startSession).toHaveBeenCalledWith(expect.objectContaining({
      taskTitle: '修复中栏状态'
    }))
  })

  it('runs lightweight SessionRadar actions without selecting the card by accident', async () => {
    const similarSession: Session = { ...runningSession, id: 'session-2', title: 'Project One / Provider One' }
    const sourceSession: Session = { ...runningSession, modelId: 'claude-opus-4-7', modelDisplayName: 'Claude Opus 4.7' }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([sourceSession]),
      stopSession: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(similarSession),
      getOutput: vi.fn().mockResolvedValue({ chunks: [], nextOffset: undefined, totalBytes: 0 }),
      getSummary: vi.fn().mockResolvedValue('Existing summary')
    })
    window.workerDesk = workerDesk

    render(<App />)

    await screen.findByText('Project One / Provider One')
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => expect(workerDesk.stopSession).toHaveBeenCalledWith('session-1'))

    fireEvent.click(screen.getByRole('button', { name: '再开同类' }))
    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      workerType: 'claude-code',
      providerProfileId: 'provider-1',
      providerModelId: 'claude-opus-4-7',
      terminalSize: { cols: 100, rows: 30 }
    })))

    const summaryButtons = screen.getAllByRole('button', { name: '摘要' })
    fireEvent.click(summaryButtons[0])
    await waitFor(() => expect(workerDesk.getSummary).toHaveBeenCalledWith('session-2'))
    expect(await screen.findByText('Existing summary')).toBeInTheDocument()
  })

  it('keeps a handled hook-derived review item in done until a new working hook arrives', async () => {
    let attentionHandler: ((event: SessionAttentionEvent) => void) | undefined
    let sessionChangedHandler: ((session: Session) => void) | undefined
    const reviewSession: Session = {
      ...runningSession,
      id: 'review-session',
      title: 'Review me'
    }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([reviewSession]),
      onSessionChanged: vi.fn().mockImplementation((handler: (session: Session) => void) => {
        sessionChangedHandler = handler
        return () => undefined
      }),
      onSessionAttentionChanged: vi.fn().mockImplementation((handler: (event: SessionAttentionEvent) => void) => {
        attentionHandler = handler
        return () => undefined
      })
    })
    window.workerDesk = workerDesk

    render(<App />)

    const radar = await waitFor(() => {
      const node = screen.getByRole('heading', { name: '调度中心' }).closest('.session-radar')
      expect(node).not.toBeNull()
      expect(within(node as HTMLElement).getByText('Review me')).toBeInTheDocument()
      return node as HTMLElement
    })

    attentionHandler?.({
      sessionId: 'review-session',
      state: 'needsReview',
      source: 'claude-code-hook',
      hookName: 'Stop',
      occurredAt: '2026-05-26T00:00:00.000Z'
    })

    await waitFor(() => expect(within(radar).getByText('先处理 1 个待处理')).toBeInTheDocument())
    expect(within(radar).queryByText('先处理 1 个待处理的现场')).not.toBeInTheDocument()
    expect(within(radar).getByRole('button', { name: '待处理 1' })).toHaveTextContent('待1')
    fireEvent.click(within(radar).getByRole('button', { name: '待处理 1' }))

    const reviewCard = within(radar).getByText('Review me').closest('.session-card')
    expect(reviewCard).not.toBeNull()
    fireEvent.click(within(reviewCard as HTMLElement).getByRole('button', { name: /Review me/ }))

    await waitFor(() => expect(within(radar).queryByText('当前可放手观察')).not.toBeInTheDocument())
    sessionChangedHandler?.({
      ...reviewSession,
      lastActivityAt: '2026-05-26T00:00:01.000Z'
    })

    await waitFor(() => expect(within(radar).queryByText('当前可放手观察')).not.toBeInTheDocument())
    fireEvent.click(within(radar).getByRole('button', { name: '已完成 1' }))
    expect(within(radar).getByText('Review me')).toBeInTheDocument()

    attentionHandler?.({
      sessionId: 'review-session',
      state: 'working',
      source: 'claude-code-hook',
      hookName: 'UserPromptSubmit',
      occurredAt: '2026-05-26T00:00:02.000Z'
    })

    await waitFor(() => {
      expect(within(radar).queryByLabelText('现场计数')).not.toBeInTheDocument()
      expect(within(radar).getByRole('button', { name: '进行中 1' })).toHaveTextContent('进1')
    })
  })

  it('lets users view and dismiss failed or exited sessions from the radar without deleting history', async () => {
    const failedSession: Session = {
      ...runningSession,
      id: 'failed-session',
      status: 'failed',
      title: 'Failed startup',
      errorMessage: '401 Unauthorized: invalid API key'
    }
    const exitedSession: Session = {
      ...runningSession,
      id: 'exited-session',
      status: 'exited',
      title: 'Finished run',
      exitedAt: '2026-05-11T00:00:02.000Z',
      exitCode: 0
    }
    const failedDeskItem = {
      ...deskHistory,
      id: 'failed-session',
      title: 'Failed startup',
      status: 'failed' as const,
      outputSizeBytes: 1
    }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([failedSession, exitedSession]),
      listHistory: vi.fn().mockResolvedValue([failedDeskItem]),
      listProjectHistory: vi.fn().mockResolvedValue({ desk: [failedDeskItem], cli: [cliHistory] })
    })
    window.workerDesk = workerDesk

    render(<App />)

    const radar = await waitFor(() => {
      const node = screen.getByRole('heading', { name: '调度中心' }).closest('.session-radar')
      expect(node).not.toBeNull()
      expect(within(node as HTMLElement).getByText('Failed startup')).toBeInTheDocument()
      return node as HTMLElement
    })
    fireEvent.click(screen.getByRole('button', { name: '查看原因' }))
    expect(screen.getByText('Terminal mock')).toBeInTheDocument()
    fireEvent.click(within(radar).getByRole('button', { name: '已完成 2' }))
    expect(within(radar).getByText('Failed startup')).toBeInTheDocument()
    fireEvent.click(within(radar).getByRole('button', { name: '全部 2' }))

    const failedCard = within(radar).getByText('Failed startup').closest('.session-card')
    expect(failedCard).not.toBeNull()
    fireEvent.click(within(failedCard as HTMLElement).getByRole('button', { name: '收起' }))
    expect(within(radar).queryByText('Failed startup')).not.toBeInTheDocument()
    fireEvent.click(within(radar).getByRole('button', { name: '查看已收起 1 个' }))
    expect(within(radar).getByText('已收起 Session')).toBeInTheDocument()
    fireEvent.click(within(radar).getByRole('button', { name: '查看 Failed startup' }))
    expect(screen.getByText('Terminal mock')).toBeInTheDocument()
    fireEvent.click(within(radar).getByRole('button', { name: '恢复 Failed startup 到现场' }))
    expect(within(radar).getByText('Failed startup')).toBeInTheDocument()
    expect(within(radar).getByText('Finished run')).toBeInTheDocument()

    const exitedCard = within(radar).getByText('Finished run').closest('.session-card')
    expect(exitedCard).not.toBeNull()
    fireEvent.click(within(exitedCard as HTMLElement).getByRole('button', { name: /Finished run/ }))
    fireEvent.click(within(radar).getByRole('button', { name: '已完成 2' }))
    expect(within(radar).getByText('Finished run')).toBeInTheDocument()
    fireEvent.click(within(radar).getByRole('button', { name: '全部 2' }))

    const visibleExitedCard = within(radar).getByText('Finished run').closest('.session-card')
    expect(visibleExitedCard).not.toBeNull()
    fireEvent.click(within(visibleExitedCard as HTMLElement).getByRole('button', { name: '收起' }))
    const visibleSessionList = radar.querySelector('.session-list')
    expect(visibleSessionList).not.toBeNull()
    expect(within(visibleSessionList as HTMLElement).queryByText('Finished run')).not.toBeInTheDocument()
    expect(within(radar).getByRole('button', { name: '查看已收起 1 个' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '历史' }))
    const historyView = document.querySelector('.history-view')
    expect(historyView).not.toBeNull()
    const lowSignalToggle = within(historyView as HTMLElement).getByRole('button', { name: '展开 1 条低信号记录' })
    expect(within(historyView as HTMLElement).queryByText('Failed startup')).not.toBeInTheDocument()
    fireEvent.click(lowSignalToggle)
    expect(within(historyView as HTMLElement).getByText('Failed startup')).toBeInTheDocument()
  })

  it('adds a newly stopped current-project session into the right-rail history without waiting for a manual reload', async () => {
    const sessionChangedHandlers: Array<(session: Session) => void> = []
    const runningCurrentSession: Session = {
      ...runningSession,
      interactionMode: 'native-jsonl',
      title: 'Live task',
      taskTitle: 'Live task',
      status: 'running'
    }
    const stoppedCurrentSession: Session = {
      ...runningCurrentSession,
      status: 'stopped',
      exitedAt: '2026-05-11T00:00:05.000Z',
      exitCode: 1,
      lastActivityAt: '2026-05-11T00:00:05.000Z'
    }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([runningCurrentSession]),
      listProjectHistory: vi.fn().mockResolvedValue({ desk: [deskHistory], cli: [cliHistory] }),
      onSessionChanged: vi.fn().mockImplementation((handler: (session: Session) => void) => {
        sessionChangedHandlers.push(handler)
        return () => undefined
      })
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '历史' }))
    expect(await screen.findByText('CLI history')).toBeInTheDocument()
    const historyView = document.querySelector('.history-view')
    expect(historyView).not.toBeNull()
    expect(within(historyView as HTMLElement).queryByText('Live task')).not.toBeInTheDocument()

    await act(async () => {
      sessionChangedHandlers.forEach((handler) => handler(stoppedCurrentSession))
    })

    expect(await within(historyView as HTMLElement).findByText('Live task')).toBeInTheDocument()
    expect(within(historyView as HTMLElement).getByText('已停止')).toBeInTheDocument()
  })

  it('sends a short GenericAgent dispatch instruction after Claude Code output becomes quiet for an auto-dispatch project', async () => {
    setClaudeCodeGenericAgentInstructionDelayForTesting(0)
    const outputHandlers: Array<(event: SessionOutputEvent) => void> = []
    const autoDispatchProject: Project = {
      ...project,
      autoDispatchGenericAgent: true,
      genericAgentConfigId: 'ga-local'
    }
    const workerDesk = createWorkerDesk({
      listProjects: vi.fn().mockResolvedValue([autoDispatchProject]),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      startSession: vi.fn().mockResolvedValue(runningSession),
      onSessionOutput: vi.fn().mockImplementation((handler: (event: SessionOutputEvent) => void) => {
        outputHandlers.push(handler)
        return () => undefined
      }),
      writeSessionInput: vi.fn().mockResolvedValue(undefined)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '开始工作' }))
    await waitFor(() => expect(workerDesk.startSession).toHaveBeenCalled())
    expect(workerDesk.writeSessionInput).not.toHaveBeenCalled()
    await waitFor(() => expect(outputHandlers.length).toBeGreaterThanOrEqual(3))

    outputHandlers.forEach((handler) => handler({
      sessionId: 'session-1',
      chunk: 'Claude Code ready\n',
      stream: 'stdout',
      timestamp: '2026-05-11T00:00:01.000Z'
    }))

    await waitFor(() => expect(workerDesk.writeSessionInput).toHaveBeenCalledTimes(2))
    expect(workerDesk.writeSessionInput).toHaveBeenNthCalledWith(
      1,
      'session-1',
      expect.stringContaining('[GA_TASK:generic-agent]')
    )
    expect(workerDesk.writeSessionInput).toHaveBeenNthCalledWith(2, 'session-1', '\r')
    const instruction = (workerDesk.writeSessionInput as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(instruction).toContain('GenericAgent')
    expect(instruction).not.toContain('\n[GA_TASK:generic-agent]\n')
  })

  it('does not send the GenericAgent dispatch instruction when Claude Code shows an unsafe startup prompt', async () => {
    setClaudeCodeGenericAgentInstructionDelayForTesting(0)
    const outputHandlers: Array<(event: SessionOutputEvent) => void> = []
    const autoDispatchProject: Project = {
      ...project,
      autoDispatchGenericAgent: true,
      genericAgentConfigId: 'ga-local'
    }
    const workerDesk = createWorkerDesk({
      listProjects: vi.fn().mockResolvedValue([autoDispatchProject]),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      startSession: vi.fn().mockResolvedValue(runningSession),
      onSessionOutput: vi.fn().mockImplementation((handler: (event: SessionOutputEvent) => void) => {
        outputHandlers.push(handler)
        return () => undefined
      }),
      writeSessionInput: vi.fn().mockResolvedValue(undefined)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '开始工作' }))
    await waitFor(() => expect(outputHandlers.length).toBeGreaterThanOrEqual(3))

    outputHandlers.forEach((handler) => handler({
      sessionId: 'session-1',
      chunk: 'Configuration Error\nChoose an option:\nEnter to confirm\n',
      stream: 'stdout',
      timestamp: '2026-05-11T00:00:01.000Z'
    }))

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(workerDesk.writeSessionInput).not.toHaveBeenCalled()
  })

  it('returns GenericAgent output to its parent Claude Code session after user confirmation', async () => {
    const parentSession: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code',
      status: 'running'
    }
    const genericSession: Session = {
      ...runningSession,
      id: 'generic-session',
      workerType: 'generic-agent',
      parentSessionId: 'claude-session',
      dispatchMode: 'auto',
      status: 'exited'
    }
    const rawOutput = [
      '[31m✻ Working...[0m',
      '⠋ thinking...',
      '● analyzing',
      '',
      '中间过程的随机输出，应该被忽略',
      '[GA_RESULT]',
      'GA result 最终答案',
      '[/GA_RESULT]',
      '✻ Worked for 9s'
    ].join('\n')
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([genericSession, parentSession]),
      getOutputBuffer: vi.fn().mockResolvedValue(rawOutput),
      writeSessionInput: vi.fn().mockResolvedValue(undefined)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '返回给 Claude Code' }))

    await waitFor(() => expect(workerDesk.getOutputBuffer).toHaveBeenCalledWith('generic-session'))
    expect(workerDesk.writeSessionInput).toHaveBeenCalledTimes(2)
    expect(workerDesk.writeSessionInput).toHaveBeenCalledWith(
      'claude-session',
      expect.stringContaining('GA result 最终答案')
    )
    expect(workerDesk.writeSessionInput).toHaveBeenNthCalledWith(2, 'claude-session', '\r')
    const writtenText = (workerDesk.writeSessionInput as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(writtenText).not.toContain('[/GA_RESULT]')
    expect(writtenText).not.toContain('Working')
    expect(writtenText).not.toContain('Worked for')
    expect(writtenText).not.toContain('⠋')
    expect(writtenText).not.toContain('●')
    expect(writtenText).not.toContain('[GA_RESULT]')
    expect(writtenText).not.toContain('中间过程的随机输出')
    expect(writtenText).toContain('GenericAgent')
  })

  it('falls back to the last clean paragraph when GA_RESULT is missing', async () => {
    const parentSession: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code',
      status: 'running'
    }
    const genericSession: Session = {
      ...runningSession,
      id: 'generic-session',
      workerType: 'generic-agent',
      parentSessionId: 'claude-session',
      dispatchMode: 'auto',
      status: 'exited'
    }
    const rawOutput = [
      '⠋ Working...',
      '● analyzing',
      '',
      '中间分析过程',
      '',
      '最终答案兜底文本'
    ].join('\n')
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([genericSession, parentSession]),
      getOutputBuffer: vi.fn().mockResolvedValue(rawOutput),
      writeSessionInput: vi.fn().mockResolvedValue(undefined)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '返回给 Claude Code' }))

    await waitFor(() => expect(workerDesk.writeSessionInput).toHaveBeenCalledTimes(2))
    const writtenText = (workerDesk.writeSessionInput as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(writtenText).toContain('最终答案兜底文本')
    expect(writtenText).not.toContain('Working')
    expect(writtenText).not.toContain('●')
    expect(writtenText).not.toContain('⠋')
  })

  it('shows an error and does not write parent input when GA output is empty noise', async () => {
    const parentSession: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code',
      status: 'running'
    }
    const genericSession: Session = {
      ...runningSession,
      id: 'generic-session',
      workerType: 'generic-agent',
      parentSessionId: 'claude-session',
      dispatchMode: 'auto',
      status: 'exited'
    }
    const rawOutput = ['⠋ Working...', '✻ Worked for 1s', '● analyzing'].join('\n')
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([genericSession, parentSession]),
      getOutputBuffer: vi.fn().mockResolvedValue(rawOutput),
      writeSessionInput: vi.fn().mockResolvedValue(undefined)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '返回给 Claude Code' }))

    await waitFor(() => expect(workerDesk.getOutputBuffer).toHaveBeenCalledWith('generic-session'))
    expect(workerDesk.writeSessionInput).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent('GenericAgent 没有可返回的输出')
  })

  it('automatically writes GA final answer to parent Claude Code after the GA child turn ends', async () => {
    setAutoReturnDelayMsForTesting(0)
    const outputHandlers: Array<(event: SessionOutputEvent) => void> = []
    const parentSession: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code',
      status: 'running'
    }
    const runningGenericSession: Session = {
      ...runningSession,
      id: 'generic-session',
      workerType: 'generic-agent',
      parentSessionId: 'claude-session',
      dispatchMode: 'auto',
      status: 'running'
    }
    const rawOutput = [
      '[Info] Load mykeys from GENERIC_AGENT_PROVIDER_CONFIG_JSON',
      '> 你好',
      '[Output] tokens=11 stop_reason=end_turn',
      '你好！有什么我可以帮你的吗？'
    ].join('\n')
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([parentSession, runningGenericSession]),
      onSessionOutput: vi.fn().mockImplementation((handler: (event: SessionOutputEvent) => void) => {
        outputHandlers.push(handler)
        return () => undefined
      }),
      getOutputBuffer: vi.fn().mockResolvedValue(rawOutput),
      writeSessionInput: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn().mockResolvedValue(undefined)
    })
    window.workerDesk = workerDesk

    render(<App />)
    await waitFor(() => expect(outputHandlers.length).toBeGreaterThanOrEqual(2))

    outputHandlers.forEach((handler) => handler({
      sessionId: 'generic-session',
      chunk: '[Output] tokens=11 stop_reason=end_turn\n',
      stream: 'stdout',
      timestamp: '2026-05-11T00:00:10.000Z'
    }))

    await waitFor(() => expect(workerDesk.writeSessionInput).toHaveBeenCalledTimes(2))
    expect(workerDesk.writeSessionInput).toHaveBeenNthCalledWith(
      1,
      'claude-session',
      expect.stringContaining('你好！有什么我可以帮你的吗？')
    )
    expect(workerDesk.writeSessionInput).toHaveBeenNthCalledWith(2, 'claude-session', '\r')
    expect(workerDesk.stopSession).toHaveBeenCalledWith('generic-session')
    const writtenText = (workerDesk.writeSessionInput as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(writtenText).not.toContain('[Output]')
    expect(writtenText).not.toContain('tokens=')
    expect(writtenText).not.toContain('stop_reason=')
    expect(writtenText).not.toContain('[Info]')
    expect(writtenText).not.toContain('> 你好')
  })

  it('does not auto-write to a parent Claude Code session that has already exited', async () => {
    setAutoReturnDelayMsForTesting(0)
    const sessionChangedHandlers: Array<(session: Session) => void> = []
    const exitedParent: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code',
      status: 'exited',
      exitedAt: '2026-05-11T00:00:01.000Z',
      exitCode: 0
    }
    const exitedGenericSession: Session = {
      ...runningSession,
      id: 'generic-session',
      workerType: 'generic-agent',
      parentSessionId: 'claude-session',
      dispatchMode: 'auto',
      status: 'exited',
      exitedAt: '2026-05-11T00:00:10.000Z',
      exitCode: 0
    }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([exitedParent]),
      onSessionChanged: vi.fn().mockImplementation((handler: (session: Session) => void) => {
        sessionChangedHandlers.push(handler)
        return () => undefined
      }),
      getOutputBuffer: vi.fn().mockResolvedValue('[GA_RESULT]\nignored\n[/GA_RESULT]'),
      writeSessionInput: vi.fn().mockResolvedValue(undefined)
    })
    window.workerDesk = workerDesk

    render(<App />)
    await waitFor(() => expect(sessionChangedHandlers.length).toBeGreaterThanOrEqual(2))

    sessionChangedHandlers.forEach((handler) => handler(exitedGenericSession))

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(workerDesk.writeSessionInput).not.toHaveBeenCalled()
  })

  it('does not auto-write again when the user already returned the same GA child manually', async () => {
    setAutoReturnDelayMsForTesting(0)
    const sessionChangedHandlers: Array<(session: Session) => void> = []
    const parentSession: Session = {
      ...runningSession,
      id: 'claude-session',
      workerType: 'claude-code',
      status: 'running'
    }
    const exitedGenericSession: Session = {
      ...runningSession,
      id: 'generic-session',
      workerType: 'generic-agent',
      parentSessionId: 'claude-session',
      dispatchMode: 'auto',
      status: 'exited',
      exitedAt: '2026-05-11T00:00:10.000Z',
      exitCode: 0
    }
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      listSessions: vi.fn().mockResolvedValue([exitedGenericSession, parentSession]),
      onSessionChanged: vi.fn().mockImplementation((handler: (session: Session) => void) => {
        sessionChangedHandlers.push(handler)
        return () => undefined
      }),
      getOutputBuffer: vi.fn().mockResolvedValue('[GA_RESULT]\n手动返回\n[/GA_RESULT]'),
      writeSessionInput: vi.fn().mockResolvedValue(undefined)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '返回给 Claude Code' }))
    await waitFor(() => expect(workerDesk.writeSessionInput).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(sessionChangedHandlers.length).toBeGreaterThanOrEqual(2))

    sessionChangedHandlers.forEach((handler) => handler(exitedGenericSession))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(workerDesk.writeSessionInput).toHaveBeenCalledTimes(2)
  })

  it('passes the selected provider model to CLI summary generation', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      getCliSessionOutput: vi.fn().mockResolvedValue('CLI output'),
      getSummary: vi.fn().mockResolvedValue(undefined),
      generateSummary: vi.fn().mockResolvedValue('CLI generated summary')
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '历史' }))
    fireEvent.click(await screen.findByRole('button', { name: /CLI history/ }))
    fireEvent.click(await screen.findByRole('button', { name: '生成 Summary' }))

    await waitFor(() => expect(workerDesk.generateSummary).toHaveBeenCalledWith(
      { kind: 'cli-session', cliSessionId: 'cli-1', projectId: 'project-1' },
      'provider-1',
      'claude-sonnet-4-6'
    ))
  })

  it('shows an error when continuing from summary without a selected provider profile', async () => {
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue({ version: 1, providers: [] }),
      getOutput: vi.fn().mockResolvedValue({ chunks: [], totalBytes: 0 }),
      getSummary: vi.fn().mockResolvedValue('Desk summary')
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '历史' }))
    fireEvent.click(await screen.findByRole('button', { name: /Desk history/ }))

    expect(await screen.findByText('需要先选择模型连接才能继续任务')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '基于 Summary 继续任务' })).toBeDisabled()
  })

  it('disables the start session button while a session is starting', async () => {
    const deferred = createDeferred<Session>()
    const workerDesk = createWorkerDesk({
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders),
      startSession: vi.fn().mockReturnValue(deferred.promise)
    })
    window.workerDesk = workerDesk

    render(<App />)

    const startButton = await screen.findByRole('button', { name: '开始工作' })
    fireEvent.click(startButton)

    expect(startButton).toBeDisabled()
    fireEvent.click(startButton)
    expect(workerDesk.startSession).toHaveBeenCalledTimes(1)

    deferred.resolve(runningSession)
    await waitFor(() => expect(startButton).toBeEnabled())
  })
})

describe('App history search', () => {
  it('reloads project history when clearing search', async () => {
    const workerDesk = createWorkerDesk({
      search: vi.fn().mockResolvedValue([{ sessionId: 'desk-1', title: 'Desk history', status: 'exited', matchedAt: '2026-05-11T00:00:00.000Z', excerpt: 'Desk' }]),
      searchCliHistory: vi.fn().mockResolvedValue([]),
      listProjectHistory: vi.fn().mockResolvedValue({ desk: [deskHistory], cli: [cliHistory] }),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '历史' }))
    expect(await screen.findByText('CLI history')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('搜索历史输出'), { target: { value: 'desk' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => expect(screen.queryByText('CLI history')).not.toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('搜索历史输出'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    expect(await screen.findByText('CLI history')).toBeInTheDocument()
    // Cleared search reloads the full project history via the bundled IPC.
    expect(workerDesk.listProjectHistory).toHaveBeenCalledWith('project-1')
  })

  it('absorbs a legacy desk session into its cli card by exit-time proximity', async () => {
    // A legacy CC desk session that exited very close to the cli updatedAt should
    // be absorbed into the cli card (in-memory backfill), so the user sees one
    // card per conversation. The desk card title should NOT show as a separate row.
    const legacyDeskClose: DeskHistoryItem = {
      ...deskHistory,
      id: 'desk-legacy',
      title: 'Legacy desk title (should be hidden)',
      // 1 second before cliHistory.updatedAt (2026-05-11T00:00:03.000Z)
      createdAt: '2026-05-11T00:00:00.000Z',
      lastActivityAt: '2026-05-11T00:00:01.000Z',
      exitedAt: '2026-05-11T00:00:02.000Z'
    }
    const workerDesk = createWorkerDesk({
      listHistory: vi.fn().mockResolvedValue([legacyDeskClose]),
      listCliHistory: vi.fn().mockResolvedValue([cliHistory]),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '历史' }))
    expect(await screen.findByText('CLI history')).toBeInTheDocument()
    // Legacy desk card is absorbed; its title should not appear as a separate card.
    expect(screen.queryByText('Legacy desk title (should be hidden)')).not.toBeInTheDocument()
  })

  it('hides small CLI history cards behind a low-signal toggle by default', async () => {
    // Tiny jsonl (<10KB) with no Summary → routed to the low-signal bucket so it
    // doesn't clutter the primary list. Primary CLI fixture stays visible.
    const tinyCli: CliHistorySession = {
      ...cliHistory,
      id: 'cli-tiny',
      firstMessage: 'hi (smoke test)',
      fileSizeBytes: 256,
      updatedAt: '2025-01-01T00:00:00.000Z'
    }
    const workerDesk = createWorkerDesk({
      listProjectHistory: vi.fn().mockResolvedValue({ desk: [], cli: [cliHistory, tinyCli] }),
      listProviderCatalog: vi.fn().mockResolvedValue(providerCatalogWithProviders)
    })
    window.workerDesk = workerDesk

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '历史' }))
    // Primary card visible
    expect(await screen.findByText('CLI history')).toBeInTheDocument()
    // Low-signal card not visible by default
    expect(screen.queryByText('hi (smoke test)')).not.toBeInTheDocument()
    // Toggle is present
    const toggle = screen.getByRole('button', { name: /低信号记录/ })
    fireEvent.click(toggle)
    // Now visible
    expect(await screen.findByText('hi (smoke test)')).toBeInTheDocument()
  })
})
