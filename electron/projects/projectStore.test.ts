import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProjectStore } from './projectStore'

describe('projectStore', () => {
  it('adds a directory project with autoDispatchGenericAgent disabled by default and persists it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-projects-'))
    const projectDir = await mkdtemp(join(dir, 'workspace-'))
    const filePath = join(dir, 'projects.json')
    try {
      const store = createProjectStore(filePath)
      const project = await store.addProject(projectDir)

      expect(project.name).toBe(basename(projectDir))
      expect(project.path).toBe(projectDir)
      expect(project.autoDispatchGenericAgent).toBe(false)
      await expect(createProjectStore(filePath).listProjects()).resolves.toEqual([project])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('normalizes existing projects with autoDispatchGenericAgent disabled by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-projects-'))
    const filePath = join(dir, 'projects.json')
    try {
      await writeFile(filePath, JSON.stringify([
        {
          id: 'project-1',
          name: 'Legacy Project',
          path: dir,
          createdAt: '2026-05-12T00:00:00.000Z',
          lastUsedAt: '2026-05-12T00:00:00.000Z'
        }
      ]))

      await expect(createProjectStore(filePath).listProjects()).resolves.toEqual([
        {
          id: 'project-1',
          name: 'Legacy Project',
          path: dir,
          createdAt: '2026-05-12T00:00:00.000Z',
          lastUsedAt: '2026-05-12T00:00:00.000Z',
          autoDispatchGenericAgent: false
        }
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('updates autoDispatchGenericAgent for an existing project and persists it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-projects-'))
    const projectDir = await mkdtemp(join(dir, 'workspace-'))
    const filePath = join(dir, 'projects.json')
    try {
      const store = createProjectStore(filePath)
      const project = await store.addProject(projectDir)

      const updatedProject = await store.updateProject(project.id, {
        autoDispatchGenericAgent: true
      })

      expect(updatedProject).toEqual({
        ...project,
        autoDispatchGenericAgent: true
      })
      await expect(createProjectStore(filePath).listProjects()).resolves.toEqual([updatedProject])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects updating a missing project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-projects-'))
    try {
      const store = createProjectStore(join(dir, 'projects.json'))

      await expect(
        store.updateProject('missing-project', { autoDispatchGenericAgent: true })
      ).rejects.toThrow('Project not found')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('removes a project from the desk list without deleting its directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-projects-'))
    const firstProjectDir = await mkdtemp(join(dir, 'workspace-a-'))
    const secondProjectDir = await mkdtemp(join(dir, 'workspace-b-'))
    const filePath = join(dir, 'projects.json')
    try {
      const store = createProjectStore(filePath)
      const firstProject = await store.addProject(firstProjectDir)
      const secondProject = await store.addProject(secondProjectDir)

      await expect(store.removeProject(firstProject.id)).resolves.toEqual(secondProject)

      await expect(createProjectStore(filePath).listProjects()).resolves.toEqual([secondProject])
      await expect(stat(firstProjectDir)).resolves.toMatchObject({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined after removing the last project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-projects-'))
    const projectDir = await mkdtemp(join(dir, 'workspace-'))
    const filePath = join(dir, 'projects.json')
    try {
      const store = createProjectStore(filePath)
      const project = await store.addProject(projectDir)

      await expect(store.removeProject(project.id)).resolves.toBeUndefined()
      await expect(createProjectStore(filePath).listProjects()).resolves.toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects removing a missing project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-projects-'))
    try {
      const store = createProjectStore(join(dir, 'projects.json'))

      await expect(store.removeProject('missing-project')).rejects.toThrow('Project not found')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects missing directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiw-projects-'))
    try {
      const store = createProjectStore(join(dir, 'projects.json'))
      await expect(store.addProject(join(dir, 'missing'))).rejects.toThrow('Project path does not exist')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
