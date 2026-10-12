# FrostSight Showcase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone 3D web page under `showcase/` that renders Troms icing risk as low-poly corridor dioramas fed by the plot-ready gold tables, with scripted scenarios, runnable locally now and deployable to Cloudflare later.

**Architecture:** Three parts with one shared contract. A Python bake script turns committed NVDB road lines, the county outline and free elevation tiles into static scene assets. A Cloudflare Worker shapes eight gold tables into one JSON state document on a cron and serves it. A React Three Fiber app renders overview and sites from the assets and colours and animates them from a state document, live or simulated.

**Tech Stack:** TypeScript strict, React 19, @react-three/fiber 9, @react-three/drei 10, three ≥ 0.170, zustand 5, zod 3, Vite 6, Vitest 3, Wrangler 4 (Workers static assets, KV, cron), Python 3.12 bake script with numpy and Pillow (PEP 723 metadata), pytest for its pure functions.

**Spec:** `docs/superpowers/specs/2026-10-12-showcase-dashboard-design.md`

## Global Constraints

- Everything lives under `showcase/` plus: `databricks.yml` gains `sync: exclude: ["showcase/**"]`, `pyproject.toml` dev group gains `numpy` and `pillow`, `tests/unit/test_bake_sites.py`, `docs/adr/0010-showcase-dashboard-outside-the-mvp.md`, `.github/workflows/showcase.yml`. Nothing in `src/`, `resources/`, `sql/`, `collector/` changes.
- Risk levels are exactly `LOW`, `MEDIUM`, `HIGH`, `VERY_HIGH`. Colours: LOW `#2e9e5b`, MEDIUM `#c98a12`, HIGH `#e0532f`, VERY_HIGH `#8e2f9c`, no coverage `#8a95ab`, simulated `#5b4bd6`. A colour is always paired with a label.
- Coverage rule: a stretch takes the station's level when its midpoint is within 5000 m of the station along the road, else `NONE`. Stretches are 2000 m. Corridor is 6 km each side of the station, resampled every 25 m.
- Timestamps are ISO 8601 UTC strings in the contract; the UI formats for display.
- No secret in the repo or in the browser. `DATABRICKS_TOKEN` exists only in `showcase/.dev.vars` (gitignored) and Wrangler secrets.
- Copy: anything from a scenario wears "Simulated"; the legend says "Cars are ambience, not traffic"; attribution text is "Road data Statens vegvesen (NLOD). Weather MET Norway and Open-Meteo (CC BY 4.0). Elevation Mapzen terrain tiles."
- Active tab or switcher item is a filled tinted pill (`--accent-soft` background, accent text, weight 700), never a side bar.
- Node 24, npm 11. `npm run check` = `tsc --noEmit && vitest run`. Commit after every task with the attribution lines the session reminder gives.
- Deviation from the spec, decided here: the heightmap is stored as `terrain.bin` (little-endian Uint16, row-major, 128 by 128, north row first) instead of a 16-bit PNG, because canvas decoding in the browser truncates PNG to 8 bits. `road.json` carries `min_m` and `max_m`; height = `min_m + v / 65535 * (max_m - min_m)`.

## Review Focus

1. A station with no current risk (`risk_level` null in `station_status`, no row in `segment_detail`): the site renders with every stretch `NONE`, the detail panel says "No current risk for this station", nothing throws. Pinned in Task 4 (`stretches` with `level: null`) and Task 10 (DetailPanel with no segment).
2. The Worker is unreachable or returns an invalid document: the app loads `/snapshot.json`, the Live chip reads "Snapshot" and the data age comes from the snapshot's `gold.risk_updated_at`. Pinned in Task 4 (`loadState` fallback).
3. A station near a road end, where one side has less than 6 km of road: the corridor is cut at the road end, `station_at_m` is less than 6000 on that side, and `stretches` still cover the whole corridor. Pinned in Task 3 (`cut_corridor` clamp) and Task 4.
4. A scenario patch naming a `road_segment_id` or `station_id` the base lacks: the item is appended, not dropped, so a scenario can introduce a closure or a segment the live data does not have. Pinned in Task 4 (`applyPatch`).
5. A segment with no history in the last 24 h: the outlook shows "No readings in the last 24 h" and no steps. Pinned in Task 4 (`outlookSteps` returns `[]`) and Task 10.

---

### Task 1: Scaffold and shared contract

**Files:**
- Create: `showcase/package.json`, `showcase/tsconfig.json`, `showcase/vite.config.ts`, `showcase/vitest.config.ts`, `showcase/index.html`, `showcase/src/main.tsx`, `showcase/src/App.tsx`, `showcase/.gitignore`, `showcase/README.md`
- Create: `showcase/shared/contract.ts`
- Test: `showcase/shared/contract.test.ts`
- Modify: `databricks.yml` (add top-level `sync:` block after `include:`)

**Interfaces:**
- Produces: `type Level = "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH"`; `const LEVELS: readonly Level[]`; `type LevelOrNone = Level | "NONE"`; `const LEVEL_COLOR: Record<LevelOrNone, string>`; `const SIMULATED_COLOR: string`; `levelLabel(level: Level | null): string` returning `Low`, `Medium`, `High`, `Very high`, `No data`; `type State`, `type Station`, `type Segment`, `type Incident`, `type HistoryPoint` exactly as spec section 6; `const StateSchema: z.ZodType<State>`; `parseState(json: unknown): State` (throws `ZodError`); `dataAgeMinutes(iso: string, now: Date): number`; `ageLabel(minutes: number): string` returning `just now` below 1, `12 min old` below 90, `3 h old` otherwise, `2 d old` from 48 h.

- [ ] **Step 1: Scaffold the app**

Run from the repo root: `npm create vite@latest showcase -- --template react-ts`, then in `showcase/`: `npm i three @react-three/fiber@9 @react-three/drei@10 zustand@5 zod@3` and `npm i -D @types/three vitest@3 wrangler@4 @cloudflare/workers-types`. Set `"type": "module"`, scripts `dev`, `build`, `preview`, `test: "vitest run"`, `check: "tsc --noEmit && vitest run"`, `bake: "uv run tools/bake_sites.py --out public"`. `tsconfig.json`: `strict: true`, `include: ["src", "shared", "worker", "vite.config.ts"]`, `types: ["@cloudflare/workers-types", "vite/client"]`. `vitest.config.ts`: `environment: "node"`, `include: ["src/**/*.test.ts", "shared/**/*.test.ts", "worker/**/*.test.ts"]`. `showcase/.gitignore`: `node_modules`, `dist`, `.dev.vars`, `.wrangler`. `App.tsx` renders the text "FrostSight showcase" for now.

