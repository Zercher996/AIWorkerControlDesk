import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => true) },
  existsSync: vi.fn(() => true)
}))
import type { Project, ProviderProfile } from '../../src/types/workerDesk'
import type { ClaudeCliJsonlTailInput } from './claudeCliJsonlTail'
import type { ClaudeCodeLaunchConfig } from '../providers/claudeCodeProviderAdapter'
import { startPtyProcess } from './claudePty'
import { createSessionManager } from './sessionManager'
import { encodeProjectPath } from './cliHistory'

const testProviderProfile: ProviderProfile = {
  id: 'anthropic-direct',
  name: 'Anthropic Direct',
  apiFormat: 'anthropic',
  protocol: 'anthropic',
  auth: { type: 'api-key', apiKey: 'sk-test-key' },
  endpoint: { baseUrl: 'https://api.anthropic.com' },
  model: { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', apiFormat: 'anthropic', enabled: true },
  models: [{ id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', apiFormat: 'anthropic', enabled: true }],
  defaults: { modelId: 'claude-opus-4-7' },
  adapters: {
    claudeCode: {
      enabled: true,
      permissionMode: 'default',
      useSettingsEnv: true
    }
  }
}

function waitForChunk(emitter: EventEmitter, sessionId: string, text: string, readBuffer: () => string = () => ''): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = readBuffer()
    const cleanup = () => {
      clearTimeout(timer)
      emitter.off('output', listener)
    }
    const finishIfMatched = () => {
      if (!buffer.includes(text)) return
      cleanup()
      resolve(buffer)
    }
    const listener = (event: { sessionId: string; chunk: string }) => {
      if (event.sessionId !== sessionId) return
      buffer += event.chunk
      finishIfMatched()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${text}`))
    }, 5000)
    emitter.on('output', listener)
    finishIfMatched()
  })
}

function waitForSessionStatus(emitter: EventEmitter, sessionId: string, status: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      emitter.off('session', listener)
    }
    const listener = (session: { id: string; status: string }) => {
      if (session.id !== sessionId || session.status !== status) return
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${sessionId} to become ${status}`))
    }, 5000)
    emitter.on('session', listener)
  })
}

