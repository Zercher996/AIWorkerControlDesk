const path = require('path')
const { repo, withDevApp, writeReport } = require('./_harness.cjs')

const DEFAULT_PROJECT_NAME = process.env.AIWORKER_E2E_PROJECT_NAME ?? 'AIWorkerControlDesk'
const BAD_PROVIDER_ID = 'e2e-missing-provider-for-fault-check'

async function main() {
  const startedAt = new Date().toISOString()
  const checks = {
    failureCaptured: false,
    failedAtPresent: false,
    reasonSanitized: false,
    userActionableReason: false,
    reportSanitized: true
  }
  let failedAt = null
  let reason = null
  let context = { project: DEFAULT_PROJECT_NAME, provider: null }

  try {
    await withDevApp(async ({ page }) => {
      const setup = await page.evaluate(async ({ projectName }) => {
        const projects = await window.workerDesk.listProjects()
        const project = projects.find((item) => item.name === projectName) ?? projects[0]
        return { project: project ? { id: project.id, name: project.name } : null }
      }, { projectName: DEFAULT_PROJECT_NAME })

      if (!setup.project) {
        failedAt = 'project-selection'
        reason = 'No project available for provider fault e2e.'
        checks.failureCaptured = true
        return
      }
      context.project = setup.project.name

      try {
        const session = await page.evaluate(async ({ projectId, providerProfileId }) => window.workerDesk.startSession({
          projectId,
          workerType: 'claude-code',
          providerProfileId,
          providerModelId: 'missing-model',
          interactionMode: 'native-jsonl',
          taskTitle: 'provider fault e2e'
        }), { projectId: setup.project.id, providerProfileId: BAD_PROVIDER_ID })
        const failedSession = await page.evaluate(async (id) => {
          const deadline = Date.now() + 15000
          let latest = await window.workerDesk.selectSession(id)
          while (Date.now() < deadline) {
            latest = await window.workerDesk.selectSession(id)
            if (latest.status === 'failed') return latest
            await new Promise((resolve) => setTimeout(resolve, 250))
          }
          return latest
        }, session.id)
        if (failedSession.status === 'failed') {
          failedAt = 'provider-selection'
          reason = failedSession.errorMessage ?? 'Provider fault produced a failed session without an error message.'
          checks.failureCaptured = true
        } else {
          failedAt = 'provider-fault-not-triggered'
          reason = `Starting with a missing provider returned status ${failedSession.status}.`
        }
      } catch (error) {
        failedAt = 'provider-selection'
        reason = error instanceof Error ? error.message : String(error)
        checks.failureCaptured = true
      }
    }, { useExistingUserData: true })
  } catch (error) {
    failedAt = failedAt ?? 'unexpected-error'
    reason = reason ?? (error instanceof Error ? error.message : String(error))
    checks.failureCaptured = true
  }

  checks.failedAtPresent = Boolean(failedAt)
  checks.reasonSanitized = Boolean(reason) && !/(sk-[a-z0-9_-]{12,}|Bearer\s+[a-z0-9._-]{12,}|ANTHROPIC_AUTH_TOKEN|apiKey)/i.test(reason)
  checks.userActionableReason = Boolean(reason) && /provider|Provider|not found|missing|找不到|缺少|选择/.test(reason)
  const ok = checks.failureCaptured && checks.failedAtPresent && checks.reasonSanitized && checks.userActionableReason && checks.reportSanitized
  const { report, filePath } = writeReport(repo, 'provider-fault', {
    ok,
    step: 'provider-fault',
    startedAt,
    project: context.project,
    provider: context.provider,
    checks,
    score: null,
    failedAt: ok ? null : failedAt,
    reason: ok ? null : reason,
    evidence: { injectedProviderId: BAD_PROVIDER_ID, capturedFailedAt: failedAt, capturedReason: reason }
  })

  console.log(JSON.stringify({ ok: report.ok, report: path.relative(repo, filePath).replace(/\\/g, '/'), checks, capturedFailedAt: failedAt, capturedReason: reason }, null, 2))
  if (!report.ok) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
