import { describe, expect, it } from 'vitest'
import { BUILTIN_CLAUDE_COMMANDS } from './builtinClaudeCommands'

describe('builtinClaudeCommands', () => {
  it('defines unique slash-prefixed Claude Code commands with native evidence and insert text', () => {
    expect(BUILTIN_CLAUDE_COMMANDS.length).toBeGreaterThan(0)

    const commands = BUILTIN_CLAUDE_COMMANDS.map((item) => item.displayText)
    expect(new Set(commands).size).toBe(commands.length)

    for (const item of BUILTIN_CLAUDE_COMMANDS) {
      expect(item.kind).toBe('builtin-command')
      expect(item.displayText).toMatch(/^\/\S+$/)
      expect(item.insertText).toBe(`${item.displayText} `)
      expect(item.description).toBeTruthy()
      expect(item.groupLabel).toBe('当前 Claude Code 命令')
      expect(item.scopeLabel).toBe('当前安装')
      expect(item.confidence).toBe('native-evidence')
      expect(item.category).toMatch(/^(native-task-command|native-management-command|desk-app-action)$/)
      expect(item.evidence).toEqual(expect.objectContaining({
        source: expect.any(String),
        excerpt: expect.any(String)
      }))
    }
  })

  it('assigns native-jsonl behavior to every builtin command', () => {
    for (const item of BUILTIN_CLAUDE_COMMANDS) {
      expect(item.behavior).toMatch(/^(send-to-session|switch-to-native|insert-only|app-action)$/)
    }
    expect(BUILTIN_CLAUDE_COMMANDS.find((item) => item.displayText === '/model')).toMatchObject({ behavior: 'app-action' })
    expect(BUILTIN_CLAUDE_COMMANDS.find((item) => item.displayText === '/plugin')).toMatchObject({ behavior: 'switch-to-native', category: 'native-management-command' })
    expect(BUILTIN_CLAUDE_COMMANDS.find((item) => item.displayText === '/mcp')).toMatchObject({ behavior: 'switch-to-native', category: 'native-management-command' })
    expect(BUILTIN_CLAUDE_COMMANDS.find((item) => item.displayText === '/permissions')).toMatchObject({ behavior: 'switch-to-native', category: 'native-management-command' })
    expect(BUILTIN_CLAUDE_COMMANDS.find((item) => item.displayText === '/skills')).toMatchObject({ behavior: 'switch-to-native', category: 'native-management-command' })
    expect(BUILTIN_CLAUDE_COMMANDS.find((item) => item.displayText === '/review')).toMatchObject({ behavior: 'send-to-session' })
  })

  it('keeps builtin commands as an evidence-backed ledger rather than guesses', () => {
    for (const item of BUILTIN_CLAUDE_COMMANDS) {
      expect(item.evidence?.source).toMatch(/claude/i)
      expect(item.evidence?.excerpt).toContain(item.displayText)
      expect(item.confidence).toBe('native-evidence')
    }

    expect(BUILTIN_CLAUDE_COMMANDS.find((item) => item.displayText === '/plugin')).toMatchObject({
      aliases: ['plugins'],
      evidence: {
        source: 'claude PTY slash menu filtered by /pl',
        excerpt: '/plugin (plugins) Manage Claude Code plugins'
      }
    })
    expect(BUILTIN_CLAUDE_COMMANDS.find((item) => item.displayText === '/skills')).toMatchObject({
      evidence: {
        source: 'claude PTY slash menu filtered by /sk',
        excerpt: '/skills List available skills'
      }
    })
  })

  it('includes only commands with current Claude Code evidence and excludes unverified reference commands', () => {
    const commands = BUILTIN_CLAUDE_COMMANDS.map((item) => item.displayText)

    expect(commands).toEqual(expect.arrayContaining([
      '/btw',
      '/context',
      '/model',
      '/permissions',
      '/clear',
      '/compact',
      '/usage',
      '/init',
      '/mcp',
      '/plugin',
      '/skills'
    ]))
    expect(commands).not.toContain('/ask')
  })
})