- [ ] **Step 2: Add the bundle sync exclusion**

In `databricks.yml` after the `include:` list add:

```yaml
sync:
  exclude:
    - showcase/**
```

Run: `databricks bundle validate -t personal`. Expected: `Validation OK!`.

- [ ] **Step 3: Write the failing contract tests**

`showcase/shared/contract.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LEVELS, LEVEL_COLOR, levelLabel, parseState, dataAgeMinutes, ageLabel } from "./contract";

const minimal = {
  generated_at: "2026-10-12T09:28:00Z", source: "live",
  gold: { risk_updated_at: "2026-10-12T09:20:00Z", computed_at: "2026-10-12T09:28:00Z" },
  kpi: { segments_total: 24, segments_high: 3, segments_very_high: 0, stations_total: 24, stations_reporting: 22, active_incidents: 1 },
  stations: [{ station_id: "3000014", name: "Bossovarri", road: "E8", lat: 69.1202, lon: 20.74511, road_segment_id: "1125788-27-9",
               status: "Reporting", last_event_time: "2026-10-12T09:20:00Z", risk_level: "HIGH", icing_score: 0.72 }],
  segments: [{ road_segment_id: "1125788-27-9", segment: "E8 · Bossovarri", road: "E8", station_id: "3000014", risk_level: "HIGH",
               icing_score: 0.72, surface_c: -3.1, air_c: -2.4, change_1h_c: -0.8, event_time: "2026-10-12T09:20:00Z", priority_rank: 2,
               drivers: [{ factor: "Snow", contribution: 0.41 }],
               readings: { dew_point_c: -3.4, precip_type: "SNOW", precip_mm_h: 2.4, wind_ms: 11 } }],
  incidents: [], history: { "1125788-27-9": [{ t: "2026-10-12T06:00:00Z", level: "MEDIUM", score: 0.48 }] },
};

describe("contract", () => {
  it("lists the four levels in order with their colours", () => {
    expect(LEVELS).toEqual(["LOW", "MEDIUM", "HIGH", "VERY_HIGH"]);
    expect(LEVEL_COLOR).toEqual({ LOW: "#2e9e5b", MEDIUM: "#c98a12", HIGH: "#e0532f", VERY_HIGH: "#8e2f9c", NONE: "#8a95ab" });
    expect(levelLabel("VERY_HIGH")).toBe("Very high");
    expect(levelLabel(null)).toBe("No data");
  });
  it("parses a valid state and rejects a bad level", () => {
    expect(parseState(minimal).stations[0].name).toBe("Bossovarri");
    expect(() => parseState({ ...minimal, stations: [{ ...minimal.stations[0], risk_level: "EXTREME" }] })).toThrow();
  });
  it("describes data age in words", () => {
    const now = new Date("2026-10-12T09:40:00Z");
    expect(dataAgeMinutes("2026-10-12T09:28:00Z", now)).toBe(12);
    expect(ageLabel(0.4)).toBe("just now");
    expect(ageLabel(12)).toBe("12 min old");
    expect(ageLabel(185)).toBe("3 h old");
    expect(ageLabel(60 * 50)).toBe("2 d old");
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd showcase && npx vitest run shared`. Expected: FAIL, module `./contract` not found.

- [ ] **Step 5: Implement `showcase/shared/contract.ts`**

Export the types and functions in the Interfaces block. Build `StateSchema` with zod from the spec's type (nullable fields as `.nullable()`, `source` as an enum of `live`, `snapshot`, `scenario`, `scenario` object optional, `history` as `z.record(z.array(...))`). `type State = z.infer<typeof StateSchema>`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd showcase && npm run check`. Expected: tsc clean, 3 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add showcase databricks.yml
git commit -m "Scaffold the showcase app and its shared state contract"
```

---

### Task 2: Worker: gold tables to one state document

**Files:**
- Create: `showcase/wrangler.toml`, `showcase/worker/src/env.ts`, `showcase/worker/src/databricks.ts`, `showcase/worker/src/queries.ts`, `showcase/worker/src/shape.ts`, `showcase/worker/src/index.ts`
- Create: `showcase/worker/fixtures/gold_rows.json` (hand-written rows for the 8 tables, 2 stations: Bossovarri with risk HIGH and a closure incident, Gardeborri stale with no `segment_detail` row)
- Create: `showcase/public/snapshot.json` (placeholder, written by the shape test's fixture until Task 12 replaces it)
- Test: `showcase/worker/src/databricks.test.ts`, `showcase/worker/src/shape.test.ts`, `showcase/worker/src/index.test.ts`

**Interfaces:**
- Consumes: `parseState`, `State` from `shared/contract.ts`.
- Produces: `type Env = { STATE: KVNamespace; ASSETS: Fetcher; DATABRICKS_HOST: string; DATABRICKS_WAREHOUSE_ID: string; CATALOG: string; DATABRICKS_TOKEN: string }`; `type Row = Record<string, string | number | boolean | null>`; `runStatement(env: Env, sql: string, fetchFn?: typeof fetch): Promise<Row[]>`; `type TableKey = "kpi_summary" | "station_status" | "segment_detail" | "segment_drivers" | "segment_history" | "segment_incidents" | "priority_list" | "latest_readings"`; `const QUERIES: Record<TableKey, (catalog: string) => string>`; `type GoldRows = Record<TableKey, Row[]>`; `shapeState(rows: GoldRows, generatedAt: string): State`; `refresh(env: Env, now: Date, fetchFn?: typeof fetch): Promise<"updated" | "unchanged" | "failed">`; default export `{ fetch(request, env): Promise<Response>; scheduled(controller, env): Promise<void> }`.
- KV keys: `state:current` (the State JSON), `state:last_error` (`{ at: string; message: string }`).
- Routes: `GET /api/state` → KV doc, `Cache-Control: public, max-age=60`, 404 `{error:"no state yet"}` when empty; `GET /api/health` → `{ generated_at, risk_updated_at, last_error }`; anything else → `env.ASSETS.fetch(request)`.

- [ ] **Step 1: Write `wrangler.toml`**

`name = "frostsight-showcase"`, `main = "worker/src/index.ts"`, `compatibility_date = "2026-09-01"`, `[assets] directory = "./dist"`, `binding = "ASSETS"`, `not_found_handling = "single-page-application"`, `[[kv_namespaces]] binding = "STATE"`, `id = "local"` (replaced at Cloudflare setup), `[triggers] crons = ["*/15 * * * *"]`, `[vars] DATABRICKS_HOST = "https://REPLACE.cloud.databricks.com"`, `DATABRICKS_WAREHOUSE_ID = "REPLACE"`, `CATALOG = "frostsight"`. Document in the README that `.dev.vars` overrides the vars locally and holds `DATABRICKS_TOKEN`.

- [ ] **Step 2: Write the failing `runStatement` test**

`databricks.test.ts`: stub `fetchFn` with a queue of responses. Case 1: POST returns `{statement_id:"s1", status:{state:"SUCCEEDED"}, manifest:{schema:{columns:[{name:"a"},{name:"b"}]}}, result:{data_array:[["1","x"]]}}` → resolves `[{a:"1", b:"x"}]`, and the POST body contains `warehouse_id`, `wait_timeout: "30s"`, `disposition: "INLINE"`, `format: "JSON_ARRAY"`, header `Authorization: Bearer tok`. Case 2: POST returns `PENDING`, first GET `/api/2.0/sql/statements/s1` returns `RUNNING`, second returns `SUCCEEDED` with rows → resolves the rows. Case 3: state `FAILED` with `status.error.message: "boom"` → rejects with an error whose message contains `boom`.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd showcase && npx vitest run worker/src/databricks`. Expected: FAIL, module not found.

