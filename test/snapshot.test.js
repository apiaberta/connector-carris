import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSnapshot, pruneVehicles, replaceVehicles, vehicleChanged } from '../src/snapshot.js'
import { normVehicle } from '../src/transform.js'

const base = {
    id: 'v1',
    line_id: '1101',
    route_id: '1101_0',
    pattern_id: '1101_0_1',
    trip_id: 't-1',
    stop_id: '010001',
    lat: 38.7,
    lon: -9.1,
    bearing: 90,
    current_status: 'IN_TRANSIT_TO',
    occupancy_status: 'MANY_SEATS_AVAILABLE',
    door_status: 'CLOSED',
    timestamp: new Date('2026-11-12T22:00:00Z'),
    seen_at: new Date('2026-11-12T22:00:00Z')
}

describe('vehicleChanged', () => {
    it('is false when only timestamp/seen_at tick', () => {
        const next = {
            ...base,
            timestamp: new Date('2026-11-12T22:01:00Z'),
            seen_at: new Date('2026-11-12T22:01:00Z')
        }
        assert.equal(vehicleChanged(base, next), false)
    })

    it('is true for a new vehicle or a moved one', () => {
        assert.equal(vehicleChanged(null, base), true)
        assert.equal(vehicleChanged(base, { ...base, lat: 38.71 }), true)
        assert.equal(vehicleChanged(base, { ...base, line_id: '1001' }), true)
    })
})

describe('pruneVehicles', () => {
    it('drops entries older than the TTL', () => {
        const map = new Map()
        map.set('old', { id: 'old', seen_at: new Date('2026-11-12T21:00:00Z') })
        map.set('fresh', { id: 'fresh', seen_at: new Date('2026-11-12T22:00:00Z') })
        pruneVehicles(map, { max: 10, ttlMs: 60_000, now: Date.parse('2026-11-12T22:00:10Z') })
        assert.equal(map.has('old'), false)
        assert.equal(map.has('fresh'), true)
    })

    it('caps size in insertion order', () => {
        const map = new Map()
        map.set('a', { id: 'a', seen_at: new Date() })
        map.set('b', { id: 'b', seen_at: new Date() })
        map.set('c', { id: 'c', seen_at: new Date() })
        pruneVehicles(map, { max: 2, ttlMs: 60_000 })
        assert.equal(map.size, 2)
        assert.equal(map.has('a'), false)
        assert.equal([...map.keys()].join(','), 'b,c')
    })
})

describe('replaceVehicles', () => {
    it('installs the next map and clears stale', () => {
        const snapshot = createSnapshot({ maxVehicles: 2, ttlMs: 60_000 })
        snapshot.stale = true
        const seenAt = new Date('2026-11-12T22:00:00Z')
        const next = new Map()
        next.set('v1', normVehicle({ id: 'v1', lat: 1, lon: 2, timestamp: seenAt }, seenAt))
        next.set('v2', normVehicle({ id: 'v2', lat: 3, lon: 4, timestamp: seenAt }, seenAt))
        next.set('v3', normVehicle({ id: 'v3', lat: 5, lon: 6, timestamp: seenAt }, seenAt))
        replaceVehicles(snapshot, next, seenAt)
        assert.equal(snapshot.stale, false)
        assert.equal(snapshot.vehicles.size, 2)
        assert.equal(snapshot.updatedAt, seenAt)
        assert.equal(snapshot.vehicles.has('v1'), false)
        assert.equal(snapshot.vehicles.has('v3'), true)
    })
})
