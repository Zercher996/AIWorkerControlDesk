import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Project, SlashAssistItem } from '../../src/types/workerDesk'
import { createSlashCommandDiscovery } from './slashCommandDiscovery'

function project(id: string, path: string): Project {
  return {
    id,
    name: 'Project',
    path,
    createdAt: '2026-05-30T00:00:00.000Z',
    lastUsedAt: '2026-05-30T00:00:00.000Z',
    autoDispatchGenericAgent: false
  }
}

async function writeCommand(root: string, relativePath: string, content: string) {
  const filePath = join(root, relativePath)
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(filePath, content, 'utf-8')
}

async function writeSkill(root: string, name: string, content: string) {
  const filePath = join(root, name, 'SKILL.md')
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(filePath, content, 'utf-8')
}

function sampledCommand(command: string, nativeOrder = 0): SlashAssistItem {
  return {
    id: `builtin-command:${command}`,
    displayText: command,
    insertText: `${command} `,
    title: command,
    description: `${command} sampled`,
    kind: 'builtin-command',
    scopeLabel: '当前安装',
    groupLabel: '当前 Claude Code 命令',
    confidence: 'native-evidence',
    priority: 2,
    behavior: 'switch-to-native',
    executionMode: 'native-interactive',
    nativeOrder,
    evidence: { source: 'test sampler', excerpt: command }
  }
}

function createTestSlashCommandDiscovery(options: Parameters<typeof createSlashCommandDiscovery>[0]) {
  return createSlashCommandDiscovery({
    sampleNativeSlashMenu: async () => [
      sampledCommand('/claude-api', 0),
      sampledCommand('/clear', 1),
      sampledCommand('/compact', 2),
      sampledCommand('/config', 3),
      sampledCommand('/context', 4),
      sampledCommand('/copy', 5),
      { ...sampledCommand('/usage', 6), aliases: ['cost'], description: 'Show session cost, plan usage, and activity stats' },
      { ...sampledCommand('/resume', 7), aliases: ['continue'], description: 'Resume a previous conversation' },
      sampledCommand('/model', 8),
      sampledCommand('/permissions', 9)
    ],
    ...options
  })
}

