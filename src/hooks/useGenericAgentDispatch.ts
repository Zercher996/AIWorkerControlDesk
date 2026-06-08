import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { AppAction, AppState } from '../state/appStore'
import type { Dispatch } from 'react'
import { getDisplayErrorMessage } from '../utils/prompts'

const MAX_BUFFER_LENGTH = 20_000
const MAX_TASK_LENGTH = 8_000
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ANSI_CONTROL_PATTERN = new RegExp(`${ESC}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\))`, 'g')
const TASK_START_PATTERN = /^(?<prefix>[ \t]*(?:[●•*-]\s*)?)\[GA_TASK:generic-agent\][ \t]*/
const TASK_END_PATTERN = /\[\/GA_TASK\]/

type NormalizedDispatchText = {
  text: string
}

function normalizeDispatchText(buffer: string): NormalizedDispatchText {
  const stripped = buffer.replace(ANSI_CONTROL_PATTERN, '')
  let text = ''
  let currentLine = ''

  for (let index = 0; index < stripped.length; index += 1) {
    const char = stripped[index]
    if (char === '\r') {
      if (stripped[index + 1] === '\n') {
        text += `${currentLine}\n`
        currentLine = ''
        index += 1
      } else {
        if (currentLine.includes('[GA_TASK:generic-agent]') && currentLine.includes('[/GA_TASK]')) {
          text += `${currentLine}\n`
        }
        currentLine = ''
      }
    } else if (char === '\n') {
      text += `${currentLine}\n`
      currentLine = ''
    } else {
      currentLine += char
    }
  }

  return { text: text + currentLine }
}

function getStartMatch(line: string): RegExpMatchArray | null {
  const match = line.match(TASK_START_PATTERN)
  if (!match) return null
  const prefix = match.groups?.prefix ?? ''
  if (prefix.trim() === '' && prefix.length > 0) return null
  return match
}

function extractTaskBlocks(buffer: string): { tasks: string[]; remaining: string } {
  const { text } = normalizeDispatchText(buffer)
  const lines = text.split('\n')
  const completeLineCount = lines.length
  const tasks: string[] = []
  let blockLines: string[] | undefined
  let pendingStartLineIndex = -1
  let consumedLineCount = 0

  for (let lineIndex = 0; lineIndex < completeLineCount; lineIndex += 1) {
    const line = lines[lineIndex]

    if (!blockLines) {
      const startMatch = getStartMatch(line)
      if (!startMatch) {
        consumedLineCount = lineIndex + 1
        continue
      }

      pendingStartLineIndex = lineIndex
      const afterStart = line.slice(startMatch[0].length)
      const endMatch = afterStart.match(TASK_END_PATTERN)
      if (endMatch?.index !== undefined) {
        const task = afterStart.slice(0, endMatch.index).trim()
        if (task && task.length <= MAX_TASK_LENGTH) tasks.push(task)
        consumedLineCount = lineIndex + 1
        pendingStartLineIndex = -1
      } else {
        blockLines = [afterStart]
      }
      continue
    }

    const endMatch = line.match(TASK_END_PATTERN)
    if (endMatch?.index !== undefined) {
      blockLines.push(line.slice(0, endMatch.index))
      const task = blockLines.join('\n').trim()
      if (task && task.length <= MAX_TASK_LENGTH) tasks.push(task)
      blockLines = undefined
      pendingStartLineIndex = -1
      consumedLineCount = lineIndex + 1
    } else {
      blockLines.push(line)
    }
  }

  if (blockLines && pendingStartLineIndex !== -1) {
    const remaining = lines.slice(pendingStartLineIndex).join('\n')
    return { tasks, remaining: remaining.slice(-MAX_BUFFER_LENGTH) }
  }

  const remaining = lines.slice(consumedLineCount).join('\n')
  return { tasks, remaining: remaining.slice(-MAX_BUFFER_LENGTH) }
}

type UseGenericAgentDispatchInput = {
  state: AppState
  dispatch: Dispatch<AppAction>
  terminalSizeRef: MutableRefObject<{ cols: number; rows: number }>
}

export function useGenericAgentDispatch(input: UseGenericAgentDispatchInput) {
  const stateRef = useRef(input.state)
  const buffersRef = useRef(new Map<string, string>())
  const triggeredRef = useRef(new Set<string>())
  const inFlightRef = useRef(new Set<string>())

  stateRef.current = input.state

  useEffect(() => {
    const dispose = window.workerDesk.onSessionOutput((event) => {
      const state = stateRef.current
      const parentSession = state.sessions.find((session) => session.id === event.sessionId)
      if (!parentSession || parentSession.workerType !== 'claude-code') return

      const project = state.projects.find((item) => item.id === parentSession.projectId)
      if (!project?.autoDispatchGenericAgent) return

      const currentBuffer = `${buffersRef.current.get(parentSession.id) ?? ''}${event.chunk}`
      const { tasks, remaining } = extractTaskBlocks(currentBuffer)
      buffersRef.current.set(parentSession.id, remaining)

      for (const task of tasks) {
        const taskKey = `${parentSession.id}:${task}`
        if (triggeredRef.current.has(taskKey) || inFlightRef.current.has(taskKey)) continue

        if (!project.genericAgentConfigId) {
          input.dispatch({ type: 'setError', error: 'Claude Code 请求分派 GenericAgent，但当前 Project 未选择 GA 启动器' })
          triggeredRef.current.add(taskKey)
          continue
        }
        if (!state.selectedProviderProfileId) {
          input.dispatch({ type: 'setError', error: 'Claude Code 请求分派 GenericAgent，但需要先选择模型连接' })
          triggeredRef.current.add(taskKey)
          continue
        }

        inFlightRef.current.add(taskKey)
        void window.workerDesk.startSession({
          projectId: parentSession.projectId,
          workerType: 'generic-agent',
          parentSessionId: parentSession.id,
          dispatchMode: 'auto',
          dispatchTask: task,
          genericAgentConfigId: project.genericAgentConfigId,
          initialPrompt: task,
          providerProfileId: state.selectedProviderProfileId,
          providerModelId: state.selectedProviderModelId,
          terminalSize: input.terminalSizeRef.current
        }).then((session) => {
          triggeredRef.current.add(taskKey)
          input.dispatch({ type: 'upsertSession', session })
          input.dispatch({ type: 'setError', error: undefined })
        }).catch((error) => {
          input.dispatch({ type: 'setError', error: getDisplayErrorMessage(error) })
        }).finally(() => {
          inFlightRef.current.delete(taskKey)
        })
      }
    })

    return () => dispose()
  }, [input.dispatch, input.terminalSizeRef])
}
