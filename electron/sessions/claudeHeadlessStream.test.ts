import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { buildClaudeHeadlessCommand, createStreamJsonLineParser, emitMappedEvents, startClaudeHeadlessStream } from './claudeHeadlessStream'
import type { ClaudeCodeLaunchConfig } from '../providers/claudeCodeProviderAdapter'

const launchConfig: ClaudeCodeLaunchConfig = {
  env: { ANTHROPIC_API_KEY: 'sk-test' },
  command: { file: 'claude', args: ['--model', 'claude-opus-4-7', '--permission-mode', 'default'] },
  permissionMode: 'default',
  model: 'claude-opus-4-7'
}

function makeStream() {
  return Object.assign(new EventEmitter(), {
    write: vi.fn()
  })
}

describe('claudeHeadlessStream', () => {
  it('adds headless stream-json flags to the Claude command', () => {
    expect(buildClaudeHeadlessCommand(launchConfig.command)).toEqual({
      file: 'claude',
      args: [
        '--model', 'claude-opus-4-7', '--permission-mode', 'default',
        '--bare', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'
      ]
    })
  })

  it('parses split JSONL chunks into structured events', () => {
    const events: unknown[] = []
    const parser = createStreamJsonLineParser({ sessionId: 'session-1', onEvent: (event) => events.push(event) })
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } })

    parser.push(line.slice(0, 20))
    parser.push(`${line.slice(20)}\n`)

    expect(events).toMatchObject([{ type: 'assistant_text', sessionId: 'session-1', text: 'hello' }])
  })

  it('emits diagnostic events for malformed JSON lines and continues', () => {
    const events: unknown[] = []
    const parser = createStreamJsonLineParser({ sessionId: 'session-1', onEvent: (event) => events.push(event) })

    parser.push('{bad json}\n')
    parser.push(`${JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 'cli-1' })}\n`)

    expect(events).toMatchObject([
      { type: 'diagnostic', level: 'warning', stream: 'parser' },
      { type: 'result', status: 'success', text: 'done', cliSessionId: 'cli-1' }
    ])
  })

  it('maps tool_use and tool_result events', () => {
    const events: unknown[] = []
    emitMappedEvents('session-1', {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }]
      }
    }, (event) => events.push(event))
    emitMappedEvents('session-1', {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' }]
      }
    }, (event) => events.push(event))

    expect(events).toMatchObject([
      { type: 'tool_use', toolUseId: 'tool-1', name: 'Read', input: { file_path: 'package.json' } },
      { type: 'tool_result', toolUseId: 'tool-1', content: 'file contents' }
    ])
  })

  it('maps permission-denied tool results and final denial summaries', () => {
    const events: unknown[] = []
    emitMappedEvents('session-1', {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: "Claude requested permissions to read from C:\\temp\\note.txt, but you haven't granted it yet.",
          is_error: true
        }]
      }
    }, (event) => events.push(event))
    emitMappedEvents('session-1', {
      type: 'result',
      is_error: false,
      result: 'done',
      session_id: 'cli-1',
      permission_denials: [{ tool_name: 'Read', tool_use_id: 'tool-1', tool_input: { file_path: 'C:/temp/note.txt' } }]
    }, (event) => events.push(event))

    expect(events).toMatchObject([
      { type: 'tool_result', isError: true, errorKind: 'permission_denied' },
      { type: 'result', status: 'success', permissionDenials: [{ toolName: 'Read', toolUseId: 'tool-1' }] }
    ])
  })

  it('writes user messages to stdin as stream-json lines', () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const stdin = makeStream()
    const child = Object.assign(new EventEmitter(), {
      pid: 1234,
      stdout,
      stderr,
      stdin,
      kill: vi.fn()
    })
    const spawnFn = vi.fn(() => child)

    const process = startClaudeHeadlessStream({
      cwd: '.',
      launchConfig,
      sessionId: 'session-1',
      onEvent: () => {},
      onExit: () => {}
    }, spawnFn)

    process.sendUserMessage(' hello ')

    expect(stdin.write).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(stdin.write.mock.calls[0][0].trim())
    expect(payload).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }
    })
    expect(spawnFn).toHaveBeenCalledWith('claude', expect.arrayContaining(['--input-format', 'stream-json']), expect.objectContaining({ cwd: '.' }))
  })
})