- [ ] **Step 4: Implement `env.ts` and `databricks.ts`**

`runStatement` posts to `${env.DATABRICKS_HOST}/api/2.0/sql/statements/`, polls every 2 s until not `PENDING`/`RUNNING`, gives up after 60 s with an error, maps `data_array` rows to objects by `manifest.schema.columns[i].name`. Numbers stay strings as the API returns them; `shapeState` converts.

- [ ] **Step 5: Run it to verify it passes**

Run: `cd showcase && npx vitest run worker/src/databricks`. Expected: 3 PASS.

- [ ] **Step 6: Write the failing `shapeState` test**

`shape.test.ts` loads `../fixtures/gold_rows.json` and asserts: `parseState(shapeState(rows, "2026-10-12T09:28:00Z"))` does not throw; `kpi.segments_high` equals the fixture's `segments_high`; the Bossovarri segment has `priority_rank` from `priority_list`, `drivers` from `segment_drivers` joined on `segment`, `readings.precip_mm_h` from `latest_readings`; the Gardeborri station appears in `stations` with `status: "Stale"` and `risk_level: null` and has no entry in `segments`; the closure incident maps to `road_segment_id` of the Bossovarri segment via `road_key`; `history["1125788-27-9"]` has the fixture's rows sorted ascending by `t`; numeric strings become numbers.

- [ ] **Step 7: Run it to verify it fails**

Run: `cd showcase && npx vitest run worker/src/shape`. Expected: FAIL.

- [ ] **Step 8: Implement `queries.ts` and `shape.ts`**

`QUERIES`: `SELECT * FROM {catalog}.gold.<table>` for the first seven; `segment_history` adds `WHERE event_time >= current_timestamp() - INTERVAL 24 HOURS`; `latest_readings` is `SELECT station_id, dew_point_c, precipitation_type, precipitation_intensity_mm_h, wind_speed_ms FROM {catalog}.gold.road_weather_observation_log QUALIFY row_number() OVER (PARTITION BY station_id ORDER BY event_time DESC) = 1`. `shapeState` joins as the spec's section 6 says; `incidents[].road_segment_id` is the `segment_detail.road_segment_id` whose `road_key` matches, else null; timestamps pass through as ISO strings (Databricks returns `2026-10-12T09:20:00.000Z` style, keep as is).

- [ ] **Step 9: Run it to verify it passes, write the placeholder snapshot**

Run: `cd showcase && npx vitest run worker/src/shape`. Expected: PASS. Then add `showcase/worker/write_fixture_snapshot.ts`, run once with `npx tsx worker/write_fixture_snapshot.ts`, which writes `shapeState(fixture, "2026-10-12T09:28:00Z")` to `public/snapshot.json` with `source: "snapshot"`.

- [ ] **Step 10: Write the failing handler tests**

`index.test.ts` with an in-memory `KVNamespace` stub (`get`, `put`) and a stubbed `fetchFn`:

```ts
it("refresh writes state:current and returns updated", async () => { /* fetchFn answers 8 statements from the fixture; expect KV state:current parses; result "updated" */ });
it("refresh skips the other seven statements when risk_updated_at is unchanged", async () => { /* KV holds a doc with the same gold.risk_updated_at; expect only 1 POST; result "unchanged"; generated_at updated */ });
it("refresh keeps the previous document and records the error on failure", async () => { /* fetchFn rejects; expect state:current untouched, state:last_error.message set; result "failed" */ });
it("GET /api/state serves the document with max-age=60 and 404 when empty", async () => { ... });
it("GET /api/health reports generated_at and last_error", async () => { ... });
```

- [ ] **Step 11: Run them to verify they fail**

Run: `cd showcase && npx vitest run worker/src/index`. Expected: FAIL.

- [ ] **Step 12: Implement `index.ts`**

`refresh` runs `QUERIES.kpi_summary` first, compares `risk_updated_at` with the stored document, then the other seven in parallel with `Promise.all`. `scheduled` calls `refresh(env, new Date())`. `fetch` routes as the Interfaces block says.

- [ ] **Step 13: Run all worker tests, then the local Worker**

Run: `cd showcase && npm run check`. Expected: PASS. Then `npx wrangler dev --test-scheduled` and in another shell `curl -s localhost:8787/api/health`. Expected: JSON with `generated_at: null` (no `.dev.vars` yet, so no refresh has run; the cron trigger is exercised in Task 12).

- [ ] **Step 14: Commit**

```bash
git add showcase
git commit -m "Add the showcase Worker that shapes gold into one state document"
```

---

### Task 3: Bake script: corridors, terrain and the county overview

**Files:**
- Create: `showcase/tools/bake_sites.py`
- Test: `tests/unit/test_bake_sites.py`
- Create: `tests/fixtures/terrarium_tile.png` (a 256 by 256 Terrarium-encoded PNG generated by the test setup, not downloaded)
- Modify: `pyproject.toml` (dev group: add `numpy`, `pillow`)
- Output (committed): `showcase/public/sites/<station_id>/road.json`, `terrain.bin` for all 24 stations; `showcase/public/overview/county.json`, `roads.json`

