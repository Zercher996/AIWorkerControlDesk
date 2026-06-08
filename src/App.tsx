import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { AiSessionPane } from './components/AiSessionPane'
import { HistoryPanel } from './components/HistoryPanel'
import { ProjectPanel } from './components/ProjectPanel'
import { SessionDetail } from './components/SessionDetail'
import { SessionRadar } from './components/SessionRadar'
import { TerminalPane } from './components/TerminalPane'
import { useGenericAgentAutoReturn } from './hooks/useGenericAgentAutoReturn'
import { useGenericAgentDispatch } from './hooks/useGenericAgentDispatch'
import { useClaudeCodeGenericAgentInstruction } from './hooks/useClaudeCodeGenericAgentInstruction'
import { useHistoryHandlers } from './hooks/useHistoryHandlers'
import { useSessionHandlers } from './hooks/useSessionHandlers'
import { useWorkerDeskIpc } from './hooks/useWorkerDeskIpc'
import { appReducer, initialAppState } from './state/appStore'
import { buildHistoryViewModel } from './utils/historyViewModel'
import { isTerminalSessionStatus } from './utils/sessionStatus'

const THEME_STORAGE_KEY = 'ai-worker-theme'

type AppTheme = 'dark' | 'light'

function readInitialTheme(): AppTheme {
  if (typeof window === 'undefined') return 'dark'
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return stored === 'light' || stored === 'dark' ? stored : 'dark'
}

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialAppState)
  const [theme, setTheme] = useState<AppTheme>(() => readInitialTheme())
  const terminalSizeRef = useRef({ cols: 100, rows: 30 })

  // Theme — lightweight built-in dark/light modes via CSS tokens
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    window.workerDesk.setWindowTheme(theme).catch(() => undefined)
  }, [theme])

  // Platform detection — set class on root element for CSS isolation
  useEffect(() => {
    const el = document.querySelector('.app-shell')
    if (!el) return
    const platform = navigator.platform
    if (platform.startsWith('Win')) el.classList.add('windows-desktop')
    else if (platform.startsWith('Mac')) el.classList.add('macos-desktop')
  }, [])

  // Reduced-transparency detection (progressive enhancement)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-transparency: reduce)')
    const handler = (e: MediaQueryListEvent) => {
      document.querySelector('.app-shell')?.classList.toggle('reduced-transparency', e.matches)
    }
    if (mq.matches) document.querySelector('.app-shell')?.classList.add('reduced-transparency')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  useWorkerDeskIpc(dispatch, state.selectedProjectId, state.selectedSessionId)
  useGenericAgentAutoReturn({ state, dispatch })
  useClaudeCodeGenericAgentInstruction({ state, dispatch })
  useGenericAgentDispatch({ state, dispatch, terminalSizeRef })

  const {
    handleApplyCurrentClaudeConfig,
    handleStartSession,
    handleContinueFromSummary,
    handleInput,
    handleSendSessionMessage,
    handleSelectSession,
    handleStopSession,
    handleCreateSimilarSession,
    handleViewSessionSummary,
    handleReturnToParentClaude,
    handleSwitchToNativeTakeover,
    handleReturnToAiPane,
    handleToggleAutoDispatch,
    handleLoadProviderCatalog,
    handleSaveProviderCatalog,
    handleAddProject,
    handleRemoveProject,
    handleResizeSession
  } = useSessionHandlers(state, dispatch, terminalSizeRef)

  const {
    handleSelectHistorySession,
    handleLoadMoreOutput,
    handleSearchHistory,
    handleGenerateSummary,
    handleExportSession
  } = useHistoryHandlers(state, dispatch)

  const selectedSession = useMemo(
    () => state.sessions.find((session) => session.id === state.selectedSessionId),
    [state.sessions, state.selectedSessionId]
  )

  const parentClaudeSession = useMemo(
    () => selectedSession?.parentSessionId
      ? state.sessions.find((session) => session.id === selectedSession.parentSessionId)
      : undefined,
    [state.sessions, selectedSession?.parentSessionId]
  )

  const canReturnToParentClaude = Boolean(
    selectedSession?.workerType === 'generic-agent'
      && selectedSession.parentSessionId
      && parentClaudeSession?.workerType === 'claude-code'
      && !isTerminalSessionStatus(parentClaudeSession.status)
  )

  const selectedHistorySession = useMemo(() => {
    if (!state.selectedHistorySessionId) return undefined
    // Try CLI history first — it's the primary source of truth for project history.
    const cli = state.cliHistory.find((session) => session.id === state.selectedHistorySessionId)
    if (cli) return cli
    // Fall back to Desk-only sessions (GA, or claude-code that failed to match a jsonl).
    const desk = state.history.find((session) => session.id === state.selectedHistorySessionId)
    if (desk) return desk
    const active = state.sessions.find((session) => session.id === state.selectedHistorySessionId)
    return active ? { ...active, source: 'desk' as const } : undefined
  }, [state.history, state.cliHistory, state.sessions, state.selectedHistorySessionId])

  const mergedHistory = useMemo(() => {
    const liveDeskHistory = state.historyQuery.trim().length === 0
      ? state.sessions.filter((session) => (
          session.projectId === state.selectedProjectId
          && isTerminalSessionStatus(session.status)
          && !state.history.some((historySession) => historySession.id === session.id)
          && !(session.cliSessionId && state.cliHistory.some((cliSession) => cliSession.id === session.cliSessionId))
        ))
      : []
    return buildHistoryViewModel({
      cliHistory: state.cliHistory,
      deskHistory: state.history,
      liveDeskHistory,
      summaryBySessionId: state.summaryBySessionId
    })
  }, [state.history, state.cliHistory, state.sessions, state.selectedProjectId, state.historyQuery, state.summaryBySessionId])

  const selectedProject = useMemo(
    () => state.projects.find((project) => project.id === state.selectedProjectId),
    [state.projects, state.selectedProjectId]
  )

  const isTerminalVisible = state.rightTab === 'terminal'
  const isHistoryVisible = state.rightTab === 'history'
  const selectedSessionViewMode = selectedSession
    ? state.sessionViewModeBySessionId[selectedSession.id] ?? defaultSessionViewMode(selectedSession)
    : 'ai'
  const showAiSessionPane = selectedSessionViewMode === 'ai'
  const currentSessionTabLabel = selectedSession ? `当前会话：${selectedSession.taskTitle ?? selectedSession.title}` : '当前会话'

  const handleInputAnchorCreated = (sessionId: string, summary: string) => {
    dispatch({ type: 'setSessionTaskTitle', sessionId, taskTitle: summary })
  }

  return (
    <main className="app-shell">
      <div className="top-menu-bar" aria-label="顶部调度栏">
        <div className="topbar-brand">
          <strong>AIWorkerControlDesk</strong>
          <span>本地 AI Worker 调度台</span>
        </div>
        <div className="topbar-drag-space" aria-hidden="true" />
        <div className="topbar-actions">
          <button
            className="theme-toggle"
            type="button"
            title={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? '浅' : '深'}
          </button>
        </div>
      </div>
      <ProjectPanel
        projects={state.projects}
        genericAgentConfigs={state.genericAgentConfigs}
        providerCatalog={state.providerCatalog}
        currentClaudeConfig={state.currentClaudeConfig}
        selectedProjectId={state.selectedProjectId}
        selectedWorkerType={state.selectedWorkerType}
        selectedProviderProfileId={state.selectedProviderProfileId}
        selectedProviderModelId={state.selectedProviderModelId}
        selectedClaudeLaunchMode={state.selectedClaudeLaunchMode}
        isStartingSession={state.isSessionStarting}
        onSelectProject={(projectId) => dispatch({ type: 'selectProject', projectId })}
        onSelectWorkerType={(workerType) => dispatch({ type: 'selectWorkerType', workerType })}
        onSelectProviderProfile={(providerProfileId) => dispatch({ type: 'selectProviderProfile', providerProfileId })}
        onSelectProviderModel={(providerModelId) => dispatch({ type: 'selectProviderModel', providerModelId })}
        onSelectClaudeLaunchMode={(mode) => dispatch({ type: 'selectClaudeLaunchMode', mode })}
        onApplyCurrentClaudeConfig={handleApplyCurrentClaudeConfig}
        onToggleAutoDispatch={handleToggleAutoDispatch}
        onSaveProviderCatalog={handleSaveProviderCatalog}
        onOpenProviderCatalog={handleLoadProviderCatalog}
        onAddProject={handleAddProject}
        onRemoveProject={handleRemoveProject}
        onStartSession={handleStartSession}
      />
      <SessionRadar
        sessions={state.sessions}
        handledAttentionSessionIds={state.handledAttentionSessionIds}
        userAttentionBySessionId={state.userAttentionBySessionId}
        selectedSessionId={state.selectedSessionId}
        onSelectSession={handleSelectSession}
        onStopSession={handleStopSession}
        onCreateSimilarSession={handleCreateSimilarSession}
        onViewSessionSummary={handleViewSessionSummary}
      />
      <div className="right-column">
        <div className="right-tabs">
          <button
            className={state.rightTab === 'terminal' ? 'tab active' : 'tab'}
            onClick={() => dispatch({ type: 'setRightTab', tab: 'terminal' })}
          >
            {currentSessionTabLabel}
          </button>
          <button
            className={state.rightTab === 'history' ? 'tab active' : 'tab'}
            onClick={() => dispatch({ type: 'setRightTab', tab: 'history' })}
          >
            历史
          </button>
        </div>
        <div className="right-content">
          {/* Current session — AI input/output page */}
          <div className={`content-layer ${isTerminalVisible ? 'is-active' : 'is-hidden'}`}
               inert={isTerminalVisible ? undefined : true}>
            {showAiSessionPane ? (
              <AiSessionPane
                selectedSession={selectedSession}
                events={selectedSession ? state.sessionAiEventsBySessionId[selectedSession.id] ?? [] : []}
                isSending={selectedSession ? state.isSendingMessageBySessionId[selectedSession.id] : false}
                onSendMessage={handleSendSessionMessage}
                onSetTaskTitle={handleInputAnchorCreated}
                onOpenModelControls={() => {
                  document.querySelector<HTMLElement>('[aria-label="模型"]')?.focus()
                  return true
                }}
                onSwitchToNativeTakeover={handleSwitchToNativeTakeover}
                onListSlashCommandSuggestions={(input) => window.workerDesk.listSlashAssistIndex(input)}
              />
            ) : (
              <TerminalPane
                selectedSession={selectedSession}
                parentSessionTitle={parentClaudeSession?.title}
                isVisible={isTerminalVisible}
                canReturnToParentClaude={canReturnToParentClaude}
                onInput={handleInput}
                onResize={handleResizeSession}
                onInputAnchorCreated={handleInputAnchorCreated}
                onReturnToParentClaude={handleReturnToParentClaude}
                onReturnToAiPane={handleReturnToAiPane}
              />
            )}
          </div>
          {/* History — always mounted, content-layer visibility toggle */}
          <div className={`content-layer ${isHistoryVisible ? 'is-active' : 'is-hidden'}`}
               inert={isHistoryVisible ? undefined : true}>
            <div className="history-view">
              {state.selectedHistorySessionId ? (
                <SessionDetail
                  session={selectedHistorySession}
                  source={selectedHistorySession?.source ?? 'desk'}
                  selectedProjectId={state.selectedProjectId}
                  selectedProviderProfileId={state.selectedProviderProfileId}
                  currentProviderName={state.providerCatalog?.providers.find((p) => p.id === state.selectedProviderProfileId)?.name}
                  output={selectedHistorySession ? state.historyOutputBySessionId[selectedHistorySession.id] ?? '' : ''}
                  summary={selectedHistorySession ? state.summaryBySessionId[selectedHistorySession.id] : undefined}
                  hasMoreOutput={selectedHistorySession ? state.historyOutputNextOffset[selectedHistorySession.id] != null : false}
                  outputSizeBytes={selectedHistorySession ? state.historyOutputTotalBytes[selectedHistorySession.id] ?? 0 : 0}
                  isLoading={state.isSummaryLoading}
                  isLoadingMore={state.isHistoryOutputLoading}
                  isStartingSession={state.isSessionStarting}
                  onGenerateSummary={handleGenerateSummary}
                  onExport={handleExportSession}
                  onLoadMore={handleLoadMoreOutput}
                  onResumeSession={handleContinueFromSummary}
                  onBack={() => dispatch({ type: 'selectHistorySession', sessionId: undefined })}
                />
              ) : (
                <HistoryPanel
                  resumableItems={mergedHistory.resumable}
                  items={mergedHistory.primary}
                  lowSignalItems={mergedHistory.lowSignal}
                  selectedSessionId={state.selectedHistorySessionId}
                  query={state.historyQuery}
                  projectName={selectedProject?.name}
                  onQueryChange={(query) => dispatch({ type: 'setHistoryQuery', query })}
                  onSearch={handleSearchHistory}
                  onSelectSession={handleSelectHistorySession}
                />
              )}
            </div>
          </div>
        </div>
      </div>
      {state.error ? (
        <div className="error-toast" role="alert" onClick={() => dispatch({ type: 'setError', error: undefined })}>
          <span>{state.error}</span>
          <button
            type="button"
            className="error-toast-close"
            aria-label="关闭错误提示"
            onClick={() => dispatch({ type: 'setError', error: undefined })}
          >
            ×
          </button>
        </div>
      ) : null}
    </main>
  )
}

function defaultSessionViewMode(session: { workerType: string; interactionMode: string }) {
  if (session.workerType === 'generic-agent') return 'native-pty'
  if (session.interactionMode === 'pty') return 'native-pty'
  return 'ai'
}
