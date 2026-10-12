# Gold on the team's silver tables

Status: decisions taken and G1 to G6 built on 8 Oct 2026 (branch `feature/m5-gold-team-silver`); section 6
lists the decisions, section 8 what runs where. Owner: Safiul.

Goal: fill `frostsight.gold` in the team workspace (`dbc-03393298-a93c`, target `free`) from the bronze and silver
tables the team built in notebooks (`/Users/nazmul.sani@cefalo.com/FrostSight/`), so the demo dashboard can read
`gold` instead of `mock`. Pilot county Troms only. This is a cut-down M5 (06_M5 T5.1, T5.3, T5.4) and
M6 T6.2 to T6.4, adapted to the silver tables that exist today rather than the ones the plan names.

## 1. What is there today (checked 8 Oct 2026)

| Area | Finding |
|---|---|
| Ingestion | Job `frostsight ingestion and transformation job` (bronze orchestrator, then silver orchestrator). **No schedule.** Each bronze table holds 2 to 4 snapshots, all loaded by hand on 6 to 8 Oct |
| Silver pattern | Every silver notebook reads only the newest bronze row (`.orderBy(ingestion_timestamp desc).limit(1)`) and **overwrites** the silver table. Silver is always one snapshot, never a history |
| Road weather | `silver.datex_road_weather_silver`: 469 stations nationwide, one row each. Troms: 24 stations. Surface temperature 24 of 24, air 20, dew point 18, humidity 20, precipitation intensity 24, wind 24, snow depth 5. `precipitation_type` is `UNKNOWN` on every row. No road surface state |
| Station ids | DATEX `station_id` equals the NVDB station number. 22 of the 24 NVDB stations in Troms match by id and position. Hamn (1900113) and Gardeborri (3000016) are not in DATEX. Gamnes and Skattørsund report but are months stale |
| Incidents | `silver.datex_incidents_silver`: 168 nationwide, 57 in the Troms box, 48 active by time. `is_active` is `false` on every row, so it cannot be used. No county column, but every row has `road_ref`, `lat`, `lon`. One situation appears as several rows, one per incident type. Severity values are `LOW`, `HIGH`, `HIGHEST`, `NONE`, `UNKNOWN` |
| Road network | **No silver road segments, road points or station lookup.** `nvdb_road_network_api_data_loader` loads the NVDB object-type catalogue (`/vegobjekttyper`), not the road network |
| Other NVDB | Weather stations, speed limits, traffic stations, avalanche: 1 row each, because the URLs use `antall=1` and do not page. Accidents: 0 rows |
| MET forecast | One point (Tromsø), 85 hours ahead |
| Frost | Notebooks exist, bronze and silver tables do not (needs the `frost_client_id` secret) |
| Data quality | No quarantine tables, no rule events. The notebooks drop rows with a null key and do not log them |
| Gold | Empty |
| Repo | No `src/frostsight` modules, no `src/jobs`, no `resources/`. The risk v0 exists only as SQL in `tools/mock_dashboards/mock_data.sql` |

## 2. What the dashboard needs, and where it comes from

The dashboard (`tools/mock_dashboards/frostsight_demo.lvdash.json`) reads 16 datasets built on the objects
below. Column lists are the mock's, which match 07_M6 T6.4. (The live dashboard reads the
plot-ready tables of section 4a instead.)

