import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionAiEvent, SlashCommandSuggestion } from '../types/workerDesk'
import { AiSessionPane } from './AiSessionPane'

const session: Session = {
  id: 'session-1',
  projectId: 'project-1',
  workerType: 'claude-code',
  interactionMode: 'headless',
  status: 'waiting',
  title: 'Project / Claude',
  createdAt: '2026-05-29T00:00:00.000Z',
  lastActivityAt: '2026-05-29T00:00:00.000Z',
  outputRef: 'jsonl:session-1'
}

const event = (type: SessionAiEvent['type'], extra: Partial<SessionAiEvent> = {}): SessionAiEvent => ({
  id: `${type}-1`,
  sessionId: 'session-1',
  timestamp: '2026-05-29T00:00:00.000Z',
  source: 'desk',
  type,
  ...extra
} as SessionAiEvent)

const slashSuggestion = (displayText: string, extra: Partial<SlashCommandSuggestion> = {}): SlashCommandSuggestion => ({
  id: `project-command:${displayText}`,
  displayText,
  insertText: `${displayText} `,
  title: displayText,
  description: `${displayText} description`,
  kind: 'project-command',
  scopeLabel: '当前项目',
  groupLabel: '当前项目 Commands',
  confidence: 'file-backed',
  priority: 0,
  executionMode: 'headless-message',
  ...extra
})

