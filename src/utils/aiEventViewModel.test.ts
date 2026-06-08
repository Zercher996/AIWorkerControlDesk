import { describe, expect, it } from 'vitest'
import type { SessionAiEvent } from '../types/workerDesk'
import { buildAiEventViewModel, buildAiTurnViewModel, summarizeCurrentAiTurn, TOOL_RESULT_PREVIEW_CHAR_LIMIT } from './aiEventViewModel'

const event = (type: SessionAiEvent['type'], extra: Partial<SessionAiEvent> = {}): SessionAiEvent => ({
  id: `${type}-${Math.random()}`,
  sessionId: 'session-1',
  timestamp: '2026-05-29T00:00:00.000Z',
  source: 'desk',
  type,
  ...extra
} as SessionAiEvent)

describe('buildAiTurnViewModel', () => {
  it('renders a greeting as one work record without repeating result text', () => {
    const turns = buildAiTurnViewModel([
      event('user_message', { id: 'u1', text: '你好呀' }),
      event('assistant_text', { id: 'a1', text: '你好！很高兴见到你！', messageId: 'msg-1' }),
      event('result', { id: 'r1', status: 'success', text: '你好！很高兴见到你！' })
    ])

    expect(turns).toMatchObject([
      {
        id: 'u1',
        userInput: '你好呀',
        assistantOutput: '你好！很高兴见到你！',
        status: 'completed',
        completionText: ''
      }
    ])
  })

  it('uses result text as fallback only when there is no assistant output', () => {
    const turns = buildAiTurnViewModel([
      event('user_message', { id: 'u1', text: 'ping' }),
      event('result', { id: 'r1', status: 'success', text: 'pong' })
    ])

    expect(turns).toMatchObject([{ userInput: 'ping', assistantOutput: 'pong', completionText: '' }])
  })

  it('keeps multiple user turns separate', () => {
    const turns = buildAiTurnViewModel([
      event('user_message', { id: 'u1', text: 'first' }),
      event('assistant_text', { id: 'a1', text: 'one' }),
      event('result', { id: 'r1', status: 'success', text: 'one' }),
      event('user_message', { id: 'u2', text: 'second' }),
      event('assistant_text', { id: 'a2', text: 'two' }),
      event('result', { id: 'r2', status: 'success', text: 'two' })
    ])

    expect(turns).toHaveLength(2)
    expect(turns).toMatchObject([
      { id: 'u1', userInput: 'first', assistantOutput: 'one' },
      { id: 'u2', userInput: 'second', assistantOutput: 'two' }
    ])
  })

  it('uses native-jsonl turn_end to complete a turn after tool results and assistant text', () => {
    const turns = buildAiTurnViewModel([
      event('user_message', { id: 'u1', text: '读取 package 名称' }),
      event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }),
      event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: '{ "name": "ai-worker-control-desk" }', isError: false }),
      event('assistant_text', { id: 'assistant-1', text: '包名是 ai-worker-control-desk。', messageId: 'message-1' }),
      event('turn_end', { id: 'turn-end-1', reason: 'end_turn', cliSessionId: 'cli-session-1' })
    ])

    expect(turns).toMatchObject([
      {
        id: 'u1',
        userInput: '读取 package 名称',
        assistantOutput: '包名是 ai-worker-control-desk。',
        status: 'completed',
        completionText: '',
        tools: [{ name: 'Read', status: 'success', resultPreview: '{ "name": "ai-worker-control-desk" }' }]
      }
    ])
  })

  it('keeps native-jsonl turns running after tools finish until turn_end or result arrives', () => {
    const turns = buildAiTurnViewModel([
      event('user_message', { id: 'u1', text: '读取 package 名称' }),
      event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }),
      event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: '{ "name": "ai-worker-control-desk" }', isError: false })
    ])

    expect(turns).toMatchObject([
      {
        status: 'running',
        completionText: '',
        tools: [{ name: 'Read', status: 'success' }]
      }
    ])
  })

  it('attaches paired tool runs to the current work record', () => {
    const turns = buildAiTurnViewModel([
      event('user_message', { id: 'u1', text: 'read package' }),
      event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }),
      event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: 'file contents', isError: false }),
      event('result', { id: 'r1', status: 'success', text: 'done' })
    ])

    expect(turns).toMatchObject([
      {
        tools: [{ name: 'Read', inputSummary: '读取 package.json', status: 'success', resultPreview: 'file contents' }],
        status: 'completed'
      }
    ])
  })

  it('keeps orphan tool results visible in a work record', () => {
    const turns = buildAiTurnViewModel([
      event('tool_result', { id: 'tool-result-1', toolUseId: 'missing-tool', content: 'late result', isError: false })
    ])

    expect(turns).toMatchObject([
      {
        id: 'tool-result-1',
        tools: [{ name: '未知工具', status: 'success', isOrphan: true, resultPreview: 'late result' }]
      }
    ])
  })

  it('marks permission denials as a takeover blocker', () => {
    const turns = buildAiTurnViewModel([
      event('user_message', { id: 'u1', text: 'read temp' }),
      event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Read', input: { file_path: 'C:/temp/note.txt' } }),
      event('tool_result', {
        id: 'tool-result-1',
        toolUseId: 'tool-1',
        content: "Claude requested permissions, but you haven't granted it yet.",
        isError: true,
        errorKind: 'permission_denied'
      }),
      event('result', {
        id: 'result-1',
        status: 'success',
        text: 'done',
        permissionDenials: [{ toolName: 'Read', toolUseId: 'tool-1', toolInput: { file_path: 'C:/temp/note.txt' } }]
      })
    ])

    expect(turns).toMatchObject([
      {
        status: 'permission_denied',
        completionText: '',
        tools: [{ status: 'permission_denied', permissionDenials: [{ toolName: 'Read', toolUseId: 'tool-1' }] }],
        permissionDenials: [{ toolName: 'Read', toolUseId: 'tool-1' }]
      }
    ])
  })

  it('keeps a failed status only when the AI never produced a usable summary', () => {
    const turns = buildAiTurnViewModel([
      event('user_message', { id: 'u1', text: 'run tests' }),
      event('tool_use', { id: 'b1', toolUseId: 'b1', name: 'Bash', input: { command: 'npm run missing' } }),
      event('tool_result', { id: 'b1-res', toolUseId: 'b1', content: 'script missing', isError: true, errorKind: 'tool_error' }),
      event('result', { id: 'r1', status: 'error', errorMessage: 'script missing' })
    ])

    expect(turns).toMatchObject([{ status: 'failed' }])
    expect(turns[0].completionText).toBe('')
  })

  it('summarizes common file and command tool actions clearly', () => {
    const turns = buildAiTurnViewModel([
      event('tool_use', { id: 'read', name: 'Read', input: { file_path: 'src/App.tsx' } }),
      event('tool_use', { id: 'write', name: 'Write', input: { file_path: 'tmp/output.txt' } }),
      event('tool_use', { id: 'edit', name: 'Edit', input: { file_path: 'src/App.tsx' } }),
      event('tool_use', { id: 'multi-edit', name: 'MultiEdit', input: { file_path: 'src/App.tsx' } }),
      event('tool_use', { id: 'bash', name: 'Bash', input: { command: 'npm run test' } }),
      event('tool_use', { id: 'grep', name: 'Grep', input: { pattern: 'canSend', path: 'src' } }),
      event('tool_use', { id: 'glob', name: 'Glob', input: { pattern: '**/*.tsx', path: 'src' } })
    ])

    expect(turns[0].tools.map((tool) => tool.inputSummary)).toEqual([
      '读取 src/App.tsx',
      '写入 tmp/output.txt',
      '修改 src/App.tsx',
      '批量修改 src/App.tsx',
      '执行 npm run test',
      '搜索 canSend · src',
      '匹配 **/*.tsx · src'
    ])
  })

  it('summarizes MCP tool names and URLs from tool input', () => {
    const turns = buildAiTurnViewModel([
      event('tool_use', { id: 'mcp', name: 'mcp__context7__query-docs', input: { libraryId: '/vercel/next.js', query: 'routing' } }),
      event('tool_use', { id: 'fetch', name: 'WebFetch', input: { url: 'https://example.com/docs' } })
    ])

    expect(turns[0].tools.map((tool) => tool.inputSummary)).toEqual([
      'MCP context7/query-docs · /vercel/next.js',
      '访问 https://example.com/docs'
    ])
  })

  it('keeps multiple permission denials visible when no paired tool call exists', () => {
    const turns = buildAiTurnViewModel([
      event('result', {
        id: 'result-1',
        status: 'success',
        text: 'done',
        permissionDenials: [
          { toolName: 'Read', toolUseId: 'read-1', toolInput: { file_path: 'secret.txt' } },
          { toolName: 'Bash', toolUseId: 'bash-1', toolInput: { command: 'rm temp.txt' } }
        ]
      })
    ])

    expect(turns).toMatchObject([
      {
        status: 'permission_denied',
        completionText: '',
        permissionDenials: [
          { toolName: 'Read', toolUseId: 'read-1' },
          { toolName: 'Bash', toolUseId: 'bash-1' }
        ]
      }
    ])
  })

  it('keeps tool errors distinct from permission denials', () => {
    const turns = buildAiTurnViewModel([
      event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Bash', input: { command: 'npm run missing' } }),
      event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: 'script missing', isError: true, errorKind: 'tool_error' })
    ])

    expect(turns).toMatchObject([
      {
        status: 'failed',
        tools: [{ name: 'Bash', status: 'error', resultPreview: 'script missing' }],
        permissionDenials: []
      }
    ])
  })

  it('does not mark the whole turn as failed when an earlier tool error is followed by a successful assistant summary', () => {
    const turns = buildAiTurnViewModel([
      event('user_message', { id: 'u1', text: 'look at my desktop' }),
      event('tool_use', { id: 'b1', toolUseId: 'b1', name: 'Bash', input: { command: 'dir "C:\\Users\\Example\\Desktop" /B' } }),
      event('tool_result', { id: 'b1-res', toolUseId: 'b1', content: 'No such file', isError: true, errorKind: 'tool_error' }),
      event('tool_use', { id: 'b2', toolUseId: 'b2', name: 'Bash', input: { command: 'ls -la "C:/Users/Example/Desktop/"' } }),
      event('tool_result', { id: 'b2-res', toolUseId: 'b2', content: 'total 50', isError: false }),
      event('assistant_text', { id: 'a1', text: '你桌面很清爽。', messageId: 'msg-1' }),
      event('result', { id: 'r1', status: 'success', text: '你桌面很清爽。' })
    ])

    expect(turns).toMatchObject([{
      status: 'completed',
      tools: [
        { name: 'Bash', status: 'error' },
        { name: 'Bash', status: 'success' }
      ]
    }])
    expect(turns[0].completionText).toBe('')
  })

  it('truncates long tool results in the preview only', () => {
    const longText = 'x'.repeat(TOOL_RESULT_PREVIEW_CHAR_LIMIT + 100)
    const [turn] = buildAiTurnViewModel([
      event('user_message', { id: 'u1', text: 'read long file' }),
      event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Read' }),
      event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: longText, isError: false })
    ])

    const [tool] = turn.tools
    expect(tool).toMatchObject({ isResultTruncated: true, resultText: longText })
    expect(tool.resultPreview?.length).toBeLessThan(longText.length)
  })
})

