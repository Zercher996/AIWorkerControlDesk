import { useEffect, useRef } from 'react'
import type { Dispatch } from 'react'
import type { AppAction, AppState } from '../state/appStore'
import { buildGenericAgentDispatchInstruction, getDisplayErrorMessage } from '../utils/prompts'
import { isTerminalSessionStatus } from '../utils/sessionStatus'

const DEFAULT_QUIET_DELAY_MS = 1000
const MAX_BUFFER_LENGTH = 8000
const UNSAFE_STARTUP_PATTERN = /Configuration Error|Choose an option|Enter to confirm|Reset with default configuration|Do you want to proceed\?|\[y\/n\]|Press Enter to continue/i
let quietDelayMs = DEFAULT_QUIET_DELAY_MS

export function setClaudeCodeGenericAgentInstructionDelayForTesting(delayMs: number): void {
  quietDelayMs = delayMs
}

export function resetClaudeCodeGenericAgentInstructionDelayForTesting(): void {
  quietDelayMs = DEFAULT_QUIET_DELAY_MS
}

type UseClaudeCodeGenericAgentInstructionInput = {
  state: AppState
  dispatch: Dispatch<AppAction>
}

export function useClaudeCodeGenericAgentInstruction(input: UseClaudeCodeGenericAgentInstructionInput) {
  const stateRef = useRef(input.state)
  const sentRef = useRef(new Set<string>())
  const canceledRef = useRef(new Set<string>())
  const buffersRef = useRef(new Map<string, string>())
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  stateRef.current = input.state

  useEffect(() => {
    function clearTimer(sessionId: string) {
      const timer = timersRef.current.get(sessionId)
      if (!timer) return
      clearTimeout(timer)
      timersRef.current.delete(sessionId)
    }

    function isEligibleClaudeSession(sessionId: string): boolean {
      if (sentRef.current.has(sessionId) || canceledRef.current.has(sessionId)) return false
      const state = stateRef.current
      const session = state.sessions.find((item) => item.id === sessionId)
      if (!session || session.workerType !== 'claude-code') return false
      if (isTerminalSessionStatus(session.status)) return false
      const project = state.projects.find((item) => item.id === session.projectId)
      return Boolean(project?.autoDispatchGenericAgent)
    }

    async function sendInstruction(sessionId: string) {
      timersRef.current.delete(sessionId)
      if (!isEligibleClaudeSession(sessionId)) return
      const buffer = buffersRef.current.get(sessionId) ?? ''
      if (UNSAFE_STARTUP_PATTERN.test(buffer)) {
        canceledRef.current.add(sessionId)
        return
      }

      try {
        const session = stateRef.current.sessions.find((item) => item.id === sessionId)
        if (session?.interactionMode === 'headless') {
          await window.workerDesk.sendSessionMessage(sessionId, buildGenericAgentDispatchInstruction())
        } else if (session?.interactionMode === 'native-jsonl' || session?.interactionMode === 'pty') {
          await window.workerDesk.writeSessionInput(sessionId, buildGenericAgentDispatchInstruction())
          await window.workerDesk.writeSessionInput(sessionId, '\r')
        }
        sentRef.current.add(sessionId)
      } catch (error) {
        input.dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
      }
    }

    const dispose = window.workerDesk.onSessionOutput((event) => {
      const currentBuffer = `${buffersRef.current.get(event.sessionId) ?? ''}${event.chunk}`.slice(-MAX_BUFFER_LENGTH)
      buffersRef.current.set(event.sessionId, currentBuffer)

      if (UNSAFE_STARTUP_PATTERN.test(currentBuffer)) {
        canceledRef.current.add(event.sessionId)
        clearTimer(event.sessionId)
        return
      }
      if (sentRef.current.has(event.sessionId) || canceledRef.current.has(event.sessionId)) return

      clearTimer(event.sessionId)
      const timer = setTimeout(() => {
        void sendInstruction(event.sessionId)
      }, quietDelayMs)
      timersRef.current.set(event.sessionId, timer)
    })

    return () => {
      dispose()
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [input.dispatch])
}
