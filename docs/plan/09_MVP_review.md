# MVP review: files 01 to 08

Date: 29 September 2026. Method: two reviewers worked in parallel, one on files 01 to 04 and one on files 05
to 08, each with the README as the contract and the other half's files as the downstream or upstream
authority. Both edited the milestone files in place. After they finished, a grep over all eight files for the
items each reviewer had flagged for the other (`schedule_paused`, `mode: production`, `catalog.schema.yml`,
`scripts`, nested landing paths, `h3_pointash3`, `landing_volume_path`, `live:` batch ids,
`Fresh`/`Reference` status strings, quarantine column names, `client` version) found no remaining
contradictions; the only hits are sentences that explain why the old form is gone, and `CAN_VIEW` where it is
the correct level for jobs and pipelines.

Decisions recorded in the README that resolved the writers' disagreements:

1. Flat landing folders `raw/<source>/<yyyy>/<mm>/<dd>/<file>`, `.jsonl` live files, `replay__<event_id>__<ts>.jsonl`
   replay files, `_failed/*.json` markers excluded by `pathGlobFilter *.jsonl`.
2. Catalog, schemas, volume and grants by SQL script, not by the bundle; the bundle owns pipeline, jobs, dashboards.
3. `mode: development` on all targets, `presets.name_prefix: ""` and `trigger_pause_status: UNPAUSED` on `free` and `aws`.
4. One `pyproject.toml`; `tools/` instead of the gitignored `scripts/`; ADRs in `docs/adr/`.
5. `config/risk_weights.yml` from 06_M5 is authoritative; 04_M3 shows the same YAML and worked examples.
6. `silver.road_incidents` and `silver.station_segment_lookup` are materialized views; road weather is a streaming table.
7. Six-column quarantine contract and the freshness statuses `FRESH`, `STALE`, `NO_DATA` everywhere.

What still needs a real workspace is listed in both parts below. The first person to reach M2 on the team
workspace should walk those lists and strike items off in this file.

---

# Part A: files 01 to 04

## Review of files 01 to 04 (M0 to M3): fixes applied, open items

Reviewer scope: `01_M0_accounts_and_sources.md`, `02_M1_history_and_reference_data.md`,
`03_M2_foundation.md`, `04_M3_design.md`, checked against `00_README.md` (contract), `05_M4` and `06_M5`
(downstream, authoritative for code-facing names) and the `databricks-core`, `databricks-dabs` and
`databricks-unity-catalog` skill references. The Databricks CLI is not installed on the review machine;
everything that could not be checked against a skill reference is listed under "Still to verify". Every
Python, YAML, TOML and JSON block in the four files was parsed (`ast`, `yaml.safe_load`, `tomllib`,
`json`); the three risk examples were recomputed with 06's `interp`; the harness and Frost pure functions
were executed offline.

### Fixed

