import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionAiEvent } from '../../src/types/workerDesk'
import { findClaudeProjectDir } from './cliHistory'
import { mapClaudeCliJsonlRecord } from './claudeCliJsonlEvents'

const DEFAULT_POLL_INTERVAL_MS = 300
const ACTIVE_FILE_MATCH_SLACK_MS = 2000

export type ClaudeCliJsonlTailStats = {
  filePath?: string
  totalBytesRead: number
  parsedLineCount: number
  mappedEventCount: number
  unsupportedCount: number
  parseErrorCount: number
  firstEventAt?: string
  lastEventAt?: string
}

export type ManagedClaudeCliJsonlTail = {
  pollNow(): Promise<void>
  getStats(): ClaudeCliJsonlTailStats
  stop(): void
}

export type ClaudeCliJsonlFileClaim = {
  deskSessionId: string
  filePath: string
  fileCreatedAtMs?: number
  cliSessionId?: string
}

export type ClaudeCliJsonlTailInput = {
  deskSessionId: string
  workspacePath: string
  createdAtMs: number
  claudeProjectsBaseDir?: string
  ignoredCliJsonlFilePaths?: string[]
  pollIntervalMs?: number
  claimCliJsonlFile?(claim: ClaudeCliJsonlFileClaim): boolean
  onCliSessionMatched?(cliSessionId: string, filePath: string): void
  onEvent(event: SessionAiEvent): void
  onDiagnostic?(message: string): void
}

type TailState = {
  filePath?: string
  offset: number
  partialLine: string
  lineIndex: number
  matchedCliSessionId?: string
  stopped: boolean
  polling: boolean
  timer?: ReturnType<typeof setInterval>
}

export function startClaudeCliJsonlTail(input: ClaudeCliJsonlTailInput): ManagedClaudeCliJsonlTail {
  const state: TailState = {
    offset: 0,
    partialLine: '',
    lineIndex: 0,
    stopped: false,
    polling: false
  }
  const stats: ClaudeCliJsonlTailStats = {
    totalBytesRead: 0,
    parsedLineCount: 0,
    mappedEventCount: 0,
    unsupportedCount: 0,
    parseErrorCount: 0
  }

  async function pollNow(): Promise<void> {
    if (state.stopped || state.polling) return
    state.polling = true
    try {
      if (!state.filePath) {
        state.filePath = await findActiveCliJsonlFile(input)
        if (state.filePath) {
          stats.filePath = state.filePath
        }
      }
      if (!state.filePath) return
      await readNewLines({ input, state, stats })
    } catch (error) {
      input.onDiagnostic?.(error instanceof Error ? error.message : String(error))
    } finally {
      state.polling = false
    }
  }

  const interval = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  if (interval > 0) {
    state.timer = setInterval(() => {
      void pollNow()
    }, interval)
    void pollNow()
  }

  return {
    pollNow,
    getStats: () => ({ ...stats }),
    stop: () => {
      state.stopped = true
      if (state.timer) clearInterval(state.timer)
    }
  }
}

async function findActiveCliJsonlFile(input: ClaudeCliJsonlTailInput): Promise<string | undefined> {
  const baseDir = input.claudeProjectsBaseDir ?? join(getHomeDir(), '.claude', 'projects')
  const projectDir = await findClaudeProjectDir(baseDir, input.workspacePath)
  if (!projectDir) return undefined

  let entries: string[]
  try {
    entries = await readdir(projectDir)
  } catch {
    return undefined
  }

  const ignoredFilePaths = new Set((input.ignoredCliJsonlFilePaths ?? []).map(normalizePath))
  const candidates: Array<{ filePath: string; createdAtMs: number; mtimeMs: number; size: number; cliSessionId?: string }> = []
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl') || entry.startsWith('agent-')) continue
    const filePath = join(projectDir, entry)
    if (ignoredFilePaths.has(normalizePath(filePath))) continue
    try {
      const value = await stat(filePath)
      if (!value.isFile() || value.size <= 0) continue
      const fileCreatedAtMs = Number.isFinite(value.birthtimeMs) ? value.birthtimeMs : value.ctimeMs
      if (fileCreatedAtMs < input.createdAtMs - ACTIVE_FILE_MATCH_SLACK_MS) continue
      if (value.mtimeMs < input.createdAtMs - ACTIVE_FILE_MATCH_SLACK_MS) continue
      if (!await fileHasWorkspaceCwd(filePath, input.workspacePath)) continue
      candidates.push({
        filePath,
        createdAtMs: fileCreatedAtMs,
        mtimeMs: value.mtimeMs,
        size: value.size,
        cliSessionId: await readCliSessionId(filePath)
      })
    } catch {
      continue
    }
  }

  candidates.sort((a, b) => {
    const createdDistance = Math.abs(a.createdAtMs - input.createdAtMs) - Math.abs(b.createdAtMs - input.createdAtMs)
    if (createdDistance !== 0) return createdDistance
    return b.mtimeMs - a.mtimeMs || b.size - a.size
  })
  for (const candidate of candidates) {
    if (input.claimCliJsonlFile && !input.claimCliJsonlFile({
      deskSessionId: input.deskSessionId,
      filePath: candidate.filePath,
      fileCreatedAtMs: candidate.createdAtMs,
      cliSessionId: candidate.cliSessionId
    })) continue
    return candidate.filePath
  }
  return undefined
}

