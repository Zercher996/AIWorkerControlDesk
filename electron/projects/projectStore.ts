import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { Project } from '../../src/types/workerDesk'
import { readJsonFile, writeJsonFile } from '../storage/jsonStore'

export type ProjectStore = {
  listProjects(): Promise<Project[]>
  addProject(projectPath: string): Promise<Project>
  updateProject(projectId: string, patch: Pick<Project, 'autoDispatchGenericAgent' | 'genericAgentConfigId'>): Promise<Project>
  removeProject(projectId: string): Promise<Project | undefined>
}

function normalizeProject(project: Project): Project {
  return {
    ...project,
    autoDispatchGenericAgent: project.autoDispatchGenericAgent ?? false
  }
}

export function createProjectStore(filePath: string): ProjectStore {
  return {
    async listProjects() {
      const projects = await readJsonFile<Project[]>(filePath, [])
      return projects.map(normalizeProject)
    },
    async addProject(projectPath: string) {
      const resolvedPath = resolve(projectPath)
      const stats = await stat(resolvedPath).catch(() => null)
      if (!stats?.isDirectory()) {
        throw new Error('Project path does not exist')
      }

      const projects = (await readJsonFile<Project[]>(filePath, [])).map(normalizeProject)
      const existing = projects.find((project) => project.path === resolvedPath)
      if (existing) {
        return existing
      }

      const now = new Date().toISOString()
      const project: Project = {
        id: randomUUID(),
        name: basename(resolvedPath),
        path: resolvedPath,
        createdAt: now,
        lastUsedAt: now,
        autoDispatchGenericAgent: false
      }
      await writeJsonFile(filePath, [...projects, project])
      return project
    },
    async updateProject(projectId, patch) {
      const projects = (await readJsonFile<Project[]>(filePath, [])).map(normalizeProject)
      const index = projects.findIndex((project) => project.id === projectId)
      if (index === -1) {
        throw new Error('Project not found')
      }

      const updatedProject: Project = {
        ...projects[index],
        autoDispatchGenericAgent: patch.autoDispatchGenericAgent,
        genericAgentConfigId: patch.genericAgentConfigId
      }
      const nextProjects = [...projects]
      nextProjects[index] = updatedProject
      await writeJsonFile(filePath, nextProjects)
      return updatedProject
    },
    async removeProject(projectId) {
      const projects = (await readJsonFile<Project[]>(filePath, [])).map(normalizeProject)
      const index = projects.findIndex((project) => project.id === projectId)
      if (index === -1) {
        throw new Error('Project not found')
      }

      const nextProjects = projects.filter((project) => project.id !== projectId)
      await writeJsonFile(filePath, nextProjects)
      return nextProjects[index] ?? nextProjects[index - 1]
    }
  }
}
