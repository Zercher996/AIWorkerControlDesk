import { useState } from 'react'
import type { CliHistorySession, SessionHistoryItem } from '../types/workerDesk'
import { SearchBox } from './SearchBox'

function isCliSession(item: SessionHistoryItem): item is CliHistorySession {
  return item.source === 'cli'
}

function historyStatusLabel(status: string): string {
  if (status === 'exited') return '已完成'
  if (status === 'stopped') return '已停止'
  if (status === 'failed') return '失败'
  return status
}

type HistoryPanelProps = {
  resumableItems?: SessionHistoryItem[]
  items: SessionHistoryItem[]
  lowSignalItems?: SessionHistoryItem[]
  selectedSessionId?: string
  query: string
  projectName?: string
  onQueryChange(query: string): void
  onSearch(query: string): void
  onSelectSession(sessionId: string): void
}

function renderCard(
  session: SessionHistoryItem,
  selectedSessionId: string | undefined,
  onSelectSession: (id: string) => void,
  resumable = false
) {
  const isCli = isCliSession(session)
  const title = isCli ? session.firstMessage : session.title
  const statusText = isCli ? 'exited' : session.status
  const timeText = isCli
    ? new Date(session.updatedAt).toLocaleString()
    : new Date(session.exitedAt ?? session.lastActivityAt).toLocaleString()
  const showGaBadge = !isCli && session.workerType === 'generic-agent'
  return (
    <button
      key={session.id}
      className={session.id === selectedSessionId ? 'history-card selected' : 'history-card'}
      aria-current={session.id === selectedSessionId ? 'true' : undefined}
      onClick={() => onSelectSession(session.id)}
    >
      <span className="session-title">
        {resumable ? <span className="worker-badge resumable">可继续</span> : null}
        {showGaBadge ? <span className="worker-badge ga">GA</span> : null}
        {title}
      </span>
      <span className={`status status-${statusText}`}>{historyStatusLabel(statusText)}</span>
      <span className="session-time">{timeText}</span>
    </button>
  )
}

export function HistoryPanel(props: HistoryPanelProps) {
  const [showLowSignal, setShowLowSignal] = useState(false)
  const resumable = props.resumableItems ?? []
  const lowSignal = props.lowSignalItems ?? []
  const totalVisibleCount = resumable.length + props.items.length

  return (
    <section className="panel history-panel">
      <h2>History</h2>
      <p className="history-scope">
        {props.projectName
          ? <>当前项目：<strong>{props.projectName}</strong> · {totalVisibleCount} 条</>
          : '请先选择一个项目以查看历史'}
      </p>
      <SearchBox query={props.query} onQueryChange={props.onQueryChange} onSearch={props.onSearch} />
      {props.projectName && totalVisibleCount === 0 && lowSignal.length === 0 ? <p className="empty">暂无历史 Session</p> : null}
      <div className="history-list">
        {resumable.map((session) => renderCard(session, props.selectedSessionId, props.onSelectSession, true))}
        {props.items.map((session) => renderCard(session, props.selectedSessionId, props.onSelectSession))}
        {lowSignal.length > 0 ? (
          <button
            type="button"
            className="history-low-signal-toggle"
            onClick={() => setShowLowSignal((v) => !v)}
            aria-expanded={showLowSignal}
          >
            {showLowSignal ? `收起 ${lowSignal.length} 条低信号记录` : `展开 ${lowSignal.length} 条低信号记录`}
          </button>
        ) : null}
        {showLowSignal
          ? lowSignal.map((session) => renderCard(session, props.selectedSessionId, props.onSelectSession))
          : null}
      </div>
    </section>
  )
}
