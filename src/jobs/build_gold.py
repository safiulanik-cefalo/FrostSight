"""build_gold: gold tables for the live dashboard from the team's silver (docs/gold-from-team-silver.md).

Reads the Troms rows of silver.datex_road_weather_silver and silver.datex_incidents_silver, which hold only
the newest snapshot (B2), so gold keeps its own append-only copy of every reading it sees
(gold.road_weather_observation_log) until silver keeps history. Then: trends, risk v0, current risk per
segment, insert-only risk history, incidents on the monitored roads, freshness.

The road network and the station-to-segment lookup are the interim silver.nvdb_seed_* tables (B3), loaded by
tools/mock_dashboards/deploy.py --dashboard live --load-reference.
"""

from __future__ import annotations

import argparse

from delta.tables import DeltaTable
from pyspark.sql import DataFrame, SparkSession, Window
from pyspark.sql import functions as F

from frostsight.config import risk_config
from frostsight.freshness import freshness_status_expr
from frostsight.incidents import place_incidents, severity_rank_expr
from frostsight.risk import infer_precipitation_expr, with_risk
from frostsight.windows import with_trends

spark = SparkSession.builder.getOrCreate()

COUNTY = "Troms"  # DATEX `county` value for the pilot county (fylke 55, ADR-0002)
STATION_COVERAGE_M = 5000.0  # 04_M3 T3.3 step 7: a station covers its own road within 5 km

RISK_COLS = [
    "road_segment_id", "station_id", "event_time", "icing_score", "risk_score", "risk_level", "risk_drivers",
    "road_surface_temperature_c", "air_temperature_c", "dew_point_c", "precipitation_type",
    "temperature_change_1h", "temperature_change_3h", "risk_updated_at", "model_version",
]  # fmt: skip
CURRENT_DDL = """
    road_segment_id STRING, station_id STRING, event_time TIMESTAMP, icing_score DOUBLE, risk_score DOUBLE,
    risk_level STRING, risk_drivers ARRAY<STRUCT<factor: STRING, contribution: DOUBLE>>,
    road_surface_temperature_c DOUBLE, air_temperature_c DOUBLE, dew_point_c DOUBLE,
    precipitation_type STRING, temperature_change_1h DOUBLE, temperature_change_3h DOUBLE,
    risk_updated_at TIMESTAMP, model_version STRING"""
DQ_DDL = """
    source STRING, last_successful_ingestion TIMESTAMP, last_event_time TIMESTAMP, ingestion_delay_min DOUBLE,
    threshold_min INT, status STRING, rows_last_24h BIGINT, quarantined_last_24h BIGINT,
    computed_at TIMESTAMP"""
GOLD_DDL = {
    "road_weather_observation_log": """
        station_id STRING, event_time TIMESTAMP, published_at TIMESTAMP, road_ref STRING,
        location_description STRING, air_temperature_c DOUBLE, road_surface_temperature_c DOUBLE,
        dew_point_c DOUBLE, humidity_pct DOUBLE, precipitation_intensity_mm_h DOUBLE,
        precipitation_type STRING, precipitation_type_source STRING, wind_speed_ms DOUBLE,
        wind_direction_deg DOUBLE, snow_depth_m DOUBLE, lat DOUBLE, lon DOUBLE,
        bronze_ingestion_timestamp TIMESTAMP, _batch_id STRING, _logged_at TIMESTAMP""",
    "road_segment_current_risk": CURRENT_DDL,
    "road_segment_risk_history": CURRENT_DDL + ", _batch_id STRING",
    "road_incidents": """
        incident_id STRING, incident_version STRING, situation_id STRING, incident_type STRING,
        severity STRING, road_ref STRING, road_number STRING, road_segment_id STRING, start_time TIMESTAMP,
        end_time TIMESTAMP, description STRING, latitude DOUBLE, longitude DOUBLE, snapshot_time TIMESTAMP""",
    "incident_summary": """
        road_segment_id STRING, active_incidents INT, incident_types ARRAY<STRING>, max_severity STRING,
        earliest_start TIMESTAMP, computed_at TIMESTAMP""",
    "data_quality_summary": DQ_DDL,
    "data_quality_summary_history": DQ_DDL,
}
CLUSTER = {
    "road_weather_observation_log": "station_id, event_time",
    "road_segment_current_risk": "road_segment_id",
    "road_segment_risk_history": "event_time",
    "road_incidents": "road_segment_id",
    "incident_summary": "road_segment_id",
    "data_quality_summary": "source",
    "data_quality_summary_history": "computed_at",
}


def ensure_tables(catalog: str) -> None:
    for name, ddl in GOLD_DDL.items():
        spark.sql(f"CREATE TABLE IF NOT EXISTS {catalog}.gold.{name} ({ddl}) CLUSTER BY ({CLUSTER[name]})")


