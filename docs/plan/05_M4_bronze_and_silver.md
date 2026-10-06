# M4: Bronze and silver live

Owners: Shawon (bronze, Auto Loader, collector contract), Sani (silver, watermark, dedup, quarantine),
Rayhan (reference job, station lookup, bundle YAML). Safiul reviews.

Goal: one Lakeflow Declarative Pipeline called `ingest` reads the landing volume with Auto Loader into
bronze streaming tables, builds silver streaming tables with expectations, routes failing rows to
quarantine tables and materialises `silver.station_segment_lookup`. A batch job called `reference` loads
NVDB and the other reference sources into bronze and silver. The `orchestrate` job triggers one pipeline
update every 10 minutes on Free Edition.

Inputs from earlier milestones: the landing volume and collector (M2), the silver schemas, watermark
(30 min), dedup key `(station_id, event_time)` and the mapping method (M3, file `04_M3_design.md`).

## 0. Lakeflow Declarative Pipelines in 15 lines

1. A pipeline is a set of Python (or SQL) files. Each file declares tables. Databricks works out the
   dependency graph, orders the work, runs it on serverless compute and keeps the checkpoints.
2. You never write `writeStream`, `start()` or a checkpoint path. The pipeline owns the write side.
3. A **streaming table** is append-only and processes each input row exactly once. Use it for Auto Loader
   and for anything that reads another streaming table with `spark.readStream.table(...)`.
4. A **materialized view** is a stored query result recomputed (incrementally when possible) on every
   update. Use it for joins and aggregates over batch data with `spark.read.table(...)`.
5. A function decorated with `@dp.table` that returns a streaming DataFrame becomes a streaming table named
   after the function, or after `name=`. `@dp.materialized_view` does the same for batch DataFrames.
6. `@dp.temporary_view` declares pipeline-private logic that is not published to Unity Catalog.
7. **Expectations** are row-level SQL predicates: `@dp.expect` logs, `@dp.expect_or_drop` drops the row,
   `@dp.expect_or_fail` stops the update. Counts per rule land in the event log.
8. Expectations do not route rows anywhere. Our quarantine tables are ordinary streaming tables that select
   the failing rows (section T4.3).
9. The **event log** is a Delta table the pipeline writes about itself: flow progress, row counts,
   expectation pass/fail counts, errors. Query it with the `event_log()` table function.
10. An **update** is one run. Triggered mode (`continuous: false`) processes everything new and stops.
    That is how we run on Free Edition; a job starts an update every 10 minutes.
11. A **full refresh** drops streaming state and reprocesses all sources from scratch. It is destructive
    for tables fed by files that were since deleted. Use it only when a schema or logic change requires it.
12. Table names can be three-part (`catalog.schema.table`). We use that to write bronze, silver and
    quarantine from one pipeline.
13. Free Edition allows **one active pipeline per account**. Every flow in this project lives in this one
    pipeline. Do not create a second pipeline in the team workspace.
14. Development mode (`development: true`) reuses compute between updates and disables retries. The bundle
    variable `pipeline_development` sets it: `true` on `free` and `personal`, `false` on `aws` (README table).
15. Code changes take effect only after `databricks bundle deploy`. Deploy, then run.
16. Python API: `from pyspark import pipelines as dp`. `import dlt`, `@dlt.view`, `dlt.read()` and the
    `LIVE.` prefix are the old DLT syntax; do not use them.

## 1. Decisions fixed in this milestone

| Decision | Choice | Why |
|---|---|---|
| DATEX II XML | The collector parses the XML and writes **JSON lines with a flat schema** (contract v1 below). The raw XML is also kept under `raw/road_weather_xml/` and `raw/road_incidents_xml/`, never read by the pipeline | One parser in Python, unit-testable outside Databricks; replay files from Frost use the same JSON contract; bronze stays a plain `cloudFiles.format = json` read. Fallback if the collector cannot flatten: `cloudFiles.format = "xml"` with `rowTag` (Auto Loader supports it) and the flattening moves into bronze |
| Incidents in silver | `silver.road_incidents` is a **materialized view**, not a streaming table | The DATEX situation feed is a snapshot: every poll repeats every open incident with a new version. Silver wants one current row per incident and a nearest-segment choice. Both are `GROUP BY` / `min_by` shapes that append-only streaming tables cannot express; a materialized view recomputes them cleanly on each update |
| Quarantine | Second streaming table selecting the failing rows; every quarantine table has the same six columns `original_row STRING, source STRING, quarantined_at TIMESTAMP, rule STRING, reason STRING, pipeline_run_id STRING` (`rule` = the id from `config/dq_rules.yml`) | See section 0, line 8; one shape lets the health page (M6) union them |
| Rules | `config/dq_rules.yml` from M2 (T2.7) is the only rule source: `rules: [{id, table, expression, action}]`, 18 rules, ids `RW001..RW008`, `IN001..IN004`, `ST001..ST002`, `SG001..SG002`, `XS001..XS002` | Rule ids are stable across expectations, quarantine rows and dashboards |
| Reference data | Batch job, Delta `MERGE` on natural keys | Re-runnable; NVDB changes weekly |
| Station lookup | Materialized view inside the pipeline, H3 candidate filter then `ST_Distance` in EPSG:25833 | Recomputes on each update; 30 stations x candidate segments is tiny |
| Landing files | README section 4: `raw/<source>/<yyyy>/<mm>/<dd>/<UTCts>.jsonl` live, `replay__<event_id>__<UTCts>__r<run start>.jsonl` replay, `raw/<source>/_failed/<UTCts>.json` collector failure markers | Bronze reads `*.jsonl` only (`pathGlobFilter`), so the `.json` markers are never ingested |
| Silver road weather: live and replay flows | `silver.road_weather_observations` is `dp.create_streaming_table` fed by two `@dp.append_flow`s: `road_weather_live` (bronze rows with `_batch_id NOT LIKE 'replay:%'`) and `road_weather_replay` (`LIKE 'replay:%'`). Both call `transforms.normalise_road_weather`, carry the same expectations and the same dedup key; each is its own streaming query with its own checkpoint, 30-minute watermark and dedup state | A streaming query has one watermark. Live data holds it at "now - 30 min", so every row replayed from last winter would be dropped as late. Built this way from M4 so S1 (10_S1 D2) needs no code change and no full refresh later |

Flat JSON contract v1 for `raw/road_weather/<yyyy>/<mm>/<dd>/<UTC timestamp>.jsonl`, one object per line
(fixed at M1, repeated here because bronze depends on it):

```json
{"schema_version": "1", "source_event_id": "SVV-1900177-2026-11-03T07:10:00Z",
 "station_ref": "1900177", "site_id": "SVV.1900177", "measurement_time": "2026-11-03T07:10:00Z",
 "air_temperature": -3.2, "road_surface_temperature": -4.1, "dew_point": -3.8, "humidity": 96.0,
 "temperature_unit": "C", "precipitation_type": "snow", "precipitation_intensity": 0.4,
 "precipitation_unit": "mm/h", "wind_speed": 3.1, "wind_speed_unit": "m/s", "wind_direction": 210.0,
 "road_surface_state": "wet"}
```

Incident lines under `raw/road_incidents/...` carry `schema_version, source_event_id, incident_id,
version, incident_type, severity, road_ref, start_time, end_time, description, lat, lon, snapshot_time`.
`incident_type` values are the lower-case set from rule `IN003`: `closure, accident, roadworks, weather,
obstruction, other`. Silver renames `lat, lon` to `latitude, longitude` (the names the rules and 04_M3 use).

## 2. Tasks

### T4.1 Rule config loader and package extras      owner: Sani
Why: the 18 rules in `config/dq_rules.yml` (M2, T2.7) must become pipeline expectations and quarantine rows
without anyone retyping them; one loader reads the file in the pipeline, in the jobs and in the unit tests.
Do:
  1. Do not create a second rules file. The shape from M2, which everything below relies on:

```yaml
version: 1
rules:
  - id: RW001
    table: silver.road_weather_observations
    expression: "air_temperature_c IS NULL OR air_temperature_c BETWEEN -60 AND 50"
    action: drop            # drop -> expect_or_drop + quarantine row; warn -> expect (kept, counted); fail -> expect_or_fail
  # ... RW002..RW008, IN001..IN004, ST001..ST002, SG001..SG002, XS001..XS002
```

     Two rules need columns the pipeline computes: `XS001` (`station_known`, true when `station_id` exists in
     `silver.road_weather_stations`) and `XS002` (`road_segment_id IS NOT NULL`, filled from
     `silver.station_segment_lookup`). T4.4 adds both columns with stream-static joins. `ST*` and `SG*`
     rules are applied by the reference job (T4.6), not by the pipeline.

  2. Replace `src/frostsight/config.py` (M2 left a one-function stub):

```python
"""Reads YAML config. Resolution order: explicit argument, FROSTSIGHT_CONFIG_DIR env var, repo layout."""
from __future__ import annotations

import os
from pathlib import Path

import yaml

_REPO_CONFIG = Path(__file__).resolve().parents[2] / "config"   # config when run from the repo
ACTIONS = ("drop", "warn", "fail")


def config_dir(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit)
    env = os.environ.get("FROSTSIGHT_CONFIG_DIR")
    return Path(env) if env else _REPO_CONFIG


def load_yaml(name: str, explicit_dir: str | None = None) -> dict:
    path = config_dir(explicit_dir) / name
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def dq_rules(table: str | None = None, explicit_dir: str | None = None) -> list[dict]:
    """All rules, or the rules of one table (two-part name, e.g. 'silver.road_incidents')."""
    rules = load_yaml("dq_rules.yml", explicit_dir)["rules"]
    for r in rules:
        if r["action"] not in ACTIONS:
            raise ValueError(f"rule {r['id']}: action must be one of {ACTIONS}")
    return [r for r in rules if table is None or r["table"] == table]


def rules_by_action(table: str, action: str, explicit_dir: str | None = None) -> dict[str, str]:
    """{rule_id: sql_expression} for one table and action, ready for dp.expect_all_*."""
    return {r["id"]: r["expression"] for r in dq_rules(table, explicit_dir) if r["action"] == action}


def rule_actions(explicit_dir: str | None = None) -> dict[str, str]:
    """{rule_id: action} for every rule; the freshness job joins event-log counts to it."""
    return {r["id"]: r["action"] for r in dq_rules(None, explicit_dir)}
```

  3. `pyproject.toml` exists from M2 (T2.3) and builds the wheel with `pyyaml` and `requests`.
     Add only the dev extras (the geo libraries are needed by the unit tests and by the `reference` job
     environment, not by the wheel):

```toml
[project.optional-dependencies]
dev = ["pytest>=8", "pyspark>=3.5,<4", "ruff", "pyproj>=3.6", "shapely>=2", "h3>=4", "pandas>=2"]
```

Expect: `uv run python -c "from frostsight.config import rules_by_action; print(rules_by_action('silver.road_weather_observations','drop'))"`
prints seven rules (`RW001` to `RW006` and `XS001`); `rules_by_action('silver.road_incidents','warn')` prints `IN003`.
If it fails: `yaml` missing (run `uv sync --extra dev`); wrong working directory (`_REPO_CONFIG` assumes
`src/frostsight/config.py`); `KeyError: 'rules'` means someone rewrote the file in another shape.

### T4.2 Pure transforms and metadata parsing      owner: Shawon
Why: unit conversion and file-name parsing are pure functions we test locally and reuse in the pipeline.
Do:
  1. Create `src/frostsight/transforms.py`:

```python
"""Silver normalisation helpers. Pure PySpark column expressions, no SparkSession created here."""
from __future__ import annotations

from pyspark.sql import Column, DataFrame
from pyspark.sql import functions as F

PRECIP_TYPES = {
    "snow": "SNOW", "sleet": "SLEET", "freezingrain": "FREEZING_RAIN", "freezing rain": "FREEZING_RAIN",
    "rain": "RAIN", "drizzle": "DRIZZLE", "none": "NONE", "noprecipitation": "NONE", "dry": "NONE",
}


def to_celsius(value: Column, unit: Column) -> Column:
    """DATEX II sends Celsius. Frost sends Celsius. Kelvin and Fahrenheit are handled in case a source changes."""
    u = F.upper(F.coalesce(unit, F.lit("C")))
    return (F.when(u == "K", value - F.lit(273.15))
             .when(u == "F", (value - F.lit(32.0)) * F.lit(5.0 / 9.0))
             .otherwise(value)).cast("double")


def to_ms(value: Column, unit: Column) -> Column:
    u = F.lower(F.coalesce(unit, F.lit("m/s")))
    return (F.when(u == "km/h", value / F.lit(3.6))
             .when(u == "kn", value * F.lit(0.514444))
             .otherwise(value)).cast("double")


def to_mm_per_hour(value: Column, unit: Column) -> Column:
    """mm/h stays; mm per 10 min (Frost PT10M sums) becomes mm/h."""
    u = F.lower(F.coalesce(unit, F.lit("mm/h")))
    return (F.when(u == "mm/10min", value * F.lit(6.0)).otherwise(value)).cast("double")


def normalise_precip_type(raw: Column) -> Column:
    key = F.lower(F.regexp_replace(F.coalesce(raw, F.lit("none")), "[_\\s]", ""))
    expr = F.lit("UNKNOWN")
    for k, v in PRECIP_TYPES.items():
        expr = F.when(key == k.replace(" ", ""), F.lit(v)).otherwise(expr)
    return expr


def to_utc_timestamp(iso_string: Column) -> Column:
    """ISO 8601 with Z or offset. Session time zone is UTC (set in the pipeline configuration)."""
    return F.to_timestamp(iso_string)


def batch_id_from_path(file_path: Column) -> Column:
    """README section 4 file names:
       live    raw/road_weather/2026/11/03/20261103T071000Z.jsonl -> 20261103T071000Z
       replay  raw/road_weather/2026/01/15/replay__storm_2026_01_15__20260115T081000Z__r20261120T091500Z.jsonl
               -> replay:storm_2026_01_15 (part 2; the timestamp and the run suffix are ignored)"""
    stem = F.regexp_extract(file_path, r"([^/]+)\.[A-Za-z0-9]+$", 1)
    return F.when(stem.startswith("replay__"),
                  F.concat(F.lit("replay:"), F.split(stem, "__").getItem(1))).otherwise(stem)


def metadata_columns(source: str):
    """The six bronze metadata columns. Call as df.select('*', *metadata_columns('road_weather'))."""
    return [
        F.current_timestamp().alias("_ingested_at"),
        F.lit(source).alias("_source"),
        F.col("_metadata.file_path").alias("_source_file"),
        F.col("source_event_id").alias("_source_event_id"),
        batch_id_from_path(F.col("_metadata.file_path")).alias("_batch_id"),
        F.coalesce(F.col("schema_version"), F.lit("1")).alias("_schema_version"),
    ]


def normalise_road_weather(b: DataFrame) -> DataFrame:
    """Bronze road_weather_events (contract v1 + metadata columns) -> silver column contract, before the joins.
    One function for both silver flows (T4.4) and for the S1 equivalence test, so the three cannot drift."""
    return b.select(
        F.col("station_ref").cast("string").alias("station_id"),
        to_utc_timestamp(F.col("measurement_time")).alias("event_time"),
        to_celsius(F.col("air_temperature"), F.col("temperature_unit")).alias("air_temperature_c"),
        to_celsius(F.col("road_surface_temperature"), F.col("temperature_unit")).alias("road_surface_temperature_c"),
        to_celsius(F.col("dew_point"), F.col("temperature_unit")).alias("dew_point_c"),
        F.col("humidity").cast("double").alias("humidity_pct"),
        normalise_precip_type(F.col("precipitation_type")).alias("precipitation_type"),
        to_mm_per_hour(F.col("precipitation_intensity"), F.col("precipitation_unit")).alias("precipitation_intensity_mm_h"),
        to_ms(F.col("wind_speed"), F.col("wind_speed_unit")).alias("wind_speed_ms"),
        F.col("wind_direction").cast("double").alias("wind_direction_deg"),
        F.upper(F.col("road_surface_state")).alias("road_surface_state"),
        F.col("site_id").alias("source_station_ref"),
        "_ingested_at", "_source", "_source_file", "_source_event_id", "_batch_id", "_schema_version",
    )
```

Expect: `uv run pytest tests/unit/test_transforms.py` passes (T4.9 writes the tests).
If it fails: `_metadata.file_path` only exists on file sources; do not call `metadata_columns` on a Delta read.

### T4.3 Bronze streaming tables with Auto Loader      owner: Shawon
Why: bronze preserves every landed row once, with lineage columns, and never fails on a new field.
Do:
  1. Create `src/pipelines/bronze.py`:

```python
"""Bronze: Auto Loader from the landing volume. One streaming table per source, plus quarantine.schema_errors."""
from pyspark import pipelines as dp
from pyspark.sql import functions as F

from frostsight.transforms import metadata_columns

CATALOG = spark.conf.get("frostsight.catalog")
LANDING = spark.conf.get("frostsight.landing_root")          # /Volumes/frostsight/landing/raw
RUN_ID = spark.conf.get("pipelines.id", "unknown")           # verify: see T4.4 step 2

WEATHER_HINTS = """
  schema_version STRING, source_event_id STRING, station_ref STRING, site_id STRING,
  measurement_time STRING, air_temperature DOUBLE, road_surface_temperature DOUBLE, dew_point DOUBLE,
  humidity DOUBLE, temperature_unit STRING, precipitation_type STRING, precipitation_intensity DOUBLE,
  precipitation_unit STRING, wind_speed DOUBLE, wind_speed_unit STRING, wind_direction DOUBLE,
  road_surface_state STRING
"""

INCIDENT_HINTS = """
  schema_version STRING, source_event_id STRING, incident_id STRING, version INT, incident_type STRING,
  severity STRING, road_ref STRING, start_time STRING, end_time STRING, description STRING,
  lat DOUBLE, lon DOUBLE, snapshot_time STRING
"""


def _autoloader(path: str, hints: str):
    """Reads raw/<source>/<yyyy>/<mm>/<dd>/*.jsonl. The collector's failure markers are
    raw/<source>/_failed/<ts>.json: the .json extension does not match the glob, so they are never read."""
    return (spark.readStream.format("cloudFiles")
            .option("cloudFiles.format", "json")
            .option("cloudFiles.schemaHints", hints)
            .option("cloudFiles.schemaEvolutionMode", "addNewColumns")   # new field -> column added, update restarts once
            .option("cloudFiles.inferColumnTypes", "true")
            .option("rescuedDataColumn", "_rescued_data")                # type mismatches land here, row is kept
            .option("cloudFiles.includeExistingFiles", "true")
            .option("pathGlobFilter", "*.jsonl")                         # generic file option; matches the file name only
            .load(path))


@dp.table(
    name=f"{CATALOG}.bronze.road_weather_events",
    comment="Raw road-weather readings as landed by the collector (DATEX II flattened to JSON lines).",
    cluster_by=["_batch_id"],
    table_properties={"quality": "bronze"},
)
def road_weather_events():
    return _autoloader(f"{LANDING}/road_weather/", WEATHER_HINTS).select(
        "*", *metadata_columns("road_weather"))


@dp.table(
    name=f"{CATALOG}.bronze.road_incident_events",
    comment="Raw DATEX II situation snapshots, one row per incident per poll.",
    cluster_by=["_batch_id"],
    table_properties={"quality": "bronze"},
)
def road_incident_events():
    return _autoloader(f"{LANDING}/road_incidents/", INCIDENT_HINTS).select(
        "*", *metadata_columns("road_incidents"))


# quarantine.schema_errors: one target, one append flow per bronze table (the documented fan-in pattern;
# a UNION of two streams is not). Same six columns as every other quarantine table.
dp.create_streaming_table(
    name=f"{CATALOG}.quarantine.schema_errors",
    comment="Bronze rows where Auto Loader rescued a field (type mismatch or unexpected structure).",
    schema="original_row STRING, source STRING, quarantined_at TIMESTAMP, rule STRING, reason STRING, pipeline_run_id STRING",
)


def _rescued(table: str):
    b = spark.readStream.table(f"{CATALOG}.bronze.{table}").where("_rescued_data IS NOT NULL")
    return b.select(F.to_json(F.struct("*")).alias("original_row"),
                    F.col("_source").alias("source"),
                    F.col("_ingested_at").alias("quarantined_at"),
                    F.lit("rescued_data").alias("rule"),
                    F.col("_rescued_data").alias("reason"),
                    F.lit(RUN_ID).alias("pipeline_run_id"))


@dp.append_flow(target=f"{CATALOG}.quarantine.schema_errors", name="schema_errors_road_weather")
def schema_errors_road_weather():
    return _rescued("road_weather_events")


@dp.append_flow(target=f"{CATALOG}.quarantine.schema_errors", name="schema_errors_road_incidents")
def schema_errors_road_incidents():
    return _rescued("road_incident_events")
```

  2. Note the choice: `_rescued_data` errors stay in bronze (the row is kept) and are copied to
     `quarantine.schema_errors` with `rule = 'rescued_data'` (not an id from `dq_rules.yml`: it is a parse
     problem, not a value rule). Value rules are applied in silver, not here.
  3. `pathGlobFilter` is the generic Spark file option the pipelines reference lists for Auto Loader
     (`pathGlobFilter / fileNamePattern`). It filters on the file name only, which is why the layout puts the
     failure markers under `.json` and the data under `.jsonl`. verify: land one `raw/road_weather/_failed/
     20261103T071000Z.json` on `personal`, run an update, and check `bronze.road_weather_events` did not grow.
     If it did, the fallback is a glob in the path: `.load(f"{LANDING}/road_weather/*/*/*/")` (date folders
     only, so `_failed/` is structurally excluded); Auto Loader accepts glob patterns in the input path.

Expect: after T4.7 deploys and runs, `SELECT count(*) FROM frostsight.bronze.road_weather_events` equals
the number of JSON lines landed; `SELECT DISTINCT _batch_id ... ORDER BY 1 DESC LIMIT 3` shows the last
three collector timestamps.
If it fails: `schemaHints` disagree with a real file (run `SELECT * FROM read_files('/Volumes/frostsight/landing/raw/road_weather/', format => 'json') LIMIT 5` in the SQL editor and fix the hint); `frostsight.catalog` not set (check `configuration` in `ingest.pipeline.yml`); the path in `cloudFiles` has no trailing slash and Auto Loader treats it as a file; `ModuleNotFoundError: frostsight` (the `root_path` note in T4.7).

### T4.4 Silver road-weather observations, dedup and quarantine      owner: Sani
Why: silver is the clean, deduplicated, unit-normalised table every window and risk calculation reads.
Do:
  1. Create `src/pipelines/silver.py`. The pattern: a temporary view normalises (with
     `transforms.normalise_road_weather`), joins the station and lookup tables (for `XS001`, `XS002`),
     watermarks, deduplicates and evaluates every `drop` rule into an array `_failed_rules`. There are two such
     views, one for live bronze rows and one for replay rows (section 1, "live and replay flows"), and two
     append flows into the one silver table. Why two: a streaming query has exactly one watermark, the
     maximum event time it has seen minus 30 minutes. Live data keeps it at "now - 30 min", so a file from
     last January replayed through a single flow would be dropped row by row as late. With its own flow, the
     replay slice has its own watermark that follows the replayed storm, and its own dedup state. The silver
     table carries the rules as expectations, so the engine drops the failing rows **and** records pass/fail
     counts per rule and per flow in the event log; the quarantine table selects the rows with a non-empty
     `_failed_rules`, one row per failed rule, through the same two slices. The two evaluations use the same
     SQL strings, so they always agree. Consequences to know: live and replay rows are deduplicated
     separately (a replay row never removes a live row with the same key; only the harness `--latest` mode
     can produce such a pair, 03_M2 T2.6); one replay event at a time per flow state, and replaying an older
     event after a newer one needs the reset in 10_S1 D3.