**Interfaces:**
- Produces, in `bake_sites.py` (pure, no I/O): `parse_wkt_linestring(wkt: str) -> list[tuple[float, float]]` (lon, lat pairs); `load_seed(sql_text: str) -> tuple[list[Road], list[Station]]` where `Road = {road_category, road_number, line_no, points}` and `Station = {station_id, name, road_category, road_number, lat, lon, climate, road_segment_id}` as dataclasses; `project_local(lon: float, lat: float, lon0: float, lat0: float) -> tuple[float, float]` returning `(x_east_m, z_south_m)`; `cumulative_m(points_xz) -> list[float]`; `nearest_index(points_xz, target_xz) -> int`; `cut_corridor(points_xz, station_idx, half_m=6000.0, step_m=25.0) -> tuple[list[tuple[float, float]], float]` returning resampled points and `station_at_m`; `pick_road(roads, station) -> Road` (same category and number, nearest point); `decode_terrarium(rgb: np.ndarray) -> np.ndarray` (`R*256 + G + B/256 - 32768`); `tile_xy(lon, lat, z) -> tuple[int, int]`; `resample_box(elev_fn, origin, size_m=14000.0, n=128) -> np.ndarray`; `encode_heights(hm) -> tuple[bytes, float, float]` (Uint16 LE, min, max); `simplify(points, tol_m) -> list` (Douglas-Peucker).
- Output shapes: `road.json` = `{station_id, name, road, climate, origin:{lat,lon}, points:[[x,z],...], station_at_m, length_m, km_marks:[{at_m, label}], terrain:{n:128, size_m:14000, min_m, max_m}}` with a km mark every 2000 m labelled `km <n>` counting from the corridor start; `county.json` = `{origin:{lat,lon}, rings:[[[x,z],...]]}`; `roads.json` = `[{road:"E6", points:[[x,z],...]}, ...]` in the county grid, simplified to 100 m.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_bake_sites.py` loads the script with `importlib.util.spec_from_file_location("bake_sites", "showcase/tools/bake_sites.py")`. Tests: `parse_wkt_linestring("LINESTRING (17.694 68.65267, 17.705 68.654)")` → two tuples; `load_seed` on a 3-line excerpt (one `seed_roads` row, one `seed_stations` row) returns one road and one station with the right fields; `project_local(20.75, 69.13, 20.74511, 69.1202)` → x within 2 % of `0.00489 * cos(69.12°) * 111320`, z negative (north is negative z); `cut_corridor` on a straight 20 km line with the station at 15 km → `station_at_m == 6000` and length 11000 (clamped at the far end), points spaced 25 m within 0.01; the same line with the station at 2 km → `station_at_m == 2000`; `decode_terrarium` of pixel `(128, 0, 0)` → 0.0 and `(129, 0, 0)` → 256.0; `encode_heights` of `[[0, 100]]` → bytes `00 00 ff ff`, min 0, max 100; `simplify` of a 3-point line with a 1 m bump at 10 m tolerance → 2 points.

- [ ] **Step 2: Run them to verify they fail**

Run: `uv sync && uv run pytest tests/unit/test_bake_sites.py -v`. Expected: FAIL, file not found.

- [ ] **Step 3: Implement the pure functions and the CLI**

PEP 723 header: `# /// script` with `dependencies = ["numpy", "pillow"]`, `requires-python = ">=3.12"`. CLI `--out`, `--seed` (default `tools/mock_dashboards/nvdb_seed.sql`), `--station` (repeatable), `--skip-terrain`, `--skip-overview`. Terrain tiles from `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` at z 12 with `urllib.request`, cached under `showcase/.cache/tiles/`. County outline from `https://ws.geonorge.no/kommuneinfo/v1/fylker/55/omrade?utkoordsys=4326`, rings simplified to 300 m. Overview roads: every `seed_roads` line, simplified to 100 m, projected on the county centroid. Vertical exaggeration is applied in the scene, not here.

- [ ] **Step 4: Run the tests to verify they pass, then bake**

Run: `uv run pytest tests/unit/test_bake_sites.py -v`. Expected: PASS. Then `cd showcase && npm run bake`. Expected: 24 site folders and the two overview files; `road.json` for `3000014` has `station_at_m` near 6000 and `terrain.max_m` above 800 (Bossovarri is a mountain pass). `uv run ruff check showcase/tools && uv run ruff format --check showcase/tools` clean.

- [ ] **Step 5: Commit**

```bash
git add showcase/tools showcase/public/sites showcase/public/overview tests/unit/test_bake_sites.py pyproject.toml uv.lock
git commit -m "Bake corridor, terrain and overview assets for the showcase"
```

---

### Task 4: App data layer

**Files:**
- Create: `showcase/src/data/corridor.ts`, `showcase/src/data/scenario.ts`, `showcase/src/data/live.ts`, `showcase/src/data/cars.ts`, `showcase/src/data/outlook.ts`, `showcase/src/data/assets.ts`, `showcase/src/data/store.ts`
- Test: one `.test.ts` beside each of the first five

