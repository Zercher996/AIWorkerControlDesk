import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CurrentClaudeConfig } from '../../src/types/workerDesk'

const AUTH_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const
const MODEL_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL'
] as const

function toStringEnv(env: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!env) return result
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') result[key] = value
  }
  return result
}

export function getDefaultClaudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

export async function readCurrentClaudeConfigFromFile(filePath: string): Promise<CurrentClaudeConfig> {
  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as { env?: Record<string, unknown> }
  const env = toStringEnv(parsed.env)
  const apiKeySource = AUTH_KEYS.find((key) => env[key])
  if (!apiKeySource) {
    throw new Error('当前 Claude 配置缺少认证信息')
  }
  const baseUrl = env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    throw new Error('当前 Claude 配置缺少 ANTHROPIC_BASE_URL')
  }
  const model = MODEL_KEYS.map((key) => env[key]).find(Boolean)
  return {
    source: 'current-claude-config',
    baseUrl,
    model,
    apiKeySource,
    env
  }
}

export function readCurrentClaudeConfig(filePath = getDefaultClaudeSettingsPath()): Promise<CurrentClaudeConfig> {
  return readCurrentClaudeConfigFromFile(filePath)
}
