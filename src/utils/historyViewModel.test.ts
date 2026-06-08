import { describe, expect, it } from 'vitest'
import type { CliHistorySession, DeskHistoryItem } from '../types/workerDesk'
import { LOW_SIGNAL_BYTES, buildHistoryViewModel } from './historyViewModel'

const cliBase: CliHistorySession = {
  id: 'cli-1',
  projectId: 'project-1',
  firstMessage: 'CLI task',
  createdAt: '2026-05-11T00:00:00.000Z',
  updatedAt: '2026-05-11T00:00:10.000Z',
  fileSizeBytes: LOW_SIGNAL_BYTES,
  cwd: 'E:/project-one',
  userMessageCount: 2,
  assistantTextChars: 600,
  apiErrorCount: 0,
  containsGaTask: false,
  qualityScanComplete: true,
  source: 'cli'
}

const deskBase: DeskHistoryItem = {
  id: 'desk-1',
  projectId: 'project-1',
  workerType: 'claude-code',
  interactionMode: 'pty',
  status: 'exited',
  title: 'Desk task',
  createdAt: '2026-05-11T00:00:00.000Z',
  lastActivityAt: '2026-05-11T00:00:09.000Z',
  exitedAt: '2026-05-11T00:00:09.000Z',
  exitCode: 0,
  outputRef: 'file:sessions/desk-1/output.jsonl',
  outputSizeBytes: LOW_SIGNAL_BYTES,
  source: 'desk'
}

