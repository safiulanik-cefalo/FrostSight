# M6: Product visible

Owners: Safiul (dashboards, Genie), Rayhan (freshness, CI deploy, grants). Read `00_README.md` first.

Goal: four AI/BI dashboards deployed from the bundle on the 2X-Small serverless warehouse; the
freshness table `gold.data_quality_summary` filled by the `orchestrate` job every run; the bundle deploys
from CI on `main`; a Genie space if there is time.

Inputs from M5 (must exist before you start): `gold.road_segment_current_risk`, `gold.road_segment_risk_history`,
`gold.road_weather_summary`, `gold.incident_summary`, `gold.historical_closures`, `silver.road_segments`,
`silver.road_weather_stations`, `silver.road_weather_observations`, `silver.road_incidents`, `quarantine.*`.

Screens to replicate (mock-ups in `docs/screens.html`): Risk Map, Road Detail, Gritting
Priority List, Platform Health.

## Task list

| Task | What | Owner |
|---|---|---|
| T6.1 | AI/BI dashboards explained | Safiul |
| T6.2 | Freshness table and data-quality events | Rayhan |
| T6.3 | Map coordinates per segment | Rayhan |
| T6.4 | Dashboard SQL, tested through the CLI | Safiul |
| T6.5 | Dashboard JSON files | Safiul |
| T6.6 | Bundle resource, deploy, open | Safiul |
| T6.7 | CI deploy on `main` | Rayhan |
| T6.8 | Genie space (optional) | Safiul |
| T6.9 | Grants and viewer credentials | Rayhan |
| T6.10 | Developing against a personal workspace | Safiul |

---

### T6.1 AI/BI dashboards explained      owner: Safiul
Why: nobody on the team has built one; these ten lines save a day of guessing.
Do: read these, then move on.

1. An AI/BI dashboard is a JSON document. The file extension is `.lvdash.json` ("Lakeview" is the old name).
2. It has two parts: `datasets` (each one is a single SQL query) and `pages` with `layout` (widgets on a 12-column grid).
3. A widget is bound to one dataset by `datasetName`, and picks columns from it by `fieldName`. A field name in the widget must match a column or alias in the dataset exactly.
4. Widget types we use: `counter` (KPI tile), `table`, `symbol-map` (points by lat/lon), `bar`, `line`, `filter-*`, and markdown text. Each type has a fixed `version` number (counter, table, map and filters are 2; bar and line are 3). The wrong version breaks the widget.
5. The dashboard runs on a SQL warehouse. Ours is the one 2X-Small serverless warehouse; its id is the bundle variable `warehouse_id`.
6. Dataset SQL uses bare table names (`FROM road_segment_current_risk`). The catalog and schema are supplied at deploy time (`dataset_catalog`, `dataset_schema`), so the same JSON works on `free`, `personal` and `aws`. The skill rule is strict: the flags only fill in missing parts, so a hard-coded `frostsight.` breaks portability. Silver tables are therefore reached through gold views (T6.4 step 2), never by a two-part name.
7. Parameters are `:name` placeholders in the SQL, declared per dataset, and bound to filter widgets. We use them for `road_segment_id`, `road_number` and the surface-temperature threshold.
8. A dashboard has a draft and a published version. Editing in the UI changes the draft; viewers see the published one. The bundle deploys and publishes in one step.
9. Publishing "with embedded credentials" means viewers run the queries as the publisher, so they need no table grants. Without it, each viewer needs `SELECT` on the tables. We embed credentials on `free` (see T6.9).
10. The rule from the dashboard skill: every dataset query is run through the CLI before it goes into the JSON. A query that fails inside the dashboard shows an empty widget with a small red icon and no useful message.

Expect: you can explain to a teammate why a widget shows "no selected fields to visualize" (field name mismatch) and why a query with `frostsight.gold.` hard-coded breaks on `personal`.
If it fails: you cannot; read `references/1-widget-specifications.md` and `references/5-troubleshooting.md` of the `databricks-aibi-dashboards` skill once (twenty minutes), then continue.

---

### T6.2 Freshness table and data-quality events      owner: Rayhan
Why: the Platform Health screen and the "data age" tile need one small table that says, per source, how old the data is. The pipeline's own event log holds the expectation counts; the job copies them into `silver.data_quality_events` so dashboards never read the event log directly.

Both tables were designed at M2 (03_M2 T2.8) and created by `sql/setup_dq_tables.sql`; the code below writes exactly those columns.
`gold.data_quality_summary`: `source, last_successful_ingestion, last_event_time, ingestion_delay_min, threshold_min, status (FRESH | STALE | NO_DATA), rows_last_24h, quarantined_last_24h, computed_at`.
`silver.data_quality_events`: `event_id, event_time, run_id, source, table_name, rule_id, action, rows_checked, rows_failed, sample`.

Do:

1. Create `src/frostsight/freshness.py` (pure functions, unit-tested):

```python
"""Per-source freshness rows for gold.data_quality_summary (columns from 03_M2 T2.8)."""
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class SourceSpec:
    source: str
    ingest_table: str        # table that carries _ingested_at
    event_table: str         # table that carries the measurement time
    event_column: str
    threshold_min: int       # STALE when the delay exceeds it
    quarantine_source: str | None   # value of quarantine.*.source, None if never quarantined


SOURCES: list[SourceSpec] = [
    SourceSpec("road_weather", "bronze.road_weather_events", "silver.road_weather_observations", "event_time", 30, "road_weather"),
    SourceSpec("incidents", "bronze.road_incident_events", "silver.road_incidents", "snapshot_time", 60, "road_incidents"),
    SourceSpec("nvdb", "bronze.road_network", "bronze.road_network", "_ingested_at", 8 * 24 * 60, "road_segments"),
    SourceSpec("elevation", "bronze.elevation", "bronze.elevation", "_ingested_at", 60 * 24 * 60, None),
]
STATUSES = ("FRESH", "STALE", "NO_DATA")


def delay_minutes(last_event_time: datetime | None, now: datetime) -> float | None:
    if last_event_time is None:
        return None
    return round((now - last_event_time).total_seconds() / 60.0, 1)


def status_for(delay: float | None, threshold: int) -> str:
    if delay is None:
        return "NO_DATA"
    return "FRESH" if delay <= threshold else "STALE"


def freshness_row(spec: SourceSpec, last_event_time, last_ingested_at,
                  rows_last_24h: int, quarantined_last_24h: int, now: datetime) -> dict:
    delay = delay_minutes(last_event_time, now)
    return {
        "source": spec.source,
        "last_successful_ingestion": last_ingested_at,
        "last_event_time": last_event_time,
        "ingestion_delay_min": delay,
        "threshold_min": spec.threshold_min,
        "status": status_for(delay, spec.threshold_min),
        "rows_last_24h": rows_last_24h,
        "quarantined_last_24h": quarantined_last_24h,
        "computed_at": now,
    }
```

2. Replace the M5 placeholder `src/jobs/build_freshness.py` (the job task; serverless, no cluster):

