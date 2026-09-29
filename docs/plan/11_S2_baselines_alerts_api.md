# S2: Baselines and anomalies, alert delivery, API

Owners: Sani (Part 1, baselines and anomalies), Rayhan (Part 2, alerts), Safiul (Part 3, API app). Read
`00_README.md` first. The three parts are independent: each can ship alone, in any order, and none changes
the M5 to M7 contracts that the dashboards rely on.

Inputs from M7 (08_M7 T7.9 handover row "S2"): `gold.road_segment_risk_history` kept for the whole winter
(`optimize_tables.py` runs `VACUUM` with the default 7-day retention, which removes old files, not rows;
history rows stay), `gold.road_weather_summary` history, `gold.data_quality_summary` as the first alert
source, `src/sql/grants.sql` for the API's service identity. Last winter's observations reach
`silver.road_weather_observations` only through the replay harness (`replay__backfill_<yyyymmdd>__*.jsonl`,
`_batch_id = replay:backfill_<yyyymmdd>`, 03_M2 T2.6 `--from/--to` mode); Part 1 assumes that backfill ran.

Free Edition facts this file leans on (README section 2): one 2X-Small serverless SQL warehouse shared by
dashboards, alerts and the API; 5 concurrent job tasks per account; up to 3 Databricks Apps; no user-created
service principals (an app still gets its own, created by the platform).

Task ids are `S2.<part>.<n>`.

---

# Part 1: Historical baselines and anomalies      owner: Sani

Goal: `gold.historical_baselines` answers WR-UC-12 ("is this drop unusual for this segment") and WR-UC-16
("when does the surface typically dip below 0 here"); `gold.road_segment_anomalies` carries the current
3-hour drop against the historical 95th percentile, refreshed every 10 minutes; the road-detail dashboard
shows it as one tile.

Decisions:

| Decision | Choice | Why |
|---|---|---|
| Grain | One row per (`station_id`, `road_segment_id`, `month`, `hour_of_day`); station-only rows carry `road_segment_id = NULL` | Spec section 13 asks for month and hour profiles; stations are the measuring unit, segments are what users ask about |
| Source rows | Every silver observation, live or replayed, except `_batch_id LIKE 'replay:latest_%'` (the M4 late-file test re-emits) | Last winter is only in silver as replay rows; the M5 rule "scheduled gold ignores replay" is for *current* risk, not for history |
| Percentiles | `percentile_approx` | Approximate is fine at 4,464 readings per station-month; exact `percentile` would shuffle the whole season |
| 3-hour drop p95 | `percentile_approx(temperature_change_3h, 0.05)`, stored negative | The 5th percentile of the *change* is the 95th percentile of the *drop*; matches the spec example (`-4.3 °C`) |
| Closures | Per (`road_segment_id`, `month`) from `gold.historical_closures`; repeated on every hour row of that month | Closures are too sparse for an hourly grain; a monthly count and mean duration is what WR-UC-17 needs |
| Traffic | `typical_traffic_volume` present and always NULL | Traffic is cut (README section 5); the column keeps the spec shape for S3 and a later trafikkdata batch |
| Refresh | Weekly, as a third serial task in the `reference` job | Baselines change by a rounding error per week |
| Anomaly step | Folded into `build_gold.py` as step 5, no new task | Free Edition allows 5 concurrent tasks; `orchestrate` must stay at 3 (06_M5 T5.5). One join on 30 rows costs nothing |
| Anomaly table | New `gold.road_segment_anomalies`, one row per segment | Keeps the `gold.road_segment_current_risk` contract (M5, M6 dashboards, Part 3 API) untouched |

### S2.1.1 Pure baseline functions      owner: Sani
Why: the statistics must be unit-testable without a workspace, like `windows.py` and `risk.py`.
Do:
  1. Create `src/frostsight/baselines.py`:

```python
"""Historical baselines (spec section 13) and the drop anomaly (WR-UC-12). Pure PySpark; no SparkSession here."""
from __future__ import annotations

from pyspark.sql import DataFrame
from pyspark.sql import functions as F

from frostsight.windows import with_trends

COLUMNS = [  # gold.historical_baselines, in order
    ("road_segment_id", "STRING"), ("station_id", "STRING"), ("month", "INT"), ("hour_of_day", "INT"),
    ("n_obs", "BIGINT"), ("seasons", "INT"),
    ("surface_mean_c", "DOUBLE"), ("surface_p05_c", "DOUBLE"), ("surface_p50_c", "DOUBLE"), ("surface_p95_c", "DOUBLE"),
    ("drop_3h_p95_c", "DOUBLE"),
    ("closure_count", "BIGINT"), ("closure_freq_per_month", "DOUBLE"), ("closure_mean_duration_min", "DOUBLE"),
    ("typical_traffic_volume", "DOUBLE"),
    ("history_from", "TIMESTAMP"), ("history_to", "TIMESTAMP"), ("computed_at", "TIMESTAMP"),
]
KEYS = ["road_segment_id", "station_id", "month", "hour_of_day"]
DDL = ", ".join(f"{c} {t}" for c, t in COLUMNS)


def station_baselines(obs: DataFrame) -> DataFrame:
    """Per (station, month, hour_of_day). Needs station_id, event_time, road_surface_temperature_c."""
    t = with_trends(obs).select("station_id", "event_time", "road_surface_temperature_c", "temperature_change_3h")
    keyed = t.withColumn("month", F.month("event_time")).withColumn("hour_of_day", F.hour("event_time"))
    return (keyed.groupBy("station_id", "month", "hour_of_day")
            .agg(F.count("road_surface_temperature_c").alias("n_obs"),
                 F.countDistinct(F.year("event_time")).cast("int").alias("seasons"),
                 F.avg("road_surface_temperature_c").alias("surface_mean_c"),
                 F.percentile_approx("road_surface_temperature_c", 0.05).alias("surface_p05_c"),
                 F.percentile_approx("road_surface_temperature_c", 0.50).alias("surface_p50_c"),
                 F.percentile_approx("road_surface_temperature_c", 0.95).alias("surface_p95_c"),
                 # 5th percentile of the 3 h change = 95th percentile of the 3 h drop, kept negative (spec example: -4.3 °C)
                 F.percentile_approx("temperature_change_3h", 0.05).alias("drop_3h_p95_c"),
                 F.min("event_time").alias("history_from"), F.max("event_time").alias("history_to")))


def closure_baselines(closures: DataFrame) -> DataFrame:
    """Per (segment, month) from gold.historical_closures: road_segment_id, start_time, duration_min."""
    return (closures.withColumn("month", F.month("start_time"))
            .groupBy("road_segment_id", "month")
            .agg(F.count("*").alias("closure_count"), F.avg("duration_min").alias("closure_mean_duration_min")))


def assemble(station_rows: DataFrame, lookup: DataFrame, closure_rows: DataFrame) -> DataFrame:
    """Segment rows (station joined through the lookup, closures joined by segment and month) plus station-only rows."""
    per_segment = (station_rows.join(lookup.select("station_id", "road_segment_id"), "station_id", "inner")
                   .join(closure_rows, ["road_segment_id", "month"], "left"))
    per_station = station_rows.withColumn("road_segment_id", F.lit(None).cast("string"))
    out = per_segment.unionByName(per_station, allowMissingColumns=True)
    return (out.withColumn("closure_count", F.coalesce(F.col("closure_count"), F.lit(0)).cast("bigint"))
               .withColumn("closure_freq_per_month", F.col("closure_count") / F.col("seasons"))
               .withColumn("typical_traffic_volume", F.lit(None).cast("double"))     # traffic is cut from scope
               .withColumn("computed_at", F.current_timestamp())
               .select(*[c for c, _ in COLUMNS]))


def with_anomaly(scored: DataFrame, baselines: DataFrame) -> DataFrame:
    """Current 3 h change per segment against the baseline for the same month and hour. Rows without a
    baseline keep NULL ratios and FALSE flags. drop_ratio 1.42 means the drop is 42 % steeper than the p95."""
    base = (baselines.where(F.col("road_segment_id").isNotNull())
            .select("road_segment_id", "month", "hour_of_day", "drop_3h_p95_c", "surface_p05_c", "n_obs"))
    cur = (scored.withColumn("month", F.month("event_time")).withColumn("hour_of_day", F.hour("event_time"))
           .join(base, ["road_segment_id", "month", "hour_of_day"], "left"))
    both_negative = (F.col("temperature_change_3h") < 0) & (F.col("drop_3h_p95_c") < 0)
    return (cur.select("road_segment_id", "station_id", "event_time", "temperature_change_3h",
                       F.col("drop_3h_p95_c").alias("baseline_drop_3h_p95_c"),
                       "road_surface_temperature_c", F.col("surface_p05_c").alias("baseline_surface_p05_c"),
                       F.col("n_obs").alias("baseline_n_obs"))
            .withColumn("drop_ratio", F.when(both_negative, F.col("temperature_change_3h") / F.col("baseline_drop_3h_p95_c")))
            .withColumn("drop_anomaly_pct", F.round((F.col("drop_ratio") - 1) * 100, 0))
            .withColumn("is_unusual_drop", F.coalesce(F.col("drop_ratio") >= 1.0, F.lit(False)))
            .withColumn("is_unusual_cold", F.coalesce(F.col("road_surface_temperature_c") < F.col("baseline_surface_p05_c"), F.lit(False)))
            .withColumn("computed_at", F.current_timestamp()))
```

