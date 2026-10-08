"""Surface-temperature trends per station (06_M5 decision table: range bands, null without a reading)."""

from __future__ import annotations

from datetime import datetime, timedelta

from pyspark.sql import Column, DataFrame, Window
from pyspark.sql import functions as F

TREND_BANDS_MIN = {"temperature_change_1h": (55, 65), "temperature_change_3h": (175, 185)}


def change_in_band(
    readings: list[tuple[datetime, float | None]], at: datetime, lo_min: int, hi_min: int
) -> float | None:
    """Surface at `at` minus the newest non-null reading lo_min to hi_min minutes earlier, else None."""
    now = [v for t, v in readings if t == at and v is not None]
    if not now:
        return None
    band = [
        (t, v)
        for t, v in readings
        if v is not None and at - timedelta(minutes=hi_min) <= t <= at - timedelta(minutes=lo_min)
    ]
    if not band:
        return None
    return round(now[0] - max(band)[1], 2)


def _band(lo_min: int, hi_min: int) -> Column:
    w = (
        Window.partitionBy("station_id")
        .orderBy(F.col("event_time").cast("long"))
        .rangeBetween(-hi_min * 60, -lo_min * 60)
    )
    return F.last("road_surface_temperature_c", ignorenulls=True).over(w)


def with_trends(obs: DataFrame) -> DataFrame:
    """Adds temperature_change_1h and _3h, the Spark twin of change_in_band()."""
    out = obs
    for name, (lo, hi) in TREND_BANDS_MIN.items():
        out = out.withColumn(name, F.round(F.col("road_surface_temperature_c") - _band(lo, hi), 2))
    return out
