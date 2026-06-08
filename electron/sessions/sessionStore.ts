import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  DeskHistoryItem,
  OutputReadInput,
  OutputReadResult,
  SearchSessionResult,
  SearchSessionsInput,
  Session,
  SessionAiEvent,
  SessionAiEventsReadInput,
  SessionAiEventsReadResult,
  SessionOutputEvent
} from '../../src/types/workerDesk'
import { appendOutputLine, readOutputLines, repairOutputJsonlTail, searchOutputLines, toPlainText } from './outputJsonl'
import { aiEventsToPlainText, appendSessionAiEventLine, readSessionAiEventLines, repairSessionAiEventsJsonlTail } from './sessionEventsJsonl'
import { readJsonFile, writeJsonFileAtomic } from '../storage/jsonStore'

const ACTIVE_STATUSES: Session['status'][] = ['starting', 'running', 'waiting']

function sessionDir(rootPath: string, sessionId: string): string {
  return join(rootPath, sessionId)
}

function metaPath(rootPath: string, sessionId: string): string {
  return join(sessionDir(rootPath, sessionId), 'meta.json')
}

function outputPath(rootPath: string, sessionId: string): string {
  return join(sessionDir(rootPath, sessionId), 'output.jsonl')
}

function eventsPath(rootPath: string, sessionId: string): string {
  return join(sessionDir(rootPath, sessionId), 'events.jsonl')
}

function summaryPath(rootPath: string, sessionId: string): string {
  return join(sessionDir(rootPath, sessionId), 'summary.md')
}

/**
 * Unified summary storage path. We key summaries by a `primaryKey`:
 *   - `cliSessionId` when available (CLI history sessions, or Desk Sessions whose
 *     CC jsonl was matched on exit). This makes "summary written via CLI history"
 *     and "summary written via Desk Session that was bound to that same jsonl"
 *     converge to the same file naturally.
 *   - Fall back to the Desk Session id for sessions without a cliSessionId
 *     (GenericAgent, or claude-code where mtime matching failed).
 *
 * `safePathSegment` is kept (URL-encoding sessionId) to avoid filesystem-unsafe
 * characters; in practice cliSessionId / desk uuid are already safe but we keep
 * the guard for forward compatibility.
 */
function unifiedSummaryPath(rootPath: string, primaryKey: string): string {
  return join(rootPath, 'summaries', `${safePathSegment(primaryKey)}.md`)
}

function safePathSegment(value: string): string {
  return encodeURIComponent(value)
}

function usesAiEvents(session: Session | null | undefined): boolean {
  return session?.interactionMode === 'headless' || session?.interactionMode === 'native-jsonl'
}

export type SessionStore = ReturnType<typeof createSessionStore>