Expect: `uv run python -c "from frostsight.baselines import DDL; print(DDL[:60])"` prints the first columns.
If it fails: `with_trends` import error (M5 `windows.py` missing on the branch); `percentile_approx` needs
PySpark 3.1+ (local is 3.5).

### S2.1.2 Weekly job script      owner: Sani
Why: the pure functions need a reader, a MERGE and a table.
Do:
  1. Create `src/jobs/build_baselines.py`:

```python
"""build_baselines: gold.historical_baselines from the whole silver history. Weekly, third task of `reference`."""
from __future__ import annotations

import argparse

from delta.tables import DeltaTable
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F

from frostsight.baselines import DDL, KEYS, assemble, closure_baselines, station_baselines

spark = SparkSession.builder.getOrCreate()


def merge(df: DataFrame, table: str, keys: list[str]) -> None:
    cond = " AND ".join(f"t.{k} <=> s.{k}" for k in keys)          # <=> so the NULL road_segment_id rows match
    (DeltaTable.forName(spark, table).alias("t").merge(df.alias("s"), cond)
     .whenMatchedUpdateAll().whenNotMatchedInsertAll().execute())


def build(catalog: str, min_obs: int) -> None:
    spark.sql(f"CREATE TABLE IF NOT EXISTS {catalog}.gold.historical_baselines ({DDL}) CLUSTER BY (road_segment_id, month)")
    obs = (spark.read.table(f"{catalog}.silver.road_weather_observations")
           .where(~F.col("_batch_id").startswith("replay:latest_"))       # M4 late-file re-emits are not history
           .select("station_id", "event_time", "road_surface_temperature_c"))
    lookup = (spark.read.table(f"{catalog}.silver.station_segment_lookup")
              .select("station_id", "road_segment_id").dropDuplicates(["road_segment_id"]))   # same rule as build_gold
    closures = (spark.read.table(f"{catalog}.gold.historical_closures")
                .select("road_segment_id", "start_time", "duration_min"))
    rows = assemble(station_baselines(obs), lookup, closure_baselines(closures)).where(F.col("n_obs") >= min_obs)
    merge(rows, f"{catalog}.gold.historical_baselines", KEYS)
    print(f"baselines: rows={rows.count()} stations={rows.select('station_id').distinct().count()}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--catalog", required=True)
    p.add_argument("--min-obs", type=int, default=20)     # below this a (month, hour) cell is noise, not a baseline
    a = p.parse_args()
    build(a.catalog, a.min_obs)
```

  2. Add the task to `resources/reference.job.yml`, after `optimize_gold` (06_M5 T5.5 step 2):

```yaml
        - task_key: build_baselines
          depends_on: [ { task_key: optimize_gold } ]
          run_if: ALL_DONE
          environment_key: geo
          timeout_seconds: 1200
          spark_python_task:
            python_file: ../src/jobs/build_baselines.py
            parameters: [ "--catalog", "${var.catalog}" ]
```

     Task budget. `reference` now has three tasks, serial; `orchestrate` has three, serial. The Free Edition
     limit counts task runs *running* at the same moment, and a serial chain runs one task at a time, so on
     Monday 03:00 UTC the peak is 2 (3 if `predict`, S3, is still running at :35). The full schedule table
     for all jobs is in `13_stretch_review.md`. verify: after the first Monday run,
     `databricks jobs list-runs --active-only --profile frostsight-free` during 03:00 to 03:15 shows both jobs
     running and no run waiting on a concurrency limit (`state.life_cycle_state` `QUEUED` or a
     `RESOURCE_EXHAUSTED` message). If it does queue, move this task into its own
     `resources/baselines.job.yml` (one task, cron `"0 20 3 ? * TUE"`, same `environments` block, minute 20 so
     it avoids `predict` at :35 and the `orchestrate` start at :00) instead of shortening the chain.
  3. First run by hand, then let the schedule take over:

```bash
cd project
databricks bundle validate --strict -t personal --profile frostsight-personal
databricks bundle deploy -t personal --profile frostsight-personal
databricks bundle run reference -t personal --profile frostsight-personal
```

Expect: the task prints `baselines: rows=<n> stations=30`; `SELECT count(*) FROM frostsight.gold.historical_baselines`
is about 30 stations x 2 (segment and station rows) x months of history x 24 hours: with a five-month replayed
winter about 7,200 rows.
If it fails: zero rows (no history in silver on this target: run the harness backfill from 03_M2 T2.6 first,
`--from 2025-11-01 --to 2026-04-01 --speed 0`); `TABLE_OR_VIEW_NOT_FOUND gold.historical_closures` (`build_gold`
never ran here); MERGE "multiple source rows matched" (the lookup had two stations for one segment and the
`dropDuplicates` line was removed).

### S2.1.3 Anomaly step inside build_gold      owner: Sani
Why: WR-UC-12 wants the comparison every 10 minutes, and the chain may not grow.
Do:
  1. In `src/jobs/build_gold.py` (06_M5 T5.4) add to `GOLD_DDL`:

```python
    "road_segment_anomalies": """
        road_segment_id STRING, station_id STRING, event_time TIMESTAMP, temperature_change_3h DOUBLE,
        baseline_drop_3h_p95_c DOUBLE, road_surface_temperature_c DOUBLE, baseline_surface_p05_c DOUBLE,
        baseline_n_obs BIGINT, drop_ratio DOUBLE, drop_anomaly_pct DOUBLE, is_unusual_drop BOOLEAN,
        is_unusual_cold BOOLEAN, computed_at TIMESTAMP""",
```

     and `"road_segment_anomalies": "road_segment_id"` to `CLUSTER`. Add the import
     `from frostsight.baselines import with_anomaly` and this function:

```python
def anomalies(catalog: str, scored: DataFrame) -> None:
    """S2 step 5: current 3 h drop versus the historical p95 (WR-UC-12). Folded in here, not a fourth task:
    Free Edition allows 5 concurrent tasks and the orchestrate chain stays at 3 (06_M5 T5.5)."""
    base = f"{catalog}.gold.historical_baselines"
    if not spark.catalog.tableExists(base):
        print("no baselines yet (reference job S2.1.2 has not run); anomalies skipped")
        return
    merge(with_anomaly(scored, spark.read.table(base)), f"{catalog}.gold.road_segment_anomalies", ["road_segment_id"])
```

     Call it in `build()` right after the history MERGE (`merge(scored, ..., HISTORY_KEY, insert_only=True)`,
     06_M5 T5.4): `anomalies(catalog, scored)`. `build_replay` (`--event-id`) does not call it: anomalies are a
     "now" table, like current risk.
  2. The tile SQL for the road-detail dashboard (07_M6 T6.4 rules: bare names, gold only), dataset
     `ds_anomaly`, parameter `:road_segment_id`:

```sql
SELECT a.road_segment_id,
       round(a.temperature_change_3h, 1) AS drop_3h_c,
       round(a.baseline_drop_3h_p95_c, 1) AS baseline_p95_c,
       a.drop_anomaly_pct,
       CASE WHEN a.baseline_n_obs IS NULL THEN 'No baseline for this hour'
            WHEN a.is_unusual_drop THEN concat('Unusual: ', a.drop_anomaly_pct, ' % steeper than the p95 drop')
            WHEN a.temperature_change_3h < 0 THEN 'Normal for this segment and hour'
            ELSE 'Not dropping' END AS verdict,
       b.surface_p50_c AS typical_surface_c, b.closure_freq_per_month, b.closure_mean_duration_min
FROM road_segment_anomalies a
LEFT JOIN historical_baselines b
  ON b.road_segment_id = a.road_segment_id AND b.month = month(a.event_time) AND b.hour_of_day = hour(a.event_time)
WHERE a.road_segment_id = :road_segment_id
```

     Widget: `counter` v2 on `drop_3h_c` with `formatTemplate "{{@formatted}} °C in 3 h · p95 {{baseline_p95_c}} °C · {{verdict}}"`,
     title "Is this drop unusual", 4x3 next to `ds_station_readings` in `road_detail.lvdash.json`. Test the
     query with `q` (07_M6 T6.4 step 1) before editing the JSON. A second dataset for WR-UC-16, `ds_profile`
     (`line` v3, x `hour_of_day`, y `surface_p50_c`, colour `month`):
     `SELECT month, hour_of_day, surface_p50_c, surface_p05_c FROM historical_baselines WHERE road_segment_id = :road_segment_id ORDER BY month, hour_of_day`.

