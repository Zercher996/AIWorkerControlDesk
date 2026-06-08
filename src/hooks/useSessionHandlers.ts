import type { Dispatch, MutableRefObject } from 'react'
import type { AppAction, AppState } from '../state/appStore'
import type { ProviderCatalogPatch, Session, WorkerType } from '../types/workerDesk'
import { joinOutputChunksForDisplay } from '../utils/outputFormatting'
import { buildContinueFromSummaryPrompt, buildGenericAgentReturnPrompt, extractGenericAgentResult, getDisplayErrorMessage } from '../utils/prompts'
import { isTerminalSessionStatus } from '../utils/sessionStatus'
import { hasChildReturned, markChildReturned } from './genericAgentReturnRegistry'

function isCurrentClaudeConfigSession(session: AppState['sessions'][number] | undefined): boolean {
  return session?.providerName === 'Current Claude Config'
}

function markHandledIfReviewable(
  session: AppState['sessions'][number] | undefined,
  userAttentionBySessionId: AppState['userAttentionBySessionId'],
  dispatch: Dispatch<AppAction>
) {
  if (!session) return
  if (
    isTerminalSessionStatus(session.status)
    || userAttentionBySessionId[session.id] === 'needsReview'
  ) {
    dispatch({ type: 'markSessionAttentionHandled', sessionId: session.id })
  }
}

