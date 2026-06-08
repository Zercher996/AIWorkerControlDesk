import path from 'node:path'
import fs from 'node:fs'
import type { GenericAgentConfig } from '../../src/types/workerDesk'
import type { ManagedPtyProcess } from './claudePty'
import { startPtyProcess } from './claudePty'

type GenericAgentCommandInput = {
  config: GenericAgentConfig
  cwd: string
}

export type GenericAgentLaunchConfig = {
  command: { file: string; args: string[]; cwd: string }
  env: NodeJS.ProcessEnv
  providerConfigJson: string
}

type StartGenericAgentPtyInput = {
  config: GenericAgentConfig
  cwd: string
  cols: number
  rows: number
  initialPrompt?: string
  launchConfig?: GenericAgentLaunchConfig
  onData(chunk: string): void
  onExit(event: { exitCode: number; signal?: number }): void
}

export type GenericAgentProcessStarter = (input: {
  file: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  cols: number
  rows: number
  onData(chunk: string): void
  onExit(event: { exitCode: number; signal?: number }): void
}) => ManagedPtyProcess

function resolveEntryScript(config: GenericAgentConfig): string {
  const entry = config.entryScript
    ? (path.isAbsolute(config.entryScript)
        ? config.entryScript
        : path.join(config.home, config.entryScript))
    : path.join(config.home, 'agentmain.py')

  if (!fs.existsSync(entry)) {
    throw new Error(`GenericAgent entry script not found: ${entry}`)
  }

  return entry
}

export function buildGenericAgentCommand(input: GenericAgentCommandInput): { file: string; args: string[]; cwd: string } {
  const pythonCommand = input.config.pythonCommand || 'python'
  const entry = resolveEntryScript(input.config)
  const args = [entry]

  return {
    file: pythonCommand,
    args,
    cwd: input.config.home
  }
}

export function buildGenericAgentEnv(config: GenericAgentConfig, baseEnv: NodeJS.ProcessEnv, providerConfigJson?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...config.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONWARNINGS: 'ignore',
    GA_LANG: 'zh'
  }
  if (providerConfigJson) {
    env.GENERIC_AGENT_PROVIDER_CONFIG_JSON = providerConfigJson
  }
  return env
}

export function createGenericAgentStarter(startProcess: GenericAgentProcessStarter) {
  return function startGenericAgentPty(input: StartGenericAgentPtyInput): ManagedPtyProcess {
    const command = input.launchConfig
      ? input.launchConfig.command
      : buildGenericAgentCommand({ config: input.config, cwd: input.cwd })
    const env = input.launchConfig
      ? buildGenericAgentEnv(input.config, process.env, input.launchConfig.providerConfigJson)
      : buildGenericAgentEnv(input.config, process.env)
    const child = startProcess({
      file: command.file,
      args: command.args,
      cwd: command.cwd,
      env: input.launchConfig ? { ...env, ...input.launchConfig.env } : env,
      cols: input.cols,
      rows: input.rows,
      onData: input.onData,
      onExit: input.onExit
    })

    if (input.initialPrompt) {
      child.write(input.initialPrompt + String.fromCharCode(13))
    }

    return child
  }
}

export const startGenericAgentPty = createGenericAgentStarter(startPtyProcess)
