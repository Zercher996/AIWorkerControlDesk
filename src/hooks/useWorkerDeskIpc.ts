import { useEffect } from 'react'
import type { Dispatch } from 'react'
import type { AppAction } from '../state/appStore'
import { getDisplayErrorMessage } from '../utils/prompts'

export function useWorkerDeskIpc(dispatch: Dispatch<AppAction>, selectedProjectId?: string, selectedSessionId?: string) {
  useEffect(() => {
    async function loadInitialData() {
      try {
        const [projects, sessions, genericAgentConfigs, catalog] = await Promise.all([
          window.workerDesk.listProjects(),
          window.workerDesk.listSessions(),
          window.workerDesk.listGenericAgentConfigs(),
          window.workerDesk.listProviderCatalog()
        ])
        dispatch({ type: 'loaded', projects, sessions })
        dispatch({ type: 'genericAgentConfigsLoaded', configs: genericAgentConfigs })
        dispatch({ type: 'providerCatalogLoaded', catalog })
        // History (both Desk meta and CLI jsonl) is loaded per-project by the
        // effect below. Without a selected project there is nothing meaningful
        // to show, so we don't pre-load a global history.
      } catch (error) {
        dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
      }
    }

    const disposeSession = window.workerDesk.onSessionChanged((session) => dispatch({ type: 'upsertSession', session }))
    const disposeAiEvent = window.workerDesk.onSessionAiEvent((event) => dispatch({ type: 'sessionAiEventReceived', event }))
    const disposeAttention = window.workerDesk.onSessionAttentionChanged((event) => dispatch({ type: 'sessionAttentionChanged', event }))
    loadInitialData()

    return () => {
      disposeSession()
      disposeAiEvent()
      disposeAttention()
    }
  }, [dispatch])

  // Project-scoped history. When the user picks a different project we make a
  // single round-trip and commit both lists in one dispatch:
  //
  //   - One IPC instead of two: `listProjectHistory` bundles desk meta + cli
  //     jsonl. Halves the round-trips compared to the old parallel pair.
  //   - One dispatch (`projectHistoryLoaded`): atomic state swap, no half-loaded
  //     mergedHistory frame.
  //   - No clearing on entry: we keep the previous project's lists visible
  //     until the new ones arrive, then overwrite. Avoids the empty flash a
  //     user would otherwise see for one frame.
  //   - `cancelled` flag: if the user clicks A → B → C quickly, B's response
  //     might arrive after C's; we ignore stale responses so we never overwrite
  //     C with B.
  useEffect(() => {
    if (!selectedProjectId) {
      // Only clear when there's literally no project selected (initial load
      // before any project exists). Project switches keep the old list until
      // the new one is in hand.
      dispatch({ type: 'projectHistoryLoaded', history: [], cliHistory: [] })
      return
    }
    let cancelled = false
    void window.workerDesk.listProjectHistory(selectedProjectId)
      .then((result) => {
        if (cancelled) return
        dispatch({ type: 'projectHistoryLoaded', history: result.desk, cliHistory: result.cli })
      })
      .catch(() => {
        if (cancelled) return
        // Listing is best-effort; on hard failure leave both lists empty rather
        // than show stale data from the previous project.
        dispatch({ type: 'projectHistoryLoaded', history: [], cliHistory: [] })
      })
    return () => {
      cancelled = true
    }
  }, [dispatch, selectedProjectId])

  useEffect(() => {
    if (!selectedSessionId) return
    let cancelled = false
    void window.workerDesk.getSessionAiEvents({ sessionId: selectedSessionId, offset: 0, limit: 1000 })
      .then((result) => {
        if (cancelled) return
        dispatch({
          type: 'sessionAiEventsLoaded',
          sessionId: selectedSessionId,
          events: result.events,
          nextOffset: result.nextOffset,
          totalBytes: result.totalBytes
        })
      })
      .catch(() => {
        if (cancelled) return
        dispatch({ type: 'sessionAiEventsLoaded', sessionId: selectedSessionId, events: [], totalBytes: 0 })
      })
    return () => {
      cancelled = true
    }
  }, [dispatch, selectedSessionId])
}