describe('summarizeCurrentAiTurn', () => {
  it('summarizes an empty scene as waiting for user input', () => {
    expect(summarizeCurrentAiTurn([])).toBe('等待用户输入。')
  })

  it('summarizes a running tool as the current scene', () => {
    const turns = buildAiTurnViewModel([
      event('user_message', { id: 'u1', text: 'run tests' }),
      event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Bash', input: { command: 'npm run test' } })
    ])

    expect(summarizeCurrentAiTurn(turns)).toBe('正在运行工具：Bash')
  })

  it('summarizes finished tools before the assistant summary arrives as a quiet placeholder', () => {
    const turns = buildAiTurnViewModel([
      event('user_message', { id: 'u1', text: 'read package' }),
      event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }),
      event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: '{}', isError: false })
    ])

    expect(summarizeCurrentAiTurn(turns)).toBe('')
  })

  it('summarizes permission blockers with the blocked tool name', () => {
    const turns = buildAiTurnViewModel([
      event('tool_use', { id: 'tool-use-1', toolUseId: 'read-1', name: 'Read', input: { file_path: 'secret.txt' } }),
      event('result', {
        id: 'result-1',
        status: 'success',
        text: 'done',
        permissionDenials: [{ toolName: 'Read', toolUseId: 'read-1' }]
      })
    ])

    expect(summarizeCurrentAiTurn(turns)).toBe('需要接管权限请求：Read')
  })

  it('summarizes failed tools with the failed tool name', () => {
    const turns = buildAiTurnViewModel([
      event('user_message', { id: 'u1', text: 'run tests' }),
      event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Bash', input: { command: 'npm run missing' } }),
      event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: 'script missing', isError: true, errorKind: 'tool_error' })
    ])

    expect(summarizeCurrentAiTurn(turns)).toBe('工具失败：Bash')
  })

  it('summarizes completed native-jsonl turns as a quiet placeholder', () => {
    const turns = buildAiTurnViewModel([
      event('user_message', { id: 'u1', text: 'hello' }),
      event('assistant_text', { id: 'a1', text: 'done' }),
      event('turn_end', { id: 'turn-end-1', reason: 'end_turn' })
    ])

    expect(summarizeCurrentAiTurn(turns)).toBe('')
  })
})

