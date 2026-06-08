import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CliHistorySession, SessionHistoryItem } from '../types/workerDesk'
import { HistoryPanel } from './HistoryPanel'

const item: SessionHistoryItem = {
  id: 'session-1',
  projectId: 'project-1',
  workerType: 'claude-code',
  interactionMode: 'pty',
  status: 'exited',
  title: 'History Session',
  createdAt: '2026-05-11T00:00:00.000Z',
  lastActivityAt: '2026-05-11T00:00:01.000Z',
  exitedAt: '2026-05-11T00:00:02.000Z',
  exitCode: 0,
  outputRef: 'file:sessions/session-1/output.jsonl',
  source: 'desk'
}

const cliItem: CliHistorySession = {
  id: 'cli-session-1',
  projectId: 'project-1',
  firstMessage: 'Hello CLI',
  messageCount: 5,
  createdAt: '2026-05-11T00:00:00.000Z',
  updatedAt: '2026-05-11T00:00:01.000Z',
  fileSizeBytes: 2048,
  cwd: 'E:\\test',
  source: 'cli'
}

describe('HistoryPanel', () => {
  it('selects a history session', () => {
    const onSelect = vi.fn()
    render(<HistoryPanel items={[item]} selectedSessionId={undefined} query="" onQueryChange={() => undefined} onSearch={() => undefined} onSelectSession={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: /History Session/ }))
    expect(onSelect).toHaveBeenCalledWith('session-1')
  })

  it('shows empty message when project is selected but has no history', () => {
    render(<HistoryPanel items={[]} selectedSessionId={undefined} query="" projectName="My Project" onQueryChange={() => undefined} onSearch={() => undefined} onSelectSession={() => undefined} />)
    expect(screen.getByText('暂无历史 Session')).toBeInTheDocument()
    expect(screen.getByText('My Project')).toBeInTheDocument()
  })

  it('prompts to select a project when none is selected', () => {
    render(<HistoryPanel items={[]} selectedSessionId={undefined} query="" onQueryChange={() => undefined} onSearch={() => undefined} onSelectSession={() => undefined} />)
    expect(screen.getByText('请先选择一个项目以查看历史')).toBeInTheDocument()
    expect(screen.queryByText('暂无历史 Session')).not.toBeInTheDocument()
  })

  it('shows stopped desk sessions as user-stopped history', () => {
    const stoppedItem: SessionHistoryItem = { ...item, id: 'session-stopped', status: 'stopped', title: 'Stopped Session' }

    render(<HistoryPanel items={[stoppedItem]} selectedSessionId={undefined} query="" onQueryChange={() => undefined} onSearch={() => undefined} onSelectSession={() => undefined} />)

    expect(screen.getByText('Stopped Session')).toBeInTheDocument()
    expect(screen.getByText('已停止')).toBeInTheDocument()
  })

  it('shows CLI session title without source badge', () => {
    render(<HistoryPanel items={[cliItem]} selectedSessionId={undefined} query="" onQueryChange={() => undefined} onSearch={() => undefined} onSelectSession={() => undefined} />)
    expect(screen.getByText('Hello CLI')).toBeInTheDocument()
    expect(screen.queryByText('CLI')).not.toBeInTheDocument()
  })

  it('does not show any badge for desk claude-code session', () => {
    render(<HistoryPanel items={[item]} selectedSessionId={undefined} query="" onQueryChange={() => undefined} onSearch={() => undefined} onSelectSession={() => undefined} />)
    expect(screen.queryByText('CLI')).not.toBeInTheDocument()
    expect(screen.queryByText('GA')).not.toBeInTheDocument()
  })

  it('shows GA badge for desk generic-agent orphan session', () => {
    const gaItem: SessionHistoryItem = { ...item, id: 'session-ga', workerType: 'generic-agent', title: 'GA Task' }
    render(<HistoryPanel items={[gaItem]} selectedSessionId={undefined} query="" onQueryChange={() => undefined} onSearch={() => undefined} onSelectSession={() => undefined} />)
    expect(screen.getByText('GA')).toBeInTheDocument()
    expect(screen.getByText('GA Task')).toBeInTheDocument()
  })

  it('hides low-signal cards behind a toggle and reveals them on click', () => {
    const lowSignalCard: CliHistorySession = { ...cliItem, id: 'cli-tiny', firstMessage: 'hi (test)', fileSizeBytes: 200 }
    render(
      <HistoryPanel
        items={[item]}
        lowSignalItems={[lowSignalCard]}
        selectedSessionId={undefined}
        query=""
        projectName="My Project"
        onQueryChange={() => undefined}
        onSearch={() => undefined}
        onSelectSession={() => undefined}
      />
    )
    // Toggle is visible, low-signal card hidden initially
    const toggle = screen.getByRole('button', { name: '展开 1 条低信号记录' })
    expect(toggle).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('hi (test)')).not.toBeInTheDocument()
    // Primary card still visible
    expect(screen.getByText('History Session')).toBeInTheDocument()
    // Click to expand
    fireEvent.click(toggle)
    expect(screen.getByText('hi (test)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '收起 1 条低信号记录' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows resumable history before regular history', () => {
    const resumableItem: SessionHistoryItem = { ...item, id: 'session-resumable', title: 'Can continue' }
    const regularItem: SessionHistoryItem = { ...item, id: 'session-regular', title: 'Regular history' }

    render(
      <HistoryPanel
        resumableItems={[resumableItem]}
        items={[regularItem]}
        selectedSessionId={undefined}
        query=""
        projectName="My Project"
        onQueryChange={() => undefined}
        onSearch={() => undefined}
        onSelectSession={() => undefined}
      />
    )

    expect(screen.getByText('可继续')).toBeInTheDocument()
    const cards = screen.getAllByRole('button').filter((button) => button.classList.contains('history-card'))
    expect(cards[0]).toHaveTextContent('Can continue')
    expect(cards[0]).toHaveTextContent('可继续')
    expect(cards[1]).toHaveTextContent('Regular history')
  })

  it('does not render the low-signal toggle when there are no low-signal items', () => {
    render(
      <HistoryPanel
        items={[item]}
        lowSignalItems={[]}
        selectedSessionId={undefined}
        query=""
        projectName="My Project"
        onQueryChange={() => undefined}
        onSearch={() => undefined}
        onSelectSession={() => undefined}
      />
    )
    expect(screen.queryByRole('button', { name: /低信号记录/ })).not.toBeInTheDocument()
  })
})
