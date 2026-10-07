-- mock_data.sql
-- Mock gold layer for previewing the dashboards before M4 to M6 deliver real data.
-- Creates frostsight.mock with the same table and view names the dashboards read in gold (07_M6 T6.4), filled
-- with a synthetic storm morning in Troms: dry and mild 24 hours ago, then cooling overnight with snow over the
-- last four hours. Every timestamp is relative to the current time, so the dashboards always look live.
-- Roads, stations and their nearest segments are real NVDB data (nvdb_seed.sql, fetch_nvdb.py, NLOD); readings,
-- risk, incidents and quality numbers are made up.
-- Risk is the real v0 model (04_M3 T3.4 weights, breakpoints and levels), computed in SQL.
--
-- Run with `uv run python tools/mock_dashboards/deploy.py`, which runs nvdb_seed.sql first, replaces
-- {geometry_expr} and runs one statement at a time. Needs the catalog from sql/001_catalog_schemas_volume.sql.
-- Remove with: DROP SCHEMA frostsight.mock CASCADE;

CREATE SCHEMA IF NOT EXISTS frostsight.mock COMMENT 'Mock gold layer for dashboard previews; safe to drop';

-- ---------- seeds ----------

CREATE OR REPLACE TABLE frostsight.mock.seed_climate (
  climate STRING, surface_offset_c DOUBLE, spread_now_c DOUBLE
);

INSERT INTO frostsight.mock.seed_climate VALUES
  ('warm', 5.0, 2.0),
  ('coast', 3.0, 1.5),
  ('fjord', 0.6, 0.6),
  ('inland', -0.4, 0.6),
  ('mountain', -1.3, 0.5);

-- source, minutes since the newest event, minutes since the newest ingestion, threshold, row counts
CREATE OR REPLACE TABLE frostsight.mock.seed_freshness (
  source STRING, event_age_min INT, ingest_age_min INT, threshold_min INT, rows_last_24h BIGINT, quarantined_last_24h BIGINT
);

INSERT INTO frostsight.mock.seed_freshness VALUES
  ('road_weather', 8, 6, 30, 3888, 21),
  ('incidents', 75, 73, 60, 62, 1),
  ('nvdb', 2890, 2880, 11520, 27, 0),
  ('elevation', NULL, NULL, 86400, 0, 0);

CREATE OR REPLACE TABLE frostsight.mock.seed_quarantine (quarantine_table STRING, rule STRING, rows_today INT);

INSERT INTO frostsight.mock.seed_quarantine VALUES
  ('invalid_road_weather', 'RW003', 9),
  ('invalid_road_weather', 'RW001', 4),
  ('invalid_road_weather', 'RW006', 2),
  ('late_road_weather', 'RW008', 5),
  ('unmapped_observations', 'LK001', 3),
  ('invalid_incidents', 'IN002', 1);

-- fail_every: a run fails this rule on every n-th pipeline update
CREATE OR REPLACE TABLE frostsight.mock.seed_dq_rules (
  rule_id STRING, source STRING, action STRING, rows_per_run INT, fail_every INT
);

INSERT INTO frostsight.mock.seed_dq_rules VALUES
  ('RW001', 'road_weather', 'quarantine', 27, 9),
  ('RW003', 'road_weather', 'quarantine', 27, 4),
  ('RW006', 'road_weather', 'quarantine', 27, 17),
  ('XS001', 'road_weather', 'warn', 27, 6),
  ('IN002', 'incidents', 'quarantine', 4, 40);

-- ---------- clock and series ----------

CREATE OR REPLACE VIEW frostsight.mock.v_clock AS
SELECT timestampadd(MINUTE, -(minute(current_timestamp()) % 10), date_trunc('MINUTE', current_timestamp())) AS now10;

-- one reading per station every 10 minutes for 24 hours; k = 10-minute steps before now, t = hours before now
CREATE OR REPLACE VIEW frostsight.mock.obs_series AS
WITH grid AS (
  SELECT s.station_id, s.climate, c.surface_offset_c, c.spread_now_c, g.k, g.k / 6.0 AS t, clk.now10,
         sin(g.k * 1.7 + crc32(s.station_id) % 100) * 0.15 AS wobble
  FROM frostsight.mock.seed_stations s
  JOIN frostsight.mock.seed_climate c ON c.climate = s.climate
  CROSS JOIN (SELECT explode(sequence(0, 143)) AS k) g
  CROSS JOIN frostsight.mock.v_clock clk
  WHERE g.k * 10 >= s.silent_min),
temps AS (
  SELECT *,
         surface_offset_c + 3.0 * t / 24 - 1.5 * exp(-t / 2) + wobble AS surface_c,
         spread_now_c + (2.5 - spread_now_c) * t / 24 AS spread_c
  FROM grid),
