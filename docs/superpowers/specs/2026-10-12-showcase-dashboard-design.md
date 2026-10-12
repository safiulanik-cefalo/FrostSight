# FrostSight Showcase: a 3D road-weather dashboard outside the MVP

Date: 2026-10-12. Owner: Safiul Anik. Status: draft for review.

## 1. What and why

A standalone, public web page that shows the FrostSight icing risk for Troms as a bright low-poly 3D world,
in the style of the WareTrack demo (`docs/wagetrack-ui-ux-demo.mov`): a diorama of a real road corridor
with the road coloured by risk, a weather station that reports, cars that drive, snow that falls, and a
barrier where the road is closed, surrounded by glass panels with the numbers. The approved design render
is at <https://claude.ai/artifact/Lptn3YcfGy2mnkPeT4Y3oj>.

It is a demo built in parallel with the MVP. It is not an MVP milestone, not in the Asset Bundle, and
does not replace the four AI/BI dashboards (decision of 2026-10-05, `docs/plan/07_M6_product.md`). It
reads the same plot-ready gold tables the AI/BI dashboards read (ADR-0009), so what it shows means the
same thing as the AI/BI risk map.

Success looks like: a person opens one URL, sees Troms, picks a station, flies into its corridor, reads the
current risk and its drivers, and can switch on a scripted snowstorm to see what the page does on a bad
day. It runs on Cloudflare's free tier and costs nothing to keep up.

## 2. Decisions already taken

| Topic | Decision |
|---|---|
| Framing | Demo in parallel, outside MVP milestones and the bundle |
| Scene | Corridor dioramas, one per weather station, plus a stylised county overview as the home scene |
| Data | Live gold by default, plus a scenario switch that plays scripted states, always labelled "Simulated" |
| Renderer | Three.js through React Three Fiber for both overview and sites, one renderer |
| Hosting | Cloudflare: one Worker that serves the static build, runs a cron and exposes one JSON route |
| Cars | Ambience only, labelled as such; speed and density follow the risk level |
| Closures | From live incidents when the feed has one on the corridor; otherwise only from scenarios |
| Place in repo | New top-level `showcase/` folder with its own toolchain; nothing in `src/`, `resources/` or `sql/` changes |

## 3. Architecture

```text
Databricks (Free Edition)                     Cloudflare                              Browser
gold.kpi_summary                              Worker  cron */15 min                   React + R3F app
gold.station_status          SQL Statement    ├─ query 8 gold tables                  ├─ GET /api/state → live state
gold.segment_detail      ───Execution API──▶  ├─ shape to state.json contract         ├─ scenarios/*.json → simulated state
gold.segment_drivers         (read-only PAT)  ├─ KV put  state:current                ├─ sites/<station_id>/{terrain.png,road.json}
gold.segment_history                          └─ GET /api/state (KV, max-age 60 s)    └─ overview/{county.json,roads.json}
gold.segment_incidents                        Static assets: the Vite build
gold.priority_list
gold.road_weather_observation_log
```

Three parts, each with one job:

1. **Bake script** (`showcase/tools/bake_sites.py`, run by hand, output committed). Turns reference data
   into static scene assets: one terrain heightmap and one road corridor per station, and the county
   outline plus simplified roads for the overview.
2. **Worker** (`showcase/worker/`). Every 15 minutes reads the plot-ready gold tables and writes one JSON
   document in the state contract to KV. Serves it on `GET /api/state`. Serves the built app as static
   assets. Holds the only Databricks credential.
3. **App** (`showcase/src/`). Renders the overview and the sites from the static assets, and colours and
   animates them from a state document, whether live from the Worker or simulated from a scenario file.

The browser never talks to Databricks. No secret ships to the browser. Nothing in the Databricks workspace
changes: no new table, job or grant, except a read-only token for the Worker (section 7).

### Design rule 2 and this showcase

`docs/plan/00_README.md` rule 2 says only `collector/` calls external URLs, and pipelines and jobs read
only the landing volume and Unity Catalog. The showcase is a consumer outside the platform, like a person
with a browser. The bake script fetches public reference data once, by hand. The Worker reads gold through
the SQL warehouse the same way the AI/BI dashboards do. Neither runs inside Databricks. ADR-0010 records
this (section 10).

## 4. Scene

### 4.1 Overview (home)

A stylised plate of Troms: the county polygon extruded a little above a pale water plane, the main roads
as thin ribbons (E6, E8, Rv and the Fv roads that carry a station), and one pin per station. Pins carry the
station's risk colour and a small pulse when reporting. Clicking a pin, or picking a site in the header
switcher, flies the camera into that site's diorama. The overview uses the same lighting, palette and
material style as the sites. It is a shape, not a map: no labels except the pins' hover tags.

