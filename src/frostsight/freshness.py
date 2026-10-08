"""Freshness status per source for gold.data_quality_summary (07_M6 T6.2 columns)."""

from __future__ import annotations

from pyspark.sql import Column
from pyspark.sql import functions as F


def freshness_status(age_min: float | None, threshold_min: float) -> str:
    if age_min is None:
        return "NO_DATA"
    return "FRESH" if age_min <= threshold_min else "STALE"


def freshness_status_expr(age_min: Column, threshold_min: Column) -> Column:
    return (
        F.when(age_min.isNull(), F.lit("NO_DATA"))
        .when(age_min <= threshold_min, F.lit("FRESH"))
        .otherwise(F.lit("STALE"))
    )
