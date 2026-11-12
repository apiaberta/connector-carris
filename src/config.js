export const SERVICE_NAME = 'connector-carris'
export const VERSION = '1.1.0'
export const PORT_DEFAULT = 3017
export const MONGO_URI_DEFAULT = 'mongodb://localhost:27017/apiaberta-carris'
export const BASE_URL = 'https://api.carrismetropolitana.pt'
export const USER_AGENT = 'apiaberta.pt/1.0 (open-data connector)'
export const FETCH_TIMEOUT_MS = 15_000
export const ARRIVALS_TIMEOUT_MS = 8_000
export const ARRIVALS_CACHE_TTL_MS = 20_000
export const ARRIVALS_CACHE_MAX = 2000
export const VEHICLES_UNFILTERED_CAP = 3000
export const PAGE_DEFAULT = 100
export const PAGE_MAX = 1000
export const ARRIVALS_LIMIT_DEFAULT = 20
export const ARRIVALS_LIMIT_MAX = 100
export const NEAR_RADIUS_DEFAULT = 500
export const NEAR_RADIUS_MAX = 5000
export const STOPS_SANITY_MIN = 1000
export const LINES_SANITY_MIN = 100
export const BULK_BATCH = 1000
export const EARTH_RADIUS_M = 6_371_000

/** Default /vehicles poll. Clamped to 60–120 s via VEHICLES_POLL_MS. */
export const VEHICLES_POLL_MS_DEFAULT = 90_000
export const VEHICLES_POLL_MS_MIN = 60_000
export const VEHICLES_POLL_MS_MAX = 120_000

/**
 * Live positions live in a bounded in-memory Map (source of truth for GET).
 * Cap is above a full Carris Metropolitana fleet so a wild upstream payload
 * cannot grow RSS without bound.
 */
export const VEHICLES_SNAPSHOT_MAX_DEFAULT = 4000
export const VEHICLES_SNAPSHOT_TTL_MS_DEFAULT = 600_000

/**
 * Mongo persist mode for vehicles:
 *   changed (default) — bulkWrite only new/moved vehicles
 *   all               — upsert every vehicle each poll (legacy)
 *   off               — in-memory only; no vehicle writes
 */
export const VEHICLES_PERSIST_DEFAULT = 'changed'
export const VEHICLES_PERSIST_MODES = new Set(['changed', 'all', 'off'])

/** Mongo TTL on vehicles.seen_at. Changing this requires dropping seen_at_1. */
export const VEHICLES_MONGO_TTL_SECONDS = 3600

export function parsePositiveInt(raw, fallback) {
    const n = Number.parseInt(raw ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
}

export function parseVehiclesPollMs(raw = process.env.VEHICLES_POLL_MS) {
    const n = Number.parseInt(raw ?? '', 10)
    if (!Number.isFinite(n)) return VEHICLES_POLL_MS_DEFAULT
    return Math.min(VEHICLES_POLL_MS_MAX, Math.max(VEHICLES_POLL_MS_MIN, n))
}

export function parseVehiclesPersist(raw = process.env.VEHICLES_PERSIST) {
    const v = String(raw ?? VEHICLES_PERSIST_DEFAULT).trim().toLowerCase()
    return VEHICLES_PERSIST_MODES.has(v) ? v : VEHICLES_PERSIST_DEFAULT
}

export function parseVehiclesSnapshotMax(raw = process.env.VEHICLES_SNAPSHOT_MAX) {
    return parsePositiveInt(raw, VEHICLES_SNAPSHOT_MAX_DEFAULT)
}

export function parseVehiclesSnapshotTtlMs(raw = process.env.VEHICLES_SNAPSHOT_TTL_MS) {
    return parsePositiveInt(raw, VEHICLES_SNAPSHOT_TTL_MS_DEFAULT)
}
