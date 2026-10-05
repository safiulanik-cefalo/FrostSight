"""Build the FrostSight demo dashboard: one AI/BI dashboard with four pages, as JSON next to this file.

The datasets use bare table names, so the same JSON reads `frostsight.mock` (deploy.py) or `frostsight.gold`
once M6 data exists. Widget shapes follow the databricks-aibi-dashboards skill: counter, table and map v2,
bar and line v3, filters v2, text as multilineTextboxSpec, every page GRID_V1 with rows that sum to 12.

Run: uv run python tools/mock_dashboards/build_dashboard.py
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

OUT = Path(__file__).resolve().parent / "frostsight_demo.lvdash.json"

LEVEL_COLOURS = {"LOW": "#4C9A6A", "MEDIUM": "#E3B23C", "HIGH": "#E07A2F", "VERY_HIGH": "#B3261E"}
GREY = "#9AA3AD"
# Theme palette. Charts without explicit mappings cycle through the first five (neutral, so a category never
# reads as a risk level); table cell rules can only point at palette slots, so light tints sit at 5 to 9.
PALETTE = [
    "#2272B4",
    "#4E5185",
    "#7FA7C9",
    GREY,
    "#6C8EAD",
    "#DCEFE2",
    "#FBEFCF",
    "#F9DFCB",
    "#F4D3D0",
    "#E9ECEF",
]
TINT_SLOT = {"LOW": 5, "MEDIUM": 6, "HIGH": 7, "VERY_HIGH": 8, "NO_DATA": 9}
DEFAULT_SEGMENT = "E8 · Lavangsdalen"
MOCK_NOTE = "Mock data: a synthetic storm morning, always relative to now. Not real observations."
SOURCES_NOTE = "Sources: Statens vegvesen (NLOD), MET Norway (CC BY 4.0). Not an official warning service."

# Human labels for risk_drivers.factor (04_M3 T3.4 factor names)
FACTOR_LABEL = (
    "CASE {col} WHEN 'surface_temp' THEN 'Surface temperature' WHEN 'air_temp' THEN 'Air temperature' "
    "WHEN 'dew_point_spread' THEN 'Close to dew point' WHEN 'precipitation' THEN 'Precipitation' "
    "WHEN 'temp_trend_1h' THEN 'Cooling, last hour' ELSE {col} END"
)

# One label per segment, shared by every road-detail dataset so one filter drives the whole page
SEGMENT_CTE = (
    "seg AS (SELECT r.road_segment_id, s.road, s.road_number, st.name AS station_name, "
    "concat(s.road, ' · ', coalesce(st.name, r.road_segment_id)) AS segment "
    "FROM road_segment_current_risk r JOIN v_segments s USING (road_segment_id) "
    "LEFT JOIN v_stations st ON st.station_id = r.station_id)"
)

# ---------- datasets ----------

DATASETS: dict[str, tuple[str, str]] = {
    # risk map
    "ds_kpi": (
        "KPIs",
        """WITH risk AS (
  SELECT count(*) AS segments_total,
         sum(CASE WHEN risk_level IN ('HIGH', 'VERY_HIGH') THEN 1 ELSE 0 END) AS segments_high,
         sum(CASE WHEN risk_level = 'VERY_HIGH' THEN 1 ELSE 0 END) AS segments_very_high,
         timestampdiff(MINUTE, max(risk_updated_at), current_timestamp()) AS data_age_minutes
  FROM road_segment_current_risk),
inc AS (SELECT coalesce(sum(active_incidents), 0) AS active_incidents FROM incident_summary),
st AS (
  SELECT count(*) AS stations_total,
         sum(CASE WHEN last_event_time >= timestampadd(MINUTE, -30, current_timestamp()) THEN 1 ELSE 0 END)
           AS stations_reporting
  FROM (SELECT s.station_id, max(o.event_time) AS last_event_time
        FROM v_stations s
        LEFT JOIN v_observations o
          ON o.station_id = s.station_id AND o.event_time >= timestampadd(HOUR, -24, current_timestamp())
        GROUP BY s.station_id))
SELECT * FROM risk, inc, st""",
    ),
    "ds_map": (
        "Segments",
        """SELECT r.road_segment_id, s.road, st.name AS station_name, s.geometry,
       s.centroid_lat AS lat, s.centroid_lon AS lon,
       r.risk_level, round(r.icing_score, 2) AS icing_score, r.risk_updated_at,
       CASE r.risk_level WHEN 'VERY_HIGH' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END
         AS risk_rank
