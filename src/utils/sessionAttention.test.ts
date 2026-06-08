import { describe, expect, it } from 'vitest'
import type { SessionStatus, SessionUserAttention } from '../types/workerDesk'
import { displayAttentionState, getSessionAttentionState } from './sessionAttention'

const session = (status: SessionStatus, id: string = status) => ({ id, status })
const handled = (...ids: string[]) => new Set(ids)
const hooks = (values: Record<string, SessionUserAttention | undefined>) => values

describe('sessionAttention', () => {
  it('routes waiting and failed sessions to needs-review attention', () => {
    expect(getSessionAttentionState(session('waiting'), handled(), hooks({}))).toBe('needsReview')
    expect(getSessionAttentionState(session('failed'), handled(), hooks({}))).toBe('needsReview')
  })

  it('routes active runtime states to working attention', () => {
    expect(getSessionAttentionState(session('starting'), handled(), hooks({}))).toBe('working')
    expect(getSessionAttentionState(session('running'), handled(), hooks({}))).toBe('working')
    expect(getSessionAttentionState(session('idle'), handled(), hooks({}))).toBe('working')
  })

  it('lets hook needs-review override a previously handled running session', () => {
    expect(getSessionAttentionState(
      session('running', 's1'),
      handled('s1'),
      hooks({ s1: 'needsReview' })
    )).toBe('needsReview')
  })

  it('lets handled sessions become completed after hook attention is cleared', () => {
    expect(getSessionAttentionState(
      session('running', 's1'),
      handled('s1'),
      hooks({})
    )).toBe('completed')
  })

  it('displays exited and stopped sessions as completed for the radar', () => {
    expect(displayAttentionState(session('exited'), handled(), hooks({}))).toBe('completed')
    expect(displayAttentionState(session('stopped'), handled(), hooks({}))).toBe('completed')
  })
})
