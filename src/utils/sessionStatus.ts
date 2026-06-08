import type { Session } from '../types/workerDesk'

export function isTerminalSessionStatus(status: Session['status']): boolean {
  return status === 'exited' || status === 'failed' || status === 'stopped'
}
