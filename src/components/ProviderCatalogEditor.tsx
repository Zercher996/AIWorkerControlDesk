import { useEffect, useRef, useState } from 'react'
import type { CcswitchProviderPreview, PermissionMode, GenericAgentSessionType, SafeProviderCatalog, SafeProviderProfile, ProviderCatalogPatch, ProviderProtocol, ProviderApiFormat, ProviderModel } from '../types/workerDesk'

type ProviderCatalogEditorProps = {
  catalog: SafeProviderCatalog
  onSave(catalog: ProviderCatalogPatch): Promise<void> | void
  onCancel(): void
}

const apiFormats: ProviderApiFormat[] = ['anthropic', 'openai_chat', 'openai_responses', 'gemini_native']
const permissionModes: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk']
const sessionTypes: GenericAgentSessionType[] = ['native_claude', 'native_oai']
const apiKeyEnvs = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const
const apiModes = ['chat_completions', 'responses'] as const
const thinkingTypes = ['adaptive', 'enabled', 'disabled'] as const
const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const

function apiFormatFromProtocol(protocol: ProviderProtocol | undefined): ProviderApiFormat {
  return protocol === 'openai-compatible' ? 'openai_chat' : 'anthropic'
}

function primaryModel(provider: SafeProviderProfile): ProviderModel {
  return provider.model ?? provider.models[0] ?? { id: '', apiFormat: provider.apiFormat, enabled: true }
}

function normalizeModelForProvider(provider: SafeProviderProfile, model: ProviderModel = primaryModel(provider)): ProviderModel {
  const apiFormat = model.apiFormat ?? provider.apiFormat ?? apiFormatFromProtocol(provider.protocol)
  return {
    ...model,
    apiFormat,
    enabled: model.enabled ?? true
  }
}

function normalizeModels(provider: SafeProviderProfile): ProviderModel[] {
  const models = Array.isArray(provider.models) && provider.models.length > 0 ? provider.models : [primaryModel(provider)]
  return models.map((model) => normalizeModelForProvider(provider, model))
}

function defaultModelId(provider: SafeProviderProfile, models = normalizeModels(provider)): string {
  return provider.defaults?.modelId && models.some((model) => model.id === provider.defaults?.modelId)
    ? provider.defaults.modelId
    : models[0]?.id ?? ''
}

function modelLabel(model: ProviderModel | undefined): string {
  if (!model) return '未选择模型'
  return model.displayName || model.id || '未命名模型'
}

function usageLabel(provider: SafeProviderProfile): string {
  const usages = [
    provider.adapters?.claudeCode?.enabled ? 'Claude Code' : undefined,
    provider.adapters?.genericAgent?.enabled ? 'GenericAgent' : undefined
  ].filter(Boolean)
  return usages.length > 0 ? usages.join('、') : '未启用 Worker'
}

function keyStateLabel(provider: SafeProviderProfile, draftApiKey?: string): string {
  if (draftApiKey?.trim()) return '已填写新 Key'
  if (provider.auth.hasApiKey) return provider.auth.apiKeyPreview ? `已保存 ${provider.auth.apiKeyPreview}` : '已保存'
  return '未保存 Key'
}

function withUpdatedModels(provider: SafeProviderProfile, models: ProviderModel[]): SafeProviderProfile {
  const nextModels = models.length > 0 ? models.map((model) => normalizeModelForProvider(provider, model)) : [normalizeModelForProvider(provider)]
  const defaultModelId = provider.defaults?.modelId && nextModels.some((model) => model.id === provider.defaults?.modelId)
    ? provider.defaults?.modelId
    : nextModels[0]?.id ?? ''
  return {
    ...provider,
    model: nextModels[0],
    models: nextModels,
    defaults: {
      ...(provider.defaults ?? {}),
      modelId: defaultModelId
    }
  }
}

function createEmptyProvider(): SafeProviderProfile {
  return {
    id: crypto.randomUUID(),
    name: '',
    apiFormat: 'anthropic',
    protocol: 'anthropic',
    auth: { type: 'api-key', apiKeyPreview: '', hasApiKey: false },
    endpoint: { baseUrl: '' },
    model: { id: '', apiFormat: 'anthropic', enabled: true },
    models: [{ id: '', apiFormat: 'anthropic', enabled: true }],
    defaults: { modelId: '', apps: {} },
    adapters: {
      claudeCode: { enabled: true, permissionMode: 'default' as PermissionMode, useSettingsEnv: true },
      genericAgent: { enabled: false, sessionType: 'native_claude' as GenericAgentSessionType }
    }
  }
}

function isModified(provider: SafeProviderProfile, original: SafeProviderCatalog): boolean {
  const orig = original.providers.find((p) => p.id === provider.id)
  if (!orig) return true
  const providerModel = primaryModel(provider)
  const originalModel = primaryModel(orig)
  return provider.name !== orig.name
    || provider.protocol !== orig.protocol
    || provider.apiFormat !== orig.apiFormat
    || provider.endpoint.baseUrl !== orig.endpoint.baseUrl
    || providerModel.id !== originalModel.id
    || JSON.stringify(normalizeModels(provider)) !== JSON.stringify(normalizeModels(orig))
    || JSON.stringify(provider.defaults ?? {}) !== JSON.stringify(orig.defaults ?? {})
}

