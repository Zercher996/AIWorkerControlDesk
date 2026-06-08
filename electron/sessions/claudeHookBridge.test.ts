import { mkdtemp, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClaudeHookBridge } from './claudeHookBridge'

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe('createClaudeHookBridge', () => {
  it('maps Claude Code Stop and Notification hooks to needs review events', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aiwcd-hooks-'))
    const onEvent = vi.fn()
    const bridge = createClaudeHookBridge({ rootDir: tempDir, onEvent, pollIntervalMs: 10 })
    const registration = await bridge.registerSession('session-1')

    await appendFile(registration.eventFilePath, `${JSON.stringify({ sessionId: 'session-1', hookName: 'Stop', occurredAt: '2026-05-25T00:00:00.000Z' })}\n`)

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({
      sessionId: 'session-1',
      state: 'needsReview',
      source: 'claude-code-hook',
      hookName: 'Stop',
      occurredAt: '2026-05-25T00:00:00.000Z'
    }))

    await appendFile(registration.eventFilePath, `${JSON.stringify({ sessionId: 'session-1', hookName: 'Notification', occurredAt: '2026-05-25T00:00:01.000Z' })}\n`)

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({
      sessionId: 'session-1',
      state: 'needsReview',
      source: 'claude-code-hook',
      hookName: 'Notification',
      occurredAt: '2026-05-25T00:00:01.000Z'
    }))

    registration.dispose()
    bridge.dispose()
  })

  it('maps work hooks to working and ignores non-whitelisted fields', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aiwcd-hooks-'))
    const onEvent = vi.fn()
    const bridge = createClaudeHookBridge({ rootDir: tempDir, onEvent, pollIntervalMs: 10 })
    const registration = await bridge.registerSession('session-1')

    await appendFile(registration.eventFilePath, `${JSON.stringify({
      sessionId: 'session-1',
      hookName: 'UserPromptSubmit',
      occurredAt: '2026-05-25T00:00:00.000Z',
      user_prompt: 'do not forward me',
      tool_input: { secret: true }
    })}\n`)

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({
      sessionId: 'session-1',
      state: 'working',
      source: 'claude-code-hook',
      hookName: 'UserPromptSubmit',
      occurredAt: '2026-05-25T00:00:00.000Z'
    }))
    expect(onEvent.mock.calls[0][0]).not.toHaveProperty('user_prompt')
    expect(onEvent.mock.calls[0][0]).not.toHaveProperty('tool_input')

    registration.dispose()
    bridge.dispose()
  })

  it('ignores unknown hook names and stops after dispose', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aiwcd-hooks-'))
    const onEvent = vi.fn()
    const bridge = createClaudeHookBridge({ rootDir: tempDir, onEvent, pollIntervalMs: 10 })
    const registration = await bridge.registerSession('session-1')

    await appendFile(registration.eventFilePath, `${JSON.stringify({ sessionId: 'session-1', hookName: 'BadHook', occurredAt: '2026-05-25T00:00:00.000Z' })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(onEvent).not.toHaveBeenCalled()

    registration.dispose()
    await appendFile(registration.eventFilePath, `${JSON.stringify({ sessionId: 'session-1', hookName: 'Stop', occurredAt: '2026-05-25T00:00:01.000Z' })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(onEvent).not.toHaveBeenCalled()

    bridge.dispose()
  })
})