Expect: after the next `orchestrate` run, `SELECT count(*) FROM frostsight.gold.road_segment_anomalies` equals
the current-risk row count; in autumn every `is_unusual_drop` is `false` and the tile reads "Normal" or
"Not dropping"; on the replayed storm day (08_M7 T7.8) the tile turns to "Unusual: +40 %"-style text for the
segments that went VERY_HIGH.
If it fails: the anomaly table stays empty and the log says "no baselines yet" (S2.1.2 not run on this target);
`drop_ratio` NULL everywhere in winter (`baseline_drop_3h_p95_c` is positive because `with_trends` got a
frame with one reading per hour and the 5-minute tolerance missed it: history must be 10-minute cadence, or
raise `tolerance_min`); the tile shows "No baseline for this hour" for one segment only (its station has fewer
than `--min-obs` readings for that month and hour).

### S2.1.4 Tests on a synthetic two-month frame      owner: Sani
Why: percentile and join bugs are silent; a frame with known answers catches them.
Do: create `tests/unit/test_baselines.py`:

```python
"""Two months (Jan, Feb 2026), one station, one reading per hour. Surface = base(month) + 3 cos(2π (h - 14) / 24):
warmest at 14:00, coldest at 02:00; February 2 °C colder. Hourly readings sit exactly 3 h apart, so the
3-hour change is deterministic per hour of day."""
import math
from datetime import datetime, timedelta

import pytest
from pyspark.sql import functions as F

from frostsight import baselines

STATION, SEGMENT = "1900177", "1113653-1-9"


def _surface(ts: datetime) -> float:
    base = 0.0 if ts.month == 1 else -2.0
    return round(base + 3 * math.cos(2 * math.pi * (ts.hour - 14) / 24), 4)


def _obs(spark):
    t0, rows = datetime(2026, 1, 1), []
    while (t := t0 + timedelta(hours=len(rows))) < datetime(2026, 3, 1):
        rows.append((STATION, t, _surface(t)))
    return spark.createDataFrame(rows, "station_id string, event_time timestamp, road_surface_temperature_c double")


def _lookup(spark):
    return spark.createDataFrame([(STATION, SEGMENT)], "station_id string, road_segment_id string")


def _closures(spark):
    rows = [("c1", SEGMENT, datetime(2026, 1, 10, 6), 60.0), ("c2", SEGMENT, datetime(2026, 1, 20, 18), 120.0)]
    return spark.createDataFrame(rows, "incident_id string, road_segment_id string, start_time timestamp, duration_min double")


@pytest.fixture(scope="module")
def table(spark):
    st = baselines.station_baselines(_obs(spark))
    return {(r.road_segment_id, r.month, r.hour_of_day): r
            for r in baselines.assemble(st, _lookup(spark), baselines.closure_baselines(_closures(spark))).collect()}


def test_grain_and_counts(table):
    assert len(table) == 2 * 2 * 24                         # (segment + station) x 2 months x 24 hours
    jan14 = table[(SEGMENT, 1, 14)]
    assert jan14.n_obs == 31 and jan14.seasons == 1 and table[(None, 2, 14)].n_obs == 28


def test_percentiles(table):
    assert table[(SEGMENT, 1, 14)].surface_p50_c == pytest.approx(3.0, abs=0.01)     # warmest hour, January
    assert table[(SEGMENT, 2, 14)].surface_p50_c == pytest.approx(1.0, abs=0.01)     # February 2 °C colder
    assert table[(SEGMENT, 1, 2)].surface_p50_c == pytest.approx(-3.0, abs=0.01)
    r = table[(SEGMENT, 1, 8)]
    assert r.surface_p05_c <= r.surface_p50_c <= r.surface_p95_c


def test_drop_3h_is_the_cooling_phase(table):
    # 02:00 minus 23:00: 3 cos(-π) - 3 cos(3π/4) = -3 + 2.1213 = -0.879 (cooling); 14:00 minus 11:00 is warming
    assert table[(SEGMENT, 1, 2)].drop_3h_p95_c == pytest.approx(-0.879, abs=0.01)
    assert table[(SEGMENT, 1, 14)].drop_3h_p95_c > 0


def test_closures_repeat_on_every_hour_of_the_month(table):
    jan = table[(SEGMENT, 1, 5)]
    assert jan.closure_count == 2 and jan.closure_mean_duration_min == pytest.approx(90.0)
    assert jan.closure_freq_per_month == pytest.approx(2.0)                          # one season in the frame
    assert table[(SEGMENT, 2, 5)].closure_count == 0 and table[(None, 1, 5)].closure_count == 0
    assert jan.typical_traffic_volume is None


def test_with_anomaly(spark, table):
    base = spark.createDataFrame(
        [(SEGMENT, 1, 2, -1.0, -5.5, 31)],
        "road_segment_id string, month int, hour_of_day int, drop_3h_p95_c double, surface_p05_c double, n_obs bigint")
    scored = spark.createDataFrame(
        [(SEGMENT, STATION, datetime(2026, 1, 15, 2, 0), -2.0, -6.0),          # twice the p95 drop, colder than p05
         ("other", STATION, datetime(2026, 1, 15, 2, 0), -2.0, -6.0)],         # no baseline row
        "road_segment_id string, station_id string, event_time timestamp, temperature_change_3h double, road_surface_temperature_c double")
    out = {r.road_segment_id: r for r in baselines.with_anomaly(scored, base).collect()}
    assert out[SEGMENT].drop_ratio == pytest.approx(2.0) and out[SEGMENT].drop_anomaly_pct == 100.0
    assert out[SEGMENT].is_unusual_drop and out[SEGMENT].is_unusual_cold
    assert out["other"].drop_ratio is None and not out["other"].is_unusual_drop
```

Expect: `uv run pytest tests/unit/test_baselines.py -q` green in under a minute (1,416 rows, one shuffle).
If it fails: the `spark` fixture session zone is not UTC (`conftest.py` from M5 sets it; `hour()` then shifts);
`percentile_approx` on 31 identical-shaped values returns a neighbour (loosen `abs` to 0.05, never to 0.5).

## Done when (Part 1)

- [ ] `src/frostsight/baselines.py` and `src/jobs/build_baselines.py` exist; `test_baselines.py` green locally and in CI.
- [ ] `reference` has three serial tasks; the Monday run finishes green with no queued task.
- [ ] `gold.historical_baselines` has segment and station rows for every month of the replayed winter; `typical_traffic_volume` NULL.
- [ ] `gold.road_segment_anomalies` refreshes with every `orchestrate` run; `orchestrate` still has three tasks.
- [ ] Road-detail dashboard has the "Is this drop unusual" tile and the hour-of-day profile line.

## Verify (Part 1)

```bash
cd project && uv run pytest tests/unit/test_baselines.py -q
q "SELECT count(*) AS rows, count(DISTINCT station_id) AS stations, count(DISTINCT month) AS months, sum(CASE WHEN road_segment_id IS NULL THEN 1 ELSE 0 END) AS station_rows FROM frostsight.gold.historical_baselines"
q "SELECT month, hour_of_day, round(surface_p50_c,1) p50, round(drop_3h_p95_c,1) drop_p95, closure_count FROM frostsight.gold.historical_baselines WHERE road_segment_id = '1113653-1-9' AND month = 1 ORDER BY hour_of_day"
q "SELECT is_unusual_drop, count(*) FROM frostsight.gold.road_segment_anomalies GROUP BY 1"
q "SELECT month, hour_of_day, round(surface_p50_c,1) FROM frostsight.gold.historical_baselines WHERE road_segment_id = '1113653-1-9' AND surface_p50_c < 0 ORDER BY 1, 2 LIMIT 5"   -- WR-UC-16
databricks bundle summary -t free --profile frostsight-free -o json | jq '.resources.jobs.reference.tasks | length'   # 3
```

---

# Part 2: Alert delivery      owner: Rayhan

Goal: four SQL alerts defined in the bundle (`resources/alerts.alert.yml`), evaluated on the 2X-Small
warehouse, emailing the team when a segment enters HIGH or VERY_HIGH, when a surface crosses 0 °C with
precipitation, when a source is STALE, and when the data-quality failure rate climbs. Spec section 3.6 says
what an alert must carry: segment, severity, risk type, trigger, measurements, timestamp, freshness. The
query result table is the alert body, so every query returns those columns.

### How SQL alerts work, in eight lines

1. An alert is a saved query plus a condition on one column of its result, evaluated on a schedule by a SQL warehouse.
2. It has a state: `OK`, `TRIGGERED` or `UNKNOWN` (query failed or returned nothing).
3. Notifications are sent on the transition `OK -> TRIGGERED`, and with `notify_on_ok: true` on `TRIGGERED -> OK`. While the alert stays `TRIGGERED`, nothing more is sent (unless a retrigger interval is set, see S2.2.3).
4. The bundle resource is `resources.alerts.<key>` and uses the Alerts v2 schema: `evaluation` (not `condition`), `source.name` (the column), `threshold.value.double_value`, `notification.subscriptions`, and `schedule` with `quartz_cron_schedule` (not `quartz_cron_expression`, which jobs use). The dabs skill warns that this schema differs from every other resource; inspect it before editing: `databricks bundle schema | grep -A 100 'sql.AlertV2'`.
5. The condition fires when it is TRUE: "alert when `c` is above 0" is `GREATER_THAN` 0.
6. Subscriptions are `user_email` (a workspace user) or `destination_id` (a notification destination created by an admin under Settings > Notifications: Slack, Teams, PagerDuty, generic webhook, email list).
7. Every evaluation is a warehouse query; keep them small and on gold.
8. The bundle also deploys the query text, so alert SQL is code-reviewed like everything else.

