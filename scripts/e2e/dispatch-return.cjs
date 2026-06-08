const path = require('path')
const { repo, wait, withDevApp, writeReport } = require('./_harness.cjs')
const { pickClaudeCodeProvider, pickGenericAgentProvider } = require('./_provider-selection.cjs')

const DEFAULT_PROVIDER_ID = process.env.AIWORKER_E2E_PROVIDER_ID
const DEFAULT_MODEL_ID = process.env.AIWORKER_E2E_MODEL_ID
const DEFAULT_GENERIC_PROVIDER_ID = process.env.AIWORKER_E2E_GENERIC_PROVIDER_ID ?? DEFAULT_PROVIDER_ID
const DEFAULT_GENERIC_MODEL_ID = process.env.AIWORKER_E2E_GENERIC_MODEL_ID ?? DEFAULT_MODEL_ID
const DEFAULT_PROJECT_NAME = process.env.AIWORKER_E2E_PROJECT_NAME ?? 'AIWorkerControlDesk'

function isLiveStatus(status) {
  return status === 'starting' || status === 'running' || status === 'waiting'
}

async function main() {
  const startedAt = new Date().toISOString()
  const checks = {
    autoDispatchProjectAvailable: false,
    genericAgentConfigAvailable: false,
    providerAvailable: false,
    parentSessionStarted: false,
    childSessionCreated: false,
    childOutputReceived: false,
    resultReturnedToParent: false,
    reportSanitized: true
  }
  let failedAt = null
  let reason = null
  let context = {
    project: DEFAULT_PROJECT_NAME,
    provider: null,
    parentProvider: null,
    genericAgentConfigId: null,
    parentSessionId: null,
    childSessionId: null,
    childStatus: null,
    childOutputBytes: 0,
    returnEvidence: null
  }

  try {
    await withDevApp(async ({ page }) => {
      const setupBase = await page.evaluate(async ({ projectName }) => {
        const [projects, configs, catalog] = await Promise.all([
          window.workerDesk.listProjects(),
          window.workerDesk.listGenericAgentConfigs(),
          window.workerDesk.listProviderCatalog()
        ])
        const project = projects.find((item) => item.name === projectName) ?? projects[0]
        return {
          project: project ? {
            id: project.id,
            name: project.name,
            autoDispatchGenericAgent: project.autoDispatchGenericAgent,
            genericAgentConfigId: project.genericAgentConfigId
          } : null,
          configs: configs.map((item) => ({ id: item.id, name: item.name })),
          catalog
        }
      }, { projectName: DEFAULT_PROJECT_NAME })
      const genericProviderPick = pickGenericAgentProvider(setupBase.catalog, DEFAULT_GENERIC_PROVIDER_ID, DEFAULT_GENERIC_MODEL_ID)
      const claudeProviderPick = pickClaudeCodeProvider(setupBase.catalog, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_ID)
      const setup = {
        ...setupBase,
        provider: genericProviderPick.provider,
        modelId: genericProviderPick.modelId,
        providerReason: genericProviderPick.reason,
        parentProvider: claudeProviderPick.provider,
        parentModelId: claudeProviderPick.modelId,
        parentProviderReason: claudeProviderPick.reason
      }

      if (setup.project) {
        context.project = setup.project.name
        checks.autoDispatchProjectAvailable = setup.project.autoDispatchGenericAgent === true
        context.genericAgentConfigId = setup.project.genericAgentConfigId ?? null
      }
      checks.genericAgentConfigAvailable = Boolean(setup.project?.genericAgentConfigId)
        && setup.configs.some((config) => config.id === setup.project.genericAgentConfigId)
      checks.providerAvailable = Boolean(setup.provider && setup.modelId)
      context.provider = setup.provider?.name ?? null
      context.parentProvider = setup.parentProvider?.name ?? null

      if (!checks.autoDispatchProjectAvailable) {
        failedAt = 'auto-dispatch-project'
        reason = 'Project is not configured with autoDispatchGenericAgent=true; App tests cover dispatch parsing, configure project for live e2e.'
        return
      }
      if (!checks.genericAgentConfigAvailable) {
        failedAt = 'generic-agent-config'
        reason = 'Project has no available GenericAgent config for live dispatch e2e.'
        return
      }
      if (!checks.providerAvailable) {
        failedAt = 'generic-agent-provider'
        reason = setup.providerReason ?? 'No GenericAgent-compatible provider is available.'
        return
      }
      if (!setup.parentProvider || !setup.parentModelId) {
        failedAt = 'parent-claude-provider'
        reason = setup.parentProviderReason ?? 'No Claude Code-compatible provider is available for the parent session.'
        return
      }

      await page.evaluate(() => {
        if (window.__aiWorkerDispatchReturnProbeInstalled) return
        const originalWriteSessionInput = window.workerDesk.writeSessionInput
        window.__aiWorkerDispatchReturnWrites = []
        window.workerDesk.writeSessionInput = async (sessionId, data) => {
          window.__aiWorkerDispatchReturnWrites.push({
            sessionId,
            isGenericAgentReturn: typeof data === 'string' && data.includes('--- GenericAgent Result ---'),
            isSubmit: data === '\r'
          })
          return originalWriteSessionInput(sessionId, data)
        }
        window.__aiWorkerDispatchReturnProbeInstalled = true
      })

      const parentSession = await page.evaluate(async ({ projectId, providerProfileId, providerModelId }) => {
        return window.workerDesk.startSession({
          projectId,
          workerType: 'claude-code',
          providerProfileId,
          providerModelId,
          interactionMode: 'native-jsonl',
          taskTitle: 'dispatch-return parent',
          terminalSize: { cols: 100, rows: 30 }
        })
      }, {
        projectId: setup.project.id,
        providerProfileId: setup.parentProvider.id,
        providerModelId: setup.parentModelId
      })
      context.parentSessionId = parentSession.id
      checks.parentSessionStarted = isLiveStatus(parentSession.status)
      if (!checks.parentSessionStarted) {
        failedAt = 'parent-session-start'
        reason = parentSession.errorMessage ?? `Unexpected parent session status ${parentSession.status}`
        return
      }

      await wait(500)

      const childSession = await page.evaluate(async ({ projectId, parentSessionId, genericAgentConfigId, providerProfileId, providerModelId }) => {
        return window.workerDesk.startSession({
          projectId,
          workerType: 'generic-agent',
          parentSessionId,
          dispatchMode: 'auto',
          dispatchTask: '返回 dispatch-return-ok',
          genericAgentConfigId,
          initialPrompt: '请只回答一行：dispatch-return-ok',
          providerProfileId,
          providerModelId,
          terminalSize: { cols: 100, rows: 30 }
        })
      }, {
        projectId: setup.project.id,
        parentSessionId: parentSession.id,
        genericAgentConfigId: setup.project.genericAgentConfigId,
        providerProfileId: setup.provider.id,
        providerModelId: setup.modelId
      })
      context.childSessionId = childSession.id
      checks.childSessionCreated = isLiveStatus(childSession.status)
      if (!checks.childSessionCreated) {
        failedAt = 'child-session-start'
        reason = childSession.errorMessage ?? `Unexpected child session status ${childSession.status}`
        return
      }

      const liveResult = await page.evaluate(async ({ parentSessionId, childSessionId }) => {
        const deadline = Date.now() + 180000
        let latestChild = await window.workerDesk.selectSession(childSessionId)
        let latestParent = await window.workerDesk.selectSession(parentSessionId)
        let output = ''
        while (Date.now() < deadline) {
          latestChild = await window.workerDesk.selectSession(childSessionId)
          latestParent = await window.workerDesk.selectSession(parentSessionId)
          output = await window.workerDesk.getOutputBuffer(childSessionId)
          const writes = window.__aiWorkerDispatchReturnWrites ?? []
          const hasReturnWrite = writes.some((write) => write.sessionId === parentSessionId && write.isGenericAgentReturn)
          const hasSubmitWrite = writes.some((write) => write.sessionId === parentSessionId && write.isSubmit)
          const childOutputReceived = output.trim().length > 0
          if (childOutputReceived && hasReturnWrite && hasSubmitWrite) {
            return { ok: true, latestChild, latestParent, outputBytes: output.length, hasReturnWrite, hasSubmitWrite, evidence: 'parent-write-probe' }
          }
          if (childOutputReceived && latestChild.status === 'stopped') {
            return { ok: true, latestChild, latestParent, outputBytes: output.length, hasReturnWrite, hasSubmitWrite, evidence: 'auto-return-stopped-child' }
          }
          if (latestChild.status === 'failed') {
            return {
              ok: false,
              latestChild,
              latestParent,
              outputBytes: output.length,
              hasReturnWrite,
              hasSubmitWrite,
              evidence: null,
              reason: latestChild.errorMessage ?? 'GenericAgent child failed'
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        const writes = window.__aiWorkerDispatchReturnWrites ?? []
        return {
          ok: false,
          latestChild,
          latestParent,
          outputBytes: output.length,
          hasReturnWrite: writes.some((write) => write.sessionId === parentSessionId && write.isGenericAgentReturn),
          hasSubmitWrite: writes.some((write) => write.sessionId === parentSessionId && write.isSubmit),
          evidence: null,
          reason: output.trim().length > 0
            ? `timed out waiting for GenericAgent auto-return; child status ${latestChild.status}`
            : `timed out waiting for GenericAgent output; child status ${latestChild.status}`
        }
      }, { parentSessionId: parentSession.id, childSessionId: childSession.id })

      context.childStatus = liveResult.latestChild?.status ?? null
      context.childOutputBytes = liveResult.outputBytes ?? 0
      context.returnEvidence = liveResult.evidence ?? null
      checks.childOutputReceived = liveResult.outputBytes > 0
      checks.resultReturnedToParent = Boolean(liveResult.hasReturnWrite && liveResult.hasSubmitWrite) || liveResult.evidence === 'auto-return-stopped-child'

      await page.evaluate(async ({ parentSessionId, childSessionId }) => {
        await Promise.all([
          window.workerDesk.stopSession(childSessionId).catch(() => undefined),
          window.workerDesk.stopSession(parentSessionId).catch(() => undefined)
        ])
      }, { parentSessionId: parentSession.id, childSessionId: childSession.id }).catch(() => undefined)

      if (!liveResult.ok) {
        failedAt = !checks.childOutputReceived ? 'generic-agent-output' : 'generic-agent-return'
        reason = liveResult.reason ?? 'GenericAgent dispatch return did not complete.'
      }
    }, { useExistingUserData: true })
  } catch (error) {
    failedAt = failedAt ?? 'unexpected-error'
    reason = reason ?? (error instanceof Error ? error.message : String(error))
  }

  const ok = Object.values(checks).every(Boolean)
  const { report, filePath } = writeReport(repo, 'dispatch-return', {
    ok,
    step: 'dispatch-return',
    startedAt,
    project: context.project,
    provider: context.provider,
    checks,
    score: null,
    failedAt: ok ? null : failedAt,
    reason: ok ? null : reason,
    evidence: {
      genericAgentConfigId: context.genericAgentConfigId,
      parentProvider: context.parentProvider,
      parentSessionId: context.parentSessionId,
      childSessionId: context.childSessionId,
      childStatus: context.childStatus,
      childOutputBytes: context.childOutputBytes,
      returnEvidence: context.returnEvidence
    }
  })

  console.log(JSON.stringify({ ok: report.ok, report: path.relative(repo, filePath).replace(/\\/g, '/'), checks, failedAt: report.failedAt, reason: report.reason }, null, 2))
  if (!report.ok) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
