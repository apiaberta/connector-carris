# API Aberta — Carris Metropolitana connector

Realtime vehicles, alerts, stops and lines from [Carris Metropolitana](https://api.carrismetropolitana.pt) (API v2). Attribution: **Carris Metropolitana / TML**. Open data, no API key.

Port **3017**. Gateway prefix `/carris`. Version **1.1.0**.

## Endpoints

| Path | Description |
| --- | --- |
| `GET /health` | Liveness. Does **not** depend on upstream. |
| `GET /carris/meta` | Connector metadata and counts |
| `GET /carris/vehicles` | Realtime vehicles (`line_id`, `route_id`, `bbox=minLon,minLat,maxLon,maxLat`) |
| `GET /carris/vehicles/:id` | Single vehicle |
| `GET /carris/alerts` | Service alerts (`active=true` by default, `line_id`, `stop_id`) |
| `GET /carris/stops` | Stops (`q`, `municipality_id`, `near=lat,lon`, `radius`, `limit`, `offset`) |
| `GET /carris/stops/:id` | Stop plus its lines |
| `GET /carris/stops/:id/arrivals` | On-demand arrivals (20s cache, 8s timeout) |
| `GET /carris/lines` | Lines (`q`, `municipality_id`) |
| `GET /carris/lines/:id` | Line plus vehicles currently on it |

Public URL: `https://api.apiaberta.pt/v1` + path.

Routes and JSON shapes are unchanged from 1.0.0. `meta.update_freq` now reflects the configured poll interval (default `vehicles 90s`).

Upstream (`alerts`, `arrivals`) is flaky (502/timeouts). The connector retries with backoff and serves the last good snapshot with `"stale": true` instead of failing. `/health` stays `ok`.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

pm2 name: `apiaberta-carris` (`ecosystem.config.cjs`). Mongo: `mongodb://localhost:27017/apiaberta-carris`.

Tests (`npm test`) inject stub models and never connect to Mongo. Do not point `MONGO_URI` in `.env` at production when running locally.

## Ingest (v1.1.0)

| Job | When | Effect |
| --- | --- | --- |
| Vehicles | `VEHICLES_POLL_MS` (default **90s**, clamped 60–120s) | Fetch `/v2/vehicles`, replace the in-memory Map, `bulkWrite` only new/moved docs |
| Alerts | every 5 min | Upsert + mark missing as inactive |
| Stops + lines | 04:15 Europe/Lisbon and startup | Sequential fetch; batched `bulkWrite` (1000); sanity guard before deletes |

Live positions are the in-memory Map (capped at `VEHICLES_SNAPSHOT_MAX`, default 4000). Vehicles not seen for `VEHICLES_SNAPSHOT_TTL_MS` (default 10 min) are dropped after a failed poll so RSS cannot hold a stale fleet forever. Mongo is a restart fallback and is no longer rewritten in full every poll.

`VEHICLES_PERSIST`:

| value | writes |
| --- | --- |
| `changed` (default) | one `bulkWrite` of upserts on unique `{ id: 1 }` for vehicles whose position/assignment changed |
| `all` | legacy: upsert every vehicle each poll |
| `off` | no vehicle writes; GET still served from memory |

## Mongo indexes

Created by Mongoose `autoIndex` on startup. Do **not** add indexes ad-hoc on the shared production mongod.

### `vehicles` (v1.1.0)

| keys | options | purpose |
| --- | --- | --- |
| `{ id: 1 }` | unique | upsert filter for `bulkWrite` |
| `{ line_id: 1 }` | | fallback `GET /vehicles?line_id=` |
| `{ route_id: 1 }` | **new in 1.1.0** | fallback `GET /vehicles?route_id=` |
| `{ seen_at: 1 }` | `expireAfterSeconds: 3600` | drop stale positions (Mongo TTL monitor, ~60s) |

`{ route_id: 1 }` is the only new index. The collection is small (~minutes of live buses); the build is cheap. Changing `expireAfterSeconds` does **not** update an existing TTL index — drop `vehicles.seen_at_1` on the mongod, then restart the connector.

### `alerts` / `stops` / `lines`

Unchanged: unique id keys, alerts `last_seen` TTL 90d, stops `2dsphere` + `municipality_id` + text.

## Environment

See `.env.example`. Production values are also in `ecosystem.config.cjs`.

| variable | default | notes |
| --- | --- | --- |
| `PORT` | `3017` | |
| `MONGO_URI` | `mongodb://localhost:27017/apiaberta-carris` | tests never use this |
| `VEHICLES_POLL_MS` | `90000` | clamped to `60000`–`120000` |
| `VEHICLES_PERSIST` | `changed` | `changed` \| `all` \| `off` |
| `VEHICLES_SNAPSHOT_MAX` | `4000` | in-memory cap |
| `VEHICLES_SNAPSHOT_TTL_MS` | `600000` | prune last-good after failed polls |

## Data source

https://api.carrismetropolitana.pt — [API docs](https://github.com/carrismetropolitana/api). Licence: open data, Carris Metropolitana / TML.

## License

MIT