| Gold object | Feeds | Source today | Have it? |
|---|---|---|---|
| `road_segment_current_risk` | KPI, map, road detail, priority | road weather silver + station lookup + risk v0 | Yes for 22 stations. Trend factor needs history (B1, B2) |
| `road_segment_risk_history` | 24 h risk and temperature lines, health KPI | appended by the gold job each run | Only from the day the schedule starts (B1, B2) |
| `v_observations` | station list, readings, priority | road weather silver | Latest only until B1, B2 are fixed. `road_surface_state` is not in the source (B5) |
| `v_stations` | map dots, station list | NVDB stations | Not in silver (B3). Interim: the committed NVDB seed |
| `v_segments` | map, road detail, priority | NVDB road segments | Not in silver (B3). Interim: the committed NVDB seed |
| `v_road_points` | grey road layer on the map | NVDB road lines, a point every 300 m | Not in silver (B3). Interim: the committed NVDB seed |
| `v_incidents`, `incident_summary` | incident table, road detail | incidents silver, mapped to a segment | Yes, after the fixes in B6 |
| `data_quality_summary` (+ `_history`) | Platform health | bronze and silver timestamps | Yes, computed by the gold job. History builds from the first run |
| `v_quarantine`, `v_dq_events` | Platform health: quarantine and rule tiles | quarantine tables, rule events | No source at all (B7) |

Short answer: the values for a **current** risk map exist. What is missing is history (no schedule, silver keeps
one snapshot), the road network (not loaded), precipitation type, road surface state and data-quality events.

## 3. Blockers and gaps

| # | Blocker | Blocks | Owner | Proposed fix |
|---|---|---|---|---|
| B1 | Ingestion job has no schedule | history, trends, freshness, everything "live" | Sani | Schedule road weather and incidents every 10 min. Reference sources (NVDB, elevation, county) daily, as a separate job, to stay inside the Free Edition quota |
| B2 | Silver road weather keeps only the newest bronze snapshot | history, `temperature_change_1h` and `_3h`, 24 h charts | Sani | In `datex_road_weather`: drop `.limit(1)`, parse every bronze row, keep the existing dedup on `(station_id, event_time)`. Same change for `datex_incidents`, deduping on `(incident_id, incident_version)`. Bronze already appends every snapshot (about 440 KB each, about 63 MB/day), so history back to the first load comes for free. Later: process only bronze rows newer than the last run and `MERGE` |
| B3 | No road segments, road points or station-to-segment lookup in silver | map, road detail, every join from station to segment | Rayhan (05_M4 T4.5, T4.6) | Interim: load the NVDB reference data already committed in `tools/mock_dashboards/nvdb_seed.sql` (real NVDB roads, segments and stations, NLOD) into `silver.nvdb_seed_roads`, `_road_points`, `_segments`, `_stations`. The names say what they are; when the reference job lands, only the plot-ready table SQL (`frostsight.serving`) moves to its tables |
| B4 | `precipitation_type` is `UNKNOWN` on every row | precipitation factor: a flat 0.2 x 0.20 = +0.04 on every segment | Safiul | Infer it in gold when the source says `UNKNOWN`: intensity 0 → `NONE`; else air ≤ 0.5 °C → `SNOW`, ≤ 1.5 °C → `SLEET`, else `RAIN`. Keep the source value when it is known. Mark inferred rows (`precipitation_type_inferred = true`). Needs your yes, because it changes the v0 model inputs (04_M3 T3.4) |
| B5 | No road surface state in DATEX `WeatherSimple_v2` | one row in the road detail "Readings" table | Safiul | The row reads "Pending Live Data". No guessing |
| B6 | `is_active` always false; one situation = several rows; severity has `HIGHEST`; no segment | incident table, `incident_summary` | Safiul | In gold: active = `start_time <= now AND (end_time IS NULL OR end_time > now)`; count situations, not rows; rank `HIGHEST > HIGH > LOW > NONE/UNKNOWN`; map to the nearest lookup segment on the same road (`E8` ↔ `E8`, `F91` ↔ `Fv91`) within 5 km, otherwise `road_segment_id` NULL (still listed, not on a segment). Troms only |
| B7 | No quarantine tables or rule events | Platform health: quarantine tile, rule table, part of the health KPI | Sani (05_M4 T4.4) | Those widgets read "Pending Live Data" until silver has rules and quarantine tables. Freshness and latency are live |
| B9 | The silver orchestrator catches every notebook error and still ends SUCCESS; each notebook has a 60 s timeout. In the first scheduled-style run (8 Oct, 16:14 UTC) six silver notebooks failed: `datex_incidents`, `trafikkdata`, `frost_station_source`, `frost_observation_history`, `nvdb_road_network_api_data_loader`, `NVDB avalanche and landslide` ("An error occurred while calling NotebookRun") | incidents stay on the 07:54 snapshot (STALE on Platform health) | Sani | Let a failing notebook fail the task (re-raise after the loop), raise the timeout, fix `datex_incidents` first |
| B8 | No `_batch_id` or `_ingested_at` in the team's tables | history key, replay filter | Safiul | Gold uses `bronze_ingestion_timestamp` as arrival time, and `_batch_id = date_format(bronze_ingestion_timestamp, "yyyyMMdd'T'HHmmss'Z'")`, which is the live file-stem format from 00_README section 4 |

