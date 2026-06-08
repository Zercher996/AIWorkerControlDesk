import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { GenericAgentConfig, Project, SafeProviderCatalog } from '../types/workerDesk'
import { ProjectPanel } from './ProjectPanel'

const project: Project = { id: 'p1', name: 'Project One', path: '/tmp/p1', createdAt: 'now', lastUsedAt: 'now', autoDispatchGenericAgent: false }
const projectWithTool: Project = { ...project, genericAgentConfigId: 'ga-local' }
const genericAgentConfig: GenericAgentConfig = { id: 'ga-local', name: 'Local GenericAgent', home: 'E:/ga', pythonCommand: 'python', entryScript: 'agentmain.py', env: {} }
const providerCatalog: SafeProviderCatalog = {
  version: 2,
  providers: [
    {
      id: 'anthropic-official',
      name: 'Anthropic 官方',
      apiFormat: 'anthropic',
      protocol: 'anthropic',
      auth: { type: 'api-key', hasApiKey: true, apiKeyPreview: 'sk-***' },
      endpoint: { baseUrl: 'https://api.anthropic.com' },
      model: { id: 'claude-sonnet-4-6', apiFormat: 'anthropic', enabled: true },
      models: [
        { id: 'claude-sonnet-4-6', apiFormat: 'anthropic', enabled: true },
        { id: 'claude-opus-4-7', apiFormat: 'anthropic', enabled: true },
        { id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true }
      ],
      defaults: { modelId: 'claude-sonnet-4-6' },
      adapters: {
        claudeCode: {
          enabled: true,
          permissionMode: 'default',
          useSettingsEnv: true
        },
        genericAgent: {
          enabled: true,
          sessionType: 'native_claude'
        }
      }
    },
    {
      id: 'openai-provider',
      name: 'OpenAI Provider',
      apiFormat: 'openai_chat',
      protocol: 'openai-compatible',
      auth: { type: 'api-key', hasApiKey: true, apiKeyPreview: 'sk-***' },
      endpoint: { baseUrl: 'https://openrouter.ai/api/v1' },
      model: { id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true },
      models: [{ id: 'openai/gpt-4o', apiFormat: 'openai_chat', enabled: true }],
      defaults: { modelId: 'openai/gpt-4o' },
      adapters: {
        genericAgent: {
          enabled: true,
          sessionType: 'native_oai'
        }
      }
    }
  ]
}

function renderProjectPanel(overrides: Record<string, unknown> = {}) {
  const props: any = {
    projects: [project],
    genericAgentConfigs: [],
    providerCatalog: undefined,
    currentClaudeConfig: undefined,
    selectedProjectId: 'p1',
    selectedWorkerType: 'claude-code',
    selectedProviderProfileId: undefined,
    selectedProviderModelId: undefined,
    selectedClaudeLaunchMode: 'provider',
    isStartingSession: false,
    onSelectProject: () => undefined,
    onSelectWorkerType: () => undefined,
    onSelectProviderProfile: () => undefined,
    onSelectProviderModel: () => undefined,
    onSelectClaudeLaunchMode: () => undefined,
    onApplyCurrentClaudeConfig: async () => undefined,
    onToggleAutoDispatch: async () => undefined,
    onAddProject: () => undefined,
    onRemoveProject: async () => undefined,
    onStartSession: () => undefined,
    onSaveProviderCatalog: async () => undefined,
    onOpenProviderCatalog: () => undefined,
    ...overrides
  }
  render(<ProjectPanel {...props} />)
  return props
}

