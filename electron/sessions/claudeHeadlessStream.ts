import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { SessionAiEvent } from '../../src/types/workerDesk'
import { buildClaudeProcessEnv } from './claudePty'
import type { ClaudeCodeLaunchConfig } from '../providers/claudeCodeProviderAdapter'

export type ManagedHeadlessProcess = {
  pid?: number
  sendUserMessage(text: string): void
  kill(): void
}

export type HeadlessLaunchInput = {
  cwd: string
  launchConfig: ClaudeCodeLaunchConfig
  onEvent(event: SessionAiEvent): void
  onExit(event: { exitCode: number; signal?: NodeJS.Signals }): void
  sessionId: string
}

type StreamLike = {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
}

type WritableLike = {
  write(chunk: string): unknown
}

type SpawnProcess = {
  pid?: number
  stdin: WritableLike
  stdout: StreamLike
  stderr: StreamLike
  kill(): unknown
  on(event: 'exit', listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): unknown
}
type SpawnFn = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => SpawnProcess

export function buildClaudeHeadlessCommand(command: ClaudeCodeLaunchConfig['command']): { file: string; args: string[] } {
  return {
    file: command.file,
    args: [
      ...command.args,
      '--bare',
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose'
    ]
  }
}

export function createStreamJsonLineParser(input: {
  sessionId: string
  onEvent(event: SessionAiEvent): void
}) {
  let buffer = ''

  function processLine(rawLine: string): void {
    const line = rawLine.trim()
    if (!line) return
    try {
      emitMappedEvents(input.sessionId, JSON.parse(line), input.onEvent)
    } catch (error) {
      input.onEvent(createDiagnosticEvent(input.sessionId, {
        level: 'warning',
        message: `Unable to parse Claude stream-json line: ${error instanceof Error ? error.message : String(error)}`,
        stream: 'parser',
        raw: line
      }))
    }
  }

  return {
    push(chunk: string): void {
      buffer += chunk
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        processLine(line)
        newlineIndex = buffer.indexOf('\n')
      }
    },
    flush(): void {
      if (!buffer.trim()) {
        buffer = ''
        return
      }
      processLine(buffer)
      buffer = ''
    }
  }
}

export function startClaudeHeadlessStream(input: HeadlessLaunchInput, spawnFn: SpawnFn = spawn): ManagedHeadlessProcess {
  const command = buildClaudeHeadlessCommand(input.launchConfig.command)
  const child = spawnFn(command.file, command.args, {
    cwd: input.cwd,
    env: buildClaudeProcessEnv({ baseEnv: process.env, launchEnv: input.launchConfig.env })
  })
  const parser = createStreamJsonLineParser({ sessionId: input.sessionId, onEvent: input.onEvent })

  child.stdout.on('data', (chunk: Buffer | string) => {
    parser.push(chunk.toString())
  })
  child.stderr.on('data', (chunk: Buffer | string) => {
    const text = chunk.toString()
    if (!text.trim()) return
    input.onEvent(createDiagnosticEvent(input.sessionId, {
      level: 'warning',
      message: text,
      stream: 'stderr'
    }))
  })
  child.on('exit', (exitCode, signal) => {
    parser.flush()
    input.onExit({ exitCode: exitCode ?? 0, signal: signal ?? undefined })
  })

  return {
    pid: child.pid,
    sendUserMessage(text: string): void {
      const trimmed = text.trim()
      if (!trimmed) return
      const message = {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: trimmed }]
        }
      }
      child.stdin.write(`${JSON.stringify(message)}\n`)
    },
    kill(): void {
      child.kill()
    }
  }
}

export function emitMappedEvents(
  sessionId: string,
  raw: unknown,
  emit: (event: SessionAiEvent) => void
): void {
  if (!raw || typeof raw !== 'object') {
    emit(createDiagnosticEvent(sessionId, {
      level: 'warning',
      message: 'Claude stream-json event is not an object',
      stream: 'parser',
      raw
    }))
    return
  }

  const record = raw as Record<string, unknown>
  if (record.type === 'system') {
    const cliSessionId = typeof record.session_id === 'string' ? record.session_id : undefined
    emit(createBaseEvent(sessionId, {
      type: 'system',
      subtype: typeof record.subtype === 'string' ? record.subtype : undefined,
      cliSessionId,
      raw
    }))
    return
  }

  if (record.type === 'stream_event') {
    const event = record.event
    if (event && typeof event === 'object') {
      const streamEvent = event as Record<string, unknown>
      if (streamEvent.type === 'content_block_delta') {
        const delta = streamEvent.delta
        if (delta && typeof delta === 'object') {
          const text = (delta as Record<string, unknown>).text
          if (typeof text === 'string' && text.length > 0) {
            emit(createBaseEvent(sessionId, {
              type: 'assistant_text',
              text,
              raw
            }))
          }
        }
      }
    }
    return
  }

  if (record.type === 'assistant') {
    const message = record.message
    if (message && typeof message === 'object') {
      const messageRecord = message as Record<string, unknown>
      const messageId = typeof messageRecord.id === 'string' ? messageRecord.id : undefined
      emitMessageContent(sessionId, messageRecord.content, raw, emit, messageId)
    }
    return
  }

  if (record.type === 'user') {
    const message = record.message
    if (message && typeof message === 'object') {
      const content = (message as Record<string, unknown>).content
      emitToolResultContent(sessionId, content, raw, record.tool_use_result, emit)
    }
    return
  }

  if (record.type === 'result') {
    const isError = record.is_error === true || typeof record.error === 'string' || record.subtype === 'error_max_budget_usd'
    emit(createBaseEvent(sessionId, {
      type: 'result',
      status: isError ? 'error' : 'success',
      text: typeof record.result === 'string' ? record.result : undefined,
      usage: record.usage,
      cliSessionId: typeof record.session_id === 'string' ? record.session_id : undefined,
      errorMessage: extractResultError(record),
      permissionDenials: extractPermissionDenials(record.permission_denials),
      raw
    }))
    return
  }

  emit(createDiagnosticEvent(sessionId, {
    level: 'info',
    message: `Unhandled Claude stream-json event type: ${String(record.type)}`,
    stream: 'parser',
    raw
  }))
}