Not blockers, but worth knowing:

- **Free Edition quota.** 144 runs a day of a 15-notebook job plus a gold task may exhaust the daily serverless
  allowance. B1's split (fast sources every 10 min, reference daily) is there for that reason.
- **Two stations have no DATEX feed** (Hamn, Gardeborri). They show as stale dots with no risk, which is correct.
- **The first hour after B1 and B2** has no 1 h trend (scored 0). The 24 h charts fill over the first day,
  unless B2 lets us backfill from the bronze snapshots.
- **Deviations from the plan** in the team's work: silver table names differ from 00_README section 4
  (`datex_road_weather_silver` vs `silver.road_weather_observations`); bronze is written by notebooks that call
  the APIs from inside Databricks (design rule 2 says only `collector/`); no Lakeflow pipeline. This plan reads
  the tables as they are and does not rename anything. Whether to rename, or to record the deviations in an ADR,
  is a separate team decision.

## 4. Design

```
silver.datex_road_weather_silver ─┐                              ┌─ gold.road_weather_observation_log (insert-only on station, event_time)
silver.nvdb_seed_stations ────────┼─ build_gold (every 4 h, or ──┼─ gold.road_segment_current_risk     (MERGE on road_segment_id)
silver.datex_incidents_silver ────┤   Fetch now), Troms, risk v0  ├─ gold.road_segment_risk_history     (insert-only on segment, event_time, _batch_id)
silver.met_locationforecast ──────┘                              ├─ gold.road_incidents, incident_summary (overwrite)
                                                                 └─ gold.data_quality_summary (+ _history)
silver.nvdb_seed_* + the gold tables above ── plot-ready gold tables (section 4a), rebuilt last in every run
```

- **Risk** is v0 exactly as 06_M5 T5.1 and T5.3 define it, and exactly what the mock computes: weights
  0.35/0.15/0.15/0.20/0.15; breakpoints for surface, air, dew-point spread, precipitation type and 1 h trend; levels
  at 0.25/0.5/0.75; the top three drivers. Pure Python in `src/frostsight/risk.py` with unit tests, and the same
  logic as Spark column expressions for the job.
- **Current row** per segment comes from its station's newest reading within the last 30 min. Silent stations keep
  their previous row (06_M5 decision table).
- **History** is insert-only, one row per segment and reading. Until B2 is fixed, gold keeps its own copy of
  every reading it sees in `gold.road_weather_observation_log`; once silver keeps history, build_gold reads silver
  instead and the log can go.
- **Freshness** per source (`road_weather`, `incidents`, `forecast`): newest `event_time` (road weather) or
  snapshot time, thresholds 300, 300 and 1440 min while a fetch runs every 4 h. `_history` gets one row per
  source per run.
- **Fetch cadence.** Every 4 h during development, or on demand. With readings 4 h apart, the 1 h and 3 h trends
  have no reading in their band, so the trend factor scores 0 and the dashboard says "Pending Live Data" for it.
  A station is "reporting" if it was in the newest fetch (within 30 min of its newest reading), not by the clock.
