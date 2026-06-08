import type { CliHistorySession, DeskHistoryItem, SessionHistoryItem } from '../types/workerDesk'

export const LOW_SIGNAL_BYTES = 10 * 1024
const LEGACY_MATCH_WINDOW_MS = 5 * 60 * 1000
const CLI_SINGLE_TURN_ASSISTANT_TEXT_CHARS = 300
const CLI_ERROR_ASSISTANT_TEXT_CHARS = 500
const CLI_GA_TASK_ASSISTANT_TEXT_CHARS = 500

type SummaryLookup = Record<string, string | undefined>

type BuildHistoryViewModelInput = {
  cliHistory: CliHistorySession[]
  deskHistory: DeskHistoryItem[]
  liveDeskHistory?: DeskHistoryItem[]
  summaryBySessionId: SummaryLookup
}

export type HistoryViewModel = {
  resumable: SessionHistoryItem[]
  primary: SessionHistoryItem[]
  lowSignal: SessionHistoryItem[]
}

function hasSummary(item: SessionHistoryItem, summaryBySessionId: SummaryLookup): boolean {
  if (item.source === 'cli') return Boolean(summaryBySessionId[item.id])
  return Boolean(summaryBySessionId[item.cliSessionId ?? item.id])
}

function getHistoryTime(item: SessionHistoryItem): string {
  return item.source === 'cli' ? item.updatedAt : item.lastActivityAt ?? ''
}

function isLowSignalCli(item: CliHistorySession): boolean {
  if (item.fileSizeBytes < LOW_SIGNAL_BYTES) return true
  if (item.qualityScanComplete !== true) return false
  if ((item.apiErrorCount ?? 0) > 0 && (item.assistantTextChars ?? 0) < CLI_ERROR_ASSISTANT_TEXT_CHARS) return true
  if (item.containsGaTask && (item.userMessageCount ?? 0) <= 2 && (item.assistantTextChars ?? 0) < CLI_GA_TASK_ASSISTANT_TEXT_CHARS) return true
  return (item.userMessageCount ?? Number.POSITIVE_INFINITY) <= 1
    && (item.assistantTextChars ?? Number.POSITIVE_INFINITY) < CLI_SINGLE_TURN_ASSISTANT_TEXT_CHARS
}

function isLowSignal(item: SessionHistoryItem, summaryBySessionId: SummaryLookup): boolean {
  if (hasSummary(item, summaryBySessionId)) return false
  if (item.source === 'cli') return isLowSignalCli(item)
  if (item.workerType === 'generic-agent') return false
  return item.status === 'failed' && (item.outputSizeBytes ?? 0) < LOW_SIGNAL_BYTES
}

function buildDeskToCliMap(deskHistory: DeskHistoryItem[], cliHistory: CliHistorySession[]) {
  const cliBySessionId = new Map(cliHistory.map((cli) => [cli.id, cli]))
  const deskToCliId = new Map<string, string>()
  const claimedCliIds = new Set<string>()

  for (const item of deskHistory) {
    if (item.cliSessionId && cliBySessionId.has(item.cliSessionId)) {
      deskToCliId.set(item.id, item.cliSessionId)
      claimedCliIds.add(item.cliSessionId)
    }
  }

  for (const item of deskHistory) {
    if (deskToCliId.has(item.id)) continue
    if (item.workerType !== 'claude-code') continue
    if (!item.exitedAt) continue

    const exitedMs = Date.parse(item.exitedAt)
    if (!Number.isFinite(exitedMs)) continue

    let bestId: string | undefined
    let bestDelta = Number.POSITIVE_INFINITY
    for (const cli of cliHistory) {
      if (claimedCliIds.has(cli.id)) continue
      const cliMs = Date.parse(cli.updatedAt)
      if (!Number.isFinite(cliMs)) continue
      const delta = Math.abs(cliMs - exitedMs)
      if (delta > LEGACY_MATCH_WINDOW_MS) continue
      if (delta < bestDelta) {
        bestDelta = delta
        bestId = cli.id
      }
    }

    if (bestId) {
      deskToCliId.set(item.id, bestId)
      claimedCliIds.add(bestId)
    }
  }

  return deskToCliId
}

export function buildHistoryViewModel(input: BuildHistoryViewModelInput): HistoryViewModel {
  const deskToCliId = buildDeskToCliMap(input.deskHistory, input.cliHistory)
  const orphanDeskItems: SessionHistoryItem[] = [
    ...(input.liveDeskHistory ?? []),
    ...input.deskHistory.filter((item) => !deskToCliId.has(item.id))
  ].map((item) => ({ ...item, source: 'desk' as const }))

  const all: SessionHistoryItem[] = [...input.cliHistory, ...orphanDeskItems]
  all.sort((a, b) => getHistoryTime(b).localeCompare(getHistoryTime(a)))

  const resumable: SessionHistoryItem[] = []
  const primary: SessionHistoryItem[] = []
  const lowSignal: SessionHistoryItem[] = []

  for (const item of all) {
    if (hasSummary(item, input.summaryBySessionId)) {
      resumable.push(item)
    } else if (isLowSignal(item, input.summaryBySessionId)) {
      lowSignal.push(item)
    } else {
      primary.push(item)
    }
  }

  return { resumable, primary, lowSignal }
}