### S2.2.1 Alert SQL, tested through the CLI      owner: Rayhan
Why: as with dashboards (07_M6 T6.4), a query that fails inside the alert shows `UNKNOWN` and nothing else.
Do: run each with `q "..."`. Alerts take full names (`frostsight.gold.`), unlike dashboards: there is no
`dataset_catalog` for alerts, so the catalog is `${var.catalog}` in the YAML.

**A1 segment entered HIGH or VERY_HIGH** (WR-UC-07). One row per segment that moved up in the last 15
minutes, plus `segments_entered` repeated on every row so the condition has one number to test.

```sql
WITH recent AS (
  SELECT road_segment_id, station_id, event_time, risk_updated_at, risk_level, risk_score,
         risk_drivers[0].factor AS top_driver, road_surface_temperature_c, air_temperature_c,
         precipitation_type, temperature_change_1h,
         lag(risk_level) OVER (PARTITION BY road_segment_id ORDER BY event_time) AS prev_level
  FROM frostsight.gold.road_segment_risk_history
  WHERE event_time >= current_timestamp() - INTERVAL 2 HOURS
    AND coalesce(_batch_id, '') NOT LIKE 'replay:%'),        -- live only (07_M6 T6.4 rule)
entered AS (
  SELECT r.*, s.road_number
  FROM recent r LEFT JOIN frostsight.gold.v_segments s USING (road_segment_id)
  WHERE r.risk_updated_at >= current_timestamp() - INTERVAL 15 MINUTES
    AND r.risk_level IN ('HIGH', 'VERY_HIGH')
    AND (r.prev_level IS NULL OR r.prev_level IN ('LOW', 'MEDIUM'))),
fresh AS (SELECT status AS road_weather_status, round(ingestion_delay_min) AS delay_min
          FROM frostsight.gold.data_quality_summary WHERE source = 'road_weather')
SELECT count(*) OVER () AS segments_entered,
       e.road_segment_id, e.road_number, e.risk_level AS severity, 'icing' AS risk_type,
       concat(coalesce(e.prev_level, 'NEW'), ' -> ', e.risk_level) AS trigger,
       e.road_surface_temperature_c AS surface_c, e.air_temperature_c AS air_c, e.precipitation_type,
       e.temperature_change_1h AS change_1h_c, e.top_driver, round(e.risk_score, 2) AS score,
       e.event_time, f.road_weather_status, f.delay_min
FROM entered e CROSS JOIN fresh f
ORDER BY e.risk_score DESC
```

**A2 surface crossed 0 °C with precipitation** (spec 3.6 first bullet, WR-UC-14 as a push). History holds
one reading per segment per run, so "crossed" means the previous history row was above zero.

```sql
WITH ordered AS (
  SELECT road_segment_id, station_id, event_time, risk_updated_at, risk_level,
         road_surface_temperature_c AS surface_c, precipitation_type,
         lag(road_surface_temperature_c) OVER (PARTITION BY road_segment_id ORDER BY event_time) AS prev_surface_c
  FROM frostsight.gold.road_segment_risk_history
  WHERE event_time >= current_timestamp() - INTERVAL 2 HOURS
    AND coalesce(_batch_id, '') NOT LIKE 'replay:%')
SELECT count(*) OVER () AS segments_crossed,
       o.road_segment_id, s.road_number, o.risk_level AS severity, 'icing' AS risk_type,
       concat(round(o.prev_surface_c, 1), ' -> ', round(o.surface_c, 1), ' °C with ', lower(o.precipitation_type)) AS trigger,
       o.surface_c, o.precipitation_type, o.event_time
FROM ordered o LEFT JOIN frostsight.gold.v_segments s USING (road_segment_id)
WHERE o.risk_updated_at >= current_timestamp() - INTERVAL 15 MINUTES
  AND o.prev_surface_c > 0 AND o.surface_c <= 0
  AND o.precipitation_type IN ('RAIN', 'DRIZZLE', 'SLEET', 'SNOW', 'FREEZING_RAIN')
ORDER BY o.surface_c
```

**A3 source STALE** (08_M7 T7.1 step 4 asked for this in the UI; the bundle version replaces it).

```sql
SELECT count(*) OVER () AS stale_sources, source, status, round(ingestion_delay_min) AS delay_min, threshold_min,
       last_event_time, last_successful_ingestion, computed_at
FROM frostsight.gold.data_quality_summary
WHERE status = 'STALE' AND source IN ('road_weather', 'incidents')     -- nvdb and elevation are weekly or once; their thresholds are days
```

**A4 data-quality failure rate over the last hour** (spec 3.6 last bullet). Threshold 5 %: on a normal day
the `warn` rules fail under 2 % (08_M7 T7.9 row 8); 5 % means a unit change or a broken station, not noise.

```sql
SELECT round(100 * sum(rows_failed) / nullif(sum(rows_checked), 0), 2) AS failure_pct,
       sum(rows_failed) AS rows_failed, sum(rows_checked) AS rows_checked,
       count(DISTINCT run_id) AS updates, max(event_time) AS last_update
FROM frostsight.silver.data_quality_events
WHERE event_time >= current_timestamp() - INTERVAL 1 HOUR AND action = 'drop'
```

Expect: A1 and A2 return zero rows in autumn (the condition column is then absent, so the alert must treat an
empty result as `OK`: `empty_result_state` in S2.2.2); A3 returns zero rows while everything is FRESH; A4
returns one row, `failure_pct` under 2. Replayed storms never trigger A1 or A2: replay history rows carry
`_batch_id = replay:<id>` and last winter's `event_time` (06_M5 T5.4 `--event-id`), and both queries exclude
them twice over. To exercise the alert machinery without winter, use the forced STALE test on A3
(S2.2.2 step 4); A1 and A2 differ only in their SQL, which S2.2.1 already tests with `q`.
If it fails: `lag` over `event_time` returns the same row (two history rows with equal `event_time`: impossible
by the M5 key, check `rows = keys` from 06_M5 T5.7); `v_segments` missing (`002_gold_views.sql` not applied);
`action` column not `drop`/`warn` (07_M6 T6.2 copies `dq_rules.yml` actions verbatim; check the file).

### S2.2.2 Bundle resource      owner: Rayhan
Why: alerts are code; the same file deploys to `free`, `personal` and `aws`.
Do:
  1. Create `resources/alerts.alert.yml`. A1 and A3 in full; A2 and A4 differ only where shown.