describe('AiSessionPane', () => {
  beforeEach(() => {
    window.localStorage.removeItem('ai-worker-message-stream-zoom-factor')
  })

  it('zooms only the message stream with Ctrl plus mouse wheel', async () => {
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('user_message', { id: 'user-1', text: '问题' }),
          event('assistant_text', { id: 'assistant-1', text: '回答', messageId: 'message-1' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    const stream = container.querySelector('.ai-event-stream') as HTMLElement
    const composer = container.querySelector('.ai-composer') as HTMLElement
    const pane = container.querySelector('.ai-session-pane') as HTMLElement
    expect(container.querySelector('.ai-session-header')).toBeNull()
    expect(stream).toHaveStyle({ '--message-stream-zoom-factor': '1' })

    fireEvent.wheel(composer, { ctrlKey: true, deltaY: -120 })

    expect(stream).toHaveStyle({ '--message-stream-zoom-factor': '1' })
    expect(window.localStorage.getItem('ai-worker-message-stream-zoom-factor')).toBe('1')

    fireEvent.wheel(stream, { ctrlKey: true, deltaY: -120 })

    await waitFor(() => expect(stream).toHaveStyle({ '--message-stream-zoom-factor': '1.05' }))
    expect(window.localStorage.getItem('ai-worker-message-stream-zoom-factor')).toBe('1.05')
    expect(composer).not.toHaveStyle({ '--message-stream-zoom-factor': '1.05' })
    expect(pane).not.toHaveStyle({ '--message-stream-zoom-factor': '1.05' })

    fireEvent.wheel(stream, { ctrlKey: true, deltaY: 120 })

    await waitFor(() => expect(stream).toHaveStyle({ '--message-stream-zoom-factor': '1' }))
    expect(window.localStorage.getItem('ai-worker-message-stream-zoom-factor')).toBe('1')
  })

  it('clamps invalid and extreme persisted message stream zoom factors to readable bounds', () => {
    window.localStorage.setItem('ai-worker-message-stream-zoom-factor', '5')
    const { container } = render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={() => undefined} />)

    const stream = container.querySelector('.ai-event-stream') as HTMLElement
    expect(stream).toHaveStyle({ '--message-stream-zoom-factor': '1.4' })
    expect(window.localStorage.getItem('ai-worker-message-stream-zoom-factor')).toBe('1.4')
  })

  it('renders lightweight Markdown in assistant output without changing user input or tool evidence', () => {
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('user_message', { id: 'user-1', text: '给我生成一段代码' }),
          event('assistant_text', {
            id: 'assistant-1',
            text: '你想生成什么样的代码？\n\n- **语言**：Python、JavaScript\n- **用途**：工具脚本、网页\n\n可以用 `npm run test` 验证。\n\n```js\nconst value = "**keep**"\n```',
            messageId: 'message-1'
          }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Bash', input: { command: 'printf "**not markdown**"' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: '**not markdown**', isError: false })
        ]}
        onSendMessage={() => undefined}
      />
    )

    const assistantBlock = container.querySelector('[data-block-kind="assistant"]') as HTMLElement
    const userBlock = container.querySelector('[data-block-kind="question"]') as HTMLElement

    expect(userBlock).toHaveTextContent('给我生成一段代码')
    expect(assistantBlock.querySelector('strong')).toHaveTextContent('语言')
    expect(assistantBlock.querySelectorAll('li')).toHaveLength(2)
    expect(assistantBlock.querySelector('code')).toHaveTextContent('npm run test')
    expect(assistantBlock.querySelector('pre code')).toHaveTextContent('const value = "**keep**"')
    expect(assistantBlock).not.toHaveTextContent('**语言**')

    fireEvent.click(screen.getByRole('button', { name: '展开执行过程：1 项' }))

    const executionBlock = container.querySelector('[data-block-kind="execution"]') as HTMLElement
    expect(executionBlock).toHaveTextContent('命令：printf "**not markdown**"')
    expect(executionBlock).toHaveTextContent('结果：**not markdown**')
    expect(executionBlock.querySelector('strong')).toHaveTextContent('Bash')
  })

  it('renders concrete Markdown polish examples used by Claude Code output', () => {
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('assistant_text', {
            id: 'assistant-1',
            messageId: 'message-1',
            text: [
              '## 修复方案',
              '',
              '1. 先读取规则',
              '2. 再修改组件',
              '',
              '> 注意：这个 Session 已停止，不能继续输入。',
              '',
              '| 项目 | 结果 |',
              '|---|---|',
              '| lint | 通过 |',
              '| test | 通过 |',
              '',
              '查看 [Claude Code 文档](https://docs.anthropic.com/claude-code) 或 https://example.com/docs。'
            ].join('\n')
          })
        ]}
        onSendMessage={() => undefined}
      />
    )

    const assistantBlock = container.querySelector('[data-block-kind="assistant"]') as HTMLElement
    expect(assistantBlock.querySelector('h2')).toHaveTextContent('修复方案')
    expect(assistantBlock).not.toHaveTextContent('## 修复方案')
    expect(assistantBlock.querySelectorAll('ol li')).toHaveLength(2)
    expect(assistantBlock.querySelector('blockquote')).toHaveTextContent('注意：这个 Session 已停止，不能继续输入。')
    const tableRows = assistantBlock.querySelectorAll('table tr')
    expect(tableRows).toHaveLength(3)
    expect(tableRows[0]).toHaveTextContent('项目')
    expect(tableRows[1]).toHaveTextContent('lint')
    expect(tableRows[2]).toHaveTextContent('test')
    expect(assistantBlock.querySelector('a[href="https://docs.anthropic.com/claude-code"]')).toHaveTextContent('Claude Code 文档')
    expect(assistantBlock.querySelector('a[href="https://example.com/docs"]')).toHaveTextContent('https://example.com/docs')
  })

  it('keeps Markdown markers literal in user input and failed tool details', () => {
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('user_message', { id: 'user-1', text: '**不要渲染我的输入**' }),
          event('assistant_text', { id: 'assistant-1', text: '**可以渲染 AI 正文**', messageId: 'message-1' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Bash', input: { command: 'echo "**keep raw**"' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: '**keep raw**', isError: true, errorKind: 'tool_error' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    const userBlock = container.querySelector('[data-block-kind="question"]') as HTMLElement
    const assistantBlock = container.querySelector('[data-block-kind="assistant"]') as HTMLElement

    expect(userBlock).toHaveTextContent('**不要渲染我的输入**')
    expect(userBlock.querySelector('strong')).toBeNull()
    expect(assistantBlock.querySelector('strong')).toHaveTextContent('可以渲染 AI 正文')

    fireEvent.click(screen.getByRole('button', { name: '展开执行过程：1 项，1 项失败' }))

    const executionBlock = container.querySelector('[data-block-kind="execution"]') as HTMLElement
    expect(executionBlock).toHaveTextContent('结果：**keep raw**')
    expect(executionBlock.querySelectorAll('strong')).toHaveLength(1)
    expect(executionBlock.querySelector('strong')).toHaveTextContent('Bash')
  })

  it('does not render a separate right-side header for the current task identity', () => {
    render(
      <AiSessionPane
        selectedSession={{ ...session, interactionMode: 'native-jsonl', status: 'running', taskTitle: '运行测试' }}
        events={[
          event('user_message', { id: 'user-1', text: 'run tests' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Bash', input: { command: 'npm run test' } })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.queryByText('任务：运行测试')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('当前会话现场摘要')).not.toBeInTheDocument()
    expect(screen.queryByText('状态：运行中')).not.toBeInTheDocument()
    expect(screen.queryByText('现场：正在运行工具：Bash')).not.toBeInTheDocument()
    expect(screen.queryByText('当前状态')).not.toBeInTheDocument()
    expect(screen.queryByText('工具')).not.toBeInTheDocument()
    expect(screen.queryByText(/聊天|Terminal shell|健康分|评分|AI 推荐指数|DAG|工作流/)).not.toBeInTheDocument()
  })

  it('does not promote tool failures into a duplicate right-side header summary', () => {
    render(
      <AiSessionPane
        selectedSession={{ ...session, interactionMode: 'native-jsonl', status: 'running' }}
        events={[
          event('user_message', { id: 'user-1', text: 'run tests' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Bash', input: { command: 'npm run test' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: 'exit 1', isError: true })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.queryByText('会话：Project / Claude')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('当前会话现场摘要')).not.toBeInTheDocument()
    expect(screen.queryByText('工具失败')).not.toBeInTheDocument()
    expect(screen.queryByText('当前状态')).not.toBeInTheDocument()
  })

  it('keeps recovered tool failure state out of the right-side header', () => {
    render(
      <AiSessionPane
        selectedSession={{ ...session, interactionMode: 'native-jsonl', status: 'waiting' }}
        events={[
          event('user_message', { id: 'user-1', text: 'look' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Bash', input: { command: 'wrong' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: 'fail', isError: true, errorKind: 'tool_error' }),
          event('tool_use', { id: 'tool-use-2', toolUseId: 'tool-2', name: 'Bash', input: { command: 'right' } }),
          event('tool_result', { id: 'tool-result-2', toolUseId: 'tool-2', content: 'ok', isError: false }),
          event('assistant_text', { id: 'assistant-1', text: '好了', messageId: 'msg-1' }),
          event('result', { id: 'result-1', status: 'success', text: '好了' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.queryByLabelText('当前会话现场摘要')).not.toBeInTheDocument()
    expect(screen.queryByText('工具失败')).not.toBeInTheDocument()
    expect(screen.queryByText('状态：等待输入')).not.toBeInTheDocument()
  })

  it('leaves task identity to the outer current-session tab when a task name is present', () => {
    render(<AiSessionPane selectedSession={{ ...session, taskTitle: '修复右栏状态条' }} events={[]} onSendMessage={() => undefined} />)

    expect(screen.queryByText('任务：修复右栏状态条')).not.toBeInTheDocument()
    expect(screen.queryByText('项目 / 会话：Project / Claude')).not.toBeInTheDocument()
    expect(screen.queryByText('状态：等待输入')).not.toBeInTheDocument()
  })

  it('does not render a separate fallback session-title header', () => {
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={() => undefined} />)

    expect(screen.queryByText('会话：Project / Claude')).not.toBeInTheDocument()
    expect(screen.queryByText('状态：等待输入')).not.toBeInTheDocument()
  })

  it('keeps task identity out of the AI pane header area', () => {
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={() => undefined} />)

    expect(screen.queryByText('会话：Project / Claude')).not.toBeInTheDocument()
    expect(screen.queryByText(/右侧把关/)).not.toBeInTheDocument()
    expect(screen.queryByText(/现场：/)).not.toBeInTheDocument()
  })

  it('renders a local readable block flow with plain question and answer text plus collapsed execution process', () => {
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('user_message', { id: 'user-1', text: '读取 package 名称' }),
          event('assistant_text', { id: 'assistant-1', text: '我先读取文件。', messageId: 'message-1' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: '{ "name": "ai-worker-control-desk" }', isError: false }),
          event('turn_end', { id: 'turn-end-1', reason: 'end_turn', cliSessionId: 'cli-session-1' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    const blocks = Array.from(container.querySelectorAll('.ai-readable-block'))
    expect(blocks.map((block) => block.getAttribute('data-block-kind'))).toEqual(['question', 'assistant', 'execution'])
    expect(blocks[0]).toHaveTextContent('读取 package 名称')
    expect(blocks[0]).not.toHaveTextContent('你问')
    expect(blocks[1]).toHaveTextContent('我先读取文件。')
    expect(blocks[1]).not.toHaveTextContent('AI 输出')
    expect(blocks[2]).toHaveTextContent('执行过程 · 1 项')
    expect(screen.queryByText('工具活动')).not.toBeInTheDocument()
    expect(screen.queryByText('Read')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '展开执行过程：1 项' }))

    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByText('文件：')).toBeInTheDocument()
    expect(screen.getByText('package.json')).toBeInTheDocument()
    expect(screen.queryByText('成功')).not.toBeInTheDocument()
  })

  it('renders permission blockers as readable exception blocks', () => {
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('result', {
            id: 'result-1',
            status: 'success',
            text: 'done',
            permissionDenials: [{ toolName: 'Read', toolUseId: 'tool-1', toolInput: { file_path: 'secret.txt' } }]
          })
        ]}
        onSendMessage={() => undefined}
      />
    )

    const blocks = Array.from(container.querySelectorAll('.ai-readable-block'))
    expect(blocks.map((block) => block.getAttribute('data-block-kind'))).toEqual(['permission-takeover', 'permission-blocker'])
    expect(blocks[0]).toHaveTextContent('需要接管')
    expect(blocks[1]).toHaveTextContent('权限拒绝：Read · secret.txt')
  })

  it('treats a recovered tool failure as a normal completed turn, not a red work record', () => {
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('user_message', { id: 'user-1', text: '帮我看看我桌面有什么？' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Bash', input: { command: 'dir "C:\\Users\\Example\\Desktop" /B' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: 'No such file or directory', isError: true, errorKind: 'tool_error' }),
          event('tool_use', { id: 'tool-use-2', toolUseId: 'tool-2', name: 'Bash', input: { command: 'ls -la "C:/Users/Example/Desktop/"' } }),
          event('tool_result', { id: 'tool-result-2', toolUseId: 'tool-2', content: 'total 50', isError: false }),
          event('assistant_text', { id: 'assistant-1', text: '你桌面很清爽。', messageId: 'msg-1' }),
          event('result', { id: 'result-1', status: 'success', text: '你桌面很清爽。' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    const blocks = Array.from(container.querySelectorAll('.ai-readable-block'))
    const blockKinds = blocks.map((block) => block.getAttribute('data-block-kind'))
    expect(blockKinds).not.toContain('status')
    expect(blocks[0]).toHaveTextContent('帮我看看我桌面有什么？')
    expect(blocks.find((block) => block.getAttribute('data-block-kind') === 'execution')).toHaveTextContent('执行过程 · 2 项')
    expect(screen.queryByText('本轮遇到权限阻塞。')).not.toBeInTheDocument()
    expect(screen.queryByText('可继续输入。')).not.toBeInTheDocument()
    expect(screen.queryByText('工具已完成，等待 AI 总结。')).not.toBeInTheDocument()
    expect(screen.queryByText('失败 · 可继续输入。')).not.toBeInTheDocument()
  })

  it('hides the redundant completion status block on every quiet greeting turn', () => {
    render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('user_message', { id: 'user-1', text: '你好呀' }),
          event('assistant_text', { id: 'assistant-1', text: '你好！' }),
          event('result', { id: 'result-1', status: 'success', text: '你好！' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.queryByText('可继续输入。')).not.toBeInTheDocument()
    expect(screen.queryByText('已完成')).not.toBeInTheDocument()
    expect(screen.queryByText('本轮已完成。')).not.toBeInTheDocument()
  })

  it('keeps the workbench summary status quiet when a tool failure was recovered', () => {
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('user_message', { id: 'user-1', text: 'look' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Bash', input: { command: 'wrong' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: 'fail', isError: true, errorKind: 'tool_error' }),
          event('tool_use', { id: 'tool-use-2', toolUseId: 'tool-2', name: 'Bash', input: { command: 'right' } }),
          event('tool_result', { id: 'tool-result-2', toolUseId: 'tool-2', content: 'ok', isError: false }),
          event('assistant_text', { id: 'assistant-1', text: '好了', messageId: 'msg-1' }),
          event('result', { id: 'result-1', status: 'success', text: '好了' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.queryByLabelText('当前会话现场摘要')).not.toBeInTheDocument()
    expect(screen.queryByText('工具失败')).not.toBeInTheDocument()
    expect(container.querySelector('.ai-readable-block[data-block-kind="status"]')).toBeNull()
  })

  it('renders a greeting as one work record without repeating completion text', () => {
    render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('user_message', { id: 'user-1', text: '你好呀' }),
          event('assistant_text', { id: 'assistant-1', text: '你好！很高兴见到你！有什么我可以帮助你的吗？' }),
          event('result', { id: 'result-1', status: 'success', text: '你好！很高兴见到你！有什么我可以帮助你的吗？' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.queryByText('你问')).not.toBeInTheDocument()
    expect(screen.getByText('你好呀')).toBeInTheDocument()
    expect(screen.queryByText('本轮输入')).not.toBeInTheDocument()
    expect(screen.queryByText('AI 输出')).not.toBeInTheDocument()
    expect(screen.getByText('你好！很高兴见到你！有什么我可以帮助你的吗？')).toBeInTheDocument()
  })

  it('renders permission-denied tool results as a takeover blocker', () => {
    render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('tool_use', {
            id: 'tool-use-1',
            toolUseId: 'tool-1',
            name: 'Read',
            input: { file_path: 'C:/temp/note.txt' }
          }),
          event('tool_result', {
            id: 'tool-result-1',
            toolUseId: 'tool-1',
            content: "Claude requested permissions to read from C:\\temp\\note.txt, but you haven't granted it yet.",
            isError: true,
            errorKind: 'permission_denied'
          }),
          event('result', {
            id: 'result-1',
            status: 'success',
            text: 'done',
            permissionDenials: [{ toolName: 'Read', toolUseId: 'tool-1', toolInput: { file_path: 'C:/temp/note.txt' } }]
          })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.getByText('执行过程 · 1 项 · 1 项需要接管')).toBeInTheDocument()
    expect(screen.queryByText('权限未授予')).not.toBeInTheDocument()
    expect(screen.queryByText('状态：权限阻塞')).not.toBeInTheDocument()
    expect(screen.getByText('需要接管')).toBeInTheDocument()
    expect(screen.getByText('Claude Code 的权限请求没有被授予。请先处理权限，或在下方输入替代做法继续。')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('权限阻塞：可处理权限后继续，或输入替代做法')).not.toBeDisabled()
    expect(screen.queryByText('本轮遇到权限阻塞。')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开执行过程：1 项，1 项需要接管' }))
    expect(screen.getByText('权限未授予')).toBeInTheDocument()
    expect(screen.getByText(/haven't granted/)).toBeInTheDocument()
    expect(screen.getByText(/权限拒绝：Read · C:\/temp\/note\.txt/)).toBeInTheDocument()
  })

  it('shows permission denial summaries as a work-record status', () => {
    render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('result', {
            status: 'success',
            text: 'done',
            permissionDenials: [{ toolName: 'Read', toolUseId: 'tool-1' }]
          })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.getByText(/权限拒绝：Read/)).toBeInTheDocument()
  })

  it('keeps composer available for an alternative after a permission blocker', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('result', {
            status: 'success',
            text: 'done',
            permissionDenials: [{ toolName: 'Read', toolUseId: 'tool-1' }]
          })
        ]}
        onSendMessage={onSendMessage}
      />
    )
    const composer = screen.getByPlaceholderText('权限阻塞：可处理权限后继续，或输入替代做法')

    fireEvent.change(composer, { target: { value: '不用读取该文件，改用当前上下文继续' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', '不用读取该文件，改用当前上下文继续'))
  })

  it('merges adjacent assistant text and attaches tool results to a work record', () => {
    render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('assistant_text', { id: 'assistant-1', text: 'hello ', messageId: 'msg-1' }),
          event('assistant_text', { id: 'assistant-2', text: 'world', messageId: 'msg-1' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Bash', input: { command: 'pwd' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: '/tmp/project', isError: false })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.queryByText('AI 输出')).not.toBeInTheDocument()
    expect(screen.getByText('hello world')).toBeInTheDocument()
    expect(screen.queryByText('工具活动')).not.toBeInTheDocument()
    expect(screen.queryByText('Worker 动作')).not.toBeInTheDocument()
    expect(screen.getByText('执行过程 · 1 项')).toBeInTheDocument()
    expect(screen.queryByText('Bash')).not.toBeInTheDocument()
    expect(screen.queryByText('成功')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开执行过程：1 项' }))
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('命令：')).toBeInTheDocument()
    expect(screen.getByText('pwd')).toBeInTheDocument()
    expect(screen.queryByText('成功')).not.toBeInTheDocument()
    expect(screen.queryByText('完整参数')).not.toBeInTheDocument()
    expect(screen.getByText('结果：')).toBeInTheDocument()
    expect(screen.getByText('/tmp/project')).toBeInTheDocument()
  })

  it('shows a lightweight transition after native-jsonl tools finish before the AI summary arrives', () => {
    render(
      <AiSessionPane
        selectedSession={{ ...session, interactionMode: 'native-jsonl', status: 'running' }}
        events={[
          event('user_message', { id: 'user-1', text: '读取 package 名称' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: '{ "name": "ai-worker-control-desk" }', isError: false })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.getByText('执行过程 · 1 项')).toBeInTheDocument()
    expect(screen.queryByText('工具活动')).not.toBeInTheDocument()
    expect(screen.queryByText('Read · 读取 package.json')).not.toBeInTheDocument()
    expect(screen.queryByText('处理中')).not.toBeInTheDocument()
    expect(screen.getByText('工具已完成，等待 AI 总结。')).toBeInTheDocument()
    expect(screen.queryByText('已发送，等待 AI 开始处理。')).not.toBeInTheDocument()
  })

  it('keeps non-native-jsonl finished-tool transitions quiet', () => {
    render(
      <AiSessionPane
        selectedSession={{ ...session, status: 'running' }}
        events={[
          event('user_message', { id: 'user-1', text: '读取 package 名称' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: '{ "name": "ai-worker-control-desk" }', isError: false })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.queryByText('工具已完成，等待 AI 总结。')).not.toBeInTheDocument()
  })

  it('enables sending after a native-jsonl turn_end completes the running turn', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(
      <AiSessionPane
        selectedSession={{ ...session, interactionMode: 'native-jsonl', status: 'running' }}
        events={[
          event('user_message', { id: 'user-1', text: '读取 package 名称' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: '{ "name": "ai-worker-control-desk" }', isError: false }),
          event('assistant_text', { id: 'assistant-1', text: '包名是 ai-worker-control-desk。', messageId: 'message-1' }),
          event('turn_end', { id: 'turn-end-1', reason: 'end_turn', cliSessionId: 'cli-session-1' })
        ]}
        onSendMessage={onSendMessage}
      />
    )
    const composer = screen.getByPlaceholderText(/输入给原生 Claude Code/) as HTMLTextAreaElement

    expect(screen.queryByText('工具已完成，等待 AI 总结。')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    fireEvent.change(composer, { target: { value: '继续下一步' } })
    expect(screen.getByRole('button', { name: '发送' })).not.toBeDisabled()
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', '继续下一步'))
  })

  it('keeps sending disabled for native-jsonl while tools finished but no turn_end arrived', () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(
      <AiSessionPane
        selectedSession={{ ...session, interactionMode: 'native-jsonl', status: 'running' }}
        events={[
          event('user_message', { id: 'user-1', text: '读取 package 名称' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: '{ "name": "ai-worker-control-desk" }', isError: false })
        ]}
        onSendMessage={onSendMessage}
      />
    )
    const composer = screen.getByPlaceholderText(/输入给原生 Claude Code/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '继续下一步' } })

    expect(screen.getByText('工具已完成，等待 AI 总结。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(onSendMessage).not.toHaveBeenCalled()
  })

  it('renders multiple permission denials without treating them as normal completion', () => {
    render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('result', {
            id: 'result-1',
            status: 'success',
            text: 'done',
            permissionDenials: [
              { toolName: 'Read', toolUseId: 'read-1', toolInput: { file_path: 'secret.txt' } },
              { toolName: 'Bash', toolUseId: 'bash-1', toolInput: { command: 'rm temp.txt' } }
            ]
          })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.getByText('需要接管')).toBeInTheDocument()
    expect(screen.getByText('接管阻塞')).toBeInTheDocument()
    expect(screen.queryByText(/权限拒绝：Read · secret\.txt、Bash · rm temp\.txt/)).toBeInTheDocument()
    expect(screen.queryByText('本轮遇到权限阻塞。')).not.toBeInTheDocument()
    expect(screen.queryByText('可继续输入。')).not.toBeInTheDocument()
  })

  it('renders error diagnostics directly and folds non-error diagnostics', () => {
    render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('diagnostic', { id: 'diagnostic-error', level: 'error', message: 'Unhandled Claude stream-json event type: plugin' }),
          event('diagnostic', { id: 'diagnostic-info', level: 'info', message: 'parser info' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.getByText('Unhandled Claude stream-json event type: plugin')).toBeInTheDocument()
    expect(screen.getByText('诊断详情')).toBeInTheDocument()
  })

  it('shows tool errors as failures rather than permission blockers', () => {
    render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Bash', input: { command: 'npm run missing' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: 'script missing', isError: true, errorKind: 'tool_error' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.getByText('执行过程 · 1 项 · 1 项失败')).toBeInTheDocument()
    expect(screen.queryByText('Bash')).not.toBeInTheDocument()
    expect(screen.queryByText('script missing')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开执行过程：1 项，1 项失败' }))
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('命令：')).toBeInTheDocument()
    expect(screen.getByText('npm run missing')).toBeInTheDocument()
    expect(screen.getByText('script missing')).toBeInTheDocument()
    expect(screen.queryByText('需要接管')).not.toBeInTheDocument()
  })

  it('shows status-aware empty states', () => {
    const { rerender } = render(<AiSessionPane selectedSession={{ ...session, status: 'starting' }} events={[]} onSendMessage={() => undefined} />)

    expect(screen.getByText('Session 正在启动，等待 Claude Code 初始化。')).toBeInTheDocument()

    rerender(<AiSessionPane selectedSession={{ ...session, status: 'running' }} events={[]} onSendMessage={() => undefined} />)

    expect(screen.getByText('Claude Code 已连接，等待输入。')).toBeInTheDocument()
    expect(screen.queryByText('AI 正在运行，等待结构化输出。')).not.toBeInTheDocument()
  })

  it('does not force scroll to bottom while reviewing older events', async () => {
    const { rerender } = render(
      <AiSessionPane
        selectedSession={session}
        events={[event('assistant_text', { id: 'assistant-1', text: 'old' })]}
        onSendMessage={() => undefined}
      />
    )
    const stream = screen.getByText('old').closest('.ai-event-stream') as HTMLDivElement
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(stream, 'clientHeight', { configurable: true, value: 200 })
    stream.scrollTop = 100
    fireEvent.scroll(stream)

    rerender(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('assistant_text', { id: 'assistant-1', text: 'old' }),
          event('assistant_text', { id: 'assistant-2', text: 'new' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(stream.scrollTop).toBe(100)
    expect(screen.getByRole('button', { name: '有新内容' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '有新内容' }))
    await waitFor(() => expect(stream.scrollTop).toBe(1000))
  })

  it('collapses and expands long tool results', () => {
    const longText = `${'a'.repeat(1300)}tail`
    render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Read' }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: longText, isError: false })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.queryByText(/tail/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开执行过程：1 项' }))
    fireEvent.click(screen.getByRole('button', { name: '展开全部' }))
    expect(screen.getByText(/tail/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '收起结果' })).toBeInTheDocument()
  })

  it('folds non-error diagnostics and weakens successful completion', () => {
    render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('diagnostic', { id: 'diagnostic-1', level: 'warning', message: 'parser warning' }),
          event('result', { id: 'result-1', status: 'success', text: 'done' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.getByText('警告详情')).toBeInTheDocument()
    expect(screen.queryByText('已完成')).not.toBeInTheDocument()
    expect(screen.queryByText('可继续输入。')).not.toBeInTheDocument()
  })

  it('keeps long output inside the scrollable event stream', () => {
    const longText = Array.from({ length: 80 }, (_, index) => `line-${index}`).join('\n')
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('user_message', { id: 'user-1', text: 'write long output' }),
          event('assistant_text', { id: 'assistant-1', text: longText }),
          event('result', { id: 'result-1', status: 'success', text: longText })
        ]}
        onSendMessage={() => undefined}
      />
    )

    const pane = container.querySelector('.ai-session-pane') as HTMLElement
    const body = container.querySelector('.ai-session-body') as HTMLElement
    const stream = container.querySelector('.ai-event-stream') as HTMLElement
    const composer = container.querySelector('.ai-composer') as HTMLElement

    expect(pane).toBeInTheDocument()
    expect(body).toBeInTheDocument()
    expect(stream).toBeInTheDocument()
    expect(composer).toBeInTheDocument()
    expect(stream).toHaveClass('scroll-container')
    expect(stream).toContainElement(screen.getByText(/line-79/))
    expect(composer).toContainElement(screen.getByRole('button', { name: '发送' }))
  })

  it('does not create navigation anchors for ordinary system-only events', () => {
    render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('assistant_text', { id: 'assistant-1', text: 'background note' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: 'ok', isError: false }),
          event('diagnostic', { id: 'diagnostic-info', level: 'info', message: 'parser info' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.queryByLabelText('工作记录导航')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /跳转到工作记录/ })).not.toBeInTheDocument()
  })

  it('keeps question navigation anchors for every user question', () => {
    render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('user_message', { id: 'user-1', text: 'first task' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: 'ok', isError: false }),
          event('user_message', { id: 'user-2', text: 'second task' }),
          event('assistant_text', { id: 'assistant-2', text: 'second result' }),
          event('result', { id: 'result-2', status: 'success', text: 'second result' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.getByRole('button', { name: '跳转到工作记录 1：first task' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '跳转到工作记录 2：second task' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Read|ok|second result/ })).not.toBeInTheDocument()
  })

  it('keeps special navigation anchors for permission blockers without a user question', () => {
    render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('result', {
            id: 'result-1',
            status: 'success',
            text: 'done',
            permissionDenials: [{ toolName: 'Read', toolUseId: 'tool-1' }]
          })
        ]}
        onSendMessage={() => undefined}
      />
    )

    const anchor = screen.getByRole('button', { name: /跳转到工作记录 1：需要接管/ })
    expect(anchor).toHaveAttribute('data-status', 'permission_denied')
  })

  it('renders work-record navigation anchors, scrolls to the selected turn, and highlights the selected question', () => {
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('user_message', { id: 'user-1', text: 'first task' }),
          event('assistant_text', { id: 'assistant-1', text: 'first result' }),
          event('result', { id: 'result-1', status: 'success', text: 'first result' }),
          event('user_message', { id: 'user-2', text: 'second task' }),
          event('assistant_text', { id: 'assistant-2', text: 'second result' }),
          event('result', { id: 'result-2', status: 'success', text: 'second result' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    const stream = container.querySelector('.ai-event-stream') as HTMLElement
    const turns = container.querySelectorAll('.ai-turn-record')
    Object.defineProperty(stream, 'offsetTop', { configurable: true, value: 20 })
    Object.defineProperty(turns[1], 'offsetTop', { configurable: true, value: 420 })

    expect(screen.getByLabelText('工作记录导航')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '跳转到工作记录 1：first task' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '跳转到工作记录 2：second task' }))

    expect(stream.scrollTop).toBe(400)
    expect(screen.getByText('second task').closest('.ai-readable-block')).toHaveAttribute('data-block-kind', 'question')
    expect(screen.getByText('second task').closest('.ai-readable-block')).toHaveClass('is-locating')
    expect(screen.getByText('first task').closest('.ai-readable-block')).not.toHaveClass('is-locating')
  })

  it('highlights the takeover block from a special navigation anchor without a user question', () => {
    render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('result', {
            id: 'result-1',
            status: 'success',
            text: 'done',
            permissionDenials: [{ toolName: 'Read', toolUseId: 'tool-1' }]
          })
        ]}
        onSendMessage={() => undefined}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /跳转到工作记录 1：需要接管/ }))

    expect(screen.getByText('Claude Code 的权限请求没有被授予。请先处理权限，或在下方输入替代做法继续。').closest('.ai-readable-block')).toHaveAttribute('data-block-kind', 'permission-takeover')
    expect(screen.getByText('Claude Code 的权限请求没有被授予。请先处理权限，或在下方输入替代做法继续。').closest('.ai-readable-block')).toHaveClass('is-locating')
  })

  it('keeps navigation rail visible next to long scrollable output', () => {
    const longText = Array.from({ length: 80 }, (_, index) => `line-${index}`).join('\n')
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('user_message', { id: 'user-1', text: 'write long output' }),
          event('assistant_text', { id: 'assistant-1', text: longText }),
          event('result', { id: 'result-1', status: 'success', text: longText })
        ]}
        onSendMessage={() => undefined}
      />
    )

    const workspace = container.querySelector('.ai-session-workspace') as HTMLElement
    const stream = container.querySelector('.ai-event-stream') as HTMLElement
    const rail = screen.getByLabelText('工作记录导航')
    const composer = container.querySelector('.ai-composer') as HTMLElement

    expect(workspace).toContainElement(stream)
    expect(workspace).toContainElement(rail)
    expect(stream).toHaveClass('scroll-container')
    expect(screen.getByRole('button', { name: '跳转到工作记录 1：write long output' })).toBeInTheDocument()
    expect(composer).toContainElement(screen.getByRole('button', { name: '发送' }))
  })

  it('shows a lightweight pending hint after sending before AI output starts', () => {
    render(<AiSessionPane selectedSession={session} events={[]} isSending onSendMessage={() => undefined} />)

    expect(screen.getByText('已发送，等待 AI 开始处理。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送中' })).toBeDisabled()
  })

  it('keeps the pending hint after the submitted user message is recorded', () => {
    render(
      <AiSessionPane
        selectedSession={{ ...session, status: 'running' }}
        events={[event('user_message', { id: 'user-1', text: '开始处理这个任务' })]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.getByText('开始处理这个任务')).toBeInTheDocument()
    expect(screen.getByText('已发送，等待 AI 开始处理。')).toBeInTheDocument()
    expect(screen.queryByText('处理中')).not.toBeInTheDocument()
    expect(screen.queryByText('正在处理')).not.toBeInTheDocument()
  })

  it('sends composer text with Enter', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={onSendMessage} />)

    fireEvent.change(screen.getByPlaceholderText(/输入给 AI 的消息/), { target: { value: 'hello' } })
    fireEvent.keyDown(screen.getByPlaceholderText(/输入给 AI 的消息/), { key: 'Enter' })

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', 'hello'))
    await waitFor(() => expect(screen.getByPlaceholderText(/输入给 AI 的消息/)).toHaveValue(''))
  })

  it('routes Claude Code model slash commands to app model controls', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={onSendMessage} />)
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/model' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(onSendMessage).not.toHaveBeenCalled()
    expect(composer).toHaveValue('/model')
    expect(screen.getByText('模型切换请使用左侧“模型”区域或“管理模型”。新的 Claude Code Session 会使用你选好的模型。')).toBeInTheDocument()
  })

  it('offers same-session native takeover for selected switch-to-native slash assist items', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    const onListSlashCommandSuggestions = vi.fn().mockResolvedValue({
      items: [slashSuggestion('/plugin', {
        id: 'builtin-command:/plugin',
        kind: 'builtin-command',
        groupLabel: '当前 Claude Code 命令',
        scopeLabel: '当前安装',
        confidence: 'native-evidence',
        priority: 2,
        executionMode: 'native-interactive',
        description: 'Manage Claude Code plugins'
      })],
      sourceStatus: 'ready'
    })
    render(
      <AiSessionPane
        selectedSession={session}
        events={[]}
        onSendMessage={onSendMessage}
        onListSlashCommandSuggestions={onListSlashCommandSuggestions}
      />
    )
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/pl' } })
    await screen.findByText('/plugin')
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(composer).toHaveValue('/plugin '))
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(onSendMessage).not.toHaveBeenCalled()
    expect(screen.getByText('这项能力需要 Claude Code 原生界面。将切换当前 Session 到原生接管，不会新建会话。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '切换当前 Session' })).toBeInTheDocument()
  })

  it('routes /model to the app model controls instead of native takeover', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    const onSwitchToNativeTakeover = vi.fn().mockResolvedValue(true)
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={onSendMessage} onSwitchToNativeTakeover={onSwitchToNativeTakeover} />)
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/model' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(onSendMessage).not.toHaveBeenCalled()
    expect(onSwitchToNativeTakeover).not.toHaveBeenCalled()
    expect(composer).toHaveValue('/model')
    expect(screen.getByText('模型切换请使用左侧“模型”区域或“管理模型”。新的 Claude Code Session 会使用你选好的模型。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '去模型设置' })).toBeInTheDocument()
  })

  it('offers same-session native takeover for plugin and MCP commands that the app cannot manage', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    const onSwitchToNativeTakeover = vi.fn().mockResolvedValue(true)
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={onSendMessage} onSwitchToNativeTakeover={onSwitchToNativeTakeover} />)
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/plugin' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(screen.getByText('这项能力需要 Claude Code 原生界面。将切换当前 Session 到原生接管，不会新建会话。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '切换当前 Session' }))

    await waitFor(() => expect(onSwitchToNativeTakeover).toHaveBeenCalledWith(session, '/plugin'))
    expect(onSendMessage).not.toHaveBeenCalled()
    expect(screen.getByText('已切换当前 Session 到 Claude Code 原生接管。')).toBeInTheDocument()
  })

  it('offers same-session native takeover for other native commands', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={onSendMessage} />)
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/status' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(onSendMessage).not.toHaveBeenCalled()
    expect(composer).toHaveValue('/status')
    expect(screen.getByText('这项能力需要 Claude Code 原生界面。将切换当前 Session 到原生接管，不会新建会话。')).toBeInTheDocument()
  })

  it('allows send-to-session slash assist items to be sent as task messages', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={onSendMessage} />)
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/review' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', '/review'))
  })

  it('sends multiline task descriptions and code blocks without rewriting content', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={onSendMessage} />)
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement
    const text = '请检查下面 JSON：\n```json\n{"path":"src/a/b.ts","command":"npm run test"}\n```'

    fireEvent.change(composer, { target: { value: text } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', text))
  })

  it('groups builtin commands, project commands, and skills in one slash assist popover', async () => {
    const onListSlashCommandSuggestions = vi.fn().mockResolvedValue({
      items: [
        slashSuggestion('/review', { groupLabel: '当前项目 Commands', scopeLabel: '当前项目', executionMode: 'headless-message' }),
        slashSuggestion('/help', {
          id: 'builtin-command:/help',
          kind: 'builtin-command',
          groupLabel: '当前 Claude Code 命令',
          scopeLabel: '当前安装',
          confidence: 'native-evidence',
          priority: 2,
          executionMode: 'native-interactive',
          description: '查看 Claude Code 帮助'
        }),
        slashSuggestion('/test-driven-development', {
          id: 'user-skill:test-driven-development',
          displayText: '/test-driven-development',
          insertText: '/test-driven-development ',
          title: 'test-driven-development',
          kind: 'user-skill',
          groupLabel: 'Skills',
          scopeLabel: '用户 Skill',
          description: '测试驱动开发',
          executionMode: 'assist-only',
          behavior: 'send-to-session',
          category: 'skill',
          priority: 4
        })
      ],
      sourceStatus: 'ready'
    })
    render(
      <AiSessionPane
        selectedSession={session}
        events={[]}
        onSendMessage={() => undefined}
        onListSlashCommandSuggestions={onListSlashCommandSuggestions}
      />
    )
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/' } })

    expect(await screen.findByText('当前项目 Commands')).toBeInTheDocument()
    expect(screen.getByText('当前 Claude Code 命令')).toBeInTheDocument()
    expect(screen.getByText('Skills')).toBeInTheDocument()
    expect(screen.getByText('来自当前 Claude Code 安装证据；管理类命令会切到当前 Session 的 Claude Code 原生界面。')).toBeInTheDocument()
    expect(screen.getByText('Skills 会作为 /skill-name 发送到当前 Session；/skills 用于打开原生 Skills 列表。')).toBeInTheDocument()
    expect(screen.getByText('/review')).toBeInTheDocument()
    expect(screen.getByText('/help')).toBeInTheDocument()
    expect(screen.getByText('/test-driven-development')).toBeInTheDocument()
    expect(screen.getByText('发送到当前 Session')).toBeInTheDocument()
    expect(screen.getByText('当前 Session 原生接管')).toBeInTheDocument()
    expect(screen.getByText('发送 Skill')).toBeInTheDocument()
  })

  it('inserts skill assist text without sending when a skill item is selected', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    const onListSlashCommandSuggestions = vi.fn().mockResolvedValue({
      items: [slashSuggestion('/test-driven-development', {
        id: 'user-skill:test-driven-development',
        displayText: '/test-driven-development',
        insertText: '/test-driven-development ',
        title: 'test-driven-development',
        kind: 'user-skill',
        groupLabel: 'Skills',
        scopeLabel: '用户 Skill',
        description: '测试驱动开发',
        priority: 4
      })],
      sourceStatus: 'ready'
    })
    render(
      <AiSessionPane
        selectedSession={session}
        events={[]}
        onSendMessage={onSendMessage}
        onListSlashCommandSuggestions={onListSlashCommandSuggestions}
      />
    )
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/test' } })
    await screen.findByText('/test-driven-development')
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(composer).toHaveValue('/test-driven-development '))
    expect(onSendMessage).not.toHaveBeenCalled()
  })

  it('sends concrete skill slash entries to the current session', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    const onListSlashCommandSuggestions = vi.fn().mockResolvedValue({
      items: [slashSuggestion('/using-superpowers', {
        id: 'user-skill:using-superpowers',
        displayText: '/using-superpowers',
        insertText: '/using-superpowers ',
        title: 'using-superpowers',
        kind: 'user-skill',
        groupLabel: 'Skills',
        scopeLabel: '用户 Skill',
        description: 'Use Superpowers workflow',
        behavior: 'send-to-session',
        category: 'skill',
        priority: 4
      })],
      sourceStatus: 'ready'
    })
    render(
      <AiSessionPane
        selectedSession={session}
        events={[]}
        onSendMessage={onSendMessage}
        onListSlashCommandSuggestions={onListSlashCommandSuggestions}
      />
    )
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/using' } })
    expect(await screen.findByText('/using-superpowers')).toBeInTheDocument()
    expect(screen.getByText('发送 Skill')).toBeInTheDocument()
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(composer).toHaveValue('/using-superpowers '))
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', '/using-superpowers'))
  })

  it('switches the current session to native takeover for the /skills management command', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    const onSwitchToNativeTakeover = vi.fn().mockResolvedValue(true)
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={onSendMessage} onSwitchToNativeTakeover={onSwitchToNativeTakeover} />)
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/skills' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(screen.getByText('这项能力需要 Claude Code 原生界面。将切换当前 Session 到原生接管，不会新建会话。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '切换当前 Session' }))

    await waitFor(() => expect(onSwitchToNativeTakeover).toHaveBeenCalledWith(session, '/skills'))
    expect(onSendMessage).not.toHaveBeenCalled()
  })

  it('refreshes slash assist suggestions on demand', async () => {
    const onListSlashCommandSuggestions = vi.fn()
      .mockResolvedValueOnce({ items: [], sourceStatus: 'empty', message: '没有匹配项。' })
      .mockResolvedValueOnce({ items: [slashSuggestion('/help', { kind: 'builtin-command', groupLabel: '当前 Claude Code 命令', scopeLabel: '当前安装', confidence: 'native-evidence', priority: 2 })], sourceStatus: 'ready' })
    render(
      <AiSessionPane
        selectedSession={session}
        events={[]}
        onSendMessage={() => undefined}
        onListSlashCommandSuggestions={onListSlashCommandSuggestions}
      />
    )
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/missing' } })
    expect(await screen.findByText('没有匹配项。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '刷新能力' }))

    await waitFor(() => expect(onListSlashCommandSuggestions).toHaveBeenLastCalledWith({ projectId: 'project-1', query: 'missing', limit: 40, refresh: true }))
  })

  it('falls through to submit when slash assist has no matching item', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    const onListSlashCommandSuggestions = vi.fn().mockResolvedValue({
      items: [],
      sourceStatus: 'empty',
      message: '没有匹配项。可以继续输入普通任务消息。'
    })
    render(
      <AiSessionPane
        selectedSession={session}
        events={[]}
        onSendMessage={onSendMessage}
        onListSlashCommandSuggestions={onListSlashCommandSuggestions}
      />
    )
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/not-real' } })
    await screen.findByText('没有匹配项。可以继续输入普通任务消息。')
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', '/not-real'))
  })

  it('shows slash command discovery from real sources and inserts selection without sending', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    const onListSlashCommandSuggestions = vi.fn().mockResolvedValue({
      items: [
        slashSuggestion('/review', { description: 'Review current changes' }),
        slashSuggestion('/workflow/analyze', { description: 'Analyze workflow' })
      ],
      sourceStatus: 'ready'
    })
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[]}
        onSendMessage={onSendMessage}
        onListSlashCommandSuggestions={onListSlashCommandSuggestions}
      />
    )
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/' } })

    expect(await screen.findByRole('listbox', { name: 'Slash 命令能力发现' })).toBeInTheDocument()
    expect(container.querySelectorAll('.ai-slash-assist-popover')).toHaveLength(1)
    expect(screen.getByText('/review')).toBeInTheDocument()
    expect(screen.getByText('Review current changes')).toBeInTheDocument()
    expect(screen.getAllByText('当前项目')[0]).toBeInTheDocument()
    expect(onListSlashCommandSuggestions).toHaveBeenCalledWith({ projectId: 'project-1', query: '', limit: 40, refresh: false })

    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(composer).toHaveValue('/review '))
    await waitFor(() => expect(container.querySelector('.ai-slash-assist-popover')).not.toBeInTheDocument())
    expect(onSendMessage).not.toHaveBeenCalled()

    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', '/review'))
  })

  it('filters slash command discovery and supports keyboard navigation', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    const onListSlashCommandSuggestions = vi.fn().mockResolvedValue({
      items: [
        slashSuggestion('/review'),
        slashSuggestion('/refactor')
      ],
      sourceStatus: 'ready'
    })
    render(
      <AiSessionPane
        selectedSession={session}
        events={[]}
        onSendMessage={onSendMessage}
        onListSlashCommandSuggestions={onListSlashCommandSuggestions}
      />
    )
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/re' } })
    await screen.findByRole('listbox', { name: 'Slash 命令能力发现' })

    await waitFor(() => expect(onListSlashCommandSuggestions).toHaveBeenCalledWith({ projectId: 'project-1', query: 're', limit: 40, refresh: false }))
    fireEvent.keyDown(composer, { key: 'ArrowDown' })
    fireEvent.keyDown(composer, { key: 'Tab' })

    await waitFor(() => expect(composer).toHaveValue('/refactor '))
    expect(onSendMessage).not.toHaveBeenCalled()
  })

  it('scrolls the highlighted slash assist item into view during keyboard navigation', async () => {
    const scrollIntoView = vi.fn()
    const previousScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
    try {
      const onListSlashCommandSuggestions = vi.fn().mockResolvedValue({
        items: Array.from({ length: 16 }, (_, index) => slashSuggestion(`/command-${index}`)),
        sourceStatus: 'ready'
      })
      render(
        <AiSessionPane
          selectedSession={session}
          events={[]}
          onSendMessage={() => undefined}
          onListSlashCommandSuggestions={onListSlashCommandSuggestions}
        />
      )
      const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement
      composer.focus()

      fireEvent.change(composer, { target: { value: '/command' } })
      await screen.findByRole('listbox', { name: 'Slash 命令能力发现' })
      scrollIntoView.mockClear()
      fireEvent.keyDown(composer, { key: 'ArrowDown' })

      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }))
      expect(composer).toHaveFocus()
    } finally {
      if (previousScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
          configurable: true,
          value: previousScrollIntoView
        })
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
      }
    }
  })

  it('falls back to passthrough when no slash command source is available', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    const onListSlashCommandSuggestions = vi.fn().mockResolvedValue({
      items: [],
      sourceStatus: 'empty',
      message: '暂时无法加载 slash 辅助能力；可以继续输入普通任务消息。'
    })
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[]}
        onSendMessage={onSendMessage}
        onListSlashCommandSuggestions={onListSlashCommandSuggestions}
      />
    )
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/unknown' } })

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('可以继续输入普通任务消息'))
    expect(container.querySelectorAll('.ai-slash-assist-popover')).toHaveLength(1)
    expect(screen.queryByRole('listbox', { name: 'Slash 命令能力发现' })).not.toBeInTheDocument()
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', '/unknown'))
  })

  it('closes slash command discovery with Escape while keeping the draft', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    const onListSlashCommandSuggestions = vi.fn().mockResolvedValue({
      items: [slashSuggestion('/review')],
      sourceStatus: 'ready'
    })
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[]}
        onSendMessage={onSendMessage}
        onListSlashCommandSuggestions={onListSlashCommandSuggestions}
      />
    )
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '/' } })
    expect(await screen.findByRole('listbox', { name: 'Slash 命令能力发现' })).toBeInTheDocument()
    expect(container.querySelectorAll('.ai-slash-assist-popover')).toHaveLength(1)
    fireEvent.keyDown(composer, { key: 'Escape' })

    expect(composer).toHaveValue('/')
    await waitFor(() => expect(container.querySelector('.ai-slash-assist-popover')).not.toBeInTheDocument())
    expect(screen.queryByRole('listbox', { name: 'Slash 命令能力发现' })).not.toBeInTheDocument()
  })

  it('keeps input history navigation independent from slash-prefixed drafts', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={onSendMessage} />)
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: 'stored prompt' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', 'stored prompt'))

    fireEvent.change(composer, { target: { value: '/' } })
    fireEvent.keyDown(composer, { key: 'Escape' })
    expect(composer).toHaveValue('/')

    fireEvent.change(composer, { target: { value: '' } })
    composer.selectionStart = 0
    composer.selectionEnd = 0
    fireEvent.keyDown(composer, { key: 'ArrowUp' })

    await waitFor(() => expect(composer).toHaveValue('stored prompt'))
  })

  it('inserts a line break with Ctrl Enter', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={onSendMessage} />)
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: 'hello' } })
    composer.selectionStart = 5
    composer.selectionEnd = 5
    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(composer).toHaveValue('hello\n'))
    expect(onSendMessage).not.toHaveBeenCalled()
  })

  it('keeps composer focused after sending so the next input can continue', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={onSendMessage} />)
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    composer.focus()
    fireEvent.change(composer, { target: { value: 'keep focus' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', 'keep focus'))
    await waitFor(() => expect(composer).toHaveFocus())
  })

  it('sends after a startup takeover diagnostic once the native-jsonl session is running again', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    const onSwitchToNativeTakeover = vi.fn().mockResolvedValue(true)
    render(
      <AiSessionPane
        selectedSession={{ ...session, interactionMode: 'native-jsonl', status: 'running' }}
        events={[
          event('diagnostic', {
            id: 'startup-diagnostic',
            level: 'warning',
            message: 'Claude Code 正在等待 bypass permissions 安全确认。请切到原生 PTY 接管后选择是否接受。'
          })
        ]}
        onSendMessage={onSendMessage}
        onSwitchToNativeTakeover={onSwitchToNativeTakeover}
      />
    )
    const composer = screen.getByPlaceholderText(/输入给原生 Claude Code/) as HTMLTextAreaElement

    expect(screen.queryByText('原生确认等待接管')).not.toBeInTheDocument()
    fireEvent.change(composer, { target: { value: '继续执行刚才的任务' } })
    expect(screen.getByRole('button', { name: '发送' })).not.toBeDisabled()
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', '继续执行刚才的任务'))
  })

  it('keeps composer disabled for terminal session statuses', () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(<AiSessionPane selectedSession={{ ...session, status: 'exited' }} events={[]} onSendMessage={onSendMessage} />)

    expect(screen.getByPlaceholderText('该 Session 已结束，不能继续输入')).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()

    rerender(<AiSessionPane selectedSession={{ ...session, status: 'failed' }} events={[]} onSendMessage={onSendMessage} />)
    expect(screen.getByPlaceholderText('该 Session 已结束，不能继续输入')).toBeDisabled()

    rerender(<AiSessionPane selectedSession={{ ...session, interactionMode: 'native-jsonl', status: 'stopped' }} events={[]} onSendMessage={onSendMessage} />)
    expect(screen.getByPlaceholderText('该 Session 已结束，不能继续输入')).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(screen.getByText('该 Session 已由用户停止。')).toBeInTheDocument()
    expect(onSendMessage).not.toHaveBeenCalled()
  })

  it('keeps composer available for native-jsonl Claude sessions', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={{ ...session, interactionMode: 'native-jsonl' }} events={[]} onSendMessage={onSendMessage} />)
    const composer = screen.getByPlaceholderText(/输入给原生 Claude Code/) as HTMLTextAreaElement

    expect(composer).not.toBeDisabled()
    fireEvent.change(composer, { target: { value: 'native jsonl prompt' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', 'native jsonl prompt'))
  })

  it('keeps composer disabled for plain PTY takeover sessions', () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={{ ...session, interactionMode: 'pty' }} events={[]} onSendMessage={onSendMessage} />)
    const composer = screen.getByPlaceholderText('该 Session 使用终端接管输入') as HTMLTextAreaElement

    expect(composer).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  })

  it('sends composer text while a headless session is running but idle', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={{ ...session, status: 'running' }} events={[]} onSendMessage={onSendMessage} />)
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: 'hello while idle' } })
    expect(screen.getByRole('button', { name: '发送' })).not.toBeDisabled()
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', 'hello while idle'))
  })

  it('allows drafting while waiting for the running session response but does not send yet', () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(
      <AiSessionPane
        selectedSession={{ ...session, status: 'running' }}
        events={[event('user_message', { id: 'user-1', text: 'submitted prompt' })]}
        onSendMessage={onSendMessage}
      />
    )
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    expect(composer).not.toBeDisabled()
    fireEvent.change(composer, { target: { value: 'next thought' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(composer).toHaveValue('next thought')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(onSendMessage).not.toHaveBeenCalled()
  })

  it('allows drafting while the running session is producing output but does not send yet', () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(
      <AiSessionPane
        selectedSession={{ ...session, status: 'running' }}
        events={[
          event('user_message', { id: 'user-1', text: 'submitted prompt' }),
          event('assistant_text', { id: 'assistant-1', text: 'working on it' })
        ]}
        onSendMessage={onSendMessage}
      />
    )
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: 'next thought' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(composer).toHaveValue('next thought')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(onSendMessage).not.toHaveBeenCalled()
  })

  it('keeps the composer disabled while a headless session is starting before the process is ready', () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={{ ...session, status: 'starting' }} events={[]} onSendMessage={onSendMessage} />)
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: 'ready when started' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(composer).toHaveValue('ready when started')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(onSendMessage).not.toHaveBeenCalled()
  })

  it('sends composer text once the started headless process is ready', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={{ ...session, status: 'running', processId: 12345 }} events={[]} onSendMessage={onSendMessage} />)
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: 'ready when started' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', 'ready when started'))
  })

  it('navigates current-session input history with arrow keys at multiline boundaries', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={onSendMessage} />)
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: 'first prompt' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', 'first prompt'))
    fireEvent.change(composer, { target: { value: 'second prompt' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', 'second prompt'))

    composer.selectionStart = 0
    composer.selectionEnd = 0
    fireEvent.keyDown(composer, { key: 'ArrowUp' })
    await waitFor(() => expect(composer).toHaveValue('second prompt'))
    composer.selectionStart = 0
    composer.selectionEnd = 0
    fireEvent.keyDown(composer, { key: 'ArrowUp' })
    await waitFor(() => expect(composer).toHaveValue('first prompt'))
    composer.selectionStart = composer.value.length
    composer.selectionEnd = composer.value.length
    fireEvent.keyDown(composer, { key: 'ArrowDown' })
    await waitFor(() => expect(composer).toHaveValue('second prompt'))
  })

  it('does not navigate input history from the middle of a multiline draft', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={onSendMessage} />)
    const composer = screen.getByPlaceholderText(/输入给 AI 的消息/) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: 'stored prompt' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', 'stored prompt'))
    fireEvent.change(composer, { target: { value: 'line one\nline two' } })
    composer.selectionStart = 9
    composer.selectionEnd = 9
    fireEvent.keyDown(composer, { key: 'ArrowUp' })

    expect(composer).toHaveValue('line one\nline two')
  })

  it('renders only the selected session events and sends to the selected session id', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    const firstSession = { ...session, id: 'session-a', status: 'waiting' as const }
    const secondSession = { ...session, id: 'session-b', status: 'waiting' as const }
    const { rerender } = render(
      <AiSessionPane
        selectedSession={firstSession}
        events={[event('assistant_text', { id: 'a-output', sessionId: 'session-a', text: 'A output' })]}
        onSendMessage={onSendMessage}
      />
    )

    expect(screen.getByText('A output')).toBeInTheDocument()
    expect(screen.queryByText('B output')).not.toBeInTheDocument()

    rerender(
      <AiSessionPane
        selectedSession={secondSession}
        events={[event('assistant_text', { id: 'b-output', sessionId: 'session-b', text: 'B output' })]}
        onSendMessage={onSendMessage}
      />
    )

    expect(screen.getByText('B output')).toBeInTheDocument()
    expect(screen.queryByText('A output')).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText(/输入给 AI 的消息/), { target: { value: 'message to B' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-b', 'message to B'))
    expect(onSendMessage).not.toHaveBeenCalledWith('session-a', 'message to B')
  })

  it('keeps running-session send button states isolated by selected session events', () => {
    const activeSession = { ...session, id: 'session-a', status: 'running' as const }
    const idleSession = { ...session, id: 'session-b', status: 'running' as const }
    const { rerender } = render(
      <AiSessionPane
        selectedSession={activeSession}
        events={[event('user_message', { id: 'a-input', sessionId: 'session-a', text: 'A is busy' })]}
        onSendMessage={() => undefined}
      />
    )

    fireEvent.change(screen.getByPlaceholderText(/输入给 AI 的消息/), { target: { value: 'next' } })
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()

    rerender(<AiSessionPane selectedSession={idleSession} events={[]} onSendMessage={() => undefined} />)

    fireEvent.change(screen.getByPlaceholderText(/输入给 AI 的消息/), { target: { value: 'message to idle B' } })
    expect(screen.getByRole('button', { name: '发送' })).not.toBeDisabled()
  })

  it('sends composer text through the headless message handler', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={onSendMessage} />)

    fireEvent.change(screen.getByPlaceholderText(/输入给 AI 的消息/), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', 'hello'))
    await waitFor(() => expect(screen.getByPlaceholderText(/输入给 AI 的消息/)).toHaveValue(''))
  })

  it('keeps running tool context inside the execution process, not the header', () => {
    render(
      <AiSessionPane
        selectedSession={{ ...session, status: 'running' }}
        events={[
          event('user_message', { id: 'user-1', text: '运行测试' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Bash', input: { command: 'npm run test' } })
        ]}
        onSendMessage={() => undefined}
      />
    )

    expect(screen.queryByText('现场：正在运行工具：Bash')).not.toBeInTheDocument()
    expect(screen.getByText('执行过程 · 1 项 · 1 项运行中')).toBeInTheDocument()
  })

  it('keeps composer text when sending fails', async () => {
    const onSendMessage = vi.fn().mockRejectedValue(new Error('send failed'))
    render(<AiSessionPane selectedSession={session} events={[]} onSendMessage={onSendMessage} />)

    fireEvent.change(screen.getByPlaceholderText(/输入给 AI 的消息/), { target: { value: 'please retry' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('session-1', 'please retry'))
    expect(screen.getByPlaceholderText(/输入给 AI 的消息/)).toHaveValue('please retry')
  })
})

describe('AiSessionPane execution ticket', () => {
  it('keeps the execution block collapsed with only the summary, but exposes the call command once expanded', () => {
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('user_message', { id: 'user-1', text: 'run tests' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Bash', input: { command: 'npm run test' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: '584 passed', isError: false })
        ]}
        onSendMessage={() => undefined}
      />
    )

    const executionBlock = container.querySelector('[data-block-kind="execution"]') as HTMLElement
    expect(executionBlock).toHaveTextContent('执行过程 · 1 项')
    expect(executionBlock).not.toHaveTextContent('npm run test')

    fireEvent.click(screen.getByRole('button', { name: '展开执行过程：1 项' }))

    expect(executionBlock).toHaveTextContent('Bash')
    expect(executionBlock).toHaveTextContent('命令：npm run test')
    expect(executionBlock).toHaveTextContent('结果：584 passed')
  })

  it('shows the file path as the instruction line for Read/Edit/Write calls', () => {
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('user_message', { id: 'user-1', text: 'read' }),
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Read', input: { file_path: 'src/App.tsx' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: 'ok', isError: false })
        ]}
        onSendMessage={() => undefined}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '展开执行过程：1 项' }))

    const executionBlock = container.querySelector('[data-block-kind="execution"]') as HTMLElement
    expect(executionBlock).toHaveTextContent('Read')
    expect(executionBlock).toHaveTextContent('文件：src/App.tsx')
  })

  it('shows the MCP source and resolved tool name as the identity line for MCP calls', () => {
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('tool_use', {
            id: 'tool-use-1',
            toolUseId: 'tool-1',
            name: 'mcp__context7__query-docs',
            input: { libraryId: '/vercel/next.js', query: 'routing' }
          }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: 'docs', isError: false })
        ]}
        onSendMessage={() => undefined}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '展开执行过程：1 项' }))

    const executionBlock = container.querySelector('[data-block-kind="execution"]') as HTMLElement
    expect(executionBlock).toHaveTextContent('context7 / query-docs')
    expect(executionBlock).toHaveTextContent('参数：/vercel/next.js')
  })

  it('shows the call command and a strong failure summary when a tool call fails', () => {
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('tool_use', { id: 'tool-use-1', toolUseId: 'tool-1', name: 'Bash', input: { command: 'npm run missing' } }),
          event('tool_result', { id: 'tool-result-1', toolUseId: 'tool-1', content: 'script missing', isError: true, errorKind: 'tool_error' })
        ]}
        onSendMessage={() => undefined}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '展开执行过程：1 项，1 项失败' }))

    const executionBlock = container.querySelector('[data-block-kind="execution"]') as HTMLElement
    expect(executionBlock).toHaveTextContent('Bash')
    expect(executionBlock).toHaveTextContent('命令：npm run missing')
    expect(executionBlock).toHaveTextContent('结果：script missing')
    expect(executionBlock).toHaveTextContent('失败')
  })

  it('shows the call command and key file path when a permission denial blocks a paired call', () => {
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
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
        ]}
        onSendMessage={() => undefined}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '展开执行过程：1 项，1 项需要接管' }))

    const executionBlock = container.querySelector('[data-block-kind="execution"]') as HTMLElement
    expect(executionBlock).toHaveTextContent('Read')
    expect(executionBlock).toHaveTextContent('文件：C:/temp/note.txt')
    expect(executionBlock).toHaveTextContent('权限未授予')
  })

  it('marks orphan tool results as unmatched without fabricating an instruction line', () => {
    const { container } = render(
      <AiSessionPane
        selectedSession={session}
        events={[
          event('tool_result', { id: 'tool-result-1', toolUseId: 'missing', content: 'late result', isError: false })
        ]}
        onSendMessage={() => undefined}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '展开执行过程：1 项' }))

    const executionBlock = container.querySelector('[data-block-kind="execution"]') as HTMLElement
    expect(executionBlock).toHaveTextContent('未匹配调用')
    expect(executionBlock).toHaveTextContent('结果：late result')
  })
})