async function fileHasWorkspaceCwd(filePath: string, workspacePath: string): Promise<boolean> {
  const stream = createReadStream(filePath, { encoding: 'utf-8', start: 0, end: 64 * 1024 - 1 })
  let raw = ''
  try {
    for await (const chunk of stream) {
      raw += chunk
      if (raw.length > 64 * 1024) break
    }
  } catch {
    return false
  } finally {
    stream.destroy()
  }

  const normalizedWorkspace = normalizePath(workspacePath)
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as Record<string, unknown>
      if (typeof record.cwd === 'string' && normalizePath(record.cwd) === normalizedWorkspace) return true
    } catch {
      continue
    }
  }
  return false
}

async function readCliSessionId(filePath: string): Promise<string | undefined> {
  const stream = createReadStream(filePath, { encoding: 'utf-8', start: 0, end: 64 * 1024 - 1 })
  let raw = ''
  try {
    for await (const chunk of stream) {
      raw += chunk
      if (raw.length > 64 * 1024) break
    }
  } catch {
    return undefined
  } finally {
    stream.destroy()
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as Record<string, unknown>
      const cliSessionId = firstString(record.sessionId, record.session_id)
      if (cliSessionId) return cliSessionId
    } catch {
      continue
    }
  }
  return undefined
}

async function readNewLines(inputValue: {
  input: ClaudeCliJsonlTailInput
  state: TailState
  stats: ClaudeCliJsonlTailStats
}): Promise<void> {
  const { input, state, stats } = inputValue
  const filePath = state.filePath
  if (!filePath) return

  const fileStat = await stat(filePath)
  if (fileStat.size < state.offset) {
    input.onDiagnostic?.(`Claude Code jsonl file shrank while tailing: ${filePath}`)
    state.filePath = undefined
    state.offset = 0
    state.partialLine = ''
    state.lineIndex = 0
    return
  }
  if (fileStat.size === state.offset) return

  const startOffset = state.offset
  const newText = await readRange(filePath, startOffset, fileStat.size - 1)
  state.offset = fileStat.size
  stats.totalBytesRead += Buffer.byteLength(newText, 'utf-8')

  const previousPartialBytes = Buffer.byteLength(state.partialLine, 'utf-8')
  const combined = `${state.partialLine}${newText}`
  const hasCompleteTail = combined.endsWith('\n') || combined.endsWith('\r')
  const splitLines = combined.split(/\r?\n/)
  state.partialLine = hasCompleteTail ? '' : splitLines.pop() ?? ''
  const completeLines = hasCompleteTail ? splitLines.slice(0, -1) : splitLines

  let lineOffset = startOffset - previousPartialBytes
  for (const rawLine of completeLines) {
    const currentLineOffset = lineOffset
    lineOffset += Buffer.byteLength(rawLine, 'utf-8') + 1
    if (!rawLine.trim()) {
      state.lineIndex += 1
      continue
    }

    let record: Record<string, unknown>
    try {
      record = JSON.parse(rawLine.trim()) as Record<string, unknown>
      stats.parsedLineCount += 1
    } catch {
      stats.parseErrorCount += 1
      state.lineIndex += 1
      continue
    }

    const events = mapClaudeCliJsonlRecord({
      deskSessionId: input.deskSessionId,
      sourceId: filePath,
      lineOffset: currentLineOffset,
      lineIndex: state.lineIndex
    }, record)
    if (events.length === 0) stats.unsupportedCount += 1

    const cliSessionId = firstString(record.sessionId, record.session_id)
    if (cliSessionId && cliSessionId !== state.matchedCliSessionId) {
      state.matchedCliSessionId = cliSessionId
      input.onCliSessionMatched?.(cliSessionId, filePath)
    }

    for (const event of events) {
      stats.mappedEventCount += 1
      stats.firstEventAt ??= event.timestamp
      stats.lastEventAt = event.timestamp
      input.onEvent(event)
    }
    state.lineIndex += 1
  }
}

async function readRange(filePath: string, start: number, end: number): Promise<string> {
  const stream = createReadStream(filePath, { encoding: 'utf-8', start, end })
  let text = ''
  try {
    for await (const chunk of stream) {
      text += chunk
    }
  } finally {
    stream.destroy()
  }
  return text
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase()
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function getHomeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || ''
}
