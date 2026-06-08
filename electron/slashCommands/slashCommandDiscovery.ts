import { homedir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { open, readdir } from 'node:fs/promises'
import type { Project, SlashAssistItem, SlashAssistKind, SlashAssistQueryInput, SlashAssistQueryResult } from '../../src/types/workerDesk'
import { BUILTIN_CLAUDE_COMMANDS } from './builtinClaudeCommands'
import { sampleNativeSlashMenu as defaultSampleNativeSlashMenu } from './nativeSlashMenuSampler'

type SlashCommandDiscoveryOptions = {
  listProjects(): Promise<Project[]>
  userCommandsDir?: string
  userSkillsDir?: string
  cacheTtlMs?: number
  nativeCommandCacheTtlMs?: number
  sampleNativeSlashMenu?: (input?: { text?: string }) => Promise<SlashAssistItem[]>
  now?: () => number
}

type SourceConfig = {
  kind: SlashAssistKind
  scopeLabel: string
  groupLabel: string
  rootDir: string
  priority: number
}

type CacheEntry = {
  expiresAt: number
  result: SlashAssistQueryResult
}

export type SlashCommandDiscovery = {
  listSlashAssistIndex(input: SlashAssistQueryInput): Promise<SlashAssistQueryResult>
  listSuggestions(input: SlashAssistQueryInput): Promise<SlashAssistQueryResult>
}

const DEFAULT_CACHE_TTL_MS = 20_000
const DEFAULT_NATIVE_COMMAND_CACHE_TTL_MS = 5 * 60_000
const DEFAULT_LIMIT = 40
const MAX_LIMIT = 80
const MAX_DEPTH = 4
const MAX_FILES_PER_SOURCE = 300
const MAX_READ_BYTES = 4096

export function createSlashCommandDiscovery(options: SlashCommandDiscoveryOptions): SlashCommandDiscovery {
  const cache = new Map<string, CacheEntry>()
  const inFlight = new Map<string, Promise<SlashAssistQueryResult>>()
  let nativeCommandCache: { expiresAt: number; items: SlashAssistItem[] } | undefined
  let nativeCommandInFlight: Promise<SlashAssistItem[]> | undefined
  const now = options.now ?? Date.now
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const nativeCommandCacheTtlMs = options.nativeCommandCacheTtlMs ?? DEFAULT_NATIVE_COMMAND_CACHE_TTL_MS
  const sampleNativeSlashMenu = options.sampleNativeSlashMenu ?? defaultSampleNativeSlashMenu
  const userCommandsDir = options.userCommandsDir ?? join(homedir(), '.claude', 'commands')
  const userSkillsDir = options.userSkillsDir ?? join(homedir(), '.claude', 'skills')

  async function listSlashAssistIndex(input: SlashAssistQueryInput): Promise<SlashAssistQueryResult> {
    const query = normalizeQuery(input.query)
    const limit = normalizeLimit(input.limit)
    const cacheKey = `${input.projectId ?? ''}\0${query}\0${limit}`
    const cached = cache.get(cacheKey)
    const currentTime = now()
    if (!input.refresh && cached && cached.expiresAt > currentTime) return cached.result

    const existing = inFlight.get(cacheKey)
    if (!input.refresh && existing) return existing

    const request = discover(input.projectId, query, limit, Boolean(input.refresh))
      .then((result) => {
        cache.set(cacheKey, { result, expiresAt: now() + cacheTtlMs })
        return result
      })
      .finally(() => {
        inFlight.delete(cacheKey)
      })
    inFlight.set(cacheKey, request)
    return request
  }

  async function discover(projectId: string | undefined, query: string, limit: number, refreshNativeCommands: boolean): Promise<SlashAssistQueryResult> {
    try {
      const { commandSources, skillSources } = await resolveSources(projectId)
      const commandScans = await Promise.all(commandSources.map((source) => scanCommandSource(source)))
      const skillScans = await Promise.all(skillSources.map((source) => scanSkillSource(source)))
      const nativeCommands = await getNativeCommands(refreshNativeCommands, query)
      const scanned = [...commandScans, ...skillScans]
      const hasPartial = scanned.some((result) => result.partial)
      const allItems = [
        ...scanned.flatMap((result) => result.items),
        ...nativeCommands
      ]
      const deduped = dedupeAssistItems(allItems)
      const filtered = filterAssistItems(deduped, query).slice(0, limit)
      const sourceStatus: SlashAssistQueryResult['sourceStatus'] = filtered.length > 0
        ? (hasPartial ? 'partial' : 'ready')
        : (hasPartial ? 'partial' : 'empty')

      return {
        items: filtered,
        sourceStatus,
        message: filtered.length > 0
          ? undefined
          : '没有匹配的补全项。可以继续输入普通任务消息。',
        refreshedAt: new Date(now()).toISOString()
      }
    } catch {
      return {
        items: [],
        sourceStatus: 'unavailable',
        message: '暂时无法加载 slash 辅助能力；可以继续输入普通任务消息。',
        refreshedAt: new Date(now()).toISOString()
      }
    }
  }

  async function getNativeCommands(refresh: boolean, query: string): Promise<SlashAssistItem[]> {
    const currentTime = now()
    if (!refresh && nativeCommandCache && nativeCommandCache.expiresAt > currentTime) return nativeCommandCache.items
    if (!refresh && nativeCommandInFlight) return nativeCommandInFlight

    const sampleInput = refresh && shouldSampleNativePrefix(query) ? { text: `/${query}` } : undefined
    const sampleRequest = sampleInput ? sampleNativeSlashMenu(sampleInput) : sampleNativeSlashMenu()
    nativeCommandInFlight = sampleRequest
      .then((items) => {
        const nativeLedgerByCommand = new Map(BUILTIN_CLAUDE_COMMANDS.map((item) => [item.displayText, item]))
        const normalizedItems = items.map((item) => {
          const ledgerItem = nativeLedgerByCommand.get(item.displayText)
          return {
            ...item,
            category: item.category ?? ledgerItem?.category ?? categoryForBehavior(item.behavior ?? ledgerItem?.behavior ?? 'switch-to-native'),
            behavior: item.behavior ?? ledgerItem?.behavior ?? 'switch-to-native',
            executionMode: item.executionMode ?? ledgerItem?.executionMode ?? 'native-interactive'
          }
        })
        const commands = normalizedItems.length > 0 ? [...normalizedItems, ...BUILTIN_CLAUDE_COMMANDS] : BUILTIN_CLAUDE_COMMANDS
        nativeCommandCache = { items: commands, expiresAt: now() + nativeCommandCacheTtlMs }
        return commands
      })
      .catch(() => {
        nativeCommandCache = { items: BUILTIN_CLAUDE_COMMANDS, expiresAt: now() + nativeCommandCacheTtlMs }
        return BUILTIN_CLAUDE_COMMANDS
      })
      .finally(() => {
        nativeCommandInFlight = undefined
      })
    return nativeCommandInFlight
  }

  async function resolveSources(projectId: string | undefined): Promise<{ commandSources: SourceConfig[]; skillSources: SourceConfig[] }> {
    const commandSources: SourceConfig[] = []
    const skillSources: SourceConfig[] = []
    if (projectId) {
      const projects = await options.listProjects()
      const project = projects.find((item) => item.id === projectId)
      if (project) {
        commandSources.push({
          kind: 'project-command',
          scopeLabel: '当前项目',
          groupLabel: '当前项目 Commands',
          rootDir: join(project.path, '.claude', 'commands'),
          priority: 0
        })
        skillSources.push({
          kind: 'project-skill',
          scopeLabel: '项目 Skill',
          groupLabel: 'Skills',
          rootDir: join(project.path, '.claude', 'skills'),
          priority: 3
        })
      }
    }
    commandSources.push({
      kind: 'user-command',
      scopeLabel: '用户全局',
      groupLabel: '用户 Commands',
      rootDir: userCommandsDir,
      priority: 1
    })
    skillSources.push({
      kind: 'user-skill',
      scopeLabel: '用户 Skill',
      groupLabel: 'Skills',
      rootDir: userSkillsDir,
      priority: 4
    })
    return { commandSources, skillSources }
  }

  return { listSlashAssistIndex, listSuggestions: listSlashAssistIndex }
}

function categoryForBehavior(behavior: NonNullable<SlashAssistItem['behavior']>): NonNullable<SlashAssistItem['category']> {
  if (behavior === 'send-to-session') return 'native-task-command'
  if (behavior === 'app-action') return 'desk-app-action'
  if (behavior === 'insert-only') return 'skill'
  return 'native-management-command'
}

function shouldSampleNativePrefix(query: string): boolean {
  return query.length >= 2 && /^[-a-z0-9_]+$/i.test(query)
}

async function scanCommandSource(source: SourceConfig): Promise<{ items: SlashAssistItem[]; partial: boolean }> {
  const items: SlashAssistItem[] = []
  let visitedFiles = 0
  let partial = false

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || visitedFiles >= MAX_FILES_PER_SOURCE) {
      partial = true
      return
    }

    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1)
        if (visitedFiles >= MAX_FILES_PER_SOURCE) partial = true
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      if (visitedFiles >= MAX_FILES_PER_SOURCE) {
        partial = true
        break
      }
      visitedFiles += 1
      const suggestion = await readCommandFile(source, fullPath).catch(() => undefined)
      if (suggestion) items.push(suggestion)
    }
  }

  await walk(source.rootDir, 0)
  return { items, partial }
}

