import type { PermissionMode } from '../../src/types/workerDesk'

// Legacy Profile type - kept locally since Profile was removed from shared types
type Profile = {
  id: string
  name: string
  provider: string
  model: string
  env: Record<string, string>
  permissionMode: PermissionMode
  sourcePath: string
}

// Inline types for ProviderProfile (not yet in src/types/workerDesk.ts)
export type ProviderProtocol = 'anthropic' | 'anthropic-compatible' | 'openai-compatible'

export type ProviderAuth = {
  type: 'api-key'
  apiKey: string
}

export type ProviderEndpoint = {
  baseUrl: string
}

export type ProviderModel = {
  id: string
  displayName?: string
}

export type ClaudeCodeProviderOptions = {
  enabled: boolean
  permissionMode: PermissionMode
  apiKeyEnv?: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN'
  useSettingsEnv: true
  extraEnv?: Record<string, string>
}

export type GenericAgentSessionType = 'native_claude' | 'native_oai'

export type GenericAgentProviderOptions = {
  enabled: boolean
  sessionType: GenericAgentSessionType
  name?: string
  apiMode?: 'chat_completions' | 'responses'
  fakeCcSystemPrompt?: boolean
  thinkingType?: 'adaptive' | 'enabled' | 'disabled'
  thinkingBudgetTokens?: number
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  contextWindow?: number
  maxTokens?: number
  temperature?: number
  userAgent?: string
  extraConfig?: Record<string, string | number | boolean>
}

export type ProviderProfile = {
  id: string
  name: string
  protocol: ProviderProtocol
  auth: ProviderAuth
  endpoint: ProviderEndpoint
  model: ProviderModel
  defaults?: {
    timeoutSeconds?: number
    readTimeoutSeconds?: number
    maxRetries?: number
    stream?: boolean
    proxy?: string
  }
  adapters?: {
    claudeCode?: ClaudeCodeProviderOptions
    genericAgent?: GenericAgentProviderOptions
  }
  notes?: string
}

const CORE_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
])

function mapProviderToProtocol(provider: string): ProviderProtocol {
  if (provider === 'anthropic') return 'anthropic'
  if (provider === 'anthropic-compatible') return 'anthropic-compatible'
  if (provider === 'openai-compatible') return 'openai-compatible'
  // Default fallback for unknown strings: treat as anthropic-compatible
  return 'anthropic-compatible'
}

function resolveApiKeyEnv(protocol: ProviderProtocol, env: Record<string, string>): { apiKey: string; apiKeyEnv: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' } {
  if (protocol === 'anthropic') {
    const key = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || ''
    return { apiKey: key, apiKeyEnv: 'ANTHROPIC_API_KEY' }
  }
  // anthropic-compatible and openai-compatible: prefer AUTH_TOKEN, fallback to API_KEY
  if (env.ANTHROPIC_AUTH_TOKEN) {
    return { apiKey: env.ANTHROPIC_AUTH_TOKEN, apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN' }
  }
  if (env.ANTHROPIC_API_KEY) {
    return { apiKey: env.ANTHROPIC_API_KEY, apiKeyEnv: 'ANTHROPIC_API_KEY' }
  }
  return { apiKey: '', apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN' }
}

function resolveBaseUrl(env: Record<string, string>): string {
  return env.ANTHROPIC_BASE_URL || ''
}

function resolveModelId(profile: Profile): string {
  return profile.env.ANTHROPIC_MODEL || profile.model || ''
}

function buildExtraEnv(env: Record<string, string>): Record<string, string> {
  const extra: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!CORE_ENV_KEYS.has(key)) {
      extra[key] = value
    }
  }
  return extra
}

function resolveGenericAgentSessionType(protocol: ProviderProtocol): GenericAgentSessionType {
  if (protocol === 'openai-compatible') return 'native_oai'
  return 'native_claude'
}

export function legacyProfileToProviderProfile(profile: Profile): ProviderProfile {
  const protocol = mapProviderToProtocol(profile.provider)
  const { apiKey, apiKeyEnv } = resolveApiKeyEnv(protocol, profile.env)
  const baseUrl = resolveBaseUrl(profile.env)
  const modelId = resolveModelId(profile)
  const extraEnv = buildExtraEnv(profile.env)

  const claudeCodeAdapter: ClaudeCodeProviderOptions = {
    enabled: true,
    permissionMode: profile.permissionMode,
    apiKeyEnv,
    useSettingsEnv: true,
    ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
  }

  const genericAgentAdapter: GenericAgentProviderOptions = {
    enabled: false,
    sessionType: resolveGenericAgentSessionType(protocol),
  }

  return {
    id: `legacy:${profile.id}`,
    name: profile.name,
    protocol,
    auth: { type: 'api-key', apiKey },
    endpoint: { baseUrl },
    model: { id: modelId },
    adapters: {
      claudeCode: claudeCodeAdapter,
      genericAgent: genericAgentAdapter,
    },
  }
}