```python
"""Fill gold.data_quality_summary (MERGE, one row per source), append its history, copy expectation counts
from the pipeline event log into silver.data_quality_events, and quarantine late road-weather rows (RW008)."""
import argparse
from datetime import datetime, timedelta, timezone

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql import types as T

from frostsight.config import dq_rules
from frostsight.freshness import SOURCES, freshness_row

SUMMARY_SCHEMA = T.StructType([
    T.StructField("source", T.StringType()),
    T.StructField("last_successful_ingestion", T.TimestampType()),
    T.StructField("last_event_time", T.TimestampType()),
    T.StructField("ingestion_delay_min", T.DoubleType()),
    T.StructField("threshold_min", T.IntegerType()),
    T.StructField("status", T.StringType()),
    T.StructField("rows_last_24h", T.LongType()),
    T.StructField("quarantined_last_24h", T.LongType()),
    T.StructField("computed_at", T.TimestampType()),
])
EVENT_LOG = "gold.ingest_event_log"          # published by ingest.pipeline.yml (05_M4 T4.7)
QUARANTINE_COLS = ["original_row", "source", "quarantined_at", "rule", "reason", "pipeline_run_id"]


def scalar(spark, sql: str):
    row = spark.sql(sql).first()
    return None if row is None else row[0]


def table_exists(spark, name: str) -> bool:
    return spark.catalog.tableExists(name)


def quarantined_since(spark, catalog: str, source: str, since: datetime) -> int:
    tables = [r.tableName for r in spark.sql(f"SHOW TABLES IN {catalog}.quarantine").collect()]
    total = 0
    for t in tables:
        total += scalar(spark, f"""
            SELECT count(*) FROM {catalog}.quarantine.{t}
            WHERE source = '{source}' AND quarantined_at >= TIMESTAMP '{since:%Y-%m-%d %H:%M:%S}'""") or 0
    return int(total)


def build_summary(spark, catalog: str, now: datetime) -> None:
    since = now - timedelta(hours=24)
    rows = []
    for s in SOURCES:
        if not table_exists(spark, f"{catalog}.{s.ingest_table}"):        # e.g. elevation never landed on this target
            rows.append(freshness_row(s, None, None, 0, 0, now))
            continue
        last_event = scalar(spark, f"SELECT max({s.event_column}) FROM {catalog}.{s.event_table}")
        last_ingested = scalar(spark, f"SELECT max(_ingested_at) FROM {catalog}.{s.ingest_table}")
        rows_24h = scalar(spark, f"""SELECT count(*) FROM {catalog}.{s.event_table}
                                     WHERE _ingested_at >= TIMESTAMP '{since:%Y-%m-%d %H:%M:%S}'""") or 0
        q_24h = quarantined_since(spark, catalog, s.quarantine_source, since) if s.quarantine_source else 0
        rows.append(freshness_row(s, last_event, last_ingested, int(rows_24h), q_24h, now))
    spark.createDataFrame(rows, SUMMARY_SCHEMA).createOrReplaceTempView("freshness_rows")
    spark.sql(f"""
        CREATE TABLE IF NOT EXISTS {catalog}.gold.data_quality_summary (
          source STRING, last_successful_ingestion TIMESTAMP, last_event_time TIMESTAMP, ingestion_delay_min DOUBLE,
          threshold_min INT, status STRING, rows_last_24h BIGINT, quarantined_last_24h BIGINT, computed_at TIMESTAMP)""")
    spark.sql(f"""
        MERGE INTO {catalog}.gold.data_quality_summary t
        USING freshness_rows s ON t.source = s.source
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *""")
    # History feeds the sparkline on the health page and the M7 outage test.
    spark.sql(f"CREATE TABLE IF NOT EXISTS {catalog}.gold.data_quality_summary_history LIKE {catalog}.gold.data_quality_summary")
    spark.sql(f"INSERT INTO {catalog}.gold.data_quality_summary_history SELECT * FROM freshness_rows")


def build_dq_events(spark, catalog: str, config_dir: str | None) -> None:
    """Expectation counts per rule per update from the event log -> silver.data_quality_events (03_M2 columns)."""
    if not table_exists(spark, f"{catalog}.{EVENT_LOG}"):
        print(f"{EVENT_LOG} missing: run the pipeline once, or switch EVENT_LOG to the event_log(TABLE(...)) form")
        return
    rules = spark.createDataFrame([(r["id"], r["table"], r["action"]) for r in dq_rules(None, config_dir)],
                                  "rule_id string, table_name string, action string")
    rules = rules.withColumn("source", F.when(F.col("table_name").contains("incident"), "incidents").otherwise("road_weather"))
    ev = spark.sql(f"""
        SELECT timestamp AS event_time, origin.update_id AS run_id, e.name AS rule_id,
               e.passed_records, e.failed_records
        FROM (SELECT timestamp, origin,
                     explode(from_json(details:flow_progress.data_quality.expectations,
                       'array<struct<name: string, dataset: string, passed_records: bigint, failed_records: bigint>>')) AS e
              FROM {catalog}.{EVENT_LOG}
              WHERE event_type = 'flow_progress'
                AND details:flow_progress.data_quality.expectations IS NOT NULL
                AND timestamp >= timestampadd(DAY, -2, current_timestamp()))""")
    out = (ev.join(rules, "rule_id", "left")
             .select(F.expr("uuid()").alias("event_id"), "event_time", "run_id", "source",
                     F.concat(F.lit(f"{catalog}."), F.col("table_name")).alias("table_name"),
                     "rule_id", "action",
                     (F.col("passed_records") + F.col("failed_records")).alias("rows_checked"),
                     F.col("failed_records").alias("rows_failed"),
                     F.lit(None).cast("string").alias("sample")))
    out.createOrReplaceTempView("dq_event_rows")
    spark.sql(f"""
        CREATE TABLE IF NOT EXISTS {catalog}.silver.data_quality_events (
          event_id STRING, event_time TIMESTAMP, run_id STRING, source STRING, table_name STRING,
          rule_id STRING, action STRING, rows_checked BIGINT, rows_failed BIGINT, sample STRING)""")
    spark.sql(f"""
        MERGE INTO {catalog}.silver.data_quality_events t
        USING dq_event_rows s
        ON t.run_id = s.run_id AND t.rule_id = s.rule_id AND t.event_time = s.event_time
        WHEN NOT MATCHED THEN INSERT *""")


def quarantine_late_rows(spark, catalog: str, now: datetime) -> None:
    """04_M3 decision D4: rows later than the 30-minute watermark are dropped inside the stream, so count them
    from bronze in batch and keep a copy under rule RW008 (same six columns as every quarantine table)."""
    q = f"{catalog}.quarantine.late_road_weather"
    spark.sql(f"CREATE TABLE IF NOT EXISTS {q} (original_row STRING, source STRING, quarantined_at TIMESTAMP, rule STRING, reason STRING, pipeline_run_id STRING)")
    last = scalar(spark, f"SELECT max(quarantined_at) FROM {q}") or (now - timedelta(hours=24))
    spark.sql(f"""
        INSERT INTO {q}
        SELECT to_json(struct(*)) AS original_row, 'road_weather' AS source, current_timestamp() AS quarantined_at,
               'RW008' AS rule, concat('ingested ', round(timestampdiff(SECOND, to_timestamp(measurement_time), _ingested_at) / 60), ' min after event') AS reason,
               _batch_id AS pipeline_run_id
        FROM {catalog}.bronze.road_weather_events
        WHERE _ingested_at > TIMESTAMP '{last:%Y-%m-%d %H:%M:%S}'
          AND _batch_id NOT LIKE 'replay:%'            -- replayed history is months "late" by design; it has its own flow
          AND _ingested_at > to_timestamp(measurement_time) + INTERVAL 30 MINUTES""")


def main(catalog: str, config_dir: str | None) -> None:
    spark = SparkSession.builder.getOrCreate()
    now = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)   # session zone is UTC on serverless
    build_summary(spark, catalog, now)
    build_dq_events(spark, catalog, config_dir)
    quarantine_late_rows(spark, catalog, now)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--catalog", required=True)
    p.add_argument("--config-dir", default=None)
    a = p.parse_args()
    main(a.catalog, a.config_dir)
```

3. The task already exists in `resources/orchestrate.job.yml` (05_M4 T4.7 and 06_M5 T5.5: `build_freshness`, `run_if: ALL_DONE`, `environment_key: gold`, parameters `--catalog` and `--config-dir`). Nothing to add to the YAML; deploy and the new script replaces the placeholder.

   `run_if: ALL_DONE` is the point: when gold fails, the freshness row still shows the delay growing.