| File | Task | Change |
|---|---|---|
| 01 | T0.1 | Workspace URL no longer goes into `config/sources.yml`; it lives in the CLI profile and the `DATABRICKS_HOST` secret |
| 01 | T0.3 | One `pyproject.toml` (hatchling build, `packages = ["src/frostsight", "collector"]`, runtime deps `pyyaml`, `requests`, extras `collector` and `geo`, `dev` group); merged the 01 and 03 versions and dropped `[tool.uv] package = false` (it blocked the wheel) and the `databricks-connect` marker line; root `pyproject.toml` stays untouched; `uv.lock` committed; `uv build --wheel` added to the check |
| 01 | T0.4 | `secrets put-secret` uses positional `SCOPE KEY` and `--string-value` instead of an invented `--json` shape; SDK `dbutils.secrets` form for Python-file tasks; stdin form for multi-line values |
| 01 | T0.5 | `scripts/verify_sources.py` renamed to `tools/verify_sources.py` everywhere (root `.gitignore` ignores `scripts/`) |
| 01 | T0.6 | Pilot county recorded as bundle variable `pilot_county` and `config/sources.yml`, not as an ADR-only value |
| 01 | T0.7 | ADRs live in the repo-root `docs/adr/` (not gitignored; template already exists); removed the wrong `docs/adr/` claim and paths; ADR 0004 references contract v1 and T1.9 |
| 01 | T0.9, Verify | Spatial check now `h3_longlatash3(18.96, 69.65, 9)` plus `ST_Distance(ST_Point(0,0,25833), ST_Point(3,4,25833))` = 5.0 (ST_ Public Preview, DBR 17.1+); ADR `ls` and `git log` paths at repo root; gate row for `uv.lock` and the wheel |
| 02 | intro | Landing table rewritten to the README's flat source names (`nvdb_road_network`, `nvdb_stations`, `nvdb_speed_limits`, `nvdb_accidents`, `nvdb_avalanche`, `nvdb_counties`, `frost_sources`, `frost_history`, `road_weather`, `road_weather_xml`, `road_incidents`, `road_incidents_xml`, `datex_sites`, `elevation`, `source_metadata`); `.jsonl` live files; replay naming and `_batch_id` derivation stated |
| 02 | T1.1 | Catalog, schemas, volume and grants now come from `sql/001_catalog_schemas_volume.sql` (full script here, since M1 needs the volume before M2); removed the CLI `catalogs create` / `schemas create` / `volumes create` path; grants to `` `account users` `` (UC grants take account-level principals); fifteen `fs mkdirs` folders |
| 02 | T1.2 | `landing_path` rejects nested source names; `deliver` gained `--target workspace` (plain `/Volumes` file IO inside a job task); `run.py` accepts several `--source` values, logs per-source failures, reads secrets from the `frostsight` scope on `workspace`; new `metadata.py` and `config/sources.yml` (licence and attribution per source, lands in `source_metadata/`) |
| 02 | T1.3 | Folder names, `srid=25833` and `inkluder=vegsegmenter` (both marked verify), `nvdb_counties` from `omrader/fylker` (05's `load_bronze` reads it), verify commands and expected files updated |
| 02 | T1.4 | `frost_sources` and `frost_history` land as JSON lines: `station_id` (nearest NVDB station within 300 m, same rule as 05), `frost_source_id`, `event_time` UTC ISO, the elements with units; harness-ready; needs the NVDB stations file (dependency added) |
| 02 | T1.5 | `datex.py` now parses the XML into contract v1 JSON lines (weather and situations, plus `datex_sites`), keeps the raw XML in `*_xml/`, fails loudly on zero parsed records; contract v1 is stated here as the source of truth 05 repeats; element names marked verify with a step to confirm them against the landed XML |
| 02 | T1.6 | Folder `nvdb_stations`; skips stations without point geometry with a warning instead of crashing |
| 02 | T1.7 | Contract rows renamed to the flat sources; added `road_segment_id` construction as 05 builds it, `vegsegmenter`, `nvdb_counties`, the `navn` values 05 reads (`Alvorligste skadegrad`, `Skade på veg`) as confirm-from-fixture, Frost flat fields, DATEX contract mapping, `datex_sites`, `source_metadata` |
| 02 | T1.8 | Storm-day script reads `frost_history/*.jsonl`; `replay_events.yml` shape unified with 03 (`id`, `label`, `start`, `end`, `why`; no `history_glob`) |
| 02 | T1.9 | Idempotency note states that the collector never writes `_batch_id`; backfill described against 05's `read_landed`; tests extended to `flatten_observations`, `parse_weather`, `parse_situations` |
| 02 | sizes, Done, Verify | Flat folder names, jsonl/xml split, `schemas list`, `read_files` counts on the new folders |
| 03 | intro, T2.1 | Bundle owns pipeline, jobs, dashboards only; `catalog.schema.yml` resource and its `mode: development` caveat removed; T2.1 is now a confirmation of the M1 SQL script (grants check, probe upload, ownership note) |
| 03 | T2.2 | `databricks.yml` matches the README variable table exactly (`catalog`, `landing_root`, `pilot_county`, `warehouse_name`, `warehouse_id` lookup, `schedule_pause_status`, `pipeline_continuous`, `pipeline_development`, `notification_email`, `config_dir`); `mode: development` on all three targets; `free` and `aws` presets `name_prefix: ""`, `trigger_pause_status: UNPAUSED`; `personal` default and paused; `artifacts` block (`type: whl`, `build: uv build --wheel`, `path: .`); collector job under `targets.aws.resources.jobs` with `--target workspace`; `schedule_paused` replaced by `schedule_pause_status` |
| 03 | T2.2 | `ingest.pipeline.yml` matches 05 T4.7 (`frostsight-ingest`, `root_path: ../src`, `serverless: true`, `schema: bronze`, `continuous`/`development` from variables, `libraries` glob `../src/pipelines/**`, `configuration` keys incl. `frostsight.config_dir: ${var.config_dir}`, `environment.dependencies`, `event_log` in `gold`, notifications); `orchestrate` v1 and `reference` match 05's names, cron, `environments` with `../dist/*.whl`; dashboards noted with `dataset_catalog`/`dataset_schema` and `CAN_READ` |
| 03 | T2.2 | Placeholder pipeline table so an M2 update succeeds; `load_reference.py` placeholder imports `frostsight`; `validate -t free --strict` expected output and the meaning of `--strict` added |
| 03 | T2.3 | References the single `pyproject.toml` from 01 T0.3 instead of a second version; pipeline import path explained via `root_path` |
| 03 | T2.4 | CI runs inside the repo root (`defaults.run.working-directory`, `uv sync --frozen` on `uv.lock`, JDK for local pyspark); profile-in-CI note corrected (`workspace.host` alternative); fallback when PATs are disabled clarified |
| 03 | T2.5 | Collector invocations use `--source road_weather road_incidents`; `--inside-workspace` replaced by `--target workspace`; NVDB weekly run scheduled before the `reference` job; Actions runner profile issue marked verify |
| 03 | T2.6 | Harness rewritten: reads `frost_history` by month folder (no `history_glob`), writes `replay__<event_id>__<ts>.jsonl` in contract v1 with no `_batch_id` field and no sidecar, `--speed` kept (0 = no pause), `--shift` minutes added (negative = late), `--latest` mode re-emits the newest live file for the duplicate and late-file tests (05 T4.8), `--from/--to` backfill mode (08); `precip_type` approximation documented |
| 03 | T2.7 | `config/dq_rules.yml` now in the shape 05's `rules_by_action` reads (`<dataset>: [{name, condition, action}]`), content identical to 05 for the pipeline datasets plus job-checked `road_weather_stations` and `road_segments`; late-row rule and `XS00x` rules removed with the reason |
| 03 | T2.8 | `silver.data_quality_events`, `gold.data_quality_summary` and `_history` columns match 07's `build_freshness.py` and `data_quality_events.sql`; `sql/002_dq_tables.sql` |
| 03 | gate, Done, Verify | Flat folder names, `.jsonl`, placeholder table check, `docs/adr/0008-m2-fallback.md` only if the fallback is taken (0004 is the external-collector ADR) |
| 04 | T3.1 | Silver contracts reconciled to 05: observations without `road_segment_id`/`station_known`, upper-case `precipitation_type`; `road_incidents` is a materialized view keyed by `incident_id` with `lat`/`lon` and no `version`/`county`; `road_segments` with `segment_no INT`, `h3_cells`, `county INT`, no `road_ref`/`nvdb_extract_date`; `road_weather_stations` with `lon`/`lat`, no `county`; lookup without `mapped` (unmapped stations go to `quarantine.unmapped_observations`); job-only silver tables and the quarantine shape added |
| 04 | T3.2 | D4 (late rows are dropped by the operator; counted from bronze at M6, no expectation), D9 (no replay filter in MVP gold, matches 06), sketch uses `rules_by_action` names and `root_path` import; late-file test references the harness `--latest --shift` |
| 04 | T3.3 | Benchmark runs on `bench_*` tables built from landing (silver does not exist at M3); `lon`/`lat`, `h3_cells`, `ST_GeomFromWKT`, `h3_longlatash3`, `h3_kring`, `h3_coverash3`; M0's ST_ check referenced and extended; method name `h3_kring2_st_distance_25833` as in 05 |
| 04 | T3.4 | Rewritten around 06's `risk_weights.yml` (weights 0.35/0.15/0.15/0.20/0.15, breakpoints, precipitation scores, lower-bound levels) with the three 06 examples (A 0.6875 HIGH, B 0.16 LOW, C 0.721875 HIGH) and the full arithmetic; 04's own conflicting factor formulas, YAML and examples deleted |
| 04 | T3.5 | Gold contracts match 06's `GOLD_DDL` and `CLUSTER` (column names, `incident_summary` per segment, `historical_closures` keyed by `incident_id`, history insert-only per observation) |
| 04 | T3.6 | Dashboard SQL uses the reconciled columns (`concat(road_category, road_number)`, `lat`/`lon`, no `version` QUALIFY, `incident_summary`, `lag_minutes`, `rule_id`, published event log `gold.ingest_event_log`); bare-name note for the M6 JSON |
| 04 | Done, Verify | Benchmark prep file, `bench_*` drop, weights and factor-name assertion |

### Still to verify on a real workspace

| File | Item | Command |
|---|---|---|
| 01 | `secrets put-secret` flag name in the installed CLI | `databricks secrets put-secret --help` |
| 01 | Free Edition accepts secret scopes | `databricks secrets create-scope frostsight --profile frostsight-free` |
| 01 | `experimental aitools tools query` present; ST_ and H3 functions on the Free Edition serverless warehouse | `databricks experimental aitools tools query "SELECT ST_Distance(ST_Point(0,0,25833), ST_Point(3,4,25833))" --profile frostsight-free` (expect `5.0`) and `... "SELECT h3_longlatash3(18.96, 69.65, 9)"` |
| 02 | `account users` accepted as grant principal on Free Edition; multi-statement script through the CLI | run `sql/001_catalog_schemas_volume.sql` in SQL Editor; `databricks experimental aitools tools query "SHOW GRANTS ON SCHEMA frostsight.silver" --profile frostsight-free` |
| 02 | `volumes list` positional form | `databricks volumes list --help` |
| 02 | NVDB `srid=25833` and `inkluder=vegsegmenter` on v4 | `curl -s -H "X-Client: frostsight" "https://nvdbapiles.atlas.vegvesen.no/vegobjekter/105?fylke=55&antall=1&inkluder=vegsegmenter&srid=25833"` |
| 02 | Frost element ids, county filter, 412 code | T1.4 step 1 curls with a client id |
| 02 | DATEX element local names, `xsi:type` values, whether the site id ends with the station number | T1.5 step 3 on the landed XML; `uv run python -c "from collector.datex import parse_weather; print(next(parse_weather(open('tests/fixtures/datex_measured_weather.xml','rb').read())))"` |
| 02 | Plain file IO to `/Volumes` from a serverless Python task (`--target workspace`), and `WorkspaceClient().dbutils.secrets.get` there | `databricks bundle run collector -t aws` at M4 |
| 03 | `lookup: warehouse: ${var.warehouse_name}` substitution inside a lookup | `databricks bundle validate -t free --strict` |
| 03 | `presets.pipelines_development` key; `event_log` block; `root_path` import behaviour; boolean variable coercion for `continuous`/`development` | `databricks bundle validate -t aws --strict`; `databricks bundle schema \| jq '.. \| .event_log? // empty' \| head` |
| 03 | `pipelines list-pipelines` vs `pipelines list` | `databricks pipelines --help` |
| 03 | `WorkspaceClient(profile=...)` on a GitHub runner without a profile file | first `collector.yml` run log |
| 03 | `DATABRICKS_HOST`/`DATABRICKS_TOKEN` override `workspace.profile` in CI | first `ci.yml` run: `User:` line of `bundle validate` |
| 03 | `databricks tokens create` allowed on Free Edition | `databricks tokens create --lifetime-seconds 7776000 --comment test --profile frostsight-free` |
| 04 | `ST_GeomFromWKT` with `LINESTRING Z`; `h3_coverash3` on a LINESTRING; `ST_Centroid` | T3.3 step 1 and 2 in SQL Editor |
| 04 | `dropDuplicatesWithinWatermark` in a serverless pipeline on `CURRENT` | 05 T4.4 step 2 on `personal` |

### Open questions for the team

1. **File extension `.json` vs `.jsonl` (blocking for M4).** README section 4 fixes live and replay files as
   `.jsonl`; 05's `bronze.py` has `pathGlobFilter("*.json")` and its test paths use `.json`. With the
   README naming the pipeline would ignore every landed file. 05 must change the glob to `*.jsonl` (or
   drop the filter and rely on `_failed/` exclusion). Owner of 05.
2. **`_batch_id` for live files.** README and 05 (`batch_id_from_path`): the timestamp stem. 08 T7.x says
   `live:<collector run id>` and filters `_batch_id LIKE 'live:%'`. 08 should use `NOT LIKE 'replay:%'`.
3. **`free` target mode.** Decision 4 (and 03 now): `mode: development` with presets on all targets. 05
   T4.7 and 07 (dashboard naming note) still say `mode: production` for `free`/`aws`, and 05 still uses
   `schedule_paused`. 05/07 need the same rename to `schedule_pause_status` and the presets wording.
4. **Late rows.** 05 T4.8 step 5 (rows older than the watermark do not reach silver) and 08 line 109
   ("silver keeps them") contradict each other. 04 D4 follows 05. 08 should be corrected.
5. **Harness flags.** 05 T4.8 calls `--source road_weather --shift -20m`; 08 calls `--from D --to D --speed 0`.
   The harness now has `--latest --shift <minutes>` and `--from/--to`; 05 should use `--latest --shift -25`
   and `--shift -125` (a multiple of 10 lands on existing keys and is deduplicated, which is the duplicate
   test, not the late test).
6. **Event log location.** 05 publishes the pipeline event log to `gold.ingest_event_log`; 07 T6.x writes
   `silver.ingest_event_log`. 03 and 04 follow 05. Pick one in 07.
7. **Quarantine column names.** 05 writes `rule`, `quarantined_at`; 07's health-page SQL reads `rule_id`,
   `ingested_at`. 04 documents 05's names. 07 should be aligned.
8. **`silver.road_weather_observations` needs `station_ref` = NVDB station number from the collector.**
   If the DATEX site id does not carry it (T1.5 step 3), silver must resolve `station_id` through
   `silver.road_weather_stations.datex_site_id` instead of taking `station_ref` directly (05 T4.4). Decide
   once the first snapshot is in hand.
9. **Speed limits in 05.** `load_reference.py` reads `bronze.speed_limits` but `load_bronze` never loads
   `nvdb_speed_limits`; 02 lands the folder. 05 should add it to its `sources` map.
10. **Pipeline `permissions` for `users`.** Free Edition users are all admins, so the `CAN_VIEW` grant is
    cosmetic; keep it for AWS. Confirm the workspace-local `users` group exists as a principal for
    `permissions` on Free Edition (it does on standard workspaces).
11. **Actions minutes.** The 30-minute cron costs about 1,450 minutes per month on a private repo; the
    decision (public repo, 30-minute cadence, or static-IP host) is still open and blocks nothing at M2.

---

# Part B: files 05 to 08

## Review of 05_M4 to 08_M7: findings and fixes

Reviewer: Safiul (with Claude), 29 Sep 2026. Scope: files 05 to 08 against `00_README.md` (contract), 02_M1
and 03_M2 (what they consume), and the current Databricks skill references (`databricks-pipelines`,
`databricks-spark-structured-streaming`, `databricks-jobs`, `databricks-dabs`, `databricks-aibi-dashboards`,
`databricks-dbsql`). Files 01 to 04 and the README were not touched. The Databricks CLI is not installed on
the review machine, so anything that needs a workspace is listed under "Still to verify" with the exact
command.

Checks run on the edited files: every Python block parses (`ast.parse`, 28 blocks), every YAML block loads
(PyYAML, 11 blocks), the `risk_map.lvdash.json` is valid JSON and every widget `fieldName` matches a
`fields[].name` of its dataset, every `queryLines` element ends in a newline, the three risk worked examples
in 06 reproduce to 1e-9 from the YAML and the pure-Python engine, every task has owner / Why / Do / Expect /
If it fails, every file has "Done when" and "Verify", no cluster configuration anywhere, one pipeline, a
three-task serial `orchestrate` chain, triggered updates.

### Fixed

#### 05_M4_bronze_and_silver.md

- Section 0, item 14: development mode is a bundle variable (`pipeline_development`: true on `free` and `personal`, false on `aws`), not "personal only"; added item 16 (modern `pyspark.pipelines` API, no `dlt`).
- Section 1: added rows for the six-column quarantine contract, the `dq_rules.yml` source and the README landing layout (`.jsonl` live, `replay__<event_id>__<ts>.jsonl`, `_failed/<ts>.json` markers); incident types are the lower-case `IN003` set; `lat/lon` become `latitude/longitude` in silver.
- T4.1: removed the second, incompatible `dq_rules.yml` (grouped by dataset, `name/condition`); `config.py` now reads 03_M2's shape (`rules: [{id, table, expression, action}]`) with `dq_rules(table)`, `rules_by_action(table, action)`, `rule_actions()`; removed the duplicate `pyproject.toml` (03 owns it), kept only the dev extras.
- T4.2: `batch_id_from_path` docstring and test use the README file names (`.jsonl`, `replay__storm_2026_01_15__...`).
- T4.3: `pathGlobFilter` (generic file option the pipelines reference lists) set to `*.jsonl`, with the `_failed/*.json` reasoning and the glob-in-path fallback; `quarantine.schema_errors` is now `dp.create_streaming_table` plus one `@dp.append_flow` per bronze table (documented fan-in pattern) with the six canonical columns (`source`, `quarantined_at` instead of `_source`, `_ingested_at`).
- T4.4: rewritten. Rule ids from `dq_rules.yml` are the expectation names; `station_known` and `road_segment_id` come from stream-static joins (rules `XS001`, `XS002`, matching 04_M3's schema); the silver table is no longer pre-filtered, the `expect_all_or_drop` decorators drop the rows so the event log carries real failed counts that match the quarantine table; quarantine rows use the six columns; incidents keep `version`, `road_number`, `snapshot_time`, `latitude/longitude`; `incident_type` and `severity` lower-cased; column contracts written out for M6/M7.
- T4.5: `latitude/longitude`; `quarantine.unmapped_observations` uses the six columns and rule id `XS002`; fallback UDF name matches `geo.py`.
- T4.6: `geo.py` gains `centroid_4326`, `udf_centroid_lat/lon`, `udf_point_to_line_m`; `load_reference.py` reads NVDB properties by id (3591, 1083, 11179, 2021, 5055, 5056, 5074, 5078, 5079, 2324, 2325, 2326, 2344), loads `nvdb_speed_limits` and `elevation` into bronze (were referenced but never loaded), uses `referanse` for `road_segment_id`, `lokasjon.stedfestinger` for speed limits, `recursiveFileLookup` + `pathGlobFilter` for the date folders, converts NVDB local date+time to UTC, applies `ST001/ST002/SG001/SG002` with quarantine tables, computes `centroid_lat/lon` at load time (moved from 07 T6.3), accepts `--from/--to` (M7 backfill) and `--config-dir`.
- T4.7: `databricks.yml` snippet now equals the README table (`schedule_pause_status`, `pipeline_development`, `warehouse_name` + lookup, `config_dir`, `mode: development` on all targets, `presets` on `free` and `aws`, no `catalog.schema.yml`); pipeline uses `${var.config_dir}`, `development: ${var.pipeline_development}`, `permissions CAN_VIEW`; `reference` job has `from/to` parameters and `--config-dir`; `orchestrate` v1 uses `schedule_pause_status`; every `client: "4"` kept (the jobs reference documents `client` as the required key).
- T4.8: `.jsonl` everywhere, `--profile` on every command, `--full-refresh-all` / `--full-refresh <t>` / `--refresh <t>` forms, event-log queries read `frostsight.gold.ingest_event_log`, `list-pipeline-events` added; the late-file test no longer depends on a harness flag that 03's harness does not have.
- T4.9: added `test_rules.py` (18 unique ids, expected drop/warn sets), centroid assertion in `test_geo.py`, README replay name in `test_batch_id`.
- Done when / Verify: quarantine contract, bundle variables, all four quarantine tables counted, event-log query by rule id.

#### 06_M5_risk_engine.md

- Inputs paragraph: points at the 05 column contracts; states that the YAML here is authoritative and 04 is aligned to it.
- Decisions table: added the replay rule (04_M3 D9): scheduled runs skip `_batch_id LIKE 'replay:%'`; `--include-replay` scores them.
- T5.4: `build()` filters replay rows unless `--include-replay`; the lookup is de-duplicated per segment before the MERGE (the "duplicate matches" failure in the old "If it fails" is now prevented); `historical_closures` uses `incident_type = 'closure'` (lower case, rule `IN003`); placeholder `build_freshness.py` accepts `--config-dir`.
- T5.5: `pause_status: ${var.schedule_pause_status}`, `--config-dir ${var.config_dir}` on both tasks; note that this is the final task list (M6 swaps the script, M7 adds `health`); `--profile` on commands; the three worked examples re-checked: A 0.6875 HIGH, B 0.16 LOW, C 0.721875 HIGH, drivers as listed, weights sum to 1.0.
- Section 3: how to run a backfill of gold (`--since-hours 168 --include-replay` as a one-off) since `run-now` cannot change task parameters.
- Verify: `--profile` on the CLI commands.

#### 07_M6_product.md

- T6.1 item 6: silver is reached through gold views, never a two-part name (the dashboard skill states the deploy-time catalog/schema flags do not rewrite a schema you typed).
- T6.2: rewritten to the 03_M2 T2.8 table contracts. `gold.data_quality_summary` columns `source, last_successful_ingestion, last_event_time, ingestion_delay_min, threshold_min, status (FRESH | STALE | NO_DATA), rows_last_24h, quarantined_last_24h, computed_at`; `silver.data_quality_events` columns `event_id, event_time, run_id, source, table_name, rule_id, action, rows_checked, rows_failed, sample`, filled in Python from `gold.ingest_event_log` joined to `dq_rules.yml` for `action`; incidents freshness reads `snapshot_time`; quarantine counts use `source` and `quarantined_at`; `quarantine.late_road_weather` (04_M3 D4, rule `RW008`) added; the YAML task is not re-declared (it exists since M4/M5 with `environment_key: gold`); `gold.data_quality_summary_history` kept and referenced consistently by 08.
- T6.3: the one-off `ALTER TABLE` / `UPDATE` is gone; centroids are computed by the reference job (05 T4.6).
- T6.4: added `src/sql/002_gold_views.sql` (`v_segments`, `v_stations`, `v_observations`, `v_incidents` with `is_active`, `v_quarantine`, `v_dq_events`) so every dataset uses bare names; `ds_kpi` active incidents from `incident_summary.active_incidents`; `ds_incidents` and `ds_recent_incidents` from `v_incidents` (gold.incident_summary has no `is_active`, `start_time` or `severity`); `ds_stations` uses `latitude/longitude`; `ds_priority` no longer re-sorts `risk_drivers` (06 already emits the sorted top 3); `ds_freshness`, `ds_freshness_trend`, `ds_quarantine_today`, `ds_pipeline_runs` use the new column names; `ds_dq_rules` added for the M7 demo.
- T6.5: JSON datasets updated to the views and column names; platform_health row of the delta table uses `rule` / `quarantine_table` / `ingestion_delay_min` and `STALE`; troubleshooting line for field-name mismatch.
- T6.6: variables come from the README (`warehouse_name` lookup), no second declaration; corrected "free is mode: production" to the README's `mode: development` + `presets.name_prefix: ""`; `--profile` on `--force`; lookup-interpolation fallback.
- T6.7: no longer redefines `deploy-free.yml` with different secret names; references 03_M2's workflows and secrets (`DATABRICKS_HOST`, `DATABRICKS_TOKEN`), keeps the proof step; token-unavailable fallback moved to "If it fails".
- T6.9 / T6.10: views mentioned in grants; personal-workspace fill uses `reference`, `ingest`, `orchestrate` (there was no gold fixture loader in M5).
- T6.1, T6.8, T6.10: "If it fails" lines added. Done when / Verify updated (`FRESH`, `run_id`, `SHOW VIEWS`).

#### 08_M7_hardening_and_demo.md

- T7.1: `_failed/` exclusion explained by `pathGlobFilter *.jsonl` versus `.json` markers (no `cloudFiles.pathGlobFilter "20*.json"`); `${var.oncall_email}` replaced by `${var.notification_email}` and the existing `email_notifications` block is extended, not duplicated; `health` rule kept with the matching notification list; statuses `FRESH`/`STALE`, column `ingestion_delay_min`.
- T7.2: the `from/to` parameters exist since M4 (no "if not, add"); `--params` kept with its verify note and the documented `jobs run-now --json` form; `--full-refresh-all` / `--full-refresh <t>` / `--refresh <t>` per the pipelines reference; live `_batch_id` is the timestamp stem, so the diff query uses `NOT LIKE 'replay:%'`; the gold rebuild after a full refresh needs `--include-replay` for replayed days.
- T7.3: test file is `.jsonl` (otherwise the glob skips it); the new field is `visibility_m` (`road_surface_state` is already in contract v1) and the wrong-typed field is the raw `air_temperature`; the quarantine flow already exists in bronze with `rule = 'rescued_data'`; `quarantined_at`.
- T7.4: `repair-run` marked as not documented in the jobs skill (CLI `--help` check kept).
- T7.5: event-log source is `frostsight.gold.ingest_event_log`; lookup flow name `station_segment_lookup`.
- T7.6: pipeline tags already set in 05.
- T7.7: runbook commands carry `--profile`; harness invocation matches 03's CLI and README file names; `rows_failed`/`rows_checked`; `002_gold_views.sql` and `001_catalog_schemas_volume.sql` in the platform runbook; scheduled gold never scores replay rows.
- T7.8: replay dataset joins `v_segments`; data-quality demo query uses `rule_id, action, rows_failed` and a quarantine sample; `Do:` numbering added.
- T7.9: row 8 evidence is the `XS002` count; "If it fails" added. T7.7 "If it fails" added. Done when / Verify use `FRESH`/`STALE`/`NO_DATA` and `ingestion_delay_min`.

### Still to verify on a real workspace

| File | Item | Command |
|---|---|---|
| 05 T4.3 | `pathGlobFilter *.jsonl` skips `raw/<source>/_failed/<ts>.json` in Auto Loader | `databricks fs cp /tmp/x.json dbfs:/Volumes/frostsight/landing/raw/road_weather/_failed/20261103T071000Z.json --profile frostsight-personal && databricks bundle run ingest -t personal --profile frostsight-personal`, then `SELECT count(*) FROM frostsight.bronze.road_weather_events` unchanged |
| 05 T4.4 | `dropDuplicatesWithinWatermark` on the serverless pipeline runtime | `databricks pipelines list-pipeline-events <pipeline_id> --profile frostsight-personal \| jq '.events[] \| select(.level=="ERROR") \| .message'` |
| 05 T4.4, T4.5 | `ST_Distance`, `ST_Transform`, `ST_Point`, `ST_GeomFromWKT` (DBR 17.1+, Public Preview) inside the pipeline and on the warehouse | `databricks experimental aitools tools query --warehouse $WH --profile frostsight-free "SELECT ST_Distance(ST_Point(0,0,25833), ST_Point(3,4,25833))"` expects 5.0 |
| 05 T4.4 | `spark.conf.get("pipelines.id")` inside a pipeline; `pipelines.updateId` as the alternative | after one update: `SELECT DISTINCT pipeline_run_id FROM frostsight.quarantine.invalid_road_weather` |
| 05 T4.4 | Expectations on the silver table report failed counts equal to the quarantine rows for the same update | `SELECT x.name, sum(x.failed_records) FROM frostsight.gold.ingest_event_log e LATERAL VIEW explode(from_json(e.details:flow_progress.data_quality.expectations,'array<struct<name:string,dataset:string,passed_records:bigint,failed_records:bigint>>')) AS x WHERE e.origin.update_id = '<id>' GROUP BY 1` versus `SELECT rule, count(*) FROM frostsight.quarantine.invalid_road_weather WHERE pipeline_run_id = '<id>' GROUP BY 1` |
| 05 T4.6 | `h3_coverash3` accepts a LINESTRING WKT (the job falls back to the UDF if not) | `databricks experimental aitools tools query --warehouse $WH --profile frostsight-free "SELECT size(h3_coverash3('LINESTRING(18.9 69.6, 18.91 69.61)', 9))"` |
| 05 T4.6 | NVDB v4 field names (`referanse`, `vegsystemreferanse.strekning.fra_meter`, `lokasjon.stedfestinger`, `fylke` on 153 objects) and the flat `frost_sources` / `datex_sites` files | `SELECT * FROM read_files('/Volumes/frostsight/landing/raw/nvdb_road_network/', format => 'json') LIMIT 1` and the same for `nvdb_stations`, `frost_sources`, `datex_sites` |
| 05 T4.6 | `spark.conf.get("spark.databricks.job.runId")` key inside a serverless job task | `print(spark.conf.get("spark.databricks.job.runId", "missing"))` in the task log |
| 05 T4.7 | `${var.warehouse_name}` interpolated inside `lookup:` | `databricks bundle validate -t free --strict --profile frostsight-free` |
| 05 T4.7 | `artifacts` block shape; `root_path: ../src` makes `import frostsight` resolve in the pipeline; `event_log` key accepted | `databricks bundle schema \| jq '.properties.artifacts'`; `databricks bundle deploy -t personal --profile frostsight-personal && databricks bundle run ingest -t personal --profile frostsight-personal`; `databricks bundle schema \| jq '.. \| .event_log? // empty' \| head` |
| 05 T4.8 | `bundle run` flags `--full-refresh-all`, `--full-refresh <t>`, `--refresh <t>` on the installed CLI | `databricks bundle run --help` |
| 06 T5.5 | `environments[].spec.client: "4"` accepted (newer CLIs may also accept `environment_version`; keep one key) | `databricks bundle validate -t personal --strict --profile frostsight-personal` |
| 07 T6.2 | Published event log table readable from the warehouse and the TVF form as fallback | `q "SELECT count(*) FROM frostsight.gold.ingest_event_log"`; `q "SELECT count(*) FROM event_log(TABLE(frostsight.silver.road_weather_observations))"` |
| 07 T6.2 | `sql/setup_dq_tables.sql` (M2) created the two DQ tables with exactly the 03 T2.8 columns | `q "DESCRIBE frostsight.gold.data_quality_summary"`, `q "DESCRIBE frostsight.silver.data_quality_events"` |
| 07 T6.4 | `databricks experimental aitools tools query --warehouse` flag on the installed CLI (fallback `DATABRICKS_WAREHOUSE_ID`) | `databricks experimental aitools tools query --help` |
| 07 T6.4 | `system.lakeflow.job_run_timeline` readable on Free Edition (else the `v_dq_events` fallback) | `q "SELECT count(*) FROM system.lakeflow.job_run_timeline WHERE period_start_time >= current_date()"` |
| 07 T6.5 | Counter widget-level `filters` shape for the "unmapped observations" tile; `filter-single-select` bound to a STRING parameter renders usable | open the deployed dashboard in edit mode |
| 07 T6.6 | `bundle generate dashboard --resource <key> --watch` flags | `databricks bundle generate dashboard --help` |
| 08 T7.1 | `email_notifications.on_duration_warning_threshold_exceeded` accepted next to `health.rules` | `databricks bundle validate -t free --strict --profile frostsight-free` |
| 08 T7.2 | `bundle run <job> --params k=v,k=v` on the installed CLI (documented fallback: `jobs run-now --json`) | `databricks bundle run --help` |
| 08 T7.4 | `jobs repair-run` flag shape | `databricks jobs repair-run --help` |
| 08 T7.5 | `run_duration` and per-task `start_time`/`end_time` field names in `jobs list-runs` / `get-run` output | `databricks jobs get-run --run-id <id> -o json --profile frostsight-free \| jq '.tasks[0] \| keys'` |
| 08 T7.6 | `presets.tags`; `system.billing.usage.custom_tags` and `usage_metadata.dlt_pipeline_id`; `system.access.table_lineage` readable on Free | `databricks bundle validate -t aws --strict --profile frostsight-aws`; `q "DESCRIBE system.billing.usage"`; `q "SELECT count(*) FROM system.access.table_lineage WHERE event_date >= date_sub(current_date(), 7)"` |

### Open questions for the team

1. **03_M2 versus README naming (for the 01 to 04 reviewer).** 03 T2.2 uses `landing_volume_path` and lacks `landing_root`, `pipeline_development`, `notification_email`, `config_dir`, `warehouse_name`; 03 T2.6's replay harness writes `<ts>.replay-<event_id>.json` under nested `frost/observations` style folders, and 02 T1.3 lands NVDB under `nvdb/<dataset>/`. Files 05 to 08 follow the README (flat `raw/<source>/`, `.jsonl`, `replay__<event_id>__<ts>.jsonl`). 02 and 03 need the same alignment or the collector and the pipeline will not meet.
2. **`dq_rules.yml` expressions in 03 T2.7 assume `latitude`/`longitude`** (`IN004`, `ST001`). 05 now uses those names in silver. If the team prefers `lat`/`lon`, change the two rules in 03 and the columns in 05 T4.4, T4.5, T4.6 and 07 T6.4 together.
3. **`XS001`, `XS002` inside the pipeline** cost two stream-static joins per update (stations and lookup). Fine at county scale; nationally the lookup join should move to gold only. Decision needed before S1.
4. **Event log location.** 05 publishes it as `frostsight.gold.ingest_event_log` (05 T4.7); 07 and 08 read that name. If the bundle schema rejects the `event_log` key, every reader switches to `event_log(TABLE(...))`; keep it in one place (`EVENT_LOG` constant in `build_freshness.py`).
5. **Gold views for dashboards** (`src/sql/002_gold_views.sql`) are created by hand per target, like `001_catalog_schemas_volume.sql`. Should they become a `sql_task` in the `reference` job (would raise it to three tasks) or a `schemas`/`volumes`-style bundle resource? Left manual for now.
6. **`quarantine.late_road_weather` and `quarantine.invalid_road_segments` / `invalid_road_weather_stations`** are new tables introduced to honour 04_M3 D4 and the `ST*`/`SG*` rules. README section 4 lists only `invalid_<source>`, `unmapped_observations`, `schema_errors`; add the three names there or drop them.
7. **Free Edition task budget.** `orchestrate` (3 tasks) plus `reference` (2 tasks) hit the 5-concurrent-task limit on Monday 03:00 UTC as designed; a manual `reference --params from=...` backfill during the day competes with the 10-minute chain. Rule proposed: backfills on `free` only with `orchestrate` paused, or on `personal`.
8. **`replay/harness.py` (03 T2.6) still tags files `.replay-<event_id>.json`.** Until it is updated to README naming, `batch_id_from_path` will not recognise replay files and the scheduled gold job will score them as live. Owner: Sani (T2.6).

Stretch-driven changes to files 05 to 08 are listed in 13_stretch_review.md.
