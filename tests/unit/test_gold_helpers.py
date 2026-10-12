from datetime import UTC, datetime, timedelta

import pytest

from frostsight.freshness import freshness_status
from frostsight.incidents import distance_m, is_active, road_key, severity_rank
from frostsight.windows import change_in_band

T0 = datetime(2026, 10, 8, 6, 0, tzinfo=UTC)


def at(minutes: int) -> datetime:
    return T0 + timedelta(minutes=minutes)


def test_change_in_band_uses_newest_reading_in_band():
    readings = [(at(0), 2.0), (at(5), 1.5), (at(60), -0.5)]
    assert change_in_band(readings, at(60), 55, 65) == pytest.approx(-2.0)  # 60 - 5 = 55 min, in the band


def test_change_in_band_is_none_without_a_reading_in_band():
    readings = [(at(0), 2.0), (at(240), -1.0)]  # a fetch every 4 h: nothing 55 to 65 min earlier
    assert change_in_band(readings, at(240), 55, 65) is None
    assert change_in_band(readings, at(240), 175, 185) is None


def test_change_in_band_skips_null_surface():
    assert change_in_band([(at(0), None), (at(60), 1.0)], at(60), 55, 65) is None
    assert change_in_band([(at(0), 1.0), (at(60), None)], at(60), 55, 65) is None


@pytest.mark.parametrize(
    "age, threshold, expected",
    [(None, 30, "NO_DATA"), (10, 30, "FRESH"), (30, 30, "FRESH"), (31, 30, "STALE")],
)
def test_freshness_status(age, threshold, expected):
    assert freshness_status(age, threshold) == expected


@pytest.mark.parametrize(
    "ref, expected",
    [
        ("E8", "E8"),
        ("F91", "F91"),
        ("R83", "R83"),
        ("Fv 91", "F91"),
        ("rv83", "R83"),
        ("", None),
        (None, None),
    ],
)
def test_road_key(ref, expected):
    assert road_key(ref) == expected


def test_is_active_by_time():
    now = 1_000.0
    assert is_active(900.0, None, now)
    assert is_active(900.0, 1_100.0, now)
    assert not is_active(900.0, 1_000.0, now)  # ended exactly now
    assert not is_active(1_100.0, 1_200.0, now)  # planned works, not started
    assert not is_active(None, None, now)


def test_severity_rank_orders_highest_first():
    ranked = sorted(["LOW", "HIGHEST", "NONE", "HIGH", "UNKNOWN", None], key=severity_rank, reverse=True)
    assert ranked[:3] == ["HIGHEST", "HIGH", "LOW"]


def test_distance_m_one_hundredth_degree_latitude():
    assert distance_m(69.65, 18.96, 69.66, 18.96) == pytest.approx(1112, abs=2)


def test_spark_twins(spark):
    from pyspark.sql import functions as F

    from frostsight.incidents import road_key_expr, severity_rank_expr

    refs = ["E8", "F91", "Fv 91", "rv83", "", None]
    sevs = ["LOW", "HIGHEST", "NONE", "HIGH", None, "x"]
    df = spark.createDataFrame(list(zip(refs, sevs, strict=True)), "r string, s string")
    got = df.select(road_key_expr(F.col("r")).alias("k"), severity_rank_expr(F.col("s")).alias("n")).collect()
    assert [g.k for g in got] == [road_key(r) for r in refs]
    assert [g.n for g in got] == [severity_rank(s) for s in sevs]
