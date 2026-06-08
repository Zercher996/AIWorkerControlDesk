import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { mkdir, readFile, stat, truncate } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SessionAiEvent, SessionAiEventsReadResult } from '../../src/types/workerDesk'

const DEFAULT_READ_LIMIT = 500

export type AiEventsReadOptions = {
  offset?: number
  limit?: number
}

export async function appendSessionAiEventLine(filePath: string, event: SessionAiEvent): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const fd = openSync(filePath, 'a')
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`, undefined, 'utf-8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export async function repairSessionAiEventsJsonlTail(filePath: string): Promise<void> {
  let raw: Buffer
  try {
    raw = await readFile(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return
    throw error
  }

  if (raw.length === 0 || raw[raw.length - 1] === 0x0a) return

  const lastNewline = raw.lastIndexOf(0x0a)
  await truncate(filePath, lastNewline === -1 ? 0 : lastNewline + 1)
}

export async function readSessionAiEventLines(
  filePath: string,
  options: AiEventsReadOptions = {}
): Promise<SessionAiEventsReadResult> {
  const offset = options.offset ?? 0
  const limit = options.limit ?? DEFAULT_READ_LIMIT
  const [raw, totalBytes] = await Promise.all([readExistingText(filePath), getFileSize(filePath)])
  const parsed = parseLines(raw)
  const events = parsed.slice(offset, offset + limit)
  const nextOffset = offset + events.length < parsed.length ? offset + events.length : undefined
  return { events, nextOffset, totalBytes }
}

export function aiEventsToPlainText(events: SessionAiEvent[]): string {
  return events.flatMap((event) => {
    switch (event.type) {
      case 'user_message':
        return [`\n> 用户：${event.text}\n`]
      case 'assistant_text':
        return [event.text]
      case 'tool_use':
        return [`\n[工具调用] ${event.name}\n`]
      case 'tool_result':
        return event.content ? [`[工具结果] ${event.content}\n`] : ['[工具结果]\n']
      case 'result':
        return event.errorMessage ? [`\n[完成：错误] ${event.errorMessage}\n`] : ['\n[完成]\n']
      case 'diagnostic':
        return [`\n[诊断:${event.level}] ${event.message}\n`]
      case 'system':
        return []
    }
  }).join('')
}

function parseLines(raw: string): SessionAiEvent[] {
  return raw.split('\n').flatMap((line) => {
    if (line.length === 0) return []
    try {
      return [JSON.parse(line) as SessionAiEvent]
    } catch {
      return []
    }
  })
}

async function readExistingText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return ''
    throw error
  }
}

async function getFileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return 0
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
