import type { ProviderProfile, PermissionMode, ProviderModel } from '../../src/types/workerDesk'
import { resolveProviderModel, validateProviderForWorker } from './providerValidation'

export type ClaudeCodeLaunchConfig = {
  env: Record<string, string>
  command: {
    file: string
    args: string[]
  }
  permissionMode: PermissionMode
  model: string
}

export type ClaudeCodeSettingsPatch = Record<string, unknown>

export function withClaudeCodeSettings(config: ClaudeCodeLaunchConfig, patch: ClaudeCodeSettingsPatch): ClaudeCodeLaunchConfig {
  const settingsIndex = config.command.args.indexOf('--settings')
  if (settingsIndex < 0 || settingsIndex + 1 >= config.command.args.length) return config
  const currentSettings = JSON.parse(config.command.args[settingsIndex + 1]) as Record<string, unknown>
  const nextArgs = [...config.command.args]
  nextArgs[settingsIndex + 1] = JSON.stringify({ ...currentSettings, ...patch })
  return {
    ...config,
    command: {
      ...config.command,
      args: nextArgs
    }
  }
}

const CLAUDE_AUTH_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const

function removeClaudeAuthEnv(env: Record<string, string>): void {
  for (const key of CLAUDE_AUTH_ENV_KEYS) {
    delete env[key]
  }
}

type BuildClaudeCodeLaunchConfigInput = ProviderProfile | {
  provider: ProviderProfile
  model: ProviderModel
}

function normalizeInput(input: BuildClaudeCodeLaunchConfigInput): { provider: ProviderProfile; model: ProviderModel } {
  if ('provider' in input) return input
  return { provider: input, model: resolveProviderModel(input, undefined, 'claudeCode') }
}

export function buildClaudeCodeLaunchConfigFromEnv(env: Record<string, string>, permissionMode: PermissionMode = 'default'): ClaudeCodeLaunchConfig {
  const settingsJson = JSON.stringify({ env })
  return {
    env: { ...env },
    command: {
      file: 'claude',
      args: [
        '--settings',
        settingsJson,
        '--permission-mode',
        permissionMode,
      ]
    },
    permissionMode,
    model: env.ANTHROPIC_MODEL ?? env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? ''
  }
}

export function buildClaudeCodeLaunchConfig(input: BuildClaudeCodeLaunchConfigInput): ClaudeCodeLaunchConfig {
  const { provider, model } = normalizeInput(input)
  validateProviderForWorker(provider, 'claude-code', model)
  const cc = provider.adapters?.claudeCode
  if (!cc) {
    throw new Error('missing Claude Code adapter config')
  }

  const apiKeyEnv = cc.apiKeyEnv ?? (provider.protocol === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN')
  const modelId = model.id

  const env: Record<string, string> = {
    ...(cc.extraEnv ?? {}),
  }
  removeClaudeAuthEnv(env)
  env[apiKeyEnv] = provider.auth.apiKey
  env.ANTHROPIC_BASE_URL = provider.endpoint.baseUrl
  env.ANTHROPIC_MODEL = modelId

  const settingsJson = JSON.stringify({ env })

  return {
    env,
    command: {
      file: 'claude',
      args: [
        '--settings',
        settingsJson,
        '--permission-mode',
        cc.permissionMode,
      ],
    },
    permissionMode: cc.permissionMode,
    model: modelId,
  }
}
