const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const net = require('net')
const os = require('os')
const { spawn } = require('child_process')
const {
  assert,
  assertCurrentShell,
  assertScreenshotNotBlank,
  assertVisibleShell
} = require('./ui-smoke-assertions.cjs')

const repo = process.cwd()
const darkScreenshotPath = path.join(repo, 'playwright-stage3-smoke-dev-dark.png')
const lightScreenshotPath = path.join(repo, 'playwright-stage3-smoke-dev-light.png')

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

async function removeTempDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 4) {
        console.warn(`Could not remove temporary dev smoke userData directory: ${dir}: ${error.message}`)
        return
      }
      await wait(250)
    }
  }
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
  throw new Error(`Timed out waiting for electron-vite dev debugging endpoint: ${lastError?.message ?? 'no response'}`)
}

async function waitForAppPage(browser, timeoutMs = 60000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().startsWith('http://localhost') || page.url().startsWith('http://127.0.0.1')) {
          return page
        }
      }
    }
    await wait(250)
  }
  throw new Error('Timed out waiting for dev Electron renderer page')
}

async function main() {
  const remoteDebuggingPort = await getFreePort()
  const testUserDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aiworker-dev-smoke-'))
  const electronViteBin = path.join(repo, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  assert(fs.existsSync(electronViteBin), `electron-vite CLI should exist: ${electronViteBin}`)
  const dev = spawn(process.execPath, [electronViteBin, 'dev', '--remoteDebuggingPort', String(remoteDebuggingPort), '--clearScreen=false'], {
    cwd: repo,
    shell: false,
    env: {
      ...process.env,
      ELECTRON_DISABLE_GPU: '1',
      AIWORKER_TEST_USER_DATA_PATH: testUserDataPath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const output = []
  dev.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    output.push(text)
    process.stdout.write(`[dev:stdout] ${text}`)
  })
  dev.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    output.push(text)
    process.stderr.write(`[dev:stderr] ${text}`)
  })

  let browser
  try {
    const wsEndpoint = await waitForDevToolsEndpoint(remoteDebuggingPort)
    browser = await chromium.connectOverCDP(wsEndpoint)
    const page = await waitForAppPage(browser)
    const pageErrors = []

    page.on('console', (msg) => console.log(`[renderer:${msg.type()}] ${msg.text()}`))
    page.on('pageerror', (err) => {
      pageErrors.push(err.message)
      console.log(`[renderer:pageerror] ${err.message}`)
    })

    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(1500)
    await assertCurrentShell(page)

    assert(await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'Dev theme should default to dark')
    await assertVisibleShell(page, 'dark')
    await assertScreenshotNotBlank(page, darkScreenshotPath, 'Dev dark theme', { checkWindowControls: true })

    await page.getByRole('button', { name: '切换到浅色模式', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    await assertCurrentShell(page)
    await assertVisibleShell(page, 'light')
    await assertScreenshotNotBlank(page, lightScreenshotPath, 'Dev light theme', { checkWindowControls: true })

    assert(pageErrors.length === 0, `Dev renderer page errors: ${pageErrors.join('; ')}`)

    console.log(JSON.stringify({
      ok: true,
      mode: 'dev',
      screenshots: {
        dark: darkScreenshotPath,
        light: lightScreenshotPath
      },
      checked: [
        'electron-vite dev renderer window is reachable through CDP',
        'Current three-column shell labels are visible in dev mode',
        'Theme tokens resolve in dev dark and light modes',
        'Shell and three work areas have visible computed layout in dev mode',
        'Dev dark screenshot is not visually blank',
        'Dev light screenshot is not visually blank after theme switch'
      ]
    }, null, 2))
  } catch (error) {
    console.error(output.join(''))
    throw error
  } finally {
    if (browser) await browser.close()
    await waitForExit(dev)
    await removeTempDir(testUserDataPath)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
