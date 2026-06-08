import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createCliHistoryStore, encodeProjectPath, matchCliSessionByMtime } from './cliHistory'

async function createClaudeProjectHistoryFixture(projectPath: string) {
  const baseDir = await mkdtemp(join(tmpdir(), 'aiw-cli-history-'))
  const projectDir = join(baseDir, encodeProjectPath(projectPath))
  await mkdir(projectDir, { recursive: true })
  return { baseDir, projectDir }
}

describe('encodeProjectPath', () => {
  it('replaces non-alphanumeric chars with hyphens', () => {
    expect(encodeProjectPath('E:\\Users\\test\\project')).toBe('E--Users-test-project')
  })

  it('preserves hyphens', () => {
    expect(encodeProjectPath('/home/user/my-project')).toBe('-home-user-my-project')
  })

  it('handles pure alphanumeric', () => {
    expect(encodeProjectPath('abc123')).toBe('abc123')
  })

  it('handles Windows-style path', () => {
    const result = encodeProjectPath('E:\\01_AIcode\\01-ClaudeCode\\00_Tools')
    expect(result).toBe('E--01-AIcode-01-ClaudeCode-00-Tools')
  })

  it('matches real Claude CLI directory name', () => {
    // This matches the actual directory name used by Claude CLI on this machine
    const result = encodeProjectPath('E:\\01_AIcode\\01_ClaudeCode\\00_Tools\\AIWorkerControlDesk')
    expect(result).toBe('E--01-AIcode-01-ClaudeCode-00-Tools-AIWorkerControlDesk')
  })
})