describe('buildHistoryViewModel', () => {
  it('folds CLI history below 10KB when it has no summary', () => {
    const cli = { ...cliBase, fileSizeBytes: LOW_SIGNAL_BYTES - 1 }

    const view = buildHistoryViewModel({ cliHistory: [cli], deskHistory: [], summaryBySessionId: {} })

    expect(view.primary).toEqual([])
    expect(view.lowSignal.map((item) => item.id)).toEqual(['cli-1'])
  })

  it('keeps small CLI history in resumable when it has a summary', () => {
    const cli = { ...cliBase, fileSizeBytes: LOW_SIGNAL_BYTES - 1 }

    const view = buildHistoryViewModel({
      cliHistory: [cli],
      deskHistory: [],
      summaryBySessionId: { 'cli-1': 'summary' }
    })

    expect(view.resumable.map((item) => item.id)).toEqual(['cli-1'])
    expect(view.primary).toEqual([])
    expect(view.lowSignal).toEqual([])
  })

  it('keeps CLI history at or above 10KB in primary', () => {
    const view = buildHistoryViewModel({ cliHistory: [cliBase], deskHistory: [], summaryBySessionId: {} })

    expect(view.primary.map((item) => item.id)).toEqual(['cli-1'])
    expect(view.lowSignal).toEqual([])
  })

  it('keeps large CLI history in primary when quality scan is incomplete', () => {
    const cli = {
      ...cliBase,
      fileSizeBytes: LOW_SIGNAL_BYTES + 20_000,
      userMessageCount: 1,
      assistantTextChars: 24,
      qualityScanComplete: false
    }

    const view = buildHistoryViewModel({ cliHistory: [cli], deskHistory: [], summaryBySessionId: {} })

    expect(view.primary.map((item) => item.id)).toEqual(['cli-1'])
    expect(view.lowSignal).toEqual([])
  })

  it('folds complete single-turn CLI history when assistant text is tiny', () => {
    const cli = {
      ...cliBase,
      fileSizeBytes: LOW_SIGNAL_BYTES + 20_000,
      userMessageCount: 1,
      assistantTextChars: 120,
      qualityScanComplete: true
    }

    const view = buildHistoryViewModel({ cliHistory: [cli], deskHistory: [], summaryBySessionId: {} })

    expect(view.primary).toEqual([])
    expect(view.lowSignal.map((item) => item.id)).toEqual(['cli-1'])
  })

  it('folds large CLI api-error sessions when the quality scan is complete and assistant text is tiny', () => {
    const cli = {
      ...cliBase,
      fileSizeBytes: LOW_SIGNAL_BYTES + 20_000,
      userMessageCount: 1,
      assistantTextChars: 0,
      apiErrorCount: 3,
      qualityScanComplete: true
    }

    const view = buildHistoryViewModel({ cliHistory: [cli], deskHistory: [], summaryBySessionId: {} })

    expect(view.primary).toEqual([])
    expect(view.lowSignal.map((item) => item.id)).toEqual(['cli-1'])
  })

  it('folds large CLI GA_TASK probe sessions when the quality scan is complete and they are short', () => {
    const cli = {
      ...cliBase,
      fileSizeBytes: LOW_SIGNAL_BYTES + 20_000,
      userMessageCount: 2,
      assistantTextChars: 80,
      containsGaTask: true,
      qualityScanComplete: true
    }

    const view = buildHistoryViewModel({ cliHistory: [cli], deskHistory: [], summaryBySessionId: {} })

    expect(view.primary).toEqual([])
    expect(view.lowSignal.map((item) => item.id)).toEqual(['cli-1'])
  })

  it('keeps large CLI sessions with real assistant text in primary', () => {
    const cli = {
      ...cliBase,
      fileSizeBytes: LOW_SIGNAL_BYTES + 20_000,
      userMessageCount: 1,
      assistantTextChars: 600
    }

    const view = buildHistoryViewModel({ cliHistory: [cli], deskHistory: [], summaryBySessionId: {} })

    expect(view.primary.map((item) => item.id)).toEqual(['cli-1'])
    expect(view.lowSignal).toEqual([])
  })

  it('keeps quality-low CLI history in primary when the quality scan is incomplete', () => {
    const cli = {
      ...cliBase,
      fileSizeBytes: LOW_SIGNAL_BYTES + 20_000,
      userMessageCount: 1,
      assistantTextChars: 0,
      apiErrorCount: 3,
      containsGaTask: true,
      qualityScanComplete: false
    }

    const view = buildHistoryViewModel({ cliHistory: [cli], deskHistory: [], summaryBySessionId: {} })

    expect(view.primary.map((item) => item.id)).toEqual(['cli-1'])
    expect(view.lowSignal).toEqual([])
  })

  it('keeps quality-low CLI history in resumable when it has a summary', () => {
    const cli = {
      ...cliBase,
      fileSizeBytes: LOW_SIGNAL_BYTES + 20_000,
      userMessageCount: 1,
      assistantTextChars: 0,
      apiErrorCount: 3,
      containsGaTask: true,
      qualityScanComplete: true
    }

    const view = buildHistoryViewModel({
      cliHistory: [cli],
      deskHistory: [],
      summaryBySessionId: { 'cli-1': 'summary' }
    })

    expect(view.resumable.map((item) => item.id)).toEqual(['cli-1'])
    expect(view.primary).toEqual([])
    expect(view.lowSignal).toEqual([])
  })

  it('folds short failed claude-code desk orphans when they have no summary', () => {
    const desk = {
      ...deskBase,
      status: 'failed' as const,
      exitCode: 1,
      outputSizeBytes: LOW_SIGNAL_BYTES - 1
    }

    const view = buildHistoryViewModel({ cliHistory: [], deskHistory: [desk], summaryBySessionId: {} })

    expect(view.primary).toEqual([])
    expect(view.lowSignal.map((item) => item.id)).toEqual(['desk-1'])
  })

  it('keeps long failed claude-code desk orphans in primary', () => {
    const desk = {
      ...deskBase,
      status: 'failed' as const,
      exitCode: 1,
      outputSizeBytes: LOW_SIGNAL_BYTES
    }

    const view = buildHistoryViewModel({ cliHistory: [], deskHistory: [desk], summaryBySessionId: {} })

    expect(view.primary.map((item) => item.id)).toEqual(['desk-1'])
    expect(view.lowSignal).toEqual([])
  })

  it('keeps failed claude-code desk orphans in resumable when they have a summary', () => {
    const desk = {
      ...deskBase,
      status: 'failed' as const,
      exitCode: 1,
      outputSizeBytes: LOW_SIGNAL_BYTES - 1
    }

    const view = buildHistoryViewModel({
      cliHistory: [],
      deskHistory: [desk],
      summaryBySessionId: { 'desk-1': 'summary' }
    })

    expect(view.resumable.map((item) => item.id)).toEqual(['desk-1'])
    expect(view.primary).toEqual([])
    expect(view.lowSignal).toEqual([])
  })

  it('keeps GA orphans in primary even when they are short failed sessions', () => {
    const desk = {
      ...deskBase,
      id: 'ga-1',
      workerType: 'generic-agent' as const,
      status: 'failed' as const,
      exitCode: 1,
      outputSizeBytes: 1
    }

    const view = buildHistoryViewModel({ cliHistory: [], deskHistory: [desk], summaryBySessionId: {} })

    expect(view.primary.map((item) => item.id)).toEqual(['ga-1'])
    expect(view.lowSignal).toEqual([])
  })

  it('absorbs legacy claude-code desk sessions into nearby CLI cards', () => {
    const cli = { ...cliBase, updatedAt: '2026-05-11T00:00:10.000Z' }
    const desk = { ...deskBase, id: 'legacy-desk', exitedAt: '2026-05-11T00:00:11.000Z' }

    const view = buildHistoryViewModel({ cliHistory: [cli], deskHistory: [desk], summaryBySessionId: {} })

    expect(view.primary.map((item) => item.id)).toEqual(['cli-1'])
    expect(view.lowSignal).toEqual([])
  })

  it('does not absorb legacy claude-code desk sessions when the nearby CLI card is only close within the old broad window', () => {
    const cli = { ...cliBase, updatedAt: '2026-05-11T00:10:00.000Z' }
    const desk = { ...deskBase, id: 'broad-window-desk', exitedAt: '2026-05-11T00:00:00.000Z' }

    const view = buildHistoryViewModel({ cliHistory: [cli], deskHistory: [desk], summaryBySessionId: {} })

    expect(view.primary.map((item) => item.id)).toEqual(['cli-1', 'broad-window-desk'])
    expect(view.lowSignal).toEqual([])
  })

  it('keeps live stopped desk history separate from nearby CLI cards', () => {
    const cli = { ...cliBase, updatedAt: '2026-05-11T00:00:10.000Z' }
    const liveDesk = {
      ...deskBase,
      id: 'live-stopped',
      status: 'stopped' as const,
      title: 'Stopped live task',
      exitCode: 1,
      lastActivityAt: '2026-05-11T00:00:11.000Z',
      exitedAt: '2026-05-11T00:00:11.000Z'
    }

    const view = buildHistoryViewModel({
      cliHistory: [cli],
      deskHistory: [],
      liveDeskHistory: [liveDesk],
      summaryBySessionId: {}
    })

    expect(view.primary.map((item) => item.id)).toEqual(['live-stopped', 'cli-1'])
    expect(view.primary[0]).toMatchObject({ id: 'live-stopped', status: 'stopped', source: 'desk' })
    expect(view.lowSignal).toEqual([])
  })

  it('does not absorb legacy claude-code desk sessions outside the time window', () => {
    const cli = { ...cliBase, updatedAt: '2026-05-11T00:00:10.000Z' }
    const desk = {
      ...deskBase,
      id: 'old-desk',
      lastActivityAt: '2026-05-11T02:30:00.000Z',
      exitedAt: '2026-05-11T02:30:00.000Z'
    }

    const view = buildHistoryViewModel({ cliHistory: [cli], deskHistory: [desk], summaryBySessionId: {} })

    expect(view.primary.map((item) => item.id)).toEqual(['old-desk', 'cli-1'])
    expect(view.lowSignal).toEqual([])
  })

  it('promotes history with summaries into the resumable list', () => {
    const cli = { ...cliBase, id: 'cli-with-summary' }
    const desk = {
      ...deskBase,
      id: 'desk-with-summary',
      lastActivityAt: '2026-05-11T02:30:00.000Z',
      exitedAt: '2026-05-11T02:30:00.000Z'
    }
    const lowSignalCli = { ...cliBase, id: 'low-signal-cli', fileSizeBytes: LOW_SIGNAL_BYTES - 1 }

    const view = buildHistoryViewModel({
      cliHistory: [cli, lowSignalCli],
      deskHistory: [desk],
      summaryBySessionId: {
        'cli-with-summary': 'summary',
        'desk-with-summary': 'summary'
      }
    })

    expect(view.resumable.map((item) => item.id)).toEqual(['desk-with-summary', 'cli-with-summary'])
    expect(view.primary).toEqual([])
    expect(view.lowSignal.map((item) => item.id)).toEqual(['low-signal-cli'])
  })

  it('sorts primary history newest first after merging', () => {
    const olderCli = { ...cliBase, id: 'older-cli', updatedAt: '2026-05-11T00:00:10.000Z' }
    const newerDesk = { ...deskBase, id: 'newer-desk', lastActivityAt: '2026-05-11T00:00:20.000Z', exitedAt: '2026-05-11T02:00:00.000Z' }

    const view = buildHistoryViewModel({
      cliHistory: [olderCli],
      deskHistory: [newerDesk],
      summaryBySessionId: {}
    })

    expect(view.primary.map((item) => item.id)).toEqual(['newer-desk', 'older-cli'])
  })
})