- **Station names** come from the NVDB seed (they match the DATEX `location_description` minus the road prefix).

## 4a. Plot-ready gold tables

Decision (8 Oct 2026, recorded as ADR-0009): the dashboard does no joins or aggregation at read time. After every fetch the gold job
rebuilds one small table per widget group (`src/frostsight/serving.py`, `CREATE OR REPLACE TABLE ... AS
SELECT`, atomic), and each live dataset is a select on one table. Only what depends on the viewer's clock stays
in the dashboard query: minutes ago, data age, whether an incident is still active, freshness delay and status
(so a stopped job shows STALE). `tests/unit/test_serving.py` fails if a live dataset reads more than one table.

| Table | Feeds | Grain |
|---|---|---|
| `station_status` | station list, station dots, station counters | one row per NVDB station |
| `map_points` | risk map (road points coloured by the covering station within 5 km on its own road, plus stations) | one row per point |
| `segment_detail` | road detail header, segment filter | one row per segment with a current risk |
| `segment_drivers`, `segment_risk_types`, `segment_readings` | road detail bar and tables | rows per segment |
| `segment_history` | road detail 24 h lines | one row per segment and reading |
| `segment_incidents` | incidents on the segment's road | one row per segment and incident |
| `priority_list` | gritting priority bar, filters and table | one row per segment, ranked |
| `kpi_summary` | risk-map counters, latency | one row |

`road_incidents`, `data_quality_summary` and `_history` are read as they are; they already have one row per
plotted item. These tables go beyond the gold list of the spec (section 7.3); they are the dashboard's serving
layer and can be rebuilt from the core gold tables at any time. The `v_*` gold views of 07_M6 T6.4 are not used.

## 5. Tasks (as built)

All on `feature/m5-gold-team-silver`, one PR into `dev`.

### G1 Reference data from the committed NVDB seed (interim for B3)
Done: `deploy.py --dashboard live --load-reference` runs `tools/mock_dashboards/nvdb_seed.sql` with
`frostsight.mock.seed_*` rewritten to `frostsight.silver.nvdb_seed_*`, skipping the mock incidents. Each table
carries the comment "Interim reference data ... replaced by the reference job (05_M4 T4.6)".
Verified: 24 stations, 22 of them join to `datex_road_weather_silver` on `station_id`.

### G2 Risk config and engine
Done: `config/risk_weights.yml` (06_M5 T5.1, plus `precipitation_inference`), `src/frostsight/config.py`,
`src/frostsight/risk.py` (T5.3 and `infer_precipitation_type` with its Spark twin), `windows.py` (trends),
`freshness.py`, `incidents.py` (road key, severity rank, distance, placement). Tests: `tests/unit/test_risk.py`
(worked examples A to C of T5.3) and `test_gold_helpers.py`. The Spark-twin tests need Java and skip without it;
the twins are checked against the Python functions on the workspace instead (section 8).

### G3 Gold builder job
Done: `src/jobs/build_gold.py`. Troms rows of `datex_road_weather_silver` into the insert-only log, precipitation
inferred, `_batch_id` from the bronze ingestion time (B8), trends from the log, risk v0, insert-only history,
current risk (station within 30 min of the newest reading), incidents within 5 km of a monitored road with the
nearest segment on their own road (B6), freshness. Tables are created with `CREATE TABLE IF NOT EXISTS` and
clustered as in the 06_M5 decision table.
Verified on 8 Oct: log 24, current 20, history 22, incidents 26 rows after the first run; after a full run
(ingestion, then gold) log 46 and history 42; a gold-only rerun on the same snapshot left both unchanged.

### G4 Plot-ready gold tables
Done: `src/frostsight/serving.py` (section 4a), built last by `build_gold`. They replaced the `v_*` gold views
of the first version, which were dropped. Verified: the old live map, priority and station queries and the new
tables return the same rows (EXCEPT ALL both ways, 0 rows).