```python
"""Silver: normalised road-weather observations and incidents, with quarantine."""
from pyspark import pipelines as dp
from pyspark.sql import functions as F

from frostsight.config import rules_by_action
from frostsight import transforms as T

CATALOG = spark.conf.get("frostsight.catalog")
CONFIG_DIR = spark.conf.get("frostsight.config_dir")
WATERMARK = "30 minutes"
RUN_ID = spark.conf.get("pipelines.id", "unknown")   # verify: step 2

OBS = "silver.road_weather_observations"
INC = "silver.road_incidents"
HARD = rules_by_action(OBS, "drop", CONFIG_DIR)      # RW001..RW006, XS001
SOFT = rules_by_action(OBS, "warn", CONFIG_DIR)      # RW007, RW008, XS002
INCIDENT_HARD = rules_by_action(INC, "drop", CONFIG_DIR)   # IN001, IN002, IN004
INCIDENT_SOFT = rules_by_action(INC, "warn", CONFIG_DIR)   # IN003
H3_RES = 9
QUARANTINE_COLS = ["original_row", "source", "quarantined_at", "rule", "reason", "pipeline_run_id"]


def _failed_rules_column(rules: dict[str, str]):
    """ARRAY<STRING> of rule ids whose expression is false or null for the row."""
    flags = [F.when(~F.coalesce(F.expr(expr), F.lit(False)), F.lit(rule_id)) for rule_id, expr in rules.items()]
    return F.array_compact(F.array(*flags))


def _quarantine_rows(df, source: str):
    """One row per (row, failed rule) in the six-column quarantine shape."""
    keep = [c for c in df.columns if c != "_failed_rules"]
    return (df.where(F.size("_failed_rules") > 0)
              .select(F.to_json(F.struct(*keep)).alias("original_row"),
                      F.lit(source).alias("source"),
                      F.col("_ingested_at").alias("quarantined_at"),
                      F.explode("_failed_rules").alias("rule"))
              .withColumn("reason", F.concat(F.lit("failed "), F.col("rule")))
              .withColumn("pipeline_run_id", F.lit(RUN_ID))
              .select(*QUARANTINE_COLS))


# ---------- road weather ----------

BRONZE_RW = f"{CATALOG}.bronze.road_weather_events"
REPLAY = "_batch_id LIKE 'replay:%'"          # README section 4: replay files carry replay:<event_id>


def _normalised(bronze_filter: str):
    """Normalise, join, watermark, dedup and flag one slice of bronze. Called once per flow: each consuming
    flow is its own streaming query, so each gets its own watermark and dedup state."""
    b = (spark.readStream.option("skipChangeCommits", "true")     # tolerate cleanup DELETEs on bronze (10_S1 T-S1.5)
         .table(BRONZE_RW).where(bronze_filter))
    n = T.normalise_road_weather(b)                               # T4.2: the one normalisation
    # Stream-static joins (static side is a snapshot taken at the start of the update):
    # station_known for XS001, road_segment_id for XS002. Both tables exist before the first update (T4.6, T4.5).
    stations = (spark.read.table(f"{CATALOG}.silver.road_weather_stations")
                .select("station_id", F.lit(True).alias("station_known")))
    lookup = spark.read.table(f"{CATALOG}.silver.station_segment_lookup").select("station_id", "road_segment_id")
    n = (n.join(stations, "station_id", "left").join(lookup, "station_id", "left")
          .withColumn("station_known", F.coalesce("station_known", F.lit(False))))
    # Watermark: rows older than (max event_time seen by THIS flow - 30 min) are dropped by the stateful operator.
    # dropDuplicatesWithinWatermark keeps the first row per key seen within the watermark window.
    deduped = (n.withWatermark("event_time", WATERMARK)
                .dropDuplicatesWithinWatermark(["station_id", "event_time"]))
    return deduped.withColumn("_failed_rules", _failed_rules_column(HARD))


@dp.temporary_view(name="road_weather_normalised_live")
def road_weather_normalised_live():
    return _normalised(f"NOT ({REPLAY})")


@dp.temporary_view(name="road_weather_normalised_replay")
def road_weather_normalised_replay():
    return _normalised(REPLAY)


# One target, two append flows (the documented fan-in pattern). Expectations sit on the target and are
# evaluated for every flow; the event log reports them per origin.flow_name.
dp.create_streaming_table(
    name=f"{CATALOG}.{OBS}",
    comment="Clean 10-minute road-weather observations, UTC, SI units, one row per station and time. Flows: live, replay.",
    cluster_by=["station_id", "event_time"],
    table_properties={"quality": "silver", "delta.enableRowTracking": "true"},
    expect_all_or_drop=HARD,      # the engine drops the failing rows here and counts them per rule in the event log
    expect_all=SOFT,              # warnings: kept, counted
)


@dp.append_flow(target=f"{CATALOG}.{OBS}", name="road_weather_live")
def road_weather_live():
    return spark.readStream.table("road_weather_normalised_live").drop("_failed_rules")


@dp.append_flow(target=f"{CATALOG}.{OBS}", name="road_weather_replay")
def road_weather_replay():
    return spark.readStream.table("road_weather_normalised_replay").drop("_failed_rules")


dp.create_streaming_table(
    name=f"{CATALOG}.quarantine.invalid_road_weather",
    comment="Road-weather rows that failed a drop rule. One row per failed rule, original row as JSON.",
    schema="original_row STRING, source STRING, quarantined_at TIMESTAMP, rule STRING, reason STRING, pipeline_run_id STRING",
)


@dp.append_flow(target=f"{CATALOG}.quarantine.invalid_road_weather", name="invalid_road_weather_live")
def invalid_road_weather_live():
    return _quarantine_rows(spark.readStream.table("road_weather_normalised_live"), "road_weather")


@dp.append_flow(target=f"{CATALOG}.quarantine.invalid_road_weather", name="invalid_road_weather_replay")
def invalid_road_weather_replay():
    return _quarantine_rows(spark.readStream.table("road_weather_normalised_replay"), "road_weather")


# ---------- incidents (materialized view, see section 1) ----------

@dp.temporary_view(name="road_incidents_latest")
def road_incidents_latest():
    """Latest version of each incident, typed, with a normalised road number."""
    b = spark.read.table(f"{CATALOG}.bronze.road_incident_events")
    typed = b.select(
        F.col("incident_id").cast("string").alias("incident_id"),
        F.coalesce(F.col("version"), F.lit(0)).alias("version"),
        F.lower(F.col("incident_type")).alias("incident_type"),          # IN003 values are lower case
        F.lower(F.col("severity")).alias("severity"),
        F.col("road_ref"),
        F.regexp_extract(F.upper(F.col("road_ref")), r"^(E|R|F|FV|RV|EV)\s?0*(\d+)", 2).alias("road_number"),
        T.to_utc_timestamp(F.col("start_time")).alias("start_time"),
        T.to_utc_timestamp(F.col("end_time")).alias("end_time"),
        F.col("description"),
        F.col("lat").cast("double").alias("latitude"), F.col("lon").cast("double").alias("longitude"),
        T.to_utc_timestamp(F.col("snapshot_time")).alias("snapshot_time"),
        "_ingested_at", "_source", "_source_file", "_source_event_id", "_batch_id", "_schema_version",
    )
    latest = (typed.groupBy("incident_id")
              .agg(F.max_by(F.struct(*[c for c in typed.columns if c != "incident_id"]),
                            F.struct("version", "snapshot_time")).alias("r"))
              .select("incident_id", "r.*"))
    return latest.withColumn("_failed_rules", _failed_rules_column(INCIDENT_HARD))


@dp.temporary_view(name="road_segment_cells")
def road_segment_cells():
    s = spark.read.table(f"{CATALOG}.silver.road_segments")
    return s.select("road_segment_id", F.col("road_number").alias("seg_road_number"), "geometry_wkt_25833",
                    F.explode("h3_cells").alias("h3_cell"))


@dp.materialized_view(
    name=f"{CATALOG}.{INC}",
    comment="Current state of each DATEX incident, mapped to the nearest NVDB segment on the same road.",
    cluster_by=["road_segment_id"],
)
@dp.expect_all_or_drop(INCIDENT_HARD)
@dp.expect_all(INCIDENT_SOFT)
def road_incidents():
    inc = spark.read.table("road_incidents_latest").drop("_failed_rules")
    inc = inc.withColumn("h3_cell", F.expr(f"h3_longlatash3(longitude, latitude, {H3_RES})"))
    cells = spark.read.table("road_segment_cells")
    # candidate segments: same H3 cell (res 9, ~170 m edge) and same road number when both are known
    cand = (inc.join(cells, on="h3_cell", how="left")
            .where((F.col("road_number") == "") | F.col("road_number").isNull()
                   | (F.col("road_number") == F.col("seg_road_number")) | F.col("seg_road_number").isNull())
            .withColumn("distance_m", F.expr(
                "ST_Distance(ST_Transform(ST_Point(longitude, latitude, 4326), 25833), ST_GeomFromWKT(geometry_wkt_25833, 25833))")))
    best = (cand.groupBy("incident_id")
            .agg(F.min_by(F.struct("road_segment_id", "distance_m"), "distance_m").alias("m")))
    return inc.drop("h3_cell").join(best, "incident_id", "left").select(
        "incident_id", "version", "incident_type", "severity", "road_ref", "road_number",
        F.when(F.col("m.distance_m") <= 500, F.col("m.road_segment_id")).alias("road_segment_id"),
        "start_time", "end_time", "description", "latitude", "longitude", "snapshot_time",
        "_ingested_at", "_source", "_source_file", "_source_event_id", "_batch_id", "_schema_version")


@dp.materialized_view(name=f"{CATALOG}.quarantine.invalid_incidents",
                      comment="Incident rows that failed a drop rule. Same six columns as every quarantine table.")
def invalid_incidents():
    return _quarantine_rows(spark.read.table("road_incidents_latest"), "road_incidents")
```

     Column contract of `silver.road_weather_observations` (M6 and M7 query these names): `station_id,
     event_time, air_temperature_c, road_surface_temperature_c, dew_point_c, humidity_pct,
     precipitation_type, precipitation_intensity_mm_h, wind_speed_ms, wind_direction_deg,
     road_surface_state, source_station_ref, station_known, road_segment_id` plus the six `_` metadata
     columns. `silver.road_incidents`: `incident_id, version, incident_type, severity, road_ref, road_number,
     road_segment_id, start_time, end_time, description, latitude, longitude, snapshot_time` plus metadata.
     An incident is "active" when `end_time IS NULL OR end_time > current_timestamp()`.

  2. Read the three things this code relies on and check them once on your personal workspace:
     - verify: `dropDuplicatesWithinWatermark` runs inside a Lakeflow pipeline on serverless (Spark 3.5
       API; the pipelines reference only rules it out for Real-Time Mode, which we do not use). Test: deploy
       to `personal`, run, look for a `DROP_DUPLICATES_WITHIN_WATERMARK` error in
       `databricks pipelines list-pipeline-events <pipeline_id> --profile frostsight-personal`. Fallback with
       identical result for our key (the key contains the event-time column):
       `.dropDuplicates(["station_id", "event_time"])` after the same `withWatermark`.
     - verify: `ST_Distance`, `ST_Transform`, `ST_Point`, `ST_GeomFromWKT` and `h3_longlatash3` on the
       serverless pipeline runtime (ST functions need DBR 17.1+ and are Public Preview; H3 functions are
       GA). Run `SELECT ST_Distance(ST_Point(0,0,25833), ST_Point(3,4,25833))` in the SQL editor; expect
       `5.0`. Fallback: T4.5 step 3.
     - verify: `spark.conf.get("pipelines.id")` returns the pipeline id inside a pipeline. If an update id is
       wanted instead, try `spark.conf.get("pipelines.updateId", "unknown")` and compare with
       `origin.update_id` in the event log. Either value is fine for `pipeline_run_id`; what matters is that
       every quarantine row of one update carries the same string.
  3. The rule `precipitation_intensity` unit: the DATEX flat contract sends mm/h; Frost replay files send
     `mm/10min`. `to_mm_per_hour` handles both. Do not "fix" it in the collector.
  4. Stream-static join order matters: the joins happen before `withWatermark` so the watermark and the
     dedup state see the final `station_id`. The static side is re-read at the start of every triggered
     update, so a station added by the weekly `reference` run is known from the next update on.
  5. verify: `dp.create_streaming_table(expect_all_or_drop=..., expect_all=...)` evaluates the expectations
     on rows of both append flows and reports them per `origin.flow_name` (the pipelines reference lists the
     three `expect_all*` dicts as parameters of `create_streaming_table`). Check after the first update:
     `SELECT origin.flow_name, count(*) FROM frostsight.gold.ingest_event_log WHERE event_type = 'flow_progress' AND details:flow_progress.data_quality IS NOT NULL GROUP BY 1`
     lists `road_weather_live` (and `road_weather_replay` once a replay file has landed). If the runtime rejects
     expectations on a flow target, move them onto each append flow as `@dp.expect_all_or_drop(HARD)` and
     `@dp.expect_all(SOFT)` decorators. verify: `skipChangeCommits` on a streaming read of a table the same
     pipeline owns (listed in the pipelines reference for streaming reads); it only matters once someone
     DELETEs replay rows from bronze (10_S1 T-S1.5 full cleanup).

