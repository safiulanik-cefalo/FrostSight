# Showcase dashboard: architecture and design record

The FrostSight showcase is a standalone 3D web page that shows the icing risk for Troms as a low-poly world:
a county overview with one pin per weather station, and one diorama per station with its real road
coloured by risk, live weather, closures and incidents. It sits beside the MVP, not in it (ADR-0010), and
reads the same plot-ready gold tables as the AI/BI dashboards (ADR-0009), so the two never disagree.

- Code: `showcase/` (app, Worker, bake and scenario tools). How to run it: `showcase/README.md`.
- Decision: `docs/adr/0010-showcase-dashboard-outside-the-mvp.md`.
- Design spec and build plan: `docs/superpowers/specs/2026-10-12-showcase-dashboard-design.md`,
  `docs/superpowers/plans/2026-10-12-showcase-dashboard.md`.
- Approved look: <https://claude.ai/artifact/Lptn3YcfGy2mnkPeT4Y3oj>.

This document records what was built, why, and what to watch when changing it. Last updated 2026-10-12.

## 1. The three parts

```text
 Databricks (Free Edition)              Cloudflare (local: wrangler dev)            Browser
 ┌──────────────────────────┐           ┌──────────────────────────────┐            ┌───────────────────────────┐
 │ gold job (after fetch)   │           │ Worker                       │            │ React + three.js app      │
 │  writes plot-ready gold  │  SQL      │  cron */15  → refresh()      │  GET       │  overview + 24 dioramas   │
 │  kpi_summary             │◀─Statement│   1 cheap check, 7 reads     │◀/api/state─│  panels, list, outlook    │
 │  station_status          │  API      │   shape → validate → KV put  │  (KV only) │  scenarios (Simulated)    │
 │  segment_detail …        │  (token)  │  /api/state  /api/health     │            │                           │
 │  incident_list           │           │  static build (assets)       │──────────▶ │  /sites/<id>/… baked once │
 └──────────────────────────┘           └──────────────────────────────┘            └───────────────────────────┘
                                                                                     fallback: /snapshot.json
```

| Part | Where | Job | Runs |
|---|---|---|---|
| Bake script | `showcase/tools/bake_sites.py` | Turns reference data into static scene files: a terrain heightmap and a road corridor per station, and the county overview | By hand, output committed |
| Worker | `showcase/worker/src/` | Reads gold, builds one state document, stores it in KV, serves it and the static app. Holds the only Databricks credential | Cron every 15 min; on every page request |
| App | `showcase/src/` | Draws the scenes from the baked files and colours and animates them from a state document (live, snapshot or scenario) | In the browser |
| Scenario tool | `showcase/tools/make_scenarios.py` | Writes the three scripted scenarios from the seed | By hand, output committed |

The browser never talks to Databricks, and no secret reaches it.

## 2. Data flow

1. The gold job (`src/jobs/build_gold.py`) rebuilds the plot-ready tables after every fetch
   (`src/frostsight/serving.py`). All joins, coverage maths, ranking and labels happen there, once.
2. Every 15 minutes the Worker runs `refresh()` (`worker/src/index.ts`):
   - Reads `gold.kpi_summary`. If `risk_updated_at` is unchanged since the stored document, it only bumps
     `generated_at` and stops, so a quiet hour costs one small query.
   - Otherwise it runs the other seven reads in parallel through the SQL Statement Execution API
     (`worker/src/databricks.ts`: `POST /api/2.0/sql/statements`, inline JSON results, polls up to 60 s).
   - `shapeState()` (`worker/src/shape.ts`) turns the rows into one document, and `parseState()` checks it
     against the same zod contract the app uses (`shared/contract.ts`). A document that fails is never
     written: the last good one stays and the error goes to `state:last_error`.
3. `GET /api/state` returns the KV document with `cache-control: max-age=60`. Page requests never reach the
   warehouse, so visitors cannot add warehouse cost.
4. The app loads `/api/state`, and falls back to the committed `public/snapshot.json` if the Worker has
   nothing valid. It polls every 60 s. The header chip says which: "Live", "Snapshot" or "Simulated".

### Gold tables read

| Table | Used for |
|---|---|
| `kpi_summary` | Counter cards, change detection (`risk_updated_at`) |
| `station_status` | Pins, station list, reporting/stale |
| `segment_detail` | Segment panel: risk, score, surface and air temperature, 1 h change |
| `segment_drivers` | Risk drivers in the segment panel |
| `segment_history` (last 24 h) | Risk outlook chart |
| `incident_list` | Incident list and markers: one row per incident record, its position, nearest station within 5 km |
| `priority_list` | Gritting priority (overview panel, truck on the site) |
| `road_weather_observation_log` (newest row per station) | Dew point, precipitation, wind for weather effects |

