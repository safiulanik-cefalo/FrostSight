# M7: Hardened and demo-ready

Owners: all. Read `00_README.md` first. Task owners follow the track table in `../overview.md`.

Goal: the system survives source outages, backfills, schema changes and restarts; performance is measured;
runbooks exist; the demo runs end to end on replayed last-winter data; the definition of done is met.

Inputs: everything from M6 running on `free`. A storm day `D` chosen at M1 whose files are in landing and
whose gold rows exist in `gold.road_segment_risk_history` (if not, T7.2 backfills it first).

## Task list

| Task | What | Owner |
|---|---|---|
| T7.1 | Outage and stale-data handling | Shawon |
| T7.2 | Backfill and reprocess | Sani |
| T7.3 | Schema-change test | Shawon |
| T7.4 | Failure recovery: pipeline restart and job repair | Rayhan |
| T7.5 | Performance benchmarks | Sani |
| T7.6 | Cost report and lineage check | Rayhan |
| T7.7 | Runbooks | all, one each |
| T7.8 | Demo script | Safiul |
| T7.9 | Definition of done and handover to stretch | Safiul |

---

### T7.1 Outage and stale-data handling      owner: Shawon
Why: DATEX will be down some night. The platform must say "stale" instead of showing yesterday's risk as current.

Do:
1. Collector retries and dead-letter, in `collector/common.py`:

```python
import json, time, pathlib, datetime as dt
import requests

RETRY_WAITS = (5, 15, 45)          # seconds; three attempts, then dead-letter

def fetch_with_retry(session: requests.Session, url: str, **kw) -> requests.Response:
    last = None
    for wait in (*RETRY_WAITS, None):
        try:
            r = session.get(url, timeout=30, **kw)
            if r.status_code < 500 and r.status_code != 429:
                r.raise_for_status()
                return r
            last = RuntimeError(f"HTTP {r.status_code}")
        except requests.RequestException as e:
            last = e
        if wait is None:
            raise last
        time.sleep(wait)

def write_failed_marker(landing_root: pathlib.Path, source: str, error: Exception) -> pathlib.Path:
    """Dead-letter: a marker file so a missed poll is visible in the landing zone, not just in a log."""
    ts = dt.datetime.now(dt.timezone.utc)
    p = landing_root / source / "_failed" / f"{ts:%Y%m%dT%H%M%SZ}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"source": source, "at": ts.isoformat(), "error": str(error)}))
    return p
```

   In `collector/run.py`, wrap each source: on exception, write the marker, exit non-zero so the GitHub Actions run is red. Auto Loader ignores `_failed/` because the bronze read uses `.option("pathGlobFilter", "*.jsonl")` (05_M4 T4.3) and the markers are `.json`: `raw/<source>/<yyyy>/<mm>/<dd>/<ts>.jsonl` is read, `raw/<source>/_failed/<ts>.json` is not. Confirm the option is in `src/pipelines/bronze.py`. verify: land one marker on `personal`, run an update, bronze must not grow (T4.3 step 3 has the fallback glob-in-path form).
2. What the platform does with no new files: the `orchestrate` job still runs every 10 minutes. The pipeline update finds no files and completes in under a minute (a no-op). `build_gold` finds no observation newer than 30 minutes, so `gold.road_segment_current_risk` keeps its last values and its old `risk_updated_at`. `build_freshness` recomputes `ingestion_delay_min` every run, so `road_weather` flips to `STALE` after 30 minutes without data (`threshold_min`). The "Data age" tile on the risk map grows; the health table shows `STALE` in red. Nothing invents data.
3. Test: pause the collector for one hour. Disable the `collector.yml` workflow (`gh workflow disable collector.yml`) or stop the cron on the VM. Wait 60 minutes. Record: the time `road_weather` turned `STALE` (should be 30 to 40 minutes after the last file), what the risk map showed, that the orchestrate runs stayed green. Re-enable. Record when it turned `FRESH` again (one job run after the first new file).
4. Add a job health rule so a human hears about a slow chain: in `resources/orchestrate.job.yml`, next to the existing `email_notifications` block (`on_failure: ["${var.notification_email}"]`, `no_alert_for_skipped_runs: true` from 06_M5 T5.5), add

```yaml
      health:
        rules:
          - { metric: RUN_DURATION_SECONDS, op: GREATER_THAN, value: 900 }
```

   (a `health` rule breach sends to the `on_duration_warning_threshold_exceeded` list; add `on_duration_warning_threshold_exceeded: ["${var.notification_email}"]` under `email_notifications`). And a SQL alert on `gold.data_quality_summary` where `status = 'STALE' AND source = 'road_weather'` (Free Edition plan said SQL alerts exist; email destination only). Create it in the UI for now; the bundle `alerts` resource is S2 work.

Expect: during the pause, `SELECT source, status, ingestion_delay_min FROM frostsight.gold.data_quality_summary` shows `road_weather STALE 6x`; `gold.data_quality_summary_history` shows the delay climbing in 10-minute steps; a `_failed/` marker appears if you also break the URL.

If it fails:
- Status never turns STALE: `build_freshness` uses `run_if: ALL_DONE`? If the pipeline task failed instead of no-op, the job stopped before freshness. Check `run_if`.
- Auto Loader picked up the marker file and quarantined it: the `pathGlobFilter` option is missing; add it and delete the quarantine rows.

