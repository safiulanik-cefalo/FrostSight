# S1: Storm replay through the live pipeline

Owners: Sani (pipeline and replay mechanics, gold, test), Shawon (harness runs, runbook), Safiul (dashboard).
Read `00_README.md` first. Everything here assumes M7 is done on `free`.

Goal: one storm from last winter (an entry in `config/replay_events.yml`) is replayed through the same landing
folder, the same `ingest` pipeline, the same gold code and the dashboards, at ×N speed, without touching live
data. The dashboard gets a replay page with a time scrubber and per-hour snapshots. A pipeline test proves the
replay output equals a straight batch computation over the same input (spec section 24).

Inputs from M7 (08 T7.9 handover row): landing keeps last winter's files; `_batch_id = replay:<event_id>` is
honoured in bronze and silver; `src/sql/replay_diff.sql`; the collector pause procedure (08 T7.1); the
full-refresh notes (08 T7.2). Plus 03 T2.6 (`replay/harness.py`), 06 T5.4 (`build_gold.py --include-replay`),
07 T6.4 (`gold.v_*` views), spec 3.5 and 16 (scrubber, incidents overlaid), WR-UC-13, WR-UC-21, WR-UC-22.

## 0. The replay path in six lines

1. The harness (laptop or runner, Files API) writes last winter's readings as 10-minute files
   `raw/road_weather/<yyyy>/<mm>/<dd>/replay__<event_id>__<ts>__<run>.jsonl`, in event-time order, one every
   `600 / speed` seconds. `orchestrate` keeps triggering `ingest` every 10 minutes; Auto Loader takes them.
2. Bronze derives `_batch_id = replay:<event_id>` from the name (05 T4.2). Silver runs the same normalisation,
   rules and dedup, but in the second flow `road_weather_replay` with its own watermark (D2, built into M4):
   the live flow's watermark sits at "now".
3. Live `build_gold` ignores `_batch_id LIKE 'replay:%'` (06). The `replay` job scores the event into
   `gold.road_segment_risk_history` (with `_batch_id`), never into `gold.road_segment_current_risk`, then builds
   `gold.replay_snapshots` (segment × hour), `gold.replay_incidents`, `gold.replay_lead_time`, `gold.replay_events`.
4. The dashboard's scrubber is the `snapshot_time` parameter; AI/BI has no animation (spec 16).
5. Cleanup deletes by `_batch_id` and `event_id`; a re-replay needs new file names and a flow reset (D3).
6. The equivalence test recomputes silver from the files and risk from silver in plain batch and compares.

## 1. Decisions

**D1 Isolation: `_batch_id` on gold history, replay never writes current risk, snapshots keyed by `event_id`.**
The alternative was a separate `gold.replay_current_risk`. Chosen: (1) bronze, silver and 08's diff query already
separate replay by `_batch_id LIKE 'replay:%'`; adding the same column to `road_segment_risk_history` makes
one predicate work in every layer, and 07's two history datasets get that predicate. (2) "Current" has no
meaning for a storm from last winter; what the product needs is "risk at hour H", which is
`gold.replay_snapshots(event_id, snapshot_time, ...)`, not a second current table whose schema must track
`current_risk`. (3) `build_gold --event-id` skips the `current_risk` and `incident_summary` writes entirely, so
contamination is impossible by construction, not by filter. (4) 08 T7.8 already relies on replay rows being in
history for day D; this keeps that. (5) One fewer table for grants, views, `OPTIMIZE` and the runbook.

**D2 The watermark problem and the two-flow silver table.** The silver stream keeps one watermark per streaming
query: `max(event_time) seen - 30 min`. Live data has moved it to "now - 30 min". Every replay row from last
January is older than that, so `dropDuplicatesWithinWatermark` drops it (05 T4.8 step 5 proved this with a
2-hour-late file). 08 T7.2 used to say "silver keeps them"; it now says they are dropped (09 open question 4).
Fix, back-propagated into 05_M4 T4.4 so it exists from the first deploy: `silver.road_weather_observations` is a
`dp.create_streaming_table` target fed by two `@dp.append_flow`s, `road_weather_live` (bronze rows with `_batch_id NOT LIKE 'replay:%'`) and
`road_weather_replay` (the rest). Each flow is its own streaming query with its own checkpoint, watermark and
dedup state; both call the same normalisation function and carry the same expectations, so it is still one code
path. The replay flow's watermark follows the storm because the harness writes in event-time order.
Consequence: one event at a time per flow state; an older event, or the same event again, needs the reset in D3.
The same holds after the whole-winter backfill S2 and S3 ask for (`replay:backfill_<day>`, 03_M2 T2.6
`--from/--to`): its watermark ends in March, so a January storm replayed afterwards is dropped as late by the
replay flow. That is harmless for scoring (T-S1.1 selects by window, and the backfill rows are the same Frost
readings), but to show the storm arriving through the pipeline, run the D3 reset first.
Rejected: shifting event times to "now" (`--shift`) keeps the watermark happy but destroys the timeline the
product shows; a full refresh before every replay works without a code change but re-reads all of landing and
cannot run "through the 10-minute triggers".

**D3 File names carry a run suffix; the reset is a selective full refresh of silver.** Auto Loader records
processed file paths in its checkpoint and does not re-read a rewritten path (`cloudFiles.allowOverwrites` stays
at its default `false`). So the harness appends `__r<UTC start>` to every file name (in 03_M2 T2.6 and the README naming row since
this review); `batch_id_from_path` is unchanged (`split(stem, '__')[1]` is still the event id). Re-replaying
also needs the replay flow's dedup state and watermark cleared:
`databricks bundle run ingest --full-refresh frostsight.silver.road_weather_observations,frostsight.quarantine.invalid_road_weather -t free --profile frostsight-free`
rebuilds silver from bronze in one batch (county scale: minutes). The Auto Loader checkpoint in bronze is not
touched by that.

**D4 Free Edition: replay shares the `ingest` pipeline and the 10-minute triggers.** One active pipeline per
account (README section 2), so there is no replay pipeline. A 6-hour storm is 36 files; at ×60 the harness
writes one every 10 s and finishes in 6 minutes, inside one or two `orchestrate` slots. Timing and correctness
are in T-S1.2 step 2.

**D5 `aws`: a dedicated replay pipeline is optional and buys compute isolation only.** A Unity Catalog table is
owned by one pipeline, so a second pipeline would have to write to its own tables (for example a `replay`
schema) and the dashboards would need a second set of views. Do it only if replays collide with live at a scale
the county never reaches. Declare it under `targets.aws.resources.pipelines` like the collector job; nothing
in this file depends on it.

## 2. Tasks

| Task | What | Owner |
|---|---|---|
| T-S1.1 | Gold isolation: check `_batch_id` on history, `build_gold.py --event-id`, `config.replay_event` (in 06_M5 since the review) | Sani |
| T-S1.2 | Silver replay flow (in 05_M4 since the review), timing proof | Sani |
| T-S1.3 | Harness run suffix (in 03_M2 since the review) and the landing rules | Shawon |
| T-S1.4 | `build_replay_snapshots.py` and `resources/replay.job.yml` | Sani |
| T-S1.5 | Runbook: run a replay, clean up, replay again | Shawon |
| T-S1.6 | Equivalence test `tests/data/test_replay_equivalence.py` | Sani |
| T-S1.7 | Replay dashboard `src/dashboards/replay.lvdash.json` | Safiul |
| T-S1.8 | Lead-time metric `gold.replay_lead_time` (feeds S3 and WR-UC-21) | Safiul |

