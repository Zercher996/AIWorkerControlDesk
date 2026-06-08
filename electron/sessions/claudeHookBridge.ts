import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionAttentionEvent } from '../../src/types/workerDesk'
import { buildClaudeHookSettings, type ClaudeHookSettings } from './claudeHookSettings'

const hookStateByName = {
  Stop: 'needsReview',
  Notification: 'needsReview',
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working'
} as const

type RawHookEvent = {
  sessionId?: unknown
  hookName?: unknown
  occurredAt?: unknown
}

type HookRegistration = {
  eventFilePath: string
  settings: ClaudeHookSettings
  dispose(): void
}

type ClaudeHookBridgeInput = {
  rootDir: string
  pollIntervalMs?: number
  onEvent(event: SessionAttentionEvent): void
}

function normalizeHookEvent(raw: RawHookEvent, sessionId: string): SessionAttentionEvent | undefined {
  if (raw.sessionId !== sessionId) return undefined
  if (typeof raw.hookName !== 'string' || !(raw.hookName in hookStateByName)) return undefined
  const hookName = raw.hookName as keyof typeof hookStateByName
  return {
    sessionId,
    state: hookStateByName[hookName],
    source: 'claude-code-hook',
    hookName,
    occurredAt: typeof raw.occurredAt === 'string' ? raw.occurredAt : new Date().toISOString()
  }
}

async function ensureFile(filePath: string): Promise<void> {
  const file = await open(filePath, 'a')
  await file.close()
}

export function createClaudeHookBridge(input: ClaudeHookBridgeInput) {
  const pollIntervalMs = input.pollIntervalMs ?? 200
  const disposers = new Set<() => void>()

  return {
    async registerSession(sessionId: string): Promise<HookRegistration> {
      await mkdir(input.rootDir, { recursive: true })
      const eventFilePath = join(input.rootDir, `${sessionId}.jsonl`)
      await writeFile(eventFilePath, '')
      await ensureFile(eventFilePath)
      let offset = 0
      let disposed = false

      const readNewEvents = async () => {
        if (disposed) return
        let content: string
        try {
          content = await readFile(eventFilePath, 'utf8')
        } catch {
          return
        }
        if (content.length <= offset) return
        const chunk = content.slice(offset)
        offset = content.length
        for (const line of chunk.split(/\r?\n/)) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const event = normalizeHookEvent(JSON.parse(trimmed) as RawHookEvent, sessionId)
            if (event) input.onEvent(event)
          } catch {
            continue
          }
        }
      }

      const timer = setInterval(() => {
        void readNewEvents()
      }, pollIntervalMs)

      const dispose = () => {
        if (disposed) return
        disposed = true
        clearInterval(timer)
        disposers.delete(dispose)
      }
      disposers.add(dispose)

      return { eventFilePath, settings: buildClaudeHookSettings({ sessionId, eventFilePath }), dispose }
    },
    dispose(): void {
      for (const dispose of [...disposers]) dispose()
      disposers.clear()
    }
  }
}
