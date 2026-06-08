import type { SessionAiEvent, SessionAiPermissionDenial } from '../types/workerDesk'

export const TOOL_RESULT_PREVIEW_CHAR_LIMIT = 1200

export type AiEventViewItem =
  | AiAssistantTextViewItem
  | AiUserMessageViewItem
  | AiToolViewItem
  | AiResultViewItem
  | AiDiagnosticViewItem

export type AiAssistantTextViewItem = {
  kind: 'assistant_text'
  id: string
  messageId?: string
  text: string
}

export type AiUserMessageViewItem = {
  kind: 'user_message'
  id: string
  text: string
}

export type AiToolStatus = 'running' | 'success' | 'error' | 'permission_denied'

export type AiToolViewItem = {
  kind: 'tool'
  id: string
  toolUseId?: string
  name: string
  input?: unknown
  inputSummary?: string
  status: AiToolStatus
  isOrphan: boolean
  resultText?: string
  resultPreview?: string
  isResultTruncated: boolean
  permissionDenials: SessionAiPermissionDenial[]
  callKindLabel: string
  callTitle: string
  callInstructionLabel?: string
  callInstructionText?: string
  resultSummary?: string
}

export type AiResultViewItem = {
  kind: 'result'
  id: string
  status: 'success' | 'error'
  text: string
  permissionDenials: SessionAiPermissionDenial[]
}

export type AiDiagnosticViewItem = {
  kind: 'diagnostic'
  id: string
  level: 'info' | 'warning' | 'error'
  message: string
}

export type AiTurnStatus = 'running' | 'completed' | 'failed' | 'permission_denied'

export type AiTurnViewModel = {
  id: string
  userInput?: string
  assistantOutput?: string
  tools: AiToolViewItem[]
  diagnostics: AiDiagnosticViewItem[]
  status: AiTurnStatus
  completionText: string
  permissionDenials: SessionAiPermissionDenial[]
}

export function buildAiEventViewModel(events: SessionAiEvent[]): AiEventViewItem[] {
  return buildAiTurnViewModel(events).flatMap(turnToLegacyItems)
}

export function summarizeCurrentAiTurn(turns: AiTurnViewModel[]): string {
  const currentTurn = turns.at(-1)
  if (!currentTurn) return '等待用户输入。'
  if (currentTurn.status === 'permission_denied') {
    const toolName = currentTurn.tools.find((tool) => tool.status === 'permission_denied')?.name
      ?? currentTurn.permissionDenials.find((denial) => denial.toolName)?.toolName
    return toolName ? `需要接管权限请求：${toolName}` : '需要接管权限请求'
  }
  if (currentTurn.status === 'failed') {
    const toolName = currentTurn.tools.find((tool) => tool.status === 'error')?.name
    return toolName ? `工具失败：${toolName}` : '当前回合失败，建议查看原因'
  }
  const runningTool = currentTurn.tools.find((tool) => tool.status === 'running')
  if (runningTool) return `正在运行工具：${runningTool.name}`
  if (currentTurn.status === 'running') return currentTurn.tools.length > 0 ? '' : 'AI 正在处理当前输入'
  return ''
}

