import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppAction, AppState } from '../state/appStore'
import type { Session } from '../types/workerDesk'
import { useSessionHandlers } from './useSessionHandlers'

function createState(patch: Partial<AppState> = {}): AppState {
  return {
    projects: [{ id: 'p1', name: 'demo', path: '.', createdAt: '', lastUsedAt: '', autoDispatchGenericAgent: false }],
    genericAgentConfigs: [],
    sessions: [],
    sessionAiEventsBySessionId: {},
    sessionAiEventsNextOffset: {},
    sessionAiEventsTotalBytes: {},
    isSendingMessageBySessionId: {},
    selectedProjectId: 'p1',
    selectedWorkerType: 'claude-code',
    selectedClaudeLaunchMode: 'provider',
    selectedProviderProfileId: 'provider-1',
    selectedProviderModelId: 'model-1',
    sessionViewModeBySessionId: {},
    handledAttentionSessionIds: [],
    userAttentionBySessionId: {},
    rightTab: 'terminal',
    history: [],
    cliHistory: [],
    historyOutputBySessionId: {},
    summaryBySessionId: {},
    historyOutputNextOffset: {},
    historyOutputTotalBytes: {},
    historyQuery: '',
    isSummaryLoading: false,
    isHistoryOutputLoading: false,
    isSessionStarting: false,
    ...patch
  }
}

function createSession(patch: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    projectId: 'p1',
    workerType: 'claude-code',
    interactionMode: 'native-jsonl',
    status: 'waiting',
    title: 'demo',
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    outputRef: 'jsonl:session-1',
    providerProfileId: 'provider-1',
    modelId: 'model-1',
    ...patch
  }
}

