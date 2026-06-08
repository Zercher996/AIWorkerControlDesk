const { chromium } = require('playwright')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { validateReport, writeReport } = require('./_report.cjs')

const repo = path.resolve(__dirname, '..', '..')

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (!address || typeof address === 'string') reject(new Error('Could not allocate a local debug port'))
        else resolve(address.port)
      })
    })
  })
}

async function waitForDevToolsEndpoint(remoteDebuggingPort, timeoutMs = 60000) {
  const startedAt = Date.now()
  let lastError
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/version`)
      if (response.ok) {
        const info = await response.json()
        if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl
      }
    } catch (error) {
      lastError = error
    }
    await wait(500)
  }
  throw new Error(`Timed out waiting for Electron debug endpoint: ${lastError?.message ?? 'no response'}`)
}

async function waitForAppPage(browser, timeoutMs = 60000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().startsWith('http://localhost') || page.url().startsWith('http://127.0.0.1')) return page
      }
    }
    await wait(250)
  }
  throw new Error('Timed out waiting for Electron renderer page')
}

function waitForExit(child, timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill()
  })
}

async function removeDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await wait(250)
    }
  }
}

async function withDevApp(callback, options = {}) {
  const remoteDebuggingPort = await getFreePort()
  const testUserDataPath = options.useExistingUserData
    ? undefined
    : fs.mkdtempSync(path.join(os.tmpdir(), 'aiworker-e2e-'))
  const electronViteBin = path.join(repo, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  if (!fs.existsSync(electronViteBin)) throw new Error(`electron-vite CLI missing: ${electronViteBin}`)

  const env = {
    ...process.env,
    ELECTRON_DISABLE_GPU: '1'
  }
  if (options.userDataPath ?? testUserDataPath) env.AIWORKER_TEST_USER_DATA_PATH = options.userDataPath ?? testUserDataPath

  const dev = spawn(process.execPath, [electronViteBin, 'dev', '--remoteDebuggingPort', String(remoteDebuggingPort), '--clearScreen=false'], {
    cwd: repo,
    shell: false,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const output = []
  dev.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    output.push(text)
    if (options.streamLogs) process.stdout.write(`[dev:stdout] ${text}`)
  })
  dev.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    output.push(text)
    if (options.streamLogs) process.stderr.write(`[dev:stderr] ${text}`)
  })

  let browser
  try {
    const wsEndpoint = await waitForDevToolsEndpoint(remoteDebuggingPort)
    browser = await chromium.connectOverCDP(wsEndpoint)
    const page = await waitForAppPage(browser)
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    if (options.streamLogs) page.on('console', (msg) => console.log(`[renderer:${msg.type()}] ${msg.text()}`))
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.workerDesk), null, { timeout: 30000 })
    const result = await callback({ page, browser, testUserDataPath, remoteDebuggingPort, pageErrors, output })
    if (pageErrors.length > 0 && !options.allowPageErrors) throw new Error(`Renderer page errors: ${pageErrors.join('; ')}`)
    return result
  } catch (error) {
    if (output.length > 0) console.error(output.join(''))
    throw error
  } finally {
    if (browser) await browser.close()
    await waitForExit(dev)
    if (!options.userDataPath) await removeDir(testUserDataPath)
  }
}

async function selfcheck() {
  const startedAt = new Date().toISOString()
  const checks = {
    appStarted: false,
    workerDeskAvailable: false,
    reportSchemaValid: false
  }
  let reportFile

  await withDevApp(async ({ page }) => {
    checks.appStarted = true
    checks.workerDeskAvailable = await page.evaluate(() => Boolean(window.workerDesk))
  })

  const draft = {
    ok: true,
    step: 'harness-selfcheck',
    startedAt,
    project: 'AIWorkerControlDesk',
    provider: null,
    checks,
    score: { hard: 60, subjective: 40, total: 100, rater: 'V', pass: true },
    failedAt: null,
    reason: null,
    evidence: {}
  }
  checks.reportSchemaValid = validateReport(draft).ok
  const written = writeReport(repo, 'harness-selfcheck', draft)
  reportFile = written.filePath
  console.log(JSON.stringify({ ok: true, report: path.relative(repo, reportFile).replace(/\\/g, '/'), checks }, null, 2))
}

if (require.main === module) {
  if (process.argv.includes('--selfcheck')) {
    selfcheck().catch((error) => {
      console.error(error)
      process.exit(1)
    })
  } else if (process.argv.includes('--list-checks')) {
    console.log(JSON.stringify([
      'start.session-real',
      'start.provider-injected',
      'start.jsonl-event',
      'watch.radar-grouping',
      'watch.parent-child',
      'takeover.input-route',
      'takeover.same-process',
      'dispatch.child-created',
      'dispatch.result-return',
      'resume.new-session',
      'resume.no-jsonl-writeback',
      'fault.locatable'
    ], null, 2))
  } else {
    console.error('Usage: node scripts/e2e/_harness.cjs --selfcheck|--list-checks')
    process.exit(1)
  }
}

module.exports = {
  repo,
  wait,
  waitForExit,
  withDevApp,
  writeReport
}