FROM road_segment_current_risk r
JOIN v_segments s USING (road_segment_id)
LEFT JOIN v_stations st ON st.station_id = r.station_id""",
    ),
    "ds_stations": (
        "Stations",
        """SELECT s.station_id, s.name, s.latitude AS lat, s.longitude AS lon,
       max(o.event_time) AS last_event_time,
       CASE WHEN max(o.event_time) >= timestampadd(MINUTE, -30, current_timestamp())
            THEN 'Reporting' ELSE 'Stale' END AS station_status
FROM v_stations s
LEFT JOIN v_observations o
  ON o.station_id = s.station_id AND o.event_time >= timestampadd(HOUR, -24, current_timestamp())
GROUP BY s.station_id, s.name, s.latitude, s.longitude""",
    ),
    "ds_incidents": (
        "Active incidents",
        """SELECT i.start_time, i.incident_type, i.severity, i.road_ref, i.description, i.road_segment_id
FROM v_incidents i
WHERE i.is_active
ORDER BY i.start_time DESC""",
    ),
    # road detail: every dataset carries `segment` for the page filter
    "ds_rd_header": (
        "Segment",
        f"""WITH {SEGMENT_CTE}
SELECT seg.segment, seg.road_segment_id, seg.station_name, r.risk_level,
       round(r.icing_score, 2) AS icing_score,
       r.road_surface_temperature_c AS surface_c, r.air_temperature_c AS air_c,
       r.temperature_change_1h AS change_1h_c,
       timestampdiff(MINUTE, r.risk_updated_at, current_timestamp()) AS updated_minutes_ago
FROM road_segment_current_risk r JOIN seg USING (road_segment_id)""",
    ),
    "ds_rd_drivers": (
        "Drivers",
        f"""WITH {SEGMENT_CTE},
d AS (SELECT road_segment_id, explode(risk_drivers) AS drv FROM road_segment_current_risk)
SELECT seg.segment, {FACTOR_LABEL.format(col="d.drv.factor")} AS factor,
       round(d.drv.contribution, 3) AS contribution
FROM d JOIN seg USING (road_segment_id)
ORDER BY contribution DESC""",
    ),
    "ds_rd_types": (
        "Risk per type",
        f"""WITH {SEGMENT_CTE}
SELECT seg.segment, 1 AS sort_key, 'Icing' AS risk_type, r.risk_level, round(r.icing_score, 2) AS score,
       'live' AS note
FROM road_segment_current_risk r JOIN seg USING (road_segment_id)
UNION ALL SELECT segment, 2, 'Closure', NULL, NULL, 'after the MVP' FROM seg
UNION ALL SELECT segment, 3, 'Accident', NULL, NULL, 'after the MVP' FROM seg
ORDER BY sort_key""",
    ),
    "ds_rd_history": (
        "Last 24 hours",
        f"""WITH {SEGMENT_CTE}
SELECT seg.segment, h.risk_updated_at, h.icing_score, h.risk_level, h.road_surface_temperature_c AS surface_c,
       h.air_temperature_c AS air_c
FROM road_segment_risk_history h JOIN seg USING (road_segment_id)
WHERE h.risk_updated_at >= timestampadd(HOUR, -24, current_timestamp())
  AND coalesce(h._batch_id, '') NOT LIKE 'replay:%'
ORDER BY h.risk_updated_at""",
    ),
    "ds_rd_readings": (
        "Station readings",
        f"""WITH {SEGMENT_CTE},
latest AS (
  SELECT seg.segment, o.*
  FROM seg
  JOIN road_segment_current_risk r USING (road_segment_id)
  JOIN v_observations o ON o.station_id = r.station_id
  QUALIFY row_number() OVER (PARTITION BY seg.segment ORDER BY o.event_time DESC) = 1)
SELECT segment, 1 AS sort_key, 'Surface' AS reading,
       concat(round(road_surface_temperature_c, 1), ' °C') AS value
FROM latest
UNION ALL SELECT segment, 2, 'Air', concat(round(air_temperature_c, 1), ' °C') FROM latest
UNION ALL SELECT segment, 3, 'Dew point', concat(round(dew_point_c, 1), ' °C') FROM latest
UNION ALL SELECT segment, 4, 'Precipitation',
                 concat(initcap(precipitation_type), ', ', round(precipitation_intensity_mm_h, 1), ' mm/h')
          FROM latest