describe('useSessionHandlers current Claude config launch', () => {
  const dispatch = vi.fn<(action: AppAction) => void>()
  const terminalSizeRef = { current: { cols: 100, rows: 30 } }

  beforeEach(() => {
    dispatch.mockReset()
    window.workerDesk = {
      getCurrentClaudeConfig: vi.fn(async () => ({
        source: 'current-claude-config',
        baseUrl: 'http://127.0.0.1:53159',
        model: 'gpt-5.4',
        apiKeySource: 'ANTHROPIC_AUTH_TOKEN'
      })),
      startSession: vi.fn(async (input) => createSession({
        id: 'session-1',
        projectId: input.projectId,
        workerType: input.workerType,
        interactionMode: input.interactionMode ?? 'native-jsonl',
        status: 'starting'
      })),
      sendSessionMessage: vi.fn(async () => undefined),
      writeSessionInput: vi.fn(async () => undefined),
      resizeSession: vi.fn(async () => undefined),
      removeProject: vi.fn(async () => ({
        id: 'p2',
        name: 'next project',
        path: '.',
        createdAt: '',
        lastUsedAt: '',
        autoDispatchGenericAgent: false
      }))
    } as never
  })

  it('starts Claude Code with current config launch source after apply button clicked', async () => {
    const state = createState()

    const handlers = useSessionHandlers(state, dispatch, terminalSizeRef)
    await handlers.handleApplyCurrentClaudeConfig()

    const currentModeState = createState({
      currentClaudeConfig: {
        source: 'current-claude-config' as const,
        baseUrl: 'http://127.0.0.1:53159',
        model: 'gpt-5.4',
        apiKeySource: 'ANTHROPIC_AUTH_TOKEN' as const
      },
      selectedClaudeLaunchMode: 'current-claude-config'
    })

    const currentModeHandlers = useSessionHandlers(currentModeState, dispatch, terminalSizeRef)
    await currentModeHandlers.handleStartSession('p1', 'claude-code')

    expect(window.workerDesk.startSession).toHaveBeenCalledWith(expect.objectContaining({
      claudeLaunchSource: { type: 'current-claude-config' },
      providerProfileId: undefined,
      providerModelId: undefined,
      interactionMode: 'native-jsonl'
    }))
  })

  it('routes native-jsonl composer submissions through PTY input with Enter', async () => {
    const session = createSession({ id: 'native-session', interactionMode: 'native-jsonl' })
    const handlers = useSessionHandlers(createState({ sessions: [session] }), dispatch, terminalSizeRef)

    await handlers.handleSendSessionMessage('native-session', '继续处理')

    expect(window.workerDesk.writeSessionInput).toHaveBeenCalledWith('native-session', '继续处理\r')
    expect(window.workerDesk.sendSessionMessage).not.toHaveBeenCalled()
  })

  it('keeps headless composer submissions on sendSessionMessage', async () => {
    const session = createSession({ id: 'headless-session', interactionMode: 'headless' })
    const handlers = useSessionHandlers(createState({ sessions: [session] }), dispatch, terminalSizeRef)

    await handlers.handleSendSessionMessage('headless-session', '继续处理')

    expect(window.workerDesk.sendSessionMessage).toHaveBeenCalledWith('headless-session', '继续处理')
    expect(window.workerDesk.writeSessionInput).not.toHaveBeenCalled()
  })

  it('continues from summary by creating native-jsonl session with initial prompt', async () => {
    const handlers = useSessionHandlers(createState({
      summaryBySessionId: { 'history-1': '上次 Summary' },
      history: [{ ...createSession({ id: 'history-1', status: 'exited' }), source: 'desk' }]
    }), dispatch, terminalSizeRef)

    await handlers.handleContinueFromSummary('history-1')

    expect(window.workerDesk.startSession).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1',
      workerType: 'claude-code',
      interactionMode: 'native-jsonl',
      initialPrompt: expect.stringContaining('上次 Summary')
    }))
    expect(window.workerDesk.sendSessionMessage).not.toHaveBeenCalled()
  })

  it('switches the current session to native takeover without creating a child session', async () => {
    const session = createSession({ id: 'native-session', interactionMode: 'native-jsonl', status: 'waiting' })
    const handlers = useSessionHandlers(createState({ sessions: [session] }), dispatch, terminalSizeRef)

    const result = await handlers.handleSwitchToNativeTakeover(session, '/plugin')

    expect(result).toBe(true)
    expect(window.workerDesk.startSession).not.toHaveBeenCalled()
    expect(window.workerDesk.writeSessionInput).toHaveBeenCalledWith('native-session', '/plugin\r')
    expect(dispatch).toHaveBeenCalledWith({ type: 'setSessionViewMode', sessionId: 'native-session', viewMode: 'native-pty' })
    expect(dispatch).toHaveBeenCalledWith({ type: 'selectSession', sessionId: 'native-session' })
  })

  it('routes terminal input and resize for native-jsonl sessions by current session capability', async () => {
    const session = createSession({ id: 'native-session', interactionMode: 'native-jsonl', status: 'waiting' })
    const handlers = useSessionHandlers(createState({ sessions: [session] }), dispatch, terminalSizeRef)

    await handlers.handleInput('native-session', 'x')
    await handlers.handleResizeSession('native-session', 120, 40)

    expect(window.workerDesk.writeSessionInput).toHaveBeenCalledWith('native-session', 'x')
    expect(window.workerDesk.resizeSession).toHaveBeenCalledWith('native-session', 120, 40)
  })
  it('removes a project through the desk API and dispatches the next selected project', async () => {
    const state = createState({
      projects: [
        { id: 'p1', name: 'current', path: '.', createdAt: '', lastUsedAt: '', autoDispatchGenericAgent: false },
        { id: 'p2', name: 'next project', path: '.', createdAt: '', lastUsedAt: '', autoDispatchGenericAgent: false }
      ],
      selectedProjectId: 'p1'
    })
    const handlers = useSessionHandlers(state, dispatch, terminalSizeRef)

    await handlers.handleRemoveProject('p1')

    expect(window.workerDesk.removeProject).toHaveBeenCalledWith('p1')
    expect(dispatch).toHaveBeenCalledWith({ type: 'projectRemoved', projectId: 'p1', nextProjectId: 'p2' })
    expect(dispatch).toHaveBeenCalledWith({ type: 'setError', error: undefined })
  })

  it('returns GenericAgent output to PTY parents with an Enter key', async () => {
    const parent = createSession({ id: 'parent', interactionMode: 'native-jsonl', status: 'waiting' })
    const child = createSession({
      id: 'child',
      workerType: 'generic-agent',
      interactionMode: 'pty',
      parentSessionId: 'parent',
      status: 'exited'
    })
    window.workerDesk.getOutputBuffer = vi.fn(async () => '[GA_RESULT]\nfinal answer\n[/GA_RESULT]')
    const handlers = useSessionHandlers(createState({ sessions: [parent, child] }), dispatch, terminalSizeRef)

    await handlers.handleReturnToParentClaude('child', 'parent')

    expect(window.workerDesk.writeSessionInput).toHaveBeenCalledWith('parent', expect.stringContaining('final answer'))
    expect(window.workerDesk.writeSessionInput).toHaveBeenCalledWith('parent', '\r')
  })
})
