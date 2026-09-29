# M5: Risk computed

Owners: Sani (windows and trends), Safiul (risk engine, gold tables, orchestration). Rayhan reviews the
bundle YAML, Sohanur reads `gold.historical_closures` as his label table.

Goal: 30-minute to 6-hour windows and temperature trends exist per station, the icing risk engine scores
every mapped road segment with explainable drivers, and the gold tables refresh every 10 minutes right
after the pipeline update, from the same `orchestrate` job.

Inputs: `silver.road_weather_observations`, `silver.station_segment_lookup`, `silver.road_incidents`,
`silver.road_segments` (M4, column contracts in 05_M4 T4.4 and T4.6). Risk model v0 from M3: weights in
`config/risk_weights.yml` (surface temp 0.35, air temp 0.15, dew-point spread 0.15, precipitation 0.20,
1-hour trend 0.15), levels `LOW < 0.25 <= MEDIUM < 0.5 <= HIGH < 0.75 <= VERY_HIGH`, drivers = top three
weighted contributions. The YAML in T5.1 is the authoritative copy; 04_M3 is aligned to it.

## 1. Decisions fixed in this milestone

**Batch, not streaming, for windows and risk.** Five lines on the trade-off:

1. The pipeline runs triggered every 10 minutes, so a streaming aggregation would deliver results no
   sooner than a batch job reading the same silver table right after the update.
2. Batch lets us use window functions (`last_value`, `min_by`, range frames) for trends; streaming
   aggregations are restricted to `GROUP BY window(...)` shapes and emit only when the watermark passes.
3. The whole county is small: 30 stations x 144 readings/day. Recomputing the last 6 hours on every run
   takes seconds; incremental state buys nothing.
4. Idempotent `MERGE` on natural keys makes re-runs and backfills trivial (`--since` parameter).
5. Cost: streaming would keep state in the pipeline update; a batch task on serverless runs 1 to 2 minutes
   and stops. If we ever move to continuous mode on AWS, the same functions can be applied in a
   `foreachBatch` sink; the pure functions do not change.

Other decisions:

| Decision | Choice |
|---|---|
| Windows | Tumbling, per station, sizes 30, 60, 180, 360 minutes; `window_start` is the tumbling boundary |
| Trend | `temperature_change_1h` = latest surface reading minus the last reading 55 to 65 minutes earlier (range window); same for 3 h with 175 to 185 minutes. Null when no reading in the band |
| Current risk row | One per `road_segment_id` from the newest observation of its station within the last 30 minutes; stations silent longer keep their previous row (freshness flags them at M6) |
| History | Append one row per (`road_segment_id`, `event_time`, `_batch_id`) via `MERGE ... WHEN NOT MATCHED INSERT`; every run, no level-change filter, so replay and validation have full resolution (about 4,300 rows/day). `_batch_id` is the same marker as in bronze and silver: the file stem for live rows, `replay:<event_id>` for a scored replay (10_S1 D1) |
| Replay rows | Silver rows with `_batch_id LIKE 'replay:%'` are ignored by the scheduled run (04_M3 decision D9). A replayed event is scored with `build_gold.py --event-id <id>`: every observation in the event window goes into history only, marked `replay:<id>`; `current_risk`, `incident_summary`, windows and closures are never written in that mode, so replay cannot reach the live map by construction. Every reader of history that means "live" adds `coalesce(_batch_id, '') NOT LIKE 'replay:%'` (07_M6 T6.4) |
| `incident_summary` | Overwritten on every run (small, "active now" semantics) |
| Partitioning | None. Liquid clustering: `CLUSTER BY (road_segment_id)` on current risk, `(event_time)` on history, `(station_id, window_start)` on summaries |

## 2. Tasks

### T5.1 Risk weights and thresholds config      owner: Safiul
Why: the model is deterministic and configurable; every number lives in one file the tests also read.
Do:
  1. Create `config/risk_weights.yml`:

```yaml
version: v0
weights:                  # must sum to 1.0
  surface_temp: 0.35
  air_temp: 0.15
  dew_point_spread: 0.15
  precipitation: 0.20
  temp_trend_1h: 0.15
breakpoints:              # [x, score] pairs; linear between, flat outside; null input scores 0
  surface_temp:     [[-2.0, 1.0], [0.0, 0.5], [3.0, 0.0]]
  air_temp:         [[-2.0, 1.0], [0.0, 0.5], [4.0, 0.0]]
  dew_point_spread: [[0.5, 1.0], [3.0, 0.0]]          # air_temperature_c - dew_point_c
  temp_trend_1h:    [[-3.0, 1.0], [-1.0, 0.5], [0.0, 0.0]]   # surface change over the last hour, °C
precipitation_scores:
  FREEZING_RAIN: 1.0
  SNOW: 0.9
  SLEET: 0.8
  RAIN: 0.5
  DRIZZLE: 0.4
  UNKNOWN: 0.2
  NONE: 0.0
levels:                   # lower bound of each level; below MEDIUM is LOW
  MEDIUM: 0.25
  HIGH: 0.5
  VERY_HIGH: 0.75
drivers_top: 3
```

  2. Add to `src/frostsight/config.py`:

```python
def risk_config(explicit_dir: str | None = None) -> dict:
    cfg = load_yaml("risk_weights.yml", explicit_dir)
    total = sum(cfg["weights"].values())
    if abs(total - 1.0) > 1e-6:
        raise ValueError(f"risk weights must sum to 1.0, got {total}")
    for k, pts in cfg["breakpoints"].items():
        xs = [p[0] for p in pts]
        if xs != sorted(xs):
            raise ValueError(f"breakpoints for {k} must be sorted by x")
    lv = cfg["levels"]
    if not (0.0 < lv["MEDIUM"] < lv["HIGH"] < lv["VERY_HIGH"] <= 1.0):
        raise ValueError("levels must increase 0 < MEDIUM < HIGH < VERY_HIGH <= 1")
    return cfg


def replay_event(event_id: str, explicit_dir: str | None = None) -> dict:
    """One entry of config/replay_events.yml (02_M1 T1.8 shape: id, label, start, end, why)."""
    events = load_yaml("replay_events.yml", explicit_dir)["events"]
    match = [e for e in events if e["id"] == event_id]
    if not match:
        raise ValueError(f"unknown replay event {event_id}; known: {[e['id'] for e in events]}")
    return match[0]
```

