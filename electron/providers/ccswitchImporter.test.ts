import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { ProviderCatalog, SafeProviderCatalog } from '../../src/types/workerDesk'
import { convertCcswitchProvider, importCcswitchClaudeProviders, listCcswitchClaudeProviderPreviews } from './ccswitchImporter'

const baseRow = {
  id: 'provider-1',
  name: 'CCswitch Test',
  is_current: 1,
  settings_config: JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: 'test-provider-secret',
      ANTHROPIC_BASE_URL: 'https://relay.example',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-7',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '6000'
    },
    skipDangerousModePermissionPrompt: true,
    enabledPlugins: { ignored: true }
  })
}

const emptySafeCatalog: SafeProviderCatalog = { version: 2, providers: [] }

function createCcswitchDb(rows: Array<{ id: string; name: string; env: Record<string, string>; isCurrent?: number }>): { dbPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'ccswitch-importer-'))
  const dbPath = join(dir, 'cc-switch.db')
  const db = new DatabaseSync(dbPath)
  db.exec("CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, app_type TEXT, settings_config TEXT, is_current INTEGER, sort_index INTEGER, created_at TEXT)")
  const insert = db.prepare("INSERT INTO providers (id, name, app_type, settings_config, is_current, sort_index, created_at) VALUES (?, ?, 'claude', ?, ?, ?, ?)")
  rows.forEach((row, index) => {
    insert.run(row.id, row.name, JSON.stringify({ env: row.env }), row.isCurrent ?? 0, index, `2026-05-23T00:00:0${index}.000Z`)
  })
  db.close()
  return {
    dbPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

function createMemoryStore(initial: ProviderCatalog = { version: 2, providers: [] }) {
  let catalog = initial
  return {
    async loadProviderCatalog() {
      return catalog
    },
    async listProviderCatalogSafe() {
      return {
        version: 2 as const,
        providers: catalog.providers.map((provider) => ({
          ...provider,
          auth: { type: 'api-key' as const, hasApiKey: true, apiKeyPreview: 'sk-***cret' }
        }))
      }
    },
    async saveProviderCatalog(next: ProviderCatalog) {
      catalog = next
      return this.listProviderCatalogSafe()
    },
    async saveProviderCatalogPatch() {
      throw new Error('unused')
    }
  }
}

describe('ccswitchImporter', () => {
  it('converts a CCswitch Claude provider into a ProviderProfile without plugin fields', () => {
    const result = convertCcswitchProvider(baseRow)

    expect(result?.provider).toMatchObject({
      id: 'ccswitch:provider-1',
      name: 'CCswitch Test',
      protocol: 'anthropic-compatible',
      auth: { type: 'api-key', apiKey: 'test-provider-secret' },
      endpoint: { baseUrl: 'https://relay.example' },
      model: { id: 'claude-sonnet-4-6' },
      adapters: {
        claudeCode: {
          enabled: true,
          permissionMode: 'bypassPermissions',
          apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN',
          useSettingsEnv: true,
          extraEnv: {
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-7',
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: '6000'
          }
        },
        genericAgent: {
          enabled: false,
          sessionType: 'native_claude'
        }
      }
    })
    expect(result?.provider).not.toHaveProperty('enabledPlugins')
  })

  it('uses anthropic protocol only for official API key and official base URL', () => {
    const result = convertCcswitchProvider({
      ...baseRow,
      settings_config: JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-secret',
          ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
          ANTHROPIC_MODEL: 'claude-opus-4-7'
        }
      })
    })

    expect(result?.provider.protocol).toBe('anthropic')
    expect(result?.provider.adapters?.claudeCode?.apiKeyEnv).toBe('ANTHROPIC_API_KEY')
  })

  it('skips invalid JSON and providers missing required env', () => {
    expect(convertCcswitchProvider({ ...baseRow, settings_config: '{broken' })).toBeUndefined()
    expect(convertCcswitchProvider({
      ...baseRow,
      settings_config: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-secret' } })
    })).toBeUndefined()
  })

  it('returns empty previews when CCswitch database is missing', () => {
    expect(listCcswitchClaudeProviderPreviews(emptySafeCatalog, '/path/that/does/not/exist.db')).toEqual([])
  })

  it('returns masked previews from CCswitch without exposing API keys', () => {
    const db = createCcswitchDb([{
      id: 'provider-preview',
      name: 'Preview Provider',
      isCurrent: 1,
      env: {
        ANTHROPIC_AUTH_TOKEN: 'test-preview-secret',
        ANTHROPIC_BASE_URL: 'https://relay.example',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6'
      }
    }])
    try {
      const previews = listCcswitchClaudeProviderPreviews(emptySafeCatalog, db.dbPath)

      expect(previews).toEqual([{
        id: 'provider-preview',
        name: 'Preview Provider',
        baseUrl: 'https://relay.example',
        model: 'claude-sonnet-4-6',
        apiKeyPreview: 'tes***cret',
        isCurrent: true,
        alreadyExists: false
      }])
      expect(JSON.stringify(previews)).not.toContain('test-preview-secret')
    } finally {
      db.cleanup()
    }
  })

  it('merges CCswitch Claude rows with the same connection into one v2 provider with multiple models', async () => {
    const db = createCcswitchDb([
      {
        id: 'provider-sonnet',
        name: 'Relay Sonnet',
        env: {
          ANTHROPIC_AUTH_TOKEN: 'test-provider-secret',
          ANTHROPIC_BASE_URL: 'https://relay.example',
          ANTHROPIC_MODEL: 'claude-sonnet-4-6'
        }
      },
      {
        id: 'provider-opus',
        name: 'Relay Opus',
        env: {
          ANTHROPIC_AUTH_TOKEN: 'test-provider-secret',
          ANTHROPIC_BASE_URL: 'https://relay.example',
          ANTHROPIC_MODEL: 'claude-opus-4-7'
        }
      }
    ])
    try {
      const store = createMemoryStore()
      const safeCatalog = await importCcswitchClaudeProviders(['provider-sonnet', 'provider-opus'], store, db.dbPath)

      expect(safeCatalog.providers).toHaveLength(1)
      expect(safeCatalog.providers[0].apiFormat).toBe('anthropic')
      expect(safeCatalog.providers[0].models.map((model) => model.id)).toEqual(['claude-sonnet-4-6', 'claude-opus-4-7'])
      expect(safeCatalog.providers[0].models.every((model) => model.apiFormat === 'anthropic')).toBe(true)
      expect(safeCatalog.providers[0].models.map((model) => model.source)).toEqual([
        { type: 'ccswitch', providerId: 'provider-sonnet', appType: 'claude', modelId: 'claude-sonnet-4-6' },
        { type: 'ccswitch', providerId: 'provider-opus', appType: 'claude', modelId: 'claude-opus-4-7' }
      ])
      expect(JSON.stringify(safeCatalog)).not.toContain('test-provider-secret')
      expect(safeCatalog.providers[0].defaults?.modelId).toBe('claude-sonnet-4-6')
    } finally {
      db.cleanup()
    }
  })
})