Expect: `SELECT count(*), count(DISTINCT station_id, event_time) FROM frostsight.silver.road_weather_observations`
returns equal numbers. The pipeline graph shows two flows, `road_weather_live` and `road_weather_replay`,
into `silver.road_weather_observations` (the replay flow reads zero rows until S1 or the M7 demo lands a
replay file). `SELECT rule, count(*) FROM frostsight.quarantine.invalid_road_weather GROUP BY 1`
shows only rules you injected with the fixtures. `SELECT count(*) FROM frostsight.silver.road_incidents WHERE road_segment_id IS NULL`
is small (a few percent) and every one is explained by a missing or off-road coordinate. The pipeline UI,
silver table, tab "Data quality", shows the same failed counts per rule id as the quarantine table.
If it fails: "Expectation names must be unique" (a rule id repeats in `dq_rules.yml`); the temporary view is
read as batch (`spark.read.table`) where a stream was meant, or the reverse; the stream-static join errors
because `silver.road_segments` or `silver.road_weather_stations` does not exist yet (run `reference`, T4.6,
first); `UNRESOLVED_COLUMN station_known` (the join block was removed; `XS001` needs it).

### T4.5 Station-to-segment lookup      owner: Rayhan
Why: every observation must key to an NVDB segment; the lookup is computed once per update and cached.
Do:
  1. Create `src/pipelines/lookup.py`:

```python
"""silver.station_segment_lookup: nearest road segment per weather station (M3 method: H3 candidates + ST_Distance)."""
from pyspark import pipelines as dp
from pyspark.sql import functions as F

CATALOG = spark.conf.get("frostsight.catalog")
RUN_ID = spark.conf.get("pipelines.id", "unknown")
H3_RES = 9          # matches silver.road_segments.h3_cells
K_RING = 2          # ~ 3 cells of 170 m edge: candidates within ~500 m
MAX_DISTANCE_M = 500
COVERAGE_M = 5000   # a station's risk covers its own road this far, straight line (04_M3 T3.3 step 7, ADR 0006)
COVER_RES = 7       # ~1.2 km cells; a 4-ring around the station reaches past 5 km
QUARANTINE_COLS = ["original_row", "source", "quarantined_at", "rule", "reason", "pipeline_run_id"]


@dp.temporary_view(name="station_candidates")
def station_candidates():
    st = spark.read.table(f"{CATALOG}.silver.road_weather_stations").select(
        "station_id", "latitude", "longitude",
        F.explode(F.expr(f"h3_kring(h3_longlatash3(longitude, latitude, {H3_RES}), {K_RING})")).alias("h3_cell"))
    seg = spark.read.table(f"{CATALOG}.silver.road_segments").select(
        "road_segment_id", "geometry_wkt_25833", F.explode("h3_cells").alias("h3_cell"))
    return (st.join(seg, "h3_cell")
            .withColumn("distance_m", F.expr(
                "ST_Distance(ST_Transform(ST_Point(longitude, latitude, 4326), 25833), ST_GeomFromWKT(geometry_wkt_25833, 25833))"))
            .groupBy("station_id")
            .agg(F.min_by(F.struct("road_segment_id", "distance_m"), "distance_m").alias("best"))
            .select("station_id", "best.road_segment_id", "best.distance_m"))


@dp.materialized_view(
    name=f"{CATALOG}.silver.station_segment_lookup",
    comment="One row per station: nearest NVDB segment within 500 m. Recomputed on every pipeline update.",
)
def station_segment_lookup():
    return (spark.read.table("station_candidates")
            .where(F.col("distance_m") <= MAX_DISTANCE_M)
            .select("station_id", "road_segment_id", "distance_m",
                    F.lit("h3_kring2_st_distance_25833").alias("method"),
                    F.current_timestamp().alias("computed_at")))


@dp.materialized_view(
    name=f"{CATALOG}.silver.segment_station_coverage",
    comment="Segments on a station's own road within 5 km of it; the nearer station wins. Map and gritting list only.",
)
def segment_station_coverage():
    seg = spark.read.table(f"{CATALOG}.silver.road_segments").select(
        "road_segment_id", "road_category", "road_number", "geometry_wkt_25833", "h3_cells")
    home_road = (spark.read.table(f"{CATALOG}.silver.station_segment_lookup")
                 .join(seg, "road_segment_id").select("station_id", "road_category", "road_number"))
    st = (spark.read.table(f"{CATALOG}.silver.road_weather_stations").join(home_road, "station_id")
          .select("station_id", "road_category", "road_number", "latitude", "longitude",
                  F.explode(F.expr(f"h3_kring(h3_longlatash3(longitude, latitude, {COVER_RES}), 4)")).alias("cell")))
    seg_cells = seg.select(
        "road_segment_id", "road_category", "road_number", "geometry_wkt_25833",
        F.explode(F.expr(f"array_distinct(transform(h3_cells, c -> h3_toparent(c, {COVER_RES})))")).alias("cell"))
    pairs = (st.join(seg_cells, ["cell", "road_category", "road_number"])
             .dropDuplicates(["station_id", "road_segment_id"])
             .withColumn("distance_m", F.expr(
                 "ST_Distance(ST_Transform(ST_Point(longitude, latitude, 4326), 25833), ST_GeomFromWKT(geometry_wkt_25833, 25833))"))
             .where(F.col("distance_m") <= COVERAGE_M))
    return (pairs.groupBy("road_segment_id")
            .agg(F.min_by(F.struct("station_id", "distance_m"), "distance_m").alias("best"))
            .select("road_segment_id", "best.station_id", "best.distance_m",
                    F.lit(f"same_road_within_{COVERAGE_M}m").alias("method"),
                    F.current_timestamp().alias("computed_at")))


@dp.materialized_view(name=f"{CATALOG}.quarantine.unmapped_observations",
                      comment="Stations with no segment within 500 m, and incidents with no segment. Six-column quarantine shape.")
def unmapped_observations():
    st = spark.read.table(f"{CATALOG}.silver.road_weather_stations")
    cand = spark.read.table("station_candidates")
    stations = (st.join(cand, "station_id", "left")
                .where(F.col("distance_m").isNull() | (F.col("distance_m") > MAX_DISTANCE_M))
                .select(F.to_json(F.struct("station_id", "name", "latitude", "longitude")).alias("original_row"),
                        F.lit("road_weather_stations").alias("source"),
                        F.current_timestamp().alias("quarantined_at"),
                        F.lit("XS002").alias("rule"),
                        F.coalesce(F.concat(F.lit("nearest segment at "), F.round("distance_m", 0), F.lit(" m")),
                                   F.lit("no candidate segment in k-ring")).alias("reason"),
                        F.lit(RUN_ID).alias("pipeline_run_id")))
    inc = (spark.read.table(f"{CATALOG}.silver.road_incidents").where("road_segment_id IS NULL")
           .select(F.to_json(F.struct("incident_id", "road_ref", "latitude", "longitude")).alias("original_row"),
                   F.lit("road_incidents").alias("source"), F.current_timestamp().alias("quarantined_at"),
                   F.lit("XS002").alias("rule"),
                   F.lit("no segment on the same road within 500 m").alias("reason"),
                   F.lit(RUN_ID).alias("pipeline_run_id")))
    return stations.unionByName(inc).select(*QUARANTINE_COLS)
```

     `XS002` is the rule id for "no road segment" in `dq_rules.yml`; the same id is a `warn` expectation on
     the observations table (T4.4), so the health page can show both the station-level cause (this table)
     and the row-level effect (event log).

  2. SQL equivalent of the H3 join, for the SQL editor when debugging (same logic):

```sql
WITH st AS (
  SELECT station_id, latitude, longitude, explode(h3_kring(h3_longlatash3(longitude, latitude, 9), 2)) AS h3_cell
  FROM frostsight.silver.road_weather_stations),
seg AS (
  SELECT road_segment_id, geometry_wkt_25833, explode(h3_cells) AS h3_cell FROM frostsight.silver.road_segments)
SELECT station_id, min_by(road_segment_id, d) AS road_segment_id, min(d) AS distance_m
FROM (SELECT st.station_id, seg.road_segment_id,
             ST_Distance(ST_Transform(ST_Point(longitude, latitude, 4326), 25833), ST_GeomFromWKT(geometry_wkt_25833, 25833)) AS d
      FROM st JOIN seg USING (h3_cell))
GROUP BY station_id;
```

  3. Fallback if ST functions are not available on the runtime: replace the `ST_Distance(...)` expression
     with the pandas UDF `frostsight.geo.udf_point_to_line_m` (T4.6 step 1, uses shapely and pyproj) and add
     `shapely>=2`, `pyproj>=3.6` to the pipeline `environment.dependencies` (T4.7). The H3 part is unchanged.

Expect: `SELECT count(*) FROM frostsight.silver.station_segment_lookup` = 30 (Troms); `max(distance_m)` under
100 m for most stations; `quarantine.unmapped_observations WHERE source = 'road_weather_stations'` empty.
`silver.segment_station_coverage` has a few thousand rows. Every station appears in it, its own lookup segment is
covered by that station, and `max(distance_m)` is at most 5000. The covered share of road length, for ADR 0006:
`SELECT round(100 * sum(CASE WHEN c.station_id IS NOT NULL THEN s.length_m END) / sum(s.length_m), 1) FROM
frostsight.silver.road_segments s LEFT JOIN frostsight.silver.segment_station_coverage c USING (road_segment_id)
WHERE s.road_category IN ('E', 'R', 'F')`.
If it fails: `h3_cells` on segments was built at another resolution than 9; a station sits on a road that
NVDB classifies outside the extract (private road), then the k-ring finds nothing.

