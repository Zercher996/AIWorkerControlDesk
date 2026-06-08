import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Project, Session, SessionAiEvent, SessionAiEventsReadInput, SessionAiEventsReadResult, SessionAttentionEvent, SessionOutputEvent, StartSessionInput, GenericAgentConfig, ProviderProfile, CurrentClaudeConfig } from '../../src/types/workerDesk'
import type { ManagedPtyProcess } from './claudePty'
import { startClaudePty } from './claudePty'
import type { ManagedHeadlessProcess } from './claudeHeadlessStream'
import { startClaudeHeadlessStream } from './claudeHeadlessStream'
import type { ClaudeCodeLaunchConfig } from '../providers/claudeCodeProviderAdapter'
import { buildClaudeCodeLaunchConfig, buildClaudeCodeLaunchConfigFromEnv, withClaudeCodeSettings } from '../providers/claudeCodeProviderAdapter'
import { matchCliSessionByMtime, findClaudeProjectDir } from './cliHistory'
import { startClaudeCliJsonlTail, type ManagedClaudeCliJsonlTail, type ClaudeCliJsonlTailInput } from './claudeCliJsonlTail'
import { createGenericAgentStarter, type GenericAgentProcessStarter } from './genericAgentPty'
import { buildGenericAgentLaunchConfig } from '../providers/genericAgentProviderAdapter'
import type { ClaudeHookSettings } from './claudeHookSettings'
import { CLAUDE_BYPASS_CONFIRMATION_WAITING_MESSAGE, getClaudeStartupGateExitMessage, getNextStatusFromOutput, isClaudeBypassPermissionsConfirmation, markInputWritten } from './sessionState'
import { resolveProviderModel, validateProviderForWorker } from '../providers/providerValidation'
import { startOpenAiLocalRelay, type OpenAiLocalRelay } from '../providers/openAiLocalRelay'
import { startClaudeCodeLocalRelay, type ClaudeCodeLocalRelay } from '../providers/claudeCodeLocalRelay'

type ProcessStarter = (input: {
  project: Project
  cwd: string
  cols: number
  rows: number
  resumeSessionId?: string
  launchConfig?: ClaudeCodeLaunchConfig
  onData(chunk: string): void
  onExit(event: { exitCode: number; signal?: number }): void
}) => ManagedPtyProcess

type HeadlessProcessStarter = (input: {
  project: Project
  cwd: string
  launchConfig: ClaudeCodeLaunchConfig
  sessionId: string
  onEvent(event: SessionAiEvent): void
  onExit(event: { exitCode: number; signal?: NodeJS.Signals }): void
}) => ManagedHeadlessProcess

type ManagedSessionProcess = {
  kind: 'pty' | 'headless' | 'native-jsonl'
  pid?: number
  write?: ManagedPtyProcess['write']
  resize?: ManagedPtyProcess['resize']
  sendUserMessage?: ManagedHeadlessProcess['sendUserMessage']
  kill: ManagedPtyProcess['kill'] | ManagedHeadlessProcess['kill']
}

type NativeJsonlTailStarter = (input: ClaudeCliJsonlTailInput) => ManagedClaudeCliJsonlTail

type SessionPersistence = {
  createSession(session: Session): Promise<void>
  updateSession(session: Session): Promise<void>
  appendOutput(event: SessionOutputEvent): Promise<void>
  appendAiEvent?(event: SessionAiEvent): Promise<void>
  getAiEvents?(input: SessionAiEventsReadInput): Promise<SessionAiEventsReadResult>
}

type CliSessionMatcher = (input: {
  workspacePath: string
  createdAtMs: number
  exitedAtMs: number
  claudeProjectsBaseDir?: string
}) => Promise<string | null>

type HookRegistration = {
  eventFilePath: string
  settings: ClaudeHookSettings
  dispose(): void
}

type ClaudeHookBridge = {
  registerSession(sessionId: string): Promise<HookRegistration>
}

type OpenAiLocalRelayStarter = (input: {
  upstreamBaseUrl: string
}) => Promise<OpenAiLocalRelay>

type ClaudeCodeLocalRelayStarter = (input: {
  upstreamBaseUrl: string
  apiKey: string
}) => Promise<ClaudeCodeLocalRelay>