async function scanSkillSource(source: SourceConfig): Promise<{ items: SlashAssistItem[]; partial: boolean }> {
  const items: SlashAssistItem[] = []
  let visitedFiles = 0
  let partial = false
  const entries = await readdir(source.rootDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue
    if (visitedFiles >= MAX_FILES_PER_SOURCE) {
      partial = true
      break
    }
    visitedFiles += 1
    const skillFilePath = join(source.rootDir, entry.name, 'SKILL.md')
    const item = await readSkillFile(source, skillFilePath, entry.name).catch(() => undefined)
    if (item) items.push(item)
  }
  return { items, partial }
}

async function readCommandFile(source: SourceConfig, filePath: string): Promise<SlashAssistItem | undefined> {
  const command = commandNameFromPath(source.rootDir, filePath)
  if (!command) return undefined
  const text = await readFilePrefix(filePath, MAX_READ_BYTES)
  const { description, title, argumentHint } = extractCommandMetadata(text, command)
  return {
    id: `${source.kind}:${command}`,
    displayText: command,
    insertText: `${command} `,
    title,
    description,
    kind: source.kind,
    category: 'file-command',
    scopeLabel: source.scopeLabel,
    groupLabel: source.groupLabel,
    argumentHint,
    confidence: 'file-backed',
    priority: source.priority,
    behavior: 'send-to-session',
    executionMode: 'headless-message'
  }
}

