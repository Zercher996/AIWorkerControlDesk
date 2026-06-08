import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { mkdir, readFile, stat, truncate } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SessionOutputEvent } from '../../src/types/workerDesk'

const DEFAULT_READ_LIMIT = 500

export type OutputReadOptions = {
  offset?: number
  limit?: number
}

export type OutputReadResult = {
  chunks: SessionOutputEvent[]
  nextOffset?: number
  totalBytes: number
}

export type OutputSearchHit = {
  line: SessionOutputEvent
  excerpt: string
}

export async function appendOutputLine(filePath: string, event: SessionOutputEvent): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const fd = openSync(filePath, 'a')
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`, undefined, 'utf-8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export async function repairOutputJsonlTail(filePath: string): Promise<void> {
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

export async function readOutputLines(filePath: string, options: OutputReadOptions = {}): Promise<OutputReadResult> {
  const offset = options.offset ?? 0
  const limit = options.limit ?? DEFAULT_READ_LIMIT
  const [raw, totalBytes] = await Promise.all([readExistingText(filePath), getFileSize(filePath)])
  const parsed = parseLines(raw)
  const chunks = parsed.slice(offset, offset + limit)
  const nextOffset = offset + chunks.length < parsed.length ? offset + chunks.length : undefined
  return { chunks, nextOffset, totalBytes }
}

export async function searchOutputLines(filePath: string, query: string): Promise<OutputSearchHit[]> {
  const normalizedQuery = query.toLocaleLowerCase()
  if (normalizedQuery.length === 0) return []

  const lines = parseLines(await readExistingText(filePath))
  return lines
    .filter((line) => line.chunk.toLocaleLowerCase().includes(normalizedQuery))
    .map((line) => ({ line, excerpt: buildExcerpt(line.chunk, normalizedQuery) }))
}

export function toPlainText(lines: SessionOutputEvent[]): string {
  return lines.map((line) => line.chunk).join('')
}

function parseLines(raw: string): SessionOutputEvent[] {
  return raw.split('\n').flatMap((line) => {
    if (line.length === 0) return []
    try {
      return [JSON.parse(line) as SessionOutputEvent]
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

function buildExcerpt(chunk: string, normalizedQuery: string): string {
  const normalizedChunk = chunk.toLocaleLowerCase()
  const index = normalizedChunk.indexOf(normalizedQuery)
  if (index === -1) return chunk.slice(0, 160)
  const start = Math.max(0, index - 60)
  return chunk.slice(start, start + 160)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
