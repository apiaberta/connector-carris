import { USER_AGENT, FETCH_TIMEOUT_MS } from './config.js'

export class UpstreamError extends Error {
  constructor(message, { status = 0, url, cause } = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.url = url
    if (cause) this.cause = cause
  }
}

export function defaultDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isTimeout(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.code === 'ABORT_ERR'
}

function isRetryable(err) {
  if (!err) return false
  if (isTimeout(err)) return true
  if (err instanceof UpstreamError) {
    return err.status >= 500 || err.status === 429 || err.status === 0
  }
  const code = err.code || err.cause?.code
  return ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)
}

/**
 * Fetch JSON with timeouts and exponential backoff.
 * 4xx (except 429) is not retried; 400 is returned so callers can handle unknown stops.
 */
export async function fetchJson(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
  retries = 3,
  headers = {},
  delay = defaultDelay
} = {}) {
  const attempts = Math.max(1, retries)
  let lastErr

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(timeoutMs)
      })
      const status = res.status

      if (status === 400) {
        let data = []
        try { data = await res.json() } catch { data = [] }
        return { status, data }
      }

      if (!res.ok) {
        const err = new UpstreamError(`HTTP ${status} fetching ${url}`, { status, url })
        if (i < attempts - 1 && isRetryable(err)) {
          lastErr = err
          await delay(250 * 2 ** i)
          continue
        }
        throw err
      }

      const data = await res.json()
      return { status, data }
    } catch (err) {
      lastErr = err
      if (i < attempts - 1 && isRetryable(err)) {
        await delay(250 * 2 ** i)
        continue
      }
      throw err
    }
  }

  throw lastErr
}
