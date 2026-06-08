import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProviderCatalogStore } from './providerCatalogStore'
import type { ProviderCatalog, ProviderCatalogPatch } from '../../src/types/workerDesk'

function catalog(): ProviderCatalog {
  return {
    version: 2,
    providers: [
      {
        id: 'anthropic-direct',
        name: 'Anthropic Direct',
        protocol: 'anthropic',
        apiFormat: 'anthropic',
        auth: { type: 'api-key', apiKey: 'sk-ant-secret' },
        endpoint: { baseUrl: 'https://api.anthropic.com' },
        model: { id: 'claude-opus-4-7' },
        models: [{ id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true }],
        defaults: { modelId: 'claude-opus-4-7' },
        adapters: {
          claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true },
          genericAgent: { enabled: true, sessionType: 'native_claude' }
        }
      }
    ]
  }
}

function v1Catalog() {
  return {
    version: 1,
    providers: [
      {
        id: 'anthropic-direct',
        name: 'Anthropic Direct',
        protocol: 'anthropic',
        auth: { type: 'api-key', apiKey: 'sk-ant-secret' },
        endpoint: { baseUrl: 'https://api.anthropic.com' },
        model: { id: 'claude-opus-4-7' },
        adapters: {
          claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true },
          genericAgent: { enabled: true, sessionType: 'native_claude' }
        }
      }
    ]
  }
}

