const { _electron: electron } = require('playwright')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawnSync } = require('child_process')
const {
  assert,
  assertCurrentShell,
  assertScreenshotNotBlank,
  assertVisibleShell
} = require('./ui-smoke-assertions.cjs')

const repo = process.cwd()
const darkScreenshotPath = path.join(repo, 'playwright-stage3-smoke-dark.png')
const lightScreenshotPath = path.join(repo, 'playwright-stage3-smoke-light.png')

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    console.warn(`Could not remove temporary smoke userData directory: ${dir}: ${error.message}`)
  }
}

async function main() {
  const build = spawnSync('npm run build', { cwd: repo, shell: true, encoding: 'utf-8' })
  if (build.status !== 0) {
    console.error(build.stdout)
    console.error(build.stderr)
    throw new Error('npm run build failed')
  }

  const testUserDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aiworker-build-smoke-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      ELECTRON_DISABLE_GPU: '1',
      AIWORKER_TEST_USER_DATA_PATH: testUserDataPath
    }
  })

  try {
    const page = await app.firstWindow()
    const pageErrors = []
    page.on('console', (msg) => console.log(`[renderer:${msg.type()}] ${msg.text()}`))
    page.on('pageerror', (err) => {
      pageErrors.push(err.message)
      console.log(`[renderer:pageerror] ${err.message}`)
    })

    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(1500)
    await assertCurrentShell(page)

    assert(await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'Theme should default to dark')
    await assertVisibleShell(page, 'dark')
    await assertScreenshotNotBlank(page, darkScreenshotPath, 'Dark theme', { checkWindowControls: true })

    await page.getByRole('button', { name: '切换到浅色模式', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    await assertCurrentShell(page)
    await assertVisibleShell(page, 'light')
    await assertScreenshotNotBlank(page, lightScreenshotPath, 'Light theme', { checkWindowControls: true })

    assert(pageErrors.length === 0, `Renderer page errors: ${pageErrors.join('; ')}`)
  } finally {
    await app.close()
    removeTempDir(testUserDataPath)
  }

  console.log(JSON.stringify({
    ok: true,
    mode: 'build',
    screenshots: {
      dark: darkScreenshotPath,
      light: lightScreenshotPath
    },
    checked: [
      'Electron app window rendered from production build',
      'Current three-column shell labels are visible',
      'Top bar avoids duplicated panel state',
      'Launch gate is visible',
      'Right rail tabs are visible',
      'Forbidden fake scoring / reviewer copy is absent',
      'Theme tokens resolve in dark and light modes',
      'Shell and three work areas have visible computed layout',
      'Dark screenshot is not visually blank',
      'Light screenshot is not visually blank after theme switch'
    ]
  }, null, 2))
}

main().catch(async (error) => {
  console.error(error)
  process.exit(1)
})