### T-S1.1 Gold isolation and `build_gold --event-id`      owner: Sani
Why: replay rows must reach history with a marker and never reach current risk; the scheduled run keeps
ignoring them (06 decision table).
Do:
  1. Nothing to write: D1 was back-propagated into the MVP (13_stretch_review.md). Check that the branch you
     build on has, from 06_M5 T5.1 and T5.4: `config.replay_event`; `_batch_id STRING` on
     `gold.road_segment_risk_history` (created by `ensure_tables`); the history MERGE key
     `HISTORY_KEY = (road_segment_id, event_time, _batch_id)`; `build_replay` and `--event-id`. In replay mode
     `build_gold` selects silver rows with `_batch_id LIKE 'replay:%'` (except `replay:latest_%`) inside the
     event's `start`/`end`, scores every one of them with trends computed inside the window, writes them to
     history with the literal marker `replay:<event_id>`, and skips `current_risk`, `incident_summary`,
     windows and closures entirely. Selecting by window rather than by the silver marker means the event is
     scored even when its readings reached silver as `replay:backfill_<day>` rows (S2 and S3 backfill the whole
     winter; the same Frost values).
  2. If your workspace's history table was created before the column existed:
     `ALTER TABLE frostsight.gold.road_segment_risk_history ADD COLUMNS (_batch_id STRING)` once, in the SQL editor.
  3. Check 07_M6 T6.4: `ds_risk_history` and `ds_latency` carry `AND coalesce(_batch_id, '') NOT LIKE 'replay:%'`
     (both read history by `risk_updated_at`, which is "today" for a replay scored today). 08 T7.8's
     `risk_map_replay` dashboard is superseded by T-S1.7.

```bash
cd project
grep -n "HISTORY_KEY\|def build_replay\|--event-id" src/jobs/build_gold.py
grep -n "def replay_event" src/frostsight/config.py
grep -c "NOT LIKE 'replay:%'" src/dashboards/road_detail.lvdash.json src/dashboards/platform_health.lvdash.json   # 1 and 1
```

Expect: the greps find each name; `DESCRIBE frostsight.gold.road_segment_risk_history` lists `_batch_id`; after
T-S1.5 step 4, `SELECT _batch_id, count(*) FROM frostsight.gold.road_segment_risk_history GROUP BY 1` shows one
`replay:<id>` group with about 30 stations × 6 readings/hour × hours, and
`SELECT max(event_time) FROM frostsight.gold.road_segment_current_risk` is still today.
If it fails: `build_replay` prints 0 rows (silver has no replay rows in the window yet: the harness did not
run, or the replay flow dropped them as late, D3:
`SELECT count(*) FROM frostsight.silver.road_weather_observations WHERE _batch_id LIKE 'replay:%' AND event_time BETWEEN '<start>' AND '<end>'`);
`UNRESOLVED_COLUMN _batch_id` (step 2 not done).

### T-S1.2 Silver replay flow and the timing proof      owner: Sani
Why: D2. Without its own flow, every replay row is behind the live watermark and is dropped.
Do:
  1. Nothing to write and no full refresh: D2 was back-propagated into M4, so the pipeline has had the two
     flows since its first deploy (05_M4 section 1 and T4.4; `transforms.normalise_road_weather` in T4.2).
     Check the deployed pipeline:

```bash
cd project
grep -n "road_weather_live\|road_weather_replay\|normalise_road_weather" src/pipelines/silver.py src/frostsight/transforms.py
q "SELECT DISTINCT origin.flow_name FROM frostsight.gold.ingest_event_log WHERE origin.flow_name RLIKE 'road_weather_(live|replay)$'"
```

     Only if a workspace still runs an older single-flow `silver.py` (built before the back-propagation):
     deploy the current code, then run once, right after an `orchestrate` run, a selective full refresh so
     the new flows do not re-read bronze into a table that already holds the rows:
     `databricks bundle run ingest --full-refresh frostsight.silver.road_weather_observations,frostsight.quarantine.invalid_road_weather -t free --profile frostsight-free`.
     verify: `bundle run <pipeline> --full-refresh <a,b>` accepts three-part names (`databricks bundle run --help`);
     fallback `databricks pipelines start-update <id> --full-refresh-selection frostsight.silver.road_weather_observations --profile frostsight-free`.
  2. Timing and correctness on Free Edition, to be written into `runbooks/transformation.md`:
     - A 6-hour storm is 36 buckets. At ×60 the harness sleeps 10 s per file: 6 minutes wall clock. At ×20:
       18 minutes. At `--speed 0`: about 40 seconds of uploads.
     - `orchestrate` triggers an update at :00, :10, :20 ... Files written in one slot are all in landing when
       the next update starts; a run that straddles a boundary is split across two updates. Each update's
       Auto Loader micro-batch takes every new file (36 is far below `cloudFiles.maxFilesPerTrigger`, 1000).
     - Why nothing is dropped as late: the replay flow's watermark is `max(event_time) - 30 min`, computed at
       the end of a micro-batch and applied to the next one. Files are atomic units of a batch and the harness
       writes buckets in ascending order, so every file of batch N+1 is newer than every file of batch N; the
       oldest row of batch N+1 is at least 10 minutes newer than `max(event_time)` of batch N minus 30 minutes.
       Within a batch the watermark is the previous one, so a whole storm arriving in one update is kept in
       full. Duplicate `(station_id, event_time)` rows within the batch collapse to the first, as live.
     - Why per-hour results are correct regardless of how files were grouped: windows (`F.window` over
       `event_time`), trends (`rangeBetween` on `event_time`) and the snapshots (`event_time <= snapshot_time`)
       are batch computations over `event_time`. Arrival grouping only decides which update wrote the row.
     - End to end at ×60: 6 min harness, up to 10 min until the next trigger, 2 to 4 min update, then the
       `replay` job 5 to 8 min: about 25 minutes from first file to dashboard.
     - Two events must not be in flight at once (one replay flow state, D2). Incidents are not replayed by the
       harness (DATEX has no history); T-S1.4 takes them from NVDB accidents and slides.

Expect: the grep finds both flow names and the normalisation function; the event-log query returns
`road_weather_live` (and `road_weather_replay` after the first harness run); after a harness run at ×600 on
`personal`, flow `road_weather_replay` shows `num_output_rows` equal to the replay file line count minus
duplicates, and `SELECT _batch_id, count(*) FROM frostsight.silver.road_weather_observations WHERE _batch_id LIKE 'replay:%' GROUP BY 1`
returns the event.
If it fails: replay rows missing (the harness did not write in bucket order, or the flow's watermark is from a
later event or a whole-winter backfill: D3 reset); only one flow name in the event log (the workspace runs an
old `silver.py`: step 1, last paragraph); expectation counts missing for `road_weather_replay` (05_M4 T4.4 step
5 verify, move the expectations onto the flows).

### T-S1.3 Harness run suffix and the landing rules      owner: Shawon
Why: D3. Auto Loader never re-reads a path it has seen; every run needs unique names.
Do:
  1. Nothing to write: the run suffix is in 03_M2 T2.6 (`landing_path(bucket, event_id, run)`, `--run`, default
     `r<UTC start>`), the README naming row and 05_M4 T4.9 `test_batch_id` (third path
     `.../replay__storm_2026_01_15__20260115T081000Z__r20261120T091500Z.jsonl` -> `replay:storm_2026_01_15`).
     Check: `grep -n "__{run}" replay/harness.py` and `uv run pytest -q tests/unit/test_transforms.py::test_batch_id`.
  2. Rules for `replay/README.md` (replace 03 T2.6 step 4): never two events in flight; run at ×60 or slower on
     `free` so the 10-minute triggers see event-time order file by file; never `--speed 0` while `orchestrate`
     is mid-update on the same day folder (it is fine otherwise: one update takes all files); `--latest --shift`
     tests stay on `personal`.
  3. Dry run, then real run on `personal` with the event chosen at M1:

```bash
cd project
uv run python -m replay.harness --event storm_2026_01_15 --speed 60 --target free --dry-run
uv run python -m replay.harness --event storm_2026_01_15 --speed 600 --target personal
databricks fs ls dbfs:/Volumes/frostsight/landing/raw/road_weather/2026/01/15/ --profile frostsight-personal
```