export function useSessionHandlers(
  state: AppState,
  dispatch: Dispatch<AppAction>,
  terminalSizeRef: MutableRefObject<{ cols: number; rows: number }>
) {
  async function handleApplyCurrentClaudeConfig() {
    try {
      const config = await window.workerDesk.getCurrentClaudeConfig()
      dispatch({ type: 'currentClaudeConfigLoaded', config })
      dispatch({ type: 'setError', error: undefined })
      return true
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
      return false
    }
  }

  async function handleStartSession(projectId: string, workerType: WorkerType, providerProfileId?: string, providerModelId?: string, taskTitle?: string) {
    if (state.isSessionStarting) return false
    dispatch({ type: 'setSessionStarting', isStarting: true })
    try {
      const selectedProject = state.projects.find((project) => project.id === projectId)
      const trimmedTaskTitle = taskTitle?.trim()
      const useCurrentClaudeConfig = workerType === 'claude-code' && state.selectedClaudeLaunchMode === 'current-claude-config'
      const session = await window.workerDesk.startSession({
        projectId,
        workerType,
        taskTitle: trimmedTaskTitle || undefined,
        genericAgentConfigId: workerType === 'generic-agent' ? selectedProject?.genericAgentConfigId : undefined,
        providerProfileId: useCurrentClaudeConfig ? undefined : providerProfileId,
        providerModelId: useCurrentClaudeConfig ? undefined : providerModelId,
        interactionMode: workerType === 'claude-code' ? 'native-jsonl' : undefined,
        claudeLaunchSource: workerType === 'claude-code'
          ? (useCurrentClaudeConfig
              ? { type: 'current-claude-config' }
              : providerProfileId
                ? { type: 'provider', providerProfileId, providerModelId }
                : undefined)
          : undefined,
        terminalSize: terminalSizeRef.current
      })
      dispatch({ type: 'upsertSession', session })

      dispatch({ type: 'selectSession', sessionId: session.id })
      dispatch({ type: 'setRightTab', tab: 'terminal' })
      dispatch({ type: 'setError', error: undefined })
      return true
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
      return false
    } finally {
      dispatch({ type: 'setSessionStarting', isStarting: false })
    }
  }

  async function handleContinueFromSummary(historySessionId: string) {
    const historySession = state.history.find((s) => s.id === historySessionId)
    const sourceSession = state.sessions.find((s) => s.id === historySessionId)
    const useCurrentClaudeConfig = isCurrentClaudeConfigSession(sourceSession) || state.selectedClaudeLaunchMode === 'current-claude-config'
    if (!useCurrentClaudeConfig && !state.selectedProviderProfileId) {
      dispatch({ type: 'setError', error: '需要先选择模型连接才能继续任务' })
      return
    }
    const cliSession = state.cliHistory.find((s) => s.id === historySessionId)
    const projectId = cliSession?.projectId ?? historySession?.projectId ?? state.selectedProjectId
    if (!projectId) {
      dispatch({ type: 'setError', error: '无法确定继续任务的项目，请先选择一个项目' })
      return
    }
    const summary = state.summaryBySessionId[historySessionId]
    if (!summary) {
      dispatch({ type: 'setError', error: '需要先生成 Summary，才能继续任务' })
      return
    }
    try {
      dispatch({ type: 'setSessionStarting', isStarting: true })
      const session = await window.workerDesk.startSession({
        projectId,
        workerType: 'claude-code',
        providerProfileId: useCurrentClaudeConfig ? undefined : state.selectedProviderProfileId,
        providerModelId: useCurrentClaudeConfig ? undefined : state.selectedProviderModelId,
        claudeLaunchSource: useCurrentClaudeConfig
          ? { type: 'current-claude-config' }
          : state.selectedProviderProfileId
            ? { type: 'provider', providerProfileId: state.selectedProviderProfileId, providerModelId: state.selectedProviderModelId }
            : undefined,
        interactionMode: 'native-jsonl',
        initialPrompt: buildContinueFromSummaryPrompt(summary),
        terminalSize: terminalSizeRef.current
      })
      dispatch({ type: 'upsertSession', session })
      dispatch({ type: 'selectSession', sessionId: session.id })
      dispatch({ type: 'setRightTab', tab: 'terminal' })
      dispatch({ type: 'setError', error: undefined })
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
    } finally {
      dispatch({ type: 'setSessionStarting', isStarting: false })
    }
  }

  async function handleInput(sessionId: string, data: string) {
    const session = state.sessions.find((s) => s.id === sessionId)
    if (!session || isTerminalSessionStatus(session.status)) return
    try {
      await window.workerDesk.writeSessionInput(sessionId, data)
    } catch {
      // Session may have exited between check and write; ignore
    }
  }

  async function handleSendSessionMessage(sessionId: string, text: string) {
    const session = state.sessions.find((s) => s.id === sessionId)
    if (!session || isTerminalSessionStatus(session.status)) return
    dispatch({ type: 'setSessionMessageSending', sessionId, isSending: true })
    try {
      if (session.interactionMode === 'headless') {
        await window.workerDesk.sendSessionMessage(sessionId, text)
      } else {
        await window.workerDesk.writeSessionInput(sessionId, `${text.trim()}\r`)
      }
      dispatch({ type: 'setError', error: undefined })
    } catch (error) {
      const message = getDisplayErrorMessage(error)
      dispatch({ type: 'setError', error: message })
      throw new Error(message, { cause: error })
    } finally {
      dispatch({ type: 'setSessionMessageSending', sessionId, isSending: false })
    }
  }

  async function handleSelectSession(sessionId: string) {
    markHandledIfReviewable(state.sessions.find((session) => session.id === sessionId), state.userAttentionBySessionId, dispatch)
    dispatch({ type: 'selectSession', sessionId })
    dispatch({ type: 'setRightTab', tab: 'terminal' })
  }

  async function handleStopSession(sessionId: string) {
    try {
      await window.workerDesk.stopSession(sessionId)
      dispatch({ type: 'setError', error: undefined })
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
    }
  }

  async function handleCreateSimilarSession(sessionId: string) {
    if (state.isSessionStarting) return
    const sourceSession = state.sessions.find((session) => session.id === sessionId)
    if (!sourceSession) return
    dispatch({ type: 'setSessionStarting', isStarting: true })
    try {
      const session = await window.workerDesk.startSession({
        projectId: sourceSession.projectId,
        workerType: sourceSession.workerType,
        taskTitle: sourceSession.taskTitle,
        initialPrompt: sourceSession.workerType === 'generic-agent' ? sourceSession.dispatchTask : undefined,
        parentSessionId: sourceSession.parentSessionId,
        dispatchMode: sourceSession.dispatchMode,
        dispatchTask: sourceSession.dispatchTask,
        genericAgentConfigId: sourceSession.genericAgentConfigId,
        providerProfileId: isCurrentClaudeConfigSession(sourceSession) ? undefined : sourceSession.providerProfileId,
        providerModelId: isCurrentClaudeConfigSession(sourceSession) ? undefined : sourceSession.modelId,
        claudeLaunchSource: sourceSession.workerType === 'claude-code'
          ? (isCurrentClaudeConfigSession(sourceSession)
              ? { type: 'current-claude-config' }
              : sourceSession.providerProfileId
                ? { type: 'provider', providerProfileId: sourceSession.providerProfileId, providerModelId: sourceSession.modelId }
                : undefined)
          : undefined,
        interactionMode: sourceSession.workerType === 'claude-code'
          ? (sourceSession.interactionMode === 'pty' ? 'pty' : 'native-jsonl')
          : undefined,
        terminalSize: terminalSizeRef.current
      })
      dispatch({ type: 'upsertSession', session })
      dispatch({ type: 'selectSession', sessionId: session.id })
      dispatch({ type: 'setRightTab', tab: 'terminal' })
      dispatch({ type: 'setError', error: undefined })
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
    } finally {
      dispatch({ type: 'setSessionStarting', isStarting: false })
    }
  }

  async function handleViewSessionSummary(sessionId: string) {
    const session = state.sessions.find((s) => s.id === sessionId)
    markHandledIfReviewable(session, state.userAttentionBySessionId, dispatch)
    dispatch({ type: 'selectHistorySession', sessionId })
    dispatch({ type: 'setRightTab', tab: 'history' })
    try {
      // Summary primaryKey: prefer cliSessionId when the session has bound to a CC
      // jsonl, falling back to the desk session id. Mirrors the unified storage rule.
      const primaryKey = session?.cliSessionId ?? sessionId
      const [outputResult, summary] = await Promise.all([
        window.workerDesk.getOutput({ sessionId, offset: 0, limit: 1000 }),
        window.workerDesk.getSummary(primaryKey)
      ])
      dispatch({
        type: 'historyOutputLoaded',
        sessionId,
        output: joinOutputChunksForDisplay(outputResult.chunks),
        nextOffset: outputResult.nextOffset,
        totalBytes: outputResult.totalBytes
      })
      dispatch({ type: 'summaryLoaded', sessionId, summary })
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
    }
  }

  async function handleReturnToParentClaude(sessionId: string, parentSessionId: string) {
    const parentSession = state.sessions.find((session) => session.id === parentSessionId)
    if (!parentSession || parentSession.workerType !== 'claude-code' || isTerminalSessionStatus(parentSession.status)) return
    if (hasChildReturned(sessionId)) return

    try {
      const output = await window.workerDesk.getOutputBuffer(sessionId)
      const finalAnswer = extractGenericAgentResult(output)
      if (!finalAnswer) {
        dispatch({ type: 'setError', error: 'GenericAgent 没有可返回的输出' })
        return
      }
      if (hasChildReturned(sessionId)) return
      if (parentSession.interactionMode === 'headless') {
        await window.workerDesk.sendSessionMessage(parentSessionId, buildGenericAgentReturnPrompt(sessionId, finalAnswer))
      } else if (parentSession.interactionMode === 'native-jsonl' || parentSession.interactionMode === 'pty') {
        await window.workerDesk.writeSessionInput(parentSessionId, buildGenericAgentReturnPrompt(sessionId, finalAnswer))
        await window.workerDesk.writeSessionInput(parentSessionId, '\r')
      }
      markChildReturned(sessionId)
      markHandledIfReviewable(state.sessions.find((session) => session.id === sessionId), state.userAttentionBySessionId, dispatch)
      dispatch({ type: 'selectSession', sessionId: parentSessionId })
      dispatch({ type: 'setRightTab', tab: 'terminal' })
      dispatch({ type: 'setError', error: undefined })
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
    }
  }

  async function handleSwitchToNativeTakeover(sourceSession: Session, command?: string) {
    const session = state.sessions.find((item) => item.id === sourceSession.id)
    if (!session || isTerminalSessionStatus(session.status)) return false
    dispatch({ type: 'setSessionViewMode', sessionId: session.id, viewMode: 'native-pty' })
    dispatch({ type: 'selectSession', sessionId: session.id })
    dispatch({ type: 'setRightTab', tab: 'terminal' })
    try {
      if (command) await window.workerDesk.writeSessionInput(session.id, `${command}\r`)
      dispatch({ type: 'setError', error: undefined })
      return true
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
      return false
    }
  }

  function handleReturnToAiPane(sessionId: string) {
    dispatch({ type: 'setSessionViewMode', sessionId, viewMode: 'ai' })
    dispatch({ type: 'setRightTab', tab: 'terminal' })
  }

  async function handleToggleAutoDispatch(projectId: string, enabled: boolean, genericAgentConfigId?: string) {
    try {
      const project = await window.workerDesk.updateProject(projectId, {
        autoDispatchGenericAgent: enabled,
        genericAgentConfigId
      })
      dispatch({ type: 'projectUpdated', project })
      dispatch({ type: 'setError', error: undefined })
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
    }
  }

  async function handleLoadProviderCatalog() {
    try {
      const catalog = await window.workerDesk.listProviderCatalog()
      dispatch({ type: 'providerCatalogLoaded', catalog })
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
    }
  }

  async function handleSaveProviderCatalog(patch: ProviderCatalogPatch) {
    try {
      const catalog = await window.workerDesk.saveProviderCatalogPatch(patch)
      dispatch({ type: 'providerCatalogLoaded', catalog })
      dispatch({ type: 'setError', error: undefined })
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
      throw error
    }
  }

  async function handleAddProject() {
    try {
      const projectPath = await window.workerDesk.pickProjectPath()
      if (!projectPath) return
      const project = await window.workerDesk.addProject(projectPath)
      dispatch({ type: 'projectAdded', project })
      dispatch({ type: 'selectProject', projectId: project.id })
      dispatch({ type: 'setError', error: undefined })
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
    }
  }

  async function handleRemoveProject(projectId: string) {
    try {
      const nextProject = await window.workerDesk.removeProject(projectId)
      dispatch({ type: 'projectRemoved', projectId, nextProjectId: nextProject?.id })
      dispatch({ type: 'setError', error: undefined })
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
    }
  }

  async function handleResizeSession(sessionId: string, cols: number, rows: number) {
    terminalSizeRef.current = { cols, rows }
    const session = state.sessions.find((s) => s.id === sessionId)
    if (!session || isTerminalSessionStatus(session.status)) return
    try {
      await window.workerDesk.resizeSession(sessionId, cols, rows)
    } catch {
      // Session may have exited; ignore resize errors
    }
  }

  return {
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
  }
}
