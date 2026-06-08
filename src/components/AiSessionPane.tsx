import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { AiDiagnosticViewItem, AiToolStatus, AiToolViewItem, AiTurnStatus, AiTurnViewModel } from '../utils/aiEventViewModel'
import { buildAiTurnViewModel } from '../utils/aiEventViewModel'
import { isTerminalSessionStatus } from '../utils/sessionStatus'
import type { Session, SessionAiPermissionDenial, SessionAiEvent, SlashCommandSuggestion, SlashCommandSuggestionsInput, SlashCommandSuggestionsResult } from '../types/workerDesk'
import { SessionNavigationRail } from './SessionNavigationRail'

type AiSessionPaneProps = {
  selectedSession?: Session
  events: SessionAiEvent[]
  isSending?: boolean
  onSendMessage(sessionId: string, text: string): void | Promise<void>
  onSetTaskTitle?(sessionId: string, taskTitle: string): void
  onOpenModelControls?(): Promise<boolean | void> | boolean | void
  onSwitchToNativeTakeover?(session: Session, command: string): Promise<boolean | void> | boolean | void
  onListSlashCommandSuggestions?(input: SlashCommandSuggestionsInput): Promise<SlashCommandSuggestionsResult>
}

type SlashMenuState = {
  open: boolean
  query: string
  items: SlashCommandSuggestion[]
  highlightedIndex: number
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  message?: string
}

type ComposerAction =
  | { kind: 'model-settings' }
  | { kind: 'switch-to-native'; command: string }

const initialSlashMenuState: SlashMenuState = {
  open: false,
  query: '',
  items: [],
  highlightedIndex: 0,
  status: 'idle'
}

const SLASH_DISCOVERY_DEBOUNCE_MS = 120
const MESSAGE_STREAM_ZOOM_STORAGE_KEY = 'ai-worker-message-stream-zoom-factor'
const DEFAULT_MESSAGE_STREAM_ZOOM_FACTOR = 1
const MIN_MESSAGE_STREAM_ZOOM_FACTOR = 0.8
const MAX_MESSAGE_STREAM_ZOOM_FACTOR = 1.4
const MESSAGE_STREAM_ZOOM_FACTOR_STEP = 0.05

function readInitialMessageStreamZoomFactor(): number {
  if (typeof window === 'undefined') return DEFAULT_MESSAGE_STREAM_ZOOM_FACTOR
  const stored = window.localStorage.getItem(MESSAGE_STREAM_ZOOM_STORAGE_KEY)
  if (stored == null) return DEFAULT_MESSAGE_STREAM_ZOOM_FACTOR
  const parsed = Number(stored)
  return clampMessageStreamZoomFactor(Number.isFinite(parsed) ? parsed : DEFAULT_MESSAGE_STREAM_ZOOM_FACTOR)
}

function clampMessageStreamZoomFactor(factor: number): number {
  const clamped = Math.min(MAX_MESSAGE_STREAM_ZOOM_FACTOR, Math.max(MIN_MESSAGE_STREAM_ZOOM_FACTOR, factor))
  return Number(clamped.toFixed(2))
}

function nextMessageStreamZoomFactor(current: number, deltaY: number): number {
  return clampMessageStreamZoomFactor(current + (deltaY < 0 ? MESSAGE_STREAM_ZOOM_FACTOR_STEP : -MESSAGE_STREAM_ZOOM_FACTOR_STEP))
}

