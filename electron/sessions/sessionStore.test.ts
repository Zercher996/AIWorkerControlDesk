import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Session, SessionAiEvent } from '../../src/types/workerDesk'
import { appendOutputLine } from './outputJsonl'
import { createSessionStore } from './sessionStore'

const isEndedStatus = (status: Session['status']) => status === 'exited' || status === 'stopped'

const baseSession = (id: string, status: Session['status'] = 'exited'): Session => ({
  id,
  projectId: 'project-1',
  workerType: 'claude-code',
  interactionMode: 'pty',
  status,
  title: `Session ${id}`,
  createdAt: '2026-05-11T00:00:00.000Z',
  lastActivityAt: '2026-05-11T00:00:01.000Z',
  exitedAt: isEndedStatus(status) ? '2026-05-11T00:00:02.000Z' : undefined,
  exitCode: status === 'exited' ? 0 : status === 'stopped' ? 1 : undefined,
  outputRef: `file:sessions/${id}/output.jsonl`
})

const aiEvent = (sessionId: string, type: SessionAiEvent['type'], extra: Partial<SessionAiEvent> = {}): SessionAiEvent => ({
  id: `${sessionId}-${type}-1`,
  sessionId,
  timestamp: '2026-05-11T00:00:00.000Z',
  source: 'desk',
  type,
  ...extra
} as SessionAiEvent)

