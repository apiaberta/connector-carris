import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import Fastify from 'fastify'
import mongoose from 'mongoose'
import cron from 'node-cron'
import { TtlLruCache } from './cache.js'
import {
    ARRIVALS_CACHE_MAX,
    ARRIVALS_CACHE_TTL_MS,
    MONGO_URI_DEFAULT,
    PORT_DEFAULT,
    SERVICE_NAME,
    VERSION,
    parseVehiclesPollMs
} from './config.js'
import { metaRoutes } from './meta.js'
import { carrisRoutes } from './routes.js'
import { createSnapshot } from './snapshot.js'
import { syncAlerts, syncStatic, syncVehicles } from './sync.js'

try { process.loadEnvFile() } catch {}

export { createSnapshot, SERVICE_NAME, VERSION }

function isDirectRun() {
    const entry = process.argv[1]
    if (!entry) return false
    try {
        return fileURLToPath(import.meta.url) === resolve(entry)
    } catch {
        return false
    }
}

export async function buildApp({
    snapshot = createSnapshot(),
    fetchImpl = globalThis.fetch,
    models,
    arrivalsCache = new TtlLruCache({ max: ARRIVALS_CACHE_MAX, ttlMs: ARRIVALS_CACHE_TTL_MS }),
    logger,
    delay
} = {}) {
    const app = Fastify({
        logger: logger === false
            ? false
            : (logger ?? {
                transport: process.env.NODE_ENV !== 'production'
                    ? { target: 'pino-pretty' }
                    : undefined
            })
    })

    app.decorate('snapshot', snapshot)
    app.decorate('fetchImpl', fetchImpl)
    app.decorate('arrivalsCache', arrivalsCache)
    if (models) app.decorate('models', models)
    if (delay) app.decorate('delay', delay)

    app.get('/health', async () => ({
        status:    'ok',
        service:   SERVICE_NAME,
        version:   VERSION,
        timestamp: new Date().toISOString()
    }))

    await app.register(metaRoutes)
    await app.register(carrisRoutes, { prefix: '/carris' })
    return app
}

function runSync(app, snapshot, name, fn) {
    return fn(app.log, { snapshot, fetchImpl: app.fetchImpl })
        .then(r => app.log.info({ r }, `${name} complete`))
        .catch(err => app.log.error({ err }, `${name} failed`))
}

/**
 * Vehicles use setInterval (env-configurable 60–120s). Alerts and static
 * stay on node-cron. Jobs start after Mongo is connected so the first
 * persist is not a no-op.
 */
export function setupJobs(app, snapshot, {
    vehiclesPollMs = parseVehiclesPollMs(),
    setIntervalFn = setInterval,
    schedule = cron.schedule
} = {}) {
    const interval = setIntervalFn(
        () => runSync(app, snapshot, 'vehicles', syncVehicles),
        vehiclesPollMs
    )
    schedule('*/5 * * * *', () => runSync(app, snapshot, 'alerts', syncAlerts))
    schedule('15 4 * * *', () => runSync(app, snapshot, 'static', syncStatic), { timezone: 'Europe/Lisbon' })
    return { interval, vehiclesPollMs }
}

async function initialSync(app, snapshot) {
    // Sequential so vehicles JSON, alerts, and the 04:15-sized static
    // payloads are not all resident at once (startup used to fire all three).
    await runSync(app, snapshot, 'vehicles', syncVehicles)
    await runSync(app, snapshot, 'alerts', syncAlerts)
    await runSync(app, snapshot, 'static', syncStatic)
}

export async function start() {
    const snapshot = createSnapshot()
    const app = await buildApp({ snapshot })
    const PORT = parseInt(process.env.PORT || String(PORT_DEFAULT), 10)
    const MONGO_URI = process.env.MONGO_URI || MONGO_URI_DEFAULT

    await mongoose.connect(MONGO_URI)
    app.log.info('Connected to MongoDB')

    const { vehiclesPollMs } = setupJobs(app, snapshot)
    app.log.info({ vehiclesPollMs }, 'Vehicle poll interval')

    await app.listen({ port: PORT, host: '0.0.0.0' })
    app.log.info(`${SERVICE_NAME} listening on port ${PORT}`)

    void initialSync(app, snapshot)
    return app
}

if (isDirectRun()) {
    await start()
}