export function buildAiTurnViewModel(events: SessionAiEvent[]): AiTurnViewModel[] {
  const turns: AiTurnViewModel[] = []
  let currentTurn: AiTurnViewModel | undefined
  let assistantMessageId: string | undefined
  const toolsByUseId = new Map<string, AiToolViewItem>()

  function ensureTurn(seedEventId: string): AiTurnViewModel {
    if (!currentTurn) {
      currentTurn = createTurn(seedEventId)
      turns.push(currentTurn)
      assistantMessageId = undefined
    }
    return currentTurn
  }

  function finishTurn(): void {
    currentTurn = undefined
    assistantMessageId = undefined
  }

  for (const event of events) {
    if (event.type === 'system') continue

    if (event.type === 'user_message') {
      currentTurn = createTurn(event.id)
      currentTurn.userInput = appendText(currentTurn.userInput, event.text)
      turns.push(currentTurn)
      assistantMessageId = undefined
      continue
    }

    if (event.type === 'assistant_text') {
      const turn = ensureTurn(event.id)
      if (assistantMessageId === undefined || assistantMessageId === event.messageId || event.messageId == null) {
        turn.assistantOutput = `${turn.assistantOutput ?? ''}${event.text}`
        assistantMessageId = event.messageId ?? assistantMessageId
      } else {
        finishTurn()
        const nextTurn = ensureTurn(event.id)
        nextTurn.assistantOutput = event.text
        assistantMessageId = event.messageId
      }
      continue
    }

    if (event.type === 'tool_use') {
      const turn = ensureTurn(event.id)
      const toolItem: AiToolViewItem = {
        kind: 'tool',
        id: event.id,
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
        inputSummary: summarizeToolInput(event.name, event.input),
        status: 'running',
        isOrphan: false,
        isResultTruncated: false,
        permissionDenials: [],
        callKindLabel: callKindLabelFor(event.name),
        callTitle: callTitleFor(event.name, event.input),
        callInstructionLabel: callInstructionLabelFor(event.name, event.input),
        callInstructionText: callInstructionTextFor(event.name, event.input)
      }
      turn.tools.push(toolItem)
      if (event.toolUseId) toolsByUseId.set(event.toolUseId, toolItem)
      updateTurnProgress(turn)
      continue
    }

    if (event.type === 'tool_result') {
      const result = createToolResultProjection(event.content, event.isError === true, event.errorKind)
      const pairedTool = event.toolUseId ? toolsByUseId.get(event.toolUseId) : undefined
      if (pairedTool) {
        pairedTool.status = result.status
        pairedTool.resultText = result.resultText
        pairedTool.resultPreview = result.resultPreview
        pairedTool.isResultTruncated = result.isResultTruncated
        pairedTool.resultSummary = resultSummaryFor(pairedTool)
        const pairedTurn = turns.find((turn) => turn.tools.includes(pairedTool))
        if (pairedTurn) updateTurnProgress(pairedTurn)
      } else {
        const turn = ensureTurn(event.id)
        turn.tools.push({
          kind: 'tool',
          id: event.id,
          toolUseId: event.toolUseId,
          name: '未知工具',
          inputSummary: undefined,
          status: result.status,
          isOrphan: true,
          resultText: result.resultText,
          resultPreview: result.resultPreview,
          isResultTruncated: result.isResultTruncated,
          permissionDenials: [],
          callKindLabel: '工具',
          callTitle: '未匹配调用',
          resultSummary: result.resultPreview
        })
        updateTurnProgress(turn)
      }
      continue
    }

    if (event.type === 'result') {
      const turn = ensureTurn(event.id)
      const permissionDenials = event.permissionDenials ?? []
      for (const denial of permissionDenials) {
        if (!denial.toolUseId) continue
        const pairedTool = toolsByUseId.get(denial.toolUseId)
        if (!pairedTool) continue
        pairedTool.status = 'permission_denied'
        pairedTool.permissionDenials = appendUniquePermissionDenial(pairedTool.permissionDenials, denial)
      }
      turn.permissionDenials = mergePermissionDenials(turn.permissionDenials, permissionDenials)
      turn.status = event.status === 'error'
        ? 'failed'
        : permissionDenials.length > 0
          ? 'permission_denied'
          : 'completed'
      turn.completionText = completionTextForResult()
      if (shouldUseResultAsAssistantOutput(event, turn, permissionDenials)) turn.assistantOutput = event.text
      finishTurn()
      continue
    }

    if (event.type === 'turn_end') {
      const turn = ensureTurn(event.id)
      turn.status = deriveFinishedTurnStatus(turn)
      turn.completionText = ''
      finishTurn()
      continue
    }

    const turn = ensureTurn(event.id)
    turn.diagnostics.push({ kind: 'diagnostic', id: event.id, level: event.level, message: event.message })
    if (event.level === 'error') turn.status = 'failed'
  }

  return turns
}

function createTurn(id: string): AiTurnViewModel {
  return {
    id,
    tools: [],
    diagnostics: [],
    status: 'running',
    completionText: '',
    permissionDenials: []
  }
}

function turnToLegacyItems(turn: AiTurnViewModel): AiEventViewItem[] {
  const items: AiEventViewItem[] = []
  if (turn.userInput) items.push({ kind: 'user_message', id: `${turn.id}:user`, text: turn.userInput })
  if (turn.assistantOutput) items.push({ kind: 'assistant_text', id: `${turn.id}:assistant`, text: turn.assistantOutput })
  items.push(...turn.tools)
  items.push(...turn.diagnostics)
  items.push({
    kind: 'result',
    id: `${turn.id}:result`,
    status: turn.status === 'failed' ? 'error' : 'success',
    text: turn.completionText,
    permissionDenials: turn.permissionDenials
  })
  return items
}

