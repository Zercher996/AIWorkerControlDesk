import { Notification, shell, type BrowserWindow } from 'electron'
import { ipcChannels } from './ipc/channels'
import { loadGenericAgentConfigs } from './genericAgents/genericAgentConfigStore'
import { createProjectStore } from './projects/projectStore'
import { createProviderCatalogStore } from './providers/providerCatalogStore'
import { readCurrentClaudeConfig } from './providers/currentClaudeConfig'
import { startPtyProcess } from './sessions/claudePty'
import { createSessionManager } from './sessions/sessionManager'
import { createSessionStore } from './sessions/sessionStore'
import { createClaudeHookBridge } from './sessions/claudeHookBridge'

export type MainSessionManagerInput = {
  projectStore: ReturnType<typeof createProjectStore>
  getGenericAgentConfigs: () => ReturnType<typeof loadGenericAgentConfigs>
  providerCatalogStore: ReturnType<typeof createProviderCatalogStore>
  sessionStore: ReturnType<typeof createSessionStore>
  hookEventsPath: string
  getMainWindow: () => BrowserWindow | null
}

export function createMainSessionManager(input: MainSessionManagerInput) {
  const attentionStateBySessionId = new Map<string, 'working' | 'needsReview'>()
  const sessionTitleById = new Map<string, string>()
  const hookBridge = createClaudeHookBridge({
    rootDir: input.hookEventsPath,
    onEvent: (event) => {
      const previousState = attentionStateBySessionId.get(event.sessionId)
      attentionStateBySessionId.set(event.sessionId, event.state)
      if (event.state === 'needsReview' && previousState !== 'needsReview') {
        const mainWindow = input.getMainWindow()
        shell.beep()
        new Notification({
          title: '任务需要查看',
          body: `${sessionTitleById.get(event.sessionId) ?? 'Claude Code Session'} 已完成本轮响应`,
          silent: true
        }).show()
        if (mainWindow && !mainWindow.isFocused()) {
          mainWindow.flashFrame(true)
          mainWindow.once('focus', () => mainWindow.flashFrame(false))
        }
      }
      input.getMainWindow()?.webContents.send(ipcChannels.sessionAttentionChanged, event)
    }
  })

  return createSessionManager({
    getProject: async (projectId) => {
      const project = (await input.projectStore.listProjects()).find((item) => item.id === projectId)
      if (!project) throw new Error(`Project not found: ${projectId}`)
      return project
    },
    getGenericAgentConfig: async (configId) => {
      const configs = await input.getGenericAgentConfigs()
      const config = configs.find((item) => item.id === configId)
      if (!config) throw new Error(`GenericAgent config not found: ${configId}`)
      return config
    },
    getProviderProfile: async (providerId) => {
      const catalog = await input.providerCatalogStore.loadProviderCatalog()
      const provider = catalog.providers.find((item) => item.id === providerId)
      if (!provider) throw new Error(`Provider not found: ${providerId}`)
      return provider
    },
    getCurrentClaudeConfig: () => readCurrentClaudeConfig(),
    startGenericProcess: (processInput) => startPtyProcess(processInput),
    hookBridge,
    sessionStore: input.sessionStore,
    onOutput: (event) => {
      input.getMainWindow()?.webContents.send(ipcChannels.sessionOutput, event)
    },
    onAiEvent: (event) => {
      input.getMainWindow()?.webContents.send(ipcChannels.sessionAiEvent, event)
    },
    onSessionChanged: (session) => {
      sessionTitleById.set(session.id, session.taskTitle ?? session.title)
      input.getMainWindow()?.webContents.send(ipcChannels.sessionChanged, session)
    }
  })
}
