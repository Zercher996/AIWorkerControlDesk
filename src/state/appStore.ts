import type { CliHistorySession, CurrentClaudeConfigSummary, DeskHistoryItem, GenericAgentConfig, Project, SafeProviderCatalog, Session, SessionAiEvent, SessionAttentionEvent, SessionUserAttention, SessionViewMode, WorkerType } from '../types/workerDesk'
import { getCompatibleModels, getCompatibleProviders, getDefaultProviderModelId } from '../utils/providerCompatibility'

export type RightTab = 'terminal' | 'history'

export type AppState = {
  projects: Project[]
  genericAgentConfigs: GenericAgentConfig[]
  providerCatalog?: SafeProviderCatalog
  currentClaudeConfig?: CurrentClaudeConfigSummary
  sessions: Session[]
  sessionAiEventsBySessionId: Record<string, SessionAiEvent[]>
  sessionAiEventsNextOffset: Record<string, number | undefined>
  sessionAiEventsTotalBytes: Record<string, number>
  isSendingMessageBySessionId: Record<string, boolean>
  selectedProjectId?: string
  selectedProviderProfileId?: string
  selectedProviderModelId?: string
  selectedClaudeLaunchMode: 'provider' | 'current-claude-config'
  selectedWorkerType: WorkerType
  selectedSessionId?: string
  sessionViewModeBySessionId: Record<string, SessionViewMode | undefined>
  handledAttentionSessionIds: string[]
  userAttentionBySessionId: Record<string, SessionUserAttention | undefined>
  error?: string
  rightTab: RightTab
  history: DeskHistoryItem[]
  cliHistory: CliHistorySession[]
  selectedHistorySessionId?: string
  historyOutputBySessionId: Record<string, string>
  summaryBySessionId: Record<string, string | undefined>
  historyOutputNextOffset: Record<string, number | undefined>
  historyOutputTotalBytes: Record<string, number>
  historyQuery: string
  isSummaryLoading: boolean
  isHistoryOutputLoading: boolean
  isSessionStarting: boolean
}

export type AppAction =
  | { type: 'loaded'; projects: Project[]; sessions: Session[] }
  | { type: 'genericAgentConfigsLoaded'; configs: GenericAgentConfig[] }
  | { type: 'providerCatalogLoaded'; catalog: SafeProviderCatalog }
  | { type: 'currentClaudeConfigLoaded'; config: CurrentClaudeConfigSummary }
  | { type: 'selectProject'; projectId: string }
  | { type: 'selectProviderProfile'; providerProfileId: string | undefined }
  | { type: 'selectProviderModel'; providerModelId: string | undefined }
  | { type: 'selectClaudeLaunchMode'; mode: 'provider' | 'current-claude-config' }
  | { type: 'selectWorkerType'; workerType: WorkerType }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'setSessionViewMode'; sessionId: string; viewMode: SessionViewMode }
  | { type: 'markSessionAttentionHandled'; sessionId: string }
  | { type: 'sessionAttentionChanged'; event: SessionAttentionEvent }
  | { type: 'upsertSession'; session: Session }
  | { type: 'sessionAiEventsLoaded'; sessionId: string; events: SessionAiEvent[]; nextOffset?: number; totalBytes: number }
  | { type: 'sessionAiEventReceived'; event: SessionAiEvent }
  | { type: 'setSessionMessageSending'; sessionId: string; isSending: boolean }
  | { type: 'setSessionTaskTitle'; sessionId: string; taskTitle: string }
  | { type: 'setError'; error?: string }
  | { type: 'projectAdded'; project: Project }
  | { type: 'projectUpdated'; project: Project }
  | { type: 'projectRemoved'; projectId: string; nextProjectId?: string }
  | { type: 'historyLoaded'; history: DeskHistoryItem[] }
  | { type: 'projectHistoryLoaded'; history: DeskHistoryItem[]; cliHistory: CliHistorySession[] }
  | { type: 'selectHistorySession'; sessionId: string | undefined }
  | { type: 'historyOutputLoaded'; sessionId: string; output: string; nextOffset?: number; totalBytes: number }
  | { type: 'appendHistoryOutput'; sessionId: string; output: string; nextOffset?: number }
  | { type: 'summaryLoaded'; sessionId: string; summary?: string }
  | { type: 'setHistoryQuery'; query: string }
  | { type: 'setSummaryLoading'; isLoading: boolean }
  | { type: 'setHistoryOutputLoading'; isLoading: boolean }
  | { type: 'setRightTab'; tab: RightTab }
  | { type: 'setSessionStarting'; isStarting: boolean }
  | { type: 'cliHistoryLoaded'; history: CliHistorySession[] }

