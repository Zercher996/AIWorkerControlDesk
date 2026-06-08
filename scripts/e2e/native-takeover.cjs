const path = require('path')
const { repo, wait, withDevApp, writeReport } = require('./_harness.cjs')
const { pickClaudeCodeProvider } = require('./_provider-selection.cjs')

const DEFAULT_PROVIDER_ID = process.env.AIWORKER_E2E_PROVIDER_ID
const DEFAULT_MODEL_ID = process.env.AIWORKER_E2E_MODEL_ID
const DEFAULT_PROJECT_NAME = process.env.AIWORKER_E2E_PROJECT_NAME ?? 'AIWorkerControlDesk'

async function main() {
  const startedAt = new Date().toISOString()
  const checks = {
    sessionStarted: false,
    sameSessionReused: false,
    noExtraClaudeSession: false,
    inputRouteStable: false,
    reportSanitized: true
  }
  let failedAt = null
  let reason = null
  let context = { project: DEFAULT_PROJECT_NAME, provider: null, sessionId: null, processIdBefore: null, processIdAfter: null }

  try {
    await withDevApp(async ({ page }) => {
      const setupBase = await page.evaluate(async ({ projectName }) => {
        const [projects, catalog] = await Promise.all([
          window.workerDesk.listProjects(),
          window.workerDesk.listProviderCatalog()
        ])
        const project = projects.find((item) => item.name === projectName) ?? projects[0]
        return {
          project: project ? { id: project.id, name: project.name } : null,
          catalog
        }
      }, { projectName: DEFAULT_PROJECT_NAME })
      const providerPick = pickClaudeCodeProvider(setupBase.catalog, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_ID)
      const setup = {
        ...setupBase,
        provider: providerPick.provider,
        modelId: providerPick.modelId,
        providerReason: providerPick.reason
      }

      if (!setup.project) {
        failedAt = 'project-selection'
        reason = `No project available for ${DEFAULT_PROJECT_NAME}`
        return
      }
      if (!setup.provider?.adapters?.claudeCode?.enabled) {
        failedAt = 'provider-selection'
        reason = setup.providerReason ?? 'No Claude Code provider is available for native takeover e2e'
        return
      }
      if (!setup.modelId) {
        failedAt = 'model-selection'
        reason = setup.providerReason ?? `Provider ${setup.provider.name} has no Claude Code model`
        return
      }
      context.project = setup.project.name
      context.provider = setup.provider.name

      const session = await page.evaluate(async ({ projectId, providerProfileId, providerModelId }) => window.workerDesk.startSession({
        projectId,
        workerType: 'claude-code',
        providerProfileId,
        providerModelId,
        interactionMode: 'native-jsonl',
        taskTitle: 'native takeover e2e'
      }), { projectId: setup.project.id, providerProfileId: setup.provider.id, providerModelId: setup.modelId })

      context.sessionId = session.id
      context.processIdBefore = session.processId ?? null
      checks.sessionStarted = Boolean(session.id)
      const beforeSessions = await page.evaluate(async () => window.workerDesk.listSessions())
      const beforeClaudeCount = beforeSessions.filter((item) => item.workerType === 'claude-code').length

      await page.evaluate(async ({ id }) => {
        await window.workerDesk.writeSessionInput(id, '/permissions\r')
      }, { id: session.id })
      await wait(1000)

      const afterSession = await page.evaluate(async (id) => window.workerDesk.selectSession(id), session.id)
      const afterSessions = await page.evaluate(async () => window.workerDesk.listSessions())
      const afterClaudeCount = afterSessions.filter((item) => item.workerType === 'claude-code').length
      context.processIdAfter = afterSession.processId ?? null

      checks.sameSessionReused = afterSession.id === session.id
      checks.noExtraClaudeSession = afterClaudeCount === beforeClaudeCount
      checks.inputRouteStable = afterSession.id === session.id && afterSession.workerType === 'claude-code'

      await page.evaluate(async (id) => {
        await window.workerDesk.stopSession(id)
      }, session.id).catch(() => undefined)

      if (!checks.sameSessionReused) {
        failedAt = 'same-session'
        reason = 'Native takeover did not keep the original session selected'
      } else if (!checks.noExtraClaudeSession) {
        failedAt = 'extra-session'
        reason = `Claude Code session count changed from ${beforeClaudeCount} to ${afterClaudeCount}`
      } else if (!checks.inputRouteStable) {
        failedAt = 'input-route'
        reason = 'Input route did not remain on the original Claude Code session'
      }
    }, { useExistingUserData: true })
  } catch (error) {
    failedAt = failedAt ?? 'unexpected-error'
    reason = reason ?? (error instanceof Error ? error.message : String(error))
  }

  const ok = Object.values(checks).every(Boolean)
  const { report, filePath } = writeReport(repo, 'native-takeover', {
    ok,
    step: 'native-takeover',
    startedAt,
    project: context.project,
    provider: context.provider,
    checks,
    score: null,
    failedAt: ok ? null : failedAt,
    reason: ok ? null : reason,
    evidence: {
      sessionId: context.sessionId,
      processIdBefore: context.processIdBefore,
      processIdAfter: context.processIdAfter
    }
  })

  console.log(JSON.stringify({ ok: report.ok, report: path.relative(repo, filePath).replace(/\\/g, '/'), checks, failedAt: report.failedAt, reason: report.reason }, null, 2))
  if (!report.ok) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
