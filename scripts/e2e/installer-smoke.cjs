const { _electron: electron } = require('playwright')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { repo, wait, waitForExit, writeReport } = require('./_harness.cjs')

const BAD_PROVIDER_ID = 'installer-smoke-missing-provider'

function exists(relativePath) {
  return fs.existsSync(path.join(repo, relativePath))
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

async function main() {
  const startedAt = new Date().toISOString()
  const checks = {
    unpackedAppPresent: false,
    appStarted: false,
    rendererLoaded: false,
    workerDeskAvailable: false,
    projectListReadable: false,
    providerCatalogReadable: false,
    genericAgentConfigsReadable: false,
    isolatedUserDataUsed: false,
    providerFaultCaptured: false,
    failedAtPresent: false,
    reasonSanitized: false,
    reasonActionable: false,
    reportSanitized: true
  }
  let failedAt = null
  let reason = null
  const evidence = {
    mode: 'packaged-unpacked-app-smoke',
    userDataMode: 'isolated-temp',
    packagedInstaller: false
  }

  const executableRelativePath = process.platform === 'win32'
    ? 'dist/win-unpacked/AIWorkerControlDesk.exe'
    : 'dist/win-unpacked/AIWorkerControlDesk.exe'
  checks.unpackedAppPresent = exists(executableRelativePath)
  evidence.executable = executableRelativePath

  if (!checks.unpackedAppPresent) {
    failedAt = 'packaged-app-output'
    reason = `Missing packaged app executable: ${executableRelativePath}`
  } else {
    const testUserDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aiworker-installer-smoke-'))
    let app
    try {
      app = await electron.launch({
        executablePath: path.join(repo, executableRelativePath),
        env: {
          ...process.env,
          ELECTRON_DISABLE_GPU: '1',
          AIWORKER_TEST_USER_DATA_PATH: testUserDataPath
        }
      })
      checks.appStarted = true
      const page = await app.firstWindow({ timeout: 60000 })
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(error.message))
      await page.waitForLoadState('domcontentloaded')
      checks.rendererLoaded = true
      await page.waitForFunction(() => Boolean(window.workerDesk), null, { timeout: 30000 })
      checks.workerDeskAvailable = true

      const apiResult = await page.evaluate(async () => {
        const [projects, catalog, genericAgentConfigs] = await Promise.all([
          window.workerDesk.listProjects(),
          window.workerDesk.listProviderCatalog(),
          window.workerDesk.listGenericAgentConfigs()
        ])
        return {
          projectCount: Array.isArray(projects) ? projects.length : null,
          providerCount: Array.isArray(catalog?.providers) ? catalog.providers.length : null,
          genericAgentConfigCount: Array.isArray(genericAgentConfigs) ? genericAgentConfigs.length : null
        }
      })
      checks.projectListReadable = typeof apiResult.projectCount === 'number'
      checks.providerCatalogReadable = typeof apiResult.providerCount === 'number'
      checks.genericAgentConfigsReadable = typeof apiResult.genericAgentConfigCount === 'number'
      checks.isolatedUserDataUsed = testUserDataPath.startsWith(os.tmpdir()) && fs.existsSync(testUserDataPath)
      evidence.api = apiResult

      const fault = await page.evaluate(async ({ projectPath, providerProfileId }) => {
        const project = await window.workerDesk.addProject(projectPath)
        const session = await window.workerDesk.startSession({
          projectId: project.id,
          workerType: 'claude-code',
          providerProfileId,
          providerModelId: 'missing-model',
          interactionMode: 'native-jsonl',
          taskTitle: 'installer smoke provider fault'
        })
        const deadline = Date.now() + 15000
        let latest = await window.workerDesk.selectSession(session.id)
        while (Date.now() < deadline) {
          latest = await window.workerDesk.selectSession(session.id)
          if (latest.status === 'failed') break
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return {
          sessionId: session.id,
          status: latest.status,
          errorMessage: latest.errorMessage ?? null
        }
      }, { projectPath: repo, providerProfileId: BAD_PROVIDER_ID })
      checks.providerFaultCaptured = fault.status === 'failed'
      checks.failedAtPresent = Boolean(fault.errorMessage)
      checks.reasonSanitized = Boolean(fault.errorMessage)
        && !/(sk-[a-z0-9_-]{12,}|Bearer\s+[a-z0-9._-]{12,}|apiKey)/i.test(fault.errorMessage)
      checks.reasonActionable = Boolean(fault.errorMessage)
        && /provider|Provider|not found|missing|找不到|缺少|选择/.test(fault.errorMessage)
      evidence.providerFault = {
        sessionId: fault.sessionId,
        status: fault.status,
        errorMessage: fault.errorMessage
      }

      if (pageErrors.length > 0) {
        failedAt = failedAt ?? 'renderer'
        reason = reason ?? `Renderer page errors: ${pageErrors.join('; ')}`
      }
      if (!checks.providerFaultCaptured) {
        failedAt = failedAt ?? 'provider-fault'
        reason = reason ?? `Expected missing provider fault, got status ${fault.status}`
      }
    } catch (error) {
      failedAt = failedAt ?? 'installer-smoke'
      reason = reason ?? (error instanceof Error ? error.message : String(error))
    } finally {
      if (app) {
        const process = app.process()
        await app.close().catch(() => undefined)
        if (process) await waitForExit(process, 10000)
      }
      await removeDir(testUserDataPath)
    }
  }

  const ok = Object.values(checks).every(Boolean)
  const { report, filePath } = writeReport(repo, 'installer-smoke', {
    ok,
    step: 'installer-smoke',
    startedAt,
    project: 'AIWorkerControlDesk',
    provider: null,
    checks,
    score: null,
    failedAt: ok ? null : failedAt,
    reason: ok ? null : reason,
    evidence
  })

  console.log(JSON.stringify({
    ok: report.ok,
    report: path.relative(repo, filePath).replace(/\\/g, '/'),
    checks,
    failedAt: report.failedAt,
    reason: report.reason,
    evidence: report.evidence
  }, null, 2))
  if (!report.ok) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
