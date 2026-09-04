import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { request, AppError } from '../src/lib/api.js'

describe('frontend request helper', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('adds request id and returns JSON', async () => {
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: true }),
    })
    await expect(
      request('/api/ping', { headers: { 'x-test': 'yes' } }),
    ).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledWith(
      '/api/ping',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-request-id': expect.stringMatching(/^req-/),
          'x-test': 'yes',
        }),
      }),
    )
  })

  it('returns streams unchanged and maps HTTP errors', async () => {
    const stream = {
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    }
    fetch.mockResolvedValueOnce(stream)
    await expect(request('/api/stream')).resolves.toBe(stream)
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ code: 'BAD', message: 'invalid' }),
    })
    await expect(request('/api/fail')).rejects.toMatchObject({
      name: 'AppError',
      status: 400,
      code: 'BAD',
      message: 'invalid',
    })
    expect(AppError).toBeDefined()
  })
})
