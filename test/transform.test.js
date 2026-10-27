import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  QueryError,
  alertId,
  filterArrivals,
  normAlert,
  normArrival,
  normStop,
  normVehicle,
  parseBbox
} from '../src/transform.js'

const dir = dirname(fileURLToPath(import.meta.url))
const load = (name) => JSON.parse(readFileSync(join(dir, 'fixtures', name), 'utf8'))

const vehicles = load('vehicles.json')
const alerts = load('alerts.json')
const stops = load('stops.json')
const arrivals = load('arrivals.json')

const NOW = Date.parse('2026-10-27T16:00:00Z') // 1761576000000

describe('normVehicle', () => {
  it('keeps id and maps timestamp from milliseconds', () => {
    const v = normVehicle(vehicles[0], new Date(NOW))
    assert.equal(v.id, '[BNA17]2532')
    assert.equal(v.line_id, '1101')
    assert.equal(v.lat, 38.736946)
    assert.equal(v.lon, -9.142685)
    assert.equal(v.timestamp.toISOString(), '2026-10-27T16:20:00.000Z')
    assert.equal(v.seen_at.toISOString(), new Date(NOW).toISOString())
  })

  it('maps timestamp from unix seconds', () => {
    const v = normVehicle(vehicles[1])
    assert.equal(v.timestamp.toISOString(), '2026-10-27T16:20:10.000Z')
  })

  it('returns null without id', () => {
    assert.equal(normVehicle({ lat: 1 }), null)
  })
})

describe('normAlert', () => {
  it('hashes a stable alert_id when upstream id is missing', () => {
    const a = normAlert(alerts[0])
    const b = normAlert(alerts[0])
    assert.equal(a.alert_id, b.alert_id)
    assert.match(a.alert_id, /^[a-f0-9]{40}$/)
    assert.equal(a.alert_id, alertId(alerts[0]))
    assert.equal(a.header_pt, 'Vila Franca de Xira: corte de via')
    assert.equal(a.header_en, 'Vila Franca de Xira: road closure')
    assert.deepEqual(a.lines, ['2306', '2307'])
    assert.deepEqual(a.stops, ['020001'])
    assert.equal(a.active_from.toISOString(), '2026-10-27T16:00:00.000Z')
    assert.equal(a.url, 'https://www.carrismetropolitana.pt/aviso/1')
  })

  it('uses the upstream id when present', () => {
    const a = normAlert(alerts[1])
    assert.equal(a.alert_id, 'alert-strike-42')
    assert.equal(a.header_en, null)
    assert.deepEqual(a.lines, ['1101'])
  })

  it('changes alert_id when header or entities change', () => {
    const other = structuredClone(alerts[0])
    other.header_text.translation[0].text = 'outro'
    assert.notEqual(alertId(alerts[0]), alertId(other))
  })
})

describe('normStop', () => {
  it('builds a GeoJSON Point as [lon, lat]', () => {
    const s = normStop(stops[0])
    assert.equal(s.id, '010001')
    assert.equal(s.name, 'Marquês de Pombal')
    assert.deepEqual(s.location, { type: 'Point', coordinates: [-9.150, 38.725] })
    assert.equal(s.location.coordinates[0], s.lon)
    assert.equal(s.location.coordinates[1], s.lat)
  })

  it('falls back from long_name and locality_name', () => {
    const s = normStop(stops[1])
    assert.equal(s.name, 'Reboleira (Estação)')
    assert.equal(s.locality, 'Reboleira')
  })
})

describe('normArrival', () => {
  it('computes minutes from estimated when present', () => {
    const a = normArrival(arrivals[0], NOW)
    assert.equal(a.minutes, 12)
    assert.equal(a.estimated, '2026-10-27T16:12:00.000Z')
    assert.equal(a.scheduled, '2026-10-27T16:10:00.000Z')
    assert.equal(a.observed, null)
    assert.equal(a.vehicle_id, '[BNA17]2532')
  })

  it('handles null realtime fields and uses scheduled for minutes', () => {
    const a = normArrival(arrivals[1], NOW)
    assert.equal(a.estimated, null)
    assert.equal(a.observed, null)
    assert.equal(a.vehicle_id, null)
    assert.equal(a.minutes, 15)
  })
})

describe('filterArrivals', () => {
  it('drops arrivals older than now-60 and sorts ascending', () => {
    const { data, realtime_available } = filterArrivals(arrivals, { now: NOW, limit: 20 })
    assert.equal(data.length, 2)
    assert.equal(data[0].trip_id, 't-1101-1')
    assert.equal(data[1].trip_id, 't-1001-2')
    assert.equal(realtime_available, true)
  })
})

describe('parseBbox', () => {
  it('parses minLon,minLat,maxLon,maxLat', () => {
    assert.deepEqual(parseBbox('-9.3,38.6,-9.0,38.8'), {
      minLon: -9.3, minLat: 38.6, maxLon: -9.0, maxLat: 38.8
    })
  })

  it('returns null for empty', () => {
    assert.equal(parseBbox(null), null)
    assert.equal(parseBbox(''), null)
  })

  it('rejects invalid values', () => {
    for (const value of ['1,2,3', 'a,b,c,d', '0,0,0,0', '10,0,-10,1', '0,-100,1,0', '200,0,201,1']) {
      assert.throws(() => parseBbox(value), (err) => err instanceof QueryError && err.statusCode === 400)
    }
  })
})
