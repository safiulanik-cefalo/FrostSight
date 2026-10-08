-- 002_gold_views.sql
-- The views the live dashboard reads in gold (07_M6 T6.4 step 2), pointed at the tables that exist today
-- (docs/gold-from-team-silver.md): the interim NVDB seed in silver (B3), the gold job's own observation log (B2)
-- and its incident table (B6). Column names match tools/mock_dashboards/mock_data.sql, so the same dashboard
-- queries run on mock and gold.
-- Needs build_gold to have run once (it creates the gold tables). Idempotent.
-- Run with `uv run python tools/mock_dashboards/deploy.py --dashboard live`, which runs it statement by statement.

CREATE OR REPLACE VIEW frostsight.gold.v_segments AS
SELECT road_segment_id, road_number, road_category,
       concat(CASE road_category WHEN 'E' THEN 'E' WHEN 'R' THEN 'Rv' WHEN 'F' THEN 'Fv' WHEN 'K' THEN 'Kv' ELSE '' END,
              road_number) AS road,
       55 AS county, length_m, CAST(NULL AS INT) AS speed_limit, centroid_lat, centroid_lon,
       ST_GeomFromText(geometry_wkt_4326, 4326) AS geometry
FROM frostsight.silver.nvdb_seed_segments;

CREATE OR REPLACE VIEW frostsight.gold.v_road_network AS
SELECT concat(CASE road_category WHEN 'E' THEN 'E' WHEN 'R' THEN 'Rv' WHEN 'F' THEN 'Fv' WHEN 'K' THEN 'Kv' ELSE '' END,
              road_number) AS road, line_no, length_m, ST_GeomFromText(geometry_wkt_4326, 4326) AS geometry
FROM frostsight.silver.nvdb_seed_roads;

CREATE OR REPLACE VIEW frostsight.gold.v_road_points AS
SELECT concat(CASE road_category WHEN 'E' THEN 'E' WHEN 'R' THEN 'Rv' WHEN 'F' THEN 'Fv' WHEN 'K' THEN 'Kv' ELSE '' END,
              road_number) AS road, line_no, seq, latitude, longitude
FROM frostsight.silver.nvdb_seed_road_points;

-- every NVDB station in Troms, with the segment it maps to, whether or not DATEX reports it
CREATE OR REPLACE VIEW frostsight.gold.v_stations AS
SELECT station_id, name, latitude, longitude,
       concat(CASE road_category WHEN 'E' THEN 'E' WHEN 'R' THEN 'Rv' WHEN 'F' THEN 'Fv' WHEN 'K' THEN 'Kv' ELSE '' END,
              road_number) AS road,
       road_segment_id
FROM frostsight.silver.nvdb_seed_stations;

-- DATEX WeatherSimple_v2 has no road surface state (B5): the column stays for the shared queries, always NULL
CREATE OR REPLACE VIEW frostsight.gold.v_observations AS
SELECT station_id, event_time, air_temperature_c, road_surface_temperature_c, dew_point_c, humidity_pct,
       precipitation_type, precipitation_intensity_mm_h, wind_speed_ms, CAST(NULL AS STRING) AS road_surface_state,
       _batch_id
FROM frostsight.gold.road_weather_observation_log;

CREATE OR REPLACE VIEW frostsight.gold.v_incidents AS
SELECT incident_id, incident_type, severity, road_ref, road_number, road_segment_id, start_time, end_time,
       description, latitude, longitude, snapshot_time,
       (start_time <= current_timestamp() AND (end_time IS NULL OR end_time > current_timestamp())) AS is_active
FROM frostsight.gold.road_incidents;
