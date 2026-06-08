import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { loadGenericAgentConfigs } from './genericAgents/genericAgentConfigStore'
import { createCliHistoryStore } from './sessions/cliHistory'
import { createProjectStore } from './projects/projectStore'
import { createProviderCatalogStore } from './providers/providerCatalogStore'
import { createSessionStore } from './sessions/sessionStore'
import { createSummaryGenerator } from './sessions/summaryGenerator'
import { getAppPaths } from './storage/appPaths'
import { registerIpcHandlers } from './ipc/handlers'
import { createMainSessionManager } from './mainSessionManager'
import { attachWindowCrashGuards, registerProcessCrashGuards } from './crashReporter'
import { createSlashCommandDiscovery } from './slashCommands/slashCommandDiscovery'
import { windowThemeOverlay } from './windowTheme'

let mainWindow: BrowserWindow | null = null

function createWindow(crashEventsPath: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f131b',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      ...windowThemeOverlay.dark,
      height: 32,
    },
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  attachWindowCrashGuards(window, crashEventsPath)

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

app.whenReady().then(async () => {
  if (process.env.AIWORKER_TEST_USER_DATA_PATH) {
    app.setPath('userData', process.env.AIWORKER_TEST_USER_DATA_PATH)
  }
  const paths = getAppPaths()
  registerProcessCrashGuards(paths.crashEventsPath)
  const projectStore = createProjectStore(paths.projectsPath)
  const getGenericAgentConfigs = () => loadGenericAgentConfigs(paths.genericAgentsPath)
  const providerCatalogStore = createProviderCatalogStore(paths.providerCatalogPath)

  const sessionStore = createSessionStore(paths.sessionsPath)
  await sessionStore.recoverInterruptedSessions()

  const sessionManager = createMainSessionManager({
    projectStore,
    getGenericAgentConfigs,
    providerCatalogStore,
    sessionStore,
    hookEventsPath: paths.hookEventsPath,
    getMainWindow: () => mainWindow
  })

  const cliHistory = createCliHistoryStore({
    getProjectPath: async (projectId) => {
      const project = (await projectStore.listProjects()).find((item) => item.id === projectId)
      if (!project) throw new Error(`Project not found: ${projectId}`)
      return project.path
    }
  })
  const slashCommandDiscovery = createSlashCommandDiscovery({
    listProjects: () => projectStore.listProjects()
  })

  const summaryGenerator = createSummaryGenerator({
    getSession: (sessionId) => sessionStore.getSession(sessionId),
    getProviderProfile: async (providerId) => {
      const catalog = await providerCatalogStore.loadProviderCatalog()
      const provider = catalog.providers.find((item) => item.id === providerId)
      if (!provider) throw new Error(`Provider not found: ${providerId}`)
      return provider
    },
    readDeskOutputTail: async (sessionId) => {
      const result = await sessionStore.getOutput({ sessionId, offset: 0, limit: 100000 })
      const text = result.chunks.map((event) => event.chunk).join('')
      return text.slice(-180000)
    },
    readCliOutputTail: async (sessionId, projectId) => {
      const text = await cliHistory.getCliSessionOutput(sessionId, projectId)
      return text.slice(-180000)
    },
    writeSummary: (primaryKey, summary) => sessionStore.writeSummary(primaryKey, summary)
  })


  registerIpcHandlers({
    ipcMain,
    getMainWindow: () => mainWindow,
    projectStore,
    loadGenericAgentConfigs: getGenericAgentConfigs,
    providerCatalogStore,
    sessionManager,
    sessionStore,
    summaryGenerator,
    cliHistory,
    slashCommandDiscovery
  })

  mainWindow = createWindow(paths.crashEventsPath)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow(getAppPaths().crashEventsPath)
  }
})