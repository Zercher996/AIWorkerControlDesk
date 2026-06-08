import { useMemo, useState } from 'react'
import type { MouseEvent } from 'react'
import type { Session, SessionUserAttention, WorkerType } from '../types/workerDesk'
import { displayAttentionState, getSessionAttentionState, type SessionAttentionState } from '../utils/sessionAttention'

type SessionFilter = 'all' | 'active' | 'attention' | 'done'

type ChildAttention = {
  total: number
  needsReview: number
}

type WorkerOverview = {
  attentionPrompt?: string
  allCount: number
  takeoverCount: number
  runningCount: number
  completedCount: number
}

type DisplaySession = {
  session: Session
  displayTitle: string
  meta?: string
  duplicateHint?: string
}

type SessionGroup = {
  session: Session
  display: DisplaySession
  children: DisplaySession[]
  childAttention: ChildAttention
  index: number
  priority: number
}

const MAX_TITLE_LENGTH = 48
const filters: Array<{ value: SessionFilter; label: string; shortLabel: string }> = [
  { value: 'all', label: '全部', shortLabel: '全' },
  { value: 'attention', label: '待处理', shortLabel: '待' },
  { value: 'active', label: '进行中', shortLabel: '进' },
  { value: 'done', label: '已完成', shortLabel: '完' }
]

function workerTag(workerType: WorkerType): { label: string; className: string } {
  if (workerType === 'generic-agent') {
    return { label: 'G', className: 'session-worker-tag-generic' }
  }
  return { label: 'C', className: 'session-worker-tag-claude' }
}

function truncateText(text: string, maxLength = MAX_TITLE_LENGTH): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}…`
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 6)
}

function sessionTimeHint(session: Session): string {
  const value = session.createdAt || session.lastActivityAt
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return `#${shortSessionId(session.id)}`
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
}

function getSessionDisplayTitle(session: Session): string {
  if (session.taskTitle) return truncateText(session.taskTitle)
  if (session.workerType === 'generic-agent' && session.dispatchTask) return truncateText(session.dispatchTask)
  return truncateText(session.title || `Session ${shortSessionId(session.id)}`)
}

