/**
 * In-process TTL + LRU cache. Get still returns expired entries so callers
 * can serve last-good data with a stale flag when upstream is down.
 */
export class TtlLruCache {
  constructor({ max = 2000, ttlMs = 20_000 } = {}) {
    this.max = max
    this.ttlMs = ttlMs
    this.map = new Map()
  }

  get(key) {
    const entry = this.map.get(key)
    if (!entry) return undefined
    this.map.delete(key)
    this.map.set(key, entry)
    return {
      value: entry.value,
      storedAt: entry.storedAt,
      stale: Date.now() - entry.storedAt > this.ttlMs
    }
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, storedAt: Date.now() })
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
  }

  get size() {
    return this.map.size
  }
}
