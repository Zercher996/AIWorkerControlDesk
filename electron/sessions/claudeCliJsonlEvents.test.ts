import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapClaudeCliJsonlRecord, readClaudeCliJsonlAsAiEvents } from './claudeCliJsonlEvents'

describe('mapClaudeCliJsonlRecord', () => {
  it('maps Claude CLI user and assistant messages to structured AI events', () => {
    const userEvents = mapClaudeCliJsonlRecord('desk-1', {
      type: 'user',
      timestamp: '2026-06-01T00:00:00.000Z',
      isMeta: false,
      message: { role: 'user', content: [{ type: 'text', text: '检查 package.json' }] }
    })
    const assistantEvents = mapClaudeCliJsonlRecord('desk-1', {
      type: 'assistant',
      timestamp: '2026-06-01T00:00:01.000Z',
      uuid: 'assistant-message-1',
      message: { role: 'assistant', content: [{ type: 'text', text: '我来检查。' }] }
    })

    expect(userEvents).toEqual([expect.objectContaining({ type: 'user_message', text: '检查 package.json', sessionId: 'desk-1', source: 'claude-code-jsonl' })])
    expect(assistantEvents).toEqual([expect.objectContaining({ type: 'assistant_text', text: '我来检查。', messageId: 'assistant-message-1', source: 'claude-code-jsonl' })])
  })

  it('maps assistant tool_use blocks and user tool_result blocks', () => {
    const toolUseEvents = mapClaudeCliJsonlRecord('desk-1', {
      type: 'assistant',
      timestamp: '2026-06-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '先读取文件。' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'package.json' } }
        ]
      }
    })
    const toolResultEvents = mapClaudeCliJsonlRecord('desk-1', {
      type: 'user',
      timestamp: '2026-06-01T00:00:03.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '{"name":"ai-worker-control-desk"}' }] }
        ]
      }
    })

    expect(toolUseEvents).toEqual([
      expect.objectContaining({ type: 'assistant_text', text: '先读取文件。' }),
      expect.objectContaining({ type: 'tool_use', toolUseId: 'toolu_1', name: 'Read', input: { file_path: 'package.json' } })
    ])
    expect(toolResultEvents).toEqual([
      expect.objectContaining({ type: 'tool_result', toolUseId: 'toolu_1', content: '{"name":"ai-worker-control-desk"}', isError: false })
    ])
  })

  it('maps permission-denied tool results and result permission denials', () => {
    const deniedToolResult = mapClaudeCliJsonlRecord('desk-1', {
      type: 'user',
      timestamp: '2026-06-01T00:00:04.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_denied', is_error: true, content: "Claude requested permissions to read secret.txt, but you haven't granted it yet." }
        ]
      }
    })
    const result = mapClaudeCliJsonlRecord('desk-1', {
      type: 'result',
      timestamp: '2026-06-01T00:00:05.000Z',
      subtype: 'success',
      result: 'done',
      sessionId: 'cli-session-1',
      permission_denials: [{ tool_name: 'Read', tool_use_id: 'toolu_denied', tool_input: { file_path: 'secret.txt' } }]
    })

    expect(deniedToolResult).toEqual([
      expect.objectContaining({ type: 'tool_result', toolUseId: 'toolu_denied', isError: true, errorKind: 'permission_denied' })
    ])
    expect(result).toEqual([
      expect.objectContaining({
        type: 'result',
        status: 'success',
        text: 'done',
        cliSessionId: 'cli-session-1',
        permissionDenials: [{ toolName: 'Read', toolUseId: 'toolu_denied', toolInput: { file_path: 'secret.txt' } }]
      })
    ])
  })

  it('maps native system api_error records to diagnostics', () => {
    const events = mapClaudeCliJsonlRecord({ deskSessionId: 'desk-1', sourceId: 'session.jsonl', lineOffset: 128 }, {
      type: 'system',
      subtype: 'api_error',
      level: 'error',
      timestamp: '2026-06-08T06:17:31.502Z',
      sessionId: 'cli-session-1',
      error: {
        status: 502,
        headers: { 'retry-after': '60' }
      },
      retryInMs: 60000,
      retryAttempt: 1,
      maxRetries: 10
    })

    expect(events).toEqual([
      expect.objectContaining({
        type: 'diagnostic',
        level: 'error',
        stream: 'lifecycle',
        message: 'Claude Code API error: HTTP 502; retry 1/10 after 60000ms'
      })
    ])
    expect(events[0].id).toBe('claude-jsonl:desk-1:session.jsonl:offset-128:0')
  })

  it('maps assistant end_turn stop reasons to a stable native turn_end event', () => {
    const first = mapClaudeCliJsonlRecord({ deskSessionId: 'desk-1', sourceId: 'session.jsonl', lineOffset: 84 }, {
      type: 'assistant',
      timestamp: '2026-06-01T00:00:02.000Z',
      sessionId: 'cli-session-1',
      message: {
        id: 'message-1',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '工具结果是 ai-worker-control-desk。' }]
      }
    })
    const second = mapClaudeCliJsonlRecord({ deskSessionId: 'desk-1', sourceId: 'session.jsonl', lineOffset: 84 }, {
      type: 'assistant',
      timestamp: '2026-06-01T00:00:02.000Z',
      sessionId: 'cli-session-1',
      message: {
        id: 'message-1',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '工具结果是 ai-worker-control-desk。' }]
      }
    })

    expect(first).toEqual([
      expect.objectContaining({ type: 'assistant_text', text: '工具结果是 ai-worker-control-desk。', messageId: 'message-1' }),
      expect.objectContaining({ type: 'turn_end', reason: 'end_turn', cliSessionId: 'cli-session-1' })
    ])
    expect(first.map((event) => event.id)).toEqual(second.map((event) => event.id))
    expect(new Set(first.map((event) => event.id)).size).toBe(first.length)
    expect(first.map((event) => event.id)).toEqual([
      'claude-jsonl:desk-1:session.jsonl:offset-84:0',
      'claude-jsonl:desk-1:session.jsonl:offset-84:1'
    ])
  })

  it('uses deterministic ids when line context is provided', () => {
    const first = mapClaudeCliJsonlRecord({ deskSessionId: 'desk-1', sourceId: 'session.jsonl', lineOffset: 42 }, {
      type: 'assistant',
      timestamp: '2026-06-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '先读取文件。' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'package.json' } }
        ]
      }
    })
    const second = mapClaudeCliJsonlRecord({ deskSessionId: 'desk-1', sourceId: 'session.jsonl', lineOffset: 42 }, {
      type: 'assistant',
      timestamp: '2026-06-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '先读取文件。' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'package.json' } }
        ]
      }
    })

    expect(first.map((event) => event.id)).toEqual(second.map((event) => event.id))
    expect(new Set(first.map((event) => event.id)).size).toBe(first.length)
    expect(first[0].id).toContain('claude-jsonl:desk-1:session.jsonl:offset-42:0')
  })

  it('preserves Chinese, emoji, and Windows paths when mapping native records', () => {
    const events = mapClaudeCliJsonlRecord({ deskSessionId: 'desk-中文', sourceId: 'C:\\Users\\zerch\\项目\\会话.jsonl', lineOffset: 12 }, {
      type: 'assistant',
      timestamp: '2026-06-01T00:00:02.000Z',
      uuid: 'assistant-中文-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '我会读取 Windows 路径里的文件 ✅' },
          { type: 'tool_use', id: 'toolu_中文', name: 'Read', input: { file_path: 'E:\\项目\\测试 空格\\说明✅.md' } }
        ]
      }
    })

    expect(events).toEqual([
      expect.objectContaining({ type: 'assistant_text', text: '我会读取 Windows 路径里的文件 ✅', messageId: 'assistant-中文-1' }),
      expect.objectContaining({ type: 'tool_use', toolUseId: 'toolu_中文', name: 'Read', input: { file_path: 'E:\\项目\\测试 空格\\说明✅.md' } })
    ])
    expect(events.every((event) => event.id.includes('claude-jsonl:desk-'))).toBe(true)
  })

  it('ignores unsupported native record types without projecting UI events', () => {
    const events = mapClaudeCliJsonlRecord({ deskSessionId: 'desk-1', lineIndex: 0 }, {
      type: 'permission-mode',
      timestamp: '2026-06-01T00:00:06.000Z',
      mode: 'acceptEdits'
    })

    expect(events).toEqual([])
  })

  it('ignores internal system records that do not carry a cli session id', () => {
    const events = mapClaudeCliJsonlRecord({ deskSessionId: 'desk-1', lineIndex: 0 }, {
      type: 'system',
      timestamp: '2026-06-01T00:00:06.000Z',
      subtype: undefined,
      data: 'internal-model-note'
    })

    expect(events).toEqual([])
  })
})