describe('slashCommandDiscovery', () => {
  it('uses sampled native Claude slash commands before fallback builtins and keeps fallback coverage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    const sampleNativeSlashMenu = vi.fn(async () => [sampledCommand('/sampled-context')])
    try {
      const discovery = createTestSlashCommandDiscovery({
        listProjects: async () => [],
        userCommandsDir: join(dir, 'missing-user-commands'),
        userSkillsDir: join(dir, 'missing-user-skills'),
        sampleNativeSlashMenu
      })

      const result = await discovery.listSlashAssistIndex({ projectId: 'missing' })
      const commands = result.items.map((item) => item.displayText)

      expect(commands).toContain('/sampled-context')
      expect(commands).toContain('/context')
      expect(commands).toContain('/usage')
      expect(commands).toContain('/plugin')
      expect(sampleNativeSlashMenu).toHaveBeenCalledTimes(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to builtin commands when native slash sampling fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    const sampleNativeSlashMenu = vi.fn(async () => { throw new Error('sampler failed') })
    try {
      const discovery = createTestSlashCommandDiscovery({
        listProjects: async () => [],
        userCommandsDir: join(dir, 'missing-user-commands'),
        userSkillsDir: join(dir, 'missing-user-skills'),
        sampleNativeSlashMenu
      })

      const result = await discovery.listSlashAssistIndex({ projectId: 'missing' })

      expect(result.items.map((item) => item.displayText)).toEqual(expect.arrayContaining(['/btw', '/context', '/plugin']))
      expect(sampleNativeSlashMenu).toHaveBeenCalledTimes(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('caches sampled native slash commands until refresh is requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    const sampleNativeSlashMenu = vi
      .fn<(input?: { text?: string }) => Promise<SlashAssistItem[]>>()
      .mockResolvedValueOnce([sampledCommand('/first')])
      .mockResolvedValueOnce([sampledCommand('/second')])
    try {
      const discovery = createTestSlashCommandDiscovery({
        listProjects: async () => [],
        userCommandsDir: join(dir, 'missing-user-commands'),
        userSkillsDir: join(dir, 'missing-user-skills'),
        sampleNativeSlashMenu,
        cacheTtlMs: 1000
      })

      const first = await discovery.listSlashAssistIndex({ projectId: 'missing' })
      const cached = await discovery.listSlashAssistIndex({ projectId: 'missing', query: '/f' })
      const refreshed = await discovery.listSlashAssistIndex({ projectId: 'missing', refresh: true })

      expect(first.items.map((item) => item.displayText)).toContain('/first')
      expect(cached.items.map((item) => item.displayText)).toContain('/first')
      expect(refreshed.items.map((item) => item.displayText)).toContain('/second')
      expect(refreshed.items.map((item) => item.displayText)).not.toContain('/first')

      expect(sampleNativeSlashMenu).toHaveBeenCalledTimes(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns native Claude commands when no local command or skill source exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    try {
      const discovery = createTestSlashCommandDiscovery({
        listProjects: async () => [],
        userCommandsDir: join(dir, 'missing-user-commands'),
        userSkillsDir: join(dir, 'missing-user-skills')
      })

      const result = await discovery.listSlashAssistIndex({ projectId: 'missing' })

      expect(result.sourceStatus).toBe('ready')
      expect(result.message).toBeUndefined()
      expect(result.items.map((item) => item.displayText)).toEqual(expect.arrayContaining(['/context', '/model', '/permissions', '/plugin', '/skills']))
      expect(result.items.find((item) => item.displayText === '/context')).toMatchObject({
        kind: 'builtin-command',
        displayText: '/context',
        insertText: '/context ',
        groupLabel: '当前 Claude Code 命令',
        scopeLabel: '当前安装',
        confidence: 'native-evidence'
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('combines builtin commands, project and user commands, and project and user skills without returning bodies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    const projectPath = join(dir, 'workspace')
    const projectCommands = join(projectPath, '.claude', 'commands')
    const projectSkills = join(projectPath, '.claude', 'skills')
    const userCommands = join(dir, 'user-commands')
    const userSkills = join(dir, 'user-skills')
    try {
      await writeCommand(projectCommands, 'review.md', '---\ndescription: Review current changes\n---\nSECRET BODY')
      await writeCommand(userCommands, 'global.md', '---\ndescription: Global helper\nargument_hint: <path>\n---\nGlobal body')
      await writeSkill(projectSkills, 'project-skill', '---\ndescription: Project skill helper\nargument-hint: <topic>\n---\nPROJECT SKILL BODY')
      await writeSkill(userSkills, 'user-skill', '# User skill helper\nUSER SKILL BODY')

      const discovery = createTestSlashCommandDiscovery({
        listProjects: async () => [project('project-1', projectPath)],
        userCommandsDir: userCommands,
        userSkillsDir: userSkills
      })

      const result = await discovery.listSlashAssistIndex({ projectId: 'project-1' })

      expect(result.sourceStatus).toBe('ready')
      expect(result.items.map((item) => item.displayText)).toEqual(expect.arrayContaining([
        '/review',
        '/global',
        '/context',
        '/project-skill',
        '/user-skill'
      ]))
      expect(result.items.find((item) => item.displayText === '/review')).toMatchObject({
        kind: 'project-command',
        insertText: '/review ',
        description: 'Review current changes',
        groupLabel: '当前项目 Commands',
        scopeLabel: '当前项目',
        confidence: 'file-backed',
        category: 'file-command',
        behavior: 'send-to-session',
        executionMode: 'headless-message'
      })
      expect(result.items.find((item) => item.displayText === '/global')).toMatchObject({
        kind: 'user-command',
        insertText: '/global ',
        argumentHint: '<path>',
        groupLabel: '用户 Commands',
        scopeLabel: '用户全局'
      })
      expect(result.items.find((item) => item.displayText === '/project-skill')).toMatchObject({
        kind: 'project-skill',
        displayText: '/project-skill',
        insertText: '/project-skill ',
        description: 'Project skill helper',
        argumentHint: '<topic>',
        groupLabel: 'Skills',
        scopeLabel: '项目 Skill',
        category: 'skill',
        behavior: 'send-to-session',
        executionMode: 'headless-message'
      })
      expect(result.items.find((item) => item.displayText === '/user-skill')).toMatchObject({
        kind: 'user-skill',
        category: 'skill',
        behavior: 'send-to-session',
        description: 'User skill helper',
        scopeLabel: '用户 Skill'
      })
      expect(JSON.stringify(result.items)).not.toContain('SECRET BODY')
      expect(JSON.stringify(result.items)).not.toContain('PROJECT SKILL BODY')
      expect(JSON.stringify(result.items)).not.toContain('USER SKILL BODY')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('scans project and user slash command markdown files without returning command body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    const projectPath = join(dir, 'workspace')
    const projectCommands = join(projectPath, '.claude', 'commands')
    const userCommands = join(dir, 'user-commands')
    try {
      await writeCommand(projectCommands, 'review.md', '---\ndescription: Review current changes\n---\nSECRET BODY')
      await writeCommand(projectCommands, 'workflow/analyze.md', '# Analyze workflow\nDetailed body should not leak')
      await writeCommand(userCommands, 'global.md', '---\ndescription: Global helper\nargument_hint: <path>\n---\nGlobal body')

      const discovery = createTestSlashCommandDiscovery({
        listProjects: async () => [project('project-1', projectPath)],
        userCommandsDir: userCommands,
        userSkillsDir: join(dir, 'missing-user-skills')
      })

      const result = await discovery.listSlashAssistIndex({ projectId: 'project-1' })

      expect(result.sourceStatus).toBe('ready')
      expect(result.items.map((item) => item.displayText)).toEqual(expect.arrayContaining(['/review', '/workflow/analyze', '/global']))
      expect(result.items[0]).toMatchObject({
        displayText: '/review',
        insertText: '/review ',
        description: 'Review current changes',
        kind: 'project-command',
        scopeLabel: '当前项目'
      })
      expect(result.items[1]).toMatchObject({
        displayText: '/workflow/analyze',
        description: 'Analyze workflow'
      })
      expect(result.items[2]).toMatchObject({
        displayText: '/global',
        argumentHint: '<path>',
        kind: 'user-command',
        scopeLabel: '用户全局'
      })
      expect(JSON.stringify(result.items)).not.toContain('SECRET BODY')
      expect(JSON.stringify(result.items)).not.toContain('Detailed body should not leak')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('filters by query and limits results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    const projectPath = join(dir, 'workspace')
    const projectCommands = join(projectPath, '.claude', 'commands')
    try {
      await writeCommand(projectCommands, 'review.md', 'review command')
      await writeCommand(projectCommands, 'refactor.md', 'refactor command')
      await writeCommand(projectCommands, 'test.md', 'test command')
      const discovery = createTestSlashCommandDiscovery({
        listProjects: async () => [project('project-1', projectPath)],
        userCommandsDir: join(dir, 'missing-user'),
        userSkillsDir: join(dir, 'missing-user-skills')
      })

      const result = await discovery.listSlashAssistIndex({ projectId: 'project-1', query: '/re', limit: 1 })

      expect(result.items).toHaveLength(1)
      expect(result.items[0].displayText).toBe('/refactor')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lets project commands override user commands with the same command name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    const projectPath = join(dir, 'workspace')
    const projectCommands = join(projectPath, '.claude', 'commands')
    const userCommands = join(dir, 'user-commands')
    try {
      await writeCommand(projectCommands, 'review.md', '---\ndescription: Project review\n---')
      await writeCommand(userCommands, 'review.md', '---\ndescription: User review\n---')
      const discovery = createTestSlashCommandDiscovery({
        listProjects: async () => [project('project-1', projectPath)],
        userCommandsDir: userCommands,
        userSkillsDir: join(dir, 'missing-user-skills')
      })

      const result = await discovery.listSlashAssistIndex({ projectId: 'project-1', query: 'review' })

      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toMatchObject({
        displayText: '/review',
        description: 'Project review',
        kind: 'project-command'
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns native Claude commands when no file-backed source exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    try {
      const discovery = createTestSlashCommandDiscovery({
        listProjects: async () => [],
        userCommandsDir: join(dir, 'missing-user'),
        userSkillsDir: join(dir, 'missing-skills')
      })

      const result = await discovery.listSlashAssistIndex({ projectId: 'missing' })

      expect(result.sourceStatus).toBe('ready')
      expect(result.message).toBeUndefined()
      expect(result.items.map((item) => item.displayText)).toEqual(expect.arrayContaining(['/context', '/model', '/permissions', '/plugin', '/skills']))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ranks slash query matches like Claude Code: command prefix first, then aliases and descriptions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    try {
      const discovery = createTestSlashCommandDiscovery({
        listProjects: async () => [],
        userCommandsDir: join(dir, 'missing-user'),
        userSkillsDir: join(dir, 'missing-skills')
      })

      const result = await discovery.listSlashAssistIndex({ projectId: 'missing', query: '/c' })
      const commands = result.items.map((item) => item.displayText)
      const firstNonPrefix = commands.findIndex((command) => !command.startsWith('/c'))
      const prefixWindow = firstNonPrefix === -1 ? commands : commands.slice(0, firstNonPrefix)

      expect(prefixWindow).toEqual(expect.arrayContaining(['/claude-api', '/clear', '/compact', '/config', '/context', '/copy']))
      expect(prefixWindow.every((command) => command.startsWith('/c'))).toBe(true)
      expect(commands.indexOf('/usage')).toBeGreaterThanOrEqual(firstNonPrefix)
      expect(commands.indexOf('/resume')).toBeGreaterThanOrEqual(firstNonPrefix)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('inherits behavior for sampled native commands from the evidence ledger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    try {
      const discovery = createSlashCommandDiscovery({
        listProjects: async () => [],
        userCommandsDir: join(dir, 'missing-user-commands'),
        userSkillsDir: join(dir, 'missing-user-skills'),
        sampleNativeSlashMenu: async () => [{ ...sampledCommand('/plugin'), executionMode: undefined as never }]
      })

      const result = await discovery.listSlashAssistIndex({ projectId: 'missing', query: '/pl' })

      expect(result.items.find((item) => item.displayText === '/plugin')).toMatchObject({
        behavior: 'switch-to-native'
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('samples the current native prefix only when refresh is manually requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    const sampleNativeSlashMenu = vi
      .fn<(input?: { text?: string }) => Promise<SlashAssistItem[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { ...sampledCommand('/plugin'), aliases: ['plugins'], description: 'Manage Claude Code plugins' },
        sampledCommand('/reload-plugins', 1)
      ])
    try {
      const discovery = createSlashCommandDiscovery({
        listProjects: async () => [],
        userCommandsDir: join(dir, 'missing-user-commands'),
        userSkillsDir: join(dir, 'missing-user-skills'),
        sampleNativeSlashMenu
      })

      await discovery.listSlashAssistIndex({ projectId: 'missing', query: '/pl' })
      const refreshed = await discovery.listSlashAssistIndex({ projectId: 'missing', query: '/pl', refresh: true })

      expect(sampleNativeSlashMenu).toHaveBeenNthCalledWith(1)
      expect(sampleNativeSlashMenu).toHaveBeenNthCalledWith(2, { text: '/pl' })
      expect(refreshed.items.map((item) => item.displayText)).toEqual(expect.arrayContaining(['/plugin', '/reload-plugins']))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not spawn a native prefix sample for ordinary non-refresh queries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    const sampleNativeSlashMenu = vi
      .fn<(input?: { text?: string }) => Promise<SlashAssistItem[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([sampledCommand('/plugin')])
    try {
      const discovery = createSlashCommandDiscovery({
        listProjects: async () => [],
        userCommandsDir: join(dir, 'missing-user-commands'),
        userSkillsDir: join(dir, 'missing-user-skills'),
        sampleNativeSlashMenu
      })

      await discovery.listSlashAssistIndex({ projectId: 'missing', query: '/p' })
      await discovery.listSlashAssistIndex({ projectId: 'missing', query: '/pl' })

      expect(sampleNativeSlashMenu).toHaveBeenCalledTimes(1)
      expect(sampleNativeSlashMenu).toHaveBeenCalledWith()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('finds plugin commands when querying /pl even if the native first page sample omits them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    try {
      const discovery = createTestSlashCommandDiscovery({
        listProjects: async () => [],
        userCommandsDir: join(dir, 'missing-user-commands'),
        userSkillsDir: join(dir, 'missing-user-skills')
      })

      const result = await discovery.listSlashAssistIndex({ projectId: 'missing', query: '/pl' })

      expect(result.items.map((item) => item.displayText)).toEqual(expect.arrayContaining(['/plugin']))
      expect(result.items.find((item) => item.displayText === '/plugin')).toMatchObject({
        aliases: ['plugins'],
        confidence: 'native-evidence',
        evidence: expect.objectContaining({
          excerpt: '/plugin (plugins) Manage Claude Code plugins'
        })
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps native management commands and concrete skills distinct in the same slash index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    const userSkills = join(dir, 'user-skills')
    try {
      await writeSkill(userSkills, 'using-superpowers', '---\ndescription: Use Superpowers workflow\n---\nbody')
      const discovery = createTestSlashCommandDiscovery({
        listProjects: async () => [],
        userCommandsDir: join(dir, 'missing-user-commands'),
        userSkillsDir: userSkills
      })

      const result = await discovery.listSlashAssistIndex({ projectId: 'missing', limit: 80 })

      expect(result.items.find((item) => item.displayText === '/skills')).toMatchObject({
        kind: 'builtin-command',
        category: 'native-management-command',
        behavior: 'switch-to-native',
        confidence: 'native-evidence'
      })
      expect(result.items.find((item) => item.displayText === '/using-superpowers')).toMatchObject({
        kind: 'user-skill',
        category: 'skill',
        behavior: 'send-to-session',
        confidence: 'file-backed'
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('deduplicates concurrent matching requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-slash-'))
    const projectPath = join(dir, 'workspace')
    const projectCommands = join(projectPath, '.claude', 'commands')
    try {
      await writeCommand(projectCommands, 'review.md', 'review command')
      const listProjects = vi.fn(async () => [project('project-1', projectPath)])
      const discovery = createTestSlashCommandDiscovery({
        listProjects,
        userCommandsDir: join(dir, 'missing-user'),
        userSkillsDir: join(dir, 'missing-user-skills'),
        cacheTtlMs: 1000
      })

      await Promise.all([
        discovery.listSuggestions({ projectId: 'project-1', query: 're' }),
        discovery.listSuggestions({ projectId: 'project-1', query: 're' })
      ])
      await discovery.listSuggestions({ projectId: 'project-1', query: 're' })

      expect(listProjects).toHaveBeenCalledTimes(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
