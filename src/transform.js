import { createHash } from 'node:crypto'
import { PAGE_DEFAULT, PAGE_MAX } from './config.js'

export class QueryError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.name = 'QueryError'
    this.statusCode = statusCode
  }
}

export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function asNumber(value) {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

export function parseTimestamp(value) {
  if (value == null || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const numeric = Number(value)
  if (Number.isFinite(numeric) && String(value).trim() !== '') {
    return parseTimestamp(numeric)
  }
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function unixToIso(unix) {
  const d = parseTimestamp(unix)
  return d ? d.toISOString() : null
}

export function unixSeconds(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

export function parseBbox(value) {
  if (value == null || value === '') return null
  const parts = String(value).split(',').map(s => Number(s.trim()))
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
    throw new QueryError('Invalid bbox, expected minLon,minLat,maxLon,maxLat')
  }
  const [minLon, minLat, maxLon, maxLat] = parts
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) {
    throw new QueryError('Invalid bbox range')
  }
  if (minLon >= maxLon || minLat >= maxLat) {
    throw new QueryError('Invalid bbox range')
  }
  return { minLon, minLat, maxLon, maxLat }
}

export function parseLatLon(value) {
  if (value == null || value === '') return null
  const parts = String(value).split(',').map(s => Number(s.trim()))
  if (parts.length !== 2 || parts.some(n => !Number.isFinite(n))) {
    throw new QueryError('Invalid near, expected lat,lon')
  }
  const [lat, lon] = parts
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new QueryError('Invalid near range')
  }
  return { lat, lon }
}

export function parsePagination(query = {}, { defaultLimit = PAGE_DEFAULT, maxLimit = PAGE_MAX } = {}) {
  let limit = Number(query.limit ?? defaultLimit)
  let offset = Number(query.offset ?? 0)
  if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit
  if (limit > maxLimit) limit = maxLimit
  if (!Number.isFinite(offset) || offset < 0) offset = 0
  return { limit: Math.floor(limit), offset: Math.floor(offset) }
}

export function lineIdFromRoute(routeId) {
  if (routeId == null || routeId === '') return null
  const m = String(routeId).match(/(?:\]|^)(\d+)(?:_|$)/)
  return m ? m[1] : null
}

function translation(field, lang) {
  if (field == null) return null
  if (typeof field === 'string') return field
  const list = field.translation
  if (!Array.isArray(list) || list.length === 0) return null
  const exact = list.find(t => t.language === lang)
  if (exact?.text) return exact.text
  const prefix = list.find(t => t.language?.startsWith(lang))
  if (prefix?.text) return prefix.text
  return null
}

function pickUrl(raw) {
  if (!raw?.url) return null
  if (typeof raw.url === 'string') return raw.url
  return translation(raw.url, 'pt') || translation(raw.url, 'en') || null
}

export function alertId(raw) {
  if (raw?.id != null && String(raw.id).trim() !== '') return String(raw.id)
  const headerPt = translation(raw?.header_text, 'pt') || ''
  const start = raw?.active_period?.[0]?.start ?? ''
  const entities = JSON.stringify(raw?.informed_entity ?? [])
  return createHash('sha1').update(`${headerPt}${start}${entities}`).digest('hex')
}

export function normVehicle(raw, seenAt = new Date()) {
  if (!raw?.id) return null
  const lat = asNumber(raw.lat)
  const lon = asNumber(raw.lon)
  return {
    id: String(raw.id),
    line_id: raw.line_id != null ? String(raw.line_id) : null,
    route_id: raw.route_id != null ? String(raw.route_id) : null,
    pattern_id: raw.pattern_id != null ? String(raw.pattern_id) : null,
    trip_id: raw.trip_id != null ? String(raw.trip_id) : null,
    stop_id: raw.stop_id != null ? String(raw.stop_id) : null,
    lat,
    lon,
    bearing: asNumber(raw.bearing),
    current_status: raw.current_status ?? null,
    occupancy_status: raw.occupancy_status ?? null,
    door_status: raw.door_status ?? null,
    timestamp: parseTimestamp(raw.timestamp),
    seen_at: seenAt
  }
}

export function normAlert(raw, seenAt = new Date()) {
  const id = alertId(raw)
  if (!id) return null
  const period = Array.isArray(raw.active_period) ? raw.active_period[0] : null
  const routes = []
  const stops = []
  const lines = []
  for (const entity of raw.informed_entity || []) {
    if (entity?.route_id) {
      routes.push(String(entity.route_id))
      const line = entity.line_id != null ? String(entity.line_id) : lineIdFromRoute(entity.route_id)
      if (line) lines.push(line)
    }
    if (entity?.stop_id) stops.push(String(entity.stop_id))
    if (entity?.line_id && !entity?.route_id) lines.push(String(entity.line_id))
  }
  return {
    alert_id: id,
    cause: raw.cause ?? null,
    effect: raw.effect ?? null,
    header_pt: translation(raw.header_text, 'pt'),
    header_en: translation(raw.header_text, 'en'),
    description_pt: translation(raw.description_text, 'pt'),
    description_en: translation(raw.description_text, 'en'),
    url: pickUrl(raw),
    active_from: parseTimestamp(period?.start),
    active_to: parseTimestamp(period?.end),
    routes: [...new Set(routes)],
    stops: [...new Set(stops)],
    lines: [...new Set(lines)],
    active: true,
    first_seen: seenAt,
    last_seen: seenAt
  }
}

