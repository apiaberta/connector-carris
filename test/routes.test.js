import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TtlLruCache } from '../src/cache.js'
import { buildApp, createSnapshot } from '../src/index.js'
import { normVehicle } from '../src/transform.js'

const dir = dirname(fileURLToPath(import.meta.url))
const vehicles = JSON.parse(readFileSync(join(dir, 'fixtures/vehicles.json'), 'utf8'))

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  }
}

function stubModels({ stop = null } = {}) {
  return {
    Vehicle: {
      find: () => ({ lean: async () => [] }),
      findOne: () => ({ lean: async () => null }),
      countDocuments: async () => 0
    },
    Alert: {
      find: () => ({
        sort() { return this },
        skip() { return this },
        limit() { return this },
        lean: async () => []
      }),
      countDocuments: async () => 0
    },
    Stop: {
      findOne: async ({ id }) => (stop && stop.id === id ? stop : null),
      find: () => ({
        skip() { return this },
        limit() { return this },
        lean: async () => []
      }),
      countDocuments: async () => 0
    },
    Line: {
      findOne: async () => null,
      find: () => ({
        select() { return this },
        sort() { return this },
        skip() { return this },
        limit() { return this },
        lean: async () => []
      }),
      countDocuments: async () => 0
    }
  }
}

function loadedSnapshot() {
  const snapshot = createSnapshot()
  const seenAt = new Date('2026-10-27T16:00:00Z')
  for (const raw of vehicles) {
    const v = normVehicle(raw, seenAt)
    snapshot.vehicles.set(v.id, v)
  }
  snapshot.updatedAt = seenAt
  snapshot.lastVehiclesSync = seenAt
  snapshot.stale = false
  return snapshot
}

async function makeApp(overrides = {}) {
  const app = await buildApp({
    snapshot: loadedSnapshot(),
    fetchImpl: async () => jsonResponse(502, { error: 'nope' }),
    models: stubModels(),
    logger: false,
    delay: async () => {},
    ...overrides
  })
  return app
}

describe('routes', () => {
  it('GET /health is ok even when upstream is down', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/health' })
      assert.equal(res.statusCode, 200)
      const body = res.json()
      assert.equal(body.status, 'ok')
      assert.equal(body.service, 'connector-carris')
      assert.equal(body.version, '1.0.0')
      assert.ok(body.timestamp)
    } finally {
      await app.close()
    }
  })

  it('GET /carris/vehicles?line_id= filters the in-memory snapshot', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/carris/vehicles?line_id=1101' })
      assert.equal(res.statusCode, 200)
      const body = res.json()
      assert.equal(body.count, 2)
      assert.equal(body.stale, false)
      assert.ok(body.updated_at)
      assert.deepEqual(body.data.map(v => v.id).sort(), ['[44]4004', '[BNA17]2532'].sort())
      assert.ok(body.data.every(v => v.line_id === '1101'))
      assert.equal(body.data[0].door_status, undefined)
    } finally {
      await app.close()
    }
  })

  it('marks vehicles stale when the last snapshot refresh failed', async () => {
    const snapshot = loadedSnapshot()
    snapshot.stale = true
    const app = await makeApp({ snapshot })
    try {
      const res = await app.inject({ method: 'GET', url: '/carris/vehicles' })
      assert.equal(res.statusCode, 200)
      assert.equal(res.json().stale, true)
      assert.ok(res.json().count > 0)
    } finally {
      await app.close()
    }
  })

  it('GET /carris/vehicles/:id returns 404 when missing', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/carris/vehicles/does-not-exist' })
      assert.equal(res.statusCode, 404)
      assert.deepEqual(res.json(), { error: 'Not found' })
    } finally {
      await app.close()
    }
  })

  it('maps 5xx arrivals upstream to 503 when there is no cache', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls++
      return jsonResponse(502, { error: 'bad gateway' })
    }
    const app = await makeApp({ fetchImpl })
    try {
      const res = await app.inject({ method: 'GET', url: '/carris/stops/010001/arrivals' })
      assert.equal(res.statusCode, 503)
      assert.deepEqual(res.json(), { error: 'Upstream unavailable', retry_after: 30 })
      assert.ok(calls >= 2, 'should retry 5xx')
    } finally {
      await app.close()
    }
  })

  it('serves last good arrivals with stale=true after upstream 5xx', async () => {
    const arrivalsCache = new TtlLruCache({ max: 10, ttlMs: 1 })
    arrivalsCache.set('010001', {
      stop_id: '010001',
      updated_at: '2026-10-27T16:00:00.000Z',
      realtime_available: true,
      stale: false,
      data: [{ line_id: '1101', minutes: 3 }]
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    const fetchImpl = async () => jsonResponse(502, [])
    const app = await makeApp({ fetchImpl, arrivalsCache })
    try {
      const res = await app.inject({ method: 'GET', url: '/carris/stops/010001/arrivals' })
      assert.equal(res.statusCode, 200)
      const body = res.json()
      assert.equal(body.stale, true)
      assert.equal(body.data[0].line_id, '1101')
    } finally {
      await app.close()
    }
  })

  it('GET /carris/stops/:id/arrivals returns 404 for unknown stops (upstream 400)', async () => {
    const fetchImpl = async () => jsonResponse(400, [])
    const app = await makeApp({ fetchImpl, models: stubModels({ stop: null }) })
    try {
      const res = await app.inject({ method: 'GET', url: '/carris/stops/unknown/arrivals' })
      assert.equal(res.statusCode, 404)
      assert.deepEqual(res.json(), { error: 'Not found' })
    } finally {
      await app.close()
    }
  })

  it('GET /carris/stops/:id/arrivals returns empty data when the stop exists but upstream is 400', async () => {
    const fetchImpl = async () => jsonResponse(400, [])
    const app = await makeApp({
      fetchImpl,
      models: stubModels({ stop: { id: '010001', name: 'Marquês de Pombal', line_ids: [] } })
    })
    try {
      const res = await app.inject({ method: 'GET', url: '/carris/stops/010001/arrivals' })
      assert.equal(res.statusCode, 200)
      const body = res.json()
      assert.deepEqual(body.data, [])
      assert.equal(body.stop_id, '010001')
    } finally {
      await app.close()
    }
  })
})
