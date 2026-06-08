import type { Server } from 'node:http'

const FETCH_SAFE_LOCAL_PORT_MIN = 49152
const FETCH_SAFE_LOCAL_PORT_MAX = 65535
const MAX_LOCAL_PORT_ATTEMPTS = 50

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87,
  95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139,
  143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548,
  554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659,
  4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697,
  10080
])

export function isFetchForbiddenPort(port: number): boolean {
  return FETCH_FORBIDDEN_PORTS.has(port)
}

export async function listenOnFetchSafeLocalhost(server: Server, failureMessage: string): Promise<number> {
  const attemptedPorts = new Set<number>()
  for (let attempt = 0; attempt < MAX_LOCAL_PORT_ATTEMPTS; attempt += 1) {
    const port = pickFetchSafeLocalPort(attemptedPorts)
    try {
      await listen(server, port)
    } catch (error) {
      if (isAddressInUse(error)) continue
      throw error
    }

    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error(failureMessage)
    }
    if (!isFetchForbiddenPort(address.port)) return address.port
    await close(server)
  }

  throw new Error(failureMessage)
}

function pickFetchSafeLocalPort(attemptedPorts: Set<number>): number {
  while (attemptedPorts.size < MAX_LOCAL_PORT_ATTEMPTS) {
    const port = FETCH_SAFE_LOCAL_PORT_MIN + Math.floor(Math.random() * (FETCH_SAFE_LOCAL_PORT_MAX - FETCH_SAFE_LOCAL_PORT_MIN + 1))
    if (attemptedPorts.has(port) || isFetchForbiddenPort(port)) continue
    attemptedPorts.add(port)
    return port
  }
  throw new Error('No fetch-safe local relay port candidates left')
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.listen(port, '127.0.0.1', onListening)
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
}