---

### T7.2 Backfill and reprocess      owner: Sani
Why: WR-UC-25 and spec section 21. Two different mechanisms: batch sources re-run by date range; the streaming path re-reads landing.

Do:
1. Batch sources: `reference.job.yml` has job parameters `from` and `to` since M4 (05_M4 T4.7, passed to the task as `--from {{job.parameters.from}} --to {{job.parameters.to}}`); `load_reference.py` filters the landing files by their `<yyyy>/<mm>/<dd>` folder, empty means "the newest extract day only". Run a backfill:

```bash
databricks bundle run reference -t free --profile frostsight-free --params from=2026-11-01,to=2026-11-03
```

   verify: `--params key=value,key=value` is the `bundle run` flag for job parameters on your CLI version (`databricks bundle run --help`); the jobs skill does not document it. The equivalent the jobs skill documents and that always works:
   `databricks jobs run-now --json '{"job_id": <id from bundle summary>, "job_parameters": {"from": "2026-11-01", "to": "2026-11-03"}}' --profile frostsight-free`.
   The loads are idempotent because every target is a `MERGE` on the natural key, so running the same range twice changes nothing.
2. Streaming path, two cases:
   - **Files missed while the collector was down.** DATEX has no history; the gap stays for road weather live data. For last winter's data, the replay harness writes Frost history files into landing (M2 prototype), and Auto Loader ingests them on the next update like any other file. Watermark note: silver does **not** keep late rows. A row whose event time is more than 30 minutes behind the maximum its flow has already seen is dropped by the dedup operator (05_M4 T4.4; the 2-hour test in 05_M4 T4.8 step 5 shows it). It does not reach the pipeline's quarantine tables either; it is visible in two places: `quarantine.late_road_weather` (rule `RW008`, copied from bronze by `build_freshness`, 07_M6 T6.2) and bronze itself (`bronze.road_weather_events` keeps every landed row). Frost history is not affected in practice: harness files are replay files, so they go through the separate `road_weather_replay` flow, whose watermark follows the replayed days as long as they are written in event-time order (one backfill or one event at a time; an older event after a newer one needs the reset in 10_S1 D3). A live file that arrives more than 30 minutes late is recovered only by a full refresh of silver (below), which rebuilds it from bronze in one batch. Document this in the runbook.
   - **Rule change, reprocess everything.** Full refresh of the pipeline drops and rebuilds every streaming table from landing:

```bash
databricks bundle run ingest --full-refresh-all -t free --profile frostsight-free
# or, by pipeline id from `bundle summary`:
databricks pipelines start-update <pipeline_id> --full-refresh --profile frostsight-free
```

   `--full-refresh-all` (everything) and `--full-refresh <table,...>` (selected tables) are the documented `bundle run` flags; `--refresh <table>` is an incremental re-run of one table. Warning from the pipelines skill: full refresh destroys streaming state and re-reads every file in landing; on the pilot county that is minutes, nationally it would be hours. Gold is not touched by the pipeline; run `databricks bundle run orchestrate -t free --profile frostsight-free` afterwards so `build_gold` recomputes from the rebuilt silver (`--since-hours 168` as a one-off rebuilds the window table; risk history for a replayed event comes from `build_gold.py --event-id <id>`, 06_M5 T5.4 step 3, because the scheduled mode scores only readings under 30 minutes old).
3. Replay versus live diff with `_batch_id`. Live files carry `_batch_id = <UTC timestamp stem>` (for example `20260115T081000Z`); replay files carry `replay:<event_id>` (README section 4). After a replay of day `D`, compare:

```sql
WITH live AS (
  SELECT station_id, date_trunc('hour', event_time) AS h, count(*) AS n_live, avg(road_surface_temperature_c) AS t_live
  FROM frostsight.silver.road_weather_observations WHERE _batch_id NOT LIKE 'replay:%' AND event_time::date = DATE 'D' GROUP BY 1, 2),
replay AS (
  SELECT station_id, date_trunc('hour', event_time) AS h, count(*) AS n_replay, avg(road_surface_temperature_c) AS t_replay
  FROM frostsight.silver.road_weather_observations WHERE _batch_id LIKE 'replay:%' AND event_time::date = DATE 'D' GROUP BY 1, 2)
SELECT coalesce(l.station_id, r.station_id) AS station_id, coalesce(l.h, r.h) AS h,
       n_live, n_replay, round(t_live - t_replay, 2) AS temp_diff
FROM live l FULL OUTER JOIN replay r USING (station_id, h)
WHERE n_live IS DISTINCT FROM n_replay OR abs(coalesce(t_live - t_replay, 0)) > 0.01
ORDER BY 1, 2;
```

   Silver carries `_batch_id` through from bronze (05_M4 T4.4 column contract). Zero rows means replay reproduced live. Save the query as `src/sql/replay_diff.sql`.

Expect: the backfill run finishes green; row counts before and after a repeated run are equal; the diff query returns zero rows for a replayed day; `DESCRIBE HISTORY frostsight.silver.road_segments` shows a `MERGE` operation with `numTargetRowsInserted = 0` on the second run.