4. Two ways to reach the pipeline event log; the code uses the first:
   - **Published event-log table** `frostsight.gold.ingest_event_log`, from `event_log: {catalog, schema, name}` in `resources/ingest.pipeline.yml` (05_M4 T4.7). A normal table, readable from the warehouse and from jobs.
   - **TVF on a pipeline table** (works for Unity Catalog pipelines without any setting): `event_log(TABLE(frostsight.silver.road_weather_observations))`. If the published table is not accepted by the bundle schema, replace `FROM {catalog}.{EVENT_LOG}` in `build_dq_events` with this form and drop the `table_exists` guard.
   verify: on the Free Edition serverless warehouse, `SELECT count(*) FROM frostsight.gold.ingest_event_log` and `SELECT count(*) FROM event_log(TABLE(frostsight.silver.road_weather_observations))` both return a number.

5. Unit test `tests/unit/test_freshness.py`: `status_for(10, 30) == "FRESH"`, `status_for(31, 30) == "STALE"`, `status_for(None, 30) == "NO_DATA"`, and `freshness_row(...)` returns exactly the nine summary columns.

Expect: `SELECT * FROM frostsight.gold.data_quality_summary` returns four rows, `road_weather` is `FRESH` with `ingestion_delay_min` under 30 a few minutes after a pipeline update; `silver.data_quality_events` has one row per rule per flow per update, and `sum(rows_failed)` for `RW001..RW006, XS001` over one `run_id` equals the `quarantine.invalid_road_weather` rows with that `pipeline_run_id`.

If it fails:
- `TABLE_OR_VIEW_NOT_FOUND bronze.elevation`: the elevation source never landed on this target; the code writes `NO_DATA` for it, so this only appears if the guard was removed.
- `ingestion_delay_min` negative: a source timestamp is local time, not UTC. Fix in silver (README section 4: UTC everywhere).
- `silver.data_quality_events` stays empty: the pipeline has not run with expectations yet, or the `details` path differs. Run `SELECT details FROM frostsight.gold.ingest_event_log WHERE event_type = 'flow_progress' LIMIT 5` and read the JSON.
- `MERGE` on `data_quality_summary` fails on columns: `sql/setup_dq_tables.sql` (M2) created it with other names; `DESCRIBE` it and align that file, not this one.

---

### T6.3 Map coordinates per segment      owner: Rayhan
Why: the map widget needs one lat/lon per segment. Computing a centroid from WKT on every dashboard refresh is wasted work on a 2X-Small warehouse; compute it once.

Do:
1. Nothing new to compute: `silver.road_segments.centroid_lat` and `centroid_lon` are written by the reference job at load time (05_M4 T4.6, `build_road_segments`, shapely centroid of the WGS84 line). If the table on your target predates that change, run `databricks bundle run reference -t free --profile frostsight-free` once; the MERGE fills the two columns for every segment.
2. Decision recorded here: dashboards read `centroid_lat` and `centroid_lon`; no `ST_` call in dashboard SQL. `ST_Centroid` on the warehouse (04_M3 fallback) is not needed.

Expect: `SELECT count(*) FROM frostsight.silver.road_segments WHERE centroid_lat IS NULL` returns 0; every lat is between 68 and 71 and every lon between 15 and 22 for Troms.

If it fails: NULL centroids for a few rows: `geometry_wkt_4326` is NULL for them (the reprojection UDF got an empty WKT); rule `SG001` should have dropped those rows, check `quarantine.invalid_road_segments`.

---

### T6.4 Dashboard SQL, tested through the CLI      owner: Safiul
Why: each dataset is one query. The skill rule is that every query runs through the CLI before it goes into JSON.

Do:
1. Find the warehouse id once and keep it in your shell:

```bash
databricks warehouses list --profile frostsight-free
export WH=<id of the 2X-Small>
q() { databricks experimental aitools tools query --warehouse "$WH" --profile frostsight-free "$1"; }
```

   If `--warehouse` is rejected: `export DATABRICKS_WAREHOUSE_ID=$WH` and drop the flag.
2. Two naming rules. In the CLI test, write full names (`frostsight.gold.road_segment_current_risk`). In the JSON, every table is bare (`road_segment_current_risk`), because the bundle sets `dataset_catalog: frostsight` and `dataset_schema: gold` and the dashboard skill says those flags do not rewrite a schema you typed. Silver tables are reached through three gold views, created once per target with `src/sql/002_gold_views.sql` (run it in the SQL editor, then `q` it on the other targets):

