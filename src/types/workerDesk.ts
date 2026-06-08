export type GenericAgentConfig = {
  id: string
  name: string
  home: string
  pythonCommand: string
  entryScript: string
  env: Record<string, string>
}

export type Project = {
  id: string
  name: string
  path: string
  createdAt: string
  lastUsedAt: string
  autoDispatchGenericAgent: boolean
  genericAgentConfigId?: string
}

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto' | 'dontAsk'

export type CurrentClaudeConfigSummary = {
  source: 'current-claude-config'
  baseUrl: string
  model?: string
  apiKeySource: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN'
}

export type CurrentClaudeConfig = CurrentClaudeConfigSummary & {
  env: Record<string, string>
}

export type ClaudeLaunchSource =
  | { type: 'provider'; providerProfileId: string; providerModelId?: string }
  | { type: 'current-claude-config' }

export type WorkerType = 'claude-code' | 'generic-agent'

export type SessionStatus = 'idle' | 'starting' | 'running' | 'waiting' | 'exited' | 'failed' | 'stopped'

export type SessionInteractionMode = 'pty' | 'headless' | 'native-jsonl'

export type SessionViewMode = 'ai' | 'native-pty'

export type DispatchMode = 'manual' | 'auto'

export type Session = {
  id: string
  projectId: string
  workerType: WorkerType
  interactionMode: SessionInteractionMode
  processId?: number
  status: SessionStatus
  title: string
  taskTitle?: string
  createdAt: string
  lastActivityAt: string
  exitedAt?: string
  exitCode?: number
  outputRef: string
  errorMessage?: string
  parentSessionId?: string
  dispatchMode?: DispatchMode
  dispatchTask?: string
  genericAgentConfigId?: string
  providerProfileId?: string
  providerName?: string
  modelId?: string
  modelDisplayName?: string
  /**
   * Claude Code CLI session id (the jsonl filename without `.jsonl` suffix).
   * Set on session exit when we can deterministically match the CC-generated jsonl
   * by mtime against this Desk Session's lifetime window. Internal-only field —
   * UI does not surface this id; we use it to read structured history from
   * `~/.claude/projects/<encoded_path>/<cliSessionId>.jsonl` instead of replaying
   * the noisy PTY chunk stream.
   */
  cliSessionId?: string
}

export type SessionOutputEvent = {
  sessionId: string
  chunk: string
  stream: 'stdout' | 'stderr'
  timestamp: string
}

export type SessionAiEventBase = {
  id: string
  sessionId: string
  timestamp: string
  source: 'claude-code-stream-json' | 'claude-code-jsonl' | 'desk'
  raw?: unknown
}

export type SessionAiPermissionDenial = {
  toolName?: string
  toolUseId?: string
  toolInput?: unknown
}

export type SessionAiUserMessageEvent = SessionAiEventBase & {
  type: 'user_message'
  text: string
}

export type SessionAiAssistantTextEvent = SessionAiEventBase & {
  type: 'assistant_text'
  text: string
  messageId?: string
}

export type SessionAiToolUseEvent = SessionAiEventBase & {
  type: 'tool_use'
  toolUseId?: string
  name: string
  input?: unknown
}

export type SessionAiToolResultEvent = SessionAiEventBase & {
  type: 'tool_result'
  toolUseId?: string
  content?: string
  isError?: boolean
  errorKind?: 'permission_denied' | 'tool_error'
}

export type SessionAiSystemEvent = SessionAiEventBase & {
  type: 'system'
  subtype?: string
  cliSessionId?: string
}

export type SessionAiTurnEndEvent = SessionAiEventBase & {
  type: 'turn_end'
  reason?: string
  cliSessionId?: string
}

export type SessionAiResultEvent = SessionAiEventBase & {
  type: 'result'
  status: 'success' | 'error'
  text?: string
  usage?: unknown
  cliSessionId?: string
  errorMessage?: string
  permissionDenials?: SessionAiPermissionDenial[]
}

