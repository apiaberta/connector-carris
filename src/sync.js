/**
 * sync.js — Carris Metropolitana data synchronisation
 * Vehicles: VEHICLES_POLL_MS (default 90s, 60–120s) | Alerts: every 5min
 * Stops+lines: daily 04:15 + startup, sequential batched bulkWrite
 *
 * Live vehicle positions are served from a bounded in-memory Map.
 * Mongo only gets new/moved vehicles (VEHICLES_PERSIST=changed) so a poll
 * does not rewrite the whole collection.
 *
 * Upstream is flaky (502/timeouts). Failures keep the last good snapshot
 * and never wipe stored data.
 */

import {
    BASE_URL,
    BULK_BATCH,
    FETCH_TIMEOUT_MS,
    LINES_SANITY_MIN,
    STOPS_SANITY_MIN,
    parseVehiclesPersist
} from './config.js'
import { fetchJson } from './http.js'
import { Alert } from './models/alert.js'
import { Line } from './models/line.js'
import { Stop } from './models/stop.js'
import { Vehicle } from './models/vehicle.js'
import { pruneVehicles, replaceVehicles, vehicleChanged } from './snapshot.js'
import { normAlert, normLine, normStop, normVehicle } from './transform.js'

let vehiclesInFlight = false
let alertsInFlight = false
let staticInFlight = false

function modelsOf(deps = {}) {
    return {
        Vehicle: 'Vehicle' in deps ? deps.Vehicle : Vehicle,
        Alert:   'Alert' in deps ? deps.Alert : Alert,
        Stop:    'Stop' in deps ? deps.Stop : Stop,
        Line:    'Line' in deps ? deps.Line : Line
    }
}

async function bulkInBatches(Model, ops, batchSize = BULK_BATCH) {
    if (!Model || ops.length === 0) return { upserted: 0, modified: 0 }
    let upserted = 0
    let modified = 0
    for (let i = 0; i < ops.length; i += batchSize) {
        const chunk = ops.slice(i, i + batchSize)
        const result = await Model.bulkWrite(chunk, { ordered: false })
        upserted += result.upsertedCount ?? 0
        modified += result.modifiedCount ?? 0
    }
    return { upserted, modified }
}

function vehicleUpsert(v) {
    return {
        updateOne: {
            filter: { id: v.id },
            update: { $set: v },
            upsert: true
        }
    }
}

export async function syncVehicles(logger, deps = {}) {
    if (vehiclesInFlight) return { skipped: true, reason: 'in-flight' }
    vehiclesInFlight = true
    const snapshot = deps.snapshot
    const { Vehicle: VehicleModel } = modelsOf(deps)
    const persist = deps.persistVehicles ?? parseVehiclesPersist()
    const batchSize = deps.batchSize ?? BULK_BATCH

    try {
        const { data } = await fetchJson(`${BASE_URL}/v2/vehicles`, {
            fetchImpl: deps.fetchImpl,
            timeoutMs: FETCH_TIMEOUT_MS,
            retries: deps.retries ?? 3,
            delay: deps.delay
        })
        if (!Array.isArray(data)) throw new Error('vehicles: expected array')

        const seenAt = new Date()
        const prev = snapshot?.vehicles
        const next = new Map()
        const ops = []
        const maxVehicles = snapshot?.maxVehicles ?? Infinity

        for (let i = 0; i < data.length; i++) {
            const v = normVehicle(data[i], seenAt)
            data[i] = null
            if (!v) continue
            if (next.size >= maxVehicles) continue
            next.set(v.id, v)
            if (persist === 'off' || !VehicleModel?.bulkWrite) continue
            if (persist === 'all' || vehicleChanged(prev?.get(v.id), v)) {
                ops.push(vehicleUpsert(v))
            }
        }
        data.length = 0

        if (snapshot) replaceVehicles(snapshot, next, seenAt)

        let mongo = { upserted: 0, modified: 0 }
        if (ops.length > 0 && VehicleModel?.bulkWrite) {
            try {
                mongo = await bulkInBatches(VehicleModel, ops, batchSize)
            } catch (err) {
                logger?.error({ err }, 'vehicles bulkWrite failed; in-memory snapshot kept')
            }
        }

        const written = ops.length
        logger?.info({ n: next.size, written, skipped: next.size - written, persist, ...mongo }, 'Vehicles sync complete')
        return { n: next.size, written, skipped: next.size - written, persist, ...mongo }
    } catch (err) {
        if (snapshot) {
            snapshot.stale = true
            snapshot.lastError = err.message
            pruneVehicles(snapshot.vehicles, {
                max: snapshot.maxVehicles,
                ttlMs: snapshot.ttlMs
            })
        }
        logger?.error({ err }, 'vehicles sync failed; keeping last snapshot')
        return { error: err.message, stale: true }
    } finally {
        vehiclesInFlight = false
    }
}

