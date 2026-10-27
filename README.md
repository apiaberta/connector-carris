# API Aberta — Carris Metropolitana connector

Realtime vehicles, alerts, stops and lines from [Carris Metropolitana](https://api.carrismetropolitana.pt) (API v2). Attribution: **Carris Metropolitana / TML**. Open data, no API key.

Port **3017**. Gateway prefix `/carris`.

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

Upstream (`alerts`, `arrivals`) is flaky (502/timeouts). The connector retries with backoff and serves the last good snapshot with `"stale": true` instead of failing. `/health` stays `ok`.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

pm2 name: `apiaberta-carris` (`ecosystem.config.cjs`). Mongo: `mongodb://localhost:27017/apiaberta-carris`.

## Data source

https://api.carrismetropolitana.pt — [API docs](https://github.com/carrismetropolitana/api). Licence: open data, Carris Metropolitana / TML.

## License

MIT
