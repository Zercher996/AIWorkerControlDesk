import type { BrowserWindow, Event } from 'electron'
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

export type CrashEvent = {
  type: 'uncaughtException' | 'unhandledRejection' | 'render-process-gone' | 'child-process-gone'
  occurredAt: string
  message?: string
  stack?: string
  reason?: string
  exitCode?: number
  serviceName?: string
  name?: string
}

type ChildProcessGoneDetails = {
  reason: string
  exitCode: number
  serviceName?: string
  name?: string
}

type UnknownErrorDetails = {
  message?: string
  stack?: string
}

export function safeAppendCrashEvent(crashEventsPath: string, event: CrashEvent): void {
  try {
    mkdirSync(dirname(crashEventsPath), { recursive: true })
    const fd = openSync(crashEventsPath, 'a')
    try {
      writeSync(fd, `${JSON.stringify(event)}\n`, undefined, 'utf-8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    console.error('Failed to write crash event', error)
  }
}

export function registerProcessCrashGuards(crashEventsPath: string): void {
  process.on('uncaughtException', (error) => {
    safeAppendCrashEvent(crashEventsPath, {
      type: 'uncaughtException',
      occurredAt: new Date().toISOString(),
      ...toErrorDetails(error)
    })
  })

  process.on('unhandledRejection', (reason) => {
    safeAppendCrashEvent(crashEventsPath, {
      type: 'unhandledRejection',
      occurredAt: new Date().toISOString(),
      ...toErrorDetails(reason)
    })
  })
}

export function attachWindowCrashGuards(window: BrowserWindow, crashEventsPath: string): void {
  window.webContents.on('render-process-gone', (_event, details) => {
    safeAppendCrashEvent(crashEventsPath, {
      type: 'render-process-gone',
      occurredAt: new Date().toISOString(),
      reason: details.reason,
      exitCode: details.exitCode
    })
  })

  window.webContents.on('child-process-gone' as never, (_event: Event, details: ChildProcessGoneDetails) => {
    safeAppendCrashEvent(crashEventsPath, {
      type: 'child-process-gone',
      occurredAt: new Date().toISOString(),
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name
    })
  })
}

function toErrorDetails(error: unknown): UnknownErrorDetails {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    }
  }
  return { message: String(error) }
}
