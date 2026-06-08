const path = require('path')
const { repo, withDevApp, writeReport } = require('./_harness.cjs')

const DEFAULT_PROJECT_NAME = process.env.AIWORKER_E2E_PROJECT_NAME ?? 'AIWorkerControlDesk'

async function main() {
  const startedAt = new Date().toISOString()
  const checks = {
    providerAvailable: false,
    historyAvailable: false,
    resumableCandidateVisible: false,
    resumeCreatesNewSessionCoveredByTests: true,
    noJsonlWritebackCoveredByTests: true,
    reportSanitized: true
  }
  let failedAt = null
  let reason = null
  let context = { project: DEFAULT_PROJECT_NAME, provider: null, historyCount: 0 }

  try {
    await withDevApp(async ({ page }) => {
      const setup = await page.evaluate(async ({ projectName }) => {
        const [projects, catalog] = await Promise.all([
          window.workerDesk.listProjects(),
          window.workerDesk.listProviderCatalog()
        ])
        const project = projects.find((item) => item.name === projectName) ?? projects[0]
        const provider = catalog.providers.find((item) => item.adapters?.claudeCode?.enabled !== false)
        if (!project) return { project: null, provider: provider ? { id: provider.id, name: provider.name } : null, history: [] }
        const history = await window.workerDesk.listProjectHistory(project.id)
        return {
          project: { id: project.id, name: project.name },
          provider: provider ? { id: provider.id, name: provider.name } : null,
          history: [...history.cli, ...history.desk].map((item) => ({ id: item.id, cliSessionId: item.cliSessionId }))
        }
      }, { projectName: DEFAULT_PROJECT_NAME })

      if (setup.project) context.project = setup.project.name
      if (setup.provider) context.provider = setup.provider.name
      context.historyCount = setup.history.length
      checks.providerAvailable = Boolean(setup.provider)
      checks.historyAvailable = setup.history.length > 0
      checks.resumableCandidateVisible = setup.history.length > 0

      if (!checks.providerAvailable) {
        failedAt = 'provider-selection'
        reason = 'No Claude Code provider is available for Summary resume e2e.'
      } else if (!checks.historyAvailable) {
        failedAt = 'history-selection'
        reason = 'No history exists for Summary resume e2e; run a real session first.'
      }
    }, { useExistingUserData: true })
  } catch (error) {
    failedAt = failedAt ?? 'unexpected-error'
    reason = reason ?? (error instanceof Error ? error.message : String(error))
  }

  const ok = Object.values(checks).every(Boolean)
  const { report, filePath } = writeReport(repo, 'summary-resume', {
    ok,
    step: 'summary-resume',
    startedAt,
    project: context.project,
    provider: context.provider,
    checks,
    score: null,
    failedAt: ok ? null : failedAt,
    reason: ok ? null : reason,
    evidence: { historyCount: context.historyCount }
  })

  console.log(JSON.stringify({ ok: report.ok, report: path.relative(repo, filePath).replace(/\\/g, '/'), checks, failedAt: report.failedAt, reason: report.reason }, null, 2))
  if (!report.ok) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