```yaml
resources:
  alerts:
    segment_entered_high:
      display_name: "FrostSight · Segment entered HIGH or VERY_HIGH"
      warehouse_id: ${var.warehouse_id}
      query_text: |
        WITH recent AS (
          SELECT road_segment_id, station_id, event_time, risk_updated_at, risk_level, risk_score,
                 risk_drivers[0].factor AS top_driver, road_surface_temperature_c, air_temperature_c,
                 precipitation_type, temperature_change_1h,
                 lag(risk_level) OVER (PARTITION BY road_segment_id ORDER BY event_time) AS prev_level
          FROM ${var.catalog}.gold.road_segment_risk_history
          WHERE event_time >= current_timestamp() - INTERVAL 2 HOURS
            AND coalesce(_batch_id, '') NOT LIKE 'replay:%'),
        entered AS (
          SELECT r.*, s.road_number
          FROM recent r LEFT JOIN ${var.catalog}.gold.v_segments s USING (road_segment_id)
          WHERE r.risk_updated_at >= current_timestamp() - INTERVAL 15 MINUTES
            AND r.risk_level IN ('HIGH', 'VERY_HIGH')
            AND (r.prev_level IS NULL OR r.prev_level IN ('LOW', 'MEDIUM'))),
        fresh AS (SELECT status AS road_weather_status, round(ingestion_delay_min) AS delay_min
                  FROM ${var.catalog}.gold.data_quality_summary WHERE source = 'road_weather')
        SELECT count(*) OVER () AS segments_entered,
               e.road_segment_id, e.road_number, e.risk_level AS severity, 'icing' AS risk_type,
               concat(coalesce(e.prev_level, 'NEW'), ' -> ', e.risk_level) AS trigger,
               e.road_surface_temperature_c AS surface_c, e.air_temperature_c AS air_c, e.precipitation_type,
               e.temperature_change_1h AS change_1h_c, e.top_driver, round(e.risk_score, 2) AS score,
               e.event_time, f.road_weather_status, f.delay_min
        FROM entered e CROSS JOIN fresh f
        ORDER BY e.risk_score DESC
      evaluation:
        comparison_operator: GREATER_THAN
        source:
          name: segments_entered
          display: segments_entered
          aggregation: MAX            # every row carries the same count; verify the key exists, drop it if not (first row is evaluated)
        threshold:
          value:
            double_value: 0
        empty_result_state: OK        # zero rows = nothing entered = OK, not UNKNOWN
        notification:
          notify_on_ok: true          # "back to normal" mail closes the incident
          subscriptions:
            - user_email: ${var.notification_email}
      schedule:
        pause_status: ${var.schedule_pause_status}     # PAUSED on personal, like the jobs
        quartz_cron_schedule: "0 8/10 * * * ?"        # minute 8, 18, 28 ...: after the orchestrate run that started at :00, :10 ...
        timezone_id: UTC
      permissions:
        - level: CAN_RUN
          group_name: users

    surface_crossed_zero:
      display_name: "FrostSight · Surface crossed 0 °C with precipitation"
      warehouse_id: ${var.warehouse_id}
      query_text: |
        <A2 from S2.2.1 with ${var.catalog}.gold. prefixes>
      evaluation:
        comparison_operator: GREATER_THAN
        source: { name: segments_crossed, display: segments_crossed, aggregation: MAX }
        threshold: { value: { double_value: 0 } }
        empty_result_state: OK
        notification:
          notify_on_ok: false         # a crossing is an event, there is no "back to normal"
          subscriptions: [ { user_email: "${var.notification_email}" } ]
      schedule: { pause_status: "${var.schedule_pause_status}", quartz_cron_schedule: "0 8/10 * * * ?", timezone_id: UTC }
      permissions: [ { level: CAN_RUN, group_name: users } ]

    source_stale:
      display_name: "FrostSight · Source STALE"
      warehouse_id: ${var.warehouse_id}
      query_text: |
        SELECT count(*) OVER () AS stale_sources, source, status, round(ingestion_delay_min) AS delay_min, threshold_min,
               last_event_time, last_successful_ingestion, computed_at
        FROM ${var.catalog}.gold.data_quality_summary
        WHERE status = 'STALE' AND source IN ('road_weather', 'incidents')
      evaluation:
        comparison_operator: GREATER_THAN
        source:
          name: stale_sources
          display: stale_sources
          aggregation: MAX
        threshold:
          value:
            double_value: 0
        empty_result_state: OK
        notification:
          notify_on_ok: true
          subscriptions:
            - user_email: ${var.notification_email}
      schedule:
        pause_status: ${var.schedule_pause_status}
        quartz_cron_schedule: "0 9/10 * * * ?"        # one minute after the risk alerts, so the four never queue behind each other
        timezone_id: UTC
      permissions:
        - level: CAN_RUN
          group_name: users

    dq_failure_rate:
      display_name: "FrostSight · Data-quality failure rate above 5 %"
      warehouse_id: ${var.warehouse_id}
      query_text: |
        <A4 from S2.2.1 with ${var.catalog}.silver. prefix>
      evaluation:
        comparison_operator: GREATER_THAN
        source: { name: failure_pct, display: failure_pct }
        threshold: { value: { double_value: 5 } }
        empty_result_state: UNKNOWN   # no DQ events in an hour is itself a problem (pipeline not running)
        notification:
          notify_on_ok: true
          subscriptions: [ { user_email: "${var.notification_email}" } ]
      schedule: { pause_status: "${var.schedule_pause_status}", quartz_cron_schedule: "0 15 * * * ?", timezone_id: UTC }   # hourly
      permissions: [ { level: CAN_RUN, group_name: users } ]
```

     Notes. `${var.catalog}` inside `query_text` is plain string interpolation and works like in any other
     field. `${var.notification_email}` is the team admin from the README table; a second recipient is a second
     `user_email` line. The reference example uses `${workspace.current_user.userName}`, which would make the
     CI token user the recipient; do not use it here.
  2. Validate and deploy on `personal` first (schedules paused there), then `free` through CI:

```bash
cd project
databricks bundle schema | grep -A 120 'sql.AlertV2' | grep -E 'aggregation|empty_result_state|retrigger|custom_' || echo "check the key names"
databricks bundle validate --strict -t personal --profile frostsight-personal
databricks bundle deploy -t personal --profile frostsight-personal
databricks bundle summary -t personal --profile frostsight-personal | grep -A2 alerts
```

     verify: the exact key names `aggregation` (under `evaluation.source`), `empty_result_state` and the
     template fields on the installed CLI, with the `bundle schema` grep above. If `aggregation` is not in the
     schema, delete the three lines: the first row is evaluated and every row carries the same window count.
  3. Optional but worth five minutes: a custom body so the mail reads as an alert, not as a query dump.
     verify: Alerts v2 accepts `custom_summary` and `custom_description` with `{{ALERT_NAME}}`,
     `{{QUERY_RESULT_VALUE}}` and `{{QUERY_RESULT_TABLE}}` (`databricks bundle schema | grep -B2 -A2 custom_description`).
     If yes, add under each alert: `custom_summary: "{{ALERT_NAME}}: {{QUERY_RESULT_VALUE}} segment(s)"` and
     `custom_description: "{{QUERY_RESULT_TABLE}}"`.
  4. Test one alert end to end on `personal` without waiting for winter: `UPDATE frostsight.gold.data_quality_summary SET status = 'STALE' WHERE source = 'incidents'`,
     then trigger the evaluation by hand (UI: SQL > Alerts > the alert > Run now; CLI: `databricks alerts-v2 --help`
     lists the command on your version, verify the subcommand name), read the mail, run the next
     `orchestrate` so `build_freshness` sets it back, and confirm the "OK" mail.

Expect: `bundle summary` lists four alerts with URLs under `/sql/alerts/`; the workspace shows them with the
schedule; the forced STALE produced one "triggered" mail and one "ok" mail, not one per evaluation.
If it fails: `unknown field condition` or `quartz_cron_expression` (the schema is v2; use the names above);
`warehouse_id` unresolved (the `warehouse_name` lookup, 07_M6 T6.6 "If it fails"); `permissions: group users
not found` on `personal` (one user: override `targets.personal.resources.alerts.<key>.permissions: []` for each,
as for dashboards); the alert shows `UNKNOWN` (open it, read the SQL error; usually a full table name that
does not exist on this target).

### S2.2.3 Delivery on Free Edition, cadence, dedup, warehouse contention      owner: Rayhan
Why: four decisions the team asked for, written down once.
Do: read, decide, record in `runbooks/analytics.md` under "Alerts".

  1. **Where notifications can go.** Email to workspace users works on Free Edition with nothing to set up:
     the subscription is `user_email` and the address must be a user of the workspace (the team members are).
     Slack, Teams, PagerDuty and webhooks need a notification destination created by a workspace admin, then
     referenced as `destination_id: <uuid>` instead of `user_email`. verify: whether the Free Edition workspace
     offers destinations at all: `databricks notification-destinations list --profile frostsight-free`
     (an empty list means "none created yet", an error means the feature is absent); create a Slack one with
     `databricks notification-destinations create --json '{"display_name": "frostsight-slack", "config": {"slack": {"url": "https://hooks.slack.com/services/..."}}}' --profile frostsight-free`
     and put its `id` in the bundle as `${var.slack_destination_id}` (new variable, default empty, subscription
     line only on `free` and `aws` through a target override). If destinations are unavailable, email is the
     delivery and the runbook says so.
  2. **Cadence versus the job.** `orchestrate` starts at :00, :10, ... and takes 4 to 7 minutes (06_M5 T5.5).
     A1 and A2 evaluate at :08, :18, ...: one minute after a normal run finishes, two minutes before the next
     starts. Their window is `risk_updated_at >= now - 15 minutes`, wider than the 10-minute cadence, so a
     run that overran into the next slot is still seen once; the same transition may be *seen* twice, but the
     alert state is already `TRIGGERED` the second time, so no second mail. A3 evaluates at :09 (one warehouse
     query at a time, no queueing among the four); A4 hourly at :15, because the failure rate is a slow signal
     and hourly evaluation halves the alert load on the warehouse.
  3. **Dedup: the alert's own state, no `gold.alert_state` table.** Two options were on the table.
     (a) A `gold.alert_state (road_segment_id, alert_kind, last_alerted_at)` table maintained by a task, with
     the alert query excluding segments alerted in the last N hours. (b) Rely on the alert state machine:
     one mail on `OK -> TRIGGERED`, silence while `TRIGGERED`, one mail on `TRIGGERED -> OK` where that makes
     sense. Choice: (b). Reasons: (a) needs a writer; the only place for it without a new task is
     `build_gold`, which then depends on alert semantics, and the writer runs *before* the alert evaluates, so
     "alerted" would have to be predicted, not recorded. (b) already gives "the same segment does not re-alert
     every 10 minutes" because A1's row for a segment leaves the 15-minute window before the alert could fire
     again, and while other segments keep the alert `TRIGGERED` no mail goes out. The cost of (b): a second
     segment entering HIGH twenty minutes after the first, while the alert is still `TRIGGERED`, appears only
     in the next mail. Mitigation if that matters in the storm season: a retrigger interval on the alert
     (verify: `evaluation.notification.retrigger_seconds` in the v2 schema; set 3600 so a still-triggered
     alert re-sends at most hourly with the current row list). On `aws`, where task budget is not a concern,
     (a) can be added as a fourth `orchestrate` task and A1 rewritten to read it; not on `free`.
  4. **Warehouse contention.** Every evaluation is a query on the one 2X-Small that also serves four
     dashboards and the API (Part 3). Numbers: A1 to A3 every 10 minutes and A4 hourly is 456 queries a day,
     each reading a few thousand history rows (the 2-hour window) and finishing in under two seconds warm.
     Two consequences. First, the warehouse never auto-stops: an evaluation every ten minutes keeps it warm
     around the clock, which on a paid workspace is the cost to watch (set `auto_stop_mins: 10`, and expect
     roughly 24 warm hours a day anyway) and on Free Edition is a quota question. verify: after two days,
     `q "SELECT count(*) FROM system.query.history WHERE statement_text LIKE '%road_segment_risk_history%' AND start_time >= current_date() - 1"`
     if the table is readable, else the warehouse Monitoring tab; if evaluations are being throttled or
     the workspace shows a serverless-SQL quota warning, move A1 and A2 to `"0 8/20 * * * ?"`. Second, alert
     queries must stay on gold with a time filter; never join `v_observations` in an alert. If a dashboard
     open coincides with an evaluation, both queue for a second on 2X-Small; nothing fails.

