import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, expect, it, afterEach } from 'vitest'
import { startClaudeCodeLocalRelay } from './claudeCodeLocalRelay'
import { listenOnFetchSafeLocalhost } from './localRelayPort'

type TestServer = {
  baseUrl: string
  close(): void
}

async function startOpenAiSseUpstream(handler: (request: IncomingMessage, body: string, response: ServerResponse) => void): Promise<TestServer> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    handler(request, Buffer.concat(chunks).toString('utf8'), response)
  })

  const port = await listenOnFetchSafeLocalhost(server, 'failed to start test upstream')

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => server.close()
  }
}

async function readText(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const chunks: string[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(new TextDecoder().decode(value, { stream: true }))
    }
  } finally {
    reader.releaseLock()
  }
  return chunks.join('')
}

describe('claudeCodeLocalRelay', () => {
  let relay: { baseUrl: string; close: () => void } | null = null
  let upstream: TestServer | null = null

  afterEach(() => {
    relay?.close()
    upstream?.close()
    relay = null
    upstream = null
  })

  it('strips upstream compression and length headers', async () => {
    const upstreamHeaders = new Headers({
      'content-type': 'text/event-stream',
      'content-encoding': 'zstd',
      'content-length': '999',
      'transfer-encoding': 'chunked',
      'x-request-id': 'req-1'
    })

    const sanitized: Record<string, string> = {}
    for (const [key, value] of upstreamHeaders.entries()) {
      const normalized = key.toLowerCase()
      if (normalized === 'content-encoding' || normalized === 'content-length' || normalized === 'transfer-encoding') continue
      sanitized[key] = value
    }

    expect(sanitized).toEqual({
      'content-type': 'text/event-stream',
      'x-request-id': 'req-1'
    })
  })

  it('forwards non-/v1/messages paths as 404', async () => {
    upstream = await startOpenAiSseUpstream(() => undefined)
    relay = await startClaudeCodeLocalRelay({
      upstreamBaseUrl: upstream.baseUrl,
      apiKey: 'sk-test'
    })

    const res = await fetch(`${relay.baseUrl}/v1/models`, {
      method: 'GET'
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.type).toBe('not_found')
  })

  it('forwards Anthropic /v1/messages to OpenAI /v1/chat/completions upstream', async () => {
    let capturedPath = ''
    let capturedAuth = ''
    let capturedBody: Record<string, unknown> | undefined
    upstream = await startOpenAiSseUpstream((request, body, response) => {
      capturedPath = request.url ?? ''
      capturedAuth = request.headers.authorization ?? ''
      capturedBody = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        'data: {"choices":[{"delta":{"content":"pong"}}]}',
        '',
        'data: [DONE]',
        '',
        ''
      ].join('\n'))
    })
    relay = await startClaudeCodeLocalRelay({
      upstreamBaseUrl: upstream.baseUrl,
      apiKey: 'sk-test'
    })

    const res = await fetch(`${relay.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-test',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'mimo-v2.5',
        max_tokens: 20,
        stream: true,
        system: 'system prompt',
        messages: [{ role: 'user', content: 'ping' }]
      })
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(capturedPath).toBe('/v1/chat/completions')
    expect(capturedAuth).toBe('Bearer sk-test')
    expect(capturedBody).toEqual({
      model: 'mimo-v2.5',
      max_tokens: 20,
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'ping' }
      ],
      stream: true
    })
    const text = await readText(res)
    expect(text).toContain('event: message_start')
    expect(text).toContain('event: content_block_start')
    expect(text).toContain('"text":"pong"')
    expect(text).toContain('event: message_stop')
  })

  it('includes reasoning_content as text output for Claude Code compatibility', async () => {
    upstream = await startOpenAiSseUpstream((_request, _body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"pong"}}]}',
        '',
        'data: [DONE]',
        '',
        ''
      ].join('\n'))
    })
    relay = await startClaudeCodeLocalRelay({
      upstreamBaseUrl: upstream.baseUrl,
      apiKey: 'sk-test'
    })

    const res = await fetch(`${relay.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-test',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'mimo-v2.5',
        max_tokens: 50,
        stream: true,
        messages: [{ role: 'user', content: 'reply only with pong' }]
      })
    })

    const text = await readText(res)
    expect(text).toContain('event: content_block_start')
    expect(text).toContain('event: message_stop')
    expect(text).toContain('"type":"text"')
    expect(text).toContain('"text":"thinking"')
  })
})
