// A small valid State for data-layer tests.
import type { State } from "../../shared/contract";

export function baseState(): State {
  return {
    generated_at: "2026-10-12T09:28:00Z",
    source: "live",
    gold: { risk_updated_at: "2026-10-12T09:20:00Z", computed_at: "2026-10-12T09:28:00Z" },
    kpi: { segments_total: 1, segments_high: 1, segments_very_high: 0, stations_total: 2, stations_reporting: 1, active_incidents: 0 },
    stations: [
      { station_id: "3000014", name: "Bossovarri", road: "E8", lat: 69.1202, lon: 20.74511, road_segment_id: "1125788-27-9",
        status: "Reporting", last_event_time: "2026-10-12T09:20:00Z", risk_level: "HIGH", icing_score: 0.72 },
      { station_id: "3000016", name: "Gardeborri", road: "E8", lat: 69.18203, lon: 20.75035, road_segment_id: "1125788-25-9",
        status: "Stale", last_event_time: "2026-10-12T04:10:00Z", risk_level: null, icing_score: null },
    ],
    segments: [
      { road_segment_id: "1125788-27-9", segment: "E8 · Bossovarri", road: "E8", station_id: "3000014", risk_level: "HIGH",
        icing_score: 0.72, surface_c: -3.1, air_c: -2.4, change_1h_c: -0.8, event_time: "2026-10-12T09:20:00Z", priority_rank: 2,
        drivers: [{ factor: "Precipitation", contribution: 0.41 }],
        readings: { dew_point_c: -3.4, precip_type: "SNOW", precip_mm_h: 2.4, wind_ms: 11 } },
    ],
    incidents: [],
    history: { "1125788-27-9": [{ t: "2026-10-12T06:00:00Z", level: "MEDIUM", score: 0.48 }] },
  };
}
