import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getPath = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath
  }
}))

describe('getAppPaths', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    delete process.env.AIWORKER_TEST_USER_DATA_PATH
  })

  it('uses Electron userData by default', async () => {
    getPath.mockReturnValue('/tmp/AIWorkerControlDeskUserData')
    const { getAppPaths } = await import('./appPaths')

    const userData = '/tmp/AIWorkerControlDeskUserData'
    expect(getAppPaths()).toEqual({
      projectsPath: join(userData, 'projects.json'),
      profilesPath: join(userData, 'profiles.json'),
      sessionsPath: join(userData, 'sessions'),
      genericAgentsPath: join(userData, 'generic-agents.json'),
      providerCatalogPath: join(userData, 'provider-catalog.json'),
      hookEventsPath: join(userData, 'hook-events'),
      crashEventsPath: join(userData, 'crash-events.jsonl')
    })
  })

  it('uses AIWORKER_TEST_USER_DATA_PATH when provided', async () => {
    getPath.mockReturnValue('/tmp/AIWorkerControlDeskUserData')
    process.env.AIWORKER_TEST_USER_DATA_PATH = '/tmp/ai-worker-electron-e2e'
    const { getAppPaths } = await import('./appPaths')

    const userData = '/tmp/ai-worker-electron-e2e'
    expect(getAppPaths()).toEqual({
      projectsPath: join(userData, 'projects.json'),
      profilesPath: join(userData, 'profiles.json'),
      sessionsPath: join(userData, 'sessions'),
      genericAgentsPath: join(userData, 'generic-agents.json'),
      providerCatalogPath: join(userData, 'provider-catalog.json'),
      hookEventsPath: join(userData, 'hook-events'),
      crashEventsPath: join(userData, 'crash-events.jsonl')
    })
  })
})
