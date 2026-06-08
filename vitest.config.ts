import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['electron/**/*.test.ts'],
          environment: 'node'
        }
      },
      {
        extends: true,
        test: {
          name: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'jsdom'
        }
      }
    ],
    coverage: {
      reporter: ['text']
    }
  }
})
