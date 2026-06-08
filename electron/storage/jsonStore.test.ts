import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readJsonFile, writeJsonFile, writeJsonFileAtomic } from './jsonStore'

describe('jsonStore', () => {
  it('returns fallback when file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-json-'))
    try {
      await expect(readJsonFile(join(dir, 'missing.json'), { items: [] })).resolves.toEqual({ items: [] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes pretty JSON and reads it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-json-'))
    const filePath = join(dir, 'nested', 'data.json')
    try {
      await writeJsonFile(filePath, { items: ['a'] })
      await expect(readJsonFile(filePath, { items: [] })).resolves.toEqual({ items: ['a'] })
      await expect(readFile(filePath, 'utf-8')).resolves.toContain('\n  "items"')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('atomically writes JSON and replaces the previous file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-json-'))
    const filePath = join(dir, 'nested', 'meta.json')
    try {
      await writeJsonFileAtomic(filePath, { status: 'running' })
      await expect(readJsonFile(filePath, { status: 'missing' })).resolves.toEqual({ status: 'running' })

      await writeJsonFileAtomic(filePath, { status: 'exited' })
      await expect(readJsonFile(filePath, { status: 'missing' })).resolves.toEqual({ status: 'exited' })
      await expect(readdir(join(dir, 'nested'))).resolves.toEqual(['meta.json'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
