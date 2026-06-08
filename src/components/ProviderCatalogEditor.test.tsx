import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderCatalogPatch, SafeProviderCatalog } from '../types/workerDesk'
import { ProviderCatalogEditor } from './ProviderCatalogEditor'

const provider1 = {
  id: 'anthropic-direct',
  name: 'Anthropic Direct',
  apiFormat: 'anthropic' as const,
  protocol: 'anthropic' as const,
  auth: { type: 'api-key' as const, apiKeyPreview: 'sk-ant-***wxyz', hasApiKey: true },
  endpoint: { baseUrl: 'https://api.anthropic.com' },
  model: { id: 'claude-opus-4-7', apiFormat: 'anthropic' as const, enabled: true },
  models: [{ id: 'claude-opus-4-7', apiFormat: 'anthropic' as const, enabled: true }],
  defaults: { modelId: 'claude-opus-4-7' },
  adapters: {
    claudeCode: { enabled: true, permissionMode: 'default' as const, useSettingsEnv: true as const },
    genericAgent: { enabled: false, sessionType: 'native_claude' as const }
  }
}

const provider2 = {
  id: 'openrouter',
  name: 'OpenRouter',
  apiFormat: 'openai_chat' as const,
  protocol: 'openai-compatible' as const,
  auth: { type: 'api-key' as const, apiKeyPreview: 'sk-or-***abcd', hasApiKey: true },
  endpoint: { baseUrl: 'https://openrouter.ai/api/v1' },
  model: { id: 'gpt-4o', apiFormat: 'openai_chat' as const, enabled: true },
  models: [{ id: 'gpt-4o', apiFormat: 'openai_chat' as const, enabled: true }],
  defaults: { modelId: 'gpt-4o' },
  adapters: {
    claudeCode: { enabled: false, permissionMode: 'default' as const, useSettingsEnv: true as const },
    genericAgent: { enabled: true, sessionType: 'native_oai' as const }
  }
}

const provider3 = {
  ...provider1,
  id: 'deepseek-compatible',
  name: 'DeepSeek Compatible',
  endpoint: { baseUrl: 'https://api.deepseek.com' },
  model: { id: 'deepseek-chat', apiFormat: 'anthropic' as const, enabled: true },
  models: [{ id: 'deepseek-chat', apiFormat: 'anthropic' as const, enabled: true }],
  defaults: { modelId: 'deepseek-chat' }
}

const providerWithGenericAgentAdvanced = {
  ...provider1,
  id: 'advanced-generic-agent',
  name: 'Advanced GenericAgent',
  adapters: {
    claudeCode: provider1.adapters.claudeCode,
    genericAgent: {
      enabled: true,
      sessionType: 'native_claude' as const,
      extraConfig: { region: 'cn', retry: 2, trace: true },
      name: 'GA Advanced',
      apiMode: 'responses' as const,
      thinkingType: 'enabled' as const,
      thinkingBudgetTokens: 32000,
      reasoningEffort: 'high' as const,
      contextWindow: 200000,
      maxTokens: 8192,
      temperature: 0.2,
      userAgent: 'AIWorkerControlDesk/Test'
    }
  }
}

const multiCatalog: SafeProviderCatalog = {
  version: 2,
  providers: [provider1, provider2]
}

const singleCatalog: SafeProviderCatalog = {
  version: 2,
  providers: [provider1]
}

function renderEditor(overrides: Partial<Parameters<typeof ProviderCatalogEditor>[0]> = {}) {
  const props = {
    catalog: singleCatalog,
    onSave: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
    ...overrides
  }
  render(<ProviderCatalogEditor {...props} />)
  return props
}

function clickProvider(name: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }))
}

function openAdvancedSettings() {
  fireEvent.click(screen.getByRole('button', { name: '▼ 高级设置' }))
}

