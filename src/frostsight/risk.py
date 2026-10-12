"""Icing risk v0 (06_M5 T5.3). Pure-Python functions for tests, and the same logic as Spark expressions."""

from __future__ import annotations

from typing import Any

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
    for (x0, y0), (x1, y1) in zip(pts, pts[1:], strict=False):
        if x0 <= x <= x1:
            return float(y0 + (y1 - y0) * (x - x0) / (x1 - x0))
    return 0.0


def infer_precipitation_type(
    source_type: str | None, intensity_mm_h: float | None, air_c: float | None, cfg: dict[str, Any]
) -> str:
    """Keep a known source type; for UNKNOWN or missing, derive it from intensity and air temperature."""
    if source_type and source_type != "UNKNOWN":
        return source_type
    if intensity_mm_h is None:
        return "UNKNOWN"
    if intensity_mm_h <= 0:
        return "NONE"
    if air_c is None:
        return "UNKNOWN"
    inf = cfg["precipitation_inference"]
    if air_c <= inf["snow_max_air_c"]:
        return "SNOW"
    if air_c <= inf["sleet_max_air_c"]:
        return "SLEET"
    return "RAIN"


def factor_scores(row: dict[str, Any], cfg: dict[str, Any]) -> dict[str, float]:
    """row keys: road_surface_temperature_c, air_temperature_c, dew_point_c, precipitation_type,
    temperature_change_1h."""
    bp = cfg["breakpoints"]
    air, dew = row.get("air_temperature_c"), row.get("dew_point_c")
    spread = None if air is None or dew is None else air - dew
    scores = cfg["precipitation_scores"]
    return {
        "surface_temp": interp(row.get("road_surface_temperature_c"), bp["surface_temp"]),
        "air_temp": interp(air, bp["air_temp"]),
        "dew_point_spread": interp(spread, bp["dew_point_spread"]),
        "precipitation": float(scores.get(row.get("precipitation_type") or "NONE", scores["UNKNOWN"])),
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
    for (x0, y0), (x1, y1) in zip(pts, pts[1:], strict=False):
        slope = (y1 - y0) / (x1 - x0)
        expr = expr.when(col <= F.lit(x1), F.lit(float(y0)) + F.lit(slope) * (col - F.lit(x0)))
    return expr.otherwise(F.lit(float(pts[-1][1])))


def infer_precipitation_expr(type_col: Column, intensity: Column, air: Column, cfg: dict[str, Any]) -> Column:
    inf = cfg["precipitation_inference"]
    return (
        F.when(type_col.isNotNull() & (type_col != "UNKNOWN"), type_col)
        .when(intensity.isNull(), F.lit("UNKNOWN"))
        .when(intensity <= 0, F.lit("NONE"))
        .when(air.isNull(), F.lit("UNKNOWN"))
        .when(air <= F.lit(float(inf["snow_max_air_c"])), F.lit("SNOW"))
        .when(air <= F.lit(float(inf["sleet_max_air_c"])), F.lit("SLEET"))
        .otherwise(F.lit("RAIN"))
    )


def precip_expr(col: Column, scores: dict[str, float]) -> Column:
    expr = F.lit(float(scores["UNKNOWN"]))
    for k, v in scores.items():
        expr = F.when(F.coalesce(col, F.lit("NONE")) == k, F.lit(float(v))).otherwise(expr)
    return expr


def level_expr(score: Column, levels: dict[str, float]) -> Column:
    return (
        F.when(score >= levels["VERY_HIGH"], "VERY_HIGH")
        .when(score >= levels["HIGH"], "HIGH")
        .when(score >= levels["MEDIUM"], "MEDIUM")
        .otherwise("LOW")
    )


def with_risk(df: DataFrame, cfg: dict[str, Any]) -> DataFrame:
    """Adds icing_score, risk_score, risk_level, risk_drivers to a frame with the observation columns."""
    bp, w = cfg["breakpoints"], cfg["weights"]
    s = {
        "surface_temp": interp_expr(F.col("road_surface_temperature_c"), bp["surface_temp"]),
        "air_temp": interp_expr(F.col("air_temperature_c"), bp["air_temp"]),
        "dew_point_spread": interp_expr(
            F.col("air_temperature_c") - F.col("dew_point_c"), bp["dew_point_spread"]
        ),
        "precipitation": precip_expr(F.col("precipitation_type"), cfg["precipitation_scores"]),
        "temp_trend_1h": interp_expr(F.col("temperature_change_1h"), bp["temp_trend_1h"]),
    }
    out = df
    for f in FACTORS:
        out = out.withColumn(f"_c_{f}", F.round(F.lit(float(w[f])) * s[f], 6))
    contrib_array = F.array(
        *[F.struct(F.lit(f).alias("factor"), F.col(f"_c_{f}").alias("contribution")) for f in FACTORS]
    )
    # sort by contribution desc, then factor name asc; take the top N
    sorted_arr = F.expr(
        "array_sort(_contrib, (a, b) -> CASE WHEN a.contribution > b.contribution THEN -1 "
        "WHEN a.contribution < b.contribution THEN 1 WHEN a.factor < b.factor THEN -1 "
        "WHEN a.factor > b.factor THEN 1 ELSE 0 END)"
    )
    total = F.col(f"_c_{FACTORS[0]}")
    for f in FACTORS[1:]:
        total = total + F.col(f"_c_{f}")
    return (
        out.withColumn("_contrib", contrib_array)
        .withColumn("icing_score", F.round(total, 6))
        .withColumn("risk_score", F.col("icing_score"))  # max(icing, closure, accident) later; icing only now
        .withColumn("risk_level", level_expr(F.col("risk_score"), cfg["levels"]))
        .withColumn("risk_drivers", F.slice(sorted_arr, 1, int(cfg.get("drivers_top", 3))))
        .drop("_contrib", *[f"_c_{f}" for f in FACTORS])
    )