function sessionMeta(session: Session, duplicateHint?: string): string | undefined {
  const parts: string[] = []
  const missingProvider = !session.providerName
  const missingModel = !session.modelDisplayName && !session.modelId
  if (missingProvider || missingModel) {
    parts.push(session.providerName ?? '未知 Provider')
    parts.push(session.modelDisplayName ?? session.modelId ?? '未知 Model')
  }
  if (session.workerType === 'generic-agent' && session.dispatchMode) parts.push(session.dispatchMode === 'auto' ? '自动分派' : '手动')
  if (duplicateHint) parts.push(duplicateHint)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

function attentionLabel(state: SessionAttentionState): string {
  if (state === 'needsReview') return '待处理'
  if (state === 'completed') return '已完成'
  return '进行中'
}

function attentionClassName(state: SessionAttentionState): string {
  if (state === 'needsReview') return 'attention-review'
  if (state === 'completed') return 'attention-completed'
  return 'attention-working'
}

function statusLabel(status: Session['status']): string {
  if (status === 'running') return '进行中'
  if (status === 'waiting') return '等待中'
  if (status === 'failed') return '异常'
  if (status === 'stopped') return '已停止'
  if (status === 'exited') return '已完成'
  if (status === 'starting') return '启动中'
  return '空闲'
}

function statusPriority(status: Session['status']): number {
  if (status === 'waiting') return 0
  if (status === 'failed') return 1
  if (status === 'starting') return 2
  if (status === 'running') return 3
  if (status === 'idle') return 4
  if (status === 'exited') return 5
  if (status === 'stopped') return 6
  return 7
}

function isWorkingState(state: SessionAttentionState) {
  return state === 'working'
}

function workerOverview(
  sessions: Session[],
  handledSessionIds: Set<string>,
  userAttentionBySessionId: Record<string, SessionUserAttention | undefined>
): WorkerOverview {
  const attentionStates = sessions.map((session) => displayAttentionState(session, handledSessionIds, userAttentionBySessionId))
  const runningCount = attentionStates.filter(isWorkingState).length
  const completedCount = attentionStates.filter((state) => state === 'completed').length
  const takeoverCount = attentionStates.filter((state) => state === 'needsReview').length
  return {
    attentionPrompt: takeoverCount > 0 ? `先处理 ${takeoverCount} 个待处理` : undefined,
    allCount: sessions.length,
    takeoverCount,
    runningCount,
    completedCount
  }
}

function isDismissibleStatus(status: Session['status']) {
  return status === 'failed' || status === 'exited' || status === 'stopped'
}

function nextActionText(session: Session, childAttention: ChildAttention): string | undefined {
  if (childAttention.needsReview > 0) return '检查子任务结果'
  if (session.status === 'failed') return '查看异常原因'
  return undefined
}

function evidenceText(session: Session): string | undefined {
  if (session.status === 'failed') return 'Worker 异常'
  if (session.status === 'stopped') return '用户已停止'
  if (session.status === 'exited' && session.exitCode != null && session.exitCode !== 0) return `退出码 ${session.exitCode}`
  return undefined
}

function filterMatchesSession(
  session: Session,
  filter: SessionFilter,
  handledSessionIds: Set<string>,
  userAttentionBySessionId: Record<string, SessionUserAttention | undefined>
) {
  if (filter === 'all') return true
  const attentionState = getSessionAttentionState(session, handledSessionIds, userAttentionBySessionId)
  if (filter === 'active') return attentionState === 'working'
  if (filter === 'attention') return attentionState === 'needsReview'
  return attentionState === 'completed'
}

function groupMatchesFilter(
  group: SessionGroup,
  filter: SessionFilter,
  handledSessionIds: Set<string>,
  userAttentionBySessionId: Record<string, SessionUserAttention | undefined>
) {
  if (filter === 'all') return true
  if (filterMatchesSession(group.session, filter, handledSessionIds, userAttentionBySessionId)) return true
  return group.children.some((child) => filterMatchesSession(child.session, filter, handledSessionIds, userAttentionBySessionId))
}

function buildDisplaySession(session: Session, duplicatedTitles: Set<string>): DisplaySession {
  const displayTitle = getSessionDisplayTitle(session)
  const duplicateHint = duplicatedTitles.has(displayTitle) ? `#${shortSessionId(session.id)} · ${sessionTimeHint(session)}` : undefined
  return {
    session,
    displayTitle,
    duplicateHint,
    meta: sessionMeta(session, duplicateHint)
  }
}

function buildDuplicatedTitles(sessions: Session[]) {
  const counts = new Map<string, number>()
  for (const session of sessions) {
    const title = getSessionDisplayTitle(session)
    counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([title]) => title))
}

function countChildAttention(
  children: Session[],
  handledSessionIds: Set<string>,
  userAttentionBySessionId: Record<string, SessionUserAttention | undefined>
): ChildAttention {
  return children.reduce<ChildAttention>((counts, child) => {
    counts.total += 1
    if (getSessionAttentionState(child, handledSessionIds, userAttentionBySessionId) === 'needsReview') counts.needsReview += 1
    return counts
  }, { total: 0, needsReview: 0 })
}

function sectionForGroup(
  group: SessionGroup,
  handledSessionIds: Set<string>,
  userAttentionBySessionId: Record<string, SessionUserAttention | undefined>
): SessionSection['key'] {
  const attentionState = getSessionAttentionState(group.session, handledSessionIds, userAttentionBySessionId)
  if (group.childAttention.needsReview > 0) return 'attention'
  if (group.session.status === 'exited' || group.session.status === 'stopped') return 'done'
  if (attentionState === 'needsReview') return 'attention'
  if (attentionState === 'completed') return 'done'
  return 'running'
}

function buildSessionSections(
  groups: SessionGroup[],
  handledSessionIds: Set<string>,
  userAttentionBySessionId: Record<string, SessionUserAttention | undefined>
): SessionSection[] {
  const sections: SessionSection[] = [
    { key: 'attention', title: '待处理', groups: [] },
    { key: 'running', title: '进行中', groups: [] },
    { key: 'done', title: '已完成', groups: [] }
  ]
  for (const group of groups) {
    sections.find((section) => section.key === sectionForGroup(group, handledSessionIds, userAttentionBySessionId))?.groups.push(group)
  }
  return sections.filter((section) => section.groups.length > 0)
}

