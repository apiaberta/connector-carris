import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { USER_AGENT } from '../src/config.js'
import { UpstreamError, fetchJson } from '../src/http.js'

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  }
}

describe('fetchJson', () => {
  it('sends the apiaberta User-Agent', async () => {
    const calls = []
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts })
      return jsonResponse(200, [{ id: 1 }])
    }
    const { data } = await fetchJson('https://example.test/v2/vehicles', { fetchImpl, delay: async () => {} })
    assert.deepEqual(data, [{ id: 1 }])
    assert.equal(calls[0].opts.headers['User-Agent'], USER_AGENT)
    assert.ok(calls[0].opts.signal)
  })

  it('retries 502 with backoff then succeeds', async () => {
    const statuses = []
    const delays = []
    const fetchImpl = async () => {
      const status = statuses.length === 0 ? 502 : 200
      statuses.push(status)
      return jsonResponse(status, status === 200 ? [1] : { error: 'bad gateway' })
    }
    const { data } = await fetchJson('https://example.test/x', {
      fetchImpl,
      retries: 3,
      delay: async (ms) => { delays.push(ms) }
    })
    assert.deepEqual(data, [1])
    assert.deepEqual(statuses, [502, 200])
    assert.deepEqual(delays, [250])
  })

  it('gives up after retrying 5xx', async () => {
    let n = 0
    const fetchImpl = async () => {
      n++
      return jsonResponse(502, [])
    }
    await assert.rejects(
      () => fetchJson('https://example.test/x', { fetchImpl, retries: 2, delay: async () => {} }),
      (err) => err instanceof UpstreamError && err.status === 502
    )
    assert.equal(n, 2)
  })

  it('does not retry HTTP 400', async () => {
    let n = 0
    const fetchImpl = async () => {
      n++
      return jsonResponse(400, [])
    }
    const { status, data } = await fetchJson('https://example.test/arrivals', {
      fetchImpl,
      retries: 3,
      delay: async () => { throw new Error('should not delay') }
    })
    assert.equal(status, 400)
    assert.deepEqual(data, [])
    assert.equal(n, 1)
  })

  it('retries timeouts', async () => {
    let n = 0
    const fetchImpl = async () => {
      n++
      if (n === 1) {
        const err = new Error('timeout')
        err.name = 'TimeoutError'
        throw err
      }
      return jsonResponse(200, { ok: true })
    }
    const { data } = await fetchJson('https://example.test/x', { fetchImpl, retries: 2, delay: async () => {} })
    assert.deepEqual(data, { ok: true })
    assert.equal(n, 2)
  })
})