**Interfaces:**
- Consumes: `State`, `Level`, `LevelOrNone`, `parseState` from `shared/contract.ts`.
- Produces:
  - `type RoadJson` matching Task 3's `road.json`; `type SiteAssets = { road: RoadJson; heights: Float32Array }`; `loadSiteAssets(stationId: string, fetchFn?: typeof fetch): Promise<SiteAssets>` (cached per id; decodes `terrain.bin` with `min_m`, `max_m`).
  - `type Stretch = { start_m: number; end_m: number; level: LevelOrNone; closed: boolean; simulated: boolean }`; `stretches(lengthM: number, stationAtM: number, level: Level | null, closures: Array<{ start_m: number; end_m: number; simulated: boolean }>, stretchM?: number, coverageM?: number): Stretch[]`; `pointAt(points: [number, number][], atM: number, stepM?: number): { x: number; z: number; tx: number; tz: number }` (unit tangent).
  - `type Patch` (deep partial of `State`; `stations`, `segments`, `incidents` arrays merged by id); `type Scenario = { id: string; title: string; blurb: string; duration_s: number; closures?: Array<{ at_s: number; station_id: string; start_m: number; end_m: number }>; outlook?: Array<{ at_h: number; level: Level; score: number }>; steps: Array<{ at_s: number; patch: Patch }> }`; `const ScenarioSchema`; `applyPatch(base: State, patch: Patch): State`; `stateAt(scenario: Scenario, base: State, tS: number): State` (source `scenario`, `scenario: { id, title, step_s: tS }`); `closuresAt(scenario, tS): Array<{ station_id; start_m; end_m }>`.
  - `loadState(fetchFn?: typeof fetch): Promise<{ state: State; via: "live" | "snapshot" }>`.
  - `carPlan(level: LevelOrNone): { count: number; speed_mps: number }` with LOW 4/22, MEDIUM 4/18, HIGH 3/13, VERY_HIGH 2/8, NONE 3/18; `openRanges(lengthM: number, closures: Array<{ start_m; end_m }>): Array<[number, number]>`; `advanceCar(posM: number, dir: 1 | -1, speedMps: number, dtS: number, range: [number, number]): number` (wraps inside the range).
  - `type OutlookStep = { label: string; at: string; level: Level; score: number; simulated: boolean }`; `outlookSteps(history: HistoryPoint[], now: Date, future?: Array<{ at_h: number; level: Level; score: number }>): OutlookStep[]` with labels `6 h ago`, `3 h ago`, `Now`, then `+3 h` style for future; `[]` when history is empty.
  - Store (zustand): `useShowcase` with `{ live: State | null; via: "live" | "snapshot" | null; scenario: Scenario | null; clockS: number; playing: boolean; view: "overview" | "site"; siteId: string | null; segmentId: string | null; tab: "segments" | "stations" | "incidents"; query: string }` and actions `boot()`, `setScenario(s | null)`, `tick(dtS)`, `seek(tS)`, `togglePlay()`, `goOverview()`, `goSite(stationId)`, `select(segmentId | null)`, `setTab`, `setQuery`; selector `current(): State | null` returning `stateAt(scenario, live, clockS)` when a scenario is on, else `live`.

- [ ] **Step 1: Write the failing tests**

`corridor.test.ts`: `stretches(11000, 6000, "HIGH", [])` → 6 stretches with ends `[2000,4000,6000,8000,10000,11000]`, every level `HIGH` (the last midpoint, 10500, is 4500 m from the station); `stretches(14000, 2000, "HIGH", [])` → 7 stretches, levels `HIGH, HIGH, HIGH, HIGH, NONE, NONE, NONE` (midpoints 1000, 3000, 5000, 7000 are within 5000 m; 9000 is not); `stretches(12000, 6000, null, [])` → every level `NONE`; a closure `{start_m: 2000, end_m: 4000, simulated: true}` marks exactly the second stretch `closed: true, simulated: true`; `pointAt([[0,0],[25,0],[50,0]], 30)` → `{x: 30, z: 0, tx: 1, tz: 0}`.

`scenario.test.ts`: `applyPatch` merges a station by `station_id` (changes `risk_level` only), appends a segment with an unknown `road_segment_id`, replaces `history["id"]` wholesale, leaves untouched keys equal; `stateAt` applies steps up to `tS` in order and marks `source: "scenario"`; `closuresAt` returns closures with `at_s <= tS`.

`live.test.ts`: `fetchFn` returns 200 with a valid state → `via: "live"`; returns 404 then the snapshot → `via: "snapshot"` and `state.source === "snapshot"`; returns 200 with invalid JSON then the snapshot → `via: "snapshot"`.

`cars.test.ts`: `carPlan("LOW")` → `{count: 4, speed_mps: 22}`; `openRanges(12000, [{start_m: 4000, end_m: 6000}])` → `[[0,4000],[6000,12000]]`; `advanceCar(3990, 1, 20, 1, [0, 4000])` → `10` (wrapped); `advanceCar(5, -1, 20, 1, [0, 4000])` → `3985`.

`outlook.test.ts`: history at 06:00 (MEDIUM .48), 06:40, 09:20 (HIGH .72), now 09:40 → labels `["6 h ago","3 h ago","Now"]` with the readings nearest 03:40, 06:40, 09:40 → levels `MEDIUM, MEDIUM, HIGH` (the 03:40 target picks the nearest, 06:00); empty history → `[]`; `future: [{at_h: 3, level: "HIGH", score: .78}]` adds `{label: "+3 h", simulated: true}`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd showcase && npx vitest run src/data`. Expected: FAIL.

- [ ] **Step 3: Implement the five modules, then `assets.ts` and `store.ts`**

`applyPatch` is a recursive merge where arrays named `stations`, `segments`, `incidents` merge by their id key and other arrays replace. `loadState` fetches `/api/state`, then `/snapshot.json`, parsing each with `parseState`. `store.ts` keeps `tick` pure: `clockS = min(clockS + dtS, scenario.duration_s)`; `boot` calls `loadState` and re-polls every 60 s.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd showcase && npm run check`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add showcase/src/data
git commit -m "Add the showcase data layer: corridor stretches, scenarios, live fallback, cars, outlook"
```

---

### Task 5: Scene: terrain, road, risk band, camera

**Files:**
- Create: `showcase/src/scene/SceneCanvas.tsx`, `showcase/src/scene/CameraRig.tsx`, `showcase/src/scene/Terrain.tsx`, `showcase/src/scene/Road.tsx`, `showcase/src/scene/RiskBand.tsx`, `showcase/src/scene/Site.tsx`, `showcase/src/scene/geometry.ts`, `showcase/src/scene/palette.ts`
- Test: `showcase/src/scene/geometry.test.ts`
- Modify: `showcase/src/App.tsx` (render `SceneCanvas` full screen)

**Interfaces:**
- Consumes: `loadSiteAssets`, `stretches`, `pointAt`, `useShowcase`, `LEVEL_COLOR`.
- Produces: `heightAt(heights: Float32Array, n: number, sizeM: number, x: number, z: number): number` (bilinear, metres, origin at centre, north = −z); `ribbonGeometry(points: [number, number][], heightFn: (x, z) => number, halfWidthM: number, liftM: number, fromM?: number, toM?: number): THREE.BufferGeometry` (double-sided strip); `terrainGeometry(heights, n, sizeM, exaggeration, snowline: boolean): THREE.BufferGeometry` with vertex colours; one scene unit is one metre; `CameraRig.tsx` exports `cameraActions: { zoomIn(): void; zoomOut(): void; rotate(): void; home(): void }` as a module-level object the HUD calls; site home pose: azimuth 0.58 rad, elevation 0.56 rad, distance 2 × corridor half-width, target the corridor midpoint; polar angle limited to 12° to 78°.
- `Site({ stationId })` renders Terrain, Road, RiskBand from the assets and `current()` state. Trees, Station, Cars, Barrier, Weather are added in Tasks 6 and 7 as children here.

- [ ] **Step 1: Write the failing geometry tests**

`geometry.test.ts`: `heightAt` on a 2 by 2 grid `[0, 100, 0, 100]` with `sizeM 100` at `x = 0` (centre) → 50; `ribbonGeometry` of a straight 100 m line with `halfWidthM 3` has `position.count === 2 * (n + 1)` and the first two vertices are 6 m apart; `terrainGeometry(…, exaggeration 1.6)` max y equals `1.6 * (max_m - min_m)`; colours: a vertex above 900 m gets the rock colour when its slope exceeds 30°, else snow; a vertex with `surface_c > 0` passed as `snowline: false` gets the grass tint below 600 m.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd showcase && npx vitest run src/scene`. Expected: FAIL.

