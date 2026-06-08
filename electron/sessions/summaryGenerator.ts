import Anthropic from '@anthropic-ai/sdk'
import type { ProviderProfile, Session } from '../../src/types/workerDesk'
import { resolveProviderModel, validateProviderForSummary } from '../providers/providerValidation'

const SUMMARY_SYSTEM_PROMPT = `请根据 Claude Code Session 输出生成中文总结。

要求：
1. 只总结输出中能确认的事实。
2. 不猜测未出现的文件、命令或结果。
3. 明确列出目标、完成内容、关键文件、验证结果和后续建议。
4. 如果输出中没有验证结果，写「未看到验证结果」。
5. 不输出密钥、token 或敏感环境变量值。`

export type SummaryGenerator = ReturnType<typeof createSummaryGenerator>

type SummaryMessage = {
  content: Array<{ type: string; text?: string }>
}

type SummaryClient = {
  messages: {
    create(input: Anthropic.MessageCreateParams): Promise<SummaryMessage>
  }
}

type CreateClientInput = {
  apiKey?: string
  authToken?: string
  baseURL?: string
}

/**
 * Source of the output content for summarization.
 *
 * - `desk-session`: the request came from a Desk Session card with no bound
 *    cliSessionId (e.g. GenericAgent, or claude-code where mtime matching failed).
 *    Output is read from the Desk Session's PTY chunk store. Optional `session`
 *    metadata enriches the prompt.
 * - `cli-session`: the request came from a CLI history card (which is now the
 *    primary list). Output is read from the CC-generated jsonl. We do not have
 *    Desk Session metadata, only the cliSessionId itself.
 */
type SummarySource =
  | { kind: 'desk-session'; deskSessionId: string }
  | { kind: 'cli-session'; cliSessionId: string; projectId: string }

type SummaryGeneratorDeps = {
  getSession(deskSessionId: string): Promise<Session>
  getProviderProfile(providerId: string): Promise<ProviderProfile>
  readDeskOutputTail(deskSessionId: string): Promise<string>
  readCliOutputTail(cliSessionId: string, projectId: string): Promise<string>
  /**
   * Persist the generated summary under a unified key:
   *   - `cliSessionId` when bound (CLI history sessions, or Desk Sessions whose
   *     CC jsonl was matched on exit). This makes summaries written via either
   *     entry point converge to the same file.
   *   - Fall back to Desk Session id otherwise.
   */
  writeSummary(primaryKey: string, summary: string): Promise<void>
  createClient?: (input: CreateClientInput) => SummaryClient
}

export function createSummaryGenerator(deps: SummaryGeneratorDeps) {
  const createClient = deps.createClient ?? ((input) => new Anthropic({
    apiKey: input.apiKey ?? null,
    authToken: input.authToken ?? null,
    baseURL: input.baseURL ?? null
  }))

  return {
    /**
     * Generate a Summary for either a Desk Session or a CLI history session.
     * Caller picks the source via `SummarySource`; the returned summary is
     * persisted under the unified primaryKey (cliSessionId preferred).
     */
    async generateSummary(source: SummarySource, providerProfileId: string, providerModelId?: string): Promise<string> {
      const provider = await deps.getProviderProfile(providerProfileId)
      if (!provider.auth.apiKey) {
        throw new Error(`Provider ${provider.id} missing API key`)
      }
      const model = resolveProviderModel(provider, providerModelId, 'summary')
      validateProviderForSummary(provider, model)
      if (source.kind === 'desk-session') {
        const session = await deps.getSession(source.deskSessionId)
        const output = await deps.readDeskOutputTail(source.deskSessionId)
        const summary = await generateWithProvider(provider, model.id, buildDeskSummaryPrompt(session, output))
        // primaryKey rule: if the desk session is bound to a cliSessionId, store
        // there so a future "summary regenerated from CLI history card" lands on
        // the same file; otherwise fall back to the desk session id.
        const primaryKey = session.cliSessionId ?? session.id
        await deps.writeSummary(primaryKey, summary)
        return summary
      }
      const output = await deps.readCliOutputTail(source.cliSessionId, source.projectId)
      const summary = await generateWithProvider(provider, model.id, buildCliSummaryPrompt(source.cliSessionId, output))
      await deps.writeSummary(source.cliSessionId, summary)
      return summary
    }
  }

  async function generateWithProvider(provider: ProviderProfile, modelId: string, prompt: string): Promise<string> {
    const apiKeyEnv = provider.adapters?.claudeCode?.apiKeyEnv
      ?? (provider.protocol === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN')
    const apiKey = apiKeyEnv === 'ANTHROPIC_API_KEY' ? provider.auth.apiKey : undefined
    const authToken = apiKeyEnv === 'ANTHROPIC_AUTH_TOKEN' ? provider.auth.apiKey : undefined
    if (!apiKey && !authToken) {
      throw new Error(`Provider ${provider.id} missing API key`)
    }

    const client = createClient({ apiKey, authToken, baseURL: provider.endpoint.baseUrl })
    let response: unknown
    try {
      response = await client.messages.create({
        model: modelId,
        max_tokens: 4096,
        system: [{ type: 'text' as const, text: SUMMARY_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' as const } }],
        messages: [{ role: 'user' as const, content: prompt }]
      })
    } catch (err) {
      throw sanitizeError(err, provider)
    }

    return extractTextFromResponse(response)
  }
}

function extractTextFromResponse(response: unknown): string {
  const msg = response as { content?: Array<{ type: string; text?: string }> }
  if (!msg.content) return ''
  return msg.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!)
    .join('\n')
    .trim()
}

function buildDeskSummaryPrompt(session: Session, output: string): string {
  return `Session 标题：${session.title}
Session 状态：${session.status}
创建时间：${session.createdAt}
退出时间：${session.exitedAt ?? '未退出'}

以下是 Session 输出：

${output}`
}

function buildCliSummaryPrompt(cliSessionId: string, output: string): string {
  return `CLI Session ID：${cliSessionId}
Session 状态：exited

以下是 CLI Session 输出：

${output}`
}

function sanitizeError(err: unknown, provider: ProviderProfile): Error {
  const original = err instanceof Error ? err.message : String(err)
  if (original.includes('invalid_key') || original.includes('Invalid API Key')) {
    const error = new Error(`Provider ${provider.name} 的 API Key 无效，请检查模型连接配置`)
    if (err instanceof Error) {
      error.cause = err
    }
    return error
  }

  if (original.includes('rate_limit_error') || original.includes('usage limit exceeded')) {
    const error = new Error(`Provider ${provider.name} 的 API 使用额度已达上限，请稍后重试或切换模型连接`)
    if (err instanceof Error) {
      error.cause = err
    }
    return error
  }

  let sanitized = original
  const sensitiveValues = [
    provider.auth.apiKey,
    provider.endpoint.baseUrl
  ]
  for (const value of sensitiveValues) {
    if (value && value.length > 4) {
      sanitized = sanitized.replaceAll(value, '[REDACTED]')
    }
  }
  const error = new Error(sanitized)
  if (err instanceof Error) {
    error.cause = err
  }
  return error
}