export const initialAppState: AppState = {
  projects: [],
  genericAgentConfigs: [],
  sessions: [],
  sessionAiEventsBySessionId: {},
  sessionAiEventsNextOffset: {},
  sessionAiEventsTotalBytes: {},
  isSendingMessageBySessionId: {},
  selectedClaudeLaunchMode: 'provider',
  selectedWorkerType: 'claude-code',
  sessionViewModeBySessionId: {},
  handledAttentionSessionIds: [],
  userAttentionBySessionId: {},
  rightTab: 'terminal',
  history: [],
  cliHistory: [],
  historyOutputBySessionId: {},
  summaryBySessionId: {},
  historyOutputNextOffset: {},
  historyOutputTotalBytes: {},
  historyQuery: '',
  isSummaryLoading: false,
  isHistoryOutputLoading: false,
  isSessionStarting: false
}

function selectCompatibleProviderModelId(
  provider: SafeProviderCatalog['providers'][number] | undefined,
  workerType: WorkerType,
  currentModelId: string | undefined
): string | undefined {
  const compatibleModels = provider ? getCompatibleModels(provider, workerType) : []
  const defaultModelId = getDefaultProviderModelId(provider)
  return compatibleModels.some((model) => model.id === currentModelId)
    ? currentModelId
    : compatibleModels.find((model) => model.id === defaultModelId)?.id ?? compatibleModels[0]?.id
}

function removeSessionId(sessionIds: string[], sessionId: string): string[] {
  return sessionIds.filter((id) => id !== sessionId)
}