function appendText(current: string | undefined, next: string): string {
  return current ? `${current}\n${next}` : next
}

function deriveTurnStatus(turn: AiTurnViewModel, fallback: AiTurnStatus = 'running'): AiTurnStatus {
  if (turn.permissionDenials.length > 0 || turn.tools.some((tool) => tool.status === 'permission_denied')) return 'permission_denied'
  if (turn.tools.some((tool) => tool.status === 'error')) return 'failed'
  if (turn.tools.some((tool) => tool.status === 'running')) return 'running'
  return fallback
}

function deriveFinishedTurnStatus(turn: AiTurnViewModel): AiTurnStatus {
  if (turn.permissionDenials.length > 0 || turn.tools.some((tool) => tool.status === 'permission_denied')) return 'permission_denied'
  if (turn.assistantOutput) return 'completed'
  if (turn.tools.some((tool) => tool.status === 'error')) return 'failed'
  if (turn.tools.some((tool) => tool.status === 'running')) return 'running'
  return 'completed'
}

function updateTurnProgress(turn: AiTurnViewModel): void {
  turn.status = deriveTurnStatus(turn)
  turn.completionText = ''
}

function completionTextForResult(): string {
  return ''
}

function shouldUseResultAsAssistantOutput(event: Extract<SessionAiEvent, { type: 'result' }>, turn: AiTurnViewModel, permissionDenials: SessionAiPermissionDenial[]): boolean {
  if (turn.assistantOutput) return false
  if (event.status !== 'success') return false
  if (!event.text) return false
  if (permissionDenials.length > 0) return false
  return true
}

function summarizeToolInput(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return summarizeMcpToolName(toolName)
  const record = input as Record<string, unknown>
  const filePath = typeof record.file_path === 'string' ? record.file_path : undefined
  const command = typeof record.command === 'string' ? record.command : undefined
  const pattern = typeof record.pattern === 'string' ? record.pattern : undefined
  const path = typeof record.path === 'string' ? record.path : undefined
  const url = typeof record.url === 'string' ? record.url : undefined
  const libraryId = typeof record.libraryId === 'string' ? record.libraryId : undefined

  switch (toolName) {
    case 'Read': return filePath ? `读取 ${filePath}` : undefined
    case 'Write': return filePath ? `写入 ${filePath}` : undefined
    case 'Edit': return filePath ? `修改 ${filePath}` : undefined
    case 'MultiEdit': return filePath ? `批量修改 ${filePath}` : undefined
    case 'Bash': return command ? `执行 ${command}` : undefined
    case 'Grep': return pattern ? joinSummaryParts(`搜索 ${pattern}`, path) : undefined
    case 'Glob': return pattern ? joinSummaryParts(`匹配 ${pattern}`, path) : undefined
    case 'WebFetch': return url ? `访问 ${url}` : undefined
  }

  const mcpToolName = summarizeMcpToolName(toolName)
  if (mcpToolName) return joinSummaryParts(mcpToolName, libraryId ?? url ?? filePath ?? command ?? pattern)
  if (filePath) return filePath
  if (command) return command
  if (pattern) return pattern
  if (url) return url
  return undefined
}

function callKindLabelFor(toolName: string): string {
  if (parseMcpToolName(toolName)) return 'MCP'
  if (toolName === 'Bash') return '命令'
  if (toolName === 'Skill') return 'Skill'
  if (toolName === 'Slash') return 'Slash'
  return '工具'
}

function callTitleFor(toolName: string, input: unknown): string {
  const mcpTool = parseMcpToolName(toolName)
  if (mcpTool) return `${mcpTool.server} / ${mcpTool.tool}`
  if (toolName === 'Skill') return extractSkillTitle(input) ?? toolName
  if (toolName === 'Slash') return extractSlashTitle(input) ?? toolName
  return toolName
}

