"""Plot-ready gold tables for the live dashboard (docs/gold-from-team-silver.md section 4a).

One table per widget group, rebuilt by build_gold after every fetch, so each dashboard dataset is a select on
one table. Joins, coverage, ranking, labels and "Pending Live Data" are decided here, once per fetch.
Only values relative to the viewer's clock stay in the dashboard queries: minutes ago, data age, whether an
incident is still active, freshness delay.

serving_tables() returns (name, SELECT) pairs in build order: a table may read the ones before it.
"""

from __future__ import annotations

PENDING = "Pending Live Data"
NOT_REPORTED = "not reported"

# Tables show state as a coloured symbol plus the word, not a cell background (dark mode); shared with the
# mock dashboard (tools/mock_dashboards/build_dashboard.py) so both read the same
LEVEL_BADGE = (
    "CASE {col} WHEN 'VERY_HIGH' THEN '🔴 VERY_HIGH' WHEN 'HIGH' THEN '🟠 HIGH' "
    "WHEN 'MEDIUM' THEN '🟡 MEDIUM' WHEN 'LOW' THEN '🟢 LOW' END"
)
# Human labels for risk_drivers.factor (04_M3 T3.4 factor names)
FACTOR_LABEL = (
    "CASE {col} WHEN 'surface_temp' THEN 'Surface temperature' WHEN 'air_temp' THEN 'Air temperature' "
    "WHEN 'dew_point_spread' THEN 'Close to dew point' WHEN 'precipitation' THEN 'Precipitation' "
    "WHEN 'temp_trend_1h' THEN 'Cooling, last hour' ELSE {col} END"
)
# NVDB category plus number as people write it: E8, Rv83, Fv91
ROAD_LABEL = (
    "concat(CASE {t}.road_category WHEN 'E' THEN 'E' WHEN 'R' THEN 'Rv' WHEN 'F' THEN 'Fv' "
    "WHEN 'K' THEN 'Kv' ELSE '' END, {t}.road_number)"
)


