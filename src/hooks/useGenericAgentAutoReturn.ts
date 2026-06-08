import { useEffect, useRef } from 'react'
import type { Dispatch } from 'react'
import type { AppAction, AppState } from '../state/appStore'
import { extractGenericAgentResult, getDisplayErrorMessage, buildGenericAgentReturnPrompt } from '../utils/prompts'
import { isTerminalSessionStatus } from '../utils/sessionStatus'
import { hasChildReturned, markChildReturned } from './genericAgentReturnRegistry'

const DEFAULT_AUTO_RETURN_DELAY_MS = 1500
const TURN_DONE_PATTERN = /\[Output\][^\n\r]*\bstop_reason\s*=\s*end_turn\b/i
let autoReturnDelayMs = DEFAULT_AUTO_RETURN_DELAY_MS

export function setAutoReturnDelayMsForTesting(delayMs: number): void {
  autoReturnDelayMs = delayMs
}

export function resetAutoReturnDelayMsForTesting(): void {
  autoReturnDelayMs = DEFAULT_AUTO_RETURN_DELAY_MS
}

type UseGenericAgentAutoReturnInput = {
  state: AppState
  dispatch: Dispatch<AppAction>
}

export function useGenericAgentAutoReturn(input: UseGenericAgentAutoReturnInput) {
  const stateRef = useRef(input.state)
  const scheduledRef = useRef(new Set<string>())
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  stateRef.current = input.state

  useEffect(() => {
    async function returnToParent(childSessionId: string, parentSessionId: string) {
      timersRef.current.delete(childSessionId)
      if (hasChildReturned(childSessionId)) return

      const currentState = stateRef.current
      const parent = currentState.sessions.find((item) => item.id === parentSessionId)
      if (!parent || parent.workerType !== 'claude-code') return
      if (isTerminalSessionStatus(parent.status)) return

      try {
        const output = await window.workerDesk.getOutputBuffer(childSessionId)
        const finalAnswer = extractGenericAgentResult(output)
        if (!finalAnswer) {
          input.dispatch({ type: 'setError', error: 'GenericAgent 没有可返回的输出' })
          return
        }
        if (hasChildReturned(childSessionId)) return
        if (parent.interactionMode === 'headless') {
          await window.workerDesk.sendSessionMessage(parentSessionId, buildGenericAgentReturnPrompt(childSessionId, finalAnswer))
        } else if (parent.interactionMode === 'native-jsonl' || parent.interactionMode === 'pty') {
          await window.workerDesk.writeSessionInput(parentSessionId, buildGenericAgentReturnPrompt(childSessionId, finalAnswer))
          await window.workerDesk.writeSessionInput(parentSessionId, '\r')
        }
        markChildReturned(childSessionId)
        await window.workerDesk.stopSession(childSessionId).catch(() => undefined)
        input.dispatch({ type: 'selectSession', sessionId: parentSessionId })
        input.dispatch({ type: 'setRightTab', tab: 'terminal' })
        input.dispatch({ type: 'setError', error: undefined })
      } catch (error) {
        input.dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
      }
    }

    function scheduleReturn(childSessionId: string, parentSessionId: string) {
      if (hasChildReturned(childSessionId)) return
      if (scheduledRef.current.has(childSessionId)) return
      scheduledRef.current.add(childSessionId)

      const timer = setTimeout(() => {
        void returnToParent(childSessionId, parentSessionId)
      }, autoReturnDelayMs)

      timersRef.current.set(childSessionId, timer)
    }

    const disposeOutput = window.workerDesk.onSessionOutput((event) => {
      if (!TURN_DONE_PATTERN.test(event.chunk)) return
      const session = stateRef.current.sessions.find((item) => item.id === event.sessionId)
      if (!session || session.workerType !== 'generic-agent') return
      if (session.dispatchMode !== 'auto') return
      if (!session.parentSessionId) return
      scheduleReturn(session.id, session.parentSessionId)
    })

    const disposeSession = window.workerDesk.onSessionChanged((session) => {
      if (session.workerType !== 'generic-agent') return
      if (session.dispatchMode !== 'auto') return
      if (!session.parentSessionId) return
      if (!isTerminalSessionStatus(session.status)) return
      scheduleReturn(session.id, session.parentSessionId)
    })

    return () => {
      disposeOutput()
      disposeSession()
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [input.dispatch])
}