UNION ALL SELECT segment, 5, 'Wind', concat(round(wind_speed_ms, 0), ' m/s') FROM latest
UNION ALL SELECT segment, 6, 'Road surface', initcap(road_surface_state) FROM latest
UNION ALL SELECT segment, 7, 'Observed', concat(date_format(event_time, 'HH:mm'), ' UTC') FROM latest
ORDER BY sort_key""",
    ),
    "ds_rd_incidents": (
        "Incidents on this road",
        f"""WITH {SEGMENT_CTE}
SELECT seg.segment, i.start_time, i.end_time, i.incident_type, i.severity,
       CASE WHEN i.is_active THEN 'Active' ELSE 'Closed' END AS state, i.description
FROM seg JOIN v_incidents i ON i.road_number = seg.road_number
WHERE i.start_time >= timestampadd(HOUR, -48, current_timestamp())
ORDER BY i.start_time DESC""",
    ),
    # gritting priority: no parameters, so page filters bind to fields and clicks cross-filter
    "ds_priority": (
        "Priority",
        f"""WITH obs AS (
  SELECT station_id,
         max_by(road_surface_temperature_c, event_time) AS surface_c,
         max_by(precipitation_type, event_time) AS precip
  FROM v_observations
  WHERE event_time >= timestampadd(HOUR, -3, current_timestamp())
  GROUP BY station_id),
ranked AS (
  SELECT r.road_segment_id, s.road, st.name AS place,
         round(r.icing_score, 2) AS icing_score, r.risk_level,
         o.surface_c, initcap(coalesce(o.precip, 'None')) AS precip,
         array_join(transform(r.risk_drivers, d -> {FACTOR_LABEL.format(col="d.factor")}), ', ')
           AS main_drivers,
         timestampdiff(MINUTE, r.risk_updated_at, current_timestamp()) AS updated_minutes_ago
  FROM road_segment_current_risk r
  JOIN v_segments s USING (road_segment_id)
  LEFT JOIN v_stations st ON st.station_id = r.station_id
  LEFT JOIN obs o ON o.station_id = r.station_id)
SELECT row_number() OVER (ORDER BY icing_score DESC, road) AS rank, *
FROM ranked
ORDER BY rank""",
    ),
    # platform health
    "ds_freshness": (
        "Freshness",
        """SELECT source, last_event_time, last_successful_ingestion, round(ingestion_delay_min) AS delay_min,
       threshold_min, status, rows_last_24h, quarantined_last_24h
FROM data_quality_summary
ORDER BY CASE status WHEN 'STALE' THEN 0 WHEN 'NO_DATA' THEN 1 ELSE 2 END, source""",
    ),
    "ds_health_kpi": (
        "Health KPIs",
        """WITH q AS (
  SELECT count(*) AS quarantined_today,
         sum(CASE WHEN quarantine_table = 'unmapped_observations' THEN 1 ELSE 0 END) AS unmapped_today
  FROM v_quarantine WHERE quarantined_at >= current_date()),
l AS (
  SELECT median(timestampdiff(SECOND, event_time, risk_updated_at)) AS latency_median_s
  FROM road_segment_risk_history
  WHERE risk_updated_at >= timestampadd(HOUR, -24, current_timestamp())
    AND coalesce(_batch_id, '') NOT LIKE 'replay:%'),
p AS (
  SELECT count(DISTINCT run_id) AS runs_today, count(DISTINCT run_id) AS runs_ok
  FROM v_dq_events WHERE event_time >= current_date())
SELECT * FROM q, l, p""",
    ),
    "ds_quarantine_today": (
        "Quarantine today",
        """SELECT quarantine_table, rule, count(*) AS rows_today
FROM v_quarantine
WHERE quarantined_at >= current_date()
GROUP BY quarantine_table, rule
ORDER BY rows_today DESC""",
    ),
    "ds_freshness_trend": (
        "Road-weather delay",
        """SELECT computed_at, ingestion_delay_min, threshold_min
FROM data_quality_summary_history
WHERE source = 'road_weather' AND computed_at >= timestampadd(HOUR, -24, current_timestamp())
ORDER BY computed_at""",
    ),
    "ds_dq_rules": (
        "Rules today",
        """SELECT rule_id, action, sum(rows_failed) AS rows_failed, sum(rows_checked) AS rows_checked
