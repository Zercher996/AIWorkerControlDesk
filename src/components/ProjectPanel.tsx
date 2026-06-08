import { useState } from 'react'
import type { CurrentClaudeConfigSummary, GenericAgentConfig, Project, ProviderCatalogPatch, SafeProviderCatalog, WorkerType } from '../types/workerDesk'
import { getCompatibleModels, getCompatibleProviders } from '../utils/providerCompatibility'
import { ProviderCatalogEditor } from './ProviderCatalogEditor'

type ProjectPanelProps = {
  projects: Project[]
  genericAgentConfigs: GenericAgentConfig[]
  providerCatalog?: SafeProviderCatalog
  currentClaudeConfig?: CurrentClaudeConfigSummary
  selectedProjectId?: string
  selectedWorkerType: WorkerType
  selectedProviderProfileId?: string
  selectedProviderModelId?: string
  selectedClaudeLaunchMode: 'provider' | 'current-claude-config'
  isStartingSession: boolean
  onSelectProject(projectId: string): void
  onSelectWorkerType(workerType: WorkerType): void
  onSelectProviderProfile(providerProfileId: string | undefined): void
  onSelectProviderModel(providerModelId: string | undefined): void
  onSelectClaudeLaunchMode(mode: 'provider' | 'current-claude-config'): void
  onApplyCurrentClaudeConfig(): Promise<boolean | void> | boolean | void
  onToggleAutoDispatch(projectId: string, enabled: boolean, genericAgentConfigId?: string): Promise<void>
  onAddProject(): void
  onRemoveProject(projectId: string): Promise<void> | void
  onStartSession(projectId: string, workerType: WorkerType, providerProfileId?: string, providerModelId?: string, taskTitle?: string): Promise<boolean | void> | boolean | void
  onSaveProviderCatalog(patch: ProviderCatalogPatch): Promise<void> | void
  onOpenProviderCatalog(): void
}