Expect: `would write .../replay__storm_2026_01_15__20260115T000000Z__r20261120T091500Z.jsonl (30 rows)` lines in
bucket order; the real run lists files with the same suffix.
If it fails: `KeyError: event_time` (M1 history schema); `0 rows` (the event's months are not in
`frost_history/<yyyy>/<mm>/01/`); upload 403 (`WRITE VOLUME` grant).

### T-S1.4 Snapshots script and the `replay` job      owner: Sani
Why: the dashboard needs per-hour rows, incidents on segments, lead time and a catalogue; the job chains the
steps serially.
Do:
  1. Create `src/jobs/build_replay_snapshots.py`:

```python
"""build_replay_snapshots: hourly snapshots, incidents on segments, lead time and the catalogue for one replayed
event. Reads gold.road_segment_risk_history rows with _batch_id = 'replay:<event_id>'. Idempotent per event_id
(delete + insert). Runs as task 3 of the replay job."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F

from frostsight.config import replay_event

spark = SparkSession.builder.getOrCreate()

DDL = {
    "replay_events": """
        event_id STRING, label STRING, start_time TIMESTAMP, end_time TIMESTAMP, speed DOUBLE, status STRING,
        run_id STRING, files_landed INT, first_file_at TIMESTAMP, last_file_at TIMESTAMP, rows_bronze BIGINT,
        rows_silver BIGINT, rows_history BIGINT, snapshots INT, incidents INT, scored_at TIMESTAMP,
        snapshot_at TIMESTAMP, note STRING""",
    "replay_snapshots": """
        event_id STRING, snapshot_time TIMESTAMP, road_segment_id STRING, risk_level STRING, risk_score DOUBLE,
        active_incidents INT""",
    "replay_incidents": """
        event_id STRING, incident_id STRING, source STRING, incident_type STRING, severity STRING,
        event_time TIMESTAMP, end_time TIMESTAMP, road_segment_id STRING, latitude DOUBLE, longitude DOUBLE""",
    "replay_lead_time": """
        event_id STRING, incident_id STRING, source STRING, road_segment_id STRING, incident_time TIMESTAMP,
        first_high_time TIMESTAMP, lead_minutes DOUBLE, level_at_incident STRING""",
}
CLUSTER = {"replay_events": "event_id", "replay_snapshots": "event_id, snapshot_time",
           "replay_incidents": "event_id", "replay_lead_time": "event_id"}
ST_DISTANCE = "ST_Distance(ST_Transform(ST_Point(longitude, latitude, 4326), 25833), ST_GeomFromWKT(geometry_wkt_25833, 25833))"
POINT_RE = r"POINT \(([-\d.]+) ([-\d.]+)\)"
NO_END_HOURS = 6      # accidents and slides have no end time: count them as active for six hours


def ensure_tables(catalog: str) -> None:
    for name, ddl in DDL.items():
        spark.sql(f"CREATE TABLE IF NOT EXISTS {catalog}.gold.{name} ({ddl}) CLUSTER BY ({CLUSTER[name]})")


def replace_event_rows(df: DataFrame, catalog: str, table: str, event_id: str) -> int:
    cols = [c.strip().split()[0] for c in DDL[table].replace("\n", " ").split(",")]
    spark.sql(f"DELETE FROM {catalog}.gold.{table} WHERE event_id = '{event_id}'")
    out = df.select(*cols)
    out.write.format("delta").mode("append").saveAsTable(f"{catalog}.gold.{table}")
    return out.count()


def ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)


def hours(start: datetime, end: datetime) -> list[datetime]:
    h = start.replace(minute=0, second=0, microsecond=0)
    if h < start:
        h += timedelta(hours=1)
    out = []
    while h <= end:
        out.append(h)
        h += timedelta(hours=1)
    return out


def map_to_segments(pts: DataFrame, catalog: str) -> DataFrame:
    """Nearest segment within 500 m: H3 res-9 candidates, then ST_Distance (05 T4.4 method) or the shapely UDF."""
    seg = spark.read.table(f"{catalog}.silver.road_segments").select(
        "road_segment_id", "geometry_wkt_25833", F.explode("h3_cells").alias("h3_cell"))
    cand = pts.withColumn("h3_cell", F.expr("h3_longlatash3(longitude, latitude, 9)")).join(seg, "h3_cell")
    try:
        spark.sql("SELECT ST_Distance(ST_Point(0,0,25833), ST_Point(3,4,25833))").collect()
        cand = cand.withColumn("distance_m", F.expr(ST_DISTANCE))
    except Exception:                                    # verify: ST_ functions on the serverless job runtime
        from frostsight.geo import udf_point_to_line_m
        cand = cand.withColumn("distance_m", udf_point_to_line_m("longitude", "latitude", "geometry_wkt_25833"))
    best = cand.groupBy("incident_id").agg(F.min_by(F.struct("road_segment_id", "distance_m"), "distance_m").alias("m"))
    return (pts.join(best, "incident_id", "left")
            .withColumn("road_segment_id", F.when(F.col("m.distance_m") <= 500, F.col("m.road_segment_id")))
            .drop("m"))


def build_incidents(catalog: str, event_id: str, start: datetime, end: datetime) -> int:
    """DATEX incidents (already on segments) plus NVDB accidents and slides (mapped here) inside the window."""
    lo, hi = F.lit(start), F.lit(end)
    datex = (spark.read.table(f"{catalog}.silver.road_incidents")
             .where(F.col("start_time").between(lo, hi))
             .select("incident_id", F.lit("datex").alias("source"), "incident_type", "severity",
                     F.col("start_time").alias("event_time"), "end_time", "road_segment_id", "latitude", "longitude"))
    acc = (spark.read.table(f"{catalog}.silver.accidents").where(F.col("event_time").between(lo, hi))
           .select(F.concat(F.lit("acc-"), F.col("accident_id")).alias("incident_id"), F.lit("nvdb_accident").alias("source"),
                   F.lit("accident").alias("incident_type"), F.col("severity"), "event_time",
                   F.lit(None).cast("timestamp").alias("end_time"),
                   F.regexp_extract("wkt_4326", POINT_RE, 2).cast("double").alias("latitude"),
                   F.regexp_extract("wkt_4326", POINT_RE, 1).cast("double").alias("longitude")))
    ava = (spark.read.table(f"{catalog}.silver.avalanche_landslide_events").where(F.col("event_time").between(lo, hi))
           .select(F.concat(F.lit("ava-"), F.col("event_id")).alias("incident_id"), F.lit("nvdb_avalanche").alias("source"),
                   F.lower("event_type").alias("incident_type"), F.col("road_closure").alias("severity"), "event_time",
                   F.lit(None).cast("timestamp").alias("end_time"),
                   F.regexp_extract("wkt_4326", POINT_RE, 2).cast("double").alias("latitude"),
                   F.regexp_extract("wkt_4326", POINT_RE, 1).cast("double").alias("longitude")))
    nvdb = map_to_segments(acc.unionByName(ava).where("latitude IS NOT NULL"), catalog)
    allinc = (datex.unionByName(nvdb)
              .withColumn("end_time", F.coalesce("end_time", F.col("event_time") + F.expr(f"INTERVAL {NO_END_HOURS} HOURS")))
              .withColumn("event_id", F.lit(event_id)))
    return replace_event_rows(allinc, catalog, "replay_incidents", event_id)


def build_snapshots(catalog: str, event_id: str, start: datetime, end: datetime) -> int:
    """Per hour H and segment: the newest history row with event_time in (H - 60 min, H]; incidents active at H."""
    hist = (spark.read.table(f"{catalog}.gold.road_segment_risk_history")
            .where(F.col("_batch_id") == F.lit(f"replay:{event_id}"))
            .select("road_segment_id", "event_time", "risk_level", "risk_score"))
    hrs = spark.createDataFrame([(h,) for h in hours(start, end)], "snapshot_time timestamp")
    joined = hrs.join(hist, (hist.event_time <= hrs.snapshot_time)
                      & (hist.event_time > hrs.snapshot_time - F.expr("INTERVAL 60 MINUTES")))
    latest = (joined.groupBy("snapshot_time", "road_segment_id")
              .agg(F.max_by(F.struct("risk_level", "risk_score"), "event_time").alias("r")))
    inc = spark.read.table(f"{catalog}.gold.replay_incidents").where(F.col("event_id") == event_id)
    active = (hrs.join(inc, (inc.event_time <= hrs.snapshot_time) & (inc.end_time > hrs.snapshot_time))
              .where("road_segment_id IS NOT NULL")
              .groupBy("snapshot_time", "road_segment_id").agg(F.count("*").cast("int").alias("active_incidents")))
    snap = (latest.join(active, ["snapshot_time", "road_segment_id"], "left")
            .select(F.lit(event_id).alias("event_id"), "snapshot_time", "road_segment_id",
                    F.col("r.risk_level").alias("risk_level"), F.col("r.risk_score").alias("risk_score"),
                    F.coalesce("active_incidents", F.lit(0)).alias("active_incidents")))
    return replace_event_rows(snap, catalog, "replay_snapshots", event_id)


def build_lead_time(catalog: str, event_id: str) -> int:
    """T-S1.8: first HIGH-or-above snapshot hour at or before each incident; positive lead = the map warned first."""
    df = spark.sql(f"""
        WITH high AS (
          SELECT road_segment_id, snapshot_time FROM {catalog}.gold.replay_snapshots
          WHERE event_id = '{event_id}' AND risk_level IN ('HIGH', 'VERY_HIGH')),
        at_incident AS (
          SELECT i.incident_id, s.risk_level
          FROM {catalog}.gold.replay_incidents i
          JOIN {catalog}.gold.replay_snapshots s
            ON s.event_id = i.event_id AND s.road_segment_id = i.road_segment_id
           AND s.snapshot_time = date_trunc('hour', i.event_time)
          WHERE i.event_id = '{event_id}')
        SELECT i.event_id, i.incident_id, i.source, i.road_segment_id, i.event_time AS incident_time,
               min(h.snapshot_time) AS first_high_time,
               round(timestampdiff(SECOND, min(h.snapshot_time), i.event_time) / 60.0, 1) AS lead_minutes,
               max(a.risk_level) AS level_at_incident
        FROM {catalog}.gold.replay_incidents i
        LEFT JOIN high h ON h.road_segment_id = i.road_segment_id AND h.snapshot_time <= i.event_time
        LEFT JOIN at_incident a ON a.incident_id = i.incident_id
        WHERE i.event_id = '{event_id}' AND i.road_segment_id IS NOT NULL
        GROUP BY i.event_id, i.incident_id, i.source, i.road_segment_id, i.event_time""")
    return replace_event_rows(df, catalog, "replay_lead_time", event_id)


def landed_files(landing: str, event_id: str, start: datetime, end: datetime) -> DataFrame:
    """The replay files of this event in the volume: name, size, modification_time (LIST on a volume path)."""
    days, d = [], start.date()
    while d <= end.date():
        days.append(d)
        d += timedelta(days=1)
    out = None
    for day in days:
        try:
            part = spark.sql(f"LIST '{landing}/road_weather/{day:%Y/%m/%d}/'")   # verify: columns path, name, size, modification_time
        except Exception:
            continue
        out = part if out is None else out.unionByName(part)
    if out is None:
        return spark.createDataFrame([], "path string, name string, size long, modification_time timestamp")
    return out.where(F.col("name").startswith(f"replay__{event_id}__"))


def build_catalogue(catalog: str, landing: str, ev: dict, speed: float, counts: dict) -> None:
    start, end, event_id = ts(ev["start"]), ts(ev["end"]), ev["id"]
    files = landed_files(landing, event_id, start, end)
    f = files.agg(F.count("*").alias("n"), F.min("modification_time").alias("first"),
                  F.max("modification_time").alias("last"), F.max("name").alias("newest")).first()
    run_id = f["newest"].rsplit("__", 1)[-1].removesuffix(".jsonl") if f["newest"] else None
    batch = f"replay:{event_id}"
    n_bronze = spark.table(f"{catalog}.bronze.road_weather_events").where(F.col("_batch_id") == batch).count()
    n_silver = (spark.table(f"{catalog}.silver.road_weather_observations")          # by window, as build_replay selects
                .where(F.col("_batch_id").startswith("replay:") & ~F.col("_batch_id").startswith("replay:latest_"))
                .where(F.col("event_time").between(F.lit(start), F.lit(end))).count())
    n_hist = spark.table(f"{catalog}.gold.road_segment_risk_history").where(F.col("_batch_id") == batch).count()
    status = ("SNAPSHOTTED" if counts["snapshots"] else "SCORED" if n_hist else "LANDED" if n_bronze
              else "FILES_ONLY" if f["n"] else "NO_FILES")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    row = spark.createDataFrame([(event_id, ev.get("label"), start, end, float(speed), status, run_id, int(f["n"]),
                                  f["first"], f["last"], n_bronze, n_silver, n_hist, counts["snapshots"],
                                  counts["incidents"], now if n_hist else None, now if counts["snapshots"] else None,
                                  ev.get("why"))], DDL["replay_events"])
    row.createOrReplaceTempView("replay_event_row")
    spark.sql(f"""MERGE INTO {catalog}.gold.replay_events t USING replay_event_row s ON t.event_id = s.event_id
                  WHEN MATCHED THEN UPDATE SET * WHEN NOT MATCHED THEN INSERT *""")
    print(f"catalogue {event_id}: {status}, files={f['n']} bronze={n_bronze} silver={n_silver} history={n_hist} "
          f"snapshots={counts['snapshots']} incidents={counts['incidents']} run={run_id}")
    if status in ("NO_FILES", "FILES_ONLY", "LANDED"):
        raise SystemExit(f"replay {event_id} is {status}: nothing to snapshot (harness not run, pipeline not updated, or build_gold skipped)")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--catalog", required=True)
    p.add_argument("--landing", required=True)
    p.add_argument("--config-dir", default=None)
    p.add_argument("--event-id", required=True)
    p.add_argument("--speed", type=float, default=60.0)      # recorded in the catalogue only
    a = p.parse_args()
    ev = replay_event(a.event_id, a.config_dir)
    start, end = ts(ev["start"]), ts(ev["end"])
    ensure_tables(a.catalog)
    counts = {"incidents": build_incidents(a.catalog, a.event_id, start, end)}
    counts["snapshots"] = build_snapshots(a.catalog, a.event_id, start, end)
    counts["lead"] = build_lead_time(a.catalog, a.event_id)
    build_catalogue(a.catalog, a.landing, ev, a.speed, counts)


if __name__ == "__main__":
    main()
```

  2. Create `resources/replay.job.yml`. Serverless, four serial tasks, no schedule (nothing to pause
     per target). Running tasks count against the five-task limit, not defined ones: this chain runs one task
     at a time, `orchestrate` one at a time, so two of five even when both run.

