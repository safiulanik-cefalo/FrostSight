// One SELECT per plot-ready gold table (ADR-0009). latest_readings is the newest row per station of the
// observation log, because dew point, precipitation and wind are not in segment_detail (spec section 6).
// map_points keeps only the coloured road points: the 2D map draws roads from its base map tiles.
export type TableKey =
  | "kpi_summary"
  | "station_status"
  | "segment_detail"
  | "segment_drivers"
  | "segment_history"
  | "incident_list"
  | "priority_list"
  | "latest_readings"
  | "map_points";

export const TABLE_KEYS: TableKey[] = [
  "kpi_summary",
  "station_status",
  "segment_detail",
  "segment_drivers",
  "segment_history",
  "incident_list",
  "priority_list",
  "latest_readings",
  "map_points",
];

export const QUERIES: Record<TableKey, (catalog: string) => string> = {
  kpi_summary: (c) => `SELECT * FROM ${c}.gold.kpi_summary`,
  station_status: (c) => `SELECT * FROM ${c}.gold.station_status`,
  segment_detail: (c) => `SELECT * FROM ${c}.gold.segment_detail`,
  segment_drivers: (c) => `SELECT * FROM ${c}.gold.segment_drivers`,
  segment_history: (c) =>
    `SELECT * FROM ${c}.gold.segment_history WHERE event_time >= current_timestamp() - INTERVAL 24 HOURS`,
  incident_list: (c) => `SELECT * FROM ${c}.gold.incident_list`,
  priority_list: (c) => `SELECT * FROM ${c}.gold.priority_list`,
  latest_readings: (c) =>
    `SELECT station_id, dew_point_c, precipitation_type, precipitation_intensity_mm_h, wind_speed_ms ` +
    `FROM ${c}.gold.road_weather_observation_log ` +
    `QUALIFY row_number() OVER (PARTITION BY station_id ORDER BY event_time DESC) = 1`,
  map_points: (c) =>
    `SELECT road, lat, lon, layer AS risk_level, place, icing_score FROM ${c}.gold.map_points ` +
    `WHERE layer IN ('LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH') ORDER BY draw_order`,
};