Expect: `uv run python -c "from frostsight.config import risk_config; print(risk_config()['version'])"` prints `v0`.
If it fails: a weight was edited without adjusting the others (the loader refuses); YAML indentation.

### T5.2 Windows and trends      owner: Sani
Why: the risk trend factor and the road-detail page both need per-station aggregates over time.
Do:
  1. Create `src/frostsight/windows.py`:

```python
"""Per-station windows and temperature trends. Pure PySpark functions; no SparkSession created here."""
from __future__ import annotations

from pyspark.sql import DataFrame, Window
from pyspark.sql import functions as F

WINDOW_MINUTES = (30, 60, 180, 360)


def windowed_summary(obs: DataFrame, minutes: int) -> DataFrame:
    """Tumbling window per station. Columns match gold.road_weather_summary minus road_segment_id.
    Precipitation: intensity is mm/h and readings are 10 min apart, so each reading contributes intensity/6 mm."""
    w = F.window("event_time", f"{minutes} minutes")
    return (obs.groupBy("station_id", w.alias("w"))
            .agg(F.min("road_surface_temperature_c").alias("surface_min_c"),
                 F.max("road_surface_temperature_c").alias("surface_max_c"),
                 F.avg("road_surface_temperature_c").alias("surface_mean_c"),
                 F.avg("air_temperature_c").alias("air_mean_c"),
                 F.sum(F.col("precipitation_intensity_mm_h") / F.lit(6.0)).alias("precip_sum_mm"),
                 (F.max_by("road_surface_temperature_c", "event_time")
                  - F.min_by("road_surface_temperature_c", "event_time")).alias("surface_change_c"),
                 F.count("*").alias("reading_count"))
            .select("station_id", F.col("w.start").alias("window_start"), F.col("w.end").alias("window_end"),
                    F.lit(minutes).alias("window_minutes"), "surface_min_c", "surface_max_c", "surface_mean_c",
                    "air_mean_c", "precip_sum_mm", "surface_change_c", "reading_count"))


def all_windows(obs: DataFrame, sizes: tuple[int, ...] = WINDOW_MINUTES) -> DataFrame:
    out = None
    for m in sizes:
        part = windowed_summary(obs, m)
        out = part if out is None else out.unionByName(part)
    return out


def with_trends(obs: DataFrame, tolerance_min: int = 5) -> DataFrame:
    """Adds temperature_change_1h and temperature_change_3h to every observation row.
    Reference reading = the latest reading between (t - H - tol) and (t - H + tol). Null if none."""
    ts = F.col("event_time").cast("long")
    d = obs.withColumn("_ts", ts)
    for label, hours in (("1h", 1), ("3h", 3)):
        lo, hi = -(hours * 3600 + tolerance_min * 60), -(hours * 3600 - tolerance_min * 60)
        frame = Window.partitionBy("station_id").orderBy("_ts").rangeBetween(lo, hi)
        d = d.withColumn(f"temperature_change_{label}",
                         F.col("road_surface_temperature_c") - F.last("road_surface_temperature_c", ignorenulls=True).over(frame))
    return d.drop("_ts")


def latest_per_station(obs: DataFrame, not_older_than_minutes: int = 30) -> DataFrame:
    """The newest observation per station, only if it is recent enough."""
    latest = (obs.groupBy("station_id")
              .agg(F.max_by(F.struct(*[c for c in obs.columns if c != "station_id"]), "event_time").alias("r"))
              .select("station_id", "r.*"))
    return latest.where(F.col("event_time") >= F.current_timestamp() - F.expr(f"INTERVAL {not_older_than_minutes} MINUTES"))
```

  2. Alternative for the trend, if you prefer a self-join (same result, easier to read, slower): join
     `obs` to itself on `station_id` with `b.event_time BETWEEN a.event_time - INTERVAL 65 MINUTES AND a.event_time - INTERVAL 55 MINUTES`,
     then `groupBy(a.*)` and `max_by(b.road_surface_temperature_c, b.event_time)`. Keep the range-window
     version in the code.

Expect: `uv run pytest tests/unit/test_windows.py` passes (T5.5).
If it fails: `F.window` needs a `timestamp` column, not a string (silver guarantees it); `rangeBetween`
needs a numeric ordering column, hence `_ts`.

### T5.3 Risk engine      owner: Safiul
Why: a deterministic, explainable score per segment is the product; it must be identical in Python (tests)
and in Spark (production).
Do:
  1. Create `src/frostsight/risk.py`:

```python
"""Icing risk v0. Pure-Python functions for tests and the same logic as native Spark expressions."""
from __future__ import annotations

from pyspark.sql import Column, DataFrame
from pyspark.sql import functions as F

FACTORS = ("surface_temp", "air_temp", "dew_point_spread", "precipitation", "temp_trend_1h")
LEVELS = ("LOW", "MEDIUM", "HIGH", "VERY_HIGH")


# ---------- pure Python ----------

def interp(x: float | None, pts: list[list[float]]) -> float:
    """Piecewise linear; flat outside the first and last breakpoint; None -> 0."""
    if x is None:
        return 0.0
    if x <= pts[0][0]:
        return float(pts[0][1])
    if x >= pts[-1][0]:
        return float(pts[-1][1])
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            return float(y0 + (y1 - y0) * (x - x0) / (x1 - x0))
    return 0.0


def factor_scores(row: dict, cfg: dict) -> dict[str, float]:
    """row keys: road_surface_temperature_c, air_temperature_c, dew_point_c, precipitation_type, temperature_change_1h."""
    bp = cfg["breakpoints"]
    air, dew = row.get("air_temperature_c"), row.get("dew_point_c")
    spread = None if air is None or dew is None else air - dew
    return {
        "surface_temp": interp(row.get("road_surface_temperature_c"), bp["surface_temp"]),
        "air_temp": interp(air, bp["air_temp"]),
        "dew_point_spread": interp(spread, bp["dew_point_spread"]),
        "precipitation": float(cfg["precipitation_scores"].get(row.get("precipitation_type") or "NONE",
                                                                cfg["precipitation_scores"]["UNKNOWN"])),
        "temp_trend_1h": interp(row.get("temperature_change_1h"), bp["temp_trend_1h"]),
    }


def icing_score(scores: dict[str, float], weights: dict[str, float]) -> float:
    return float(sum(weights[f] * scores[f] for f in FACTORS))


def risk_level(score: float, levels: dict[str, float]) -> str:
    if score >= levels["VERY_HIGH"]:
        return "VERY_HIGH"
    if score >= levels["HIGH"]:
        return "HIGH"
    if score >= levels["MEDIUM"]:
        return "MEDIUM"
    return "LOW"


def drivers(scores: dict[str, float], weights: dict[str, float], top: int = 3) -> list[tuple[str, float]]:
    contrib = [(f, round(weights[f] * scores[f], 6)) for f in FACTORS]
    return sorted(contrib, key=lambda kv: (-kv[1], kv[0]))[:top]


# ---------- Spark, same definitions ----------

def interp_expr(col: Column, pts: list[list[float]]) -> Column:
    """F.when chain equivalent of interp()."""
    expr = F.when(col.isNull(), F.lit(0.0)).when(col <= F.lit(pts[0][0]), F.lit(float(pts[0][1])))
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        slope = (y1 - y0) / (x1 - x0)
        expr = expr.when(col <= F.lit(x1), F.lit(float(y0)) + F.lit(slope) * (col - F.lit(x0)))
    return expr.otherwise(F.lit(float(pts[-1][1])))


def precip_expr(col: Column, scores: dict[str, float]) -> Column:
    expr = F.lit(float(scores["UNKNOWN"]))
    for k, v in scores.items():
        expr = F.when(F.coalesce(col, F.lit("NONE")) == k, F.lit(float(v))).otherwise(expr)
    return expr


def level_expr(score: Column, levels: dict[str, float]) -> Column:
    return (F.when(score >= levels["VERY_HIGH"], "VERY_HIGH")
             .when(score >= levels["HIGH"], "HIGH")
             .when(score >= levels["MEDIUM"], "MEDIUM")
             .otherwise("LOW"))


def with_risk(df: DataFrame, cfg: dict) -> DataFrame:
    """Adds icing_score, risk_score, risk_level, risk_drivers to a frame with the observation columns."""
    bp, w = cfg["breakpoints"], cfg["weights"]
    s = {
        "surface_temp": interp_expr(F.col("road_surface_temperature_c"), bp["surface_temp"]),
        "air_temp": interp_expr(F.col("air_temperature_c"), bp["air_temp"]),
        "dew_point_spread": interp_expr(F.col("air_temperature_c") - F.col("dew_point_c"), bp["dew_point_spread"]),
        "precipitation": precip_expr(F.col("precipitation_type"), cfg["precipitation_scores"]),
        "temp_trend_1h": interp_expr(F.col("temperature_change_1h"), bp["temp_trend_1h"]),
    }
    out = df
    for f in FACTORS:
        out = out.withColumn(f"_c_{f}", F.round(F.lit(float(w[f])) * s[f], 6))
    contrib_array = F.array(*[F.struct(F.lit(f).alias("factor"), F.col(f"_c_{f}").alias("contribution")) for f in FACTORS])
    # sort by contribution desc, then factor name asc; take the top N
    sorted_arr = F.expr(
        "array_sort(_contrib, (a, b) -> CASE WHEN a.contribution > b.contribution THEN -1 "
        "WHEN a.contribution < b.contribution THEN 1 WHEN a.factor < b.factor THEN -1 WHEN a.factor > b.factor THEN 1 ELSE 0 END)")
    out = (out.withColumn("_contrib", contrib_array)
              .withColumn("icing_score", F.round(sum(F.col(f"_c_{f}") for f in FACTORS), 6))
              .withColumn("risk_score", F.col("icing_score"))            # max(icing, closure, accident) later; icing only in MVP
              .withColumn("risk_level", level_expr(F.col("risk_score"), cfg["levels"]))
              .withColumn("risk_drivers", F.slice(sorted_arr, 1, int(cfg.get("drivers_top", 3))))
              .drop("_contrib", *[f"_c_{f}" for f in FACTORS]))
    return out
```

  2. The worked examples (used by the tests in T5.5), weights as in the YAML:

| Case | Inputs (surface, air, dew, precip, trend 1h) | Factor scores | Score | Level | Drivers |
|---|---|---|---|---|---|
| A cold clear night | -4.0, -3.0, -3.4, NONE, -0.5 | 1.0, 1.0, 1.0, 0.0, 0.25 | 0.6875 | HIGH | surface_temp 0.35, air_temp 0.15, dew_point_spread 0.15 |
| B mild rain | 4.0, 5.0, 3.0, RAIN, +0.5 | 0.0, 0.0, 0.4, 0.5, 0.0 | 0.16 | LOW | precipitation 0.10, dew_point_spread 0.06, air_temp 0.0 |
| C snow near zero, falling | -1.0, 0.5, -0.5, SNOW, -1.5 | 0.75, 0.4375, 0.8, 0.9, 0.625 | 0.721875 | HIGH | surface_temp 0.2625, precipitation 0.18, dew_point_spread 0.12 |

     Case C is 0.028 below VERY_HIGH: a good demo of what one more degree of cooling does.