async function readSkillFile(source: SourceConfig, filePath: string, fallbackName?: string): Promise<SlashAssistItem | undefined> {
  const text = await readFilePrefix(filePath, MAX_READ_BYTES)
  const name = fallbackName ?? basename(join(filePath, '..'))
  if (!name) return undefined
  const command = `/${name}`
  const { description, title, argumentHint } = extractSkillMetadata(text, name)
  return {
    id: `${source.kind}:${name}`,
    displayText: command,
    insertText: `${command} `,
    title,
    description,
    kind: source.kind,
    category: 'skill',
    scopeLabel: source.scopeLabel,
    groupLabel: source.groupLabel,
    argumentHint,
    confidence: 'file-backed',
    priority: source.priority,
    behavior: 'send-to-session',
    executionMode: 'headless-message'
  }
}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<string> {
  const file = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await file.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf-8')
  } finally {
    await file.close()
  }
}

function commandNameFromPath(rootDir: string, filePath: string): string | undefined {
  const relativePath = relative(rootDir, filePath)
  if (!relativePath || relativePath.startsWith('..')) return undefined
  const withoutExtension = relativePath.replace(/\.md$/i, '')
  const normalized = withoutExtension.split(sep).join('/').replace(/\\/g, '/')
  if (!normalized || normalized.includes('..')) return undefined
  return `/${normalized}`
}