def merge(df: DataFrame, table: str, keys: list[str], insert_only: bool = False) -> None:
    cond = " AND ".join(f"t.{k} <=> s.{k}" for k in keys)
    m = DeltaTable.forName(spark, table).alias("t").merge(df.alias("s"), cond)
    if not insert_only:
        m = m.whenMatchedUpdateAll()
    m.whenNotMatchedInsertAll().execute()


def overwrite(df: DataFrame, table: str) -> None:
    """INSERT OVERWRITE keeps the table's CLUSTER BY, unlike an overwrite saveAsTable."""
    view = "_overwrite_" + table.rsplit(".", 1)[-1]
    df.createOrReplaceTempView(view)
    spark.sql(f"INSERT OVERWRITE {table} SELECT * FROM {view}")


def log_snapshot(catalog: str, cfg: dict) -> DataFrame:
    """Append the Troms rows of the current silver snapshot to the log; returns the snapshot."""
    snap = spark.read.table(f"{catalog}.silver.datex_road_weather_silver").where(F.col("county") == COUNTY)
    rows = snap.select(
        "station_id", "event_time", "published_at", "road_ref", "location_description", "air_temperature_c",
        "road_surface_temperature_c", "dew_point_c", "humidity_pct", "precipitation_intensity_mm_h",
        infer_precipitation_expr(
            F.col("precipitation_type"),
            F.col("precipitation_intensity_mm_h"),
            F.col("air_temperature_c"),
            cfg,
        ).alias("precipitation_type"),
        F.col("precipitation_type").alias("precipitation_type_source"),
        "wind_speed_ms", "wind_direction_deg", "snow_depth_m", "lat", "lon", "bronze_ingestion_timestamp",
        F.date_format("bronze_ingestion_timestamp", "yyyyMMdd'T'HHmmss'Z'").alias("_batch_id"),
        F.current_timestamp().alias("_logged_at"),
    )  # fmt: skip
    merge(
        rows, f"{catalog}.gold.road_weather_observation_log", ["station_id", "event_time"], insert_only=True
    )
    return snap


def build_risk(catalog: str, cfg: dict, current_window_min: int) -> None:
    log = spark.read.table(f"{catalog}.gold.road_weather_observation_log")
    lookup = spark.read.table(f"{catalog}.silver.nvdb_seed_stations").select("station_id", "road_segment_id")
    scored = (
        with_risk(with_trends(log), cfg)
        .join(lookup, "station_id")
        .withColumn("risk_updated_at", F.current_timestamp())
        .withColumn("model_version", F.lit(cfg["version"]))
    )
    merge(
        scored.select(*RISK_COLS, "_batch_id"),
        f"{catalog}.gold.road_segment_risk_history",
        ["road_segment_id", "event_time", "_batch_id"],
        insert_only=True,
    )
    # Current row: the newest reading per segment, if its station reported within current_window_min of the
    # newest reading of the latest fetch. Stations silent longer keep their previous row; the dashboard marks
    # them stale (06_M5 decision table: 30 minutes).
    newest = log.agg(F.max("event_time")).first()[0]
    fresh = scored.where(
        F.col("event_time") >= F.lit(newest) - F.expr(f"INTERVAL {current_window_min} MINUTES")
    )
    w = Window.partitionBy("road_segment_id").orderBy(F.col("event_time").desc())
    current = fresh.withColumn("_n", F.row_number().over(w)).where("_n = 1").select(*RISK_COLS)
    # history holds only new rows' risk_updated_at; the current row keeps the time it was first scored
    first_scored = spark.read.table(f"{catalog}.gold.road_segment_risk_history").select(
        "road_segment_id", "event_time", F.col("risk_updated_at").alias("_first")
    )
    current = (
        current.join(first_scored, ["road_segment_id", "event_time"], "left")
        .withColumn("risk_updated_at", F.coalesce("_first", "risk_updated_at"))
        .drop("_first")
        .dropDuplicates(["road_segment_id"])
    )
    merge(current, f"{catalog}.gold.road_segment_current_risk", ["road_segment_id"])


