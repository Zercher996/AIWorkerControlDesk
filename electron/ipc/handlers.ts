import type { BrowserWindow, IpcMain } from 'electron'
import { dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import type { GenericAgentConfig, Project, ProviderCatalogPatch, SessionAiEvent, SessionOutputEvent, SlashAssistQueryInput, SummarySource } from '../../src/types/workerDesk'
import type { ProjectStore } from '../projects/projectStore'
import type { ProviderCatalogStore } from '../providers/providerCatalogStore'
import { importCcswitchClaudeProviders, listCcswitchClaudeProviderPreviews } from '../providers/ccswitchImporter'
import { readCurrentClaudeConfig } from '../providers/currentClaudeConfig'
import type { CliHistoryStore } from '../sessions/cliHistory'
import type { SessionManager } from '../sessions/sessionManager'
import type { SessionStore } from '../sessions/sessionStore'
import { ipcChannels } from './channels'
import { windowThemeOverlay } from '../windowTheme'

type SummaryGenerator = {
  generateSummary(source: SummarySource, providerProfileId: string, providerModelId?: string): Promise<string>
}

type SlashCommandDiscovery = {
  listSlashAssistIndex(input: SlashAssistQueryInput): Promise<unknown>
  listSuggestions?(input: SlashAssistQueryInput): Promise<unknown>
}

type RegisterHandlersInput = {
  ipcMain: IpcMain
  getMainWindow(): BrowserWindow | null
  projectStore: ProjectStore
  loadGenericAgentConfigs(): Promise<GenericAgentConfig[]>
  providerCatalogStore?: ProviderCatalogStore
  sessionManager: SessionManager
  sessionStore: SessionStore
  summaryGenerator: SummaryGenerator
  cliHistory: CliHistoryStore
  slashCommandDiscovery?: SlashCommandDiscovery
}

export function registerIpcHandlers(input: RegisterHandlersInput): void {
  input.ipcMain.handle(ipcChannels.listProjects, () => input.projectStore.listProjects())
  input.ipcMain.handle(ipcChannels.addProject, (_event, projectPath: string) => input.projectStore.addProject(projectPath))
  input.ipcMain.handle(ipcChannels.updateProject, (_event, projectId: string, patch: Pick<Project, 'autoDispatchGenericAgent' | 'genericAgentConfigId'>) => input.projectStore.updateProject(projectId, patch))
  input.ipcMain.handle(ipcChannels.removeProject, (_event, projectId: string) => input.projectStore.removeProject(projectId))
  input.ipcMain.handle(ipcChannels.pickProjectPath, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择项目目录'
    })
    if (result.canceled || result.filePaths.length === 0) return undefined
    return result.filePaths[0]
  })
  input.ipcMain.handle(ipcChannels.listGenericAgentConfigs, () => input.loadGenericAgentConfigs())
  input.ipcMain.handle(ipcChannels.startSession, (_event, payload) => input.sessionManager.startSession(payload))
  input.ipcMain.handle(ipcChannels.listSessions, () => input.sessionManager.listSessions())
  input.ipcMain.handle(ipcChannels.selectSession, (_event, sessionId: string) => input.sessionManager.selectSession(sessionId))
  input.ipcMain.handle(ipcChannels.getOutputBuffer, (_event, sessionId: string) => input.sessionManager.getOutputBuffer(sessionId))
  input.ipcMain.handle(ipcChannels.sendSessionMessage, (_event, sessionId: string, text: string) => input.sessionManager.sendSessionMessage(sessionId, text))
  input.ipcMain.handle(ipcChannels.getSessionAiEvents, (_event, payload) => input.sessionManager.getSessionAiEvents(payload))
  input.ipcMain.handle(ipcChannels.writeSessionInput, (_event, sessionId: string, data: string) => input.sessionManager.writeSessionInput(sessionId, data))
  input.ipcMain.handle(ipcChannels.resizeSession, (_event, sessionId: string, cols: number, rows: number) => input.sessionManager.resizeSession(sessionId, cols, rows))
  input.ipcMain.handle(ipcChannels.stopSession, (_event, sessionId: string) => input.sessionManager.stopSession(sessionId))
  input.ipcMain.handle(ipcChannels.listHistory, (_event, projectId?: string) => input.sessionStore.listHistory(projectId))
  input.ipcMain.handle(ipcChannels.listProjectHistory, async (_event, projectId: string) => {
    // Bundle desk meta + cli jsonl into a single response so the renderer can
    // commit both lists atomically. CLI listing is best-effort (the user may
    // never have used Claude Code in this project), so its failure does not
    // shadow the desk results.
    const [desk, cli] = await Promise.all([
      input.sessionStore.listHistory(projectId),
      input.cliHistory.listCliHistory(projectId).catch(() => [])
    ])
    return { desk, cli }
  })
  input.ipcMain.handle(ipcChannels.getOutput, (_event, payload) => input.sessionStore.getOutput(payload))
  input.ipcMain.handle(ipcChannels.generateSummary, (_event, source: SummarySource, providerProfileId: string, providerModelId?: string) => input.summaryGenerator.generateSummary(source, providerProfileId, providerModelId))
  input.ipcMain.handle(ipcChannels.getSummary, (_event, primaryKey: string) => input.sessionStore.getSummary(primaryKey))
  input.ipcMain.handle(ipcChannels.search, (_event, payload) => input.sessionStore.search(payload))
  input.ipcMain.handle(ipcChannels.exportSession, async (_event, sessionId: string) => {
    const text = await input.sessionStore.buildExportText(sessionId)
    const window = input.getMainWindow()
    const result = await dialog.showSaveDialog(window ?? undefined as unknown as Electron.BaseWindow, {
      title: '导出 Session 输出',
      defaultPath: `${sessionId}.txt`,
      filters: [{ name: 'Text', extensions: ['txt'] }]
    })
    if (result.canceled || !result.filePath) return undefined
    await writeFile(result.filePath, text, 'utf-8')
    return result.filePath
  })
  input.ipcMain.handle(ipcChannels.listCliHistory, (_event, projectId: string) => input.cliHistory.listCliHistory(projectId))
  input.ipcMain.handle(ipcChannels.getCliSessionOutput, (_event, sessionId: string, projectId: string) => input.cliHistory.getCliSessionOutput(sessionId, projectId))
  input.ipcMain.handle(ipcChannels.searchCliHistory, (_event, projectId: string, query: string) => input.cliHistory.searchCliHistory(projectId, query))
  input.ipcMain.handle(ipcChannels.listProviderCatalog, async () => {
    if (!input.providerCatalogStore) throw new Error('Provider catalog store is unavailable')
    return input.providerCatalogStore.listProviderCatalogSafe()
  })
  input.ipcMain.handle(ipcChannels.saveProviderCatalogPatch, async (_event, patch: ProviderCatalogPatch) => {
    if (!input.providerCatalogStore) throw new Error('Provider catalog store is unavailable')
    return input.providerCatalogStore.saveProviderCatalogPatch(patch)
  })
  input.ipcMain.handle(ipcChannels.getCurrentClaudeConfig, async () => {
    const config = await readCurrentClaudeConfig()
    return {
      source: config.source,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKeySource: config.apiKeySource
    }
  })
  input.ipcMain.handle(ipcChannels.listCcswitchClaudeProviderPreviews, async () => {
    if (!input.providerCatalogStore) throw new Error('Provider catalog store is unavailable')
    return listCcswitchClaudeProviderPreviews(await input.providerCatalogStore.listProviderCatalogSafe())
  })
  input.ipcMain.handle(ipcChannels.importCcswitchClaudeProviders, async (_event, ids: string[]) => {
    if (!input.providerCatalogStore) throw new Error('Provider catalog store is unavailable')
    return importCcswitchClaudeProviders(ids, input.providerCatalogStore)
  })
  input.ipcMain.handle(ipcChannels.listSlashAssistIndex, async (_event, payload: SlashAssistQueryInput) => {
    if (!input.slashCommandDiscovery) throw new Error('Slash assist discovery is unavailable')
    return input.slashCommandDiscovery.listSlashAssistIndex(payload)
  })
  input.ipcMain.handle(ipcChannels.listSlashCommandSuggestions, async (_event, payload: SlashAssistQueryInput) => {
    if (!input.slashCommandDiscovery) throw new Error('Slash assist discovery is unavailable')
    return input.slashCommandDiscovery.listSlashAssistIndex(payload)
  })
  input.ipcMain.handle(ipcChannels.setWindowTheme, (_event, theme: 'dark' | 'light') => {
    const window = input.getMainWindow()
    if (!window) return
    window.setTitleBarOverlay({ ...windowThemeOverlay[theme], height: 32 })
  })
}

export function emitSessionOutput(window: BrowserWindow | null, event: SessionOutputEvent): void {
  window?.webContents.send(ipcChannels.sessionOutput, event)
}

export function emitSessionAiEvent(window: BrowserWindow | null, event: SessionAiEvent): void {
  window?.webContents.send(ipcChannels.sessionAiEvent, event)
}

export function emitSessionChanged(window: BrowserWindow | null, session: unknown): void {
  window?.webContents.send(ipcChannels.sessionChanged, session)
}
