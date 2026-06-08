import path from 'node:path'

function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/')
}
import type { GenericAgentConfig, ProviderProfile, GenericAgentSessionType, ProviderModel } from '../../src/types/workerDesk'
import { resolveProviderModel, validateProviderForWorker } from './providerValidation'

export type GenericAgentLaunchConfig = {
  command: {
    file: string
    args: string[]
    cwd: string
  }
  env: Record<string, string>
  providerConfigJson: string
}

type ProviderConfig = {
  sessionType: GenericAgentSessionType
  config: Record<string, string | number | boolean>
}

type BuildProviderConfigInput = {
  provider: ProviderProfile
  model: ProviderModel
}

type BuildGenericAgentLaunchConfigInput = {
  provider: ProviderProfile
  model?: ProviderModel
  genericAgent: GenericAgentConfig
}

export function buildProviderConfig(input: BuildProviderConfigInput): ProviderConfig {
  const { provider, model } = input
  validateProviderForWorker(provider, 'generic-agent', model)
  const ga = provider.adapters?.genericAgent
  if (!ga) {
    throw new Error('missing GenericAgent adapter config')
  }

  const config: Record<string, string | number | boolean> = {
    name: ga.name ?? provider.name,
    apikey: provider.auth.apiKey,
    apibase: provider.endpoint.baseUrl,
    model: model.id,
  }

  if (ga.sessionType === 'native_claude') {
    if (ga.fakeCcSystemPrompt !== undefined) {
      config.fake_cc_system_prompt = ga.fakeCcSystemPrompt
    }
    if (ga.thinkingType !== undefined) {
      config.thinking_type = ga.thinkingType
    }
  }

  if (ga.sessionType === 'native_oai') {
    if (ga.apiMode !== undefined) {
      config.api_mode = ga.apiMode
    }
    if (ga.reasoningEffort !== undefined) {
      config.reasoning_effort = ga.reasoningEffort
    }
  }

  if (ga.thinkingBudgetTokens !== undefined) {
    config.thinking_budget_tokens = ga.thinkingBudgetTokens
  }

  if (ga.contextWindow !== undefined) {
    config.context_win = ga.contextWindow
  }
  if (ga.maxTokens !== undefined) {
    config.max_tokens = ga.maxTokens
  }
  if (ga.temperature !== undefined) {
    config.temperature = ga.temperature
  }
  if (ga.userAgent !== undefined) {
    config.user_agent = ga.userAgent
  }

  if (ga.extraConfig) {
    for (const [k, v] of Object.entries(ga.extraConfig)) {
      config[k] = v
    }
  }

  return {
    sessionType: ga.sessionType,
    config,
  }
}

export function buildGenericAgentLaunchConfig(input: BuildGenericAgentLaunchConfigInput): GenericAgentLaunchConfig {
  const { provider, genericAgent } = input
  const model = input.model ?? resolveProviderModel(provider, undefined, 'genericAgent')

  const providerConfig = buildProviderConfig({ provider, model })
  const providerConfigJson = JSON.stringify(providerConfig)

  const entryScriptPath = toPosixPath(
    path.isAbsolute(genericAgent.entryScript)
      ? genericAgent.entryScript
      : path.join(genericAgent.home, genericAgent.entryScript)
  )

  const env: Record<string, string> = {
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    GA_LANG: 'zh',
    ...genericAgent.env,
    GENERIC_AGENT_PROVIDER_CONFIG_JSON: providerConfigJson,
  }

  return {
    command: {
      file: genericAgent.pythonCommand,
      args: [entryScriptPath],
      cwd: genericAgent.home,
    },
    env,
    providerConfigJson,
  }
}
