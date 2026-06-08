import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildClaudeCommand, buildClaudeProcessEnv, resolveCommandForPty, startPtyProcess } from './claudePty'

function waitForOutput(emitter: EventEmitter, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 5000)
    emitter.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.includes(expected)) {
        clearTimeout(timer)
        resolve(buffer)
      }
    })
  })
}

describe('claudePty', () => {
  it('builds a safe claude command', () => {
    expect(buildClaudeCommand({ model: 'claude-sonnet-4-6', permissionMode: 'default' })).toEqual({
      file: 'claude',
      args: ['--model', 'claude-sonnet-4-6', '--permission-mode', 'default']
    })
  })

  it('loads profile env as explicit settings without excluding user settings', () => {
    const command = buildClaudeCommand({ model: 'mimo-v2.5-pro', permissionMode: 'bypassPermissions', envModel: 'mimo-v2.5-pro', env: { ANTHROPIC_MODEL: 'mimo-v2.5-pro' } })
    expect(command.args.slice(0, 2)).toEqual(['--settings', JSON.stringify({ env: { ANTHROPIC_MODEL: 'mimo-v2.5-pro' } })])
    expect(command.args).not.toContain('--setting-sources')
    expect(command.args).not.toContain('local')
  })

  it('omits --model when profile env already defines the provider model', () => {
    expect(buildClaudeCommand({ model: 'MiniMax-M2.7', permissionMode: 'bypassPermissions', envModel: 'MiniMax-M2.7' })).toEqual({
      file: 'claude',
      args: ['--permission-mode', 'bypassPermissions']
    })
  })

  it('forks a new session when resuming CLI history', () => {
    expect(buildClaudeCommand({ model: 'claude-sonnet-4-6', permissionMode: 'default', resumeSessionId: '123e4567-e89b-12d3-a456-426614174000' })).toEqual({
      file: 'claude',
      args: ['--model', 'claude-sonnet-4-6', '--permission-mode', 'default', '--resume', '123e4567-e89b-12d3-a456-426614174000', '--fork-session']
    })
  })

  it('rejects unsafe env model names before shell launch', () => {
    expect(() => buildClaudeCommand({ model: 'MiniMax-M2.7', permissionMode: 'default', envModel: 'bad; rm -rf /' })).toThrow('Invalid model name')
  })

  it('rejects unsafe model names before shell launch', () => {
    expect(() => buildClaudeCommand({ model: 'sonnet; rm -rf /', permissionMode: 'default' })).toThrow('Invalid model name')
  })

  it('removes inherited auth token when launch env injects api key', () => {
    const result = buildClaudeProcessEnv({
      baseEnv: {
        PATH: '/usr/bin',
        ANTHROPIC_AUTH_TOKEN: 'dirty-token'
      },
      launchEnv: {
        ANTHROPIC_API_KEY: 'sk-provider'
      }
    })

    expect(result.PATH).toBe('/usr/bin')
    expect(result.ANTHROPIC_API_KEY).toBe('sk-provider')
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('removes inherited api key when launch env injects auth token', () => {
    const result = buildClaudeProcessEnv({
      baseEnv: {
        ANTHROPIC_API_KEY: 'dirty-key'
      },
      launchEnv: {
        ANTHROPIC_AUTH_TOKEN: 'provider-token'
      }
    })

    expect(result.ANTHROPIC_AUTH_TOKEN).toBe('provider-token')
    expect(result.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('rejects launch env with both Claude auth mechanisms', () => {
    expect(() => buildClaudeProcessEnv({
      baseEnv: {},
      launchEnv: {
        ANTHROPIC_API_KEY: 'sk-provider',
        ANTHROPIC_AUTH_TOKEN: 'provider-token'
      }
    })).toThrow('cannot set both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN')
  })

  it('resolves Windows executables from PATH for pty launch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-pty-path-'))
    try {
      const exePath = join(dir, 'claude.exe')
      await writeFile(exePath, '')
      const env = { PATH: dir, PATHEXT: '.EXE' }
      expect(resolveCommandForPty('claude', env, 'win32')).toBe(exePath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('starts a real pty process and forwards input', async () => {
    const emitter = new EventEmitter()
    const script = "process.stdout.write('ready\\n');process.stdin.on('data',d=>process.stdout.write('echo:'+d.toString(),()=>process.exit(0)))"
    const child = startPtyProcess({
      file: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
      onData: (chunk) => emitter.emit('data', chunk),
      onExit: () => emitter.emit('exit')
    })

    await waitForOutput(emitter, 'ready')
    child.write('ping\r')
    await expect(waitForOutput(emitter, 'echo:ping')).resolves.toContain('echo:ping')
    await once(emitter, 'exit')
  })
})