### G5 Bundle job
Done: `resources/gold.job.yml`, job `gold`, task `build_gold` (serverless, wheel), cron `0 0 0/4 * * ?` UTC,
`pause_status: ${var.schedule_pause_status}`, `users` with `CAN_MANAGE_RUN`. On `free`, `databricks.yml` adds
task `ingest` (`run_job_task` on `${var.ingest_job_id}`, looked up by name) before `build_gold`.
Found on the way: `trigger_pause_status: UNPAUSED` is rejected with `mode: development`, so `free` and `aws` no
longer set it (00_README section 2 updated).

### G6 Dashboard on gold
Done: `build_dashboard.py` writes `frostsight_live.lvdash.json` next to the demo JSON (demo unchanged byte for
byte); `deploy.py --dashboard live` checks the plot-ready tables exist, sets the Fetch now link, tests every dataset and
publishes "FrostSight (live)". Each live dataset is a single-table select (section 4a).

### G7 Ask the silver owner (B1, B2)
Open: a note to Sani with the two notebook changes. The gold job now runs the ingestion job every 4 h, which
covers B1 for the sources it fetches.

## 6. Decisions (8 Oct 2026)

1. **History (B2):** Sani is asked to fix the silver notebooks. Until then the gold job keeps its own copy
   (`gold.road_weather_observation_log`).
2. **Road network (B3):** interim load from the committed NVDB seed into `silver.nvdb_seed_*`.
3. **Precipitation type (B4):** inferred from intensity and air temperature (`config/risk_weights.yml`
   `precipitation_inference`); the source value is kept in `precipitation_type_source`.
4. **Job:** a bundle job, `gold` (`resources/gold.job.yml`), deployed to `free`. Every 4 h while in development,
   not every 10 min. On `free` it runs the team's ingestion job first, so one run fetches and rebuilds everything.
5. **Fetch now:** AI/BI dashboards cannot hold a button that starts a job, so every page header has a
   "⟳ Fetch now" link to the job's page, where "Run now" starts it. The `users` group has `CAN_MANAGE_RUN` on the
   job.
6. **Missing data:** every widget, table row or value without a real source reads "Pending Live Data".
7. **Dashboard:** a second dashboard, "FrostSight (live)", beside the mock one.

## 7. Done when

- The live dashboard on the team workspace shows Troms risk computed from the latest DATEX readings, at most
  4 hours old, or minutes old after Fetch now.
- 24 h history and trends are filled (needs B1, B2).
- `uv run pytest`, `ruff` and `bundle validate -t free` pass; gold reruns are idempotent.

## 8. What runs where (team workspace, 8 Oct 2026)

| Thing | Where |
|---|---|
| Gold job `[dev safiul_kabir] frostsight-gold` | `databricks bundle deploy -t free`; tasks `ingest` (the team's job) then `build_gold`; cron `0 0 0/4 * * ?` UTC |
| Reference seed | `uv run python tools/mock_dashboards/deploy.py --profile frostsight-free --dashboard live --load-reference` (once) |
| Plot-ready tables | built by the gold job after every fetch (`frostsight.serving`) |
| Live dashboard | `deploy.py --profile frostsight-free --dashboard live --share users`; id in `.dashboard_id.frostsight-free.live` |
| First full run (Fetch now path) | 8 Oct 16:14 UTC: ingestion 14 min, gold 1 min, both SUCCESS; road weather FRESH (19 min), incidents STALE (B9) |
| Spark versus Python check | every `road_segment_current_risk` row recomputed with `frostsight.risk` in Python: 20 of 20 equal on 8 Oct |

Pending Live Data today: quarantine and rule counts (B7), pipeline runs, road surface state (B5), the 1 h trend
(a fetch every 4 h), closure and accident risk types (after the MVP).