weather AS (
  SELECT *,
         surface_c + 0.8 + 0.3 * cos(k * 0.9) AS air_c
  FROM temps)
SELECT station_id, k,
       timestampadd(MINUTE, -(10 * k + 6), now10) AS event_time,
       round(air_c, 1) AS air_temperature_c,
       round(surface_c, 1) AS road_surface_temperature_c,
       round(air_c - spread_c, 1) AS dew_point_c,
       round(least(99.0, 100.0 - 5.0 * spread_c), 0) AS humidity_pct,
       CASE WHEN t >= 4 THEN 'NONE' WHEN air_c > 1.5 THEN 'RAIN' WHEN air_c > 0.3 THEN 'SLEET' ELSE 'SNOW' END
         AS precipitation_type,
       CASE WHEN t >= 4 THEN 0.0 ELSE round(0.8 + 1.2 * (1 - t / 4) + wobble, 1) END AS precipitation_intensity_mm_h,
       round(4.0 + 6.0 * (1 - t / 24) + 2.0 * sin(k * 0.4 + crc32(station_id) % 7), 1) AS wind_speed_ms,
       CASE WHEN surface_c <= 0 AND t < 4 AND air_c <= 0.3 THEN 'SNOW'
            WHEN surface_c <= 0 THEN 'ICY'
            WHEN t < 4 THEN 'WET'
            ELSE 'DRY' END AS road_surface_state,
       concat(date_format(timestampadd(MINUTE, -(10 * k), now10), 'yyyyMMdd'), 'T',
              date_format(timestampadd(MINUTE, -(10 * k), now10), 'HHmm'), '00Z') AS _batch_id
FROM weather;

-- v0 risk per observation: piecewise-linear factor scores, weighted sum, levels, top three drivers
CREATE OR REPLACE VIEW frostsight.mock.risk_series AS
WITH obs AS (
  SELECT o.*, s.road_segment_id,
         o.road_surface_temperature_c - lead(o.road_surface_temperature_c, 6)
           OVER (PARTITION BY o.station_id ORDER BY o.k) AS dts_1h,
         o.road_surface_temperature_c - lead(o.road_surface_temperature_c, 18)
           OVER (PARTITION BY o.station_id ORDER BY o.k) AS dts_3h
  FROM frostsight.mock.obs_series o
  JOIN frostsight.mock.seed_stations s ON s.station_id = o.station_id),
f AS (
  SELECT *,
         CAST(CASE WHEN road_surface_temperature_c <= -2 THEN 1.0
              WHEN road_surface_temperature_c <= 0 THEN 1.0 - 0.25 * (road_surface_temperature_c + 2)
              WHEN road_surface_temperature_c <= 3 THEN 0.5 - road_surface_temperature_c / 6
              ELSE 0.0 END AS DOUBLE) AS f_surface,
         CAST(CASE WHEN air_temperature_c <= -2 THEN 1.0
              WHEN air_temperature_c <= 0 THEN 1.0 - 0.25 * (air_temperature_c + 2)
              WHEN air_temperature_c <= 4 THEN 0.5 - air_temperature_c / 8
              ELSE 0.0 END AS DOUBLE) AS f_air,
         CAST(CASE WHEN air_temperature_c - dew_point_c <= 0.5 THEN 1.0
              WHEN air_temperature_c - dew_point_c <= 3 THEN 1.0 - (air_temperature_c - dew_point_c - 0.5) / 2.5
              ELSE 0.0 END AS DOUBLE) AS f_dew,
         CAST(CASE precipitation_type WHEN 'FREEZING_RAIN' THEN 1.0 WHEN 'SNOW' THEN 0.9 WHEN 'SLEET' THEN 0.8
              WHEN 'RAIN' THEN 0.5 WHEN 'DRIZZLE' THEN 0.4 WHEN 'UNKNOWN' THEN 0.2 ELSE 0.0 END AS DOUBLE) AS f_precip,
         CAST(CASE WHEN dts_1h IS NULL THEN 0.0
              WHEN dts_1h <= -3 THEN 1.0
              WHEN dts_1h <= -1 THEN 0.5 + 0.25 * (-1 - dts_1h)
              WHEN dts_1h <= 0 THEN -0.5 * dts_1h
              ELSE 0.0 END AS DOUBLE) AS f_trend
  FROM obs),
c AS (
  SELECT *,
         array(named_struct('factor', 'surface_temp', 'contribution', 0.35D * f_surface),
               named_struct('factor', 'air_temp', 'contribution', 0.15D * f_air),
               named_struct('factor', 'dew_point_spread', 'contribution', 0.15D * f_dew),
               named_struct('factor', 'precipitation', 'contribution', 0.20D * f_precip),
               named_struct('factor', 'temp_trend_1h', 'contribution', 0.15D * f_trend)) AS contributions
  FROM f),