export function ProjectPanel(props: ProjectPanelProps) {
  const [isEditingProviderCatalog, setIsEditingProviderCatalog] = useState(false)
  const [showAssistToolPicker, setShowAssistToolPicker] = useState(false)
  const [confirmRemoveProjectId, setConfirmRemoveProjectId] = useState<string | null>(null)
  const [taskTitle, setTaskTitle] = useState('')
  const selectedProject = props.projects.find((project) => project.id === props.selectedProjectId)
  const isSingleTool = props.selectedWorkerType === 'generic-agent'
  const workerDisplayName = isSingleTool ? 'GenericAgent' : 'Claude Code'
  const useCurrentClaudeConfig = !isSingleTool && props.selectedClaudeLaunchMode === 'current-claude-config'
  const compatibleProviders = getCompatibleProviders(props.providerCatalog, props.selectedWorkerType)
  const providerCount = props.providerCatalog?.providers.length ?? 0
  const selectedProvider = compatibleProviders.find((provider) => provider.id === props.selectedProviderProfileId)
  const compatibleModels = selectedProvider ? getCompatibleModels(selectedProvider, props.selectedWorkerType) : []
  const selectedGenericAgentConfig = props.genericAgentConfigs.find((config) => config.id === selectedProject?.genericAgentConfigId)
  const selectedProviderName = useCurrentClaudeConfig ? '当前 Claude' : selectedProvider?.name ?? '未选模型来源'
  const selectedModelLabel = useCurrentClaudeConfig
    ? props.currentClaudeConfig?.model ?? '当前 Claude'
    : compatibleModels.find((model) => model.id === props.selectedProviderModelId)?.displayName ?? props.selectedProviderModelId ?? '未选模型'
  const launchSummary = `${selectedProject?.name ?? '未选项目'} · ${workerDisplayName} · ${selectedModelLabel}`
  const launchGateModel = useCurrentClaudeConfig ? selectedModelLabel : `${selectedProviderName} / ${selectedModelLabel}`
  const launchGateAssist = isSingleTool
    ? selectedGenericAgentConfig?.name ?? '未选 Agent'
    : selectedProject?.autoDispatchGenericAgent
      ? selectedGenericAgentConfig?.name ?? '待选择协助 Agent'
      : '未开启'
  const startLabel = isSingleTool ? '开始执行' : '开始工作'

  const startIssues: string[] = []
  if (!props.selectedProjectId) startIssues.push('先选择一个代码项目')
  if (!useCurrentClaudeConfig && !props.selectedProviderProfileId) startIssues.push('先选择一个 AI 模型')
  if (!useCurrentClaudeConfig && props.selectedProviderProfileId && !selectedProvider) startIssues.push(`当前连接不兼容 ${workerDisplayName}，请换一个连接或到「管理模型」调整兼容性`)
  if (!useCurrentClaudeConfig && !props.selectedProviderModelId) startIssues.push('先选择一个 AI 模型')
  if (!useCurrentClaudeConfig && props.selectedProviderModelId && !compatibleModels.some((model) => model.id === props.selectedProviderModelId)) startIssues.push(`当前模型不兼容 ${workerDisplayName}，请换一个模型`)
  if (useCurrentClaudeConfig && !props.currentClaudeConfig) startIssues.push('先读取当前 Claude 的设置')
  if (isSingleTool && !selectedProject?.genericAgentConfigId) startIssues.push('先选择要启动的 Agent')
  const canStart = startIssues.length === 0 && !props.isStartingSession
  const startWarning = startIssues[0]
  const showAutoAssistToolPicker = !isSingleTool && selectedProject?.autoDispatchGenericAgent && (!selectedProject.genericAgentConfigId || showAssistToolPicker)
  const autoAssistControls = !isSingleTool ? (
    <div className="provider-pick-nested-section">
      <label className="provider-pick-nested-field">
        <span>自动协助</span>
        <select
          aria-label="自动协助"
          value={selectedProject?.autoDispatchGenericAgent ? 'on' : 'off'}
          disabled={!selectedProject}
          onChange={(event) => {
            if (!selectedProject) return
            const enabled = event.target.value === 'on'
            setShowAssistToolPicker(false)
            void props.onToggleAutoDispatch(selectedProject.id, enabled, selectedProject.genericAgentConfigId)
          }}
        >
          <option value="off">协助关闭</option>
          <option value="on">协助开启</option>
        </select>
      </label>
      {selectedProject?.autoDispatchGenericAgent && selectedProject.genericAgentConfigId && !showAutoAssistToolPicker ? (
        <p className="project-panel-field-hint">
          已开启{selectedGenericAgentConfig ? `：${selectedGenericAgentConfig.name}` : ''}
          <button type="button" className="project-panel-inline-link" onClick={() => setShowAssistToolPicker(true)}>更换</button>
        </p>
      ) : null}
      {showAutoAssistToolPicker ? (
        <label className="provider-pick-nested-field">
          <span>选择协助 Agent</span>
          <select
            aria-label="协助工具"
            value={selectedProject?.genericAgentConfigId ?? ''}
            disabled={!selectedProject}
            onChange={(event) => {
              if (!selectedProject) return
              const configId = event.target.value || undefined
              setShowAssistToolPicker(false)
              void props.onToggleAutoDispatch(selectedProject.id, selectedProject.autoDispatchGenericAgent, configId)
            }}
          >
            <option value="">选择协助工具</option>
            {props.genericAgentConfigs.map((config) => (
              <option key={config.id} value={config.id}>{config.name}</option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  ) : null

  return (
    <section className="panel project-panel">
      <div className="project-panel-scroll">
        <section className="project-panel-flow-section">
          <div className="project-panel-title-row">
            <h2 className="project-panel-section-title">项目</h2>
            <button type="button" className="project-panel-secondary-action project-panel-title-action" onClick={() => props.onAddProject()}>+ 添加项目</button>
          </div>
          <select
            aria-label="Project"
            value={props.selectedProjectId ?? ''}
            onChange={(event) => {
              setConfirmRemoveProjectId(null)
              props.onSelectProject(event.target.value)
            }}
          >
            <option value="" disabled>选择项目</option>
            {props.projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          {selectedProject ? (
            <div className="project-panel-remove-row">
              {confirmRemoveProjectId === selectedProject.id ? (
                <>
                  <span>仅从调度台移除，不删本地目录。</span>
                  <button
                    type="button"
                    className="project-panel-inline-danger"
                    onClick={() => {
                      setConfirmRemoveProjectId(null)
                      void props.onRemoveProject(selectedProject.id)
                    }}
                  >
                    确认移除？
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="project-panel-inline-link"
                  onClick={() => setConfirmRemoveProjectId(selectedProject.id)}
                >
                  移除项目
                </button>
              )}
            </div>
          ) : null}
        </section>

        <select
          aria-label="Worker"
          className="sr-only-control"
          value={props.selectedWorkerType}
          onChange={(event) => props.onSelectWorkerType(event.target.value as WorkerType)}
        >
          <option value="claude-code">claude-code</option>
          <option value="generic-agent">generic-agent</option>
        </select>

        {isSingleTool ? (
          <section className="project-panel-flow-section">
            <h2 className="project-panel-section-title">Agent</h2>
            <select
              aria-label="选择 Agent"
              value={selectedProject?.genericAgentConfigId ?? ''}
              disabled={!selectedProject}
              onChange={(event) => {
                if (!selectedProject) return
                const configId = event.target.value || undefined
                void props.onToggleAutoDispatch(
                  selectedProject.id,
                  selectedProject.autoDispatchGenericAgent,
                  configId
                )
              }}
            >
              <option value="">选择 Agent</option>
              {props.genericAgentConfigs.map((config) => (
                <option key={config.id} value={config.id}>{config.name}</option>
              ))}
            </select>
            <button type="button" className="project-panel-secondary-action" onClick={() => props.onSelectWorkerType('claude-code')}>返回普通工作</button>
          </section>
        ) : null}

        <section className="project-panel-flow-section">
          <div className="project-panel-title-row">
            <h2 className="project-panel-section-title">模型</h2>
            <button type="button" className="project-panel-secondary-action project-panel-title-action" onClick={() => { props.onOpenProviderCatalog(); setIsEditingProviderCatalog(true) }}>管理模型</button>
          </div>
          {!isSingleTool ? (
            <div className="project-panel-source-switch" aria-label="模型来源">
              <span className="project-panel-source-label">
                来源：{useCurrentClaudeConfig ? '当前 Claude 设置' : '已保存连接'}
              </span>
              {useCurrentClaudeConfig ? (
                <button
                  type="button"
                  className="project-panel-inline-link project-panel-source-action"
                  onClick={() => props.onSelectClaudeLaunchMode('provider')}
                >
                  改用已保存连接
                </button>
              ) : (
                <button
                  type="button"
                  className="project-panel-inline-link project-panel-source-action"
                  onClick={async () => {
                    const result = await props.onApplyCurrentClaudeConfig()
                    if (result === false) return
                    props.onSelectClaudeLaunchMode('current-claude-config')
                  }}
                >
                  用当前 Claude 设置
                </button>
              )}
            </div>
          ) : null}
          {useCurrentClaudeConfig ? (
            <p className="project-panel-field-hint">
              {props.currentClaudeConfig
                ? `${props.currentClaudeConfig.model ?? '当前 Claude'} · ${props.currentClaudeConfig.baseUrl}`
                : '还没读取当前 Claude 设置'}
            </p>
          ) : compatibleProviders.length === 0 ? (
            <p className="project-panel-field-hint">
              {providerCount === 0
                ? '没有可用连接，去「管理模型」添加。'
                : `现有连接不兼容 ${workerDisplayName}，去「管理模型」调整。`}
            </p>
          ) : (
            <>
              <div className="provider-pick-list" role="listbox" aria-label="选择模型连接">
                {compatibleProviders.map((provider) => {
                  const isSelected = provider.id === props.selectedProviderProfileId
                  const models = getCompatibleModels(provider, props.selectedWorkerType)
                  const defaultModel = models.find((m) => m.id === provider.defaults?.modelId) ?? models[0]
                  const rowModel = isSelected
                    ? models.find((m) => m.id === props.selectedProviderModelId) ?? defaultModel
                    : defaultModel
                  return (
                    <div key={provider.id} className={`provider-pick-card${isSelected ? ' selected' : ''}`}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className="provider-pick-item"
                        onClick={() => {
                          props.onSelectClaudeLaunchMode('provider')
                          props.onSelectProviderProfile(provider.id)
                          const targetModel = models.find((m) => m.id === props.selectedProviderModelId) ?? defaultModel
                          if (targetModel) props.onSelectProviderModel(targetModel.id)
                        }}
                      >
                        <span className="provider-pick-name">{provider.name}</span>
                        <span className="provider-pick-model">{rowModel?.displayName || rowModel?.id || '未配置模型'} · {models.length} 个可用模型</span>
                      </button>
                      {isSelected ? (
                        <div className="provider-pick-details">
                          {models.length > 1 ? (
                            <label className="provider-pick-nested-field">
                              <span>模型</span>
                              <select
                                aria-label="模型"
                                value={props.selectedProviderModelId ?? ''}
                                onChange={(event) => {
                                  props.onSelectClaudeLaunchMode('provider')
                                  props.onSelectProviderModel(event.target.value || undefined)
                                }}
                              >
                                {models.map((model) => (
                                  <option key={model.id} value={model.id}>{model.displayName || model.id}</option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                          {autoAssistControls}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </>
          )}
          {isEditingProviderCatalog && props.providerCatalog ? (
            <ProviderCatalogEditor
              catalog={props.providerCatalog}
              onSave={async (patch) => {
                await props.onSaveProviderCatalog(patch)
                setIsEditingProviderCatalog(false)
              }}
              onCancel={() => setIsEditingProviderCatalog(false)}
            />
          ) : null}
        </section>

        {!isSingleTool ? (
          <section className="project-panel-flow-section project-panel-secondary-launch">
            <button type="button" className="project-panel-agent-launch-action" onClick={() => props.onSelectWorkerType('generic-agent')}>单独启动 Agent</button>
          </section>
        ) : null}
      </div>

      <div className="project-panel-start">
        <div className="project-panel-start-card">
          <div className="project-launch-summary" aria-label="启动摘要" role="group">
            <strong>{launchSummary}</strong>
          </div>
          <div className="project-launch-gate" aria-label="启动检查" role="group">
            <dl>
              <div>
                <dt>项目</dt>
                <dd>{selectedProject?.name ?? '未选项目'}</dd>
              </div>
              <div>
                <dt>Worker</dt>
                <dd>{workerDisplayName}</dd>
              </div>
              <div>
                <dt>模型</dt>
                <dd>{launchGateModel}</dd>
              </div>
              <div>
                <dt>协助</dt>
                <dd>{launchGateAssist}</dd>
              </div>
            </dl>
          </div>
          {startWarning ? <p className="project-panel-start-warning">{startWarning}</p> : null}
          <label className="project-panel-task-title">
            <span>任务名（可选）</span>
            <input
              aria-label="任务名"
              maxLength={60}
              placeholder="例如：修复中栏状态"
              value={taskTitle}
              onChange={(event) => setTaskTitle(event.target.value)}
            />
          </label>
          <button
            className="project-panel-start-button"
            disabled={!canStart}
            onClick={async () => {
              const trimmedTaskTitle = taskTitle.trim()
              const result = trimmedTaskTitle
                ? await props.onStartSession(
                  props.selectedProjectId!,
                  props.selectedWorkerType,
                  props.selectedProviderProfileId,
                  props.selectedProviderModelId,
                  trimmedTaskTitle
                )
                : await props.onStartSession(
                  props.selectedProjectId!,
                  props.selectedWorkerType,
                  props.selectedProviderProfileId,
                  props.selectedProviderModelId
                )
              if (result !== false) setTaskTitle('')
            }}
          >
            {props.isStartingSession ? '正在启动…' : startLabel}
          </button>
        </div>
      </div>
    </section>
  )
}