describe('providerCatalogStore', () => {
  it('loads and returns safe catalog without leaking apiKey', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-catalog-'))
    const filePath = join(dir, 'provider-catalog.json')
    try {
      await writeFile(filePath, JSON.stringify(catalog()), 'utf-8')
      const store = createProviderCatalogStore(filePath)
      const safe = await store.listProviderCatalogSafe()
      expect(safe.version).toBe(2)
      expect(safe.providers).toHaveLength(1)
      const p = safe.providers[0]
      expect(p.auth).toEqual({ type: 'api-key', hasApiKey: true, apiKeyPreview: 'sk-***cret' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('safe catalog preserves Claude Code extraConfig needed by renderer compatibility', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-catalog-'))
    const filePath = join(dir, 'provider-catalog.json')
    try {
      const c = catalog()
      c.providers[0].adapters!.claudeCode!.extraConfig = { relay: true }
      await writeFile(filePath, JSON.stringify(c), 'utf-8')
      const store = createProviderCatalogStore(filePath)
      const safe = await store.listProviderCatalogSafe()
      const cc = safe.providers[0].adapters!.claudeCode!
      expect(cc.extraConfig).toEqual({ relay: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('safe catalog does not leak adapters.claudeCode.extraEnv values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-catalog-'))
    const filePath = join(dir, 'provider-catalog.json')
    try {
      const c = catalog()
      c.providers[0].adapters!.claudeCode!.extraEnv = { EXTRA_CC_ENV: 'sensitive-value' }
      await writeFile(filePath, JSON.stringify(c), 'utf-8')
      const store = createProviderCatalogStore(filePath)
      const safe = await store.listProviderCatalogSafe()
      const cc = safe.providers[0].adapters!.claudeCode!
      expect(cc.extraEnv).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('saves catalog and rejects masked/placeholder apiKey', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-catalog-'))
    const filePath = join(dir, 'provider-catalog.json')
    try {
      const store = createProviderCatalogStore(filePath)
      const c = catalog()
      await store.saveProviderCatalog(c)

      const bad = catalog()
      bad.providers[0].auth.apiKey = 'sk-xxx'
      await expect(store.saveProviderCatalog(bad)).rejects.toThrow('placeholder')

      const masked = catalog()
      masked.providers[0].auth.apiKey = 'sk-***cret'
      await expect(store.saveProviderCatalog(masked)).rejects.toThrow('placeholder')

      const placeholder = catalog()
      placeholder.providers[0].auth.apiKey = '<your-api-key>'
      await expect(store.saveProviderCatalog(placeholder)).rejects.toThrow('placeholder')

      const plain = catalog()
      plain.providers[0].auth.apiKey = 'your-api-key'
      await expect(store.saveProviderCatalog(plain)).rejects.toThrow('placeholder')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('patch preserves old apiKey when not provided and rejects placeholder in patch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-catalog-'))
    const filePath = join(dir, 'provider-catalog.json')
    try {
      const store = createProviderCatalogStore(filePath)
      await store.saveProviderCatalog(catalog())

      const patch: ProviderCatalogPatch = {
        version: 2,
        providers: [
          {
            id: 'anthropic-direct',
            name: 'Anthropic Direct',
            protocol: 'anthropic',
            apiFormat: 'anthropic',
            auth: { type: 'api-key' },
            endpoint: { baseUrl: 'https://api.anthropic.com' },
            model: { id: 'claude-opus-4-7' },
            models: [{ id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true }],
            defaults: { modelId: 'claude-opus-4-7' },
            adapters: {
              claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true },
              genericAgent: { enabled: true, sessionType: 'native_claude' }
            }
          }
        ]
      }
      const safe = await store.saveProviderCatalogPatch(patch)
      expect(safe.providers[0].auth.hasApiKey).toBe(true)

      const badPatch: ProviderCatalogPatch = {
        version: 2,
        providers: [
          {
            id: 'anthropic-direct',
            name: 'Anthropic Direct',
            protocol: 'anthropic',
            apiFormat: 'anthropic',
            auth: { type: 'api-key', apiKey: 'sk-xxx' },
            endpoint: { baseUrl: 'https://api.anthropic.com' },
            model: { id: 'claude-opus-4-7' },
            models: [{ id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true }],
            defaults: { modelId: 'claude-opus-4-7' },
            adapters: {
              claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true },
              genericAgent: { enabled: true, sessionType: 'native_claude' }
            }
          }
        ]
      }
      await expect(store.saveProviderCatalogPatch(badPatch)).rejects.toThrow('placeholder')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('patch rejects nested placeholder in adapters.claudeCode.extraEnv', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-catalog-'))
    const filePath = join(dir, 'provider-catalog.json')
    try {
      const store = createProviderCatalogStore(filePath)
      await store.saveProviderCatalog(catalog())

      const badPatch: ProviderCatalogPatch = {
        version: 2,
        providers: [
          {
            id: 'anthropic-direct',
            name: 'Anthropic Direct',
            protocol: 'anthropic',
            apiFormat: 'anthropic',
            auth: { type: 'api-key' },
            endpoint: { baseUrl: 'https://api.anthropic.com' },
            model: { id: 'claude-opus-4-7' },
            models: [{ id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true }],
            defaults: { modelId: 'claude-opus-4-7' },
            adapters: {
              claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true, extraEnv: { SECRET: 'your-api-key' } },
              genericAgent: { enabled: true, sessionType: 'native_claude' }
            }
          }
        ]
      }
      await expect(store.saveProviderCatalogPatch(badPatch)).rejects.toThrow('placeholder')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('loads v1 catalog as normalized v2 without rewriting old config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-catalog-'))
    const filePath = join(dir, 'provider-catalog.json')
    try {
      const oldConfig = v1Catalog()
      const oldConfigText = JSON.stringify(oldConfig)
      await writeFile(filePath, oldConfigText, 'utf-8')
      const store = createProviderCatalogStore(filePath)
      const loaded = await store.loadProviderCatalog()
      expect(loaded.version).toBe(2)
      expect(loaded.providers[0].apiFormat).toBe('anthropic')
      expect(loaded.providers[0].models).toEqual([{ id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true }])
      expect(loaded.providers[0].defaults?.modelId).toBe('claude-opus-4-7')
      expect(await readFile(filePath, 'utf-8')).toBe(oldConfigText)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('safe catalog redacts apiKey, hides extraEnv, and copies only non-secret model source fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-catalog-'))
    const filePath = join(dir, 'provider-catalog.json')
    try {
      const c = catalog()
      c.providers[0].adapters!.claudeCode!.extraEnv = { EXTRA_CC_ENV: 'sensitive-value' }
      c.providers[0].models[0].source = {
        type: 'ccswitch',
        providerId: 'provider-row-id',
        appType: 'claude',
        modelId: 'claude-opus-4-7'
      }
      await writeFile(filePath, JSON.stringify(c), 'utf-8')
      const store = createProviderCatalogStore(filePath)
      const safe = await store.listProviderCatalogSafe()
      const safeProvider = safe.providers[0]

      expect('apiKey' in safeProvider.auth).toBe(false)
      expect(safeProvider.auth.apiKeyPreview).toBe('sk-***cret')
      expect(safeProvider.adapters!.claudeCode!.extraEnv).toBeUndefined()
      expect(safeProvider.models[0].source).toEqual({
        type: 'ccswitch',
        providerId: 'provider-row-id',
        appType: 'claude',
        modelId: 'claude-opus-4-7'
      })
      expect(JSON.stringify(safe)).not.toContain('sensitive-value')
      expect(JSON.stringify(safeProvider.models[0].source)).not.toContain('sk-')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('save and patch write explicit v2 canonical catalog after normalization', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-catalog-'))
    const filePath = join(dir, 'provider-catalog.json')
    try {
      const store = createProviderCatalogStore(filePath)
      await store.saveProviderCatalog(v1Catalog())
      let saved = JSON.parse(await readFile(filePath, 'utf-8'))
      expect(saved.version).toBe(2)
      expect(saved.providers[0].models).toEqual([{ id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true }])

      await store.saveProviderCatalogPatch({
        version: 1,
        providers: [{
          id: 'anthropic-direct',
          name: 'Anthropic Direct',
          protocol: 'anthropic',
          auth: { type: 'api-key' },
          endpoint: { baseUrl: 'https://api.anthropic.com' },
          model: { id: 'claude-opus-4-7' },
          adapters: {
            claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true },
            genericAgent: { enabled: true, sessionType: 'native_claude' }
          }
        }]
      })
      saved = JSON.parse(await readFile(filePath, 'utf-8'))
      expect(saved.version).toBe(2)
      expect(saved.providers[0].auth.apiKey).toBe('sk-ant-secret')
      expect(saved.providers[0].defaults.modelId).toBe('claude-opus-4-7')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