The last read is a window function in the Worker, not a select on one table. It is the one known exception
to ADR-0009 here; the fix is a small `latest_readings` gold table.

### The state contract

`shared/contract.ts` is the single definition of the document, shared by Worker, app and tests:
`generated_at`, `source` (live, snapshot, scenario), `gold` timestamps, `kpi`, `stations`, `segments` (with
drivers and readings), `incidents` (with optional position and nearest station) and `history` keyed by
segment. Any change goes there first; both sides fail their tests until they agree.

## 3. The app

| Area | Files | Notes |
|---|---|---|
| State | `src/data/store.ts` (zustand), `live.ts`, `scenario.ts` | View (overview or site), selected site, segment and incident; scenario clock |
| Overview scene | `src/scene/Overview.tsx` | 600-unit plate from a 256×256 elevation grid, county border, roads, one pin per station, incident cones |
| Site scene | `src/scene/Site.tsx` and its parts | Terrain, road, risk band, trees, station with spinning wind gauge, cars, gritting truck, weather, barriers, incident cones |
| Panels | `src/app/*.tsx`, `src/styles/hud.css` | Header with search and site switcher, counters, segment detail, risk outlook, tabbed list, legend, camera controls |
| Pure logic | `src/data/corridor.ts`, `cars.ts`, `outlook.ts`, `geo.ts`, `src/app/listRows.ts`, `src/scene/dressing.ts` | Unit-tested; scenes only draw what these return |

### Scene scale

Sites are dioramas: the terrain shrinks to a 300-unit plate while road, cars, station and trees keep toy
sizes, because a 7 m road at true scale would be under a pixel wide. Vertical exaggeration is 2.4 on sites
and 7 on the overview. Cars move at 40 times real speed. Treelines (metres): coast 450, fjord 500, inland
550, mountain 650, warm 600. Constants live in `src/scene/scale.ts` and `dressing.ts`.

### Positions

The bake script and the app share one projection: metres east (x) and south (z) of an origin
(`project_local` in Python, `projectLocal` in `src/data/geo.ts`). A site's origin is its station; the
overview's origin is the county centre. `nearestAlong()` puts a point on the baked road to find "how far
along the road" an incident or closure is.

### Risk on the road

A road stretch takes the colour of the covering station within 5 km on the same road, the same rule as
`gold.map_points`, so the 3D road and the AI/BI map agree. Beyond 5 km the road is grey ("No coverage").

### Incidents

Each incident record in `gold.incident_list` carries its position and, when there is one, the nearest
monitored station on its road within 5 km. In the list, active incidents near a station come first.
Clicking a row:

- near a station: opens that station's site, selects its segment and marks the spot with a cone;
- far from any station: marks it on the county overview;
- scenario incident (no position): opens the site of its segment.

A live closure is drawn 250 m either side of its own spot on the road when its position is on the baked
road; otherwise 1 km either side of the station, labelled "position approximate". DATEX gives a point, not
the closed stretch.

### Scenarios

`public/scenarios/*.json` hold three scripted stories: snowstorm on E8, black ice in Lavangsdalen and a
quiet morning. Each is a list of timed patches over the live state, with a focus station and relative
history; counters are recounted from the simulated rows. Every simulated thing on screen carries
"Simulated", and simulated incident ids start with `sim-`.

## 4. Design decisions

| Decision | Why | Cost if wrong |
|---|---|---|
| Standalone page on Cloudflare, outside the MVP and the bundle (ADR-0010) | AI/BI cannot draw 3D; Databricks Apps on Free Edition stop after 24 h and need a login | A second front end to maintain |
| Worker holds the only credential; browser reads KV | No secret in the browser; visitors cannot drive warehouse cost | Data is up to 15 min old |
| Read plot-ready gold only (ADR-0009) | Same numbers as AI/BI; logic lives once, in gold | New widgets need gold changes first |
| One shared zod contract, validated before every KV write | A bad gold row can never blank the page | Contract changes touch three places |
| Snapshot fallback committed in the repo | The page works with no Worker, for demos and CI | The snapshot ages; refresh it after gold runs |
| Bake terrain and roads offline, commit the output | No map service at runtime; fast, free, deterministic | Re-run the bake when the seed changes |
| Diorama scale, not true scale | A true-scale road is invisible | Distances on screen are not to scale |
| Same 5 km coverage rule as `gold.map_points` | The 3D road and the AI/BI map never disagree | Long roads between stations stay grey |
| Cars are ambience, labelled so | No traffic data exists | Someone could still read them as traffic |
| Scenarios over the live state, always "Simulated" | Shows a bad day on a quiet day without faking live data | The label must never be dropped |