export function AiSessionPane(props: AiSessionPaneProps) {
  const [draft, setDraft] = useState('')
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [historyCursor, setHistoryCursor] = useState<number | undefined>(undefined)
  const [expandedToolResults, setExpandedToolResults] = useState<Record<string, boolean>>({})
  const [expandedExecutionBlocks, setExpandedExecutionBlocks] = useState<Record<string, boolean>>({})
  const [slashMenu, setSlashMenu] = useState<SlashMenuState>(initialSlashMenuState)
  const [composerNotice, setComposerNotice] = useState<string | undefined>(undefined)
  const [composerAction, setComposerAction] = useState<ComposerAction | undefined>(undefined)
  const [messageStreamZoomFactor, setMessageStreamZoomFactor] = useState(() => readInitialMessageStreamZoomFactor())
  const [hasUnreadEvents, setHasUnreadEvents] = useState(false)
  const [locatingTurnId, setLocatingTurnId] = useState<string | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const selectedSlashSuggestionRef = useRef<SlashCommandSuggestion | undefined>(undefined)
  const turnRefs = useRef(new Map<string, HTMLElement>())
  const shouldStickToBottomRef = useRef(true)
  const slashRequestSeqRef = useRef(0)
  const slashDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const turns = useMemo(() => buildAiTurnViewModel(props.events), [props.events])
  const navigationItems = useMemo(() => buildQuestionNavigationItems(turns), [turns])
  const hasPermissionBlocker = turns.some((turn) => turn.status === 'permission_denied')
  const startupTakeoverDiagnostic = findStartupTakeoverDiagnostic(turns)
  const canShowStartupTakeover = Boolean(
    props.selectedSession?.interactionMode === 'native-jsonl'
      && props.selectedSession.status === 'waiting'
      && startupTakeoverDiagnostic
      && props.onSwitchToNativeTakeover
  )
  const pendingResponseTurnId = props.selectedSession && isWaitingForAiResponse(props.selectedSession, turns)
    ? turns.at(-1)?.id
    : undefined
  const waitingForAiSummaryTurnId = props.selectedSession && isWaitingForAiSummary(props.selectedSession, turns)
    ? turns.at(-1)?.id
    : undefined
  const hasActiveRunningTurn = Boolean(
    props.selectedSession?.status === 'running' && turns.some(isActiveAiWorkTurn)
  )
  const shouldShowPendingSendHint = Boolean(
    props.selectedSession && (props.isSending || pendingResponseTurnId)
  )
  const isComposerDisabled = !props.selectedSession
    || props.selectedSession.interactionMode === 'pty'
    || isTerminalSessionStatus(props.selectedSession.status)
  const slashQuery = getSlashQuery(draft)
  const shouldShowSlashAssist = slashMenu.open
  const canSend = Boolean(
    !isComposerDisabled
      && props.selectedSession
      && draft.trim()
      && !props.isSending
      && props.selectedSession.status !== 'starting'
      && !hasActiveRunningTurn
  )

  useEffect(() => {
    window.localStorage.setItem(MESSAGE_STREAM_ZOOM_STORAGE_KEY, messageStreamZoomFactor.toString())
  }, [messageStreamZoomFactor])

  useEffect(() => {
    const stream = scrollRef.current
    if (!stream) return
    if (shouldStickToBottomRef.current) {
      stream.scrollTop = stream.scrollHeight
      setHasUnreadEvents(false)
    } else {
      setHasUnreadEvents(true)
    }
  }, [props.events.length, props.selectedSession?.id])

  useEffect(() => {
    setDraft('')
    setInputHistory([])
    setHistoryCursor(undefined)
    setExpandedToolResults({})
    setExpandedExecutionBlocks({})
    setSlashMenu(initialSlashMenuState)
    setComposerNotice(undefined)
    setComposerAction(undefined)
    selectedSlashSuggestionRef.current = undefined
    setHasUnreadEvents(false)
    setLocatingTurnId(undefined)
    shouldStickToBottomRef.current = true
  }, [props.selectedSession?.id])

  function requestSlashAssist(query: string, refresh = false) {
    if (slashDebounceRef.current) clearTimeout(slashDebounceRef.current)
    const session = props.selectedSession
    if (!session || !props.onListSlashCommandSuggestions) return
    const requestSeq = slashRequestSeqRef.current + 1
    slashRequestSeqRef.current = requestSeq
    setSlashMenu((current) => ({
      ...current,
      open: true,
      query,
      items: refresh ? [] : (current.query === query ? current.items : []),
      highlightedIndex: 0,
      status: 'loading',
      message: undefined
    }))

    slashDebounceRef.current = setTimeout(() => {
      props.onListSlashCommandSuggestions?.({
        projectId: session.projectId,
        query,
        limit: 40,
        refresh
      }).then((result) => {
        if (slashRequestSeqRef.current !== requestSeq) return
        setSlashMenu({
          open: true,
          query,
          items: result.items,
          highlightedIndex: 0,
          status: result.items.length > 0 ? 'ready' : 'empty',
          message: result.message
        })
      }).catch(() => {
        if (slashRequestSeqRef.current !== requestSeq) return
        setSlashMenu({
          open: true,
          query,
          items: [],
          highlightedIndex: 0,
          status: 'error',
          message: '暂时无法加载 slash 辅助能力；可以继续输入普通任务消息。'
        })
      })
    }, refresh ? 0 : SLASH_DISCOVERY_DEBOUNCE_MS)
  }

  useEffect(() => {
    if (slashDebounceRef.current) clearTimeout(slashDebounceRef.current)
    const session = props.selectedSession
    if (slashQuery == null || isComposerDisabled || !session || !props.onListSlashCommandSuggestions) {
      slashRequestSeqRef.current += 1
      setSlashMenu(initialSlashMenuState)
      return
    }

    requestSlashAssist(slashQuery)

    return () => {
      if (slashDebounceRef.current) clearTimeout(slashDebounceRef.current)
    }
  }, [isComposerDisabled, props.onListSlashCommandSuggestions, props.selectedSession, slashQuery])

  function handleStreamScroll() {
    const stream = scrollRef.current
    if (!stream) return
    const distanceFromBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight
    shouldStickToBottomRef.current = distanceFromBottom <= 24
    if (shouldStickToBottomRef.current) setHasUnreadEvents(false)
  }

  function handleStreamWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey) return
    event.preventDefault()
    setMessageStreamZoomFactor((current) => nextMessageStreamZoomFactor(current, event.deltaY))
  }

  function scrollToLatest() {
    const stream = scrollRef.current
    if (!stream) return
    stream.scrollTop = stream.scrollHeight
    shouldStickToBottomRef.current = true
    setHasUnreadEvents(false)
  }

  function scrollToTurn(turnId: string) {
    const stream = scrollRef.current
    const turnElement = turnRefs.current.get(turnId)
    if (!stream || !turnElement) return
    stream.scrollTop = turnElement.offsetTop - stream.offsetTop
    shouldStickToBottomRef.current = false
    setHasUnreadEvents(false)
    setLocatingTurnId(turnId)
  }

  function bindTurnElement(turnId: string) {
    return (element: HTMLElement | null) => {
      if (element) turnRefs.current.set(turnId, element)
      else turnRefs.current.delete(turnId)
    }
  }

  async function handleStartupTakeover() {
    const session = props.selectedSession
    if (!session || !props.onSwitchToNativeTakeover) return
    try {
      const result = await props.onSwitchToNativeTakeover(session, '')
      if (result === false) setComposerNotice('当前未能切到原生接管。请稍后重试。')
    } catch {
      setComposerNotice('当前未能切到原生接管。请稍后重试。')
    }
  }

  async function submitDraft() {
    const session = props.selectedSession
    const sessionId = session?.id
    const text = draft.trim()
    if (!sessionId || !text || !canSend) return

    const slashAction = resolveSlashSubmissionAction(text, selectedSlashSuggestionRef.current, slashMenu.items)
    if (slashAction?.kind === 'model-settings') {
      setComposerNotice('模型切换请使用左侧“模型”区域或“管理模型”。新的 Claude Code Session 会使用你选好的模型。')
      setComposerAction({ kind: 'model-settings' })
      setSlashMenu(initialSlashMenuState)
      return
    }

    if (slashAction?.kind === 'switch-to-native') {
      setComposerNotice('这项能力需要 Claude Code 原生界面。将切换当前 Session 到原生接管，不会新建会话。')
      setComposerAction({ kind: 'switch-to-native', command: slashAction.command })
      setSlashMenu(initialSlashMenuState)
      selectedSlashSuggestionRef.current = undefined
      return
    }

    try {
      await props.onSendMessage(sessionId, text)
      if (!session.taskTitle) props.onSetTaskTitle?.(sessionId, text)
      setInputHistory((current) => [...current.filter((item) => item !== text), text])
      setHistoryCursor(undefined)
      selectedSlashSuggestionRef.current = undefined
      setComposerNotice(undefined)
      setComposerAction(undefined)
      setDraft('')
      setSlashMenu(initialSlashMenuState)
      requestAnimationFrame(() => inputRef.current?.focus())
    } catch {
      return
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    await submitDraft()
  }

  async function handleComposerAction() {
    const action = composerAction
    const session = props.selectedSession
    if (!action || !session) return
    if (action.kind === 'model-settings') {
      const result = await props.onOpenModelControls?.()
      if (result === false) return
      setComposerNotice(undefined)
      setComposerAction(undefined)
      return
    }
    try {
      if (!props.onSwitchToNativeTakeover) {
        setComposerNotice(`当前未能切换 ${action.command} 到原生接管。请稍后重试。`)
        return
      }
      const result = await props.onSwitchToNativeTakeover(session, action.command)
      if (result === false) {
        setComposerNotice(`当前未能切换 ${action.command} 到原生接管。请稍后重试。`)
        return
      }
      setComposerNotice('已切换当前 Session 到 Claude Code 原生接管。')
      setComposerAction(undefined)
    } catch {
      setComposerNotice(`当前未能切换 ${action.command} 到原生接管。请稍后重试。`)
    }
  }

  function insertDraftLineBreak() {
    const input = inputRef.current
    if (!input) {
      setDraft((current) => `${current}\n`)
      return
    }
    const start = input.selectionStart
    const end = input.selectionEnd
    const nextDraft = `${draft.slice(0, start)}\n${draft.slice(end)}`
    setDraft(nextDraft)
    requestAnimationFrame(() => {
      input.selectionStart = start + 1
      input.selectionEnd = start + 1
    })
  }

  function showHistoryEntry(nextCursor: number | undefined) {
    if (nextCursor == null) {
      setHistoryCursor(undefined)
      setDraft('')
      return
    }
    setHistoryCursor(nextCursor)
    setDraft(inputHistory[nextCursor] ?? '')
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      const nextPosition = input.value.length
      input.selectionStart = nextPosition
      input.selectionEnd = nextPosition
    })
  }

  function canNavigateHistoryBackward(input: HTMLTextAreaElement): boolean {
    if (inputHistory.length === 0) return false
    return input.selectionStart === input.selectionEnd && input.selectionStart <= firstLineLength(input.value)
  }

  function canNavigateHistoryForward(input: HTMLTextAreaElement): boolean {
    if (inputHistory.length === 0 || historyCursor == null) return false
    return input.selectionStart === input.selectionEnd && input.selectionStart >= lastLineStart(input.value)
  }

  function handleHistoryNavigation(key: 'ArrowUp' | 'ArrowDown') {
    const input = inputRef.current
    if (!input) return false
    if (key === 'ArrowUp') {
      if (!canNavigateHistoryBackward(input)) return false
      const nextCursor = historyCursor == null ? inputHistory.length - 1 : Math.max(0, historyCursor - 1)
      showHistoryEntry(nextCursor)
      return true
    }
    if (!canNavigateHistoryForward(input) || historyCursor == null) return false
    const nextCursor = historyCursor + 1
    showHistoryEntry(nextCursor >= inputHistory.length ? undefined : nextCursor)
    return true
  }

  function selectSlashSuggestion(suggestion: SlashCommandSuggestion) {
    const nextDraft = suggestion.insertText
    selectedSlashSuggestionRef.current = suggestion
    setComposerNotice(undefined)
    setDraft(nextDraft)
    setSlashMenu(initialSlashMenuState)
    setHistoryCursor(undefined)
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      input.selectionStart = nextDraft.length
      input.selectionEnd = nextDraft.length
    })
  }

  function handleSlashMenuKeyDown(key: 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape'): boolean {
    if (key === 'Escape' && slashMenu.open) {
      setSlashMenu(initialSlashMenuState)
      return true
    }
    if (!slashMenu.open || slashMenu.items.length === 0) return false
    if (key === 'ArrowDown') {
      setSlashMenu((current) => ({
        ...current,
        highlightedIndex: (current.highlightedIndex + 1) % current.items.length
      }))
      return true
    }
    if (key === 'ArrowUp') {
      setSlashMenu((current) => ({
        ...current,
        highlightedIndex: current.highlightedIndex <= 0 ? current.items.length - 1 : current.highlightedIndex - 1
      }))
      return true
    }
    if (key === 'Enter' || key === 'Tab') {
      selectSlashSuggestion(slashMenu.items[slashMenu.highlightedIndex] ?? slashMenu.items[0])
      return true
    }
    return false
  }

  return (
    <section className="panel ai-session-pane">
      <div className="ai-session-body">
        <div className="ai-session-workspace">
          <div className="ai-event-stream-wrap">
            <div
              className="ai-event-stream scroll-container"
              ref={scrollRef}
              onScroll={handleStreamScroll}
              onWheel={handleStreamWheel}
              style={{ '--message-stream-zoom-factor': messageStreamZoomFactor } as React.CSSProperties}
            >
              {props.selectedSession ? (
                <>
                  {canShowStartupTakeover && startupTakeoverDiagnostic ? (
                    <div className="ai-startup-takeover-banner" role="alert">
                      <div className="ai-startup-takeover-copy">
                        <span>原生确认等待接管</span>
                        <strong>{startupTakeoverDiagnostic.message}</strong>
                      </div>
                      <button type="button" onClick={() => { void handleStartupTakeover() }}>切到原生接管</button>
                    </div>
                  ) : null}
                  {turns.length > 0 ? turns.map((turn) => (
                    <AiTurnRecord
                      key={turn.id}
                      turnElementRef={bindTurnElement(turn.id)}
                      turn={turn}
                      isLocating={locatingTurnId === turn.id}
                      expandedToolResults={expandedToolResults}
                      expandedExecutionBlocks={expandedExecutionBlocks}
                      hideStatus={turn.id === pendingResponseTurnId}
                      onLocateEnd={() => setLocatingTurnId((current) => current === turn.id ? undefined : current)}
                      onToggleExecutionBlock={(blockId) => setExpandedExecutionBlocks((current) => ({
                        ...current,
                        [blockId]: current[blockId] !== true
                      }))}
                      onToggleToolResult={(toolId) => setExpandedToolResults((current) => ({
                        ...current,
                        [toolId]: current[toolId] !== true
                      }))}
                    />
                  )) : (
                    shouldShowPendingSendHint ? null : <div className="ai-empty-state">{emptyStateText(props.selectedSession)}</div>
                  )}
                  {shouldShowPendingSendHint ? <div className="ai-pending-send-hint" role="status">已发送，等待 AI 开始处理。</div> : null}
                  {waitingForAiSummaryTurnId ? <div className="ai-pending-send-hint" role="status">工具已完成，等待 AI 总结。</div> : null}
                </>
              ) : (
                <div className="ai-empty-state">请选择或启动一个 Claude Code Session。</div>
              )}
            </div>
            {hasUnreadEvents ? (
              <button className="ai-new-events-button" type="button" onClick={scrollToLatest}>有新内容</button>
            ) : null}
          </div>
          <SessionNavigationRail ariaLabel="工作记录导航" items={navigationItems} onSelectItem={scrollToTurn} />
        </div>
        <form className="ai-composer" onSubmit={handleSubmit}>
          <div className="ai-composer-input-wrap">
            {shouldShowSlashAssist ? (
              <SlashAssistPopover
                state={slashMenu}
                onSelect={selectSlashSuggestion}
                onRefresh={() => requestSlashAssist(slashMenu.query, true)}
              />
            ) : null}
            {composerNotice ? (
              <div className="ai-composer-notice" role="alert">
                <span>{composerNotice}</span>
                {composerAction ? (
                  <button type="button" className="ai-inline-action" onClick={() => { void handleComposerAction() }}>
                    {composerAction.kind === 'model-settings' ? '去模型设置' : '切换当前 Session'}
                  </button>
                ) : null}
              </div>
            ) : null}
            <textarea
              ref={inputRef}
              value={draft}
              disabled={isComposerDisabled}
              placeholder={composerPlaceholder(props.selectedSession, hasPermissionBlocker)}
              rows={3}
              onChange={(event) => {
                selectedSlashSuggestionRef.current = undefined
                setComposerNotice(undefined)
                setComposerAction(undefined)
                setDraft(event.target.value)
                setHistoryCursor(undefined)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  if (handleSlashMenuKeyDown('Escape')) event.preventDefault()
                  return
                }
                if (event.key === 'Tab') {
                  if (handleSlashMenuKeyDown('Tab')) event.preventDefault()
                  return
                }
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                  if (handleSlashMenuKeyDown(event.key) || handleHistoryNavigation(event.key)) event.preventDefault()
                  return
                }
                if (event.key !== 'Enter') return
                if (event.metaKey || event.ctrlKey) {
                  event.preventDefault()
                  insertDraftLineBreak()
                  return
                }
                if (handleSlashMenuKeyDown('Enter')) {
                  event.preventDefault()
                  return
                }
                event.preventDefault()
                void submitDraft()
              }}
            />
          </div>
          <button type="submit" disabled={!canSend}>{props.isSending ? '发送中' : '发送'}</button>
        </form>
      </div>
    </section>
  )
}