type SessionManagerDeps = {
  getProject(projectId: string): Promise<Project>
  getGenericAgentConfig?(configId: string): Promise<GenericAgentConfig>
  getProviderProfile?(providerId: string): Promise<ProviderProfile>
  getCurrentClaudeConfig?(): Promise<CurrentClaudeConfig>
  startProcess?: ProcessStarter
  startHeadlessProcess?: HeadlessProcessStarter
  startGenericProcess?: GenericAgentProcessStarter
  startNativeJsonlTail?: NativeJsonlTailStarter
  startOpenAiLocalRelay?: OpenAiLocalRelayStarter
  startClaudeCodeLocalRelay?: ClaudeCodeLocalRelayStarter
  claudeProjectsBaseDir?: string
  sessionStore?: SessionPersistence
  matchCliSession?: CliSessionMatcher
  hookBridge?: ClaudeHookBridge
  onOutput(event: SessionOutputEvent): void
  onAiEvent?(event: SessionAiEvent): void
  onSessionChanged(session: Session): void
  onSessionAttentionChanged?(event: SessionAttentionEvent): void
}

export type SessionManager = ReturnType<typeof createSessionManager>

export function createSessionManager(deps: SessionManagerDeps) {
  const sessions = new Map<string, Session>()
  const processes = new Map<string, ManagedSessionProcess>()
  const hookRegistrations = new Map<string, HookRegistration>()
  const buffers = new Map<string, string>()
  const nativeJsonlTailers = new Map<string, ManagedClaudeCliJsonlTail>()
  const nativeJsonlFileClaims = new Map<string, string>()
  const nativeJsonlCliSessionClaims = new Map<string, string>()
  const ccRelays = new Map<string, ClaudeCodeLocalRelay>()
  const userStoppedSessionIds = new Set<string>()
  const startupGateDiagnosticSessionIds = new Set<string>()
  const startProcess: ProcessStarter = deps.startProcess ?? ((input) => startClaudePty({
    cwd: input.cwd,
    cols: input.cols,
    rows: input.rows,
    resumeSessionId: input.resumeSessionId,
    launchConfig: input.launchConfig!,
    onData: input.onData,
    onExit: input.onExit
  }))
  const startHeadlessProcess: HeadlessProcessStarter = deps.startHeadlessProcess ?? ((input) => startClaudeHeadlessStream({
    cwd: input.cwd,
    launchConfig: input.launchConfig,
    sessionId: input.sessionId,
    onEvent: input.onEvent,
    onExit: input.onExit
  }))

  const startGenericAgentPty = deps.startGenericProcess ? createGenericAgentStarter(deps.startGenericProcess) : undefined
  const startNativeJsonlTail: NativeJsonlTailStarter = deps.startNativeJsonlTail ?? startClaudeCliJsonlTail
  const startLocalRelay: OpenAiLocalRelayStarter = deps.startOpenAiLocalRelay ?? startOpenAiLocalRelay
  const startCcLocalRelay: ClaudeCodeLocalRelayStarter = deps.startClaudeCodeLocalRelay ?? startClaudeCodeLocalRelay
  const matchCliSession: CliSessionMatcher = deps.matchCliSession ?? matchCliSessionByMtime
  const claudeProjectsBaseDir = deps.claudeProjectsBaseDir ?? join(getHomeDir(), '.claude', 'projects')

  function updateSession(sessionId: string, patch: Partial<Session>): Session {
    const current = getSessionOrThrow(sessionId)
    const next = { ...current, ...patch, lastActivityAt: new Date().toISOString() }
    sessions.set(sessionId, next)
    deps.onSessionChanged(next)
    void deps.sessionStore?.updateSession(next).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const patched = { ...sessions.get(sessionId)!, errorMessage }
      sessions.set(sessionId, patched)
      deps.onSessionChanged(patched)
    })
    return next
  }

  function getSessionOrThrow(sessionId: string): Session {
    const session = sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return session
  }

  function createBaseSession(input: StartSessionInput, project: Project, sessionId: string, now: string, interactionMode: Session['interactionMode']): Session {
    const taskTitle = input.taskTitle?.trim()
    return {
      id: sessionId,
      projectId: project.id,
      workerType: input.workerType,
      interactionMode,
      status: 'starting',
      title: project.name,
      taskTitle: taskTitle || undefined,
      createdAt: now,
      lastActivityAt: now,
      outputRef: `jsonl:${sessionId}`,
      parentSessionId: input.parentSessionId,
      dispatchMode: input.dispatchMode,
      dispatchTask: input.dispatchTask,
      genericAgentConfigId: input.genericAgentConfigId,
      providerProfileId: input.providerProfileId
    }
  }

  async function withHooks(sessionId: string, launchConfig: ClaudeCodeLaunchConfig): Promise<ClaudeCodeLaunchConfig> {
    if (!deps.hookBridge) return launchConfig
    const registration = await deps.hookBridge.registerSession(sessionId)
    hookRegistrations.set(sessionId, registration)
    return withClaudeCodeSettings(launchConfig, registration.settings)
  }

  function disposeHooks(sessionId: string): void {
    hookRegistrations.get(sessionId)?.dispose()
    hookRegistrations.delete(sessionId)
  }

  function releaseNativeJsonlClaims(sessionId: string): void {
    for (const [filePath, ownerSessionId] of nativeJsonlFileClaims.entries()) {
      if (ownerSessionId === sessionId) nativeJsonlFileClaims.delete(filePath)
    }
    for (const [cliSessionId, ownerSessionId] of nativeJsonlCliSessionClaims.entries()) {
      if (ownerSessionId === sessionId) nativeJsonlCliSessionClaims.delete(cliSessionId)
    }
  }

  function claimNativeJsonlFile(input: { deskSessionId: string; filePath: string; fileCreatedAtMs?: number; cliSessionId?: string }): boolean {
    const fileOwner = nativeJsonlFileClaims.get(input.filePath)
    if (fileOwner && fileOwner !== input.deskSessionId) return false
    if (input.fileCreatedAtMs != null) {
      const current = sessions.get(input.deskSessionId)
      const currentDistance = current ? Math.abs(input.fileCreatedAtMs - Date.parse(current.createdAt)) : Number.POSITIVE_INFINITY
      for (const [candidateSessionId, candidate] of sessions.entries()) {
        if (candidateSessionId === input.deskSessionId) continue
        if (candidate.workerType !== 'claude-code' || candidate.interactionMode !== 'native-jsonl') continue
        if (candidate.status === 'failed' || candidate.status === 'exited' || candidate.status === 'stopped') continue
        if (candidate.cliSessionId) continue
        const candidateDistance = Math.abs(input.fileCreatedAtMs - Date.parse(candidate.createdAt))
        if (candidateDistance + 1 < currentDistance) return false
      }
    }
    if (input.cliSessionId) {
      const cliOwner = nativeJsonlCliSessionClaims.get(input.cliSessionId)
      if (cliOwner && cliOwner !== input.deskSessionId) return false
      nativeJsonlCliSessionClaims.set(input.cliSessionId, input.deskSessionId)
    }
    nativeJsonlFileClaims.set(input.filePath, input.deskSessionId)
    return true
  }

  function stopNativeJsonlTailer(sessionId: string): ManagedClaudeCliJsonlTail | undefined {
    const tailer = nativeJsonlTailers.get(sessionId)
    nativeJsonlTailers.delete(sessionId)
    releaseNativeJsonlClaims(sessionId)
    tailer?.stop()
    return tailer
  }

  function handleStructuredAiEvent(sessionId: string, event: SessionAiEvent): void {
    const current = getSessionOrThrow(sessionId)
    void deps.sessionStore?.appendAiEvent?.(event).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error)
      updateSession(sessionId, { errorMessage })
    })
    deps.onAiEvent?.(event)
    const sessionFailureMessage = failureMessageFromAiEvent(event)
    if (sessionFailureMessage) {
      const latest = sessions.get(sessionId) ?? current
      updateSession(sessionId, {
        status: 'failed',
        cliSessionId: 'cliSessionId' in event ? event.cliSessionId ?? latest.cliSessionId : latest.cliSessionId,
        errorMessage: sessionFailureMessage
      })
      return
    }
    if (event.type === 'system' && event.cliSessionId && !current.cliSessionId) {
      const nextStatus = current.status === 'starting' ? 'running' : current.status
      updateSession(sessionId, { cliSessionId: event.cliSessionId, status: nextStatus })
      return
    }
    if (event.type === 'user_message' || event.type === 'assistant_text' || event.type === 'tool_use' || event.type === 'tool_result') {
      const latest = sessions.get(sessionId) ?? current
      if (latest.status === 'starting' || latest.status === 'idle' || latest.status === 'waiting') {
        updateSession(sessionId, { status: 'running' })
      } else {
        updateSession(sessionId, {})
      }
      return
    }
    if (event.type === 'result') {
      const latest = sessions.get(sessionId) ?? current
      updateSession(sessionId, {
        status: event.status === 'error' ? 'failed' : (latest.status === 'exited' || latest.status === 'stopped' || latest.status === 'failed' ? latest.status : 'waiting'),
        cliSessionId: event.cliSessionId ?? latest.cliSessionId,
        errorMessage: event.errorMessage ?? latest.errorMessage
      })
      return
    }
    if (event.type === 'turn_end') {
      const latest = sessions.get(sessionId) ?? current
      updateSession(sessionId, {
        status: latest.status === 'exited' || latest.status === 'stopped' || latest.status === 'failed' ? latest.status : 'waiting',
        cliSessionId: event.cliSessionId ?? latest.cliSessionId
      })
      return
    }
    updateSession(sessionId, {})
  }

  function failureMessageFromAiEvent(event: SessionAiEvent): string | undefined {
    if (event.type === 'assistant_text' && isClaudeAuthFailureText(event.text)) return event.text.trim()
    if (event.type === 'result' && event.status === 'error') return event.errorMessage?.trim() || undefined
    return undefined
  }

  function isClaudeAuthFailureText(text: string): boolean {
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
    return /please run\s+\/login\b|run\s+\/login\b|401\s+unauthorized|invalid api key|api key (?:is )?invalid|authentication (?:failed|required)|not logged in/.test(normalized)
  }

  function emitDeskDiagnostic(sessionId: string, level: 'info' | 'warning' | 'error', message: string): void {
    handleStructuredAiEvent(sessionId, {
      id: `desk-diagnostic:${sessionId}:${Date.now()}`,
      sessionId,
      timestamp: new Date().toISOString(),
      source: 'desk',
      type: 'diagnostic',
      level,
      stream: 'lifecycle',
      message
    })
  }

  function handlePtyOutput(sessionId: string, chunk: string): void {
    const timestamp = new Date().toISOString()
    buffers.set(sessionId, `${buffers.get(sessionId) ?? ''}${chunk}`)
    const current = getSessionOrThrow(sessionId)
    const nextStatus = getNextStatusFromOutput(current.status, chunk)
    if (nextStatus !== current.status) {
      updateSession(sessionId, { status: nextStatus })
    } else {
      updateSession(sessionId, {})
    }
    if (isClaudeBypassPermissionsConfirmation(chunk) && !startupGateDiagnosticSessionIds.has(sessionId)) {
      startupGateDiagnosticSessionIds.add(sessionId)
      emitDeskDiagnostic(sessionId, 'warning', CLAUDE_BYPASS_CONFIRMATION_WAITING_MESSAGE)
    }
    deps.onOutput({ sessionId, chunk, stream: 'stdout', timestamp })
    void deps.sessionStore?.appendOutput({ sessionId, chunk, stream: 'stdout', timestamp }).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error)
      updateSession(sessionId, { errorMessage })
    })
  }

  function handleClaudeExit(sessionId: string, project: Project, exitCode: number): void {
    const tailer = nativeJsonlTailers.get(sessionId)
    if (tailer) {
      void tailer.pollNow().catch(() => undefined).finally(() => stopNativeJsonlTailer(sessionId))
    }
    processes.delete(sessionId)
    const relay = ccRelays.get(sessionId)
    ccRelays.delete(sessionId)
    relay?.close()
    disposeHooks(sessionId)
    const exitedAt = new Date().toISOString()
    const current = sessions.get(sessionId)
    const wasUserStopped = userStoppedSessionIds.delete(sessionId)
    const startupGateExitMessage = !wasUserStopped && exitCode !== 0 ? getClaudeStartupGateExitMessage(buffers.get(sessionId) ?? '') : undefined
    startupGateDiagnosticSessionIds.delete(sessionId)
    updateSession(sessionId, {
      status: wasUserStopped ? 'stopped' : exitCode === 0 && current?.status !== 'failed' ? 'exited' : 'failed',
      exitCode,
      exitedAt,
      errorMessage: startupGateExitMessage ?? current?.errorMessage
    })
    const created = sessions.get(sessionId)?.createdAt
    if (created) {
      void matchCliSession({
        workspacePath: project.path,
        createdAtMs: Date.parse(created),
        exitedAtMs: Date.parse(exitedAt),
        claudeProjectsBaseDir
      })
        .then((cliSessionId) => {
          if (cliSessionId) updateSession(sessionId, { cliSessionId })
        })
        .catch(() => {
        })
    }
  }

  function startClaudeProcess(input: {
    sessionId: string
    project: Project
    launchConfig: ClaudeCodeLaunchConfig
    resumeSessionId?: string
    terminalSize?: { cols: number; rows: number }
  }): ManagedSessionProcess {
    if (sessions.get(input.sessionId)?.interactionMode === 'headless') {
      const child = startHeadlessProcess({
        project: input.project,
        cwd: input.project.path,
        launchConfig: input.launchConfig,
        sessionId: input.sessionId,
        onEvent: (event) => handleStructuredAiEvent(input.sessionId, event),
        onExit: ({ exitCode }) => handleClaudeExit(input.sessionId, input.project, exitCode)
      })
      return { ...child, kind: 'headless' }
    }

    const child = startProcess({
      project: input.project,
      cwd: input.project.path,
      cols: input.terminalSize?.cols ?? 100,
      rows: input.terminalSize?.rows ?? 30,
      resumeSessionId: input.resumeSessionId,
      launchConfig: input.launchConfig,
      onData: (chunk) => handlePtyOutput(input.sessionId, chunk),
      onExit: ({ exitCode }) => handleClaudeExit(input.sessionId, input.project, exitCode)
    })
    return { ...child, kind: sessions.get(input.sessionId)?.interactionMode === 'native-jsonl' ? 'native-jsonl' : 'pty' }
  }

  async function snapshotExistingClaudeJsonlFiles(workspacePath: string): Promise<string[]> {
    const projectDir = await findClaudeProjectDir(claudeProjectsBaseDir, workspacePath)
    if (!projectDir) return []
    let entries: string[]
    try {
      entries = await readdir(projectDir)
    } catch {
      return []
    }
    return entries
      .filter((entry) => entry.endsWith('.jsonl') && !entry.startsWith('agent-'))
      .map((entry) => join(projectDir, entry))
  }

  function startNativeJsonlProjection(sessionId: string, project: Project, ignoredCliJsonlFilePaths: string[] = []): void {
    const session = getSessionOrThrow(sessionId)
    const tailer = startNativeJsonlTail({
      deskSessionId: sessionId,
      workspacePath: project.path,
      createdAtMs: Date.parse(session.createdAt),
      claudeProjectsBaseDir,
      ignoredCliJsonlFilePaths,
      claimCliJsonlFile: claimNativeJsonlFile,
      onCliSessionMatched: (cliSessionId, filePath) => {
        if (!claimNativeJsonlFile({ deskSessionId: sessionId, filePath, cliSessionId })) return
        const current = sessions.get(sessionId)
        if (!current || current.cliSessionId === cliSessionId) return
        updateSession(sessionId, { cliSessionId })
      },
      onEvent: (event) => handleStructuredAiEvent(sessionId, event),
      onDiagnostic: (message) => handleStructuredAiEvent(sessionId, {
        id: `claude-jsonl-diagnostic:${sessionId}:${Date.now()}`,
        sessionId,
        timestamp: new Date().toISOString(),
        source: 'desk',
        type: 'diagnostic',
        level: 'warning',
        stream: 'lifecycle',
        message
      })
    })
    nativeJsonlTailers.set(sessionId, tailer)
  }

  return {
    async startSession(input: StartSessionInput): Promise<Session> {
      const project = await deps.getProject(input.projectId)
      const now = new Date().toISOString()
      const sessionId = randomUUID()
      const requestedInteractionMode = input.workerType === 'claude-code' ? input.interactionMode : undefined
      const interactionMode: Session['interactionMode'] = requestedInteractionMode ?? (input.workerType === 'claude-code' ? 'native-jsonl' : 'pty')
      const session = createBaseSession(input, project, sessionId, now, interactionMode)
      sessions.set(sessionId, session)
      buffers.set(sessionId, '')
      deps.onSessionChanged(session)
      void deps.sessionStore?.createSession(session).catch(() => {
        // Session persistence failure is non-fatal; session still works in memory
      })

      try {
        if (input.workerType === 'claude-code') {
          if (input.claudeLaunchSource?.type === 'current-claude-config') {
            if (!deps.getCurrentClaudeConfig) {
              throw new Error('getCurrentClaudeConfig is not available')
            }
            const currentConfig = await deps.getCurrentClaudeConfig()
            const launchConfig = await withHooks(sessionId, buildClaudeCodeLaunchConfigFromEnv(currentConfig.env))
            updateSession(sessionId, {
              providerProfileId: undefined,
              providerName: 'Current Claude Config',
              modelId: currentConfig.model,
              modelDisplayName: currentConfig.model || currentConfig.baseUrl,
              title: `${project.name} / Current Claude Config`
            })

            const existingCliJsonlFiles = session.interactionMode === 'native-jsonl' ? await snapshotExistingClaudeJsonlFiles(project.path) : []
            const child = startClaudeProcess({
              sessionId,
              project,
              launchConfig,
              resumeSessionId: input.resumeSessionId,
              terminalSize: input.terminalSize
            })
            processes.set(sessionId, child)
            if (sessions.get(sessionId)?.interactionMode === 'native-jsonl') {
              startNativeJsonlProjection(sessionId, project, existingCliJsonlFiles)
              if (child.write && input.initialPrompt?.trim()) child.write(`${input.initialPrompt.trim()}\r`)
            }
            return updateSession(sessionId, child.kind === 'headless' ? { processId: child.pid, status: 'running' } : { processId: child.pid })
          }

          if (!input.providerProfileId) {
            throw new Error('providerProfileId is required for claude-code')
          }
          if (!deps.getProviderProfile) {
            throw new Error('getProviderProfile is not available')
          }
          const provider = await deps.getProviderProfile(input.providerProfileId)
          const providerModel = resolveProviderModel(provider, input.providerModelId, 'claudeCode')
          validateProviderForWorker(provider, 'claude-code', providerModel)
          let ccRelay: ClaudeCodeLocalRelay | undefined
          if (provider.adapters?.claudeCode?.extraConfig?.relay === true) {
            ccRelay = await startCcLocalRelay({ upstreamBaseUrl: provider.endpoint.baseUrl, apiKey: provider.auth.apiKey })
          }
          const launchConfig = await withHooks(sessionId, buildClaudeCodeLaunchConfig({ provider, model: providerModel }))
          if (ccRelay) {
            ccRelays.set(sessionId, ccRelay)
            launchConfig.env.ANTHROPIC_BASE_URL = ccRelay.baseUrl
            const noProxyEnv = withNoProxyForLocalRelay({ env: launchConfig.env, command: launchConfig.command, providerConfigJson: '' })
            launchConfig.env = noProxyEnv.env
            const settingsIndex = launchConfig.command.args.indexOf('--settings')
            if (settingsIndex >= 0 && settingsIndex + 1 < launchConfig.command.args.length) {
              const settings = JSON.parse(launchConfig.command.args[settingsIndex + 1]) as { env?: Record<string, string> }
              launchConfig.command.args[settingsIndex + 1] = JSON.stringify({
                ...settings,
                env: {
                  ...(settings.env ?? {}),
                  ...launchConfig.env
                }
              })
            }
          }
          updateSession(sessionId, {
            providerProfileId: provider.id,
            providerName: provider.name,
            modelId: providerModel.id,
            modelDisplayName: providerModel.displayName || providerModel.id,
            title: `${project.name} / ${provider.name}`
          })

          const existingCliJsonlFiles = session.interactionMode === 'native-jsonl' ? await snapshotExistingClaudeJsonlFiles(project.path) : []
          const child = startClaudeProcess({
            sessionId,
            project,
            launchConfig,
            resumeSessionId: input.resumeSessionId,
            terminalSize: input.terminalSize
          })
          processes.set(sessionId, child)
          if (sessions.get(sessionId)?.interactionMode === 'native-jsonl') {
            startNativeJsonlProjection(sessionId, project, existingCliJsonlFiles)
            if (child.write && input.initialPrompt?.trim()) child.write(`${input.initialPrompt.trim()}\r`)
          }
          return updateSession(sessionId, child.kind === 'headless' ? { processId: child.pid, status: 'running' } : { processId: child.pid })
        }

        if (!input.providerProfileId) {
          throw new Error('providerProfileId is required for generic-agent')
        }
        if (!input.genericAgentConfigId) {
          throw new Error('genericAgentConfigId is required for generic-agent')
        }
        if (!deps.getGenericAgentConfig) {
          throw new Error('getGenericAgentConfig is not available')
        }
        if (!deps.getProviderProfile) {
          throw new Error('getProviderProfile is not available')
        }
        if (!startGenericAgentPty) {
          throw new Error('startGenericProcess is not available')
        }

        const config = await deps.getGenericAgentConfig(input.genericAgentConfigId)
        const provider = await deps.getProviderProfile(input.providerProfileId)
        const providerModel = resolveProviderModel(provider, input.providerModelId, 'genericAgent')
        validateProviderForWorker(provider, 'generic-agent', providerModel)
        let launchConfig = buildGenericAgentLaunchConfig({ provider, model: providerModel, genericAgent: config })
        let localRelay: OpenAiLocalRelay | undefined
        if (provider.adapters?.genericAgent?.sessionType === 'native_oai' && provider.adapters.genericAgent.extraConfig?.local_fetch_relay === true) {
          localRelay = await startLocalRelay({ upstreamBaseUrl: provider.endpoint.baseUrl })
          launchConfig = withGenericAgentProviderConfig(launchConfig, (providerConfig) => {
            providerConfig.config.apibase = localRelay!.baseUrl
            delete providerConfig.config.local_fetch_relay
            return providerConfig
          })
          launchConfig = withNoProxyForLocalRelay(launchConfig)
        }
        updateSession(sessionId, {
          title: `${project.name} / ${provider.name} / ${config.name}`,
          providerProfileId: provider.id,
          providerName: provider.name,
          modelId: providerModel.id,
          modelDisplayName: providerModel.displayName || providerModel.id,
        })

        const child = startGenericAgentPty({
          config,
          cwd: project.path,
          cols: input.terminalSize?.cols ?? 100,
          rows: input.terminalSize?.rows ?? 30,
          initialPrompt: input.initialPrompt,
          launchConfig,
          onData: (chunk) => {
            const timestamp = new Date().toISOString()
            buffers.set(sessionId, `${buffers.get(sessionId) ?? ''}${chunk}`)
            const current = getSessionOrThrow(sessionId)
            const nextStatus = getNextStatusFromOutput(current.status, chunk)
            if (nextStatus !== current.status) {
              updateSession(sessionId, { status: nextStatus })
            } else {
              updateSession(sessionId, {})
            }
            deps.onOutput({ sessionId, chunk, stream: 'stdout', timestamp })
            void deps.sessionStore?.appendOutput({ sessionId, chunk, stream: 'stdout', timestamp }).catch((error) => {
              const errorMessage = error instanceof Error ? error.message : String(error)
              updateSession(sessionId, { errorMessage })
            })
          },
          onExit: ({ exitCode }) => {
            processes.delete(sessionId)
            localRelay?.close()
            const wasUserStopped = userStoppedSessionIds.delete(sessionId)
            updateSession(sessionId, {
              status: wasUserStopped ? 'stopped' : exitCode === 0 ? 'exited' : 'failed',
              exitCode,
              exitedAt: new Date().toISOString()
            })
          }
        })
        processes.set(sessionId, { ...child, kind: 'pty' })
        return updateSession(sessionId, { processId: child.pid })
      } catch (error) {
        return updateSession(sessionId, {
          status: 'failed',
          exitedAt: new Date().toISOString(),
          errorMessage: error instanceof Error ? error.message : String(error)
        })
      }
    },

    listSessions(): Session[] {
      return [...sessions.values()]
    },

    selectSession(sessionId: string): Session {
      return getSessionOrThrow(sessionId)
    },

    getOutputBuffer(sessionId: string): string {
      getSessionOrThrow(sessionId)
      return buffers.get(sessionId) ?? ''
    },

    async writeSessionInput(sessionId: string, data: string): Promise<void> {
      const process = processes.get(sessionId)
      if (!process) {
        throw new Error(`Session is not running: ${sessionId}`)
      }
      if (!process.write) {
        throw new Error(`Session process does not support terminal input: ${sessionId}`)
      }
      process.write(data)
      const current = getSessionOrThrow(sessionId)
      updateSession(sessionId, { status: markInputWritten(current.status) })
    },

    async sendSessionMessage(sessionId: string, text: string): Promise<void> {
      const trimmed = text.trim()
      if (!trimmed) return
      const session = getSessionOrThrow(sessionId)
      if (session.status === 'exited' || session.status === 'failed' || session.status === 'stopped') {
        throw new Error(`Session is not running: ${sessionId}`)
      }
      const process = processes.get(sessionId)
      if (!process) {
        throw new Error(`Session is not running: ${sessionId}`)
      }
      if (!process.sendUserMessage) {
        throw new Error(`Session process does not support AI message input: ${sessionId}`)
      }
      process.sendUserMessage(trimmed)
      handleStructuredAiEvent(sessionId, {
        id: randomUUID(),
        sessionId,
        timestamp: new Date().toISOString(),
        source: 'desk',
        type: 'user_message',
        text: trimmed
      })
    },

    async getSessionAiEvents(input: SessionAiEventsReadInput): Promise<SessionAiEventsReadResult> {
      getSessionOrThrow(input.sessionId)
      return deps.sessionStore?.getAiEvents?.(input) ?? { events: [], totalBytes: 0 }
    },

    async stopSession(sessionId: string): Promise<void> {
      const process = processes.get(sessionId)
      if (!process) return
      userStoppedSessionIds.add(sessionId)
      process.kill()
    },

    resizeSession(sessionId: string, cols: number, rows: number): void {
      const process = processes.get(sessionId)
      if (!process?.resize) return
      process.resize(cols, rows)
    }
  }
}