### T4.6 Reference loader job      owner: Rayhan
Why: silver.road_segments and silver.road_weather_stations are the spine of the model; they come from NVDB
files that the collector landed at M1 and refreshes weekly.
Do:
  1. Create `src/frostsight/geo.py` (pure Python, runs on the driver or in pandas UDFs):

```python
"""Coordinate transforms and H3 helpers. Needs pyproj, shapely, h3, pandas (job environment, dev extras)."""
from __future__ import annotations

from functools import lru_cache

import h3
import pandas as pd
from pyspark.sql import functions as F
from pyspark.sql.types import ArrayType, DoubleType, LongType, StringType
from shapely import wkt as shapely_wkt
from shapely.geometry import Point
from shapely.ops import transform


@lru_cache(maxsize=1)
def _to_wgs84():
    from pyproj import Transformer
    return Transformer.from_crs("EPSG:25833", "EPSG:4326", always_xy=True).transform


@lru_cache(maxsize=1)
def _to_utm():
    from pyproj import Transformer
    return Transformer.from_crs("EPSG:4326", "EPSG:25833", always_xy=True).transform


def wkt_25833_to_4326(wkt: str | None) -> str | None:
    """LINESTRING Z / POINT Z in UTM 33N -> 2D WKT in WGS84 (lon lat order). Returning two values drops Z."""
    if not wkt:
        return None
    geom = shapely_wkt.loads(wkt)
    return transform(lambda x, y, z=None: _to_wgs84()(x, y), geom).wkt


def mean_z(wkt: str | None) -> float | None:
    """Mean height of the vertices; NVDB heights are NN2000 metres (srid 5973)."""
    if not wkt:
        return None
    geom = shapely_wkt.loads(wkt)
    if not geom.has_z:
        return None
    zs = [c[2] for c in geom.coords] if geom.geom_type != "MultiLineString" else [c[2] for g in geom.geoms for c in g.coords]
    return sum(zs) / len(zs) if zs else None


def centroid_4326(wkt_4326: str | None) -> tuple[float, float] | None:
    """(lon, lat) of the centroid of a WGS84 geometry; the map widget needs one point per segment."""
    if not wkt_4326:
        return None
    c = shapely_wkt.loads(wkt_4326).centroid
    return (float(c.x), float(c.y))


def line_cells(wkt_4326: str | None, res: int = 9, step_m: float = 50.0) -> list[int]:
    """H3 cells touched by a line: sample points every step_m along it (fallback for h3_coverash3)."""
    if not wkt_4326:
        return []
    geom = shapely_wkt.loads(wkt_4326)
    lines = geom.geoms if geom.geom_type == "MultiLineString" else [geom]
    cells: set[int] = set()
    for line in lines:
        n = max(2, int(line.length / (step_m / 111_000)) + 1)     # degrees per metre at high latitude is coarse but safe
        for i in range(n + 1):
            p = line.interpolate(i / n, normalized=True)
            cells.add(h3.str_to_int(h3.latlng_to_cell(p.y, p.x, res)))
    return sorted(cells)


def point_to_line_distance_m(lon: float, lat: float, line_wkt_25833: str) -> float:
    x, y = _to_utm()(lon, lat)
    return float(Point(x, y).distance(shapely_wkt.loads(line_wkt_25833)))


# pandas UDF wrappers for Spark
@F.pandas_udf(StringType())
def udf_wkt_to_4326(s: pd.Series) -> pd.Series:
    return s.map(wkt_25833_to_4326)


@F.pandas_udf(DoubleType())
def udf_mean_z(s: pd.Series) -> pd.Series:
    return s.map(mean_z)


@F.pandas_udf(DoubleType())
def udf_centroid_lon(s: pd.Series) -> pd.Series:
    return s.map(lambda w: (centroid_4326(w) or (None, None))[0])


@F.pandas_udf(DoubleType())
def udf_centroid_lat(s: pd.Series) -> pd.Series:
    return s.map(lambda w: (centroid_4326(w) or (None, None))[1])


@F.pandas_udf(ArrayType(LongType()))
def udf_line_cells(s: pd.Series) -> pd.Series:
    return s.map(lambda w: line_cells(w, 9))


@F.pandas_udf(DoubleType())
def udf_point_to_line_m(lon: pd.Series, lat: pd.Series, wkt: pd.Series) -> pd.Series:
    return pd.Series([point_to_line_distance_m(a, b, c) for a, b, c in zip(lon, lat, wkt)])
```

  2. Create `src/jobs/load_reference.py`. NVDB properties are read by **id** (stable), never by
     Norwegian name: 153 stations `3591` Målestasjonsnummer, `1083` Navn, `11179` Status; 105 speed limits
     `2021` Fartsgrense; 570 accidents `5055` Ulykkesdato, `5056` Ulykkesklokkeslett, `5074`
     Alvorlighetsgrad, `5078` Føreforhold, `5079` Værforhold; 445 slides `2324` Skred dato, `2325` Skred
     klokkeslett, `2326` Type skred, `2344` Stengning (02_M1 T1.7 contract).

