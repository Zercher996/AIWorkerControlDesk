import { app } from 'electron'
import { join } from 'node:path'

export type AppPaths = {
  projectsPath: string
  profilesPath: string
  sessionsPath: string
  genericAgentsPath: string
  providerCatalogPath: string
  hookEventsPath: string
  crashEventsPath: string
}

export function getAppPaths(): AppPaths {
  const userData = process.env.AIWORKER_TEST_USER_DATA_PATH || app.getPath('userData')
  return {
    projectsPath: join(userData, 'projects.json'),
    profilesPath: join(userData, 'profiles.json'),
    sessionsPath: join(userData, 'sessions'),
    genericAgentsPath: join(userData, 'generic-agents.json'),
    providerCatalogPath: join(userData, 'provider-catalog.json'),
    hookEventsPath: join(userData, 'hook-events'),
    crashEventsPath: join(userData, 'crash-events.jsonl')
  }
}