describe('readClaudeCliJsonlAsAiEvents', () => {
  it('reads a Claude CLI jsonl fixture into event order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-cli-jsonl-events-'))
    const filePath = join(dir, 'session.jsonl')
    await writeFile(filePath, [
      JSON.stringify({ type: 'system', subtype: 'init', sessionId: 'cli-session-1', timestamp: '2026-06-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'user', isMeta: false, timestamp: '2026-06-01T00:00:01.000Z', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T00:00:02.000Z', sessionId: 'cli-session-1', message: { role: 'assistant', content: 'hi', stop_reason: 'end_turn' } }),
      JSON.stringify({ type: 'result', timestamp: '2026-06-01T00:00:03.000Z', result: 'hi', sessionId: 'cli-session-1' })
    ].join('\n'), 'utf-8')

    try {
      const result = await readClaudeCliJsonlAsAiEvents(filePath, 'desk-1')

      expect(result.totalBytes).toBeGreaterThan(0)
      expect(result.unsupportedCount).toBe(0)
      expect(result.events.map((event) => event.type)).toEqual(['system', 'user_message', 'assistant_text', 'turn_end', 'result'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads UTF-8 native jsonl without corrupting Chinese or emoji content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-cli-jsonl-events-utf8-'))
    const filePath = join(dir, '会话✅.jsonl')
    await writeFile(filePath, [
      JSON.stringify({ type: 'user', isMeta: false, timestamp: '2026-06-01T00:00:01.000Z', message: { role: 'user', content: '读取 E:\\项目\\说明✅.md' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-01T00:00:02.000Z',
        sessionId: 'cli-session-中文',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '内容是：中文路径和 emoji ✅ 都正常。' },
            { type: 'tool_use', id: 'toolu_utf8', name: 'Read', input: { file_path: 'E:\\项目\\说明✅.md' } }
          ],
          stop_reason: 'end_turn'
        }
      })
    ].join('\n'), 'utf-8')

    try {
      const result = await readClaudeCliJsonlAsAiEvents(filePath, 'desk-中文')

      expect(result.unsupportedCount).toBe(0)
      expect(result.events).toEqual([
        expect.objectContaining({ type: 'user_message', text: '读取 E:\\项目\\说明✅.md' }),
        expect.objectContaining({ type: 'assistant_text', text: '内容是：中文路径和 emoji ✅ 都正常。' }),
        expect.objectContaining({ type: 'tool_use', toolUseId: 'toolu_utf8', input: { file_path: 'E:\\项目\\说明✅.md' } }),
        expect.objectContaining({ type: 'turn_end', cliSessionId: 'cli-session-中文' })
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
