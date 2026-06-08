import type { Session, SessionUserAttention } from '../types/workerDesk'

export type SessionAttentionState = 'working' | 'needsReview' | 'completed'

export function getSessionAttentionState(
  session: Pick<Session, 'id' | 'status'>,
  handledSessionIds: Set<string>,
  userAttentionBySessionId: Record<string, SessionUserAttention | undefined>
): SessionAttentionState {
  const hookAttention = userAttentionBySessionId[session.id]
  if (hookAttention === 'needsReview') return 'needsReview'
  if (handledSessionIds.has(session.id)) return 'completed'
  if (hookAttention === 'working') return 'working'
  if (session.status === 'waiting' || session.status === 'failed') return 'needsReview'
  if (session.status === 'starting' || session.status === 'running' || session.status === 'idle') return 'working'
  return 'needsReview'
}

export function displayAttentionState(
  session: Pick<Session, 'id' | 'status'>,
  handledSessionIds: Set<string>,
  userAttentionBySessionId: Record<string, SessionUserAttention | undefined>
): SessionAttentionState {
  if (session.status === 'exited' || session.status === 'stopped') return 'completed'
  return getSessionAttentionState(session, handledSessionIds, userAttentionBySessionId)
}