- [ ] **Step 3: Implement `geometry.ts`, `palette.ts` and the components**

`palette.ts`: scene colours from the render (`sky #dfe8f6`, `snow #f4f7fb`, `snowShade #e3eaf4`, `rock #8a97ad`, `rockDark #6c7a93`, `grass #cfe0d2`, `asphalt #4d5668`, `shoulder #e9eef5`, `dash #fff6d6`). `SceneCanvas` is `<Canvas shadows dpr={[1, 2]} camera={{ fov: 36, near: 1, far: 60000 }}>` with a hemisphere light `#f2f6ff`/`#9fb3d4` at 0.75, a directional sun `#fff4e6` at 1.5 from `(-700, 1200, 600)` with a 2048 shadow map, `fog` from the sky colour; the sky and fog colour shift 6 % towards `#c9d6ea` when the station's `air_c` is below −5 °C. `Road` draws shoulder (half 5.2 m), asphalt (half 3.4 m), dashes every 18 m. `RiskBand` draws one strip per stretch (half 4.6 m, lift 0.46 m) in `LEVEL_COLOR[level]`, closed stretches at 0.4 opacity with the band in `#e0532f`. Terrain vertical exaggeration 1.6.

- [ ] **Step 4: Run the tests, then look**

Run: `cd showcase && npm run check`. Expected: PASS. Then `npm run dev`, open `http://localhost:5173/#site=3000014` (App reads `siteId` from the hash for now), screenshot with the Playwright tool at 1600 by 900. Expected: a snowy valley with a coloured road ribbon, orbit by drag, no console errors.

- [ ] **Step 5: Commit**

```bash
git add showcase/src
git commit -m "Render the corridor diorama: terrain, road, risk band and camera"
```

---

### Task 6: Scene: station, trees, barrier, weather

**Files:**
- Create: `showcase/src/scene/Station.tsx`, `showcase/src/scene/Trees.tsx`, `showcase/src/scene/Barrier.tsx`, `showcase/src/scene/Weather.tsx`, `showcase/src/scene/Tag.tsx`, `showcase/src/scene/dressing.ts`
- Test: `showcase/src/scene/dressing.test.ts`
- Modify: `showcase/src/scene/Site.tsx`

**Interfaces:**
- Consumes: `heightAt`, `pointAt`, `stretches`, `closuresAt`, `current()`.
- Produces: `treePlacements(seed: string, climate: string, heightFn, distToRoadFn, sizeM: number, count: number): Array<{ x: number; z: number; s: number }>` deterministic (mulberry32 from a string hash), none within 7 m of the road, none above the treeline (800 m mountain, 500 m coast, 400 m for the two climate zones inland and fjord: use 600), density factor coast 1.0, fjord 1.0, inland 0.7, mountain 0.4, warm 1.0; `Tag({ position, children, tone })` renders a drei `<Html>` chip in the HUD style; `Station({ x, z, status, windMs, name })`; `Barrier({ atM, simulated })` placed at a closure's start and end; `Weather({ precipType, mmH })` instanced particles: snow 2600 round sprites falling at 0.08 to 0.2 m per frame scaled by `mmH / 2.4`, rain 1600 streaks, none otherwise.

- [ ] **Step 1: Write the failing dressing test**

`dressing.test.ts`: same seed and inputs give the same placements; no placement within 7 m of the road (use `distToRoadFn = () => 3` to prove the count is 0, `() => 50` to prove it is `count`); `climate "mountain"` yields `round(count * 0.4)`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd showcase && npx vitest run src/scene/dressing`. Expected: FAIL.

- [ ] **Step 3: Implement the modules and add them to `Site`**

Station geometry as in the render (cabinet, pole, mast, anemometer that spins at `windMs * 0.8` rad/s, pin that bobs and is grey when `Stale`). The station sits 9 m beside the road at `station_at_m`. Barriers come from `closuresAt` when a scenario is on, and from live `incidents` whose `incident_type` contains `closure` (case-insensitive) on this station's `road_segment_id`, placed at `station_at_m ± 1000` when the incident has no position.

- [ ] **Step 4: Run the tests, then look**

Run: `cd showcase && npm run check`. Expected: PASS. Dev server screenshot of `#site=3000014`: station with spinning anemometer, trees thinning with height, snow falling (the placeholder snapshot has `precip_type: "SNOW"`).

- [ ] **Step 5: Commit**

```bash
git add showcase/src
git commit -m "Dress the diorama: station, trees, barriers and precipitation"
```

---

### Task 7: Scene: cars

**Files:**
- Create: `showcase/src/scene/Cars.tsx`, `showcase/src/scene/Car.tsx`
- Modify: `showcase/src/scene/Site.tsx`

**Interfaces:**
- Consumes: `carPlan`, `openRanges`, `advanceCar`, `pointAt`, `heightAt`, `Tag`.
- Produces: `Cars({ stretches, lengthM, level, truck: boolean })`: `carPlan(level).count` cars split between directions, each in the longest open range, offset 1.1 m right of centre in its direction; the gritting truck (orange `#e28a2a`, 5.4 m) drives when `truck` is true and carries a Tag `GR-07 gritting`; respects `prefers-reduced-motion` by standing still.

- [ ] **Step 1: Implement**

Positions advance in `useFrame` with `advanceCar`; orientation from `pointAt` tangent. `truck` is true when the station's segment `priority_rank <= 5`.

- [ ] **Step 2: Look**

Dev server screenshot: cars on the open stretch, none on a closed one when the snapshot has a closure. `npm run check` clean.

- [ ] **Step 3: Commit**

```bash
git add showcase/src
git commit -m "Drive ambience cars and the gritting truck along the corridor"
```