export function createSessionStore(rootPath: string) {
  const metaWriteQueues = new Map<string, Promise<void>>()

  function writeSessionMeta(session: Session): Promise<void> {
    const previous = metaWriteQueues.get(session.id) ?? Promise.resolve()
    const write = previous.catch(() => undefined).then(() => writeJsonFileAtomic(metaPath(rootPath, session.id), session))
    metaWriteQueues.set(session.id, write)
    return write.finally(() => {
      if (metaWriteQueues.get(session.id) === write) metaWriteQueues.delete(session.id)
    })
  }

  return {
    async createSession(session: Session): Promise<void> {
      await writeSessionMeta(session)
    },

    async updateSession(session: Session): Promise<void> {
      await writeSessionMeta(session)
    },

    async getSession(sessionId: string): Promise<Session> {
      const meta = await readJsonFile<Session | null>(metaPath(rootPath, sessionId), null)
      if (!meta || !meta.id) {
        throw new Error(`Session not found: ${sessionId}`)
      }
      return meta
    },

    async appendOutput(event: SessionOutputEvent): Promise<void> {
      await appendOutputLine(outputPath(rootPath, event.sessionId), event)
    },

    async appendAiEvent(event: SessionAiEvent): Promise<void> {
      await appendSessionAiEventLine(eventsPath(rootPath, event.sessionId), event)
    },

    async getAiEvents(input: SessionAiEventsReadInput): Promise<SessionAiEventsReadResult> {
      return readSessionAiEventLines(eventsPath(rootPath, input.sessionId), {
        offset: input.offset,
        limit: input.limit
      })
    },

    async getOutput(input: OutputReadInput): Promise<OutputReadResult> {
      const meta = await readJsonFile<Session | null>(metaPath(rootPath, input.sessionId), null)
      if (usesAiEvents(meta)) {
        const result = await readSessionAiEventLines(eventsPath(rootPath, input.sessionId), {
          offset: input.offset,
          limit: input.limit
        })
        const plainOutput = aiEventsToPlainText(result.events)
        return {
          chunks: plainOutput.length > 0
            ? [{ sessionId: input.sessionId, chunk: plainOutput, stream: 'stdout', timestamp: result.events[0]?.timestamp ?? meta!.createdAt }]
            : [],
          nextOffset: result.nextOffset,
          totalBytes: result.totalBytes
        }
      }
      return readOutputLines(outputPath(rootPath, input.sessionId), {
        offset: input.offset,
        limit: input.limit
      })
    },

    async listHistory(projectId?: string): Promise<DeskHistoryItem[]> {
      let entries: string[]
      try {
        entries = await readDir(rootPath)
      } catch {
        return []
      }

      const items: DeskHistoryItem[] = []
      for (const entry of entries) {
        try {
          const meta = await readJsonFile<Session>(metaPath(rootPath, entry), undefined as unknown as Session)
          if (!meta || !meta.id) continue
          // Project-level history: when projectId is provided, only return sessions
          // belonging to that project. This keeps the Desk history scoped to what
          // the user is currently looking at, matching CLI history's per-project model.
          if (projectId && meta.projectId !== projectId) continue
          let outputSizeBytes = 0
          try {
            outputSizeBytes = (await stat(usesAiEvents(meta) ? eventsPath(rootPath, entry) : outputPath(rootPath, entry))).size
          } catch {
            // output/events file may not exist
          }
          let summaryGeneratedAt: string | undefined
          // Summary lookup: prefer the unified path keyed by cliSessionId (when bound),
          // fall back to desk sessionId at the unified path, then legacy per-session path.
          const primaryKey = meta.cliSessionId ?? meta.id
          const candidatePaths = [
            unifiedSummaryPath(rootPath, primaryKey),
            unifiedSummaryPath(rootPath, meta.id),
            summaryPath(rootPath, meta.id)
          ]
          for (const candidate of candidatePaths) {
            try {
              const summaryContent = await readFile(candidate, 'utf-8')
              if (summaryContent.length > 0) {
                const summaryStat = await stat(candidate)
                summaryGeneratedAt = summaryStat.mtime.toISOString()
                break
              }
            } catch {
              // try next candidate
            }
          }
          items.push({ ...meta, summaryGeneratedAt, outputSizeBytes })
        } catch {
          // skip corrupted meta
        }
      }

      items.sort((a, b) => {
        const timeA = a.exitedAt ?? a.lastActivityAt
        const timeB = b.exitedAt ?? b.lastActivityAt
        return timeB.localeCompare(timeA)
      })

      return items
    },

    async recoverInterruptedSessions(): Promise<void> {
      let entries: string[]
      try {
        entries = await readDir(rootPath)
      } catch {
        return
      }

      for (const entry of entries) {
        try {
          await repairOutputJsonlTail(outputPath(rootPath, entry))
          await repairSessionAiEventsJsonlTail(eventsPath(rootPath, entry))
        } catch {
          // skip if output/events file missing
        }

        try {
          const meta = await readJsonFile<Session>(metaPath(rootPath, entry), undefined as unknown as Session)
          if (!meta || !ACTIVE_STATUSES.includes(meta.status)) continue

          const now = new Date().toISOString()
          const updated: Session = {
            ...meta,
            status: 'failed',
            errorMessage: 'Session was interrupted by application restart',
            exitedAt: now,
            lastActivityAt: now
          }
          await writeJsonFileAtomic(metaPath(rootPath, entry), updated)
        } catch {
          // skip corrupted meta
        }
      }
    },

    async getSummary(primaryKey: string): Promise<string | undefined> {
      // Primary read: unified summary directory keyed by cliSessionId or desk sessionId.
      try {
        const content = await readFile(unifiedSummaryPath(rootPath, primaryKey), 'utf-8')
        return content.length > 0 ? content : undefined
      } catch {
        // fall through to legacy path
      }
      // Legacy fallback: pre-unification Desk Session summaries lived under
      // `<root>/<sessionId>/summary.md`. We treat primaryKey as a desk sessionId here,
      // which is correct when the session never bound a cliSessionId (matching failed
      // or older record). Read-only fallback; new writes always go to the unified path.
      try {
        const content = await readFile(summaryPath(rootPath, primaryKey), 'utf-8')
        return content.length > 0 ? content : undefined
      } catch {
        return undefined
      }
    },

    async writeSummary(primaryKey: string, summary: string): Promise<void> {
      const path = unifiedSummaryPath(rootPath, primaryKey)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, summary, 'utf-8')
    },

    async search(input: SearchSessionsInput): Promise<SearchSessionResult[]> {
      const normalizedQuery = input.query.toLocaleLowerCase()
      if (normalizedQuery.length === 0) return []

      const history = await this.listHistory()
      const results: SearchSessionResult[] = []

      for (const session of history) {
        const matchedAt = new Date().toISOString()

        // Search title
        if (session.title.toLocaleLowerCase().includes(normalizedQuery)) {
          results.push({
            sessionId: session.id,
            title: session.title,
            status: session.status,
            matchedAt,
            excerpt: session.title.slice(0, 160)
          })
          continue
        }

        // Search output/events
        try {
          if (usesAiEvents(session)) {
            const eventText = aiEventsToPlainText((await this.getAiEvents({ sessionId: session.id, offset: 0, limit: 100000 })).events)
            if (eventText.toLocaleLowerCase().includes(normalizedQuery)) {
              const index = eventText.toLocaleLowerCase().indexOf(normalizedQuery)
              const start = Math.max(0, index - 60)
              results.push({
                sessionId: session.id,
                title: session.title,
                status: session.status,
                matchedAt,
                excerpt: eventText.slice(start, start + 160)
              })
              continue
            }
          } else {
            const hits = await searchOutputLines(outputPath(rootPath, session.id), input.query)
            if (hits.length > 0) {
              results.push({
                sessionId: session.id,
                title: session.title,
                status: session.status,
                matchedAt,
                excerpt: hits[0].excerpt
              })
              continue
            }
          }
        } catch {
          // output/events file may not exist
        }

        // Search summary
        try {
          const primaryKey = session.cliSessionId ?? session.id
          const summaryContent =
            (await tryReadFile(unifiedSummaryPath(rootPath, primaryKey)))
            ?? (await tryReadFile(unifiedSummaryPath(rootPath, session.id)))
            ?? (await tryReadFile(summaryPath(rootPath, session.id)))
          if (summaryContent && summaryContent.toLocaleLowerCase().includes(normalizedQuery)) {
            const index = summaryContent.toLocaleLowerCase().indexOf(normalizedQuery)
            const start = Math.max(0, index - 60)
            results.push({
              sessionId: session.id,
              title: session.title,
              status: session.status,
              matchedAt,
              excerpt: summaryContent.slice(start, start + 160)
            })
          }
        } catch {
          // summary may not exist
        }
      }

      return results
    },

    async buildExportText(sessionId: string): Promise<string> {
      const meta = await this.getSession(sessionId)
      const plainOutput = usesAiEvents(meta)
        ? aiEventsToPlainText((await this.getAiEvents({ sessionId, offset: 0, limit: 100000 })).events)
        : toPlainText((await this.getOutput({ sessionId, offset: 0, limit: 100000 })).chunks)
      const primaryKey = meta.cliSessionId ?? meta.id
      const summary =
        (await tryReadFile(unifiedSummaryPath(rootPath, primaryKey)))
        ?? (await tryReadFile(unifiedSummaryPath(rootPath, meta.id)))
        ?? (await tryReadFile(summaryPath(rootPath, meta.id)))

      const lines: string[] = [
        `Title: ${meta.title}`,
        `Project ID: ${meta.projectId}`,
        `Status: ${meta.status}`,
        `Created: ${meta.createdAt}`,
        `Exited: ${meta.exitedAt ?? 'N/A'}`,
        '',
        '--- Output ---',
        plainOutput
      ]

      if (summary) {
        lines.push('', '--- Summary ---', summary)
      }

      return lines.join('\n')
    }
  }
}

async function readDir(dirPath: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  return readdir(dirPath)
}

async function tryReadFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return undefined
  }
}
