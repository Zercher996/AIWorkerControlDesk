import { rebuild } from '@electron/rebuild'
import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

async function main() {
  if (platform() === 'win32') {
    // Workaround for NoDefaultCurrentDirectoryInExePath=1 breaking cmd batch file resolution
    const env = { ...process.env }
    env['PATH'] = '.' + (env['PATH'] ? ';' + env['PATH'] : '')
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [join(projectRoot, 'node_modules', '@electron', 'rebuild', 'lib', 'main.js'), '-f', '-w', 'node-pty'],
        { cwd: projectRoot, env, stdio: 'inherit' }
      )
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`electron-rebuild exited with code ${code}`)))
      child.on('error', reject)
    })
  } else {
    await rebuild({ projectRoot, buildFromSource: true })
  }
}

main().catch((err) => {
  console.error('node-pty rebuild failed:', err.message)
  process.exit(1)
})