type GenericAgentProviderConfigPayload = {
  sessionType: string
  config: Record<string, string | number | boolean>
}

function withGenericAgentProviderConfig(
  launchConfig: ReturnType<typeof buildGenericAgentLaunchConfig>,
  map: (providerConfig: GenericAgentProviderConfigPayload) => GenericAgentProviderConfigPayload
): ReturnType<typeof buildGenericAgentLaunchConfig> {
  const current = JSON.parse(launchConfig.providerConfigJson) as GenericAgentProviderConfigPayload
  const nextProviderConfig = map(current)
  const providerConfigJson = JSON.stringify(nextProviderConfig)
  return {
    ...launchConfig,
    providerConfigJson,
    env: {
      ...launchConfig.env,
      GENERIC_AGENT_PROVIDER_CONFIG_JSON: providerConfigJson
    }
  }
}

function withNoProxyForLocalRelay<T extends { env: NodeJS.ProcessEnv }>(launchConfig: T): T {
  const noProxy = mergeNoProxy(launchConfig.env.NO_PROXY, '127.0.0.1', 'localhost')
  const lowerNoProxy = mergeNoProxy(launchConfig.env.no_proxy, '127.0.0.1', 'localhost')
  return {
    ...launchConfig,
    env: {
      ...launchConfig.env,
      NO_PROXY: noProxy,
      no_proxy: lowerNoProxy
    }
  }
}

function mergeNoProxy(current: string | undefined, ...required: string[]): string {
  const values = new Set((current ?? '').split(',').map((item) => item.trim()).filter(Boolean))
  for (const value of required) values.add(value)
  return [...values].join(',')
}

function getHomeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || ''
}