describe('sessionStore', () => {
  it('creates meta and output paths for a session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    try {
      const store = createSessionStore(dir)
      const session = baseSession('session-1', 'running')
      await store.createSession(session)
      await store.appendOutput({ sessionId: session.id, chunk: 'hello', stream: 'stdout', timestamp: session.createdAt })
      await expect(store.getOutput({ sessionId: session.id })).resolves.toMatchObject({
        chunks: [{ chunk: 'hello' }]
      })
      await expect(readFile(join(dir, session.id, 'meta.json'), 'utf-8')).resolves.toContain('"status": "running"')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('serializes create and concurrent meta updates for the same session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    try {
      const store = createSessionStore(dir)
      const session = baseSession('session-1', 'starting')
      const createPromise = store.createSession(session)
      const updates = Array.from({ length: 30 }, (_, index) => store.updateSession({
        ...session,
        status: index === 29 ? 'waiting' : 'running',
        title: `Session update ${index}`,
        processId: index,
        lastActivityAt: `2026-05-11T00:00:${String(index).padStart(2, '0')}.000Z`
      }))

      await expect(Promise.all([createPromise, ...updates])).resolves.toBeDefined()
      const raw = await readFile(join(dir, session.id, 'meta.json'), 'utf-8')
      const persisted = JSON.parse(raw) as Session
      expect(persisted.title).toBe('Session update 29')
      expect(persisted.status).toBe('waiting')
      expect(persisted.processId).toBe(29)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('gets session by id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    try {
      const store = createSessionStore(dir)
      const session = baseSession('session-1')
      await store.createSession(session)
      const result = await store.getSession(session.id)
      expect(result.id).toBe(session.id)
      expect(result.title).toBe(session.title)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('throws when session not found', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    try {
      const store = createSessionStore(dir)
      await expect(store.getSession('nonexistent')).rejects.toThrow('Session not found: nonexistent')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('recovers interrupted sessions as failed and sorts history newest first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    try {
      const store = createSessionStore(dir)
      await store.createSession(baseSession('old', 'exited'))
      await store.createSession({ ...baseSession('live', 'running'), lastActivityAt: '2026-05-11T00:10:00.000Z' })
      await store.recoverInterruptedSessions()
      const history = await store.listHistory()
      expect(history[0]).toMatchObject({ id: 'live', status: 'failed', errorMessage: 'Session was interrupted by application restart' })
      expect(history[1]).toMatchObject({ id: 'old', status: 'exited' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('repairs incomplete output tail during recovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    try {
      const store = createSessionStore(dir)
      const session = baseSession('session-1')
      await store.createSession(session)
      await writeFile(join(dir, session.id, 'output.jsonl'), '{"sessionId":"session-1"', 'utf-8')
      await store.recoverInterruptedSessions()
      await expect(store.getOutput({ sessionId: session.id })).resolves.toMatchObject({ chunks: [] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('searches title, output, and summary without leaking env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    try {
      const store = createSessionStore(dir)
      const session = baseSession('session-1')
      await store.createSession(session)
      await appendOutputLine(join(dir, session.id, 'output.jsonl'), { sessionId: session.id, chunk: 'needle output', stream: 'stdout', timestamp: session.createdAt })
      await store.writeSummary(session.id, 'summary needle')
      const results = await store.search({ query: 'needle' })
      expect(results).toEqual([expect.objectContaining({ sessionId: session.id, title: session.title })])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writeSummary persists under unified path and getSummary reads it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    try {
      const store = createSessionStore(dir)
      const session = baseSession('session-1')
      await store.createSession(session)
      await store.writeSummary(session.id, '# Session Summary\n\nDone.')
      const summary = await store.getSummary(session.id)
      expect(summary).toContain('Done.')
      // Unified path is `<root>/summaries/<encoded primaryKey>.md`
      await expect(readFile(join(dir, 'summaries', `${encodeURIComponent(session.id)}.md`), 'utf-8')).resolves.toContain('Done.')
      const history = await store.listHistory()
      expect(history[0].summaryGeneratedAt).toBeDefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stores summaries by cliSessionId so Desk and CLI entries converge to one file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    try {
      const store = createSessionStore(dir)
      const sessionId = '../cli/session'
      // CLI history can only refer to a session by cliSessionId — that's the primary key.
      await store.writeSummary(sessionId, '# CLI Summary\n\nDone.')

      await expect(store.getSummary(sessionId)).resolves.toContain('Done.')
      await expect(readFile(join(dir, 'summaries', `${encodeURIComponent(sessionId)}.md`), 'utf-8')).resolves.toContain('Done.')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to legacy per-session summary path for pre-unification data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    try {
      const store = createSessionStore(dir)
      const session = baseSession('legacy-session')
      await store.createSession(session)
      // Write directly to the legacy location to simulate older data
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(dir, session.id), { recursive: true })
      await writeFile(join(dir, session.id, 'summary.md'), 'legacy summary content', 'utf-8')

      await expect(store.getSummary(session.id)).resolves.toContain('legacy summary')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('projects headless AI events through getOutput for history and summary readers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    try {
      const store = createSessionStore(dir)
      const session = { ...baseSession('headless-1'), interactionMode: 'headless' as const }
      await store.createSession(session)
      await store.appendAiEvent(aiEvent(session.id, 'user_message', { text: 'first prompt' }))
      await store.appendAiEvent(aiEvent(session.id, 'assistant_text', { text: 'assistant answer' }))

      const output = await store.getOutput({ sessionId: session.id })
      expect(output.chunks).toHaveLength(1)
      expect(output.chunks[0].chunk).toContain('first prompt')
      expect(output.chunks[0].chunk).toContain('assistant answer')
      expect(output.totalBytes).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('exports plain text with summary appended and no env leak', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    try {
      const store = createSessionStore(dir)
      const session = baseSession('session-1')
      await store.createSession(session)
      await store.appendOutput({ sessionId: session.id, chunk: 'plain output', stream: 'stdout', timestamp: session.createdAt })
      await store.writeSummary(session.id, '# Session Summary\n\nDone.')
      const text = await store.buildExportText(session.id)
      expect(text).toContain('plain output')
      expect(text).toContain('# Session Summary')
      expect(text).toContain(`Title: ${session.title}`)
      expect(text).toContain(`Status: ${session.status}`)
      expect(text).not.toContain('ANTHROPIC_API_KEY')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns empty list for missing root directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    await rm(dir, { recursive: true, force: true })
    const store = createSessionStore(dir)
    await expect(store.listHistory()).resolves.toEqual([])
  })

  it('filters listHistory by projectId when provided', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    try {
      const store = createSessionStore(dir)
      await store.createSession({ ...baseSession('a'), projectId: 'project-1' })
      await store.createSession({ ...baseSession('b'), projectId: 'project-2' })
      await store.createSession({ ...baseSession('c'), projectId: 'project-1' })

      const all = await store.listHistory()
      expect(all).toHaveLength(3)

      const onlyProject1 = await store.listHistory('project-1')
      expect(onlyProject1.map((item) => item.id).sort()).toEqual(['a', 'c'])

      const onlyProject2 = await store.listHistory('project-2')
      expect(onlyProject2.map((item) => item.id)).toEqual(['b'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists history across store instances (simulates restart)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    try {
      const store1 = createSessionStore(dir)
      await store1.createSession(baseSession('session-1'))
      await store1.appendOutput({ sessionId: 'session-1', chunk: 'hello', stream: 'stdout', timestamp: '2026-05-11T00:00:00.000Z' })
      await store1.writeSummary('session-1', '# Summary')

      // Create a new store instance pointing to the same directory (simulates app restart)
      const store2 = createSessionStore(dir)
      const history = await store2.listHistory()
      expect(history).toHaveLength(1)
      expect(history[0].id).toBe('session-1')
      expect(history[0].summaryGeneratedAt).toBeDefined()

      const output = await store2.getOutput({ sessionId: 'session-1' })
      expect(output.chunks[0].chunk).toBe('hello')

      const summary = await store2.getSummary('session-1')
      expect(summary).toContain('Summary')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads large output in batches via nextOffset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-store-'))
    try {
      const store = createSessionStore(dir)
      const session = baseSession('session-1')
      await store.createSession(session)

      // Write 500 chunks
      for (let i = 0; i < 500; i++) {
        await store.appendOutput({
          sessionId: session.id,
          chunk: `chunk-${i}`,
          stream: 'stdout',
          timestamp: '2026-05-11T00:00:00.000Z'
        })
      }

      // Read in batches of 100
      const allChunks: string[] = []
      let offset = 0
      let batches = 0
      while (true) {
        const result = await store.getOutput({ sessionId: session.id, offset, limit: 100 })
        for (const c of result.chunks) allChunks.push(c.chunk)
        batches++
        if (!result.nextOffset) break
        offset = result.nextOffset
      }

      expect(allChunks).toHaveLength(500)
      expect(allChunks[0]).toBe('chunk-0')
      expect(allChunks[499]).toBe('chunk-499')
      expect(batches).toBe(5)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