export type SessionAiDiagnosticEvent = SessionAiEventBase & {
  type: 'diagnostic'
  level: 'info' | 'warning' | 'error'
  message: string
  stream?: 'stderr' | 'parser' | 'lifecycle'
}

export type SessionAiEvent =
  | SessionAiUserMessageEvent
  | SessionAiAssistantTextEvent
  | SessionAiToolUseEvent
  | SessionAiToolResultEvent
  | SessionAiSystemEvent
  | SessionAiTurnEndEvent
  | SessionAiResultEvent
  | SessionAiDiagnosticEvent

export type SessionAiEventsReadInput = {
  sessionId: string
  offset?: number
  limit?: number
}

export type SessionAiEventsReadResult = {
  events: SessionAiEvent[]
  nextOffset?: number
  totalBytes: number
}

export type SessionUserAttention = 'working' | 'needsReview'

export type ClaudeHookEventName = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'Notification'

export type SessionAttentionEvent = {
  sessionId: string
  state: SessionUserAttention
  source: 'claude-code-hook'
  hookName: ClaudeHookEventName
  occurredAt: string
}

export type StartSessionInput = {
  projectId: string
  workerType: WorkerType
  resumeSessionId?: string
  initialPrompt?: string
  taskTitle?: string
  parentSessionId?: string
  dispatchMode?: DispatchMode
  dispatchTask?: string
  interactionMode?: SessionInteractionMode
  terminalSize?: {
    cols: number
    rows: number
  }
  genericAgentConfigId?: string
  providerProfileId?: string
  providerModelId?: string
  claudeLaunchSource?: ClaudeLaunchSource
}

export type DeskHistoryItem = Session & {
  summaryGeneratedAt?: string
  outputSizeBytes?: number
  source?: 'desk'
}

export type CliHistorySession = {
  id: string
  projectId: string
  firstMessage: string
  /**
   * Optional. Older builds always populated this by scanning the entire jsonl.
   * The current renderer doesn't display it, so the listing path skips counting
   * to keep project switches fast. Kept on the type for fixture/test compat.
   */
  messageCount?: number
  createdAt: string
  updatedAt: string
  fileSizeBytes: number
  cwd: string
  userMessageCount?: number
  assistantTextChars?: number
  apiErrorCount?: number
  containsGaTask?: boolean
  qualityScanComplete?: boolean
  source: 'cli'
}

export type SessionHistoryItem = DeskHistoryItem | CliHistorySession

/**
 * Combined project-scoped history payload.
 *
 * Project switching is the only consumer that needs both lists at once. Bundling
 * them avoids two IPC round-trips, two dispatches, and the in-between half-loaded
 * state in the merged history view.
 */
export type ProjectHistory = {
  desk: DeskHistoryItem[]
  cli: CliHistorySession[]
}

/**
 * Source of a Summary generation request. The renderer picks which kind of
 * history card the user is interacting with; the main process reads output
 * from the appropriate place and persists the summary under a unified key
 * (cliSessionId preferred, desk session id fallback).
 */
export type SummarySource =
  | { kind: 'desk-session'; deskSessionId: string }
  | { kind: 'cli-session'; cliSessionId: string; projectId: string }

export type OutputReadInput = {
  sessionId: string
  offset?: number
  limit?: number
}

export type OutputReadResult = {
  chunks: SessionOutputEvent[]
  nextOffset?: number
  totalBytes: number
}

export type SearchSessionsInput = {
  query: string
}

export type SearchSessionResult = {
  sessionId: string
  title: string
  status: SessionStatus
  matchedAt: string
  excerpt: string
}

export type SlashAssistKind = 'builtin-command' | 'project-command' | 'user-command' | 'project-skill' | 'user-skill'

export type SlashAssistCategory = 'native-task-command' | 'native-management-command' | 'desk-app-action' | 'file-command' | 'skill'

export type SlashAssistExecutionMode = 'headless-message' | 'native-interactive' | 'assist-only'

export type SlashAssistBehavior = 'send-to-session' | 'switch-to-native' | 'insert-only' | 'app-action'

