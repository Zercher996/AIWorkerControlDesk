import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return fallback
    }
    throw error
  }
}

export async function writeJsonFile<T>(filePath: string, value: T): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

export async function writeJsonFileAtomic<T>(filePath: string, value: T): Promise<void> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true })
  const tempPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  await rename(tempPath, filePath)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