export async function syncAlerts(logger, deps = {}) {
    if (alertsInFlight) return { skipped: true, reason: 'in-flight' }
    alertsInFlight = true
    const snapshot = deps.snapshot
    const { Alert: AlertModel } = modelsOf(deps)
    const batchSize = deps.batchSize ?? BULK_BATCH

    try {
        const { data } = await fetchJson(`${BASE_URL}/v2/alerts`, {
            fetchImpl: deps.fetchImpl,
            timeoutMs: FETCH_TIMEOUT_MS,
            retries: deps.retries ?? 3,
            delay: deps.delay
        })
        if (!Array.isArray(data)) throw new Error('alerts: expected array')

        const seenAt = new Date()
        const ids = []
        const ops = []
        for (const raw of data) {
            const a = normAlert(raw, seenAt)
            if (!a) continue
            ids.push(a.alert_id)
            const { first_seen, ...rest } = a
            ops.push({
                updateOne: {
                    filter: { alert_id: a.alert_id },
                    update: {
                        $set: { ...rest, last_seen: seenAt, active: true },
                        $setOnInsert: { first_seen }
                    },
                    upsert: true
                }
            })
        }

        if (AlertModel?.bulkWrite) {
            await bulkInBatches(AlertModel, ops, batchSize)
            if (AlertModel.updateMany) {
                await AlertModel.updateMany(
                    { alert_id: { $nin: ids }, active: true },
                    { $set: { active: false } }
                )
            }
        }

        if (snapshot) {
            snapshot.lastAlertsSync = seenAt
            snapshot.alertsStale = false
        }

        logger?.info({ n: ids.length }, 'Alerts sync complete')
        return { n: ids.length }
    } catch (err) {
        if (snapshot) snapshot.alertsStale = true
        logger?.error({ err }, 'alerts sync failed; keeping last data')
        return { error: err.message, stale: true }
    } finally {
        alertsInFlight = false
    }
}

async function syncCollection({ url, Model, norm, sanityMin, logger, deps, label, batchSize }) {
    const { data } = await fetchJson(url, {
        fetchImpl: deps.fetchImpl,
        timeoutMs: FETCH_TIMEOUT_MS,
        retries: deps.retries ?? 3,
        delay: deps.delay
    })
    if (!Array.isArray(data)) throw new Error(`${label}: expected array`)

    const syncedAt = new Date()
    let n = 0
    let mongo = { upserted: 0, modified: 0 }
    const batch = []

    async function flush() {
        if (!Model?.bulkWrite || batch.length === 0) {
            batch.length = 0
            return
        }
        const result = await Model.bulkWrite(batch, { ordered: false })
        mongo.upserted += result.upsertedCount ?? 0
        mongo.modified += result.modifiedCount ?? 0
        batch.length = 0
    }

    for (let i = 0; i < data.length; i++) {
        const doc = norm(data[i], syncedAt)
        data[i] = null
        if (!doc) continue
        n++
        batch.push({
            updateOne: {
                filter: { id: doc.id },
                update: { $set: doc },
                upsert: true
            }
        })
        if (batch.length >= batchSize) await flush()
    }
    await flush()
    data.length = 0

    let deleted = 0
    if (Model?.bulkWrite) {
        if (n > sanityMin && Model.deleteMany) {
            const result = await Model.deleteMany({ synced_at: { $lt: syncedAt } })
            deleted = result.deletedCount ?? 0
        } else if (n <= sanityMin) {
            logger?.warn({ n, sanityMin }, `${label}: skip stale delete (sanity guard)`)
        }
    }

    logger?.info({ n, deleted, ...mongo }, `${label} sync complete`)
    return { n, deleted, ...mongo }
}

export async function syncStatic(logger, deps = {}) {
    if (staticInFlight) return { skipped: true, reason: 'in-flight' }
    staticInFlight = true
    const snapshot = deps.snapshot
    const { Stop: StopModel, Line: LineModel } = modelsOf(deps)
    const batchSize = deps.batchSize ?? BULK_BATCH
    const result = { stops: null, lines: null }

    try {
        // Sequential: overlapping stops+lines JSON + ops arrays doubled the 04:15 RSS spike.
        try {
            result.stops = await syncCollection({
                url: `${BASE_URL}/v2/stops`,
                Model: StopModel,
                norm: normStop,
                sanityMin: STOPS_SANITY_MIN,
                logger,
                deps,
                label: 'stops',
                batchSize
            })
        } catch (err) {
            result.stops = { error: err.message }
            logger?.error({ err }, 'stops sync failed')
        }

        try {
            result.lines = await syncCollection({
                url: `${BASE_URL}/v2/lines`,
                Model: LineModel,
                norm: normLine,
                sanityMin: LINES_SANITY_MIN,
                logger,
                deps,
                label: 'lines',
                batchSize
            })
        } catch (err) {
            result.lines = { error: err.message }
            logger?.error({ err }, 'lines sync failed')
        }

        const stopsOk = result.stops && !result.stops.error
        const linesOk = result.lines && !result.lines.error
        if (snapshot) {
            if (stopsOk || linesOk) snapshot.lastStaticSync = new Date()
            snapshot.staticStale = !stopsOk || !linesOk
        }
        return result
    } finally {
        staticInFlight = false
    }
}

/** Test helper: reset in-flight guards. */
export function resetSyncGuards() {
    vehiclesInFlight = false
    alertsInFlight = false
    staticInFlight = false
}
