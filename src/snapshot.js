export function createSnapshot() {
  return {
    vehicles: new Map(),
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