function callInstructionLabelFor(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  if (toolName === 'Skill') return typeof record.prompt === 'string' ? '指令' : undefined
  if (toolName === 'Slash') return typeof record.command === 'string' ? '命令' : typeof record.prompt === 'string' ? '指令' : undefined
  if (toolName === 'Bash') return typeof record.command === 'string' ? '命令' : undefined
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    return typeof record.file_path === 'string' ? '文件' : undefined
  }
  if (parseMcpToolName(toolName)) return callInstructionTextFor(toolName, input) ? '参数' : undefined
  if (typeof record.file_path === 'string') return '文件'
  if (typeof record.command === 'string') return '命令'
  if (typeof record.query === 'string') return '查询'
  if (typeof record.pattern === 'string') return '查询'
  if (typeof record.url === 'string') return '地址'
  return undefined
}

function callInstructionTextFor(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  const filePath = typeof record.file_path === 'string' ? record.file_path : undefined
  const command = typeof record.command === 'string' ? record.command : undefined
  const prompt = typeof record.prompt === 'string' ? record.prompt : undefined
  const pattern = typeof record.pattern === 'string' ? record.pattern : undefined
  const path = typeof record.path === 'string' ? record.path : undefined
  const url = typeof record.url === 'string' ? record.url : undefined
  const libraryId = typeof record.libraryId === 'string' ? record.libraryId : undefined
  const query = typeof record.query === 'string' ? record.query : undefined

  if (toolName === 'Skill') return prompt
  if (toolName === 'Slash') return command ?? prompt
  if (toolName === 'Bash') return command
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') return filePath
  if (toolName === 'Grep' || toolName === 'Glob') return joinSummaryParts(pattern ?? '', path) || undefined
  if (toolName === 'WebFetch') return url
  if (parseMcpToolName(toolName)) return libraryId ?? url ?? filePath ?? command ?? pattern ?? query
  return filePath ?? command ?? pattern ?? url ?? query ?? libraryId
}

function resultSummaryFor(tool: AiToolViewItem): string | undefined {
  if (tool.resultPreview) return tool.resultPreview
  if (tool.status === 'running') return undefined
  return undefined
}

function extractSkillTitle(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  const rawTitle = firstString(record.skillName, record.skill_name, record.name, record.skill, record.command)
  if (!rawTitle) return undefined
  return rawTitle.startsWith('/') ? rawTitle.slice(1) : rawTitle
}

function extractSlashTitle(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  return firstString(record.command, record.name, record.slashCommand, record.slash_command)
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

function parseMcpToolName(toolName: string): { server: string; tool: string } | undefined {
  const match = /^mcp__([^_]+)__(.+)$/.exec(toolName)
  if (!match) return undefined
  return {
    server: match[1],
    tool: match[2].replace(/_/g, '-')
  }
}

function joinSummaryParts(primary: string, secondary: string | undefined): string {
  return secondary ? `${primary} · ${secondary}` : primary
}

function summarizeMcpToolName(toolName: string): string | undefined {
  const parsed = parseMcpToolName(toolName)
  if (!parsed) return undefined
  return `MCP ${parsed.server}/${parsed.tool}`
}

function createToolResultProjection(
  content: string | undefined,
  isError: boolean,
  errorKind: 'permission_denied' | 'tool_error' | undefined
): Pick<AiToolViewItem, 'status' | 'resultText' | 'resultPreview' | 'isResultTruncated'> {
  const status: AiToolStatus = errorKind === 'permission_denied' ? 'permission_denied' : isError ? 'error' : 'success'
  const resultText = content || undefined
  const truncated = resultText ? truncateToolResult(resultText) : { preview: undefined, isTruncated: false }
  return {
    status,
    resultText,
    resultPreview: truncated.preview,
    isResultTruncated: truncated.isTruncated
  }
}

function truncateToolResult(text: string): { preview: string; isTruncated: boolean } {
  if (text.length <= TOOL_RESULT_PREVIEW_CHAR_LIMIT) return { preview: text, isTruncated: false }
  return {
    preview: `${text.slice(0, TOOL_RESULT_PREVIEW_CHAR_LIMIT).trimEnd()}\n…`,
    isTruncated: true
  }
}

function mergePermissionDenials(
  current: SessionAiPermissionDenial[],
  next: SessionAiPermissionDenial[]
): SessionAiPermissionDenial[] {
  return next.reduce(appendUniquePermissionDenial, current)
}

function appendUniquePermissionDenial(
  denials: SessionAiPermissionDenial[],
  denial: SessionAiPermissionDenial
): SessionAiPermissionDenial[] {
  if (denials.some((item) => item.toolUseId === denial.toolUseId && item.toolName === denial.toolName)) return denials
  return [...denials, denial]
}