If it fails:
- `--params` unknown: use the `jobs run-now --json` form.
- Full refresh hangs on "WAITING_FOR_RESOURCES": another update of the one pipeline is running (Free Edition allows one). `databricks pipelines stop <pipeline_id>` first.
- Diff shows counts off by one per hour: the dedup key `(station_id, event_time)` collapses a duplicate in one path only; check that both file sets contain the same `_source_event_id`.

---

### T7.3 Schema-change test      owner: Shawon
Why: Statens vegvesen will add a field one day. The pipeline must neither crash for good nor silently drop the field.

Do:
1. Read `src/pipelines/bronze.py` and note the Auto Loader options: `cloudFiles.schemaEvolutionMode` (`addNewColumns`) and `rescuedDataColumn` (`_rescued_data`). Write the value found here: `mode = ______`.
2. Make a test file: copy the latest road-weather landing file, add a new top-level field to every record (`"visibility_m": 250`, a field not in contract v1), and one record with a wrong type in an existing field (`"air_temperature": "n/a"`). Upload it as a new file name in today's folder (`.jsonl`, or the glob skips it):

```bash
databricks fs cp /tmp/schema_test.jsonl dbfs:/Volumes/frostsight/landing/raw/road_weather/2026/11/03/20261103T121000Z.jsonl --profile frostsight-free
databricks bundle run ingest -t free --profile frostsight-free
```

3. What you should see, by mode:

| Mode | New field `visibility_m` | Wrong-typed `air_temperature` |
|---|---|---|
| `addNewColumns` (default) | The update fails once with `UnknownFieldException`; the pipeline retries the update automatically, evolves the bronze schema, and the column appears with NULL for old rows. Two updates in the event log, the first `FAILED`, the second `COMPLETED` | Goes into `_rescued_data` as `{"air_temperature":"n/a"}`; the column is NULL |
| `rescue` | No new column. The whole field lands in `_rescued_data` for every row of that file | Same |
| `failOnNewColumns` | The update fails and stays failed until someone changes the schema. Not what we want | Same |

   verify: that the serverless pipeline retries the failed update by itself after schema evolution (it does on triggered updates started by a job; a manual `bundle run` may show the failure and need one more run).
4. Rescued rows are already routed: `src/pipelines/bronze.py` (05_M4 T4.3) appends every bronze row with `_rescued_data IS NOT NULL` to `quarantine.schema_errors` with `rule = 'rescued_data'` and `reason = _rescued_data`, through one append flow per bronze table. Confirm both flows exist. Then the health page's "schema_errors" bar moves when a source changes shape, and nobody has to read logs.
5. Record the outcome in `docs/schema_change_test.md`: mode, what happened, how long until the pipeline was healthy, and what the operator has to do (for `addNewColumns`: nothing; for `rescue`: update the schema hints and full-refresh that table).

Expect: after the test, `SELECT count(*) FROM frostsight.quarantine.schema_errors WHERE quarantined_at >= current_date()` is 1 (the bad-typed row) in `addNewColumns` mode; `DESCRIBE frostsight.bronze.road_weather_events` lists `visibility_m`; silver is unchanged because silver selects named columns.

If it fails:
- The update fails twice with `UnknownFieldException`: the retry did not fire; run `bundle run ingest` once more.
- Nothing quarantined and no new column: the file was not picked up; check the file name ends in `.jsonl` (T7.1 glob) and that it is newer than the checkpoint.

---

### T7.4 Failure recovery: pipeline restart and job repair      owner: Rayhan
Why: spec section 24 pipeline tests: restart after failure, no duplicates. This is what checkpoints are for; prove it.

Do:
1. Take a baseline:

```sql
SELECT count(*) AS n, count(DISTINCT station_id, event_time) AS n_distinct FROM frostsight.silver.road_weather_observations;
```

2. Drop three fresh files into landing (copy three historical files with new names), start an update, and kill it while it is running:

```bash
databricks bundle run ingest -t free --profile frostsight-free &     # or start-update, capture the update id
sleep 40
databricks pipelines stop <pipeline_id> --profile frostsight-free       # cancels the running update
```

3. Re-run `databricks bundle run ingest -t free`. Then the baseline query again. `n` must equal `n_distinct`, and `n` must have grown by exactly the rows in the three files. Auto Loader's checkpoint records which files were committed; the cancelled update either committed a file or did not, never half.
4. Job repair. Break `build_gold` on purpose (a wrong catalog name through a temporary env var, or `raise RuntimeError("repair test")` behind an env check), run `orchestrate`, watch the task fail and `build_freshness` still run (`ALL_DONE`). Fix the code, deploy, then repair the same run instead of starting a new one:
   - UI: Workflows > orchestrate > the failed run > "Repair run" > keep "rerun failed tasks" > Repair.
   - CLI: `databricks jobs repair-run --json '{"run_id": <run_id>, "rerun_all_failed_tasks": true}' --profile frostsight-free`. verify: the jobs skill does not document `repair-run`; check the flag shape (`--json` versus `RUN_ID --rerun-all-failed-tasks`) with `databricks jobs repair-run --help`.
   A repair reruns only the failed tasks and their dependents; the pipeline task is not run again. Check `gold.road_segment_current_risk.risk_updated_at` advanced once, not twice.