s AS (
  SELECT *, aggregate(contributions, 0.0D, (acc, x) -> acc + x.contribution) AS icing
  FROM c)
SELECT road_segment_id, station_id, k, event_time,
       round(icing, 4) AS icing_score,
       round(icing, 4) AS risk_score,
       CASE WHEN icing >= 0.75 THEN 'VERY_HIGH' WHEN icing >= 0.5 THEN 'HIGH' WHEN icing >= 0.25 THEN 'MEDIUM'
            ELSE 'LOW' END AS risk_level,
       slice(array_sort(contributions, (l, r) ->
               CASE WHEN l.contribution > r.contribution THEN -1 WHEN l.contribution < r.contribution THEN 1
                    WHEN l.factor < r.factor THEN -1 WHEN l.factor > r.factor THEN 1 ELSE 0 END), 1, 3) AS risk_drivers,
       road_surface_temperature_c, air_temperature_c, dew_point_c, precipitation_type,
       round(dts_1h, 1) AS temperature_change_1h,
       round(dts_3h, 1) AS temperature_change_3h,
       timestampadd(SECOND, 180 + (k * 37) % 120, event_time) AS risk_updated_at,
       'v0' AS model_version,
       _batch_id
FROM s;

-- ---------- the names the dashboards read (07_M6 T6.4) ----------

CREATE OR REPLACE VIEW frostsight.mock.road_segment_risk_history AS
SELECT road_segment_id, station_id, event_time, icing_score, risk_score, risk_level, risk_drivers,
       road_surface_temperature_c, air_temperature_c, dew_point_c, precipitation_type,
       temperature_change_1h, temperature_change_3h, risk_updated_at, model_version, _batch_id
FROM frostsight.mock.risk_series;

CREATE OR REPLACE VIEW frostsight.mock.road_segment_current_risk AS
SELECT road_segment_id, station_id, event_time, icing_score, risk_score, risk_level, risk_drivers,
       road_surface_temperature_c, air_temperature_c, dew_point_c, precipitation_type,
       temperature_change_1h, temperature_change_3h, risk_updated_at, model_version
FROM frostsight.mock.risk_series
QUALIFY row_number() OVER (PARTITION BY road_segment_id ORDER BY k) = 1;

-- the real NVDB segment nearest each station (nvdb_seed.sql), as silver.station_segment_lookup will map it
CREATE OR REPLACE VIEW frostsight.mock.v_segments AS
SELECT road_segment_id, road_number, road_category,
       concat(CASE road_category WHEN 'E' THEN 'E' WHEN 'R' THEN 'Rv' WHEN 'F' THEN 'Fv' WHEN 'K' THEN 'Kv' ELSE '' END,
              road_number) AS road,
       55 AS county, length_m, CAST(NULL AS INT) AS speed_limit, centroid_lat, centroid_lon,
       {geometry_expr} AS geometry
FROM frostsight.mock.seed_segments;

-- the road network as lines (path map) and as points every 300 m (point map), for the grey road layer
CREATE OR REPLACE VIEW frostsight.mock.v_road_network AS
SELECT concat(CASE road_category WHEN 'E' THEN 'E' WHEN 'R' THEN 'Rv' WHEN 'F' THEN 'Fv' WHEN 'K' THEN 'Kv' ELSE '' END,
              road_number) AS road, line_no, length_m, {geometry_expr} AS geometry
FROM frostsight.mock.seed_roads;

CREATE OR REPLACE VIEW frostsight.mock.v_road_points AS
SELECT concat(CASE road_category WHEN 'E' THEN 'E' WHEN 'R' THEN 'Rv' WHEN 'F' THEN 'Fv' WHEN 'K' THEN 'Kv' ELSE '' END,
              road_number) AS road, line_no, seq, latitude, longitude
FROM frostsight.mock.seed_road_points;

CREATE OR REPLACE VIEW frostsight.mock.v_stations AS
SELECT station_id, name, latitude, longitude FROM frostsight.mock.seed_stations;

CREATE OR REPLACE VIEW frostsight.mock.v_observations AS
SELECT station_id, event_time, air_temperature_c, road_surface_temperature_c, dew_point_c, humidity_pct,
       precipitation_type, precipitation_intensity_mm_h, wind_speed_ms, road_surface_state, _batch_id
FROM frostsight.mock.obs_series;

