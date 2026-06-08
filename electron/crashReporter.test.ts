import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachWindowCrashGuards, safeAppendCrashEvent } from './crashReporter'

function uniquePath(): string {
  return join(tmpdir(), `ai-worker-crash-${Date.now()}-${Math.random().toString(16).slice(2)}`)
}

async function readEvents(filePath: string) {
  const raw = await readFile(filePath, 'utf-8')
  return raw.trim().split('\n').map((line) => JSON.parse(line))
}

describe('crashReporter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('writes crash events as jsonl', async () => {
    const dir = uniquePath()
    const filePath = join(dir, 'crash-events.jsonl')

    safeAppendCrashEvent(filePath, {
      type: 'uncaughtException',
      occurredAt: '2026-05-27T00:00:00.000Z',
      message: 'boom',
      stack: 'Error: boom'
    })

    const events = await readEvents(filePath)
    expect(events).toEqual([{ type: 'uncaughtException', occurredAt: '2026-05-27T00:00:00.000Z', message: 'boom', stack: 'Error: boom' }])
    await rm(dir, { recursive: true, force: true })
  })

  it('does not throw when writing fails', async () => {
    const dir = uniquePath()
    await mkdir(dir, { recursive: true })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() => safeAppendCrashEvent(dir, {
      type: 'unhandledRejection',
      occurredAt: '2026-05-27T00:00:00.000Z',
      message: 'not writable'
    })).not.toThrow()

    expect(consoleError).toHaveBeenCalled()
    await rm(dir, { recursive: true, force: true })
  })

  it('records renderer and child process crash events from BrowserWindow webContents', async () => {
    const dir = uniquePath()
    const filePath = join(dir, 'crash-events.jsonl')
    const webContents = new EventEmitter()
    const window = { webContents } as never

    attachWindowCrashGuards(window, filePath)
    webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 })
    webContents.emit('child-process-gone', {}, { reason: 'killed', exitCode: 9, serviceName: 'Utility', name: 'network' })

    const events = await readEvents(filePath)
    expect(events).toMatchObject([
      { type: 'render-process-gone', reason: 'crashed', exitCode: 139 },
      { type: 'child-process-gone', reason: 'killed', exitCode: 9, serviceName: 'Utility', name: 'network' }
    ])
    await rm(dir, { recursive: true, force: true })
  })
})