5. Record both results in `docs/failure_recovery.md` with the counts and run ids.

Expect: `n = n_distinct` before and after; the repaired run shows the original run id with a "repair" history in the UI; `databricks jobs get-run --run-id <id>` lists `repair_history`.

If it fails:
- `n > n_distinct` after the restart: silver dedup is missing or keyed wrongly (`dropDuplicatesWithinWatermark` on `station_id, event_time`); fix in `silver.py` and full-refresh silver.
- Repair reruns the pipeline task too: the failed task list included it; deselect in the UI or list tasks explicitly with `"rerun_tasks": ["build_gold", "build_freshness"]`.

---

### T7.5 Performance benchmarks      owner: Sani
Why: spec section 20 asks the team to measure on purpose. On Free Edition the levers are file layout and incremental versus full refresh; the numbers go into `docs/benchmarks.md`.

Do:
1. Measure these, one row each, three runs where it says so:

| Measure | How | Runs |
|---|---|---|
| Pipeline update duration, one 10-minute batch | Event log query below, `update_progress` COMPLETED minus first event of the update | 3 |
| Pipeline update, no new files (no-op) | Same | 3 |
| Pipeline full refresh, whole pilot-county landing | Same, one `--full-refresh` update | 1 |
| `build_gold` task duration | `databricks jobs list-runs` below, `run_duration` of the task | 3 |
| End-to-end latency, `event_time` to `risk_updated_at` | `ds_latency` query from M6 T6.4 (median and p95 over 24 h) | 1 |
| Dashboard dataset query times | `time q "<query>"` for the four heaviest datasets: `ds_map`, `ds_priority`, `ds_kpi`, `ds_quarantine_today`; also `system.query.history` if readable | 3 each |
| Table sizes and file counts | `DESCRIBE DETAIL` on every bronze, silver, gold table | 1 |
| Spatial lookup build | Duration of the `station_segment_lookup` flow in the event log (`origin.flow_name`, from M3 benchmark, re-run) | 1 |

2. Collection commands:

```sql
-- pipeline update durations, last 2 days
SELECT origin.update_id,
       min(timestamp) AS started, max(timestamp) AS ended,
       timestampdiff(SECOND, min(timestamp), max(timestamp)) AS seconds,
       max(CASE WHEN event_type = 'update_progress' THEN details:update_progress:state END) AS final_state
FROM frostsight.gold.ingest_event_log              -- the published event log (05_M4 T4.7); TVF form in M6 T6.2 step 4
WHERE timestamp >= timestampadd(DAY, -2, current_timestamp())
GROUP BY origin.update_id ORDER BY started DESC;

-- sizes and files
DESCRIBE DETAIL frostsight.silver.road_weather_observations;   -- numFiles, sizeInBytes, clusteringColumns, partitionColumns
```

```bash
JOB_ID=$(databricks bundle summary -t free --profile frostsight-free -o json | jq -r '.resources.jobs.orchestrate.id')
databricks jobs list-runs --job-id "$JOB_ID" --limit 10 -o json --profile frostsight-free \
  | jq -r '.runs[] | [.run_id, .start_time, .run_duration, .state.result_state] | @tsv'
databricks jobs get-run --run-id <run_id> -o json --profile frostsight-free | jq '.tasks[] | {task_key, run_duration: (.end_time - .start_time)}'
```

   verify: `run_duration` and per-task `start_time`/`end_time` field names in the `list-runs` / `get-run` output of your CLI version.
3. Incremental versus full refresh: one triggered update with one batch, one full refresh, both from the event-log query. Expected shape: incremental in tens of seconds, full refresh in minutes; the ratio is the number to quote.
4. Layout check and fix for the gold tables the job writes (pipeline-owned tables are maintained by the pipeline; do not `OPTIMIZE` them by hand; verify: whether manual `OPTIMIZE` on a streaming table from outside its pipeline is rejected on your runtime):

```sql
ALTER TABLE frostsight.gold.road_segment_risk_history CLUSTER BY (road_segment_id, risk_updated_at);
ALTER TABLE frostsight.gold.road_segment_current_risk CLUSTER BY (road_segment_id);
OPTIMIZE frostsight.gold.road_segment_risk_history;
DESCRIBE DETAIL frostsight.gold.road_segment_risk_history;   -- clusteringColumns now set, numFiles down
```

   Re-time `ds_risk_history` (road detail) and `ds_latency` before and after; record both.
5. Write `docs/benchmarks.md`: one table per measure with date, target, number, and a one-line reading of what it means. Numbers without a date are useless a month later.

Expect: `docs/benchmarks.md` filled; `numFiles` on `road_segment_risk_history` drops after `OPTIMIZE`; `ds_map` under 3 seconds on the warm warehouse.

If it fails:
- `CLUSTER BY` rejected: the table was created without liquid clustering and has partitions; recreate it (`CREATE TABLE ... CLUSTER BY ... AS SELECT`) in a slot when the job is paused.
- Query history table not readable on Free: use `time q` timings only and say so in the doc.

---

### T7.6 Cost report and lineage check      owner: Rayhan
Why: the platform track owns "cost report" and "lineage check" at M7. Free Edition and AWS differ; write down which is verified.

