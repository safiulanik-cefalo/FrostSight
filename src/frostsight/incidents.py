"""Incidents from the DATEX situation feed, placed on the monitored road network.

See docs/gold-from-team-silver.md B6.
"""

from __future__ import annotations

import math
import re

from pyspark.sql import Column, DataFrame, Window
from pyspark.sql import functions as F

SEVERITY_RANK = {"HIGHEST": 4, "HIGH": 3, "MEDIUM": 2, "LOW": 1}  # NONE, UNKNOWN and anything else rank 0
EARTH_RADIUS_M = 6_371_000.0


def road_key(road_ref: str | None) -> str | None:
    """DATEX road_ref (`E8`, `F91`, `R83`, `Fv 91`) and NVDB category plus number to one key, `E8`, `F91`."""
    if not road_ref:
        return None
    m = re.match(r"^\s*([ERFK])[a-z]*\s*(\d+)", road_ref.strip(), re.IGNORECASE)
    return f"{m.group(1).upper()}{m.group(2)}" if m else None


def is_active(start_epoch: float | None, end_epoch: float | None, now_epoch: float) -> bool:
    return (
        start_epoch is not None and start_epoch <= now_epoch and (end_epoch is None or end_epoch > now_epoch)
    )


def severity_rank(severity: str | None) -> int:
    return SEVERITY_RANK.get((severity or "").upper(), 0)


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (
        math.sin((p2 - p1) / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


# ---------- Spark twins ----------


def road_key_expr(road_ref: Column) -> Column:
    m = F.regexp_extract(F.upper(F.trim(road_ref)), r"^([ERFK])[A-Z]*\s*(\d+)", 0)
    key = F.regexp_replace(m, r"^([ERFK])[A-Z]*\s*", "$1")
    return F.when(m == "", F.lit(None).cast("string")).otherwise(key)


def severity_rank_expr(severity: Column) -> Column:
    expr = F.lit(0)
    for k, v in SEVERITY_RANK.items():
        expr = F.when(F.upper(severity) == k, F.lit(v)).otherwise(expr)
    return expr


def distance_m_expr(lat1: Column, lon1: Column, lat2: Column, lon2: Column) -> Column:
    a = F.pow(F.sin(F.radians(lat2 - lat1) / 2), 2) + F.cos(F.radians(lat1)) * F.cos(F.radians(lat2)) * F.pow(
        F.sin(F.radians(lon2 - lon1) / 2), 2
    )
    return F.lit(2 * EARTH_RADIUS_M) * F.asin(F.sqrt(a))


def place_incidents(
    incidents: DataFrame, road_points: DataFrame, segments: DataFrame, within_m: float
) -> DataFrame:
    """Keep incidents within `within_m` of a monitored road point; give each the nearest segment on its
    own road within `within_m`, else a NULL road_segment_id.

    incidents: incident_id, road_ref, lat, lon, ...; road_points: latitude, longitude;
    segments: road_segment_id, road_key, centroid_lat, centroid_lon.
    """
    inc = incidents.withColumn("_rid", F.monotonically_increasing_id()).withColumn(
        "road_key", road_key_expr(F.col("road_ref"))
    )
    near = (
        inc.select("_rid", "lat", "lon")
        .crossJoin(road_points.select("latitude", "longitude"))
        .where(distance_m_expr(F.col("lat"), F.col("lon"), F.col("latitude"), F.col("longitude")) <= within_m)
        .select("_rid")
        .distinct()
    )
    seg = (
        inc.select("_rid", "road_key", "lat", "lon")
        .join(segments.select("road_segment_id", "road_key", "centroid_lat", "centroid_lon"), "road_key")
        .withColumn(
            "_d", distance_m_expr(F.col("lat"), F.col("lon"), F.col("centroid_lat"), F.col("centroid_lon"))
        )
        .where(F.col("_d") <= within_m)
        .withColumn("_n", F.row_number().over(Window.partitionBy("_rid").orderBy("_d")))
        .where("_n = 1")
        .select("_rid", "road_segment_id")
    )
    return inc.join(near, "_rid").join(seg, "_rid", "left").drop("_rid")
