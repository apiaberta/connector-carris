import {
  ARRIVALS_LIMIT_DEFAULT,
  ARRIVALS_LIMIT_MAX,
  ARRIVALS_TIMEOUT_MS,
  BASE_URL,
  EARTH_RADIUS_M,
  NEAR_RADIUS_DEFAULT,
  NEAR_RADIUS_MAX,
  PAGE_DEFAULT,
  PAGE_MAX,
  VEHICLES_UNFILTERED_CAP
} from './config.js'
import { fetchJson, UpstreamError } from './http.js'
import { Alert } from './models/alert.js'
import { Line } from './models/line.js'
import { Stop } from './models/stop.js'
import { Vehicle } from './models/vehicle.js'
import {
  QueryError,
  escapeRegex,
  filterArrivals,
  formatAlert,
  formatLine,
  formatStop,
  formatVehicle,
  matchVehicle,
  parseBbox,
  parseLatLon,
  parsePagination
} from './transform.js'

const tags = ['Transport']

function modelsOf(app) {
  return app.models ?? { Vehicle, Alert, Stop, Line }
}

async function leanFindOne(model, filter) {
  if (!model?.findOne) return null
  const query = model.findOne(filter)
  if (query && typeof query.lean === 'function') return query.lean()
  return query
}

async function leanFind(model, filter, { skip = 0, limit, sort, select } = {}) {
  if (!model?.find) return []
  let query = model.find(filter)
  if (select && typeof query.select === 'function') query = query.select(select)
  if (sort && typeof query.sort === 'function') query = query.sort(sort)
  if (skip && typeof query.skip === 'function') query = query.skip(skip)
  if (limit != null && typeof query.limit === 'function') query = query.limit(limit)
  if (query && typeof query.lean === 'function') query = query.lean()
  return query
}

async function countDocs(model, filter = {}) {
  if (!model?.countDocuments) return 0
  return model.countDocuments(filter)
}

function sendQueryError(err, reply) {
  if (err instanceof QueryError) {
    return reply.code(err.statusCode).send({ error: err.message })
  }
  throw err
}

function listVehicles(snapshot, query) {
  const line_id = query.line_id
  const route_id = query.route_id
  let bbox = null
  if (query.bbox) bbox = parseBbox(query.bbox)
  const all = [...(snapshot?.vehicles?.values() ?? [])]
  return all.filter(v => matchVehicle(v, { line_id, route_id, bbox }))
}

function pageVehicles(filtered, query) {
  const wantsPaging = query.limit != null || query.offset != null
  const hasFilter = Boolean(query.line_id || query.bbox)
  if (wantsPaging) {
    const { limit, offset } = parsePagination(query)
    return filtered.slice(offset, offset + limit)
  }
  if (!hasFilter && filtered.length > VEHICLES_UNFILTERED_CAP) {
    return filtered.slice(0, VEHICLES_UNFILTERED_CAP)
  }
  return filtered
}