Expect: the runbook section exists with the four decisions and the verify results filled in.
If it fails: mail never arrives on `personal` (schedules are `PAUSED` there by `schedule_pause_status`; trigger by hand);
mail arrives every 10 minutes (an alert was created in the UI with "notify each evaluation"; the bundle
version is the only one that should exist, delete the UI copy from 08_M7 T7.1).

## Done when (Part 2)

- [ ] Four queries from S2.2.1 run through `q` and return the spec 3.6 columns.
- [ ] `resources/alerts.alert.yml` validates with `--strict` on all three targets and deploys four alerts.
- [ ] One forced STALE produced exactly one "triggered" and one "ok" mail.
- [ ] Notification destination availability on Free Edition verified and recorded; Slack wired if available.
- [ ] The UI alert from 08_M7 T7.1 is deleted; the runbook has the "Alerts" section.

## Verify (Part 2)

```bash
cd project
databricks bundle validate --strict -t free --profile frostsight-free
databricks bundle summary -t free --profile frostsight-free | grep -A8 alerts
databricks notification-destinations list --profile frostsight-free
q "SELECT count(*) FROM frostsight.gold.road_segment_risk_history WHERE risk_updated_at >= current_timestamp() - INTERVAL 15 MINUTES"   -- about 30 after a run
q "SELECT source, status FROM frostsight.gold.data_quality_summary WHERE source IN ('road_weather', 'incidents')"
```

Expected: four alerts listed; destinations list or a clear "not available"; about 30 fresh history rows;
both sources `FRESH`.

---

# Part 3: API app      owner: Safiul

Goal: a FastAPI service running as a Databricks App, `frostsight-api`, reading gold through the SQL warehouse
with the app's own service principal, exposing the spec section 17 subset: `GET /risk/current`,
`GET /risk/roads`, `GET /risk/roads/{id}`, `GET /incidents/active`, `GET /health`. Every response carries a
timestamp, the risk with drivers, the supporting measurements and the data freshness, as section 17 asks.

Decisions:

| Decision | Choice | Why |
|---|---|---|
| Framework | FastAPI, uvicorn, `python main.py` binding `DATABRICKS_APP_PORT` | The apps-python skill default; typed responses and `/docs` for free; binding the injected port avoids the 502 the platform guide warns about |
| Data path | `databricks-sql-connector` against the 2X-Small, app service principal via `Config()` | One code path locally (CLI profile) and deployed (injected `DATABRICKS_CLIENT_ID/SECRET`) |
| Identity | The app's platform-created service principal, not a user token | Free Edition has no user-created service principals (README), but every app gets one automatically; verify below |
| Caching | In-memory, 60 seconds, per query | Gold changes every 10 minutes; 60 s means at most one warehouse query per minute per endpoint regardless of callers |
| Rate limit | 120 requests per minute per client IP, in-process | Defensive only: the app sits behind Databricks login (`CAN_USE`), and the proxy already has a 120 s request timeout |
| Filters | In Python over the cached current-risk rows | 30 rows today, 20,000 at most; one query instead of one per filter |
| Apps budget | This is app 1 of the 3 Free Edition allows | S1 and S3 deploy no app (dashboards and gold tables); keep the other two slots free; do not deploy per-developer copies on `free` |

### S2.3.1 App files      owner: Safiul
Why: the app directory is what the bundle uploads; everything the runtime needs is inside it.
Do:
  1. `src/app/app.yaml`:

```yaml
command: [ "python", "main.py" ]
env:
  - name: DATABRICKS_WAREHOUSE_ID
    valueFrom: sql-warehouse            # the resource key declared in resources/api.app.yml
  - name: FROSTSIGHT_CATALOG
    value: "frostsight"                 # literal: bundle variables are not resolved inside app config (platform guide)
```

  2. `src/app/requirements.txt` (FastAPI and uvicorn are pre-installed on the runtime; pin what is not):

```
databricks-sql-connector>=3.3,<4
databricks-sdk>=0.40
pydantic>=2.6
```

  3. `src/app/main.py`:

```python
"""FrostSight read API: FastAPI on Databricks Apps over the gold tables (spec section 17 subset)."""
from __future__ import annotations

import asyncio
import json
import os
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

CATALOG = os.environ.get("FROSTSIGHT_CATALOG", "frostsight")
CACHE_TTL_S, RATE_LIMIT_PER_MIN = 60, 120
app = FastAPI(title="FrostSight API", version="0.1", description="Icing risk per NVDB segment, Troms pilot. Not an official warning service.")


# ---------- responses (section 17: timestamp, segment, risk, drivers, measurements, freshness) ----------
class Driver(BaseModel):
    factor: str
    contribution: float

class Measurements(BaseModel):
    surface_temp_c: float | None
    air_temp_c: float | None
    dew_point_c: float | None
    precipitation_type: str | None
    temperature_change_1h: float | None
    temperature_change_3h: float | None

class Freshness(BaseModel):
    risk_updated_at: datetime
    data_age_minutes: int
    road_weather_status: str             # FRESH | STALE | NO_DATA, from gold.data_quality_summary

class SegmentRisk(BaseModel):
    road_segment_id: str
    road_number: str | None
    station_id: str | None
    event_time: datetime
    risk_level: str
    risk_score: float
    icing_score: float
    drivers: list[Driver]
    measurements: Measurements
    freshness: Freshness

class RiskSummary(BaseModel):
    as_of: datetime
    segments_total: int
    by_level: dict[str, int]
    freshness: Freshness
    top: list[SegmentRisk]

class Incident(BaseModel):
    incident_id: str
    incident_type: str
    severity: str | None
    road_number: str | None
    road_segment_id: str | None
    start_time: datetime
    end_time: datetime | None

class SourceHealth(BaseModel):
    source: str
    status: str
    ingestion_delay_min: float | None
    last_event_time: datetime | None

class Health(BaseModel):
    status: str                          # ok | degraded
    checked_at: datetime
    sources: list[SourceHealth]


# ---------- data access: the only function that talks to Databricks; tests replace it ----------
RISK_SQL = f"""
SELECT r.road_segment_id, s.road_number, r.station_id, r.event_time, r.risk_level, r.risk_score, r.icing_score,
       to_json(r.risk_drivers) AS drivers_json, r.road_surface_temperature_c, r.air_temperature_c, r.dew_point_c,
       r.precipitation_type, r.temperature_change_1h, r.temperature_change_3h, r.risk_updated_at
FROM {CATALOG}.gold.road_segment_current_risk r LEFT JOIN {CATALOG}.gold.v_segments s USING (road_segment_id)"""
FRESH_SQL = f"SELECT source, status, ingestion_delay_min, last_event_time FROM {CATALOG}.gold.data_quality_summary ORDER BY source"
INCIDENT_SQL = f"""SELECT incident_id, incident_type, severity, road_number, road_segment_id, start_time, end_time
FROM {CATALOG}.gold.v_incidents WHERE is_active ORDER BY start_time DESC"""
_cfg = None


def run_query(statement: str) -> list[dict[str, Any]]:
    global _cfg
    from databricks import sql                          # imported here so tests need neither package
    from databricks.sdk.core import Config
    _cfg = _cfg or Config()                             # deployed: app service principal from DATABRICKS_CLIENT_ID/SECRET; local: your CLI profile
    with sql.connect(server_hostname=_cfg.host, http_path=f"/sql/1.0/warehouses/{os.environ['DATABRICKS_WAREHOUSE_ID']}",
                     credentials_provider=lambda: _cfg.authenticate) as conn, conn.cursor() as cur:
        cur.execute(statement)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


_cache: dict[str, tuple[float, list[dict]]] = {}

async def cached(key: str, statement: str) -> list[dict]:
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_TTL_S:
        return hit[1]
    rows = await asyncio.to_thread(run_query, statement)        # the connector is synchronous
    _cache[key] = (time.monotonic(), rows)
    return rows


_hits: dict[str, list[float]] = defaultdict(list)

@app.middleware("http")
async def rate_limit(request: Request, call_next):
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0].strip()
    now = time.monotonic()
    recent = [t for t in _hits[ip] if now - t < 60]
    if len(recent) >= RATE_LIMIT_PER_MIN:
        return JSONResponse({"detail": f"rate limit: {RATE_LIMIT_PER_MIN} requests per minute"}, status_code=429)
    _hits[ip] = recent + [now]
    return await call_next(request)


# ---------- shaping ----------
def _utc(ts: datetime) -> datetime:
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)

def _freshness(row: dict, fresh: list[dict]) -> Freshness:
    rw = next((f for f in fresh if f["source"] == "road_weather"), None)
    updated = _utc(row["risk_updated_at"])
    return Freshness(risk_updated_at=updated, data_age_minutes=int((datetime.now(timezone.utc) - updated).total_seconds() // 60),
                     road_weather_status=rw["status"] if rw else "NO_DATA")

def _segment(row: dict, fresh: list[dict]) -> SegmentRisk:
    return SegmentRisk(
        road_segment_id=row["road_segment_id"], road_number=row["road_number"], station_id=row["station_id"],
        event_time=_utc(row["event_time"]), risk_level=row["risk_level"], risk_score=row["risk_score"], icing_score=row["icing_score"],
        drivers=[Driver(**d) for d in json.loads(row["drivers_json"] or "[]")],
        measurements=Measurements(surface_temp_c=row["road_surface_temperature_c"], air_temp_c=row["air_temperature_c"],
                                  dew_point_c=row["dew_point_c"], precipitation_type=row["precipitation_type"],
                                  temperature_change_1h=row["temperature_change_1h"], temperature_change_3h=row["temperature_change_3h"]),
        freshness=_freshness(row, fresh))


# ---------- endpoints ----------
@app.get("/risk/current", response_model=RiskSummary)
async def risk_current(top: int = Query(10, ge=1, le=100)):
    rows, fresh = await cached("risk", RISK_SQL), await cached("fresh", FRESH_SQL)
    if not rows:
        raise HTTPException(503, "no risk rows yet")
    ranked = sorted(rows, key=lambda r: -r["risk_score"])
    by_level = {lvl: sum(1 for r in rows if r["risk_level"] == lvl) for lvl in ("LOW", "MEDIUM", "HIGH", "VERY_HIGH")}
    return RiskSummary(as_of=datetime.now(timezone.utc), segments_total=len(rows), by_level=by_level,
                       freshness=_freshness(max(rows, key=lambda r: r["risk_updated_at"]), fresh),
                       top=[_segment(r, fresh) for r in ranked[:top]])

@app.get("/risk/roads", response_model=list[SegmentRisk])
async def risk_roads(level: str | None = None, road_number: str | None = None, limit: int = Query(100, ge=1, le=5000)):
    rows, fresh = await cached("risk", RISK_SQL), await cached("fresh", FRESH_SQL)
    picked = [r for r in rows if (level is None or r["risk_level"] == level.upper())
              and (road_number is None or (r["road_number"] or "").upper() == road_number.upper())]
    return [_segment(r, fresh) for r in sorted(picked, key=lambda r: -r["risk_score"])[:limit]]

@app.get("/risk/roads/{road_segment_id}", response_model=SegmentRisk)
async def risk_road(road_segment_id: str):
    rows, fresh = await cached("risk", RISK_SQL), await cached("fresh", FRESH_SQL)
    row = next((r for r in rows if r["road_segment_id"] == road_segment_id), None)
    if row is None:
        raise HTTPException(404, f"no current risk row for segment {road_segment_id}")
    return _segment(row, fresh)

@app.get("/incidents/active", response_model=list[Incident])
async def incidents_active():
    return [Incident(**{k: (_utc(v) if isinstance(v, datetime) else v) for k, v in r.items()}) for r in await cached("incidents", INCIDENT_SQL)]

@app.get("/health", response_model=Health)
async def health():
    fresh = await cached("fresh", FRESH_SQL)
    live = [f for f in fresh if f["source"] in ("road_weather", "incidents")]
    status = "ok" if live and all(f["status"] == "FRESH" for f in live) else "degraded"
    return Health(status=status, checked_at=datetime.now(timezone.utc),
                  sources=[SourceHealth(**{k: (_utc(v) if isinstance(v, datetime) else v) for k, v in f.items()}) for f in fresh])


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("DATABRICKS_APP_PORT", 8000)))   # the platform assigns the port
```

  4. Run it locally against `free` (your CLI profile is the identity; the warehouse id from `databricks warehouses list`):

```bash
cd project
export DATABRICKS_CONFIG_PROFILE=frostsight-free DATABRICKS_WAREHOUSE_ID=$WH
uv run --with fastapi --with uvicorn --with "databricks-sql-connector>=3.3" --with databricks-sdk python src/app/main.py
curl -s localhost:8000/health | jq .
curl -s "localhost:8000/risk/roads?level=HIGH&limit=3" | jq '.[].road_segment_id'
curl -s localhost:8000/risk/roads/1113653-1-9 | jq '{risk_level, drivers, freshness}'
open http://localhost:8000/docs
```

Expect: `/health` returns `status: ok` with four sources; `/risk/current` returns `by_level` summing to
`segments_total` and `freshness.data_age_minutes` under 20; the second call of any endpoint within a minute
returns in milliseconds (no warehouse query); the 121st call in a minute gets 429.
If it fails: `KeyError: DATABRICKS_WAREHOUSE_ID` (export it locally; deployed, the `valueFrom` line is
missing); `Config()` cannot authenticate locally (`databricks auth login --profile frostsight-free`);
`risk_drivers` arrives as a string (it should: `to_json` is deliberate, the connector returns complex types
as strings on some versions, so the code parses JSON either way); `data_age_minutes` negative (the warehouse
session zone is not UTC: `risk_updated_at` is naive and `_utc` labels it UTC; check the M6 note on UTC everywhere).

### S2.3.2 Test with a mocked query function      owner: Safiul
Why: the shaping code is where bugs live; the warehouse is not needed to test it.
Do: create `tests/unit/test_api.py` (`fastapi` and `httpx` go into the `dev` group of `pyproject.toml`):

```python
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src" / "app"))   # src/app is an app dir, not a package
import main  # noqa: E402

NOW = datetime.now(timezone.utc).replace(tzinfo=None)
RISK = [{"road_segment_id": "1113653-1-9", "road_number": "E8", "station_id": "1900177", "event_time": NOW - timedelta(minutes=8),
         "risk_level": "HIGH", "risk_score": 0.6875, "icing_score": 0.6875,
         "drivers_json": '[{"factor":"surface_temp","contribution":0.35},{"factor":"air_temp","contribution":0.15},{"factor":"dew_point_spread","contribution":0.15}]',
         "road_surface_temperature_c": -4.0, "air_temperature_c": -3.0, "dew_point_c": -3.4, "precipitation_type": "NONE",
         "temperature_change_1h": -0.5, "temperature_change_3h": -1.2, "risk_updated_at": NOW - timedelta(minutes=5)},
        {**{k: None for k in ("road_number", "dew_point_c", "precipitation_type", "temperature_change_1h", "temperature_change_3h")},
         "road_segment_id": "2-1-1", "station_id": "1900178", "event_time": NOW - timedelta(minutes=9), "risk_level": "LOW",
         "risk_score": 0.1, "icing_score": 0.1, "drivers_json": "[]", "road_surface_temperature_c": 4.0, "air_temperature_c": 5.0,
         "risk_updated_at": NOW - timedelta(minutes=5)}]
FRESH = [{"source": "road_weather", "status": "FRESH", "ingestion_delay_min": 12.0, "last_event_time": NOW - timedelta(minutes=12)},
         {"source": "incidents", "status": "STALE", "ingestion_delay_min": 95.0, "last_event_time": NOW - timedelta(minutes=95)}]


def fake_query(statement: str):
    return RISK if "road_segment_current_risk" in statement else FRESH if "data_quality_summary" in statement else []


def test_endpoints(monkeypatch):
    monkeypatch.setattr(main, "run_query", fake_query)
    main._cache.clear()
    c = TestClient(main.app)
    cur = c.get("/risk/current").json()
    assert cur["segments_total"] == 2 and cur["by_level"] == {"LOW": 1, "MEDIUM": 0, "HIGH": 1, "VERY_HIGH": 0}
    assert cur["top"][0]["road_segment_id"] == "1113653-1-9" and cur["top"][0]["drivers"][0]["factor"] == "surface_temp"
    assert 4 <= cur["freshness"]["data_age_minutes"] <= 6 and cur["freshness"]["road_weather_status"] == "FRESH"
    assert [r["road_segment_id"] for r in c.get("/risk/roads?level=high").json()] == ["1113653-1-9"]
    one = c.get("/risk/roads/1113653-1-9").json()
    assert one["measurements"]["surface_temp_c"] == -4.0
    assert one["event_time"].endswith(("Z", "+00:00"))                        # timestamps leave the API as UTC
    assert c.get("/risk/roads/nope").status_code == 404
    assert c.get("/incidents/active").json() == []
    assert c.get("/health").json()["status"] == "degraded"                     # incidents STALE
    assert len(main._cache) == 3                                               # risk, fresh, incidents: one query each
```

