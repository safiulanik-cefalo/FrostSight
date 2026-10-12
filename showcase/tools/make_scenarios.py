# ruff: noqa: E501  (scenario data tables read better one row per line)
# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy", "pillow"]
# ///
"""Write the showcase's scripted scenarios to public/scenarios/ from the NVDB seed stations.

Every station and segment a scenario touches is written in full at its first step, so a scenario plays over
any base state, from the two-station fixture to a real snapshot. Run from showcase/:
`uv run tools/make_scenarios.py`.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
_spec = importlib.util.spec_from_file_location("bake_sites", HERE.parent / "bake_sites.py")
bake = importlib.util.module_from_spec(_spec)
sys.modules["bake_sites"] = bake
_spec.loader.exec_module(bake)

OUT = HERE.parents[1] / "public" / "scenarios"
SIM = "2026-10-12T00:00:00Z"  # start time of simulated incidents; shown as a time of day only


def station(s, level, score, reporting=True):
    return {
        "station_id": s.station_id,
        "name": s.name,
        "road": bake.road_label(s.road_category, s.road_number),
        "lat": s.lat,
        "lon": s.lon,
        "road_segment_id": s.road_segment_id,
        "status": "Reporting" if reporting else "Stale",
        "last_event_time": None,
        "risk_level": level,
        "icing_score": score,
    }


def segment(s, level, score, surface, air, precip_type, mm_h, wind, dew, drivers, rank=None, change=None):
    road = bake.road_label(s.road_category, s.road_number)
    return {
        "road_segment_id": s.road_segment_id,
        "segment": f"{road} · {s.name}",
        "road": road,
        "station_id": s.station_id,
        "risk_level": level,
        "icing_score": score,
        "surface_c": surface,
        "air_c": air,
        "change_1h_c": change,
        "event_time": None,
        "priority_rank": rank,
        "drivers": [{"factor": f, "contribution": c} for f, c in drivers],
        "readings": {"dew_point_c": dew, "precip_type": precip_type, "precip_mm_h": mm_h, "wind_ms": wind},
    }


def update(s, **fields):
    """A partial segment patch, merged by road_segment_id."""
    readings = {
        k: fields.pop(k) for k in ("precip_mm_h", "precip_type", "dew_point_c", "wind_ms") if k in fields
    }
    out = {"road_segment_id": s.road_segment_id, **fields}
    if readings:
        out["readings"] = readings
    return out


def main() -> None:
    _, stations = bake.load_seed(bake.SEED.read_text())
    by_name = {s.name: s for s in stations}
    boss, garde, galgo = by_name["Bossovarri"], by_name["Gardeborri"], by_name["Galgo"]
    lav = by_name["Lavangsdalen"]
    e8 = [boss, garde, galgo]
    snow_drivers = [("Precipitation", 0.38), ("Surface temperature", 0.3), ("Close to dew point", 0.12)]

    storm = {
        "id": "snowstorm-e8",
        "title": "Snowstorm on E8",
        "blurb": "Heavy snow over Skibotndalen: three E8 stations climb to very high and Gardeborri closes.",
        "duration_s": 90,
        "focus_station_id": garde.station_id,
        "closures": [{"at_s": 60, "station_id": garde.station_id, "start_m": 5000, "end_m": 7000}],
        "outlook": [
            {"at_h": 3, "level": "HIGH", "score": 0.78},
            {"at_h": 6, "level": "VERY_HIGH", "score": 0.9},
            {"at_h": 12, "level": "MEDIUM", "score": 0.5},
        ],
        "history_rel": {
            s.road_segment_id: [
                {"ago_h": 6, "level": "LOW", "score": 0.2},
                {"ago_h": 3, "level": "MEDIUM", "score": 0.4},
                {"ago_h": 0, "level": "MEDIUM", "score": 0.45},
            ]
            for s in e8
        },
        "steps": [
            {
                "at_s": 0,
                "patch": {
                    "stations": [station(s, "MEDIUM", 0.45) for s in e8],
                    "segments": [
                        segment(
                            s, "MEDIUM", 0.45, -1.0, -2.0, "SNOW", 0.8, 8, -1.4, snow_drivers, change=-0.4
                        )
                        for s in e8
                    ],
                },
            },
            {
                "at_s": 30,
                "patch": {
                    "stations": [
                        {"station_id": s.station_id, "risk_level": "HIGH", "icing_score": 0.68} for s in e8
                    ],
                    "segments": [
                        update(
                            s,
                            risk_level="HIGH",
                            icing_score=0.68,
                            surface_c=-3.0,
                            precip_mm_h=2.4,
                            priority_rank=i + 1,
                        )
                        for i, s in enumerate([boss, garde, galgo])
                    ],
                },
            },
            {
                "at_s": 60,
                "patch": {
                    "stations": [
                        {"station_id": s.station_id, "risk_level": "VERY_HIGH", "icing_score": 0.86}
                        for s in e8
                    ],
                    "segments": [
                        update(s, risk_level="VERY_HIGH", icing_score=0.86, surface_c=-5.0, precip_mm_h=5.0)
                        for s in e8
                    ],
                    "incidents": [
                        {
                            "incident_id": "sim-gardeborri-closed",
                            "road": "E8",
                            "road_segment_id": garde.road_segment_id,
                            "incident_type": "roadClosed",
                            "severity": "high",
                            "start_time": SIM,
                            "end_time": None,
                            "description": "Simulated: E8 closed at Gardeborri, convoy driving",
                        }
                    ],
                },
            },
            {
                "at_s": 90,
                "patch": {
                    "stations": [{"station_id": s.station_id, "icing_score": 0.93} for s in e8],
                    "segments": [update(s, icing_score=0.93, precip_mm_h=6.5, wind_ms=14) for s in e8],
                },
            },
        ],
    }

    ice_drivers = [("Close to dew point", 0.5), ("Surface temperature", 0.32), ("Cooling, last hour", 0.12)]
    black_ice = {
        "id": "black-ice-lavangsdalen",
        "title": "Black ice in Lavangsdalen",
        "blurb": "A clear, still night: the road surface falls through 0 °C right at the dew point, with no snow.",
        "duration_s": 60,
        "focus_station_id": lav.station_id,
        "outlook": [
            {"at_h": 3, "level": "HIGH", "score": 0.74},
            {"at_h": 6, "level": "MEDIUM", "score": 0.5},
        ],
        "history_rel": {
            lav.road_segment_id: [
                {"ago_h": 6, "level": "LOW", "score": 0.15},
                {"ago_h": 3, "level": "LOW", "score": 0.25},
                {"ago_h": 0, "level": "MEDIUM", "score": 0.42},
            ]
        },
        "steps": [
            {
                "at_s": 0,
                "patch": {
                    "stations": [station(lav, "MEDIUM", 0.42)],
                    "segments": [
                        segment(lav, "MEDIUM", 0.42, 0.4, -1.5, "NONE", 0.0, 1, 0.2, ice_drivers, change=-0.6)
                    ],
                },
            },
            {
                "at_s": 20,
                "patch": {"segments": [update(lav, surface_c=-0.3, dew_point_c=-0.5, change_1h_c=-0.9)]},
            },
            {
                "at_s": 30,
                "patch": {
                    "stations": [{"station_id": lav.station_id, "risk_level": "HIGH", "icing_score": 0.71}],
                    "segments": [update(lav, risk_level="HIGH", icing_score=0.71, priority_rank=1)],
                },
            },
            {
                "at_s": 50,
                "patch": {"segments": [update(lav, surface_c=-1.2, dew_point_c=-1.4, icing_score=0.76)]},
            },
        ],
    }

    calm = [("Surface temperature", 0.06)]
    quiet = {
        "id": "quiet-morning",
        "title": "Quiet morning",
        "blurb": "Every station low, dry roads and light traffic. The baseline.",
        "duration_s": 30,
        "steps": [
            {
                "at_s": 0,
                "patch": {
                    "stations": [station(s, "LOW", 0.1) for s in stations],
                    "segments": [
                        segment(s, "LOW", 0.1, 2.5, 1.0, "NONE", 0.0, 3, -3.0, calm) for s in stations
                    ],
                },
            }
        ],
    }

    OUT.mkdir(parents=True, exist_ok=True)
    scenarios = [storm, black_ice, quiet]
    for sc in scenarios:
        (OUT / f"{sc['id']}.json").write_text(json.dumps(sc, ensure_ascii=False, indent=1) + "\n")
    index = [{"id": s["id"], "title": s["title"], "blurb": s["blurb"]} for s in scenarios]
    (OUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1) + "\n")
    print("wrote", ", ".join(s["id"] for s in scenarios))


if __name__ == "__main__":
    main()