Source for the outline: Kartverket's open administrative-units API (`ws.geonorge.no/kommuneinfo/v1`
area for county 55), simplified to about 600 vertices by the bake script. Roads: the committed NVDB road
lines in `tools/mock_dashboards/nvdb_seed.sql` (`seed_roads`, NLOD), simplified.

### 4.2 Site (corridor diorama)

One site per station in `silver.nvdb_seed_stations` (24 today). The bake script produces, per station:

- **Corridor**: the road polyline (`seed_roads` `line_no`) whose nearest point is closest to the station,
  cut to 6 km of path length on each side of that point, resampled every 25 m, projected to a local metre
  grid centred on the station (north up). Stored as `road.json`: `{station_id, origin:{lat,lon},
  points:[[x,z],...], km_marks:[{at_m, label}], station_at_m}`.
- **Terrain**: a 14 km by 14 km heightmap centred on the station, 128 by 128 samples, from Mapzen
  Terrarium elevation tiles on AWS Open Data at zoom 12 (free, no key; Norway coverage comes from
  Kartverket's DTM). Stored as a 16-bit greyscale PNG with `min_m` and `max_m` in `road.json`. Vertical
  exaggeration 1.6 in the scene so a fjord valley reads as one.
- **Dressing**, generated in the browser, deterministic per station id: trees below the local treeline
  (fewer and smaller with height, none within 7 m of the road, density by climate zone from the seed:
  coast and fjord dense, inland medium, mountain sparse), rock patches on steep high ground, snow cover
  that follows surface temperature from the state (below 0 °C white, above it grass shows through).

Scene objects and what drives them:

| Object | Shape | Driven by |
|---|---|---|
| Road ribbon | asphalt strip with dashed centre line and a snow shoulder | geometry only |
| Risk band | coloured band along both road edges, split into 2 km stretches | the station's `risk_level`, applied to stretches within `coverage_km` of the station (the same rule as `gold.map_points`); stretches beyond are grey "no coverage" |
| Station | pole, cabinet, mast with spinning anemometer, pin above | `station_status` (pin pulses when Reporting, grey when Stale), `wind_ms` sets anemometer speed |
| Cars | low-poly car bodies, one gritting truck | ambience; count and speed by `risk_level` (LOW 4 cars fast, VERY_HIGH 2 cars slow); the truck appears when the segment is in the top 5 of `priority_list`; cars never enter a closed stretch |
| Barrier | two posts, striped bar, sign | an active incident of type closure on the corridor, or a scenario closure; wears a "Simulated" tag when from a scenario |
| Precipitation | instanced particles | `precip_type` and `precip_mm_h`: snow flakes, rain streaks, none |
| Sky and light | pale blue, warm sun, soft shadows | `air_c` tints the sky slightly colder below −5 °C; otherwise constant |
| Hover tags | small white chips above station, truck, barrier | always on for those three; other objects show a chip on hover |

Camera: perspective, orbit with drag, zoom with wheel or the +/− buttons, rotate 30° per click, home
resets. Pitch limited between 12° and 78°. Fly-in from the overview is a 1.2 s eased move; respects
`prefers-reduced-motion` by cutting straight.

Performance budget: under 150 k triangles per site, one shadow-casting light, instanced trees and
particles, 60 fps on a 2020 laptop. Terrain 128 by 128 flat-shaded. Textures none except the particle
sprite.

## 5. HUD (panels)

Same layout as the render, built in React with plain CSS and design tokens. Light and dark themes.

- **Header**: brand, search (filters sites and segments by name or road), site switcher (tag with the
  road, station name, one-line summary; opens a grouped list by climate zone), Live chip with the data
  age in words ("12 min old"), scenario toggle, notification bell (count of segments at HIGH or above),
  viewer name placeholder "Road operations".
- **KPI cards** (top left): segments at HIGH or above of total, stations reporting of total, data age.
  From `kpi_summary`. On a site, the first card narrows to that road.
- **Camera controls** (right edge).
- **Detail panel** (right): the selected segment, from `segment_detail` and `segment_drivers`: risk pill
  and icing score bar, station status, surface and air temperature, 1 h change, driver rows with
  contribution chips, gritting rank from `priority_list`, the active incident if any. On the overview it
  shows the county: top 5 of `priority_list`.
- **Risk outlook** (bottom left): the last 24 h of `segment_history` for the selected segment as a step
  row (6 h, 3 h, now) plus the scenario's scripted future when a scenario is on. Live gold has no
  forecast today, so the live view shows history only and says so; forecast steps appear only in
  scenarios and are labelled "Simulated".
- **List** (bottom right): tabs Segments, Stations, Incidents. Active tab is a filled tinted pill. Rows:
  coloured dot, name, status pill, mini bar for icing score. Clicking a row selects it in the scene.
- **Legend** (bottom centre): the four risk colours and "Cars are ambience, not traffic".
- **Footer line** in the legend's chip on hover: "Road data Statens vegvesen (NLOD). Weather MET Norway and
  Open-Meteo (CC BY 4.0). Elevation Mapzen terrain tiles."

State shown as shape before words everywhere: dot plus one word, bar for a score, chip for a name.

Risk palette (validated with the dataviz checker, light surface): LOW `#2e9e5b`, MEDIUM `#c98a12`, HIGH
`#e0532f`, VERY_HIGH `#8e2f9c`, no coverage grey. Simulated is a separate indigo. Always paired with a
label, never colour alone.

## 6. State contract

One JSON document, `showcase/shared/contract.ts` is the single definition, used by the Worker, the app and
the scenario files. Field names follow the gold tables so a reader can trace a number back.

```ts
type State = {
  generated_at: string;           // ISO UTC, when the Worker built it
  source: "live" | "snapshot" | "scenario";
  scenario?: { id: string; title: string; step_s: number };
  gold: { risk_updated_at: string | null; computed_at: string | null };
  kpi: { segments_total: number; segments_high: number; segments_very_high: number;
         stations_total: number; stations_reporting: number; active_incidents: number };
  stations: Array<{ station_id: string; name: string; road: string; lat: number; lon: number;
         road_segment_id: string | null; status: "Reporting" | "Stale"; last_event_time: string | null;
         risk_level: Level | null; icing_score: number | null }>;
  segments: Array<{ road_segment_id: string; segment: string; road: string; station_id: string | null;
         risk_level: Level; icing_score: number; surface_c: number | null; air_c: number | null;
         change_1h_c: number | null; event_time: string | null; priority_rank: number | null;
         drivers: Array<{ factor: string; contribution: number }>;
         readings: { dew_point_c: number | null; precip_type: string | null; precip_mm_h: number | null;
                     wind_ms: number | null } }>;
  incidents: Array<{ incident_id: string; road: string; road_segment_id: string | null;
         incident_type: string; severity: string | null; start_time: string; end_time: string | null;
         description: string | null }>;
  history: Record<string, Array<{ t: string; level: Level; score: number }>>;  // by road_segment_id, 24 h
};
type Level = "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";
```

Source per field: `kpi` from `gold.kpi_summary`; `stations` from `gold.station_status`; `segments` from
`gold.segment_detail` joined in the Worker to `gold.segment_drivers` (by `segment`), `gold.priority_list`
(by `road_segment_id`) and the newest row per station of `gold.road_weather_observation_log` for
`readings` (dew point, precipitation, wind are not in `segment_detail`); `incidents` from
`gold.segment_incidents`; `history` from `gold.segment_history` where `event_time` is within 24 h.
Joining a handful of 24-row tables in the Worker is shaping for one consumer, not read-time aggregation
on a dashboard; if the showcase needs more than this, the right fix is a new plot-ready gold table.

A **snapshot** (`showcase/public/snapshot.json`) is a real state document captured from the Worker and
committed. The app uses it when `/api/state` fails or returns nothing, and marks the Live chip "Snapshot".

## 7. Worker

`showcase/worker/src/index.ts`, deployed with Wrangler. Bindings: KV namespace `STATE`, static assets
from `showcase/dist`, vars `DATABRICKS_HOST`, `DATABRICKS_WAREHOUSE_ID`, `CATALOG`; secret
`DATABRICKS_TOKEN`.

- **Cron** `*/15 * * * *`: for each of the eight tables, `POST /api/2.0/sql/statements` with
  `wait_timeout: "30s"`, `disposition: INLINE`, `format: JSON_ARRAY`, polling `GET
  /api/2.0/sql/statements/{id}` while the state is PENDING or RUNNING, at most 60 s in total. Shape the
  rows into the contract and `put` it at `state:current` with `generated_at`. On any failure keep the
  previous document and `put` an error note at `state:last_error`; the Live chip then shows the age of the
  document it has.
- **`GET /api/state`**: the KV document, `Cache-Control: public, max-age=60`, CORS same-origin only.
- **`GET /api/health`**: `generated_at`, `last_error`, no secrets.
- Everything else: the static asset.

Credential: on Free Edition there are no service principals, so the token is a personal access token of
the deploying user, created for this purpose and granted nothing beyond `USE CATALOG`, `USE SCHEMA` and
`SELECT` on `gold` (already true for the user). On the paid workspace it becomes a service principal with
the same grants from `sql/001_catalog_schemas_volume.sql`. The token lives only in Wrangler secrets.

Cost: 96 cron runs a day, 8 statements each, on a warehouse that otherwise idles. Free on Free Edition.
If gold is unchanged since the previous run (`risk_updated_at` equal), skip the other seven statements.

## 8. Scenarios

`showcase/public/scenarios/<id>.json`: `{id, title, blurb, base: "snapshot", duration_s, steps:
[{at_s, patch}]}` where `patch` is a partial State deep-merged over the base. The player applies steps on a
clock the viewer can pause and scrub; the header chip says "Simulated · <title>" while one is active and
the legend gains a "Simulated" entry. Three ship:

1. **Snowstorm on E8**: Bossovarri, Gardeborri and Galgo climb MEDIUM, HIGH, VERY_HIGH over 90 s; snow
   intensity rises; a closure appears at Gardeborri; the gritting truck arrives at Bossovarri.
2. **Black ice in Lavangsdalen**: clear sky, surface falls through 0 °C with a tiny dew-point gap; the risk
   jumps to HIGH with no precipitation, to show that icing is not only snow.
3. **Quiet morning**: everything LOW, light traffic, sun. The baseline.

Scenario files are data, validated against the contract in a unit test.

## 9. Repo, toolchain, quality

```text
showcase/
  README.md                 how to run, bake, deploy; attribution
  package.json              vite, react 18, typescript, three, @react-three/fiber, @react-three/drei, zustand, vitest, wrangler
  index.html  vite.config.ts  tsconfig.json  wrangler.toml
  shared/contract.ts        the State type, level colours, pure helpers (shared by app and worker)
  src/
    app/        HUD components (Header, KpiCards, DetailPanel, Outlook, ListPanel, Legend, CameraControls)
    scene/      R3F components (Overview, Site, Terrain, Road, RiskBand, Station, Cars, Barrier, Weather, Trees, CameraRig)
    data/       useState store, live loader, snapshot fallback, scenario player, corridor and colour helpers
    styles/     tokens.css, hud.css
  worker/src/index.ts       cron, shaping, routes
  tools/bake_sites.py       PEP 723 script, run with `uv run showcase/tools/bake_sites.py`
  public/
    sites/<station_id>/terrain.png, road.json
    overview/county.json, roads.json
    scenarios/*.json
    snapshot.json
```

Kept out of the platform: `databricks.yml` gets `sync: exclude: ["showcase/**"]`; `pyproject.toml`
leaves ruff on so the bake script is linted; pytest stays on `tests/unit`. A new GitHub workflow
`showcase.yml` runs on changes under `showcase/**`: `npm ci`, `tsc --noEmit`, `vitest run`, `vite build`,
`wrangler deploy --dry-run`. Deploys are by hand with `wrangler deploy` until the demo is stable.

Tests, all pure logic, test-first:

- `shared`: level colours and labels; contract validation of the three scenario files and the snapshot.
- `data`: corridor cutting (6 km each side, resample 25 m) on a synthetic polyline; coverage rule
  colouring stretches; scenario patch application and step selection by time; live-then-snapshot fallback.
- `worker`: shaping from fixture rows of each gold table to a State; skip rule when `risk_updated_at` is
  unchanged; error path keeps the previous document.
- `tools`: heightmap decoding of a Terrarium tile fixture and the projection to the local metre grid
  (Python, in `tests/unit/test_bake_sites.py`).

Scene rendering is checked by eye with one Playwright screenshot per scene type in the README's checklist,
not by automated pixel tests.

## 10. Honesty on screen

- Cars are never presented as traffic. The legend says so; the README says so.
- Anything a scenario puts on screen wears "Simulated".
- The live risk colour on a stretch of road follows the same coverage rule as the AI/BI map, so the two
  never disagree.
- Forecast steps exist only in scenarios until gold carries a forecast.
- Attribution: Statens vegvesen (NLOD), MET Norway and Open-Meteo (CC BY 4.0), Mapzen terrain tiles, in
  the legend and the README.

ADR-0010, "Showcase dashboard outside the MVP", records the framing, the consumer-outside-the-platform
reading of design rule 2, the Cloudflare hosting, the personal-token interim, and that the showcase does
not replace the AI/BI dashboards.

## 11. Out of scope

Authentication, per-user settings, alerts, a mobile layout beyond "readable and not broken", real-time
vehicle data, forecasts in gold, moving the showcase into the bundle, any change to pipelines or jobs.

## 12. Answers from the user (2026-10-12)

- The Worker may use a personal access token on the personal workspace for now.
- Develop locally first; the Cloudflare account and hostname are chosen after the local demo.
