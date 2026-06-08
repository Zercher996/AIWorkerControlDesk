import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CliHistorySession, DeskHistoryItem } from '../types/workerDesk'
import { SessionDetail } from './SessionDetail'

const session: DeskHistoryItem = {
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

const genericSession: DeskHistoryItem = {
  ...session,
  id: 'session-child-123456',
  workerType: 'generic-agent',
  title: 'Generic child',
  parentSessionId: 'session-parent-abcdef',
  dispatchMode: 'auto'
}

const cliSession: CliHistorySession = {
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

const defaultProps = {
  session,
  output: 'hello output',
  summary: undefined as string | undefined,
  hasMoreOutput: false,
  outputSizeBytes: 1024,
  isLoading: false,
  isLoadingMore: false,
  isStartingSession: false,
  source: 'desk' as const,
  selectedProjectId: 'project-1',
  selectedProviderProfileId: 'provider-1',
  onGenerateSummary: vi.fn(),
  onExport: vi.fn(),
  onLoadMore: vi.fn(),
  onResumeSession: vi.fn(),
  onBack: vi.fn()
}

describe('SessionDetail', () => {
  it('shows output and triggers summary generation', () => {
    const onGenerateSummary = vi.fn()
    render(<SessionDetail {...defaultProps} onGenerateSummary={onGenerateSummary} />)
    expect(screen.getByText('hello output')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '生成 Summary' }))
    expect(onGenerateSummary).toHaveBeenCalledWith('session-1')
  })

  it('shows empty prompt when no session selected', () => {
    render(<SessionDetail {...defaultProps} session={undefined} />)
    expect(screen.getByText('请选择历史 Session。')).toBeInTheDocument()
  })

  it('shows existing summary', () => {
    render(<SessionDetail {...defaultProps} summary="Done summary" />)
    expect(screen.getByText('Done summary')).toBeInTheDocument()
  })

  it('shows load more button when hasMoreOutput is true', () => {
    const onLoadMore = vi.fn()
    render(<SessionDetail {...defaultProps} hasMoreOutput onLoadMore={onLoadMore} />)
    const btn = screen.getByRole('button', { name: '加载更多输出' })
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    expect(onLoadMore).toHaveBeenCalledWith('session-1')
  })

  it('hides load more button when hasMoreOutput is false', () => {
    render(<SessionDetail {...defaultProps} hasMoreOutput={false} />)
    expect(screen.queryByRole('button', { name: '加载更多输出' })).not.toBeInTheDocument()
  })

  it('shows 50 MB warning when output is large', () => {
    render(<SessionDetail {...defaultProps} outputSizeBytes={60 * 1024 * 1024} />)
    expect(screen.getByText(/输出超过 50 MB/)).toBeInTheDocument()
  })

  it('does not show 50 MB warning for small output', () => {
    render(<SessionDetail {...defaultProps} outputSizeBytes={1024} />)
    expect(screen.queryByText(/输出超过 50 MB/)).not.toBeInTheDocument()
  })

  it('shows summary generation for CLI session and hides export', () => {
    render(<SessionDetail {...defaultProps} session={cliSession} source="cli" />)
    expect(screen.getByRole('button', { name: '生成 Summary' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '导出输出' })).not.toBeInTheDocument()
  })

  it('shows continue from summary button for CLI session', () => {
    const onResume = vi.fn()
    render(<SessionDetail {...defaultProps} session={cliSession} source="cli" summary="历史总结" onResumeSession={onResume} />)
    const btn = screen.getByRole('button', { name: '基于 Summary 继续任务' })
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    expect(onResume).toHaveBeenCalledWith('cli-session-1')
  })

  it('shows continue from summary button for desk session', () => {
    const onResume = vi.fn()
    render(<SessionDetail {...defaultProps} summary="历史总结" onResumeSession={onResume} />)
    const btn = screen.getByRole('button', { name: '基于 Summary 继续任务' })
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    expect(onResume).toHaveBeenCalledWith('session-1')
  })

  it('shows CLI session title without source badge', () => {
    render(<SessionDetail {...defaultProps} session={cliSession} source="cli" />)
    expect(screen.getByText('Hello CLI')).toBeInTheDocument()
    expect(screen.queryByText('CLI')).not.toBeInTheDocument()
  })

  it('shows Summary section for CLI session', () => {
    render(<SessionDetail {...defaultProps} session={cliSession} source="cli" />)
    expect(screen.getByText('Summary')).toBeInTheDocument()
    expect(screen.getByText('尚未生成 Summary。')).toBeInTheDocument()
  })

  it('shows existing summary for CLI session', () => {
    render(<SessionDetail {...defaultProps} session={cliSession} source="cli" summary="CLI summary" />)
    expect(screen.getByText('Summary')).toBeInTheDocument()
    expect(screen.getByText('CLI summary')).toBeInTheDocument()
  })

  it('requires summary before continuing from CLI session', () => {
    render(<SessionDetail {...defaultProps} session={cliSession} source="cli" summary={undefined} />)
    expect(screen.getByRole('button', { name: '基于 Summary 继续任务' })).toBeDisabled()
    expect(screen.getByText('需要先生成 Summary，才能基于 Summary 继续任务')).toBeInTheDocument()
  })

  it('explains that continuing from summary starts a new real session', () => {
    render(<SessionDetail {...defaultProps} summary="历史总结" currentProviderName="Longcat" />)

    expect(screen.getByText('将基于 Summary 新建真实 Session，不恢复原运行态。')).toBeInTheDocument()
  })

  it('shows new-session hint for CLI session when a provider profile is selected', () => {
    render(<SessionDetail {...defaultProps} session={cliSession} source="cli" selectedProviderProfileId="provider-1" summary="CLI summary" />)
    expect(screen.getByText('将基于 Summary 新建真实 Session，不恢复原运行态。')).toBeInTheDocument()
  })

  it('disables resume button and shows warning when no provider profile is selected', () => {
    render(<SessionDetail {...defaultProps} session={cliSession} source="cli" selectedProviderProfileId={undefined} summary="CLI summary" />)
    expect(screen.getByRole('button', { name: '基于 Summary 继续任务' })).toBeDisabled()
    expect(screen.getByText('需要先选择模型连接才能继续任务')).toBeInTheDocument()
  })

  it('requires summary before continuing from desk session', () => {
    render(<SessionDetail {...defaultProps} summary={undefined} />)
    expect(screen.getByRole('button', { name: '基于 Summary 继续任务' })).toBeDisabled()
    expect(screen.getByText('需要先生成 Summary，才能基于 Summary 继续任务')).toBeInTheDocument()
  })

  it('does not show CLI badge for desk session', () => {
    render(<SessionDetail {...defaultProps} />)
    expect(screen.queryByText('CLI')).not.toBeInTheDocument()
  })

  it('shows worker dispatch metadata for desk history sessions', () => {
    render(<SessionDetail {...defaultProps} session={genericSession} />)

    expect(screen.getByText('Session ID: session-')).toBeInTheDocument()
    expect(screen.getByText('Role: GenericAgent 子 Worker')).toBeInTheDocument()
    expect(screen.getByText('Worker: generic-agent')).toBeInTheDocument()
    expect(screen.getByText('Dispatch: automatic from [GA_TASK:generic-agent]')).toBeInTheDocument()
    expect(screen.getByText('Parent Claude Session: session-')).toBeInTheDocument()
  })

  it('does not read worker metadata from CLI history sessions', () => {
    render(<SessionDetail {...defaultProps} session={cliSession} source="cli" />)

    expect(screen.queryByText(/Worker:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Dispatch:/)).not.toBeInTheDocument()
    expect(screen.getByText('Hello CLI')).toBeInTheDocument()
  })
})
