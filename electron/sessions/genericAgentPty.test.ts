import path from 'node:path'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { GenericAgentConfig } from '../../src/types/workerDesk'
import { startPtyProcess } from './claudePty'
import {
  buildGenericAgentCommand,
  buildGenericAgentEnv,
  createGenericAgentStarter,
  type GenericAgentProcessStarter
} from './genericAgentPty'

function createTestConfig(overrides?: Partial<GenericAgentConfig>): GenericAgentConfig {
  return {
    id: 'test-config',
    name: 'Test Config',
    home: process.cwd(),
    pythonCommand: 'python',
    entryScript: 'package.json',
    env: { GA_CUSTOM_VAR: 'custom-value' },
    ...overrides
  }
}

describe('genericAgentPty', () => {
  it('builds a GenericAgent Python command from config', () => {
    const config = createTestConfig()
    const command = buildGenericAgentCommand({ config, cwd: '/tmp/project-one' })

    expect(command.file).toBe('python')
    expect(path.normalize(command.args[0])).toBe(path.normalize(path.join(process.cwd(), 'package.json')))
    expect(command.args).toHaveLength(1)
    expect(command.cwd).toBe(process.cwd())
  })

  it('throws a clear error when entryScript does not exist', () => {
    const config = createTestConfig({ entryScript: 'missing-agent.py' })

    expect(() => buildGenericAgentCommand({ config, cwd: '/tmp/project-one' })).toThrow(
      'GenericAgent entry script not found'
    )
  })

  it('uses custom entryScript when provided', () => {
    const config = createTestConfig({ entryScript: 'package.json' })
    const command = buildGenericAgentCommand({ config, cwd: '/tmp/project-one' })

    expect(path.normalize(command.args[0])).toBe(path.normalize(path.join(process.cwd(), 'package.json')))
  })

  it('uses absolute entryScript path when provided', () => {
    const config = createTestConfig({ entryScript: process.execPath })
    const command = buildGenericAgentCommand({ config, cwd: '/tmp/project-one' })

    expect(command.args[0]).toBe(process.execPath)
  })

  it('does not pass local llm selector arguments in Provider-first mode', () => {
    const config = createTestConfig()
    const command = buildGenericAgentCommand({ config, cwd: '/tmp/project-one' })

    expect(command.args).toEqual([expect.stringContaining('package.json')])
  })

  it('merges config env into base env with GA defaults', () => {
    const config = createTestConfig()
    const result = buildGenericAgentEnv(config, { PATH: '/usr/bin', HOME: '/home/user' })

    expect(result.GA_CUSTOM_VAR).toBe('custom-value')
    expect(result.PATH).toBe('/usr/bin')
    expect(result.PYTHONUTF8).toBe('1')
    expect(result.PYTHONIOENCODING).toBe('utf-8')
    expect(result.GA_LANG).toBe('zh')
  })

  it('passes provider config JSON through env without writing temp files', () => {
    const config = createTestConfig()
    const providerConfigJson = JSON.stringify({ sessionType: 'native_oai', config: { name: 'openrouter', apikey: 'test-openrouter-key' } })
    const env = buildGenericAgentEnv(config, { PATH: '/usr/bin' }, providerConfigJson)

    expect(env.GENERIC_AGENT_PROVIDER_CONFIG_JSON).toBe(providerConfigJson)
    expect(Object.values(env).some((value) => String(value).includes('mykey.py'))).toBe(false)
  })

  it('keeps provider config JSON authoritative over local GenericAgent env', () => {
    const providerConfigJson = JSON.stringify({ sessionType: 'native_oai', config: { name: 'selected-provider', apikey: 'test-openrouter-key' } })
    const config = createTestConfig({
      env: {
        GENERIC_AGENT_PROVIDER_CONFIG_JSON: JSON.stringify({ sessionType: 'native_oai', config: { name: 'local-provider' } })
      }
    })

    const env = buildGenericAgentEnv(config, { PATH: '/usr/bin' }, providerConfigJson)

    expect(env.GENERIC_AGENT_PROVIDER_CONFIG_JSON).toBe(providerConfigJson)
  })

  it('accepts optional launchConfig in starter and merges env with providerConfigJson', () => {
    const config = createTestConfig()
    const providerConfigJson = JSON.stringify({ sessionType: 'native_claude', config: { name: 'anthropic', apikey: 'test-anthropic-key' } })
    const launchConfig = {
      command: { file: 'python', args: ['custom.py'], cwd: config.home },
      env: { CUSTOM_VAR: 'custom-value' },
      providerConfigJson
    }

    const emitter = new EventEmitter()
    const script = "process.stdout.write('ready\\n');process.stdin.on('data',d=>process.stdout.write('got:'+d.toString(),()=>process.exit(0)))"

    const startProcess: GenericAgentProcessStarter = ({ cwd, env, cols, rows, onData, onExit }) => {
      emitter.emit('env', env)
      return startPtyProcess({
        file: process.execPath,
        args: ['-e', script],
        cwd,
        env,
        cols,
        rows,
        onData,
        onExit
      })
    }

    const startGenericAgentPty = createGenericAgentStarter(startProcess)

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for env event')), 5000)
      emitter.on('env', (env: NodeJS.ProcessEnv) => {
        clearTimeout(timer)
        expect(env.GENERIC_AGENT_PROVIDER_CONFIG_JSON).toBe(providerConfigJson)
        expect(env.CUSTOM_VAR).toBe('custom-value')
        expect(Object.values(env).some((value) => String(value).includes('mykey.py'))).toBe(false)
        resolve()
      })

      startGenericAgentPty({
        config,
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        launchConfig,
        onData: (chunk) => emitter.emit('data', chunk),
        onExit: () => emitter.emit('exit')
      })
    })
  })

  it('writes initialPrompt to stdin after process starts', async () => {
    const emitter = new EventEmitter()
    const script = "process.stdout.write('ready\\n');process.stdin.on('data',d=>process.stdout.write('got:'+d.toString(),()=>process.exit(0)))"

    const startProcess: GenericAgentProcessStarter = ({ cwd, env, cols, rows, onData, onExit }) => {
      return startPtyProcess({
        file: process.execPath,
        args: ['-e', script],
        cwd,
        env,
        cols,
        rows,
        onData,
        onExit
      })
    }

    const startGenericAgentPty = createGenericAgentStarter(startProcess)

    startGenericAgentPty({
      config: createTestConfig(),
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      initialPrompt: 'do the thing',
      onData: (chunk) => emitter.emit('data', chunk),
      onExit: () => emitter.emit('exit')
    })

    await new Promise<void>((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error(`timeout waiting for got: buf=${JSON.stringify(buf)}`)), 10000)
      emitter.on('data', (chunk: string) => {
        buf += chunk
        if (buf.includes('got:do the thing')) {
          clearTimeout(timer)
          resolve()
        }
      })
    })

    await once(emitter, 'exit')
  }, 15000)
})
