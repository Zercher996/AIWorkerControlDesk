const { _electron: electron } = require('playwright')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { repo, wait, waitForExit, writeReport } = require('./_harness.cjs')

const BAD_PROVIDER_ID = 'release-smoke-missing-provider'

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

function baseChecks() {
  return {
    buildOutputPresent: false,
    appStarted: false,
    rendererLoaded: false,
    workerDeskAvailable: false,
    projectListReadable: false,
    providerCatalogReadable: false,
    genericAgentConfigsReadable: false,
    isolatedUserDataUsed: false,
    reportSanitized: true
  }
}

function practicalChecks() {
  return {
    releaseProjectCreated: false,
    releaseFaultCaptured: false,
    releaseFailedAtPresent: false,
    releaseReasonSanitized: false,
    releaseReasonActionable: false
  }
}

async function runProviderFault(page) {
  const result = await page.evaluate(async ({ projectPath, providerProfileId }) => {
    const project = await window.workerDesk.addProject(projectPath)
    let capturedFailedAt = null
    let capturedReason = null
    let sessionId = null
    let status = null

    try {
      const session = await window.workerDesk.startSession({
        projectId: project.id,
        workerType: 'claude-code',
        providerProfileId,
        providerModelId: 'missing-model',
        interactionMode: 'native-jsonl',
        taskTitle: 'release smoke provider fault'
      })
      sessionId = session.id
      const deadline = Date.now() + 15000
      let latest = await window.workerDesk.selectSession(session.id)
      while (Date.now() < deadline) {
        latest = await window.workerDesk.selectSession(session.id)
        status = latest.status
        if (latest.status === 'failed') break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (latest.status === 'failed') {
        capturedFailedAt = 'provider-selection'
        capturedReason = latest.errorMessage ?? 'Provider fault produced a failed session without an error message.'
      } else {
        capturedFailedAt = 'provider-fault-not-triggered'
        capturedReason = `Starting with a missing provider returned status ${latest.status}.`
      }
    } catch (error) {
      capturedFailedAt = 'provider-selection'
      capturedReason = error instanceof Error ? error.message : String(error)
    }

    return {
      project: { id: project.id, name: project.name },
      sessionId,
      status,
      capturedFailedAt,
      capturedReason
    }
  }, { projectPath: repo, providerProfileId: BAD_PROVIDER_ID })

  return result
}

async function main() {
  const startedAt = new Date().toISOString()
  const includePractical = process.argv.includes('--practical')
  const checks = includePractical ? { ...baseChecks(), ...practicalChecks() } : baseChecks()
  let failedAt = null
  let reason = null
  const evidence = {
    mode: includePractical ? 'production-build-practical-smoke' : 'production-build-smoke',
    packagedInstaller: false,
    note: 'This smoke launches the production build output via Electron. A full installer/package smoke is reserved for a later release-candidate packaging step.'
  }

  const requiredOutputs = [
    'out/main/main.js',
    'out/preload/preload.mjs',
    'out/renderer/index.html'
  ]
  checks.buildOutputPresent = requiredOutputs.every(exists)

  if (!checks.buildOutputPresent) {
    failedAt = 'build-output'
    reason = `Missing production build output: ${requiredOutputs.filter((item) => !exists(item)).join(', ')}`
  } else {
    const testUserDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aiworker-release-smoke-'))
    evidence.userDataMode = 'isolated-temp'
    evidence.buildOutputs = requiredOutputs

    let app
    try {
      app = await electron.launch({
        args: ['.'],
        cwd: repo,
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

      if (includePractical) {
        const fault = await runProviderFault(page)
        checks.releaseProjectCreated = Boolean(fault.project?.id)
        checks.releaseFaultCaptured = fault.capturedFailedAt === 'provider-selection'
        checks.releaseFailedAtPresent = Boolean(fault.capturedFailedAt)
        checks.releaseReasonSanitized = Boolean(fault.capturedReason)
          && !/(sk-[a-z0-9_-]{12,}|Bearer\s+[a-z0-9._-]{12,}|ANTHROPIC_AUTH_TOKEN|apiKey)/i.test(fault.capturedReason)
        checks.releaseReasonActionable = Boolean(fault.capturedReason)
          && /provider|Provider|not found|missing|找不到|缺少|选择/.test(fault.capturedReason)
        evidence.practical = {
          projectName: fault.project?.name ?? null,
          sessionId: fault.sessionId,
          status: fault.status,
          capturedFailedAt: fault.capturedFailedAt,
          capturedReason: fault.capturedReason
        }
        if (!checks.releaseFaultCaptured) {
          failedAt = fault.capturedFailedAt ?? 'release-provider-fault'
          reason = fault.capturedReason ?? 'Release provider fault was not captured.'
        }
      }

      if (pageErrors.length > 0) {
        failedAt = failedAt ?? 'renderer'
        reason = reason ?? `Renderer page errors: ${pageErrors.join('; ')}`
      }
    } catch (error) {
      failedAt = failedAt ?? 'release-smoke'
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
  const step = includePractical ? 'release-practical-smoke' : 'release-smoke'
  const { report, filePath } = writeReport(repo, step, {
    ok,
    step,
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