## 5. Data sources and attribution

| Source | Used for | Licence |
|---|---|---|
| Statens vegvesen NVDB (via `tools/mock_dashboards/nvdb_seed.sql`) | Roads, stations, segments | NLOD |
| Statens vegvesen DATEX (through the pipeline) | Road weather, incidents | NLOD |
| MET Norway, Open-Meteo (through the pipeline) | Weather fields | CC BY 4.0 |
| Mapzen Terrarium tiles on AWS (zoom 11 sites, zoom 8 overview) | Terrain | Mapzen terms, attribution in legend |
| Kartverket / Geonorge county outline (`fylke=55`) | County border | CC BY 4.0 |

## 6. Security

| Item | Status |
|---|---|
| Databricks credential | Server-side only: `showcase/.dev.vars` (gitignored) locally, a Wrangler secret on Cloudflare. Never in the browser, the repo or the snapshot |
| SQL | Fixed SELECTs with the catalog from configuration; no user input reaches a query |
| Warehouse cost from visitors | None: requests read KV only |
| Dev server | Vite is told not to serve `.dev.vars` or `.env*` (`vite.config.ts`) |
| Personal access token | **Open.** It carries the owner's full rights. Before a public launch, use a service principal with OAuth M2M, `SELECT` on the gold schema and `CAN USE` on one warehouse |
| `/api/health` | Says when the last refresh failed, with a generic message. The reason, which can name the workspace, goes to the Worker log and KV `state:last_error` only |
| Access to the page | Public by design (open data). Cloudflare Access can add a login without code |
| Warehouse wake-ups | The 15-min check wakes the warehouse up to 96 times a day; align the cron to the gold schedule to cut cost |

## 7. Scaling beyond Troms

| Concern | Today | For all of Norway |
|---|---|---|
| State document | 37 KB, 24 stations | Split per county (`/api/state/<county>`); load what is on screen |
| Statement API results | Inline, one chunk | Follow `next_chunk_internal_link`; cancel timed-out statements |
| Site assets | About 44 KB per station, loaded on demand | A few hundred stations is about 15 MB, still loaded one at a time; bake per county |
| Overview | One 256×256 grid of Troms | A national map that drills into counties, with terrain detail levels |
| Pipeline | `fylke=55` seed and gold | The real limit: seed, silver and gold must cover every county first |

## 8. Running and changing it

Commands are in `showcase/README.md`. In short:

```bash
cd showcase && npm ci && npm run dev                       # app on :5173, falls back to the snapshot
npm run build && npx wrangler dev --test-scheduled         # Worker on :8787, Vite proxies /api to it
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*" # run the cron once
curl -s http://localhost:8787/api/state > public/snapshot.json && npm run check
npm run check                                              # tsc + vitest (app and Worker)
uv run pytest tests/unit/test_bake_sites.py tests/unit/test_serving.py
```

When you change:

- **What the page shows from gold**: add a column or a table in `src/frostsight/serving.py` with a test in
  `tests/unit/test_serving.py`, deploy the bundle and run the gold job, then read it in
  `worker/src/queries.ts` and map it in `shape.ts`. Do not join or aggregate in the Worker.
- **The document**: change `shared/contract.ts` first, then the Worker fixture and tests, then the app.
- **Roads or stations**: re-run `tools/bake_sites.py` and commit `public/sites` and `public/overview`.

CI: `.github/workflows/showcase.yml` runs the app and Worker checks and the bake tests on changes under
`showcase/`.

## 9. Known gaps and future work

Known gaps:

- `latest_readings` is a window function in the Worker; move it to a gold table.
- The Worker ignores chunked Statement API results and does not cancel timed-out statements.
- Incidents refresh only when risk changes (the change check keys on `risk_updated_at`).
- The outlook shows nothing when history is empty, even when a scenario has a future.
- Accessibility: list and tab roles are incomplete, `--fg-3` text is about 2.9:1 contrast, and 3D pins
  cannot be reached by keyboard.
- Textures and replaced geometries are not disposed; the scenario bar re-renders every frame while playing.

Ideas:

- Forecast steps from gold once the pipeline carries a forecast (today only scenarios have a future).
- Group DATEX records of one situation into one incident row.
- Fly the camera to a picked incident on the overview.
- Colder sky below −5 °C, hover tags on all objects, km marks along the road.
- Service principal and Cloudflare Access before a public launch.
- Per-county state and a national overview for the rest of Norway.
- Deploy to Cloudflare (`showcase/README.md`, "Deploy to Cloudflare").
