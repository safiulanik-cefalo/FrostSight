import pytest

from frostsight.config import risk_config
from frostsight.risk import drivers, factor_scores, icing_score, infer_precipitation_type, interp, risk_level

CFG = risk_config()


def score(surface, air, dew, precip, trend):
    row = {
        "road_surface_temperature_c": surface,
        "air_temperature_c": air,
        "dew_point_c": dew,
        "precipitation_type": precip,
        "temperature_change_1h": trend,
    }
    s = factor_scores(row, CFG)
    total = icing_score(s, CFG["weights"])
    return s, total, risk_level(total, CFG["levels"]), drivers(s, CFG["weights"], CFG["drivers_top"])


def test_config_is_v0_and_weights_sum_to_one():
    assert CFG["version"] == "v0"
    assert sum(CFG["weights"].values()) == pytest.approx(1.0)


@pytest.mark.parametrize(
    "x, expected",
    [(None, 0.0), (-5.0, 1.0), (-2.0, 1.0), (-1.0, 0.75), (0.0, 0.5), (1.5, 0.25), (3.0, 0.0), (9.0, 0.0)],
)
def test_interp_surface(x, expected):
    assert interp(x, CFG["breakpoints"]["surface_temp"]) == pytest.approx(expected)


def test_case_a_cold_clear_night():  # 06_M5 T5.3 worked example A
    s, total, level, top = score(-4.0, -3.0, -3.4, "NONE", -0.5)
    assert [s[f] for f in s] == pytest.approx([1.0, 1.0, 1.0, 0.0, 0.25])
    assert total == pytest.approx(0.6875)
    assert level == "HIGH"
    assert top == [("surface_temp", 0.35), ("air_temp", 0.15), ("dew_point_spread", 0.15)]


def test_case_b_mild_rain():  # example B
    _, total, level, top = score(4.0, 5.0, 3.0, "RAIN", 0.5)
    assert total == pytest.approx(0.16)
    assert level == "LOW"
    assert [f for f, _ in top] == ["precipitation", "dew_point_spread", "air_temp"]


def test_case_c_snow_near_zero_falling():  # example C
    s, total, level, top = score(-1.0, 0.5, -0.5, "SNOW", -1.5)
    assert [s[f] for f in s] == pytest.approx([0.75, 0.4375, 0.8, 0.9, 0.625])
    assert total == pytest.approx(0.721875)
    assert level == "HIGH"
    assert [f for f, _ in top] == ["surface_temp", "precipitation", "dew_point_spread"]


def test_missing_inputs_score_zero_and_unknown_precip_scores_point_two():
    s, total, level, _ = score(None, None, None, "UNKNOWN", None)
    assert s["precipitation"] == pytest.approx(0.2)
    assert total == pytest.approx(0.04)
    assert level == "LOW"


@pytest.mark.parametrize(
    "source, intensity, air, expected",
    [
        ("SNOW", 0.0, 5.0, "SNOW"),  # a known source type wins
        ("UNKNOWN", None, 0.0, "UNKNOWN"),
        ("UNKNOWN", 0.0, -3.0, "NONE"),
        ("UNKNOWN", 0.4, 0.5, "SNOW"),
        ("UNKNOWN", 0.4, 1.0, "SLEET"),
        ("UNKNOWN", 0.4, 1.5, "SLEET"),
        ("UNKNOWN", 2.7, 4.0, "RAIN"),
        (None, 1.0, None, "UNKNOWN"),
    ],
)
def test_infer_precipitation_type(source, intensity, air, expected):
    assert infer_precipitation_type(source, intensity, air, CFG) == expected


def test_spark_twin_matches_python(spark):
    from pyspark.sql import functions as F

    from frostsight.risk import infer_precipitation_expr, with_risk

    rows = [
        (-4.0, -3.0, -3.4, "NONE", -0.5, 0.0),
        (4.0, 5.0, 3.0, "RAIN", 0.5, 1.0),
        (-1.0, 0.5, -0.5, "UNKNOWN", -1.5, 0.8),
        (None, None, None, "UNKNOWN", None, None),
    ]
    cols = (
        "road_surface_temperature_c air_temperature_c dew_point_c src temperature_change_1h intensity".split()
    )
    df = spark.createDataFrame(rows, cols).withColumn(
        "precipitation_type",
        infer_precipitation_expr(F.col("src"), F.col("intensity"), F.col("air_temperature_c"), CFG),
    )
    for r in with_risk(df, CFG).collect():
        precip = infer_precipitation_type(r.src, r.intensity, r.air_temperature_c, CFG)
        assert r.precipitation_type == precip
        _, total, level, top = score(
            r.road_surface_temperature_c, r.air_temperature_c, r.dew_point_c, precip, r.temperature_change_1h
        )
        assert r.icing_score == pytest.approx(total)
        assert r.risk_level == level
        assert [(d.factor, d.contribution) for d in r.risk_drivers] == [(f, pytest.approx(c)) for f, c in top]