describe('ProviderCatalogEditor', () => {
  it('renders provider list with all providers', () => {
    renderEditor({ catalog: multiCatalog })

    const listbox = screen.getByRole('listbox', { name: '模型连接列表' })
    expect(within(listbox).getByRole('button', { name: /Anthropic Direct/ })).toBeInTheDocument()
    expect(within(listbox).getByRole('button', { name: /OpenRouter/ })).toBeInTheDocument()
    expect(screen.getByText('当前启动使用')).toBeInTheDocument()
  })

  it('keeps the model manager header compact by default', () => {
    renderEditor({ catalog: multiCatalog })

    expect(screen.getByRole('heading', { name: '模型连接' })).toBeInTheDocument()
    expect(screen.queryByText('日常只改默认模型；连接和 Worker 细节默认收起。')).not.toBeInTheDocument()
  })

  it('shows connection and model facts by default without exposing advanced catalog fields', () => {
    renderEditor({ catalog: multiCatalog })

    expect(screen.getByText('基础连接')).toBeInTheDocument()
    expect(screen.getByText('模型')).toBeInTheDocument()
    expect(screen.getByText('可用于')).toBeInTheDocument()

    expect(screen.getByLabelText('连接名称')).toHaveValue('Anthropic Direct')
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.anthropic.com')
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    expect(screen.getByLabelText('Default Model')).toHaveValue('claude-opus-4-7')

    expect(screen.queryByLabelText('Provider API Format')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Model API Format')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Claude Code Default Model')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('GenericAgent Default Model')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Summary Default Model')).not.toBeInTheDocument()
    expect(screen.queryByText(/adapter/i)).not.toBeInTheDocument()
    expect(screen.queryByText('适配')).not.toBeInTheDocument()
  })

  it('switches selected provider when clicking list item', () => {
    renderEditor({ catalog: multiCatalog })

    clickProvider('OpenRouter')
    const nameInput = screen.getByLabelText('连接名称') as HTMLInputElement
    expect(nameInput.value).toBe('OpenRouter')
  })

  it('adds a new provider and selects it', () => {
    renderEditor({ catalog: singleCatalog })

    fireEvent.click(screen.getByRole('button', { name: /\+ 新增/ }))

    const nameInput = screen.getByLabelText('连接名称') as HTMLInputElement
    expect(nameInput.value).toBe('')
  })

  it('deletes a provider after confirming', () => {
    renderEditor({ catalog: multiCatalog })

    const deleteButtons = screen.getAllByLabelText(/删除/)
    fireEvent.click(deleteButtons[0])

    expect(screen.getByText('确认删除？')).toBeInTheDocument()

    fireEvent.click(screen.getByText('确认删除？'))

    expect(screen.queryByRole('button', { name: /Anthropic Direct/ })).not.toBeInTheDocument()
    const listbox = screen.getByRole('listbox', { name: '模型连接列表' })
    expect(within(listbox).getByRole('button', { name: /OpenRouter/ })).toBeInTheDocument()
  })

  it('reverts delete confirmation after 3 seconds', async () => {
    vi.useFakeTimers()
    renderEditor({ catalog: multiCatalog })

    const deleteButtons = screen.getAllByLabelText(/删除/)
    fireEvent.click(deleteButtons[0])
    expect(screen.getByText('确认删除？')).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(3000) })

    expect(screen.queryByText('确认删除？')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Anthropic Direct/ })).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('falls back to first remaining provider when deleting selected', () => {
    renderEditor({ catalog: multiCatalog })

    const deleteButtons = screen.getAllByLabelText(/删除/)
    fireEvent.click(deleteButtons[0])
    fireEvent.click(screen.getByText('确认删除？'))

    const nameInput = screen.getByLabelText('连接名称') as HTMLInputElement
    expect(nameInput.value).toBe('OpenRouter')
  })

  it('shows empty state when all providers deleted', () => {
    renderEditor({ catalog: singleCatalog })

    const deleteButtons = screen.getAllByLabelText(/删除/)
    fireEvent.click(deleteButtons[0])
    fireEvent.click(screen.getByText('确认删除？'))

    expect(screen.getByText(/没有模型连接/)).toBeInTheDocument()
  })

  it('deletes selected providers in batch after confirmation', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({ catalog: { version: 2, providers: [provider1, provider2, provider3] }, onSave })

    fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Anthropic Direct' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 OpenRouter' }))
    expect(screen.getByText('已选 2 个')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '删除选中' }))
    expect(screen.getByText('确认删除选中的 2 个连接？')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认删除选中' }))

    expect(screen.queryByRole('button', { name: /Anthropic Direct/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /OpenRouter/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /DeepSeek Compatible/ })).toBeInTheDocument()
    expect(screen.getByLabelText('连接名称')).toHaveValue('DeepSeek Compatible')

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    const patch: ProviderCatalogPatch = onSave.mock.calls[0][0]
    expect(patch.providers.map((provider) => provider.id)).toEqual(['deepseek-compatible'])
  })

  it('cancels provider batch delete without removing selected providers', () => {
    renderEditor({ catalog: multiCatalog })

    fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Anthropic Direct' }))
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }))
    fireEvent.click(screen.getByRole('button', { name: '取消批量删除' }))

    expect(screen.getByRole('button', { name: /Anthropic Direct/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /OpenRouter/ })).toBeInTheDocument()
    expect(screen.getByText('已选 1 个')).toBeInTheDocument()
  })

  it('exits provider batch mode and clears selected providers', () => {
    renderEditor({ catalog: multiCatalog })

    fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Anthropic Direct' }))
    fireEvent.click(screen.getByRole('button', { name: '完成' }))

    expect(screen.queryByText('已选 1 个')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: '选择 Anthropic Direct' })).not.toBeInTheDocument()
  })

  it('shows modified dot when provider name changes', () => {
    renderEditor({ catalog: singleCatalog })

    expect(screen.queryByText('●')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: 'Updated Name' } })
    expect(screen.getByText('●')).toBeInTheDocument()
  })

  it('shows validation error for empty fields on save', async () => {
    renderEditor({ catalog: multiCatalog })

    clickProvider('OpenRouter')
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: '' } })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('名称不能为空')
    })
  })

  it('jumps to invalid provider on save', async () => {
    renderEditor({ catalog: multiCatalog })

    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: '' } })
    clickProvider('OpenRouter')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      const nameInput = screen.getByLabelText('连接名称') as HTMLInputElement
      expect(nameInput.value).toBe('')
    })
  })

  it('saves patch with all providers', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({ catalog: multiCatalog, onSave })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce()
    })

    const patch: ProviderCatalogPatch = onSave.mock.calls[0][0]
    expect(patch.providers).toHaveLength(2)
    expect(patch.providers[0].id).toBe('anthropic-direct')
    expect(patch.providers[1].id).toBe('openrouter')
  })

  it('derives provider.model from the selected default model when saving', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({
      catalog: {
        version: 2,
        providers: [{
          ...provider1,
          models: [
            { id: 'claude-opus-4-7', displayName: 'Opus', apiFormat: 'anthropic' as const, enabled: true },
            { id: 'claude-sonnet-4-6', displayName: 'Sonnet', apiFormat: 'anthropic' as const, enabled: true }
          ],
          defaults: { modelId: 'claude-opus-4-7' }
        }]
      },
      onSave
    })

    fireEvent.change(screen.getByLabelText('Default Model'), { target: { value: 'claude-sonnet-4-6' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    const patch: ProviderCatalogPatch = onSave.mock.calls[0][0]
    expect(patch.providers[0].defaults?.modelId).toBe('claude-sonnet-4-6')
    expect(patch.providers[0].model).toEqual({
      id: 'claude-sonnet-4-6',
      displayName: 'Sonnet',
      apiFormat: 'anthropic',
      enabled: true
    })
  })

  it('saves patch without deleted provider', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({ catalog: multiCatalog, onSave })

    const deleteButtons = screen.getAllByLabelText(/删除/)
    fireEvent.click(deleteButtons[0])
    fireEvent.click(screen.getByText('确认删除？'))

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce()
    })

    const patch: ProviderCatalogPatch = onSave.mock.calls[0][0]
    expect(patch.providers).toHaveLength(1)
    expect(patch.providers[0].id).toBe('openrouter')
  })

  it('saves patch without apiKey when user does not input a new key', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({ onSave })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce()
    })
    const patch: ProviderCatalogPatch = onSave.mock.calls[0][0]
    expect(patch.providers[0].auth.apiKey).toBeUndefined()
  })

  it('saves patch with apiKey when user inputs a new key', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({ onSave })

    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'test-anthropic-key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce()
    })
    const patch: ProviderCatalogPatch = onSave.mock.calls[0][0]
    expect(patch.providers[0].auth.apiKey).toBe('test-anthropic-key')
  })

  it('calls onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn()
    renderEditor({ onCancel })

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('displays error when save throws', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('保存失败'))
    renderEditor({ onSave })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('保存失败')
    })
  })

  it('shows worker availability controls without adapter wording', () => {
    renderEditor()

    const availability = screen.getByRole('group', { name: '可用于' })
    const ccCheckbox = within(availability).getByRole('checkbox', { name: 'Claude Code' }) as HTMLInputElement
    const gaCheckbox = within(availability).getByRole('checkbox', { name: 'GenericAgent' }) as HTMLInputElement

    expect(ccCheckbox.checked).toBe(true)
    expect(gaCheckbox.checked).toBe(false)
    expect(screen.queryByRole('checkbox', { name: '启用 Claude Code 适配' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: '启用 GenericAgent 适配' })).not.toBeInTheDocument()
  })

  it('saves worker availability changes through adapter flags', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({ onSave })

    const availability = screen.getByRole('group', { name: '可用于' })
    fireEvent.click(within(availability).getByRole('checkbox', { name: 'Claude Code' }))
    fireEvent.click(within(availability).getByRole('checkbox', { name: 'GenericAgent' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    const patch: ProviderCatalogPatch = onSave.mock.calls[0][0]
    expect(patch.providers[0].adapters?.claudeCode?.enabled).toBe(false)
    expect(patch.providers[0].adapters?.genericAgent?.enabled).toBe(true)
  })

  it('preserves hidden GenericAgent fields when toggling enabled', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({
      catalog: { version: 2, providers: [providerWithGenericAgentAdvanced] },
      onSave
    })

    const availability = screen.getByRole('group', { name: '可用于' })
    fireEvent.click(within(availability).getByRole('checkbox', { name: 'GenericAgent' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    const patch: ProviderCatalogPatch = onSave.mock.calls[0][0]
    expect(patch.providers[0].adapters?.genericAgent).toEqual({
      ...providerWithGenericAgentAdvanced.adapters.genericAgent,
      enabled: false
    })
  })

  it('preserves hidden GenericAgent fields when changing session type', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({
      catalog: { version: 2, providers: [providerWithGenericAgentAdvanced] },
      onSave
    })

    openAdvancedSettings()
    fireEvent.change(screen.getByDisplayValue('native_claude'), { target: { value: 'native_oai' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    const patch: ProviderCatalogPatch = onSave.mock.calls[0][0]
    expect(patch.providers[0].adapters?.genericAgent).toEqual({
      ...providerWithGenericAgentAdvanced.adapters.genericAgent,
      sessionType: 'native_oai'
    })
  })

  it('shows empty message when catalog is empty and allows creating', () => {
    const emptyCatalog: SafeProviderCatalog = { version: 2, providers: [] }
    renderEditor({ catalog: emptyCatalog })

    expect(screen.getByText(/没有模型连接/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /\+ 新增/ }))
    expect(screen.getByLabelText('连接名称')).toHaveValue('')
  })

  it('opens legacy safe providers that only have model without crashing', () => {
    renderEditor({
      catalog: {
        version: 2,
        providers: [{
          id: 'legacy-safe',
          name: 'Legacy Safe',
          apiFormat: 'anthropic',
          protocol: 'anthropic',
          auth: { type: 'api-key', hasApiKey: true, apiKeyPreview: 'sk-***' },
          endpoint: { baseUrl: 'https://api.anthropic.com' },
          model: { id: 'claude-sonnet-4-6', apiFormat: 'anthropic', enabled: true },
          defaults: { modelId: 'claude-sonnet-4-6' },
          adapters: {
            claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true }
          }
        }]
      } as unknown as SafeProviderCatalog
    })

    expect(screen.getByLabelText('连接名称')).toHaveValue('Legacy Safe')
    expect(screen.getAllByLabelText('Model ID')).toHaveLength(1)
    expect((screen.getAllByLabelText('Model ID')[0] as HTMLInputElement).value).toBe('claude-sonnet-4-6')
  })

  it('shows validation error for empty name on save with new provider', async () => {
    const emptyCatalog: SafeProviderCatalog = { version: 2, providers: [] }
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({ catalog: emptyCatalog, onSave })

    fireEvent.click(screen.getByRole('button', { name: /\+ 新增/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('名称不能为空')
    })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('requires an API key when saving a new provider', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({ catalog: { version: 2, providers: [] }, onSave })

    fireEvent.click(screen.getByRole('button', { name: /\+ 新增/ }))
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: 'First Provider' } })
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'claude-sonnet-4-6' } })
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.example.com' } })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('新连接需要填写 API Key'))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('keeps existing saved API key optional when saving an existing provider', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({ onSave })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    const patch: ProviderCatalogPatch = onSave.mock.calls[0][0]
    expect(patch.providers[0].auth.apiKey).toBeUndefined()
  })

  it('keeps Base URL in the basic connection section and validates it on save', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({ catalog: { version: 2, providers: [] }, onSave })

    fireEvent.click(screen.getByRole('button', { name: /\+ 新增/ }))
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: 'First Provider' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'test-key-value' } })
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'claude-sonnet-4-6' } })

    expect(screen.getByLabelText('Base URL')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Base URL 不能为空'))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('edits and saves multiple models with apiFormat overrides and defaults', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({
      catalog: {
        version: 2,
        providers: [{
          ...provider1,
          apiFormat: 'anthropic',
          models: [
            { id: 'claude-opus-4-7', displayName: 'Opus', apiFormat: 'anthropic' as const, enabled: true },
            { id: 'claude-sonnet-4-6', displayName: 'Sonnet', apiFormat: 'anthropic' as const, enabled: true }
          ],
          defaults: {
            modelId: 'claude-opus-4-7',
            apps: {
              claudeCode: { modelId: 'claude-opus-4-7' },
              genericAgent: { modelId: 'claude-sonnet-4-6' },
              summary: { modelId: 'claude-opus-4-7' }
            }
          }
        }]
      },
      onSave
    })

    expect(screen.queryByLabelText('Provider API Format')).not.toBeInTheDocument()
    const modelIds = screen.getAllByLabelText('Model ID') as HTMLInputElement[]
    expect(modelIds.map((input) => input.value)).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6'])

    fireEvent.change(modelIds[1], { target: { value: 'openai/gpt-4o' } })
    fireEvent.change(screen.getByLabelText('Default Model'), { target: { value: 'openai/gpt-4o' } })
    openAdvancedSettings()
    expect(screen.getByLabelText('Provider API Format')).toHaveValue('anthropic')
    fireEvent.change(screen.getByLabelText('Provider API Format'), { target: { value: 'openai_chat' } })
    fireEvent.change((screen.getAllByLabelText('Model API Format')[1] as HTMLSelectElement), { target: { value: 'openai_chat' } })
    fireEvent.change(screen.getByLabelText('Claude Code Default Model'), { target: { value: 'claude-opus-4-7' } })
    fireEvent.change(screen.getByLabelText('GenericAgent Default Model'), { target: { value: 'openai/gpt-4o' } })
    fireEvent.change(screen.getByLabelText('Summary Default Model'), { target: { value: 'claude-opus-4-7' } })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    const patch: ProviderCatalogPatch = onSave.mock.calls[0][0]
    expect(patch.providers[0].apiFormat).toBe('openai_chat')
    expect(patch.providers[0].models).toEqual([
      { id: 'claude-opus-4-7', displayName: 'Opus', apiFormat: 'anthropic', enabled: true },
      { id: 'openai/gpt-4o', displayName: 'Sonnet', apiFormat: 'openai_chat', enabled: true }
    ])
    expect(patch.providers[0].model).toEqual({ id: 'openai/gpt-4o', displayName: 'Sonnet', apiFormat: 'openai_chat', enabled: true })
    expect(patch.providers[0].defaults).toMatchObject({
      modelId: 'openai/gpt-4o',
      apps: {
        claudeCode: { modelId: 'claude-opus-4-7' },
        genericAgent: { modelId: 'openai/gpt-4o' },
        summary: { modelId: 'claude-opus-4-7' }
      }
    })
  })

  it('guides first-time users with a compact empty state', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({ catalog: { version: 2, providers: [] }, onSave })

    expect(screen.getByText('还没有模型连接，点左侧「新增」开始。')).toBeInTheDocument()
    expect(screen.queryByText(/填写连接名称、Base URL、模型 ID 和 API Key/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /\+ 新增/ }))
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: 'First Provider' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-ant-secret' } })
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'claude-sonnet-4-6' } })
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.anthropic.com' } })

    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0)
    expect(screen.queryByText('sk-ant-secret')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    const patch: ProviderCatalogPatch = onSave.mock.calls[0][0]
    expect(patch.providers).toHaveLength(1)
    expect(patch.providers[0]).toMatchObject({
      name: 'First Provider',
      apiFormat: 'anthropic',
      endpoint: { baseUrl: 'https://api.anthropic.com' },
      model: { id: 'claude-sonnet-4-6', apiFormat: 'anthropic', enabled: true },
      defaults: { modelId: 'claude-sonnet-4-6' },
      adapters: {
        claudeCode: { enabled: true, permissionMode: 'default', useSettingsEnv: true }
      }
    })
    expect(patch.providers[0].auth.apiKey).toBe('sk-ant-secret')
  })

  it('shows readable save errors without leaking the draft API key', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Provider 不兼容 Claude Code，请改用 Anthropic API 格式'))
    renderEditor({ catalog: { version: 2, providers: [] }, onSave })

    fireEvent.click(screen.getByRole('button', { name: /\+ 新增/ }))
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: 'Broken Provider' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-ant-secret' } })
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'claude-sonnet-4-6' } })
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.example.com' } })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Provider 不兼容 Claude Code，请改用 Anthropic API 格式'))
    expect(screen.queryByText('sk-ant-secret')).not.toBeInTheDocument()
  })

  it('adds and removes model rows without displaying raw API keys', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({ onSave })

    expect(screen.getByLabelText('API Key')).toHaveValue('')
    expect(screen.queryByDisplayValue('sk-ant-secret')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '新增模型' }))
    const modelIds = screen.getAllByLabelText('Model ID') as HTMLInputElement[]
    fireEvent.change(modelIds[1], { target: { value: 'claude-sonnet-4-6' } })
    fireEvent.change((screen.getAllByLabelText('Model Display Name')[1] as HTMLInputElement), { target: { value: 'Sonnet' } })
    expect(screen.getAllByLabelText('Model ID')).toHaveLength(2)

    openAdvancedSettings()
    fireEvent.click(screen.getAllByRole('button', { name: '删除模型' })[0])
    expect(screen.getAllByLabelText('Model ID')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    const patch: ProviderCatalogPatch = onSave.mock.calls[0][0]
    expect(patch.providers[0].auth.apiKey).toBeUndefined()
    expect(patch.providers[0].models).toEqual([
      { id: 'claude-sonnet-4-6', displayName: 'Sonnet', apiFormat: 'anthropic', enabled: true }
    ])
  })
})