---

### Task 8: Overview scene and fly-in

**Files:**
- Create: `showcase/src/scene/Overview.tsx`, `showcase/src/scene/Pin.tsx`
- Modify: `showcase/src/scene/SceneCanvas.tsx`, `showcase/src/scene/CameraRig.tsx`, `showcase/src/App.tsx`

**Interfaces:**
- Consumes: `public/overview/county.json`, `roads.json`, `current().stations`, `goSite`, `goOverview`.
- Produces: `Overview()` renders the county plate (extruded `ShapeGeometry` from the rings, 1 unit = 1 m, scaled 0.02 in the scene so the county spans about 6000 units), water plane, road ribbons (half 120 m), one `Pin` per station in `LEVEL_COLOR[risk_level ?? "NONE"]` with a pulse when `Reporting`, hover Tag with name and level, click → `goSite(station_id)`. `CameraRig` tweens between the overview pose (elevation 0.9 rad, distance 9000) and the site pose over 1.2 s with ease-in-out, or cuts when `prefers-reduced-motion`.

- [ ] **Step 1: Implement**

`App` renders `Overview` when `view === "overview"` and `Site` otherwise; the hash reflects the view (`#overview`, `#site=<id>`) and is read at boot.

- [ ] **Step 2: Look**

Dev server: the county with 24 pins; click Bossovarri → fly in; home button → fly out. `npm run check` clean.

- [ ] **Step 3: Commit**

```bash
git add showcase/src
git commit -m "Add the county overview and the fly-in between overview and sites"
```

---

### Task 9: HUD: tokens, header, KPI cards, camera controls, legend

**Files:**
- Create: `showcase/src/styles/tokens.css`, `showcase/src/styles/hud.css`, `showcase/src/app/Header.tsx`, `showcase/src/app/SiteSwitcher.tsx`, `showcase/src/app/KpiCards.tsx`, `showcase/src/app/CameraControls.tsx`, `showcase/src/app/Legend.tsx`, `showcase/src/app/format.ts`
- Test: `showcase/src/app/format.test.ts`
- Modify: `showcase/src/App.tsx`

**Interfaces:**
- Consumes: store, `ageLabel`, `dataAgeMinutes`, `levelLabel`, `LEVEL_COLOR`, `cameraActions`.
- Produces: `format.ts`: `siteSummary(state: State, stationId: string): string` → `"HIGH · icing 0.72"` or `"No current risk"` (live data has one level per station); `kpiNarrow(state, stationId): { segmentsHigh: number; total: number }` counting segments on the same road; `filterSites(stations: Station[], query: string): Station[]` matching name or road, case-insensitive, accent-insensitive (`Skattørsund` matches `skatt`).
- `Legend` shows the four levels, "Cars are ambience, not traffic", and the attribution text from Global Constraints as its `title` and in an expandable line.
- Header layout and copy from the render: brand, search with `/` shortcut focusing it, SiteSwitcher (tag road, name, summary; dropdown grouped by climate zone, active item a filled tinted pill), Live chip (`Live · 12 min old`, `Snapshot · 3 h old`, or `Simulated · <title>` in the simulated tone), scenario toggle, bell with count of segments at HIGH or above, viewer "Road operations".
- Tokens: light and dark values for `--bg --surface --surface-solid --line --fg --fg-2 --fg-3 --accent --accent-soft --accent-ink --low --medium --high --very-high --sim --shadow --font`, same values as the approved render; `color-scheme` follows.

- [ ] **Step 1: Write the failing format tests**

`format.test.ts`: `filterSites` accent-insensitive match; `siteSummary` for a station with a segment → `"HIGH · icing 0.72"`; without → `"No current risk"`; `kpiNarrow` counts only the station's road.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd showcase && npx vitest run src/app`. Expected: FAIL.

- [ ] **Step 3: Implement**

Plain CSS with the tokens, glass panels (`backdrop-filter: blur(16px)`), the `.hud` layer `pointer-events: none` with children `auto`. Phone width: switcher and search collapse, KPI cards wrap.

- [ ] **Step 4: Run the tests, then look**

`npm run check` clean. Screenshot at 1600 by 900 and at 400 by 800: header, three KPI cards, camera column, legend; nothing overflows horizontally.

- [ ] **Step 5: Commit**

```bash
git add showcase/src
git commit -m "Add the showcase HUD shell: header, KPI cards, camera controls and legend"
```

---

### Task 10: HUD: detail panel, outlook, list

**Files:**
- Create: `showcase/src/app/DetailPanel.tsx`, `showcase/src/app/Outlook.tsx`, `showcase/src/app/ListPanel.tsx`, `showcase/src/app/Pill.tsx`, `showcase/src/app/listRows.ts`
- Test: `showcase/src/app/listRows.test.ts`
- Modify: `showcase/src/App.tsx`