describe('sessionManager', () => {
  it('starts two real pty sessions and keeps input isolated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-session-'))
    const events = new EventEmitter()
    const project: Project = {
      id: 'project-1',
      name: 'workspace',
      path: dir,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      autoDispatchGenericAgent: false
    }
    try {
      const manager = createSessionManager({
        getProject: async () => project,
        getProviderProfile: async () => testProviderProfile,
        startProcess: ({ cwd, onData, onExit }) => startPtyProcess({
          file: process.execPath,
          args: ['-e', "process.stdout.write('ready\\n');process.stdin.on('data',d=>{const text=d.toString();process.stdout.write(process.cwd()+':'+text);if(text.includes('exit')) process.exit(0)})"],
          cwd,
          env: process.env,
          cols: 80,
          rows: 24,
          onData,
          onExit
        }),
        onOutput: (event) => events.emit('output', event),
        onSessionChanged: (session) => events.emit('session', session)
      })

      const first = await manager.startSession({ projectId: project.id, providerProfileId: testProviderProfile.id, workerType: 'claude-code' })
      const second = await manager.startSession({ projectId: project.id, providerProfileId: testProviderProfile.id, workerType: 'claude-code' })

      await waitForChunk(events, first.id, 'ready', () => manager.getOutputBuffer(first.id))
      await waitForChunk(events, second.id, 'ready', () => manager.getOutputBuffer(second.id))

      await manager.writeSessionInput(first.id, 'first\r')
      await expect(waitForChunk(events, first.id, 'first', () => manager.getOutputBuffer(first.id))).resolves.toContain('first')
      expect(manager.getOutputBuffer(second.id)).not.toContain('first')

      const firstExited = waitForSessionStatus(events, first.id, 'exited')
      const secondExited = waitForSessionStatus(events, second.id, 'exited')
      await manager.writeSessionInput(first.id, 'exit\r')
      await manager.writeSessionInput(second.id, 'exit\r')
      await firstExited
      await secondExited
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 200))
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('marks a user-stopped pty session as stopped instead of failed', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const write = vi.fn()
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startProcess: ({ onData, onExit }) => {
        onData('ready')
        return { pid: 12345, write, resize: () => {}, kill: () => onExit({ exitCode: 1 }) }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct'
    })

    const stopped = waitForSessionStatus(events, session.id, 'stopped')
    await manager.stopSession(session.id)

    expect(write).not.toHaveBeenCalled()
    await stopped
  })

  it('keeps non-user non-zero pty exits as failed', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startProcess: ({ onExit }) => {
        onExit({ exitCode: 1 })
        return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct'
    })

    expect(session.status).toBe('failed')
  })

  it('does not overwrite waiting status set by synchronous onData', async () => {
    const events = new EventEmitter()
    const project: Project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(),
      autoDispatchGenericAgent: false
    }

    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startProcess: ({ onData }) => {
        onData('Do you want to proceed?')
        return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({ projectId: project.id, providerProfileId: testProviderProfile.id, workerType: 'claude-code' })
    expect(session.status).toBe('waiting')
  })

  it('marks a native-jsonl startup confirmation as running after takeover input is written', async () => {
    const events = new EventEmitter()
    const project: Project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(),
      autoDispatchGenericAgent: false
    }
    let written = ''
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => ({
        ...testProviderProfile,
        adapters: {
          claudeCode: { enabled: true, permissionMode: 'bypassPermissions', useSettingsEnv: true }
        }
      }),
      startProcess: ({ onData }) => {
        onData([
          'WARNING: Claude Code running in Bypass Permissions mode',
          '1. No, exit',
          '2. Yes, I accept',
          'Enter to confirm · Esc to cancel'
        ].join('\n'))
        return {
          pid: 12345,
          write: (data: string) => { written += data },
          resize: () => {},
          kill: () => {}
        }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({ projectId: project.id, providerProfileId: testProviderProfile.id, workerType: 'claude-code' })
    expect(session.status).toBe('waiting')

    await manager.writeSessionInput(session.id, '2\r')

    expect(written).toBe('2\r')
    expect(manager.selectSession(session.id).status).toBe('running')
  })

  it('does not overwrite exited status set by synchronous onExit', async () => {
    const events = new EventEmitter()
    const project: Project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(),
      autoDispatchGenericAgent: false
    }

    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startProcess: ({ onExit }) => {
        onExit({ exitCode: 0 })
        return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({ projectId: project.id, providerProfileId: testProviderProfile.id, workerType: 'claude-code' })
    expect(session.status).toBe('exited')
  })

  it('passes requested terminal size to startProcess', async () => {
    const events = new EventEmitter()
    const project: Project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(),
      autoDispatchGenericAgent: false
    }

    let capturedSize: { cols: number; rows: number } | undefined
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startProcess: ({ cols, rows, onData }) => {
        capturedSize = { cols, rows }
        onData('ready')
        return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    await manager.startSession({
      projectId: project.id,
      providerProfileId: testProviderProfile.id,
      workerType: 'claude-code',
      terminalSize: { cols: 72, rows: 18 }
    })

    expect(capturedSize).toEqual({ cols: 72, rows: 18 })
  })

  it('records providerProfileId on sessions started with a Provider Profile', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startProcess: ({ onData }) => {
        onData('ready')
        return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct'
    })

    expect(session.providerProfileId).toBe('anthropic-direct')
    expect(session.providerName).toBe('Anthropic Direct')
    expect(session.modelId).toBe('claude-opus-4-7')
    expect(session.modelDisplayName).toBe('Claude Opus 4.7')
    expect(session.title).toBe('workspace / Anthropic Direct')
  })

  it('starts Claude Code with current config env when launch source is current-claude-config', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const startProcess = vi.fn(({ onData }) => {
      onData('ready')
      return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
    })
    const manager = createSessionManager({
      getProject: async () => project,
      getCurrentClaudeConfig: async () => ({
        source: 'current-claude-config',
        baseUrl: 'http://127.0.0.1:53159',
        model: 'gpt-5.4',
        apiKeySource: 'ANTHROPIC_AUTH_TOKEN',
        env: {
          ANTHROPIC_AUTH_TOKEN: 'secret-token',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:53159',
          ANTHROPIC_MODEL: 'gpt-5.4'
        }
      }),
      startProcess,
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      claudeLaunchSource: { type: 'current-claude-config' }
    })

    expect(startProcess).toHaveBeenCalledWith(expect.objectContaining({
      launchConfig: expect.objectContaining({
        env: expect.objectContaining({
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:53159',
          ANTHROPIC_MODEL: 'gpt-5.4'
        })
      })
    }))
    expect(session.providerProfileId).toBeUndefined()
    expect(session.providerName).toBe('Current Claude Config')
    expect(session.modelId).toBe('gpt-5.4')
  })

  it('records taskTitle on started sessions without changing generated title', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startProcess: ({ onData }) => {
        onData('ready')
        return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct',
      taskTitle: '修复中栏状态展示'
    })

    expect(session.taskTitle).toBe('修复中栏状态展示')
    expect(session.title).toBe('workspace / Anthropic Direct')
  })

  it('records parent session and dispatch mode on started sessions', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startProcess: ({ onData }) => {
        onData('ready')
        return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct',
      parentSessionId: 'parent-session',
      dispatchMode: 'auto'
    })

    expect(session.parentSessionId).toBe('parent-session')
    expect(session.dispatchMode).toBe('auto')
  })

  it('starts claude-code with providerProfileId and injects Claude hook settings', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    let capturedLaunchConfig: ClaudeCodeLaunchConfig | undefined
    const dispose = vi.fn()
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      hookBridge: {
        registerSession: async (sessionId) => ({
          eventFilePath: `hooks/${sessionId}.jsonl`,
          settings: {
            hooks: {
              Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook Stop' }] }],
              Notification: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook Notification' }] }],
              UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook UserPromptSubmit' }] }],
              PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook PreToolUse' }] }],
              PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook PostToolUse' }] }]
            }
          },
          dispose
        })
      },
      startProcess: ({ launchConfig, onExit }) => {
        capturedLaunchConfig = launchConfig
        setTimeout(() => onExit({ exitCode: 0 }), 0)
        return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session),
      onSessionAttentionChanged: (event) => events.emit('attention', event)
    })

    await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct'
    })

    expect(capturedLaunchConfig).toBeDefined()
    const settingsIndex = capturedLaunchConfig!.command.args.indexOf('--settings')
    const settings = JSON.parse(capturedLaunchConfig!.command.args[settingsIndex + 1])
    expect(settings.env.ANTHROPIC_API_KEY).toBe('sk-test-key')
    expect(settings.hooks.Stop).toHaveLength(1)
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1)
    expect(settings.Stop).toBeUndefined()
    await vi.waitFor(() => expect(dispose).toHaveBeenCalled())
  })

  it('marks headless Claude Code ready to receive the first message after process spawn', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const sendUserMessage = vi.fn()
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startHeadlessProcess: () => ({ pid: 12345, sendUserMessage, kill: () => {} }),
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct',
      interactionMode: 'headless'
    })

    expect(session.interactionMode).toBe('headless')
    expect(session.processId).toBe(12345)
    expect(session.status).toBe('running')
    await manager.sendSessionMessage(session.id, 'hello')
    expect(sendUserMessage).toHaveBeenCalledWith('hello')
  })

  it('can explicitly start a Claude Code PTY takeover session even when headless support is available', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const sendUserMessage = vi.fn()
    const write = vi.fn()
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startHeadlessProcess: () => ({ pid: 11111, sendUserMessage, kill: () => {} }),
      startProcess: ({ onData }) => {
        onData('native ready')
        return { pid: 22222, write, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct',
      interactionMode: 'pty'
    })

    expect(session.interactionMode).toBe('pty')
    expect(session.processId).toBe(22222)
    expect(sendUserMessage).not.toHaveBeenCalled()
    await manager.writeSessionInput(session.id, '/plugin\r')
    expect(write).toHaveBeenCalledWith('/plugin\r')
  })

  it('starts claude-code with providerProfileId and passes launchConfig to starter', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    let capturedLaunchConfig: ClaudeCodeLaunchConfig | undefined
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startProcess: ({ launchConfig, onData }) => {
        capturedLaunchConfig = launchConfig
        onData('ready')
        return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })
    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct'
    })
    expect(session.status).toBe('running')
    expect(capturedLaunchConfig).toBeDefined()
    expect(capturedLaunchConfig!.env.ANTHROPIC_API_KEY).toBe('sk-test-key')
    expect(capturedLaunchConfig!.env.ANTHROPIC_MODEL).toBe('claude-opus-4-7')
    expect(capturedLaunchConfig!.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
    expect(capturedLaunchConfig!.command.file).toBe('claude')
    expect(Array.isArray(capturedLaunchConfig!.command.args)).toBe(true)
    expect(session.providerName).toBe('Anthropic Direct')
    expect(session.modelId).toBe('claude-opus-4-7')
    expect(session.title).toBe('workspace / Anthropic Direct')
  })

  it('starts claude-code through a local relay when requested', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    let capturedLaunchConfig: ClaudeCodeLaunchConfig | undefined
    let exitHandler: ((event: { exitCode: number }) => void) | undefined
    const closeRelay = vi.fn()
    const startClaudeCodeLocalRelay = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:56789',
      close: closeRelay
    }))
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => ({
        id: 'mimo-cc-relay',
        name: 'MIMO CC Relay',
        apiFormat: 'anthropic',
        protocol: 'openai-compatible',
        auth: { type: 'api-key', apiKey: 'test-relay-key' },
        endpoint: { baseUrl: 'https://test.404888.xyz' },
        model: { id: 'mimo-v2.5', displayName: 'MIMO v2.5', apiFormat: 'openai_chat', enabled: true },
        models: [{ id: 'mimo-v2.5', displayName: 'MIMO v2.5', apiFormat: 'openai_chat', enabled: true }],
        defaults: { modelId: 'mimo-v2.5' },
        adapters: {
          claudeCode: {
            enabled: true,
            permissionMode: 'default',
            useSettingsEnv: true,
            extraConfig: { relay: true }
          }
        }
      }),
      startClaudeCodeLocalRelay,
      startProcess: ({ launchConfig, onData, onExit }) => {
        capturedLaunchConfig = launchConfig
        exitHandler = onExit
        onData('ready')
        return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'mimo-cc-relay'
    })

    expect(session.status).toBe('running')
    expect(startClaudeCodeLocalRelay).toHaveBeenCalledWith({ upstreamBaseUrl: 'https://test.404888.xyz', apiKey: 'test-relay-key' })
    expect(capturedLaunchConfig!.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:56789')
    const settingsIndex = capturedLaunchConfig!.command.args.indexOf('--settings')
    const settings = JSON.parse(capturedLaunchConfig!.command.args[settingsIndex + 1])
    expect(settings.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:56789')
    expect(settings.env.NO_PROXY).toContain('127.0.0.1')
    expect(settings.env.no_proxy).toContain('127.0.0.1')
    expect(capturedLaunchConfig!.env.NO_PROXY).toContain('127.0.0.1')
    expect(capturedLaunchConfig!.env.NO_PROXY).toContain('localhost')
    expect(capturedLaunchConfig!.env.no_proxy).toContain('127.0.0.1')
    expect(capturedLaunchConfig!.env.no_proxy).toContain('localhost')

    exitHandler?.({ exitCode: 0 })
    expect(closeRelay).toHaveBeenCalledOnce()
  })

  it('requires providerProfileId for claude-code', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const manager = createSessionManager({
      getProject: async () => project,
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code'
    })

    expect(session.status).toBe('failed')
    expect(session.errorMessage).toContain('providerProfileId is required for claude-code')
  })

  it('requires providerProfileId for generic-agent and returns failed session when missing', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const manager = createSessionManager({
      getProject: async () => project,
      getGenericAgentConfig: async () => ({
        id: 'ga-local', name: 'Local GA', home: 'E:/ga',
        pythonCommand: 'python', entryScript: 'agentmain.py', env: {}
      }),
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })
    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'generic-agent',
      genericAgentConfigId: 'ga-local'
    })
    expect(session.status).toBe('failed')
    expect(session.errorMessage).toContain('providerProfileId is required')
  })

  it('starts generic-agent without profileId and passes launchConfig to starter', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    let capturedEnv: NodeJS.ProcessEnv | undefined
    const manager = createSessionManager({
      getProject: async () => project,
      getGenericAgentConfig: async () => ({
        id: 'ga-local', name: 'Local GA', home: 'E:/ga',
        pythonCommand: 'python', entryScript: 'agentmain.py', env: {}
      }),
      getProviderProfile: async () => ({
        id: 'openrouter-gpt',
        name: 'OpenRouter GPT',
        apiFormat: 'openai_chat',
        protocol: 'openai-compatible',
        auth: { type: 'api-key', apiKey: 'sk-or-test-key' },
        endpoint: { baseUrl: 'https://openrouter.ai/api/v1' },
        model: { id: 'openai/gpt-4', apiFormat: 'openai_chat', enabled: true },
        models: [{ id: 'openai/gpt-4', apiFormat: 'openai_chat', enabled: true }],
        defaults: { modelId: 'openai/gpt-4' },
        adapters: {
          genericAgent: {
            enabled: true,
            sessionType: 'native_oai'
          }
        }
      }),
      startGenericProcess: ({ env, onData }) => {
        capturedEnv = env
        onData('ready')
        return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })
    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'generic-agent',
      genericAgentConfigId: 'ga-local',
      providerProfileId: 'openrouter-gpt'
    })
    expect(session.status).toBe('running')
    expect(session.title).toBe('workspace / OpenRouter GPT / Local GA')
    expect(capturedEnv).toBeDefined()
    expect(capturedEnv!.GENERIC_AGENT_PROVIDER_CONFIG_JSON).toBeDefined()
    const gaConfig = JSON.parse(capturedEnv!.GENERIC_AGENT_PROVIDER_CONFIG_JSON!) as { sessionType: string; config: Record<string, unknown> }
    expect(gaConfig.sessionType).toBe('native_oai')
    expect(gaConfig.config.apikey).toBe('sk-or-test-key')
    expect(gaConfig.config.model).toBe('openai/gpt-4')
    expect(gaConfig.config.apibase).toBe('https://openrouter.ai/api/v1')
  })

  it('routes GenericAgent native_oai providers through a local relay when requested', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    let capturedEnv: NodeJS.ProcessEnv | undefined
    let exitHandler: ((event: { exitCode: number }) => void) | undefined
    const closeRelay = vi.fn()
    const startOpenAiLocalRelay = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:45678',
      close: closeRelay
    }))
    const manager = createSessionManager({
      getProject: async () => project,
      getGenericAgentConfig: async () => ({
        id: 'ga-local', name: 'Local GA', home: 'E:/ga',
        pythonCommand: 'python', entryScript: 'agentmain.py', env: {}
      }),
      getProviderProfile: async () => ({
        id: 'mimo-openai',
        name: 'MIMO OpenAI',
        apiFormat: 'openai_chat',
        protocol: 'openai-compatible',
        auth: { type: 'api-key', apiKey: 'test-relay-key' },
        endpoint: { baseUrl: 'https://test.404888.xyz' },
        model: { id: 'mimo-v2.5', apiFormat: 'openai_chat', enabled: true },
        models: [{ id: 'mimo-v2.5', apiFormat: 'openai_chat', enabled: true }],
        defaults: { modelId: 'mimo-v2.5' },
        adapters: {
          genericAgent: {
            enabled: true,
            sessionType: 'native_oai',
            apiMode: 'chat_completions',
            extraConfig: {
              local_fetch_relay: true,
              stream: false
            }
          }
        }
      }),
      startOpenAiLocalRelay,
      startGenericProcess: ({ env, onData, onExit }) => {
        capturedEnv = env
        exitHandler = onExit
        onData('ready')
        return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'generic-agent',
      genericAgentConfigId: 'ga-local',
      providerProfileId: 'mimo-openai'
    })

    expect(session.status).toBe('running')
    expect(startOpenAiLocalRelay).toHaveBeenCalledWith({ upstreamBaseUrl: 'https://test.404888.xyz' })
    const gaConfig = JSON.parse(capturedEnv!.GENERIC_AGENT_PROVIDER_CONFIG_JSON!) as { sessionType: string; config: Record<string, unknown> }
    expect(gaConfig.sessionType).toBe('native_oai')
    expect(gaConfig.config.apibase).toBe('http://127.0.0.1:45678')
    expect(gaConfig.config.apikey).toBe('test-relay-key')
    expect(gaConfig.config.local_fetch_relay).toBeUndefined()
    expect(capturedEnv!.NO_PROXY).toContain('127.0.0.1')
    expect(capturedEnv!.NO_PROXY).toContain('localhost')
    expect(capturedEnv!.no_proxy).toContain('127.0.0.1')
    expect(capturedEnv!.no_proxy).toContain('localhost')

    exitHandler?.({ exitCode: 0 })
    expect(closeRelay).toHaveBeenCalledOnce()
  })

  it('records GenericAgent dispatch task on started child sessions', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const manager = createSessionManager({
      getProject: async () => project,
      getGenericAgentConfig: async () => ({
        id: 'ga-local', name: 'Local GA', home: 'E:/ga',
        pythonCommand: 'python', entryScript: 'agentmain.py', env: {}
      }),
      getProviderProfile: async () => ({
        id: 'openrouter-gpt',
        name: 'OpenRouter GPT',
        apiFormat: 'openai_chat',
        protocol: 'openai-compatible',
        auth: { type: 'api-key', apiKey: 'sk-or-test-key' },
        endpoint: { baseUrl: 'https://openrouter.ai/api/v1' },
        model: { id: 'openai/gpt-4', apiFormat: 'openai_chat', enabled: true },
        models: [{ id: 'openai/gpt-4', apiFormat: 'openai_chat', enabled: true }],
        defaults: { modelId: 'openai/gpt-4' },
        adapters: {
          genericAgent: {
            enabled: true,
            sessionType: 'native_oai'
          }
        }
      }),
      startGenericProcess: ({ onData }) => {
        onData('ready')
        return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'generic-agent',
      genericAgentConfigId: 'ga-local',
      providerProfileId: 'openrouter-gpt',
      parentSessionId: 'claude-session',
      dispatchMode: 'auto',
      initialPrompt: '检查 SessionRadar 卡片显示问题',
      dispatchTask: '检查 SessionRadar 卡片显示问题'
    })

    expect(session.dispatchTask).toBe('检查 SessionRadar 卡片显示问题')
  })

  it('falls back modelDisplayName to model.id when provider.model.displayName is undefined', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const providerWithoutDisplayName: ProviderProfile = {
      id: 'custom-provider',
      name: 'Custom Provider',
      apiFormat: 'anthropic',
      protocol: 'anthropic-compatible',
      auth: { type: 'api-key', apiKey: 'sk-test-key' },
      endpoint: { baseUrl: 'https://custom.api.com' },
      model: { id: 'custom-model-v2', apiFormat: 'anthropic', enabled: true },
      models: [{ id: 'custom-model-v2', apiFormat: 'anthropic', enabled: true }],
      defaults: { modelId: 'custom-model-v2' },
      adapters: {
        claudeCode: {
          enabled: true,
          permissionMode: 'default',
          useSettingsEnv: true
        }
      }
    }
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => providerWithoutDisplayName,
      startProcess: ({ onData }) => {
        onData('ready')
        return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'custom-provider'
    })

    expect(session.modelId).toBe('custom-model-v2')
    expect(session.modelDisplayName).toBe('custom-model-v2')
    expect(session.providerName).toBe('Custom Provider')
    expect(session.title).toBe('workspace / Custom Provider')
  })
  it('uses providerModelId to freeze the selected model and launch Claude Code', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    let capturedLaunchConfig: ClaudeCodeLaunchConfig | undefined
    const multiModelProvider: ProviderProfile = {
      ...testProviderProfile,
      models: [
        { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', apiFormat: 'anthropic', enabled: true },
        { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', apiFormat: 'anthropic', enabled: true }
      ],
      defaults: { modelId: 'claude-opus-4-7' }
    }
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => multiModelProvider,
      startProcess: ({ launchConfig, onData }) => {
        capturedLaunchConfig = launchConfig
        onData('ready')
        return { pid: 12345, write: () => {}, resize: () => {}, kill: () => {} }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct',
      providerModelId: 'claude-sonnet-4-6'
    })

    expect(session.modelId).toBe('claude-sonnet-4-6')
    expect(session.modelDisplayName).toBe('Claude Sonnet 4.6')
    expect(capturedLaunchConfig?.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
  })

  it('fails before starting Claude Code when providerModelId points to an OpenAI model', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const startProcess = vi.fn()
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => ({
        ...testProviderProfile,
        models: [
          { id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true },
          { id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true }
        ],
        defaults: { modelId: 'claude-opus-4-7' }
      }),
      startProcess,
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct',
      providerModelId: 'openai/gpt-4o'
    })

    expect(session.status).toBe('failed')
    expect(session.errorMessage).toContain('requires apiFormat "anthropic"')
    expect(startProcess).not.toHaveBeenCalled()
  })
  it('starts native-jsonl Claude Code through PTY and projects tailed AI events', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const write = vi.fn()
    let tailInput: ClaudeCliJsonlTailInput | undefined
    const stopped = vi.fn()
    const pollNow = vi.fn(async () => undefined)
    const appendedAiEvents: unknown[] = []
    const broadcastAiEvents: unknown[] = []
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startProcess: ({ onData }) => {
        onData('native ready')
        return { pid: 22222, write, resize: () => {}, kill: () => {} }
      },
      startHeadlessProcess: () => ({ pid: 11111, sendUserMessage: () => {}, kill: () => {} }),
      startNativeJsonlTail: (input) => {
        tailInput = input
        return { pollNow, getStats: () => ({ totalBytesRead: 0, parsedLineCount: 0, mappedEventCount: 0, unsupportedCount: 0, parseErrorCount: 0 }), stop: stopped }
      },
      sessionStore: {
        createSession: async () => undefined,
        updateSession: async () => undefined,
        appendOutput: async () => undefined,
        appendAiEvent: async (event) => { appendedAiEvents.push(event) }
      },
      onOutput: (event) => events.emit('output', event),
      onAiEvent: (event) => {
        broadcastAiEvents.push(event)
        events.emit('ai', event)
      },
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct',
      interactionMode: 'native-jsonl',
      initialPrompt: '继续做任务'
    })

    expect(session.interactionMode).toBe('native-jsonl')
    expect(session.processId).toBe(22222)
    expect(write).toHaveBeenCalledWith('继续做任务\r')
    expect(tailInput).toEqual(expect.objectContaining({ deskSessionId: session.id, workspacePath: project.path }))

    tailInput!.onCliSessionMatched?.('cli-session-1', 'session.jsonl')
    tailInput!.onEvent({
      id: 'event-1',
      sessionId: session.id,
      timestamp: '2026-06-01T00:00:00.000Z',
      source: 'claude-code-jsonl',
      type: 'assistant_text',
      text: '完成'
    })

    expect(appendedAiEvents).toHaveLength(1)
    expect(broadcastAiEvents).toHaveLength(1)
    expect(manager.selectSession(session.id).cliSessionId).toBe('cli-session-1')
    expect(manager.selectSession(session.id).status).toBe('running')

    tailInput!.onEvent({
      id: 'event-2',
      sessionId: session.id,
      timestamp: '2026-06-01T00:00:01.000Z',
      source: 'claude-code-jsonl',
      type: 'turn_end',
      reason: 'end_turn',
      cliSessionId: 'cli-session-1'
    })

    expect(appendedAiEvents).toHaveLength(2)
    expect(broadcastAiEvents).toHaveLength(2)
    expect(manager.selectSession(session.id).status).toBe('waiting')
  })

  it('keeps native-jsonl sessions failed after auth errors even when turn_end arrives', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    let tailInput: ClaudeCliJsonlTailInput | undefined
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startProcess: () => ({ pid: 22222, write: () => {}, resize: () => {}, kill: () => {} }),
      startNativeJsonlTail: (input) => {
        tailInput = input
        return {
          pollNow: vi.fn(async () => undefined),
          getStats: () => ({ totalBytesRead: 0, parsedLineCount: 0, mappedEventCount: 0, unsupportedCount: 0, parseErrorCount: 0 }),
          stop: vi.fn()
        }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct',
      interactionMode: 'native-jsonl'
    })

    tailInput!.onEvent({
      id: 'event-1',
      sessionId: session.id,
      timestamp: '2026-06-01T00:00:00.000Z',
      source: 'claude-code-jsonl',
      type: 'result',
      status: 'error',
      errorMessage: '401 Unauthorized: invalid API key',
      cliSessionId: 'cli-session-1'
    })
    tailInput!.onEvent({
      id: 'event-2',
      sessionId: session.id,
      timestamp: '2026-06-01T00:00:01.000Z',
      source: 'claude-code-jsonl',
      type: 'turn_end',
      reason: 'end_turn',
      cliSessionId: 'cli-session-1'
    })

    expect(manager.selectSession(session.id)).toMatchObject({
      status: 'failed',
      errorMessage: '401 Unauthorized: invalid API key',
      cliSessionId: 'cli-session-1'
    })
  })

  it('marks native-jsonl sessions failed when Claude asks for login in assistant text', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    let tailInput: ClaudeCliJsonlTailInput | undefined
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startProcess: () => ({ pid: 22222, write: () => {}, resize: () => {}, kill: () => {} }),
      startNativeJsonlTail: (input) => {
        tailInput = input
        return {
          pollNow: vi.fn(async () => undefined),
          getStats: () => ({ totalBytesRead: 0, parsedLineCount: 0, mappedEventCount: 0, unsupportedCount: 0, parseErrorCount: 0 }),
          stop: vi.fn()
        }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const session = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct',
      interactionMode: 'native-jsonl'
    })

    tailInput!.onEvent({
      id: 'event-1',
      sessionId: session.id,
      timestamp: '2026-06-01T00:00:00.000Z',
      source: 'claude-code-jsonl',
      type: 'assistant_text',
      text: 'Invalid API key. Please run /login to authenticate.',
      messageId: 'assistant-message-1'
    })

    expect(manager.selectSession(session.id)).toMatchObject({
      status: 'failed',
      errorMessage: 'Invalid API key. Please run /login to authenticate.'
    })
  })

  it('shares native-jsonl file claims across parallel Claude Code sessions', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const tailInputs: ClaudeCliJsonlTailInput[] = []
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startProcess: () => ({ pid: 22222, write: () => {}, resize: () => {}, kill: () => {} }),
      startNativeJsonlTail: (input) => {
        tailInputs.push(input)
        return {
          pollNow: vi.fn(async () => undefined),
          getStats: () => ({ totalBytesRead: 0, parsedLineCount: 0, mappedEventCount: 0, unsupportedCount: 0, parseErrorCount: 0 }),
          stop: vi.fn()
        }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const first = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct',
      interactionMode: 'native-jsonl'
    })
    const second = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct',
      interactionMode: 'native-jsonl'
    })

    expect(tailInputs).toHaveLength(2)
    expect(tailInputs[0].deskSessionId).toBe(first.id)
    expect(tailInputs[1].deskSessionId).toBe(second.id)
    expect(tailInputs[0].claimCliJsonlFile?.({ deskSessionId: first.id, filePath: 'same.jsonl', cliSessionId: 'cli-same' })).toBe(true)
    expect(tailInputs[1].claimCliJsonlFile?.({ deskSessionId: second.id, filePath: 'same.jsonl', cliSessionId: 'cli-same' })).toBe(false)
    expect(tailInputs[1].claimCliJsonlFile?.({ deskSessionId: second.id, filePath: 'other.jsonl', cliSessionId: 'cli-other' })).toBe(true)
  })

  it('does not let an earlier native-jsonl desk session claim a jsonl file closer to a later unbound session', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    const tailInputs: ClaudeCliJsonlTailInput[] = []
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startProcess: () => ({ pid: 22222, write: () => {}, resize: () => {}, kill: () => {} }),
      startNativeJsonlTail: (input) => {
        tailInputs.push(input)
        return {
          pollNow: vi.fn(async () => undefined),
          getStats: () => ({ totalBytesRead: 0, parsedLineCount: 0, mappedEventCount: 0, unsupportedCount: 0, parseErrorCount: 0 }),
          stop: vi.fn()
        }
      },
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    const first = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct',
      interactionMode: 'native-jsonl'
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct',
      interactionMode: 'native-jsonl'
    })

    const firstStartedAt = Date.parse(first.createdAt)
    const secondStartedAt = Date.parse(second.createdAt)
    const closerToSecond = secondStartedAt
    expect(tailInputs[0].claimCliJsonlFile?.({ deskSessionId: first.id, filePath: 'second.jsonl', fileCreatedAtMs: closerToSecond, cliSessionId: 'cli-second' })).toBe(false)
    expect(tailInputs[1].claimCliJsonlFile?.({ deskSessionId: second.id, filePath: 'second.jsonl', fileCreatedAtMs: closerToSecond, cliSessionId: 'cli-second' })).toBe(true)
    expect(tailInputs[0].claimCliJsonlFile?.({ deskSessionId: first.id, filePath: 'first.jsonl', fileCreatedAtMs: firstStartedAt, cliSessionId: 'cli-first' })).toBe(true)
  })

  it('passes existing Claude jsonl files to native-jsonl tailer as ignored startup files', async () => {
    const events = new EventEmitter()
    const root = await mkdtemp(join(tmpdir(), 'aiw-session-manager-jsonl-'))
    const workspacePath = join(tmpdir(), 'workspace-existing-jsonl')
    const projectDir = join(root, encodeProjectPath(workspacePath))
    await mkdir(projectDir, { recursive: true })
    const existingFilePath = join(projectDir, 'old-cli-session.jsonl')
    await writeFile(existingFilePath, JSON.stringify({ type: 'system', sessionId: 'old-cli-session', cwd: workspacePath }) + '\n', 'utf-8')
    const project = {
      id: 'project-1', name: 'workspace', path: workspacePath,
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    let tailInput: ClaudeCliJsonlTailInput | undefined
    try {
      const manager = createSessionManager({
        getProject: async () => project,
        getProviderProfile: async () => testProviderProfile,
        claudeProjectsBaseDir: root,
        startProcess: () => ({ pid: 22222, write: () => {}, resize: () => {}, kill: () => {} }),
        startNativeJsonlTail: (input) => {
          tailInput = input
          return {
            pollNow: vi.fn(async () => undefined),
            getStats: () => ({ totalBytesRead: 0, parsedLineCount: 0, mappedEventCount: 0, unsupportedCount: 0, parseErrorCount: 0 }),
            stop: vi.fn()
          }
        },
        onOutput: (event) => events.emit('output', event),
        onSessionChanged: (session) => events.emit('session', session)
      })

      await manager.startSession({
        projectId: project.id,
        workerType: 'claude-code',
        providerProfileId: 'anthropic-direct',
        interactionMode: 'native-jsonl'
      })

      expect(tailInput?.ignoredCliJsonlFilePaths).toEqual([existingFilePath])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stops native-jsonl tailer after process exit', async () => {
    const events = new EventEmitter()
    const project = {
      id: 'project-1', name: 'workspace', path: '.',
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), autoDispatchGenericAgent: false
    }
    let exitHandler: ((event: { exitCode: number }) => void) | undefined
    const stopped = vi.fn()
    const pollNow = vi.fn(async () => undefined)
    const manager = createSessionManager({
      getProject: async () => project,
      getProviderProfile: async () => testProviderProfile,
      startProcess: ({ onExit }) => {
        exitHandler = onExit
        return { pid: 22222, write: () => {}, resize: () => {}, kill: () => {} }
      },
      startNativeJsonlTail: () => ({ pollNow, getStats: () => ({ totalBytesRead: 0, parsedLineCount: 0, mappedEventCount: 0, unsupportedCount: 0, parseErrorCount: 0 }), stop: stopped }),
      onOutput: (event) => events.emit('output', event),
      onSessionChanged: (session) => events.emit('session', session)
    })

    await manager.startSession({
      projectId: project.id,
      workerType: 'claude-code',
      providerProfileId: 'anthropic-direct',
      interactionMode: 'native-jsonl'
    })
    exitHandler?.({ exitCode: 0 })

    await vi.waitFor(() => expect(pollNow).toHaveBeenCalled())
    await vi.waitFor(() => expect(stopped).toHaveBeenCalled())
  })

})

