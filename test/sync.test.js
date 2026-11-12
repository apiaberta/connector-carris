import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createSnapshot } from '../src/snapshot.js'
import { resetSyncGuards, syncStatic, syncVehicles } from '../src/sync.js'
import { normVehicle } from '../src/transform.js'

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    }
}

function recordingModel() {
    const writes = []
    return {
        writes,
        bulkWrite: async (ops) => {
            writes.push(ops.map(op => op.updateOne.filter.id))
            return { upsertedCount: ops.length, modifiedCount: 0 }
        },
        deleteMany: async () => ({ deletedCount: 0 })
    }
}

afterEach(() => resetSyncGuards())

describe('syncVehicles', () => {
    it('replaces the in-memory snapshot on success', async () => {
        const snapshot = createSnapshot()
        const fetchImpl = async () => jsonResponse(200, [
            { id: 'v1', line_id: '1101', lat: 38.7, lon: -9.1, timestamp: 1793118000000 }
        ])
        const result = await syncVehicles(null, { snapshot, fetchImpl, Vehicle: null, delay: async () => {} })
        assert.equal(result.n, 1)
        assert.equal(snapshot.stale, false)
        assert.equal(snapshot.vehicles.get('v1').line_id, '1101')
    })

    it('keeps the last good snapshot and sets stale on failure', async () => {
        const snapshot = createSnapshot()
        const previous = normVehicle({ id: 'old', line_id: '1001', lat: 1, lon: 2, timestamp: 1793118000000 })
        snapshot.vehicles.set(previous.id, previous)
        snapshot.stale = false
        snapshot.updatedAt = new Date('2026-10-27T15:00:00Z')

        const fetchImpl = async () => jsonResponse(502, { error: 'bad gateway' })
        const result = await syncVehicles(null, { snapshot, fetchImpl, Vehicle: null, retries: 2, delay: async () => {} })
        assert.equal(result.stale, true)
        assert.equal(snapshot.stale, true)
        assert.equal(snapshot.vehicles.get('old').line_id, '1001')
        assert.equal(snapshot.vehicles.size, 1)
    })

    it('does not overlap in-flight runs', async () => {
        const snapshot = createSnapshot()
        let release
        const fetchImpl = () => new Promise(resolve => {
            release = () => resolve(jsonResponse(200, []))
        })
        const first = syncVehicles(null, { snapshot, fetchImpl, Vehicle: null })
        const second = await syncVehicles(null, { snapshot, fetchImpl, Vehicle: null })
        assert.equal(second.skipped, true)
        release()
        const done = await first
        assert.equal(done.n, 0)
    })

    it('bulkWrites only new or moved vehicles when persist=changed', async () => {
        const snapshot = createSnapshot()
        const Vehicle = recordingModel()
        const seen = 1793118000000
        const payload = [
            { id: 'parked', line_id: '1101', lat: 38.7, lon: -9.1, bearing: 90, timestamp: seen },
            { id: 'mover', line_id: '1101', lat: 38.7, lon: -9.1, bearing: 90, timestamp: seen }
        ]
        await syncVehicles(null, {
            snapshot,
            fetchImpl: async () => jsonResponse(200, payload),
            Vehicle,
            persistVehicles: 'changed',
            delay: async () => {}
        })
        assert.equal(Vehicle.writes.length, 1)
        assert.deepEqual(Vehicle.writes[0].sort(), ['mover', 'parked'])

        Vehicle.writes.length = 0
        const moved = [
            { id: 'parked', line_id: '1101', lat: 38.7, lon: -9.1, bearing: 90, timestamp: seen + 30_000 },
            { id: 'mover', line_id: '1101', lat: 38.71, lon: -9.1, bearing: 91, timestamp: seen + 30_000 }
        ]
        const result = await syncVehicles(null, {
            snapshot,
            fetchImpl: async () => jsonResponse(200, moved),
            Vehicle,
            persistVehicles: 'changed',
            delay: async () => {}
        })
        assert.equal(result.written, 1)
        assert.equal(result.skipped, 1)
        assert.deepEqual(Vehicle.writes, [['mover']])
        assert.equal(snapshot.vehicles.get('parked').lat, 38.7)
        assert.equal(snapshot.vehicles.get('mover').lat, 38.71)
    })

    it('skips Mongo entirely when persist=off', async () => {
        const snapshot = createSnapshot()
        const Vehicle = recordingModel()
        await syncVehicles(null, {
            snapshot,
            fetchImpl: async () => jsonResponse(200, [{ id: 'v1', lat: 1, lon: 2, timestamp: 1 }]),
            Vehicle,
            persistVehicles: 'off',
            delay: async () => {}
        })
        assert.equal(Vehicle.writes.length, 0)
        assert.equal(snapshot.vehicles.size, 1)
    })

    it('upserts every vehicle when persist=all', async () => {
        const snapshot = createSnapshot()
        const Vehicle = recordingModel()
        const body = () => [
            { id: 'a', lat: 1, lon: 2, timestamp: 1 },
            { id: 'b', lat: 3, lon: 4, timestamp: 1 }
        ]
        await syncVehicles(null, {
            snapshot,
            fetchImpl: async () => jsonResponse(200, body()),
            Vehicle,
            persistVehicles: 'all',
            delay: async () => {}
        })
        Vehicle.writes.length = 0
        await syncVehicles(null, {
            snapshot,
            fetchImpl: async () => jsonResponse(200, body()),
            Vehicle,
            persistVehicles: 'all',
            delay: async () => {}
        })
        assert.deepEqual(Vehicle.writes[0].sort(), ['a', 'b'])
    })
})

describe('syncStatic', () => {
    it('fetches stops then lines and bulkWrites in batches', async () => {
        const Stop = recordingModel()
        const Line = recordingModel()
        const urls = []
        let inFlight = 0
        let maxInFlight = 0
        const fetchImpl = async (url) => {
            urls.push(url)
            inFlight++
            maxInFlight = Math.max(maxInFlight, inFlight)
            await Promise.resolve()
            inFlight--
            if (url.includes('/stops')) {
                return jsonResponse(200, [
                    { id: 's1', name: 'A', lat: 1, lon: 2 },
                    { id: 's2', name: 'B', lat: 1, lon: 2 },
                    { id: 's3', name: 'C', lat: 1, lon: 2 }
                ])
            }
            return jsonResponse(200, [
                { id: 'l1', short_name: '1' },
                { id: 'l2', short_name: '2' }
            ])
        }
        const result = await syncStatic(null, {
            fetchImpl,
            Stop,
            Line,
            batchSize: 2,
            delay: async () => {}
        })
        assert.equal(maxInFlight, 1)
        assert.ok(urls[0].includes('/stops'))
        assert.ok(urls[1].includes('/lines'))
        assert.equal(result.stops.n, 3)
        assert.equal(result.lines.n, 2)
        assert.deepEqual(Stop.writes, [['s1', 's2'], ['s3']])
        assert.deepEqual(Line.writes, [['l1', 'l2']])
    })
})
