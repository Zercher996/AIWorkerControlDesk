import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { listenOnFetchSafeLocalhost } from './localRelayPort'

export type OpenAiLocalRelay = {
  baseUrl: string
  close(): void
}

type StartOpenAiLocalRelayInput = {
  upstreamBaseUrl: string
}

const ALLOWED_PATHS = new Set(['/v1/chat/completions', '/v1/responses', '/v1/models'])

export async function startOpenAiLocalRelay(input: StartOpenAiLocalRelayInput): Promise<OpenAiLocalRelay> {
  const upstreamBaseUrl = input.upstreamBaseUrl.replace(/\/$/, '')

  const server = createServer((request, response) => {
    void handleRequest({ request, response, upstreamBaseUrl })
  })

  const port = await listenOnFetchSafeLocalhost(server, 'Failed to start OpenAI local relay')

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => server.close()
  }
}

async function handleRequest(input: { request: IncomingMessage; response: ServerResponse; upstreamBaseUrl: string }): Promise<void> {
  const { request, response, upstreamBaseUrl } = input
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (!ALLOWED_PATHS.has(path)) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'OpenAI local relay route not found', type: 'not_found' } }))
    return
  }

  try {
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readBody(request)
    const upstream = await fetch(`${upstreamBaseUrl}${path}`, {
      method: request.method,
      headers: forwardHeaders(request),
      body
    })

    response.writeHead(upstream.status, sanitizeResponseHeaders(upstream.headers))
    if (!upstream.body) {
      response.end()
      return
    }

    const reader = upstream.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        response.write(Buffer.from(value))
      }
      response.end()
    } finally {
      reader.releaseLock()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    response.writeHead(502, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message, type: 'relay_error' } }))
  }
}

function forwardHeaders(request: IncomingMessage): HeadersInit {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    const normalized = key.toLowerCase()
    if (normalized === 'host' || normalized === 'content-length' || normalized === 'connection') continue
    headers[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return headers
}

export function sanitizeResponseHeaders(upstreamHeaders: Headers): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of upstreamHeaders.entries()) {
    const normalized = key.toLowerCase()
    if (normalized === 'content-encoding' || normalized === 'content-length') continue
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
