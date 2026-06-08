import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          main: resolve(rootDir, 'electron/main.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          preload: resolve(rootDir, 'electron/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src',
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(rootDir, 'src/index.html')
        }
      }
    }
  }
})