function SlashAssistPopover(props: {
  state: SlashMenuState
  onSelect(suggestion: SlashCommandSuggestion): void
  onRefresh(): void
}) {
  const activeItemRef = useRef<HTMLButtonElement | null>(null)
  const hasItems = props.state.items.length > 0
  const groups = groupSlashItems(props.state.items)
  let flatIndex = 0

  useEffect(() => {
    const activeItem = activeItemRef.current
    if (typeof activeItem?.scrollIntoView !== 'function') return
    activeItem.scrollIntoView({ block: 'nearest' })
  }, [props.state.highlightedIndex, props.state.items])

  return (
    <div className="ai-slash-assist-popover" role="status">
      <div className="ai-slash-discovery-header">
        <strong>{hasItems ? 'Slash 辅助输入' : 'slash 辅助输入'}</strong>
        <span>{hasItems ? '选择只会填入输入框；当前 AI 输入页会把普通文本交给 Claude Code 处理。' : '没有可展示的能力项时，仍可输入普通任务消息。'}</span>
      </div>
      {hasItems ? (
        <div className="ai-slash-discovery-list" role="listbox" aria-label="Slash 命令能力发现">
          {groups.map((group) => (
            <div className="ai-slash-discovery-group" key={group.label}>
              <div className="ai-slash-discovery-group-title">{group.label}</div>
              {group.label === '当前 Claude Code 命令' ? (
                <div className="ai-slash-discovery-group-note">来自当前 Claude Code 安装证据；管理类命令会切到当前 Session 的 Claude Code 原生界面。</div>
              ) : null}
              {group.label === 'Skills' ? (
                <div className="ai-slash-discovery-group-note">Skills 会作为 /skill-name 发送到当前 Session；/skills 用于打开原生 Skills 列表。</div>
              ) : null}
              {group.items.map((item) => {
                const index = flatIndex
                flatIndex += 1
                return (
                  <button
                    key={item.id}
                    ref={index === props.state.highlightedIndex ? activeItemRef : undefined}
                    className={`ai-slash-discovery-item ${index === props.state.highlightedIndex ? 'is-active' : ''}`}
                    type="button"
                    role="option"
                    aria-selected={index === props.state.highlightedIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => props.onSelect(item)}
                  >
                    <span className="ai-slash-discovery-command">{item.displayText}{item.argumentHint ? ` ${item.argumentHint}` : ''}</span>
                    <span className="ai-slash-discovery-description">{item.description ?? item.groupLabel}</span>
                    <span className="ai-slash-discovery-source">{item.scopeLabel}</span>
                    <span className={`ai-slash-discovery-execution ${executionModeClassName(item)}`}>{executionModeLabel(item)}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      ) : (
        <div className="ai-slash-discovery-empty">
          <span>{props.state.status === 'loading'
            ? '正在加载可用功能…'
            : props.state.message ?? '可以继续输入普通任务消息；交互式 slash 命令请在 Claude Code 原生界面执行。'}</span>
          {props.state.status !== 'loading' ? (
            <button className="ai-slash-refresh-button" type="button" onMouseDown={(event) => event.preventDefault()} onClick={props.onRefresh}>刷新能力</button>
          ) : null}
        </div>
      )}
    </div>
  )
}

function groupSlashItems(items: SlashCommandSuggestion[]): Array<{ label: string; items: SlashCommandSuggestion[] }> {
  const groups: Array<{ label: string; items: SlashCommandSuggestion[] }> = []
  items.forEach((item) => {
    let group = groups.find((candidate) => candidate.label === item.groupLabel)
    if (!group) {
      group = { label: item.groupLabel, items: [] }
      groups.push(group)
    }
    group.items.push(item)
  })
  return groups
}

type AiReadableBlock =
  | { id: string; kind: 'question'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'execution'; tools: AiToolViewItem[] }
  | { id: string; kind: 'diagnostics'; label: string; diagnostics: AiDiagnosticViewItem[] }
  | { id: string; kind: 'permission-takeover'; label: string; text: string }
  | { id: string; kind: 'permission-blocker'; label: string; text: string }
  | { id: string; kind: 'status'; label: string; status: AiTurnStatus; text: string }

function AiTurnRecord(props: {
  turnElementRef?: (element: HTMLElement | null) => void
  turn: AiTurnViewModel
  isLocating?: boolean
  expandedToolResults: Record<string, boolean>
  expandedExecutionBlocks: Record<string, boolean>
  hideStatus?: boolean
  onLocateEnd(): void
  onToggleExecutionBlock(blockId: string): void
  onToggleToolResult(toolId: string): void
}) {
  const blocks = buildReadableBlocks(props.turn, props.hideStatus)
  const locatingBlockKind = getLocatingBlockKind(props.turn)

  return (
    <article ref={props.turnElementRef} className={`ai-turn-record ${turnStatusClassName(props.turn.status)}`}>
      {blocks.map((block) => (
        <AiReadableBlockView
          key={block.id}
          block={block}
          isLocating={props.isLocating && block.kind === locatingBlockKind}
          expandedToolResults={props.expandedToolResults}
          expandedExecutionBlocks={props.expandedExecutionBlocks}
          onLocateEnd={props.onLocateEnd}
          onToggleExecutionBlock={props.onToggleExecutionBlock}
          onToggleToolResult={props.onToggleToolResult}
        />
      ))}
    </article>
  )
}

function AiReadableBlockView(props: {
  block: AiReadableBlock
  isLocating?: boolean
  expandedToolResults: Record<string, boolean>
  expandedExecutionBlocks: Record<string, boolean>
  onLocateEnd(): void
  onToggleExecutionBlock(blockId: string): void
  onToggleToolResult(toolId: string): void
}) {
  const className = `ai-readable-block ai-turn-section ${props.block.kind === 'status' ? 'ai-turn-status' : readableBlockClassName(props.block.kind)} ${props.isLocating ? 'is-locating' : ''}`
  const locateEndHandler = props.isLocating ? props.onLocateEnd : undefined

  switch (props.block.kind) {
    case 'question':
    case 'assistant':
      return (
        <section className={className} data-block-kind={props.block.kind} onAnimationEnd={locateEndHandler}>
          <div className="ai-event-text">
            {props.block.kind === 'assistant' ? <AiMarkdownText text={props.block.text} /> : props.block.text}
          </div>
        </section>
      )
    case 'permission-takeover':
    case 'permission-blocker':
      return (
        <section className={className} data-block-kind={props.block.kind} onAnimationEnd={locateEndHandler}>
          <span className="ai-event-label">{props.block.label}</span>
          <div className={props.block.kind === 'permission-takeover' ? 'ai-takeover-hint' : 'ai-tool-denial'}>{props.block.text}</div>
        </section>
      )
    case 'execution': {
      const isExpanded = props.expandedExecutionBlocks[props.block.id] === true
      const summary = executionSummary(props.block.tools)
      return (
        <section className={className} data-block-kind={props.block.kind} onAnimationEnd={locateEndHandler}>
          <button
            className="ai-execution-summary"
            type="button"
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? '收起' : '展开'}执行过程：${summary.accessible}`}
            onClick={() => props.onToggleExecutionBlock(props.block.id)}
          >
            <span>{summary.text}</span>
            <span aria-hidden="true">{isExpanded ? '⌄' : '›'}</span>
          </button>
          {isExpanded ? (
            <div className="ai-tool-list">
              {props.block.tools.map((tool) => (
                <AiToolCard
                  key={tool.id}
                  tool={tool}
                  isResultExpanded={props.expandedToolResults[tool.id] === true}
                  onToggleResult={() => props.onToggleToolResult(tool.id)}
                />
              ))}
            </div>
          ) : null}
        </section>
      )
    }
    case 'diagnostics':
      return (
        <section className={className} data-block-kind={props.block.kind} onAnimationEnd={locateEndHandler}>
          <span className="ai-event-label">{props.block.label}</span>
          <div className="ai-diagnostic-list">
            {props.block.diagnostics.map((diagnostic) => <AiDiagnostic key={diagnostic.id} diagnostic={diagnostic} />)}
          </div>
        </section>
      )
    case 'status':
      return (
        <div className={className} data-block-kind={props.block.kind} onAnimationEnd={locateEndHandler}>
          <span>{props.block.label}</span>
          <span>{props.block.text}</span>
        </div>
      )
  }
}

function AiMarkdownText({ text }: { text: string }) {
  return <>{parseMarkdownBlocks(text)}</>
}

function parseMarkdownBlocks(text: string): React.ReactNode[] {
  const lines = text.split('\n')
  const blocks: React.ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      index += 1
      continue
    }

    const fenceMatch = /^```(\S*)?\s*$/.exec(line)
    if (fenceMatch) {
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push(
        <pre className="ai-markdown-code-block" key={`code-${index}`}>
          <code>{codeLines.join('\n')}</code>
        </pre>
      )
      continue
    }

    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line)
    if (headingMatch) {
      const level = headingMatch[1].length
      const content = parseMarkdownInline(headingMatch[2])
      if (level === 1) {
        blocks.push(<h1 className="ai-markdown-heading ai-markdown-heading-1" key={`heading-${index}`}>{content}</h1>)
      } else if (level === 2) {
        blocks.push(<h2 className="ai-markdown-heading ai-markdown-heading-2" key={`heading-${index}`}>{content}</h2>)
      } else {
        blocks.push(<h3 className="ai-markdown-heading ai-markdown-heading-3" key={`heading-${index}`}>{content}</h3>)
      }
      index += 1
      continue
    }

    const tableRows = parseMarkdownTable(lines, index)
    if (tableRows) {
      blocks.push(
        <div className="ai-markdown-table-wrap" key={`table-${index}`}>
          <table className="ai-markdown-table">
            <thead>
              <tr>{tableRows.headers.map((cell, cellIndex) => <th key={`h-${cellIndex}`}>{cell}</th>)}</tr>
            </thead>
            <tbody>
              {tableRows.rows.map((row, rowIndex) => (
                <tr key={`r-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      index = tableRows.nextIndex
      continue
    }

    const quoteLines: string[] = []
    while (index < lines.length) {
      const quoteMatch = /^\s*>\s?(.*)$/.exec(lines[index])
      if (!quoteMatch) break
      quoteLines.push(quoteMatch[1])
      index += 1
    }
    if (quoteLines.length > 0) {
      blocks.push(<blockquote className="ai-markdown-blockquote" key={`quote-${index}`}>{parseMarkdownInline(quoteLines.join('\n'))}</blockquote>)
      continue
    }

    const orderedItems: string[] = []
    while (index < lines.length) {
      const itemMatch = /^\s*\d+\.\s+(.+)$/.exec(lines[index])
      if (!itemMatch) break
      orderedItems.push(itemMatch[1])
      index += 1
    }
    if (orderedItems.length > 0) {
      blocks.push(
        <ol className="ai-markdown-list ai-markdown-ordered-list" key={`ordered-list-${index}`}>
          {orderedItems.map((item, itemIndex) => <li key={`${index}-${itemIndex}`}>{parseMarkdownInline(item)}</li>)}
        </ol>
      )
      continue
    }

    const listItems: string[] = []
    while (index < lines.length) {
      const itemMatch = /^\s*[-*]\s+(.+)$/.exec(lines[index])
      if (!itemMatch) break
      listItems.push(itemMatch[1])
      index += 1
    }
    if (listItems.length > 0) {
      blocks.push(
        <ul className="ai-markdown-list" key={`list-${index}`}>
          {listItems.map((item, itemIndex) => <li key={`${index}-${itemIndex}`}>{parseMarkdownInline(item)}</li>)}
        </ul>
      )
      continue
    }

    const paragraphLines = [line]
    index += 1
    while (index < lines.length && lines[index].trim() !== '' && !isMarkdownBlockStart(lines, index)) {
      paragraphLines.push(lines[index])
      index += 1
    }
    blocks.push(<p key={`p-${index}`}>{parseMarkdownInline(paragraphLines.join('\n'))}</p>)
  }

  return blocks
}

function isMarkdownBlockStart(lines: string[], index: number): boolean {
  const line = lines[index]
  return /^```/.test(line) || /^(#{1,3})\s+/.test(line) || /^\s*>\s?/.test(line) || /^\s*\d+\.\s+/.test(line) || /^\s*[-*]\s+/.test(line) || parseMarkdownTable(lines, index) !== undefined
}

type MarkdownTable = {
  headers: string[]
  rows: string[][]
  nextIndex: number
}

function parseMarkdownTable(lines: string[], index: number): MarkdownTable | undefined {
  if (index + 1 >= lines.length || !isTableLine(lines[index]) || !isTableSeparatorLine(lines[index + 1])) return undefined

  const headers = splitTableCells(lines[index])
  const rows: string[][] = []
  let nextIndex = index + 2
  while (nextIndex < lines.length && isTableLine(lines[nextIndex])) {
    rows.push(splitTableCells(lines[nextIndex]))
    nextIndex += 1
  }

  if (headers.length === 0 || rows.length === 0) return undefined
  return { headers, rows, nextIndex }
}

function isTableLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

function isTableSeparatorLine(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function splitTableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function parseMarkdownInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const pattern = /(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<]+|`[^`]+`|\*\*[^*]+\*\*)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    const token = match[0]
    const key = `${match.index}-${token}`
    const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token)
    if (linkMatch) {
      nodes.push(<a className="ai-markdown-link" href={linkMatch[2]} key={key} rel="noreferrer" target="_blank">{linkMatch[1]}</a>)
    } else if (token.startsWith('http://') || token.startsWith('https://')) {
      const { href, trailingText } = splitAutolinkToken(token)
      nodes.push(<a className="ai-markdown-link" href={href} key={key} rel="noreferrer" target="_blank">{href}</a>)
      if (trailingText) nodes.push(trailingText)
    } else if (token.startsWith('`')) {
      nodes.push(<code className="ai-markdown-inline-code" key={key}>{token.slice(1, -1)}</code>)
    } else {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    }
    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

function splitAutolinkToken(token: string): { href: string; trailingText: string } {
  const trailingMatch = /[。.,!?;:，。！？；：]+$/.exec(token)
  if (!trailingMatch) return { href: token, trailingText: '' }
  return { href: token.slice(0, trailingMatch.index), trailingText: trailingMatch[0] }
}

function buildReadableBlocks(turn: AiTurnViewModel, hideStatus = false): AiReadableBlock[] {
  const blocks: AiReadableBlock[] = []
  if (turn.userInput) blocks.push({ id: `${turn.id}:question`, kind: 'question', text: turn.userInput })
  if (turn.assistantOutput) blocks.push({ id: `${turn.id}:assistant`, kind: 'assistant', text: turn.assistantOutput })
  if (turn.tools.length > 0) blocks.push({ id: `${turn.id}:execution`, kind: 'execution', tools: turn.tools })
  if (turn.diagnostics.length > 0) blocks.push({ id: `${turn.id}:diagnostics`, kind: 'diagnostics', label: '诊断', diagnostics: turn.diagnostics })
  if (turn.permissionDenials.length > 0) {
    blocks.push({
      id: `${turn.id}:permission-takeover`,
      kind: 'permission-takeover',
      label: '需要接管',
      text: 'Claude Code 的权限请求没有被授予。请先处理权限，或在下方输入替代做法继续。'
    })
  }
  if (turn.permissionDenials.length > 0 && turn.tools.length === 0) {
    blocks.push({
      id: `${turn.id}:permission-blocker`,
      kind: 'permission-blocker',
      label: '接管阻塞',
      text: formatPermissionDenials(turn.permissionDenials)
    })
  }
  if (!hideStatus && turn.status !== 'completed' && turn.completionText) {
    blocks.push({
      id: `${turn.id}:status`,
      kind: 'status',
      label: turnStatusLabel(turn.status),
      status: turn.status,
      text: turn.completionText
    })
  }
  return blocks
}

function getLocatingBlockKind(turn: AiTurnViewModel): AiReadableBlock['kind'] | undefined {
  if (turn.userInput) return 'question'
  if (turn.permissionDenials.length > 0) return 'permission-takeover'
  if (turn.status === 'failed') return turn.diagnostics.length > 0 ? 'diagnostics' : 'status'
  return undefined
}

function readableBlockClassName(kind: AiReadableBlock['kind']): string {
  switch (kind) {
    case 'question': return 'user-input'
    case 'assistant': return 'assistant-output'
    case 'execution': return 'execution-process'
    case 'diagnostics': return 'diagnostics'
    case 'permission-takeover': return 'permission-takeover'
    case 'permission-blocker': return 'permission-blocker'
    case 'status': return ''
  }
}

function executionSummary(tools: AiToolViewItem[]): { text: string; accessible: string } {
  const countText = `${tools.length} 项`
  const statusText = executionStatusText(tools)
  const summaryText = statusText ? `${countText} · ${statusText}` : countText
  return {
    text: `执行过程 · ${summaryText}`,
    accessible: summaryText.replace(' · ', '，')
  }
}

function executionStatusText(tools: AiToolViewItem[]): string | undefined {
  const permissionCount = tools.filter((tool) => tool.status === 'permission_denied').length
  if (permissionCount > 0) return `${permissionCount} 项需要接管`
  const runningCount = tools.filter((tool) => tool.status === 'running').length
  if (runningCount > 0) return `${runningCount} 项运行中`
  const errorCount = tools.filter((tool) => tool.status === 'error').length
  if (errorCount === 0) return undefined
  return tools.some((tool) => tool.status === 'success') ? `${errorCount} 次重试` : `${errorCount} 项失败`
}

function AiToolCard(props: {
  tool: AiToolViewItem
  isResultExpanded: boolean
  onToggleResult(): void
}) {
  const shouldShowDetails = props.tool.status !== 'success' || props.tool.isResultTruncated
  const resultText = shouldShowDetails ? (props.isResultExpanded ? props.tool.resultText : props.tool.resultPreview) : undefined
  return (
    <article className={`ai-event-card tool ${toolStatusClassName(props.tool.status)}`}>
      <div className="ai-tool-header">
        <strong>
          <span className="ai-tool-kind">{props.tool.callKindLabel}</span>
          <span aria-hidden="true"> · </span>
          <span>{props.tool.callTitle}</span>
        </strong>
        {props.tool.status !== 'success' ? <span className="ai-tool-status" data-status={props.tool.status}>{toolStatusLabel(props.tool.status)}</span> : null}
      </div>
      {props.tool.callInstructionLabel && props.tool.callInstructionText ? (
        <div className="ai-tool-call-row">
          <span className="ai-tool-call-label">{props.tool.callInstructionLabel}：</span>
          <span className="ai-tool-call-value">{props.tool.callInstructionText}</span>
        </div>
      ) : null}
      {props.tool.resultSummary ? (
        <div className="ai-tool-call-row ai-tool-result-line">
          <span className="ai-tool-call-label">结果：</span>
          <span className="ai-tool-call-value">{props.tool.resultSummary}</span>
        </div>
      ) : null}
      {props.tool.permissionDenials.length > 0 ? (
        <div className="ai-tool-denial">{formatPermissionDenials(props.tool.permissionDenials)}</div>
      ) : null}
      {shouldShowDetails && props.tool.input != null ? <details className="ai-tool-details"><summary>完整参数</summary><pre>{formatUnknown(props.tool.input)}</pre></details> : null}
      {resultText && resultText !== props.tool.resultSummary ? (
        <div className="ai-tool-result-summary">
          <span className="ai-event-label">结果详情</span>
          <div className="ai-event-text">{resultText}</div>
        </div>
      ) : null}
      {props.tool.isResultTruncated ? (
        <button className="ai-inline-action" type="button" onClick={props.onToggleResult}>
          {props.isResultExpanded ? '收起结果' : '展开全部'}
        </button>
      ) : null}
    </article>
  )
}

function AiDiagnostic({ diagnostic }: { diagnostic: AiDiagnosticViewItem }) {
  if (diagnostic.level === 'error') {
    return <div className="ai-event-text">{diagnostic.message}</div>
  }
  return (
    <details className="ai-diagnostic-details">
      <summary>{diagnostic.level === 'warning' ? '警告详情' : '诊断详情'}</summary>
      <div className="ai-event-text">{diagnostic.message}</div>
    </details>
  )
}

function emptyStateText(session: Session): string {
  if (session.status === 'starting') return 'Session 正在启动，等待 Claude Code 初始化。'
  if (session.status === 'running') return 'Claude Code 已连接，等待输入。'
  if (session.status === 'waiting') return '等待用户输入。'
  if (session.status === 'exited') return '该 Session 已结束。'
  if (session.status === 'stopped') return '该 Session 已由用户停止。'
  if (session.status === 'failed') return '该 Session 启动或运行失败。'
  return '等待用户输入或 AI 输出。'
}

function buildQuestionNavigationItems(turns: AiTurnViewModel[]) {
  return turns
    .filter((turn) => turn.userInput || turn.status === 'failed' || turn.status === 'permission_denied')
    .map((turn, index) => ({
      id: turn.id,
      label: String(index + 1),
      title: navigationTitleForTurn(turn),
      status: turn.status
    }))
}

function navigationTitleForTurn(turn: AiTurnViewModel): string {
  if (turn.status === 'permission_denied') return '需要接管'
  const title = turn.userInput ?? turn.assistantOutput ?? turn.tools[0]?.inputSummary ?? turn.tools[0]?.name ?? turn.completionText
  return truncateNavigationTitle(title)
}

function findStartupTakeoverDiagnostic(turns: AiTurnViewModel[]): AiDiagnosticViewItem | undefined {
  return turns.flatMap((turn) => turn.diagnostics).find((diagnostic) => (
    diagnostic.message.includes('bypass permissions 安全确认')
    || diagnostic.message.includes('原生 PTY 接管')
  ))
}

function isActiveAiWorkTurn(turn: AiTurnViewModel): boolean {
  if (turn.status !== 'running') return false
  return Boolean(turn.userInput || turn.assistantOutput || turn.tools.length > 0 || turn.permissionDenials.length > 0)
}

function isWaitingForAiResponse(session: Session, turns: AiTurnViewModel[]): boolean {
  if (session.status !== 'running') return false
  const lastTurn = turns.at(-1)
  if (!lastTurn?.userInput) return false
  return !lastTurn.assistantOutput && lastTurn.tools.length === 0 && lastTurn.diagnostics.length === 0 && lastTurn.permissionDenials.length === 0
}

function isWaitingForAiSummary(session: Session, turns: AiTurnViewModel[]): boolean {
  if (session.interactionMode !== 'native-jsonl' || session.status !== 'running') return false
  const lastTurn = turns.at(-1)
  if (!lastTurn || lastTurn.status !== 'running') return false
  if (lastTurn.tools.length === 0) return false
  if (lastTurn.assistantOutput || lastTurn.diagnostics.length > 0 || lastTurn.permissionDenials.length > 0) return false
  return lastTurn.tools.every((tool) => tool.status === 'success')
}

function truncateNavigationTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 36) return normalized || '工作记录'
  return `${normalized.slice(0, 35)}…`
}

function getSlashQuery(text: string): string | undefined {
  if (!/^\/\S*$/.test(text)) return undefined
  return text.slice(1)
}

type SlashSubmissionAction =
  | { kind: 'model-settings'; command: string }
  | { kind: 'switch-to-native'; command: string }

function resolveSlashSubmissionAction(text: string, selectedSuggestion: SlashCommandSuggestion | undefined, visibleSuggestions: SlashCommandSuggestion[]): SlashSubmissionAction | undefined {
  const normalized = text.trim()
  if (!/^\/\S+$/.test(normalized)) return undefined
  const command = normalized.split(/\s+/, 1)[0]
  const behavior = slashBehaviorForCommand(command, selectedSuggestion, visibleSuggestions)
  if (behavior === 'app-action') return { kind: 'model-settings', command }
  if (behavior === 'switch-to-native') return { kind: 'switch-to-native', command }
  return undefined
}

function slashBehaviorForCommand(command: string, selectedSuggestion: SlashCommandSuggestion | undefined, visibleSuggestions: SlashCommandSuggestion[]) {
  const matched = selectedSuggestion?.displayText === command
    ? selectedSuggestion
    : visibleSuggestions.find((item) => item.displayText === command)
  if (matched?.behavior) return matched.behavior
  if (matched?.executionMode === 'native-interactive') return command === '/model' ? 'app-action' : 'switch-to-native'
  if (matched?.executionMode === 'assist-only') return 'insert-only'
  if (command === '/model') return 'app-action'
  if (KNOWN_NATIVE_TAKEOVER_SLASH_COMMANDS.has(command)) return 'switch-to-native'
  return undefined
}

const KNOWN_NATIVE_TAKEOVER_SLASH_COMMANDS = new Set([
  '/add-dir',
  '/agents',
  '/background',
  '/branch',
  '/clear',
  '/color',
  '/compact',
  '/config',
  '/context',
  '/copy',
  '/diff',
  '/hooks',
  '/keybindings',
  '/memory',
  '/mcp',
  '/model',
  '/permissions',
  '/plugin',
  '/reload-plugins',
  '/resume',
  '/rewind',
  '/skills',
  '/status',
  '/statusline',
  '/tasks',
  '/usage'
])

function executionModeLabel(item: SlashCommandSuggestion): string {
  if (item.category === 'skill') return '发送 Skill'
  if (item.category === 'file-command') return '发送 Command'
  const behavior = item.behavior ?? legacyBehaviorForExecutionMode(item.executionMode, item.displayText)
  switch (behavior) {
    case 'send-to-session': return '发送到当前 Session'
    case 'switch-to-native': return '当前 Session 原生接管'
    case 'insert-only': return '辅助发现'
    case 'app-action': return '应用内操作'
  }
}

function executionModeClassName(item: SlashCommandSuggestion): string {
  return `is-${item.behavior ?? legacyBehaviorForExecutionMode(item.executionMode, item.displayText)}`
}

function legacyBehaviorForExecutionMode(mode: SlashCommandSuggestion['executionMode'], displayText: string) {
  if (displayText === '/model') return 'app-action'
  if (mode === 'headless-message') return 'send-to-session'
  if (mode === 'assist-only') return 'insert-only'
  return 'switch-to-native'
}

function firstLineLength(text: string): number {
  const lineBreakIndex = text.indexOf('\n')
  return lineBreakIndex === -1 ? text.length : lineBreakIndex
}

function lastLineStart(text: string): number {
  const lineBreakIndex = text.lastIndexOf('\n')
  return lineBreakIndex === -1 ? 0 : lineBreakIndex + 1
}

function composerPlaceholder(session: Session | undefined, hasPermissionBlocker = false): string {
  if (!session) return '先选择一个 Claude Code Session'
  if (isTerminalSessionStatus(session.status)) return '该 Session 已结束，不能继续输入'
  if (session.interactionMode === 'pty') return '该 Session 使用终端接管输入'
  if (session.interactionMode === 'native-jsonl') return '输入给原生 Claude Code，Enter 发送，Ctrl/⌘ + Enter 换行'
  if (hasPermissionBlocker) return '权限阻塞：可处理权限后继续，或输入替代做法'
  return '输入给 AI 的消息，Enter 发送，Ctrl/⌘ + Enter 换行'
}

function turnStatusLabel(status: AiTurnStatus): string {
  switch (status) {
    case 'running': return '处理中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'permission_denied': return '权限阻塞'
  }
}

function turnStatusClassName(status: AiTurnStatus): string {
  switch (status) {
    case 'running': return 'is-running'
    case 'completed': return 'is-completed'
    case 'failed': return 'is-failed'
    case 'permission_denied': return 'is-permission-denied'
  }
}

function toolStatusLabel(status: AiToolStatus): string {
  switch (status) {
    case 'running': return '运行中'
    case 'success': return '成功'
    case 'error': return '失败'
    case 'permission_denied': return '权限未授予'
  }
}

function toolStatusClassName(status: AiToolStatus): string {
  switch (status) {
    case 'running': return 'is-running'
    case 'success': return 'is-success'
    case 'error': return 'is-error'
    case 'permission_denied': return 'is-permission-denied'
  }
}

function formatPermissionDenials(denials: SessionAiPermissionDenial[]): string {
  return `权限拒绝：${denials.map((denial) => {
    const toolName = denial.toolName ?? '工具'
    const input = formatPermissionInput(denial.toolInput)
    return input ? `${toolName} · ${input}` : toolName
  }).join('、')}`
}

function formatPermissionInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  if (typeof record.file_path === 'string') return record.file_path
  if (typeof record.command === 'string') return record.command
  if (typeof record.pattern === 'string') return record.pattern
  if (typeof record.url === 'string') return record.url
  return undefined
}

function formatUnknown(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