export type SlashAssistEvidence = {
  source: string
  excerpt: string
}

export type SlashAssistItem = {
  id: string
  displayText: string
  insertText: string
  title: string
  description?: string
  kind: SlashAssistKind
  category?: SlashAssistCategory
  scopeLabel: string
  groupLabel: string
  confidence: 'file-backed' | 'native-evidence' | 'curated'
  priority: number
  /**
   * Product-level behavior in the native-jsonl main path. `executionMode` is kept
   * temporarily for compatibility with older cached slash items/tests.
   */
  behavior?: SlashAssistBehavior
  executionMode?: SlashAssistExecutionMode
  argumentHint?: string
  aliases?: string[]
  nativeOrder?: number
  evidence?: SlashAssistEvidence
}

export type SlashAssistQueryInput = {
  projectId?: string
  query?: string
  limit?: number
  refresh?: boolean
}

export type SlashAssistQueryResult = {
  items: SlashAssistItem[]
  sourceStatus: 'ready' | 'empty' | 'unavailable' | 'partial'
  message?: string
  refreshedAt?: string
}

export type SlashCommandSuggestion = SlashAssistItem
export type SlashCommandSuggestionsInput = SlashAssistQueryInput
export type SlashCommandSuggestionsResult = SlashAssistQueryResult

export type WorkerDeskApi = {
  listProjects(): Promise<Project[]>
  addProject(path: string): Promise<Project>
  updateProject(projectId: string, patch: Pick<Project, 'autoDispatchGenericAgent' | 'genericAgentConfigId'>): Promise<Project>
  removeProject(projectId: string): Promise<Project | undefined>
  pickProjectPath(): Promise<string | undefined>
  listGenericAgentConfigs(): Promise<GenericAgentConfig[]>
  startSession(input: StartSessionInput): Promise<Session>
  listSessions(): Promise<Session[]>
  selectSession(sessionId: string): Promise<Session>
  getOutputBuffer(sessionId: string): Promise<string>
  sendSessionMessage(sessionId: string, text: string): Promise<void>
  getSessionAiEvents(input: SessionAiEventsReadInput): Promise<SessionAiEventsReadResult>
  writeSessionInput(sessionId: string, data: string): Promise<void>
  resizeSession(sessionId: string, cols: number, rows: number): Promise<void>
  stopSession(sessionId: string): Promise<void>
  onSessionOutput(handler: (event: SessionOutputEvent) => void): () => void
  onSessionAiEvent(handler: (event: SessionAiEvent) => void): () => void
  onSessionChanged(handler: (session: Session) => void): () => void
  onSessionAttentionChanged(handler: (event: SessionAttentionEvent) => void): () => void
  listHistory(projectId?: string): Promise<DeskHistoryItem[]>
  /**
   * Project-scoped history in one round-trip. Returned together so the renderer
   * can update both lists in a single dispatch (no half-loaded mergedHistory
   * intermediate state).
   */
  listProjectHistory(projectId: string): Promise<ProjectHistory>
  getOutput(input: OutputReadInput): Promise<OutputReadResult>
  /**
   * Generate a Summary for a Desk Session or CLI history session.
   * Persists under the unified primary key (cliSessionId preferred).
   */
  generateSummary(source: SummarySource, providerProfileId: string, providerModelId?: string): Promise<string>
  /**
   * Read an existing Summary by primary key (cliSessionId or desk session id).
   * Falls back to legacy per-session paths when present.
   */
  getSummary(primaryKey: string): Promise<string | undefined>
  search(input: SearchSessionsInput): Promise<SearchSessionResult[]>
  exportSession(sessionId: string): Promise<string | undefined>
  listCliHistory(projectId: string): Promise<CliHistorySession[]>
  getCliSessionOutput(sessionId: string, projectId: string): Promise<string>
  searchCliHistory(projectId: string, query: string): Promise<SearchSessionResult[]>
  listProviderCatalog(): Promise<SafeProviderCatalog>
  saveProviderCatalogPatch(patch: ProviderCatalogPatch): Promise<SafeProviderCatalog>
  getCurrentClaudeConfig(): Promise<CurrentClaudeConfigSummary>
  listCcswitchClaudeProviderPreviews(): Promise<CcswitchProviderPreview[]>
  importCcswitchClaudeProviders(ids: string[]): Promise<SafeProviderCatalog>
  listSlashAssistIndex(input: SlashAssistQueryInput): Promise<SlashAssistQueryResult>
  listSlashCommandSuggestions(input: SlashCommandSuggestionsInput): Promise<SlashCommandSuggestionsResult>
  setWindowTheme(theme: 'dark' | 'light'): Promise<void>
}