export async function carrisRoutes(app) {
  const vehiclesQuery = {
    type: 'object',
    properties: {
      line_id:  { type: 'string' },
      route_id: { type: 'string' },
      bbox:     { type: 'string', description: 'minLon,minLat,maxLon,maxLat' },
      limit:    { type: 'integer', minimum: 1, maximum: PAGE_MAX },
      offset:   { type: 'integer', minimum: 0 }
    }
  }

  app.get('/vehicles', {
    schema: {
      description: 'Realtime Carris Metropolitana vehicles (in-memory snapshot)',
      tags,
      querystring: vehiclesQuery
    }
  }, async (req, reply) => {
    try {
      const snapshot = app.snapshot
      let filtered = listVehicles(snapshot, req.query)
      let stale = Boolean(snapshot?.stale)
      let updated_at = snapshot?.updatedAt ?? null

      if (filtered.length === 0 && (!snapshot?.vehicles || snapshot.vehicles.size === 0)) {
        const { Vehicle: VehicleModel } = modelsOf(app)
        const filter = {}
        if (req.query.line_id) filter.line_id = req.query.line_id
        if (req.query.route_id) filter.route_id = req.query.route_id
        if (req.query.bbox) {
          const bbox = parseBbox(req.query.bbox)
          filter.lon = { $gte: bbox.minLon, $lte: bbox.maxLon }
          filter.lat = { $gte: bbox.minLat, $lte: bbox.maxLat }
        }
        filtered = await leanFind(VehicleModel, filter)
        stale = true
      }

      const data = pageVehicles(filtered, req.query).map(formatVehicle)
      return {
        count: data.length,
        updated_at,
        stale,
        data
      }
    } catch (err) {
      return sendQueryError(err, reply)
    }
  })

  app.get('/vehicles/:id', {
    schema: {
      description: 'Single vehicle by id',
      tags,
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      }
    }
  }, async (req, reply) => {
    const snapshot = app.snapshot
    let vehicle = snapshot?.vehicles?.get(req.params.id)
    if (!vehicle) {
      const { Vehicle: VehicleModel } = modelsOf(app)
      vehicle = await leanFindOne(VehicleModel, { id: req.params.id })
    }
    if (!vehicle) return reply.code(404).send({ error: 'Not found' })
    return formatVehicle(vehicle)
  })

  app.get('/alerts', {
    schema: {
      description: 'Service alerts from Carris Metropolitana',
      tags,
      querystring: {
        type: 'object',
        properties: {
          active:   { type: 'boolean', default: true },
          line_id:  { type: 'string' },
          stop_id:  { type: 'string' },
          limit:    { type: 'integer', default: PAGE_DEFAULT, minimum: 1, maximum: PAGE_MAX },
          offset:   { type: 'integer', default: 0, minimum: 0 }
        }
      }
    }
  }, async (req) => {
    const { Alert: AlertModel } = modelsOf(app)
    const { limit, offset } = parsePagination(req.query)
    const filter = {}
    if (req.query.active !== false) filter.active = true
    else filter.active = false
    if (req.query.line_id) {
      filter.$or = [
        { lines: req.query.line_id },
        { routes: req.query.line_id }
      ]
    }
    if (req.query.stop_id) filter.stops = req.query.stop_id

    const [total, docs] = await Promise.all([
      countDocs(AlertModel, filter),
      leanFind(AlertModel, filter, { skip: offset, limit, sort: { active_to: -1 } })
    ])
    const data = docs.map(formatAlert)
    return {
      count: data.length,
      total,
      stale: Boolean(app.snapshot?.alertsStale),
      data
    }
  })

  app.get('/stops', {
    schema: {
      description: 'Carris Metropolitana stops',
      tags,
      querystring: {
        type: 'object',
        properties: {
          q:               { type: 'string' },
          municipality_id: { type: 'string' },
          near:            { type: 'string', description: 'lat,lon' },
          radius:          { type: 'number', default: NEAR_RADIUS_DEFAULT, minimum: 1, maximum: NEAR_RADIUS_MAX },
          limit:           { type: 'integer', default: PAGE_DEFAULT, minimum: 1, maximum: PAGE_MAX },
          offset:          { type: 'integer', default: 0, minimum: 0 }
        }
      }
    }
  }, async (req, reply) => {
    try {
      const { Stop: StopModel } = modelsOf(app)
      const { limit, offset } = parsePagination(req.query)
      const filter = {}
      if (req.query.municipality_id) filter.municipality_id = req.query.municipality_id
      if (req.query.q) filter.name = { $regex: escapeRegex(req.query.q), $options: 'i' }
      if (req.query.near) {
        const { lat, lon } = parseLatLon(req.query.near)
        const radius = Math.min(Number(req.query.radius ?? NEAR_RADIUS_DEFAULT) || NEAR_RADIUS_DEFAULT, NEAR_RADIUS_MAX)
        filter.location = {
          $geoWithin: {
            $centerSphere: [[lon, lat], radius / EARTH_RADIUS_M]
          }
        }
      }
      const [total, docs] = await Promise.all([
        countDocs(StopModel, filter),
        leanFind(StopModel, filter, { skip: offset, limit })
      ])
      const data = docs.map(formatStop)
      return { count: data.length, total, data }
    } catch (err) {
      return sendQueryError(err, reply)
    }
  })

  app.get('/stops/:id/arrivals', {
    schema: {
      description: 'Upcoming arrivals at a stop (on-demand proxy, 20s cache)',
      tags,
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: ARRIVALS_LIMIT_DEFAULT, minimum: 1, maximum: ARRIVALS_LIMIT_MAX }
        }
      }
    }
  }, async (req, reply) => {
    const stopId = req.params.id
    const limit = parsePagination(req.query, {
      defaultLimit: ARRIVALS_LIMIT_DEFAULT,
      maxLimit: ARRIVALS_LIMIT_MAX
    }).limit
    const cache = app.arrivalsCache
    const cached = cache?.get(stopId)

    if (cached && !cached.stale) {
      const body = { ...cached.value, stale: false }
      body.data = (body.data || []).slice(0, limit)
      return body
    }

    try {
      const { status, data } = await fetchJson(`${BASE_URL}/v2/arrivals/by_stop/${encodeURIComponent(stopId)}`, {
        fetchImpl: app.fetchImpl,
        timeoutMs: ARRIVALS_TIMEOUT_MS,
        retries: 2,
        delay: app.delay
      })

      if (status === 400) {
        const { Stop: StopModel } = modelsOf(app)
        const stop = await leanFindOne(StopModel, { id: stopId })
        if (!stop) return reply.code(404).send({ error: 'Not found' })
        const empty = {
          stop_id: stopId,
          updated_at: new Date().toISOString(),
          realtime_available: false,
          stale: false,
          data: []
        }
        cache?.set(stopId, empty)
        return empty
      }

      if (!Array.isArray(data)) throw new UpstreamError('arrivals: expected array', { status: 502, url: 'arrivals' })

      const { data: arrivals, realtime_available } = filterArrivals(data, { limit })
      const body = {
        stop_id: stopId,
        updated_at: new Date().toISOString(),
        realtime_available,
        stale: false,
        data: arrivals
      }
      cache?.set(stopId, body)
      return body
    } catch (err) {
      if (cached) {
        const body = { ...cached.value, stale: true }
        body.data = (body.data || []).slice(0, limit)
        return body
      }
      return reply.code(503).header('Retry-After', '30').send({ error: 'Upstream unavailable', retry_after: 30 })
    }
  })

  app.get('/stops/:id', {
    schema: {
      description: 'Single stop plus its lines',
      tags,
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      }
    }
  }, async (req, reply) => {
    const { Stop: StopModel, Line: LineModel } = modelsOf(app)
    const stop = await leanFindOne(StopModel, { id: req.params.id })
    if (!stop) return reply.code(404).send({ error: 'Not found' })
    const ids = stop.line_ids || []
    const lines = ids.length
      ? (await leanFind(LineModel, { id: { $in: ids } }, { select: 'id short_name long_name color' }))
          .map(l => ({ id: l.id, short_name: l.short_name, long_name: l.long_name, color: l.color }))
      : []
    return { ...formatStop(stop), lines }
  })

  app.get('/lines', {
    schema: {
      description: 'Carris Metropolitana lines',
      tags,
      querystring: {
        type: 'object',
        properties: {
          q:               { type: 'string' },
          municipality_id: { type: 'string' },
          limit:           { type: 'integer', default: PAGE_DEFAULT, minimum: 1, maximum: PAGE_MAX },
          offset:          { type: 'integer', default: 0, minimum: 0 }
        }
      }
    }
  }, async (req) => {
    const { Line: LineModel } = modelsOf(app)
    const { limit, offset } = parsePagination(req.query)
    const filter = {}
    if (req.query.municipality_id) filter.municipality_ids = req.query.municipality_id
    if (req.query.q) {
      const re = new RegExp(escapeRegex(req.query.q), 'i')
      filter.$or = [{ short_name: re }, { long_name: re }, { id: re }]
    }
    const [total, docs] = await Promise.all([
      countDocs(LineModel, filter),
      leanFind(LineModel, filter, { skip: offset, limit, sort: { short_name: 1 } })
    ])
    const data = docs.map(formatLine)
    return { count: data.length, total, data }
  })

  app.get('/lines/:id', {
    schema: {
      description: 'Single line plus vehicles currently on it',
      tags,
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      }
    }
  }, async (req, reply) => {
    const { Line: LineModel } = modelsOf(app)
    const line = await leanFindOne(LineModel, { id: req.params.id })
    if (!line) return reply.code(404).send({ error: 'Not found' })
    const vehicles = [...(app.snapshot?.vehicles?.values() ?? [])]
      .filter(v => v.line_id === req.params.id)
      .map(formatVehicle)
    return {
      ...formatLine(line),
      vehicles,
      stale: Boolean(app.snapshot?.stale)
    }
  })
}
