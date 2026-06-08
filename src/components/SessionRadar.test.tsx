import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../types/workerDesk'
import { SessionRadar } from './SessionRadar'

const session: Session = {
  id: 's1abcdef',
  projectId: 'p1',
  workerType: 'claude-code',
  interactionMode: 'pty',
  status: 'running',
  title: 'Project / Sonnet',
  createdAt: '2026-05-09T00:00:00.000Z',
  lastActivityAt: '2026-05-09T00:00:01.000Z',
  outputRef: 'memory:s1',
  providerName: 'Longcat',
  modelDisplayName: 'Sonnet'
}

function sessionButton(title: string) {
  return screen.getByRole('button', { name: new RegExp(title) })
}

function filterButton(name: RegExp | string) {
  return within(screen.getByRole('group', { name: 'Session 筛选' })).getByRole('button', { name })
}

function sessionButtons() {
  return screen.getAllByRole('button').filter((button) => button.classList.contains('session-card-main'))
}

describe('SessionRadar', () => {
  it('renders the worker floor overview without repeating running status inside quiet cards', () => {
    const onSelect = vi.fn()
    render(<SessionRadar sessions={[session]} selectedSessionId={undefined} onSelectSession={onSelect} />)

    expect(screen.queryByText('当前可放手观察')).not.toBeInTheDocument()
    expect(screen.queryByText('进行中：1 个')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Session 筛选' })).toBeInTheDocument()
    const card = screen.getByText('Project / Sonnet').closest('.session-card')
    expect(card).not.toBeNull()
    expect(within(card as HTMLElement).getByLabelText('进行中')).toHaveClass('session-status-badge')
    expect(within(card as HTMLElement).queryByText('运行中')).not.toBeInTheDocument()
    expect(within(card as HTMLElement).queryByText('继续观察')).not.toBeInTheDocument()
    expect(within(card as HTMLElement).queryByText('进程运行中')).not.toBeInTheDocument()
    fireEvent.click(sessionButton('Project / Sonnet'))
    expect(onSelect).toHaveBeenCalledWith('s1abcdef')
  })

  it('keeps the worker floor free of decorative supervisor scoring', () => {
    render(<SessionRadar sessions={[session]} selectedSessionId={undefined} onSelectSession={vi.fn()} />)

    expect(screen.queryByText(/中栏把关/)).not.toBeInTheDocument()
    expect(screen.queryByText(/低噪音 90/)).not.toBeInTheDocument()
  })

  it('uses Claude hook attention to move a running session into needs review', () => {
    render(
      <SessionRadar
        sessions={[session]}
        userAttentionBySessionId={{ s1abcdef: 'needsReview' }}
        selectedSessionId={undefined}
        onSelectSession={vi.fn()}
      />
    )

    expect(screen.queryByText('需要处理：1 个')).not.toBeInTheDocument()
    expect(screen.queryByText('进行中：0 个')).not.toBeInTheDocument()

    fireEvent.click(filterButton(/待处理/))
    const card = screen.getByText('Project / Sonnet').closest('.session-card')
    expect(card).not.toBeNull()
    expect(within(card as HTMLElement).getByLabelText('待处理')).toHaveClass('session-status-badge')
  })

  it('keeps a running session in running while Claude hook attention is working', () => {
    render(
      <SessionRadar
        sessions={[session]}
        userAttentionBySessionId={{ s1abcdef: 'working' }}
        selectedSessionId={undefined}
        onSelectSession={vi.fn()}
      />
    )

    expect(screen.queryByText('当前可放手观察')).not.toBeInTheDocument()
    expect(screen.queryByText('进行中：1 个')).not.toBeInTheDocument()

    fireEvent.click(filterButton(/待处理/))
    expect(screen.queryByText('Project / Sonnet')).not.toBeInTheDocument()
  })

  it('lets a new Claude needs-review hook override a previously handled running session', () => {
    render(
      <SessionRadar
        sessions={[session]}
        handledAttentionSessionIds={['s1abcdef']}
        userAttentionBySessionId={{ s1abcdef: 'needsReview' }}
        selectedSessionId={undefined}
        onSelectSession={vi.fn()}
      />
    )

    expect(screen.queryByText('需要处理：1 个')).not.toBeInTheDocument()
  })

  it('uses task title without repeating provider and model metadata by default', () => {
    render(<SessionRadar sessions={[{ ...session, taskTitle: '修复中栏状态展示' }]} selectedSessionId={undefined} onSelectSession={vi.fn()} />)

    expect(screen.getByText('C')).toHaveClass('session-worker-tag-claude')
    expect(screen.getByText('修复中栏状态展示')).toBeInTheDocument()
    expect(screen.queryByText('Longcat · Sonnet')).not.toBeInTheDocument()
  })

  it('uses GenericAgent dispatch task as the child session title', () => {
    const genericSession: Session = {
      ...session,
      id: 'ga-child',
      workerType: 'generic-agent',
      title: 'Project / Longcat / GenericAgent Local',
      dispatchMode: 'auto',
      dispatchTask: '检查 SessionRadar 的筛选交互',
      parentSessionId: 'parent'
    }
    const parent: Session = { ...session, id: 'parent', title: 'Parent task' }
    render(<SessionRadar sessions={[parent, genericSession]} selectedSessionId="parent" onSelectSession={vi.fn()} />)

    expect(screen.getByText('检查 SessionRadar 的筛选交互')).toBeInTheDocument()
    expect(screen.getByText('自动分派')).toBeInTheDocument()
    expect(screen.queryByText('Longcat · Sonnet · 自动分派')).not.toBeInTheDocument()
  })

  it('shows urgent overview when a worker needs attention', () => {
    const waitingSession: Session = { ...session, id: 's2', status: 'waiting', title: 'Project B' }
    const failedSession: Session = { ...session, id: 's3', status: 'failed', title: 'Project C' }
    const exitedSession: Session = { ...session, id: 's4', status: 'exited', title: 'Project D' }
    render(<SessionRadar sessions={[session, waitingSession, failedSession, exitedSession]} selectedSessionId={undefined} onSelectSession={vi.fn()} />)

    expect(screen.queryByText('需要处理：3 个')).not.toBeInTheDocument()
    expect(screen.queryByText('进行中：1 个')).not.toBeInTheDocument()
  })

  it('treats waiting sessions as takeover attention instead of background work', () => {
    const waitingSession: Session = { ...session, id: 'waiting', title: 'Waiting task', status: 'waiting' }
    const runningSession: Session = { ...session, id: 'running', title: 'Running task', status: 'running' }

    render(<SessionRadar sessions={[waitingSession, runningSession]} selectedSessionId={undefined} onSelectSession={vi.fn()} />)

    expect(screen.queryByText('需要处理：1 个')).not.toBeInTheDocument()
    expect(screen.queryByText('进行中：1 个')).not.toBeInTheDocument()

    const attentionSection = screen.getByRole('region', { name: '待处理' })
    const workingSection = screen.getByRole('region', { name: '进行中' })
    expect(within(attentionSection).getByText('Waiting task')).toBeInTheDocument()
    expect(within(workingSection).getByText('Running task')).toBeInTheDocument()
  })

  it('shows user-stopped sessions as stopped with output review action', () => {
    const stoppedSession: Session = { ...session, id: 'stopped', title: 'Stopped task', status: 'stopped' }
    const onSelect = vi.fn()

    render(<SessionRadar sessions={[stoppedSession]} selectedSessionId={undefined} onSelectSession={onSelect} />)

    const stoppedCard = screen.getByText('Stopped task').closest('.session-card')
    expect(stoppedCard).not.toBeNull()
    expect(within(stoppedCard as HTMLElement).getByLabelText('已完成')).toHaveClass('session-status-badge')
    expect(within(stoppedCard as HTMLElement).queryByText('已停止')).not.toBeInTheDocument()
    expect(within(stoppedCard as HTMLElement).queryByText('查看已产生输出')).not.toBeInTheDocument()
    fireEvent.click(within(stoppedCard as HTMLElement).getByRole('button', { name: '查看输出' }))
    expect(onSelect).toHaveBeenCalledWith('stopped')
    expect(screen.getByRole('button', { name: '收起' })).toBeInTheDocument()
  })

  it('shows provider and model fallback as the second line', () => {
    const missingMetaSession: Session = {
      ...session,
      providerName: undefined,
      modelDisplayName: undefined,
      modelId: undefined
    }
    render(<SessionRadar sessions={[missingMetaSession]} selectedSessionId="s1abcdef" onSelectSession={vi.fn()} />)

    expect(screen.getByText('未知 Provider · 未知 Model')).toBeInTheDocument()
    expect(screen.queryByText('Longcat · Sonnet')).not.toBeInTheDocument()
  })

  it('sorts sessions by attention status while preserving same-priority order', () => {
    const runningSession: Session = { ...session, id: 'running', title: 'Running task', status: 'running' }
    const exitedSession: Session = { ...session, id: 'exited', title: 'Exited task', status: 'exited' }
    const failedSession: Session = { ...session, id: 'failed', title: 'Failed task', status: 'failed' }
    const waitingSession: Session = { ...session, id: 'waiting', title: 'Waiting task', status: 'waiting' }

    render(
      <SessionRadar
        sessions={[runningSession, exitedSession, failedSession, waitingSession]}
        selectedSessionId={undefined}
        onSelectSession={vi.fn()}
      />
    )

    const buttons = sessionButtons()
    expect(within(buttons[0]).getByText('Waiting task')).toBeInTheDocument()
    expect(within(buttons[1]).getByText('Failed task')).toBeInTheDocument()
    expect(within(buttons[2]).getByText('Running task')).toBeInTheDocument()
    expect(within(buttons[3]).getByText('Exited task')).toBeInTheDocument()
  })

  it('groups sessions into attention, running, and done sections by default', () => {
    const waitingSession: Session = { ...session, id: 'waiting', title: 'Waiting task', status: 'waiting' }
    const failedSession: Session = { ...session, id: 'failed', title: 'Failed task', status: 'failed' }
    const startingSession: Session = { ...session, id: 'starting', title: 'Starting task', status: 'starting' }
    const runningSession: Session = { ...session, id: 'running', title: 'Running task', status: 'running' }
    const exitedSession: Session = { ...session, id: 'exited', title: 'Exited task', status: 'exited' }

    render(
      <SessionRadar
        sessions={[runningSession, exitedSession, failedSession, waitingSession, startingSession]}
        selectedSessionId={undefined}
        onSelectSession={vi.fn()}
      />
    )

    const sectionTitles = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    expect(sectionTitles).toEqual(['待处理', '进行中', '已完成'])

    const attentionSection = screen.getByRole('region', { name: '待处理' })
    const workingSection = screen.getByRole('region', { name: '进行中' })
    const doneSection = screen.getByRole('region', { name: '已完成' })

    expect(within(attentionSection).getByText('Waiting task')).toBeInTheDocument()
    expect(within(attentionSection).getByText('Failed task')).toBeInTheDocument()
    expect(within(workingSection).getByText('Starting task')).toBeInTheDocument()
    expect(within(workingSection).getByText('Running task')).toBeInTheDocument()
    expect(within(doneSection).getByText('Exited task')).toBeInTheDocument()
  })

  it('moves handled sessions from attention to done without changing their technical status', () => {
    const exitedSession: Session = { ...session, id: 'exited', title: 'Exited task', status: 'exited' }

    render(
      <SessionRadar
        sessions={[exitedSession]}
        handledAttentionSessionIds={['exited']}
        selectedSessionId={undefined}
        onSelectSession={vi.fn()}
      />
    )

    expect(screen.queryByText('当前可放手观察')).not.toBeInTheDocument()

    fireEvent.click(filterButton(/待处理/))
    expect(screen.queryByText('Exited task')).not.toBeInTheDocument()

    fireEvent.click(filterButton(/已完成/))
    const exitedCard = screen.getByText('Exited task').closest('.session-card')
    expect(exitedCard).not.toBeNull()
    expect(within(exitedCard as HTMLElement).getByLabelText('已完成')).toHaveClass('session-status-badge')
  })

  it('puts mission counts directly on the filter tabs without a duplicate count strip', () => {
    const waitingSession: Session = { ...session, id: 'waiting', title: 'Waiting task', status: 'waiting' }
    const failedSession: Session = { ...session, id: 'failed', title: 'Failed task', status: 'failed', errorMessage: 'exit 1' }
    const runningSession: Session = { ...session, id: 'running', title: 'Running task', status: 'running' }
    const exitedSession: Session = { ...session, id: 'exited', title: 'Exited task', status: 'exited' }

    render(
      <SessionRadar
        sessions={[runningSession, waitingSession, failedSession, exitedSession]}
        selectedSessionId={undefined}
        onSelectSession={vi.fn()}
      />
    )

    expect(screen.queryByLabelText('现场计数')).not.toBeInTheDocument()
    expect(screen.getByText('先处理 2 个待处理')).toBeInTheDocument()
    expect(screen.queryByText('先处理 2 个待处理的现场')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '全部 4' })).toHaveTextContent('全4')
    expect(screen.getByRole('button', { name: '待处理 2' })).toHaveTextContent('待2')
    expect(screen.getByRole('button', { name: '进行中 1' })).toHaveTextContent('进1')
    expect(screen.getByRole('button', { name: '已完成 1' })).toHaveTextContent('完1')
    expect(screen.queryByText(/健康分|评分|AI 推荐指数/)).not.toBeInTheDocument()
  })

  it('renders compact intervention evidence only for attention-first session cards', () => {
    const waitingSession: Session = { ...session, id: 'waiting', title: 'Waiting task', status: 'waiting' }
    const failedSession: Session = { ...session, id: 'failed', title: 'Failed task', status: 'failed', errorMessage: 'exit 1' }

    render(<SessionRadar sessions={[waitingSession, failedSession]} selectedSessionId="failed" onSelectSession={vi.fn()} />)

    const failedCard = screen.getByText('Failed task').closest('.session-card')
    const waitingCard = screen.getByText('Waiting task').closest('.session-card')
    expect(failedCard).not.toBeNull()
    expect(waitingCard).not.toBeNull()
    expect(within(failedCard as HTMLElement).getByLabelText('待处理')).toHaveClass('session-status-badge')
    expect(within(failedCard as HTMLElement).getByText('查看异常原因')).toHaveClass('session-next-action-line')
    expect(within(failedCard as HTMLElement).getByText('Worker 异常')).toHaveClass('session-evidence-line')
    expect(within(failedCard as HTMLElement).queryByText('异常')).not.toBeInTheDocument()
    expect(within(failedCard as HTMLElement).queryByText('证据')).not.toBeInTheDocument()
    expect(within(failedCard as HTMLElement).queryByText('下一步')).not.toBeInTheDocument()
    expect(within(waitingCard as HTMLElement).getByLabelText('待处理')).toHaveClass('session-status-badge')
    expect(within(waitingCard as HTMLElement).queryByText('输入继续')).not.toBeInTheDocument()
    expect(within(waitingCard as HTMLElement).queryByText('等待中')).not.toBeInTheDocument()
    expect(within(waitingCard as HTMLElement).queryByText('等待用户输入')).not.toBeInTheDocument()
  })

  it('promotes parent groups with child attention into the attention section', () => {
    const parent: Session = { ...session, id: 'parent', title: 'Parent task', status: 'running' }
    const runningSibling: Session = { ...session, id: 'sibling', title: 'Sibling task', status: 'running' }
    const failedChild: Session = {
      ...session,
      id: 'child-failed',
      title: 'Child failed',
      status: 'failed',
      parentSessionId: 'parent',
      workerType: 'generic-agent'
    }

    render(<SessionRadar sessions={[runningSibling, parent, failedChild]} selectedSessionId={undefined} onSelectSession={vi.fn()} />)

    const attentionSection = screen.getByRole('region', { name: '待处理' })
    const workingSection = screen.getByRole('region', { name: '进行中' })
    expect(within(attentionSection).getByText('Parent task')).toBeInTheDocument()
    expect(within(attentionSection).getByText('待处理 1')).toBeInTheDocument()
    expect(within(workingSection).queryByText('Parent task')).not.toBeInTheDocument()
    expect(within(workingSection).getByText('Sibling task')).toBeInTheDocument()
  })

  it('renders child worker counts as lightweight lineage evidence instead of a node graph', () => {
    const parent: Session = { ...session, id: 'parent', title: 'Parent task', status: 'running' }
    const runningChild: Session = { ...session, id: 'child-running', title: 'Child running', status: 'running', parentSessionId: 'parent', workerType: 'generic-agent' }
    const failedChild: Session = { ...session, id: 'child-failed', title: 'Child failed', status: 'failed', parentSessionId: 'parent', workerType: 'generic-agent' }

    render(<SessionRadar sessions={[parent, runningChild, failedChild]} selectedSessionId="parent" onSelectSession={vi.fn()} />)

    const parentCard = screen.getByText('Parent task').closest('.session-card')
    expect(parentCard).not.toBeNull()
    expect(within(parentCard as HTMLElement).getByText('子任务')).toBeInTheDocument()
    expect(within(parentCard as HTMLElement).getByText('2')).toBeInTheDocument()
    expect(within(parentCard as HTMLElement).getByText('待处理 1')).toBeInTheDocument()
    expect(screen.queryByText(/节点图|DAG|工作流/)).not.toBeInTheDocument()
  })

  it('shows actionable failure evidence only when present and selected', () => {
    const failedSession: Session = {
      ...session,
      id: 'failed',
      title: 'Failed task',
      status: 'failed',
      errorMessage: 'GenericAgent exited with code 1'
    }

    const { rerender } = render(<SessionRadar sessions={[failedSession]} selectedSessionId={undefined} onSelectSession={vi.fn()} />)

    expect(screen.queryByText('GenericAgent exited with code 1')).not.toBeInTheDocument()

    rerender(<SessionRadar sessions={[failedSession]} selectedSessionId="failed" onSelectSession={vi.fn()} />)

    expect(screen.getByText('GenericAgent exited with code 1')).toBeInTheDocument()
  })

  it('shows parent sessions by default and expands children for the selected parent', () => {
    const parent: Session = { ...session, id: 'parent', title: 'Parent task' }
    const sibling: Session = { ...session, id: 'sibling', title: 'Sibling task' }
    const child: Session = {
      ...session,
      id: 'child',
      workerType: 'generic-agent',
      title: 'Child task',
      parentSessionId: 'parent'
    }

    render(<SessionRadar sessions={[parent, child, sibling]} selectedSessionId="parent" onSelectSession={vi.fn()} />)

    const buttons = sessionButtons()
    expect(within(buttons[0]).getByText('Parent task')).toBeInTheDocument()
    expect(within(buttons[1]).getByText('Child task')).toBeInTheDocument()
    expect(within(buttons[2]).getByText('Sibling task')).toBeInTheDocument()
    expect(screen.getByText('G')).toHaveClass('session-worker-tag-generic')
  })

  it('keeps the parent lineage expanded when a child is selected', () => {
    const parent: Session = { ...session, id: 'parent', title: 'Parent task' }
    const child: Session = {
      ...session,
      id: 'child',
      workerType: 'generic-agent',
      title: 'Child task',
      parentSessionId: 'parent'
    }
    const hiddenChild: Session = {
      ...session,
      id: 'hidden-child',
      workerType: 'generic-agent',
      title: 'Hidden child task',
      parentSessionId: 'other-parent'
    }

    render(<SessionRadar sessions={[parent, child, hiddenChild]} selectedSessionId="child" onSelectSession={vi.fn()} />)

    expect(screen.getByText('Parent task')).toBeInTheDocument()
    expect(screen.getByText('Child task')).toBeInTheDocument()
    expect(screen.queryByText('Hidden child task')).not.toBeInTheDocument()
  })

  it('promotes a parent group for unhandled completed child work and clears it after handling', () => {
    const quietParent: Session = { ...session, id: 'quiet-parent', title: 'Quiet parent', status: 'running' }
    const urgentParent: Session = { ...session, id: 'urgent-parent', title: 'Urgent parent', status: 'running' }
    const exitedChild: Session = {
      ...session,
      id: 'exited-child',
      title: 'Exited child',
      status: 'exited',
      parentSessionId: 'urgent-parent'
    }

    const { rerender } = render(
      <SessionRadar
        sessions={[quietParent, urgentParent, exitedChild]}
        selectedSessionId="urgent-parent"
        onSelectSession={vi.fn()}
      />
    )

    const buttons = sessionButtons()
    expect(within(buttons[0]).getByText('Urgent parent')).toBeInTheDocument()
    expect(within(buttons[0]).getByText('待处理 1')).toBeInTheDocument()
    expect(within(buttons[1]).getByText('Exited child')).toBeInTheDocument()
    expect(within(buttons[2]).getByText('Quiet parent')).toBeInTheDocument()

    rerender(
      <SessionRadar
        sessions={[quietParent, urgentParent, exitedChild]}
        handledAttentionSessionIds={['exited-child']}
        selectedSessionId="urgent-parent"
        onSelectSession={vi.fn()}
      />
    )

    const urgentCard = screen.getByText('Urgent parent').closest('.session-card')
    expect(urgentCard).not.toBeNull()
    expect(within(urgentCard as HTMLElement).queryByText('待处理 1')).not.toBeInTheDocument()
    expect(screen.getByText('Quiet parent')).toBeInTheDocument()
    expect(screen.getByText('Exited child')).toBeInTheDocument()
  })

  it('filters session groups without breaking parent and child context', () => {
    const runningParent: Session = { ...session, id: 'running-parent', title: 'Running parent', status: 'running' }
    const handledParent: Session = { ...session, id: 'handled-parent', title: 'Handled parent', status: 'exited' }
    const waitingParent: Session = { ...session, id: 'waiting-parent', title: 'Waiting parent', status: 'running' }
    const waitingChild: Session = { ...session, id: 'waiting-child', title: 'Waiting child', status: 'waiting', parentSessionId: 'waiting-parent' }

    render(
      <SessionRadar
        sessions={[runningParent, handledParent, waitingParent, waitingChild]}
        handledAttentionSessionIds={['handled-parent']}
        selectedSessionId="waiting-parent"
        onSelectSession={vi.fn()}
      />
    )

    fireEvent.click(filterButton(/进行中/))
    expect(screen.getByText('Waiting parent')).toBeInTheDocument()
    expect(screen.getByText('Waiting child')).toBeInTheDocument()
    expect(screen.getByText('Running parent')).toBeInTheDocument()
    expect(screen.queryByText('Handled parent')).not.toBeInTheDocument()

    fireEvent.click(filterButton(/已完成/))
    expect(screen.getByText('Handled parent')).toBeInTheDocument()
    expect(screen.queryByText('Waiting parent')).not.toBeInTheDocument()
  })

  it('shows a filtered empty state', () => {
    render(<SessionRadar sessions={[session]} selectedSessionId={undefined} onSelectSession={vi.fn()} />)

    fireEvent.click(filterButton(/已完成/))

    expect(screen.getByText('当前筛选无结果')).toBeInTheDocument()
  })

  it('marks exited sessions with a low emphasis status class', () => {
    const exitedSession: Session = { ...session, id: 'exited', title: 'Exited task', status: 'exited' }
    render(<SessionRadar sessions={[exitedSession]} selectedSessionId={undefined} onSelectSession={vi.fn()} />)

    expect(screen.getByText('Exited task').closest('.session-card')).toHaveClass('status-exited')
  })

  it('adds a short hint when display titles are duplicated', () => {
    const first: Session = { ...session, id: 'first-session', title: 'Same title', createdAt: '2026-05-09T08:30:00.000Z' }
    const second: Session = { ...session, id: 'second-session', title: 'Same title', createdAt: '2026-05-09T09:45:00.000Z' }

    render(<SessionRadar sessions={[first, second]} selectedSessionId={undefined} onSelectSession={vi.fn()} />)

    expect(screen.getByText(/#first-/)).toBeInTheDocument()
    expect(screen.getByText(/#second/)).toBeInTheDocument()
    expect(screen.queryByText(/Longcat · Sonnet · #first-/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Longcat · Sonnet · #second/)).not.toBeInTheDocument()
  })

  it('keeps action buttons from selecting the card', () => {
    const onSelect = vi.fn()
    const onStop = vi.fn()
    const onCreateSimilar = vi.fn()
    const onViewSummary = vi.fn()
    render(
      <SessionRadar
        sessions={[session]}
        selectedSessionId={undefined}
        onSelectSession={onSelect}
        onStopSession={onStop}
        onCreateSimilarSession={onCreateSimilar}
        onViewSessionSummary={onViewSummary}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(onStop).toHaveBeenCalledWith('s1abcdef')
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '再开同类' }))
    expect(onCreateSimilar).toHaveBeenCalledWith('s1abcdef')

    fireEvent.click(screen.getByRole('button', { name: '摘要' }))
    expect(onViewSummary).toHaveBeenCalledWith('s1abcdef')
  })

  it('shows a dismissed session drawer for viewing or restoring folded sessions', () => {
    const onSelect = vi.fn()
    const failedSession: Session = { ...session, id: 'failed', title: 'Failed task', status: 'failed' }
    const exitedSession: Session = { ...session, id: 'exited', title: 'Exited task', status: 'exited' }
    render(<SessionRadar sessions={[failedSession, exitedSession]} selectedSessionId={undefined} onSelectSession={onSelect} />)

    const failedCard = screen.getByText('Failed task').closest('.session-card')
    expect(failedCard).not.toBeNull()
    fireEvent.click(within(failedCard as HTMLElement).getByRole('button', { name: '收起' }))
    fireEvent.click(screen.getByRole('button', { name: '查看已收起 1 个' }))

    expect(screen.getByText('已收起 Session')).toBeInTheDocument()
    const dismissedList = screen.getByText('已收起 Session').closest('.session-dismissed-list')
    expect(dismissedList).not.toBeNull()
    expect(within(dismissedList as HTMLElement).getByText('Failed task')).toBeInTheDocument()
    expect(within(dismissedList as HTMLElement).getByText('异常')).toBeInTheDocument()
    expect(within(dismissedList as HTMLElement).getAllByText('异常')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '查看 Failed task' }))
    expect(onSelect).toHaveBeenCalledWith('failed')

    fireEvent.click(screen.getByRole('button', { name: '恢复 Failed task 到现场' }))
    expect(screen.queryByRole('button', { name: '查看已收起 1 个' })).not.toBeInTheDocument()
    expect(screen.getByText('Failed task')).toBeInTheDocument()
  })

  it('shows dismissed drawer only in the all filter', () => {
    const failedSession: Session = { ...session, id: 'failed', title: 'Failed task', status: 'failed' }
    render(<SessionRadar sessions={[failedSession]} selectedSessionId={undefined} onSelectSession={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.getByRole('button', { name: '查看已收起 1 个' })).toBeInTheDocument()

    fireEvent.click(filterButton(/待处理/))
    expect(screen.queryByRole('button', { name: '查看已收起 1 个' })).not.toBeInTheDocument()

    fireEvent.click(filterButton(/全部/))
    expect(screen.getByRole('button', { name: '查看已收起 1 个' })).toBeInTheDocument()
  })

  it('shows a dismissed empty state when all visible sessions are folded away', () => {
    const failedSession: Session = { ...session, id: 'failed', title: 'Failed task', status: 'failed' }
    render(<SessionRadar sessions={[failedSession]} selectedSessionId={undefined} onSelectSession={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '收起' }))

    expect(screen.getByText('现场已收起')).toBeInTheDocument()
    expect(screen.getByText('异常或完成记录没有删除，仍可在历史里查看。')).toBeInTheDocument()
    expect(screen.queryByText('暂无 worker')).not.toBeInTheDocument()
  })

  it('shows continue action only for waiting sessions and view action for failed sessions', () => {
    const onSelect = vi.fn()
    const waitingSession: Session = { ...session, id: 'waiting', status: 'waiting', title: 'Waiting task' }
    const failedSession: Session = { ...session, id: 'failed', status: 'failed', title: 'Failed task' }
    render(<SessionRadar sessions={[waitingSession, failedSession]} selectedSessionId={undefined} onSelectSession={onSelect} />)

    const waitingCard = screen.getByText('Waiting task').closest('.session-card')
    const failedCard = screen.getByText('Failed task').closest('.session-card')
    expect(waitingCard).not.toBeNull()
    expect(failedCard).not.toBeNull()

    expect(within(waitingCard as HTMLElement).queryByText('输入继续')).not.toBeInTheDocument()
    fireEvent.click(within(waitingCard as HTMLElement).getByRole('button', { name: '继续' }))
    fireEvent.click(within(failedCard as HTMLElement).getByRole('button', { name: '查看原因' }))

    expect(onSelect).toHaveBeenNthCalledWith(1, 'waiting')
    expect(onSelect).toHaveBeenNthCalledWith(2, 'failed')
    expect(within(failedCard as HTMLElement).queryByRole('button', { name: '继续' })).not.toBeInTheDocument()
    expect(within(failedCard as HTMLElement).queryByRole('button', { name: '输入' })).not.toBeInTheDocument()
  })

  it('surfaces intervention actions without repeating quiet technical status details', () => {
    const waitingSession: Session = { ...session, id: 'waiting', status: 'waiting', title: 'Waiting for approval' }
    const failedSession: Session = { ...session, id: 'failed', status: 'failed', title: 'Broken worker', errorMessage: 'exit 1' }
    render(<SessionRadar sessions={[session, waitingSession, failedSession]} selectedSessionId={undefined} onSelectSession={vi.fn()} />)

    expect(screen.getByText('先处理 2 个待处理')).toBeInTheDocument()
    expect(screen.queryByText('先处理 2 个待处理的现场')).not.toBeInTheDocument()
    expect(screen.queryByText('输入继续')).not.toBeInTheDocument()
    expect(screen.getByText('查看异常原因')).toHaveClass('session-next-action-line')
    expect(screen.queryByText('继续观察')).not.toBeInTheDocument()
    expect(screen.queryByText('进程进行中')).not.toBeInTheDocument()
  })

  it('summarizes child worker attention on the parent card', () => {
    const parent: Session = { ...session, id: 'parent', title: 'Parent task', status: 'running' }
    const failedChild: Session = { ...session, id: 'child-1', title: 'Child failed', status: 'failed', parentSessionId: 'parent', workerType: 'generic-agent' }
    const exitedChild: Session = { ...session, id: 'child-2', title: 'Child done', status: 'exited', parentSessionId: 'parent', workerType: 'generic-agent' }

    render(<SessionRadar sessions={[parent, failedChild, exitedChild]} selectedSessionId="parent" onSelectSession={vi.fn()} />)

    expect(screen.getByText('待处理 2')).toBeInTheDocument()
    expect(screen.getByText('检查子任务结果')).toHaveClass('session-next-action-line')
  })
})