```yaml
resources:
  jobs:
    replay:
      name: frostsight-replay
      description: "Storm replay: sweep pipeline update -> score replayed rows into history -> hourly snapshots, incidents, lead time, catalogue -> equivalence test. Started by hand after the harness."
      max_concurrent_runs: 1
      timeout_seconds: 3600
      email_notifications:
        on_failure: [ "${var.notification_email}" ]
      parameters:
        - { name: catalog, default: "${var.catalog}" }
        - { name: event_id, default: "" }                  # required at run time; the tasks fail fast on ""
        - { name: speed, default: "60" }                   # what the harness was run with; recorded in gold.replay_events
      environments:
        - environment_key: replay
          spec:
            client: "4"
            dependencies:
              - ../dist/*.whl                              # frostsight wheel (pyyaml, risk, windows, geo)
              - pyproj>=3.6                                # geo UDF fallback in map_to_segments
              - shapely>=2
              - h3>=4
              - pandas>=2
      tasks:
        - task_key: pipeline_sweep                         # one more update so the last harness files are in silver
          pipeline_task:
            pipeline_id: ${resources.pipelines.ingest.id}
            full_refresh: false
        - task_key: build_gold_replay
          depends_on: [ { task_key: pipeline_sweep } ]
          environment_key: replay
          timeout_seconds: 900
          spark_python_task:
            python_file: ../src/jobs/build_gold.py
            parameters: [ "--catalog", "{{job.parameters.catalog}}", "--config-dir", "${var.config_dir}",
                          "--include-replay", "--event-id", "{{job.parameters.event_id}}" ]
        - task_key: build_replay_snapshots
          depends_on: [ { task_key: build_gold_replay } ]
          environment_key: replay
          timeout_seconds: 900
          spark_python_task:
            python_file: ../src/jobs/build_replay_snapshots.py
            parameters: [ "--catalog", "{{job.parameters.catalog}}", "--landing", "${var.landing_root}",
                          "--config-dir", "${var.config_dir}", "--event-id", "{{job.parameters.event_id}}",
                          "--speed", "{{job.parameters.speed}}" ]
        - task_key: test_equivalence                       # T-S1.6; the run is red if replay != batch
          depends_on: [ { task_key: build_replay_snapshots } ]
          environment_key: replay
          timeout_seconds: 900
          spark_python_task:
            python_file: ../tests/data/test_replay_equivalence.py
            parameters: [ "--catalog", "{{job.parameters.catalog}}", "--landing", "${var.landing_root}",
                          "--config-dir", "${var.config_dir}", "--event-id", "{{job.parameters.event_id}}" ]
      permissions:
        - level: CAN_MANAGE_RUN
          group_name: users
```

     The sweep task starts a pipeline update while `orchestrate` may be running one. verify: what a
     `pipeline_task` does when an update of the same pipeline is in progress (waits, or fails with
     "update already in progress"; `databricks jobs get-run --run-id <id>` shows the task state). If it fails,
     start the job right after an `orchestrate` run finishes (the runbook says so), or give the task
     `max_retries: 2` with `min_retry_interval_millis: 120000`.
  3. Deploy and validate: `databricks bundle validate -t free --strict --profile frostsight-free`,
     `databricks bundle deploy -t personal --profile frostsight-personal`, then run it after a harness run
     (T-S1.5 step 4).