Expect: `uv run pytest tests/unit/test_risk.py` passes.
If it fails: Spark and Python disagree on a boundary (check `<=` in both `interp` and `interp_expr`); the
lambda in `array_sort` is rejected (needs Spark 3.0+; local PySpark 3.5 has it).

### T5.4 Gold builder job      owner: Safiul
Why: gold tables are what dashboards query; they must be rebuilt idempotently every 10 minutes.
Do:
  1. Create `src/jobs/build_gold.py`:

```python
"""build_gold: windows, trends, icing risk and gold MERGEs. Runs after the pipeline update in `orchestrate`."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone

from delta.tables import DeltaTable
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F

from frostsight.config import replay_event, risk_config
from frostsight.risk import with_risk
from frostsight.windows import all_windows, latest_per_station, with_trends

spark = SparkSession.builder.getOrCreate()

RISK_COLS = ["road_segment_id", "station_id", "event_time", "icing_score", "risk_score", "risk_level", "risk_drivers",
             "road_surface_temperature_c", "air_temperature_c", "dew_point_c", "precipitation_type",
             "temperature_change_1h", "temperature_change_3h", "risk_updated_at", "model_version"]
HISTORY_KEY = ["road_segment_id", "event_time", "_batch_id"]

GOLD_DDL = {
    "road_weather_summary": """
        station_id STRING, road_segment_id STRING, window_start TIMESTAMP, window_end TIMESTAMP, window_minutes INT,
        surface_min_c DOUBLE, surface_max_c DOUBLE, surface_mean_c DOUBLE, air_mean_c DOUBLE, precip_sum_mm DOUBLE,
        surface_change_c DOUBLE, reading_count BIGINT, computed_at TIMESTAMP""",
    "road_segment_current_risk": """
        road_segment_id STRING, station_id STRING, event_time TIMESTAMP, icing_score DOUBLE, risk_score DOUBLE,
        risk_level STRING, risk_drivers ARRAY<STRUCT<factor: STRING, contribution: DOUBLE>>,
        road_surface_temperature_c DOUBLE, air_temperature_c DOUBLE, dew_point_c DOUBLE, precipitation_type STRING,
        temperature_change_1h DOUBLE, temperature_change_3h DOUBLE, risk_updated_at TIMESTAMP, model_version STRING""",
    "road_segment_risk_history": None,   # current-risk columns plus _batch_id, see ensure_tables
    "incident_summary": """
        road_segment_id STRING, active_incidents INT, incident_types ARRAY<STRING>, max_severity STRING,
        earliest_start TIMESTAMP, computed_at TIMESTAMP""",
    "historical_closures": """
        incident_id STRING, road_segment_id STRING, road_ref STRING, start_time TIMESTAMP, end_time TIMESTAMP,
        duration_min DOUBLE, description STRING, computed_at TIMESTAMP""",
}
CLUSTER = {
    "road_weather_summary": "station_id, window_start",
    "road_segment_current_risk": "road_segment_id",
    "road_segment_risk_history": "event_time",
    "incident_summary": "road_segment_id",
    "historical_closures": "road_segment_id",
}


def ensure_tables(catalog: str) -> None:
    for name, ddl in GOLD_DDL.items():
        cols = ddl or GOLD_DDL["road_segment_current_risk"] + ", _batch_id STRING"   # history: same marker as silver
        spark.sql(f"CREATE TABLE IF NOT EXISTS {catalog}.gold.{name} ({cols}) CLUSTER BY ({CLUSTER[name]})")


def _scored(obs: DataFrame, lookup: DataFrame, cfg: dict) -> DataFrame:
    """Risk per observation row, joined to its segment. Keeps _batch_id from silver."""
    return (with_risk(obs, cfg).join(lookup, "station_id", "inner")
            .withColumn("risk_updated_at", F.current_timestamp())
            .withColumn("model_version", F.lit(cfg["version"])))


def merge(df: DataFrame, table: str, keys: list[str], insert_only: bool = False) -> None:
    cond = " AND ".join(f"t.{k} <=> s.{k}" for k in keys)
    m = DeltaTable.forName(spark, table).alias("t").merge(df.alias("s"), cond)
    if not insert_only:
        m = m.whenMatchedUpdateAll()
    m.whenNotMatchedInsertAll().execute()


def build(catalog: str, since_hours: int, config_dir: str | None, include_replay: bool) -> None:
    cfg = risk_config(config_dir)
    now = datetime.now(timezone.utc)
    since = now - timedelta(hours=since_hours)
    obs = (spark.read.table(f"{catalog}.silver.road_weather_observations")
           .where(F.col("event_time") >= F.lit(since)))
    if not include_replay:                                   # live gold ignores replayed files (README section 4 naming)
        obs = obs.where(~F.col("_batch_id").startswith("replay:"))
    lookup = (spark.read.table(f"{catalog}.silver.station_segment_lookup")
              .select("station_id", "road_segment_id").dropDuplicates(["road_segment_id"]))   # one station per segment

    # 1. windows -> gold.road_weather_summary
    summary = (all_windows(obs).join(lookup, "station_id", "left")
               .withColumn("computed_at", F.current_timestamp()))
    merge(summary, f"{catalog}.gold.road_weather_summary", ["station_id", "window_start", "window_minutes"])

    # 2. latest reading per station with trends -> risk per segment
    latest = latest_per_station(with_trends(obs), not_older_than_minutes=30)
    scored = _scored(latest, lookup, cfg).select(*RISK_COLS, "_batch_id")
    merge(scored.select(*RISK_COLS), f"{catalog}.gold.road_segment_current_risk", ["road_segment_id"])
    merge(scored, f"{catalog}.gold.road_segment_risk_history", HISTORY_KEY, insert_only=True)

    # 3. active incidents per segment (overwrite: small, "now" semantics)
    inc = spark.read.table(f"{catalog}.silver.road_incidents")
    active = (inc.where("road_segment_id IS NOT NULL AND (end_time IS NULL OR end_time > current_timestamp())")
              .groupBy("road_segment_id")
              .agg(F.count("*").cast("int").alias("active_incidents"), F.collect_set("incident_type").alias("incident_types"),
                   F.max("severity").alias("max_severity"), F.min("start_time").alias("earliest_start"))
              .withColumn("computed_at", F.current_timestamp()))
    active.createOrReplaceTempView("active_incidents_now")
    spark.sql(f"""INSERT OVERWRITE {catalog}.gold.incident_summary
                  SELECT road_segment_id, active_incidents, incident_types, max_severity, earliest_start, computed_at
                  FROM active_incidents_now""")            # keeps the table's CLUSTER BY, unlike an overwrite saveAsTable

    # 4. closures with duration -> label table for ML and analytics (incident_type values are lower case, rule IN003)
    closures = (inc.where("incident_type = 'closure' AND end_time IS NOT NULL")
                .select("incident_id", "road_segment_id", "road_ref", "start_time", "end_time",
                        (F.unix_timestamp("end_time") - F.unix_timestamp("start_time")).cast("double").alias("_s"),
                        "description")
                .withColumn("duration_min", F.col("_s") / 60.0).drop("_s")
                .withColumn("computed_at", F.current_timestamp()))
    merge(closures, f"{catalog}.gold.historical_closures", ["incident_id"])
    print(f"gold built: window rows={summary.count()} risk rows={scored.count()} active segments={active.count()}")


def build_replay(catalog: str, event_id: str, config_dir: str | None) -> None:
    """Score every replayed observation inside one event's window into history, marked replay:<event_id>.
    Never writes current_risk, incident_summary, windows or closures (10_S1 D1). Rows are selected by window,
    not by their silver _batch_id: after a whole-winter backfill the same readings may sit in silver as
    replay:backfill_<day> rows, which are the same Frost values."""
    cfg, ev = risk_config(config_dir), replay_event(event_id, config_dir)
    obs = (spark.read.table(f"{catalog}.silver.road_weather_observations")
           .where(F.col("_batch_id").startswith("replay:") & ~F.col("_batch_id").startswith("replay:latest_"))
           .where(F.col("event_time").between(F.lit(ev["start"]).cast("timestamp"), F.lit(ev["end"]).cast("timestamp"))))
    lookup = (spark.read.table(f"{catalog}.silver.station_segment_lookup")
              .select("station_id", "road_segment_id").dropDuplicates(["road_segment_id"]))
    scored = (_scored(with_trends(obs), lookup, cfg).select(*RISK_COLS)
              .withColumn("_batch_id", F.lit(f"replay:{event_id}")))
    merge(scored, f"{catalog}.gold.road_segment_risk_history", HISTORY_KEY, insert_only=True)
    print(f"replay {event_id}: {scored.count()} history rows, window {ev['start']} to {ev['end']}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--catalog", required=True)
    p.add_argument("--since-hours", type=int, default=6)     # windows backfill, e.g. 168; risk only scores the newest reading
    p.add_argument("--config-dir", default=None)              # folder holding risk_weights.yml; None = repo layout / env var
    p.add_argument("--include-replay", action="store_true")   # windows over replay rows too; kept for old commands
    p.add_argument("--event-id", default="")                  # replay mode: history only, for one replay_events.yml id
    a = p.parse_args()
    ensure_tables(a.catalog)
    if a.event_id:
        build_replay(a.catalog, a.event_id, a.config_dir)
    else:
        build(a.catalog, a.since_hours, a.config_dir, a.include_replay)


if __name__ == "__main__":
    main()
```

  2. Create the M6 placeholder `src/jobs/build_freshness.py` so the chain is complete now:

```python
"""Placeholder until M6: prints and exits 0. M6 replaces it with gold.data_quality_summary and freshness rows."""
import argparse

p = argparse.ArgumentParser()
p.add_argument("--catalog", required=True)
p.add_argument("--config-dir", default=None)
args, _unknown = p.parse_known_args()
print(f"build_freshness placeholder for {args.catalog}")
```

  3. Why a separate replay mode: `build()` scores only the newest reading per station and only if it is
     under 30 minutes old (`latest_per_station`), so no `--since-hours` value can put last winter's
     readings into history. `build_replay` scores every observation of the event window, with trends
     computed inside the window. `with_trends` needs a reading 55 to 65 minutes earlier, so give every
     event in `replay_events.yml` a `start` one hour before the interesting part. The scheduled
     `orchestrate` job never passes `--event-id`; run it as a one-off (section 3), from the M7 demo
     preparation (08_M7 T7.8), or through the S1 `replay` job. Expect `replay <id>: <n> history rows`, with
     `n` about 30 stations x 6 readings per hour x the window hours.
  4. Idempotency check: run `databricks bundle run orchestrate -t personal --profile frostsight-personal` twice within one 10-minute
     collector slot. `DESCRIBE HISTORY frostsight.gold.road_segment_risk_history` must show the second MERGE
     with `numTargetRowsInserted = 0`; `current_risk` shows updates only (the same rows, newer `risk_updated_at`).

