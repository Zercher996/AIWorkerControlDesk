import { describe, expect, it } from 'vitest'
import {
  buildGenericAgentReturnPrompt,
  extractGenericAgentResult
} from './prompts'

const ESC = String.fromCharCode(27)
const ANSI_RED = `${ESC}[31m`
const ANSI_RESET = `${ESC}[0m`

describe('buildGenericAgentReturnPrompt', () => {
  it('passes the final answer through verbatim inside the wrapper', () => {
    const finalAnswer = '这是最终答案\n包含两行'
    const prompt = buildGenericAgentReturnPrompt('child-1', finalAnswer)
    expect(prompt).toContain('child-1')
    expect(prompt).toContain('--- GenericAgent Result ---')
    expect(prompt).toContain('--- End GenericAgent Result ---')
    expect(prompt).toContain(finalAnswer)
  })
})

describe('extractGenericAgentResult', () => {
  it('returns the trimmed content of a clean GA_RESULT block', () => {
    const raw = `random log line\n[GA_RESULT]\nFinal answer\n[/GA_RESULT]\n`
    expect(extractGenericAgentResult(raw)).toBe('Final answer')
  })

  it('strips ANSI noise around the GA_RESULT block', () => {
    const raw = `${ANSI_RED}thinking...${ANSI_RESET}\r\n[GA_RESULT]\n你好\n[/GA_RESULT]\n${ANSI_RED}done${ANSI_RESET}`
    expect(extractGenericAgentResult(raw)).toBe('你好')
  })

  it('returns the last GA_RESULT block when multiple are present', () => {
    const raw = `[GA_RESULT]\n第一段\n[/GA_RESULT]\nmiddle log\n[GA_RESULT]\n最终\n[/GA_RESULT]\n`
    expect(extractGenericAgentResult(raw)).toBe('最终')
  })

  it('supports inline GA_RESULT on a single line', () => {
    const raw = `noise\n[GA_RESULT] 你好 [/GA_RESULT]\nmore`
    expect(extractGenericAgentResult(raw)).toBe('你好')
  })

  it('falls back to the last non-status paragraph when GA_RESULT is missing', () => {
    const raw = [
      '⠋ Working...',
      '✻ Worked for 9s',
      '● 处理中',
      '',
      'first paragraph line A',
      'first paragraph line B',
      '',
      '最终答案行 1',
      '最终答案行 2',
      '',
      '⠙ Loading'
    ].join('\n')
    const result = extractGenericAgentResult(raw)
    expect(result).toBe('最终答案行 1\n最终答案行 2')
    expect(result).not.toContain('Worked')
    expect(result).not.toContain('⠋')
    expect(result).not.toContain('●')
  })

  it('returns an empty string when only status/spinner noise exists', () => {
    const raw = [
      '⠋ Working...',
      `${ANSI_RED}✻ Worked for 1s${ANSI_RESET}`,
      '● analyzing',
      '⏵⏵ thinking',
      '> running tool'
    ].join('\n')
    expect(extractGenericAgentResult(raw)).toBe('')
  })

  it('treats carriage return overwrites without inventing extra paragraphs', () => {
    const raw = `progress 10%\rprogress 99%\r\n[GA_RESULT]\nok\n[/GA_RESULT]`
    expect(extractGenericAgentResult(raw)).toBe('ok')
  })

  it('drops GA CLI trailing banner lines like [Output] tokens=… and stop_reason=… in fallback mode', () => {
    const raw = [
      '⠋ Working...',
      '',
      '最终答案应该被保留',
      '',
      '[Output] tokens=38 stop_reason=end_turn',
      'stop_reason=end_turn',
      '[Info] session closed'
    ].join('\n')
    const result = extractGenericAgentResult(raw)
    expect(result).toBe('最终答案应该被保留')
    expect(result).not.toContain('[Output]')
    expect(result).not.toContain('tokens=')
    expect(result).not.toContain('stop_reason=')
    expect(result).not.toContain('[Info]')
  })

  it('returns empty when only GA banner lines remain after status filtering', () => {
    const raw = [
      '⠋ Working...',
      '[Output] tokens=12 stop_reason=end_turn',
      'stop_reason=end_turn',
      '[Info] Load mykeys from GENERIC_AGENT_PROVIDER_CONFIG_JSON'
    ].join('\n')
    expect(extractGenericAgentResult(raw)).toBe('')
  })
})