export function normStop(raw, syncedAt = new Date()) {
  if (!raw?.id) return null
  const lat = asNumber(raw.lat)
  const lon = asNumber(raw.lon)
  const name = raw.name || raw.long_name || raw.short_name || String(raw.id)
  const stop = {
    id: String(raw.id),
    name,
    lat,
    lon,
    municipality_id: raw.municipality_id != null ? String(raw.municipality_id) : null,
    municipality_name: raw.municipality_name ?? null,
    locality: raw.locality || raw.locality_name || null,
    line_ids: Array.isArray(raw.line_ids) ? raw.line_ids.map(String) : [],
    synced_at: syncedAt
  }
  if (lat != null && lon != null) {
    stop.location = { type: 'Point', coordinates: [lon, lat] }
  }
  return stop
}

export function normLine(raw, syncedAt = new Date()) {
  if (!raw?.id) return null
  return {
    id: String(raw.id),
    short_name: raw.short_name ?? null,
    long_name: raw.long_name ?? null,
    color: raw.color ?? null,
    text_color: raw.text_color ?? null,
    route_ids: Array.isArray(raw.route_ids) ? raw.route_ids : [],
    pattern_ids: Array.isArray(raw.pattern_ids) ? raw.pattern_ids : [],
    municipality_ids: Array.isArray(raw.municipality_ids) ? raw.municipality_ids.map(String) : [],
    synced_at: syncedAt
  }
}

export function normArrival(raw, now = Date.now()) {
  const estimatedUnix = unixSeconds(raw.estimated_arrival_unix ?? raw.estimated_arrival)
  const scheduledUnix = unixSeconds(raw.scheduled_arrival_unix ?? raw.scheduled_arrival)
  const observedUnix = unixSeconds(raw.observed_arrival_unix ?? raw.observed_arrival)
  const refUnix = estimatedUnix ?? scheduledUnix
  const nowSec = Math.floor(now / 1000)
  const minutes = refUnix != null ? Math.round((refUnix - nowSec) / 60) : null
  return {
    line_id: raw.line_id != null ? String(raw.line_id) : null,
    route_id: raw.route_id != null ? String(raw.route_id) : null,
    pattern_id: raw.pattern_id != null ? String(raw.pattern_id) : null,
    trip_id: raw.trip_id != null ? String(raw.trip_id) : null,
    headsign: raw.headsign ?? null,
    scheduled: unixToIso(scheduledUnix) || (typeof raw.scheduled_arrival === 'string' ? raw.scheduled_arrival : null),
    estimated: unixToIso(estimatedUnix) || (typeof raw.estimated_arrival === 'string' ? raw.estimated_arrival : null),
    observed: unixToIso(observedUnix) || (typeof raw.observed_arrival === 'string' ? raw.observed_arrival : null),
    minutes,
    vehicle_id: raw.vehicle_id != null ? String(raw.vehicle_id) : null,
    _sort: refUnix,
    _hasRealtime: estimatedUnix != null || (raw.estimated_arrival != null && raw.estimated_arrival !== '')
  }
}

export function filterArrivals(rawList, { now = Date.now(), limit = 20 } = {}) {
  const nowSec = Math.floor(now / 1000)
  const mapped = []
  for (const raw of rawList || []) {
    const item = normArrival(raw, now)
    if (item._sort == null || item._sort < nowSec - 60) continue
    mapped.push(item)
  }
  mapped.sort((a, b) => a._sort - b._sort)
  const data = mapped.slice(0, limit).map(({ _sort, _hasRealtime, ...rest }) => rest)
  const realtime_available = mapped.some(a => a._hasRealtime)
  return { data, realtime_available }
}

export function formatVehicle(v) {
  if (!v) return null
  return {
    id: v.id,
    line_id: v.line_id,
    route_id: v.route_id,
    pattern_id: v.pattern_id,
    trip_id: v.trip_id,
    stop_id: v.stop_id,
    lat: v.lat,
    lon: v.lon,
    bearing: v.bearing,
    current_status: v.current_status,
    occupancy_status: v.occupancy_status,
    timestamp: v.timestamp instanceof Date ? v.timestamp.toISOString() : unixToIso(v.timestamp)
  }
}

export function formatAlert(a) {
  if (!a) return null
  return {
    alert_id: a.alert_id,
    cause: a.cause,
    effect: a.effect,
    header_pt: a.header_pt,
    header_en: a.header_en,
    description_pt: a.description_pt,
    description_en: a.description_en,
    url: a.url,
    active_from: a.active_from instanceof Date ? a.active_from.toISOString() : a.active_from,
    active_to: a.active_to instanceof Date ? a.active_to.toISOString() : a.active_to,
    routes: a.routes || [],
    stops: a.stops || [],
    lines: a.lines || [],
    active: a.active
  }
}

export function formatStop(s) {
  if (!s) return null
  return {
    id: s.id,
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    municipality_id: s.municipality_id,
    municipality_name: s.municipality_name,
    locality: s.locality,
    line_ids: s.line_ids || []
  }
}

export function formatLine(l) {
  if (!l) return null
  return {
    id: l.id,
    short_name: l.short_name,
    long_name: l.long_name,
    color: l.color,
    text_color: l.text_color,
    route_ids: l.route_ids || [],
    pattern_ids: l.pattern_ids || [],
    municipality_ids: l.municipality_ids || []
  }
}

export function matchVehicle(v, { line_id, route_id, bbox } = {}) {
  if (line_id && v.line_id !== line_id) return false
  if (route_id && v.route_id !== route_id) return false
  if (bbox) {
    if (v.lon == null || v.lat == null) return false
    if (v.lon < bbox.minLon || v.lon > bbox.maxLon || v.lat < bbox.minLat || v.lat > bbox.maxLat) return false
  }
  return true
}