**Interfaces:**
- Consumes: store, `outlookSteps`, `levelLabel`, `LEVEL_COLOR`.
- Produces: `listRows.ts`: `segmentRows(state, siteId | null): Array<{ id; title; subtitle; level: LevelOrNone; score: number | null; closed: boolean }>` (all segments on the overview, the site's road on a site, sorted by score descending); `stationRows(state, siteId | null)`; `incidentRows(state, siteId | null)` with `active` computed from `end_time` null or in the future against `Date.now()`; `DetailPanel` shows the selected segment (or the site's station segment by default; the county's top 5 priority rows on the overview); with no segment for the station it shows the station card and the sentence "No current risk for this station"; driver rows show `factor` and a chip `Driver` when `contribution >= 0.25`, `Rising` when between 0.1 and 0.25, `Minor` below; `Outlook` renders `outlookSteps` as the step row and the sentence "No readings in the last 24 h" when empty; `ListPanel` tabs with the active filled pill, rows clickable → `select(id)` and, for stations, `goSite`.

- [ ] **Step 1: Write the failing listRows tests**

`segmentRows` on a site returns only that road's segments sorted by score; `incidentRows` marks `end_time: null` active and a past `end_time` inactive; `stationRows` puts `Stale` stations last.

- [ ] **Step 2: Run it to verify it fails, implement, run to pass**

Run: `cd showcase && npx vitest run src/app/listRows`. Then implement, then `npm run check` clean.

- [ ] **Step 3: Look**

Screenshot of `#site=3000014` matches the render's panels; the `#overview` detail shows the top 5 priority rows. Clicking a station row flies to its site.

- [ ] **Step 4: Commit**

```bash
git add showcase/src
git commit -m "Add the detail panel, risk outlook and tabbed list to the showcase HUD"
```

---

### Task 11: Scenarios and the player

**Files:**
- Create: `showcase/public/scenarios/snowstorm-e8.json`, `showcase/public/scenarios/black-ice-lavangsdalen.json`, `showcase/public/scenarios/quiet-morning.json`, `showcase/public/scenarios/index.json` (`[{id, title, blurb}]`)
- Create: `showcase/src/app/ScenarioMenu.tsx`, `showcase/src/app/ScenarioBar.tsx`
- Test: `showcase/src/data/scenarioFiles.test.ts`
- Modify: `showcase/src/app/Header.tsx`, `showcase/src/App.tsx`

**Interfaces:**
- Consumes: `ScenarioSchema`, `setScenario`, `tick`, `seek`, `togglePlay`, `closuresAt`.
- Scenario content (station ids from the seed: Bossovarri `3000014`, Gardeborri `3000016`, Galgo `1900179`, Lavangsdalen `1900175`):
  1. `snowstorm-e8`, 90 s: steps at 0, 30, 60, 90 s raise the three E8 stations MEDIUM → HIGH → VERY_HIGH with `precip_mm_h` 0.8 → 2.4 → 5.0 → 6.5 and `surface_c` −1 → −3 → −5; closure at Gardeborri `start_m 5000, end_m 7000` from 60 s; Bossovarri `priority_rank 1` from 30 s; outlook `+3 h HIGH .78`, `+6 h VERY_HIGH .9`, `+12 h MEDIUM .5`.
  2. `black-ice-lavangsdalen`, 60 s: `precip_type "NONE"`, `precip_mm_h 0`, `surface_c` +0.4 → −0.3 → −1.2, `readings.dew_point_c` within 0.3 of surface, level MEDIUM → HIGH at 30 s, driver factor `Dew point gap` 0.5.
  3. `quiet-morning`, 30 s: every station LOW with `icing_score 0.1`, `precip_type "NONE"`, no incidents.
- `ScenarioBar` (below the header while a scenario is on): title, play/pause, a range input seeking `clockS`, elapsed of duration, "Simulated" chip, close.

- [ ] **Step 1: Write the failing scenario-file test**

`scenarioFiles.test.ts` reads the three files from disk with `fs` and asserts `ScenarioSchema.parse` succeeds, `stateAt(scenario, snapshot, duration_s)` parses with `parseState`, and for `snowstorm-e8` the Gardeborri station at 90 s is `VERY_HIGH` and `closuresAt(…, 90)` has one closure.

- [ ] **Step 2: Run it to verify it fails, write the files, run to pass**

Run: `cd showcase && npx vitest run src/data/scenarioFiles`. Write the JSON, re-run. Expected: PASS.

- [ ] **Step 3: Implement the menu and bar, wire `tick` to `useFrame`**

The header toggle opens `ScenarioMenu` (list from `index.json`); choosing one calls `setScenario` and `seek(0)`, playing. The legend gains a "Simulated" entry while on.

- [ ] **Step 4: Look**

Dev server: start "Snowstorm on E8" on `#site=3000016`; by 60 s the barrier appears with a "Simulated" tag, snow thickens, the chip reads `Simulated · Snowstorm on E8`. `npm run check` clean.

- [ ] **Step 5: Commit**

```bash
git add showcase
git commit -m "Add the three scripted scenarios and the scenario player"
```

---

### Task 12: Real snapshot, README, ADR, CI

**Files:**
- Create: `showcase/.dev.vars` (local only, gitignored), `docs/adr/0010-showcase-dashboard-outside-the-mvp.md`, `.github/workflows/showcase.yml`
- Modify: `showcase/public/snapshot.json`, `showcase/README.md`, `showcase/wrangler.toml` (real `DATABRICKS_HOST` of the personal workspace and its warehouse id; both are not secrets)

**Interfaces:**
- Consumes: Task 2's Worker, the personal workspace with gold already built (`databricks bundle deploy -t personal` and the gold job have run).

- [ ] **Step 1: Capture a real snapshot**

Create a personal access token in the personal workspace, put `DATABRICKS_TOKEN=...` in `showcase/.dev.vars`. Run `npx wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"` and `curl -s localhost:8787/api/state > public/snapshot.json`. Expected: `npx vitest run` still passes (the snapshot parses) and `kpi.stations_total` is 24. If the gold tables are empty on the personal workspace, run the gold job first or capture from the free workspace.

- [ ] **Step 2: Write the README**

Sections: what it is and what it is not (not the MVP, not traffic), run locally (`npm i`, `npm run dev`, scenarios work without a Worker), the Worker locally (`.dev.vars`, `wrangler dev --test-scheduled`), bake (`npm run bake`, when to re-run), deploy later (`wrangler kv namespace create STATE`, set `id`, `wrangler secret put DATABRICKS_TOKEN`, `npm run build && npx wrangler deploy`), screenshot checklist (overview, site, snowstorm at 60 s, phone width), attribution text verbatim from Global Constraints.

- [ ] **Step 3: Write ADR-0010 from `docs/adr/0000-template.md`**

Title "Showcase dashboard outside the MVP". Context: the 2026-10-05 decision and the demo wish. Options: AI/BI only; a Databricks App; a standalone page on Cloudflare reading gold through a Worker. Decision: the third, as a demo outside the milestones and bundle. Consequences: design rule 2 reading (consumer outside the platform), personal token interim until a service principal on the paid workspace, no change to pipelines or jobs, not a replacement for the AI/BI dashboards.

- [ ] **Step 4: Add the workflow**

`.github/workflows/showcase.yml`: on `push` and `pull_request` with `paths: ["showcase/**"]`; `actions/setup-node@v4` with `node-version: 24`, `npm ci`, `npm run check`, `npm run build`, `npx wrangler deploy --dry-run`; a second job `uv run pytest tests/unit/test_bake_sites.py` with `astral-sh/setup-uv@v3`.

- [ ] **Step 5: Verify and commit**

Run: `cd showcase && npm run check && npm run build && npx wrangler deploy --dry-run` and from the root `uv run ruff check . && uv run pytest`. Expected: all clean.

```bash
git add showcase/README.md showcase/public/snapshot.json showcase/wrangler.toml docs/adr/0010-showcase-dashboard-outside-the-mvp.md .github/workflows/showcase.yml
git commit -m "Capture a live snapshot, document the showcase and record ADR-0010"
```
