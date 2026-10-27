import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createSnapshot } from '../src/snapshot.js'
import { resetSyncGuards, syncVehicles } from '../src/sync.js'
import { normVehicle } from '../src/transform.js'

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
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
})
