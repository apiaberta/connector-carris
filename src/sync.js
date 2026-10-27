/**
 * sync.js — Carris Metropolitana data synchronisation
 * Vehicles: every 30s | Alerts: every 5min | Stops+lines: daily 04:15 + startup
 *
 * Upstream is flaky (502/timeouts). Failures keep the last good snapshot
 * and never wipe stored data.
 */

import { BASE_URL, BULK_BATCH, FETCH_TIMEOUT_MS, LINES_SANITY_MIN, STOPS_SANITY_MIN } from './config.js'
import { fetchJson } from './http.js'
import { Alert } from './models/alert.js'
import { Line } from './models/line.js'
import { Stop } from './models/stop.js'
import { Vehicle } from './models/vehicle.js'
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

export async function syncVehicles(logger, deps = {}) {
  if (vehiclesInFlight) return { skipped: true, reason: 'in-flight' }
  vehiclesInFlight = true
  const snapshot = deps.snapshot
  const { Vehicle: VehicleModel } = modelsOf(deps)

  try {
    const { data } = await fetchJson(`${BASE_URL}/v2/vehicles`, {
      fetchImpl: deps.fetchImpl,
      timeoutMs: FETCH_TIMEOUT_MS,
      retries: deps.retries ?? 3,
      delay: deps.delay
    })
    if (!Array.isArray(data)) throw new Error('vehicles: expected array')

    const seenAt = new Date()
    const next = new Map()
    const ops = []
    for (const raw of data) {
      const v = normVehicle(raw, seenAt)
      if (!v) continue
      next.set(v.id, v)
      ops.push({
        updateOne: {
          filter: { id: v.id },
          update: { $set: v },
          upsert: true
        }
      })
    }

    if (snapshot) {
      snapshot.vehicles = next
      snapshot.updatedAt = seenAt
      snapshot.stale = false
      snapshot.lastVehiclesSync = seenAt
      snapshot.lastError = null
    }

    let mongo = { upserted: 0, modified: 0 }
    if (VehicleModel?.bulkWrite) {
      try {
        mongo = await bulkInBatches(VehicleModel, ops)
      } catch (err) {
        logger?.error({ err }, 'vehicles bulkWrite failed; in-memory snapshot kept')
      }
    }

    logger?.info({ n: next.size, ...mongo }, 'Vehicles sync complete')
    return { n: next.size, ...mongo }
  } catch (err) {
    if (snapshot) {
      snapshot.stale = true
      snapshot.lastError = err.message
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
      await bulkInBatches(AlertModel, ops)
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

async function syncCollection({ url, Model, norm, sanityMin, logger, deps, label }) {
  const { data } = await fetchJson(url, {
    fetchImpl: deps.fetchImpl,
    timeoutMs: FETCH_TIMEOUT_MS,
    retries: deps.retries ?? 3,
    delay: deps.delay
  })
  if (!Array.isArray(data)) throw new Error(`${label}: expected array`)

  const syncedAt = new Date()
  const ops = []
  for (const raw of data) {
    const doc = norm(raw, syncedAt)
    if (!doc) continue
    ops.push({
      updateOne: {
        filter: { id: doc.id },
        update: { $set: doc },
        upsert: true
      }
    })
  }

  let mongo = { upserted: 0, modified: 0 }
  let deleted = 0
  if (Model?.bulkWrite) {
    mongo = await bulkInBatches(Model, ops)
    if (ops.length > sanityMin && Model.deleteMany) {
      const result = await Model.deleteMany({ synced_at: { $lt: syncedAt } })
      deleted = result.deletedCount ?? 0
    } else if (ops.length <= sanityMin) {
      logger?.warn({ n: ops.length, sanityMin }, `${label}: skip stale delete (sanity guard)`)
    }
  }

  logger?.info({ n: ops.length, deleted, ...mongo }, `${label} sync complete`)
  return { n: ops.length, deleted, ...mongo }
}

export async function syncStatic(logger, deps = {}) {
  if (staticInFlight) return { skipped: true, reason: 'in-flight' }
  staticInFlight = true
  const snapshot = deps.snapshot
  const { Stop: StopModel, Line: LineModel } = modelsOf(deps)
  const result = { stops: null, lines: null }

  try {
    const [stops, lines] = await Promise.allSettled([
      syncCollection({
        url: `${BASE_URL}/v2/stops`,
        Model: StopModel,
        norm: normStop,
        sanityMin: STOPS_SANITY_MIN,
        logger,
        deps,
        label: 'stops'
      }),
      syncCollection({
        url: `${BASE_URL}/v2/lines`,
        Model: LineModel,
        norm: normLine,
        sanityMin: LINES_SANITY_MIN,
        logger,
        deps,
        label: 'lines'
      })
    ])

    result.stops = stops.status === 'fulfilled' ? stops.value : { error: stops.reason?.message }
    result.lines = lines.status === 'fulfilled' ? lines.value : { error: lines.reason?.message }

    if (stops.status === 'rejected') logger?.error({ err: stops.reason }, 'stops sync failed')
    if (lines.status === 'rejected') logger?.error({ err: lines.reason }, 'lines sync failed')

    const ok = stops.status === 'fulfilled' || lines.status === 'fulfilled'
    if (snapshot) {
      if (ok) snapshot.lastStaticSync = new Date()
      snapshot.staticStale = stops.status === 'rejected' || lines.status === 'rejected'
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
