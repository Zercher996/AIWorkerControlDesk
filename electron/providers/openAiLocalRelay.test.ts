import { describe, expect, it } from 'vitest'
import { sanitizeResponseHeaders } from './openAiLocalRelay'

describe('openAiLocalRelay', () => {
  it('strips upstream compression headers after Node fetch decodes the response body', () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'content-encoding': 'zstd',
      'content-length': '999',
      'x-request-id': 'req-1'
    })

    expect(sanitizeResponseHeaders(headers)).toEqual({
      'content-type': 'application/json',
      'x-request-id': 'req-1'
    })
  })
})