describe('buildAiEventViewModel', () => {
  it('keeps a legacy event-item projection for existing callers', () => {
    const items = buildAiEventViewModel([
      event('user_message', { id: 'u1', text: 'hello' }),
      event('assistant_text', { id: 'a1', text: 'world' }),
      event('result', { id: 'r1', status: 'success', text: 'world' })
    ])

    expect(items).toMatchObject([
      { kind: 'user_message', text: 'hello' },
      { kind: 'assistant_text', text: 'world' },
      { kind: 'result', text: '' }
    ])
  })
})

describe('AiToolViewItem execution ticket', () => {
  it('labels Bash calls as command and exposes the command line as the instruction text', () => {
    const [turn] = buildAiTurnViewModel([
      event('tool_use', { id: 'bash', toolUseId: 'tool-1', name: 'Bash', input: { command: 'npm run test' } }),
      event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: '584 passed', isError: false })
    ])

    const [tool] = turn.tools
    expect(tool.callKindLabel).toBe('命令')
    expect(tool.callTitle).toBe('Bash')
    expect(tool.callInstructionLabel).toBe('命令')
    expect(tool.callInstructionText).toBe('npm run test')
    expect(tool.resultSummary).toBe('584 passed')
  })

  it('labels Read/Write/Edit calls as tool and exposes the file path as the instruction text', () => {
    const [turn] = buildAiTurnViewModel([
      event('tool_use', { id: 'read', toolUseId: 'r1', name: 'Read', input: { file_path: 'src/App.tsx' } }),
      event('tool_use', { id: 'write', toolUseId: 'w1', name: 'Write', input: { file_path: 'tmp/out.txt' } }),
      event('tool_use', { id: 'edit', toolUseId: 'e1', name: 'Edit', input: { file_path: 'src/App.tsx' } })
    ])

    const tools = turn.tools
    expect(tools[0]).toMatchObject({ callKindLabel: '工具', callTitle: 'Read', callInstructionLabel: '文件', callInstructionText: 'src/App.tsx' })
    expect(tools[1]).toMatchObject({ callKindLabel: '工具', callTitle: 'Write', callInstructionLabel: '文件', callInstructionText: 'tmp/out.txt' })
    expect(tools[2]).toMatchObject({ callKindLabel: '工具', callTitle: 'Edit', callInstructionLabel: '文件', callInstructionText: 'src/App.tsx' })
  })

  it('labels MCP tool calls as MCP and exposes the resolved mcp server / tool name as the title', () => {
    const [turn] = buildAiTurnViewModel([
      event('tool_use', {
        id: 'mcp',
        toolUseId: 'mcp-1',
        name: 'mcp__context7__query-docs',
        input: { libraryId: '/vercel/next.js', query: 'routing' }
      }),
      event('tool_result', { id: 'mcp-res', toolUseId: 'mcp-1', content: 'docs', isError: false })
    ])

    const [tool] = turn.tools
    expect(tool.callKindLabel).toBe('MCP')
    expect(tool.callTitle).toBe('context7 / query-docs')
    expect(tool.callInstructionLabel).toBe('参数')
    expect(tool.callInstructionText).toBe('/vercel/next.js')
  })

  it('uses a strong result summary for failed tool calls', () => {
    const [turn] = buildAiTurnViewModel([
      event('tool_use', { id: 'bash', toolUseId: 'b1', name: 'Bash', input: { command: 'npm run missing' } }),
      event('tool_result', { id: 'b1-res', toolUseId: 'b1', content: 'script missing', isError: true, errorKind: 'tool_error' })
    ])

    expect(turn.tools[0].resultSummary).toBe('script missing')
    expect(turn.tools[0].status).toBe('error')
  })

  it('does not fabricate an instruction for orphan tool results without a paired tool_use', () => {
    const [turn] = buildAiTurnViewModel([
      event('tool_result', { id: 'orphan', toolUseId: 'missing', content: 'late result', isError: false })
    ])

    const [tool] = turn.tools
    expect(tool.isOrphan).toBe(true)
    expect(tool.callTitle).toBe('未匹配调用')
    expect(tool.callInstructionText).toBeUndefined()
    expect(tool.callInstructionLabel).toBeUndefined()
    expect(tool.resultSummary).toBe('late result')
  })
})
