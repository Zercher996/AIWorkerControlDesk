import type { Dispatch } from 'react'
import type { AppAction, AppState } from '../state/appStore'
import { formatOutputForDisplay, joinOutputChunksForDisplay } from '../utils/outputFormatting'
import { getDisplayErrorMessage } from '../utils/prompts'

export function useHistoryHandlers(state: AppState, dispatch: Dispatch<AppAction>) {
  /**
   * Resolve the unified Summary primary key for a given history card id.
   *   - CLI history card: the card id IS the cliSessionId, use it as-is.
   *   - Desk-only card (GA, or claude-code where mtime matching failed):
   *     no cliSessionId, fall back to the Desk Session id.
   * This keeps the renderer free of "which kind is it" branching at every
   * Summary read/write site — only the source-of-output decision needs it.
   */
  function resolveSummaryPrimaryKey(historySessionId: string): string {
    const cli = state.cliHistory.find((s) => s.id === historySessionId)
    if (cli) return cli.id
    const desk = state.history.find((s) => s.id === historySessionId)
    return desk?.cliSessionId ?? historySessionId
  }

  async function handleSelectHistorySession(sessionId: string | undefined) {
    dispatch({ type: 'selectHistorySession', sessionId })
    if (!sessionId) return
    dispatch({ type: 'setRightTab', tab: 'history' })

    const cliSession = state.cliHistory.find((s) => s.id === sessionId)
    const primaryKey = resolveSummaryPrimaryKey(sessionId)

    // CLI history card (the common case after this refactor):
    // read structured conversation directly from CC's jsonl. Summary is keyed
    // by cliSessionId so it converges with whatever was generated via Desk.
    if (cliSession) {
      try {
        const [output, summary] = await Promise.all([
          window.workerDesk.getCliSessionOutput(sessionId, cliSession.projectId),
          window.workerDesk.getSummary(primaryKey)
        ])
        dispatch({
          type: 'historyOutputLoaded',
          sessionId,
          output: formatOutputForDisplay(output),
          nextOffset: undefined,
          totalBytes: 0
        })
        dispatch({ type: 'summaryLoaded', sessionId, summary })
      } catch (error) {
        dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
      }
      return
    }

    // Desk-only card: GenericAgent, or claude-code where matching the CC jsonl
    // failed. Output comes from the PTY chunk store; Summary still uses the
    // unified primaryKey.
    try {
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

  async function handleLoadMoreOutput(sessionId: string) {
    const offset = state.historyOutputNextOffset[sessionId]
    if (offset == null) return
    dispatch({ type: 'setHistoryOutputLoading', isLoading: true })
    try {
      const result = await window.workerDesk.getOutput({ sessionId, offset, limit: 1000 })
      dispatch({
        type: 'appendHistoryOutput',
        sessionId,
        output: joinOutputChunksForDisplay(result.chunks),
        nextOffset: result.nextOffset
      })
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
    } finally {
      dispatch({ type: 'setHistoryOutputLoading', isLoading: false })
    }
  }

  async function handleSearchHistory(query: string) {
    const projectId = state.selectedProjectId
    if (query.trim().length === 0) {
      // Cleared search: reload the full project history in one round-trip.
      if (!projectId) {
        dispatch({ type: 'projectHistoryLoaded', history: [], cliHistory: [] })
        return
      }
      const { desk, cli } = await window.workerDesk.listProjectHistory(projectId)
      dispatch({ type: 'projectHistoryLoaded', history: desk, cliHistory: cli })
      return
    }
    // Search path: still uses the dedicated search endpoints since they return
    // result objects (with excerpts) rather than the full history items.
    const [history, deskResults, cliResults] = await Promise.all([
      window.workerDesk.listHistory(projectId),
      window.workerDesk.search({ query }),
      projectId ? window.workerDesk.searchCliHistory(projectId, query) : Promise.resolve([])
    ])
    const deskResultIds = new Set(deskResults.map((result) => result.sessionId))
    const cliResultIds = new Set(cliResults.map((result) => result.sessionId))
    dispatch({
      type: 'historyLoaded',
      history: history.filter((session) => deskResultIds.has(session.id))
    })
    if (projectId) {
      const filteredCliHistory = state.cliHistory.filter((session) => cliResultIds.has(session.id))
      dispatch({ type: 'cliHistoryLoaded', history: filteredCliHistory })
    }
  }

  async function handleGenerateSummary(sessionId: string) {
    dispatch({ type: 'setSummaryLoading', isLoading: true })
    try {
      const providerProfileId = state.selectedProviderProfileId ?? ''
      if (!providerProfileId) {
        dispatch({ type: 'setError', error: '需要先选择模型连接才能生成 Summary' })
        return
      }
      const cliSession = state.cliHistory.find((session) => session.id === sessionId)
      const source = cliSession
        ? { kind: 'cli-session' as const, cliSessionId: cliSession.id, projectId: cliSession.projectId }
        : { kind: 'desk-session' as const, deskSessionId: sessionId }
      const summary = await window.workerDesk.generateSummary(source, providerProfileId, state.selectedProviderModelId)
      dispatch({ type: 'summaryLoaded', sessionId, summary })
      dispatch({ type: 'setError', error: undefined })
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
    } finally {
      dispatch({ type: 'setSummaryLoading', isLoading: false })
    }
  }

  async function handleExportSession(sessionId: string) {
    try {
      await window.workerDesk.exportSession(sessionId)
    } catch (error) {
      dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
    }
  }

  return {
    handleSelectHistorySession,
    handleLoadMoreOutput,
    handleSearchHistory,
    handleGenerateSummary,
    handleExportSession
  }
}