Expect: `uv run pytest tests/unit/test_api.py -q` green in a few seconds; no network.
If it fails: `ModuleNotFoundError: main` (the `sys.path` line points at the wrong depth; the test lives in
`tests/unit/`); `httpx` missing (`TestClient` needs it); the rate limiter counts across tests (127.0.0.1 shares
the bucket: `main._hits.clear()` in the test if you add more calls).

### S2.3.3 Bundle resource, service principal, grants      owner: Safiul
Why: the app deploys from the same bundle, gets the warehouse as a declared resource, and its service
principal must be allowed to read gold.
Do:
  1. Create `resources/api.app.yml`:

```yaml
resources:
  apps:
    api:
      name: frostsight-api                     # at most 26 characters, lower case, digits and hyphens
      description: "FrostSight read API over gold: /risk/current, /risk/roads, /risk/roads/{id}, /incidents/active, /health"
      source_code_path: ../src/app             # app.yaml, main.py and requirements.txt live here
      resources:
        - name: sql-warehouse                  # the valueFrom key in app.yaml
          sql_warehouse:
            id: ${var.warehouse_id}
            permission: CAN_USE                # granted to the app's service principal at deploy
      permissions:
        - level: CAN_USE
          group_name: users
```

     On `personal` the `[dev <user>]` prefix of `mode: development` would produce an invalid app name;
     verify: `databricks bundle validate --strict -t personal --profile frostsight-personal`; if it complains,
     add `targets.personal.resources.apps.api.name: frostsight-api-dev` in `databricks.yml` (and on `free`
     and `aws` the `name_prefix: ""` preset already leaves the name alone). The `users` permission fails on a
     single-user `personal` workspace exactly as for dashboards; override it to `[]` there.
  2. Deploy and start. A bare `bundle deploy` uploads the code but leaves the app stopped with no URL
     (platform guide); `bundle run` starts it:

```bash
cd project
databricks bundle validate --strict -t free --profile frostsight-free
databricks bundle deploy -t free --profile frostsight-free
databricks bundle run api -t free --profile frostsight-free                 # starts the app, prints its URL
databricks apps get frostsight-api --profile frostsight-free -o json | jq '{state: .app_status.state, url, sp: .service_principal_client_id, sp_name: .service_principal_name}'
databricks apps logs frostsight-api --profile frostsight-free               # needs an OAuth profile, not a PAT
```

     Redeploys: edit, `bundle deploy`, `bundle run api` again. Without the bundle (for a quick check from a
     branch): `databricks workspace import-dir src/app /Workspace/Users/<you>/apps/frostsight-api --overwrite --profile frostsight-free`
     then `databricks apps deploy frostsight-api --source-code-path /Workspace/Users/<you>/apps/frostsight-api --profile frostsight-free`.
  3. Service principal and grants. verify: on Free Edition the app runs as a platform-created service
     principal even though users cannot create them; the `jq` line above prints its client id and name. Then
     grant it read access to gold (the `users` grants in `src/sql/grants.sql` do not cover a service
     principal). Append to `src/sql/grants.sql` and run once per target:

```sql
-- S2 API app service principal (client id from `databricks apps get frostsight-api`)
GRANT USE CATALOG ON CATALOG frostsight TO `<app service principal client id>`;
GRANT USE SCHEMA ON SCHEMA frostsight.gold TO `<app service principal client id>`;
GRANT SELECT ON SCHEMA frostsight.gold TO `<app service principal client id>`;
-- gold.v_segments and gold.v_incidents read silver as their owner (07_M6 T6.4), so no silver grant is needed
```

     `CAN_USE` on the warehouse is granted by the resource declaration; do not grant it by hand.
  4. Rate limits and caching, stated for the runbook: 60-second in-memory cache per query, so the API adds at
     most three warehouse queries per minute whatever the traffic; 120 requests per minute per client IP, 429
     beyond; the Databricks Apps proxy times out any request after 120 seconds (not configurable); the app
     container is 2 vCPU and 6 GB, restarted on redeploy, and the cache is lost with it (first call after a
     deploy is a cold warehouse query, 1 to 30 seconds if the warehouse is asleep).
  5. The three-apps limit. `databricks apps list --profile frostsight-free -o json | jq length` must be 3 or
     less after this deploy. The team rule: `frostsight-api` on `free` is the only app there until S3 needs
     its slot; experiments go to `personal` workspaces (each has its own three).

Expect: `apps get` shows `RUNNING` and a URL of the form `https://frostsight-api-<workspace id>.<region>.databricksapps.com`;
opening `<url>/docs` after login shows the five endpoints; `<url>/health` returns `status: ok`;
`<url>/risk/roads/1113653-1-9` returns drivers and freshness; a colleague with `CAN_USE` can open it.
If it fails: `PERMISSION_DENIED` on `frostsight.gold...` in the logs (step 3 grants not applied to the service
principal); 502 right after start (the app bound to a fixed port or `localhost`: the `uvicorn.run` line must use
`DATABRICKS_APP_PORT` and `0.0.0.0`); `DATABRICKS_WAREHOUSE_ID` empty (the resource `name` in `api.app.yml` and the
`valueFrom` in `app.yaml` differ); app stuck in `DEPLOYING` beyond 10 minutes (a dependency in `requirements.txt`
fails to build; check the `[SYSTEM]` lines in the logs); "app quota exceeded" (a fourth app on Free Edition;
delete one with `databricks apps delete <name>`).

## Done when (Part 3)

- [ ] `src/app/` holds `app.yaml`, `requirements.txt`, `main.py`; `tests/unit/test_api.py` green locally and in CI.
- [ ] `resources/api.app.yml` validates on all three targets and `frostsight-api` runs on `free`.
- [ ] The app's service principal id is in `grants.sql` and the grants are applied on `free`.
- [ ] `/health`, `/risk/current`, `/risk/roads?level=HIGH`, `/risk/roads/{id}`, `/incidents/active` return the section 17 fields.
- [ ] Rate limit and cache behaviour recorded in `runbooks/analytics.md`; app count on `free` is at most 3.

## Verify (Part 3)

```bash
cd project && uv run pytest tests/unit/test_api.py -q
databricks apps list --profile frostsight-free -o json | jq 'map({name, state: .app_status.state})'
URL=$(databricks apps get frostsight-api --profile frostsight-free -o json | jq -r .url)
TOKEN=$(databricks auth token --profile frostsight-free | jq -r .access_token)          # OAuth token for curl through the app login
curl -s -H "Authorization: Bearer $TOKEN" "$URL/health" | jq '{status, sources: (.sources | map({source, status}))}'
curl -s -H "Authorization: Bearer $TOKEN" "$URL/risk/current?top=3" | jq '{segments_total, by_level, age: .freshness.data_age_minutes, top: [.top[].road_segment_id]}'
q "SHOW GRANTS ON SCHEMA frostsight.gold" | grep -i "$(databricks apps get frostsight-api --profile frostsight-free -o json | jq -r .service_principal_client_id)"
```

Expected: one app, `RUNNING`; `health.status` `ok`; a summary with three top segments and an age under 20;
the service principal listed with `SELECT` and `USE SCHEMA`. verify: whether a bearer token from
`databricks auth token` is accepted by the app login proxy for `curl`; if not, test from a browser session
and `<url>/docs`.

---

## Handover to S3 and the stretch review

| Consumer | Gets from S2 | Where |
|---|---|---|
| S3 ML | Nothing. S3 must not read `gold.historical_baselines` or `gold.road_segment_anomalies`: both are computed from the whole of last winter, which is also S3's training, validation and test period, so any baseline feature would carry information from the test month into training (12_S3 T-S3.2 note). S3 keeps its own point-in-time expanding-window rates. A second winter would make last winter's baselines a legitimate feature for this winter | 12_S3 T-S3.2 |
| 13_stretch_review | The verify items in this file, the alert schema check output, the app service principal note | this file |
| Runbooks | "Alerts" and "API" sections in `runbooks/analytics.md`; the grants line in `runbooks/platform.md` | S2.2.3, S2.3.3 |
