import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent as ReactClipboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { Session, SessionOutputEvent } from '../types/workerDesk'
import { isTerminalSessionStatus } from '../utils/sessionStatus'

type TerminalWithTextAreaSync = Terminal & {
  _core?: {
    _syncTextArea?: () => void
  }
  hasSelection?: () => boolean
  getSelection?: () => string
  clearSelection?: () => void
  paste?: (data: string) => void
  attachCustomKeyEventHandler?: (handler: (event: KeyboardEvent) => boolean) => void
}

type TerminalWithBuffer = Terminal & {
  buffer?: {
    active?: {
      baseY: number
      cursorY: number
    }
  }
}

type InputAnchor = {
  id: number
  sessionId: string
  line: number
  summary: string
  submittedAt: number
}

const TERMINAL_INIT_DELAY_MS = 100
const TERMINAL_RESIZE_DELAY_MS = 50
const MAX_INPUT_SUMMARY_LENGTH = 72
const COMMAND_PREFIX_PATTERN = /^(npm|pnpm|yarn|git|ls|cd|pwd|cat|echo|node|python|python3|npx|mkdir|rm|cp|mv|dir|type)\b/i

function readCssVariable(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function readTerminalTheme() {
  return {
    background: readCssVariable('--surface-terminal') || '#101216',
    foreground: readCssVariable('--text-primary') || '#d7dde8',
    cursor: readCssVariable('--accent') || '#6ea8fe',
    selectionBackground: readCssVariable('--bg-hover') || '#1f2535'
  }
}

type InputParseState = {
  mode: 'normal' | 'csi' | 'control-string'
  csiBuffer: string
  isBracketedPaste: boolean
}

function isPrintableInput(data: string) {
  return [...data].every((char) => {
    const code = char.charCodeAt(0)
    return code > 31 && code !== 127
  })
}

function createInputParseState(): InputParseState {
  return {
    mode: 'normal',
    csiBuffer: '',
    isBracketedPaste: false
  }
}

function stripTerminalControlSequences(data: string, state: InputParseState) {
  let result = ''
  for (let index = 0; index < data.length; index += 1) {
    const char = data.charAt(index)

    if (state.mode === 'control-string') {
      if (char === '') state.mode = 'normal'
      if (char === '\x1b' && data.charAt(index + 1) === '\\') {
        state.mode = 'normal'
        index += 1
      }
      continue
    }

    if (state.mode === 'csi') {
      state.csiBuffer += char
      const code = char.charCodeAt(0)
      if (code >= 0x40 && code <= 0x7e) {
        if (state.csiBuffer === '\x1b[200~') state.isBracketedPaste = true
        if (state.csiBuffer === '\x1b[201~') state.isBracketedPaste = false
        state.csiBuffer = ''
        state.mode = 'normal'
      }
      continue
    }

    if (char !== '\x1b') {
      result += state.isBracketedPaste && (char === '\r' || char === '\n') ? ' ' : char
      continue
    }

    const next = data.charAt(index + 1)
    if (next === '[') {
      state.mode = 'csi'
      state.csiBuffer = '\x1b['
      index += 1
      continue
    }

    if (next === ']' || next === 'P' || next === '^' || next === '_' || next === 'X') {
      state.mode = 'control-string'
      index += 1
      continue
    }

    if (next) index += 1
  }
  return result
}

function normalizeInputSummary(text: string) {
  const summary = text.replace(/\s+/g, ' ').trim()
  if (summary.length <= MAX_INPUT_SUMMARY_LENGTH) return summary
  return `${summary.slice(0, MAX_INPUT_SUMMARY_LENGTH - 1)}…`
}

function shouldAddInputAnchor(text: string) {
  const trimmed = text.trim()
  return Boolean(trimmed) && !trimmed.startsWith('/') && !COMMAND_PREFIX_PATTERN.test(trimmed)
}

function terminalStatusLabel(status?: Session['status']) {
  if (status === 'running') return '运行中'
  if (status === 'waiting') return '等待你输入'
  if (status === 'failed') return '失败'
  if (status === 'stopped') return '已停止'
  if (status === 'exited') return '已完成'
  if (status === 'starting') return '启动中'
  return '空闲'
}

function terminalWorkerName(session?: Session) {
  if (!session) return 'Terminal'
  return session.workerType === 'generic-agent' ? 'GenericAgent' : 'Claude Code'
}

function failureGuidance(session: Session) {
  const message = session.errorMessage?.trim() || '进程异常退出，请查看下方输出。'
  const normalized = message.toLowerCase()
  if (/provider|api key|apikey|base url|baseurl|model|unauthorized|authentication|not logged in|\/login|401|403/.test(normalized)) {
    return { message, nextStep: '检查 Provider 配置' }
  }
  if (/genericagent|generic agent|agentmain\.py|entry script|script|spawn|enoent/.test(normalized)) {
    return { message, nextStep: '检查 GenericAgent 启动配置' }
  }
  return { message, nextStep: '可新建 Session 重新说明任务' }
}

type TerminalPaneProps = {
  selectedSession?: Session
  parentSessionTitle?: string
  isVisible: boolean
  canReturnToParentClaude?: boolean
  onInput(sessionId: string, data: string): void
  onResize(sessionId: string, cols: number, rows: number): void
  onInputAnchorCreated?(sessionId: string, summary: string): void
  onReturnToParentClaude?(sessionId: string, parentSessionId: string): void
  onReturnToAiPane?(sessionId: string): void
}

export function TerminalPane(props: TerminalPaneProps) {
  const [isTerminalFocused, setIsTerminalFocused] = useState(false)
  const terminalFrameRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | undefined>(props.selectedSession?.id)
  const canReceiveInputRef = useRef(Boolean(props.selectedSession && !isTerminalSessionStatus(props.selectedSession.status)))
  const onInputRef = useRef(props.onInput)
  const onResizeRef = useRef(props.onResize)
  const onInputAnchorCreatedRef = useRef(props.onInputAnchorCreated)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isComposingRef = useRef(false)
  const pendingOutputRef = useRef<{ sessionId: string; output: string } | null>(null)
  const rewriteGenerationRef = useRef(0)
  const hydrationGenerationRef = useRef(0)
  const hydratedBufferRef = useRef('')
  const isHydratingRef = useRef(false)
  const isRewritePendingRef = useRef(false)
  const postHydrationChunksRef = useRef<string[]>([])
  const inputAnchorsBySessionRef = useRef(new Map<string, InputAnchor[]>())
  const inputDraftBySessionRef = useRef(new Map<string, string>())
  const inputParseStateBySessionRef = useRef(new Map<string, InputParseState>())
  const inputSeqBySessionRef = useRef(new Map<string, number>())
  const reportedInputTitleBySessionRef = useRef(new Set<string>())
  const [visibleInputAnchors, setVisibleInputAnchors] = useState<InputAnchor[]>([])

  const isInputDisabled = !props.selectedSession
    || isTerminalSessionStatus(props.selectedSession.status)
  const failedSessionGuidance = props.selectedSession?.status === 'failed'
    ? failureGuidance(props.selectedSession)
    : undefined
  const canShowReturnAction = props.selectedSession?.workerType === 'generic-agent' && props.selectedSession.parentSessionId
  const canShowMissionStrip = props.selectedSession?.workerType === 'generic-agent'
    && (Boolean(props.selectedSession.dispatchTask) || Boolean(props.parentSessionTitle))

  const fitVisibleTerminal = () => {
    if (document.hidden) return false
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    const terminalFrame = terminalFrameRef.current
    if (!terminal || !fitAddon || !terminalFrame || terminalFrame.clientWidth === 0 || terminalFrame.clientHeight === 0) return false
    fitAddon.fit()
    const sessionId = sessionIdRef.current
    if (sessionId) {
      onResizeRef.current(sessionId, terminal.cols, terminal.rows)
    }
    return true
  }

  const refreshTerminal = () => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.refresh(0, Math.max(0, terminal.rows - 1))
  }

  const syncTextAreaToCursor = () => {
    const terminal = terminalRef.current as TerminalWithTextAreaSync | null
    terminal?._core?._syncTextArea?.()
  }

  const appendChunk = (chunk: string) => {
    const sessionId = sessionIdRef.current
    if (!sessionId || chunk.length === 0) return
    hydratedBufferRef.current = `${hydratedBufferRef.current}${chunk}`
    if (isComposingRef.current) {
      const pendingOutput = pendingOutputRef.current
      pendingOutputRef.current = {
        sessionId,
        output: pendingOutput?.sessionId === sessionId ? `${pendingOutput.output}${chunk}` : chunk
      }
      return
    }
    terminalRef.current?.write(chunk)
  }

  const flushPostHydrationChunks = () => {
    const bufferedChunks = postHydrationChunksRef.current
    if (bufferedChunks.length === 0) return
    postHydrationChunksRef.current = []
    appendChunk(bufferedChunks.join(''))
  }

  const stabilizeTerminalView = () => {
    const terminal = terminalRef.current
    if (!terminal || !props.selectedSession || !props.isVisible) return
    fitVisibleTerminal()
    terminal.scrollToBottom()
    refreshTerminal()
    syncTextAreaToCursor()
  }

  const handleCompositionStart = () => {
    isComposingRef.current = true
  }

  const handleCompositionEnd = () => {
    isComposingRef.current = false
    const pendingOutput = pendingOutputRef.current
    pendingOutputRef.current = null
    if (pendingOutput && pendingOutput.sessionId === sessionIdRef.current) {
      terminalRef.current?.write(pendingOutput.output)
    }
    syncTextAreaToCursor()
  }

  const rewriteTerminal = (output: string, shouldStabilizeAfterWrite: boolean) => {
    const terminal = terminalRef.current
    if (!terminal) return
    pendingOutputRef.current = null
    const rewriteSessionId = sessionIdRef.current
    const rewriteGeneration = rewriteGenerationRef.current + 1
    rewriteGenerationRef.current = rewriteGeneration
    isRewritePendingRef.current = true
    fitVisibleTerminal()
    terminal.reset()
    terminal.write(output, () => {
      if (rewriteGenerationRef.current !== rewriteGeneration || sessionIdRef.current !== rewriteSessionId) return
      isRewritePendingRef.current = false
      terminal.scrollToBottom()
      refreshTerminal()
      flushPostHydrationChunks()
      if (shouldStabilizeAfterWrite) {
        stabilizeTerminalView()
      }
    })
  }

  const focusTerminal = () => {
    const terminal = terminalRef.current
    if (!terminal || isInputDisabled) return
    terminal.focus()
    setIsTerminalFocused(true)
  }

  const activateTerminalInput = () => {
    if (isInputDisabled) return
    stabilizeTerminalView()
    focusTerminal()
  }

  const copySelectionToClipboard = async () => {
    const terminal = terminalRef.current as TerminalWithTextAreaSync | null
    const selection = terminal?.hasSelection?.() ? terminal.getSelection?.() : ''
    if (!selection || !navigator.clipboard?.writeText) return false
    await navigator.clipboard.writeText(selection)
    terminal?.clearSelection?.()
    return true
  }

  const pasteTextToTerminal = (text: string) => {
    if (!text || isInputDisabled) return
    activateTerminalInput()
    const terminal = terminalRef.current as TerminalWithTextAreaSync | null
    if (terminal?.paste) {
      terminal.paste(text)
      return
    }
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    onInputRef.current(sessionId, text)
  }

  const getCurrentBufferLine = () => {
    const buffer = (terminalRef.current as TerminalWithBuffer | null)?.buffer?.active
    return (buffer?.baseY ?? 0) + (buffer?.cursorY ?? 0)
  }

  const syncVisibleInputAnchors = (sessionId = sessionIdRef.current) => {
    setVisibleInputAnchors(sessionId ? [...(inputAnchorsBySessionRef.current.get(sessionId) ?? [])] : [])
  }

  const addInputAnchor = (sessionId: string, text: string) => {
    const summary = normalizeInputSummary(text)
    if (!summary || !shouldAddInputAnchor(summary)) return
    const nextId = (inputSeqBySessionRef.current.get(sessionId) ?? 0) + 1
    inputSeqBySessionRef.current.set(sessionId, nextId)
    const nextAnchor: InputAnchor = {
      id: nextId,
      sessionId,
      line: getCurrentBufferLine(),
      summary,
      submittedAt: Date.now()
    }
    const nextAnchors = [...(inputAnchorsBySessionRef.current.get(sessionId) ?? []), nextAnchor]
    inputAnchorsBySessionRef.current.set(sessionId, nextAnchors)
    if (!reportedInputTitleBySessionRef.current.has(sessionId)) {
      reportedInputTitleBySessionRef.current.add(sessionId)
      onInputAnchorCreatedRef.current?.(sessionId, summary)
    }
    if (sessionId === sessionIdRef.current) setVisibleInputAnchors(nextAnchors)
  }

  const commitInputDraft = (sessionId: string) => {
    const draft = inputDraftBySessionRef.current.get(sessionId) ?? ''
    inputDraftBySessionRef.current.set(sessionId, '')
    addInputAnchor(sessionId, draft)
  }

  const collectInputAnchor = (sessionId: string, data: string) => {
    let parseState = inputParseStateBySessionRef.current.get(sessionId)
    if (!parseState) {
      parseState = createInputParseState()
      inputParseStateBySessionRef.current.set(sessionId, parseState)
    }
    const inputText = stripTerminalControlSequences(data, parseState)
    if (inputText === '\x03' || inputText === '\x15') {
      inputDraftBySessionRef.current.set(sessionId, '')
      return
    }
    if (inputText === '\x7f' || inputText === '\b') {
      const draft = inputDraftBySessionRef.current.get(sessionId) ?? ''
      inputDraftBySessionRef.current.set(sessionId, draft.slice(0, -1))
      return
    }
    if (!inputText) return

    let draft = inputDraftBySessionRef.current.get(sessionId) ?? ''
    for (const char of inputText) {
      if (char === '\r' || char === '\n') {
        inputDraftBySessionRef.current.set(sessionId, draft)
        commitInputDraft(sessionId)
        draft = ''
        continue
      }
      if (isPrintableInput(char)) draft += char
    }
    inputDraftBySessionRef.current.set(sessionId, draft)
  }

  const scrollToInputAnchor = (anchor: InputAnchor) => {
    terminalRef.current?.scrollToLine(anchor.line)
    refreshTerminal()
  }

  const handleTerminalMouseDownCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.terminal-question-rail')) return
    if (event.button !== 0 || isInputDisabled || isTerminalFocused) return
    event.preventDefault()
    event.stopPropagation()
    activateTerminalInput()
  }

  const handleTerminalCopy = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const terminal = terminalRef.current as TerminalWithTextAreaSync | null
    const selection = terminal?.hasSelection?.() ? terminal.getSelection?.() : ''
    if (!selection) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', selection)
    terminal?.clearSelection?.()
  }

  onInputRef.current = props.onInput
  onResizeRef.current = props.onResize
  onInputAnchorCreatedRef.current = props.onInputAnchorCreated
  canReceiveInputRef.current = !isInputDisabled

  useEffect(() => {
    if (!terminalFrameRef.current) return

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      fontSize: 13,
      scrollback: 10000,
      theme: readTerminalTheme()
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(terminalFrameRef.current)

    const refreshVisibleTerminal = () => {
      const lastRow = Math.max(0, terminal.rows - 1)
      terminal.refresh(0, lastRow)
    }

    const safeFit = () => {
      if (document.hidden) return false
      const terminalFrame = terminalFrameRef.current
      if (!terminalFrame || terminalFrame.clientWidth === 0 || terminalFrame.clientHeight === 0) return false
      fitAddon.fit()
      return true
    }

    const initTimer = setTimeout(() => {
      if (safeFit()) refreshVisibleTerminal()
    }, TERMINAL_INIT_DELAY_MS)

    const disposable = terminal.onData((data) => {
      const sessionId = sessionIdRef.current
      if (!sessionId || !canReceiveInputRef.current) return
      collectInputAnchor(sessionId, data)
      onInputRef.current(sessionId, data)
    })

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      const sessionId = sessionIdRef.current
      if (sessionId) {
        onResizeRef.current(sessionId, cols, rows)
      }
    })

    ;(terminal as TerminalWithTextAreaSync).attachCustomKeyEventHandler?.((event) => {
      if (event.type !== 'keydown') return true

      const isCopyShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'c'
      const isPasteShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'v'

      if (isCopyShortcut) {
        const hasSelection = (terminal as TerminalWithTextAreaSync).hasSelection?.() ?? false
        if (!hasSelection) return true
        void copySelectionToClipboard().catch(() => undefined)
        return false
      }

      if (isPasteShortcut) {
        if (!navigator.clipboard?.readText) return true
        void navigator.clipboard.readText().then((text) => pasteTextToTerminal(text)).catch(() => undefined)
        return false
      }

      return true
    })

    const disposeSessionOutput = window.workerDesk.onSessionOutput((event: SessionOutputEvent) => {
      if (event.sessionId !== sessionIdRef.current) return
      if (isHydratingRef.current) return
      if (isRewritePendingRef.current) {
        postHydrationChunksRef.current.push(event.chunk)
        return
      }
      appendChunk(event.chunk)
    })

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimerRef.current !== null) {
        clearTimeout(resizeTimerRef.current)
      }
      resizeTimerRef.current = setTimeout(() => {
        if (safeFit()) refreshVisibleTerminal()
      }, TERMINAL_RESIZE_DELAY_MS)
    })
    resizeObserver.observe(terminalFrameRef.current)

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        setTimeout(() => {
          if (safeFit()) refreshVisibleTerminal()
        }, TERMINAL_RESIZE_DELAY_MS)
      }
    }

    const handleWindowFocus = () => {
      setTimeout(() => {
        if (safeFit()) refreshVisibleTerminal()
      }, TERMINAL_RESIZE_DELAY_MS)
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleWindowFocus)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    return () => {
      clearTimeout(initTimer)
      if (resizeTimerRef.current !== null) {
        clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = null
      }
      disposeSessionOutput()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleWindowFocus)
      resizeObserver.disconnect()
      resizeDisposable.dispose()
      disposable.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const terminal = terminalRef.current
      if (!terminal) return
      terminal.options.theme = readTerminalTheme()
      terminal.refresh(0, Math.max(0, terminal.rows - 1))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const sessionId = props.selectedSession?.id
    sessionIdRef.current = sessionId
    setIsTerminalFocused(false)
    syncVisibleInputAnchors(sessionId)
    hydratedBufferRef.current = ''
    pendingOutputRef.current = null
    postHydrationChunksRef.current = []
    isHydratingRef.current = false
    isRewritePendingRef.current = false

    if (!sessionId) {
      rewriteTerminal('请选择或启动一个 Session。', false)
      return
    }

    const hydrationGeneration = hydrationGenerationRef.current + 1
    hydrationGenerationRef.current = hydrationGeneration
    isHydratingRef.current = true

    void window.workerDesk.getOutputBuffer(sessionId).then((output) => {
      if (hydrationGenerationRef.current !== hydrationGeneration || sessionIdRef.current !== sessionId) return
      hydratedBufferRef.current = output
      isHydratingRef.current = false
      rewriteTerminal(output, Boolean(props.isVisible))
    }).catch(() => {
      if (hydrationGenerationRef.current !== hydrationGeneration || sessionIdRef.current !== sessionId) return
      hydratedBufferRef.current = ''
      isHydratingRef.current = false
      rewriteTerminal('', Boolean(props.isVisible))
    })
  }, [props.selectedSession?.id])

  useEffect(() => {
    if (!props.isVisible) return
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    const terminalFrame = terminalFrameRef.current
    if (!terminal || !fitAddon || !terminalFrame) return

    const timer = setTimeout(() => {
      if (fitVisibleTerminal()) {
        terminal.scrollToBottom()
        const lastRow = Math.max(0, terminal.rows - 1)
        terminal.refresh(0, lastRow)
        syncTextAreaToCursor()
      }
    }, TERMINAL_INIT_DELAY_MS)

    return () => clearTimeout(timer)
  }, [props.isVisible])

  return (
    <section className="panel terminal-pane">
      <div className="terminal-header">
        <div className="terminal-identity">
          <strong>{props.selectedSession ? `当前接管：${terminalWorkerName(props.selectedSession)}${props.selectedSession.workerType === 'claude-code' ? ` · ${props.selectedSession.title}` : ''}` : '当前接管：Terminal'}</strong>
          {props.selectedSession?.workerType === 'generic-agent' && props.parentSessionTitle ? (
            <span>来源：{props.parentSessionTitle}</span>
          ) : null}
          <span>状态：{terminalStatusLabel(props.selectedSession?.status)}</span>
        </div>
        <div className="terminal-header-actions">
          {props.selectedSession?.workerType === 'claude-code' && props.selectedSession.interactionMode === 'native-jsonl' ? (
            <button
              type="button"
              className="terminal-return-btn"
              onClick={() => props.onReturnToAiPane?.(props.selectedSession!.id)}
            >
              返回 AI 页面
            </button>
          ) : null}
          {canShowReturnAction ? (
            <button
              type="button"
              className="terminal-return-btn"
              disabled={!props.canReturnToParentClaude}
              onClick={() => props.onReturnToParentClaude?.(props.selectedSession!.id, props.selectedSession!.parentSessionId!)}
            >
              返回给 Claude Code
            </button>
          ) : null}
        </div>
      </div>
      {canShowMissionStrip ? (
        <div className="ga-mission-strip">
          {props.selectedSession?.dispatchTask ? (
            <div className="ga-mission-item ga-mission-task">
              <span className="ga-mission-label">Task</span>
              <strong className="ga-mission-value">{props.selectedSession.dispatchTask}</strong>
            </div>
          ) : null}
          {props.parentSessionTitle ? (
            <div className="ga-mission-item">
              <span className="ga-mission-label">From</span>
              <strong className="ga-mission-value">{props.parentSessionTitle}</strong>
            </div>
          ) : null}
        </div>
      ) : null}
      {failedSessionGuidance ? (
        <div className="terminal-failure-strip" role="note">
          <div className="terminal-failure-item">
            <span className="terminal-failure-label">发生了什么</span>
            <strong className="terminal-failure-value">{failedSessionGuidance.message}</strong>
          </div>
          <div className="terminal-failure-item">
            <span className="terminal-failure-label">下一步去哪里</span>
            <strong className="terminal-failure-value">{failedSessionGuidance.nextStep}</strong>
          </div>
          <div className="terminal-failure-item">
            <span className="terminal-failure-label">怎么继续</span>
            <strong className="terminal-failure-value">不要复活失败进程，请新建 Session 继续。</strong>
          </div>
        </div>
      ) : null}
      <div
        className="terminal-container"
        style={isInputDisabled ? { opacity: 0.6 } : undefined}
        onMouseDown={() => setIsTerminalFocused(true)}
        onMouseDownCapture={handleTerminalMouseDownCapture}
        onCopy={handleTerminalCopy}
      >
        {!isInputDisabled && !isTerminalFocused ? (
          <div className="terminal-input-hint">Click terminal to type</div>
        ) : null}
        <div className="terminal-body">
          <div
            className="terminal-frame"
            ref={terminalFrameRef}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
          />
          <div className="terminal-question-rail" aria-label="输入导航轨道">
            <div className="terminal-question-rail-line" aria-hidden="true" />
            {visibleInputAnchors.map((anchor) => (
              <button
                key={`${anchor.sessionId}-${anchor.id}`}
                type="button"
                className="terminal-question-anchor"
                title={anchor.summary}
                aria-label={`跳转到输入 ${anchor.id}：${anchor.summary}`}
                onClick={() => scrollToInputAnchor(anchor)}
              >
                {anchor.id}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
