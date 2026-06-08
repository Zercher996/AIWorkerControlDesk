import { contextBridge, ipcRenderer } from 'electron'
import type { OutputReadInput, ProviderCatalogPatch, SearchSessionsInput, Session, SessionAiEvent, SessionAiEventsReadInput, SessionAttentionEvent, SessionOutputEvent, SlashAssistQueryInput, StartSessionInput, SummarySource, WorkerDeskApi } from '../src/types/workerDesk'
import { ipcChannels } from './ipc/channels'

const workerDesk: WorkerDeskApi = {
  listProjects: () => ipcRenderer.invoke(ipcChannels.listProjects),
  addProject: (path) => ipcRenderer.invoke(ipcChannels.addProject, path),
  updateProject: (projectId, patch) => ipcRenderer.invoke(ipcChannels.updateProject, projectId, patch),
  removeProject: (projectId) => ipcRenderer.invoke(ipcChannels.removeProject, projectId),
  pickProjectPath: () => ipcRenderer.invoke(ipcChannels.pickProjectPath),
  listGenericAgentConfigs: () => ipcRenderer.invoke(ipcChannels.listGenericAgentConfigs),
  startSession: (input: StartSessionInput) => ipcRenderer.invoke(ipcChannels.startSession, input),
  listSessions: () => ipcRenderer.invoke(ipcChannels.listSessions),
  selectSession: (sessionId) => ipcRenderer.invoke(ipcChannels.selectSession, sessionId),
  getOutputBuffer: (sessionId) => ipcRenderer.invoke(ipcChannels.getOutputBuffer, sessionId),
  sendSessionMessage: (sessionId, text) => ipcRenderer.invoke(ipcChannels.sendSessionMessage, sessionId, text),
  getSessionAiEvents: (input: SessionAiEventsReadInput) => ipcRenderer.invoke(ipcChannels.getSessionAiEvents, input),
  writeSessionInput: (sessionId, data) => ipcRenderer.invoke(ipcChannels.writeSessionInput, sessionId, data),
  resizeSession: (sessionId, cols, rows) => ipcRenderer.invoke(ipcChannels.resizeSession, sessionId, cols, rows),
  stopSession: (sessionId) => ipcRenderer.invoke(ipcChannels.stopSession, sessionId),
  onSessionOutput: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionOutputEvent) => handler(payload)
    ipcRenderer.on(ipcChannels.sessionOutput, listener)
    return () => ipcRenderer.off(ipcChannels.sessionOutput, listener)
  },
  onSessionAiEvent: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionAiEvent) => handler(payload)
    ipcRenderer.on(ipcChannels.sessionAiEvent, listener)
    return () => ipcRenderer.off(ipcChannels.sessionAiEvent, listener)
  },
  onSessionChanged: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Session) => handler(payload)
    ipcRenderer.on(ipcChannels.sessionChanged, listener)
    return () => ipcRenderer.off(ipcChannels.sessionChanged, listener)
  },
  onSessionAttentionChanged: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionAttentionEvent) => handler(payload)
    ipcRenderer.on(ipcChannels.sessionAttentionChanged, listener)
    return () => ipcRenderer.off(ipcChannels.sessionAttentionChanged, listener)
  },
  listHistory: (projectId) => ipcRenderer.invoke(ipcChannels.listHistory, projectId),
  listProjectHistory: (projectId) => ipcRenderer.invoke(ipcChannels.listProjectHistory, projectId),
  getOutput: (input: OutputReadInput) => ipcRenderer.invoke(ipcChannels.getOutput, input),
  generateSummary: (source: SummarySource, providerProfileId, providerModelId) => ipcRenderer.invoke(ipcChannels.generateSummary, source, providerProfileId, providerModelId),
  getSummary: (primaryKey) => ipcRenderer.invoke(ipcChannels.getSummary, primaryKey),
  search: (input: SearchSessionsInput) => ipcRenderer.invoke(ipcChannels.search, input),
  exportSession: (sessionId) => ipcRenderer.invoke(ipcChannels.exportSession, sessionId),
  listCliHistory: (projectId) => ipcRenderer.invoke(ipcChannels.listCliHistory, projectId),
  getCliSessionOutput: (sessionId, projectId) => ipcRenderer.invoke(ipcChannels.getCliSessionOutput, sessionId, projectId),
  searchCliHistory: (projectId, query) => ipcRenderer.invoke(ipcChannels.searchCliHistory, projectId, query),
  listProviderCatalog: () => ipcRenderer.invoke(ipcChannels.listProviderCatalog),
  saveProviderCatalogPatch: (patch: ProviderCatalogPatch) => ipcRenderer.invoke(ipcChannels.saveProviderCatalogPatch, patch),
  getCurrentClaudeConfig: () => ipcRenderer.invoke(ipcChannels.getCurrentClaudeConfig),
  listCcswitchClaudeProviderPreviews: () => ipcRenderer.invoke(ipcChannels.listCcswitchClaudeProviderPreviews),
  importCcswitchClaudeProviders: (ids: string[]) => ipcRenderer.invoke(ipcChannels.importCcswitchClaudeProviders, ids),
  listSlashAssistIndex: (input: SlashAssistQueryInput) => ipcRenderer.invoke(ipcChannels.listSlashAssistIndex, input),
  listSlashCommandSuggestions: (input: SlashAssistQueryInput) => ipcRenderer.invoke(ipcChannels.listSlashCommandSuggestions, input),
  setWindowTheme: (theme) => ipcRenderer.invoke(ipcChannels.setWindowTheme, theme)
}

contextBridge.exposeInMainWorld('workerDesk', workerDesk)