function hasValidationError(provider: SafeProviderProfile, draftApiKey?: string): string | null {
  const models = normalizeModels(provider)
  if (!provider.name.trim()) return '名称不能为空'
  if (!provider.auth.hasApiKey && !draftApiKey?.trim()) return '新连接需要填写 API Key'
  if (!provider.endpoint.baseUrl.trim()) return 'Base URL 不能为空'
  if (!models.length) return '至少保留一个模型'
  if (models.some((model) => !model.id.trim())) return 'Model 不能为空'
  return null
}

export function ProviderCatalogEditor(props: ProviderCatalogEditorProps) {
  const [providerList, setProviderList] = useState<SafeProviderProfile[]>(() =>
    props.catalog.providers.length > 0 ? [...props.catalog.providers] : []
  )
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    providerList[0]?.id ?? null
  )
  const [newApiKeyMap, setNewApiKeyMap] = useState<Record<string, string>>({})
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [isBatchManaging, setIsBatchManaging] = useState(false)
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<string>>(new Set())
  const [isConfirmingBatchDelete, setIsConfirmingBatchDelete] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [error, setError] = useState<string>()
  const [showConnectionAdvanced, setShowConnectionAdvanced] = useState(false)
  const [showGaAdvanced, setShowGaAdvanced] = useState(false)
  const [showCcswitchImport, setShowCcswitchImport] = useState(false)
  const [ccswitchPreviews, setCcswitchPreviews] = useState<CcswitchProviderPreview[]>([])
  const [selectedCcswitchIds, setSelectedCcswitchIds] = useState<Set<string>>(new Set())
  const [isCcswitchLoading, setIsCcswitchLoading] = useState(false)
  const [isCcswitchImporting, setIsCcswitchImporting] = useState(false)

  const confirmTimerRef = useRef<number | null>(null)
  const originalCatalogRef = useRef(props.catalog)

  const selectedProvider = providerList.find((p) => p.id === selectedId) ?? null
  const selectedModels = selectedProvider ? normalizeModels(selectedProvider) : []
  const selectedDefaultModelId = selectedProvider ? defaultModelId(selectedProvider, selectedModels) : ''
  const selectedDefaultModel = selectedModels.find((model) => model.id === selectedDefaultModelId) ?? selectedModels[0]
  const selectedProviderSourceLabel = selectedModels.some((model) => model.source?.type === 'ccswitch') ? '来自 CCswitch' : undefined

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const fresh = props.catalog.providers.length > 0 ? [...props.catalog.providers] : []
    setProviderList(fresh)
    setSelectedId(fresh[0]?.id ?? null)
    setNewApiKeyMap({})
    setConfirmDeleteId(null)
    setIsBatchManaging(false)
    setSelectedBatchIds(new Set())
    setIsConfirmingBatchDelete(false)
    setValidationError(null)
    setError(undefined)
    setShowConnectionAdvanced(false)
    setShowGaAdvanced(false)
    setShowCcswitchImport(false)
    setCcswitchPreviews([])
    setSelectedCcswitchIds(new Set())
    setIsCcswitchLoading(false)
    setIsCcswitchImporting(false)
    originalCatalogRef.current = props.catalog
    if (confirmTimerRef.current !== null) {
      clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = null
    }
  }, [props.catalog])

  function updateProvider(patch: Partial<SafeProviderProfile>) {
    setProviderList((list) =>
      list.map((p) => (p.id === selectedId ? { ...p, ...patch } : p))
    )
    setValidationError(null)
  }

  function updateSelectedProvider(updater: (provider: SafeProviderProfile) => SafeProviderProfile) {
    setProviderList((list) =>
      list.map((p) => (p.id === selectedId ? updater(p) : p))
    )
    setValidationError(null)
  }

  function handleAddProvider() {
    const newProvider = createEmptyProvider()
    setProviderList((list) => [...list, newProvider])
    setSelectedId(newProvider.id)
    setValidationError(null)
    setError(undefined)
    setShowConnectionAdvanced(false)
    setShowGaAdvanced(false)
    setIsBatchManaging(false)
    setSelectedBatchIds(new Set())
    setIsConfirmingBatchDelete(false)
  }

  function toggleBatchProvider(id: string) {
    setSelectedBatchIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setIsConfirmingBatchDelete(false)
  }

  function exitBatchManaging() {
    setIsBatchManaging(false)
    setSelectedBatchIds(new Set())
    setIsConfirmingBatchDelete(false)
  }

  function handleConfirmBatchDelete() {
    const idsToDelete = selectedBatchIds
    setProviderList((list) => list.filter((provider) => !idsToDelete.has(provider.id)))
    setNewApiKeyMap((map) => {
      const next = { ...map }
      idsToDelete.forEach((id) => { delete next[id] })
      return next
    })
    setSelectedId((currentId) => {
      if (currentId && idsToDelete.has(currentId)) {
        const remaining = providerList.filter((provider) => !idsToDelete.has(provider.id))
        return remaining[0]?.id ?? null
      }
      return currentId
    })
    exitBatchManaging()
  }

  function handleRequestDelete(id: string) {
    if (confirmTimerRef.current !== null) clearTimeout(confirmTimerRef.current)
    setConfirmDeleteId(id)
    confirmTimerRef.current = window.setTimeout(() => {
      setConfirmDeleteId((current) => (current === id ? null : current))
      confirmTimerRef.current = null
    }, 3000)
  }

  function handleConfirmDelete(id: string) {
    if (confirmTimerRef.current !== null) {
      clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = null
    }
    setConfirmDeleteId(null)
    setProviderList((list) => list.filter((p) => p.id !== id))
    setNewApiKeyMap((map) => {
      const next = { ...map }
      delete next[id]
      return next
    })
    setSelectedId((currentId) => {
      if (currentId === id) {
        const remaining = providerList.filter((p) => p.id !== id)
        return remaining[0]?.id ?? null
      }
      return currentId
    })
    setSelectedBatchIds((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
    setIsConfirmingBatchDelete(false)
  }

  async function handleSubmit() {
    for (const provider of providerList) {
      const errMsg = hasValidationError(provider, newApiKeyMap[provider.id])
      if (errMsg) {
        setValidationError(`"${provider.name || '未命名'}"：${errMsg}`)
        setSelectedId(provider.id)
        if (errMsg.includes('Base URL')) setShowConnectionAdvanced(true)
        return
      }
    }

    setValidationError(null)

    const ccExtraEnv = parseOptionalJson(ccExtraEnvJson)
    const gaExtraConfig = parseOptionalExtraConfig(gaExtraConfigJson)

    const patch: ProviderCatalogPatch = {
      version: 2,
      providers: providerList.map((p) => {
        const apiFormat = p.apiFormat ?? apiFormatFromProtocol(p.protocol)
        const providerForModels = { ...p, apiFormat }
        const models = normalizeModels(providerForModels)
        const defaultModelId = p.defaults?.modelId && models.some((model) => model.id === p.defaults?.modelId)
          ? p.defaults.modelId
          : models[0]?.id ?? ''
        const apps = p.defaults?.apps ?? {}
        const model = models.find((item) => item.id === defaultModelId) ?? models[0]
        return {
          id: p.id,
          name: p.name,
          apiFormat,
          protocol: p.protocol,
          auth: { type: 'api-key' as const, apiKey: newApiKeyMap[p.id] || undefined },
          endpoint: p.endpoint,
          model,
          models,
          defaults: { ...(p.defaults ?? {}), modelId: defaultModelId, apps },
          adapters: {
            claudeCode: {
              enabled: p.adapters?.claudeCode?.enabled ?? false,
              permissionMode: p.adapters?.claudeCode?.permissionMode ?? 'default',
              useSettingsEnv: true,
              ...(p.adapters?.claudeCode?.apiKeyEnv ? { apiKeyEnv: p.adapters.claudeCode.apiKeyEnv } : {}),
              ...(ccExtraEnv && p.id === selectedId ? { extraEnv: ccExtraEnv } : {})
            },
            genericAgent: {
              enabled: p.adapters?.genericAgent?.enabled ?? false,
              sessionType: p.adapters?.genericAgent?.sessionType ?? 'native_claude',
              ...(p.adapters?.genericAgent?.name ? { name: p.adapters.genericAgent.name } : {}),
              ...(p.adapters?.genericAgent?.apiMode ? { apiMode: p.adapters.genericAgent.apiMode } : {}),
              ...(p.adapters?.genericAgent?.thinkingType ? { thinkingType: p.adapters.genericAgent.thinkingType } : {}),
              ...(p.adapters?.genericAgent?.thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens: p.adapters.genericAgent.thinkingBudgetTokens } : {}),
              ...(p.adapters?.genericAgent?.reasoningEffort ? { reasoningEffort: p.adapters.genericAgent.reasoningEffort } : {}),
              ...(p.adapters?.genericAgent?.contextWindow !== undefined ? { contextWindow: p.adapters.genericAgent.contextWindow } : {}),
              ...(p.adapters?.genericAgent?.maxTokens !== undefined ? { maxTokens: p.adapters.genericAgent.maxTokens } : {}),
              ...(p.adapters?.genericAgent?.temperature !== undefined ? { temperature: p.adapters.genericAgent.temperature } : {}),
              ...(p.adapters?.genericAgent?.userAgent ? { userAgent: p.adapters.genericAgent.userAgent } : {}),
              ...(gaExtraConfig && p.id === selectedId ? { extraConfig: gaExtraConfig } : {})
            }
          }
        }
      })
    }

    try {
      await props.onSave(patch)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Advanced state is per-selected-provider, tracked locally
  const ccExtraEnvJson = selectedProvider?.id
    ? (selectedProvider.adapters?.claudeCode?.extraEnv
      ? JSON.stringify(selectedProvider.adapters.claudeCode.extraEnv as Record<string, string>, null, 2)
      : '')
    : ''
  const gaExtraConfigJson = selectedProvider?.id
    ? (selectedProvider.adapters?.genericAgent?.extraConfig
      ? JSON.stringify(selectedProvider.adapters.genericAgent.extraConfig as Record<string, string | number | boolean>, null, 2)
      : '')
    : ''

  function parseOptionalJson(json: string): Record<string, string> | undefined {
    const trimmed = json.trim()
    if (!trimmed) return undefined
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('必须是 JSON 对象')
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new Error(`字段 ${key} 必须是字符串`)
      }
    }
    return parsed as Record<string, string>
  }

  function parseOptionalExtraConfig(json: string): Record<string, string | number | boolean> | undefined {
    const trimmed = json.trim()
    if (!trimmed) return undefined
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('必须是 JSON 对象')
    }
    return parsed as Record<string, string | number | boolean>
  }

  async function handleOpenCcswitchImport() {
    setShowCcswitchImport(true)
    setIsCcswitchLoading(true)
    setError(undefined)
    try {
      const previews = await window.workerDesk.listCcswitchClaudeProviderPreviews()
      setCcswitchPreviews(previews)
      setSelectedCcswitchIds(new Set(previews.filter((provider) => !provider.alreadyExists).map((provider) => provider.id)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsCcswitchLoading(false)
    }
  }

  function toggleCcswitchProvider(id: string) {
    setSelectedCcswitchIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleImportCcswitchProviders() {
    setIsCcswitchImporting(true)
    setError(undefined)
    try {
      const catalog = await window.workerDesk.importCcswitchClaudeProviders([...selectedCcswitchIds])
      const fresh = catalog.providers.length > 0 ? [...catalog.providers] : []
      setProviderList(fresh)
      setSelectedId(fresh[0]?.id ?? null)
      setNewApiKeyMap({})
      originalCatalogRef.current = catalog
      setShowCcswitchImport(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsCcswitchImporting(false)
    }
  }

  return (
    <div className="profile-editor-backdrop">
      <div className="profile-editor-modal provider-editor-modal" role="dialog" aria-label="管理模型">
        <div className="profile-editor-header">
          <div>
            <h2>模型连接</h2>
          </div>
          <div className="provider-editor-header-actions">
            <button type="button" className="provider-btn-secondary" onClick={handleOpenCcswitchImport}>从 CCswitch 导入</button>
            <button type="button" className="profile-editor-close" aria-label="关闭" onClick={props.onCancel}>×</button>
          </div>
        </div>

        {showCcswitchImport ? (
          <div className="ccswitch-import-panel" role="dialog" aria-label="从 CCswitch 导入">
            <div className="ccswitch-import-header">
              <div>
                <div className="provider-detail-section-title">从 CCswitch 导入</div>
                <p className="profile-editor-subtitle">只显示脱敏预览。</p>
              </div>
              <button type="button" className="profile-editor-close" aria-label="关闭导入" onClick={() => setShowCcswitchImport(false)}>×</button>
            </div>
            {isCcswitchLoading ? (
              <div className="ccswitch-import-empty">正在读取 CCswitch 配置…</div>
            ) : ccswitchPreviews.length === 0 ? (
              <div className="ccswitch-import-empty">未检测到可导入的 CCswitch Claude provider。</div>
            ) : (
              <>
                <div className="ccswitch-import-list">
                  {ccswitchPreviews.map((provider) => (
                    <label key={provider.id} className={`ccswitch-import-item${provider.alreadyExists ? ' is-existing' : ''}`}>
                      <input
                        type="checkbox"
                        checked={selectedCcswitchIds.has(provider.id)}
                        onChange={() => toggleCcswitchProvider(provider.id)}
                      />
                      <span className="ccswitch-import-main">
                        <span className="ccswitch-import-name">{provider.name}{provider.isCurrent ? '（当前）' : ''}</span>
                        <span className="ccswitch-import-meta">{provider.model} · {provider.baseUrl}</span>
                      </span>
                      <span className="ccswitch-import-key">{provider.apiKeyPreview}</span>
                      {provider.alreadyExists ? <span className="ccswitch-import-badge">已存在</span> : null}
                    </label>
                  ))}
                </div>
                <div className="ccswitch-import-actions">
                  <span className="profile-editor-subtitle">已选择 {selectedCcswitchIds.size} 项</span>
                  <button type="button" className="provider-btn-secondary" onClick={() => setShowCcswitchImport(false)}>取消</button>
                  <button
                    type="button"
                    className="provider-btn-primary"
                    disabled={selectedCcswitchIds.size === 0 || isCcswitchImporting}
                    onClick={handleImportCcswitchProviders}
                  >
                    {isCcswitchImporting ? '导入中…' : '导入选中项'}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}

        <div className="provider-editor-body">
          <div className="provider-sidebar" role="listbox" aria-label="模型连接列表">
            <div className="provider-sidebar-toolbar">
              <button type="button" className="provider-sidebar-add" onClick={handleAddProvider}>+ 新增</button>
              <button
                type="button"
                className={`provider-sidebar-batch-toggle${isBatchManaging ? ' is-active' : ''}`}
                onClick={() => {
                  if (isBatchManaging) exitBatchManaging()
                  else {
                    setIsBatchManaging(true)
                    setIsConfirmingBatchDelete(false)
                  }
                }}
              >
                {isBatchManaging ? '完成' : '批量管理'}
              </button>
            </div>
            {isBatchManaging ? (
              <div className="provider-sidebar-batch-bar">
                {isConfirmingBatchDelete ? (
                  <div className="provider-sidebar-batch-confirm">
                    <span>确认删除选中的 {selectedBatchIds.size} 个连接？</span>
                    <div className="provider-sidebar-batch-actions">
                      <button type="button" className="provider-btn-secondary" onClick={() => setIsConfirmingBatchDelete(false)}>取消批量删除</button>
                      <button type="button" className="provider-sidebar-batch-delete" onClick={handleConfirmBatchDelete}>确认删除选中</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span>已选 {selectedBatchIds.size} 个</span>
                    <button
                      type="button"
                      className="provider-sidebar-batch-delete"
                      disabled={selectedBatchIds.size === 0}
                      onClick={() => setIsConfirmingBatchDelete(true)}
                    >
                      删除选中
                    </button>
                  </>
                )}
              </div>
            ) : null}
            {providerList.map((provider) => {
              const isSelected = provider.id === selectedId
              const hasError = hasValidationError(provider, newApiKeyMap[provider.id]) !== null
              const isModifiedFlag = isModified(provider, originalCatalogRef.current)
              const isConfirming = provider.id === confirmDeleteId
              const isBatchSelected = selectedBatchIds.has(provider.id)

              const defaultModel = normalizeModels(provider).find((model) => model.id === defaultModelId(provider)) ?? normalizeModels(provider)[0]
              const keyState = provider.auth.hasApiKey ? 'Key 已保存' : '缺 Key'

              return (
                <div
                  key={provider.id}
                  role="option"
                  aria-selected={isSelected}
                  className={`provider-sidebar-item${isSelected ? ' selected' : ''}${hasError ? ' has-error' : ''}`}
                >
                  {isBatchManaging ? (
                    <input
                      type="checkbox"
                      className="provider-sidebar-item-check"
                      aria-label={`选择 ${provider.name || '未命名'}`}
                      checked={isBatchSelected}
                      onChange={() => toggleBatchProvider(provider.id)}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="provider-sidebar-item-name"
                    onClick={() => {
                      setSelectedId(provider.id)
                      setValidationError(null)
                      setError(undefined)
                      setShowConnectionAdvanced(false)
                      setShowGaAdvanced(false)
                    }}
                  >
                    <span className="provider-sidebar-item-main">
                      <span className="provider-sidebar-item-text">{provider.name || '未命名'}</span>
                      <span className="provider-sidebar-item-meta">{modelLabel(defaultModel)} · {keyState}</span>
                      <span className="provider-sidebar-item-meta">{usageLabel(provider)}</span>
                    </span>
                    {isModifiedFlag ? <span className="provider-sidebar-item-dot" aria-label="已修改">●</span> : null}
                  </button>
                  {!isBatchManaging && isConfirming ? (
                    <button
                      type="button"
                      className="provider-sidebar-item-confirm-delete"
                      onClick={() => handleConfirmDelete(provider.id)}
                    >
                      确认删除？
                    </button>
                  ) : !isBatchManaging ? (
                    <button
                      type="button"
                      className="provider-sidebar-item-delete"
                      aria-label="删除连接"
                      title={`删除 ${provider.name || '未命名'}`}
                      onClick={() => handleRequestDelete(provider.id)}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              )
            })}
          </div>

          {selectedProvider ? (
            <div className="provider-detail">
              <div className="provider-current-card">
                <div className="provider-current-main">
                  <div className="provider-current-eyebrow">当前启动使用</div>
                  <div className="provider-current-name">{selectedProvider.name || '未命名'}</div>
                  <div className="provider-current-model">
                    {modelLabel(selectedDefaultModel)}
                    {selectedProviderSourceLabel ? <span className="provider-current-source">{selectedProviderSourceLabel}</span> : null}
                  </div>
                </div>
                <dl className="provider-current-meta">
                  <div>
                    <dt>Key</dt>
                    <dd>{keyStateLabel(selectedProvider, newApiKeyMap[selectedProvider.id])}</dd>
                  </div>
                  <div>
                    <dt>Base URL</dt>
                    <dd>{selectedProvider.endpoint.baseUrl || '未填写'}</dd>
                  </div>
                  <div>
                    <dt>能力</dt>
                    <dd>{usageLabel(selectedProvider)}</dd>
                  </div>
                </dl>
              </div>

              <div className="provider-detail-section">
                <div className="provider-detail-section-title">基础连接</div>
                <div className="provider-field-grid">
                  <label>
                    连接名称
                    <input value={selectedProvider.name} onChange={(e) => updateProvider({ name: e.target.value })} />
                  </label>
                  <label>
                    Base URL
                    <input aria-label="Base URL" value={selectedProvider.endpoint.baseUrl} onChange={(e) => updateProvider({ endpoint: { baseUrl: e.target.value } })} />
                  </label>
                  <label className="provider-field-span">
                    API Key
                    <input
                      type="password"
                      placeholder={selectedProvider.auth.apiKeyPreview || '输入新的 API Key'}
                      value={newApiKeyMap[selectedProvider.id] ?? ''}
                      onChange={(e) =>
                        setNewApiKeyMap((map) => ({ ...map, [selectedProvider.id]: e.target.value }))
                      }
                    />
                  </label>
                </div>
              </div>

              <div className="provider-detail-section">
                <div className="provider-section-header">
                  <span className="provider-section-label">模型</span>
                  <button
                    type="button"
                    className="provider-model-add-btn"
                    aria-label="新增模型"
                    onClick={() => updateSelectedProvider((provider) => withUpdatedModels(provider, [
                      ...normalizeModels(provider),
                      { id: '', displayName: '', apiFormat: provider.apiFormat, enabled: true }
                    ]))}
                  >+</button>
                </div>
                <label className="provider-default-model-field">
                  默认模型
                  <select
                    aria-label="Default Model"
                    value={selectedDefaultModelId}
                    onChange={(e) => updateProvider({ defaults: { ...(selectedProvider.defaults ?? {}), modelId: e.target.value } })}
                  >
                    {selectedModels.map((model) => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)}
                  </select>
                </label>
                <div className="provider-model-list">
                  {selectedModels.map((model, index) => {
                    const isDefault = selectedDefaultModelId === model.id
                    return (
                      <div key={`${index}-${model.id}`} className={`provider-model-card${isDefault ? ' is-current' : ''}`}>
                        <div className="provider-model-card-header">
                          <label className="provider-model-default-choice">
                            <input
                              type="radio"
                              name={`provider-${selectedProvider.id}-default-model`}
                              checked={isDefault}
                              onChange={() => updateProvider({ defaults: { ...(selectedProvider.defaults ?? {}), modelId: model.id } })}
                            />
                            <span className="provider-model-summary">
                              <span className="provider-model-name">{modelLabel(model)}</span>
                              <span className="provider-model-id">{model.id || '还没有填写模型 ID'}</span>
                            </span>
                          </label>
                          <div className="provider-model-card-actions">
                            <label className="provider-model-enabled">
                              <input
                                type="checkbox"
                                checked={model.enabled !== false}
                                onChange={(e) => updateSelectedProvider((provider) => {
                                  const models = normalizeModels(provider)
                                  models[index] = { ...models[index], enabled: e.target.checked }
                                  return withUpdatedModels(provider, models)
                                })}
                              />
                              启用
                            </label>
                            <button
                              type="button"
                              className="provider-model-delete-btn"
                              aria-label="删除模型"
                              disabled={selectedModels.length <= 1}
                              onClick={() => updateSelectedProvider((provider) => withUpdatedModels(provider, normalizeModels(provider).filter((_, modelIndex) => modelIndex !== index)))}
                            >×</button>
                          </div>
                        </div>
                        <div className="provider-model-edit-grid">
                          <label>
                            模型 ID
                            <input
                              aria-label="Model ID"
                              value={model.id}
                              onChange={(e) => updateSelectedProvider((provider) => {
                                const models = normalizeModels(provider)
                                models[index] = { ...models[index], id: e.target.value }
                                return withUpdatedModels(provider, models)
                              })}
                            />
                          </label>
                          <label>
                            显示名称
                            <input
                              aria-label="Model Display Name"
                              value={model.displayName ?? ''}
                              onChange={(e) => updateSelectedProvider((provider) => {
                                const models = normalizeModels(provider)
                                models[index] = { ...models[index], displayName: e.target.value || undefined }
                                return withUpdatedModels(provider, models)
                              })}
                            />
                          </label>
                        </div>
                        {showConnectionAdvanced ? (
                          <div className="provider-model-advanced-grid">
                            <label>
                              Model API Format
                              <select
                                aria-label="Model API Format"
                                value={model.apiFormat ?? selectedProvider.apiFormat}
                                onChange={(e) => updateSelectedProvider((provider) => {
                                  const models = normalizeModels(provider)
                                  models[index] = { ...models[index], apiFormat: e.target.value as ProviderApiFormat }
                                  return withUpdatedModels(provider, models)
                                })}
                              >
                                {apiFormats.map((format) => <option key={format} value={format}>{format}</option>)}
                              </select>
                            </label>
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="provider-detail-section">
                <div className="provider-detail-section-title">可用于</div>
                <div className="provider-availability-list" role="group" aria-label="可用于">
                  <label className="provider-availability-item">
                    <input
                      type="checkbox"
                      checked={selectedProvider.adapters?.claudeCode?.enabled ?? false}
                      onChange={(e) =>
                        updateProvider({
                          adapters: {
                            ...selectedProvider.adapters,
                            claudeCode: {
                              ...(selectedProvider.adapters?.claudeCode ?? {}),
                              enabled: e.target.checked,
                              permissionMode: selectedProvider.adapters?.claudeCode?.permissionMode ?? 'default',
                              useSettingsEnv: true
                            }
                          }
                        })
                      }
                    />
                    <span>Claude Code</span>
                  </label>
                  <label className="provider-availability-item">
                    <input
                      type="checkbox"
                      checked={selectedProvider.adapters?.genericAgent?.enabled ?? false}
                      onChange={(e) =>
                        updateProvider({
                          adapters: {
                            ...selectedProvider.adapters,
                            genericAgent: {
                              ...(selectedProvider.adapters?.genericAgent ?? {}),
                              enabled: e.target.checked,
                              sessionType: selectedProvider.adapters?.genericAgent?.sessionType ?? 'native_claude'
                            }
                          }
                        })
                      }
                    />
                    <span>GenericAgent</span>
                  </label>
                  <span className="provider-availability-item is-readonly">Summary</span>
                </div>
              </div>

              <div className="provider-detail-section provider-advanced-row">
                <button
                  type="button"
                  className="provider-advanced-toggle"
                  aria-expanded={showConnectionAdvanced}
                  onClick={() => setShowConnectionAdvanced((value) => !value)}
                >
                  {showConnectionAdvanced ? '▲ 收起高级设置' : '▼ 高级设置'}
                </button>
              </div>

              {showConnectionAdvanced ? (
                <>
                  <div className="provider-detail-section">
                    <div className="provider-detail-section-title">高级连接设置</div>
                    <div className="provider-field-grid">
                      <label className="provider-field-span">
                        协议
                        <select
                          value={selectedProvider.protocol}
                          onChange={(e) => {
                            const protocol = e.target.value as ProviderProtocol
                            const apiFormat = apiFormatFromProtocol(protocol)
                            updateSelectedProvider((provider) => withUpdatedModels({ ...provider, protocol, apiFormat }, normalizeModels(provider)))
                          }}
                        >
                          <option value="anthropic">anthropic</option>
                          <option value="anthropic-compatible">anthropic-compatible</option>
                          <option value="openai-compatible">openai-compatible</option>
                        </select>
                      </label>
                      <label>
                        Provider API Format
                        <select
                          aria-label="Provider API Format"
                          value={selectedProvider.apiFormat}
                          onChange={(e) => {
                            const apiFormat = e.target.value as ProviderApiFormat
                            updateSelectedProvider((provider) => withUpdatedModels({ ...provider, apiFormat }, normalizeModels(provider)))
                          }}
                        >
                          {apiFormats.map((format) => <option key={format} value={format}>{format}</option>)}
                        </select>
                      </label>
                    </div>
                  </div>

                  <div className="provider-detail-section">
                    <div className="provider-detail-section-title">不同用途使用不同模型</div>
                    <div className="provider-field-grid">
                      <label>
                        Claude Code Default Model
                        <select
                          aria-label="Claude Code Default Model"
                          value={selectedProvider.defaults?.apps?.claudeCode?.modelId ?? ''}
                          onChange={(e) => updateProvider({
                            defaults: {
                              ...(selectedProvider.defaults ?? {}),
                              apps: { ...(selectedProvider.defaults?.apps ?? {}), claudeCode: { modelId: e.target.value || undefined } }
                            }
                          })}
                        >
                          <option value="">默认</option>
                          {selectedModels.map((model) => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)}
                        </select>
                      </label>
                      <label>
                        GenericAgent Default Model
                        <select
                          aria-label="GenericAgent Default Model"
                          value={selectedProvider.defaults?.apps?.genericAgent?.modelId ?? ''}
                          onChange={(e) => updateProvider({
                            defaults: {
                              ...(selectedProvider.defaults ?? {}),
                              apps: { ...(selectedProvider.defaults?.apps ?? {}), genericAgent: { modelId: e.target.value || undefined } }
                            }
                          })}
                        >
                          <option value="">默认</option>
                          {selectedModels.map((model) => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)}
                        </select>
                      </label>
                      <label>
                        Summary Default Model
                        <select
                          aria-label="Summary Default Model"
                          value={selectedProvider.defaults?.apps?.summary?.modelId ?? ''}
                          onChange={(e) => updateProvider({
                            defaults: {
                              ...(selectedProvider.defaults ?? {}),
                              apps: { ...(selectedProvider.defaults?.apps ?? {}), summary: { modelId: e.target.value || undefined } }
                            }
                          })}
                        >
                          <option value="">默认</option>
                          {selectedModels.map((model) => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)}
                        </select>
                      </label>
                    </div>
                  </div>

                  <div className="provider-detail-section">
                    <div className="provider-section-header">
                      <span className="provider-section-label">Claude Code 高级</span>
                    </div>
                    {(selectedProvider.adapters?.claudeCode?.enabled ?? false) && (
                      <div className="provider-field-grid">
                        <label>
                          权限模式
                          <select
                            value={selectedProvider.adapters?.claudeCode?.permissionMode ?? 'default'}
                            onChange={(e) =>
                              updateProvider({
                                adapters: {
                                  ...selectedProvider.adapters,
                                  claudeCode: {
                                    ...(selectedProvider.adapters?.claudeCode ?? {}),
                                    enabled: selectedProvider.adapters?.claudeCode?.enabled ?? true,
                                    permissionMode: e.target.value as PermissionMode,
                                    useSettingsEnv: true
                                  }
                                }
                              })
                            }
                          >
                            {permissionModes.map((mode) => (
                              <option key={mode} value={mode}>{mode}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          API Key 环境变量
                          <select
                            value={selectedProvider.adapters?.claudeCode?.apiKeyEnv ?? ''}
                            onChange={(e) =>
                              updateProvider({
                                adapters: {
                                  ...selectedProvider.adapters,
                                  claudeCode: {
                                    ...selectedProvider.adapters!.claudeCode!,
                                    apiKeyEnv: (e.target.value || undefined) as 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | undefined
                                  }
                                }
                              })
                            }
                          >
                            <option value="">自动选择</option>
                            {apiKeyEnvs.map((env) => (
                              <option key={env} value={env}>{env}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                    )}
                  </div>

                  <div className="provider-detail-section">
                    <div className="provider-section-header">
                      <span className="provider-section-label">GenericAgent 高级</span>
                    </div>
                    {(selectedProvider.adapters?.genericAgent?.enabled ?? false) && (
                      <>
                        <div className="provider-field-grid">
                          <label>
                            会话类型
                            <select
                              value={selectedProvider.adapters?.genericAgent?.sessionType ?? 'native_claude'}
                              onChange={(e) =>
                                updateProvider({
                                  adapters: {
                                    ...selectedProvider.adapters,
                                    genericAgent: {
                                      ...(selectedProvider.adapters?.genericAgent ?? {}),
                                      enabled: selectedProvider.adapters?.genericAgent?.enabled ?? true,
                                      sessionType: e.target.value as GenericAgentSessionType
                                    }
                                  }
                                })
                              }
                            >
                              {sessionTypes.map((type) => (
                                <option key={type} value={type}>{type}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            API 模式
                            <select
                              value={selectedProvider.adapters?.genericAgent?.apiMode ?? ''}
                              onChange={(e) =>
                                updateProvider({
                                  adapters: {
                                    ...selectedProvider.adapters,
                                    genericAgent: {
                                      ...selectedProvider.adapters!.genericAgent!,
                                      apiMode: (e.target.value || undefined) as 'chat_completions' | 'responses' | undefined
                                    }
                                  }
                                })
                              }
                            >
                              <option value="">默认</option>
                              {apiModes.map((m) => (
                                <option key={m} value={m}>{m}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            显示名称
                            <input
                              value={selectedProvider.adapters?.genericAgent?.name ?? ''}
                              onChange={(e) =>
                                updateProvider({
                                  adapters: {
                                    ...selectedProvider.adapters,
                                    genericAgent: {
                                      ...selectedProvider.adapters!.genericAgent!,
                                      name: e.target.value || undefined
                                    }
                                  }
                                })
                              }
                            />
                          </label>
                          <label>
                            思考模式
                            <select
                              value={selectedProvider.adapters?.genericAgent?.thinkingType ?? ''}
                              onChange={(e) =>
                                updateProvider({
                                  adapters: {
                                    ...selectedProvider.adapters,
                                    genericAgent: {
                                      ...selectedProvider.adapters!.genericAgent!,
                                      thinkingType: (e.target.value || undefined) as 'adaptive' | 'enabled' | 'disabled' | undefined
                                    }
                                  }
                                })
                              }
                            >
                              <option value="">默认</option>
                              {thinkingTypes.map((t) => (
                                <option key={t} value={t}>{t}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            推理力度
                            <select
                              value={selectedProvider.adapters?.genericAgent?.reasoningEffort ?? ''}
                              onChange={(e) =>
                                updateProvider({
                                  adapters: {
                                    ...selectedProvider.adapters,
                                    genericAgent: {
                                      ...selectedProvider.adapters!.genericAgent!,
                                      reasoningEffort: (e.target.value || undefined) as 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined
                                    }
                                  }
                                })
                              }
                            >
                              <option value="">默认</option>
                              {reasoningEfforts.map((r) => (
                                <option key={r} value={r}>{r}</option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <button
                          type="button"
                          className="provider-advanced-toggle"
                          onClick={() => setShowGaAdvanced((v) => !v)}
                        >
                          {showGaAdvanced ? '▲ 收起高级选项' : '▼ 高级选项'}
                        </button>
                        {showGaAdvanced && (
                          <div className="provider-field-grid">
                            <label>
                              思考预算 (Tokens)
                              <input
                                type="number"
                                placeholder="默认"
                                value={selectedProvider.adapters?.genericAgent?.thinkingBudgetTokens ?? ''}
                                onChange={(e) =>
                                  updateProvider({
                                    adapters: {
                                      ...selectedProvider.adapters,
                                      genericAgent: {
                                        ...selectedProvider.adapters!.genericAgent!,
                                        thinkingBudgetTokens: e.target.value ? Number(e.target.value) : undefined
                                      }
                                    }
                                  })
                                }
                              />
                            </label>
                            <label>
                              上下文窗口
                              <input
                                type="number"
                                placeholder="默认"
                                value={selectedProvider.adapters?.genericAgent?.contextWindow ?? ''}
                                onChange={(e) =>
                                  updateProvider({
                                    adapters: {
                                      ...selectedProvider.adapters,
                                      genericAgent: {
                                        ...selectedProvider.adapters!.genericAgent!,
                                        contextWindow: e.target.value ? Number(e.target.value) : undefined
                                      }
                                    }
                                  })
                                }
                              />
                            </label>
                            <label>
                              最大输出 (Tokens)
                              <input
                                type="number"
                                placeholder="默认"
                                value={selectedProvider.adapters?.genericAgent?.maxTokens ?? ''}
                                onChange={(e) =>
                                  updateProvider({
                                    adapters: {
                                      ...selectedProvider.adapters,
                                      genericAgent: {
                                        ...selectedProvider.adapters!.genericAgent!,
                                        maxTokens: e.target.value ? Number(e.target.value) : undefined
                                      }
                                    }
                                  })
                                }
                              />
                            </label>
                            <label>
                              温度
                              <input
                                type="number"
                                step="0.1"
                                placeholder="默认"
                                value={selectedProvider.adapters?.genericAgent?.temperature ?? ''}
                                onChange={(e) =>
                                  updateProvider({
                                    adapters: {
                                      ...selectedProvider.adapters,
                                      genericAgent: {
                                        ...selectedProvider.adapters!.genericAgent!,
                                        temperature: e.target.value ? Number(e.target.value) : undefined
                                      }
                                    }
                                  })
                                }
                              />
                            </label>
                            <label className="provider-field-span">
                              User Agent
                              <input
                                value={selectedProvider.adapters?.genericAgent?.userAgent ?? ''}
                                onChange={(e) =>
                                  updateProvider({
                                    adapters: {
                                      ...selectedProvider.adapters,
                                      genericAgent: {
                                        ...selectedProvider.adapters!.genericAgent!,
                                        userAgent: e.target.value || undefined
                                      }
                                    }
                                  })
                                }
                              />
                            </label>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <div className="provider-detail profile-editor-form">
              <p className="profile-editor-subtitle">还没有模型连接，点左侧「新增」开始。</p>
            </div>
          )}
        </div>

        {validationError ? <div role="alert" className="profile-editor-error">{validationError}</div> : null}
        {error ? <div role="alert" className="profile-editor-error">{error}</div> : null}
        <div className="profile-editor-actions">
          <button type="button" className="provider-btn-secondary" onClick={props.onCancel}>取消</button>
          <button type="button" className="provider-btn-primary" onClick={handleSubmit}>保存</button>
        </div>
      </div>
    </div>
  )
}