Do:
1. Free Edition. There is no billing schema and job run metadata carries no DBU field; `databricks jobs list-runs` gives durations only. Report: runs per day (144 orchestrate runs at a 10-minute cadence), mean run duration, pipeline update durations from T7.5, warehouse active hours (the warehouse's Monitoring tab). State plainly: "DBUs are not exposed on Free Edition; cost is $0 by construction; these are the durations that would drive cost on a paid workspace."
2. AWS. Tag the bundle so usage can be filtered. In `databricks.yml`:

```yaml
targets:
  aws:
    presets:
      tags: {project: frostsight}         # applied to jobs; verify: presets.tags support on your CLI version
```

   The pipeline already carries `tags: {project: frostsight}` (05_M4 T4.7); the warehouse takes none, filter it by id. Query (needs `system.billing` readable):

```sql
SELECT u.usage_date, u.sku_name,
       CASE WHEN u.usage_metadata.job_id IS NOT NULL THEN 'job'
            WHEN u.usage_metadata.dlt_pipeline_id IS NOT NULL THEN 'pipeline'
            WHEN u.usage_metadata.warehouse_id IS NOT NULL THEN 'warehouse' ELSE 'other' END AS kind,
       sum(u.usage_quantity) AS dbus,
       sum(u.usage_quantity * p.pricing.default) AS usd_list
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices p
  ON p.sku_name = u.sku_name AND p.cloud = u.cloud AND p.price_end_time IS NULL
WHERE u.workspace_id = :workspace_id
  AND u.usage_date >= date_sub(current_date(), 30)
  AND (u.custom_tags['project'] = 'frostsight'
       OR u.usage_metadata.dlt_pipeline_id = :pipeline_id
       OR u.usage_metadata.warehouse_id = :warehouse_id)
GROUP BY 1, 2, 3 ORDER BY 1 DESC, 5 DESC;
```

   verify: `custom_tags` is a MAP column on `system.billing.usage` and `usage_metadata.dlt_pipeline_id` is the pipeline key name in your region's schema (`DESCRIBE system.billing.usage`). Which of the two is verified goes in `docs/cost_report.md`: on Free only the duration report; on `aws` the query above with a screenshot of the result.
3. Lineage check (Unity Catalog, works on Free):

```sql
SELECT source_table_full_name, target_table_full_name, max(event_time) AS last_seen
FROM system.access.table_lineage
WHERE target_table_full_name LIKE 'frostsight.gold.%' AND event_date >= date_sub(current_date(), 7)
GROUP BY 1, 2 ORDER BY 2, 1;
```

   Expected chain: `landing` path -> `bronze.road_weather_events` -> `silver.road_weather_observations` -> `gold.road_segment_current_risk` and `gold.road_segment_risk_history`. Also open Catalog Explorer > `gold.road_segment_current_risk` > Lineage tab and screenshot the graph for the docs. verify: `system.access` is enabled and readable on the Free Edition metastore; if not, the Catalog Explorer lineage tab is the evidence.

Expect: `docs/cost_report.md` and a lineage screenshot in `docs/`. The lineage query returns the bronze-silver-gold chain with `last_seen` within the last hour.

If it fails: lineage rows missing for gold: `build_gold` writes with `saveAsTable`/`MERGE` through Spark SQL, which is captured; a `write.format("delta").save(path)` to a path is not. Use table names.

---

### T7.7 Runbooks      owner: all
Why: the definition of done says "documentation describes operational procedures". One runbook per track, one template, so they read the same.

Do:
1. Template `runbooks/_template.md`:

```markdown
# Runbook: <track>
Purpose: what this track keeps running, in two lines.
Schedule: what runs when (cron, trigger, cadence) and where (GitHub Actions, orchestrate job, pipeline).
Run manually: the exact commands.
Check health: the query or screen that says "fine" and the numbers that mean "fine".
Common failures and fixes: table of symptom, cause, fix.
Backfill or reprocess: the exact commands and what they will and will not repair.
Contacts: owner, backup, where the team talks.
```

2. Write the four files. Content to put under each heading:

**`runbooks/ingestion.md`** (Shawon)
- Purpose: collector pulls DATEX road weather and incidents, NVDB weekly, into `frostsight.landing.raw`.
- Schedule: `collector.yml` cron every 30 min (road weather, incidents); VM cron if the DATEX fixed IP is enforced; NVDB weekly Sunday 03:00 UTC.
- Run manually: `python -m collector.run --source road_weather --target free`; `--source incidents`; `--source nvdb`.
- Check health: `databricks fs ls dbfs:/Volumes/frostsight/landing/raw/road_weather/<yyyy>/<mm>/<dd>/ --profile frostsight-free` shows a `.jsonl` file every 10 to 30 min; no files under `raw/road_weather/_failed/` today; Platform Health shows `road_weather FRESH`.
- Common failures: HTTP 401 from DATEX (account expired; renew form); HTTP 429 (rate limit; retries handle it, otherwise slow the cron); `_failed/` marker every run (endpoint changed; compare with `config/sources.yml`); GitHub Actions minutes exhausted (switch cadence to 30 min or move to the VM).
- Backfill: DATEX has no history; Frost history through the replay harness (`uv run python -m replay.harness --event <event_id> --speed 0 --target free`, files named `replay__<event_id>__<ts>__r<run start>.jsonl`, `_batch_id = replay:<event_id>`, through the `road_weather_replay` flow); NVDB by re-running the weekly source and `reference` with `--params from=...,to=...` (T7.2).
- Contacts: Shawon, backup Rayhan, `#frostsight` channel.

**`runbooks/transformation.md`** (Sani)
- Purpose: the `ingest` pipeline (bronze, silver, lookup) and the `build_gold` task.
- Schedule: `orchestrate` job every 10 min: pipeline update -> build_gold -> build_freshness.
- Run manually: `databricks bundle run ingest -t free --profile frostsight-free`; `databricks bundle run orchestrate -t free --profile frostsight-free`; full refresh from T7.2; errors: `databricks pipelines list-pipeline-events <pipeline_id> --profile frostsight-free`.
- Check health: pipeline UI shows the last update COMPLETED under 3 min; `ds_latency` median under 15 min; `n = n_distinct` query from T7.4; `gold.road_segment_current_risk.risk_updated_at` within 20 min.
- Common failures: `UnknownFieldException` (schema evolved; the retry handles it; see `docs/schema_change_test.md`); update stuck WAITING_FOR_RESOURCES (another update running; stop it); expectations dropping everything (`silver.data_quality_events` shows `rows_failed = rows_checked` for a rule; a unit change at the source; fix the transform and full-refresh silver); `build_gold` MERGE conflict (two orchestrate runs overlapped; `max_concurrent_runs: 1` must be set); silver observations all `station_known = false` (the `reference` job never ran on this target).
- Backfill: T7.2 steps; replay diff query `src/sql/replay_diff.sql`.
- Contacts: Sani, backup Safiul.

**`runbooks/platform.md`** (Rayhan)
- Purpose: Unity Catalog layout, grants, bundle deploys, CI, freshness and quarantine monitoring.
- Schedule: `ci.yml` on every PR; `deploy-free.yml` on merge to `main`; `deploy-aws.yml` manual.
- Run manually: `databricks bundle validate --strict -t free --profile frostsight-free`; `databricks bundle deploy -t free --profile frostsight-free`; grants from `src/sql/grants.sql`; views from `src/sql/002_gold_views.sql`; schemas once per workspace from `sql/001_catalog_schemas_volume.sql`.
- Check health: last `deploy-free` run green; `bundle summary` matches the workspace; Platform Health page: all sources FRESH (elevation may be NO_DATA), quarantine today under 100 rows, schema_errors 0.
- Common failures: deploy lock (T6.7); "modified remotely" on dashboards (T6.6 step 4); token expired (rotate, update the repository secret); `PERMISSION_DENIED` for a user (grants.sql); Free Edition task quota hit (someone's personal job running in the team workspace; move it).
- Backfill: not applicable; for a broken deploy, redeploy the previous commit (`git checkout <sha> -- project && databricks bundle deploy -t free`).
- Contacts: Rayhan, backup Shawon.

**`runbooks/analytics.md`** (Safiul)
- Purpose: the four dashboards, the risk engine's weights, gold contracts, Genie space.
- Schedule: dashboards refresh on open (no scheduled refresh on Free; add a schedule on `aws` if wanted); risk weights change only through a PR to `config/risk_weights.yml`.
- Run manually: `databricks bundle run orchestrate -t free --profile frostsight-free` to force a new risk row; `databricks bundle open risk_map -t free --profile frostsight-free`.
- Check health: risk map data age under 20 min; stations reporting close to the total; road detail opens for a real segment id; priority list rank 1 has the highest icing score.
- Common failures: widget with red icon (SQL error; edit mode shows it; usually a renamed column in gold); empty map (centroids NULL; M6 T6.3); risk everywhere LOW in autumn (expected; use the replay for demos); `ds_priority` empty (threshold too low for the season).
- Backfill: risk history for a past event: replay its files (harness), then `build_gold.py --catalog frostsight --event-id <id>` as a one-off (history only, marked `replay:<id>`); the engine is deterministic, so the same input gives the same rows. Scheduled runs never score replay rows, and every live history query filters `coalesce(_batch_id, '') NOT LIKE 'replay:%'`.
- Contacts: Safiul, backup Sani.

Expect: four runbooks plus the template under `runbooks/`, each with all seven headings, each command copy-pasteable.
If it fails: a command in a runbook does not run as pasted (missing `--profile` or `-t`; every command names both); a heading is empty ("not applicable" with one line of reason is fine, blank is not).

---

### T7.8 Demo script (15 minutes)      owner: Safiul
Why: the demo must not depend on Norwegian weather on the day. It runs on storm day `D` from last winter, replayed.

Do:
1. Preparation, the day before:
- If S1 is done: use S1's `FrostSight · Storm replay` dashboard (10_S1 T-S1.7) and its `replay` job; it **supersedes** the `risk_map_replay` dashboard below, which is then not deployed. Preparation is 10_S1 T-S1.5 steps 1 to 4 for the event of day `D`.
- If not: land day `D` with the harness (`uv run python -m replay.harness --event <D event id> --speed 0 --target free`; the files go through the replay flow), wait for one `orchestrate` update, then score it once with `python build_gold.py --catalog frostsight --event-id <D event id>` (06_M5 T5.4 step 3; history only, `_batch_id = replay:<id>`, never current risk). Check with `SELECT count(*), min(risk_updated_at), max(risk_updated_at) FROM frostsight.gold.road_segment_risk_history WHERE _batch_id = 'replay:<D event id>'`. Deploy a fifth dashboard `risk_map_replay.lvdash.json` (superseded by S1's replay dashboard once S1 is done): the risk map JSON with a parameter `as_of` (STRING, default `'D 07:00:00'`) and this map dataset:

```sql
SELECT h.road_segment_id, s.road_number, s.centroid_lat AS lat, s.centroid_lon AS lon, h.risk_level, h.icing_score, h.event_time
FROM road_segment_risk_history h JOIN v_segments s USING (road_segment_id)
WHERE h._batch_id LIKE 'replay:%'
  AND h.event_time <= to_timestamp(:as_of) AND h.event_time >= timestampadd(HOUR, -1, to_timestamp(:as_of))
QUALIFY row_number() OVER (PARTITION BY h.road_segment_id ORDER BY h.event_time DESC) = 1
```

   Stepping the `as_of` parameter (`07:00`, `08:00`, `09:30`) is the replay.
- Warm the warehouse 10 minutes before: open each dashboard once.
- Have `q` ready in a terminal with the two SQL snippets below pasted.

2. Script:

| Minute | Show | Exactly this | Say |
|---|---|---|---|
| 0-1 | Slide: context diagram | `../overview.md` (b) | Three open sources, one county, one pipeline, icing risk with drivers. Not an official warning service. |
| 1-3 | Platform Health (live) | Freshness table, quarantine bars, latency tile | This is live right now: last file `n` minutes ago, `x` rows quarantined today by rule. If the feed is stale, the tile says so; that is the feature. |
| 3-4 | Landing volume | `databricks fs ls dbfs:/Volumes/frostsight/landing/raw/road_weather/<today>/` | Collector runs outside, one file per poll, Auto Loader takes it from here. |
| 4-8 | Risk map replay | S1 done: `FrostSight · Storm replay`, event `D`, step `snapshot_time`. Otherwise `risk_map_replay`, `as_of` = `D 07:00`, then `08:00`, then `09:30` | Watch E8 and E6 turn orange then red as surface temperature crosses zero with snow. Incidents table shows the closures reported that morning. |
| 8-10 | Road detail | `road_detail`, `road_segment_id` = the segment that went VERY_HIGH | Risk per type, the driver bars, nearest station readings, recent incidents on the same road. Explainable: each bar is a normalised factor from `risk_weights.yml`. |
| 10-12 | Gritting priority | `priority_list`, `road_number` = E8, `surface_max_c` = 1 | Same gold table, filtered for a contractor: ranked, with the main drivers in words. |
| 12-13 | Data quality | `q "SELECT rule_id, action, sum(rows_failed) FROM frostsight.silver.data_quality_events WHERE event_time >= current_date() GROUP BY 1, 2"` and one quarantine sample row (`SELECT rule, reason, original_row FROM frostsight.quarantine.invalid_road_weather ORDER BY quarantined_at DESC LIMIT 1`) | Bad rows are counted and kept, never dropped silently. |
| 13-14 | Engineering | GitHub: last `deploy-free` run; `resources/` tree; `docs/benchmarks.md` | Everything is a bundle; CI validates and deploys; here are the measured numbers. |
| 14-15 | Limitations and stretch | Spec section 30 list | Observed versus derived versus predicted; incident data is incomplete; next: replay through the live pipeline, alerts, ML. |

3. Fallback if the live feed is stale on demo day: keep minute 1-3 and say why the tile is red (that is what it is for), then run the rest on the replay, which has no live dependency. If the warehouse is cold, the first dashboard takes a minute; warm it beforehand.

Expect: a dry run the day before completes in 14 minutes with no query over 5 seconds.

If it fails: the replay dashboard shows nothing for `D`: `event_time` for that day is missing in history (backfill), or `as_of` is not parseable (`to_timestamp` needs `yyyy-MM-dd HH:mm:ss`).

---

### T7.9 Definition of done and handover to stretch      owner: Safiul
Why: the spec's section 32 and the README's section 8 are the contract. Tick each line with evidence, not opinion.

Do: fill this table in `docs/definition_of_done.md`, linking evidence.

| # | Spec 32 / README 8 item | How verified | Evidence |
|---|---|---|---|
| 1 | Real Norwegian data ingested automatically | `collector.yml` runs green; files every 10-30 min | Actions history; `fs ls` of today |
| 2 | Pipelines run without manual intervention | 24 h of `orchestrate` runs, all SUCCESS | `jobs list-runs` output |
| 3 | Bronze/Silver/Gold operational | tables exist with rows; lineage chain | T7.6 lineage query |
| 4 | Streaming and batch both demonstrated | pipeline (Auto Loader, watermark) plus `reference` job | pipeline UI; job UI |
| 5 | Duplicate and late events handled | T7.4 `n = n_distinct`; late-event test from M4 | `docs/failure_recovery.md` |
| 6 | Invalid data measurable and quarantined | quarantine tables with rows; health page bars | Platform Health screenshot |
| 7 | Historical backfills work | T7.2 run and diff query | `docs/benchmarks.md`, diff output |
| 8 | Observations mapped to road segments | `XS002` warn count under 2 % of rows in `silver.data_quality_events`; `quarantine.unmapped_observations` explained | health page bar and quarantine count |
| 9 | Current risk queryable through gold | `SELECT ... FROM gold.road_segment_current_risk` | Genie or SQL editor |
| 10 | Dashboard: current conditions, road detail, historical analytics | four dashboards; historical closures query (WR-UC-17) saved in `src/sql/` | M6 done list |
| 11 | One historical winter event replayed end to end | day `D` replay dashboard (S1 if done, else history playback) | T7.8 |
| 12 | Freshness and pipeline health visible | Platform Health | screenshot |
| 13 | Unity Catalog governance and lineage configured | grants.sql applied; lineage graph | `SHOW GRANTS`; screenshot |
| 14 | Automated tests and CI/CD | `ci.yml` on PRs; `deploy-free.yml` on main | Actions history |
| 15 | Performance measured | `docs/benchmarks.md` | file |
| 16 | Documentation: architecture, assumptions, limitations, operations | ADRs, spec section 30 list in README, four runbooks | repo |
| 17 | One real-world use case end to end | WR-UC-15 gritting priority on the replay | T7.8 minute 10-12 |

Handover to stretch, what each needs from M7:

| Stretch | Needs from M7 | Where |
|---|---|---|
| S1 replay through the live pipeline | Landing keeps last winter's files; `_batch_id = replay:<event_id>` convention honoured in bronze and silver; the diff query; a pause/resume procedure for the live collector (T7.1); T7.2 full-refresh notes | `src/sql/replay_diff.sql`, `runbooks/ingestion.md` |
| S2 baselines, alerts, API | `gold.road_segment_risk_history` kept for the whole winter (no `VACUUM` under 30 days; retention noted in `runbooks/analytics.md`); `gold.road_weather_summary` history; the freshness table as the first alert source; `grants.sql` for the API's service identity | `runbooks/analytics.md`, `src/sql/grants.sql` |
| S3 ML | Labels: `gold.incident_summary` and `gold.historical_closures` keyed by `road_segment_id` with start and end times; features: `gold.road_segment_risk_history` plus `gold.road_weather_summary`; a time-based split rule (train before `D`, test on `D` and after) written in M2's label doc; the benchmark numbers for feature-build cost | `docs/benchmarks.md` |

Expect: `docs/definition_of_done.md` with all 17 rows ticked or with a written gap; the handover table copied into `10_S1_replay.md`, `11_S2_baselines_alerts_api.md`, `12_S3_ml.md` as their "Inputs" line.
If it fails: a row has no evidence link (it is not done; write the gap and the owner, do not tick it); rows 2 and 14 fail because a personal test job ran in the team workspace and hit the task quota (move it, T7.7 platform runbook).

---

## Done when

- [ ] One-hour collector pause produced `STALE`, green job runs, and a return to `FRESH`; recorded.
- [ ] Batch backfill by date range ran twice with identical counts; full refresh ran; replay diff query returns zero rows for a replayed day.
- [ ] Schema-change test recorded in `docs/schema_change_test.md`; rescued rows reach `quarantine.schema_errors`.
- [ ] Killed pipeline update re-run with `n = n_distinct`; one job repair done from UI or CLI; recorded.
- [ ] `docs/benchmarks.md` filled with dated numbers, including incremental versus full refresh and before/after `OPTIMIZE`.
- [ ] `docs/cost_report.md` states which method is verified; lineage screenshot in `docs/`.
- [ ] Five files in `runbooks/`.
- [ ] Demo dry run under 15 minutes on replayed day `D`; fallback rehearsed.
- [ ] `docs/definition_of_done.md` complete; handover rows copied into the stretch files.

## Verify

```bash
cd project
ls runbooks/            # _template.md ingestion.md transformation.md platform.md analytics.md
ls docs/ | grep -E "benchmarks|cost_report|schema_change_test|failure_recovery|definition_of_done"
q "SELECT count(*) AS n, count(DISTINCT station_id, event_time) AS n_distinct FROM frostsight.silver.road_weather_observations"
q "SELECT source, status, round(ingestion_delay_min) AS delay_min FROM frostsight.gold.data_quality_summary ORDER BY 1"
q "SELECT count(*) FROM frostsight.gold.road_segment_risk_history WHERE event_time::date = DATE 'D' AND _batch_id LIKE 'replay:%'"
q "SELECT count(*) FROM frostsight.quarantine.schema_errors"
databricks jobs list-runs --job-id "$JOB_ID" --limit 144 -o json --profile frostsight-free | jq '[.runs[].state.result_state] | group_by(.) | map({(.[0]): length}) | add'
gh run list --workflow deploy-free.yml --limit 1
```

Expected: five runbook files; five docs; `n = n_distinct`; all sources `FRESH` (elevation may be `NO_DATA`); a positive count for day `D`; the last 144 runs are all `SUCCESS` (or the exceptions are the deliberate T7.4 failure); the last deploy is green.