```python
"""reference job: NVDB and other reference files from the landing volume -> bronze -> silver. Idempotent (MERGE).
Applies the batch rules ST001, ST002, SG001, SG002 from config/dq_rules.yml."""
from __future__ import annotations

import argparse

from delta.tables import DeltaTable
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F

from frostsight.config import rules_by_action
from frostsight.geo import udf_centroid_lat, udf_centroid_lon, udf_line_cells, udf_mean_z, udf_wkt_to_4326

spark = SparkSession.builder.getOrCreate()
QUARANTINE_COLS = ["original_row", "source", "quarantined_at", "rule", "reason", "pipeline_run_id"]

# landing folder -> (bronze table, natural key column in the landed JSON). README section 4 source names.
BRONZE_SOURCES = {
    "nvdb_road_network": ("bronze.road_network", "id"),
    "nvdb_stations": ("bronze.road_weather_stations_raw", "id"),
    "nvdb_speed_limits": ("bronze.speed_limits", "id"),
    "nvdb_accidents": ("bronze.accidents", "id"),
    "nvdb_avalanche": ("bronze.avalanche_landslide_events", "id"),
    "nvdb_counties": ("bronze.admin_boundaries_raw", "nummer"),
    "elevation": ("bronze.elevation", "station_id"),
    "source_metadata": ("bronze.source_metadata", "source"),
}


def merge_upsert(df: DataFrame, table: str, keys: list[str], cluster_by: list[str] | None = None) -> None:
    """Create the table on first run, then MERGE on the natural key. Re-running with the same input changes nothing."""
    if not spark.catalog.tableExists(table):
        writer = df.write.format("delta")
        if cluster_by:
            writer = writer.clusterBy(*cluster_by)
        writer.saveAsTable(table)
        return
    cond = " AND ".join(f"t.{k} <=> s.{k}" for k in keys)
    (DeltaTable.forName(spark, table).alias("t")
     .merge(df.alias("s"), cond)
     .whenMatchedUpdateAll()
     .whenNotMatchedInsertAll()
     .execute())


def apply_batch_rules(df: DataFrame, table: str, catalog: str, run_id: str, config_dir: str | None) -> DataFrame:
    """drop rules -> quarantine.invalid_<table>; warn rules -> printed count; fail rules -> exception."""
    short = table.split(".")[-1]
    for rule_id, expr in rules_by_action(table, "fail", config_dir).items():
        bad = df.where(~F.coalesce(F.expr(expr), F.lit(False))).count()
        if bad:
            raise RuntimeError(f"{rule_id} failed for {bad} rows of {table}: {expr}")
    for rule_id, expr in rules_by_action(table, "warn", config_dir).items():
        print(f"{rule_id} warn: {df.where(~F.coalesce(F.expr(expr), F.lit(False))).count()} rows of {table}")
    drop = rules_by_action(table, "drop", config_dir)
    if not drop:
        return df
    flags = F.array_compact(F.array(*[F.when(~F.coalesce(F.expr(e), F.lit(False)), F.lit(r)) for r, e in drop.items()]))
    flagged = df.withColumn("_failed_rules", flags)
    q = (flagged.where(F.size("_failed_rules") > 0)
         .select(F.to_json(F.struct(*df.columns)).alias("original_row"), F.lit(short).alias("source"),
                 F.current_timestamp().alias("quarantined_at"), F.explode("_failed_rules").alias("rule"))
         .withColumn("reason", F.concat(F.lit("failed "), F.col("rule")))
         .withColumn("pipeline_run_id", F.lit(run_id)).select(*QUARANTINE_COLS))
    q.write.format("delta").mode("append").saveAsTable(f"{catalog}.quarantine.invalid_{short}")
    return flagged.where(F.size("_failed_rules") == 0).drop("_failed_rules")


def bronze_metadata(df: DataFrame, source: str) -> DataFrame:
    return df.select(
        "*",
        F.current_timestamp().alias("_ingested_at"), F.lit(source).alias("_source"),
        F.col("_metadata.file_path").alias("_source_file"),
        F.col("id").cast("string").alias("_source_event_id"),
        F.regexp_extract(F.col("_metadata.file_path"), r"([^/]+)\.[A-Za-z0-9]+$", 1).alias("_batch_id"),
        F.lit("1").alias("_schema_version"))


def read_landed(landing: str, source: str, day_from: str = "", day_to: str = "") -> DataFrame:
    """Reads the JSON-lines files under raw/<source>/<yyyy>/<mm>/<dd>/. Default: only the newest extract day.
    With --from/--to (YYYY-MM-DD): every extract day in the range, newest row per key wins in MERGE."""
    df = (spark.read.format("json").option("multiLine", "false")
          .option("recursiveFileLookup", "true").option("pathGlobFilter", "*.jsonl")   # date folders; _failed/*.json excluded
          .load(f"{landing}/{source}/"))
    df = df.withColumn("_extract_day", F.regexp_replace(
        F.regexp_extract(F.col("_metadata.file_path"), r"/(\d{4}/\d{2}/\d{2})/", 1), "/", "-"))
    if day_from or day_to:
        lo, hi = day_from or "0000-01-01", day_to or "9999-12-31"
        return df.where(F.col("_extract_day").between(lo, hi)).drop("_extract_day")
    latest = df.agg(F.max("_extract_day")).first()[0]
    return df.where(F.col("_extract_day") == latest).drop("_extract_day")


def load_bronze(catalog: str, landing: str, day_from: str, day_to: str) -> None:
    for folder, (table, key) in BRONZE_SOURCES.items():
        try:
            df = read_landed(landing, folder, day_from, day_to)
        except Exception as e:                       # a source that has never landed (elevation on a fresh workspace)
            print(f"skip {folder}: {e}")
            continue
        if key != "id":
            df = df.withColumn("id", F.col(key))
        merge_upsert(bronze_metadata(df, folder), f"{catalog}.{table}", ["_source_event_id"])


def prop(prop_id: int):
    """NVDB objects carry properties as an array of {id, navn, verdi, ...}. Pull one by id."""
    return F.expr(f"filter(egenskaper, e -> e.id = {prop_id})[0].verdi")


def build_road_segments(catalog: str, run_id: str, config_dir: str | None) -> None:
    # verify: NVDB v4 field names against tests/fixtures/nvdb_road_network_sample.json (02_M1 T1.7 lists them)
    raw = spark.read.table(f"{catalog}.bronze.road_network")
    seg = raw.select(
        F.coalesce(F.col("referanse"),
                   F.concat_ws("-", F.col("veglenkesekvensid"), F.col("veglenkenummer"), F.col("segmentnummer"))).alias("road_segment_id"),
        F.col("veglenkesekvensid").cast("long"),
        F.col("segmentnummer").cast("int").alias("segment_no"),
        F.col("vegsystemreferanse.vegsystem.vegkategori").alias("road_category"),
        F.col("vegsystemreferanse.vegsystem.nummer").cast("string").alias("road_number"),
        F.col("vegsystemreferanse.strekning.fra_meter").cast("double").alias("from_m"),   # verify: present in v4 segmentert output
        F.col("vegsystemreferanse.strekning.til_meter").cast("double").alias("to_m"),
        F.col("lengde").cast("double").alias("length_m"),
        F.col("geometri.wkt").alias("geometry_wkt_25833"),
        F.col("fylke").cast("int").alias("county"),
    )
    seg = (seg.withColumn("geometry_wkt_4326", udf_wkt_to_4326("geometry_wkt_25833"))
              .withColumn("elevation_m", udf_mean_z("geometry_wkt_25833"))
              .withColumn("centroid_lat", udf_centroid_lat("geometry_wkt_4326"))     # the map widget reads these (M6)
              .withColumn("centroid_lon", udf_centroid_lon("geometry_wkt_4326")))
    # H3 cells along the line. Primary: built-in h3_coverash3 on the WGS84 line. Fallback: sampled points UDF.
    try:
        spark.sql("SELECT h3_coverash3('LINESTRING(18.9 69.6, 18.91 69.61)', 9)").collect()
        seg = seg.withColumn("h3_cells", F.expr("h3_coverash3(geometry_wkt_4326, 9)"))
    except Exception:
        seg = seg.withColumn("h3_cells", udf_line_cells("geometry_wkt_4326"))
    # Speed limits (object type 105): highest limit on the link sequence. v0 ignores position overlap; null when absent.
    if spark.catalog.tableExists(f"{catalog}.bronze.speed_limits"):
        sl = (spark.read.table(f"{catalog}.bronze.speed_limits")
              .select(F.explode("lokasjon.stedfestinger").alias("st"), prop(2021).cast("int").alias("speed_limit"))
              .select(F.col("st.veglenkesekvensid").cast("long").alias("veglenkesekvensid"), "speed_limit")
              .groupBy("veglenkesekvensid").agg(F.max("speed_limit").alias("speed_limit")))
        seg = seg.join(sl, "veglenkesekvensid", "left")
    else:
        seg = seg.withColumn("speed_limit", F.lit(None).cast("int"))
    seg = apply_batch_rules(seg.dropDuplicates(["road_segment_id"]), "silver.road_segments", catalog, run_id, config_dir)
    merge_upsert(seg, f"{catalog}.silver.road_segments", ["road_segment_id"], cluster_by=["road_segment_id"])


def _external_points(landing: str, folder: str, id_col: str) -> DataFrame:
    """Flat JSON lines {<id_col>, name, lat, lon} written by the collector (02_M1 T1.7 contract).
    verify: if the file is the raw Frost JSON-LD instead, use explode(data) and geometry.coordinates[0]/[1]."""
    return read_landed(landing, folder).select(F.col(id_col).cast("string").alias("ext_id"),
                                               F.col("lat").cast("double").alias("elat"),
                                               F.col("lon").cast("double").alias("elon"))


def build_stations(catalog: str, landing: str, run_id: str, config_dir: str | None) -> None:
    raw = spark.read.table(f"{catalog}.bronze.road_weather_stations_raw")
    st = raw.select(
        prop(3591).cast("string").alias("station_id"),
        prop(1083).alias("name"),
        prop(11179).alias("status"),                       # keep 'Operativ' rows; others are listed, not used
        F.col("id").cast("long").alias("nvdb_object_id"),
        F.col("geometri.wkt").alias("wkt_25833"),
        F.col("fylke").cast("int").alias("county"),         # verify: top-level fylke on 153 objects, else lokasjon.fylker[0]
    )
    st = (st.withColumn("wkt_4326", udf_wkt_to_4326("wkt_25833"))
            .withColumn("longitude", F.regexp_extract("wkt_4326", r"POINT \(([-\d.]+) ([-\d.]+)\)", 1).cast("double"))
            .withColumn("latitude", F.regexp_extract("wkt_4326", r"POINT \(([-\d.]+) ([-\d.]+)\)", 2).cast("double"))
            .withColumn("elevation_m", udf_mean_z("wkt_25833"))
            .drop("wkt_25833", "wkt_4326"))
    if spark.catalog.tableExists(f"{catalog}.bronze.elevation"):   # Open-Meteo fallback when the NVDB point has no Z
        el = spark.read.table(f"{catalog}.bronze.elevation").select(
            F.col("station_id").cast("string").alias("station_id"), F.col("elevation_m").alias("el_m"))
        st = st.join(el, "station_id", "left").withColumn("elevation_m", F.coalesce("elevation_m", "el_m")).drop("el_m")
    # External ids by nearest point within 300 m (DATEX site table, Frost sources).
    for folder, id_col, out_col in (("datex_sites", "site_id", "datex_site_id"), ("frost_sources", "source_id", "frost_source_id")):
        try:
            ext = _external_points(landing, folder, id_col)
        except Exception:
            st = st.withColumn(out_col, F.lit(None).cast("string"))
            continue
        d = (st.crossJoin(ext)
               .withColumn("d_m", F.expr("2*6371000*asin(sqrt(pow(sin(radians(elat-latitude)/2),2)+cos(radians(latitude))*cos(radians(elat))*pow(sin(radians(elon-longitude)/2),2)))"))
               .where("d_m <= 300")
               .groupBy("station_id").agg(F.min_by("ext_id", "d_m").alias(out_col)))
        st = st.join(d, "station_id", "left")
    st = apply_batch_rules(st, "silver.road_weather_stations", catalog, run_id, config_dir)   # ST002 raises on a null station_id
    merge_upsert(st, f"{catalog}.silver.road_weather_stations", ["station_id"])


def _oslo_to_utc(date_col, time_col):
    """NVDB dates are local (Europe/Oslo); times are 'HH:mm' (570) or int hhmm (445)."""
    hhmm = F.lpad(F.regexp_replace(time_col.cast("string"), ":", ""), 4, "0")
    local = F.concat(date_col.cast("string"), F.lit(" "), F.substring(hhmm, 1, 2), F.lit(":"), F.substring(hhmm, 3, 2))
    return F.to_utc_timestamp(F.to_timestamp(local, "yyyy-MM-dd HH:mm"), "Europe/Oslo")


def build_events(catalog: str) -> None:
    acc = spark.read.table(f"{catalog}.bronze.accidents").select(
        F.col("id").cast("long").alias("accident_id"),
        F.to_date(prop(5055)).alias("accident_date"),
        _oslo_to_utc(prop(5055), prop(5056)).alias("event_time"),
        prop(5074).alias("severity"),
        prop(5078).alias("road_condition"), prop(5079).alias("weather_condition"),
        F.col("geometri.wkt").alias("wkt_25833"))
    acc = acc.withColumn("wkt_4326", udf_wkt_to_4326("wkt_25833"))
    merge_upsert(acc, f"{catalog}.silver.accidents", ["accident_id"])
    ava = spark.read.table(f"{catalog}.bronze.avalanche_landslide_events").select(
        F.col("id").cast("long").alias("event_id"),
        F.to_date(prop(2324)).alias("event_date"),
        _oslo_to_utc(prop(2324), prop(2325)).alias("event_time"),
        prop(2326).alias("event_type"), prop(2344).alias("road_closure"),
        F.col("geometri.wkt").alias("wkt_25833"))
    ava = ava.withColumn("wkt_4326", udf_wkt_to_4326("wkt_25833"))
    merge_upsert(ava, f"{catalog}.silver.avalanche_landslide_events", ["event_id"])
    adm = spark.read.table(f"{catalog}.bronze.admin_boundaries_raw").select(
        F.col("nummer").cast("int").alias("county"), F.col("navn").alias("county_name"))
    merge_upsert(adm, f"{catalog}.silver.admin_boundaries", ["county"])


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--catalog", required=True)
    p.add_argument("--landing", required=True)        # /Volumes/frostsight/landing/raw
    p.add_argument("--config-dir", default=None)      # folder holding dq_rules.yml; None = repo layout / env var
    p.add_argument("--from", dest="day_from", default="")   # backfill range, YYYY-MM-DD, empty = newest extract only
    p.add_argument("--to", dest="day_to", default="")
    a = p.parse_args()
    run_id = spark.conf.get("spark.databricks.job.runId", "manual")   # verify: key name; any stable string per run is fine
    load_bronze(a.catalog, a.landing, a.day_from, a.day_to)
    build_road_segments(a.catalog, run_id, a.config_dir)
    build_stations(a.catalog, a.landing, run_id, a.config_dir)
    build_events(a.catalog)
    print("reference load done")


if __name__ == "__main__":
    main()
```

  3. verify: `h3_coverash3` accepts a LINESTRING WKT (the DBSQL reference documents it as covering a
     geography given as WKT, WKB or GeoJSON). The `try` block above switches to the sampled-point UDF
     automatically, so a wrong guess costs nothing but a slower job. Do not use `h3_polyfillash3` for
     lines: it is polygon-only.
  4. verify: the NVDB v4 JSON field names (`referanse`, `veglenkesekvensid`, `veglenkenummer`,
     `segmentnummer`, `vegsystemreferanse.vegsystem.vegkategori`, `.nummer`, `strekning.fra_meter`, `lengde`,
     `geometri.wkt`, `fylke`, `lokasjon.stedfestinger[].veglenkesekvensid`) against
     `tests/fixtures/nvdb_road_network_sample.json` and the contract in `docs/contracts/landing.md`. The
     collector lands geometry with `srid: 5973` (UTM 33 + NN2000 heights); the horizontal part is
     EPSG:25833, so `wkt_25833_to_4326` is correct on it and `mean_z` gives metres above sea level.
  5. Column contract of `silver.road_segments` (M6 queries these): `road_segment_id, veglenkesekvensid,
     segment_no, road_category, road_number, from_m, to_m, length_m, geometry_wkt_25833, geometry_wkt_4326,
     elevation_m, centroid_lat, centroid_lon, h3_cells, speed_limit, county`. `silver.road_weather_stations`:
     `station_id, name, status, nvdb_object_id, county, longitude, latitude, elevation_m, datex_site_id,
     frost_source_id`.

Expect: `databricks bundle run reference -t personal --profile frostsight-personal` finishes in under 10 minutes;
`SELECT count(*) FROM frostsight.silver.road_segments` is about 20,000 for Troms;
`SELECT count(*) FROM frostsight.silver.road_weather_stations` = 30; `centroid_lat` between 68 and 71 and
`centroid_lon` between 15 and 22 for every row; running the job twice leaves counts unchanged and
`DESCRIBE HISTORY frostsight.silver.road_segments` shows a MERGE with 0 inserted rows on the second run.
If it fails: `ModuleNotFoundError: pyproj` (the `environments` block in T4.7 is missing or the task lacks
`environment_key`); `egenskaper` is not an array in the fixture (NVDB returns it only when the collector asked
for `inkluder=egenskaper,geometri,lokasjon`); `RuntimeError: ST002 failed` (a station object without
`Målestasjonsnummer`: fix the collector filter, the rule is `fail` on purpose); `MERGE` fails on duplicate
source keys (two rows with the same `station_id` in one extract: open an issue on the collector).

### T4.7 Bundle resources: pipeline and jobs      owner: Rayhan
Why: everything deploys from YAML with `databricks bundle deploy`; nothing is created by hand in the UI.
Do:
  1. `databricks.yml` exists from M2 (T2.2). Bring it to the README's authoritative table
     (section 2, "Bundle variables and targets"); the parts this milestone relies on:

