import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    VEHICLES_POLL_MS_DEFAULT,
    VEHICLES_POLL_MS_MAX,
    VEHICLES_POLL_MS_MIN,
    VERSION,
    parseVehiclesPersist,
    parseVehiclesPollMs,
    parseVehiclesSnapshotMax,
    parseVehiclesSnapshotTtlMs
} from '../src/config.js'

describe('VERSION', () => {
    it('is the 1.1 minor bump', () => {
        assert.equal(VERSION, '1.1.0')
    })
})

describe('parseVehiclesPollMs', () => {
    it('defaults to 90s', () => {
        assert.equal(parseVehiclesPollMs(undefined), VEHICLES_POLL_MS_DEFAULT)
        assert.equal(parseVehiclesPollMs(''), VEHICLES_POLL_MS_DEFAULT)
        assert.equal(parseVehiclesPollMs('nope'), VEHICLES_POLL_MS_DEFAULT)
    })

    it('clamps to 60–120s', () => {
        assert.equal(parseVehiclesPollMs('1000'), VEHICLES_POLL_MS_MIN)
        assert.equal(parseVehiclesPollMs('30000'), VEHICLES_POLL_MS_MIN)
        assert.equal(parseVehiclesPollMs('999999'), VEHICLES_POLL_MS_MAX)
        assert.equal(parseVehiclesPollMs('75000'), 75_000)
        assert.equal(parseVehiclesPollMs('120000'), 120_000)
        assert.equal(parseVehiclesPollMs('60000'), 60_000)
    })
})

describe('parseVehiclesPersist', () => {
    it('accepts changed, all, off and defaults to changed', () => {
        assert.equal(parseVehiclesPersist(undefined), 'changed')
        assert.equal(parseVehiclesPersist('ALL'), 'all')
        assert.equal(parseVehiclesPersist(' off '), 'off')
        assert.equal(parseVehiclesPersist('changed'), 'changed')
        assert.equal(parseVehiclesPersist('nope'), 'changed')
    })
})

describe('snapshot env parsers', () => {
    it('falls back on invalid values', () => {
        assert.equal(parseVehiclesSnapshotMax(''), 4000)
        assert.equal(parseVehiclesSnapshotMax('2500'), 2500)
        assert.equal(parseVehiclesSnapshotTtlMs('0'), 600_000)
        assert.equal(parseVehiclesSnapshotTtlMs('120000'), 120_000)
    })
})
