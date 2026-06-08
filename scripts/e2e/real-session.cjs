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
    providerModelPinned: false,
    aiEventsReceived: false,
    reportSanitized: false
  }
  let failedAt = null
  let reason = null
  let reportContext = {
    project: DEFAULT_PROJECT_NAME,
    provider: null,
    sessionId: null,
    model: DEFAULT_MODEL_ID,
    firstEventType: null,
    latestStatus: null
  }

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
          catalog,
          providers: catalog.providers.map((item) => ({ id: item.id, name: item.name }))
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
        throw new Error(reason)
      }
      reportContext.project = setup.project.name
      if (!setup.provider) {
        failedAt = 'provider-selection'
        reason = setup.providerReason
        throw new Error(reason)
      }
      if (!setup.provider.adapters?.claudeCode?.enabled) {
        failedAt = 'provider-compatibility'
        reason = `Provider ${setup.provider.name} does not enable Claude Code adapter`
        throw new Error(reason)
      }
      if (!setup.modelId) {
        failedAt = 'model-selection'
        reason = setup.providerReason ?? `Provider ${setup.provider.name} has no Claude Code model`
        throw new Error(reason)
      }
      reportContext.provider = setup.provider.name
      reportContext.model = setup.modelId

      const session = await page.evaluate(async ({ projectId, providerProfileId, providerModelId }) => {
        return window.workerDesk.startSession({
          projectId,
          workerType: 'claude-code',
          providerProfileId,
          providerModelId,
          interactionMode: 'native-jsonl',
          taskTitle: 'real-session e2e pong'
        })
      }, {
        projectId: setup.project.id,
        providerProfileId: setup.provider.id,
        providerModelId: setup.modelId
      })
      reportContext.sessionId = session.id
      reportContext.latestStatus = session.status
      checks.sessionStarted = ['starting', 'running', 'waiting'].includes(session.status)
      checks.providerModelPinned = session.providerProfileId === setup.provider.id
        && session.providerName === setup.provider.name
        && session.modelId === setup.modelId
      if (!checks.sessionStarted) {
        failedAt = 'session-start'
        reason = `Unexpected initial status ${session.status}`
        throw new Error(reason)
      }
      if (!checks.providerModelPinned) {
        failedAt = 'provider-injection'
        reason = `Session provider/model mismatch: provider=${session.providerName}, model=${session.modelId}`
        throw new Error(reason)
      }

      await wait(2500)
      await page.evaluate(async ({ id }) => {
        await window.workerDesk.writeSessionInput(id, '只回复 pong，不要解释。\r')
      }, { id: session.id })

      const result = await page.evaluate(async ({ id }) => {
        const deadline = Date.now() + 120000
        let latestSession = await window.workerDesk.selectSession(id)
        let latestEvents = []
        while (Date.now() < deadline) {
          latestSession = await window.workerDesk.selectSession(id)
          const eventPage = await window.workerDesk.getSessionAiEvents({ sessionId: id, limit: 200 })
          latestEvents = eventPage.events
          if (latestEvents.length > 0) {
            const assistantEvidence = latestEvents
              .filter((event) => event.type === 'assistant_text')
              .map((event) => event.text ?? '')
              .join('\n')
              .toLowerCase()
            if (assistantEvidence.includes('pong') || latestEvents.some((event) => event.type === 'turn_end' || event.type === 'tool_use' || event.type === 'result')) {
              return { ok: true, latestSession, latestEvents }
            }
          }
          if (latestSession.status === 'failed') {
            return { ok: false, latestSession, latestEvents, reason: latestSession.errorMessage ?? 'session failed' }
          }
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        const latestDiagnostic = latestEvents
          .filter((event) => event.type === 'diagnostic')
          .at(-1)
        return {
          ok: false,
          latestSession,
          latestEvents,
          reason: latestDiagnostic?.message
            ? `timed out waiting for assistant events; latest diagnostic: ${latestDiagnostic.message}`
            : 'timed out waiting for native-jsonl events'
        }
      }, { id: session.id })

      reportContext.latestStatus = result.latestSession?.status ?? reportContext.latestStatus
      reportContext.firstEventType = result.latestEvents[0]?.type ?? null
      checks.aiEventsReceived = result.ok && result.latestEvents.length > 0
      await page.evaluate(async (id) => {
        await window.workerDesk.stopSession(id)
      }, session.id).catch(() => undefined)

      if (!checks.aiEventsReceived) {
        failedAt = 'native-jsonl-events'
        reason = result.reason ?? 'native-jsonl events missing'
        throw new Error(reason)
      }
    }, { useExistingUserData: true })
  } catch (error) {
    if (!failedAt) failedAt = 'unexpected-error'
    if (!reason) reason = error instanceof Error ? error.message : String(error)
  }

  checks.reportSanitized = true
  const ok = Object.values(checks).every(Boolean)
  const { report, filePath } = writeReport(repo, 'real-session', {
    ok,
    step: 'real-session',
    startedAt,
    project: reportContext.project,
    provider: reportContext.provider,
    checks,
    score: null,
    failedAt: ok ? null : failedAt,
    reason: ok ? null : reason,
    evidence: {
      sessionId: reportContext.sessionId,
      model: reportContext.model,
      firstEventType: reportContext.firstEventType,
      latestStatus: reportContext.latestStatus
    }
  })

  console.log(JSON.stringify({ ok: report.ok, report: path.relative(repo, filePath).replace(/\\/g, '/'), checks, failedAt: report.failedAt, reason: report.reason }, null, 2))
  if (!report.ok) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