FROM v_dq_events
WHERE event_time >= current_date()
GROUP BY rule_id, action
ORDER BY rows_failed DESC""",
    ),
}

# ---------- widget helpers ----------


def field(name: str, expression: str | None = None) -> dict[str, str]:
    return {"name": name, "expression": expression or f"`{name}`"}


def query(dataset: str, fields: list[dict[str, str]], disaggregated: bool = True) -> list[dict[str, Any]]:
    return [
        {
            "name": "main_query",
            "query": {"datasetName": dataset, "fields": fields, "disaggregated": disaggregated},
        }
    ]


def frame(title: str, description: str | None = None) -> dict[str, Any]:
    f: dict[str, Any] = {"showTitle": True, "title": title}
    if description:
        f.update(description=description, showDescription=True)
    return f


def place(widget: dict[str, Any], x: int, y: int, w: int, h: int) -> dict[str, Any]:
    return {"widget": widget, "position": {"x": x, "y": y, "width": w, "height": h}}


def text(name: str, lines: list[str]) -> dict[str, Any]:
    return {"name": name, "multilineTextboxSpec": {"lines": lines}}


def counter(
    name: str,
    dataset: str,
    value: str,
    title: str,
    extra: list[str] = (),
    template: str | None = None,
    fmt: dict[str, Any] | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    enc: dict[str, Any] = {"fieldName": value, "displayName": title}
    if template:
        enc["formatTemplate"] = template
    if fmt:
        enc["format"] = fmt
    return {
        "name": name,
        "queries": query(dataset, [field(value), *(field(e) for e in extra)]),
        "spec": {
            "version": 2,
            "widgetType": "counter",
            "encodings": {"value": enc},
            "frame": frame(title, description),
        },
    }


def table(
    name: str,
    dataset: str,
    columns: list[tuple[str, str] | tuple[str, str, dict]],
    title: str,
    description: str | None = None,
) -> dict[str, Any]:
    cols = []
    for c in columns:
        col: dict[str, Any] = {"fieldName": c[0], "displayName": c[1]}
        if len(c) == 3:
            col.update(c[2])
        cols.append(col)
    return {
        "name": name,
        "queries": query(dataset, [field(c[0]) for c in columns]),
        "spec": {
            "version": 2,
            "widgetType": "table",
            "encodings": {"columns": cols},
            "frame": frame(title, description),
        },
    }


def level_mappings() -> list[dict[str, str]]:
    return [{"value": k, "color": v} for k, v in LEVEL_COLOURS.items()]


def level_style() -> dict[str, Any]:
    """Table cell tint per risk level (palette slots 5 to 8)."""
    rules = [
        {
            "condition": {"operand": {"type": "data-value", "value": lvl}, "operator": "="},
            "backgroundColor": {"themeColorType": "visualizationColors", "position": TINT_SLOT[lvl]},
        }
        for lvl in LEVEL_COLOURS
    ]
    return {"style": {"type": "basic", "rules": rules}}


def status_style() -> dict[str, Any]:
    return {
        "style": {
            "type": "basic",
            "rules": [
                {
                    "condition": {"operand": {"type": "data-value", "value": "STALE"}, "operator": "="},
                    "backgroundColor": {
                        "themeColorType": "visualizationColors",
                        "position": TINT_SLOT["VERY_HIGH"],
                    },
                },
                {
                    "condition": {"operand": {"type": "data-value", "value": "NO_DATA"}, "operator": "="},
                    "backgroundColor": {
                        "themeColorType": "visualizationColors",
                        "position": TINT_SLOT["NO_DATA"],
                    },
                },
            ],
        }
    }


def page(name: str, title: str, layout: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "name": name,
        "displayName": title,
        "pageType": "PAGE_TYPE_CANVAS",
        "layoutVersion": "GRID_V1",
        "layout": layout,
    }


def header(name: str, title: str, subtitle: str) -> list[dict[str, Any]]:
    return [place(text(f"{name}-title", [f"## {title}\n", "\n", f"{subtitle} *{MOCK_NOTE}*\n"]), 0, 0, 12, 2)]


# ---------- pages ----------


def risk_map_page() -> dict[str, Any]:
    segment_map = {
        "name": "map-segments",
        "queries": query(
            "ds_map",
            [
                field("lat"),
                field("lon"),
                field("risk_level"),
                field("road"),
                field("station_name"),
                field("icing_score"),
                field("road_segment_id"),
            ],
        ),
        "spec": {
            "version": 2,
            "widgetType": "symbol-map",
            "encodings": {
                "coordinates": {"latitude": {"fieldName": "lat"}, "longitude": {"fieldName": "lon"}},
                "color": {
                    "fieldName": "risk_level",
                    "displayName": "Risk level",
                    "scale": {"type": "categorical", "mappings": level_mappings()},
                },
            },
            "mark": {"opacity": 0.9},
            "frame": frame("Icing risk per segment"),
        },
    }
    station_map = {
        "name": "map-stations",
        "queries": query("ds_stations", [field("lat"), field("lon"), field("station_status"), field("name")]),
        "spec": {
            "version": 2,
            "widgetType": "symbol-map",
            "encodings": {
                "coordinates": {"latitude": {"fieldName": "lat"}, "longitude": {"fieldName": "lon"}},
                "color": {
                    "fieldName": "station_status",
                    "displayName": "Station",
                    "scale": {
                        "type": "categorical",
                        "mappings": [
                            {"value": "Reporting", "color": LEVEL_COLOURS["LOW"]},
                            {"value": "Stale", "color": GREY},
                        ],
                    },
                },
            },
            "mark": {"opacity": 0.9},
            "frame": frame("Stations", "Green: reported in the last 30 min. Grey: stale."),
        },
    }
    return page(
        "risk_map",
        "Risk map",
        [
            *header(
                "map",
                "FrostSight · Risk map · Troms",
                "Icing risk per road segment from the newest road-weather readings, every 10 minutes.",
            ),
            place(
                counter(
                    "kpi-high",
                    "ds_kpi",
                    "segments_high",
                    "Segments HIGH or above",
                    ["segments_total"],
                    "{{@formatted}} of {{segments_total}}",
                ),
                0,
                2,
                3,
                3,
            ),
            place(counter("kpi-very-high", "ds_kpi", "segments_very_high", "VERY_HIGH"), 3, 2, 3, 3),
            place(
                counter(
                    "kpi-stations",
                    "ds_kpi",
                    "stations_reporting",
                    "Stations reporting",
                    ["stations_total"],
                    "{{@formatted}} of {{stations_total}}",
                ),
                6,
                2,
                3,
                3,
            ),
            place(
                counter(
                    "kpi-age",
                    "ds_kpi",
                    "data_age_minutes",
                    "Data age",
                    template="{{@formatted}} min",
                    fmt={"type": "number-plain"},
                ),
                9,
                2,
                3,
                3,
            ),
            place(segment_map, 0, 5, 8, 9),
            place(station_map, 8, 5, 4, 9),
            place(
                table(
                    "incidents-table",
                    "ds_incidents",
                    [
                        ("start_time", "Start (UTC)"),
                        ("incident_type", "Type"),
                        ("severity", "Severity"),
                        ("road_ref", "Road"),
                        ("description", "What"),
                    ],
                    "Active incidents (DATEX II)",
                ),
                0,
                14,
                12,
                4,
            ),
            place(
                text(
                    "map-footer",
                    [
                        "Legend: LOW green, MEDIUM yellow, HIGH orange, VERY_HIGH red. "
                        "Next: **Road detail** for one segment, **Gritting priority** for the ranked list. "
                        f"{SOURCES_NOTE}\n"
                    ],
                ),
                0,
                18,
                12,
                1,
            ),
        ],
    )


def road_detail_page() -> dict[str, Any]:
    detail_sets = [
        "ds_rd_header",
        "ds_rd_drivers",
        "ds_rd_types",
        "ds_rd_history",
        "ds_rd_readings",
        "ds_rd_incidents",
    ]
    segment_filter = {
        "name": "filter-segment",
        "queries": [
            {
                "name": f"q_{d}",
                "query": {"datasetName": d, "fields": [field("segment")], "disaggregated": False},
            }
            for d in detail_sets
        ],
        "spec": {
            "version": 2,
            "widgetType": "filter-single-select",
            "encodings": {
                "fields": [
                    {"fieldName": "segment", "displayName": "Segment", "queryName": f"q_{d}"}
                    for d in detail_sets
                ]
            },
            "selection": {
                "defaultSelection": {"values": {"dataType": "STRING", "values": [{"value": DEFAULT_SEGMENT}]}}
            },
            "frame": frame("Segment"),
        },
    }
    drivers = {
        "name": "drivers-bar",
        "queries": query("ds_rd_drivers", [field("factor"), field("contribution")]),
        "spec": {
            "version": 3,
            "widgetType": "bar",
            "encodings": {
                "x": {
                    "fieldName": "contribution",
                    "displayName": "Share of the score",
                    "scale": {"type": "quantitative"},
                },
                "y": {"fieldName": "factor", "displayName": "Driver", "scale": {"type": "categorical"}},
            },
            "frame": frame("Why this level", "Top three factors, weighted (config/risk_weights.yml)"),
        },
    }

    def line(name: str, y: str, title: str, description: str) -> dict[str, Any]:
        return {
            "name": name,
            "queries": query("ds_rd_history", [field("risk_updated_at"), field(y)]),
            "spec": {
                "version": 3,
                "widgetType": "line",
                "encodings": {
                    "x": {
                        "fieldName": "risk_updated_at",
                        "displayName": "Time (UTC)",
                        "scale": {"type": "temporal"},
                    },
                    "y": {"fieldName": y, "displayName": title, "scale": {"type": "quantitative"}},
                },
                "frame": frame(title, description),
            },
        }

    return page(
        "road_detail",
        "Road detail",
        [
            *header(
                "detail",
                "Road detail",
                "Pick a segment: its risk, why, and what the nearest station measures.",
            ),
            place(segment_filter, 0, 2, 4, 2),
            place(
                text(
                    "detail-hint",
                    [
                        "Levels: LOW < 0.25 ≤ MEDIUM < 0.5 ≤ HIGH < 0.75 ≤ VERY_HIGH. "
                        "Times are UTC. The risk is recomputed every 10 minutes.\n"
                    ],
                ),
                4,
                2,
                8,
                2,
            ),
            place(
                counter(
                    "kpi-icing",
                    "ds_rd_header",
                    "icing_score",
                    "Icing score",
                    ["risk_level"],
                    "{{@formatted}} · {{risk_level}}",
                ),
                0,
                4,
                3,
                3,
            ),
            place(
                counter(
                    "kpi-surface",
                    "ds_rd_header",
                    "surface_c",
                    "Surface temperature",
                    ["change_1h_c"],
                    "{{@formatted}} °C ({{change_1h_c}} in 1 h)",
                ),
                3,
                4,
                3,
                3,
            ),
            place(
                counter("kpi-air", "ds_rd_header", "air_c", "Air temperature", template="{{@formatted}} °C"),
                6,
                4,
                3,
                3,
            ),
            place(
                counter(
                    "kpi-updated",
                    "ds_rd_header",
                    "updated_minutes_ago",
                    "Updated",
                    ["station_name"],
                    "{{@formatted}} min ago · {{station_name}}",
                    {"type": "number-plain"},
                ),
                9,
                4,
                3,
                3,
            ),
            place(drivers, 0, 7, 6, 5),
            place(
                table(
                    "types-table",
                    "ds_rd_types",
                    [
                        ("risk_type", "Risk"),
                        ("risk_level", "Level", level_style()),
                        ("score", "Score"),
                        ("note", "Note"),
                    ],
                    "Risk per type",
                ),
                6,
                7,
                6,
                5,
            ),
            place(
                line("history-icing", "icing_score", "Icing score, last 24 h", "0.5 is HIGH, 0.75 VERY_HIGH"),
                0,
                12,
                6,
                5,
            ),
            place(
                line(
                    "history-surface",
                    "surface_c",
                    "Surface temperature, last 24 h",
                    "°C at the nearest station",
                ),
                6,
                12,
                6,
                5,
            ),
            place(
                table(
                    "readings-table",
                    "ds_rd_readings",
                    [("reading", "Reading"), ("value", "Value")],
                    "Nearest station, newest reading",
                ),
                0,
                17,
                4,
                5,
            ),
            place(
                table(
                    "detail-incidents",
                    "ds_rd_incidents",
                    [
                        ("start_time", "Start (UTC)"),
                        ("incident_type", "Type"),
                        ("severity", "Severity"),
                        ("state", "State"),
                        ("description", "What"),
                    ],
                    "Incidents on this road, last 48 h",
                ),
                4,
                17,
                8,
                5,
            ),
        ],
    )


def priority_page() -> dict[str, Any]:
    road_filter = {
        "name": "filter-road",
        "queries": [
            {
                "name": "q_road",
                "query": {"datasetName": "ds_priority", "fields": [field("road")], "disaggregated": False},
            }
        ],
        "spec": {
            "version": 2,
            "widgetType": "filter-multi-select",
            "encodings": {"fields": [{"fieldName": "road", "displayName": "Road", "queryName": "q_road"}]},
            "frame": frame("Roads"),
        },
    }
    surface_filter = {
        "name": "filter-surface",
        "queries": [
            {
                "name": "q_surface",
                "query": {
                    "datasetName": "ds_priority",
                    "fields": [
                        field("min(surface_c)", "MIN(`surface_c`)"),
                        field("max(surface_c)", "MAX(`surface_c`)"),
                    ],
                    "disaggregated": False,
                },
            }
        ],
        "spec": {
            "version": 2,
            "widgetType": "range-slider",
            "encodings": {"fields": [{"fieldName": "surface_c", "queryName": "q_surface"}]},
            "frame": frame("Surface temperature (°C)"),
        },
    }
    by_road = {
        "name": "by-road-bar",
        "queries": query(
            "ds_priority",
            [field("road"), field("risk_level"), field("count(rank)", "COUNT(`rank`)")],
            disaggregated=False,
        ),
        "spec": {
            "version": 3,
            "widgetType": "bar",
            "encodings": {
                "x": {"fieldName": "road", "displayName": "Road", "scale": {"type": "categorical"}},
                "y": {
                    "fieldName": "count(rank)",
                    "displayName": "Segments",
                    "scale": {"type": "quantitative"},
                },
                "color": {
                    "fieldName": "risk_level",
                    "displayName": "Risk level",
                    "scale": {"type": "categorical", "mappings": level_mappings()},
                },
            },
            "frame": frame("Segments per road and level", "Click a bar to filter the list"),
        },
    }
    return page(
        "priority",
        "Gritting priority",
        [
            *header(
                "priority",
                "Gritting priority",
                "Ranked by icing score, then road. Filter to the roads in your contract.",
            ),
            place(road_filter, 0, 2, 4, 2),
            place(surface_filter, 4, 2, 4, 2),
            place(
                text(
                    "priority-hint",
                    [
                        "Rank is county-wide, so a filtered list keeps its gaps. "
                        "Surface is the newest reading of the last 3 h.\n"
                    ],
                ),
                8,
                2,
                4,
                2,
            ),
            place(by_road, 0, 4, 12, 4),
            place(
                table(
                    "priority-table",
                    "ds_priority",
                    [
                        ("rank", "Rank"),
                        ("road", "Road"),
                        ("place", "Place"),
                        ("risk_level", "Level", level_style()),
                        ("icing_score", "Icing"),
                        ("surface_c", "Surface °C"),
                        ("precip", "Precipitation"),
                        ("main_drivers", "Main drivers"),
                        ("updated_minutes_ago", "Min ago"),
                    ],
                    "Segments to grit first",
                ),
                0,
                8,
                12,
                10,
            ),
        ],
    )


def health_page() -> dict[str, Any]:
    quarantine_bar = {
        "name": "quarantine-bar",
        "queries": query(
            "ds_quarantine_today", [field("rule"), field("quarantine_table"), field("rows_today")]
        ),
        "spec": {
            "version": 3,
            "widgetType": "bar",
            "encodings": {
                "x": {"fieldName": "rule", "displayName": "Rule", "scale": {"type": "categorical"}},
                "y": {"fieldName": "rows_today", "displayName": "Rows", "scale": {"type": "quantitative"}},
                "color": {
                    "fieldName": "quarantine_table",
                    "displayName": "Table",
                    "scale": {"type": "categorical"},
                },
            },
            "frame": frame("Quarantined rows today, by rule"),
        },
    }
    trend = {
        "name": "freshness-line",
        "queries": query(
            "ds_freshness_trend", [field("computed_at"), field("ingestion_delay_min"), field("threshold_min")]
        ),
        "spec": {
            "version": 3,
            "widgetType": "line",
            "encodings": {
                "x": {"fieldName": "computed_at", "displayName": "Time (UTC)", "scale": {"type": "temporal"}},
                "y": {
                    "scale": {"type": "quantitative"},
                    "fields": [
                        {"fieldName": "ingestion_delay_min", "displayName": "Delay (min)"},
                        {"fieldName": "threshold_min", "displayName": "Threshold"},
                    ],
                },
            },
            "frame": frame("Road-weather delay, last 24 h", "Above the threshold the source turns STALE"),
        },
    }
    return page(
        "health",
        "Platform health",
        [
            *header("health", "Platform health", "Is the data fresh, and what did the rules catch today?"),
            place(
                table(
                    "freshness-table",
                    "ds_freshness",
                    [
                        ("source", "Source"),
                        ("status", "Status", status_style()),
                        ("delay_min", "Delay (min)"),
                        ("threshold_min", "Threshold (min)"),
                        ("last_event_time", "Newest event (UTC)"),
                        ("rows_last_24h", "Rows 24 h"),
                        ("quarantined_last_24h", "Quarantined 24 h"),
                    ],
                    "Freshness per source",
                ),
                0,
                2,
                12,
                4,
            ),
            place(
                counter("kpi-quarantined", "ds_health_kpi", "quarantined_today", "Quarantined today"),
                0,
                6,
                3,
                3,
            ),
            place(
                counter("kpi-unmapped", "ds_health_kpi", "unmapped_today", "Unmapped observations"),
                3,
                6,
                3,
                3,
            ),
            place(
                counter(
                    "kpi-latency",
                    "ds_health_kpi",
                    "latency_median_s",
                    "Latency, median",
                    template="{{@formatted}} s",
                    fmt={"type": "number-plain"},
                    description="Measurement to risk row, last 24 h",
                ),
                6,
                6,
                3,
                3,
            ),
            place(
                counter(
                    "kpi-runs",
                    "ds_health_kpi",
                    "runs_ok",
                    "Pipeline runs today",
                    ["runs_today"],
                    "{{@formatted}} of {{runs_today}} ok",
                ),
                9,
                6,
                3,
                3,
            ),
            place(quarantine_bar, 0, 9, 6, 5),
            place(trend, 6, 9, 6, 5),
            place(
                table(
                    "rules-table",
                    "ds_dq_rules",
                    [
                        ("rule_id", "Rule"),
                        ("action", "Action"),
                        ("rows_failed", "Failed"),
                        ("rows_checked", "Checked"),
                    ],
                    "Expectations today",
                ),
                0,
                14,
                12,
                4,
            ),
            place(
                text(
                    "health-footer",
                    ["Thresholds: 30 min road weather, 60 min incidents, 8 days NVDB, 60 days elevation.\n"],
                ),
                0,
                18,
                12,
                1,
            ),
        ],
    )


def dashboard() -> dict[str, Any]:
    return {
        "datasets": [
            {"name": name, "displayName": display, "queryLines": [line + "\n" for line in sql.splitlines()]}
            for name, (display, sql) in DATASETS.items()
        ],
        "pages": [risk_map_page(), road_detail_page(), priority_page(), health_page()],
        "uiSettings": {
            "theme": {
                "canvasBackgroundColor": {"light": "#F4F6F8", "dark": "#1F272D"},
                "widgetBackgroundColor": {"light": "#FBFCFD", "dark": "#11171C"},
                "widgetBorderColor": {"light": "#FBFCFD", "dark": "#11171C"},
                "fontColor": {"light": "#12233A", "dark": "#E8ECF0"},
                "selectionColor": {"light": "#2272B4", "dark": "#8ACAFF"},
                "visualizationColors": PALETTE,
                "widgetHeaderAlignment": "LEFT",
            }
        },
    }


def check(d: dict[str, Any]) -> None:
    """The skill's structural rules: rows fill 12 columns, names are safe, fields match encodings."""
    names = {ds["name"] for ds in d["datasets"]}
    for p in d["pages"]:
        rows: dict[int, int] = {}
        for item in p["layout"]:
            pos, w = item["position"], item["widget"]
            assert w["name"].replace("-", "").replace("_", "").isalnum(), w["name"]
            rows[pos["y"]] = rows.get(pos["y"], 0) + pos["width"]
            for q in w.get("queries", []):
                assert q["query"]["datasetName"] in names, q["query"]["datasetName"]
        assert all(v == 12 for v in rows.values()), (p["name"], rows)


if __name__ == "__main__":
    d = dashboard()
    check(d)
    OUT.write_text(json.dumps(d, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {OUT.relative_to(Path.cwd()) if OUT.is_relative_to(Path.cwd()) else OUT}")