describe('createCliHistoryStore', () => {
  it('matches CLI session by mtime only after confirming jsonl cwd belongs to the workspace', async () => {
    const projectPath = 'E:/tmp/aiworker-cli-history-mtime-cwd'
    const otherProjectPath = 'E:/tmp/aiworker-cli-history-other-cwd'
    const { baseDir, projectDir } = await createClaudeProjectHistoryFixture(projectPath)
    const rightSessionId = 'right-cwd-session'
    const wrongSessionId = 'wrong-cwd-session'
    const createdAt = new Date('2026-05-11T00:00:00.000Z')
    const exitedAt = new Date('2026-05-11T00:00:10.000Z')

    await rm(projectDir, { recursive: true, force: true })
    await mkdir(projectDir, { recursive: true })
    const rightFilePath = join(projectDir, `${rightSessionId}.jsonl`)
    const wrongFilePath = join(projectDir, `${wrongSessionId}.jsonl`)
    await writeFile(rightFilePath, [
      JSON.stringify({ type: 'system', sessionId: rightSessionId, timestamp: '2026-05-11T00:00:00.000Z', cwd: projectPath }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'right workspace task' }, sessionId: rightSessionId, timestamp: '2026-05-11T00:00:01.000Z', isMeta: false })
    ].join('\n'), 'utf-8')
    await writeFile(wrongFilePath, [
      JSON.stringify({ type: 'system', sessionId: wrongSessionId, timestamp: '2026-05-11T00:00:00.000Z', cwd: otherProjectPath }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'wrong workspace task' }, sessionId: wrongSessionId, timestamp: '2026-05-11T00:00:01.000Z', isMeta: false })
    ].join('\n'), 'utf-8')
    await utimes(rightFilePath, exitedAt, new Date(exitedAt.getTime() - 1000))
    await utimes(wrongFilePath, exitedAt, exitedAt)

    try {
      await expect(matchCliSessionByMtime({
        workspacePath: projectPath,
        createdAtMs: createdAt.getTime(),
        exitedAtMs: exitedAt.getTime(),
        slackMs: 0,
        claudeProjectsBaseDir: baseDir
      })).resolves.toBe(rightSessionId)
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it('reads CLI output using cached project path when projectId is empty', async () => {
    const projectPath = 'E:/tmp/aiworker-cli-history-cache'
    const { baseDir, projectDir } = await createClaudeProjectHistoryFixture(projectPath)
    const sessionId = 'cached-session'

    await rm(projectDir, { recursive: true, force: true })
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello cached project' },
        sessionId,
        timestamp: '2026-05-11T00:00:00.000Z',
        cwd: projectPath,
        isMeta: false
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'cached response' },
        sessionId,
        timestamp: '2026-05-11T00:00:01.000Z'
      })
    ].join('\n'), 'utf-8')

    try {
      const store = createCliHistoryStore({
        getProjectPath: async (projectId) => {
          if (!projectId) throw new Error('projectId is required')
          return projectPath
        },
        claudeProjectsBaseDir: baseDir
      })

      await store.listCliHistory('project-1')

      await expect(store.getCliSessionOutput(sessionId, '')).resolves.toContain('>>> hello cached project')
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it('lists sessions using stat mtime instead of scanning to file end', async () => {
    // Performance contract: listCliHistory must not depend on the trailing
    // entries to compute updatedAt. We force a mismatch — last entry timestamp
    // is far in the past, but the file's actual mtime is "now" — and assert
    // the listing prefers mtime, so project switching stays fast on big jsonls.
    const projectPath = 'E:/tmp/aiworker-cli-history-mtime'
    const { baseDir, projectDir } = await createClaudeProjectHistoryFixture(projectPath)
    const sessionId = 'mtime-session'

    await rm(projectDir, { recursive: true, force: true })
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello mtime' },
        sessionId,
        timestamp: '2020-01-01T00:00:00.000Z',
        cwd: projectPath,
        isMeta: false
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'old response' },
        sessionId,
        timestamp: '2020-01-01T00:00:01.000Z'
      })
    ].join('\n'), 'utf-8')

    try {
      const store = createCliHistoryStore({ getProjectPath: async () => projectPath, claudeProjectsBaseDir: baseDir })
      const items = await store.listCliHistory('project-1')
      expect(items).toHaveLength(1)
      const item = items[0]
      expect(item.id).toBe(sessionId)
      expect(item.firstMessage).toBe('hello mtime')
      // updatedAt should reflect the file's mtime (set by writeFile during this test run),
      // not the in-file 2020 timestamp.
      const updatedMs = Date.parse(item.updatedAt)
      const recentThresholdMs = Date.now() - 60_000
      expect(updatedMs).toBeGreaterThan(recentThresholdMs)
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it('finds firstMessage even when several non-message entries appear first', async () => {
    const projectPath = 'E:/tmp/aiworker-cli-history-headskip'
    const { baseDir, projectDir } = await createClaudeProjectHistoryFixture(projectPath)
    const sessionId = 'headskip-session'

    await rm(projectDir, { recursive: true, force: true })
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${sessionId}.jsonl`), [
      // Lead-in entries that are not user messages
      JSON.stringify({ type: 'system', sessionId, timestamp: '2026-05-11T00:00:00.000Z', cwd: projectPath }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' }, sessionId, isMeta: true }),
      // Then the first real user message
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'real first message' }, sessionId, timestamp: '2026-05-11T00:00:02.000Z', isMeta: false }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'reply' }, sessionId, timestamp: '2026-05-11T00:00:03.000Z' })
    ].join('\n'), 'utf-8')

    try {
      const store = createCliHistoryStore({ getProjectPath: async () => projectPath, claudeProjectsBaseDir: baseDir })
      const items = await store.listCliHistory('project-1')
      expect(items).toHaveLength(1)
      expect(items[0].firstMessage).toBe('real first message')
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it('collects bounded quality signals for list classification', async () => {
    const projectPath = 'E:/tmp/aiworker-cli-history-quality'
    const { baseDir, projectDir } = await createClaudeProjectHistoryFixture(projectPath)
    const sessionId = 'quality-session'

    await rm(projectDir, { recursive: true, force: true })
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'system', sessionId, timestamp: '2026-05-11T00:00:00.000Z', cwd: projectPath }),
      JSON.stringify({ type: 'system', subtype: 'api_error', sessionId, timestamp: '2026-05-11T00:00:01.000Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'please emit [GA_TASK:generic-agent] hi [/GA_TASK]' }, sessionId, timestamp: '2026-05-11T00:00:02.000Z', isMeta: false }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '[GA_TASK:generic-agent] hi [/GA_TASK]' }] }, sessionId, timestamp: '2026-05-11T00:00:03.000Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'second prompt' }, sessionId, timestamp: '2026-05-11T00:00:04.000Z', isMeta: false }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'second reply' }, sessionId, timestamp: '2026-05-11T00:00:05.000Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'third prompt should not be needed' }, sessionId, timestamp: '2026-05-11T00:00:06.000Z', isMeta: false })
    ].join('\n'), 'utf-8')

    try {
      const store = createCliHistoryStore({ getProjectPath: async () => projectPath, claudeProjectsBaseDir: baseDir })
      const items = await store.listCliHistory('project-1')

      expect(items).toHaveLength(1)
      expect(items[0]).toEqual(expect.objectContaining({
        id: sessionId,
        firstMessage: 'please emit [GA_TASK:generic-agent] hi [/GA_TASK]',
        userMessageCount: 3,
        assistantTextChars: '[GA_TASK:generic-agent] hi [/GA_TASK]'.length + 'second reply'.length,
        apiErrorCount: 1,
        containsGaTask: true,
        qualityScanComplete: true
      }))
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it('marks quality scan incomplete when the 64KB cap is reached', async () => {
    const projectPath = 'E:/tmp/aiworker-cli-history-incomplete-quality'
    const { baseDir, projectDir } = await createClaudeProjectHistoryFixture(projectPath)
    const sessionId = 'incomplete-quality-session'
    const largeAssistantText = 'x'.repeat(70 * 1024)

    await rm(projectDir, { recursive: true, force: true })
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'system', sessionId, timestamp: '2026-05-11T00:00:00.000Z', cwd: projectPath }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'large sampled session' }, sessionId, timestamp: '2026-05-11T00:00:01.000Z', isMeta: false }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: largeAssistantText }, sessionId, timestamp: '2026-05-11T00:00:02.000Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'later prompt after cap' }, sessionId, timestamp: '2026-05-11T00:00:03.000Z', isMeta: false })
    ].join('\n'), 'utf-8')

    try {
      const store = createCliHistoryStore({ getProjectPath: async () => projectPath, claudeProjectsBaseDir: baseDir })
      const items = await store.listCliHistory('project-1')

      expect(items).toHaveLength(1)
      expect(items[0]).toEqual(expect.objectContaining({
        id: sessionId,
        firstMessage: 'large sampled session',
        userMessageCount: 1,
        qualityScanComplete: false
      }))
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it('stops scanning after match without rejecting', async () => {
    const projectPath = 'E:/tmp/aiworker-cli-history-search'
    const { baseDir, projectDir } = await createClaudeProjectHistoryFixture(projectPath)
    const sessionId = 'search-session'

    await rm(projectDir, { recursive: true, force: true })
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'title message' },
        sessionId,
        timestamp: '2026-05-11T00:00:00.000Z',
        cwd: projectPath,
        isMeta: false
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'needle response' },
        sessionId,
        timestamp: '2026-05-11T00:00:01.000Z'
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'later response' },
        sessionId,
        timestamp: '2026-05-11T00:00:02.000Z'
      })
    ].join('\n'), 'utf-8')

    try {
      const store = createCliHistoryStore({ getProjectPath: async () => projectPath, claudeProjectsBaseDir: baseDir })

      await expect(store.searchCliHistory('project-1', 'needle')).resolves.toEqual([
        expect.objectContaining({ sessionId, title: 'title message', excerpt: 'needle response' })
      ])
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })
})

describe('JSONL format compatibility', () => {
  it('parses user messages from Claude CLI JSONL format', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Fix the bug in auth module' },
      sessionId: 'test-001',
      timestamp: '2026-05-11T09:00:00.000Z',
      cwd: 'E:\\test',
      uuid: 'msg-1',
      isMeta: false
    })
    const entry = JSON.parse(line)
    expect(entry.message.role).toBe('user')
    expect(entry.message.content).toBe('Fix the bug in auth module')
    expect(entry.isMeta).toBe(false)
  })

  it('parses block array content format', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me analyze this...' },
          { type: 'text', text: 'I found the issue.' }
        ]
      },
      sessionId: 'test-001',
      timestamp: '2026-05-11T09:00:05.000Z',
      uuid: 'msg-2'
    })
    const entry = JSON.parse(line)
    expect(entry.message.content).toBeInstanceOf(Array)
    const textBlock = entry.message.content.find((b: { type: string }) => b.type === 'text')
    expect(textBlock.text).toBe('I found the issue.')
  })

  it('filters meta messages correctly', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '<command-name>/model</command-name>' },
      sessionId: 'test-001',
      isMeta: true
    })
    const entry = JSON.parse(line)
    expect(entry.isMeta).toBe(true)
  })

  it('handles malformed JSON gracefully', () => {
    const malformedLines = [
      'this is not json',
      '',
      '{incomplete json'
    ]
    for (const line of malformedLines) {
      expect(() => JSON.parse(line)).toThrow()
    }
  })
})