function emitMessageContent(
  sessionId: string,
  content: unknown,
  raw: unknown,
  emit: (event: SessionAiEvent) => void,
  messageId?: string
): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const blockRecord = block as Record<string, unknown>
    if (blockRecord.type === 'text' && typeof blockRecord.text === 'string') {
      emit(createBaseEvent(sessionId, {
        type: 'assistant_text',
        text: blockRecord.text,
        messageId,
        raw
      }))
    }
    if (blockRecord.type === 'tool_use') {
      emit(createBaseEvent(sessionId, {
        type: 'tool_use',
        toolUseId: typeof blockRecord.id === 'string' ? blockRecord.id : undefined,
        name: typeof blockRecord.name === 'string' ? blockRecord.name : 'unknown',
        input: blockRecord.input,
        raw
      }))
    }
  }
}

function emitToolResultContent(
  sessionId: string,
  content: unknown,
  raw: unknown,
  toolUseResult: unknown,
  emit: (event: SessionAiEvent) => void
): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const blockRecord = block as Record<string, unknown>
    if (blockRecord.type !== 'tool_result') continue
    const isError = blockRecord.is_error === true
    emit(createBaseEvent(sessionId, {
      type: 'tool_result',
      toolUseId: typeof blockRecord.tool_use_id === 'string' ? blockRecord.tool_use_id : undefined,
      content: extractToolResultText(blockRecord.content, toolUseResult),
      isError,
      errorKind: detectToolResultErrorKind(isError, blockRecord.content, toolUseResult),
      raw
    }))
  }
}

function extractToolResultText(content: unknown, toolUseResult: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const text = (item as Record<string, unknown>).text
      return typeof text === 'string' ? [text] : []
    }).join('\n') || undefined
  }
  if (toolUseResult && typeof toolUseResult === 'object') {
    const resultRecord = toolUseResult as Record<string, unknown>
    if (typeof resultRecord.content === 'string') return resultRecord.content
    const file = resultRecord.file
    if (file && typeof file === 'object') {
      const fileRecord = file as Record<string, unknown>
      if (typeof fileRecord.content === 'string') return fileRecord.content
    }
  }
  return undefined
}

function detectToolResultErrorKind(isError: boolean, content: unknown, toolUseResult: unknown): 'permission_denied' | 'tool_error' | undefined {
  if (!isError) return undefined
  const text = extractToolResultText(content, toolUseResult)
  if (!text) return 'tool_error'
  if (/requested permissions|haven't granted|permission/i.test(text)) return 'permission_denied'
  return 'tool_error'
}

function extractPermissionDenials(value: unknown): Array<{ toolName?: string; toolUseId?: string; toolInput?: unknown }> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    return [{
      toolName: typeof record.tool_name === 'string' ? record.tool_name : undefined,
      toolUseId: typeof record.tool_use_id === 'string' ? record.tool_use_id : undefined,
      toolInput: record.tool_input
    }]
  })
}

function extractResultError(record: Record<string, unknown>): string | undefined {
  const errors = record.errors
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map(String).join('\n')
  }
  if (typeof record.error === 'string') return record.error
  if (record.subtype === 'error_max_budget_usd') return 'Reached maximum budget'
  return undefined
}

function createDiagnosticEvent(
  sessionId: string,
  input: {
    level: 'info' | 'warning' | 'error'
    message: string
    stream?: 'stderr' | 'parser' | 'lifecycle'
    raw?: unknown
  }
): SessionAiEvent {
  return createBaseEvent(sessionId, {
    type: 'diagnostic',
    level: input.level,
    message: input.message,
    stream: input.stream,
    raw: input.raw
  })
}

function createBaseEvent<T extends Omit<SessionAiEvent, 'id' | 'sessionId' | 'timestamp' | 'source'>>(
  sessionId: string,
  event: T
): SessionAiEvent {
  return {
    id: randomUUID(),
    sessionId,
    timestamp: new Date().toISOString(),
    source: 'claude-code-stream-json',
    ...event
  } as SessionAiEvent
}
