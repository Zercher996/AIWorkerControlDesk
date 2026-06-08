const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const net = require('net')
const { spawn } = require('child_process')

const repo = process.cwd()

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

async function main() {
  const remoteDebuggingPort = await getFreePort()
  const electronViteBin = path.join(repo, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  const dev = spawn(process.execPath, [electronViteBin, 'dev', '--remoteDebuggingPort', String(remoteDebuggingPort), '--clearScreen=false'], {
    cwd: repo,
    shell: false,
    env: {
      ...process.env,
      ELECTRON_DISABLE_GPU: '1'
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
  let sessionId
  try {
    const wsEndpoint = await waitForDevToolsEndpoint(remoteDebuggingPort)
    browser = await chromium.connectOverCDP(wsEndpoint)
    const page = await waitForAppPage(browser)
    page.on('console', (msg) => console.log(`[renderer:${msg.type()}] ${msg.text()}`))
    page.on('pageerror', (err) => console.log(`[renderer:pageerror] ${err.message}`))
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.workerDesk), null, { timeout: 30000 })

    const setup = await page.evaluate(async () => {
      const [projects, catalog] = await Promise.all([
        window.workerDesk.listProjects(),
        window.workerDesk.listProviderCatalog()
      ])
      const project = projects.find((item) => item.name === 'AIWorkerControlDesk') ?? projects[0]
      const provider = catalog.providers.find((item) => item.id === 'mimo-openai-genericagent')
      return {
        project,
        provider,
        providers: catalog.providers.map((item) => ({ id: item.id, name: item.name, adapters: item.adapters, defaults: item.defaults }))
      }
    })

    if (!setup.project) throw new Error('No project available for validation')
    if (!setup.provider) throw new Error(`MIMO provider missing. Providers: ${JSON.stringify(setup.providers)}`)
    if (!setup.provider.adapters?.claudeCode?.enabled) throw new Error(`MIMO provider Claude Code adapter is not enabled: ${JSON.stringify(setup.provider)}`)

    const prompt = '只回复 pong，不要解释。'
    const session = await page.evaluate(async ({ projectId, providerProfileId, providerModelId }) => {
      return window.workerDesk.startSession({
        projectId,
        workerType: 'claude-code',
        providerProfileId,
        providerModelId,
        interactionMode: 'native-jsonl',
        taskTitle: 'MIMO CC relay 验收'
      })
    }, {
      projectId: setup.project.id,
      providerProfileId: setup.provider.id,
      providerModelId: 'mimo-v2.5'
    })
    sessionId = session.id
    console.log(`[validation] started session ${sessionId} initial status=${session.status}`)

    await wait(2500)
    await page.evaluate(async ({ id, text }) => {
      await window.workerDesk.writeSessionInput(id, `${text}\r`)
    }, { id: sessionId, text: prompt })

    const result = await page.evaluate(async ({ id }) => {
      const deadline = Date.now() + 120000
      let latestSession = await window.workerDesk.selectSession(id)
      let latestEvents = []
      let output = ''
      while (Date.now() < deadline) {
        latestSession = await window.workerDesk.selectSession(id)
        output = await window.workerDesk.getOutputBuffer(id)
        const eventPage = await window.workerDesk.getSessionAiEvents({ sessionId: id, limit: 200 })
        latestEvents = eventPage.events
        const assistantEvidence = latestEvents
          .filter((event) => event.type === 'assistant_text')
          .map((event) => event.text ?? '')
          .join('\n')
          .toLowerCase()
        if (assistantEvidence.includes('pong')) {
          return { ok: true, latestSession, output, latestEvents }
        }
        if (latestSession.status === 'failed') {
          return { ok: false, latestSession, output, latestEvents, reason: latestSession.errorMessage ?? 'session failed' }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      return { ok: false, latestSession, output, latestEvents, reason: 'timed out waiting for pong evidence' }
    }, { id: sessionId })

    await page.evaluate(async (id) => {
      await window.workerDesk.stopSession(id)
    }, sessionId).catch(() => undefined)

    fs.writeFileSync(path.join(repo, 'playwright-mimo-cc-relay-validation.json'), JSON.stringify({
      project: { id: setup.project.id, name: setup.project.name, path: setup.project.path },
      provider: { id: setup.provider.id, name: setup.provider.name },
      sessionId,
      result
    }, null, 2))

    if (!result.ok) {
      throw new Error(`MIMO CC relay app validation failed: ${result.reason}; status=${result.latestSession?.status}; error=${result.latestSession?.errorMessage ?? ''}`)
    }

    console.log(JSON.stringify({
      ok: true,
      sessionId,
      status: result.latestSession.status,
      provider: setup.provider.name,
      model: 'mimo-v2.5',
      evidenceFile: path.join(repo, 'playwright-mimo-cc-relay-validation.json')
    }, null, 2))
  } catch (error) {
    console.error(output.join(''))
    throw error
  } finally {
    if (browser) await browser.close()
    await waitForExit(dev)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
