const { _electron: electron } = require('playwright')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { repo, wait, waitForExit, writeReport } = require('./_harness.cjs')

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
    buildOutputPresent: false,
    appStarted: false,
    rendererLoaded: false,
    workerDeskAvailable: false,
    projectAddedViaApi: false,
    providerEditorOpened: false,
    missingKeyGuidanceVisible: false,
    missingBaseUrlGuidanceVisible: false,
    baseUrlFieldAutoRevealed: false,
    incompatibleProviderGuidanceVisible: false,
    reportSanitized: true
  }
  let failedAt = null
  let reason = null
  const evidence = {
    mode: 'production-build-ui-click-through',
    note: 'This script performs an agent-driven UI click-through on the production build output. It does not replace a human acceptance pass.'
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
    const testUserDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aiworker-rc-click-'))
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

      const project = await page.evaluate(async ({ projectPath }) => window.workerDesk.addProject(projectPath), { projectPath: repo })
      checks.projectAddedViaApi = Boolean(project?.id)
      evidence.projectName = project?.name ?? null

      await page.getByRole('button', { name: '管理模型' }).click()
      await page.getByRole('dialog', { name: '管理模型' }).waitFor({ timeout: 10000 })
      checks.providerEditorOpened = true

      await page.getByRole('button', { name: /\+ 新增/ }).click()
      await page.getByLabel('连接名称').fill('Click Through Provider')
      await page.getByLabel('Model ID').fill('example-model')
      await page.getByLabel('Base URL').fill('https://example-provider.invalid')
      await page.getByRole('button', { name: '保存' }).click()
      await page.getByRole('alert').waitFor({ timeout: 10000 })
      const missingKeyText = await page.getByRole('alert').textContent()
      checks.missingKeyGuidanceVisible = Boolean(missingKeyText?.includes('新连接需要填写 API Key'))

      await page.getByRole('textbox', { name: 'API Key' }).fill('test-key-value')
      await page.getByLabel('Base URL').fill('')
      await page.getByRole('button', { name: '保存' }).click()
      await page.getByRole('alert').waitFor({ timeout: 10000 })
      const missingBaseUrlText = await page.getByRole('alert').textContent()
      checks.missingBaseUrlGuidanceVisible = Boolean(missingBaseUrlText?.includes('Base URL 不能为空'))
      checks.baseUrlFieldAutoRevealed = await page.getByLabel('Base URL').isVisible()

      await page.getByRole('button', { name: '关闭' }).click()

      await page.evaluate(async () => {
        await window.workerDesk.saveProviderCatalogPatch({
          version: 2,
          providers: [{
            id: 'rc-click-openai-only',
            name: 'OpenAI Only Click Through',
            apiFormat: 'openai_chat',
            protocol: 'openai-compatible',
            auth: { type: 'api-key', apiKey: 'test-key-value' },
            endpoint: { baseUrl: 'https://example-provider.invalid' },
            model: { id: 'example-openai-model', apiFormat: 'openai_chat', enabled: true },
            models: [{ id: 'example-openai-model', apiFormat: 'openai_chat', enabled: true }],
            defaults: { modelId: 'example-openai-model' },
            adapters: {
              claudeCode: { enabled: false, permissionMode: 'default', useSettingsEnv: true },
              genericAgent: { enabled: true, sessionType: 'native_oai' }
            }
          }]
        })
      })
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() => Boolean(window.workerDesk), null, { timeout: 30000 })
      await page.getByText('现有连接不兼容 Claude Code，去「管理模型」调整。').waitFor({ timeout: 10000 })
      checks.incompatibleProviderGuidanceVisible = true

      evidence.ui = {
        missingKeyGuidance: 'visible',
        missingBaseUrlGuidance: 'visible',
        incompatibleProviderGuidance: 'visible'
      }

      if (pageErrors.length > 0) {
        failedAt = failedAt ?? 'renderer'
        reason = reason ?? `Renderer page errors: ${pageErrors.join('; ')}`
      }
    } catch (error) {
      failedAt = failedAt ?? 'rc-click-through'
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
  const { report, filePath } = writeReport(repo, 'rc-click-through', {
    ok,
    step: 'rc-click-through',
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