CREATE OR REPLACE VIEW frostsight.mock.v_incidents AS
SELECT i.incident_id, i.incident_type, i.severity,
       concat(CASE s.road_category WHEN 'E' THEN 'E' WHEN 'R' THEN 'RV' WHEN 'F' THEN 'FV' ELSE '' END, s.road_number)
         AS road_ref,
       s.road_number, s.road_segment_id,
       timestampadd(MINUTE, -i.start_age_min, clk.now10) AS start_time,
       timestampadd(MINUTE, -i.end_age_min, clk.now10) AS end_time,
       i.description, s.latitude + 0.002 AS latitude, s.longitude + 0.004 AS longitude,
       timestampadd(MINUTE, -73, clk.now10) AS snapshot_time,
       i.end_age_min IS NULL AS is_active
FROM frostsight.mock.seed_incidents i
JOIN frostsight.mock.seed_stations s ON s.station_id = i.station_id
CROSS JOIN frostsight.mock.v_clock clk;

CREATE OR REPLACE VIEW frostsight.mock.incident_summary AS
SELECT road_segment_id, CAST(count(*) AS INT) AS active_incidents, collect_set(incident_type) AS incident_types,
       max_by(severity, CASE severity WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 1 ELSE 0 END)
         AS max_severity,
       min(start_time) AS earliest_start, current_timestamp() AS computed_at
FROM frostsight.mock.v_incidents
WHERE is_active
GROUP BY road_segment_id;

CREATE OR REPLACE VIEW frostsight.mock.data_quality_summary AS
SELECT f.source,
       timestampadd(MINUTE, -f.ingest_age_min, clk.now10) AS last_successful_ingestion,
       timestampadd(MINUTE, -f.event_age_min, clk.now10) AS last_event_time,
       CAST(f.event_age_min AS DOUBLE) AS ingestion_delay_min,
       f.threshold_min,
       CASE WHEN f.event_age_min IS NULL THEN 'NO_DATA' WHEN f.event_age_min <= f.threshold_min THEN 'FRESH'
            ELSE 'STALE' END AS status,
       f.rows_last_24h, f.quarantined_last_24h,
       clk.now10 AS computed_at
FROM frostsight.mock.seed_freshness f
CROSS JOIN frostsight.mock.v_clock clk;

-- road-weather delay every 10 minutes for 24 hours, with a 40-minute collector outage about six hours ago
CREATE OR REPLACE VIEW frostsight.mock.data_quality_summary_history AS
WITH g AS (SELECT explode(sequence(0, 143)) AS k)
SELECT f.source,
       timestampadd(MINUTE, -(10 * g.k), clk.now10) AS computed_at,
       CAST(CASE WHEN f.source <> 'road_weather' THEN f.event_age_min
                 WHEN g.k BETWEEN 33 AND 37 THEN 8 + (37 - g.k) * 10
                 ELSE 4 + (crc32(CAST(g.k AS STRING)) % 9) END AS DOUBLE) AS ingestion_delay_min,
       f.threshold_min
FROM frostsight.mock.seed_freshness f
CROSS JOIN g
CROSS JOIN frostsight.mock.v_clock clk;

-- quarantined rows spread over today (UTC), so the "today" tiles are never empty
CREATE OR REPLACE VIEW frostsight.mock.v_quarantine AS
WITH q AS (SELECT quarantine_table, rule, explode(sequence(1, rows_today)) AS n FROM frostsight.mock.seed_quarantine)
SELECT q.quarantine_table, q.rule,
       timestampadd(SECOND,
                    -CAST((crc32(concat(q.rule, CAST(q.n AS STRING))) % 1000) / 1000.0
                          * (unix_timestamp(clk.now10) - unix_timestamp(CAST(current_date() AS TIMESTAMP))) AS INT),
                    clk.now10) AS quarantined_at
FROM q
CROSS JOIN frostsight.mock.v_clock clk;

-- one pipeline update every 10 minutes since midnight UTC
CREATE OR REPLACE VIEW frostsight.mock.v_dq_events AS
WITH clk AS (SELECT now10, (hour(now10) * 60 + minute(now10)) DIV 10 AS runs FROM frostsight.mock.v_clock),
r AS (SELECT clk.now10, explode(sequence(0, clk.runs)) AS run FROM clk)
SELECT timestampadd(MINUTE, -(10 * r.run) - 2, r.now10) AS event_time,
       concat('update-', date_format(timestampadd(MINUTE, -(10 * r.run), r.now10), 'HHmm')) AS run_id,
       d.source, d.rule_id, d.action,
       CAST(d.rows_per_run AS BIGINT) AS rows_checked,
       CAST(CASE WHEN r.run % d.fail_every = 0 THEN 1 + r.run % 3 ELSE 0 END AS BIGINT) AS rows_failed
FROM r
CROSS JOIN frostsight.mock.seed_dq_rules d;
