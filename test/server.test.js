import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'
import { buildApp, setupJobs } from '../src/index.js'
import { createSnapshot } from '../src/snapshot.js'

const dir = dirname(fileURLToPath(import.meta.url))
const root = join(dir, '..')
const require = createRequire(import.meta.url)

describe('test isolation', () => {
  it('never opens a mongoose connection', () => {
    assert.equal(mongoose.connection.readyState, 0)
  })
})

describe('pm2 entrypoint', () => {
  it('points ecosystem.script at src/server.js, which always calls start()', () => {
    const eco = require(join(root, 'ecosystem.config.cjs'))
    assert.equal(eco.apps[0].script, 'src/server.js')
    assert.equal(eco.apps[0].env.VEHICLES_POLL_MS, '90000')
    assert.equal(eco.apps[0].env.VEHICLES_PERSIST, 'changed')
    const server = readFileSync(join(root, 'src/server.js'), 'utf8')
    assert.match(server, /import\s+\{\s*start\s*\}\s+from\s+['"]\.\/index\.js['"]/)
    assert.match(server, /await\s+start\s*\(\s*\)/)
  })
})

describe('setupJobs', () => {
  it('polls vehicles with setInterval at the configured ms, not a 30s cron', async () => {
    const intervals = []
    const crons = []
    const app = await buildApp({
      snapshot: createSnapshot(),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }),
      logger: false,
      delay: async () => {}
    })
    try {
      const { vehiclesPollMs } = setupJobs(app, app.snapshot, {
        vehiclesPollMs: 90_000,
        setIntervalFn: (fn, ms) => {
          intervals.push(ms)
          return 0
        },
        schedule: (expr) => { crons.push(expr) }
      })
      assert.equal(vehiclesPollMs, 90_000)
      assert.deepEqual(intervals, [90_000])
      assert.ok(crons.includes('*/5 * * * *'))
      assert.ok(crons.includes('15 4 * * *'))
      assert.equal(crons.includes('*/30 * * * * *'), false)
    } finally {
      await app.close()
    }
  })
})
