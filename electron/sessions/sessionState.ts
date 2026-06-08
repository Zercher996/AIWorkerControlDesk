import type { SessionStatus } from '../../src/types/workerDesk'

export const CLAUDE_BYPASS_CONFIRMATION_WAITING_MESSAGE = 'Claude Code 正在等待 bypass permissions 安全确认。请切到原生 PTY 接管后选择是否接受。'
export const CLAUDE_BYPASS_CONFIRMATION_EXIT_MESSAGE = 'Claude Code 正在等待 bypass permissions 安全确认，未完成确认前进程已退出。请切到原生 PTY 接管后选择是否接受。'

const waitingPatterns = [
  /^\s*Do you want to proceed\?\s*$/im,
  /^\s*Yes, and don't ask again\s*$/im,
  /^\s*Allow\s+[^\r\n?]+\?\s*$/im,
  /^\s*\[y\/n\]\s*$/im,
  /^\s*Press Enter to continue\s*$/im
]

export function getNextStatusFromOutput(current: SessionStatus, chunk: string): SessionStatus {
  if (current === 'exited' || current === 'failed') {
    return current
  }
  if (isClaudeBypassPermissionsConfirmation(chunk) || waitingPatterns.some((pattern) => pattern.test(chunk))) {
    return 'waiting'
  }
  if (current === 'starting') {
    return 'running'
  }
  return current
}

const ANSI_ESCAPE_PATTERN = new RegExp(String.fromCharCode(27) + '\\[[0-?]*[ -/]*[@-~]', 'g')

export function isClaudeBypassPermissionsConfirmation(chunk: string): boolean {
  const normalized = chunk.replace(ANSI_ESCAPE_PATTERN, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  return normalized.includes('warning: claude code running in bypass permissions mode')
    && normalized.includes('yes, i accept')
    && normalized.includes('no, exit')
}

export function getClaudeStartupGateExitMessage(output: string): string | undefined {
  return isClaudeBypassPermissionsConfirmation(output) ? CLAUDE_BYPASS_CONFIRMATION_EXIT_MESSAGE : undefined
}

export function markInputWritten(current: SessionStatus): SessionStatus {
  return current === 'waiting' ? 'running' : current
}