function mergeAiEvents(existing: SessionAiEvent[], incoming: SessionAiEvent[]): SessionAiEvent[] {
  const seen = new Set(existing.map((event) => event.id))
  const next = [...existing]
  for (const event of incoming) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    next.push(event)
  }
  return next
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        projects: action.projects,
        sessions: action.sessions,
        selectedProjectId: state.selectedProjectId ?? action.projects[0]?.id,
        selectedSessionId: state.selectedSessionId ?? action.sessions[0]?.id
      }
    case 'genericAgentConfigsLoaded':
      return { ...state, genericAgentConfigs: action.configs }
    case 'providerCatalogLoaded': {
      const compatibleProviders = getCompatibleProviders(action.catalog, state.selectedWorkerType)
      const selectedProviderId = state.selectedProviderProfileId && compatibleProviders.some((provider) => provider.id === state.selectedProviderProfileId)
        ? state.selectedProviderProfileId
        : compatibleProviders[0]?.id
      const selectedProvider = compatibleProviders.find((provider) => provider.id === selectedProviderId)
      const selectedModelId = selectCompatibleProviderModelId(selectedProvider, state.selectedWorkerType, state.selectedProviderModelId)
      return {
        ...state,
        providerCatalog: action.catalog,
        selectedProviderProfileId: selectedProviderId,
        selectedProviderModelId: selectedModelId
      }
    }
    case 'currentClaudeConfigLoaded':
      return {
        ...state,
        currentClaudeConfig: action.config,
        selectedClaudeLaunchMode: 'current-claude-config'
      }
    case 'selectProject':
      return { ...state, selectedProjectId: action.projectId }
    case 'selectProviderProfile': {
      const selectedProvider = state.providerCatalog?.providers.find((provider) => provider.id === action.providerProfileId)
      return {
        ...state,
        selectedProviderProfileId: action.providerProfileId,
        selectedProviderModelId: selectCompatibleProviderModelId(selectedProvider, state.selectedWorkerType, undefined)
      }
    }
    case 'selectProviderModel':
      return { ...state, selectedProviderModelId: action.providerModelId }
    case 'selectClaudeLaunchMode':
      return { ...state, selectedClaudeLaunchMode: action.mode }
    case 'selectWorkerType':
      return { ...state, selectedWorkerType: action.workerType }
    case 'selectSession':
      return { ...state, selectedSessionId: action.sessionId }
    case 'setSessionViewMode':
      return {
        ...state,
        sessionViewModeBySessionId: {
          ...state.sessionViewModeBySessionId,
          [action.sessionId]: action.viewMode
        }
      }
    case 'markSessionAttentionHandled': {
      const alreadyHandled = state.handledAttentionSessionIds.includes(action.sessionId)
      const nextAttention = state.userAttentionBySessionId[action.sessionId] === undefined
        ? state.userAttentionBySessionId
        : {
            ...state.userAttentionBySessionId,
            [action.sessionId]: undefined
          }
      if (alreadyHandled && nextAttention === state.userAttentionBySessionId) return state
      return {
        ...state,
        handledAttentionSessionIds: alreadyHandled
          ? state.handledAttentionSessionIds
          : [...state.handledAttentionSessionIds, action.sessionId],
        userAttentionBySessionId: nextAttention
      }
    }
    case 'sessionAttentionChanged':
      return {
        ...state,
        userAttentionBySessionId: {
          ...state.userAttentionBySessionId,
          [action.event.sessionId]: action.event.state
        },
        handledAttentionSessionIds: removeSessionId(state.handledAttentionSessionIds, action.event.sessionId)
      }
    case 'upsertSession': {
      const sessions = state.sessions.some((session) => session.id === action.session.id)
        ? state.sessions.map((session) => {
          if (session.id !== action.session.id) return session
          return { ...action.session, taskTitle: action.session.taskTitle ?? session.taskTitle }
        })
        : [action.session, ...state.sessions]
      return {
        ...state,
        sessions,
        selectedSessionId: state.selectedSessionId ?? action.session.id
      }
    }
    case 'sessionAiEventsLoaded':
      return {
        ...state,
        sessionAiEventsBySessionId: {
          ...state.sessionAiEventsBySessionId,
          [action.sessionId]: mergeAiEvents(state.sessionAiEventsBySessionId[action.sessionId] ?? [], action.events)
        },
        sessionAiEventsNextOffset: {
          ...state.sessionAiEventsNextOffset,
          [action.sessionId]: action.nextOffset
        },
        sessionAiEventsTotalBytes: {
          ...state.sessionAiEventsTotalBytes,
          [action.sessionId]: action.totalBytes
        }
      }
    case 'sessionAiEventReceived':
      return {
        ...state,
        sessionAiEventsBySessionId: {
          ...state.sessionAiEventsBySessionId,
          [action.event.sessionId]: mergeAiEvents(state.sessionAiEventsBySessionId[action.event.sessionId] ?? [], [action.event])
        }
      }
    case 'setSessionMessageSending':
      return {
        ...state,
        isSendingMessageBySessionId: {
          ...state.isSendingMessageBySessionId,
          [action.sessionId]: action.isSending
        }
      }
    case 'setSessionTaskTitle':
      return {
        ...state,
        sessions: state.sessions.map((session) => (
          session.id === action.sessionId && !session.taskTitle
            ? { ...session, taskTitle: action.taskTitle }
            : session
        ))
      }
    case 'projectAdded': {
      const projects = state.projects.some((p) => p.id === action.project.id)
        ? state.projects
        : [...state.projects, action.project]
      return {
        ...state,
        projects,
        selectedProjectId: state.selectedProjectId ?? action.project.id
      }
    }
    case 'projectUpdated':
      return {
        ...state,
        projects: state.projects.map((project) => project.id === action.project.id ? action.project : project)
      }
    case 'projectRemoved': {
      const projectExists = state.projects.some((project) => project.id === action.projectId)
      if (!projectExists) return state
      const selectedProjectWasRemoved = state.selectedProjectId === action.projectId
      return {
        ...state,
        projects: state.projects.filter((project) => project.id !== action.projectId),
        selectedProjectId: selectedProjectWasRemoved ? action.nextProjectId : state.selectedProjectId,
        history: selectedProjectWasRemoved ? [] : state.history,
        cliHistory: selectedProjectWasRemoved ? [] : state.cliHistory,
        selectedHistorySessionId: selectedProjectWasRemoved ? undefined : state.selectedHistorySessionId,
        historyOutputBySessionId: selectedProjectWasRemoved ? {} : state.historyOutputBySessionId,
        summaryBySessionId: selectedProjectWasRemoved ? {} : state.summaryBySessionId,
        historyOutputNextOffset: selectedProjectWasRemoved ? {} : state.historyOutputNextOffset,
        historyOutputTotalBytes: selectedProjectWasRemoved ? {} : state.historyOutputTotalBytes,
        historyQuery: selectedProjectWasRemoved ? '' : state.historyQuery,
        isSummaryLoading: selectedProjectWasRemoved ? false : state.isSummaryLoading,
        isHistoryOutputLoading: selectedProjectWasRemoved ? false : state.isHistoryOutputLoading
      }
    }
    case 'setError':
      return { ...state, error: action.error }
    case 'historyLoaded':
      return { ...state, history: action.history }
    case 'projectHistoryLoaded':
      // Atomic project history swap: replace both lists in one render so the
      // mergedHistory memo doesn't see a half-loaded intermediate state, and
      // the user doesn't see a flash between "old project's history" and
      // "new project's history".
      return { ...state, history: action.history, cliHistory: action.cliHistory }
    case 'selectHistorySession':
      return { ...state, selectedHistorySessionId: action.sessionId }
    case 'historyOutputLoaded':
      return {
        ...state,
        historyOutputBySessionId: {
          ...state.historyOutputBySessionId,
          [action.sessionId]: action.output
        },
        historyOutputNextOffset: {
          ...state.historyOutputNextOffset,
          [action.sessionId]: action.nextOffset
        },
        historyOutputTotalBytes: {
          ...state.historyOutputTotalBytes,
          [action.sessionId]: action.totalBytes
        }
      }
    case 'appendHistoryOutput':
      return {
        ...state,
        historyOutputBySessionId: {
          ...state.historyOutputBySessionId,
          [action.sessionId]: `${state.historyOutputBySessionId[action.sessionId] ?? ''}${action.output}`
        },
        historyOutputNextOffset: {
          ...state.historyOutputNextOffset,
          [action.sessionId]: action.nextOffset
        }
      }
    case 'summaryLoaded':
      return {
        ...state,
        summaryBySessionId: {
          ...state.summaryBySessionId,
          [action.sessionId]: action.summary
        }
      }
    case 'setHistoryQuery':
      return { ...state, historyQuery: action.query }
    case 'setSummaryLoading':
      return { ...state, isSummaryLoading: action.isLoading }
    case 'setHistoryOutputLoading':
      return { ...state, isHistoryOutputLoading: action.isLoading }
    case 'setRightTab':
      return { ...state, rightTab: action.tab }
    case 'setSessionStarting':
      return { ...state, isSessionStarting: action.isStarting }
    case 'cliHistoryLoaded':
      return { ...state, cliHistory: action.history }
    default:
      return state
  }
}