```yaml
bundle:
  name: frostsight

include:
  - resources/*.yml

variables:
  catalog:               { default: frostsight }
  landing_root:          { default: /Volumes/frostsight/landing/raw }
  pilot_county:          { default: "55" }
  warehouse_name:        { default: "Serverless Starter Warehouse" }   # verify: databricks warehouses list
  warehouse_id:
    lookup: { warehouse: "${var.warehouse_name}" }                      # verify: variable interpolation inside lookup; else paste the name
  schedule_pause_status: { default: UNPAUSED }         # the job schedule field takes this enum, not a boolean
  pipeline_continuous:   { default: false }
  pipeline_development:  { default: true }
  notification_email:    { default: safiul.kabir@cefalo.no }
  config_dir:            { default: "${workspace.file_path}/config" }  # the bundle syncs config here

artifacts:
  frostsight:
    type: whl
    path: .
    build: uv build --wheel

targets:
  free:
    default: true
    mode: development
    workspace: { profile: frostsight-free }
    presets: { name_prefix: "", trigger_pause_status: UNPAUSED }   # stable names, schedules run
  personal:
    mode: development                                                # keeps the [dev <user>] prefix and paused schedules
    workspace: { profile: frostsight-personal }
    variables: { schedule_pause_status: PAUSED }
  aws:
    mode: development
    workspace: { profile: frostsight-aws }
    presets: { name_prefix: "", trigger_pause_status: UNPAUSED }
    variables: { pipeline_development: false }
    # resources.jobs.collector is declared here, inline (03_M2 T2.2)
```

     No `catalog.schema.yml`: catalog, schemas, volume and grants come from
     `sql/001_catalog_schemas_volume.sql`, run once per workspace (README rule 5).
     verify: the `artifacts` block shape (`type: whl`, `build`, `path`) with `databricks bundle schema | jq .properties.artifacts`
     and one `databricks bundle deploy -t personal` that prints `Uploading frostsight-0.1.0-py3-none-any.whl`.
     The wheel is what the job `environments` install as `../dist/*.whl`.

  2. Replace `resources/ingest.pipeline.yml`:

```yaml
resources:
  pipelines:
    ingest:
      name: frostsight-ingest
      catalog: ${var.catalog}
      schema: bronze                      # default schema; silver and quarantine tables use three-part names
      serverless: true
      continuous: ${var.pipeline_continuous}
      development: ${var.pipeline_development}
      channel: CURRENT
      root_path: ../src                   # puts src/ on the import path so `import frostsight` resolves (verify: see note)
      libraries:
        - glob:
            include: ../src/pipelines/**
      configuration:
        frostsight.catalog: ${var.catalog}
        frostsight.landing_root: ${var.landing_root}
        frostsight.config_dir: ${var.config_dir}
        spark.sql.session.timeZone: UTC
        spark.sql.shuffle.partitions: auto
      environment:
        dependencies:
          - pyyaml>=6
      event_log:
        catalog: ${var.catalog}
        schema: gold
        name: ingest_event_log            # the published event log; M6 and M7 read frostsight.gold.ingest_event_log
      notifications:
        - email_recipients: [ "${var.notification_email}" ]
          alerts: [ on-update-failure, on-update-fatal-failure, on-flow-failure ]
      permissions:
        - level: CAN_VIEW
          group_name: users
      tags:
        project: frostsight
```

     Serverless, no cluster block, no `photon` key (not a serverless setting). Pipeline permission levels
     are `CAN_VIEW`, `CAN_RUN`, `CAN_MANAGE`.
     verify: the `event_log: {catalog, schema, name}` key is accepted by the bundle schema for pipelines
     (`databricks bundle schema | jq '.. | .event_log? // empty' | head`); if not, drop it and query
     `event_log(TABLE(frostsight.silver.road_weather_observations))` instead.
     verify: that `root_path: ../src` makes `import frostsight` resolve in the pipeline's Python files (the
     DABs reference pairs `root_path` with `libraries.glob` for exactly this). If it does not, the
     alternative is `- --editable ${workspace.file_path}` under `environment.dependencies`, which installs
     the package from `pyproject.toml`; if that fails too, add `../dist/*.whl` there (the wheel the
     `artifacts` block builds).

  3. Replace `resources/reference.job.yml`:

```yaml
resources:
  jobs:
    reference:
      name: frostsight-reference
      max_concurrent_runs: 1
      timeout_seconds: 3600
      schedule:
        quartz_cron_expression: "0 0 3 ? * MON"     # weekly, Monday 03:00 UTC
        timezone_id: UTC
        pause_status: ${var.schedule_pause_status}
      email_notifications:
        on_failure: [ "${var.notification_email}" ]
      parameters:                                   # backfill range, empty = newest extract only (M7 T7.2)
        - { name: from, default: "" }
        - { name: to, default: "" }
      environments:
        - environment_key: geo
          spec:
            client: "4"                             # required: the serverless base environment version
            dependencies:
              - ../dist/*.whl          # the frostsight package built by `artifacts`
              - pyproj>=3.6
              - shapely>=2
              - h3>=4
      tasks:
        - task_key: load_reference
          environment_key: geo
          spark_python_task:
            python_file: ../src/jobs/load_reference.py
            parameters: [ "--catalog", "${var.catalog}", "--landing", "${var.landing_root}",
                          "--config-dir", "${var.config_dir}",
                          "--from", "{{job.parameters.from}}", "--to", "{{job.parameters.to}}" ]
```

  4. Replace `resources/orchestrate.job.yml` (version 1; M5 adds the gold and freshness tasks):

```yaml
resources:
  jobs:
    orchestrate:
      name: frostsight-orchestrate
      max_concurrent_runs: 1              # a slow update never overlaps the next one
      timeout_seconds: 1200
      schedule:
        quartz_cron_expression: "0 0/10 * * * ?"
        timezone_id: UTC
        pause_status: ${var.schedule_pause_status}
      email_notifications:
        on_failure: [ "${var.notification_email}" ]
        no_alert_for_skipped_runs: true
      tasks:
        - task_key: pipeline_update
          pipeline_task:
            pipeline_id: ${resources.pipelines.ingest.id}
            full_refresh: false
```

  5. `databricks bundle validate -t personal --strict --profile frostsight-personal`. Fix every warning
     before deploying.

Expect: `validate` prints the three resources with no errors. On `personal`, `mode: development` prefixes
names with `[dev <you>]` and pauses schedules; on `free`, the presets keep the names as written and the
schedule runs.
If it fails: `environments[].spec.client` missing (the API rejects the job); `../dist/*.whl` not found (run
`uv build --wheel` once locally, then the bundle build does it on every deploy); `${resources.pipelines.ingest.id}`
unresolved because the pipeline file is not included by `include: [resources/*.yml]`; `${var.config_dir}`
printed literally (the variable is not declared in `databricks.yml`).

### T4.8 Deploy, run, and test recovery      owner: Shawon, Sani
Why: the pipeline has to survive a stop, a duplicate file and a late file before anyone builds on it.
Do:
  1. Personal first, then the team workspace:

```bash
cd project
databricks bundle deploy -t personal --profile frostsight-personal
databricks bundle run reference -t personal --profile frostsight-personal   # silver.road_segments and stations first
databricks bundle run ingest -t personal --profile frostsight-personal      # first update: includeExistingFiles reads everything landed
# then on the team workspace, from main only (normally CI does this, 03_M2 T2.4):
databricks bundle deploy -t free --profile frostsight-free
databricks bundle run reference -t free --profile frostsight-free
databricks bundle run ingest -t free --profile frostsight-free
```

  2. Read the expectation counts from the event log (SQL editor, 2X-Small warehouse):

```sql
-- The published event log from ingest.pipeline.yml. Alternative without it: FROM event_log(TABLE(frostsight.silver.road_weather_observations)) e
SELECT e.timestamp,
       e.details:flow_progress.metrics.num_output_rows::int AS rows_out,
       x.name AS rule, x.passed_records, x.failed_records
FROM frostsight.gold.ingest_event_log e
LATERAL VIEW explode(from_json(e.details:flow_progress.data_quality.expectations,
             'array<struct<name:string,dataset:string,passed_records:bigint,failed_records:bigint>>')) AS x
WHERE e.event_type = 'flow_progress' AND e.origin.flow_name RLIKE 'road_weather_(live|replay)$'
ORDER BY e.timestamp DESC LIMIT 50;
```

     The silver table is fed by the two flows `road_weather_live` and `road_weather_replay` (T4.4), so the
     filter names them. A looser `LIKE '%road_weather_%'` also matches `road_weather_events` (bronze) and
     `invalid_road_weather_live/_replay` (quarantine), which have no expectations but do have row counts.

     Or open the pipeline in the UI, click the silver table, tab "Data quality".
  3. Checkpoint recovery: start an update, stop it mid-way, restart, and prove nothing was lost or doubled.

```bash
PIPELINE_ID=$(databricks bundle summary -t personal --output json --profile frostsight-personal | jq -r '.resources.pipelines.ingest.id')
databricks pipelines start-update $PIPELINE_ID --profile frostsight-personal
sleep 20 && databricks pipelines stop $PIPELINE_ID --profile frostsight-personal
databricks bundle run ingest -t personal --profile frostsight-personal
```

```sql
SELECT count(*) AS bronze_rows, count(DISTINCT _source_file) AS files FROM frostsight.bronze.road_weather_events;
-- compare with the number of files: databricks fs ls -r dbfs:/Volumes/frostsight/landing/raw/road_weather --profile frostsight-personal | grep -c '\.jsonl$'
SELECT count(*) - count(DISTINCT station_id, event_time) AS duplicate_keys FROM frostsight.silver.road_weather_observations;  -- 0
```

  4. Duplicate file: copy the newest landed file under a new name and run an update.

```bash
F=$(databricks fs ls -r dbfs:/Volumes/frostsight/landing/raw/road_weather --profile frostsight-personal | grep '\.jsonl$' | tail -1 | awk '{print $NF}')
databricks fs cp dbfs:$F dbfs:${F%.jsonl}_dup.jsonl --profile frostsight-personal
databricks bundle run ingest -t personal --profile frostsight-personal
```

     Expect: bronze grows by the file's line count; silver grows by 0; `event_log` shows the rows read.
  5. Late file, by hand (the replay harness writes whole storm days, not single shifted files): download
     the newest landed file, subtract 20 minutes from every `measurement_time`, upload it under a new name,
     run an update; then the same with 2 hours.

```bash
databricks fs cp dbfs:$F /tmp/late.jsonl --profile frostsight-personal
python3 - <<'PY'
import json, datetime as dt
rows = [json.loads(l) for l in open("/tmp/late.jsonl")]
for r in rows:
    t = dt.datetime.fromisoformat(r["measurement_time"].replace("Z", "+00:00")) - dt.timedelta(minutes=20)
    r["measurement_time"] = t.strftime("%Y-%m-%dT%H:%M:%SZ"); r["source_event_id"] += "-late20"
open("/tmp/late20.jsonl", "w").write("\n".join(json.dumps(r) for r in rows) + "\n")
PY
databricks fs cp /tmp/late20.jsonl dbfs:${F%/*}/$(date -u +%Y%m%dT%H%M%SZ).jsonl --profile frostsight-personal
databricks bundle run ingest -t personal --profile frostsight-personal
```

     Expect: the 20-minute file appears in silver (inside the 30-minute watermark); the 2-hour file does not
     (older than the live flow's watermark; the rows are dropped by the stateful operator and are not in the
     pipeline's quarantine table; `build_freshness` copies late arrivals from bronze into
     `quarantine.late_road_weather` under rule `RW008`, 07_M6 T6.2). The file is live-named, so it goes
     through `road_weather_live`; that is the flow this test is about. Write that down in the runbook at M7:
     live rows later than 30 minutes are lost to silver; history goes through replay files (replay flow, own
     watermark, event-time order) or a full refresh.
  6. Full refresh, once, to learn what it does: `databricks bundle run ingest -t personal --full-refresh-all --profile frostsight-personal`
     (selective: `--full-refresh <table,...>`; incremental re-run of one table: `--refresh <table>`).
     Never on `free` without telling the team; it drops the streaming state and rereads every landed file.

