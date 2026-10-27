import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const root = join(dir, '..')
const require = createRequire(import.meta.url)

describe('pm2 entrypoint', () => {
  it('points ecosystem.script at src/server.js, which always calls start()', () => {
    const eco = require(join(root, 'ecosystem.config.cjs'))
    assert.equal(eco.apps[0].script, 'src/server.js')
    const server = readFileSync(join(root, 'src/server.js'), 'utf8')
    assert.match(server, /import\s+\{\s*start\s*\}\s+from\s+['"]\.\/index\.js['"]/)
    assert.match(server, /await\s+start\s*\(\s*\)/)
  })
})