function sortSessionGroups(
  parentSessions: Session[],
  childrenByParentId: Map<string, Session[]>,
  duplicatedTitles: Set<string>,
  handledSessionIds: Set<string>,
  userAttentionBySessionId: Record<string, SessionUserAttention | undefined>
): SessionGroup[] {
  return parentSessions
    .map((session, index) => {
      const children = childrenByParentId.get(session.id) ?? []
      const priority = children.reduce(
        (currentPriority, childSession) => Math.min(currentPriority, statusPriority(childSession.status)),
        statusPriority(session.status)
      )
      return {
        session,
        display: buildDisplaySession(session, duplicatedTitles),
        children: children.map((child) => buildDisplaySession(child, duplicatedTitles)),
        childAttention: countChildAttention(children, handledSessionIds, userAttentionBySessionId),
        index,
        priority
      }
    })
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
}

type SessionSection = {
  key: 'attention' | 'running' | 'done'
  title: string
  groups: SessionGroup[]
}

type SessionRadarProps = {
  sessions: Session[]
  selectedSessionId?: string
  onSelectSession(sessionId: string): void
  onStopSession?(sessionId: string): void
  onCreateSimilarSession?(sessionId: string): void
  onViewSessionSummary?(sessionId: string): void
  handledAttentionSessionIds?: string[]
  userAttentionBySessionId?: Record<string, SessionUserAttention | undefined>
}