```sql
CREATE OR REPLACE VIEW frostsight.gold.v_segments AS
  SELECT road_segment_id, road_number, road_category, county, length_m, speed_limit, centroid_lat, centroid_lon
  FROM frostsight.silver.road_segments;
CREATE OR REPLACE VIEW frostsight.gold.v_stations AS
  SELECT station_id, name, latitude, longitude FROM frostsight.silver.road_weather_stations;
CREATE OR REPLACE VIEW frostsight.gold.v_observations AS
  SELECT station_id, event_time, air_temperature_c, road_surface_temperature_c, dew_point_c, humidity_pct,
         precipitation_type, precipitation_intensity_mm_h, wind_speed_ms, road_surface_state, _batch_id
  FROM frostsight.silver.road_weather_observations;
CREATE OR REPLACE VIEW frostsight.gold.v_incidents AS
  SELECT incident_id, incident_type, severity, road_ref, road_number, road_segment_id, start_time, end_time,
         description, latitude, longitude, snapshot_time,
         (end_time IS NULL OR end_time > current_timestamp()) AS is_active
  FROM frostsight.silver.road_incidents;
CREATE OR REPLACE VIEW frostsight.gold.v_quarantine AS
  SELECT 'invalid_road_weather' AS quarantine_table, rule, quarantined_at FROM frostsight.quarantine.invalid_road_weather
  UNION ALL SELECT 'invalid_incidents', rule, quarantined_at FROM frostsight.quarantine.invalid_incidents
  UNION ALL SELECT 'unmapped_observations', rule, quarantined_at FROM frostsight.quarantine.unmapped_observations
  UNION ALL SELECT 'schema_errors', rule, quarantined_at FROM frostsight.quarantine.schema_errors
  UNION ALL SELECT 'late_road_weather', rule, quarantined_at FROM frostsight.quarantine.late_road_weather;
CREATE OR REPLACE VIEW frostsight.gold.v_dq_events AS
  SELECT event_time, run_id, source, rule_id, action, rows_checked, rows_failed FROM frostsight.silver.data_quality_events;
```

   Views cost nothing, keep bronze and quarantine grants unchanged for viewers (T6.9: the view owner's rights apply), and give the dashboards one schema. `invalid_road_segments` and `invalid_road_weather_stations` (reference job) can be added to `v_quarantine` when they exist.
3. Run each query below with `q "..."` (for the test, prefix bare names with `frostsight.gold.`). Every one must print rows with the expected columns before you touch the JSON.

**Risk map**

`ds_kpi` (one row, feeds four counters):

```sql
WITH risk AS (
  SELECT count(*) AS segments_total,
         sum(CASE WHEN risk_level IN ('HIGH', 'VERY_HIGH') THEN 1 ELSE 0 END) AS segments_high,
         timestampdiff(MINUTE, max(risk_updated_at), current_timestamp()) AS data_age_minutes
  FROM road_segment_current_risk),
inc AS (SELECT coalesce(sum(active_incidents), 0) AS active_incidents FROM incident_summary),
st AS (
  SELECT count(*) AS stations_total,
         sum(CASE WHEN last_event_time >= timestampadd(MINUTE, -30, current_timestamp()) THEN 1 ELSE 0 END) AS stations_reporting
  FROM (SELECT s.station_id, max(o.event_time) AS last_event_time
        FROM v_stations s
        LEFT JOIN v_observations o
          ON o.station_id = s.station_id AND o.event_time >= timestampadd(HOUR, -24, current_timestamp())
        GROUP BY s.station_id))
SELECT * FROM risk, inc, st
```

`ds_map` (one point per segment):

```sql
SELECT r.road_segment_id, s.road_number, s.road_category, s.centroid_lat AS lat, s.centroid_lon AS lon,
       r.risk_level, r.risk_score, r.icing_score, r.risk_updated_at,
       CASE r.risk_level WHEN 'VERY_HIGH' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END AS risk_rank
FROM road_segment_current_risk r
JOIN v_segments s USING (road_segment_id)
```

`ds_stations` (station dots, reporting or stale):

```sql
SELECT s.station_id, s.name, s.latitude AS lat, s.longitude AS lon, max(o.event_time) AS last_event_time,
       CASE WHEN max(o.event_time) >= timestampadd(MINUTE, -30, current_timestamp())
            THEN 'Reporting' ELSE 'Stale' END AS station_status
FROM v_stations s
LEFT JOIN v_observations o
  ON o.station_id = s.station_id AND o.event_time >= timestampadd(HOUR, -24, current_timestamp())
GROUP BY s.station_id, s.name, s.latitude, s.longitude
```

`ds_incidents` (active incidents, WR-UC-03; `silver.road_incidents` through `v_incidents`, `gold.incident_summary` is per segment and has no incident rows):

```sql
SELECT i.start_time, i.incident_type, i.severity, i.road_segment_id, i.road_number, i.road_ref
FROM v_incidents i
WHERE i.is_active
ORDER BY i.start_time DESC
```

The legend is the map's own categorical legend (LOW, MEDIUM, HIGH, VERY_HIGH) plus a text widget line "Station dot: green reporting, grey stale".

**Road detail** (parameter `:road_segment_id`, STRING, default `"1113653-1-9"` or any real id from `ds_map`)

`ds_header`:

```sql
SELECT r.road_segment_id, s.road_number, s.road_category, s.county, s.length_m, s.speed_limit,
       r.risk_level, r.risk_score, r.icing_score, r.risk_updated_at,
       timestampdiff(MINUTE, r.risk_updated_at, current_timestamp()) AS updated_minutes_ago,
       r.station_id, st.name AS station_name
FROM road_segment_current_risk r
JOIN v_segments s USING (road_segment_id)
LEFT JOIN v_stations st ON st.station_id = r.station_id
WHERE r.road_segment_id = :road_segment_id
```

`ds_risk_types` (only icing is live in the MVP; the other two are static rows so the screen matches the mock-up):

```sql
SELECT 1 AS sort_key, 'Icing' AS risk_type, risk_level, round(icing_score, 2) AS score, 'live' AS note
FROM road_segment_current_risk WHERE road_segment_id = :road_segment_id
UNION ALL SELECT 2, 'Closure', NULL, NULL, 'post-MVP'
UNION ALL SELECT 3, 'Accident', NULL, NULL, 'post-MVP'
ORDER BY sort_key
```

`ds_drivers` (exploded and sorted, feeds a horizontal bar):

```sql
SELECT d.factor, round(d.contribution, 3) AS contribution
FROM road_segment_current_risk
LATERAL VIEW explode(risk_drivers) t AS d
WHERE road_segment_id = :road_segment_id
ORDER BY contribution DESC
```

`ds_station_readings` (latest reading of the nearest station, one row per measure):

```sql
WITH latest AS (
  SELECT o.* FROM v_observations o
  JOIN road_segment_current_risk r ON r.station_id = o.station_id
  WHERE r.road_segment_id = :road_segment_id
  ORDER BY o.event_time DESC LIMIT 1)
SELECT 'Air temp' AS reading, concat(round(air_temperature_c, 1), ' °C') AS value, 1 AS sort_key FROM latest
UNION ALL SELECT 'Surface temp', concat(round(road_surface_temperature_c, 1), ' °C'), 2 FROM latest
UNION ALL SELECT 'Precipitation', coalesce(precipitation_type, 'None'), 3 FROM latest
UNION ALL SELECT 'Wind', concat(round(wind_speed_ms, 0), ' m/s'), 4 FROM latest
UNION ALL SELECT 'Humidity', concat(round(humidity_pct, 0), ' %'), 5 FROM latest
UNION ALL SELECT 'Observed at', date_format(event_time, 'HH:mm'), 6 FROM latest
UNION ALL SELECT 'Traffic', 'post-MVP', 7
ORDER BY sort_key
```

`ds_recent_incidents` (same road number, last 48 hours):

```sql
SELECT i.start_time, i.end_time, i.incident_type, i.severity, i.is_active, i.road_segment_id
FROM v_incidents i
WHERE i.road_number = (SELECT road_number FROM v_segments WHERE road_segment_id = :road_segment_id)
  AND i.start_time >= timestampadd(HOUR, -48, current_timestamp())
ORDER BY i.start_time DESC
```

`ds_risk_history` (24-hour line, spec section 16 "risk history"):

```sql
SELECT risk_updated_at, icing_score, risk_level
FROM road_segment_risk_history
WHERE road_segment_id = :road_segment_id AND risk_updated_at >= timestampadd(HOUR, -24, current_timestamp())
  AND coalesce(_batch_id, '') NOT LIKE 'replay:%'      -- a replay scored today has today's risk_updated_at (06_M5 T5.4)
ORDER BY risk_updated_at
```

**Gritting priority list** (parameters: `road_number` STRING MULTI, default empty; `surface_max_c` DECIMAL, default 1.0)

`ds_priority`:

```sql
WITH obs AS (
  SELECT station_id,
         max_by(road_surface_temperature_c, event_time) AS surface_c,
         max_by(precipitation_type, event_time) AS precip
  FROM v_observations
  WHERE event_time >= timestampadd(HOUR, -3, current_timestamp())
  GROUP BY station_id),
ranked AS (
  SELECT r.road_segment_id, s.road_number, s.road_category,
         round(r.icing_score, 2) AS icing_score, r.risk_level,
         o.surface_c, coalesce(o.precip, 'None') AS precip,
         array_join(transform(r.risk_drivers, d -> d.factor), ', ') AS main_drivers,   -- already the top 3, sorted (06_M5 T5.3)
         r.risk_updated_at
  FROM road_segment_current_risk r
  JOIN v_segments s USING (road_segment_id)
  LEFT JOIN obs o ON o.station_id = r.station_id
  WHERE (size(:road_number) = 0 OR array_contains(:road_number, s.road_number))
    AND (o.surface_c IS NULL OR o.surface_c <= :surface_max_c))
SELECT row_number() OVER (ORDER BY icing_score DESC, road_category) AS rank, *
FROM ranked
ORDER BY rank
```

`ds_road_numbers` (fills the filter list): `SELECT DISTINCT road_number FROM v_segments WHERE road_number IS NOT NULL ORDER BY 1`.

**Platform health**

`ds_freshness`: `SELECT source, last_event_time, last_successful_ingestion, round(ingestion_delay_min) AS delay_min, threshold_min, status, rows_last_24h, quarantined_last_24h FROM data_quality_summary ORDER BY source`

`ds_quarantine_today` (one query over every quarantine table, through `v_quarantine`; `rule` is the `dq_rules.yml` id or `rescued_data`):

```sql
SELECT quarantine_table, rule, count(*) AS rows_today
FROM v_quarantine
WHERE quarantined_at >= current_date()
GROUP BY quarantine_table, rule
ORDER BY rows_today DESC
```

`ds_latency` (median seconds from measurement to risk row, last 24 hours):

```sql
SELECT median(timestampdiff(SECOND, event_time, risk_updated_at)) AS latency_median_s,
       percentile_approx(timestampdiff(SECOND, event_time, risk_updated_at), 0.95) AS latency_p95_s,
       count(*) AS risk_rows_24h
FROM road_segment_risk_history
WHERE risk_updated_at >= timestampadd(HOUR, -24, current_timestamp())
  AND coalesce(_batch_id, '') NOT LIKE 'replay:%'      -- replay rows have months-old event_time: they would wreck the latency
```

Rule for every query on `road_segment_risk_history` that means "live": add
`coalesce(_batch_id, '') NOT LIKE 'replay:%'`. The history table holds scored replay events too (06_M5
decision "Replay rows"); `coalesce` keeps rows written before the column existed.

`ds_pipeline_runs` (runs today). Primary: the orchestrate job's run history from the system table.
verify: `system.lakeflow.job_run_timeline` is readable on Free Edition (the schema may need enabling: `databricks system-schemas enable <metastore_id> lakeflow`). If not, use the fallback.

```sql
-- primary (system table; job_id from `databricks bundle summary -t free`)
SELECT count(*) AS runs_today,
       sum(CASE WHEN result_state = 'SUCCESS' THEN 1 ELSE 0 END) AS runs_ok
FROM system.lakeflow.job_run_timeline
WHERE job_id = :orchestrate_job_id AND period_start_time >= current_date()
-- fallback (pipeline updates that reached the expectation stage today)
SELECT count(DISTINCT run_id) AS runs_today, count(DISTINCT run_id) AS runs_ok
FROM v_dq_events WHERE event_time >= current_date()
```

`ds_freshness_trend` (sparkline behind the delay tile): `SELECT computed_at, ingestion_delay_min FROM data_quality_summary_history WHERE source = 'road_weather' AND computed_at >= timestampadd(HOUR, -24, current_timestamp()) ORDER BY computed_at`

`ds_dq_rules` (failed rows per rule today, the "bad rows are counted" story in the M7 demo): `SELECT rule_id, action, sum(rows_failed) AS rows_failed, sum(rows_checked) AS rows_checked FROM v_dq_events WHERE event_time >= current_date() GROUP BY rule_id, action ORDER BY rows_failed DESC`

Expect: every `q` call prints rows. `ds_kpi` prints one row with six numbers. `ds_map` prints one row per segment that has a risk row (30 on a quiet day: one mapped segment per station) with no NULL lat. `ds_priority` prints a ranked list where rank 1 has the highest `icing_score`.

If it fails:
- `PARSE_SYNTAX_ERROR` near `:road_segment_id`: the CLI does not bind dashboard parameters; for the test replace `:road_segment_id` with a literal.
- `median` not found (it is a standard DBSQL aggregate): use `percentile_approx(x, 0.5)`.
- `ds_priority` returns nothing: `surface_max_c` too low for the season; test with `10.0`.
- `TABLE_OR_VIEW_NOT_FOUND v_segments`: `002_gold_views.sql` not run on this target.

---

### T6.5 Dashboard JSON files      owner: Safiul
Why: the JSON is the deliverable. One complete file is given; the other three follow the same shape.

Do:
1. Create `src/dashboards/risk_map.lvdash.json`. Every `queryLines` element ends with `\n`; widget `name` is letters, digits, hyphens; every page has `layoutVersion: GRID_V1`; every row sums to 12.

```json
{
  "datasets": [
    {"name": "ds_kpi", "displayName": "KPIs", "queryLines": [
      "WITH risk AS (SELECT count(*) AS segments_total, sum(CASE WHEN risk_level IN ('HIGH','VERY_HIGH') THEN 1 ELSE 0 END) AS segments_high, timestampdiff(MINUTE, max(risk_updated_at), current_timestamp()) AS data_age_minutes FROM road_segment_current_risk),\n",
      "inc AS (SELECT coalesce(sum(active_incidents), 0) AS active_incidents FROM incident_summary),\n",
      "st AS (SELECT count(*) AS stations_total, sum(CASE WHEN last_event_time >= timestampadd(MINUTE, -30, current_timestamp()) THEN 1 ELSE 0 END) AS stations_reporting\n",
      "  FROM (SELECT s.station_id, max(o.event_time) AS last_event_time FROM v_stations s LEFT JOIN v_observations o ON o.station_id = s.station_id AND o.event_time >= timestampadd(HOUR, -24, current_timestamp()) GROUP BY s.station_id))\n",
      "SELECT * FROM risk, inc, st\n"]},
    {"name": "ds_map", "displayName": "Segments", "queryLines": [
      "SELECT r.road_segment_id, s.road_number, s.road_category, s.centroid_lat AS lat, s.centroid_lon AS lon, r.risk_level, r.risk_score, r.icing_score, r.risk_updated_at,\n",
      "  CASE r.risk_level WHEN 'VERY_HIGH' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END AS risk_rank\n",
      "FROM road_segment_current_risk r JOIN v_segments s USING (road_segment_id)\n"]},
    {"name": "ds_stations", "displayName": "Stations", "queryLines": [
      "SELECT s.station_id, s.name, s.latitude AS lat, s.longitude AS lon, max(o.event_time) AS last_event_time,\n",
      "  CASE WHEN max(o.event_time) >= timestampadd(MINUTE, -30, current_timestamp()) THEN 'Reporting' ELSE 'Stale' END AS station_status\n",
      "FROM v_stations s LEFT JOIN v_observations o ON o.station_id = s.station_id AND o.event_time >= timestampadd(HOUR, -24, current_timestamp())\n",
      "GROUP BY s.station_id, s.name, s.latitude, s.longitude\n"]},
    {"name": "ds_incidents", "displayName": "Active incidents", "queryLines": [
      "SELECT i.start_time, i.incident_type, i.severity, i.road_segment_id, i.road_number, i.road_ref\n",
      "FROM v_incidents i\n",
      "WHERE i.is_active ORDER BY i.start_time DESC\n"]}
  ],
  "pages": [
    {"name": "map", "displayName": "Risk map", "pageType": "PAGE_TYPE_CANVAS", "layoutVersion": "GRID_V1",
     "layout": [
      {"widget": {"name": "title", "multilineTextboxSpec": {"lines": ["## FrostSight · Risk map · Troms pilot\n", "\n", "Icing risk per NVDB segment from gold.road_segment_current_risk, refreshed every 10 minutes. Not an official warning service.\n"]}},
       "position": {"x": 0, "y": 0, "width": 12, "height": 2}},

      {"widget": {"name": "kpi-high",
        "queries": [{"name": "main_query", "query": {"datasetName": "ds_kpi", "disaggregated": true,
          "fields": [{"name": "segments_high", "expression": "`segments_high`"}, {"name": "segments_total", "expression": "`segments_total`"}]}}],
        "spec": {"version": 2, "widgetType": "counter",
          "encodings": {"value": {"fieldName": "segments_high", "displayName": "Segments HIGH or above", "formatTemplate": "{{@formatted}} of {{segments_total}}"}},
          "frame": {"showTitle": true, "title": "Segments HIGH or above"}}},
       "position": {"x": 0, "y": 2, "width": 3, "height": 3}},

      {"widget": {"name": "kpi-incidents",
        "queries": [{"name": "main_query", "query": {"datasetName": "ds_kpi", "disaggregated": true,
          "fields": [{"name": "active_incidents", "expression": "`active_incidents`"}]}}],
        "spec": {"version": 2, "widgetType": "counter",
          "encodings": {"value": {"fieldName": "active_incidents", "displayName": "Active incidents"}},
          "frame": {"showTitle": true, "title": "Active incidents"}}},
       "position": {"x": 3, "y": 2, "width": 3, "height": 3}},

      {"widget": {"name": "kpi-stations",
        "queries": [{"name": "main_query", "query": {"datasetName": "ds_kpi", "disaggregated": true,
          "fields": [{"name": "stations_reporting", "expression": "`stations_reporting`"}, {"name": "stations_total", "expression": "`stations_total`"}]}}],
        "spec": {"version": 2, "widgetType": "counter",
          "encodings": {"value": {"fieldName": "stations_reporting", "displayName": "Stations reporting", "formatTemplate": "{{@formatted}} of {{stations_total}}"}},
          "frame": {"showTitle": true, "title": "Stations reporting"}}},
       "position": {"x": 6, "y": 2, "width": 3, "height": 3}},

      {"widget": {"name": "kpi-age",
        "queries": [{"name": "main_query", "query": {"datasetName": "ds_kpi", "disaggregated": true,
          "fields": [{"name": "data_age_minutes", "expression": "`data_age_minutes`"}]}}],
        "spec": {"version": 2, "widgetType": "counter",
          "encodings": {"value": {"fieldName": "data_age_minutes", "displayName": "Data age", "format": {"type": "number-plain"}, "formatTemplate": "{{@formatted}} min"}},
          "frame": {"showTitle": true, "title": "Data age"}}},
       "position": {"x": 9, "y": 2, "width": 3, "height": 3}},

      {"widget": {"name": "map-segments",
        "queries": [{"name": "main_query", "query": {"datasetName": "ds_map", "disaggregated": true,
          "fields": [{"name": "lat", "expression": "`lat`"}, {"name": "lon", "expression": "`lon`"},
                     {"name": "risk_level", "expression": "`risk_level`"}, {"name": "road_segment_id", "expression": "`road_segment_id`"},
                     {"name": "road_number", "expression": "`road_number`"}, {"name": "icing_score", "expression": "`icing_score`"}]}}],
        "spec": {"version": 2, "widgetType": "symbol-map",
          "encodings": {
            "coordinates": {"latitude": {"fieldName": "lat"}, "longitude": {"fieldName": "lon"}},
            "color": {"fieldName": "risk_level", "displayName": "Risk level",
              "scale": {"type": "categorical", "mappings": [
                {"value": "LOW", "color": "#4C9A6A"}, {"value": "MEDIUM", "color": "#E3B23C"},
                {"value": "HIGH", "color": "#E07A2F"}, {"value": "VERY_HIGH", "color": "#B3261E"}]}}},
          "mark": {"opacity": 0.85},
          "frame": {"showTitle": true, "title": "Segment icing risk"}}},
       "position": {"x": 0, "y": 5, "width": 8, "height": 8}},

      {"widget": {"name": "map-stations",
        "queries": [{"name": "main_query", "query": {"datasetName": "ds_stations", "disaggregated": true,
          "fields": [{"name": "lat", "expression": "`lat`"}, {"name": "lon", "expression": "`lon`"},
                     {"name": "station_status", "expression": "`station_status`"}, {"name": "name", "expression": "`name`"}]}}],
        "spec": {"version": 2, "widgetType": "symbol-map",
          "encodings": {
            "coordinates": {"latitude": {"fieldName": "lat"}, "longitude": {"fieldName": "lon"}},
            "color": {"fieldName": "station_status", "displayName": "Station",
              "scale": {"type": "categorical", "mappings": [
                {"value": "Reporting", "color": "#4C9A6A"}, {"value": "Stale", "color": "#9AA3AD"}]}}},
          "mark": {"opacity": 0.9},
          "frame": {"showTitle": true, "title": "Stations: reporting or stale"}}},
       "position": {"x": 8, "y": 5, "width": 4, "height": 8}},

      {"widget": {"name": "incidents-table",
        "queries": [{"name": "main_query", "query": {"datasetName": "ds_incidents", "disaggregated": true,
          "fields": [{"name": "start_time", "expression": "`start_time`"}, {"name": "incident_type", "expression": "`incident_type`"},
                     {"name": "severity", "expression": "`severity`"}, {"name": "road_number", "expression": "`road_number`"},
                     {"name": "road_segment_id", "expression": "`road_segment_id`"}]}}],
        "spec": {"version": 2, "widgetType": "table",
          "encodings": {"columns": [
            {"fieldName": "start_time", "displayName": "Start"}, {"fieldName": "incident_type", "displayName": "Type"},
            {"fieldName": "severity", "displayName": "Severity"}, {"fieldName": "road_number", "displayName": "Road"},
            {"fieldName": "road_segment_id", "displayName": "Segment"}]},
          "frame": {"showTitle": true, "title": "Active incidents (DATEX II)"}}},
       "position": {"x": 0, "y": 13, "width": 12, "height": 5}},

      {"widget": {"name": "footer", "multilineTextboxSpec": {"lines": ["Legend: LOW green, MEDIUM yellow, HIGH orange, VERY_HIGH red. Station dot: green reporting within 30 min, grey stale. Sources: Statens vegvesen (NLOD), MET Norway (CC BY 4.0).\n"]}},
       "position": {"x": 0, "y": 18, "width": 12, "height": 1}}
     ]}
  ],
  "uiSettings": {"theme": {
    "canvasBackgroundColor": {"light": "#F4F6F8", "dark": "#1F272D"},
    "widgetBackgroundColor": {"light": "#FBFCFD", "dark": "#11171C"},
    "widgetBorderColor": {"light": "#D8DEE6", "dark": "#11171C"},
    "fontColor": {"light": "#12233A", "dark": "#E8ECF0"},
    "selectionColor": {"light": "#2272B4", "dark": "#8ACAFF"},
    "visualizationColors": ["#4C9A6A", "#E3B23C", "#E07A2F", "#B3261E", "#4E5185", "#9AA3AD"],
    "widgetHeaderAlignment": "LEFT"}}
}
```

2. The other three files use the same skeleton. Deltas only:

| File | Datasets | Widgets (type, dataset, position) | Parameters |
|---|---|---|---|
| `road_detail.lvdash.json` | `ds_header`, `ds_risk_types`, `ds_drivers`, `ds_station_readings`, `ds_recent_incidents`, `ds_risk_history` | title text (12x2); filter `filter-single-select` bound to parameter `road_segment_id` on every dataset, list of ids from `ds_map`-style query `SELECT DISTINCT road_segment_id FROM road_segment_current_risk` (4x2); header counter `risk_score` with `formatTemplate "{{risk_level}} · {{road_number}} · updated {{updated_minutes_ago}} min ago · station {{station_name}}"` (8x2); table `ds_risk_types` (4x4); horizontal `bar` v3 `ds_drivers` with `x` quantitative `contribution`, `y` categorical `factor` (8x4); table `ds_station_readings` (4x5); table `ds_recent_incidents` (8x5); `line` v3 `ds_risk_history` x temporal `risk_updated_at`, y `icing_score` (12x5) | `road_segment_id` STRING, `defaultSelection: {"values": {"dataType": "STRING", "values": [{"value": "<a real id>"}]}}` declared on all six datasets |
| `priority_list.lvdash.json` | `ds_priority`, `ds_road_numbers` | title text; `filter-multi-select` bound to parameter `road_number` (MULTI) with the value list from `ds_road_numbers` (4x2); `filter-single-select` bound to parameter `surface_max_c` (4x2); text "Ranked by icing score, then road class. Post-MVP: closure and accident risk add columns" (4x2); table `ds_priority` columns rank, road_segment_id, road_number, icing_score, risk_level, surface_c, precip, main_drivers, risk_updated_at with a `style` rule colouring `icing_score` >= 0.7 (12x10) | `road_number` STRING `complexType: MULTI` default `[]`; `surface_max_c` DECIMAL default `1.0` |
| `platform_health.lvdash.json` | `ds_freshness`, `ds_freshness_trend`, `ds_quarantine_today`, `ds_dq_rules`, `ds_latency`, `ds_pipeline_runs` | title text; table `ds_freshness` with a `style` rule on the `status` column: operand `data-value` `STALE`, operator `=`, red background (12x5); counters: quarantined today (`sum(rows_today)` over `ds_quarantine_today`, `disaggregated: false`), unmapped observations (same dataset with a widget-level `filters: [{"expression": "`quarantine_table` = 'unmapped_observations'"}]`, verify the filter shape in the skill's widget spec), `latency_median_s` with `formatTemplate "{{@formatted}} s"`, `runs_ok` with `formatTemplate "{{@formatted}} of {{runs_today}} ok"` (4 x 3x3); `bar` v3 `ds_quarantine_today` x categorical `rule`, y `rows_today`, colour `quarantine_table` (6x5); `line` v3 `ds_freshness_trend` x temporal `computed_at`, y `ingestion_delay_min` (6x5); table `ds_dq_rules` (12x4); text "Threshold: 30 min for the 10-minute stream, 60 min incidents, 8 days NVDB, 60 days elevation" (12x1) | `orchestrate_job_id` INTEGER if the system-table variant is used |

   verify: a `filter-single-select` bound to a STRING parameter renders as a free-text box; if the UI needs a value list, add a second query in the filter widget that reads `road_segment_id` from a helper dataset, as in the skill's "Date Range Filtering" example (field plus parameter in one widget).
3. Validate the JSON files before deploying: `for f in src/dashboards/*.lvdash.json; do jq empty "$f" && echo "ok $f"; done`.

Expect: `jq` prints `ok` four times. After T6.6, the risk map shows tiles with numbers, a map with coloured dots over Troms, a second map of station dots, and an incidents table (possibly empty on a quiet day).

If it fails:
- "failed to parse serialized dashboard": a `queryLines` element without trailing `\n`, or a `query` string instead of `queryLines`, or a missing `pageType`.
- Counter shows "unsupported widget definition": a `color` on the counter value. Remove it.
- Map empty but table fine: `lat`/`lon` NULL for every row (`silver.road_segments` on this target predates the centroid columns; run `reference`, T6.3).
- Widget shows "no selected fields to visualize": a `fields[].name` does not match its `encodings.*.fieldName`.

---

### T6.6 Bundle resource, deploy, open      owner: Safiul
Why: dashboards are code. The bundle creates them, sets the warehouse, fills in catalog and schema, sets permissions and publishes.

Do:
1. The variables are already in `databricks.yml` (README table; 05_M4 T4.7 shows the file): `warehouse_name` (default `"Serverless Starter Warehouse"`, verify with `databricks warehouses list --profile frostsight-free`) and `warehouse_id` as `lookup: {warehouse: "${var.warehouse_name}"}`, resolved by name at deploy time. Nothing to add; if the lookup fails, see "If it fails".

2. Create `resources/dashboards.dashboard.yml`:

```yaml
resources:
  dashboards:
    risk_map:
      display_name: "FrostSight · Risk map"
      file_path: ../src/dashboards/risk_map.lvdash.json
      warehouse_id: ${var.warehouse_id}
      dataset_catalog: ${var.catalog}
      dataset_schema: gold
      embed_credentials: true
      permissions:
        - level: CAN_READ
          group_name: users
    road_detail:
      display_name: "FrostSight · Road detail"
      file_path: ../src/dashboards/road_detail.lvdash.json
      warehouse_id: ${var.warehouse_id}
      dataset_catalog: ${var.catalog}
      dataset_schema: gold
      embed_credentials: true
      permissions: [{level: CAN_READ, group_name: users}]
    priority_list:
      display_name: "FrostSight · Gritting priority"
      file_path: ../src/dashboards/priority_list.lvdash.json
      warehouse_id: ${var.warehouse_id}
      dataset_catalog: ${var.catalog}
      dataset_schema: gold
      embed_credentials: true
      permissions: [{level: CAN_READ, group_name: users}]
    platform_health:
      display_name: "FrostSight · Platform health"
      file_path: ../src/dashboards/platform_health.lvdash.json
      warehouse_id: ${var.warehouse_id}
      dataset_catalog: ${var.catalog}
      dataset_schema: gold
      embed_credentials: true
      permissions: [{level: CAN_READ, group_name: users}]
```

   Notes. `dataset_catalog` and `dataset_schema` need Databricks CLI 0.281.0 or newer (`databricks -v`). Dashboard permission levels are `CAN_READ`, `CAN_RUN`, `CAN_EDIT`, `CAN_MANAGE`; `CAN_VIEW` is the job level and is rejected on a dashboard. All three targets are `mode: development`; `free` and `aws` set `presets.name_prefix: ""` so the display names appear as written, `personal` keeps the `[dev <user>]` prefix (README section 2).
3. Validate, deploy, open:

```bash
cd project
databricks bundle validate --strict -t free --profile frostsight-free
databricks bundle deploy -t free --profile frostsight-free
databricks bundle summary -t free --profile frostsight-free      # prints each dashboard's URL and id
databricks bundle open risk_map -t free --profile frostsight-free
```

4. Iterating: edit the JSON, deploy again. If someone edited the dashboard in the UI, the next deploy refuses with "dashboard was modified remotely". Either pull the UI changes back into the file with `databricks bundle generate dashboard --resource risk_map -t free --profile frostsight-free` (add `--watch` to keep pulling while you edit in the UI), or discard them with `databricks bundle deploy -t free --force --profile frostsight-free`. verify: the DABs reference documents `bundle generate dashboard <dashboard-id>`; the `--resource` and `--watch` forms come from the CLI (`databricks bundle generate dashboard --help`).

Expect: `bundle summary` lists four dashboards with URLs of the form `https://<host>/sql/dashboardsv3/<id>/published`. Opening one shows data within 10 seconds (first warehouse start can take a minute).

If it fails:
- `warehouse_id` lookup fails: name mismatch; run `databricks warehouses list` and paste the id as a plain `default:` for now.
- A widget shows a red icon: open the dashboard in edit mode, click the widget, read the SQL error. It is almost always a name: a silver or quarantine table referenced directly instead of through its `v_` view, or the test query used full names that were not stripped.
- `permissions: group users not found`: on `personal` targets there is one user; drop the permissions block there with a target override (`targets.personal.resources.dashboards.risk_map.permissions: []`).
- `warehouse_id` lookup: `${var.warehouse_name}` inside `lookup` not interpolated on your CLI version: write the name literally in `lookup: {warehouse: ...}` and note it in `09b_review_M4_M7.md`.

---

### T6.7 CI deploy on `main`      owner: Rayhan
Why: "deploys from the repo" is in the definition of done. On Free Edition there are no service principals, so CI authenticates as a user.

Do:
1. The workflows exist from M2 (03_M2 T2.4): `ci.yml` (ruff, pytest, `bundle validate -t free --strict` on every PR), `deploy-free.yml` (`bundle deploy -t free --auto-approve` on push to `main`, `concurrency: deploy-free`) and `deploy-aws.yml` (manual). Secrets: `DATABRICKS_HOST` and `DATABRICKS_TOKEN` (the admin's PAT, `databricks tokens create --lifetime-seconds 7776000`). Rotate the token before it expires (90 days) and update the repository secret.
2. This milestone adds the dashboards to what CI deploys; nothing changes in the workflow. Two things to check once:
   - the `warehouse_id` lookup resolves under the token user (CI logs `Deployment complete!` with no lookup error);
   - `databricks bundle summary -t free` printed by a step after deploy shows four dashboards.
3. Prove it: branch `feature/m6-ci-title`, change `display_name` of `risk_map` to "FrostSight · Risk map (Troms)", open a PR, merge. Watch the Actions run, then `databricks bundle summary -t free --profile frostsight-free` shows the new name and the workspace shows the renamed dashboard.

Expect: the workflow is green in under three minutes; the dashboard is renamed; the run log ends with "Deployment complete!".

If it fails:
- `Error: cannot resolve bundle auth configuration`: the two env vars are missing or the token expired.
- `Error: deployment lock`: a previous run was cancelled mid-deploy. `databricks bundle deploy -t free --force-lock --profile frostsight-free` once, from a laptop.
- The deploy runs as a different user than the one who deployed by hand at T6.6: the bundle state is per target, not per user, so it is fine; but the dashboards' owner changes to the token user. Use the admin's token.
- Token creation is not available on your Free Edition workspace: CI cannot deploy on `free`; document a manual deploy from a laptop and let `deploy-aws.yml` prove the CI path on `aws`.

---

### T6.8 Genie space (optional)      owner: Safiul
Why: a natural-language layer over gold is a five-minute demo win. Not in the MVP.

Do:
1. In the workspace: Genie > New. Name "FrostSight". Warehouse: the 2X-Small.
2. Tables: `gold.road_segment_current_risk`, `gold.road_segment_risk_history`, `gold.incident_summary`, `gold.historical_closures`, `gold.road_weather_summary`, `silver.road_segments`, `silver.road_weather_stations`. Nothing from bronze or quarantine.
3. Instructions box: "Risk levels are LOW, MEDIUM, HIGH, VERY_HIGH. `risk_score` is 0 to 1. Join risk to segments on `road_segment_id`. Times are UTC. Pilot county is Troms."
4. Sample questions to save: "Which E8 segments are HIGH right now?", "How many segments changed level in the last hour?", "Which segments were closed most often last winter?", "Average surface temperature by hour of day on Fv 91 in January."
5. Ask each sample question once; fix the generated SQL where Genie guesses wrong and save it as a trusted asset.
6. Link it from the dashboards: in each `.lvdash.json` add `"genieSpace": {"isEnabled": true, "overrideId": "<space id>", "enablementMode": "ENABLED"}` under `uiSettings`. The space id is in its URL.

Expect: the four sample questions return sensible tables; the "Ask Genie" button appears on the risk map.
If it fails: Genie is not available on the workspace (skip, it is optional); a question joins on the wrong column (add the join rule to the instructions box and save the corrected SQL as a trusted asset).

---

### T6.9 Grants and viewer credentials      owner: Rayhan
Why: dashboards publish with embedded credentials, so viewers need only dashboard `CAN_READ`. Analysts who query gold in the SQL editor (WR-UC-17, 19) need table grants.

Do:
1. Run once per target (the `personal` target has a single user; skip there):

```sql
GRANT USE CATALOG ON CATALOG frostsight TO `users`;
GRANT USE SCHEMA ON SCHEMA frostsight.gold TO `users`;
GRANT SELECT ON SCHEMA frostsight.gold TO `users`;
GRANT USE SCHEMA ON SCHEMA frostsight.silver TO `users`;
GRANT SELECT ON SCHEMA frostsight.silver TO `users`;
SHOW GRANTS ON SCHEMA frostsight.gold;
```

   Put the statements in `src/sql/grants.sql` so M7's platform runbook can point at them. Bronze and quarantine stay owner-only; the gold views from T6.4 step 2 expose the few silver and quarantine columns the dashboards need.
2. Embedded credentials, plainly: with `embed_credentials: true` the published dashboard runs every query as the user who deployed (the CI token user). Viewers see data without table grants, and the query history shows the publisher. With `false`, each viewer runs the queries as themselves and needs the grants above. `free` uses `true`; on `aws` set it per target if the audit trail matters.
3. Check as a second team member: open the published URL, tiles load; open the SQL editor, `SELECT count(*) FROM frostsight.gold.road_segment_current_risk` works; `SELECT count(*) FROM frostsight.bronze.road_weather_events` is denied.

Expect: exactly that. `SHOW GRANTS` lists `users` with `SELECT` and `USE SCHEMA` on gold and silver.

If it fails: `PERMISSION_DENIED ... USE CATALOG`: the catalog grant is missing; grants do not cascade upward.

---

### T6.10 Developing against a personal workspace      owner: Safiul
Why: the team workspace has one warehouse and one pipeline; dashboard iteration should not compete with them.

Do:
1. Fill your personal metastore: `databricks bundle run reference -t personal --profile frostsight-personal` (silver reference tables), `databricks bundle run ingest -t personal --profile frostsight-personal` over the landed fixtures (05_M4 T4.10), then `databricks bundle run orchestrate -t personal --profile frostsight-personal` for gold, and `002_gold_views.sql` in the SQL editor. There is no separate gold fixture loader.
2. `databricks bundle deploy -t personal --profile frostsight-personal` deploys the four dashboards against the same names in your own catalog. The `personal` target is `mode: development`, so they are prefixed `[dev <you>]`.
3. Edit in the UI if you like the visual editor, then `databricks bundle generate dashboard --resource risk_map -t personal --watch` to write the JSON back into `src/dashboards/`. Commit that file; `free` gets it through CI.

Expect: the same JSON renders on both targets. The only visible difference is the data.
If it fails: empty widgets on `personal` (no gold rows yet: run `orchestrate` there once; or `002_gold_views.sql` not applied); `warehouse_id` lookup fails on `personal` (the warehouse name differs in your own workspace: `databricks warehouses list --profile frostsight-personal`, then override `warehouse_name` under `targets.personal.variables`).

---

## Done when

- [ ] `gold.data_quality_summary` has four rows with the 03_M2 columns and is rewritten by every `orchestrate` run; `silver.data_quality_events` fills after each pipeline update; `quarantine.late_road_weather` exists.
- [ ] `silver.road_segments.centroid_lat/lon` populated for every pilot-county segment (written by `reference`).
- [ ] `src/sql/002_gold_views.sql` applied on every target; dashboard SQL uses bare names only.
- [ ] Every dataset query in T6.4 ran through the CLI and returned rows.
- [ ] Four `.lvdash.json` files in `src/dashboards/`, `jq` clean, deployed by `resources/dashboards.dashboard.yml`.
- [ ] The four published dashboards open for a non-admin team member and show data.
- [ ] `deploy-free.yml` is green on `main` and a title change through a PR reached the workspace.
- [ ] Grants in `src/sql/grants.sql` applied on `free`.
- [ ] Optional: Genie space with four trusted questions, linked from the dashboards.

## Verify

```bash
cd project
databricks bundle validate --strict -t free --profile frostsight-free
databricks bundle summary -t free --profile frostsight-free | grep -A2 dashboards
q "SELECT source, status, round(ingestion_delay_min) AS delay_min FROM frostsight.gold.data_quality_summary ORDER BY 1"
q "SELECT count(DISTINCT run_id) AS runs, max(event_time) FROM frostsight.silver.data_quality_events WHERE event_time >= current_date()"
q "SHOW VIEWS IN frostsight.gold"
q "SELECT count(*) AS n, sum(CASE WHEN centroid_lat IS NULL THEN 1 ELSE 0 END) AS missing FROM frostsight.silver.road_segments"
q "SHOW GRANTS ON SCHEMA frostsight.gold"
gh run list --workflow deploy-free.yml --limit 3
for f in src/dashboards/*.lvdash.json; do jq empty "$f" && echo "ok $f"; done
```

Expected: validate prints no warnings; summary shows four dashboards with URLs; freshness shows `road_weather FRESH`; `missing` is 0; six `v_` views; the last `deploy-free` run is `completed success`; `jq` prints `ok` four times.
