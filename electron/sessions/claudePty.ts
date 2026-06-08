import { accessSync, constants } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import * as pty from 'node-pty'
import type { PermissionMode } from '../../src/types/workerDesk'

export type PtyLaunchInput = {
  file: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  cols: number
  rows: number
  onData(chunk: string): void
  onExit(event: { exitCode: number; signal?: number }): void
}

export type ManagedPtyProcess = {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

type ClaudeCommandInput = {
  model: string
  envModel?: string
  env?: Record<string, string>
  permissionMode: PermissionMode
  resumeSessionId?: string
}

function validateModelName(model: string): void {
  if (!/^[A-Za-z0-9._:/-]+$/.test(model)) {
    throw new Error('Invalid model name')
  }
}

export function buildClaudeCommand(input: ClaudeCommandInput): { file: string; args: string[] } {
  validateModelName(input.model)
  if (input.envModel) {
    validateModelName(input.envModel)
  }

  const providerArgs = input.env
    ? ['--settings', JSON.stringify({ env: input.env })]
    : []
  const runArgs = input.envModel
    ? ['--permission-mode', input.permissionMode]
    : ['--model', input.model, '--permission-mode', input.permissionMode]
  const resumeArgs = input.resumeSessionId ? ['--resume', input.resumeSessionId, '--fork-session'] : []
  const args = [...providerArgs, ...runArgs, ...resumeArgs]

  return {
    file: 'claude',
    args
  }
}

const CLAUDE_AUTH_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const

export function buildClaudeProcessEnv(input: {
  baseEnv: NodeJS.ProcessEnv
  launchEnv: Record<string, string>
}): NodeJS.ProcessEnv {
  const hasApiKey = Boolean(input.launchEnv.ANTHROPIC_API_KEY)
  const hasAuthToken = Boolean(input.launchEnv.ANTHROPIC_AUTH_TOKEN)
  if (hasApiKey && hasAuthToken) {
    throw new Error('Claude Code launch env cannot set both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN')
  }

  const env: NodeJS.ProcessEnv = { ...input.baseEnv, ...input.launchEnv }
  if (hasApiKey || hasAuthToken) {
    for (const key of CLAUDE_AUTH_ENV_KEYS) {
      if (!(key in input.launchEnv)) {
        delete env[key]
      }
    }
  }

  return env
}

export function resolveCommandForPty(
  file: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32' || isAbsolute(file) || file.includes('/') || file.includes('\\')) {
    return file
  }

  const pathValue = env.PATH ?? env.Path ?? env.path ?? ''
  const pathExtValue = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  const extensions = extname(file) ? [''] : pathExtValue.split(';').filter(Boolean)

  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${file}${extension.toLowerCase()}`)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        const originalCaseCandidate = join(directory, `${file}${extension}`)
        try {
          accessSync(originalCaseCandidate, constants.X_OK)
          return originalCaseCandidate
        } catch {
          // Continue searching PATH entries.
        }
      }
    }
  }

  return file
}

export type ClaudeCodeLaunchConfig = {
  env: Record<string, string>
  command: { file: string; args: string[] }
  permissionMode: PermissionMode
  model: string
}

export function startClaudePty(input: {
  cwd: string
  cols: number
  rows: number
  resumeSessionId?: string
  launchConfig: ClaudeCodeLaunchConfig
  onData(chunk: string): void
  onExit(event: { exitCode: number; signal?: number }): void
}): ManagedPtyProcess {
  if (!input.launchConfig) {
    throw new Error('launchConfig is required')
  }
  const command = input.launchConfig.command
  return startPtyProcess({
    file: command.file,
    args: command.args,
    cwd: input.cwd,
    env: buildClaudeProcessEnv({ baseEnv: process.env, launchEnv: input.launchConfig.env }),
    cols: input.cols,
    rows: input.rows,
    onData: input.onData,
    onExit: input.onExit
  })
}

export function startPtyProcess(input: PtyLaunchInput): ManagedPtyProcess {
  const file = resolveCommandForPty(input.file, input.env)
  const child = pty.spawn(file, input.args, {
    name: 'xterm-256color',
    cols: input.cols,
    rows: input.rows,
    cwd: input.cwd,
    env: input.env,
    encoding: 'utf8'
  })

  child.onData(input.onData)
  child.onExit(input.onExit)

  return {
    pid: child.pid,
    write: (data) => child.write(data),
    resize: (cols, rows) => child.resize(cols, rows),
    kill: () => child.kill()
  }
}