export function SessionRadar(props: SessionRadarProps) {
  const [filter, setFilter] = useState<SessionFilter>('all')
  const [dismissedSessionIds, setDismissedSessionIds] = useState<Set<string>>(() => new Set())
  const [isDismissedDrawerOpen, setIsDismissedDrawerOpen] = useState(false)
  const handledSessionIds = useMemo(() => new Set(props.handledAttentionSessionIds ?? []), [props.handledAttentionSessionIds])
  const userAttentionBySessionId = props.userAttentionBySessionId ?? {}
  const visibleSessions = useMemo(
    () => props.sessions.filter((session) => !dismissedSessionIds.has(session.id)),
    [dismissedSessionIds, props.sessions]
  )
  const dismissedSessions = useMemo(
    () => props.sessions.filter((session) => dismissedSessionIds.has(session.id)),
    [dismissedSessionIds, props.sessions]
  )
  const selectedSession = props.sessions.find((session) => session.id === props.selectedSessionId)
  const expandedParentId = selectedSession?.parentSessionId ?? selectedSession?.id
  const overview = workerOverview(visibleSessions, handledSessionIds, userAttentionBySessionId)
  const sessionGroups = useMemo(() => {
    const parentSessions = visibleSessions.filter((session) => !session.parentSessionId)
    const childrenByParentId = new Map<string, Session[]>()
    for (const session of visibleSessions) {
      if (!session.parentSessionId) continue
      const children = childrenByParentId.get(session.parentSessionId) ?? []
      children.push(session)
      childrenByParentId.set(session.parentSessionId, children)
    }
    return sortSessionGroups(parentSessions, childrenByParentId, buildDuplicatedTitles(visibleSessions), handledSessionIds, userAttentionBySessionId)
  }, [handledSessionIds, userAttentionBySessionId, visibleSessions])
  const visibleGroups = sessionGroups.filter((group) => groupMatchesFilter(group, filter, handledSessionIds, userAttentionBySessionId))
  const visibleSections = buildSessionSections(visibleGroups, handledSessionIds, userAttentionBySessionId)
  const filterCounts: Record<SessionFilter, number> = {
    all: overview.allCount,
    active: overview.runningCount,
    attention: overview.takeoverCount,
    done: overview.completedCount
  }
  const dismissSession = (sessionId: string) => {
    setDismissedSessionIds((current) => {
      const next = new Set(current)
      next.add(sessionId)
      return next
    })
  }
  const restoreSession = (sessionId: string) => {
    setDismissedSessionIds((current) => {
      const next = new Set(current)
      next.delete(sessionId)
      return next
    })
  }

  return (
    <section className="panel session-radar">
      <div className="session-radar-header">
        <h2>调度中心</h2>
        {overview.attentionPrompt ? <p className="session-radar-prompt">{overview.attentionPrompt}</p> : null}
        <div className="session-filter-tabs" role="group" aria-label="Session 筛选">
          {filters.map((item) => {
            const count = filterCounts[item.value]
            return (
              <button
                key={item.value}
                type="button"
                className={filter === item.value ? 'session-filter-tab active' : 'session-filter-tab'}
                aria-pressed={filter === item.value}
                aria-label={`${item.label} ${count}`}
                title={`${item.label} ${count}`}
                onClick={() => setFilter(item.value)}
              >
                <span>{item.shortLabel}</span>
                <strong>{count}</strong>
              </button>
            )
          })}
        </div>
      </div>
      {props.sessions.length === 0 ? (
        <div className="session-radar-empty">
          <strong>暂无运行任务</strong>
          <span>启动一个 Claude Code Session 后，它会出现在这里。</span>
        </div>
      ) : null}
      {props.sessions.length > 0 && visibleSessions.length === 0 ? (
        <div className="session-radar-empty">
          <strong>现场已收起</strong>
          <span>异常或完成记录没有删除，仍可在历史里查看。</span>
        </div>
      ) : null}
      {visibleSessions.length > 0 && visibleGroups.length === 0 ? (
        <div className="session-radar-empty">
          <strong>当前筛选无结果</strong>
          <span>切回“全部”查看所有 Session。</span>
        </div>
      ) : null}
      <div className="session-list">
        {visibleSections.map((section) => (
          <section className="session-section" aria-labelledby={`session-section-${section.key}`} key={section.key}>
            <h3 className="session-section-title" id={`session-section-${section.key}`}>{section.title}</h3>
            {section.groups.map((group) => {
              const childSessions = expandedParentId === group.session.id ? group.children : []
              return (
                <div className="session-group" key={group.session.id}>
                  <SessionCard
                    display={group.display}
                    childAttention={group.childAttention}
                    selected={group.session.id === props.selectedSessionId}
                    expanded={group.session.id === expandedParentId}
                    level="parent"
                    attentionState={displayAttentionState(group.session, handledSessionIds, userAttentionBySessionId)}
                    onSelectSession={props.onSelectSession}
                    onStopSession={props.onStopSession}
                    onCreateSimilarSession={props.onCreateSimilarSession}
                    onViewSessionSummary={props.onViewSessionSummary}
                    onDismissSession={dismissSession}
                  />
                  {childSessions.length > 0 ? (
                    <div className="session-children">
                      {childSessions.map((childSession) => (
                        <SessionCard
                          key={childSession.session.id}
                          display={childSession}
                          childAttention={{ total: 0, needsReview: 0 }}
                          selected={childSession.session.id === props.selectedSessionId}
                          expanded={childSession.session.id === props.selectedSessionId}
                          level="child"
                          attentionState={displayAttentionState(childSession.session, handledSessionIds, userAttentionBySessionId)}
                          onSelectSession={props.onSelectSession}
                          onStopSession={props.onStopSession}
                          onCreateSimilarSession={props.onCreateSimilarSession}
                          onViewSessionSummary={props.onViewSessionSummary}
                          onDismissSession={dismissSession}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </section>
        ))}
      </div>
      {filter === 'all' && dismissedSessions.length > 0 ? (
        <div className="session-dismissed-drawer">
          <button
            type="button"
            className="session-dismissed-toggle"
            aria-expanded={isDismissedDrawerOpen}
            onClick={() => setIsDismissedDrawerOpen((open) => !open)}
          >
            查看已收起 {dismissedSessions.length} 个
          </button>
          {isDismissedDrawerOpen ? (
            <div className="session-dismissed-list">
              <strong>已收起 Session</strong>
              {dismissedSessions.map((session) => {
                const display = buildDisplaySession(session, new Set())
                return (
                  <div className="session-dismissed-item" key={session.id}>
                    <span className="session-dismissed-main">
                      <span>{display.displayTitle}</span>
                      <span>{statusLabel(session.status)}</span>
                    </span>
                    {display.meta ? <span className="session-dismissed-meta">{display.meta}</span> : null}
                    <span className="session-dismissed-actions">
                      <button
                        type="button"
                        className="session-card-action session-card-action-primary"
                        onClick={() => props.onSelectSession(session.id)}
                      >
                        查看 {display.displayTitle}
                      </button>
                      <button
                        type="button"
                        className="session-card-action"
                        onClick={() => restoreSession(session.id)}
                      >
                        恢复 {display.displayTitle} 到现场
                      </button>
                    </span>
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

type SessionCardProps = {
  display: DisplaySession
  childAttention: ChildAttention
  selected: boolean
  expanded: boolean
  level: 'parent' | 'child'
  attentionState: SessionAttentionState
  onSelectSession(sessionId: string): void
  onStopSession?(sessionId: string): void
  onCreateSimilarSession?(sessionId: string): void
  onViewSessionSummary?(sessionId: string): void
  onDismissSession?(sessionId: string): void
}

function SessionCard(props: SessionCardProps) {
  const session = props.display.session
  const tag = workerTag(session.workerType)
  const className = ['session-card', `session-card-${props.level}`, `status-${session.status}`]
  const canStop = session.status === 'starting' || session.status === 'running' || session.status === 'waiting'
  const canTakeOver = session.status === 'waiting'
  const canView = session.status === 'failed' || session.status === 'stopped' || session.status === 'exited'
  const canDismiss = isDismissibleStatus(session.status)
  if (props.selected) className.push('selected')
  if (props.expanded) className.push('expanded')
  const nextAction = nextActionText(session, props.childAttention)
  const evidence = evidenceText(session)
  const attentionState = props.childAttention.needsReview > 0 ? 'needsReview' : props.attentionState
  const badgeLabel = attentionLabel(attentionState)
  className.push(attentionClassName(attentionState))
  const summaryVisible = Boolean(nextAction || evidence)

  const handleAction = (event: MouseEvent<HTMLButtonElement>, action: (() => void) | undefined) => {
    event.stopPropagation()
    action?.()
  }

  return (
    <div className={className.join(' ')}>
      <button
        type="button"
        className="session-card-main"
        aria-current={props.selected ? 'true' : undefined}
        onClick={() => props.onSelectSession(session.id)}
      >
        <span className="session-main-row">
          <span className={`session-worker-tag ${tag.className}`}>{tag.label}</span>
          <span className="session-title">{props.display.displayTitle}</span>
          <span className={`session-status-badge status-${session.status} ${attentionClassName(attentionState)}`} aria-label={badgeLabel} title={statusLabel(session.status)}>
            <span className="session-status-dot" aria-hidden="true" />
            <span className="session-status-text">{badgeLabel}</span>
          </span>
        </span>
        {props.display.meta ? <span className="session-meta-line">{props.display.meta}</span> : null}
        {summaryVisible ? (
          <span className="session-card-summary">
            {nextAction ? <span className="session-next-action-line">{nextAction}</span> : null}
            {evidence ? <span className="session-evidence-line">{evidence}</span> : null}
          </span>
        ) : null}
        {props.childAttention.total > 0 ? (
          <span className="session-child-alerts">
            <span>子任务 <b>{props.childAttention.total}</b></span>
            {props.childAttention.needsReview > 0 ? <span>待处理 {props.childAttention.needsReview}</span> : null}
          </span>
        ) : null}
        {props.expanded && session.status === 'failed' && session.errorMessage ? (
          <span className="session-error-line">{session.errorMessage}</span>
        ) : null}
      </button>
      <span className="session-card-actions">
        {canTakeOver ? (
          <button
            type="button"
            className="session-card-action session-card-action-primary"
            onClick={(event) => handleAction(event, () => props.onSelectSession(session.id))}
          >
            继续
          </button>
        ) : null}
        {canView ? (
          <button
            type="button"
            className="session-card-action session-card-action-primary"
            onClick={(event) => handleAction(event, () => props.onSelectSession(session.id))}
          >
            {session.status === 'failed' ? '查看原因' : '查看输出'}
          </button>
        ) : null}
        {canDismiss ? (
          <button
            type="button"
            className="session-card-action"
            onClick={(event) => handleAction(event, () => props.onDismissSession?.(session.id))}
          >
            收起
          </button>
        ) : null}
        {canStop && props.onStopSession ? (
          <button
            type="button"
            className="session-card-action"
            onClick={(event) => handleAction(event, () => props.onStopSession?.(session.id))}
          >
            停止
          </button>
        ) : null}
        {props.onCreateSimilarSession ? (
          <button
            type="button"
            className="session-card-action"
            onClick={(event) => handleAction(event, () => props.onCreateSimilarSession?.(session.id))}
          >
            再开同类
          </button>
        ) : null}
        {props.onViewSessionSummary ? (
          <button
            type="button"
            className="session-card-action"
            onClick={(event) => handleAction(event, () => props.onViewSessionSummary?.(session.id))}
          >
            摘要
          </button>
        ) : null}
      </span>
    </div>
  )
}