Expect: three green updates in a row on `free`, the `orchestrate` schedule starting updates every 10 minutes,
each finishing in 2 to 4 minutes on serverless.
If it fails: update stuck in `INITIALIZING` for minutes (normal cold start, wait); `RESOURCE_EXHAUSTED` on
Free Edition (another pipeline in the account is running: stop it, only one active pipeline is allowed);
`Cannot create streaming table from batch query` (a function used `spark.read` where a stream was needed);
`ModuleNotFoundError: frostsight` inside the pipeline (T4.7 step 2 note on `root_path`).

### T4.9 Unit tests for the pure functions      owner: Sani, Rayhan
Why: the transforms run inside the pipeline where debugging is slow; catch mistakes locally in seconds.
Do:
  1. `tests/unit/conftest.py`:

```python
import pytest
from pyspark.sql import SparkSession


@pytest.fixture(scope="session")
def spark():
    s = (SparkSession.builder.master("local[2]").appName("frostsight-tests")
         .config("spark.sql.session.timeZone", "UTC").config("spark.sql.shuffle.partitions", "2").getOrCreate())
    yield s
    s.stop()
```

  2. `tests/unit/test_transforms.py`:

```python
from pyspark.sql import functions as F

from frostsight import transforms as T


def test_units(spark):
    df = spark.createDataFrame([(273.15, "K", 36.0, "km/h", 0.5, "mm/10min")],
                               "t double, tu string, w double, wu string, p double, pu string")
    r = df.select(T.to_celsius(F.col("t"), F.col("tu")).alias("c"), T.to_ms(F.col("w"), F.col("wu")).alias("ms"),
                  T.to_mm_per_hour(F.col("p"), F.col("pu")).alias("mmh")).first()
    assert abs(r.c) < 1e-9 and abs(r.ms - 10.0) < 1e-9 and abs(r.mmh - 3.0) < 1e-9


def test_precip_type_and_utc(spark):
    df = spark.createDataFrame([("Freezing rain", "2026-11-03T07:10:00+01:00")], "p string, ts string")
    r = df.select(T.normalise_precip_type(F.col("p")).alias("p"), T.to_utc_timestamp(F.col("ts")).alias("t")).first()
    assert r.p == "FREEZING_RAIN" and r.t.hour == 6 and r.t.minute == 10


def test_batch_id(spark):
    df = spark.createDataFrame([("/Volumes/w/landing/raw/road_weather/2026/11/03/20261103T071000Z.jsonl",),
                                ("/Volumes/w/landing/raw/road_weather/2026/01/15/replay__storm_2026_01_15__20260115T081000Z.jsonl",),
                                ("/Volumes/w/landing/raw/road_weather/2026/01/15/replay__storm_2026_01_15__20260115T081000Z__r20261120T091500Z.jsonl",)],
                               "p string")
    got = [r[0] for r in df.select(T.batch_id_from_path(F.col("p"))).collect()]
    assert got == ["20261103T071000Z", "replay:storm_2026_01_15", "replay:storm_2026_01_15"]   # run suffix ignored


def test_dedup_key(spark):
    df = spark.createDataFrame([("1", "2026-11-03 07:10:00"), ("1", "2026-11-03 07:10:00"), ("1", "2026-11-03 07:20:00")],
                               "station_id string, event_time string").withColumn("event_time", F.to_timestamp("event_time"))
    assert df.dropDuplicates(["station_id", "event_time"]).count() == 2
```

  3. `tests/unit/test_rules.py` (the rule file is the contract between M2, M4 and M6):

```python
from frostsight.config import ACTIONS, dq_rules, rule_actions, rules_by_action


def test_rule_ids_unique_and_actions_valid():
    rules = dq_rules()
    ids = [r["id"] for r in rules]
    assert len(ids) == len(set(ids)) == 18
    assert all(r["action"] in ACTIONS for r in rules)


def test_pipeline_rules_present():
    assert set(rules_by_action("silver.road_weather_observations", "drop")) == {"RW001", "RW002", "RW003", "RW004", "RW005", "RW006", "XS001"}
    assert set(rules_by_action("silver.road_weather_observations", "warn")) == {"RW007", "RW008", "XS002"}
    assert rule_actions()["ST002"] == "fail"
```

  4. `tests/unit/test_geo.py`:

```python
import pytest

from frostsight import geo


def test_wkt_transform_tromso():
    # UTM 33N point near Tromsø centre (E 654000, N 7732000) -> about 69.65 N, 18.95 E
    wkt = geo.wkt_25833_to_4326("POINT Z (654000 7732000 12)")
    lon, lat = map(float, wkt.replace("POINT (", "").rstrip(")").split())
    assert lat == pytest.approx(69.66, abs=0.05) and lon == pytest.approx(18.98, abs=0.1)


def test_mean_z_cells_and_centroid():
    line = "LINESTRING Z (654000 7732000 10, 654100 7732100 20)"
    assert geo.mean_z(line) == 15.0
    wgs = geo.wkt_25833_to_4326(line)
    cells = geo.line_cells(wgs, 9)
    assert 1 <= len(cells) <= 4
    lon, lat = geo.centroid_4326(wgs)
    assert 68 < lat < 71 and 15 < lon < 22
```

  5. Run `uv run pytest -q`. CI (M2, `ci.yml`) runs the same command on every pull request.

Expect: all tests pass in under a minute after the first JVM start.
If it fails: no Java on the machine (install Temurin 17); `pyproj` missing (`uv sync --extra dev`).

### T4.10 Personal-workspace workflow      owner: all
Why: five engineers share one active pipeline in the team account; iteration happens elsewhere.
Do:
  1. Branch `feature/m4-<name>`; deploy with `-t personal` to your own Free Edition account. Your account
     has its own metastore, so `frostsight.bronze...` names do not collide with the team's.
  2. Land fixtures into your own volume: `databricks fs cp -r tests/fixtures/landing dbfs:/Volumes/frostsight/landing/raw --profile frostsight-personal`.
  3. Iterate: edit, `bundle deploy -t personal`, `bundle run ingest -t personal`, read the event log.
  4. Open a pull request. CI runs ruff, pytest and `bundle validate`. After squash merge, `deploy-free.yml`
     deploys `main` to the team workspace. Nobody deploys to `free` from a laptop except to unblock CI.
  5. Do not start updates on `free` by hand while `orchestrate` is unpaused; the job owns the pipeline.

Expect: `databricks bundle summary -t personal --profile frostsight-personal` lists `[dev <you>] frostsight-ingest`, `-orchestrate` and `-reference`; the same command with `-t free` lists them without the prefix.
If it fails: `RESOURCE_EXHAUSTED` on `personal` (your own account already has an active pipeline from an earlier experiment: delete it); a PR is red on `bundle validate` because the runner has no credentials (03_M2 T2.4 secrets).

## 3. Done when

- [ ] `bronze.road_weather_events`, `bronze.road_incident_events`, `quarantine.schema_errors` exist on `free` and grow every 10 minutes.
- [ ] `silver.road_weather_observations` has no duplicate `(station_id, event_time)`, UTC timestamps, °C, m/s, mm/h; it is fed by the two flows `road_weather_live` and `road_weather_replay`, both using `transforms.normalise_road_weather`.
- [ ] `quarantine.invalid_road_weather` and `quarantine.invalid_incidents` hold the injected bad fixtures with `rule` (the `dq_rules.yml` id), `reason` and `pipeline_run_id`; every quarantine table has the same six columns.
- [ ] `silver.road_incidents` shows the latest version per incident with `road_segment_id` for at least 90 % of rows with coordinates.
- [ ] `silver.road_segments` (~20k, Troms, with `centroid_lat/lon` and `h3_cells`), `silver.road_weather_stations` (30, `latitude/longitude`), `silver.accidents`, `silver.avalanche_landslide_events`, `silver.admin_boundaries` loaded by `reference`; second run changes nothing.
- [ ] Bundle variables and targets match the README table (`schedule_pause_status`, `pipeline_development`, `config_dir`, `mode: development` everywhere, presets on `free` and `aws`).
- [ ] `silver.station_segment_lookup` covers 30 of 30 stations, all within 500 m.
- [ ] `silver.segment_station_coverage` holds the segments within 5 km of each station on its own road, the nearer station winning (04_M3 T3.3 step 7).
- [ ] Stop-and-restart, duplicate file and late file tests done on `personal`, results noted in `runbooks/ingestion.md` draft.
- [ ] `orchestrate` runs every 10 minutes on `free`, `max_concurrent_runs: 1`, email on failure.
- [ ] `uv run pytest` green locally and in CI.

## 4. Verify

```sql
-- row counts per layer
SELECT 'bronze.road_weather_events' t, count(*) n FROM frostsight.bronze.road_weather_events
UNION ALL SELECT 'bronze.road_incident_events', count(*) FROM frostsight.bronze.road_incident_events
UNION ALL SELECT 'silver.road_weather_observations', count(*) FROM frostsight.silver.road_weather_observations
UNION ALL SELECT 'silver.road_incidents', count(*) FROM frostsight.silver.road_incidents
UNION ALL SELECT 'silver.road_segments', count(*) FROM frostsight.silver.road_segments
UNION ALL SELECT 'silver.road_weather_stations', count(*) FROM frostsight.silver.road_weather_stations
UNION ALL SELECT 'silver.station_segment_lookup', count(*) FROM frostsight.silver.station_segment_lookup
UNION ALL SELECT 'quarantine.invalid_road_weather', count(*) FROM frostsight.quarantine.invalid_road_weather
UNION ALL SELECT 'quarantine.invalid_incidents', count(*) FROM frostsight.quarantine.invalid_incidents
UNION ALL SELECT 'quarantine.schema_errors', count(*) FROM frostsight.quarantine.schema_errors
UNION ALL SELECT 'quarantine.unmapped_observations', count(*) FROM frostsight.quarantine.unmapped_observations;

-- dedup and freshness
SELECT count(*) - count(DISTINCT station_id, event_time) AS dup_keys, max(event_time) AS newest,
       timestampdiff(MINUTE, max(event_time), current_timestamp()) AS lag_min
FROM frostsight.silver.road_weather_observations;

-- expectation metrics, last update (rule ids from dq_rules.yml)
SELECT x.name AS rule_id, sum(x.passed_records) passed, sum(x.failed_records) failed
FROM frostsight.gold.ingest_event_log e
LATERAL VIEW explode(from_json(e.details:flow_progress.data_quality.expectations,
     'array<struct<name:string,dataset:string,passed_records:bigint,failed_records:bigint>>')) AS x
WHERE e.event_type = 'flow_progress'
  AND e.origin.update_id = (SELECT max_by(origin.update_id, timestamp) FROM frostsight.gold.ingest_event_log)
GROUP BY 1;

-- quarantine samples and lookup coverage
SELECT rule, reason, original_row FROM frostsight.quarantine.invalid_road_weather ORDER BY quarantined_at DESC LIMIT 5;
SELECT count(*) AS stations, count(l.road_segment_id) AS mapped, max(distance_m) AS worst_m
FROM frostsight.silver.road_weather_stations s LEFT JOIN frostsight.silver.station_segment_lookup l USING (station_id);
```

```bash
databricks bundle summary -t free --profile frostsight-free                          # ids and URLs of ingest, orchestrate, reference
databricks pipelines list-updates $PIPELINE_ID --profile frostsight-free | jq '.updates[0:3][] | {state, cause, creation_time}'
databricks pipelines list-pipeline-events $PIPELINE_ID --profile frostsight-free | jq '.events[] | select(.level == "ERROR") | .message' | head
databricks jobs list-runs --job-id $(databricks bundle summary -t free --output json --profile frostsight-free | jq -r .resources.jobs.orchestrate.id) --limit 3 --profile frostsight-free
```
