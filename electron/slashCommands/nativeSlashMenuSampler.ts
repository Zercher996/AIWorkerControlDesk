import { existsSync } from 'node:fs'
import { join } from 'node:path'
import pty from 'node-pty'
import type { SlashAssistItem } from '../../src/types/workerDesk'
import { BUILTIN_CLAUDE_COMMANDS } from './builtinClaudeCommands'

type NativeSlashSamplerOptions = {
  claudePath?: string
  cwd?: string
  timeoutMs?: number
  inputDelayMs?: number
  text?: string
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_INPUT_DELAY_MS = 1_200

export async function sampleNativeSlashMenu(options: NativeSlashSamplerOptions = {}): Promise<SlashAssistItem[]> {
  const output = await captureNativeSlashMenu(options)
  return parseNativeSlashMenu(output)
}

export function parseNativeSlashMenu(output: string): SlashAssistItem[] {
  const lines = stripAnsi(output).split('\n')
  const fallbackByCommand = new Map(BUILTIN_CLAUDE_COMMANDS.map((item) => [item.displayText, item]))
  const seen = new Set<string>()
  const items: SlashAssistItem[] = []

  for (const line of lines) {
    const parsed = parseNativeMenuLine(line.trim(), fallbackByCommand)
    if (!parsed || seen.has(parsed.command)) continue
    seen.add(parsed.command)
    const nativeOrder = items.length
    const fallback = fallbackByCommand.get(parsed.command)
    items.push({
      id: `builtin-command:${parsed.command}`,
      displayText: parsed.command,
      insertText: `${parsed.command} `,
      title: parsed.command,
      description: parsed.description,
      kind: 'builtin-command',
      category: fallback?.category ?? 'native-management-command',
      scopeLabel: '当前安装',
      groupLabel: '当前 Claude Code 命令',
      confidence: 'native-evidence',
      priority: 2,
      behavior: fallback?.behavior ?? 'switch-to-native',
      executionMode: fallback?.executionMode ?? 'native-interactive',
      aliases: parsed.aliases,
      nativeOrder,
      evidence: {
        source: 'claude slash menu sample',
        excerpt: `${parsed.command}${parsed.aliases.length > 0 ? ` (${parsed.aliases.join(', ')})` : ''} ${parsed.evidenceDescription}`
      }
    })
  }

  return items
}

type ParsedNativeMenuLine = {
  command: string
  aliases: string[]
  description: string
  evidenceDescription: string
}

function parseNativeMenuLine(line: string, fallbackByCommand: Map<string, SlashAssistItem>): ParsedNativeMenuLine | undefined {
  const spaced = line.match(/^(\/[a-z][a-z0-9_-]*)(?:\s*\(([^)]*)\))?\s{2,}(.+)$/)
  if (spaced) {
    const command = spaced[1]
    const rawDescription = spaced[3]
    if (!command || !rawDescription) return undefined
    const fallback = fallbackByCommand.get(command)
    return {
      command,
      aliases: parseAliases(spaced[2]) ?? fallback?.aliases ?? [],
      description: normalizeDescription(rawDescription) ?? fallback?.description ?? '',
      evidenceDescription: normalizeDescription(rawDescription) ?? fallback?.description ?? ''
    }
  }

  const sticky = line.match(/^(\/[a-z][a-z0-9_-]*)(?:\(([^)]*)\))?([^\s].*)$/)
  if (!sticky) return undefined
  const stickyCommand = sticky[1]
  const stickyRemainder = sticky[3]
  if (!stickyCommand || !stickyRemainder) return undefined
  const exactFallback = fallbackByCommand.get(stickyCommand)
  if (exactFallback) {
    const fallbackDescription = exactFallback.description ?? ''
    const evidenceDescription = normalizeDescription(stickyRemainder) ?? fallbackDescription
    if (!fallbackDescription || !evidenceDescription) return undefined
    return {
      command: stickyCommand,
      aliases: parseAliases(sticky[2]) ?? exactFallback.aliases ?? [],
      description: fallbackDescription,
      evidenceDescription
    }
  }

  const recovered = recoverStickyCommand(line, fallbackByCommand)
  if (!recovered) return undefined
  const [command, fallback] = recovered
  const remainder = line.slice(command.length)
  const aliasMatch = remainder.match(/^\(([^)]*)\)/)
  const fallbackDescription = fallback.description ?? ''
  const evidenceDescription = normalizeDescription(remainder.slice(aliasMatch?.[0].length ?? 0)) ?? fallbackDescription
  if (!fallbackDescription || !evidenceDescription) return undefined
  return {
    command,
    aliases: parseAliases(aliasMatch?.[1]) ?? fallback.aliases ?? [],
    description: fallbackDescription,
    evidenceDescription
  }
}

function recoverStickyCommand(line: string, fallbackByCommand: Map<string, SlashAssistItem>): [string, SlashAssistItem] | undefined {
  return [...fallbackByCommand.entries()]
    .filter(([command]) => {
      if (!line.startsWith(command)) return false
      const next = line.charAt(command.length)
      return next === '(' || /[A-Z]/.test(next)
    })
    .sort((a, b) => b[0].length - a[0].length)[0]
}

async function captureNativeSlashMenu(options: NativeSlashSamplerOptions): Promise<string> {
  return await new Promise((resolve, reject) => {
    const claudePath = options.claudePath ?? resolveClaudeExecutable()
    let output = ''
    let finished = false
    const terminal = pty.spawn(claudePath, ['--bare'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, NO_COLOR: '1' }
    })

    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      try { terminal.kill() } catch { /* terminal already exited */ }
      if (error) reject(error)
      else resolve(output)
    }

    const timeout = setTimeout(() => finish(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    terminal.onData((data) => { output += data })
    terminal.onExit(({ exitCode }) => {
      if (!finished && output.length === 0) finish(new Error(`Claude slash menu sampler exited before output: ${exitCode}`))
    })
    setTimeout(() => terminal.write(options.text ?? '/'), options.inputDelayMs ?? DEFAULT_INPUT_DELAY_MS)
  })
}

function resolveClaudeExecutable(): string {
  const localWindows = join(process.env.USERPROFILE ?? '', '.local', 'bin', 'claude.exe')
  if (localWindows && existsSync(localWindows)) return localWindows
  return process.platform === 'win32' ? 'claude.exe' : 'claude'
}

function stripAnsi(input: string): string {
  const escape = String.fromCharCode(27)
  return input
    .replace(new RegExp(`${escape}\\][^]*(?:|${escape}\\\\)`, 'g'), '')
    .replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, 'g'), '')
    .replace(new RegExp(`${escape}[()][A-Za-z0-9]`, 'g'), '')
    .replace(/\r/g, '\n')
}

function parseAliases(input: string | undefined): string[] | undefined {
  if (!input) return undefined
  const aliases = input
    .split(/[,/|]/)
    .map((item) => item.trim())
    .filter(Boolean)
  return aliases.length > 0 ? aliases : undefined
}

function normalizeDescription(input: string): string | undefined {
  const normalized = input.replace(/\s+/g, ' ').trim()
  return normalized.length > 0 ? normalized : undefined
}
