import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { SessionAiEvent, SessionAiPermissionDenial } from '../../src/types/workerDesk'

export type ClaudeCliJsonlMapContext = {
  deskSessionId: string
  sourceId?: string
  lineOffset?: number
  lineIndex?: number
}

export type ClaudeCliJsonlReadResult = {
  events: SessionAiEvent[]
  totalBytes: number
  unsupportedCount: number
}

export async function readClaudeCliJsonlAsAiEvents(filePath: string, sessionId: string): Promise<ClaudeCliJsonlReadResult> {
  const totalBytes = await stat(filePath).then((value) => value.size).catch(() => 0)
  const events: SessionAiEvent[] = []
  let unsupportedCount = 0
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity })
  let lineIndex = 0

  try {
    for await (const rawLine of rl) {
      const currentLineIndex = lineIndex
      lineIndex += 1
      const line = rawLine.trim()
      if (!line) continue
      let record: Record<string, unknown>
      try {
        record = JSON.parse(line) as Record<string, unknown>
      } catch {
        unsupportedCount += 1
        continue
      }
      const mapped = mapClaudeCliJsonlRecord({ deskSessionId: sessionId, sourceId: filePath, lineIndex: currentLineIndex }, record)
      if (mapped.length === 0) unsupportedCount += 1
      events.push(...mapped)
    }
  } finally {
    rl.close()
    fileStream.destroy()
  }

  return { events, totalBytes, unsupportedCount }
}

export function mapClaudeCliJsonlRecord(context: ClaudeCliJsonlMapContext | string, record: Record<string, unknown>): SessionAiEvent[] {
  const mapContext = normalizeMapContext(context)
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString()
  if (record.type === 'system') {
    const subtype = typeof record.subtype === 'string' ? record.subtype : undefined
    const cliSessionId = firstString(record.sessionId, record.session_id)
    if (subtype === 'api_error') {
      return withStableEventIds(mapContext, [baseEvent(mapContext.deskSessionId, timestamp, record, {
        type: 'diagnostic',
        level: record.level === 'error' ? 'error' : 'warning',
        stream: 'lifecycle',
        message: formatSystemApiError(record)
      })])
    }
    if (!subtype && !cliSessionId) return []
    return withStableEventIds(mapContext, [baseEvent(mapContext.deskSessionId, timestamp, record, {
      type: 'system',
      subtype,
      cliSessionId
    })])
  }

  if (record.type === 'assistant') {
    const message = objectRecord(record.message)
    if (!message) return []
    const events = mapAssistantMessage(mapContext.deskSessionId, timestamp, record, message)
    if (message.stop_reason === 'end_turn') {
      events.push(baseEvent(mapContext.deskSessionId, timestamp, record, {
        type: 'turn_end',
        reason: 'end_turn',
        cliSessionId: firstString(record.sessionId, record.session_id)
      }))
    }
    return withStableEventIds(mapContext, events)
  }

  if (record.type === 'user') {
    const message = objectRecord(record.message)
    if (!message) return []
    const content = message.content
    const toolResults = mapUserToolResults(mapContext.deskSessionId, timestamp, record, content, record.toolUseResult ?? record.tool_use_result)
    if (toolResults.length > 0) return withStableEventIds(mapContext, toolResults)
    if (record.isMeta === true) return []
    const text = extractTextFromContent(content)
    return text ? withStableEventIds(mapContext, [baseEvent(mapContext.deskSessionId, timestamp, record, { type: 'user_message', text })]) : []
  }

  if (record.type === 'result') {
    const isError = record.is_error === true || typeof record.error === 'string' || record.subtype === 'error_max_budget_usd'
    return withStableEventIds(mapContext, [baseEvent(mapContext.deskSessionId, timestamp, record, {
      type: 'result',
      status: isError ? 'error' : 'success',
      text: firstString(record.result),
      usage: record.usage,
      cliSessionId: firstString(record.sessionId, record.session_id),
      errorMessage: extractResultError(record),
      permissionDenials: extractPermissionDenials(record.permission_denials ?? record.permissionDenials)
    })])
  }

  return []
}

function mapAssistantMessage(sessionId: string, timestamp: string, raw: Record<string, unknown>, message: Record<string, unknown>): SessionAiEvent[] {
  const messageId = firstString(message.id, raw.uuid)
  const content = message.content
  if (typeof content === 'string') {
    return content ? [baseEvent(sessionId, timestamp, raw, { type: 'assistant_text', text: content, messageId })] : []
  }
  if (!Array.isArray(content)) return []
  const events: SessionAiEvent[] = []
  for (const block of content) {
    const item = objectRecord(block)
    if (!item) continue
    if (item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
      events.push(baseEvent(sessionId, timestamp, raw, { type: 'assistant_text', text: item.text, messageId }))
      continue
    }
    if (item.type === 'tool_use') {
      events.push(baseEvent(sessionId, timestamp, raw, {
        type: 'tool_use',
        toolUseId: firstString(item.id),
        name: firstString(item.name) ?? 'unknown',
        input: item.input
      }))
    }
  }
  return events
}

