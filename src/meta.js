import { SERVICE_NAME, VERSION } from './config.js'
import { Alert } from './models/alert.js'
import { Line } from './models/line.js'
import { Stop } from './models/stop.js'
import { Vehicle } from './models/vehicle.js'

function modelsOf(app) {
  return app.models ?? { Vehicle, Alert, Stop, Line }
}

async function safeCount(model, filter = {}) {
  try {
    if (!model?.countDocuments) return 0
    return await model.countDocuments(filter)
  } catch {
    return 0
  }
}

export async function metaRoutes(app) {
  app.get('/carris/meta', {
    schema: {
      description: 'Metadata and stats for the Carris Metropolitana connector',
      tags: ['Transport']
    }
  }, async () => {
    const { Vehicle: VehicleModel, Alert: AlertModel, Stop: StopModel, Line: LineModel } = modelsOf(app)
    const snapshot = app.snapshot
    const [vehiclesMongo, activeAlerts, stops, lines] = await Promise.all([
      safeCount(VehicleModel),
      safeCount(AlertModel, { active: true }),
      safeCount(StopModel),
      safeCount(LineModel)
    ])
    const vehicles = snapshot?.vehicles?.size || vehiclesMongo
    return {
      connector:   SERVICE_NAME,
      version:     VERSION,
      description: 'Realtime vehicles, alerts, stops and lines from Carris Metropolitana',
      source:      'https://api.carrismetropolitana.pt',
      license:     'Open data – Carris Metropolitana/TML',
      update_freq: 'vehicles 30s, alerts 5min, stops/lines daily',
      endpoints: [
        { path: '/v1/carris/vehicles',             description: 'Realtime vehicles (optional line_id, route_id, bbox)' },
        { path: '/v1/carris/vehicles/:id',         description: 'Single vehicle' },
        { path: '/v1/carris/alerts',               description: 'Service alerts' },
        { path: '/v1/carris/stops',                description: 'Stops (q, municipality_id, near)' },
        { path: '/v1/carris/stops/:id',            description: 'Single stop plus lines' },
        { path: '/v1/carris/stops/:id/arrivals',   description: 'Upcoming arrivals at a stop' },
        { path: '/v1/carris/lines',                description: 'Lines' },
        { path: '/v1/carris/lines/:id',            description: 'Single line plus vehicles currently on it' }
      ],
      stats: {
        vehicles,
        active_alerts:      activeAlerts,
        stops,
        lines,
        last_vehicles_sync: snapshot?.lastVehiclesSync ?? null,
        last_alerts_sync:   snapshot?.lastAlertsSync ?? null,
        last_static_sync:   snapshot?.lastStaticSync ?? null
      }
    }
  })
}
