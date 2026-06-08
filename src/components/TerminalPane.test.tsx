import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionOutputEvent } from '../types/workerDesk'

const terminalState: {
  onData?: (data: string) => void
  onResize?: (size: { cols: number; rows: number }) => void
  keyHandler?: (event: KeyboardEvent) => boolean
  fitCalls: number
  openParentClassName?: string
  observedClassName?: string
  refreshCalls: Array<[number, number]>
  resetCalls: number
  clearCalls: number
  focusCalls: number
  scrollToBottomCalls: number
  scrollToLineCalls: number[]
  events: string[]
  syncTextAreaCalls: number
  resizeCallback?: () => void
  writeCallbacks: Array<() => void>
  writtenData: string[]
  pastedData: string[]
  selectionText: string
  buffer: {
    active: {
      baseY: number
      cursorY: number
    }
  }
} = { fitCalls: 0, refreshCalls: [], resetCalls: 0, clearCalls: 0, focusCalls: 0, scrollToBottomCalls: 0, scrollToLineCalls: [], events: [], syncTextAreaCalls: 0, writeCallbacks: [], writtenData: [], pastedData: [], selectionText: '', buffer: { active: { baseY: 0, cursorY: 0 } } }

let sessionOutputHandler: ((event: SessionOutputEvent) => void) | undefined
const getOutputBufferMock = vi.fn<(sessionId: string) => Promise<string>>()
const disposeSessionOutput = vi.fn()
const clipboardReadTextMock = vi.fn<() => Promise<string>>()
const clipboardWriteTextMock = vi.fn<(text: string) => Promise<void>>()

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve()
  })
}

function emitOutput(event: Partial<SessionOutputEvent> & Pick<SessionOutputEvent, 'sessionId' | 'chunk'>) {
  sessionOutputHandler?.({
    stream: 'stdout',
    timestamp: '2026-05-12T00:00:01.000Z',
    ...event
  })
}

class MockResizeObserver {
  constructor(callback: () => void) {
    terminalState.resizeCallback = callback
  }
  observe(element: Element) {
    terminalState.observedClassName = element.className
  }
  disconnect() {}
  unobserve() {}
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return 600
    }
  })
  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    configurable: true,
    value: MockResizeObserver
  })
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    configurable: true,
    value: MockResizeObserver
  })
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      terminalState.fitCalls++
      terminalState.events.push('fit')
    }
  }
}))

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    rows = 24
    cols = 80
    buffer = terminalState.buffer
    _core = {
      _syncTextArea: () => {
        terminalState.syncTextAreaCalls++
        terminalState.events.push('syncTextArea')
      }
    }
    loadAddon() {}
    open(parent: HTMLElement) {
      terminalState.openParentClassName = parent.className
    }
    clear() {
      terminalState.clearCalls++
    }
    reset() {
      terminalState.resetCalls++
      terminalState.events.push('reset')
    }
    write(data: string, callback?: () => void) {
      terminalState.events.push('write')
      terminalState.writtenData.push(data)
      if (callback) {
        terminalState.writeCallbacks.push(callback)
      }
    }
    refresh(start: number, end: number) {
      terminalState.events.push('refresh')
      terminalState.refreshCalls.push([start, end])
    }
    hasSelection() {
      return terminalState.selectionText.length > 0
    }
    getSelection() {
      return terminalState.selectionText
    }
    clearSelection() {
      terminalState.selectionText = ''
    }
    paste(data: string) {
      terminalState.pastedData.push(data)
      terminalState.events.push('paste')
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      terminalState.keyHandler = handler
    }
    focus() {
      terminalState.focusCalls++
      terminalState.events.push('focus')
    }
    scrollToBottom() {
      terminalState.scrollToBottomCalls++
      terminalState.events.push('scrollToBottom')
    }
    scrollToLine(line: number) {
      terminalState.scrollToLineCalls.push(line)
      terminalState.events.push('scrollToLine')
    }
    dispose() {}
    onData(callback: (data: string) => void) {
      terminalState.onData = callback
      return { dispose() {} }
    }
    onResize(callback: (size: { cols: number; rows: number }) => void) {
      terminalState.onResize = callback
      return { dispose() {} }
    }
  }

  return { Terminal: MockTerminal }
})