Expect: `SELECT risk_level, count(*) FROM frostsight.gold.road_segment_current_risk GROUP BY 1` returns 30 rows
in total (one per mapped station's segment) within 3 minutes of the pipeline update finishing.
If it fails: `UNRESOLVED_COLUMN _batch_id` in the history MERGE (the history table was created before this
version of `ensure_tables`: `ALTER TABLE frostsight.gold.road_segment_risk_history ADD COLUMNS (_batch_id STRING)`);
`DeltaTable.forName` fails on a table just created (`ensure_tables` runs first; check the
schema name); `MERGE` complains about duplicate matches (two stations mapped to the same segment: the lookup
must keep one station per segment, add `.dropDuplicates(["road_segment_id"])` on `lookup` and raise it with
Rayhan); the risk frame is empty because no observation is newer than 30 minutes (collector stopped, see
the M7 outage runbook).

### T5.5 Bundle: orchestrate job version 2      owner: Safiul, Rayhan
Why: gold must run right after each pipeline update, serially, within the five-task limit of Free Edition.
Do:
  1. Replace `resources/orchestrate.job.yml`:

```yaml
resources:
  jobs:
    orchestrate:
      name: frostsight-orchestrate
      description: "Every 10 min: pipeline update -> gold -> freshness. Serial chain, 3 of the 5 concurrent tasks Free Edition allows."
      max_concurrent_runs: 1
      timeout_seconds: 1500
      schedule:
        quartz_cron_expression: "0 0/10 * * * ?"
        timezone_id: UTC
        pause_status: ${var.schedule_pause_status}     # README variable: UNPAUSED on free and aws, PAUSED on personal
      email_notifications:
        on_failure: [ "${var.notification_email}" ]
        no_alert_for_skipped_runs: true
      parameters:
        - name: catalog
          default: ${var.catalog}
      environments:
        - environment_key: gold
          spec:
            client: "4"                                 # required: serverless base environment version
            dependencies:
              - ../dist/*.whl                           # frostsight wheel from the bundle `artifacts` block; pulls pyyaml
      tasks:
        - task_key: pipeline_update
          pipeline_task:
            pipeline_id: ${resources.pipelines.ingest.id}
            full_refresh: false
        - task_key: build_gold
          depends_on: [ { task_key: pipeline_update } ]
          environment_key: gold
          timeout_seconds: 600
          spark_python_task:
            python_file: ../src/jobs/build_gold.py
            parameters: [ "--catalog", "{{job.parameters.catalog}}", "--since-hours", "6",
                          "--config-dir", "${var.config_dir}" ]
        - task_key: build_freshness
          depends_on: [ { task_key: build_gold } ]
          run_if: ALL_DONE            # freshness must report even when gold failed (M6 uses this)
          environment_key: gold
          spark_python_task:
            python_file: ../src/jobs/build_freshness.py
            parameters: [ "--catalog", "{{job.parameters.catalog}}", "--config-dir", "${var.config_dir}" ]
```

     This is the final shape of the job: M6 only replaces the placeholder script behind `build_freshness`
     and M7 adds a `health` rule to it; nobody adds tasks (three of the five concurrent tasks Free Edition
     allows; `reference` uses the other two on Monday nights).

  2. Add the weekly maintenance task to `resources/reference.job.yml` (after `load_reference`):

```yaml
        - task_key: optimize_gold
          depends_on: [ { task_key: load_reference } ]
          run_if: ALL_DONE
          environment_key: geo
          spark_python_task:
            python_file: ../src/jobs/optimize_tables.py
            parameters: [ "--catalog", "${var.catalog}" ]
```

     with `src/jobs/optimize_tables.py`:

```python
import argparse
from pyspark.sql import SparkSession

spark = SparkSession.builder.getOrCreate()
parser = argparse.ArgumentParser()
parser.add_argument("--catalog", required=True)
catalog = parser.parse_args().catalog
for t in ("gold.road_segment_current_risk", "gold.road_segment_risk_history", "gold.road_weather_summary",
          "silver.road_weather_observations", "bronze.road_weather_events"):
    spark.sql(f"OPTIMIZE {catalog}.{t}")
    spark.sql(f"VACUUM {catalog}.{t}")            # default 7-day retention
    print("optimized", t)
```

  3. `databricks bundle validate -t personal --strict --profile frostsight-personal && databricks bundle deploy -t personal --profile frostsight-personal && databricks bundle run orchestrate -t personal --profile frostsight-personal`.
     Then the same on `free` from CI after merge (03_M2 T2.4).
  4. Concurrency note for the team: this chain has 3 tasks and runs them one at a time, like every job in
     this project (serial `depends_on`, `max_concurrent_runs: 1`). The Free Edition limit is 5 task runs
     *running* at the same moment across the account, so a serial job holds at most 1 of the 5 however many
     tasks it defines. With the stretch jobs added (S1 `replay`, S2 third `reference` task, S3 `predict` and
     `train`) the scheduled peak is 3; `13_stretch_review.md` has the schedule table. Ad-hoc test jobs go to
     personal accounts.

Expect: a run of `orchestrate` on `free` shows three green boxes in the job UI, total 4 to 7 minutes; the
next scheduled run is skipped (not queued) if the previous one is still running, and no email is sent for
the skip.
If it fails: `{{job.parameters.catalog}}` unresolved (the `parameters` block is missing);
`environments[].spec.client` missing; `${var.schedule_pause_status}` printed literally (variable not declared
in `databricks.yml`, 05_M4 T4.7); `build_freshness` runs while `build_gold` failed and hides the failure:
that is intended, the job still ends `FAILED` because `build_gold` did.

### T5.6 Tests      owner: Sani, Safiul
Why: the model is the product; a boundary bug would colour the whole map wrong.
Do:
  1. `tests/unit/test_risk.py`:

```python
import pytest
from pyspark.sql import functions as F

from frostsight.config import risk_config
from frostsight import risk

CFG = risk_config()
CASES = {  # (surface, air, dew, precip, trend) -> (score, level, top driver)
    "A": ((-4.0, -3.0, -3.4, "NONE", -0.5), 0.6875, "HIGH", "surface_temp"),
    "B": ((4.0, 5.0, 3.0, "RAIN", 0.5), 0.16, "LOW", "precipitation"),
    "C": ((-1.0, 0.5, -0.5, "SNOW", -1.5), 0.721875, "HIGH", "surface_temp"),
}


def _row(v):
    return {"road_surface_temperature_c": v[0], "air_temperature_c": v[1], "dew_point_c": v[2],
            "precipitation_type": v[3], "temperature_change_1h": v[4]}


@pytest.mark.parametrize("name", CASES)
def test_python_examples(name):
    inputs, score, level, top = CASES[name]
    s = risk.factor_scores(_row(inputs), CFG)
    total = risk.icing_score(s, CFG["weights"])
    assert total == pytest.approx(score, abs=1e-6)
    assert risk.risk_level(total, CFG["levels"]) == level
    assert risk.drivers(s, CFG["weights"])[0][0] == top


def test_spark_matches_python(spark):
    rows = [(_row(v[0]) | {"id": k}) for k, v in CASES.items()]
    df = spark.createDataFrame(rows)
    out = {r.id: r for r in risk.with_risk(df, CFG).collect()}
    for k, (inputs, score, level, top) in CASES.items():
        assert out[k].icing_score == pytest.approx(score, abs=1e-6)
        assert out[k].risk_level == level
        assert out[k].risk_drivers[0].factor == top
        assert len(out[k].risk_drivers) == 3


def test_missing_inputs_score_zero():
    s = risk.factor_scores({}, CFG)
    assert all(v == 0.0 for k, v in s.items() if k != "precipitation")
    assert risk.risk_level(risk.icing_score(s, CFG["weights"]), CFG["levels"]) == "LOW"


def test_level_monotone_in_score():
    order = {lvl: i for i, lvl in enumerate(risk.LEVELS)}
    prev = 0
    for i in range(0, 101):
        cur = order[risk.risk_level(i / 100, CFG["levels"])]
        assert cur >= prev
        prev = cur
    assert risk.risk_level(0.25, CFG["levels"]) == "MEDIUM" and risk.risk_level(0.2499, CFG["levels"]) == "LOW"
    assert risk.risk_level(0.75, CFG["levels"]) == "VERY_HIGH"


def test_interp_matches_spark_on_breakpoints(spark):
    pts = CFG["breakpoints"]["surface_temp"]
    xs = [-5.0, -2.0, -1.0, 0.0, 1.5, 3.0, 10.0]
    df = spark.createDataFrame([(x,) for x in xs], "x double")
    got = [r[0] for r in df.select(risk.interp_expr(F.col("x"), pts)).collect()]
    assert got == pytest.approx([risk.interp(x, pts) for x in xs])
```

  2. `tests/unit/test_windows.py`, five synthetic readings for one station:

```python
from datetime import datetime, timedelta

from pyspark.sql import functions as F

from frostsight import windows

T0 = datetime(2026, 11, 3, 6, 0)


def _obs(spark):
    # 06:00 -1.0 | 06:10 -1.5 | 06:30 -2.0 | 07:00 -3.0 | 07:10 -3.5   (surface), air = surface + 1, precip 0.6 mm/h
    rows = [(T0 + timedelta(minutes=m), s) for m, s in ((0, -1.0), (10, -1.5), (30, -2.0), (60, -3.0), (70, -3.5))]
    return (spark.createDataFrame(rows, "event_time timestamp, road_surface_temperature_c double")
            .withColumn("station_id", F.lit("1900177"))
            .withColumn("air_temperature_c", F.col("road_surface_temperature_c") + 1)
            .withColumn("precipitation_intensity_mm_h", F.lit(0.6)))


def test_windowed_summary_1h(spark):
    w = {r.window_start: r for r in windows.windowed_summary(_obs(spark), 60).collect()}
    first = w[T0]
    assert first.surface_min_c == -2.0 and first.surface_max_c == -1.0 and first.reading_count == 3
    assert abs(first.surface_change_c - (-1.0)) < 1e-9          # last (-2.0) minus first (-1.0)
    assert abs(first.precip_sum_mm - 0.3) < 1e-9                # 3 readings * 0.6/6


def test_trends(spark):
    t = {r.event_time: r for r in windows.with_trends(_obs(spark)).collect()}
    assert abs(t[T0 + timedelta(minutes=60)].temperature_change_1h - (-2.0)) < 1e-9   # 07:00 -3.0 vs 06:00 -1.0
    assert abs(t[T0 + timedelta(minutes=70)].temperature_change_1h - (-2.0)) < 1e-9   # 07:10 -3.5 vs 06:10 -1.5
    assert t[T0].temperature_change_1h is None                                       # nothing an hour earlier
    assert t[T0 + timedelta(minutes=70)].temperature_change_3h is None


def test_all_windows_has_four_sizes(spark):
    sizes = {r.window_minutes for r in windows.all_windows(_obs(spark)).select("window_minutes").distinct().collect()}
    assert sizes == {30, 60, 180, 360}
```

  3. `uv run pytest -q`; CI runs it on the pull request.

Expect: green. The trend test is the one most likely to expose an off-by-tolerance mistake.
If it fails: `F.last(..., ignorenulls=True)` over a range frame returns the current row when the frame
includes it (it must not: `hi` is negative); timestamps created without `timezone` are interpreted in the
session zone, which `conftest.py` sets to UTC.

### T5.7 Validation queries      owner: Safiul
Why: numbers you can read on a dashboard tile before the dashboard exists.
Do: run these in the SQL editor on `free` after two or three scheduled runs.

```sql
-- top 10 segments by risk right now
SELECT r.road_segment_id, s.road_category, s.road_number, r.risk_level, r.risk_score,
       r.road_surface_temperature_c, r.precipitation_type, r.temperature_change_1h, r.risk_drivers[0].factor AS top_driver
FROM frostsight.gold.road_segment_current_risk r JOIN frostsight.silver.road_segments s USING (road_segment_id)
ORDER BY r.risk_score DESC LIMIT 10;

-- level distribution
SELECT risk_level, count(*) AS segments, round(avg(risk_score), 3) AS mean_score
FROM frostsight.gold.road_segment_current_risk GROUP BY 1 ORDER BY min(risk_score);

-- driver frequency over the last 24 h of history
SELECT d.factor, count(*) AS times_in_top3, round(avg(d.contribution), 3) AS mean_contribution
FROM frostsight.gold.road_segment_risk_history LATERAL VIEW explode(risk_drivers) AS d
WHERE event_time >= current_timestamp() - INTERVAL 24 HOURS GROUP BY 1 ORDER BY 2 DESC;

-- latency from observation to risk row, minutes
SELECT round(avg(timestampdiff(SECOND, event_time, risk_updated_at)) / 60, 1) AS mean_min,
       round(percentile(timestampdiff(SECOND, event_time, risk_updated_at), 0.95) / 60, 1) AS p95_min
FROM frostsight.gold.road_segment_risk_history WHERE risk_updated_at >= current_timestamp() - INTERVAL 6 HOURS;

-- history growth and idempotency
SELECT count(*) AS rows, count(DISTINCT road_segment_id, event_time, _batch_id) AS keys, min(event_time), max(event_time)
FROM frostsight.gold.road_segment_risk_history;
```

Expect: latency mean under 15 minutes (10-minute cadence plus a 2 to 4 minute run); `rows = keys`; level
distribution in autumn mostly LOW with a few MEDIUM; the replay storm at S1 is where HIGH and VERY_HIGH
appear.
If it fails: latency above 20 minutes means the pipeline update exceeds the slot (check update durations in
the event log, look for a full refresh someone triggered); `rows > keys` means `insert_only` MERGE was
replaced by an append somewhere.

## 3. Performance note

County scale is small: 30 stations x 144 readings/day = 4,320 observations/day, about 20,000 segments,
30 risk rows every 10 minutes. Nothing here needs partitioning, and partitioning by date would create tiny
files. Rules:

- No `partitionBy`. Use liquid clustering: `CLUSTER BY (road_segment_id)` on `current_risk` and
  `incident_summary`, `(event_time)` on `risk_history`, `(station_id, window_start)` on `road_weather_summary`
  (created that way in `ensure_tables`).
- `OPTIMIZE` and `VACUUM` weekly from the `reference` job (T5.5 step 2); MERGE every 10 minutes creates
  small files and this is what compacts them.
- Keep `--since-hours 6` in the scheduled run; use larger values only for backfills of the window table,
  run by hand: `databricks jobs run-now --json '{"job_id": <orchestrate id>, ...}'` cannot change task
  parameters, so a backfill is a one-off task run from a notebook or
  `python build_gold.py --catalog frostsight --since-hours 168 --include-replay` on serverless (M7 T7.2).
  That rebuilds `road_weather_summary` only; risk history for a past event comes from
  `python build_gold.py --catalog frostsight --event-id <id from replay_events.yml>` (T5.4 step 3).
- Spark shuffle partitions: serverless sets `auto`; do not set them in the job.
- Nothing in gold reads bronze. If a query on the dashboard is slow at M6, the fix is another gold table,
  not a bigger warehouse (there is only the 2X-Small on Free Edition).

## 4. Done when

- [ ] `config/risk_weights.yml` loaded and validated; the three worked examples pass in Python and in Spark.
- [ ] `gold.road_weather_summary` has rows for all four window sizes per station, `surface_change_c` matches a manual check on one station.
- [ ] `gold.road_segment_current_risk` has one row per mapped segment with `risk_level`, three `risk_drivers`, `risk_updated_at` within 15 minutes of `event_time`.
- [ ] `gold.road_segment_risk_history` grows by about 30 rows per run, has `_batch_id`, no duplicate `(road_segment_id, event_time, _batch_id)`; `build_gold.py --event-id` writes history only.
- [ ] `gold.incident_summary` and `gold.historical_closures` exist; Sohanur has confirmed the closure columns fit the label definition.
- [ ] `orchestrate` runs pipeline -> gold -> freshness every 10 minutes on `free`, serial, `max_concurrent_runs: 1`, failure email tested once by breaking `--catalog` on `personal`.
- [ ] `reference` job optimises gold weekly.
- [ ] `uv run pytest` green locally and in CI; a second `orchestrate` run within one slot changes no history row.

## 5. Verify

```sql
SELECT 'gold.road_weather_summary' t, count(*) n FROM frostsight.gold.road_weather_summary
UNION ALL SELECT 'gold.road_segment_current_risk', count(*) FROM frostsight.gold.road_segment_current_risk
UNION ALL SELECT 'gold.road_segment_risk_history', count(*) FROM frostsight.gold.road_segment_risk_history
UNION ALL SELECT 'gold.incident_summary', count(*) FROM frostsight.gold.incident_summary
UNION ALL SELECT 'gold.historical_closures', count(*) FROM frostsight.gold.historical_closures;

SELECT window_minutes, count(*) AS windows, count(DISTINCT station_id) AS stations
FROM frostsight.gold.road_weather_summary WHERE window_start >= current_timestamp() - INTERVAL 6 HOURS GROUP BY 1;

SELECT road_segment_id, risk_level, risk_score, risk_drivers, risk_updated_at
FROM frostsight.gold.road_segment_current_risk ORDER BY risk_updated_at DESC LIMIT 5;

DESCRIBE HISTORY frostsight.gold.road_segment_risk_history LIMIT 3;   -- operation MERGE, operationMetrics.numTargetRowsInserted
```

```bash
cd project && uv run pytest -q
databricks bundle summary -t free --output json --profile frostsight-free | jq '.resources.jobs.orchestrate | {id, url}'
databricks jobs list-runs --job-id <orchestrate id> --limit 3 --profile frostsight-free | jq '.runs[] | {state: .state.result_state, start: .start_time, duration: .run_duration}'
```
