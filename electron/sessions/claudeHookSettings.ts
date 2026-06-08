import { appendFileSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { ClaudeHookEventName } from '../../src/types/workerDesk'

const hookNames: ClaudeHookEventName[] = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification']

type ClaudeHookCommandInput = {
  sessionId: string
  eventFilePath: string
}

type ClaudeHookMatcher = {
  matcher: string
  hooks: Array<{ type: 'command'; command: string }>
}

export type ClaudeHookSettings = {
  hooks: Record<ClaudeHookEventName, ClaudeHookMatcher[]>
}

export function resolveHookNodeExecutable(): string {
  const npmNodeExecPath = process.env.npm_node_execpath
  if (npmNodeExecPath) return npmNodeExecPath
  const executableName = basename(process.execPath).toLowerCase()
  if (executableName === 'node' || executableName === 'node.exe') return process.execPath
  return 'node'
}

function buildNodeHookCommand(input: ClaudeHookCommandInput, hookName: ClaudeHookEventName): string {
  const script = [
    "const fs=require('fs');",
    "fs.readFileSync(0,'utf8');",
    "const [sessionId,hookName,eventFilePath]=process.argv.slice(1);",
    "const event={sessionId,hookName,occurredAt:new Date().toISOString()};",
    "fs.appendFileSync(eventFilePath,JSON.stringify(event)+'\\n');"
  ].join('')
  const nodeExecutable = resolveHookNodeExecutable()
  return `${JSON.stringify(nodeExecutable)} -e ${JSON.stringify(script)} ${JSON.stringify(input.sessionId)} ${JSON.stringify(hookName)} ${JSON.stringify(input.eventFilePath)}`
}

export function buildClaudeHookSettings(input: ClaudeHookCommandInput): ClaudeHookSettings {
  return {
    hooks: Object.fromEntries(hookNames.map((hookName) => [
      hookName,
      [{ matcher: '*', hooks: [{ type: 'command', command: buildNodeHookCommand(input, hookName) }] }]
    ])) as Record<ClaudeHookEventName, ClaudeHookMatcher[]>
  }
}

export function appendClaudeHookEventForTesting(eventFilePath: string, sessionId: string, hookName: ClaudeHookEventName): void {
  readFileSync(eventFilePath, 'utf8')
  appendFileSync(eventFilePath, `${JSON.stringify({ sessionId, hookName, occurredAt: new Date().toISOString() })}\n`)
}