import { TerminalPane } from './TerminalPane'

const session: Session = {
  id: 'session-1',
  projectId: 'project-1',
  workerType: 'claude-code',
  interactionMode: 'pty',
  processId: 123,
  status: 'running',
  title: 'Session 1',
  createdAt: '2026-05-12T00:00:00.000Z',
  lastActivityAt: '2026-05-12T00:00:00.000Z',
  outputRef: 'jsonl:session-1'
}

const genericChildSession: Session = {
  ...session,
  id: 'generic-session',
  workerType: 'generic-agent',
  parentSessionId: 'claude-session',
  dispatchMode: 'auto',
  title: 'GenericAgent Session'
}

describe('TerminalPane', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.useFakeTimers()
    sessionOutputHandler = undefined
    disposeSessionOutput.mockReset()
    getOutputBufferMock.mockReset()
    getOutputBufferMock.mockResolvedValue('')
    clipboardReadTextMock.mockReset()
    clipboardWriteTextMock.mockReset()
    clipboardReadTextMock.mockResolvedValue('pasted text')
    clipboardWriteTextMock.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: clipboardReadTextMock,
        writeText: clipboardWriteTextMock
      }
    })
    window.workerDesk = {
      getOutputBuffer: getOutputBufferMock,
      onSessionOutput: vi.fn().mockImplementation((handler: (event: SessionOutputEvent) => void) => {
        sessionOutputHandler = handler
        return disposeSessionOutput
      })
    } as unknown as typeof window.workerDesk
    terminalState.onData = undefined
    terminalState.onResize = undefined
    terminalState.keyHandler = undefined
    terminalState.fitCalls = 0
    terminalState.openParentClassName = undefined
    terminalState.observedClassName = undefined
    terminalState.refreshCalls = []
    terminalState.resetCalls = 0
    terminalState.clearCalls = 0
    terminalState.focusCalls = 0
    terminalState.scrollToBottomCalls = 0
    terminalState.scrollToLineCalls = []
    terminalState.syncTextAreaCalls = 0
    terminalState.events = []
    terminalState.resizeCallback = undefined
    terminalState.writeCallbacks = []
    terminalState.writtenData = []
    terminalState.pastedData = []
    terminalState.selectionText = ''
    terminalState.buffer.active.baseY = 0
    terminalState.buffer.active.cursorY = 0
  })

  it('opens and observes the inner terminal frame', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    expect(terminalState.openParentClassName).toBe('terminal-frame')
    expect(terminalState.observedClassName).toBe('terminal-frame')
    expect(screen.getByLabelText('输入导航轨道')).toBeInTheDocument()
  })

  it('forwards xterm onData with latest onInput callback', () => {
    const firstOnInput = vi.fn()
    const secondOnInput = vi.fn()
    const onResize = vi.fn()

    const { rerender } = render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={firstOnInput}
        onResize={onResize}
      />
    )

    rerender(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={secondOnInput}
        onResize={onResize}
      />
    )

    terminalState.onData?.('hello')

    expect(firstOnInput).not.toHaveBeenCalled()
    expect(secondOnInput).toHaveBeenCalledWith('session-1', 'hello')
  })

  it('shows a minimal terminal identity bar for the selected session', () => {
    render(
      <TerminalPane
        selectedSession={{ ...session, status: 'waiting', title: 'AIWorkerControlDesk' }}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    expect(screen.getByText('当前接管：Claude Code · AIWorkerControlDesk')).toBeInTheDocument()
    expect(screen.getByText('状态：等待你输入')).toBeInTheDocument()
  })

  it('shows parent source in the terminal identity bar for GenericAgent sessions', () => {
    render(
      <TerminalPane
        selectedSession={{ ...genericChildSession, dispatchTask: '检查 Terminal 测试' }}
        parentSessionTitle="Claude Code · AIWorkerControlDesk"
        isVisible
        canReturnToParentClaude
        onInput={() => undefined}
        onResize={() => undefined}
        onReturnToParentClaude={() => undefined}
      />
    )

    expect(screen.getByText('当前接管：GenericAgent')).toBeInTheDocument()
    expect(screen.getByText('来源：Claude Code · AIWorkerControlDesk')).toBeInTheDocument()
    expect(screen.getByText('状态：运行中')).toBeInTheDocument()
  })

  it('does not render a standalone terminal input textarea', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    expect(screen.queryByLabelText('Terminal input')).not.toBeInTheDocument()
  })

  it('returns a GenericAgent child session to its parent Claude Code session', () => {
    const onReturnToParentClaude = vi.fn()
    render(
      <TerminalPane
        selectedSession={genericChildSession}
        isVisible
        canReturnToParentClaude
        onInput={() => undefined}
        onResize={() => undefined}
        onReturnToParentClaude={onReturnToParentClaude}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '返回给 Claude Code' }))

    expect(onReturnToParentClaude).toHaveBeenCalledWith('generic-session', 'claude-session')
  })

  it('does not show the return action for Claude Code sessions', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    expect(screen.queryByRole('button', { name: '返回给 Claude Code' })).not.toBeInTheDocument()
  })

  it('disables the return action when the parent Claude Code session cannot receive input', () => {
    render(
      <TerminalPane
        selectedSession={genericChildSession}
        isVisible
        canReturnToParentClaude={false}
        onInput={() => undefined}
        onResize={() => undefined}
        onReturnToParentClaude={() => undefined}
      />
    )

    expect(screen.getByRole('button', { name: '返回给 Claude Code' })).toBeDisabled()
  })

  it('shows mission context for GenericAgent child sessions', () => {
    render(
      <TerminalPane
        selectedSession={{
          ...genericChildSession,
          dispatchTask: '检查 SessionRadar 卡片显示问题'
        }}
        parentSessionTitle="00_Yu / Kimi"
        isVisible
        canReturnToParentClaude
        onInput={() => undefined}
        onResize={() => undefined}
        onReturnToParentClaude={() => undefined}
      />
    )

    expect(screen.getByText('Task')).toBeInTheDocument()
    expect(screen.getByText('检查 SessionRadar 卡片显示问题')).toBeInTheDocument()
    expect(screen.getByText('From')).toBeInTheDocument()
    expect(screen.getByText('00_Yu / Kimi')).toBeInTheDocument()
  })

  it('does not show mission context for Claude Code sessions', () => {
    render(
      <TerminalPane
        selectedSession={session}
        parentSessionTitle="Parent"
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    expect(screen.queryByText('Task')).not.toBeInTheDocument()
    expect(screen.queryByText('From')).not.toBeInTheDocument()
  })

  it('reports the first input anchor summary once per session', () => {
    const onInput = vi.fn()
    const onInputAnchorCreated = vi.fn()
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={onInput}
        onResize={() => undefined}
        onInputAnchorCreated={onInputAnchorCreated}
      />
    )

    act(() => {
      terminalState.onData?.('写一篇 800 字作文')
      terminalState.onData?.('\r')
      terminalState.onData?.('继续润色')
      terminalState.onData?.('\r')
    })

    expect(onInput).toHaveBeenCalledWith('session-1', '写一篇 800 字作文')
    expect(onInputAnchorCreated).toHaveBeenCalledTimes(1)
    expect(onInputAnchorCreated).toHaveBeenCalledWith('session-1', '写一篇 800 字作文')
    expect(screen.getByRole('button', { name: '跳转到输入 1：写一篇 800 字作文' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '跳转到输入 2：继续润色' })).toBeInTheDocument()
  })

  it('does not report command input anchors as task titles', () => {
    const onInputAnchorCreated = vi.fn()
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
        onInputAnchorCreated={onInputAnchorCreated}
      />
    )

    act(() => {
      terminalState.onData?.('npm run test')
      terminalState.onData?.('\r')
    })

    expect(onInputAnchorCreated).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /跳转到输入/ })).not.toBeInTheDocument()
  })

  it('forwards xterm input after a session becomes selected', () => {
    const onInput = vi.fn()
    const { rerender } = render(
      <TerminalPane
        isVisible
        onInput={onInput}
        onResize={() => undefined}
      />
    )

    rerender(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={onInput}
        onResize={() => undefined}
      />
    )

    terminalState.onData?.('hello')

    expect(onInput).toHaveBeenCalledWith('session-1', 'hello')
  })

  it('hydrates selected session output before first terminal write', async () => {
    const deferred = createDeferred<string>()
    getOutputBufferMock.mockReturnValueOnce(deferred.promise)

    const { rerender } = render(
      <TerminalPane
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    terminalState.events = []
    terminalState.writeCallbacks = []

    rerender(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    expect(getOutputBufferMock).toHaveBeenCalledWith('session-1')

    deferred.resolve('first output')
    await flushPromises()

    expect(terminalState.events).toEqual(['fit', 'reset', 'write'])

    act(() => {
      terminalState.writeCallbacks.shift()?.()
    })

    expect(terminalState.events).toEqual([
      'fit',
      'reset',
      'write',
      'scrollToBottom',
      'refresh',
      'fit',
      'scrollToBottom',
      'refresh',
      'syncTextArea'
    ])
  })

  it('refreshes terminal after hydrated output arrives', async () => {
    getOutputBufferMock.mockResolvedValueOnce('first output')

    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    await flushPromises()

    expect(terminalState.resetCalls).toBeGreaterThan(0)
    expect(terminalState.refreshCalls).not.toContainEqual([0, 23])

    act(() => {
      terminalState.writeCallbacks.shift()?.()
    })

    expect(terminalState.refreshCalls).toContainEqual([0, 23])
  })

  it('flushes live output received after hydration resolves but before rewrite callback completes', async () => {
    const deferred = createDeferred<string>()
    getOutputBufferMock.mockReturnValueOnce(deferred.promise)

    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    deferred.resolve('base')
    await flushPromises()

    emitOutput({ sessionId: 'session-1', chunk: ' tail' })
    expect(terminalState.writtenData).toEqual(['base'])

    act(() => {
      terminalState.writeCallbacks.shift()?.()
    })

    expect(terminalState.writtenData).toEqual(['base', ' tail'])
  })

  it('keeps accepting live output when hydration fails', async () => {
    getOutputBufferMock.mockRejectedValueOnce(new Error('read failed'))

    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    await flushPromises()
    terminalState.writtenData = []

    emitOutput({ sessionId: 'session-1', chunk: 'live after failed hydration' })
    expect(terminalState.writtenData).toEqual([])

    act(() => {
      terminalState.writeCallbacks.shift()?.()
    })

    expect(terminalState.writtenData).toEqual(['live after failed hydration'])
  })

  it('writes live output only for the selected session', async () => {
    getOutputBufferMock.mockResolvedValueOnce('')

    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    await flushPromises()
    act(() => {
      terminalState.writeCallbacks.shift()?.()
    })
    terminalState.writtenData = []

    emitOutput({ sessionId: 'session-2', chunk: 'ignored' })
    emitOutput({ sessionId: 'session-1', chunk: 'accepted' })

    expect(terminalState.writtenData).toEqual(['accepted'])
  })

  it('does not forward xterm input when session cannot receive input', () => {
    const onInput = vi.fn()
    const exitedSession: Session = { ...session, status: 'exited' }
    render(
      <TerminalPane
        selectedSession={exitedSession}
        isVisible
        onInput={onInput}
        onResize={() => undefined}
      />
    )

    terminalState.onData?.('hello')

    expect(onInput).not.toHaveBeenCalled()
  })

  it('resizes the selected PTY after terminal tab becomes visible', () => {
    const onResize = vi.fn()
    const { rerender } = render(
      <TerminalPane
        selectedSession={session}
        isVisible={false}
        onInput={() => undefined}
        onResize={onResize}
      />
    )

    onResize.mockClear()

    rerender(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={onResize}
      />
    )

    act(() => {
      vi.advanceTimersByTime(100)
    })

    expect(onResize).toHaveBeenCalledWith('session-1', 80, 24)
    expect(terminalState.refreshCalls).toContainEqual([0, 23])
  })

  it('does not focus terminal when a session becomes selected', async () => {
    const { rerender } = render(
      <TerminalPane
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    terminalState.focusCalls = 0
    terminalState.writeCallbacks = []

    rerender(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    await flushPromises()

    act(() => {
      terminalState.writeCallbacks.shift()?.()
    })

    expect(terminalState.focusCalls).toBe(0)
    expect(screen.getByText('Click terminal to type')).toBeInTheDocument()
  })

  it('stabilizes switched session output without focusing terminal', async () => {
    const nextSession: Session = { ...session, id: 'session-2', title: 'Session 2' }
    getOutputBufferMock
      .mockResolvedValueOnce('first output')
      .mockResolvedValueOnce('second output')

    const { rerender } = render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    await flushPromises()
    act(() => {
      terminalState.writeCallbacks.shift()?.()
    })
    terminalState.events = []
    terminalState.writeCallbacks = []

    rerender(
      <TerminalPane
        selectedSession={nextSession}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    await flushPromises()

    expect(terminalState.events).toEqual(['fit', 'reset', 'write'])

    act(() => {
      terminalState.writeCallbacks.shift()?.()
    })

    expect(terminalState.events).toEqual([
      'fit',
      'reset',
      'write',
      'scrollToBottom',
      'refresh',
      'fit',
      'scrollToBottom',
      'refresh',
      'syncTextArea'
    ])
  })

  it('activates terminal input on first left mouse down without waiting for session change', () => {
    const { container } = render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    terminalState.events = []
    terminalState.focusCalls = 0

    const terminalContainer = container.querySelector('.terminal-container')
    expect(terminalContainer).not.toBeNull()

    fireEvent.mouseDown(terminalContainer!, { button: 0 })

    expect(terminalState.focusCalls).toBe(1)
    expect(terminalState.events).toContain('focus')
    expect(terminalState.events).toContain('syncTextArea')
  })

  it('copies selected terminal text to clipboard on Ctrl+C shortcut', async () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    terminalState.selectionText = 'selected output'
    const handled = terminalState.keyHandler?.(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))
    await flushPromises()

    expect(handled).toBe(false)
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('selected output')
    expect(terminalState.selectionText).toBe('')
  })

  it('pastes clipboard text into xterm on Ctrl+V shortcut', async () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    const handled = terminalState.keyHandler?.(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }))
    await flushPromises()

    expect(handled).toBe(false)
    expect(clipboardReadTextMock).toHaveBeenCalled()
    expect(terminalState.pastedData).toEqual(['pasted text'])
  })

  it('does not move terminal cursor while model output arrives during IME composition', async () => {
    getOutputBufferMock.mockResolvedValueOnce('user prompt')

    const { container } = render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )
    await flushPromises()
    act(() => {
      terminalState.writeCallbacks.shift()?.()
    })
    terminalState.events = []
    terminalState.writtenData = []

    const terminalFrame = container.querySelector('.terminal-frame')
    expect(terminalFrame).not.toBeNull()
    fireEvent.compositionStart(terminalFrame!)

    emitOutput({ sessionId: 'session-1', chunk: '\nassistant thinking output' })

    expect(terminalState.writtenData).toEqual([])
    expect(terminalState.events).toEqual([])
  })

  it('buffers incremental output while composing IME text', async () => {
    getOutputBufferMock.mockResolvedValueOnce('base')

    const { container } = render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )
    await flushPromises()
    act(() => {
      terminalState.writeCallbacks.shift()?.()
    })
    terminalState.writtenData = []

    const terminalFrame = container.querySelector('.terminal-frame')
    expect(terminalFrame).not.toBeNull()
    fireEvent.compositionStart(terminalFrame!)

    emitOutput({ sessionId: 'session-1', chunk: ' thinking output' })

    expect(terminalState.writtenData).toEqual([])

    fireEvent.compositionEnd(terminalFrame!)

    expect(terminalState.writtenData).toEqual([' thinking output'])
  })

  it('does not flush composed pending output after switching sessions', async () => {
    const nextSession: Session = { ...session, id: 'session-2', title: 'Session 2' }
    getOutputBufferMock
      .mockResolvedValueOnce('base')
      .mockResolvedValueOnce('second output')

    const { container, rerender } = render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )
    await flushPromises()
    act(() => {
      terminalState.writeCallbacks.shift()?.()
    })
    terminalState.writtenData = []

    const terminalFrame = container.querySelector('.terminal-frame')
    expect(terminalFrame).not.toBeNull()
    fireEvent.compositionStart(terminalFrame!)

    emitOutput({ sessionId: 'session-1', chunk: ' old-session-output' })
    expect(terminalState.writtenData).toEqual([])

    rerender(
      <TerminalPane
        selectedSession={nextSession}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )
    await flushPromises()
    terminalState.writtenData = []

    fireEvent.compositionEnd(terminalFrame!)

    expect(terminalState.writtenData).toEqual([])
  })

  it('ignores stale rewrite callbacks after switching sessions', async () => {
    const nextSession: Session = { ...session, id: 'session-2', title: 'Session 2' }
    getOutputBufferMock
      .mockResolvedValueOnce('first output')
      .mockResolvedValueOnce('second output')

    const { rerender } = render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    await flushPromises()
    const staleCallback = terminalState.writeCallbacks.shift()
    terminalState.events = []

    rerender(
      <TerminalPane
        selectedSession={nextSession}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    await flushPromises()

    act(() => {
      staleCallback?.()
    })

    expect(terminalState.events).toEqual(['fit', 'reset', 'write'])
  })

  it('adds a input anchor for Chinese question input', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    terminalState.buffer.active.baseY = 42
    terminalState.buffer.active.cursorY = 3
    act(() => {
      terminalState.onData?.('怎么查看之前的问题？\r')
    })

    expect(screen.getByRole('button', { name: '跳转到输入 1：怎么查看之前的问题？' })).toBeInTheDocument()
  })

  it('adds an input anchor for non-command plain input', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    act(() => {
      terminalState.onData?.('你好\r')
    })

    expect(screen.getByRole('button', { name: '跳转到输入 1：你好' })).toBeInTheDocument()
  })

  it('adds a input anchor for pasted bracketed question input', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    act(() => {
      terminalState.onData?.('\x1b[200~这个项目怎么运行？\x1b[201~\r')
    })

    expect(screen.getByRole('button', { name: '跳转到输入 1：这个项目怎么运行？' })).toBeInTheDocument()
  })

  it('adds a input anchor for English question input', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    act(() => {
      terminalState.onData?.('how can I run tests?\r')
    })

    expect(screen.getByRole('button', { name: '跳转到输入 1：how can I run tests?' })).toBeInTheDocument()
  })

  it('does not add a input anchor for obvious commands', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    act(() => {
      terminalState.onData?.('npm test\r')
    })

    expect(screen.queryByRole('button', { name: /跳转到输入/ })).not.toBeInTheDocument()
  })

  it('does not add an input anchor for Claude Code slash commands', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    act(() => {
      terminalState.onData?.('/model\r')
      terminalState.onData?.('/help status\r')
    })

    expect(screen.queryByRole('button', { name: /跳转到输入/ })).not.toBeInTheDocument()
  })

  it('does not leak xterm control responses into the next input anchor', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    act(() => {
      terminalState.onData?.('\x1bP>|xterm.js 5.5.0\x1b\\')
      terminalState.onData?.('你好\r')
    })

    expect(screen.getByRole('button', { name: '跳转到输入 1：你好' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /xterm/ })).not.toBeInTheDocument()
  })

  it('does not leak split xterm control responses into the next input anchor', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    act(() => {
      terminalState.onData?.('\x1bP>|x')
      terminalState.onData?.('term.js 5.5.0\x1b\\')
      terminalState.onData?.('你好\r')
    })

    expect(screen.getByRole('button', { name: '跳转到输入 1：你好' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /xterm/ })).not.toBeInTheDocument()
  })

  it('adds one input anchor for multiline bracketed paste input', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    act(() => {
      terminalState.onData?.('\x1b[200~第一行需求\n第二行约束\n第三行验收\x1b[201~\r')
    })

    expect(screen.getByRole('button', { name: '跳转到输入 1：第一行需求 第二行约束 第三行验收' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /跳转到输入 2/ })).not.toBeInTheDocument()
  })

  it('adds one input anchor for split multiline bracketed paste input', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    act(() => {
      terminalState.onData?.('\x1b[200~')
      terminalState.onData?.('第一行需求\n第二行约束')
      terminalState.onData?.('\n第三行验收\x1b[201~\r')
    })

    expect(screen.getByRole('button', { name: '跳转到输入 1：第一行需求 第二行约束 第三行验收' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /跳转到输入 2/ })).not.toBeInTheDocument()
  })

  it('truncates long input anchor summaries with an ellipsis', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )
    const longInput = '请帮我先阅读这段很长的需求说明，整理出关键问题，然后给出最小修改方案，最后再补充验证方式，不要直接开始扩展功能，并且要特别检查 slash 命令、长文本、多行粘贴、xterm 控制响应和续聊自动注入这些边界情况'

    act(() => {
      terminalState.onData?.(`${longInput}\r`)
    })

    const anchor = screen.getByRole('button', { name: /跳转到输入 1：请帮我先阅读/ })
    expect(anchor).toHaveAttribute('title', expect.stringMatching(/…$/))
    expect(anchor.getAttribute('title')).toHaveLength(72)
  })

  it('uses backspace edits before adding a input anchor', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    act(() => {
      terminalState.onData?.('how can I run tset')
      terminalState.onData?.('\x7f')
      terminalState.onData?.('\x7f')
      terminalState.onData?.('\x7f')
      terminalState.onData?.('est?\r')
    })

    expect(screen.getByRole('button', { name: '跳转到输入 1：how can I run test?' })).toBeInTheDocument()
  })

  it('clears question draft on Ctrl+C and Ctrl+U', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    act(() => {
      terminalState.onData?.('how can I run tests?')
      terminalState.onData?.('')
      terminalState.onData?.('\r')
      terminalState.onData?.('为什么会失败？')
      terminalState.onData?.('')
      terminalState.onData?.('\r')
    })

    expect(screen.queryByRole('button', { name: /跳转到输入/ })).not.toBeInTheDocument()
  })

  it('does not add a input anchor when session cannot receive input', () => {
    const exitedSession: Session = { ...session, status: 'exited' }
    render(
      <TerminalPane
        selectedSession={exitedSession}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    act(() => {
      terminalState.onData?.('怎么查看之前的问题？\r')
    })

    expect(screen.queryByRole('button', { name: /跳转到输入/ })).not.toBeInTheDocument()
  })

  it('shows a three-part failure strip for failed sessions with provider guidance', () => {
    render(
      <TerminalPane
        selectedSession={{
          ...session,
          status: 'failed',
          errorMessage: '401 Unauthorized: invalid API key for base URL'
        }}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    expect(screen.getByText('发生了什么')).toBeInTheDocument()
    expect(screen.getByText('401 Unauthorized: invalid API key for base URL')).toBeInTheDocument()
    expect(screen.getByText('下一步去哪里')).toBeInTheDocument()
    expect(screen.getByText('检查 Provider 配置')).toBeInTheDocument()
    expect(screen.getByText('怎么继续')).toBeInTheDocument()
    expect(screen.getByText('不要复活失败进程，请新建 Session 继续。')).toBeInTheDocument()
    expect(screen.queryByText('Click terminal to type')).not.toBeInTheDocument()
  })

  it('shows provider guidance when Claude asks the user to login', () => {
    render(
      <TerminalPane
        selectedSession={{
          ...session,
          status: 'failed',
          errorMessage: 'Invalid API key. Please run /login to authenticate.'
        }}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    expect(screen.getByText('Invalid API key. Please run /login to authenticate.')).toBeInTheDocument()
    expect(screen.getByText('检查 Provider 配置')).toBeInTheDocument()
  })

  it('shows GenericAgent guidance when a failed session points at the worker launcher', () => {
    render(
      <TerminalPane
        selectedSession={{
          ...genericChildSession,
          status: 'failed',
          errorMessage: 'spawn python ENOENT: agentmain.py not found'
        }}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    expect(screen.getByText('spawn python ENOENT: agentmain.py not found')).toBeInTheDocument()
    expect(screen.getByText('检查 GenericAgent 启动配置')).toBeInTheDocument()
  })

  it('shows a fallback failure message and task guidance when no specific failed reason exists', () => {
    render(
      <TerminalPane
        selectedSession={{ ...session, status: 'failed', errorMessage: undefined }}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    expect(screen.getByText('进程异常退出，请查看下方输出。')).toBeInTheDocument()
    expect(screen.getByText('可新建 Session 重新说明任务')).toBeInTheDocument()
  })

  it('shows only the selected session input anchors and restores them after switching back', () => {
    const nextSession: Session = { ...session, id: 'session-2', title: 'Session 2' }
    const { rerender } = render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    act(() => {
      terminalState.onData?.('怎么查看之前的问题？\r')
    })
    expect(screen.getByRole('button', { name: '跳转到输入 1：怎么查看之前的问题？' })).toBeInTheDocument()

    rerender(
      <TerminalPane
        selectedSession={nextSession}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )
    expect(screen.queryByRole('button', { name: '跳转到输入 1：怎么查看之前的问题？' })).not.toBeInTheDocument()

    act(() => {
      terminalState.onData?.('how can I run tests?\r')
    })
    expect(screen.getByRole('button', { name: '跳转到输入 1：how can I run tests?' })).toBeInTheDocument()

    rerender(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )
    expect(screen.getByRole('button', { name: '跳转到输入 1：怎么查看之前的问题？' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '跳转到输入 1：how can I run tests?' })).not.toBeInTheDocument()
  })

  it('scrolls to input anchor without focusing terminal', () => {
    render(
      <TerminalPane
        selectedSession={session}
        isVisible
        onInput={() => undefined}
        onResize={() => undefined}
      />
    )

    terminalState.buffer.active.baseY = 8
    terminalState.buffer.active.cursorY = 2
    act(() => {
      terminalState.onData?.('怎么查看之前的问题？\r')
    })
    terminalState.focusCalls = 0

    fireEvent.click(screen.getByRole('button', { name: '跳转到输入 1：怎么查看之前的问题？' }))

    expect(terminalState.scrollToLineCalls).toEqual([10])
    expect(terminalState.focusCalls).toBe(0)
  })
})
