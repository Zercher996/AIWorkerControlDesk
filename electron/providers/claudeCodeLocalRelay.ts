import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { listenOnFetchSafeLocalhost } from './localRelayPort'

export type ClaudeCodeLocalRelay = {
  baseUrl: string
  close(): void
}

type StartClaudeCodeLocalRelayInput = {
  upstreamBaseUrl: string
  apiKey: string
}

// ---- Request translation: Anthropic → OpenAI ----

interface AnthropicMessage {
  role: string
  content: string | Array<{ type: string; text?: string }>
}

interface AnthropicRequest {
  model: string
  max_tokens: number
  system?: string
  messages: AnthropicMessage[]
  stream: boolean
}

function anthropicToOpenAIRequest(req: AnthropicRequest, apiKey: string): { url: string; body: string; headers: Record<string, string> } {
  const messages: AnthropicMessage[] = []

  // Prepend system prompt as a system message
  if (req.system) {
    messages.push({ role: 'system', content: req.system })
  }

  // Flatten multi-block content into plain text
  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      messages.push(msg)
    } else if (Array.isArray(msg.content)) {
      const text = msg.content.map((block) => block.type === 'text' ? (block.text ?? '') : '').join('\n')
      messages.push({ role: msg.role, content: text })
    }
  }

  const body = JSON.stringify({
    model: req.model,
    max_tokens: req.max_tokens,
    messages,
    stream: req.stream,
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  }

  return { url: '/v1/chat/completions', body, headers }
}

// ---- Server startup ----

export async function startClaudeCodeLocalRelay(input: StartClaudeCodeLocalRelayInput): Promise<ClaudeCodeLocalRelay> {
  const upstreamBaseUrl = input.upstreamBaseUrl.replace(/\/$/, '')
  const apiKey = input.apiKey

  const server = createServer((request, response) => {
    void handleRequest({ request, response, upstreamBaseUrl, apiKey })
  })

  const port = await listenOnFetchSafeLocalhost(server, 'Failed to start Claude Code local relay')

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => server.close()
  }
}

// ---- Request handler ----

async function handleRequest(input: {
  request: IncomingMessage
  response: ServerResponse
  upstreamBaseUrl: string
  apiKey: string
}): Promise<void> {
  const { request, response, upstreamBaseUrl, apiKey } = input
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname

  // Only support /v1/messages (Anthropic streaming endpoint)
  if (path !== '/v1/messages') {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Claude Code relay route not found', type: 'not_found' } }))
    return
  }

  try {
    // Read request body
    const body = await readBody(request)
    const anthropicReq: AnthropicRequest = JSON.parse(body)

    // Translate to OpenAI format
    const { url, body: openAiBody, headers } = anthropicToOpenAIRequest(anthropicReq, apiKey)

    // Forward to upstream
    const upstream = await fetch(`${upstreamBaseUrl}${url}`, {
      method: 'POST',
      headers,
      body: openAiBody,
    })

    // Set up streaming response headers
    const upstreamHeaders = sanitizeResponseHeaders(upstream.headers)
    response.writeHead(upstream.status, {
      ...upstreamHeaders,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    })

    if (!upstream.body) {
      response.end()
      return
    }

    // Translate OpenAI SSE → Anthropic SSE → stream-json
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let blockIndex = 0
    let activeBlock: 'text' | 'thinking' | undefined

    writeSse(response, 'message_start', { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', content: [], stop_reason: null } })

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() ?? ''

        for (const rawLine of lines) {
          const line = rawLine.trim()
          if (!line.startsWith('data: ')) continue

          const jsonStr = line.slice('data: '.length)
          if (jsonStr === '[DONE]') {
            if (activeBlock) {
              writeSse(response, 'content_block_stop', { type: 'content_block_stop', index: blockIndex })
              activeBlock = undefined
            }
            writeSse(response, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })
            writeSse(response, 'message_stop', { type: 'message_stop' })
            continue
          }

          try {
            const chunk = JSON.parse(jsonStr)
            const choice = chunk.choices?.[0]
            const delta = choice?.delta
            const finishReason = choice?.finish_reason
            if (finishReason === 'length' || finishReason === 'stop') {
              if (activeBlock) {
                writeSse(response, 'content_block_stop', { type: 'content_block_stop', index: blockIndex })
                activeBlock = undefined
              }
              writeSse(response, 'message_delta', { type: 'message_delta', delta: { stop_reason: finishReason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })
              writeSse(response, 'message_stop', { type: 'message_stop' })
              continue
            }
            if (!delta) continue

            const thinking = delta.reasoning_content
            if (typeof thinking === 'string' && thinking.length > 0) {
              if (activeBlock !== 'text') {
                if (activeBlock) {
                  writeSse(response, 'content_block_stop', { type: 'content_block_stop', index: blockIndex })
                  blockIndex++
                }
                writeSse(response, 'content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } })
                activeBlock = 'text'
              }
              writeSse(response, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: thinking } })
            }

            const content = delta.content
            if (typeof content === 'string' && content.length > 0) {
              if (activeBlock !== 'text') {
                if (activeBlock) {
                  writeSse(response, 'content_block_stop', { type: 'content_block_stop', index: blockIndex })
                  blockIndex++
                }
                writeSse(response, 'content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } })
                activeBlock = 'text'
              }
              writeSse(response, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: content } })
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
      response.end()
    } finally {
      reader.releaseLock()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'application/json' })
    }
    response.end(JSON.stringify({ error: { message, type: 'relay_error' } }))
  }
}

function writeSse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\n`)
  response.write(`data: ${JSON.stringify(data)}\n\n`)
}

function sanitizeResponseHeaders(upstreamHeaders: Headers): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of upstreamHeaders.entries()) {
    const normalized = key.toLowerCase()
    if (normalized === 'content-encoding' || normalized === 'content-length' || normalized === 'transfer-encoding') continue
    headers[key] = value
  }
  return headers
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}