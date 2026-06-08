import { describe, expect, it } from 'vitest'
import { getNextStatusFromOutput, markInputWritten } from './sessionState'

describe('sessionState', () => {
  it('moves starting session to running when output arrives', () => {
    expect(getNextStatusFromOutput('starting', 'Claude Code')).toBe('running')
  })

  it('detects conservative waiting prompts', () => {
    expect(getNextStatusFromOutput('running', 'Do you want to proceed?')).toBe('waiting')
    expect(getNextStatusFromOutput('running', 'Yes, and don\'t ask again')).toBe('waiting')
    expect(getNextStatusFromOutput('running', 'Allow file edit?')).toBe('waiting')
    expect(getNextStatusFromOutput('running', '[y/n]')).toBe('waiting')
    expect(getNextStatusFromOutput('running', 'Press Enter to continue')).toBe('waiting')
  })

  it('detects Claude Code bypass permissions confirmation as waiting', () => {
    const output = [
      'WARNING: Claude Code running in Bypass Permissions mode',
      '1. No, exit',
      '2. Yes, I accept',
      'Enter to confirm · Esc to cancel'
    ].join('\n')

    expect(getNextStatusFromOutput('starting', output)).toBe('waiting')
  })

  it('keeps ordinary output running', () => {
    expect(getNextStatusFromOutput('running', 'Allowed tools: Read, Write')).toBe('running')
    expect(getNextStatusFromOutput('running', 'Press Enter to continue reading the docs later')).toBe('running')
  })

  it('keeps terminal statuses unchanged', () => {
    expect(getNextStatusFromOutput('exited', 'Do you want to proceed?')).toBe('exited')
    expect(getNextStatusFromOutput('failed', 'Do you want to proceed?')).toBe('failed')
  })

  it('moves starting directly to waiting when prompt arrives before first output', () => {
    expect(getNextStatusFromOutput('starting', 'Do you want to proceed?')).toBe('waiting')
  })

  it('keeps waiting unchanged when non-prompt output arrives', () => {
    expect(getNextStatusFromOutput('waiting', 'Some ordinary output')).toBe('waiting')
  })

  it('moves waiting session back to running after input', () => {
    expect(markInputWritten('waiting')).toBe('running')
    expect(markInputWritten('running')).toBe('running')
  })

  it('does not change starting or idle on input', () => {
    expect(markInputWritten('starting')).toBe('starting')
    expect(markInputWritten('idle')).toBe('idle')
  })
})
