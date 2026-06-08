export class ProviderError extends Error {
  payload: Record<string, unknown>

  constructor(message: string, payload: Record<string, unknown>) {
    super(message)
    this.name = 'ProviderError'
    this.payload = payload
  }
}