function mapUserToolResults(sessionId: string, timestamp: string, raw: Record<string, unknown>, content: unknown, toolUseResult: unknown): SessionAiEvent[] {
  if (!Array.isArray(content)) return []
  const events: SessionAiEvent[] = []
  for (const block of content) {
    const item = objectRecord(block)
    if (!item || item.type !== 'tool_result') continue
    const isError = item.is_error === true
    events.push(baseEvent(sessionId, timestamp, raw, {
      type: 'tool_result',
      toolUseId: firstString(item.tool_use_id, item.toolUseId),
      content: extractToolResultText(item.content, toolUseResult),
      isError,
      errorKind: detectToolResultErrorKind(isError, item.content, toolUseResult)
    }))
  }
  return events
}

function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined
  if (!Array.isArray(content)) return undefined
  const text = content.flatMap((block) => {
    const item = objectRecord(block)
    if (!item || item.type !== 'text') return []
    return typeof item.text === 'string' ? [item.text] : []
  }).join('\n\n').trim()
  return text || undefined
}

function extractToolResultText(content: unknown, toolUseResult: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content.flatMap((item) => {
      const block = objectRecord(item)
      if (!block) return []
      return typeof block.text === 'string' ? [block.text] : []
    }).join('\n')
    if (text) return text
  }
  const result = objectRecord(toolUseResult)
  if (!result) return undefined
  if (typeof result.content === 'string') return result.content
  const file = objectRecord(result.file)
  if (file && typeof file.content === 'string') return file.content
  return undefined
}

function detectToolResultErrorKind(isError: boolean, content: unknown, toolUseResult: unknown): 'permission_denied' | 'tool_error' | undefined {
  if (!isError) return undefined
  const text = extractToolResultText(content, toolUseResult)
  if (!text) return 'tool_error'
  if (/requested permissions|haven't granted|permission|权限/i.test(text)) return 'permission_denied'
  return 'tool_error'
}

function extractPermissionDenials(value: unknown): SessionAiPermissionDenial[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const denials = value.flatMap((item) => {
    const record = objectRecord(item)
    if (!record) return []
    return [{
      toolName: firstString(record.tool_name, record.toolName),
      toolUseId: firstString(record.tool_use_id, record.toolUseId),
      toolInput: record.tool_input ?? record.toolInput
    }]
  })
  return denials.length > 0 ? denials : undefined
}

function extractResultError(record: Record<string, unknown>): string | undefined {
  if (Array.isArray(record.errors) && record.errors.length > 0) return record.errors.map(String).join('\n')
  if (typeof record.error === 'string') return record.error
  if (record.subtype === 'error_max_budget_usd') return 'Reached maximum budget'
  return undefined
}

function formatSystemApiError(record: Record<string, unknown>): string {
  const error = objectRecord(record.error)
  const status = typeof error?.status === 'number' ? `HTTP ${error.status}` : firstString(error?.type, record.level) ?? 'unknown error'
  const retryAttempt = typeof record.retryAttempt === 'number' ? record.retryAttempt : undefined
  const maxRetries = typeof record.maxRetries === 'number' ? record.maxRetries : undefined
  const retryInMs = typeof record.retryInMs === 'number' ? record.retryInMs : undefined
  const retryText = retryAttempt !== undefined && maxRetries !== undefined
    ? `; retry ${retryAttempt}/${maxRetries}${retryInMs !== undefined ? ` after ${retryInMs}ms` : ''}`
    : ''
  return `Claude Code API error: ${status}${retryText}`
}

function baseEvent<T extends Omit<SessionAiEvent, 'id' | 'sessionId' | 'timestamp' | 'source'>>(
  sessionId: string,
  timestamp: string,
  raw: unknown,
  event: T
): SessionAiEvent {
  return {
    id: fallbackEventId(sessionId, timestamp, raw, event),
    sessionId,
    timestamp,
    source: 'claude-code-jsonl',
    raw,
    ...event
  } as SessionAiEvent
}

function normalizeMapContext(context: ClaudeCliJsonlMapContext | string): ClaudeCliJsonlMapContext {
  return typeof context === 'string' ? { deskSessionId: context } : context
}

function withStableEventIds(context: ClaudeCliJsonlMapContext, events: SessionAiEvent[]): SessionAiEvent[] {
  const lineKey = eventLineKey(context)
  if (!lineKey) return events
  return events.map((event, index) => ({
    ...event,
    id: `claude-jsonl:${context.deskSessionId}:${lineKey}:${index}`
  } as SessionAiEvent))
}

function eventLineKey(context: ClaudeCliJsonlMapContext): string | undefined {
  const sourceId = context.sourceId ? sanitizeEventIdPart(context.sourceId) : undefined
  if (context.lineOffset != null) return `${sourceId ?? 'source'}:offset-${context.lineOffset}`
  if (context.lineIndex != null) return `${sourceId ?? 'source'}:line-${context.lineIndex}`
  return undefined
}

function fallbackEventId(sessionId: string, timestamp: string, raw: unknown, event: unknown): string {
  const record = objectRecord(raw)
  const rawId = firstString(record?.uuid, record?.sessionId, record?.session_id)
  const eventRecord = objectRecord(event)
  const eventKey = firstString(eventRecord?.type, eventRecord?.toolUseId, eventRecord?.name)
  return `claude-jsonl:${sessionId}:${sanitizeEventIdPart(rawId ?? timestamp)}:${sanitizeEventIdPart(eventKey ?? 'event')}`
}

function sanitizeEventIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]+/g, '-')
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}
