import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default tseslint.config(
  { ignores: ['out', 'dist', 'node_modules', 'scripts', 'references', '.claude/**', '.worktrees/**', '.playwright-mcp/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.node
      },
      parserOptions: {
        tsconfigRootDir: __dirname
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
)
