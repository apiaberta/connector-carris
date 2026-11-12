import {
    parseVehiclesSnapshotMax,
    parseVehiclesSnapshotTtlMs
} from './config.js'

export function createSnapshot({
    maxVehicles = parseVehiclesSnapshotMax(),
    ttlMs = parseVehiclesSnapshotTtlMs()
} = {}) {
    return {
        vehicles: new Map(),
        maxVehicles,
        ttlMs,
        updatedAt: null,
        stale: false,
        lastVehiclesSync: null,
        lastAlertsSync: null,
        lastStaticSync: null,
        alertsStale: false,
        staticStale: false,
        lastError: null
    }
}

function numEq(a, b) {
    if (a == null && b == null) return true
    if (a == null || b == null) return false
    return Math.abs(Number(a) - Number(b)) < 1e-6
}

/**
 * True when a vehicle's public position/assignment changed.
 * Ignores timestamp and seen_at so a parked bus does not rewrite Mongo
 * every poll (upstream often ticks timestamp on a stationary vehicle).
 */
export function vehicleChanged(prev, next) {
    if (!prev) return true
    return prev.line_id !== next.line_id
        || prev.route_id !== next.route_id
        || prev.pattern_id !== next.pattern_id
        || prev.trip_id !== next.trip_id
        || prev.stop_id !== next.stop_id
        || prev.current_status !== next.current_status
        || prev.occupancy_status !== next.occupancy_status
        || prev.door_status !== next.door_status
        || !numEq(prev.lat, next.lat)
        || !numEq(prev.lon, next.lon)
        || !numEq(prev.bearing, next.bearing)
}

export function pruneVehicles(map, { max, ttlMs, now = Date.now() } = {}) {
    if (!map) return map
    if (ttlMs > 0) {
        for (const [id, v] of map) {
            const seen = v?.seen_at instanceof Date
                ? v.seen_at.getTime()
                : (v?.seen_at != null ? Number(v.seen_at) : NaN)
            if (Number.isFinite(seen) && now - seen > ttlMs) map.delete(id)
        }
    }
    if (max > 0) {
        while (map.size > max) {
            const oldest = map.keys().next().value
            map.delete(oldest)
        }
    }
    return map
}

export function replaceVehicles(snapshot, next, seenAt) {
    pruneVehicles(next, {
        max: snapshot.maxVehicles,
        ttlMs: snapshot.ttlMs,
        now: seenAt instanceof Date ? seenAt.getTime() : Date.now()
    })
    snapshot.vehicles = next
    snapshot.updatedAt = seenAt
    snapshot.stale = false
    snapshot.lastVehiclesSync = seenAt
    snapshot.lastError = null
    return next
}
