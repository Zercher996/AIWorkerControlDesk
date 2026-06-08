import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionAiEvent } from '../../src/types/workerDesk'
import { aiEventsToPlainText, appendSessionAiEventLine, readSessionAiEventLines, repairSessionAiEventsJsonlTail } from './sessionEventsJsonl'

const event = (type: SessionAiEvent['type'], extra: Partial<SessionAiEvent> = {}): SessionAiEvent => ({
  id: `${type}-1`,
  sessionId: 'session-1',
  timestamp: '2026-05-29T00:00:00.000Z',
  source: 'claude-code-stream-json',
  type,
  ...extra
} as SessionAiEvent)

describe('sessionEventsJsonl', () => {
  it('appends and reads AI events as newline-delimited JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-events-'))
    const filePath = join(dir, 'events.jsonl')
    const first = event('user_message', { text: 'hello' })
    const second = event('assistant_text', { text: 'world' })
    try {
      await appendSessionAiEventLine(filePath, first)
      await appendSessionAiEventLine(filePath, second)
      await expect(readSessionAiEventLines(filePath)).resolves.toMatchObject({
        events: [first, second],
        nextOffset: undefined
      })
      await expect(readFile(filePath, 'utf-8')).resolves.toMatch(/\n$/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns nextOffset when events exceed the read limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-events-'))
    const filePath = join(dir, 'events.jsonl')
    const first = event('user_message', { text: 'first' })
    const second = event('assistant_text', { text: 'second' })
    try {
      await appendSessionAiEventLine(filePath, first)
      await appendSessionAiEventLine(filePath, second)
      await expect(readSessionAiEventLines(filePath, { offset: 0, limit: 1 })).resolves.toMatchObject({ events: [first], nextOffset: 1 })
      await expect(readSessionAiEventLines(filePath, { offset: 1, limit: 1 })).resolves.toMatchObject({ events: [second], nextOffset: undefined })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('repairs incomplete tail lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-events-'))
    const filePath = join(dir, 'events.jsonl')
    const ok = event('assistant_text', { text: 'ok' })
    try {
      await writeFile(filePath, `${JSON.stringify(ok)}\n{"id":`, 'utf-8')
      await repairSessionAiEventsJsonlTail(filePath)
      await expect(readSessionAiEventLines(filePath)).resolves.toMatchObject({ events: [ok] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('projects AI events to readable plain text', () => {
    expect(aiEventsToPlainText([
      event('user_message', { text: 'hi' }),
      event('assistant_text', { text: 'hello' }),
      event('tool_use', { name: 'Read' }),
      event('tool_result', { content: 'done' }),
      event('result', { status: 'success' })
    ])).toContain('用户：hi')
  })
})
