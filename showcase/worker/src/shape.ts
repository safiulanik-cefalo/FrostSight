// Gold rows (strings from the statement API) to one State document. Joins here are lookups between
// small serving tables for one consumer; anything heavier belongs in a new gold table (spec section 6).
import type { Row } from "./databricks";
import type { TableKey } from "./queries";
import type { Level, State } from "../../shared/contract";

export type GoldRows = Record<TableKey, Row[]>;

const str = (v: Row[string] | undefined): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: Row[string] | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const req = (v: Row[string] | undefined): number => num(v) ?? 0;

export function shapeState(rows: GoldRows, generatedAt: string): State {
  const kpi = rows.kpi_summary[0] ?? {};
  const bySegment = new Map(rows.segment_detail.map((d) => [String(d.segment), d]));
  const rank = new Map(rows.priority_list.map((p) => [String(p.road_segment_id), num(p.rank)]));
  const reading = new Map(rows.latest_readings.map((r) => [String(r.station_id), r]));

  const segments = rows.segment_detail.map((d) => {
    const r = reading.get(String(d.station_id)) ?? {};
    return {
      road_segment_id: String(d.road_segment_id),
      segment: String(d.segment),
      road: String(d.road),
      station_id: str(d.station_id),
      risk_level: String(d.risk_level) as Level,
      icing_score: req(d.icing_score),
      surface_c: num(d.surface_c),
      air_c: num(d.air_c),
      change_1h_c: num(d.change_1h_c),
      event_time: str(d.event_time),
      priority_rank: rank.get(String(d.road_segment_id)) ?? null,
      drivers: rows.segment_drivers
        .filter((x) => x.segment === d.segment)
        .map((x) => ({ factor: String(x.factor), contribution: req(x.contribution) })),
      readings: {
        dew_point_c: num(r.dew_point_c),
        precip_type: str(r.precipitation_type),
        precip_mm_h: num(r.precipitation_intensity_mm_h),
        wind_ms: num(r.wind_speed_ms),
      },
    };
  });

  const history: State["history"] = {};
  for (const h of rows.segment_history) {
    const d = bySegment.get(String(h.segment));
    if (!d) continue;
    (history[String(d.road_segment_id)] ??= []).push({
      t: String(h.event_time),
      level: String(h.risk_level) as Level,
      score: req(h.icing_score),
    });
  }
  for (const list of Object.values(history)) list.sort((a, b) => a.t.localeCompare(b.t));

  return {
    generated_at: generatedAt,
    source: "live",
    gold: { risk_updated_at: str(kpi.risk_updated_at), computed_at: str(kpi.computed_at) },
    kpi: {
      segments_total: req(kpi.segments_total),
      segments_high: req(kpi.segments_high),
      segments_very_high: req(kpi.segments_very_high),
      stations_total: req(kpi.stations_total),
      stations_reporting: req(kpi.stations_reporting),
      active_incidents: req(kpi.active_incidents),
    },
    stations: rows.station_status.map((s) => ({
      station_id: String(s.station_id),
      name: String(s.name),
      road: String(s.road),
      lat: req(s.lat),
      lon: req(s.lon),
      road_segment_id: str(s.road_segment_id),
      status: s.station_status === "Reporting" ? "Reporting" : "Stale",
      last_event_time: str(s.last_event_time),
      risk_level: (str(s.risk_level) as Level | null) ?? null,
      icing_score: num(s.icing_score),
    })),
    segments,
    incidents: rows.segment_incidents.map((i) => {
      const d = bySegment.get(String(i.segment));
      return {
        incident_id: String(i.incident_id),
        road: d ? String(d.road) : String(i.segment).split(" · ")[0],
        road_segment_id: d ? String(d.road_segment_id) : null,
        incident_type: String(i.incident_type),
        severity: str(i.severity),
        start_time: String(i.start_time),
        end_time: str(i.end_time),
        description: str(i.description),
      };
    }),
    history,
  };
}
