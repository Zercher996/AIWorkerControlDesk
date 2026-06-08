import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionOutputEvent } from '../../src/types/workerDesk'
import { appendOutputLine, readOutputLines, repairOutputJsonlTail, searchOutputLines, toPlainText } from './outputJsonl'

const event = (chunk: string, timestamp = '2026-05-11T00:00:00.000Z'): SessionOutputEvent => ({
  sessionId: 'session-1',
  chunk,
  stream: 'stdout',
  timestamp
})

describe('outputJsonl', () => {
  it('appends output as newline-delimited JSON and reads it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-output-'))
    const filePath = join(dir, 'output.jsonl')
    try {
      await appendOutputLine(filePath, event('hello'))
      await appendOutputLine(filePath, event('world'))
      await expect(readOutputLines(filePath, { offset: 0, limit: 10 })).resolves.toMatchObject({
        chunks: [event('hello'), event('world')],
        nextOffset: undefined
      })
      await expect(readFile(filePath, 'utf-8')).resolves.toMatch(/\n$/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns nextOffset when output has more chunks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-output-'))
    const filePath = join(dir, 'output.jsonl')
    try {
      await appendOutputLine(filePath, event('first'))
      await appendOutputLine(filePath, event('second'))
      await expect(readOutputLines(filePath, { offset: 0, limit: 1 })).resolves.toMatchObject({
        chunks: [event('first')],
        nextOffset: 1
      })
      await expect(readOutputLines(filePath, { offset: 1, limit: 1 })).resolves.toMatchObject({
        chunks: [event('second')],
        nextOffset: undefined
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('truncates an incomplete tail line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-output-'))
    const filePath = join(dir, 'output.jsonl')
    try {
      await writeFile(filePath, `${JSON.stringify(event('ok'))}\n{"sessionId":`, 'utf-8')
      await repairOutputJsonlTail(filePath)
      await expect(readOutputLines(filePath, { offset: 0, limit: 10 })).resolves.toMatchObject({
        chunks: [event('ok')]
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('truncates a file without a complete line to empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-output-'))
    const filePath = join(dir, 'output.jsonl')
    try {
      await writeFile(filePath, '{"sessionId":"session-1"', 'utf-8')
      await repairOutputJsonlTail(filePath)
      await expect(readFile(filePath, 'utf-8')).resolves.toBe('')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips bad middle lines while reading and searching', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-output-'))
    const filePath = join(dir, 'output.jsonl')
    try {
      await writeFile(filePath, [
        JSON.stringify(event('alpha')),
        '{bad json}',
        JSON.stringify(event('needle beta')),
        ''
      ].join('\n'), 'utf-8')
      await expect(readOutputLines(filePath, { offset: 0, limit: 10 })).resolves.toMatchObject({
        chunks: [event('alpha'), event('needle beta')]
      })
      await expect(searchOutputLines(filePath, 'NEEDLE')).resolves.toEqual([
        { line: event('needle beta'), excerpt: 'needle beta' }
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns empty results for missing files and empty search queries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-output-'))
    const filePath = join(dir, 'missing.jsonl')
    try {
      await expect(readOutputLines(filePath)).resolves.toEqual({ chunks: [], nextOffset: undefined, totalBytes: 0 })
      await expect(searchOutputLines(filePath, 'anything')).resolves.toEqual([])
      await expect(searchOutputLines(filePath, '')).resolves.toEqual([])
      await expect(repairOutputJsonlTail(filePath)).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('converts chunks to plain text', async () => {
    expect(toPlainText([event('a'), event('b')])).toBe('ab')
  })
})
