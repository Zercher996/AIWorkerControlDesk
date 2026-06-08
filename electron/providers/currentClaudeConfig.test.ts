import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCurrentClaudeConfigFromFile } from './currentClaudeConfig'

async function withSettingsFile(content: object, run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-settings-'))
  const filePath = join(dir, 'settings.json')
  await writeFile(filePath, JSON.stringify(content), 'utf8')
  try {
    await run(filePath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('readCurrentClaudeConfigFromFile', () => {
  it('reads anthropic env that already points to local proxy', async () => {
    await withSettingsFile({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'secret-token',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:53159',
        ANTHROPIC_MODEL: 'gpt-5.4'
      }
    }, async (filePath) => {
      const result = await readCurrentClaudeConfigFromFile(filePath)
      expect(result.baseUrl).toBe('http://127.0.0.1:53159')
      expect(result.model).toBe('gpt-5.4')
      expect(result.apiKeySource).toBe('ANTHROPIC_AUTH_TOKEN')
      expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe('secret-token')
    })
  })

  it('fails when auth env is missing', async () => {
    await withSettingsFile({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:53159' } }, async (filePath) => {
      await expect(readCurrentClaudeConfigFromFile(filePath)).rejects.toThrow('当前 Claude 配置缺少认证信息')
    })
  })

  it('fails when base url is missing', async () => {
    await withSettingsFile({ env: { ANTHROPIC_AUTH_TOKEN: 'secret-token' } }, async (filePath) => {
      await expect(readCurrentClaudeConfigFromFile(filePath)).rejects.toThrow('当前 Claude 配置缺少 ANTHROPIC_BASE_URL')
    })
  })
})