describe('ProjectPanel', () => {
  it('keeps title actions compact in the narrow project rail', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/project-panel.css'), 'utf8')

    expect(css).toMatch(/\.project-panel\s+\.project-panel-title-row\s+button\.project-panel-title-action\s*\{[\s\S]*?width:\s*auto;/)
  })

  it('asks for confirmation before removing the selected project from the desk list', () => {
    const onRemoveProject = vi.fn()
    renderProjectPanel({
      projects: [project, { ...project, id: 'p2', name: 'Project Two', path: '/tmp/p2' }],
      onRemoveProject
    })

    expect(screen.queryByText('仅从调度台移除，不删本地目录。')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '移除项目' }))
    expect(screen.getByText('仅从调度台移除，不删本地目录。')).toBeInTheDocument()
    expect(onRemoveProject).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '确认移除？' }))
    expect(onRemoveProject).toHaveBeenCalledWith('p1')
  })

  it('does not show the remove project action before a project is selected', () => {
    renderProjectPanel({ selectedProjectId: undefined })

    expect(screen.queryByRole('button', { name: '移除项目' })).not.toBeInTheDocument()
  })

  it('shows the V2 default chain without the old settings drawer', () => {
    renderProjectPanel({ providerCatalog, selectedProviderProfileId: 'anthropic-official', selectedProviderModelId: 'claude-sonnet-4-6' })

    expect(screen.getByRole('heading', { name: '项目' })).toBeInTheDocument()
    expect(screen.getByRole('listbox', { name: '选择模型连接' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '选择模型来源' })).not.toBeInTheDocument()
    expect(screen.getByText('来源：已保存连接')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '用当前 Claude 设置' })).toBeInTheDocument()
    expect(screen.getByLabelText('自动协助')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始工作' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '单独启动 Agent' })).toHaveClass('project-panel-agent-launch-action')
    expect(screen.getByLabelText('模型').closest('.provider-pick-details')).not.toBeNull()
    expect(screen.getByLabelText('自动协助').closest('.provider-pick-details')).not.toBeNull()
    expect(screen.queryByText(/更多设置/)).not.toBeInTheDocument()
    expect(screen.queryByText('Worker 模式')).not.toBeInTheDocument()
    expect(screen.queryByText('GenericAgent')).not.toBeInTheDocument()
    expect(screen.queryByText('GA_TASK')).not.toBeInTheDocument()
  })

  it('nests model details and auto assist under the selected provider card', () => {
    renderProjectPanel({ providerCatalog, selectedProviderProfileId: 'anthropic-official', selectedProviderModelId: 'claude-sonnet-4-6' })

    const selectedProvider = screen.getByRole('option', { name: /Anthropic 官方/ }).closest('.provider-pick-card')
    expect(selectedProvider).not.toBeNull()
    const details = selectedProvider!.querySelector('.provider-pick-details')
    expect(details).not.toBeNull()
    expect(within(details as HTMLElement).getByLabelText('模型')).toBeInTheDocument()
    expect(within(details as HTMLElement).getByLabelText('自动协助')).toBeInTheDocument()
  })

  it('shows the launch summary content in the unified start panel', () => {
    renderProjectPanel({ providerCatalog, selectedProviderProfileId: 'anthropic-official', selectedProviderModelId: 'claude-sonnet-4-6' })

    expect(screen.getByLabelText('启动摘要')).toHaveTextContent('Project One · Claude Code · claude-sonnet-4-6')
    expect(screen.queryByText(/左侧把关/)).not.toBeInTheDocument()
  })

  it('shows a launch gate with the real project, worker, model, and assist state', () => {
    renderProjectPanel({
      projects: [projectWithTool],
      genericAgentConfigs: [genericAgentConfig],
      providerCatalog,
      selectedProviderProfileId: 'anthropic-official',
      selectedProviderModelId: 'claude-sonnet-4-6'
    })

    const launchGate = screen.getByLabelText('启动检查')
    expect(within(launchGate).getByText('项目')).toBeInTheDocument()
    expect(within(launchGate).getByText('Project One')).toBeInTheDocument()
    expect(within(launchGate).getByText('Worker')).toBeInTheDocument()
    expect(within(launchGate).getByText('Claude Code')).toBeInTheDocument()
    expect(within(launchGate).getByText('模型')).toBeInTheDocument()
    expect(within(launchGate).getByText('Anthropic 官方 / claude-sonnet-4-6')).toBeInTheDocument()
    expect(within(launchGate).getByText('协助')).toBeInTheDocument()
    expect(within(launchGate).getByText('未开启')).toBeInTheDocument()
    expect(screen.queryByText(/健康分|评分|推荐指数/)).not.toBeInTheDocument()
  })

  it('shows why the launch gate cannot start before enabling the primary action', () => {
    renderProjectPanel({
      selectedProviderProfileId: undefined,
      selectedProviderModelId: undefined
    })

    const launchGate = screen.getByLabelText('启动检查')
    expect(within(launchGate).getByText('未选模型来源 / 未选模型')).toBeInTheDocument()
    expect(screen.getByText('先选择一个 AI 模型')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始工作' })).toBeDisabled()
  })

  it('places the task title input before the primary start action', () => {
    renderProjectPanel({ providerCatalog, selectedProviderProfileId: 'anthropic-official', selectedProviderModelId: 'claude-sonnet-4-6' })

    const taskTitleInput = screen.getByLabelText('任务名')
    const startButton = screen.getByRole('button', { name: '开始工作' })
    expect(taskTitleInput.compareDocumentPosition(startButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('filters provider options and model options by worker compatibility', () => {
    renderProjectPanel({ providerCatalog, selectedWorkerType: 'claude-code', selectedProviderProfileId: 'anthropic-official', selectedProviderModelId: 'claude-sonnet-4-6' })

    const providerList = screen.getByRole('listbox', { name: '选择模型连接' })
    expect(within(providerList).getByRole('option', { name: /Anthropic 官方/ })).toBeInTheDocument()
    expect(within(providerList).queryByRole('option', { name: /OpenAI Provider/ })).not.toBeInTheDocument()

    const modelSelect = screen.getByLabelText('模型') as HTMLSelectElement
    expect(modelSelect.closest('.provider-pick-details')).not.toBeNull()
    expect(within(modelSelect).getByRole('option', { name: 'claude-sonnet-4-6' })).toBeInTheDocument()
    expect(within(modelSelect).queryByRole('option', { name: 'openai/gpt-4o' })).not.toBeInTheDocument()
  })

  it('passes providerModelId when starting a session', () => {
    const onStart = vi.fn()
    renderProjectPanel({
      providerCatalog,
      selectedProviderProfileId: 'anthropic-official',
      selectedProviderModelId: 'claude-sonnet-4-6',
      onStartSession: onStart
    })

    fireEvent.click(screen.getByRole('button', { name: '开始工作' }))
    expect(onStart).toHaveBeenCalledWith('p1', 'claude-code', 'anthropic-official', 'claude-sonnet-4-6')
  })

  it('toggles auto assist with the selected helper tool', () => {
    const onToggleAutoDispatch = vi.fn()
    renderProjectPanel({
      projects: [projectWithTool],
      genericAgentConfigs: [genericAgentConfig],
      providerCatalog,
      selectedProviderProfileId: 'anthropic-official',
      selectedProviderModelId: 'claude-sonnet-4-6',
      onToggleAutoDispatch
    })

    fireEvent.change(screen.getByLabelText('自动协助'), { target: { value: 'on' } })
    expect(onToggleAutoDispatch).toHaveBeenCalledWith('p1', true, 'ga-local')
  })

  it('shows assist tool picker when auto assist is on without a tool', () => {
    const onToggleAutoDispatch = vi.fn()
    renderProjectPanel({
      projects: [{ ...project, autoDispatchGenericAgent: true }],
      genericAgentConfigs: [genericAgentConfig],
      providerCatalog,
      selectedProviderProfileId: 'anthropic-official',
      selectedProviderModelId: 'claude-sonnet-4-6',
      onToggleAutoDispatch
    })

    fireEvent.change(screen.getByLabelText('协助工具'), { target: { value: 'ga-local' } })
    expect(onToggleAutoDispatch).toHaveBeenCalledWith('p1', true, 'ga-local')
  })

  it('switches into the single tool path', () => {
    const onSelectWorkerType = vi.fn()
    renderProjectPanel({
      providerCatalog,
      selectedProviderProfileId: 'anthropic-official',
      selectedProviderModelId: 'claude-sonnet-4-6',
      onSelectWorkerType
    })

    fireEvent.click(screen.getByRole('button', { name: '单独启动 Agent' }))
    expect(onSelectWorkerType).toHaveBeenCalledWith('generic-agent')
  })

  it('starts the single tool path with selected provider model', () => {
    const onStart = vi.fn()
    renderProjectPanel({
      projects: [projectWithTool],
      providerCatalog,
      selectedWorkerType: 'generic-agent',
      selectedProviderProfileId: 'openai-provider',
      selectedProviderModelId: 'openai/gpt-4o',
      genericAgentConfigs: [genericAgentConfig],
      onStartSession: onStart
    })

    expect(screen.getByRole('button', { name: '开始执行' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
    expect(onStart).toHaveBeenCalledWith('p1', 'generic-agent', 'openai-provider', 'openai/gpt-4o')
  })

  it('shows GenericAgent native_oai models when the worker is the single tool path', () => {
    renderProjectPanel({
      projects: [projectWithTool],
      providerCatalog,
      selectedWorkerType: 'generic-agent',
      selectedProviderProfileId: 'openai-provider',
      selectedProviderModelId: 'openai/gpt-4o',
      genericAgentConfigs: [genericAgentConfig]
    })

    expect(screen.getByRole('listbox', { name: '选择模型连接' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始执行' })).toBeEnabled()
  })

  it('shows add-provider guidance when the provider catalog is empty', () => {
    renderProjectPanel({
      providerCatalog: { version: 2, providers: [] },
      selectedProviderProfileId: undefined,
      selectedProviderModelId: undefined
    })

    expect(screen.getByText('没有可用连接，去「管理模型」添加。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始工作' })).toBeDisabled()
  })

  it('explains when saved providers are incompatible with Claude Code', () => {
    renderProjectPanel({
      providerCatalog: { version: 2, providers: [providerCatalog.providers[1]] },
      selectedProviderProfileId: undefined,
      selectedProviderModelId: undefined
    })

    expect(screen.getByText('现有连接不兼容 Claude Code，去「管理模型」调整。')).toBeInTheDocument()
  })

  it('shows a connection compatibility warning for stale selected providers', () => {
    renderProjectPanel({
      providerCatalog,
      selectedProviderProfileId: 'openai-provider',
      selectedProviderModelId: 'openai/gpt-4o'
    })

    expect(screen.getByText('当前连接不兼容 Claude Code，请换一个连接或到「管理模型」调整兼容性')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始工作' })).toBeDisabled()
  })

  it('shows a model compatibility warning for stale selected models', () => {
    renderProjectPanel({
      providerCatalog,
      selectedProviderProfileId: 'anthropic-official',
      selectedProviderModelId: 'openai/gpt-4o'
    })

    expect(screen.getByText('当前模型不兼容 Claude Code，请换一个模型')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始工作' })).toBeDisabled()
  })
})
