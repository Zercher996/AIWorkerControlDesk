import { afterEach, describe, expect, it } from 'vitest'
import { resolveHookNodeExecutable } from './claudeHookSettings'

const originalExecPath = process.execPath
const originalNpmNodeExecPath = process.env.npm_node_execpath

afterEach(() => {
  Object.defineProperty(process, 'execPath', {
    value: originalExecPath,
    configurable: true
  })
  if (originalNpmNodeExecPath === undefined) {
    delete process.env.npm_node_execpath
  } else {
    process.env.npm_node_execpath = originalNpmNodeExecPath
  }
})

describe('resolveHookNodeExecutable', () => {
  it('prefers npm_node_execpath when Electron is the current executable', () => {
    Object.defineProperty(process, 'execPath', {
      value: 'C:/Program Files/Electron/electron.exe',
      configurable: true
    })
    process.env.npm_node_execpath = 'C:/Program Files/nodejs/node.exe'

    expect(resolveHookNodeExecutable()).toBe('C:/Program Files/nodejs/node.exe')
  })

  it('uses the current executable when already running on node', () => {
    delete process.env.npm_node_execpath
    Object.defineProperty(process, 'execPath', {
      value: 'C:/Program Files/nodejs/node.exe',
      configurable: true
    })

    expect(resolveHookNodeExecutable()).toBe('C:/Program Files/nodejs/node.exe')
  })

  it('falls back to node when Electron is the current executable and no node path is available', () => {
    delete process.env.npm_node_execpath
    Object.defineProperty(process, 'execPath', {
      value: 'C:/Program Files/Electron/electron.exe',
      configurable: true
    })

    expect(resolveHookNodeExecutable()).toBe('node')
  })
})
