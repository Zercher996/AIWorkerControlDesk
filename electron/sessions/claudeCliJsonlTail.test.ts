import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { encodeProjectPath } from './cliHistory'
import { startClaudeCliJsonlTail } from './claudeCliJsonlTail'

async function createClaudeProjectFixture(workspacePath: string) {
  const root = await mkdtemp(join(tmpdir(), 'aiw-native-jsonl-tail-'))
  const projectDir = join(root, encodeProjectPath(workspacePath))
  await mkdir(projectDir, { recursive: true })
  return { root, projectDir }
}

describe('startClaudeCliJsonlTail', () => {
  it('discovers a newly created Claude jsonl file and tails complete lines once', async () => {
    const workspacePath = join(tmpdir(), 'workspace-tail-once')
    const { root, projectDir } = await createClaudeProjectFixture(workspacePath)
    const events: Array<{ type: string; text?: string; id: string; source: string }> = []
    const matched = vi.fn()
    try {
      const tail = startClaudeCliJsonlTail({
        deskSessionId: 'desk-1',
        workspacePath,
        createdAtMs: Date.now() - 1000,
        claudeProjectsBaseDir: root,
        pollIntervalMs: 0,
        onCliSessionMatched: matched,
        onEvent: (event) => events.push(event as never)
      })
      const filePath = join(projectDir, 'cli-session-1.jsonl')
      await writeFile(filePath, [
        JSON.stringify({ type: 'system', sessionId: 'cli-session-1', cwd: workspacePath, timestamp: '2026-06-01T00:00:00.000Z' }),
        JSON.stringify({ type: 'user', isMeta: false, timestamp: '2026-06-01T00:00:01.000Z', message: { role: 'user', content: 'hello' } })
      ].join('\n') + '\n', 'utf-8')

      await tail.pollNow()
      await tail.pollNow()

      expect(events.map((event) => event.type)).toEqual(['system', 'user_message'])
      expect(events[0].source).toBe('claude-code-jsonl')
      expect(new Set(events.map((event) => event.id)).size).toBe(events.length)
      expect(matched).toHaveBeenCalledWith('cli-session-1', filePath)
      expect(tail.getStats().parsedLineCount).toBe(2)
      tail.stop()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('buffers an incomplete tail line until it is newline terminated', async () => {
    const workspacePath = join(tmpdir(), 'workspace-partial-line')
    const { root, projectDir } = await createClaudeProjectFixture(workspacePath)
    const events: Array<{ type: string; text?: string }> = []
    try {
      const filePath = join(projectDir, 'cli-session-2.jsonl')
      const completeLine = JSON.stringify({ type: 'system', sessionId: 'cli-session-2', cwd: workspacePath, timestamp: '2026-06-01T00:00:00.000Z' }) + '\n'
      const partialLine = JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T00:00:01.000Z', message: { role: 'assistant', content: 'hi' } })
      await writeFile(filePath, completeLine + partialLine.slice(0, -2), 'utf-8')
      const tail = startClaudeCliJsonlTail({
        deskSessionId: 'desk-1',
        workspacePath,
        createdAtMs: Date.now() - 1000,
        claudeProjectsBaseDir: root,
        pollIntervalMs: 0,
        onEvent: (event) => events.push(event as never)
      })

      await tail.pollNow()
      expect(events.map((event) => event.type)).toEqual(['system'])

      await writeFile(filePath, completeLine + partialLine + '\n', 'utf-8')
      await tail.pollNow()
      expect(events.map((event) => event.type)).toEqual(['system', 'assistant_text'])
      tail.stop()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not bind a new file until it has matching workspace cwd evidence', async () => {
    const workspacePath = join(tmpdir(), 'workspace-cwd-evidence')
    const { root, projectDir } = await createClaudeProjectFixture(workspacePath)
    const events: Array<{ type: string }> = []
    try {
      const filePath = join(projectDir, 'cli-session-cwd.jsonl')
      await writeFile(filePath, JSON.stringify({ type: 'permission-mode', mode: 'default', timestamp: '2026-06-01T00:00:00.000Z' }) + '\n', 'utf-8')
      const tail = startClaudeCliJsonlTail({
        deskSessionId: 'desk-1',
        workspacePath,
        createdAtMs: Date.now() - 1000,
        claudeProjectsBaseDir: root,
        pollIntervalMs: 0,
        onEvent: (event) => events.push(event as never)
      })

      await tail.pollNow()
      expect(tail.getStats().filePath).toBeUndefined()
      expect(events).toEqual([])

      await writeFile(filePath, [
        JSON.stringify({ type: 'permission-mode', mode: 'default', timestamp: '2026-06-01T00:00:00.000Z' }),
        JSON.stringify({ type: 'system', sessionId: 'cli-session-cwd', cwd: workspacePath, timestamp: '2026-06-01T00:00:01.000Z' })
      ].join('\n') + '\n', 'utf-8')
      await tail.pollNow()

      expect(tail.getStats().filePath).toBe(filePath)
      expect(events.map((event) => event.type)).toEqual(['system'])
      tail.stop()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prefers the Claude jsonl file whose creation time is closest to the desk session start', async () => {
    const workspacePath = join(tmpdir(), 'workspace-closest-created')
    const { root, projectDir } = await createClaudeProjectFixture(workspacePath)
    const events: Array<{ text?: string }> = []
    try {
      const startedAt = Date.now()
      const olderFilePath = join(projectDir, 'cli-session-older.jsonl')
      await writeFile(olderFilePath, [
        JSON.stringify({ type: 'system', sessionId: 'cli-session-older', cwd: workspacePath, timestamp: '2026-06-01T00:00:00.000Z' }),
        JSON.stringify({ type: 'user', isMeta: false, timestamp: '2026-06-01T00:00:01.000Z', message: { role: 'user', content: 'older session' } })
      ].join('\n') + '\n', 'utf-8')
      await new Promise((resolve) => setTimeout(resolve, 25))
      const newerFilePath = join(projectDir, 'cli-session-newer.jsonl')
      await writeFile(newerFilePath, [
        JSON.stringify({ type: 'system', sessionId: 'cli-session-newer', cwd: workspacePath, timestamp: '2026-06-01T00:00:02.000Z' }),
        JSON.stringify({ type: 'user', isMeta: false, timestamp: '2026-06-01T00:00:03.000Z', message: { role: 'user', content: 'newer session' } })
      ].join('\n') + '\n', 'utf-8')

      const tail = startClaudeCliJsonlTail({
        deskSessionId: 'desk-1',
        workspacePath,
        createdAtMs: startedAt,
        claudeProjectsBaseDir: root,
        pollIntervalMs: 0,
        onEvent: (event) => events.push(event as never)
      })

      await tail.pollNow()

      expect(tail.getStats().filePath).toBe(olderFilePath)
      expect(events.some((event) => event.text === 'older session')).toBe(true)
      expect(events.some((event) => event.text === 'newer session')).toBe(false)
      tail.stop()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not bind an older Claude jsonl file that was merely updated near the desk session start', async () => {
    const workspacePath = join(tmpdir(), 'workspace-ignore-old-updated')
    const { root, projectDir } = await createClaudeProjectFixture(workspacePath)
    const events: Array<{ type: string }> = []
    try {
      const filePath = join(projectDir, 'cli-session-old-updated.jsonl')
      await writeFile(filePath, [
        JSON.stringify({ type: 'system', sessionId: 'cli-session-old-updated', cwd: workspacePath, timestamp: '2026-06-01T00:00:00.000Z' }),
        JSON.stringify({ type: 'user', isMeta: false, timestamp: '2026-06-01T00:00:01.000Z', message: { role: 'user', content: 'old but active' } })
      ].join('\n') + '\n', 'utf-8')
      await new Promise((resolve) => setTimeout(resolve, 25))
      const startedAt = Date.now()
      await writeFile(filePath, [
        JSON.stringify({ type: 'system', sessionId: 'cli-session-old-updated', cwd: workspacePath, timestamp: '2026-06-01T00:00:00.000Z' }),
        JSON.stringify({ type: 'user', isMeta: false, timestamp: '2026-06-01T00:00:01.000Z', message: { role: 'user', content: 'old but active' } }),
        JSON.stringify({ type: 'assistant', sessionId: 'cli-session-old-updated', timestamp: '2026-06-01T00:00:02.000Z', message: { role: 'assistant', content: 'still writing' } })
      ].join('\n') + '\n', 'utf-8')

      const tail = startClaudeCliJsonlTail({
        deskSessionId: 'desk-new',
        workspacePath,
        createdAtMs: startedAt,
        claudeProjectsBaseDir: root,
        ignoredCliJsonlFilePaths: [filePath],
        pollIntervalMs: 0,
        onEvent: (event) => events.push(event as never)
      })

      await tail.pollNow()

      expect(tail.getStats().filePath).toBeUndefined()
      expect(events).toEqual([])
      tail.stop()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not bind a Claude jsonl file already claimed by another desk session', async () => {
    const workspacePath = join(tmpdir(), 'workspace-exclusive-tail')
    const { root, projectDir } = await createClaudeProjectFixture(workspacePath)
    const claims = new Map<string, string>()
    const claimCliJsonlFile = vi.fn((claim: { deskSessionId: string; filePath: string }) => {
      const owner = claims.get(claim.filePath)
      if (owner && owner !== claim.deskSessionId) return false
      claims.set(claim.filePath, claim.deskSessionId)
      return true
    })
    const firstEvents: Array<{ sessionId: string; text?: string }> = []
    const secondEvents: Array<{ sessionId: string; text?: string }> = []
    try {
      const filePath = join(projectDir, 'cli-session-exclusive.jsonl')
      await writeFile(filePath, [
        JSON.stringify({ type: 'system', sessionId: 'cli-session-exclusive', cwd: workspacePath, timestamp: '2026-06-01T00:00:00.000Z' }),
        JSON.stringify({ type: 'user', isMeta: false, timestamp: '2026-06-01T00:00:01.000Z', message: { role: 'user', content: 'belongs to first' } })
      ].join('\n') + '\n', 'utf-8')

      const firstTail = startClaudeCliJsonlTail({
        deskSessionId: 'desk-1',
        workspacePath,
        createdAtMs: Date.now() - 1000,
        claudeProjectsBaseDir: root,
        pollIntervalMs: 0,
        claimCliJsonlFile,
        onEvent: (event) => firstEvents.push(event as never)
      })
      const secondTail = startClaudeCliJsonlTail({
        deskSessionId: 'desk-2',
        workspacePath,
        createdAtMs: Date.now() - 1000,
        claudeProjectsBaseDir: root,
        pollIntervalMs: 0,
        claimCliJsonlFile,
        onEvent: (event) => secondEvents.push(event as never)
      })

      await firstTail.pollNow()
      await secondTail.pollNow()

      expect(firstEvents.map((event) => event.sessionId)).toEqual(['desk-1', 'desk-1'])
      expect(secondEvents).toEqual([])
      expect(secondTail.getStats().filePath).toBeUndefined()
      expect(claims.get(filePath)).toBe('desk-1')
      firstTail.stop()
      secondTail.stop()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not modify malformed or truncated Claude jsonl content', async () => {
    const workspacePath = join(tmpdir(), 'workspace-readonly-tail')
    const { root, projectDir } = await createClaudeProjectFixture(workspacePath)
    const diagnostics: string[] = []
    try {
      const filePath = join(projectDir, 'cli-session-3.jsonl')
      const raw = [
        JSON.stringify({ type: 'system', sessionId: 'cli-session-3', cwd: workspacePath, timestamp: '2026-06-01T00:00:00.000Z' }),
        '{malformed}',
        '{"type":"assistant"'
      ].join('\n')
      await writeFile(filePath, raw, 'utf-8')
      const tail = startClaudeCliJsonlTail({
        deskSessionId: 'desk-1',
        workspacePath,
        createdAtMs: Date.now() - 1000,
        claudeProjectsBaseDir: root,
        pollIntervalMs: 0,
        onEvent: () => undefined,
        onDiagnostic: (message) => diagnostics.push(message)
      })

      await tail.pollNow()
      expect(await readFile(filePath, 'utf-8')).toBe(raw)
      expect(tail.getStats().parseErrorCount).toBe(1)
      await truncate(filePath, 0)
      await tail.pollNow()
      expect(diagnostics.some((message) => message.includes('shrank'))).toBe(true)
      tail.stop()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