Expect: `bundle summary -t personal` lists `[dev <you>] frostsight-replay`; a run shows four green boxes;
`SELECT status, files_landed, rows_silver, rows_history, snapshots, incidents FROM frostsight.gold.replay_events`
shows `SNAPSHOTTED` with `snapshots` = hours × mapped segments (about 30 × hours) and
`SELECT snapshot_time, count(*) FROM frostsight.gold.replay_snapshots WHERE event_id = '<id>' GROUP BY 1 ORDER BY 1`
one row per hour.
If it fails: `unknown replay event` (id typo; `--params` not passed); `TABLE_OR_VIEW_NOT_FOUND silver.accidents`
(the `reference` job never ran on this target; `build_incidents` needs both NVDB tables); `LIST` rejected
(replace `landed_files` with `dbutils.fs.ls` through `WorkspaceClient().dbutils`, or drop timings); the task
ends `NO_FILES` (wrong event id in the harness, or files landed under another target's volume).

### T-S1.5 Runbook: run a replay, clean up, replay again      owner: Shawon
Why: a replay is a five-step procedure with one destructive step; write it once, in `runbooks/replay.md`.
Do:
  1. Pick the event: `uv run python -c "import yaml; [print(e['id'], e['label']) for e in yaml.safe_load(open('config/replay_events.yml'))['events']]"`.
     Check that it is not in flight or already scored: `SELECT event_id, status FROM frostsight.gold.replay_events`.
     If it is scored and you want it again, do step 6 first.
  2. Start the harness from the repo root (laptop or runner; it uses the Files API):

```bash
uv run python -m replay.harness --event storm_2026_01_15 --speed 60 --target free
```

  3. Watch the pipeline take the files (the `orchestrate` trigger, every 10 minutes):

```bash
PIPELINE_ID=$(databricks bundle summary -t free --output json --profile frostsight-free | jq -r '.resources.pipelines.ingest.id')
databricks pipelines list-updates $PIPELINE_ID --profile frostsight-free | jq '.updates[0:2][] | {state, creation_time}'
q "SELECT origin.flow_name, sum(details:flow_progress.metrics.num_output_rows::int) AS rows_out FROM frostsight.gold.ingest_event_log WHERE event_type = 'flow_progress' AND timestamp >= timestampadd(MINUTE, -30, current_timestamp()) GROUP BY 1"
q "SELECT count(*) FROM frostsight.silver.road_weather_observations WHERE _batch_id = 'replay:storm_2026_01_15'"
```

     (`q` is the M6 helper: `databricks experimental aitools tools query --warehouse $WH --profile frostsight-free`.)
  4. When the harness has printed its last file and the next update has completed, run the job (08 T7.2
     syntax; fallback `jobs run-now --json` with `job_parameters`):

```bash
databricks bundle run replay -t free --profile frostsight-free --params event_id=storm_2026_01_15,speed=60
```

  5. Open the dashboard: `databricks bundle open replay -t free --profile frostsight-free`, pick the event,
     step `snapshot_time`.
  6. Cleanup and re-replay. Minimum cleanup (gold only; bronze and silver keep the rows, isolated by
     `_batch_id`):

```sql
DELETE FROM frostsight.gold.road_segment_risk_history WHERE _batch_id LIKE 'replay:storm_2026_01_15%';
DELETE FROM frostsight.gold.replay_snapshots  WHERE event_id = 'storm_2026_01_15';
DELETE FROM frostsight.gold.replay_incidents  WHERE event_id = 'storm_2026_01_15';
DELETE FROM frostsight.gold.replay_lead_time  WHERE event_id = 'storm_2026_01_15';
DELETE FROM frostsight.gold.replay_events     WHERE event_id = 'storm_2026_01_15';
```

     Full cleanup adds the pipeline tables and the files:

```sql
DELETE FROM frostsight.silver.road_weather_observations WHERE _batch_id LIKE 'replay:storm_2026_01_15%';
DELETE FROM frostsight.bronze.road_weather_events       WHERE _batch_id LIKE 'replay:storm_2026_01_15%';
DELETE FROM frostsight.quarantine.invalid_road_weather  WHERE original_row:_batch_id LIKE 'replay:storm_2026_01_15%';
```

```bash
for f in $(databricks fs ls dbfs:/Volumes/frostsight/landing/raw/road_weather/2026/01/15/ --profile frostsight-free | grep 'replay__storm_2026_01_15__'); do
  databricks fs rm dbfs:/Volumes/frostsight/landing/raw/road_weather/2026/01/15/$f --profile frostsight-free
done
```

     verify: `DELETE` on a pipeline-owned streaming table from the SQL editor is accepted on this runtime
     (Unity Catalog streaming tables allow DML; the downstream flows need `skipChangeCommits`, T-S1.2). If it
     is rejected, stay with the minimum cleanup; it is enough for the dashboard and the tests.
     Then, whichever cleanup you chose, reset the replay flow's state (D3) and replay again; the harness
     stamps a new run suffix, so Auto Loader reads the new files:

```bash
databricks bundle run ingest --full-refresh frostsight.silver.road_weather_observations,frostsight.quarantine.invalid_road_weather -t free --profile frostsight-free
uv run python -m replay.harness --event storm_2026_01_15 --speed 60 --target free
```

     Why both: without new names Auto Loader skips the files (checkpoint); without the reset the replay flow
     drops every row as late (its watermark is at the end of the last storm) or as a duplicate (its dedup
     state still holds the keys). The full refresh rebuilds silver from bronze in one batch; live rows come back
     unchanged, and if bronze still holds the old replay rows they come back too, which is the same data.
  7. Order of events with `orchestrate` unpaused (the normal case): nothing needs pausing. The harness, the
     triggers and the `replay` job never write the same table at the same time except history, where both
     writers are insert-only MERGEs on different keys. Pause `orchestrate` (`databricks jobs update` on the
     schedule, or the UI toggle) only for a `--speed 0` backfill of a whole month.

Expect: step 3 shows `road_weather_replay` rows growing per update and zero on `road_weather_live` changes;
step 4 ends green in under 10 minutes; step 6 followed by a second replay yields the same `rows_history` in
`gold.replay_events` as the first.
If it fails: `--params` unknown (use `databricks jobs run-now --json '{"job_id": <id>, "job_parameters": {"event_id": "storm_2026_01_15", "speed": "60"}}'`);
the second replay lands zero silver rows (the full refresh was skipped, or the harness reused `--run`);
`DELETE` rejected on bronze (see verify above).

### T-S1.6 Equivalence test      owner: Sani
Why: spec section 24, "replay produces the same results as the original live run". Two checks: the stream
produced what a batch over the same files would (A), and the snapshots equal a batch risk computation from
silver with the same functions (B). Tolerance 1e-6 on scores, exact on levels.
Do:
  1. Create `tests/data/test_replay_equivalence.py`:

```python
"""Replay equivalence (spec section 24). A: silver replay rows == batch over the replay files with the same
transforms and a batch dedup. B: gold.replay_snapshots == batch risk from silver with the same windows/risk
functions. Runs as task 4 of the replay job, or in a notebook: %run-free, `python test_replay_equivalence.py
--catalog frostsight --landing /Volumes/frostsight/landing/raw --event-id <id>` (serverless, wheel installed)."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F

from frostsight import transforms as T
from frostsight.config import replay_event, risk_config, rules_by_action
from frostsight.risk import with_risk
from frostsight.windows import with_trends

NUMERIC = ["air_temperature_c", "road_surface_temperature_c", "dew_point_c", "humidity_pct",
           "precipitation_intensity_mm_h", "wind_speed_ms", "wind_direction_deg"]


def ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)


def batch_silver(spark, landing: str, event_id: str, config_dir: str | None) -> DataFrame:
    """The replay files read in one batch, normalised with the pipeline's function, deduplicated, hard rules applied."""
    raw = (spark.read.format("json").option("recursiveFileLookup", "true")
           .option("pathGlobFilter", f"replay__{event_id}__*.jsonl").load(f"{landing}/road_weather/")
           .select("*", *T.metadata_columns("road_weather")))
    n = T.normalise_road_weather(raw).dropDuplicates(["station_id", "event_time"])
    for expr in rules_by_action("silver.road_weather_observations", "drop", config_dir).values():
        if "station_known" in expr or "road_segment_id" in expr:      # XS001/XS002 need the joins; skipped here
            continue
        n = n.where(F.coalesce(F.expr(expr), F.lit(False)))
    return n


def replay_rows_in_window(spark, catalog: str, start: datetime, end: datetime, end_inclusive: bool) -> DataFrame:
    """Silver replay rows of the window, whichever replay run brought them (the event itself or a backfill,
    06_M5 build_replay). The harness reads [start, end); build_replay and the snapshots use [start, end]."""
    t = F.col("event_time")
    upper = (t <= F.lit(end)) if end_inclusive else (t < F.lit(end))
    return (spark.read.table(f"{catalog}.silver.road_weather_observations")
            .where(F.col("_batch_id").startswith("replay:") & ~F.col("_batch_id").startswith("replay:latest_"))
            .where((t >= F.lit(start)) & upper))


def check_a(spark, catalog: str, landing: str, event_id: str, config_dir: str | None) -> list[str]:
    ev = replay_event(event_id, config_dir)
    silver = replay_rows_in_window(spark, catalog, ts(ev["start"]), ts(ev["end"]), end_inclusive=False)
    batch = batch_silver(spark, landing, event_id, config_dir)
    stations = {r[0] for r in spark.read.table(f"{catalog}.silver.road_weather_stations").select("station_id").collect()}
    batch = batch.where(F.col("station_id").isin(list(stations)))          # XS001 by hand
    key = ["station_id", "event_time"]
    fails = []
    only_batch = batch.join(silver, key, "left_anti").count()
    only_silver = silver.join(batch, key, "left_anti").count()
    if only_batch or only_silver:
        fails.append(f"A keys: {only_batch} rows only in batch, {only_silver} only in silver")
    j = batch.alias("b").join(silver.alias("s"), key)
    for c in NUMERIC:
        bad = j.where(F.abs(F.col(f"b.{c}") - F.col(f"s.{c}")) > 1e-9).count()
        if bad:
            fails.append(f"A values: {c} differs on {bad} rows")
    bad = j.where(F.col("b.precipitation_type") != F.col("s.precipitation_type")).count()
    if bad:
        fails.append(f"A values: precipitation_type differs on {bad} rows")
    return fails


def check_b(spark, catalog: str, event_id: str, config_dir: str | None) -> list[str]:
    cfg, ev = risk_config(config_dir), replay_event(event_id, config_dir)
    start, end = ts(ev["start"]), ts(ev["end"])
    obs = replay_rows_in_window(spark, catalog, start, end, end_inclusive=True)      # same rows as build_replay
    lookup = (spark.read.table(f"{catalog}.silver.station_segment_lookup")
              .select("station_id", "road_segment_id").dropDuplicates(["road_segment_id"]))
    scored = with_risk(with_trends(obs), cfg).join(lookup, "station_id", "inner")
    h = start.replace(minute=0, second=0, microsecond=0)
    h += timedelta(hours=1) if h < start else timedelta(0)
    hrs = spark.createDataFrame([(h + timedelta(hours=i),) for i in range(int((end - h).total_seconds() // 3600) + 1)],
                                "snapshot_time timestamp")
    joined = hrs.join(scored, (scored.event_time <= hrs.snapshot_time)
                      & (scored.event_time > hrs.snapshot_time - F.expr("INTERVAL 60 MINUTES")))
    expected = (joined.groupBy("snapshot_time", "road_segment_id")
                .agg(F.max_by(F.struct("risk_level", "risk_score"), "event_time").alias("r"))
                .select("snapshot_time", "road_segment_id", F.col("r.risk_level").alias("e_level"), F.col("r.risk_score").alias("e_score")))
    got = (spark.read.table(f"{catalog}.gold.replay_snapshots").where(F.col("event_id") == event_id)
           .select("snapshot_time", "road_segment_id", "risk_level", "risk_score"))
    key = ["snapshot_time", "road_segment_id"]
    fails = []
    only_e, only_g = expected.join(got, key, "left_anti").count(), got.join(expected, key, "left_anti").count()
    if only_e or only_g:
        fails.append(f"B keys: {only_e} expected rows missing, {only_g} unexpected rows")
    j = expected.join(got, key)
    bad_score = j.where(F.abs(F.col("e_score") - F.col("risk_score")) > 1e-6).count()
    bad_level = j.where(F.col("e_level") != F.col("risk_level")).count()
    if bad_score or bad_level:
        fails.append(f"B values: score off on {bad_score} rows, level off on {bad_level} rows")
    if got.count() == 0:
        fails.append("B: gold.replay_snapshots has no rows for the event")
    return fails


def run_checks(spark, catalog: str, landing: str, event_id: str, config_dir: str | None) -> list[str]:
    return check_a(spark, catalog, landing, event_id, config_dir) + check_b(spark, catalog, event_id, config_dir)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--catalog", required=True)
    p.add_argument("--landing", required=True)
    p.add_argument("--config-dir", default=None)
    p.add_argument("--event-id", required=True)
    a = p.parse_args()
    fails = run_checks(SparkSession.builder.getOrCreate(), a.catalog, a.landing, a.event_id, a.config_dir)
    for f in fails:
        print("FAIL", f)
    if fails:
        raise SystemExit(f"replay equivalence failed for {a.event_id}: {len(fails)} check(s)")
    print(f"replay equivalence OK for {a.event_id}: silver == batch(files), snapshots == batch(risk)")


if __name__ == "__main__":
    main()
```

  2. It runs as task 4 of the `replay` job (T-S1.4). From a notebook on serverless: `%pip install` the wheel
     from the bundle's `artifacts/.internal/` folder, set `sys.argv` to the four arguments and `exec` the file
     from `.bundle/frostsight/<target>/files/tests/data/`. It needs workspace tables, so keep `tests/data/`
     out of CI's `pytest -q` (`testpaths = ["tests/unit"]` in `pyproject.toml`; check M4 set it).
  3. What a failure means: A key mismatch = the stream dropped rows (watermark, D2 reset) or the batch read
     saw files from another run (clean up, step 6 of T-S1.5); A value mismatch = a unit transform differs
     between pipeline and package (impossible while both use `transforms.normalise_road_weather` from 05_M4 T4.2, unless the wheel is stale: redeploy);
     B mismatch = `build_replay` filtered differently from the test (window bounds), or the snapshot lookback
     changed in one place only.

Expect: the task prints `replay equivalence OK for storm_2026_01_15: ...`; the job run is green.
If it fails: `ImportError: normalise_road_weather` (a wheel built from a branch older than the 05_M4 T4.2
function; `databricks bundle deploy` rebuilds it); `pathGlobFilter` matched nothing (files deleted by cleanup
after scoring; A is then meaningless, run B only by commenting A out for that check).

### T-S1.7 Replay dashboard      owner: Safiul
Why: WR-UC-13 and spec 16: pick an event, step through time, incidents overlaid. AI/BI has no animation; the
`snapshot_time` parameter is the scrubber, a single-select listing the snapshot hours.
Do:
  1. Datasets (bare names; `dataset_catalog: frostsight`, `dataset_schema: gold`; test each with `q` using full
     names and literals in place of the parameters):

`ds_events` (fills the event picker and the header table):

```sql
SELECT event_id, label, status, start_time, end_time, speed, files_landed, rows_silver, snapshots, incidents
FROM replay_events ORDER BY start_time DESC
```

`ds_hours` (the scrubber's value list; parameter `event_id`):

```sql
SELECT DISTINCT date_format(snapshot_time, 'yyyy-MM-dd HH:mm') AS snapshot_hour
FROM replay_snapshots WHERE event_id = :event_id ORDER BY 1
```

`ds_snapshot_kpi` (parameters `event_id`, `snapshot_time`; one row):

```sql
SELECT count(*) AS segments_total,
       sum(CASE WHEN risk_level IN ('HIGH', 'VERY_HIGH') THEN 1 ELSE 0 END) AS segments_high,
       sum(active_incidents) AS active_incidents, round(max(risk_score), 2) AS max_score
FROM replay_snapshots
WHERE event_id = :event_id AND snapshot_time = to_timestamp(:snapshot_time, 'yyyy-MM-dd HH:mm')
```

`ds_snapshot_map` (map at the snapshot):

```sql
SELECT p.road_segment_id, s.road_number, s.centroid_lat AS lat, s.centroid_lon AS lon,
       p.risk_level, p.risk_score, p.active_incidents
FROM replay_snapshots p JOIN v_segments s USING (road_segment_id)
WHERE p.event_id = :event_id AND p.snapshot_time = to_timestamp(:snapshot_time, 'yyyy-MM-dd HH:mm')
```

`ds_incidents_to_snapshot` (table of incidents reported up to the snapshot):

```sql
SELECT i.event_time, i.source, i.incident_type, i.severity, i.road_segment_id, s.road_number
FROM replay_incidents i LEFT JOIN v_segments s USING (road_segment_id)
WHERE i.event_id = :event_id AND i.event_time <= to_timestamp(:snapshot_time, 'yyyy-MM-dd HH:mm')
ORDER BY i.event_time DESC
```

`ds_high_per_hour` (line chart over the whole event; parameter `event_id` only):

```sql
SELECT snapshot_time,
       sum(CASE WHEN risk_level IN ('HIGH', 'VERY_HIGH') THEN 1 ELSE 0 END) AS segments_high,
       sum(active_incidents) AS active_incidents
FROM replay_snapshots WHERE event_id = :event_id
GROUP BY snapshot_time ORDER BY snapshot_time
```

`ds_lead_time` and `ds_lead_kpi` (T-S1.8; parameter `event_id`):

```sql
SELECT incident_time, source, road_segment_id, first_high_time, lead_minutes, level_at_incident
FROM replay_lead_time WHERE event_id = :event_id ORDER BY incident_time
```

```sql
SELECT count(*) AS incidents_on_segments,
       sum(CASE WHEN lead_minutes > 0 THEN 1 ELSE 0 END) AS warned_first,
       round(median(lead_minutes), 0) AS median_lead_min
FROM replay_lead_time WHERE event_id = :event_id
```

  2. Parameters, declared on every dataset that uses them (`parameters: [{keyword, dataType: STRING, defaultSelection: {values: {dataType: STRING, values: [{value: ...}]}}}]`):
     `event_id` default = the M1 event id; `snapshot_time` default = the event's third hour as
     `yyyy-MM-dd HH:mm`. Both are STRING: `to_timestamp(:snapshot_time, 'yyyy-MM-dd HH:mm')` in SQL keeps the
     filter value list and the parameter in one format.
  3. `src/dashboards/replay.lvdash.json`, same skeleton and theme as `risk_map.lvdash.json` (07 T6.5):

| Widget | Type, version | Dataset, fields | Position |
|---|---|---|---|
| title | text | "## FrostSight · Storm replay · Troms" + one line "Pick an event, then step the hour. Rows come from the live pipeline replayed at ×N; incidents from DATEX and NVDB." | 0,0 12x2 |
| filter-event | `filter-single-select` v2 | field `event_id` from `ds_events` (value list) plus `parameterName: event_id` on the other seven datasets | 0,2 4x2 |
| filter-hour | `filter-single-select` v2 | field `snapshot_hour` from `ds_hours` (value list) plus `parameterName: snapshot_time` on `ds_snapshot_kpi`, `ds_snapshot_map`, `ds_incidents_to_snapshot`; title "Snapshot hour (scrubber)" | 4,2 4x2 |
| event-status | `table` v2 | `ds_events`: status, files_landed, rows_silver, snapshots | 8,2 4x2 |
| kpi-high | `counter` v2, `disaggregated: true` | `ds_snapshot_kpi.segments_high`, `formatTemplate "{{@formatted}} of {{segments_total}}"`, title "Segments HIGH or above at snapshot" | 0,4 3x3 |
| kpi-incidents | `counter` v2 | `ds_snapshot_kpi.active_incidents` | 3,4 3x3 |
| kpi-max | `counter` v2 | `ds_snapshot_kpi.max_score` | 6,4 3x3 |
| kpi-lead | `counter` v2 | `ds_lead_kpi.median_lead_min`, `formatTemplate "{{@formatted}} min · {{warned_first}} of {{incidents_on_segments}} warned first"` | 9,4 3x3 |
| map-snapshot | `symbol-map` v2 | `ds_snapshot_map` lat, lon, colour `risk_level` with the 07 categorical mappings, tooltip road_number, risk_score, active_incidents | 0,7 8x8 |
| incidents-table | `table` v2 | `ds_incidents_to_snapshot` all columns, title "Incidents reported up to the snapshot" | 8,7 4x8 |
| line-high | `line` v3 | `ds_high_per_hour`: x temporal `snapshot_time`, y quantitative `segments_high` and `active_incidents` (multi-y), title "HIGH-or-above segments per hour" | 0,15 12x5 |
| lead-table | `table` v2 | `ds_lead_time` | 0,20 12x5 |
| footer | text | "Frost history through the live pipeline; precipitation type approximated (ADR 0007). Sources: Statens vegvesen (NLOD), MET Norway (CC BY 4.0)." | 0,25 12x1 |

     verify: a `filter-single-select` with one field query (the value list) and several `parameterName`
     bindings in the same widget, the shape the skill shows for date-range filters; the M6 note on STRING
     parameters rendering as a text box applies. If the mixed form is rejected, keep the parameter bindings and
     type the hour by hand (still the scrubber, less pleasant), and record it in `13_stretch_review.md`.
  4. Add to `resources/dashboards.dashboard.yml`:

```yaml
    replay:
      display_name: "FrostSight · Storm replay"
      file_path: ../src/dashboards/replay.lvdash.json
      warehouse_id: ${var.warehouse_id}
      dataset_catalog: ${var.catalog}
      dataset_schema: gold
      embed_credentials: true
      permissions: [{level: CAN_READ, group_name: users}]
```

     `jq empty src/dashboards/replay.lvdash.json`, `databricks bundle deploy -t personal --profile frostsight-personal`,
     `databricks bundle open replay -t personal --profile frostsight-personal`.

Expect: every `q` returns rows for the scored event (`ds_snapshot_kpi` one row with `segments_total` about 30);
the published page shows the map recolouring as `snapshot_time` steps, the incidents table growing, the line
chart peaking in the storm's coldest hours.
If it fails: empty widgets after picking an event (the `snapshot_time` default is not one of `ds_hours`, pick
one from the list); "no selected fields" (field name mismatch); `to_timestamp` returns NULL (the value list
format and the SQL format differ; both are `yyyy-MM-dd HH:mm`); map empty (`v_segments` centroids, 07 T6.3).

### T-S1.8 Lead-time metric      owner: Safiul
Why: WR-UC-21 asks whether the score preceded observed incidents; S3 uses the same rows to judge the model.
Do:
  1. The computation lives in `build_replay_snapshots.build_lead_time` (T-S1.4) and writes
     `gold.replay_lead_time(event_id, incident_id, source, road_segment_id, incident_time, first_high_time, lead_minutes, level_at_incident)`.
     Definition, to be quoted in S3: for each incident in the window that maps to a segment, `first_high_time`
     is the earliest snapshot hour at or before the incident where that segment was HIGH or VERY_HIGH;
     `lead_minutes = incident_time - first_high_time` in minutes (positive: the map warned first; null: never
     HIGH before the incident); `level_at_incident` is the level of the snapshot at the incident's hour.
  2. Ad-hoc reading, the WR-UC-21 numbers for one event:

```sql
SELECT event_id, count(*) AS incidents,
       sum(CASE WHEN lead_minutes > 0 THEN 1 ELSE 0 END) AS warned_first,
       round(100.0 * sum(CASE WHEN lead_minutes > 0 THEN 1 ELSE 0 END) / count(*), 1) AS recall_pct,
       round(median(lead_minutes), 0) AS median_lead_min, round(percentile(lead_minutes, 0.9), 0) AS p90_lead_min,
       sum(CASE WHEN level_at_incident IN ('HIGH', 'VERY_HIGH') THEN 1 ELSE 0 END) AS high_at_incident
FROM frostsight.gold.replay_lead_time GROUP BY event_id;
```

     Precision (segments HIGH with no incident) is S3's job: it needs a negative set, which
     `gold.replay_snapshots` provides hour by hour.
  3. Caveat for the write-up: NVDB accident times are local date plus `HH:mm` converted to UTC (05 T4.6);
     slides carry a date and often `00:00`; a slide at `00:00` gets a lead time against the snapshot at
     midnight, which is honest but coarse. Filter `source = 'nvdb_accident'` for the precise number.

Expect: `SELECT count(*), sum(CASE WHEN lead_minutes > 0 THEN 1 ELSE 0 END) FROM frostsight.gold.replay_lead_time WHERE event_id = '<id>'`
returns a count equal to the incidents on segments in the window; lead times are between −360 and the event
length in minutes.
If it fails: zero rows (no NVDB event in the window: check `SELECT count(*) FROM frostsight.silver.accidents WHERE event_time BETWEEN ...`;
pick another event from `replay_events.yml`, M1 T1.8 said days with slides make the better demo);
`road_segment_id` null for most incidents (H3 cells missing on `silver.road_segments`, or coordinates outside the county).

## 3. Done when

- [ ] `gold.road_segment_risk_history` has `_batch_id`; 07's `ds_risk_history` and `ds_latency` filter `NOT LIKE 'replay:%'`; `build_gold.py --event-id` (06_M5 T5.4) scores the event into history only.
- [ ] `silver.road_weather_observations` is fed by `road_weather_live` and `road_weather_replay` (05_M4 T4.4); `transforms.normalise_road_weather` is the one normalisation; both flow names appear in `gold.ingest_event_log`.
- [ ] Harness writes `replay__<event_id>__<ts>__<run>.jsonl`; `test_batch_id` covers the four-part name.
- [ ] `resources/replay.job.yml` deployed; one storm replayed on `free` at ×60 through the `orchestrate` triggers; `gold.replay_events` shows `SNAPSHOTTED` with timings.
- [ ] `gold.replay_snapshots`, `gold.replay_incidents`, `gold.replay_lead_time` filled for that event.
- [ ] `test_equivalence` task green for that event (A and B).
- [ ] `FrostSight · Storm replay` dashboard published; stepping `snapshot_time` recolours the map; incidents overlay.
- [ ] `runbooks/replay.md` written; a cleanup and a second replay of the same event done once, with equal counts.
- [ ] 08 T7.8 demo minute 4-8 switched to this dashboard; `gold.road_segment_current_risk` untouched throughout (checked by `max(event_time)`).

## 4. Verify

```bash
cd project
databricks bundle validate -t free --strict --profile frostsight-free
databricks bundle summary -t free --profile frostsight-free | grep -E "replay|ingest"
uv run pytest -q tests/unit                                 # test_batch_id with the run suffix
uv run python -m replay.harness --event <id> --speed 60 --target free --dry-run | tail -2
JOB_ID=$(databricks bundle summary -t free --output json --profile frostsight-free | jq -r '.resources.jobs.replay.id')
databricks jobs list-runs --job-id "$JOB_ID" --limit 1 --profile frostsight-free | jq '.runs[0] | {state: .state.result_state, duration: .run_duration}'
```

```sql
SELECT event_id, status, speed, files_landed, first_file_at, last_file_at, rows_silver, rows_history, snapshots, incidents
FROM frostsight.gold.replay_events;
SELECT origin.flow_name, count(*) AS updates FROM frostsight.gold.ingest_event_log
WHERE event_type = 'flow_progress' AND timestamp >= current_date() GROUP BY 1;          -- both road_weather flows present
SELECT snapshot_time, sum(CASE WHEN risk_level IN ('HIGH','VERY_HIGH') THEN 1 ELSE 0 END) AS high, count(*) AS segments
FROM frostsight.gold.replay_snapshots WHERE event_id = '<id>' GROUP BY 1 ORDER BY 1;
SELECT max(event_time) AS newest_current, max(risk_updated_at) FROM frostsight.gold.road_segment_current_risk;   -- today, not last winter
SELECT coalesce(_batch_id LIKE 'replay:%', false) AS replay, count(*) FROM frostsight.gold.road_segment_risk_history GROUP BY 1;
SELECT source, count(*), round(avg(lead_minutes)) AS mean_lead FROM frostsight.gold.replay_lead_time WHERE event_id = '<id>' GROUP BY 1;
```

Expected: validate clean; summary lists `replay frostsight-replay`; dry run ends with `run r...: 36 files` for a
6-hour window; the last `replay` run is `SUCCESS`; the catalogue row is `SNAPSHOTTED`; two flow names; one
snapshot row per hour with `segments` about 30; `newest_current` is today; the history split shows both groups;
lead times per source.
