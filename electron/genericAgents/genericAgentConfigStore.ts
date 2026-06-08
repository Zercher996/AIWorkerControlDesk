import type { GenericAgentConfig } from '../../src/types/workerDesk'
import { readJsonFile } from '../storage/jsonStore'

type RawConfig = Omit<GenericAgentConfig, 'pythonCommand' | 'entryScript' | 'env'> & {
  pythonCommand?: string
  entryScript?: string
  env?: Record<string, string>
}

export async function loadGenericAgentConfigs(sourcePath: string): Promise<GenericAgentConfig[]> {
  const rawConfigs = await readJsonFile<RawConfig[]>(sourcePath, [])
  if (!Array.isArray(rawConfigs)) {
    throw new Error('GenericAgent config file must contain an array')
  }
  return rawConfigs.map((config) => normalizeConfig(config))
}

function normalizeConfig(config: RawConfig): GenericAgentConfig {
  requireString(config.id, 'id')
  requireString(config.name, 'name')
  requireString(config.home, 'home')

  if (config.env && (typeof config.env !== 'object' || Array.isArray(config.env))) {
    throw new Error(`GenericAgent config ${config.id} has invalid env`)
  }
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      if (typeof value !== 'string') {
        throw new Error(`GenericAgent config ${config.id} env key ${key} must be a string`)
      }
    }
  }

  return {
    id: config.id,
    name: config.name,
    home: config.home,
    pythonCommand: config.pythonCommand ?? 'python',
    entryScript: config.entryScript ?? 'agentmain.py',
    env: config.env ?? {}
  }
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`GenericAgent config missing ${field}`)
  }
}