def serving_tables(catalog: str, current_window_min: int, coverage_km: float) -> list[tuple[str, str]]:
    g, s = f"{catalog}.gold", f"{catalog}.silver"
    newest = f"(SELECT max(event_time) FROM {g}.road_weather_observation_log)"
    return [
        # every NVDB station; reporting if it was in the newest fetch (fetches are hours apart, not the clock)
        (
            "station_status",
            f"""WITH last AS (
  SELECT station_id, max(event_time) AS last_event_time
  FROM {g}.road_weather_observation_log GROUP BY station_id)
SELECT st.station_id, st.name, st.latitude AS lat, st.longitude AS lon, {ROAD_LABEL.format(t="st")} AS road,
       st.road_segment_id, l.last_event_time,
       CASE WHEN l.last_event_time >= {newest} - INTERVAL {current_window_min} MINUTES THEN 'Reporting'
            ELSE 'Stale' END AS station_status,
       CASE WHEN l.last_event_time >= {newest} - INTERVAL {current_window_min} MINUTES THEN '🟢 Reporting'
            ELSE '⚪ Stale' END AS status_label,
       r.risk_level, round(r.icing_score, 2) AS icing_score
FROM {s}.nvdb_seed_stations st
LEFT JOIN last l USING (station_id)
LEFT JOIN {g}.road_segment_current_risk r ON r.station_id = st.station_id""",
        ),
        # the risk map's three layers: road points (grey, or the covering station's risk within coverage_km on
        # its own road) and the stations; draw_order puts coloured points on top
        (
            "map_points",
            f"""WITH risk AS (
  SELECT road, name AS place, lat AS st_lat, lon AS st_lon, risk_level, icing_score
  FROM {g}.station_status WHERE risk_level IS NOT NULL),
nearest AS (
  SELECT {ROAD_LABEL.format(t="p")} AS road, p.line_no, p.seq, p.latitude AS lat, p.longitude AS lon,
         k.place, k.risk_level, k.icing_score,
         111.2 * sqrt(power(p.latitude - k.st_lat, 2)
                      + power((p.longitude - k.st_lon) * cos(radians(p.latitude)), 2)) AS station_km
  FROM {s}.nvdb_seed_road_points p
  LEFT JOIN risk k ON k.road = {ROAD_LABEL.format(t="p")}
  QUALIFY row_number() OVER (PARTITION BY p.road_category, p.road_number, p.line_no, p.seq
                             ORDER BY station_km) = 1)
SELECT road, lat, lon,
       CASE WHEN station_km <= {coverage_km} THEN risk_level ELSE 'Road' END AS layer,
       CASE WHEN station_km <= {coverage_km} THEN place END AS place,
       CASE WHEN station_km <= {coverage_km} THEN icing_score END AS icing_score,
       CASE WHEN station_km <= {coverage_km} THEN
            CASE risk_level WHEN 'VERY_HIGH' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END
            ELSE 0 END AS draw_order
FROM nearest
UNION ALL
SELECT road, lat, lon, CASE station_status WHEN 'Reporting' THEN 'Station' ELSE 'Station (stale)' END,
       name, icing_score, 9
FROM {g}.station_status""",
        ),
        # one row per segment with a current risk: the road-detail header and the base of the other tables
        (
            "segment_detail",
            f"""SELECT concat({ROAD_LABEL.format(t="s")}, ' · ', coalesce(st.name, r.road_segment_id))
         AS segment,
       r.road_segment_id, {ROAD_LABEL.format(t="s")} AS road,
       concat(s.road_category, s.road_number) AS road_key,
       r.station_id, st.name AS station_name, r.risk_level, round(r.icing_score, 2) AS icing_score,
       r.road_surface_temperature_c AS surface_c, r.air_temperature_c AS air_c,
       r.temperature_change_1h AS change_1h_c,
       coalesce(concat(CASE WHEN r.temperature_change_1h > 0 THEN '+' ELSE '' END,
                       round(r.temperature_change_1h, 1), ' in 1 h'), 'trend: {PENDING}') AS change_label,
       r.risk_drivers, r.event_time, r.risk_updated_at
FROM {g}.road_segment_current_risk r
JOIN {s}.nvdb_seed_segments s USING (road_segment_id)
LEFT JOIN {s}.nvdb_seed_stations st ON st.station_id = r.station_id""",
        ),
        (
            "segment_drivers",
            f"""SELECT segment, {FACTOR_LABEL.format(col="drv.factor")} AS factor,
       round(drv.contribution, 3) AS contribution
FROM (SELECT segment, explode(risk_drivers) AS drv FROM {g}.segment_detail)""",
        ),
        (
            "segment_risk_types",
            f"""SELECT segment, 1 AS sort_key, 'Icing' AS risk_type,
       {LEVEL_BADGE.format(col="risk_level")} AS level,
       icing_score AS score, 'live' AS note
FROM {g}.segment_detail
UNION ALL SELECT segment, 2, 'Closure', NULL, NULL, '{PENDING}' FROM {g}.segment_detail
UNION ALL SELECT segment, 3, 'Accident', NULL, NULL, '{PENDING}' FROM {g}.segment_detail""",
        ),
        (
            "segment_history",
            f"""SELECT d.segment, h.event_time, h.icing_score, h.risk_level,
       h.road_surface_temperature_c AS surface_c, h.air_temperature_c AS air_c
FROM {g}.road_segment_risk_history h
JOIN {g}.segment_detail d USING (road_segment_id)
WHERE coalesce(h._batch_id, '') NOT LIKE 'replay:%'""",
        ),
        # the newest reading of the segment's station, one row per reading for the two-column table
        (
            "segment_readings",
            f"""WITH latest AS (
  SELECT d.segment, o.*
  FROM {g}.segment_detail d
  JOIN {g}.road_weather_observation_log o ON o.station_id = d.station_id
  QUALIFY row_number() OVER (PARTITION BY d.segment ORDER BY o.event_time DESC) = 1)
SELECT segment, 1 AS sort_key, 'Surface' AS reading,
       coalesce(concat(round(road_surface_temperature_c, 1), ' °C'), '{NOT_REPORTED}') AS value FROM latest
UNION ALL SELECT segment, 2, 'Air',
       coalesce(concat(round(air_temperature_c, 1), ' °C'), '{NOT_REPORTED}') FROM latest
UNION ALL SELECT segment, 3, 'Dew point',
       coalesce(concat(round(dew_point_c, 1), ' °C'), '{NOT_REPORTED}') FROM latest
UNION ALL SELECT segment, 4, 'Precipitation',
       concat(initcap(precipitation_type),
              CASE WHEN precipitation_type_source = 'UNKNOWN' AND precipitation_type <> 'UNKNOWN'
                   THEN ' (inferred)' ELSE '' END,
              coalesce(concat(', ', round(precipitation_intensity_mm_h, 1), ' mm/h'), '')) FROM latest
UNION ALL SELECT segment, 5, 'Wind',
       coalesce(concat(round(wind_speed_ms, 0), ' m/s'), '{NOT_REPORTED}') FROM latest
UNION ALL SELECT segment, 6, 'Road surface', '{PENDING}' FROM latest
UNION ALL SELECT segment, 7, 'Observed', concat(date_format(event_time, 'HH:mm'), ' UTC') FROM latest""",
        ),
        # incidents on the segment's road; whether one is still active is the query's call (viewer's clock)
        (
            "segment_incidents",
            f"""SELECT d.segment, i.incident_id, i.start_time, i.end_time, i.incident_type, i.severity,
       i.description
FROM {g}.segment_detail d
JOIN {g}.road_incidents i ON i.road_key = d.road_key""",
        ),
        # gritting priority: county-wide rank, surface and precipitation from the last 3 h of readings
        (
            "priority_list",
            f"""WITH obs AS (
  SELECT station_id, max_by(road_surface_temperature_c, event_time) AS surface_c,
         max_by(precipitation_type, event_time) AS precip
  FROM {g}.road_weather_observation_log
  WHERE event_time >= {newest} - INTERVAL 3 HOURS
  GROUP BY station_id),
ranked AS (
  SELECT d.road_segment_id, d.road, d.station_name AS place, d.icing_score, d.risk_level,
         {LEVEL_BADGE.format(col="d.risk_level")} AS level, o.surface_c,
         initcap(coalesce(o.precip, 'None')) AS precip,
         array_join(transform(d.risk_drivers, x -> {FACTOR_LABEL.format(col="x.factor")}), ', ')
           AS main_drivers,
         d.risk_updated_at
  FROM {g}.segment_detail d
  LEFT JOIN obs o ON o.station_id = d.station_id)
SELECT row_number() OVER (ORDER BY icing_score DESC, road) AS rank, * FROM ranked""",
        ),
        # one row for the counters on the risk map and Platform health
        (
            "kpi_summary",
            f"""SELECT r.segments_total, r.segments_high, r.segments_very_high, r.risk_updated_at,
       s.stations_total, s.stations_reporting, i.active_incidents, l.latency_median_s,
       current_timestamp() AS computed_at
FROM (SELECT count(*) AS segments_total,
             count_if(risk_level IN ('HIGH', 'VERY_HIGH')) AS segments_high,
             count_if(risk_level = 'VERY_HIGH') AS segments_very_high,
             max(risk_updated_at) AS risk_updated_at
      FROM {g}.road_segment_current_risk) r,
     (SELECT count(*) AS stations_total, count_if(station_status = 'Reporting') AS stations_reporting
      FROM {g}.station_status) s,
     (SELECT coalesce(sum(active_incidents), 0) AS active_incidents FROM {g}.incident_summary) i,
     (SELECT median(timestampdiff(SECOND, event_time, risk_updated_at)) AS latency_median_s
      FROM {g}.road_segment_risk_history
      WHERE event_time >= current_timestamp() - INTERVAL 24 HOURS
        AND coalesce(_batch_id, '') NOT LIKE 'replay:%') l""",
        ),
    ]