function extractCommandMetadata(text: string, command: string): { title: string; description?: string; argumentHint?: string } {
  const frontmatter = parseFrontmatter(text)
  const description = firstString(frontmatter.description) ?? firstContentLine(text)
  const argumentHint = firstString(frontmatter.argumentHint) ?? firstString(frontmatter.argument_hint)
  return {
    title: command,
    description: truncateText(description, 140),
    argumentHint: truncateText(argumentHint, 80)
  }
}

function extractSkillMetadata(text: string, name: string): { title: string; description?: string; argumentHint?: string } {
  const frontmatter = parseFrontmatter(text)
  const description = firstString(frontmatter.description) ?? firstContentLine(text)
  const argumentHint = firstString(frontmatter.argumentHint) ?? firstString(frontmatter['argument-hint']) ?? firstString(frontmatter.argument_hint)
  return {
    title: name,
    description: truncateText(description, 140),
    argumentHint: truncateText(argumentHint, 80)
  }
}

function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end === -1) return {}
  const body = text.slice(3, end).trim()
  const result: Record<string, string> = {}
  body.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) return
    result[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim()
  })
  return result
}

function firstString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function firstContentLine(text: string): string | undefined {
  const withoutFrontmatter = text.startsWith('---')
    ? text.slice(Math.max(0, text.indexOf('\n---', 3) + 4))
    : text
  const line = withoutFrontmatter
    .split(/\r?\n/)
    .map((item) => item.replace(/^#+\s*/, '').trim())
    .find((item) => item.length > 0 && !item.startsWith('---'))
  return line
}

function truncateText(text: string | undefined, maxLength: number): string | undefined {
  if (!text) return undefined
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}…`
}

function dedupeAssistItems(items: SlashAssistItem[]): SlashAssistItem[] {
  const commandByDisplayText = new Map<string, SlashAssistItem>()
  const skills: SlashAssistItem[] = []
  items.forEach((item) => {
    if (item.kind === 'project-skill' || item.kind === 'user-skill') {
      skills.push(item)
      return
    }
    const existing = commandByDisplayText.get(item.displayText)
    if (!existing || item.priority < existing.priority) {
      commandByDisplayText.set(item.displayText, item)
    }
  })
  return [...commandByDisplayText.values(), ...skills].sort((a, b) => {
    const priorityDiff = a.priority - b.priority
    return priorityDiff === 0 ? a.displayText.localeCompare(b.displayText) : priorityDiff
  })
}

function filterAssistItems(items: SlashAssistItem[], query: string): SlashAssistItem[] {
  if (!query) return items
  const normalizedQuery = query.toLowerCase()
  const slashQuery = normalizedQuery.startsWith('/') ? normalizedQuery : `/${normalizedQuery}`
  return items
    .map((item) => ({ item, rank: slashMatchRank(item, normalizedQuery, slashQuery) }))
    .filter((entry): entry is { item: SlashAssistItem; rank: number } => entry.rank != null)
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      const priorityDiff = a.item.priority - b.item.priority
      if (priorityDiff !== 0) return priorityDiff
      const nativeOrderDiff = (a.item.nativeOrder ?? Number.MAX_SAFE_INTEGER) - (b.item.nativeOrder ?? Number.MAX_SAFE_INTEGER)
      return nativeOrderDiff === 0 ? a.item.displayText.localeCompare(b.item.displayText) : nativeOrderDiff
    })
    .map((entry) => entry.item)
}

function slashMatchRank(item: SlashAssistItem, normalizedQuery: string, slashQuery: string): number | undefined {
  const displayText = item.displayText.toLowerCase()
  if (displayText.startsWith(slashQuery)) return 0
  if (item.aliases?.some((alias) => alias.toLowerCase().startsWith(normalizedQuery))) return 1
  if ((item.description ?? '').toLowerCase().includes(normalizedQuery)) return 2
  return undefined
}

function normalizeQuery(query: string | undefined): string {
  const trimmed = query?.trim() ?? ''
  return trimmed.startsWith('/') ? trimmed.slice(1).toLowerCase() : trimmed.toLowerCase()
}

function normalizeLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
}