def build_incidents(catalog: str) -> None:
    inc = spark.read.table(f"{catalog}.silver.datex_incidents_silver")
    points = spark.read.table(f"{catalog}.silver.nvdb_seed_road_points")
    segments = spark.read.table(f"{catalog}.silver.nvdb_seed_segments").withColumn(
        "road_key", F.concat("road_category", "road_number")
    )
    placed = place_incidents(inc, points, segments, STATION_COVERAGE_M).select(
        "incident_id", "incident_version", "situation_id", "incident_type", "severity", "road_ref",
        F.regexp_extract("road_ref", r"(\d+)", 1).alias("road_number"), "road_segment_id", "start_time",
        "end_time", "description", F.col("lat").alias("latitude"), F.col("lon").alias("longitude"),
        F.col("bronze_ingestion_timestamp").alias("snapshot_time"),
    )  # fmt: skip
    overwrite(placed, f"{catalog}.gold.road_incidents")

    # is_active in silver is always false (B6): active is decided by time. One situation can be several rows.
    now = F.current_timestamp()
    active = placed.where(
        F.col("road_segment_id").isNotNull()
        & (F.col("start_time") <= now)
        & (F.col("end_time").isNull() | (F.col("end_time") > now))
    )
    summary = (
        active.withColumn("_rank", severity_rank_expr(F.col("severity")))
        .groupBy("road_segment_id")
        .agg(
            F.countDistinct(F.coalesce("situation_id", "incident_id")).cast("int").alias("active_incidents"),
            F.collect_set("incident_type").alias("incident_types"),
            F.max_by("severity", "_rank").alias("max_severity"),
            F.min("start_time").alias("earliest_start"),
        )
        .withColumn("computed_at", now)
    )
    overwrite(summary, f"{catalog}.gold.incident_summary")


def build_freshness(catalog: str, stale_after_min: int, forecast_threshold_min: int) -> None:
    log = spark.read.table(f"{catalog}.gold.road_weather_observation_log")
    rw = spark.read.table(f"{catalog}.silver.datex_road_weather_silver").where(F.col("county") == COUNTY)
    inc = spark.read.table(f"{catalog}.silver.datex_incidents_silver")
    fc = spark.read.table(f"{catalog}.silver.met_locationforecast_silver")
    day_ago = F.current_timestamp() - F.expr("INTERVAL 24 HOURS")

    def row(source: str, df: DataFrame, event_col: str | None, rows: DataFrame, threshold: int) -> DataFrame:
        event = F.max(event_col) if event_col else F.max("bronze_ingestion_timestamp")
        agg = df.agg(F.max("bronze_ingestion_timestamp").alias("ing"), event.alias("ev"))
        return agg.crossJoin(rows.agg(F.count("*").alias("rows_last_24h"))).select(
            F.lit(source).alias("source"),
            F.col("ing").alias("last_successful_ingestion"),
            F.col("ev").alias("last_event_time"),
            F.round((F.unix_timestamp(F.current_timestamp()) - F.unix_timestamp("ev")) / 60.0, 1).alias(
                "ingestion_delay_min"
            ),
            F.lit(threshold).alias("threshold_min"),
            "rows_last_24h",
        )

    parts = [
        row("road_weather", rw, "event_time", log.where(F.col("_logged_at") >= day_ago), stale_after_min),
        # incidents are state, not measurements: their age is the age of the snapshot
        row(
            "incidents", inc, None, inc.where(F.col("bronze_ingestion_timestamp") >= day_ago), stale_after_min
        ),
        row(
            "forecast",
            fc,
            None,
            fc.where(F.col("bronze_ingestion_timestamp") >= day_ago),
            forecast_threshold_min,
        ),
    ]
    out = parts[0].unionByName(parts[1]).unionByName(parts[2])
    out = out.select(
        "source", "last_successful_ingestion", "last_event_time", "ingestion_delay_min",
        F.col("threshold_min").cast("int"),
        freshness_status_expr(F.col("ingestion_delay_min"), F.col("threshold_min")).alias("status"),
        F.col("rows_last_24h").cast("bigint"),
        F.lit(None).cast("bigint").alias("quarantined_last_24h"),  # no quarantine tables yet (B7)
        F.current_timestamp().alias("computed_at"),
    )  # fmt: skip
    overwrite(out, f"{catalog}.gold.data_quality_summary")
    spark.sql(
        f"INSERT INTO {catalog}.gold.data_quality_summary_history "
        f"SELECT * FROM {catalog}.gold.data_quality_summary"
    )


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--catalog", default="frostsight")
    p.add_argument("--config-dir", default=None)
    p.add_argument(
        "--stale-after-min",
        type=int,
        default=300,
        help="road-weather and incident freshness threshold (development cadence: a fetch every 4 h)",
    )
    p.add_argument(
        "--current-window-min",
        type=int,
        default=30,
        help="a station is current if it reported within this many minutes of the newest reading",
    )
    p.add_argument("--forecast-threshold-min", type=int, default=1440)
    a, _ = p.parse_known_args()
    cfg = risk_config(a.config_dir)

    ensure_tables(a.catalog)
    log_snapshot(a.catalog, cfg)
    build_risk(a.catalog, cfg, a.current_window_min)
    build_incidents(a.catalog)
    build_freshness(a.catalog, a.stale_after_min, a.forecast_threshold_min)
    for t in ("road_weather_observation_log", "road_segment_current_risk", "road_segment_risk_history",
              "road_incidents", "incident_summary"):  # fmt: skip
        print(f"gold.{t}: {spark.read.table(f'{a.catalog}.gold.{t}').count()} rows")


if __name__ == "__main__":
    main()