export type CcswitchProviderPreview = {
  id: string
  name: string
  baseUrl: string
  model: string
  apiKeyPreview: string
  isCurrent: boolean
  alreadyExists: boolean
}

export type ProviderProtocol = 'anthropic' | 'anthropic-compatible' | 'openai-compatible'

export type ProviderApiFormat = 'anthropic' | 'openai_chat' | 'openai_responses' | 'gemini_native'

export type ProviderModelSource = {
  type: 'manual' | 'ccswitch'
  providerId?: string
  appType?: 'claude' | 'codex' | 'gemini'
  modelId?: string
}

export type ProviderAuth = {
  type: 'api-key'
  apiKey: string
}

export type ProviderEndpoint = {
  baseUrl: string
}

export type ProviderModel = {
  id: string
  displayName?: string
  apiFormat?: ProviderApiFormat
  enabled?: boolean
  source?: ProviderModelSource
}

export type ProviderDefaults = {
  modelId?: string
  apps?: {
    claudeCode?: { modelId?: string }
    genericAgent?: { modelId?: string }
    summary?: { modelId?: string }
  }
  timeoutSeconds?: number
  readTimeoutSeconds?: number
  maxRetries?: number
  stream?: boolean
  proxy?: string
}

export type ClaudeCodeProviderOptions = {
  enabled: boolean
  permissionMode: PermissionMode
  apiKeyEnv?: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN'
  useSettingsEnv: true
  extraEnv?: Record<string, string>
  extraConfig?: Record<string, string | number | boolean>
}

export type GenericAgentSessionType = 'native_claude' | 'native_oai'

export type GenericAgentProviderOptions = {
  enabled: boolean
  sessionType: GenericAgentSessionType
  name?: string
  apiMode?: 'chat_completions' | 'responses'
  fakeCcSystemPrompt?: boolean
  thinkingType?: 'adaptive' | 'enabled' | 'disabled'
  thinkingBudgetTokens?: number
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  contextWindow?: number
  maxTokens?: number
  temperature?: number
  userAgent?: string
  extraConfig?: Record<string, string | number | boolean>
}

export type ProviderProfile = {
  id: string
  name: string
  apiFormat: ProviderApiFormat
  protocol?: ProviderProtocol
  auth: ProviderAuth
  endpoint: ProviderEndpoint
  model?: ProviderModel
  models: ProviderModel[]
  defaults?: ProviderDefaults
  adapters?: {
    claudeCode?: ClaudeCodeProviderOptions
    genericAgent?: GenericAgentProviderOptions
  }
  notes?: string
}

export type ProviderCatalog = {
  version: 2
  providers: ProviderProfile[]
}

export type SafeProviderProfile = Omit<ProviderProfile, 'auth'> & {
  auth: {
    type: 'api-key'
    hasApiKey: boolean
    apiKeyPreview: string
  }
}

export type SafeProviderCatalog = {
  version: 2
  providers: SafeProviderProfile[]
}

export type ProviderProfilePatch = Omit<Partial<ProviderProfile>, 'auth'> & {
  id: string
  name: string
  auth: {
    type: 'api-key'
    apiKey?: string
  }
}

export type ProviderCatalogPatch = {
  version: 1 | 2
  providers: ProviderProfilePatch[]
}
