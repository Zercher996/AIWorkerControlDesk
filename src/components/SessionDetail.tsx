import type { CliHistorySession, DeskHistoryItem, SessionHistoryItem } from '../types/workerDesk'

const LARGE_OUTPUT_THRESHOLD = 50 * 1024 * 1024 // 50 MB

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

function roleLabel(workerType: DeskHistoryItem['workerType']): string {
  return workerType === 'generic-agent' ? 'GenericAgent 子 Worker' : 'Claude Code 主控'
}

function dispatchLabel(dispatchMode: DeskHistoryItem['dispatchMode']): string | undefined {
  if (dispatchMode === 'auto') return 'automatic from [GA_TASK:generic-agent]'
  if (dispatchMode === 'manual') return 'manual'
  return undefined
}

function isCliSession(session?: SessionHistoryItem): session is CliHistorySession {
  return session?.source === 'cli'
}

type SessionDetailProps = {
  session?: SessionHistoryItem
  output: string
  summary?: string
  hasMoreOutput: boolean
  outputSizeBytes: number
  isLoading: boolean
  isLoadingMore: boolean
  isStartingSession: boolean
  source?: 'desk' | 'cli'
  selectedProjectId?: string
  selectedProviderProfileId?: string
  currentProviderName?: string
  onGenerateSummary(sessionId: string): void
  onExport(sessionId: string): void
  onLoadMore(sessionId: string): void
  onResumeSession(sessionId: string): void
  onBack(): void
}

function resumeHint(props: SessionDetailProps, deskSession: DeskHistoryItem | undefined): string {
  if (!props.summary) return '需要先生成 Summary，才能基于 Summary 继续任务'
  if (!props.selectedProviderProfileId) return '需要先选择模型连接才能继续任务'
  const base = '将基于 Summary 新建真实 Session，不恢复原运行态。'
  if (deskSession?.providerName && props.currentProviderName && deskSession.providerName !== props.currentProviderName) {
    return `${base} 将使用当前模型连接（${props.currentProviderName}），原会话使用的是 ${deskSession.providerName}`
  }
  return base
}

export function SessionDetail(props: SessionDetailProps) {
  if (!props.session) {
    return (
      <section className="panel session-detail">
        <p className="empty">请选择历史 Session。</p>
      </section>
    )
  }

  const isCli = isCliSession(props.session) || props.source === 'cli'
  const deskSession = isCli ? undefined : props.session as DeskHistoryItem
  const title = isCli ? (props.session as CliHistorySession).firstMessage : deskSession!.title
  const statusText = isCli ? 'exited' : deskSession!.status
  const fileSizeBytes = isCli ? (props.session as CliHistorySession).fileSizeBytes : props.outputSizeBytes

  return (
    <section className="panel session-detail">
      <header className="detail-header">
        <div>
          <button className="detail-back" onClick={props.onBack}>&#8592; Back</button>
          <h2>{title}</h2>
          <span className={`status status-${statusText}`}>{statusText}</span>
          {deskSession && (
            <p className="session-detail-meta">
              <span>Session ID: {shortSessionId(deskSession.id)}</span>
              <span>Role: {roleLabel(deskSession.workerType)}</span>
              <span>Worker: {deskSession.workerType}</span>
              {dispatchLabel(deskSession.dispatchMode) ? <span>Dispatch: {dispatchLabel(deskSession.dispatchMode)}</span> : null}
              {deskSession.parentSessionId ? <span>Parent Claude Session: {shortSessionId(deskSession.parentSessionId)}</span> : null}
              {(deskSession.providerName || deskSession.modelId) && (
                <span>Provider: {deskSession.providerName ?? '未知'} / {deskSession.modelDisplayName ?? deskSession.modelId ?? '未知'}</span>
              )}
            </p>
          )}
        </div>
        <div className="detail-actions">
          <button disabled={props.isLoading} onClick={() => props.onGenerateSummary(props.session!.id)}>生成 Summary</button>
          {!isCli && <button onClick={() => props.onExport(props.session!.id)}>导出输出</button>}
          <button disabled={!props.selectedProviderProfileId || !props.summary || props.isStartingSession} onClick={() => props.onResumeSession(props.session!.id)}>
            {props.isStartingSession ? '启动中…' : '基于 Summary 继续任务'}
          </button>
        </div>
      </header>
      <p className="resume-hint">
        {resumeHint(props, deskSession)}
      </p>
      <h3>Output</h3>
      {!isCli && fileSizeBytes > LARGE_OUTPUT_THRESHOLD && (
        <div className="output-warning">
          输出超过 50 MB（{formatBytes(fileSizeBytes)}），加载可能较慢。完整内容不会被截断。
        </div>
      )}
      <pre className="history-output">{props.output}</pre>
      {!isCli && props.hasMoreOutput && (
        <button
          className="load-more-btn"
          disabled={props.isLoadingMore}
          onClick={() => props.onLoadMore(props.session!.id)}
        >
          {props.isLoadingMore ? '加载中…' : '加载更多输出'}
        </button>
      )}
      <h3>Summary</h3>
      <article className="summary-output">{props.summary ?? '尚未生成 Summary。'}</article>
    </section>
  )
}
